/**
 * AI 生成功法 candidate 共享核心
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中处理功法 candidate 的模型请求、JSON 清洗、结果校验、重试与技能 ID 重映射。
 * 2) 做什么：让洞府研修与伙伴招募共用同一套功法生成核心，避免两边各维护一份提示词与数值校验逻辑。
 * 3) 不做什么：不写数据库、不决定发布态/作用域，也不处理任务状态机与退款。
 *
 * 输入/输出：
 * - 输入：功法类型、品质、最大层数、任务上下文，以及可选的提示词额外语境。
 * - 输出：合法的 `TechniqueGenerationCandidate`、模型名、提示词快照、尝试次数。
 *
 * 数据流/状态流：
 * 调用方上下文 -> buildTechniqueGeneratorPromptInput -> 文本模型 -> sanitize/validate -> 返回 candidate -> 调用方决定落库。
 *
 * 关键边界条件与坑点：
 * 1) `maxLayer` 不能再硬编码为洞府研修口径，伙伴天生功法会传入更低层数；否则虽然复用了生成器，结果仍会错层。
 * 2) 共享层只返回合法 candidate，不接触 job 表；这样伙伴招募与洞府研修才不会被彼此的任务字段耦合住。
 */
import { randomUUID } from 'crypto';
import type { SkillEffect } from '../../battle/types.js';
import { callConfiguredTextModel } from '../ai/openAITextClient.js';
import {
  buildTextModelPromptNoiseHash,
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
  TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE,
} from './techniqueTextModelShared.js';
import { resolveTechniqueGenerationRequestFailure } from './techniqueGenerationRequestFailure.js';
import {
  buildTechniqueGeneratorPromptInput,
  buildTechniqueGenerationResponseFormat,
  TECHNIQUE_EFFECT_TYPE_LIST,
  TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS,
  TECHNIQUE_PROMPT_EFFECT_COMMON_FIELDS,
  TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
  TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY,
  isSupportedTechniquePassiveKey,
  validateTechniqueSkillTargetCount,
  validateTechniqueSkillUpgrade,
  type GeneratedTechniqueType,
} from './techniqueGenerationConstraints.js';
import {
  resolveSkillTriggerType,
  validatePassiveSkillConfig,
} from '../../shared/skillTriggerType.js';
import type { TechniqueSkillUpgradeEntry } from './techniqueSkillGenerationSpec.js';
import {
  TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE,
  validateTechniqueSkillEffectList,
} from './techniqueSkillGenerationSpec.js';
import type {
  TechniqueGenerationCandidate,
  TechniqueQuality,
} from '../techniqueGenerationService.js';

export type TechniqueGenerationAttemptFailureStage =
  | 'config_missing'
  | 'request_timeout'
  | 'request_failed'
  | 'http_error'
  | 'empty_response'
  | 'json_parse_failed'
  | 'candidate_sanitize_failed'
  | 'candidate_validate_failed';

export class TechniqueGenerationExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TechniqueGenerationExhaustedError';
  }
}

type TechniqueGenerationAttemptFailure = {
  success: false;
  stage: TechniqueGenerationAttemptFailureStage;
  reason: string;
  modelName: string;
  promptSnapshot: string;
  rawContent?: string;
};

type TechniqueGenerationAttemptSuccess = {
  success: true;
  candidate: TechniqueGenerationCandidate;
  modelName: string;
  promptSnapshot: string;
};

type TechniqueGenerationAttemptResult =
  | TechniqueGenerationAttemptFailure
  | TechniqueGenerationAttemptSuccess;

type CandidateValidationResult =
  | { success: true }
  | { success: false; message: string; code: 'GENERATOR_INVALID' };

type TechniqueGenerationRetryGuidance = {
  previousFailureReason: string;
  correctionRules: string[];
};

type TechniqueCandidateSanitizeResult =
  | {
      success: true;
      candidate: TechniqueGenerationCandidate;
    }
  | {
      success: false;
      reason: string;
    };

