/**
 * 九州修仙录 - 装备生成服务
 * 
 * 装备生成流程：
 * 1. 获取装备模板（item_def）
 * 2. 抽取品质（根据权重或指定）
 * 3. 抽取词条（根据词条池和品质）
 * 4. 设置数值（根据词条tier随机）
 * 5. 创建实例（写入item_instance）
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { findEmptySlots } from './inventory/index.js';
import type { SlottedInventoryLocation } from './inventory/shared/types.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import {
  QUALITY_MULTIPLIER_BY_RANK,
  QUALITY_ORDER,
  QUALITY_RANK_MAP,
  isQualityName,
  type QualityName,
} from './shared/itemQuality.js';
import {
  getRealmRankOneBasedForEquipment,
} from './shared/realmRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { getAffixPoolDefinitions, getItemDefinitionById } from './staticConfigLoader.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';
import {
  buildAffixValueAndModifiers,
  isRatioAttrKey,
  type AffixApplyType,
  type AffixEffectType,
  type AffixModifierDef,
  type AffixParams,
  type GeneratedAffixModifier,
} from './shared/affixModifier.js';
import {
  convertPercentToRating,
  getEffectiveLevelByRealmRank,
  resolveRatingBaseAttrKey,
  toRatingAttrKey,
} from './shared/affixRating.js';
import { normalizeItemInstanceObtainedFrom } from './shared/itemInstanceSource.js';
import { resolveAffixPoolBySlot } from './shared/affixPoolSlotResolver.js';
import { roundAffixResultValue } from './shared/affixPrecision.js';
import {
  bufferCharacterItemInstanceMutations,
  type BufferedCharacterItemInstanceMutation,
  type ItemInstanceSlotResolution,
  type JsonValue,
  loadProjectedCharacterItemInstances,
  reserveItemInstanceIds,
  tryApplyCharacterItemInstanceMutationsImmediately,
} from './shared/characterItemInstanceMutationService.js';
import type { InventorySlotSession } from './shared/inventorySlotSession.js';

// ============================================
// 类型定义
// ============================================

// 品质类型
export type Quality = QualityName;
export const QUALITY_RANK: Record<Quality, number> = QUALITY_RANK_MAP;
const QUALITIES: Quality[] = [...QUALITY_ORDER];
const DEFAULT_AFFIX_COUNT_BY_QUALITY: Record<Quality, { min: number; max: number }> = {
  '黄': { min: 1, max: 2 },
  '玄': { min: 2, max: 4 },
  '地': { min: 4, max: 5 },
  '天': { min: 6, max: 6 },
};
const AFFIX_GEN_VERSION = 5;
const coerceQuality = (value: unknown): Quality | null => {
  if (!isQualityName(value)) return null;
  return value;
};

const getQualityMultiplier = (rank: number): number => {
  return QUALITY_MULTIPLIER_BY_RANK[rank] ?? 1;
};

const clampInt = (value: number, min: number, max: number): number => {
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
};

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

/**
 * 根据词条采样值计算 roll 比例（0~1）。
 * 当 min/max 相等时，视为固定词条，直接返回 1（100%）。
 */
