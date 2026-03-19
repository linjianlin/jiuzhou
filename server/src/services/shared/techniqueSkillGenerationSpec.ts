/**
 * AI 功法技能机制共享规格
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护 AI 生成功法允许使用的技能 effect / upgrade 枚举、字段约束与结果校验，供 prompt 约束与服务端落库前校验复用。
 * 2) 不做什么：不负责数据库读写、不负责模型请求、不负责战斗执行。
 *
 * 输入/输出：
 * - 输入：单个技能效果对象 `SkillEffect`，以及单个升级项 JSON 对象。
 * - 输出：统一的校验结果 `{ success: true } | { success: false; reason }`，以及供 prompt 复用的枚举常量。
 *
 * 数据流/状态流：
 * battle 枚举/结构化 Buff 白名单 -> 本模块汇总为单一技能机制规格 -> techniqueGenerationConstraints/service/tests 共用。
 *
 * 关键边界条件与坑点：
 * 1) `control/mark` 的枚举必须直接复用战斗模块导出的运行时常量，避免 AI 侧白名单和实际战斗支持集合漂移。
 * 2) `upgrades[*].changes.effects/addEffect` 必须复用同一套 effect 校验；否则新增机制时很容易只放通基础技能，遗漏升级强化链路。
 */
import type { SkillEffect } from '../../battle/types.js';
import { CONTROL_TYPE_LIST } from '../../battle/modules/control.js';
import {
  MARK_CONSUME_MODE_LIST,
  MARK_ID_LIST,
  MARK_OPERATION_LIST,
  MARK_RESULT_TYPE_LIST,
} from '../../battle/modules/mark.js';
import {
  MOMENTUM_BONUS_TYPE_LIST,
  MOMENTUM_CONSUME_MODE_LIST,
  MOMENTUM_ID_LIST,
  MOMENTUM_OPERATION_LIST,
} from '../../battle/modules/momentum.js';
import { validateTechniqueStructuredBuffEffect } from './techniqueStructuredBuffCatalog.js';

type TechniqueJsonPrimitive = string | number | boolean | null;
type TechniqueJsonValue = TechniqueJsonPrimitive | TechniqueJsonObject | TechniqueJsonValue[];

export type TechniqueJsonObject = {
  [key: string]: TechniqueJsonValue | undefined;
};

export type TechniqueSkillUpgradeEntry = TechniqueJsonObject;

export type TechniqueSkillGenerationValidationResult =
  | { success: true }
  | { success: false; reason: string };

export const TECHNIQUE_SKILL_EFFECT_MAX_COUNT = 4;

export const TECHNIQUE_SKILL_EFFECT_TYPE_LIST = [
  'damage',
  'heal',
  'shield',
  'buff',
  'debuff',
  'dispel',
  'resource',
  'restore_lingqi',
  'cleanse',
  'cleanse_control',
  'lifesteal',
  'control',
  'mark',
  'momentum',
  'delayed_burst',
  'fate_swap',
] as const;

export const TECHNIQUE_SKILL_TARGET_TYPE_LIST = [
  'self',
  'single_enemy',
  'single_ally',
  'all_enemy',
  'all_ally',
  'random_enemy',
  'random_ally',
] as const;
export const TECHNIQUE_SKILL_TRIGGER_TYPE_LIST = ['active', 'passive'] as const;

export const TECHNIQUE_SKILL_VALUE_TYPE_LIST = ['flat', 'percent', 'scale', 'combined'] as const;
export const TECHNIQUE_SKILL_RESOURCE_TYPE_LIST = ['lingqi', 'qixue'] as const;
export const TECHNIQUE_SKILL_RESOURCE_TARGET_LIST = ['self', 'enemy', 'ally'] as const;
export const TECHNIQUE_SKILL_DISPEL_TYPE_LIST = ['buff', 'debuff', 'all'] as const;
export const TECHNIQUE_SKILL_SCALE_ATTR_LIST = [
  'max_qixue',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'jianfantan',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
] as const;

