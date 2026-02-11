/**
 * 九州修仙录 - Buff/Debuff 管理模块
 */

import type { 
  BattleState, 
  BattleUnit, 
  ActiveBuff, 
  DotEffect,
  HotEffect,
  Shield,
  BattleLogEntry 
} from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { applyDamage } from './damage.js';
import { applyHealing } from './healing.js';

/**
 * 添加Buff到单位
 */
export function addBuff(
  unit: BattleUnit,
  buff: Omit<ActiveBuff, 'remainingDuration' | 'stacks'>,
  duration: number,
  stacks: number = 1
): { added: boolean; refreshed: boolean } {
  // 查找已存在的同ID Buff
  const existingIndex = unit.buffs.findIndex(b => b.buffDefId === buff.buffDefId);
  
  if (existingIndex >= 0) {
    const existing = unit.buffs[existingIndex];
    
    // 刷新持续时间
    existing.remainingDuration = Math.max(existing.remainingDuration, duration);
    
    // 叠加层数
    if (existing.maxStacks > 1) {
      existing.stacks = Math.min(existing.stacks + stacks, existing.maxStacks);
    }
    
    return { added: false, refreshed: true };
  }
  
  // 添加新Buff
  const newBuff: ActiveBuff = {
    ...buff,
    remainingDuration: duration,
    stacks: Math.min(stacks, buff.maxStacks),
  };
  
  unit.buffs.push(newBuff);
  
  // 重新计算属性
  recalculateUnitAttrs(unit);
  
  return { added: true, refreshed: false };
}

/**
 * 移除Buff
 */
export function removeBuff(unit: BattleUnit, buffId: string): boolean {
  const index = unit.buffs.findIndex(b => b.id === buffId);
  if (index < 0) return false;
  
  unit.buffs.splice(index, 1);
  recalculateUnitAttrs(unit);
  
  return true;
}

/**
 * 添加护盾
 */
export function addShield(
  unit: BattleUnit,
  shield: Omit<Shield, 'id'>,
  sourceSkillId: string
): void {
  const newShield: Shield = {
    ...shield,
    id: `shield-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    sourceSkillId,
  };
  
  unit.shields.push(newShield);
}

/**
 * 处理回合开始的DOT/HOT
 */
export function processRoundStartEffects(
  state: BattleState,
  unit: BattleUnit
): BattleLogEntry[] {
  const logs: BattleLogEntry[] = [];
  
  for (const buff of unit.buffs) {
    // DOT伤害
    if (buff.dot) {
      const dotDamage = calculateDotDamage(buff.dot, unit);
      const { actualDamage } = applyDamage(state, unit, dotDamage, buff.dot.damageType);
      
      logs.push({
        type: 'dot',
        round: state.roundCount,
        unitId: unit.id,
        unitName: unit.name,
        buffName: buff.name,
        damage: actualDamage,
      });
      
      // 检查死亡
      if (!unit.isAlive) {
        logs.push({
          type: 'death',
          round: state.roundCount,
          unitId: unit.id,
          unitName: unit.name,
        });
      }
    }
    
    // HOT治疗
    if (buff.hot && unit.isAlive) {
      const hotHeal = calculateHotHeal(buff.hot, unit);
      const actualHeal = applyHealing(unit, hotHeal);
      
      if (actualHeal > 0) {
        logs.push({
          type: 'hot',
          round: state.roundCount,
          unitId: unit.id,
          unitName: unit.name,
          buffName: buff.name,
          heal: actualHeal,
        });
      }
    }
  }
  
  return logs;
}

/**
 * 处理回合结束的Buff递减
 */
export function processRoundEndBuffs(
  state: BattleState,
  unit: BattleUnit
): BattleLogEntry[] {
  const logs: BattleLogEntry[] = [];
  
  // Buff持续时间递减
  unit.buffs = unit.buffs.filter(buff => {
    buff.remainingDuration--;
    
    if (buff.remainingDuration <= 0) {
      logs.push({
        type: 'buff_expire',
        round: state.roundCount,
        unitId: unit.id,
        unitName: unit.name,
        buffName: buff.name,
      });
      return false;
    }
    return true;
  });
  
  // 护盾持续时间递减
  unit.shields = unit.shields.filter(shield => {
    if (shield.duration === -1) return true;  // 永久护盾
    shield.duration--;
    return shield.duration > 0;
  });
  
  // 重新计算属性
  recalculateUnitAttrs(unit);
  
  return logs;
}

/**
 * 计算DOT伤害
 */
function calculateDotDamage(dot: DotEffect, target: BattleUnit): number {
  // DOT伤害不受防御影响，但受五行抗性影响
  let damage = dot.damage;
  
  if (dot.element && dot.element !== 'none') {
    const resistance = getElementResistanceForDot(target, dot.element);
    damage *= (1 - resistance / 10000);
  }
  
  return Math.floor(Math.max(1, damage));
}

/**
 * 计算HOT治疗
 */
function calculateHotHeal(hot: HotEffect, target: BattleUnit): number {
  let heal = hot.heal;
  
  // 受减疗影响
  const healReduction = Math.min(target.currentAttrs.jianliao, BATTLE_CONSTANTS.MAX_HEAL_REDUCTION);
  heal *= (1 - healReduction / 10000);
  
  return Math.floor(Math.max(1, heal));
}

/**
 * 重新计算单位属性
 */
function recalculateUnitAttrs(unit: BattleUnit): void {
  // 从基础属性开始
  unit.currentAttrs = { ...unit.baseAttrs };
  
  // 收集所有属性修正
  const flatMods: Record<string, number> = {};
  const percentMods: Record<string, number> = {};
  
  for (const buff of unit.buffs) {
    if (!buff.attrModifiers) continue;
    
    for (const mod of buff.attrModifiers) {
      const value = mod.value * buff.stacks;
      
      if (mod.mode === 'flat') {
        flatMods[mod.attr] = (flatMods[mod.attr] || 0) + value;
      } else {
        percentMods[mod.attr] = (percentMods[mod.attr] || 0) + value;
      }
    }
  }
  
  // 应用固定值修正
  for (const [attr, value] of Object.entries(flatMods)) {
    if (attr in unit.currentAttrs) {
      (unit.currentAttrs as any)[attr] += value;
    }
  }
  
  // 应用百分比修正
  for (const [attr, value] of Object.entries(percentMods)) {
    if (attr in unit.currentAttrs) {
      (unit.currentAttrs as any)[attr] = Math.floor(
        (unit.currentAttrs as any)[attr] * (1 + value / 10000)
      );
    }
  }
  
  // 确保属性不为负
  unit.currentAttrs.max_qixue = Math.max(1, unit.currentAttrs.max_qixue);
  unit.currentAttrs.wugong = Math.max(0, unit.currentAttrs.wugong);
  unit.currentAttrs.fagong = Math.max(0, unit.currentAttrs.fagong);
  unit.currentAttrs.wufang = Math.max(0, unit.currentAttrs.wufang);
  unit.currentAttrs.fafang = Math.max(0, unit.currentAttrs.fafang);
  unit.currentAttrs.sudu = Math.max(0, unit.currentAttrs.sudu);
}

/**
 * 获取五行抗性（用于DOT）
 */
function getElementResistanceForDot(unit: BattleUnit, element: string): number {
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
