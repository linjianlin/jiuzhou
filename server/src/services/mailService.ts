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
import { afterTransactionCommit, query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import type { GenerateOptions } from './equipmentService.js';
import { getInventoryInfo, moveItemInstancesToBagWithStacking } from './inventory/index.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import { recordCollectItemEventsBatch } from './taskService.js';
import { createCacheLayer } from './shared/cacheLayer.js';
import { getGameServerIfInitialized } from '../game/gameServer.js';
import { grantSectionRewards } from './mainQuest/grantRewards.js';
import type { RewardResult } from './mainQuest/types.js';
import {
  buildGrantRewardsInput,
  hasGrantedRewardPayload,
  normalizeGrantedRewardPayload,
  type GrantedRewardPayload,
  type GrantedRewardPreviewResult,
} from './shared/rewardPayload.js';
import { applyCharacterRewardDeltas, createCharacterRewardDelta } from './shared/characterRewardSettlement.js';
import { getItemDefinitionsByIds } from './staticConfigLoader.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
} from './autoDisassembleRewardService.js';
import { normalizeAutoDisassembleSetting } from './autoDisassembleRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import {
  applyMailCounterDeltas,
  buildMailCounterClaimDelta,
  buildMailCounterDeleteDelta,
  buildMailCounterInsertDelta,
  buildMailCounterReadDelta,
  buildMailCounterStateFromRow,
  loadMailCounterSnapshot,
  type MailCounterDeltaInput,
  type MailCounterStateRow,
} from './shared/mailCounterStore.js';
import { enqueueCharacterItemGrant } from './shared/characterItemGrantDeltaService.js';
import {
  loadProjectedCharacterItemInstances,
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstancesByLocation,
  type JsonValue,
} from './shared/characterItemInstanceMutationService.js';
import {
  buildMailAttachmentPreviewRewards,
  type MailInstanceAttachmentPreviewItem,
} from './shared/mailAttachmentPreview.js';
import { resolveRewardItemDisplayMetaMap } from './shared/rewardDisplay.js';

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
    equipOptions?: GenerateOptions;
    metadata?: Record<string, string | number | boolean | null | undefined>;
    quality?: string;
    qualityRank?: number;
  };
}

const resolveMailClaimRewardItemName = (
  itemDefId: string,
  preferredName: string | null | undefined,
  itemDisplayMetaById: ReadonlyMap<string, { name: string }>,
): string | undefined => {
  const normalizedPreferredName = typeof preferredName === 'string' ? preferredName.trim() : '';
  if (normalizedPreferredName) {
    return normalizedPreferredName;
  }

  const normalizedItemDefId = String(itemDefId || '').trim();
  if (!normalizedItemDefId) {
    return undefined;
  }

  const normalizedResolvedName = itemDisplayMetaById.get(normalizedItemDefId)?.name.trim() || '';
  return normalizedResolvedName || undefined;
};

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

export interface BulkMailRecipient {
  recipientUserId: number;
  recipientCharacterId?: number;
}

export interface SendBulkMailOptions {
  recipients: BulkMailRecipient[];
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
  hasAttachments: boolean;
  hasClaimableAttachments: boolean;
  readAt: string | null;
  claimedAt: string | null;
  expireAt: string | null;
  createdAt: string;
}

type ClaimMailRow = {
  id: number;
  recipient_user_id: number;
  recipient_character_id: number | null;
  attach_silver: number;
  attach_spirit_stones: number;
  attach_items: MailCounterStateRow['attach_items'];
  attach_rewards: MailCounterStateRow['attach_rewards'];
  attach_instance_ids: MailCounterStateRow['attach_instance_ids'];
  source: string | null;
  read_at: Date | string | null;
  claimed_at: Date | string | null;
  expire_at: Date | string | null;
};

type ClaimInstanceRow = {
  id: number;
  item_def_id: string;
  qty: number;
  bind_type: string;
};

type NormalizedMailRecipient = {
  recipientUserId: number;
  recipientCharacterId: number | null;
};

type PreparedMailInsertPayload = {
  senderType: SenderType;
  senderUserId: number | null;
  senderCharacterId: number | null;
  senderName: string;
  mailType: MailType;
  title: string;
  content: string;
  attachSilver: number;
  attachSpiritStones: number;
  attachItemsJson: string | null;
  attachRewardsJson: string | null;
  attachInstanceIds: number[];
  attachInstanceIdsJson: string | null;
  expireAt: Date | null;
  source: string | null;
  sourceRefId: string | null;
  metadataJson: string | null;
  isUnclaimed: boolean;
};

type PrepareMailInsertPayloadResult =
  | { success: true; payload: PreparedMailInsertPayload }
  | { success: false; message: string };

const MAIL_HAS_ATTACHMENTS_SQL = '(attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL)';
const MAIL_ACTIVE_SCOPE_SQL = `COALESCE(expire_at, 'infinity'::timestamptz) > NOW()`;
export const CLAIM_MAIL_STATUS_UPDATE_SQL = `
      UPDATE mail
      SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
    `;
const MAIL_UNREAD_CACHE_REDIS_TTL_SEC = 300;
const MAIL_UNREAD_CACHE_MEMORY_TTL_MS = 5_000;
const MAIL_UNREAD_CACHE_MIN_REDIS_TTL_SEC = 1;
const MAIL_UNREAD_CACHE_MIN_MEMORY_TTL_MS = 250;
const MAIL_EXPIRE_CLEANUP_THROTTLE_MS = 60_000;
const MAIL_UNREAD_PUSH_COALESCE_MS = 500;
const MAIL_BULK_INSERT_BATCH_SIZE = 500;

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

type MailUnreadCounterCacheEntry = MailUnreadCounter & {
  nextActiveExpireAtMs: number | null;
};

const isJsonRecord = (value: JsonValue | null): value is { [key: string]: JsonValue } => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const normalizeMailMetadataAttachmentPreviewItems = (
  value: JsonValue | null,
): MailInstanceAttachmentPreviewItem[] => {
  if (!isJsonRecord(value)) {
    return [];
  }

  const rawItems = value.attachmentPreviewItems;
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const normalized: MailInstanceAttachmentPreviewItem[] = [];
  for (const rawItem of rawItems) {
    if (!isJsonRecord(rawItem)) {
      continue;
    }

    const itemDefId = String(rawItem.itemDefId || '').trim();
    const itemName = String(rawItem.itemName || '').trim();
    const quantity = Math.max(0, Math.floor(Number(rawItem.quantity) || 0));
    if (!itemDefId || quantity <= 0) {
      continue;
    }

    normalized.push({
      itemDefId,
      ...(itemName ? { itemName } : {}),
      quantity,
    });
  }

  return normalized;
};

const shouldTreatAttachItemsAsInstancePreviewOnly = (input: {
  source: string | null;
  attachItems: readonly MailAttachItem[];
  attachInstanceIds: readonly number[];
}): boolean => {
  return input.source === 'market'
    && input.attachItems.length > 0
    && input.attachInstanceIds.length > 0;
};

type LoadMailCounterOptions = {
  characterId: number;
  userId: number;
  commonWhereSql?: string[];
};

type MailExpireCleanupState = {
  nextAllowedAtMs: number;
  runningPromise: Promise<void> | null;
};

type MailUnreadPushState = {
  timer: NodeJS.Timeout | null;
  runningPromise: Promise<void> | null;
  pending: boolean;
};

const mailExpireCleanupState = new Map<string, MailExpireCleanupState>();
const mailUnreadPushState = new Map<number, MailUnreadPushState>();

