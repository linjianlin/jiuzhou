/**
 * 热点性能索引同步回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：校验 mail / item_instance / market_listing 的热点性能索引可被统一同步，并在库内存在。
 * - 做什么：锁住索引表达式与部分索引谓词，避免后续重构把查询写法和索引定义拆开。
 * - 不做什么：不评估执行计划，不做真实性能基准，不覆盖业务接口层。
 *
 * 输入/输出：
 * - 输入：性能索引定义列表、数据库 `pg_indexes` 元数据。
 * - 输出：索引存在性，以及关键表达式/谓词断言。
 *
 * 数据流/状态流：
 * - 测试先调用 `ensurePerformanceIndexes()`；
 * - 再逐个查询 `pg_indexes` 回查索引定义；
 * - 最后校验关键索引表达式与谓词没有被意外改坏。
 *
 * 关键边界条件与坑点：
 * 1) mail 活跃范围索引必须保留 `COALESCE(expire_at, 'infinity'::timestamptz)`，否则和服务层查询写法脱钩。
 * 2) item_instance 堆叠索引必须保留特殊实例过滤谓词，不能把 metadata / quality / quality_rank 非空行纳入普通堆叠扫描。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { pool, query } from '../../config/database.js';
import {
  ensurePerformanceIndexes,
  getPerformanceIndexDefinitions,
  MAIL_CHARACTER_ACTIVE_COUNTER_INDEX_NAME,
  ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME,
  MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME,
  MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME,
  MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME,
} from '../shared/performanceIndexes.js';

test.after(async () => {
  await pool.end();
});

test('ensurePerformanceIndexes 应保证热点性能索引存在', async () => {
  await ensurePerformanceIndexes();

  const definitions = getPerformanceIndexDefinitions();

  for (const definition of definitions) {
    const result = await query<{
      indexname: string;
      indexdef: string;
    }>(
      `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = $1
      `,
      [definition.name],
    );

    assert.equal(result.rows.length, 1, `缺少性能索引 ${definition.name}`);
  }

  const mailIndexResult = await query<{ indexdef: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [MAIL_CHARACTER_ACTIVE_SCOPE_INDEX_NAME],
  );
  const mailIndexDef = mailIndexResult.rows[0]?.indexdef ?? '';
  assert.match(mailIndexDef, /COALESCE\(expire_at, 'infinity'::timestamp with time zone\)/i);
  assert.match(mailIndexDef, /deleted_at IS NULL/i);

  const mailCounterIndexResult = await query<{ indexdef: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [MAIL_CHARACTER_ACTIVE_COUNTER_INDEX_NAME],
  );
  const mailCounterIndexDef = mailCounterIndexResult.rows[0]?.indexdef ?? '';
  assert.match(mailCounterIndexDef, /COALESCE\(expire_at, 'infinity'::timestamp with time zone\)/i);
  assert.match(mailCounterIndexDef, /INCLUDE \(read_at, claimed_at, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids\)/i);
  assert.match(mailCounterIndexDef, /deleted_at IS NULL/i);

  const itemStackIndexResult = await query<{ indexdef: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [ITEM_INSTANCE_STACKABLE_LOOKUP_INDEX_NAME],
  );
  const itemStackIndexDef = itemStackIndexResult.rows[0]?.indexdef ?? '';
  assert.match(itemStackIndexDef, /metadata IS NULL/i);
  assert.match(itemStackIndexDef, /quality IS NULL/i);
  assert.match(itemStackIndexDef, /quality_rank IS NULL/i);

  const cleanupIndexResult = await query<{ indexdef: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [MAIL_CHARACTER_EXPIRE_CLEANUP_INDEX_NAME],
  );
  const cleanupIndexDef = cleanupIndexResult.rows[0]?.indexdef ?? '';
  assert.match(cleanupIndexDef, /deleted_at IS NULL/i);
  assert.match(cleanupIndexDef, /expire_at IS NOT NULL/i);

  const marketListingIndexResult = await query<{ indexdef: string }>(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = $1
    `,
    [MARKET_LISTING_ITEM_INSTANCE_ID_INDEX_NAME],
  );
  const marketListingIndexDef = marketListingIndexResult.rows[0]?.indexdef ?? '';
  assert.match(marketListingIndexDef, /item_instance_id IS NOT NULL/i);
});
