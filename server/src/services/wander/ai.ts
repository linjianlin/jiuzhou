/**
 * 云游奇遇 AI 编排模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把云游奇遇拆成“生成待选幕次”和“玩家选择后结算”两段 AI 输出，避免终幕尾声与称号在玩家尚未抉择前被提前写死。
 * 2. 做什么：统一维护两段式 prompt、JSON schema 与业务校验，避免 service 层散落约束。
 * 3. 不做什么：不写数据库，不决定冷却与总幕数，也不直接发放正式称号。
 *
 * 输入 / 输出：
 * - 输入：玩家上下文、故事上下文、历史幕次，以及当前幕次或玩家选择。
 * - 输出：校验通过的“幕次草稿”或“选择结算草稿”。
 *
 * 数据流 / 状态流：
 * - 生成阶段：wanderService -> 本模块 -> 返回 storyTheme/storyPremise/opening/options -> service 落库待选幕次
 * - 结算阶段：wanderService -> 本模块 -> 返回 summary/endingType/称号字段 -> service 落库并在终幕发放称号
 *
 * 关键边界条件与坑点：
 * 1. 生成阶段禁止提前写尾声、结局与称号；否则玩家的最终选择会失去因果感。
 * 2. 结算阶段必须严格复用服务端的终幕判定；模型只能补写结果，不能擅自把普通幕改成结局或反之。
 */
import { callConfiguredTextModel } from '../ai/openAITextClient.js';
import { readTextModelConfig } from '../ai/modelConfig.js';
import {
  CHARACTER_ATTR_LABEL_MAP,
  CHARACTER_RATIO_ATTR_KEY_SET,
  TITLE_EFFECT_KEYS,
  TITLE_EFFECT_VALUE_MAX_MAP,
  type TitleEffectKey,
} from '../shared/characterAttrRegistry.js';
import {
  buildTechniqueTextModelJsonSchemaResponseFormat,
  buildTextModelPromptNoiseHash,
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
  type TechniqueModelJsonObject,
  type TechniqueTextModelJsonSchema,
  type TechniqueTextModelJsonSchemaObject,
  type TechniqueTextModelJsonSchemaProperties,
  type TechniqueTextModelResponseFormat,
} from '../shared/techniqueTextModelShared.js';
import type {
  WanderAiEpisodeResolutionDraft,
  WanderAiEpisodeSetupDraft,
  WanderEndingType,
} from './types.js';
import type { WanderStoryLocation } from './location.js';

type WanderAiJsonValue =
  | string
  | number
  | boolean
  | null
  | TechniqueModelJsonObject
  | WanderAiJsonValue[];

export interface WanderAiPreviousEpisodeContext {
  dayIndex: number;
  locationName: string;
  title: string;
  opening: string;
  chosenOptionText: string;
  summary: string;
  isEnding: boolean;
}

export interface WanderAiEpisodeSetupInput {
  nickname: string;
  realm: string;
  hasTeam: boolean;
  storyLocation: WanderStoryLocation;
  activeTheme: string | null;
  activePremise: string | null;
  storySummary: string | null;
  nextEpisodeIndex: number;
  maxEpisodeIndex: number;
  isEndingEpisode: boolean;
  previousEpisodes: WanderAiPreviousEpisodeContext[];
}

export interface WanderAiEpisodeResolutionInput {
  nickname: string;
  realm: string;
  hasTeam: boolean;
  storyLocation: WanderStoryLocation;
  activeTheme: string | null;
  activePremise: string | null;
  storySummary: string | null;
  currentEpisodeIndex: number;
  maxEpisodeIndex: number;
  currentEpisodeTitle: string;
  currentEpisodeOpening: string;
  chosenOptionText: string;
  isEndingEpisode: boolean;
  previousEpisodes: WanderAiPreviousEpisodeContext[];
}

type WanderAiSetupValidationResult =
  | { success: true; data: WanderAiEpisodeSetupDraft }
  | { success: false; reason: string };

type WanderAiResolutionValidationResult =
  | { success: true; data: WanderAiEpisodeResolutionDraft }
  | { success: false; reason: string };

type WanderAiResolutionMode = 'must_continue' | 'must_end';

type WanderAiTitleEffectEntry = {
  key: string;
  value: number;
};

type WanderAiSetupPromptRuleSet = {
  systemRules: string[];
  outputRules: {
    storyThemeLengthRange: string;
    storyThemeStyleRule: string;
    storyThemeExample: string;
    storyPremiseLengthRange: string;
    storyPremiseStyleRule: string;
    storyPremiseExample: string;
    optionCount: number;
    optionStyleRule: string;
    optionExample: [string, string, string];
    episodeTitleLengthRange: string;
    episodeTitleStyleRule: string;
    openingLengthRange: string;
    openingStyleRule: string;
    openingExample: string;
    endingSceneRule: string;
  };
};

type WanderAiResolutionPromptRuleSet = {
  systemRules: string[];
  outputRules: {
    summaryLengthRange: string;
    summaryStyleRule: string;
    summaryExample: string;
    rewardTitleNameLengthRange: string;
    rewardTitleDescLengthRange: string;
    rewardTitleColorPattern: string;
    rewardTitleEffectCountRange: string;
    rewardTitleEffectKeys: readonly string[];
    rewardTitleEffectGuide: string;
    rewardTitleEffectLimitGuide: string;
    rewardTitleEffectValueMaxMap: Readonly<Record<string, number>>;
    nonEndingTitleFieldExample: {
      endingType: 'none';
      rewardTitleName: '';
      rewardTitleDesc: '';
      rewardTitleColor: '';
      rewardTitleEffects: [];
    };
    endingTypeValues: WanderEndingType[];
    endingRule: string;
  };
};

