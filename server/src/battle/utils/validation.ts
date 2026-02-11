/**
 * 九州修仙录 - 战斗数据验证模块
 * 严格验证所有战斗数据，防止作弊
 */

import type { BattleState, BattleUnit, BattleSkill, BattleAttrs } from '../types.js';
import { BATTLE_CONSTANTS } from '../types.js';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * 验证战斗状态完整性
 */
export function validateBattleState(state: BattleState): ValidationResult {
  if (!state.battleId) {
    return { valid: false, error: '战斗ID不能为空' };
  }
  
  if (!state.teams.attacker || !state.teams.defender) {
    return { valid: false, error: '战斗双方不能为空' };
  }
  
  if (state.teams.attacker.units.length === 0) {
    return { valid: false, error: '进攻方没有单位' };
  }
  
  if (state.teams.defender.units.length === 0) {
    return { valid: false, error: '防守方没有单位' };
  }
  
  // 验证每个单位
  for (const unit of state.teams.attacker.units) {
    const result = validateBattleUnit(unit);
    if (!result.valid) return result;
  }
  
  for (const unit of state.teams.defender.units) {
    const result = validateBattleUnit(unit);
    if (!result.valid) return result;
  }
  
  return { valid: true };
}

/**
 * 验证战斗单位数据
 */
export function validateBattleUnit(unit: BattleUnit): ValidationResult {
  if (!unit.id || !unit.name) {
    return { valid: false, error: '单位ID或名称不能为空' };
  }
  
  if (!['player', 'monster', 'npc', 'summon'].includes(unit.type)) {
    return { valid: false, error: `无效的单位类型: ${unit.type}` };
  }
  
  // 验证属性范围
  const attrsResult = validateBattleAttrs(unit.baseAttrs);
  if (!attrsResult.valid) return attrsResult;
  
  // 验证当前状态
  if (unit.qixue < 0 || unit.qixue > unit.currentAttrs.max_qixue) {
    return { valid: false, error: `气血值异常: ${unit.qixue}` };
  }
  
  if (unit.lingqi < 0 || unit.lingqi > unit.currentAttrs.max_lingqi) {
    return { valid: false, error: `灵气值异常: ${unit.lingqi}` };
  }
  
  return { valid: true };
}

/**
 * 验证属性值范围
 * 注意：万分比属性允许超出范围，在实际计算时会被钳制
 */
export function validateBattleAttrs(attrs: BattleAttrs): ValidationResult {
  // 基础属性必须为正数
  if (attrs.max_qixue <= 0) {
    return { valid: false, error: '最大气血必须大于0' };
  }
  
  if (attrs.wugong < 0 || attrs.fagong < 0) {
    return { valid: false, error: '攻击力不能为负数' };
  }
  
  if (attrs.wufang < 0 || attrs.fafang < 0) {
    return { valid: false, error: '防御力不能为负数' };
  }
  
  if (attrs.sudu < 0) {
    return { valid: false, error: '速度不能为负数' };
  }
  
  // 万分比属性只检查是否为负数，超出上限在计算时会被钳制
  if (attrs.mingzhong < 0) {
    return { valid: false, error: `命中率不能为负数: ${attrs.mingzhong}` };
  }
  
  if (attrs.shanbi < 0) {
    return { valid: false, error: `闪避率不能为负数: ${attrs.shanbi}` };
  }
  
  if (attrs.baoji < 0) {
    return { valid: false, error: `暴击率不能为负数: ${attrs.baoji}` };
  }
  
  if (attrs.baoshang < 0) {
    return { valid: false, error: `爆伤不能为负数: ${attrs.baoshang}` };
  }
  
  return { valid: true };
}

/**
 * 验证技能使用合法性
 */
export function validateSkillUse(
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
  targetIds: string[]
): ValidationResult {
  // 检查单位是否可行动
  if (!unit.isAlive) {
    return { valid: false, error: '单位已死亡，无法行动' };
  }
  
  if (!unit.canAct) {
    return { valid: false, error: '单位被控制，无法行动' };
  }
  
  // 检查技能是否属于该单位
  const hasSkill = unit.skills.some(s => s.id === skill.id);
  if (!hasSkill) {
    return { valid: false, error: `单位没有技能: ${skill.id}` };
  }
  
  // 检查冷却
  const cooldown = unit.skillCooldowns[skill.id] || 0;
  if (cooldown > 0) {
    return { valid: false, error: `技能冷却中: ${cooldown}回合` };
  }
  
  // 检查消耗
  if (skill.cost.lingqi && unit.lingqi < skill.cost.lingqi) {
    return { valid: false, error: `灵气不足: 需要${skill.cost.lingqi}，当前${unit.lingqi}` };
  }
  
  if (skill.cost.qixue && unit.qixue <= skill.cost.qixue) {
    return { valid: false, error: `气血不足: 需要${skill.cost.qixue}，当前${unit.qixue}` };
  }
  
  // 检查目标合法性
  const targetResult = validateTargets(state, unit, skill, targetIds);
  if (!targetResult.valid) return targetResult;
  
  // 检查技能条件
  if (skill.conditions) {
    const condResult = validateSkillConditions(unit, skill.conditions);
    if (!condResult.valid) return condResult;
  }
  
  return { valid: true };
}


