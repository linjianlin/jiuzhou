/**
 * 反应型伤害复用模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一处理“基于已发生伤害再派生的二次伤害”计算与落地，例如反弹伤害、回响伤害。
 * 2) 不做什么：不负责命中/暴击/招架判定，不直接决定触发时机，调用方只在已满足触发条件后使用。
 *
 * 输入/输出：
 * - 输入：已发生的源伤害、比例系数，以及二次伤害的来源/目标单位。
 * - 输出：归一化后的派生伤害数值，和包含 hit/死亡日志的统一结算结果。
 *
 * 数据流/状态流：
 * - 主伤害/受击结果 -> 本模块换算二次伤害 -> applyDamage 落地 -> 交还给技能/套装日志层拼装 action。
 *
 * 关键边界条件与坑点：
 * 1) 这里只处理“已知数值”的二次伤害，因此不会再次触发命中、暴击、招架，避免递归放大与日志乱序。
 * 2) 比例与源伤害任一非正时直接返回 0，表示本次不应派生伤害，而不是偷偷兜底为 1。
 */

import type { BattleLogEntry, BattleState, BattleUnit, TargetHitResult } from '../types.js';
import { applyDamage } from './damage.js';
import { calculateDefenseReductionRate } from './defense.js';

export interface ReactiveDamageApplyResult {
  actualDamage: number;
  shieldAbsorbed: number;
  hit: TargetHitResult;
  extraLogs: BattleLogEntry[];
}

export function calculateReactiveDamageByRate(
  sourceDamage: number,
  rate: number,
  damageMultiplier = 1,
): number {
  if (!Number.isFinite(sourceDamage) || sourceDamage <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  if (!Number.isFinite(damageMultiplier) || damageMultiplier <= 0) return 0;
  return Math.floor(sourceDamage * rate * damageMultiplier);
}

export function applyReactiveDamage(
  state: BattleState,
  source: BattleUnit,
  target: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true',
): ReactiveDamageApplyResult | null {
  const normalizedDamage = Math.floor(damage);
  if (!Number.isFinite(normalizedDamage) || normalizedDamage <= 0) return null;
  const reducedDamage = applyReactiveDefenseReduction(target, normalizedDamage, damageType);
  if (reducedDamage <= 0) return null;

  const wasAlive = target.isAlive;
  const { actualDamage, shieldAbsorbed } = applyDamage(state, target, reducedDamage, damageType);
  const safeDamage = Math.max(0, actualDamage);
  const safeShieldAbsorbed = Math.max(0, shieldAbsorbed);
  source.stats.damageDealt += safeDamage;

  const extraLogs: BattleLogEntry[] = [];
  if (wasAlive && !target.isAlive) {
    source.stats.killCount += 1;
    extraLogs.push({
      type: 'death',
      round: state.roundCount,
      unitId: target.id,
      unitName: target.name,
      killerId: source.id,
      killerName: source.name,
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

export function applyReactiveTrueDamage(
  state: BattleState,
  source: BattleUnit,
  target: BattleUnit,
  damage: number,
): ReactiveDamageApplyResult | null {
  return applyReactiveDamage(state, source, target, damage, 'true');
}

function applyReactiveDefenseReduction(
  target: BattleUnit,
  damage: number,
  damageType: 'physical' | 'magic' | 'true',
): number {
  if (damageType === 'true') return damage;
  const reductionRate = calculateDefenseReductionRate(target, damageType);
  return Math.max(0, Math.floor(damage * (1 - reductionRate)));
}
