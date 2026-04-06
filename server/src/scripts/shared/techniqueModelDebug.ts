/**
 * 功法模型联调共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装功法文本模型联调所需的参数解析辅助、主模型生成、第二模型平衡复评、按复评意见二次生成、可选技能图标挂载与摘要提取。
 * 2. 做什么：让单次联调脚本与批量功法书测试脚本共用同一套生成核心，避免 prompt、JSON 解析、校验与汇总逻辑再次分叉。
 * 3. 不做什么：不写数据库、不创建生成任务、不发放道具，也不决定批量文件如何命名与落盘。
 *
 * 输入 / 输出：
 * - 输入：功法品质、功法类型、可选 seed、可选底模、是否生成技能图标。
 * - 输出：包含模型名、seed、归一化 candidate、摘要信息的联调结果。
 *
 * 数据流 / 状态流：
 * CLI 参数
 * -> 本模块解析质量/类型/seed
 * -> 功法文本模型请求构造
 * -> 主模型生成 candidate
 * -> 可选第二模型复评数值平衡
 * -> 复评启用且需要调整时按修正规则再次生成
 * -> 共享清洗与校验
 * -> 调用方决定打印或落盘。
 *
 * 复用设计说明：
 * - 单次联调与批量落盘都依赖同一条“请求模型 -> 清洗 -> 校验 -> 摘要”链路，集中到这里后只维护一份生成口径。
 * - 高频变化点是模型请求参数与结果结构校验，因此统一收在本模块，调用脚本只保留各自的 CLI 和输出职责。
 *
 * 关键边界条件与坑点：
 * 1. `server/tsconfig.json` 只编译 `src` 目录下的 TypeScript 文件，所以共享核心必须放在 `src` 下，才能被 `tsc -b` 实际校验。
 * 2. 批量测试默认不生成图片；是否挂技能图标必须由调用方显式声明，避免脚本因环境变量存在而偷偷扩大测试范围。
 * 3. 是否启用复评必须由调用方显式传入，避免“未指定复评模型”与“沿用环境默认复评模型”被混成同一条链路。
 */

import { readTextModelConfig } from '../../services/ai/modelConfig.js';
import type { TechniqueGenerationCandidate, TechniqueQuality } from '../../services/techniqueGenerationService.js';
import { validatePartnerRecruitRequestedBaseModel } from '../../services/shared/partnerRecruitBaseModel.js';
import {
  reviewTechniqueBalanceCandidate,
  type TechniqueBalanceReviewResponse,
  type TechniqueBalanceReviewResult,
} from '../../services/shared/techniqueBalanceReview.js';
import {
  buildTechniqueGenerationTextModelRequest,
  sanitizeTechniqueGenerationCandidateFromModelDetailed,
  validateTechniqueGenerationCandidate,
} from '../../services/shared/techniqueGenerationCandidateCore.js';
import {
  GENERATED_TECHNIQUE_TYPE_LIST,
  type GeneratedTechniqueType,
} from '../../services/shared/techniqueGenerationConstraints.js';
import { generateTechniqueSkillIconMap } from '../../services/shared/techniqueSkillImageGenerator.js';
import { callConfiguredTextModel } from '../../services/ai/openAITextClient.js';
import { parseTechniqueTextModelJsonObject } from '../../services/shared/techniqueTextModelShared.js';

export type TechniqueModelDebugArgMap = Record<string, string | undefined>;

export type TechniqueModelDebugSummary = {
  techniqueName: string;
  techniqueType: TechniqueGenerationCandidate['technique']['type'];
  skillCount: number;
  layerCount: number;
};

export type TechniqueModelDebugBalanceReviewSummary = {
  enabled: boolean;
  modelName: string;
  adjusted: boolean;
  reason: string;
  riskTags: TechniqueBalanceReviewResult['riskTags'];
  adjustmentGuidance: string[];
};

export type TechniqueModelDebugGenerationTrace = {
  modelName: string;
  seed: number;
  attemptCount: number;
  elapsedMs: number;
  promptBytes: number;
  promptSnapshotBytes: number;
  techniqueName: string;
  skillCount: number;
  layerCount: number;
};

