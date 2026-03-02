/**
 * 战斗结算（去重包装 + 核心奖励分发）
 *
 * 作用：
 * - finishBattle: 去重 + 缓存包装，确保同一战斗只结算一次
 * - finishBattleCore: 核心结算逻辑（分发奖励、推送结果、清理状态）
 * - getBattleMonsters: 从引擎中提取怪物列表
 *
 * 复用点：ticker.ts / action.ts / queries.ts 调用 finishBattle。
 *
 * 边界条件：
 * 1) finishBattle 使用 finishingBattleResults 防止并发结算
 * 2) PVP 战斗调用 settleArenaBattleIfNeeded 进行评分结算
 */

import { BattleEngine } from "../../battle/battleEngine.js";
import type { MonsterData } from "../../battle/battleFactory.js";
import {
  battleDropService,
  type BattleParticipant,
  type DistributeResult,
} from "../battleDropService.js";
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByUserId,
  setCharacterResourcesByCharacterId,
} from "../characterComputedService.js";
import { getArenaStatus } from "../arenaService.js";
import { recordKillMonsterEvent } from "../taskService.js";
import { getGameServer } from "../../game/gameServer.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { getMonsterDefinitions } from "../staticConfigLoader.js";
import type { BattleResult } from "./battleTypes.js";
import {
  activeBattles,
  battleParticipants,
  finishedBattleResults,
  finishingBattleResults,
  BATTLE_START_COOLDOWN_MS,
  collectPlayerCharacterIdsFromBattleState,
  getFinishedBattleResultIfFresh,
  setBattleStartCooldownByCharacterIds,
} from "./runtime/state.js";
import { stopBattleTicker } from "./runtime/ticker.js";
import { removeBattleFromRedis } from "./runtime/persistence.js";
import { settleArenaBattleIfNeeded } from "./pvp.js";

export async function getBattleMonsters(engine: BattleEngine): Promise<MonsterData[]> {
  const state = engine.getState();
  if (state.battleType !== "pve") return [];
  const orderedIds = state.teams.defender.units
    .filter((u) => u.type === "monster")
    .map((u) => String(u.sourceId))
    .filter(Boolean);
  if (orderedIds.length === 0) return [];
  const uniqIds = [...new Set(orderedIds)];
  const idSet = new Set(uniqIds);
  const defs = getMonsterDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => idSet.has(entry.id)) as MonsterData[];
  const defMap = new Map(defs.map((m) => [m.id, m] as const));
  const monsters: MonsterData[] = [];
  for (const id of orderedIds) {
    const def = defMap.get(id);
    if (def) monsters.push(def);
  }
  return monsters;
}

