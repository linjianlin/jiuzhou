/**
 * AI 伙伴招募服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供伙伴招募状态查询、任务创建、异步生成落库、结果确认、放弃与已读标记。
 * 2) 做什么：把动态伙伴定义、伙伴专属生成功法与招募任务状态机收口到单一服务，避免伙伴系统走双轨实现。
 * 3) 不做什么：不解析 HTTP 参数，也不在这里维护 worker 队列；全服播报仅在确认获得天级伙伴后通过共享广播模块触发。
 *
 * 输入/输出：
 * - 输入：characterId、generationId。
 * - 输出：统一 ServiceResult，以及伙伴招募状态 DTO / 确认结果 DTO。
 *
 * 数据流/状态流：
 * route -> partnerRecruitService.create -> runner.enqueue -> worker -> processPendingRecruitJob -> preview -> confirm/discard -> 天级确认后触发世界系统广播。
 *
 * 关键边界条件与坑点：
 * 1) 失败路径必须退款并把任务写成终结态，不能让任务卡在 pending，也不能吞掉头像/模型失败。
 * 2) 伙伴预览只生成动态定义，不直接创建实例；只有 confirm 才真正写入 `character_partner`，且广播必须放在事务提交后触发。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from './featureUnlockService.js';
import {
  getItemDefinitionById,
  getPartnerDefinitionById,
  getSkillDefinitions,
  getTechniqueDefinitions,
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
  type PartnerDefConfig,
} from './staticConfigLoader.js';
import { addItemToInventory } from './inventory/index.js';
import { consumeMaterialByDefId } from './inventory/shared/consume.js';
import { partnerService } from './partnerService.js';
import {
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
} from './shared/techniqueTextModelShared.js';
import { getCharacterNicknameById } from './shared/characterNickname.js';
import { resolveTechniqueGenerationRequestFailure } from './shared/techniqueGenerationRequestFailure.js';
import {
  buildPartnerRecruitJobState,
  type PartnerRecruitJobStatus,
  type PartnerRecruitPreviewDto,
} from './shared/partnerRecruitJobShared.js';
import {
  buildPartnerRecruitStatusDto,
  type PartnerRecruitJobDto,
  type PartnerRecruitStatusDto,
} from './shared/partnerRecruitStatus.js';
import {
  buildPartnerRecruitCooldownState,
  buildPartnerRecruitPromptNoiseHash,
  buildPartnerRecruitPreviewExpireAt,
  buildPartnerRecruitPromptInput,
  buildPartnerRecruitResponseFormat,
  fillPartnerRecruitBaseAttrs,
  formatPartnerRecruitCooldownRemaining,
  getPartnerRecruitTechniqueMaxLayer,
  isPartnerRecruitPreviewExpired,
  PARTNER_RECRUIT_COOLDOWN_APPLY_JOB_STATUSES,
  PARTNER_RECRUIT_SPIRIT_STONES_COST,
  resolvePartnerRecruitQualityByWeight,
  type PartnerRecruitCombatStyle,
  type PartnerRecruitDraft,
  type PartnerRecruitQuality,
  validatePartnerRecruitDraft,
} from './shared/partnerRecruitRules.js';
import { getActiveMonthCardCooldownReductionRate } from './shared/monthCardBenefits.js';
import {
  PARTNER_RECRUIT_FORM_RULES,
} from './shared/partnerRecruitCreativeDirection.js';
import {
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN,
  guardPartnerRecruitRequestedBaseModel,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
  resolvePartnerRecruitBaseModel,
  shouldPartnerRecruitBypassCooldownWithCustomBaseModel,
  validatePartnerRecruitRequestedBaseModelSelection,
} from './shared/partnerRecruitBaseModel.js';
import {
  buildPartnerRecruitUnlockState,
  type PartnerRecruitUnlockState,
} from './shared/partnerRecruitUnlock.js';
import {
  generatePartnerRecruitAvatar,
  type PartnerRecruitAvatarInput,
} from './shared/partnerRecruitAvatarGenerator.js';
import { generateTechniqueCandidateWithIcons } from './shared/techniqueGenerationExecution.js';
import { broadcastWorldSystemMessage } from './shared/worldChatBroadcast.js';
import { callConfiguredTextModel } from './ai/openAITextClient.js';
import {
  TechniqueGenerationExhaustedError,
  generateTechniqueCandidateWithRetry,
  remapTechniqueCandidateSkillIds,
  validateTechniqueGenerationCandidate,
} from './shared/techniqueGenerationCandidateCore.js';
import { persistGeneratedTechniqueCandidateTx } from './shared/generatedTechniquePersistence.js';
import type { GeneratedTechniqueType } from './shared/techniqueGenerationConstraints.js';
import type { TechniqueGenerationCandidate } from './techniqueGenerationService.js';

export type ServiceResult<T = unknown> = {
  success: boolean;
  message: string;
  data?: T;
  code?: string;
};

export type { PartnerRecruitJobDto, PartnerRecruitStatusDto } from './shared/partnerRecruitStatus.js';

export interface PartnerRecruitConfirmResponse {
  generationId: string;
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
  activated: boolean;
}

type RecruitJobRow = {
  generationId: string;
  status: PartnerRecruitJobStatus;
  quality: PartnerRecruitQuality;
  spiritStonesCost: number;
  cooldownStartedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
  requestedBaseModel: string | null;
  previewPartnerDefId: string | null;
};

type RecruitTextAttemptFailure = {
  success: false;
  reason: string;
  modelName: string;
};

type RecruitTextAttemptSuccess = {
  success: true;
  draft: PartnerRecruitDraft;
  modelName: string;
};

type RecruitTextAttemptResult = RecruitTextAttemptFailure | RecruitTextAttemptSuccess;

export type GeneratedRecruitTechniqueDraft = {
  techniqueId: string;
  candidate: TechniqueGenerationCandidate;
};

const PARTNER_RECRUIT_PROMPT_SYSTEM_MESSAGE = [
  '你是《九州修仙录》的伙伴创作引擎。',
  '你必须返回严格 JSON，不得输出 markdown、解释、注释。',
  '你要生成一个可招募的仙侠伙伴草稿，字段必须完整且满足输入约束。',
  '字段名必须与输入约束和 response schema 完全一致，不得自创别名。',
  '不要生成现代词汇、科幻词汇、英文名、阿拉伯数字名。',
  ...PARTNER_RECRUIT_FORM_RULES,
].join('\n');

const DEFAULT_ATTACK_SKILL_ICON = '/assets/skills/icon_skill_38.png';
const DEFAULT_SUPPORT_SKILL_ICON = '/assets/skills/icon_skill_36.png';
const DEFAULT_GUARD_SKILL_ICON = '/assets/skills/icon_skill_14.png';

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asNumber = (raw: unknown, fallback = 0): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const toIsoString = (raw: unknown): string | null => {
  if (!raw) return null;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const normalizeGeneratedId = (prefix: string): string => {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const buildPartnerRecruitGenerationId = (): string => normalizeGeneratedId('partner-recruit');
const buildGeneratedPartnerDefId = (): string => normalizeGeneratedId('partner-gen');
const buildGeneratedTechniqueId = (): string => normalizeGeneratedId('tech-partner');

const getPartnerRecruitCustomBaseModelTokenName = (): string => {
  const itemDef = getItemDefinitionById(PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID);
  const itemName = asString(itemDef?.name);
  if (!itemName) {
    throw new Error(`伙伴招募自定义底模消耗道具未配置：${PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID}`);
  }
  return itemName;
};

const resolveCombatStyleAttributeType = (combatStyle: PartnerRecruitCombatStyle): {
  attributeType: 'physical' | 'magic';
} => {
  if (combatStyle === 'physical') {
    return {
      attributeType: 'physical',
    };
  }
  return {
    attributeType: 'magic',
  };
};

const resolvePartnerRecruitTechniqueType = (
  combatStyle: PartnerRecruitCombatStyle,
  kind: PartnerRecruitDraft['innateTechniques'][number]['kind'],
): GeneratedTechniqueType => {
  if (kind === 'attack') {
    return resolveCombatStyleAttributeType(combatStyle).attributeType === 'physical' ? '武技' : '法诀';
  }
  return '辅修';
};

const resolvePartnerRecruitDefaultSkillIcon = (
  kind: PartnerRecruitDraft['innateTechniques'][number]['kind'],
): string => {
  if (kind === 'attack') return DEFAULT_ATTACK_SKILL_ICON;
  if (kind === 'support') return DEFAULT_SUPPORT_SKILL_ICON;
  return DEFAULT_GUARD_SKILL_ICON;
};

const buildPartnerRecruitTechniquePromptContext = (params: {
  draft: PartnerRecruitDraft;
  technique: PartnerRecruitDraft['innateTechniques'][number];
  techniqueIndex: number;
  techniqueType: GeneratedTechniqueType;
}): Record<string, unknown> => {
  const { draft, technique, techniqueIndex, techniqueType } = params;
  return {
    partner: {
      name: draft.partner.name,
      quality: draft.partner.quality,
      role: draft.partner.role,
      combatStyle: draft.partner.combatStyle,
      attributeElement: draft.partner.attributeElement,
      description: draft.partner.description,
    },
    innateTechnique: {
      slot: techniqueIndex + 1,
      totalCount: draft.innateTechniques.length,
      kind: technique.kind,
      preferredTechniqueType: techniqueType,
      preferredName: technique.name,
      preferredDescription: technique.description,
      preferredPassiveKey: technique.passiveKey,
      preferredPassiveValue: technique.passiveValue,
    },
  };
};

const buildPartnerRecruitAvatarInput = (
  partnerDefId: string,
  draft: PartnerRecruitDraft,
): PartnerRecruitAvatarInput => ({
  partnerId: partnerDefId,
  name: draft.partner.name,
  quality: draft.partner.quality,
  element: draft.partner.attributeElement,
  role: draft.partner.role,
  description: draft.partner.description,
});

const adaptTechniqueCandidateForPartner = (params: {
  draft: PartnerRecruitDraft;
  candidate: TechniqueGenerationCandidate;
  techniqueType: GeneratedTechniqueType;
}): TechniqueGenerationCandidate => {
  const { draft, candidate, techniqueType } = params;
  const combatStyle = resolveCombatStyleAttributeType(draft.partner.combatStyle);
  const attributeType = techniqueType === '武技'
    ? 'physical'
    : techniqueType === '法诀'
      ? 'magic'
      : combatStyle.attributeType;

  return {
    ...candidate,
    technique: {
      ...candidate.technique,
      type: techniqueType,
      requiredRealm: '凡人',
      attributeType,
      attributeElement: draft.partner.attributeElement,
    },
    skills: candidate.skills.map((skill) => ({
      ...skill,
      element: draft.partner.attributeElement,
      damageType: techniqueType === '武技'
        ? (skill.damageType ?? 'physical')
        : techniqueType === '法诀'
          ? (skill.damageType ?? 'magic')
          : skill.damageType,
    })),
  };
};

// 伙伴文案草稿只负责“想生成什么”，真正的技能/层级/被动统一复用常规功法 candidate 核心，
// 这样伙伴招募与洞府研修就不会各维护一套数值与结构校验。
const generateRecruitTechniqueDrafts = async (params: {
  characterId: number;
  generationId: string;
  draft: PartnerRecruitDraft;
}): Promise<GeneratedRecruitTechniqueDraft[]> => {
  const { characterId, generationId, draft } = params;
  const maxLayer = getPartnerRecruitTechniqueMaxLayer(draft.partner.quality);
  const generatedTechniques: GeneratedRecruitTechniqueDraft[] = [];

  for (const [index, entry] of draft.innateTechniques.entries()) {
    const techniqueType = resolvePartnerRecruitTechniqueType(draft.partner.combatStyle, entry.kind);
    const generated = await generateTechniqueCandidateWithRetry({
      generationId: `${generationId}:innate:${index + 1}`,
      characterId,
      techniqueType,
      quality: draft.partner.quality,
      maxLayer,
      promptContext: buildPartnerRecruitTechniquePromptContext({
        draft,
        technique: entry,
        techniqueIndex: index,
        techniqueType,
      }),
    });
    const adaptedCandidate = adaptTechniqueCandidateForPartner({
      draft,
      candidate: generated.candidate,
      techniqueType,
    });
    const validateAdapted = validateTechniqueGenerationCandidate({
      candidate: adaptedCandidate,
      expectedTechniqueType: techniqueType,
      expectedQuality: draft.partner.quality,
      expectedMaxLayer: maxLayer,
    });
    if (!validateAdapted.success) {
      throw new TechniqueGenerationExhaustedError(validateAdapted.message);
    }

    const execution = await generateTechniqueCandidateWithIcons({
      quality: draft.partner.quality,
      candidate: adaptedCandidate,
      defaultSkillIcon: resolvePartnerRecruitDefaultSkillIcon(entry.kind),
    });
    const normalizedCandidate = remapTechniqueCandidateSkillIds(execution.candidate);
    const validateNormalized = validateTechniqueGenerationCandidate({
      candidate: normalizedCandidate,
      expectedTechniqueType: techniqueType,
      expectedQuality: draft.partner.quality,
      expectedMaxLayer: maxLayer,
    });
    if (!validateNormalized.success) {
      throw new TechniqueGenerationExhaustedError(validateNormalized.message);
    }

    generatedTechniques.push({
      techniqueId: buildGeneratedTechniqueId(),
      candidate: normalizedCandidate,
    });
  }

  return generatedTechniques;
};

/**
 * 伙伴视觉资源并发执行入口
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把伙伴头像生成与伙伴天生功法链路放到同一入口并发发起，避免 service 主流程里再次写出串行等待。
 * 2) 做什么：集中维护头像入参与依赖注入，让单测只验证“是否并发启动”，不必触碰数据库与真实模型。
 * 3) 不做什么：不负责数据库落库、不改动功法生成细节，也不在这里吞掉任一子任务异常。
 *
 * 输入/输出：
 * - 输入：角色 ID、招募任务 ID、伙伴草稿、伙伴定义 ID，以及可选的头像/功法生成依赖。
 * - 输出：`{ techniques, avatarUrl }`，供后续事务统一落库。
 *
 * 数据流/状态流：
 * partner draft -> buildPartnerRecruitAvatarInput / generateRecruitTechniqueDrafts -> Promise.all 并发执行 -> processPendingRecruitJob 落库。
 *
 * 关键边界条件与坑点：
 * 1) 这里只做并发编排，不做失败兜底；任一子任务失败都必须原样抛回上层，保持整单退款语义单一。
 * 2) 技能图标并发仍由 `generateTechniqueSkillIconMap` 自己控速，这里只额外并发 1 条伙伴头像链路，避免把并发控制散落到多个调用点。
 */
