import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { assertMember, compareRealmRank, getCharacterRealm, getCharacterSectId, hasPermission, toNumber } from './db.js';
import type { Result, SectApplicationRow } from './types.js';
import { updateAchievementProgress } from '../achievementService.js';

interface SectApplicationWithCharacterRow extends SectApplicationRow {
  nickname: string;
  realm: string;
}

interface MySectApplicationRow {
  id: number;
  sect_id: string;
  message: string | null;
  created_at: string;
  sect_name: string;
  sect_level: number | string;
  member_count: number | string;
  max_members: number | string;
  join_type: 'open' | 'apply' | 'invite';
}

/**
 * 宗门申请服务
 *
 * 作用：处理宗门入门申请、审批、取消等逻辑
 * 不做：不处理路由层参数校验、不做权限判断（权限在方法内部判断）
 *
 * 数据流：
 * - applyToSect：检查境界、宗门类型，插入申请或直接加入
 * - handleApplication：审批申请，通过则加入宗门并更新成员数
 * - cancelMyApplication：取消自己的申请
 *
 * 边界条件：
 * 1) 所有写操作使用 @Transactional 保证原子性
 * 2) listApplications 和 listMyApplications 为纯读方法，不需要事务
 */
class SectApplicationService {
  private async addLog(
    sectId: string,
    logType: string,
    operatorId: number | null,
    targetId: number | null,
    content: string
  ): Promise<void> {
    await query(
      `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
      [sectId, logType, operatorId, targetId, content]
    );
  }

  @Transactional
  async applyToSect(characterId: number, sectId: string, message?: string): Promise<Result> {
    const existing = await getCharacterSectId(characterId);
    if (existing) {
      return { success: false, message: '已加入宗门，无法申请' };
    }

    const sectRes = await query(
      `SELECT id, join_type, join_min_realm, member_count, max_members FROM sect_def WHERE id = $1 FOR UPDATE`,
      [sectId]
    );
    if (sectRes.rows.length === 0) {
      return { success: false, message: '宗门不存在' };
    }

    const joinType = sectRes.rows[0].join_type as 'open' | 'apply' | 'invite';
    const joinMinRealm = typeof sectRes.rows[0].join_min_realm === 'string' ? sectRes.rows[0].join_min_realm : '凡人';
    const memberCount = toNumber(sectRes.rows[0].member_count);
    const maxMembers = toNumber(sectRes.rows[0].max_members);

    if (memberCount >= maxMembers) {
      return { success: false, message: '宗门人数已满' };
    }

    const realm = await getCharacterRealm(characterId);
    if (!realm) {
      return { success: false, message: '角色不存在' };
    }
    if (compareRealmRank(realm, joinMinRealm) < 0) {
      return { success: false, message: `境界不足，需达到：${joinMinRealm}` };
    }

    if (joinType === 'invite') {
      return { success: false, message: '该宗门仅支持邀请加入' };
    }

    if (joinType === 'open') {
      await query(
        `INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
         VALUES ($1, $2, 'disciple', 0, 0)`,
        [sectId, characterId]
      );
      await query('UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1', [sectId]);
      await this.addLog(sectId, 'join', characterId, null, '加入宗门（开放加入）');
      await updateAchievementProgress(characterId, 'sect:join', 1);
      return { success: true, message: '加入成功' };
    }

    const pendingRes = await query(
      `SELECT id FROM sect_application WHERE sect_id = $1 AND character_id = $2 AND status = 'pending'`,
      [sectId, characterId]
    );
    if (pendingRes.rows.length > 0) {
      return { success: false, message: '已提交申请，请等待审核' };
    }

    await query(
      `
        INSERT INTO sect_application (sect_id, character_id, message, status)
        VALUES ($1, $2, $3, 'pending')
      `,
      [sectId, characterId, message || null]
    );
    await this.addLog(sectId, 'apply', characterId, null, '提交入门申请');
    return { success: true, message: '申请已提交' };
  }

  async listApplications(
    operatorId: number
  ): Promise<{ success: boolean; message: string; data?: Array<SectApplicationRow & { nickname: string; realm: string }> }> {
    const member = await assertMember(operatorId);
    if (!(member.position === 'leader' || member.position === 'vice_leader' || member.position === 'elder')) {
      return { success: false, message: '无权限查看申请' };
    }

    const res = await query<SectApplicationWithCharacterRow>(
      `
      SELECT a.*, c.nickname, c.realm
      FROM sect_application a
      JOIN characters c ON c.id = a.character_id
      WHERE a.sect_id = $1 AND a.status = 'pending'
      ORDER BY a.created_at ASC
    `,
      [member.sectId]
    );
    return { success: true, message: 'ok', data: res.rows };
  }

  async listMyApplications(
    characterId: number
  ): Promise<{
    success: boolean;
    message: string;
    data?: Array<{
      id: number;
      sectId: string;
      sectName: string;
      sectLevel: number;
      memberCount: number;
      maxMembers: number;
      joinType: 'open' | 'apply' | 'invite';
      createdAt: string;
      message: string | null;
    }>;
  }> {
    const res = await query<MySectApplicationRow>(
      `
      SELECT
        a.id,
        a.sect_id,
        a.message,
        a.created_at,
        sd.name AS sect_name,
        sd.level AS sect_level,
        sd.member_count,
        sd.max_members,
        sd.join_type
      FROM sect_application a
      JOIN sect_def sd ON sd.id = a.sect_id
      WHERE a.character_id = $1 AND a.status = 'pending'
      ORDER BY a.created_at DESC
    `,
      [characterId]
    );

    return {
      success: true,
      message: 'ok',
      data: res.rows.map((row) => ({
        id: Number(row.id),
        sectId: row.sect_id,
        sectName: row.sect_name,
        sectLevel: toNumber(row.sect_level),
        memberCount: toNumber(row.member_count),
        maxMembers: toNumber(row.max_members),
        joinType: row.join_type,
        createdAt: row.created_at,
        message: row.message,
      })),
    };
  }

  @Transactional
  async handleApplication(operatorId: number, applicationId: number, approve: boolean): Promise<Result> {
    const me = await assertMember(operatorId);
    if (!hasPermission(me.position, 'approve')) {
      return { success: false, message: '无权限处理申请' };
    }

    const appRes = await query(
      `
        SELECT * FROM sect_application
        WHERE id = $1
        FOR UPDATE
      `,
      [applicationId]
    );
    if (appRes.rows.length === 0) {
      return { success: false, message: '申请不存在' };
    }

    const app = appRes.rows[0] as SectApplicationRow;
    if (app.sect_id !== me.sectId) {
      return { success: false, message: '不可处理其他宗门的申请' };
    }
    if (app.status !== 'pending') {
      return { success: false, message: '申请已处理' };
    }

    if (!approve) {
      await query(
        `UPDATE sect_application SET status = 'rejected', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
        [applicationId, operatorId]
      );
      await this.addLog(me.sectId, 'reject', operatorId, app.character_id, '拒绝入门申请');
      return { success: true, message: '已拒绝' };
    }

