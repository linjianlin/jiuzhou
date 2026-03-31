/**
 * 功法技能升级展示共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一根据功法层级里的 `unlock_skill_ids` / `upgrade_skill_ids` 计算每层技能变化后的展示值。
 * 2. 做什么：为功法列表、详情弹窗、修炼预览提供同一套“升级后技能属性”口径，避免同一规则散落在多个组件里。
 * 3. 不做什么：不处理功法加成、不发起网络请求，也不负责 UI 渲染。
 *
 * 输入/输出：
 * - 输入：技能定义列表、功法层配置列表，以及图标解析函数。
 * - 输出：按层分组的技能变化映射，可直接供界面展示。
 *
 * 数据流/状态流：
 * SkillDefDto[] + TechniqueLayerDto[] -> 本模块统一套用 upgrades -> TechniqueModal 各视图复用。
 *
 * 关键边界条件与坑点：
 * 1. 同一技能在后续层被升级时，必须覆盖旧层展示值；否则列表和 tooltip 会一直停留在基础属性。
 * 2. 若某技能首次只出现在 `upgrade_skill_ids`，该层也必须把它当作已解锁技能展示，并以本层升级后的结果为准，避免展示和实战口径漂移。
 */

import type { SkillDefDto, TechniqueLayerDto } from '../../../../services/api';

export type TechniqueSkillProgressionEntry = {
  id: string;
  name: string;
  icon: string;
  description?: string;
  cost_lingqi?: number;
  cost_lingqi_rate?: number;
  cost_qixue?: number;
  cost_qixue_rate?: number;
  cooldown?: number;
  target_type?: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: SkillDefDto['effects'];
};

type TechniqueSkillUpgradeRule = {
  layer: number;
  changes: JsonObject;
};

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type EffectiveTechniqueSkillData = Pick<
  TechniqueSkillProgressionEntry,
  | 'cost_lingqi'
  | 'cost_lingqi_rate'
  | 'cost_qixue'
  | 'cost_qixue_rate'
  | 'cooldown'
  | 'target_count'
  | 'damage_type'
  | 'element'
  | 'effects'
>;

const toNumber = (value: JsonValue | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toRecord = (value: JsonValue | undefined): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
};

const cloneEffects = (effects: SkillDefDto['effects'] | undefined): SkillDefDto['effects'] | undefined => {
  if (!Array.isArray(effects)) return undefined;
  return effects.map((effect) => {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      return effect;
    }
    return { ...(effect as JsonObject) };
  });
};

const isDamageEffect = (effect: JsonValue): effect is JsonObject => {
  return Boolean(
    effect
    && typeof effect === 'object'
    && !Array.isArray(effect)
    && (effect as JsonObject).type === 'damage',
  );
};

const findFirstDamageEffect = (effects: SkillDefDto['effects'] | undefined): JsonObject | null => {
  if (!Array.isArray(effects)) return null;
  for (const effect of effects) {
    if (isDamageEffect(effect as JsonValue)) return { ...(effect as JsonObject) };
  }
  return null;
};

const hasDamageEffect = (effects: SkillDefDto['effects'] | undefined): boolean => {
  if (!Array.isArray(effects)) return false;
  return effects.some((effect) => isDamageEffect(effect as JsonValue));
};

const parseSkillUpgradeRules = (raw: SkillDefDto['upgrades']): TechniqueSkillUpgradeRule[] => {
  if (!Array.isArray(raw)) return [];
  const rules: TechniqueSkillUpgradeRule[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const row = toRecord(raw[index]);
    const changes = toRecord(row.changes);
    if (Object.keys(changes).length === 0) continue;
    const parsedLayer = toNumber(row.layer);
    const layer = Math.max(1, Math.floor(parsedLayer ?? index + 1));
    rules.push({ layer, changes });
  }
  rules.sort((left, right) => left.layer - right.layer);
  return rules;
};

