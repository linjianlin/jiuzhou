/**
 * AI 生成功法服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供 AI 生成功法草稿、放弃当前推演、自定义命名发布、状态查询。
 * 2) 不做什么：不负责 HTTP 参数解析与鉴权（由路由层处理），不负责前端交互流程。
 *
 * 输入/输出：
 * - 输入：characterId、generationId、customName。
 * - 输出：统一 ServiceResult（success/message/data/code）。
 *
 * 数据流/状态流：
 * 1) 生成：校验周限与功法残页余额 -> 扣除残页建任务(pending) -> AI 生成 -> 落草稿(generated_draft) 或失败退款。
 * 2) 发布：校验草稿状态与命名规则 -> 全服唯一检查 -> 发布功法 -> 发放可交易功法书(published)。
 *
 * 关键边界条件与坑点：
 * 1) 草稿默认 24h 过期，过期后自动退款并置为 refunded。
 * 2) 洞府研修采用统一冷却时间配置，状态接口与创建任务前校验必须复用同一模块，避免前后端展示与服务端拦截不一致。
 */
import { randomUUID } from 'crypto';
import type { SkillEffect } from '../battle/types.js';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { addItemToInventory } from './inventory/index.js';
import { consumeMaterialByDefId } from './inventory/shared/consume.js';
import { getItemDefinitionById, getTechniqueDefinitions, refreshGeneratedTechniqueSnapshots } from './staticConfigLoader.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { getRealmRankZeroBased } from './shared/realmRules.js';
import { buildTechniqueResearchJobState } from './shared/techniqueResearchJobShared.js';
import { normalizeTechniqueName, validateTechniqueCustomName, getTechniqueNameRulesView } from './shared/techniqueNameRules.js';
import { generateTechniqueCandidateWithIcons } from './shared/techniqueGenerationExecution.js';
import {
  buildTechniqueTextModelPayload,
  extractTechniqueTextModelContent,
  parseTechniqueTextModelJsonObject,
  resolveTechniqueTextModelEndpoint,
} from './shared/techniqueTextModelShared.js';
import { resolveTechniqueGenerationRequestFailure } from './shared/techniqueGenerationRequestFailure.js';
import {
  buildTechniqueGeneratorPromptInput,
  TECHNIQUE_EFFECT_TYPE_LIST,
  TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS,
  TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
  TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY,
  isSupportedTechniquePassiveKey,
  validateTechniqueSkillEffect,
  validateTechniqueSkillUpgrade,
} from './shared/techniqueGenerationConstraints.js';
import type { TechniqueSkillUpgradeEntry } from './shared/techniqueSkillGenerationSpec.js';
import {
  buildTechniqueResearchCooldownState,
  formatTechniqueResearchCooldownRemaining,
} from './shared/techniqueResearchCooldown.js';

export type TechniqueGenerationStatus =
  | 'pending'
  | 'generated_draft'
  | 'published'
  | 'failed'
  | 'refunded';

export type TechniqueQuality = '黄' | '玄' | '地' | '天';

export type ServiceResult<T = unknown> = {
  success: boolean;
  message: string;
  data?: T;
  code?: string;
};

export type TechniqueGenerationCandidate = {
  technique: {
    name: string;
    type: '武技' | '心法' | '法诀' | '身法' | '辅修';
    quality: TechniqueQuality;
    maxLayer: number;
    requiredRealm: string;
    attributeType: 'physical' | 'magic';
    attributeElement: string;
    tags: string[];
    description: string;
    longDesc: string;
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    icon: string | null;
    sourceType: 'technique';
    costLingqi: number;
    costLingqiRate: number;
    costQixue: number;
    costQixueRate: number;
    cooldown: number;
    targetType: 'self' | 'single_enemy' | 'single_ally' | 'all_enemy' | 'all_ally' | 'random_enemy' | 'random_ally';
    targetCount: number;
    damageType: 'physical' | 'magic' | 'true' | null;
    element: string;
    effects: unknown[];
    triggerType: 'active';
    aiPriority: number;
    upgrades: TechniqueSkillUpgradeEntry[];
  }>;
  layers: Array<{
    layer: number;
    costSpiritStones: number;
    costExp: number;
    costMaterials: Array<{ itemId: string; qty: number }>;
    passives: Array<{ key: string; value: number }>;
    unlockSkillIds: string[];
    upgradeSkillIds: string[];
    layerDesc: string;
  }>;
};

export type TechniquePreview = {
  draftTechniqueId: string;
  aiSuggestedName: string;
  quality: TechniqueQuality;
  type: string;
  maxLayer: number;
  description: string;
  longDesc: string;
  skillNames: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    icon: string | null;
    costLingqi: number;
    costLingqiRate: number;
    costQixue: number;
    costQixueRate: number;
    cooldown: number;
    targetType: string;
    targetCount: number;
    damageType: string | null;
    element: string;
    effects: unknown[];
  }>;
};

type GeneratedDraftRow = {
  generationId: string;
  id: string;
  quality: TechniqueQuality;
  type: string;
  maxLayer: number;
  description: string;
  longDesc: string;
  suggestedName: string;
  draftExpireAt: string;
};

export type TechniqueResearchResultStatus = 'generated_draft' | 'failed';

export type TechniqueResearchJobView = {
  generationId: string;
  status: TechniqueGenerationStatus;
  quality: TechniqueQuality;
  draftTechniqueId: string | null;
  startedAt: string;
  finishedAt: string | null;
  draftExpireAt: string | null;
  preview: TechniquePreview | null;
  errorMessage: string | null;
};

type TechniqueResearchStatusData = {
  fragmentBalance: number;
  fragmentCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  currentDraft: GeneratedDraftRow | null;
  draftExpireAt: string | null;
  nameRules: ReturnType<typeof getTechniqueNameRulesView>;
  currentJob: TechniqueResearchJobView | null;
  hasUnreadResult: boolean;
  resultStatus: TechniqueResearchResultStatus | null;
};

type TechniqueGenerationAttemptFailureStage =
  | 'config_missing'
  | 'request_timeout'
  | 'request_failed'
  | 'http_error'
  | 'empty_response'
  | 'json_parse_failed'
  | 'candidate_sanitize_failed'
  | 'candidate_validate_failed';

type TechniqueGenerationAttemptSuccess = {
  success: true;
  candidate: TechniqueGenerationCandidate;
  modelName: string;
  promptSnapshot: string;
};

type TechniqueGenerationAttemptFailure = {
  success: false;
  stage: TechniqueGenerationAttemptFailureStage;
  reason: string;
  modelName: string;
  promptSnapshot: string;
};