const WANDER_OPTION_COUNT = 3;
const WANDER_AI_TIMEOUT_MS = 600_000;
const WANDER_AI_MAX_ATTEMPTS = 3;
const WANDER_ENDING_TYPE_VALUES: WanderEndingType[] = ['none', 'good', 'neutral', 'tragic', 'bizarre'];
const WANDER_COMPLETED_ENDING_TYPE_VALUES: WanderEndingType[] = ['good', 'neutral', 'tragic', 'bizarre'];
const WANDER_NON_ENDING_TYPE_VALUES: WanderEndingType[] = ['none'];
const WANDER_TITLE_COLOR_PATTERN = '^#[0-9a-fA-F]{6}$';
const WANDER_TITLE_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
const WANDER_TITLE_MIN_EFFECT_COUNT = 1;
const WANDER_TITLE_MAX_EFFECT_COUNT = 5;
const WANDER_TITLE_RATIO_EFFECT_PRECISION = 10_000;
const WANDER_TITLE_EFFECT_KEY_SET = new Set<string>(TITLE_EFFECT_KEYS);
const WANDER_TITLE_EFFECT_KEYS_TEXT = TITLE_EFFECT_KEYS.join(' / ');
const WANDER_TITLE_EFFECT_GUIDE = TITLE_EFFECT_KEYS.map(
  (key) => `${key}(${CHARACTER_ATTR_LABEL_MAP[key] ?? key})`,
).join('、');
const WANDER_TITLE_EFFECT_LIMIT_GUIDE = TITLE_EFFECT_KEYS.map((key) => {
  const max = TITLE_EFFECT_VALUE_MAX_MAP[key];
  const maxText = CHARACTER_RATIO_ATTR_KEY_SET.has(key) ? `${Math.round(max * 10_000) / 100}%` : String(max);
  return `${key}(${CHARACTER_ATTR_LABEL_MAP[key] ?? key}<=${maxText})`;
}).join('、');

const WANDER_OPTION_EXAMPLE: [string, string, string] = [
  '先借檐避雨，再试探来意',
  '绕到桥下暗查灵息',
  '收敛气机，静观其变',
];
const WANDER_STORY_THEME_EXAMPLE = '雨夜借灯';
const WANDER_STORY_THEME_STYLE_RULE = 'storyTheme 必须是 24 字内主题短词，只概括这一幕或这条故事线的意象母题，像“雨夜借灯”“荒祠问卜”，禁止把剧情摘要直接写进 storyTheme，也不要写完整事件经过或长句解释。';
const WANDER_STORY_PREMISE_EXAMPLE = '你循着残留血迹误入谷口深处，才觉今夜盘踞此地的异物并非寻常山兽。';
const WANDER_STORY_PREMISE_STYLE_RULE = 'storyPremise 必须是 8 到 120 字的故事引子，只概括整条奇遇当前的起势、缘由或悬念，像一句前情提要；禁止把整幕 opening 原样压缩，也不要写成标题、角色独白或过长剧情摘要。';
const WANDER_OPTION_STYLE_RULE = 'optionTexts 必须是长度恰好为 3 的字符串数组，每个元素都必须是非空短句，禁止返回空字符串、null、对象、嵌套数组或把三个选项拼成一个字符串。';
const WANDER_EPISODE_TITLE_STYLE_RULE = 'episodeTitle 必须是 24字内中文短标题，像“雨夜借灯”“断桥问剑”，禁止句子式长标题、标点堆砌和副标题。';
const WANDER_OPENING_STYLE_RULE = 'opening 必须是一段 80 到 420 字的完整正文，要交代当下场景、人物动作与异样征兆，并把局势推到玩家抉择前一刻；禁止提前替玩家做选择，禁止提前给出尾声、结局或称号。';
const WANDER_OPENING_EXAMPLE = '夜雨压桥，河雾顺着石栏缓缓爬起，你才在破庙檐下收住衣角，便见对岸灯影摇成一线。那人披着旧蓑衣，手里提灯不前不后，只隔着雨幕望来，像是在等谁认出他的来意；桥下水声却忽然沉了一拍，仿佛另有什么东西正贴着桥墩缓缓游过。';
const WANDER_ENDING_SCENE_RULE = '若本幕是终幕抉择幕，opening 也只能把局势推到最后抉择前一刻，不能提前写玩家选择后的尾声、结局类型、称号名、称号描述、颜色或属性。';
const WANDER_SUMMARY_STYLE_RULE = 'summary 必须是 20 到 160 字的结果摘要，要明确体现玩家本次选择带来的余波、转折或收束，禁止脱离 chosenOptionText 单独编写空泛结论。';
const WANDER_SUMMARY_EXAMPLE = '你借灯试探来意后顺势稳住桥上气机，逼得对岸来客率先露出口风，桥下暗潮却因此彻底惊动，这一幕落在暂得线索却更深卷入风波的余波之中。';
const WANDER_TITLE_EFFECT_STYLE_RULE = `rewardTitleEffects 必须是长度 ${WANDER_TITLE_MIN_EFFECT_COUNT} 到 ${WANDER_TITLE_MAX_EFFECT_COUNT} 的数组，每项都必须是 {key,value} 对象；key 只能从 ${WANDER_TITLE_EFFECT_KEYS_TEXT} 中选择；固定值属性的 value 必须是正整数，百分比属性的 value 必须使用小数比率表示，例如 0.03 表示 3%；每个属性的 value 上限都不同，必须严格遵守属性上限表：${WANDER_TITLE_EFFECT_LIMIT_GUIDE}。`;
const WANDER_TITLE_EFFECT_EXAMPLE: [WanderAiTitleEffectEntry, WanderAiTitleEffectEntry] = [
  { key: 'max_qixue', value: 60 },
  { key: 'baoji', value: 0.03 },
];
const WANDER_TITLE_COLOR_STYLE_RULE = 'rewardTitleColor 必须是 7 位十六进制颜色字符串，格式严格为 #RRGGBB，例如 #faad14。';
const WANDER_TITLE_COLOR_EXAMPLE = '#faad14';
const WANDER_NON_ENDING_TITLE_FIELD_RULE = '非终幕结算必须返回 endingType=none，rewardTitleName、rewardTitleDesc、rewardTitleColor 必须为空字符串，rewardTitleEffects 必须为空数组，不允许返回占位称号或任意属性。';
const WANDER_NON_ENDING_TITLE_FIELD_EXAMPLE = {
  endingType: 'none' as const,
  rewardTitleName: '' as const,
  rewardTitleDesc: '' as const,
  rewardTitleColor: '' as const,
  rewardTitleEffects: [] as [],
};

