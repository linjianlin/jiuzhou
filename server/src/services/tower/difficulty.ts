/**
 * 千层塔难度曲线纯函数。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护千层塔楼层倍率曲线，让算法、测试与后续调数只复用这一处公式。
 * 2. 做什么：把“基础平滑增长”“层型加成”“overflow 软增长”拆开，避免 `algorithm.ts` 再次出现多段倍率散落拼装。
 * 3. 不做什么：不负责怪物选择、不负责境界池推进、不读写数据库。
 *
 * 输入/输出：
 * - 输入：`floor`、`kind`、`overflowTierCount`。
 * - 输出：最终应用到怪物 `base_attrs` 的倍率。
 *
 * 数据流/状态流：
 * - tower algorithm 先解析楼层与 overflow -> 本模块统一算倍率 -> algorithm 把倍率应用到怪物属性。
 *
 * 关键边界条件与坑点：
 * 1. 整条曲线必须单调递增，否则高层可能出现比低层更弱的倒挂。
 * 2. overflow 只能做软增长，不能重新制造高层台阶尖峰；因此这里只允许对数级补偿，不允许线性猛抬。
 */

import type { TowerFloorKind } from './types.js';

const TOWER_LINEAR_GROWTH_PER_FLOOR = 0.013;
const TOWER_CURVE_GROWTH_FACTOR = 0.0012;
const TOWER_CURVE_GROWTH_EXPONENT = 1.35;
const TOWER_ELITE_MULTIPLIER = 1.07;
const TOWER_BOSS_MULTIPLIER = 1.135;
const TOWER_OVERFLOW_LOG_GROWTH = 0.03;

const normalizeFloor = (floor: number): number => {
  return Math.max(1, Math.floor(floor));
};

const normalizeOverflowTierCount = (overflowTierCount: number): number => {
  return Math.max(0, Math.floor(overflowTierCount));
};

const resolveBaseTowerCurve = (floor: number): number => {
  const progress = normalizeFloor(floor) - 1;
  return 1
    + progress * TOWER_LINEAR_GROWTH_PER_FLOOR
    + Math.pow(progress, TOWER_CURVE_GROWTH_EXPONENT) * TOWER_CURVE_GROWTH_FACTOR;
};

const resolveTowerKindMultiplier = (kind: TowerFloorKind): number => {
  if (kind === 'boss') return TOWER_BOSS_MULTIPLIER;
  if (kind === 'elite') return TOWER_ELITE_MULTIPLIER;
  return 1;
};

const resolveTowerOverflowMultiplier = (overflowTierCount: number): number => {
  const normalized = normalizeOverflowTierCount(overflowTierCount);
  return 1 + Math.log1p(normalized) * TOWER_OVERFLOW_LOG_GROWTH;
};

export const resolveTowerAttrMultiplier = (params: {
  floor: number;
  kind: TowerFloorKind;
  overflowTierCount: number;
}): number => {
  const baseCurve = resolveBaseTowerCurve(params.floor);
  const kindMultiplier = resolveTowerKindMultiplier(params.kind);
  const overflowMultiplier = resolveTowerOverflowMultiplier(params.overflowTierCount);

  return Number((baseCurve * kindMultiplier * overflowMultiplier).toFixed(6));
};
