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
import {
  consumeBattleLogDelta,
  getBattleLogCursor,
} from "../../battle/logStream.js";
import type { MonsterData } from "../../battle/battleFactory.js";
import type { BattleState } from "../../battle/types.js";
import { query } from "../../config/database.js";
import {
  battleDropService,
  type BattleParticipant,
  type DistributeResult,
} from "../battleDropService.js";
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedBatchByCharacterIds,
  getCharacterComputedByCharacterId,
  setCharacterResourcesByCharacterId,
} from "../characterComputedService.js";
import { getArenaStatus } from "../arenaService.js";
import { recordKillMonsterEvent } from "../taskService.js";
import { getGameServer } from "../../game/gameServer.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { getMonsterDefinitions } from "../staticConfigLoader.js";
import { parseDungeonRewardEligibleCharacterIdSet } from "../dungeon/shared/rewardEligibility.js";
import type { BattleResult } from "./battleTypes.js";
import {
  activeBattles,
  battleParticipants,
  finishedBattleResults,
  finishingBattleResults,
  BATTLE_START_COOLDOWN_MS,
  collectPlayerCharacterIdsFromBattleState,
  getFinishedBattleResultIfFresh,
  removeBattleCharacterIndex,
  removeBattleParticipantIndex,
  setBattleStartCooldownByCharacterIds,
} from "./runtime/state.js";
import { stopBattleTicker } from "./runtime/ticker.js";
import { removeBattleFromRedis } from "./runtime/persistence.js";
import { settleArenaBattleIfNeeded } from "./pvp.js";
import {
  canReceiveBattleSessionRealtime,
  markBattleSessionFinished,
} from "../battleSession/index.js";
import {
  buildBattleFinishedRealtimePayload,
} from "./runtime/realtime.js";
import {
  DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
  shouldApplyBattleSettlementCooldown,
  TOWER_PVE_BATTLE_START_POLICY,
} from "./shared/startPolicy.js";
import {
  applyTowerPostBattleResourceChange,
  settleTowerBattle,
} from "../tower/service.js";
import { getTowerBattleRuntime } from "../tower/runtime.js";

type ResolvedSettlementParticipants = {
  participants: BattleParticipant[];
  notificationUserIds: number[];
};

/**
 * 读取当前秘境战斗的可领奖角色集合。
 *
 * 作用：
 * - 按 battleId 在 dungeon_instance.instance_data.currentBattleId 中反查对应实例；
 * - 从实例快照中读取 rewardEligibleCharacterIds。
 *
 * 边界条件：
 * 1) 查询不到实例或名单字段缺失时，返回空集合（严格不发奖励，不回退到全员发奖）。
 * 2) 仅匹配 status='running' 的实例，避免读取历史完成实例的脏数据。
 */
const loadDungeonBattleRewardEligibleCharacterIdSet = async (battleId: string): Promise<Set<number>> => {
  const res = await query(
    `
      SELECT instance_data
      FROM dungeon_instance
      WHERE status = 'running'
        AND instance_data ->> 'currentBattleId' = $1
      LIMIT 1
    `,
    [battleId],
  );
  if (res.rows.length === 0) return new Set<number>();
  return parseDungeonRewardEligibleCharacterIdSet(res.rows[0]?.instance_data);
};

