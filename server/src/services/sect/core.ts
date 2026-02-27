import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../../config/database.js';
import { assertMember, generateSectId, getCharacterSectId, hasPermission, positionRank, toNumber } from './db.js';
import { withBuildingRequirement } from './buildings.js';
import type { CreateResult, Result, SectBuildingRow, SectDefRow, SectInfo, SectListResult, SectPosition } from './types.js';
import { updateAchievementProgress } from '../achievementService.js';

const DEFAULT_BUILDINGS: string[] = [
  'hall',
  'library',
  'training_hall',
  'alchemy_room',
  'forge_house',
  'spirit_array',
  'defense_array',
];

const upsertLogTx = async (
  client: PoolClient,
  sectId: string,
  logType: string,
  operatorId: number | null,
  targetId: number | null,
  content: string
) => {
  await client.query(
    `
      INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [sectId, logType, operatorId, targetId, content]
  );
};

export const createSect = async (characterId: number, name: string, description?: string): Promise<CreateResult> => {
  try {
    return await withTransaction(async (client) => {
  const existing = await getCharacterSectId(characterId, client);
      if (existing) {
        await client.query('ROLLBACK');
        return { success: false, message: '已加入宗门，无法创建' };
      }
  
      const nameCheck = await client.query('SELECT id FROM sect_def WHERE name = $1', [name]);
      if (nameCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '宗门名称已存在' };
      }
  
      const createCost = 1000;
      const charRes = await client.query('SELECT spirit_stones FROM characters WHERE id = $1 FOR UPDATE', [characterId]);
      if (charRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '角色不存在' };
      }
      const curSS = toNumber(charRes.rows[0]?.spirit_stones);
      if (curSS < createCost) {
        await client.query('ROLLBACK');
        return { success: false, message: `灵石不足，创建需要${createCost}` };
      }
      await client.query(`UPDATE characters SET spirit_stones = spirit_stones - $1, updated_at = NOW() WHERE id = $2`, [
        createCost,
        characterId,
      ]);
  
      const sectId = generateSectId();
      await client.query(
        `
          INSERT INTO sect_def (id, name, leader_id, level, exp, funds, reputation, build_points, announcement, description, join_type, join_min_realm, member_count, max_members)
          VALUES ($1, $2, $3, 1, 0, 0, 0, 0, NULL, $4, 'apply', '凡人', 1, 20)
        `,
        [sectId, name, characterId, description || null]
      );
  
      await client.query(
        `
          INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
          VALUES ($1, $2, 'leader', 0, 0)
        `,
        [sectId, characterId]
      );
  
      for (const buildingType of DEFAULT_BUILDINGS) {
        await client.query(
          `
            INSERT INTO sect_building (sect_id, building_type, level, status)
            VALUES ($1, $2, 1, 'normal')
            ON CONFLICT (sect_id, building_type) DO NOTHING
          `,
          [sectId, buildingType]
        );
      }
  
      await upsertLogTx(client, sectId, 'create', characterId, null, `创建宗门：${name}`);
  try {
        await updateAchievementProgress(characterId, 'sect:join', 1);
      } catch {}
      return { success: true, message: '创建成功', sectId };
    });
  } catch (error) {
console.error('创建宗门失败:', error);
    return { success: false, message: '创建宗门失败' };
  }
};

const getSectDefTx = async (client: PoolClient, sectId: string): Promise<SectDefRow | null> => {
  const res = await client.query('SELECT * FROM sect_def WHERE id = $1', [sectId]);
  if (res.rows.length === 0) return null;
  return res.rows[0] as SectDefRow;
};

export const getSectInfo = async (sectId: string): Promise<{ success: boolean; message: string; data?: SectInfo }> => {
  try {
    const sectRes = await pool.query('SELECT * FROM sect_def WHERE id = $1', [sectId]);
    if (sectRes.rows.length === 0) return { success: false, message: '宗门不存在' };
    const sect = sectRes.rows[0] as SectDefRow;

    const membersRes = await pool.query(
      `
        SELECT sm.character_id, sm.position, sm.contribution, sm.weekly_contribution, sm.joined_at, c.nickname, c.realm, c.last_offline_at
        FROM sect_member sm
        JOIN characters c ON c.id = sm.character_id
        WHERE sm.sect_id = $1
        ORDER BY
          CASE sm.position
            WHEN 'leader' THEN 5
            WHEN 'vice_leader' THEN 4
            WHEN 'elder' THEN 3
            WHEN 'elite' THEN 2
            ELSE 1
          END DESC,
          sm.joined_at ASC
      `,
      [sectId]
    );

    const buildingsRes = await pool.query('SELECT * FROM sect_building WHERE sect_id = $1 ORDER BY building_type', [
      sectId,
    ]);

    const members = membersRes.rows.map((r) => ({
      characterId: toNumber(r.character_id),
      nickname: typeof r.nickname === 'string' ? r.nickname : String(r.character_id),
      realm: typeof r.realm === 'string' ? r.realm : '凡人',
      position: r.position as SectPosition,
      contribution: toNumber(r.contribution),
      weeklyContribution: toNumber(r.weekly_contribution),
      joinedAt: String(r.joined_at),
      lastOfflineAt: r.last_offline_at ? String(r.last_offline_at) : null,
    }));

    const buildings = buildingsRes.rows.map((row) => withBuildingRequirement(row as SectBuildingRow));

    return {
      success: true,
      message: 'ok',
      data: {
        sect,
        members,
        buildings,
      },
    };
  } catch (error) {
    console.error('获取宗门信息失败:', error);
    return { success: false, message: '获取宗门信息失败' };
  }
};

export const getCharacterSect = async (
  characterId: number
): Promise<{ success: boolean; message: string; data?: SectInfo | null }> => {
  try {
    const sectIdRes = await pool.query('SELECT sect_id FROM sect_member WHERE character_id = $1', [characterId]);
    if (sectIdRes.rows.length === 0) return { success: true, message: 'ok', data: null };
    const sectId = sectIdRes.rows[0]?.sect_id as string;
    const res = await getSectInfo(sectId);
    if (!res.success) return { success: false, message: res.message };
    return { success: true, message: 'ok', data: res.data! };
  } catch (error) {
    console.error('获取角色宗门失败:', error);
    return { success: false, message: '获取角色宗门失败' };
  }
};

export const searchSects = async (keyword?: string, page: number = 1, limit: number = 20): Promise<SectListResult> => {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 20;
  const offset = (safePage - 1) * safeLimit;
  const q = keyword?.trim() ? `%${keyword.trim()}%` : null;

  try {
    const where = q ? 'WHERE name ILIKE $1' : '';
    const params = q ? [q, safeLimit, offset] : [safeLimit, offset];
    const listRes = await pool.query(
      `
        SELECT id, name, level, member_count, max_members, join_type, join_min_realm, announcement
        FROM sect_def
        ${where}
        ORDER BY level DESC, member_count DESC, created_at DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `,
      params
    );

    const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM sect_def ${where}`, q ? [q] : []);

    return {
      success: true,
      message: 'ok',
      list: listRes.rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        level: toNumber(r.level),
        memberCount: toNumber(r.member_count),
        maxMembers: toNumber(r.max_members),
        joinType: r.join_type,
        joinMinRealm: r.join_min_realm,
        announcement: r.announcement ?? null,
      })),
      page: safePage,
      limit: safeLimit,
      total: toNumber(countRes.rows[0]?.cnt),
    };
  } catch (error) {
    console.error('搜索宗门失败:', error);
    return { success: false, message: '搜索宗门失败' };
  }
};

