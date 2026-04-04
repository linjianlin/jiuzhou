/**
 * 词缀池配置标准化
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：把词缀作者配置里的 `start_tier + values.base/growth` 简化模型，统一展开成运行时消费的 `tiers`。
 * - 不做什么：不负责掉落抽样、不负责洗炼结算，也不在这里处理历史装备实例的迁库。
 *
 * 输入/输出：
 * - 输入：`affix_pool.json` 的原始对象结构，词缀只配置 affix 层起始档位与一个或多个 value source。
 * - 输出：标准化后的 pool/affix 定义；每个 affix 都具备稳定的 `tiers` 与 `value_tiers`。
 *
 * 数据流/状态流：
 * 简化 seed -> `normalizeAffixPoolFile` -> 标准化 `tiers/value_tiers` -> `staticConfigLoader` / 装备生成 / 洗炼 / 测试共用。
 *
 * 关键边界条件与坑点：
 * 1. `start_tier` 只能放在 affix 层；这样多数值词条不会出现不同 value source 起始档不一致的问题。
 * 2. 多数值词条与单数值词条必须共享同一条展开链路，否则后续一旦引入复合属性，就会很快裂成两套计算逻辑。
 */

import { formatAffixDisplayNumber, roundAffixResultValue } from './affixPrecision.js';

export const DEFAULT_AFFIX_MAX_TIER = 11;

export type AffixAllowedSlot =
  | 'weapon'
  | 'head'
  | 'clothes'
  | 'gloves'
  | 'pants'
  | 'necklace'
  | 'accessory'
  | 'artifact';

export type AffixTierConfig = {
  tier: number;
  min: number;
  max: number;
  realm_rank_min: number;
  description?: string;
};

export type AffixModifierConfig = {
  attr_key: string;
  ratio?: number;
  value_source?: string;
};

export type AffixValueBaseConfig = {
  min: number;
  max: number;
};

export type AffixValueGrowthFlat = {
  mode: 'flat';
  min_delta: number;
  max_delta: number;
};

export type AffixValueGrowthPercent = {
  mode: 'percent';
  min_rate: number;
  max_rate: number;
};

export type AffixValueGrowthConfig = AffixValueGrowthFlat | AffixValueGrowthPercent;

export type AffixValueConfig = {
  base: AffixValueBaseConfig;
  growth: AffixValueGrowthConfig;
};

export type AffixValueConfigMap = Record<string, AffixValueConfig>;
export type AffixValueTierMap = Record<string, AffixTierConfig[]>;

export type SpecialAffixDescriptionTemplateKey =
  | 'proc_zhuihun'
  | 'proc_tianlei'
  | 'proc_baonu'
  | 'proc_hushen'
  | 'proc_fansha'
  | 'proc_lingchao'
  | 'proc_duanxing'
  | 'proc_huixiang'
  | 'proc_xuangang'
  | 'proc_tongqi';

type AffixSharedFields = {
  key: string;
  name: string;
  modifiers?: AffixModifierConfig[];
  apply_type: 'flat' | 'percent' | 'special';
  group: string;
  weight: number;
  start_tier: number;
  allowed_slots?: AffixAllowedSlot[];
  is_legendary?: boolean;
  trigger?: 'on_turn_start' | 'on_skill' | 'on_hit' | 'on_ally_hit' | 'on_crit' | 'on_be_hit' | 'on_heal';
  target?: 'self' | 'enemy';
  effect_type?: 'buff' | 'debuff' | 'damage' | 'heal' | 'resource' | 'shield' | 'mark' | 'pursuit';
  duration_round?: number;
  params?: Record<string, string | number | boolean>;
  primary_value_source?: string;
  description_template?: SpecialAffixDescriptionTemplateKey;
  description_value_source?: string;
};

export type RawAffixDefConfig = AffixSharedFields & {
  values: AffixValueConfigMap;
};

export type NormalizedAffixDefConfig = AffixSharedFields & {
  primary_value_source: string;
  description_value_source?: string;
  tiers: AffixTierConfig[];
  value_tiers: AffixValueTierMap;
};

