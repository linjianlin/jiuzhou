/**
 * AI 生成功法约束共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护生成功法的 prompt 约束、被动词典与结构化 Buff 校验入口，供服务层与本地联调脚本复用。
 * 2) 不做什么：不负责数据库读写、不负责 AI 调用、不负责业务状态机。
 *
 * 输入/输出：
 * - 输入：待校验的被动 key，以及待校验的结构化 Buff effect。
 * - 输出：是否为系统支持 key（boolean）、结构化 Buff 校验结果，以及可复用的约束常量。
 *
 * 数据流/状态流：
 * 常量定义/动态目录 -> 导出只读映射与校验入口 -> 业务模块按需引用并执行 prompt 拼装与结果校验。
 *
 * 关键边界条件与坑点：
 * 1) key 统一按 trim 后匹配，空字符串一律视为非法。
 * 2) 共享被动池中的 key 必须来自支持词典，否则会导致 AI 生成约束与运行时校验漂移。
 * 3) 结构化 Buff 的允许列表来自静态预定义数据，若直接手写会与运行时支持集合漂移。
 */
import { REALM_ORDER } from './realmRules.js';
import {
  TECHNIQUE_SKILL_CONTROL_TYPE_LIST,
  TECHNIQUE_SKILL_DISPEL_TYPE_LIST,
  TECHNIQUE_SKILL_EFFECT_TYPE_LIST,
  TECHNIQUE_SKILL_MARK_CONSUME_MODE_LIST,
  TECHNIQUE_SKILL_MARK_ID_LIST,
  TECHNIQUE_SKILL_MARK_OPERATION_LIST,
  TECHNIQUE_SKILL_MARK_RESULT_TYPE_LIST,
  TECHNIQUE_SKILL_MOMENTUM_BONUS_TYPE_LIST,
  TECHNIQUE_SKILL_MOMENTUM_CONSUME_MODE_LIST,
  TECHNIQUE_SKILL_MOMENTUM_ID_LIST,
  TECHNIQUE_SKILL_MOMENTUM_OPERATION_LIST,
  TECHNIQUE_SKILL_RESOURCE_TARGET_LIST,
  TECHNIQUE_SKILL_RESOURCE_TYPE_LIST,
  TECHNIQUE_SKILL_SCALE_ATTR_LIST,
  TECHNIQUE_SKILL_TARGET_TYPE_LIST,
  TECHNIQUE_SKILL_UPGRADE_ALLOWED_CHANGE_KEYS,
  TECHNIQUE_SKILL_UPGRADE_UNSUPPORTED_FIELDS,
  TECHNIQUE_SKILL_VALUE_TYPE_LIST,
  validateTechniqueSkillEffect,
  validateTechniqueSkillUpgrade,
} from './techniqueSkillGenerationSpec.js';
import {
  getTechniqueStructuredBuffCatalog,
  validateTechniqueStructuredBuffEffect,
} from './techniqueStructuredBuffCatalog.js';

export const GENERATED_TECHNIQUE_TYPE_LIST = ['武技', '心法', '法诀', '身法', '辅修'] as const;
export type GeneratedTechniqueType = (typeof GENERATED_TECHNIQUE_TYPE_LIST)[number];
export type GeneratedTechniqueQuality = '黄' | '玄' | '地' | '天';
export type TechniquePassiveMode = 'percent' | 'flat';
export type TechniquePassivePoolEntry = { key: string; mode: TechniquePassiveMode };
export type TechniquePassiveValueConstraint = {
  mode: TechniquePassiveMode;
  maxPerLayer: number;
  maxTotal: number;
};

export const TECHNIQUE_PROMPT_SYSTEM_MESSAGE =
  '你是修仙RPG功法设计器。请严格输出JSON，不要输出额外文本。';

export const TECHNIQUE_EFFECT_TYPE_LIST = TECHNIQUE_SKILL_EFFECT_TYPE_LIST;

export const TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS = ['valueFormula'] as const;

export const isGeneratedTechniqueType = (raw: unknown): raw is GeneratedTechniqueType => {
  return typeof raw === 'string' && GENERATED_TECHNIQUE_TYPE_LIST.includes(raw as GeneratedTechniqueType);
};

export const TECHNIQUE_PASSIVE_KEY_MEANING_MAP: Record<string, string> = {
  wugong: '物理攻击（百分比加成）',
  fagong: '法术攻击（百分比加成）',
  wufang: '物理防御（百分比加成）',
  fafang: '法术防御（百分比加成）',
  max_qixue: '最大气血（百分比加成）',
  max_lingqi: '最大灵气（固定值加成）',
  mingzhong: '命中率（加算百分比）',
  shanbi: '闪避率（加算百分比）',
  zhaojia: '招架率（加算百分比）',
  baoji: '暴击率（加算百分比）',
  baoshang: '暴击伤害倍率（加算百分比）',
  jianbaoshang: '暴击伤害减免（加算百分比）',
  kangbao: '抗暴率（加算百分比）',
  zengshang: '增伤（加算百分比）',
  zhiliao: '治疗加成（加算百分比）',
  jianliao: '受疗减免（加算百分比）',
  xixue: '吸血比例（加算百分比）',
  lengque: '冷却缩减（加算百分比）',
  sudu: '速度（固定值加成）',
  shuxing_shuzhi: '属性伤害增幅（加算百分比）',
  kongzhi_kangxing: '控制抗性（加算百分比）',
  jin_kangxing: '金系抗性（加算百分比）',
  mu_kangxing: '木系抗性（加算百分比）',
  shui_kangxing: '水系抗性（加算百分比）',
  huo_kangxing: '火系抗性（加算百分比）',
  tu_kangxing: '土系抗性（加算百分比）',
  qixue_huifu: '每回合气血恢复（固定值加成）',
  lingqi_huifu: '每回合灵气恢复（固定值加成）',
};

