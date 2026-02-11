/**
 * 九州修仙录 - 控制效果模块
 */

import type { BattleState, BattleUnit, ActiveBuff } from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';
import { rollChance } from '../utils/random.js';
import { addBuff } from './buff.js';

// 硬控类型（会触发递减）
const HARD_CONTROL_TYPES = ['stun', 'freeze', 'fear'];

// 控制效果定义
const CONTROL_DEFINITIONS: Record<string, {
  name: string;
  category: string;
  tags: string[];
}> = {
  stun: { name: '眩晕', category: 'control', tags: ['hard_control', 'stun'] },
  freeze: { name: '冻结', category: 'control', tags: ['hard_control', 'freeze'] },
  silence: { name: '沉默', category: 'control', tags: ['soft_control', 'silence'] },
  disarm: { name: '缴械', category: 'control', tags: ['soft_control', 'disarm'] },
  root: { name: '定身', category: 'control', tags: ['soft_control', 'root'] },
  taunt: { name: '嘲讽', category: 'control', tags: ['soft_control', 'taunt'] },
  fear: { name: '恐惧', category: 'control', tags: ['hard_control', 'fear'] },
};

interface ControlResult {
  success: boolean;
  resisted: boolean;
  duration: number;
  controlType: string;
}

/**
 * 尝试施加控制效果
 */
export function tryApplyControl(
  state: BattleState,
  source: BattleUnit,
  target: BattleUnit,
  controlType: string,
  baseRate: number,  // 万分比
  baseDuration: number
): ControlResult {
  const result: ControlResult = {
    success: false,
    resisted: false,
    duration: 0,
    controlType,
  };

  // 检查控制类型是否有效
  if (!CONTROL_DEFINITIONS[controlType]) {
    return result;
  }

  // 计算实际控制率（考虑控制抗性）
  const resistance = Math.min(
    target.currentAttrs.kongzhi_kangxing,
    BATTLE_CONSTANTS.MAX_CONTROL_RESIST
  );
  const actualRate = Math.floor(baseRate * (1 - resistance / 10000));

  // 概率判定
  if (!rollChance(state, actualRate)) {
    result.resisted = true;
    return result;
  }

  // 计算实际持续时间（考虑递减）
  let duration = baseDuration;
  
  if (HARD_CONTROL_TYPES.includes(controlType)) {
    duration = applyControlDiminishing(state, target, controlType, baseDuration);
    
    // 免疫期间
    if (duration <= 0) {
      result.resisted = true;
      return result;
    }
  }

  // 创建控制Buff
  const controlDef = CONTROL_DEFINITIONS[controlType];
  const controlBuff: Omit<ActiveBuff, 'remainingDuration' | 'stacks'> = {
    id: `control-${controlType}-${Date.now()}`,
    buffDefId: `control-${controlType}`,
    name: controlDef.name,
    type: 'debuff',
    category: controlDef.category,
    sourceUnitId: source.id,
    maxStacks: 1,
    control: controlType,
    tags: controlDef.tags,
    dispellable: true,
  };

  addBuff(target, controlBuff, duration, 1);

  result.success = true;
  result.duration = duration;
  
  return result;
}

/**
 * 应用控制递减（PVP机制）
 */
function applyControlDiminishing(
  state: BattleState,
  target: BattleUnit,
  controlType: string,
  baseDuration: number
): number {
  // 获取或初始化递减记录
  if (!target.controlDiminishing[controlType]) {
    target.controlDiminishing[controlType] = {
      count: 0,
      resetRound: state.roundCount + BATTLE_CONSTANTS.CONTROL_DIMINISHING_RESET,
    };
  }

  const diminishing = target.controlDiminishing[controlType];

  // 检查是否需要重置
  if (state.roundCount >= diminishing.resetRound) {
    diminishing.count = 0;
    diminishing.resetRound = state.roundCount + BATTLE_CONSTANTS.CONTROL_DIMINISHING_RESET;
  }

  // 计算递减后的持续时间
  let duration: number;
  
  switch (diminishing.count) {
    case 0:
      duration = baseDuration;  // 100%
      break;
    case 1:
      duration = Math.ceil(baseDuration * 0.5);  // 50%
      break;
    case 2:
      duration = Math.ceil(baseDuration * 0.25);  // 25%
      break;
    default:
      duration = 0;  // 免疫
      break;
  }

  // 增加递减计数
  diminishing.count++;
  diminishing.resetRound = state.roundCount + BATTLE_CONSTANTS.CONTROL_DIMINISHING_RESET;

  return duration;
}

/**
 * 检查单位是否被眩晕/冻结（无法行动）
 */
export function isStunned(unit: BattleUnit): boolean {
  return unit.buffs.some(buff => 
    buff.control === 'stun' || buff.control === 'freeze'
  );
}

/**
 * 检查单位是否被沉默（无法使用法术）
 */
export function isSilenced(unit: BattleUnit): boolean {
  return unit.buffs.some(buff => buff.control === 'silence');
}

/**
 * 检查单位是否被缴械（无法使用物理技能）
 */
export function isDisarmed(unit: BattleUnit): boolean {
  return unit.buffs.some(buff => buff.control === 'disarm');
}

/**
 * 检查单位是否被嘲讽
 */
export function getTauntSource(unit: BattleUnit): string | null {
  const tauntBuff = unit.buffs.find(buff => buff.control === 'taunt');
  return tauntBuff ? tauntBuff.sourceUnitId : null;
}

/**
 * 检查单位是否处于恐惧状态
 */
export function isFeared(unit: BattleUnit): boolean {
  return unit.buffs.some(buff => buff.control === 'fear');
}

/**
 * 检查技能是否可以使用（考虑控制状态）
 */
export function canUseSkill(
  unit: BattleUnit,
  skillDamageType?: 'physical' | 'magic' | 'true'
): boolean {
  // 眩晕/冻结/恐惧无法使用任何技能
  if (isStunned(unit) || isFeared(unit)) {
    return false;
  }

  // 沉默无法使用法术技能
  if (skillDamageType === 'magic' && isSilenced(unit)) {
    return false;
  }

  // 缴械无法使用物理技能
  if (skillDamageType === 'physical' && isDisarmed(unit)) {
    return false;
  }

  return true;
}
