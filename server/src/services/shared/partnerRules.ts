/**
 * 伙伴成长与打书共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中定义伙伴成长维度、升级消耗、面板结算与打书可覆盖规则，作为伙伴服务与战斗快照的唯一纯函数入口。
 * 2) 不做什么：不直接读写数据库，不处理 HTTP 参数，不消费物品。
 *
 * 输入/输出：
 * - 输入：伙伴基础配置、模板每级成长、等级、已学功法被动、经验注入预算、当前已学功法列表。
 * - 输出：伙伴属性快照、经验注入结算、可覆盖功法列表等纯数据结果。
 *
 * 数据流/状态流：
 * partnerService / battle-pve / main quest reward -> partnerRules -> 返回稳定规则结果 -> 调用方负责落库或构建 DTO。
 *
 * 关键边界条件与坑点：
 * 1) 伙伴等级无上限，但单级升级经验必须始终为正整数，否则会导致注入循环无法终止。
 * 2) 打书只能覆盖后天功法，因此“当前只有天生功法”必须明确判定为不可覆盖，不能静默回退。
 */
import type {
  PartnerBaseAttrConfig,
  PartnerGrowthConfig,
  PartnerTechniquePassiveConfig,
} from '../staticConfigLoader.js';
import { splitTechniquePassiveAttrs } from './techniquePassiveAttrs.js';

export const PARTNER_GROWTH_KEYS = [
  'max_qixue',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
] as const;

export type PartnerGrowthKey = (typeof PARTNER_GROWTH_KEYS)[number];

export type PartnerGrowthValues = Record<PartnerGrowthKey, number>;

export interface PartnerInjectPlan {
  spentExp: number;
  remainingCharacterExp: number;
  beforeLevel: number;
  afterLevel: number;
  beforeProgressExp: number;
  afterProgressExp: number;
  gainedLevels: number;
}

export interface PartnerLearnedTechniqueState {
  techniqueId: string;
  isInnate: boolean;
}

export const PARTNER_INTEGER_ATTR_KEYS = new Set<string>([
  'max_qixue',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
  'qixue_huifu',
  'lingqi_huifu',
]);

const normalizeInteger = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
};

const normalizeFiniteNumber = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
};

const cloneBaseAttrs = (
  baseAttrs: PartnerBaseAttrConfig,
): Record<string, number> => {
  return {
    max_qixue: normalizeFiniteNumber(baseAttrs.max_qixue),
    max_lingqi: normalizeFiniteNumber(baseAttrs.max_lingqi),
    wugong: normalizeFiniteNumber(baseAttrs.wugong),
    fagong: normalizeFiniteNumber(baseAttrs.fagong),
    wufang: normalizeFiniteNumber(baseAttrs.wufang),
    fafang: normalizeFiniteNumber(baseAttrs.fafang),
    sudu: normalizeFiniteNumber(baseAttrs.sudu),
    mingzhong: normalizeFiniteNumber(baseAttrs.mingzhong),
    shanbi: normalizeFiniteNumber(baseAttrs.shanbi),
    zhaojia: normalizeFiniteNumber(baseAttrs.zhaojia),
    baoji: normalizeFiniteNumber(baseAttrs.baoji),
    baoshang: normalizeFiniteNumber(baseAttrs.baoshang),
    jianbaoshang: normalizeFiniteNumber(baseAttrs.jianbaoshang),
    kangbao: normalizeFiniteNumber(baseAttrs.kangbao),
    zengshang: normalizeFiniteNumber(baseAttrs.zengshang),
    zhiliao: normalizeFiniteNumber(baseAttrs.zhiliao),
    jianliao: normalizeFiniteNumber(baseAttrs.jianliao),
    xixue: normalizeFiniteNumber(baseAttrs.xixue),
    lengque: normalizeFiniteNumber(baseAttrs.lengque),
    kongzhi_kangxing: normalizeFiniteNumber(baseAttrs.kongzhi_kangxing),
    jin_kangxing: normalizeFiniteNumber(baseAttrs.jin_kangxing),
    mu_kangxing: normalizeFiniteNumber(baseAttrs.mu_kangxing),
    shui_kangxing: normalizeFiniteNumber(baseAttrs.shui_kangxing),
    huo_kangxing: normalizeFiniteNumber(baseAttrs.huo_kangxing),
    tu_kangxing: normalizeFiniteNumber(baseAttrs.tu_kangxing),
    qixue_huifu: normalizeFiniteNumber(baseAttrs.qixue_huifu),
    lingqi_huifu: normalizeFiniteNumber(baseAttrs.lingqi_huifu),
  };
};

