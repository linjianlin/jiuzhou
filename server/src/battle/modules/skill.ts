/**
 * 九州修仙录 - 技能执行模块
 */

import type {
  BattleState,
  BattleUnit,
  BattleSkill,
  SkillEffect,
  AttrModifier,
  AuraEffect,
  AuraSubEffect,
  AuraTargetType,
  DelayedBurstEffect,
  DodgeNextEffect,
  DotEffect,
  HotEffect,
  NextSkillBonusEffect,
  ReflectDamageEffect,
  ActionLog,
  BattleLogEntry,
  TargetHitResult,
  TargetResult
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';
import { calculateDamage, applyDamage } from './damage.js';
import { applyHealing, applyLifesteal } from './healing.js';
import {
  addBuff,
  addShield,
  createDelayedBurstRuntime,
  createNextSkillBonusRuntime,
  getUnitReflectDamageRate,
  removeBuff,
} from './buff.js';
import { tryApplyControl, canUseSkill, isSilenced, isDisarmed } from './control.js';
import { resolveTargets } from './target.js';
import { triggerSetBonusEffects } from './setBonus.js';
import {
  applyMarkStacks,
  applySoulShackleRecoveryReduction,
  consumeMarkStacks,
  resolveMarkEffectConfig,
} from './mark.js';
import { applyMarkConsumeRuntimeAddon } from './markAddonRuntime.js';
import {
  consumeMomentumStacks,
  gainMomentumStacks,
  resolveMomentumEffectConfig,
  type MomentumBonusType,
} from './momentum.js';
import { applyReactiveDamage, applyReactiveTrueDamage, calculateReactiveDamageByRate } from './reactiveDamage.js';
import { resolveSkillCostForResourceState } from '../../shared/skillCost.js';
import {
  applySkillCooldownAfterCast,
  getSkillCooldownBlockedMessage,
  getSkillCooldownRemainingRounds,
} from '../utils/cooldown.js';
import {
  DEFAULT_PERCENT_BUFF_ATTR_SET,
  buildAuraHostRuntimeBuffKey,
  normalizeBuffApplyType,
  normalizeBuffAttrKey,
  normalizeBuffKind,
  resolveBuffEffectKey,
  resolveSignedAttrValue,
} from '../utils/buffSpec.js';
import { appendBattleLog, appendBattleLogs } from '../logStream.js';
import { buildAuraApplySummary } from '../utils/auraSummary.js';

interface SkillExecutionResult {
  success: boolean;
  log?: ActionLog;
  error?: string;
}

const resolveCasterSkillCost = (caster: BattleUnit, skill: BattleSkill) => {
  return resolveSkillCostForResourceState(skill.cost, {
    maxLingqi: caster.currentAttrs.max_lingqi,
    maxQixue: caster.currentAttrs.max_qixue,
  });
};

const PERCENT_BUFF_ATTR_SET = DEFAULT_PERCENT_BUFF_ATTR_SET;

type BuffRuntimeData = {
  attrModifiers?: AttrModifier[];
  dot?: DotEffect;
  hot?: HotEffect;
  reflectDamage?: ReflectDamageEffect;
  delayedBurst?: DelayedBurstEffect;
  dodgeNext?: DodgeNextEffect;
  nextSkillBonus?: NextSkillBonusEffect;
  healForbidden?: boolean;
  aura?: AuraEffect;
};

type SkillExecutionContext = {
  momentumBonusRateByType: Record<'damage' | 'heal' | 'shield' | 'resource', number>;
  momentumGained: string[];
  momentumConsumed: string[];
  consumedNextSkillBuffIds: string[];
};

type BuffOrDebuffEffect = SkillEffect & { type: 'buff' | 'debuff' };

function hasBuffRuntimeData(data: BuffRuntimeData): boolean {
  return Boolean(
    data.dot
    || data.hot
    || data.reflectDamage
    || data.delayedBurst
    || data.dodgeNext
    || data.nextSkillBonus
    || data.healForbidden
    || data.aura
    || (Array.isArray(data.attrModifiers) && data.attrModifiers.length > 0)
  );
}

function createSkillExecutionContext(): SkillExecutionContext {
  return {
    momentumBonusRateByType: {
      damage: 0,
      heal: 0,
      shield: 0,
      resource: 0,
    },
    momentumGained: [],
    momentumConsumed: [],
    consumedNextSkillBuffIds: [],
  };
}

function applyContextBonus(value: number, bonusRate: number): number {
  if (value === 0) return 0;
  if (bonusRate <= 0) return Math.floor(value);
  return Math.floor(value * (1 + bonusRate));
}

function addMomentumBonusToContext(
  context: SkillExecutionContext,
  bonusType: MomentumBonusType,
  bonusRate: number,
): void {
  if (bonusRate <= 0) return;
  if (bonusType === 'all') {
    context.momentumBonusRateByType.damage += bonusRate;
    context.momentumBonusRateByType.heal += bonusRate;
    context.momentumBonusRateByType.shield += bonusRate;
    context.momentumBonusRateByType.resource += bonusRate;
    return;
  }
  context.momentumBonusRateByType[bonusType] += bonusRate;
}

function consumeNextSkillBonusBuffs(
  caster: BattleUnit,
  context: SkillExecutionContext,
): void {
  for (const buff of caster.buffs) {
    const nextSkillBonus = buff.nextSkillBonus;
    if (!nextSkillBonus || nextSkillBonus.rate <= 0) continue;
    addMomentumBonusToContext(context, nextSkillBonus.bonusType, nextSkillBonus.rate);
    context.consumedNextSkillBuffIds.push(buff.id);
  }
}

function clearConsumedNextSkillBonusBuffs(caster: BattleUnit, context: SkillExecutionContext): void {
  for (const buffId of context.consumedNextSkillBuffIds) {
    removeBuff(caster, buffId);
  }
  context.consumedNextSkillBuffIds = [];
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 解析灼烧额外伤害比例。
 *
 * 作用：
 * - 从技能效果数据中读取“目标最大气血附加比例伤害”，作为运行时 DOT 计算参数。
 *
 * 输入/输出：
 * - 输入：effect.bonusTargetMaxQixueRate（后端技能定义字段）
 * - 输出：>= 0 的比例值，非正数一律视为 0
 *
 * 数据流：
 * - 技能定义 effects[] -> SkillEffect -> 本函数 -> DotEffect.bonusTargetMaxQixueRate
 *
 * 边界条件与坑点：
 * 1) 非数值或空值会被归零，避免污染 DOT 结算。
 * 2) 本函数不做默认常量兜底，配置缺失即表示“无附加比例伤害”。
 */
