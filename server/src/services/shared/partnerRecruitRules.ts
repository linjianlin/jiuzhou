/**
 * AI 伙伴招募共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中定义招募成本、冷却、预览保留时长、品质权重、属性约束与草稿校验规则。
 * 2) 做什么：统一把模型输出约束在稳定范围内，并收敛开发环境冷却绕过规则，避免 service、worker、前端各自散落一份业务规则。
 * 3) 不做什么：不访问数据库、不执行扣费、不负责图片生成或任务调度。
 *
 * 输入/输出：
 * - 输入：模型返回草稿、最近一次冷却起点、当前时间、可选运行环境覆盖。
 * - 输出：合法化后的伙伴草稿、冷却状态、格式化剩余时间等。
 *
 * 数据流/状态流：
 * 文本模型 -> validatePartnerRecruitDraft -> partnerRecruitService 落库/预览；
 * 历史任务时间 -> buildPartnerRecruitCooldownState -> 状态接口 / 创建任务拦截 / 前端倒计时。
 *
 * 关键边界条件与坑点：
 * 1) 草稿校验不允许偷偷兜底成“低质量占位伙伴”，任一关键字段非法都应直接失败退款。
 * 2) 冷却判断与状态接口必须共用同一套纯函数，否则前端倒计时与服务端拦截会在临界秒不一致。
 */
import {
  getPartnerDefinitionById,
  type PartnerBaseAttrConfig,
} from '../staticConfigLoader.js';
import {
  buildTechniqueTextModelJsonSchemaResponseFormat,
  type TechniqueTextModelJsonSchema,
  type TechniqueTextModelJsonSchemaObject,
  type TechniqueTextModelJsonSchemaProperties,
  type TechniqueTextModelResponseFormat,
} from './techniqueTextModelShared.js';
import {
  PARTNER_INTEGER_ATTR_KEYS,
} from './partnerRules.js';
import {
  getTechniquePassiveValueConstraint,
  type TechniquePassiveValueConstraint,
} from './techniqueGenerationConstraints.js';

export type PartnerRecruitQuality = '黄' | '玄' | '地' | '天';
export type PartnerRecruitElement = 'jin' | 'mu' | 'shui' | 'huo' | 'tu' | 'none';
export type PartnerRecruitCombatStyle = 'physical' | 'magic';
export type PartnerRecruitTechniqueKind = 'attack' | 'support' | 'guard';
export type PartnerRecruitPassiveKey =
  | 'max_qixue'
  | 'wugong'
  | 'fagong'
  | 'wufang'
  | 'fafang'
  | 'sudu'
  | 'zengshang'
  | 'zhiliao';

export type PartnerRecruitBaseAttrs = {
  [Key in keyof Required<PartnerBaseAttrConfig>]: number;
};

export type PartnerRecruitDraft = {
  partner: {
    name: string;
    description: string;
    quality: PartnerRecruitQuality;
    attributeElement: PartnerRecruitElement;
    role: string;
    combatStyle: PartnerRecruitCombatStyle;
    maxTechniqueSlots: number;
    baseAttrs: PartnerRecruitBaseAttrs;
    levelAttrGains: PartnerRecruitBaseAttrs;
  };
  innateTechniques: Array<{
    name: string;
    description: string;
    kind: PartnerRecruitTechniqueKind;
    passiveKey: PartnerRecruitPassiveKey;
    passiveValue: number;
  }>;
};

type TextLengthRange = {
  min: number;
  max: number;
};

const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

const PARTNER_RECRUIT_TEXT_LENGTH_LIMITS = {
  partnerName: { min: 2, max: 6 },
  partnerDescription: { min: 35, max: 90 },
  partnerRole: { min: 2, max: 6 },
  techniqueName: { min: 2, max: 6 },
  techniqueDescription: { min: 18, max: 60 },
} as const satisfies Record<string, TextLengthRange>;

