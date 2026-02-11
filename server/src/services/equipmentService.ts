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
import { query, pool } from '../config/database.js';
import type { PoolClient } from 'pg';
import { findEmptySlotsWithClient } from './inventoryService.js';

// ============================================
// 类型定义
// ============================================

// 品质类型
export type Quality = '黄' | '玄' | '地' | '天';
export const QUALITY_RANK: Record<Quality, number> = { '黄': 1, '玄': 2, '地': 3, '天': 4 };
const QUALITIES: Quality[] = ['黄', '玄', '地', '天'];
const DEFAULT_AFFIX_COUNT_BY_QUALITY: Record<Quality, { min: number; max: number }> = {
  '黄': { min: 1, max: 2 },
  '玄': { min: 2, max: 4 },
  '地': { min: 4, max: 5 },
  '天': { min: 6, max: 6 },
};

const coerceQuality = (value: unknown): Quality | null => {
  return QUALITIES.includes(value as Quality) ? (value as Quality) : null;
};

const QUALITY_MULTIPLIER_BY_RANK: Record<number, number> = {
  1: 1,
  2: 1.2,
  3: 1.45,
  4: 1.75,
};

const getQualityMultiplier = (rank: number): number => {
  return QUALITY_MULTIPLIER_BY_RANK[rank] ?? 1;
};

const clampInt = (value: number, min: number, max: number): number => {
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
};

const getStrengthenMultiplier = (strengthenLevel: number): number => {
  const lv = clampInt(strengthenLevel, 0, 15);
  return 1 + lv * 0.03;
};

const scaleAttrs = (attrs: Record<string, number>, factor: number): Record<string, number> => {
  if (!Number.isFinite(factor) || factor === 1) return attrs;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.round(n * factor);
  }
  return out;
};

// 词条定义
export interface AffixDef {
  key: string;
  name: string;
  attr_key: string;
  apply_type: 'flat' | 'percent' | 'special';
  group: string;
  weight: number;
  is_legendary?: boolean;
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
  count_by_quality: Record<Quality, { min: number; max: number }>;
  allow_duplicate: boolean;
  mutex_groups?: string[][];
  max_per_group?: Record<string, number>;
  legendary_chance?: number;
}

// 生成的词条实例
export interface GeneratedAffix {
  key: string;
  name: string;
  attr_key: string;
  apply_type: string;
  tier: number;
  value: number;
  is_legendary?: boolean;
  description?: string;
}

// 装备模板
export interface EquipmentDef {
  id: string;
  code: string;
  name: string;
  category: string;
  sub_category: string;
  quality: Quality;
  quality_rank: number;
  quality_min: Quality | null;
  quality_max: Quality | null;
  level: number;
  equip_slot: string;
  equip_req_realm: string;
  base_attrs: Record<string, number>;
  affix_pool_id: string;
  affix_count_min: number;
  affix_count_max: number;
  set_id: string | null;
  bind_type: string;
}

// 生成选项
export interface GenerateOptions {
  quality?: Quality;                    // 指定品质（不指定则随机）
  qualityWeights?: Record<Quality, number>; // 品质权重
  realmRank?: number;                   // 玩家境界等级（影响词条tier）
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
    return Math.floor(this.next() * (max - min + 1)) + min;
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
  const result = await query(`
    SELECT id, code, name, category, sub_category, quality, quality_rank, quality_min, quality_max, level,
           equip_slot, equip_req_realm, base_attrs,
           affix_pool_id, affix_count_min, affix_count_max, set_id, bind_type
    FROM item_def
    WHERE id = $1 AND category = 'equipment' AND enabled = true
  `, [itemDefId]);
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  const quality = coerceQuality(row.quality) ?? '黄';
  return {
    ...row,
    quality,
    quality_rank: Number(row.quality_rank) || QUALITY_RANK[quality],
    quality_min: coerceQuality(row.quality_min),
    quality_max: coerceQuality(row.quality_max),
    base_attrs: row.base_attrs || {},
  };
};

/**
 * 获取词条池
 */
