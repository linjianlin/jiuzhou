/**
 * 秘境战斗（开启/推进/结算）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：管理秘境实例的开战、推进下一波与通关排队结算，整个请求期只读写在线战斗投影。
 * 2. 做什么：把人数/境界/体力/次数/可领奖资格统一收口到投影链路，避免秘境热路径再直接触库。
 * 3. 不做什么：不在这里执行真实 DB 发奖、写 dungeon_record 或写 dungeon_instance 表，这些都交给延迟结算任务。
 *
 * 输入/输出：
 * - 输入：userId、instanceId。
 * - 输出：秘境当前战斗开启结果、推进结果或通关结束结果。
 *
 * 数据流/状态流：
 * - start -> 校验投影 -> 开启 battle -> 写回 dungeon projection；
 * - next -> 读取 battle result -> 更新 dungeon projection -> 必要时排队 deferred settlement task；
 * - 最终清算 -> onlineBattleSettlementRunner 异步执行真实落库。
 *
 * 关键边界条件与坑点：
 * 1. 秘境实例缺失、投影未预热、角色快照缺失时直接失败，不允许回退 DB。
 * 2. 通关后必须先更新投影状态再排队结算任务，确保前端立刻读取到 cleared/failed 的最新状态。
 */

import type { BattleParticipant } from '../battleDropService.js';
import { getBattleState, startDungeonPVEBattleForDungeonFlow } from '../battle/index.js';
import { getGameServer } from '../../game/gameServer.js';
import {
  applyOnlineBattleCharacterStaminaDelta,
  createDeferredSettlementTask,
  type DungeonEntryCountProjectionRecord,
  getDungeonProjection,
  getOnlineBattleCharacterSnapshotsByCharacterIds,
  type OnlineBattleCharacterSnapshot,
  upsertDungeonProjection,
} from '../onlineBattleProjectionService.js';
import { applyStaminaRecoveryByCharacterIds } from '../staminaService.js';
import { runDungeonStartFlow } from './shared/startFlow.js';
import { getDungeonDifficultyById } from '../staticConfigLoader.js';
import { touchEntryCount, incEntryCount } from './shared/entryCount.js';
import {
  buildParticipantLabel,
  getParticipantNicknameMap,
  getUserAndCharacter,
} from './shared/participants.js';
import {
  DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD,
  buildDungeonRewardEligibleCharacterIds,
  selectDungeonRewardEligibleParticipants,
} from './shared/rewardEligibility.js';
import { loadDungeonBenefitPolicyMap } from './shared/benefitPolicy.js';
import { validateDungeonParticipantRealmAccess } from './shared/realmAccess.js';
import { buildMonsterDefIdsFromWave, getStageAndWave } from './shared/stageData.js';
import { asObject, asNumber, asString, countPlayerDeaths } from './shared/typeUtils.js';
import type {
  DungeonInstanceParticipant,
  DungeonInstanceStatus,
} from './types.js';
import { getDungeonDefById } from './shared/configLoader.js';
import { createScopedLogger } from '../../utils/logger.js';
import { createSlowOperationLogger } from '../../utils/slowOperationLogger.js';
import { resolveDungeonMonsterAttrMultiplier } from './shared/difficulty.js';

const dungeonCombatLogger = createScopedLogger('dungeon.combat');

type DungeonBattleRegisteredPayload = {
  battleId: string;
  participantUserIds: number[];
};

type DungeonBattleStartOptions = {
  onBattleRegistered?: (payload: DungeonBattleRegisteredPayload) => void;
};

type DungeonCombatResponse =
  | {
      success: true;
      data: {
        instanceId: string;
        status: DungeonInstanceStatus;
        battleId?: string;
        state?: unknown;
        finished?: boolean;
      };
    }
  | { success: false; message: string };

const buildDungeonFixedTeamContext = (params: {
  starterCharacterId: number;
  participants: DungeonInstanceParticipant[];
  participantSnapshots: ReadonlyMap<number, OnlineBattleCharacterSnapshot>;
}): {
  starterSnapshot: OnlineBattleCharacterSnapshot;
  participants: Array<{ userId: number; characterId: number }>;
  snapshotsByCharacterId: ReadonlyMap<number, OnlineBattleCharacterSnapshot>;
} | null => {
  const starterSnapshot = params.participantSnapshots.get(params.starterCharacterId);
  if (!starterSnapshot) {
    return null;
  }

  return {
    starterSnapshot,
    participants: params.participants.map((participant) => ({
      userId: participant.userId,
      characterId: participant.characterId,
    })),
    snapshotsByCharacterId: params.participantSnapshots,
  };
};

