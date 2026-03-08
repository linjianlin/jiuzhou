/**
 * 洞府研修前端共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义研修红点、结果态与面板主视图的映射，避免主界面与功法弹窗各写一套判断。
 * 2. 做什么：把服务端 `currentJob/hasUnreadResult/resultStatus/cooldown*` 收敛成稳定的前端展示语义与按钮可用态。
 * 3. 不做什么：不处理 React 状态、不发起请求、不直接渲染 DOM。
 *
 * 输入/输出：
 * - 输入：研修状态接口返回的 `TechniqueResearchStatusData`。
 * - 输出：红点指示器、研修面板主视图、结果提示文案、操作按钮状态。
 *
 * 数据流/状态流：
 * API / WebSocket -> researchShared -> Game 主界面红点 + ResearchPanel 结果卡。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 只表示生成中，不能亮红点；否则玩家会把“处理中”误解为“已完成待查看”。
 * 2. 功法残页余额判断与冷却按钮禁用必须共用同一组纯函数，避免组件内各自计算导致显示与交互不一致。
 */
import type {
  TechniqueResearchJobDto,
  TechniqueResearchResultStatusDto,
  TechniqueResearchStatusResponse,
} from '../../../../services/api';

export type TechniqueResearchStatusData = NonNullable<TechniqueResearchStatusResponse['data']>;
export const TECHNIQUE_RESEARCH_STATUS_POLL_INTERVAL_MS = 20_000;

export type TechniqueResearchIndicatorView = {
  badgeDot: boolean;
  tooltip?: string;
};

export type TechniqueResearchPanelView =
  | { kind: 'empty' }
  | { kind: 'pending'; job: TechniqueResearchJobDto }
  | { kind: 'draft'; job: TechniqueResearchJobDto; preview: NonNullable<TechniqueResearchJobDto['preview']> }
  | { kind: 'failed'; job: TechniqueResearchJobDto; errorMessage: string };

export type TechniqueResearchActionState = {
  canGenerate: boolean;
  pendingGenerationId: string | null;
};

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export const buildTechniqueResearchIndicator = (
  status: TechniqueResearchStatusData | null,
): TechniqueResearchIndicatorView => {
  if (!status?.hasUnreadResult) return { badgeDot: false };
  return { badgeDot: true, tooltip: getTechniqueResearchIndicatorTooltip(status.resultStatus) };
};

export const resolveTechniqueResearchIndicatorStatus = (
  status: TechniqueResearchStatusData | null,
): TechniqueResearchResultStatusDto | null => {
  return status?.hasUnreadResult ? status.resultStatus : null;
};

export const shouldPollTechniqueResearchStatus = (
  status: TechniqueResearchStatusData | null,
): boolean => {
  return status?.currentJob?.status === 'pending';
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
      errorMessage: job.errorMessage || '洞府推演未能成法，本次消耗的功法残页已自动退还。',
    };
  }
  return { kind: 'empty' };
};

export const isTechniqueResearchCoolingDown = (
  status: TechniqueResearchStatusData | null,
): boolean => {
  return (status?.cooldownRemainingSeconds ?? 0) > 0;
};

export const formatTechniqueResearchCooldownRemaining = (
  cooldownRemainingSeconds: number,
): string => {
  const safeSeconds = Math.max(0, Math.floor(cooldownRemainingSeconds));
  if (safeSeconds >= DAY_SECONDS) {
    const days = Math.floor(safeSeconds / DAY_SECONDS);
    const hours = Math.floor((safeSeconds % DAY_SECONDS) / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${days}天${hours}小时${minutes}分`;
    if (hours > 0) return `${days}天${hours}小时`;
    return `${days}天`;
  }

  if (safeSeconds >= HOUR_SECONDS) {
    const hours = Math.floor(safeSeconds / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${hours}小时${minutes}分`;
    return `${hours}小时`;
  }

  if (safeSeconds >= MINUTE_SECONDS) {
    const minutes = Math.floor(safeSeconds / MINUTE_SECONDS);
    const seconds = safeSeconds % MINUTE_SECONDS;
    if (seconds > 0) return `${minutes}分${seconds}秒`;
    return `${minutes}分`;
  }

  return `${safeSeconds}秒`;
};

export const resolveTechniqueResearchActionState = (
  status: TechniqueResearchStatusData | null,
): TechniqueResearchActionState => {
  const panelView = resolveTechniqueResearchPanelView(status);
  const canGenerate =
    status !== null &&
    panelView.kind !== 'pending' &&
    !isTechniqueResearchCoolingDown(status) &&
    status.fragmentBalance >= status.fragmentCost;

  return {
    canGenerate,
    pendingGenerationId: panelView.kind === 'pending' ? panelView.job.generationId : null,
  };
};
