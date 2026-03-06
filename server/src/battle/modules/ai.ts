/**
 * 九州修仙录 - AI决策模块
 * 
 * 目标：
 * 1. 怪物不再依赖 behavior 配置，统一走同一套“按权重/随机”策略
 * 2. 统一策略下支持治疗技能避开满血目标
 */

import type { BattleState, BattleUnit, BattleSkill } from '../types.js';
import { getNextRandom, getRandomInt } from '../utils/random.js';
import { resolveSingleAllyTargetId } from '../utils/allyTargeting.js';
import { getAvailableSkills, getNormalAttack } from './skill.js';
import { getLowestHpTarget, getHighestThreatTarget, getHealTargets } from './target.js';
import { isStunned, isFeared, getTauntSource } from './control.js';

type AIDecision = {
  skill: BattleSkill;
  targetIds: string[];
};

/**
 * AI决策主入口
 */
export function makeAIDecision(
  state: BattleState,
  unit: BattleUnit
): AIDecision {
  // 被眩晕/冻结无法行动，直接保底普攻
  if (isStunned(unit)) {
    return { skill: getNormalAttack(unit), targetIds: [] };
  }

  // 恐惧状态下随机攻击任意阵营单位
  if (isFeared(unit)) {
    return makeFearDecision(state, unit);
  }

  // 玩家AI逻辑保持原有“明确技能优先”行为
  if (unit.type === 'player') {
    const availableSkills = getAvailableSkills(unit);
    const selectedSkill = availableSkills.find((s) => s.id !== 'skill-normal-attack') ?? getNormalAttack(unit);
    const targetIds = selectTargets(state, unit, selectedSkill);
    return { skill: selectedSkill, targetIds };
  }

  // 怪物采用统一策略：优先按权重随机，权重缺失时等权随机
  const availableSkills = getAvailableSkills(unit);
  if (availableSkills.length === 0) {
    const fallbackSkill = getNormalAttack(unit);
    return {
      skill: fallbackSkill,
      targetIds: selectTargets(state, unit, fallbackSkill),
    };
  }

  const selectedSkill = selectMonsterSkill(state, unit, availableSkills);
  const targetIds = selectTargets(state, unit, selectedSkill);
  return { skill: selectedSkill, targetIds };
}

function makeFearDecision(state: BattleState, unit: BattleUnit): AIDecision {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  const allTargets = [...allies, ...enemies].filter((u) => u.isAlive);

  if (allTargets.length === 0) {
    return { skill: getNormalAttack(unit), targetIds: [] };
  }

  const targetIndex = getRandomInt(state, allTargets.length);
  const randomTarget = allTargets[targetIndex];

  return {
    skill: getNormalAttack(unit),
    targetIds: [randomTarget.id],
  };
}

/**
 * 怪物统一技能池：有血量阈值时剔除“会治疗已满血目标”的技能。
 * 如果没有可选治疗技能（即有受伤单位），则直接可选全部技能。
 */
function selectMonsterSkill(state: BattleState, unit: BattleUnit, availableSkills: BattleSkill[]): BattleSkill {
  const skillPool = getAllowedMonsterSkillPool(state, unit, availableSkills);
  const weightedSkill = selectWeightedSkill(state, skillPool, unit.aiProfile?.skillWeights ?? {});
  if (weightedSkill) {
    return weightedSkill;
  }
  if (skillPool.length > 0) {
    return pickRandomSkill(state, skillPool, unit);
  }
  return getNormalAttack(unit);
}

function getAllowedMonsterSkillPool(
  state: BattleState,
  unit: BattleUnit,
  availableSkills: BattleSkill[]
): BattleSkill[] {
  if (canHealAnyAlly(state, unit)) {
    return availableSkills;
  }

  const nonHealSkills = availableSkills.filter((skill) => !hasHealEffect(skill));
  return nonHealSkills.length > 0 ? nonHealSkills : availableSkills;
}

function canHealAnyAlly(state: BattleState, unit: BattleUnit): boolean {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const aliveAllies = allies.filter((u) => u.isAlive);
  return getHealTargets(aliveAllies, 1).length > 0;
}

function hasHealEffect(skill: BattleSkill): boolean {
  return skill.effects.some((effect) => effect.type === 'heal');
}

function toPositiveWeight(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function selectWeightedSkill(
  state: BattleState,
  availableSkills: BattleSkill[],
  skillWeights: Record<string, number>
): BattleSkill | null {
  const weighted = availableSkills
    .map((skill) => ({ skill, weight: toPositiveWeight(skillWeights[skill.id]) }))
    .filter((entry) => entry.weight > 0);
  if (weighted.length === 0) return null;

  const totalWeight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;

  let cursor = getNextRandom(state) * totalWeight;
  for (const entry of weighted) {
    cursor -= entry.weight;
    if (cursor <= 0) {
      return entry.skill;
    }
  }
  return weighted[weighted.length - 1]?.skill ?? null;
}

function pickRandomSkill(state: BattleState, skills: BattleSkill[], unit: BattleUnit): BattleSkill {
  if (skills.length === 0) return getNormalAttack(unit);
  const index = getRandomInt(state, skills.length);
  return skills[index] ?? getNormalAttack(unit);
}

/**
 * 目标选择入口
 */
export function selectTargets(
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill
): string[] {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;

  const aliveAllies = allies.filter((u) => u.isAlive);
  const aliveEnemies = enemies.filter((u) => u.isAlive);

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
      return [];
    default:
      return [];
  }
}

/**
 * 单体敌方目标：优先嘲讽，其次低血 -> 威胁高 -> 首位
 */
function selectSingleEnemyTarget(unit: BattleUnit, enemies: BattleUnit[]): string[] {
  if (enemies.length === 0) return [];

  const tauntSourceId = getTauntSource(unit);
  if (tauntSourceId) {
    const tauntTarget = enemies.find((e) => e.id === tauntSourceId);
    if (tauntTarget) {
      return [tauntTarget.id];
    }
  }

  const lowHpTarget = getLowestHpTarget(enemies);
  if (lowHpTarget && lowHpTarget.qixue / lowHpTarget.currentAttrs.max_qixue < 0.3) {
    return [lowHpTarget.id];
  }

  const highThreatTarget = getHighestThreatTarget(enemies);
  if (highThreatTarget) {
    return [highThreatTarget.id];
  }

  return [enemies[0].id];
}

/**
 * 单体友方目标：
 * - 治疗技能：只会命中未满血目标
 * - 其他辅助：优先高输出单位
 */
function selectSingleAllyTarget(
  unit: BattleUnit,
  skill: BattleSkill,
  allies: BattleUnit[]
): string[] {
  const targetId = resolveSingleAllyTargetId(unit, skill, allies);
  return targetId ? [targetId] : [];
}