const DEFAULT_REQUIRED_REALM = '凡人';
const DAMAGE_EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_EFFECT_TYPE_LIST);
const TECHNIQUE_CANDIDATE_WRAPPER_KEYS = ['candidate', 'data', 'result', 'payload'] as const;

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asNumber = (raw: unknown, fallback = 0): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const readAliasedField = (
  row: Record<string, unknown>,
  ...keys: string[]
): unknown => {
  for (const key of keys) {
    if (key in row) {
      return row[key];
    }
  }
  return undefined;
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

const isTechniquePlainObject = (raw: unknown): raw is Record<string, unknown> => {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
};

const summarizeTechniqueObjectKeys = (row: Record<string, unknown>): string => {
  const keys = Object.keys(row).slice(0, 8);
  return keys.length > 0 ? keys.join(', ') : '(空对象)';
};

const resolveTechniqueCandidateSourceObject = (
  raw: unknown,
): {
  source: Record<string, unknown> | null;
  wrapperKey: string | null;
  failureReason: string | null;
} => {
  if (!isTechniquePlainObject(raw)) {
    return {
      source: null,
      wrapperKey: null,
      failureReason: '模型结果顶层不是 JSON 对象',
    };
  }

  const directTechnique = raw.technique;
  if (isTechniquePlainObject(directTechnique)) {
    return {
      source: raw,
      wrapperKey: null,
      failureReason: null,
    };
  }

  for (const wrapperKey of TECHNIQUE_CANDIDATE_WRAPPER_KEYS) {
    const nested = raw[wrapperKey];
    if (!isTechniquePlainObject(nested)) continue;
    const nestedTechnique = nested.technique;
    if (!isTechniquePlainObject(nestedTechnique)) continue;
    return {
      source: null,
      wrapperKey,
      failureReason: `模型结果被额外包裹在顶层键 ${wrapperKey} 中，顶层必须直接返回 technique/skills/layers`,
    };
  }

  return {
    source: null,
    wrapperKey: null,
    failureReason: `模型结果缺少 technique 对象，当前顶层键：${summarizeTechniqueObjectKeys(raw)}`,
  };
};

const buildGeneratedSkillId = (idx: number): string => {
  return `skill-gen-${Date.now().toString(36)}-${idx}-${randomUUID().slice(0, 4)}`;
};

const toTargetType = (raw: unknown): TechniqueGenerationCandidate['skills'][number]['targetType'] => {
  const text = asString(raw);
  if (text === 'self' || text === 'single_enemy' || text === 'single_ally' || text === 'all_enemy' || text === 'all_ally' || text === 'random_enemy' || text === 'random_ally') {
    return text;
  }
  return 'single_enemy';
};

const toDamageType = (raw: unknown): 'physical' | 'magic' | 'true' | null => {
  const text = asString(raw);
  if (text === 'physical' || text === 'magic' || text === 'true') return text;
  return null;
};

const stripNullishTechniqueJsonValue = (raw: unknown): unknown => {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => stripNullishTechniqueJsonValue(entry))
      .filter((entry) => entry !== undefined);
  }
  if (typeof raw !== 'object') {
    return raw;
  }

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const sanitizedValue = stripNullishTechniqueJsonValue(value);
    if (sanitizedValue !== undefined) {
      next[key] = sanitizedValue;
    }
  }
  return next;
};

const sanitizeTechniqueEffect = (raw: Record<string, unknown>): Record<string, unknown> => {
  const nextRaw = stripNullishTechniqueJsonValue(raw);
  const next = (nextRaw && typeof nextRaw === 'object' && !Array.isArray(nextRaw))
    ? { ...(nextRaw as Record<string, unknown>) }
    : {};
  for (const field of TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS) {
    if (field in next) {
      delete next[field];
    }
  }
  return next;
};

const sanitizeTechniqueUpgrade = (raw: Record<string, unknown>): TechniqueSkillUpgradeEntry => {
  const sanitized = stripNullishTechniqueJsonValue(raw);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as TechniqueSkillUpgradeEntry;
};

const normalizeEffects = (raw: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => sanitizeTechniqueEffect(entry as Record<string, unknown>))
    .filter((entry) => DAMAGE_EFFECT_TYPE_SET.has(String(entry.type || '')));
};

const normalizeTechniqueLayerSkillIds = (
  raw: unknown,
  sanitizedSkillIdSet: ReadonlySet<string>,
): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => asString(entry))
    .filter((id) => sanitizedSkillIdSet.has(id));
};

const DUPLICATE_EFFECT_FAILURE_TOKEN = '不允许包含重复 effect';
const UPGRADE_UNSUPPORTED_FIELD_REASON_PATTERN = /upgrades\.changes 包含未支持字段：([A-Za-z0-9_]+)/;
const UPGRADE_DAMAGE_TOTAL_SCALE_FAILURE_TOKEN = 'scaleRate × hit_count 不能大于';

