import { describe, expect, it } from 'vitest';
import {
  buildInsightInjectPreview,
  calcAffordableInsightLevels,
  calcInsightCostByLevel,
  calcInsightTotalCost,
  type InsightGrowthFormulaConfig,
  shouldConfirmInsightInject,
} from '../insightShared';

const mockGrowth: InsightGrowthFormulaConfig = {
  costBaseExp: 100_000,
  costStepExp: 20_000,
  costQuadraticExp: 3_000,
  bonusPctPerLevel: 0.0005,
};

describe('insightShared', () => {
  it('calcInsightCostByLevel: 单级消耗按二次公式递增', () => {
    expect(calcInsightCostByLevel(1, mockGrowth)).toBe(100_000);
    expect(calcInsightCostByLevel(2, mockGrowth)).toBe(123_000);
    expect(calcInsightCostByLevel(10, mockGrowth)).toBe(523_000);
  });

  it('calcInsightTotalCost: 批量消耗与逐级求和一致', () => {
    const total = calcInsightTotalCost(0, 3, mockGrowth);
    expect(total).toBe(100_000 + 123_000 + 152_000);
  });

  it('calcAffordableInsightLevels: 经验不足时按可支付等级截断', () => {
    const affordable = calcAffordableInsightLevels(0, 200_000, 10, 100, mockGrowth);
    expect(affordable).toBe(1);
  });

  it('buildInsightInjectPreview: 预估值应自洽', () => {
    const preview = buildInsightInjectPreview({
      currentLevel: 0,
      characterExp: 1_000_000,
      inputLevels: 10,
      batchMaxLevels: 100,
      growth: mockGrowth,
    });

    expect(preview.actualInjectLevels).toBeGreaterThan(0);
    expect(preview.actualInjectLevels).toBeLessThan(10);
    expect(preview.plannedInjectLevels).toBe(10);
    expect(preview.plannedSpentExp).toBe(calcInsightTotalCost(0, 10, mockGrowth));
    expect(preview.actualSpentExp).toBeLessThanOrEqual(1_000_000);
    expect(preview.remainingExp).toBe(1_000_000 - preview.actualSpentExp);
    expect(preview.plannedGainedBonusPct).toBeGreaterThan(0);
  });

  it('shouldConfirmInsightInject: 达到阈值才触发确认', () => {
    expect(shouldConfirmInsightInject(99_999, 100_000)).toBe(false);
    expect(shouldConfirmInsightInject(100_000, 100_000)).toBe(true);
    expect(shouldConfirmInsightInject(120_000, 100_000)).toBe(true);
  });
});
