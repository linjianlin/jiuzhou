import { afterTransactionCommit, query, withTransaction } from '../../config/database.js';
import { redis } from '../../config/redis.js';
import { itemService } from '../itemService.js';
import { sendSystemMail, type MailAttachItem } from '../mailService.js';
import type { GenerateOptions, GeneratedEquipment } from '../equipmentService.js';
import { createScopedLogger } from '../../utils/logger.js';
import { lockCharacterInventoryMutex } from '../inventoryMutex.js';
import { createCharacterBagSlotAllocatorFromSession } from './characterBagSlotAllocator.js';
import { createCharacterInventoryMutationContextFromSession } from './characterInventoryMutationContext.js';
import { createInventorySlotSession } from './inventorySlotSession.js';

/**
 * 角色物品授予 Delta 聚合服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把高频奖励链路里的普通物品 / 装备实例创建先聚合到 Redis，后台按角色批量 flush 到真实库存。
 * 2. 做什么：把“背包已满 -> 转系统邮件”从战斗结算热路径移到异步 flush 线程，避免结算线程为 `item_instance` 和邮件表持锁。
 * 3. 不做什么：不负责角色资源增量，也不负责任务/主线/成就推进；这些由独立 Delta 服务处理。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、用户 ID、物品定义、数量、绑定态、获取来源与可序列化装备参数。
 * - 输出：无直接业务返回；副作用是写入 Redis Hash，并在 flush 时落到 `item_instance` / `mail`。
 *
 * 数据流 / 状态流：
 * 业务事务提交 -> `bufferCharacterItemGrantDeltas`
 * -> Redis `hash + dirty set` 合并
 * -> flush worker `main -> inflight`
 * -> 单角色事务内批量 `createItem`
 * -> 背包已满的部分统一转系统邮件
 * -> 成功 finalize / 失败 restore。
 *
 * 复用设计说明：
 * 1. 战斗掉落、秘境结算、后续任务奖励都可以复用同一套“资产先缓存、后台异步入库”的协议，避免每条奖励链路各写一套 Redis 结构。
 * 2. 高频变化点是“哪些场景产出什么物品”，不是 flush 细节，因此把编码、claim、邮件兜底、落库集中在这里最能减少重复维护。
 *
 * 关键边界条件与坑点：
 * 1. 必须按角色 claim，保证同一角色的装备随机生成、背包格子竞争、邮件补发都在单事务里串行完成。
 * 2. `equipOptions.preGeneratedEquipment` 必须一并序列化，否则自动分解判定后保留下来的装备会在 flush 时重新随机，导致前后语义不一致。
 */

type BufferedCharacterItemGrantEquipOptions = GenerateOptions & {
  preGeneratedEquipment?: GeneratedEquipment;
};

type BufferedCharacterItemGrantMetadata = Record<string, string | number | boolean | null | undefined>;

export type BufferedCharacterItemGrant = {
  characterId: number;
  userId: number;
  itemDefId: string;
  qty: number;
  bindType?: string;
  obtainedFrom: string;
  idleSessionId?: string;
  metadata?: BufferedCharacterItemGrantMetadata | null;
  quality?: string | null;
  qualityRank?: number | null;
  equipOptions?: BufferedCharacterItemGrantEquipOptions;
};

export type SimpleBufferedCharacterItemGrant = Omit<
  BufferedCharacterItemGrant,
  'characterId' | 'userId'
>;

type EncodedCharacterItemGrantPayload = {
  userId: number;
  itemDefId: string;
  bindType: string;
  obtainedFrom: string;
  idleSessionId: string | null;
  metadata: BufferedCharacterItemGrantMetadata | null;
  quality: string | null;
  qualityRank: number | null;
  equipOptions: BufferedCharacterItemGrantEquipOptions | null;
};

type NormalizedCharacterItemGrant = {
  characterId: number;
  payload: EncodedCharacterItemGrantPayload;
  qty: number;
};

export type PendingCharacterItemGrant = {
  itemDefId: string;
  qty: number;
  bindType: string;
  obtainedFrom: string;
  idleSessionId: string | null;
  metadata: BufferedCharacterItemGrantMetadata | null;
  quality: string | null;
  qualityRank: number | null;
};

