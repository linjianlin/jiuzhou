import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Prisma 功法动态表 schema 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住功法动态表在 Prisma schema 中必须声明的关键运行时列。
 * 2. 做什么：把“提取模型块 / 断言字段存在”集中成单一测试辅助函数，避免每个字段检查重复写一套文本匹配。
 * 3. 不做什么：不连接数据库，不验证 Prisma CLI，只检查 schema 文本是否覆盖关键列。
 *
 * 输入/输出：
 * - 输入：`server/prisma/schema.prisma` 文件内容。
 * - 输出：断言指定 Prisma 模型内包含运行时代码依赖的关键列定义。
 *
 * 数据流/状态流：
 * - 读取 schema 文件 -> 按模型名截取模型块 -> 复用统一断言函数校验关键列存在。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 schema 文本，不验证数据库现状；真实补列仍由 `db push` 完成。
 * 2. 如果未来重命名模型或拆分 schema 文件，必须同步更新这里的定位逻辑，否则测试会误报。
 */

const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

const getModelBlock = (modelName: string): string => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const modelPattern = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`);
  const match = schema.match(modelPattern);
  return match?.[0] ?? '';
};

const assertModelHasField = (modelName: string, fieldPattern: RegExp, message: string): void => {
  const block = getModelBlock(modelName);
  assert.match(block, fieldPattern, message);
};

test('generated_technique_def: Prisma schema 应声明 usage_scope 列', () => {
  assertModelHasField(
    'generated_technique_def',
    /\busage_scope\s+String\b/,
    'generated_technique_def 缺少 usage_scope 列定义',
  );
});

test('generated_skill_def: Prisma schema 应声明比例消耗列', () => {
  assertModelHasField(
    'generated_skill_def',
    /\bcost_lingqi_rate\s+Decimal\b/,
    'generated_skill_def 缺少 cost_lingqi_rate 列定义',
  );
  assertModelHasField(
    'generated_skill_def',
    /\bcost_qixue_rate\s+Decimal\b/,
    'generated_skill_def 缺少 cost_qixue_rate 列定义',
  );
});

test('technique_generation_job: Prisma schema 应声明任务恢复依赖列', () => {
  assertModelHasField(
    'technique_generation_job',
    /\btype_rolled\s+String\?/,
    'technique_generation_job 缺少 type_rolled 列定义',
  );
  assertModelHasField(
    'technique_generation_job',
    /\bused_cooldown_bypass_token\s+Boolean\b/,
    'technique_generation_job 缺少 used_cooldown_bypass_token 列定义',
  );
  assertModelHasField(
    'technique_generation_job',
    /\bburning_word_prompt\s+String\?\s+@db\.VarChar\(8\)/,
    'technique_generation_job 缺少 burning_word_prompt 列定义',
  );
});

test('characters: Prisma schema 应声明洞府研修连续未出天累计字段', () => {
  assertModelHasField(
    'characters',
    /\btechnique_research_generated_non_heaven_count\s+Int\b/,
    'characters 缺少 technique_research_generated_non_heaven_count 列定义',
  );
});