const resolveWanderAiResolutionMode = (input: WanderAiEpisodeResolutionInput): WanderAiResolutionMode => {
  return input.isEndingEpisode ? 'must_end' : 'must_continue';
};

const buildWanderAiResolutionRuleText = (mode: WanderAiResolutionMode): string => {
  if (mode === 'must_continue') {
    return `当前不是终幕结算：${WANDER_NON_ENDING_TITLE_FIELD_RULE}`;
  }
  return `当前是终幕结算：endingType 只能是 ${WANDER_COMPLETED_ENDING_TYPE_VALUES.join(' / ')}；rewardTitleName 必须是 2 到 8 字中文正式称号名；rewardTitleDesc 必须是 8 到 40 字中文称号描述；rewardTitleColor 必须是合法 #RRGGBB；rewardTitleEffects 必须给出 ${WANDER_TITLE_MIN_EFFECT_COUNT} 到 ${WANDER_TITLE_MAX_EFFECT_COUNT} 条合法属性。`;
};

const readString = (value: WanderAiJsonValue): string => (typeof value === 'string' ? value.trim() : '');

const readStringTuple3 = (value: WanderAiJsonValue): [string, string, string] | null => {
  if (!Array.isArray(value) || value.length !== WANDER_OPTION_COUNT) return null;
  const normalized = value.map((entry) => readString(entry));
  if (normalized.some((entry) => entry.length <= 0)) return null;
  return [normalized[0], normalized[1], normalized[2]];
};

const isJsonObjectRecord = (value: WanderAiJsonValue): value is TechniqueModelJsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readEndingType = (value: WanderAiJsonValue): WanderEndingType | null => {
  const endingType = readString(value) as WanderEndingType;
  return WANDER_ENDING_TYPE_VALUES.includes(endingType) ? endingType : null;
};

const readPositiveInteger = (value: WanderAiJsonValue): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
};

const roundWanderRatioEffectValue = (value: number): number => {
  return Math.round(value * WANDER_TITLE_RATIO_EFFECT_PRECISION) / WANDER_TITLE_RATIO_EFFECT_PRECISION;
};

const assertLengthRange = (value: string, min: number, max: number): boolean => {
  return value.length >= min && value.length <= max;
};

const isValidWanderTitleColor = (value: string): boolean => {
  return WANDER_TITLE_COLOR_REGEX.test(value);
};

const isValidWanderTitleEffectKey = (key: string): boolean => {
  return WANDER_TITLE_EFFECT_KEY_SET.has(key);
};

const getWanderTitleEffectValueMax = (key: string): number => {
  return TITLE_EFFECT_VALUE_MAX_MAP[key as TitleEffectKey];
};

const readWanderTitleEffectValue = (key: string, value: WanderAiJsonValue): number | null => {
  const valueMax = getWanderTitleEffectValueMax(key);
  if (CHARACTER_RATIO_ATTR_KEY_SET.has(key)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    const normalized = roundWanderRatioEffectValue(value);
    return normalized > 0 && normalized <= valueMax ? normalized : null;
  }

  const normalized = readPositiveInteger(value);
  return normalized !== null && normalized <= valueMax ? normalized : null;
};

const readRewardTitleEffects = (
  value: WanderAiJsonValue,
  minEffectCount: number,
): Record<string, number> | null => {
  if (!Array.isArray(value)) return null;
  if (value.length < minEffectCount || value.length > WANDER_TITLE_MAX_EFFECT_COUNT) return null;
  const out: Record<string, number> = {};
  for (const entry of value) {
    if (!isJsonObjectRecord(entry)) return null;
    const key = readString(entry.key ?? '');
    if (!key || !isValidWanderTitleEffectKey(key) || key in out) return null;
    const normalizedValue = readWanderTitleEffectValue(key, entry.value ?? null);
    if (normalizedValue === null || normalizedValue > getWanderTitleEffectValueMax(key)) return null;
    out[key] = normalizedValue;
  }
  return out;
};