export const PARTNER_RECRUIT_SPIRIT_STONES_COST = 50_000;
export const PARTNER_RECRUIT_COOLDOWN_HOURS = 12;
export const PARTNER_RECRUIT_PREVIEW_EXPIRE_HOURS = 24;
export const PARTNER_RECRUIT_ALLOWED_ELEMENTS: readonly PartnerRecruitElement[] = ['jin', 'mu', 'shui', 'huo', 'tu', 'none'] as const;
export const PARTNER_RECRUIT_ALLOWED_COMBAT_STYLES: readonly PartnerRecruitCombatStyle[] = ['physical', 'magic'] as const;
export const PARTNER_RECRUIT_ALLOWED_TECHNIQUE_KINDS: readonly PartnerRecruitTechniqueKind[] = ['attack', 'support', 'guard'] as const;
export const PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS: readonly PartnerRecruitPassiveKey[] = [
  'max_qixue',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
  'zengshang',
  'zhiliao',
] as const;

export const PARTNER_RECRUIT_BASE_ATTR_KEYS = [
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
] as const satisfies ReadonlyArray<keyof PartnerRecruitBaseAttrs>;

const PARTNER_RECRUIT_STRICT_POSITIVE_ATTR_KEYS = new Set<keyof PartnerRecruitBaseAttrs>([
  'max_qixue',
  'sudu',
]);

const PARTNER_RECRUIT_TOP_LEVEL_REQUIRED_KEYS = ['partner', 'innateTechniques'] as const;
const PARTNER_RECRUIT_PARTNER_REQUIRED_KEYS = [
  'name',
  'description',
  'quality',
  'attributeElement',
  'role',
  'combatStyle',
  'maxTechniqueSlots',
  'baseAttrs',
  'levelAttrGains',
] as const;
const PARTNER_RECRUIT_INNATE_TECHNIQUE_REQUIRED_KEYS = [
  'name',
  'description',
  'kind',
  'passiveKey',
  'passiveValue',
] as const;
const PARTNER_RECRUIT_FORBIDDEN_ALIAS_KEYS = ['element', 'slots', 'techniques'] as const;
const PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT = 1;
const PARTNER_RECRUIT_QUALITY_SCHEMA_NAME_SEGMENT: Record<PartnerRecruitQuality, string> = {
  黄: 'huang',
  玄: 'xuan',
  地: 'di',
  天: 'tian',
};

const getPartnerRecruitPassiveValueConstraint = (
  key: PartnerRecruitPassiveKey,
  quality: PartnerRecruitQuality,
): TechniquePassiveValueConstraint | null => {
  return getTechniquePassiveValueConstraint(key, quality);
};

const buildPartnerRecruitPassiveValueGuideByKey = (
  quality: PartnerRecruitQuality,
): Record<PartnerRecruitPassiveKey, TechniquePassiveValueConstraint> => {
  return PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS.reduce<Record<PartnerRecruitPassiveKey, TechniquePassiveValueConstraint>>((accumulator, key) => {
    const constraint = getPartnerRecruitPassiveValueConstraint(key, quality);
    if (constraint) {
      accumulator[key] = constraint;
    }
    return accumulator;
  }, {} as Record<PartnerRecruitPassiveKey, TechniquePassiveValueConstraint>);
};

const getPartnerRecruitPassiveValueMaxTotalUpperBound = (
  quality: PartnerRecruitQuality,
): number => {
  return PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS.reduce((maxValue, key) => {
    const constraint = getPartnerRecruitPassiveValueConstraint(key, quality);
    return constraint ? Math.max(maxValue, constraint.maxTotal) : maxValue;
  }, 0);
};

const QUALITY_ROLL_TABLE: ReadonlyArray<{ quality: PartnerRecruitQuality; weight: number }> = [
  { quality: '黄', weight: 55 },
  { quality: '玄', weight: 28 },
  { quality: '地', weight: 12 },
  { quality: '天', weight: 5 },
];

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asInt = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};

