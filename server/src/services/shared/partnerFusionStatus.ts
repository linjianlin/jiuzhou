/**
 * 三魂归契状态 DTO 构建模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把三魂归契任务状态、红点与当前任务统一收敛为前端直接可消费的状态 DTO。
 * 2) 做什么：让 HTTP 状态接口与 Socket 推送复用同一份结构，避免字段口径漂移。
 * 3) 不做什么：不读数据库、不决定任务是否合法，也不拼装伙伴总览。
 *
 * 输入/输出：
 * - 输入：功能码、任务状态输出。
 * - 输出：`PartnerFusionStatusDto`。
 *
 * 数据流/状态流：
 * partnerFusionService.getFusionStatus -> 本模块构建 DTO -> route 响应 / Socket 推送 -> PartnerModal。
 *
 * 关键边界条件与坑点：
 * 1) `resultStatus` 与 `hasUnreadResult` 必须来自同一任务态映射，不能在不同层各自猜。
 * 2) 当前任务 DTO 直接透传素材伙伴 ID，前端禁用态说明可复用这一份源数据，不必再额外拼字段。
 */
import type {
  PartnerFusionJobStateOutput,
  PartnerFusionJobView,
} from './partnerFusionJobShared.js';

export type PartnerFusionStatusDto = {
  featureCode: string;
  unlocked: true;
  currentJob: PartnerFusionJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_preview' | 'failed' | null;
};

export const buildPartnerFusionStatusDto = (params: {
  featureCode: string;
  state: PartnerFusionJobStateOutput;
}): PartnerFusionStatusDto => {
  return {
    featureCode: params.featureCode,
    unlocked: true,
    currentJob: params.state.currentJob,
    hasUnreadResult: params.state.hasUnreadResult,
    resultStatus: params.state.resultStatus,
  };
};
