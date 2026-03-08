/**
 * 洞府研修冷却配置与计算
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义洞府研修冷却时长，并提供状态接口与创建任务前共用的冷却计算函数。
 * 2. 做什么：统一剩余时间的中文文案格式，避免 service 在多处拼接不同口径的提示文本。
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
 * 2. 剩余秒数必须向上取整，保证服务端拦截与前端倒计时在临界秒上口径一致。
 */

export const TECHNIQUE_RESEARCH_COOLDOWN_HOURS = 0;

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

export const buildTechniqueResearchCooldownState = (
  latestStartedAt: string | null,
  now: Date = new Date(),
): TechniqueResearchCooldownState => {
  const startedAtMs = latestStartedAt ? new Date(latestStartedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedAtMs)) {
    return {
      cooldownHours: TECHNIQUE_RESEARCH_COOLDOWN_HOURS,
      cooldownUntil: null,
      cooldownRemainingSeconds: 0,
      isCoolingDown: false,
    };
  }

  const cooldownUntilMs = startedAtMs + TECHNIQUE_RESEARCH_COOLDOWN_HOURS * HOUR_SECONDS * SECOND_MS;
  const remainingSeconds = Math.max(0, Math.ceil((cooldownUntilMs - now.getTime()) / SECOND_MS));

  return {
    cooldownHours: TECHNIQUE_RESEARCH_COOLDOWN_HOURS,
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
