import { clampInt as clampGrowthInt } from './equipmentGrowthRules.js';
import { getEquipRealmRankForReroll } from './equipmentAffixRerollService.js';

export const REROLL_SCROLL_ITEM_DEF_ID = 'scroll-003';

const clampInt = clampGrowthInt;
const MAX_SAFE_LOCK_COUNT = 30;
const SILVER_GROWTH_BASE = 1.6;

export interface AffixRerollCostPlan {
  baseSilver: number;
  silverCost: number;
  multiplier: number;
  lockCount: number;
  rerollScrollItemDefId: string;
  rerollScrollQty: number;
  spiritStoneCost: number;
}

export interface AffixLockValidationResult {
  success: boolean;
  message: string;
  normalizedLockIndexes: number[];
  maxLockCount: number;
  affixCount: number;
}

export const normalizeAffixLockIndexes = (lockIndexes: number[] | null | undefined): number[] => {
  if (!Array.isArray(lockIndexes)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of lockIndexes) {
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out.sort((a, b) => a - b);
};

export const validateAffixLockIndexes = (
  affixCountRaw: number,
  lockIndexesRaw: number[] | null | undefined
): AffixLockValidationResult => {
  const affixCount = Math.max(0, clampInt(affixCountRaw, 0, 999));
  const maxLockCount = Math.max(0, affixCount - 1);
  const normalizedLockIndexes = normalizeAffixLockIndexes(lockIndexesRaw);
  const indexOutOfRange = normalizedLockIndexes.some((idx) => idx >= affixCount);
  if (indexOutOfRange || normalizedLockIndexes.length > maxLockCount) {
    return {
      success: false,
      message: '锁定词条数量不合法',
      normalizedLockIndexes: [],
      maxLockCount,
      affixCount,
    };
  }
  return {
    success: true,
    message: 'ok',
    normalizedLockIndexes,
    maxLockCount,
    affixCount,
  };
};

export const buildAffixRerollCostPlan = (realmRaw: unknown, lockCountRaw: number): AffixRerollCostPlan => {
  const realmRank = Math.max(1, clampInt(getEquipRealmRankForReroll(realmRaw), 1, 99));
  const lockCount = Math.max(0, clampInt(lockCountRaw, 0, MAX_SAFE_LOCK_COUNT));
  const lockMultiplier = Math.pow(2, lockCount);
  const multiplier = Math.pow(SILVER_GROWTH_BASE, lockCount);
  const baseSilver = Math.floor(realmRank * realmRank * 500);
  const silverCost = Math.max(0, Math.floor(baseSilver * multiplier));
  const spiritStoneCost = lockCount > 0
    ? Math.max(0, Math.floor((lockMultiplier - 1) * realmRank * 40))
    : 0;

  return {
    baseSilver,
    silverCost,
    multiplier,
    lockCount,
    rerollScrollItemDefId: REROLL_SCROLL_ITEM_DEF_ID,
    rerollScrollQty: lockMultiplier,
    spiritStoneCost,
  };
};
