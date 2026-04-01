/**
 * 云游奇遇共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护云游奇遇的正式冷却口径与虚拟 dayKey 派生规则，避免 service、worker、路由各自散落时间判断。
 * 2. 做什么：统一提供“生产 1 小时冷却 / 本地开发无冷却”的纯函数，让概览读取、创建任务与异步 worker 使用同一份结果。
 * 3. 不做什么：不访问数据库，不执行 AI 生成，也不拼接前端展示结构。
 *
 * 输入/输出：
 * - 输入：运行环境、最近一次云游创建时间、最近一次云游的 `dayKey`、当前时间。
 * - 输出：冷却结束时间、剩余秒数、是否仍在冷却，以及本次应写入的虚拟 dayKey。
 *
 * 数据流/状态流：
 * route/service/worker -> 本模块 -> 获得开发态是否跳过冷却、正式冷却状态与下一次云游 dayKey -> 继续执行业务读写。
 *
 * 复用设计说明：
 * 1. 冷却判断与虚拟日期推进都集中在这里，避免概览、创建任务、worker 重复维护“上一幕是否仍在限制内”。
 * 2. 生产放开入口后，前后端都只需要消费服务层返回的冷却状态，不再各写一份环境开关。
 * 3. dayKey 虚拟推进仍保留在这里，专门吸收“同一天内允许多幕”带来的唯一索引约束，不把数据库细节泄漏到业务层。
 *
 * 关键边界条件与坑点：
 * 1. 冷却时间必须基于真实 `created_at` 计算，不能继续依赖 `dayKey`，否则 1 小时口径会退化回自然日限制。
 * 2. dayKey 仍要写入合法 date，不能直接改成时间戳字符串，否则会破坏既有表结构与查询排序。
 */

export const WANDER_COOLDOWN_HOURS = 1;

const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

export type WanderCooldownState = {
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  isCoolingDown: boolean;
};

export const buildDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseDateKey = (dayKey: string | null): Date | null => {
  if (!dayKey) return null;
  const matched = dayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return null;
  const year = Number(matched[1]);
  const monthIndex = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  const parsed = new Date(year, monthIndex, day);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getFullYear() !== year
    || parsed.getMonth() !== monthIndex
    || parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
};

const addDays = (date: Date, days: number): Date => {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
};

export const shouldBypassWanderCooldown = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean => {
  return nodeEnv === 'development';
};

const buildIdleCooldownState = (cooldownHours: number): WanderCooldownState => {
  return {
    cooldownHours,
    cooldownUntil: null,
    cooldownRemainingSeconds: 0,
    isCoolingDown: false,
  };
};

export const buildWanderCooldownState = (
  latestEpisodeCreatedAt: string | null,
  now: Date = new Date(),
  bypassCooldown: boolean = shouldBypassWanderCooldown(),
): WanderCooldownState => {
  const cooldownHours = bypassCooldown ? 0 : WANDER_COOLDOWN_HOURS;
  if (bypassCooldown) {
    return buildIdleCooldownState(cooldownHours);
  }

  const createdAtMs = latestEpisodeCreatedAt ? new Date(latestEpisodeCreatedAt).getTime() : Number.NaN;
  if (!Number.isFinite(createdAtMs)) {
    return buildIdleCooldownState(cooldownHours);
  }

  const cooldownUntilMs = createdAtMs + cooldownHours * HOUR_SECONDS * SECOND_MS;
  const cooldownRemainingSeconds = Math.max(0, Math.ceil((cooldownUntilMs - now.getTime()) / SECOND_MS));
  return {
    cooldownHours,
    cooldownUntil: new Date(cooldownUntilMs).toISOString(),
    cooldownRemainingSeconds,
    isCoolingDown: cooldownRemainingSeconds > 0,
  };
};

export const formatWanderCooldownRemaining = (cooldownRemainingSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(cooldownRemainingSeconds));
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

export const resolveWanderGenerationDayKey = (
  latestEpisodeDayKey: string | null,
  now: Date = new Date(),
): string => {
  const today = buildDateKey(now);
  const latestEpisodeDate = parseDateKey(latestEpisodeDayKey);
  const todayDate = parseDateKey(today);
  if (!latestEpisodeDate || !todayDate) {
    return today;
  }

  if (latestEpisodeDate.getTime() < todayDate.getTime()) {
    return today;
  }

  return buildDateKey(addDays(latestEpisodeDate, 1));
};
