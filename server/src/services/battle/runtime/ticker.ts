/**
 * 战斗 tick 驱动与更新推送
 *
 * 作用：
 * - 驱动每场战斗的 tick 循环（AI 行动、回合推进）
 * - 推送战斗状态更新到参与者客户端
 * - 处理离线玩家代操、自动跳过等逻辑
 *
 * 不做什么：不管理战斗创建/结算、不操作数据库。
 *
 * 数据流：
 * setInterval -> tickBattle -> engine.aiAction / 推送 -> emitBattleUpdate -> WS + Redis
 *
 * 复用点：
 * - state.ts 的 registerStartedBattle 通过延迟 import 调用 startBattleTicker / emitBattleUpdate
 *
 * 边界条件：
 * 1) battleTickLocks 防止同一战斗并发 tick
 * 2) patchBattleUpdatePayload 剥离静态字段、使用日志增量减少传输量
 */

import type { BattleSkill, BattleState, BattleUnit } from "../../../battle/types.js";
import { canUseSkill, isFeared, isStunned } from "../../../battle/modules/control.js";
import { getNormalAttack } from "../../../battle/modules/skill.js";
import { resolveSingleAllyTargetId } from "../../../battle/utils/allyTargeting.js";
import { getGameServer } from "../../../game/gameServer.js";
import {
  activeBattles,
  battleParticipants,
  battleTickLocks,
  battleTickers,
  battleLastEmittedLogLen,
  battleLastRedisSavedAt,
  BATTLE_TICK_MS,
  getAttackerPlayerCount,
  getUserIdByCharacterId,
  stripStaticFieldsFromState,
} from "./state.js";
import { saveBattleToRedis } from "./persistence.js";

// ------ 常量 ------

const BATTLE_REDIS_SAVE_INTERVAL_MS = 2000;
const MAX_BATTLE_LOG_DELTA = 80;
const PLAYER_ACTION_TIMEOUT_MS = 30_000;

type PlayerTurnTimeoutState = {
  turnKey: string;
  deadlineAt: number;
};

const playerTurnTimeoutStateByBattleId = new Map<string, PlayerTurnTimeoutState>();

// ------ 推送优化 ------

function patchBattleUpdatePayload(battleId: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return payload;
  const kind = String(payload.kind || "");

  if (kind === "battle_started") {
    const state = payload.state as unknown as BattleState | undefined;
    const logsLen = Array.isArray(state?.logs) ? state.logs.length : 0;
    battleLastEmittedLogLen.set(battleId, logsLen);
    return payload;
  }

  if (kind === "battle_finished" || kind === "battle_abandoned") {
    battleLastEmittedLogLen.delete(battleId);
    return payload;
  }

  if (kind !== "battle_state") return payload;

  const state = payload.state as BattleState | undefined;
  if (!state || typeof state !== "object") return payload;

  const logs = Array.isArray(state.logs) ? state.logs : [];
  const currentLen = logs.length;
  const prevLenRaw = battleLastEmittedLogLen.get(battleId);
  const prevLen =
    typeof prevLenRaw === "number" && prevLenRaw >= 0 ? prevLenRaw : 0;
  const startIndex = currentLen >= prevLen ? prevLen : 0;
  const deltaLogs = logs.slice(startIndex);

  battleLastEmittedLogLen.set(battleId, currentLen);

  const strippedState = stripStaticFieldsFromState(state);
  strippedState.logs =
    deltaLogs.length > MAX_BATTLE_LOG_DELTA ? logs : deltaLogs;
  const logDelta = deltaLogs.length <= MAX_BATTLE_LOG_DELTA;
  const logStart = logDelta ? startIndex : 0;

  return {
    ...payload,
    state: strippedState,
    logStart,
    logDelta,
    unitsDelta: true,
  };
}

// ------ 推送更新 ------

