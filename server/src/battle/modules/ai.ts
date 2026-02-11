/**
 * 九州修仙录 - AI决策模块
 */

import type { BattleState, BattleUnit, BattleSkill } from '../types.js';
import { rollChance, getRandomInt } from '../utils/random.js';
import { getAvailableSkills, getNormalAttack } from './skill.js';
import { 
  getLowestHpTarget, 
  getHighestThreatTarget, 
  getHealTargets
} from './target.js';
import { isStunned, isFeared, getTauntSource } from './control.js';

// AI行为模式
export type AIBehavior = 'passive' | 'aggressive' | 'defensive' | 'support' | 'boss';

export interface AIDecision {
  skill: BattleSkill;
  targetIds: string[];
}

/**
 * AI决策主函数
 */
export function makeAIDecision(
  state: BattleState,
  unit: BattleUnit
): AIDecision {
  // 被眩晕/冻结无法行动
  if (isStunned(unit)) {
    return { skill: getNormalAttack(unit), targetIds: [] };
  }
  
  // 恐惧状态随机行动
  if (isFeared(unit)) {
    return makeFearDecision(state, unit);
  }

  if (unit.type === 'player') {
    const availableSkills = getAvailableSkills(unit);
    const selectedSkill = availableSkills.find((s) => s.id !== 'skill-normal-attack') ?? getNormalAttack(unit);
    const targetIds = selectTargets(state, unit, selectedSkill);
    return { skill: selectedSkill, targetIds };
  }
  
  // 获取AI行为模式
  const behavior = getAIBehavior(unit);
  
  // 获取可用技能
  const availableSkills = getAvailableSkills(unit);
  
  // 根据行为模式选择技能
  let selectedSkill: BattleSkill;
  
  switch (behavior) {
    case 'aggressive':
      selectedSkill = selectAggressiveSkill(state, unit, availableSkills);
      break;
    case 'defensive':
      selectedSkill = selectDefensiveSkill(unit, availableSkills);
      break;
    case 'support':
      selectedSkill = selectSupportSkill(state, unit, availableSkills);
      break;
    case 'boss':
      selectedSkill = selectBossSkill(state, unit, availableSkills);
      break;
    default:
      selectedSkill = selectPassiveSkill(unit);
  }
  
  // 选择目标
  const targetIds = selectTargets(state, unit, selectedSkill);
  
  return { skill: selectedSkill, targetIds };
}

/**
 * 获取AI行为模式
 */
function getAIBehavior(_unit: BattleUnit): AIBehavior {
  // 可以从unit的扩展属性中读取，这里默认aggressive
  return 'aggressive';
}

/**
 * 恐惧状态随机行动
 */
