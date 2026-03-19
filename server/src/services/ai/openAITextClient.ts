/**
 * AI 文本模型统一入口
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：根据 TextModelConfig.provider 分流到 OpenAI SDK 或 Anthropic SDK，对外暴露统一的 `callConfiguredTextModel`。
 * 2) 做什么：让功法生成、伙伴招募等业务层只调用这一个入口，不感知底层 provider 差异。
 * 3) 不做什么：不拼业务 prompt、不做业务 JSON 校验，也不吞掉请求异常。
 *
 * 输入/输出：
 * - 输入：system/user 消息、可选 responseFormat、可选 seed、请求超时。
 * - 输出：`{ modelName, promptSnapshot, content }`。
 *
 * 数据流/状态流：
 * 业务 prompt -> callConfiguredTextModel -> (OpenAI SDK | Anthropic SDK) -> 统一提取 content -> 调用方做 JSON 解析/业务校验。
 *
 * 关键边界条件与坑点：
 * 1) OpenAI SDK 返回的 message content 可能是字符串，也可能是分段数组；这里必须统一提取，否则业务层又会回到重复解析。
 * 2) Anthropic 的 seed 参数不支持，切换 provider 后 seed 会被忽略；responseFormat 会自动转换为 Anthropic 的 output_config.format。
 */
import OpenAI from 'openai';
import { readTextModelConfig } from './modelConfig.js';
import { callAnthropicTextModel } from './anthropicTextClient.js';
import {
  buildTechniqueTextModelPayload,
  extractTechniqueTextModelContent,
  type TechniqueTextModelResponseFormat,
} from '../shared/techniqueTextModelShared.js';

export type OpenAITextModelCallResult = {
  modelName: string;
  promptSnapshot: string;
  content: string;
};

const normalizeCompletionContent = (rawContent: unknown): string => {
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return '';
  return extractTechniqueTextModelContent(
    rawContent.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { text: null };
      }
      const row = entry as { text?: string | null };
      return {
        text: typeof row.text === 'string' ? row.text : null,
      };
    }),
  );
};

export const callConfiguredTextModel = async (params: {
  responseFormat?: TechniqueTextModelResponseFormat;
  systemMessage: string;
  userMessage: string;
  seed?: number;
  temperature?: number;
  timeoutMs: number;
}): Promise<OpenAITextModelCallResult | null> => {
  const config = readTextModelConfig();
  if (!config) return null;

  // Anthropic provider：seed 不支持；responseFormat 会在 Anthropic 客户端内转换为 output_config
  if (config.provider === 'anthropic') {
    return callAnthropicTextModel(config, {
      responseFormat: params.responseFormat,
      systemMessage: params.systemMessage,
      userMessage: params.userMessage,
      temperature: params.temperature,
      timeoutMs: params.timeoutMs,
    });
  }

  const payload = buildTechniqueTextModelPayload({
    modelName: config.modelName,
    responseFormat: params.responseFormat,
    systemMessage: params.systemMessage,
    userMessage: params.userMessage,
    seed: params.seed,
    temperature: params.temperature,
  });
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: params.timeoutMs,
  });
  const completion = await client.chat.completions.create(payload);

  return {
    modelName: config.modelName,
    promptSnapshot: JSON.stringify(payload),
    content: normalizeCompletionContent(completion.choices[0]?.message?.content),
  };
};