const asFiniteNumber = (raw: unknown): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
};

const isPartnerRecruitQuality = (raw: unknown): raw is PartnerRecruitQuality => {
  return raw === '黄' || raw === '玄' || raw === '地' || raw === '天';
};

const isPartnerRecruitElement = (raw: unknown): raw is PartnerRecruitElement => {
  return PARTNER_RECRUIT_ALLOWED_ELEMENTS.includes(raw as PartnerRecruitElement);
};

const isPartnerRecruitCombatStyle = (raw: unknown): raw is PartnerRecruitCombatStyle => {
  return PARTNER_RECRUIT_ALLOWED_COMBAT_STYLES.includes(raw as PartnerRecruitCombatStyle);
};

const isPartnerRecruitTechniqueKind = (raw: unknown): raw is PartnerRecruitTechniqueKind => {
  return PARTNER_RECRUIT_ALLOWED_TECHNIQUE_KINDS.includes(raw as PartnerRecruitTechniqueKind);
};

const isPartnerRecruitPassiveKey = (raw: unknown): raw is PartnerRecruitPassiveKey => {
  return PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS.includes(raw as PartnerRecruitPassiveKey);
};

const createEmptyPartnerRecruitBaseAttrs = (): PartnerRecruitBaseAttrs => ({
  max_qixue: 0,
  max_lingqi: 0,
  wugong: 0,
  fagong: 0,
  wufang: 0,
  fafang: 0,
  sudu: 0,
  mingzhong: 0,
  shanbi: 0,
  zhaojia: 0,
  baoji: 0,
  baoshang: 0,
  jianbaoshang: 0,
  kangbao: 0,
  zengshang: 0,
  zhiliao: 0,
  jianliao: 0,
  xixue: 0,
  lengque: 0,
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
});

const normalizeStrictBaseAttrValue = (
  row: Record<string, unknown>,
  key: keyof PartnerRecruitBaseAttrs,
  params: {
    attrSource: 'baseAttrs' | 'levelAttrGains';
    requirePositiveCoreAttrs: boolean;
  },
): number | null => {
  if (!(key in row)) return null;
  const value = asFiniteNumber(row[key]);
  if (!Number.isFinite(value) || value < 0) return null;
  const shouldRequireInteger = params.attrSource === 'baseAttrs' && PARTNER_INTEGER_ATTR_KEYS.has(key);
  if (shouldRequireInteger && !Number.isInteger(value)) {
    return null;
  }
  if (params.requirePositiveCoreAttrs && PARTNER_RECRUIT_STRICT_POSITIVE_ATTR_KEYS.has(key) && value <= 0) {
    return null;
  }
  return value;
};