export async function getBattleMonsters(engine: BattleEngine): Promise<MonsterData[]> {
  const state = engine.getState();
  if (state.battleType !== "pve") return [];
  const towerRuntime = getTowerBattleRuntime(state.battleId);
  if (towerRuntime) {
    return towerRuntime.monsters;
  }
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

const resolveSettlementParticipants = async (
  state: BattleState,
  participantUserIds: number[],
): Promise<ResolvedSettlementParticipants> => {
  const attackerCharacterIds = [
    ...new Set(
      state.teams.attacker.units
        .filter((unit) => unit.type === "player")
        .map((unit) => Math.floor(Number(unit.sourceId)))
        .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
    ),
  ];
  const computedMap = await getCharacterComputedBatchByCharacterIds(attackerCharacterIds);
  const participants: BattleParticipant[] = [];
  const notificationUserIdSet = new Set<number>();

  for (const participantUserId of participantUserIds) {
    const normalizedUserId = Math.floor(Number(participantUserId));
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
    notificationUserIdSet.add(normalizedUserId);
  }

  for (const characterId of attackerCharacterIds) {
    const computed = computedMap.get(characterId);
    if (!computed) continue;
    participants.push({
      userId: computed.user_id,
      characterId: computed.id,
      nickname: computed.nickname,
      realm: normalizeRealmKeepingUnknown(computed.realm, computed.sub_realm),
      fuyuan: Number(computed.fuyuan ?? 1),
    });
    const normalizedUserId = Math.floor(Number(computed.user_id));
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
    notificationUserIdSet.add(normalizedUserId);
  }

  return {
    participants,
    notificationUserIds: [...notificationUserIdSet],
  };
};

async function finishBattleCore(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const state = engine.getState();
  const result = engine.getResult();
  const finalLogDelta = consumeBattleLogDelta(battleId);
  const finalLogCursor = getBattleLogCursor(battleId);

  const participantUserIds = (battleParticipants.get(battleId) || []).slice();
  const { participants, notificationUserIds } = await resolveSettlementParticipants(
    state,
    participantUserIds,
  );
  const participantCount = Math.max(1, participants.length);
  const isVictory = result.result === "attacker_win";
  const isDungeonBattle = battleId.startsWith("dungeon-battle-");
  const isTowerBattle = getTowerBattleRuntime(battleId) !== null;
  const rewardEligibleCharacterIdSet = isDungeonBattle
    ? await loadDungeonBattleRewardEligibleCharacterIdSet(battleId)
    : null;
  const rewardParticipants =
    rewardEligibleCharacterIdSet === null
      ? participants
      : participants.filter((participant) =>
        rewardEligibleCharacterIdSet.has(Math.floor(Number(participant.characterId))),
      );

  let dropResult: DistributeResult | null = null;
  let towerRewardsData: {
    exp: number;
    silver: number;
    totalExp: number;
    totalSilver: number;
    participantCount: number;
    items: Array<{
      itemDefId: string;
      name: string;
      quantity: number;
      receiverId: number;
    }>;
    perPlayerRewards: Array<{
      characterId: number;
      userId: number;
      exp: number;
      silver: number;
      items: Array<{
        itemDefId: string;
        itemName: string;
        quantity: number;
        instanceIds: number[];
      }>;
    }>;
  } | null = null;

  if (state.battleType === "pve") {
    if (isVictory) {
      if (isTowerBattle) {
        await applyTowerPostBattleResourceChange({
          battleId,
          result: result.result as "attacker_win" | "defender_win" | "draw",
        });
        towerRewardsData = await settleTowerBattle({
          battleId,
          result: result.result as "attacker_win" | "defender_win" | "draw",
          participants: rewardParticipants,
        });
      } else {
        dropResult = await battleDropService.distributeBattleRewards(
          monsters,
          rewardParticipants,
          true,
          { isDungeonBattle },
        );

        for (const participant of participants) {
          const computed = await getCharacterComputedByCharacterId(participant.characterId);
          if (!computed) continue;
          const healAmount = Math.floor(computed.max_qixue * 0.3);
          await setCharacterResourcesByCharacterId(participant.characterId, {
            qixue: Math.min(computed.max_qixue, computed.qixue + healAmount),
            lingqi: computed.lingqi,
          });
        }
      }

      try {
        const killCounts = new Map<string, number>();
        for (const m of monsters) {
          const id = String((m as unknown as Record<string, unknown>)?.id ?? "").trim();
          if (!id) continue;
          killCounts.set(id, (killCounts.get(id) ?? 0) + 1);
        }
        if (killCounts.size > 0) {
          for (const p of rewardParticipants) {
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
      if (isTowerBattle) {
        await applyTowerPostBattleResourceChange({
          battleId,
          result: result.result as "attacker_win" | "defender_win" | "draw",
        });
        await settleTowerBattle({
          battleId,
          result: result.result as "attacker_win" | "defender_win" | "draw",
          participants: rewardParticipants,
        });
      } else {
        for (const participant of participants) {
          const computed = await getCharacterComputedByCharacterId(participant.characterId);
          if (!computed) continue;
          const loss = Math.floor(computed.max_qixue * 0.1);
          await applyCharacterResourceDeltaByCharacterId(
            participant.characterId,
            { qixue: -loss },
            { minQixue: 1 },
          );
        }
      }
    } else if (isTowerBattle && result.result === "draw") {
      await settleTowerBattle({
        battleId,
        result: result.result as "attacker_win" | "defender_win" | "draw",
        participants: rewardParticipants,
      });
    }
  }

  const rewardsData = towerRewardsData ?? (
    dropResult
      ? {
          exp: dropResult.rewards.exp,
          silver: dropResult.rewards.silver,
          totalExp: dropResult.rewards.exp,
          totalSilver: dropResult.rewards.silver,
          participantCount: rewardParticipants.length,
          items: dropResult.rewards.items.map((item) => ({
            itemDefId: item.itemDefId,
            name: item.itemName,
            quantity: item.quantity,
            receiverId: item.receiverId,
          })),
          perPlayerRewards: dropResult.perPlayerRewards,
        }
      : null
  );

  // 秘境/千层塔跳过冷却：后续推进不依赖 3 秒战斗冷却，结算包也不再向客户端下发冷却元数据。
  let cooldownUntilMs: number | null = null;
  const shouldApplySettlementCooldown = isDungeonBattle
    ? shouldApplyBattleSettlementCooldown(DUNGEON_FLOW_PVE_BATTLE_START_POLICY)
    : isTowerBattle
      ? shouldApplyBattleSettlementCooldown(TOWER_PVE_BATTLE_START_POLICY)
      : true;
  if (!shouldApplySettlementCooldown) {
    cooldownUntilMs = null;
  } else {
    const participantCharacterIds = participants
      .map((entry) => Math.floor(Number(entry.characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0);
    const cooldownCharacterIds =
      participantCharacterIds.length > 0
        ? participantCharacterIds
        : collectPlayerCharacterIdsFromBattleState(state);
    cooldownUntilMs =
      setBattleStartCooldownByCharacterIds(cooldownCharacterIds);
  }

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
      logCursor: finalLogCursor,
      state,
      isTeamBattle: participantCount > 1,
      ...(!shouldApplySettlementCooldown
        ? {}
        : {
            battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
            nextBattleAvailableAt: cooldownUntilMs,
          }),
    },
  };

  const sessionSnapshot = await markBattleSessionFinished(
    battleId,
    result.result as "attacker_win" | "defender_win" | "draw",
  );
  if (sessionSnapshot) {
    battleResult.data = {
      ...battleResult.data,
      session: sessionSnapshot,
    };
  }

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

  activeBattles.delete(state.battleId);
  battleParticipants.delete(state.battleId);
  removeBattleCharacterIndex(state.battleId);
  removeBattleParticipantIndex(state.battleId);
  stopBattleTicker(state.battleId);
  finishedBattleResults.set(state.battleId, {
    result: battleResult,
    at: Date.now(),
  });
  void removeBattleFromRedis(state.battleId);

  try {
    const gameServer = getGameServer();
    const finishedRealtimePayload = buildBattleFinishedRealtimePayload({
      battleId,
      battleResult,
      session: sessionSnapshot,
      logs: finalLogDelta.logs,
      logStart: finalLogDelta.logStart,
      logDelta: finalLogDelta.logDelta,
    });
    for (const participantUserId of notificationUserIds) {
      if (!Number.isFinite(participantUserId)) continue;
      if (!canReceiveBattleSessionRealtime({
        battleId,
        userId: participantUserId,
        fallbackUserIds: notificationUserIds,
      })) {
        continue;
      }
      if (finishedRealtimePayload) {
        gameServer.emitToUser(
          participantUserId,
          "battle:update",
          finishedRealtimePayload,
        );
      }
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
