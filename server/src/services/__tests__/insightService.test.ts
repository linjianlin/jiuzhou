import test from 'node:test';
import assert from 'node:assert/strict';
import { isInsightUnlocked, resolveInsightInjectPlan } from '../insightService.js';
import type { InsightGrowthConfig } from '../staticConfigLoader.js';

const mockConfig: InsightGrowthConfig = {
  unlock_realm: '炼精化炁·养气期',
  cost_stage_levels: 50,
  cost_stage_base_exp: 500_000,
  bonus_pct_per_level: 0.0005,
};

test('isInsightUnlocked: 养气期及以上可解锁悟道', () => {
  assert.equal(isInsightUnlocked('凡人', null, mockConfig.unlock_realm), false);
  assert.equal(isInsightUnlocked('炼精化炁', '养气期', mockConfig.unlock_realm), true);
  assert.equal(isInsightUnlocked('炼精化炁·通脉期', null, mockConfig.unlock_realm), true);
});

test('resolveInsightInjectPlan: 经验不足时不产生注入等级', () => {
  const plan = resolveInsightInjectPlan({
    beforeLevel: 0,
    characterExp: 499_999,
    requestedLevels: 10,
    config: mockConfig,
  });

  assert.equal(plan.actualInjectedLevels, 0);
  assert.equal(plan.spentExp, 0);
  assert.equal(plan.afterLevel, 0);
  assert.equal(plan.remainingExp, 499_999);
});

test('resolveInsightInjectPlan: 请求超过可支付时按可支付等级结算', () => {
  const plan = resolveInsightInjectPlan({
    beforeLevel: 0,
    characterExp: 1_000_000,
    requestedLevels: 10,
    config: mockConfig,
  });

  assert.ok(plan.actualInjectedLevels > 0, '应至少注入 1 级');
  assert.ok(plan.actualInjectedLevels < 10, '应被可支付等级截断');
  assert.ok(plan.spentExp <= 1_000_000, '不应超额扣减经验');
  assert.equal(plan.beforeBonusPct < plan.afterBonusPct, true);
});