const buildTechniqueGenerationRetryCorrectionRules = (reason: string): string[] => {
  const rules = [
    '本次为重试生成，必须先修正 previousFailureReason 对应的问题，再输出完整 JSON。',
  ];

  if (reason.includes(DUPLICATE_EFFECT_FAILURE_TOKEN)) {
    rules.push(
      '同一技能的 effects 数组内，任意两个 effect 对象都不能完全相同。',
      '如果已经存在 restore_lingqi/heal/shield/resource 等效果，不要再复制一条字段与数值完全一致的 effect。',
      '如果只是想增强同一效果，请直接提高该 effect 的 value、baseValue、scaleRate 或 duration，不要新增重复对象。',
    );
  }

  if (reason.includes(UPGRADE_DAMAGE_TOTAL_SCALE_FAILURE_TOKEN)) {
    rules.push(
      '只有升级链路需要限制总伤害倍率；基础技能 effects 不受这条规则约束。',
      `若 upgrades.changes.effects 或 addEffect 中包含 damage，且同时填写 scaleRate 与 hit_count，则总倍率（scaleRate × hit_count）不能超过 ${TECHNIQUE_UPGRADE_DAMAGE_EFFECT_MAX_TOTAL_SCALE_RATE}。`,
      '如果升级想做多段伤害，请同步下调每段 scaleRate，保证升级后的总倍率预算不过线。',
    );
  }

  const unsupportedFieldMatch = reason.match(UPGRADE_UNSUPPORTED_FIELD_REASON_PATTERN);
  const unsupportedField = unsupportedFieldMatch?.[1];
  if (unsupportedField && unsupportedField in TECHNIQUE_PROMPT_EFFECT_COMMON_FIELDS) {
    rules.push(
      `upgrades.changes 不能直接写 ${unsupportedField}；它属于单个 effect 的内部字段，不属于升级改动顶层键。`,
      `如果要修改已有效果中的 ${unsupportedField}，必须改写 changes.effects，提供完整 effects 数组；不要返回 changes.${unsupportedField}。`,
      '如果只是新增一个效果，请使用 changes.addEffect，并把该 effect 的全部字段写在 addEffect 对象内部。',
    );
  }

  return rules;
};

/**
 * 构建重试阶段的附加提示语境。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把上一轮失败原因收敛成统一的 `techniqueRetryGuidance`，供后续重试直接复用。
 * 2) 做什么：保留调用方已有的 promptContext，避免伙伴招募等上游语境在重试时被覆盖。
 * 3) 不做什么：不改写原始失败原因，不吞掉任何业务错误，也不在这里做结果修复。
 *
 * 输入/输出：
 * - 输入：调用方原始 promptContext，以及上一轮失败原因。
 * - 输出：追加了 `techniqueRetryGuidance` 的 promptContext；若当前是首轮生成则原样返回。
 *
 * 数据流/状态流：
 * generateTechniqueCandidateWithRetry -> 本函数补充 retry guidance -> buildTechniqueGenerationTextModelRequest -> 模型下一轮重试。
 *
 * 关键边界条件与坑点：
 * 1) `techniqueRetryGuidance` 是共享 prompt 协议，字段名必须稳定；否则 prompt 规则里声明的读取路径会失效。
 * 2) 重试提示只能“加约束”，不能在这里偷偷改 candidate 数据；否则会把生成问题伪装成服务端兜底。
 */
export const buildTechniqueGenerationRetryPromptContext = (params: {
  promptContext?: Record<string, unknown>;
  previousFailureReason?: string | null;
}): Record<string, unknown> | undefined => {
  const { promptContext, previousFailureReason } = params;
  if (!previousFailureReason) {
    return promptContext;
  }

  const retryGuidance: TechniqueGenerationRetryGuidance = {
    previousFailureReason,
    correctionRules: buildTechniqueGenerationRetryCorrectionRules(previousFailureReason),
  };

  return {
    ...(promptContext ?? {}),
    techniqueRetryGuidance: retryGuidance,
  };
};

const readTechniqueGenerationRetryGuidance = (
  promptContext?: Record<string, unknown>,
): TechniqueGenerationRetryGuidance | undefined => {
  const raw = promptContext?.techniqueRetryGuidance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (typeof row.previousFailureReason !== 'string' || !row.previousFailureReason.trim()) {
    return undefined;
  }
  if (!Array.isArray(row.correctionRules)) {
    return undefined;
  }
  const correctionRules = row.correctionRules
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
  if (correctionRules.length <= 0) {
    return undefined;
  }
  return {
    previousFailureReason: row.previousFailureReason.trim(),
    correctionRules,
  };
};

/**
 * 统一清洗 AI 返回的功法 candidate。
 *
 * 作用：
 * 1) 收敛模型输出 JSON 到服务端标准结构，避免战斗/预览/落库各自兼容字段名。
 * 2) 同时接受 camelCase 与 snake_case，专门兜住 AI 在 `skills/layers` 上混用命名造成的字段丢失。
 * 3) 不做什么：不校验业务合法性，不决定发布态，也不写数据库。
 *
 * 输入/输出：
 * - 输入：模型原始 JSON、目标功法类型、品质、最大层数。
 * - 输出：清洗后的 `TechniqueGenerationCandidate`；结构非法时返回 `null`。
 *
 * 数据流/状态流：
 * 文本模型输出 -> 本函数字段归一化 -> validateTechniqueGenerationCandidate -> 落草稿/发布/战斗链路复用。
 *
 * 关键边界条件与坑点：
 * 1) AI 偶发把 `upgradeSkillIds/unlockSkillIds/costLingqi/...` 写成 snake_case；若这里只认 camelCase，后续战斗会静默吃掉升级冷却等结构化字段。
 * 2) 本函数只做“命名口径归一化 + 基础数值裁剪”，不替调用方吞掉缺失层、重复技能等业务错误，业务合法性仍由 validate 阶段统一拦截。
 */
