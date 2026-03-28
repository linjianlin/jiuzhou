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
import { query, withTransactionAuto } from '../../config/database.js';
import { BATTLE_TICK_MS, BATTLE_START_COOLDOWN_MS } from '../battle/index.js';
import { getGameServer } from '../../game/gameServer.js';
import { getRoomInMap } from '../mapService.js';
import { getCharacterUserId } from '../sect/db.js';
import type {
  IdleBattleReplaySnapshot,
  IdleBattleRewardSettlementPlan,
  IdleSessionRow,
  RewardItemEntry,
} from './types.js';
import {
  buildIdleBattleRewardSettlementPlan,
  buildIdleRewardParticipant,
  settleIdleBattleRewardSettlementPlan,
} from './idleBattleRewardResolver.js';
import { toPgTextArrayLiteral } from './pgTextArrayLiteral.js';
import { rowToIdleSessionRow } from './rowMappers.js';
import { idleSessionService } from './idleSessionService.js';
import type { IdleRoomMonsterSlot } from './idleBattleSimulationCore.js';
import {
  appendBattleResultToIdleSessionSummary,
  createIdleSessionSummaryState,
  getIdleSessionSummaryFlushPayload,
  resetIdleSessionSummaryDelta,
  type IdleSessionSummaryState,
} from './idleSessionSummary.js';
import {
  appendIdleRewardWindowBatch,
  createIdleRewardWindowState,
  getIdleRewardWindowFlushPayload,
  resetIdleRewardWindowDelta,
  shouldFlushIdleRewardWindow,
  type IdleRewardWindowBatch,
  type IdleRewardWindowState,
} from './idleRewardWindow.js';
import {
  clearIdleExecutionLoopRegistry,
  touchIdleExecutionLoop,
  registerIdleExecutionLoop,
  unregisterIdleExecutionLoop,
} from './idleExecutionRegistry.js';
import {
  logIdleFlushFailure,
  resolveIdleTerminationFlushDecision,
} from './idleFlushControl.js';
import { getWorkerPool } from '../../workers/workerPool.js';

// ============================================
// 类型定义
// ============================================

type WorkerBatchResult = {
  result: 'attacker_win' | 'defender_win' | 'draw';
  randomSeed: number;
  roundCount: number;
  replaySnapshot: IdleBattleReplaySnapshot | null;
  monsterIds: string[];
};

type SingleBatchResult = WorkerBatchResult & {
  rewardPlan: IdleBattleRewardSettlementPlan;
};

type BatchBuffer = {
  rewardWindow: IdleRewardWindowState;
  summaryState: IdleSessionSummaryState;
};

// ============================================
// 常量配置
// ============================================

/** 批量写入时间阈值：距上次 flush 超过多少毫秒后触发 */
const FLUSH_INTERVAL_MS = 30_000;

/** 会话状态查库间隔：仅用于开战前预检查，避免每轮都重复查询 idle_sessions */
const SESSION_STATUS_CHECK_INTERVAL_MS = 15_000;

// ============================================
// 内部状态
// ============================================

/** 执行循环 Map（sessionId → timeoutHandle）*/
const activeLoops = new Map<string, ReturnType<typeof setTimeout>>();

/** 活跃缓冲区 Map（sessionId → { session, userId, buffer }）*/
const activeBuffers = new Map<
  string,
  { session: IdleSessionRow; userId: number; buffer: BatchBuffer }
>();

/** 立即唤醒回调（sessionId → wakeNow） */
const loopWakeHandlers = new Map<string, () => void>();

/** 循环运行态（避免 stop 请求期间并发调度） */
const loopRuntimeStates = new Map<
  string,
  {
    running: boolean;
    wakeRequested: boolean;
    stopRequested: boolean;
    lastSessionStatusCheckAt: number;
  }
>();

// ============================================
// 缓冲区管理
// ============================================

function createBuffer(session: Pick<IdleSessionRow, 'rewardItems' | 'bagFullFlag'>): BatchBuffer {
  return {
    rewardWindow: createIdleRewardWindowState(),
    summaryState: createIdleSessionSummaryState(session),
  };
}

function shouldFlush(buffer: BatchBuffer): boolean {
  return shouldFlushIdleRewardWindow({
    pendingBatchCount: buffer.rewardWindow.batches.length,
    lastFlushAt: buffer.rewardWindow.lastFlushAt,
    now: Date.now(),
    flushIntervalMs: FLUSH_INTERVAL_MS,
  });
}

/**
 * 将内存缓冲区批量写入 DB
 */
