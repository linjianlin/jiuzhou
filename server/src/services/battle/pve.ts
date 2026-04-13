/**
 * PVE 战斗发起（普通 + 秘境）
 *
 * 作用：处理 PVE 战斗的完整创建流程（校验、准备、创建引擎、注册）。
 *
 * 输入/输出：
 * - startPVEBattle: (userId, monsterIds) -> BattleResult
 * - startDungeonPVEBattle: (userId, monsterDefIds) -> BattleResult
 *
 * 复用点：路由层 / dungeon combat.ts 调用。
 *
 * 边界条件：
 * 1) 普通 PVE 需校验怪物是否在当前房间
 * 2) 秘境推进允许由服务端内部入口跳过发起者冷却，但该能力不对外暴露参数
 */

import {
  createPVEBattle,
  type CharacterData,
  type MonsterData,
  type SkillData,
} from "../../battle/battleFactory.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import { getRoomInMap } from "../mapService.js";
import {
  getOnlineBattleCharacterSnapshotByUserId,
} from "../onlineBattleProjectionService.js";
import type { BattleResult } from "./battleTypes.js";
import {
  BATTLE_START_COOLDOWN_MS,
  buildCharacterInBattleResult,
  registerStartedBattle,
  validateBattleStartCooldown,
  buildBattleStartCooldownResult,
} from "./runtime/state.js";
import { resolveOrderedMonsters } from "./shared/monsters.js";
import {
  rejectIfIdling,
  withBattleStartResources,
  scheduleBattleStartResourcesSyncForUsers,
  prepareFixedTeamBattleParticipants,
  prepareTeamBattleParticipants,
  type FixedBattleParticipant,
} from "./shared/preparation.js";
import {
  DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
  PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
  SESSION_FLOW_PVE_BATTLE_START_POLICY,
  shouldValidateBattleStarterCooldown,
  type PveBattleStartPolicy,
} from "./shared/startPolicy.js";
import { applyDungeonDifficultyToMonsters } from "../dungeon/shared/difficulty.js";
import { uniqueStringIds, randomIntInclusive } from "./shared/helpers.js";
import { buildBattleSnapshotState } from "./runtime/realtime.js";
import { createScopedLogger } from "../../utils/logger.js";
import { createSlowOperationLogger } from "../../utils/slowOperationLogger.js";
import type { OnlineBattleCharacterSnapshot } from "../onlineBattleProjectionService.js";

const battlePveLogger = createScopedLogger("battle.pve");

export type PveBattleRegisteredPayload = {
  battleId: string;
  participantUserIds: number[];
};

export type StartPVEBattleOptions = {
  onBattleRegistered?: (payload: PveBattleRegisteredPayload) => void;
  deferBattleActivation?: boolean;
  dungeonDifficultyMonsterAttrMultiplier?: number;
  fixedTeamContext?: {
    starterSnapshot: OnlineBattleCharacterSnapshot;
    participants: FixedBattleParticipant[];
    snapshotsByCharacterId: ReadonlyMap<number, OnlineBattleCharacterSnapshot>;
  };
};

