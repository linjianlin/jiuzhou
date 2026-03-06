/**
 * 洞府研修异步任务协调器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：负责投递研修生成任务到独立 worker，并在任务完成后统一推送 WebSocket 结果事件。
 * 2) 做什么：在服务启动时恢复数据库中遗留的 pending 任务，避免进程重启后任务永久卡住。
 * 3) 不做什么：不做 HTTP 参数校验，不直接生成草稿，也不在此处实现 UI 状态判断。
 *
 * 输入/输出：
 * - 输入：generationId / characterId / quality / userId。
 * - 输出：无同步业务结果；任务完成后通过 WebSocket 推送结果事件。
 *
 * 数据流/状态流：
 * route/service -> TechniqueGenerationJobRunner.enqueue -> worker 执行 -> runner 接收结果 -> emitToUser 推送。
 *
 * 关键边界条件与坑点：
 * 1) 若 worker 启动失败，必须主动把任务标记失败并退款，不能让任务停留在 pending。
 * 2) 恢复 pending 任务时用户可能离线，此时允许只落状态不推送，前端刷新后再从状态接口恢复红点。
 */
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../config/database.js';
import { getGameServer } from '../game/gameServer.js';
import { getCharacterUserId } from './sect/db.js';
import {
  techniqueGenerationService,
  type TechniqueQuality,
} from './techniqueGenerationService.js';
import type {
  TechniqueGenerationWorkerMessage,
  TechniqueGenerationWorkerPayload,
  TechniqueGenerationWorkerResponse,
} from '../workers/techniqueGenerationWorkerShared.js';

type EnqueueParams = TechniqueGenerationWorkerPayload & {
  userId?: number;
};

class TechniqueGenerationJobRunner {
  private activeWorkers = new Map<string, Worker>();
  private initialized = false;

  private resolveWorkerScript(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    if (process.env.NODE_ENV !== 'production') {
      return path.join(__dirname, '../../dist/workers/techniqueGenerationWorker.js');
    }
    return path.join(__dirname, '../workers/techniqueGenerationWorker.js');
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
    if (this.activeWorkers.has(params.generationId)) return;

    const worker = new Worker(this.resolveWorkerScript());
    this.activeWorkers.set(params.generationId, worker);

    const cleanup = async (): Promise<void> => {
      this.activeWorkers.delete(params.generationId);
      await worker.terminate().catch(() => undefined);
    };

    const failJob = async (reason: string): Promise<void> => {
      await techniqueGenerationService.failPendingGenerationJob(params.characterId, params.generationId, reason);
      const userId = params.userId ?? await getCharacterUserId(params.characterId);
      if (!userId) return;
      getGameServer().emitToUser(userId, 'techniqueResearchResult', {
        characterId: params.characterId,
        generationId: params.generationId,
        status: 'failed',
        hasUnreadResult: true,
        message: '洞府推演失败，请前往功法查看',
        errorMessage: reason,
      });
    };

    worker.once('error', (error) => {
      void (async () => {
        await cleanup();
        const message = error instanceof Error ? error.message : String(error);
        await failJob(`研修 worker 启动失败：${message}`);
      })();
    });

    worker.once('exit', (code) => {
      if (code === 0) return;
      void (async () => {
        if (!this.activeWorkers.has(params.generationId)) return;
        await cleanup();
        await failJob(`研修 worker 异常退出，退出码=${code}`);
      })();
    });

    worker.on('message', (message: TechniqueGenerationWorkerResponse) => {
      void (async () => {
        if (message.type === 'ready') {
          const request: TechniqueGenerationWorkerMessage = {
            type: 'executeTechniqueGeneration',
            payload: {
              characterId: params.characterId,
              generationId: params.generationId,
              quality: params.quality,
            },
          };
          worker.postMessage(request);
          return;
        }

        await cleanup();
        const userId = params.userId ?? await getCharacterUserId(params.characterId);
        if (message.type === 'error') {
          await failJob(`研修 worker 执行失败：${message.payload.error}`);
          return;
        }

        if (!userId) return;
        getGameServer().emitToUser(userId, 'techniqueResearchResult', {
          characterId: message.payload.characterId,
          generationId: message.payload.generationId,
          status: message.payload.status,
          hasUnreadResult: true,
          message: message.payload.status === 'generated_draft'
            ? '新的研修草稿已生成，请前往功法查看'
            : '洞府推演失败，请前往功法查看',
          preview: message.payload.preview
            ? {
                aiSuggestedName: message.payload.preview.aiSuggestedName,
                quality: message.payload.preview.quality,
                type: message.payload.preview.type,
                maxLayer: message.payload.preview.maxLayer,
              }
            : undefined,
          errorMessage: message.payload.errorMessage ?? undefined,
        });
      })();
    });
  }

  private async recoverPendingJobs(): Promise<void> {
    const result = await query(
      `
        SELECT id, character_id, quality_rolled
        FROM technique_generation_job
        WHERE status = 'pending'
        ORDER BY created_at ASC
      `,
    );

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const generationId = typeof row.id === 'string' ? row.id : '';
      const characterId = Number(row.character_id);
      const quality = (typeof row.quality_rolled === 'string' ? row.quality_rolled : '黄') as TechniqueQuality;
      if (!generationId || !Number.isFinite(characterId) || characterId <= 0) continue;
      const userId = await getCharacterUserId(characterId);
      await this.enqueue({
        generationId,
        characterId,
        quality,
        userId: userId ?? undefined,
      });
    }
  }
}

const runner = new TechniqueGenerationJobRunner();

export const initializeTechniqueGenerationJobRunner = async (): Promise<void> => {
  await runner.initialize();
};

export const shutdownTechniqueGenerationJobRunner = async (): Promise<void> => {
  await runner.shutdown();
};

export const enqueueTechniqueGenerationJob = async (params: EnqueueParams): Promise<void> => {
  await runner.enqueue(params);
};
