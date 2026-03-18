/**
 * 组队相关战斗钩子
 *
 * 作用：
 * - onUserJoinTeam: 加入队伍时自动退出单人 PVE 战斗
 * - onUserLeaveTeam: 离开队伍时同步移除参战资格与攻击方玩家单位
 * - syncBattleStateOnReconnect: 重连时推送活跃战斗状态
 *
 * 复用点：teamService.ts / gameServer.ts 调用。
 *
 * 边界条件：
 * 1) onUserJoinTeam 仅退出单人 PVE 战斗（多人战斗不处理）
 * 2) onUserLeaveTeam 不终止整场多人战斗，但必须同步修正 attacker.units 与当前行动指针
 */

import { getGameServer } from "../../game/gameServer.js";
import { getBattleLogCursor } from "../../battle/logStream.js";
import {
  activeBattles,
  battleParticipants,
  getAttackerPlayerCount,
  getUserIdByCharacterId,
  listActiveBattleIdsByUserId,
  setBattleParticipantsForBattle,
  syncBattleCharacterIndex,
} from "./runtime/state.js";
import { abandonBattle } from "./action.js";
import { getBattleState } from "./queries.js";
import {
  buildBattleLogCursorSnapshot,
  buildBattleFinishedRealtimePayload,
  buildBattleRealtimePayload,
  buildBattleSnapshotState,
} from "./runtime/realtime.js";
import {
  getAttachedBattleSessionSnapshot,
  removeBattleSessionParticipantUser,
} from "../battleSession/index.js";

/**
 * 同步移除离队玩家的参战资格与攻击方玩家单位，避免 participants 与 battle state 脱节。
 */
async function removeUserFromTeamBattle(
  userId: number,
  battleId: string,
): Promise<void> {
  const engine = activeBattles.get(battleId);
  if (!engine) return;

  const state = engine.getState();
  const ownedAttackerUnitIds: string[] = [];
  for (const unit of state.teams.attacker.units) {
    if (unit.type !== "player") continue;
    const characterId = Math.floor(Number(unit.sourceId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    const ownerUserId = await getUserIdByCharacterId(characterId);
    if (ownerUserId !== userId) continue;
    ownedAttackerUnitIds.push(unit.id);
  }

  engine.removeAttackerUnits(ownedAttackerUnitIds);
  syncBattleCharacterIndex(battleId, engine.getState());

  const participants = battleParticipants.get(battleId) || [];
  const nextParticipants = participants.filter((id) => id !== userId);
  setBattleParticipantsForBattle(battleId, nextParticipants);
  removeBattleSessionParticipantUser(battleId, userId);
}

export async function onUserJoinTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount > 1) continue;
    try {
      await abandonBattle(userId, battleId);
    } catch (error) {
      console.warn(`[battle] onUserJoinTeam 自动退出战斗失败: ${battleId}`, error);
    }
  }
}

export async function onUserLeaveTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    if (state.battleType !== "pve") continue;
    if (state.teams.attacker.odwnerId === userId) {
      try {
        await abandonBattle(userId, battleId);
      } catch (error) {
        console.warn(`[battle] onUserLeaveTeam 队长退出战斗失败: ${battleId}`, error);
      }
      continue;
    }
    await removeUserFromTeamBattle(userId, battleId);
    try {
      const gameServer = getGameServer();
      gameServer.emitToUser(userId, "battle:update", {
        kind: "battle_abandoned",
        battleId,
        success: true,
        message: "已离开队伍，退出队伍战斗",
      });
    } catch (error) {
      console.warn(`[battle] onUserLeaveTeam 推送退出战斗失败: ${battleId}`, error);
    }
  }
}

export async function syncBattleStateOnReconnect(
  userId: number,
): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;

  const gameServer = getGameServer();
  if (!gameServer) return;

  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;

    const state = engine.getState();

    if (state.phase === "finished") continue;
    const logSnapshot = buildBattleLogCursorSnapshot(getBattleLogCursor(battleId));

    gameServer.emitToUser(userId, "battle:update", buildBattleRealtimePayload({
      kind: "battle_started",
      battleId,
      state: buildBattleSnapshotState(state),
      logs: logSnapshot.logs,
      extras: {
        authoritative: true,
        logStart: logSnapshot.logStart,
        logDelta: logSnapshot.logDelta,
      },
    }));
  }
}

/**
 * 按 battleId 向指定用户主动补发一次完整战斗快照。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为开战首帧、重连恢复、页面主动请求同步提供统一的 battle 快照发送入口。
 * 2. 做什么：活跃战斗发 `battle_started`，刚结束且仍可查询到结果的战斗发 `battle_finished`，避免客户端拿到只有 battleId 的半成品状态。
 * 3. 不做什么：不改变 battle/session 运行状态，也不做权限外的房间或地图切换。
 *
 * 输入/输出：
 * - 输入：userId、battleId。
 * - 输出：是否成功补发到一条可消费的 battle realtime 消息。
 *
 * 数据流/状态流：
 * - 客户端拿到 battleId -> 调本函数 -> 服务端读取 active battle / finished result -> 推送完整 realtime payload。
 *
 * 关键边界条件与坑点：
 * 1. 活跃 battle 与已结束 battle 要走不同 payload 口径，不能把 finished result 冒充成 `battle_started`。
 * 2. battle 可能已经被清理，查不到时必须返回 false，让调用方知道这不是一场可恢复的战斗。
 */
export async function syncBattleSnapshotToUser(
  userId: number,
  battleId: string,
): Promise<boolean> {
  const normalizedBattleId = String(battleId || "").trim();
  if (!normalizedBattleId) return false;

  const gameServer = getGameServer();
  if (!gameServer) return false;

  const engine = activeBattles.get(normalizedBattleId);
  if (engine) {
    const state = engine.getState();
    if (state.phase === "finished") {
      const battleRes = await getBattleState(normalizedBattleId);
      if (!battleRes.success) return false;
      const payload = buildBattleFinishedRealtimePayload({
        battleId: normalizedBattleId,
        battleResult: battleRes,
        session: getAttachedBattleSessionSnapshot(normalizedBattleId),
      });
      if (!payload) return false;
      gameServer.emitToUser(userId, "battle:update", payload);
      return true;
    }
    const logSnapshot = buildBattleLogCursorSnapshot(
      getBattleLogCursor(normalizedBattleId),
    );

    gameServer.emitToUser(userId, "battle:update", buildBattleRealtimePayload({
      kind: "battle_started",
      battleId: normalizedBattleId,
      state: buildBattleSnapshotState(state),
      logs: logSnapshot.logs,
      extras: {
        authoritative: true,
        ...(getAttachedBattleSessionSnapshot(normalizedBattleId)
          ? { session: getAttachedBattleSessionSnapshot(normalizedBattleId) }
          : {}),
        logStart: logSnapshot.logStart,
        logDelta: logSnapshot.logDelta,
      },
    }));
    return true;
  }

  const battleRes = await getBattleState(normalizedBattleId);
  if (!battleRes.success) return false;
  const payload = buildBattleFinishedRealtimePayload({
    battleId: normalizedBattleId,
    battleResult: battleRes,
    session: getAttachedBattleSessionSnapshot(normalizedBattleId),
  });
  if (!payload) return false;
  gameServer.emitToUser(userId, "battle:update", payload);
  return true;
}