const buildDeferredSettlementParticipants = async (
  participants: DungeonInstanceParticipant[],
): Promise<BattleParticipant[]> => {
  const snapshots = await getOnlineBattleCharacterSnapshotsByCharacterIds(
    participants.map((participant) => participant.characterId),
  );

  const out: BattleParticipant[] = [];
  for (const participant of participants) {
    const snapshot = snapshots.get(participant.characterId);
    if (!snapshot) continue;
    out.push({
      userId: snapshot.userId,
      characterId: snapshot.characterId,
      nickname: snapshot.computed.nickname,
      realm: snapshot.computed.sub_realm
        ? `${snapshot.computed.realm}·${snapshot.computed.sub_realm}`
        : snapshot.computed.realm,
      fuyuan: Math.max(0, Number(snapshot.computed.fuyuan ?? 1)),
    });
  }
  return out;
};

/** 开启秘境战斗。 */
export const startDungeonInstance = async (
  userId: number,
  instanceId: string,
  options?: DungeonBattleStartOptions,
): Promise<
  | {
      success: true;
      data: {
        instanceId: string;
        status: DungeonInstanceStatus;
        battleId: string;
        state: unknown;
      };
    }
  | { success: false; message: string }
> => {
  const user = await getUserAndCharacter(userId);
  if (!user.ok) return { success: false, message: user.message };

  const projection = await getDungeonProjection(instanceId);
  if (!projection) {
    return { success: false, message: '秘境实例不存在' };
  }
  if (projection.status !== 'preparing') {
    return { success: false, message: '秘境已开始或已结束' };
  }
  if (projection.creatorCharacterId !== user.characterId) {
    return { success: false, message: '只有创建者可以开始秘境' };
  }

  const dungeonDef = getDungeonDefById(projection.dungeonId);
  if (!dungeonDef) {
    return { success: false, message: '秘境不存在' };
  }
  const difficultyDef = getDungeonDifficultyById(projection.difficultyId);
  if (!difficultyDef) {
    return { success: false, message: '秘境难度不存在' };
  }
  const difficultyMonsterAttrMultiplier = resolveDungeonMonsterAttrMultiplier(difficultyDef.monster_attr_mult);

  const participants = projection.participants.slice();
  const participantNicknameMap = await getParticipantNicknameMap(participants);
  if (participants.length < dungeonDef.min_players) {
    return { success: false, message: `人数不足，需要至少${dungeonDef.min_players}人` };
  }
  if (participants.length > dungeonDef.max_players) {
    return { success: false, message: `人数超限，最多${dungeonDef.max_players}人` };
  }

  const realmAccess = await validateDungeonParticipantRealmAccess({
    participants,
    dungeonMinRealm: dungeonDef.min_realm,
    difficultyMinRealm: difficultyDef.min_realm ?? null,
  });
  if (!realmAccess.success) {
    return realmAccess;
  }

  const participantCharacterIds = participants.map((participant) => participant.characterId);
  const participantBenefitPolicyMap = await loadDungeonBenefitPolicyMap(participantCharacterIds);
  await applyStaminaRecoveryByCharacterIds(participantCharacterIds);
  const participantSnapshots = await getOnlineBattleCharacterSnapshotsByCharacterIds(participantCharacterIds);

  const staminaConsumingParticipants: DungeonInstanceParticipant[] = [];
  const rewardEligibleParticipantsAtStart: DungeonInstanceParticipant[] = [];

  for (const participant of participants) {
    const benefitPolicy = participantBenefitPolicyMap.get(participant.characterId);
    const snapshot = participantSnapshots.get(participant.characterId);
    const participantLabel = buildParticipantLabel(participant, participantNicknameMap);
    if (!benefitPolicy || !snapshot) {
      return { success: false, message: `${participantLabel}在线战斗快照缺失` };
    }
    if (!benefitPolicy.skipStaminaCost) {
      staminaConsumingParticipants.push(participant);
      if (snapshot.computed.stamina < dungeonDef.stamina_cost) {
        return {
          success: false,
          message: `${participantLabel}体力不足，需要${dungeonDef.stamina_cost}，当前${snapshot.computed.stamina}`,
        };
      }
    }
    if (benefitPolicy.rewardEligible) {
      rewardEligibleParticipantsAtStart.push(participant);
    }
  }

  const rewardEligibleCharacterIds = buildDungeonRewardEligibleCharacterIds(rewardEligibleParticipantsAtStart);
  for (const participant of participants) {
    const touch = await touchEntryCount(
      participant.characterId,
      projection.dungeonId,
      dungeonDef.daily_limit,
      dungeonDef.weekly_limit,
    );
    if (!touch.ok) return { success: false, message: touch.message };
  }

  const stageWave = await getStageAndWave(projection.difficultyId, 1, 1);
  if (!stageWave.ok) {
    return { success: false, message: stageWave.message };
  }
  const monsterDefIds = buildMonsterDefIdsFromWave(stageWave.wave.monsters, 5);
  if (monsterDefIds.length <= 0) {
    return { success: false, message: '该波次未配置怪物' };
  }

  return runDungeonStartFlow({
    startBattle: () => startDungeonPVEBattleForDungeonFlow(userId, monsterDefIds, {
      onBattleRegistered: options?.onBattleRegistered,
      dungeonDifficultyMonsterAttrMultiplier: difficultyMonsterAttrMultiplier,
      fixedTeamContext: buildDungeonFixedTeamContext({
        starterCharacterId: user.characterId,
        participants,
        participantSnapshots,
      }) ?? undefined,
    }),
    commitOnBattleStarted: async ({ battleId, state }) => {
      const startTime = new Date().toISOString();
      const entryCountSnapshots: DungeonEntryCountProjectionRecord[] = [];
      for (const participant of participants) {
        entryCountSnapshots.push(
          await incEntryCount(participant.characterId, projection.dungeonId),
        );
      }
      for (const participant of staminaConsumingParticipants) {
        const nextSnapshot = await applyOnlineBattleCharacterStaminaDelta(
          participant.characterId,
          -dungeonDef.stamina_cost,
        );
        if (!nextSnapshot) {
          return { success: false, message: '体力扣除失败' };
        }
      }
      const gameServer = getGameServer();
      for (const participant of staminaConsumingParticipants) {
        void gameServer.pushCharacterUpdate(participant.userId);
      }

      await upsertDungeonProjection({
        ...projection,
        status: 'running',
        currentStage: 1,
        currentWave: 1,
        currentBattleId: battleId,
        rewardEligibleCharacterIds,
        startTime,
        endTime: null,
      });

      await createDeferredSettlementTask(
        {
          battleId,
          battleType: 'pve',
          result: 'draw',
          participants: [],
          rewardParticipants: [],
          isDungeonBattle: true,
          isTowerBattle: false,
          rewardsPreview: null,
          battleRewardPlan: null,
          monsters: [],
          arenaDelta: null,
          dungeonContext: {
            instanceId: projection.instanceId,
            dungeonId: projection.dungeonId,
            difficultyId: projection.difficultyId,
          },
          dungeonStartConsumption: {
            instanceId: projection.instanceId,
            dungeonId: projection.dungeonId,
            difficultyId: projection.difficultyId,
            creatorCharacterId: projection.creatorCharacterId,
            teamId: projection.teamId,
            currentStage: 1,
            currentWave: 1,
            participants: participants.slice(),
            currentBattleId: battleId,
            rewardEligibleCharacterIds,
            startTime,
            entryCountSnapshots,
            staminaConsumptions: staminaConsumingParticipants.map((participant) => ({
              characterId: participant.characterId,
              amount: dungeonDef.stamina_cost,
            })),
          },
          dungeonSettlement: null,
          session: null,
        },
        {
          taskId: `dungeon-start:${projection.instanceId}`,
        },
      );

      return {
        success: true,
        data: {
          instanceId,
          status: 'running' as DungeonInstanceStatus,
          battleId,
          state,
        },
      };
    },
  });
};

