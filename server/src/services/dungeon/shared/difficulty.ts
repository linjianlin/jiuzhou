/**
 * 秘境难度系数工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一解析秘境难度配置里的怪物属性倍率与奖励倍率，供开战链路和结算链路共用。
 * 2. 做什么：提供“把难度倍率应用到已解析怪物数据”的单一入口，避免 battle 与 combat 两侧各自复制一份缩放逻辑。
 * 3. 不做什么：不读取数据库，不决定秘境难度选择，也不处理掉落池本身的随机逻辑。
 *
 * 输入 / 输出：
 * - 输入：难度配置上的 `monster_attr_mult / reward_mult`，以及已解析好的怪物列表。
 * - 输出：规范化后的倍率数值，或已经应用难度倍率的新怪物列表。
 *
 * 数据流 / 状态流：
 * 静态配置加载器读取难度定义 -> 本模块统一解析倍率 -> 开战链路消费怪物倍率 / 结算链路消费奖励倍率。
 *
 * 复用设计说明：
 * 1. 秘境难度已经在静态种子中声明了两类系数，但此前没有统一消费入口；把口径集中在这里后，战斗与奖励不会再各写一套默认值与缩放规则。
 * 2. 怪物列表缩放单独封装后，`battle/pve.ts` 只负责起战流程，不再感知秘境难度字段细节。
 * 3. 高频变化点是难度系数调数；未来如果只调倍率，不需要碰战斗流程与结算流程的主体代码。
 *
 * 关键边界条件与坑点：
 * 1. 难度倍率必须始终大于 0；非法值不能继续传进战斗或奖励计算，否则会产生 0 倍奖励或负倍率怪物。
 * 2. 同一波次中相同怪物 ID 可能重复出现，缩放时需要按 ID 复用结果，避免重复构造大对象。
 */

import type { MonsterData } from '../../../battle/battleFactory.js';
import { scaleMonsterBaseAttrs } from '../../shared/monsterBaseAttrScaling.js';

type DungeonDifficultyMultiplierInput = number | string | null | undefined;

const normalizeDungeonDifficultyMultiplier = (
  value: DungeonDifficultyMultiplierInput,
): number => {
  const normalized = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 1;
};

export const resolveDungeonMonsterAttrMultiplier = (
  value: DungeonDifficultyMultiplierInput,
): number => {
  return normalizeDungeonDifficultyMultiplier(value);
};

export const resolveDungeonRewardMultiplier = (
  value: DungeonDifficultyMultiplierInput,
): number => {
  return normalizeDungeonDifficultyMultiplier(value);
};

export const applyDungeonDifficultyToMonsters = (
  monsters: readonly MonsterData[],
  monsterAttrMultiplierValue: DungeonDifficultyMultiplierInput,
): MonsterData[] => {
  const multiplier = resolveDungeonMonsterAttrMultiplier(monsterAttrMultiplierValue);
  if (multiplier === 1) {
    return [...monsters];
  }

  const scaledMonsterById = new Map<string, MonsterData>();
  return monsters.map((monster) => {
    const cached = scaledMonsterById.get(monster.id);
    if (cached) return cached;

    const scaledMonster: MonsterData = {
      ...monster,
      base_attrs: scaleMonsterBaseAttrs(monster.base_attrs, multiplier),
    };
    scaledMonsterById.set(monster.id, scaledMonster);
    return scaledMonster;
  });
};
