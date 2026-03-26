/**
 * 邮件计数聚合存储
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把邮件红点/总量统计收敛到 `mail_counter` 聚合表，避免读接口重复扫描 `mail` 明细表。
 * 2. 做什么：提供统一的增量更新、快照读取与历史数据回填入口，避免计数规则散落在 `mailService` 各写路径里。
 * 3. 不做什么：不负责邮件列表分页，不负责 socket 推送，也不在这里决定缓存失效时机。
 *
 * 输入/输出：
 * - 输入：邮件作用域（账号级/角色级）与计数增量，或 `userId + characterId` 查询请求。
 * - 输出：聚合后的计数快照，或对 `mail_counter` 的幂等 upsert / 回填结果。
 *
 * 数据流/状态流：
 * - `mailService` 写路径 -> 本模块聚合增量 -> upsert `mail_counter`
 * - `/mail/list` / `/mail/unread` -> 本模块读取角色级 + 账号级两行快照 -> 返回统计结果
 * - 启动流程 -> 本模块回填历史活跃邮件 -> 初始化 `mail_counter`
 *
 * 关键边界条件与坑点：
 * 1. 账号级邮件与角色级邮件必须共用同一套聚合协议，但落到不同 scope；否则同一封邮件会被重复计数。
 * 2. 这里不做任何“读 miss 自动扫 `mail` 表”的兜底，真相源就是 `mail_counter`；历史数据修复只能走显式回填。
 */
import { query } from '../../config/database.js';

const MAIL_HAS_ATTACHMENTS_SQL = '(attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL)';
const MAIL_ACTIVE_SCOPE_SQL = `deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW()`;

type MailJsonValue =
  | string
  | number
  | boolean
  | null
  | MailJsonValue[]
  | { [key: string]: MailJsonValue };

export type MailCounterScopeType = 'character' | 'user';

export interface MailCounterSnapshot {
  totalCount: number;
  unreadCount: number;
  unclaimedCount: number;
}

export interface MailCounterDeltaInput {
  recipientUserId: number;
  recipientCharacterId: number | null;
  totalCountDelta?: number;
  unreadCountDelta?: number;
  unclaimedCountDelta?: number;
}

export interface MailCounterStateRow {
  recipient_user_id: number | string;
  recipient_character_id: number | string | null;
  read_at: Date | string | null;
  claimed_at: Date | string | null;
  attach_silver: number | string | null;
  attach_spirit_stones: number | string | null;
  attach_items: MailJsonValue;
  attach_rewards: MailJsonValue;
  attach_instance_ids: MailJsonValue;
}

export interface MailCounterStateSnapshot {
  recipientUserId: number;
  recipientCharacterId: number | null;
  isUnread: boolean;
  isUnclaimed: boolean;
}

type MailCounterDelta = {
  scopeType: MailCounterScopeType;
  scopeId: number;
  totalCountDelta: number;
  unreadCountDelta: number;
  unclaimedCountDelta: number;
};

const normalizePositiveInteger = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
};

const normalizeDeltaInteger = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.trunc(value);
};

const hasMailAttachments = (input: {
  attachSilver: number;
  attachSpiritStones: number;
  attachItems: MailJsonValue;
  attachRewards: MailJsonValue;
  attachInstanceIds: MailJsonValue;
}): boolean => {
  return (
    input.attachSilver > 0
    || input.attachSpiritStones > 0
    || input.attachItems !== null
    || input.attachRewards !== null
    || input.attachInstanceIds !== null
  );
};

const createMailCounterDelta = (input: MailCounterDeltaInput): MailCounterDelta | null => {
  const normalizedRecipientCharacterId = input.recipientCharacterId === null
    ? 0
    : normalizePositiveInteger(Number(input.recipientCharacterId));
  const recipientUserId = normalizePositiveInteger(Number(input.recipientUserId));
  const hasCharacterScope = normalizedRecipientCharacterId > 0;
  const scopeType: MailCounterScopeType = hasCharacterScope ? 'character' : 'user';
  const scopeId = hasCharacterScope ? normalizedRecipientCharacterId : recipientUserId;

  if (scopeId <= 0) return null;

  return {
    scopeType,
    scopeId,
    totalCountDelta: normalizeDeltaInteger(input.totalCountDelta),
    unreadCountDelta: normalizeDeltaInteger(input.unreadCountDelta),
    unclaimedCountDelta: normalizeDeltaInteger(input.unclaimedCountDelta),
  };
};

