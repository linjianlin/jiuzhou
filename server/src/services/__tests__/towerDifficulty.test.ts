/**
 * 千层塔难度曲线回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定千层塔倍率从前期到后期保持连续增长，避免后续调数重新引入“某一段突然暴涨”的尖峰。
 * 2. 做什么：验证精英层、首领层仍然高于普通层，保留楼层节奏差异，但差异受控。
 * 3. 不做什么：不校验怪物选择、数据库进度、battle session，仅关注难度倍率纯函数。
 *
 * 输入/输出：
 * - 输入：楼层、层型、境界封顶后的 overflow 档位。
 * - 输出：该层应应用到怪物基础属性上的倍率。
 *
 * 数据流/状态流：
 * - 测试 -> tower difficulty 纯函数 -> 返回倍率 -> 断言平滑性与层型差异。
 *
 * 关键边界条件与坑点：
 * 1. 平滑不等于平坦，倍率仍需单调增长，否则玩家会遇到高层反而变简单的倒挂。
 * 2. 首领层必须更强，但不能像旧公式那样在高层突然跳一个台阶。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTowerAttrMultiplier } from '../tower/difficulty.js';

test('resolveTowerAttrMultiplier: 第 1 层普通层应作为整条曲线起点', () => {
  assert.equal(
    resolveTowerAttrMultiplier({
      floor: 1,
      kind: 'normal',
      overflowTierCount: 0,
    }),
    1,
  );
});

test('resolveTowerAttrMultiplier: 普通层倍率应随楼层平滑递增', () => {
  const normalFloors = [1, 2, 3, 4, 6, 7, 8, 9, 11, 21, 31, 41, 51, 61, 71, 81, 91, 101, 111];
  const multipliers = normalFloors.map((floor) =>
    resolveTowerAttrMultiplier({
      floor,
      kind: 'normal',
      overflowTierCount: 0,
    }),
  );

  for (let index = 1; index < multipliers.length; index += 1) {
    assert.ok(
      multipliers[index]! > multipliers[index - 1]!,
      `普通层倍率没有递增: floor=${normalFloors[index - 1]} -> ${normalFloors[index]}`,
    );
  }
});

test('resolveTowerAttrMultiplier: 高层首领层十层增幅不应出现尖峰', () => {
  const bossFloors = [
    { floor: 10, overflowTierCount: 0 },
    { floor: 20, overflowTierCount: 0 },
    { floor: 30, overflowTierCount: 0 },
    { floor: 40, overflowTierCount: 0 },
    { floor: 50, overflowTierCount: 0 },
    { floor: 60, overflowTierCount: 0 },
    { floor: 70, overflowTierCount: 0 },
    { floor: 80, overflowTierCount: 0 },
    { floor: 90, overflowTierCount: 1 },
    { floor: 100, overflowTierCount: 2 },
    { floor: 110, overflowTierCount: 3 },
    { floor: 120, overflowTierCount: 4 },
  ];
  const multipliers = bossFloors.map(({ floor, overflowTierCount }) =>
    resolveTowerAttrMultiplier({
      floor,
      kind: 'boss',
      overflowTierCount,
    }),
  );

  const decadeRatios = multipliers.slice(1).map((value, index) => value / multipliers[index]!);

  for (const ratio of decadeRatios) {
    assert.ok(ratio < 1.18, `十层首领层增幅过大: ratio=${ratio}`);
  }

  const lateSpike = decadeRatios[7];
  const previousRatio = decadeRatios[6];
  assert.ok(
    lateSpike != null && previousRatio != null && lateSpike - previousRatio < 0.03,
    `80 -> 90 层首领层增幅出现尖峰: previous=${previousRatio}, next=${lateSpike}`,
  );
});

test('resolveTowerAttrMultiplier: 层型加成应存在但保持可控', () => {
  const normalBeforeElite = resolveTowerAttrMultiplier({
    floor: 24,
    kind: 'normal',
    overflowTierCount: 0,
  });
  const elite = resolveTowerAttrMultiplier({
    floor: 25,
    kind: 'elite',
    overflowTierCount: 0,
  });
  const normalBeforeBoss = resolveTowerAttrMultiplier({
    floor: 29,
    kind: 'normal',
    overflowTierCount: 0,
  });
  const boss = resolveTowerAttrMultiplier({
    floor: 30,
    kind: 'boss',
    overflowTierCount: 0,
  });

  assert.ok(elite > normalBeforeElite, '精英层应强于相邻普通层');
  assert.ok(boss > normalBeforeBoss, '首领层应强于相邻普通层');
  assert.ok(elite / normalBeforeElite < 1.12, `精英层加成过大: ratio=${elite / normalBeforeElite}`);
  assert.ok(boss / normalBeforeBoss < 1.15, `首领层加成过大: ratio=${boss / normalBeforeBoss}`);
});
