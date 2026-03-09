/**
 * 分解规则
 */
import { QUALITY_RANK_MAP as SHARED_QUALITY_RANK_MAP } from './shared/itemQuality.js';

export const QUALITY_RANK_MAP: Record<string, number> = { ...SHARED_QUALITY_RANK_MAP };

export const clampQualityRank = (value: unknown, fallback: number = 1): number => {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(1, Math.min(4, n));
};

export const resolveQualityRank = (quality: unknown): number => {
  const key = String(quality || '').trim();
  return QUALITY_RANK_MAP[key] || 0;
};

export const resolveDisassembleRewardItemDefIdByQualityRank = (qualityRank: number): string | null => {
  if (qualityRank >= 1 && qualityRank <= 2) return 'enhance-001';
  if (qualityRank >= 3 && qualityRank <= 4) return 'enhance-002';
  return null;
};

export const resolveDisassembleRewardItemDefIdByQuality = (quality: unknown): string | null => {
  return resolveDisassembleRewardItemDefIdByQualityRank(resolveQualityRank(quality));
};

export type TechniqueBookDisassembleReward = {
  itemDefId: string;
  qty: number;
};

const TECHNIQUE_BOOK_REWARD_QTY_BY_QUALITY_RANK: Record<number, number> = {
  1: 10,
  2: 20,
  3: 40,
  4: 80,
};

export const resolveTechniqueBookDisassembleRewardByQualityRank = (
  qualityRank: number
): TechniqueBookDisassembleReward | null => {
  const safeRank = clampQualityRank(qualityRank, 0);
  const qty = TECHNIQUE_BOOK_REWARD_QTY_BY_QUALITY_RANK[safeRank];
  if (!qty) return null;
  return { itemDefId: 'mat-gongfa-canye', qty };
};

export const resolveTechniqueBookDisassembleRewardByQuality = (
  quality: unknown
): TechniqueBookDisassembleReward | null => {
  return resolveTechniqueBookDisassembleRewardByQualityRank(resolveQualityRank(quality));
};

/**
 * 默认分解银两公式输入
 *
 * 说明：
 * - 仅在“未命中特殊分解规则”时使用
 * - qty 为本次分解数量（单件或批量子项）
 */
export type DefaultDisassembleSilverInput = {
  qualityRank: number;
  strengthenLevel: number;
  refineLevel: number;
  affixCount: number;
  qty: number;
};

export type DefaultDisassembleSilverResult = {
  unitSilver: number;
  totalSilver: number;
};

const QUALITY_FACTOR_BY_RANK: Record<number, number> = {
  1: 1.0,
  2: 1.8,
  3: 3.0,
  4: 4.8,
};

/**
 * 计算默认分解银两（未特殊标注物品）
 *
 * 公式：
 * - base = 100
 * - qualityFactor = {1:1.0, 2:1.8, 3:3.0, 4:4.8}
 * - growthFactor = 1 + strengthenLevel*0.06 + refineLevel*0.08 + affixCount*0.03
 * - unitSilver = floor(base * qualityFactor * growthFactor / 10), 且最小为1
 * - totalSilver = unitSilver * qty
 */
export const calculateDefaultDisassembleSilver = (
  input: DefaultDisassembleSilverInput
): DefaultDisassembleSilverResult => {
  const qualityRank = clampQualityRank(input.qualityRank, 1);
  const strengthenLevel = Math.max(0, Math.floor(Number(input.strengthenLevel) || 0));
  const refineLevel = Math.max(0, Math.floor(Number(input.refineLevel) || 0));
  const affixCount = Math.max(0, Math.floor(Number(input.affixCount) || 0));
  const qty = Math.max(1, Math.floor(Number(input.qty) || 1));

  const base = 100;
  const qualityFactor = QUALITY_FACTOR_BY_RANK[qualityRank] ?? 1.0;
  const growthFactor = 1 + strengthenLevel * 0.06 + refineLevel * 0.08 + affixCount * 0.03;
  const unitSilver = Math.max(1, Math.floor((base * qualityFactor * growthFactor) / 10));
  const totalSilver = unitSilver * qty;
  return { unitSilver, totalSilver };
};
