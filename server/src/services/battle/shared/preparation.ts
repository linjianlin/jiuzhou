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
 * 2) prepareTeamBattleParticipants 发现“队伍成员挂机中”时直接拒绝整场战斗，不允许以“跳过该成员”方式继续开战
 */

import type {
  CharacterData,
  PveBattleTeamMember,
} from "../../../battle/battleFactory.js";
import type { PoolClient } from "pg";
import { getGameServer } from "../../../game/gameServer.js";
import { idleSessionService } from "../../idle/idleSessionService.js";
import {
  getOnlineBattleCharacterSnapshotsByCharacterIds,
  getTeamProjectionByUserId,
  type OnlineBattleCharacterSnapshot,
} from "../../onlineBattleProjectionService.js";
import type { BattleResult } from "../battleTypes.js";
import { getBattleStartCooldownRemainingMs, isCharacterInBattle } from "../runtime/state.js";
import { recoverBattleStartResourcesByUserIds } from "./resourceRecovery.js";
import {
  shouldValidateTeamMemberCooldown,
  type PveBattleStartPolicy,
} from "./startPolicy.js";

// ------ 类型 ------

type QueryExecutor = Pick<PoolClient, "query">;

export type TeamBattleMember = PveBattleTeamMember;

export type TeamBattlePreparationResult =
  | {
      success: true;
      validTeamMembers: TeamBattleMember[];
      participantUserIds: number[];
    }
  | { success: false; result: BattleResult };

export type TeamBattlePreparationOptions = {
  startPolicy: PveBattleStartPolicy;
};

export type FixedBattleParticipant = {
  userId: number;
  characterId: number;
};

type SyncBattleStartResourcesOptions = {
  queryExecutor?: QueryExecutor;
  context: string;
};

const normalizeCharacterId = (value: unknown): number => {
  const characterId = Math.floor(Number(value));
  if (!Number.isFinite(characterId) || characterId <= 0) return 0;
  return characterId;
};

const getTeamBattleMemberCharacterId = (member: TeamBattleMember): number => {
  return normalizeCharacterId(member.data.id);
};

const getTeamBattleMemberNickname = (member: TeamBattleMember): string => {
  return String(member.data.nickname || '').trim();
};

const buildBattleMemberData = (
  snapshot: OnlineBattleCharacterSnapshot,
  applyBattleStartResources: boolean,
): CharacterData => {
  const computed = applyBattleStartResources
    ? withBattleStartResources(snapshot.computed)
    : snapshot.computed;
  return {
    ...computed,
    setBonusEffects: snapshot.loadout.setBonusEffects,
  };
};

const buildTeamBattleMemberFromSnapshot = (
  snapshot: OnlineBattleCharacterSnapshot,
  applyBattleStartResources: boolean,
): TeamBattleMember => ({
  data: buildBattleMemberData(snapshot, applyBattleStartResources),
  skills: snapshot.loadout.skills,
  partnerMember: snapshot.activePartner,
});

// ------ 挂机检查 ------

/**
 * 挂机中检查 -- 若角色有活跃挂机会话则拒绝发起战斗
 *
 * 返回：null 表示未挂机，可继续；非 null 为拒绝结果，直接 return 即可。
 */
export async function isCharacterIdling(characterId: number): Promise<boolean> {
  const normalizedCharacterId = normalizeCharacterId(characterId);
  if (normalizedCharacterId <= 0) return false;
  const activeIdleCharacterIdSet = await idleSessionService.getActiveIdleCharacterIdSet([normalizedCharacterId]);
  return activeIdleCharacterIdSet.has(normalizedCharacterId);
}

