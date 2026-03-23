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
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import type { GenerateOptions } from './equipmentService.js';
import { itemService } from './itemService.js';
import { getInventoryInfo, moveItemInstanceToBagWithStacking } from './inventory/index.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import { recordCollectItemEvent } from './taskService.js';
import { createCacheLayer } from './shared/cacheLayer.js';
import { getGameServer } from '../game/gameServer.js';
import { grantSectionRewards } from './mainQuest/grantRewards.js';
import type { RewardResult } from './mainQuest/types.js';
import {
  buildGrantRewardsInput,
  buildGrantedRewardPreview,
  hasGrantedRewardPayload,
  normalizeGrantedRewardPayload,
  type GrantedRewardPayload,
  type GrantedRewardPreviewResult,
} from './shared/rewardPayload.js';
import { getItemDefinitionsByIds } from './staticConfigLoader.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
} from './autoDisassembleRewardService.js';
import { normalizeAutoDisassembleSetting } from './autoDisassembleRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';

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
  attachRewards?: GrantedRewardPayload;
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
  attachRewards: GrantedRewardPreviewResult[];
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
  attach_rewards: unknown;
  attach_instance_ids: unknown;
  claimed_at: Date | string | null;
  expire_at: Date | string | null;
};

type ClaimInstanceRow = {
  id: number;
  item_def_id: string;
  qty: number;
  bind_type: string;
};

const MAIL_HAS_ATTACHMENTS_SQL = '(attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL)';
const MAIL_ACTIVE_SCOPE_SQL = `COALESCE(expire_at, 'infinity'::timestamptz) > NOW()`;
const MAIL_UNREAD_CACHE_REDIS_TTL_SEC = 30;
const MAIL_UNREAD_CACHE_MEMORY_TTL_MS = 5_000;

type MailScopedUnionSqlOptions = {
  selectSql: string;
  characterIdParamIndex: number;
  userIdParamIndex: number;
  commonWhereSql?: string[];
  characterWhereSql?: string[];
  userWhereSql?: string[];
  orderBySql?: string;
  limitParamIndex?: number;
};

type MailUnreadCounter = {
  totalCount: number;
  unreadCount: number;
  unclaimedCount: number;
};

type LoadMailCounterOptions = {
  characterId: number;
  userId: number;
  commonWhereSql?: string[];
};

const buildLegacyMailRewardPayload = (input: {
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailAttachItem[];
}): GrantedRewardPayload => {
  return normalizeGrantedRewardPayload({
    silver: Math.max(0, Math.floor(Number(input.attachSilver) || 0)),
    spiritStones: Math.max(0, Math.floor(Number(input.attachSpiritStones) || 0)),
    items: input.attachItems.map((item) => ({
      itemDefId: String(item.item_def_id || '').trim(),
      quantity: Math.max(0, Math.floor(Number(item.qty) || 0)),
    })),
  });
};

const buildMailPreviewRewards = (input: {
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailAttachItem[];
  attachRewardsRaw: unknown;
}): GrantedRewardPreviewResult[] => {
  const normalizedAttachRewards = normalizeGrantedRewardPayload(input.attachRewardsRaw);
  if (hasGrantedRewardPayload(normalizedAttachRewards)) {
    return buildGrantedRewardPreview(normalizedAttachRewards);
  }
  return buildGrantedRewardPreview(
    buildLegacyMailRewardPayload({
      attachSilver: input.attachSilver,
      attachSpiritStones: input.attachSpiritStones,
      attachItems: input.attachItems,
    }),
  );
};

const buildMailUnreadCacheKey = (userId: number, characterId: number): string => {
  return `${userId}:${characterId}`;
};

const parseMailUnreadCacheKey = (
  cacheKey: string,
): { userId: number; characterId: number } | null => {
  const [userIdRaw, characterIdRaw] = cacheKey.split(':', 2);
  const userId = Number(userIdRaw);
  const characterId = Number(characterIdRaw);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(characterId) || characterId <= 0) return null;
  return { userId, characterId };
};

/**
 * 生成“角色邮件 + 账号级邮件”双分支 UNION SQL。
 *
 * 作用：
 * - 把原先多处重复的 `recipient_character_id OR recipient_user_id` 判定收敛成单一 SQL 生成入口；
 * - 让 PostgreSQL 能分别命中角色分支、账号分支索引，避免大范围 OR 扫描拖慢列表/计数/一键领取。
 *
 * 输入/输出：
 * - 输入：查询列、参数位序、公共过滤条件、分支附加条件，以及可选的分支排序/分支 limit。
 * - 输出：可直接嵌入 `WITH scoped_mail AS (...)` 的 UNION ALL SQL 片段。
 *
 * 数据流：
 * mailService 各查询 -> buildRecipientScopedMailUnionSql -> CTE/scoped_mail -> 列表/计数/领取逻辑
 *
 * 关键边界条件与坑点：
 * 1. 账号级分支必须带 `recipient_character_id IS NULL`，否则角色邮件与账号邮件会重叠命中。
 * 2. 分支内排序只负责帮助索引扫描；最终对外顺序仍需在外层查询统一 `ORDER BY`。
 */