type TechniqueGenerationAttemptResult =
  | TechniqueGenerationAttemptSuccess
  | TechniqueGenerationAttemptFailure;

class TechniqueGenerationRollbackError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TechniqueGenerationRollbackError';
    this.code = code;
  }
}

class TechniqueGenerationExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TechniqueGenerationExhaustedError';
  }
}

const isTechniqueGenerationRollbackError = (
  error: unknown,
): error is TechniqueGenerationRollbackError => {
  return error instanceof TechniqueGenerationRollbackError;
};

const DRAFT_EXPIRE_HOURS = 24;
const DEFAULT_REQUIRED_REALM = '凡人';
const GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID = 'book-generated-technique';
const DEFAULT_GENERATED_SKILL_ICON = '/assets/skills/icon_skill_44.png';
const TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID = 'mat-gongfa-canye';
const TECHNIQUE_RESEARCH_FRAGMENT_COST = 5_000;

const QUALITY_MAX_LAYER: Record<TechniqueQuality, number> = {
  黄: 3,
  玄: 5,
  地: 7,
  天: 9,
};

const QUALITY_RANDOM_WEIGHT: Array<{ quality: TechniqueQuality; weight: number }> = [
  { quality: '黄', weight: 55 },
  { quality: '玄', weight: 30 },
  { quality: '地', weight: 12 },
  { quality: '天', weight: 3 },
];

const DAMAGE_EFFECT_TYPE_SET = new Set<string>(TECHNIQUE_EFFECT_TYPE_LIST);

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const asNumber = (raw: unknown, fallback = 0): number => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const resolveWeekKey = (date: Date): string => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const weekStr = String(weekNo).padStart(2, '0');
  return `${d.getUTCFullYear()}-W${weekStr}`;
};

const resolveQualityByWeight = (): TechniqueQuality => {
  const totalWeight = QUALITY_RANDOM_WEIGHT.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return '黄';
  const roll = Math.random() * totalWeight;
  let cursor = 0;
  for (const row of QUALITY_RANDOM_WEIGHT) {
    cursor += row.weight;
    if (roll <= cursor) return row.quality;
  }
  return QUALITY_RANDOM_WEIGHT[QUALITY_RANDOM_WEIGHT.length - 1]?.quality ?? '黄';
};

const toTechniqueType = (raw: unknown): TechniqueGenerationCandidate['technique']['type'] => {
  const text = asString(raw);
  if (text === '武技' || text === '心法' || text === '法诀' || text === '身法' || text === '辅修') {
    return text;
  }
  return '武技';
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

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
};

const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmRankZeroBased(realmRaw, subRealmRaw);
};

const isRealmSufficient = (currentRealm: unknown, requiredRealm: unknown, currentSubRealm?: unknown): boolean => {
  const required = asString(requiredRealm);
  if (!required) return true;
  return getRealmRank(currentRealm, currentSubRealm) >= getRealmRank(required);
};

const buildGenerationId = (): string => {
  return `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const buildGeneratedTechniqueId = (): string => {
  return `tech-gen-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
};

const buildGeneratedSkillId = (idx: number): string => {
  return `skill-gen-${Date.now().toString(36)}-${idx}-${randomUUID().slice(0, 4)}`;
};

const isUndefinedTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '42P01';
};

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '23505';
};

const serializePromptSnapshot = (payload: Record<string, unknown>): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{}';
  }
};

const toIsoString = (raw: unknown): string | null => {
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => asString(entry)).filter(Boolean);
};

const toTechniquePreviewSkills = (raw: unknown): TechniquePreview['skills'] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const id = asString(row.id);
    const name = asString(row.name);
    if (!id || !name) return [];
    return [{
      id,
      name,
      description: asString(row.description),
      icon: asString(row.icon) || null,
      costLingqi: Math.max(0, Math.floor(asNumber(row.costLingqi ?? row.cost_lingqi, 0))),
      costLingqiRate: Math.max(0, asNumber(row.costLingqiRate ?? row.cost_lingqi_rate, 0)),
      costQixue: Math.max(0, Math.floor(asNumber(row.costQixue ?? row.cost_qixue, 0))),
      costQixueRate: Math.max(0, asNumber(row.costQixueRate ?? row.cost_qixue_rate, 0)),
      cooldown: Math.max(0, Math.floor(asNumber(row.cooldown, 0))),
      targetType: asString(row.targetType ?? row.target_type),
      targetCount: Math.max(1, Math.floor(asNumber(row.targetCount ?? row.target_count, 1))),
      damageType: asString(row.damageType ?? row.damage_type) || null,
      element: asString(row.element) || 'none',
      effects: Array.isArray(row.effects) ? row.effects : [],
    }];
  });
};

const buildTechniquePreviewFromRow = (
  row: Record<string, unknown>,
  qualityFallback: TechniqueQuality,
): TechniquePreview | null => {
  const draftTechniqueId = asString(row.draft_technique_id);
  const suggestedName = asString(row.suggested_name);
  const type = asString(row.technique_type);
  if (!draftTechniqueId || !suggestedName || !type) return null;

  return {
    draftTechniqueId,
    aiSuggestedName: suggestedName,
    quality: (asString(row.technique_quality) as TechniqueQuality) || qualityFallback,
    type,
    maxLayer: Math.max(1, Math.floor(asNumber(row.max_layer, 1))),
    description: asString(row.description),
    longDesc: asString(row.long_desc),
    skillNames: toStringArray(row.skill_names),
    skills: toTechniquePreviewSkills(row.skill_previews),
  };
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

const normalizeEffects = (raw: unknown): unknown[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => sanitizeTechniqueEffect(entry as Record<string, unknown>))
    .filter((entry) => DAMAGE_EFFECT_TYPE_SET.has(String((entry as Record<string, unknown>).type || '')));
};

