/**
 * 九州修仙录 - 技能执行模块
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleSkill, 
  SkillEffect,
  AttrModifier,
  DotEffect,
  HotEffect,
  ActionLog,
  TargetHitResult,
  TargetResult
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';
import { calculateDamage, applyDamage } from './damage.js';
import { applyHealing, applyLifesteal } from './healing.js';
import { addBuff, addShield, removeBuff } from './buff.js';
import { tryApplyControl, canUseSkill, isSilenced, isDisarmed } from './control.js';
import { resolveTargets } from './target.js';
import { triggerSetBonusEffects } from './setBonus.js';

export interface SkillExecutionResult {
  success: boolean;
  log?: ActionLog;
  error?: string;
}

const PERCENT_BUFF_ATTR_SET = new Set(['wugong', 'fagong', 'wufang', 'fafang']);
const BUFF_ATTR_ALIAS: Record<string, string> = {
  'max-lingqi': 'max_lingqi',
  'kongzhi-kangxing': 'kongzhi_kangxing',
};

type BuffRuntimeData = {
  attrModifiers?: AttrModifier[];
  dot?: DotEffect;
  hot?: HotEffect;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getAttrValue(unit: BattleUnit, attrKey: string): number {
  const attrs = unit.currentAttrs as unknown as Record<string, unknown>;
  const value = attrs[attrKey];
  return toFiniteNumber(value, 0);
}

function normalizeBuffAttrKey(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return '';
  if (BUFF_ATTR_ALIAS[lowered]) return BUFF_ATTR_ALIAS[lowered];
  return lowered.replace(/-/g, '_');
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

  if (effect.valueType === 'scale') {
    const rate = toFiniteNumber(effect.scaleRate, value);
    return Math.floor(getAttrValue(caster, scaleAttr) * rate / 10000);
  }

  if (scaleAttrRaw) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value / 10000);
  }

  if (effect.valueType === 'percent') {
    return Math.floor(getAttrValue(caster, scaleAttr) * value / 10000);
  }

  if (effect.valueType === 'flat') {
    return Math.floor(value);
  }

  const defaultScaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
  if (scaleAttr === defaultScaleAttr && value > 0 && value <= 10000) {
    return Math.floor(getAttrValue(caster, scaleAttr) * value / 10000);
  }

  return Math.floor(value);
}

function buildBuffRuntimeData(
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill,
  effect: SkillEffect
): BuffRuntimeData {
  const buffId = typeof effect.buffId === 'string' ? effect.buffId.trim() : '';
  if (!buffId) return {};

  if (buffId === 'debuff-burn') {
    const scaleAttr = skill.damageType === 'magic' ? 'fagong' : 'wugong';
    const dotDamage = Math.max(1, resolveEffectValue(caster, skill, effect, scaleAttr));
    return {
      dot: {
        damage: dotDamage,
        damageType: skill.damageType === 'magic' ? 'magic' : 'physical',
        element: skill.element || 'none',
      },
    };
  }

  if (buffId === 'buff-hot') {
    const heal = Math.max(1, resolveEffectValue(caster, skill, effect, 'fagong'));
    return { hot: { heal } };
  }

  if (buffId === 'buff-dodge-next') {
    const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
    return {
      attrModifiers: [{ attr: 'shanbi', value: 10000 * stacks, mode: 'flat' }],
    };
  }

  const matched = /^(buff|debuff)-([a-z0-9-]+)-(up|down)$/.exec(buffId);
  if (!matched) return {};

  const attr = normalizeBuffAttrKey(matched[2]);
  if (!attr) return {};
  const baseValue = Math.floor(Math.abs(toFiniteNumber(effect.value, 0)));
  if (baseValue <= 0) return {};
  const upOrDown = matched[3] === 'down' ? -1 : 1;
  const buffOrDebuff = matched[1] === 'debuff' ? -1 : 1;
  const value = baseValue * upOrDown * buffOrDebuff;
  const mode: AttrModifier['mode'] = PERCENT_BUFF_ATTR_SET.has(attr) ? 'percent' : 'flat';

  if (effect.type === 'buff' && target.currentAttrs[attr as keyof typeof target.currentAttrs] == null) {
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
    return Math.max(0, Math.floor(target.currentAttrs.max_qixue * value / 10000));
  }

  const fallbackScaleAttr = damageType === 'magic' ? 'fagong' : 'wugong';
  const scaleAttrRaw = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  const scaleAttr = scaleAttrRaw || fallbackScaleAttr;
  const scaleRate = toFiniteNumber(effect.scaleRate, value);
  return Math.max(0, Math.floor(getAttrValue(caster, scaleAttr) * scaleRate / 10000));
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
  result: TargetResult
): DamageExecutionSummary {
  const damageType = resolveEffectDamageType(skill, effect);
  if (!damageType) return { attempted: false, landed: false };

  const hitCount = resolveDamageHitCount(effect);
  const baseDamage = resolveDamageBaseValue(caster, target, effect, damageType);
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
      state.logs.push({
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
    });
    state.logs.push(...onHitLogs);
    const onBeHitLogs = triggerSetBonusEffects(state, 'on_be_hit', target, {
      target: caster,
      damage: actualDamage,
    });
    state.logs.push(...onBeHitLogs);
    if (damageResult.isCrit) {
      const onCritLogs = triggerSetBonusEffects(state, 'on_crit', caster, {
        target,
        damage: actualDamage,
      });
      state.logs.push(...onCritLogs);
    }
  }

  return { attempted, landed };
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
  const cooldown = caster.skillCooldowns[skill.id] || 0;
  if (cooldown > 0) {
    return { success: false, error: `技能冷却中: ${cooldown}回合` };
  }
  
  // 检查消耗
  if (skill.cost.lingqi && caster.lingqi < skill.cost.lingqi) {
    return { success: false, error: '灵气不足' };
  }
  if (skill.cost.qixue && caster.qixue <= skill.cost.qixue) {
    return { success: false, error: '气血不足' };
  }
  
  // 扣除消耗
  if (skill.cost.lingqi) {
    caster.lingqi -= skill.cost.lingqi;
  }
  if (skill.cost.qixue) {
    caster.qixue -= skill.cost.qixue;
  }
  
  // 设置冷却
  if (skill.cooldown > 0) {
    const cdReduction = Math.min(caster.currentAttrs.lengque, 5000);
    const actualCd = Math.max(1, Math.floor(skill.cooldown * (1 - cdReduction / 10000)));
    caster.skillCooldowns[skill.id] = actualCd;
  }
  
  // 解析目标
  const targets = resolveTargets(state, caster, skill, selectedTargetIds);
  if (targets.length === 0) {
    return { success: false, error: '没有有效目标' };
  }
  
  // 执行技能效果
  const targetResults: TargetResult[] = [];
  const onSkillLogs = triggerSetBonusEffects(state, 'on_skill', caster);
  state.logs.push(...onSkillLogs);
  
  for (const target of targets) {
    const result = executeSkillOnTarget(state, caster, target, skill);
    targetResults.push(result);
  }
  
  // 生成日志
  const log: ActionLog = {
    type: 'action',
    round: state.roundCount,
    actorId: caster.id,
    actorName: caster.name,
    skillId: skill.id,
    skillName: skill.name,
    targets: targetResults,
  };
  
  state.logs.push(log);
  
  return { success: true, log };
}

/**
 * 对单个目标执行技能效果
 */
