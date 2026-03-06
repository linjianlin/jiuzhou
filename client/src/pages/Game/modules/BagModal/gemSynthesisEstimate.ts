import type { GemSynthesisRecipeDto } from '../../../../services/api';

/**
 * 宝石快捷合成预估工具
 *
 * 作用：
 * - 集中维护“快捷合成”预估产出与货币消耗逻辑，避免弹窗组件内重复堆叠业务计算
 * - 为 UI 展示和后续测试提供单一入口，降低成功率口径被改坏的风险
 *
 * 输入/输出：
 * - 输入：同系列宝石配方列表、目标等级、当前钱包
 * - 输出：预估的各等级余量/产出，以及总银两/灵石消耗
 *
 * 数据流：
 * - 配方列表按 fromLevel 建索引 -> 逐级计算可合成次数 -> 按成功率换算期望产出 -> 累加到下一等级材料池
 *
 * 关键边界条件与坑点：
 * 1) successRate 使用 0~1 概率语义，不能把 0.85 当成 0.85 次成功或 0.85%
 * 2) 某一级缺配方时直接终止并返回空预估，不做兜底跨级推导
 */

export interface BatchEstimate {
  /** 各等级预估产出/余量，level 升序；最后一项为目标等级产出，其余为中间余量 */
  byLevel: Array<{ level: number; count: number }>;
  /** 预估消耗银两 */
  silver: number;
  /** 预估消耗灵石 */
  spiritStones: number;
}

export const EMPTY_BATCH_ESTIMATE: BatchEstimate = { byLevel: [], silver: 0, spiritStones: 0 };

const roundEstimateCount = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
};

const calculateExpectedOutputQty = (times: number, recipe: GemSynthesisRecipeDto): number => {
  return roundEstimateCount(times * recipe.successRate * recipe.output.qty);
};

export const estimateBatchOutput = (
  seriesRecipes: GemSynthesisRecipeDto[],
  targetLevel: number,
  wallet: { silver: number; spiritStones: number } | null,
): BatchEstimate => {
  if (!wallet || seriesRecipes.length === 0 || targetLevel < 2) return EMPTY_BATCH_ESTIMATE;

  const recipeByFromLevel = new Map<number, GemSynthesisRecipeDto>();
  for (const recipe of seriesRecipes) {
    if (!recipeByFromLevel.has(recipe.fromLevel)) {
      recipeByFromLevel.set(recipe.fromLevel, recipe);
    }
  }

  let carry = 0;
  let remainingSilver = wallet.silver;
  let remainingSpiritStones = wallet.spiritStones;
  let totalSilver = 0;
  let totalSpiritStones = 0;
  const byLevel: Array<{ level: number; count: number }> = [];

  for (let fromLevel = 1; fromLevel < targetLevel; fromLevel += 1) {
    const recipe = recipeByFromLevel.get(fromLevel);
    if (!recipe) return EMPTY_BATCH_ESTIMATE;

    const available = recipe.input.owned + carry;
    const maxByGems = recipe.input.qty > 0 ? Math.floor(available / recipe.input.qty) : 0;
    const maxBySilver = recipe.costs.silver > 0 ? Math.floor(remainingSilver / recipe.costs.silver) : maxByGems;
    const maxBySpirit =
      recipe.costs.spiritStones > 0
        ? Math.floor(remainingSpiritStones / recipe.costs.spiritStones)
        : maxByGems;
    const times = Math.max(0, Math.min(maxByGems, maxBySilver, maxBySpirit));

    const consumed = times * recipe.input.qty;
    const remainder = roundEstimateCount(available - consumed);
    if (remainder > 0) {
      byLevel.push({ level: fromLevel, count: remainder });
    }

    const silverCost = times * recipe.costs.silver;
    const spiritCost = times * recipe.costs.spiritStones;
    remainingSilver -= silverCost;
    remainingSpiritStones -= spiritCost;
    totalSilver += silverCost;
    totalSpiritStones += spiritCost;

    carry = calculateExpectedOutputQty(times, recipe);
    if (carry <= 0) {
      return { byLevel, silver: totalSilver, spiritStones: totalSpiritStones };
    }
  }

  if (carry > 0) {
    byLevel.push({ level: targetLevel, count: roundEstimateCount(carry) });
  }

  return { byLevel, silver: totalSilver, spiritStones: totalSpiritStones };
};
