/**
 * IdleBattleWorker — 离线挂机战斗计算 Worker
 *
 * 作用：
 *   在独立线程中执行挂机战斗的纯计算部分，避免阻塞主线程事件循环。
 *   仅负责战斗模拟，不涉及奖励结算与数据库写入（由主线程负责）。
 *
 * 输入/输出：
 *   - 接收消息：{ type: 'executeBatch', payload: ExecuteBatchPayload }
 *   - 返回消息：{ type: 'batchResult', batchIndex, result: SingleBatchResult }
 *                或 { type: 'error', batchIndex, error: string }
 *
 * 数据流：
 *   主线程 → Worker: executeBatch 消息（包含 session 快照、怪物配置）
 *   Worker → 主线程: batchResult 消息（战斗结果、战斗日志）
 *
 * 关键边界条件：
 *   1. Worker 内不访问数据库（所有数据通过消息传递）
 *   2. Worker 内不访问 Redis（无状态计算）
 *   3. Worker 内不推送 Socket 消息（由主线程负责）
 *   4. 怪物解析复用 resolveMonsterDataForBattle，保持与普通战斗一致
 */

import { parentPort } from 'worker_threads';
import type { IdleSessionRow } from '../services/idle/types.js';
import {
  simulateIdleBattle,
  type IdleBattleSimulationResult,
  type IdleRoomMonsterSlot,
} from '../services/idle/idleBattleSimulationCore.js';

// ============================================
// 类型定义
// ============================================

type ExecuteBatchPayload = {
  session: IdleSessionRow;
  batchIndex: number;
  userId: number;
  /** 房间怪物配置（从主线程传入，避免 Worker 内查询 DB）*/
  roomMonsters: IdleRoomMonsterSlot[];
};

type SingleBatchResult = IdleBattleSimulationResult;

type WorkerMessage =
  | { type: 'executeBatch'; payload: ExecuteBatchPayload }
  | { type: 'shutdown' };

type WorkerResponse =
  | { type: 'batchResult'; batchIndex: number; result: SingleBatchResult }
  | { type: 'error'; batchIndex: number; error: string; stack?: string }
  | { type: 'ready' };

// ============================================
// 核心计算函数（纯函数，无副作用）
// ============================================

/**
 * 执行单场挂机战斗（纯计算，无 DB/Redis/Socket 操作）
 *
 * 步骤：
 *   1. 调用 simulateIdleBattle（复用普通执行器同一模拟逻辑）
 *   2. 返回战斗过程与结果（奖励由主线程统一结算）
 *
 * 注意：
 *   - Worker 不做奖励结算，避免与主线程规则分叉
 */
function executeSingleBatch(payload: ExecuteBatchPayload): SingleBatchResult {
  return simulateIdleBattle(payload.session, payload.userId, payload.roomMonsters);
}

// ============================================
// Worker 消息处理
// ============================================

if (!parentPort) {
  throw new Error('[IdleBattleWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (msg: WorkerMessage) => {
  try {
    if (msg.type === 'executeBatch') {
      const result = executeSingleBatch(msg.payload);
      const response: WorkerResponse = {
        type: 'batchResult',
        batchIndex: msg.payload.batchIndex,
        result,
      };
      parentPort!.postMessage(response);
    } else if (msg.type === 'shutdown') {
      // 优雅关闭：清理资源后退出
      process.exit(0);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const response: WorkerResponse = {
      type: 'error',
      batchIndex: (msg as { payload?: { batchIndex?: number } }).payload?.batchIndex ?? -1,
      error: errorMsg,
      stack: err instanceof Error ? err.stack : undefined,
    };
    parentPort!.postMessage(response);
  }
});

// Worker 启动完成，通知主线程
parentPort.postMessage({ type: 'ready' } as WorkerResponse);
