/**
 * 角色资源结算 Delta 聚合服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把角色 `exp/silver/spirit_stones` 的正负增量先合并到 Redis，再由后台批量 flush 到 `characters`，避免高频战斗、消耗、退款每次都直写数据库。
 * 2. 做什么：通过 `main -> inflight` 原子切换，把“继续接收新增量”和“后台批量落库”拆成两段，保证同一角色 100 场战斗会先在缓存层合并，而不是变成 100 次写库。
 * 3. 不做什么：不处理背包实例、装备实例、邮件附件，也不负责任务/主线/成就的增量模型；这些需要独立的 Delta 承载协议。
 *
 * 输入 / 输出：
 * - 输入：按角色聚合后的资源增量。
 * - 输出：无直接业务返回；副作用是把增量写入 Redis，并在 flush 时批量更新 `characters` 表。
 *
 * 数据流 / 状态流：
 * 业务事务提交 -> `bufferCharacterSettlementResourceDeltas`
 * -> Redis `hash + dirty set` 合并增量
 * -> 后台 flush loop 把 `main` key 原子改名为 `inflight`
 * -> 批量 `UPDATE characters`
 * -> 成功删除 inflight，失败再把 inflight 增量回滚合并到 main。
 *
 * 复用设计说明：
 * 1. 角色资源结算原先散落在 battle/task/bounty 等多条链路里统一调用 `applyCharacterRewardDeltas`，现在收敛到本模块后，这些入口自动复用同一套 Redis 合并与批量落库协议。
 * 2. 高频变化点是“哪些结算会产生资源增量”，不是 flush 算法本身，因此把缓存合并、批量 claim、失败回滚集中在这里最能减少后续重复维护。
 *
 * 关键边界条件与坑点：
 * 1. flush 过程中如果先删 Redis 再写 DB，一旦 DB 失败就会丢账，所以必须先 `RENAME` 到 inflight，再根据 DB 成败决定删除或回滚合并。
 * 2. 读取角色面板时必须同时叠加 `main + inflight` 两份增量，否则 flush 窗口内会出现前端看到旧资源值的裂缝。
 */
import { query } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { createScopedLogger } from '../../utils/logger.js';

export type CharacterSettlementResourceDelta = {
  exp: number;
  silver: number;
  spiritStones: number;
};

export type CharacterSettlementResourceSnapshot = {
  exp: number;
  silver: number;
  spiritStones: number;
};

export type CharacterSettlementCurrencyExactDelta = {
  silver: bigint;
  spiritStones: bigint;
};

export type CharacterSettlementCurrencyExactSnapshot = {
  silver: bigint;
  spiritStones: bigint;
};

type FlushOptions = {
  drainAll?: boolean;
  limit?: number;
};

type StartupInflightRecoveryTask = {
  dirtyIndexKey: string;
  buildInflightKey: (characterId: number) => string;
  restoreClaimedDelta: (characterId: number) => Promise<void>;
};

type ClaimedCharacterDelta = {
  characterId: number;
  delta: CharacterSettlementResourceDelta;
};

type ClaimedCharacterExactDelta = {
  characterId: number;
  delta: CharacterSettlementCurrencyExactDelta;
};

type CharacterResourceBaseRow = {
  exp: number | string | null;
  silver: number | string | null;
  spirit_stones: number | string | null;
};

const RESOURCE_DELTA_DIRTY_INDEX_KEY = 'character:settlement-delta:resource:index';
const RESOURCE_DELTA_KEY_PREFIX = 'character:settlement-delta:resource:';
const RESOURCE_DELTA_INFLIGHT_KEY_PREFIX = 'character:settlement-delta:resource:inflight:';
const RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY = 'character:settlement-delta:resource-exact:index';
const RESOURCE_EXACT_DELTA_KEY_PREFIX = 'character:settlement-delta:resource-exact:';
const RESOURCE_EXACT_DELTA_INFLIGHT_KEY_PREFIX = 'character:settlement-delta:resource-exact:inflight:';
const RESOURCE_DELTA_FLUSH_INTERVAL_MS = 1_000;
const RESOURCE_DELTA_FLUSH_BATCH_LIMIT = 200;
const resourceDeltaLogger = createScopedLogger('characterSettlement.resourceDelta');

