/**
 * 装备词条修饰器工具
 *
 * 作用：
 * 1. 统一 flat/percent 词条的复合属性结构（modifiers）解析与归一化；
 * 2. 统一词条数值精度规则，避免不同服务各自实现导致行为漂移；
 * 3. 提供从“旧结构（attr_key + value）”到“新结构（modifiers）”的安全转换能力。
 */

export type AffixApplyType = 'flat' | 'percent' | 'special';
export type AffixEffectType = 'buff' | 'debuff' | 'damage' | 'heal' | 'resource' | 'shield' | 'mark';
export type AffixParamValue = string | number | boolean;
export type AffixParams = Record<string, AffixParamValue>;

export interface AffixModifierDef {
  attr_key: string;
  ratio?: number;
}

export interface GeneratedAffixModifier {
  attr_key: string;
  value: number;
}

export interface AffixValueNormalizeContext {
  applyType: AffixApplyType;
  attrKey: string;
  effectType?: AffixEffectType;
  params?: AffixParams;
}

const RATIO_ATTR_KEYS = new Set([
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

export const isRatioAttrKey = (attrKeyRaw: unknown): boolean => {
  return typeof attrKeyRaw === 'string' && RATIO_ATTR_KEYS.has(attrKeyRaw);
};

const isRatioSpecialAffixValue = (
  effectType: AffixEffectType | undefined,
  params?: AffixParams
): boolean => {
  if (!params) return false;
  const paramApplyType = typeof params.apply_type === 'string' ? params.apply_type : '';
  const paramAttrKey = typeof params.attr_key === 'string' ? params.attr_key : '';
  const damageType = typeof params.damage_type === 'string' ? params.damage_type : '';
  const debuffType = typeof params.debuff_type === 'string' ? params.debuff_type : '';
  const shieldMode = typeof params.shield_mode === 'string' ? params.shield_mode : '';

  if ((effectType === 'buff' || effectType === 'debuff') && (paramApplyType === 'percent' || isRatioAttrKey(paramAttrKey))) {
    return true;
  }
  /**
   * special 比例型数值判定：
   * - reflect/echo：按伤害比例结算；
   * - damage_echo：按受击伤害比例生成护盾；
   * - bleed：按比例读取持续伤害系数。
   */
  if (effectType === 'damage' && (damageType === 'reflect' || damageType === 'echo')) return true;
  if (effectType === 'shield' && shieldMode === 'damage_echo') return true;
  if (effectType === 'debuff' && debuffType === 'bleed') return true;
  return false;
};

const shouldKeepRatioPrecision = (context: AffixValueNormalizeContext): boolean => {
  if (context.applyType === 'percent') return true;
  if (isRatioAttrKey(context.attrKey)) return true;
  if (context.applyType !== 'special') return false;
  return isRatioSpecialAffixValue(context.effectType, context.params);
};

export const normalizeAffixValueByContext = (
  context: AffixValueNormalizeContext,
  value: number
): number => {
  if (!Number.isFinite(value)) return 0;
  if (shouldKeepRatioPrecision(context)) return Number(value.toFixed(6));
  return Math.round(value);
};

const normalizeModifierRatio = (ratioRaw: unknown): number => {
  const ratio = toFiniteNumber(ratioRaw, 1);
  if (!Number.isFinite(ratio) || ratio === 0) return 1;
  return ratio;
};

export const normalizeAffixModifierDefs = (
  modifiersRaw: unknown,
  fallbackAttrKeyRaw: unknown
): AffixModifierDef[] => {
  const out: AffixModifierDef[] = [];
  const seen = new Set<string>();
  const rows = Array.isArray(modifiersRaw) ? modifiersRaw : [];

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const attrKey = typeof row.attr_key === 'string' ? row.attr_key.trim() : '';
    if (!attrKey || seen.has(attrKey)) continue;
    seen.add(attrKey);
    const ratio = normalizeModifierRatio(row.ratio);
    out.push(ratio === 1 ? { attr_key: attrKey } : { attr_key: attrKey, ratio });
  }

  if (out.length > 0) return out;

  const fallbackAttrKey = typeof fallbackAttrKeyRaw === 'string' ? fallbackAttrKeyRaw.trim() : '';
  if (!fallbackAttrKey) return [];
  return [{ attr_key: fallbackAttrKey }];
};

export const buildGeneratedAffixModifiers = (params: {
  applyType: AffixApplyType;
  effectType?: AffixEffectType;
  params?: AffixParams;
  modifierDefs: AffixModifierDef[];
  baseValue: number;
}): GeneratedAffixModifier[] => {
  const out: GeneratedAffixModifier[] = [];
  for (const modifierDef of params.modifierDefs) {
    const attrKey = String(modifierDef.attr_key || '').trim();
    if (!attrKey) continue;
    const ratio = normalizeModifierRatio(modifierDef.ratio);
    const rawValue = params.baseValue * ratio;
    const value = normalizeAffixValueByContext(
      {
        applyType: params.applyType,
        attrKey,
        effectType: params.effectType,
        params: params.params,
      },
      rawValue
    );
    out.push({ attr_key: attrKey, value });
  }
  return out;
};

export interface BuildAffixValueResult {
  value: number;
  modifiers: GeneratedAffixModifier[];
}

/**
 * 根据词条定义与基础值，统一计算“最终词条值 + modifiers”。
 *
 * 该函数用于装备生成与词条洗炼，避免两处实现发生数值漂移。
 */
export const buildAffixValueAndModifiers = (params: {
  applyType: AffixApplyType;
  keyRaw: unknown;
  effectType?: AffixEffectType;
  params?: AffixParams;
  modifiersRaw: unknown;
  rawScaledValue: number;
}): BuildAffixValueResult | null => {
  const modifierDefs =
    params.applyType === 'special'
      ? []
      : normalizeAffixModifierDefs(params.modifiersRaw, undefined);
  const generatedModifiers =
    params.applyType === 'special'
      ? []
      : buildGeneratedAffixModifiers({
          applyType: params.applyType,
          effectType: params.effectType,
          params: params.params,
          modifierDefs,
          baseValue: params.rawScaledValue,
        });

  const affixAttrKey = resolvePrimaryAffixAttrKey({
    applyType: params.applyType,
    keyRaw: params.keyRaw,
    attrKeyRaw: undefined,
    modifiers: generatedModifiers,
  });
  if (!affixAttrKey) return null;

  const value =
    params.applyType === 'special'
      ? normalizeAffixValueByContext(
          {
            applyType: params.applyType,
            attrKey: affixAttrKey,
            effectType: params.effectType,
            params: params.params,
          },
          params.rawScaledValue
        )
      : generatedModifiers[0]?.value ?? 0;

  return {
    value,
    modifiers: generatedModifiers,
  };
};

export const normalizeGeneratedAffixModifiers = (params: {
  applyType: AffixApplyType;
  effectType?: AffixEffectType;
  params?: AffixParams;
  modifiersRaw: unknown;
  fallbackAttrKeyRaw: unknown;
  fallbackValueRaw: unknown;
}): GeneratedAffixModifier[] => {
  if (params.applyType === 'special') return [];

  const fallbackValue = toFiniteNumber(params.fallbackValueRaw, 0);
  const modifierDefs = normalizeAffixModifierDefs(params.modifiersRaw, params.fallbackAttrKeyRaw);

  const out: GeneratedAffixModifier[] = [];
  const seen = new Set<string>();
  const rows = Array.isArray(params.modifiersRaw) ? params.modifiersRaw : [];

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const attrKey = typeof row.attr_key === 'string' ? row.attr_key.trim() : '';
    if (!attrKey || seen.has(attrKey)) continue;
    seen.add(attrKey);

    const valueRaw = toFiniteNumber(row.value, NaN);
    if (Number.isFinite(valueRaw)) {
      const value = normalizeAffixValueByContext(
        {
          applyType: params.applyType,
          attrKey,
          effectType: params.effectType,
          params: params.params,
        },
        valueRaw
      );
      out.push({ attr_key: attrKey, value });
      continue;
    }

    const ratio = normalizeModifierRatio(row.ratio);
    const value = normalizeAffixValueByContext(
      {
        applyType: params.applyType,
        attrKey,
        effectType: params.effectType,
        params: params.params,
      },
      fallbackValue * ratio
    );
    out.push({ attr_key: attrKey, value });
  }

  if (out.length > 0) return out;

  return buildGeneratedAffixModifiers({
    applyType: params.applyType,
    effectType: params.effectType,
    params: params.params,
    modifierDefs,
    baseValue: fallbackValue,
  });
};

