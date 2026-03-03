/**
 * 悟道前端共享计算
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护悟道预估公式、批量输入约束、百分比文案格式化，避免桌面与移动端重复写同一逻辑。
 * 2) 做什么：所有成本与收益计算均使用服务端下发配置，确保前后端同一数据源。
 * 3) 不做什么：不发起网络请求、不直接操作 React 状态。
 *
 * 输入/输出：
 * - 输入：当前悟道等级、当前经验、用户输入等级、批量上限、悟道成长配置。
 * - 输出：预估可注入等级、预计消耗、预计收益、预计剩余经验。
 *
 * 数据流/状态流：
 * InsightPanel 输入变化 -> buildInsightInjectPreview -> UI 预览卡片。
 *
 * 关键边界条件与坑点：
 * 1) 单次注入等级必须在 [1, batchMaxLevels]，超界统一收敛，避免前后端规则漂移。
 * 2) 成本公式是“基础 + 线性 + 二次项”，总消耗采用逐级累加，必须与服务端扣费路径一致。
 */

export interface InsightGrowthFormulaConfig {
  costBaseExp: number;
  costStepExp: number;
  costQuadraticExp: number;
  bonusPctPerLevel: number;
}

export interface InsightInjectPreview {
  inputLevels: number;
  normalizedLevels: number;
  plannedInjectLevels: number;
  plannedSpentExp: number;
  plannedGainedBonusPct: number;
  plannedAfterLevel: number;
  plannedTotalBonusPct: number;
  actualInjectLevels: number;
  actualSpentExp: number;
  actualGainedBonusPct: number;
  actualAfterLevel: number;
  actualTotalBonusPct: number;
  remainingExp: number;
  nextLevelCostExp: number;
}

const toSafeInteger = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

export const clampInsightInjectLevels = (inputLevels: number, batchMaxLevels: number): number => {
  const max = Math.max(1, toSafeInteger(batchMaxLevels));
  const n = toSafeInteger(inputLevels);
  if (n <= 0) return 1;
  return Math.min(n, max);
};

/**
 * 计算指定等级（1-based）的单级消耗。
 * 公式：base + step * idx + quadratic * idx^2，idx = level - 1。
 */
export const calcInsightCostByLevel = (level: number, growth: InsightGrowthFormulaConfig): number => {
  const safeLevel = Math.max(1, toSafeInteger(level));
  const stepIndex = safeLevel - 1;
  const cost =
    growth.costBaseExp +
    growth.costStepExp * stepIndex +
    growth.costQuadraticExp * stepIndex * stepIndex;
  return toSafeInteger(cost);
};

/**
 * 计算从 currentLevel 开始注入 injectLevels 级的总消耗。
 * 这里采用逐级累加，确保与服务端实际扣费严格一致。
 */
export const calcInsightTotalCost = (
  currentLevel: number,
  injectLevels: number,
  growth: InsightGrowthFormulaConfig,
): number => {
  const safeCurrentLevel = toSafeInteger(currentLevel);
  const safeInjectLevels = toSafeInteger(injectLevels);
  if (safeInjectLevels <= 0) return 0;

  let total = 0;
  for (let i = 0; i < safeInjectLevels; i += 1) {
    const nextLevel = safeCurrentLevel + i + 1;
    total += calcInsightCostByLevel(nextLevel, growth);
  }
  return toSafeInteger(total);
};

export const calcAffordableInsightLevels = (
  currentLevel: number,
  characterExp: number,
  requestedLevels: number,
  batchMaxLevels: number,
  growth: InsightGrowthFormulaConfig,
): number => {
  const safeCurrentLevel = toSafeInteger(currentLevel);
  let remainingExp = toSafeInteger(characterExp);
  const cappedRequestedLevels = clampInsightInjectLevels(requestedLevels, batchMaxLevels);

  let affordable = 0;
  for (let i = 0; i < cappedRequestedLevels; i += 1) {
    const nextLevel = safeCurrentLevel + i + 1;
    const levelCost = calcInsightCostByLevel(nextLevel, growth);
    if (remainingExp < levelCost) break;
    remainingExp -= levelCost;
    affordable += 1;
  }
  return affordable;
};

export const buildInsightBonusPctByLevel = (level: number, bonusPctPerLevel: number): number => {
  return toSafeInteger(level) * bonusPctPerLevel;
};

export const buildInsightInjectPreview = (params: {
  currentLevel: number;
  characterExp: number;
  inputLevels: number;
  batchMaxLevels: number;
  growth: InsightGrowthFormulaConfig;
}): InsightInjectPreview => {
  const { currentLevel, characterExp, inputLevels, batchMaxLevels, growth } = params;
  const safeCurrentLevel = toSafeInteger(currentLevel);
  const normalizedLevels = clampInsightInjectLevels(inputLevels, batchMaxLevels);
  const plannedInjectLevels = normalizedLevels;
  const plannedSpentExp = calcInsightTotalCost(safeCurrentLevel, plannedInjectLevels, growth);
  const plannedAfterLevel = safeCurrentLevel + plannedInjectLevels;
  const plannedTotalBonusPct = buildInsightBonusPctByLevel(plannedAfterLevel, growth.bonusPctPerLevel);
  const plannedGainedBonusPct =
    plannedTotalBonusPct - buildInsightBonusPctByLevel(safeCurrentLevel, growth.bonusPctPerLevel);

  const actualInjectLevels = calcAffordableInsightLevels(
    currentLevel,
    characterExp,
    normalizedLevels,
    batchMaxLevels,
    growth,
  );
  const actualSpentExp = calcInsightTotalCost(safeCurrentLevel, actualInjectLevels, growth);
  const actualAfterLevel = safeCurrentLevel + actualInjectLevels;
  const actualTotalBonusPct = buildInsightBonusPctByLevel(actualAfterLevel, growth.bonusPctPerLevel);
  const actualGainedBonusPct =
    actualTotalBonusPct - buildInsightBonusPctByLevel(safeCurrentLevel, growth.bonusPctPerLevel);
  const remainingExp = Math.max(0, toSafeInteger(characterExp) - actualSpentExp);

  return {
    inputLevels: toSafeInteger(inputLevels),
    normalizedLevels,
    plannedInjectLevels,
    plannedSpentExp,
    plannedGainedBonusPct,
    plannedAfterLevel,
    plannedTotalBonusPct,
    actualInjectLevels,
    actualSpentExp,
    actualGainedBonusPct,
    actualAfterLevel,
    actualTotalBonusPct,
    remainingExp,
    nextLevelCostExp: calcInsightCostByLevel(actualAfterLevel + 1, growth),
  };
};

export const shouldConfirmInsightInject = (spentExp: number, threshold: number): boolean => {
  return toSafeInteger(spentExp) >= Math.max(1, toSafeInteger(threshold));
};

export const formatInsightPctText = (pct: number): string => {
  return `${(Math.max(0, pct) * 100).toFixed(2)}%`;
};