let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushInFlight: Promise<void> | null = null;

const buildResourceDeltaKey = (characterId: number): string =>
  `${RESOURCE_DELTA_KEY_PREFIX}${characterId}`;

const buildInflightResourceDeltaKey = (characterId: number): string =>
  `${RESOURCE_DELTA_INFLIGHT_KEY_PREFIX}${characterId}`;

const buildResourceExactDeltaKey = (characterId: number): string =>
  `${RESOURCE_EXACT_DELTA_KEY_PREFIX}${characterId}`;

const buildInflightResourceExactDeltaKey = (characterId: number): string =>
  `${RESOURCE_EXACT_DELTA_INFLIGHT_KEY_PREFIX}${characterId}`;

const normalizeDeltaValue = (value: number | undefined): number => {
  const normalized = Math.floor(Number(value ?? 0));
  if (!Number.isFinite(normalized)) return 0;
  return normalized;
};

const parseBigIntValue = (value: string | number | bigint | null | undefined): bigint => {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0n;
    return BigInt(Math.trunc(value));
  }
  const normalized = String(value).trim();
  if (!normalized) return 0n;
  try {
    return BigInt(normalized);
  } catch {
    return 0n;
  }
};

const hasDelta = (delta: CharacterSettlementResourceDelta): boolean =>
  delta.exp !== 0 || delta.silver !== 0 || delta.spiritStones !== 0;

const normalizeDelta = (delta: Partial<CharacterSettlementResourceDelta>): CharacterSettlementResourceDelta => ({
  exp: normalizeDeltaValue(delta.exp),
  silver: normalizeDeltaValue(delta.silver),
  spiritStones: normalizeDeltaValue(delta.spiritStones),
});

const parseRedisDeltaHash = (hash: Record<string, string>): CharacterSettlementResourceDelta => ({
  exp: normalizeDeltaValue(Number(hash.exp ?? 0)),
  silver: normalizeDeltaValue(Number(hash.silver ?? 0)),
  spiritStones: normalizeDeltaValue(Number(hash.spiritStones ?? 0)),
});

const hasExactDelta = (delta: CharacterSettlementCurrencyExactDelta): boolean =>
  delta.silver !== 0n || delta.spiritStones !== 0n;

const parseRedisExactDeltaHash = (hash: Record<string, string>): CharacterSettlementCurrencyExactDelta => ({
  silver: parseBigIntValue(hash.silver),
  spiritStones: parseBigIntValue(hash.spiritStones),
});

const claimResourceDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

if redis.call('EXISTS', inflightKey) == 1 then
  return 0
end

if redis.call('EXISTS', mainKey) == 0 then
  redis.call('SREM', dirtyIndexKey, characterId)
  return 0
end

redis.call('RENAME', mainKey, inflightKey)
return 1
`;

const finalizeClaimedResourceDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

redis.call('DEL', inflightKey)
if redis.call('EXISTS', mainKey) == 1 then
  redis.call('SADD', dirtyIndexKey, characterId)
else
  redis.call('SREM', dirtyIndexKey, characterId)
end
return 1
`;

const restoreClaimedResourceDeltaLua = `
local dirtyIndexKey = KEYS[1]
local mainKey = KEYS[2]
local inflightKey = KEYS[3]
local characterId = ARGV[1]

local inflightValues = redis.call('HGETALL', inflightKey)
if next(inflightValues) == nil then
  if redis.call('EXISTS', mainKey) == 1 then
    redis.call('SADD', dirtyIndexKey, characterId)
  else
    redis.call('SREM', dirtyIndexKey, characterId)
  end
  return 0
end

for i = 1, #inflightValues, 2 do
  redis.call('HINCRBY', mainKey, inflightValues[i], tonumber(inflightValues[i + 1]))
end
redis.call('DEL', inflightKey)
redis.call('SADD', dirtyIndexKey, characterId)
return 1
`;

