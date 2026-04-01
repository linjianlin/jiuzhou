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
import {
  battleDropService,
  type BattleParticipant,
  type BattleRewardSettlementPlan,
  type DistributeResult,
} from "../battleDropService.js";
import {
  buildBattleRewardsPreviewFromDistributeResult,
  buildImmediateBattleResultWithProjectionPreview,
  createDeferredSettlementTask,
  getArenaProjection,
  getDungeonProjectionByBattleId,
  getOnlineBattleCharacterSnapshotsByCharacterIds,
  getTowerProjection,
  upsertTowerProjection,
} from "../onlineBattleProjectionService.js";
import { getArenaStatus } from "../arenaService.js";
import { getGameServer } from "../../game/gameServer.js";
import { normalizeRealmKeepingUnknown } from "../shared/realmRules.js";
import { getDungeonDifficultyById, getMonsterDefinitions } from "../staticConfigLoader.js";
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
import {
  resolveArenaBattleSettlementContext,
  settleArenaBattleIfNeeded,
} from "./pvp.js";
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
  applyBattleFailureResourceLossByCharacterIds,
  restoreCharacterResourcesAfterVictoryByCharacterIds,
} from "./shared/resourceRecovery.js";
import { getTowerBattleRuntime } from "../tower/runtime.js";
import { createScopedLogger } from "../../utils/logger.js";
import { createSlowOperationLogger } from "../../utils/slowOperationLogger.js";
import {
  recordBattleOutcomeAchievements,
  type AchievementBattleParticipantSnapshot,
} from "../achievement/battleTracking.js";
import { resolveDungeonRewardMultiplier } from "../dungeon/shared/difficulty.js";

const battleSettlementLogger = createScopedLogger("battle.settlement");

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
  const projection = await getDungeonProjectionByBattleId(battleId);
  if (!projection) return new Set<number>();
  return new Set<number>(projection.rewardEligibleCharacterIds);
};

const applyImmediateTowerProjectionResult = async (
  battleId: string,
  result: "attacker_win" | "defender_win" | "draw",
): Promise<void> => {
  const runtime = getTowerBattleRuntime(battleId);
  if (!runtime) return;
  const projection = await getTowerProjection(runtime.characterId);
  if (!projection) return;

  if (result === "attacker_win") {
    await upsertTowerProjection({
      ...projection,
      bestFloor: Math.max(projection.bestFloor, runtime.floor),
      nextFloor: Math.max(projection.nextFloor, runtime.floor + 1),
      currentRunId: projection.currentRunId ?? runtime.runId,
      currentFloor: runtime.floor,
      currentBattleId: null,
      lastSettledFloor: runtime.floor,
      updatedAt: new Date().toISOString(),
      reachedAt:
        runtime.floor > projection.bestFloor
          ? new Date().toISOString()
          : projection.reachedAt,
    });
    return;
  }

  await upsertTowerProjection({
    ...projection,
    currentRunId: null,
    currentFloor: null,
    currentBattleId: null,
    updatedAt: new Date().toISOString(),
  });
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
  const computedMap = await getOnlineBattleCharacterSnapshotsByCharacterIds(attackerCharacterIds);
  const participants: BattleParticipant[] = [];
  const notificationUserIdSet = new Set<number>();

  for (const participantUserId of participantUserIds) {
    const normalizedUserId = Math.floor(Number(participantUserId));
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
    notificationUserIdSet.add(normalizedUserId);
  }

  for (const characterId of attackerCharacterIds) {
    const snapshot = computedMap.get(characterId);
    if (!snapshot) continue;
    participants.push({
      userId: snapshot.userId,
      characterId: snapshot.characterId,
      nickname: snapshot.computed.nickname,
      realm: normalizeRealmKeepingUnknown(snapshot.computed.realm, snapshot.computed.sub_realm),
      fuyuan: Number(snapshot.computed.fuyuan ?? 1),
    });
    const normalizedUserId = Math.floor(Number(snapshot.userId));
    if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) continue;
    notificationUserIdSet.add(normalizedUserId);
  }

  return {
    participants,
    notificationUserIds: [...notificationUserIdSet],
  };
};

