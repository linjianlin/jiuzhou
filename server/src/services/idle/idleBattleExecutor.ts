/**
 * IdleBattleExecutor — 挂机战斗执行循环（批量写入版）
 *
 * 作用：
 *   驱动离线挂机战斗的核心执行逻辑，包括：
 *   - executeSingleBatch：执行单场战斗（纯计算 + 奖励分发，不直接写 DB）
 *   - flushBuffer：将内存缓冲区批量写入 DB（减少 DB 操作次数）
 *   - startExecutionLoop：启动 setInterval 驱动的执行循环，检查终止条件
 *   - stopExecutionLoop：手动停止指定会话的执行循环
 *   - recoverActiveIdleSessions：服务启动时恢复所有活跃会话
 *
 * 输入/输出：
 *   - executeSingleBatch(session, batchIndex, userId) → SingleBatchResult
 *   - flushBuffer(sessionId, buffer) → Promise<void>
 *   - startExecutionLoop(session, userId) → void（异步驱动）
 *   - stopExecutionLoop(sessionId) → void
 *   - recoverActiveIdleSessions() → Promise<void>
 *
 * 数据流（批量写入）：
 *   startExecutionLoop → setTimeout → executeSingleBatch（纯计算）
 *   → appendToBuffer → 内存累加
 *   → 达到 FLUSH_BATCH_SIZE 或 FLUSH_INTERVAL_MS
 *   → flushBuffer → 批量 INSERT idle_battle_batches
 *   → emitToUser（每场仍实时推送）
 *   终止条件满足 → 强制 flushBuffer → completeIdleSession → releaseIdleLock
 *
 * 关键边界条件：
 *   1. 终止时必须强制 flush 剩余缓冲区，防止数据丢失
 *   2. flush 失败不中断循环，记录日志后继续（下次 flush 会重试累积数据）
 *   3. 战败时 expGained/silverGained/itemsGained 均为零（由 quickDistributeRewards 保证）
 *   4. 同一 sessionId 不会重复启动（activeLoops Map 保护）
 */

import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import { BATTLE_TICK_MS, BATTLE_START_COOLDOWN_MS } from '../battle/index.js';
import { getGameServer } from '../../game/gameServer.js';
import { getRoomInMap } from '../mapService.js';
import { getCharacterUserId } from '../sect/db.js';
import type { IdleSessionRow, RewardItemEntry } from './types.js';
import { toPgTextArrayLiteral } from './pgTextArrayLiteral.js';
import { resolveIdleBattleRewards } from './idleBattleRewardResolver.js';
import { simulateIdleBattle } from './idleBattleSimulationCore.js';
import type { BattleLogEntry } from '../../battle/types.js';
import { rowToIdleSessionRow } from './rowMappers.js';
import {
  completeIdleSession,
  releaseIdleLock,
  updateSessionSummary,
  getActiveIdleSession,
} from './idleSessionService.js';

// ============================================
// 常量
// ============================================

/**
 * 缓冲区积累多少场后触发 flush（场数阈值）
 * 1000 会话 × 10场/flush = 每次 flush 约 1000 次 DB 批量写入，而非 10000 次单条写入
 */
const FLUSH_BATCH_SIZE = 10;

/**
 * 距上次 flush 超过此时间后强制 flush（时间阈值，ms）
 * 防止低频会话长时间不 flush 导致数据延迟
 */
const FLUSH_INTERVAL_MS = 5_000;

// ============================================
// 内部状态
// ============================================

/** 执行循环 Map（sessionId → timeoutHandle）*/
const activeLoops = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 活跃缓冲区 Map（sessionId → { characterId, buffer }）
 *
 * 提升到模块级，使 flushAllBuffers 可以在进程退出时遍历所有会话缓冲区。
 * startExecutionLoop 写入，stopExecutionLoop / 终止时删除。
 */
const activeBuffers = new Map<string, { characterId: number; buffer: BatchBuffer }>();

// ============================================
// 类型定义
// ============================================

/** 单场战斗执行结果（纯计算结果，不含 DB 写入） */
export interface SingleBatchResult {
  result: 'attacker_win' | 'defender_win' | 'draw';
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  randomSeed: number;
  roundCount: number;
  battleLog: BattleLogEntry[];
  monsterIds: string[];
  bagFullFlag: boolean;
}

