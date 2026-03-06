/**
 * 配方概率换算工具
 *
 * 作用：
 * - 统一处理不同配方类型的成功率/返还率口径，避免同一份配置在不同服务里各自判断
 * - 约束配方概率的单一数据源：`gem_synthesis` 使用 0~1 小数，其余配方使用 0~100 百分数
 *
 * 输入/输出：
 * - 输入：原始配置值、配方类型、默认比例值（默认值始终使用 0~1 比例语义）
 * - 输出：标准化后的比例值（0~1）或百分比值（0~100）
 *
 * 数据流：
 * - 原始配置 -> 按 recipeType 识别口径 -> 换算为 0~1 比例 -> 业务层按需转成百分比显示/概率判定
 *
 * 关键边界条件与坑点：
 * 1) `gem_synthesis` 配置明确使用 0~1 小数，不能再走 0~100 百分数逻辑，否则 0.85 会被当成 0.85%
 * 2) 默认值也统一按比例语义传入，避免调用方把 100/0 这类不同量纲的值混进来
 */

const GEM_SYNTHESIS_RECIPE_TYPE = 'gem_synthesis';

const clampRateRatio = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const toFiniteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isRatioRecipeType = (recipeType: string): boolean => {
  return recipeType.trim() === GEM_SYNTHESIS_RECIPE_TYPE;
};

export const normalizeRecipeRateToRatio = (
  value: unknown,
  recipeType: string,
  fallbackRatio: number,
): number => {
  const parsed = toFiniteNumber(value);
  const safeFallback = clampRateRatio(fallbackRatio);
  if (parsed === null) return safeFallback;

  if (isRatioRecipeType(recipeType)) {
    return clampRateRatio(parsed);
  }
  return clampRateRatio(parsed / 100);
};

export const normalizeRecipeRateToPercent = (
  value: unknown,
  recipeType: string,
  fallbackRatio: number,
): number => {
  const normalizedRatio = normalizeRecipeRateToRatio(value, recipeType, fallbackRatio);
  return Math.round(normalizedRatio * 10000) / 100;
};
