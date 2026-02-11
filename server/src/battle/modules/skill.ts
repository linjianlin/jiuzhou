/**
 * 九州修仙录 - 技能执行模块
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleSkill, 
  SkillEffect,
  ActionLog,
  TargetResult,
  DamageResult
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';
import { calculateDamage, applyDamage } from './damage.js';
import { calculateHealing, applyHealing, applyLifesteal } from './healing.js';
import { addBuff, addShield } from './buff.js';
import { tryApplyControl, canUseSkill, isSilenced, isDisarmed } from './control.js';
import { resolveTargets } from './target.js';
import { triggerSetBonusEffects } from './setBonus.js';

export interface SkillExecutionResult {
  success: boolean;
  log?: ActionLog;
  error?: string;
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
    buffsApplied: [],
    buffsRemoved: [],
  };
  
  // 处理伤害
  if (skill.damageType && skill.coefficient > 0) {
    const damageResult = calculateDamage(state, caster, target, skill);
    
    if (damageResult.isMiss) {
      result.isMiss = true;
    } else {
      const { actualDamage: damageApplied, shieldAbsorbed } = applyDamage(
        state, target, damageResult.damage, skill.damageType
      );
      const actualDamage = Math.max(0, damageApplied);

      result.damage = actualDamage;
      result.shieldAbsorbed = shieldAbsorbed;
      result.isCrit = damageResult.isCrit;
      result.isParry = damageResult.isParry;
      result.isElementBonus = damageResult.isElementBonus;
      
      // 更新统计
      caster.stats.damageDealt += actualDamage;
      
      // 吸血
      if (actualDamage > 0) {
        applyLifesteal(caster, actualDamage);
      }
      
      // 检查击杀
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
  }
  
  // 处理技能效果
  for (const effect of skill.effects) {
    // 概率判定
    if (effect.chance && !rollChance(state, effect.chance)) {
      continue;
    }
    
    executeEffect(state, caster, target, effect, result);
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
  effect: SkillEffect,
  result: TargetResult
): void {
  switch (effect.type) {
    case 'damage':
      // 额外伤害（已在主伤害中处理）
      break;
      
    case 'heal':
      executeHealEffect(state, caster, target, effect, result);
      break;
      
    case 'shield':
      executeShieldEffect(target, effect, result);
      break;
      
    case 'buff':
    case 'debuff':
      executeBuffEffect(caster, target, effect, result);
      break;
      
    case 'dispel':
      executeDispelEffect(target, effect, result);
      break;
      
    case 'resource':
      executeResourceEffect(target, effect);
      break;
  }
  
  // 控制效果
  if (effect.controlType && effect.controlRate && effect.controlDuration) {
    const controlResult = tryApplyControl(
      state, caster, target,
      effect.controlType,
      effect.controlRate,
      effect.controlDuration
    );
    
    if (controlResult.success) {
      result.controlApplied = effect.controlType;
    } else if (controlResult.resisted) {
      result.controlResisted = true;
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
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const shieldValue = effect.value || 0;
  
  addShield(target, {
    value: shieldValue,
    maxValue: shieldValue,
    duration: effect.buffDuration || 2,
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
  effect: SkillEffect,
  result: TargetResult
): void {
  if (!effect.buffDefId) return;
  
  const buffType = effect.type === 'buff' ? 'buff' : 'debuff';
  
  addBuff(target, {
    id: `${effect.buffDefId}-${Date.now()}`,
    buffDefId: effect.buffDefId,
    name: effect.buffDefId,
    type: buffType,
    category: 'skill',
    sourceUnitId: caster.id,
    maxStacks: effect.buffStacks || 1,
    tags: [],
    dispellable: true,
  }, effect.buffDuration || 1, effect.buffStacks || 1);
  
  result.buffsApplied?.push(effect.buffDefId);
}

/**
 * 执行驱散效果
 */
function executeDispelEffect(
  target: BattleUnit,
  effect: SkillEffect,
  result: TargetResult
): void {
  const dispelCount = effect.dispelCount || 1;
  const dispelType = effect.dispelType || 'debuff';
  
  let removed = 0;
  const toRemove: string[] = [];
  
  for (const buff of target.buffs) {
    if (removed >= dispelCount) break;
    
    if (!buff.dispellable) continue;
    
    if (dispelType === 'all' || buff.type === dispelType) {
      toRemove.push(buff.id);
      result.buffsRemoved?.push(buff.name);
      removed++;
    }
  }
  
  target.buffs = target.buffs.filter(b => !toRemove.includes(b.id));
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
    coefficient: 1.0,
    fixedDamage: 0,
    effects: [],
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