const buildRecipientScopedMailUnionSql = ({
  selectSql,
  characterIdParamIndex,
  userIdParamIndex,
  commonWhereSql = [],
  characterWhereSql = [],
  userWhereSql = [],
  orderBySql,
  limitParamIndex,
}: MailScopedUnionSqlOptions): string => {
  const buildBranchSql = (
    recipientSql: string,
    branchWhereSql: string[],
  ): string => {
    const whereSql = [recipientSql, ...commonWhereSql, ...branchWhereSql].join('\n              AND ');
    const suffixSql = [
      orderBySql,
      limitParamIndex === undefined ? undefined : `LIMIT $${limitParamIndex}`,
    ]
      .filter((segment): segment is string => typeof segment === 'string' && segment.length > 0)
      .join('\n            ');

    return `(
            SELECT ${selectSql}
            FROM mail
            WHERE ${whereSql}
            ${suffixSql}
          )`;
  };

  return [
    buildBranchSql(`recipient_character_id = $${characterIdParamIndex}`, characterWhereSql),
    buildBranchSql(
      `recipient_user_id = $${userIdParamIndex}
              AND recipient_character_id IS NULL`,
      userWhereSql,
    ),
  ].join('\n          UNION ALL\n');
};

const loadMailCounter = async ({
  characterId,
  userId,
  commonWhereSql = [],
}: LoadMailCounterOptions): Promise<MailUnreadCounter> => {
  const scopedMailUnionSql = buildRecipientScopedMailUnionSql({
    selectSql: `
              COUNT(*)::bigint AS total_count,
              (COUNT(*) FILTER (WHERE read_at IS NULL))::bigint AS unread_count,
              (COUNT(*) FILTER (WHERE claimed_at IS NULL AND ${MAIL_HAS_ATTACHMENTS_SQL}))::bigint AS unclaimed_count`,
    characterIdParamIndex: 1,
    userIdParamIndex: 2,
    commonWhereSql,
  });

  const result = await query(
    `
      WITH scoped_mail_counter AS (
        ${scopedMailUnionSql}
      )
      SELECT
        COALESCE(SUM(total_count), 0)::bigint AS total_count,
        COALESCE(SUM(unread_count), 0)::bigint AS unread_count,
        COALESCE(SUM(unclaimed_count), 0)::bigint AS unclaimed_count
      FROM scoped_mail_counter
    `,
    [characterId, userId],
  );

  const row = (result.rows[0] ?? {}) as {
    total_count?: string | number;
    unread_count?: string | number;
    unclaimed_count?: string | number;
  };

  return {
    totalCount: Math.max(0, Math.floor(Number(row.total_count) || 0)),
    unreadCount: Math.max(0, Math.floor(Number(row.unread_count) || 0)),
    unclaimedCount: Math.max(0, Math.floor(Number(row.unclaimed_count) || 0)),
  };
};

const loadMailUnreadCounter = async (cacheKey: string): Promise<MailUnreadCounter | null> => {
  const parsedKey = parseMailUnreadCacheKey(cacheKey);
  if (!parsedKey) return null;

  return loadMailCounter({
    characterId: parsedKey.characterId,
    userId: parsedKey.userId,
    commonWhereSql: [
      'deleted_at IS NULL',
      MAIL_ACTIVE_SCOPE_SQL,
    ],
  });
};

const mailUnreadCounterCache = createCacheLayer<string, MailUnreadCounter>({
  keyPrefix: 'mail:unread:',
  redisTtlSec: MAIL_UNREAD_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: MAIL_UNREAD_CACHE_MEMORY_TTL_MS,
  loader: loadMailUnreadCounter,
});

// ============================================
// MailService Class
// ============================================

class MailService {
  private async cleanupExpiredMailForRecipient(
    userId: number,
    characterId: number,
  ): Promise<void> {
    await Promise.all([
      query(
        `
          UPDATE mail
          SET deleted_at = NOW(), updated_at = NOW()
          WHERE recipient_character_id = $1
            AND deleted_at IS NULL
            AND expire_at IS NOT NULL
            AND expire_at < NOW()
        `,
        [characterId],
      ),
      query(
        `
          UPDATE mail
          SET deleted_at = NOW(), updated_at = NOW()
          WHERE recipient_user_id = $1
            AND recipient_character_id IS NULL
            AND deleted_at IS NULL
            AND expire_at IS NOT NULL
            AND expire_at < NOW()
        `,
        [userId],
      ),
    ]);
  }

