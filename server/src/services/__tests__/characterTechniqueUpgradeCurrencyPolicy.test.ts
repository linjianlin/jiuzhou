/**
 * 功法升级角色资源扣减策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定功法升级必须复用共享资源扣减入口，避免再次回退成手写 `UPDATE characters`。
 * 2. 做什么：保证主动成长链路和结算链路共用同一套 pending Delta 资源口径。
 * 3. 不做什么：不连接真实数据库，不覆盖材料扣除或成就推进流程。
 *
 * 输入/输出：
 * - 输入：功法服务源码文本。
 * - 输出：共享入口调用与禁用旧 SQL 的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查共享资源扣减入口 -> 断言旧的直接角色资源 SQL 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时断言“共享入口存在”和“旧 SQL 消失”，否则后续重构可能只是套一层辅助函数，却把旧热点保留下来。
 * 2. 这里只锁定角色资源扣减协议，不约束材料锁或功法层数锁，避免测试把无关实现细节绑死。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('功法升级应复用共享原子扣费入口', () => {
  const source = readSource('../characterTechniqueService.ts');

  assert.match(source, /consumeCharacterStoredResourcesAndMaterialsAtomically\(characterId,\s*\{/u);
  assert.doesNotMatch(source, /UPDATE characters\s+SET spirit_stones = spirit_stones -/u);
  assert.doesNotMatch(source, /SELECT spirit_stones,\s*exp FROM characters WHERE id = \$1 FOR UPDATE/u);
});