export const TECHNIQUE_SKILL_CONTROL_TYPE_LIST = CONTROL_TYPE_LIST;
export const TECHNIQUE_SKILL_MARK_ID_LIST = MARK_ID_LIST;
export const TECHNIQUE_SKILL_MARK_OPERATION_LIST = MARK_OPERATION_LIST;
export const TECHNIQUE_SKILL_MARK_CONSUME_MODE_LIST = MARK_CONSUME_MODE_LIST;
export const TECHNIQUE_SKILL_MARK_RESULT_TYPE_LIST = MARK_RESULT_TYPE_LIST;
export const TECHNIQUE_SKILL_MOMENTUM_ID_LIST = MOMENTUM_ID_LIST;
export const TECHNIQUE_SKILL_MOMENTUM_OPERATION_LIST = MOMENTUM_OPERATION_LIST;
export const TECHNIQUE_SKILL_MOMENTUM_CONSUME_MODE_LIST = MOMENTUM_CONSUME_MODE_LIST;
export const TECHNIQUE_SKILL_MOMENTUM_BONUS_TYPE_LIST = MOMENTUM_BONUS_TYPE_LIST;
export const TECHNIQUE_SKILL_FATE_SWAP_MODE_LIST = ['debuff_to_target', 'buff_to_self', 'shield_steal'] as const;

export const TECHNIQUE_SKILL_AURA_TARGET_LIST = ['all_ally', 'all_enemy', 'self'] as const;
export const TECHNIQUE_SKILL_AURA_SUB_EFFECT_TYPE_LIST = [
  'damage', 'heal', 'buff', 'debuff', 'resource', 'restore_lingqi',
] as const;

export const TECHNIQUE_SKILL_UPGRADE_ALLOWED_CHANGE_KEYS = [
  'target_count',
  'cooldown',
  'cost_lingqi',
  'cost_lingqi_rate',
  'cost_qixue',
  'cost_qixue_rate',
  'ai_priority',
  'effects',
  'addEffect',
] as const;

export const TECHNIQUE_SKILL_UPGRADE_UNSUPPORTED_FIELDS = [
  'description',
  'effectChanges',
  'effectIndex',
  'valueFormula',
] as const;

const EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_EFFECT_TYPE_LIST);
const VALUE_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_VALUE_TYPE_LIST);
const RESOURCE_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_RESOURCE_TYPE_LIST);
const RESOURCE_TARGET_SET = new Set<string>(TECHNIQUE_SKILL_RESOURCE_TARGET_LIST);
const DISPEL_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_DISPEL_TYPE_LIST);
const SCALE_ATTR_SET = new Set<string>(TECHNIQUE_SKILL_SCALE_ATTR_LIST);
const CONTROL_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_CONTROL_TYPE_LIST);
const MARK_ID_SET = new Set<string>(TECHNIQUE_SKILL_MARK_ID_LIST);
const MARK_OPERATION_SET = new Set<string>(TECHNIQUE_SKILL_MARK_OPERATION_LIST);
const MARK_CONSUME_MODE_SET = new Set<string>(TECHNIQUE_SKILL_MARK_CONSUME_MODE_LIST);
const MARK_RESULT_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_MARK_RESULT_TYPE_LIST);
const MOMENTUM_ID_SET = new Set<string>(TECHNIQUE_SKILL_MOMENTUM_ID_LIST);
const MOMENTUM_OPERATION_SET = new Set<string>(TECHNIQUE_SKILL_MOMENTUM_OPERATION_LIST);
const MOMENTUM_CONSUME_MODE_SET = new Set<string>(TECHNIQUE_SKILL_MOMENTUM_CONSUME_MODE_LIST);
const MOMENTUM_BONUS_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_MOMENTUM_BONUS_TYPE_LIST);
const FATE_SWAP_MODE_SET = new Set<string>(TECHNIQUE_SKILL_FATE_SWAP_MODE_LIST);
const AURA_TARGET_SET = new Set<string>(TECHNIQUE_SKILL_AURA_TARGET_LIST);
const AURA_SUB_EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_SKILL_AURA_SUB_EFFECT_TYPE_LIST);
const UPGRADE_ALLOWED_CHANGE_KEY_SET = new Set<string>(TECHNIQUE_SKILL_UPGRADE_ALLOWED_CHANGE_KEYS);
const MULTI_TARGET_COUNT_ALLOWED_TARGET_TYPE_SET = new Set<string>(['random_enemy', 'random_ally']);