export type TechniqueModelDebugReviewTrace = {
  enabled: boolean;
  modelName: string;
  elapsedMs: number;
  promptSnapshotBytes: number;
  adjusted: boolean;
  reason: string;
  riskTags: TechniqueBalanceReviewResult['riskTags'];
  adjustmentGuidance: string[];
};

export type TechniqueModelDebugSkillIconTrace = {
  enabled: boolean;
  elapsedMs: number;
  attachedCount: number;
};

export type TechniqueModelDebugTrace = {
  initialGeneration: TechniqueModelDebugGenerationTrace;
  balanceReview: TechniqueModelDebugReviewTrace;
  finalGeneration: TechniqueModelDebugGenerationTrace;
  skillIcons: TechniqueModelDebugSkillIconTrace;
  totalElapsedMs: number;
};

export type TechniqueModelDebugGenerateParams = {
  quality: TechniqueQuality;
  techniqueType: GeneratedTechniqueType;
  seed?: number;
  baseModel?: string;
  includeSkillIcons: boolean;
  enableReview: boolean;
  reviewModelName?: string;
};

export type TechniqueModelDebugGenerateResult = {
  modelName: string;
  promptSnapshot: string;
  seed: number;
  quality: TechniqueQuality;
  requestedTechniqueType: GeneratedTechniqueType;
  baseModel: string | null;
  candidate: TechniqueGenerationCandidate;
  summary: TechniqueModelDebugSummary;
  balanceReview: TechniqueModelDebugBalanceReviewSummary;
  trace: TechniqueModelDebugTrace;
};

type TechniqueModelDebugPromptContext = {
  techniqueBaseModel: string;
  techniqueBaseModelScopeRules: string[];
  techniqueRetryGuidance?: {
    previousFailureReason: string;
    correctionRules: string[];
  };
};

type TechniqueModelDebugSinglePassResult = {
  modelName: string;
  promptSnapshot: string;
  promptBytes: number;
  elapsedMs: number;
  seed: number;
  attemptCount: number;
  candidate: TechniqueGenerationCandidate;
};

const QUALITY_RANDOM_WEIGHT: Array<{ quality: TechniqueQuality; weight: number }> = [
  { quality: '黄', weight: 55 },
  { quality: '玄', weight: 30 },
  { quality: '地', weight: 12 },
  { quality: '天', weight: 3 },
];

export const QUALITY_MAX_LAYER: Record<TechniqueQuality, number> = {
  黄: 3,
  玄: 5,
  地: 7,
  天: 9,
};

export const TECHNIQUE_DEBUG_BASE_MODEL_GENERAL_RULE =
  '若 extraContext.techniqueBaseModel 存在，它表示本次功法测试指定的底模；请围绕该底模延展功法命名、描述、技能意象、机制母题与整体文风，但不要把它原样重复成固定前缀，也不要输出额外字段解释底模。';
export const TECHNIQUE_DEBUG_BASE_MODEL_SCOPE_GENERAL_RULE =
  '若 extraContext.techniqueBaseModelScopeRules 存在，必须逐条遵守这些作用范围限制；底模只能收束主题、套路倾向与表现母题，不得借此突破品质、层数、效果数量、目标数量、倍率、冷却、被动预算等既有硬约束。';
export const TECHNIQUE_DEBUG_BASE_MODEL_SCOPE_RULES = [
  '底模只用于限定本次功法的主体意象、套路母题、命名气质、描述文风、技能表现与局部机制倾向，不直接决定品质、层数、技能数量、目标数量与任何数值预算。',
  '若底模与当前功法类型不完全贴合，应做仙侠语境下的合理化转译；可以保留核心母题，但不要为了迎合底模强行拼接多体系、全覆盖或违和机制。',
  '底模可以让功法风格更鲜明，但不能产出全能通吃、超大范围、多段超高倍率、超长控制、超高回复或明显超出既有硬约束与预算的结果。',
] as const;

const asString = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

export const parseCliArgMap = (argv: string[]): TechniqueModelDebugArgMap => {
  const map: TechniqueModelDebugArgMap = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      map[key] = 'true';
      continue;
    }

    map[key] = next;
    index += 1;
  }

  return map;
};