export const loadCharacterSettlementResourceDeltaMap = async (
  characterIds: readonly number[],
): Promise<Map<number, CharacterSettlementResourceDelta>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  const deltaByCharacterId = new Map<number, CharacterSettlementResourceDelta>();
  if (normalizedCharacterIds.length <= 0) {
    return deltaByCharacterId;
  }

  const pipeline = redis.pipeline();
  for (const characterId of normalizedCharacterIds) {
    pipeline.hgetall(buildResourceDeltaKey(characterId));
    pipeline.hgetall(buildInflightResourceDeltaKey(characterId));
  }
  const results = await pipeline.exec();
  if (!results) {
    return deltaByCharacterId;
  }

  normalizedCharacterIds.forEach((characterId, index) => {
    const mainResult = results[index * 2]?.[1];
    const inflightResult = results[index * 2 + 1]?.[1];
    const mainDelta = parseRedisDeltaHash(
      mainResult && typeof mainResult === 'object' ? (mainResult as Record<string, string>) : {},
    );
    const inflightDelta = parseRedisDeltaHash(
      inflightResult && typeof inflightResult === 'object' ? (inflightResult as Record<string, string>) : {},
    );
    const mergedDelta = normalizeDelta({
      exp: mainDelta.exp + inflightDelta.exp,
      silver: mainDelta.silver + inflightDelta.silver,
      spiritStones: mainDelta.spiritStones + inflightDelta.spiritStones,
    });
    if (!hasDelta(mergedDelta)) {
      return;
    }
    deltaByCharacterId.set(characterId, mergedDelta);
  });

  return deltaByCharacterId;
};

export const loadCharacterSettlementResourceSnapshot = async (
  characterId: number,
  options: { forUpdate?: boolean } = {},
): Promise<CharacterSettlementResourceSnapshot | null> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return null;
  }

  const result = await query<CharacterResourceBaseRow>(
    `
      SELECT exp, silver, spirit_stones
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${options.forUpdate === true ? 'FOR UPDATE' : ''}
    `,
    [normalizedCharacterId],
  );
  if (result.rows.length <= 0) {
    return null;
  }

  const baseRow = result.rows[0];
  const deltaMap = await loadCharacterSettlementResourceDeltaMap([normalizedCharacterId]);
  const pendingDelta = deltaMap.get(normalizedCharacterId);

  return {
    exp: normalizeDeltaValue(Number(baseRow.exp ?? 0)) + (pendingDelta?.exp ?? 0),
    silver: normalizeDeltaValue(Number(baseRow.silver ?? 0)) + (pendingDelta?.silver ?? 0),
    spiritStones: normalizeDeltaValue(Number(baseRow.spirit_stones ?? 0)) + (pendingDelta?.spiritStones ?? 0),
  };
};

export const loadCharacterSettlementCurrencyExactSnapshot = async (
  characterId: number,
  options: { forUpdate?: boolean } = {},
): Promise<CharacterSettlementCurrencyExactSnapshot | null> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return null;
  }

  const result = await query<CharacterResourceBaseRow>(
    `
      SELECT silver, spirit_stones
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${options.forUpdate === true ? 'FOR UPDATE' : ''}
    `,
    [normalizedCharacterId],
  );
  if (result.rows.length <= 0) {
    return null;
  }

  const [numberDeltaMap, exactDeltaMap] = await Promise.all([
    loadCharacterSettlementResourceDeltaMap([normalizedCharacterId]),
    loadCharacterSettlementCurrencyExactDeltaMap([normalizedCharacterId]),
  ]);
  const numberDelta = numberDeltaMap.get(normalizedCharacterId);
  const exactDelta = exactDeltaMap.get(normalizedCharacterId);
  const baseRow = result.rows[0];

  return {
    silver:
      parseBigIntValue(baseRow.silver)
      + BigInt(numberDelta?.silver ?? 0)
      + (exactDelta?.silver ?? 0n),
    spiritStones:
      parseBigIntValue(baseRow.spirit_stones)
      + BigInt(numberDelta?.spiritStones ?? 0)
      + (exactDelta?.spiritStones ?? 0n),
  };
};

