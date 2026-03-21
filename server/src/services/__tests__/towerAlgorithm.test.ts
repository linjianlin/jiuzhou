/**
 * 千层塔算法回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“同角色同层必定生成同一批怪物/楼层预览”的稳定性，避免 hash 逻辑漂移后让楼层内容悄悄改变。
 * 2. 做什么：验证 5/10 层的层型节奏，防止后续重构把普通层、精英层、首领层判定写乱。
 * 3. 不做什么：不发起真实战斗，不校验数据库进度，也不覆盖掉落服务的随机分配实现。
 *
 * 输入/输出：
 * - 输入：角色 ID、楼层数。
 * - 输出：`resolveTowerFloor` 生成的楼层预览与怪物列表。
 *
 * 数据流/状态流：
 * - 调用 tower algorithm -> 读取静态怪物池 -> 断言层型与怪物预览符合预期规则。
 *
 * 关键边界条件与坑点：
 * 1. 这里锁的是“稳定性”和“节奏规则”，不是具体某只怪物名称；怪物池扩容后，测试仍应允许合法的新内容。
 * 2. 如果未来调整 5/10 层节奏，必须同步更新断言，否则会把设计变更误判成回归。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTowerFloor } from '../tower/algorithm.js';

test('resolveTowerFloor: 同角色同层应生成稳定一致的楼层结果', () => {
  const first = resolveTowerFloor({ characterId: 1001, floor: 17 });
  const second = resolveTowerFloor({ characterId: 1001, floor: 17 });

  assert.deepEqual(first.preview, second.preview);
  assert.deepEqual(first.monsters, second.monsters);
});

test('resolveTowerFloor: 第 5 层应为精英层', () => {
  const resolved = resolveTowerFloor({ characterId: 1001, floor: 5 });

  assert.equal(resolved.preview.kind, 'elite');
  assert.ok(resolved.monsters.length >= 1);
});

test('resolveTowerFloor: 第 10 层应为首领层且只有单个怪物', () => {
  const bossFloor = resolveTowerFloor({ characterId: 1001, floor: 10 });

  assert.equal(bossFloor.preview.kind, 'boss');
  assert.equal(bossFloor.monsters.length, 1);
});

test('resolveTowerFloor: 怪物静态配置中的注释项不应参与怪物池构建', () => {
  const resolved = resolveTowerFloor({ characterId: 1001, floor: 1 });

  assert.ok(resolved.preview.monsterIds.length > 0);
  for (const monsterId of resolved.preview.monsterIds) {
    assert.equal(typeof monsterId, 'string');
    assert.ok(monsterId.trim().length > 0);
  }
});
