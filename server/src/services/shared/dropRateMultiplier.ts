/**
 * 掉落倍率工具
 *
 * 作用：
 * 1. 统一通用掉落池倍率规则（副本/世界、普通/精英/BOSS）
 * 2. 统一读取条目配置中的境界概率加成，以及秘境难度 reward_mult 对物品掉落率的影响，避免战斗结算与预览各写一套
 * 3. 给展示层提供“翻倍后”的概率/权重值计算入口
 * 4. 给结算层提供“翻倍后”的数量计算入口（按业务条件开启）
 *
 * 输入 / 输出：
 * - 输入：条目的来源类型、来源池 ID、怪物种类/境界、秘境场景与可选的 reward_mult。
 * - 输出：按统一业务规则放大后的概率、权重与数量。
 *
 * 数据流 / 状态流：
 * - 战斗结算与秘境预览都把场景信息收敛成 DropMultiplierContext；
 * - 本模块统一解释通用池倍率、境界概率加成、秘境 reward_mult；
 * - 下游只消费这里返回的最终概率/权重/数量。
 *
 * 复用设计说明：
 * 1. 秘境掉落率的放大逻辑集中在这里后，battleDropService 与 dungeon/definitions 不再各自维护 reward_mult 公式。
 * 2. “固定 BOSS 掉落池不参与额外倍率”的规则与既有公共池排除集合共用一份入口，避免后续新增倍率时漏改。
 * 3. 高频变化点是池子排除名单和倍率公式，因此放在共享层，保证展示与结算严格同口径。
 *
 * 关键边界条件与坑点：
 * 1. reward_mult 只影响秘境场景的物品掉落率，不影响世界怪、普通战斗，也不影响数量倍率。
 * 2. 被排除的秘境 BOSS 固定掉落池必须严格按配置值展示与结算，不能额外乘通用倍率、境界加成外的 reward_mult。
 */
import { getRealmRankZeroBased } from './realmRules.js';
import { resolveDungeonRewardMultiplier } from '../dungeon/shared/difficulty.js';

export type MonsterKind = 'normal' | 'elite' | 'boss';
export type DropEntrySourceType = 'common' | 'exclusive';

export type DropMultiplierContext = {
  isDungeonBattle?: boolean;
  monsterKind?: MonsterKind;
  monsterRealm?: string | null;
  chanceAddByMonsterRealm?: number;
  dungeonRewardMultiplier?: number;
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
  // 秘境BOSS额外固定产出条目需要严格按配置值展示与结算，不参与秘境/BOSS通用倍率放大。
  'dp-common-dungeon-boss-unbind',
  'dp-common-dungeon-boss-advanced-recruit-token',
]);

const EXCLUDED_POOLS_FOR_DUNGEON_REWARD_MULTIPLIER = new Set<string>([
  'dp-common-dungeon-boss-unbind',
  'dp-common-dungeon-boss-advanced-recruit-token',
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
 * 仅处理“条目已声明”的境界概率加成。
 * 规则保持在共享层，这样 JSON 配置一旦调整，结算与预览会同步生效。
 */
const getRealmScaledChanceBonus = (
  chanceAddByMonsterRealmRaw: number | undefined,
  monsterRealmRaw?: string | null,
): number => {
  const chanceAddByMonsterRealm = Number(chanceAddByMonsterRealmRaw);
  if (!Number.isFinite(chanceAddByMonsterRealm) || chanceAddByMonsterRealm <= 0) return 0;
  const realmRank = Math.max(0, getRealmRankZeroBased(monsterRealmRaw));
  return realmRank * chanceAddByMonsterRealm;
};

const getDungeonRewardRateMultiplier = (
  sourcePoolId: string,
  options: DropMultiplierContext = {},
): number => {
  if (options.isDungeonBattle !== true) return 1;
  if (EXCLUDED_POOLS_FOR_DUNGEON_REWARD_MULTIPLIER.has(sourcePoolId)) return 1;
  return resolveDungeonRewardMultiplier(options.dungeonRewardMultiplier);
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
  const multipliedChance = chance * getCommonPoolMultiplier(sourceType, sourcePoolId, options);
  const itemChanceBonus = getRealmScaledChanceBonus(
    options.chanceAddByMonsterRealm,
    options.monsterRealm,
  );
  return clamp01(
    (multipliedChance + itemChanceBonus) * getDungeonRewardRateMultiplier(sourcePoolId, options),
  );
};

export const getAdjustedWeight = (
  weight: number,
  sourceType: DropEntrySourceType,
  sourcePoolId: string,
  options: DropMultiplierContext = {},
): number => {
  if (!Number.isFinite(weight) || weight <= 0) return 0;
  return (
    weight *
    getCommonPoolMultiplier(sourceType, sourcePoolId, options) *
    getDungeonRewardRateMultiplier(sourcePoolId, options)
  );
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