export function emitBattleUpdate(battleId: string, payload: Record<string, unknown>): void {
  try {
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) return;
    const gameServer = getGameServer();
    const patched = patchBattleUpdatePayload(battleId, payload);
    for (const userId of participants) {
      if (!Number.isFinite(userId)) continue;
      gameServer.emitToUser(userId, "battle:update", patched);
    }
    const engine = activeBattles.get(battleId);
    if (engine) {
      const kind = typeof payload?.kind === "string" ? payload.kind : "";
      const now = Date.now();
      const lastSavedAt = battleLastRedisSavedAt.get(battleId) ?? 0;
      const shouldSave =
        kind === "battle_started" ||
        kind === "battle_finished" ||
        kind === "battle_abandoned" ||
        now - lastSavedAt >= BATTLE_REDIS_SAVE_INTERVAL_MS;
      if (shouldSave) {
        battleLastRedisSavedAt.set(battleId, now);
        void saveBattleToRedis(battleId, engine, participants);
      }
    }
  } catch (error) {
    console.warn(`[battle] 推送战斗更新失败: ${battleId}`, error);
  }
}

// ------ 自动操作 ------

const resolveAutoSkipTargetIds = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): string[] => {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  const aliveAllies = allies.filter((u) => u.isAlive);
  const aliveEnemies = enemies.filter((u) => u.isAlive);

  if (skill.targetType === "self") {
    return [unit.id];
  }
  if (skill.targetType === "single_enemy") {
    return aliveEnemies[0] ? [aliveEnemies[0].id] : [];
  }
  if (skill.targetType === "single_ally") {
    const targetId = resolveSingleAllyTargetId(unit, skill, aliveAllies);
    return targetId ? [targetId] : [];
  }
  return [];
};

const canCastSkillForAutoSkip = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): boolean => {
  if (skill.triggerType !== "active") return false;
  if (!canUseSkill(unit, skill.damageType)) return false;
  if ((unit.skillCooldowns[skill.id] || 0) > 0) return false;
  if (skill.cost.lingqi && unit.lingqi < skill.cost.lingqi) return false;
  if (skill.cost.qixue && unit.qixue <= skill.cost.qixue) return false;

  if (
    skill.targetType === "self" ||
    skill.targetType === "single_enemy" ||
    skill.targetType === "single_ally"
  ) {
    return resolveAutoSkipTargetIds(state, unit, skill).length > 0;
  }
  return true;
};

export const canPlayerUseAnySkillThisTurn = (
  state: BattleState,
  currentUnit: BattleUnit,
): boolean => {
  const activeSkills = currentUnit.skills.filter(
    (skill) => skill.triggerType === "active",
  );
  const normalAttack = getNormalAttack(currentUnit);
  const candidateSkills = [...activeSkills, normalAttack];
  const seenSkillIds = new Set<string>();

  for (const skill of candidateSkills) {
    if (seenSkillIds.has(skill.id)) continue;
    seenSkillIds.add(skill.id);
    if (canCastSkillForAutoSkip(state, currentUnit, skill)) return true;
  }
  return false;
};

function hasAnyOnlineUser(
  userIds: number[],
  gameServer: ReturnType<typeof getGameServer>,
): boolean {
  for (const userId of userIds) {
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (gameServer.isUserOnline(userId)) return true;
  }
  return false;
}

async function shouldServerTakeoverDisconnectedPlayerTurn(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
): Promise<boolean> {
  if (state.currentTeam !== "attacker") return false;
  if (currentUnit.type !== "player") return false;
  if (getAttackerPlayerCount(state) <= 1) return false;

  const gameServer = getGameServer();
  const participants = battleParticipants.get(battleId) || [];
  if (!hasAnyOnlineUser(participants, gameServer)) return false;

  const characterId = Math.floor(Number(currentUnit.sourceId));
  if (!Number.isFinite(characterId) || characterId <= 0) return true;

  const ownerUserId = await getUserIdByCharacterId(characterId);
  if (!ownerUserId) return true;
  return !gameServer.isUserOnline(ownerUserId);
}

function clearPlayerTurnTimeoutState(battleId: string): void {
  playerTurnTimeoutStateByBattleId.delete(battleId);
}

