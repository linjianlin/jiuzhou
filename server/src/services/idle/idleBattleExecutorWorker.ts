/**
 * IdleBattleExecutor (Worker 版本) — 主线程协调器
 *
 * 作用：
 *   协调 Worker 池执行挂机战斗，主线程仅负责：
 *   - 任务调度（分发战斗计算任务到 Worker）
 *   - 数据库操作（批量写入战斗结果）
 *   - Socket 推送（实时通知客户端）
 *   - 终止条件检查（体力、时长、背包）
 *
 * 输入/输出：
 *   - startExecutionLoop(session, userId) → void（启动挂机循环）
 *   - stopExecutionLoop(sessionId) → void（停止挂机循环）
 *   - recoverActiveIdleSessions() → Promise<void>（服务启动恢复）
 *
 * 数据流（Worker 版本）：
 *   主线程 → WorkerPool.executeTask → Worker 执行战斗 → 返回结果
 *   → 主线程 appendToBuffer → 达到阈值 → flushBuffer（批量写 DB）
 *
 * 关键边界条件：
 *   1. Worker 计算失败时使用默认延迟继续调度（不中断挂机）
 *   2. 终止时强制 flush 剩余缓冲区
 *   3. 进程退出时等待所有 Worker 任务完成后再关闭连接
 */

import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { BATTLE_TICK_MS, BATTLE_START_COOLDOWN_MS } from '../battle/index.js';
import { getGameServer } from '../../game/gameServer.js';
import { getRoomInMap } from '../mapService.js';
import { getCharacterUserId } from '../sect/db.js';
import type { IdleSessionRow, RewardItemEntry } from './types.js';
import { resolveIdleBattleRewards } from './idleBattleRewardResolver.js';
import { toPgTextArrayLiteral } from './pgTextArrayLiteral.js';
import { rowToIdleSessionRow } from './rowMappers.js';
import {
  completeIdleSession,
  getActiveIdleSession,
  releaseIdleLock,
  updateSessionSummary,
} from './idleSessionService.js';
import { getWorkerPool } from '../../workers/workerPool.js';

// ============================================
// 类型定义
// ============================================

type WorkerBatchResult = {
  result: 'attacker_win' | 'defender_win' | 'draw';
  randomSeed: number;
  roundCount: number;
  battleLog: unknown[];
  monsterIds: string[];
};

type SingleBatchResult = WorkerBatchResult & {
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  bagFullFlag: boolean;
};

type BatchBuffer = {
  batches: Array<{
    id: string;
    sessionId: string;
    batchIndex: number;
    result: string;
    roundCount: number;
    randomSeed: number;
    expGained: number;
    silverGained: number;
    itemsGained: RewardItemEntry[];
    bagFullFlag: boolean;
    battleLog: unknown[];
    monsterIds: string[];
  }>;
  lastFlushAt: number;
};

// ============================================
// 常量配置
// ============================================

/** 批量写入阈值：积累多少场战斗后触发 flush */
const FLUSH_BATCH_SIZE = 10;

/** 批量写入时间阈值：距上次 flush 超过多少毫秒后触发 */
const FLUSH_INTERVAL_MS = 5_000;

// ============================================
// 内部状态
// ============================================

/** 执行循环 Map（sessionId → timeoutHandle）*/
const activeLoops = new Map<string, ReturnType<typeof setTimeout>>();

/** 活跃缓冲区 Map（sessionId → { characterId, buffer }）*/
const activeBuffers = new Map<string, { characterId: number; buffer: BatchBuffer }>();

// ============================================
// 缓冲区管理
// ============================================

function createBuffer(): BatchBuffer {
  return {
    batches: [],
    lastFlushAt: Date.now(),
  };
}

function shouldFlush(buffer: BatchBuffer): boolean {
  return (
    buffer.batches.length >= FLUSH_BATCH_SIZE ||
    Date.now() - buffer.lastFlushAt >= FLUSH_INTERVAL_MS
  );
}

/**
 * 将内存缓冲区批量写入 DB
 */
