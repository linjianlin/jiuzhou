/**
 * 九州修仙录 - 目标解析模块
 */

import type { BattleState, BattleUnit, BattleSkill } from '../types.js';
import { shuffle } from '../utils/random.js';
import { resolveSingleAllyTargetId } from '../utils/allyTargeting.js';
import { getTauntSource } from './control.js';

/**
 * 解析技能目标
 */
export function resolveTargets(
  state: BattleState,
  caster: BattleUnit,
  skill: BattleSkill,
  selectedTargetIds?: string[]
): BattleUnit[] {
  const isAttacker = state.teams.attacker.units.some(u => u.id === caster.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  
  const aliveAllies = allies.filter(u => u.isAlive);
  const aliveEnemies = enemies.filter(u => u.isAlive);

  switch (skill.targetType) {
    case 'self':
      return [caster];
      
    case 'single_enemy':
      return resolveSingleEnemy(caster, aliveEnemies, selectedTargetIds);
      
    case 'single_ally':
      return resolveSingleAlly(caster, skill, aliveAllies, selectedTargetIds);
      
    case 'all_enemy':
      return aliveEnemies;
      
    case 'all_ally':
      return aliveAllies;
      
    case 'random_enemy':
      return resolveRandomTargets(state, aliveEnemies, skill.targetCount);
      
    case 'random_ally':
      return resolveRandomTargets(state, aliveAllies, skill.targetCount);
      
    default:
      return [];
  }
}

/**
 * 解析单体敌方目标（考虑嘲讽）
 */
function resolveSingleEnemy(
  caster: BattleUnit,
  enemies: BattleUnit[],
  selectedTargetIds?: string[]
): BattleUnit[] {
  // 检查嘲讽
  const tauntSourceId = getTauntSource(caster);
  if (tauntSourceId) {
    const tauntTarget = enemies.find(e => e.id === tauntSourceId && e.isAlive);
    if (tauntTarget) {
      return [tauntTarget];
    }
  }
  
  // 使用玩家选择的目标
  if (selectedTargetIds && selectedTargetIds.length > 0) {
    const target = enemies.find(e => e.id === selectedTargetIds[0]);
    if (target) {
      return [target];
    }
  }
  
  // 默认选择第一个存活敌人
  return enemies.length > 0 ? [enemies[0]] : [];
}

/**
 * 解析单体友方目标
 */
function resolveSingleAlly(
  caster: BattleUnit,
  skill: BattleSkill,
  allies: BattleUnit[],
  selectedTargetIds?: string[]
): BattleUnit[] {
  const targetId = resolveSingleAllyTargetId(caster, skill, allies, selectedTargetIds);
  if (!targetId) return [];
  const target = allies.find((ally) => ally.id === targetId);
  return target ? [target] : [];
}

/**
 * 解析随机目标
 */
function resolveRandomTargets(
  state: BattleState,
  candidates: BattleUnit[],
  count: number = 1
): BattleUnit[] {
  if (candidates.length === 0) return [];
  if (candidates.length <= count) return [...candidates];
  
  const shuffled = shuffle(state, candidates);
  return shuffled.slice(0, count);
}

/**
 * 获取最低血量目标
 */
export function getLowestHpTarget(units: BattleUnit[]): BattleUnit | undefined {
  const alive = units.filter(u => u.isAlive);
  if (alive.length === 0) return undefined;
  
  return alive.reduce((lowest, current) => {
    const lowestPercent = lowest.qixue / lowest.currentAttrs.max_qixue;
    const currentPercent = current.qixue / current.currentAttrs.max_qixue;
    return currentPercent < lowestPercent ? current : lowest;
  });
}

/**
 * 获取最高威胁目标（按输出伤害排序）
 */
export function getHighestThreatTarget(units: BattleUnit[]): BattleUnit | undefined {
  const alive = units.filter(u => u.isAlive);
  if (alive.length === 0) return undefined;
  
  return alive.reduce((highest, current) => {
    return current.stats.damageDealt > highest.stats.damageDealt ? current : highest;
  });
}

/**
 * 获取需要治疗的友方目标
 */
export function getHealTargets(allies: BattleUnit[], threshold: number = 0.7): BattleUnit[] {
  return allies.filter(u => {
    if (!u.isAlive) return false;
    const hpPercent = u.qixue / u.currentAttrs.max_qixue;
    return hpPercent < threshold;
  }).sort((a, b) => {
    const aPercent = a.qixue / a.currentAttrs.max_qixue;
    const bPercent = b.qixue / b.currentAttrs.max_qixue;
    return aPercent - bPercent;
  });
}