export async function rejectIfIdling(
  characterId: number,
): Promise<BattleResult | null> {
  const idling = await isCharacterIdling(characterId);
  if (idling) {
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

/**
 * 异步调度战前资源回写。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“开战后把角色资源快照回写到在线投影并推送前端”移出 HTTP 响应临界区，避免 advance/start 被这类补偿性副作用拖慢。
 * 2. 做什么：统一复用 `syncBattleStartResourcesForUsers`，避免各战斗入口各自写一套 fire-and-forget 包装。
 * 3. 不做什么：不改变 battle engine 使用的开战资源；引擎仍直接使用 `withBattleStartResources` 的同步结果。
 *
 * 输入/输出：
 * - 输入：参与用户 ID 列表、日志上下文。
 * - 输出：无同步返回；副作用在后台异步执行。
 *
 * 数据流/状态流：
 * start/advance -> 本函数排队微任务 -> syncBattleStartResourcesForUsers -> 在线投影回写 + 角色推送。
 *
 * 关键边界条件与坑点：
 * 1. 这里故意不 `await`；即使后台同步失败，也不能阻塞战斗创建成功响应。
 * 2. 同步失败只记日志，不做回退重试；权威战斗状态仍以当前 battle/session 为准。
 */
export const scheduleBattleStartResourcesSyncForUsers = (
  userIds: number[],
  options: SyncBattleStartResourcesOptions,
): void => {
  void Promise.resolve().then(async () => {
    await syncBattleStartResourcesForUsers(userIds, options);
  });
};

// ------ 队伍成员数据 ------

export async function getTeamMembersData(
  userId: number,
  characterId: number,
): Promise<{
  isInTeam: boolean;
  isLeader: boolean;
  teamId: string | null;
  members: TeamBattleMember[];
}> {
  const teamProjection = await getTeamProjectionByUserId(userId);
  if (!teamProjection?.teamId || !teamProjection.role) {
    return { isInTeam: false, isLeader: false, teamId: null, members: [] };
  }

  const teamId = teamProjection.teamId;
  const isLeader = teamProjection.role === "leader";
  const orderedMemberCharacterIds = teamProjection.memberCharacterIds
    .map((memberCharacterId) => normalizeCharacterId(memberCharacterId))
    .filter((memberCharacterId) => memberCharacterId > 0)
    .filter((memberCharacterId) => memberCharacterId !== characterId)
    .filter((memberCharacterId) => memberCharacterId > 0);

  const computedMemberMap = await getOnlineBattleCharacterSnapshotsByCharacterIds(
    orderedMemberCharacterIds,
  );
  const members: Array<TeamBattleMember | null> = await Promise.all(
    orderedMemberCharacterIds.map(async (memberCharacterId) => {
      const snapshot = computedMemberMap.get(memberCharacterId);
      if (!snapshot) return null;
      return buildTeamBattleMemberFromSnapshot(snapshot, false);
    }),
  );

  return {
    isInTeam: true,
    isLeader,
    teamId,
    members: members.filter((member): member is TeamBattleMember => member !== null),
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

  const teamMemberCharacterIds = teamInfo.members
    .map(getTeamBattleMemberCharacterId)
    .filter((characterId) => characterId > 0);
  const activeIdleCharacterIdSet = await idleSessionService.getActiveIdleCharacterIdSet(teamMemberCharacterIds);
  if (activeIdleCharacterIdSet.size > 0) {
    for (const member of teamInfo.members) {
      const memberCharacterId = getTeamBattleMemberCharacterId(member);
      if (memberCharacterId <= 0) continue;
      if (!activeIdleCharacterIdSet.has(memberCharacterId)) continue;
      const memberNickname = getTeamBattleMemberNickname(member);
      const memberLabel = memberNickname.length > 0
        ? `队伍成员【${memberNickname}】`
        : `队伍成员(角色ID:${memberCharacterId})`;
      return {
        success: false,
        result: { success: false, message: `${memberLabel}离线挂机中，无法发起战斗` },
      };
    }
  }

  const shouldCheckMemberCooldown = shouldValidateTeamMemberCooldown(options.startPolicy);
  for (const member of teamInfo.members) {
    const memberCharacterId = getTeamBattleMemberCharacterId(member);
    if (memberCharacterId > 0 && isCharacterInBattle(memberCharacterId)) {
      continue;
    }
    if (
      shouldCheckMemberCooldown &&
      memberCharacterId > 0 &&
      getBattleStartCooldownRemainingMs(memberCharacterId) > 0
    ) {
      continue;
    }
    const recoveredMemberData = withBattleStartResources(member.data);
    if (recoveredMemberData.qixue <= 0) continue;

    validTeamMembers.push({
      ...member,
      data: recoveredMemberData,
    });
    participantUserIds.push(member.data.user_id);
  }

  return { success: true, validTeamMembers, participantUserIds };
}

/**
 * 基于已冻结的参战名单构建组队参战结果。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：复用秘境/千层塔这类“参战成员已经在上游冻结”的场景，直接按传入名单组装队友数据，避免重复查询队伍投影。
 * 2. 做什么：保持参战顺序与上游传入名单一致，只在这里做最小必要的快照存在性过滤。
 * 3. 不做什么：不重新校验队伍归属、不做挂机拦截，也不做成员冷却筛选；这些规则由冻结名单生成时保证。
 *
 * 输入/输出：
 * - 输入：当前角色 ID、固定参与者列表、按 characterId 索引的在线战斗快照。
 * - 输出：与 `prepareTeamBattleParticipants` 同结构的参战结果。
 *
 * 数据流/状态流：
 * dungeon/tower 上游冻结 participants -> 批量读取在线战斗快照
 * -> 本函数组装队友 CharacterData/skills
 * -> startResolvedPVEBattleByPolicy 直接创建 battle。
 *
 * 关键边界条件与坑点：
 * 1. 冻结名单里缺少当前角色或其快照时必须直接失败，否则会进入“队友存在、自己缺失”的非法 battle 状态。
 * 2. 这里只按冻结名单裁剪成员，不会擅自回退到实时队伍投影，避免推进中的秘境被队伍变更污染。
 */
export const prepareFixedTeamBattleParticipants = (params: {
  selfCharacterId: number;
  participants: FixedBattleParticipant[];
  snapshotsByCharacterId: ReadonlyMap<number, OnlineBattleCharacterSnapshot>;
}): TeamBattlePreparationResult => {
  const validTeamMembers: TeamBattleMember[] = [];
  const participantUserIds: number[] = [];
  const seenUserIds = new Set<number>();
  let selfSnapshotExists = false;

  for (const participant of params.participants) {
    const userId = normalizeCharacterId(participant.userId);
    const characterId = normalizeCharacterId(participant.characterId);
    if (userId <= 0 || characterId <= 0) {
      continue;
    }

    const snapshot = params.snapshotsByCharacterId.get(characterId);
    if (!snapshot) {
      return {
        success: false,
        result: { success: false, message: `参战角色快照缺失: ${characterId}` },
      };
    }

    if (!seenUserIds.has(userId)) {
      participantUserIds.push(userId);
      seenUserIds.add(userId);
    }

    if (characterId === params.selfCharacterId) {
      selfSnapshotExists = true;
      continue;
    }

    validTeamMembers.push({
      ...buildTeamBattleMemberFromSnapshot(snapshot, true),
    });
  }

  if (!selfSnapshotExists) {
    return {
      success: false,
      result: { success: false, message: '当前角色不在秘境参战名单中' },
    };
  }

  return {
    success: true,
    validTeamMembers,
    participantUserIds,
  };
};