const asString = (value: TechniqueJsonValue | undefined): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const asNumber = (value: TechniqueJsonValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const isJsonObject = (value: TechniqueJsonValue | undefined): value is TechniqueJsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isSkillEffectObject = (value: TechniqueJsonObject): value is TechniqueJsonObject & SkillEffect => {
  return typeof value.type === 'string' && value.type.trim().length > 0;
};

const hasOwn = (source: object, key: string): boolean => {
  return Object.prototype.hasOwnProperty.call(source, key);
};

const validateOptionalEnumField = (
  fieldName: string,
  value: TechniqueJsonValue | undefined,
  allowedSet: ReadonlySet<string>,
): TechniqueSkillGenerationValidationResult => {
  if (value === undefined) return { success: true };
  const text = asString(value);
  if (!text || !allowedSet.has(text)) {
    return { success: false, reason: `${fieldName} 不在允许枚举中` };
  }
  return { success: true };
};

const validateOptionalIntegerField = (
  fieldName: string,
  value: TechniqueJsonValue | undefined,
  min: number,
  max?: number,
): TechniqueSkillGenerationValidationResult => {
  if (value === undefined) return { success: true };
  const parsed = asNumber(value);
  if (parsed === null || !Number.isInteger(parsed) || parsed < min) {
    return { success: false, reason: `${fieldName} 必须是 >= ${min} 的整数` };
  }
  if (max !== undefined && parsed > max) {
    return { success: false, reason: `${fieldName} 不能大于 ${max}` };
  }
  return { success: true };
};

const validateOptionalNumberRangeField = (
  fieldName: string,
  value: TechniqueJsonValue | undefined,
  min: number,
  max: number,
): TechniqueSkillGenerationValidationResult => {
  if (value === undefined) return { success: true };
  const parsed = asNumber(value);
  if (parsed === null || parsed < min || parsed > max) {
    return { success: false, reason: `${fieldName} 必须在 ${min}~${max} 范围内` };
  }
  return { success: true };
};

const validateRequiredNumberField = (
  fieldName: string,
  value: TechniqueJsonValue | undefined,
  min?: number,
  max?: number,
): TechniqueSkillGenerationValidationResult => {
  const parsed = asNumber(value);
  if (parsed === null) {
    return { success: false, reason: `${fieldName} 缺失或不是有限数字` };
  }
  if (min !== undefined && parsed < min) {
    return { success: false, reason: `${fieldName} 不能小于 ${min}` };
  }
  if (max !== undefined && parsed > max) {
    return { success: false, reason: `${fieldName} 不能大于 ${max}` };
  }
  return { success: true };
};

const validateScaleAttr = (effect: SkillEffect): TechniqueSkillGenerationValidationResult => {
  if (effect.scaleAttr === undefined) return { success: false, reason: 'scaleAttr 缺失' };
  const scaleAttr = typeof effect.scaleAttr === 'string' ? effect.scaleAttr.trim() : '';
  if (!scaleAttr || !SCALE_ATTR_SET.has(scaleAttr)) {
    return { success: false, reason: 'scaleAttr 不在允许属性枚举中' };
  }
  return { success: true };
};

const validateValueExpression = (effect: SkillEffect): TechniqueSkillGenerationValidationResult => {
  const hasAnyValueInput = effect.value !== undefined
    || effect.baseValue !== undefined
    || effect.scaleAttr !== undefined
    || effect.scaleRate !== undefined;

  if (effect.valueType === undefined) {
    if (effect.scaleAttr !== undefined) {
      return validateScaleAttr(effect);
    }
    if (!hasAnyValueInput) {
      return { success: false, reason: '缺少数值表达字段' };
    }
    return { success: true };
  }

  const valueType = typeof effect.valueType === 'string' ? effect.valueType.trim() : '';
  if (!valueType || !VALUE_TYPE_SET.has(valueType)) {
    return { success: false, reason: 'valueType 不在允许枚举中' };
  }

  if (valueType === 'flat' || valueType === 'percent') {
    return validateRequiredNumberField('value', effect.value);
  }

  if (valueType === 'scale') {
    const scaleAttrValidation = validateScaleAttr(effect);
    if (!scaleAttrValidation.success) return scaleAttrValidation;
    return validateRequiredNumberField('scaleRate', effect.scaleRate, 0, 5);
  }

  const combinedScaleAttrValidation = validateScaleAttr(effect);
  if (!combinedScaleAttrValidation.success) return combinedScaleAttrValidation;
  const baseValueValidation = validateRequiredNumberField('baseValue', effect.baseValue);
  if (!baseValueValidation.success) return baseValueValidation;
  return validateRequiredNumberField('scaleRate', effect.scaleRate, 0, 5);
};

/**
 * 校验光环效果配置
 *
 * 作用：校验 buffKind='aura' 时的 auraTarget 和 auraEffects 字段合法性。
 * 输入：单个 SkillEffect（type 为 buff/debuff，buffKind 为 aura）。
 * 输出：校验结果。
 *
 * 坑点：
 * 1) auraEffects 中的子效果不允许 buffKind='aura'（禁止嵌套光环）。
 * 2) 光环本体永久存在，子效果不允许再声明 duration；每个子效果递归调用 validateTechniqueSkillEffect 校验。
 */
const validateAuraEffect = (
  effect: SkillEffect,
): TechniqueSkillGenerationValidationResult => {
  const auraTarget = typeof effect.auraTarget === 'string' ? effect.auraTarget.trim() : '';
  if (!auraTarget || !AURA_TARGET_SET.has(auraTarget)) {
    return { success: false, reason: 'auraTarget 缺失或不在允许枚举中' };
  }

  const auraEffects = (effect as unknown as Record<string, unknown>).auraEffects;
  if (!Array.isArray(auraEffects) || auraEffects.length === 0) {
    return { success: false, reason: 'auraEffects 缺失或为空数组' };
  }
  if (auraEffects.length > 4) {
    return { success: false, reason: 'auraEffects 长度不能超过 4' };
  }

  for (const sub of auraEffects) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
      return { success: false, reason: 'auraEffects 子效果必须是对象' };
    }
    const subEffect = sub as SkillEffect;
    const subType = typeof subEffect.type === 'string' ? subEffect.type.trim() : '';
    if (!subType || !AURA_SUB_EFFECT_TYPE_SET.has(subType)) {
      return { success: false, reason: `auraEffects 子效果 type 不在允许枚举中: ${subType}` };
    }
    // 禁止嵌套光环
    if ((subType === 'buff' || subType === 'debuff') && typeof subEffect.buffKind === 'string' && subEffect.buffKind.trim() === 'aura') {
      return { success: false, reason: 'auraEffects 子效果不允许嵌套光环（buffKind=aura）' };
    }
    if (subEffect.duration !== undefined) {
      return { success: false, reason: 'auraEffects 子效果不允许声明 duration，光环效果持续时间由宿主光环统一决定' };
    }
    const subValidation = validateTechniqueSkillEffect(subEffect);
    if (!subValidation.success) {
      return { success: false, reason: `auraEffects 子效果校验失败: ${subValidation.reason}` };
    }
  }

  return { success: true };
};