export const fillPartnerRecruitBaseAttrs = (
  raw: Partial<PartnerBaseAttrConfig> | null | undefined,
): PartnerRecruitBaseAttrs => {
  const baseAttrs = createEmptyPartnerRecruitBaseAttrs();
  if (!raw) return baseAttrs;
  for (const key of PARTNER_RECRUIT_BASE_ATTR_KEYS) {
    const value = asFiniteNumber(raw[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    baseAttrs[key] = value;
  }
  return baseAttrs;
};

const normalizeBaseAttrs = (
  raw: unknown,
  params: {
    attrSource: 'baseAttrs' | 'levelAttrGains';
    requirePositiveCoreAttrs: boolean;
  },
): PartnerRecruitBaseAttrs | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const baseAttrs = createEmptyPartnerRecruitBaseAttrs();
  for (const key of PARTNER_RECRUIT_BASE_ATTR_KEYS) {
    const value = normalizeStrictBaseAttrValue(row, key, params);
    if (value === null) return null;
    baseAttrs[key] = value;
  }
  return baseAttrs;
};

const validateBaseAttrs = (
  attrs: PartnerRecruitBaseAttrs,
  params: {
    attrSource: 'baseAttrs' | 'levelAttrGains';
    requirePositiveCoreAttrs: boolean;
  },
): boolean => {
  return PARTNER_RECRUIT_BASE_ATTR_KEYS.every((key) => {
    const value = attrs[key];
    if (!Number.isFinite(value) || value < 0) return false;
    const shouldRequireInteger = params.attrSource === 'baseAttrs' && PARTNER_INTEGER_ATTR_KEYS.has(key);
    if (shouldRequireInteger && !Number.isInteger(value)) {
      return false;
    }
    if (params.requirePositiveCoreAttrs && PARTNER_RECRUIT_STRICT_POSITIVE_ATTR_KEYS.has(key) && value <= 0) {
      return false;
    }
    return true;
  });
};

const isTextLengthInRange = (value: string, range: TextLengthRange): boolean => {
  return value.length >= range.min && value.length <= range.max;
};

const buildPartnerRecruitNumberSchema = (
  type: 'integer' | 'number',
  params: {
    maximum?: number;
    minimum?: number;
    exclusiveMinimum?: number;
  },
): TechniqueTextModelJsonSchema => {
  return {
    type,
    ...(params.maximum === undefined ? {} : { maximum: params.maximum }),
    ...(params.minimum === undefined ? {} : { minimum: params.minimum }),
    ...(params.exclusiveMinimum === undefined ? {} : { exclusiveMinimum: params.exclusiveMinimum }),
  };
};

const buildPartnerRecruitAttrJsonSchema = (
  key: keyof PartnerRecruitBaseAttrs,
  params: {
    attrSource: 'baseAttrs' | 'levelAttrGains';
    requirePositiveCoreAttrs: boolean;
  },
): TechniqueTextModelJsonSchema => {
  const minimum = params.requirePositiveCoreAttrs && PARTNER_RECRUIT_STRICT_POSITIVE_ATTR_KEYS.has(key) ? 1 : 0;
  const useIntegerSchema = params.attrSource === 'baseAttrs' && PARTNER_INTEGER_ATTR_KEYS.has(key);
  if (useIntegerSchema) {
    return buildPartnerRecruitNumberSchema('integer', { minimum });
  }
  return buildPartnerRecruitNumberSchema('number', { minimum });
};

const buildPartnerRecruitBaseAttrsJsonSchema = (
  params: {
    attrSource: 'baseAttrs' | 'levelAttrGains';
    requirePositiveCoreAttrs: boolean;
  },
): TechniqueTextModelJsonSchemaObject => {
  const properties = Object.fromEntries(
    PARTNER_RECRUIT_BASE_ATTR_KEYS.map((key) => [
      key,
      buildPartnerRecruitAttrJsonSchema(key, params),
    ]),
  ) as TechniqueTextModelJsonSchemaProperties;

  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: [...PARTNER_RECRUIT_BASE_ATTR_KEYS],
  };
};

