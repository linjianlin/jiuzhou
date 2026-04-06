/**
 * 功法书批量联调脚本源码约束测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `technique-book-batch` 的复评启用条件，确保只有显式传入复评模型时才会进入复评链路。
 * 2. 做什么：锁定批量输出的复评状态字段与日志文案，避免“未启用复评”和“复评通过”继续混为同一状态。
 * 3. 不做什么：不执行脚本、不请求真实模型，也不覆盖共享联调模块的候选生成逻辑。
 *
 * 输入 / 输出：
 * - 输入：批量脚本源码文本。
 * - 输出：源码级断言结果。
 *
 * 数据流 / 状态流：
 * 批量脚本源码
 * -> 读取文本
 * -> 断言复评启用条件 / 汇总字段 / 日志状态文案。
 *
 * 复用设计说明：
 * - 这里直接锁定批量入口的源码约束，避免把“batch 特有的复评开关规则”再散落到其他测试里重复维护。
 * - 复评启用条件是高频变更点，单独建测试文件后，后续只需在一个入口更新断言。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 batch 入口，不替代共享调试链路的复评顺序测试。
 * 2. 必须同时锁定汇总字段与日志文案，否则关闭复评后仍可能在输出层伪装成“复评通过”。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readBatchScriptSource = (): string => {
  return readFileSync(
    new URL('../../scripts/testTechniqueBookModelBatch.ts', import.meta.url),
    'utf8',
  );
};

test('testTechniqueBookModelBatch: 未指定复评模型时应关闭复评链路', () => {
  const source = readBatchScriptSource();

  assert.match(source, /enableReview:\s*options\.reviewModelName\s*!==\s*undefined/u);
});

test('testTechniqueBookModelBatch: 应输出独立的复评启用状态与未启用文案', () => {
  const source = readBatchScriptSource();

  assert.match(source, /balanceReviewEnabled:\s*result\.balanceReview\.enabled/u);
  assert.match(source, /\[未启用复评\]/u);
});
