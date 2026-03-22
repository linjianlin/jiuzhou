/**
 * 九州修仙录 - 套装战斗效果执行模块
 * 仅处理战斗期触发型套装效果（equip 常驻属性已在穿戴时写入角色）
 */

import type {
  ActionLog,
  BattleLogEntry,
  BattleSetBonusEffect,
  BattleSetBonusTrigger,
  BattleState,
  TargetResult,
  BattleUnit,
} from '../types.js';
import { rollChance } from '../utils/random.js';
import { addBuff, addShield } from './buff.js';
import { applyDamage, calculateDamage } from './damage.js';
import { applyHealing } from './healing.js';
import {
  applyMarkStacks,
  applySoulShackleRecoveryReduction,
  consumeMarkStacks,
  resolveMarkEffectConfig,
} from './mark.js';
import { applyMarkConsumeRuntimeAddon } from './markAddonRuntime.js';
import { applyReactiveDamage, applyReactiveTrueDamage, calculateReactiveDamageByRate } from './reactiveDamage.js';
import {
  convertRatingToPercent,
  getEffectiveLevelByRealm,
  resolveRatingBaseAttrKey,
} from '../../services/shared/affixRating.js';

interface SetBonusTriggerContext {
  target?: BattleUnit;
  damage?: number;
  damageType?: 'physical' | 'magic' | 'true';
  heal?: number;
}

interface SetBonusApplyResult {
  targetResult: TargetResult;
  extraLogs?: BattleLogEntry[];
}

interface PreparedTriggerEffect {
  effect: BattleSetBonusEffect;
  params: Record<string, unknown>;
  chance: number;
}

interface SetBuffAttrModifier {
  attrKey: string;
  applyType: 'flat' | 'percent';
  value: number;
}

function resolveSetBuffAttrModifier(
  target: BattleUnit,
  params: Record<string, unknown>
): SetBuffAttrModifier | null {
  const attrKey = asNonEmptyString(params.attr_key);
  const applyType = asApplyType(params.apply_type);
  const value = asFiniteNumber(params.value);
  if (!attrKey || value === null || !applyType) return null;

  const ratingBaseAttrKey = resolveRatingBaseAttrKey(attrKey);
  if (!ratingBaseAttrKey) {
    return { attrKey, applyType, value };
  }

  const effectiveLevel = getEffectiveLevelByRealm(target.currentAttrs.realm);
  const convertedPercent = convertRatingToPercent(ratingBaseAttrKey, value, effectiveLevel);
  if (!Number.isFinite(convertedPercent) || convertedPercent === 0) return null;

  // rating 统一换算为百分比增量，以 flat 形式叠加到比率属性。
  return {
    attrKey: ratingBaseAttrKey,
    applyType: 'flat',
    value: convertedPercent,
  };
}

export function triggerSetBonusEffects(
  state: BattleState,
  trigger: BattleSetBonusTrigger,
  owner: BattleUnit,
  context: SetBonusTriggerContext = {}
): BattleLogEntry[] {
  const effects = Array.isArray(owner.setBonusEffects) ? owner.setBonusEffects : [];
  if (effects.length === 0) return [];

  const logs: BattleLogEntry[] = [];
  const preparedEffects = buildPreparedTriggerEffects(effects, trigger);
  for (const prepared of preparedEffects) {
    const { effect, params, chance } = prepared;
    const target = effect.target === 'enemy' ? context.target : owner;
    if (!target || !target.isAlive) continue;
    const roundLimit = normalizeRoundLimit(params.round_limit);
    const quotaKey = buildTriggerQuotaKey(effect, params);
    if (isRoundLimitReached(owner, state.roundCount, quotaKey, roundLimit)) continue;
    if (!passChance(state, chance)) continue;

    let applyResult: SetBonusApplyResult | null = null;
    switch (effect.effectType) {
      case 'buff':
      case 'debuff':
        applyResult = applySetBuffOrDebuff(effect, owner, target, params);
        break;
      case 'damage':
        applyResult = applySetDamage(state, owner, target, params, context.damage, context.damageType);
        break;
      case 'heal':
        applyResult = applySetHeal(owner, target, params);
        break;
      case 'resource':
        applyResult = applySetResource(owner, target, params);
        break;
      case 'shield':
        applyResult = applySetShield(effect, owner, target, params, context.damage);
        break;
      case 'mark':
        applyResult = applySetMark(state, effect, owner, target, params);
        break;
      case 'pursuit':
        applyResult = applySetPursuit(state, owner, target, params);
        break;
      default:
        break;
    }

    if (!applyResult) continue;
    consumeRoundLimit(owner, state.roundCount, quotaKey, roundLimit);
    logs.push(buildSetBonusActionLog(state, owner, effect, applyResult.targetResult));
    if (Array.isArray(applyResult.extraLogs) && applyResult.extraLogs.length > 0) {
      logs.push(...applyResult.extraLogs);
    }
  }

  return logs;
}

