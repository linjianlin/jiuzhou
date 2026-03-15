/**
 * 伙伴招募 HASH 扰动请求测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴招募文本模型请求会显式携带随机 seed，并把基于 seed 生成的扰动 hash 注入 prompt 输入。
 * 2. 做什么：确保“只加 prompt 扰动、不做骨架”的策略集中在单一请求构造入口，避免后续 service 内联拼接再次分叉。
 * 3. 不做什么：不请求真实模型、不访问数据库，也不覆盖草稿校验与预览落库。
 *
 * 输入/输出：
 * - 输入：品质、固定 seed。
 * - 输出：文本模型请求参数中的 seed、promptNoiseHash 与 userMessage。
 *
 * 数据流/状态流：
 * 固定 seed -> buildPartnerRecruitTextModelRequest -> prompt 输入 JSON -> 文本模型调用。
 *
 * 关键边界条件与坑点：
 * 1. 显式 seed 与 promptNoiseHash 必须来自同一请求构造入口，否则“看起来有 hash，实际没传 seed”会再次分叉。
 * 2. hash 只用于扰动 prompt，不应要求模型解释或显式输出；测试只锁定请求载荷，不测试模型行为。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPartnerRecruitTextModelRequest,
} from '../partnerRecruitService.js';
import {
  buildPartnerRecruitPromptNoiseHash,
} from '../shared/partnerRecruitRules.js';

test('buildPartnerRecruitTextModelRequest: 应显式传入 seed 并在 prompt 中注入对应扰动 hash', () => {
  const seed = 20260315;
  const request = buildPartnerRecruitTextModelRequest('黄', seed);
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    quality?: string;
    promptNoiseHash?: string;
  };

  assert.equal(request.seed, seed);
  assert.equal(parsedUserMessage.quality, '黄');
  assert.equal(parsedUserMessage.promptNoiseHash, buildPartnerRecruitPromptNoiseHash(seed));
});