async function flushBuffer(
  session: IdleSessionRow,
  userId: number,
  buffer: BatchBuffer,
): Promise<boolean> {
  const flushPayload = getIdleRewardWindowFlushPayload(buffer.rewardWindow);
  if (flushPayload.batches.length === 0) return true;

  const batches = flushPayload.batches;
  const nextSummaryState = createIdleSessionSummaryState(buffer.summaryState.snapshot);
  const participant = buildIdleRewardParticipant(session, userId);

  try {
    await withTransactionAuto(async () => {
      const settledBatches: Array<
        IdleRewardWindowBatch & {
          expGained: number;
          silverGained: number;
          itemsGained: RewardItemEntry[];
          bagFullFlag: boolean;
        }
      > = [];

      for (const batch of batches) {
        const settledReward = await settleIdleBattleRewardSettlementPlan(
          participant,
          {
            expGained: batch.expGained,
            silverGained: batch.silverGained,
            previewItems: batch.previewItems,
            dropPlans: batch.dropPlans,
          },
        );
        appendBattleResultToIdleSessionSummary(nextSummaryState, {
          ...settledReward,
          result: batch.result,
        });
        settledBatches.push({
          ...batch,
          expGained: settledReward.expGained,
          silverGained: settledReward.silverGained,
          itemsGained: settledReward.itemsGained,
          bagFullFlag: settledReward.bagFullFlag,
        });
      }

      const summaryPayload = getIdleSessionSummaryFlushPayload(nextSummaryState);
      const values = batches
        .map(
          (b, i) =>
            `($${i * 11 + 1}, $${i * 11 + 2}, $${i * 11 + 3}, $${i * 11 + 4}, $${i * 11 + 5}, $${i * 11 + 6}, $${i * 11 + 7}, $${i * 11 + 8}, $${i * 11 + 9}, $${i * 11 + 10}, $${i * 11 + 11}, NOW())`,
        )
        .join(', ');
      const params = settledBatches.flatMap((b) => [
        b.id,
        b.sessionId,
        b.batchIndex,
        b.result,
        b.roundCount,
        b.randomSeed,
        b.expGained,
        b.silverGained,
        JSON.stringify(b.replaySnapshot),
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

      await idleSessionService.updateSessionSummary(
        session.id,
        summaryPayload.delta,
        summaryPayload.snapshot,
      );
    });
    buffer.summaryState.snapshot = nextSummaryState.snapshot;
    resetIdleSessionSummaryDelta(buffer.summaryState);
    resetIdleRewardWindowDelta(buffer.rewardWindow, Date.now());
  } catch (err) {
    if (err instanceof Error) {
      logIdleFlushFailure('IdleBattleExecutor', err);
      return false;
    }

    throw err;
  }

  try {
    await getGameServer().pushCharacterUpdate(userId);
  } catch (err) {
    console.error(`[IdleBattleExecutor] flush 后角色快照推送失败:`, err);
  }

  return true;
}

/**
 * 将所有活跃会话的内存缓冲区批量写入 DB（进程退出时调用）
 */
export async function flushAllBuffers(): Promise<void> {
  const entries = Array.from(activeBuffers.entries());
  if (entries.length === 0) return;

  console.log(`[IdleBattleExecutor] 正在刷写 ${entries.length} 个会话的缓冲区...`);

  const results = await Promise.all(
    entries.map(([, { session, userId, buffer }]) =>
      flushBuffer(session, userId, buffer),
    ),
  );

  const failedCount = results.filter((result) => !result).length;
  if (failedCount > 0) {
    console.error(`[IdleBattleExecutor] ${failedCount} 个会话 flush 失败`);
  }
  console.log(
    `[IdleBattleExecutor] 缓冲区刷写完成（成功 ${results.length - failedCount}/${results.length}）`,
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
  const buffer = createBuffer(session);
  const runtime = {
    running: false,
    wakeRequested: false,
    stopRequested: false,
    lastSessionStatusCheckAt: 0,
  };
  let cachedRoomMonsters: IdleRoomMonsterSlot[] | null = null;

  registerIdleExecutionLoop(session.id);
  loopRuntimeStates.set(session.id, runtime);
  activeBuffers.set(session.id, { session, userId, buffer });

  function clearLoopRuntimeState(): void {
    unregisterIdleExecutionLoop(session.id);
    activeLoops.delete(session.id);
    activeBuffers.delete(session.id);
    loopWakeHandlers.delete(session.id);
    loopRuntimeStates.delete(session.id);
  }

  async function finalizeTermination(
    stop: Extract<TerminationCheckResult, { terminate: true }>
  ): Promise<void> {
    const flushSucceeded =
      !(shouldFlush(buffer) || stop.terminate) ||
      (await flushBuffer(session, userId, buffer));
    const flushDecision = resolveIdleTerminationFlushDecision({
      executorLabel: 'IdleBattleExecutor',
      sessionId: session.id,
      flushSucceeded,
    });
    if (!flushDecision.shouldFinalize) {
      runtime.wakeRequested = false;
      scheduleNext(flushDecision.retryDelayMs);
      return;
    }

    clearLoopRuntimeState();
    await idleSessionService.completeIdleSession(session.id, stop.status);
    await idleSessionService.releaseIdleLock(session.characterId);

    try {
      getGameServer().emitToUser(userId, 'idle:finished', {
        sessionId: session.id,
        reason: stop.reason,
      });
    } catch {
      // 忽略推送错误
    }
  }

  function scheduleNext(delayMs: number): void {
    touchIdleExecutionLoop(session.id);
    const handle = setTimeout(() => {
      void runSingleTick();
    }, delayMs);
    activeLoops.set(session.id, handle);
  }

  function wakeNow(): void {
    runtime.wakeRequested = true;
    touchIdleExecutionLoop(session.id);
    if (runtime.running) {
      return;
    }

    const handle = activeLoops.get(session.id);
    if (handle) {
      clearTimeout(handle);
    }
    scheduleNext(0);
  }

  async function getCachedRoomMonsters(): Promise<IdleRoomMonsterSlot[]> {
    if (cachedRoomMonsters) {
      return cachedRoomMonsters;
    }

    const room = await getRoomInMap(session.mapId, session.roomId);
    cachedRoomMonsters = room?.monsters ?? [];
    return cachedRoomMonsters;
  }

  async function runSingleTick(): Promise<void> {
    touchIdleExecutionLoop(session.id);
    runtime.running = true;
    try {
      // 先检查终止条件，确保 stop 能在下一轮立即生效。
      const shouldStopBeforeBattle = await checkTerminationConditions(session, runtime);
      if (shouldStopBeforeBattle.terminate) {
        await finalizeTermination(shouldStopBeforeBattle);
        return;
      }

      // 1. 获取房间怪物配置（会话级缓存，避免每轮重复解析同一房间）
      const roomMonsters = await getCachedRoomMonsters();

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
      const rewardPlan = await buildIdleBattleRewardSettlementPlan(
        workerResult.monsterIds,
        buildIdleRewardParticipant(session, userId),
        workerResult.result,
      );
      const batchResult: SingleBatchResult = {
        ...workerResult,
        rewardPlan,
      };

      // 4. 追加结果到缓冲区
      appendIdleRewardWindowBatch(buffer.rewardWindow, {
        id: randomUUID(),
        sessionId: session.id,
        batchIndex,
        result: batchResult.result,
        roundCount: batchResult.roundCount,
        randomSeed: batchResult.randomSeed,
        expGained: batchResult.rewardPlan.expGained,
        silverGained: batchResult.rewardPlan.silverGained,
        previewItems: batchResult.rewardPlan.previewItems,
        dropPlans: batchResult.rewardPlan.dropPlans,
        replaySnapshot: batchResult.replaySnapshot,
        monsterIds: batchResult.monsterIds,
      });
      batchIndex++;

      // 5. 实时推送本场摘要
      try {
        getGameServer().emitToUser(userId, 'idle:update', {
          sessionId: session.id,
          batchIndex: batchIndex - 1,
          result: batchResult.result,
          expGained: batchResult.rewardPlan.expGained,
          silverGained: batchResult.rewardPlan.silverGained,
          itemsGained: batchResult.rewardPlan.previewItems,
          roundCount: batchResult.roundCount,
        });
      } catch {
        // 忽略推送错误
      }

      const shouldStopAfterBattle = checkTerminationConditionsWithoutDb(session, runtime);
      if (shouldFlush(buffer) || shouldStopAfterBattle.terminate) {
        await flushBuffer(session, userId, buffer);
      }

      if (shouldStopAfterBattle.terminate) {
        await finalizeTermination(shouldStopAfterBattle);
        return;
      }

      const nextDelay =
        runtime.wakeRequested
          ? 0
          : BATTLE_START_COOLDOWN_MS + batchResult.roundCount * BATTLE_TICK_MS;
      runtime.wakeRequested = false;
      scheduleNext(nextDelay);
    } catch (err) {
      console.error(`[IdleBattleExecutor] 会话 ${session.id} 第 ${batchIndex} 场战斗异常:`, err);
      const nextDelay = runtime.wakeRequested ? 0 : BATTLE_START_COOLDOWN_MS;
      runtime.wakeRequested = false;
      scheduleNext(nextDelay);
    } finally {
      runtime.running = false;
    }
  }

  loopWakeHandlers.set(session.id, wakeNow);
  scheduleNext(BATTLE_START_COOLDOWN_MS);
}

/**
 * 请求会话立即停止（配合 stopIdleSession 的 status='stopping' 使用）
 *
 * 作用：
 *   1. 立即清除当前 sleep timeout
 *   2. 唤醒下一轮 0ms 终止检查
 *   3. 不直接改 DB 状态，状态持久化由 stopIdleSession 负责
 */
export function requestImmediateStop(sessionId: string): void {
  const runtime = loopRuntimeStates.get(sessionId);
  if (runtime) {
    runtime.stopRequested = true;
    runtime.wakeRequested = true;
  }
  touchIdleExecutionLoop(sessionId);
  const wakeNow = loopWakeHandlers.get(sessionId);
  if (wakeNow) {
    wakeNow();
  }
}

/**
 * 强制停止指定会话的执行循环（仅用于进程级停机）
 */
export function stopExecutionLoop(sessionId: string): void {
  const handle = activeLoops.get(sessionId);
  if (handle) {
    clearTimeout(handle);
  }
  unregisterIdleExecutionLoop(sessionId);
  activeLoops.delete(sessionId);
  activeBuffers.delete(sessionId);
  loopWakeHandlers.delete(sessionId);
  loopRuntimeStates.delete(sessionId);
}

/**
 * 停止所有挂机会话的执行循环（优雅关闭）
 */
export function stopAllExecutionLoops(): void {
  console.log(`[IdleBattleExecutor] 正在停止 ${activeLoops.size} 个执行循环...`);

  for (const [, handle] of activeLoops.entries()) {
    clearTimeout(handle);
  }

  activeLoops.clear();
  activeBuffers.clear();
  loopWakeHandlers.clear();
  loopRuntimeStates.clear();
  clearIdleExecutionLoopRegistry();

  console.log('[IdleBattleExecutor] 所有执行循环已停止');
}

// ============================================
// 终止条件检查
// ============================================

type TerminationCheckResult =
  | { terminate: false }
  | { terminate: true; status: 'completed' | 'interrupted'; reason: string };

function checkTerminationConditionsWithoutDb(
  session: IdleSessionRow,
  runtime: {
    stopRequested: boolean;
  },
): TerminationCheckResult {
  if (runtime.stopRequested) {
    return { terminate: true, status: 'interrupted', reason: '会话已停止' };
  }

  const elapsed = Date.now() - new Date(session.startedAt).getTime();
  if (elapsed >= session.maxDurationMs) {
    return { terminate: true, status: 'completed', reason: '达到时长上限' };
  }

  return { terminate: false };
}

async function checkTerminationConditions(
  session: IdleSessionRow,
  runtime: {
    stopRequested: boolean;
    lastSessionStatusCheckAt: number;
  },
  options: {
    forceDbStatusCheck?: boolean;
  } = {},
): Promise<TerminationCheckResult> {
  const localTermination = checkTerminationConditionsWithoutDb(session, runtime);
  if (localTermination.terminate) {
    return localTermination;
  }

  const now = Date.now();
  const shouldSkipDbStatusCheck =
    options.forceDbStatusCheck !== true &&
    now - runtime.lastSessionStatusCheckAt < SESSION_STATUS_CHECK_INTERVAL_MS;
  if (shouldSkipDbStatusCheck) {
    return { terminate: false };
  }

  // 低频检查会话状态（兜住跨进程/重启恢复后的状态漂移）
  const currentSession = await idleSessionService.getIdleSessionById(session.id);
  if (!currentSession) {
    return { terminate: true, status: 'completed', reason: 'session_not_found' };
  }
  if (currentSession.status === 'stopping') {
    runtime.stopRequested = true;
    return { terminate: true, status: 'interrupted', reason: '会话已停止' };
  }
  if (currentSession.status !== 'active') {
    return { terminate: true, status: 'completed', reason: '会话已结束' };
  }
  runtime.lastSessionStatusCheckAt = now;

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
      await idleSessionService.completeIdleSession(session.id, 'interrupted');
      continue;
    }

    startExecutionLoop(session, userIdRes);
  }

  console.log(`✓ ${res.rows.length} 个挂机会话已恢复`);
}