export const buildPartnerRecruitResponseFormat = (
  quality: PartnerRecruitQuality,
): TechniqueTextModelResponseFormat => {
  const passiveValueMaxTotalUpperBound = getPartnerRecruitPassiveValueMaxTotalUpperBound(quality);
  return buildTechniqueTextModelJsonSchemaResponseFormat({
    name: `partner_recruit_draft_${PARTNER_RECRUIT_QUALITY_SCHEMA_NAME_SEGMENT[quality]}`,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [...PARTNER_RECRUIT_TOP_LEVEL_REQUIRED_KEYS],
      properties: {
        partner: {
          type: 'object',
          additionalProperties: false,
          required: [...PARTNER_RECRUIT_PARTNER_REQUIRED_KEYS],
          properties: {
            name: {
              type: 'string',
              minLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerName.min,
              maxLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerName.max,
            },
            description: {
              type: 'string',
              minLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerDescription.min,
              maxLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerDescription.max,
            },
            quality: {
              type: 'string',
              enum: [quality],
            },
            attributeElement: {
              type: 'string',
              enum: [...PARTNER_RECRUIT_ALLOWED_ELEMENTS],
            },
            role: {
              type: 'string',
              minLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerRole.min,
              maxLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerRole.max,
            },
            combatStyle: {
              type: 'string',
              enum: [...PARTNER_RECRUIT_ALLOWED_COMBAT_STYLES],
            },
            maxTechniqueSlots: {
              type: 'integer',
              minimum: 1,
            },
            baseAttrs: buildPartnerRecruitBaseAttrsJsonSchema({
              attrSource: 'baseAttrs',
              requirePositiveCoreAttrs: true,
            }),
            levelAttrGains: buildPartnerRecruitBaseAttrsJsonSchema({
              attrSource: 'levelAttrGains',
              requirePositiveCoreAttrs: false,
            }),
          },
        },
        innateTechniques: {
          type: 'array',
          minItems: PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT,
          maxItems: PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [...PARTNER_RECRUIT_INNATE_TECHNIQUE_REQUIRED_KEYS],
            properties: {
              name: {
                type: 'string',
                minLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueName.min,
                maxLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueName.max,
              },
              description: {
                type: 'string',
                minLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueDescription.min,
                maxLength: PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueDescription.max,
              },
              kind: {
                type: 'string',
                enum: [...PARTNER_RECRUIT_ALLOWED_TECHNIQUE_KINDS],
              },
              passiveKey: {
                type: 'string',
                enum: [...PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS],
              },
              passiveValue: buildPartnerRecruitNumberSchema('number', {
                exclusiveMinimum: 0,
                maximum: passiveValueMaxTotalUpperBound,
              }),
            },
          },
        },
      },
    },
  });
};

export const resolvePartnerRecruitQualityByWeight = (): PartnerRecruitQuality => {
  const totalWeight = QUALITY_ROLL_TABLE.reduce((sum, entry) => sum + entry.weight, 0);
  let rolled = Math.random() * totalWeight;
  for (const entry of QUALITY_ROLL_TABLE) {
    rolled -= entry.weight;
    if (rolled <= 0) return entry.quality;
  }
  return '黄';
};

export const getPartnerRecruitTechniqueMaxLayer = (
  quality: PartnerRecruitQuality,
): number => {
  if (quality === '黄') return 3;
  if (quality === '玄') return 4;
  if (quality === '地') return 5;
  return 6;
};

const PARTNER_RECRUIT_REFERENCE_PARTNER_ID = 'partner-qingmu-xiaoou';

const buildPartnerRecruitReferenceExample = (): Record<string, unknown> | null => {
  const definition = getPartnerDefinitionById(PARTNER_RECRUIT_REFERENCE_PARTNER_ID);
  if (!definition) return null;
  return {
    partner: {
      name: definition.name,
      description: definition.description ?? '',
      quality: definition.quality ?? '黄',
      attributeElement: definition.attribute_element ?? 'none',
      role: definition.role ?? '伙伴',
      combatStyle: 'physical',
      maxTechniqueSlots: Math.max(1, Number(definition.max_technique_slots) || 1),
      baseAttrs: fillPartnerRecruitBaseAttrs(definition.base_attrs),
      levelAttrGains: fillPartnerRecruitBaseAttrs(definition.level_attr_gains),
    },
    innateTechniqueIds: [...definition.innate_technique_ids],
  };
};

