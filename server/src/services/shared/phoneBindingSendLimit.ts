import { redis } from '../../config/redis.js';
import { BusinessError } from '../../middleware/BusinessError.js';

/**
 * 手机号绑定短信发送限次共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理手机号绑定验证码发送的自然小时/自然日限次校验与发送成功后的 Redis 计数写入，避免业务服务重复维护两套窗口键和错误文案。
 * 2. 做什么：把 Asia/Shanghai 的时间窗口口径收敛到单一模块，保证“每小时 5 次 / 每天 10 次”在所有调用点都按同一时区计算。
 * 3. 不做什么：不负责手机号格式校验、不调用短信供应商，也不处理发送冷却倒计时。
 *
 * 输入/输出：
 * - 输入：用户 ID、发送限次配置，以及可选的当前时间。
 * - 输出：发送前校验通过则无返回；超限时抛出 `BusinessError`；发送成功记录函数无返回。
 *
 * 数据流/状态流：
 * - `marketPhoneBindingService` 在发送前调用本模块做小时/天限次校验；
 * - 短信发送成功后再次调用本模块记录当前小时与当天窗口的发送次数。
 *
 * 关键边界条件与坑点：
 * 1. 小时和天窗口必须共用同一时区口径；如果一个按服务器本地时间、一个按 UTC，会导致整点和跨天重置时机不一致。
 * 2. 本模块只统计“发送成功”的次数；如果在短信发送前先计数，供应商失败也会白白占用额度，和用户感知不一致。
 */

export type PhoneBindingSendLimitConfig = {
  hourlyLimit: number;
  dailyLimit: number;
};

type PhoneBindingSendLimitWindow = {
  keySegment: 'hour' | 'day';
  limit: number;
  expireSeconds: number;
};

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const TWO_HOURS_SECONDS = 2 * 60 * 60;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

const windowTokenFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

const PHONE_BINDING_SEND_LIMIT_WINDOWS = (
  config: PhoneBindingSendLimitConfig,
): PhoneBindingSendLimitWindow[] => [
  {
    keySegment: 'hour',
    limit: config.hourlyLimit,
    expireSeconds: TWO_HOURS_SECONDS,
  },
  {
    keySegment: 'day',
    limit: config.dailyLimit,
    expireSeconds: TWO_DAYS_SECONDS,
  },
];

const extractWindowParts = (now: Date): { year: string; month: string; day: string; hour: string } => {
  const formattedParts = windowTokenFormatter.formatToParts(now);
  const year = formattedParts.find((part) => part.type === 'year')?.value;
  const month = formattedParts.find((part) => part.type === 'month')?.value;
  const day = formattedParts.find((part) => part.type === 'day')?.value;
  const hour = formattedParts.find((part) => part.type === 'hour')?.value;

  if (!year || !month || !day || !hour) {
    throw new Error('无法生成手机号绑定短信发送限次时间窗口');
  }

  return { year, month, day, hour };
};

const buildWindowToken = (window: PhoneBindingSendLimitWindow, now: Date): string => {
  const parts = extractWindowParts(now);
  if (window.keySegment === 'hour') {
    return `${parts.year}${parts.month}${parts.day}${parts.hour}`;
  }
  return `${parts.year}${parts.month}${parts.day}`;
};

const buildWindowKey = (
  userId: number,
  window: PhoneBindingSendLimitWindow,
  now: Date,
): string => {
  return `market:phone-binding:send-limit:${window.keySegment}:${userId}:${buildWindowToken(window, now)}`;
};

const parseStoredCount = (rawCount: string | null): number => {
  if (rawCount === null) {
    return 0;
  }

  const normalized = Number(rawCount);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`手机号绑定短信发送限次计数无效: ${rawCount}`);
  }

  return Math.floor(normalized);
};

const buildExceededMessage = (window: PhoneBindingSendLimitWindow): string => {
  if (window.keySegment === 'hour') {
    return `验证码每小时最多发送${window.limit}次，请下个整点后再试`;
  }
  return `验证码当天最多发送${window.limit}次，请明天再试`;
};

export const assertPhoneBindingSendLimitAvailable = async (
  userId: number,
  config: PhoneBindingSendLimitConfig,
  now: Date = new Date(),
): Promise<void> => {
  for (const window of PHONE_BINDING_SEND_LIMIT_WINDOWS(config)) {
    const rawCount = await redis.get(buildWindowKey(userId, window, now));
    const currentCount = parseStoredCount(rawCount);

    if (currentCount >= window.limit) {
      throw new BusinessError(buildExceededMessage(window));
    }
  }
};

export const recordPhoneBindingSendSuccess = async (
  userId: number,
  config: PhoneBindingSendLimitConfig,
  now: Date = new Date(),
): Promise<void> => {
  for (const window of PHONE_BINDING_SEND_LIMIT_WINDOWS(config)) {
    const redisKey = buildWindowKey(userId, window, now);
    const nextCount = await redis.incr(redisKey);

    if (nextCount === 1) {
      await redis.expire(redisKey, window.expireSeconds);
    }
  }
};
