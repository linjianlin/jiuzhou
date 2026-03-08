/**
 * AI 文本模型共享解析测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证文生成功法共享模块对 endpoint、content、JSON 对象解析的行为稳定，避免正式链路与联调脚本再次分叉。
 * 2. 不做什么：不请求真实模型、不读取环境变量，也不验证具体业务候选功法是否合法。
 *
 * 输入/输出：
 * - 输入：基础地址、完整地址、字符串/分段 content、模型原始文本。
 * - 输出：归一化后的 `chat/completions` 地址、拼接后的文本、JSON 解析结果。
 *
 * 数据流/状态流：
 * 原始模型配置/响应片段 -> 共享解析函数 -> 断言统一输出。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁定的是“协议适配”而不是业务规则，未来如果支持新 provider，优先扩展共享模块而不是回到 service 内联判断。
 * 2. 基础地址与完整地址都必须通过，同一个规则要同时被正式服务和本地脚本复用，才能真正减少重复。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTechniqueTextModelPayload,
  extractTechniqueTextModelContent,
  parseTechniqueTextModelJsonObject,
  TECHNIQUE_TEXT_MODEL_SEED_MAX,
  TECHNIQUE_TEXT_MODEL_SEED_MIN,
  TECHNIQUE_TEXT_MODEL_TEMPERATURE,
  resolveTechniqueTextModelEndpoint,
} from '../shared/techniqueTextModelShared.js';

test('基础地址应自动补全为 chat completions 地址', () => {
  assert.equal(
    resolveTechniqueTextModelEndpoint('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    resolveTechniqueTextModelEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  );
});

test('已带完整 chat completions 地址时应保持不变', () => {
  assert.equal(
    resolveTechniqueTextModelEndpoint('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('请求 payload 应统一使用 temperature 1.0', () => {
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"天"}',
  });

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.temperature, TECHNIQUE_TEXT_MODEL_TEMPERATURE);
  assert.equal(payload.temperature, 1.0);
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '{"quality":"天"}' },
  ]);
});

test('未显式传入 seed 时应自动生成合法随机整数', () => {
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"玄"}',
  });

  assert.equal(Number.isInteger(payload.seed), true);
  assert.equal(payload.seed >= TECHNIQUE_TEXT_MODEL_SEED_MIN, true);
  assert.equal(payload.seed <= TECHNIQUE_TEXT_MODEL_SEED_MAX, true);
});

test('显式传入 seed 时应保留调用方提供的值', () => {
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"地"}',
    seed: 20260308,
  });

  assert.equal(payload.seed, 20260308);
});

test('分段 content 应拼接为统一文本', () => {
  const content = extractTechniqueTextModelContent([
    { text: '```json' },
    { text: '\n{"technique":{"name":"太虚剑诀"}}\n' },
    { text: '```' },
  ]);
  assert.equal(content, '```json\n{"technique":{"name":"太虚剑诀"}}\n```');
});

test('模型文本中包裹的 JSON 对象应能被提取', () => {
  const result = parseTechniqueTextModelJsonObject(
    '下面是结果：\n```json\n{"technique":{"name":"太虚剑诀"}}\n```',
  );
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.technique && typeof result.data.technique === 'object', true);
});
