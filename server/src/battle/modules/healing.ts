/**
 * 九州修仙录 - 治疗计算模块
 */

import type { BattleUnit } from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';

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
function calculateLifesteal(
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