const validateCandidate = (
  candidate: TechniqueGenerationCandidate,
  expectedQuality: TechniqueQuality,
): ServiceResult<null> => {
  const quality = candidate.technique.quality;
  if (!candidate.technique.name) {
    return { success: false, message: 'AI结果功法名称缺失', code: 'GENERATOR_INVALID' };
  }
  if (quality !== expectedQuality) {
    return { success: false, message: 'AI结果品质与随机品质不一致', code: 'GENERATOR_INVALID' };
  }

  const expectedMaxLayer = QUALITY_MAX_LAYER[quality];
  if (candidate.technique.maxLayer !== expectedMaxLayer) {
    return { success: false, message: 'AI结果最大层数非法', code: 'GENERATOR_INVALID' };
  }

  if (candidate.layers.length !== expectedMaxLayer) {
    return { success: false, message: 'AI结果层级数量非法', code: 'GENERATOR_INVALID' };
  }

  if (candidate.skills.length <= 0) {
    return { success: false, message: 'AI结果未生成技能', code: 'GENERATOR_INVALID' };
  }
  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[quality];
  if (candidate.skills.length < skillCountRange.min || candidate.skills.length > skillCountRange.max) {
    return {
      success: false,
      message: `AI结果技能数量非法，${quality}品需${skillCountRange.min}~${skillCountRange.max}个技能`,
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
    if (skill.cooldown < 0 || skill.cooldown > 6) {
      return { success: false, message: 'AI结果技能冷却越界', code: 'GENERATOR_INVALID' };
    }
    if (skill.costLingqi < 0 || skill.costLingqi > 80) {
      return { success: false, message: 'AI结果技能消耗越界', code: 'GENERATOR_INVALID' };
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

  return { success: true, message: 'ok', data: null };
};

const sanitizeCandidateFromModel = (raw: unknown, quality: TechniqueQuality): TechniqueGenerationCandidate | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const rawTechnique = source.technique && typeof source.technique === 'object' && !Array.isArray(source.technique)
    ? (source.technique as Record<string, unknown>)
    : null;
  if (!rawTechnique) return null;
  const type = toTechniqueType(rawTechnique?.type);
  const maxLayer = QUALITY_MAX_LAYER[quality];
  const techniqueName = asString(rawTechnique?.name);
  if (!techniqueName) return null;

  const technique: TechniqueGenerationCandidate['technique'] = {
    name: techniqueName,
    type,
    quality,
    maxLayer,
    requiredRealm: asString(rawTechnique?.requiredRealm) || DEFAULT_REQUIRED_REALM,
    attributeType: asString(rawTechnique?.attributeType) === 'physical' ? 'physical' : 'magic',
    attributeElement: asString(rawTechnique?.attributeElement) || 'none',
    tags: Array.isArray(rawTechnique?.tags)
      ? rawTechnique!.tags!.map((entry) => asString(entry)).filter(Boolean)
      : [],
    description: asString(rawTechnique?.description),
    longDesc: asString(rawTechnique?.longDesc),
  };

  const rawSkills = Array.isArray(source.skills) ? source.skills : [];
  const skills: TechniqueGenerationCandidate['skills'] = rawSkills.flatMap((rawSkill, idx) => {
    if (!rawSkill || typeof rawSkill !== 'object' || Array.isArray(rawSkill)) return [];
    const row = rawSkill as Record<string, unknown>;
    const name = asString(row.name);
    if (!name) return [];
    const normalizedEffects = normalizeEffects(row.effects);
    const skill: TechniqueGenerationCandidate['skills'][number] = {
      id: asString(row.id) || buildGeneratedSkillId(idx + 1),
      name,
      description: asString(row.description) || `${name}（AI生成）`,
      icon: typeof row.icon === 'string' ? row.icon : null,
      sourceType: 'technique' as const,
      costLingqi: Math.floor(clamp(asNumber(row.costLingqi, 10), 0, 80)),
      costLingqiRate: clamp(asNumber(row.costLingqiRate, 0), 0, 1),
      costQixue: Math.floor(clamp(asNumber(row.costQixue, 0), 0, 120)),
      costQixueRate: clamp(asNumber(row.costQixueRate, 0), 0, 0.95),
      cooldown: Math.floor(clamp(asNumber(row.cooldown, 1), 0, 6)),
      targetType: toTargetType(row.targetType),
      targetCount: Math.floor(clamp(asNumber(row.targetCount, 1), 1, 6)),
      damageType: toDamageType(row.damageType),
      element: asString(row.element) || technique.attributeElement || 'none',
      effects: normalizedEffects,
      triggerType: 'active' as const,
      aiPriority: Math.floor(clamp(asNumber(row.aiPriority, 50), 0, 100)),
      upgrades: Array.isArray(row.upgrades)
        ? row.upgrades.flatMap((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
            return [entry as TechniqueSkillUpgradeEntry];
          })
        : [],
    };
    return [skill];
  });

  const rawLayers = Array.isArray(source.layers) ? source.layers : [];
  const orderedLayers = rawLayers
    .map((rawLayer): TechniqueGenerationCandidate['layers'][number] | null => {
      if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) return null;
      const row = rawLayer as Record<string, unknown>;
      const layerNo = Math.floor(clamp(asNumber(row.layer, 0), 1, maxLayer));
      return {
        layer: layerNo,
        costSpiritStones: Math.floor(clamp(asNumber(row.costSpiritStones, 0), 0, 1000000)),
        costExp: Math.floor(clamp(asNumber(row.costExp, 0), 0, 1000000)),
        costMaterials: [] as Array<{ itemId: string; qty: number }>,
        passives: Array.isArray(row.passives)
          ? row.passives
              .map((entry) => {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
                const passive = entry as Record<string, unknown>;
                const key = asString(passive.key);
                const value = asNumber(passive.value, NaN);
                if (!isSupportedTechniquePassiveKey(key) || !Number.isFinite(value)) return null;
                return { key, value };
              })
              .filter((entry): entry is { key: string; value: number } => Boolean(entry))
          : [],
        unlockSkillIds: Array.isArray(row.unlockSkillIds)
          ? row.unlockSkillIds.map((entry) => asString(entry)).filter(Boolean)
          : [],
        upgradeSkillIds: Array.isArray(row.upgradeSkillIds)
          ? row.upgradeSkillIds.map((entry) => asString(entry)).filter(Boolean)
          : [],
        layerDesc: asString(row.layerDesc) || `第${layerNo}层`,
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

const summarizeHttpErrorResponse = (responseText: string): string => {
  const normalized = responseText.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.slice(0, 300);
};

const tryCallExternalGenerator = async (quality: TechniqueQuality): Promise<TechniqueGenerationAttemptResult> => {
  const endpoint = resolveTechniqueTextModelEndpoint(asString(process.env.AI_TECHNIQUE_MODEL_URL));
  const apiKey = asString(process.env.AI_TECHNIQUE_MODEL_KEY);
  const modelName = asString(process.env.AI_TECHNIQUE_MODEL_NAME) || 'gpt-4o-mini';
  if (!endpoint || !apiKey) {
    return buildTechniqueGenerationAttemptFailure({
      stage: 'config_missing',
      reason: '缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置',
      modelName,
    });
  }
  const promptInput = buildTechniqueGeneratorPromptInput({
    quality,
    maxLayer: QUALITY_MAX_LAYER[quality],
    effectTypeEnum: Array.from(DAMAGE_EFFECT_TYPE_SET),
  });

  const payload = buildTechniqueTextModelPayload({
    modelName,
    systemMessage: TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
    userMessage: JSON.stringify(promptInput),
  });
  const promptSnapshot = serializePromptSnapshot(payload as unknown as Record<string, unknown>);

  const controller = new AbortController();
  const timeoutMs = 300_000;
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const responseText = await resp.text();
      const responseSummary = summarizeHttpErrorResponse(responseText);
      return buildTechniqueGenerationAttemptFailure({
        stage: 'http_error',
        reason: responseSummary
          ? `模型接口返回非成功状态：${resp.status}（endpoint=${endpoint}，body=${responseSummary}）`
          : `模型接口返回非成功状态：${resp.status}（endpoint=${endpoint}）`,
        modelName,
        promptSnapshot,
      });
    }
    const body = (await resp.json()) as Record<string, unknown>;
    const content = extractTechniqueTextModelContent(
      ((body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as {
        content?: string | Array<{ text?: string | null }> | null;
      } | undefined)?.content,
    );
    if (!content) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'empty_response',
        reason: '模型返回内容为空',
        modelName,
        promptSnapshot,
      });
    }

    const parsedResult = parseTechniqueTextModelJsonObject(content);
    if (!parsedResult.success) {
      return buildTechniqueGenerationAttemptFailure({
        stage: 'json_parse_failed',
        reason: parsedResult.reason === 'empty_content'
          ? '模型返回内容为空'
          : '模型返回内容不是合法 JSON 对象',
        modelName,
        promptSnapshot,
      });
    }

    const candidate = sanitizeCandidateFromModel(parsedResult.data, quality);
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
      didTimeout,
      timeoutMs,
    });
    return buildTechniqueGenerationAttemptFailure({
      stage: failure.stage,
      reason: failure.reason,
      modelName,
      promptSnapshot,
    });
  } finally {
    clearTimeout(timer);
  }
};

