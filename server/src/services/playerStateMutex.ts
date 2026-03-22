import type { PoolClient, QueryResult } from 'pg';

import {
  getTransactionClient,
  isInTransaction,
  withTransactionAuto,
} from '../config/database.js';

/**
 * 玩家状态角色级互斥锁
 *
 * 作用：
 * 1. 做什么：为 Redis 主状态的角色/背包写入提供“按角色串行化”的 PostgreSQL advisory xact lock。
 * 2. 做什么：让兼容层的 `forUpdate` 读取与仓库层的 patch/upsert/delete 共用同一把锁，避免同角色并发读改写互相覆盖。
 * 3. 不做什么：不负责开启业务事务边界，不负责 Redis 读写，不做失败重试决策之外的兜底。
 *
 * 输入/输出：
 * - `lockPlayerStateMutex(characterId)`：输入角色 ID，输出 Promise<void>，成功表示当前事务已持有该角色锁。
 * - `withPlayerStateMutex(characterId, task)`：输入角色 ID 与任务函数，输出任务返回值。
 *
 * 数据流/状态流：
 * 业务服务进入事务 -> 获取角色级 advisory xact lock -> 读取/修改 Redis 主状态 -> 事务提交或回滚时自动释放锁。
 *
 * 关键边界条件与坑点：
 * 1. 锁生命周期绑定数据库事务；脱离事务直接加锁会导致锁语义失效，所以必须走 `withTransactionAuto` 或已有事务上下文。
 * 2. 该锁只负责同角色串行化；hydrate/flush 的跨实例协同仍由 Redis 锁负责，二者职责不能混用。
 */
const PLAYER_STATE_MUTEX_NAMESPACE = 3102;
const PLAYER_STATE_MUTEX_RETRY_INTERVAL_MS = 50;
const PLAYER_STATE_MUTEX_MAX_WAIT_MS = 45_000;

type PlayerStateMutexQueryRunner = Pick<PoolClient, 'query'>;

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const tryLockPlayerStateMutexWithRunner = async (
  runner: PlayerStateMutexQueryRunner,
  characterId: number,
): Promise<boolean> => {
  const result = await runner.query(
    'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS locked',
    [PLAYER_STATE_MUTEX_NAMESPACE, characterId],
  ) as QueryResult<{ locked: boolean }>;
  return result.rows[0]?.locked === true;
};

const waitForPlayerStateMutexWithRunner = async (
  runner: PlayerStateMutexQueryRunner,
  characterId: number,
): Promise<void> => {
  const startAt = Date.now();
  while (true) {
    const locked = await tryLockPlayerStateMutexWithRunner(runner, characterId);
    if (locked) return;

    const waitedMs = Date.now() - startAt;
    if (waitedMs >= PLAYER_STATE_MUTEX_MAX_WAIT_MS) {
      throw new Error(
        `获取玩家状态互斥锁超时: characterId=${characterId}, waitedMs=${waitedMs}, maxWaitMs=${PLAYER_STATE_MUTEX_MAX_WAIT_MS}`,
      );
    }

    await sleep(PLAYER_STATE_MUTEX_RETRY_INTERVAL_MS);
  }
};

export const lockPlayerStateMutexByClient = async (
  client: PoolClient,
  characterId: number,
): Promise<void> => {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`玩家状态互斥锁参数错误: characterId=${String(characterId)}`);
  }
  await waitForPlayerStateMutexWithRunner(client, characterId);
};

export const lockPlayerStateMutex = async (
  characterId: number,
): Promise<void> => {
  if (!Number.isInteger(characterId) || characterId <= 0) {
    throw new Error(`玩家状态互斥锁参数错误: characterId=${String(characterId)}`);
  }
  if (!isInTransaction()) {
    throw new Error('玩家状态互斥锁必须在事务上下文中获取，请通过 @Transactional 或 withTransactionAuto 调用');
  }
  const client = getTransactionClient();
  if (!client) {
    throw new Error('玩家状态互斥锁获取失败：事务连接不存在');
  }
  await lockPlayerStateMutexByClient(client, characterId);
};

export const withPlayerStateMutex = async <T>(
  characterId: number,
  task: () => Promise<T>,
): Promise<T> => {
  return withTransactionAuto(async () => {
    await lockPlayerStateMutex(characterId);
    return task();
  });
};
