import { query } from '../config/database.js';
import crypto from 'crypto';
import { getGameServer } from '../game/GameServer.js';
import { onUserJoinTeam, onUserLeaveTeam } from './battleService.js';
import { updateAchievementProgress } from './achievementService.js';

/**
 * 九州修仙录 - 组队系统服务
 */

// 境界排序（用于境界比较）
const REALM_ORDER = [
  '凡人',
  '炼精化炁·养气期', '炼精化炁·通脉期', '炼精化炁·凝炁期',
  '炼炁化神·炼己期', '炼炁化神·采药期', '炼炁化神·结胎期',
  '炼神返虚·养神期', '炼神返虚·还虚期', '炼神返虚·合道期',
  '炼虚合道·证道期', '炼虚合道·历劫期', '炼虚合道·成圣期',
];

const getRealmRank = (realm: string): number => {
  const idx = REALM_ORDER.indexOf(realm);
  return idx >= 0 ? idx : 0;
};

const isRealmSufficient = (characterRealm: string, minRealm: string): boolean => {
  return getRealmRank(characterRealm) >= getRealmRank(minRealm);
};

// 获取角色完整境界
const getFullRealm = (realm: string, subRealm: string | null): string => {
  if (!subRealm || realm === '凡人') return realm;
  return `${realm}·${subRealm}`;
};

// 队伍成员类型
interface TeamMember {
  id: string;
  characterId: number;
  name: string;
  role: 'leader' | 'member';
  realm: string;
  online: boolean;
  avatar: string | null;
}

// 队伍信息类型
interface TeamInfo {
  id: string;
  name: string;
  leader: string;
  leaderId: number;
  members: TeamMember[];
  memberCount: number;
  maxMembers: number;
  goal: string;
  joinMinRealm: string;
  autoJoinEnabled: boolean;
  autoJoinMinRealm: string;
  currentMapId: string | null;
  isPublic: boolean;
}

const emitTeamUpdateToUserIds = (userIds: number[], payload: any) => {
  try {
    const gameServer = getGameServer();
    const ids = Array.from(new Set(userIds.filter((id) => Number.isFinite(id))));
    ids.forEach((userId) => gameServer.emitToUser(userId, 'team:update', payload));
  } catch {
    // 忽略
  }
};

const getUserIdsByCharacterIds = async (characterIds: number[]): Promise<number[]> => {
  const ids = Array.from(new Set(characterIds.filter((id) => Number.isFinite(id))));
  if (ids.length === 0) return [];
  const res = await query(`SELECT DISTINCT user_id FROM characters WHERE id = ANY($1::int[])`, [ids]);
  return res.rows.map((r: any) => Number(r.user_id)).filter((n: number) => Number.isFinite(n));
};

const notifyTeamMembersChanged = async (teamId: string, extraCharacterIds: number[] = [], kind: string = 'team_changed') => {
  const memberRes = await query(`SELECT character_id FROM team_members WHERE team_id = $1`, [teamId]);
  const memberIds = memberRes.rows.map((r: any) => Number(r.character_id)).filter((n: number) => Number.isFinite(n));
  const allCharacterIds = Array.from(new Set([...memberIds, ...extraCharacterIds]));
  const userIds = await getUserIdsByCharacterIds(allCharacterIds);
  emitTeamUpdateToUserIds(userIds, { kind, teamId, time: Date.now() });
};

/**
 * 获取角色当前队伍
 */
