/**
 * 三魂归契 AI 生成 worker
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在独立线程中执行单个三魂归契任务的 AI 伙伴预览生成。
 * 2) 不做什么：不处理 HTTP、不直接推送 Socket，也不维护任务队列。
 *
 * 输入/输出：
 * - 输入：`executePartnerFusion`，包含 characterId 与 fusionId。
 * - 输出：`result`（成功或失败结果）或 `error`（worker 级异常）。
 *
 * 数据流/状态流：
 * 主线程 runner -> worker -> partnerFusionService.processPendingFusionJob -> runner。
 *
 * 关键边界条件与坑点：
 * 1) 业务失败必须转换成 `result` 返回主线程，不能让任务静默停在 pending。
 * 2) worker 只执行单任务，线程生命周期统一由 runner 管理。
 */
import '../bootstrap/installConsoleLogger.js';
import { parentPort } from 'worker_threads';
import type {
  PartnerFusionWorkerMessage,
  PartnerFusionWorkerResponse,
} from './partnerFusionWorkerShared.js';
import { executePartnerFusionWorkerTask } from './partnerFusionWorkerExecution.js';

if (!parentPort) {
  throw new Error('[PartnerFusionWorker] parentPort 未定义，无法启动 Worker');
}

parentPort.on('message', (message: PartnerFusionWorkerMessage) => {
  void (async () => {
    try {
      if (message.type === 'shutdown') {
        process.exit(0);
        return;
      }

      if (message.type !== 'executePartnerFusion') {
        return;
      }

      const response = await executePartnerFusionWorkerTask({
        characterId: message.payload.characterId,
        fusionId: message.payload.fusionId,
      });
      parentPort!.postMessage(response);
    } catch (error) {
      const response: PartnerFusionWorkerResponse = {
        type: 'error',
        payload: {
          fusionId: message.type === 'executePartnerFusion' ? message.payload.fusionId : '',
          characterId: message.type === 'executePartnerFusion' ? message.payload.characterId : 0,
          error: error instanceof Error ? error.message : '未知异常',
          stack: error instanceof Error ? error.stack : undefined,
        },
      };
      parentPort!.postMessage(response);
    }
  })();
});

parentPort.postMessage({ type: 'ready' } as PartnerFusionWorkerResponse);
