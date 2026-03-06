/**
 * AI 生成功法服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供功法书兑换研修点、AI 生成功法草稿、自定义命名发布、状态查询。
 * 2) 不做什么：不负责 HTTP 参数解析与鉴权（由路由层处理），不负责前端交互流程。
 *
 * 输入/输出：
 * - 输入：characterId、兑换条目、generationId、customName。
 * - 输出：统一 ServiceResult（success/message/data/code）。
 *
 * 数据流/状态流：
 * 1) 兑换：锁定物品实例 -> 校验功法书 -> 扣除实例 -> 增加研修点与流水。
 * 2) 生成：校验周限与余额 -> 扣点建任务(pending) -> AI/保底生成 -> 落草稿(generated_draft)。
 * 3) 发布：校验草稿状态与命名规则 -> 全服唯一检查 -> 发布功法 -> 发放可交易功法书(published)。
 *
 * 关键边界条件与坑点：
 * 1) 草稿默认 24h 过期，过期后自动退款并置为 refunded。
 * 2) 命名冲突与敏感词拒绝不重复扣费；仅系统异常回滚时触发退款。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import { addItemToInventory } from './inventory/index.js';
import { getItemDefinitionById, getTechniqueDefinitions, refreshGeneratedTechniqueSnapshots } from './staticConfigLoader.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { getRealmRankZeroBased } from './shared/realmRules.js';
import { buildTechniqueResearchJobState } from './shared/techniqueResearchJobShared.js';
import { normalizeTechniqueName, validateTechniqueCustomName, getTechniqueNameRulesView } from './shared/techniqueNameRules.js';
import { generateTechniqueCandidateWithIcons } from './shared/techniqueGenerationExecution.js';
import {
  buildTechniqueGeneratorPromptInput,
  TECHNIQUE_EFFECT_TYPE_LIST,
  TECHNIQUE_EFFECT_UNSUPPORTED_FIELDS,
  TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE,
  TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
  TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY,
  isSupportedTechniquePassiveKey,
} from './shared/techniqueGenerationConstraints.js';

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

type ResearchExchangeItemInput = {
  itemInstanceId: number;
  qty: number;
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
    costQixue: number;
    cooldown: number;
    targetType: 'self' | 'single_enemy' | 'single_ally' | 'all_enemy' | 'all_ally' | 'random_enemy' | 'random_ally';
    targetCount: number;
    damageType: 'physical' | 'magic' | 'true' | null;
    element: string;
    effects: unknown[];
    triggerType: 'active';
    aiPriority: number;
    upgrades: unknown[];
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
    costQixue: number;
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
  pointsBalance: number;
  weeklyLimit: number;
  weeklyUsed: number;
  weeklyRemaining: number;
  generationCostByQuality: Record<TechniqueQuality, number>;
  currentDraft: GeneratedDraftRow | null;
  draftExpireAt: string | null;
  nameRules: ReturnType<typeof getTechniqueNameRulesView>;
  currentJob: TechniqueResearchJobView | null;
  hasUnreadResult: boolean;
  resultStatus: TechniqueResearchResultStatus | null;
};

const WEEKLY_LIMIT = 1;
const DRAFT_EXPIRE_HOURS = 24;
const DEFAULT_REQUIRED_REALM = '凡人';
const GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID = 'book-generated-technique';
const DEFAULT_GENERATED_SKILL_ICON = '/assets/skills/icon_skill_44.png';

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

const GENERATE_POINT_COST_BY_QUALITY: Record<TechniqueQuality, number> = {
  黄: 500,
  玄: 500,
  地: 500,
  天: 500,
};

const EXCHANGE_POINTS_BY_QUALITY_RANK: Record<number, number> = {
  1: 10,
  2: 20,
  3: 35,
  4: 60,
};

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

const chooseFrom = <T>(list: T[]): T => {
  return list[Math.floor(Math.random() * list.length)] as T;
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
      costQixue: Math.max(0, Math.floor(asNumber(row.costQixue ?? row.cost_qixue, 0))),
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

const buildFallbackSkillEffects = (type: TechniqueGenerationCandidate['technique']['type'], quality: TechniqueQuality): unknown[] => {
  const damageRate = quality === '天' ? 1.9 : quality === '地' ? 1.65 : quality === '玄' ? 1.4 : 1.2;
  if (type === '辅修') {
    return [{ type: 'heal', valueType: 'scale', scaleAttr: 'fagong', scaleRate: 0.7 + (damageRate - 1) * 0.6 }];
  }
  if (type === '心法') {
    return [{ type: 'restore_lingqi', value: quality === '天' ? 35 : quality === '地' ? 28 : quality === '玄' ? 22 : 16, valueType: 'flat' }];
  }
  if (type === '身法') {
    return [
      {
        type: 'buff',
        buffKey: 'buff-shanbi-up',
        buffKind: 'attr',
        attrKey: 'shanbi',
        applyType: 'flat',
        duration: 2,
        value: quality === '天' ? 0.24 : quality === '地' ? 0.2 : quality === '玄' ? 0.16 : 0.12,
      },
      { type: 'damage', valueType: 'scale', scaleAttr: 'wugong', scaleRate: 0.8 + (damageRate - 1) * 0.3 },
    ];
  }
  if (type === '法诀') {
    return [{ type: 'damage', valueType: 'scale', scaleAttr: 'fagong', scaleRate: damageRate }];
  }
  return [{ type: 'damage', valueType: 'scale', scaleAttr: 'wugong', scaleRate: damageRate }];
};

const buildFallbackCandidate = (quality: TechniqueQuality): TechniqueGenerationCandidate => {
  const type = chooseFrom<TechniqueGenerationCandidate['technique']['type']>(['武技', '心法', '法诀', '身法', '辅修']);
  const nounByType: Record<TechniqueGenerationCandidate['technique']['type'], string[]> = {
    武技: ['破岳', '裂空', '断川', '惊雷'],
    心法: ['养元', '归息', '凝神', '归藏'],
    法诀: ['焚星', '寒潮', '玄木', '碎岩'],
    身法: ['游云', '逐影', '惊鸿', '踏月'],
    辅修: ['回春', '清心', '固元', '护脉'],
  };
  const suffixByType: Record<TechniqueGenerationCandidate['technique']['type'], string> = {
    武技: '式',
    心法: '诀',
    法诀: '法',
    身法: '步',
    辅修: '术',
  };
  const maxLayer = QUALITY_MAX_LAYER[quality];
  const suggestedName = `${chooseFrom(nounByType[type])}${suffixByType[type]}`;
  const attributeType = type === '武技' || type === '身法' ? 'physical' : 'magic';
  const element = chooseFrom(['none', 'jin', 'mu', 'shui', 'huo', 'tu']);
  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[quality];
  const fallbackSkillCount = Math.max(1, skillCountRange.min);
  const targetType: TechniqueGenerationCandidate['skills'][number]['targetType'] =
    type === '辅修' ? 'single_ally' : type === '心法' ? 'self' : 'single_enemy';
  const damageType: TechniqueGenerationCandidate['skills'][number]['damageType'] =
    type === '武技' || type === '身法' ? 'physical' : type === '法诀' ? 'magic' : null;
  const skills: TechniqueGenerationCandidate['skills'] = Array.from({ length: fallbackSkillCount }, (_, idx) => {
    const skillId = buildGeneratedSkillId(idx + 1);
    const effects = buildFallbackSkillEffects(type, quality).map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const row = { ...(entry as Record<string, unknown>) };
      const scaleRate = asNumber(row.scaleRate, NaN);
      if (Number.isFinite(scaleRate)) row.scaleRate = clamp(scaleRate + idx * 0.06, 0, 4);
      const value = asNumber(row.value, NaN);
      if (Number.isFinite(value)) row.value = Math.floor(clamp(value + idx * 2, 0, 99999));
      return row;
    });
    return {
      id: skillId,
      name: `${suggestedName}·${idx + 1}式`,
      description: `${suggestedName}的第${idx + 1}式。`,
      icon: DEFAULT_GENERATED_SKILL_ICON,
      sourceType: 'technique' as const,
      costLingqi: quality === '天' ? 16 : quality === '地' ? 14 : quality === '玄' ? 12 : 10,
      costQixue: 0,
      cooldown: quality === '天' ? 2 : 1,
      targetType,
      targetCount: 1,
      damageType,
      element,
      effects,
      triggerType: 'active' as const,
      aiPriority: Math.max(30, 55 - idx * 3),
      upgrades: [
        {
          layer: maxLayer,
          upgradeType: 'value',
          changes: {
            effects: effects.map((entry) => {
              if (!entry || typeof entry !== 'object') return entry;
              const row = { ...(entry as Record<string, unknown>) };
              const scaleRate = asNumber(row.scaleRate, NaN);
              if (Number.isFinite(scaleRate)) row.scaleRate = clamp(scaleRate + 0.25, 0, 4);
              const value = asNumber(row.value, NaN);
              if (Number.isFinite(value)) row.value = Math.floor(clamp(value * 1.2, 0, 99999));
              return row;
            }),
          },
        },
      ],
    };
  });
  const skillIds = skills.map((skill) => skill.id);

  const passivePool = TECHNIQUE_PASSIVE_KEY_POOL_BY_TYPE[type];
  const layers: TechniqueGenerationCandidate['layers'] = [];
  for (let layer = 1; layer <= maxLayer; layer += 1) {
    const passiveDef = passivePool[(layer - 1) % passivePool.length] ?? passivePool[0];
    const qualityMult = quality === '天' ? 1.6 : quality === '地' ? 1.35 : quality === '玄' ? 1.15 : 1;
    const passiveValue = passiveDef.mode === 'percent'
      ? Number((0.01 * qualityMult * (1 + layer * 0.25)).toFixed(4))
      : Math.max(1, Math.floor(2 * qualityMult * layer));

    layers.push({
      layer,
      costSpiritStones: layer <= 1 ? 0 : Math.floor(80 * qualityMult * Math.pow(layer, 1.5)),
      costExp: layer <= 1 ? 0 : Math.floor(120 * qualityMult * Math.pow(layer, 1.55)),
      costMaterials: [],
      passives: [{ key: passiveDef.key, value: passiveValue }],
      unlockSkillIds: layer === 1 ? skillIds : [],
      upgradeSkillIds: layer === maxLayer ? skillIds : [],
      layerDesc: `第${layer}层，强化${passiveDef.key}`,
    });
  }

  return {
    technique: {
      name: suggestedName,
      type,
      quality,
      maxLayer: maxLayer,
      requiredRealm: DEFAULT_REQUIRED_REALM,
      attributeType,
      attributeElement: element,
      tags: [type, '研修生成', quality],
      description: `由洞府研修推演而成的${quality}品${type}。`,
      longDesc: `${suggestedName}为研修所得秘传，随层数提升可持续增强核心套路。`,
    },
    skills,
    layers,
  };
};

const validateCandidate = (
  candidate: TechniqueGenerationCandidate,
  expectedQuality: TechniqueQuality,
): ServiceResult<null> => {
  const quality = candidate.technique.quality;
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
  for (const layer of candidate.layers) {
    if (layer.layer < 1 || layer.layer > expectedMaxLayer) {
      return { success: false, message: 'AI结果层级序号非法', code: 'GENERATOR_INVALID' };
    }
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
    for (const passive of layer.passives) {
      if (!isSupportedTechniquePassiveKey(passive.key)) {
        return { success: false, message: 'AI结果包含未支持的被动key', code: 'GENERATOR_INVALID' };
      }
      if (!Number.isFinite(passive.value)) {
        return { success: false, message: 'AI结果被动数值非法', code: 'GENERATOR_INVALID' };
      }
    }
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
    if (skill.targetCount < 1 || skill.targetCount > 6) {
      return { success: false, message: 'AI结果技能目标数量越界', code: 'GENERATOR_INVALID' };
    }

    for (const effect of skill.effects) {
      if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
        return { success: false, message: 'AI结果技能效果结构非法', code: 'GENERATOR_INVALID' };
      }
      if ('valueFormula' in (effect as Record<string, unknown>)) {
        return { success: false, message: 'AI结果技能效果包含未支持字段valueFormula', code: 'GENERATOR_INVALID' };
      }
      const effectType = asString((effect as Record<string, unknown>).type);
      if (!DAMAGE_EFFECT_TYPE_SET.has(effectType)) {
        return { success: false, message: 'AI结果技能效果类型非法', code: 'GENERATOR_INVALID' };
      }
    }
  }

  return { success: true, message: 'ok', data: null };
};

const sanitizeCandidateFromModel = (raw: unknown, quality: TechniqueQuality): TechniqueGenerationCandidate | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;

  const fallback = buildFallbackCandidate(quality);
  const rawTechnique = source.technique && typeof source.technique === 'object' && !Array.isArray(source.technique)
    ? (source.technique as Record<string, unknown>)
    : null;
  const type = toTechniqueType(rawTechnique?.type);
  const maxLayer = QUALITY_MAX_LAYER[quality];

  const technique: TechniqueGenerationCandidate['technique'] = {
    name: asString(rawTechnique?.name) || fallback.technique.name,
    type,
    quality,
    maxLayer,
    requiredRealm: asString(rawTechnique?.requiredRealm) || DEFAULT_REQUIRED_REALM,
    attributeType: asString(rawTechnique?.attributeType) === 'physical' ? 'physical' : 'magic',
    attributeElement: asString(rawTechnique?.attributeElement) || 'none',
    tags: Array.isArray(rawTechnique?.tags)
      ? rawTechnique!.tags!.map((entry) => asString(entry)).filter(Boolean)
      : fallback.technique.tags,
    description: asString(rawTechnique?.description) || fallback.technique.description,
    longDesc: asString(rawTechnique?.longDesc) || fallback.technique.longDesc,
  };

  const rawSkills = Array.isArray(source.skills) ? source.skills : [];
  const skills: TechniqueGenerationCandidate['skills'] = rawSkills.flatMap((rawSkill, idx) => {
    if (!rawSkill || typeof rawSkill !== 'object' || Array.isArray(rawSkill)) return [];
    const row = rawSkill as Record<string, unknown>;
    const name = asString(row.name);
    if (!name) return [];
    const normalizedEffects = normalizeEffects(row.effects);
    const fallbackEffects = buildFallbackSkillEffects(type, quality);
    const skill: TechniqueGenerationCandidate['skills'][number] = {
      id: asString(row.id) || buildGeneratedSkillId(idx + 1),
      name,
      description: asString(row.description) || `${name}（AI生成）`,
      icon: typeof row.icon === 'string' ? row.icon : null,
      sourceType: 'technique' as const,
      costLingqi: Math.floor(clamp(asNumber(row.costLingqi, 10), 0, 80)),
      costQixue: Math.floor(clamp(asNumber(row.costQixue, 0), 0, 120)),
      cooldown: Math.floor(clamp(asNumber(row.cooldown, 1), 0, 6)),
      targetType: toTargetType(row.targetType),
      targetCount: Math.floor(clamp(asNumber(row.targetCount, 1), 1, 6)),
      damageType: toDamageType(row.damageType),
      element: asString(row.element) || technique.attributeElement || 'none',
      effects: normalizedEffects.length > 0 ? normalizedEffects : fallbackEffects,
      triggerType: 'active' as const,
      aiPriority: Math.floor(clamp(asNumber(row.aiPriority, 50), 0, 100)),
      upgrades: Array.isArray(row.upgrades) ? row.upgrades : [],
    };
    return [skill];
  });

  if (skills.length <= 0) {
    skills.push(...fallback.skills);
  }
  const skillCountRange = TECHNIQUE_SKILL_COUNT_RANGE_BY_QUALITY[quality];
  if (skills.length < skillCountRange.min) {
    const missingCount = skillCountRange.min - skills.length;
    skills.push(...fallback.skills.slice(0, missingCount));
  }
  if (skills.length > skillCountRange.max) {
    skills.splice(skillCountRange.max);
  }

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

  const fallbackLayerMap = new Map(fallback.layers.map((row) => [row.layer, row]));
  const layers: TechniqueGenerationCandidate['layers'] = [];
  for (let layer = 1; layer <= maxLayer; layer += 1) {
    const row = orderedLayers.find((entry) => entry.layer === layer) ?? fallbackLayerMap.get(layer);
    const fallbackLayer = fallbackLayerMap.get(layer);
    if (!row) continue;
    const passives = row.passives.length > 0
      ? row.passives
      : (fallbackLayer?.passives ?? []);
    layers.push({
      layer,
      costSpiritStones: row.costSpiritStones,
      costExp: row.costExp,
      costMaterials: row.costMaterials,
      passives,
      unlockSkillIds: row.unlockSkillIds,
      upgradeSkillIds: row.upgradeSkillIds,
      layerDesc: row.layerDesc,
    });
  }

  if (layers.length !== maxLayer) {
    return null;
  }

  return {
    technique,
    skills,
    layers,
  };
};

const tryCallExternalGenerator = async (quality: TechniqueQuality): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; promptSnapshot: string } | null> => {
  const endpoint = asString(process.env.AI_TECHNIQUE_MODEL_URL);
  const apiKey = asString(process.env.AI_TECHNIQUE_MODEL_KEY);
  const modelName = asString(process.env.AI_TECHNIQUE_MODEL_NAME) || 'gpt-4o-mini';
  if (!endpoint || !apiKey) return null;
  const promptInput = buildTechniqueGeneratorPromptInput({
    quality,
    maxLayer: QUALITY_MAX_LAYER[quality],
    effectTypeEnum: Array.from(DAMAGE_EFFECT_TYPE_SET),
  });

  const payload = {
    model: modelName,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: TECHNIQUE_PROMPT_SYSTEM_MESSAGE,
      },
      {
        role: 'user',
        content: JSON.stringify(promptInput),
      },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

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
    if (!resp.ok) return null;
    const body = (await resp.json()) as Record<string, unknown>;
    const content =
      (((body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as Record<string, unknown> | undefined)?.content as string | undefined) ??
      '';
    if (!content) return null;

    let parsedRaw: unknown = null;
    try {
      parsedRaw = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        parsedRaw = JSON.parse(match[0]);
      } catch {
        return null;
      }
    }

    const candidate = sanitizeCandidateFromModel(parsedRaw, quality);
    if (!candidate) return null;
    return {
      candidate,
      modelName,
      promptSnapshot: serializePromptSnapshot(payload as unknown as Record<string, unknown>),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const generateCandidateWithRetry = async (quality: TechniqueQuality): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; attemptCount: number; promptSnapshot: string }> => {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const external = await tryCallExternalGenerator(quality);
    if (!external) continue;
    const validate = validateCandidate(external.candidate, quality);
    if (!validate.success) continue;
    return {
      candidate: external.candidate,
      modelName: external.modelName,
      attemptCount: attempt,
      promptSnapshot: external.promptSnapshot,
    };
  }

  const fallback = buildFallbackCandidate(quality);
  return {
    candidate: fallback,
    modelName: 'fallback-rule-generator',
    attemptCount: maxAttempts,
    promptSnapshot: '{}',
  };
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
  private async ensureResearchPointRowTx(characterId: number): Promise<void> {
    await query(
      `
        INSERT INTO character_research_points (character_id)
        VALUES ($1)
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterId],
    );
  }

  @Transactional
  private async refundExpiredDraftJobsTx(characterId: number): Promise<void> {
    await this.ensureResearchPointRowTx(characterId);

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

    const totalRefund = (expiredRes.rows as Array<Record<string, unknown>>)
      .map((row) => Math.max(0, Math.floor(asNumber(row.cost_points, 0))))
      .reduce((sum, val) => sum + val, 0);
    if (totalRefund <= 0) return;

    await query(
      `
        UPDATE character_research_points
        SET balance_points = balance_points + $2,
            total_earned_points = total_earned_points + $2,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [characterId, totalRefund],
    );

    for (const row of expiredRes.rows as Array<Record<string, unknown>>) {
      const jobId = asString(row.id);
      const refundPoints = Math.max(0, Math.floor(asNumber(row.cost_points, 0)));
      if (!jobId || refundPoints <= 0) continue;
      await query(
        `
          INSERT INTO research_points_ledger (character_id, change_points, reason, ref_type, ref_id)
          VALUES ($1, $2, 'generate_refund', 'generation_job', $3)
        `,
        [characterId, refundPoints, jobId],
      );
    }

    await query(
      `
        UPDATE technique_generation_job
        SET status = 'refunded',
            error_code = 'GENERATION_EXPIRED',
            error_message = '草稿已过期，系统自动退款',
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
    await this.ensureResearchPointRowTx(characterId);

    const weekKey = resolveWeekKey(new Date());
    const [pointsRes, usedRes, draftRes, currentJobRes] = await Promise.all([
      query(
        `
          SELECT balance_points
          FROM character_research_points
          WHERE character_id = $1
          LIMIT 1
        `,
        [characterId],
      ),
      query(
        `
          SELECT COUNT(*)::int AS cnt
          FROM technique_generation_job
          WHERE character_id = $1
            AND week_key = $2
            AND status IN ('pending', 'generated_draft', 'published')
        `,
        [characterId, weekKey],
      ),
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
                  'costQixue', s.cost_qixue,
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

    const pointsBalance = Math.max(0, Math.floor(asNumber((pointsRes.rows[0] as Record<string, unknown> | undefined)?.balance_points, 0)));
    const weeklyUsed = Math.max(0, Math.floor(asNumber((usedRes.rows[0] as Record<string, unknown> | undefined)?.cnt, 0)));
    const weeklyRemaining = Math.max(0, WEEKLY_LIMIT - weeklyUsed);

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

    return {
      success: true,
      message: '获取成功',
      data: {
        pointsBalance,
        weeklyLimit: WEEKLY_LIMIT,
        weeklyUsed,
        weeklyRemaining,
        generationCostByQuality: { ...GENERATE_POINT_COST_BY_QUALITY },
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
  async exchangeTechniqueBooks(
    characterId: number,
    userId: number,
    items: ResearchExchangeItemInput[],
  ): Promise<ServiceResult<{ gainedPoints: number; pointsBalance: number }>> {
    void userId;
    if (!Array.isArray(items) || items.length === 0) {
      return { success: false, message: '缺少兑换条目', code: 'INVALID_ARGS' };
    }

    await lockCharacterInventoryMutex(characterId);
    await this.ensureResearchPointRowTx(characterId);

    const qtyByInstanceId = new Map<number, number>();
    for (const raw of items) {
      const id = Math.floor(asNumber(raw.itemInstanceId, 0));
      const qty = Math.floor(asNumber(raw.qty, 0));
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(qty) || qty <= 0) {
        return { success: false, message: '兑换条目参数错误', code: 'INVALID_ARGS' };
      }
      qtyByInstanceId.set(id, (qtyByInstanceId.get(id) ?? 0) + qty);
    }

    const itemIds = [...qtyByInstanceId.keys()];
    const itemRowsRes = await query(
      `
        SELECT id, item_def_id, qty, locked, location, quality, quality_rank
        FROM item_instance
        WHERE owner_character_id = $1
          AND id = ANY($2::bigint[])
        FOR UPDATE
      `,
      [characterId, itemIds],
    );

    if (itemRowsRes.rows.length !== itemIds.length) {
      return { success: false, message: '存在无效物品', code: 'INVALID_ITEMS' };
    }

    let gainedPoints = 0;
    for (const rowRaw of itemRowsRes.rows as Array<Record<string, unknown>>) {
      const instanceId = Math.floor(asNumber(rowRaw.id, 0));
      const itemDefId = asString(rowRaw.item_def_id);
      const rowQty = Math.max(0, Math.floor(asNumber(rowRaw.qty, 0)));
      const consumeQty = qtyByInstanceId.get(instanceId) ?? 0;

      if (!itemDefId || instanceId <= 0 || consumeQty <= 0) {
        return { success: false, message: '兑换条目参数错误', code: 'INVALID_ARGS' };
      }
      if (consumeQty > rowQty) {
        return { success: false, message: '道具数量不足', code: 'ITEM_NOT_ENOUGH' };
      }
      if (Boolean(rowRaw.locked)) {
        return { success: false, message: '包含已锁定物品，无法兑换', code: 'ITEM_LOCKED' };
      }

      const location = asString(rowRaw.location);
      if (location !== 'bag' && location !== 'warehouse') {
        return { success: false, message: '仅背包或仓库中的功法书可兑换', code: 'ITEM_LOCATION_INVALID' };
      }

      const itemDef = getItemDefinitionById(itemDefId);
      if (!itemDef || String(itemDef.sub_category || '').trim() !== 'technique_book') {
        return { success: false, message: '仅支持功法书兑换研修点', code: 'ITEM_TYPE_INVALID' };
      }

      const qualityRank = Math.max(
        1,
        Math.floor(
          asNumber(
            rowRaw.quality_rank,
            resolveQualityRankFromName(asString(rowRaw.quality) || itemDef.quality, 1),
          ),
        ),
      );
      const pointPerBook = EXCHANGE_POINTS_BY_QUALITY_RANK[qualityRank] ?? EXCHANGE_POINTS_BY_QUALITY_RANK[1];
      gainedPoints += pointPerBook * consumeQty;

      if (consumeQty === rowQty) {
        await query('DELETE FROM item_instance WHERE id = $1', [instanceId]);
      } else {
        await query(
          'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
          [consumeQty, instanceId],
        );
      }
    }

    if (gainedPoints <= 0) {
      return { success: false, message: '未获得任何研修点', code: 'NO_GAIN' };
    }

    await query(
      `
        UPDATE character_research_points
        SET balance_points = balance_points + $2,
            total_earned_points = total_earned_points + $2,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [characterId, gainedPoints],
    );

    await query(
      `
        INSERT INTO research_points_ledger (character_id, change_points, reason, ref_type, ref_id)
        VALUES ($1, $2, 'exchange_book', 'batch', $3)
      `,
      [characterId, gainedPoints, `exchange:${Date.now()}`],
    );

    const balanceRes = await query(
      `
        SELECT balance_points
        FROM character_research_points
        WHERE character_id = $1
        LIMIT 1
      `,
      [characterId],
    );
    const pointsBalance = Math.max(0, Math.floor(asNumber((balanceRes.rows[0] as Record<string, unknown> | undefined)?.balance_points, 0)));

    return {
      success: true,
      message: `成功兑换${gainedPoints}研修点`,
      data: { gainedPoints, pointsBalance },
    };
  }

  @Transactional
  private async createGenerationJobTx(characterId: number): Promise<ServiceResult<{ generationId: string; quality: TechniqueQuality; costPoints: number; weekKey: string }>> {
    await this.refundExpiredDraftJobsTx(characterId);
    await this.ensureResearchPointRowTx(characterId);

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

    const weekKey = resolveWeekKey(new Date());
    const usedRes = await query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM technique_generation_job
        WHERE character_id = $1
          AND week_key = $2
          AND status IN ('pending', 'generated_draft', 'published')
      `,
      [characterId, weekKey],
    );
    const weeklyUsed = Math.max(0, Math.floor(asNumber((usedRes.rows[0] as Record<string, unknown> | undefined)?.cnt, 0)));
    if (weeklyUsed >= WEEKLY_LIMIT) {
      return { success: false, message: '本周领悟次数已用尽', code: 'WEEKLY_LIMIT_REACHED' };
    }

    const quality = resolveQualityByWeight();
    const costPoints = GENERATE_POINT_COST_BY_QUALITY[quality];

    const pointsRes = await query(
      `
        SELECT balance_points
        FROM character_research_points
        WHERE character_id = $1
        FOR UPDATE
      `,
      [characterId],
    );
    const pointsBalance = Math.max(0, Math.floor(asNumber((pointsRes.rows[0] as Record<string, unknown> | undefined)?.balance_points, 0)));
    if (pointsBalance < costPoints) {
      return { success: false, message: `研修点不足，需要${costPoints}，当前${pointsBalance}`, code: 'POINT_NOT_ENOUGH' };
    }

    await query(
      `
        UPDATE character_research_points
        SET balance_points = balance_points - $2,
            total_spent_points = total_spent_points + $2,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [characterId, costPoints],
    );

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
          NOW() + ($6::int * INTERVAL '1 hour'),
          NOW(), NOW()
        )
      `,
      [generationId, characterId, weekKey, quality, costPoints, DRAFT_EXPIRE_HOURS],
    );

    await query(
      `
        INSERT INTO research_points_ledger (character_id, change_points, reason, ref_type, ref_id)
        VALUES ($1, $2, 'generate_consume', 'generation_job', $3)
      `,
      [characterId, -costPoints, generationId],
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
            cost_qixue,
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
            $8, $9, $10,
            $11, $12, $13,
            $14, $15::jsonb,
            $16, $17,
            $18::jsonb,
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
          skill.costQixue,
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
            finished_at = NOW(),
            viewed_at = NULL,
            failed_viewed_at = NULL,
            error_code = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [generationId, draftTechniqueId, attemptCount, modelName, promptSnapshot],
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
            costQixue: skill.costQixue,
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
    await this.ensureResearchPointRowTx(characterId);
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
    if ((status === 'refunded' || status === 'failed' || status === 'published') || costPoints <= 0) return;

    await query(
      `
        UPDATE character_research_points
        SET balance_points = balance_points + $2,
            total_earned_points = total_earned_points + $2,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [characterId, costPoints],
    );

    await query(
      `
        INSERT INTO research_points_ledger (character_id, change_points, reason, ref_type, ref_id)
        VALUES ($1, $2, 'generate_refund', 'generation_job', $3)
      `,
      [characterId, costPoints, generationId],
    );

    await query(
      `
        UPDATE technique_generation_job
        SET status = $4,
            error_code = $5,
            error_message = $3,
            finished_at = NOW(),
            failed_viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `,
      [generationId, characterId, reason, nextStatus, errorCode],
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
      const generated = await generateCandidateWithRetry(quality);
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
  async publishGeneratedTechnique(args: {
    characterId: number;
    userId: number;
    generationId: string;
    customName: string;
  }): Promise<ServiceResult<{ techniqueId: string; finalName: string; bookItemInstanceId: number }>> {
    const { characterId, userId, generationId, customName } = args;

    await this.refundExpiredDraftJobsTx(characterId);
    await this.ensureResearchPointRowTx(characterId);

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

    await refreshGeneratedTechniqueSnapshots();

    const bookDef = getItemDefinitionById(GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID);
    if (!bookDef) {
      return { success: false, message: '系统缺少领悟功法书定义，请联系管理员', code: 'ITEM_DEF_MISSING' };
    }

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
      return { success: false, message: addRes.message || '发放领悟功法书失败', code: 'REWARD_FAILED' };
    }

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
          pointsBalance: 0,
          weeklyLimit: WEEKLY_LIMIT,
          weeklyUsed: 0,
          weeklyRemaining: WEEKLY_LIMIT,
          generationCostByQuality: { ...GENERATE_POINT_COST_BY_QUALITY },
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
