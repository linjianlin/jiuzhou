/**
 * 三魂归契异步任务协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：负责把三魂归契任务投递到独立 worker，并在任务完成后统一推送 Socket 结果事件。
 * 2) 做什么：在服务启动时恢复数据库中的 pending 归契任务，避免重启后任务永久卡死。
 * 3) 不做什么：不做 HTTP 参数校验，不直接生成预览，也不负责前端状态判定。
 *
 * 输入/输出：
 * - 输入：fusionId / characterId / userId。
 * - 输出：无同步业务结果；任务完成后通过 Socket 推送结果事件。
 *
 * 数据流/状态流：
 * route/service -> PartnerFusionJobRunner.enqueue -> worker 执行 -> runner 接收结果 -> emitToUser 推送。
 *
 * 关键边界条件与坑点：
 * 1) 若 worker 启动失败，必须主动把任务写成 failed，不能让任务停留在 pending。
 * 2) 恢复 pending 任务时用户可能离线，此时允许只落状态不推送，前端刷新后通过状态接口恢复结果。
 */
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { getGameServer } from '../game/gameServer.js';
import {
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
} from './staticConfigLoader.js';
import { getCharacterUserId } from './sect/db.js';
import { notifyPartnerFusionStatus } from './partnerFusionPush.js';
import { partnerFusionService } from './partnerFusionService.js';
import type {
  PartnerFusionWorkerMessage,
  PartnerFusionWorkerPayload,
  PartnerFusionWorkerResponse,
} from '../workers/partnerFusionWorkerShared.js';

type EnqueueParams = PartnerFusionWorkerPayload & {
  userId?: number;
};

class PartnerFusionJobRunner {
  private activeWorkers = new Map<string, Worker>();
  private initialized = false;

  private async syncGeneratedFusionSnapshots(): Promise<void> {
    await refreshGeneratedTechniqueSnapshots();
    await refreshGeneratedPartnerSnapshots();
  }

  private resolveWorkerScript(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    if (process.env.NODE_ENV !== 'production') {
      return path.join(__dirname, '../../dist/workers/partnerFusionWorker.js');
    }
    return path.join(__dirname, '../workers/partnerFusionWorker.js');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.recoverPendingJobs();
  }

  async shutdown(): Promise<void> {
    const workers = [...this.activeWorkers.values()];
    this.activeWorkers.clear();
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }

  async enqueue(params: EnqueueParams): Promise<void> {
    if (this.activeWorkers.has(params.fusionId)) return;

    const worker = new Worker(this.resolveWorkerScript());
    this.activeWorkers.set(params.fusionId, worker);

    const cleanup = async (): Promise<void> => {
      this.activeWorkers.delete(params.fusionId);
      await worker.terminate().catch(() => undefined);
    };

    const failJob = async (reason: string): Promise<void> => {
      await partnerFusionService.forceFailPendingFusionJob(params.characterId, params.fusionId, reason);
      const userId = params.userId ?? await getCharacterUserId(params.characterId);
      if (!userId) return;
      getGameServer().emitToUser(userId, 'partnerFusionResult', {
        characterId: params.characterId,
        fusionId: params.fusionId,
        status: 'failed',
        hasUnreadResult: true,
        message: '三魂归契失败，请前往伙伴界面查看',
        errorMessage: reason,
      });
      await notifyPartnerFusionStatus(params.characterId, userId);
    };

    worker.once('error', (error) => {
      void (async () => {
        await cleanup();
        const message = error instanceof Error ? error.message : String(error);
        await failJob(`三魂归契 worker 启动失败：${message}`);
      })();
    });

    worker.once('exit', (code) => {
      if (code === 0) return;
      void (async () => {
        if (!this.activeWorkers.has(params.fusionId)) return;
        await cleanup();
        await failJob(`三魂归契 worker 异常退出，退出码=${code}`);
      })();
    });

    worker.on('message', (message: PartnerFusionWorkerResponse) => {
      void (async () => {
        if (message.type === 'ready') {
          const request: PartnerFusionWorkerMessage = {
            type: 'executePartnerFusion',
            payload: {
              fusionId: params.fusionId,
              characterId: params.characterId,
            },
          };
          worker.postMessage(request);
          return;
        }

        await cleanup();
        const userId = params.userId ?? await getCharacterUserId(params.characterId);
        if (message.type === 'error') {
          await failJob(`三魂归契 worker 执行失败：${message.payload.error}`);
          return;
        }

        if (message.payload.status === 'generated_preview') {
          await this.syncGeneratedFusionSnapshots();
        }

        if (!userId) return;
        getGameServer().emitToUser(userId, 'partnerFusionResult', {
          characterId: message.payload.characterId,
          fusionId: message.payload.fusionId,
          status: message.payload.status,
          hasUnreadResult: true,
          message: message.payload.status === 'generated_preview'
            ? '三魂归契结果已生成，请前往伙伴界面查看'
            : '三魂归契失败，请前往伙伴界面查看',
          preview: message.payload.preview
            ? {
                name: message.payload.preview.name,
                quality: message.payload.preview.quality,
                role: message.payload.preview.role,
                element: message.payload.preview.element,
              }
            : undefined,
          errorMessage: message.payload.errorMessage ?? undefined,
        });
        await notifyPartnerFusionStatus(message.payload.characterId, userId);
      })();
    });
  }

  async abort(fusionId: string): Promise<void> {
    const worker = this.activeWorkers.get(fusionId);
    if (!worker) return;
    this.activeWorkers.delete(fusionId);
    await worker.terminate().catch(() => undefined);
  }

  private async recoverPendingJobs(): Promise<void> {
    const result = await query(
      `
        SELECT id, character_id
        FROM partner_fusion_job
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
    );

    for (const row of result.rows as Array<{ id: string; character_id: number }>) {
      const fusionId = String(row.id);
      const characterId = Number(row.character_id);
      if (!fusionId || !Number.isInteger(characterId) || characterId <= 0) continue;
      const userId = await getCharacterUserId(characterId);
      await this.enqueue({
        fusionId,
        characterId,
        userId: userId ?? undefined,
      });
    }
  }
}

const runner = new PartnerFusionJobRunner();

export const initializePartnerFusionJobRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownPartnerFusionJobRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const enqueuePartnerFusionJob = async (params: EnqueueParams): Promise<void> => {
  await runner.enqueue(params);
};

export const abortPartnerFusionJob = async (fusionId: string): Promise<void> => {
  await runner.abort(fusionId);
};
