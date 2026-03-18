/**
 * 战斗技能输入归一化与转换共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一把 SkillData/技能定义中的 target_type、damage_type、trigger_type 转成 BattleSkill 可执行结构。
 * 2. 做什么：集中维护技能效果深拷贝规则，避免不同装配入口对同一技能得出不同 triggerType。
 * 3. 不做什么：不读取数据库、不加载静态配置，也不决定技能槽顺序。
 *
 * 输入/输出：
 * - 输入：`BattleSkillDataInput`，即战斗装配阶段的原始技能数据。
 * - 输出：可直接交给 BattleEngine 使用的 `BattleSkill`。
 *
 * 数据流/状态流：
 * - skill_def/generated_skill_def/角色技能槽 -> SkillData -> 本模块统一转换 -> battleFactory / snapshot / monster runtime 复用。
 *
 * 关键边界条件与坑点：
 * 1. `trigger_type` 一旦丢失会把被动技能错误塞进主动轮转，因此必须在单一入口归一化并保留。
 * 2. `effects` 必须逐项浅拷贝，避免多个战斗实例共享同一份技能效果数组导致运行时串改。
 */

import type { BattleSkill, SkillEffect } from '../types.js';
import {
  normalizeExplicitSkillTriggerType,
  resolveSkillTriggerType,
} from '../../shared/skillTriggerType.js';

export type BattleSkillDataInput = {
  id: string;
  name: string;
  cost_lingqi: number;
  cost_lingqi_rate: number;
  cost_qixue: number;
  cost_qixue_rate: number;
  cooldown: number;
  target_type: string;
  target_count: number;
  damage_type: string;
  element: string;
  effects: SkillEffect[];
  trigger_type?: BattleSkill['triggerType'];
  ai_priority: number;
};

const SKILL_TARGET_TYPE_SET = new Set<BattleSkill['targetType']>([
  'self',
  'single_enemy',
  'single_ally',
  'all_enemy',
  'all_ally',
  'random_enemy',
  'random_ally',
]);

const toText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export function normalizeSkillTargetType(raw: string): BattleSkill['targetType'] {
  const target = toText(raw);
  return SKILL_TARGET_TYPE_SET.has(target as BattleSkill['targetType'])
    ? (target as BattleSkill['targetType'])
    : 'single_enemy';
}

export function normalizeSkillDamageType(raw: string): BattleSkill['damageType'] {
  const damageType = toText(raw);
  if (damageType === 'physical' || damageType === 'magic' || damageType === 'true') {
    return damageType;
  }
  return undefined;
}

export function normalizeSkillTriggerType(raw: string | null | undefined): BattleSkill['triggerType'] {
  return normalizeExplicitSkillTriggerType(raw);
}

export function toBattleSkillFromSkillData(skill: BattleSkillDataInput): BattleSkill {
  return {
    id: skill.id,
    name: skill.name,
    source: 'innate',
    cost: {
      lingqi: skill.cost_lingqi,
      lingqiRate: skill.cost_lingqi_rate,
      qixue: skill.cost_qixue,
      qixueRate: skill.cost_qixue_rate,
    },
    cooldown: skill.cooldown,
    targetType: normalizeSkillTargetType(skill.target_type),
    targetCount: Math.max(1, Math.floor(skill.target_count || 1)),
    damageType: normalizeSkillDamageType(skill.damage_type),
    element: toText(skill.element) || 'none',
    effects: skill.effects.map((effect) => ({ ...effect })),
    triggerType: resolveSkillTriggerType({
      triggerType: skill.trigger_type,
      effects: skill.effects,
    }),
    aiPriority: Math.max(0, Math.floor(skill.ai_priority || 0)),
  };
}