function applySetBuffOrDebuff(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const modifier = resolveSetBuffAttrModifier(target, params);
  const duration = normalizeDuration(effect.durationRound);
  const isDebuff = effect.effectType === 'debuff';

  if (modifier) {
    const buffDefId = buildSetBuffDefId(effect, modifier.attrKey);
    const buffName = `${effect.setName}${isDebuff ? '负面' : '增益'}`;
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: buffName,
        type: isDebuff ? 'debuff' : 'buff',
        category: 'set_bonus',
        sourceUnitId: owner.id,
        maxStacks: 1,
        attrModifiers: [{ attr: modifier.attrKey, value: isDebuff ? -Math.abs(modifier.value) : modifier.value, mode: modifier.applyType }],
        tags: ['set_bonus', effect.setId],
        dispellable: true,
      },
      duration,
      1
    );
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        buffsApplied: [buffName],
      },
    };
  }

  const debuffType = asNonEmptyString(params.debuff_type);
  if (isDebuff && debuffType === 'bleed') {
    const rawValue = asFiniteNumber(params.value) ?? 0;
    const dotDamage = Math.max(
      1,
      Math.floor(owner.currentAttrs.wugong * normalizeRate(rawValue))
    );
    const buffDefId = buildSetBuffDefId(effect, 'bleed');
    const buffName = `${effect.setName}·流血`;
    addBuff(
      target,
      {
        id: `${buffDefId}-${Date.now()}`,
        buffDefId,
        name: buffName,
        type: 'debuff',
        category: 'set_bonus',
        sourceUnitId: owner.id,
        maxStacks: 1,
        dot: {
          damage: dotDamage,
          damageType: 'true',
        },
        tags: ['set_bonus', effect.setId, 'bleed'],
        dispellable: true,
      },
      duration,
      1
    );
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        buffsApplied: [buffName],
      },
    };
  }

  return null;
}

