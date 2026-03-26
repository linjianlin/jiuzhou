/**
 * 热点查询性能索引同步工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中维护 mail / item_instance / market_listing 的高频热点索引，避免性能相关 DDL 散落在业务代码或脚本中。
 * - 做什么：提供幂等同步入口，给 `db:sync` 和回归测试复用，保证本地与线上库结构一致。
 * - 不做什么：不做业务数据修复，不改写业务 SQL，不承担迁移编排职责。
 *
 * 输入/输出：
 * - 输入：无；内部直接使用统一 `query` 执行索引 DDL。
 * - 输出：`Promise<void>`；保证目标热点索引存在。
 *
 * 数据流/状态流：
 * - `db:sync` / 测试 -> ensurePerformanceIndexes -> 对比库内索引定义 -> 缺失则创建、旧定义则重建。
 *
 * 关键边界条件与坑点：
 * 1) mail 活跃范围查询依赖 `COALESCE(expire_at, 'infinity')` 表达式，索引表达式必须与查询写法保持一致，否则 PostgreSQL 无法稳定命中。
 * 2) mail 红点计数会同时读取 `read_at / claimed_at / attach_*`，索引若不覆盖这些列，角色邮件大盘点数仍会退化成大范围 heap scan。
 * 3) item_instance 堆叠查询既要兼容历史“空字符串 / 0 / json null”旧数据，又要继续把特殊实例排除在热点索引之外，否则新旧普通实例会继续分堆或把索引放大成无差别扫描。
 * 4) 已存在但定义过旧的索引，`CREATE INDEX IF NOT EXISTS` 不会自动修正；必须显式校验定义并重建，否则优化永远落不到老库。
 */
import { query } from '../../config/database.js';
import { buildPlainStackingSqlPredicate } from '../inventory/shared/stacking.js';
import { buildNormalizedItemBindTypeSql } from './itemBindType.js';

export const MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME = 'idx_mail_character_active_scope';
export const MAIL_USER_ACTIVE_SCOPE_INDEX_NAME = 'idx_mail_user_active_scope';
export const MAIL_CHARACTER_ACTIVE_COUNTER_INDEX_NAME = 'idx_mail_character_active_counter';
export const MAIL_USER_ACTIVE_COUNTER_INDEX_NAME = 'idx_mail_user_active_counter';
export const MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME = 'idx_mail_character_expire_cleanup';
export const MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME = 'idx_mail_user_expire_cleanup';
export const MAIL_DELETED_HISTORY_CLEANUP_INDEX_NAME = 'idx_mail_deleted_history_cleanup';
export const MAIL_EXPIRED_HISTORY_CLEANUP_INDEX_NAME = 'idx_mail_expired_history_cleanup';
export const ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME = 'idx_item_instance_stackable_lookup';
export const MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME = 'idx_market_listing_item_instance_id';

const ITEM_INSTANCE_STACKABLE_LOOKUP_BIND_TYPE_SQL = buildNormalizedItemBindTypeSql('bind_type');
const ITEM_INSTANCE_STACKABLE_LOOKUP_PREDICATE_SQL = buildPlainStackingSqlPredicate({
  metadata: 'metadata',
  quality: 'quality',
  qualityRank: 'quality_rank',
});

export type PerformanceIndexDefinition = {
  name: string;
  createSql: string;
  matchFragments: string[];
};