/**
 * 验证目标合法性
 */
export function validateTargets(
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
  targetIds: string[]
): ValidationResult {
  const isAttacker = state.teams.attacker.units.some(u => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  
  switch (skill.targetType) {
    case 'self':
      if (targetIds.length !== 1 || targetIds[0] !== unit.id) {
        return { valid: false, error: '自身技能目标必须是自己' };
      }
      break;
      
    case 'single_enemy':
      if (targetIds.length !== 1) {
        return { valid: false, error: '单体敌方技能只能选择一个目标' };
      }
      // 客户端战斗状态可能略滞后（如自动战斗/组队并发操作），
      // 这里仅校验“存在可攻击敌人”，具体目标在 resolveTargets 阶段再二次解析并回退。
      if (!enemies.some(e => e.isAlive)) {
        return { valid: false, error: '目标不是有效的敌方单位' };
      }
      break;
      
    case 'single_ally':
      if (targetIds.length !== 1) {
        return { valid: false, error: '单体友方技能只能选择一个目标' };
      }
      if (!allies.some(a => a.isAlive)) {
        return { valid: false, error: '目标不是有效的友方单位' };
      }
      break;
      
    case 'all_enemy':
      // 全体敌方不需要指定目标
      break;
      
    case 'all_ally':
      // 全体友方不需要指定目标
      break;
      
    case 'random_enemy':
    case 'random_ally':
      // 随机目标由服务端决定，不需要客户端指定
      break;
      
    default:
      return { valid: false, error: `未知的目标类型: ${skill.targetType}` };
  }
  
  return { valid: true };
}

/**
 * 验证技能条件
 */
export function validateSkillConditions(
  unit: BattleUnit,
  conditions: NonNullable<BattleSkill['conditions']>
): ValidationResult {
  const qixuePercent = (unit.qixue / unit.currentAttrs.max_qixue) * 100;
  
  if (conditions.minQixuePercent !== undefined) {
    if (qixuePercent < conditions.minQixuePercent) {
      return { valid: false, error: `气血百分比不足: 需要${conditions.minQixuePercent}%` };
    }
  }
  
  if (conditions.maxQixuePercent !== undefined) {
    if (qixuePercent > conditions.maxQixuePercent) {
      return { valid: false, error: `气血百分比过高: 需要低于${conditions.maxQixuePercent}%` };
    }
  }
  
  if (conditions.requireBuff) {
    const hasBuff = unit.buffs.some(b => b.buffDefId === conditions.requireBuff && b.type === 'buff');
    if (!hasBuff) {
      return { valid: false, error: `缺少必要Buff: ${conditions.requireBuff}` };
    }
  }
  
  return { valid: true };
}

/**
 * 验证玩家行动权限
 * 支持组队多玩家：任意队友都可以操作当前行动的玩家单位
 */
export function validatePlayerAction(
  state: BattleState,
  _userId: number,
  unitId: string
): ValidationResult {
  // 检查是否轮到攻击方行动
  if (state.currentTeam !== 'attacker') {
    return { valid: false, error: '不是玩家方的回合' };
  }
  
  const currentTeam = state.teams.attacker;
  
  // 检查是否是当前应该行动的单位
  const aliveUnits = currentTeam.units.filter(u => u.isAlive);
  const currentUnit = aliveUnits[state.currentUnitIndex];
  
  if (!currentUnit || currentUnit.id !== unitId) {
    return { valid: false, error: '不是该单位的行动回合' };
  }
  
  // 检查单位是否是玩家类型
  const unit = currentTeam.units.find(u => u.id === unitId);
  if (!unit || unit.type !== 'player') {
    return { valid: false, error: '无法操作该单位' };
  }
  
  // 组队战斗：允许任意队友操作当前行动的玩家单位
  // 权限验证在 battleService 层通过 battleParticipants 完成
  
  return { valid: true };
}

/**
 * 验证战斗结果完整性（用于防止篡改）
 */
export function validateBattleResult(state: BattleState): ValidationResult {
  // 检查胜负判定是否正确
  const attackerAlive = state.teams.attacker.units.some(u => u.isAlive);
  const defenderAlive = state.teams.defender.units.some(u => u.isAlive);
  
  if (!attackerAlive && state.result !== 'defender_win') {
    return { valid: false, error: '战斗结果与状态不符' };
  }
  
  if (!defenderAlive && state.result !== 'attacker_win') {
    return { valid: false, error: '战斗结果与状态不符' };
  }
  
  // 检查回合数是否超限
  const maxRounds = state.battleType === 'pvp' 
    ? BATTLE_CONSTANTS.MAX_ROUNDS_PVP 
    : BATTLE_CONSTANTS.MAX_ROUNDS_PVE;
    
  if (state.roundCount > maxRounds && state.result !== 'draw') {
    return { valid: false, error: '回合数超限但未判定平局' };
  }
  
  return { valid: true };
}