export type AffixPoolRulesConfig = {
  allow_duplicate?: boolean;
  mutex_groups?: string[][];
  legendary_chance?: number;
};

export type RawAffixPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  rules: AffixPoolRulesConfig;
  affixes: RawAffixDefConfig[];
  enabled?: boolean;
  version?: number;
};

export type NormalizedAffixPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  rules: AffixPoolRulesConfig;
  affixes: NormalizedAffixDefConfig[];
  enabled?: boolean;
  version?: number;
};

export type RawAffixPoolFile = {
  version?: number;
  description?: string;
  pools: RawAffixPoolDefConfig[];
};

const roundTierValue = (value: number): number => roundAffixResultValue(value);

const trimNumber = (value: number): string => {
  return formatAffixDisplayNumber(value);
};

const SPECIAL_AFFIX_DESCRIPTION_BUILDERS: Record<
  SpecialAffixDescriptionTemplateKey,
  (min: number, max: number) => string
> = {
  proc_zhuihun: (min, max) => `命中时22%概率触发追魂斩，追加${trimNumber(min)}~${trimNumber(max)}点真伤并附加60%物攻加成`,
  proc_tianlei: (min, max) => `命中时22%概率引动天雷，追加${trimNumber(min)}~${trimNumber(max)}点法伤并附加65%法攻加成`,
  proc_baonu: (min, max) => `暴击时28%概率激发暴怒意，2回合内增伤提高${trimNumber(min * 100)}%~${trimNumber(max * 100)}%`,
  proc_hushen: (min, max) => `受击时26%概率触发护心诀，回复${trimNumber(min)}~${trimNumber(max)}点气血并附加9%生命加成`,
  proc_fansha: (min, max) => `受击时22%概率反煞，反弹${trimNumber(min * 100)}%~${trimNumber(max * 100)}%本次伤害`,
  proc_lingchao: (min, max) => `回合开始时30%概率引动灵潮，恢复${trimNumber(min)}~${trimNumber(max)}点灵气`,
  proc_duanxing: (min, max) => `命中时20%概率引爆断星芒，造成${trimNumber(min)}~${trimNumber(max)}点真伤并附加42%最大灵气加成`,
  proc_huixiang: (min, max) => `命中时22%概率引动太虚回锋，追加本次命中伤害${trimNumber(min * 100)}%~${trimNumber(max * 100)}%的真伤`,
  proc_xuangang: (min, max) => `受击时27%概率凝成玄罡回璧，获得相当于本次受击伤害${trimNumber(min * 100)}%~${trimNumber(max * 100)}%的护盾，持续2回合`,
  proc_tongqi: (min, max) => `友方命中时20%概率触发协锋追击，由你立刻追击目标，造成相当于你较高攻击属性${trimNumber(min * 100)}%~${trimNumber(max * 100)}%的追击伤害，每回合同名词缀最多触发1次`,
};

export const buildSpecialAffixDescription = (
  template: SpecialAffixDescriptionTemplateKey,
  min: number,
  max: number,
): string => {
  return SPECIAL_AFFIX_DESCRIPTION_BUILDERS[template](min, max);
};

const buildTierConfig = (
  tier: number,
  min: number,
  max: number,
  description?: string,
): AffixTierConfig => {
  if (description) {
    return {
      tier,
      min,
      max,
      realm_rank_min: tier,
      description,
    };
  }
  return {
    tier,
    min,
    max,
    realm_rank_min: tier,
  };
};

const expandValueSeries = (
  startTier: number,
  valueConfig: AffixValueConfig,
  maxTier = DEFAULT_AFFIX_MAX_TIER,
): AffixTierConfig[] => {
  const tiers: AffixTierConfig[] = [];
  let currentMin = roundTierValue(valueConfig.base.min);
  let currentMax = roundTierValue(valueConfig.base.max);

  for (let tier = startTier; tier <= maxTier; tier += 1) {
    tiers.push(buildTierConfig(tier, currentMin, currentMax));
    if (tier >= maxTier) continue;

    if (valueConfig.growth.mode === 'flat') {
      currentMin = roundTierValue(currentMin + valueConfig.growth.min_delta);
      currentMax = roundTierValue(currentMax + valueConfig.growth.max_delta);
      continue;
    }

    currentMin = roundTierValue(currentMin * (1 + valueConfig.growth.min_rate));
    currentMax = roundTierValue(currentMax * (1 + valueConfig.growth.max_rate));
  }

  return tiers;
};