  /**
   * 生成“邮件收件人可见范围”SQL 片段。
   *
   * 作用：
   * - 统一封装“角色邮件 + 账号级邮件”判定，避免同一业务规则在多个查询中重复拼接。
   * - 通过参数位序显式传入，兼容不同 SQL 场景（例如第 1/2 位或第 2/3 位参数）。
   *
   * 输入/输出：
   * - 输入：角色ID参数位序、用户ID参数位序（均为 1-based SQL 参数序号）
   * - 输出：可直接拼接到 WHERE 的布尔表达式字符串
   *
   * 边界条件：
   * 1) 仅负责条件表达式，不负责参数值有效性校验；调用方需保证传入为正整数位序。
   * 2) 该表达式包含 `recipient_character_id IS NULL` 分支，确保账号级邮件与角色邮件互斥，不会重复命中。
   */
  private buildRecipientScopeSql(characterIdParamIndex: number, userIdParamIndex: number): string {
    return `(recipient_character_id = $${characterIdParamIndex} OR (recipient_user_id = $${userIdParamIndex} AND recipient_character_id IS NULL))`;
  }

  /**
   * 统一生成邮件未读计数缓存键。
   *
   * 作用：
   * - 把“账号级邮件 + 角色级邮件”的可见范围绑定到同一缓存键格式；
   * - 让读取与失效都只依赖单一键规则，避免不同写路径各自拼字符串。
   *
   * 输入/输出：
   * - 输入：userId、characterId
   * - 输出：稳定的 Redis/内存缓存键后缀
   *
   * 边界条件：
   * 1) 仅接受正整数 userId/characterId，调用方应保证鉴权完成后再进入。
   * 2) 键格式必须保持稳定，否则旧缓存将无法被统一失效。
   */
  private buildUnreadCounterCacheKey(userId: number, characterId: number): string {
    return buildMailUnreadCacheKey(userId, characterId);
  }

  /**
   * 失效指定账号下所有角色可见的邮件红点缓存。
   *
   * 作用：
   * - 统一处理“账号级邮件”对全部角色视图的影响；
   * - 避免发邮件/已读/删除等多个写路径分别手写查角色 + 删缓存逻辑。
   *
   * 输入/输出：
   * - 输入：recipientUserId，和可选的直接命中角色ID
   * - 输出：无；保证该账号相关邮件计数缓存被清理
   *
   * 边界条件：
   * 1) 若账号当前没有角色记录，则仅失效显式传入的角色键。
   * 2) 账号级邮件会被所有该账号角色共享，因此必须按 userId 扩散失效，不能只删当前 characterId。
   */
  private async invalidateUnreadCounterCacheForRecipient(
    recipientUserId: number,
    recipientCharacterId?: number,
  ): Promise<void> {
    const characterIds = new Set<number>();
    const directCharacterId = recipientCharacterId;
    if (
      typeof directCharacterId === 'number'
      && Number.isInteger(directCharacterId)
      && directCharacterId > 0
    ) {
      characterIds.add(directCharacterId);
    }

    const characterResult = await query(
      `
        SELECT id
        FROM characters
        WHERE user_id = $1
      `,
      [recipientUserId],
    );

    for (const row of characterResult.rows as Array<{ id?: unknown }>) {
      const characterId = Number(row.id);
      if (!Number.isInteger(characterId) || characterId <= 0) continue;
      characterIds.add(characterId);
    }

    if (characterIds.size <= 0) return;

    await Promise.all(
      Array.from(characterIds, (characterId) =>
        mailUnreadCounterCache.invalidate(
          this.buildUnreadCounterCacheKey(recipientUserId, characterId),
        ),
      ),
    );
  }

  /**
   * 推送当前在线角色可见的邮件红点状态。
   *
   * 作用：
   * - 统一把首页邮件红点收敛为 socket 单一来源，避免前端靠轮询 `/mail/unread` 才能看到变化。
   * - 只推当前在线角色视角的计数，保证角色级邮件不会错误污染同账号的其他角色视图。
   *
   * 输入/输出：
   * - 输入：recipientUserId
   * - 输出：无；副作用是向当前在线用户发送 `mail:update`
   *
   * 边界条件：
   * 1) 账号离线或当前没有在线角色时直接跳过，邮件写操作本身不能依赖 socket 成功。
   * 2) 邮件缓存必须先失效再读取最新计数，否则会把旧红点重新推回前端。
   */
  async pushUnreadCounterUpdateToUser(recipientUserId: number): Promise<void> {
    try {
      const gameServer = getGameServer();
      const activeCharacterId = gameServer.getActiveCharacterIdByUserId(recipientUserId);
      if (!activeCharacterId) return;

      const counter = await this.getUnreadCount(recipientUserId, activeCharacterId);
      gameServer.emitToUser(recipientUserId, 'mail:update', counter);
    } catch (error) {
      console.error(`[mail] 推送未读计数失败: userId=${recipientUserId}`, error);
    }
  }