const ITEM_GRANT_DIRTY_INDEX_KEY = 'character:item-grant-delta:index';
const ITEM_GRANT_KEY_PREFIX = 'character:item-grant-delta:';
const ITEM_GRANT_INFLIGHT_KEY_PREFIX = 'character:item-grant-delta:inflight:';
const ITEM_GRANT_FLUSH_INTERVAL_MS = 1_000;
const ITEM_GRANT_FLUSH_BATCH_LIMIT = 100;
const ITEM_GRANT_MAIL_CHUNK_SIZE = 10;
const itemGrantDeltaLogger = createScopedLogger('characterItemGrant.delta');

let itemGrantFlushTimer: ReturnType<typeof setInterval> | null = null;
let itemGrantFlushInFlight: Promise<void> | null = null;

const claimItemGrantDeltaLua = `
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

const finalizeItemGrantDeltaLua = `
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

const restoreItemGrantDeltaLua = `
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

const buildItemGrantDeltaKey = (characterId: number): string =>
  `${ITEM_GRANT_KEY_PREFIX}${characterId}`;

const buildInflightItemGrantDeltaKey = (characterId: number): string =>
  `${ITEM_GRANT_INFLIGHT_KEY_PREFIX}${characterId}`;

const normalizePositiveInt = (value: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const normalizeBindType = (bindType: string | undefined): string => {
  const normalized = String(bindType ?? '').trim();
  return normalized || 'none';
};

const normalizeObtainedFrom = (obtainedFrom: string): string => {
  return String(obtainedFrom || '').trim();
};

const normalizeIdleSessionId = (idleSessionId: string | null | undefined): string | null => {
  const normalized = String(idleSessionId ?? '').trim();
  return normalized || null;
};

const normalizeGrantMetadata = (
  metadata: BufferedCharacterItemGrantMetadata | null | undefined,
): BufferedCharacterItemGrantMetadata | null => {
  if (!metadata || typeof metadata !== 'object') return null;
  const normalizedEntries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  if (normalizedEntries.length <= 0) return null;
  return Object.fromEntries(normalizedEntries);
};

const normalizeGrantQuality = (quality: string | null | undefined): string | null => {
  const normalized = String(quality ?? '').trim();
  return normalized || null;
};

const normalizeGrantQualityRank = (qualityRank: number | null | undefined): number | null => {
  if (qualityRank === null || qualityRank === undefined) return null;
  const normalized = Math.max(1, Math.floor(Number(qualityRank) || 1));
  return Number.isFinite(normalized) ? normalized : null;
};

const encodeItemGrantPayload = (payload: EncodedCharacterItemGrantPayload): string => {
  return JSON.stringify({
    userId: payload.userId,
    itemDefId: payload.itemDefId,
    bindType: payload.bindType,
    obtainedFrom: payload.obtainedFrom,
    idleSessionId: payload.idleSessionId,
    metadata: payload.metadata,
    quality: payload.quality,
    qualityRank: payload.qualityRank,
    equipOptions: payload.equipOptions,
  });
};

const decodeItemGrantPayload = (raw: string): EncodedCharacterItemGrantPayload | null => {
  try {
    const parsed = JSON.parse(raw) as EncodedCharacterItemGrantPayload;
    const userId = Math.floor(Number(parsed.userId));
    const itemDefId = String(parsed.itemDefId || '').trim();
    const bindType = normalizeBindType(parsed.bindType);
    const obtainedFrom = normalizeObtainedFrom(parsed.obtainedFrom);
    if (!Number.isFinite(userId) || userId <= 0 || !itemDefId || !obtainedFrom) {
      return null;
    }
    return {
      userId,
      itemDefId,
      bindType,
      obtainedFrom,
      idleSessionId: normalizeIdleSessionId(parsed.idleSessionId),
      metadata: normalizeGrantMetadata(parsed.metadata),
      quality: normalizeGrantQuality(parsed.quality),
      qualityRank: normalizeGrantQualityRank(parsed.qualityRank),
      equipOptions: parsed.equipOptions ?? null,
    };
  } catch {
    return null;
  }
};

const normalizeBufferedCharacterItemGrants = (
  grants: BufferedCharacterItemGrant[],
): NormalizedCharacterItemGrant[] => {
  const grantByCompositeKey = new Map<string, NormalizedCharacterItemGrant>();

  for (const grant of grants) {
    const characterId = Math.floor(Number(grant.characterId));
    const userId = Math.floor(Number(grant.userId));
    const itemDefId = String(grant.itemDefId || '').trim();
    const qty = normalizePositiveInt(grant.qty);
    const obtainedFrom = normalizeObtainedFrom(grant.obtainedFrom);
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!itemDefId || !obtainedFrom || qty <= 0) continue;

    const payload: EncodedCharacterItemGrantPayload = {
      userId,
      itemDefId,
      bindType: normalizeBindType(grant.bindType),
      obtainedFrom,
      idleSessionId: normalizeIdleSessionId(grant.idleSessionId),
      metadata: normalizeGrantMetadata(grant.metadata),
      quality: normalizeGrantQuality(grant.quality),
      qualityRank: normalizeGrantQualityRank(grant.qualityRank),
      equipOptions: grant.equipOptions ?? null,
    };
    const encodedPayload = encodeItemGrantPayload(payload);
    const compositeKey = `${characterId}:${encodedPayload}`;
    const existing = grantByCompositeKey.get(compositeKey);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    grantByCompositeKey.set(compositeKey, {
      characterId,
      payload,
      qty,
    });
  }

  return [...grantByCompositeKey.values()];
};

const buildMailMergeKey = (mailItem: MailAttachItem): string => {
  return JSON.stringify({
    itemDefId: String(mailItem.item_def_id || '').trim(),
    bindType: String(mailItem.options?.bindType || '').trim(),
    metadata: mailItem.options?.metadata ?? null,
    quality: mailItem.options?.quality ?? null,
    qualityRank: mailItem.options?.qualityRank ?? null,
    equipOptions: mailItem.options?.equipOptions ?? null,
  });
};

const pushPendingMailItem = (
  bucket: MailAttachItem[],
  mailItem: MailAttachItem,
): void => {
  const mergeKey = buildMailMergeKey(mailItem);
  const found = bucket.find((entry) => buildMailMergeKey(entry) === mergeKey);
  if (found) {
    found.qty += mailItem.qty;
    return;
  }
  bucket.push({
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(mailItem.options ? { options: { ...mailItem.options } } : {}),
  });
};

export const bufferCharacterItemGrantDeltas = async (
  grants: BufferedCharacterItemGrant[],
): Promise<void> => {
  const normalizedGrants = normalizeBufferedCharacterItemGrants(grants);
  if (normalizedGrants.length <= 0) return;

  await afterTransactionCommit(async () => {
    const multi = redis.multi();
    for (const grant of normalizedGrants) {
      multi.hincrby(
        buildItemGrantDeltaKey(grant.characterId),
        encodeItemGrantPayload(grant.payload),
        grant.qty,
      );
      multi.sadd(ITEM_GRANT_DIRTY_INDEX_KEY, String(grant.characterId));
    }
    await multi.exec();
  });
};

export const enqueueCharacterItemGrant = async (
  grant: BufferedCharacterItemGrant,
): Promise<{ success: boolean; message: string; itemIds: number[] }> => {
  await bufferCharacterItemGrantDeltas([grant]);
  return {
    success: true,
    message: '物品奖励已写入异步资产 Delta',
    itemIds: [],
  };
};

export const bufferSimpleCharacterItemGrants = async (
  characterId: number,
  userId: number,
  grants: readonly SimpleBufferedCharacterItemGrant[],
): Promise<void> => {
  if (grants.length <= 0) return;
  await bufferCharacterItemGrantDeltas(
    grants.map((grant) => ({
      characterId,
      userId,
      itemDefId: grant.itemDefId,
      qty: grant.qty,
      bindType: grant.bindType,
      obtainedFrom: grant.obtainedFrom,
      metadata: grant.metadata,
      quality: grant.quality,
      qualityRank: grant.qualityRank,
      equipOptions: grant.equipOptions,
    })),
  );
};

const listDirtyCharacterIdsForItemGrantDelta = async (
  limit: number,
): Promise<number[]> => {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return (await redis.srandmember(ITEM_GRANT_DIRTY_INDEX_KEY, normalizedLimit))
    .map((characterId) => Math.floor(Number(characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
    .sort((left, right) => left - right);
};

const claimCharacterItemGrantDelta = async (
  characterId: number,
): Promise<boolean> => {
  const result = await redis.eval(
    claimItemGrantDeltaLua,
    3,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    String(characterId),
  );
  return Number(result) === 1;
};

const finalizeCharacterItemGrantDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    finalizeItemGrantDeltaLua,
    3,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    String(characterId),
  );
};

const restoreCharacterItemGrantDelta = async (
  characterId: number,
): Promise<void> => {
  await redis.eval(
    restoreItemGrantDeltaLua,
    3,
    ITEM_GRANT_DIRTY_INDEX_KEY,
    buildItemGrantDeltaKey(characterId),
    buildInflightItemGrantDeltaKey(characterId),
    String(characterId),
  );
};

const loadClaimedCharacterItemGrantHash = async (
  characterId: number,
): Promise<Record<string, string>> => {
  return await redis.hgetall(buildInflightItemGrantDeltaKey(characterId));
};

const parseClaimedCharacterItemGrantHash = (
  characterId: number,
  hash: Record<string, string>,
): NormalizedCharacterItemGrant[] => {
  const parsedGrants: NormalizedCharacterItemGrant[] = [];

  for (const [field, rawQty] of Object.entries(hash)) {
    const payload = decodeItemGrantPayload(field);
    const qty = normalizePositiveInt(Number(rawQty));
    if (!payload || qty <= 0) continue;
    parsedGrants.push({
      characterId,
      payload,
      qty,
    });
  }

  return parsedGrants;
};

export const loadCharacterPendingItemGrants = async (
  characterId: number,
): Promise<PendingCharacterItemGrant[]> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return [];
  }

  const [mainHash, inflightHash] = await Promise.all([
    redis.hgetall(buildItemGrantDeltaKey(normalizedCharacterId)),
    redis.hgetall(buildInflightItemGrantDeltaKey(normalizedCharacterId)),
  ]);
  const mergedHash = new Map<string, number>();
  for (const hash of [mainHash, inflightHash]) {
    for (const [field, rawQty] of Object.entries(hash)) {
      const qty = normalizePositiveInt(Number(rawQty));
      if (qty <= 0) continue;
      mergedHash.set(field, (mergedHash.get(field) ?? 0) + qty);
    }
  }

  const pendingGrants: PendingCharacterItemGrant[] = [];
  for (const [field, qty] of mergedHash.entries()) {
    const payload = decodeItemGrantPayload(field);
    if (!payload || qty <= 0) continue;
      pendingGrants.push({
        itemDefId: payload.itemDefId,
        qty,
        bindType: payload.bindType,
        obtainedFrom: payload.obtainedFrom,
        idleSessionId: payload.idleSessionId,
        metadata: payload.metadata,
        quality: payload.quality,
        qualityRank: payload.qualityRank,
    });
  }
  return pendingGrants;
};

const flushSingleCharacterItemGrants = async (
  characterId: number,
  grants: NormalizedCharacterItemGrant[],
): Promise<void> => {
  if (grants.length <= 0) return;

  await withTransaction(async () => {
    await lockCharacterInventoryMutex(characterId);
    const slotSession = await createInventorySlotSession([characterId]);
    const bagSlotAllocator = createCharacterBagSlotAllocatorFromSession(slotSession, [characterId]);
    const inventoryMutationContext = createCharacterInventoryMutationContextFromSession(slotSession);
    const pendingMailItems: MailAttachItem[] = [];
    const idleBagFullSessionIds = new Set<string>();
    let receiverUserId = 0;

    for (const grant of grants) {
      receiverUserId = grant.payload.userId;
      const createResult = await itemService.createItem(
        grant.payload.userId,
        characterId,
        grant.payload.itemDefId,
        grant.qty,
        {
          location: 'bag',
          obtainedFrom: grant.payload.obtainedFrom,
          bindType: grant.payload.bindType,
          bagSlotAllocator,
          inventoryMutationContext,
          slotSession,
          skipInventoryMutexLock: true,
          ...(grant.payload.metadata ? { metadata: grant.payload.metadata } : {}),
          ...(grant.payload.quality ? { quality: grant.payload.quality } : {}),
          ...(grant.payload.qualityRank !== null ? { qualityRank: grant.payload.qualityRank } : {}),
          ...(grant.payload.equipOptions ? { equipOptions: grant.payload.equipOptions } : {}),
        },
      );

      if (createResult.success) {
        continue;
      }

      if (createResult.message === '背包已满') {
        if (grant.payload.idleSessionId) {
          idleBagFullSessionIds.add(grant.payload.idleSessionId);
        }
        pushPendingMailItem(pendingMailItems, {
          item_def_id: grant.payload.itemDefId,
          qty: grant.qty,
          options: {
            bindType: grant.payload.bindType,
            ...(grant.payload.metadata ? { metadata: grant.payload.metadata } : {}),
            ...(grant.payload.quality ? { quality: grant.payload.quality } : {}),
            ...(grant.payload.qualityRank !== null ? { qualityRank: grant.payload.qualityRank } : {}),
            ...(grant.payload.equipOptions ? { equipOptions: grant.payload.equipOptions } : {}),
          },
        });
        continue;
      }

      throw new Error(`角色资产 Delta flush 失败: characterId=${characterId}, itemDefId=${grant.payload.itemDefId}, message=${createResult.message}`);
    }

    for (let index = 0; index < pendingMailItems.length; index += ITEM_GRANT_MAIL_CHUNK_SIZE) {
      const chunk = pendingMailItems.slice(index, index + ITEM_GRANT_MAIL_CHUNK_SIZE);
      const mailResult = await sendSystemMail(
        receiverUserId,
        characterId,
        '奖励补发',
        '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。',
        { items: chunk },
        30,
      );
      if (!mailResult.success) {
        throw new Error(`角色资产 Delta 补发邮件失败: characterId=${characterId}, message=${mailResult.message}`);
      }
    }

    if (idleBagFullSessionIds.size > 0) {
      await query(
        `UPDATE idle_sessions
         SET bag_full_flag = true,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [[...idleBagFullSessionIds]],
      );
    }
  });
};

