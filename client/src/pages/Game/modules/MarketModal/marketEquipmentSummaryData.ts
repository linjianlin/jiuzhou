import { parseSocketedGems, type SocketedGemEntry } from '../../shared/socketedGemDisplay';

export type MarketEquipmentSummaryInput = {
  category: string | null;
  strengthenLevel: number;
  refineLevel: number;
  socketedGems?: string | SocketedGemEntry[] | null;
};

export type MarketEquipmentSummaryItem = {
  key: 'strengthen' | 'refine' | 'gems';
  text: string;
};

const normalizeLevel = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
};

const normalizeCategory = (value: string | null): string => {
  return String(value ?? '').trim().toLowerCase();
};

export const buildMarketEquipmentSummary = (
  input: MarketEquipmentSummaryInput,
): MarketEquipmentSummaryItem[] => {
  if (normalizeCategory(input.category) !== 'equipment') {
    return [];
  }

  const strengthenLevel = normalizeLevel(input.strengthenLevel);
  const refineLevel = normalizeLevel(input.refineLevel);
  const gemCount = parseSocketedGems(input.socketedGems).length;
  const items: MarketEquipmentSummaryItem[] = [];

  if (strengthenLevel > 0) {
    items.push({ key: 'strengthen', text: `强化+${strengthenLevel}` });
  }
  if (refineLevel > 0) {
    items.push({ key: 'refine', text: `精炼+${refineLevel}` });
  }
  if (gemCount > 0) {
    items.push({ key: 'gems', text: `宝石${gemCount}` });
  }

  return items;
};