/**
 * 内存缓冲区：积累多场战斗结果，批量写入 DB
 *
 * 字段说明：
 *   - batches：待写入 idle_battle_batches 的行数据
 *   - summaryDelta：待更新 idle_sessions 的汇总增量
 *   - lastFlushAt：上次 flush 时间戳，用于时间阈值判断
 */
interface BatchBuffer {
  batches: Array<{
    id: string;
    sessionId: string;
    batchIndex: number;
    result: SingleBatchResult['result'];
    roundCount: number;
    randomSeed: number;
    expGained: number;
    silverGained: number;
    itemsGained: RewardItemEntry[];
    battleLog: BattleLogEntry[];
    monsterIds: string[];
  }>;
  summaryDelta: {
    totalBattlesDelta: number;
    winDelta: number;
    loseDelta: number;
    expDelta: number;
    silverDelta: number;
    newItems: RewardItemEntry[];
    bagFullFlag: boolean;
  };
  lastFlushAt: number;
}

/** 创建空缓冲区 */
function createBuffer(): BatchBuffer {
  return {
    batches: [],
    summaryDelta: {
      totalBattlesDelta: 0,
      winDelta: 0,
      loseDelta: 0,
      expDelta: 0,
      silverDelta: 0,
      newItems: [],
      bagFullFlag: false,
    },
    lastFlushAt: Date.now(),
  };
}

// ============================================
// executeSingleBatch：执行单场战斗（纯计算，不写 DB）
// ============================================

/**
 * 执行单场挂机战斗，返回结果（不直接写 DB）
 *
 * 步骤：
 *   1. 从 mapService 获取房间怪物列表
 *   2. 调用 simulateIdleBattle 执行统一战斗模拟
 *   3. 调用 resolveIdleBattleRewards 统一奖励结算
 *
 * 不做的事：
 *   - 不写 idle_battle_batches（由 flushBuffer 批量写入）
 *   - 不扣减 stamina（由 flushBuffer 批量扣减）
 *   - 不更新 idle_sessions 汇总（由 flushBuffer 批量更新）
 *
 * 失败场景：
 *   - 房间不存在或无怪物 → 返回 draw，无奖励
 *   - 怪物数据解析失败 → 返回 draw，无奖励
 *   - 战败 → expGained/silverGained/itemsGained 均为零
 */
export async function executeSingleBatch(
  session: IdleSessionRow,
  _batchIndex: number,
  userId: number,
): Promise<SingleBatchResult> {
  const room = await getRoomInMap(session.mapId, session.roomId);

  const simulationResult = simulateIdleBattle(session, userId, room?.monsters ?? []);
  const rewardSnapshot = await resolveIdleBattleRewards(
    simulationResult.monsterIds,
    session,
    userId,
    simulationResult.result,
  );

  return {
    result: simulationResult.result,
    expGained: rewardSnapshot.expGained,
    silverGained: rewardSnapshot.silverGained,
    itemsGained: rewardSnapshot.itemsGained,
    randomSeed: simulationResult.randomSeed,
    roundCount: simulationResult.roundCount,
    battleLog: simulationResult.battleLog,
    monsterIds: simulationResult.monsterIds,
    bagFullFlag: rewardSnapshot.bagFullFlag,
  };
}

// ============================================
// flushBuffer：批量写入 DB
// ============================================

/**
 * 将内存缓冲区中的战斗结果批量写入 DB
 *
 * 执行顺序（保证原子性语义）：
 *   1. 批量 INSERT idle_battle_batches（单条 SQL，VALUES 多行）
 *   2. updateSessionSummary（累加汇总）
 *
 * 关键边界：
 *   - 缓冲区为空时直接返回，不发起任何 DB 请求
 *   - flush 完成后重置缓冲区内容（保留 lastFlushAt 更新）
 *   - 两步操作不在同一事务中（性能优先），极端崩溃场景下可能有轻微数据不一致
 *     （可接受：挂机战斗结果允许最终一致）
 */
