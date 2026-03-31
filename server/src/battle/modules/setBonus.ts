/**
 * 九州修仙录 - 套装战斗效果执行模块
 * 仅处理战斗期触发型套装效果（equip 常驻属性已在穿戴时写入角色）
 */

import type {
  ActionLog,
  BattleLogEntry,
  BattleSkill,
  BattleSetBonusEffect,
  BattleSetBonusTrigger,
  BattleState,
  MagicSkillSnapshot,
  TargetResult,
  BattleUnit,
} from '../types.js';
import type { SkillAffixTriggerRuntimeState } from '../utils/affixTriggerBudget.js';
import { rollChance } from '../utils/random.js';
import {
  buildSkillAffixTriggerRuntimeKey,
  consumeSkillAffixTriggerSuccess,
  readSkillAffixTriggerSuccessCount,
  resolveAffixTriggerChanceBySuccessCount,
} from '../utils/affixTriggerBudget.js';
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
import { reduceSkillCooldownRemainingRounds } from '../utils/cooldown.js';
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
  skill?: BattleSkill;
  magicSkillSnapshot?: MagicSkillSnapshot | null;
  affixTriggerRuntimeState?: SkillAffixTriggerRuntimeState;
}

interface SetBonusApplyResult {
  targetResult: TargetResult;
  extraLogs?: BattleLogEntry[];
  skipDefaultActionLog?: boolean;
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

const EXCLUSIVE_SET_EFFECT_TYPE_SET = new Set(['spell_projection', 'defer_damage', 'extra_action']);

function isSupersededExclusiveSetEffect(
  effects: BattleSetBonusEffect[],
  effect: BattleSetBonusEffect,
): boolean {
  if (!EXCLUSIVE_SET_EFFECT_TYPE_SET.has(effect.effectType)) return false;
  return effects.some(
    (candidate) =>
      candidate !== effect
      && candidate.trigger === effect.trigger
      && candidate.setId === effect.setId
      && candidate.effectType === effect.effectType
      && candidate.pieceCount > effect.pieceCount,
  );
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
    const affixGroupKey = buildAffixGroupKey(effect, params);
    const quotaKey = affixGroupKey ?? `set:${effect.setId}`;
    const scaledChance = resolveTriggerChance(owner, affixGroupKey, chance, context.affixTriggerRuntimeState);
    if (isRoundLimitReached(owner, state.roundCount, quotaKey, roundLimit)) continue;
    if (!passChance(state, scaledChance)) continue;

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
      case 'spell_projection':
        applyResult = applySetSpellProjection(state, effect, owner, context.skill, context.magicSkillSnapshot);
        break;
      case 'defer_damage':
        applyResult = applySetDeferredShield(effect, owner, params);
        break;
      case 'extra_action':
        applyResult = applySetExtraAction(effect, owner, target, params, context.damage);
        break;
      default:
        break;
    }