const mergeMailCounterDeltas = (inputs: readonly MailCounterDeltaInput[]): MailCounterDelta[] => {
  const deltaMap = new Map<string, MailCounterDelta>();

  for (const input of inputs) {
    const resolvedDelta = createMailCounterDelta(input);
    if (!resolvedDelta) continue;

    if (
      resolvedDelta.totalCountDelta === 0
      && resolvedDelta.unreadCountDelta === 0
      && resolvedDelta.unclaimedCountDelta === 0
    ) {
      continue;
    }

    const key = `${resolvedDelta.scopeType}:${resolvedDelta.scopeId}`;
    const currentDelta = deltaMap.get(key);
    if (currentDelta) {
      currentDelta.totalCountDelta += resolvedDelta.totalCountDelta;
      currentDelta.unreadCountDelta += resolvedDelta.unreadCountDelta;
      currentDelta.unclaimedCountDelta += resolvedDelta.unclaimedCountDelta;
      continue;
    }

    deltaMap.set(key, { ...resolvedDelta });
  }

  return Array.from(deltaMap.values());
};

export const buildMailCounterStateFromRow = (
  row: MailCounterStateRow,
): MailCounterStateSnapshot | null => {
  const recipientUserId = normalizePositiveInteger(Number(row.recipient_user_id));
  if (recipientUserId <= 0) return null;

  const rawRecipientCharacterId = row.recipient_character_id;
  const normalizedRecipientCharacterId = rawRecipientCharacterId === null
    ? null
    : normalizePositiveInteger(Number(rawRecipientCharacterId));

  return {
    recipientUserId,
    recipientCharacterId:
      normalizedRecipientCharacterId !== null && normalizedRecipientCharacterId > 0
        ? normalizedRecipientCharacterId
        : null,
    isUnread: row.read_at === null,
    isUnclaimed:
      row.claimed_at === null
      && hasMailAttachments({
        attachSilver: Math.max(0, Math.floor(Number(row.attach_silver) || 0)),
        attachSpiritStones: Math.max(0, Math.floor(Number(row.attach_spirit_stones) || 0)),
        attachItems: row.attach_items,
        attachRewards: row.attach_rewards,
        attachInstanceIds: row.attach_instance_ids,
      }),
  };
};

export const buildMailCounterInsertDelta = (
  state: MailCounterStateSnapshot,
): MailCounterDeltaInput => {
  return {
    recipientUserId: state.recipientUserId,
    recipientCharacterId: state.recipientCharacterId,
    totalCountDelta: 1,
    unreadCountDelta: state.isUnread ? 1 : 0,
    unclaimedCountDelta: state.isUnclaimed ? 1 : 0,
  };
};

export const buildMailCounterDeleteDelta = (
  state: MailCounterStateSnapshot,
): MailCounterDeltaInput => {
  return {
    recipientUserId: state.recipientUserId,
    recipientCharacterId: state.recipientCharacterId,
    totalCountDelta: -1,
    unreadCountDelta: state.isUnread ? -1 : 0,
    unclaimedCountDelta: state.isUnclaimed ? -1 : 0,
  };
};

export const buildMailCounterReadDelta = (
  state: MailCounterStateSnapshot,
): MailCounterDeltaInput | null => {
  if (!state.isUnread) return null;
  return {
    recipientUserId: state.recipientUserId,
    recipientCharacterId: state.recipientCharacterId,
    unreadCountDelta: -1,
  };
};

export const buildMailCounterClaimDelta = (
  state: MailCounterStateSnapshot,
): MailCounterDeltaInput | null => {
  if (!state.isUnread && !state.isUnclaimed) return null;
  return {
    recipientUserId: state.recipientUserId,
    recipientCharacterId: state.recipientCharacterId,
    unreadCountDelta: state.isUnread ? -1 : 0,
    unclaimedCountDelta: state.isUnclaimed ? -1 : 0,
  };
};

export const applyMailCounterDeltas = async (
  inputs: readonly MailCounterDeltaInput[],
): Promise<void> => {
  const deltas = mergeMailCounterDeltas(inputs);
  if (deltas.length <= 0) {
    return;
  }

  await query(
    `
      WITH input_rows AS (
        SELECT
          scope_type,
          scope_id,
          total_count_delta,
          unread_count_delta,
          unclaimed_count_delta
        FROM jsonb_to_recordset($1::jsonb) AS rows (
          scope_type varchar(16),
          scope_id bigint,
          total_count_delta bigint,
          unread_count_delta bigint,
          unclaimed_count_delta bigint
        )
      ),
      upserted AS (
        INSERT INTO mail_counter (
          scope_type,
          scope_id,
          total_count,
          unread_count,
          unclaimed_count,
          updated_at
        )
        SELECT
          input_rows.scope_type,
          input_rows.scope_id,
          input_rows.total_count_delta,
          input_rows.unread_count_delta,
          input_rows.unclaimed_count_delta,
          NOW()
        FROM input_rows
        ON CONFLICT (scope_type, scope_id) DO UPDATE SET
          total_count = GREATEST(0, mail_counter.total_count + EXCLUDED.total_count),
          unread_count = GREATEST(0, mail_counter.unread_count + EXCLUDED.unread_count),
          unclaimed_count = GREATEST(0, mail_counter.unclaimed_count + EXCLUDED.unclaimed_count),
          updated_at = NOW()
        RETURNING scope_type, scope_id
      )
      DELETE FROM mail_counter
      USING upserted
      WHERE mail_counter.scope_type = upserted.scope_type
        AND mail_counter.scope_id = upserted.scope_id
        AND mail_counter.total_count <= 0
        AND mail_counter.unread_count <= 0
        AND mail_counter.unclaimed_count <= 0
    `,
    [
      JSON.stringify(
        deltas.map((delta) => ({
          scope_type: delta.scopeType,
          scope_id: delta.scopeId,
          total_count_delta: delta.totalCountDelta,
          unread_count_delta: delta.unreadCountDelta,
          unclaimed_count_delta: delta.unclaimedCountDelta,
        })),
      ),
    ],
  );
};

