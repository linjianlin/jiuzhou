/**
 * 三魂归契任务共享状态映射
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把三魂归契任务原始状态统一映射为前端可直接消费的当前任务、未读红点与结果态。
 * 2) 做什么：收口 pending/预览成功/失败/已确认 的可见性规则，避免服务端与前端各写一套判断。
 * 3) 不做什么：不查询数据库、不创建任务，也不处理素材校验。
 *
 * 输入/输出：
 * - 输入：融合任务状态输入对象。
 * - 输出：当前任务视图、未读标记与结果态。
 *
 * 数据流/状态流：
 * DB 行 + 预览 DTO + 物料 ID -> buildPartnerFusionJobState -> 状态接口 / Socket 推送 / 前端红点。
 *
 * 关键边界条件与坑点：
 * 1) `failed` 仍然需要保留在当前任务视图中，直到前端已读，否则玩家无法看到失败原因。
 * 2) `accepted` 必须从当前任务视图中移除，否则确认归契后结果卡不会消失。
 */
import type { GeneratedPartnerPreviewDto } from './partnerGeneratedPreview.js';

export type PartnerFusionJobStatus =
  | 'pending'
  | 'generated_preview'
  | 'accepted'
  | 'failed';

export type PartnerFusionJobStateInput = {
  fusionId: string;
  status: PartnerFusionJobStatus;
  startedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
  sourceQuality: string;
  resultQuality: string | null;
  materialPartnerIds: number[];
  preview: GeneratedPartnerPreviewDto | null;
};

export type PartnerFusionJobView = {
  fusionId: string;
  status: PartnerFusionJobStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  sourceQuality: string;
  resultQuality: string | null;
  materialPartnerIds: number[];
  preview: GeneratedPartnerPreviewDto | null;
};

export type PartnerFusionJobStateOutput = {
  currentJob: PartnerFusionJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_preview' | 'failed' | null;
};

export const buildPartnerFusionJobState = (
  input: PartnerFusionJobStateInput | null,
): PartnerFusionJobStateOutput => {
  if (!input) {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  if (input.status === 'accepted') {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  const currentJob: PartnerFusionJobView = {
    fusionId: input.fusionId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    errorMessage: input.errorMessage,
    sourceQuality: input.sourceQuality,
    resultQuality: input.resultQuality,
    materialPartnerIds: input.materialPartnerIds,
    preview: input.preview,
  };

  if (input.status === 'generated_preview') {
    return {
      currentJob,
      hasUnreadResult: !input.viewedAt,
      resultStatus: 'generated_preview',
    };
  }

  if (input.status === 'failed') {
    return {
      currentJob,
      hasUnreadResult: !input.viewedAt,
      resultStatus: 'failed',
    };
  }

  return {
    currentJob,
    hasUnreadResult: false,
    resultStatus: null,
  };
};
