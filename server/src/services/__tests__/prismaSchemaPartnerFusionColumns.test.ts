import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * Prisma 三魂归契表 schema 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住三魂归契任务表与素材表的关键列定义，避免服务层已依赖字段而 Prisma schema 漏改。
 * 2. 做什么：复用统一的模型块截取逻辑，让字段断言集中在单一入口，减少 schema 文本匹配重复代码。
 * 3. 不做什么：不连接数据库，不执行 Prisma CLI，也不验证线上表结构是否已经同步。
 *
 * 输入/输出：
 * - 输入：`server/prisma/schema.prisma` 文件内容。
 * - 输出：断言 `partner_fusion_job` 与 `partner_fusion_job_material` 模型包含关键运行时列。
 *
 * 数据流/状态流：
 * 读取 schema 文件 -> 截取模型块 -> 校验归契任务与素材占用列定义存在。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 Prisma schema 文本，真实数据库补表仍依赖后续 Prisma 同步步骤。
 * 2. 如果未来拆分 Prisma schema 文件，必须同步更新读取路径，否则测试会因定位失败而误报。
 */

const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');

const getModelBlock = (modelName: string): string => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const modelPattern = new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`);
  const match = schema.match(modelPattern);
  return match?.[0] ?? '';
};

test('partner_fusion_job: Prisma schema 应声明结果品质与预览伙伴定义列', () => {
  const block = getModelBlock('partner_fusion_job');
  assert.match(
    block,
    /\bresult_quality\s+String\?\b/,
    'partner_fusion_job 缺少 result_quality 列定义',
  );
  assert.match(
    block,
    /\bpreview_partner_def_id\s+String\?\b/,
    'partner_fusion_job 缺少 preview_partner_def_id 列定义',
  );
});

test('partner_fusion_job_material: Prisma schema 应声明素材快照列', () => {
  const block = getModelBlock('partner_fusion_job_material');
  assert.match(
    block,
    /\bpartner_snapshot\s+Json\b/,
    'partner_fusion_job_material 缺少 partner_snapshot 列定义',
  );
  assert.match(
    block,
    /\bmaterial_order\s+Int\b/,
    'partner_fusion_job_material 缺少 material_order 列定义',
  );
});
