/**
 * 玩家状态 Redis key 约定
 *
 * 作用：
 * 1. 做什么：集中维护玩家状态主数据、元数据、dirty 集和分布式锁 key 命名。
 * 2. 做什么：保证 hydrate、flush、仓库读写、公用运维工具使用同一套 key 规范。
 * 3. 不做什么：不直接访问 Redis，不负责状态序列化。
 *
 * 输入/输出：
 * - 输入：characterId / userId。
 * - 输出：对应的 Redis key 字符串。
 *
 * 数据流/状态流：
 * 业务层通过仓库调用 -> 仓库拼 key -> Redis 读写/加锁/扫描 dirty。
 *
 * 关键边界条件与坑点：
 * 1. 主状态 key 不允许附带 TTL；只有锁 key 允许过期。
 * 2. userId 到 characterId 的映射必须独立成 key，避免每次按 userId hydrate 都回 DB 查一次。
 */

const PLAYER_STATE_PREFIX = 'player:state';

export const playerStateCharacterKey = (characterId: number): string => {
  return `${PLAYER_STATE_PREFIX}:character:${characterId}`;
};

export const playerStateInventoryKey = (characterId: number): string => {
  return `${PLAYER_STATE_PREFIX}:inventory:${characterId}`;
};

export const playerStateMetaKey = (characterId: number): string => {
  return `${PLAYER_STATE_PREFIX}:meta:${characterId}`;
};

export const playerStateUserCharacterKey = (userId: number): string => {
  return `${PLAYER_STATE_PREFIX}:user:${userId}:character`;
};

export const playerStateDirtySetKey = (): string => {
  return `${PLAYER_STATE_PREFIX}:dirty`;
};

export const playerStateHydrateLockKey = (characterId: number): string => {
  return `${PLAYER_STATE_PREFIX}:lock:hydrate:${characterId}`;
};

export const playerStateFlushLockKey = (characterId: number): string => {
  return `${PLAYER_STATE_PREFIX}:lock:flush:${characterId}`;
};
