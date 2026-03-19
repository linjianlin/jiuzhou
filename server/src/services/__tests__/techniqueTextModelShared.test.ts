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
  buildTextModelPromptNoiseHash,
  buildTechniqueTextModelPayload,
  buildTechniqueTextModelJsonSchemaResponseFormat,
  extractTechniqueTextModelContent,
  parseTechniqueTextModelJsonObject,
  TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE,
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

test('请求 payload 应统一使用供应商兼容字段', () => {
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"天"}',
  });

  assert.equal(payload.model, 'gpt-4o-mini');
  assert.equal(payload.temperature, TECHNIQUE_TEXT_MODEL_TEMPERATURE);
  assert.equal(payload.temperature, 1.0);
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

test('显式传入 temperature 时应覆盖默认值', () => {
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"玄"}',
    temperature: TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE,
  });

  assert.equal(payload.temperature, TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE);
});

test('同一 scope 与 seed 应派生稳定的 promptNoiseHash', () => {
  const noiseHash = buildTextModelPromptNoiseHash('technique-generation', 20260315);

  assert.equal(noiseHash.length, 16);
  assert.equal(noiseHash, buildTextModelPromptNoiseHash('technique-generation', 20260315));
  assert.notEqual(noiseHash, buildTextModelPromptNoiseHash('partner-recruit', 20260315));
});

test('显式传入 response_format 时应原样写入 payload', () => {
  const responseFormat = buildTechniqueTextModelJsonSchemaResponseFormat({
    name: 'partner_recruit_draft',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['partner'],
      properties: {
        partner: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: {
              type: 'string',
              minLength: 2,
              maxLength: 6,
            },
          },
        },
      },
    },
  });
  const payload = buildTechniqueTextModelPayload({
    modelName: 'gpt-4o-mini',
    systemMessage: 'system prompt',
    userMessage: '{"quality":"黄"}',
    responseFormat,
  });

  assert.deepEqual(payload.response_format, responseFormat);
  assert.equal(responseFormat.type, 'json_schema');
  if (responseFormat.type !== 'json_schema') return;
  assert.equal(responseFormat.json_schema.name, 'partner_recruit_draft');
  assert.equal(responseFormat.json_schema.strict, true);
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

test('前置说明含有无效花括号时仍应提取后续合法 JSON 对象', () => {
  const result = parseTechniqueTextModelJsonObject(
    '请忽略这个占位 {not-json}\n最终结果如下：{"technique":{"name":"太虚剑诀","summary":"剑意如潮 {不入结构}"}}',
  );
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.technique && typeof result.data.technique === 'object', true);
});

test('存在多个嵌入对象时应优先提取命中期望顶层键的完整结果', () => {
  const result = parseTechniqueTextModelJsonObject(
    [
      '先给一个错误示例：',
      '{"id":"skill-a","name":"碎星斩","description":"这是单个技能对象"}',
      '最终结果：',
      '{"technique":{"name":"太虚剑诀"},"skills":[{"id":"skill-a","name":"碎星斩"}],"layers":[{"layer":1}]}',
    ].join('\n'),
    {
      preferredTopLevelKeys: ['technique', 'skills', 'layers'],
    },
  );

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.technique && typeof result.data.technique === 'object', true);
  assert.equal(Array.isArray(result.data.skills), true);
  assert.equal(Array.isArray(result.data.layers), true);
});

test('模型返回 think 标签时应忽略其中的 JSON 并解析最终结果', () => {
  const result = parseTechniqueTextModelJsonObject(
    [
      '<think>',
      '{"technique":{"name":"推理草稿"},"skills":[{"id":"skill-think","name":"不要入库"}],"layers":[{"layer":1,"unlockSkillIds":["skill-think"],"upgradeSkillIds":[]}],"analysis":"这只是模型思维链，不是最终答案"}',
      '</think>',
      '{"technique":{"name":"太虚剑诀"},"skills":[{"id":"skill-final","name":"碎星斩"}],"layers":[{"layer":1,"unlockSkillIds":["skill-final"],"upgradeSkillIds":[]}]}',
    ].join('\n'),
    {
      preferredTopLevelKeys: ['technique', 'skills', 'layers'],
    },
  );

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.technique && typeof result.data.technique === 'object', true);
  assert.equal(
    result.data.technique &&
      typeof result.data.technique === 'object' &&
      'name' in result.data.technique
      ? result.data.technique.name
      : null,
    '太虚剑诀',
  );
});