export const SUPPORTED_TECHNIQUE_PASSIVE_KEYS = Object.freeze(Object.keys(TECHNIQUE_PASSIVE_KEY_MEANING_MAP));
export const SUPPORTED_TECHNIQUE_PASSIVE_KEY_SET = new Set<string>(SUPPORTED_TECHNIQUE_PASSIVE_KEYS);

const TECHNIQUE_PASSIVE_MODE_BY_KEY: Record<string, TechniquePassiveMode> = {
  wugong: 'percent',
  fagong: 'percent',
  wufang: 'percent',
  fafang: 'percent',
  max_qixue: 'percent',
  max_lingqi: 'flat',
  mingzhong: 'percent',
  shanbi: 'percent',
  zhaojia: 'percent',
  baoji: 'percent',
  baoshang: 'percent',
  jianbaoshang: 'percent',
  kangbao: 'percent',
  zengshang: 'percent',
  zhiliao: 'percent',
  jianliao: 'percent',
  xixue: 'percent',
  lengque: 'percent',
  sudu: 'flat',
  shuxing_shuzhi: 'percent',
  kongzhi_kangxing: 'percent',
  jin_kangxing: 'percent',
  mu_kangxing: 'percent',
  shui_kangxing: 'percent',
  huo_kangxing: 'percent',
  tu_kangxing: 'percent',
  qixue_huifu: 'flat',
  lingqi_huifu: 'flat',
};

/**
 * 功法被动预算共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护 AI 功法被动的单层上限与整本同 key 累计上限，供 prompt 约束复用。
 * 2) 不做什么：不决定被动 key 是否可用，也不替代角色最终属性结算逻辑。
 *
 * 输入/输出：
 * - 输入：功法品质、被动 key。
 * - 输出：该 key 在当前品质下的数值模式、单层上限与累计上限。
 *
 * 数据流/状态流：
 * 基础预算表 -> `getTechniquePassiveValueConstraint` -> prompt 指南按品质展开到 `passiveValueGuideByKey`。
 *
 * 关键边界条件与坑点：
 * 1) `wugong/fagong/wufang/fafang/max_qixue` 会进入百分比乘区，累计上限必须明显低于旧的 100%+ 区间。
 * 2) 平铺到 7/9 层时，限制的是“同一个 key 的累计值”，不是所有被动简单相加；否则会误伤多样化搭配。
 */
const TECHNIQUE_PASSIVE_DEFAULT_CONSTRAINTS_BY_MODE: Record<
  TechniquePassiveMode,
  Record<GeneratedTechniqueQuality, Omit<TechniquePassiveValueConstraint, 'mode'>>
> = {
  percent: {
    黄: { maxPerLayer: 0.10, maxTotal: 0.20 },
    玄: { maxPerLayer: 0.20, maxTotal: 0.30 },
    地: { maxPerLayer: 0.30, maxTotal: 0.40 },
    天: { maxPerLayer: 0.35, maxTotal: 0.50 },
  },
  flat: {
    黄: { maxPerLayer: 10, maxTotal: 20 },
    玄: { maxPerLayer: 20, maxTotal: 40 },
    地: { maxPerLayer: 30, maxTotal: 60 },
    天: { maxPerLayer: 40, maxTotal: 80 },
  },
};

export const getTechniquePassiveValueConstraint = (
  key: string,
  quality: GeneratedTechniqueQuality,
): TechniquePassiveValueConstraint | null => {
  const mode = TECHNIQUE_PASSIVE_MODE_BY_KEY[key];
  if (mode !== 'percent' && mode !== 'flat') {
    return null;
  }
  const baseConstraint = TECHNIQUE_PASSIVE_DEFAULT_CONSTRAINTS_BY_MODE[mode][quality];
  return {
    mode,
    maxPerLayer: baseConstraint.maxPerLayer,
    maxTotal: baseConstraint.maxTotal,
  };
};

export const buildTechniquePassiveValueGuideByKey = (
  quality: GeneratedTechniqueQuality,
): Record<string, TechniquePassiveValueConstraint> => {
  return TECHNIQUE_PASSIVE_ENTRY_POOL.reduce<Record<string, TechniquePassiveValueConstraint>>((accumulator, entry) => {
    const constraint = getTechniquePassiveValueConstraint(entry.key, quality);
    if (constraint !== null) {
      accumulator[entry.key] = constraint;
    }
    return accumulator;
  }, {});
};

/**
 * 共享功法被动池
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中维护 AI 可选的全部功法被动 key 与对应数值模式，避免再按类型复制多份候选池。
 * 2) 不做什么：不根据功法类型做二次筛选，不承担运行时合法性校验。
 *
 * 输入/输出：
 * - 输入：受支持的功法被动 key 列表与每个 key 的数值模式。
 * - 输出：可直接复用的只读被动池条目数组。
 *
 * 数据流/状态流：
 * 被动语义字典/数值模式映射 -> 共享被动池 -> 各功法类型复用同一份候选集合 -> prompt 与测试保持一致。
 *
 * 关键边界条件与坑点：
 * 1) 这里是 AI 选项池，不是运行时白名单；真正合法性仍由 `isSupportedTechniquePassiveKey` 统一校验。
 * 2) 若新增支持 key 但漏配 mode，会让共享池与支持词典脱节，因此必须和 `TECHNIQUE_PASSIVE_KEY_MEANING_MAP` 同步维护。
 */
