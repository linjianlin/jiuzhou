/**
 * 秘境难度系数回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定秘境难度的怪物属性倍率与奖励倍率都会进入统一纯函数入口，避免继续出现“种子已配置、运行时未生效”。
 * 2. 做什么：验证同一波次重复怪物会复用同一份缩放结果，避免重复构造大对象。
 * 3. 不做什么：不启动真实秘境战斗，不访问数据库，也不覆盖在线结算整条链路。
 *
 * 输入 / 输出：
 * - 输入：秘境难度倍率、已解析怪物数据、静态奖励配置。
 * - 输出：缩放后的怪物属性与奖励包断言结果。
 *
 * 数据流 / 状态流：
 * 测试 -> `dungeon/shared/difficulty.ts` 纯函数 -> 必要时继续喂给 `rewards.ts` -> 断言倍率结果。
 *
 * 复用设计说明：
 * 1. 怪物缩放与奖励倍率都集中断言在一个测试文件，后续调数时只需要维护这一处，不必在战斗链路和奖励链路分别补重复断言。
 * 2. 高风险变化点是比例属性精度和默认倍率口径，因此测试直接覆盖这两个纯函数入口。
 *
 * 关键边界条件与坑点：
 * 1. 比例属性必须保留小数口径，不能被整数化。
 * 2. 非法倍率必须回落到 1，否则会把配置错误直接放大成战斗或奖励异常。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { MonsterData } from '../../battle/battleFactory.js';
import {
  applyDungeonDifficultyToMonsters,
  resolveDungeonMonsterAttrMultiplier,
  resolveDungeonRewardMultiplier,
} from '../dungeon/shared/difficulty.js';
import { rollDungeonRewardBundle } from '../dungeon/shared/rewards.js';

test('applyDungeonDifficultyToMonsters: 应按难度倍率缩放基础属性并复用重复怪物结果', () => {
  const monster: MonsterData = {
    id: 'monster-test',
    name: '测试怪',
    realm: '炼精化炁·养气期',
    element: 'none',
    attr_variance: 0.05,
    attr_multiplier_min: 0.9,
    attr_multiplier_max: 1.1,
    base_attrs: {
      max_qixue: 100,
      wugong: 20,
      baoji: 0.15,
    },
    skills: [],
    ai_profile: { skillIds: [], skillWeights: {}, phaseTriggers: [] },
    exp_reward: 10,
    silver_reward_min: 5,
    silver_reward_max: 8,
    kind: 'normal',
  };

  const scaledMonsters = applyDungeonDifficultyToMonsters([monster, monster], 1.4);

  assert.equal(scaledMonsters.length, 2);
  assert.notEqual(scaledMonsters[0], monster);
  assert.equal(scaledMonsters[0], scaledMonsters[1], '重复怪物应复用同一份缩放结果');
  assert.deepEqual(scaledMonsters[0]?.base_attrs, {
    max_qixue: 140,
    wugong: 28,
    baoji: 0.21,
  });
  assert.deepEqual(monster.base_attrs, {
    max_qixue: 100,
    wugong: 20,
    baoji: 0.15,
  });
  assert.equal(scaledMonsters[0]?.attr_multiplier_min, 0.9);
  assert.equal(scaledMonsters[0]?.attr_multiplier_max, 1.1);
});

test('resolveDungeon*Multiplier: 非法倍率应统一按 1 处理', () => {
  assert.equal(resolveDungeonMonsterAttrMultiplier(1.36), 1.36);
  assert.equal(resolveDungeonMonsterAttrMultiplier('1.52'), 1.52);
  assert.equal(resolveDungeonMonsterAttrMultiplier(0), 1);
  assert.equal(resolveDungeonRewardMultiplier(-2), 1);
  assert.equal(resolveDungeonRewardMultiplier('NaN'), 1);
});

test('rollDungeonRewardBundle: 奖励倍率应放大经验与银两奖励', () => {
  const rewardMultiplier = resolveDungeonRewardMultiplier('1.5');
  const rewardBundle = rollDungeonRewardBundle({
    exp: 120,
    silver: 80,
    items: [
      {
        item_def_id: 'mat-001',
        qty: 2,
      },
    ],
  }, rewardMultiplier);

  assert.equal(rewardBundle.exp, 180);
  assert.equal(rewardBundle.silver, 120);
  assert.deepEqual(rewardBundle.items, [
    {
      itemDefId: 'mat-001',
      qty: 2,
    },
  ]);
});
