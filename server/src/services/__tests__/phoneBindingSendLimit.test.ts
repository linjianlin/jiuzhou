/**
 * 手机号绑定短信发送限次测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定手机号绑定短信发送的小时/天限次规则，避免业务服务里再次散落“每小时 / 每天”两套 Redis 计数判断。
 * 2. 做什么：验证共享模块会按同一时区口径生成窗口键，并在发送成功后统一记录小时与天的发送计数。
 * 3. 不做什么：不请求真实 Redis，不调用阿里云短信服务，也不验证手机号绑定写库流程。
 *
 * 输入/输出：
 * - 输入：模拟的 Redis `get/incr/expire` 行为、固定的当前时间、以及小时/天上限配置。
 * - 输出：发送前校验结果、超限业务错误，以及发送成功后的 Redis 写入断言。
 *
 * 数据流/状态流：
 * - 测试先用 `node:test` mock 模拟 Redis 当前计数；
 * - 再调用限次共享模块执行“发送前校验 / 发送后记数”；
 * - 最后断言是否抛出正确业务错误，以及是否写入统一窗口键。
 *
 * 关键边界条件与坑点：
 * 1. 小时与天窗口必须共享同一时区口径；如果一个按本地时区、一个按 UTC，玩家会遇到“明明过点了但仍被拦”的错觉。
 * 2. 发送成功后必须同时记录小时与天两个窗口；不能在业务服务里各自补一遍 Redis 写入，否则后续再接别的短信场景时会重复实现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { redis } from '../../config/redis.js';
import { BusinessError } from '../../middleware/BusinessError.js';
import {
  assertPhoneBindingSendLimitAvailable,
  recordPhoneBindingSendSuccess,
} from '../shared/phoneBindingSendLimit.js';

const LIMIT_CONFIG = {
  hourlyLimit: 5,
  dailyLimit: 10,
} as const;

test.after(() => {
  redis.disconnect();
});

test('assertPhoneBindingSendLimitAvailable: 当前小时和当天都未超限时应允许发送', async (t) => {
  t.mock.method(redis, 'get', async () => null);

  await assertPhoneBindingSendLimitAvailable(7, LIMIT_CONFIG, new Date('2026-03-16T12:34:56.000Z'));
});

test('assertPhoneBindingSendLimitAvailable: 当前小时已达上限时应拒绝发送', async (t) => {
  t.mock.method(redis, 'get', async (key: string) => {
    if (key.includes(':hour:')) {
      return '5';
    }
    return '3';
  });

  await assert.rejects(
    assertPhoneBindingSendLimitAvailable(7, LIMIT_CONFIG, new Date('2026-03-16T12:34:56.000Z')),
    (error: unknown) =>
      error instanceof BusinessError && error.message === '验证码每小时最多发送5次，请下个整点后再试',
  );
});

test('assertPhoneBindingSendLimitAvailable: 当前天已达上限时应拒绝发送', async (t) => {
  t.mock.method(redis, 'get', async (key: string) => {
    if (key.includes(':hour:')) {
      return '2';
    }
    return '10';
  });

  await assert.rejects(
    assertPhoneBindingSendLimitAvailable(7, LIMIT_CONFIG, new Date('2026-03-16T12:34:56.000Z')),
    (error: unknown) =>
      error instanceof BusinessError && error.message === '验证码当天最多发送10次，请明天再试',
  );
});

test('recordPhoneBindingSendSuccess: 发送成功后应同时写入小时与天窗口计数', async (t) => {
  const incrKeys: string[] = [];
  const expireCalls: Array<{ key: string; seconds: number }> = [];

  t.mock.method(redis, 'incr', async (key: string) => {
    incrKeys.push(key);
    return 1;
  });
  t.mock.method(redis, 'expire', async (key: string, seconds: number) => {
    expireCalls.push({ key, seconds });
    return 1;
  });

  await recordPhoneBindingSendSuccess(7, LIMIT_CONFIG, new Date('2026-03-16T12:34:56.000Z'));

  assert.deepEqual(incrKeys, [
    'market:phone-binding:send-limit:hour:7:2026031620',
    'market:phone-binding:send-limit:day:7:20260316',
  ]);
  assert.deepEqual(expireCalls, [
    { key: 'market:phone-binding:send-limit:hour:7:2026031620', seconds: 7200 },
    { key: 'market:phone-binding:send-limit:day:7:20260316', seconds: 172800 },
  ]);
});