export const TECHNIQUE_PASSIVE_ENTRY_POOL = Object.freeze(
  SUPPORTED_TECHNIQUE_PASSIVE_KEYS.map((key) => ({
    key,
    mode: TECHNIQUE_PASSIVE_MODE_BY_KEY[key],
  })),
);

export const TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE: Record<GeneratedTechniqueType, TechniquePassivePoolEntry[]> = {
  武技: [...TECHNIQUE_PASSIVE_ENTRY_POOL],
  心法: [...TECHNIQUE_PASSIVE_ENTRY_POOL],
  法诀: [...TECHNIQUE_PASSIVE_ENTRY_POOL],
  身法: [...TECHNIQUE_PASSIVE_ENTRY_POOL],
  辅修: [...TECHNIQUE_PASSIVE_ENTRY_POOL],
};

export const TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY: Record<GeneratedTechniqueQuality, { min: number; max: number }> = {
  黄: { min: 1, max: 2 },
  玄: { min: 1, max: 3 },
  地: { min: 1, max: 4 },
  天: { min: 2, max: 4 },
};

export const TECHNIQUE_EFFECT_SCALE_ATTR_OPTIONS = TECHNIQUE_SKILL_SCALE_ATTR_LIST;

export const TECHNIQUE_PROMPT_GENERAL_RULES = [
  '仅输出单个 JSON 对象，不要输出代码块与解释文本',
  '所有字段必须使用 camelCase，禁止 snake_case 与中文 key',
  'skills 必须为数组，长度必须满足 skillCountRange',
  'layers 必须与 maxLayer 一致，按 layer 从小到大给出',
  '生成功法不需要升级材料，layers[*].costMaterials 必须是 []',
  'skill.id 仅作占位，后端会重写；但在本次输出内仍需保持 skills/layers 引用一致',
  '所有枚举字段必须使用给定枚举值，严禁自造枚举（例如 controlType/markId/targetType）',
  'effects 中每个对象必须满足所属 effect.type 的 required 字段',
  'chance 统一使用 0~1 浮点概率（0.1=10%），禁止使用 10/60 这类百分数整数',
  'valueType=combined 时必须同时提供 baseValue 与 scaleRate',
  'valueType=scale 时必须提供 scaleAttr 与 scaleRate',
  'technique.type 必须等于 techniqueType，禁止自行改成其他功法类型',
  'technique.requiredRealm 必须来自 realmEnum',
  'buff/debuff 必须使用结构化 Buff 字段（buffKind/buffKey/attrKey/applyType），禁止使用 buffId，且 buffKey/attrKey 必须来自 allowedBuffConfigRules',
  'mark.markId 必须来自 allowedMarkIds',
  'effects 不支持 valueFormula，严禁返回该字段',
  'skills[*].upgrades 只允许使用 { layer, changes } 结构，不要返回 description/effectChanges/effectIndex',
  'upgrades[*].changes 仅允许 target_count/cooldown/cost_lingqi/cost_lingqi_rate/cost_qixue/cost_qixue_rate/ai_priority/effects/addEffect',
  '如果要调整效果，只能使用 changes.effects 全量替换，或 changes.addEffect 追加',
  '功法类型不会限制被动 key 搭配，layers.passives 可自由从 allowedPassiveKeys 中组合',
  '禁止输出 null/undefined 字段；可省略可选字段，不要输出空字符串占位',
] as const;

export const TECHNIQUE_PROMPT_TYPE_ENUM = GENERATED_TECHNIQUE_TYPE_LIST;

export const TECHNIQUE_PROMPT_REALM_ENUM = REALM_ORDER;

export const TECHNIQUE_PROMPT_TARGET_TYPE_ENUM = TECHNIQUE_SKILL_TARGET_TYPE_LIST;

export const TECHNIQUE_PROMPT_ELEMENT_ENUM = ['none', 'jin', 'mu', 'shui', 'huo', 'tu'] as const;

export const TECHNIQUE_PROMPT_DAMAGE_TYPE_ENUM = ['physical', 'magic', 'true'] as const;

export const TECHNIQUE_PROMPT_VALUE_TYPE_ENUM = TECHNIQUE_SKILL_VALUE_TYPE_LIST;

export const TECHNIQUE_PROMPT_RESOURCE_TYPE_ENUM = TECHNIQUE_SKILL_RESOURCE_TYPE_LIST;

export const TECHNIQUE_PROMPT_DISPEL_TYPE_ENUM = TECHNIQUE_SKILL_DISPEL_TYPE_LIST;

export const TECHNIQUE_PROMPT_RESOURCE_TARGET_ENUM = TECHNIQUE_SKILL_RESOURCE_TARGET_LIST;

export const TECHNIQUE_PROMPT_CONTROL_TYPE_ENUM = TECHNIQUE_SKILL_CONTROL_TYPE_LIST;

