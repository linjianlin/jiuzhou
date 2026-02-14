/**
 * 宝石语义工具
 *
 * 作用：
 * - 统一判定一个物品定义是否为“可镶嵌宝石”
 * - 统一读取宝石等级（gem_level）
 * - 统一解析宝石类型（attack/defense/survival/all/utility）
 *
 * 输入：
 * - itemDef：静态物品定义（来自 item_def/gem_def/equipment_def 合并结果）
 *
 * 输出：
 * - isGemItemDefinition：是否为宝石定义
 * - getGemLevel：宝石等级（非宝石或非法值返回 null）
 * - resolveGemTypeFromItemDefinition：宝石类型
 *
 * 关键约束：
 * - 不依赖命名/前缀判断（如 gem_、gem-）
 * - 宝石身份由分类字段决定：category = gem
 */
import {
  inferGemTypeFromEffects,
  parseSocketEffectsFromItemEffectDefs,
} from '../equipmentGrowthRules.js';
import type { ItemDefConfig } from '../staticConfigLoader.js';

type ItemDefGemLike = Pick<ItemDefConfig, 'category' | 'sub_category' | 'effect_defs' | 'gem_level'>;

const GEM_SUB_CATEGORY_TO_TYPE: Record<string, string> = {
  gem_attack: 'attack',
  gem_defense: 'defense',
  gem_survival: 'survival',
  gem_all: 'all',
};

const toPositiveInt = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const int = Math.floor(n);
  return int > 0 ? int : null;
};

const normalizeSubCategory = (value: unknown): string => {
  return String(value || '').trim().toLowerCase();
};

export const isGemItemDefinition = (itemDef: ItemDefGemLike | null | undefined): boolean => {
  if (!itemDef) return false;
  return String(itemDef.category || '').trim().toLowerCase() === 'gem';
};

export const getGemLevel = (itemDef: ItemDefGemLike | null | undefined): number | null => {
  if (!itemDef) return null;
  return toPositiveInt(itemDef.gem_level);
};

export const resolveGemTypeFromItemDefinition = (itemDef: ItemDefGemLike | null | undefined): string => {
  if (!itemDef) return 'all';
  const bySubCategory = GEM_SUB_CATEGORY_TO_TYPE[normalizeSubCategory(itemDef.sub_category)];
  if (bySubCategory) return bySubCategory;
  const effects = parseSocketEffectsFromItemEffectDefs(itemDef.effect_defs);
  if (effects.length === 0) return 'all';
  return inferGemTypeFromEffects(effects);
};
