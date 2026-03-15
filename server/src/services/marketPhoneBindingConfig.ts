import dotenv from 'dotenv';

dotenv.config();

/**
 * 坊市手机号绑定配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解析坊市手机号绑定开关、短信模板参数与验证码时效配置，供绑定服务和坊市守卫共用。
 * 2. 做什么：在显式开启时强校验关键配置，避免服务处于“路由开始拦截但短信无法发送”的半启用状态。
 * 3. 不做什么：不直接发送短信、不直接访问 Redis，也不执行业务校验。
 *
 * 输入/输出：
 * - 输入：`process.env` 中的坊市手机号绑定相关环境变量。
 * - 输出：`MarketPhoneBindingConfig`，供后端运行期直接消费。
 *
 * 数据流/状态流：
 * 环境变量 -> 本模块归一化 -> 绑定服务 / 坊市中间件 / 状态接口复用。
 *
 * 关键边界条件与坑点：
 * 1. 默认必须关闭，只有显式配置 `MARKET_PHONE_BINDING_ENABLED=true` 才开启，避免开发环境被意外锁住坊市入口。
 * 2. 只要显式开启，就必须同时提供短信签名和模板编码；不能偷偷回退成“不发短信但放行业务”。
 */

export type MarketPhoneBindingConfig = {
  enabled: boolean;
  signName: string;
  templateCode: string;
  codeExpireSeconds: number;
  sendCooldownSeconds: number;
  sendHourlyLimit: number;
  sendDailyLimit: number;
};

const DEFAULT_CODE_EXPIRE_SECONDS = 300;
const DEFAULT_SEND_COOLDOWN_SECONDS = 60;
const DEFAULT_SEND_HOURLY_LIMIT = 5;
const DEFAULT_SEND_DAILY_LIMIT = 10;

const asString = (raw: string | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

const asBoolean = (raw: string | undefined): boolean => {
  const normalized = asString(raw).toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const asPositiveInt = (raw: string | undefined, defaultValue: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : defaultValue;
};

export const readMarketPhoneBindingConfig = (): MarketPhoneBindingConfig => {
  const enabled = asBoolean(process.env.MARKET_PHONE_BINDING_ENABLED);
  const signName = asString(process.env.ALIYUN_SMS_SIGN_NAME);
  const templateCode = asString(process.env.ALIYUN_SMS_VERIFY_TEMPLATE_CODE);
  const codeExpireSeconds = asPositiveInt(
    process.env.MARKET_PHONE_BINDING_CODE_EXPIRE_SECONDS,
    DEFAULT_CODE_EXPIRE_SECONDS,
  );
  const sendCooldownSeconds = asPositiveInt(
    process.env.MARKET_PHONE_BINDING_SEND_COOLDOWN_SECONDS,
    DEFAULT_SEND_COOLDOWN_SECONDS,
  );
  const sendHourlyLimit = asPositiveInt(
    process.env.MARKET_PHONE_BINDING_SEND_HOURLY_LIMIT,
    DEFAULT_SEND_HOURLY_LIMIT,
  );
  const sendDailyLimit = asPositiveInt(
    process.env.MARKET_PHONE_BINDING_SEND_DAILY_LIMIT,
    DEFAULT_SEND_DAILY_LIMIT,
  );

  if (!enabled) {
    return {
      enabled: false,
      signName,
      templateCode,
      codeExpireSeconds,
      sendCooldownSeconds,
      sendHourlyLimit,
      sendDailyLimit,
    };
  }

  if (!signName) {
    throw new Error('MARKET_PHONE_BINDING_ENABLED=true 时必须配置 ALIYUN_SMS_SIGN_NAME');
  }

  if (!templateCode) {
    throw new Error('MARKET_PHONE_BINDING_ENABLED=true 时必须配置 ALIYUN_SMS_VERIFY_TEMPLATE_CODE');
  }

  return {
    enabled: true,
    signName,
    templateCode,
    codeExpireSeconds,
    sendCooldownSeconds,
    sendHourlyLimit,
    sendDailyLimit,
  };
};

export const MARKET_PHONE_BINDING_CONFIG = readMarketPhoneBindingConfig();