export const TECHNIQUE_PROMPT_MARK_ID_ENUM = TECHNIQUE_SKILL_MARK_ID_LIST;
export const TECHNIQUE_PROMPT_MARK_OPERATION_ENUM = TECHNIQUE_SKILL_MARK_OPERATION_LIST;
export const TECHNIQUE_PROMPT_MARK_CONSUME_MODE_ENUM = TECHNIQUE_SKILL_MARK_CONSUME_MODE_LIST;
export const TECHNIQUE_PROMPT_MARK_RESULT_TYPE_ENUM = TECHNIQUE_SKILL_MARK_RESULT_TYPE_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_ID_ENUM = TECHNIQUE_SKILL_MOMENTUM_ID_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_OPERATION_ENUM = TECHNIQUE_SKILL_MOMENTUM_OPERATION_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_CONSUME_MODE_ENUM = TECHNIQUE_SKILL_MOMENTUM_CONSUME_MODE_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_BONUS_TYPE_ENUM = TECHNIQUE_SKILL_MOMENTUM_BONUS_TYPE_LIST;

const buildTechniquePromptBuffConfigRules = () => {
  const catalog = getTechniqueStructuredBuffCatalog();
  return {
    kindEnum: [...catalog.kindEnum],
    attrKeyEnum: [...catalog.attrKeyEnum],
    applyTypeEnum: [...catalog.applyTypeEnum],
    buffKeyEnumByType: {
      buff: [...catalog.buffKeyEnumByType.buff],
      debuff: [...catalog.buffKeyEnumByType.debuff],
    },
    exampleByTypeAndKind: catalog.exampleByTypeAndKind,
    commonRequired: ['type', 'buffKind', 'buffKey'],
    commonOptional: ['value', 'duration', 'stacks'],
    byKind: {
      attr: {
        required: ['attrKey'],
        optional: ['applyType', 'value'],
        notes: ['applyType 可选 flat/percent；未填时由服务端按属性默认规则推导'],
      },
      dot: {
        required: [],
        optional: ['valueType', 'scaleAttr', 'scaleRate', 'bonusTargetMaxQixueRate'],
        notes: ['持续伤害模板（例如灼烧）'],
      },
      hot: {
        required: [],
        optional: ['valueType', 'scaleAttr', 'scaleRate'],
        notes: ['持续治疗模板'],
      },
      dodge_next: {
        required: [],
        optional: ['stacks'],
        notes: ['下一次闪避强化模板'],
      },
      reflect_damage: {
        required: ['value'],
        optional: [],
        notes: ['受击后按本次实际受击伤害的比例反弹真伤，value 使用 0~1 浮点比例'],
      },
    },
  } as const;
};

export const TECHNIQUE_PROMPT_NUMERIC_RANGES = {
  skill: {
    costLingqi: [0, 80],
    costLingqiRate: [0, 1],
    costQixue: [0, 120],
    costQixueRate: [0, 0.95],
    cooldown: [0, 6],
    targetCount: [1, 6],
    aiPriority: [0, 100],
  },
  layer: {
    layer: [1, 'maxLayer'],
    costSpiritStones: [0, 1000000],
    costExp: [0, 1000000],
  },
  effect: {
    chance: [0, 1],
    duration: [1, 99],
    hit_count: [1, 20],
    scaleRate: [0, 5],
    stacks: [1, 99],
    count: [1, 99],
    maxStacks: [1, 99],
    consumeStacks: [1, 99],
    perStackRate: [0, 5],
    bonusTargetMaxQixueRate: [0, 1],
  },
  passiveValue: {
    rule: '被动值不能套用统一大范围，必须逐 key 遵守 passiveValueGuideByKey 中的 maxPerLayer/maxTotal',
  },
  upgradeDeltaSuggested: {
    cooldown: [-3, 3],
    cost_lingqi: [-40, 40],
    cost_lingqi_rate: [-0.5, 0.5],
    cost_qixue: [-60, 60],
    cost_qixue_rate: [-0.5, 0.5],
    ai_priority: [-50, 50],
  },
} as const;

export const TECHNIQUE_PROMPT_UPGRADE_ALLOWED_CHANGE_KEYS = TECHNIQUE_SKILL_UPGRADE_ALLOWED_CHANGE_KEYS;

export const TECHNIQUE_PROMPT_UPGRADE_UNSUPPORTED_FIELDS = TECHNIQUE_SKILL_UPGRADE_UNSUPPORTED_FIELDS;

export const TECHNIQUE_PROMPT_UPGRADE_SCHEMA = {
  item: {
    required: ['layer', 'changes'],
    forbidden: ['description', 'effectChanges', 'effectIndex'],
    layer: '触发层级（整数，1~maxLayer）',
    changes: '升级改动对象，只允许 upgradeAllowedChangeKeys；未出现的键表示不改动',
  },
  changes: {
    target_count: '直接设置目标数（绝对值，不是增量，整数 >= 1）',
    cooldown: '冷却增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cooldown）',
    cost_lingqi: '灵气消耗增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cost_lingqi）',
    cost_lingqi_rate: '灵气比例消耗增量（可正可负，0.1=10%，建议范围见 numericRanges.upgradeDeltaSuggested.cost_lingqi_rate）',
    cost_qixue: '气血消耗增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cost_qixue）',
    cost_qixue_rate: '气血比例消耗增量（可正可负，0.1=10%，建议范围见 numericRanges.upgradeDeltaSuggested.cost_qixue_rate）',
    ai_priority: 'AI优先级增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.ai_priority）',
    effects: '完整 effects 新数组（整包替换，不支持按索引局部改）',
    addEffect: '追加一个 effect 对象（用于在现有效果末尾新增）',
  },
  examples: {
    valid: [
      {
        layer: 3,
        changes: {
          effects: [
            {
              type: 'damage',
              valueType: 'scale',
              scaleAttr: 'wugong',
              scaleRate: 1.8,
              damageType: 'physical',
              element: 'none',
            },
          ],
        },
      },
      {
        layer: 5,
        changes: {
          addEffect: {
            type: 'control',
            controlType: 'stun',
            chance: 0.25,
            duration: 1,
          },
        },
      },
    ],
    invalid: [
      {
        layer: 3,
        description: '错误示例，upgrades 不允许 description',
        effectChanges: [{ effectIndex: 0, scaleRate: 1.8 }],
      },
    ],
  },
} as const;