const PERFORMANCE_INDEX_DEFINITIONS: PerformanceIndexDefinition[] = [
  {
    name: MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME}
      ON mail (
        recipient_character_id,
        (COALESCE(expire_at, 'infinity'::timestamptz)),
        created_at DESC,
        id DESC
      )
      WHERE deleted_at IS NULL
    `,
    matchFragments: [
      'recipient_character_id',
      "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
      'created_at DESC',
      'id DESC',
      'deleted_at IS NULL',
    ],
  },
  {
    name: MAIL_CHARACTER_ACTIVE_COUNTER_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_CHARACTER_ACTIVE_COUNTER_INDEX_NAME}
      ON mail (
        recipient_character_id,
        (COALESCE(expire_at, 'infinity'::timestamptz))
      )
      INCLUDE (
        read_at,
        claimed_at,
        attach_silver,
        attach_spirit_stones,
        attach_items,
        attach_rewards,
        attach_instance_ids
      )
      WHERE deleted_at IS NULL
    `,
    matchFragments: [
      'recipient_character_id',
      "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
      'INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids)',
      'deleted_at IS NULL',
    ],
  },
  {
    name: MAIL_USER_ACTIVE_SCOPE_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_USER_ACTIVE_SCOPE_INDEX_NAME}
      ON mail (
        recipient_user_id,
        (COALESCE(expire_at, 'infinity'::timestamptz)),
        created_at DESC,
        id DESC
      )
      WHERE deleted_at IS NULL
        AND recipient_character_id IS NULL
    `,
    matchFragments: [
      'recipient_user_id',
      "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
      'created_at DESC',
      'id DESC',
      'deleted_at IS NULL',
      'recipient_character_id IS NULL',
    ],
  },
  {
    name: MAIL_USER_ACTIVE_COUNTER_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_USER_ACTIVE_COUNTER_INDEX_NAME}
      ON mail (
        recipient_user_id,
        (COALESCE(expire_at, 'infinity'::timestamptz))
      )
      INCLUDE (
        read_at,
        claimed_at,
        attach_silver,
        attach_spirit_stones,
        attach_items,
        attach_rewards,
        attach_instance_ids
      )
      WHERE deleted_at IS NULL
        AND recipient_character_id IS NULL
    `,
    matchFragments: [
      'recipient_user_id',
      "COALESCE(expire_at, 'infinity'::timestamp with time zone)",
      'INCLUDE (read_at, claimed_at, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids)',
      'deleted_at IS NULL',
      'recipient_character_id IS NULL',
    ],
  },
  {
    name: MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME}
      ON mail (recipient_character_id, expire_at)
      WHERE deleted_at IS NULL
        AND expire_at IS NOT NULL
    `,
    matchFragments: [
      'recipient_character_id',
      'expire_at',
      'deleted_at IS NULL',
      'expire_at IS NOT NULL',
    ],
  },
  {
    name: MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME}
      ON mail (recipient_user_id, expire_at)
      WHERE recipient_character_id IS NULL
        AND deleted_at IS NULL
        AND expire_at IS NOT NULL
    `,
    matchFragments: [
      'recipient_user_id',
      'expire_at',
      'recipient_character_id IS NULL',
      'deleted_at IS NULL',
      'expire_at IS NOT NULL',
    ],
  },
  {
    name: MAIL_DELETED_HISTORY_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_DELETED_HISTORY_CLEANUP_INDEX_NAME}
      ON mail (deleted_at, id)
      WHERE deleted_at IS NOT NULL
    `,
    matchFragments: [
      'deleted_at',
      'id',
      'deleted_at IS NOT NULL',
    ],
  },
  {
    name: MAIL_EXPIRED_HISTORY_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_EXPIRED_HISTORY_CLEANUP_INDEX_NAME}
      ON mail (expire_at, id)
      WHERE deleted_at IS NULL
        AND expire_at IS NOT NULL
    `,
    matchFragments: [
      'expire_at',
      'id',
      'deleted_at IS NULL',
      'expire_at IS NOT NULL',
    ],
  },
  {
    name: ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME}
      ON item_instance (
        owner_character_id,
        location,
        item_def_id,
        (${ITEM_INSTANCE_STACKABLE_LOOKUP_BIND_TYPE_SQL}),
        qty DESC,
        id ASC
      )
      WHERE ${ITEM_INSTANCE_STACKABLE_LOOKUP_PREDICATE_SQL}
    `,
    matchFragments: [
      'owner_character_id',
      'location',
      'item_def_id',
      "COALESCE(NULLIF(LOWER(BTRIM(bind_type)), ''), 'none')",
      'qty DESC',
      'id',
      "metadata IS NULL OR LOWER(BTRIM(metadata::text)) = 'null'",
      "quality IS NULL OR BTRIM(quality) = ''",
      'quality_rank IS NULL OR quality_rank <= 0',
    ],
  },
  {
    name: MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME}
      ON market_listing (item_instance_id)
      WHERE item_instance_id IS NOT NULL
    `,
    matchFragments: [
      'item_instance_id',
      'item_instance_id IS NOT NULL',
    ],
  },
];

export const getPerformanceIndexDefinitions = (): PerformanceIndexDefinition[] => {
  return PERFORMANCE_INDEX_DEFINITIONS.slice();
};

const normalizeSql = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
};

const matchesExpectedFragments = (
  indexDefinitionSql: string,
  fragments: string[],
): boolean => {
  const normalizedIndexDefinition = normalizeSql(indexDefinitionSql);
  return fragments.every((fragment) => normalizedIndexDefinition.includes(normalizeSql(fragment)));
};

const loadExistingIndexDefinition = async (indexName: string): Promise<string | null> => {
  const result = await query<{ indexdef?: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [indexName],
  );
  return typeof result.rows[0]?.indexdef === 'string' ? result.rows[0].indexdef : null;
};

export const ensurePerformanceIndexes = async (): Promise<void> => {
  for (const definition of PERFORMANCE_INDEX_DEFINITIONS) {
    const existingDefinition = await loadExistingIndexDefinition(definition.name);
    if (existingDefinition && matchesExpectedFragments(existingDefinition, definition.matchFragments)) {
      continue;
    }

    if (existingDefinition) {
      await query(`DROP INDEX IF EXISTS ${definition.name}`);
    }

    await query(definition.createSql);
  }
};