export const buildWanderAiEpisodeSetupPromptRuleSet = (isEndingEpisode: boolean): WanderAiSetupPromptRuleSet => {
  const endingSceneRule = isEndingEpisode
    ? `本幕是终幕抉择幕。${WANDER_ENDING_SCENE_RULE}`
    : '本幕不是终幕，只能继续制造悬念与分叉，不能提前把整条故事写完。';

  return {
    systemRules: [
      '你是《九州修仙录》的云游奇遇导演。',
      '你必须输出严格 JSON，不得输出 markdown、解释、额外注释。',
      '剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。',
      '本阶段只负责生成待玩家选择的幕次，不负责结算结果。',
      'previousEpisodes 会按幕次顺序提供已经发生的完整前文，每一幕都包含标题、正文、玩家已选选项和选择后的结果；续写时必须严格承接这些既成事实，不得遗忘、改写或跳过已经发生的因果。',
      WANDER_STORY_THEME_STYLE_RULE,
      `storyTheme 示例：${WANDER_STORY_THEME_EXAMPLE}`,
      WANDER_STORY_PREMISE_STYLE_RULE,
      `storyPremise 示例：${WANDER_STORY_PREMISE_EXAMPLE}`,
      WANDER_OPTION_STYLE_RULE,
      `optionTexts 示例：${JSON.stringify(WANDER_OPTION_EXAMPLE)}`,
      WANDER_EPISODE_TITLE_STYLE_RULE,
      WANDER_OPENING_STYLE_RULE,
      `opening 示例：${WANDER_OPENING_EXAMPLE}`,
      WANDER_ENDING_SCENE_RULE,
      endingSceneRule,
      '三条选项都必须可执行、方向明确、互相有差异，不能只换措辞。',
    ],
    outputRules: {
      storyThemeLengthRange: '2-24',
      storyThemeStyleRule: WANDER_STORY_THEME_STYLE_RULE,
      storyThemeExample: WANDER_STORY_THEME_EXAMPLE,
      storyPremiseLengthRange: '8-120',
      storyPremiseStyleRule: WANDER_STORY_PREMISE_STYLE_RULE,
      storyPremiseExample: WANDER_STORY_PREMISE_EXAMPLE,
      optionCount: WANDER_OPTION_COUNT,
      optionStyleRule: WANDER_OPTION_STYLE_RULE,
      optionExample: WANDER_OPTION_EXAMPLE,
      episodeTitleLengthRange: '2-24',
      episodeTitleStyleRule: WANDER_EPISODE_TITLE_STYLE_RULE,
      openingLengthRange: '80-420',
      openingStyleRule: WANDER_OPENING_STYLE_RULE,
      openingExample: WANDER_OPENING_EXAMPLE,
      endingSceneRule,
    },
  };
};

export const buildWanderAiEpisodeSetupSystemMessage = (isEndingEpisode: boolean): string => {
  return buildWanderAiEpisodeSetupPromptRuleSet(isEndingEpisode).systemRules.join('\n');
};

const buildWanderAiEpisodeSetupRepairSystemMessage = (isEndingEpisode: boolean): string => {
  return [
    buildWanderAiEpisodeSetupSystemMessage(isEndingEpisode),
    '如果用户消息指出上一轮 JSON 的具体错误，你必须严格按该错误修正，并完整重写整个 JSON 对象。',
  ].join('\n');
};

const parseWanderAiEpisodeSetupDraft = (data: TechniqueModelJsonObject): WanderAiSetupValidationResult => {
  const storyTheme = readString(data.storyTheme ?? '');
  const storyPremise = readString(data.storyPremise ?? '');
  const episodeTitle = readString(data.episodeTitle ?? '');
  const opening = readString(data.opening ?? '');
  const optionTexts = readStringTuple3(data.optionTexts ?? []);

  if (!assertLengthRange(storyTheme, 2, 24)) {
    return { success: false, reason: 'storyTheme 长度必须在 2 到 24 之间' };
  }
  if (!assertLengthRange(storyPremise, 8, 120)) {
    return { success: false, reason: 'storyPremise 长度必须在 8 到 120 之间' };
  }
  if (!assertLengthRange(episodeTitle, 2, 24)) {
    return { success: false, reason: 'episodeTitle 长度必须在 2 到 24 之间' };
  }
  if (!assertLengthRange(opening, 80, 420)) {
    return { success: false, reason: 'opening 长度必须在 80 到 420 之间' };
  }
  if (optionTexts === null) {
    return { success: false, reason: `optionTexts 必须是 ${WANDER_OPTION_COUNT} 个非空字符串` };
  }

  return {
    success: true,
    data: {
      storyTheme,
      storyPremise,
      episodeTitle,
      opening,
      optionTexts,
    },
  };
};

export const validateWanderAiEpisodeSetupContent = (content: string): WanderAiSetupValidationResult => {
  const parsed = parseTechniqueTextModelJsonObject(content);
  if (!parsed.success || !isJsonObjectRecord(parsed.data)) {
    return { success: false, reason: '模型未返回合法 JSON 对象' };
  }

  return parseWanderAiEpisodeSetupDraft(parsed.data);
};