export const bufferCharacterSettlementResourceDeltas = async (
  rewardMap: Map<number, CharacterSettlementResourceDelta>,
): Promise<void> => {
  if (rewardMap.size <= 0) return;

  const multi = redis.multi();
  let deltaCount = 0;
  for (const [characterId, rawDelta] of rewardMap.entries()) {
    if (!Number.isInteger(characterId) || characterId <= 0) continue;
    const delta = normalizeDelta(rawDelta);
    if (!hasDelta(delta)) continue;

    const key = buildResourceDeltaKey(characterId);
    multi.hincrby(key, 'exp', delta.exp);
    multi.hincrby(key, 'silver', delta.silver);
    multi.hincrby(key, 'spiritStones', delta.spiritStones);
    multi.sadd(RESOURCE_DELTA_DIRTY_INDEX_KEY, String(characterId));
    deltaCount += 1;
  }
  if (deltaCount <= 0) return;

  await multi.exec();
};

export const loadCharacterSettlementCurrencyExactDeltaMap = async (
  characterIds: readonly number[],
): Promise<Map<number, CharacterSettlementCurrencyExactDelta>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  const deltaByCharacterId = new Map<number, CharacterSettlementCurrencyExactDelta>();
  if (normalizedCharacterIds.length <= 0) {
    return deltaByCharacterId;
  }

  const pipeline = redis.pipeline();
  for (const characterId of normalizedCharacterIds) {
    pipeline.hgetall(buildResourceExactDeltaKey(characterId));
    pipeline.hgetall(buildInflightResourceExactDeltaKey(characterId));
  }
  const results = await pipeline.exec();
  if (!results) {
    return deltaByCharacterId;
  }

  normalizedCharacterIds.forEach((characterId, index) => {
    const mainResult = results[index * 2]?.[1];
    const inflightResult = results[index * 2 + 1]?.[1];
    const mainDelta = parseRedisExactDeltaHash(
      mainResult && typeof mainResult === 'object' ? (mainResult as Record<string, string>) : {},
    );
    const inflightDelta = parseRedisExactDeltaHash(
      inflightResult && typeof inflightResult === 'object' ? (inflightResult as Record<string, string>) : {},
    );
    const mergedDelta: CharacterSettlementCurrencyExactDelta = {
      silver: mainDelta.silver + inflightDelta.silver,
      spiritStones: mainDelta.spiritStones + inflightDelta.spiritStones,
    };
    if (!hasExactDelta(mergedDelta)) {
      return;
    }
    deltaByCharacterId.set(characterId, mergedDelta);
  });

  return deltaByCharacterId;
};

export const bufferCharacterSettlementCurrencyExactDeltas = async (
  rewardMap: Map<number, CharacterSettlementCurrencyExactDelta>,
): Promise<void> => {
  if (rewardMap.size <= 0) return;

  const multi = redis.multi();
  let deltaCount = 0;
  for (const [characterId, rawDelta] of rewardMap.entries()) {
    if (!Number.isInteger(characterId) || characterId <= 0) continue;
    const delta: CharacterSettlementCurrencyExactDelta = {
      silver: parseBigIntValue(rawDelta.silver),
      spiritStones: parseBigIntValue(rawDelta.spiritStones),
    };
    if (!hasExactDelta(delta)) continue;

    const key = buildResourceExactDeltaKey(characterId);
    multi.hincrby(key, 'silver', delta.silver.toString());
    multi.hincrby(key, 'spiritStones', delta.spiritStones.toString());
    multi.sadd(RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY, String(characterId));
    deltaCount += 1;
  }
  if (deltaCount <= 0) return;

  await multi.exec();
};

const claimCharacterResourceDelta = async (
  characterId: number,
): Promise<boolean> => {
  const result = await redis.eval(
    claimResourceDeltaLua,
    3,
    RESOURCE_DELTA_DIRTY_INDEX_KEY,
    buildResourceDeltaKey(characterId),
    buildInflightResourceDeltaKey(characterId),
    String(characterId),
  );
  return Number(result) === 1;
};

const finalizeClaimedCharacterResourceDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    finalizeClaimedResourceDeltaLua,
    3,
    RESOURCE_DELTA_DIRTY_INDEX_KEY,
    buildResourceDeltaKey(characterId),
    buildInflightResourceDeltaKey(characterId),
    String(characterId),
  );
};

const restoreClaimedCharacterResourceDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    restoreClaimedResourceDeltaLua,
    3,
    RESOURCE_DELTA_DIRTY_INDEX_KEY,
    buildResourceDeltaKey(characterId),
    buildInflightResourceDeltaKey(characterId),
    String(characterId),
  );
};

const loadClaimedCharacterResourceDeltas = async (
  characterIds: readonly number[],
): Promise<ClaimedCharacterDelta[]> => {
  const normalizedCharacterIds = characterIds
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0);
  if (normalizedCharacterIds.length <= 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const characterId of normalizedCharacterIds) {
    pipeline.hgetall(buildInflightResourceDeltaKey(characterId));
  }
  const results = await pipeline.exec();
  if (!results) {
    return [];
  }

  const claimedDeltas: ClaimedCharacterDelta[] = [];
  normalizedCharacterIds.forEach((characterId, index) => {
    const hash = results[index]?.[1];
    const delta = parseRedisDeltaHash(
      hash && typeof hash === 'object' ? (hash as Record<string, string>) : {},
    );
    if (!hasDelta(delta)) {
      return;
    }
    claimedDeltas.push({ characterId, delta });
  });
  return claimedDeltas;
};

const claimCharacterResourceExactDelta = async (
  characterId: number,
): Promise<boolean> => {
  const result = await redis.eval(
    claimResourceDeltaLua,
    3,
    RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY,
    buildResourceExactDeltaKey(characterId),
    buildInflightResourceExactDeltaKey(characterId),
    String(characterId),
  );
  return Number(result) === 1;
};

const finalizeClaimedCharacterResourceExactDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    finalizeClaimedResourceDeltaLua,
    3,
    RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY,
    buildResourceExactDeltaKey(characterId),
    buildInflightResourceExactDeltaKey(characterId),
    String(characterId),
  );
};

const restoreClaimedCharacterResourceExactDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    restoreClaimedResourceDeltaLua,
    3,
    RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY,
    buildResourceExactDeltaKey(characterId),
    buildInflightResourceExactDeltaKey(characterId),
    String(characterId),
  );
};

const loadClaimedCharacterResourceExactDeltas = async (
  characterIds: readonly number[],
): Promise<ClaimedCharacterExactDelta[]> => {
  const normalizedCharacterIds = characterIds
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0);
  if (normalizedCharacterIds.length <= 0) {
    return [];
  }

  const pipeline = redis.pipeline();
  for (const characterId of normalizedCharacterIds) {
    pipeline.hgetall(buildInflightResourceExactDeltaKey(characterId));
  }
  const results = await pipeline.exec();
  if (!results) {
    return [];
  }

  const claimedDeltas: ClaimedCharacterExactDelta[] = [];
  normalizedCharacterIds.forEach((characterId, index) => {
    const hash = results[index]?.[1];
    const delta = parseRedisExactDeltaHash(
      hash && typeof hash === 'object' ? (hash as Record<string, string>) : {},
    );
    if (!hasExactDelta(delta)) {
      return;
    }
    claimedDeltas.push({ characterId, delta });
  });
  return claimedDeltas;
};

const applyClaimedCharacterResourceDeltasToDb = async (
  deltas: ClaimedCharacterDelta[],
): Promise<void> => {
  if (deltas.length <= 0) return;

  await query(
    `
      WITH delta_rows AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb)
          AS x(character_id int, exp int, silver int, spirit_stones int)
      )
      UPDATE characters AS c
      SET exp = c.exp + delta_rows.exp,
          silver = c.silver + delta_rows.silver,
          spirit_stones = c.spirit_stones + delta_rows.spirit_stones,
          updated_at = NOW()
      FROM delta_rows
      WHERE c.id = delta_rows.character_id
    `,
    [JSON.stringify(deltas.map((entry) => ({
      character_id: entry.characterId,
      exp: entry.delta.exp,
      silver: entry.delta.silver,
      spirit_stones: entry.delta.spiritStones,
    })))],
  );
};