const startPVEBattleByPolicy = async (
  userId: number,
  monsterIds: string[],
  startPolicy: PveBattleStartPolicy,
  options?: StartPVEBattleOptions,
): Promise<BattleResult> => {
  const slowLogger = createSlowOperationLogger({
    label: "battle.startPVEBattle",
    fields: {
      userId,
      requestedMonsterCount: monsterIds.length,
    },
  });

  try {
    const characterSnapshot = await getOnlineBattleCharacterSnapshotByUserId(userId);
    slowLogger.mark("getCharacterComputedByUserId", {
      characterLoaded: Boolean(characterSnapshot),
    });
    if (!characterSnapshot) {
      slowLogger.flush({
        success: false,
        reason: "character_missing",
      });
      return { success: false, message: "角色不存在" };
    }
    const characterBase = characterSnapshot.computed;
    const characterId = Number(characterBase.id);

    const idleReject = await rejectIfIdling(characterId);
    slowLogger.mark("rejectIfIdling", {
      idleBlocked: Boolean(idleReject),
    });
    if (idleReject) {
      slowLogger.flush({
        success: false,
        reason: "idle_blocked",
      });
      return idleReject;
    }

    const characterBattleLoadout = characterSnapshot.loadout;
    slowLogger.mark("getCharacterBattleLoadoutByCharacterId", {
      loadoutLoaded: Boolean(characterBattleLoadout),
    });
    if (!characterBattleLoadout) {
      slowLogger.flush({
        success: false,
        reason: "battle_loadout_missing",
      });
      return { success: false, message: "角色战斗资料不存在" };
    }
    const characterWithSetBonus: CharacterData = {
      ...characterBase,
      setBonusEffects: characterBattleLoadout.setBonusEffects,
    };

    if (characterWithSetBonus.qixue <= 0) {
      slowLogger.flush({
        success: false,
        reason: "qixue_empty",
      });
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) {
      slowLogger.flush({
        success: false,
        reason: "already_in_battle",
      });
      return selfInBattleResult;
    }
    if (shouldValidateBattleStarterCooldown(startPolicy)) {
      const selfCooldown = validateBattleStartCooldown(characterId);
      if (selfCooldown) {
        slowLogger.flush({
          success: false,
          reason: "battle_start_cooldown",
        });
        return buildBattleStartCooldownResult(
          selfCooldown,
          "battle_start_cooldown",
        );
      }
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterIds.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    const selectedMonsterId = requestedMonsterIds[0];
    if (!selectedMonsterId) {
      slowLogger.flush({
        success: false,
        reason: "monster_missing",
      });
      return { success: false, message: "请指定战斗目标" };
    }

    const mapId = characterBase.current_map_id || "";
    const roomId = characterBase.current_room_id || "";
    if (!mapId || !roomId) {
      slowLogger.flush({
        success: false,
        reason: "position_invalid",
      });
      return { success: false, message: "角色位置异常，无法战斗" };
    }

    const roomPromise = getRoomInMap(mapId, roomId);
    const preparedTeamPromise = prepareTeamBattleParticipants(
      userId,
      character.id,
      { startPolicy },
    );

    const room = await roomPromise;
    slowLogger.mark("getRoomInMap", {
      roomLoaded: Boolean(room),
    });
    if (!room) {
      slowLogger.flush({
        success: false,
        reason: "room_missing",
      });
      return { success: false, message: "当前房间不存在，无法战斗" };
    }

    const roomMonsterIds = uniqueStringIds(
      (Array.isArray(room.monsters) ? room.monsters : [])
        .map((m) => m?.monster_def_id)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    );
    const roomMonsterIdSet = new Set(roomMonsterIds);

    for (const id of requestedMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        slowLogger.flush({
          success: false,
          reason: "monster_not_in_room",
        });
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const preparedTeam = await preparedTeamPromise;
    slowLogger.mark("prepareTeamBattleParticipants", {
      teamPrepared: preparedTeam.success,
    });
    if (!preparedTeam.success) {
      slowLogger.flush({
        success: false,
        reason: "team_prepare_failed",
      });
      return preparedTeam.result;
    }
    const { validTeamMembers, participantUserIds } = preparedTeam;
    const partnerMember = characterSnapshot.activePartner ?? null;
    scheduleBattleStartResourcesSyncForUsers(participantUserIds, {
      context: "同步战前资源（普通战斗）",
    });
    slowLogger.mark("syncBattleStartResourcesForUsers", {
      participantUserCount: participantUserIds.length,
    });

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = playerCount > 1 ? Math.min(playerCount, 5) : 2;

    let finalMonsterIds: string[] = [];
    if (playerCount <= 1) {
      const desired = randomIntInclusive(1, 2);
      finalMonsterIds = Array.from(
        { length: desired },
        () => selectedMonsterId,
      );
    } else {
      finalMonsterIds = Array.from(
        { length: maxMonsters },
        () => selectedMonsterId,
      );
    }

    for (const id of finalMonsterIds) {
      if (!roomMonsterIdSet.has(id)) {
        slowLogger.flush({
          success: false,
          reason: "resolved_monster_not_in_room",
        });
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      slowLogger.flush({
        success: false,
        reason: "resolve_monsters_failed",
      });
      return { success: false, message: monsterResolveResult.error };
    }
    const monsters = monsterResolveResult.monsters;
    const monsterSkillsMap = monsterResolveResult.monsterSkillsMap;

    const battleId = `battle-${userId}-${Date.now()}`;
    slowLogger.mark("buildConfiguredPartnerBattleMember");

    const battleState = createPVEBattle(
      battleId,
      character,
      characterBattleLoadout.skills,
      monsters,
      monsterSkillsMap,
      {
        teamMembers: validTeamMembers.length > 0 ? validTeamMembers : undefined,
        partnerMember: partnerMember ?? undefined,
      },
    );

    const engine = new BattleEngine(battleState);
    registerStartedBattle(battleId, engine, participantUserIds);
    options?.onBattleRegistered?.({
      battleId,
      participantUserIds: participantUserIds.slice(),
    });
    slowLogger.mark("registerStartedBattle", {
      battleId,
      participantUserCount: participantUserIds.length,
    });
    slowLogger.flush({
      success: true,
      battleId,
    });

    return {
      success: true,
      message:
        playerCount > 1 ? `组队战斗开始（${playerCount}人）` : "战斗开始",
      data: {
        battleId,
        state: buildBattleSnapshotState(engine.getState()),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    slowLogger.flush({
      success: false,
      reason: "exception",
    });
    battlePveLogger.error({
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "发起战斗失败");
    return { success: false, message: "发起战斗失败" };
  }
};

export async function startPVEBattle(
  userId: number,
  monsterIds: string[],
  options?: StartPVEBattleOptions,
): Promise<BattleResult> {
  return startPVEBattleByPolicy(
    userId,
    monsterIds,
    PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
    options,
  );
}

export async function startPVEBattleForSessionFlow(
  userId: number,
  monsterIds: string[],
  options?: StartPVEBattleOptions,
): Promise<BattleResult> {
  return startPVEBattleByPolicy(
    userId,
    monsterIds,
    SESSION_FLOW_PVE_BATTLE_START_POLICY,
    options,
  );
}

/**
 * 用已解析好的怪物数据发起 PVE 战斗。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“角色校验 -> 战前资源同步 -> 创建 PVE battle”这段通用链路抽出来，给秘境与千层塔共用。
 * 2. 做什么：允许调用方传入已经生成好的怪物数据，从而支持算法生成型玩法，而不要求怪物必须直接来自房间/静态配置 ID 列表。
 * 3. 不做什么：不负责房间目标校验，也不负责怪物选择算法；这些由调用方先处理。
 *
 * 输入/输出：
 * - 输入：userId、battleId、怪物列表、开始策略与模式开关。
 * - 输出：标准 BattleResult，成功时携带 battleId 与初始 state。
 *
 * 数据流/状态流：
 * - tower/dungeon 先准备 monsters -> 本函数复用统一起战流程 -> 注册 active battle。
 *
 * 关键边界条件与坑点：
 * 1. 关闭组队后仍会保留伙伴逻辑，但不会读取队伍成员，保证单人玩法不会被队伍状态混入。
 * 2. 这里假设 `monsters` 已是最终强度版本，因此不会再次做怪物选择或额外裁剪。
 */
export const startResolvedPVEBattleByPolicy = async (params: {
  userId: number;
  battleId: string;
  monsters: MonsterData[];
  monsterSkillsMap: Record<string, SkillData[]>;
  startPolicy: PveBattleStartPolicy;
  allowTeamBattle: boolean;
  syncResourceContext: string;
  startSuccessMessage: string;
  errorMessage: string;
  onBattleRegistered?: (payload: PveBattleRegisteredPayload) => void;
  deferBattleActivation?: boolean;
  fixedTeamContext?: StartPVEBattleOptions['fixedTeamContext'];
}): Promise<BattleResult> => {
  try {
    const baseCharacterSnapshot = params.fixedTeamContext?.starterSnapshot
      ?? await getOnlineBattleCharacterSnapshotByUserId(params.userId);
    if (!baseCharacterSnapshot) {
      return { success: false, message: '角色不存在' };
    }
    const baseCharacter = baseCharacterSnapshot.computed;

    const characterId = Number(baseCharacter.id);
    if (!params.fixedTeamContext) {
      const idleReject = await rejectIfIdling(characterId);
      if (idleReject) return idleReject;
    }

    const characterBattleLoadout = baseCharacterSnapshot.loadout;
    if (!characterBattleLoadout) {
      return { success: false, message: '角色战斗资料不存在' };
    }
    const characterWithSetBonus: CharacterData = {
      ...baseCharacter,
      setBonusEffects: characterBattleLoadout.setBonusEffects,
    };
    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: '气血不足，无法战斗' };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      'character_in_battle',
      '角色正在战斗中',
    );
    if (selfInBattleResult) return selfInBattleResult;
    if (shouldValidateBattleStarterCooldown(params.startPolicy)) {
      const selfCooldown = validateBattleStartCooldown(characterId);
      if (selfCooldown) {
        return buildBattleStartCooldownResult(
          selfCooldown,
          'battle_start_cooldown',
        );
      }
    }
    if (params.monsters.length <= 0) {
      return { success: false, message: '请指定战斗目标' };
    }

    const character = withBattleStartResources(characterWithSetBonus);

    const validTeamMembersPromise = params.allowTeamBattle
      ? (
        params.fixedTeamContext
          ? Promise.resolve(prepareFixedTeamBattleParticipants({
              selfCharacterId: character.id,
              participants: params.fixedTeamContext.participants,
              snapshotsByCharacterId: params.fixedTeamContext.snapshotsByCharacterId,
            }))
          : prepareTeamBattleParticipants(
              params.userId,
              character.id,
              { startPolicy: params.startPolicy },
            )
      )
      : Promise.resolve({
          success: true as const,
          validTeamMembers: [],
          participantUserIds: [params.userId],
          result: { success: true, message: 'ok' } as BattleResult,
        });

    const preparedTeam = await validTeamMembersPromise;
    if (!preparedTeam.success) return preparedTeam.result;
    const { validTeamMembers, participantUserIds } = preparedTeam;
    const partnerMember = baseCharacterSnapshot.activePartner ?? null;
    scheduleBattleStartResourcesSyncForUsers(participantUserIds, {
      context: params.syncResourceContext,
    });
    const playerCount = validTeamMembers.length + 1;

    const battleState = createPVEBattle(
      params.battleId,
      character,
      characterBattleLoadout.skills,
      params.monsters,
      params.monsterSkillsMap,
      {
        teamMembers: validTeamMembers.length > 0 ? validTeamMembers : undefined,
        partnerMember: partnerMember ?? undefined,
      },
    );

    const engine = new BattleEngine(battleState);
    registerStartedBattle(params.battleId, engine, participantUserIds, {
      autoActivateRuntime: params.deferBattleActivation !== true,
    });
    params.onBattleRegistered?.({
      battleId: params.battleId,
      participantUserIds: participantUserIds.slice(),
    });

    return {
      success: true,
      message: params.startSuccessMessage,
      data: {
        battleId: params.battleId,
        state: buildBattleSnapshotState(engine.getState()),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    battlePveLogger.error({
      battleId: params.battleId,
      userId: params.userId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, params.errorMessage);
    return { success: false, message: params.errorMessage };
  }
};

const startDungeonPVEBattleByPolicy = async (
  userId: number,
  monsterDefIds: string[],
  startPolicy: PveBattleStartPolicy,
  options?: StartPVEBattleOptions,
): Promise<BattleResult> => {
  try {
    const requestedMonsterIds = monsterDefIds.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    if (requestedMonsterIds.length === 0) {
      return { success: false, message: "请指定战斗目标" };
    }
    const maxMonsters = Math.min(5, Math.max(1, requestedMonsterIds.length));
    const finalMonsterIds = requestedMonsterIds.slice(0, maxMonsters);
    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      return { success: false, message: monsterResolveResult.error };
    }
    const scaledMonsters = applyDungeonDifficultyToMonsters(
      monsterResolveResult.monsters,
      options?.dungeonDifficultyMonsterAttrMultiplier,
    );
    const battleId = `dungeon-battle-${userId}-${Date.now()}`;
    return startResolvedPVEBattleByPolicy({
      userId,
      battleId,
      monsters: scaledMonsters,
      monsterSkillsMap: monsterResolveResult.monsterSkillsMap,
      startPolicy,
      allowTeamBattle: true,
      syncResourceContext: '同步战前资源（秘境战斗）',
      startSuccessMessage: '战斗开始',
      errorMessage: '发起秘境战斗失败',
      onBattleRegistered: options?.onBattleRegistered,
      deferBattleActivation: options?.deferBattleActivation,
      fixedTeamContext: options?.fixedTeamContext,
    });
  } catch (error) {
    battlePveLogger.error({
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    }, "发起秘境战斗失败");
    return { success: false, message: "发起秘境战斗失败" };
  }
};

export async function startDungeonPVEBattle(
  userId: number,
  monsterDefIds: string[],
  options?: StartPVEBattleOptions,
): Promise<BattleResult> {
  return startDungeonPVEBattleByPolicy(
    userId,
    monsterDefIds,
    PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
    options,
  );
}

export async function startDungeonPVEBattleForDungeonFlow(
  userId: number,
  monsterDefIds: string[],
  options?: StartPVEBattleOptions,
): Promise<BattleResult> {
  return startDungeonPVEBattleByPolicy(
    userId,
    monsterDefIds,
    DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
    {
      ...options,
      deferBattleActivation: true,
    },
  );
}