const buildBattleAchievementParticipants = (
  state: BattleState,
): AchievementBattleParticipantSnapshot[] => {
  const snapshots: AchievementBattleParticipantSnapshot[] = [];

  for (const unit of state.teams.attacker.units) {
    if (unit.type !== 'player') continue;

    const characterId = Math.floor(Number(unit.sourceId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;

    snapshots.push({
      characterId,
      finalQixue: Math.max(0, Math.floor(unit.qixue)),
      finalMaxQixue: Math.max(1, Math.floor(unit.currentAttrs.max_qixue)),
    });
  }

  return snapshots;
};

async function finishBattleCore(
  battleId: string,
  engine: BattleEngine,
  monsters: MonsterData[],
): Promise<BattleResult> {
  const slowLogger = createSlowOperationLogger({
    label: "battle.finishBattle",
    fields: {
      battleId,
      monsterCount: monsters.length,
    },
  });
  const state = engine.getState();
  const result = engine.getResult();
  const finalLogDelta = consumeBattleLogDelta(battleId);
  const finalLogCursor = getBattleLogCursor(battleId);

  const participantUserIds = (battleParticipants.get(battleId) || []).slice();
  const { participants, notificationUserIds } = await resolveSettlementParticipants(
    state,
    participantUserIds,
  );
  const battleAchievementParticipants = buildBattleAchievementParticipants(state);
  slowLogger.mark("resolveSettlementParticipants", {
    participantCount: participants.length,
    notificationUserCount: notificationUserIds.length,
  });
  const participantCount = Math.max(1, participants.length);
  const isVictory = result.result === "attacker_win";
  const isDungeonBattle = battleId.startsWith("dungeon-battle-");
  const isTowerBattle = getTowerBattleRuntime(battleId) !== null;
  const dungeonProjection = isDungeonBattle
    ? await getDungeonProjectionByBattleId(battleId)
    : null;
  const dungeonRewardMultiplier = dungeonProjection
    ? resolveDungeonRewardMultiplier(getDungeonDifficultyById(dungeonProjection.difficultyId)?.reward_mult)
    : 1;
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
  let battleRewardPlan: BattleRewardSettlementPlan | null = null;
  let rewardsPreviewData: {
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
  let arenaDeltaForTask: {
    challengerCharacterId: number;
    opponentCharacterId: number;
    challengerScoreAfter: number;
    challengerScoreDelta: number;
    challengerOutcome: 'win' | 'lose' | 'draw';
  } | null = null;

  if (state.battleType === "pve") {
    if (isVictory) {
      if (isTowerBattle) {
        await applyImmediateTowerProjectionResult(
          battleId,
          result.result as "attacker_win" | "defender_win" | "draw",
        );
      }
      if (!isTowerBattle) {
        battleRewardPlan = await battleDropService.planBattleRewards(
          monsters,
          rewardParticipants,
          true,
          { isDungeonBattle, dungeonRewardMultiplier },
        );
        dropResult = battleDropService.previewBattleRewardPlan(battleRewardPlan);
        slowLogger.mark("distributeBattleRewards", {
          rewardParticipantCount: rewardParticipants.length,
        });

        rewardsPreviewData = buildBattleRewardsPreviewFromDistributeResult(dropResult);
        await restoreCharacterResourcesAfterVictoryByCharacterIds(
          participants.map((participant) => participant.characterId),
        );
        slowLogger.mark("restoreCharacterResourcesAfterVictory");
      }
    } else if (result.result === "defender_win") {
      if (isTowerBattle) {
        await applyImmediateTowerProjectionResult(
          battleId,
          result.result as "attacker_win" | "defender_win" | "draw",
        );
      }
      if (!isTowerBattle) {
        await applyBattleFailureResourceLossByCharacterIds(
          participants.map((participant) => participant.characterId),
        );
        slowLogger.mark("applyFailureResourceLoss");
      }
    }
  }

  const rewardsData = rewardsPreviewData ?? null;

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
  slowLogger.mark("markBattleSessionFinished");
  if (sessionSnapshot) {
    battleResult.data = {
      ...battleResult.data,
      session: sessionSnapshot,
    };
  }
  const arenaSettlementContext = resolveArenaBattleSettlementContext({
    state,
    session: sessionSnapshot,
  });

  try {
    if (battleAchievementParticipants.length > 0) {
      await recordBattleOutcomeAchievements(
        battleId,
        result.result as "attacker_win" | "defender_win" | "draw",
        battleAchievementParticipants,
      );
      slowLogger.mark("recordBattleOutcomeAchievements", {
        trackedCharacterCount: battleAchievementParticipants.length,
      });
    }

    if (arenaSettlementContext) {
      const beforeProjection = await getArenaProjection(
        arenaSettlementContext.challengerCharacterId,
      );
      await settleArenaBattleIfNeeded(
        {
          battleId,
          battleResult: result.result as "attacker_win" | "defender_win" | "draw",
          challengerCharacterId: arenaSettlementContext.challengerCharacterId,
          opponentCharacterId: arenaSettlementContext.opponentCharacterId,
        },
      );
      const afterProjection = await getArenaProjection(
        arenaSettlementContext.challengerCharacterId,
      );
      if (beforeProjection && afterProjection) {
        arenaDeltaForTask = {
          challengerCharacterId: arenaSettlementContext.challengerCharacterId,
          opponentCharacterId: arenaSettlementContext.opponentCharacterId,
          challengerScoreAfter: afterProjection.score,
          challengerScoreDelta: afterProjection.score - beforeProjection.score,
          challengerOutcome:
            result.result === 'attacker_win'
              ? 'win'
              : result.result === 'defender_win'
                ? 'lose'
                : 'draw',
        };
      }
      slowLogger.mark("settleArenaBattleIfNeeded");
    }
  } catch (error) {
    battleSettlementLogger.warn({
      battleId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "竞技场战斗结算失败");
  }

  await createDeferredSettlementTask({
    battleId,
    battleType: state.battleType,
    result: result.result as "attacker_win" | "defender_win" | "draw",
    participants,
    rewardParticipants,
    isDungeonBattle,
    isTowerBattle,
    rewardsPreview: rewardsData,
    battleRewardPlan,
    monsters: monsters.map((monster) => ({
      id: monster.id,
      name: monster.name,
      realm: monster.realm ?? null,
      expReward: monster.exp_reward,
      silverRewardMin: monster.silver_reward_min,
      silverRewardMax: monster.silver_reward_max,
      dropPoolId: monster.drop_pool_id ?? null,
      kind: monster.kind ?? null,
    })),
    arenaDelta: arenaDeltaForTask,
    dungeonContext: dungeonProjection
      ? {
          instanceId: dungeonProjection.instanceId,
          dungeonId: dungeonProjection.dungeonId,
          difficultyId: dungeonProjection.difficultyId,
        }
      : null,
    dungeonStartConsumption: null,
    dungeonSettlement: null,
    session: sessionSnapshot
      ? {
          ...sessionSnapshot,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
      : null,
  });
  const immediateBattleResult = buildImmediateBattleResultWithProjectionPreview(
    battleResult,
    rewardsData,
  );
  battleResult.data = immediateBattleResult.data;

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
    if (arenaSettlementContext) {
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
    slowLogger.mark("emitFinishedRealtime");
  } catch (error) {
    battleSettlementLogger.warn({
      battleId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "推送战斗结束事件失败");
  }

  slowLogger.flush({
    result: result.result,
    notificationUserCount: notificationUserIds.length,
  });

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
