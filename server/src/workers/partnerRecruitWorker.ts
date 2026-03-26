/**
 * 伙伴招募 AI 生成 worker
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在独立线程中执行单个伙伴招募任务的 AI 文本/头像生成与预览落库。
 * 2) 不做什么：不处理 HTTP、不直接推送 WebSocket，也不管理任务排队。
 *
 * 输入/输出：
 * - 输入：`executePartnerRecruit`，包含 characterId / generationId / quality。
 * - 输出：`result`（成功或失败结果）或 `error`（worker 级异常）。
 *
 * 数据流/状态流：
 * 主线程 runner -> worker -> partnerRecruitService.processPendingRecruitJob -> runner。
 *
 * 关键边界条件与坑点：
 * 1) 业务失败必须转换成 `result` 返回主线程，避免任务静默卡在 pending。
 * 2) worker 只执行单任务，不在本线程里维护重试或队列，线程生命周期统一由 runner 管理。
 */
import '../bootstrap/installConsoleLogger.js';
import { parentPort } from 'worker_threads';
import { partnerRecruitService } from '../services/partnerRecruitService.js';
import type {
  PartnerRecruitWorkerMessage,
  PartnerRecruitWorkerResponse,
} from './partnerRecruitWorkerShared.js';

if (!parentPort) {
  throw new Error('[PartnerRecruitWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (message: PartnerRecruitWorkerMessage) => {
  void (async () => {
    try {
      if (message.type === 'shutdown') {
        process.exit(0);
        return;
      }

      if (message.type !== 'executePartnerRecruit') {
        return;
      }

      const result = await partnerRecruitService.processPendingRecruitJob({
        characterId: message.payload.characterId,
        generationId: message.payload.generationId,
        quality: message.payload.quality,
      });

      const response: PartnerRecruitWorkerResponse = {
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
      const response: PartnerRecruitWorkerResponse = {
        type: 'error',
        payload: {
          generationId: message.type === 'executePartnerRecruit' ? message.payload.generationId : '',
          characterId: message.type === 'executePartnerRecruit' ? message.payload.characterId : 0,
          error: error instanceof Error ? error.message : '未知异常',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    }
  })();
});

parentPort.postMessage({ type: 'ready' } as PartnerRecruitWorkerResponse);