export const sanitizeTechniqueGenerationCandidateFromModel = (
  raw: unknown,
  techniqueType: GeneratedTechniqueType,
  quality: TechniqueQuality,
  maxLayer: number,
): TechniqueGenerationCandidate | null => {
  const result = sanitizeTechniqueGenerationCandidateFromModelDetailed(
    raw,
    techniqueType,
    quality,
    maxLayer,
  );
  return result.success ? result.candidate : null;
};

/**
 * 统一清洗 AI 返回的功法 candidate，并输出可用于重试提示的失败原因。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在保留标准 candidate 清洗逻辑的同时，把顶层结构错误收敛成明确失败原因，供重试提示与日志复用。
 * 2) 做什么：明确指出“多包一层 candidate/data/result/payload”这类当前模型常见偏移，避免所有结构问题都退化成同一句泛化报错。
 * 3) 不做什么：不额外兼容包裹结构，不偷偷改写模型结果，只负责给出单一入口的结构诊断。
 *
 * 输入/输出：
 * - 输入：模型原始 JSON、目标功法类型、品质、最大层数。
 * - 输出：`{ success, candidate | reason }`。
 *
 * 数据流/状态流：
 * 文本模型输出 -> 本函数做顶层结构诊断与字段归一化 -> validateTechniqueGenerationCandidate / 重试 guidance / 日志。
 *
 * 关键边界条件与坑点：
 * 1) 这里必须明确拒绝 candidate/data/result/payload 包裹层，而不是默默兼容；否则 prompt 协议会继续漂移。
 * 2) 失败原因需要稳定、具体，才能在下一轮重试提示中精确告诉模型“哪里错了”，避免重复撞同一个 sanitize 失败。
 */
