/**
 * 自动分解规则归一化与匹配
 *
 * 目标：
 * - 将客户端提交/数据库存储的规则标准化
 * - 提供统一匹配函数，供战斗掉落、秘境结算等自动分解入口复用
 */
import { clampQualityRank } from './equipmentDisassembleRules.js';
import { normalizeMarketCategoryFilter, resolveMarketItemCategory } from './shared/marketItemCategory.js';

export interface AutoDisassembleRuleSet {
  categories: string[];
  subCategories: string[];
  excludedSubCategories: string[];
  includeNameKeywords: string[];
  excludeNameKeywords: string[];
  /** 该规则允许自动分解的最高品质（1黄/2玄/3地/4天），品质超过此值则不命中 */
  maxQualityRank: number;
}

export interface AutoDisassembleSetting {
  enabled: boolean;
  rules: AutoDisassembleRuleSet[];
}

export interface AutoDisassembleCandidateMeta {
  itemName: string;
  category: string;
  subCategory: string | null;
  effectDefs?: unknown;
  qualityRank: number;
}

const normalizeCategoryToken = (raw: unknown): string => {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'skillbook' || value === 'technique' || value === 'technique_book') return 'skill';
  const normalizedByMarket = normalizeMarketCategoryFilter(value);
  if (normalizedByMarket && normalizedByMarket !== 'all') {
    if (normalizedByMarket === 'skillbook') return 'skill';
    return normalizedByMarket;
  }
  return value;
};

const normalizeCategoryList = (raw: unknown, maxSize: number = 100): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const normalized = normalizeCategoryToken(row);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxSize) break;
  }
  return out;
};

const toEffectDefsArray = (raw: unknown): unknown[] | undefined => {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  return undefined;
};

const normalizeStringList = (raw: unknown, maxSize: number = 100): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const value = String(row ?? '').trim().toLowerCase();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxSize) break;
  }
  return out;
};

const normalizeKeywordList = (raw: unknown, maxSize: number = 100): string[] => {
  return normalizeStringList(raw, maxSize);
};

const DEFAULT_AUTO_DISASSEMBLE_RULE_SET: AutoDisassembleRuleSet = {
  categories: ['equipment'],
  subCategories: [],
  excludedSubCategories: [],
  includeNameKeywords: [],
  excludeNameKeywords: [],
  maxQualityRank: 1,
};

const createDefaultAutoDisassembleRuleSet = (): AutoDisassembleRuleSet => {
  return {
    categories: [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.categories],
    subCategories: [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.subCategories],
    excludedSubCategories: [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.excludedSubCategories],
    includeNameKeywords: [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.includeNameKeywords],
    excludeNameKeywords: [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.excludeNameKeywords],
    maxQualityRank: DEFAULT_AUTO_DISASSEMBLE_RULE_SET.maxQualityRank,
  };
};

/**
 * 归一化规则：
 * - 未配置 categories 时默认仅自动分解装备（保持现有行为）
 * - 其他数组规则统一去重并限制长度
 * - 名称关键词统一按小写匹配，便于大小写无关检索
 */
export const normalizeAutoDisassembleRuleSet = (raw: unknown): AutoDisassembleRuleSet => {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const categories = normalizeCategoryList(record.categories);
  const subCategories = normalizeStringList(record.subCategories);
  const excludedSubCategories = normalizeStringList(record.excludedSubCategories);
  const includeNameKeywords = normalizeKeywordList(record.includeNameKeywords);
  const excludeNameKeywords = normalizeKeywordList(record.excludeNameKeywords);

  return {
    categories: categories.length > 0 ? categories : [...DEFAULT_AUTO_DISASSEMBLE_RULE_SET.categories],
    subCategories,
    excludedSubCategories,
    includeNameKeywords,
    excludeNameKeywords,
    maxQualityRank: clampQualityRank(record.maxQualityRank, 1),
  };
};

const normalizeAutoDisassembleRuleSetList = (raw: unknown, maxSize: number = 20): AutoDisassembleRuleSet[] => {
  if (!Array.isArray(raw)) return [createDefaultAutoDisassembleRuleSet()];
  const out: AutoDisassembleRuleSet[] = [];
  for (const row of raw) {
    if (out.length >= maxSize) break;
    out.push(normalizeAutoDisassembleRuleSet(row));
  }
  if (out.length <= 0) {
    return [createDefaultAutoDisassembleRuleSet()];
  }
  return out;
};

export const normalizeAutoDisassembleSetting = (raw: {
  enabled?: unknown;
  rules?: unknown;
}): AutoDisassembleSetting => {
  return {
    enabled: Boolean(raw.enabled),
    rules: normalizeAutoDisassembleRuleSetList(raw.rules),
  };
};

const matchesRuleSet = (ruleSet: AutoDisassembleRuleSet, meta: AutoDisassembleCandidateMeta): boolean => {
  const rawCategory = String(meta.category || '').trim().toLowerCase();
  const normalizedCategory = normalizeCategoryToken(rawCategory);
  const subCategory = String(meta.subCategory || '').trim().toLowerCase();
  const itemName = String(meta.itemName || '').trim().toLowerCase();
  const candidateCategorySet = new Set<string>();
  if (normalizedCategory) candidateCategorySet.add(normalizedCategory);
  if (rawCategory) candidateCategorySet.add(rawCategory);

  const resolvedMarketCategory = resolveMarketItemCategory({
    category: rawCategory,
    sub_category: subCategory || undefined,
    effect_defs: toEffectDefsArray(meta.effectDefs),
  });
  // 历史功法书常见为 category=consumable + sub_category=technique_book，
  // 规则层统一按 skill 匹配，兼容老数据中的 skillbook 值。
  if (resolvedMarketCategory === 'skillbook') {
    candidateCategorySet.add('skill');
  }

  const ruleCategories = ruleSet.categories.map((value) => normalizeCategoryToken(value)).filter((value) => value.length > 0);

  // 品质判断：物品品质超过该规则的最高品质阈值则不命中
  const qualityRank = Number(meta.qualityRank);
  if (Number.isInteger(qualityRank) && qualityRank > 0 && qualityRank > ruleSet.maxQualityRank) {
    return false;
  }

  if (ruleCategories.length > 0 && !ruleCategories.some((category) => candidateCategorySet.has(category))) {
    return false;
  }

  if (ruleSet.subCategories.length > 0 && !ruleSet.subCategories.includes(subCategory)) {
    return false;
  }

  if (ruleSet.excludedSubCategories.includes(subCategory)) {
    return false;
  }

  if (
    ruleSet.includeNameKeywords.length > 0 &&
    !ruleSet.includeNameKeywords.some((keyword) => itemName.includes(keyword))
  ) {
    return false;
  }

  if (ruleSet.excludeNameKeywords.some((keyword) => itemName.includes(keyword))) {
    return false;
  }

  return true;
};

export const shouldAutoDisassembleBySetting = (
  setting: AutoDisassembleSetting,
  meta: AutoDisassembleCandidateMeta
): boolean => {
  if (!setting.enabled) return false;
  const qualityRank = Number(meta.qualityRank);
  if (!Number.isInteger(qualityRank) || qualityRank <= 0) return false;
  // 多条规则采用 OR：命中任一规则即可自动分解。
  return setting.rules.some((ruleSet) => matchesRuleSet(ruleSet, meta));
};
