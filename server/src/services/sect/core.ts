/**
 * 宗门核心服务
 *
 * 作用：处理宗门的创建、管理、成员操作等核心功能
 * 不做：不处理路由层参数校验、不做权限判断之外的业务规则
 *
 * 数据流：
 * - 创建宗门：扣除灵石 → 创建宗门记录 → 添加成员 → 初始化建筑
 * - 成员管理：权限检查 → 更新成员状态 → 记录日志
 * - 宗门信息：查询宗门定义 → 查询成员列表 → 查询建筑列表
 *
 * 边界条件：
 * 1) 所有写操作使用 @Transactional 保证原子性
 * 2) 纯读操作不加 @Transactional，避免不必要的事务开销
 */
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { consumeCharacterCurrencies } from '../inventory/shared/consume.js';
import { assertMember, generateSectId, getCharacterSectId, hasPermission, positionRank, toNumber } from './db.js';
import { getCachedSectInfo, invalidateSectApplicationCachesBySectIds, invalidateSectInfoCache } from './cache.js';
import { cancelVisiblePendingApplicationsByCharacterId } from './pendingApplications.js';
import type { CreateResult, Result, SectDefRow, SectInfo, SectListResult, SectPosition } from './types.js';
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

/**
 * 宗门核心服务类
 *
 * 复用点：所有宗门核心操作统一通过此服务类调用
 * 被调用位置：sectService.ts、sectRoutes.ts
 */
