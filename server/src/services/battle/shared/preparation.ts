/**
 * 战斗准备阶段通用逻辑
 *
 * 作用：
 * - 挂机状态检查（rejectIfIdling）
 * - 队伍成员数据查询（getTeamMembersData）
 * - 组队参战资格校验（prepareTeamBattleParticipants）
 * - 战前资源同步（syncBattleStartResourcesForUsers / restoreBattleStartResourcesInDb）
 * - 战前临时属性闭包（withBattleStartResources）
 *
 * 不做什么：不创建战斗、不操作 Redis、不推送前端。
 *
 * 复用点：
 * - pve.ts / pvp.ts 中 startXxxBattle 调用上述函数
 *
 * 边界条件：
 * 1) getTeamMembersData 返回的 members 不含自己（排除 characterId）
 * 2) prepareTeamBattleParticipants 中跳过"正在战斗/冷却/气血为0"的队友
 */

import { query } from "../../../config/database.js";
import type { CharacterData, SkillData } from "../../../battle/battleFactory.js";
import type { PoolClient } from "pg";
import { getGameServer } from "../../../game/gameServer.js";
import {
  getCharacterComputedByCharacterId,
  recoverBattleStartResourcesByUserIds,
} from "../../characterComputedService.js";
import { idleSessionService } from "../../idle/idleSessionService.js";
import type { BattleResult } from "../battleTypes.js";
import { isCharacterInBattle } from "../runtime/state.js";
import { getBattleStartCooldownRemainingMs } from "../runtime/state.js";
import { attachSetBonusEffectsToCharacterData } from "./effects.js";
import { getCharacterBattleSkillData } from "./skills.js";

// ------ 类型 ------

type QueryExecutor = Pick<PoolClient, "query">;

export type TeamBattleMember = { data: CharacterData; skills: SkillData[] };

export type TeamBattlePreparationResult =
  | {
      success: true;
      validTeamMembers: TeamBattleMember[];
      participantUserIds: number[];
    }
  | { success: false; result: BattleResult };

export type TeamBattlePreparationOptions = {
  ignoreMemberCooldown: boolean;
};

type SyncBattleStartResourcesOptions = {
  queryExecutor?: QueryExecutor;
  context: string;
};

// ------ 挂机检查 ------

/**
 * 挂机中检查 -- 若角色有活跃挂机会话则拒绝发起战斗
 *
 * 返回：null 表示未挂机，可继续；非 null 为拒绝结果，直接 return 即可。
 */
export async function rejectIfIdling(
  characterId: number,
): Promise<BattleResult | null> {
  const idleSession =
    await idleSessionService.getActiveIdleSession(characterId);
  if (idleSession) {
    return { success: false, message: "离线挂机中，无法发起战斗" };
  }
  return null;
}

// ------ 战前资源 ------

export function withBattleStartResources<
  T extends {
    qixue?: number;
    max_qixue?: number;
    lingqi?: number;
    max_lingqi?: number;
  },
>(data: T): T {
  const maxQixue = Number(data.max_qixue ?? 0);
  const maxLingqi = Number(data.max_lingqi ?? 0);
  const currentLingqiRaw = Number(data.lingqi ?? 0);
  const currentLingqi = Number.isFinite(currentLingqiRaw)
    ? currentLingqiRaw
    : 0;
  const targetLingqi =
    maxLingqi > 0 ? Math.max(0, Math.floor(maxLingqi * 0.5)) : currentLingqi;
  return {
    ...data,
    qixue: maxQixue > 0 ? maxQixue : Number(data.qixue ?? 0),
    lingqi: currentLingqi < targetLingqi ? targetLingqi : currentLingqi,
  };
}

export async function restoreBattleStartResourcesInDb(
  userIds: number[],
  queryExecutor?: QueryExecutor,
): Promise<void> {
  void queryExecutor;
  await recoverBattleStartResourcesByUserIds(userIds);
}

