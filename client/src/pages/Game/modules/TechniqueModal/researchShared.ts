/**
 * 洞府研修前端共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义研修红点、结果态与面板主视图的映射，避免主界面与功法弹窗各写一套判断。
 * 2. 做什么：把服务端 `currentJob/hasUnreadResult/resultStatus` 收敛成稳定的前端展示语义。
 * 3. 不做什么：不处理 React 状态、不发起请求、不直接渲染 DOM。
 *
 * 输入/输出：
 * - 输入：研修状态接口返回的 `TechniqueResearchStatusData`。
 * - 输出：红点指示器、研修面板主视图、结果提示文案。
 *
 * 数据流/状态流：
 * API / WebSocket -> researchShared -> Game 主界面红点 + ResearchPanel 结果卡。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 只表示生成中，不能亮红点；否则玩家会把“处理中”误解为“已完成待查看”。
 * 2. `failed` 与 `refunded` 对前端都归为失败结果态，保证退款类失败也有统一提示。
 */
import type {
  TechniqueResearchJobDto,
  TechniqueResearchResultStatusDto,
  TechniqueResearchStatusResponse,
} from '../../../../services/api';

export type TechniqueResearchStatusData = NonNullable<TechniqueResearchStatusResponse['data']>;

export type TechniqueResearchIndicatorView = {
  badgeDot: boolean;
  tooltip?: string;
};

export type TechniqueResearchPanelView =
  | { kind: 'empty' }
  | { kind: 'pending'; job: TechniqueResearchJobDto }
  | { kind: 'draft'; job: TechniqueResearchJobDto; preview: NonNullable<TechniqueResearchJobDto['preview']> }
  | { kind: 'failed'; job: TechniqueResearchJobDto; errorMessage: string };

export const buildTechniqueResearchIndicator = (
  status: TechniqueResearchStatusData | null,
): TechniqueResearchIndicatorView => {
  if (!status?.hasUnreadResult) return { badgeDot: false };
  return { badgeDot: true, tooltip: getTechniqueResearchIndicatorTooltip(status.resultStatus) };
};

export const getTechniqueResearchIndicatorTooltip = (
  resultStatus: TechniqueResearchResultStatusDto | null | undefined,
): string | undefined => {
  if (resultStatus === 'generated_draft') return '有新的研修草稿待查看';
  if (resultStatus == null) return undefined;
  return '本次洞府研修已结束，请查看结果';
};

export const resolveTechniqueResearchPanelView = (
  status: TechniqueResearchStatusData | null,
): TechniqueResearchPanelView => {
  const job = status?.currentJob ?? null;
  if (!job) return { kind: 'empty' };
  if (job.status === 'pending') return { kind: 'pending', job };
  if (job.status === 'generated_draft' && job.preview) {
    return { kind: 'draft', job, preview: job.preview };
  }
  if (job.status === 'failed' || job.status === 'refunded') {
    return {
      kind: 'failed',
      job,
      errorMessage: job.errorMessage || '洞府推演未能成法，本次研修点已自动退还。',
    };
  }
  return { kind: 'empty' };
};