const WANDER_SETUP_RESPONSE_SCHEMA_REQUIRED_FIELDS = [
  'storyTheme',
  'storyPremise',
  'episodeTitle',
  'opening',
  'optionTexts',
] as const;

const buildWanderAiEpisodeSetupResponseSchema = (): TechniqueTextModelJsonSchemaObject => {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...WANDER_SETUP_RESPONSE_SCHEMA_REQUIRED_FIELDS],
    properties: {
      storyTheme: { type: 'string', minLength: 2, maxLength: 24 },
      storyPremise: { type: 'string', minLength: 8, maxLength: 120 },
      episodeTitle: { type: 'string', minLength: 2, maxLength: 24 },
      opening: { type: 'string', minLength: 80, maxLength: 420 },
      optionTexts: {
        type: 'array',
        minItems: WANDER_OPTION_COUNT,
        maxItems: WANDER_OPTION_COUNT,
        items: { type: 'string', minLength: 4, maxLength: 32 },
      },
    },
  };
};

export const buildWanderAiEpisodeSetupUserPayload = (
  input: WanderAiEpisodeSetupInput,
  seed: number,
): {
  promptNoiseHash: string;
  player: {
    nickname: string;
    realm: string;
    hasTeam: boolean;
  };
  storyLocation: WanderStoryLocation;
  story: {
    activeTheme: string | null;
    activePremise: string | null;
    storySummary: string | null;
    nextEpisodeIndex: number;
    maxEpisodeIndex: number;
    isEndingEpisode: boolean;
    previousEpisodes: WanderAiPreviousEpisodeContext[];
  };
  outputRules: WanderAiSetupPromptRuleSet['outputRules'];
} => {
  return {
    promptNoiseHash: buildTextModelPromptNoiseHash('wander-story-setup', seed),
    player: {
      nickname: input.nickname,
      realm: input.realm,
      hasTeam: input.hasTeam,
    },
    storyLocation: input.storyLocation,
    story: {
      activeTheme: input.activeTheme,
      activePremise: input.activePremise,
      storySummary: input.storySummary,
      nextEpisodeIndex: input.nextEpisodeIndex,
      maxEpisodeIndex: input.maxEpisodeIndex,
      isEndingEpisode: input.isEndingEpisode,
      previousEpisodes: input.previousEpisodes,
    },
    outputRules: buildWanderAiEpisodeSetupPromptRuleSet(input.isEndingEpisode).outputRules,
  };
};

const buildWanderAiEpisodeSetupUserMessage = (
  input: WanderAiEpisodeSetupInput,
  seed: number,
): string => {
  return JSON.stringify(buildWanderAiEpisodeSetupUserPayload(input, seed));
};

const buildWanderAiEpisodeSetupRepairUserMessage = (
  input: WanderAiEpisodeSetupInput,
  seed: number,
  previousContent: string,
  validationReason: string,
): string => {
  return JSON.stringify({
    task: '你上一轮输出的 JSON 未通过校验，请基于同一幕剧情进行修正，并完整重写整个 JSON 对象。',
    validationReason,
    outputRules: buildWanderAiEpisodeSetupPromptRuleSet(input.isEndingEpisode).outputRules,
    originalTask: JSON.parse(buildWanderAiEpisodeSetupUserMessage(input, seed)),
    previousOutput: previousContent,
  });
};

export const buildWanderAiEpisodeResolutionPromptRuleSet = (
  mode: WanderAiResolutionMode,
): WanderAiResolutionPromptRuleSet => {
  return {
    systemRules: [
      '你是《九州修仙录》的云游奇遇导演。',
      '你必须输出严格 JSON，不得输出 markdown、解释、额外注释。',
      '剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。',
      '本阶段只负责根据玩家已经选定的选项，生成这一幕真正发生的余波与收束。',
      'previousEpisodes 会按幕次顺序提供已经发生的完整前文，每一幕都包含标题、正文、玩家已选选项和选择后的结果；你必须把当前这一幕放在这些既有经历之后承接，不能忽略已发生的因果。',
      WANDER_SUMMARY_STYLE_RULE,
      `summary 示例：${WANDER_SUMMARY_EXAMPLE}`,
      WANDER_TITLE_COLOR_STYLE_RULE,
      `rewardTitleColor 示例：${WANDER_TITLE_COLOR_EXAMPLE}`,
      WANDER_TITLE_EFFECT_STYLE_RULE,
      `rewardTitleEffects 可用属性：${WANDER_TITLE_EFFECT_GUIDE}`,
      `rewardTitleEffects 示例：${JSON.stringify(WANDER_TITLE_EFFECT_EXAMPLE)}`,
      WANDER_NON_ENDING_TITLE_FIELD_RULE,
      `非终幕字段示例：${JSON.stringify(WANDER_NON_ENDING_TITLE_FIELD_EXAMPLE)}`,
      buildWanderAiResolutionRuleText(mode),
    ],
    outputRules: {
      summaryLengthRange: '20-160',
      summaryStyleRule: WANDER_SUMMARY_STYLE_RULE,
      summaryExample: WANDER_SUMMARY_EXAMPLE,
      rewardTitleNameLengthRange: '2-8',
      rewardTitleDescLengthRange: '8-40',
      rewardTitleColorPattern: '#RRGGBB',
      rewardTitleEffectCountRange: `${WANDER_TITLE_MIN_EFFECT_COUNT}-${WANDER_TITLE_MAX_EFFECT_COUNT}`,
      rewardTitleEffectKeys: TITLE_EFFECT_KEYS,
      rewardTitleEffectGuide: WANDER_TITLE_EFFECT_GUIDE,
      rewardTitleEffectLimitGuide: WANDER_TITLE_EFFECT_LIMIT_GUIDE,
      rewardTitleEffectValueMaxMap: TITLE_EFFECT_VALUE_MAX_MAP,
      nonEndingTitleFieldExample: WANDER_NON_ENDING_TITLE_FIELD_EXAMPLE,
      endingTypeValues: WANDER_ENDING_TYPE_VALUES,
      endingRule: buildWanderAiResolutionRuleText(mode),
    },
  };
};

