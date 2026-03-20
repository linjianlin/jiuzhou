/**
 * AI 伙伴预览生成共享核心
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一承接 AI 伙伴草稿生成、头像与天生功法并发生成、动态伙伴定义落库，以及预览 DTO 构建。
 * 2) 做什么：让伙伴招募与三魂归契复用同一条“生成新伙伴预览”链路，避免两套模型请求、图标生成和落库逻辑并存。
 * 3) 不做什么：不管理具体业务任务状态，不决定是招募还是融合，也不处理确认收下后的伙伴实例创建。
 *
 * 输入/输出：
 * - 输入：角色 ID、任务 ID、目标品质、伙伴草稿，以及生成/落库所需依赖。
 * - 输出：动态伙伴预览 DTO、动态伙伴定义与生成功法草稿。
 *
 * 数据流/状态流：
 * 业务任务 -> 文本模型生成伙伴草稿 -> 头像/功法并发生成 -> generated_technique_def + generated_partner_def -> 预览 DTO。
 *
 * 关键边界条件与坑点：
 * 1) 动态伙伴预览依赖“伙伴定义 + 生成功法/技能”两套快照，落库后必须统一刷新，否则确认与预览读取会断链。
 * 2) 这里故意不感知业务任务表；任务状态推进由调用方负责，避免共享核心反向耦合招募/融合各自的状态机。
 */
import { randomUUID } from 'crypto';
import { query } from '../../config/database.js';
import {
  getPartnerDefinitionById,
  getSkillDefinitions,
  getTechniqueDefinitions,
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
  type PartnerDefConfig,
} from '../staticConfigLoader.js';
import {
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
} from './techniqueTextModelShared.js';
import { resolveTechniqueGenerationRequestFailure } from './techniqueGenerationRequestFailure.js';
import {
  buildPartnerRecruitPromptNoiseHash,
  buildPartnerRecruitPromptInput,
  buildPartnerRecruitResponseFormat,
  fillPartnerRecruitBaseAttrs,
  getPartnerRecruitTechniqueMaxLayer,
  type PartnerRecruitBaseAttrs,
  type PartnerRecruitCombatStyle,
  type PartnerRecruitDraft,
  type PartnerRecruitQuality,
  validatePartnerRecruitDraft,
} from './partnerRecruitRules.js';
import { PARTNER_RECRUIT_FORM_RULES } from './partnerRecruitCreativeDirection.js';
import {
  guardPartnerRecruitRequestedBaseModel,
  resolvePartnerRecruitBaseModel,
  type PartnerRecruitRequestedBaseModelValidationResult,
} from './partnerRecruitBaseModel.js';
import {
  generatePartnerRecruitAvatar,
  type PartnerRecruitAvatarInput,
} from './partnerRecruitAvatarGenerator.js';
import { generateTechniqueCandidateWithIcons } from './techniqueGenerationExecution.js';
import {
  TechniqueGenerationExhaustedError,
  generateTechniqueCandidateWithRetry,
  remapTechniqueCandidateSkillIds,
  validateTechniqueGenerationCandidate,
} from './techniqueGenerationCandidateCore.js';
import { persistGeneratedTechniqueCandidateTx } from './generatedTechniquePersistence.js';
import { callConfiguredTextModel } from '../ai/openAITextClient.js';
import type { GeneratedTechniqueType } from './techniqueGenerationConstraints.js';
import type { TechniqueGenerationCandidate } from '../techniqueGenerationService.js';

export type GeneratedPartnerPreviewTechniqueDto = {
  techniqueId: string;
  name: string;
  description: string;
  quality: string;
  icon: string | null;
  skillNames: string[];
};

export type GeneratedPartnerPreviewDto = {
  partnerDefId: string;
  name: string;
  description: string;
  avatar: string | null;
  quality: string;
  element: string;
  role: string;
  slotCount: number;
  baseAttrs: PartnerRecruitBaseAttrs;
  levelAttrGains: PartnerRecruitBaseAttrs;
  innateTechniques: GeneratedPartnerPreviewTechniqueDto[];
};

export type GeneratedPartnerTechniqueDraft = {
  techniqueId: string;
  candidate: TechniqueGenerationCandidate;
};

export type GeneratedPartnerTextAttemptFailure = {
  success: false;
  reason: string;
  modelName: string;
};

export type GeneratedPartnerTextAttemptSuccess = {
  success: true;
  draft: PartnerRecruitDraft;
  modelName: string;
};

export type GeneratedPartnerTextAttemptResult =
  | GeneratedPartnerTextAttemptFailure
  | GeneratedPartnerTextAttemptSuccess;