export const executePartnerRecruitVisualGeneration = async (
  params: {
    characterId: number;
    generationId: string;
    draft: PartnerRecruitDraft;
    partnerDefId: string;
  },
  deps: {
    generateTechniques: (args: {
      characterId: number;
      generationId: string;
      draft: PartnerRecruitDraft;
    }) => Promise<GeneratedRecruitTechniqueDraft[]>;
    generateAvatar: (input: PartnerRecruitAvatarInput) => Promise<string>;
  } = {
    generateTechniques: generateRecruitTechniqueDrafts,
    generateAvatar: generatePartnerRecruitAvatar,
  },
): Promise<{
  techniques: GeneratedRecruitTechniqueDraft[];
  avatarUrl: string;
}> => {
  const [techniques, avatarUrl] = await Promise.all([
    deps.generateTechniques({
      characterId: params.characterId,
      generationId: params.generationId,
      draft: params.draft,
    }),
    deps.generateAvatar(buildPartnerRecruitAvatarInput(params.partnerDefId, params.draft)),
  ]);

  return {
    techniques,
    avatarUrl,
  };
};

const buildPartnerDefFromDraft = (
  partnerDefId: string,
  generationId: string,
  characterId: number,
  draft: PartnerRecruitDraft,
  avatarUrl: string,
  techniques: GeneratedRecruitTechniqueDraft[],
): PartnerDefConfig => {
  return {
    id: partnerDefId,
    name: draft.partner.name,
    description: draft.partner.description,
    avatar: avatarUrl,
    quality: draft.partner.quality,
    attribute_element: draft.partner.attributeElement,
    role: draft.partner.role,
    max_technique_slots: draft.partner.maxTechniqueSlots,
    innate_technique_ids: techniques.map((entry) => entry.techniqueId),
    base_attrs: draft.partner.baseAttrs,
    level_attr_gains: draft.partner.levelAttrGains,
    enabled: true,
    sort_weight: 1000,
    created_by_character_id: characterId,
    source_job_id: generationId,
  };
};