const applyClaimedCharacterResourceExactDeltasToDb = async (
  deltas: ClaimedCharacterExactDelta[],
): Promise<void> => {
  if (deltas.length <= 0) return;

  await query(
    `
      WITH delta_rows AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb)
          AS x(character_id int, silver text, spirit_stones text)
      )
      UPDATE characters AS c
      SET silver = c.silver + (delta_rows.silver)::bigint,
          spirit_stones = c.spirit_stones + (delta_rows.spirit_stones)::bigint,
          updated_at = NOW()
      FROM delta_rows
      WHERE c.id = delta_rows.character_id
    `,
    [JSON.stringify(deltas.map((entry) => ({
      character_id: entry.characterId,
      silver: entry.delta.silver.toString(),
      spirit_stones: entry.delta.spiritStones.toString(),
    })))],
  );
};

export const flushCharacterSettlementResourceDeltas = async (
  options: FlushOptions = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const batchLimit = Math.max(1, Math.floor(options.limit ?? RESOURCE_DELTA_FLUSH_BATCH_LIMIT));

  do {
    const dirtyCharacterIds = (await redis.srandmember(RESOURCE_DELTA_DIRTY_INDEX_KEY, batchLimit))
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
      .sort((left, right) => left - right);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }

    const claimedCharacterIds: number[] = [];
    for (const characterId of dirtyCharacterIds) {
      if (await claimCharacterResourceDelta(characterId)) {
        claimedCharacterIds.push(characterId);
      }
    }
    if (claimedCharacterIds.length <= 0) {
      if (!drainAll) return;
      continue;
    }

    const claimedDeltas = await loadClaimedCharacterResourceDeltas(claimedCharacterIds);
    if (claimedDeltas.length <= 0) {
      for (const characterId of claimedCharacterIds) {
        await finalizeClaimedCharacterResourceDelta(characterId);
      }
      if (!drainAll) return;
      continue;
    }

    try {
      await applyClaimedCharacterResourceDeltasToDb(claimedDeltas);
      for (const entry of claimedDeltas) {
        await finalizeClaimedCharacterResourceDelta(entry.characterId);
      }
    } catch (error) {
      for (const entry of claimedDeltas) {
        await restoreClaimedCharacterResourceDelta(entry.characterId);
      }
      throw error;
    }
  } while (drainAll);
};

export const flushCharacterSettlementResourceExactDeltas = async (
  options: FlushOptions = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const batchLimit = Math.max(1, Math.floor(options.limit ?? RESOURCE_DELTA_FLUSH_BATCH_LIMIT));

  do {
    const dirtyCharacterIds = (await redis.srandmember(RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY, batchLimit))
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
      .sort((left, right) => left - right);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }

    const claimedCharacterIds: number[] = [];
    for (const characterId of dirtyCharacterIds) {
      if (await claimCharacterResourceExactDelta(characterId)) {
        claimedCharacterIds.push(characterId);
      }
    }
    if (claimedCharacterIds.length <= 0) {
      if (!drainAll) return;
      continue;
    }

    const claimedDeltas = await loadClaimedCharacterResourceExactDeltas(claimedCharacterIds);
    if (claimedDeltas.length <= 0) {
      for (const characterId of claimedCharacterIds) {
        await finalizeClaimedCharacterResourceExactDelta(characterId);
      }
      if (!drainAll) return;
      continue;
    }

    try {
      await applyClaimedCharacterResourceExactDeltasToDb(claimedDeltas);
      for (const entry of claimedDeltas) {
        await finalizeClaimedCharacterResourceExactDelta(entry.characterId);
      }
    } catch (error) {
      for (const entry of claimedDeltas) {
        await restoreClaimedCharacterResourceExactDelta(entry.characterId);
      }
      throw error;
    }
  } while (drainAll);
};

const runFlushLoopOnce = async (): Promise<void> => {
  if (flushInFlight) {
    await flushInFlight;
    return;
  }

  const currentFlush = (async () => {
    await flushCharacterSettlementResourceDeltas();
    await flushCharacterSettlementResourceExactDeltas();
  })().catch((error: Error) => {
    resourceDeltaLogger.error(error, '角色资源结算 Delta flush 失败');
  });
  flushInFlight = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (flushInFlight === currentFlush) {
      flushInFlight = null;
    }
  }
};