export const buildPartnerRecruitPromptInput = (quality: PartnerRecruitQuality): Record<string, unknown> => {
  const percentAttrKeys = PARTNER_RECRUIT_BASE_ATTR_KEYS.filter((key) => !PARTNER_INTEGER_ATTR_KEYS.has(key));
  const passiveValueGuideByKey = buildPartnerRecruitPassiveValueGuideByKey(quality);
  const referencePartnerExample = buildPartnerRecruitReferenceExample();
  return {
    worldview: '中国仙侠世界《九州修仙录》',
    quality,
    allowedElements: [...PARTNER_RECRUIT_ALLOWED_ELEMENTS],
    allowedCombatStyles: [...PARTNER_RECRUIT_ALLOWED_COMBAT_STYLES],
    allowedTechniqueKinds: [...PARTNER_RECRUIT_ALLOWED_TECHNIQUE_KINDS],
    allowedPassiveKeys: [...PARTNER_RECRUIT_ALLOWED_PASSIVE_KEYS],
    techniqueCount: PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT,
    techniqueMaxLayer: getPartnerRecruitTechniqueMaxLayer(quality),
    requiredTopLevelKeys: [...PARTNER_RECRUIT_TOP_LEVEL_REQUIRED_KEYS],
    partnerRequiredKeys: [...PARTNER_RECRUIT_PARTNER_REQUIRED_KEYS],
    innateTechniqueRequiredKeys: [...PARTNER_RECRUIT_INNATE_TECHNIQUE_REQUIRED_KEYS],
    forbiddenAliasKeys: [...PARTNER_RECRUIT_FORBIDDEN_ALIAS_KEYS],
    requiredAttrKeys: [...PARTNER_RECRUIT_BASE_ATTR_KEYS],
    integerAttrKeys: [...PARTNER_INTEGER_ATTR_KEYS],
    percentAttrKeys,
    referencePartnerExample,
    passiveValueGuideByKey,
    constraints: [
      '必须返回严格 JSON 对象，禁止额外解释文本',
      '顶层字段必须且只能使用 requiredTopLevelKeys，禁止使用 forbiddenAliasKeys 中的别名字段',
      `伙伴名字 ${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerName.min}-${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerName.max} 个中文字符，不得包含标点或空格`,
      `伙伴描述 ${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerDescription.min}-${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerDescription.max} 个中文字符`,
      `伙伴角色 role 为自由发挥的中文职业称谓，长度 ${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerRole.min}-${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerRole.max} 个中文字符`,
      'partner.combatStyle 必须严格从 allowedCombatStyles 中选择，用于决定攻击型天生功法走武技还是法诀；physical 表示偏武道，magic 表示偏术法',
      `每个天生功法名字 ${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueName.min}-${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueName.max} 个中文字符，描述 ${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueDescription.min}-${PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueDescription.max} 个中文字符`,
      `innateTechniques 必须且只能生成 ${PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT} 门天生功法，禁止多生成`,
      'partner 必须完整包含 partnerRequiredKeys；每个 innateTechniques 项必须完整包含 innateTechniqueRequiredKeys',
      'partner.baseAttrs 与 partner.levelAttrGains 必须完整包含 requiredAttrKeys 中的全部字段，禁止缺项',
      '每个天生功法 passiveValue 必须 > 0，且不得超过 passiveValueGuideByKey[passiveKey].maxTotal；百分比继续使用小数表示，例如 0.18 表示 18%',
      'partner.baseAttrs 中 integerAttrKeys 的属性必须使用非负整数；partner.levelAttrGains 的全部属性都使用非负数字，允许按参考模板写小数成长',
      'percentAttrKeys 中的属性必须使用非负数字，小数表示百分比，例如 0.18 表示 18%',
      '品质高低顺序固定为 黄 < 玄 < 地 < 天；referencePartnerExample 中青木小偶的 quality=黄，表示它是最低品质参考模板，最终强度与风格仍必须以当前 quality 字段为准',
      'referencePartnerExample 是现有伙伴模板示例，只用于参考数值量级、字段完整度与成长写法，禁止照抄名字、描述或功法列表',
    ],
  };
};

