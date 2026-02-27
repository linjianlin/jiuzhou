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
 */
import { query, withTransaction } from '../config/database.js';
import { createItem } from './itemService.js';
import { getInventoryInfoWithClient } from './inventory/index.js';
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

type MailAttachItemView = MailAttachItem & {
  item_name?: string;
  quality?: string;
};

const estimateRequiredSlots = async (
  client: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> },
  items: MailAttachItem[]
): Promise<number> => {
  void client;
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
};

// ============================================
// 发送邮件
// ============================================

export const sendMail = async (options: SendMailOptions): Promise<{ success: boolean; mailId?: number; message: string }> => {
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
        attach_silver, attach_spirit_stones, attach_items,
        expire_at, source, source_ref_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
};

// 发送系统邮件（简化接口）
export const sendSystemMail = async (
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
): Promise<{ success: boolean; mailId?: number; message: string }> => {
  return sendMail({
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
};

// ============================================
// 获取邮件列表
// ============================================

export const getMailList = async (
  userId: number,
  characterId: number,
  page: number = 1,
  pageSize: number = 50
): Promise<{ success: boolean; mails: MailDto[]; total: number; unreadCount: number; unclaimedCount: number }> => {
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
        attach_silver, attach_spirit_stones, attach_items,
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
        COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL)) as unclaimed_count
      FROM mail
      WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
    `, [characterId, userId]);

    const stats = statsResult.rows[0];

    const itemDefIds = Array.from(
      new Set(
        result.rows.flatMap((row: any) => {
          const items = Array.isArray(row.attach_items) ? (row.attach_items as MailAttachItem[]) : [];
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
      attachItems: (Array.isArray(row.attach_items) ? row.attach_items : []).map((item: MailAttachItem) => {
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
};

// ============================================
// 阅读邮件
// ============================================

export const readMail = async (
  userId: number,
  characterId: number,
  mailId: number
): Promise<{ success: boolean; message: string }> => {
  try {
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
  } catch (error) {
    console.error('阅读邮件失败:', error);
    return { success: false, message: '操作失败' };
  }
};

// ============================================
// 领取附件（核心功能 - 严格校验）
// ============================================

export const claimAttachments = async (
  userId: number,
  characterId: number,
  mailId: number
): Promise<{ success: boolean; message: string; rewards?: { silver?: number; spiritStones?: number; itemIds?: number[] } }> => {
  const collectCounts = new Map<string, number>();

  try {
    return await withTransaction(async (client) => {

    // 1. 获取邮件并锁定
    const mailResult = await client.query(`
      SELECT id, attach_silver, attach_spirit_stones, attach_items, claimed_at, expire_at
      FROM mail
      WHERE id = $1 
        AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
      FOR UPDATE
    `, [mailId, characterId, userId]);

    if (mailResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '邮件不存在' };
    }

    const mail = mailResult.rows[0];

    // 2. 检查是否已领取
    if (mail.claimed_at) {
      await client.query('ROLLBACK');
      return { success: false, message: '附件已领取' };
    }

    // 3. 检查是否过期
    if (mail.expire_at && new Date(mail.expire_at) < new Date()) {
      await client.query('ROLLBACK');
      return { success: false, message: '邮件已过期' };
    }

    // 4. 检查是否有附件
    const hasCurrency = mail.attach_silver > 0 || mail.attach_spirit_stones > 0;
    const hasItems = mail.attach_items && mail.attach_items.length > 0;

    if (!hasCurrency && !hasItems) {
      await client.query('ROLLBACK');
      return { success: false, message: '该邮件没有附件' };
    }

    // 5. 检查背包空间（如果有物品附件）
    if (hasItems) {
      const inventoryInfo = await getInventoryInfoWithClient(characterId, client);
      const requiredSlots = await estimateRequiredSlots(client, mail.attach_items as MailAttachItem[]);
      const freeSlots = inventoryInfo.bag_capacity - inventoryInfo.bag_used;
      if (freeSlots < requiredSlots) {
        await client.query('ROLLBACK');
        return { success: false, message: `背包空间不足，需要${requiredSlots}格，当前剩余${freeSlots}格` };
      }
    }

    const rewards: { silver?: number; spiritStones?: number; itemIds?: number[] } = {};

    // 6. 发放货币
    if (hasCurrency) {
      await client.query(`
        UPDATE characters 
        SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW()
        WHERE id = $3
      `, [mail.attach_silver, mail.attach_spirit_stones, characterId]);

      if (mail.attach_silver > 0) rewards.silver = mail.attach_silver;
      if (mail.attach_spirit_stones > 0) rewards.spiritStones = mail.attach_spirit_stones;
    }

    // 7. 发放物品
    const itemIds: number[] = [];
    if (hasItems) {
      for (const attachItem of mail.attach_items as MailAttachItem[]) {
        const createResult = await createItem(
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
          await client.query('ROLLBACK');
          return { success: false, message: `物品创建失败: ${createResult.message}` };
        }

        if (createResult.itemIds) {
          itemIds.push(...createResult.itemIds);
        }

        const key = String(attachItem.item_def_id || '').trim();
        if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + Math.max(1, Math.floor(Number(attachItem.qty) || 1)));
      }
      rewards.itemIds = itemIds;
    }

    // 8. 更新邮件状态
    await client.query(`
      UPDATE mail 
      SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()), 
          attach_instance_ids = $1, updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(itemIds), mailId]);

    for (const [itemDefId, qty] of collectCounts.entries()) {
      try {
        await recordCollectItemEvent(characterId, itemDefId, qty);
      } catch {}
    }

    return { success: true, message: '领取成功', rewards };
    });

  } catch (error) {
    console.error('领取附件失败:', error);
    return { success: false, message: '领取失败' };
  }
};

