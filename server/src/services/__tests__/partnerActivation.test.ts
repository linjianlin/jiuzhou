/**
 * 伙伴出战切换 SQL 顺序回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住“同一角色只能有一个出战伙伴”时的安全切换顺序，避免再次用单条 `CASE WHEN` 更新撞上唯一索引。
 * 2. 做什么：验证共享切换函数既支持“切到指定伙伴出战”，也支持“清空当前出战伙伴”，确保业务规则保持单一入口。
 * 3. 不做什么：不连接真实数据库，不验证伙伴详情组装，只关注 SQL 调用顺序与参数。
 *
 * 输入/输出：
 * - 输入：角色 ID、目标伙伴 ID，以及测试内注入的 SQL 执行器。
 * - 输出：记录下来的 SQL 文本与参数顺序。
 *
 * 数据流/状态流：
 * 测试构造假的 query 执行器 -> 调用伙伴切换共享函数 -> 断言先执行“取消旧出战”SQL，再按动作决定是否激活新伙伴。
 *
 * 关键边界条件与坑点：
 * 1. 这里不依赖数据库真实执行顺序，而是直接锁定服务层允许发出的 SQL 形态，避免再次出现危险的 `CASE WHEN id = $2 THEN TRUE ELSE FALSE END`。
 * 2. 激活目标伙伴时，第二条更新必须带上 `character_id + id` 双条件，防止未来复用时误把别的角色伙伴激活。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { setCharacterPartnerActivation } from '../shared/partnerActivation.js';

test('setCharacterPartnerActivation: 应先取消旧出战再激活目标伙伴', async () => {
  const calls: Array<{ sql: string; params: readonly (string | number | boolean | null)[] }> = [];

  await setCharacterPartnerActivation({
    characterId: 101,
    partnerId: 202,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0]?.sql ?? '', /UPDATE character_partner[\s\S]*SET is_active = FALSE/);
  assert.match(calls[0]?.sql ?? '', /WHERE character_id = \$1 AND is_active = TRUE/);
  assert.deepEqual(calls[0]?.params, [101]);

  assert.match(calls[1]?.sql ?? '', /UPDATE character_partner[\s\S]*SET is_active = TRUE/);
  assert.match(calls[1]?.sql ?? '', /WHERE character_id = \$1 AND id = \$2/);
  assert.deepEqual(calls[1]?.params, [101, 202]);
});

test('setCharacterPartnerActivation: 清空当前出战伙伴时只应执行取消出战 SQL', async () => {
  const calls: Array<{ sql: string; params: readonly (string | number | boolean | null)[] }> = [];

  await setCharacterPartnerActivation({
    characterId: 303,
    partnerId: null,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.sql ?? '', /UPDATE character_partner[\s\S]*SET is_active = FALSE/);
  assert.match(calls[0]?.sql ?? '', /WHERE character_id = \$1 AND is_active = TRUE/);
  assert.deepEqual(calls[0]?.params, [303]);
});

test('setCharacterPartnerActivation: 不应再使用会撞唯一索引的 CASE WHEN 批量切换', async () => {
  const sqlTexts: string[] = [];

  await setCharacterPartnerActivation({
    characterId: 7,
    partnerId: 8,
    execute: async (sql) => {
      sqlTexts.push(sql);
      return { rows: [] };
    },
  });

  assert.equal(sqlTexts.some((sql) => /CASE WHEN id = \$2 THEN TRUE ELSE FALSE END/.test(sql)), false);
});