class SectCoreService {
  /**
   * 记录宗门日志（私有方法，仅在事务内调用）
   */
  private async upsertLog(
    sectId: string,
    logType: string,
    operatorId: number | null,
    targetId: number | null,
    content: string
  ): Promise<void> {
    await query(
      `
        INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [sectId, logType, operatorId, targetId, content]
    );
  }

  /**
   * 获取宗门定义（私有方法，仅在事务内调用）
   */
  private async getSectDef(sectId: string): Promise<SectDefRow | null> {
    const res = await query('SELECT * FROM sect_def WHERE id = $1', [sectId]);
    if (res.rows.length === 0) return null;
    return res.rows[0] as SectDefRow;
  }

  /**
   * 创建宗门
   */
  @Transactional
  async createSect(characterId: number, name: string, description?: string): Promise<CreateResult> {
    const existing = await getCharacterSectId(characterId);
    if (existing) {
      return { success: false, message: '已加入宗门，无法创建' };
    }

    const nameCheck = await query('SELECT id FROM sect_def WHERE name = $1', [name]);
    if (nameCheck.rows.length > 0) {
      return { success: false, message: '宗门名称已存在' };
    }

    const createCost = 1000;
    const consumeResult = await consumeCharacterCurrencies(characterId, {
      spiritStones: createCost,
    });
    if (!consumeResult.success) {
      if (consumeResult.message.startsWith('灵石不足')) {
        return { success: false, message: `灵石不足，创建需要${createCost}` };
      }
      return { success: false, message: consumeResult.message };
    }

    const sectId = generateSectId();
    await query(
      `
        INSERT INTO sect_def (id, name, leader_id, level, exp, funds, reputation, build_points, announcement, description, join_type, join_min_realm, member_count, max_members)
        VALUES ($1, $2, $3, 1, 0, 0, 0, 0, NULL, $4, 'apply', '凡人', 1, 20)
      `,
      [sectId, name, characterId, description || null]
    );
    const clearedPendingSectIds = await cancelVisiblePendingApplicationsByCharacterId(characterId);

    await query(
      `
        INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution)
        VALUES ($1, $2, 'leader', 0, 0)
      `,
      [sectId, characterId]
    );

    for (const buildingType of DEFAULT_BUILDINGS) {
      await query(
        `
          INSERT INTO sect_building (sect_id, building_type, level, status)
          VALUES ($1, $2, 1, 'normal')
          ON CONFLICT (sect_id, building_type) DO NOTHING
        `,
        [sectId, buildingType]
      );
    }

    await this.upsertLog(sectId, 'create', characterId, null, `创建宗门：${name}`);
    await Promise.all([
      invalidateSectInfoCache(sectId),
      invalidateSectApplicationCachesBySectIds(clearedPendingSectIds, characterId),
    ]);
    await updateAchievementProgress(characterId, 'sect:join', 1);
    return { success: true, message: '创建成功', sectId };
  }

  /**
   * 获取宗门信息（纯读操作，不需要事务）
   */
  async getSectInfo(sectId: string): Promise<{ success: boolean; message: string; data?: SectInfo }> {
    const data = await getCachedSectInfo(sectId);
    if (!data) return { success: false, message: '宗门不存在' };
    return {
      success: true,
      message: 'ok',
      data,
    };
  }

  /**
   * 获取角色所在宗门（纯读操作，不需要事务）
   */
  async getCharacterSect(
    characterId: number
  ): Promise<{ success: boolean; message: string; data?: SectInfo | null }> {
    const sectIdRes = await query('SELECT sect_id FROM sect_member WHERE character_id = $1', [characterId]);
    if (sectIdRes.rows.length === 0) return { success: true, message: 'ok', data: null };
    const sectId = sectIdRes.rows[0]?.sect_id as string;
    const res = await this.getSectInfo(sectId);
    if (!res.success) return { success: false, message: res.message };
    return { success: true, message: 'ok', data: res.data! };
  }

  /**
   * 搜索宗门（纯读操作，不需要事务）
   */
  async searchSects(keyword?: string, page: number = 1, limit: number = 20): Promise<SectListResult> {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 20;
    const offset = (safePage - 1) * safeLimit;
    const q = keyword?.trim() ? `%${keyword.trim()}%` : null;

    const where = q ? 'WHERE name ILIKE $1' : '';
    const params = q ? [q, safeLimit, offset] : [safeLimit, offset];
    const listRes = await query(
      `
        SELECT id, name, level, member_count, max_members, join_type, join_min_realm, announcement
        FROM sect_def
        ${where}
        ORDER BY level DESC, member_count DESC, created_at DESC
        LIMIT $${q ? 2 : 1} OFFSET $${q ? 3 : 2}
      `,
      params
    );

    const countRes = await query(`SELECT COUNT(*)::int AS cnt FROM sect_def ${where}`, q ? [q] : []);

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
  }

  /**
   * 更新宗门公告
   */
  @Transactional
  async updateSectAnnouncement(operatorId: number, announcement: string): Promise<Result> {
    const me = await assertMember(operatorId);
    if (!hasPermission(me.position, 'approve')) {
      return { success: false, message: '无权限编辑宗门公告' };
    }

    const normalized = announcement.trim();
    await query('UPDATE sect_def SET announcement = $2, updated_at = NOW() WHERE id = $1', [
      me.sectId,
      normalized || null,
    ]);

    const logContent = normalized ? `更新宗门公告：${normalized}` : '清空宗门公告';
    await this.upsertLog(me.sectId, 'update_announcement', operatorId, null, logContent);
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '公告更新成功' };
  }

  /**
   * 转让宗主
   */
  @Transactional
  async transferLeader(currentLeaderId: number, newLeaderId: number): Promise<Result> {
    const me = await assertMember(currentLeaderId);
    if (me.position !== 'leader') {
      return { success: false, message: '只有宗主可转让' };
    }

    const target = await query('SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE', [
      newLeaderId,
    ]);
    if (target.rows.length === 0 || target.rows[0].sect_id !== me.sectId) {
      return { success: false, message: '目标不在本宗门' };
    }

    await query('UPDATE sect_def SET leader_id = $1, updated_at = NOW() WHERE id = $2', [newLeaderId, me.sectId]);
    await query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
      'leader',
      me.sectId,
      newLeaderId,
    ]);
    await query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
      'vice_leader',
      me.sectId,
      currentLeaderId,
    ]);

    await this.upsertLog(me.sectId, 'transfer_leader', currentLeaderId, newLeaderId, '转让宗主');
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '转让成功' };
  }

  /**
   * 解散宗门
   */
  @Transactional
  async disbandSect(leaderId: number): Promise<Result> {
    const me = await assertMember(leaderId);
    if (!hasPermission(me.position, 'disband')) {
      return { success: false, message: '无权限解散宗门' };
    }

    const sect = await this.getSectDef(me.sectId);
    if (!sect) {
      return { success: false, message: '宗门不存在' };
    }
    if (toNumber(sect.leader_id) !== leaderId) {
      return { success: false, message: '只有宗主可解散宗门' };
    }

    await this.upsertLog(me.sectId, 'disband', leaderId, null, `解散宗门：${sect.name}`);

    await query('DELETE FROM sect_def WHERE id = $1', [me.sectId]);
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '解散成功' };
  }

  /**
   * 退出宗门
   */
  @Transactional
  async leaveSect(characterId: number): Promise<Result> {
    const me = await assertMember(characterId);
    if (me.position === 'leader') {
      return { success: false, message: '宗主不可退出，请先转让或解散' };
    }

    await query('DELETE FROM sect_member WHERE character_id = $1', [characterId]);
    await query('UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1', [
      me.sectId,
    ]);
    await this.upsertLog(me.sectId, 'leave', characterId, null, '退出宗门');
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '已退出宗门' };
  }

  /**
   * 踢出成员
   */
  @Transactional
  async kickMember(operatorId: number, targetId: number): Promise<Result> {
    const me = await assertMember(operatorId);
    if (!hasPermission(me.position, 'kick')) {
      return { success: false, message: '无权限踢人' };
    }

    const targetRes = await query(
      'SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE',
      [targetId]
    );
    if (targetRes.rows.length === 0 || targetRes.rows[0].sect_id !== me.sectId) {
      return { success: false, message: '目标不在本宗门' };
    }

    const targetPos = targetRes.rows[0].position as SectPosition;
    if (targetPos === 'leader') {
      return { success: false, message: '不可踢出宗主' };
    }
    if (positionRank(me.position) <= positionRank(targetPos)) {
      return { success: false, message: '权限不足，无法操作同级或更高职位' };
    }

    await query('DELETE FROM sect_member WHERE character_id = $1', [targetId]);
    await query('UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1', [
      me.sectId,
    ]);
    await this.upsertLog(me.sectId, 'kick', operatorId, targetId, '踢出成员');
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '已踢出成员' };
  }

  /**
   * 任命职位
   */
  @Transactional
  async appointPosition(operatorId: number, targetId: number, position: string): Promise<Result> {
    const me = await assertMember(operatorId);
    if (!(me.position === 'leader' || me.position === 'vice_leader')) {
      return { success: false, message: '无权限任命职位' };
    }

    const allowed: SectPosition[] = ['vice_leader', 'elder', 'elite', 'disciple'];
    if (!allowed.includes(position as SectPosition)) {
      return { success: false, message: '职位参数错误' };
    }

    const targetRes = await query(
      'SELECT sect_id, position FROM sect_member WHERE character_id = $1 FOR UPDATE',
      [targetId]
    );
    if (targetRes.rows.length === 0 || targetRes.rows[0].sect_id !== me.sectId) {
      return { success: false, message: '目标不在本宗门' };
    }
    if (targetRes.rows[0].position === 'leader') {
      return { success: false, message: '不可任命宗主职位' };
    }
    if (operatorId !== targetId && positionRank(me.position) <= positionRank(targetRes.rows[0].position as SectPosition)) {
      if (me.position !== 'leader') {
        return { success: false, message: '权限不足，无法任命同级或更高职位' };
      }
    }

    if (position === 'vice_leader') {
      const cntRes = await query(
        `SELECT COUNT(*)::int AS cnt FROM sect_member WHERE sect_id = $1 AND position = 'vice_leader'`,
        [me.sectId]
      );
      if (toNumber(cntRes.rows[0]?.cnt) >= 2) {
        return { success: false, message: '副宗主已满' };
      }
    }
    if (position === 'elder') {
      const cntRes = await query(
        `SELECT COUNT(*)::int AS cnt FROM sect_member WHERE sect_id = $1 AND position = 'elder'`,
        [me.sectId]
      );
      if (toNumber(cntRes.rows[0]?.cnt) >= 5) {
        return { success: false, message: '长老已满' };
      }
    }

    await query('UPDATE sect_member SET position = $1 WHERE sect_id = $2 AND character_id = $3', [
      position,
      me.sectId,
      targetId,
    ]);
    await this.upsertLog(me.sectId, 'appoint', operatorId, targetId, `任命职位：${position}`);
    await invalidateSectInfoCache(me.sectId);
    return { success: true, message: '任命成功' };
  }
}

export const sectCoreService = new SectCoreService();

// 向后兼容的命名导出
export const createSect = sectCoreService.createSect.bind(sectCoreService);
export const getSectInfo = sectCoreService.getSectInfo.bind(sectCoreService);
export const getCharacterSect = sectCoreService.getCharacterSect.bind(sectCoreService);
export const searchSects = sectCoreService.searchSects.bind(sectCoreService);
export const updateSectAnnouncement = sectCoreService.updateSectAnnouncement.bind(sectCoreService);
export const transferLeader = sectCoreService.transferLeader.bind(sectCoreService);
export const disbandSect = sectCoreService.disbandSect.bind(sectCoreService);
export const leaveSect = sectCoreService.leaveSect.bind(sectCoreService);
export const kickMember = sectCoreService.kickMember.bind(sectCoreService);
export const appointPosition = sectCoreService.appointPosition.bind(sectCoreService);