const buildMailUnreadCacheKey = (userId: number, characterId: number): string => {
  return `${userId}:${characterId}`;
};

const buildMailExpireCleanupKey = buildMailUnreadCacheKey;

const chunkMailRecipients = (
  recipients: readonly NormalizedMailRecipient[],
  chunkSize: number,
): NormalizedMailRecipient[][] => {
  const chunks: NormalizedMailRecipient[][] = [];
  for (let index = 0; index < recipients.length; index += chunkSize) {
    chunks.push(recipients.slice(index, index + chunkSize));
  }
  return chunks;
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

const resolveMailUnreadCounterCacheTtl = (
  counter: MailUnreadCounterCacheEntry,
): {
  redisTtlSec: number;
  memoryTtlMs: number;
} => {
  if (counter.nextActiveExpireAtMs === null) {
    return {
      redisTtlSec: MAIL_UNREAD_CACHE_REDIS_TTL_SEC,
      memoryTtlMs: MAIL_UNREAD_CACHE_MEMORY_TTL_MS,
    };
  }

  const remainingMs = counter.nextActiveExpireAtMs - Date.now();
  if (remainingMs <= 0) {
    return {
      redisTtlSec: MAIL_UNREAD_CACHE_MIN_REDIS_TTL_SEC,
      memoryTtlMs: MAIL_UNREAD_CACHE_MIN_MEMORY_TTL_MS,
    };
  }

  return {
    redisTtlSec: Math.max(
      MAIL_UNREAD_CACHE_MIN_REDIS_TTL_SEC,
      Math.min(MAIL_UNREAD_CACHE_REDIS_TTL_SEC, Math.floor(remainingMs / 1000)),
    ),
    memoryTtlMs: Math.max(
      MAIL_UNREAD_CACHE_MIN_MEMORY_TTL_MS,
      Math.min(MAIL_UNREAD_CACHE_MEMORY_TTL_MS, remainingMs),
    ),
  };
};

const loadMailCounter = async ({
  characterId,
  userId,
  commonWhereSql = [],
}: LoadMailCounterOptions): Promise<MailUnreadCounterCacheEntry> => {
  const nextExpireUnionSql = buildRecipientScopedMailUnionSql({
    selectSql: 'expire_at, id',
    characterIdParamIndex: 1,
    userIdParamIndex: 2,
    commonWhereSql: [
      ...commonWhereSql,
      'expire_at IS NOT NULL',
    ],
    orderBySql: 'ORDER BY expire_at ASC, id ASC',
    limitParamIndex: 3,
  });

  const [counterSnapshot, nextExpireResult] = await Promise.all([
    loadMailCounterSnapshot(userId, characterId),
    query<{ next_active_expire_at?: Date | string | null }>(
      `
        WITH next_active_mail AS (
          ${nextExpireUnionSql}
        )
        SELECT MIN(expire_at) AS next_active_expire_at
        FROM next_active_mail
      `,
      [characterId, userId, 1],
    ),
  ]);

  const nextActiveExpireAtRaw = nextExpireResult.rows[0]?.next_active_expire_at;
  const nextActiveExpireAtMs = nextActiveExpireAtRaw
    ? new Date(String(nextActiveExpireAtRaw)).getTime()
    : null;

  return {
    totalCount: counterSnapshot.totalCount,
    unreadCount: counterSnapshot.unreadCount,
    unclaimedCount: counterSnapshot.unclaimedCount,
    nextActiveExpireAtMs: Number.isFinite(nextActiveExpireAtMs) ? nextActiveExpireAtMs : null,
  };
};

const loadMailUnreadCounter = async (cacheKey: string): Promise<MailUnreadCounterCacheEntry | null> => {
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

const mailUnreadCounterCache = createCacheLayer<string, MailUnreadCounterCacheEntry>({
  keyPrefix: 'mail:unread:',
  redisTtlSec: MAIL_UNREAD_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: MAIL_UNREAD_CACHE_MEMORY_TTL_MS,
  loader: loadMailUnreadCounter,
  ttlResolver: ({ value }) => resolveMailUnreadCounterCacheTtl(value),
});

// ============================================
// MailService Class
// ============================================

class MailService {
  @Transactional
  private async cleanupExpiredMailForRecipient(
    userId: number,
    characterId: number,
  ): Promise<void> {
    const [characterExpiredResult, userExpiredResult] = await Promise.all([
      query<MailCounterStateRow>(
        `
          UPDATE mail
          SET deleted_at = NOW(), updated_at = NOW()
          WHERE recipient_character_id = $1
            AND deleted_at IS NULL
            AND expire_at IS NOT NULL
            AND expire_at < NOW()
          RETURNING
            recipient_user_id,
            recipient_character_id,
            read_at,
            claimed_at,
            attach_silver,
            attach_spirit_stones,
            attach_items,
            attach_rewards,
            attach_instance_ids
        `,
        [characterId],
      ),
      query<MailCounterStateRow>(
        `
          UPDATE mail
          SET deleted_at = NOW(), updated_at = NOW()
          WHERE recipient_user_id = $1
            AND recipient_character_id IS NULL
            AND deleted_at IS NULL
            AND expire_at IS NOT NULL
            AND expire_at < NOW()
          RETURNING
            recipient_user_id,
            recipient_character_id,
            read_at,
            claimed_at,
            attach_silver,
            attach_spirit_stones,
            attach_items,
            attach_rewards,
            attach_instance_ids
        `,
        [userId],
      ),
    ]);

    await this.applyMailCounterDeltaInputs([
      ...characterExpiredResult.rows.map((row) => {
        const state = buildMailCounterStateFromRow(row);
        return state ? buildMailCounterDeleteDelta(state) : null;
      }),
      ...userExpiredResult.rows.map((row) => {
        const state = buildMailCounterStateFromRow(row);
        return state ? buildMailCounterDeleteDelta(state) : null;
      }),
    ]);

    if (characterExpiredResult.rows.length > 0 || userExpiredResult.rows.length > 0) {
      await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);
    }
  }

  /**
   * 调度“收件人作用域”的过期邮件清理任务。
   *
   * 作用：
   * - 把过期软删除从同步读链路中摘出来，避免 `getMailList` 每次都阻塞等待两条 `UPDATE mail`；
   * - 以“用户ID + 角色ID”为单一调度键做节流与并发去重，避免同一收件人短时间重复清理。
   *
   * 输入/输出：
   * - 输入：userId、characterId
   * - 输出：无；内部以 best-effort 方式异步执行清理，失败仅记录日志，不影响列表读取。
   *
   * 数据流/状态流：
   * - getMailList -> scheduleExpiredMailCleanupForRecipient -> 内存节流状态
   *   -> cleanupExpiredMailForRecipient -> 更新 mail.deleted_at。
   *
   * 关键边界条件与坑点：
   * 1) 可见性不依赖软删除完成时机，因为列表/计数查询本身已带 `MAIL_ACTIVE_SCOPE_SQL` 过滤，过期邮件不会重新暴露给用户。
   * 2) 节流只作用于清理任务，不影响发信/读信/领附件后的未读缓存失效；两条链路职责必须分开。
   */
  private scheduleExpiredMailCleanupForRecipient(
    userId: number,
    characterId: number,
  ): void {
    const cacheKey = buildMailExpireCleanupKey(userId, characterId);
    const currentState = mailExpireCleanupState.get(cacheKey);
    const nowMs = Date.now();

    if (currentState?.runningPromise) {
      return;
    }
    if (currentState && currentState.nextAllowedAtMs > nowMs) {
      return;
    }

    const runningPromise = this.cleanupExpiredMailForRecipient(userId, characterId)
      .catch((error) => {
        console.error(
          `[mail] 异步清理过期邮件失败: userId=${userId}, characterId=${characterId}`,
          error,
        );
      })
      .finally(() => {
        const latestState = mailExpireCleanupState.get(cacheKey);
        if (!latestState || latestState.runningPromise !== runningPromise) {
          return;
        }
        mailExpireCleanupState.set(cacheKey, {
          nextAllowedAtMs: Date.now() + MAIL_EXPIRE_CLEANUP_THROTTLE_MS,
          runningPromise: null,
        });
      });

    mailExpireCleanupState.set(cacheKey, {
      nextAllowedAtMs: nowMs + MAIL_EXPIRE_CLEANUP_THROTTLE_MS,
      runningPromise,
    });
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

  private normalizeBulkMailRecipients(
    recipients: readonly BulkMailRecipient[],
  ): NormalizedMailRecipient[] | null {
    if (recipients.length <= 0) {
      return [];
    }

    const recipientMap = new Map<string, NormalizedMailRecipient>();

    for (const recipient of recipients) {
      const recipientUserId = Math.floor(Number(recipient.recipientUserId));
      if (!Number.isInteger(recipientUserId) || recipientUserId <= 0) {
        return null;
      }

      const rawRecipientCharacterId = recipient.recipientCharacterId;
      const recipientCharacterId =
        rawRecipientCharacterId === undefined
          ? null
          : Math.floor(Number(rawRecipientCharacterId));

      if (
        recipientCharacterId !== null
        && (!Number.isInteger(recipientCharacterId) || recipientCharacterId <= 0)
      ) {
        return null;
      }

      const dedupeKey = `${recipientUserId}:${recipientCharacterId ?? 0}`;
      if (!recipientMap.has(dedupeKey)) {
        recipientMap.set(dedupeKey, {
          recipientUserId,
          recipientCharacterId,
        });
      }
    }

    return Array.from(recipientMap.values());
  }

  /**
   * 批量失效多个收件对象可见的邮件红点缓存。
   *
   * 作用：
   * - 把单封邮件与批量发奖共用的缓存失效逻辑收口到同一入口，避免 bulk send 再退回 N 次逐账号查角色。
   * - 统一处理账号级邮件对全部角色视图的影响，保证计数缓存与 `mail_counter` 同步失效。
   *
   * 输入/输出：
   * - 输入：归一化后的收件对象列表（`recipientUserId + recipientCharacterId`）
   * - 输出：无；保证这些账号相关的邮件计数缓存被清理
   *
   * 边界条件：
   * 1) 账号当前没有角色记录时，仍要保留显式传入的 `(userId, characterId)` 直达键失效，避免事务内写入的新角色邮件留脏缓存。
   * 2) 账号级邮件会影响该账号全部角色，因此必须先按 `userId` 扩散出所有角色键，再统一删缓存。
   */
  private async invalidateUnreadCounterCacheForRecipients(
    recipients: readonly NormalizedMailRecipient[],
  ): Promise<void> {
    if (recipients.length <= 0) {
      return;
    }

    const unreadCacheKeys = new Set<string>();
    const recipientUserIds = Array.from(
      new Set(recipients.map((recipient) => recipient.recipientUserId)),
    );

    for (const recipient of recipients) {
      if (recipient.recipientCharacterId !== null) {
        unreadCacheKeys.add(
          this.buildUnreadCounterCacheKey(
            recipient.recipientUserId,
            recipient.recipientCharacterId,
          ),
        );
      }
    }

    const characterResult = await query<{ user_id: number | string; id: number | string }>(
      `
        SELECT user_id, id
        FROM characters
        WHERE user_id = ANY($1::int[])
      `,
      [recipientUserIds],
    );

    for (const row of characterResult.rows) {
      const userId = Number(row.user_id);
      const characterId = Number(row.id);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      if (!Number.isInteger(characterId) || characterId <= 0) continue;
      unreadCacheKeys.add(this.buildUnreadCounterCacheKey(userId, characterId));
    }

    if (unreadCacheKeys.size <= 0) {
      return;
    }

    await Promise.all(
      Array.from(unreadCacheKeys, (cacheKey) => mailUnreadCounterCache.invalidate(cacheKey)),
    );
  }

  /**
   * 失效指定账号下所有角色可见的邮件红点缓存。
   *
   * 作用：
   * - 兼容现有单收件人调用点，继续复用批量缓存失效入口。
   * - 让 read/claim/delete 这类单封写路径不需要感知批处理实现细节。
   *
   * 输入/输出：
   * - 输入：recipientUserId，和可选的直接命中角色ID
   * - 输出：无；保证该账号相关邮件计数缓存被清理
   *
   * 边界条件：
   * 1) 这里不重复实现任何查角色逻辑，单收件人与批量收件必须共用同一条缓存失效链路。
   * 2) `recipientCharacterId` 允许为空，表示账号级邮件只按 user 维度扩散。
   */
  private async invalidateUnreadCounterCacheForRecipient(
    recipientUserId: number,
    recipientCharacterId?: number,
  ): Promise<void> {
    await this.invalidateUnreadCounterCacheForRecipients([
      {
        recipientUserId,
        recipientCharacterId: recipientCharacterId ?? null,
      },
    ]);
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
   * 2) 脚本/离线工具环境可能根本没有初始化 GameServer，这里必须静默跳过，不能因为缺少 socket 容器污染运维日志。
   * 3) 邮件缓存必须先失效再读取最新计数，否则会把旧红点重新推回前端。
   */
  async pushUnreadCounterUpdateToUser(recipientUserId: number): Promise<void> {
    try {
      const gameServer = getGameServerIfInitialized();
      if (!gameServer) return;
      const activeCharacterId = gameServer.getActiveCharacterIdByUserId(recipientUserId);
      if (!activeCharacterId) return;

      const counter = await this.getUnreadCount(recipientUserId, activeCharacterId);
      gameServer.emitToUser(recipientUserId, 'mail:update', counter);
    } catch (error) {
      console.error(`[mail] 推送未读计数失败: userId=${recipientUserId}`, error);
    }
  }

  /**
   * 合并短时间内重复的邮件红点刷新请求。
   *
   * 作用：
   * - 把同一用户在连续邮件写操作后的多次“立即重算”压缩成一次，避免 burst 场景下反复执行同一条计数 SQL。
   * - 保留 `pushUnreadCounterUpdateToUser` 作为立即推送入口，给登录补发等首屏场景继续直接使用。
   *
   * 输入/输出：
   * - 输入：recipientUserId
   * - 输出：无；内部通过定时器和进行中的 Promise 串行化同一用户的推送
   *
   * 数据流/状态流：
   * 邮件写操作提交后 -> scheduleUnreadCounterUpdateToUser -> 定时合并
   * -> pushUnreadCounterUpdateToUser -> socket `mail:update`
   *
   * 关键边界条件与坑点：
   * 1) 这里只合并同进程内、同 userId 的短时间刷新，不负责跨进程协调；跨进程仍依赖缓存层减压。
   * 2) 若上一轮推送尚未完成，新的刷新只会把 `pending` 置回 true，待当前轮次结束后再补一次，避免并发重算。
   */
  private scheduleUnreadCounterUpdateToUser(recipientUserId: number): void {
    const currentState = mailUnreadPushState.get(recipientUserId) ?? {
      timer: null,
      runningPromise: null,
      pending: false,
    };
    currentState.pending = true;
    mailUnreadPushState.set(recipientUserId, currentState);

    if (currentState.timer || currentState.runningPromise) {
      return;
    }

    currentState.timer = setTimeout(() => {
      const scheduledState = mailUnreadPushState.get(recipientUserId);
      if (!scheduledState) {
        return;
      }
      scheduledState.timer = null;

      const runningPromise = (async (): Promise<void> => {
        if (!scheduledState.pending) {
          return;
        }
        scheduledState.pending = false;
        await this.pushUnreadCounterUpdateToUser(recipientUserId);
      })()
        .catch((error) => {
          console.error(`[mail] 合并推送未读计数失败: userId=${recipientUserId}`, error);
        })
        .finally(() => {
          const latestState = mailUnreadPushState.get(recipientUserId);
          if (!latestState || latestState.runningPromise !== runningPromise) {
            return;
          }
          latestState.runningPromise = null;
          if (latestState.pending) {
            this.scheduleUnreadCounterUpdateToUser(recipientUserId);
            return;
          }
          if (!latestState.timer) {
            mailUnreadPushState.delete(recipientUserId);
          }
        });

      scheduledState.runningPromise = runningPromise;
    }, MAIL_UNREAD_PUSH_COALESCE_MS);
  }

  /**
   * 统一调度“邮件未读缓存失效 + 首页红点推送”。
   *
   * 作用：
   * - 把所有会影响邮件红点的写路径收敛成单一入口，避免 send/read/claim/delete 各处重复写一套缓存失效与 socket 推送。
   * - 保证首页看到的邮件红点和 `/mail/unread` 共用同一份缓存读模型。
   * - 对事务内调用统一延后到提交后执行，避免持有背包 advisory lock / mail 行锁时再触发慢计数查询。
   *
   * 输入/输出：
   * - 输入：recipientUserId，以及可选的 recipientCharacterId
   * - 输出：无；保证缓存已失效，并尝试向在线用户推送最新红点
   *
   * 边界条件：
   * 1) 账号级邮件会影响该账号所有角色缓存，因此这里不能只清当前 characterId 的键。
   * 2) 提交后副作用必须复用同一入口，避免事务方法和非事务方法出现两套通知时机。
   */
  private async invalidateUnreadCounterAndNotifyRecipient(
    recipientUserId: number,
    recipientCharacterId?: number,
  ): Promise<void> {
    await this.invalidateUnreadCounterAndNotifyRecipients([
      {
        recipientUserId,
        recipientCharacterId: recipientCharacterId ?? null,
      },
    ]);
  }

  /**
   * 统一调度“批量邮件未读缓存失效 + 首页红点推送”。
   *
   * 作用：
   * - 给 bulk send 提供单一提交后副作用入口，避免一批补偿邮件拆成 N 次 after-commit 回调。
   * - 统一对同一批收件人做缓存失效与在线红点调度，减少重复 userId 去重与查角色成本。
   *
   * 输入/输出：
   * - 输入：归一化后的收件对象列表
   * - 输出：无；保证这批账号的邮件缓存已失效，并尝试推送最新红点
   *
   * 边界条件：
   * 1) 必须在事务提交后执行，不能在批量 insert 期间混入额外的读计数查询。
   * 2) 同一 userId 可能因为多封角色邮件重复出现，推送调度必须先去重。
   */
  private async invalidateUnreadCounterAndNotifyRecipients(
    recipients: readonly NormalizedMailRecipient[],
  ): Promise<void> {
    await afterTransactionCommit(async () => {
      await this.invalidateUnreadCounterCacheForRecipients(recipients);

      for (const recipientUserId of new Set(
        recipients.map((recipient) => recipient.recipientUserId),
      )) {
        this.scheduleUnreadCounterUpdateToUser(recipientUserId);
      }
    });
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

    const bagRows = (await loadProjectedCharacterItemInstancesByLocation(characterId, 'bag'))
      .filter((row) => uniqueItemDefIds.includes(String(row.item_def_id || '').trim()))
      .map((row) => ({
        item_def_id: row.item_def_id,
        bind_type: row.bind_type,
        qty: row.qty,
      }));

    const keyOf = (itemDefId: string, bindType: string): string =>
      `${itemDefId}::${bindType}`;
    const freeCapByGroup = new Map<string, number[]>();

    for (const row of bagRows) {
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
          ? (() => {
              const optionsSource = optionsRaw as Record<string, string | number | boolean | object | null | undefined>;
              return {
              bindType:
                typeof optionsSource.bindType === 'string'
                  ? String(optionsSource.bindType).trim()
                  : undefined,
              equipOptions: optionsSource.equipOptions as GenerateOptions | undefined,
              metadata:
                (() => {
                  const metadata = optionsSource.metadata;
                  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
                  const metadataSource = metadata as Record<string, string | number | boolean | null | undefined>;
                  const entries = Object.entries(metadataSource)
                    .filter(([, value]) => value !== undefined)
                    .sort(([left], [right]) => left.localeCompare(right));
                  return entries.length > 0
                    ? Object.fromEntries(entries) as Record<string, string | number | boolean | null>
                    : undefined;
                })(),
              quality:
                typeof optionsSource.quality === 'string'
                  ? String(optionsSource.quality).trim() || undefined
                  : undefined,
              qualityRank:
                (() => {
                  const value = Number(optionsSource.qualityRank);
                  if (!Number.isFinite(value)) return undefined;
                  const normalizedValue = Math.max(1, Math.floor(value));
                  return normalizedValue;
                })(),
            };
            })()
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

  /**
   * 把多行邮件旧状态归并成计数增量。
   *
   * 作用：
   * - 把发信/已读/领取/删除/过期清理等写路径统一收敛到 `mail_counter` 增量协议；
   * - 避免每条写路径各自手写“账号级/角色级邮件该怎么扣减”的重复逻辑。
   *
   * 输入/输出：
   * - 输入：已解析好的计数增量列表。
   * - 输出：无；内部统一调用共享 `mail_counter` upsert 入口。
   *
   * 边界条件：
   * 1) 这里不做缓存失效，缓存与 socket 推送仍由 `invalidateUnreadCounterAndNotifyRecipient` 统一处理。
   * 2) 空增量列表会被直接跳过，避免无意义写库。
   */
  private async applyMailCounterDeltaInputs(
    deltas: readonly (MailCounterDeltaInput | null)[],
  ): Promise<void> {
    const effectiveDeltas = deltas.filter(
      (delta): delta is MailCounterDeltaInput => delta !== null,
    );
    if (effectiveDeltas.length <= 0) {
      return;
    }
    await applyMailCounterDeltas(effectiveDeltas);
  }

  /**
   * 统一准备邮件写库载荷。
   *
   * 作用：
   * - 把单封发送与批量发送共用的标题/正文/附件校验收口到同一入口，避免两条写路径各维护一套规则。
   * - 预先把 JSONB 附件、过期时间和“是否有未领取附件”计算好，降低写库阶段的重复判断。
   *
   * 输入/输出：
   * - 输入：除收件人以外的发件参数。
   * - 输出：可直接用于 `INSERT INTO mail` 的标准化载荷，或校验失败消息。
   *
   * 边界条件：
   * 1) `attachRewards` 与旧附件字段/实例附件仍然互斥，任何混用都必须在这里直接拦截。
   * 2) 这里不校验收件人是否存在；收件范围由调用方负责确定，避免把筛选逻辑散到邮件服务里。
   */
  private prepareMailInsertPayload(
    options: Omit<SendBulkMailOptions, 'recipients'>,
  ): PrepareMailInsertPayloadResult {
    const normalizedAttachRewards = normalizeGrantedRewardPayload(options.attachRewards);
    const hasNormalizedAttachRewards = hasGrantedRewardPayload(normalizedAttachRewards);

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
    if (options.attachItems && options.attachItems.length > 0 && options.attachInstanceIds && options.attachInstanceIds.length > 0) {
      return { success: false, message: '定义附件不能与实例附件混用' };
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

    let expireAt: Date | null = null;
    if (options.expireDays && options.expireDays > 0) {
      expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + options.expireDays);
    }

    return {
      success: true,
      payload: {
        senderType: options.senderType || 'system',
        senderUserId: options.senderUserId || null,
        senderCharacterId: options.senderCharacterId || null,
        senderName: options.senderName || '系统',
        mailType: options.mailType || 'normal',
        title: options.title,
        content: options.content,
        attachSilver: hasNormalizedAttachRewards ? 0 : (options.attachSilver || 0),
        attachSpiritStones: hasNormalizedAttachRewards ? 0 : (options.attachSpiritStones || 0),
        attachItemsJson: hasNormalizedAttachRewards
          ? null
          : (options.attachItems ? JSON.stringify(options.attachItems) : null),
        attachRewardsJson: hasNormalizedAttachRewards
          ? JSON.stringify(normalizedAttachRewards)
          : null,
        attachInstanceIds,
        attachInstanceIdsJson:
          attachInstanceIds.length > 0 ? JSON.stringify(attachInstanceIds) : null,
        expireAt,
        source: options.source || null,
        sourceRefId: options.sourceRefId || null,
        metadataJson: options.metadata ? JSON.stringify(options.metadata) : null,
        isUnclaimed:
          hasNormalizedAttachRewards
          || (options.attachSilver ?? 0) > 0
          || (options.attachSpiritStones ?? 0) > 0
          || (options.attachItems?.length ?? 0) > 0
          || attachInstanceIds.length > 0,
      },
    };
  }

  /**
   * 批量写入同模板邮件。
   *
   * 作用：
   * - 用单条 `INSERT ... SELECT` 承接一批同模板邮件，避免全服补偿退化成逐条插入。
   * - 通过固定批大小分片，控制单次 JSON 参数和事务内 SQL 文本规模。
   *
   * 输入/输出：
   * - 输入：归一化后的收件对象列表，以及标准化好的邮件写库载荷。
   * - 输出：无；成功时保证整批邮件都已写入 `mail`。
   *
   * 边界条件：
   * 1) 分片只影响单条 SQL 的体积，不改变“当前事务内全部成功或全部失败”的语义。
   * 2) 收件人列表必须先去重，否则同一角色会重复收到补偿。
   */
  private async insertBulkMailRows(
    recipients: readonly NormalizedMailRecipient[],
    payload: PreparedMailInsertPayload,
  ): Promise<void> {
    for (const chunk of chunkMailRecipients(recipients, MAIL_BULK_INSERT_BATCH_SIZE)) {
      await query(
        `
          INSERT INTO mail (
            recipient_user_id,
            recipient_character_id,
            sender_type,
            sender_user_id,
            sender_character_id,
            sender_name,
            mail_type,
            title,
            content,
            attach_silver,
            attach_spirit_stones,
            attach_items,
            attach_rewards,
            attach_instance_ids,
            expire_at,
            source,
            source_ref_id,
            metadata
          )
          SELECT
            input_rows.recipient_user_id,
            input_rows.recipient_character_id,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12::jsonb,
            $13,
            $14,
            $15,
            $16,
            $17
          FROM jsonb_to_recordset($1::jsonb) AS input_rows (
            recipient_user_id bigint,
            recipient_character_id bigint
          )
        `,
        [
          JSON.stringify(
            chunk.map((recipient) => ({
              recipient_user_id: recipient.recipientUserId,
              recipient_character_id: recipient.recipientCharacterId,
            })),
          ),
          payload.senderType,
          payload.senderUserId,
          payload.senderCharacterId,
          payload.senderName,
          payload.mailType,
          payload.title,
          payload.content,
          payload.attachSilver,
          payload.attachSpiritStones,
          payload.attachItemsJson,
          payload.attachRewardsJson,
          payload.attachInstanceIdsJson,
          payload.expireAt,
          payload.source,
          payload.sourceRefId,
          payload.metadataJson,
        ],
      );
    }
  }

  // ============================================
  // 发送邮件
  // ============================================

  @Transactional
  async sendMail(options: SendMailOptions): Promise<{ success: boolean; mailId?: number; message: string }> {
    const preparedPayloadResult = this.prepareMailInsertPayload({
      senderType: options.senderType,
      senderUserId: options.senderUserId,
      senderCharacterId: options.senderCharacterId,
      senderName: options.senderName,
      mailType: options.mailType,
      title: options.title,
      content: options.content,
      attachSilver: options.attachSilver,
      attachSpiritStones: options.attachSpiritStones,
      attachItems: options.attachItems,
      attachRewards: options.attachRewards,
      attachInstanceIds: options.attachInstanceIds,
      expireDays: options.expireDays,
      source: options.source,
      sourceRefId: options.sourceRefId,
      metadata: options.metadata,
    });
    if (!preparedPayloadResult.success) {
      return { success: false, message: preparedPayloadResult.message };
    }

    const normalizedRecipient = this.normalizeBulkMailRecipients([
      {
        recipientUserId: options.recipientUserId,
        recipientCharacterId: options.recipientCharacterId,
      },
    ]);
    if (!normalizedRecipient) {
      return { success: false, message: '收件人无效' };
    }

    const recipient = normalizedRecipient[0];
    const preparedPayload = preparedPayloadResult.payload;

    const insertCounterDelta = buildMailCounterInsertDelta({
      recipientUserId: recipient.recipientUserId,
      recipientCharacterId: recipient.recipientCharacterId,
      isUnread: true,
      isUnclaimed: preparedPayload.isUnclaimed,
    });

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
        recipient.recipientUserId,
        recipient.recipientCharacterId,
        preparedPayload.senderType,
        preparedPayload.senderUserId,
        preparedPayload.senderCharacterId,
        preparedPayload.senderName,
        preparedPayload.mailType,
        preparedPayload.title,
        preparedPayload.content,
        preparedPayload.attachSilver,
        preparedPayload.attachSpiritStones,
        preparedPayload.attachItemsJson,
        preparedPayload.attachRewardsJson,
        preparedPayload.attachInstanceIdsJson,
        preparedPayload.expireAt,
        preparedPayload.source,
        preparedPayload.sourceRefId,
        preparedPayload.metadataJson,
      ]);

      await this.applyMailCounterDeltaInputs([insertCounterDelta]);

      await this.invalidateUnreadCounterAndNotifyRecipients(normalizedRecipient);

      return { success: true, mailId: result.rows[0].id, message: '邮件发送成功' };
    } catch (error) {
      console.error('发送邮件失败:', error);
      return { success: false, message: '发送邮件失败' };
    }
  }

  /**
   * 批量发送同模板邮件。
   *
   * 作用：
   * - 承接全服补偿、批量运营发奖等“一批收件人共享同一封邮件模板”的场景，避免脚本层逐条调用 `sendMail`。
   * - 统一复用单封邮件的附件校验、`mail_counter` 增量协议与提交后红点刷新逻辑。
   *
   * 输入/输出：
   * - 输入：收件人列表，以及共享的标题/正文/附件配置。
   * - 输出：成功时返回实际发送数量；失败时返回统一错误消息。
   *
   * 边界条件：
   * 1) 这里不会为每个收件人单独返回 mailId；批量入口强调吞吐和一致性，追踪应改用 `sourceRefId`/`metadata`。
   * 2) 收件人列表会先去重，避免同一角色因为上游筛选重复而收到多封相同补偿。
   */
  @Transactional
  async sendBulkMail(
    options: SendBulkMailOptions,
  ): Promise<{ success: boolean; sentCount: number; message: string }> {
    const normalizedRecipients = this.normalizeBulkMailRecipients(options.recipients);
    if (!normalizedRecipients) {
      return { success: false, sentCount: 0, message: '收件人无效' };
    }
    if (normalizedRecipients.length <= 0) {
      return { success: false, sentCount: 0, message: '收件人不能为空' };
    }

    const preparedPayloadResult = this.prepareMailInsertPayload({
      senderType: options.senderType,
      senderUserId: options.senderUserId,
      senderCharacterId: options.senderCharacterId,
      senderName: options.senderName,
      mailType: options.mailType,
      title: options.title,
      content: options.content,
      attachSilver: options.attachSilver,
      attachSpiritStones: options.attachSpiritStones,
      attachItems: options.attachItems,
      attachRewards: options.attachRewards,
      attachInstanceIds: options.attachInstanceIds,
      expireDays: options.expireDays,
      source: options.source,
      sourceRefId: options.sourceRefId,
      metadata: options.metadata,
    });
    if (!preparedPayloadResult.success) {
      return { success: false, sentCount: 0, message: preparedPayloadResult.message };
    }

    try {
      await this.insertBulkMailRows(normalizedRecipients, preparedPayloadResult.payload);
      await this.applyMailCounterDeltaInputs(
        normalizedRecipients.map((recipient) =>
          buildMailCounterInsertDelta({
            recipientUserId: recipient.recipientUserId,
            recipientCharacterId: recipient.recipientCharacterId,
            isUnread: true,
            isUnclaimed: preparedPayloadResult.payload.isUnclaimed,
          }),
        ),
      );
      await this.invalidateUnreadCounterAndNotifyRecipients(normalizedRecipients);

      return {
        success: true,
        sentCount: normalizedRecipients.length,
        message: `批量邮件发送成功（${normalizedRecipients.length}封）`,
      };
    } catch (error) {
      console.error('批量发送邮件失败:', error);
      return { success: false, sentCount: 0, message: '批量发送邮件失败' };
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
              attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, source, metadata,
              read_at, claimed_at, expire_at, created_at`,
      characterIdParamIndex: 1,
      userIdParamIndex: 2,
      commonWhereSql: ['deleted_at IS NULL', MAIL_ACTIVE_SCOPE_SQL],
      orderBySql: 'ORDER BY created_at DESC, id DESC',
      limitParamIndex: 5,
    });

    try {
      const [result, stats] = await Promise.all([
        query(`
          WITH scoped_mail AS (
            ${listScopedMailUnionSql}
          )
          SELECT
            id, sender_type, sender_name, mail_type, title, content,
            attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, source, metadata,
            read_at, claimed_at, expire_at, created_at
          FROM scoped_mail
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4
        `, [characterId, userId, pageSize, offset, branchLimit]),
        mailUnreadCounterCache.get(
          this.buildUnreadCounterCacheKey(userId, characterId),
        ),
      ]);

      const normalizedAttachItemsList = result.rows.map((row) => this.normalizeAttachItems(row.attach_items));
      const normalizedAttachRewardsList = result.rows.map((row) => normalizeGrantedRewardPayload(row.attach_rewards));
      const normalizedAttachInstanceIdList = result.rows.map((row) => this.normalizeAttachInstanceIds(row.attach_instance_ids));
      const metadataPreviewItemsList = result.rows.map((row) => normalizeMailMetadataAttachmentPreviewItems(row.metadata ?? null));
      const attachInstanceIdSet = new Set<number>();
      for (const attachInstanceIds of normalizedAttachInstanceIdList) {
        for (const attachInstanceId of attachInstanceIds) {
          attachInstanceIdSet.add(attachInstanceId);
        }
      }

      const instancePreviewById = new Map<number, MailInstanceAttachmentPreviewItem>();
      if (attachInstanceIdSet.size > 0) {
        const projectedItems = await loadProjectedCharacterItemInstances(characterId);
        for (const projectedItem of projectedItems) {
          if (!attachInstanceIdSet.has(projectedItem.id)) {
            continue;
          }
          if (projectedItem.location !== 'mail') {
            continue;
          }
          instancePreviewById.set(projectedItem.id, {
            itemDefId: String(projectedItem.item_def_id || '').trim(),
            itemName: undefined,
            quantity: Math.max(0, Math.floor(Number(projectedItem.qty) || 0)),
          });
        }
      }

      const mails: MailDto[] = result.rows.map((row, index) => {
        const attachItems = normalizedAttachItemsList[index];
        const attachRewardsPayload = normalizedAttachRewardsList[index];
        const attachInstanceIds = normalizedAttachInstanceIdList[index];
        const metadataPreviewItems = metadataPreviewItemsList[index];
        const resolvedInstancePreviewItems = attachInstanceIds
          .map((attachInstanceId) => instancePreviewById.get(attachInstanceId))
          .filter(
            (
              preview,
            ): preview is MailInstanceAttachmentPreviewItem => preview !== undefined,
          );
        const treatAttachItemsAsPreviewOnly = shouldTreatAttachItemsAsInstancePreviewOnly({
          source: typeof row.source === 'string' ? row.source : null,
          attachItems,
          attachInstanceIds,
        });
        const previewAttachItems = metadataPreviewItems.length > 0 && treatAttachItemsAsPreviewOnly
          ? []
          : attachItems;
        const previewInstanceItems = metadataPreviewItems.length > 0
          ? metadataPreviewItems
          : (treatAttachItemsAsPreviewOnly ? [] : resolvedInstancePreviewItems);
        const previewRewards = buildMailAttachmentPreviewRewards({
          attachSilver: Number(row.attach_silver) || 0,
          attachSpiritStones: Number(row.attach_spirit_stones) || 0,
          attachItems: previewAttachItems,
          attachRewardsRaw: row.attach_rewards,
          attachInstanceItems: previewInstanceItems,
        });
        const hasAttachRewards = hasGrantedRewardPayload(attachRewardsPayload);
        const hasCurrency = Number(row.attach_silver) > 0 || Number(row.attach_spirit_stones) > 0;
        const hasClaimableItemAttachments = !treatAttachItemsAsPreviewOnly && attachItems.length > 0;
        const hasClaimableInstanceAttachments = attachInstanceIds.length > 0
          && resolvedInstancePreviewItems.length === attachInstanceIds.length;
        const hasAttachments = previewRewards.length > 0
          || hasAttachRewards
          || hasCurrency
          || attachItems.length > 0
          || attachInstanceIds.length > 0;
        const hasClaimableAttachments = row.claimed_at === null && (
          hasAttachRewards
          || hasCurrency
          || hasClaimableItemAttachments
          || hasClaimableInstanceAttachments
        );

        return {
          id: row.id,
          senderType: row.sender_type,
          senderName: row.sender_name,
          mailType: row.mail_type,
          title: row.title,
          content: row.content,
          attachSilver: row.attach_silver,
          attachSpiritStones: row.attach_spirit_stones,
          attachItems: attachItems.map((item: MailAttachItem) => ({
            ...item,
            item_def_id: String(item.item_def_id || '').trim(),
          })),
          attachRewards: previewRewards,
          hasAttachments,
          hasClaimableAttachments,
          readAt: row.read_at?.toISOString() || null,
          claimedAt: row.claimed_at?.toISOString() || null,
          expireAt: row.expire_at?.toISOString() || null,
          createdAt: row.created_at.toISOString(),
        };
      });

      this.scheduleExpiredMailCleanupForRecipient(userId, characterId);

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

  @Transactional
  async readMail(
    userId: number,
    characterId: number,
    mailId: number
  ): Promise<{ success: boolean; message: string }> {
    const result = await query<MailCounterStateRow>(`
      WITH target_mail AS (
        SELECT
          recipient_user_id,
          recipient_character_id,
          read_at,
          claimed_at,
          attach_silver,
          attach_spirit_stones,
          attach_items,
          attach_rewards,
          attach_instance_ids
        FROM mail
        WHERE id = $1
          AND ${this.buildRecipientScopeSql(2, 3)}
          AND deleted_at IS NULL
        FOR UPDATE
      )
      UPDATE mail
      SET read_at = COALESCE(mail.read_at, NOW()),
          updated_at = NOW()
      FROM target_mail
      WHERE mail.id = $1
      RETURNING
        target_mail.recipient_user_id,
        target_mail.recipient_character_id,
        target_mail.read_at,
        target_mail.claimed_at,
        target_mail.attach_silver,
        target_mail.attach_spirit_stones,
        target_mail.attach_items,
        target_mail.attach_rewards,
        target_mail.attach_instance_ids
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    const readState = buildMailCounterStateFromRow(result.rows[0]);
    await this.applyMailCounterDeltaInputs([
      readState ? buildMailCounterReadDelta(readState) : null,
    ]);
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

    // 1. 获取邮件并锁定（NOWAIT 避免锁等待拖到 statement_timeout）。
    let mailResult: { rows: ClaimMailRow[] };
    try {
      const lockedMailResult = await query<ClaimMailRow>(`
        SELECT
          id,
          recipient_user_id,
          recipient_character_id,
          attach_silver,
          attach_spirit_stones,
          attach_items,
          attach_rewards,
          attach_instance_ids,
          source,
          read_at,
          claimed_at,
          expire_at
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

    // 2. 检查是否已领取
    if (mail.claimed_at) {
      return { success: false, message: '附件已领取' };
    }

    // 3. 检查是否过期
    if (mail.expire_at && new Date(mail.expire_at) < new Date()) {
      return { success: false, message: '邮件已过期' };
    }

    // 4. 检查是否有附件
    const attachRewards = normalizeGrantedRewardPayload(mail.attach_rewards);
    const hasAttachRewards = hasGrantedRewardPayload(attachRewards);
    const hasCurrency = mail.attach_silver > 0 || mail.attach_spirit_stones > 0;
    const attachItems = this.normalizeAttachItems(mail.attach_items);
    const attachInstanceIds = this.normalizeAttachInstanceIds(mail.attach_instance_ids);
    const treatAttachItemsAsPreviewOnly = shouldTreatAttachItemsAsInstancePreviewOnly({
      source: typeof mail.source === 'string' ? mail.source : null,
      attachItems,
      attachInstanceIds,
    });
    const effectiveAttachItems = treatAttachItemsAsPreviewOnly ? [] : attachItems;
    const hasItems = effectiveAttachItems.length > 0 || attachInstanceIds.length > 0;

    if (!hasAttachRewards && !hasCurrency && !hasItems) {
      return { success: false, message: '该邮件没有附件' };
    }

    let lockedInstanceRows: ClaimInstanceRow[] = [];
    if (attachInstanceIds.length > 0) {
      // 只有“保留原实例属性”的附件仍需要同步入包，因此只为这一类领取持有背包互斥锁并做容量校验。
      await lockCharacterInventoryMutex(characterId);
      const projectedInstances = await Promise.all(
        attachInstanceIds.map((attachInstanceId) =>
          loadProjectedCharacterItemInstanceById(characterId, attachInstanceId),
        ),
      );
      lockedInstanceRows = projectedInstances
        .filter((row): row is NonNullable<(typeof projectedInstances)[number]> => {
          return row !== null
            && row.owner_user_id === userId
            && row.owner_character_id === characterId
            && row.location === 'mail';
        })
        .map((row) => ({
          id: row.id,
          item_def_id: row.item_def_id,
          qty: row.qty,
          bind_type: row.bind_type,
        }));

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

      const requiredSlots = await this.estimateRequiredSlotsForInstanceAttachments(
        characterId,
        lockedInstanceRows,
      );
      const inventoryInfo = await getInventoryInfo(characterId);
      const bagCapacity = Number(inventoryInfo.bag_capacity) || 0;
      const bagUsed = Number(inventoryInfo.bag_used) || 0;
      const freeSlots = Math.max(0, bagCapacity - bagUsed);
      if (freeSlots < requiredSlots) {
        return { success: false, message: `背包空间不足，需要${requiredSlots}格，当前剩余${freeSlots}格` };
      }
    }

    const rewardItemDisplayMetaById = resolveRewardItemDisplayMetaMap([
      ...lockedInstanceRows.map((row) => String(row.item_def_id || '').trim()),
      ...effectiveAttachItems.map((attachItem) => String(attachItem.item_def_id || '').trim()),
    ]);

    let rewards: RewardResult[] = [];
    let claimedInstanceIds: number[] = [];
    const autoDisassembleSetting = await this.getMailClaimAutoDisassembleSetting(
      characterId,
      autoDisassemble,
    );
    const rewardDelta = createCharacterRewardDelta();

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
        rewardDelta.silver += Math.max(0, Math.floor(Number(mail.attach_silver) || 0));
        rewardDelta.spiritStones += Math.max(0, Math.floor(Number(mail.attach_spirit_stones) || 0));

        if (mail.attach_silver > 0) rewards.push({ type: 'silver', amount: mail.attach_silver });
        if (mail.attach_spirit_stones > 0) rewards.push({ type: 'spirit_stones', amount: mail.attach_spirit_stones });
      }

      if (attachInstanceIds.length > 0) {
        // 实例附件领取：复用库存模块“实例入包自动堆叠”逻辑，避免同规则在邮件/坊市重复实现。
        const moveResult = await moveItemInstancesToBagWithStacking(
          characterId,
          attachInstanceIds,
          {
            expectedSourceLocation: 'mail',
            expectedOwnerUserId: userId,
          },
        );
        if (!moveResult.success) {
          throw new Error(`实例附件入包失败: ${moveResult.message}`);
        }
        claimedInstanceIds = moveResult.itemIds;

        for (const row of lockedInstanceRows) {
          const key = String(row.item_def_id || '').trim();
          const qty = Math.max(1, Math.floor(Number(row.qty) || 1));
          if (key) collectCounts.set(key, (collectCounts.get(key) || 0) + qty);
          rewards.push({
            type: 'item',
            itemDefId: key,
            quantity: qty,
            itemName: resolveMailClaimRewardItemName(key, undefined, rewardItemDisplayMetaById),
          });
        }
      } else {
        const attachItemDefIds = Array.from(
          new Set(
            effectiveAttachItems
              .map((attachItem) => String(attachItem.item_def_id || '').trim())
              .filter((itemDefId) => itemDefId.length > 0),
          ),
        );
        const attachItemDefs = getItemDefinitionsByIds(attachItemDefIds);

        for (const attachItem of effectiveAttachItems) {
          if (autoDisassembleSetting) {
            const itemDefId = String(attachItem.item_def_id || '').trim();
            const itemDef = attachItemDefs.get(itemDefId);
            const autoDisassembleResult = await grantRewardItemWithAutoDisassemble({
              characterId,
              itemDefId,
              qty: Math.max(1, Math.floor(Number(attachItem.qty) || 1)),
              bindType: attachItem.options?.bindType,
              itemMeta: {
                itemName:
                  resolveMailClaimRewardItemName(
                    itemDefId,
                    attachItem.item_name,
                    rewardItemDisplayMetaById,
                  ) || itemDefId,
                category: String(itemDef?.category || ''),
                subCategory: typeof itemDef?.sub_category === 'string' ? itemDef.sub_category : null,
                effectDefs: itemDef?.effect_defs,
                qualityRank: resolveQualityRankFromName(itemDef?.quality, 1),
                disassemblable: typeof itemDef?.disassemblable === 'boolean' ? itemDef.disassemblable : null,
              },
              autoDisassembleSetting,
              sourceObtainedFrom: 'mail',
              createItem: async (params) => {
                return enqueueCharacterItemGrant({
                  characterId,
                  userId,
                  itemDefId: params.itemDefId,
                  qty: params.qty,
                  obtainedFrom: params.obtainedFrom,
                  ...(params.bindType ? { bindType: params.bindType } : {}),
                  ...(attachItem.options?.metadata ? { metadata: attachItem.options.metadata } : {}),
                  ...(attachItem.options?.quality ? { quality: attachItem.options.quality } : {}),
                  ...(attachItem.options?.qualityRank !== undefined
                    ? { qualityRank: attachItem.options.qualityRank }
                    : {}),
                  ...(params.equipOptions !== undefined
                    ? { equipOptions: params.equipOptions as GenerateOptions }
                    : {}),
                });
              },
              addSilver: async (targetCharacterId, silverAmount) => {
                if (targetCharacterId !== characterId) {
                  return { success: false, message: '邮件领取资源目标不一致' };
                }
                rewardDelta.silver += silverAmount;
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
                itemName: resolveMailClaimRewardItemName(
                  grantedItem.itemDefId,
                  undefined,
                  rewardItemDisplayMetaById,
                ),
              });
            }
            if (autoDisassembleResult.gainedSilver > 0) {
              rewards.push({ type: 'silver', amount: autoDisassembleResult.gainedSilver });
            }
            continue;
          }

          const createResult = await enqueueCharacterItemGrant({
            characterId,
            userId,
            itemDefId: attachItem.item_def_id,
            qty: attachItem.qty,
            obtainedFrom: 'mail',
            ...(attachItem.options?.bindType ? { bindType: attachItem.options.bindType } : {}),
            ...(attachItem.options?.metadata ? { metadata: attachItem.options.metadata } : {}),
            ...(attachItem.options?.quality ? { quality: attachItem.options.quality } : {}),
            ...(attachItem.options?.qualityRank !== undefined
              ? { qualityRank: attachItem.options.qualityRank }
              : {}),
            ...(attachItem.options?.equipOptions
              ? { equipOptions: attachItem.options.equipOptions as GenerateOptions }
              : {}),
          });

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
            itemName: resolveMailClaimRewardItemName(
              key,
              attachItem.item_name,
              rewardItemDisplayMetaById,
            ),
          });
        }
      }
    }

    if (rewardDelta.exp !== 0 || rewardDelta.silver !== 0 || rewardDelta.spiritStones !== 0) {
      await applyCharacterRewardDeltas(new Map([[characterId, rewardDelta]]));
    }

    // 8. 更新邮件状态
    await query(CLAIM_MAIL_STATUS_UPDATE_SQL, [mailId]);

    if (collectCounts.size > 0) {
      await recordCollectItemEventsBatch([{
        characterId,
        events: [...collectCounts.entries()].map(([itemId, count]) => ({
          itemId,
          count,
        })),
      }]);
    }

    const claimState = buildMailCounterStateFromRow(mail);
    await this.applyMailCounterDeltaInputs([
      claimState ? buildMailCounterClaimDelta(claimState) : null,
    ]);

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
      selectSql: 'id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, source, created_at',
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
      SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, source
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
      const treatAttachItemsAsPreviewOnly = shouldTreatAttachItemsAsInstancePreviewOnly({
        source: typeof row.source === 'string' ? row.source : null,
        attachItems,
        attachInstanceIds,
      });
      const hasAttachRewards = hasGrantedRewardPayload(attachRewards);
      const hasCurrency = Number(row.attach_silver) > 0 || Number(row.attach_spirit_stones) > 0;
      const hasItems = (treatAttachItemsAsPreviewOnly ? 0 : attachItems.length) > 0 || attachInstanceIds.length > 0;
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

  @Transactional
  async deleteMail(
    userId: number,
    characterId: number,
    mailId: number
  ): Promise<{ success: boolean; message: string }> {
    const result = await query<MailCounterStateRow>(`
      UPDATE mail SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1
        AND ${this.buildRecipientScopeSql(2, 3)}
        AND deleted_at IS NULL
      RETURNING
        recipient_user_id,
        recipient_character_id,
        read_at,
        claimed_at,
        attach_silver,
        attach_spirit_stones,
        attach_items,
        attach_rewards,
        attach_instance_ids
    `, [mailId, characterId, userId]);

    if (result.rows.length === 0) {
      return { success: false, message: '邮件不存在' };
    }

    const deleteState = buildMailCounterStateFromRow(result.rows[0]);
    await this.applyMailCounterDeltaInputs([
      deleteState ? buildMailCounterDeleteDelta(deleteState) : null,
    ]);
    await this.invalidateUnreadCounterAndNotifyRecipient(userId, characterId);

    const mail = result.rows[0];
    const attachSilver = Math.max(0, Math.floor(Number(mail.attach_silver) || 0));
    const attachSpiritStones = Math.max(0, Math.floor(Number(mail.attach_spirit_stones) || 0));
    const hasAttachments = attachSilver > 0 || attachSpiritStones > 0 ||
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

    const result = await query<MailCounterStateRow>(
      sql + `
        RETURNING
          recipient_user_id,
          recipient_character_id,
          read_at,
          claimed_at,
          attach_silver,
          attach_spirit_stones,
          attach_items,
          attach_rewards,
          attach_instance_ids
      `,
      [characterId, userId],
    );

    if (result.rows.length > 0) {
      await this.applyMailCounterDeltaInputs(
        result.rows.map((row) => {
          const deleteState = buildMailCounterStateFromRow(row);
          return deleteState ? buildMailCounterDeleteDelta(deleteState) : null;
        }),
      );
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
    const result = await query<{
      recipient_user_id: number | string;
      recipient_character_id: number | string | null;
    }>(`
      UPDATE mail SET read_at = NOW(), updated_at = NOW()
      WHERE ${this.buildRecipientScopeSql(1, 2)}
        AND deleted_at IS NULL
        AND read_at IS NULL
      RETURNING recipient_user_id, recipient_character_id
    `, [characterId, userId]);

    if (result.rows.length > 0) {
      await this.applyMailCounterDeltaInputs(
        result.rows.map((row) =>
          ({
            recipientUserId: Number(row.recipient_user_id),
            recipientCharacterId:
              row.recipient_character_id === null
                ? null
                : Number(row.recipient_character_id),
            unreadCountDelta: -1,
          }),
        ),
      );
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
      this.scheduleExpiredMailCleanupForRecipient(userId, characterId);
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