async function flushBuffer(
  _characterId: number,
  sessionId: string,
  buffer: BatchBuffer,
): Promise<void> {
  if (buffer.batches.length === 0) return;

  const batchesToFlush = buffer.batches.splice(0);

  const summaryDelta = { ...buffer.summaryDelta };
  buffer.summaryDelta = {
    totalBattlesDelta: 0,
    winDelta: 0,
    loseDelta: 0,
    expDelta: 0,
    silverDelta: 0,
    newItems: [],
    bagFullFlag: false,
  };
  buffer.lastFlushAt = Date.now();

  // 1. 批量 INSERT idle_battle_batches
  // 构造多行 VALUES：($1,$2,...),($11,$12,...) 每行 11 个参数
  const COLS_PER_ROW = 11;
  const values: (string | number)[] = [];
  const placeholders = batchesToFlush.map((b, i) => {
    const base = i * COLS_PER_ROW;
    values.push(
      b.id,
      b.sessionId,
      b.batchIndex,
      b.result,
      b.roundCount,
      b.randomSeed,
      b.expGained,
      b.silverGained,
      JSON.stringify(b.itemsGained),
      JSON.stringify(b.battleLog),
      toPgTextArrayLiteral(b.monsterIds),
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},NOW())`;
  });

  await query(
    `INSERT INTO idle_battle_batches (
      id, session_id, batch_index, result, round_count, random_seed,
      exp_gained, silver_gained, items_gained, battle_log, monster_ids, executed_at
    ) VALUES ${placeholders.join(',')}`,
    values,
  );

  // 2. 更新会话汇总
  await updateSessionSummary(sessionId, summaryDelta);
}

/**
 * 将单场战斗结果追加到缓冲区
 *
 * 复用点：仅在 startExecutionLoop 内部调用，集中管理缓冲区写入逻辑。
 * DB 写入由 flushBuffer 批量完成。
 */
async function appendToBuffer(
  buffer: BatchBuffer,
  batchResult: SingleBatchResult,
  sessionId: string,
  batchIndex: number,
  _characterId: number,
): Promise<void> {
  buffer.batches.push({
    id: randomUUID(),
    sessionId,
    batchIndex,
    result: batchResult.result,
    roundCount: batchResult.roundCount,
    randomSeed: batchResult.randomSeed,
    expGained: batchResult.expGained,
    silverGained: batchResult.silverGained,
    itemsGained: batchResult.itemsGained,
    battleLog: batchResult.battleLog,
    monsterIds: batchResult.monsterIds,
  });

  // 累加汇总增量
  buffer.summaryDelta.totalBattlesDelta += 1;
  if (batchResult.result === 'attacker_win') buffer.summaryDelta.winDelta += 1;
  if (batchResult.result === 'defender_win') buffer.summaryDelta.loseDelta += 1;
  buffer.summaryDelta.expDelta += batchResult.expGained;
  buffer.summaryDelta.silverDelta += batchResult.silverGained;

  // 合并物品（同 itemDefId 累加数量）
  for (const item of batchResult.itemsGained) {
    const existing = buffer.summaryDelta.newItems.find((i) => i.itemDefId === item.itemDefId);
    if (existing) {
      existing.quantity += item.quantity;
    } else {
      buffer.summaryDelta.newItems.push({ ...item });
    }
  }

  if (batchResult.bagFullFlag) {
    buffer.summaryDelta.bagFullFlag = true;
  }
}

/**
 * 判断缓冲区是否需要 flush
 *
 * 触发条件（满足任一）：
 *   - 积累场数 >= FLUSH_BATCH_SIZE
 *   - 距上次 flush 超过 FLUSH_INTERVAL_MS
 */
function shouldFlush(buffer: BatchBuffer): boolean {
  return (
    buffer.batches.length >= FLUSH_BATCH_SIZE ||
    Date.now() - buffer.lastFlushAt >= FLUSH_INTERVAL_MS
  );
}

// ============================================
// startExecutionLoop：执行循环控制
// ============================================

/**
 * 启动挂机执行循环（动态延迟版）
 *
 * 每次迭代：
 *   1. 执行单场战斗（纯计算）
 *   2. 追加结果到 BatchBuffer
 *   3. 实时推送本场摘要给客户端（不等 flush）
 *   4. 检查终止条件
 *   5. 若满足 flush 条件（场数/时间阈值）或即将终止，触发 flushBuffer
 *   6. 根据本场回合数动态计算下一场延迟：BATTLE_START_COOLDOWN_MS + roundCount × BATTLE_TICK_MS
 *
 * 关键边界：
 *   - 使用递归 setTimeout 而非 setInterval，每场战斗后根据实际回合数动态调整间隔
 *   - 终止时强制 flush 剩余缓冲区，防止最后几场数据丢失
 *   - flush 失败记录日志，不中断循环（下次 flush 会重试）
 *   - 同一 sessionId 不会重复启动（activeLoops Map 保护）
 */
export function startExecutionLoop(session: IdleSessionRow, userId: number): void {
  if (activeLoops.has(session.id)) return;

  let batchIndex = session.totalBattles + 1;
  const buffer = createBuffer();
  activeBuffers.set(session.id, { characterId: session.characterId, buffer });

  /** 递归调度下一场战斗，delayMs 为距下一场的等待时间 */
  function scheduleNext(delayMs: number): void {
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const batchResult = await executeSingleBatch(session, batchIndex, userId);
          await appendToBuffer(buffer, batchResult, session.id, batchIndex, session.characterId);
          batchIndex++;

          // 实时推送本场摘要（不等 flush，保证客户端体验）
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
            // GameServer 未初始化时忽略推送错误（如测试环境）
          }

          // 检查终止条件
          const shouldStop = await checkTerminationConditions(session, userId);

          // 满足 flush 条件或即将终止时批量写入
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
            return; // 终止，不再调度下一场
          }

          // 根据本场实际回合数动态计算下一场延迟
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
 * 手动停止指定会话的执行循环（仅清理内存，DB 状态由 stopIdleSession 负责）
 *
 * 注意：此函数不 flush 缓冲区。调用方（stopIdleSession）应确保在停止前
 * 已通过 status = 'stopping' 触发循环内部的终止 flush。
 */
export function stopExecutionLoop(sessionId: string): void {
  const handle = activeLoops.get(sessionId);
  if (handle) {
    clearTimeout(handle);
    activeLoops.delete(sessionId);
    activeBuffers.delete(sessionId);
  }
}

// ============================================
// 终止条件检查（内部函数）
// ============================================

type TerminationCheckResult =
  | { terminate: false }
  | { terminate: true; status: 'completed' | 'interrupted'; reason: string };

/**
 * 检查是否满足终止条件
 *
 * 按优先级顺序检查：
 *   1. status = 'stopping'（用户主动停止）→ interrupted
 *   2. 时长超限 → completed
 */
async function checkTerminationConditions(
  session: IdleSessionRow,
  _userId: number,
): Promise<TerminationCheckResult> {
  const currentSession = await getActiveIdleSession(session.characterId);
  if (!currentSession) {
    return { terminate: true, status: 'completed', reason: 'session_not_found' };
  }
  if (currentSession.status === 'stopping') {
    return { terminate: true, status: 'interrupted', reason: 'user_stopped' };
  }

  const elapsedMs = Date.now() - session.startedAt.getTime();
  if (elapsedMs >= session.maxDurationMs) {
    return { terminate: true, status: 'completed', reason: 'duration_exceeded' };
  }

  return { terminate: false };
}

// ============================================
// flushAllBuffers：进程退出时批量刷写所有缓冲区
// ============================================

/**
 * 将所有活跃会话的内存缓冲区批量写入 DB
 *
 * 作用：在进程收到 SIGTERM/SIGINT 时调用，防止缓冲区中未 flush 的战斗数据丢失。
 * 调用方：startupPipeline.ts 的 gracefulShutdown，在 pool.end() 之前执行。
 *
 * 关键边界：
 *   - 并发 flush 所有会话（Promise.allSettled），单个失败不影响其他
 *   - flush 完成后不清理 activeBuffers（进程即将退出，无需维护状态）
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
  console.log(`[IdleBattleExecutor] 缓冲区刷写完成（成功 ${results.length - failed.length}/${results.length}）`);
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
// recoverActiveIdleSessions：服务启动恢复
// ============================================

/**
 * 服务启动时恢复所有活跃挂机会话
 *
 * 查询 DB 中 status IN ('active', 'stopping') 的会话，
 * 对每个会话查询对应 userId，调用 startExecutionLoop 恢复执行。
 *
 * 关键边界：
 *   - 若 userId 查询失败（角色已删除），跳过该会话并标记为 interrupted
 *   - 'stopping' 状态的会话恢复后会在第一次终止检查时立即结束
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
    const sessionId = session.id;
    const characterId = session.characterId;

    const userId = await getCharacterUserId(characterId);
    if (!userId) {
      console.warn(`  跳过会话 ${sessionId}：角色 ${characterId} 不存在`);
      await completeIdleSession(sessionId, 'interrupted');
      continue;
    }

    startExecutionLoop(session, userId);
    console.log(`  恢复会话: ${sessionId} (角色 ${characterId})`);
  }

  console.log('✓ 挂机会话恢复完成');
}
