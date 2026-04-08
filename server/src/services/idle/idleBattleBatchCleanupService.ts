import type { PoolClient } from 'pg';
import {
  parseScheduledCleanupBooleanEnv,
  parseScheduledCleanupIntegerEnv,
} from '../shared/scheduledCleanupConfig.js';
import { withSessionAdvisoryLock } from '../shared/sessionAdvisoryLock.js';
import {
  IDLE_FINISHED_SESSION_STATUSES,
  IDLE_HISTORY_KEEP_SESSION_COUNT,
} from './idleHistoryRetention.js';

/**
 * 挂机历史清理服务（仅负责清理逻辑，不负责定时调度）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按“每个角色仅保留最近 N 个已结束挂机会话”的规则清理 idle_sessions，控制历史体积增长。
 * 2. 做什么：依赖 idle_sessions -> idle_battle_batches 的级联删除，一并清理回放批次明细，避免批次表无限增长。
 * 3. 不做什么：不创建 setInterval，不管理线程生命周期；调度统一交给 cleanupWorker。
 *
 * 输入/输出：
 * - 输入：环境变量（是否启用、每角色保留条数、调度间隔、单批删除会话数、单轮最大批次数）。
 * - 输出：runCleanupOnce 返回本轮删除的会话数；getScheduleConfig 返回调度配置。
 *
 * 数据流/状态流：
 * cleanupWorker -> getScheduleConfig -> runCleanupOnce
 * -> advisory lock -> 分批 DELETE idle_sessions -> CASCADE 删除 idle_battle_batches -> 返回删除统计
 *
 * 关键边界条件与坑点：
 * 1. 多实例部署使用 pg_try_advisory_lock，避免多个实例并发清理同一批数据。
 * 2. 只处理 completed / interrupted，会话仍处于 active / stopping 时绝不进入裁剪集合。
 * 3. 单轮清理采用“单批上限 + 最大批次数”限制，避免单次事务过大导致锁等待/WAL 激增。
 */

type IdleCleanupConfig = {
  enabled: boolean;
  keepSessionCount: number;
  intervalMs: number;
  deleteSessionBatchSize: number;
  maxDeleteBatchesPerRun: number;
};

export type IdleBattleBatchCleanupScheduleConfig = {
  enabled: boolean;
  intervalMs: number;
};

const IDLE_CLEANUP_LOCK_KEY_1 = 2026;
const IDLE_CLEANUP_LOCK_KEY_2 = 311;
const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_DELETE_SESSION_BATCH_SIZE = 20;
const DEFAULT_MAX_DELETE_BATCHES_PER_RUN = 20;

function loadIdleCleanupConfig(): IdleCleanupConfig {
  const enabled = parseScheduledCleanupBooleanEnv('IDLE_HISTORY_CLEANUP_ENABLED', true, 'IdleHistoryCleanup');
  const keepSessionCount = parseScheduledCleanupIntegerEnv(
    'IDLE_HISTORY_KEEP_COUNT',
    IDLE_HISTORY_KEEP_SESSION_COUNT,
    1,
    30,
    'IdleHistoryCleanup',
  );
  const intervalSeconds = parseScheduledCleanupIntegerEnv(
    'IDLE_HISTORY_CLEANUP_INTERVAL_SECONDS',
    DEFAULT_INTERVAL_SECONDS,
    60,
    86_400,
    'IdleHistoryCleanup',
  );
  const deleteSessionBatchSize = parseScheduledCleanupIntegerEnv(
    'IDLE_HISTORY_CLEANUP_DELETE_SESSION_BATCH_SIZE',
    DEFAULT_DELETE_SESSION_BATCH_SIZE,
    1,
    1_000,
    'IdleHistoryCleanup',
  );
  const maxDeleteBatchesPerRun = parseScheduledCleanupIntegerEnv(
    'IDLE_HISTORY_CLEANUP_MAX_BATCHES_PER_RUN',
    DEFAULT_MAX_DELETE_BATCHES_PER_RUN,
    1,
    200,
    'IdleHistoryCleanup',
  );

  return {
    enabled,
    keepSessionCount,
    intervalMs: intervalSeconds * 1000,
    deleteSessionBatchSize,
    maxDeleteBatchesPerRun,
  };
}

class IdleBattleBatchCleanupService {
  private readonly config: IdleCleanupConfig = loadIdleCleanupConfig();
  private inFlight = false;

  getScheduleConfig(): IdleBattleBatchCleanupScheduleConfig {
    return {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
    };
  }

  getConfigSummaryText(): string {
    return `每角色保留 ${this.config.keepSessionCount} 条，间隔 ${Math.floor(
      this.config.intervalMs / 1000,
    )} 秒，单批 ${this.config.deleteSessionBatchSize} 个会话，单轮最多 ${this.config.maxDeleteBatchesPerRun} 批`;
  }

  private async deleteExpiredSessionsOnce(client: PoolClient): Promise<number> {
    const res = await client.query(
      `
      WITH ranked_session AS (
        SELECT
          s.id,
          s.started_at,
          ROW_NUMBER() OVER (
            PARTITION BY s.character_id
            ORDER BY s.started_at DESC, s.id DESC
          ) AS rank_no
        FROM idle_sessions s
        WHERE s.status = ANY($1::varchar[])
      ),
      stale_session AS (
        SELECT rs.id
        FROM ranked_session rs
        WHERE rs.rank_no > $2
        ORDER BY rs.started_at ASC, rs.id ASC
         LIMIT $3
      )
      DELETE FROM idle_sessions s
      USING stale_session
      WHERE s.id = stale_session.id
    `,
      [IDLE_FINISHED_SESSION_STATUSES, this.config.keepSessionCount, this.config.deleteSessionBatchSize],
    );

    return res.rowCount ?? 0;
  }

  async runCleanupOnce(): Promise<number> {
    if (!this.config.enabled) return 0;
    if (this.inFlight) return 0;
    this.inFlight = true;

    try {
      const execution = await withSessionAdvisoryLock(IDLE_CLEANUP_LOCK_KEY_1, IDLE_CLEANUP_LOCK_KEY_2, async (client) => {
        let totalDeleted = 0;
        for (let batchNo = 0; batchNo < this.config.maxDeleteBatchesPerRun; batchNo += 1) {
          const deletedCount = await this.deleteExpiredSessionsOnce(client);
          totalDeleted += deletedCount;

          if (deletedCount < this.config.deleteSessionBatchSize) {
            break;
          }
        }

        if (totalDeleted > 0) {
          console.log(
            `[IdleBatchCleanup] 本轮清理完成：删除 ${totalDeleted} 个历史会话（每角色保留 ${this.config.keepSessionCount} 条）`,
          );
        }

        return totalDeleted;
      });

      if (!execution.acquired) {
        return 0;
      }

      return execution.result ?? 0;
    } catch (error) {
      console.error('[IdleBatchCleanup] 清理失败:', error);
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}

export const idleBattleBatchCleanupService = new IdleBattleBatchCleanupService();
