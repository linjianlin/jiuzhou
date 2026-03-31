/**
 * 洞府研修保底共享规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证洞府研修的保底阈值、概率展示、开发环境强制天阶以及成功后计数推进都来自同一套纯函数。
 * 2. 做什么：锁定状态接口展示概率与建单实际品质必须共用同一规则来源，避免后续再写散。
 * 3. 不做什么：不连接数据库、不覆盖任务创建和草稿落库，只验证共享规则模块。
 *
 * 输入/输出：
 * - 输入：连续成功生成未出天次数、运行环境、成功产出品质。
 * - 输出：保底状态、品质概率表、下一次品质与新计数。
 *
 * 数据流/状态流：
 * characters.technique_research_generated_non_heaven_count -> techniqueResearchGuarantee -> 状态接口 / 创建任务 / 成功后计数更新。
 *
 * 关键边界条件与坑点：
 * 1. 保底只在“下一次成功生成草稿”生效，失败和退款不能提前把计数清零或推进。
 * 2. development 环境下的强制天阶必须与概率展示同步，否则会出现“面板不是 100%，实际却必出天”的错位。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveTechniqueResearchGeneratedNonHeavenCountAfterSuccess,
  resolveTechniqueResearchHeavenGuaranteeState,
  resolveTechniqueResearchQualityForGeneratedDraftSuccess,
  resolveTechniqueResearchQualityRateEntries,
  shouldForceTechniqueResearchHeavenQuality,
} from '../shared/techniqueResearchGuarantee.js';

test('resolveTechniqueResearchQualityRateEntries: 应输出与当前权重同源的品质概率表', () => {
  assert.deepEqual(resolveTechniqueResearchQualityRateEntries(), [
    { quality: '黄', weight: 4, rate: 40 },
    { quality: '玄', weight: 3, rate: 30 },
    { quality: '地', weight: 2, rate: 20 },
    { quality: '天', weight: 1, rate: 10 },
  ]);
});

test('resolveTechniqueResearchHeavenGuaranteeState: 连续 19 次成功生成未出天后，下次应进入保底态', () => {
  assert.deepEqual(resolveTechniqueResearchHeavenGuaranteeState(19), {
    generatedNonHeavenCount: 19,
    remainingUntilGuaranteedHeaven: 1,
    isGuaranteedHeavenOnNextGeneratedDraft: true,
  });
});

test('shouldForceTechniqueResearchHeavenQuality: 仅 development 环境应开启本地必出天阶', () => {
  assert.equal(shouldForceTechniqueResearchHeavenQuality('development'), true);
  assert.equal(shouldForceTechniqueResearchHeavenQuality('test'), false);
  assert.equal(shouldForceTechniqueResearchHeavenQuality('production'), false);
  assert.equal(shouldForceTechniqueResearchHeavenQuality(undefined), false);
});

test('resolveTechniqueResearchHeavenGuaranteeState: development 环境下应统一视为下次必出天阶', () => {
  assert.deepEqual(resolveTechniqueResearchHeavenGuaranteeState(0, 'development'), {
    generatedNonHeavenCount: 0,
    remainingUntilGuaranteedHeaven: 1,
    isGuaranteedHeavenOnNextGeneratedDraft: true,
  });
});

test('resolveTechniqueResearchQualityRateEntries: 保底态下应只展示天阶 100% 概率', () => {
  assert.deepEqual(resolveTechniqueResearchQualityRateEntries(19), [
    { quality: '黄', weight: 0, rate: 0 },
    { quality: '玄', weight: 0, rate: 0 },
    { quality: '地', weight: 0, rate: 0 },
    { quality: '天', weight: 1, rate: 100 },
  ]);
});

test('resolveTechniqueResearchQualityForGeneratedDraftSuccess: 保底态下成功生成时应直接产出天阶', () => {
  assert.equal(resolveTechniqueResearchQualityForGeneratedDraftSuccess(19), '天');
});

test('resolveTechniqueResearchGeneratedNonHeavenCountAfterSuccess: 非天成功生成应累计，天阶成功生成应重置', () => {
  assert.equal(resolveTechniqueResearchGeneratedNonHeavenCountAfterSuccess(18, '地'), 19);
  assert.equal(resolveTechniqueResearchGeneratedNonHeavenCountAfterSuccess(19, '天'), 0);
});
