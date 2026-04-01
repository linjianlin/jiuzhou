import api from './core';
import type { AxiosRequestConfig } from 'axios';

/**
 * 云游奇遇接口模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装云游奇遇概览、生成与选项确认请求，供奇遇入口弹窗复用。
 * 2. 做什么：复用后端正式 DTO 结构，让弹窗与后续可能的首页提示共享同一份类型。
 * 3. 不做什么：不处理本地状态机，不拼接按钮文案，也不替代正式称号列表接口。
 *
 * 输入/输出：
 * - 输入：无参概览、无参生成，或 `episodeId + optionIndex` 的确认参数。
 * - 输出：统一业务响应。
 *
 * 数据流/状态流：
 * WanderModal -> 本模块 -> `/api/wander/*` -> 服务端返回概览或剧情结果。
 *
 * 关键边界条件与坑点：
 * 1. 选项索引使用后端固定的 0-based 编号，前端不要自行做别名映射。
 * 2. 动态云游称号虽然进入正式称号体系，但这里只展示云游来源的标题，不替代成就称号页。
 */

export type WanderEndingType = 'none' | 'good' | 'neutral' | 'tragic' | 'bizarre';
export type WanderGenerationJobStatus = 'pending' | 'generated' | 'failed';

export interface WanderGenerationJobDto {
  generationId: string;
  status: WanderGenerationJobStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface WanderEpisodeOptionDto {
  index: number;
  text: string;
}

export interface WanderEpisodeDto {
  id: string;
  dayKey: string;
  dayIndex: number;
  title: string;
  opening: string;
  options: WanderEpisodeOptionDto[];
  chosenOptionIndex: number | null;
  chosenOptionText: string | null;
  summary: string;
  isEnding: boolean;
  endingType: WanderEndingType;
  rewardTitleName: string | null;
  rewardTitleDesc: string | null;
  createdAt: string;
  chosenAt: string | null;
}

export interface WanderStoryDto {
  id: string;
  status: 'active' | 'finished';
  theme: string;
  premise: string;
  summary: string;
  episodeCount: number;
  rewardTitleId: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  episodes: WanderEpisodeDto[];
}

export interface WanderGeneratedTitleDto {
  id: string;
  name: string;
  description: string;
  color: string | null;
  effects: Record<string, number>;
  isEquipped: boolean;
  obtainedAt: string;
}

export interface WanderOverviewDto {
  today: string;
  aiAvailable: boolean;
  hasPendingEpisode: boolean;
  canGenerate: boolean;
  isCoolingDown: boolean;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  currentGenerationJob: WanderGenerationJobDto | null;
  activeStory: WanderStoryDto | null;
  currentEpisode: WanderEpisodeDto | null;
  latestFinishedStory: WanderStoryDto | null;
  generatedTitles: WanderGeneratedTitleDto[];
}

export interface WanderChooseResultDto {
  story: WanderStoryDto;
  awardedTitle: WanderGeneratedTitleDto | null;
}

export interface WanderGenerateQueueResultDto {
  job: WanderGenerationJobDto;
}

export interface WanderOverviewResponse {
  success: boolean;
  message: string;
  data?: WanderOverviewDto;
}

export interface WanderGenerateResponse {
  success: boolean;
  message: string;
  data?: WanderGenerateQueueResultDto;
}

export interface WanderChooseResponse {
  success: boolean;
  message: string;
  data?: WanderChooseResultDto;
}

export const getWanderOverview = (config?: AxiosRequestConfig): Promise<WanderOverviewResponse> => {
  return api.get('/wander/overview', config);
};

export const generateWanderEpisode = (config?: AxiosRequestConfig): Promise<WanderGenerateResponse> => {
  return api.post('/wander/generate', undefined, config);
};

export const chooseWanderEpisodeOption = (params: {
  episodeId: string;
  optionIndex: number;
}): Promise<WanderChooseResponse> => {
  return api.post('/wander/choose', params);
};
