/**
 * 九州修仙录 - 战斗引擎主控制器
 * 真回合制：一方全部行动完毕后，另一方再行动
 */

import type { 
  BattleState, 
  BattleUnit, 
  BattleLogEntry,
  RoundLog,
  ActionLog,
  AttrModifier,
  MonsterAIPhaseTrigger,
  SkillEffect,
  TargetResult,
} from './types.js';
import { BATTLE_CONSTANTS } from './types.js';
import { validateBattleState, validateSkillUse, validatePlayerAction } from './utils/validation.js';
import { addBuff, processRoundStartEffects, processRoundEndBuffs } from './modules/buff.js';
import { executeSkill, getNormalAttack } from './modules/skill.js';
import { makeAIDecision, selectTargets } from './modules/ai.js';
import { isFeared, isStunned } from './modules/control.js';
import { triggerSetBonusEffects } from './modules/setBonus.js';
import { decayUnitMarksAtRoundStart } from './modules/mark.js';
import { decayUnitMomentumAtRoundEnd } from './modules/momentum.js';
import {
  ensureBattleStateSkillCooldownState,
  reduceUnitSkillCooldowns,
} from './utils/cooldown.js';
import {
  DEFAULT_PERCENT_BUFF_ATTR_SET,
  normalizeBuffApplyType,
  normalizeBuffAttrKey,
  normalizeBuffKind,
  resolveBuffEffectKey,
  resolveSignedAttrValue,
} from './utils/buffSpec.js';

import type { BattleSkill } from './types.js';

/** 自定义玩家技能选择回调（用于挂机战斗注入 AutoSkillPolicy） */
export type PlayerSkillSelector = (unit: BattleUnit) => BattleSkill;
const PHASE_PERCENT_BUFF_ATTR_SET = DEFAULT_PERCENT_BUFF_ATTR_SET;
type BuffOrDebuffEffect = SkillEffect & { type: 'buff' | 'debuff' };

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function buildPhaseAttrModifiers(effect: BuffOrDebuffEffect): AttrModifier[] {
  if (normalizeBuffKind(effect.buffKind) !== 'attr') return [];
  const attr = normalizeBuffAttrKey(effect.attrKey);
  if (!attr) return [];

  const finalValue = resolveSignedAttrValue(effect.type, effect.value);
  if (finalValue === 0) return [];
  const mode: AttrModifier['mode'] =
    normalizeBuffApplyType(effect.applyType)
    ?? (PHASE_PERCENT_BUFF_ATTR_SET.has(attr) ? 'percent' : 'flat');

  return [{ attr, value: finalValue, mode }];
}

export class BattleEngine {
  private state: BattleState;
  
