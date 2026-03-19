/**
 * AI 文本模型共享解析
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中处理文生成功法所需的文本模型地址归一化、请求 payload 构造、结构化输出 response_format、seed 生成、消息正文提取、JSON 对象解析。
 * 2) 不做什么：不负责读取环境变量、不负责发起 HTTP 请求、不负责业务校验与数据库落库。
 *
 * 输入/输出：
 * - 输入：模型基础地址或完整地址、模型名、可选 seed、可选 JSON Schema response_format、system/user 消息文本、模型消息 content、模型返回文本。
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
 * 5) 结构化输出 schema 一旦开始使用，必须由共享层统一承接，避免每个业务 service 自己拼 `response_format` 导致字段名继续漂移。
 */
import { createHash, randomInt } from 'crypto';


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

type TechniqueTextModelJsonSchemaBase = {
  allOf?: TechniqueTextModelJsonSchema[];
  anyOf?: TechniqueTextModelJsonSchema[];
  const?: TechniqueModelJsonPrimitive;
  description?: string;
  else?: TechniqueTextModelJsonSchema;
  if?: TechniqueTextModelJsonSchema;
  oneOf?: TechniqueTextModelJsonSchema[];
  then?: TechniqueTextModelJsonSchema;
};

type TechniqueTextModelJsonSchemaString = TechniqueTextModelJsonSchemaBase & {
  type: 'string';
  enum?: string[];
  maxLength?: number;
  minLength?: number;
  pattern?: string;
};

type TechniqueTextModelJsonSchemaNumber = TechniqueTextModelJsonSchemaBase & {
  type: 'integer' | 'number';
  exclusiveMaximum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minimum?: number;
};

type TechniqueTextModelJsonSchemaBoolean = TechniqueTextModelJsonSchemaBase & {
  type: 'boolean';
};

type TechniqueTextModelJsonSchemaNull = TechniqueTextModelJsonSchemaBase & {
  type: 'null';
};

type TechniqueTextModelJsonSchemaArray = TechniqueTextModelJsonSchemaBase & {
  type: 'array';
  items: TechniqueTextModelJsonSchema;
  maxItems?: number;
  minItems?: number;
};

type TechniqueTextModelJsonSchemaComposite = TechniqueTextModelJsonSchemaBase & {
  type?: undefined;
};

export type TechniqueTextModelJsonSchemaProperties = Record<string, TechniqueTextModelJsonSchema>;

export type TechniqueTextModelJsonSchemaObject = TechniqueTextModelJsonSchemaBase & {
  type: 'object';
  additionalProperties: boolean;
  properties: TechniqueTextModelJsonSchemaProperties;
  required: string[];
};

export type TechniqueTextModelJsonSchema =
  | TechniqueTextModelJsonSchemaArray
  | TechniqueTextModelJsonSchemaBoolean
  | TechniqueTextModelJsonSchemaComposite
  | TechniqueTextModelJsonSchemaNull
  | TechniqueTextModelJsonSchemaNumber
  | TechniqueTextModelJsonSchemaObject
  | TechniqueTextModelJsonSchemaString;

export type TechniqueTextModelResponseFormat =
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        schema: TechniqueTextModelJsonSchemaObject;
        strict: true;
      };
    }
  | {
      type: 'json_object';
    };

export type TechniqueTextModelRequestPayload = {
  model: string;
  response_format?: TechniqueTextModelResponseFormat;
  seed: number;
  temperature: number;
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
export const TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE = 0.4;
export const TECHNIQUE_TEXT_MODEL_SEED_MIN = 1;
export const TECHNIQUE_TEXT_MODEL_SEED_MAX = 2_147_483_647;
export const TEXT_MODEL_PROMPT_NOISE_CONSTRAINT =
  '如果提供了 promptNoiseHash，它仅作为本次创作扰动码：只需隐式影响命名、描述意象、措辞节奏与功法文风，禁止解释、复述、拆解、计算或显式输出该字符串，也不要生成数字、字母、符号或密码感内容';

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

const extractEmbeddedJsonObject = (text: string): TechniqueModelJsonObject | null => {
  let candidateStart = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === '\\') {
        isEscaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        candidateStart = index;
      }
      depth += 1;
      continue;
    }

    if (char !== '}' || depth === 0 || candidateStart < 0) {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    const candidate = text.slice(candidateStart, index + 1);
    const parsed = tryParseJsonObject(candidate);
    if (parsed) {
      return parsed;
    }
    candidateStart = -1;
  }

  return null;
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

export const normalizeTextModelPromptNoiseHash = (raw: string | undefined): string | null => {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(normalized)) return null;
  return normalized;
};

export const buildTextModelPromptNoiseHash = (scope: string, seed: number): string => {
  return createHash('sha256')
    .update(`${scope}:${seed}`)
    .digest('hex')
    .slice(0, 16);
};

export const buildTechniqueTextModelJsonSchemaResponseFormat = (_params: {
  name: string;
  schema: TechniqueTextModelJsonSchemaObject;
}): TechniqueTextModelResponseFormat => ({
  type: 'json_schema',
  json_schema: {
    name: _params.name,
    schema: _params.schema,
    strict: true,
  },
});

export const buildTechniqueTextModelPayload = (params: {
  modelName: string;
  responseFormat?: TechniqueTextModelResponseFormat;
  systemMessage: string;
  userMessage: string;
  seed?: number;
  temperature?: number;
}): TechniqueTextModelRequestPayload => ({
  model: params.modelName,
  response_format: params.responseFormat,
  seed: params.seed ?? generateTechniqueTextModelSeed(),
  temperature: params.temperature ?? TECHNIQUE_TEXT_MODEL_TEMPERATURE,
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

  const extractedObject = extractEmbeddedJsonObject(trimmed);
  if (!extractedObject) {
    return { success: false, reason: 'invalid_json_object' };
  }

  return {
    success: true,
    data: extractedObject,
  };
};
