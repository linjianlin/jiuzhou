/**
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验敏感词检测服务配置的启停、`baseUrl` 归一化和固定 endpoint 推导。
 * - 不做什么：不发真实网络请求，也不验证具体业务入口如何消费检测结果。
 *
 * 输入/输出：
 * - 输入：测试内构造的环境变量。
 * - 输出：`readSensitiveWordServiceConfig` 与相关纯函数的归一化结果。
 *
 * 数据流/状态流：
 * 环境变量 -> 配置读取模块 -> 统一配置对象 -> 断言 endpoint / timeout / 启停状态。
 *
 * 关键边界条件与坑点：
 * 1) 服务开启但缺少 `baseUrl` 必须直接失败，否则调用方会误以为检测已经生效。
 * 2) endpoint 只能由单一模块补全 `/wordscheck`，测试要锁住这一点，避免业务层再次拼路径。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSensitiveWordServiceBaseUrl,
  readSensitiveWordServiceConfig,
  resolveSensitiveWordServiceEndpoint,
} from '../sensitiveWordConfig.js';

const withEnv = (entries: Record<string, string | undefined>, run: () => void): void => {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(entries)) {
    previous[key] = process.env[key];
    const nextValue = entries[key];
    if (typeof nextValue === 'string') {
      process.env[key] = nextValue;
      continue;
    }
    delete process.env[key];
  }

  try {
    run();
  } finally {
    for (const key of Object.keys(entries)) {
      const previousValue = previous[key];
      if (typeof previousValue === 'string') {
        process.env[key] = previousValue;
        continue;
      }
      delete process.env[key];
    }
  }
};

test('normalizeSensitiveWordServiceBaseUrl: 应移除末尾斜杠', () => {
  assert.equal(
    normalizeSensitiveWordServiceBaseUrl('http://192.168.99.110:8080///'),
    'http://192.168.99.110:8080',
  );
});

test('resolveSensitiveWordServiceEndpoint: 应统一追加固定 wordscheck 路径', () => {
  assert.equal(
    resolveSensitiveWordServiceEndpoint('http://192.168.99.110:8080/base-path/'),
    'http://192.168.99.110:8080/wordscheck',
  );
});

test('readSensitiveWordServiceConfig: 关闭时不应要求 baseUrl', () => {
  withEnv(
    {
      SENSITIVE_WORD_SERVICE_ENABLED: 'false',
      SENSITIVE_WORD_SERVICE_BASE_URL: undefined,
      SENSITIVE_WORD_SERVICE_TIMEOUT_MS: '4500',
    },
    () => {
      const config = readSensitiveWordServiceConfig();
      assert.deepEqual(config, {
        enabled: false,
        baseUrl: '',
        endpoint: '',
        timeoutMs: 4500,
      });
    },
  );
});

test('readSensitiveWordServiceConfig: 开启但缺少 baseUrl 时应直接失败', () => {
  withEnv(
    {
      SENSITIVE_WORD_SERVICE_ENABLED: 'true',
      SENSITIVE_WORD_SERVICE_BASE_URL: undefined,
      SENSITIVE_WORD_SERVICE_TIMEOUT_MS: '3000',
    },
    () => {
      assert.throws(
        () => readSensitiveWordServiceConfig(),
        /必须配置 SENSITIVE_WORD_SERVICE_BASE_URL/,
      );
    },
  );
});