  constructor(state: BattleState) {
    this.state = state;
    ensureBattleStateSkillCooldownState(this.state);
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
    this.state.currentUnitId = null;
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

      // 每回合开始重置行动资格，确保召唤单位“下回合生效”
      unit.canAct = true;

      // 统一回合开始印记衰减
      decayUnitMarksAtRoundStart(unit);
      
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
      // 回合开始处理完毕后，将 currentUnitId 指向先手方第一个可行动单位
      this.state.currentUnitId = this.getFirstActableUnitId(this.state.currentTeam);
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
    reduceUnitSkillCooldowns(unit);
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
  aiAction(allowPlayer: boolean = false, playerSkillSelector?: PlayerSkillSelector): void {
    const currentUnit = this.getCurrentUnit();
    if (!currentUnit) return;
    if (!allowPlayer && currentUnit.type === 'player') return;

    if (currentUnit.type === 'monster' || currentUnit.type === 'summon') {
      this.processPhaseTriggersBeforeAction(currentUnit);
      if (this.checkBattleEnd()) return;
    }

    // 检查是否被控制
    if (isStunned(currentUnit) || isFeared(currentUnit)) {
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

    // 玩家单位且有自定义选择器时，使用选择器选技能 + selectTargets 选目标
    if (currentUnit.type === 'player' && playerSkillSelector) {
      const skill = playerSkillSelector(currentUnit);
      const targetIds = selectTargets(this.state, currentUnit, skill);
      executeSkill(this.state, currentUnit, skill, targetIds);
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
   * 怪物行动前处理阶段触发
   */
  private processPhaseTriggersBeforeAction(unit: BattleUnit): void {
    const aiProfile = unit.aiProfile;
    // Worker 场景下怪物 aiProfile 可能来自原始配置（未携带 phaseTriggers），
    // 这里统一做数组守卫，避免读取 undefined.length 导致整场战斗中断。
    const phaseTriggers = Array.isArray((aiProfile as { phaseTriggers?: unknown } | undefined)?.phaseTriggers)
      ? (aiProfile as { phaseTriggers: MonsterAIPhaseTrigger[] }).phaseTriggers
      : [];
    if (phaseTriggers.length === 0) return;
    const maxQixue = Math.max(1, unit.currentAttrs.max_qixue);
    const hpPercent = unit.qixue / maxQixue;
    if (!unit.triggeredPhaseIds) {
      unit.triggeredPhaseIds = [];
    }
    const triggeredSet = new Set(unit.triggeredPhaseIds);

    for (const trigger of phaseTriggers) {
      if (triggeredSet.has(trigger.id)) continue;
      if (hpPercent > trigger.hpPercent) continue;

      if (trigger.action === 'enrage') {
        const buffsApplied = this.applyPhaseTriggerEffects(unit, trigger);
        const targets: TargetResult[] = [{
          targetId: unit.id,
          targetName: unit.name,
          hits: [],
          buffsApplied,
        }];
        this.appendPhaseActionLog(
          unit,
          `proc-phase-enrage-${trigger.id}`,
          '阶段触发·狂暴',
          targets
        );
      } else if (trigger.action === 'summon') {
        const summonedUnits = this.summonByTrigger(unit, trigger);
        const targets: TargetResult[] = summonedUnits.length > 0
          ? summonedUnits.map((summoned) => ({
            targetId: summoned.id,
            targetName: summoned.name,
            hits: [],
          }))
          : [{
            targetId: unit.id,
            targetName: unit.name,
            hits: [],
            buffsApplied: ['召唤失败'],
          }];
        this.appendPhaseActionLog(
          unit,
          `proc-phase-summon-${trigger.id}`,
          '阶段触发·召唤',
          targets
        );
      }

      triggeredSet.add(trigger.id);
      unit.triggeredPhaseIds.push(trigger.id);
    }
  }

  private applyPhaseTriggerEffects(unit: BattleUnit, trigger: MonsterAIPhaseTrigger): string[] {
    const appliedBuffs: string[] = [];
    const effects = Array.isArray((trigger as { effects?: unknown }).effects)
      ? trigger.effects
      : [];
    for (const effect of effects) {
      if (effect.type !== 'buff' && effect.type !== 'debuff') continue;
      const buffEffect = effect as BuffOrDebuffEffect;
      const buffId = resolveBuffEffectKey(buffEffect);
      if (!buffId) continue;
      const attrModifiers = buildPhaseAttrModifiers(buffEffect);
      if (attrModifiers.length === 0) continue;

      const stacks = Math.max(1, Math.floor(toFiniteNumber(effect.stacks, 1)));
      const duration = Math.max(1, Math.floor(toFiniteNumber(effect.duration, 1)));
      addBuff(unit, {
        id: `phase-${buffId}-${Date.now()}`,
        buffDefId: buffId,
        name: buffId,
        type: buffEffect.type,
        category: 'phase',
        sourceUnitId: unit.id,
        maxStacks: stacks,
        attrModifiers,
        tags: ['phase_trigger'],
        dispellable: true,
      }, duration, stacks);
      appliedBuffs.push(buffId);
    }
    return appliedBuffs;
  }

  private summonByTrigger(summoner: BattleUnit, trigger: MonsterAIPhaseTrigger): BattleUnit[] {
    const template = trigger.summonTemplate;
    if (!template) return [];

    const teamKey = this.resolveTeamKey(summoner);
    const team = this.state.teams[teamKey];
    const summonCount = Math.max(1, Math.floor(trigger.summonCount || 1));
    const summonedUnits: BattleUnit[] = [];

    for (let i = 0; i < summonCount; i++) {
      const attrs = { ...template.baseAttrs };
      const battleSkills = template.skills.map((skill) => ({
        ...skill,
        cost: { ...skill.cost },
        effects: skill.effects.map((effect) => ({ ...effect })),
      }));
      const hasNormalAttack = battleSkills.some((skill) => skill.id === 'skill-normal-attack');
      if (!hasNormalAttack) {
        const normalAttack = getNormalAttack({
          currentAttrs: attrs,
        } as BattleUnit);
        battleSkills.unshift(normalAttack);
      }

      const summonIndex = team.units.filter((unit) => unit.type === 'summon').length + 1;
      const summonUnit: BattleUnit = {
        id: `summon-${template.id}-${Date.now()}-${summonIndex}`,
        name: template.name,
        type: 'summon',
        sourceId: template.id,
        baseAttrs: { ...attrs },
        currentAttrs: { ...attrs },
        qixue: attrs.max_qixue,
        lingqi: attrs.max_lingqi,
        shields: [],
        buffs: [],
        marks: [],
        momentum: null,
        skills: battleSkills,
        skillCooldowns: {},
        skillCooldownDiscountBank: {},
        setBonusEffects: [],
        aiProfile: template.aiProfile,
        triggeredPhaseIds: [],
        controlDiminishing: {},
        isAlive: true,
        canAct: false, // 召唤当回合不可行动，下回合自动恢复
        isSummon: true,
        summonerId: summoner.id,
        stats: {
          damageDealt: 0,
          damageTaken: 0,
          healingDone: 0,
          healingReceived: 0,
          killCount: 0,
        },
      };
      team.units.push(summonUnit);
      summonedUnits.push(summonUnit);
    }

    team.totalSpeed = team.units
      .filter((unit) => unit.isAlive)
      .reduce((sum, unit) => sum + unit.currentAttrs.sudu, 0);
    return summonedUnits;
  }

  private resolveTeamKey(unit: BattleUnit): 'attacker' | 'defender' {
    const isAttacker = this.state.teams.attacker.units.some((entry) => entry.id === unit.id);
    return isAttacker ? 'attacker' : 'defender';
  }

  private appendPhaseActionLog(
    actor: BattleUnit,
    skillId: string,
    skillName: string,
    targets: TargetResult[]
  ): void {
    const log: ActionLog = {
      type: 'action',
      round: this.state.roundCount,
      actorId: actor.id,
      actorName: actor.name,
      skillId,
      skillName,
      targets,
    };
    this.state.logs.push(log);
  }
  
  /**
   * 获取当前行动单位。
   *
   * 设计说明：用 currentUnitId 而非数组下标定位，避免行动过程中有单位死亡导致
   * 过滤列表缩短、下标漂移、跳过后续单位的 bug。
   * - currentUnitId 为 null：当前队伍尚未分配行动单位，调用方需先调用 advanceAction 推进。
   * - 找不到对应单位（已死亡/不可行动）：返回 null，由 advanceAction 跳过并推进。
   */
  getCurrentUnit(): BattleUnit | null {
    if (!this.state.currentUnitId) return null;
    const team = this.state.teams[this.state.currentTeam];
    const unit = team.units.find(u => u.id === this.state.currentUnitId);
    if (!unit || !unit.isAlive || !unit.canAct) return null;
    return unit;
  }
  
  /**
   * 推进行动：将 currentUnitId 移动到当前队伍下一个可行动单位。
   *
   * 坑点：不能用下标 +1，因为行动过程中可能有单位死亡导致列表缩短。
   * 正确做法：找到当前单位在"全量列表"中的位置，向后扫描第一个存活且可行动的单位。
   * 若当前队伍已无可行动单位，则切换队伍。
   */
  private advanceAction(): void {
    if (this.checkBattleEnd()) return;

    const team = this.state.teams[this.state.currentTeam];

    // 在全量列表中找到当前单位的位置，向后找下一个可行动单位
    const currentIdx = this.state.currentUnitId
      ? team.units.findIndex(u => u.id === this.state.currentUnitId)
      : -1;

    let nextUnit: BattleUnit | null = null;
    for (let i = currentIdx + 1; i < team.units.length; i++) {
      const u = team.units[i];
      if (u.isAlive && u.canAct) {
        nextUnit = u;
        break;
      }
    }

    if (nextUnit) {
      this.state.currentUnitId = nextUnit.id;
    } else {
      // 当前队伍所有单位行动完毕
      this.state.currentUnitId = null;
      this.switchTeam();
    }
  }
  
  /**
   * 切换行动方，并将 currentUnitId 指向新队伍第一个可行动单位。
   */
  private switchTeam(): void {
    const secondMover = this.state.firstMover === 'attacker' ? 'defender' : 'attacker';
    
    if (this.state.currentTeam === this.state.firstMover) {
      // 先手方行动完毕，切换到后手方
      this.state.currentTeam = secondMover;
      this.state.currentUnitId = this.getFirstActableUnitId(secondMover);
    } else {
      // 后手方行动完毕，回合结束
      this.processRoundEnd();
    }
  }

  /**
   * 获取指定队伍第一个可行动单位的 ID，无则返回 null。
   */
  private getFirstActableUnitId(teamKey: 'attacker' | 'defender'): string | null {
    const unit = this.state.teams[teamKey].units.find(u => u.isAlive && u.canAct);
    return unit?.id ?? null;
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
      decayUnitMomentumAtRoundEnd(unit);
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
    this.state.currentUnitId = null;
    
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
  autoExecute(playerSkillSelector?: PlayerSkillSelector): void {
    while (this.state.phase !== 'finished') {
      const currentUnit = this.getCurrentUnit();

      if (!currentUnit) {
        // 没有当前单位，推进
        this.advanceAction();
        continue;
      }

      if (currentUnit.type === 'player') {
        // 玩家单位也用AI控制（自动战斗）
        this.aiAction(true, playerSkillSelector);
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
