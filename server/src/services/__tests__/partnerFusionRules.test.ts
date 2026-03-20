/**
 * 三魂归契品级概率规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住三魂归契 5% 降品 / 85% 同品 / 10% 升品的核心权重规则。
 * 2. 做什么：验证黄/天边界会把无效升降概率并回同品级，保证前后端概率展示与实际抽取一致。
 * 3. 不做什么：不访问数据库、不创建任务，也不测试 worker 异步链路。
 *
 * 输入/输出：
 * - 输入：源品级与受控随机值。
 * - 输出：品级权重列表，以及一次抽取后的目标品级。
 *
 * 数据流/状态流：
 * 三魂归契发起 -> partnerFusionRules -> partner_fusion_job.result_quality -> AI 伙伴生成。
 *
 * 关键边界条件与坑点：
 * 1. 黄品不能降、天品不能升；边界概率必须并回同品级，否则总权重会丢失。
 * 2. 抽取函数必须复用同一份权重表，不能让展示概率和实际结果出现分叉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolvePartnerFusionQualityWeights,
  rollPartnerFusionResultQuality,
} from '../shared/partnerFusionRules.js';

test('resolvePartnerFusionQualityWeights: 玄品应保持 5/85/10 的标准权重', () => {
  assert.deepEqual(resolvePartnerFusionQualityWeights('玄'), [
    { quality: '黄', weight: 5 },
    { quality: '玄', weight: 85 },
    { quality: '地', weight: 10 },
  ]);
});

test('resolvePartnerFusionQualityWeights: 黄品应把降品概率并回同品级', () => {
  assert.deepEqual(resolvePartnerFusionQualityWeights('黄'), [
    { quality: '黄', weight: 90 },
    { quality: '玄', weight: 10 },
  ]);
});

test('resolvePartnerFusionQualityWeights: 天品应把升品概率并回同品级', () => {
  assert.deepEqual(resolvePartnerFusionQualityWeights('天'), [
    { quality: '地', weight: 5 },
    { quality: '天', weight: 95 },
  ]);
});

test('rollPartnerFusionResultQuality: 应按权重区间返回对应品级', () => {
  assert.equal(rollPartnerFusionResultQuality('玄', 0.00), '黄');
  assert.equal(rollPartnerFusionResultQuality('玄', 0.049), '黄');
  assert.equal(rollPartnerFusionResultQuality('玄', 0.05), '玄');
  assert.equal(rollPartnerFusionResultQuality('玄', 0.899), '玄');
  assert.equal(rollPartnerFusionResultQuality('玄', 0.90), '地');
  assert.equal(rollPartnerFusionResultQuality('玄', 0.999), '地');
});