export const TECHNIQUE_PROMPT_FIELD_SEMANTICS = {
  technique: {
    name: '功法内部名/建议名，发布时会由玩家最终命名',
    type: '功法类型，必须严格等于 techniqueType',
    quality: '功法品质，必须与 quality 入参一致',
    maxLayer: '最大层数，必须与 quality 对应层数一致',
    requiredRealm: '学习最低境界，必须在 realmEnum 中（如 凡人 / 炼精化炁·养气期）',
    attributeType: '主属性类型，physical 或 magic（与技能主伤害倾向一致）',
    attributeElement: '元素属性，必须在 elementEnum 中',
    tags: '标签数组，便于检索与展示',
    description: '短描述，用于列表卡片（建议 20~60 字）',
    longDesc: '长描述，用于详情文案（建议 40~180 字）',
  },
  skill: {
    id: '技能唯一标识（后端会重写为全局唯一）',
    name: '技能名称',
    description: '技能描述',
    icon: '图标路径，可为 null',
    sourceType: '技能来源，固定 technique',
    costLingqi: '释放灵气消耗（整数，范围见 numericRanges.skill.costLingqi）',
    costLingqiRate: '释放灵气比例消耗（按最大灵气计算，0.1=10%，范围见 numericRanges.skill.costLingqiRate）',
    costQixue: '释放气血消耗（整数，范围见 numericRanges.skill.costQixue）',
    costQixueRate: '释放气血比例消耗（按最大气血计算，0.1=10%，范围见 numericRanges.skill.costQixueRate，必须小于1）',
    cooldown: '冷却回合（整数，范围见 numericRanges.skill.cooldown）',
    targetType: '目标类型，必须在 targetTypeEnum',
    targetCount: '目标数量（整数，范围见 numericRanges.skill.targetCount）',
    damageType: '伤害类型 physical/magic/true/null',
    element: '技能元素，必须在 elementEnum 中',
    effects: '技能效果数组，按 effectSchemaByType 生成',
    triggerType: '触发类型，固定 active',
    aiPriority: 'AI 施放优先级，范围见 numericRanges.skill.aiPriority，越高越优先',
    upgrades: '高层强化配置数组；可为空数组；必须符合 upgradeSchema',
  },
  layer: {
    layer: '层号，从 1 开始递增，范围见 numericRanges.layer.layer',
    costSpiritStones: '灵石消耗（整数，范围见 numericRanges.layer.costSpiritStones）',
    costExp: '经验消耗（整数，范围见 numericRanges.layer.costExp）',
    costMaterials: '升级材料数组，本系统固定要求 []',
    passives: '本层被动数组，key 必须来自 allowedPassiveKeys，数值必须遵守 passiveValueGuideByKey 的单层与累计预算',
    unlockSkillIds: '本层解锁技能ID数组（引用 skills[*].id）',
    upgradeSkillIds: '本层强化技能ID数组（引用 skills[*].id）',
    layerDesc: '层描述文案',
  },
} as const;

export const TECHNIQUE_PROMPT_EFFECT_COMMON_FIELDS = {
  type: '效果类型，必须在 effectTypeEnum',
  value: '数值字段。含义依 valueType 与 effect.type 变化；必须是有限数字',
  valueType: '取值模式：flat 固定值 / percent 百分比 / scale 属性倍率 / combined 固定值+倍率',
  baseValue: '仅 combined 模式使用的固定基础值；与 scaleRate 配合',
  scaleAttr: `倍率引用属性，必须在 attributeKeyEnum 中（推荐：${TECHNIQUE_EFFECT_SCALE_ATTR_OPTIONS.join('/')}）`,
  scaleRate: '倍率系数（建议范围见 numericRanges.effect.scaleRate）',
  buffKey: '结构化 Buff 键。buff/debuff 必填，且必须在 allowedBuffConfigRules.buffKeyEnumByType[type] 中',
  attrKey: '属性 Buff 的属性键。buffKind=attr 时必填，且必须在 allowedBuffConfigRules.attrKeyEnum 中',
  applyType: '属性 Buff 的叠加模式。若填写，必须在 allowedBuffConfigRules.applyTypeEnum 中',
  duration: '持续回合数（整数，建议范围见 numericRanges.effect.duration）',
  chance: '概率（0~1 浮点，建议范围见 numericRanges.effect.chance）',
  element: '元素（必须在 elementEnum 中）',
  damageType: '伤害类型（必须在 damageTypeEnum 中）',
  target: '资源类效果目标（必须在 resourceTargetEnum 中）',
  momentumId: '势能资源 ID，momentum 效果必填，必须在 momentumIdEnum 中',
  gainStacks: '本次获得的势层数（整数，建议 1~99）',
  bonusType: '消耗势后加成的效果类别，必须在 momentumBonusTypeEnum 中',
} as const;