function resolveBurnTargetMaxQixueRate(effect: SkillEffect): number {
  const rate = toFiniteNumber(effect.bonusTargetMaxQixueRate, 0);
  return rate > 0 ? rate : 0;
}

function resolveReflectDamageEffect(effect: SkillEffect): ReflectDamageEffect | null {
  const rate = toFiniteNumber(effect.value, 0);
  if (rate <= 0) return null;
  return { rate };
}

function getAttrValue(unit: BattleUnit, attrKey: string): number {
  const attrs = unit.currentAttrs as unknown as Record<string, unknown>;
  const value = attrs[attrKey];
  return toFiniteNumber(value, 0);
}

function resolveEffectValue(
  caster: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  fallbackScaleAttr: string
): number {
  const value = toFiniteNumber(effect.value, 0);
  const scaleAttrRaw = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  const scaleAttr = scaleAttrRaw || fallbackScaleAttr;
  if (!scaleAttr) return Math.floor(value);

  // 固定值 + 属性加成模式：baseValue + 属性值 * scaleRate
  if (effect.valueType === 'combined') {
    const baseValue = toFiniteNumber(effect.baseValue, 0);
    const rate = toFiniteNumber(effect.scaleRate, 0);
    return Math.floor(baseValue + getAttrValue(caster, scaleAttr) * rate);
  }

  if (effect.valueType === 'scale') {
    const rate = toFiniteNumber(effect.scaleRate, value);
    return Math.floor(getAttrValue(caster, scaleAttr) * rate);
  }

  if (scaleAttrRaw) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  if (effect.valueType === 'percent') {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  if (effect.valueType === 'flat') {
    return Math.floor(value);
  }

  const defaultScaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
  if (scaleAttr === defaultScaleAttr && value > 0 && value <= 1) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value);
  }

  return Math.floor(value);
}

const AURA_TARGET_SET = new Set<string>(['all_ally', 'all_enemy', 'self']);

function resolveAuraTarget(raw: string | undefined): AuraTargetType | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return AURA_TARGET_SET.has(trimmed) ? (trimmed as AuraTargetType) : null;
}

/**
 * 解析光环子效果列表，按施法者属性快照计算数值。
 *
 * 作用：遍历光环的 auraEffects 配置，将每个子效果转换为运行时 AuraSubEffect。
 * 输入：施法者、技能、子效果配置数组。
 * 输出：已解析的 AuraSubEffect 数组（数值已快照）。
 *
 * 坑点：
 * 1) buff/debuff 子效果会递归调用 buildBuffRuntimeData 构建子 Buff 运行时数据，但子效果不允许嵌套光环。
 * 2) damage/heal 子效果使用 resolveEffectValue 按施法者当前属性快照计算。
 */
function resolveAuraSubEffects(
  caster: BattleUnit,
  skill: BattleSkill,
  subEffects: SkillEffect[],
): AuraSubEffect[] {
  const results: AuraSubEffect[] = [];
  for (const sub of subEffects) {
    const subType = typeof sub.type === 'string' ? sub.type.trim() : '';
    if (!subType) continue;

    if (subType === 'damage') {
      const scaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
      const resolvedValue = Math.max(1, resolveEffectValue(caster, skill, sub, scaleAttr));
      results.push({
        type: 'damage',
        resolvedValue,
        damageType: sub.damageType ?? (skill.damageType === 'magic' ? 'magic' : 'physical'),
        element: sub.element ?? skill.element ?? 'none',
      });
      continue;
    }

    if (subType === 'heal') {
      const resolvedValue = Math.max(1, resolveEffectValue(caster, skill, sub, 'fagong'));
      results.push({ type: 'heal', resolvedValue });
      continue;
    }

    if (subType === 'buff' || subType === 'debuff') {
      // 禁止嵌套光环
      if (normalizeBuffKind(sub.buffKind) === 'aura') continue;
      const subRuntime = buildBuffRuntimeData(caster, caster, skill, sub as BuffOrDebuffEffect);
      if (!hasBuffRuntimeData(subRuntime)) continue;
      const buffDefId = resolveBuffEffectKey(sub as BuffOrDebuffEffect) || `aura-sub-${subType}`;
      results.push({
        type: subType,
        resolvedValue: subRuntime.attrModifiers?.[0]?.value ?? 0,
        buffDefId,
        buffType: subType,
        attrModifiers: subRuntime.attrModifiers,
        dot: subRuntime.dot,
        hot: subRuntime.hot,
        healForbidden: subRuntime.healForbidden,
      });
      continue;
    }

    if (subType === 'resource') {
      const value = toFiniteNumber(sub.value, 0);
      if (value === 0) continue;
      results.push({
        type: 'resource',
        resolvedValue: value,
        resourceType: sub.resourceType ?? 'lingqi',
      });
      continue;
    }

    if (subType === 'restore_lingqi') {
      const value = Math.max(0, Math.floor(toFiniteNumber(sub.value, 0)));
      if (value <= 0) continue;
      results.push({ type: 'restore_lingqi', resolvedValue: value });
      continue;
    }
  }
  return results;
}