export const resolveTechniqueQualityByRandom = (): TechniqueQuality => {
  const totalWeight = QUALITY_RANDOM_WEIGHT.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new Error('功法品质权重配置非法');
  }

  const roll = Math.random() * totalWeight;
  let cursor = 0;
  for (const entry of QUALITY_RANDOM_WEIGHT) {
    cursor += entry.weight;
    if (roll <= cursor) return entry.quality;
  }

  return QUALITY_RANDOM_WEIGHT[QUALITY_RANDOM_WEIGHT.length - 1]!.quality;
};

export const resolveTechniqueQualityArg = (raw: string | undefined): TechniqueQuality | null => {
  const text = asString(raw);
  if (text === '黄' || text === '玄' || text === '地' || text === '天') return text;
  return null;
};

export const resolveTechniqueTypeByRandom = (): GeneratedTechniqueType => {
  const index = Math.floor(Math.random() * GENERATED_TECHNIQUE_TYPE_LIST.length);
  return GENERATED_TECHNIQUE_TYPE_LIST[index]!;
};

export const resolveTechniqueTypeArg = (raw: string | undefined): GeneratedTechniqueType | null => {
  const text = asString(raw);
  if (!text) return null;
  return GENERATED_TECHNIQUE_TYPE_LIST.find((entry) => entry === text) ?? null;
};

export const resolveOptionalPositiveIntegerArg = (
  raw: string | undefined,
  optionName: string,
): number | undefined => {
  const text = asString(raw);
  if (!text) return undefined;

  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`CLI 参数 --${optionName} 必须是正整数`);
  }

  return value;
};

export const overrideTechniqueModelName = (modelName: string | undefined): void => {
  const normalized = asString(modelName);
  if (!normalized) return;
  process.env.AI_TECHNIQUE_MODEL_NAME = normalized;
};

export const overrideTechniqueReviewModelName = (modelName: string | undefined): void => {
  const normalized = asString(modelName);
  if (!normalized) return;
  process.env.AI_PARTNER_MODEL_NAME = normalized;
};

export const resolveTechniqueDebugBaseModelArg = (raw: string | undefined): string | null => {
  const validation = validatePartnerRecruitRequestedBaseModel(raw);
  if (!validation.success) {
    throw new Error(`CLI 参数 --base-model 无效：${validation.message}`);
  }
  return validation.value;
};

export const isTechniqueSkillImageGenerationConfigured = (): boolean => {
  const endpoint = asString(process.env.AI_TECHNIQUE_IMAGE_MODEL_URL);
  const apiKey = asString(process.env.AI_TECHNIQUE_IMAGE_MODEL_KEY);
  return endpoint.length > 0 && apiKey.length > 0;
};

const buildTechniqueModelDebugSummary = (
  candidate: TechniqueGenerationCandidate,
): TechniqueModelDebugSummary => {
  return {
    techniqueName: candidate.technique.name,
    techniqueType: candidate.technique.type,
    skillCount: candidate.skills.length,
    layerCount: candidate.layers.length,
  };
};

const parseTechniqueModelJson = (
  content: string,
): ReturnType<typeof parseTechniqueTextModelJsonObject> => {
  return parseTechniqueTextModelJsonObject(content, {
    preferredTopLevelKeys: ['technique', 'skills', 'layers'],
  });
};

const attachGeneratedSkillIcons = async (
  candidate: TechniqueGenerationCandidate,
): Promise<{ candidate: TechniqueGenerationCandidate; attachedCount: number }> => {
  if (candidate.skills.length <= 0) {
    return {
      candidate,
      attachedCount: 0,
    };
  }

  const iconMap = await generateTechniqueSkillIconMap(candidate.skills.map((skill) => ({
    skillId: skill.id,
    techniqueName: candidate.technique.name,
    techniqueType: candidate.technique.type,
    techniqueQuality: candidate.technique.quality,
    techniqueElement: candidate.technique.attributeElement,
    skillName: skill.name,
    skillDescription: skill.description,
    skillEffects: skill.effects,
  })));

  if (iconMap.size <= 0) {
    return {
      candidate,
      attachedCount: 0,
    };
  }

  return {
    candidate: {
      ...candidate,
      skills: candidate.skills.map((skill) => {
        const icon = iconMap.get(skill.id);
        return icon ? { ...skill, icon } : skill;
      }),
    },
    attachedCount: iconMap.size,
  };
};

