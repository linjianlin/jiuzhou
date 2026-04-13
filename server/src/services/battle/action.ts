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
  applyOnlineBattleCharacterResourceDelta,
  getOnlineBattleCharacterSnapshotByUserId,
} from "../onlineBattleProjectionService.js";
import { getArenaStatus } from "../arenaService.js";
import type { BattleResult } from "./battleTypes.js";
import {
  activeBattles,
  battleParticipants,
  finishedBattleResults,
  BATTLE_START_COOLDOWN_MS,
  collectPlayerCharacterIdsFromBattleState,
  getFinishedBattleResultIfFresh,
  normalizeBattleParticipantUserIds,
  removeBattleCharacterIndex,
  removeBattleParticipantIndex,
  setBattleStartCooldownByCharacterIds,
} from "./runtime/state.js";
import {
  emitBattleProgressUpdateSafely,
  stopBattleTicker,
} from "./runtime/ticker.js";
import { removeBattleFromRedis } from "./runtime/persistence.js";
import { buildBattleAbandonedRealtimePayload } from "./runtime/realtime.js";
import {
  resolveArenaBattleSettlementContext,
  settleArenaBattleIfNeeded,
} from "./pvp.js";
import {
  abandonWaitingTransitionBattleSession,
  getAttachedBattleSessionSnapshot,
  markBattleSessionAbandoned,
} from "../battleSession/index.js";
import { createScopedLogger } from "../../utils/logger.js";
import { createSlowOperationLogger } from "../../utils/slowOperationLogger.js";

const battleActionLogger = createScopedLogger("battle.action");

/**
 * 终局行动后的异步派发。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“终局后一整套 finishBattle/推送/清理”移出 action 首包临界区，避免最后一击把 HTTP 响应拖到 1 秒级。
 * 2. 做什么：继续复用 `emitBattleProgressUpdateSafely` 这一条权威结算路径，不额外复制终局处理逻辑。
 * 3. 不做什么：不改变战斗结果，也不跳过结算；只是从“同步等待完成”改成“后台继续执行”。
 *
 * 输入/输出：
 * - 输入：battleId、当前 BattleEngine。
 * - 输出：无同步返回；副作用在后台异步完成。
 *
 * 数据流/状态流：
 * playerAction 命中终局 -> 本函数排队微任务 -> emitBattleProgressUpdateSafely
 * -> finishBattle -> battle_finished realtime / 清理 runtime。
 *
 * 关键边界条件与坑点：
 * 1. 这里只能用于 `phase === finished` 的场景；进行中状态若异步化，会让 battle_state 推送顺序失控。
 * 2. 异步执行期间若 ticker 恰好也命中同一终局，最终会由 finishBattle 的 inflight 去重兜住，不能再额外实现第二套锁。
 */
