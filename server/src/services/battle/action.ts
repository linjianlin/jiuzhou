/**
 * 玩家战斗行动（技能释放 + 逃离）
 *
 * 作用：
 * - playerAction: 玩家在回合中释放技能
 * - abandonBattle: 玩家逃离战斗
 *
 * 复用点：路由层调用。
 *
 * 边界条件：
 * 1) playerAction 需验证当前是否为该玩家的行动回合
 * 2) abandonBattle 组队战斗只有队长可以逃跑
 */

import { getGameServer } from "../../game/gameServer.js";
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByUserId,
} from "../characterComputedService.js";
import { getArenaStatus } from "../arenaService.js";
import { cancelBattleCooldown } from "./cooldownManager.js";
import type { BattleResult } from "./battleTypes.js";
import {
  activeBattles,
  battleParticipants,
  finishedBattleResults,
  BATTLE_START_COOLDOWN_MS,
  collectPlayerCharacterIdsFromBattleState,
  normalizeBattleParticipantUserIds,
  removeBattleCharacterIndex,
  removeBattleParticipantIndex,
  setBattleStartCooldownByCharacterIds,
} from "./runtime/state.js";
import { stopBattleTicker, emitBattleUpdate } from "./runtime/ticker.js";
import { removeBattleFromRedis } from "./runtime/persistence.js";
import { buildBattleAbandonedRealtimePayload } from "./runtime/realtime.js";
import { finishBattle, getBattleMonsters } from "./settlement.js";
import { settleArenaBattleIfNeeded } from "./pvp.js";
import {
  getAttachedBattleSessionSnapshot,
  markBattleSessionAbandoned,
} from "../battleSession/index.js";

export async function playerAction(
  userId: number,
  battleId: string,
  skillId: string,
  targetIds: string[],
): Promise<BattleResult> {
  try {
    const engine = activeBattles.get(battleId);

    if (!engine) {
      return { success: false, message: "战斗不存在或已结束" };
    }

    const state = engine.getState();

    const participants = battleParticipants.get(battleId) || [];
    if (
      !participants.includes(userId) &&
      state.teams.attacker.odwnerId !== userId
    ) {
      return { success: false, message: "无权操作此战斗" };
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      return { success: false, message: "没有当前行动单位" };
    }
    if (currentUnit.type !== "player" || state.currentTeam !== "attacker") {
      return { success: false, message: "当前不是玩家行动回合" };
    }

    const result = engine.playerAction(userId, skillId, targetIds);

    if (!result.success) {
      return { success: false, message: result.error || "行动失败" };
    }
    emitBattleUpdate(battleId, {
      kind: "battle_state",
      battleId,
      state: engine.getState(),
    });

    const currentState = engine.getState();
    if (currentState.phase === "finished") {
      const monsters = await getBattleMonsters(engine);
      await finishBattle(battleId, engine, monsters);
      stopBattleTicker(battleId);
      return {
        success: true,
        message: "行动已提交",
      };
    }

    return {
      success: true,
      message: "行动已提交",
    };
  } catch (error) {
    console.error("玩家行动失败:", error);
    return { success: false, message: "行动失败" };
  }
}

export async function abandonBattle(
  userId: number,
  battleId: string,
): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);

  if (!engine) {
    return { success: false, message: "战斗不存在" };
  }

  const state = engine.getState();
  const attachedSession = getAttachedBattleSessionSnapshot(battleId);
  const participants = normalizeBattleParticipantUserIds([
    ...(battleParticipants.get(battleId) || []),
    ...(attachedSession?.participantUserIds ?? []),
    state.teams.attacker.odwnerId,
  ]);
  const participantCharacterIds: number[] = [];

  if (participants.length > 1 && state.teams.attacker.odwnerId !== userId) {
    return { success: false, message: "组队战斗只有队长可以逃跑" };
  }
  if (
    participants.length <= 1 &&
    !participants.includes(userId) &&
    state.teams.attacker.odwnerId !== userId
  ) {
    return { success: false, message: "无权操作此战斗" };
  }

  for (const participantUserId of participants) {
    const computed = await getCharacterComputedByUserId(participantUserId);
    if (!computed) continue;
    participantCharacterIds.push(Math.floor(Number(computed.id)));
    const loss = Math.floor(computed.max_qixue * 0.1);
    await applyCharacterResourceDeltaByCharacterId(
      computed.id,
      { qixue: -loss },
      { minQixue: 1 },
    );
  }

  const cooldownCharacterIds = participantCharacterIds.filter(
    (characterId) => Number.isFinite(characterId) && characterId > 0,
  );
  const cooldownUntilMs = setBattleStartCooldownByCharacterIds(
    cooldownCharacterIds.length > 0
      ? cooldownCharacterIds
      : collectPlayerCharacterIdsFromBattleState(state),
  );

  for (const characterId of cooldownCharacterIds) {
    cancelBattleCooldown(characterId);
  }

  try {
    if (state.battleType === "pvp") {
      await settleArenaBattleIfNeeded(battleId, "defender_win");
    }
  } catch (error) {
    console.warn("放弃战斗时竞技场结算失败:", error);
  }

  try {
    const gameServer = getGameServer();
    const sessionSnapshot = markBattleSessionAbandoned(battleId);
    for (const participantUserId of participants) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(
        participantUserId,
        "battle:update",
        buildBattleAbandonedRealtimePayload({
          battleId,
          success: true,
          message: "已放弃战斗",
          battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
          nextBattleAvailableAt: cooldownUntilMs,
          session: sessionSnapshot,
        }),
      );
      void gameServer.pushCharacterUpdate(participantUserId);
      if (state.battleType === "pvp") {
        const computed = await getCharacterComputedByUserId(participantUserId);
        const characterId = Number(computed?.id);
        if (Number.isFinite(characterId) && characterId > 0) {
          const statusRes = await getArenaStatus(characterId);
          if (statusRes.success && statusRes.data) {
            gameServer.emitToUser(participantUserId, "arena:update", {
              kind: "arena_status",
              status: statusRes.data,
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn(`[battle] 推送放弃战斗事件失败: ${battleId}`, error);
  }

  activeBattles.delete(battleId);
  battleParticipants.delete(battleId);
  removeBattleCharacterIndex(battleId);
  removeBattleParticipantIndex(battleId);
  stopBattleTicker(battleId);
  finishedBattleResults.set(battleId, {
    result: { success: true, message: "已放弃战斗" },
    at: Date.now(),
  });
  void removeBattleFromRedis(battleId);
  return {
    success: true,
    message: "已放弃战斗",
    data: {
      battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      nextBattleAvailableAt: cooldownUntilMs,
    },
  };
}