const buildEffectiveTechniqueSkill = (
  skill: SkillDefDto,
  upgradeLevel: number,
): EffectiveTechniqueSkillData => {
  const effective: EffectiveTechniqueSkillData = {
    cost_lingqi: skill.cost_lingqi,
    cost_lingqi_rate: skill.cost_lingqi_rate,
    cost_qixue: skill.cost_qixue,
    cost_qixue_rate: skill.cost_qixue_rate,
    cooldown: skill.cooldown,
    target_count: skill.target_count,
    damage_type: skill.damage_type,
    element: skill.element,
    effects: cloneEffects(skill.effects),
  };

  const rules = parseSkillUpgradeRules(skill.upgrades).slice(0, Math.max(0, Math.floor(upgradeLevel)));
  for (const rule of rules) {
    const preservedDamageEffect = findFirstDamageEffect(effective.effects);

    const targetCount = toNumber(rule.changes.target_count);
    if (targetCount !== null) {
      effective.target_count = Math.max(1, Math.floor(targetCount));
    }

    const cooldownDelta = toNumber(rule.changes.cooldown);
    if (cooldownDelta !== null) {
      effective.cooldown = Math.max(0, Math.floor((effective.cooldown ?? 0) + cooldownDelta));
    }

    const costLingqiDelta = toNumber(rule.changes.cost_lingqi);
    if (costLingqiDelta !== null) {
      effective.cost_lingqi = Math.max(0, Math.floor((effective.cost_lingqi ?? 0) + costLingqiDelta));
    }
    const costLingqiRateDelta = toNumber(rule.changes.cost_lingqi_rate);
    if (costLingqiRateDelta !== null) {
      effective.cost_lingqi_rate = Math.max(0, (effective.cost_lingqi_rate ?? 0) + costLingqiRateDelta);
    }

    const costQixueDelta = toNumber(rule.changes.cost_qixue);
    if (costQixueDelta !== null) {
      effective.cost_qixue = Math.max(0, Math.floor((effective.cost_qixue ?? 0) + costQixueDelta));
    }
    const costQixueRateDelta = toNumber(rule.changes.cost_qixue_rate);
    if (costQixueRateDelta !== null) {
      effective.cost_qixue_rate = Math.max(0, (effective.cost_qixue_rate ?? 0) + costQixueRateDelta);
    }

    if (Array.isArray(rule.changes.effects)) {
      const nextEffects = cloneEffects(rule.changes.effects as SkillDefDto['effects']);
      if (preservedDamageEffect && !hasDamageEffect(nextEffects)) {
        nextEffects?.unshift({ ...preservedDamageEffect });
      }
      effective.effects = nextEffects;
    }

    const addEffect = rule.changes.addEffect;
    if (addEffect && typeof addEffect === 'object' && !Array.isArray(addEffect)) {
      effective.effects = [...(effective.effects ?? []), { ...(addEffect as JsonObject) }];
    }
  }

  return effective;
};

const createTechniqueSkillEntry = (
  skill: SkillDefDto,
  upgradeLevel: number,
  resolveIcon: (icon: string | null | undefined) => string,
): TechniqueSkillProgressionEntry => {
  const effective = buildEffectiveTechniqueSkill(skill, upgradeLevel);
  return {
    id: skill.id,
    name: skill.name,
    icon: resolveIcon(skill.icon),
    description: skill.description ?? undefined,
    cost_lingqi: effective.cost_lingqi,
    cost_lingqi_rate: effective.cost_lingqi_rate,
    cost_qixue: effective.cost_qixue,
    cost_qixue_rate: effective.cost_qixue_rate,
    cooldown: effective.cooldown,
    target_type: skill.target_type,
    target_count: effective.target_count,
    damage_type: effective.damage_type,
    element: effective.element,
    effects: effective.effects,
  };
};

export const buildTechniqueLayerSkillProgression = (
  layers: TechniqueLayerDto[],
  skills: SkillDefDto[],
  resolveIcon: (icon: string | null | undefined) => string,
): Map<number, TechniqueSkillProgressionEntry[]> => {
  const skillMap = new Map(skills.map((skill) => [skill.id, skill] as const));
  const upgradeCountBySkillId = new Map<string, number>();
  const result = new Map<number, TechniqueSkillProgressionEntry[]>();

  for (const layer of layers) {
    const layerSkillIds = new Set<string>();
    for (const skillId of Array.isArray(layer.unlock_skill_ids) ? layer.unlock_skill_ids : []) {
      layerSkillIds.add(skillId);
    }
    for (const skillId of Array.isArray(layer.upgrade_skill_ids) ? layer.upgrade_skill_ids : []) {
      upgradeCountBySkillId.set(skillId, (upgradeCountBySkillId.get(skillId) ?? 0) + 1);
      // upgrade 首次出现时，本层也视为正式解锁，保证展示口径与服务端一致。
      layerSkillIds.add(skillId);
    }

    const layerSkills = Array.from(layerSkillIds)
      .map((skillId) => {
        const skill = skillMap.get(skillId);
        if (!skill) return null;
        return createTechniqueSkillEntry(skill, upgradeCountBySkillId.get(skillId) ?? 0, resolveIcon);
      })
      .filter((entry): entry is TechniqueSkillProgressionEntry => Boolean(entry));

    result.set(layer.layer, layerSkills);
  }

  return result;
};
