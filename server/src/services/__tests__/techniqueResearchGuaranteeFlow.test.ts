/**
 * 洞府研修保底链路源码回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定洞府研修创建任务必须复用共享保底入口，且成功落草稿后必须原子更新连续未出天计数。
 * 2. 做什么：避免只改状态展示或纯函数，却漏掉真实建单/落库链路，导致面板与实际结果不一致。
 * 3. 不做什么：不执行数据库、不调用 service，只检查源码中关键调用与 SQL 片段。
 *
 * 输入/输出：
 * - 输入：`techniqueGenerationService.ts` 源码文本。
 * - 输出：断言共享保底调用与原子计数字段更新仍然存在。
 *
 * 数据流/状态流：
 * 读取 service 源码 -> 正则匹配保底入口 / 原子更新 SQL -> 防回归断言。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁关键链路，不验证完整 SQL 语法；若未来重构到新模块，需同步更新这里的定位模式。
 * 2. 计数更新必须保持单条 SQL 原子完成，不能退回到“先查后写”的多步流程，否则并发下会丢计数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const techniqueGenerationSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/services/techniqueGenerationService.ts'),
  'utf8',
);

test('techniqueGenerationService: 创建任务应复用共享保底入口，成功后计数改为原子更新', () => {
  assert.match(
    techniqueGenerationSource,
    /const quality = resolveTechniqueResearchQualityForGeneratedDraftSuccess\(generatedNonHeavenCount\);/u,
    '创建任务未复用洞府研修共享保底入口',
  );
  assert.match(
    techniqueGenerationSource,
    /technique_research_generated_non_heaven_count = CASE[\s\S]*WHEN \$2 = '天' THEN 0[\s\S]*ELSE technique_research_generated_non_heaven_count \+ 1/iu,
    '洞府研修连续未出天计数未使用单条 SQL 原子更新',
  );
});
