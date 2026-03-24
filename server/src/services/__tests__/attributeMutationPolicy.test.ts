/**
 * 属性加点并发协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定属性加点/减点必须使用单条条件更新，避免“先查再改”放大同一角色行锁争用。
 * 2. 做什么：锁定 Socket 加点入口必须复用 attributeService，而不是在 gameServer 再保留第二套更新 SQL。
 * 3. 不做什么：不连接真实数据库，不验证触发器效果，也不覆盖角色面板推送链路。
 *
 * 输入/输出：
 * - 输入：attributeService 与 gameServer 源码文本。
 * - 输出：属性变更 SQL 协议与复用关系断言。
 *
 * 数据流/状态流：
 * 读取源码 -> 校验服务层是否使用单条条件更新 -> 校验 Socket 入口是否复用服务层。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁并发协议，不锁具体文案；重点是不要再回退到两段式“先 SELECT 再 UPDATE”。
 * 2. Socket 与 HTTP 若各自保留一套 SQL，后续任何并发修复都会再次分叉。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('属性变更应走服务层单条条件更新并被 Socket 入口复用', () => {
  const attributeServiceSource = readFileSync(
    new URL('../attributeService.ts', import.meta.url),
    'utf8',
  );
  const gameServerSource = readFileSync(
    new URL('../../game/gameServer.ts', import.meta.url),
    'utf8',
  );

  assert.match(attributeServiceSource, /WITH target_character AS/u);
  assert.match(attributeServiceSource, /attribute_points >= \$2/u);
  assert.match(attributeServiceSource, /\$\{attribute\} >= \$2/u);
  assert.doesNotMatch(attributeServiceSource, /SELECT attribute_points FROM characters WHERE user_id = \$1/u);

  assert.match(gameServerSource, /addAttributePoint/u);
  assert.doesNotMatch(gameServerSource, /private async saveAttributePoints/u);
});