export const sanitizeTechniqueGenerationCandidateFromModelDetailed = (
  raw: unknown,
  techniqueType: GeneratedTechniqueType,
  quality: TechniqueQuality,
  maxLayer: number,
): TechniqueCandidateSanitizeResult => {
  const sourceResult = resolveTechniqueCandidateSourceObject(raw);
  if (!sourceResult.source) {
    return {
      success: false,
      reason: sourceResult.failureReason ?? '模型结果顶层结构非法',
    };
  }
  const source = sourceResult.source;

  const rawTechnique = isTechniquePlainObject(source.technique)
    ? source.technique
    : null;
  if (!rawTechnique) {
    return {
      success: false,
      reason: '模型结果缺少 technique 对象',
    };
  }
  const techniqueName = asString(rawTechnique.name);
  if (!techniqueName) {
    return {
      success: false,
      reason: '模型结果缺少 technique.name',
    };
  }

  const technique: TechniqueGenerationCandidate['technique'] = {
    name: techniqueName,
    type: techniqueType,
    quality,
    maxLayer,
    requiredRealm: asString(readAliasedField(rawTechnique, 'requiredRealm', 'required_realm')) || DEFAULT_REQUIRED_REALM,
    attributeType: asString(readAliasedField(rawTechnique, 'attributeType', 'attribute_type')) === 'physical' ? 'physical' : 'magic',
    attributeElement: asString(readAliasedField(rawTechnique, 'attributeElement', 'attribute_element')) || 'none',
    tags: Array.isArray(rawTechnique.tags)
      ? rawTechnique.tags.map((entry) => asString(entry)).filter(Boolean)
      : [],
    description: asString(rawTechnique.description),
    longDesc: asString(readAliasedField(rawTechnique, 'longDesc', 'long_desc')),
  };

  const rawSkills = Array.isArray(source.skills) ? source.skills : [];
  const skills: TechniqueGenerationCandidate['skills'] = rawSkills.flatMap((rawSkill, idx) => {
    if (!rawSkill || typeof rawSkill !== 'object' || Array.isArray(rawSkill)) return [];
    const row = rawSkill as Record<string, unknown>;
    const name = asString(row.name);
    if (!name) return [];
    const effects = normalizeEffects(row.effects);
    const auraInspectableEffects = effects.map((effect) => ({
      type: typeof effect.type === 'string' ? effect.type : undefined,
      buffKind: typeof effect.buffKind === 'string' ? effect.buffKind : undefined,
    }));
    return [{
      id: asString(row.id) || buildGeneratedSkillId(idx + 1),
      name,
      description: asString(row.description) || `${name}（AI生成）`,
      icon: typeof row.icon === 'string' ? row.icon : null,
      sourceType: 'technique',
      costLingqi: Math.floor(clamp(asNumber(readAliasedField(row, 'costLingqi', 'cost_lingqi'), 10), 0, 80)),
      costLingqiRate: clamp(asNumber(readAliasedField(row, 'costLingqiRate', 'cost_lingqi_rate'), 0), 0, 1),
      costQixue: Math.floor(clamp(asNumber(readAliasedField(row, 'costQixue', 'cost_qixue'), 0), 0, 120)),
      costQixueRate: clamp(asNumber(readAliasedField(row, 'costQixueRate', 'cost_qixue_rate'), 0), 0, 0.95),
      cooldown: Math.floor(clamp(asNumber(row.cooldown, 1), 0, 6)),
      targetType: toTargetType(readAliasedField(row, 'targetType', 'target_type')),
      targetCount: Math.floor(clamp(asNumber(readAliasedField(row, 'targetCount', 'target_count'), 1), 1, 6)),
      damageType: toDamageType(readAliasedField(row, 'damageType', 'damage_type')),
      element: asString(row.element) || technique.attributeElement || 'none',
      effects,
      triggerType: resolveSkillTriggerType({
        triggerType: asString(readAliasedField(row, 'triggerType', 'trigger_type')) || undefined,
        effects: auraInspectableEffects,
      }),
      aiPriority: Math.floor(clamp(asNumber(readAliasedField(row, 'aiPriority', 'ai_priority'), 50), 0, 100)),
      upgrades: Array.isArray(row.upgrades)
        ? row.upgrades.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
            return [sanitizeTechniqueUpgrade(entry as Record<string, unknown>)];
          })
        : [],
    }];
  });

  // 清洗后实际保留的技能ID集合，用于过滤 layer 中引用的不存在技能ID
  const sanitizedSkillIdSet = new Set(skills.map((s) => s.id));

  const rawLayers = Array.isArray(source.layers) ? source.layers : [];
  const orderedLayers = rawLayers
    .map((rawLayer): TechniqueGenerationCandidate['layers'][number] | null => {
      if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) return null;
      const row = rawLayer as Record<string, unknown>;
      const layerNo = Math.floor(clamp(asNumber(row.layer, 0), 1, maxLayer));
      return {
        layer: layerNo,
        costSpiritStones: Math.floor(clamp(asNumber(readAliasedField(row, 'costSpiritStones', 'cost_spirit_stones'), 0), 0, 1_000_000)),
        costExp: Math.floor(clamp(asNumber(readAliasedField(row, 'costExp', 'cost_exp'), 0), 0, 1_000_000)),
        costMaterials: [],
        passives: Array.isArray(row.passives)
          ? row.passives
              .map((entry) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
                const passive = entry as Record<string, unknown>;
                const key = asString(passive.key);
                const value = asNumber(passive.value, Number.NaN);
                if (!isSupportedTechniquePassiveKey(key) || !Number.isFinite(value)) return null;
                return { key, value };
              })
              .filter((entry): entry is { key: string; value: number } => entry !== null)
          : [],
        unlockSkillIds: normalizeTechniqueLayerSkillIds(
          readAliasedField(row, 'unlockSkillIds', 'unlock_skill_ids'),
          sanitizedSkillIdSet,
        ),
        upgradeSkillIds: normalizeTechniqueLayerSkillIds(
          readAliasedField(row, 'upgradeSkillIds', 'upgrade_skill_ids'),
          sanitizedSkillIdSet,
        ),
        layerDesc: asString(readAliasedField(row, 'layerDesc', 'layer_desc')) || `第${layerNo}层`,
      };
    })
    .filter((row): row is TechniqueGenerationCandidate['layers'][number] => row !== null)
    .sort((a, b) => a.layer - b.layer);

  return {
    success: true,
    candidate: {
      technique,
      skills,
      layers: orderedLayers,
    },
  };
};

const buildTechniqueGenerationAttemptFailure = (params: {
  stage: TechniqueGenerationAttemptFailureStage;
  reason: string;
  modelName: string;
  promptSnapshot?: string;
  rawContent?: string;
}): TechniqueGenerationAttemptFailure => {
  return {
    success: false,
    stage: params.stage,
    reason: params.reason,
    modelName: params.modelName,
    promptSnapshot: params.promptSnapshot ?? '{}',
    rawContent: params.rawContent,
  };
};

const logTechniqueGenerationAttemptFailure = (params: {
  generationId: string;
  characterId: number;
  quality: TechniqueQuality;
  attempt: number;
  stage: TechniqueGenerationAttemptFailureStage;
  reason: string;
  modelName: string;
  rawContent?: string;
}): void => {
  console.error('[TechniqueGeneration] AI功法生成尝试失败:', params);
  if (process.env.NODE_ENV === 'production' || !params.rawContent) return;
  console.error('[TechniqueGeneration] AI功法生成原始输出:', {
    generationId: params.generationId,
    characterId: params.characterId,
    attempt: params.attempt,
    stage: params.stage,
    modelName: params.modelName,
    rawContent: params.rawContent,
  });
};

const logTechniqueGenerationTaskFailure = (params: {
  generationId: string;
  characterId: number;
  quality: TechniqueQuality;
  attemptCount: number;
  reason: string;
  stage?: TechniqueGenerationAttemptFailureStage;
  modelName?: string;
}): void => {
  console.error('[TechniqueGeneration] AI功法生成任务失败:', params);
};

