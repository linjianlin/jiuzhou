/**
 * IdleBattleSimulationCore — 挂机单场战斗模拟统一入口
 *
 * 作用：
 *   统一“目标怪物解析 + BattleEngine 执行 + 战斗日志输出”流程，
 *   供普通执行器和 Worker 执行器共同复用，避免核心战斗逻辑分叉。
 *   不负责奖励结算，不负责数据库写入。
 *
 * 输入/输出：
 *   - simulateIdleBattle(session, userId, roomMonsters)
 *     输入会话快照、用户 ID、房间怪物配置；
 *     输出单场战斗核心结果（胜负、随机种子、回合数、日志、怪物 ID 列表）。
 *
 * 数据流：
 *   roomMonsters + sessionSnapshot → 目标怪物列表
 *   → resolveMonsterDataForBattle（普通战斗同入口）
 *   → createPVEBattle + BattleEngine.autoExecute
 *   → battle result / logs
 *
 * 关键边界条件与坑点：
 *   1. targetMonsterDefId 存在时只打该种怪，数量取房间配置 count（默认 1）。
 *   2. 怪物解析失败或无怪物时返回 draw，且不抛异常，保证挂机循环可持续。
 */

import { randomUUID } from 'crypto';
import { createPVEBattle, type CharacterData, type SkillData } from '../../battle/battleFactory.js';
import { BattleEngine, type PlayerSkillSelector } from '../../battle/battleEngine.js';
import type { BattleLogEntry } from '../../battle/types.js';
import { resolveMonsterDataForBattle } from '../battle/index.js';
import { hasConfiguredAutoSkillPolicy } from './autoSkillPolicyGuard.js';
import { selectSkillByPolicy } from './selectSkillByPolicy.js';
import type { IdleSessionRow } from './types.js';

export type IdleRoomMonsterSlot = {
  monster_def_id: string;
  count: number;
};

export interface IdleBattleSimulationResult {
  result: 'attacker_win' | 'defender_win' | 'draw';
  randomSeed: number;
  roundCount: number;
  battleLog: BattleLogEntry[];
  monsterIds: string[];
}

function snapshotToCharacterData(
  snapshot: IdleSessionRow['sessionSnapshot'],
  userId: number,
): CharacterData {
  const a = snapshot.baseAttrs;
  return {
    user_id: userId,
    id: snapshot.characterId,
    nickname: snapshot.nickname || '无名修士',
    realm: snapshot.realm,
    attribute_element: (a as { element?: string }).element ?? 'none',
    qixue: a.max_qixue ?? 0,
    max_qixue: a.max_qixue ?? 0,
    lingqi: a.max_lingqi != null && a.max_lingqi > 0
      ? Math.floor(a.max_lingqi * 0.5)
      : 0,
    max_lingqi: a.max_lingqi ?? 0,
    wugong: a.wugong ?? 0,
    fagong: a.fagong ?? 0,
    wufang: a.wufang ?? 0,
    fafang: a.fafang ?? 0,
    sudu: a.sudu ?? 1,
    mingzhong: a.mingzhong ?? 0.9,
    shanbi: a.shanbi ?? 0,
    zhaojia: a.zhaojia ?? 0,
    baoji: a.baoji ?? 0,
    baoshang: a.baoshang ?? 0,
    kangbao: a.kangbao ?? 0,
    zengshang: a.zengshang ?? 0,
    zhiliao: a.zhiliao ?? 0,
    jianliao: a.jianliao ?? 0,
    xixue: a.xixue ?? 0,
    lengque: a.lengque ?? 0,
    kongzhi_kangxing: a.kongzhi_kangxing ?? 0,
    jin_kangxing: a.jin_kangxing ?? 0,
    mu_kangxing: a.mu_kangxing ?? 0,
    shui_kangxing: a.shui_kangxing ?? 0,
    huo_kangxing: a.huo_kangxing ?? 0,
    tu_kangxing: a.tu_kangxing ?? 0,
    qixue_huifu: a.qixue_huifu ?? 0,
    lingqi_huifu: a.lingqi_huifu ?? 0,
    setBonusEffects: snapshot.setBonusEffects,
  };
}

function battleSkillsToSkillData(
  skills: IdleSessionRow['sessionSnapshot']['skills'],
): SkillData[] {
  return skills.map((s) => ({
    id: s.id,
    name: s.name,
    cost_lingqi: s.cost.lingqi ?? 0,
    cost_qixue: s.cost.qixue ?? 0,
    cooldown: s.cooldown,
    target_type: s.targetType,
    target_count: s.targetCount,
    damage_type: s.damageType ?? 'none',
    element: s.element,
    effects: s.effects,
    ai_priority: s.aiPriority,
  }));
}

function buildMonsterIds(
  targetMonsterDefId: string | undefined,
  roomMonsters: IdleRoomMonsterSlot[],
): string[] {
  if (targetMonsterDefId) {
    const monsterEntry = roomMonsters.find((m) => m.monster_def_id === targetMonsterDefId);
    const count = monsterEntry?.count ?? 1;
    return Array(count).fill(targetMonsterDefId) as string[];
  }
  return roomMonsters.map((m) => m.monster_def_id);
}

/**
 * 执行单场挂机战斗模拟（不含奖励）。
 */
export function simulateIdleBattle(
  session: IdleSessionRow,
  userId: number,
  roomMonsters: IdleRoomMonsterSlot[],
): IdleBattleSimulationResult {
  const monsterIds = buildMonsterIds(session.sessionSnapshot.targetMonsterDefId, roomMonsters);
  if (monsterIds.length === 0) {
    return {
      result: 'draw',
      randomSeed: 0,
      roundCount: 0,
      battleLog: [],
      monsterIds: [],
    };
  }

  const monsterResult = resolveMonsterDataForBattle(monsterIds);
  if (!monsterResult.success) {
    return {
      result: 'draw',
      randomSeed: 0,
      roundCount: 0,
      battleLog: [],
      monsterIds,
    };
  }

  const characterData = snapshotToCharacterData(session.sessionSnapshot, userId);
  const skillData = battleSkillsToSkillData(session.sessionSnapshot.skills);
  const state = createPVEBattle(
    randomUUID(),
    characterData,
    skillData,
    monsterResult.monsters,
    monsterResult.monsterSkillsMap,
  );

  const engine = new BattleEngine(state);
  const policy = session.sessionSnapshot.autoSkillPolicy;
  const playerSelector: PlayerSkillSelector | undefined =
    hasConfiguredAutoSkillPolicy(policy)
      ? (unit) => selectSkillByPolicy(unit, policy)
      : undefined;
  engine.autoExecute(playerSelector);

  const finalState = engine.getState();
  return {
    result: finalState.result ?? 'draw',
    randomSeed: finalState.randomSeed,
    roundCount: finalState.roundCount,
    battleLog: finalState.logs as BattleLogEntry[],
    monsterIds,
  };
}
