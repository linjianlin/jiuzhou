/**
 * 玩家状态兼容入口
 *
 * 作用：
 * 1. 做什么：把旧的玩家写回缓存 API 收口到 Redis 主状态仓库，避免业务服务一次性改名导致改动面失控。
 * 2. 做什么：统一提供角色/物品状态读取、patch、flush 和生命周期调度能力。
 * 3. 不做什么：不再保存进程内玩家主状态；进程内只保留运行时版本号用于本地派生缓存签名失效。
 *
 * 输入/输出：
 * - 输入：角色 ID、用户 ID、角色 patch、物品 patch。
 * - 输出：Redis 主状态中的角色与物品状态，以及按角色/全量 flush 行为。
 *
 * 数据流/状态流：
 * 业务服务 -> 本兼容入口 -> playerStateRepository -> Redis
 * 定时/下线/关服 -> playerStateFlushService -> PostgreSQL。
 *
 * 关键边界条件与坑点：
 * 1. 所有角色/物品 patch 都必须 await；否则后续读取可能抢在 Redis 更新完成前执行。
 * 2. 运行时版本号只用于本地静态缓存签名，不是玩家状态真相，不能代替 Redis 主状态。
 */
import {
  flushAllPlayerStates,
  flushPlayerStateByCharacterId,
} from './playerStateFlushService.js';
import {
  deletePlayerInventoryState,
  ensurePlayerStateHydratedByCharacterId,
  loadDirtyPlayerStateCharacterIds,
  loadPlayerCharacterStateByCharacterId,
  loadPlayerCharacterStateByUserId,
  loadPlayerInventoryStateByItemId,
  loadPlayerInventoryStatesByCharacterId,
  patchPlayerCharacterState,
  patchPlayerInventoryState,
  upsertPlayerInventoryState,
} from './playerStateRepository.js';
import { withPlayerStateMutex } from './playerStateMutex.js';
import type {
  PlayerCharacterState,
  PlayerCharacterStatePatch,
  PlayerInventoryItemState,
  PlayerInventoryItemStatePatch,
  PlayerStateJsonValue,
} from './playerStateTypes.js';

const PLAYER_WRITEBACK_FLUSH_INTERVAL_MS = 5_000;

type CharacterWritebackSnapshot = PlayerCharacterStatePatch;
type CharacterWritebackRow = PlayerCharacterState;
type InventoryWritebackBaseSnapshot = {
  id: number;
  owner_user_id?: number;
  owner_character_id: number;
  item_def_id: string;
  qty: number;
  location: string;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number | null;
  refine_level: number | null;
  affixes: PlayerStateJsonValue;
  affix_gen_version: number | null;
  affix_roll_meta?: PlayerStateJsonValue;
  locked?: boolean;
  quality?: string | null;
  quality_rank?: number | null;
  socketed_gems?: PlayerStateJsonValue;
  identified?: boolean | null;
  bind_type?: string | null;
  bind_owner_user_id?: number | null;
  bind_owner_character_id?: number | null;
  random_seed?: number | null;
  custom_name?: string | null;
  expire_at?: string | null;
  obtained_from?: string | null;
  obtained_ref_id?: string | null;
  metadata?: PlayerStateJsonValue;
  created_at?: string | null;
};
type InventoryWritebackNextSnapshot = PlayerInventoryItemState;
type InventoryWritebackPatch = PlayerInventoryItemStatePatch;

type PendingInventoryState = {
  base: InventoryWritebackBaseSnapshot;
  next: InventoryWritebackNextSnapshot | null;
};

const characterRuntimeVersions = new Map<number, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const isPositiveInteger = (value: number): boolean => {
  return Number.isInteger(value) && value > 0;
};

const bumpCharacterRuntimeVersion = (characterId: number): void => {
  characterRuntimeVersions.set(characterId, (characterRuntimeVersions.get(characterId) ?? 0) + 1);
};

const cancelFlushTimer = (): void => {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
};

const scheduleFlushTimer = (): void => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAllPlayerWriteback().catch((error: unknown) => {
      console.error('[playerWritebackCacheService] 定时 flush 失败:', error);
    });
  }, PLAYER_WRITEBACK_FLUSH_INTERVAL_MS);
};

export const queueCharacterWritebackSnapshot = async (
  characterId: number,
  snapshot: CharacterWritebackSnapshot,
): Promise<void> => {
  if (!isPositiveInteger(characterId)) return;
  await patchPlayerCharacterState(characterId, snapshot);
  bumpCharacterRuntimeVersion(characterId);
  scheduleFlushTimer();
};

export const getPendingCharacterWritebackSnapshot = async (
  characterId: number,
): Promise<CharacterWritebackSnapshot | null> => {
  if (!isPositiveInteger(characterId)) return null;
  const state = await loadPlayerCharacterStateByCharacterId(characterId);
  if (!state) return null;
  return { ...state };
};

export const applyPendingCharacterWriteback = async <TRow extends { id?: unknown }>(
  row: TRow,
): Promise<TRow> => {
  const characterId = Number(row.id);
  if (!isPositiveInteger(characterId)) return row;
  const state = await loadPlayerCharacterStateByCharacterId(characterId);
  if (!state) return row;
  return {
    ...row,
    ...state,
  };
};

export const loadCharacterWritebackRowByCharacterId = async (
  characterId: number,
  options?: { forUpdate?: boolean },
): Promise<CharacterWritebackRow | null> => {
  if (!isPositiveInteger(characterId)) return null;
  if (options?.forUpdate === true) {
    return withPlayerStateMutex(characterId, async () => {
      return loadPlayerCharacterStateByCharacterId(characterId);
    });
  }
  return loadPlayerCharacterStateByCharacterId(characterId);
};