export const validateTechniqueGenerationCandidate = (params: {
  candidate: TechniqueGenerationCandidate;
  expectedTechniqueType: GeneratedTechniqueType;
  expectedQuality: TechniqueQuality;
  expectedMaxLayer: number;
}): CandidateValidationResult => {
  const { candidate, expectedTechniqueType, expectedQuality, expectedMaxLayer } = params;
  if (!candidate.technique.name) {
    return { success: false, message: 'AI结果功法名称缺失', code: 'GENERATOR_INVALID' };
  }
  if (candidate.technique.type !== expectedTechniqueType) {
    return { success: false, message: 'AI结果功法类型与目标类型不一致', code: 'GENERATOR_INVALID' };
  }
  if (candidate.technique.quality !== expectedQuality) {
    return { success: false, message: 'AI结果品质与目标品质不一致', code: 'GENERATOR_INVALID' };
  }
  if (candidate.technique.maxLayer !== expectedMaxLayer) {
    return { success: false, message: 'AI结果最大层数非法', code: 'GENERATOR_INVALID' };
  }
  if (candidate.layers.length !== expectedMaxLayer) {
    return { success: false, message: 'AI结果层级数量非法', code: 'GENERATOR_INVALID' };
  }
  if (candidate.skills.length <= 0) {
    return { success: false, message: 'AI结果未生成技能', code: 'GENERATOR_INVALID' };
  }

  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[expectedQuality];
  if (candidate.skills.length < skillCountRange.min || candidate.skills.length > skillCountRange.max) {
    return {
      success: false,
      message: `AI结果技能数量非法，${expectedQuality}品需${skillCountRange.min}~${skillCountRange.max}个技能`,
      code: 'GENERATOR_INVALID',
    };
  }

  const skillIdSet = new Set(candidate.skills.map((skill) => skill.id));
  if (skillIdSet.size !== candidate.skills.length) {
    return { success: false, message: 'AI结果技能ID重复', code: 'GENERATOR_INVALID' };
  }

  const layerNoSet = new Set<number>();
  for (const layer of candidate.layers) {
    if (layer.layer < 1 || layer.layer > expectedMaxLayer) {
      return { success: false, message: 'AI结果层级序号非法', code: 'GENERATOR_INVALID' };
    }
    if (layerNoSet.has(layer.layer)) {
      return { success: false, message: 'AI结果层级序号重复', code: 'GENERATOR_INVALID' };
    }
    layerNoSet.add(layer.layer);

    for (const skillId of layer.unlockSkillIds) {
      if (!skillIdSet.has(skillId)) {
        return { success: false, message: 'AI结果解锁技能ID不存在', code: 'GENERATOR_INVALID' };
      }
    }
    for (const skillId of layer.upgradeSkillIds) {
      if (!skillIdSet.has(skillId)) {
        return { success: false, message: 'AI结果强化技能ID不存在', code: 'GENERATOR_INVALID' };
      }
    }
    if (Array.isArray(layer.costMaterials) && layer.costMaterials.length > 0) {
      return { success: false, message: 'AI结果层级材料必须为空', code: 'GENERATOR_INVALID' };
    }
    if (!Array.isArray(layer.passives) || layer.passives.length <= 0) {
      return { success: false, message: 'AI结果层级被动为空', code: 'GENERATOR_INVALID' };
    }
  }
  if (layerNoSet.size !== expectedMaxLayer) {
    return { success: false, message: 'AI结果层级不完整', code: 'GENERATOR_INVALID' };
  }

  for (const skill of candidate.skills) {
    if (!skill.id || !skill.name) {
      return { success: false, message: 'AI结果技能标识缺失', code: 'GENERATOR_INVALID' };
    }
    if (skill.sourceType !== 'technique') {
      return { success: false, message: 'AI结果技能来源非法', code: 'GENERATOR_INVALID' };
    }
    if (skill.triggerType !== 'active' && skill.triggerType !== 'passive') {
      return { success: false, message: 'AI结果技能触发类型非法', code: 'GENERATOR_INVALID' };
    }
    const passiveSkillValidation = validatePassiveSkillConfig({
      triggerType: skill.triggerType,
      targetType: skill.targetType,
      cooldown: skill.cooldown,
      costLingqi: skill.costLingqi,
      costLingqiRate: skill.costLingqiRate,
      costQixue: skill.costQixue,
      costQixueRate: skill.costQixueRate,
    });
    if (!passiveSkillValidation.success) {
      return {
        success: false,
        message: `AI结果被动技能配置非法：${passiveSkillValidation.reason}`,
        code: 'GENERATOR_INVALID',
      };
    }
    if (skill.cooldown < 0 || skill.cooldown > 6) {
      return { success: false, message: 'AI结果技能冷却越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.costLingqi < 0 || skill.costLingqi > 80) {
      return { success: false, message: 'AI结果技能灵气消耗越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.costLingqiRate < 0 || skill.costLingqiRate > 1) {
      return { success: false, message: 'AI结果技能灵气比例消耗越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.costQixue < 0 || skill.costQixue > 120) {
      return { success: false, message: 'AI结果技能气血消耗越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.costQixueRate < 0 || skill.costQixueRate >= 1) {
      return { success: false, message: 'AI结果技能气血比例消耗越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.targetCount < 1 || skill.targetCount > 6) {
      return { success: false, message: 'AI结果技能目标数量越界', code: 'GENERATOR_INVALID' };
    }
    const targetCountRuleValidation = validateTechniqueSkillTargetCount(
      skill.targetType,
      skill.targetCount,
      'targetCount',
    );
    if (!targetCountRuleValidation.success) {
      return {
        success: false,
        message: `AI结果技能目标配置非法：${targetCountRuleValidation.reason}`,
        code: 'GENERATOR_INVALID',
      };
    }
    const effectListValidation = validateTechniqueSkillEffectList(skill.effects, 'skill.effects', {
      quality: expectedQuality,
    });
    if (!effectListValidation.success) {
      return {
        success: false,
        message: `AI结果技能效果非法：${effectListValidation.reason}`,
        code: 'GENERATOR_INVALID',
      };
    }

    for (const upgrade of skill.upgrades) {
      const upgradeValidation = validateTechniqueSkillUpgrade(
        upgrade,
        expectedMaxLayer,
        skill.targetType,
        { quality: expectedQuality },
      );
      if (!upgradeValidation.success) {
        return {
          success: false,
          message: `AI结果技能升级配置非法：${upgradeValidation.reason}`,
          code: 'GENERATOR_INVALID',
        };
      }
    }
  }

  return { success: true };
};

export const remapTechniqueCandidateSkillIds = (
  candidate: TechniqueGenerationCandidate,
): TechniqueGenerationCandidate => {
  const idMap = new Map<string, string>();
  const remappedSkills = candidate.skills.map((skill, idx) => {
    const nextId = buildGeneratedSkillId(idx + 1);
    idMap.set(skill.id, nextId);
    return {
      ...skill,
      id: nextId,
    };
  });

  const remapLayerSkillIds = (ids: string[]): string[] => {
    return ids
      .map((id) => idMap.get(id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  };

  return {
    ...candidate,
    skills: remappedSkills,
    layers: candidate.layers.map((layer) => ({
      ...layer,
      unlockSkillIds: remapLayerSkillIds(layer.unlockSkillIds),
      upgradeSkillIds: remapLayerSkillIds(layer.upgradeSkillIds),
    })),
  };
};

const tryCallExternalGenerator = async (params: {
  techniqueType: GeneratedTechniqueType;
  quality: TechniqueQuality;
  maxLayer: number;
  promptContext?: Record<string, unknown>;
}): Promise<TechniqueGenerationAttemptResult> => {
  const { techniqueType, quality, maxLayer } = params;
  const request = buildTechniqueGenerationTextModelRequest(params);
  const external = await callConfiguredTextModel({
    modelScope: 'technique',
    ...request,
  });
  if (!external) {
    return buildTechniqueGenerationAttemptFailure({
      stage: 'config_missing',
      reason: '缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置',
      modelName: 'gpt-4o-mini',
    });
  }
  const { content, modelName, promptSnapshot } = external;

  try {
    if (!content) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'empty_response',
        reason: '模型返回内容为空',
        modelName,
        promptSnapshot,
      });
    }

    const parsed = parseTechniqueTextModelJsonObject(content, {
      preferredTopLevelKeys: ['technique', 'skills', 'layers'],
    });
    if (!parsed.success) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'json_parse_failed',
        reason: parsed.reason === 'empty_content' ? '模型返回内容为空' : '模型返回内容不是合法 JSON 对象',
        modelName,
        promptSnapshot,
        rawContent: content,
      });
    }

    const sanitizeResult = sanitizeTechniqueGenerationCandidateFromModelDetailed(
      parsed.data,
      techniqueType,
      quality,
      maxLayer,
    );
    if (!sanitizeResult.success) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'candidate_sanitize_failed',
        reason: sanitizeResult.reason,
        modelName,
        promptSnapshot,
        rawContent: content,
      });
    }

    return {
      success: true,
      candidate: sanitizeResult.candidate,
      modelName,
      promptSnapshot,
    };
  } catch (error) {
    const failure = resolveTechniqueGenerationRequestFailure({
      error,
      didTimeout: false,
      timeoutMs: request.timeoutMs,
    });
    return buildTechniqueGenerationAttemptFailure({
      stage: failure.stage,
      reason: failure.reason,
      modelName,
      promptSnapshot,
      rawContent: content,
    });
  }
};

