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
 * - 输出：文本模型请求参数中的 seed、promptNoiseHash、baseModel 与 userMessage。
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
import {
  resolvePartnerRecruitBaseModelBySeed,
} from '../shared/partnerRecruitBaseModel.js';

test('buildPartnerRecruitTextModelRequest: 应显式传入 seed 并在 prompt 中注入对应扰动 hash 与基础类型', () => {
  const seed = 20260315;
  const request = buildPartnerRecruitTextModelRequest({
    quality: '黄',
    seed,
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    quality?: string;
    promptNoiseHash?: string;
    baseModel?: string;
    constraints?: string[];
  };

  assert.equal(request.seed, seed);
  assert.equal(parsedUserMessage.quality, '黄');
  assert.equal(parsedUserMessage.promptNoiseHash, buildPartnerRecruitPromptNoiseHash(seed));
  assert.equal(request.baseModel, resolvePartnerRecruitBaseModelBySeed(seed));
  assert.equal(parsedUserMessage.baseModel, resolvePartnerRecruitBaseModelBySeed(seed));
  assert.equal(
    parsedUserMessage.constraints?.some((rule) => rule.includes('仅作为伙伴主体形态、种族特征、气质与文风倾向参考')) ?? false,
    false,
  );
});

test('buildPartnerRecruitTextModelRequest: 传入自定义底模时应优先使用玩家输入', () => {
  const request = buildPartnerRecruitTextModelRequest({
    quality: '黄',
    seed: 20260315,
    requestedBaseModel: '雪狐',
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    baseModel?: string;
    constraints?: string[];
  };

  assert.equal(request.requestedBaseModel, '雪狐');
  assert.equal(request.baseModel, '雪狐');
  assert.equal(parsedUserMessage.baseModel, '雪狐');
  assert.equal(
    parsedUserMessage.constraints?.includes('玩家指定的底模「雪狐」仅作为伙伴主体形态、种族特征、气质、文风与属性倾向参考，不得作为基础属性、成长数值、天生功法收益或整体强度的具体数值参考'),
    true,
  );
});

test('buildPartnerRecruitTextModelRequest: 自定义底模应携带“只认形态、不认强度诉求”的统一约束', () => {
  const request = buildPartnerRecruitTextModelRequest({
    quality: '地',
    seed: 20260315,
    requestedBaseModel: '千速',
  });
  const parsedUserMessage = JSON.parse(request.userMessage) as {
    baseModel?: string;
    constraints?: string[];
  };

  assert.equal(parsedUserMessage.baseModel, '千速');
  assert.equal(
    parsedUserMessage.constraints?.includes(
      '若底模中出现速度、攻击、血量、连击、暴击、护盾、回血、控制、无敌、秒杀等含义，可以提炼为仙侠世界中的外形意象、气质意象或战斗倾向，但禁止直接实现为极高速度、极高攻击、极高血量、离谱连击、必定暴击、无敌或秒杀等明显超出当前品质约束的数值与机制结果',
    ),
    true,
  );
});