export const loadMailCounterSnapshot = async (
  userId: number,
  characterId: number,
): Promise<MailCounterSnapshot> => {
  const result = await query<{
    total_count?: string | number;
    unread_count?: string | number;
    unclaimed_count?: string | number;
  }>(
    `
      SELECT
        COALESCE(SUM(total_count), 0)::bigint AS total_count,
        COALESCE(SUM(unread_count), 0)::bigint AS unread_count,
        COALESCE(SUM(unclaimed_count), 0)::bigint AS unclaimed_count
      FROM mail_counter
      WHERE (scope_type = 'character' AND scope_id = $1)
         OR (scope_type = 'user' AND scope_id = $2)
    `,
    [characterId, userId],
  );

  const row = result.rows[0] ?? {};
  return {
    totalCount: Math.max(0, Math.floor(Number(row.total_count) || 0)),
    unreadCount: Math.max(0, Math.floor(Number(row.unread_count) || 0)),
    unclaimedCount: Math.max(0, Math.floor(Number(row.unclaimed_count) || 0)),
  };
};

const MAIL_COUNTER_REBUILD_SQL = `
  INSERT INTO mail_counter (
    scope_type,
    scope_id,
    total_count,
    unread_count,
    unclaimed_count,
    updated_at
  )
  SELECT
    aggregated_counter.scope_type,
    aggregated_counter.scope_id,
    aggregated_counter.total_count,
    aggregated_counter.unread_count,
    aggregated_counter.unclaimed_count,
    NOW()
  FROM (
    SELECT
      'character'::varchar(16) AS scope_type,
      recipient_character_id AS scope_id,
      COUNT(*)::bigint AS total_count,
      COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count,
      COUNT(*) FILTER (WHERE claimed_at IS NULL AND ${MAIL_HAS_ATTACHMENTS_SQL})::bigint AS unclaimed_count
    FROM mail
    WHERE recipient_character_id IS NOT NULL
      AND ${MAIL_ACTIVE_SCOPE_SQL}
    GROUP BY recipient_character_id

    UNION ALL

    SELECT
      'user'::varchar(16) AS scope_type,
      recipient_user_id AS scope_id,
      COUNT(*)::bigint AS total_count,
      COUNT(*) FILTER (WHERE read_at IS NULL)::bigint AS unread_count,
      COUNT(*) FILTER (WHERE claimed_at IS NULL AND ${MAIL_HAS_ATTACHMENTS_SQL})::bigint AS unclaimed_count
    FROM mail
    WHERE recipient_character_id IS NULL
      AND ${MAIL_ACTIVE_SCOPE_SQL}
    GROUP BY recipient_user_id
  ) AS aggregated_counter
`;

export const rebuildAllMailCounterSnapshots = async (): Promise<void> => {
  await query('TRUNCATE TABLE mail_counter');
  await query(MAIL_COUNTER_REBUILD_SQL);
};

export const backfillMailCounterSnapshotsIfEmpty = async (): Promise<void> => {
  const existingResult = await query<{ scope_type?: string }>(
    `
      SELECT scope_type
      FROM mail_counter
      LIMIT 1
    `,
  );
  if (existingResult.rows.length > 0) {
    return;
  }

  await query(MAIL_COUNTER_REBUILD_SQL);

  const insertedCountResult = await query<{ counter_count?: string | number }>(
    `
      SELECT COUNT(*)::bigint AS counter_count
      FROM mail_counter
    `,
  );
  const insertedCount = Math.max(
    0,
    Math.floor(Number(insertedCountResult.rows[0]?.counter_count) || 0),
  );
  if (insertedCount > 0) {
    console.log(`[mail_counter] 已回填计数快照: ${insertedCount} 条`);
  }
};