export const validatePartnerRecruitDraft = (
  raw: unknown,
): PartnerRecruitDraft | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const partnerRaw = data.partner;
  if (!partnerRaw || typeof partnerRaw !== 'object' || Array.isArray(partnerRaw)) return null;
  const partner = partnerRaw as Record<string, unknown>;
  const quality = partner.quality;
  const attributeElement = partner.attributeElement;
  const role = asString(partner.role);
  const combatStyle = partner.combatStyle;
  if (!isPartnerRecruitQuality(quality) || !isPartnerRecruitElement(attributeElement) || !isPartnerRecruitCombatStyle(combatStyle)) {
    return null;
  }

  const name = asString(partner.name);
  const description = asString(partner.description);
  if (
    !isTextLengthInRange(name, PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerName) ||
    !isTextLengthInRange(description, PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerDescription) ||
    !isTextLengthInRange(role, PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.partnerRole)
  ) {
    return null;
  }

  const baseAttrs = normalizeBaseAttrs(partner.baseAttrs, {
    attrSource: 'baseAttrs',
    requirePositiveCoreAttrs: true,
  });
  const levelAttrGains = normalizeBaseAttrs(partner.levelAttrGains, {
    attrSource: 'levelAttrGains',
    requirePositiveCoreAttrs: false,
  });
  if (!baseAttrs || !levelAttrGains) return null;

  const maxTechniqueSlots = asInt(partner.maxTechniqueSlots);
  if (!validateBaseAttrs(baseAttrs, {
    attrSource: 'baseAttrs',
    requirePositiveCoreAttrs: true,
  }) || !validateBaseAttrs(levelAttrGains, {
    attrSource: 'levelAttrGains',
    requirePositiveCoreAttrs: false,
  })) {
    return null;
  }
  if (!Number.isInteger(maxTechniqueSlots) || maxTechniqueSlots < 1) {
    return null;
  }

  const innateTechniquesRaw = Array.isArray(data.innateTechniques) ? data.innateTechniques : null;
  if (!innateTechniquesRaw) return null;
  if (innateTechniquesRaw.length !== PARTNER_RECRUIT_INNATE_TECHNIQUE_COUNT) {
    return null;
  }

  const innateTechniques = innateTechniquesRaw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const techniqueName = asString(row.name);
    const techniqueDescription = asString(row.description);
    const kind = row.kind;
    const passiveKey = row.passiveKey;
    const passiveValue = asFiniteNumber(row.passiveValue);
    const passiveConstraint = isPartnerRecruitPassiveKey(passiveKey)
      ? getPartnerRecruitPassiveValueConstraint(passiveKey, quality)
      : null;
    if (
      !isTextLengthInRange(techniqueName, PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueName) ||
      !isTextLengthInRange(techniqueDescription, PARTNER_RECRUIT_TEXT_LENGTH_LIMITS.techniqueDescription) ||
      !isPartnerRecruitTechniqueKind(kind) ||
      !isPartnerRecruitPassiveKey(passiveKey) ||
      !passiveConstraint ||
      !Number.isFinite(passiveValue) ||
      passiveValue <= 0 ||
      passiveValue > passiveConstraint.maxTotal
    ) {
      return [];
    }
    return [{
      name: techniqueName,
      description: techniqueDescription,
      kind,
      passiveKey,
      passiveValue,
    }];
  });

  if (innateTechniques.length !== innateTechniquesRaw.length) return null;
  if (maxTechniqueSlots < innateTechniques.length) return null;

  return {
    partner: {
      name,
      description,
      quality,
      attributeElement,
      role,
      combatStyle,
      maxTechniqueSlots,
      baseAttrs,
      levelAttrGains,
    },
    innateTechniques,
  };
};

export type PartnerRecruitCooldownState = {
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  isCoolingDown: boolean;
};

type PartnerRecruitCooldownOptions = {
  bypassCooldown?: boolean;
};