const flushCharacterItemGrantDeltas = async (
  options: { drainAll?: boolean; limit?: number } = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const limit = Math.max(1, Math.floor(options.limit ?? ITEM_GRANT_FLUSH_BATCH_LIMIT));

  do {
    const dirtyCharacterIds = await listDirtyCharacterIdsForItemGrantDelta(limit);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }

    for (const characterId of dirtyCharacterIds) {
      const claimed = await claimCharacterItemGrantDelta(characterId);
      if (!claimed) continue;

      try {
        const hash = await loadClaimedCharacterItemGrantHash(characterId);
        const grants = parseClaimedCharacterItemGrantHash(characterId, hash);
        await flushSingleCharacterItemGrants(characterId, grants);
        await finalizeCharacterItemGrantDelta(characterId);
      } catch (error) {
        await restoreCharacterItemGrantDelta(characterId);
        throw error;
      }
    }
  } while (drainAll);
};

const runItemGrantFlushLoopOnce = async (): Promise<void> => {
  if (itemGrantFlushInFlight) {
    await itemGrantFlushInFlight;
    return;
  }

  const currentFlush = flushCharacterItemGrantDeltas().catch((error: Error) => {
    itemGrantDeltaLogger.error(error, '角色物品授予 Delta flush 失败');
  });
  itemGrantFlushInFlight = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (itemGrantFlushInFlight === currentFlush) {
      itemGrantFlushInFlight = null;
    }
  }
};

export const initializeCharacterItemGrantDeltaService = async (): Promise<void> => {
  if (itemGrantFlushTimer) return;

  itemGrantFlushTimer = setInterval(() => {
    void runItemGrantFlushLoopOnce();
  }, ITEM_GRANT_FLUSH_INTERVAL_MS);
};

export const shutdownCharacterItemGrantDeltaService = async (): Promise<void> => {
  if (itemGrantFlushTimer) {
    clearInterval(itemGrantFlushTimer);
    itemGrantFlushTimer = null;
  }

  if (itemGrantFlushInFlight) {
    await itemGrantFlushInFlight;
  }

  await flushCharacterItemGrantDeltas({ drainAll: true });
};