export const TECHNIQUE_PROMPT_EFFECT_SCHEMA_BY_TYPE = {
  damage: {
    meaning: '直接伤害效果',
    required: ['type'],
    optional: ['valueType', 'value', 'scaleAttr', 'scaleRate', 'damageType', 'element', 'hit_count', 'bonusTargetMaxQixueRate'],
    rangeGuide: {
      hit_count: '整数，建议 1~20（见 numericRanges.effect.hit_count）',
      bonusTargetMaxQixueRate: '比例，建议 0~1（见 numericRanges.effect.bonusTargetMaxQixueRate）',
    },
    notes: [
      'valueType=scale 时推荐给出 scaleAttr + scaleRate',
      'damageType 缺失时会继承 skill.damageType；建议显式填写',
      'element 缺失时会继承 skill.element；建议显式填写',
    ],
    defaultTemplate: {
      type: 'damage',
      valueType: 'scale',
      scaleAttr: 'wugong',
      scaleRate: 1.2,
      damageType: 'physical',
      element: 'none',
      hit_count: 1,
    },
  },
  heal: {
    meaning: '治疗效果',
    required: ['type'],
    optional: ['valueType', 'value', 'scaleAttr', 'scaleRate'],
    notes: ['推荐 valueType=scale，scaleAttr=fagong'],
    defaultTemplate: {
      type: 'heal',
      valueType: 'scale',
      scaleAttr: 'fagong',
      scaleRate: 0.8,
    },
  },
  shield: {
    meaning: '护盾效果',
    required: ['type'],
    optional: ['valueType', 'value', 'scaleAttr', 'scaleRate', 'duration'],
    notes: ['duration 建议 1~5 回合'],
    defaultTemplate: {
      type: 'shield',
      valueType: 'scale',
      scaleAttr: 'max_qixue',
      scaleRate: 0.3,
      duration: 2,
    },
  },
  buff: {
    meaning: '增益效果，使用结构化 Buff 配置（可扩展）',
    required: ['type', 'buffKind', 'buffKey'],
    optional: ['attrKey', 'applyType', 'value', 'valueType', 'scaleAttr', 'scaleRate', 'duration', 'stacks'],
    rules: [
      'buffKind 必须在 allowedBuffConfigRules.kindEnum 中',
      'buffKey 必须在 allowedBuffConfigRules.buffKeyEnumByType.buff 中',
      'buffKind=attr 时必须提供 attrKey，且 attrKey 必须在 allowedBuffConfigRules.attrKeyEnum 中',
      'applyType 如有填写，必须在 allowedBuffConfigRules.applyTypeEnum 中',
      'duration/stacks 建议为正整数（见 numericRanges.effect.duration / stacks）',
    ],
    defaultTemplate: {
      type: 'buff',
      buffKind: 'attr',
      buffKey: 'buff-shanbi-up',
      attrKey: 'shanbi',
      applyType: 'flat',
      value: 0.12,
      duration: 2,
      stacks: 1,
    },
  },
  debuff: {
    meaning: '减益效果，使用结构化 Buff 配置（可扩展）',
    required: ['type', 'buffKind', 'buffKey'],
    optional: ['attrKey', 'applyType', 'value', 'valueType', 'scaleAttr', 'scaleRate', 'duration', 'stacks'],
    rules: [
      'buffKind 必须在 allowedBuffConfigRules.kindEnum 中',
      'buffKey 必须在 allowedBuffConfigRules.buffKeyEnumByType.debuff 中',
      'buffKind=attr 时必须提供 attrKey，且 attrKey 必须在 allowedBuffConfigRules.attrKeyEnum 中',
      'applyType 如有填写，必须在 allowedBuffConfigRules.applyTypeEnum 中',
    ],
    defaultTemplate: {
      type: 'debuff',
      buffKind: 'dot',
      buffKey: 'debuff-burn',
      valueType: 'scale',
      scaleAttr: 'fagong',
      scaleRate: 0.3,
      duration: 2,
    },
  },
  dispel: {
    meaning: '驱散目标身上可驱散 buff/debuff',
    required: ['type'],
    optional: ['dispelType', 'count'],
    rules: ['dispelType 必须在 dispelTypeEnum 中', 'count 建议 1~99（见 numericRanges.effect.count）'],
    defaultTemplate: {
      type: 'dispel',
      dispelType: 'debuff',
      count: 1,
    },
  },
  resource: {
    meaning: '资源调整（灵气/气血）',
    required: ['type', 'resourceType', 'value'],
    optional: ['target'],
    rules: [
      'resourceType 必须在 resourceTypeEnum 中',
      'target 必须在 resourceTargetEnum 中；建议 self',
    ],
    defaultTemplate: {
      type: 'resource',
      resourceType: 'lingqi',
      value: 20,
      target: 'self',
    },
  },
  restore_lingqi: {
    meaning: '灵气回复（快捷效果）',
    required: ['type', 'value'],
    optional: [],
    notes: ['value 应为正整数'],
    defaultTemplate: {
      type: 'restore_lingqi',
      value: 20,
    },
  },
  cleanse: {
    meaning: '净化 debuff',
    required: ['type'],
    optional: ['count'],
    notes: ['count 建议 1~99'],
    defaultTemplate: {
      type: 'cleanse',
      count: 1,
    },
  },
  cleanse_control: {
    meaning: '仅净化控制类 debuff',
    required: ['type'],
    optional: ['count'],
    notes: ['count 建议 1~99'],
    defaultTemplate: {
      type: 'cleanse_control',
      count: 1,
    },
  },
  lifesteal: {
    meaning: '按本次造成伤害比例吸血',
    required: ['type', 'value'],
    optional: [],
    rules: ['value 必须是 0~1 的比例'],
    defaultTemplate: {
      type: 'lifesteal',
      value: 0.15,
    },
  },
  control: {
    meaning: '控制效果（受目标控制抗性影响）',
    required: ['type', 'controlType'],
    optional: ['chance', 'duration'],
    rules: [
      'controlType 必须在 controlTypeEnum 中',
      'chance 必须是 0~1 浮点',
      'duration 建议 1~3',
    ],
    defaultTemplate: {
      type: 'control',
      controlType: 'stun',
      chance: 0.2,
      duration: 1,
    },
  },
  mark: {
    meaning: '印记效果（叠加/消耗）',
    required: ['type', 'markId', 'operation'],
    optional: ['maxStacks', 'consumeMode', 'consumeStacks', 'perStackRate', 'resultType', 'valueType', 'scaleAttr', 'scaleRate'],
    rules: [
      'markId 必须在 allowedMarkIds 中',
      'operation 必须在 markOperationEnum 中',
      'consumeMode 必须在 markConsumeModeEnum 中',
      'resultType 必须在 markResultTypeEnum 中',
      'consume 模式建议同时给 consumeMode + consumeStacks + perStackRate',
    ],
    defaultTemplate: {
      type: 'mark',
      markId: 'void_erosion',
      operation: 'apply',
      maxStacks: 5,
    },
  },
  momentum: {
    meaning: '势能效果（施法者自身连招资源）',
    required: ['type', 'momentumId', 'operation'],
    optional: ['gainStacks', 'maxStacks', 'consumeMode', 'consumeStacks', 'perStackRate', 'bonusType'],
    rules: [
      'momentumId 必须在 momentumIdEnum 中',
      'operation 必须在 momentumOperationEnum 中',
      'consumeMode 必须在 momentumConsumeModeEnum 中',
      'bonusType 必须在 momentumBonusTypeEnum 中',
      'gain 时建议填写 gainStacks，consume 时建议填写 consumeMode + perStackRate + bonusType',
    ],
    defaultTemplate: {
      type: 'momentum',
      momentumId: 'battle_momentum',
      operation: 'gain',
      gainStacks: 1,
      maxStacks: 5,
    },
  },
} as const;