export const loadCharacterWritebackRowByUserId = async (
  userId: number,
  options?: { forUpdate?: boolean },
): Promise<CharacterWritebackRow | null> => {
  if (!isPositiveInteger(Math.floor(Number(userId)))) return null;
  const state = await loadPlayerCharacterStateByUserId(userId);
  if (!state) return null;
  if (options?.forUpdate === true) {
    return withPlayerStateMutex(state.id, async () => {
      return loadPlayerCharacterStateByCharacterId(state.id);
    });
  }
  return state;
};

export const queueInventoryItemWritebackSnapshot = async (
  characterId: number,
  base: InventoryWritebackBaseSnapshot,
  nextPatch: InventoryWritebackPatch | null,
): Promise<void> => {
  if (!isPositiveInteger(characterId) || !isPositiveInteger(base.id)) return;
  await ensurePlayerStateHydratedByCharacterId(characterId);
  if (nextPatch === null) {
    await deletePlayerInventoryState(characterId, base.id);
  } else {
    const current = await loadPlayerInventoryStateByItemId(characterId, base.id);
    if (current) {
      await patchPlayerInventoryState(characterId, base.id, nextPatch);
    } else {
      await upsertPlayerInventoryState(characterId, {
        ...base,
        owner_user_id: base.owner_user_id ?? 0,
        locked: base.locked ?? false,
        quality: base.quality ?? null,
        quality_rank: base.quality_rank ?? null,
        socketed_gems: base.socketed_gems ?? [],
        affix_roll_meta: base.affix_roll_meta ?? {},
        identified: base.identified ?? null,
        bind_type: base.bind_type ?? null,
        bind_owner_user_id: base.bind_owner_user_id ?? null,
        bind_owner_character_id: base.bind_owner_character_id ?? null,
        random_seed: base.random_seed ?? null,
        custom_name: base.custom_name ?? null,
        expire_at: base.expire_at ?? null,
        obtained_from: base.obtained_from ?? null,
        obtained_ref_id: base.obtained_ref_id ?? null,
        metadata: base.metadata ?? {},
        created_at: base.created_at ?? null,
        ...nextPatch,
        owner_character_id: characterId,
      });
    }
  }
  bumpCharacterRuntimeVersion(characterId);
  scheduleFlushTimer();
};

export const getPlayerWritebackRuntimeVersion = (characterId: number): number => {
  if (!isPositiveInteger(characterId)) return 0;
  return characterRuntimeVersions.get(characterId) ?? 0;
};

export const getPendingInventoryItemState = async (
  characterId: number,
  itemId: number,
): Promise<PendingInventoryState | null> => {
  if (!isPositiveInteger(characterId) || !isPositiveInteger(itemId)) return null;
  const item = await loadPlayerInventoryStateByItemId(characterId, itemId);
  if (!item) return null;
  return {
    base: item,
    next: item,
  };
};

export const applyPendingInventoryItemWritebackRows = async <TRow extends { id?: unknown }>(
  characterId: number,
  rows: TRow[],
): Promise<TRow[]> => {
  if (!isPositiveInteger(characterId) || rows.length <= 0) return rows;
  const stateRows = await loadPlayerInventoryStatesByCharacterId(characterId);
  const stateMap = new Map(stateRows.map((row) => [row.id, row] as const));
  const output: TRow[] = [];
  for (const row of rows) {
    const itemId = Number(row.id);
    if (!isPositiveInteger(itemId)) {
      output.push(row);
      continue;
    }
    const state = stateMap.get(itemId);
    if (!state) continue;
    output.push({
      ...row,
      ...state,
    });
  }
  return output;
};

export const applyPendingInventoryItemWritebackRow = async <TRow extends { id?: unknown }>(
  characterId: number,
  row: TRow | null,
): Promise<TRow | null> => {
  if (!row) return null;
  const rows = await applyPendingInventoryItemWritebackRows(characterId, [row]);
  return rows[0] ?? null;
};

export const applyPendingInventoryUsageToInfo = async <TInfo extends {
  bag_used?: unknown;
  warehouse_used?: unknown;
}>(
  characterId: number,
  info: TInfo,
): Promise<TInfo> => {
  if (!isPositiveInteger(characterId)) return info;
  const items = await loadPlayerInventoryStatesByCharacterId(characterId);
  let bagUsed = 0;
  let warehouseUsed = 0;
  for (const item of items) {
    if (item.location === 'bag') bagUsed += 1;
    if (item.location === 'warehouse') warehouseUsed += 1;
  }
  return {
    ...info,
    bag_used: bagUsed,
    warehouse_used: warehouseUsed,
  };
};

export const applyPendingInventoryItemTotal = async (
  characterId: number,
  location: string,
  _total: number,
): Promise<number> => {
  if (!isPositiveInteger(characterId)) return 0;
  const items = await loadPlayerInventoryStatesByCharacterId(characterId);
  return items.filter((item) => item.location === location).length;
};

export const flushPlayerWritebackByCharacterId = async (
  characterId: number,
): Promise<void> => {
  if (!isPositiveInteger(characterId)) return;
  await flushPlayerStateByCharacterId(characterId);
};

export const flushAllPlayerWriteback = async (): Promise<void> => {
  await flushAllPlayerStates();
  const dirtyCharacterIds = await loadDirtyPlayerStateCharacterIds();
  if (dirtyCharacterIds.length <= 0) {
    cancelFlushTimer();
    return;
  }
  scheduleFlushTimer();
};

export const startPlayerWritebackFlushLoop = (): void => {
  scheduleFlushTimer();
};

export const stopPlayerWritebackFlushLoop = (): void => {
  cancelFlushTimer();
};

export const resetPlayerWritebackStateForTests = (): void => {
  cancelFlushTimer();
  characterRuntimeVersions.clear();
};