const buildTechniqueJsonValueSignature = (value: TechniqueJsonValue | undefined): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => buildTechniqueJsonValueSignature(entry)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${buildTechniqueJsonValueSignature(value[key])}`).join(',')}}`;
};

export const validateTechniqueSkillEffectList = (
  effectsRaw: unknown,
  fieldName: string,
): TechniqueSkillGenerationValidationResult => {
  if (!Array.isArray(effectsRaw) || effectsRaw.length <= 0) {
    return { success: false, reason: `${fieldName} 必须是非空数组` };
  }
  if (effectsRaw.length > TECHNIQUE_SKILL_EFFECT_MAX_COUNT) {
    return { success: false, reason: `${fieldName} 最多只能包含 ${TECHNIQUE_SKILL_EFFECT_MAX_COUNT} 个 effect` };
  }

  const effectSignatureSet = new Set<string>();
  for (const entry of effectsRaw) {
    if (!isJsonObject(entry)) {
      return { success: false, reason: `${fieldName} 只能包含对象 effect` };
    }
    if (!isSkillEffectObject(entry)) {
      return { success: false, reason: `${fieldName} 缺少合法 type` };
    }
    const signature = buildTechniqueJsonValueSignature(entry);
    if (effectSignatureSet.has(signature)) {
      return { success: false, reason: `${fieldName} 不允许包含重复 effect` };
    }
    effectSignatureSet.add(signature);

    const effectValidation = validateTechniqueSkillEffect(entry);
    if (!effectValidation.success) {
      return { success: false, reason: `${fieldName} 非法：${effectValidation.reason}` };
    }
  }

  return { success: true };
};