function buildBuffRuntimeData(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: BuffOrDebuffEffect
): BuffRuntimeData {
  const buffKind = normalizeBuffKind(effect.buffKind);
  if (!buffKind) return {};

  if (buffKind === 'dot') {
    const scaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
    const dotDamage = Math.max(1, resolveEffectValue(caster, skill, effect, scaleAttr));
    const burnBonusRate = resolveBurnTargetMaxQixueRate(effect);
    return {
      dot: {
        damage: dotDamage,
        damageType: skill.damageType === 'magic' ? 'magic' : 'physical',
        element: skill.element || 'none',
        bonusTargetMaxQixueRate: burnBonusRate > 0 ? burnBonusRate : undefined,
      },
    };
  }

  if (buffKind === 'hot') {
    const heal = Math.max(1, resolveEffectValue(caster, skill, effect, 'fagong'));
    return { hot: { heal } };
  }

  if (buffKind === 'dodge_next') {
    return {
      dodgeNext: { guaranteedMiss: true },
    };
  }

  if (buffKind === 'reflect_damage') {
    const reflectDamage = resolveReflectDamageEffect(effect);
    return reflectDamage ? { reflectDamage } : {};
  }

  if (buffKind === 'heal_forbid') {
    return { healForbidden: true };
  }

  if (buffKind === 'aura') {
    const auraTarget = resolveAuraTarget(effect.auraTarget);
    if (!auraTarget) return {};
    const auraSubEffects = Array.isArray(effect.auraEffects) ? effect.auraEffects : [];
    if (auraSubEffects.length === 0) return {};
    const resolvedEffects = resolveAuraSubEffects(caster, skill, auraSubEffects);
    if (resolvedEffects.length === 0) return {};
    return {
      aura: {
        auraTarget,
        effects: resolvedEffects,
        damageType: skill.damageType === 'magic' ? 'magic' : skill.damageType === 'true' ? 'true' : 'physical',
        element: skill.element || 'none',
      },
    };
  }

  if (buffKind === 'next_skill_bonus') {
    const rate = Math.max(0, toFiniteNumber(effect.value, 0));
    const bonusType = effect.bonusType ?? 'all';
    if (rate <= 0) return {};
    return {
      nextSkillBonus: createNextSkillBonusRuntime({
        rate,
        bonusType,
      }),
    };
  }

  if (buffKind !== 'attr') return {};
  const attr = normalizeBuffAttrKey(effect.attrKey);
  if (!attr) return {};
  const value = resolveSignedAttrValue(effect.type, effect.value);
  if (value === 0) return {};
  const mode: AttrModifier['mode'] =
    normalizeBuffApplyType(effect.applyType)
    ?? (PERCENT_BUFF_ATTR_SET.has(attr) ? 'percent' : 'flat');

  if (target.currentAttrs[attr as keyof typeof target.currentAttrs] == null) {
    return {};
  }

  return {
    attrModifiers: [{ attr, value, mode }],
  };
}

function isDirectDamageType(damageType: unknown): damageType is 'physical' | 'magic' | 'true' {
  return damageType === 'physical' || damageType === 'magic' || damageType === 'true';
}

function resolveEffectDamageType(skill: BattleSkill, effect: SkillEffect): 'physical' | 'magic' | 'true' | null {
  const raw = effect.damageType;
  if (isDirectDamageType(raw)) return raw;
  if (isDirectDamageType(skill.damageType)) return skill.damageType;
  return null;
}

function resolveEffectDamageElement(skill: BattleSkill, effect: SkillEffect): string {
  const raw = effect.element;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : (skill.element || 'none');
}

function resolveDamageHitCount(effect: SkillEffect): number {
  return Math.max(1, Math.floor(toFiniteNumber(effect.hit_count, 1)));
}

function resolveDamageBaseValue(
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  damageType: 'physical' | 'magic' | 'true'
): number {
  const value = toFiniteNumber(effect.value, 0);
  const valueType = effect.valueType || 'scale';

  if (valueType === 'flat') {
    return Math.max(0, Math.floor(value));
  }

  if (valueType === 'percent') {
    return Math.max(0, Math.floor(target.currentAttrs.max_qixue * value));
  }

  const fallbackScaleAttr = damageType === 'magic' ? 'fagong' : 'wugong';
  const scaleAttrRaw = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  const scaleAttr = scaleAttrRaw || fallbackScaleAttr;
  const scaleRate = toFiniteNumber(effect.scaleRate, value);
  return Math.max(0, Math.floor(getAttrValue(caster, scaleAttr) * scaleRate));
}

type DamageExecutionSummary = {
  attempted: boolean;
  landed: boolean;
};

function executeDamageEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): DamageExecutionSummary {
  const damageType = resolveEffectDamageType(skill, effect);
  if (!damageType) return { attempted: false, landed: false };

  const hitCount = resolveDamageHitCount(effect);
  const rawBaseDamage = resolveDamageBaseValue(caster, target, effect, damageType);
  const baseDamage = applyContextBonus(rawBaseDamage, context.momentumBonusRateByType.damage);
  if (baseDamage <= 0) return { attempted: false, landed: false };

  let attempted = false;
  let landed = false;

  for (let i = 0; i < hitCount; i++) {
    if (!target.isAlive) break;
    attempted = true;
    const hitIndex = result.hits.length + 1;

    const damageResult = calculateDamage(state, caster, target, {
      damageType,
      element: resolveEffectDamageElement(skill, effect),
      baseDamage,
    });
    if (damageResult.isMiss) {
      const missedHit: TargetHitResult = {
        index: hitIndex,
        damage: 0,
        isMiss: true,
        isCrit: false,
        isParry: false,
        isElementBonus: false,
        shieldAbsorbed: 0,
      };
      result.hits.push(missedHit);
      continue;
    }

    landed = true;
    const { actualDamage: damageApplied, shieldAbsorbed } = applyDamage(
      state, target, damageResult.damage, damageType
    );
    const actualDamage = Math.max(0, damageApplied);
    const landedHit: TargetHitResult = {
      index: hitIndex,
      damage: actualDamage,
      isMiss: false,
      isCrit: damageResult.isCrit,
      isParry: damageResult.isParry,
      isElementBonus: damageResult.isElementBonus,
      shieldAbsorbed,
    };
    result.hits.push(landedHit);

    result.damage = (result.damage || 0) + actualDamage;
    result.shieldAbsorbed = (result.shieldAbsorbed || 0) + shieldAbsorbed;
    result.isCrit = Boolean(result.isCrit || damageResult.isCrit);
    result.isParry = Boolean(result.isParry || damageResult.isParry);
    result.isElementBonus = Boolean(result.isElementBonus || damageResult.isElementBonus);

    caster.stats.damageDealt += actualDamage;
    if (actualDamage > 0) {
      applyLifesteal(caster, actualDamage);
    }

    if (!target.isAlive) {
      caster.stats.killCount++;
      appendBattleLog(state, {
        type: 'death',
        round: state.roundCount,
        unitId: target.id,
        unitName: target.name,
        killerId: caster.id,
        killerName: caster.name,
      });
    }

    const onHitLogs = triggerSetBonusEffects(state, 'on_hit', caster, {
      target,
      damage: actualDamage,
      damageType,
    });
    appendBattleLogs(state, onHitLogs);
    const onBeHitLogs = triggerSetBonusEffects(state, 'on_be_hit', target, {
      target: caster,
      damage: actualDamage,
      damageType,
    });
    appendBattleLogs(state, onBeHitLogs);
    if (damageResult.isCrit) {
      const onCritLogs = triggerSetBonusEffects(state, 'on_crit', caster, {
        target,
        damage: actualDamage,
        damageType,
      });
      appendBattleLogs(state, onCritLogs);
    }
    const onAllyHitOwners = resolveAliveAllies(state, caster);
    for (const ally of onAllyHitOwners) {
      const onAllyHitLogs = triggerSetBonusEffects(state, 'on_ally_hit', ally, {
        target,
        damage: actualDamage,
        damageType,
      });
      appendBattleLogs(state, onAllyHitLogs);
    }

    const reflectLogs = buildReflectDamageLogs(state, target, caster, actualDamage, damageType);
    if (reflectLogs.length > 0) {
      appendBattleLogs(state, reflectLogs);
    }
  }

  return { attempted, landed };
}

function resolveAliveAllies(state: BattleState, caster: BattleUnit): BattleUnit[] {
  const isAttacker = state.teams.attacker.units.some((entry) => entry.id === caster.id);
  const team = isAttacker ? state.teams.attacker : state.teams.defender;
  return team.units.filter((entry) => entry.isAlive);
}

function buildReflectDamageLogs(
  state: BattleState,
  defender: BattleUnit,
  attacker: BattleUnit,
  actualDamage: number,
  sourceDamageType: 'physical' | 'magic' | 'true',
): BattleLogEntry[] {
  if (actualDamage <= 0 || !attacker.isAlive) return [];

  const reflectRate = getUnitReflectDamageRate(defender);
  const reflectDamage = calculateReactiveDamageByRate(
    actualDamage,
    reflectRate,
    Math.max(0, 1 - attacker.currentAttrs.jianfantan),
  );
  if (reflectDamage <= 0) return [];

  const applied = applyReactiveDamage(state, defender, attacker, reflectDamage, sourceDamageType);
  if (!applied) return [];

  return [{
    type: 'action',
    round: state.roundCount,
    actorId: defender.id,
    actorName: defender.name,
    skillId: `proc-${defender.id}-reflect-damage`,
    skillName: '反弹伤害',
    targets: [{
      targetId: attacker.id,
      targetName: attacker.name,
      hits: [applied.hit],
      damage: applied.actualDamage,
      shieldAbsorbed: applied.shieldAbsorbed,
    }],
  }, ...applied.extraLogs];
}

