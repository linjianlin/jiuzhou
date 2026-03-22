/**
 * 玩家状态 Redis 主状态仓库
 *
 * 作用：
 * 1. 做什么：以 Redis 作为角色与背包的唯一运行时真相，统一提供 hydrate、读取、角色 patch、物品 patch 与 dirty/version 管理。
 * 2. 做什么：把角色/背包状态的序列化、分布式锁和 Redis key 访问收敛到单一模块，避免各业务服务各写一套 Redis 逻辑。
 * 3. 不做什么：不负责把状态刷回 PostgreSQL，不处理业务规则，不替调用方计算数值。
 *
 * 输入/输出：
 * - 输入：characterId / userId、角色 patch、物品 patch、物品删除指令。
 * - 输出：Redis 中的角色状态、物品状态、元数据状态。
 *
 * 数据流/状态流：
 * 业务服务 -> ensure hydrated -> 读取/更新 Redis 主状态 -> 标记 dirty/version -> flush 服务异步刷库。
 *
 * 关键边界条件与坑点：
 * 1. hydrate 必须在锁内二次检查 key，避免并发 miss 时重复装载覆盖。
 * 2. 仓库更新必须统一递增版本号；否则 flush 无法识别“刷库期间又有新写入”。
 */
import crypto from 'node:crypto';

import { query } from '../config/database.js';
import { redis } from '../config/redis.js';
import { CHARACTER_BASE_COLUMNS_SQL } from './shared/sqlFragments.js';
import {
  playerStateCharacterKey,
  playerStateDirtySetKey,
  playerStateFlushLockKey,
  playerStateHydrateLockKey,
  playerStateInventoryKey,
  playerStateMetaKey,
  playerStateUserCharacterKey,
} from './playerStateKeys.js';
import { withPlayerStateMutex } from './playerStateMutex.js';
import type {
  PlayerCharacterState,
  PlayerCharacterStatePatch,
  PlayerInventoryItemState,
  PlayerInventoryItemStatePatch,
  PlayerStateJsonValue,
  PlayerStateMeta,
} from './playerStateTypes.js';

const PLAYER_STATE_LOCK_TTL_SECONDS = 15;
const PLAYER_STATE_HYDRATE_WAIT_MS = 50;
const PLAYER_STATE_HYDRATE_MAX_WAIT_TIMES = 60;

const ensurePositiveInteger = (value: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`非法角色标识: ${value}`);
  }
  return normalized;
};

const parseInteger = (value: unknown, fallback = 0): number => {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.floor(normalized);
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return fallback;
};

const normalizeJsonValue = (value: unknown): PlayerStateJsonValue => {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (typeof value === 'object' && value !== null) {
    const output: { [key: string]: PlayerStateJsonValue | undefined } = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = normalizeJsonValue(entry);
    }
    return output;
  }
  return String(value);
};

const normalizeTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
};

const serialize = (value: PlayerCharacterState | PlayerInventoryItemState): string => {
  return JSON.stringify(value);
};

const deserializeCharacter = (raw: string): PlayerCharacterState => {
  return JSON.parse(raw) as PlayerCharacterState;
};

const deserializeInventoryItem = (raw: string): PlayerInventoryItemState => {
  return JSON.parse(raw) as PlayerInventoryItemState;
};

const buildDefaultMeta = (): PlayerStateMeta => {
  return {
    version: 1,
    dirtyCharacter: false,
    dirtyInventory: false,
    hydratedAt: new Date().toISOString(),
    lastFlushAt: null,
  };
};