async function finishBattleCore(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const state = engine.getState();
  const result = engine.getResult();

  const participantUserIds = (battleParticipants.get(battleId) || []).slice();
  const participantCount = Math.max(1, participantUserIds.length);
  const isVictory = result.result === "attacker_win";
  const isDungeonBattle = battleId.startsWith("dungeon-battle-");

  const participants: BattleParticipant[] = [];
  for (const participantUserId of participantUserIds) {
    const computed = await getCharacterComputedByUserId(participantUserId);
    if (!computed) continue;
    participants.push({
      userId: participantUserId,
      characterId: computed.id,
      nickname: computed.nickname,
      realm: normalizeRealmKeepingUnknown(computed.realm, computed.sub_realm),
      fuyuan: Number(computed.fuyuan ?? 1),
    });
  }

  let dropResult: DistributeResult | null = null;

  if (state.battleType === "pve") {
    if (isVictory) {
      dropResult = await battleDropService.distributeBattleRewards(
        monsters,
        participants,
        true,
        { isDungeonBattle },
      );

      for (const participantUserId of participantUserIds) {
        const computed = await getCharacterComputedByUserId(participantUserId);
        if (!computed) continue;
        const healAmount = Math.floor(computed.max_qixue * 0.3);
        await setCharacterResourcesByCharacterId(computed.id, {
          qixue: Math.min(computed.max_qixue, computed.qixue + healAmount),
          lingqi: computed.lingqi,
        });
      }

      try {
        const killCounts = new Map<string, number>();
        for (const m of monsters) {
          const id = String((m as unknown as Record<string, unknown>)?.id ?? "").trim();
          if (!id) continue;
          killCounts.set(id, (killCounts.get(id) ?? 0) + 1);
        }
        if (killCounts.size > 0) {
          for (const p of participants) {
            const characterId = Number(p.characterId);
            if (!Number.isFinite(characterId) || characterId <= 0) continue;
            for (const [monsterId, count] of killCounts.entries()) {
              await recordKillMonsterEvent(characterId, monsterId, count);
            }
          }
        }
      } catch (error) {
        console.warn("[battle] 记录击杀怪物事件失败:", error);
      }
    } else if (result.result === "defender_win") {
      for (const participantUserId of participantUserIds) {
        const computed = await getCharacterComputedByUserId(participantUserId);
        if (!computed) continue;
        const loss = Math.floor(computed.max_qixue * 0.1);
        await applyCharacterResourceDeltaByCharacterId(
          computed.id,
          { qixue: -loss },
          { minQixue: 1 },
        );
      }
    }
  }

  const rewardsData = dropResult
    ? {
        exp: dropResult.rewards.exp,
        silver: dropResult.rewards.silver,
        totalExp: dropResult.rewards.exp,
        totalSilver: dropResult.rewards.silver,
        participantCount,
        items: dropResult.rewards.items.map((item) => ({
          itemDefId: item.itemDefId,
          name: item.itemName,
          quantity: item.quantity,
          receiverId: item.receiverId,
        })),
        perPlayerRewards: dropResult.perPlayerRewards,
      }
    : null;

  const participantCharacterIds = participants
    .map((entry) => Math.floor(Number(entry.characterId)))
    .filter((characterId) => Number.isFinite(characterId) && characterId > 0);
  const cooldownCharacterIds =
    participantCharacterIds.length > 0
      ? participantCharacterIds
      : collectPlayerCharacterIdsFromBattleState(state);
  const cooldownUntilMs =
    setBattleStartCooldownByCharacterIds(cooldownCharacterIds);

  const battleResult: BattleResult = {
    success: true,
    message:
      result.result === "attacker_win"
        ? "战斗胜利"
        : result.result === "defender_win"
          ? "战斗失败"
          : "战斗平局",
    data: {
      result: result.result,
      rounds: result.rounds,
      rewards: rewardsData,
      stats: result.stats,
      logs: result.logs,
      state,
      isTeamBattle: participantCount > 1,
      battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      nextBattleAvailableAt: cooldownUntilMs,
    },
  };

  try {
    if (state.battleType === "pvp") {
      await settleArenaBattleIfNeeded(
        battleId,
        result.result as "attacker_win" | "defender_win" | "draw",
      );
    }
  } catch (error) {
    console.warn("竞技场战斗结算失败:", error);
  }

  try {
    const gameServer = getGameServer();
    for (const participantUserId of participantUserIds) {
      if (!Number.isFinite(participantUserId)) continue;
      gameServer.emitToUser(participantUserId, "battle:update", {
        kind: "battle_finished",
        battleId,
        ...battleResult,
      });
      void gameServer.pushCharacterUpdate(participantUserId);
    }
    if (state.battleType === "pvp") {
      for (const p of participants) {
        const characterId = Number(p.characterId);
        if (!Number.isFinite(characterId) || characterId <= 0) continue;
        const statusRes = await getArenaStatus(characterId);
        if (!statusRes.success || !statusRes.data) continue;
        gameServer.emitToUser(p.userId, "arena:update", {
          kind: "arena_status",
          status: statusRes.data,
        });
      }
    }
  } catch (error) {
    console.warn(`[battle] 推送战斗结束事件失败: ${battleId}`, error);
  }

  activeBattles.delete(state.battleId);
  battleParticipants.delete(state.battleId);
  stopBattleTicker(state.battleId);
  finishedBattleResults.set(state.battleId, {
    result: battleResult,
    at: Date.now(),
  });
  void removeBattleFromRedis(state.battleId);

  return battleResult;
}

export async function finishBattle(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const cachedResult = getFinishedBattleResultIfFresh(battleId);
  if (cachedResult) {
    return cachedResult;
  }

  const inflightResult = finishingBattleResults.get(battleId);
  if (inflightResult) {
    return inflightResult;
  }

  const settlePromise = finishBattleCore(battleId, engine, monsters);
  finishingBattleResults.set(battleId, settlePromise);
  try {
    return await settlePromise;
  } finally {
    finishingBattleResults.delete(battleId);
  }
}