const buildTechniqueModelDebugPromptContext = (
  baseModel: string | undefined,
): TechniqueModelDebugPromptContext | undefined => {
  const normalized = resolveTechniqueDebugBaseModelArg(baseModel);
  if (!normalized) return undefined;

  return {
    techniqueBaseModel: normalized,
    techniqueBaseModelScopeRules: [...TECHNIQUE_DEBUG_BASE_MODEL_SCOPE_RULES],
  };
};

const buildTechniqueModelDebugRetryCorrectionRules = (params: {
  review?: TechniqueBalanceReviewResult;
  previousFailureReason?: string | null;
}): string[] => {
  const correctionRules = params.review
    ? [...params.review.adjustmentGuidance]
    : [];
  const failureReason = params.previousFailureReason?.trim();
  if (failureReason) {
    correctionRules.push(`必须先修正本轮失败原因：${failureReason}`);
  }
  return correctionRules;
};

export const buildTechniqueModelDebugGenerationPromptContext = (params: {
  basePromptContext?: TechniqueModelDebugPromptContext;
  review?: TechniqueBalanceReviewResult;
  previousFailureReason?: string | null;
}): Record<string, unknown> | undefined => {
  const { basePromptContext, review, previousFailureReason } = params;
  if (!basePromptContext && !review && !previousFailureReason) {
    return undefined;
  }

  const promptGeneralRules = basePromptContext
    ? [
        TECHNIQUE_DEBUG_BASE_MODEL_GENERAL_RULE,
        TECHNIQUE_DEBUG_BASE_MODEL_SCOPE_GENERAL_RULE,
      ]
    : [];
  const nextPromptContext: Record<string, unknown> = {
    ...(basePromptContext ?? {}),
    ...(promptGeneralRules.length > 0
      ? { techniquePromptGeneralRules: promptGeneralRules }
      : {}),
  };

  const correctionRules = buildTechniqueModelDebugRetryCorrectionRules({
    review,
    previousFailureReason,
  });
  if (correctionRules.length <= 0) {
    return nextPromptContext;
  }

  return {
    ...nextPromptContext,
    techniqueRetryGuidance: {
      previousFailureReason: previousFailureReason?.trim()
        || (review ? `功法平衡复评结论：${review.reason}` : ''),
      correctionRules,
    },
  };
};

const generateTechniqueCandidateForDebug = async (params: {
  quality: TechniqueQuality;
  techniqueType: GeneratedTechniqueType;
  seed?: number;
  basePromptContext?: TechniqueModelDebugPromptContext;
  review?: TechniqueBalanceReviewResult;
}): Promise<TechniqueModelDebugSinglePassResult> => {
  const startedAt = Date.now();
  const maxAttempts = 3;
  let previousFailureReason: string | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const request = buildTechniqueGenerationTextModelRequest({
      techniqueType: params.techniqueType,
      quality: params.quality,
      maxLayer: QUALITY_MAX_LAYER[params.quality],
      seed: params.seed,
      promptContext: buildTechniqueModelDebugGenerationPromptContext({
        basePromptContext: params.basePromptContext,
        review: params.review,
        previousFailureReason,
      }),
    });

    const response = await callConfiguredTextModel({
      modelScope: 'technique',
      responseFormat: request.responseFormat,
      systemMessage: request.systemMessage,
      userMessage: request.userMessage,
      seed: request.seed,
      temperature: request.temperature,
      timeoutMs: request.timeoutMs,
    });
    if (!response) {
      throw new Error('功法文本模型调用失败：未读取到可用模型配置');
    }

    try {
      const parsedResult = parseTechniqueModelJson(response.content);
      if (!parsedResult.success) {
        if (parsedResult.reason === 'empty_content') {
          throw new Error('模型返回内容为空');
        }
        throw new Error('模型返回不是合法 JSON 对象');
      }

      const sanitizedResult = sanitizeTechniqueGenerationCandidateFromModelDetailed(
        parsedResult.data,
        params.techniqueType,
        params.quality,
        QUALITY_MAX_LAYER[params.quality],
      );
      if (!sanitizedResult.success) {
        throw new Error(`AI结果清洗失败：${sanitizedResult.reason}`);
      }

      const validation = validateTechniqueGenerationCandidate({
        candidate: sanitizedResult.candidate,
        expectedTechniqueType: params.techniqueType,
        expectedQuality: params.quality,
        expectedMaxLayer: QUALITY_MAX_LAYER[params.quality],
      });
      if (!validation.success) {
        throw new Error(`AI结果校验失败：${validation.message}`);
      }

      return {
        modelName: response.modelName,
        promptSnapshot: response.promptSnapshot,
        promptBytes: request.userMessage.length,
        elapsedMs: Date.now() - startedAt,
        seed: request.seed,
        attemptCount: attempt,
        candidate: sanitizedResult.candidate,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      previousFailureReason = lastError.message;
      if (attempt >= maxAttempts) {
        break;
      }
    }
  }

  throw lastError ?? new Error('功法文本模型调试生成失败');
};