export async function syncBattleStartResourcesForUsers(
  userIds: number[],
  options: SyncBattleStartResourcesOptions,
): Promise<void> {
  try {
    await restoreBattleStartResourcesInDb(userIds, options.queryExecutor);
    const gameServer = getGameServer();
    for (const userId of userIds) {
      if (!Number.isFinite(userId) || userId <= 0) continue;
      void gameServer.pushCharacterUpdate(userId);
    }
  } catch (error) {
    console.warn(`[battle] ${options.context}失败:`, error);
  }
}

// ------ 队伍成员数据 ------

export async function getTeamMembersData(
  userId: number,
  characterId: number,
): Promise<{
  isInTeam: boolean;
  isLeader: boolean;
  teamId: string | null;
  members: Array<{ data: CharacterData; skills: SkillData[] }>;
}> {
  const memberResult = await query(
    `SELECT tm.team_id, tm.role FROM team_members tm
     JOIN characters c ON tm.character_id = c.id
     WHERE c.user_id = $1`,
    [userId],
  );

  if (memberResult.rows.length === 0) {
    return { isInTeam: false, isLeader: false, teamId: null, members: [] };
  }

  const { team_id: teamId, role } = memberResult.rows[0];
  const isLeader = role === "leader";

  const teamMembersResult = await query(
    `SELECT tm.character_id FROM team_members tm
     WHERE tm.team_id = $1 AND tm.character_id != $2
     ORDER BY tm.role DESC, tm.joined_at ASC`,
    [teamId, characterId],
  );

  const members = await Promise.all(
    teamMembersResult.rows.map(async (row) => {
      const memberCharacterId = Number((row as Record<string, unknown>)?.character_id);
      if (!Number.isFinite(memberCharacterId) || memberCharacterId <= 0) {
        return null;
      }
      const base = await getCharacterComputedByCharacterId(memberCharacterId);
      if (!base) return null;
      const data = await attachSetBonusEffectsToCharacterData(
        memberCharacterId,
        base as CharacterData,
      );
      const skills = await getCharacterBattleSkillData(memberCharacterId);
      return { data, skills };
    }),
  );

  return {
    isInTeam: true,
    isLeader,
    teamId,
    members: members.filter(
      (x): x is { data: CharacterData; skills: SkillData[] } => x !== null,
    ),
  };
}

// ------ 组队参战校验 ------

export async function prepareTeamBattleParticipants(
  userId: number,
  selfCharacterId: number,
  options: TeamBattlePreparationOptions,
): Promise<TeamBattlePreparationResult> {
  const teamInfo = await getTeamMembersData(userId, selfCharacterId);
  if (teamInfo.isInTeam && !teamInfo.isLeader) {
    return {
      success: false,
      result: { success: false, message: "组队中只有队长可以发起战斗" },
    };
  }

  const validTeamMembers: TeamBattleMember[] = [];
  const participantUserIds: number[] = [userId];

  if (!teamInfo.isInTeam || teamInfo.members.length === 0) {
    return { success: true, validTeamMembers, participantUserIds };
  }

  for (const member of teamInfo.members) {
    const memberCharacterId = Number((member.data as unknown as Record<string, unknown>)?.id);
    if (
      Number.isFinite(memberCharacterId) &&
      memberCharacterId > 0 &&
      isCharacterInBattle(memberCharacterId)
    ) {
      continue;
    }
    if (
      !options.ignoreMemberCooldown &&
      Number.isFinite(memberCharacterId) &&
      memberCharacterId > 0 &&
      getBattleStartCooldownRemainingMs(memberCharacterId) > 0
    ) {
      continue;
    }
    if (member.data.qixue <= 0) continue;

    validTeamMembers.push({
      ...member,
      data: withBattleStartResources(member.data),
    });
    participantUserIds.push(member.data.user_id);
  }

  return { success: true, validTeamMembers, participantUserIds };
}
