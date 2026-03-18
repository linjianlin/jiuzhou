/**
 * 技能触发类型共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护技能 `triggerType/trigger_type` 的归一化规则，避免战斗装配、静态配置读取、AI 生成功法清洗各自写一套。
 * 2. 做什么：把“含光环效果的技能必须按被动处理”“只有主动技能才能进入手动配技/策略列表”收敛成单一入口。
 * 3. 做什么：提供被动技能运行时前置约束校验，避免生成链路和配置链路各自手写一套判断。
 * 4. 不做什么：不负责技能效果完整合法性校验，不决定战斗目标选择，也不执行战斗逻辑。
 *
 * 输入/输出：
 * - 输入：原始触发类型字符串、技能效果数组中最小必要字段（`type` / `buffKind`），以及被动技能校验所需的目标/消耗/冷却字段。
 * - 输出：规范化后的触发类型、是否允许手动配置，以及被动技能配置校验结果。
 *
 * 数据流/状态流：
 * 技能定义/生成技能/战斗技能数据 -> 本模块统一解析触发类型/可手动施放性 -> 战斗构建、技能详情展示、AI candidate 清洗、角色与伙伴配技复用。
 *
 * 关键边界条件与坑点：
 * 1. 光环业务规则是“效果决定触发类型”，即使存量数据把 `trigger_type` 错写成 `active`，这里也必须强制归一到 `passive`，否则会在多个消费端同时出错。
 * 2. 这里只识别外层 `buff/debuff + buffKind=aura`；光环子效果中的普通 buff/debuff 不应把宿主技能误判成光环技能。
 * 3. 当前战斗引擎只支持 `passive` 技能在进场时以 `self + 0消耗 + 0冷却` 自动执行，因此生成链路必须在这里复用同一套约束，避免面板、落库、实战各自放宽。
 */

export type SkillTriggerType = 'active' | 'passive' | 'counter' | 'chase';

type AuraInspectableSkillEffect = {
  type?: string;
  buffKind?: string;
};

type PassiveSkillConfigValidationResult =
  | { success: true }
  | { success: false; reason: string };

const SKILL_TRIGGER_TYPE_SET = new Set<SkillTriggerType>([
  'active',
  'passive',
  'counter',
  'chase',
]);

const toText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

export const normalizeExplicitSkillTriggerType = (
  raw: string | null | undefined,
): SkillTriggerType => {
  const triggerType = toText(raw);
  return SKILL_TRIGGER_TYPE_SET.has(triggerType as SkillTriggerType)
    ? (triggerType as SkillTriggerType)
    : 'active';
};

export const skillHasAuraEffect = (
  effects: readonly AuraInspectableSkillEffect[] | null | undefined,
): boolean => {
  if (!effects || effects.length === 0) return false;
  return effects.some((effect) => {
    if (!effect) return false;
    const effectType = toText(effect.type);
    if (effectType !== 'buff' && effectType !== 'debuff') return false;
    return toText(effect.buffKind) === 'aura';
  });
};

export const resolveSkillTriggerType = (params: {
  triggerType?: string | null;
  effects?: readonly AuraInspectableSkillEffect[] | null;
}): SkillTriggerType => {
  if (skillHasAuraEffect(params.effects)) {
    return 'passive';
  }
  return normalizeExplicitSkillTriggerType(params.triggerType);
};

export const isManualSkillTriggerType = (triggerType: SkillTriggerType): boolean => {
  return triggerType === 'active';
};

const isZeroLikeNumber = (value: number | null | undefined): boolean => {
  if (value === null || value === undefined) return true;
  return Number.isFinite(value) && Math.abs(value) <= 1e-9;
};

export const validatePassiveSkillConfig = (params: {
  triggerType: SkillTriggerType;
  targetType?: string | null;
  cooldown?: number | null;
  costLingqi?: number | null;
  costLingqiRate?: number | null;
  costQixue?: number | null;
  costQixueRate?: number | null;
}): PassiveSkillConfigValidationResult => {
  if (params.triggerType !== 'passive') {
    return { success: true };
  }
  if (toText(params.targetType) !== 'self') {
    return { success: false, reason: '被动技能 targetType 必须为 self' };
  }
  if (!isZeroLikeNumber(params.cooldown)) {
    return { success: false, reason: '被动技能 cooldown 必须为 0' };
  }
  if (!isZeroLikeNumber(params.costLingqi) || !isZeroLikeNumber(params.costLingqiRate)) {
    return { success: false, reason: '被动技能灵气消耗必须为 0' };
  }
  if (!isZeroLikeNumber(params.costQixue) || !isZeroLikeNumber(params.costQixueRate)) {
    return { success: false, reason: '被动技能气血消耗必须为 0' };
  }
  return { success: true };
};
