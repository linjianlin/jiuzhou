/**
 * 战斗生命周期管理（恢复 / 清理 / 关闭）
 *
 * 作用：
 * - recoverBattlesFromRedis: 服务启动时从 Redis 恢复活跃战斗
 * - cleanupExpiredBattles: 单次执行超时战斗清理（由 cleanupWorker 定时调度）
 * - stopBattleService: 优雅关闭战斗 ticker 定时器
 *
 * 复用点：startupPipeline.ts 调用 recoverBattlesFromRedis / stopBattleService。
 *
 * 边界条件：
 * 1) 恢复时无法找到参与者的战斗会被跳过并清理
 * 2) cleanupExpiredBattles 通过 battleId 中的时间戳判断过期
 */

import { redis } from "../../config/redis.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import type { BattleState } from "../../battle/types.js";
import { migrateRecoveredLegacyBattleCooldownState } from "../../battle/utils/cooldown.js";
import {
  activeBattles,
  setBattleParticipantsForBattle,
  syncBattleCharacterIndex,
  battleParticipants,
  finishedBattleResults,
  removeBattleCharacterIndex,
  removeBattleParticipantIndex,
} from "./runtime/state.js";
import {
  startBattleTicker,
  stopAllBattleTickers,
  stopBattleTicker,
} from "./runtime/ticker.js";
import {
  REDIS_BATTLE_KEY_PREFIX,
  REDIS_BATTLE_STATIC_PREFIX,
  REDIS_BATTLE_PARTICIPANTS_PREFIX,
  removeBattleFromRedis,
  restoreBattleStateFromRedisSnapshot,
  resolveRecoveredBattleParticipants,
  shouldPersistBattleToRedis,
} from "./runtime/persistence.js";

const FINISHED_BATTLE_TTL_MS = 2 * 60 * 1000;
export const BATTLE_EXPIRED_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export async function recoverBattlesFromRedis(): Promise<number> {
  let recoveredCount = 0;
  try {
    const keys = await redis.keys(`${REDIS_BATTLE_KEY_PREFIX}*`);
    const battleStateKeys = keys.filter((key) => {
      if (key.startsWith(REDIS_BATTLE_STATIC_PREFIX)) return false;
      const battleId = key.replace(REDIS_BATTLE_KEY_PREFIX, "");
      return shouldPersistBattleToRedis(battleId);
    });
    if (battleStateKeys.length === 0) {
      console.log("✓ 没有需要恢复的战斗");
      return 0;
    }

    for (const key of battleStateKeys) {
      const battleId = key.replace(REDIS_BATTLE_KEY_PREFIX, "");
      try {
        const [stateJson, staticStateJson, participantsJson] = await Promise.all([
          redis.get(key),
          redis.get(`${REDIS_BATTLE_STATIC_PREFIX}${battleId}`),
          redis.get(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
        ]);

        if (!stateJson || !staticStateJson) {
          await removeBattleFromRedis(battleId);
          continue;
        }

        const state = restoreBattleStateFromRedisSnapshot(
          stateJson,
          staticStateJson,
        );

        if (state.phase === "finished") {
          await removeBattleFromRedis(battleId);
          continue;
        }
        const participantsRaw = participantsJson
          ? JSON.parse(participantsJson)
          : null;
        const participants = await resolveRecoveredBattleParticipants(
          state,
          participantsRaw,
        );
        if (participants.length === 0) {
          console.warn(
            `  跳过恢复战斗 ${battleId}: 参与者缺失且无法从战斗状态反推`,
          );
          await removeBattleFromRedis(battleId);
          continue;
        }

        migrateRecoveredLegacyBattleCooldownState(state);
        const engine = new BattleEngine(state);
        activeBattles.set(battleId, engine);
        setBattleParticipantsForBattle(battleId, participants);
        syncBattleCharacterIndex(battleId, state);
        startBattleTicker(battleId);

        recoveredCount++;
        console.log(
          `  恢复战斗: ${battleId} (${participants.length} 名参与者)`,
        );
      } catch (error) {
        console.error(`  恢复战斗 ${battleId} 失败:`, error);
        await removeBattleFromRedis(battleId);
      }
    }

    console.log(`✓ 已恢复 ${recoveredCount} 场战斗`);
  } catch (error) {
    console.error("恢复战斗失败:", error);
  }
  return recoveredCount;
}

export function cleanupExpiredBattles(): void {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000;

  for (const battleId of activeBattles.keys()) {
    const parts = String(battleId || "").split("-");
    let battleTime = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const n = Number(parts[i]);
      if (!Number.isFinite(n)) continue;
      if (n <= 0) continue;
      battleTime = Math.floor(n);
      break;
    }

    if (!Number.isFinite(battleTime) || battleTime <= 0) continue;
    if (now - battleTime > maxAge) {
      activeBattles.delete(battleId);
      battleParticipants.delete(battleId);
      removeBattleCharacterIndex(battleId);
      removeBattleParticipantIndex(battleId);
      stopBattleTicker(battleId);
      void removeBattleFromRedis(battleId);
    }
  }

  for (const [battleId, cached] of finishedBattleResults.entries()) {
    if (now - cached.at > FINISHED_BATTLE_TTL_MS) {
      finishedBattleResults.delete(battleId);
    }
  }
}

export function stopBattleService(): void {
  stopAllBattleTickers();
}