const normalizeCharacterStateRow = (row: Record<string, unknown>): PlayerCharacterState => {
  return {
    id: parseInteger(row.id),
    user_id: parseInteger(row.user_id),
    nickname: typeof row.nickname === 'string' ? row.nickname : '',
    title: typeof row.title === 'string' ? row.title : '散修',
    gender: typeof row.gender === 'string' ? row.gender : 'male',
    avatar: typeof row.avatar === 'string' ? row.avatar : null,
    auto_cast_skills: parseBoolean(row.auto_cast_skills, true),
    auto_disassemble_enabled: parseBoolean(row.auto_disassemble_enabled, false),
    auto_disassemble_rules: normalizeJsonValue(row.auto_disassemble_rules ?? []),
    dungeon_no_stamina_cost: parseBoolean(row.dungeon_no_stamina_cost, false),
    spirit_stones: parseInteger(row.spirit_stones),
    silver: parseInteger(row.silver),
    stamina: parseInteger(row.stamina),
    stamina_recover_at: normalizeTimestamp(row.stamina_recover_at),
    realm: typeof row.realm === 'string' ? row.realm : '凡人',
    sub_realm: typeof row.sub_realm === 'string' ? row.sub_realm : null,
    exp: parseInteger(row.exp),
    attribute_points: parseInteger(row.attribute_points),
    jing: parseInteger(row.jing),
    qi: parseInteger(row.qi),
    shen: parseInteger(row.shen),
    attribute_type: typeof row.attribute_type === 'string' ? row.attribute_type : 'physical',
    attribute_element: typeof row.attribute_element === 'string' ? row.attribute_element : 'none',
    current_map_id: typeof row.current_map_id === 'string' ? row.current_map_id : 'starting_village',
    current_room_id: typeof row.current_room_id === 'string' ? row.current_room_id : 'village_square',
    last_offline_at: normalizeTimestamp(row.last_offline_at),
  };
};

