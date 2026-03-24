import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPartnerBattleAttrs,
  calcPartnerUpgradeExpByTargetLevel,
  resolvePartnerInjectPlan,
} from '../shared/partnerRules.js';
import type { PartnerGrowthConfig } from '../staticConfigLoader.js';

const mockConfig: PartnerGrowthConfig = {
  exp_base_exp: 1000,
  exp_growth_rate: 1.15,
};

test('calcPartnerUpgradeExpByTargetLevel: 伙伴升级经验随目标等级递增', () => {
  assert.equal(calcPartnerUpgradeExpByTargetLevel(2, mockConfig), 1000);
  assert.equal(calcPartnerUpgradeExpByTargetLevel(3, mockConfig), 1150);
  assert.equal(calcPartnerUpgradeExpByTargetLevel(4, mockConfig), 1322);
  assert.equal(calcPartnerUpgradeExpByTargetLevel(10, mockConfig), 3059);
});

test('resolvePartnerInjectPlan: 单次灌注可跨多级并保留剩余进度', () => {
  const plan = resolvePartnerInjectPlan({
    beforeLevel: 1,
    beforeProgressExp: 0,
    characterExp: 200,
    injectExpBudget: 200,
    config: mockConfig,
  });

  assert.equal(plan.spentExp, 200);
  assert.equal(plan.afterLevel, 4);
  assert.equal(plan.afterProgressExp, 51);
  assert.equal(plan.gainedLevels, 3);
  assert.equal(plan.remainingCharacterExp, 0);
});

test('resolvePartnerInjectPlan: 经验不足时仅累加当前级进度', () => {
  const plan = resolvePartnerInjectPlan({
    beforeLevel: 5,
    beforeProgressExp: 10,
    characterExp: 20,
    injectExpBudget: 20,
    config: mockConfig,
  });

  assert.equal(plan.afterLevel, 5);
  assert.equal(plan.afterProgressExp, 30);
  assert.equal(plan.gainedLevels, 0);
  assert.equal(plan.remainingCharacterExp, 0);
});

test('resolvePartnerInjectPlan: 命中等级上限时应停止继续升级', () => {
  const plan = resolvePartnerInjectPlan({
    beforeLevel: 8,
    beforeProgressExp: 0,
    characterExp: 10_000,
    injectExpBudget: 10_000,
    config: mockConfig,
    maxLevel: 10,
  });

  assert.equal(plan.afterLevel, 10);
  assert.equal(plan.afterProgressExp, 0);
  assert.equal(plan.gainedLevels, 2);
  assert.equal(plan.spentExp, 6571);
  assert.equal(plan.remainingCharacterExp, 3429);
});

test('buildPartnerBattleAttrs: 功法百分比被动应体现在伙伴面板主属性上', () => {
  const attrs = buildPartnerBattleAttrs({
    baseAttrs: {
      max_qixue: 220,
      max_lingqi: 60,
      wugong: 60,
      fagong: 40,
      wufang: 25,
      fafang: 30,
      sudu: 2,
      mingzhong: 0.9,
      shanbi: 0,
      zhaojia: 0.1,
      baoji: 0.05,
      baoshang: 1.5,
      jianbaoshang: 0,
      jianfantan: 0,
      kangbao: 0.02,
      zengshang: 0,
      zhiliao: 0,
      jianliao: 0,
      xixue: 0,
      lengque: 0,
      kongzhi_kangxing: 0,
      jin_kangxing: 0,
      mu_kangxing: 0,
      shui_kangxing: 0,
      huo_kangxing: 0,
      tu_kangxing: 0,
      qixue_huifu: 2,
      lingqi_huifu: 1,
    },
    level: 1,
    passiveAttrs: {
      max_qixue: 0.1,
      wugong: 0.2,
      wufang: 0.4,
      baoji: 0.05,
      sudu: 3,
    },
    element: 'mu',
  });

  assert.equal(attrs.max_qixue, 242);
  assert.equal(attrs.wugong, 72);
  assert.equal(attrs.wufang, 35);
  assert.equal(attrs.baoji, 0.1);
  assert.equal(attrs.sudu, 5);
});