const buildPreviewFromPartnerDefinition = (
  definition: PartnerDefConfig,
): PartnerRecruitPreviewDto => {
  const skillDefinitions = getSkillDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueDefinitions = getTechniqueDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueMap = new Map(techniqueDefinitions.map((entry) => [entry.id, entry] as const));
  const skillsByTechniqueId = new Map<string, string[]>();
  for (const skill of skillDefinitions) {
    if (skill.source_type !== 'technique') continue;
    const sourceId = asString(skill.source_id);
    if (!sourceId) continue;
    const list = skillsByTechniqueId.get(sourceId) ?? [];
    const name = asString(skill.name);
    if (name) list.push(name);
    skillsByTechniqueId.set(sourceId, list);
  }

  return {
    partnerDefId: definition.id,
    name: definition.name,
    description: definition.description ?? '',
    avatar: definition.avatar ?? null,
    quality: definition.quality ?? '黄',
    element: definition.attribute_element ?? 'none',
    role: definition.role ?? '伙伴',
    slotCount: Math.max(1, Number(definition.max_technique_slots) || 1),
    baseAttrs: fillPartnerRecruitBaseAttrs(definition.base_attrs),
    levelAttrGains: fillPartnerRecruitBaseAttrs(definition.level_attr_gains),
    innateTechniques: definition.innate_technique_ids.map((techniqueId) => {
      const technique = techniqueMap.get(techniqueId);
      return {
        techniqueId,
        name: asString(technique?.name) || techniqueId,
        description: asString(technique?.description),
        quality: asString(technique?.quality) || definition.quality || '黄',
        icon: asString(technique?.icon) || null,
        skillNames: [...new Set(skillsByTechniqueId.get(techniqueId) ?? [])],
      };
    }),
  };
};

