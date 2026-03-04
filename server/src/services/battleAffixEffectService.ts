import type { BattleSetBonusEffect } from '../battle/types.js';

type BattleAffixTrigger = BattleSetBonusEffect['trigger'];
type BattleAffixEffectType = BattleSetBonusEffect['effectType'];
type BattleAffixTarget = BattleSetBonusEffect['target'];
type BattleAffixParamValue = string | number | boolean;

const BATTLE_AFFIX_TRIGGER_SET: ReadonlySet<BattleAffixTrigger> = new Set([
  'on_turn_start',
  'on_skill',
  'on_hit',
  'on_crit',
  'on_be_hit',
  'on_heal',
]);

const BATTLE_AFFIX_EFFECT_TYPE_SET: ReadonlySet<BattleAffixEffectType> = new Set([
  'buff',
  'debuff',
  'damage',
  'heal',
  'resource',
  'shield',
  'mark',
]);

type RawGeneratedAffix = {
  key?: string;
  name?: string;
  apply_type?: string;
  trigger?: string;
  target?: string;
  effect_type?: string;
  duration_round?: number | string;
  value?: number | string;
  params?: Record<string, unknown> | null;
};

export type BattleAffixEffectSource = {
  itemInstanceId: number;
  itemName: string;
  affixesRaw: unknown;
};

const toObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const toText = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeAffixArray = (affixesRaw: unknown): RawGeneratedAffix[] => {
  let rows: unknown = affixesRaw;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      return row as RawGeneratedAffix;
    })
    .filter((row): row is RawGeneratedAffix => !!row);
};

const normalizeTrigger = (value: unknown): BattleAffixTrigger | null => {
  const trigger = toText(value);
  return BATTLE_AFFIX_TRIGGER_SET.has(trigger as BattleAffixTrigger)
    ? (trigger as BattleAffixTrigger)
    : null;
};

const normalizeEffectType = (value: unknown): BattleAffixEffectType | null => {
  const effectType = toText(value);
  return BATTLE_AFFIX_EFFECT_TYPE_SET.has(effectType as BattleAffixEffectType)
    ? (effectType as BattleAffixEffectType)
    : null;
};

const normalizeTarget = (value: unknown): BattleAffixTarget | null => {
  const target = toText(value);
  if (target === 'self' || target === 'enemy') return target;
  return null;
};

const normalizeParams = (value: unknown): Record<string, BattleAffixParamValue> => {
  const out: Record<string, BattleAffixParamValue> = {};
  const raw = toObject(value);
  for (const [key, param] of Object.entries(raw)) {
    if (typeof param === 'number' && Number.isFinite(param)) {
      out[key] = param;
      continue;
    }
    if (typeof param === 'string' || typeof param === 'boolean') {
      out[key] = param;
    }
  }
  return out;
};

export const extractBattleAffixEffectsFromEquippedItems = (
  sources: BattleAffixEffectSource[]
): BattleSetBonusEffect[] => {
  const out: BattleSetBonusEffect[] = [];

  for (const source of sources) {
    const itemId = Number.isFinite(source.itemInstanceId) ? Math.floor(source.itemInstanceId) : 0;
    if (itemId <= 0) continue;

    const itemName = toText(source.itemName) || '装备词条';
    const affixes = normalizeAffixArray(source.affixesRaw);
    for (let i = 0; i < affixes.length; i++) {
      const affix = affixes[i];
      if (toText(affix.apply_type) !== 'special') continue;

      const trigger = normalizeTrigger(affix.trigger);
      const effectType = normalizeEffectType(affix.effect_type);
      const target = normalizeTarget(affix.target);
      if (!trigger || !effectType || !target) continue;

      const params = normalizeParams(affix.params);
      if (params.value === undefined) {
        const value = toNumber(affix.value);
        if (value !== null) params.value = value;
      }

      const durationRaw = toNumber(affix.duration_round);
      const durationRound =
        durationRaw === null ? undefined : Math.max(1, Math.floor(durationRaw));
      const key = toText(affix.key) || `special-${i + 1}`;
      // 统一写入词条key，供战斗期做“同词条聚合判定”。
      params.affix_key = key;
      const affixName = toText(affix.name) || key;
      const element = toText(params.element);

      out.push({
        setId: `affix-${itemId}-${key}`,
        setName: `${itemName}·${affixName}`,
        pieceCount: 1,
        trigger,
        target,
        effectType,
        durationRound,
        element: element || undefined,
        params,
      });
    }
  }

  return out;
};