async function flushBuffer(
  _characterId: number,
  sessionId: string,
  buffer: BatchBuffer,
): Promise<void> {
  if (buffer.batches.length === 0) return;

  const batches = buffer.batches.splice(0);
  buffer.lastFlushAt = Date.now();

  try {
    // 1. 批量 INSERT idle_battle_batches
    const values = batches
      .map(
        (b, i) =>
          `($${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5}, $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10}, $${i * 11 + 11}, NOW())`,
      )
      .join(', ');
    const params = batches.flatMap((b) => [
      b.id,
      b.sessionId,
      b.batchIndex,
      b.result,
      b.roundCount,
      b.randomSeed,
      b.expGained,
      b.silverGained,
      JSON.stringify(b.battleLog),
      JSON.stringify(b.itemsGained),
      toPgTextArrayLiteral(b.monsterIds),
    ]);

    await query(
      `INSERT INTO idle_battle_batches (
        id, session_id, batch_index, result, round_count, random_seed,
        exp_gained, silver_gained, battle_log, items_gained, monster_ids, executed_at
      )
       VALUES ${values}`,
      params,
    );

    // 2. 累加汇总数据
    const totalBattlesDelta = batches.length;
    const winDelta = batches.filter((b) => b.result === 'attacker_win').length;
    const loseDelta = batches.filter((b) => b.result === 'defender_win').length;
    const expDelta = batches.reduce((sum, b) => sum + b.expGained, 0);
    const silverDelta = batches.reduce((sum, b) => sum + b.silverGained, 0);
    const newItems = batches.flatMap((b) => b.itemsGained);
    const bagFullFlag = batches.some((b) => b.bagFullFlag);

    await updateSessionSummary(sessionId, {
      totalBattlesDelta,
      winDelta,
      loseDelta,
      expDelta,
      silverDelta,
      newItems,
      bagFullFlag,
    });

    console.log(
      `[IdleBattleExecutor] 会话 ${sessionId} flush 完成：${batches.length} 场战斗`,
    );
  } catch (err) {
    console.error(`[IdleBattleExecutor] flush 失败:`, err);
    // flush 失败时将 batches 放回缓冲区（下次重试）
    buffer.batches.unshift(...batches);
  }
}

/**
 * 将所有活跃会话的内存缓冲区批量写入 DB（进程退出时调用）
 */
export async function flushAllBuffers(): Promise<void> {
  const entries = Array.from(activeBuffers.entries());
  if (entries.length === 0) return;

  console.log(`[IdleBattleExecutor] 正在刷写 ${entries.length} 个会话的缓冲区...`);

  const results = await Promise.allSettled(
    entries.map(([sessionId, { characterId, buffer }]) =>
      flushBuffer(characterId, sessionId, buffer),
    ),
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    console.error(`[IdleBattleExecutor] ${failed.length} 个会话 flush 失败`);
  }
  console.log(
    `[IdleBattleExecutor] 缓冲区刷写完成（成功 ${results.length - failed.length}/${results.length}）`,
  );
}

// ============================================
// 执行循环（Worker 版本）
// ============================================

/**
 * 启动挂机执行循环（Worker 版本）
 *
 * 每次迭代：
 *   1. 分发战斗计算任务到 Worker
 *   2. Worker 返回结果后追加到 BatchBuffer
 *   3. 实时推送本场摘要给客户端
 *   4. 检查终止条件
 *   5. 满足 flush 条件时批量写入 DB
 *   6. 根据回合数动态计算下一场延迟
 */
export function startExecutionLoop(session: IdleSessionRow, userId: number): void {
  if (activeLoops.has(session.id)) return;

  let batchIndex = session.totalBattles + 1;
  const buffer = createBuffer();
  activeBuffers.set(session.id, { characterId: session.characterId, buffer });

  /** 递归调度下一场战斗 */
  function scheduleNext(delayMs: number): void {
    const handle = setTimeout(() => {
      void (async () => {
        try {
          // 1. 获取房间怪物配置（主线程查询，传递给 Worker）
          const room = await getRoomInMap(session.mapId, session.roomId);
          const roomMonsters = room?.monsters ?? [];

          // 2. 分发任务到 Worker
          const workerPool = getWorkerPool();
          const workerResult = await workerPool.executeTask<WorkerBatchResult>({
            type: 'executeBatch',
            payload: {
              session,
              batchIndex,
              userId,
              roomMonsters,
            },
          });

          // 3. 奖励统一复用普通执行器逻辑（主线程结算，避免 Worker 与主流程分叉）
          const rewardSnapshot = await resolveIdleBattleRewards(
            workerResult.monsterIds,
            session,
            userId,
            workerResult.result,
          );
          const batchResult: SingleBatchResult = {
            ...workerResult,
            expGained: rewardSnapshot.expGained,
            silverGained: rewardSnapshot.silverGained,
            itemsGained: rewardSnapshot.itemsGained,
            bagFullFlag: rewardSnapshot.bagFullFlag,
          };

          // 4. 追加结果到缓冲区
          buffer.batches.push({
            id: randomUUID(),
            sessionId: session.id,
            batchIndex,
            result: batchResult.result,
            roundCount: batchResult.roundCount,
            randomSeed: batchResult.randomSeed,
            expGained: batchResult.expGained,
            silverGained: batchResult.silverGained,
            itemsGained: batchResult.itemsGained,
            bagFullFlag: batchResult.bagFullFlag,
            battleLog: batchResult.battleLog,
            monsterIds: batchResult.monsterIds,
          });
          batchIndex++;

          // 5. 实时推送本场摘要
          try {
            getGameServer().emitToUser(userId, 'idle:update', {
              sessionId: session.id,
              batchIndex: batchIndex - 1,
              result: batchResult.result,
              expGained: batchResult.expGained,
              silverGained: batchResult.silverGained,
              itemsGained: batchResult.itemsGained,
              roundCount: batchResult.roundCount,
            });
          } catch {
            // 忽略推送错误
          }

          // 6. 检查终止条件
          const shouldStop = await checkTerminationConditions(session, userId);

          // 7. 满足 flush 条件或即将终止时批量写入
          if (shouldFlush(buffer) || shouldStop.terminate) {
            await flushBuffer(session.characterId, session.id, buffer);
          }

          if (shouldStop.terminate) {
            activeLoops.delete(session.id);
            activeBuffers.delete(session.id);
            await completeIdleSession(session.id, shouldStop.status);
            await releaseIdleLock(session.characterId);

            try {
              getGameServer().emitToUser(userId, 'idle:finished', {
                sessionId: session.id,
                reason: shouldStop.reason,
              });
            } catch {
              // 忽略推送错误
            }
            return; // 终止
          }

          // 7. 根据回合数动态计算下一场延迟
          const nextDelay = BATTLE_START_COOLDOWN_MS + batchResult.roundCount * BATTLE_TICK_MS;
          scheduleNext(nextDelay);
        } catch (err) {
          console.error(`[IdleBattleExecutor] 会话 ${session.id} 第 ${batchIndex} 场战斗异常:`, err);
          // 异常后仍继续调度，使用默认延迟
          scheduleNext(BATTLE_START_COOLDOWN_MS);
        }
      })();
    }, delayMs);

    activeLoops.set(session.id, handle);
  }

  // 首场战斗使用开战冷却作为初始延迟
  scheduleNext(BATTLE_START_COOLDOWN_MS);
}

