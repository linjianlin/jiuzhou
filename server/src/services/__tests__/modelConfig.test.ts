import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeOpenAIBaseUrl,
  normalizeSizeForDashScope,
  readTextModelConfig,
  resolveDashScopeImageEndpoint,
  resolveImageProvider,
  resolveTextModelName,
} from '../ai/modelConfig.js';

const restoreEnvValue = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
};

test('normalizeOpenAIBaseUrl: 应统一归一化为 OpenAI SDK baseURL', () => {
  assert.equal(
    normalizeOpenAIBaseUrl('https://api.openai.com'),
    'https://api.openai.com/v1',
  );
  assert.equal(
    normalizeOpenAIBaseUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1',
  );
  assert.equal(
    normalizeOpenAIBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/images/generations'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
  );
});

test('resolveDashScopeImageEndpoint: 应统一归一化为同步生图地址', () => {
  assert.equal(
    resolveDashScopeImageEndpoint('https://dashscope.aliyuncs.com'),
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  );
  assert.equal(
    resolveDashScopeImageEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  );
});

test('normalizeSizeForDashScope: 应统一转为星号尺寸', () => {
  assert.equal(normalizeSizeForDashScope('512x768'), '512*768');
  assert.equal(normalizeSizeForDashScope('512*768'), '512*768');
});

test('resolveImageProvider: auto 应按 endpoint 与模型名判定 provider', () => {
  assert.equal(resolveImageProvider('auto', 'https://dashscope.aliyuncs.com', 'qwen-image-2.0'), 'dashscope');
  assert.equal(resolveImageProvider('auto', 'https://api.openai.com', 'gpt-image-1'), 'openai');
  assert.equal(resolveImageProvider('openai', 'https://dashscope.aliyuncs.com', 'qwen-image-2.0'), 'openai');
});

test('readTextModelConfig: 功法与伙伴文本模型配置应完全独立', () => {
  const originalEnv = {
    AI_TECHNIQUE_MODEL_PROVIDER: process.env.AI_TECHNIQUE_MODEL_PROVIDER,
    AI_TECHNIQUE_MODEL_URL: process.env.AI_TECHNIQUE_MODEL_URL,
    AI_TECHNIQUE_MODEL_KEY: process.env.AI_TECHNIQUE_MODEL_KEY,
    AI_TECHNIQUE_MODEL_NAME: process.env.AI_TECHNIQUE_MODEL_NAME,
    AI_PARTNER_MODEL_PROVIDER: process.env.AI_PARTNER_MODEL_PROVIDER,
    AI_PARTNER_MODEL_URL: process.env.AI_PARTNER_MODEL_URL,
    AI_PARTNER_MODEL_KEY: process.env.AI_PARTNER_MODEL_KEY,
    AI_PARTNER_MODEL_NAME: process.env.AI_PARTNER_MODEL_NAME,
  };

  process.env.AI_TECHNIQUE_MODEL_PROVIDER = 'openai';
  process.env.AI_TECHNIQUE_MODEL_URL = 'https://technique.example.com/v1/chat/completions';
  process.env.AI_TECHNIQUE_MODEL_KEY = 'technique-key';
  process.env.AI_TECHNIQUE_MODEL_NAME = 'technique-model';
  process.env.AI_PARTNER_MODEL_PROVIDER = 'anthropic';
  process.env.AI_PARTNER_MODEL_URL = 'https://partner.example.com';
  process.env.AI_PARTNER_MODEL_KEY = 'partner-key';
  process.env.AI_PARTNER_MODEL_NAME = 'partner-model';

  try {
    assert.deepEqual(readTextModelConfig('technique'), {
      provider: 'openai',
      apiKey: 'technique-key',
      baseURL: 'https://technique.example.com/v1',
      modelName: 'technique-model',
    });
    assert.deepEqual(readTextModelConfig('partner'), {
      provider: 'anthropic',
      apiKey: 'partner-key',
      baseURL: 'https://partner.example.com',
      modelName: 'partner-model',
    });
  } finally {
    restoreEnvValue('AI_TECHNIQUE_MODEL_PROVIDER', originalEnv.AI_TECHNIQUE_MODEL_PROVIDER);
    restoreEnvValue('AI_TECHNIQUE_MODEL_URL', originalEnv.AI_TECHNIQUE_MODEL_URL);
    restoreEnvValue('AI_TECHNIQUE_MODEL_KEY', originalEnv.AI_TECHNIQUE_MODEL_KEY);
    restoreEnvValue('AI_TECHNIQUE_MODEL_NAME', originalEnv.AI_TECHNIQUE_MODEL_NAME);
    restoreEnvValue('AI_PARTNER_MODEL_PROVIDER', originalEnv.AI_PARTNER_MODEL_PROVIDER);
    restoreEnvValue('AI_PARTNER_MODEL_URL', originalEnv.AI_PARTNER_MODEL_URL);
    restoreEnvValue('AI_PARTNER_MODEL_KEY', originalEnv.AI_PARTNER_MODEL_KEY);
    restoreEnvValue('AI_PARTNER_MODEL_NAME', originalEnv.AI_PARTNER_MODEL_NAME);
  }
});

