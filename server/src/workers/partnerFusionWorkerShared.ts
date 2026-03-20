/**
 * 三魂归契 worker 通讯协议
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中定义主线程与三魂归契 worker 之间的消息结构，避免 runner 与 worker 各自维护字符串协议。
 * 2) 不做什么：不执行业务、不读写数据库，也不直接推送前端。
 *
 * 输入/输出：
 * - 输入：主线程投递的执行消息。
 * - 输出：worker 返回的 ready / result / error 消息。
 *
 * 数据流/状态流：
 * runner -> partnerFusionWorkerMessage -> worker
 * worker -> partnerFusionWorkerResponse -> runner
 *
 * 关键边界条件与坑点：
 * 1) 返回载荷必须复用业务侧状态类型，避免 worker 和 service 的状态字符串漂移。
 * 2) 该协议只服务于单次三魂归契任务，不混入其他 worker 任务。
 */
import type { GeneratedPartnerPreviewDto } from '../services/shared/partnerGeneratedPreview.js';
import type { PartnerFusionJobStatus } from '../services/shared/partnerFusionJobShared.js';

export type PartnerFusionWorkerPayload = {
  characterId: number;
  fusionId: string;
};

export type PartnerFusionWorkerMessage =
  | { type: 'executePartnerFusion'; payload: PartnerFusionWorkerPayload }
  | { type: 'shutdown' };

export type PartnerFusionWorkerResult = {
  fusionId: string;
  characterId: number;
  status: Extract<PartnerFusionJobStatus, 'generated_preview' | 'failed'>;
  preview: GeneratedPartnerPreviewDto | null;
  errorMessage: string | null;
};

export type PartnerFusionWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; payload: PartnerFusionWorkerResult }
  | { type: 'error'; payload: { fusionId: string; characterId: number; error: string; stack?: string } };
