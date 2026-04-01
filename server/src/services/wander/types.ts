/**
 * 云游奇遇共享类型
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中声明云游奇遇服务、AI 输出和接口 DTO 需要的类型，避免 route、service、AI 模块各自复制字段定义。
 * 2. 做什么：把“冷却推进、三选一、结局称号”的结构约束固化到类型层，减少后续扩展时的漂移。
 * 3. 不做什么：不处理数据库查询，不做 AI 调用，也不拼接展示文案。
 *
 * 输入/输出：
 * - 输入：由服务层和 AI 模块共享消费。
 * - 输出：统一的 TypeScript 类型定义。
 *
 * 数据流/状态流：
 * route/service/AI 模块 -> 统一引用本文件类型 -> 保持奇遇 DTO 与内部状态结构一致。
 *
 * 关键边界条件与坑点：
 * 1. `endingType` 固定枚举，结局奖励与色彩都依赖它；新增结局类型时必须同步修改服务层映射。
 * 2. 选项数量当前固定为 3，前端按钮布局和 AI 校验都基于这个假设，不能单边放宽。
 */

export type WanderStoryStatus = 'active' | 'finished';
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
  status: WanderStoryStatus;
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

export interface WanderAiEpisodeDraft {
  storyTheme: string;
  storyPremise: string;
  episodeTitle: string;
  opening: string;
  summary: string;
  optionTexts: [string, string, string];
  isEnding: boolean;
  endingType: WanderEndingType;
  rewardTitleName: string;
  rewardTitleDesc: string;
}
