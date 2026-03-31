/**
 * 洞府研修保底与品质概率共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义洞府研修的品质权重、保底触发阈值、概率展示和成功生成时的实际品质决策。
 * 2. 做什么：让状态接口、创建任务与成功落草稿后的计数推进共用同一套纯函数，避免“面板显示一套、实际结果另一套”。
 * 3. 不做什么：不访问数据库、不处理冷却、不负责功法类型选择和草稿落库。
 *
 * 输入/输出：
 * - 输入：当前连续成功生成未出天的次数，以及可选运行环境。
 * - 输出：保底状态、品质概率表、下一次成功生成应使用的品质和成功后的新计数。
 *
 * 数据流/状态流：
 * characters.technique_research_generated_non_heaven_count -> 本模块 -> 状态接口 / 创建任务 -> 草稿成功后原子更新计数。
 *
 * 复用设计说明：
 * 1. 保底阈值、概率表和开发环境强制天阶都属于同一条高频变化业务规则，集中在这里后，服务层只需要读写计数。
 * 2. 当前由洞府研修状态接口、创建任务和成功落草稿流程复用；后续若主界面角标或活动面板也展示概率，可继续直接复用。
 *
 * 关键边界条件与坑点：
 * 1. 保底计数只统计“成功生成草稿但不是天阶”的结果；失败、退款、冷却豁免都不能推进计数。
 * 2. development 环境的强制天阶只允许在共享规则里统一生效，不能让调用方各自判断环境，否则测试和页面展示会再次分叉。
 */

export type TechniqueResearchQuality = '黄' | '玄' | '地' | '天';

export type TechniqueResearchQualityRateEntry = {
  quality: TechniqueResearchQuality;
  weight: number;
  rate: number;
};

export type TechniqueResearchHeavenGuaranteeState = {
  generatedNonHeavenCount: number;
  remainingUntilGuaranteedHeaven: number;
  isGuaranteedHeavenOnNextGeneratedDraft: boolean;
};

const QUALITY_ROLL_TABLE: ReadonlyArray<{
  quality: TechniqueResearchQuality;
  weight: number;
}> = [
  { quality: '黄', weight: 4 },
  { quality: '玄', weight: 3 },
  { quality: '地', weight: 2 },
  { quality: '天', weight: 1 },
] as const;

export const TECHNIQUE_RESEARCH_HEAVEN_GUARANTEE_TRIGGER_COUNT = 20;

const normalizeTechniqueResearchGeneratedNonHeavenCount = (raw: number): number => {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
};

export const shouldForceTechniqueResearchHeavenQuality = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean => {
  return nodeEnv === 'development';
};

export const resolveTechniqueResearchHeavenGuaranteeState = (
  generatedNonHeavenCount: number,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TechniqueResearchHeavenGuaranteeState => {
  const normalizedCount = normalizeTechniqueResearchGeneratedNonHeavenCount(generatedNonHeavenCount);
  if (shouldForceTechniqueResearchHeavenQuality(nodeEnv)) {
    return {
      generatedNonHeavenCount: normalizedCount,
      remainingUntilGuaranteedHeaven: 1,
      isGuaranteedHeavenOnNextGeneratedDraft: true,
    };
  }

  const guaranteeThreshold = TECHNIQUE_RESEARCH_HEAVEN_GUARANTEE_TRIGGER_COUNT - 1;
  return {
    generatedNonHeavenCount: normalizedCount,
    remainingUntilGuaranteedHeaven: Math.max(
      1,
      TECHNIQUE_RESEARCH_HEAVEN_GUARANTEE_TRIGGER_COUNT - normalizedCount,
    ),
    isGuaranteedHeavenOnNextGeneratedDraft: normalizedCount >= guaranteeThreshold,
  };
};

export const resolveTechniqueResearchQualityByWeight = (): TechniqueResearchQuality => {
  const totalWeight = QUALITY_ROLL_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
  let rolled = Math.random() * totalWeight;
  for (const entry of QUALITY_ROLL_TABLE) {
    rolled -= entry.weight;
    if (rolled <= 0) return entry.quality;
  }
  return '黄';
};

export const resolveTechniqueResearchQualityRateEntries = (
  generatedNonHeavenCount = 0,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TechniqueResearchQualityRateEntry[] => {
  const guaranteeState = resolveTechniqueResearchHeavenGuaranteeState(generatedNonHeavenCount, nodeEnv);
  if (guaranteeState.isGuaranteedHeavenOnNextGeneratedDraft) {
    return QUALITY_ROLL_TABLE.map((entry) => ({
      quality: entry.quality,
      weight: entry.quality === '天' ? entry.weight : 0,
      rate: entry.quality === '天' ? 100 : 0,
    }));
  }

  const totalWeight = QUALITY_ROLL_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
  return QUALITY_ROLL_TABLE.map((entry) => ({
    quality: entry.quality,
    weight: entry.weight,
    rate: totalWeight > 0 ? (entry.weight / totalWeight) * 100 : 0,
  }));
};

export const resolveTechniqueResearchQualityForGeneratedDraftSuccess = (
  generatedNonHeavenCount: number,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): TechniqueResearchQuality => {
  const guaranteeState = resolveTechniqueResearchHeavenGuaranteeState(generatedNonHeavenCount, nodeEnv);
  if (guaranteeState.isGuaranteedHeavenOnNextGeneratedDraft) {
    return '天';
  }
  return resolveTechniqueResearchQualityByWeight();
};

export const resolveTechniqueResearchGeneratedNonHeavenCountAfterSuccess = (
  currentGeneratedNonHeavenCount: number,
  quality: TechniqueResearchQuality,
): number => {
  if (quality === '天') {
    return 0;
  }
  return normalizeTechniqueResearchGeneratedNonHeavenCount(currentGeneratedNonHeavenCount) + 1;
};