export const validateTechniqueSkillEffect = (
  effect: SkillEffect,
): TechniqueSkillGenerationValidationResult => {
  if (hasOwn(effect, 'valueFormula')) {
    return { success: false, reason: 'effect 不支持 valueFormula' };
  }

  const effectType = typeof effect.type === 'string' ? effect.type.trim() : '';
  if (!effectType || !EFFECT_TYPE_SET.has(effectType)) {
    return { success: false, reason: 'effect.type 不在允许枚举中' };
  }

  const chanceValidation = validateOptionalNumberRangeField('chance', effect.chance, 0, 1);
  if (!chanceValidation.success) return chanceValidation;
  const durationValidation = validateOptionalIntegerField('duration', effect.duration, 1, 99);
  if (!durationValidation.success) return durationValidation;
  const countValidation = validateOptionalIntegerField('count', effect.count, 1, 99);
  if (!countValidation.success) return countValidation;
  const stacksValidation = validateOptionalIntegerField('stacks', effect.stacks, 1, 99);
  if (!stacksValidation.success) return stacksValidation;
  const maxStacksValidation = validateOptionalIntegerField('maxStacks', effect.maxStacks, 1, 99);
  if (!maxStacksValidation.success) return maxStacksValidation;
  const consumeStacksValidation = validateOptionalIntegerField('consumeStacks', effect.consumeStacks, 1, 99);
  if (!consumeStacksValidation.success) return consumeStacksValidation;
  const hitCountValidation = validateOptionalIntegerField('hit_count', effect.hit_count, 1, 20);
  if (!hitCountValidation.success) return hitCountValidation;
  const perStackRateValidation = validateOptionalNumberRangeField('perStackRate', effect.perStackRate, 0, 5);
  if (!perStackRateValidation.success) return perStackRateValidation;
  const bonusTargetMaxQixueRateValidation = validateOptionalNumberRangeField(
    'bonusTargetMaxQixueRate',
    effect.bonusTargetMaxQixueRate,
    0,
    1,
  );
  if (!bonusTargetMaxQixueRateValidation.success) return bonusTargetMaxQixueRateValidation;

  switch (effectType) {
    case 'damage':
      return validateValueExpression(effect);

    case 'heal':
    case 'shield':
      return validateValueExpression(effect);

    case 'buff':
    case 'debuff': {
      const buffValidation = validateTechniqueStructuredBuffEffect(effect);
      if (!buffValidation.success) {
        return { success: false, reason: buffValidation.reason };
      }
      const buffKind = typeof effect.buffKind === 'string' ? effect.buffKind.trim() : '';
      if (buffKind === 'aura') {
        return validateAuraEffect(effect);
      }
      if (buffKind === 'dodge_next' || buffKind === 'heal_forbid') {
        return { success: true };
      }
      return validateValueExpression(effect);
    }

    case 'dispel': {
      const dispelTypeValidation = validateOptionalEnumField('dispelType', effect.dispelType, DISPEL_TYPE_SET);
      return dispelTypeValidation;
    }

    case 'resource': {
      const resourceTypeValidation = validateOptionalEnumField('resourceType', effect.resourceType, RESOURCE_TYPE_SET);
      if (!resourceTypeValidation.success) return resourceTypeValidation;
      if (effect.resourceType === undefined) {
        return { success: false, reason: 'resourceType 缺失' };
      }
      const targetValidation = validateOptionalEnumField('target', effect.target, RESOURCE_TARGET_SET);
      if (!targetValidation.success) return targetValidation;
      return validateRequiredNumberField('value', effect.value);
    }

    case 'restore_lingqi':
      return validateRequiredNumberField('value', effect.value, 0);

    case 'cleanse':
    case 'cleanse_control':
      return { success: true };

    case 'lifesteal':
      return validateRequiredNumberField('value', effect.value, 0, 1);

    case 'control': {
      const controlTypeValidation = validateOptionalEnumField('controlType', effect.controlType, CONTROL_TYPE_SET);
      if (!controlTypeValidation.success) return controlTypeValidation;
      if (effect.controlType === undefined) {
        return { success: false, reason: 'controlType 缺失' };
      }
      return { success: true };
    }

    case 'mark': {
      const markIdValidation = validateOptionalEnumField('markId', effect.markId, MARK_ID_SET);
      if (!markIdValidation.success) return markIdValidation;
      if (effect.markId === undefined) {
        return { success: false, reason: 'markId 缺失' };
      }
      const operationValidation = validateOptionalEnumField('operation', effect.operation, MARK_OPERATION_SET);
      if (!operationValidation.success) return operationValidation;
      if (effect.operation === undefined) {
        return { success: false, reason: 'operation 缺失' };
      }
      const consumeModeValidation = validateOptionalEnumField('consumeMode', effect.consumeMode, MARK_CONSUME_MODE_SET);
      if (!consumeModeValidation.success) return consumeModeValidation;
      const resultTypeValidation = validateOptionalEnumField('resultType', effect.resultType, MARK_RESULT_TYPE_SET);
      if (!resultTypeValidation.success) return resultTypeValidation;

      if (effect.operation === 'consume') {
        return validateValueExpression(effect);
      }
      return { success: true };
    }

    case 'momentum': {
      const momentumIdValidation = validateOptionalEnumField('momentumId', effect.momentumId, MOMENTUM_ID_SET);
      if (!momentumIdValidation.success) return momentumIdValidation;
      if (effect.momentumId === undefined) {
        return { success: false, reason: 'momentumId 缺失' };
      }
      const operationValidation = validateOptionalEnumField('operation', effect.operation, MOMENTUM_OPERATION_SET);
      if (!operationValidation.success) return operationValidation;
      if (effect.operation === undefined) {
        return { success: false, reason: 'operation 缺失' };
      }
      const consumeModeValidation = validateOptionalEnumField('consumeMode', effect.consumeMode, MOMENTUM_CONSUME_MODE_SET);
      if (!consumeModeValidation.success) return consumeModeValidation;
      const bonusTypeValidation = validateOptionalEnumField('bonusType', effect.bonusType, MOMENTUM_BONUS_TYPE_SET);
      if (!bonusTypeValidation.success) return bonusTypeValidation;

      if (effect.operation === 'gain') {
        if (effect.gainStacks === undefined) {
          return { success: false, reason: 'gainStacks 缺失' };
        }
        return validateOptionalIntegerField('gainStacks', effect.gainStacks, 1, 99);
      }

      if (effect.bonusType === undefined) {
        return { success: false, reason: 'bonusType 缺失' };
      }
      return validateRequiredNumberField('perStackRate', effect.perStackRate, 0, 5);
    }

    case 'delayed_burst': {
      const damageTypeValidation = validateOptionalEnumField('damageType', effect.damageType, new Set(['physical', 'magic', 'true']));
      if (!damageTypeValidation.success) return damageTypeValidation;
      const elementValidation = validateOptionalEnumField('element', effect.element, new Set(['none', 'jin', 'mu', 'shui', 'huo', 'tu']));
      if (!elementValidation.success) return elementValidation;
      if (effect.duration === undefined) {
        return { success: false, reason: 'duration 缺失' };
      }
      return validateValueExpression(effect);
    }

    case 'fate_swap': {
      const swapModeValidation = validateOptionalEnumField('swapMode', effect.swapMode, FATE_SWAP_MODE_SET);
      if (!swapModeValidation.success) return swapModeValidation;
      if (effect.swapMode === undefined) {
        return { success: false, reason: 'swapMode 缺失' };
      }
      if (effect.swapMode === 'shield_steal') {
        return validateRequiredNumberField('value', effect.value, 0, 1);
      }
      return validateOptionalIntegerField('count', effect.count, 1, 99);
    }

    default:
      return { success: true };
  }
};

