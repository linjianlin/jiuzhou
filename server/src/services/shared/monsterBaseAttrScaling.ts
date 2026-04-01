/**
 * 怪物基础属性倍率工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理怪物 `base_attrs` 的倍率缩放，供千层塔、秘境难度等需要“在战斗前一次性放大怪物基础属性”的链路复用。
 * 2. 做什么：把比例属性与整数属性的缩放口径集中到单一入口，避免不同玩法各自维护一套四舍五入与精度规则。
 * 3. 不做什么：不读取静态配置，不决定倍率来源，也不处理遭遇战随机波动。
 *
 * 输入 / 输出：
 * - 输入：怪物 `base_attrs` 与已经确定好的倍率。
 * - 输出：按统一规则缩放后的新 `base_attrs` 对象。
 *
 * 数据流 / 状态流：
 * 难度/楼层规则模块先解析倍率 -> 本模块缩放怪物基础属性 -> 战斗创建阶段继续叠加各玩法自己的后续规则。
 *
 * 复用设计说明：
 * 1. 千层塔与秘境都需要对怪物基础属性做一次性缩放，如果各自维护比例属性名单和取整规则，后续调数会出现漂移。
 * 2. 把缩放逻辑收口后，玩法层只关心“倍率是多少”，不再重复关心“哪些属性保留小数、哪些属性取整”。
 * 3. 高风险变化点是比例属性白名单；集中在这里后，新增属性时只需要同步一处。
 *
 * 关键边界条件与坑点：
 * 1. 比例属性必须保留小数精度，不能按整数取整，否则暴击、吸血等属性会被放大后直接失真。
 * 2. 非正数基础属性不参与缩放，避免把原本未配置或显式为 0 的字段错误放大成有效属性。
 */

import type { MonsterData } from '../../battle/battleFactory.js';
import { CHARACTER_RATIO_ATTR_KEY_SET } from './characterAttrRegistry.js';

const MONSTER_BASE_RATIO_ATTR_KEY_SET: ReadonlySet<keyof MonsterData['base_attrs']> = new Set(
  Array.from(CHARACTER_RATIO_ATTR_KEY_SET) as Array<keyof MonsterData['base_attrs']>,
);

const normalizeMonsterBaseAttrMultiplier = (value: number): number => {
  return Number.isFinite(value) && value > 0 ? value : 1;
};

export const scaleMonsterBaseAttrs = (
  raw: MonsterData['base_attrs'] | undefined,
  multiplierRaw: number,
): MonsterData['base_attrs'] => {
  const source = raw ?? {};
  const multiplier = normalizeMonsterBaseAttrMultiplier(multiplierRaw);
  if (multiplier === 1) {
    return { ...source };
  }

  const next: MonsterData['base_attrs'] = {};
  for (const [attrKey, attrValue] of Object.entries(source)) {
    const value = Number(attrValue);
    if (!Number.isFinite(value) || value <= 0) continue;

    const typedAttrKey = attrKey as keyof MonsterData['base_attrs'];
    const scaled = value * multiplier;
    next[typedAttrKey] = MONSTER_BASE_RATIO_ATTR_KEY_SET.has(typedAttrKey)
      ? Number(scaled.toFixed(6))
      : Math.max(1, Math.round(scaled));
  }

  return next;
};