const resolvePrimaryValueSource = (affix: RawAffixDefConfig): string => {
  const configuredKey = typeof affix.primary_value_source === 'string'
    ? affix.primary_value_source.trim()
    : '';
  if (configuredKey) {
    if (!affix.values[configuredKey]) {
      throw new Error(`${affix.key} primary_value_source=${configuredKey} 未在 values 中定义`);
    }
    return configuredKey;
  }

  const valueKeys = Object.keys(affix.values);
  const firstKey = valueKeys[0]?.trim() ?? '';
  if (!firstKey) {
    throw new Error(`${affix.key} 缺少可用的 value source`);
  }
  return firstKey;
};

const resolveDescriptionValueSource = (
  affix: RawAffixDefConfig,
  primaryValueSource: string,
): string | undefined => {
  const configuredKey = typeof affix.description_value_source === 'string'
    ? affix.description_value_source.trim()
    : '';
  if (!configuredKey) {
    return affix.description_template ? primaryValueSource : undefined;
  }
  if (!affix.values[configuredKey]) {
    throw new Error(`${affix.key} description_value_source=${configuredKey} 未在 values 中定义`);
  }
  return configuredKey;
};

const buildValueTierMap = (affix: RawAffixDefConfig): AffixValueTierMap => {
  const entries = Object.entries(affix.values);
  if (entries.length <= 0) {
    throw new Error(`${affix.key} values 不能为空`);
  }

  const valueTierMap: AffixValueTierMap = {};
  for (const [valueKey, valueConfig] of entries) {
    valueTierMap[valueKey] = expandValueSeries(affix.start_tier, valueConfig);
  }
  return valueTierMap;
};

const addSpecialDescriptions = (
  tiers: AffixTierConfig[],
  descriptionTemplate: SpecialAffixDescriptionTemplateKey,
): AffixTierConfig[] => {
  return tiers.map((tier) => ({
    ...tier,
    description: buildSpecialAffixDescription(descriptionTemplate, Number(tier.min), Number(tier.max)),
  }));
};

const normalizeAffix = (affix: RawAffixDefConfig): NormalizedAffixDefConfig => {
  const primaryValueSource = resolvePrimaryValueSource(affix);
  const descriptionValueSource = resolveDescriptionValueSource(affix, primaryValueSource);
  const value_tiers = buildValueTierMap(affix);

  const primaryTiers = value_tiers[primaryValueSource];
  if (!primaryTiers || primaryTiers.length <= 0) {
    throw new Error(`${affix.key} primary value source 未生成 tiers`);
  }

  const descriptionTiers =
    affix.description_template && descriptionValueSource
      ? addSpecialDescriptions(value_tiers[descriptionValueSource], affix.description_template)
      : value_tiers[primaryValueSource];

  const tiers =
    affix.description_template && descriptionValueSource === primaryValueSource
      ? descriptionTiers
      : primaryTiers.map((tier, index) => {
          const description = descriptionTiers[index]?.description;
          return description
            ? buildTierConfig(tier.tier, Number(tier.min), Number(tier.max), description)
            : tier;
        });

  return {
    ...affix,
    primary_value_source: primaryValueSource,
    description_value_source: descriptionValueSource,
    tiers,
    value_tiers,
  };
};

export const normalizeAffixPoolFile = (
  file: RawAffixPoolFile,
): NormalizedAffixPoolDefConfig[] => {
  return file.pools.map((pool) => ({
    id: pool.id,
    name: pool.name,
    description: pool.description,
    rules: pool.rules,
    affixes: pool.affixes.map((affix) => normalizeAffix(affix)),
    enabled: pool.enabled,
    version: pool.version,
  }));
};
