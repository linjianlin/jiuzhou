/**
 * 战斗 Redis 持久化
 *
 * 作用：
 * - 将战斗状态保存到 Redis（用于服务器重启后恢复）
 * - 从 Redis 删除已结束的战斗
 * - 恢复战斗参与者列表
 *
 * 不做什么：不管理内存状态、不操作战斗引擎。
 *
 * 复用点：ticker.ts（定期保存）、settlement.ts（结算后删除）、lifecycle.ts（恢复）
 *
 * 边界条件：
 * 1) saveBattleToRedis 失败时仅 warn，不中断战斗流程
 * 2) resolveRecoveredBattleParticipants 优先用 Redis 数据，缺失时从 state 反推
 */

import { redis } from "../../../config/redis.js";
import { BattleEngine } from "../../../battle/battleEngine.js";
import type { BattleState } from "../../../battle/types.js";
import {
  normalizeBattleParticipantUserIds,
  collectBattleOwnerUserIds,
  collectPlayerCharacterIdsFromBattleState,
  getUserIdByCharacterId,
} from "./state.js";

// ------ 常量 ------

export const REDIS_BATTLE_KEY_PREFIX = "battle:state:";
export const REDIS_BATTLE_PARTICIPANTS_PREFIX = "battle:participants:";
export const REDIS_BATTLE_TTL_SECONDS = 30 * 60; // 30 分钟

// ------ 保存/删除 ------

export async function saveBattleToRedis(
  battleId: string,
  engine: BattleEngine,
  participants: number[],
): Promise<void> {
  try {
    const state = engine.getState();
    await Promise.all([
      redis.setex(
        `${REDIS_BATTLE_KEY_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(state),
      ),
      redis.setex(
        `${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`,
        REDIS_BATTLE_TTL_SECONDS,
        JSON.stringify(participants),
      ),
    ]);
  } catch (error) {
    console.error("保存战斗到 Redis 失败:", error);
  }
}

export async function removeBattleFromRedis(battleId: string): Promise<void> {
  try {
    await Promise.all([
      redis.del(`${REDIS_BATTLE_KEY_PREFIX}${battleId}`),
      redis.del(`${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`),
    ]);
  } catch (error) {
    console.error("从 Redis 删除战斗失败:", error);
  }
}

// ------ 恢复参与者 ------

export async function resolveRecoveredBattleParticipants(
  state: BattleState,
  participantsRaw: unknown,
): Promise<number[]> {
  const fromRedis = normalizeBattleParticipantUserIds(participantsRaw);
  if (fromRedis.length > 0) return fromRedis;

  const ids = new Set<number>();
  for (const ownerUserId of collectBattleOwnerUserIds(state)) {
    ids.add(ownerUserId);
  }

  const playerCharacterIds = collectPlayerCharacterIdsFromBattleState(state);
  if (playerCharacterIds.length > 0) {
    const ownerUserIds = await Promise.all(
      playerCharacterIds.map((characterId) =>
        getUserIdByCharacterId(characterId),
      ),
    );
    for (const userId of ownerUserIds) {
      const normalizedUserId = Math.floor(Number(userId));
      if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
      ids.add(normalizedUserId);
    }
  }

  return [...ids];
}