// ============================================
// 一键领取所有附件
// ============================================

export const claimAllAttachments = async (
  userId: number,
  characterId: number
): Promise<{ success: boolean; message: string; claimedCount: number; rewards?: { silver: number; spiritStones: number; itemCount: number } }> => {
  const collectCounts = new Map<string, number>();

  try {
    return await withTransaction(async (client) => {

    // 1. 获取所有未领取的邮件
    const mailsResult = await client.query(`
      SELECT id, attach_silver, attach_spirit_stones, attach_items
      FROM mail
      WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
        AND claimed_at IS NULL
        AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL)
        AND (expire_at IS NULL OR expire_at > NOW())
      FOR UPDATE
    `, [characterId, userId]);

    if (mailsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: true, message: '没有可领取的附件', claimedCount: 0 };
    }

    // 2. 计算总需空间
    let totalItemSlots = 0;
    const allAttachItems: MailAttachItem[] = [];
    for (const mail of mailsResult.rows) {
      if (mail.attach_items && mail.attach_items.length > 0) {
        allAttachItems.push(...(mail.attach_items as MailAttachItem[]));
      }
    }
    if (allAttachItems.length > 0) {
      totalItemSlots = await estimateRequiredSlots(client, allAttachItems);
    }

    // 3. 检查背包空间
    if (totalItemSlots > 0) {
      const inventoryInfo = await getInventoryInfoWithClient(characterId, client);
      const freeSlots = inventoryInfo.bag_capacity - inventoryInfo.bag_used;
      if (freeSlots < totalItemSlots) {
        await client.query('ROLLBACK');
        return { success: false, message: `背包空间不足，需要${totalItemSlots}格，当前剩余${freeSlots}格`, claimedCount: 0 };
      }
    }

    // 4. 汇总货币
    let totalSilver = 0;
    let totalSpiritStones = 0;
    let totalItemCount = 0;
    const mailIds: number[] = [];

    for (const mail of mailsResult.rows) {
      totalSilver += mail.attach_silver || 0;
      totalSpiritStones += mail.attach_spirit_stones || 0;
      if (mail.attach_items) {
        for (const item of mail.attach_items as MailAttachItem[]) {
          totalItemCount += item.qty;
        }
      }
      mailIds.push(mail.id);
    }

    // 5. 发放货币
    if (totalSilver > 0 || totalSpiritStones > 0) {
      await client.query(`
        UPDATE characters 
        SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW()
        WHERE id = $3
      `, [totalSilver, totalSpiritStones, characterId]);
    }

    // 6. 发放物品
    for (const mail of mailsResult.rows) {
      if (mail.attach_items && mail.attach_items.length > 0) {
        for (const attachItem of mail.attach_items as MailAttachItem[]) {
          const createResult = await createItem(
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
            await client.query('ROLLBACK');
            return { success: false, message: `物品创建失败: ${createResult.message}`, claimedCount: 0 };
          }

          const key = String(attachItem.item_def_id || '').trim();
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + Math.max(1, Math.floor(Number(attachItem.qty) || 1)));
        }
      }
    }

    // 7. 批量更新邮件状态
    await client.query(`
      UPDATE mail 
      SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()), updated_at = NOW()
      WHERE id = ANY($1)
    `, [mailIds]);

    for (const [itemDefId, qty] of collectCounts.entries()) {
      try {
        await recordCollectItemEvent(characterId, itemDefId, qty);
      } catch {}
    }

    return {
      success: true,
      message: `成功领取${mailIds.length}封邮件附件`,
      claimedCount: mailIds.length,
      rewards: { silver: totalSilver, spiritStones: totalSpiritStones, itemCount: totalItemCount }
    };
    });

  } catch (error) {
    console.error('一键领取失败:', error);
    return { success: false, message: '领取失败', claimedCount: 0 };
  }
};

