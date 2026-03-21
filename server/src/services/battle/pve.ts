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
  getCharacterComputedByUserId,
} from "../characterComputedService.js";
import { partnerService } from "../partnerService.js";
import { getMonthCardActiveMapByCharacterIds } from "../shared/monthCardBenefits.js";
import type { BattleResult } from "./battleTypes.js";
import {
  BATTLE_START_COOLDOWN_MS,
  buildCharacterInBattleResult,
  registerStartedBattle,
  validateBattleStartCooldown,
  buildBattleStartCooldownResult,
} from "./runtime/state.js";
import { resolveOrderedMonsters } from "./shared/monsters.js";
import { getCharacterBattleLoadoutByCharacterId } from "./shared/profileCache.js";
import {
  rejectIfIdling,
  withBattleStartResources,
  syncBattleStartResourcesForUsers,
  prepareTeamBattleParticipants,
} from "./shared/preparation.js";
import {
  DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
  PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
  shouldValidateBattleStarterCooldown,
  type PveBattleStartPolicy,
} from "./shared/startPolicy.js";
import { uniqueStringIds, randomIntInclusive } from "./shared/helpers.js";
import { buildBattleSnapshotState } from "./runtime/realtime.js";

export async function startPVEBattle(
  userId: number,
  monsterIds: string[],
): Promise<BattleResult> {
  try {
    const characterBase = await getCharacterComputedByUserId(userId);
    if (!characterBase) {
      return { success: false, message: "角色不存在" };
    }
    const characterId = Number(characterBase.id);

    const idleReject = await rejectIfIdling(characterId);
    if (idleReject) return idleReject;

    const characterBattleLoadout = await getCharacterBattleLoadoutByCharacterId(characterId);
    if (!characterBattleLoadout) {
      return { success: false, message: "角色战斗资料不存在" };
    }
    const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds([characterId]);
    const characterWithSetBonus: CharacterData = {
      ...characterBase,
      monthCardActive: monthCardActiveMap.get(characterId) ?? false,
      setBonusEffects: characterBattleLoadout.setBonusEffects,
    };

    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) return selfInBattleResult;
    if (shouldValidateBattleStarterCooldown(PLAYER_DRIVEN_PVE_BATTLE_START_POLICY)) {
      const selfCooldown = validateBattleStartCooldown(characterId);
      if (selfCooldown) {
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
      return { success: false, message: "请指定战斗目标" };
    }

    const mapId = characterBase.current_map_id || "";
    const roomId = characterBase.current_room_id || "";
    if (!mapId || !roomId) {
      return { success: false, message: "角色位置异常，无法战斗" };
    }

    const roomPromise = getRoomInMap(mapId, roomId);
    const preparedTeamPromise = prepareTeamBattleParticipants(
      userId,
      character.id,
      { startPolicy: PLAYER_DRIVEN_PVE_BATTLE_START_POLICY },
    );

    const room = await roomPromise;
    if (!room) {
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
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const preparedTeam = await preparedTeamPromise;
    if (!preparedTeam.success) return preparedTeam.result;
    const { validTeamMembers, participantUserIds } = preparedTeam;

    const partnerMemberPromise =
      partnerService.buildConfiguredPartnerBattleMember({
        characterId,
        enabled: validTeamMembers.length <= 0,
      });
    await syncBattleStartResourcesForUsers(participantUserIds, {
      context: "同步战前资源（普通战斗）",
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
        return { success: false, message: "战斗目标不在当前房间" };
      }
    }

    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      return { success: false, message: monsterResolveResult.error };
    }
    const monsters = monsterResolveResult.monsters;
    const monsterSkillsMap = monsterResolveResult.monsterSkillsMap;

    const battleId = `battle-${userId}-${Date.now()}`;

    const partnerMember = await partnerMemberPromise;

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
    console.error("发起战斗失败:", error);
    return { success: false, message: "发起战斗失败" };
  }
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
}): Promise<BattleResult> => {
  try {
    const baseCharacter = await getCharacterComputedByUserId(params.userId);
    if (!baseCharacter) {
      return { success: false, message: '角色不存在' };
    }

    const characterId = Number(baseCharacter.id);
    const idleReject = await rejectIfIdling(characterId);
    if (idleReject) return idleReject;

    const characterBattleLoadout = await getCharacterBattleLoadoutByCharacterId(characterId);
    if (!characterBattleLoadout) {
      return { success: false, message: '角色战斗资料不存在' };
    }
    const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds([characterId]);
    const characterWithSetBonus: CharacterData = {
      ...baseCharacter,
      monthCardActive: monthCardActiveMap.get(characterId) ?? false,
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
      ? prepareTeamBattleParticipants(
          params.userId,
          character.id,
          { startPolicy: params.startPolicy },
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

    const partnerMemberPromise =
      partnerService.buildConfiguredPartnerBattleMember({
        characterId,
        enabled: validTeamMembers.length <= 0,
      });
    await syncBattleStartResourcesForUsers(participantUserIds, {
      context: params.syncResourceContext,
    });

    const partnerMember = await partnerMemberPromise;
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
    registerStartedBattle(params.battleId, engine, participantUserIds);

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
    console.error(params.errorMessage, error);
    return { success: false, message: params.errorMessage };
  }
};

const startDungeonPVEBattleByPolicy = async (
  userId: number,
  monsterDefIds: string[],
  startPolicy: PveBattleStartPolicy,
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
    const battleId = `dungeon-battle-${userId}-${Date.now()}`;
    return startResolvedPVEBattleByPolicy({
      userId,
      battleId,
      monsters: monsterResolveResult.monsters,
      monsterSkillsMap: monsterResolveResult.monsterSkillsMap,
      startPolicy,
      allowTeamBattle: true,
      syncResourceContext: '同步战前资源（秘境战斗）',
      startSuccessMessage: '战斗开始',
      errorMessage: '发起秘境战斗失败',
    });
  } catch (error) {
    console.error("发起秘境战斗失败:", error);
    return { success: false, message: "发起秘境战斗失败" };
  }
};

export async function startDungeonPVEBattle(
  userId: number,
  monsterDefIds: string[],
): Promise<BattleResult> {
  return startDungeonPVEBattleByPolicy(
    userId,
    monsterDefIds,
    PLAYER_DRIVEN_PVE_BATTLE_START_POLICY,
  );
}

export async function startDungeonPVEBattleForDungeonFlow(
  userId: number,
  monsterDefIds: string[],
): Promise<BattleResult> {
  return startDungeonPVEBattleByPolicy(
    userId,
    monsterDefIds,
    DUNGEON_FLOW_PVE_BATTLE_START_POLICY,
  );
}