function makeFearDecision(state: BattleState, unit: BattleUnit): AIDecision {
  const isAttacker = state.teams.attacker.units.some(u => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  
  const allTargets = [...allies, ...enemies].filter(u => u.isAlive);
  
  if (allTargets.length === 0) {
    return { skill: getNormalAttack(unit), targetIds: [] };
  }
  
  const randomTarget = allTargets[getRandomInt(state, allTargets.length)];
  
  return {
    skill: getNormalAttack(unit),
    targetIds: [randomTarget.id],
  };
}

/**
 * 被动模式：只用普攻
 */
function selectPassiveSkill(unit: BattleUnit): BattleSkill {
  return getNormalAttack(unit);
}

function getDamageEffects(skill: BattleSkill): Array<BattleSkill['effects'][number]> {
  return skill.effects.filter((e) => e.type === 'damage');
}

function isDamageSkill(skill: BattleSkill): boolean {
  return getDamageEffects(skill).length > 0;
}

function getDamageScaleScore(skill: BattleSkill): number {
  let score = 0;
  for (const effect of getDamageEffects(skill)) {
    const scaleRateRaw = Number(effect.scaleRate ?? effect.value ?? 0);
    const scaleRate = Number.isFinite(scaleRateRaw) ? Math.max(0, scaleRateRaw) : 0;
    const hitCountRaw = Number(effect.hit_count ?? 1);
    const hitCount = Number.isFinite(hitCountRaw) ? Math.max(1, Math.floor(hitCountRaw)) : 1;
    score = Math.max(score, scaleRate * hitCount);
  }
  return score;
}

/**
 * 激进模式：优先高伤害技能
 */
function selectAggressiveSkill(
  state: BattleState,
  unit: BattleUnit,
  availableSkills: BattleSkill[]
): BattleSkill {
  // 筛选伤害技能
  const damageSkills = availableSkills.filter((s) => isDamageSkill(s));
  
  if (damageSkills.length === 0) {
    return getNormalAttack(unit);
  }
  
  // 按优先级和系数排序
  damageSkills.sort((a, b) => {
    const scoreA = a.aiPriority + getDamageScaleScore(a);
    const scoreB = b.aiPriority + getDamageScaleScore(b);
    return scoreB - scoreA;
  });
  
  // 有一定概率选择次优技能增加随机性
  if (damageSkills.length > 1 && rollChance(state, 3000)) {
    return damageSkills[1];
  }
  
  return damageSkills[0];
}

/**
 * 防守模式：优先生存技能
 */
function selectDefensiveSkill(
  unit: BattleUnit,
  availableSkills: BattleSkill[]
): BattleSkill {
  const hpPercent = unit.qixue / unit.currentAttrs.max_qixue;
  
  // 血量低时优先护盾/治疗
  if (hpPercent < 0.5) {
    const survivalSkills = availableSkills.filter(s =>
      s.effects.some(e => e.type === 'shield' || e.type === 'heal')
    );
    
    if (survivalSkills.length > 0) {
      return survivalSkills[0];
    }
  }
  
  // 否则使用普攻
  return getNormalAttack(unit);
}

/**
 * 辅助模式：优先治疗/增益
 */
function selectSupportSkill(
  state: BattleState,
  unit: BattleUnit,
  availableSkills: BattleSkill[]
): BattleSkill {
  const isAttacker = state.teams.attacker.units.some(u => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  
  // 检查是否有需要治疗的队友
  const healTargets = getHealTargets(allies, 0.6);
  
  if (healTargets.length > 0) {
    const healSkills = availableSkills.filter(s =>
      s.effects.some(e => e.type === 'heal') &&
      (s.targetType === 'single_ally' || s.targetType === 'all_ally')
    );
    
    if (healSkills.length > 0) {
      return healSkills[0];
    }
  }
  
  // 检查是否有增益技能
  const buffSkills = availableSkills.filter(s =>
    s.effects.some(e => e.type === 'buff') &&
    (s.targetType === 'single_ally' || s.targetType === 'all_ally' || s.targetType === 'self')
  );
  
  if (buffSkills.length > 0 && rollChance(state, 5000)) {
    return buffSkills[0];
  }
  
  return getNormalAttack(unit);
}

/**
 * Boss模式：按阶段切换策略
 */
function selectBossSkill(
  state: BattleState,
  unit: BattleUnit,
  availableSkills: BattleSkill[]
): BattleSkill {
  const hpPercent = unit.qixue / unit.currentAttrs.max_qixue;
  
  // 阶段1：血量>70%，正常输出
  if (hpPercent > 0.7) {
    return selectAggressiveSkill(state, unit, availableSkills);
  }
  
  // 阶段2：血量30%-70%，使用强力技能
  if (hpPercent > 0.3) {
    const powerSkills = availableSkills.filter(s => 
      s.aiPriority >= 80 || s.targetType === 'all_enemy'
    );
    
    if (powerSkills.length > 0) {
      return powerSkills[0];
    }
  }
  
  // 阶段3：血量<30%，狂暴模式
  const ultimateSkills = availableSkills.filter(s => s.aiPriority >= 90);
  if (ultimateSkills.length > 0) {
    return ultimateSkills[0];
  }
  
  return selectAggressiveSkill(state, unit, availableSkills);
}

/**
 * 选择目标
 */
function selectTargets(
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill
): string[] {
  const isAttacker = state.teams.attacker.units.some(u => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  
  const aliveAllies = allies.filter(u => u.isAlive);
  const aliveEnemies = enemies.filter(u => u.isAlive);
  
  switch (skill.targetType) {
    case 'self':
      return [unit.id];
      
    case 'single_enemy':
      return selectSingleEnemyTarget(unit, aliveEnemies);
      
    case 'single_ally':
      return selectSingleAllyTarget(unit, skill, aliveAllies);
      
    case 'all_enemy':
    case 'all_ally':
    case 'random_enemy':
    case 'random_ally':
      // 这些类型不需要指定目标
      return [];
      
    default:
      return [];
  }
}

/**
 * 选择单体敌方目标
 */
function selectSingleEnemyTarget(
  unit: BattleUnit,
  enemies: BattleUnit[]
): string[] {
  if (enemies.length === 0) return [];
  
  // 检查嘲讽
  const tauntSourceId = getTauntSource(unit);
  if (tauntSourceId) {
    const tauntTarget = enemies.find(e => e.id === tauntSourceId);
    if (tauntTarget) {
      return [tauntTarget.id];
    }
  }
  
  // 优先攻击低血量目标
  const lowHpTarget = getLowestHpTarget(enemies);
  if (lowHpTarget && lowHpTarget.qixue / lowHpTarget.currentAttrs.max_qixue < 0.3) {
    return [lowHpTarget.id];
  }
  
  // 优先攻击高威胁目标
  const highThreatTarget = getHighestThreatTarget(enemies);
  if (highThreatTarget) {
    return [highThreatTarget.id];
  }
  
  // 默认第一个
  return [enemies[0].id];
}

/**
 * 选择单体友方目标
 */
function selectSingleAllyTarget(
  unit: BattleUnit,
  skill: BattleSkill,
  allies: BattleUnit[]
): string[] {
  if (allies.length === 0) return [];
  
  // 治疗技能选择最低血量
  const isHealSkill = skill.effects.some(e => e.type === 'heal');
  if (isHealSkill) {
    const healTargets = getHealTargets(allies);
    if (healTargets.length > 0) {
      return [healTargets[0].id];
    }
  }
  
  // 增益技能选择自己或输出最高的
  const isBuffSkill = skill.effects.some(e => e.type === 'buff');
  if (isBuffSkill) {
    const highestDamage = allies.reduce((highest, current) => 
      current.stats.damageDealt > highest.stats.damageDealt ? current : highest
    );
    return [highestDamage.id];
  }
  
  // 默认自己
  return [unit.id];
}

/**
 * 计算技能权重
 */
export function calculateSkillWeight(
  _state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
  enemies: BattleUnit[],
  allies: BattleUnit[]
): number {
  let weight = skill.aiPriority;
  
  // 根据战场状态调整
  const hpPercent = unit.qixue / unit.currentAttrs.max_qixue;
  
  // 自身血量低时提高生存技能权重
  if (hpPercent < 0.3) {
    if (skill.effects.some(e => e.type === 'heal' || e.type === 'shield')) {
      weight += 100;
    }
  }
  
  // 有低血量队友时提高治疗权重
  const lowHpAllies = allies.filter(a => 
    a.isAlive && a.qixue / a.currentAttrs.max_qixue < 0.3
  );
  if (lowHpAllies.length > 0) {
    if (skill.effects.some(e => e.type === 'heal') && 
        (skill.targetType === 'single_ally' || skill.targetType === 'all_ally')) {
      weight += 80;
    }
  }
  
  // 敌人数量多时提高AOE权重
  if (enemies.length >= 3 && skill.targetType === 'all_enemy') {
    weight += 50;
  }
  
  // 敌人低血量时提高伤害技能权重
  const lowHpEnemies = enemies.filter(e => 
    e.isAlive && e.qixue / e.currentAttrs.max_qixue < 0.2
  );
  if (lowHpEnemies.length > 0 && isDamageSkill(skill)) {
    weight += 30;
  }
  
  return weight;
}
