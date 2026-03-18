/**
 * PVE 战斗发起（普通 + 秘境）
 *
 * 作用：处理 PVE 战斗的完整创建流程（校验、准备、创建引擎、注册）。
 *
 * 输入/输出：
 * - startPVEBattle: (userId, monsterIds) -> BattleResult
 * - startDungeonPVEBattle: (userId, monsterDefIds, options?) -> BattleResult
 *
 * 复用点：路由层 / dungeon combat.ts 调用。
 *
 * 边界条件：
 * 1) 普通 PVE 需校验怪物是否在当前房间
 * 2) 秘境 PVE 可跳过冷却检查（skipCooldown）
 */

import {
  createPVEBattle,
  type CharacterData,
} from "../../battle/battleFactory.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import { getRoomInMap } from "../mapService.js";
import {
  getCharacterComputedByUserId,
} from "../characterComputedService.js";
import { partnerService } from "../partnerService.js";
import type { BattleResult, StartDungeonPVEBattleOptions } from "./battleTypes.js";
import {
  BATTLE_START_COOLDOWN_MS,
  buildCharacterInBattleResult,
  registerStartedBattle,
  validateBattleStartCooldown,
  buildBattleStartCooldownResult,
} from "./runtime/state.js";
import { resolveOrderedMonsters } from "./shared/monsters.js";
import { getCharacterBattleSkillData } from "./shared/skills.js";
import { attachSetBonusEffectsToCharacterData } from "./shared/effects.js";
import {
  rejectIfIdling,
  withBattleStartResources,
  syncBattleStartResourcesForUsers,
  prepareTeamBattleParticipants,
} from "./shared/preparation.js";
import { uniqueStringIds, randomIntInclusive } from "./shared/helpers.js";

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

    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(
      characterId,
      characterBase as CharacterData,
    );

    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) return selfInBattleResult;
    const selfCooldown = validateBattleStartCooldown(characterId);
    if (selfCooldown) {
      return buildBattleStartCooldownResult(
        selfCooldown,
        "battle_start_cooldown",
      );
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
    const playerSkillsPromise = getCharacterBattleSkillData(characterId);
    const preparedTeamPromise = prepareTeamBattleParticipants(
      userId,
      character.id,
      { ignoreMemberCooldown: false },
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

    const [playerSkills, preparedTeam] = await Promise.all([
      playerSkillsPromise,
      preparedTeamPromise,
    ]);
    if (!preparedTeam.success) return preparedTeam.result;
    const { validTeamMembers, participantUserIds } = preparedTeam;

    const partnerMemberPromise =
      partnerService.buildConfiguredPartnerBattleMember({
        characterId,
        userId,
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
      playerSkills,
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
        state: engine.getState(),
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

export async function startDungeonPVEBattle(
  userId: number,
  monsterDefIds: string[],
  options?: StartDungeonPVEBattleOptions,
): Promise<BattleResult> {
  try {
    const baseCharacter = await getCharacterComputedByUserId(userId);
    if (!baseCharacter) {
      return { success: false, message: "角色不存在" };
    }

    const characterId = Number(baseCharacter.id);

    const idleReject = await rejectIfIdling(characterId);
    if (idleReject) return idleReject;

    const characterWithSetBonus = await attachSetBonusEffectsToCharacterData(
      characterId,
      baseCharacter as CharacterData,
    );
    if (characterWithSetBonus.qixue <= 0) {
      return { success: false, message: "气血不足，无法战斗" };
    }
    const selfInBattleResult = buildCharacterInBattleResult(
      characterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (selfInBattleResult) return selfInBattleResult;
    if (!options?.skipCooldown) {
      const selfCooldown = validateBattleStartCooldown(characterId);
      if (selfCooldown) {
        return buildBattleStartCooldownResult(
          selfCooldown,
          "battle_start_cooldown",
        );
      }
    }
    const character = withBattleStartResources(characterWithSetBonus);

    const requestedMonsterIds = monsterDefIds.filter(
      (x) => typeof x === "string" && x.length > 0,
    );
    if (requestedMonsterIds.length === 0) {
      return { success: false, message: "请指定战斗目标" };
    }

    const [playerSkills, preparedTeam] = await Promise.all([
      getCharacterBattleSkillData(characterId),
      prepareTeamBattleParticipants(
        userId,
        character.id,
        { ignoreMemberCooldown: Boolean(options?.skipCooldown) },
      ),
    ]);
    if (!preparedTeam.success) return preparedTeam.result;
    const { validTeamMembers, participantUserIds } = preparedTeam;

    const partnerMemberPromise =
      partnerService.buildConfiguredPartnerBattleMember({
        characterId,
        userId,
        enabled: validTeamMembers.length <= 0,
      });
    await syncBattleStartResourcesForUsers(participantUserIds, {
      queryExecutor: options?.resourceSyncClient,
      context: "同步战前资源（秘境战斗）",
    });

    const playerCount = validTeamMembers.length + 1;
    const maxMonsters = Math.min(
      5,
      Math.max(1, playerCount > 1 ? playerCount : 3),
    );
    const finalMonsterIds = requestedMonsterIds.slice(0, maxMonsters);

    const monsterResolveResult = resolveOrderedMonsters(finalMonsterIds);
    if (!monsterResolveResult.success) {
      return { success: false, message: monsterResolveResult.error };
    }
    const monsters = monsterResolveResult.monsters;
    const monsterSkillsMap = monsterResolveResult.monsterSkillsMap;

    const battleId = `dungeon-battle-${userId}-${Date.now()}`;
    const partnerMember = await partnerMemberPromise;

    const battleState = createPVEBattle(
      battleId,
      character,
      playerSkills,
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
      message: "战斗开始",
      data: {
        battleId,
        state: engine.getState(),
        isTeamBattle: playerCount > 1,
        teamMemberCount: playerCount,
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起秘境战斗失败:", error);
    return { success: false, message: "发起秘境战斗失败" };
  }
}
