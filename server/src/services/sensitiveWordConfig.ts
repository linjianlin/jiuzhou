/**
 * 敏感词检测服务配置模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中读取敏感词检测服务的启停、`baseUrl`、超时配置，并把固定接口路径归一化成可直接请求的 endpoint。
 * 2) 做什么：为聊天、角色道号、功法命名等所有文本检测场景提供单一配置入口，避免每个业务模块各自拼接 `/wordscheck`。
 * 3) 不做什么：不发起网络请求、不解析响应体，也不决定命中后的业务提示文案。
 *
 * 输入/输出：
 * - 输入：`process.env` 中的敏感词服务环境变量。
 * - 输出：`SensitiveWordServiceConfig`，供共享检测模块直接消费。
 *
 * 数据流/状态流：
 * 环境变量 -> 本模块归一化 -> 共享检测服务 -> 角色创建 / 聊天 / 功法命名复用。
 *
 * 关键边界条件与坑点：
 * 1) `baseUrl` 只配置服务基础地址，请求路径固定为 `/wordscheck`；路径拼接必须集中，避免各处多写或漏写斜杠。
 * 2) 当显式开启服务却未配置 `baseUrl` 时必须立即报错，不能静默回退，否则线上会出现“看似开启、实际未生效”的隐性故障。
 */

export type SensitiveWordServiceConfig = {
  enabled: boolean;
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 3_000;
const WORDS_CHECK_PATH = '/wordscheck';

const asString = (raw: string | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

const asBoolean = (raw: string | undefined): boolean => {
  const normalized = asString(raw).toLowerCase();
  return normalized === '1' || normalized === 'true';
};

const asPositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
};

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export const normalizeSensitiveWordServiceBaseUrl = (raw: string): string => {
  return trimTrailingSlash(raw.trim());
};

export const resolveSensitiveWordServiceEndpoint = (baseUrl: string): string => {
  const normalizedBaseUrl = normalizeSensitiveWordServiceBaseUrl(baseUrl);
  if (!normalizedBaseUrl) return '';

  const parsed = new URL(normalizedBaseUrl);
  return `${parsed.origin}${WORDS_CHECK_PATH}`;
};

export const readSensitiveWordServiceConfig = (): SensitiveWordServiceConfig => {
  const enabled = asBoolean(process.env.SENSITIVE_WORD_SERVICE_ENABLED);
  const baseUrl = normalizeSensitiveWordServiceBaseUrl(process.env.SENSITIVE_WORD_SERVICE_BASE_URL ?? '');
  if (!enabled) {
    return {
      enabled: false,
      baseUrl,
      endpoint: '',
      timeoutMs: asPositiveInt(process.env.SENSITIVE_WORD_SERVICE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    };
  }

  if (!baseUrl) {
    throw new Error('SENSITIVE_WORD_SERVICE_ENABLED=true 时必须配置 SENSITIVE_WORD_SERVICE_BASE_URL');
  }

  return {
    enabled: true,
    baseUrl,
    endpoint: resolveSensitiveWordServiceEndpoint(baseUrl),
    timeoutMs: asPositiveInt(process.env.SENSITIVE_WORD_SERVICE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
};