// ============================================
// 删除邮件
// ============================================

export const deleteMail = async (
  userId: number,
  characterId: number,
  mailId: number
): Promise<{ success: boolean; message: string }> => {
  try {
    const result = await query(`
      UPDATE mail SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 
        AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL))
        AND deleted_at IS NULL
      RETURNING id, claimed_at, attach_silver, attach_spirit_stones, attach_items
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    const mail = result.rows[0];
    const hasAttachments = mail.attach_silver > 0 || mail.attach_spirit_stones > 0 || 
                          (mail.attach_items && mail.attach_items.length > 0);

    if (hasAttachments && !mail.claimed_at) {
      // 有未领取的附件，提示用户
      return { success: true, message: '邮件已删除（附件未领取）' };
    }

    return { success: true, message: '邮件已删除' };
  } catch (error) {
    console.error('删除邮件失败:', error);
    return { success: false, message: '删除失败' };
  }
};

// ============================================
// 一键删除所有邮件
// ============================================

export const deleteAllMails = async (
  userId: number,
  characterId: number,
  onlyRead: boolean = false
): Promise<{ success: boolean; message: string; deletedCount: number }> => {
  try {
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
  } catch (error) {
    console.error('一键删除失败:', error);
    return { success: false, message: '删除失败', deletedCount: 0 };
  }
};

// ============================================
// 标记全部已读
// ============================================

export const markAllRead = async (
  userId: number,
  characterId: number
): Promise<{ success: boolean; message: string; readCount: number }> => {
  try {
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
  } catch (error) {
    console.error('标记已读失败:', error);
    return { success: false, message: '操作失败', readCount: 0 };
  }
};

// ============================================
// 获取未读邮件数量（用于红点提示）
// ============================================

export const getUnreadCount = async (
  userId: number,
  characterId: number
): Promise<{ unreadCount: number; unclaimedCount: number }> => {
  try {
    const result = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE read_at IS NULL) as unread_count,
        COUNT(*) FILTER (WHERE claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL)) as unclaimed_count
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
};
