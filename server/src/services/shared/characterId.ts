/**
 * 角色ID公共查询工具。
 * - `getCharacterIdByUserId`：普通查询（双层缓存）。
 * - `getCharacterIdByUserIdForUpdate`：事务内加锁查询（FOR UPDATE）。
 * - `primeCharacterIdByUserIdCache` / `invalidateCharacterIdByUserIdCache`：缓存维护。
 * 返回：有效角色ID或 `null`。
 */
import { loadCharacterWritebackRowByUserId } from '../playerWritebackCacheService.js';
import { createCacheLayer } from './cacheLayer.js';

const CHARACTER_ID_BY_USER_KEY_PREFIX = 'character:id:user:';
const CHARACTER_ID_BY_USER_REDIS_TTL_SEC = 3600;
const CHARACTER_ID_BY_USER_MEMORY_TTL_MS = 60_000;

const normalizeUserId = (userId: number): number | null => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  return uid;
};

const normalizeCharacterId = (rawId: unknown): number | null => {
  const characterId = Number(rawId);
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  return characterId;
};

const characterIdByUserIdCache = createCacheLayer<number, number>({
  keyPrefix: CHARACTER_ID_BY_USER_KEY_PREFIX,
  redisTtlSec: CHARACTER_ID_BY_USER_REDIS_TTL_SEC,
  memoryTtlMs: CHARACTER_ID_BY_USER_MEMORY_TTL_MS,
  loader: async (userId) => {
    const character = await loadCharacterWritebackRowByUserId(userId);
    return normalizeCharacterId(character?.id);
  },
});

export const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  const uid = normalizeUserId(userId);
  if (!uid) return null;

  return characterIdByUserIdCache.get(uid);
};

export const getCharacterIdByUserIdForUpdate = async (
  userId: number,
): Promise<number | null> => {
  const uid = normalizeUserId(userId);
  if (!uid) return null;

  const character = await loadCharacterWritebackRowByUserId(uid, { forUpdate: true });
  return normalizeCharacterId(character?.id);
};

export const primeCharacterIdByUserIdCache = async (
  userId: number,
  characterId: number,
): Promise<void> => {
  const uid = normalizeUserId(userId);
  const cid = normalizeCharacterId(characterId);
  if (!uid || !cid) return;

  await characterIdByUserIdCache.set(uid, cid);
};

export const invalidateCharacterIdByUserIdCache = async (userId: number): Promise<void> => {
  const uid = normalizeUserId(userId);
  if (!uid) return;

  await characterIdByUserIdCache.invalidate(uid);
};