test('resolveTextModelName: 应支持逗号分隔模型并按随机值稳定选择', () => {
  assert.equal(resolveTextModelName('', 'fallback-model', 0.3), 'fallback-model');
  assert.equal(resolveTextModelName('gpt-4o-mini', 'fallback-model', 0.3), 'gpt-4o-mini');
  assert.equal(resolveTextModelName('gpt-4o-mini, claude-3-5-sonnet ,deepseek-chat', 'fallback-model', 0), 'gpt-4o-mini');
  assert.equal(resolveTextModelName('gpt-4o-mini, claude-3-5-sonnet ,deepseek-chat', 'fallback-model', 0.5), 'claude-3-5-sonnet');
  assert.equal(resolveTextModelName('gpt-4o-mini, claude-3-5-sonnet ,deepseek-chat', 'fallback-model', 0.999999), 'deepseek-chat');
});

test('readTextModelConfig: 伙伴文本模型缺配置时不应回退读取功法变量', () => {
  const originalEnv = {
    AI_TECHNIQUE_MODEL_PROVIDER: process.env.AI_TECHNIQUE_MODEL_PROVIDER,
    AI_TECHNIQUE_MODEL_URL: process.env.AI_TECHNIQUE_MODEL_URL,
    AI_TECHNIQUE_MODEL_KEY: process.env.AI_TECHNIQUE_MODEL_KEY,
    AI_TECHNIQUE_MODEL_NAME: process.env.AI_TECHNIQUE_MODEL_NAME,
    AI_PARTNER_MODEL_PROVIDER: process.env.AI_PARTNER_MODEL_PROVIDER,
    AI_PARTNER_MODEL_URL: process.env.AI_PARTNER_MODEL_URL,
    AI_PARTNER_MODEL_KEY: process.env.AI_PARTNER_MODEL_KEY,
    AI_PARTNER_MODEL_NAME: process.env.AI_PARTNER_MODEL_NAME,
  };

  process.env.AI_TECHNIQUE_MODEL_PROVIDER = 'openai';
  process.env.AI_TECHNIQUE_MODEL_URL = 'https://technique.example.com/v1';
  process.env.AI_TECHNIQUE_MODEL_KEY = 'technique-key';
  process.env.AI_TECHNIQUE_MODEL_NAME = 'technique-model';
  delete process.env.AI_PARTNER_MODEL_PROVIDER;
  delete process.env.AI_PARTNER_MODEL_URL;
  delete process.env.AI_PARTNER_MODEL_KEY;
  delete process.env.AI_PARTNER_MODEL_NAME;

  try {
    assert.equal(readTextModelConfig('partner'), null);
  } finally {
    restoreEnvValue('AI_TECHNIQUE_MODEL_PROVIDER', originalEnv.AI_TECHNIQUE_MODEL_PROVIDER);
    restoreEnvValue('AI_TECHNIQUE_MODEL_URL', originalEnv.AI_TECHNIQUE_MODEL_URL);
    restoreEnvValue('AI_TECHNIQUE_MODEL_KEY', originalEnv.AI_TECHNIQUE_MODEL_KEY);
    restoreEnvValue('AI_TECHNIQUE_MODEL_NAME', originalEnv.AI_TECHNIQUE_MODEL_NAME);
    restoreEnvValue('AI_PARTNER_MODEL_PROVIDER', originalEnv.AI_PARTNER_MODEL_PROVIDER);
    restoreEnvValue('AI_PARTNER_MODEL_URL', originalEnv.AI_PARTNER_MODEL_URL);
    restoreEnvValue('AI_PARTNER_MODEL_KEY', originalEnv.AI_PARTNER_MODEL_KEY);
    restoreEnvValue('AI_PARTNER_MODEL_NAME', originalEnv.AI_PARTNER_MODEL_NAME);
  }
});