const generateCandidateWithRetry = async (args: {
  generationId: string;
  characterId: number;
  quality: TechniqueQuality;
}): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; attemptCount: number; promptSnapshot: string }> => {
  const { generationId, characterId, quality } = args;
  const maxAttempts = 3;
  let lastFailure: TechniqueGenerationAttemptFailure | null = null;
  let attemptCount = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptCount = attempt;
    const external = await tryCallExternalGenerator(quality);
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
    const validate = validateCandidate(external.candidate, quality);
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

const remapGeneratedSkillIds = (
  candidate: TechniqueGenerationCandidate,
): TechniqueGenerationCandidate => {
  const idMap = new Map<string, string>();
  const remappedSkills = candidate.skills.map((skill, idx) => {
    const generatedSkillId = buildGeneratedSkillId(idx + 1);
    idMap.set(skill.id, generatedSkillId);
    return {
      ...skill,
      id: generatedSkillId,
    };
  });

  const remapLayerSkillIds = (ids: string[]): string[] => {
    return ids
      .map((id) => idMap.get(id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  };

  const remappedLayers = candidate.layers.map((layer) => ({
    ...layer,
    unlockSkillIds: remapLayerSkillIds(layer.unlockSkillIds),
    upgradeSkillIds: remapLayerSkillIds(layer.upgradeSkillIds),
  }));

  return {
    ...candidate,
    skills: remappedSkills,
    layers: remappedLayers,
  };
};

class TechniqueGenerationService {
  private async getResearchFragmentBalanceTx(characterId: number): Promise<number> {
    const fragmentRes = await query(
      `
        SELECT COALESCE(SUM(qty), 0) AS fragment_balance
        FROM item_instance
        WHERE owner_character_id = $1
          AND item_def_id = $2
          AND location IN ('bag', 'warehouse')
          AND locked = false
      `,
      [characterId, TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID],
    );
    return Math.max(
      0,
      Math.floor(asNumber((fragmentRes.rows[0] as Record<string, unknown> | undefined)?.fragment_balance, 0)),
    );
  }

  private async refundFragmentsToInventoryTx(characterId: number, qty: number, obtainedFrom: string): Promise<void> {
    const refundQty = Math.max(0, Math.floor(asNumber(qty, 0)));
    if (refundQty <= 0) return;

    const characterRes = await query(
      `
        SELECT user_id
        FROM characters
        WHERE id = $1
        LIMIT 1
      `,
      [characterId],
    );
    const userId = Math.floor(asNumber((characterRes.rows[0] as Record<string, unknown> | undefined)?.user_id, 0));
    if (userId <= 0) {
      throw new Error('退款失败：角色不存在');
    }

    const addRes = await addItemToInventory(characterId, userId, TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID, refundQty, {
      obtainedFrom,
    });
    if (!addRes.success) {
      throw new Error(addRes.message || '退款失败：功法残页回退失败');
    }
  }

  private async applyGenerationFragmentRefundTx(
    characterId: number,
    refundEntries: Array<{ generationId: string; refundFragments: number }>,
  ): Promise<void> {
    const refundableEntries = refundEntries.filter((entry) => entry.generationId && entry.refundFragments > 0);
    for (const entry of refundableEntries) {
      await this.refundFragmentsToInventoryTx(
        characterId,
        entry.refundFragments,
        `technique_research_refund:${entry.generationId}`,
      );
    }
  }

  @Transactional
  private async refundExpiredDraftJobsTx(characterId: number): Promise<void> {
    const expiredRes = await query(
      `
        SELECT id, cost_points
        FROM technique_generation_job
        WHERE character_id = $1
          AND status = 'generated_draft'
          AND draft_expire_at IS NOT NULL
          AND draft_expire_at <= NOW()
        FOR UPDATE
      `,
      [characterId],
    );

    if (expiredRes.rows.length === 0) return;

    await this.applyGenerationFragmentRefundTx(
      characterId,
      (expiredRes.rows as Array<Record<string, unknown>>).map((row) => ({
        generationId: asString(row.id),
        refundFragments: Math.max(0, Math.floor(asNumber(row.cost_points, 0))),
      })),
    );

    await query(
      `
        UPDATE technique_generation_job
        SET status = 'refunded',
            error_code = 'GENERATION_EXPIRED',
            error_message = '草稿已过期，系统已自动退还功法残页',
            finished_at = COALESCE(finished_at, NOW()),
            failed_viewed_at = NULL,
            updated_at = NOW()
        WHERE character_id = $1
          AND status = 'generated_draft'
          AND draft_expire_at IS NOT NULL
          AND draft_expire_at <= NOW()
      `,
      [characterId],
    );
  }

  async getResearchStatus(characterId: number): Promise<ServiceResult<TechniqueResearchStatusData>> {
    await this.refundExpiredDraftJobsTx(characterId);

    const [fragmentBalance, draftRes, currentJobRes] = await Promise.all([
      this.getResearchFragmentBalanceTx(characterId),
      query(
        `
          SELECT
            j.id AS generation_id,
            j.draft_technique_id,
            j.draft_expire_at,
            d.quality,
            d.type,
            d.max_layer,
            d.description,
            d.long_desc,
            d.name
          FROM technique_generation_job j
          JOIN generated_technique_def d ON d.id = j.draft_technique_id
          WHERE j.character_id = $1
            AND j.status = 'generated_draft'
          ORDER BY j.created_at DESC
          LIMIT 1
        `,
        [characterId],
      ),
      query(
        `
          SELECT
            j.id AS generation_id,
            j.status,
            j.quality_rolled,
            j.draft_technique_id,
            j.created_at,
            j.finished_at,
            j.draft_expire_at,
            j.error_message,
            j.viewed_at,
            j.failed_viewed_at,
            d.name AS suggested_name,
            d.quality AS technique_quality,
            d.type AS technique_type,
            d.max_layer,
            d.description,
            d.long_desc,
            (
              SELECT json_agg(s.name ORDER BY s.created_at ASC)
              FROM generated_skill_def s
              WHERE s.generation_id = j.id
            ) AS skill_names,
            (
              SELECT json_agg(
                json_build_object(
                  'id', s.id,
                  'name', s.name,
                  'description', s.description,
                  'icon', s.icon,
                  'costLingqi', s.cost_lingqi,
                  'costLingqiRate', s.cost_lingqi_rate,
                  'costQixue', s.cost_qixue,
                  'costQixueRate', s.cost_qixue_rate,
                  'cooldown', s.cooldown,
                  'targetType', s.target_type,
                  'targetCount', s.target_count,
                  'damageType', s.damage_type,
                  'element', s.element,
                  'effects', s.effects
                )
                ORDER BY s.created_at ASC, s.id ASC
              )
              FROM generated_skill_def s
              WHERE s.generation_id = j.id
            ) AS skill_previews
          FROM technique_generation_job j
          LEFT JOIN generated_technique_def d ON d.id = j.draft_technique_id
          WHERE j.character_id = $1
          ORDER BY j.created_at DESC
          LIMIT 1
        `,
        [characterId],
        ),
    ]);

    const draftRow = draftRes.rows[0] as Record<string, unknown> | undefined;
    const currentDraft: GeneratedDraftRow | null = draftRow
      ? {
          generationId: asString(draftRow.generation_id),
          id: asString(draftRow.draft_technique_id),
          quality: (asString(draftRow.quality) as TechniqueQuality) || '黄',
          type: asString(draftRow.type) || '武技',
          maxLayer: Math.max(1, Math.floor(asNumber(draftRow.max_layer, 1))),
          description: asString(draftRow.description),
          longDesc: asString(draftRow.long_desc),
          suggestedName: asString(draftRow.name),
          draftExpireAt: new Date(String(draftRow.draft_expire_at || '')).toISOString(),
        }
      : null;
    const currentJobRow = currentJobRes.rows[0] as Record<string, unknown> | undefined;
    const currentJobState = buildTechniqueResearchJobState(
      currentJobRow
        ? {
            generationId: asString(currentJobRow.generation_id),
            status: (asString(currentJobRow.status) as TechniqueGenerationStatus) || 'pending',
            quality: (asString(currentJobRow.quality_rolled) as TechniqueQuality) || '黄',
            draftTechniqueId: asString(currentJobRow.draft_technique_id) || null,
            draftExpireAt: toIsoString(currentJobRow.draft_expire_at),
            startedAt: toIsoString(currentJobRow.created_at) || new Date().toISOString(),
            finishedAt: toIsoString(currentJobRow.finished_at),
            viewedAt: toIsoString(currentJobRow.viewed_at),
            failedViewedAt: toIsoString(currentJobRow.failed_viewed_at),
            errorMessage: asString(currentJobRow.error_message) || null,
            preview: buildTechniquePreviewFromRow(
              currentJobRow,
              (asString(currentJobRow.quality_rolled) as TechniqueQuality) || '黄',
            ),
          }
        : null,
    );
    const cooldownState = buildTechniqueResearchCooldownState(currentJobState.currentJob?.startedAt ?? null);

    return {
      success: true,
      message: '获取成功',
      data: {
        fragmentBalance,
        fragmentCost: TECHNIQUE_RESEARCH_FRAGMENT_COST,
        cooldownHours: cooldownState.cooldownHours,
        cooldownUntil: cooldownState.cooldownUntil,
        cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
        currentDraft,
        draftExpireAt: currentDraft?.draftExpireAt ?? null,
        nameRules: getTechniqueNameRulesView(),
        currentJob: currentJobState.currentJob,
        hasUnreadResult: currentJobState.hasUnreadResult,
        resultStatus: currentJobState.resultStatus,
      },
    };
  }

  @Transactional
  private async createGenerationJobTx(characterId: number): Promise<ServiceResult<{ generationId: string; quality: TechniqueQuality; costPoints: number; weekKey: string }>> {
    await this.refundExpiredDraftJobsTx(characterId);

    const charRes = await query(
      `
        SELECT id
        FROM characters
        WHERE id = $1
        FOR UPDATE
      `,
      [characterId],
    );
    if (charRes.rows.length === 0) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    const latestJobRes = await query(
      `
        SELECT created_at
        FROM technique_generation_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    const latestStartedAt = toIsoString((latestJobRes.rows[0] as Record<string, unknown> | undefined)?.created_at);
    const cooldownState = buildTechniqueResearchCooldownState(latestStartedAt);
    if (cooldownState.isCoolingDown) {
      return {
        success: false,
        message: `洞府研修冷却中，还需等待${formatTechniqueResearchCooldownRemaining(cooldownState.cooldownRemainingSeconds)}`,
        code: 'RESEARCH_COOLDOWN_ACTIVE',
      };
    }
    const weekKey = resolveWeekKey(new Date());

    const quality = resolveQualityByWeight();
    const costPoints = TECHNIQUE_RESEARCH_FRAGMENT_COST;
    const fragmentBalance = await this.getResearchFragmentBalanceTx(characterId);
    if (fragmentBalance < costPoints) {
      return {
        success: false,
        message: `功法残页不足，需要${costPoints}页，当前${fragmentBalance}页`,
        code: 'FRAGMENT_NOT_ENOUGH',
      };
    }
    const consumeRes = await consumeMaterialByDefId(characterId, TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID, costPoints);
    if (!consumeRes.success) {
      return {
        success: false,
        message: consumeRes.message === '材料已锁定'
          ? '功法残页已锁定，无法用于洞府研修'
          : `功法残页不足，需要${costPoints}页，当前${fragmentBalance}页`,
        code: consumeRes.message === '材料已锁定' ? 'FRAGMENT_LOCKED' : 'FRAGMENT_NOT_ENOUGH',
      };
    }

    const generationId = buildGenerationId();
    await query(
      `
        INSERT INTO technique_generation_job (
          id,
          character_id,
          week_key,
          status,
          quality_rolled,
          cost_points,
          draft_expire_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, 'pending', $4, $5,
          NULL,
          NOW(), NOW()
        )
      `,
      [generationId, characterId, weekKey, quality, costPoints],
    );

    return {
      success: true,
      message: '创建任务成功',
      data: { generationId, quality, costPoints, weekKey },
    };
  }

  @Transactional
  private async saveGeneratedDraftTx(args: {
    characterId: number;
    generationId: string;
    quality: TechniqueQuality;
    modelName: string;
    promptSnapshot: string;
    attemptCount: number;
    candidate: TechniqueGenerationCandidate;
  }): Promise<ServiceResult<{ draftTechniqueId: string; preview: TechniquePreview }>> {
    const {
      characterId,
      generationId,
      quality,
      modelName,
      promptSnapshot,
      attemptCount,
      candidate,
    } = args;

    const jobRes = await query(
      `
        SELECT id, status
        FROM technique_generation_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length === 0) {
      return { success: false, message: '生成任务不存在', code: 'GENERATION_NOT_FOUND' };
    }

    const status = asString((jobRes.rows[0] as Record<string, unknown>).status);
    if (status !== 'pending') {
      return { success: false, message: '生成任务状态异常', code: 'GENERATION_STATE_INVALID' };
    }

    const validate = validateCandidate(candidate, quality);
    if (!validate.success) {
      return { success: false, message: validate.message, code: validate.code };
    }

    // 强制由系统重建技能ID，避免模型返回ID污染全局主键空间。
    const normalizedCandidate = remapGeneratedSkillIds(candidate);
    const validateNormalized = validateCandidate(normalizedCandidate, quality);
    if (!validateNormalized.success) {
      return { success: false, message: validateNormalized.message, code: validateNormalized.code };
    }

    const draftTechniqueId = buildGeneratedTechniqueId();
    await query(
      `
        INSERT INTO generated_technique_def (
          id,
          generation_id,
          created_by_character_id,
          name,
          type,
          quality,
          max_layer,
          required_realm,
          attribute_type,
          attribute_element,
          tags,
          description,
          long_desc,
          icon,
          is_published,
          enabled,
          version,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7,
          $8, $9, $10,
          $11::jsonb,
          $12, $13, $14,
          false, true, 1, NOW(), NOW()
        )
      `,
      [
        draftTechniqueId,
        generationId,
        characterId,
        normalizedCandidate.technique.name,
        normalizedCandidate.technique.type,
        normalizedCandidate.technique.quality,
        normalizedCandidate.technique.maxLayer,
        normalizedCandidate.technique.requiredRealm,
        normalizedCandidate.technique.attributeType,
        normalizedCandidate.technique.attributeElement,
        JSON.stringify(normalizedCandidate.technique.tags),
        normalizedCandidate.technique.description,
        normalizedCandidate.technique.longDesc,
        DEFAULT_GENERATED_SKILL_ICON,
      ],
    );

    for (const skill of normalizedCandidate.skills) {
      await query(
        `
          INSERT INTO generated_skill_def (
            id,
            generation_id,
            source_type,
            source_id,
            code,
            name,
            description,
            icon,
            cost_lingqi,
            cost_lingqi_rate,
            cost_qixue,
            cost_qixue_rate,
            cooldown,
            target_type,
            target_count,
            damage_type,
            element,
            effects,
            trigger_type,
            ai_priority,
            upgrades,
            enabled,
            version,
            created_at,
            updated_at
          ) VALUES (
            $1, $2,
            'technique', $3,
            $4, $5, $6, $7,
            $8, $9, $10, $11,
            $12, $13, $14,
            $15, $16, $17::jsonb,
            $18, $19,
            $20::jsonb,
            true, 1, NOW(), NOW()
          )
        `,
        [
          skill.id,
          generationId,
          draftTechniqueId,
          skill.id,
          skill.name,
          skill.description,
          skill.icon,
          skill.costLingqi,
          skill.costLingqiRate,
          skill.costQixue,
          skill.costQixueRate,
          skill.cooldown,
          skill.targetType,
          skill.targetCount,
          skill.damageType,
          skill.element,
          JSON.stringify(skill.effects),
          skill.triggerType,
          skill.aiPriority,
          JSON.stringify(skill.upgrades),
        ],
      );
    }

    for (const layer of normalizedCandidate.layers) {
      await query(
        `
          INSERT INTO generated_technique_layer (
            generation_id,
            technique_id,
            layer,
            cost_spirit_stones,
            cost_exp,
            cost_materials,
            passives,
            unlock_skill_ids,
            upgrade_skill_ids,
            required_realm,
            layer_desc,
            enabled,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3,
            $4, $5,
            $6::jsonb,
            $7::jsonb,
            $8::text[],
            $9::text[],
            $10,
            $11,
            true,
            NOW(), NOW()
          )
        `,
        [
          generationId,
          draftTechniqueId,
          layer.layer,
          layer.costSpiritStones,
          layer.costExp,
          JSON.stringify(layer.costMaterials),
          JSON.stringify(layer.passives),
          layer.unlockSkillIds,
          layer.upgradeSkillIds,
          normalizedCandidate.technique.requiredRealm,
          layer.layerDesc,
        ],
      );
    }

    await query(
      `
        UPDATE technique_generation_job
        SET status = 'generated_draft',
            draft_technique_id = $2,
            attempt_count = $3,
            model_name = $4,
            prompt_snapshot = $5::jsonb,
            draft_expire_at = NOW() + ($6::int * INTERVAL '1 hour'),
            finished_at = NOW(),
            viewed_at = NULL,
            failed_viewed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [generationId, draftTechniqueId, attemptCount, modelName, promptSnapshot, DRAFT_EXPIRE_HOURS],
    );

    return {
      success: true,
      message: '领悟草稿成功',
      data: {
        draftTechniqueId,
        preview: {
          draftTechniqueId,
          aiSuggestedName: normalizedCandidate.technique.name,
          quality,
          type: normalizedCandidate.technique.type,
          maxLayer: normalizedCandidate.technique.maxLayer,
          description: normalizedCandidate.technique.description,
          longDesc: normalizedCandidate.technique.longDesc,
          skillNames: normalizedCandidate.skills.map((skill) => skill.name),
          skills: normalizedCandidate.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            icon: skill.icon,
            costLingqi: skill.costLingqi,
            costLingqiRate: skill.costLingqiRate,
            costQixue: skill.costQixue,
            costQixueRate: skill.costQixueRate,
            cooldown: skill.cooldown,
            targetType: skill.targetType,
            targetCount: skill.targetCount,
            damageType: skill.damageType,
            element: skill.element,
            effects: skill.effects,
          })),
        },
      },
    };
  }

  @Transactional
  private async refundGenerationJobTx(
    characterId: number,
    generationId: string,
    reason: string,
    nextStatus: 'failed' | 'refunded' = 'refunded',
    errorCode: string = nextStatus === 'failed' ? 'GENERATION_FAILED' : 'GENERATION_REFUNDED',
  ): Promise<void> {
    const jobRes = await query(
      `
        SELECT status, cost_points
        FROM technique_generation_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length === 0) return;

    const row = jobRes.rows[0] as Record<string, unknown>;
    const status = asString(row.status);
    const costPoints = Math.max(0, Math.floor(asNumber(row.cost_points, 0)));
    if (status === 'refunded' || status === 'failed' || status === 'published') return;

    await this.applyGenerationFragmentRefundTx(characterId, [
      {
        generationId,
        refundFragments: costPoints,
      },
    ]);

    await query(
      `
        UPDATE technique_generation_job
        SET status = $2,
            error_code = $3,
            error_message = $4,
            finished_at = NOW(),
            failed_viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [generationId, nextStatus, errorCode, reason],
    );
  }

  async processPendingGenerationJob(args: {
    characterId: number;
    generationId: string;
    quality: TechniqueQuality;
  }): Promise<ServiceResult<{
    generationId: string;
    status: TechniqueResearchResultStatus;
    preview: TechniquePreview | null;
    errorMessage: string | null;
  }>> {
    const { characterId, generationId, quality } = args;

    try {
      const generated = await generateCandidateWithRetry({
        generationId,
        characterId,
        quality,
      });
      const executionResult = await generateTechniqueCandidateWithIcons({
        quality,
        candidate: generated.candidate,
        defaultSkillIcon: DEFAULT_GENERATED_SKILL_ICON,
      });
      const saveRes = await this.saveGeneratedDraftTx({
        characterId,
        generationId,
        quality,
        modelName: generated.modelName,
        promptSnapshot: generated.promptSnapshot,
        attemptCount: generated.attemptCount,
        candidate: executionResult.candidate,
      });

      if (!saveRes.success || !saveRes.data) {
        const reason = saveRes.message || '草稿落库失败，已自动退款';
        await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', saveRes.code || 'GENERATION_FAILED');
        return {
          success: true,
          message: reason,
          data: {
            generationId,
            status: 'failed',
            preview: null,
            errorMessage: reason,
          },
        };
      }

      return {
        success: true,
        message: '领悟草稿成功',
        data: {
          generationId,
          status: 'generated_draft',
          preview: saveRes.data.preview,
          errorMessage: null,
        },
      };
    } catch (error) {
      const reason = `AI生成异常，已自动退款：${error instanceof Error ? error.message : '未知异常'}`;
      if (!(error instanceof TechniqueGenerationExhaustedError)) {
        logTechniqueGenerationTaskFailure({
          generationId,
          characterId,
          quality,
          attemptCount: 0,
          reason,
        });
      }
      await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', 'GENERATION_FAILED');
      return {
        success: true,
        message: reason,
        data: {
          generationId,
          status: 'failed',
          preview: null,
          errorMessage: reason,
        },
      };
    }
  }

  async generateTechniqueDraft(characterId: number): Promise<ServiceResult<{
    generationId: string;
    quality: TechniqueQuality;
    status: 'pending';
  }>> {
    const createRes = await this.createGenerationJobTx(characterId);
    if (!createRes.success) {
      return { success: false, message: createRes.message, code: createRes.code };
    }
    if (!createRes.data) {
      return { success: false, message: '创建生成任务失败', code: 'GENERATION_FAILED' };
    }

    const { generationId, quality } = createRes.data;
    return {
      success: true,
      message: '已加入洞府推演队列',
      data: {
        generationId,
        quality,
        status: 'pending',
      },
    };
  }

  async failPendingGenerationJob(characterId: number, generationId: string, reason: string): Promise<void> {
    await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', 'GENERATION_FAILED');
  }

  @Transactional
  async abandonPendingGenerationJob(characterId: number, generationId: string): Promise<ServiceResult<{
    generationId: string;
    status: 'failed';
  }>> {
    const jobRes = await query(
      `
        SELECT status
        FROM technique_generation_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length === 0) {
      return { success: false, message: '当前推演任务不存在', code: 'GENERATION_NOT_FOUND' };
    }

    const status = asString((jobRes.rows[0] as Record<string, unknown>).status);
    if (status !== 'pending') {
      return { success: false, message: '当前推演已结束，无需放弃', code: 'GENERATION_NOT_PENDING' };
    }

    const reason = '你已主动放弃当前洞府推演，可重新开始领悟。';
    await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', 'GENERATION_ABORTED');
    return {
      success: true,
      message: '已放弃当前洞府推演',
      data: {
        generationId,
        status: 'failed',
      },
    };
  }

  @Transactional
  async markLatestResultViewed(characterId: number): Promise<ServiceResult<{ marked: boolean }>> {
    const jobRes = await query(
      `
        SELECT id, status
        FROM technique_generation_job
        WHERE character_id = $1
          AND (
            (status = 'generated_draft' AND viewed_at IS NULL)
            OR (status IN ('failed', 'refunded') AND failed_viewed_at IS NULL)
          )
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [characterId],
    );
    if (jobRes.rows.length === 0) {
      return { success: true, message: '无未查看结果', data: { marked: false } };
    }

    const row = jobRes.rows[0] as Record<string, unknown>;
    const generationId = asString(row.id);
    const status = asString(row.status);
    if (!generationId || !status) {
      return { success: false, message: '未找到可标记结果', code: 'GENERATION_NOT_FOUND' };
    }

    if (status === 'generated_draft') {
      await query(
        `
          UPDATE technique_generation_job
          SET viewed_at = COALESCE(viewed_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
        `,
        [generationId],
      );
    } else {
      await query(
        `
          UPDATE technique_generation_job
          SET failed_viewed_at = COALESCE(failed_viewed_at, NOW()),
              updated_at = NOW()
          WHERE id = $1
        `,
        [generationId],
      );
    }

    return {
      success: true,
      message: '已标记查看',
      data: { marked: true },
    };
  }

  @Transactional
  private async publishGeneratedTechniqueTx(args: {
    characterId: number;
    userId: number;
    generationId: string;
    customName: string;
  }): Promise<ServiceResult<{ techniqueId: string; finalName: string; bookItemInstanceId: number }>> {
    const { characterId, userId, generationId, customName } = args;

    await this.refundExpiredDraftJobsTx(characterId);

    if (!getItemDefinitionById(GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID)) {
      return { success: false, message: '系统缺少领悟功法书定义，请联系管理员', code: 'ITEM_DEF_MISSING' };
    }

    const jobRes = await query(
      `
        SELECT id, status, draft_technique_id, draft_expire_at, publish_attempts
        FROM technique_generation_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length === 0) {
      return { success: false, message: '生成任务不存在', code: 'GENERATION_NOT_READY' };
    }

    const job = jobRes.rows[0] as Record<string, unknown>;
    const jobStatus = asString(job.status);
    const draftTechniqueId = asString(job.draft_technique_id);
    const draftExpireAt = job.draft_expire_at ? new Date(String(job.draft_expire_at)) : null;

    if (jobStatus === 'published') {
      return { success: false, message: '该草稿已发布', code: 'GENERATION_NOT_READY' };
    }
    if (jobStatus !== 'generated_draft' || !draftTechniqueId) {
      return { success: false, message: '草稿尚未就绪', code: 'GENERATION_NOT_READY' };
    }
    if (!draftExpireAt || draftExpireAt.getTime() <= Date.now()) {
      await this.refundGenerationJobTx(characterId, generationId, '草稿已过期，已自动退款');
      return { success: false, message: '草稿已过期，请重新领悟', code: 'GENERATION_EXPIRED' };
    }

    const nameCheck = validateTechniqueCustomName(customName);
    if (!nameCheck.success) {
      return { success: false, message: nameCheck.message, code: nameCheck.code };
    }

    const staticConflict = getTechniqueDefinitions().some((entry) => {
      const entryId = asString((entry as { id?: unknown }).id);
      if (entryId === draftTechniqueId) return false;
      const entryName = asString((entry as { name?: unknown }).name);
      if (!entryName) return false;
      return normalizeTechniqueName(entryName) === nameCheck.normalizedName;
    });
    if (staticConflict) {
      return { success: false, message: '名称已存在，请更换', code: 'NAME_CONFLICT' };
    }

    const draftRes = await query(
      `
        SELECT id, quality, is_published, name_locked
        FROM generated_technique_def
        WHERE id = $1
        FOR UPDATE
      `,
      [draftTechniqueId],
    );
    if (draftRes.rows.length === 0) {
      return { success: false, message: '草稿功法不存在', code: 'GENERATION_NOT_READY' };
    }

    const draftRow = draftRes.rows[0] as Record<string, unknown>;
    if (draftRow.is_published === true || draftRow.name_locked === true) {
      return { success: false, message: '名称已锁定，不可修改', code: 'GENERATION_NOT_READY' };
    }

    try {
      await query(
        `
          UPDATE generated_technique_def
          SET display_name = $2,
              normalized_name = $3,
              is_published = true,
              published_at = NOW(),
              name_locked = true,
              updated_at = NOW()
          WHERE id = $1
        `,
        [draftTechniqueId, nameCheck.displayName, nameCheck.normalizedName],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { success: false, message: '名称已存在，请更换', code: 'NAME_CONFLICT' };
      }
      throw error;
    }

    await query(
      `
        UPDATE technique_generation_job
        SET status = 'published',
            generated_technique_id = $2,
            publish_attempts = publish_attempts + 1,
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
      `,
      [generationId, draftTechniqueId],
    );

    const qualityText = asString(draftRow.quality) || '黄';
    const addRes = await addItemToInventory(characterId, userId, GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID, 1, {
      location: 'bag',
      bindType: 'none',
      obtainedFrom: `technique_generate:${generationId}`,
      metadata: {
        generatedTechniqueId: draftTechniqueId,
        generatedTechniqueName: nameCheck.displayName,
      },
      quality: qualityText,
      qualityRank: resolveQualityRankFromName(qualityText, 1),
    });

    if (!addRes.success || !addRes.itemIds || addRes.itemIds.length === 0) {
      throw new TechniqueGenerationRollbackError(
        addRes.message || '发放领悟功法书失败',
        'REWARD_FAILED',
      );
    }

    await refreshGeneratedTechniqueSnapshots();

    return {
      success: true,
      message: '发布成功，已发放可交易功法书',
      data: {
        techniqueId: draftTechniqueId,
        finalName: nameCheck.displayName,
        bookItemInstanceId: addRes.itemIds[0],
      },
    };
  }

  async publishGeneratedTechnique(args: {
    characterId: number;
    userId: number;
    generationId: string;
    customName: string;
  }): Promise<ServiceResult<{ techniqueId: string; finalName: string; bookItemInstanceId: number }>> {
    try {
      return await this.publishGeneratedTechniqueTx(args);
    } catch (error) {
      if (isTechniqueGenerationRollbackError(error)) {
        return {
          success: false,
          message: error.message,
          code: error.code,
        };
      }
      throw error;
    }
  }
}

export const techniqueGenerationService = new TechniqueGenerationService();

// 启动阶段表未初始化时，状态接口可安全返回空数据。
export const safeGetTechniqueGenerationStatus = async (characterId: number): Promise<ServiceResult<unknown>> => {
  try {
    return await techniqueGenerationService.getResearchStatus(characterId);
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return {
        success: true,
        message: 'AI领悟系统未初始化',
        data: {
          fragmentBalance: 0,
          fragmentCost: TECHNIQUE_RESEARCH_FRAGMENT_COST,
          cooldownHours: buildTechniqueResearchCooldownState(null).cooldownHours,
          cooldownUntil: null,
          cooldownRemainingSeconds: 0,
          currentDraft: null,
          draftExpireAt: null,
          nameRules: getTechniqueNameRulesView(),
          currentJob: null,
          hasUnreadResult: false,
          resultStatus: null,
        },
      };
    }
    throw error;
  }
};
