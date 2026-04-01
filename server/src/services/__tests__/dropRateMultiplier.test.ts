/**
 * 通用掉落池倍率与特殊概率规则测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证通用池倍率排除规则、秘境 reward_mult 的掉落率放大规则，以及按配置声明的境界追加概率会被共享倍率入口统一应用。
 * - 不做什么：不覆盖完整战斗掉落实例，也不验证福缘、境界压制等其他倍率链路。
 *
 * 输入/输出：
 * - 输入：公共池来源类型、公共池 ID、秘境 BOSS 场景下的基础概率/数量。
 * - 输出：倍率工具返回的仍应是统一业务规则下的概率、权重与数量。
 *
 * 数据流/状态流：
 * - 测试直接调用共享倍率工具；
 * - 共享倍率工具被战斗结算与 UI 预览共同复用；
 * - 因此该测试同时约束这两条链路对固定 BOSS 池、reward_mult 与配置化境界加成的概率口径。
 *
 * 关键边界条件与坑点：
 * 1. 被排除的固定 BOSS 池必须同时跳过通用倍率与 reward_mult，避免高难度把固定产出池抬高。
 * 2. 额外概率由条目配置驱动；凡人境界维持原值，每升一阶按配置值增加绝对概率，之后再统一乘 reward_mult。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getAdjustedChance, getAdjustedQuantity, getAdjustedWeight } from '../shared/dropRateMultiplier.js';

const DUNGEON_BOSS_UNBIND_POOL_ID = 'dp-common-dungeon-boss-unbind';
const DUNGEON_BOSS_ADVANCED_RECRUIT_TOKEN_POOL_ID = 'dp-common-dungeon-boss-advanced-recruit-token';

test('秘境 BOSS 解绑道具公共池不应放大概率与数量', () => {
  const options = { isDungeonBattle: true, monsterKind: 'boss' as const };

  assert.equal(
    getAdjustedChance(0.005, 'common', DUNGEON_BOSS_UNBIND_POOL_ID, options),
    0.005,
  );
  assert.equal(
    getAdjustedQuantity(1, 'common', DUNGEON_BOSS_UNBIND_POOL_ID, options, true),
    1,
  );
});

test('秘境 BOSS 高级招募令公共池不应放大概率与数量', () => {
  const options = { isDungeonBattle: true, monsterKind: 'boss' as const };

  assert.equal(
    getAdjustedChance(0.001, 'common', DUNGEON_BOSS_ADVANCED_RECRUIT_TOKEN_POOL_ID, options),
    0.001,
  );
  assert.equal(
    getAdjustedQuantity(1, 'common', DUNGEON_BOSS_ADVANCED_RECRUIT_TOKEN_POOL_ID, options, true),
    1,
  );
});

test('其他未排除公共池仍应按秘境 BOSS 规则放大', () => {
  const options = { isDungeonBattle: true, monsterKind: 'boss' as const };

  assert.equal(getAdjustedChance(0.005, 'common', 'dp-common-monster-global', options), 0.03);
  assert.equal(getAdjustedQuantity(1, 'common', 'dp-common-monster-global', options, true), 6);
});

test('秘境 reward_mult 应放大非排除池的物品掉落概率与权重', () => {
  const options = {
    isDungeonBattle: true,
    monsterKind: 'boss' as const,
    dungeonRewardMultiplier: 1.5,
  };

  assert.equal(getAdjustedChance(0.01, 'common', 'dp-common-monster-global', options), 0.09);
  assert.equal(getAdjustedWeight(2, 'common', 'dp-common-monster-global', options), 18);
});

test('固定秘境 BOSS 池不应乘 reward_mult', () => {
  const options = {
    isDungeonBattle: true,
    monsterKind: 'boss' as const,
    dungeonRewardMultiplier: 3,
  };

  assert.equal(
    getAdjustedChance(0.01, 'common', DUNGEON_BOSS_UNBIND_POOL_ID, options),
    0.01,
  );
  assert.equal(
    getAdjustedChance(0.002, 'common', DUNGEON_BOSS_ADVANCED_RECRUIT_TOKEN_POOL_ID, options),
    0.002,
  );
  assert.equal(
    getAdjustedWeight(2, 'common', DUNGEON_BOSS_UNBIND_POOL_ID, options),
    2,
  );
});

test('配置了境界概率步进值的条目应按怪物境界递增概率', () => {
  assert.equal(
    getAdjustedChance(0.01, 'common', 'dp-common-monster-global', {
      monsterKind: 'normal',
      monsterRealm: '凡人',
      chanceAddByMonsterRealm: 0.005,
    }),
    0.01,
  );

  assert.equal(
    getAdjustedChance(0.01, 'common', 'dp-common-monster-global', {
      monsterKind: 'normal',
      monsterRealm: '炼精化炁·养气期',
      chanceAddByMonsterRealm: 0.005,
    }),
    0.015,
  );

  assert.equal(
    getAdjustedChance(0.01, 'common', 'dp-common-monster-global', {
      monsterKind: 'normal',
      monsterRealm: '炼炁化神·结胎期',
      chanceAddByMonsterRealm: 0.005,
    }),
    0.04,
  );
});

test('未配置境界概率步进值的条目不应吃到额外概率加成', () => {
  assert.equal(
    getAdjustedChance(0.01, 'common', 'dp-common-monster-global', {
      monsterKind: 'normal',
      monsterRealm: '炼炁化神·结胎期',
    }),
    0.01,
  );
});