    if (!applyResult) continue;
    consumeRoundLimit(owner, state.roundCount, quotaKey, roundLimit);
    consumeAffixTriggerSuccessState(owner, affixGroupKey, context.affixTriggerRuntimeState);
    if (!applyResult.skipDefaultActionLog) {
      logs.push(buildSetBonusActionLog(state, owner, effect, applyResult.targetResult));
    }
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

function applySetSpellProjection(
  state: BattleState,
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  skill?: BattleSkill,
  magicSkillSnapshot?: MagicSkillSnapshot | null,
): SetBonusApplyResult | null {
  if (effect.trigger !== 'after_skill') return null;
  if (!skill || !magicSkillSnapshot) return null;
  if (magicSkillSnapshot.hitCount <= 0 || magicSkillSnapshot.averageFinalDamage <= 0) return null;

  const params = toObject(effect.params);
  const projectionName = asNonEmptyString(params.projection_name)
    ?? (effect.pieceCount >= 8 ? '两仪流照' : '周天衍光');
  const ignoreDefenseRate = Math.max(0, Math.min(1, asFiniteNumber(params.ignore_fafang_rate) ?? 0));
  const singleSplitRate = Math.max(0, asFiniteNumber(params.single_split_rate) ?? 0);
  const multiFocusRate = Math.max(0, asFiniteNumber(params.multi_focus_rate) ?? 0);
  const singleReturnRate = Math.max(0, asFiniteNumber(params.single_return_rate) ?? 0);
  const multiReturnRate = Math.max(0, asFiniteNumber(params.multi_return_rate) ?? 0);
  const lingqiRestore = Math.max(0, Math.floor(asFiniteNumber(params.lingqi_restore) ?? 0));
  const cooldownReduceIfFull = Math.max(0, Math.floor(asFiniteNumber(params.cooldown_reduce_if_full) ?? 0));

  const baseDamage = Math.max(1, Math.floor(magicSkillSnapshot.averageFinalDamage));
  const isSingleHitSkill = magicSkillSnapshot.hitCount === 1;
  const projectionLogs: BattleLogEntry[] = [];
  let projectionHitCount = 0;

  const applyProjectionWave = (
    targets: BattleUnit[],
    rate: number,
    waveName: string,
  ): void => {
    const safeRate = Math.max(0, rate);
    if (targets.length <= 0 || safeRate <= 0) return;

    const targetResults: TargetResult[] = [];
    const waveLogs: BattleLogEntry[] = [];
    const projectedDamage = Math.max(1, Math.floor(baseDamage * safeRate));
    for (const target of targets) {
      if (!target.isAlive) continue;
      const calculated = calculateDamage(state, owner, target, {
        baseDamage: projectedDamage,
        damageType: 'magic',
        element: magicSkillSnapshot.element ?? skill.element ?? effect.element,
        ignoreDefenseRate,
      });
      const targetResult = buildTargetResultBase(target);
      if (calculated.isMiss) {
        targetResult.hits = [{
          index: 1,
          damage: 0,
          isMiss: true,
          isCrit: false,
          isParry: false,
          isElementBonus: false,
          shieldAbsorbed: 0,
        }];
        targetResults.push(targetResult);
        continue;
      }

      const wasAlive = target.isAlive;
      const { actualDamage, shieldAbsorbed } = applyDamage(state, target, calculated.damage, 'magic');
      const safeActualDamage = Math.max(0, actualDamage);
      const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
      owner.stats.damageDealt += safeActualDamage;
      targetResult.hits = [{
        index: 1,
        damage: safeActualDamage,
        isMiss: false,
        isCrit: calculated.isCrit,
        isParry: calculated.isParry,
        isElementBonus: calculated.isElementBonus,
        shieldAbsorbed: safeShieldAbsorbed,
      }];
      targetResult.damage = safeActualDamage;
      targetResult.shieldAbsorbed = safeShieldAbsorbed;
      targetResults.push(targetResult);

      if (safeActualDamage > 0) {
        projectionHitCount += 1;
      }
      if (wasAlive && !target.isAlive) {
        owner.stats.killCount += 1;
        waveLogs.push({
          type: 'death',
          round: state.roundCount,
          unitId: target.id,
          unitName: target.name,
          killerId: owner.id,
          killerName: owner.name,
        });
      }
    }

    if (targetResults.length <= 0) return;
    projectionLogs.push({
      type: 'action',
      round: state.roundCount,
      actorId: owner.id,
      actorName: owner.name,
      skillId: 'proc-set-tianyan-zhouyan',
      skillName: waveName,
      targets: targetResults,
    });
    projectionLogs.push(...waveLogs);
  };

  if (isSingleHitSkill) {
    const splitTargets = getAliveEnemyUnits(state, owner)
      .filter((unit) => !magicSkillSnapshot.hitTargetIds.includes(unit.id));
    applyProjectionWave(splitTargets, singleSplitRate, projectionName);

    if (effect.pieceCount >= 8 && singleReturnRate > 0) {
      const primaryTarget = magicSkillSnapshot.primaryTargetId
        ? findAliveUnitById(state, magicSkillSnapshot.primaryTargetId)
        : null;
      if (primaryTarget) {
        applyProjectionWave([primaryTarget], singleReturnRate, '回天照');
      }
    }
  } else {
    const focusTarget = pickLowestQixueAliveUnit(state, magicSkillSnapshot.hitTargetIds);
    if (focusTarget) {
      applyProjectionWave([focusTarget], multiFocusRate, projectionName);
    }
    if (effect.pieceCount >= 8 && multiReturnRate > 0) {
      const returnTargets = magicSkillSnapshot.hitTargetIds
        .map((targetId) => findAliveUnitById(state, targetId))
        .filter((target): target is BattleUnit => Boolean(target));
      applyProjectionWave(returnTargets, multiReturnRate, '流辉照');
    }
  }

  if (projectionLogs.length <= 0) return null;

  if (projectionHitCount >= 2) {
    if (owner.lingqi < owner.currentAttrs.max_lingqi) {
      const actualRestore = Math.min(
        owner.currentAttrs.max_lingqi - owner.lingqi,
        lingqiRestore,
      );
      owner.lingqi += actualRestore;
    } else if (skill.id && cooldownReduceIfFull > 0) {
      reduceSkillCooldownRemainingRounds(owner, skill.id, cooldownReduceIfFull);
    }
  }

  return {
    targetResult: buildTargetResultBase(owner),
    extraLogs: projectionLogs,
    skipDefaultActionLog: true,
  };
}

function applySetDeferredShield(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  params: Record<string, unknown>,
): SetBonusApplyResult | null {
  if (effect.trigger !== 'on_turn_start') return null;
  const deferred = owner.deferredDamageState;
  if (!deferred || deferred.pool <= 0) return null;

  const shieldRate = Math.max(0, asFiniteNumber(params.shield_rate) ?? 0);
  const shieldValue = Math.max(0, Math.floor(deferred.pool * shieldRate));
  if (shieldValue <= 0) return null;

  addShield(owner, {
    value: shieldValue,
    maxValue: shieldValue,
    duration: 1,
    absorbType: 'all',
    priority: 1,
    sourceSkillId: effect.setId,
  }, owner.id);

  return {
    targetResult: {
      ...buildTargetResultBase(owner),
      buffsApplied: ['承劫护身'],
    },
  };
}

function applySetExtraAction(
  effect: BattleSetBonusEffect,
  owner: BattleUnit,
  target: BattleUnit,
  params: Record<string, unknown>,
  sourceDamage?: number,
): SetBonusApplyResult | null {
  if (effect.trigger !== 'on_hit' || !target || typeof sourceDamage !== 'number' || sourceDamage <= 0) {
    return null;
  }

  const thresholdRate = Math.max(0, asFiniteNumber(params.damage_threshold_max_qixue_rate) ?? 0);
  const maxActionsPerRound = Math.max(1, Math.floor(asFiniteNumber(params.max_actions_per_round) ?? 1));
  const extraState = ensureExtraActionState(owner);
  let changed = false;
  const appliedTexts: string[] = [];

  const thresholdDamage = Math.floor(target.currentAttrs.max_qixue * thresholdRate);
  if (
    !extraState.currentActionIsExtra
    && thresholdDamage > 0
    && sourceDamage >= thresholdDamage
    && extraState.grantedThisRound < maxActionsPerRound
  ) {
    extraState.charges += 1;
    extraState.grantedThisRound += 1;
    changed = true;
    appliedTexts.push('踏虚续步');
  }

  const lowQixueRefundRate = Math.max(0, asFiniteNumber(params.low_qixue_refund_rate) ?? 0);
  const qixueBefore = Math.max(0, target.qixue + sourceDamage);
  const crossedThreshold = effect.pieceCount >= 8
    && extraState.currentActionIsExtra
    && qixueBefore > Math.floor(target.currentAttrs.max_qixue * lowQixueRefundRate)
    && target.qixue <= Math.floor(target.currentAttrs.max_qixue * lowQixueRefundRate);
  const killRefund = effect.pieceCount >= 8 && extraState.currentActionIsExtra && !target.isAlive;
  if ((crossedThreshold || killRefund) && extraState.grantedThisRound < maxActionsPerRound) {
    extraState.charges += 1;
    extraState.grantedThisRound += 1;
    changed = true;
    appliedTexts.push('踏虚回锋');
  }

  if (!changed) return null;

  return {
    targetResult: {
      ...buildTargetResultBase(owner),
      buffsApplied: appliedTexts,
    },
  };
}

function ensureExtraActionState(unit: BattleUnit) {
  if (!unit.extraActionState) {
    unit.extraActionState = {
      charges: 0,
      grantedThisRound: 0,
      currentActionIsExtra: false,
    };
  }
  return unit.extraActionState;
}

function getAliveEnemyUnits(state: BattleState, owner: BattleUnit): BattleUnit[] {
  const ownerInAttacker = state.teams.attacker.units.some((unit) => unit.id === owner.id);
  const team = ownerInAttacker ? state.teams.defender : state.teams.attacker;
  return team.units.filter((unit) => unit.isAlive);
}

function findAliveUnitById(state: BattleState, unitId: string): BattleUnit | null {
  for (const unit of [...state.teams.attacker.units, ...state.teams.defender.units]) {
    if (unit.id === unitId && unit.isAlive) return unit;
  }
  return null;
}

function pickLowestQixueAliveUnit(state: BattleState, unitIds: string[]): BattleUnit | null {
  let picked: BattleUnit | null = null;
  for (const unitId of unitIds) {
    const unit = findAliveUnitById(state, unitId);
    if (!unit) continue;
    if (!picked || unit.qixue < picked.qixue) {
      picked = unit;
    }
  }
  return picked;
}

export function applySetDeferredDamageBeforeHit(
  state: BattleState,
  owner: BattleUnit,
  attacker: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true',
): { damage: number; logs: BattleLogEntry[] } {
  if (damage <= 0 || (damageType !== 'physical' && damageType !== 'magic')) {
    return { damage, logs: [] };
  }

  const preparedEffects = buildPreparedTriggerEffects(owner.setBonusEffects ?? [], 'on_be_hit');
  const logs: BattleLogEntry[] = [];
  let nextDamage = damage;

  for (const prepared of preparedEffects) {
    const { effect, params, chance } = prepared;
    if (effect.effectType !== 'defer_damage') continue;
    const roundLimit = normalizeRoundLimit(params.round_limit);
    const quotaKey = `set:${effect.setId}:defer_damage`;
    if (isRoundLimitReached(owner, state.roundCount, quotaKey, roundLimit)) continue;
    if (!passChance(state, chance)) continue;

    const thresholdRate = Math.max(0, asFiniteNumber(params.threshold_max_qixue_rate) ?? 0);
    const convertRate = Math.max(0, Math.min(1, asFiniteNumber(params.convert_rate) ?? 0));
    const settleRate = Math.max(0, Math.min(1, asFiniteNumber(params.settle_rate) ?? 0.5));
    const remainingRounds = Math.max(1, Math.floor(asFiniteNumber(params.remaining_rounds) ?? 2));
    const thresholdDamage = Math.floor(owner.currentAttrs.max_qixue * thresholdRate);
    if (thresholdDamage <= 0 || nextDamage < thresholdDamage || convertRate <= 0) continue;

    const convertedDamage = Math.max(1, Math.floor(nextDamage * convertRate));
    nextDamage = Math.max(1, nextDamage - convertedDamage);
    owner.deferredDamageState = {
      pool: Math.max(0, (owner.deferredDamageState?.pool ?? 0) + convertedDamage),
      remainingRounds,
      settleRate,
      lastSourceUnitId: attacker.id,
      damageType,
    };

    consumeRoundLimit(owner, state.roundCount, quotaKey, roundLimit);
    logs.push({
      type: 'action',
      round: state.roundCount,
      actorId: owner.id,
      actorName: owner.name,
      skillId: `proc-${effect.setId}`,
      skillName: '承劫',
      targets: [{
        ...buildTargetResultBase(owner),
        buffsApplied: [`化去${convertedDamage}点伤害为劫痕`],
      }],
    });
  }

  return { damage: nextDamage, logs };
}

export function settleSetDeferredDamageAtRoundEnd(
  state: BattleState,
  owner: BattleUnit,
): BattleLogEntry[] {
  const deferred = owner.deferredDamageState;
  if (!deferred || deferred.pool <= 0 || !owner.isAlive) return [];
  const damageType = deferred.damageType;
  if (damageType !== 'physical' && damageType !== 'magic') {
    owner.deferredDamageState = null;
    return [];
  }

  const logs: BattleLogEntry[] = [];
  const settleDamage = deferred.remainingRounds <= 1
    ? deferred.pool
    : Math.max(1, Math.floor(deferred.pool * deferred.settleRate));
  if (settleDamage <= 0) {
    owner.deferredDamageState = null;
    return [];
  }

  const wasAlive = owner.isAlive;
  const { actualDamage, shieldAbsorbed } = applyDamage(state, owner, settleDamage, damageType);
  const safeActualDamage = Math.max(0, actualDamage);
  const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
  logs.push({
    type: 'action',
    round: state.roundCount,
    actorId: owner.id,
    actorName: owner.name,
    skillId: 'proc-set-xuanheng-jiehen',
    skillName: '劫痕回落',
    targets: [{
      ...buildTargetResultBase(owner),
      hits: [{
        index: 1,
        damage: safeActualDamage,
        isMiss: false,
        isCrit: false,
        isParry: false,
        isElementBonus: false,
        shieldAbsorbed: safeShieldAbsorbed,
      }],
      damage: safeActualDamage,
      shieldAbsorbed: safeShieldAbsorbed,
      buffsApplied: safeShieldAbsorbed > 0 ? ['护盾承下劫痕'] : undefined,
    }],
  });

  if (wasAlive && !owner.isAlive) {
    const killer = deferred.lastSourceUnitId ? findAliveUnitById(state, deferred.lastSourceUnitId) : null;
    logs.push({
      type: 'death',
      round: state.roundCount,
      unitId: owner.id,
      unitName: owner.name,
      killerId: killer?.id,
      killerName: killer?.name,
    });
  }

  const nextPool = Math.max(0, deferred.pool - settleDamage);
  if (nextPool <= 0 || !owner.isAlive) {
    owner.deferredDamageState = null;
  } else {
    owner.deferredDamageState = {
      ...deferred,
      pool: nextPool,
      remainingRounds: Math.max(0, deferred.remainingRounds - 1),
    };
  }

  if (safeShieldAbsorbed > 0 && getHighestSetPieceCount(owner, 'set-xuanheng') >= 8 && deferred.lastSourceUnitId) {
    const source = findAliveUnitById(state, deferred.lastSourceUnitId);
    if (source) {
      const wasSourceAlive = source.isAlive;
      const reflected = applyDamage(state, source, safeShieldAbsorbed, damageType);
      logs.push({
        type: 'action',
        round: state.roundCount,
        actorId: owner.id,
        actorName: owner.name,
        skillId: 'proc-set-xuanheng-huanjie',
        skillName: '还劫',
        targets: [{
          ...buildTargetResultBase(source),
          hits: [{
            index: 1,
            damage: reflected.actualDamage,
            isMiss: false,
            isCrit: false,
            isParry: false,
            isElementBonus: false,
            shieldAbsorbed: reflected.shieldAbsorbed,
          }],
          damage: reflected.actualDamage,
          shieldAbsorbed: reflected.shieldAbsorbed,
        }],
      });
      if (wasSourceAlive && !source.isAlive) {
        logs.push({
          type: 'death',
          round: state.roundCount,
          unitId: source.id,
          unitName: source.name,
          killerId: owner.id,
          killerName: owner.name,
        });
      }
    }
  }

  return logs;
}

export function resetSetRuntimeStateForRound(unit: BattleUnit): void {
  if (unit.extraActionState) {
    unit.extraActionState.charges = 0;
    unit.extraActionState.grantedThisRound = 0;
    unit.extraActionState.currentActionIsExtra = false;
  }
}

export function consumeExtraActionCharge(unit: BattleUnit): boolean {
  const extraState = unit.extraActionState;
  if (!extraState || extraState.charges <= 0) {
    if (extraState) {
      extraState.currentActionIsExtra = false;
    }
    return false;
  }
  extraState.charges -= 1;
  extraState.currentActionIsExtra = true;
  return true;
}

export function clearCurrentExtraActionFlag(unit: BattleUnit): void {
  if (unit.extraActionState) {
    unit.extraActionState.currentActionIsExtra = false;
  }
}

function getHighestSetPieceCount(unit: BattleUnit, setId: string): number {
  let highest = 0;
  for (const effect of unit.setBonusEffects ?? []) {
    if (effect.setId !== setId) continue;
    if (effect.pieceCount > highest) highest = effect.pieceCount;
  }
  return highest;
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
    if (isSupersededExclusiveSetEffect(effects, effect)) continue;

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

function resolveTriggerChance(
  owner: BattleUnit,
  affixGroupKey: string | null,
  chance: number,
  affixTriggerRuntimeState?: SkillAffixTriggerRuntimeState,
): number {
  if (!affixGroupKey) return chance;
  const runtimeKey = buildSkillAffixTriggerRuntimeKey(owner.id, affixGroupKey);
  const successCount = readSkillAffixTriggerSuccessCount(affixTriggerRuntimeState, runtimeKey);
  return resolveAffixTriggerChanceBySuccessCount(chance, successCount);
}

function consumeAffixTriggerSuccessState(
  owner: BattleUnit,
  affixGroupKey: string | null,
  affixTriggerRuntimeState?: SkillAffixTriggerRuntimeState,
): void {
  if (!affixGroupKey) return;
  const runtimeKey = buildSkillAffixTriggerRuntimeKey(owner.id, affixGroupKey);
  consumeSkillAffixTriggerSuccess(affixTriggerRuntimeState, runtimeKey);
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
