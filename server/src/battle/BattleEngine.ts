/**
 * 九州修仙录 - 战斗引擎主控制器
 * 真回合制：一方全部行动完毕后，另一方再行动
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleSkill,
  BattleLogEntry,
  RoundLog
} from './types.js';
import { BATTLE_CONSTANTS } from './types.js';
import { validateBattleState, validateSkillUse, validatePlayerAction } from './utils/validation.js';
import { processRoundStartEffects, processRoundEndBuffs, recalculateUnitAttrs } from './modules/buff.js';
import { executeSkill, getNormalAttack, getAvailableSkills } from './modules/skill.js';
import { makeAIDecision } from './modules/ai.js';
import { isStunned, isFeared } from './modules/control.js';
import { triggerSetBonusEffects } from './modules/setBonus.js';

export class BattleEngine {
  private state: BattleState;
  
  constructor(state: BattleState) {
    this.state = state;
  }
  
  /**
   * 获取当前战斗状态
   */
  getState(): BattleState {
    return this.state;
  }
  
  /**
   * 开始战斗
   */
  startBattle(): void {
    // 验证状态
    const validation = validateBattleState(this.state);
    if (!validation.valid) {
      throw new Error(validation.error);
    }
    
    // 判定先手
    this.determineFirstMover();
    
    // 初始化
    this.state.roundCount = 1;
    this.state.currentTeam = this.state.firstMover;
    this.state.currentUnitIndex = 0;
    this.state.phase = 'roundStart';
    
    // 按速度排序队内单位
    this.sortUnitsBySpeed(this.state.teams.attacker.units);
    this.sortUnitsBySpeed(this.state.teams.defender.units);
    
    // 处理回合开始
    this.processRoundStart();
  }
  
  /**
   * 判定先手方
   */
  private determineFirstMover(): void {
    const attackerSpeed = this.state.teams.attacker.totalSpeed;
    const defenderSpeed = this.state.teams.defender.totalSpeed;
    
    if (attackerSpeed > defenderSpeed) {
      this.state.firstMover = 'attacker';
    } else if (defenderSpeed > attackerSpeed) {
      this.state.firstMover = 'defender';
    } else {
      // 速度相同，玩家方优先
      this.state.firstMover = 'attacker';
    }
  }
  
  /**
   * 按速度排序单位
   */
  private sortUnitsBySpeed(units: BattleUnit[]): void {
    units.sort((a, b) => b.currentAttrs.sudu - a.currentAttrs.sudu);
  }
  
  /**
   * 处理回合开始
   */
  private processRoundStart(): void {
    this.state.phase = 'roundStart';
    
    // 记录回合开始日志
    this.state.logs.push({
      type: 'round_start',
      round: this.state.roundCount,
    } as RoundLog);
    
    // 双方同时处理回合开始效果
    const allUnits = [
      ...this.state.teams.attacker.units,
      ...this.state.teams.defender.units,
    ];
    
    for (const unit of allUnits) {
      if (!unit.isAlive) continue;
      
      // DOT/HOT结算
      const effectLogs = processRoundStartEffects(this.state, unit);
      this.state.logs.push(...effectLogs);

      const setLogs = triggerSetBonusEffects(this.state, 'on_turn_start', unit);
      this.state.logs.push(...setLogs);
      
      // 气血/灵气恢复（只有属性值才恢复，没有基础恢复）
      this.recoverResources(unit);
      
      // 技能冷却递减
      this.reduceCooldowns(unit);
    }
    
    // 检查是否有单位死亡（可能改变phase为finished）
    if (!this.checkBattleEnd()) {
      this.state.phase = 'action';
    }
  }
  
  /**
   * 气血/灵气恢复（只有属性值才恢复）
   */
  private recoverResources(unit: BattleUnit): void {
    // 气血恢复（只有 qixue_huifu 属性才恢复）
    const qixueRegen = unit.currentAttrs.qixue_huifu || 0;
    if (qixueRegen > 0) {
      unit.qixue = Math.min(
        unit.qixue + qixueRegen,
        unit.currentAttrs.max_qixue
      );
    }
    
    // 灵气恢复（只有 lingqi_huifu 属性才恢复，没有基础恢复）
    const lingqiRegen = unit.currentAttrs.lingqi_huifu || 0;
    if (lingqiRegen > 0) {
      unit.lingqi = Math.min(
        unit.lingqi + lingqiRegen,
        unit.currentAttrs.max_lingqi
      );
    }
  }
  
  /**
   * 技能冷却递减
   */
  private reduceCooldowns(unit: BattleUnit): void {
    for (const skillId of Object.keys(unit.skillCooldowns)) {
      if (unit.skillCooldowns[skillId] > 0) {
        unit.skillCooldowns[skillId]--;
      }
    }
  }
  
  /**
   * 玩家行动
   */
  playerAction(userId: number, skillId: string, targetIds: string[]): { success: boolean; error?: string } {
    // 验证行动权限
    const currentUnit = this.getCurrentUnit();
    if (!currentUnit) {
      return { success: false, error: '没有当前行动单位' };
    }
    
    const validation = validatePlayerAction(this.state, userId, currentUnit.id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    
    // 获取技能
    const skill = currentUnit.skills.find(s => s.id === skillId) || getNormalAttack(currentUnit);
    
    // 验证技能使用
    const skillValidation = validateSkillUse(this.state, currentUnit, skill, targetIds);
    if (!skillValidation.valid) {
      return { success: false, error: skillValidation.error };
    }
    
    // 执行技能
    const result = executeSkill(this.state, currentUnit, skill, targetIds);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    
    // 推进行动
    this.advanceAction();
    
    return { success: true };
  }
  
  /**
   * AI行动（自动执行当前AI单位的行动）
   */
  aiAction(allowPlayer: boolean = false): void {
    const currentUnit = this.getCurrentUnit();
    if (!currentUnit) return;
    if (!allowPlayer && currentUnit.type === 'player') return;
    
    // 检查是否被控制
    if (isStunned(currentUnit)) {
      this.state.logs.push({
        type: 'action',
        round: this.state.roundCount,
        actorId: currentUnit.id,
        actorName: currentUnit.name,
        skillId: 'skip',
        skillName: '跳过',
        targets: [],
      });
      this.advanceAction();
      return;
    }
    
    // AI决策
    const decision = makeAIDecision(this.state, currentUnit);
    
    // 执行技能
    executeSkill(this.state, currentUnit, decision.skill, decision.targetIds);
    
    // 推进行动
    this.advanceAction();
  }
  
  /**
   * 获取当前行动单位
   */
  getCurrentUnit(): BattleUnit | null {
    const team = this.state.teams[this.state.currentTeam];
    const aliveUnits = team.units.filter(u => u.isAlive);
    
    if (this.state.currentUnitIndex >= aliveUnits.length) {
      return null;
    }
    
    return aliveUnits[this.state.currentUnitIndex];
  }
  
  /**
   * 推进行动
   */
  private advanceAction(): void {
    // 检查战斗是否结束
    if (this.checkBattleEnd()) return;
    
    // 移动到下一个单位
    this.state.currentUnitIndex++;
    
    const team = this.state.teams[this.state.currentTeam];
    const aliveUnits = team.units.filter(u => u.isAlive);
    
    // 当前方所有单位行动完毕
    if (this.state.currentUnitIndex >= aliveUnits.length) {
      this.switchTeam();
    }
  }
  
  /**
   * 切换行动方
   */
  private switchTeam(): void {
    const secondMover = this.state.firstMover === 'attacker' ? 'defender' : 'attacker';
    
    if (this.state.currentTeam === this.state.firstMover) {
      // 先手方行动完毕，切换到后手方
      this.state.currentTeam = secondMover;
      this.state.currentUnitIndex = 0;
    } else {
      // 后手方行动完毕，回合结束
      this.processRoundEnd();
    }
  }
  
  /**
   * 处理回合结束
   */
  private processRoundEnd(): void {
    this.state.phase = 'roundEnd';
    
    // 双方同时处理Buff递减
    const allUnits = [
      ...this.state.teams.attacker.units,
      ...this.state.teams.defender.units,
    ];
    
    for (const unit of allUnits) {
      if (!unit.isAlive) continue;
      
      const buffLogs = processRoundEndBuffs(this.state, unit);
      this.state.logs.push(...buffLogs);
    }
    
    // 记录回合结束日志
    this.state.logs.push({
      type: 'round_end',
      round: this.state.roundCount,
    } as RoundLog);
    
    // 检查战斗是否结束
    if (this.checkBattleEnd()) return;
    
    // 检查回合数限制
    const maxRounds = this.state.battleType === 'pvp' 
      ? BATTLE_CONSTANTS.MAX_ROUNDS_PVP 
      : BATTLE_CONSTANTS.MAX_ROUNDS_PVE;
    
    if (this.state.roundCount >= maxRounds) {
      this.endBattle('draw');
      return;
    }
    
    // 开始新回合
    this.state.roundCount++;
    this.state.currentTeam = this.state.firstMover;
    this.state.currentUnitIndex = 0;
    
    // 重新计算速度总和（可能因Buff变化）
    this.updateTeamSpeed();
    
    // 处理新回合开始
    this.processRoundStart();
  }
  
  /**
   * 更新队伍速度总和
   */
  private updateTeamSpeed(): void {
    this.state.teams.attacker.totalSpeed = this.state.teams.attacker.units
      .filter(u => u.isAlive)
      .reduce((sum, u) => sum + u.currentAttrs.sudu, 0);
    
    this.state.teams.defender.totalSpeed = this.state.teams.defender.units
      .filter(u => u.isAlive)
      .reduce((sum, u) => sum + u.currentAttrs.sudu, 0);
  }
  
  /**
   * 检查战斗是否结束
   */
  private checkBattleEnd(): boolean {
    const attackerAlive = this.state.teams.attacker.units.some(u => u.isAlive);
    const defenderAlive = this.state.teams.defender.units.some(u => u.isAlive);
    
    if (!attackerAlive) {
      this.endBattle('defender_win');
      return true;
    }
    
    if (!defenderAlive) {
      this.endBattle('attacker_win');
      return true;
    }
    
    return false;
  }
  
  /**
   * 结束战斗
   */
  private endBattle(result: 'attacker_win' | 'defender_win' | 'draw'): void {
    this.state.phase = 'finished';
    this.state.result = result;
  }
  
  /**
   * 自动执行战斗（用于PVE快速结算）
   */
  autoExecute(): void {
    while (this.state.phase !== 'finished') {
      const currentUnit = this.getCurrentUnit();
      
      if (!currentUnit) {
        // 没有当前单位，推进
        this.advanceAction();
        continue;
      }
      
      if (currentUnit.type === 'player') {
        // 玩家单位也用AI控制（自动战斗）
        this.aiAction(true);
      } else {
        this.aiAction();
      }
      
      // 防止无限循环
      if (this.state.roundCount > BATTLE_CONSTANTS.MAX_ROUNDS_PVE + 10) {
        this.endBattle('draw');
        break;
      }
    }
  }
  
  /**
   * 获取战斗结果
   */
  getResult(): {
    result: string;
    rounds: number;
    logs: BattleLogEntry[];
    stats: {
      attacker: { damageDealt: number; healingDone: number };
      defender: { damageDealt: number; healingDone: number };
    };
  } {
    const attackerStats = this.state.teams.attacker.units.reduce(
      (acc, u) => ({
        damageDealt: acc.damageDealt + u.stats.damageDealt,
        healingDone: acc.healingDone + u.stats.healingDone,
      }),
      { damageDealt: 0, healingDone: 0 }
    );
    
    const defenderStats = this.state.teams.defender.units.reduce(
      (acc, u) => ({
        damageDealt: acc.damageDealt + u.stats.damageDealt,
        healingDone: acc.healingDone + u.stats.healingDone,
      }),
      { damageDealt: 0, healingDone: 0 }
    );
    
    return {
      result: this.state.result || 'unknown',
      rounds: this.state.roundCount,
      logs: this.state.logs,
      stats: {
        attacker: attackerStats,
        defender: defenderStats,
      },
    };
  }
}