export const TECHNIQUE_PROMPT_OUTPUT_SCHEMA = {
  technique: {
    name: 'string(必须为中文字符串，建议 2~8 字)',
    type: 'enum',
    quality: 'enum(必须等于quality入参)',
    maxLayer: 'number(必须等于maxLayer入参)',
    requiredRealm: 'string',
    attributeType: 'physical|magic',
    attributeElement: 'string',
    tags: 'string[]',
    description: 'string',
    longDesc: 'string',
  },
  skills: [
    {
      id: 'string',
      name: 'string',
      description: 'string',
      icon: 'string|null',
      costLingqi: 'number',
      costLingqiRate: 'number',
      costQixue: 'number',
      costQixueRate: 'number',
      cooldown: 'number',
      targetType: 'enum',
      targetCount: 'number',
      damageType: 'physical|magic|true|null',
      element: 'string',
      effects: 'SkillEffect[]（严格按 effectSchemaByType）',
      aiPriority: 'number',
      upgrades: [
        {
          layer: 'number',
          changes: {
            target_count: 'number(可选)',
            cooldown: 'number(可选，增量)',
            cost_lingqi: 'number(可选，增量)',
            cost_lingqi_rate: 'number(可选，增量)',
            cost_qixue: 'number(可选，增量)',
            cost_qixue_rate: 'number(可选，增量)',
            ai_priority: 'number(可选，增量)',
            effects: 'SkillEffect[](可选，整包替换)',
            addEffect: 'SkillEffect(可选，追加一个)',
          },
        },
      ],
    },
  ],
  layers: [
    {
      layer: 'number',
      costSpiritStones: 'number',
      costExp: 'number',
      costMaterials: '[]（固定空数组）',
      passives: [{ key: 'string', value: 'number' }],
      unlockSkillIds: 'string[]',
      upgradeSkillIds: 'string[]',
      layerDesc: 'string',
    },
  ],
} as const;

export const TECHNIQUE_PROMPT_OUTPUT_CHECKLIST = [
  '输出必须是单个 JSON 对象，且可被 JSON.parse 直接解析',
  '必须只返回 technique/skills/layers 三个顶层字段',
  'technique.requiredRealm 必须在 realmEnum 中',
  'skills.length 必须命中对应品质的 skillCountRange',
  'layers.length 必须等于 maxLayer，且 layer 从 1 递增到 maxLayer',
  'layers[*].costMaterials 必须是 []',
  '所有 effect.type 必须在 effectTypeEnum 中',
  '任何 effect 不得出现 valueFormula 字段',
  'controlType 必须在 controlTypeEnum；markId 必须在 allowedMarkIds',
  'buff/debuff 必须使用结构化 Buff 字段，不得使用 buffId，且 buffKey/attrKey 必须命中预定义允许列表',
  'skills[*].upgrades 只能使用 upgradeSchema，禁止 description/effectChanges/effectIndex',
  'upgrades[*].changes 只能包含 upgradeAllowedChangeKeys 中的字段',
  'chance 必须在 0~1 且使用浮点比例表达',
  'layers.passives[].key 必须来自 allowedPassiveKeys，且 value 必须满足 passiveValueGuideByKey 的单层/累计上限',
] as const;