export const getAffixPool = async (poolId: string): Promise<{ rules: AffixPoolRules; affixes: AffixDef[] } | null> => {
  const result = await query(
    'SELECT rules, affixes FROM affix_pool WHERE id = $1 AND enabled = true',
    [poolId]
  );
  
  if (result.rows.length === 0) return null;
  
  return {
    rules: result.rows[0].rules,
    affixes: result.rows[0].affixes
  };
};

/**
 * 抽取品质
 */
export const rollQuality = (
  rng: SeededRandom,
  baseQuality: Quality,
  weights?: Record<Quality, number>,
  fuyuan?: number,
  qualityMin?: Quality,
  qualityMax?: Quality
): Quality => {
  const minRankRaw = QUALITY_RANK[qualityMin ?? '黄'];
  const maxRankRaw = QUALITY_RANK[qualityMax ?? '天'];
  const minRank = Math.min(minRankRaw, maxRankRaw);
  const maxRank = Math.max(minRankRaw, maxRankRaw);

  const baseRankRaw = QUALITY_RANK[baseQuality];
  const baseRank = Math.min(maxRank, Math.max(minRank, baseRankRaw));

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
    const clamped = QUALITIES.find((q) => QUALITY_RANK[q] === baseRank) ?? baseQuality;
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
  
  // 获取该品质的词条数量范围
  const countRange = rules.count_by_quality?.[quality] || DEFAULT_AFFIX_COUNT_BY_QUALITY[quality];
  if (!countRange) return result;
  
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
  
  // 已选词条分组计数
  const groupCounts: Record<string, number> = {};
  
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
      
      // 检查分组上限
      if (rules.max_per_group && rules.max_per_group[affix.group]) {
        const currentCount = groupCounts[affix.group] || 0;
        if (currentCount >= rules.max_per_group[affix.group]) {
          return false;
        }
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
      groupCounts[selected.group] = (groupCounts[selected.group] || 0) + 1;
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
  
  // 在tier范围内随机数值
  const value = rng.nextInt(selectedTier.min, selectedTier.max);
  const scaledValue = Number.isFinite(attrFactor) && attrFactor !== 1 ? Math.round(value * attrFactor) : value;
  
  return {
    key: affix.key,
    name: affix.name,
    attr_key: affix.attr_key,
    apply_type: affix.apply_type,
    tier: selectedTier.tier,
    value: scaledValue,
    is_legendary: affix.is_legendary,
    description: selectedTier.description
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
  const boundMin = def.quality_min ?? def.quality;
  const boundMax = def.quality_max ?? def.quality;
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
        : rollQuality(rng, def.quality, options.qualityWeights, options.fuyuan, boundMin, boundMax);
  const qualityRank = QUALITY_RANK[quality];

  const baseQualityRank = Number(def.quality_rank) || QUALITY_RANK[def.quality];
  const attrFactor = getQualityMultiplier(qualityRank) / getQualityMultiplier(baseQualityRank);
  const scaledBaseAttrs = scaleAttrs(def.base_attrs, attrFactor);
  
  // 3. 获取词条池并抽取词条
  let affixes: GeneratedAffix[] = [];
  if (def.affix_pool_id) {
    const pool = await getAffixPool(def.affix_pool_id);
    if (pool) {
      const realmRank = options.realmRank || Math.max(baseQualityRank, qualityRank);
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
    setId: def.set_id,
    seed: rng.getSeed()
  };
};

/**
 * 创建装备实例（写入数据库）
 */
export const createEquipmentInstance = async (
  userId: number,
  characterId: number,
  generated: GeneratedEquipment,
  options: {
    location?: string;
    locationSlot?: number;
    bindType?: string;
    identified?: boolean;
    obtainedFrom?: string;
  } = {}
): Promise<{ success: boolean; instanceId?: number; message: string }> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const txResult = await createEquipmentInstanceTx(client, userId, characterId, generated, options);
    if (!txResult.success) {
      await client.query('ROLLBACK');
      return txResult;
    }

    await client.query('COMMIT');
    
    return {
      success: true,
      instanceId: txResult.instanceId,
      message: txResult.message
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('创建装备实例失败:', error);
    return { success: false, message: '创建装备实例失败' };
  } finally {
    client.release();
  }
};

export const createEquipmentInstanceTx = async (
  client: PoolClient,
  userId: number,
  characterId: number,
  generated: GeneratedEquipment,
  options: {
    location?: string;
    locationSlot?: number;
    bindType?: string;
    identified?: boolean;
    obtainedFrom?: string;
  } = {}
): Promise<{ success: boolean; instanceId?: number; message: string }> => {
  const isUniqueViolation = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === '23505';
  };

  const location = options.location || 'bag';
  const hasExplicitSlot = options.locationSlot !== undefined && options.locationSlot !== null;
  let locationSlot = options.locationSlot ?? null;

  let attempt = 0;
  while (attempt < 6) {
    attempt += 1;

    if ((location === 'bag' || location === 'warehouse') && (locationSlot === null || locationSlot === undefined)) {
      const slots = await findEmptySlotsWithClient(characterId, location, 6, client);
      if (slots.length === 0) {
        return { success: false, message: '背包已满' };
      }
      locationSlot = slots[0];
    }

    try {
      const result = await client.query(
        `
          INSERT INTO item_instance (
            owner_user_id, owner_character_id, item_def_id, qty,
            quality, quality_rank,
            location, location_slot, bind_type, 
            random_seed, affixes, identified,
            obtained_from
          ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id
        `,
        [
          userId,
          characterId,
          generated.itemDefId,
          generated.quality,
          generated.qualityRank,
          location,
          locationSlot,
          options.bindType || 'none',
          generated.seed,
          JSON.stringify(generated.affixes),
          options.identified !== false,
          options.obtainedFrom || 'system',
        ]
      );

      return {
        success: true,
        instanceId: result.rows[0].id,
        message: '装备创建成功',
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (hasExplicitSlot) return { success: false, message: '目标格子已被占用' };
      locationSlot = null;
    }
  }

  return {
    success: false,
    message: '背包已满'
  };
};

/**
 * 一键生成并创建装备实例
 */
export const generateAndCreateEquipment = async (
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
}> => {
  // 生成装备
  const generated = await generateEquipment(itemDefId, options);
  if (!generated) {
    return { success: false, message: '装备生成失败' };
  }
  
  // 创建实例
  const result = await createEquipmentInstance(userId, characterId, generated, {
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
};

/**
 * 获取装备实例详情（包含模板信息和词条）
 */
export const getEquipmentInstance = async (instanceId: number): Promise<any | null> => {
  const result = await query(`
    SELECT 
      ii.*,
      COALESCE(ii.quality, id.quality) as resolved_quality,
      COALESCE(ii.quality_rank, id.quality_rank) as resolved_quality_rank,
      id.name, id.icon, id.quality as def_quality, id.quality_rank as def_quality_rank,
      id.equip_slot, id.equip_req_realm, id.base_attrs,
      id.set_id, id.description
    FROM item_instance ii
    JOIN item_def id ON ii.item_def_id = id.id
    WHERE ii.id = $1
  `, [instanceId]);
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  const resolvedQualityRank = Number(row.resolved_quality_rank) || 1;
  const baseRank = Number(row.def_quality_rank) || 1;
  const attrFactor = getQualityMultiplier(resolvedQualityRank) / getQualityMultiplier(baseRank);
  const strengthenFactor = getStrengthenMultiplier(Number(row.strengthen_level) || 0);
  return {
    id: row.id,
    itemDefId: row.item_def_id,
    name: row.name,
    icon: row.icon,
    quality: row.resolved_quality,
    qualityRank: row.resolved_quality_rank,
    equipSlot: row.equip_slot,
    equipReqRealm: row.equip_req_realm,
    baseAttrs: scaleAttrs(
      (row.base_attrs && typeof row.base_attrs === 'object' ? row.base_attrs : {}) as Record<string, number>,
      attrFactor * strengthenFactor
    ),
    affixes: row.affixes || [],
    setId: row.set_id,
    strengthenLevel: row.strengthen_level,
    refineLevel: row.refine_level,
    socketedGems: row.socketed_gems,
    identified: row.identified,
    locked: row.locked,
    bindType: row.bind_type,
    location: row.location,
    locationSlot: row.location_slot,
    equippedSlot: row.equipped_slot,
    description: row.description,
    createdAt: row.created_at
  };
};