export const updateSectAnnouncement = async (operatorId: number, announcement: string): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(operatorId, client);
      if (!hasPermission(me.position, 'approve')) {
        await client.query('ROLLBACK');
        return { success: false, message: '无权限编辑宗门公告' };
      }
  
      const normalized = announcement.trim();
      await client.query('UPDATE sect_def SET announcement = $2, updated_at = NOW() WHERE id = $1', [
        me.sectId,
        normalized || null,
      ]);
  
      const logContent = normalized ? `更新宗门公告：${normalized}` : '清空宗门公告';
      await upsertLogTx(client, me.sectId, 'update_announcement', operatorId, null, logContent);
  return { success: true, message: '公告更新成功' };
    });
  } catch (error) {
console.error('更新宗门公告失败:', error);
    return { success: false, message: '更新宗门公告失败' };
  }
};

export const transferLeader = async (currentLeaderId: number, newLeaderId: number): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(currentLeaderId, client);
      if (me.position !== 'leader') {
        await client.query('ROLLBACK');
        return { success: false, message: '只有宗主可转让' };
      }
  
      const target = await client.query('SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE', [
        newLeaderId,
      ]);
      if (target.rows.length === 0 || target.rows[0].sect_id !== me.sectId) {
        await client.query('ROLLBACK');
        return { success: false, message: '目标不在本宗门' };
      }
  
      await client.query('UPDATE sect_def SET leader_id = $1, updated_at = NOW() WHERE id = $2', [newLeaderId, me.sectId]);
      await client.query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
        'leader',
        me.sectId,
        newLeaderId,
      ]);
      await client.query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
        'vice_leader',
        me.sectId,
        currentLeaderId,
      ]);
  
      await upsertLogTx(client, me.sectId, 'transfer_leader', currentLeaderId, newLeaderId, '转让宗主');
  return { success: true, message: '转让成功' };
    });
  } catch (error) {
console.error('转让宗主失败:', error);
    return { success: false, message: '转让宗主失败' };
  }
};

