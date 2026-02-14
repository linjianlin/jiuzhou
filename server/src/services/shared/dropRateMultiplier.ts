/**
 * 掉落倍率工具
 *
 * 作用：
 * 1. 统一通用掉落池倍率规则（副本/世界、普通/精英/BOSS）
 * 2. 给展示层提供“翻倍后”的概率/权重值计算入口
 * 3. 给结算层提供“翻倍后”的数量计算入口（按业务条件开启）
 */

export type MonsterKind = 'normal' | 'elite' | 'boss';
export type DropEntrySourceType = 'common' | 'exclusive';

export type DropMultiplierContext = {
  isDungeonBattle?: boolean;
  monsterKind?: MonsterKind;
};

type PoolMultiplierConfig = {
  normalBattle: number;
  dungeonBattle: number;
};

const COMMON_POOL_MULTIPLIER: Record<MonsterKind, PoolMultiplierConfig> = {
  normal: {
    normalBattle: 1,
    dungeonBattle: 2,
  },
  elite: {
    normalBattle: 2,
    dungeonBattle: 4,
  },
  boss: {
    normalBattle: 4,
    dungeonBattle: 6,
  },
} as const;

const EXCLUDED_COMMON_POOLS_FOR_MULTIPLIER = new Set<string>([
  'dp-common-monster-elite',
  'dp-common-monster-boss',
]);

const clamp01 = (value: number): number => {
  return Math.max(0, Math.min(1, value));
};

export const normalizeMonsterKind = (value: unknown): MonsterKind => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'elite') return 'elite';
  if (normalized === 'boss') return 'boss';
  return 'normal';
};

/**
 * 计算通用掉落池在特定场景下的倍率。
 * 独占池始终为 1；排除列表中的通用池也固定为 1。
 */
export const getCommonPoolMultiplier = (
  sourceType: DropEntrySourceType,
  sourcePoolId: string,
  options: DropMultiplierContext = {},
): number => {
  if (sourceType !== 'common') return 1;
  if (EXCLUDED_COMMON_POOLS_FOR_MULTIPLIER.has(sourcePoolId)) return 1;

  const isDungeonBattle = options.isDungeonBattle === true;
  const monsterKind = normalizeMonsterKind(options.monsterKind);
  const config = COMMON_POOL_MULTIPLIER[monsterKind];
  return isDungeonBattle ? config.dungeonBattle : config.normalBattle;
};

/**
 * 1) 概率模式：返回 0~1 之间的翻倍后概率
 * 2) 权重模式：仅按倍率返回翻倍后权重
 */
export const getAdjustedChance = (
  chance: number,
  sourceType: DropEntrySourceType,
  sourcePoolId: string,
  options: DropMultiplierContext = {},
): number => {
  if (!Number.isFinite(chance) || chance <= 0) return 0;
  return clamp01(chance * getCommonPoolMultiplier(sourceType, sourcePoolId, options));
};

export const getAdjustedWeight = (
  weight: number,
  sourceType: DropEntrySourceType,
  sourcePoolId: string,
  options: DropMultiplierContext = {},
): number => {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return weight * getCommonPoolMultiplier(sourceType, sourcePoolId, options);
};

/**
 * 数量模式：
 * - shouldApplyMultiplier=false 时直接返回原数量
 * - shouldApplyMultiplier=true 时按通用掉落池倍率放大
 */
export const getAdjustedQuantity = (
  quantity: number,
  sourceType: DropEntrySourceType,
  sourcePoolId: string,
  options: DropMultiplierContext = {},
  shouldApplyMultiplier: boolean = true,
): number => {
  const baseQty = Math.max(0, Math.floor(Number(quantity) || 0));
  if (baseQty <= 0) return 0;
  if (!shouldApplyMultiplier) return baseQty;

  const multiplier = getCommonPoolMultiplier(sourceType, sourcePoolId, options);
  if (!Number.isFinite(multiplier) || multiplier <= 1) return baseQty;
  return Math.max(1, Math.floor(baseQty * multiplier));
};
