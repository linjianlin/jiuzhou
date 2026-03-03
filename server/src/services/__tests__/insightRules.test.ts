import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInsightPctBonusByLevel,
  calcAffordableInjectLevels,
  calcInsightCostByLevel,
  calcInsightTotalCost,
} from '../shared/insightRules.js';
import type { InsightGrowthConfig } from '../staticConfigLoader.js';

const mockConfig: InsightGrowthConfig = {
  unlock_realm: '炼精化炁·养气期',
  cost_stage_levels: 50,
  cost_stage_base_exp: 500_000,
  bonus_pct_per_level: 0.0005,
};

test('calcInsightCostByLevel: 单级消耗按 50 级分段阶梯递增', () => {
  assert.equal(calcInsightCostByLevel(1, mockConfig), 500_000);
  assert.equal(calcInsightCostByLevel(50, mockConfig), 500_000);
  assert.equal(calcInsightCostByLevel(51, mockConfig), 1_000_000);
  assert.equal(calcInsightCostByLevel(100, mockConfig), 1_000_000);
  assert.equal(calcInsightCostByLevel(101, mockConfig), 1_500_000);
});

test('calcInsightTotalCost: 批量消耗与逐级求和一致', () => {
  const total = calcInsightTotalCost(0, 3, mockConfig);
  const expected = 500_000 + 500_000 + 500_000;
  assert.equal(total, expected);
});

test('calcAffordableInjectLevels: 在经验不足时按可支付等级截断', () => {
  const affordable = calcAffordableInjectLevels(0, 1_200_000, 10, mockConfig);
  assert.equal(affordable, 2);
});

test('calcAffordableInjectLevels: 批量等级不再受单次上限约束', () => {
  const affordable = calcAffordableInjectLevels(0, Number.MAX_SAFE_INTEGER, 500, mockConfig);
  assert.equal(affordable, 500);
});

test('buildInsightPctBonusByLevel: 百万经验投入收益约 0.1%', () => {
  const millionExpAffordableLevels = calcAffordableInjectLevels(0, 1_000_000, 100, mockConfig);
  const bonusPct = buildInsightPctBonusByLevel(millionExpAffordableLevels, mockConfig);
  assert.ok(Math.abs(bonusPct - 0.001) < 1e-12, `累计 100 万经验收益应在 0.1%，实际 bonusPct=${bonusPct}`);
});
