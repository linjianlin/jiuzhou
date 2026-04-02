import type { WanderOverviewDto } from '../../../../services/api';

/**
 * 云游入口共享状态
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义云游入口红点与主界面刷新时机，避免 `Game` 页和弹窗各自散落判断。
 * 2. 做什么：把服务端 `hasPendingEpisode`、`canGenerate`、`isCoolingDown`、`currentGenerationJob` 收敛成稳定的前端入口语义。
 * 3. 不做什么：不发起请求、不维护 React 状态，也不渲染任何 DOM。
 *
 * 输入/输出：
 * - 输入：云游概览接口返回的 `WanderOverviewDto`。
 * - 输出：入口红点视图，以及下一次需要刷新的最短等待时间。
 *
 * 数据流/状态流：
 * API / WanderModal -> 本模块 -> Game 主界面 `FunctionMenu` 红点与定时刷新调度。
 *
 * 复用设计说明：
 * 1. 红点展示与刷新节奏共用同一份状态收敛，避免“主界面已亮红点但仍在继续轮询”这类重复维护。
 * 2. 入口提示文案在这里统一，后续若首页、侧边栏也要展示云游状态，可以直接复用这组纯函数。
 * 3. 冷却结束后的刷新时刻收口到单一出口，避免多个组件分别手写超时计算。
 *
 * 关键边界条件与坑点：
 * 1. `currentGenerationJob.status === 'pending'` 时不能亮红点；此时玩家没有可执行动作，只需要轻量轮询等待结果。
 * 2. 冷却结束不需要常驻轮询；直接按剩余秒数预约下一次刷新，避免 1 小时冷却期间持续请求。
 */

export const WANDER_PENDING_JOB_POLL_INTERVAL_MS = 2_000;
const WANDER_COOLDOWN_READY_BUFFER_MS = 1_000;

export type WanderIndicatorView = {
  badgeDot: boolean;
  tooltip?: string;
};

export const buildWanderIndicator = (
  overview: WanderOverviewDto | null,
): WanderIndicatorView => {
  if (!overview?.aiAvailable) {
    return { badgeDot: false };
  }
  if (overview.hasPendingEpisode) {
    return {
      badgeDot: true,
      tooltip: '有云游抉择待定',
    };
  }
  if (overview.currentGenerationJob?.status === 'failed') {
    return {
      badgeDot: true,
      tooltip: overview.isResolvingEpisode ? '云游尾声推演失败，可继续推演' : '云游推演失败，可立即重新推演',
    };
  }
  if (overview.canGenerate && !overview.isCoolingDown && overview.currentGenerationJob === null) {
    return {
      badgeDot: true,
      tooltip: '云游冷却已结束，可开启新的奇遇',
    };
  }
  return { badgeDot: false };
};

export const resolveWanderIndicatorNextRefreshDelayMs = (
  overview: WanderOverviewDto | null,
): number | null => {
  if (!overview?.aiAvailable) {
    return null;
  }
  if (overview.currentGenerationJob?.status === 'pending') {
    return WANDER_PENDING_JOB_POLL_INTERVAL_MS;
  }
  if (!overview.isCoolingDown) {
    return null;
  }
  return Math.max(
    WANDER_COOLDOWN_READY_BUFFER_MS,
    Math.ceil(overview.cooldownRemainingSeconds * 1000) + WANDER_COOLDOWN_READY_BUFFER_MS,
  );
};