export const getCharacterTeam = async (characterId: number) => {
  try {
    // 查询角色所在队伍
    const memberResult = await query(
      `SELECT tm.team_id, tm.role FROM team_members tm WHERE tm.character_id = $1`,
      [characterId]
    );

    if (memberResult.rows.length === 0) {
      return { success: true, data: null, message: '未加入队伍' };
    }

    const { team_id: teamId, role } = memberResult.rows[0];
    
    // 获取队伍详情
    const teamResult = await query(
      `SELECT t.*, c.nickname as leader_name 
       FROM teams t 
       JOIN characters c ON t.leader_id = c.id 
       WHERE t.id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    const team = teamResult.rows[0];

    // 获取队伍成员
    const membersResult = await query(
      `SELECT tm.character_id, tm.role, c.nickname, c.realm, c.sub_realm, c.avatar
       FROM team_members tm
       JOIN characters c ON tm.character_id = c.id
       WHERE tm.team_id = $1
       ORDER BY tm.role DESC, tm.joined_at ASC`,
      [teamId]
    );

    const members: TeamMember[] = membersResult.rows.map((row: any) => ({
      id: `tm-${row.character_id}`,
      characterId: row.character_id,
      name: row.nickname,
      role: row.role,
      realm: getFullRealm(row.realm, row.sub_realm),
      online: true, // TODO: 实现在线状态检测
      avatar: row.avatar,
    }));

    const teamInfo: TeamInfo = {
      id: team.id,
      name: team.name,
      leader: team.leader_name,
      leaderId: team.leader_id,
      members,
      memberCount: members.length,
      maxMembers: team.max_members,
      goal: team.goal,
      joinMinRealm: team.join_min_realm,
      autoJoinEnabled: team.auto_join_enabled,
      autoJoinMinRealm: team.auto_join_min_realm,
      currentMapId: team.current_map_id,
      isPublic: team.is_public,
    };

    return { success: true, data: teamInfo, role };
  } catch (error) {
    console.error('获取角色队伍失败:', error);
    return { success: false, message: '获取队伍失败' };
  }
};

/**
 * 根据ID获取队伍详情
 */
export const getTeamById = async (teamId: string) => {
  try {
    const teamResult = await query(
      `SELECT t.*, c.nickname as leader_name 
       FROM teams t 
       JOIN characters c ON t.leader_id = c.id 
       WHERE t.id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    const team = teamResult.rows[0];

    // 获取队伍成员
    const membersResult = await query(
      `SELECT tm.character_id, tm.role, c.nickname, c.realm, c.sub_realm, c.avatar
       FROM team_members tm
       JOIN characters c ON tm.character_id = c.id
       WHERE tm.team_id = $1
       ORDER BY tm.role DESC, tm.joined_at ASC`,
      [teamId]
    );

    const members: TeamMember[] = membersResult.rows.map((row: any) => ({
      id: `tm-${row.character_id}`,
      characterId: row.character_id,
      name: row.nickname,
      role: row.role,
      realm: getFullRealm(row.realm, row.sub_realm),
      online: true,
      avatar: row.avatar,
    }));

    return {
      success: true,
      data: {
        id: team.id,
        name: team.name,
        leader: team.leader_name,
        leaderId: team.leader_id,
        members,
        memberCount: members.length,
        maxMembers: team.max_members,
        goal: team.goal,
        joinMinRealm: team.join_min_realm,
        autoJoinEnabled: team.auto_join_enabled,
        autoJoinMinRealm: team.auto_join_min_realm,
        currentMapId: team.current_map_id,
        isPublic: team.is_public,
      },
    };
  } catch (error) {
    console.error('获取队伍详情失败:', error);
    return { success: false, message: '获取队伍详情失败' };
  }
};


/**
 * 创建队伍
 */
export const createTeam = async (characterId: number, name?: string, goal?: string) => {
  try {
    // 检查角色是否已在队伍中
    const existingMember = await query(
      `SELECT team_id FROM team_members WHERE character_id = $1`,
      [characterId]
    );

    if (existingMember.rows.length > 0) {
      return { success: false, message: '你已在队伍中，请先退出当前队伍' };
    }

    const userIds = await getUserIdsByCharacterIds([characterId]);
    const userId = Number(userIds?.[0]);
    if (Number.isFinite(userId) && userId > 0) {
      await onUserJoinTeam(userId);
    }

    // 获取角色信息
    const charResult = await query(
      `SELECT nickname, current_map_id FROM characters WHERE id = $1`,
      [characterId]
    );

    if (charResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const character = charResult.rows[0];
    const teamId = crypto.randomUUID();
    const teamName = name || `${character.nickname}的小队`;
    const teamGoal = goal || '组队冒险';

    // 创建队伍
    await query(
      `INSERT INTO teams (id, name, leader_id, goal, current_map_id) 
       VALUES ($1, $2, $3, $4, $5)`,
      [teamId, teamName, characterId, teamGoal, character.current_map_id]
    );

    // 添加队长为成员
    await query(
      `INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader')`,
      [teamId, characterId]
    );

    await notifyTeamMembersChanged(teamId, [characterId], 'create_team');

    try {
      await updateAchievementProgress(characterId, 'team:create', 1);
      await updateAchievementProgress(characterId, 'team:join', 1);
    } catch {}

    return {
      success: true,
      message: '队伍创建成功',
      data: { teamId, name: teamName },
    };
  } catch (error) {
    console.error('创建队伍失败:', error);
    return { success: false, message: '创建队伍失败' };
  }
};

/**
 * 解散队伍
 */
export const disbandTeam = async (characterId: number, teamId: string) => {
  try {
    // 验证是否为队长
    const teamResult = await query(
      `SELECT leader_id FROM teams WHERE id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    if (teamResult.rows[0].leader_id !== characterId) {
      return { success: false, message: '只有队长才能解散队伍' };
    }

    const memberRes = await query(`SELECT character_id FROM team_members WHERE team_id = $1`, [teamId]);
    const memberCharacterIds = memberRes.rows.map((r: any) => Number(r.character_id)).filter((n: number) => Number.isFinite(n));
    const memberUserIds = await getUserIdsByCharacterIds(memberCharacterIds);
    for (const userId of memberUserIds) {
      if (!Number.isFinite(userId) || userId <= 0) continue;
      await onUserLeaveTeam(userId);
    }
    emitTeamUpdateToUserIds(memberUserIds, { kind: 'disband_team', teamId, time: Date.now() });

    // 删除队伍（级联删除成员、申请、邀请）
    await query(`DELETE FROM teams WHERE id = $1`, [teamId]);

    return { success: true, message: '队伍已解散' };
  } catch (error) {
    console.error('解散队伍失败:', error);
    return { success: false, message: '解散队伍失败' };
  }
};

/**
 * 离开队伍
 */
export const leaveTeam = async (characterId: number) => {
  try {
    // 查询角色所在队伍
    const memberResult = await query(
      `SELECT tm.team_id, tm.role, t.leader_id 
       FROM team_members tm 
       JOIN teams t ON tm.team_id = t.id 
       WHERE tm.character_id = $1`,
      [characterId]
    );

    if (memberResult.rows.length === 0) {
      return { success: false, message: '你不在任何队伍中' };
    }

    const { team_id: teamId, role } = memberResult.rows[0];
    const userIds = await getUserIdsByCharacterIds([characterId]);
    const userId = Number(userIds?.[0]);
    if (Number.isFinite(userId) && userId > 0) {
      await onUserLeaveTeam(userId);
    }

    // 如果是队长，需要转让或解散
    if (role === 'leader') {
      // 查找其他成员
      const otherMembers = await query(
        `SELECT character_id FROM team_members 
         WHERE team_id = $1 AND character_id != $2 
         ORDER BY joined_at ASC LIMIT 1`,
        [teamId, characterId]
      );

      if (otherMembers.rows.length > 0) {
        // 转让给最早加入的成员
        const newLeaderId = otherMembers.rows[0].character_id;
        await query(`UPDATE teams SET leader_id = $1 WHERE id = $2`, [newLeaderId, teamId]);
        await query(`UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2`, [teamId, newLeaderId]);
      } else {
        // 没有其他成员，解散队伍
        const memberRes = await query(`SELECT character_id FROM team_members WHERE team_id = $1`, [teamId]);
        const memberCharacterIds = memberRes.rows.map((r: any) => Number(r.character_id)).filter((n: number) => Number.isFinite(n));
        const memberUserIds = await getUserIdsByCharacterIds(memberCharacterIds);
        emitTeamUpdateToUserIds(memberUserIds, { kind: 'disband_team', teamId, time: Date.now() });
        await query(`DELETE FROM teams WHERE id = $1`, [teamId]);
        return { success: true, message: '队伍已解散（无其他成员）' };
      }
    }

    // 移除成员
    await query(`DELETE FROM team_members WHERE character_id = $1`, [characterId]);

    await notifyTeamMembersChanged(teamId, [characterId], 'leave_team');

    return { success: true, message: '已离开队伍' };
  } catch (error) {
    console.error('离开队伍失败:', error);
    return { success: false, message: '离开队伍失败' };
  }
};

/**
 * 申请加入队伍
 */
export const applyToTeam = async (characterId: number, teamId: string, message?: string) => {
  try {
    // 检查角色是否已在队伍中
    const existingMember = await query(
      `SELECT team_id FROM team_members WHERE character_id = $1`,
      [characterId]
    );

    if (existingMember.rows.length > 0) {
      return { success: false, message: '你已在队伍中' };
    }

    // 检查队伍是否存在及人数
    const teamResult = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t WHERE t.id = $1`,
      [teamId]
    );

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    const team = teamResult.rows[0];

    if (team.member_count >= team.max_members) {
      return { success: false, message: '队伍已满' };
    }

    // 检查境界要求
    const charResult = await query(
      `SELECT realm, sub_realm FROM characters WHERE id = $1`,
      [characterId]
    );
    const charRealm = getFullRealm(charResult.rows[0].realm, charResult.rows[0].sub_realm);

    if (!isRealmSufficient(charRealm, team.join_min_realm)) {
      return { success: false, message: `境界不足，需要${team.join_min_realm}以上` };
    }

    // 检查是否已有待处理申请
    const existingApp = await query(
      `SELECT id FROM team_applications 
       WHERE team_id = $1 AND applicant_id = $2 AND status = 'pending'`,
      [teamId, characterId]
    );

    if (existingApp.rows.length > 0) {
      return { success: false, message: '已有待处理的申请' };
    }

    // 自动入队检查
    if (team.auto_join_enabled && isRealmSufficient(charRealm, team.auto_join_min_realm)) {
      // 直接加入队伍
      const userIds = await getUserIdsByCharacterIds([characterId]);
      const userId = Number(userIds?.[0]);
      if (Number.isFinite(userId) && userId > 0) {
        await onUserJoinTeam(userId);
      }
      await query(
        `INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')`,
        [teamId, characterId]
      );
      await notifyTeamMembersChanged(teamId, [characterId], 'auto_join');
      try {
        await updateAchievementProgress(characterId, 'team:join', 1);
      } catch {}
      return { success: true, message: '已自动加入队伍', autoJoined: true };
    }

    // 创建申请
    const applicationId = crypto.randomUUID();
    await query(
      `INSERT INTO team_applications (id, team_id, applicant_id, message) VALUES ($1, $2, $3, $4)`,
      [applicationId, teamId, characterId, message || null]
    );

    const leaderId = Number(team.leader_id);
    if (Number.isFinite(leaderId)) {
      const leaderUserIds = await getUserIdsByCharacterIds([leaderId]);
      emitTeamUpdateToUserIds(leaderUserIds, { kind: 'new_application', teamId, applicationId, time: Date.now() });
    }

    return { success: true, message: '申请已提交', applicationId };
  } catch (error) {
    console.error('申请加入队伍失败:', error);
    return { success: false, message: '申请失败' };
  }
};


/**
 * 获取队伍申请列表
 */
export const getTeamApplications = async (teamId: string, characterId: number) => {
  try {
    // 验证是否为队长
    const teamResult = await query(`SELECT leader_id FROM teams WHERE id = $1`, [teamId]);

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    if (teamResult.rows[0].leader_id !== characterId) {
      return { success: false, message: '只有队长才能查看申请' };
    }

    // 获取待处理申请
    const applications = await query(
      `SELECT ta.id, ta.message, ta.created_at, 
              c.id as character_id, c.nickname, c.realm, c.sub_realm, c.avatar
       FROM team_applications ta
       JOIN characters c ON ta.applicant_id = c.id
       WHERE ta.team_id = $1 AND ta.status = 'pending'
       ORDER BY ta.created_at DESC`,
      [teamId]
    );

    const data = applications.rows.map((row: any) => ({
      id: row.id,
      characterId: row.character_id,
      name: row.nickname,
      realm: getFullRealm(row.realm, row.sub_realm),
      avatar: row.avatar,
      message: row.message,
      time: new Date(row.created_at).getTime(),
    }));

    return { success: true, data };
  } catch (error) {
    console.error('获取申请列表失败:', error);
    return { success: false, message: '获取申请列表失败' };
  }
};

/**
 * 处理入队申请
 */
export const handleApplication = async (characterId: number, applicationId: string, approve: boolean) => {
  try {
    // 获取申请信息
    const appResult = await query(
      `SELECT ta.*, t.leader_id, t.max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = ta.team_id) as member_count
       FROM team_applications ta
       JOIN teams t ON ta.team_id = t.id
       WHERE ta.id = $1 AND ta.status = 'pending'`,
      [applicationId]
    );

    if (appResult.rows.length === 0) {
      return { success: false, message: '申请不存在或已处理' };
    }

    const app = appResult.rows[0];

    if (app.leader_id !== characterId) {
      return { success: false, message: '只有队长才能处理申请' };
    }

    if (approve) {
      // 检查队伍是否已满
      if (app.member_count >= app.max_members) {
        await query(
          `UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
          [applicationId]
        );
        return { success: false, message: '队伍已满' };
      }

      // 检查申请者是否已在其他队伍
      const existingMember = await query(
        `SELECT team_id FROM team_members WHERE character_id = $1`,
        [app.applicant_id]
      );

      if (existingMember.rows.length > 0) {
        await query(
          `UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
          [applicationId]
        );
        return { success: false, message: '该玩家已加入其他队伍' };
      }

      // 添加成员
      const userIds = await getUserIdsByCharacterIds([app.applicant_id]);
      const userId = Number(userIds?.[0]);
      if (Number.isFinite(userId) && userId > 0) {
        await onUserJoinTeam(userId);
      }
      await query(
        `INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')`,
        [app.team_id, app.applicant_id]
      );

      // 更新申请状态
      await query(
        `UPDATE team_applications SET status = 'approved', handled_at = NOW() WHERE id = $1`,
        [applicationId]
      );

      await notifyTeamMembersChanged(app.team_id, [app.applicant_id], 'approve_application');

      try {
        await updateAchievementProgress(Number(app.applicant_id), 'team:join', 1);
      } catch {}

      return { success: true, message: '已通过申请' };
    } else {
      // 拒绝申请
      await query(
        `UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
        [applicationId]
      );

      const applicantId = Number(app.applicant_id);
      if (Number.isFinite(applicantId)) {
        const applicantUserIds = await getUserIdsByCharacterIds([applicantId]);
        emitTeamUpdateToUserIds(applicantUserIds, { kind: 'reject_application', teamId: app.team_id, applicationId, time: Date.now() });
      }

      return { success: true, message: '已拒绝申请' };
    }
  } catch (error) {
    console.error('处理申请失败:', error);
    return { success: false, message: '处理申请失败' };
  }
};

/**
 * 踢出成员
 */
export const kickMember = async (leaderId: number, targetCharacterId: number) => {
  try {
    // 获取队长所在队伍
    const leaderMember = await query(
      `SELECT tm.team_id, t.leader_id 
       FROM team_members tm 
       JOIN teams t ON tm.team_id = t.id 
       WHERE tm.character_id = $1`,
      [leaderId]
    );

    if (leaderMember.rows.length === 0) {
      return { success: false, message: '你不在任何队伍中' };
    }

    const { team_id: teamId, leader_id } = leaderMember.rows[0];

    if (leader_id !== leaderId) {
      return { success: false, message: '只有队长才能踢人' };
    }

    if (leaderId === targetCharacterId) {
      return { success: false, message: '不能踢出自己' };
    }

    // 检查目标是否在队伍中
    const targetMember = await query(
      `SELECT id FROM team_members WHERE team_id = $1 AND character_id = $2`,
      [teamId, targetCharacterId]
    );

    if (targetMember.rows.length === 0) {
      return { success: false, message: '该玩家不在队伍中' };
    }

    const userIds = await getUserIdsByCharacterIds([targetCharacterId]);
    const userId = Number(userIds?.[0]);
    if (Number.isFinite(userId) && userId > 0) {
      await onUserLeaveTeam(userId);
    }

    // 移除成员
    await query(`DELETE FROM team_members WHERE team_id = $1 AND character_id = $2`, [teamId, targetCharacterId]);

    await notifyTeamMembersChanged(teamId, [targetCharacterId], 'kick_member');

    return { success: true, message: '已踢出成员' };
  } catch (error) {
    console.error('踢出成员失败:', error);
    return { success: false, message: '踢出成员失败' };
  }
};

/**
 * 转让队长
 */
export const transferLeader = async (currentLeaderId: number, newLeaderId: number) => {
  try {
    // 获取当前队长所在队伍
    const leaderMember = await query(
      `SELECT tm.team_id, t.leader_id 
       FROM team_members tm 
       JOIN teams t ON tm.team_id = t.id 
       WHERE tm.character_id = $1`,
      [currentLeaderId]
    );

    if (leaderMember.rows.length === 0) {
      return { success: false, message: '你不在任何队伍中' };
    }

    const { team_id: teamId, leader_id } = leaderMember.rows[0];

    if (leader_id !== currentLeaderId) {
      return { success: false, message: '只有队长才能转让' };
    }

    // 检查新队长是否在队伍中
    const newLeaderMember = await query(
      `SELECT id FROM team_members WHERE team_id = $1 AND character_id = $2`,
      [teamId, newLeaderId]
    );

    if (newLeaderMember.rows.length === 0) {
      return { success: false, message: '该玩家不在队伍中' };
    }

    // 更新队伍队长
    await query(`UPDATE teams SET leader_id = $1, updated_at = NOW() WHERE id = $2`, [newLeaderId, teamId]);

    // 更新成员角色
    await query(`UPDATE team_members SET role = 'member' WHERE team_id = $1 AND character_id = $2`, [teamId, currentLeaderId]);
    await query(`UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2`, [teamId, newLeaderId]);

    await notifyTeamMembersChanged(teamId, [currentLeaderId, newLeaderId], 'transfer_leader');

    return { success: true, message: '队长已转让' };
  } catch (error) {
    console.error('转让队长失败:', error);
    return { success: false, message: '转让队长失败' };
  }
};

/**
 * 更新队伍设置
 */
export const updateTeamSettings = async (
  characterId: number,
  teamId: string,
  settings: {
    name?: string;
    goal?: string;
    joinMinRealm?: string;
    autoJoinEnabled?: boolean;
    autoJoinMinRealm?: string;
    isPublic?: boolean;
  }
) => {
  try {
    // 验证是否为队长
    const teamResult = await query(`SELECT leader_id FROM teams WHERE id = $1`, [teamId]);

    if (teamResult.rows.length === 0) {
      return { success: false, message: '队伍不存在' };
    }

    if (teamResult.rows[0].leader_id !== characterId) {
      return { success: false, message: '只有队长才能修改设置' };
    }

    // 构建更新语句
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (settings.name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(settings.name);
    }
    if (settings.goal !== undefined) {
      updates.push(`goal = $${paramIndex++}`);
      values.push(settings.goal);
    }
    if (settings.joinMinRealm !== undefined) {
      updates.push(`join_min_realm = $${paramIndex++}`);
      values.push(settings.joinMinRealm);
    }
    if (settings.autoJoinEnabled !== undefined) {
      updates.push(`auto_join_enabled = $${paramIndex++}`);
      values.push(settings.autoJoinEnabled);
    }
    if (settings.autoJoinMinRealm !== undefined) {
      updates.push(`auto_join_min_realm = $${paramIndex++}`);
      values.push(settings.autoJoinMinRealm);
    }
    if (settings.isPublic !== undefined) {
      updates.push(`is_public = $${paramIndex++}`);
      values.push(settings.isPublic);
    }

    if (updates.length === 0) {
      return { success: true, message: '无需更新' };
    }

    updates.push(`updated_at = NOW()`);
    values.push(teamId);

    await query(
      `UPDATE teams SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
      values
    );

    await notifyTeamMembersChanged(teamId, [characterId], 'update_team_settings');

    return { success: true, message: '设置已更新' };
  } catch (error) {
    console.error('更新队伍设置失败:', error);
    return { success: false, message: '更新设置失败' };
  }
};


/**
 * 获取附近队伍
 */
export const getNearbyTeams = async (characterId: number, mapId?: string) => {
  try {
    // 获取角色当前地图
    const charResult = await query(
      `SELECT current_map_id FROM characters WHERE id = $1`,
      [characterId]
    );

    if (charResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }

    const currentMapId = mapId || charResult.rows[0].current_map_id;

    // 查询同地图的公开队伍
    const teamsResult = await query(
      `SELECT t.id, t.name, t.goal, t.join_min_realm, t.max_members,
              c.nickname as leader_name,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
       FROM teams t
       JOIN characters c ON t.leader_id = c.id
       WHERE t.current_map_id = $1 
         AND t.is_public = true
         AND t.id NOT IN (SELECT team_id FROM team_members WHERE character_id = $2)
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [currentMapId, characterId]
    );

    const data = teamsResult.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      leader: row.leader_name,
      members: parseInt(row.member_count),
      cap: row.max_members,
      goal: row.goal,
      minRealm: row.join_min_realm,
      distance: `${Math.floor(Math.random() * 500) + 50}米`, // TODO: 实现真实距离计算
    }));

    return { success: true, data };
  } catch (error) {
    console.error('获取附近队伍失败:', error);
    return { success: false, message: '获取附近队伍失败' };
  }
};

/**
 * 获取队伍大厅列表
 */
export const getLobbyTeams = async (characterId: number, search?: string, limit: number = 50) => {
  try {
    let sql = `
      SELECT t.id, t.name, t.goal, t.join_min_realm, t.max_members,
             c.nickname as leader_name,
             (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count
      FROM teams t
      JOIN characters c ON t.leader_id = c.id
      WHERE t.is_public = true
        AND t.id NOT IN (SELECT team_id FROM team_members WHERE character_id = $1)
    `;
    const params: any[] = [characterId];

    if (search) {
      sql += ` AND (t.name ILIKE $2 OR c.nickname ILIKE $2 OR t.goal ILIKE $2)`;
      params.push(`%${search}%`);
    }

    sql += ` ORDER BY t.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const teamsResult = await query(sql, params);

    const data = teamsResult.rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      leader: row.leader_name,
      members: parseInt(row.member_count),
      cap: row.max_members,
      goal: row.goal,
      minRealm: row.join_min_realm,
    }));

    return { success: true, data };
  } catch (error) {
    console.error('获取队伍大厅失败:', error);
    return { success: false, message: '获取队伍大厅失败' };
  }
};

/**
 * 邀请玩家入队
 */
export const inviteToTeam = async (inviterId: number, inviteeId: number, message?: string) => {
  try {
    // 获取邀请者所在队伍
    const inviterMember = await query(
      `SELECT tm.team_id, tm.role, t.leader_id, t.max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = tm.team_id) as member_count
       FROM team_members tm
       JOIN teams t ON tm.team_id = t.id
       WHERE tm.character_id = $1`,
      [inviterId]
    );

    if (inviterMember.rows.length === 0) {
      return { success: false, message: '你不在任何队伍中' };
    }

    const { team_id: teamId, leader_id, max_members, member_count } = inviterMember.rows[0];

    // 只有队长可以邀请
    if (leader_id !== inviterId) {
      return { success: false, message: '只有队长才能邀请' };
    }

    // 检查队伍是否已满
    if (member_count >= max_members) {
      return { success: false, message: '队伍已满' };
    }

    // 检查被邀请者是否已在队伍中
    const inviteeMember = await query(
      `SELECT team_id FROM team_members WHERE character_id = $1`,
      [inviteeId]
    );

    if (inviteeMember.rows.length > 0) {
      return { success: false, message: '该玩家已在队伍中' };
    }

    // 检查是否已有待处理邀请
    const existingInvite = await query(
      `SELECT id FROM team_invitations 
       WHERE team_id = $1 AND invitee_id = $2 AND status = 'pending'`,
      [teamId, inviteeId]
    );

    if (existingInvite.rows.length > 0) {
      return { success: false, message: '已有待处理的邀请' };
    }

    // 创建邀请
    const invitationId = crypto.randomUUID();
    await query(
      `INSERT INTO team_invitations (id, team_id, inviter_id, invitee_id, message) 
       VALUES ($1, $2, $3, $4, $5)`,
      [invitationId, teamId, inviterId, inviteeId, message || null]
    );

    const inviteeUserIds = await getUserIdsByCharacterIds([inviteeId]);
    emitTeamUpdateToUserIds(inviteeUserIds, { kind: 'new_invitation', teamId, invitationId, time: Date.now() });

    return { success: true, message: '邀请已发送', invitationId };
  } catch (error) {
    console.error('邀请入队失败:', error);
    return { success: false, message: '邀请失败' };
  }
};

/**
 * 获取收到的邀请
 */
export const getReceivedInvitations = async (characterId: number) => {
  try {
    const invitations = await query(
      `SELECT ti.id, ti.message, ti.created_at,
              t.id as team_id, t.name as team_name, t.goal,
              c.nickname as inviter_name
       FROM team_invitations ti
       JOIN teams t ON ti.team_id = t.id
       JOIN characters c ON ti.inviter_id = c.id
       WHERE ti.invitee_id = $1 AND ti.status = 'pending'
       ORDER BY ti.created_at DESC`,
      [characterId]
    );

    const data = invitations.rows.map((row: any) => ({
      id: row.id,
      teamId: row.team_id,
      teamName: row.team_name,
      goal: row.goal,
      inviterName: row.inviter_name,
      message: row.message,
      time: new Date(row.created_at).getTime(),
    }));

    return { success: true, data };
  } catch (error) {
    console.error('获取邀请列表失败:', error);
    return { success: false, message: '获取邀请列表失败' };
  }
};

/**
 * 处理入队邀请
 */
export const handleInvitation = async (characterId: number, invitationId: string, accept: boolean) => {
  try {
    // 获取邀请信息
    const inviteResult = await query(
      `SELECT ti.*, t.max_members,
              (SELECT COUNT(*) FROM team_members WHERE team_id = ti.team_id) as member_count
       FROM team_invitations ti
       JOIN teams t ON ti.team_id = t.id
       WHERE ti.id = $1 AND ti.invitee_id = $2 AND ti.status = 'pending'`,
      [invitationId, characterId]
    );

    if (inviteResult.rows.length === 0) {
      return { success: false, message: '邀请不存在或已处理' };
    }

    const invite = inviteResult.rows[0];

    if (accept) {
      // 检查是否已在其他队伍
      const existingMember = await query(
        `SELECT team_id FROM team_members WHERE character_id = $1`,
        [characterId]
      );

      if (existingMember.rows.length > 0) {
        await query(
          `UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
          [invitationId]
        );
        return { success: false, message: '你已在其他队伍中' };
      }

      // 检查队伍是否已满
      if (invite.member_count >= invite.max_members) {
        await query(
          `UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
          [invitationId]
        );
        return { success: false, message: '队伍已满' };
      }

      // 加入队伍
      const userIds = await getUserIdsByCharacterIds([characterId]);
      const userId = Number(userIds?.[0]);
      if (Number.isFinite(userId) && userId > 0) {
        await onUserJoinTeam(userId);
      }
      await query(
        `INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')`,
        [invite.team_id, characterId]
      );

      // 更新邀请状态
      await query(
        `UPDATE team_invitations SET status = 'accepted', handled_at = NOW() WHERE id = $1`,
        [invitationId]
      );

      // 拒绝其他待处理邀请
      await query(
        `UPDATE team_invitations SET status = 'rejected', handled_at = NOW() 
         WHERE invitee_id = $1 AND status = 'pending' AND id != $2`,
        [characterId, invitationId]
      );

      await notifyTeamMembersChanged(invite.team_id, [characterId], 'accept_invitation');

      return { success: true, message: '已加入队伍' };
    } else {
      // 拒绝邀请
      await query(
        `UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1`,
        [invitationId]
      );

      const inviterId = Number(invite.inviter_id);
      if (Number.isFinite(inviterId)) {
        const inviterUserIds = await getUserIdsByCharacterIds([inviterId]);
        emitTeamUpdateToUserIds(inviterUserIds, { kind: 'reject_invitation', teamId: invite.team_id, invitationId, time: Date.now() });
      }

      return { success: true, message: '已拒绝邀请' };
    }
  } catch (error) {
    console.error('处理邀请失败:', error);
    return { success: false, message: '处理邀请失败' };
  }
};
