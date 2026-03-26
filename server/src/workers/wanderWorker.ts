/**
 * 云游奇遇异步生成 worker
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在独立线程中执行单个云游生成任务，避免前端点击“今日云游”后被 AI 长请求阻塞。
 * 2. 做什么：把任务结果统一转换成 `generated / failed` 返回主线程，避免任务卡在 pending。
 * 3. 不做什么：不处理 HTTP，不直接推送前端，也不在本线程内做排队管理。
 *
 * 输入/输出：
 * - 输入：`executeWanderGeneration`，包含 `characterId / generationId`。
 * - 输出：`result` 或 `error` 消息。
 *
 * 数据流/状态流：
 * 主线程 runner -> worker -> wanderService.processPendingGenerationJob -> runner。
 *
 * 关键边界条件与坑点：
 * 1. 业务失败必须落成 `result`，不能靠抛异常让任务永久停在 pending。
 * 2. worker 只执行单任务；任务恢复、重试与生命周期都由 runner 统一负责。
 */
import '../bootstrap/installConsoleLogger.js';
import { parentPort } from 'worker_threads';
import { wanderService } from '../services/wander/service.js';
import type { WanderWorkerMessage, WanderWorkerResponse } from './wanderWorkerShared.js';

if (!parentPort) {
  throw new Error('[WanderWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (message: WanderWorkerMessage) => {
  void (async () => {
    try {
      if (message.type === 'shutdown') {
        process.exit(0);
        return;
      }

      if (message.type !== 'executeWanderGeneration') {
        return;
      }

      const result = await wanderService.processPendingGenerationJob(
        message.payload.characterId,
        message.payload.generationId,
      );

      const response: WanderWorkerResponse = {
        type: 'result',
        payload: {
          generationId: message.payload.generationId,
          characterId: message.payload.characterId,
          status: result.data?.status === 'generated' ? 'generated' : 'failed',
          episodeId: result.data?.episodeId ?? null,
          errorMessage: result.data?.errorMessage ?? result.message,
        },
      };
      parentPort!.postMessage(response);
    } catch (error) {
      const response: WanderWorkerResponse = {
        type: 'error',
        payload: {
          generationId: message.type === 'executeWanderGeneration' ? message.payload.generationId : '',
          characterId: message.type === 'executeWanderGeneration' ? message.payload.characterId : 0,
          error: error instanceof Error ? error.message : '未知异常',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    }
  })();
});

parentPort.postMessage({ type: 'ready' } as WanderWorkerResponse);