export const resolvePrimaryAffixAttrKey = (params: {
  applyType: AffixApplyType;
  keyRaw: unknown;
  attrKeyRaw: unknown;
  modifiers?: GeneratedAffixModifier[];
}): string | null => {
  if (params.applyType === 'special') {
    const attrKey = typeof params.attrKeyRaw === 'string' ? params.attrKeyRaw.trim() : '';
    if (attrKey) return attrKey;
    const key = typeof params.keyRaw === 'string' ? params.keyRaw.trim() : '';
    return key || null;
  }

  const modifiers = Array.isArray(params.modifiers) ? params.modifiers : [];
  const fromModifier = modifiers.find((modifier) => typeof modifier.attr_key === 'string' && modifier.attr_key.trim().length > 0);
  if (fromModifier) return fromModifier.attr_key.trim();

  const attrKey = typeof params.attrKeyRaw === 'string' ? params.attrKeyRaw.trim() : '';
  return attrKey || null;
};

export interface FlatAffixDelta {
  attrKey: string;
  value: number;
}

export interface PercentAffixDelta {
  attrKey: string;
  value: number;
}

const extractAffixDeltasByApplyType = (
  affixRaw: unknown,
  applyType: 'flat' | 'percent',
): Array<{ attrKey: string; value: number }> => {
  if (!affixRaw || typeof affixRaw !== 'object') return [];
  const affix = affixRaw as Record<string, unknown>;
  const rawApplyType = String(affix.apply_type || '').trim().toLowerCase();
  if (rawApplyType !== applyType) return [];

  const modifiers = normalizeGeneratedAffixModifiers({
    applyType,
    effectType: undefined,
    params: undefined,
    modifiersRaw: affix.modifiers,
    fallbackAttrKeyRaw: undefined,
    fallbackValueRaw: affix.value,
  });

  return modifiers
    .map((modifier) => ({
      attrKey: String(modifier.attr_key || '').trim(),
      value: toFiniteNumber(modifier.value, 0),
    }))
    .filter((row) => row.attrKey.length > 0);
};

export const extractFlatAffixDeltas = (affixRaw: unknown): FlatAffixDelta[] => {
  return extractAffixDeltasByApplyType(affixRaw, 'flat');
};

export const extractPercentAffixDeltas = (affixRaw: unknown): PercentAffixDelta[] => {
  return extractAffixDeltasByApplyType(affixRaw, 'percent');
};