function applySetDamage(
  state: BattleState,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>,
  sourceDamage?: number,
  sourceDamageType?: 'physical' | 'magic' | 'true',
): SetBonusApplyResult | null {
  const rawValue = asFiniteNumber(params.value) ?? 0;
  const damageTypeRaw = asNonEmptyString(params.damage_type) ?? 'true';

  let damage = 0;
  /**
   * 触发伤害模式说明：
   * 1) reflect：沿用旧规则，按“本次受击伤害 × 比例”反弹伤害；
   * 2) echo：新机制“回响伤害”，按“本次命中伤害 × 比例”追加真伤；
   * 3) 其他模式：按词条基础值结算（可叠加 scale）。
   *
   * 边界：
   * - reflect/echo 依赖 sourceDamage，若缺失或 <=0，则本次不生效；
   * - echo 设计为纯比例机制，不叠加 scale，避免与“固定值+比例”混合。
   */
  if (damageTypeRaw === 'reflect' || damageTypeRaw === 'echo') {
    damage += calculateReactiveDamageByRate(
      sourceDamage ?? 0,
      normalizeRate(rawValue),
      damageTypeRaw === 'reflect' ? Math.max(0, 1 - target.currentAttrs.jianfantan) : 1,
    );
  } else {
    damage += Math.floor(rawValue);
  }

  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRateRaw = asFiniteNumber(params.scale_rate);
  if (damageTypeRaw !== 'echo' && scaleKey && scaleRateRaw !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    damage += Math.floor(attrValue * normalizeRate(scaleRateRaw));
  }

  if (damage <= 0) return null;

  const damageType = normalizeDamageType(damageTypeRaw);
  const reactiveDamageResult =
    damageTypeRaw === 'reflect'
      ? sourceDamageType
        ? applyReactiveDamage(state, owner, target, damage, sourceDamageType)
        : null
      : damageTypeRaw === 'echo'
        ? applyReactiveTrueDamage(state, owner, target, damage)
      : null;
  const directDamageResult = reactiveDamageResult
    ? null
    : applyDirectSetDamage(state, owner, target, damage, damageType);
  const finalDamageResult = reactiveDamageResult ?? directDamageResult;
  if (!finalDamageResult) return null;

  return {
    targetResult: {
      ...buildTargetResultBase(target),
      hits: [finalDamageResult.hit],
      damage: finalDamageResult.actualDamage,
      shieldAbsorbed: finalDamageResult.shieldAbsorbed,
    },
    extraLogs: finalDamageResult.extraLogs,
  };
}

function applyDirectSetDamage(
  state: BattleState,
  owner: BattleUnit,
  target: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true'
) {
  const wasAlive = target.isAlive;
  const { actualDamage, shieldAbsorbed } = applyDamage(state, target, Math.max(1, damage), damageType);
  const safeDamage = Math.max(0, actualDamage);
  const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
  owner.stats.damageDealt += safeDamage;

  const extraLogs: BattleLogEntry[] = [];
  if (wasAlive && !target.isAlive) {
    owner.stats.killCount += 1;
    extraLogs.push({
      type: 'death',
      round: state.roundCount,
      unitId: target.id,
      unitName: target.name,
      killerId: owner.id,
      killerName: owner.name,
    });
  }

  return {
    actualDamage: safeDamage,
    shieldAbsorbed: safeShieldAbsorbed,
    hit: {
      index: 1,
      damage: safeDamage,
      isMiss: false,
      isCrit: false,
      isParry: false,
      isElementBonus: false,
      shieldAbsorbed: safeShieldAbsorbed,
    },
    extraLogs,
  };
}

function applySetHeal(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const base = asFiniteNumber(params.value) ?? 0;
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRateRaw = asFiniteNumber(params.scale_rate);

  let healAmount = Math.floor(base);
  if (scaleKey && scaleRateRaw !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    healAmount += Math.floor(attrValue * normalizeRate(scaleRateRaw));
  }
  if (healAmount <= 0) return null;

  const actualHeal = applyHealing(target, healAmount);
  if (actualHeal > 0) {
    owner.stats.healingDone += actualHeal;
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        heal: actualHeal,
      },
    };
  }

  return null;
}

function applySetPursuit(
  state: BattleState,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const rawRate = asFiniteNumber(params.value);
  if (rawRate === null || rawRate <= 0) return null;

  const scaleKey = asNonEmptyString(params.scale_key) ?? 'main_attack';
  const scaleValue = resolvePursuitScaleValue(owner, scaleKey);
  if (scaleValue <= 0) return null;

  const damage = Math.max(1, Math.floor(scaleValue * normalizeRate(rawRate)));
  const damageType = resolvePursuitDamageType(owner, scaleKey, asNonEmptyString(params.damage_type));
  const finalDamageResult = applyCalculatedSetDamage(state, owner, target, damage, damageType);

  return {
    targetResult: {
      ...buildTargetResultBase(target),
      hits: [finalDamageResult.hit],
      damage: finalDamageResult.actualDamage,
      shieldAbsorbed: finalDamageResult.shieldAbsorbed,
    },
    extraLogs: finalDamageResult.extraLogs,
  };
}