/**
 * 伙伴招募文本模型请求构造
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中构造伙伴招募文本模型请求，把显式 seed 与基于 seed 派生的 prompt 扰动 hash 绑在一起，避免 service 内联拼接再次分叉。
 * 2) 不做什么：不请求模型、不解析响应，也不负责草稿校验。
 *
 * 输入/输出：
 * - 输入：伙伴品质、可选固定 seed（测试用）。
 * - 输出：可直接传给 `callConfiguredTextModel` 的请求参数，以及便于调试的 `promptNoiseHash/baseModel`。
 *
 * 数据流/状态流：
 * 品质/seed -> promptNoiseHash -> buildPartnerRecruitPromptInput -> 文本模型调用。
 *
 * 关键边界条件与坑点：
 * 1) promptNoiseHash 必须与 seed 同源，否则“请求看起来有扰动，实际 seed 不是同一次”会让排查失真。
 * 2) 基础类型必须与 seed 绑定，保证同一次招募请求里的创作约束可复现，而不是每次重试又随机成另一种主体。
 */
export const buildPartnerRecruitTextModelRequest = (params: {
  quality: PartnerRecruitQuality;
  seed?: number;
  requestedBaseModel?: string | null;
}): {
  responseFormat: ReturnType<typeof buildPartnerRecruitResponseFormat>;
  systemMessage: string;
  userMessage: string;
  seed: number;
  timeoutMs: number;
  promptNoiseHash: string;
  requestedBaseModel: string | null;
  baseModel: string;
} => {
  const seed = params.seed ?? generateTechniqueTextModelSeed();
  const promptNoiseHash = buildPartnerRecruitPromptNoiseHash(seed);
  const baseModelSelection = resolvePartnerRecruitBaseModel({
    seed,
    requestedBaseModel: params.requestedBaseModel,
  });
  const timeoutMs = 300_000;

  return {
    responseFormat: buildPartnerRecruitResponseFormat(params.quality),
    systemMessage: PARTNER_RECRUIT_PROMPT_SYSTEM_MESSAGE,
    userMessage: JSON.stringify(buildPartnerRecruitPromptInput(params.quality, {
      baseModel: baseModelSelection.baseModel,
      promptNoiseHash,
    })),
    seed,
    timeoutMs,
    promptNoiseHash,
    requestedBaseModel: baseModelSelection.requestedBaseModel,
    baseModel: baseModelSelection.baseModel,
  };
};

const tryCallPartnerRecruitTextModel = async (
  params: {
    quality: PartnerRecruitQuality;
    requestedBaseModel?: string | null;
  },
): Promise<RecruitTextAttemptResult> => {
    const requestedBaseModelValidation = await guardPartnerRecruitRequestedBaseModel(params.requestedBaseModel);
    if (!requestedBaseModelValidation.success) {
      return {
        success: false,
      reason: requestedBaseModelValidation.message,
      modelName: 'gpt-4o-mini',
    };
  }

  const request = buildPartnerRecruitTextModelRequest({
    ...params,
    requestedBaseModel: requestedBaseModelValidation.value,
  });
  const external = await callConfiguredTextModel(request);
  if (!external) {
    return {
      success: false,
      reason: '缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置',
      modelName: 'gpt-4o-mini',
    };
  }
  const { content, modelName } = external;

  try {
    const parsed = parseTechniqueTextModelJsonObject(content);
    if (!parsed.success) {
      return {
        success: false,
        reason: parsed.reason === 'empty_content' ? '伙伴生成模型返回空内容' : '伙伴生成模型未返回合法 JSON',
        modelName,
      };
    }
    const draft = validatePartnerRecruitDraft(parsed.data);
    if (!draft) {
      return {
        success: false,
        reason: '伙伴生成模型返回结构非法或超出约束',
        modelName,
      };
    }
    if (draft.partner.quality !== params.quality) {
      return {
        success: false,
        reason: '伙伴生成模型返回的品质与本次抽取品质不一致',
        modelName,
      };
    }
    return {
      success: true,
      draft,
      modelName,
    };
  } catch (error) {
    const failure = resolveTechniqueGenerationRequestFailure({
      error,
      didTimeout: false,
      timeoutMs: request.timeoutMs,
    });
    return {
      success: false,
      reason: failure.reason,
      modelName,
    };
  }
};

const buildRecruitPreviewByPartnerDefId = (
  partnerDefId: string,
): PartnerRecruitPreviewDto | null => {
  const definition = getPartnerDefinitionById(partnerDefId);
  if (!definition) return null;
  return buildPreviewFromPartnerDefinition(definition);
};

class PartnerRecruitService {
  private async broadcastHeavenPartnerRecruit(
    characterId: number,
    partnerDefId: string,
    partnerName: string,
  ): Promise<void> {
    const definition = getPartnerDefinitionById(partnerDefId);
    if (!definition || definition.quality !== '天') {
      return;
    }

    const nickname = await getCharacterNicknameById(characterId);
    if (!nickname) {
      return;
    }

    broadcastWorldSystemMessage({
      senderTitle: '天机传音',
      content: `【伙伴招募】『${nickname}』招募到天级伙伴【${partnerName}】，灵契共鸣，声传九州！`,
    });
  }

  private async getPartnerRecruitUnlockStateTx(
    characterId: number,
    lockRow: boolean,
  ): Promise<ServiceResult<PartnerRecruitUnlockState>> {
    const queryText = lockRow
      ? `
        SELECT realm, sub_realm
        FROM characters
        WHERE id = $1
        FOR UPDATE
      `
      : `
        SELECT realm, sub_realm
        FROM characters
        WHERE id = $1
      `;
    const characterRes = await query(queryText, [characterId]);
    if (characterRes.rows.length === 0) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    const row = characterRes.rows[0] as { realm?: string | null; sub_realm?: string | null };
    return {
      success: true,
      message: '获取伙伴招募开放态成功',
      data: buildPartnerRecruitUnlockState(
        typeof row.realm === 'string' ? row.realm.trim() : '',
        typeof row.sub_realm === 'string' && row.sub_realm.trim() ? row.sub_realm.trim() : null,
      ),
    };
  }

