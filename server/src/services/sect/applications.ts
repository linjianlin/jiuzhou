import type { PoolClient } from 'pg';
import { pool } from '../../config/database.js';
import { assertMember, compareRealmRank, getCharacterRealm, getCharacterSectId, hasPermission, toNumber } from './db.js';
import type { Result, SectApplicationRow, SectPosition } from './types.js';
import { updateAchievementProgress } from '../achievementService.js';

const addLogTx = async (
  client: PoolClient,
  sectId: string,
  logType: string,
  operatorId: number | null,
  targetId: number | null,
  content: string
) => {
  await client.query(
    `INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content) VALUES ($1, $2, $3, $4, $5)`,
    [sectId, logType, operatorId, targetId, content]
  );
};

export const applyToSect = async (characterId: number, sectId: string, message?: string): Promise<Result> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await getCharacterSectId(characterId, client);
    if (existing) {
      await client.query('ROLLBACK');
      return { success: false, message: '已加入宗门，无法申请' };
    }

    const sectRes = await client.query(
      `SELECT id, join_type, join_min_realm, member_count, max_members FROM sect_def WHERE id = $1 FOR UPDATE`,
      [sectId]
    );
    if (sectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门不存在' };
    }

    const joinType = sectRes.rows[0].join_type as 'open' | 'apply' | 'invite';
    const joinMinRealm = typeof sectRes.rows[0].join_min_realm === 'string' ? sectRes.rows[0].join_min_realm : '凡人';
    const memberCount = toNumber(sectRes.rows[0].member_count);
    const maxMembers = toNumber(sectRes.rows[0].max_members);

    if (memberCount >= maxMembers) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门人数已满' };
    }

    const realm = await getCharacterRealm(characterId, client);
    if (!realm) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    if (compareRealmRank(realm, joinMinRealm) < 0) {
      await client.query('ROLLBACK');
      return { success: false, message: `境界不足，需达到：${joinMinRealm}` };
    }

    if (joinType === 'invite') {
      await client.query('ROLLBACK');
      return { success: false, message: '该宗门仅支持邀请加入' };
    }

    if (joinType === 'open') {
      await client.query(
        `INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
         VALUES ($1, $2, 'disciple', 0, 0)`,
        [sectId, characterId]
      );
      await client.query('UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1', [sectId]);
      await addLogTx(client, sectId, 'join', characterId, null, '加入宗门（开放加入）');
      await client.query('COMMIT');
      try {
        await updateAchievementProgress(characterId, 'sect:join', 1);
      } catch {}
      return { success: true, message: '加入成功' };
    }

    const pendingRes = await client.query(
      `SELECT id FROM sect_application WHERE sect_id = $1 AND character_id = $2 AND status = 'pending'`,
      [sectId, characterId]
    );
    if (pendingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '已提交申请，请等待审核' };
    }

    await client.query(
      `
        INSERT INTO sect_application (sect_id, character_id, message, status)
        VALUES ($1, $2, $3, 'pending')
      `,
      [sectId, characterId, message || null]
    );
    await addLogTx(client, sectId, 'apply', characterId, null, '提交入门申请');
    await client.query('COMMIT');
    return { success: true, message: '申请已提交' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('申请加入失败:', error);
    return { success: false, message: '申请加入失败' };
  } finally {
    client.release();
  }
};

export const listApplications = async (
  operatorId: number
): Promise<{ success: boolean; message: string; data?: Array<SectApplicationRow & { nickname: string; realm: string }> }> => {
  try {
    const member = await assertMember(operatorId);
    if (!(member.position === 'leader' || member.position === 'vice_leader' || member.position === 'elder')) {
      return { success: false, message: '无权限查看申请' };
    }

    const res = await pool.query(
      `
        SELECT a.*, c.nickname, c.realm
        FROM sect_application a
        JOIN characters c ON c.id = a.character_id
        WHERE a.sect_id = $1 AND a.status = 'pending'
        ORDER BY a.created_at ASC
      `,
      [member.sectId]
    );
    return { success: true, message: 'ok', data: res.rows as any };
  } catch (error) {
    console.error('获取申请列表失败:', error);
    return { success: false, message: '获取申请列表失败' };
  }
};