function applyCalculatedSetDamage(
  state: BattleState,
  owner: BattleUnit,
  target: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true'
) {
  const damageResult = calculateDamage(state, owner, target, {
    baseDamage: Math.max(1, damage),
    damageType,
  });

  if (damageResult.isMiss) {
    return {
      actualDamage: 0,
      shieldAbsorbed: 0,
      hit: {
        index: 1,
        damage: 0,
        isMiss: true,
        isCrit: false,
        isParry: false,
        isElementBonus: false,
        shieldAbsorbed: 0,
      },
      extraLogs: [] as BattleLogEntry[],
    };
  }

  const wasAlive = target.isAlive;
  const { actualDamage, shieldAbsorbed } = applyDamage(state, target, damageResult.damage, damageType);
  const safeDamage = Math.max(0, actualDamage);
  const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
  owner.stats.damageDealt += safeDamage;

  const extraLogs: BattleLogEntry[] = [];
  if (wasAlive && !target.isAlive) {
    owner.stats.killCount += 1;
    extraLogs.push({
      type: 'death',
      round: state.roundCount,
      unitId: target.id,
      unitName: target.name,
      killerId: owner.id,
      killerName: owner.name,
    });
  }

  return {
    actualDamage: safeDamage,
    shieldAbsorbed: safeShieldAbsorbed,
    hit: {
      index: 1,
      damage: safeDamage,
      isMiss: false,
      isCrit: damageResult.isCrit,
      isParry: damageResult.isParry,
      isElementBonus: damageResult.isElementBonus,
      shieldAbsorbed: safeShieldAbsorbed,
    },
    extraLogs,
  };
}

function applySetResource(
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const resourceType = asNonEmptyString(params.resource_type) ?? asNonEmptyString(params.resource);
  const value = asFiniteNumber(params.value);
  if (!resourceType || value === null) return null;

  const amount = Math.floor(value);
  if (amount <= 0) return null;

  if (resourceType === 'qixue') {
    const actualHeal = applyHealing(target, amount);
    if (actualHeal > 0) {
      owner.stats.healingDone += actualHeal;
      return {
        targetResult: {
          ...buildTargetResultBase(target),
          heal: actualHeal,
        },
      };
    }
    return null;
  }

  if (resourceType === 'lingqi') {
    const effectiveAmount = applySoulShackleRecoveryReduction(amount, target);
    if (effectiveAmount <= 0) return null;
    const before = target.lingqi;
    const after = Math.min(target.currentAttrs.max_lingqi, before + effectiveAmount);
    const gain = Math.max(0, after - before);
    target.lingqi = after;
    if (gain <= 0) return null;
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        resources: [{ type: 'lingqi', amount: gain }],
      },
    };
  }

  return null;
}

function applySetShield(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>,
  sourceDamage?: number
): SetBonusApplyResult | null {
  const baseValue = asFiniteNumber(params.value) ?? 0;
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRate = asFiniteNumber(params.scale_rate);
  const shieldModeRaw = asNonEmptyString(params.shield_mode);

  /**
   * 护盾模式说明：
   * 1) damage_echo：新机制“受击回璧”，按“本次受击伤害 × 比例”生成护盾；
   * 2) 默认模式：沿用旧规则，按基础值 + 可选 scale 生成护盾。
   *
   * 边界：
   * - damage_echo 必须依赖 sourceDamage，缺失或 <=0 时不生效；
   * - 护盾值 <=0 时直接忽略，避免写入无效护盾实例。
   */
  let shieldValue = 0;
  if (shieldModeRaw === 'damage_echo') {
    if (typeof sourceDamage !== 'number' || sourceDamage <= 0) return null;
    shieldValue = Math.floor(sourceDamage * normalizeRate(baseValue));
  } else {
    shieldValue = Math.floor(baseValue);
    if (scaleKey && scaleRate !== null) {
      const scaleAttr = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
      shieldValue += Math.floor(scaleAttr * normalizeRate(scaleRate));
    }
  }

  if (shieldValue <= 0) return null;

  const absorbTypeRaw = asNonEmptyString(params.absorb_type);
  const absorbType = absorbTypeRaw === 'physical' || absorbTypeRaw === 'magic' ? absorbTypeRaw : 'all';
  const duration = normalizeDuration(effect.durationRound);

  addShield(
    target,
    {
      value: shieldValue,
      maxValue: shieldValue,
      duration,
      absorbType,
      priority: 1,
      sourceSkillId: effect.setId,
    },
    owner.id,
  );

  return {
    targetResult: {
      ...buildTargetResultBase(target),
      buffsApplied: [`${effect.setName}·护盾`],
    },
  };
}

