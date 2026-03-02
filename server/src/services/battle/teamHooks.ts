/**
 * 组队相关战斗钩子
 *
 * 作用：
 * - onUserJoinTeam: 加入队伍时自动退出单人 PVE 战斗
 * - onUserLeaveTeam: 离开队伍时从队伍战斗中移除
 * - syncBattleStateOnReconnect: 重连时推送活跃战斗状态
 *
 * 复用点：teamService.ts / gameServer.ts 调用。
 *
 * 边界条件：
 * 1) onUserJoinTeam 仅退出单人 PVE 战斗（多人战斗不处理）
 * 2) onUserLeaveTeam 只是从 participants 中移除，不终止战斗
 */

import { getGameServer } from "../../game/gameServer.js";
import {
  activeBattles,
  battleParticipants,
  getAttackerPlayerCount,
  listActiveBattleIdsByUserId,
} from "./runtime/state.js";
import { abandonBattle } from "./action.js";

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
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount <= 1) continue;
    const participants = battleParticipants.get(battleId) || [];
    const nextParticipants = participants.filter((id) => id !== userId);
    battleParticipants.set(battleId, nextParticipants);
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

    gameServer.emitToUser(userId, "battle:update", {
      kind: "battle_started",
      battleId,
      state,
    });
  }
}
