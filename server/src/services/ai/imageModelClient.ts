/**
 * AI 图片模型 client
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一承接图片模型调用，对 OpenAI provider 使用标准 OpenAI SDK，对 DashScope provider 维持专用协议调用。
 * 2) 做什么：集中输出标准图片资源 `{ b64, url }`，让头像与技能图标链路只处理落盘与压缩，不再关心 provider 差异。
 * 3) 不做什么：不做业务 prompt 生成、不做图片落盘，也不决定业务失败时是抛错还是静默返回。
 *
 * 输入/输出：
 * - 输入：图片 prompt。
 * - 输出：`{ asset, timeoutMs, provider, modelName }`。
 *
 * 数据流/状态流：
 * 业务 prompt -> imageModelClient -> OpenAI SDK / DashScope 协议 -> 标准图片资源 -> 调用方下载/压缩/落盘。
 *
 * 关键边界条件与坑点：
 * 1) OpenAI 与 DashScope 的协议完全不同，但业务层不应该知道这个差异；provider 分流必须集中在这一层。
 * 2) 图片结果可能是 b64，也可能是 URL；统一资源结构后，头像和技能图标才能复用同一套后处理逻辑。
 */
import OpenAI from 'openai';
import {
  normalizeSizeForDashScope,
  readImageModelConfig,
  type ImageProvider,
} from './modelConfig.js';
import {
  buildDashScopeImageGenerationPayload,
  readDashScopeImageGenerationResult,
} from '../shared/dashScopeImageGenerationShared.js';

export type GeneratedImageAsset = {
  b64: string;
  url: string;
};

export type ImageGenerationResult = {
  asset: GeneratedImageAsset;
  timeoutMs: number;
  provider: ImageProvider;
  modelName: string;
};

type OpenAIImageSize =
  | 'auto'
  | '256x256'
  | '512x512'
  | '1024x1024'
  | '1024x1536'
  | '1536x1024'
  | '1024x1792'
  | '1792x1024';

type OpenAIImageResponseFormat = 'b64_json' | 'url';

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const DATA_URL_BASE64_PREFIX_REGEXP = /^data:[^;,]+;base64,/i;

/**
 * 规范化模型返回的 base64 图片内容
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一剥离 OpenAI 兼容接口可能返回的 Data URL 前缀，输出可直接解码的纯 base64。
 * 2) 做什么：让技能图标与伙伴头像共用同一份图片解码规则，避免业务层各自补解析逻辑。
 * 3) 不做什么：不校验图片格式真伪、不负责把 base64 转成 Buffer。
 *
 * 输入/输出：
 * - 输入：模型响应中的 `b64_json` / `b64_image` 字符串。
 * - 输出：可直接传给 `Buffer.from(..., 'base64')` 的纯 base64；空值返回空字符串。
 *
 * 数据流/状态流：
 * provider 原始响应 -> normalizeGeneratedImageBase64 -> 标准图片资源 `{ b64, url }` -> 业务层解码落盘。
 *
 * 关键边界条件与坑点：
 * 1) 第三方 OpenAI 兼容服务可能把 `b64_json` 包成 `data:image/png;base64,...`，如果不在共享层剥离，所有调用方都会静默解码失败。
 * 2) 这里只做单一职责的字符串归一化，不在这里引入图片下载或容错分支，避免职责继续扩散。
 */
export const normalizeGeneratedImageBase64 = (raw: string): string => {
  const value = asString(raw);
  if (!value) return '';
  return value.replace(DATA_URL_BASE64_PREFIX_REGEXP, '').trim();
};

const toOpenAIImageSize = (size: string): OpenAIImageSize => {
  if (
    size === 'auto' ||
    size === '256x256' ||
    size === '512x512' ||
    size === '1024x1024' ||
    size === '1024x1536' ||
    size === '1536x1024' ||
    size === '1024x1792' ||
    size === '1792x1024'
  ) {
    return size;
  }
  throw new Error(`AI_TECHNIQUE_IMAGE_SIZE 配置无效：${size}`);
};

const toOpenAIImageResponseFormat = (responseFormat: string): OpenAIImageResponseFormat => {
  if (responseFormat === 'b64_json' || responseFormat === 'url') {
    return responseFormat;
  }
  throw new Error(`AI_TECHNIQUE_IMAGE_RESPONSE_FORMAT 配置无效：${responseFormat}`);
};

const fetchJsonWithTimeout = async (
  endpoint: string,
  payload: Record<string, unknown>,
  apiKey: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'disable',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const rawText = await response.text();
      throw new Error(`图像模型请求失败：${response.status} ${rawText.slice(0, 200)}`.trim());
    }
    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
};

export const downloadImageBuffer = async (url: string, timeoutMs: number): Promise<Buffer> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`下载图片失败：${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length <= 0) {
      throw new Error('下载图片失败：返回空图片');
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
};

export const generateConfiguredImageAsset = async (
  prompt: string,
): Promise<ImageGenerationResult | null> => {
  const config = readImageModelConfig();
  if (!config) return null;

  if (config.provider === 'dashscope') {
    const payload = buildDashScopeImageGenerationPayload(
      config.modelName,
      prompt,
      normalizeSizeForDashScope(config.size),
    );
    const body = await fetchJsonWithTimeout(config.endpoint, payload, config.apiKey, config.timeoutMs);
    const asset = readDashScopeImageGenerationResult(body);
    return {
      asset: {
        ...asset,
        b64: normalizeGeneratedImageBase64(asset.b64),
      },
      timeoutMs: config.timeoutMs,
      provider: config.provider,
      modelName: config.modelName,
    };
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.timeoutMs,
  });
  const response = await client.images.generate({
    model: config.modelName,
    prompt,
    size: toOpenAIImageSize(config.size),
    response_format: toOpenAIImageResponseFormat(config.responseFormat),
  });
  const image = Array.isArray(response.data) ? response.data[0] : undefined;

  return {
    asset: {
      b64: normalizeGeneratedImageBase64(asString(image?.b64_json)),
      url: asString(image?.url),
    },
    timeoutMs: config.timeoutMs,
    provider: config.provider,
    modelName: config.modelName,
  };
};