function buildPlayerTurnKey(state: BattleState, currentUnit: BattleUnit): string {
  return [
    String(state.roundCount ?? ""),
    String(state.currentTeam ?? ""),
    String(state.currentUnitId ?? ""),
    currentUnit.id,
  ].join("|");
}

function shouldTakeoverPlayerTurnByTimeout(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
  now: number = Date.now(),
): boolean {
  const turnKey = buildPlayerTurnKey(state, currentUnit);
  const current = playerTurnTimeoutStateByBattleId.get(battleId);

  if (!current || current.turnKey !== turnKey) {
    playerTurnTimeoutStateByBattleId.set(battleId, {
      turnKey,
      deadlineAt: now + PLAYER_ACTION_TIMEOUT_MS,
    });
    return false;
  }

  if (now < current.deadlineAt) return false;
  clearPlayerTurnTimeoutState(battleId);
  return true;
}

// ------ tick 驱动 ------

/**
 * 核心 tick 逻辑：推进一步战斗
 *
 * 注意：finishBattle 通过延迟 import 从 settlement.ts 获取，避免循环依赖。
 */
async function tickBattle(battleId: string): Promise<void> {
  if (battleTickLocks.has(battleId)) return;
  battleTickLocks.add(battleId);
  try {
    const engine = activeBattles.get(battleId);
    if (!engine) {
      clearPlayerTurnTimeoutState(battleId);
      stopBattleTicker(battleId);
      return;
    }

    const state = engine.getState();
    if (state.phase === "finished") {
      clearPlayerTurnTimeoutState(battleId);
      const { finishBattle } = await import("../settlement.js");
      const { getBattleMonsters } = await import("../settlement.js");
      const monsters = await getBattleMonsters(engine);
      await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return;
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      clearPlayerTurnTimeoutState(battleId);
      return;
    }

    if (currentUnit.type === "player") {
      if (state.currentTeam !== "attacker") {
        clearPlayerTurnTimeoutState(battleId);
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (isStunned(currentUnit) || isFeared(currentUnit)) {
        clearPlayerTurnTimeoutState(battleId);
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (
        await shouldServerTakeoverDisconnectedPlayerTurn(
          battleId,
          state,
          currentUnit,
        )
      ) {
        clearPlayerTurnTimeoutState(battleId);
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (!canPlayerUseAnySkillThisTurn(state, currentUnit)) {
        clearPlayerTurnTimeoutState(battleId);
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      if (shouldTakeoverPlayerTurnByTimeout(battleId, state, currentUnit)) {
        engine.aiAction(true);
        emitBattleUpdate(battleId, {
          kind: "battle_state",
          battleId,
          state: engine.getState(),
        });
        return;
      }
      emitBattleUpdate(battleId, {
        kind: "battle_state",
        battleId,
        state: engine.getState(),
      });
      return;
    }

    clearPlayerTurnTimeoutState(battleId);
    engine.aiAction();
    emitBattleUpdate(battleId, {
      kind: "battle_state",
      battleId,
      state: engine.getState(),
    });
  } catch (error) {
    console.error(
      `[battle] tickBattle 发生未处理异常，已停止 ticker: ${battleId}`,
      error,
    );
    stopBattleTicker(battleId);
  } finally {
    battleTickLocks.delete(battleId);
  }
}

export function startBattleTicker(battleId: string): void {
  if (battleTickers.has(battleId)) return;
  const timer = setInterval(() => {
    void tickBattle(battleId);
  }, BATTLE_TICK_MS);
  battleTickers.set(battleId, timer);
  void tickBattle(battleId);
}

export function stopBattleTicker(battleId: string): void {
  clearPlayerTurnTimeoutState(battleId);
  const t = battleTickers.get(battleId);
  if (t) clearInterval(t);
  battleTickers.delete(battleId);
  battleTickLocks.delete(battleId);
  battleLastEmittedLogLen.delete(battleId);
  battleLastRedisSavedAt.delete(battleId);
}