  /**
   * 统一处理“邮件未读缓存失效 + 首页红点推送”。
   *
   * 作用：
   * - 把所有会影响邮件红点的写路径收敛成单一入口，避免 send/read/claim/delete 各处重复写一套缓存失效与 socket 推送。
   * - 保证首页看到的邮件红点和 `/mail/unread` 共用同一份缓存读模型。
   *
   * 输入/输出：
   * - 输入：recipientUserId，以及可选的 recipientCharacterId
   * - 输出：无；保证缓存已失效，并尝试向在线用户推送最新红点
   *
   * 边界条件：
   * 1) 账号级邮件会影响该账号所有角色缓存，因此这里不能只清当前 characterId 的键。
   * 2) 推送失败时不允许抛出到业务写路径，避免成功的邮件写入被 socket 提示反向打断。
   */
  private async invalidateUnreadCounterAndNotifyRecipient(
    recipientUserId: number,
    recipientCharacterId?: number,
  ): Promise<void> {
    await this.invalidateUnreadCounterCacheForRecipient(recipientUserId, recipientCharacterId);
    await this.pushUnreadCounterUpdateToUser(recipientUserId);
  }

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
   * 估算“实例附件”领取时实际新增占用的背包格子数。
   *
   * 作用：
   * - 复用背包堆叠规则（同 item_def_id + bind_type）；
   * - 在真正写库前先计算是否会占新格，避免“先写后失败”导致事务内出现中间状态。
   *
   * 输入/输出：
   * - 输入：角色ID、已锁定的实例附件列表（必须来自 mail 位置）
   * - 输出：该批实例在当前背包下最少需要新增的格子数量
   *
   * 边界条件：
   * 1) 仅 `stack_max > 1` 的实例会尝试消耗已有堆叠空余容量。
   * 2) 同一批附件之间允许相互堆叠（先入包实例可承接后续实例），因此结果不会高估所需格子。
   */
  private async estimateRequiredSlotsForInstanceAttachments(
    characterId: number,
    instances: ClaimInstanceRow[],
  ): Promise<number> {
    if (instances.length === 0) return 0;

    const uniqueItemDefIds = Array.from(
      new Set(
        instances
          .map((row) => String(row.item_def_id || '').trim())
          .filter((itemDefId) => itemDefId.length > 0),
      ),
    );
    if (uniqueItemDefIds.length === 0) {
      throw new Error('实例附件缺少有效 item_def_id，无法估算格子');
    }

    const defs = getItemDefinitionsByIds(uniqueItemDefIds);
    const stackMaxByItemDefId = new Map<string, number>();
    for (const itemDefId of uniqueItemDefIds) {
      const def = defs.get(itemDefId);
      if (!def) {
        throw new Error(`实例附件缺少物品定义: ${itemDefId}`);
      }
      stackMaxByItemDefId.set(
        itemDefId,
        Math.max(1, Math.floor(Number(def.stack_max) || 1)),
      );
    }

    const bagResult = await query(
      `
        SELECT item_def_id, bind_type, qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND item_def_id = ANY($2::varchar[])
      `,
      [characterId, uniqueItemDefIds],
    );

    const keyOf = (itemDefId: string, bindType: string): string =>
      `${itemDefId}::${bindType}`;
    const freeCapByGroup = new Map<string, number[]>();

    for (const row of bagResult.rows) {
      const itemDefId = String(row.item_def_id || '').trim();
      if (!itemDefId) continue;

      const stackMax = stackMaxByItemDefId.get(itemDefId);
      if (stackMax === undefined || stackMax <= 1) continue;

      const qty = Math.max(0, Math.floor(Number(row.qty) || 0));
      const freeCap = Math.max(0, stackMax - qty);
      if (freeCap <= 0) continue;

      const bindType = String(row.bind_type || 'none');
      const key = keyOf(itemDefId, bindType);
      const caps = freeCapByGroup.get(key) ?? [];
      caps.push(freeCap);
      freeCapByGroup.set(key, caps);
    }

    let requiredSlots = 0;
    for (const instance of instances) {
      const itemDefId = String(instance.item_def_id || '').trim();
      const bindType = String(instance.bind_type || 'none');
      const stackMax = stackMaxByItemDefId.get(itemDefId);
      if (stackMax === undefined) {
        throw new Error(`实例附件缺少堆叠配置: ${itemDefId}`);
      }
      let remainingQty = Math.max(1, Math.floor(Number(instance.qty) || 1));

      if (stackMax > 1) {
        const key = keyOf(itemDefId, bindType);
        const caps = freeCapByGroup.get(key) ?? [];
        for (let index = 0; index < caps.length && remainingQty > 0; index += 1) {
          const canUse = Math.min(remainingQty, Math.max(0, caps[index]));
          if (canUse <= 0) continue;
          caps[index] -= canUse;
          remainingQty -= canUse;
        }
        freeCapByGroup.set(key, caps);
      }

      if (remainingQty > 0) {
        requiredSlots += 1;
        if (stackMax > 1) {
          const key = keyOf(itemDefId, bindType);
          const caps = freeCapByGroup.get(key) ?? [];
          caps.push(Math.max(0, stackMax - remainingQty));
          freeCapByGroup.set(key, caps);
        }
      }
    }

    return requiredSlots;
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

  private async getMailClaimAutoDisassembleSetting(
    characterId: number,
    autoDisassemble: boolean,
  ): Promise<AutoDisassembleSetting | null> {
    if (!autoDisassemble) return null;

    const result = await query<{ auto_disassemble_rules: unknown }>(
      `
        SELECT auto_disassemble_rules
        FROM characters
        WHERE id = $1
        LIMIT 1
      `,
      [characterId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return normalizeAutoDisassembleSetting({
      enabled: true,
      rules: result.rows[0].auto_disassemble_rules,
    });
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
    const normalizedAttachRewards = normalizeGrantedRewardPayload(options.attachRewards);
    const hasNormalizedAttachRewards = hasGrantedRewardPayload(normalizedAttachRewards);

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
    if (
      hasNormalizedAttachRewards
      && (
        (options.attachSilver && options.attachSilver > 0)
        || (options.attachSpiritStones && options.attachSpiritStones > 0)
        || (options.attachItems && options.attachItems.length > 0)
      )
    ) {
      return { success: false, message: '通用奖励附件不能与旧附件字段混用' };
    }
    if (hasNormalizedAttachRewards && options.attachInstanceIds && options.attachInstanceIds.length > 0) {
      return { success: false, message: '通用奖励附件不能与实例附件混用' };
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
          attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids,
          expire_at, source, source_ref_id, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18)
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
        hasNormalizedAttachRewards ? 0 : (options.attachSilver || 0),
        hasNormalizedAttachRewards ? 0 : (options.attachSpiritStones || 0),
        hasNormalizedAttachRewards ? null : (options.attachItems ? JSON.stringify(options.attachItems) : null),
        hasNormalizedAttachRewards ? JSON.stringify(normalizedAttachRewards) : null,
        attachInstanceIds.length > 0 ? JSON.stringify(attachInstanceIds) : null,
        expireAt,
        options.source || null,
        options.sourceRefId || null,
        options.metadata ? JSON.stringify(options.metadata) : null
      ]);

      await this.invalidateUnreadCounterAndNotifyRecipient(
        options.recipientUserId,
        options.recipientCharacterId,
      );

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
    const branchLimit = pageSize + offset;
    const listScopedMailUnionSql = buildRecipientScopedMailUnionSql({
      selectSql: `
              id, sender_type, sender_name, mail_type, title, content,
              attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids,
              read_at, claimed_at, expire_at, created_at`,
      characterIdParamIndex: 1,
      userIdParamIndex: 2,
      commonWhereSql: ['deleted_at IS NULL', MAIL_ACTIVE_SCOPE_SQL],
      orderBySql: 'ORDER BY created_at DESC, id DESC',
      limitParamIndex: 5,
    });

    try {
      // 清理过期邮件（软删除）
      await this.cleanupExpiredMailForRecipient(userId, characterId);

      const [result, stats] = await Promise.all([
        query(`
          WITH scoped_mail AS (
            ${listScopedMailUnionSql}
          )
          SELECT
            id, sender_type, sender_name, mail_type, title, content,
            attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids,
            read_at, claimed_at, expire_at, created_at
          FROM scoped_mail
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4
        `, [characterId, userId, pageSize, offset, branchLimit]),
        mailUnreadCounterCache.get(
          this.buildUnreadCounterCacheKey(userId, characterId),
        ),
      ]);

      const mails: MailDto[] = result.rows.map(row => ({
        id: row.id,
        senderType: row.sender_type,
        senderName: row.sender_name,
        mailType: row.mail_type,
        title: row.title,
        content: row.content,
        attachSilver: row.attach_silver,
        attachSpiritStones: row.attach_spirit_stones,
        attachItems: this.normalizeAttachItems(row.attach_items).map((item: MailAttachItem) => ({
          ...item,
          item_def_id: String(item.item_def_id || '').trim(),
        })),
        attachRewards: buildMailPreviewRewards({
          attachSilver: Number(row.attach_silver) || 0,
          attachSpiritStones: Number(row.attach_spirit_stones) || 0,
          attachItems: this.normalizeAttachItems(row.attach_items),
          attachRewardsRaw: row.attach_rewards,
        }),
        readAt: row.read_at?.toISOString() || null,
        claimedAt: row.claimed_at?.toISOString() || null,
        expireAt: row.expire_at?.toISOString() || null,
        createdAt: row.created_at.toISOString()
      }));

      return {
        success: true,
        mails,
        total: stats?.totalCount ?? 0,
        unreadCount: stats?.unreadCount ?? 0,
        unclaimedCount: stats?.unclaimedCount ?? 0,
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
        AND ${this.buildRecipientScopeSql(2, 3)}
        AND deleted_at IS NULL
      RETURNING id
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);
    return { success: true, message: '已读' };
  }

  // ============================================
  // 领取附件（核心功能 - 严格校验）
  // ============================================

  @Transactional
  async claimAttachments(
    userId: number,
    characterId: number,
    mailId: number,
    shouldInvalidateUnreadCounter: boolean = true,
    autoDisassemble: boolean = false,
  ): Promise<{ success: boolean; message: string; rewards?: RewardResult[] }> {
    const collectCounts = new Map<string, number>();

    // 1. 先获取角色背包互斥锁，统一“背包锁 → 邮件行锁”的顺序，避免并发领取形成锁等待链。
    await lockCharacterInventoryMutex(characterId);

    // 2. 获取邮件并锁定（NOWAIT 避免锁等待拖到 statement_timeout）。
    let mailResult: { rows: ClaimMailRow[] };
    try {
      const lockedMailResult = await query<ClaimMailRow>(`
        SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, claimed_at, expire_at
        FROM mail
        WHERE id = $1
          AND ${this.buildRecipientScopeSql(2, 3)}
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
    const attachRewards = normalizeGrantedRewardPayload(mail.attach_rewards);
    const hasAttachRewards = hasGrantedRewardPayload(attachRewards);
    const hasCurrency = mail.attach_silver > 0 || mail.attach_spirit_stones > 0;
    const attachItems = this.normalizeAttachItems(mail.attach_items);
    const attachInstanceIds = this.normalizeAttachInstanceIds(mail.attach_instance_ids);
    const hasItems = attachItems.length > 0 || attachInstanceIds.length > 0;

    if (!hasAttachRewards && !hasCurrency && !hasItems) {
      return { success: false, message: '该邮件没有附件' };
    }

    let lockedInstanceRows: ClaimInstanceRow[] = [];
    let requiredSlots = 0;
    let freeSlots = 0;

    // 6. 检查背包空间（如果有物品附件）
    if (hasAttachRewards) {
      const rewardAttachItems: MailAttachItem[] = (attachRewards.items ?? []).map((item) => ({
        item_def_id: item.itemDefId,
        qty: item.quantity,
      }));
      if (rewardAttachItems.length > 0) {
        requiredSlots = await this.estimateRequiredSlots(rewardAttachItems);
        const inventoryInfo = await getInventoryInfo(characterId);
        freeSlots = inventoryInfo.bag_capacity - inventoryInfo.bag_used;
        if (freeSlots < requiredSlots) {
          return { success: false, message: `背包空间不足，需要${requiredSlots}格，当前剩余${freeSlots}格` };
        }
      }
    } else if (hasItems) {
      if (attachInstanceIds.length > 0) {
        const lockedInstanceResult = await query<ClaimInstanceRow>(
          `
            SELECT id, item_def_id, qty, bind_type
            FROM item_instance
            WHERE id = ANY($1::bigint[])
              AND owner_user_id = $2
              AND owner_character_id = $3
              AND location = 'mail'
            FOR UPDATE
          `,
          [attachInstanceIds, userId, characterId],
        );
        lockedInstanceRows = lockedInstanceResult.rows;

        const lockedIds = new Set(lockedInstanceRows.map((row) => Number(row.id)));
        for (const attachInstanceId of attachInstanceIds) {
          if (!lockedIds.has(attachInstanceId)) {
            return { success: false, message: '邮件附件状态异常' };
          }
        }

        if (
          lockedInstanceRows.some(
            (row) => String(row.item_def_id || '').trim().length === 0,
          )
        ) {
          return { success: false, message: '邮件附件状态异常' };
        }

        const uniqueItemDefIds = Array.from(
          new Set(
            lockedInstanceRows
              .map((row) => String(row.item_def_id || '').trim())
              .filter((itemDefId) => itemDefId.length > 0),
          ),
        );
        if (uniqueItemDefIds.length === 0) {
          return { success: false, message: '邮件附件状态异常' };
        }
        const defs = getItemDefinitionsByIds(uniqueItemDefIds);
        if (defs.size !== uniqueItemDefIds.length) {
          return { success: false, message: '物品配置不存在' };
        }

        requiredSlots = await this.estimateRequiredSlotsForInstanceAttachments(
          characterId,
          lockedInstanceRows,
        );
      } else {
        requiredSlots = await this.estimateRequiredSlots(attachItems);
      }

      const inventoryInfo = await getInventoryInfo(characterId);
      freeSlots = inventoryInfo.bag_capacity - inventoryInfo.bag_used;
      if (freeSlots < requiredSlots) {
        return { success: false, message: `背包空间不足，需要${requiredSlots}格，当前剩余${freeSlots}格` };
      }
    }

    let rewards: RewardResult[] = [];
    let claimedInstanceIds: number[] = [];
    const autoDisassembleSetting = await this.getMailClaimAutoDisassembleSetting(
      characterId,
      autoDisassemble,
    );

    // 7. 发放奖励
    if (hasAttachRewards) {
      rewards = await grantSectionRewards(
        userId,
        characterId,
        buildGrantRewardsInput(attachRewards),
        {
          obtainedFrom: 'mail',
          obtainedRefId: String(mailId),
          autoDisassembleSetting: autoDisassembleSetting ?? undefined,
        },
      );
    } else if (hasItems || hasCurrency) {
      if (hasCurrency) {
        await query(`
          UPDATE characters
          SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW()
          WHERE id = $3
        `, [mail.attach_silver, mail.attach_spirit_stones, characterId]);

        if (mail.attach_silver > 0) rewards.push({ type: 'silver', amount: mail.attach_silver });
        if (mail.attach_spirit_stones > 0) rewards.push({ type: 'spirit_stones', amount: mail.attach_spirit_stones });
      }

      if (attachInstanceIds.length > 0) {
        // 实例附件领取：复用库存模块“实例入包自动堆叠”逻辑，避免同规则在邮件/坊市重复实现。
        for (const attachInstanceId of attachInstanceIds) {
          const moveResult = await moveItemInstanceToBagWithStacking(
            characterId,
            attachInstanceId,
            {
              expectedSourceLocation: 'mail',
              expectedOwnerUserId: userId,
            },
          );
          if (!moveResult.success) {
            throw new Error(`实例附件入包失败: ${moveResult.message}`);
          }
          if (moveResult.itemId !== undefined) {
            claimedInstanceIds.push(moveResult.itemId);
          }
        }

        for (const row of lockedInstanceRows) {
          const key = String(row.item_def_id || '').trim();
          const qty = Math.max(1, Math.floor(Number(row.qty) || 1));
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + qty);
          rewards.push({
            type: 'item',
            itemDefId: key,
            quantity: qty,
          });
        }
      } else {
        const attachItemDefIds = Array.from(
          new Set(
            attachItems
              .map((attachItem) => String(attachItem.item_def_id || '').trim())
              .filter((itemDefId) => itemDefId.length > 0),
          ),
        );
        const attachItemDefs = getItemDefinitionsByIds(attachItemDefIds);

        for (const attachItem of attachItems) {
          if (autoDisassembleSetting) {
            const itemDefId = String(attachItem.item_def_id || '').trim();
            const itemDef = attachItemDefs.get(itemDefId);
            const autoDisassembleResult = await grantRewardItemWithAutoDisassemble({
              characterId,
              itemDefId,
              qty: Math.max(1, Math.floor(Number(attachItem.qty) || 1)),
              bindType: attachItem.options?.bindType,
              itemMeta: {
                itemName: String(attachItem.item_name || '').trim() || itemDefId,
                category: String(itemDef?.category || ''),
                subCategory: typeof itemDef?.sub_category === 'string' ? itemDef.sub_category : null,
                effectDefs: itemDef?.effect_defs,
                qualityRank: resolveQualityRankFromName(itemDef?.quality, 1),
                disassemblable: typeof itemDef?.disassemblable === 'boolean' ? itemDef.disassemblable : null,
              },
              autoDisassembleSetting,
              sourceObtainedFrom: 'mail',
              createItem: async (params) => {
                return itemService.createItem(
                  userId,
                  characterId,
                  params.itemDefId,
                  params.qty,
                  {
                    location: 'bag',
                    bindType: params.bindType,
                    obtainedFrom: params.obtainedFrom,
                    ...(params.equipOptions !== undefined
                      ? { equipOptions: params.equipOptions as GenerateOptions }
                      : {}),
                  },
                );
              },
              addSilver: async (targetCharacterId, silverAmount) => {
                await query(
                  `
                    UPDATE characters
                    SET silver = silver + $1, updated_at = NOW()
                    WHERE id = $2
                  `,
                  [silverAmount, targetCharacterId],
                );
                return { success: true, message: 'ok' };
              },
              sourceEquipOptions: attachItem.options?.equipOptions,
            });

            for (const grantedItem of autoDisassembleResult.grantedItems) {
              if (grantedItem.itemIds.length > 0) {
                claimedInstanceIds.push(...grantedItem.itemIds);
              }
              collectCounts.set(
                grantedItem.itemDefId,
                (collectCounts.get(grantedItem.itemDefId) || 0) + grantedItem.qty,
              );
              rewards.push({
                type: 'item',
                itemDefId: grantedItem.itemDefId,
                quantity: grantedItem.qty,
                itemName:
                  typeof attachItemDefs.get(grantedItem.itemDefId)?.name === 'string'
                    ? String(attachItemDefs.get(grantedItem.itemDefId)?.name).trim() || undefined
                    : undefined,
              });
            }
            if (autoDisassembleResult.gainedSilver > 0) {
              rewards.push({ type: 'silver', amount: autoDisassembleResult.gainedSilver });
            }
            continue;
          }

          const createResult = await itemService.createItem(
            userId,
            characterId,
            attachItem.item_def_id,
            attachItem.qty,
            {
              location: 'bag',
              bindType: attachItem.options?.bindType,
              obtainedFrom: 'mail',
              equipOptions: attachItem.options?.equipOptions
            }
          );

          if (!createResult.success) {
            return { success: false, message: `物品创建失败: ${createResult.message}` };
          }

          if (createResult.itemIds) {
            claimedInstanceIds.push(...createResult.itemIds);
          }

          const key = String(attachItem.item_def_id || '').trim();
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + Math.max(1, Math.floor(Number(attachItem.qty) || 1)));
          rewards.push({
            type: 'item',
            itemDefId: key,
            quantity: Math.max(1, Math.floor(Number(attachItem.qty) || 1)),
            itemName: String(attachItem.item_name || '').trim() || undefined,
          });
        }
      }
    }

    // 8. 更新邮件状态
    await query(`
      UPDATE mail
      SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()),
          attach_instance_ids = $1, updated_at = NOW()
      WHERE id = $2
    `, [JSON.stringify(claimedInstanceIds), mailId]);

    for (const [itemDefId, qty] of collectCounts.entries()) {
      await recordCollectItemEvent(characterId, itemDefId, qty);
    }

    if (shouldInvalidateUnreadCounter) {
      await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);
    }

    return { success: true, message: '领取成功', rewards };
  }

  // ============================================
  // 一键领取所有附件
  // ============================================

  async claimAllAttachments(
    userId: number,
    characterId: number,
    autoDisassemble: boolean = false,
  ): Promise<{
    success: boolean;
    message: string;
    claimedCount: number;
    skippedCount?: number;
    rewards?: { silver: number; spiritStones: number; itemCount: number };
  }> {
    // 1. 获取所有可尝试领取的邮件（不做总量空间校验，改为逐封领取）
    // 说明：此方法不包裹单一大事务，避免批量领取时长时间持有 mail 行锁与背包互斥锁。
    const claimableMailUnionSql = buildRecipientScopedMailUnionSql({
      selectSql: 'id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, created_at',
      characterIdParamIndex: 1,
      userIdParamIndex: 2,
      commonWhereSql: [
        'deleted_at IS NULL',
        'claimed_at IS NULL',
        MAIL_HAS_ATTACHMENTS_SQL,
        MAIL_ACTIVE_SCOPE_SQL,
      ],
      orderBySql: 'ORDER BY created_at ASC, id ASC',
    });
    const mailsResult = await query(
      `
      WITH candidate_mail AS (
        ${claimableMailUnionSql}
      )
      SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids
      FROM candidate_mail
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
      const attachRewards = normalizeGrantedRewardPayload(row.attach_rewards);
      const attachItems = this.normalizeAttachItems(row.attach_items);
      const attachInstanceIds = this.normalizeAttachInstanceIds(row.attach_instance_ids);
      const hasAttachRewards = hasGrantedRewardPayload(attachRewards);
      const hasCurrency = Number(row.attach_silver) > 0 || Number(row.attach_spirit_stones) > 0;
      const hasItems = attachItems.length > 0 || attachInstanceIds.length > 0;
      if (!hasAttachRewards && !hasCurrency && !hasItems) continue;

      const claimResult = await this.claimAttachments(
        userId,
        characterId,
        mailId,
        false,
        autoDisassemble,
      );

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
      for (const reward of claimResult.rewards ?? []) {
        if (reward.type === 'silver') {
          totalSilver += Math.max(0, Math.floor(Number(reward.amount) || 0));
          continue;
        }
        if (reward.type === 'spirit_stones') {
          totalSpiritStones += Math.max(0, Math.floor(Number(reward.amount) || 0));
          continue;
        }
        if (reward.type === 'item') {
          totalItemCount += Math.max(0, Math.floor(Number(reward.quantity) || 0));
        }
      }
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

    await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);

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
        AND ${this.buildRecipientScopeSql(2, 3)}
        AND deleted_at IS NULL
      RETURNING id, claimed_at, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);

    const mail = result.rows[0];
    const hasAttachments = mail.attach_silver > 0 || mail.attach_spirit_stones > 0 ||
                          this.normalizeAttachItems(mail.attach_items).length > 0 ||
                          hasGrantedRewardPayload(normalizeGrantedRewardPayload(mail.attach_rewards)) ||
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
      WHERE ${this.buildRecipientScopeSql(1, 2)}
        AND deleted_at IS NULL
    `;

    if (onlyRead) {
      sql += ` AND read_at IS NOT NULL`;
    }

    const result = await query(sql + ' RETURNING id', [characterId, userId]);

    if (result.rows.length > 0) {
      await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);
    }

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
      WHERE ${this.buildRecipientScopeSql(1, 2)}
        AND deleted_at IS NULL
        AND read_at IS NULL
      RETURNING id
    `, [characterId, userId]);

    if (result.rows.length > 0) {
      await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);
    }

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
      const cachedCounter = await mailUnreadCounterCache.get(
        this.buildUnreadCounterCacheKey(userId, characterId),
      );
      return {
        unreadCount: cachedCounter?.unreadCount ?? 0,
        unclaimedCount: cachedCounter?.unclaimedCount ?? 0,
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