export const handleApplication = async (operatorId: number, applicationId: number, approve: boolean): Promise<Result> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const me = await assertMember(operatorId, client);
    if (!hasPermission(me.position, 'approve')) {
      await client.query('ROLLBACK');
      return { success: false, message: '无权限处理申请' };
    }

    const appRes = await client.query(
      `
        SELECT * FROM sect_application
        WHERE id = $1
        FOR UPDATE
      `,
      [applicationId]
    );
    if (appRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '申请不存在' };
    }

    const app = appRes.rows[0] as SectApplicationRow;
    if (app.sect_id !== me.sectId) {
      await client.query('ROLLBACK');
      return { success: false, message: '不可处理其他宗门的申请' };
    }
    if (app.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, message: '申请已处理' };
    }

    if (!approve) {
      await client.query(
        `UPDATE sect_application SET status = 'rejected', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
        [applicationId, operatorId]
      );
      await addLogTx(client, me.sectId, 'reject', operatorId, app.character_id, '拒绝入门申请');
      await client.query('COMMIT');
      return { success: true, message: '已拒绝' };
    }

    const sectRes = await client.query(`SELECT member_count, max_members FROM sect_def WHERE id = $1 FOR UPDATE`, [
      me.sectId,
    ]);
    if (sectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门不存在' };
    }
    const memberCount = toNumber(sectRes.rows[0].member_count);
    const maxMembers = toNumber(sectRes.rows[0].max_members);
    if (memberCount >= maxMembers) {
      await client.query('ROLLBACK');
      return { success: false, message: '宗门人数已满' };
    }

    const existing = await client.query('SELECT sect_id FROM sect_member WHERE character_id = $1', [app.character_id]);
    if (existing.rows.length > 0) {
      await client.query(
        `UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
        [applicationId, operatorId]
      );
      await client.query('COMMIT');
      return { success: false, message: '对方已加入其他宗门' };
    }

    await client.query(
      `INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
       VALUES ($1, $2, 'disciple', 0, 0)`,
      [me.sectId, app.character_id]
    );
    await client.query('UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1', [me.sectId]);
    await client.query(
      `UPDATE sect_application SET status = 'approved', handled_at = NOW(), handled_by = $2 WHERE id = $1`,
      [applicationId, operatorId]
    );
    await addLogTx(client, me.sectId, 'approve', operatorId, app.character_id, '通过入门申请');
    await client.query('COMMIT');
    try {
      await updateAchievementProgress(app.character_id, 'sect:join', 1);
    } catch {}
    return { success: true, message: '已通过' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('处理申请失败:', error);
    return { success: false, message: '处理申请失败' };
  } finally {
    client.release();
  }
};

export const cancelMyApplication = async (characterId: number, applicationId: number): Promise<Result> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const appRes = await client.query(
      `SELECT id, sect_id, character_id, status FROM sect_application WHERE id = $1 FOR UPDATE`,
      [applicationId]
    );
    if (appRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '申请不存在' };
    }
    const app = appRes.rows[0] as { id: number; sect_id: string; character_id: number; status: string };
    if (app.character_id !== characterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '无权限取消该申请' };
    }
    if (app.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, message: '申请已处理，无法取消' };
    }
    await client.query(`UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = NULL WHERE id = $1`, [
      applicationId,
    ]);
    await addLogTx(client, app.sect_id, 'cancel_apply', characterId, null, '取消入门申请');
    await client.query('COMMIT');
    return { success: true, message: '已取消' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('取消申请失败:', error);
    return { success: false, message: '取消申请失败' };
  } finally {
    client.release();
  }
};