const normalizeInventoryItemRow = (row: Record<string, unknown>): PlayerInventoryItemState => {
  return {
    id: parseInteger(row.id),
    owner_user_id: parseInteger(row.owner_user_id),
    owner_character_id: parseInteger(row.owner_character_id),
    item_def_id: typeof row.item_def_id === 'string' ? row.item_def_id : '',
    qty: parseInteger(row.qty),
    locked: parseBoolean(row.locked, false),
    quality: typeof row.quality === 'string' ? row.quality : null,
    quality_rank: row.quality_rank === null || row.quality_rank === undefined ? null : parseInteger(row.quality_rank),
    strengthen_level:
      row.strengthen_level === null || row.strengthen_level === undefined ? null : parseInteger(row.strengthen_level),
    refine_level: row.refine_level === null || row.refine_level === undefined ? null : parseInteger(row.refine_level),
    socketed_gems: normalizeJsonValue(row.socketed_gems ?? []),
    affixes: normalizeJsonValue(row.affixes ?? []),
    affix_gen_version:
      row.affix_gen_version === null || row.affix_gen_version === undefined ? null : parseInteger(row.affix_gen_version),
    affix_roll_meta: normalizeJsonValue(row.affix_roll_meta ?? {}),
    identified:
      row.identified === null || row.identified === undefined ? null : parseBoolean(row.identified, false),
    bind_type: typeof row.bind_type === 'string' ? row.bind_type : null,
    bind_owner_user_id:
      row.bind_owner_user_id === null || row.bind_owner_user_id === undefined ? null : parseInteger(row.bind_owner_user_id),
    bind_owner_character_id:
      row.bind_owner_character_id === null || row.bind_owner_character_id === undefined ? null : parseInteger(row.bind_owner_character_id),
    location: typeof row.location === 'string' ? row.location : 'bag',
    location_slot: row.location_slot === null || row.location_slot === undefined ? null : parseInteger(row.location_slot),
    equipped_slot: typeof row.equipped_slot === 'string' ? row.equipped_slot : null,
    random_seed:
      row.random_seed === null || row.random_seed === undefined ? null : parseInteger(row.random_seed),
    custom_name: typeof row.custom_name === 'string' ? row.custom_name : null,
    expire_at: normalizeTimestamp(row.expire_at),
    obtained_from: typeof row.obtained_from === 'string' ? row.obtained_from : null,
    obtained_ref_id: typeof row.obtained_ref_id === 'string' ? row.obtained_ref_id : null,
    metadata: normalizeJsonValue(row.metadata ?? {}),
    created_at: normalizeTimestamp(row.created_at),
  };
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const releaseLock = async (lockKey: string, token: string): Promise<void> => {
  await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then
       return redis.call('DEL', KEYS[1])
     end
     return 0`,
    1,
    lockKey,
    token,
  );
};

const withRedisLock = async <T>(lockKey: string, task: () => Promise<T>): Promise<T> => {
  const token = crypto.randomUUID();
  const acquired = await redis.set(lockKey, token, 'EX', PLAYER_STATE_LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') {
    throw new Error(`获取 Redis 锁失败: ${lockKey}`);
  }
  try {
    return await task();
  } finally {
    await releaseLock(lockKey, token);
  }
};

const readMeta = async (characterId: number): Promise<PlayerStateMeta | null> => {
  const raw = await redis.hgetall(playerStateMetaKey(characterId));
  if (Object.keys(raw).length <= 0) return null;
  return {
    version: parseInteger(raw.version, 1),
    dirtyCharacter: parseBoolean(raw.dirtyCharacter, false),
    dirtyInventory: parseBoolean(raw.dirtyInventory, false),
    hydratedAt: typeof raw.hydratedAt === 'string' && raw.hydratedAt ? raw.hydratedAt : new Date().toISOString(),
    lastFlushAt: typeof raw.lastFlushAt === 'string' && raw.lastFlushAt ? raw.lastFlushAt : null,
  };
};

const writeMeta = async (characterId: number, meta: PlayerStateMeta): Promise<void> => {
  await redis.hmset(playerStateMetaKey(characterId), {
    version: String(meta.version),
    dirtyCharacter: meta.dirtyCharacter ? '1' : '0',
    dirtyInventory: meta.dirtyInventory ? '1' : '0',
    hydratedAt: meta.hydratedAt,
    lastFlushAt: meta.lastFlushAt ?? '',
  });
};

const bumpMetaVersion = async (characterId: number, patch: {
  dirtyCharacter?: boolean;
  dirtyInventory?: boolean;
}): Promise<PlayerStateMeta> => {
  const meta = (await readMeta(characterId)) ?? buildDefaultMeta();
  const nextMeta: PlayerStateMeta = {
    ...meta,
    version: Math.max(1, meta.version + 1),
    dirtyCharacter: patch.dirtyCharacter ?? meta.dirtyCharacter,
    dirtyInventory: patch.dirtyInventory ?? meta.dirtyInventory,
  };
  await writeMeta(characterId, nextMeta);
  await redis.sadd(playerStateDirtySetKey(), String(characterId));
  return nextMeta;
};

const resolveCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  const cached = await redis.get(playerStateUserCharacterKey(userId));
  if (cached) {
    const characterId = parseInteger(cached);
    if (characterId > 0) return characterId;
  }

  const result = await query(
    `
      SELECT id
      FROM characters
      WHERE user_id = $1
      LIMIT 1
    `,
    [userId],
  );
  if (result.rows.length <= 0) return null;
  const characterId = parseInteger((result.rows[0] as Record<string, unknown>).id);
  if (characterId <= 0) return null;
  await redis.set(playerStateUserCharacterKey(userId), String(characterId));
  return characterId;
};

const hydrateCharacterState = async (characterId: number): Promise<PlayerCharacterState> => {
  const result = await query(
    `
      SELECT
        ${CHARACTER_BASE_COLUMNS_SQL},
        stamina_recover_at,
        last_offline_at
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [characterId],
  );
  if (result.rows.length <= 0) {
    throw new Error(`角色不存在: ${characterId}`);
  }
  return normalizeCharacterStateRow(result.rows[0] as Record<string, unknown>);
};

const hydrateInventoryStates = async (characterId: number): Promise<PlayerInventoryItemState[]> => {
  const result = await query(
    `
      SELECT *
      FROM item_instance
      WHERE owner_character_id = $1
    `,
    [characterId],
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => normalizeInventoryItemRow(row));
};