const validateUpgradeDeltaNumber = (
  fieldName: string,
  value: TechniqueJsonValue | undefined,
): TechniqueSkillGenerationValidationResult => {
  if (value === undefined) return { success: true };
  const parsed = asNumber(value);
  if (parsed === null) {
    return { success: false, reason: `${fieldName} 必须是有限数字` };
  }
  return { success: true };
};

export const validateTechniqueSkillTargetCount = (
  targetType: string,
  targetCount: number,
  fieldName: string,
): TechniqueSkillGenerationValidationResult => {
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    return { success: false, reason: `${fieldName} 必须是 >= 1 的整数` };
  }
  if (targetCount === 1) {
    return { success: true };
  }
  if (!MULTI_TARGET_COUNT_ALLOWED_TARGET_TYPE_SET.has(targetType)) {
    return {
      success: false,
      reason: `${fieldName} 仅允许 random_enemy/random_ally 在 > 1 时使用，当前 targetType=${targetType}`,
    };
  }
  return { success: true };
};

export const validateTechniqueSkillUpgrade = (
  upgrade: TechniqueSkillUpgradeEntry,
  maxLayer: number,
  targetType: string,
): TechniqueSkillGenerationValidationResult => {
  for (const field of TECHNIQUE_SKILL_UPGRADE_UNSUPPORTED_FIELDS) {
    if (hasOwn(upgrade, field)) {
      return { success: false, reason: `upgrades 不支持字段 ${field}` };
    }
  }

  const upgradeKeys = Object.keys(upgrade);
  for (const key of upgradeKeys) {
    if (key !== 'layer' && key !== 'changes') {
      return { success: false, reason: `upgrades 顶层字段非法：${key}` };
    }
  }

  const layer = asNumber(upgrade.layer);
  if (layer === null || !Number.isInteger(layer) || layer < 1 || layer > maxLayer) {
    return { success: false, reason: `upgrades.layer 必须是 1~${maxLayer} 的整数` };
  }

  if (!isJsonObject(upgrade.changes)) {
    return { success: false, reason: 'upgrades.changes 必须是对象' };
  }

  const changes = upgrade.changes;
  const changeKeys = Object.keys(changes);
  if (changeKeys.length <= 0) {
    return { success: false, reason: 'upgrades.changes 不能为空对象' };
  }

  for (const key of changeKeys) {
    if (!UPGRADE_ALLOWED_CHANGE_KEY_SET.has(key)) {
      return { success: false, reason: `upgrades.changes 包含未支持字段：${key}` };
    }
  }

  const targetCountValidation = validateOptionalIntegerField('target_count', changes.target_count, 1);
  if (!targetCountValidation.success) return targetCountValidation;
  if (changes.target_count !== undefined) {
    const parsedTargetCount = asNumber(changes.target_count);
    if (parsedTargetCount === null) {
      return { success: false, reason: 'target_count 必须是 >= 1 的整数' };
    }
    const targetCountRuleValidation = validateTechniqueSkillTargetCount(
      targetType,
      parsedTargetCount,
      'upgrades.changes.target_count',
    );
    if (!targetCountRuleValidation.success) return targetCountRuleValidation;
  }

  const cooldownValidation = validateUpgradeDeltaNumber('cooldown', changes.cooldown);
  if (!cooldownValidation.success) return cooldownValidation;
  const costLingqiValidation = validateUpgradeDeltaNumber('cost_lingqi', changes.cost_lingqi);
  if (!costLingqiValidation.success) return costLingqiValidation;
  const costLingqiRateValidation = validateUpgradeDeltaNumber('cost_lingqi_rate', changes.cost_lingqi_rate);
  if (!costLingqiRateValidation.success) return costLingqiRateValidation;
  const costQixueValidation = validateUpgradeDeltaNumber('cost_qixue', changes.cost_qixue);
  if (!costQixueValidation.success) return costQixueValidation;
  const costQixueRateValidation = validateUpgradeDeltaNumber('cost_qixue_rate', changes.cost_qixue_rate);
  if (!costQixueRateValidation.success) return costQixueRateValidation;
  const aiPriorityValidation = validateUpgradeDeltaNumber('ai_priority', changes.ai_priority);
  if (!aiPriorityValidation.success) return aiPriorityValidation;

  if (changes.effects !== undefined) {
    const effectListValidation = validateTechniqueSkillEffectList(
      changes.effects,
      'upgrades.changes.effects',
    );
    if (!effectListValidation.success) {
      return effectListValidation;
    }
  }

  if (changes.addEffect !== undefined) {
    if (!isJsonObject(changes.addEffect)) {
      return { success: false, reason: 'upgrades.changes.addEffect 必须是对象' };
    }
    if (!isSkillEffectObject(changes.addEffect)) {
      return { success: false, reason: 'upgrades.changes.addEffect 缺少合法 type' };
    }
    const addEffectValidation = validateTechniqueSkillEffect(changes.addEffect);
    if (!addEffectValidation.success) {
      return { success: false, reason: `upgrades.changes.addEffect 非法：${addEffectValidation.reason}` };
    }
  }

  return { success: true };
};