/**
 * 功法生成文本模型请求构造
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中构造功法生成文本模型请求，把显式 seed 与基于 seed 派生的 prompt 扰动 hash 绑在一起，供洞府研修与伙伴天生功法共同复用。
 * 2) 不做什么：不请求模型、不解析返回，也不在这里决定重试策略。
 *
 * 输入/输出：
 * - 输入：功法类型、品质、最大层数、可选 extraContext 与可选固定 seed（测试用）。
 * - 输出：可直接传给 `callConfiguredTextModel` 的请求参数，以及便于排查的 `promptNoiseHash`。
 *
 * 数据流/状态流：
 * 技术参数/seed -> promptNoiseHash -> buildTechniqueGeneratorPromptInput -> 文本模型调用。
 *
 * 关键边界条件与坑点：
 * 1) 伙伴招募与洞府研修都复用这里，因此扰动逻辑必须保持纯函数，不能依赖任务表或调用方状态。
 * 2) 接入 HASH 扰动时不能覆盖 extraContext；否则伙伴天生功法已经传入的伙伴语境会丢失。
 */
export const buildTechniqueGenerationTextModelRequest = (params: {
  techniqueType: GeneratedTechniqueType;
  quality: TechniqueQuality;
  maxLayer: number;
  promptContext?: Record<string, unknown>;
  seed?: number;
}): {
  responseFormat: ReturnType<typeof buildTechniqueGenerationResponseFormat>;
  systemMessage: string;
  userMessage: string;
  seed: number;
  temperature?: number;
  timeoutMs: number;
  promptNoiseHash: string;
} => {
  const seed = params.seed ?? generateTechniqueTextModelSeed();
  const promptNoiseHash = buildTextModelPromptNoiseHash('technique-generation', seed);
  const timeoutMs = 300_000;
  const retryGuidance = readTechniqueGenerationRetryGuidance(params.promptContext);
  const promptInput = buildTechniqueGeneratorPromptInput({
    techniqueType: params.techniqueType,
    quality: params.quality,
    maxLayer: params.maxLayer,
    effectTypeEnum: Array.from(DAMAGE_EFFECT_TYPE_SET),
    promptNoiseHash,
    retryGuidance,
  });
  const userMessagePayload = params.promptContext
    ? { ...promptInput, extraContext: params.promptContext }
    : promptInput;

  return {
    responseFormat: buildTechniqueGenerationResponseFormat({
      techniqueType: params.techniqueType,
      quality: params.quality,
      maxLayer: params.maxLayer,
    }),
    systemMessage: TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
    userMessage: JSON.stringify(userMessagePayload),
    seed,
    temperature: retryGuidance ? TECHNIQUE_TEXT_MODEL_RETRY_TEMPERATURE : undefined,
    timeoutMs,
    promptNoiseHash,
  };
};