/** 推进秘境实例（下一波次/通关结算）。 */
export const nextDungeonInstance = async (
  userId: number,
  instanceId: string,
  options?: DungeonBattleStartOptions,
): Promise<DungeonCombatResponse> => {
  const slowLogger = createSlowOperationLogger({
    label: 'dungeon.nextDungeonInstance',
    fields: {
      userId,
      instanceId,
    },
  });
  const flushAndReturn = <T extends DungeonCombatResponse>(
    response: T,
    fields?: Record<string, boolean | number | string | null | undefined>,
  ): T => {
    slowLogger.flush({
      success: response.success,
      ...(fields ?? {}),
    });
    return response;
  };

  const user = await getUserAndCharacter(userId);
  slowLogger.mark('getUserAndCharacter', { userLoaded: user.ok });
  if (!user.ok) {
    return flushAndReturn({ success: false, message: user.message }, { reason: 'user_missing' });
  }

  const projection = await getDungeonProjection(instanceId);
  slowLogger.mark('getDungeonProjection', { projectionLoaded: Boolean(projection) });
  if (!projection) {
    return flushAndReturn({ success: false, message: '秘境实例不存在' }, { reason: 'instance_missing' });
  }
  if (projection.status !== 'running') {
    return flushAndReturn({ success: false, message: '秘境未在进行中' }, { reason: 'instance_not_running' });
  }
  if (projection.creatorCharacterId !== user.characterId) {
    return flushAndReturn({ success: false, message: '只有创建者可以推进秘境' }, { reason: 'not_creator' });
  }
  if (!projection.participants.some((participant) => participant.userId === userId)) {
    return flushAndReturn({ success: false, message: '无权访问该秘境' }, { reason: 'participant_forbidden' });
  }
  const difficultyDef = getDungeonDifficultyById(projection.difficultyId);
  if (!difficultyDef) {
    return flushAndReturn({ success: false, message: '秘境难度不存在' }, { reason: 'difficulty_missing' });
  }
  const difficultyMonsterAttrMultiplier = resolveDungeonMonsterAttrMultiplier(difficultyDef.monster_attr_mult);

  const rewardEligibleParticipants = selectDungeonRewardEligibleParticipants(
    projection.participants,
    {
      [DUNGEON_REWARD_ELIGIBLE_CHARACTER_IDS_FIELD]: projection.rewardEligibleCharacterIds,
    },
  );
  if (
    projection.participants.length > 0
    && projection.rewardEligibleCharacterIds.length > 0
    && rewardEligibleParticipants.length <= 0
  ) {
    dungeonCombatLogger.warn({
      instanceId,
      participantCount: projection.participants.length,
      rewardEligibleCharacterIdCount: projection.rewardEligibleCharacterIds.length,
    }, '实例可领奖名单为空，结算奖励将跳过');
  }

  const currentBattleId = projection.currentBattleId;
  if (!currentBattleId) {
    return flushAndReturn({ success: false, message: '当前战斗不存在' }, { reason: 'current_battle_missing' });
  }

  const battleStateRes = await getBattleState(currentBattleId);
  slowLogger.mark('getBattleState', {
    battleStateLoaded: battleStateRes.success,
    currentBattleId,
  });
  if (!battleStateRes.success) {
    return flushAndReturn(
      { success: false, message: battleStateRes.message || '获取战斗状态失败' },
      { reason: 'battle_state_failed', currentBattleId },
    );
  }

  const battleData = asObject(battleStateRes.data) ?? {};
  const result = asString(battleData.result, '');
  if (result !== 'attacker_win' && result !== 'defender_win' && result !== 'draw') {
    return flushAndReturn({ success: false, message: '战斗未结束' }, { reason: 'battle_not_finished' });
  }

  if (result !== 'attacker_win') {
    await upsertDungeonProjection({
      ...projection,
      status: 'failed',
      currentBattleId: null,
      endTime: new Date().toISOString(),
    });
    slowLogger.mark('markDungeonFailed');
    return flushAndReturn(
      { success: true, data: { instanceId, status: 'failed', finished: true } },
      { result, finished: true },
    );
  }

  const stageWave = await getStageAndWave(projection.difficultyId, projection.currentStage, projection.currentWave);
  slowLogger.mark('getStageAndWave', {
    stageLoaded: stageWave.ok,
    currentStage: projection.currentStage,
    currentWave: projection.currentWave,
  });
  if (!stageWave.ok) {
    return flushAndReturn({ success: false, message: stageWave.message }, { reason: 'stage_wave_missing' });
  }

  let nextStage = projection.currentStage;
  let nextWave = projection.currentWave + 1;
  if (nextWave > stageWave.maxWaveIndexInStage) {
    nextStage = projection.currentStage + 1;
    nextWave = 1;
  }

  if (nextStage > stageWave.stageCount) {
    const logs = battleData.logs;
    const deathCount = countPlayerDeaths(logs);
    const stats = asObject(battleData.stats) ?? {};
    const attackerStats = asObject(stats.attacker) ?? {};
    const totalDamage = Math.floor(asNumber(attackerStats.damageDealt, 0));
    const startAtMs = projection.startTime ? new Date(projection.startTime).getTime() : Date.now();
    const timeSpentSec = Math.max(0, Math.floor((Date.now() - startAtMs) / 1000));

    await upsertDungeonProjection({
      ...projection,
      status: 'cleared',
      currentBattleId: null,
      endTime: new Date().toISOString(),
    });

    await createDeferredSettlementTask(
      {
        battleId: currentBattleId,
        battleType: 'pve',
        result: 'attacker_win',
        participants: await buildDeferredSettlementParticipants(projection.participants),
        rewardParticipants: await buildDeferredSettlementParticipants(rewardEligibleParticipants),
        isDungeonBattle: true,
        isTowerBattle: false,
        rewardsPreview: null,
        battleRewardPlan: null,
        monsters: [],
        arenaDelta: null,
        dungeonContext: {
          instanceId: projection.instanceId,
          dungeonId: projection.dungeonId,
          difficultyId: projection.difficultyId,
        },
        dungeonStartConsumption: null,
        dungeonSettlement: {
          instanceId: projection.instanceId,
          dungeonId: projection.dungeonId,
          difficultyId: projection.difficultyId,
          timeSpentSec,
          totalDamage,
          deathCount,
        },
        session: null,
      },
      {
        taskId: `dungeon-clear:${projection.instanceId}`,
      },
    );

    slowLogger.mark('enqueueDungeonClearSettlement', {
      rewardParticipantCount: rewardEligibleParticipants.length,
    });
    return flushAndReturn(
      { success: true, data: { instanceId, status: 'cleared', finished: true } },
      { result, finished: true, rewardParticipantCount: rewardEligibleParticipants.length },
    );
  }

  const nextStageWave = await getStageAndWave(projection.difficultyId, nextStage, nextWave);
  slowLogger.mark('getNextStageAndWave', {
    stageLoaded: nextStageWave.ok,
    nextStage,
    nextWave,
  });
  if (!nextStageWave.ok) {
    return flushAndReturn({ success: false, message: nextStageWave.message }, { reason: 'next_stage_wave_missing' });
  }

  const monsterDefIds = buildMonsterDefIdsFromWave(nextStageWave.wave.monsters, 5);
  if (monsterDefIds.length <= 0) {
    return flushAndReturn({ success: false, message: '该波次未配置怪物' }, { reason: 'monster_wave_empty' });
  }

  const participantCharacterIds = Array.from(
    new Set(
      projection.participants.map((participant) => participant.characterId),
    ),
  );
  const participantSnapshots = await getOnlineBattleCharacterSnapshotsByCharacterIds(participantCharacterIds);
  const fixedTeamContext = buildDungeonFixedTeamContext({
    starterCharacterId: user.characterId,
    participants: projection.participants,
    participantSnapshots,
  });
  if (!fixedTeamContext) {
    return flushAndReturn(
      { success: false, message: '当前角色在线战斗快照缺失' },
      { reason: 'starter_snapshot_missing' },
    );
  }

  const response = await runDungeonStartFlow({
    startBattle: () => startDungeonPVEBattleForDungeonFlow(userId, monsterDefIds, {
      onBattleRegistered: options?.onBattleRegistered,
      dungeonDifficultyMonsterAttrMultiplier: difficultyMonsterAttrMultiplier,
      fixedTeamContext,
    }),
    commitOnBattleStarted: async ({ battleId, state }) => {
      await upsertDungeonProjection({
        ...projection,
        status: 'running',
        currentStage: nextStage,
        currentWave: nextWave,
        currentBattleId: battleId,
      });

      return {
        success: true,
        data: {
          instanceId,
          status: 'running' as DungeonInstanceStatus,
          battleId,
          state,
        },
      };
    },
  });

  slowLogger.mark('runDungeonStartFlow', {
    battleStarted: Boolean(response.success && response.data?.battleId),
    nextStage,
    nextWave,
  });
  const dungeonFlowFinished =
    response.success && 'finished' in response.data
      ? Boolean(response.data.finished)
      : false;
  return flushAndReturn(response, {
    result,
    finished: dungeonFlowFinished,
  });
};