function executeSkillOnTarget(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  skill: BattleSkill
): TargetResult {
  const result: TargetResult = {
    targetId: target.id,
    targetName: target.name,
    hits: [],
    buffsApplied: [],
    buffsRemoved: [],
  };

  // 先处理伤害效果，保持“先伤害后附加效果”的执行顺序
  let attemptedDamage = false;
  let landedDamage = false;
  for (const effect of skill.effects) {
    if (effect.type !== 'damage') continue;
    if (effect.chance && !rollChance(state, effect.chance)) {
      continue;
    }

    const summary = executeDamageEffect(state, caster, target, skill, effect, result);
    attemptedDamage = attemptedDamage || summary.attempted;
    landedDamage = landedDamage || summary.landed;
  }
  if (attemptedDamage && !landedDamage) {
    result.isMiss = true;
  }

  // 再处理非伤害技能效果
  for (const effect of skill.effects) {
    if (effect.type === 'damage') continue;
    // 控制效果走独立命中流程，避免重复概率判定
    if (effect.type !== 'control' && effect.chance && !rollChance(state, effect.chance)) {
      continue;
    }
    
    executeEffect(state, caster, target, skill, effect, result);
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
  result: TargetResult
): void {
  switch (effect.type) {
    case 'damage':
      // 伤害效果在 executeSkillOnTarget 中统一执行
      break;
      
    case 'heal':
      executeHealEffect(state, caster, target, effect, result);
      break;
      
    case 'shield':
      executeShieldEffect(caster, target, skill, effect, result);
      break;
      
    case 'buff':
    case 'debuff':
      executeBuffEffect(caster, target, skill, effect, result);
      break;
      
    case 'dispel':
      executeDispelEffect(target, effect, result);
      break;
      
    case 'resource':
      executeResourceEffect(target, effect);
      break;

    case 'restore_lingqi':
      executeRestoreLingqiEffect(target, effect);
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
  }
}

/**
 * 执行治疗效果
 */
function executeHealEffect(
  state: BattleState,
  caster: BattleUnit,
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  let healValue = effect.value || 0;
  
  if (effect.valueType === 'percent') {
    healValue = Math.floor(target.currentAttrs.max_qixue * healValue / 10000);
  } else if (effect.valueType === 'scale' && effect.scaleAttr && effect.scaleRate) {
    const attrValue = (caster.currentAttrs as any)[effect.scaleAttr] || 0;
    healValue = Math.floor(attrValue * effect.scaleRate / 10000);
  }
  
  // 治疗加成
  const healBonus = Math.min(caster.currentAttrs.zhiliao, BATTLE_CONSTANTS.MAX_HEAL_BONUS);
  healValue = Math.floor(healValue * (1 + healBonus / 10000));
  
  // 减疗
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  healValue = Math.floor(healValue * (1 - healReduction / 10000));
  
  const actualHeal = applyHealing(target, healValue);
  result.heal = actualHeal;
  caster.stats.healingDone += actualHeal;
  if (actualHeal > 0) {
    const logs = triggerSetBonusEffects(state, 'on_heal', caster, {
      target,
      heal: actualHeal,
    });
    state.logs.push(...logs);
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
  result: TargetResult
): void {
  const shieldValue = Math.max(1, resolveEffectValue(caster, skill, effect, 'max_qixue'));
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
  effect: SkillEffect,
  result: TargetResult
): void {
  const buffId = typeof effect.buffId === 'string' ? effect.buffId.trim() : '';
  if (!buffId) return;
  
  const buffType = effect.type === 'buff' ? 'buff' : 'debuff';
  const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
  const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));
  const runtimeData = buildBuffRuntimeData(caster, target, skill, effect);
  
  addBuff(target, {
    id: `${buffId}-${Date.now()}`,
    buffDefId: buffId,
    name: buffId,
    type: buffType,
    category: 'skill',
    sourceUnitId: caster.id,
    maxStacks: stacks,
    attrModifiers: runtimeData.attrModifiers,
    dot: runtimeData.dot,
    hot: runtimeData.hot,
    tags: [],
    dispellable: true,
  }, duration, stacks);
  
  result.buffsApplied?.push(buffId);
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
  const rate = Math.max(0, Math.floor(toFiniteNumber(effect.value, 0)));
  if (rate <= 0) return;
  const healAmount = Math.floor(damage * rate / 10000);
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
  const controlRate = Math.max(0, Math.floor(toFiniteNumber(effect.chance, 10000)));
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
  effect: SkillEffect
): void {
  const value = Math.max(0, Math.floor(toFiniteNumber(effect.value, 0)));
  if (value <= 0) return;
  target.lingqi = Math.min(target.lingqi + value, target.currentAttrs.max_lingqi);
}

/**
 * 执行资源效果
 */
function executeResourceEffect(
  target: BattleUnit,
  effect: SkillEffect
): void {
  const value = effect.value || 0;
  
  if (effect.resourceType === 'lingqi') {
    target.lingqi = Math.min(
      target.lingqi + value,
      target.currentAttrs.max_lingqi
    );
  } else if (effect.resourceType === 'qixue') {
    target.qixue = Math.min(
      target.qixue + value,
      target.currentAttrs.max_qixue
    );
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
      scaleRate: 10000,
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
    if ((unit.skillCooldowns[skill.id] || 0) > 0) return false;
    
    // 检查消耗
    if (skill.cost.lingqi && unit.lingqi < skill.cost.lingqi) return false;
    if (skill.cost.qixue && unit.qixue <= skill.cost.qixue) return false;
    
    // 检查触发类型
    if (skill.triggerType !== 'active') return false;
    
    return true;
  });
}