const PARTNER_GENERATION_PROMPT_SYSTEM_MESSAGE = [
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

const asString = (raw: string | null | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

const normalizeGeneratedId = (prefix: string): string => {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const resolveCombatStyleAttributeType = (
  combatStyle: PartnerRecruitCombatStyle,
): { attributeType: 'physical' | 'magic' } => {
  if (combatStyle === 'physical') {
    return {
      attributeType: 'physical',
    };
  }
  return {
    attributeType: 'magic',
  };
};

const resolveGeneratedPartnerTechniqueType = (
  combatStyle: PartnerRecruitCombatStyle,
  kind: PartnerRecruitDraft['innateTechniques'][number]['kind'],
): GeneratedTechniqueType => {
  if (kind === 'attack') {
    return resolveCombatStyleAttributeType(combatStyle).attributeType === 'physical' ? '武技' : '法诀';
  }
  return '辅修';
};

const resolveGeneratedPartnerDefaultSkillIcon = (
  kind: PartnerRecruitDraft['innateTechniques'][number]['kind'],
): string => {
  if (kind === 'attack') return DEFAULT_ATTACK_SKILL_ICON;
  if (kind === 'support') return DEFAULT_SUPPORT_SKILL_ICON;
  return DEFAULT_GUARD_SKILL_ICON;
};

const buildGeneratedPartnerTechniquePromptContext = (params: {
  draft: PartnerRecruitDraft;
  technique: PartnerRecruitDraft['innateTechniques'][number];
  techniqueIndex: number;
  techniqueType: GeneratedTechniqueType;
}): {
  partner: {
    name: string;
    quality: string;
    role: string;
    combatStyle: string;
    attributeElement: string;
    description: string;
  };
  innateTechnique: {
    slot: number;
    totalCount: number;
    kind: string;
    preferredTechniqueType: GeneratedTechniqueType;
    preferredName: string;
    preferredDescription: string;
    preferredPassiveKey: string;
    preferredPassiveValue: number;
  };
} => {
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

const buildPartnerGenerationAvatarInput = (
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

const adaptTechniqueCandidateForGeneratedPartner = (params: {
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

const generateGeneratedPartnerTechniqueDrafts = async (params: {
  characterId: number;
  generationId: string;
  draft: PartnerRecruitDraft;
}): Promise<GeneratedPartnerTechniqueDraft[]> => {
  const { characterId, generationId, draft } = params;
  const maxLayer = getPartnerRecruitTechniqueMaxLayer(draft.partner.quality);
  const generatedTechniques: GeneratedPartnerTechniqueDraft[] = [];

  for (const [index, entry] of draft.innateTechniques.entries()) {
    const techniqueType = resolveGeneratedPartnerTechniqueType(draft.partner.combatStyle, entry.kind);
    const generated = await generateTechniqueCandidateWithRetry({
      generationId: `${generationId}:innate:${index + 1}`,
      characterId,
      techniqueType,
      quality: draft.partner.quality,
      maxLayer,
      promptContext: buildGeneratedPartnerTechniquePromptContext({
        draft,
        technique: entry,
        techniqueIndex: index,
        techniqueType,
      }),
    });
    const adaptedCandidate = adaptTechniqueCandidateForGeneratedPartner({
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
      defaultSkillIcon: resolveGeneratedPartnerDefaultSkillIcon(entry.kind),
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

export const buildGeneratedPartnerDefId = (): string => normalizeGeneratedId('partner-gen');

export const buildGeneratedTechniqueId = (): string => normalizeGeneratedId('tech-partner');

export const buildGeneratedPartnerTextModelRequest = (params: {
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
    systemMessage: PARTNER_GENERATION_PROMPT_SYSTEM_MESSAGE,
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

export const tryCallGeneratedPartnerTextModel = async (params: {
  quality: PartnerRecruitQuality;
  requestedBaseModel?: string | null;
}): Promise<GeneratedPartnerTextAttemptResult> => {
  const requestedBaseModelValidation: PartnerRecruitRequestedBaseModelValidationResult =
    await guardPartnerRecruitRequestedBaseModel(params.requestedBaseModel);
  if (!requestedBaseModelValidation.success) {
    return {
      success: false,
      reason: requestedBaseModelValidation.message,
      modelName: 'gpt-4o-mini',
    };
  }

  const request = buildGeneratedPartnerTextModelRequest({
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

  try {
    const parsed = parseTechniqueTextModelJsonObject(external.content, {
      preferredTopLevelKeys: ['partner', 'innateTechniques'],
    });
    if (!parsed.success) {
      return {
        success: false,
        reason: parsed.reason === 'empty_content' ? '伙伴生成模型返回空内容' : '伙伴生成模型未返回合法 JSON',
        modelName: external.modelName,
      };
    }

    const draft = validatePartnerRecruitDraft(parsed.data);
    if (!draft) {
      return {
        success: false,
        reason: '伙伴生成模型返回结构非法或超出约束',
        modelName: external.modelName,
      };
    }
    if (draft.partner.quality !== params.quality) {
      return {
        success: false,
        reason: '伙伴生成模型返回的品质与本次目标品质不一致',
        modelName: external.modelName,
      };
    }

    return {
      success: true,
      draft,
      modelName: external.modelName,
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
      modelName: external.modelName,
    };
  }
};

/**
 * 伙伴视觉资源并发执行入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把伙伴头像与天生功法生成收口为单入口，供招募与三魂归契复用。
 * 2) 不做什么：不落库、不推进任务状态，也不吞掉任一子任务异常。
 *
 * 输入/输出：
 * - 输入：角色 ID、业务任务 ID、伙伴草稿、伙伴定义 ID。
 * - 输出：`{ techniques, avatarUrl }`。
 *
 * 数据流/状态流：
 * 伙伴草稿 -> 天生功法生成 / 头像生成并发 -> 调用方事务落库。
 *
 * 关键边界条件与坑点：
 * 1) 这里只做并发编排，不处理补偿；任一子任务失败必须原样上抛给业务层。
 * 2) 头像入参映射只维护这一份，避免不同业务入口再各写一次 name/quality/element 拼装。
 */
export const executeGeneratedPartnerVisualGeneration = async (
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
    }) => Promise<GeneratedPartnerTechniqueDraft[]>;
    generateAvatar: (input: PartnerRecruitAvatarInput) => Promise<string>;
  } = {
    generateTechniques: generateGeneratedPartnerTechniqueDrafts,
    generateAvatar: generatePartnerRecruitAvatar,
  },
): Promise<{
  techniques: GeneratedPartnerTechniqueDraft[];
  avatarUrl: string;
}> => {
  const [techniques, avatarUrl] = await Promise.all([
    deps.generateTechniques({
      characterId: params.characterId,
      generationId: params.generationId,
      draft: params.draft,
    }),
    deps.generateAvatar(buildPartnerGenerationAvatarInput(params.partnerDefId, params.draft)),
  ]);

  return {
    techniques,
    avatarUrl,
  };
};

export const buildGeneratedPartnerDefinitionFromDraft = (
  partnerDefId: string,
  generationId: string,
  characterId: number,
  draft: PartnerRecruitDraft,
  avatarUrl: string,
  techniques: GeneratedPartnerTechniqueDraft[],
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

export const buildGeneratedPartnerPreviewFromDefinition = (
  definition: PartnerDefConfig,
): GeneratedPartnerPreviewDto => {
  const skillDefinitions = getSkillDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueDefinitions = getTechniqueDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueMap = new Map(techniqueDefinitions.map((entry) => [entry.id, entry] as const));
  const skillsByTechniqueId = new Map<string, string[]>();

  for (const skill of skillDefinitions) {
    if (skill.source_type !== 'technique') continue;
    const sourceId = asString(skill.source_id);
    if (!sourceId) continue;
    const currentSkillNames = skillsByTechniqueId.get(sourceId) ?? [];
    const skillName = asString(skill.name);
    if (skillName) {
      currentSkillNames.push(skillName);
      skillsByTechniqueId.set(sourceId, currentSkillNames);
    }
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

export const buildGeneratedPartnerPreviewByPartnerDefId = (
  partnerDefId: string,
): GeneratedPartnerPreviewDto | null => {
  const definition = getPartnerDefinitionById(partnerDefId);
  if (!definition) return null;
  return buildGeneratedPartnerPreviewFromDefinition(definition);
};

/**
 * 动态伙伴定义事务落库入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：在当前事务里落生成功法与动态伙伴定义，并刷新运行时快照，返回可直接展示的预览 DTO。
 * 2) 不做什么：不改业务任务表，不决定任务成功/失败，也不创建实际伙伴实例。
 *
 * 输入/输出：
 * - 输入：角色 ID、业务任务 ID、伙伴草稿、伙伴定义 ID、头像 URL、天生功法草稿。
 * - 输出：`{ preview, partnerDef }`。
 *
 * 数据流/状态流：
 * 业务事务 -> generated_technique_def / generated_partner_def -> 刷新快照 -> 预览 DTO。
 *
 * 关键边界条件与坑点：
 * 1) 这里必须运行在调用方事务里，保证“任务状态更新”和“动态定义落库”同成同败。
 * 2) 若快照刷新失败必须抛错，让整笔事务回滚，不能留下数据库里有定义但运行时读不到的半完成状态。
 */
export const persistGeneratedPartnerPreviewTx = async (params: {
  characterId: number;
  generationId: string;
  draft: PartnerRecruitDraft;
  partnerDefId: string;
  avatarUrl: string;
  techniques: GeneratedPartnerTechniqueDraft[];
}): Promise<{
  preview: GeneratedPartnerPreviewDto;
  partnerDef: PartnerDefConfig;
}> => {
  const { characterId, generationId, draft, partnerDefId, avatarUrl, techniques } = params;

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

  const partnerDef = buildGeneratedPartnerDefinitionFromDraft(
    partnerDefId,
    generationId,
    characterId,
    draft,
    avatarUrl,
    techniques,
  );

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

  await refreshGeneratedTechniqueSnapshots();
  await refreshGeneratedPartnerSnapshots();

  return {
    preview: buildGeneratedPartnerPreviewFromDefinition(partnerDef),
    partnerDef,
  };
};
