/**
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验敏感词检测共享服务对“本地词表命中、远端服务命中、服务不可用”的统一归一化行为。
 * - 不做什么：不验证聊天/角色创建/功法命名各自的 UI 或路由提示，它们只消费本模块结果。
 *
 * 输入/输出：
 * - 输入：待检测文本、模拟环境变量、模拟 fetch 返回值。
 * - 输出：`detectSensitiveWords` 与 `guardSensitiveText` 的标准结果。
 *
 * 数据流/状态流：
 * 输入文本 -> 本地词表短路 / 远端 `/wordscheck` -> 统一检测结果 -> 调用方错误文案。
 *
 * 关键边界条件与坑点：
 * 1) 本地词表已命中时必须短路，不能继续发起远端请求，否则会造成重复开销和结果漂移。
 * 2) 服务开启却请求失败时不能偷偷放行，必须显式返回“服务不可用”分支给上层拦截。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSensitiveWords, guardSensitiveText } from '../sensitiveWordService.js';

const withEnv = async (
  entries: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> => {
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
    await run();
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

const withFetch = async (fetchImpl: typeof fetch, run: () => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('detectSensitiveWords: 本地词表命中时应直接短路', async () => {
  let fetchCalled = false;
  await withEnv(
    {
      SENSITIVE_WORD_SERVICE_ENABLED: 'false',
      SENSITIVE_WORD_SERVICE_BASE_URL: undefined,
      SENSITIVE_WORD_SERVICE_TIMEOUT_MS: '3000',
    },
    async () => {
      await withFetch(
        async () => {
          fetchCalled = true;
          return new Response('{}', { status: 200 });
        },
        async () => {
          const result = await detectSensitiveWords('管理员驾到');
          assert.equal(result.matched, true);
          assert.equal(result.source, 'local');
          assert.equal(result.hits[0]?.keyword, '管理员');
          assert.equal(fetchCalled, false);
        },
      );
    },
  );
});

test('detectSensitiveWords: 远端命中时应返回统一结构', async () => {
  await withEnv(
    {
      SENSITIVE_WORD_SERVICE_ENABLED: 'true',
      SENSITIVE_WORD_SERVICE_BASE_URL: 'http://192.168.99.110:8080',
      SENSITIVE_WORD_SERVICE_TIMEOUT_MS: '3000',
    },
    async () => {
      await withFetch(
        async () =>
          new Response(
            JSON.stringify({
              code: '0',
              msg: '检测成功',
              return_str: '他是*-***',
              word_list: [
                { keyword: '习', category: '政治', position: '2-2', level: '中' },
                { keyword: '近平', category: '政治', position: '4-6', level: '中' },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        async () => {
          const result = await detectSensitiveWords('他是习-近-平');
          assert.equal(result.matched, true);
          assert.equal(result.source, 'remote');
          assert.equal(result.sanitizedContent, '他是*-***');
          assert.equal(result.hits.length, 2);
        },
      );
    },
  );
});

test('guardSensitiveText: 远端异常时应返回服务不可用提示', async () => {
  await withEnv(
    {
      SENSITIVE_WORD_SERVICE_ENABLED: 'true',
      SENSITIVE_WORD_SERVICE_BASE_URL: 'http://192.168.99.110:8080',
      SENSITIVE_WORD_SERVICE_TIMEOUT_MS: '3000',
    },
    async () => {
      await withFetch(
        async () => {
          throw new Error('network down');
        },
        async () => {
          const result = await guardSensitiveText(
            '正常内容',
            '内容包含敏感词，请重试',
            '敏感词检测服务暂不可用，请稍后重试',
          );
          assert.equal(result.success, false);
          if (result.success) return;
          assert.equal(result.code, 'SERVICE_UNAVAILABLE');
          assert.equal(result.message, '敏感词检测服务暂不可用，请稍后重试');
        },
      );
    },
  );
});
