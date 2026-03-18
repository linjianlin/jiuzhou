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
} from './techniqueTextModelShared.js';
import { resolveTechniqueGenerationRequestFailure } from './techniqueGenerationRequestFailure.js';
import {
  buildTechniqueGeneratorPromptInput,
  buildTechniqueGenerationResponseFormat,
  TECHNIQUE_EFFECT_TYPE_LIST,
  TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS,
  TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
  TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY,
  isSupportedTechniquePassiveKey,
  validateTechniqueSkillEffect,
  validateTechniqueSkillUpgrade,
  type GeneratedTechniqueType,
} from './techniqueGenerationConstraints.js';
import {
  resolveSkillTriggerType,
  validatePassiveSkillConfig,
} from '../../shared/skillTriggerType.js';
import type { TechniqueSkillUpgradeEntry } from './techniqueSkillGenerationSpec.js';
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

const DEFAULT_REQUIRED_REALM = '凡人';
const DAMAGE_EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_EFFECT_TYPE_LIST);

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

const sanitizeTechniqueEffect = (raw: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...raw };
  for (const field of TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS) {
    if (field in next) {
      delete next[field];
    }
  }
  return next;
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const rawTechnique = source.technique && typeof source.technique === 'object' && !Array.isArray(source.technique)
    ? (source.technique as Record<string, unknown>)
    : null;
  if (!rawTechnique) return null;
  const techniqueName = asString(rawTechnique.name);
  if (!techniqueName) return null;

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
            return [entry as TechniqueSkillUpgradeEntry];
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
    technique,
    skills,
    layers: orderedLayers,
  };
};

const buildTechniqueGenerationAttemptFailure = (params: {
  stage: TechniqueGenerationAttemptFailureStage;
  reason: string;
  modelName: string;
  promptSnapshot?: string;
}): TechniqueGenerationAttemptFailure => {
  return {
    success: false,
    stage: params.stage,
    reason: params.reason,
    modelName: params.modelName,
    promptSnapshot: params.promptSnapshot ?? '{}',
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
}): void => {
  console.error('[TechniqueGeneration] AI功法生成尝试失败:', params);
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
    if (!Array.isArray(skill.effects) || skill.effects.length === 0) {
      return { success: false, message: 'AI结果技能效果为空', code: 'GENERATOR_INVALID' };
    }

    for (const effect of skill.effects) {
      if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
        return { success: false, message: 'AI结果技能效果结构非法', code: 'GENERATOR_INVALID' };
      }
      const effectValidation = validateTechniqueSkillEffect(effect as SkillEffect);
      if (!effectValidation.success) {
        return {
          success: false,
          message: `AI结果技能效果非法：${effectValidation.reason}`,
          code: 'GENERATOR_INVALID',
        };
      }
    }

    for (const upgrade of skill.upgrades) {
      const upgradeValidation = validateTechniqueSkillUpgrade(upgrade, expectedMaxLayer);
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
  const external = await callConfiguredTextModel(request);
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

    const parsed = parseTechniqueTextModelJsonObject(content);
    if (!parsed.success) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'json_parse_failed',
        reason: parsed.reason === 'empty_content' ? '模型返回内容为空' : '模型返回内容不是合法 JSON 对象',
        modelName,
        promptSnapshot,
      });
    }

    const candidate = sanitizeTechniqueGenerationCandidateFromModel(parsed.data, techniqueType, quality, maxLayer);
    if (!candidate) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'candidate_sanitize_failed',
        reason: '模型结果缺少必要字段或结构非法，无法完成清洗',
        modelName,
        promptSnapshot,
      });
    }

    return {
      success: true,
      candidate,
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
  timeoutMs: number;
  promptNoiseHash: string;
} => {
  const seed = params.seed ?? generateTechniqueTextModelSeed();
  const promptNoiseHash = buildTextModelPromptNoiseHash('technique-generation', seed);
  const timeoutMs = 300_000;
  const promptInput = buildTechniqueGeneratorPromptInput({
    techniqueType: params.techniqueType,
    quality: params.quality,
    maxLayer: params.maxLayer,
    effectTypeEnum: Array.from(DAMAGE_EFFECT_TYPE_SET),
    promptNoiseHash,
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
    const external = await tryCallExternalGenerator({
      techniqueType,
      quality,
      maxLayer,
      promptContext,
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
