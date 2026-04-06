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
import {
  normalizeTextModelPromptNoiseHash,
  TEXT_MODEL_PROMPT_NOISE_CONSTRAINT,
  type TechniqueTextModelResponseFormat,
} from './techniqueTextModelShared.js';
import { REALM_ORDER } from './realmRules.js';
import { MARK_TRAIT_GUIDE_BY_ID } from '../../battle/modules/mark.js';
import {
  TECHNIQUE_SKILL_CONTROL_TYPE_LIST,
  TECHNIQUE_SKILL_DISPEL_TYPE_LIST,
  TECHNIQUE_SKILL_EFFECT_TYPE_LIST,
  TECHNIQUE_SKILL_FATE_SWAP_MODE_LIST,
  TECHNIQUE_SKILL_AURA_TARGET_LIST,
  TECHNIQUE_SKILL_AURA_SUB_EFFECT_TYPE_LIST,
  TECHNIQUE_SKILL_EFFECT_MAX_COUNT,
  TECHNIQUE_SKILL_EFFECT_TARGET_LIST,
  TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE,
  TECHNIQUE_SKILL_TRIGGER_TYPE_LIST,
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
  validateTechniqueSkillTargetCount,
  validateTechniqueSkillUpgrade,
} from './techniqueSkillGenerationSpec.js';
import {
  getTechniqueStructuredBuffCatalog,
  validateTechniqueStructuredBuffEffect,
} from './techniqueStructuredBuffCatalog.js';
import {
  ATTACK_ATTR_KEY_SET,
  TECHNIQUE_PASSIVE_KEY_MEANING_MAP,
  TECHNIQUE_PASSIVE_KEYS,
  TECHNIQUE_PASSIVE_MODE_BY_KEY,
} from './characterAttrRegistry.js';
import {
  getTechniquePassiveValueConstraint,
  type GeneratedTechniqueQuality,
  type TechniquePassiveValueConstraint,
} from './techniquePassiveValueBudget.js';
import {
  TECHNIQUE_BURNING_WORD_PROMPT_GENERAL_RULE,
  TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_GENERAL_RULE,
} from './techniqueBurningWordPrompt.js';
import {
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_GENERAL_RULE,
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_SCOPE_GENERAL_RULE,
} from './techniqueRecentSuccessfulDescriptionPrompt.js';
import { TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE } from './techniqueResearchCreativeDirectionPrompt.js';

export const GENERATED_TECHNIQUE_TYPE_LIST = ['武技', '心法', '法诀', '身法', '辅修'] as const;
export type GeneratedTechniqueType = (typeof GENERATED_TECHNIQUE_TYPE_LIST)[number];
export type TechniquePassiveMode = 'percent' | 'flat';
export type TechniquePassivePoolEntry = { key: string; mode: TechniquePassiveMode };
export type { GeneratedTechniqueQuality, TechniquePassiveValueConstraint } from './techniquePassiveValueBudget.js';

export const TECHNIQUE_PROMPT_SYSTEM_MESSAGE =
  '你是修仙RPG功法设计器。请严格输出JSON，不要输出额外文本。';

export const TECHNIQUE_EFFECT_TYPE_LIST = TECHNIQUE_SKILL_EFFECT_TYPE_LIST;

export const TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS = ['valueFormula'] as const;

export const isGeneratedTechniqueType = (raw: unknown): raw is GeneratedTechniqueType => {
  return typeof raw === 'string' && GENERATED_TECHNIQUE_TYPE_LIST.includes(raw as GeneratedTechniqueType);
};

export const SUPPORTED_TECHNIQUE_PASSIVE_KEYS = TECHNIQUE_PASSIVE_KEYS;
export const SUPPORTED_TECHNIQUE_PASSIVE_KEY_SET = new Set<string>(SUPPORTED_TECHNIQUE_PASSIVE_KEYS);
export { TECHNIQUE_PASSIVE_KEY_MEANING_MAP };

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
    mode: TECHNIQUE_PASSIVE_MODE_BY_KEY[key] === 'multiply' ? 'percent' : TECHNIQUE_PASSIVE_MODE_BY_KEY[key],
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
export const TECHNIQUE_DAMAGE_EFFECT_FORBIDDEN_SCALE_ATTR_OPTIONS = ['sudu'] as const;
export const TECHNIQUE_PROMPT_CREATIVE_DIRECTION_RULES = [
  '功法可以围绕 1~2 个核心机制展开，不必平均覆盖输出、控制、生存、回复等所有方向。',
  '允许采用偏科、连段、蓄势、印记、反制、献祭、铺场、光环、延迟爆发等鲜明套路；只要主题统一且满足既有硬约束，不必为了“全面”强行补齐无关效果。',
  'skills、layers 与 layerDesc 应服务同一核心套路的递进深化；允许多个层级持续强化同一机制，不必为追求差异而频繁换套路。',
  '命名、description、longDesc、layerDesc 与 skill.description 可以更有门派感、人物气质和招式辨识度，避免模板化套话。',
] as const;