export const disbandSect = async (leaderId: number): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(leaderId, client);
      if (!hasPermission(me.position, 'disband')) {
        await client.query('ROLLBACK');
        return { success: false, message: '无权限解散宗门' };
      }
  
      const sect = await getSectDefTx(client, me.sectId);
      if (!sect) {
        await client.query('ROLLBACK');
        return { success: false, message: '宗门不存在' };
      }
      if (toNumber(sect.leader_id) !== leaderId) {
        await client.query('ROLLBACK');
        return { success: false, message: '只有宗主可解散宗门' };
      }
  
      await upsertLogTx(client, me.sectId, 'disband', leaderId, null, `解散宗门：${sect.name}`);
  
      await client.query('DELETE FROM sect_def WHERE id = $1', [me.sectId]);
  return { success: true, message: '解散成功' };
    });
  } catch (error) {
console.error('解散宗门失败:', error);
    return { success: false, message: '解散宗门失败' };
  }
};

export const leaveSect = async (characterId: number): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(characterId, client);
      if (me.position === 'leader') {
        await client.query('ROLLBACK');
        return { success: false, message: '宗主不可退出，请先转让或解散' };
      }
  
      await client.query('DELETE FROM sect_member WHERE character_id = $1', [characterId]);
      await client.query('UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1', [
        me.sectId,
      ]);
      await upsertLogTx(client, me.sectId, 'leave', characterId, null, '退出宗门');
  return { success: true, message: '已退出宗门' };
    });
  } catch (error) {
console.error('退出宗门失败:', error);
    return { success: false, message: '退出宗门失败' };
  }
};

export const kickMember = async (operatorId: number, targetId: number): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(operatorId, client);
      if (!hasPermission(me.position, 'kick')) {
        await client.query('ROLLBACK');
        return { success: false, message: '无权限踢人' };
      }
  
      const targetRes = await client.query(
        'SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE',
        [targetId]
      );
      if (targetRes.rows.length === 0 || targetRes.rows[0].sect_id !== me.sectId) {
        await client.query('ROLLBACK');
        return { success: false, message: '目标不在本宗门' };
      }
  
      const targetPos = targetRes.rows[0].position as SectPosition;
      if (targetPos === 'leader') {
        await client.query('ROLLBACK');
        return { success: false, message: '不可踢出宗主' };
      }
      if (positionRank(me.position) <= positionRank(targetPos)) {
        await client.query('ROLLBACK');
        return { success: false, message: '权限不足，无法操作同级或更高职位' };
      }
  
      await client.query('DELETE FROM sect_member WHERE character_id = $1', [targetId]);
      await client.query('UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1', [
        me.sectId,
      ]);
      await upsertLogTx(client, me.sectId, 'kick', operatorId, targetId, '踢出成员');
  return { success: true, message: '已踢出成员' };
    });
  } catch (error) {
console.error('踢人失败:', error);
    return { success: false, message: '踢人失败' };
  }
};

export const appointPosition = async (operatorId: number, targetId: number, position: string): Promise<Result> => {
  try {
    return await withTransaction(async (client) => {
  const me = await assertMember(operatorId, client);
      if (!(me.position === 'leader' || me.position === 'vice_leader')) {
        await client.query('ROLLBACK');
        return { success: false, message: '无权限任命职位' };
      }
  
      const allowed: SectPosition[] = ['vice_leader', 'elder', 'elite', 'disciple'];
      if (!allowed.includes(position as SectPosition)) {
        await client.query('ROLLBACK');
        return { success: false, message: '职位参数错误' };
      }
  
      const targetRes = await client.query(
        'SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE',
        [targetId]
      );
      if (targetRes.rows.length === 0 || targetRes.rows[0].sect_id !== me.sectId) {
        await client.query('ROLLBACK');
        return { success: false, message: '目标不在本宗门' };
      }
      if (targetRes.rows[0].position === 'leader') {
        await client.query('ROLLBACK');
        return { success: false, message: '不可任命宗主职位' };
      }
      if (operatorId !== targetId && positionRank(me.position) <= positionRank(targetRes.rows[0].position as SectPosition)) {
        if (me.position !== 'leader') {
          await client.query('ROLLBACK');
          return { success: false, message: '权限不足，无法任命同级或更高职位' };
        }
      }
  
      if (position === 'vice_leader') {
        const cntRes = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM sect_member WHERE sect_id = $1 AND position = 'vice_leader'`,
          [me.sectId]
        );
        if (toNumber(cntRes.rows[0]?.cnt) >= 2) {
          await client.query('ROLLBACK');
          return { success: false, message: '副宗主已满' };
        }
      }
      if (position === 'elder') {
        const cntRes = await client.query(
          `SELECT COUNT(*)::int AS cnt FROM sect_member WHERE sect_id = $1 AND position = 'elder'`,
          [me.sectId]
        );
        if (toNumber(cntRes.rows[0]?.cnt) >= 5) {
          await client.query('ROLLBACK');
          return { success: false, message: '长老已满' };
        }
      }
  
      await client.query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
        position,
        me.sectId,
        targetId,
      ]);
      await upsertLogTx(client, me.sectId, 'appoint', operatorId, targetId, `任命职位：${position}`);
  return { success: true, message: '任命成功' };
    });
  } catch (error) {
console.error('任命失败:', error);
    return { success: false, message: '任命失败' };
  }
};