function applySetMark(
  state: BattleState,
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>
): SetBonusApplyResult | null {
  const config = resolveMarkEffectConfig(params);
  if (!config) return null;

  if (config.operation === 'apply') {
    const applied = applyMarkStacks(target, owner.id, config);
    if (!applied.applied) return null;
    return {
      targetResult: {
        ...buildTargetResultBase(target),
        marksApplied: [applied.text],
      },
    };
  }

  let baseValue = Math.max(0, Math.floor(asFiniteNumber(params.value) ?? 0));
  const scaleKey = asNonEmptyString(params.scale_key);
  const scaleRate = asFiniteNumber(params.scale_rate);
  if (scaleKey && scaleRate !== null) {
    const attrValue = asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
    baseValue += Math.max(0, Math.floor(attrValue * normalizeRate(scaleRate)));
  }

  const consumed = consumeMarkStacks(
    target,
    owner.id,
    config,
    baseValue,
    target.currentAttrs.max_qixue
  );
  if (!consumed.consumed) return null;

  const consumeText = consumed.wasCapped ? `${consumed.text}（触发35%上限）` : consumed.text;
  const convertedValue = Math.max(0, consumed.finalValue);
  const targetResult: TargetResult = {
    ...buildTargetResultBase(target),
    marksConsumed: [consumeText],
  };
  applyMarkConsumeRuntimeAddon({
    caster: owner,
    target,
    config,
    consumed,
    targetResult,
    sourceSkillId: effect.setId,
  });

  if (convertedValue <= 0) {
    return { targetResult };
  }

  if (consumed.resultType === 'damage') {
    const wasAlive = target.isAlive;
    const { actualDamage, shieldAbsorbed } = applyDamage(state, target, convertedValue, 'true');
    const safeDamage = Math.max(0, actualDamage);
    const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
    owner.stats.damageDealt += safeDamage;

    const extraLogs: BattleLogEntry[] = [];
    if (wasAlive && !target.isAlive) {
      owner.stats.killCount += 1;
      extraLogs.push({
        type: 'death',
        round: state.roundCount,
        unitId: target.id,
        unitName: target.name,
        killerId: owner.id,
        killerName: owner.name,
      });
    }

    targetResult.hits = [
      {
        index: 1,
        damage: safeDamage,
        isMiss: false,
        isCrit: false,
        isParry: false,
        isElementBonus: false,
        shieldAbsorbed: safeShieldAbsorbed,
      },
    ];
    targetResult.damage = safeDamage;
    targetResult.shieldAbsorbed = safeShieldAbsorbed;
    return {
      targetResult,
      extraLogs,
    };
  }

  if (consumed.resultType === 'shield_self') {
    const duration = normalizeDuration(effect.durationRound);
    addShield(
      owner,
      {
        value: convertedValue,
        maxValue: convertedValue,
        duration,
        absorbType: 'all',
        priority: 1,
        sourceSkillId: effect.setId,
      },
      owner.id
    );
    if (target.id === owner.id) {
      targetResult.buffsApplied = [`${effect.setName}·护盾`];
    }
    return { targetResult };
  }

  const actualHeal = applyHealing(owner, convertedValue);
  if (actualHeal > 0) {
    owner.stats.healingDone += actualHeal;
    if (target.id === owner.id) {
      targetResult.heal = actualHeal;
    }
  }
  return { targetResult };
}