/**
 * 启动时恢复旧 inflight 资源 Delta。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：扫描 dirty index 中仍残留 inflight hash 的角色，把异常退出前 claim 走但未 finalize/restore 的增量恢复回 main。
 * 2. 做什么：复用现有 restore Lua，保证恢复语义与正常 flush 失败回滚完全一致。
 * 3. 不做什么：不直接写数据库，不跳过现有 flush 协议，也不扫描不在 dirty index 中的全量 Redis key。
 *
 * 输入 / 输出：
 * - 输入：dirty index key、inflight key 生成器、restore 实现。
 * - 输出：返回本次实际恢复的角色数量。
 *
 * 数据流 / 状态流：
 * dirty index -> EXISTS inflight hash -> restoreClaimedDelta -> main hash + dirty index -> 后续 flush 正常落库。
 *
 * 复用设计说明：
 * - 启动恢复只前移“失败回滚”时机，不新增第二套账本协议，后续 flush 仍然复用同一条链路。
 * - 以 dirty index 为候选集合，避免全量扫描 Redis，降低启动成本与误恢复范围。
 *
 * 关键边界条件与坑点：
 * 1. 只恢复 dirty index 内仍存在 inflight 的角色，避免误碰正常已 finalize 的历史角色。
 * 2. 恢复后仍需跑一次 flush，才能把旧 inflight 重新合并后的 main delta 尽快落表。
 */
const recoverClaimedSettlementInflightByDirtyIndex = async (
  task: StartupInflightRecoveryTask,
): Promise<number> => {
  const dirtyCharacterIds = (await redis.smembers(task.dirtyIndexKey))
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
    .sort((left, right) => left - right);
  if (dirtyCharacterIds.length <= 0) {
    return 0;
  }

  const pipeline = redis.pipeline();
  for (const characterId of dirtyCharacterIds) {
    pipeline.exists(task.buildInflightKey(characterId));
  }
  const existsResults = await pipeline.exec();
  if (!existsResults) {
    return 0;
  }

  let recoveredCount = 0;
  for (const [index, characterId] of dirtyCharacterIds.entries()) {
    const existsValue = Number(existsResults[index]?.[1] ?? 0);
    if (existsValue !== 1) {
      continue;
    }
    await task.restoreClaimedDelta(characterId);
    recoveredCount += 1;
  }

  return recoveredCount;
};

const recoverCharacterSettlementInflightDeltasOnStartup = async (): Promise<void> => {
  const [resourceRecoveredCount, exactRecoveredCount] = await Promise.all([
    recoverClaimedSettlementInflightByDirtyIndex({
      dirtyIndexKey: RESOURCE_DELTA_DIRTY_INDEX_KEY,
      buildInflightKey: buildInflightResourceDeltaKey,
      restoreClaimedDelta: restoreClaimedCharacterResourceDelta,
    }),
    recoverClaimedSettlementInflightByDirtyIndex({
      dirtyIndexKey: RESOURCE_EXACT_DELTA_DIRTY_INDEX_KEY,
      buildInflightKey: buildInflightResourceExactDeltaKey,
      restoreClaimedDelta: restoreClaimedCharacterResourceExactDelta,
    }),
  ]);

  if (resourceRecoveredCount <= 0 && exactRecoveredCount <= 0) {
    return;
  }

  resourceDeltaLogger.warn(
    {
      resourceRecoveredCount,
      exactRecoveredCount,
    },
    '启动时检测到残留 inflight 角色资源 Delta，已回滚到主账本等待重新 flush',
  );
};

export const initializeCharacterSettlementResourceDeltaService = async (): Promise<void> => {
  if (flushTimer) {
    return;
  }

  await recoverCharacterSettlementInflightDeltasOnStartup();

  await runFlushLoopOnce();

  flushTimer = setInterval(() => {
    void runFlushLoopOnce();
  }, RESOURCE_DELTA_FLUSH_INTERVAL_MS);
};

export const shutdownCharacterSettlementResourceDeltaService = async (): Promise<void> => {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  if (flushInFlight) {
    await flushInFlight;
  }

  await flushCharacterSettlementResourceDeltas({ drainAll: true });
  await flushCharacterSettlementResourceExactDeltas({ drainAll: true });
};