function processMomentumEffectsByOperation(
  state: BattleState,
  caster: BattleUnit,
  skill: BattleSkill,
  context: SkillExecutionContext,
  operation: 'gain' | 'consume',
): void {
  for (const effect of skill.effects) {
    if (effect.type !== 'momentum') continue;
    const config = resolveMomentumEffectConfig({ ...effect });
    if (!config || config.operation !== operation) continue;
    if (typeof effect.chance === 'number' && !rollChance(state, effect.chance)) continue;

    if (operation === 'consume') {
      const consumed = consumeMomentumStacks(caster, config);
      if (!consumed.consumed) continue;
      addMomentumBonusToContext(context, consumed.bonusType, consumed.bonusRate);
      context.momentumConsumed.push(consumed.text);
      continue;
    }

    const gained = gainMomentumStacks(caster, config);
    if (!gained.gained) continue;
    context.momentumGained.push(gained.text);
  }
}

/**
 * 执行技能
 */
export function executeSkill(
  state: BattleState,
  caster: BattleUnit,
  skill: BattleSkill,
  selectedTargetIds?: string[]
): SkillExecutionResult {
  // 检查控制状态
  if (!canUseSkill(caster, skill.damageType)) {
    return { success: false, error: '被控制无法使用技能' };
  }

  // 检查沉默/缴械
  if (skill.damageType === 'magic' && isSilenced(caster)) {
    return { success: false, error: '被沉默无法使用法术' };
  }
  if (skill.damageType === 'physical' && isDisarmed(caster)) {
    return { success: false, error: '被缴械无法使用物理技能' };
  }

  // 检查冷却
  const cooldownMessage = getSkillCooldownBlockedMessage(caster, skill.id);
  if (cooldownMessage) {
    return { success: false, error: cooldownMessage };
  }

  // 检查消耗
  const cost = resolveCasterSkillCost(caster, skill);
  if (cost.totalLingqi > 0 && caster.lingqi < cost.totalLingqi) {
    return { success: false, error: '灵气不足' };
  }
  if (cost.totalQixue > 0 && caster.qixue <= cost.totalQixue) {
    return { success: false, error: '气血不足' };
  }

  // 扣除消耗
  if (cost.totalLingqi > 0) {
    caster.lingqi -= cost.totalLingqi;
  }
  if (cost.totalQixue > 0) {
    caster.qixue -= cost.totalQixue;
  }

  // 设置冷却
  if (skill.cooldown > 0) {
    applySkillCooldownAfterCast(caster, skill.id, skill.cooldown);
  }

  // 解析目标
  const targets = resolveTargets(state, caster, skill, selectedTargetIds);
  if (targets.length === 0) {
    return { success: false, error: '没有有效目标' };
  }

  const context = createSkillExecutionContext();

  // 先落主动作日志，再按触发时机追加触发日志，保证日志顺序符合战斗时序
  const targetResults: TargetResult[] = [];
  const log: ActionLog = {
    type: 'action',
    round: state.roundCount,
    actorId: caster.id,
    actorName: caster.name,
    skillId: skill.id,
    skillName: skill.name,
    targets: targetResults,
  };
  appendBattleLog(state, log);

  const onSkillLogs = triggerSetBonusEffects(state, 'on_skill', caster);
  appendBattleLogs(state, onSkillLogs);

  processMomentumEffectsByOperation(state, caster, skill, context, 'consume');
  consumeNextSkillBonusBuffs(caster, context);

  for (const target of targets) {
    const result = executeSkillOnTarget(state, caster, target, skill, context);
    targetResults.push(result);
  }

  processMomentumEffectsByOperation(state, caster, skill, context, 'gain');
  clearConsumedNextSkillBonusBuffs(caster, context);

  if (targetResults.length > 0) {
    if (context.momentumConsumed.length > 0) {
      targetResults[0].momentumConsumed = [...context.momentumConsumed];
    }
    if (context.momentumGained.length > 0) {
      targetResults[0].momentumGained = [...context.momentumGained];
    }
  }

  return { success: true, log };
}

/**
 * 对单个目标执行技能效果
 */
function executeSkillOnTarget(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  context: SkillExecutionContext,
): TargetResult {
  const result: TargetResult = {
    targetId: target.id,
    targetName: target.name,
    hits: [],
    buffsApplied: [],
    buffsRemoved: [],
    marksApplied: [],
    marksConsumed: [],
  };

  // 先处理伤害效果，保持“先伤害后附加效果”的执行顺序
  let attemptedDamage = false;
  let landedDamage = false;
  for (const effect of skill.effects) {
    if (effect.type !== 'damage') continue;
    if (typeof effect.chance === 'number' && !rollChance(state, effect.chance)) {
      continue;
    }

    const summary = executeDamageEffect(state, caster, target, skill, effect, result, context);
    attemptedDamage = attemptedDamage || summary.attempted;
    landedDamage = landedDamage || summary.landed;
  }
  if (attemptedDamage && !landedDamage) {
    result.isMiss = true;
  }

  // 再处理非伤害技能效果
  for (let effectIndex = 0; effectIndex < skill.effects.length; effectIndex++) {
    const effect = skill.effects[effectIndex];
    if (!effect) continue;
    if (effect.type === 'damage' || effect.type === 'momentum') continue;
    // 控制效果走独立命中流程，避免重复概率判定
    if (effect.type !== 'control' && typeof effect.chance === 'number' && !rollChance(state, effect.chance)) {
      continue;
    }

    executeEffect(state, caster, target, skill, effect, result, context, effectIndex);
  }

  return result;
}

/**
 * 执行单个效果
 */
function executeEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
  effectIndex: number,
): void {
  switch (effect.type) {
    case 'damage':
      // 伤害效果在 executeSkillOnTarget 中统一执行
      break;

    case 'heal':
      executeHealEffect(state, caster, target, skill, effect, result, context);
      break;

    case 'shield':
      executeShieldEffect(caster, target, skill, effect, result, context);
      break;

    case 'buff':
    case 'debuff':
      executeBuffEffect(caster, target, skill, effect as BuffOrDebuffEffect, result, effectIndex);
      break;

    case 'dispel':
      executeDispelEffect(target, effect, result);
      break;

    case 'resource':
      executeResourceEffect(target, effect, result, context);
      break;

    case 'restore_lingqi':
      executeRestoreLingqiEffect(target, effect, result, context);
      break;

    case 'cleanse':
      executeCleanseEffect(target, effect, result);
      break;

    case 'cleanse_control':
      executeCleanseControlEffect(target, effect, result);
      break;

    case 'lifesteal':
      executeLifestealEffect(caster, result, effect);
      break;

    case 'control':
      executeControlEffect(state, caster, target, effect, result);
      break;

    case 'mark':
      executeMarkEffect(state, caster, target, skill, effect, result);
      break;

    case 'momentum':
      break;

    case 'delayed_burst':
      executeDelayedBurstEffect(caster, target, skill, effect, result);
      break;

    case 'fate_swap':
      executeFateSwapEffect(caster, target, effect, result);
      break;
  }
}

function executeMarkEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult
): void {
  const config = resolveMarkEffectConfig(effect as unknown as Record<string, unknown>);
  if (!config) return;

  if (config.operation === 'apply') {
    const applied = applyMarkStacks(target, caster.id, config);
    if (applied.applied) {
      result.marksApplied?.push(applied.text);
    }
    return;
  }

  const fallbackScaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
  const baseValue = Math.max(0, resolveEffectValue(caster, skill, effect, fallbackScaleAttr));
  const consumed = consumeMarkStacks(
    target,
    caster.id,
    config,
    baseValue,
    target.currentAttrs.max_qixue
  );
  if (!consumed.consumed) return;

  const consumeText = consumed.wasCapped ? `${consumed.text}（触发35%上限）` : consumed.text;
  result.marksConsumed?.push(consumeText);
  applyMarkConsumeRuntimeAddon({
    caster,
    target,
    config,
    consumed,
    targetResult: result,
    sourceSkillId: skill.id,
  });

  const convertedValue = Math.max(0, consumed.finalValue);
  if (convertedValue <= 0) return;

  if (consumed.resultType === 'damage') {
    const hitIndex = result.hits.length + 1;
    const { actualDamage, shieldAbsorbed } = applyDamage(state, target, convertedValue, 'true');
    const safeDamage = Math.max(0, actualDamage);
    const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
    result.hits.push({
      index: hitIndex,
      damage: safeDamage,
      isMiss: false,
      isCrit: false,
      isParry: false,
      isElementBonus: false,
      shieldAbsorbed: safeShieldAbsorbed,
    });
    result.damage = (result.damage || 0) + safeDamage;
    result.shieldAbsorbed = (result.shieldAbsorbed || 0) + safeShieldAbsorbed;
    caster.stats.damageDealt += safeDamage;

    if (!target.isAlive) {
      caster.stats.killCount++;
      appendBattleLog(state, {
        type: 'death',
        round: state.roundCount,
        unitId: target.id,
        unitName: target.name,
        killerId: caster.id,
        killerName: caster.name,
      });
    }
    return;
  }

  if (consumed.resultType === 'shield_self') {
    const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 2)));
    addShield(caster, {
      value: convertedValue,
      maxValue: convertedValue,
      duration,
      absorbType: 'all',
      priority: 1,
      sourceSkillId: skill.id,
    }, caster.id);
    if (target.id === caster.id) {
      result.buffsApplied?.push('护盾');
    }
    return;
  }

  const actualHeal = applyHealing(caster, convertedValue);
  if (actualHeal > 0) {
    caster.stats.healingDone += actualHeal;
    if (target.id === caster.id) {
      result.heal = (result.heal || 0) + actualHeal;
    }
  }
}

/**
 * 执行治疗效果
 */
function executeHealEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  let healValue = effect.valueType === 'percent'
    ? Math.floor(target.currentAttrs.max_qixue * toFiniteNumber(effect.value, 0))
    : resolveEffectValue(caster, skill, effect, 'fagong');
  healValue = applyContextBonus(healValue, context.momentumBonusRateByType.heal);

  // 治疗加成
  const healBonus = Math.min(caster.currentAttrs.zhiliao, BATTLE_CONSTANTS.MAX_HEAL_BONUS);
  healValue = Math.floor(healValue * (1 + healBonus));

  // 减疗
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  healValue = Math.floor(healValue * (1 - healReduction));

  const actualHeal = applyHealing(target, healValue);
  result.heal = actualHeal;
  caster.stats.healingDone += actualHeal;
  if (actualHeal > 0) {
    const logs = triggerSetBonusEffects(state, 'on_heal', caster, {
      target,
      heal: actualHeal,
    });
    appendBattleLogs(state, logs);
  }
}

/**
 * 执行护盾效果
 */
function executeShieldEffect(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const shieldValue = Math.max(
    1,
    applyContextBonus(
      resolveEffectValue(caster, skill, effect, 'max_qixue'),
      context.momentumBonusRateByType.shield,
    ),
  );
  const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 2)));

  addShield(target, {
    value: shieldValue,
    maxValue: shieldValue,
    duration,
    absorbType: 'all',
    priority: 1,
    sourceSkillId: '',
  }, '');

  result.buffsApplied?.push('护盾');
}

/**
 * 执行Buff/Debuff效果
 */