/**
 * 复用点：
 * - 当前由 `buildPartnerRecruitCooldownState` 默认消费，统一让状态接口与创建任务校验共享同一环境口径。
 * - 纯函数测试可通过 `bypassCooldown` 显式覆盖，避免测试直接改全局环境变量。
 *
 * 设计原因：
 * - 项目本地开发默认不是 production，因此这里沿用仓库既有“非 production 视为开发态”的约定。
 * - 将环境判断收敛在共享规则后，服务层只消费冷却状态，避免重复实现“开发环境 0 冷却”。
 */
export const shouldBypassPartnerRecruitCooldown = (
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean => {
  return nodeEnv !== 'production';
};

const buildIdleCooldownState = (
  cooldownHours: number,
): PartnerRecruitCooldownState => ({
  cooldownHours,
  cooldownUntil: null,
  cooldownRemainingSeconds: 0,
  isCoolingDown: false,
});

export const buildPartnerRecruitCooldownState = (
  latestStartedAt: string | null,
  now: Date = new Date(),
  options: PartnerRecruitCooldownOptions = {},
): PartnerRecruitCooldownState => {
  const bypassCooldown = options.bypassCooldown ?? shouldBypassPartnerRecruitCooldown();
  const cooldownHours = bypassCooldown ? 0 : PARTNER_RECRUIT_COOLDOWN_HOURS;
  if (bypassCooldown) {
    return buildIdleCooldownState(cooldownHours);
  }
  const startedAtMs = latestStartedAt ? new Date(latestStartedAt).getTime() : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return buildIdleCooldownState(cooldownHours);
  const cooldownUntilMs = startedAtMs + cooldownHours * HOUR_SECONDS * SECOND_MS;
  const remainingSeconds = Math.max(0, Math.ceil((cooldownUntilMs - now.getTime()) / SECOND_MS));
  return {
    cooldownHours,
    cooldownUntil: new Date(cooldownUntilMs).toISOString(),
    cooldownRemainingSeconds: remainingSeconds,
    isCoolingDown: remainingSeconds > 0,
  };
};

export const buildPartnerRecruitPreviewExpireAt = (finishedAtIso: string | null): string | null => {
  if (!finishedAtIso) return null;
  const finishedAtMs = new Date(finishedAtIso).getTime();
  if (!Number.isFinite(finishedAtMs)) return null;
  return new Date(finishedAtMs + PARTNER_RECRUIT_PREVIEW_EXPIRE_HOURS * HOUR_SECONDS * SECOND_MS).toISOString();
};

export const isPartnerRecruitPreviewExpired = (
  finishedAtIso: string | null,
  now: Date = new Date(),
): boolean => {
  const expireAt = buildPartnerRecruitPreviewExpireAt(finishedAtIso);
  if (!expireAt) return false;
  return new Date(expireAt).getTime() <= now.getTime();
};

export const formatPartnerRecruitCooldownRemaining = (cooldownRemainingSeconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(cooldownRemainingSeconds));
  if (safeSeconds >= DAY_SECONDS) {
    const days = Math.floor(safeSeconds / DAY_SECONDS);
    const hours = Math.floor((safeSeconds % DAY_SECONDS) / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${days}天${hours}小时${minutes}分`;
    if (hours > 0) return `${days}天${hours}小时`;
    return `${days}天`;
  }
  if (safeSeconds >= HOUR_SECONDS) {
    const hours = Math.floor(safeSeconds / HOUR_SECONDS);
    const minutes = Math.floor((safeSeconds % HOUR_SECONDS) / MINUTE_SECONDS);
    if (minutes > 0) return `${hours}小时${minutes}分`;
    return `${hours}小时`;
  }
  if (safeSeconds >= MINUTE_SECONDS) {
    const minutes = Math.floor(safeSeconds / MINUTE_SECONDS);
    const seconds = safeSeconds % MINUTE_SECONDS;
    if (seconds > 0) return `${minutes}分${seconds}秒`;
    return `${minutes}分`;
  }
  return `${safeSeconds}秒`;
};