function buildPreparedTriggerEffects(
  effects: BattleSetBonusEffect[],
  trigger: BattleSetBonusTrigger
): PreparedTriggerEffect[] {
  type OrderedPreparedTriggerEffect = PreparedTriggerEffect & { order: number };
  type PreparedTriggerGroup = { order: number; entries: PreparedTriggerEffect[] };

  const singles: OrderedPreparedTriggerEffect[] = [];
  const groups = new Map<string, PreparedTriggerGroup>();
  let order = 0;

  for (const effect of effects) {
    if (effect.trigger !== trigger) continue;

    const params = toObject(effect.params);
    const prepared: PreparedTriggerEffect = {
      effect,
      params,
      chance: normalizeChance(params.chance),
    };
    const groupKey = buildAffixGroupKey(effect, params);
    if (!groupKey) {
      singles.push({ ...prepared, order });
      order += 1;
      continue;
    }

    const existed = groups.get(groupKey);
    if (existed) {
      existed.entries.push(prepared);
      continue;
    }
    groups.set(groupKey, {
      order,
      entries: [prepared],
    });
    order += 1;
  }

  const mergedGroups: OrderedPreparedTriggerEffect[] = [];
  for (const group of groups.values()) {
    mergedGroups.push({
      ...mergePreparedTriggerGroup(group.entries),
      order: group.order,
    });
  }

  return [...singles, ...mergedGroups]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _, ...rest }) => rest);
}

function mergePreparedTriggerGroup(entries: PreparedTriggerEffect[]): PreparedTriggerEffect {
  if (entries.length === 0) {
    throw new Error('mergePreparedTriggerGroup: entries 不能为空');
  }
  if (entries.length === 1) return entries[0];

  // 同词条多件装备：概率按“至少触发一次”合并，避免直接加算与重复触发。
  const combinedChance = mergeIndependentChances(entries.map((entry) => entry.chance));
  const representative = pickRepresentativeEntry(entries);
  return {
    effect: representative.effect,
    params: representative.params,
    chance: combinedChance,
  };
}

function pickRepresentativeEntry(entries: PreparedTriggerEffect[]): PreparedTriggerEffect {
  if (entries.length === 0) {
    throw new Error('pickRepresentativeEntry: entries 不能为空');
  }

  let picked = entries[0];
  let pickedScore = getEntryStrengthScore(picked.params);

  for (let i = 1; i < entries.length; i += 1) {
    const current = entries[i];
    if (!current) continue;
    const score = getEntryStrengthScore(current.params);
    if (score > pickedScore) {
      picked = current;
      pickedScore = score;
    }
  }

  return picked;
}

function getEntryStrengthScore(params: Record<string, unknown>): number {
  const value = asFiniteNumber(params.value) ?? 0;
  const scaleRate = asFiniteNumber(params.scale_rate) ?? 0;
  return value + scaleRate;
}

function buildAffixGroupKey(
  effect: BattleSetBonusEffect,
  params: Record<string, unknown>
): string | null {
  const explicitKey = asNonEmptyString(params.affix_key);
  if (explicitKey) return `affix:${explicitKey}`;

  if (!effect.setId.startsWith('affix-')) return null;
  const parts = effect.setId.split('-');
  if (parts.length < 3) return null;
  const fallbackKey = parts.slice(2).join('-').trim();
  if (!fallbackKey) return null;
  return `affix:${fallbackKey}`;
}

function buildTriggerQuotaKey(
  effect: BattleSetBonusEffect,
  params: Record<string, unknown>
): string {
  return buildAffixGroupKey(effect, params) ?? `set:${effect.setId}`;
}

function normalizeRoundLimit(value: unknown): number | null {
  const limit = asFiniteNumber(value);
  if (limit === null) return null;
  return Math.max(1, Math.floor(limit));
}

