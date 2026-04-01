/**
 * 秘境 reward_mult 掉落接线测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `battleDropService.rollDrops` 已经消费秘境难度 `reward_mult`，确保实际战斗掉落概率会随难度放大。
 * 2. 做什么：锁定“不吃额外倍率的固定 BOSS 掉落池”继续按原配置判定，不被 reward_mult 拉高。
 * 3. 不做什么：不验证经验、银两、首通奖励，也不触发真实数据库写入。
 *
 * 输入 / 输出：
 * - 输入：最小化内联概率池、秘境场景参数、固定的 `Math.random()` 序列。
 * - 输出：普通池在 `reward_mult` 放大后可命中；排除池在同倍率下仍维持原始概率。
 *
 * 数据流 / 状态流：
 * - 测试直接调用 `rollDrops`；
 * - `rollDrops` 内部会走共享掉落倍率工具；
 * - 因此该测试能同时约束 battle/settlement 的真实结算链路与秘境掉落概率口径。
 *
 * 复用设计说明：
 * 1. 这里复用 battleDropService 的真实入口，而不是复制共享函数公式，避免测试与实现双份漂移。
 * 2. 排除池 ID 与掉落倍率判断都走共享层，后续再调 reward_mult 规则时，这个测试会第一时间暴露断裂点。
 * 3. 概率池场景足以覆盖“掉落率乘 reward_mult”的核心变化点，避免把无关分发逻辑耦进这组测试。
 *
 * 关键边界条件与坑点：
 * 1. `reward_mult` 作用于掉落率，不作用于数量，所以断言只看是否命中，不看数量放大。
 * 2. 排除规则按来源池 ID 生效，不能错误地按物品 ID 或怪物 ID 做分支。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { battleDropService } from '../battleDropService.js';

const buildProbabilityPool = (sourcePoolId: string) => ({
  id: `test-${sourcePoolId}`,
  name: '测试概率池',
  mode: 'prob' as const,
  entries: [
    {
      id: 1,
      item_def_id: 'cons-rename-001',
      chance: 0.4,
      weight: 0,
      chance_add_by_monster_realm: 0,
      qty_min: 1,
      qty_max: 1,
      qty_min_add_by_monster_realm: 0,
      qty_max_add_by_monster_realm: 0,
      qty_multiply_by_monster_realm: 1,
      quality_weights: null,
      bind_type: 'none',
      sourceType: 'common' as const,
      sourcePoolId,
    },
  ],
});

test('秘境普通掉落池应按 reward_mult 放大掉落概率', (t) => {
  const dropPool = buildProbabilityPool('dp-common-monster-global');

  t.mock.method(Math, 'random', () => 0.6);

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: true,
      monsterKind: 'boss',
      dungeonRewardMultiplier: 2,
    }),
    [
      {
        itemDefId: 'cons-rename-001',
        quantity: 6,
        bindType: 'none',
      },
    ],
  );
});

test('固定秘境 BOSS 池不应按 reward_mult 放大掉落概率', (t) => {
  const dropPool = buildProbabilityPool('dp-common-dungeon-boss-unbind');

  t.mock.method(Math, 'random', () => 0.6);

  assert.deepEqual(
    battleDropService.rollDrops(dropPool, 0, {
      isDungeonBattle: true,
      monsterKind: 'boss',
      dungeonRewardMultiplier: 2,
    }),
    [],
  );
});
