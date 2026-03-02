/**
 * 九州修仙录 - 邮件服务
 *
 * 功能：
 * 1. 发送邮件（系统/玩家/GM）
 * 2. 获取邮件列表
 * 3. 阅读邮件
 * 4. 领取附件（严格校验+事务）
 * 5. 删除邮件
 * 6. 批量操作
 * 7. 实例附件发放（用于坊市等需保留实例属性的场景）
 *
 * 改造说明：
 * - 使用 class 单例模式组织代码
 * - 使用 @Transactional 装饰器替代手动事务管理
 * - 辅助函数改为私有方法，提升内聚性
 */
import { query, getTransactionClient } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { itemService } from './itemService.js';
import { findEmptySlotsWithClient, getInventoryInfoWithClient } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { recordCollectItemEvent } from './taskService.js';
import { getItemDefinitionsByIds } from './staticConfigLoader.js';

// ============================================
// 类型定义
// ============================================

export type SenderType = 'system' | 'player' | 'gm';
export type MailType = 'normal' | 'reward' | 'trade' | 'gm';

export interface MailAttachItem {
  item_def_id: string;
  item_name?: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: any;
  };
}

export interface SendMailOptions {
  recipientUserId: number;
  recipientCharacterId?: number;
  senderType?: SenderType;
  senderUserId?: number;
  senderCharacterId?: number;
  senderName?: string;
  mailType?: MailType;
  title: string;
  content: string;
  attachSilver?: number;
  attachSpiritStones?: number;
  attachItems?: MailAttachItem[];
  attachInstanceIds?: number[];
  expireDays?: number;
  source?: string;
  sourceRefId?: string;
  metadata?: any;
}

export interface MailDto {
  id: number;
  senderType: SenderType;
  senderName: string;
  mailType: MailType;
  title: string;
  content: string;
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailAttachItem[];
  readAt: string | null;
  claimedAt: string | null;
  expireAt: string | null;
  createdAt: string;
}

type ClaimMailRow = {
  id: number;
  attach_silver: number;
  attach_spirit_stones: number;
  attach_items: MailAttachItem[] | null;
  attach_instance_ids: unknown;
  claimed_at: Date | string | null;
  expire_at: Date | string | null;
};

type MailAttachItemView = MailAttachItem & {
  item_name?: string;
  quality?: string;
};

const MAIL_HAS_ATTACHMENTS_SQL = '(attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_instance_ids IS NOT NULL)';

// ============================================
// MailService Class
// ============================================

class MailService {
  /**
   * 估算邮件附件所需背包格子数
   * - 装备类：每个占一格
   * - 消耗品/材料：按堆叠上限计算
   */
  private async estimateRequiredSlots(items: MailAttachItem[]): Promise<number> {
    if (!items || items.length === 0) return 0;

    const ids = Array.from(new Set(items.map((i) => i.item_def_id)));
    const defs = getItemDefinitionsByIds(ids);

    const defMap = new Map<string, { category: string; stack_max: number }>();
    for (const id of ids) {
      const def = defs.get(id);
      if (!def) continue;
      defMap.set(id, {
        category: String(def.category || ''),
        stack_max: Math.max(1, Math.floor(Number(def.stack_max) || 1)),
      });
    }

    let slots = 0;
    for (const item of items) {
      const def = defMap.get(item.item_def_id);
      if (!def) {
        slots += Math.max(1, item.qty);
        continue;
      }

      if (def.category === 'equipment') {
        slots += Math.max(1, item.qty);
      } else {
        const stackMax = Math.max(1, def.stack_max || 1);
        slots += Math.ceil(Math.max(1, item.qty) / stackMax);
      }
    }

    return slots;
  }

  /**
   * 判断是否为背包容量不足的错误消息
   */
  private isBagCapacityMessage(message: string): boolean {
    return message.includes('背包空间不足') || message.includes('背包已满');
  }

  /**
   * 判断是否为可跳过的领取错误消息（批量领取时使用）
   */
  private isSkippableClaimMessage(message: string): boolean {
    return (
      this.isBagCapacityMessage(message) ||
      message === '邮件不存在' ||
      message === '附件已领取' ||
      message === '邮件已过期' ||
      message === '该邮件没有附件' ||
      message === '邮件正在处理中，请稍后重试'
    );
  }