export const generateTechniqueCandidateWithRetry = async (params: {
  generationId: string;
  characterId: number;
  techniqueType: GeneratedTechniqueType;
  quality: TechniqueQuality;
  maxLayer: number;
  promptContext?: Record<string, unknown>;
}): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; attemptCount: number; promptSnapshot: string }> => {
  const { generationId, characterId, techniqueType, quality, maxLayer, promptContext } = params;
  const maxAttempts = 3;
  let lastFailure: TechniqueGenerationAttemptFailure | null = null;
  let attemptCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptCount = attempt;
    const attemptPromptContext = buildTechniqueGenerationRetryPromptContext({
      promptContext,
      previousFailureReason: lastFailure?.reason ?? null,
    });
    const external = await tryCallExternalGenerator({
      techniqueType,
      quality,
      maxLayer,
      promptContext: attemptPromptContext,
    });
    if (!external.success) {
      lastFailure = external;
      logTechniqueGenerationAttemptFailure({
        generationId,
        characterId,
        quality,
        attempt,
        stage: external.stage,
        reason: external.reason,
        modelName: external.modelName,
        rawContent: external.rawContent,
      });
      if (external.stage === 'config_missing') break;
      continue;
    }

    const validate = validateTechniqueGenerationCandidate({
      candidate: external.candidate,
      expectedTechniqueType: techniqueType,
      expectedQuality: quality,
      expectedMaxLayer: maxLayer,
    });
    if (!validate.success) {
      lastFailure = buildTechniqueGenerationAttemptFailure({
        stage: 'candidate_validate_failed',
        reason: validate.message,
        modelName: external.modelName,
        promptSnapshot: external.promptSnapshot,
      });
      logTechniqueGenerationAttemptFailure({
        generationId,
        characterId,
        quality,
        attempt,
        stage: lastFailure.stage,
        reason: lastFailure.reason,
        modelName: lastFailure.modelName,
      });
      continue;
    }

    return {
      candidate: external.candidate,
      modelName: external.modelName,
      attemptCount: attempt,
      promptSnapshot: external.promptSnapshot,
    };
  }

  const finalReason = lastFailure?.reason ?? '未知原因';
  logTechniqueGenerationTaskFailure({
    generationId,
    characterId,
    quality,
    attemptCount,
    reason: finalReason,
    stage: lastFailure?.stage,
    modelName: lastFailure?.modelName,
  });
  throw new TechniqueGenerationExhaustedError(finalReason);
};