export const buildWanderAiEpisodeResolutionSystemMessage = (mode: WanderAiResolutionMode): string => {
  return buildWanderAiEpisodeResolutionPromptRuleSet(mode).systemRules.join('\n');
};

const buildWanderAiEpisodeResolutionRepairSystemMessage = (mode: WanderAiResolutionMode): string => {
  return [
    buildWanderAiEpisodeResolutionSystemMessage(mode),
    '如果用户消息指出上一轮 JSON 的具体错误，你必须严格按该错误修正，并完整重写整个 JSON 对象。',
  ].join('\n');
};

const parseWanderAiEpisodeResolutionDraft = (
  data: TechniqueModelJsonObject,
  mode: WanderAiResolutionMode,
): WanderAiResolutionValidationResult => {
  const summary = readString(data.summary ?? '');
  const endingType = readEndingType(data.endingType ?? '');
  const rewardTitleName = readString(data.rewardTitleName ?? '');
  const rewardTitleDesc = readString(data.rewardTitleDesc ?? '');
  const rewardTitleColor = readString(data.rewardTitleColor ?? '');
  const rewardTitleEffects = readRewardTitleEffects(
    data.rewardTitleEffects ?? [],
    mode === 'must_end' ? WANDER_TITLE_MIN_EFFECT_COUNT : 0,
  );

  if (!assertLengthRange(summary, 20, 160)) {
    return { success: false, reason: 'summary 长度必须在 20 到 160 之间' };
  }
  if (endingType === null) {
    return { success: false, reason: `endingType 必须属于 ${WANDER_ENDING_TYPE_VALUES.join(' / ')}` };
  }

  if (mode === 'must_continue') {
    if (
      endingType !== 'none'
      || rewardTitleName
      || rewardTitleDesc
      || rewardTitleColor
      || rewardTitleEffects === null
      || Object.keys(rewardTitleEffects).length > 0
    ) {
      return { success: false, reason: '非终幕结算必须返回 endingType=none，且称号名、描述、颜色、属性字段都为空' };
    }
  } else if (
    endingType === 'none'
    || !assertLengthRange(rewardTitleName, 2, 8)
    || !assertLengthRange(rewardTitleDesc, 8, 40)
    || !isValidWanderTitleColor(rewardTitleColor)
    || rewardTitleEffects === null
  ) {
    return { success: false, reason: '终幕结算必须返回有效 endingType，并提供合法长度的称号名、称号描述、颜色与属性数组' };
  }

  return {
    success: true,
    data: {
      summary,
      isEnding: mode === 'must_end',
      endingType,
      rewardTitleName,
      rewardTitleDesc,
      rewardTitleColor,
      rewardTitleEffects: rewardTitleEffects ?? {},
    },
  };
};

export const validateWanderAiEpisodeResolutionContent = (
  content: string,
  mode: WanderAiResolutionMode,
): WanderAiResolutionValidationResult => {
  const parsed = parseTechniqueTextModelJsonObject(content);
  if (!parsed.success || !isJsonObjectRecord(parsed.data)) {
    return { success: false, reason: '模型未返回合法 JSON 对象' };
  }

  return parseWanderAiEpisodeResolutionDraft(parsed.data, mode);
};

const buildWanderTitleEffectEntrySchema = (): TechniqueTextModelJsonSchemaObject => {
  return {
    oneOf: TITLE_EFFECT_KEYS.map((key) => ({
      type: 'object',
      additionalProperties: false,
      required: ['key', 'value'],
      properties: {
        key: { type: 'string', const: key },
        value: CHARACTER_RATIO_ATTR_KEY_SET.has(key)
          ? { type: 'number', exclusiveMinimum: 0, maximum: TITLE_EFFECT_VALUE_MAX_MAP[key] }
          : { type: 'integer', exclusiveMinimum: 0, maximum: TITLE_EFFECT_VALUE_MAX_MAP[key] },
      },
    })),
    type: 'object',
    additionalProperties: false,
    required: ['key', 'value'],
    properties: {
      key: { type: 'string', enum: [...TITLE_EFFECT_KEYS] },
      value: { type: 'number', exclusiveMinimum: 0, maximum: Math.max(...Object.values(TITLE_EFFECT_VALUE_MAX_MAP)) },
    },
  };
};

const buildWanderTitleEffectsSchema = (
  minItems: number,
  maxItems: number,
): TechniqueTextModelJsonSchema => {
  return {
    type: 'array',
    minItems,
    maxItems,
    items: buildWanderTitleEffectEntrySchema(),
  };
};

