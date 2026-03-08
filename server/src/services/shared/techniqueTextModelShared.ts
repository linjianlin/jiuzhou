/**
 * AI 文本模型共享解析
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中处理文生成功法所需的文本模型地址归一化、请求 payload 构造、seed 生成、消息正文提取、JSON 对象解析。
 * 2) 不做什么：不负责读取环境变量、不负责发起 HTTP 请求、不负责业务校验与数据库落库。
 *
 * 输入/输出：
 * - 输入：模型基础地址或完整地址、模型名、可选 seed、system/user 消息文本、模型消息 content、模型返回文本。
 * - 输出：可直接请求的 `chat/completions` 地址、统一请求 payload、纯文本 content、结构化 JSON 解析结果。
 *
 * 数据流/状态流：
 * 环境变量/提示词输入/响应体字段 -> 共享函数 -> service 正式链路 / 联调脚本共同消费。
 *
 * 关键边界条件与坑点：
 * 1) 很多 OpenAI 兼容服务允许只填基础地址，因此这里必须统一补全 `/v1/chat/completions`，避免各处手写导致 404。
 * 2) 文本模型请求参数（尤其 temperature/seed）要由单一入口构造，避免正式服务与联调脚本只改到一边。
 * 3) 未显式传入 seed 时必须在共享层自动生成，这样正式服务与联调脚本才能保持同一套随机策略。
 * 4) 模型 content 既可能是字符串，也可能是分段数组；若不集中处理，脚本与服务很容易再次分叉。
 */
import { randomInt } from 'crypto';


type TechniqueModelJsonPrimitive = string | number | boolean | null;
type TechniqueModelJsonValue =
  | TechniqueModelJsonPrimitive
  | TechniqueModelJsonObject
  | TechniqueModelJsonValue[];

export type TechniqueModelJsonObject = {
  [key: string]: TechniqueModelJsonValue;
};

export type TechniqueModelContentPart = {
  text?: string | null;
};

export type TechniqueTextModelRequestPayload = {
  model: string;
  seed: number;
  temperature: number;
  response_format: {
    type: 'json_object';
  };
  messages: [
    {
      role: 'system';
      content: string;
    },
    {
      role: 'user';
      content: string;
    },
  ];
};

export type TechniqueModelJsonParseResult =
  | {
      success: true;
      data: TechniqueModelJsonObject;
    }
  | {
      success: false;
      reason: 'empty_content' | 'invalid_json_object';
    };

export const TECHNIQUE_TEXT_MODEL_TEMPERATURE = 1.0;
export const TECHNIQUE_TEXT_MODEL_SEED_MIN = 1;
export const TECHNIQUE_TEXT_MODEL_SEED_MAX = 2_147_483_647;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const isJsonObject = (value: TechniqueModelJsonValue): value is TechniqueModelJsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const tryParseJsonObject = (text: string): TechniqueModelJsonObject | null => {
  try {
    const parsed = JSON.parse(text) as TechniqueModelJsonValue;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const resolveTechniqueTextModelEndpoint = (rawEndpoint: string): string => {
  const endpoint = trimTrailingSlash(rawEndpoint.trim());
  if (!endpoint) return '';
  if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
  if (/\/v1$/i.test(endpoint)) return `${endpoint}/chat/completions`;
  return `${endpoint}/v1/chat/completions`;
};

export const generateTechniqueTextModelSeed = (): number =>
  randomInt(TECHNIQUE_TEXT_MODEL_SEED_MIN, TECHNIQUE_TEXT_MODEL_SEED_MAX + 1);

export const buildTechniqueTextModelPayload = (params: {
  modelName: string;
  systemMessage: string;
  userMessage: string;
  seed?: number;
}): TechniqueTextModelRequestPayload => ({
  model: params.modelName,
  seed: params.seed ?? generateTechniqueTextModelSeed(),
  temperature: TECHNIQUE_TEXT_MODEL_TEMPERATURE,
  response_format: { type: 'json_object' },
  messages: [
    {
      role: 'system',
      content: params.systemMessage,
    },
    {
      role: 'user',
      content: params.userMessage,
    },
  ],
});

export const extractTechniqueTextModelContent = (
  rawContent: string | readonly TechniqueModelContentPart[] | null | undefined,
): string => {
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return '';
  return rawContent
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter((part) => part.length > 0)
    .join('');
};

export const parseTechniqueTextModelJsonObject = (
  content: string,
): TechniqueModelJsonParseResult => {
  const trimmed = content.trim();
  if (!trimmed) {
    return { success: false, reason: 'empty_content' };
  }

  const directObject = tryParseJsonObject(trimmed);
  if (directObject) {
    return {
      success: true,
      data: directObject,
    };
  }

  const matched = trimmed.match(/\{[\s\S]*\}/);
  if (!matched) {
    return { success: false, reason: 'invalid_json_object' };
  }

  const extractedObject = tryParseJsonObject(matched[0]);
  if (!extractedObject) {
    return { success: false, reason: 'invalid_json_object' };
  }

  return {
    success: true,
    data: extractedObject,
  };
};