const resolveAffixRollRatio = (
  sampledValue: number,
  min: number,
  max: number,
): number => {
  if (!Number.isFinite(sampledValue) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const span = high - low;
  if (span <= Number.EPSILON) return 1;
  return clampNumber((sampledValue - low) / span, 0, 1);
};

const normalizeScaledAttrValue = (attrKey: string, value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return isRatioAttrKey(attrKey) ? roundAffixResultValue(value) : Math.round(value);
};

const sampleTierValueByRollRatio = (tier: AffixTier, rollRatio: number): number | null => {
  const min = Number(tier.min);
  const max = Number(tier.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const safeRollRatio = clampNumber(rollRatio, 0, 1);

  if (Number.isInteger(low) && Number.isInteger(high)) {
    return clampInt(Math.round(low + (high - low) * safeRollRatio), low, high);
  }

  return roundAffixResultValue(low + (high - low) * safeRollRatio);
};

const buildAffixSourceValueMap = (
  affix: AffixDef,
  selectedTier: number,
  rollRatio: number,
  attrFactor: number,
  primaryValue: number,
): Record<string, number> | undefined => {
  if (!affix.value_tiers) return undefined;

  const out: Record<string, number> = {};
  for (const [valueSource, tiers] of Object.entries(affix.value_tiers)) {
    const tier = tiers.find((row) => row.tier === selectedTier);
    if (!tier) continue;
    const sourceValue = sampleTierValueByRollRatio(tier, rollRatio);
    if (sourceValue === null) continue;
    out[valueSource] =
      Number.isFinite(attrFactor) && attrFactor !== 1
        ? sourceValue * attrFactor
        : sourceValue;
  }

  const primaryValueSource = typeof affix.primary_value_source === 'string' ? affix.primary_value_source.trim() : '';
  if (primaryValueSource) {
    out[primaryValueSource] = primaryValue;
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const scaleAttrs = (attrs: Record<string, number>, factor: number): Record<string, number> => {
  if (!Number.isFinite(factor) || factor === 1) return attrs;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = normalizeScaledAttrValue(k, n * factor);
  }
  return out;
};

// 词条定义
export interface AffixDef {
  key: string;
  name: string;
  modifiers?: AffixModifierDef[];
  allowed_slots?: string[];
  primary_value_source?: string;
  value_tiers?: Record<string, AffixTier[]>;
  apply_type: AffixApplyType;
  group: string;
  weight: number;
  is_legendary?: boolean;
  trigger?: 'on_turn_start' | 'on_skill' | 'on_hit' | 'on_ally_hit' | 'on_crit' | 'on_be_hit' | 'on_heal';
  target?: 'self' | 'enemy';
  effect_type?: AffixEffectType;
  duration_round?: number;
  params?: AffixParams;
  tiers: AffixTier[];
}

export interface AffixTier {
  tier: number;
  min: number;
  max: number;
  realm_rank_min: number;
  description?: string;
}

// 词条池规则
export interface AffixPoolRules {
  allow_duplicate: boolean;
  mutex_groups?: string[][];
  legendary_chance?: number;
}

// 生成的词条实例
export interface GeneratedAffix {
  key: string;
  name: string;
  modifiers?: GeneratedAffixModifier[];
  apply_type: AffixApplyType;
  tier: number;
  value: number;
  /** 词条随机区间内的ROLL比例（0~1）。 */
  roll_ratio?: number;
  /** 词条随机区间内的ROLL百分比（0~100）。 */
  roll_percent?: number;
  is_legendary?: boolean;
  description?: string;
  trigger?: 'on_turn_start' | 'on_skill' | 'on_hit' | 'on_ally_hit' | 'on_crit' | 'on_be_hit' | 'on_heal';
  target?: 'self' | 'enemy';
  effect_type?: AffixEffectType;
  duration_round?: number;
  params?: AffixParams;
  value_type?: 'raw' | 'rating';
  rating_attr_key?: string;
}

// 装备模板
export interface EquipmentDef {
  id: string;
  name: string;
  category: string;
  sub_category: string;
  equip_slot: string;
  equip_req_realm: string;
  base_attrs: Record<string, number>;
  affix_pool_id: string;
  set_id: string | null;
  bind_type: string;
}

// 生成选项
export interface GenerateOptions {
  quality?: Quality;                    // 指定品质（不指定则随机）
  qualityWeights?: Record<Quality, number>; // 品质权重
  realmRank?: number;                   // 覆盖装备境界等级（影响词条tier）
  identified?: boolean;                 // 是否已鉴定
  bindType?: string;                    // 绑定类型
  obtainedFrom?: string;                // 获取来源
  seed?: number;                        // 随机种子（用于复现）
  fuyuan?: number;
}

// 生成结果
export interface GeneratedEquipment {
  itemDefId: string;
  name: string;
  quality: Quality;
  qualityRank: number;
  baseAttrs: Record<string, number>;
  affixes: GeneratedAffix[];
  affixGenVersion: number;
  setId: string | null;
  seed: number;
}

// ============================================
// 随机工具函数
// ============================================

// 简单随机数生成器（可复现）
class SeededRandom {
  private seed: number;
  
  constructor(seed?: number) {
    this.seed = seed ?? Date.now();
  }
  
  getSeed(): number {
    return this.seed;
  }
  
  // 生成 0-1 之间的随机数
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  
  // 生成 min-max 之间的整数
  nextInt(min: number, max: number): number {
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    return Math.floor(this.next() * (safeMax - safeMin + 1)) + safeMin;
  }

  // 生成 min-max 之间的小数
  nextRange(min: number, max: number): number {
    const safeMin = Math.min(min, max);
    const safeMax = Math.max(min, max);
    return safeMin + this.next() * (safeMax - safeMin);
  }
  
  // 根据权重随机选择
  weightedChoice<T>(items: T[], weights: number[]): T {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = this.next() * totalWeight;
    
    for (let i = 0; i < items.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        return items[i];
      }
    }
    return items[items.length - 1];
  }
  
  // 随机打乱数组
  shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

// ============================================
// 核心功能
// ============================================

/**
 * 获取装备模板
 */
export const getEquipmentDef = async (itemDefId: string): Promise<EquipmentDef | null> => {
  const row = getItemDefinitionById(itemDefId);
  if (!row || row.category !== 'equipment' || row.enabled === false) return null;

  const baseAttrs = row.base_attrs && typeof row.base_attrs === 'object'
    ? (row.base_attrs as Record<string, number>)
    : {};

  return {
    id: row.id,
    name: String(row.name || row.id),
    category: String(row.category || 'equipment'),
    sub_category: String(row.sub_category || ''),
    equip_slot: String(row.equip_slot || ''),
    equip_req_realm: String(row.equip_req_realm || ''),
    base_attrs: baseAttrs,
    affix_pool_id: String(row.affix_pool_id || ''),
    set_id: typeof row.set_id === 'string' ? row.set_id : null,
    bind_type: String(row.bind_type || 'none'),
  };
};

/**
 * 获取词条池
 */
export const getAffixPool = async (
  poolId: string,
  equipSlot: string,
): Promise<{ rules: AffixPoolRules; affixes: AffixDef[] } | null> => {
  const result = resolveAffixPoolBySlot(getAffixPoolDefinitions(), poolId, equipSlot);
  if (!result || result.affixes.length <= 0) return null;
  return {
    rules: result.rules as AffixPoolRules,
    affixes: result.affixes as AffixDef[]
  };
};

/**
 * 抽取品质
 */
export const rollQuality = (
  rng: SeededRandom,
  weights?: Record<Quality, number>,
  fuyuan?: number,
  qualityMin: Quality = '黄',
  qualityMax: Quality = '天'
): Quality => {
  const minRankRaw = QUALITY_RANK[qualityMin];
  const maxRankRaw = QUALITY_RANK[qualityMax];
  const minRank = Math.min(minRankRaw, maxRankRaw);
  const maxRank = Math.max(minRankRaw, maxRankRaw);

  const baseRank = minRank;

  const defaultWeights: Record<Quality, number> = {
    '黄': 0,
    '玄': 0,
    '地': 0,
    '天': 0,
  };

  for (const q of QUALITIES) {
    const r = QUALITY_RANK[q];
    if (r < minRank || r > maxRank) continue;
    defaultWeights[q] = Math.pow(0.5, Math.abs(r - baseRank)) * 70;
  }

  const baseWeightsRaw = weights ? { ...weights } : defaultWeights;
  const baseWeights: Record<Quality, number> = {
    '黄': Number(baseWeightsRaw['黄'] ?? 0),
    '玄': Number(baseWeightsRaw['玄'] ?? 0),
    '地': Number(baseWeightsRaw['地'] ?? 0),
    '天': Number(baseWeightsRaw['天'] ?? 0),
  };

  for (const q of QUALITIES) {
    const r = QUALITY_RANK[q];
    if (r < minRank || r > maxRank) baseWeights[q] = 0;
  }

  const hasAnyBaseWeight = QUALITIES.some((q) => baseWeights[q] > 0);
  if (!hasAnyBaseWeight) {
    for (const q of QUALITIES) baseWeights[q] = defaultWeights[q];
  }

  const cappedFuyuan = Math.min(200, Math.max(0, Number(fuyuan ?? 0)));
  const rate = 1 + cappedFuyuan * 0.0025;

  const adjustedWeights: Record<Quality, number> = {
    '黄': Number(baseWeights['黄'] ?? 0),
    '玄': Number(baseWeights['玄'] ?? 0),
    '地': Number(baseWeights['地'] ?? 0),
    '天': Number(baseWeights['天'] ?? 0),
  };

  if (cappedFuyuan > 0) {
    for (const q of QUALITIES) {
      const diff = QUALITY_RANK[q] - baseRank;
      if (diff <= 0) continue;
      const w = adjustedWeights[q];
      if (w <= 0) continue;
      adjustedWeights[q] = w * (1 + (rate - 1) * diff);
    }
  }

  const validQualities = QUALITIES.filter((q) => adjustedWeights[q] > 0);
  if (validQualities.length === 0) {
    const clamped = QUALITIES.find((q) => QUALITY_RANK[q] === baseRank) ?? '黄';
    return clamped;
  }

  const validWeights = validQualities.map((q) => adjustedWeights[q]);
  return rng.weightedChoice(validQualities, validWeights);
};

/**
 * 抽取词条
 */
export const rollAffixes = (
  rng: SeededRandom,
  pool: { rules: AffixPoolRules; affixes: AffixDef[] },
  quality: Quality,
  realmRank: number = 1,
  attrFactor: number = 1
): GeneratedAffix[] => {
  const { rules, affixes } = pool;
  const result: GeneratedAffix[] = [];

  // 词条数量统一按默认品阶规则随机，不再从词条池配置读取。
  const countRange = DEFAULT_AFFIX_COUNT_BY_QUALITY[quality];
  const affixCount = rng.nextInt(countRange.min, countRange.max);
  
  // 过滤可用词条（排除传奇词条，除非触发传奇概率）
  let availableAffixes = affixes.filter(a => !a.is_legendary);
  
  // 传奇词条概率
  const hasLegendary = rules.legendary_chance && rng.next() < rules.legendary_chance;
  if (hasLegendary) {
    const legendaryAffixes = affixes.filter(a => a.is_legendary);
    if (legendaryAffixes.length > 0) {
      const legendaryWeights = legendaryAffixes.map(a => a.weight);
      const legendary = rng.weightedChoice(legendaryAffixes, legendaryWeights);
      const generatedLegendary = rollAffixValue(rng, legendary, realmRank, attrFactor);
      if (generatedLegendary) {
        result.push(generatedLegendary);
      }
    }
  }
  
  // 已选词条key（用于去重）
  const selectedKeys = new Set(result.map(a => a.key));
  
  // 互斥组检查
  const getMutexGroup = (key: string): string[] | undefined => {
    return rules.mutex_groups?.find(group => group.includes(key));
  };
  
  // 抽取普通词条
  while (result.length < affixCount && availableAffixes.length > 0) {
    // 过滤可选词条
    const validAffixes = availableAffixes.filter(affix => {
      // 检查是否已选
      if (!rules.allow_duplicate && selectedKeys.has(affix.key)) {
        return false;
      }
      
      // 检查互斥组
      const mutexGroup = getMutexGroup(affix.key);
      if (mutexGroup && mutexGroup.some(k => selectedKeys.has(k))) {
        return false;
      }
      
      // 检查是否有可用tier
      const validTiers = affix.tiers.filter(t => t.realm_rank_min <= realmRank);
      if (validTiers.length === 0) {
        return false;
      }
      
      return true;
    });
    
    if (validAffixes.length === 0) break;
    
    // 按权重选择
    const weights = validAffixes.map(a => a.weight);
    const selected = rng.weightedChoice(validAffixes, weights);
    
    // 生成词条数值
    const generated = rollAffixValue(rng, selected, realmRank, attrFactor);
    if (generated) {
      result.push(generated);
      selectedKeys.add(selected.key);
    }
    
    // 从可用列表移除（如果不允许重复）
    if (!rules.allow_duplicate) {
      availableAffixes = availableAffixes.filter(a => a.key !== selected.key);
    }
  }
  
  return result;
};

/**
 * 生成词条数值
 */
const rollAffixValue = (
  rng: SeededRandom,
  affix: AffixDef,
  realmRank: number,
  attrFactor: number
): GeneratedAffix | null => {
  // 找到最高可用tier
  const validTiers = affix.tiers
    .filter(t => t.realm_rank_min <= realmRank)
    .sort((a, b) => b.tier - a.tier);
  
  if (validTiers.length === 0) return null;
  
  // 选择tier（倾向于选择较高tier，但有随机性）
  const tierWeights = validTiers.map((_, i) => Math.pow(0.6, i));
  const selectedTier = rng.weightedChoice(validTiers, tierWeights);
  
  // 在 tier 范围内随机数值（支持小数词条）
  const min = Number(selectedTier.min);
  const max = Number(selectedTier.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const sampledValue = Number.isInteger(min) && Number.isInteger(max)
    ? rng.nextInt(min, max)
    : rng.nextRange(min, max);
  const rollRatio = resolveAffixRollRatio(sampledValue, min, max);
  const rollPercent = Number((rollRatio * 100).toFixed(2));
  const rawScaledValue = Number.isFinite(attrFactor) && attrFactor !== 1
    ? sampledValue * attrFactor
    : sampledValue;
  const rawScaledValueBySource = buildAffixSourceValueMap(affix, selectedTier.tier, rollRatio, attrFactor, rawScaledValue);
  const resolvedAffixValue = buildAffixValueAndModifiers({
    applyType: affix.apply_type,
    keyRaw: affix.key,
    effectType: affix.effect_type,
    params: affix.params,
    modifiersRaw: affix.modifiers,
    rawScaledValue,
    rawScaledValueBySource,
    defaultValueSource: affix.primary_value_source,
  });
  if (!resolvedAffixValue) return null;
  const scaledValue = resolvedAffixValue.value;
  const generatedModifiers = resolvedAffixValue.modifiers;

  const out: GeneratedAffix = {
    key: affix.key,
    name: affix.name,
    apply_type: affix.apply_type,
    tier: selectedTier.tier,
    value: scaledValue,
    roll_ratio: rollRatio,
    roll_percent: rollPercent,
    is_legendary: affix.is_legendary,
    description: selectedTier.description
  };
  if (generatedModifiers.length > 0) out.modifiers = generatedModifiers;

  if (affix.apply_type === 'special') {
    out.trigger = affix.trigger;
    out.target = affix.target;
    out.effect_type = affix.effect_type;
    out.duration_round = affix.duration_round;
    if (affix.params) {
      out.params = { ...affix.params };
      if (out.params.value === undefined) {
        out.params.value = scaledValue;
      }
    } else {
      out.params = { value: scaledValue };
    }
  }

  return convertGeneratedAffixToRating(out, realmRank);
};

/**
 * 将“比率类副属性”统一转换为 rating 存储。
 *
 * 规则：
 * 1) 仅处理 special 以外词条；
 * 2) 仅处理 modifiers 中可识别为比率属性的字段；
 * 3) 转换后 attr_key 改为 `${attr}_rating`，并标记 value_type=rating；
 * 4) 非比率词条保持原语义，标记 value_type=raw。
 */
const convertGeneratedAffixToRating = (
  affix: GeneratedAffix,
  realmRank: number,
): GeneratedAffix => {
  if (affix.apply_type === 'special') return affix;
  const rows = Array.isArray(affix.modifiers) ? affix.modifiers : [];
  if (rows.length <= 0) return { ...affix, value_type: affix.value_type ?? 'raw' };

  const effectiveLevel = getEffectiveLevelByRealmRank(realmRank);
  let hasRatingModifier = false;
  let primaryRatingAttrKey: string | undefined;

  const nextModifiers: GeneratedAffixModifier[] = rows.map((row) => {
    const attrKey = String(row.attr_key || '').trim();
    const rawValue = Number(row.value);
    if (!attrKey || !Number.isFinite(rawValue)) {
      return row;
    }

    const existingBaseAttr = resolveRatingBaseAttrKey(attrKey);
    if (existingBaseAttr) {
      hasRatingModifier = true;
      if (!primaryRatingAttrKey) primaryRatingAttrKey = attrKey;
      return { attr_key: attrKey, value: Math.round(rawValue) };
    }

    if (!isRatioAttrKey(attrKey)) {
      return row;
    }

    const ratingAttrKey = toRatingAttrKey(attrKey);
    if (!ratingAttrKey) {
      return row;
    }
    const ratingValue = convertPercentToRating(attrKey, rawValue, effectiveLevel);
    hasRatingModifier = true;
    if (!primaryRatingAttrKey) primaryRatingAttrKey = ratingAttrKey;
    return {
      attr_key: ratingAttrKey,
      value: ratingValue,
    };
  });

  if (!hasRatingModifier) {
    return {
      ...affix,
      modifiers: nextModifiers,
      value_type: 'raw',
      rating_attr_key: undefined,
    };
  }

  const firstValue = Number(nextModifiers[0]?.value);
  return {
    ...affix,
    apply_type: 'flat',
    modifiers: nextModifiers,
    value: Number.isFinite(firstValue) ? firstValue : 0,
    value_type: 'rating',
    rating_attr_key: primaryRatingAttrKey,
  };
};

/**
 * 生成装备（核心函数）
 */
export const generateEquipment = async (
  itemDefId: string,
  options: GenerateOptions = {}
): Promise<GeneratedEquipment | null> => {
  // 1. 获取装备模板
  const def = await getEquipmentDef(itemDefId);
  if (!def) {
    console.error(`装备模板不存在: ${itemDefId}`);
    return null;
  }
  
  // 初始化随机数生成器
  const rng = new SeededRandom(options.seed);
  
  // 2. 抽取品质
  const boundMin: Quality = '黄';
  const boundMax: Quality = '天';
  const minRank = Math.min(QUALITY_RANK[boundMin], QUALITY_RANK[boundMax]);
  const maxRank = Math.max(QUALITY_RANK[boundMin], QUALITY_RANK[boundMax]);

  const resolvedQuality =
    options.quality && coerceQuality(options.quality)
      ? (options.quality as Quality)
      : null;

  const quality =
    resolvedQuality && QUALITY_RANK[resolvedQuality] >= minRank && QUALITY_RANK[resolvedQuality] <= maxRank
      ? resolvedQuality
      : resolvedQuality
        ? (QUALITIES.find((q) => QUALITY_RANK[q] === Math.min(maxRank, Math.max(minRank, QUALITY_RANK[resolvedQuality]))) ??
          boundMin)
        : rollQuality(rng, options.qualityWeights, options.fuyuan, boundMin, boundMax);
  const qualityRank = QUALITY_RANK[quality];

  const baseQualityRank = QUALITY_RANK['黄'];
  const attrFactor = getQualityMultiplier(qualityRank) / getQualityMultiplier(baseQualityRank);
  const scaledBaseAttrs = scaleAttrs(def.base_attrs, attrFactor);
  
  // 3. 获取词条池并抽取词条
  let affixes: GeneratedAffix[] = [];
  if (def.affix_pool_id) {
    const pool = await getAffixPool(def.affix_pool_id, def.equip_slot);
    if (pool) {
      const explicitRealmRank = Number.isInteger(options.realmRank) && Number(options.realmRank) > 0
        ? Number(options.realmRank)
        : null;
      const realmRank = explicitRealmRank ?? getRealmRankOneBasedForEquipment(def.equip_req_realm);
      affixes = rollAffixes(rng, pool, quality, realmRank, attrFactor);
    }
  }
  
  // 4. 返回生成结果
  return {
    itemDefId: def.id,
    name: def.name,
    quality,
    qualityRank,
    baseAttrs: scaledBaseAttrs,
    affixes,
    affixGenVersion: AFFIX_GEN_VERSION,
    setId: def.set_id,
    seed: rng.getSeed()
  };
};

/**
 * 装备生成服务
 *
 * 作用：装备模板查询、装备生成、装备实例创建与查询
 * 不做：装备强化/精炼/词条重铸（由其他服务负责）
 *
 * 数据流：
 * - getEquipmentDef / getAffixPool：从静态配置读取模板
 * - generateEquipment：纯计算生成装备数据
 * - createEquipmentInstance：事务中写入 item_instance 表
 * - getEquipmentInstance：读取装备实例详情
 *
 * 边界条件：
 * 1) createEquipmentInstance 使用 @Transactional 保证背包槽位分配与写入的原子性
 * 2) createEquipmentInstanceTx 仅承载创建逻辑本体，统一通过 query 自动复用事务上下文
 */
class EquipmentService {
  /**
   * 装备实例立即落库 mutation 构建器
   *
   * 作用：
   * - 做什么：把装备实例快照收敛为共享的 item_instance mutation 结构，复用统一的槽位安全立即落库协议。
   * - 不做什么：不分配槽位、不处理重试策略，调用方必须先准备好候选 snapshot。
   *
   * 输入 / 输出：
   * - 输入：角色ID与已完成字段收敛的装备实例 snapshot。
   * - 输出：单条 upsert mutation，供 savepoint/事务内立即写库复用。
   *
   * 数据流 / 状态流：
   * - createEquipmentInstanceTx 先分配候选槽位；
   * - 再通过本方法构建 mutation；
   * - 最终交给 shared 层的槽位安全立即落库能力处理。
   *
   * 复用设计说明：
   * - 把“装备立即写 item_instance”的 mutation 结构集中到单一出口，避免邮件领取、奖励同步发放各自拼一套对象。
   * - 后续若还有实例型奖励要立即落库，也能直接复用同一构造协议。
   *
   * 关键边界条件与坑点：
   * 1) `createdAt` 只用于 mutation 排序，必须保持稳定可比；这里单条 mutation 直接使用当前时间即可。
   * 2) snapshot 必须已经带上最终 `location/location_slot`，否则 shared 层只能按错误目标执行占槽校验。
   */
  private buildImmediateCreateMutation(
    characterId: number,
    snapshot: {
      id: number;
      owner_user_id: number;
      owner_character_id: number;
      item_def_id: string;
      qty: number;
      quality: string | null;
      quality_rank: number | null;
      metadata: null;
      location: string;
      location_slot: number | null;
      equipped_slot: null;
      strengthen_level: number;
      refine_level: number;
      socketed_gems: JsonValue;
      affixes: JsonValue;
      identified: boolean;
      locked: boolean;
      bind_type: string;
      bind_owner_user_id: null;
      bind_owner_character_id: null;
      random_seed: string;
      affix_gen_version: number;
      affix_roll_meta: null;
      custom_name: null;
      expire_at: null;
      obtained_from: string | null;
      obtained_ref_id: null;
      created_at: Date;
    },
    slotResolution?: ItemInstanceSlotResolution,
  ): BufferedCharacterItemInstanceMutation {
    return {
      opId: `equipment-create:${snapshot.id}:${Date.now()}`,
      characterId,
      itemId: snapshot.id,
      createdAt: Date.now(),
      kind: 'upsert',
      snapshot,
      slotResolution,
    };
  }

  private buildBufferedCreateMutation(
    characterId: number,
    snapshot: {
      id: number;
      owner_user_id: number;
      owner_character_id: number;
      item_def_id: string;
      qty: number;
      quality: string | null;
      quality_rank: number | null;
      metadata: null;
      location: string;
      location_slot: number | null;
      equipped_slot: null;
      strengthen_level: number;
      refine_level: number;
      socketed_gems: JsonValue;
      affixes: JsonValue;
      identified: boolean;
      locked: boolean;
      bind_type: string;
      bind_owner_user_id: null;
      bind_owner_character_id: null;
      random_seed: string;
      affix_gen_version: number;
      affix_roll_meta: null;
      custom_name: null;
      expire_at: null;
      obtained_from: string | null;
      obtained_ref_id: null;
      created_at: Date;
    },
    slotResolution?: ItemInstanceSlotResolution,
  ): BufferedCharacterItemInstanceMutation {
    return {
      opId: `equipment-create:${snapshot.id}:${Date.now()}`,
      characterId,
      itemId: snapshot.id,
      createdAt: Date.now(),
      kind: 'upsert',
      snapshot,
      slotResolution,
    };
  }

  // 创建装备实例（自动开启事务）
  @Transactional
  async createEquipmentInstance(
    userId: number,
    characterId: number,
    generated: GeneratedEquipment,
    options: {
      location?: string;
      locationSlot?: number;
      bindType?: string;
      identified?: boolean;
      obtainedFrom?: string;
      skipInventoryMutexLock?: boolean;
      persistImmediately?: boolean;
      fallbackOnSlotConflict?: boolean;
      slotSession?: InventorySlotSession;
    } = {}
  ): Promise<{ success: boolean; instanceId?: number; message: string; pendingMutation?: BufferedCharacterItemInstanceMutation }> {
    return this.createEquipmentInstanceTx(userId, characterId, generated, options);
  }

  // 事务内创建装备实例（供其他 service 在已有事务中调用）
  async createEquipmentInstanceTx(
    userId: number,
    characterId: number,
    generated: GeneratedEquipment,
    options: {
      location?: string;
      locationSlot?: number;
      bindType?: string;
      identified?: boolean;
      obtainedFrom?: string;
      skipInventoryMutexLock?: boolean;
      persistImmediately?: boolean;
      fallbackOnSlotConflict?: boolean;
      slotSession?: InventorySlotSession;
      deferBufferedMutation?: boolean;
    } = {}
  ): Promise<{ success: boolean; instanceId?: number; message: string; pendingMutation?: BufferedCharacterItemInstanceMutation }> {
    const location = options.location || 'bag';
    const hasExplicitSlot = options.locationSlot !== undefined && options.locationSlot !== null;
    const shouldFallbackOnSlotConflict = options.fallbackOnSlotConflict === true || !hasExplicitSlot;
    const slotSession = options.slotSession;
    let locationSlot = options.locationSlot ?? null;
    const obtainedFrom = normalizeItemInstanceObtainedFrom(options.obtainedFrom).value;

    if (!options.skipInventoryMutexLock) {
      await lockCharacterInventoryMutex(characterId);
    }

    if (hasExplicitSlot && (location === 'bag' || location === 'warehouse')) {
      const slottedLocation: SlottedInventoryLocation = location === 'warehouse' ? 'warehouse' : 'bag';
      const occupied = slotSession
        ? !slotSession.isSlotAvailable(characterId, slottedLocation, Number(locationSlot))
        : (await loadProjectedCharacterItemInstances(characterId)).some((item) => (
          item.location === location && item.location_slot === locationSlot
        ));
      if (occupied) {
        return { success: false, message: '目标格子已被占用' };
      }
    }

    if (!options.persistImmediately && (location === 'bag' || location === 'warehouse') && (locationSlot === null || locationSlot === undefined)) {
      const slottedLocation: SlottedInventoryLocation = location === 'warehouse' ? 'warehouse' : 'bag';
      const slots = slotSession
        ? slotSession.listEmptySlots(characterId, slottedLocation, 6)
        : await findEmptySlots(characterId, location, 6);
      if (slots.length === 0) {
        return { success: false, message: '背包已满' };
      }
      locationSlot = slots[0] ?? null;
    }
    const shouldUseAutoSlotResolution =
      (location === 'bag' || location === 'warehouse')
      && shouldFallbackOnSlotConflict;
    const autoSlotResolution: ItemInstanceSlotResolution | undefined = shouldUseAutoSlotResolution
      ? { mode: 'auto' }
      : undefined;
    if (shouldUseAutoSlotResolution) {
      locationSlot = null;
    }

    const [instanceId] = await reserveItemInstanceIds(1);
    if (!Number.isInteger(instanceId) || instanceId <= 0) {
      return { success: false, message: '装备创建失败' };
    }

    const baseSnapshot = {
      id: instanceId,
      owner_user_id: userId,
      owner_character_id: characterId,
      item_def_id: generated.itemDefId,
      qty: 1,
      quality: generated.quality,
      quality_rank: generated.qualityRank,
      metadata: null,
      location,
      location_slot: locationSlot,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      socketed_gems: [],
      affixes: JSON.parse(JSON.stringify(generated.affixes)) as JsonValue,
      identified: options.identified !== false,
      locked: false,
      bind_type: options.bindType || 'none',
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      random_seed: String(generated.seed),
      affix_gen_version: generated.affixGenVersion || AFFIX_GEN_VERSION,
      affix_roll_meta: null,
      custom_name: null,
      expire_at: null,
      obtained_from: obtainedFrom,
      obtained_ref_id: null,
      created_at: new Date(),
    };

    if (options.persistImmediately) {
      const maxAttempts = shouldFallbackOnSlotConflict && (location === 'bag' || location === 'warehouse') ? 6 : 1;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let nextLocationSlot = locationSlot;
        if ((location === 'bag' || location === 'warehouse') && (nextLocationSlot === null || nextLocationSlot === undefined)) {
          const slottedLocation: SlottedInventoryLocation = location === 'warehouse' ? 'warehouse' : 'bag';
          const slots = attempt === 0 && slotSession
            ? slotSession.listEmptySlots(characterId, slottedLocation, 6)
            : await findEmptySlots(characterId, location, 6);
          if (slots.length === 0) {
            return { success: false, message: '背包已满' };
          }
          nextLocationSlot = slots[0] ?? null;
        }

        const persisted = await tryApplyCharacterItemInstanceMutationsImmediately([
          this.buildImmediateCreateMutation(characterId, {
            ...baseSnapshot,
            location_slot: nextLocationSlot,
          }, shouldUseAutoSlotResolution ? { mode: 'auto' } : undefined),
        ]);

        if (persisted) {
          locationSlot = nextLocationSlot;
          if (slotSession) {
            slotSession.registerSnapshot({
              ...baseSnapshot,
              location_slot: nextLocationSlot,
            });
          }
          return {
            success: true,
            instanceId,
            message: '装备创建成功',
          };
        }

        if (!shouldFallbackOnSlotConflict) {
          return { success: false, message: '目标格子已被占用' };
        }

        locationSlot = null;
      }

      return { success: false, message: '背包已满' };
    } else {
      const pendingMutation = this.buildBufferedCreateMutation(characterId, {
        ...baseSnapshot,
        location_slot: locationSlot,
      }, autoSlotResolution);
      if (options.deferBufferedMutation) {
        return {
          success: true,
          instanceId,
          message: '装备创建成功',
          pendingMutation,
        };
      }
      await bufferCharacterItemInstanceMutations([pendingMutation]);
      if (slotSession) {
        slotSession.registerSnapshot({
          ...baseSnapshot,
          location_slot: locationSlot,
        });
      }
    }

    return {
      success: true,
      instanceId,
      message: '装备创建成功',
    };
  }

  // 一键生成并创建装备实例
  async generateAndCreateEquipment(
    userId: number,
    characterId: number,
    itemDefId: string,
    options: GenerateOptions & {
      location?: string;
      locationSlot?: number;
    } = {}
  ): Promise<{
    success: boolean;
    instanceId?: number;
    equipment?: GeneratedEquipment;
    message: string;
  }> {
    // 生成装备
    const generated = await generateEquipment(itemDefId, options);
    if (!generated) {
      return { success: false, message: '装备生成失败' };
    }

    // 创建实例
    const result = await this.createEquipmentInstance(userId, characterId, generated, {
      location: options.location,
      locationSlot: options.locationSlot,
      bindType: options.bindType,
      identified: options.identified,
      obtainedFrom: options.obtainedFrom
    });

    if (!result.success) {
      return { success: false, message: result.message };
    }

    return {
      success: true,
      instanceId: result.instanceId,
      equipment: generated,
      message: '装备生成并创建成功'
    };
  }

  // 获取装备实例详情（纯读，不加 @Transactional）
  async getEquipmentInstance(instanceId: number): Promise<any | null> {
    const result = await query(
      `
      SELECT *
      FROM item_instance
      WHERE id = $1
    `,
      [instanceId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const itemDefId = String(row.item_def_id || '').trim();
    if (!itemDefId) return null;
    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef || itemDef.category !== 'equipment') return null;

    const resolvedQuality = coerceQuality(row.quality) ?? '黄';
    const defQualityRank = resolveQualityRankFromName(itemDef.quality, QUALITY_RANK['黄']);
    const resolvedQualityRank = Number(row.quality_rank) || QUALITY_RANK[resolvedQuality] || defQualityRank;
    const baseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: itemDef.base_attrs,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: row.strengthen_level,
      refineLevelRaw: row.refine_level,
      socketedGemsRaw: row.socketed_gems,
    });
    return {
      id: row.id,
      itemDefId: row.item_def_id,
      name: itemDef.name,
      icon: itemDef.icon,
      quality: resolvedQuality,
      qualityRank: resolvedQualityRank,
      equipSlot: itemDef.equip_slot,
      equipReqRealm: itemDef.equip_req_realm,
      baseAttrs,
      affixes: row.affixes || [],
      setId: itemDef.set_id,
      strengthenLevel: row.strengthen_level,
      refineLevel: row.refine_level,
      socketedGems: row.socketed_gems,
      identified: row.identified,
      locked: row.locked,
      bindType: row.bind_type,
      location: row.location,
      locationSlot: row.location_slot,
      equippedSlot: row.equipped_slot,
      description: itemDef.description,
      createdAt: row.created_at
    };
  }
}

export const equipmentService = new EquipmentService();