const buildWanderAiEpisodeResolutionBaseProperties = (): TechniqueTextModelJsonSchemaProperties => {
  return {
    summary: { type: 'string', minLength: 20, maxLength: 160 },
    endingType: { type: 'string', enum: WANDER_ENDING_TYPE_VALUES },
    rewardTitleName: { type: 'string', minLength: 0, maxLength: 8 },
    rewardTitleDesc: { type: 'string', minLength: 0, maxLength: 40 },
    rewardTitleColor: { type: 'string', minLength: 0, maxLength: 7 },
    rewardTitleEffects: buildWanderTitleEffectsSchema(0, WANDER_TITLE_MAX_EFFECT_COUNT),
  };
};

const buildWanderAiEpisodeResolutionContinueSchema = (): TechniqueTextModelJsonSchemaObject => {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'endingType', 'rewardTitleName', 'rewardTitleDesc', 'rewardTitleColor', 'rewardTitleEffects'],
    properties: {
      ...buildWanderAiEpisodeResolutionBaseProperties(),
      endingType: { type: 'string', enum: WANDER_NON_ENDING_TYPE_VALUES, const: 'none' },
      rewardTitleName: { type: 'string', minLength: 0, maxLength: 0 },
      rewardTitleDesc: { type: 'string', minLength: 0, maxLength: 0 },
      rewardTitleColor: { type: 'string', minLength: 0, maxLength: 0 },
      rewardTitleEffects: buildWanderTitleEffectsSchema(0, 0),
    },
  };
};

const buildWanderAiEpisodeResolutionEndingSchema = (): TechniqueTextModelJsonSchemaObject => {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'endingType', 'rewardTitleName', 'rewardTitleDesc', 'rewardTitleColor', 'rewardTitleEffects'],
    properties: {
      ...buildWanderAiEpisodeResolutionBaseProperties(),
      endingType: { type: 'string', enum: WANDER_COMPLETED_ENDING_TYPE_VALUES },
      rewardTitleName: { type: 'string', minLength: 2, maxLength: 8 },
      rewardTitleDesc: { type: 'string', minLength: 8, maxLength: 40 },
      rewardTitleColor: { type: 'string', minLength: 7, maxLength: 7, pattern: WANDER_TITLE_COLOR_PATTERN },
      rewardTitleEffects: buildWanderTitleEffectsSchema(WANDER_TITLE_MIN_EFFECT_COUNT, WANDER_TITLE_MAX_EFFECT_COUNT),
    },
  };
};

export const buildWanderAiEpisodeResolutionResponseSchema = (
  mode: WanderAiResolutionMode,
): TechniqueTextModelJsonSchemaObject => {
  return mode === 'must_end'
    ? buildWanderAiEpisodeResolutionEndingSchema()
    : buildWanderAiEpisodeResolutionContinueSchema();
};

export const buildWanderAiEpisodeResolutionUserPayload = (
  input: WanderAiEpisodeResolutionInput,
  seed: number,
): {
  promptNoiseHash: string;
  player: {
    nickname: string;
    realm: string;
    hasTeam: boolean;
  };
  storyLocation: WanderStoryLocation;
  story: {
    activeTheme: string | null;
    activePremise: string | null;
    storySummary: string | null;
    currentEpisodeIndex: number;
    maxEpisodeIndex: number;
    currentEpisodeTitle: string;
    currentEpisodeOpening: string;
    chosenOptionText: string;
    isEndingEpisode: boolean;
    previousEpisodes: WanderAiPreviousEpisodeContext[];
    resolutionMode: WanderAiResolutionMode;
  };
  outputRules: WanderAiResolutionPromptRuleSet['outputRules'];
} => {
  const resolutionMode = resolveWanderAiResolutionMode(input);
  return {
    promptNoiseHash: buildTextModelPromptNoiseHash('wander-story-resolution', seed),
    player: {
      nickname: input.nickname,
      realm: input.realm,
      hasTeam: input.hasTeam,
    },
    storyLocation: input.storyLocation,
    story: {
      activeTheme: input.activeTheme,
      activePremise: input.activePremise,
      storySummary: input.storySummary,
      currentEpisodeIndex: input.currentEpisodeIndex,
      maxEpisodeIndex: input.maxEpisodeIndex,
      currentEpisodeTitle: input.currentEpisodeTitle,
      currentEpisodeOpening: input.currentEpisodeOpening,
      chosenOptionText: input.chosenOptionText,
      isEndingEpisode: input.isEndingEpisode,
      previousEpisodes: input.previousEpisodes,
      resolutionMode,
    },
    outputRules: buildWanderAiEpisodeResolutionPromptRuleSet(resolutionMode).outputRules,
  };
};

const buildWanderAiEpisodeResolutionUserMessage = (
  input: WanderAiEpisodeResolutionInput,
  seed: number,
): string => {
  return JSON.stringify(buildWanderAiEpisodeResolutionUserPayload(input, seed));
};

const buildWanderAiEpisodeResolutionRepairUserMessage = (
  input: WanderAiEpisodeResolutionInput,
  seed: number,
  previousContent: string,
  validationReason: string,
): string => {
  const mode = resolveWanderAiResolutionMode(input);
  return JSON.stringify({
    task: '你上一轮输出的 JSON 未通过校验，请基于同一幕剧情进行修正，并完整重写整个 JSON 对象。',
    validationReason,
    outputRules: buildWanderAiEpisodeResolutionPromptRuleSet(mode).outputRules,
    originalTask: JSON.parse(buildWanderAiEpisodeResolutionUserMessage(input, seed)),
    previousOutput: previousContent,
  });
};

