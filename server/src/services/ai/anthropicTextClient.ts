/**
 * Anthropic 文本模型 client
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：使用 @anthropic-ai/sdk 发起文本模型请求，并统一返回与 OpenAI 客户端相同结构的结果（modelName / promptSnapshot / content）。
 * 2) 做什么：让功法生成、伙伴招募等业务链路在切换到 Anthropic provider 时无需感知协议差异。
 * 3) 不做什么：不拼业务 prompt、不做业务 JSON 校验，也不吞掉请求异常。
 *
 * 输入/输出：
 * - 输入：system/user 消息、可选 responseFormat（OpenAI 格式的 json_schema，会自动转换为 Anthropic output_config）、请求超时。
 * - 输出：`{ modelName, promptSnapshot, content }`，与 OpenAI 客户端返回类型一致。
 *
 * 数据流/状态流：
 * 业务 prompt -> anthropicTextClient -> Anthropic SDK messages.create -> 提取 text content -> 调用方做 JSON 解析/业务校验。
 *
 * 关键边界条件与坑点：
 * 1) Anthropic 的 system message 不在 messages 数组中，而是通过独立的 `system` 参数传入；混入 messages 会导致 400 错误。
 * 2) OpenAI 的 response_format.json_schema.schema 需要转换为 Anthropic 的 output_config.format（type: 'json_schema', schema）。
 * 3) 无 responseFormat 时，SDK 不支持 json_object 模式；通过 assistant prefill `{` 引导 Claude 直接输出 JSON，避免 markdown 包裹或解释文字。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { TextModelConfig } from './modelConfig.js';
import {
  TECHNIQUE_TEXT_MODEL_TEMPERATURE,
  type TechniqueTextModelResponseFormat,
} from '../shared/techniqueTextModelShared.js';
import type { OpenAITextModelCallResult } from './openAITextClient.js';

// 功法 JSON 结构较大，需要足够的输出 token 空间
const ANTHROPIC_MAX_TOKENS = 81920;

/**
 * 从 Anthropic 响应的 content 数组中提取纯文本。
 * Anthropic 返回 `content: Array<{ type: 'text', text: string } | ...>`，只取 text 类型拼接。
 */
const extractAnthropicTextContent = (
  content: Anthropic.Messages.ContentBlock[],
): string => {
  return content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
};

/**
 * 构建 Anthropic output_config。
 * 有 responseFormat（JSON Schema）时转换为 Anthropic 的 json_schema 格式；
 * 无 responseFormat 时不设置 output_config（由 system message 约束 JSON 输出）。
 *
 * OpenAI: { type: 'json_schema', json_schema: { name, schema, strict } }
 * Anthropic: { format: { type: 'json_schema', schema } }
 */
const buildAnthropicOutputConfig = (
  responseFormat?: TechniqueTextModelResponseFormat,
): Anthropic.Messages.OutputConfig | undefined => {
  if (!responseFormat) return undefined;
  if (responseFormat.type !== 'json_schema') return undefined;
  return {
    format: {
      type: 'json_schema',
      schema: responseFormat.json_schema.schema as Record<string, unknown>,
    },
  };
};

export const callAnthropicTextModel = async (
  config: TextModelConfig,
  params: {
    responseFormat?: TechniqueTextModelResponseFormat;
    systemMessage: string;
    userMessage: string;
    temperature?: number;
    timeoutMs: number;
  },
): Promise<OpenAITextModelCallResult> => {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    timeout: params.timeoutMs,
  });

  const requestBody: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: config.modelName,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    temperature: params.temperature ?? TECHNIQUE_TEXT_MODEL_TEMPERATURE,
    system: params.systemMessage,
    thinking: { type:"enabled", budget_tokens: 64000 },
    messages: [
      { role: 'user' as const, content: params.userMessage },
    ],
    output_config: buildAnthropicOutputConfig(params.responseFormat),
  };

  const message = await client.messages.create(requestBody);

  return {
    modelName: config.modelName,
    promptSnapshot: JSON.stringify(requestBody),
    content: extractAnthropicTextContent(message.content),
  };
};