const buildTechniqueModelDebugGenerationTrace = (
  generation: TechniqueModelDebugSinglePassResult,
): TechniqueModelDebugGenerationTrace => {
  return {
    modelName: generation.modelName,
    seed: generation.seed,
    attemptCount: generation.attemptCount,
    elapsedMs: generation.elapsedMs,
    promptBytes: generation.promptBytes,
    promptSnapshotBytes: generation.promptSnapshot.length,
    techniqueName: generation.candidate.technique.name,
    skillCount: generation.candidate.skills.length,
    layerCount: generation.candidate.layers.length,
  };
};

const buildTechniqueModelDebugBalanceReviewSummary = (
  reviewResponse: TechniqueBalanceReviewResponse,
): TechniqueModelDebugBalanceReviewSummary => {
  return {
    enabled: true,
    modelName: reviewResponse.modelName,
    adjusted: reviewResponse.review.needsAdjustment,
    reason: reviewResponse.review.reason,
    riskTags: [...reviewResponse.review.riskTags],
    adjustmentGuidance: [...reviewResponse.review.adjustmentGuidance],
  };
};

const buildTechniqueModelDebugSkippedBalanceReviewSummary = (): TechniqueModelDebugBalanceReviewSummary => {
  return {
    enabled: false,
    modelName: '未启用',
    adjusted: false,
    reason: '未启用复评',
    riskTags: [],
    adjustmentGuidance: [],
  };
};

const buildTechniqueModelDebugReviewTrace = (params: {
  reviewResponse: TechniqueBalanceReviewResponse;
  elapsedMs: number;
}): TechniqueModelDebugReviewTrace => {
  return {
    enabled: true,
    modelName: params.reviewResponse.modelName,
    elapsedMs: params.elapsedMs,
    promptSnapshotBytes: params.reviewResponse.promptSnapshot.length,
    adjusted: params.reviewResponse.review.needsAdjustment,
    reason: params.reviewResponse.review.reason,
    riskTags: [...params.reviewResponse.review.riskTags],
    adjustmentGuidance: [...params.reviewResponse.review.adjustmentGuidance],
  };
};

const buildTechniqueModelDebugSkippedReviewTrace = (): TechniqueModelDebugReviewTrace => {
  return {
    enabled: false,
    modelName: '未启用',
    elapsedMs: 0,
    promptSnapshotBytes: 0,
    adjusted: false,
    reason: '未启用复评',
    riskTags: [],
    adjustmentGuidance: [],
  };
};

