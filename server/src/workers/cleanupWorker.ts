import {
  cleanupExpiredBattles,
  BATTLE_EXPIRED_CLEANUP_INTERVAL_MS,
} from '../services/battle/index.js';
import { dungeonExpiredInstanceCleanupService } from '../services/dungeonExpiredInstanceCleanupService.js';
import { idleBattleBatchCleanupService } from '../services/idle/idleBattleBatchCleanupService.js';
import { mailHistoryCleanupService } from '../services/mailHistoryCleanupService.js';

/**
 * 清理 Worker（单进程内的统一清理调度器）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承载“清理类”定时任务的调度（战斗过期状态、过期秘境实例、挂机会话历史、邮件热表历史）。
 * 2. 做什么：统一负责任务首轮执行、周期执行、并发互斥和停机清理。
 * 3. 不做什么：不实现具体业务清理 SQL/算法，具体清理由各 service 提供。
 *
 * 输入/输出：
 * - 输入：各清理 service 暴露的“单次清理函数 + 调度配置”。
 * - 输出：无返回值（副作用：启动/停止定时器并触发清理任务执行）。
 *
 * 数据流/状态流：
 * startupPipeline -> startCleanupWorker -> registerJobs -> runJobNow -> setInterval
 * shutdown -> stopCleanupWorker -> clearInterval 全量回收定时器
 *
 * 关键边界条件与坑点：
 * 1. 同一任务使用 inFlight 互斥，防止上轮未结束时重复触发造成并发清理。
 * 2. 任务执行异常仅记录日志，不影响其他清理任务继续执行。
 */

type CleanupJob = {
  id: string;
  label: string;
  enabled: boolean;
  intervalMs: number;
  run: () => Promise<void> | void;
};

type CleanupJobRuntime = {
  job: CleanupJob;
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
};

class CleanupWorker {
  private started = false;
  private jobs: CleanupJobRuntime[] = [];

  private buildJobs(): CleanupJob[] {
    const dungeonExpiredInstanceCleanupSchedule = dungeonExpiredInstanceCleanupService.getScheduleConfig();
    const idleBatchSchedule = idleBattleBatchCleanupService.getScheduleConfig();
    const mailHistoryCleanupSchedule = mailHistoryCleanupService.getScheduleConfig();

    return [
      {
        id: 'battle-expired-cleanup',
        label: '战斗过期状态清理',
        enabled: true,
        intervalMs: BATTLE_EXPIRED_CLEANUP_INTERVAL_MS,
        run: () => {
          cleanupExpiredBattles();
        },
      },
      {
        id: 'dungeon-expired-instance-cleanup',
        label: '过期秘境实例收口',
        enabled: dungeonExpiredInstanceCleanupSchedule.enabled,
        intervalMs: dungeonExpiredInstanceCleanupSchedule.intervalMs,
        run: async () => {
          await dungeonExpiredInstanceCleanupService.runCleanupOnce();
        },
      },
      {
        id: 'idle-batch-history-cleanup',
        label: '挂机会话历史清理',
        enabled: idleBatchSchedule.enabled,
        intervalMs: idleBatchSchedule.intervalMs,
        run: async () => {
          await idleBattleBatchCleanupService.runCleanupOnce();
        },
      },
      {
        id: 'mail-history-cleanup',
        label: '邮件热表生命周期清理',
        enabled: mailHistoryCleanupSchedule.enabled,
        intervalMs: mailHistoryCleanupSchedule.intervalMs,
        run: async () => {
          await mailHistoryCleanupService.runCleanupOnce();
        },
      },
    ];
  }

  private async runJob(runtime: CleanupJobRuntime): Promise<void> {
    if (runtime.inFlight) return;
    runtime.inFlight = true;

    try {
      await runtime.job.run();
    } catch (error) {
      console.error(`[CleanupWorker] 任务执行失败: ${runtime.job.id}`, error);
    } finally {
      runtime.inFlight = false;
    }
  }

  async startCleanupWorker(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const jobs = this.buildJobs().filter((job) => job.enabled);
    this.jobs = jobs.map((job) => ({
      job,
      timer: null,
      inFlight: false,
    }));

    if (this.jobs.length === 0) {
      console.log('[CleanupWorker] 无启用的清理任务，已跳过启动');
      return;
    }

    console.log(`[CleanupWorker] 启动，注册 ${this.jobs.length} 个清理任务`);
    for (const runtime of this.jobs) {
      if (runtime.job.id === 'idle-batch-history-cleanup') {
        console.log(`[CleanupWorker] ${runtime.job.label}：${idleBattleBatchCleanupService.getConfigSummaryText()}`);
      } else if (runtime.job.id === 'dungeon-expired-instance-cleanup') {
        console.log(`[CleanupWorker] ${runtime.job.label}：${dungeonExpiredInstanceCleanupService.getConfigSummaryText()}`);
      } else if (runtime.job.id === 'mail-history-cleanup') {
        console.log(`[CleanupWorker] ${runtime.job.label}：${mailHistoryCleanupService.getConfigSummaryText()}`);
      } else {
        console.log(
          `[CleanupWorker] ${runtime.job.label}：间隔 ${Math.floor(runtime.job.intervalMs / 1000)} 秒`,
        );
      }

      await this.runJob(runtime);
      runtime.timer = setInterval(() => {
        void this.runJob(runtime);
      }, runtime.job.intervalMs);
    }
  }

  stopCleanupWorker(): void {
    for (const runtime of this.jobs) {
      if (runtime.timer) {
        clearInterval(runtime.timer);
        runtime.timer = null;
      }
    }
    this.jobs = [];
    this.started = false;
  }
}

const cleanupWorker = new CleanupWorker();

export const startCleanupWorker = cleanupWorker.startCleanupWorker.bind(cleanupWorker);
export const stopCleanupWorker = cleanupWorker.stopCleanupWorker.bind(cleanupWorker);
