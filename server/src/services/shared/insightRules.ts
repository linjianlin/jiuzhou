/**
 * 悟道系统公式规则（纯函数）
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护悟道的成本、批量可支付等级、总加成百分比公式。
 * 2) 不做什么：不访问数据库、不读写缓存、不处理权限与事务。
 *
 * 输入/输出：
 * - 输入：当前等级、可用经验、请求注入等级数、悟道静态配置。
 * - 输出：单级成本、可注入等级、总加成百分比。
 *
 * 数据流/状态流：
 * insightService / characterComputedService -> 调用本文件纯函数 -> 基于配置得到可复用计算结果。
 *
 * 关键边界条件与坑点：
 * 1) level 采用 1-based（第1级对应首级消耗）；业务等级本身为 0-based（当前等级），调用时需 +1。
 * 2) 批量可注入计算按“逐级扣减”执行，确保与真实扣费一致，不做近似估算。
 * 3) 不再限制单次请求注入等级上限，requestedLevels 仅要求 > 0。
 */
import type { InsightGrowthConfig } from '../staticConfigLoader.js';

const clampToNonNegativeInteger = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

/**
 * 计算某一目标级别（1-based）的单级经验消耗。
 *
 * 公式说明：
 * - 前 `cost_stage_levels` 级单级成本固定为 `cost_stage_base_exp`；
 * - 每跨过一个完整分段，单级成本额外增加 `cost_stage_base_exp`。
 * - 例如 stage=50, base=500000：
 *   1~50 级每级 50 万；51~100 级每级 100 万；101~150 级每级 150 万。
 */
export const calcInsightCostByLevel = (level: number, config: InsightGrowthConfig): number => {
  const safeLevel = Math.max(1, Math.floor(level));
  const stageIndex = Math.floor((safeLevel - 1) / config.cost_stage_levels) + 1;
  const cost = config.cost_stage_base_exp * stageIndex;
  return clampToNonNegativeInteger(cost);
};

/**
 * 计算在“当前等级 + 注入等级数”条件下的总消耗。
 *
 * 参数说明：
 * - currentLevel：当前悟道等级（0-based）。
 * - injectLevels：计划注入等级数量。
 */
export const calcInsightTotalCost = (
  currentLevel: number,
  injectLevels: number,
  config: InsightGrowthConfig,
): number => {
  const safeCurrentLevel = clampToNonNegativeInteger(currentLevel);
  const safeInjectLevels = clampToNonNegativeInteger(injectLevels);
  if (safeInjectLevels <= 0) return 0;

  /**
   * 逐级累加，确保与真实注入扣费路径严格一致。
   * 说明：即便成本公式后续继续扩展高阶项，逐级累加也无需改动求和公式。
   */
  let total = 0;
  for (let i = 0; i < safeInjectLevels; i += 1) {
    const targetLevel = safeCurrentLevel + i + 1;
    total += calcInsightCostByLevel(targetLevel, config);
  }
  return clampToNonNegativeInteger(total);
};

/**
 * 按可用经验与请求等级，计算实际可注入等级数。
 */
export const calcAffordableInjectLevels = (
  currentLevel: number,
  availableExp: number,
  requestedLevels: number,
  config: InsightGrowthConfig,
): number => {
  const safeCurrentLevel = clampToNonNegativeInteger(currentLevel);
  let remainingExp = clampToNonNegativeInteger(availableExp);
  const safeRequestedLevels = Math.max(0, clampToNonNegativeInteger(requestedLevels));

  let affordable = 0;
  for (let i = 0; i < safeRequestedLevels; i += 1) {
    const nextLevel = safeCurrentLevel + i + 1;
    const levelCost = calcInsightCostByLevel(nextLevel, config);
    if (remainingExp < levelCost) break;
    remainingExp -= levelCost;
    affordable += 1;
  }
  return affordable;
};

/**
 * 计算某个悟道等级对应的总百分比加成（小数形式，如 0.01 表示 +1%）。
 */
export const buildInsightPctBonusByLevel = (level: number, config: InsightGrowthConfig): number => {
  const safeLevel = clampToNonNegativeInteger(level);
  return safeLevel * config.bonus_pct_per_level;
};