export const buildTechniqueGeneratorPromptInput = (params: {
  techniqueType: GeneratedTechniqueType;
  quality: GeneratedTechniqueQuality;
  maxLayer: number;
  effectTypeEnum: readonly string[];
}) => {
  const { techniqueType, quality, maxLayer, effectTypeEnum } = params;
  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[quality];
  const promptBuffConfigRules = buildTechniquePromptBuffConfigRules();
  const passiveValueGuideByKey = buildTechniquePassiveValueGuideByKey(quality);
  return {
    task: '生成完整功法定义',
    techniqueType,
    quality,
    maxLayer,
    constraints: {
      generalRules: [...TECHNIQUE_PROMPT_GENERAL_RULES],
      fieldSemantics: TECHNIQUE_PROMPT_FIELD_SEMANTICS,
      typeEnum: [techniqueType],
      realmEnum: [...TECHNIQUE_PROMPT_REALM_ENUM],
      targetTypeEnum: [...TECHNIQUE_PROMPT_TARGET_TYPE_ENUM],
      elementEnum: [...TECHNIQUE_PROMPT_ELEMENT_ENUM],
      damageTypeEnum: [...TECHNIQUE_PROMPT_DAMAGE_TYPE_ENUM],
      valueTypeEnum: [...TECHNIQUE_PROMPT_VALUE_TYPE_ENUM],
      effectTypeEnum: [...effectTypeEnum],
      controlTypeEnum: [...TECHNIQUE_PROMPT_CONTROL_TYPE_ENUM],
      resourceTypeEnum: [...TECHNIQUE_PROMPT_RESOURCE_TYPE_ENUM],
      resourceTargetEnum: [...TECHNIQUE_PROMPT_RESOURCE_TARGET_ENUM],
      dispelTypeEnum: [...TECHNIQUE_PROMPT_DISPEL_TYPE_ENUM],
      allowedMarkIds: [...TECHNIQUE_PROMPT_MARK_ID_ENUM],
      markOperationEnum: [...TECHNIQUE_PROMPT_MARK_OPERATION_ENUM],
      markConsumeModeEnum: [...TECHNIQUE_PROMPT_MARK_CONSUME_MODE_ENUM],
      markResultTypeEnum: [...TECHNIQUE_PROMPT_MARK_RESULT_TYPE_ENUM],
      momentumIdEnum: [...TECHNIQUE_PROMPT_MOMENTUM_ID_ENUM],
      momentumOperationEnum: [...TECHNIQUE_PROMPT_MOMENTUM_OPERATION_ENUM],
      momentumConsumeModeEnum: [...TECHNIQUE_PROMPT_MOMENTUM_CONSUME_MODE_ENUM],
      momentumBonusTypeEnum: [...TECHNIQUE_PROMPT_MOMENTUM_BONUS_TYPE_ENUM],
      allowedBuffConfigRules: promptBuffConfigRules,
      attributeKeyEnum: [...TECHNIQUE_EFFECT_SCALE_ATTR_OPTIONS],
      numericRanges: TECHNIQUE_PROMPT_NUMERIC_RANGES,
      effectCommonFields: TECHNIQUE_PROMPT_EFFECT_COMMON_FIELDS,
      effectSchemaByType: TECHNIQUE_PROMPT_EFFECT_SCHEMA_BY_TYPE,
      effectUnsupportedFields: [...TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS],
      effectRule: 'effects 不支持 valueFormula；请使用 value/valueType/scaleAttr/scaleRate 表达数值',
      allowedPassiveKeys: [...SUPPORTED_TECHNIQUE_PASSIVE_KEYS],
      passiveKeyMeanings: TECHNIQUE_PASSIVE_KEY_MEANING_MAP,
      passiveValueGuideByKey,
      typeRule: 'technique.type 必须严格等于 techniqueType',
      passiveRule:
        'layers.passives[].key 可自由从 allowedPassiveKeys 中组合，不受功法类型限制；每层 value 必须 > 0 且不超过 passiveValueGuideByKey[key].maxPerLayer，同一个 key 在全部 layers 的累计值不能超过 passiveValueGuideByKey[key].maxTotal',
      skillCountRange,
      skillCountRule: `skills.length 必须在${skillCountRange.min}~${skillCountRange.max}之间`,
      noMaterialRule: '生成功法不需要升级材料，layers[].costMaterials 必须始终为空数组',
      cooldownRange: [0, 6],
      lingqiCostRange: [0, 80],
      lingqiCostRateRange: [0, 1],
      qixueCostRange: [0, 120],
      qixueCostRateRange: [0, 0.95],
      targetCountRange: [1, 6],
      upgradeAllowedChangeKeys: [...TECHNIQUE_PROMPT_UPGRADE_ALLOWED_CHANGE_KEYS],
      upgradeUnsupportedFields: [...TECHNIQUE_PROMPT_UPGRADE_UNSUPPORTED_FIELDS],
      upgradeSchema: TECHNIQUE_PROMPT_UPGRADE_SCHEMA,
      upgradeRule:
        'upgrades 每项必须是 {layer,changes}。changes 只允许 target_count/cooldown/cost_lingqi/cost_lingqi_rate/cost_qixue/cost_qixue_rate/ai_priority/effects/addEffect。严禁 effectChanges/effectIndex/description。',
      outputChecklist: [...TECHNIQUE_PROMPT_OUTPUT_CHECKLIST],
    },
    outputSchema: TECHNIQUE_PROMPT_OUTPUT_SCHEMA,
  };
};

export { validateTechniqueSkillEffect, validateTechniqueSkillUpgrade, validateTechniqueStructuredBuffEffect };

export const isSupportedTechniquePassiveKey = (raw: unknown): boolean => {
  if (typeof raw !== 'string') return false;
  const key = raw.trim();
  if (!key) return false;
  return SUPPORTED_TECHNIQUE_PASSIVE_KEY_SET.has(key);
};
