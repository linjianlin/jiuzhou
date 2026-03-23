/**
 * 自定义数据库索引同步脚本
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：在 Prisma `db push` 之后补齐 Prisma 不能直接声明，或当前项目集中托管的热点性能索引。
 * - 做什么：把索引补建入口集中到单一脚本，避免开发、测试、部署环境各自手敲 SQL。
 * - 不做什么：不执行数据迁移，不处理业务数据修复，不启动应用服务。
 *
 * 输入/输出：
 * - 输入：无；读取服务端 `.env` 连接数据库。
 * - 输出：控制台同步结果；失败时抛出原始异常并返回非零退出码。
 *
 * 数据流/状态流：
 * - `db:sync` -> 本脚本 -> 各索引同步入口 -> PostgreSQL 索引元数据。
 *
 * 关键边界条件与坑点：
 * 1) 该脚本必须保持幂等，避免重复执行导致索引创建报错。
 * 2) 这里只维护项目明确收口的索引；常规表结构仍应继续由 Prisma schema 维护。
 */
import { pool } from '../src/config/database.js';
import { ensureItemInstanceSlotUniqueIndex, ITEM_INSTANCE_SLOT_UNIQUE_INDEX_NAME } from '../src/services/shared/itemInstanceSlotUniqueIndex.js';
import { ensurePerformanceIndexes, getPerformanceIndexDefinitions } from '../src/services/shared/performanceIndexes.js';

const main = async (): Promise<void> => {
  await ensureItemInstanceSlotUniqueIndex();
  await ensurePerformanceIndexes();
  console.log(`已同步自定义索引: ${ITEM_INSTANCE_SLOT_UNIQUE_INDEX_NAME}`);
  console.log(
    `已同步热点性能索引: ${getPerformanceIndexDefinitions().map((definition) => definition.name).join(', ')}`,
  );
};

main()
  .catch((error: unknown) => {
    console.error('自定义索引同步失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