function executeBuffEffect(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: BuffOrDebuffEffect,
  result: TargetResult,
  effectIndex: number,
): void {
  const baseBuffDefId = resolveBuffEffectKey(effect);
  if (!baseBuffDefId) return;

  const buffType = effect.type === 'buff' ? 'buff' : 'debuff';
  const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
  const isAura = normalizeBuffKind(effect.buffKind) === 'aura';
  const buffDefId = isAura
    ? buildAuraHostRuntimeBuffKey({
      sourceUnitId: caster.id,
      skillId: skill.id,
      effectIndex,
      buffDefId: baseBuffDefId,
    })
    : baseBuffDefId;
  // 光环永久存在（duration=-1），不可驱散
  const duration = isAura ? -1 : Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));
  const runtimeData = buildBuffRuntimeData(caster, target, skill, effect);
  if (!hasBuffRuntimeData(runtimeData)) return;

  addBuff(target, {
    id: `${buffDefId}-${Date.now()}`,
    buffDefId,
    name: baseBuffDefId,
    type: buffType,
    category: 'skill',
    sourceUnitId: caster.id,
    maxStacks: stacks,
    attrModifiers: runtimeData.attrModifiers,
    dot: runtimeData.dot,
    hot: runtimeData.hot,
    reflectDamage: runtimeData.reflectDamage,
    delayedBurst: runtimeData.delayedBurst,
    dodgeNext: runtimeData.dodgeNext,
    nextSkillBonus: runtimeData.nextSkillBonus,
    healForbidden: runtimeData.healForbidden,
    aura: runtimeData.aura,
    tags: [],
    dispellable: !isAura,
  }, duration, stacks);

  if (isAura && runtimeData.aura) {
    result.buffsApplied?.push(buildAuraApplySummary(buffType, runtimeData.aura));
    return;
  }

  result.buffsApplied?.push(baseBuffDefId);
}

function executeDelayedBurstEffect(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect,
  result: TargetResult,
): void {
  const damageType = resolveEffectDamageType(skill, effect) ?? 'true';
  const damage = Math.max(1, resolveEffectValue(caster, skill, effect, damageType === 'magic' ? 'fagong' : 'wugong'));
  const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 2)));
  const buffDefId = `delayed-burst:${skill.id}:${effect.element ?? skill.element ?? 'none'}`;

  addBuff(target, {
    id: `${buffDefId}-${Date.now()}`,
    buffDefId,
    name: '延迟爆发',
    type: 'debuff',
    category: 'skill',
    sourceUnitId: caster.id,
    maxStacks: 1,
    delayedBurst: createDelayedBurstRuntime({
      damage,
      damageType,
      element: resolveEffectDamageElement(skill, effect),
      remainingRounds: duration,
    }),
    tags: ['delayed_burst'],
    dispellable: true,
  }, duration + 1, 1);

  result.buffsApplied?.push(`延迟爆发（${duration}回合后）`);
}

type FateSwapMode = NonNullable<SkillEffect['swapMode']>;

function resolveFateSwapMode(raw: SkillEffect['swapMode']): FateSwapMode {
  if (raw === 'buff_to_self') return 'buff_to_self';
  if (raw === 'shield_steal') return 'shield_steal';
  return 'debuff_to_target';
}

function executeFateSwapEffect(
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult,
): void {
  const swapMode = resolveFateSwapMode(effect.swapMode);

  if (swapMode === 'shield_steal') {
    const rate = Math.min(1, Math.max(0, toFiniteNumber(effect.value, 1)));
    const firstShield = target.shields[0];
    if (!firstShield || firstShield.value <= 0 || rate <= 0) return;
    const stolenValue = Math.max(1, Math.floor(firstShield.value * rate));
    firstShield.value = Math.max(0, firstShield.value - stolenValue);
    firstShield.maxValue = Math.max(firstShield.value, firstShield.maxValue - stolenValue);
    target.shields = target.shields.filter((shield) => shield.value > 0);
    addShield(caster, {
      value: stolenValue,
      maxValue: stolenValue,
      duration: Math.max(1, firstShield.duration),
      absorbType: firstShield.absorbType,
      priority: firstShield.priority,
      sourceSkillId: '',
    }, '');
    result.buffsApplied?.push(`夺取护盾 ${stolenValue}`);
    return;
  }

  const count = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const sourceBuffs = (swapMode === 'debuff_to_target'
    ? caster.buffs.filter((buff) => buff.type === 'debuff' && buff.dispellable)
    : target.buffs.filter((buff) => buff.type === 'buff' && buff.dispellable)
  ).slice(0, count);

  if (sourceBuffs.length <= 0) return;

  for (const buff of sourceBuffs) {
    const sourceUnit = swapMode === 'debuff_to_target' ? caster : target;
    const destinationUnit = swapMode === 'debuff_to_target' ? target : caster;
    addBuff(destinationUnit, {
      id: buff.id,
      buffDefId: buff.buffDefId,
      name: buff.name,
      type: buff.type,
      category: buff.category,
      sourceUnitId: buff.sourceUnitId,
      maxStacks: buff.maxStacks,
      attrModifiers: buff.attrModifiers,
      dot: buff.dot,
      hot: buff.hot,
      reflectDamage: buff.reflectDamage,
      delayedBurst: buff.delayedBurst,
      dodgeNext: buff.dodgeNext,
      nextSkillBonus: buff.nextSkillBonus,
      healForbidden: buff.healForbidden,
      control: buff.control,
      tags: [...buff.tags],
      dispellable: buff.dispellable,
    }, buff.remainingDuration, buff.stacks);
    removeBuff(sourceUnit, buff.id);
    result.buffsRemoved?.push(`转移${buff.name}`);
    result.buffsApplied?.push(`承接${buff.name}`);
  }
}