  private async assertPartnerRecruitUnlocked(
    characterId: number,
    lockRow: boolean,
  ): Promise<ServiceResult<{ featureCode: string }>> {
    const featureUnlocked = await isFeatureUnlocked(characterId, PARTNER_SYSTEM_FEATURE_CODE);
    if (!featureUnlocked) {
      return { success: false, message: '伙伴系统尚未解锁', code: 'PARTNER_SYSTEM_LOCKED' };
    }

    const unlockState = await this.getPartnerRecruitUnlockStateTx(characterId, lockRow);
    if (!unlockState.success || !unlockState.data) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }
    if (!unlockState.data.unlocked) {
      return {
        success: false,
        message: `伙伴招募需达到${unlockState.data.unlockRealm}后开放`,
        code: 'PARTNER_RECRUIT_REALM_LOCKED',
      };
    }

    return {
      success: true,
      message: 'ok',
      data: {
        featureCode: PARTNER_SYSTEM_FEATURE_CODE,
      },
    };
  }

  @Transactional
  private async discardExpiredDraftJobsTx(characterId: number): Promise<void> {
    const expiredRes = await query(
      `
        SELECT id, finished_at
        FROM partner_recruit_job
        WHERE character_id = $1
          AND status = 'generated_draft'
        FOR UPDATE
      `,
      [characterId],
    );

    const expiredGenerationIds = (expiredRes.rows as Array<Record<string, unknown>>)
      .filter((row) => isPartnerRecruitPreviewExpired(toIsoString(row.finished_at)))
      .map((row) => asString(row.id))
      .filter(Boolean);
    if (expiredGenerationIds.length <= 0) return;

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'discarded',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE character_id = $1
          AND id = ANY($2::text[])
      `,
      [characterId, expiredGenerationIds],
    );
  }

  private async loadLatestJobRow(
    characterId: number,
    forUpdate: boolean,
  ): Promise<RecruitJobRow | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT
          id,
          status,
          quality_rolled,
          spirit_stones_cost,
          cooldown_started_at,
          finished_at,
          viewed_at,
          error_message,
          requested_base_model,
          preview_partner_def_id
        FROM partner_recruit_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      generationId: asString(row.id),
      status: (asString(row.status) as PartnerRecruitJobStatus) || 'pending',
      quality: (asString(row.quality_rolled) as PartnerRecruitQuality) || '黄',
      spiritStonesCost: Math.max(0, Math.floor(asNumber(row.spirit_stones_cost, 0))),
      cooldownStartedAt: toIsoString(row.cooldown_started_at) ?? new Date().toISOString(),
      finishedAt: toIsoString(row.finished_at),
      viewedAt: toIsoString(row.viewed_at),
      errorMessage: asString(row.error_message) || null,
      requestedBaseModel: asString(row.requested_base_model) || null,
      previewPartnerDefId: asString(row.preview_partner_def_id) || null,
    };
  }

  private async loadLatestRecruitCooldownStartedAt(
    characterId: number,
    forUpdate: boolean,
  ): Promise<string | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT cooldown_started_at
        FROM partner_recruit_job
        WHERE character_id = $1
          AND status = ANY($2::text[])
          AND requested_base_model IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        ${lockSql}
      `,
      [characterId, [...PARTNER_RECRUIT_COOLDOWN_APPLY_JOB_STATUSES]],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return toIsoString(row.cooldown_started_at);
  }

  private async loadCharacterSpiritStones(characterId: number, forUpdate: boolean): Promise<number | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT spirit_stones
        FROM characters
        WHERE id = $1
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    return Math.max(0, Math.floor(asNumber((result.rows[0] as Record<string, unknown>).spirit_stones, 0)));
  }

  private async loadCharacterUserId(characterId: number, forUpdate: boolean): Promise<number | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT user_id
        FROM characters
        WHERE id = $1
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    const userId = Number((result.rows[0] as Record<string, unknown>).user_id);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    return userId;
  }

  private async loadCustomBaseModelTokenAvailableQty(characterId: number, forUpdate: boolean): Promise<number> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND item_def_id = $2
          AND location IN ('bag', 'warehouse')
          AND locked = false
        ${lockSql}
      `,
      [characterId, PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID],
    );
    return result.rows.reduce((totalQty, row) => {
      const currentQty = Number((row as Record<string, unknown>).qty ?? 0);
      if (!Number.isFinite(currentQty) || currentQty <= 0) {
        return totalQty;
      }
      return totalQty + Math.floor(currentQty);
    }, 0);
  }

  async getRecruitStatus(characterId: number): Promise<ServiceResult<PartnerRecruitStatusDto>> {
    const featureUnlocked = await isFeatureUnlocked(characterId, PARTNER_SYSTEM_FEATURE_CODE);
    if (!featureUnlocked) {
      return { success: false, message: '伙伴系统尚未解锁', code: 'PARTNER_SYSTEM_LOCKED' };
    }
    const customBaseModelTokenItemName = getPartnerRecruitCustomBaseModelTokenName();
    const customBaseModelTokenAvailableQty = await this.loadCustomBaseModelTokenAvailableQty(characterId, false);

    const unlockState = await this.getPartnerRecruitUnlockStateTx(characterId, false);
    if (!unlockState.success || !unlockState.data) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    if (!unlockState.data.unlocked) {
      const cooldownState = buildPartnerRecruitCooldownState(null);
      return {
        success: true,
        message: '获取成功',
        data: buildPartnerRecruitStatusDto({
          featureCode: PARTNER_SYSTEM_FEATURE_CODE,
          unlockState: unlockState.data,
          spiritStoneCost: PARTNER_RECRUIT_SPIRIT_STONES_COST,
          cooldownHours: cooldownState.cooldownHours,
          cooldownUntil: cooldownState.cooldownUntil,
          cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
          customBaseModelBypassesCooldown: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN,
          customBaseModelMaxLength: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH,
          customBaseModelTokenCost: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
          customBaseModelTokenItemName,
          customBaseModelTokenAvailableQty,
          currentJob: null,
          hasUnreadResult: false,
          resultStatus: null,
        }),
      };
    }

    await this.discardExpiredDraftJobsTx(characterId);
    const latestJob = await this.loadLatestJobRow(characterId, false);
    const latestCooldownStartedAt = await this.loadLatestRecruitCooldownStartedAt(characterId, false);
    const cooldownReductionRate = await getActiveMonthCardCooldownReductionRate(characterId);
    const cooldownState = buildPartnerRecruitCooldownState(latestCooldownStartedAt, new Date(), {
      cooldownReductionRate,
    });
    const preview = latestJob?.previewPartnerDefId
      ? buildRecruitPreviewByPartnerDefId(latestJob.previewPartnerDefId)
      : null;
    const jobState = buildPartnerRecruitJobState(latestJob
      ? {
          generationId: latestJob.generationId,
          status: latestJob.status,
          startedAt: latestJob.cooldownStartedAt,
          finishedAt: latestJob.finishedAt,
          viewedAt: latestJob.viewedAt,
          errorMessage: latestJob.errorMessage,
          previewExpireAt: buildPartnerRecruitPreviewExpireAt(latestJob.finishedAt),
          requestedBaseModel: latestJob.requestedBaseModel,
          preview,
        }
      : null);

    return {
      success: true,
      message: '获取成功',
      data: buildPartnerRecruitStatusDto({
        featureCode: PARTNER_SYSTEM_FEATURE_CODE,
        unlockState: unlockState.data,
        spiritStoneCost: PARTNER_RECRUIT_SPIRIT_STONES_COST,
        cooldownHours: cooldownState.cooldownHours,
        cooldownUntil: cooldownState.cooldownUntil,
        cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
        customBaseModelBypassesCooldown: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN,
        customBaseModelMaxLength: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH,
        customBaseModelTokenCost: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
        customBaseModelTokenItemName,
        customBaseModelTokenAvailableQty,
        currentJob: jobState.currentJob,
        hasUnreadResult: jobState.hasUnreadResult,
        resultStatus: jobState.resultStatus,
      }),
    };
  }

  @Transactional
  private async createRecruitJobTx(
    characterId: number,
    quality: PartnerRecruitQuality,
    customBaseModelEnabled: boolean,
    requestedBaseModel: string | null,
  ): Promise<ServiceResult<{ generationId: string }>> {
    await this.discardExpiredDraftJobsTx(characterId);

    const requestedBaseModelValidation = await validatePartnerRecruitRequestedBaseModelSelection({
      enabled: customBaseModelEnabled,
      requestedBaseModel,
    });
    if (!requestedBaseModelValidation.success) {
      return {
        success: false,
        message: requestedBaseModelValidation.message,
        code: 'RECRUIT_BASE_MODEL_INVALID',
      };
    }

    const unlockState = await this.assertPartnerRecruitUnlocked(characterId, true);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const latestJob = await this.loadLatestJobRow(characterId, true);
    if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'generated_draft')) {
      return {
        success: false,
        message: latestJob.status === 'pending' ? '当前已有伙伴招募进行中' : '当前已有待确认的伙伴预览',
        code: 'RECRUIT_JOB_ACTIVE',
      };
    }

    const shouldBypassCooldown = shouldPartnerRecruitBypassCooldownWithCustomBaseModel(requestedBaseModelValidation.value);
    if (!shouldBypassCooldown) {
      const cooldownReductionRate = await getActiveMonthCardCooldownReductionRate(characterId);
      const latestCooldownStartedAt = await this.loadLatestRecruitCooldownStartedAt(characterId, true);
      const cooldownState = buildPartnerRecruitCooldownState(latestCooldownStartedAt, new Date(), {
        cooldownReductionRate,
      });
      if (cooldownState.isCoolingDown) {
        return {
          success: false,
          message: `伙伴招募冷却中，还需等待${formatPartnerRecruitCooldownRemaining(cooldownState.cooldownRemainingSeconds)}`,
          code: 'RECRUIT_COOLDOWN_ACTIVE',
        };
      }
    }

    const spiritStones = await this.loadCharacterSpiritStones(characterId, true);
    if (spiritStones === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }
    if (spiritStones < PARTNER_RECRUIT_SPIRIT_STONES_COST) {
      return {
        success: false,
        message: `灵石不足，需要${PARTNER_RECRUIT_SPIRIT_STONES_COST.toLocaleString()}，当前${spiritStones.toLocaleString()}`,
        code: 'SPIRIT_STONES_NOT_ENOUGH',
      };
    }

    if (requestedBaseModelValidation.value) {
      const customBaseModelTokenAvailableQty = await this.loadCustomBaseModelTokenAvailableQty(characterId, true);
      if (customBaseModelTokenAvailableQty < PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST) {
        const tokenItemName = getPartnerRecruitCustomBaseModelTokenName();
        return {
          success: false,
          message: `${tokenItemName}不足，启用自定义底模需消耗${PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST}枚`,
          code: 'RECRUIT_CUSTOM_BASE_MODEL_TOKEN_NOT_ENOUGH',
        };
      }
    }

    const generationId = buildPartnerRecruitGenerationId();
    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones - $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [characterId, PARTNER_RECRUIT_SPIRIT_STONES_COST],
    );

    if (requestedBaseModelValidation.value) {
      const consumeTokenResult = await consumeMaterialByDefId(
        characterId,
        PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
        PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
      );
      if (!consumeTokenResult.success) {
        return {
          success: false,
          message: consumeTokenResult.message,
          code: 'RECRUIT_CUSTOM_BASE_MODEL_TOKEN_CONSUME_FAILED',
        };
      }
    }

    await query(
      `
        INSERT INTO partner_recruit_job (
          id,
          character_id,
          status,
          quality_rolled,
          spirit_stones_cost,
          requested_base_model,
          cooldown_started_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'pending', $3, $4, $5, NOW(), NOW(), NOW()
        )
      `,
      [
        generationId,
        characterId,
        quality,
        PARTNER_RECRUIT_SPIRIT_STONES_COST,
        requestedBaseModelValidation.value,
      ],
    );

    return {
      success: true,
      message: '伙伴招募已开始',
      data: {
        generationId,
      },
    };
  }

  async createRecruitJob(
    characterId: number,
    quality: PartnerRecruitQuality,
    customBaseModelEnabled: boolean,
    requestedBaseModel: string | null,
  ): Promise<ServiceResult<{ generationId: string }>> {
    return this.createRecruitJobTx(characterId, quality, customBaseModelEnabled, requestedBaseModel);
  }

  @Transactional
  private async refundRecruitJobTx(
    characterId: number,
    generationId: string,
    reason: string,
    nextStatus: 'failed' | 'refunded' = 'refunded',
  ): Promise<void> {
    const jobRes = await query(
      `
        SELECT status, spirit_stones_cost, requested_base_model
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length <= 0) return;
    const row = jobRes.rows[0] as Record<string, unknown>;
    const status = asString(row.status);
    const spiritStonesCost = Math.max(0, Math.floor(asNumber(row.spirit_stones_cost, 0)));
    const requestedBaseModel = asString(row.requested_base_model) || null;
    if (status === 'accepted' || status === 'discarded' || status === 'failed' || status === 'refunded') return;

    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones + $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [characterId, spiritStonesCost],
    );
    if (requestedBaseModel) {
      const userId = await this.loadCharacterUserId(characterId, true);
      if (userId) {
        await addItemToInventory(
          characterId,
          userId,
          PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
          PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
          {
            obtainedFrom: 'partner_recruit_refund',
          },
        );
      }
    }
    await query(
      `
        UPDATE partner_recruit_job
        SET status = $3,
            error_message = $4,
            finished_at = COALESCE(finished_at, NOW()),
            viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId, nextStatus, reason],
    );
  }

  async forceRefundPendingRecruitJob(
    characterId: number,
    generationId: string,
    reason: string,
  ): Promise<void> {
    await this.refundRecruitJobTx(characterId, generationId, reason, 'refunded');
  }

  @Transactional
  private async persistGeneratedRecruitDraftTx(args: {
    characterId: number;
    generationId: string;
    draft: PartnerRecruitDraft;
    partnerDefId: string;
    avatarUrl: string;
    techniques: GeneratedRecruitTechniqueDraft[];
  }): Promise<ServiceResult<{ preview: PartnerRecruitPreviewDto }>> {
    const { characterId, generationId, draft, partnerDefId, avatarUrl, techniques } = args;
    const jobRes = await query(
      `
        SELECT id, status
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const jobStatus = asString((jobRes.rows[0] as Record<string, unknown>).status);
    if (jobStatus !== 'pending') {
      return { success: false, message: '招募任务状态异常', code: 'RECRUIT_JOB_STATE_INVALID' };
    }

    for (const technique of techniques) {
      await persistGeneratedTechniqueCandidateTx({
        generationId,
        techniqueId: technique.techniqueId,
        createdByCharacterId: characterId,
        candidate: technique.candidate,
        usageScope: 'partner_only',
        isPublished: true,
        publishedAt: new Date(),
        nameLocked: true,
        techniqueIcon: technique.candidate.skills[0]?.icon ?? null,
        displayName: technique.candidate.technique.name,
        longDescSuffix: '（伙伴天生功法）',
        requiredRealm: '凡人',
      });
    }

    const partnerDef = buildPartnerDefFromDraft(partnerDefId, generationId, characterId, draft, avatarUrl, techniques);
    await query(
      `
        INSERT INTO generated_partner_def (
          id,
          name,
          description,
          avatar,
          quality,
          attribute_element,
          role,
          max_technique_slots,
          base_attrs,
          level_attr_gains,
          innate_technique_ids,
          enabled,
          created_by_character_id,
          source_job_id,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb,
          $10::jsonb,
          $11::text[],
          true, $12, $13, NOW(), NOW()
        )
      `,
      [
        partnerDef.id,
        partnerDef.name,
        partnerDef.description ?? null,
        partnerDef.avatar ?? null,
        partnerDef.quality,
        partnerDef.attribute_element,
        partnerDef.role,
        partnerDef.max_technique_slots,
        JSON.stringify(partnerDef.base_attrs),
        JSON.stringify(partnerDef.level_attr_gains ?? {}),
        partnerDef.innate_technique_ids,
        characterId,
        generationId,
      ],
    );

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'generated_draft',
            preview_partner_def_id = $3,
            preview_avatar_url = $4,
            finished_at = NOW(),
            viewed_at = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId, partnerDefId, avatarUrl],
    );

    await refreshGeneratedTechniqueSnapshots();
    await refreshGeneratedPartnerSnapshots();

    const preview = buildRecruitPreviewByPartnerDefId(partnerDefId);
    if (!preview) {
      return { success: false, message: '生成成功但预览构建失败', code: 'RECRUIT_PREVIEW_BUILD_FAILED' };
    }

    return {
      success: true,
      message: '伙伴预览已生成',
      data: {
        preview,
      },
    };
  }

  async processPendingRecruitJob(args: {
    characterId: number;
    generationId: string;
    quality: PartnerRecruitQuality;
  }): Promise<ServiceResult<{ status: Extract<PartnerRecruitJobStatus, 'generated_draft' | 'failed' | 'refunded'>; preview: PartnerRecruitPreviewDto | null; errorMessage: string | null }>> {
    const job = await query(
      `
        SELECT status, requested_base_model
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        LIMIT 1
      `,
      [args.generationId, args.characterId],
    );
    if (job.rows.length <= 0) {
      return {
        success: true,
        message: '招募任务不存在',
        data: {
          status: 'failed',
          preview: null,
          errorMessage: '招募任务不存在',
        },
      };
    }

    const jobRow = job.rows[0] as Record<string, unknown>;
    const jobStatus = asString(jobRow.status);
    if (jobStatus !== 'pending') {
      return {
        success: true,
        message: '招募任务状态异常',
        data: {
          status: 'failed',
          preview: null,
          errorMessage: '招募任务状态异常',
        },
      };
    }

    const requestedBaseModel = asString(jobRow.requested_base_model) || null;
    const maxAttempts = 3;
    let lastFailure = '伙伴生成失败';
    let lastModelName = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await tryCallPartnerRecruitTextModel({
        quality: args.quality,
        requestedBaseModel,
      });
      if (!result.success) {
        lastFailure = result.reason;
        lastModelName = result.modelName;
        continue;
      }

      try {
        const partnerDefId = buildGeneratedPartnerDefId();
        const { techniques, avatarUrl } = await executePartnerRecruitVisualGeneration({
          characterId: args.characterId,
          generationId: args.generationId,
          draft: result.draft,
          partnerDefId,
        });

        const persist = await this.persistGeneratedRecruitDraftTx({
          characterId: args.characterId,
          generationId: args.generationId,
          draft: result.draft,
          partnerDefId,
          avatarUrl,
          techniques,
        });
        if (!persist.success || !persist.data) {
          lastFailure = persist.message;
          lastModelName = result.modelName;
          continue;
        }

        return {
          success: true,
          message: '伙伴预览生成成功',
          data: {
            status: 'generated_draft',
            preview: persist.data.preview,
            errorMessage: null,
          },
        };
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : '伙伴功法生成异常';
        lastModelName = result.modelName;
        continue;
      }
    }

    const finalReason = lastModelName ? `伙伴生成失败：${lastFailure}（model=${lastModelName}）` : `伙伴生成失败：${lastFailure}`;
    await this.refundRecruitJobTx(args.characterId, args.generationId, finalReason, 'refunded');
    return {
      success: true,
      message: finalReason,
      data: {
        status: 'refunded',
        preview: null,
        errorMessage: finalReason,
      },
    };
  }

  async confirmRecruitDraft(characterId: number, generationId: string): Promise<ServiceResult<PartnerRecruitConfirmResponse>> {
    const result = await this.confirmRecruitDraftTx(characterId, generationId);
    if (result.success && result.data) {
      await this.broadcastHeavenPartnerRecruit(
        characterId,
        result.data.partnerDefId,
        result.data.partnerName,
      );
    }
    return result;
  }

  @Transactional
  private async confirmRecruitDraftTx(characterId: number, generationId: string): Promise<ServiceResult<PartnerRecruitConfirmResponse>> {
    const unlockState = await this.assertPartnerRecruitUnlocked(characterId, true);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    await this.discardExpiredDraftJobsTx(characterId);
    const result = await query(
      `
        SELECT id, status, finished_at, preview_partner_def_id
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (result.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const row = result.rows[0] as Record<string, unknown>;
    const status = asString(row.status) as PartnerRecruitJobStatus;
    const previewPartnerDefId = asString(row.preview_partner_def_id);
    if (status !== 'generated_draft' || !previewPartnerDefId) {
      return { success: false, message: '当前预览不可确认收下', code: 'RECRUIT_JOB_STATE_INVALID' };
    }
    if (isPartnerRecruitPreviewExpired(toIsoString(row.finished_at))) {
      await query(
        `
          UPDATE partner_recruit_job
          SET status = 'discarded',
              viewed_at = COALESCE(viewed_at, NOW()),
              updated_at = NOW()
          WHERE id = $1 AND character_id = $2
        `,
        [generationId, characterId],
      );
      return { success: false, message: '预览已过期，无法确认收下', code: 'RECRUIT_PREVIEW_EXPIRED' };
    }

    const definition = getPartnerDefinitionById(previewPartnerDefId);
    if (!definition) {
      return { success: false, message: '预览伙伴定义不存在', code: 'RECRUIT_PREVIEW_NOT_FOUND' };
    }

    const created = await partnerService.createPartnerInstanceFromDefinition({
      characterId,
      definition,
      obtainedFrom: 'partner_recruit',
      obtainedRefId: generationId,
      nickname: definition.name,
    });

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'accepted',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId],
    );

    return {
      success: true,
      message: '已确认收下新伙伴',
      data: {
        generationId,
        partnerId: created.reward.partnerId,
        partnerDefId: created.reward.partnerDefId,
        partnerName: created.reward.partnerName,
        partnerAvatar: created.reward.partnerAvatar,
        activated: created.activated,
      },
    };
  }

  @Transactional
  async discardRecruitDraft(characterId: number, generationId: string): Promise<ServiceResult<{ generationId: string }>> {
    const result = await query(
      `
        SELECT status
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (result.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const status = asString((result.rows[0] as Record<string, unknown>).status) as PartnerRecruitJobStatus;
    if (status !== 'generated_draft') {
      return { success: false, message: '当前任务不可放弃', code: 'RECRUIT_JOB_STATE_INVALID' };
    }

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'discarded',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId],
    );
    return {
      success: true,
      message: '已放弃本次伙伴预览',
      data: {
        generationId,
      },
    };
  }

  @Transactional
  async markResultViewed(characterId: number): Promise<ServiceResult<{ generationId: string | null }>> {
    const latestJob = await this.loadLatestJobRow(characterId, true);
    if (!latestJob) {
      return {
        success: true,
        message: '当前没有可标记结果',
        data: {
          generationId: null,
        },
      };
    }

    if (
      latestJob.status !== 'generated_draft' &&
      latestJob.status !== 'failed' &&
      latestJob.status !== 'refunded'
    ) {
      return {
        success: true,
        message: '当前没有可标记结果',
        data: {
          generationId: null,
        },
      };
    }

    await query(
      `
        UPDATE partner_recruit_job
        SET viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [latestJob.generationId, characterId],
    );
    return {
      success: true,
      message: '已标记查看',
      data: {
        generationId: latestJob.generationId,
      },
    };
  }

  resolveQualityForNewRecruit(): PartnerRecruitQuality {
    return resolvePartnerRecruitQualityByWeight();
  }
}

export const partnerRecruitService = new PartnerRecruitService();
export default partnerRecruitService;