const writeHydratedState = async (
  characterState: PlayerCharacterState,
  inventoryStates: PlayerInventoryItemState[],
): Promise<void> => {
  const inventoryKey = playerStateInventoryKey(characterState.id);
  const transaction = redis.multi();
  transaction.set(playerStateCharacterKey(characterState.id), serialize(characterState));
  transaction.set(playerStateUserCharacterKey(characterState.user_id), String(characterState.id));
  transaction.del(inventoryKey);
  for (const item of inventoryStates) {
    transaction.hset(inventoryKey, String(item.id), serialize(item));
  }
  const meta = buildDefaultMeta();
  transaction.hmset(playerStateMetaKey(characterState.id), {
    version: String(meta.version),
    dirtyCharacter: '0',
    dirtyInventory: '0',
    hydratedAt: meta.hydratedAt,
    lastFlushAt: '',
  });
  await transaction.exec();
};

export const ensurePlayerStateHydratedByCharacterId = async (characterIdRaw: number): Promise<number> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const existing = await redis.exists(playerStateCharacterKey(characterId));
  if (existing > 0) return characterId;

  const lockKey = playerStateHydrateLockKey(characterId);
  try {
    await withRedisLock(lockKey, async () => {
      const current = await redis.exists(playerStateCharacterKey(characterId));
      if (current > 0) return;
      const [characterState, inventoryStates] = await Promise.all([
        hydrateCharacterState(characterId),
        hydrateInventoryStates(characterId),
      ]);
      await writeHydratedState(characterState, inventoryStates);
    });
  } catch (error) {
    for (let index = 0; index < PLAYER_STATE_HYDRATE_MAX_WAIT_TIMES; index += 1) {
      const current = await redis.exists(playerStateCharacterKey(characterId));
      if (current > 0) return characterId;
      await sleep(PLAYER_STATE_HYDRATE_WAIT_MS);
    }
    throw error;
  }

  return characterId;
};

export const ensurePlayerStateHydratedByUserId = async (userIdRaw: number): Promise<number | null> => {
  const userId = ensurePositiveInteger(userIdRaw);
  const characterId = await resolveCharacterIdByUserId(userId);
  if (!characterId) return null;
  await ensurePlayerStateHydratedByCharacterId(characterId);
  return characterId;
};

export const loadPlayerCharacterStateByCharacterId = async (
  characterIdRaw: number,
): Promise<PlayerCharacterState | null> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  await ensurePlayerStateHydratedByCharacterId(characterId);
  const raw = await redis.get(playerStateCharacterKey(characterId));
  return raw ? deserializeCharacter(raw) : null;
};

export const loadPlayerCharacterStateByUserId = async (
  userIdRaw: number,
): Promise<PlayerCharacterState | null> => {
  const characterId = await ensurePlayerStateHydratedByUserId(userIdRaw);
  if (!characterId) return null;
  return loadPlayerCharacterStateByCharacterId(characterId);
};

export const patchPlayerCharacterState = async (
  characterIdRaw: number,
  patch: PlayerCharacterStatePatch,
): Promise<PlayerCharacterState> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  return withPlayerStateMutex(characterId, async () => {
    const current = await loadPlayerCharacterStateByCharacterId(characterId);
    if (!current) {
      throw new Error(`角色不存在: ${characterId}`);
    }
    const nextState: PlayerCharacterState = {
      ...current,
      ...patch,
    };
    await redis.set(playerStateCharacterKey(characterId), serialize(nextState));
    await bumpMetaVersion(characterId, { dirtyCharacter: true });
    return nextState;
  });
};

export const loadPlayerInventoryStatesByCharacterId = async (
  characterIdRaw: number,
): Promise<PlayerInventoryItemState[]> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  await ensurePlayerStateHydratedByCharacterId(characterId);
  const rawMap = await redis.hgetall(playerStateInventoryKey(characterId));
  return Object.values(rawMap).map((raw) => deserializeInventoryItem(raw));
};

export const loadPlayerInventoryStateByItemId = async (
  characterIdRaw: number,
  itemIdRaw: number,
): Promise<PlayerInventoryItemState | null> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const itemId = ensurePositiveInteger(itemIdRaw);
  await ensurePlayerStateHydratedByCharacterId(characterId);
  const raw = await redis.hget(playerStateInventoryKey(characterId), String(itemId));
  return raw ? deserializeInventoryItem(raw) : null;
};

