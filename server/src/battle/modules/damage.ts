/**
 * 九州修仙录 - 伤害计算模块
 */

import type { BattleState, BattleUnit, DamageResult } from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';

export interface DamageProfile {
  damageType: 'physical' | 'magic' | 'true';
  element?: string;
  baseDamage: number;
}

/**
 * 计算伤害
 */
export function calculateDamage(
  state: BattleState,
  attacker: BattleUnit,
  defender: BattleUnit,
  profile: DamageProfile
): DamageResult {
  const result: DamageResult = {
    damage: 0,
    isMiss: false,
    isParry: false,
    isCrit: false,
    isElementBonus: false,
    shieldAbsorbed: 0,
    actualDamage: 0,
  };

  // 1. 基础伤害
  let damage = Math.max(0, profile.baseDamage);
  if (damage <= 0) return result;

  // 2. 命中判定
  const hitRate = clamp(
    attacker.currentAttrs.mingzhong - defender.currentAttrs.shanbi,
    BATTLE_CONSTANTS.MIN_HIT_RATE,
    BATTLE_CONSTANTS.MAX_HIT_RATE
  );
  
  if (!rollChance(state, hitRate)) {
    result.isMiss = true;
    return result;
  }

  // 3. 防御减伤（真实伤害跳过）
  if (profile.damageType !== 'true') {
    const defense = profile.damageType === 'physical' 
      ? defender.currentAttrs.wufang 
      : defender.currentAttrs.fafang;
    const defenseConstant = getDefenseConstant(defender.currentAttrs.realm);
    const defenseReduction = defense / (defense + defenseConstant);
    damage *= (1 - defenseReduction);
  }

  // 4. 招架判定
  const parryRate = Math.min(defender.currentAttrs.zhaojia, BATTLE_CONSTANTS.MAX_PARRY_RATE);
  if (rollChance(state, parryRate)) {
    result.isParry = true;
    damage *= BATTLE_CONSTANTS.PARRY_REDUCTION;
  }

  // 5. 暴击判定
  const critRate = clamp(
    attacker.currentAttrs.baoji - defender.currentAttrs.kangbao,
    0,
    BATTLE_CONSTANTS.MAX_CRIT_RATE
  );
  
  if (rollChance(state, critRate)) {
    result.isCrit = true;
    const critDamageBonus = clamp(attacker.currentAttrs.baoshang, 0, BATTLE_CONSTANTS.MAX_CRIT_DAMAGE);
    damage *= (10000 + critDamageBonus) / 10000;
  }

  // 6. 增伤加成
  const damageBonus = Math.min(attacker.currentAttrs.zengshang, BATTLE_CONSTANTS.MAX_DAMAGE_BONUS);
  damage *= (1 + damageBonus / 10000);

  // 7. 五行克制
  if (isElementCounter(profile.element, defender.currentAttrs.element)) {
    result.isElementBonus = true;
    damage *= (1 + BATTLE_CONSTANTS.ELEMENT_COUNTER_BONUS / 10000);
  }

  // 8. 五行抗性
  const resistance = getElementResistance(defender, profile.element);
  const cappedResistance = Math.min(resistance, BATTLE_CONSTANTS.MAX_ELEMENT_RESIST);
  damage *= (1 - cappedResistance / 10000);

  // 最终伤害取整，最低1点
  result.damage = Math.floor(Math.max(1, damage));
  
  return result;
}

/**
 * 应用伤害到目标（含护盾吸收）
 */
export function applyDamage(
  _state: BattleState,
  target: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true'
): { actualDamage: number; shieldAbsorbed: number } {
  let remainingDamage = damage;
  let totalAbsorbed = 0;

  // 按优先级处理护盾
  const sortedShields = [...target.shields].sort((a, b) => b.priority - a.priority);
  
  for (const shield of sortedShields) {
    if (remainingDamage <= 0) break;
    
    // 检查护盾类型是否匹配
    if (shield.absorbType !== 'all' && shield.absorbType !== damageType) {
      continue;
    }
    
    const absorbed = Math.min(shield.value, remainingDamage);
    shield.value -= absorbed;
    remainingDamage -= absorbed;
    totalAbsorbed += absorbed;
    
    // 移除耗尽的护盾
    if (shield.value <= 0) {
      target.shields = target.shields.filter(s => s.id !== shield.id);
    }
  }

  // 扣除气血
  const actualDamage = Math.min(remainingDamage, target.qixue);
  target.qixue -= actualDamage;
  
  // 更新统计
  target.stats.damageTaken += actualDamage;
  
  // 检查死亡
  if (target.qixue <= 0) {
    target.qixue = 0;
    target.isAlive = false;
  }

  return { actualDamage, shieldAbsorbed: totalAbsorbed };
}

/**
 * 获取防御常数
 */
export function getDefenseConstant(realm?: string): number {
  if (!realm) return BATTLE_CONSTANTS.DEFENSE_CONSTANT['凡人'];
  return BATTLE_CONSTANTS.DEFENSE_CONSTANT[realm] || BATTLE_CONSTANTS.DEFENSE_CONSTANT['凡人'];
}

/**
 * 判断五行克制
 */
export function isElementCounter(attackElement?: string, defendElement?: string): boolean {
  if (!attackElement || !defendElement || attackElement === 'none' || defendElement === 'none') {
    return false;
  }
  return BATTLE_CONSTANTS.ELEMENT_COUNTER[attackElement] === defendElement;
}

/**
 * 获取五行抗性
 */
export function getElementResistance(unit: BattleUnit, element?: string): number {
  if (!element || element === 'none') return 0;
  
  const resistanceMap: Record<string, keyof typeof unit.currentAttrs> = {
    'jin': 'jin_kangxing',
    'mu': 'mu_kangxing',
    'shui': 'shui_kangxing',
    'huo': 'huo_kangxing',
    'tu': 'tu_kangxing',
  };
  
  const key = resistanceMap[element];
  return key ? (unit.currentAttrs[key] as number) || 0 : 0;
}

/**
 * 数值限制
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