export const calcPartnerUpgradeExpByTargetLevel = (
  targetLevel: number,
  config: PartnerGrowthConfig,
): number => {
  const safeTargetLevel = Math.max(2, normalizeInteger(targetLevel));
  const levelOffset = Math.max(0, safeTargetLevel - 2);
  // 伙伴升级经验采用“起始经验 × 成长倍率^等级偏移”，让大基数配置也能自然拉开梯度。
  const rawCost =
    normalizeInteger(config.exp_base_exp) *
    Math.pow(normalizeFiniteNumber(config.exp_growth_rate), levelOffset);
  const normalizedCost = Math.floor(rawCost);
  if (normalizedCost <= 0) {
    throw new Error('伙伴升级配置异常：单级升级经验必须大于 0');
  }
  return normalizedCost;
};

export const resolvePartnerInjectPlan = (params: {
  beforeLevel: number;
  beforeProgressExp: number;
  characterExp: number;
  injectExpBudget: number;
  config: PartnerGrowthConfig;
}): PartnerInjectPlan => {
  const beforeLevel = Math.max(1, normalizeInteger(params.beforeLevel));
  const beforeProgressExp = normalizeInteger(params.beforeProgressExp);
  const characterExp = normalizeInteger(params.characterExp);
  const injectExpBudget = Math.min(
    characterExp,
    normalizeInteger(params.injectExpBudget),
  );

  let currentLevel = beforeLevel;
  let currentProgressExp = beforeProgressExp;
  let remainingBudget = injectExpBudget;
  let gainedLevels = 0;

  const currentLevelCost = calcPartnerUpgradeExpByTargetLevel(
    currentLevel + 1,
    params.config,
  );
  if (currentProgressExp >= currentLevelCost) {
    throw new Error('伙伴进度异常：当前等级经验已超过升级需求');
  }

  while (remainingBudget > 0) {
    const nextLevelCost = calcPartnerUpgradeExpByTargetLevel(
      currentLevel + 1,
      params.config,
    );
    const requiredExp = Math.max(0, nextLevelCost - currentProgressExp);
    if (requiredExp <= 0) {
      currentLevel += 1;
      currentProgressExp = 0;
      gainedLevels += 1;
      continue;
    }

    if (remainingBudget >= requiredExp) {
      remainingBudget -= requiredExp;
      currentLevel += 1;
      currentProgressExp = 0;
      gainedLevels += 1;
      continue;
    }

    currentProgressExp += remainingBudget;
    remainingBudget = 0;
  }

  const spentExp = injectExpBudget - remainingBudget;
  return {
    spentExp,
    remainingCharacterExp: Math.max(0, characterExp - spentExp),
    beforeLevel,
    afterLevel: currentLevel,
    beforeProgressExp,
    afterProgressExp: currentProgressExp,
    gainedLevels,
  };
};

export const mergePartnerTechniquePassives = (
  passiveGroups: PartnerTechniquePassiveConfig[][],
): Record<string, number> => {
  const merged: Record<string, number> = {};
  for (const group of passiveGroups) {
    for (const passive of group) {
      const key = String(passive.key || '').trim();
      if (!key) continue;
      const value = normalizeFiniteNumber(passive.value);
      merged[key] = normalizeFiniteNumber(merged[key]) + value;
    }
  }
  return merged;
};

export const buildPartnerBattleAttrs = (params: {
  baseAttrs: PartnerBaseAttrConfig;
  level: number;
  levelAttrGains?: Partial<PartnerBaseAttrConfig>;
  passiveAttrs?: Record<string, number>;
  element?: string;
}): Record<string, number | string | undefined> => {
  const base = cloneBaseAttrs(params.baseAttrs);
  const safeLevel = Math.max(1, normalizeInteger(params.level));
  const gainedLevels = Math.max(0, safeLevel - 1);
  const passiveAttrs = params.passiveAttrs ?? {};

  for (const [key, value] of Object.entries(params.levelAttrGains ?? {})) {
    const baseValue = normalizeFiniteNumber(base[key]);
    const levelGain = normalizeFiniteNumber(value);
    base[key] = baseValue + gainedLevels * levelGain;
  }

  const splitPassives = splitTechniquePassiveAttrs(passiveAttrs);

  for (const [key, value] of Object.entries(splitPassives.flatAdditive)) {
    base[key] = normalizeFiniteNumber(base[key]) + normalizeFiniteNumber(value);
  }

  for (const [key, value] of Object.entries(splitPassives.percentAdditive)) {
    base[key] = normalizeFiniteNumber(base[key]) + normalizeFiniteNumber(value);
  }

  for (const [key, value] of Object.entries(splitPassives.percentMultiply)) {
    const baseValue = normalizeFiniteNumber(base[key]);
    base[key] = Math.max(0, baseValue * (1 + normalizeFiniteNumber(value)));
  }

  return {
    ...base,
    element: params.element,
  };
};

export const listReplaceablePartnerTechniqueIds = (
  techniques: PartnerLearnedTechniqueState[],
  maxTechniqueSlots: number,
): string[] => {
  if (techniques.length < Math.max(0, normalizeInteger(maxTechniqueSlots))) {
    return [];
  }
  return techniques
    .filter((entry) => !entry.isInnate)
    .map((entry) => entry.techniqueId);
};