/**
 * 手动停止指定会话的执行循环
 */
export function stopExecutionLoop(sessionId: string): void {
  const handle = activeLoops.get(sessionId);
  if (handle) {
    clearTimeout(handle);
    activeLoops.delete(sessionId);
    activeBuffers.delete(sessionId);
  }
}

/**
 * 停止所有挂机会话的执行循环（优雅关闭）
 */
export function stopAllExecutionLoops(): void {
  console.log(`[IdleBattleExecutor] 正在停止 ${activeLoops.size} 个执行循环...`);

  for (const [sessionId, handle] of activeLoops.entries()) {
    clearTimeout(handle);
  }

  activeLoops.clear();
  activeBuffers.clear();

  console.log('[IdleBattleExecutor] 所有执行循环已停止');
}

// ============================================
// 终止条件检查
// ============================================

type TerminationCheckResult =
  | { terminate: false }
  | { terminate: true; status: 'completed' | 'interrupted'; reason: string };

async function checkTerminationConditions(
  session: IdleSessionRow,
  userId: number,
): Promise<TerminationCheckResult> {
  // 1. 检查会话状态（是否被手动停止）
  const currentSession = await getActiveIdleSession(session.characterId);
  if (!currentSession || currentSession.status === 'stopping') {
    return { terminate: true, status: 'interrupted', reason: '会话已停止' };
  }

  // 2. 检查时长限制
  const elapsed = Date.now() - new Date(session.startedAt).getTime();
  if (elapsed >= session.maxDurationMs) {
    return { terminate: true, status: 'completed', reason: '达到时长上限' };
  }

  // 3. 检查体力（简化版，实际应查询 DB）
  // TODO: 从 DB 查询当前体力，判断是否足够继续战斗

  return { terminate: false };
}

// ============================================
// 服务启动恢复
// ============================================

/**
 * 服务启动时恢复所有活跃挂机会话
 */
export async function recoverActiveIdleSessions(): Promise<void> {
  const res = await query(
    `SELECT * FROM idle_sessions WHERE status IN ('active', 'stopping')`,
    [],
  );

  if (res.rows.length === 0) {
    console.log('✓ 没有需要恢复的挂机会话');
    return;
  }

  console.log(`正在恢复 ${res.rows.length} 个挂机会话...`);

  for (const row of res.rows as Record<string, unknown>[]) {
    const session = rowToIdleSessionRow(row);
    const userIdRes = await getCharacterUserId(session.characterId);
    if (!userIdRes) {
      console.warn(`会话 ${session.id} 的角色 ${session.characterId} 不存在，跳过恢复`);
      await completeIdleSession(session.id, 'interrupted');
      continue;
    }

    startExecutionLoop(session, userIdRes);
  }

  console.log(`✓ ${res.rows.length} 个挂机会话已恢复`);
}
