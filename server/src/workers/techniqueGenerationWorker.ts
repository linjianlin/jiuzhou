/**
 * 洞府研修 AI 生成 worker
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在独立线程中执行单个研修任务的 AI 生成与草稿落库。
 * 2) 不做什么：不处理 HTTP、不会直接推送 WebSocket，也不管理任务队列。
 *
 * 输入/输出：
 * - 输入：`executeTechniqueGeneration`，包含 characterId / generationId / techniqueType / quality。
 * - 输出：`result`（成功或失败结果）或 `error`（worker 级异常）。
 *
 * 数据流/状态流：
 * 主线程 runner -> worker -> techniqueGenerationService.processPendingGenerationJob -> runner。
 *
 * 关键边界条件与坑点：
 * 1) 所有业务失败都要转换成 `result` 返回给主线程，避免任务静默卡在 pending。
 * 2) worker 只执行单任务，不在本线程里维护排队与重试，队列统一由主线程 runner 管控。
 */
import '../bootstrap/installConsoleLogger.js';
import { parentPort } from 'worker_threads';
import { techniqueGenerationService } from '../services/techniqueGenerationService.js';
import type {
  TechniqueGenerationWorkerMessage,
  TechniqueGenerationWorkerResponse,
} from './techniqueGenerationWorkerShared.js';

if (!parentPort) {
  throw new Error('[TechniqueGenerationWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (message: TechniqueGenerationWorkerMessage) => {
  void (async () => {
    try {
      if (message.type === 'shutdown') {
        process.exit(0);
        return;
      }

      if (message.type !== 'executeTechniqueGeneration') {
        return;
      }

      const result = await techniqueGenerationService.processPendingGenerationJob(message.payload);
      const response: TechniqueGenerationWorkerResponse = {
        type: 'result',
        payload: {
          generationId: message.payload.generationId,
          characterId: message.payload.characterId,
          status: result.data?.status ?? 'failed',
          preview: result.data?.preview ?? null,
          errorMessage: result.data?.errorMessage ?? result.message,
        },
      };
      parentPort!.postMessage(response);
    } catch (error) {
      const response: TechniqueGenerationWorkerResponse = {
        type: 'error',
        payload: {
          generationId: message.type === 'executeTechniqueGeneration' ? message.payload.generationId : '',
          characterId: message.type === 'executeTechniqueGeneration' ? message.payload.characterId : 0,
          error: error instanceof Error ? error.message : '未知异常',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    }
  })();
});

parentPort.postMessage({ type: 'ready' } as TechniqueGenerationWorkerResponse);
