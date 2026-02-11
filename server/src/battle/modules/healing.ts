/**
 * 九州修仙录 - 治疗计算模块
 */

import type { BattleState, BattleUnit, BattleSkill } from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';

export interface HealResult {
  baseHeal: number;
  actualHeal: number;
  overHeal: number;
}

/**
 * 计算治疗量
 */
export function calculateHealing(
  state: BattleState,
  healer: BattleUnit,
  target: BattleUnit,
  _skill: BattleSkill,
  healValue?: number
): HealResult {
  // 基础治疗
  let baseHeal = Math.max(0, Math.floor(Number(healValue) || 0));

  // 治疗加成
  const healBonus = Math.min(healer.currentAttrs.zhiliao, BATTLE_CONSTANTS.MAX_HEAL_BONUS);
  baseHeal *= (1 + healBonus / 10000);

  // 减疗效果
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  baseHeal *= (1 - healReduction / 10000);

  if (state.battleType === 'pvp') {
    baseHeal *= 0.1;
  }

  // 治疗上限
  const healCap = target.currentAttrs.max_qixue * BATTLE_CONSTANTS.HEAL_CAP_PERCENT;
  baseHeal = Math.min(baseHeal, healCap);

  // 实际治疗（不超过缺失气血）
  const missingHp = target.currentAttrs.max_qixue - target.qixue;
  const actualHeal = Math.min(Math.floor(baseHeal), missingHp);
  const overHeal = Math.floor(baseHeal) - actualHeal;

  return {
    baseHeal: Math.floor(baseHeal),
    actualHeal,
    overHeal,
  };
}

/**
 * 应用治疗
 */
export function applyHealing(
  target: BattleUnit,
  healAmount: number,
  _healerId?: string
): number {
  const missingHp = target.currentAttrs.max_qixue - target.qixue;
  const actualHeal = Math.min(healAmount, missingHp);
  
  target.qixue += actualHeal;
  target.stats.healingReceived += actualHeal;
  
  return actualHeal;
}

/**
 * 计算吸血
 */
export function calculateLifesteal(
  attacker: BattleUnit,
  damage: number
): number {
  const lifestealRate = Math.min(attacker.currentAttrs.xixue, BATTLE_CONSTANTS.MAX_LIFESTEAL);
  return Math.floor(damage * lifestealRate / 10000);
}

/**
 * 应用吸血
 */
export function applyLifesteal(
  attacker: BattleUnit,
  damage: number
): number {
  const lifestealAmount = calculateLifesteal(attacker, damage);
  if (lifestealAmount <= 0) return 0;
  
  const actualHeal = applyHealing(attacker, lifestealAmount);
  attacker.stats.healingDone += actualHeal;
  
  return actualHeal;
}