  /**
   * 判断是否为 PostgreSQL 行锁冲突（FOR UPDATE NOWAIT）
   */
  private isLockNotAvailableError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === '55P03';
  }

  /**
   * 计算附件物品总数量
   */
  private getAttachItemTotalQty(items: MailAttachItem[] | null | undefined): number {
    if (!items || items.length === 0) return 0;
    return items.reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.qty) || 0)), 0);
  }

  /**
   * 统一清洗邮件中的“定义附件”结构，避免同一解析逻辑在列表/领取/批量领取里重复实现。
   *
   * 数据流说明：
   * - 输入：数据库 JSONB 字段 `attach_items` 的原始值。
   * - 输出：仅保留 `item_def_id` 合法且 `qty > 0` 的附件条目。
   *
   * 边界条件：
   * 1) 非数组输入直接视为“无附件”，不做兜底修复。
   * 2) 数量会被规整为正整数，非法条目直接丢弃，避免污染后续发奖逻辑。
   */
  private normalizeAttachItems(raw: unknown): MailAttachItem[] {
    if (!Array.isArray(raw)) return [];

    const normalized: MailAttachItem[] = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const source = row as Record<string, unknown>;

      const itemDefId = String(source.item_def_id || '').trim();
      const qty = Math.floor(Number(source.qty) || 0);
      if (!itemDefId || qty <= 0) continue;

      const optionsRaw = source.options;
      const normalizedOptions =
        optionsRaw && typeof optionsRaw === 'object'
          ? {
              bindType:
                typeof (optionsRaw as Record<string, unknown>).bindType === 'string'
                  ? String((optionsRaw as Record<string, unknown>).bindType).trim()
                  : undefined,
              equipOptions: (optionsRaw as Record<string, unknown>).equipOptions,
            }
          : undefined;

      normalized.push({
        item_def_id: itemDefId,
        item_name: typeof source.item_name === 'string' ? source.item_name : undefined,
        qty,
        options: normalizedOptions,
      });
    }

    return normalized;
  }

  /**
   * 解析邮件中的“实例附件ID”列表。
   *
   * 设计目的：
   * - 坊市交易需要保留原实例（强化/词条/随机种子），不能重建新实例。
   * - 通过统一解析函数复用在领取和批量扫描逻辑中，避免重复数据清洗代码。
   *
   * 边界条件：
   * 1) 仅接受正整数实例ID，非法值直接丢弃。
   * 2) 自动去重，避免重复ID导致同一实例被重复处理。
   */
  private normalizeAttachInstanceIds(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];

    const ids = new Set<number>();
    for (const row of raw) {
      const n = typeof row === 'number' ? row : Number(row);
      if (Number.isInteger(n) && n > 0) {
        ids.add(n);
      }
    }
    return Array.from(ids);
  }

  // ============================================
  // 发送邮件
  // ============================================

  async sendMail(options: SendMailOptions): Promise<{ success: boolean; mailId?: number; message: string }> {
    // 参数校验
    if (!options.title || options.title.length > 128) {
      return { success: false, message: '邮件标题无效（1-128字符）' };
    }
    if (!options.content || options.content.length > 2000) {
      return { success: false, message: '邮件内容无效（1-2000字符）' };
    }
    if (options.attachSilver && (options.attachSilver < 0 || !Number.isInteger(options.attachSilver))) {
      return { success: false, message: '银两数量无效' };
    }
    if (options.attachSpiritStones && (options.attachSpiritStones < 0 || !Number.isInteger(options.attachSpiritStones))) {
      return { success: false, message: '灵石数量无效' };
    }
    if (options.attachItems && options.attachItems.length > 10) {
      return { success: false, message: '附件物品不能超过10个' };
    }
    if (options.attachInstanceIds && options.attachInstanceIds.length > 10) {
      return { success: false, message: '附件实例不能超过10个' };
    }

    const attachInstanceIds = options.attachInstanceIds
      ? this.normalizeAttachInstanceIds(options.attachInstanceIds)
      : [];
    if (options.attachInstanceIds && attachInstanceIds.length !== options.attachInstanceIds.length) {
      return { success: false, message: '附件实例ID无效' };
    }

    // 计算过期时间
    let expireAt: Date | null = null;
    if (options.expireDays && options.expireDays > 0) {
      expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + options.expireDays);
    }

    try {
      const result = await query(`
        INSERT INTO mail (
          recipient_user_id, recipient_character_id,
          sender_type, sender_user_id, sender_character_id, sender_name,
          mail_type, title, content,
          attach_silver, attach_spirit_stones, attach_items, attach_instance_ids,
          expire_at, source, source_ref_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
      `, [
        options.recipientUserId,
        options.recipientCharacterId || null,
        options.senderType || 'system',
        options.senderUserId || null,
        options.senderCharacterId || null,
        options.senderName || '系统',
        options.mailType || 'normal',
        options.title,
        options.content,
        options.attachSilver || 0,
        options.attachSpiritStones || 0,
        options.attachItems ? JSON.stringify(options.attachItems) : null,
        attachInstanceIds.length > 0 ? JSON.stringify(attachInstanceIds) : null,
        expireAt,
        options.source || null,
        options.sourceRefId || null,
        options.metadata ? JSON.stringify(options.metadata) : null
      ]);

      return { success: true, mailId: result.rows[0].id, message: '邮件发送成功' };
    } catch (error) {
      console.error('发送邮件失败:', error);
      return { success: false, message: '发送邮件失败' };
    }
  }

  /**
   * 发送系统邮件（简化接口）
   */
  async sendSystemMail(
    recipientUserId: number,
    recipientCharacterId: number,
    title: string,
    content: string,
    attachments?: {
      silver?: number;
      spiritStones?: number;
      items?: MailAttachItem[];
    },
    expireDays: number = 30
  ): Promise<{ success: boolean; mailId?: number; message: string }> {
    return this.sendMail({
      recipientUserId,
      recipientCharacterId,
      senderType: 'system',
      senderName: '系统',
      mailType: 'reward',
      title,
      content,
      attachSilver: attachments?.silver,
      attachSpiritStones: attachments?.spiritStones,
      attachItems: attachments?.items,
      expireDays
    });
  }

  // ============================================
  // 获取邮件列表
  // ============================================

  async getMailList(
    userId: number,
    characterId: number,
    page: number = 1,
    pageSize: number = 50
  ): Promise<{ success: boolean; mails: MailDto[]; total: number; unreadCount: number; unclaimedCount: number }> {
    const offset = (page - 1) * pageSize;

    try {
      // 清理过期邮件（软删除）
      await query(`
        UPDATE mail SET deleted_at = NOW(), updated_at = NOW()
        WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
          AND expire_at IS NOT NULL
          AND expire_at < NOW()
          AND deleted_at IS NULL
      `, [characterId, userId]);

      // 获取邮件列表
      const result = await query(`
        SELECT
          id, sender_type, sender_name, mail_type, title, content,
          attach_silver, attach_spirit_stones, attach_items, attach_instance_ids,
          read_at, claimed_at, expire_at, created_at
        FROM mail
        WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
          AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `, [characterId, userId, pageSize, offset]);

      // 获取统计
      const statsResult = await query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE read_at IS NULL) as unread_count,
          COUNT(*) FILTER (WHERE claimed_at IS NULL AND ${MAIL_HAS_ATTACHMENTS_SQL}) as unclaimed_count
        FROM mail
        WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
          AND deleted_at IS NULL
      `, [characterId, userId]);

      const stats = statsResult.rows[0];

      const itemDefIds = Array.from(
        new Set(
          result.rows.flatMap((row: any) => {
            const items = this.normalizeAttachItems(row.attach_items);
            return items
              .map((item) => String(item.item_def_id || '').trim())
              .filter((id) => id.length > 0);
          })
        )
      );

      const itemDefMap = new Map<string, { name: string; quality: string }>();
      if (itemDefIds.length > 0) {
        const defs = getItemDefinitionsByIds(itemDefIds);
        for (const id of itemDefIds) {
          const def = defs.get(id);
          if (!def) continue;
          const name = String(def.name || '').trim();
          itemDefMap.set(id, {
            name: name || id,
            quality: String(def.quality || '').trim(),
          });
        }
      }

      const mails: MailDto[] = result.rows.map(row => ({
        id: row.id,
        senderType: row.sender_type,
        senderName: row.sender_name,
        mailType: row.mail_type,
        title: row.title,
        content: row.content,
        attachSilver: row.attach_silver,
        attachSpiritStones: row.attach_spirit_stones,
        attachItems: this.normalizeAttachItems(row.attach_items).map((item: MailAttachItem) => {
          const itemDefId = String(item.item_def_id || '').trim();
          const defInfo = itemDefId ? itemDefMap.get(itemDefId) : undefined;
          const itemName = defInfo?.name || item.item_name || itemDefId || '未知物品';
          return {
            ...item,
            item_def_id: itemDefId,
            item_name: itemName,
            quality: defInfo?.quality || '',
          } as MailAttachItemView;
        }),
        readAt: row.read_at?.toISOString() || null,
        claimedAt: row.claimed_at?.toISOString() || null,
        expireAt: row.expire_at?.toISOString() || null,
        createdAt: row.created_at.toISOString()
      }));

      return {
        success: true,
        mails,
        total: parseInt(stats.total),
        unreadCount: parseInt(stats.unread_count),
        unclaimedCount: parseInt(stats.unclaimed_count)
      };
    } catch (error) {
      console.error('获取邮件列表失败:', error);
      return { success: false, mails: [], total: 0, unreadCount: 0, unclaimedCount: 0 };
    }
  }

  // ============================================
  // 阅读邮件
  // ============================================

  async readMail(
    userId: number,
    characterId: number,
    mailId: number
  ): Promise<{ success: boolean; message: string }> {
    const result = await query(`
      UPDATE mail SET read_at = COALESCE(read_at, NOW()), updated_at = NOW()
      WHERE id = $1
        AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
      RETURNING id
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    return { success: true, message: '已读' };
  }

  // ============================================
  // 领取附件（核心功能 - 严格校验）
  // ============================================

  @Transactional
  async claimAttachments(
    userId: number,
    characterId: number,
    mailId: number
  ): Promise<{ success: boolean; message: string; rewards?: { silver?: number; spiritStones?: number; itemIds?: number[] } }> {
    const collectCounts = new Map<string, number>();
    const client = getTransactionClient();

    if (!client) {
      throw new Error('事务上下文不可用');
    }

    // 1. 先获取角色背包互斥锁，统一“背包锁 → 邮件行锁”的顺序，避免并发领取形成锁等待链。
    await lockCharacterInventoryMutexTx(client, characterId);

    // 2. 获取邮件并锁定（NOWAIT 避免锁等待拖到 statement_timeout）。
    let mailResult: { rows: ClaimMailRow[] };
    try {
      const lockedMailResult = await client.query<ClaimMailRow>(`
        SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_instance_ids, claimed_at, expire_at
        FROM mail
        WHERE id = $1
          AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL))
          AND deleted_at IS NULL
        FOR UPDATE NOWAIT
      `, [mailId, characterId, userId]);
      mailResult = { rows: lockedMailResult.rows };
    } catch (error) {
      if (this.isLockNotAvailableError(error)) {
        return { success: false, message: '邮件正在处理中，请稍后重试' };
      }
      throw error;
    }

    if (mailResult.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    const mail = mailResult.rows[0];

    // 3. 检查是否已领取
    if (mail.claimed_at) {
      return { success: false, message: '附件已领取' };
    }

    // 4. 检查是否过期
    if (mail.expire_at && new Date(mail.expire_at) < new Date()) {
      return { success: false, message: '邮件已过期' };
    }

    // 5. 检查是否有附件
    const hasCurrency = mail.attach_silver > 0 || mail.attach_spirit_stones > 0;
    const attachItems = this.normalizeAttachItems(mail.attach_items);
    const attachInstanceIds = this.normalizeAttachInstanceIds(mail.attach_instance_ids);
    const hasItems = attachItems.length > 0 || attachInstanceIds.length > 0;

    if (!hasCurrency && !hasItems) {
      return { success: false, message: '该邮件没有附件' };
    }

    // 6. 检查背包空间（如果有物品附件）
    if (hasItems) {
      const inventoryInfo = await getInventoryInfoWithClient(characterId, client);
      // 约定：实例附件存在时，按实例附件发放；定义附件仅用于展示，不再重复创建实例。
      // 这样可保证坊市交易装备的强化/词条等实例属性不丢失。
      const requiredSlots =
        attachInstanceIds.length > 0
          ? attachInstanceIds.length
          : await this.estimateRequiredSlots(attachItems);
      const freeSlots = inventoryInfo.bag_capacity - inventoryInfo.bag_used;
      if (freeSlots < requiredSlots) {
        return { success: false, message: `背包空间不足，需要${requiredSlots}格，当前剩余${freeSlots}格` };
      }
    }

    const rewards: { silver?: number; spiritStones?: number; itemIds?: number[] } = {};

    // 7. 发放货币
    if (hasCurrency) {
      await query(`
        UPDATE characters
        SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW()
        WHERE id = $3
      `, [mail.attach_silver, mail.attach_spirit_stones, characterId]);

      if (mail.attach_silver > 0) rewards.silver = mail.attach_silver;
      if (mail.attach_spirit_stones > 0) rewards.spiritStones = mail.attach_spirit_stones;
    }

    // 8. 发放物品
    const itemIds: number[] = [];
    if (hasItems) {
      if (attachInstanceIds.length > 0) {
        // 实例附件领取：直接把实例从 mail 位置搬运到 bag，避免重建实例导致属性丢失。
        const lockedInstanceResult = await client.query<{
          id: number;
          item_def_id: string;
          qty: number;
        }>(
          `
            SELECT id, item_def_id, qty
            FROM item_instance
            WHERE id = ANY($1::bigint[])
              AND owner_user_id = $2
              AND owner_character_id = $3
              AND location = 'mail'
            FOR UPDATE
          `,
          [attachInstanceIds, userId, characterId],
        );

        const lockedIds = new Set(lockedInstanceResult.rows.map((row) => Number(row.id)));
        for (const attachInstanceId of attachInstanceIds) {
          if (!lockedIds.has(attachInstanceId)) {
            return { success: false, message: '邮件附件状态异常' };
          }
        }

        const targetSlots = await findEmptySlotsWithClient(characterId, 'bag', attachInstanceIds.length, client);
        if (targetSlots.length < attachInstanceIds.length) {
          return {
            success: false,
            message: `背包空间不足，需要${attachInstanceIds.length}格，当前剩余${targetSlots.length}格`,
          };
        }

        const slotByInstanceId = new Map<number, number>();
        for (let index = 0; index < attachInstanceIds.length; index += 1) {
          slotByInstanceId.set(attachInstanceIds[index], targetSlots[index]);
        }

        for (const attachInstanceId of attachInstanceIds) {
          const slot = slotByInstanceId.get(attachInstanceId);
          if (slot === undefined) {
            return { success: false, message: '邮件附件状态异常' };
          }

          const updateResult = await client.query(
            `
              UPDATE item_instance
              SET owner_user_id = $1,
                  owner_character_id = $2,
                  location = 'bag',
                  location_slot = $3,
                  equipped_slot = NULL,
                  updated_at = NOW()
              WHERE id = $4
                AND owner_user_id = $1
                AND owner_character_id = $2
                AND location = 'mail'
              RETURNING id
            `,
            [userId, characterId, slot, attachInstanceId],
          );

          if (updateResult.rows.length === 0) {
            return { success: false, message: '邮件附件状态异常' };
          }
          itemIds.push(Number(updateResult.rows[0].id));
        }

        for (const row of lockedInstanceResult.rows) {
          const key = String(row.item_def_id || '').trim();
          const qty = Math.max(1, Math.floor(Number(row.qty) || 1));
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + qty);
        }
      } else {
        for (const attachItem of attachItems) {
          const createResult = await itemService.createItem(
            userId,
            characterId,
            attachItem.item_def_id,
            attachItem.qty,
            {
              location: 'bag',
              bindType: attachItem.options?.bindType,
              obtainedFrom: 'mail',
              equipOptions: attachItem.options?.equipOptions,
              dbClient: client
            }
          );

          if (!createResult.success) {
            return { success: false, message: `物品创建失败: ${createResult.message}` };
          }

          if (createResult.itemIds) {
            itemIds.push(...createResult.itemIds);
          }

          const key = String(attachItem.item_def_id || '').trim();
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + Math.max(1, Math.floor(Number(attachItem.qty) || 1)));
        }
      }
      if (itemIds.length > 0) {
        rewards.itemIds = itemIds;
      }
    }

    // 9. 更新邮件状态
    await query(`
      UPDATE mail
      SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()),
          attach_instance_ids = $1, updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(itemIds), mailId]);

    for (const [itemDefId, qty] of collectCounts.entries()) {
      await recordCollectItemEvent(characterId, itemDefId, qty);
    }

    return { success: true, message: '领取成功', rewards };
  }

  // ============================================
  // 一键领取所有附件
  // ============================================

  async claimAllAttachments(
    userId: number,
    characterId: number
  ): Promise<{
    success: boolean;
    message: string;
    claimedCount: number;
    skippedCount?: number;
    rewards?: { silver: number; spiritStones: number; itemCount: number };
  }> {
    // 1. 获取所有可尝试领取的邮件（不做总量空间校验，改为逐封领取）
    // 说明：此方法不包裹单一大事务，避免批量领取时长时间持有 mail 行锁与背包互斥锁。
    const mailsResult = await query(
      `
      SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_instance_ids
      FROM mail
      WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
        AND claimed_at IS NULL
        AND ${MAIL_HAS_ATTACHMENTS_SQL}
        AND (expire_at IS NULL OR expire_at > NOW())
      ORDER BY created_at ASC, id ASC
    `,
      [characterId, userId],
    );

    if (mailsResult.rows.length === 0) {
      return { success: true, message: '没有可领取的附件', claimedCount: 0, skippedCount: 0 };
    }

    let claimedCount = 0;
    let skippedCount = 0;
    let totalSilver = 0;
    let totalSpiritStones = 0;
    let totalItemCount = 0;

    for (const row of mailsResult.rows) {
      const mailId = Number(row.id);
      const attachItems = this.normalizeAttachItems(row.attach_items);
      const attachInstanceIds = this.normalizeAttachInstanceIds(row.attach_instance_ids);
      const hasCurrency = Number(row.attach_silver) > 0 || Number(row.attach_spirit_stones) > 0;
      const hasItems = attachItems.length > 0 || attachInstanceIds.length > 0;
      if (!hasCurrency && !hasItems) continue;

      const claimResult = await this.claimAttachments(userId, characterId, mailId);

      if (!claimResult.success) {
        if (this.isBagCapacityMessage(claimResult.message)) {
          skippedCount += 1;
          continue;
        }
        if (this.isSkippableClaimMessage(claimResult.message)) {
          continue;
        }
        throw new Error(`批量领取失败(mailId=${mailId}): ${claimResult.message}`);
      }

      claimedCount += 1;
      totalSilver += Math.max(0, Math.floor(Number(claimResult.rewards?.silver) || 0));
      totalSpiritStones += Math.max(0, Math.floor(Number(claimResult.rewards?.spiritStones) || 0));
      totalItemCount += attachItems.length > 0 ? this.getAttachItemTotalQty(attachItems) : attachInstanceIds.length;
    }

    if (claimedCount === 0) {
      if (skippedCount > 0) {
        return {
          success: true,
          message: `背包空间不足，${skippedCount}封邮件附件未领取`,
          claimedCount: 0,
          skippedCount,
        };
      }
      return { success: true, message: '没有可领取的附件', claimedCount: 0, skippedCount: 0 };
    }

    if (skippedCount > 0) {
      return {
        success: true,
        message: `成功领取${claimedCount}封邮件附件，${skippedCount}封因背包空间不足未领取`,
        claimedCount,
        skippedCount,
        rewards: { silver: totalSilver, spiritStones: totalSpiritStones, itemCount: totalItemCount },
      };
    }

    return {
      success: true,
      message: `成功领取${claimedCount}封邮件附件`,
      claimedCount,
      skippedCount: 0,
      rewards: { silver: totalSilver, spiritStones: totalSpiritStones, itemCount: totalItemCount },
    };
  }

  // ============================================
  // 删除邮件
  // ============================================

  async deleteMail(
    userId: number,
    characterId: number,
    mailId: number
  ): Promise<{ success: boolean; message: string }> {
    const result = await query(`
      UPDATE mail SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
      RETURNING id, claimed_at, attach_silver, attach_spirit_stones, attach_items, attach_instance_ids
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    const mail = result.rows[0];
    const hasAttachments = mail.attach_silver > 0 || mail.attach_spirit_stones > 0 ||
                          this.normalizeAttachItems(mail.attach_items).length > 0 ||
                          this.normalizeAttachInstanceIds(mail.attach_instance_ids).length > 0;

    if (hasAttachments && !mail.claimed_at) {
      // 有未领取的附件，提示用户
      return { success: true, message: '邮件已删除（附件未领取）' };
    }

    return { success: true, message: '邮件已删除' };
  }

  // ============================================
  // 一键删除所有邮件
  // ============================================

  @Transactional
  async deleteAllMails(
    userId: number,
    characterId: number,
    onlyRead: boolean = false
  ): Promise<{ success: boolean; message: string; deletedCount: number }> {
    let sql = `
      UPDATE mail SET deleted_at = NOW(), updated_at = NOW()
      WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
    `;

    if (onlyRead) {
      sql += ` AND read_at IS NOT NULL`;
    }

    const result = await query(sql + ' RETURNING id', [characterId, userId]);

    return {
      success: true,
      message: `已删除${result.rows.length}封邮件`,
      deletedCount: result.rows.length
    };
  }

  // ============================================
  // 标记全部已读
  // ============================================

  @Transactional
  async markAllRead(
    userId: number,
    characterId: number
  ): Promise<{ success: boolean; message: string; readCount: number }> {
    const result = await query(`
      UPDATE mail SET read_at = NOW(), updated_at = NOW()
      WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
        AND read_at IS NULL
      RETURNING id
    `, [characterId, userId]);

    return {
      success: true,
      message: `已读${result.rows.length}封邮件`,
      readCount: result.rows.length
    };
  }

  // ============================================
  // 获取未读邮件数量（用于红点提示）
  // ============================================

  async getUnreadCount(
    userId: number,
    characterId: number
  ): Promise<{ unreadCount: number; unclaimedCount: number }> {
    try {
      const result = await query(`
        SELECT
          COUNT(*) FILTER (WHERE read_at IS NULL) as unread_count,
          COUNT(*) FILTER (WHERE claimed_at IS NULL AND ${MAIL_HAS_ATTACHMENTS_SQL}) as unclaimed_count
        FROM mail
        WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
          AND deleted_at IS NULL
          AND (expire_at IS NULL OR expire_at > NOW())
      `, [characterId, userId]);

      return {
        unreadCount: parseInt(result.rows[0].unread_count),
        unclaimedCount: parseInt(result.rows[0].unclaimed_count)
      };
    } catch (error) {
      console.error('获取未读数量失败:', error);
      return { unreadCount: 0, unclaimedCount: 0 };
    }
  }
}

// ============================================
// 导出单例
// ============================================

export const mailService = new MailService();

// ============================================
// 兼容性导出（保持向后兼容）
// ============================================

export const sendMail = mailService.sendMail.bind(mailService);
export const sendSystemMail = mailService.sendSystemMail.bind(mailService);
export const getMailList = mailService.getMailList.bind(mailService);
export const readMail = mailService.readMail.bind(mailService);
export const claimAttachments = mailService.claimAttachments.bind(mailService);
export const claimAllAttachments = mailService.claimAllAttachments.bind(mailService);
export const deleteMail = mailService.deleteMail.bind(mailService);
export const deleteAllMails = mailService.deleteAllMails.bind(mailService);
export const markAllRead = mailService.markAllRead.bind(mailService);
export const getUnreadCount = mailService.getUnreadCount.bind(mailService);