const scheduleFinishedBattleProgressUpdate = (
  battleId: string,
  engine: Parameters<typeof emitBattleProgressUpdateSafely>[1],
): void => {
  void Promise.resolve().then(async () => {
    try {
      await emitBattleProgressUpdateSafely(battleId, engine);
    } catch (error) {
      battleActionLogger.error({
        battleId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, "终局行动异步派发失败");
    }
  });
};

export async function playerAction(
  userId: number,
  battleId: string,
  skillId: string,
  targetIds: string[],
): Promise<BattleResult> {
  const slowLogger = createSlowOperationLogger({
    label: "api/battle/action",
    fields: {
      userId,
      battleId,
      skillId,
      targetCount: targetIds.length,
    },
  });

  try {
    const engine = activeBattles.get(battleId);

    if (!engine) {
      slowLogger.flush({
        success: false,
        reason: "battle_missing",
      });
      return { success: false, message: "战斗不存在或已结束" };
    }

    const state = engine.getState();

    const participants = battleParticipants.get(battleId) || [];
    if (
      !participants.includes(userId) &&
      state.teams.attacker.odwnerId !== userId
    ) {
      slowLogger.flush({
        success: false,
        reason: "forbidden",
      });
      return { success: false, message: "无权操作此战斗" };
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      slowLogger.flush({
        success: false,
        reason: "no_current_unit",
      });
      return { success: false, message: "没有当前行动单位" };
    }
    if (currentUnit.type !== "player" || state.currentTeam !== "attacker") {
      slowLogger.flush({
        success: false,
        reason: "not_player_turn",
      });
      return { success: false, message: "当前不是玩家行动回合" };
    }

    const result = engine.playerAction(userId, skillId, targetIds);
    slowLogger.mark("engine.playerAction", {
      actionSuccess: result.success,
      phaseAfterAction: engine.getState().phase,
    });

    if (!result.success) {
      slowLogger.flush({
        success: false,
        reason: "engine_rejected",
      });
      return { success: false, message: result.error || "行动失败" };
    }
    const phaseAfterAction = engine.getState().phase;
    if (phaseAfterAction === "finished") {
      scheduleFinishedBattleProgressUpdate(battleId, engine);
      slowLogger.mark("scheduleFinishedBattleProgressUpdate", {
        finalPhase: phaseAfterAction,
      });
      slowLogger.flush({
        success: true,
        battleFinished: true,
      });

      return {
        success: true,
        message: "行动已提交",
      };
    }

    await emitBattleProgressUpdateSafely(battleId, engine);
    slowLogger.mark("emitBattleProgressUpdateSafely", {
      finalPhase: engine.getState().phase,
    });
    slowLogger.flush({
      success: true,
      battleFinished: false,
    });

    return {
      success: true,
      message: "行动已提交",
    };
  } catch (error) {
    slowLogger.flush({
      success: false,
      reason: "exception",
    });
    battleActionLogger.error({
      battleId,
      userId,
      skillId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "玩家行动失败");
    return { success: false, message: "行动失败" };
  }
}

export async function abandonBattle(
  userId: number,
  battleId: string,
): Promise<BattleResult> {
  const engine = activeBattles.get(battleId);

  if (!engine) {
    const waitingTransitionRes = await abandonWaitingTransitionBattleSession({
      battleId,
      userId,
    });
    if (!waitingTransitionRes.success) {
      return { success: false, message: waitingTransitionRes.message };
    }

    const cachedResult = getFinishedBattleResultIfFresh(battleId);
    const nextBattleAvailableAtRaw = cachedResult?.data?.nextBattleAvailableAt;
    const nextBattleAvailableAt =
      typeof nextBattleAvailableAtRaw === "number" && Number.isFinite(nextBattleAvailableAtRaw)
        ? nextBattleAvailableAtRaw
        : undefined;

    try {
      const gameServer = getGameServer();
      for (const participantUserId of waitingTransitionRes.data.participantUserIds) {
        if (!Number.isFinite(participantUserId)) continue;
        gameServer.emitToUser(
          participantUserId,
          "battle:update",
          buildBattleAbandonedRealtimePayload({
            battleId,
            success: true,
            message: "已退出战斗",
            session: waitingTransitionRes.data.session,
            ...(typeof nextBattleAvailableAt === "number"
              ? { nextBattleAvailableAt }
              : {}),
          }),
        );
        void gameServer.pushCharacterUpdate(participantUserId);
      }
    } catch (error) {
      battleActionLogger.warn({
        battleId,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      }, "推送 waiting_transition 退出事件失败");
    }

    return {
      success: true,
      message: "已退出战斗",
      data: typeof nextBattleAvailableAt === "number"
        ? { nextBattleAvailableAt }
        : undefined,
    };
  }

  const state = engine.getState();
  const attachedSession = getAttachedBattleSessionSnapshot(battleId);
  const arenaSettlementContext = resolveArenaBattleSettlementContext({
    state,
    session: attachedSession,
  });
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
    const snapshot = await getOnlineBattleCharacterSnapshotByUserId(participantUserId);
    if (!snapshot) continue;
    participantCharacterIds.push(Math.floor(Number(snapshot.characterId)));
    const loss = Math.floor(snapshot.computed.max_qixue * 0.1);
    await applyOnlineBattleCharacterResourceDelta(
      snapshot.characterId,
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

  try {
    if (arenaSettlementContext) {
      await settleArenaBattleIfNeeded({
        battleId,
        battleResult: "defender_win",
        challengerCharacterId: arenaSettlementContext.challengerCharacterId,
        opponentCharacterId: arenaSettlementContext.opponentCharacterId,
      });
    }
  } catch (error) {
    battleActionLogger.warn({
      battleId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "放弃战斗时竞技场结算失败");
  }

  try {
    const gameServer = getGameServer();
    const sessionSnapshot = await markBattleSessionAbandoned(battleId);
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
      if (arenaSettlementContext) {
        const snapshot = await getOnlineBattleCharacterSnapshotByUserId(participantUserId);
        const characterId = Number(snapshot?.characterId);
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
    battleActionLogger.warn({
      battleId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "推送放弃战斗事件失败");
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
