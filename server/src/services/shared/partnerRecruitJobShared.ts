/**
 * 伙伴招募任务共享状态映射
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把招募任务原始状态行收敛为前端可直接消费的当前任务、未读红点与结果态。
 * 2) 做什么：统一 pending/预览成功/失败退款/已接受/已丢弃 的可见性，避免 service 与前端各写一套判断。
 * 3) 不做什么：不查数据库、不创建任务、不直接渲染 UI。
 *
 * 输入/输出：
 * - 输入：`PartnerRecruitJobStateInput`，由任务行与预览 DTO 组合而成。
 * - 输出：`currentJob/hasUnreadResult/resultStatus`。
 *
 * 数据流/状态流：
 * DB 行 -> buildPartnerRecruitJobState -> 状态接口 / Socket 推送 / 前端红点与结果卡。
 *
 * 关键边界条件与坑点：
 * 1) `refunded` 对前端仍属于失败结果，否则玩家看不到“失败并已退款”的原因。
 * 2) `accepted/discarded` 必须从当前任务视图里隐去，否则确认收下后结果卡不会消失。
 */
import type { GeneratedPartnerPreviewDto } from './partnerGeneratedPreview.js';

export type PartnerRecruitJobStatus =
  | 'pending'
  | 'generated_draft'
  | 'accepted'
  | 'failed'
  | 'refunded'
  | 'discarded';

export type PartnerRecruitPreviewDto = GeneratedPartnerPreviewDto;

export type PartnerRecruitJobStateInput = {
  generationId: string;
  status: PartnerRecruitJobStatus;
  startedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
  previewExpireAt: string | null;
  requestedBaseModel: string | null;
  preview: PartnerRecruitPreviewDto | null;
};

export type PartnerRecruitJobView = {
  generationId: string;
  status: PartnerRecruitJobStatus;
  startedAt: string;
  finishedAt: string | null;
  previewExpireAt: string | null;
  requestedBaseModel: string | null;
  preview: PartnerRecruitPreviewDto | null;
  errorMessage: string | null;
};

export type PartnerRecruitJobStateOutput = {
  currentJob: PartnerRecruitJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_draft' | 'failed' | null;
};

const isFailureStatus = (status: PartnerRecruitJobStatus): boolean => {
  return status === 'failed' || status === 'refunded';
};

export const buildPartnerRecruitJobState = (
  input: PartnerRecruitJobStateInput | null,
): PartnerRecruitJobStateOutput => {
  if (!input) {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  if (input.status === 'accepted' || input.status === 'discarded') {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  const currentJob: PartnerRecruitJobView = {
    generationId: input.generationId,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    previewExpireAt: input.previewExpireAt,
    requestedBaseModel: input.requestedBaseModel,
    preview: input.preview,
    errorMessage: input.errorMessage,
  };

  if (input.status === 'generated_draft') {
    return {
      currentJob,
      hasUnreadResult: !input.viewedAt,
      resultStatus: 'generated_draft',
    };
  }

  if (isFailureStatus(input.status)) {
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