const buildWanderAiResponseFormat = (
  schema: TechniqueTextModelJsonSchemaObject,
  useStructuredSchema: boolean,
): TechniqueTextModelResponseFormat => {
  if (!useStructuredSchema) {
    return { type: 'json_object' };
  }

  return buildTechniqueTextModelJsonSchemaResponseFormat({
    name: 'wander_story_payload',
    schema,
  });
};

const isUnsupportedStructuredSchemaError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message.includes('invalid_json_schema')
    || error.message.includes("'allOf' is not permitted")
    || error.message.includes('Invalid schema for response_format');
};

const requestWanderAiContent = async (params: {
  responseFormat: TechniqueTextModelResponseFormat;
  systemMessage: string;
  userMessage: string;
  seed: number;
}): Promise<string> => {
  const callResult = await callConfiguredTextModel({
    modelScope: 'wander',
    responseFormat: params.responseFormat,
    systemMessage: params.systemMessage,
    userMessage: params.userMessage,
    seed: params.seed,
    timeoutMs: WANDER_AI_TIMEOUT_MS,
  });

  if (!callResult) {
    throw new Error('未配置 AI 文本模型，无法生成云游奇遇');
  }

  return callResult.content;
};

export const isWanderAiAvailable = (): boolean => {
  return readTextModelConfig('wander') !== null;
};

export const generateWanderAiEpisodeSetupDraft = async (
  input: WanderAiEpisodeSetupInput,
): Promise<WanderAiEpisodeSetupDraft> => {
  const seed = generateTechniqueTextModelSeed();
  let useStructuredSchema = true;
  let latestContent = '';
  let latestFailureReason = '模型未返回合法 JSON 对象';

  for (let attempt = 1; attempt <= WANDER_AI_MAX_ATTEMPTS; attempt += 1) {
    const systemMessage = attempt === 1
      ? buildWanderAiEpisodeSetupSystemMessage(input.isEndingEpisode)
      : buildWanderAiEpisodeSetupRepairSystemMessage(input.isEndingEpisode);
    const userMessage = attempt === 1
      ? buildWanderAiEpisodeSetupUserMessage(input, seed)
      : buildWanderAiEpisodeSetupRepairUserMessage(input, seed, latestContent, latestFailureReason);

    try {
      latestContent = await requestWanderAiContent({
        responseFormat: buildWanderAiResponseFormat(buildWanderAiEpisodeSetupResponseSchema(), useStructuredSchema),
        systemMessage,
        userMessage,
        seed,
      });
    } catch (error) {
      if (useStructuredSchema && isUnsupportedStructuredSchemaError(error)) {
        useStructuredSchema = false;
        latestFailureReason = '当前模型端不支持本次结构化 schema，已改为普通 JSON 输出，请严格按规则完整重写 JSON。';
        latestContent = '';
        attempt -= 1;
        continue;
      }
      throw error;
    }

    const validation = validateWanderAiEpisodeSetupContent(latestContent);
    if (validation.success) {
      return validation.data;
    }

    latestFailureReason = validation.reason;
  }

  throw new Error(`云游奇遇模型返回字段不符合业务约束：${latestFailureReason}`);
};

export const generateWanderAiEpisodeResolutionDraft = async (
  input: WanderAiEpisodeResolutionInput,
): Promise<WanderAiEpisodeResolutionDraft> => {
  const seed = generateTechniqueTextModelSeed();
  const mode = resolveWanderAiResolutionMode(input);
  let useStructuredSchema = true;
  let latestContent = '';
  let latestFailureReason = '模型未返回合法 JSON 对象';

  for (let attempt = 1; attempt <= WANDER_AI_MAX_ATTEMPTS; attempt += 1) {
    const systemMessage = attempt === 1
      ? buildWanderAiEpisodeResolutionSystemMessage(mode)
      : buildWanderAiEpisodeResolutionRepairSystemMessage(mode);
    const userMessage = attempt === 1
      ? buildWanderAiEpisodeResolutionUserMessage(input, seed)
      : buildWanderAiEpisodeResolutionRepairUserMessage(input, seed, latestContent, latestFailureReason);

    try {
      latestContent = await requestWanderAiContent({
        responseFormat: buildWanderAiResponseFormat(buildWanderAiEpisodeResolutionResponseSchema(mode), useStructuredSchema),
        systemMessage,
        userMessage,
        seed,
      });
    } catch (error) {
      if (useStructuredSchema && isUnsupportedStructuredSchemaError(error)) {
        useStructuredSchema = false;
        latestFailureReason = '当前模型端不支持本次结构化 schema，已改为普通 JSON 输出，请严格按规则完整重写 JSON。';
        latestContent = '';
        attempt -= 1;
        continue;
      }
      throw error;
    }

    const validation = validateWanderAiEpisodeResolutionContent(latestContent, mode);
    if (validation.success) {
      return validation.data;
    }

    latestFailureReason = validation.reason;
  }

  throw new Error(`云游奇遇模型返回字段不符合业务约束：${latestFailureReason}`);
};