export const TECHNIQUE_PROMPT_QIXUE_ATTACK_RATIO_RULE =
  '当前数值环境可近似理解为：max_qixue 与 wugong/fagong 的量级比例约为 3:1；生成涉及气血倍率、气血百分比伤害或基于双攻的伤害时，请以这个相对量级作为数值参考。';

export const TECHNIQUE_PROMPT_GENERAL_RULES = [
  '仅输出单个 JSON 对象，不要输出代码块与解释文本',
  '所有字段必须使用 camelCase，禁止 snake_case 与中文 key',
  '顶层必须直接返回 technique/skills/layers，禁止额外包裹 candidate/data/result/payload 等中间键',
  '若 extraContext.techniqueRetryGuidance 存在，必须优先修正 previousFailureReason 指出的错误，再满足其余设计约束与业务规则',
  TECHNIQUE_BURNING_WORD_PROMPT_GENERAL_RULE,
  TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_GENERAL_RULE,
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_GENERAL_RULE,
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_SCOPE_GENERAL_RULE,
  TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_GENERAL_RULE,
  TECHNIQUE_PROMPT_QIXUE_ATTACK_RATIO_RULE,
  ...TECHNIQUE_PROMPT_CREATIVE_DIRECTION_RULES,
  'skills 必须为数组，长度必须满足 skillCountRange',
  'layers 必须与 maxLayer 一致，按 layer 从小到大给出',
  '生成功法不需要升级材料，layers[*].costMaterials 必须是 []',
  'skill.id 仅作占位，后端会重写；但在本次输出内仍需保持 skills/layers 引用一致',
  '所有枚举字段必须使用给定枚举值，严禁自造枚举（例如 controlType/markId/targetType）',
  'effects 中每个对象必须补齐所属 effect.type 的关键字段',
  `skills[*].effects 与 upgrades[*].changes.effects 最多只能包含 ${TECHNIQUE_SKILL_EFFECT_MAX_COUNT} 个 effect，且不允许完全重复的 effect`,
  'chance 统一使用 0~1 浮点概率（0.1=10%），禁止使用 10/60 这类百分数整数',
  'valueType=combined 时必须同时提供 baseValue 与 scaleRate',
  'valueType=scale 时必须提供 scaleAttr 与 scaleRate',
  `damage/delayed_burst/mark(resultType=damage) 使用倍率时，scaleAttr 禁止为 ${TECHNIQUE_DAMAGE_EFFECT_FORBIDDEN_SCALE_ATTR_OPTIONS.join('/')}`,
  'technique.type 必须等于 techniqueType，禁止自行改成其他功法类型',
  'technique.requiredRealm 必须来自 realmEnum',
  'buff/debuff 必须使用结构化 Buff 字段（buffKind/buffKey/attrKey/applyType），禁止使用 buffId，且 buffKey/attrKey 必须来自 allowedBuffConfigRules',
  'buff 未填写 target 时默认施加给自身；debuff 未填写 target 时默认命中敌方目标；heal/shield/cleanse/cleanse_control/restore_lingqi 与正向 resource 若技能主目标是敌方，则未填 target 时默认作用自身，否则默认跟随技能主目标',
  'mark.markId 必须来自 allowedMarkIds',
  'effects 不支持 valueFormula，严禁返回该字段',
  'skills[*].upgrades 只允许使用 { layer, changes } 结构，不要返回 description/effectChanges/effectIndex',
  'upgrades[*].changes 仅允许 target_count/cooldown/cost_lingqi/cost_lingqi_rate/cost_qixue/cost_qixue_rate/ai_priority/effects/addEffect',
  'value/valueType/baseValue/scaleAttr/scaleRate/duration/chance 等 effect 内字段不得直接放在 upgrades[*].changes 顶层，只能写进 changes.effects[*] 或 changes.addEffect',
  `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
  '如果要调整效果，只能使用 changes.effects 全量替换，或 changes.addEffect 追加',
  '功法类型不会限制被动 key 搭配，layers.passives 可自由从 allowedPassiveKeys 中组合',
  '禁止输出 null/undefined 与空字符串占位；无意义的可选字段直接省略',
  '当 triggerType=passive 时，技能必须为自目标常驻被动：targetType=self、targetCount=1、cooldown=0、costLingqi=0、costLingqiRate=0、costQixue=0、costQixueRate=0',
  'buffKind=aura 时必须提供 auraTarget 和 auraEffects，auraEffects 中每个子效果遵循对应 type 的标准校验规则；子效果不允许嵌套光环，也不允许使用 next_skill_bonus 这类“下一次技能强化”瞬时机制',
  buildTechniqueAuraPolarityPromptRule(),
  'buffKind=aura 的 auraEffects 若包含进攻类百分比 attr 增益（如法攻/物攻/暴击/暴伤/增伤），请参考接近天品强度的建议范围设计总和，不要再按品质拆固定上限，也不要为了凑满范围硬塞数值。',
  'buffKind=aura 的光环效果只能用于 triggerType=passive 的被动技能，costLingqi/costQixue/cooldown 必须为 0，进场自动生效，永久存在',
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
export const TECHNIQUE_PROMPT_EFFECT_TARGET_ENUM = TECHNIQUE_SKILL_EFFECT_TARGET_LIST;

export const TECHNIQUE_PROMPT_CONTROL_TYPE_ENUM = TECHNIQUE_SKILL_CONTROL_TYPE_LIST;

export const TECHNIQUE_PROMPT_MARK_ID_ENUM = TECHNIQUE_SKILL_MARK_ID_LIST;
export const TECHNIQUE_PROMPT_MARK_OPERATION_ENUM = TECHNIQUE_SKILL_MARK_OPERATION_LIST;
export const TECHNIQUE_PROMPT_MARK_CONSUME_MODE_ENUM = TECHNIQUE_SKILL_MARK_CONSUME_MODE_LIST;
export const TECHNIQUE_PROMPT_MARK_RESULT_TYPE_ENUM = TECHNIQUE_SKILL_MARK_RESULT_TYPE_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_ID_ENUM = TECHNIQUE_SKILL_MOMENTUM_ID_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_OPERATION_ENUM = TECHNIQUE_SKILL_MOMENTUM_OPERATION_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_CONSUME_MODE_ENUM = TECHNIQUE_SKILL_MOMENTUM_CONSUME_MODE_LIST;
export const TECHNIQUE_PROMPT_MOMENTUM_BONUS_TYPE_ENUM = TECHNIQUE_SKILL_MOMENTUM_BONUS_TYPE_LIST;
export const TECHNIQUE_PROMPT_FATE_SWAP_MODE_ENUM = TECHNIQUE_SKILL_FATE_SWAP_MODE_LIST;

export const TECHNIQUE_PROMPT_AURA_TARGET_ENUM = TECHNIQUE_SKILL_AURA_TARGET_LIST;
export const TECHNIQUE_PROMPT_AURA_SUB_EFFECT_TYPE_ENUM = TECHNIQUE_SKILL_AURA_SUB_EFFECT_TYPE_LIST;
const TECHNIQUE_AURA_ATTACK_PERCENT_ATTR_KEYS = Object.freeze(Array.from(ATTACK_ATTR_KEY_SET).sort());
export const TECHNIQUE_AURA_ATTACK_PERCENT_SUGGESTED_RANGE = Object.freeze({
  min: 0.10,
  max: 0.25,
});

/**
 * 光环进攻区间提示语生成器
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把会计入光环进攻强度参考区间的 attrKey 集合与“接近天品上限”的建议范围收敛成单一提示语，供首轮 prompt 与 checklist 共用。
 * 2) 不做什么：不负责运行时校验，也不决定哪些属性属于 attack bucket；归类仍以 `ATTACK_ATTR_KEY_SET` 为准。
 *
 * 输入/输出：
 * - 输入：无；统一使用共享建议范围。
 * - 输出：可直接塞进 prompt/generalRules 的中文规则字符串。
 *
 * 数据流/状态流：
 * characterAttrRegistry.attack bucket -> 本函数拼装建议口径 -> 功法生成 prompt / checklist 复用。
 *
 * 关键边界条件与坑点：
 * 1) 这里强调的是“多项相加后的建议总和区间”，不是每个 attrKey 各自都要落在这个区间。
 * 2) 只覆盖正向百分比 attack attr Buff；固定值、防御类、治疗类与其他桶属性不应被误写进这条说明。
 */
export const buildTechniqueAuraAttackPercentSoftRangePromptRule = (): string => {
  return `buffKind=aura 的 auraEffects 中，attrKey 属于 ${TECHNIQUE_AURA_ATTACK_PERCENT_ATTR_KEYS.join('/')} 的正向百分比 buff 可以自由组合；这些 value 的总和建议大致控制在 ${TECHNIQUE_AURA_ATTACK_PERCENT_SUGGESTED_RANGE.min}~${TECHNIQUE_AURA_ATTACK_PERCENT_SUGGESTED_RANGE.max}，这是接近天品上限的参考区间，由你结合覆盖范围、附带代价与机制复杂度自行决定，不要求固定档位。`;
};

export function buildTechniqueAuraPolarityPromptRule(): string {
  return 'buffKind=aura 时，光环外层 type/buffKey 必须与 auraEffects 的实际语义一致，而不是只看 auraTarget：整体为正向常驻效果时使用 type=buff + buff-aura；整体为负向常驻效果时使用 type=debuff + debuff-aura。允许给敌方施加增益光环，也允许给自身/友方施加负面光环，但禁止返回“外层 buff-aura，auraEffects 却全是 debuff/持续伤害/禁疗/减资源等负向效果”这类自相矛盾结构。';
}

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
      aura: {
        required: ['auraTarget', 'auraEffects'],
        optional: [],
        notes: [
          '光环效果：进场自动生效，永久存在直到施法者死亡，不可驱散',
          '光环不需要 duration（运行时强制永久），只能用于 triggerType=passive 的被动技能',
          'auraEffects 子效果也不需要 duration；子效果持续时间由宿主光环统一维持',
          'auraTarget 必须在 auraTargetEnum 中（all_ally/all_enemy/self）',
          'auraEffects 必须是非空数组，长度 ≤ 4',
          '子效果 type 必须在 auraSubEffectTypeEnum 中（damage/heal/buff/debuff/resource/restore_lingqi）',
          '子效果中的 buff/debuff 不允许 buffKind=aura（禁止嵌套），也不允许 buffKind=next_skill_bonus',
        ],
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
    upgradeDamageTotalScaleRate: [0, TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE],
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
    target_count: '直接设置目标数（绝对值，不是增量）；仅 random_enemy/random_ally 允许 > 1，其余 targetType 必须为 1',
    cooldown: '冷却增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cooldown）',
    cost_lingqi: '灵气消耗增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cost_lingqi）',
    cost_lingqi_rate: '灵气比例消耗增量（可正可负，0.1=10%，建议范围见 numericRanges.upgradeDeltaSuggested.cost_lingqi_rate）',
    cost_qixue: '气血消耗增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.cost_qixue）',
    cost_qixue_rate: '气血比例消耗增量（可正可负，0.1=10%，建议范围见 numericRanges.upgradeDeltaSuggested.cost_qixue_rate）',
    ai_priority: 'AI优先级增量（可正可负，建议范围见 numericRanges.upgradeDeltaSuggested.ai_priority）',
    effects: '完整 effects 新数组（整包替换，不支持按索引局部改；若要改 scaleRate/value/duration 等 effect 字段，必须放在这里）',
    addEffect: '追加一个 effect 对象（用于在现有效果末尾新增；effect 内字段也只能放在该对象里）',
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
      {
        layer: 4,
        changes: {
          scaleRate: 1.8,
        },
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
    targetCount: '目标数量（整数，范围见 numericRanges.skill.targetCount）；仅 random_enemy/random_ally 允许 > 1，其余 targetType 必须为 1',
    damageType: '伤害类型 physical/magic/true/null',
    element: '技能元素，必须在 elementEnum 中',
    effects: '技能效果数组，按 effectGuideByType 设计',
    triggerType: '触发类型，active 或 passive；当 effects 含光环（buffKind=aura）时必须为 passive',
    aiPriority: 'AI 施放优先级，范围见 numericRanges.skill.aiPriority，越高越优先',
    upgrades: '高层强化配置数组；可为空数组；必须符合 upgradeGuide',
  },
  layer: {
    layer: '层号，从 1 开始递增，范围见 numericRanges.layer.layer',
    costSpiritStones: '灵石消耗（整数，范围见 numericRanges.layer.costSpiritStones）',
    costExp: '经验消耗（整数，范围见 numericRanges.layer.costExp）',
    costMaterials: '升级材料数组，本系统固定要求 []',
    passives: '本层被动数组，key 必须来自 allowedPassiveKeys，数值必须遵守 passiveValueGuideByKey 的单层与累计预算',
    unlockSkillIds: '本层解锁技能ID数组（引用 skills[*].id）',
    upgradeSkillIds: '本层强化技能ID数组（引用 skills[*].id）；若某技能此前未在 unlockSkillIds 出现，运行时会从本层开始视为已解锁',
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
  target: `效果目标。buff/debuff/heal/shield/cleanse/cleanse_control/restore_lingqi 可选 ${TECHNIQUE_SKILL_EFFECT_TARGET_LIST.join('/')}；resource 仅支持 resourceTargetEnum`,
  momentumId: '势能资源 ID，momentum 效果必填，必须在 momentumIdEnum 中',
  gainStacks: '本次获得的势层数（整数，建议 1~99）',
  bonusType: '消耗势后加成的效果类别，必须在 momentumBonusTypeEnum 中',
  swapMode: '命运交换模式，必须在 fateSwapModeEnum 中',
  auraTarget: '光环作用范围（all_ally/all_enemy/self），buffKind=aura 时必填',
  auraEffects: '光环子效果数组，buffKind=aura 时必填，每个子效果遵循对应 type 的标准校验规则',
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
      `伤害类倍率禁止使用 ${TECHNIQUE_DAMAGE_EFFECT_FORBIDDEN_SCALE_ATTR_OPTIONS.join('/')}，该属性成长过低会导致技能数值失衡偏废`,
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
    optional: ['target', 'valueType', 'value', 'scaleAttr', 'scaleRate'],
    notes: [
      '推荐 valueType=scale，scaleAttr=fagong',
      '若技能主目标是敌方且想治疗自己，可省略 target；若要治疗敌方或友方，必须显式填写 target',
    ],
    defaultTemplate: {
      type: 'heal',
      target: 'self',
      valueType: 'scale',
      scaleAttr: 'fagong',
      scaleRate: 0.8,
    },
  },
  shield: {
    meaning: '护盾效果',
    required: ['type'],
    optional: ['target', 'valueType', 'value', 'scaleAttr', 'scaleRate', 'duration'],
    notes: [
      'duration 建议 1~5 回合',
      '若技能主目标是敌方且想给自己套盾，可省略 target；若要给敌方或友方目标套盾，必须显式填写 target',
    ],
    defaultTemplate: {
      type: 'shield',
      target: 'self',
      valueType: 'scale',
      scaleAttr: 'max_qixue',
      scaleRate: 0.3,
      duration: 2,
    },
  },
  buff: {
    meaning: '增益效果，使用结构化 Buff 配置（可扩展）',
    required: ['type', 'buffKind', 'buffKey'],
    optional: ['target', 'attrKey', 'applyType', 'value', 'valueType', 'scaleAttr', 'scaleRate', 'duration', 'stacks'],
    rules: [
      'buffKind 必须在 allowedBuffConfigRules.kindEnum 中',
      'buffKey 必须在 allowedBuffConfigRules.buffKeyEnumByType.buff 中',
      'target 如有填写，必须在 effectTargetEnum 中；未填写时默认施加给施法者自身',
      'buffKind=attr 时必须提供 attrKey，且 attrKey 必须在 allowedBuffConfigRules.attrKeyEnum 中',
      'applyType 如有填写，必须在 allowedBuffConfigRules.applyTypeEnum 中',
      'duration/stacks 建议为正整数（见 numericRanges.effect.duration / stacks）',
      'buffKind=aura 时必须提供 auraTarget（all_ally/all_enemy/self）和 auraEffects（子效果数组，长度 ≤ 4）',
      'buffKind=aura 时不需要 duration，光环永久存在直到施法者死亡',
      'auraEffects 子效果不需要 duration；光环每回合自动续上子效果',
      'auraEffects 不允许出现 buffKind=next_skill_bonus；下一次技能强化只能作为普通短时 buff 单独存在',
      'buff 类型的 aura 用于表达整体正向的常驻效果；即使 auraTarget=all_enemy，只要子效果整体是增益也允许继续使用 type=buff + buff-aura',
      'auraEffects 若同时给多个进攻类百分比 attr Buff（如法攻/物攻/暴击/暴伤/增伤），请参考 numericRanges.effect.auraAttackPercentSuggestedRange 设计总和，不要再按品质拆固定档位，也不要为了凑满范围硬塞数值',
    ],
    defaultTemplate: {
      type: 'buff',
      target: 'self',
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
    optional: ['target', 'attrKey', 'applyType', 'value', 'valueType', 'scaleAttr', 'scaleRate', 'duration', 'stacks'],
    rules: [
      'buffKind 必须在 allowedBuffConfigRules.kindEnum 中',
      'buffKey 必须在 allowedBuffConfigRules.buffKeyEnumByType.debuff 中',
      'target 如有填写，必须在 effectTargetEnum 中；未填写时默认命中敌方目标',
      'buffKind=attr 时必须提供 attrKey，且 attrKey 必须在 allowedBuffConfigRules.attrKeyEnum 中',
      'applyType 如有填写，必须在 allowedBuffConfigRules.applyTypeEnum 中',
      'buffKind=aura 时必须提供 auraTarget（all_ally/all_enemy/self）和 auraEffects（子效果数组，长度 ≤ 4）',
      'buffKind=aura 时不需要 duration，光环永久存在直到施法者死亡',
      'auraEffects 子效果不需要 duration；光环每回合自动续上子效果',
      'auraEffects 不允许出现 buffKind=next_skill_bonus；下一次技能强化只能作为普通短时 buff 单独存在',
      'debuff 类型的 aura 用于表达整体负向的常驻效果；只要子效果整体是削弱、持续伤害、禁疗、减资源等负向语义，外层就必须保持 type=debuff + debuff-aura，而不是误写成 buff-aura',
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
    optional: ['target'],
    notes: ['value 应为正整数', 'target 如有填写，必须在 effectTargetEnum 中'],
    defaultTemplate: {
      type: 'restore_lingqi',
      target: 'self',
      value: 20,
    },
  },
  cleanse: {
    meaning: '净化 debuff',
    required: ['type'],
    optional: ['target', 'count'],
    notes: ['count 建议 1~99', 'target 如有填写，必须在 effectTargetEnum 中'],
    defaultTemplate: {
      type: 'cleanse',
      target: 'self',
      count: 1,
    },
  },
  cleanse_control: {
    meaning: '仅净化控制类 debuff',
    required: ['type'],
    optional: ['target', 'count'],
    notes: ['count 建议 1~99', 'target 如有填写，必须在 effectTargetEnum 中'],
    defaultTemplate: {
      type: 'cleanse_control',
      target: 'self',
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
      '不同 markId 的战斗语义不同，必须参考 allowedMarkGuideById 设计技能描述与效果搭配',
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
  delayed_burst: {
    meaning: '延迟爆发，在后续回合开始时引爆',
    required: ['type', 'duration'],
    optional: ['valueType', 'value', 'scaleAttr', 'scaleRate', 'damageType', 'element'],
    rules: [
      'duration 必须是正整数，表示还需等待多少次回合开始后引爆',
      'damageType 必须在 damageTypeEnum 中',
      `scaleAttr 禁止使用 ${TECHNIQUE_DAMAGE_EFFECT_FORBIDDEN_SCALE_ATTR_OPTIONS.join('/')}，避免低成长属性生成废技能`,
      '推荐使用 valueType=scale，并显式给出 scaleAttr + scaleRate',
    ],
    defaultTemplate: {
      type: 'delayed_burst',
      duration: 2,
      valueType: 'scale',
      scaleAttr: 'fagong',
      scaleRate: 1.5,
      damageType: 'magic',
      element: 'huo',
    },
  },
  fate_swap: {
    meaning: '命运交换，搬运 debuff / buff / 护盾等状态',
    required: ['type', 'swapMode'],
    optional: ['count', 'value'],
    rules: [
      'swapMode 必须在 fateSwapModeEnum 中',
      'swapMode=shield_steal 时必须提供 value，且使用 0~1 浮点比例',
      '其余模式建议提供 count，表示最多搬运的状态数量',
    ],
    defaultTemplate: {
      type: 'fate_swap',
      swapMode: 'debuff_to_target',
      count: 1,
    },
  },
} as const;

export const TECHNIQUE_PROMPT_OUTPUT_SHAPE = {
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
      effects: 'SkillEffect[]（严格按 effectGuideByType 设计）',
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
  '禁止返回 candidate/data/result/payload 等包裹层',
  'technique.requiredRealm 必须在 realmEnum 中',
  'skills.length 必须命中对应品质的 skillCountRange',
  'layers.length 必须等于 maxLayer，且 layer 从 1 递增到 maxLayer',
  'layers[*].costMaterials 必须是 []',
  '所有 effect.type 必须在 effectTypeEnum 中',
  '任何 effect 不得出现 valueFormula 字段',
  'controlType 必须在 controlTypeEnum；markId 必须在 allowedMarkIds',
  'buff/debuff 必须使用结构化 Buff 字段，不得使用 buffId，且 buffKey/attrKey 必须命中预定义允许列表',
  'skills[*].upgrades 只能使用 upgradeGuide 约定结构，禁止 description/effectChanges/effectIndex',
  'upgrades[*].changes 只能包含 upgradeAllowedChangeKeys 中的字段',
  'scaleRate/value/baseValue/valueType/scaleAttr/duration/chance 等 effect 字段不得直接出现在 upgrades[*].changes 顶层',
  `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}`,
  'chance 必须在 0~1 且使用浮点比例表达',
  '仅 random_enemy/random_ally 允许 targetCount > 1；self/single_*/all_* 的 targetCount 必须为 1',
  'layers.passives[].key 必须来自 allowedPassiveKeys，且 value 必须满足 passiveValueGuideByKey 的单层/累计上限',
  'buffKind=aura 时必须提供 auraTarget 和 auraEffects，子效果不允许嵌套光环，也不允许使用 next_skill_bonus',
  buildTechniqueAuraPolarityPromptRule(),
  'buffKind=aura 若包含多个进攻类百分比 attr Buff，请参考 numericRanges.effect.auraAttackPercentSuggestedRange 设计总和，不要再按品质拆固定上限',
] as const;

export const buildTechniqueGeneratorPromptInput = (params: {
  techniqueType: GeneratedTechniqueType;
  quality: GeneratedTechniqueQuality;
  maxLayer: number;
  effectTypeEnum: readonly string[];
  promptNoiseHash?: string;
  retryGuidance?: {
    previousFailureReason: string;
    correctionRules: string[];
  };
}) => {
  const { techniqueType, quality, maxLayer, effectTypeEnum } = params;
  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[quality];
  const promptBuffConfigRules = buildTechniquePromptBuffConfigRules();
  const passiveValueGuideByKey = buildTechniquePassiveValueGuideByKey(quality);
  const promptNoiseHash = normalizeTextModelPromptNoiseHash(params.promptNoiseHash);
  return {
    task: '生成完整功法定义',
    techniqueType,
    quality,
    maxLayer,
    promptNoiseHash,
    ...(params.retryGuidance
      ? {
        retryGuidance: {
          previousFailureReason: params.retryGuidance.previousFailureReason,
          correctionRules: [...params.retryGuidance.correctionRules],
        },
      }
      : {}),
    constraints: {
      generalRules: [
        ...TECHNIQUE_PROMPT_GENERAL_RULES,
        buildTechniqueAuraAttackPercentSoftRangePromptRule(),
        TEXT_MODEL_PROMPT_NOISE_CONSTRAINT,
      ],
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
      effectTargetEnum: [...TECHNIQUE_PROMPT_EFFECT_TARGET_ENUM],
      dispelTypeEnum: [...TECHNIQUE_PROMPT_DISPEL_TYPE_ENUM],
      allowedMarkIds: [...TECHNIQUE_PROMPT_MARK_ID_ENUM],
      allowedMarkGuideById: MARK_TRAIT_GUIDE_BY_ID,
      markOperationEnum: [...TECHNIQUE_PROMPT_MARK_OPERATION_ENUM],
      markConsumeModeEnum: [...TECHNIQUE_PROMPT_MARK_CONSUME_MODE_ENUM],
      markResultTypeEnum: [...TECHNIQUE_PROMPT_MARK_RESULT_TYPE_ENUM],
      momentumIdEnum: [...TECHNIQUE_PROMPT_MOMENTUM_ID_ENUM],
      momentumOperationEnum: [...TECHNIQUE_PROMPT_MOMENTUM_OPERATION_ENUM],
      momentumConsumeModeEnum: [...TECHNIQUE_PROMPT_MOMENTUM_CONSUME_MODE_ENUM],
      momentumBonusTypeEnum: [...TECHNIQUE_PROMPT_MOMENTUM_BONUS_TYPE_ENUM],
      fateSwapModeEnum: [...TECHNIQUE_PROMPT_FATE_SWAP_MODE_ENUM],
      auraTargetEnum: [...TECHNIQUE_PROMPT_AURA_TARGET_ENUM],
      auraSubEffectTypeEnum: [...TECHNIQUE_PROMPT_AURA_SUB_EFFECT_TYPE_ENUM],
      allowedBuffConfigRules: promptBuffConfigRules,
      attributeKeyEnum: [...TECHNIQUE_EFFECT_SCALE_ATTR_OPTIONS],
      damageForbiddenScaleAttrEnum: [...TECHNIQUE_DAMAGE_EFFECT_FORBIDDEN_SCALE_ATTR_OPTIONS],
      numericRanges: {
        ...TECHNIQUE_PROMPT_NUMERIC_RANGES,
        effect: {
          ...TECHNIQUE_PROMPT_NUMERIC_RANGES.effect,
          auraAttackPercentSuggestedRange: [
            TECHNIQUE_AURA_ATTACK_PERCENT_SUGGESTED_RANGE.min,
            TECHNIQUE_AURA_ATTACK_PERCENT_SUGGESTED_RANGE.max,
          ],
        },
      },
      effectCommonFields: TECHNIQUE_PROMPT_EFFECT_COMMON_FIELDS,
      effectGuideByType: TECHNIQUE_PROMPT_EFFECT_SCHEMA_BY_TYPE,
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
      targetCountRule: '仅 random_enemy/random_ally 允许 targetCount > 1；self/single_*/all_* 的 targetCount 必须为 1',
      upgradeAllowedChangeKeys: [...TECHNIQUE_PROMPT_UPGRADE_ALLOWED_CHANGE_KEYS],
      upgradeUnsupportedFields: [...TECHNIQUE_PROMPT_UPGRADE_UNSUPPORTED_FIELDS],
      upgradeGuide: TECHNIQUE_PROMPT_UPGRADE_SCHEMA,
      upgradeRule:
        `upgrades 每项必须是 {layer,changes}。changes 只允许 target_count/cooldown/cost_lingqi/cost_lingqi_rate/cost_qixue/cost_qixue_rate/ai_priority/effects/addEffect。严禁 effectChanges/effectIndex/description，也严禁把 scaleRate/value/baseValue/valueType/scaleAttr/duration/chance 这类 effect 字段直接写在 changes 顶层。若 changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则升级后的总倍率（scaleRate × hit_count）不能大于 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}。`,
      outputChecklist: [
        ...TECHNIQUE_PROMPT_OUTPUT_CHECKLIST,
        buildTechniqueAuraAttackPercentSoftRangePromptRule(),
      ],
    },
    outputShape: TECHNIQUE_PROMPT_OUTPUT_SHAPE,
  };
};

export {
  validateTechniqueSkillEffect,
  validateTechniqueSkillTargetCount,
  validateTechniqueSkillUpgrade,
  validateTechniqueStructuredBuffEffect,
};

export const isSupportedTechniquePassiveKey = (raw: unknown): boolean => {
  if (typeof raw !== 'string') return false;
  const key = raw.trim();
  if (!key) return false;
  return SUPPORTED_TECHNIQUE_PASSIVE_KEY_SET.has(key);
};

/**
 * 构建功法生成 response_format
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一返回 `json_object`，让模型把注意力放在数值与机制设计，而不是 strict schema 占位。
 * 2) 不做什么：不替代运行时技能校验；effect/upgrades 的合法性仍以后端 validate 为准。
 *
 * 输入/输出：
 * - 输入：功法品质、功法类型、最大层数。
 * - 输出：`TechniqueTextModelResponseFormat`，可直接传入 `callConfiguredTextModel`。
 *
 * 关键边界条件与坑点：
 * 1) 功法生成链已经有 sanitize/validate/retry，结构问题不需要再靠 strict schema 重复兜一层。
 * 2) 这里只调整功法生成；伙伴招募等其他链路仍可继续使用 json_schema。
 */
export const buildTechniqueGenerationResponseFormat = (_params: {
  techniqueType: GeneratedTechniqueType;
  quality: GeneratedTechniqueQuality;
  maxLayer: number;
}): TechniqueTextModelResponseFormat => ({ type: 'json_object' });