    const sectRes = await query(`SELECT member_count, max_members FROM sect_def WHERE id = $1 FOR UPDATE`, [
      me.sectId,
    ]);
    if (sectRes.rows.length === 0) {
      return { success: false, message: '宗门不存在' };
    }
    const memberCount = toNumber(sectRes.rows[0].member_count);
    const maxMembers = toNumber(sectRes.rows[0].max_members);
    if (memberCount >= maxMembers) {
      return { success: false, message: '宗门人数已满' };
    }

    const existing = await query('SELECT sect_id FROM sect_member WHERE character_id = $1', [app.character_id]);
    if (existing.rows.length > 0) {
      await query(
        `UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
        [applicationId, operatorId]
      );
      return { success: false, message: '对方已加入其他宗门' };
    }

    await query(
      `INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
       VALUES ($1, $2, 'disciple', 0, 0)`,
      [me.sectId, app.character_id]
    );
    await query('UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1', [me.sectId]);
    await query(
      `UPDATE sect_application SET status = 'approved', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
      [applicationId, operatorId]
    );
    await this.addLog(me.sectId, 'approve', operatorId, app.character_id, '通过入门申请');
    await updateAchievementProgress(app.character_id, 'sect:join', 1);
    return { success: true, message: '已通过' };
  }

  @Transactional
  async cancelMyApplication(characterId: number, applicationId: number): Promise<Result> {
    const appRes = await query(
      `SELECT id, sect_id, character_id, status FROM sect_application WHERE id = $1 FOR UPDATE`,
      [applicationId]
    );
    if (appRes.rows.length === 0) {
      return { success: false, message: '申请不存在' };
    }
    const app = appRes.rows[0] as { id: number; sect_id: string; character_id: number; status: string };
    if (app.character_id !== characterId) {
      return { success: false, message: '无权限取消该申请' };
    }
    if (app.status !== 'pending') {
      return { success: false, message: '申请已处理，无法取消' };
    }
    await query(`UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = NULL WHERE id = $1`, [
      applicationId,
    ]);
    await this.addLog(app.sect_id, 'cancel_apply', characterId, null, '取消入门申请');
    return { success: true, message: '已取消' };
  }
}

export const sectApplicationService = new SectApplicationService();

// 向后兼容的命名导出
export const applyToSect = (characterId: number, sectId: string, message?: string) =>
  sectApplicationService.applyToSect(characterId, sectId, message);
export const listApplications = (operatorId: number) => sectApplicationService.listApplications(operatorId);
export const listMyApplications = (characterId: number) => sectApplicationService.listMyApplications(characterId);
export const handleApplication = (operatorId: number, applicationId: number, approve: boolean) =>
  sectApplicationService.handleApplication(operatorId, applicationId, approve);
export const cancelMyApplication = (characterId: number, applicationId: number) =>
  sectApplicationService.cancelMyApplication(characterId, applicationId);