export const upsertPlayerInventoryState = async (
  characterIdRaw: number,
  nextState: PlayerInventoryItemState,
): Promise<PlayerInventoryItemState> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  return withPlayerStateMutex(characterId, async () => {
    await ensurePlayerStateHydratedByCharacterId(characterId);
    const normalizedState: PlayerInventoryItemState = {
      ...nextState,
      owner_character_id: characterId,
    };
    await redis.hset(
      playerStateInventoryKey(characterId),
      String(normalizedState.id),
      serialize(normalizedState),
    );
    await bumpMetaVersion(characterId, { dirtyInventory: true });
    return normalizedState;
  });
};

export const patchPlayerInventoryState = async (
  characterIdRaw: number,
  itemIdRaw: number,
  patch: PlayerInventoryItemStatePatch,
  fallbackBase?: PlayerInventoryItemState,
): Promise<PlayerInventoryItemState> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const itemId = ensurePositiveInteger(itemIdRaw);
  return withPlayerStateMutex(characterId, async () => {
    const current =
      (await loadPlayerInventoryStateByItemId(characterId, itemId)) ??
      (fallbackBase ? { ...fallbackBase, owner_character_id: characterId } : null);
    if (!current) {
      throw new Error(`物品不存在: ${itemId}`);
    }
    return upsertPlayerInventoryState(characterId, {
      ...current,
      ...patch,
      id: itemId,
      owner_user_id: current.owner_user_id,
      owner_character_id: characterId,
    });
  });
};

export const deletePlayerInventoryState = async (
  characterIdRaw: number,
  itemIdRaw: number,
): Promise<void> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const itemId = ensurePositiveInteger(itemIdRaw);
  await withPlayerStateMutex(characterId, async () => {
    await ensurePlayerStateHydratedByCharacterId(characterId);
    await redis.hdel(playerStateInventoryKey(characterId), String(itemId));
    await bumpMetaVersion(characterId, { dirtyInventory: true });
  });
};

export const loadPlayerStateMetaByCharacterId = async (
  characterIdRaw: number,
): Promise<PlayerStateMeta | null> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  await ensurePlayerStateHydratedByCharacterId(characterId);
  return readMeta(characterId);
};

export const markPlayerStateFlushedIfVersionUnchanged = async (
  characterIdRaw: number,
  version: number,
): Promise<boolean> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const meta = await readMeta(characterId);
  if (!meta) return false;
  const now = new Date().toISOString();
  if (meta.version !== version) {
    await writeMeta(characterId, {
      ...meta,
      lastFlushAt: now,
    });
    return false;
  }
  await writeMeta(characterId, {
    ...meta,
    dirtyCharacter: false,
    dirtyInventory: false,
    lastFlushAt: now,
  });
  await redis.srem(playerStateDirtySetKey(), String(characterId));
  return true;
};

export const loadDirtyPlayerStateCharacterIds = async (): Promise<number[]> => {
  const members = await redis.smembers(playerStateDirtySetKey());
  return members
    .map((member) => parseInteger(member))
    .filter((characterId) => characterId > 0)
    .sort((left, right) => left - right);
};

export const withPlayerStateFlushLock = async <T>(
  characterIdRaw: number,
  task: () => Promise<T>,
): Promise<T> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  return withRedisLock(playerStateFlushLockKey(characterId), task);
};

export const clearPlayerStateForTests = async (characterIdRaw: number): Promise<void> => {
  const characterId = ensurePositiveInteger(characterIdRaw);
  const character = await loadPlayerCharacterStateByCharacterId(characterId);
  const multi = redis.multi();
  multi.del(playerStateCharacterKey(characterId));
  multi.del(playerStateInventoryKey(characterId));
  multi.del(playerStateMetaKey(characterId));
  multi.srem(playerStateDirtySetKey(), String(characterId));
  if (character) {
    multi.del(playerStateUserCharacterKey(character.user_id));
  }
  await multi.exec();
};
