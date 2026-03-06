/**
 * 研修任务共享状态映射
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把任务表原始字段收敛为前端可直接消费的当前任务、未查看红点与结果态。
 * 2. 做什么：统一成功草稿、失败退款与生成中的状态语义，避免 service、推送与前端各写一套判断。
 * 3. 不做什么：不负责数据库查询、不负责 worker 调度、不直接处理 UI 组件渲染。
 *
 * 输入/输出：
 * - 输入：`TechniqueResearchJobStateInput`，来自任务表和草稿/技能预览的组合数据。
 * - 输出：`buildTechniqueResearchJobState` 返回 `currentJob`、`hasUnreadResult`、`resultStatus`。
 *
 * 数据流/状态流：
 * DB 行 -> buildTechniqueResearchJobState -> 研修状态接口 / WebSocket 推送 / 前端红点与详情展示。
 *
 * 关键边界条件与坑点：
 * 1. `refunded` 对前端而言仍属于“失败结果”，否则玩家看不到过期退款或调度失败结果。
 * 2. `pending` 只能表示生成中，不能亮红点，否则会把“处理中”误导成“有新结果待查看”。
 */

export type TechniqueResearchJobStatus =
  | 'pending'
  | 'generated_draft'
  | 'published'
  | 'failed'
  | 'refunded';

export type TechniqueQuality = '黄' | '玄' | '地' | '天';

export type TechniqueResearchPreviewSkill = {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  costLingqi: number;
  costQixue: number;
  cooldown: number;
  targetType: string;
  targetCount: number;
  damageType: string | null;
  element: string;
  effects: unknown[];
};

export type TechniqueResearchPreview = {
  draftTechniqueId: string;
  aiSuggestedName: string;
  quality: TechniqueQuality;
  type: string;
  maxLayer: number;
  description: string;
  longDesc: string;
  skillNames: string[];
  skills: TechniqueResearchPreviewSkill[];
};

export type TechniqueResearchJobStateInput = {
  generationId: string;
  status: TechniqueResearchJobStatus;
  quality: TechniqueQuality;
  draftTechniqueId: string | null;
  draftExpireAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  failedViewedAt: string | null;
  errorMessage: string | null;
  preview: TechniqueResearchPreview | null;
};

export type TechniqueResearchJobView = {
  generationId: string;
  status: TechniqueResearchJobStatus;
  quality: TechniqueQuality;
  draftTechniqueId: string | null;
  draftExpireAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  preview: TechniqueResearchPreview | null;
  errorMessage: string | null;
};

export type TechniqueResearchJobStateOutput = {
  currentJob: TechniqueResearchJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_draft' | 'failed' | null;
};

const isFailureStatus = (status: TechniqueResearchJobStatus): boolean => {
  return status === 'failed' || status === 'refunded';
};

export const buildTechniqueResearchJobState = (
  input: TechniqueResearchJobStateInput | null,
): TechniqueResearchJobStateOutput => {
  if (!input) {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  const currentJob: TechniqueResearchJobView = {
    generationId: input.generationId,
    status: input.status,
    quality: input.quality,
    draftTechniqueId: input.draftTechniqueId,
    draftExpireAt: input.draftExpireAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
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
      hasUnreadResult: !input.failedViewedAt,
      resultStatus: 'failed',
    };
  }

  return {
    currentJob,
    hasUnreadResult: false,
    resultStatus: null,
  };
};
