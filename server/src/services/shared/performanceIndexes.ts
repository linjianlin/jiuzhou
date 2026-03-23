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
 * - `db:sync` / 测试 -> ensurePerformanceIndexes -> 逐条执行 CREATE INDEX IF NOT EXISTS。
 *
 * 关键边界条件与坑点：
 * 1) mail 活跃范围查询依赖 `COALESCE(expire_at, 'infinity')` 表达式，索引表达式必须与查询写法保持一致，否则 PostgreSQL 无法稳定命中。
 * 2) item_instance 堆叠查询只应覆盖普通可堆叠实例，必须把 `metadata / quality / quality_rank IS NULL` 放进部分索引谓词，避免把特殊实例也塞进同一索引扫描路径。
 */
import { query } from '../../config/database.js';

export const MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME = 'idx_mail_character_active_scope';
export const MAIL_USER_ACTIVE_SCOPE_INDEX_NAME = 'idx_mail_user_active_scope';
export const MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME = 'idx_mail_character_expire_cleanup';
export const MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME = 'idx_mail_user_expire_cleanup';
export const ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME = 'idx_item_instance_stackable_lookup';
export const MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME = 'idx_market_listing_item_instance_id';

export type PerformanceIndexDefinition = {
  name: string;
  createSql: string;
};

const PERFORMANCE_INDEX_DEFINITIONS: PerformanceIndexDefinition[] = [
  {
    name: MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME}
      ON mail (
        recipient_character_id,
        deleted_at,
        (COALESCE(expire_at, 'infinity'::timestamptz)),
        created_at DESC,
        id DESC
      )
    `,
  },
  {
    name: MAIL_USER_ACTIVE_SCOPE_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_USER_ACTIVE_SCOPE_INDEX_NAME}
      ON mail (
        recipient_user_id,
        recipient_character_id,
        deleted_at,
        (COALESCE(expire_at, 'infinity'::timestamptz)),
        created_at DESC,
        id DESC
      )
    `,
  },
  {
    name: MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME}
      ON mail (recipient_character_id, deleted_at, expire_at)
    `,
  },
  {
    name: MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MAIL_USER_EXPIRE_CLEANUP_INDEX_NAME}
      ON mail (recipient_user_id, recipient_character_id, deleted_at, expire_at)
    `,
  },
  {
    name: ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME}
      ON item_instance (
        owner_character_id,
        location,
        item_def_id,
        bind_type,
        qty DESC,
        id ASC
      )
      WHERE metadata IS NULL
        AND quality IS NULL
        AND quality_rank IS NULL
    `,
  },
  {
    name: MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME}
      ON market_listing (item_instance_id)
    `,
  },
];

export const getPerformanceIndexDefinitions = (): PerformanceIndexDefinition[] => {
  return PERFORMANCE_INDEX_DEFINITIONS.slice();
};

export const ensurePerformanceIndexes = async (): Promise<void> => {
  for (const definition of PERFORMANCE_INDEX_DEFINITIONS) {
    await query(definition.createSql);
  }
};
