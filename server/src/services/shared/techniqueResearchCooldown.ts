/**
 * 洞府研修冷却配置与计算
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义洞府研修冷却时长，并提供状态接口与创建任务前共用的冷却计算函数。
 * 2. 做什么：集中收敛“默认始终保留正式冷却”的规则，避免状态接口与创建任务校验各写一套环境判断。
 * 3. 不做什么：不读取数据库、不处理 HTTP 响应、不决定前端展示布局。
 *
 * 输入/输出：
 * - 输入：最近一次研修开始时间 ISO 字符串、当前时间。
 * - 输出：冷却时长配置、冷却结束时间、剩余秒数、是否仍在冷却中。
 *
 * 数据流/状态流：
 * 最近一次研修时间 -> buildTechniqueResearchCooldownState -> 状态接口 / 创建任务校验 / 前端展示。
 *
 * 关键边界条件与坑点：
 * 1. 仅当最近一次研修时间可解析时才计算冷却，避免脏数据把玩家永久锁死。
 * 2. 研修失败不应进入冷却，因此状态接口与创建任务校验必须共享同一个“哪些状态计入冷却”的判断。
 * 3. 显式跳过冷却时必须仍走同一返回结构，保证测试覆盖与业务主链口径一致。
 * 4. 剩余秒数必须向上取整，保证服务端拦截与前端倒计时在临界秒上口径一致。
 */

import {
  applyCooldownReductionSeconds,
  convertCooldownSecondsToHours,
} from './monthCardBenefits.js';

export const TECHNIQUE_RESEARCH_COOLDOWN_HOURS = 72;
export const TECHNIQUE_RESEARCH_COOLDOWN_APPLY_JOB_STATUSES = [
  'pending',
  'generated_draft',
  'published',
  'refunded',
] as const;

const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

export type TechniqueResearchCooldownState = {
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  isCoolingDown: boolean;
};

export const shouldTechniqueResearchApplyCooldown = (
  latestJobStatus: string | null | undefined,
): boolean => {
  return TECHNIQUE_RESEARCH_COOLDOWN_APPLY_JOB_STATUSES.includes(
    latestJobStatus as (typeof TECHNIQUE_RESEARCH_COOLDOWN_APPLY_JOB_STATUSES)[number],
  );
};

type TechniqueResearchCooldownOptions = {
  bypassCooldown?: boolean;
  cooldownReductionRate?: number;
};

/**
 * 复用点：
 * - 当前由 `buildTechniqueResearchCooldownState` 默认消费，统一让状态接口与创建任务校验都遵守同一环境口径。
 * - 若纯函数测试或未来批处理需要显式跳过冷却，可通过参数覆盖，避免业务主链再分叉出环境特判。
 *
 * 设计原因：
 * - 本地开发环境需要支持连续联调，因此直接在共享规则内关闭冷却，避免状态接口与创建校验口径分裂。
 * - 测试与生产仍保留正式冷却，保证测试断言与线上规则一致。
 * - 将默认行为收敛在这里后，业务层只关注冷却状态，不再重复判断运行环境。
 */
export const shouldBypassTechniqueResearchCooldown = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean => {
  return nodeEnv === 'development';
};

const buildTechniqueResearchIdleCooldownState = (
  cooldownHours: number,
): TechniqueResearchCooldownState => {
  return {
    cooldownHours,
    cooldownUntil: null,
    cooldownRemainingSeconds: 0,
    isCoolingDown: false,
  };
};

export const buildTechniqueResearchCooldownState = (
  latestStartedAt: string | null,
  now: Date = new Date(),
  options: TechniqueResearchCooldownOptions = {},
): TechniqueResearchCooldownState => {
  const bypassCooldown = options.bypassCooldown ?? shouldBypassTechniqueResearchCooldown();
  const baseCooldownSeconds = bypassCooldown ? 0 : TECHNIQUE_RESEARCH_COOLDOWN_HOURS * HOUR_SECONDS;
  const actualCooldownSeconds = bypassCooldown
    ? 0
    : applyCooldownReductionSeconds(baseCooldownSeconds, options.cooldownReductionRate ?? 0);
  const cooldownHours = convertCooldownSecondsToHours(actualCooldownSeconds);
  if (bypassCooldown) {
    return buildTechniqueResearchIdleCooldownState(cooldownHours);
  }

  const startedAtMs = latestStartedAt ? new Date(latestStartedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedAtMs)) {
    return buildTechniqueResearchIdleCooldownState(cooldownHours);
  }

  const cooldownUntilMs = startedAtMs + actualCooldownSeconds * SECOND_MS;
  const remainingSeconds = Math.max(0, Math.ceil((cooldownUntilMs - now.getTime()) / SECOND_MS));

  return {
    cooldownHours,
    cooldownUntil: new Date(cooldownUntilMs).toISOString(),
    cooldownRemainingSeconds: remainingSeconds,
    isCoolingDown: remainingSeconds > 0,
  };
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
