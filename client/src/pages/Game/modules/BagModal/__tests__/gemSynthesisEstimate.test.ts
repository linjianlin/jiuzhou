import { describe, expect, it } from 'vitest';
import type { GemSynthesisRecipeDto } from '../../../../../services/api';
import { estimateBatchOutput } from '../gemSynthesisEstimate';

const createRecipe = (params: {
  recipeId: string;
  fromLevel: number;
  toLevel: number;
  inputOwned: number;
  inputQty?: number;
  outputQty?: number;
  successRate: number;
  silver?: number;
  spiritStones?: number;
}): GemSynthesisRecipeDto => ({
  recipeId: params.recipeId,
  name: `${params.fromLevel}级 -> ${params.toLevel}级`,
  gemType: 'attack',
  seriesKey: 'flame',
  fromLevel: params.fromLevel,
  toLevel: params.toLevel,
  input: {
    itemDefId: `gem-atk-flame-${params.fromLevel}`,
    name: `${params.fromLevel}级宝石`,
    icon: null,
    qty: params.inputQty ?? 3,
    owned: params.inputOwned,
  },
  output: {
    itemDefId: `gem-atk-flame-${params.toLevel}`,
    name: `${params.toLevel}级宝石`,
    icon: null,
    qty: params.outputQty ?? 1,
  },
  costs: {
    silver: params.silver ?? 0,
    spiritStones: params.spiritStones ?? 0,
  },
  successRate: params.successRate,
  maxSynthesizeTimes: 999,
  canSynthesize: true,
});

describe('gemSynthesisEstimate', () => {
  it('单次 85% 成功率时，目标等级预估应保留 0.85 而不是被截断为 0', () => {
    const estimate = estimateBatchOutput(
      [
        createRecipe({
          recipeId: 'gem-synth-atk-flame-5',
          fromLevel: 5,
          toLevel: 6,
          inputOwned: 3,
          successRate: 0.85,
        }),
      ],
      6,
      { silver: 0, spiritStones: 0 },
    );

    expect(estimate.byLevel).toStrictEqual([{ level: 6, count: 0.85 }]);
  });

  it('逐级预估时应把上一级期望产出继续作为下一级材料', () => {
    const estimate = estimateBatchOutput(
      [
        createRecipe({
          recipeId: 'gem-synth-atk-flame-5',
          fromLevel: 5,
          toLevel: 6,
          inputOwned: 6,
          successRate: 0.85,
        }),
        createRecipe({
          recipeId: 'gem-synth-atk-flame-6',
          fromLevel: 6,
          toLevel: 7,
          inputOwned: 0,
          successRate: 0.7,
        }),
      ],
      7,
      { silver: 0, spiritStones: 0 },
    );

    expect(estimate.byLevel).toStrictEqual([{ level: 7, count: 0.47 }]);
  });
});