function getOrCreateTriggerState(owner: BattleUnit, round: number) {
  if (!owner.setBonusTriggerState || owner.setBonusTriggerState.round !== round) {
    owner.setBonusTriggerState = {
      round,
      counts: {},
    };
  }
  return owner.setBonusTriggerState;
}

function isRoundLimitReached(
  owner: BattleUnit,
  round: number,
  quotaKey: string,
  roundLimit: number | null
): boolean {
  if (roundLimit === null) return false;
  const triggerState = getOrCreateTriggerState(owner, round);
  return (triggerState.counts[quotaKey] ?? 0) >= roundLimit;
}

function consumeRoundLimit(
  owner: BattleUnit,
  round: number,
  quotaKey: string,
  roundLimit: number | null
): void {
  if (roundLimit === null) return;
  const triggerState = getOrCreateTriggerState(owner, round);
  triggerState.counts[quotaKey] = (triggerState.counts[quotaKey] ?? 0) + 1;
}

function normalizeChance(value: unknown): number {
  const chanceRaw = asFiniteNumber(value);
  if (chanceRaw === null) return 1;
  return Math.max(0, Math.min(1, chanceRaw));
}

function mergeIndependentChances(chances: number[]): number {
  let missChance = 1;
  for (const chance of chances) {
    missChance *= 1 - Math.max(0, Math.min(1, chance));
  }
  return 1 - missChance;
}

function passChance(state: BattleState, chance: number): boolean {
  if (chance >= 1) return true;
  if (chance <= 0) return false;
  return rollChance(state, chance);
}

function normalizeRate(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeDamageType(value: string): 'physical' | 'magic' | 'true' {
  if (value === 'physical') return 'physical';
  if (value === 'magic') return 'magic';
  return 'true';
}

function resolvePursuitScaleValue(owner: BattleUnit, scaleKey: string): number {
  if (scaleKey === 'main_attack') {
    return Math.max(owner.currentAttrs.wugong, owner.currentAttrs.fagong);
  }
  return asFiniteNumber(readAttrValue(owner, scaleKey)) ?? 0;
}

function resolvePursuitDamageType(
  owner: BattleUnit,
  scaleKey: string,
  damageTypeRaw: string | null
): 'physical' | 'magic' | 'true' {
  if (damageTypeRaw === 'physical' || damageTypeRaw === 'magic' || damageTypeRaw === 'true') {
    return damageTypeRaw;
  }
  if (scaleKey === 'wugong') return 'physical';
  if (scaleKey === 'fagong') return 'magic';
  return owner.currentAttrs.wugong >= owner.currentAttrs.fagong ? 'physical' : 'magic';
}

function normalizeDuration(value: unknown): number {
  const n = asFiniteNumber(value);
  if (n === null) return 1;
  return Math.max(1, Math.floor(n));
}

function buildSetBuffDefId(effect: BattleSetBonusEffect, suffix: string): string {
  return `set-${effect.setId}-${effect.pieceCount}-${effect.trigger}-${suffix}`;
}

function buildSetBonusActionLog(
  state: BattleState,
  owner: BattleUnit,
  effect: BattleSetBonusEffect,
  targetResult: TargetResult
): ActionLog {
  return {
    type: 'action',
    round: state.roundCount,
    actorId: owner.id,
    actorName: owner.name,
    skillId: `proc-${effect.setId}`,
    skillName: effect.setName,
    targets: [targetResult],
  };
}

function buildTargetResultBase(target: BattleUnit): TargetResult {
  return {
    targetId: target.id,
    targetName: target.name,
    hits: [],
  };
}

function asApplyType(value: unknown): 'flat' | 'percent' | null {
  if (value === 'flat') return 'flat';
  if (value === 'percent') return 'percent';
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out ? out : null;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readAttrValue(owner: BattleUnit, key: string): unknown {
  return (owner.currentAttrs as unknown as Record<string, unknown>)[key];
}