/**
 * 执行驱散效果
 */
function executeDispelEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const dispelCount = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const dispelType = effect.dispelType || 'debuff';
  const toRemove = target.buffs
    .filter((buff) => buff.dispellable)
    .filter((buff) => dispelType === 'all' || buff.type === dispelType)
    .slice(0, dispelCount);

  for (const buff of toRemove) {
    if (removeBuff(target, buff.id)) {
      result.buffsRemoved?.push(buff.name);
    }
  }
}

/**
 * 执行净化效果（移除Debuff）
 */
function executeCleanseEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const count = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const tempEffect: SkillEffect = {
    type: 'dispel',
    dispelType: 'debuff',
    count,
  };
  executeDispelEffect(target, tempEffect, result);
}

/**
 * 执行净控效果（仅移除控制Debuff）
 */
function executeCleanseControlEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const count = Math.max(1, Math.floor(toFiniteNumber(effect.count, 1)));
  const toRemove = target.buffs
    .filter((buff) => buff.type === 'debuff' && !!buff.control)
    .slice(0, count);

  for (const buff of toRemove) {
    if (removeBuff(target, buff.id)) {
      result.buffsRemoved?.push(buff.name);
    }
  }
}

/**
 * 执行吸血效果（按本次命中伤害比例回复施法者）
 */
function executeLifestealEffect(
  caster: BattleUnit,
  result: TargetResult,
  effect: SkillEffect
): void {
  const damage = Math.max(0, Math.floor(toFiniteNumber(result.damage, 0)));
  if (damage <= 0) return;
  const rate = Math.max(0, toFiniteNumber(effect.value, 0));
  if (rate <= 0) return;
  const healAmount = Math.floor(damage * rate);
  if (healAmount <= 0) return;

  const actualHeal = applyHealing(caster, healAmount);
  if (actualHeal > 0) {
    caster.stats.healingDone += actualHeal;
  }
}

/**
 * 执行控制效果
 */
function executeControlEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const controlType = typeof effect.controlType === 'string' ? effect.controlType.trim() : '';
  if (!controlType) return;
  const controlRate = Math.max(0, toFiniteNumber(effect.chance, 1));
  const controlDuration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));

  const controlResult = tryApplyControl(
    state,
    caster,
    target,
    controlType,
    controlRate,
    controlDuration
  );

  if (controlResult.success) {
    result.controlApplied = controlType;
  } else if (controlResult.resisted) {
    result.controlResisted = true;
  }
}

/**
 * 执行灵气回复效果
 */
function executeRestoreLingqiEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const rawValue = Math.max(
    0,
    applyContextBonus(
      Math.floor(toFiniteNumber(effect.value, 0)),
      context.momentumBonusRateByType.resource,
    ),
  );
  const value = applySoulShackleRecoveryReduction(rawValue, target);
  if (value <= 0) return;
  target.lingqi = Math.min(target.lingqi + value, target.currentAttrs.max_lingqi);
  result.resources = [...(result.resources ?? []), { type: 'lingqi', amount: value }];
}

/**
 * 执行资源效果
 */
function executeResourceEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult,
  context: SkillExecutionContext,
): void {
  const rawValue = applyContextBonus(toFiniteNumber(effect.value, 0), context.momentumBonusRateByType.resource);
  const value = effect.resourceType === 'lingqi' && rawValue > 0
    ? applySoulShackleRecoveryReduction(rawValue, target)
    : rawValue;
  if (value === 0) return;

  if (effect.resourceType === 'lingqi') {
    target.lingqi = Math.min(
      target.lingqi + value,
      target.currentAttrs.max_lingqi
    );
    result.resources = [...(result.resources ?? []), { type: 'lingqi', amount: Math.abs(Math.floor(value)) }];
  } else if (effect.resourceType === 'qixue') {
    target.qixue = Math.min(
      target.qixue + value,
      target.currentAttrs.max_qixue
    );
    result.resources = [...(result.resources ?? []), { type: 'qixue', amount: Math.abs(Math.floor(value)) }];
  }
}

/**
 * 获取普通攻击技能
 */
export function getNormalAttack(unit: BattleUnit): BattleSkill {
  const damageType = unit.currentAttrs.fagong > unit.currentAttrs.wugong
    ? 'magic'
    : 'physical';

  return {
    id: 'skill-normal-attack',
    name: '普通攻击',
    source: 'innate',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType,
    element: (unit.currentAttrs.element as string) || 'none',
    effects: [{
      type: 'damage',
      valueType: 'scale',
      scaleAttr: damageType === 'magic' ? 'fagong' : 'wugong',
      scaleRate: 1,
    }],
    triggerType: 'active',
    aiPriority: 0,
  };
}

/**
 * 获取可用技能列表
 */
export function getAvailableSkills(unit: BattleUnit): BattleSkill[] {
  return unit.skills.filter(skill => {
    // 检查冷却
    if (getSkillCooldownRemainingRounds(unit, skill.id) > 0) return false;

    // 检查消耗
    const cost = resolveCasterSkillCost(unit, skill);
    if (cost.totalLingqi > 0 && unit.lingqi < cost.totalLingqi) return false;
    if (cost.totalQixue > 0 && unit.qixue <= cost.totalQixue) return false;

    // 检查触发类型
    if (skill.triggerType !== 'active') return false;

    return true;
  });
}