export const generateTechniqueModelDebugResult = async (
  params: TechniqueModelDebugGenerateParams,
): Promise<TechniqueModelDebugGenerateResult> => {
  const startedAt = Date.now();
  const resolvedTechniqueModelConfig = readTextModelConfig('technique');
  if (!resolvedTechniqueModelConfig) {
    throw new Error('缺少功法文本模型配置，请检查 AI_TECHNIQUE_MODEL_PROVIDER/URL/KEY/NAME');
  }
  const resolvedReviewModelConfig = params.enableReview
    ? readTextModelConfig('partner')
    : null;
  if (params.enableReview && !resolvedReviewModelConfig) {
    throw new Error('缺少功法平衡复评模型配置，请检查 AI_PARTNER_MODEL_PROVIDER/URL/KEY/NAME');
  }

  const originalTechniqueModelName = process.env.AI_TECHNIQUE_MODEL_NAME;
  const originalReviewModelName = process.env.AI_PARTNER_MODEL_NAME;
  process.env.AI_TECHNIQUE_MODEL_NAME = resolvedTechniqueModelConfig.modelName;
  if (params.enableReview && resolvedReviewModelConfig) {
    process.env.AI_PARTNER_MODEL_NAME = params.reviewModelName?.trim() || resolvedReviewModelConfig.modelName;
  }

  try {
    const debugPromptContext = buildTechniqueModelDebugPromptContext(params.baseModel);
    const initialGeneration = await generateTechniqueCandidateForDebug({
      quality: params.quality,
      techniqueType: params.techniqueType,
      seed: params.seed,
      basePromptContext: debugPromptContext,
    });
    const reviewStartedAt = params.enableReview ? Date.now() : 0;
    const reviewResponse = params.enableReview
      ? await reviewTechniqueBalanceCandidate({
          candidate: initialGeneration.candidate,
          quality: params.quality,
          techniqueType: params.techniqueType,
          maxLayer: QUALITY_MAX_LAYER[params.quality],
          baseModel: debugPromptContext?.techniqueBaseModel ?? null,
        })
      : null;
    const reviewElapsedMs = params.enableReview
      ? Date.now() - reviewStartedAt
      : 0;

    const finalGeneration = reviewResponse?.review.needsAdjustment
      ? await generateTechniqueCandidateForDebug({
          quality: params.quality,
          techniqueType: params.techniqueType,
          seed: initialGeneration.seed,
          basePromptContext: debugPromptContext,
          review: reviewResponse.review,
        })
      : initialGeneration;

    const skillIconStartedAt = Date.now();
    const skillIconResult = params.includeSkillIcons
      ? await attachGeneratedSkillIcons(finalGeneration.candidate)
      : {
          candidate: finalGeneration.candidate,
          attachedCount: 0,
        };
    const skillIconElapsedMs = Date.now() - skillIconStartedAt;
    const candidate = skillIconResult.candidate;

    return {
      modelName: finalGeneration.modelName,
      promptSnapshot: finalGeneration.promptSnapshot,
      seed: finalGeneration.seed,
      quality: params.quality,
      requestedTechniqueType: params.techniqueType,
      baseModel: debugPromptContext?.techniqueBaseModel ?? null,
      candidate,
      summary: buildTechniqueModelDebugSummary(candidate),
      balanceReview: reviewResponse
        ? buildTechniqueModelDebugBalanceReviewSummary(reviewResponse)
        : buildTechniqueModelDebugSkippedBalanceReviewSummary(),
      trace: {
        initialGeneration: buildTechniqueModelDebugGenerationTrace(initialGeneration),
        balanceReview: reviewResponse
          ? buildTechniqueModelDebugReviewTrace({
              reviewResponse,
              elapsedMs: reviewElapsedMs,
            })
          : buildTechniqueModelDebugSkippedReviewTrace(),
        finalGeneration: buildTechniqueModelDebugGenerationTrace(finalGeneration),
        skillIcons: {
          enabled: params.includeSkillIcons,
          elapsedMs: skillIconElapsedMs,
          attachedCount: skillIconResult.attachedCount,
        },
        totalElapsedMs: Date.now() - startedAt,
      },
    };
  } finally {
    if (originalTechniqueModelName === undefined) {
      delete process.env.AI_TECHNIQUE_MODEL_NAME;
    } else {
      process.env.AI_TECHNIQUE_MODEL_NAME = originalTechniqueModelName;
    }

    if (originalReviewModelName === undefined) {
      delete process.env.AI_PARTNER_MODEL_NAME;
    } else {
      process.env.AI_PARTNER_MODEL_NAME = originalReviewModelName;
    }
  }
};
