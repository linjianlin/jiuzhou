import type { PoolClient, QueryResult } from 'pg';
import { query } from '../config/database.js';

/**
 * Inventory Mutex — 角色背包互斥锁工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：在事务内为角色背包写操作提供"按角色串行化"的 advisory xact lock。
 * - 不做什么：不负责事务开启与提交，不负责业务重试策略，不负责吞掉锁超时异常。
 *
 * 输入/输出：
 * - lockCharacterInventoryMutex(characterId)
 *   输入角色 ID，输出为 Promise<void>（成功即表示已拿到互斥锁）。
 *   内部使用 `query()` 自动走事务连接（调用方须处于事务上下文）。
 * - lockCharacterInventoryMutexes(characterIds)
 *   输入角色 ID 列表，内部先去重排序后逐个加锁，输出 Promise<void>。
 *
 * 向后兼容：
 * - 保留 lockCharacterInventoryMutexTx / lockCharacterInventoryMutexesTx 作为别名导出，
 *   签名接受 `client: PoolClient | null` 但内部忽略该参数，供尚未改造的外部调用方过渡使用。
 *
 * 数据流/状态流：
 * - 调用方进入事务后调用本模块；
 * - 本模块使用 `pg_try_advisory_xact_lock` 进行非阻塞尝试；
 * - 未拿到锁时按固定间隔轮询，直到拿到锁或超时；
 * - 事务提交/回滚后，xact lock 由 PostgreSQL 自动释放。
 *
 * 关键边界条件与坑点：
 * 1. 必须在事务上下文中使用（xact lock 生命周期绑定事务），否则锁会在语句结束后立即失效或语义不符合预期。
 * 2. 多角色加锁必须按升序统一顺序，避免不同调用链加锁顺序反转导致的死锁环。
 */
const INVENTORY_MUTEX_NAMESPACE = 3101;
const INVENTORY_MUTEX_RETRY_INTERVAL_MS = 50;
const INVENTORY_MUTEX_MAX_WAIT_MS = 45000;

const normalizeCharacterIds = (characterIds: number[]): number[] =>
  [...new Set(characterIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 尝试获取单个角色背包互斥锁（非阻塞）
 * 使用统一 query() 入口，自动走事务连接
 */
const tryLockCharacterInventoryMutex = async (
  characterId: number
): Promise<boolean> => {
  const sql = 'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked';
  const params: [number, number] = [INVENTORY_MUTEX_NAMESPACE, characterId];
  const result = await query(sql, params) as unknown as QueryResult<{ locked: boolean }>;
  return result.rows[0]?.locked === true;
};

/**
 * 获取单个角色背包互斥锁（阻塞轮询直到成功或超时）
 * 使用统一 query() 入口，无需传入 client
 */
export const lockCharacterInventoryMutex = async (
  characterId: number
): Promise<void> => {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`角色背包互斥锁参数错误: characterId=${String(characterId)}`);
  }

  const startAt = Date.now();
  while (true) {
    const locked = await tryLockCharacterInventoryMutex(characterId);
    if (locked) return;

    const waitedMs = Date.now() - startAt;
    if (waitedMs >= INVENTORY_MUTEX_MAX_WAIT_MS) {
      throw new Error(
        `获取角色背包互斥锁超时: characterId=${characterId}, waitedMs=${waitedMs}, maxWaitMs=${INVENTORY_MUTEX_MAX_WAIT_MS}`
      );
    }

    await sleep(INVENTORY_MUTEX_RETRY_INTERVAL_MS);
  }
};

/**
 * 获取多个角色背包互斥锁（按升序逐个加锁，避免死锁）
 */
export const lockCharacterInventoryMutexes = async (
  characterIds: number[]
): Promise<void> => {
  const ids = normalizeCharacterIds(characterIds);
  for (const characterId of ids) {
    await lockCharacterInventoryMutex(characterId);
  }
};

/**
 * 向后兼容别名：接受 client 参数但内部忽略，供尚未改造的外部调用方过渡使用
 */
export const lockCharacterInventoryMutexTx = async (
  _client: PoolClient | null,
  characterId: number
): Promise<void> => {
  return lockCharacterInventoryMutex(characterId);
};

export const lockCharacterInventoryMutexesTx = async (
  _client: PoolClient | null,
  characterIds: number[]
): Promise<void> => {
  return lockCharacterInventoryMutexes(characterIds);
};
