import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * migration history 清理回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住启动数据准备链不再依赖 `runDbMigrationOnce`。
 * 2. 做什么：锁住 Prisma schema 不再声明 `db_migration_history`，避免遗留清理只做一半。
 * 3. 不做什么：不连接数据库，不验证启动流程，只检查源码文本是否已完成清理。
 *
 * 输入/输出：
 * - 输入：`server/src/models/initTables.ts` 与 `server/prisma/schema.prisma` 文件内容。
 * - 输出：断言启动入口直接执行幂等回填，且 schema 不再包含 migration history 模型。
 *
 * 数据流/状态流：
 * 读取源码 -> 断言 initTables 文本不再引用 `runDbMigrationOnce` -> 断言 Prisma schema 文本不再声明 `db_migration_history`。
 *
 * 关键边界条件与坑点：
 * 1. 这是文本级回归测试，不验证数据库中旧表是否已经物理删除；真实删除仍由 `db push` 完成。
 * 2. 如果后续重命名 `initTables.ts` 或拆分 schema 文件，必须同步更新这里的定位路径，否则会误报。
 */

const initTablesPath = path.resolve(process.cwd(), 'src/models/initTables.ts');
const prismaSchemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

test('initTables: 不再通过 runDbMigrationOnce 包装排行榜快照回填', () => {
  const source = fs.readFileSync(initTablesPath, 'utf8');
  assert.doesNotMatch(source, /\brunDbMigrationOnce\b/, 'initTables 仍然依赖 runDbMigrationOnce');
  assert.match(
    source,
    /await backfillCharacterRankSnapshots\(\);/,
    'initTables 应直接执行幂等的排行榜快照回填',
  );
});

test('schema.prisma: 不再声明 db_migration_history 模型', () => {
  const schema = fs.readFileSync(prismaSchemaPath, 'utf8');
  assert.doesNotMatch(schema, /model db_migration_history \{/, 'schema.prisma 仍然保留 db_migration_history 模型');
});
