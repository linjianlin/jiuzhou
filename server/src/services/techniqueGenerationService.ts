/**
 * AI 生成功法服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供 AI 生成功法草稿、自定义命名发布、主动放弃与状态查询。
 * 2) 不做什么：不负责 HTTP 参数解析与鉴权（由路由层处理），不负责前端交互流程。
 *
 * 输入/输出：
 * - 输入：characterId、generationId、customName。
 * - 输出：统一 ServiceResult（success/message/data/code）。
 *
 * 数据流/状态流：
 * 1) 生成：校验周限与功法残页余额 -> 扣除残页建任务(pending) -> AI 生成 -> 落草稿(generated_draft) 或失败退款。
 * 2) 放弃：校验草稿仍处于 generated_draft -> 复用“草稿过期”退款规则 -> 置为 refunded，继续保留冷却。
 * 3) 发布：校验草稿状态与命名规则 -> 全服唯一检查 -> 发布功法 -> 发放可交易功法书(published)。
 *
 * 关键边界条件与坑点：
 * 1) 草稿默认 24h 过期，过期后自动退款并置为 refunded。
 * 2) 洞府研修采用统一冷却时间配置，状态接口与创建任务前校验必须复用同一模块，避免前后端展示与服务端拦截不一致。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import type { SkillTriggerType } from '../shared/skillTriggerType.js';
import { addItemToInventory } from './inventory/index.js';
import { consumeMaterialByDefId } from './inventory/shared/consume.js';
import { mailService } from './mailService.js';
import { getItemDefinitionById, getTechniqueDefinitions, refreshGeneratedTechniqueSnapshots } from './staticConfigLoader.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { buildTechniqueResearchJobState } from './shared/techniqueResearchJobShared.js';
import { normalizeTechniqueName, validateTechniqueCustomName, getTechniqueNameRulesView } from './shared/techniqueNameRules.js';
import { isCharacterVisibleTechniqueDefinition } from './shared/techniqueUsageScope.js';
import { getCharacterNicknameById } from './shared/characterNickname.js';
import { broadcastWorldSystemMessage } from './shared/worldChatBroadcast.js';
import { generateTechniqueCandidateWithIcons } from './shared/techniqueGenerationExecution.js';
import {
  GENERATED_TECHNIQUE_TYPE_LIST,
  type GeneratedTechniqueType,
} from './shared/techniqueGenerationConstraints.js';
import type { TechniqueSkillUpgradeEntry } from './shared/techniqueSkillGenerationSpec.js';
import {
  TechniqueGenerationExhaustedError,
  generateTechniqueCandidateWithRetry as generateTechniqueCandidateWithRetryCore,
  remapTechniqueCandidateSkillIds,
  validateTechniqueGenerationCandidate,
  type TechniqueGenerationAttemptFailureStage,
} from './shared/techniqueGenerationCandidateCore.js';
import {
  buildTechniqueResearchCooldownState,
  formatTechniqueResearchCooldownRemaining,
  TECHNIQUE_RESEARCH_COOLDOWN_APPLY_JOB_STATUSES,
} from './shared/techniqueResearchCooldown.js';
import {
  resolveTechniqueResearchHeavenGuaranteeState,
  resolveTechniqueResearchQualityForGeneratedDraftSuccess,
  resolveTechniqueResearchQualityRateEntries,
  type TechniqueResearchQuality,
  type TechniqueResearchQualityRateEntry,
} from './shared/techniqueResearchGuarantee.js';
import {
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN,
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID,
  shouldTechniqueResearchBypassCooldownWithToken,
  shouldTechniqueResearchUseCooldownBypassToken,
} from './shared/techniqueResearchCooldownBypass.js';
import { getActiveMonthCardCooldownReductionRate } from './shared/monthCardBenefits.js';
import {
  buildTechniqueResearchUnlockState,
  type TechniqueResearchUnlockState,
} from './shared/techniqueResearchUnlock.js';
import { lockTechniqueResearchCreationMutex } from './shared/characterOperationMutex.js';
import { loadCharacterRealmSnapshot } from './shared/characterRealm.js';
import {
  hasGrantedRewardPayload,
} from './shared/rewardPayload.js';
import {
  resolveTechniqueResearchRefundFragments,
  buildTechniqueResearchRefundRewardPayload,
  TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE,
  TECHNIQUE_RESEARCH_FULL_REFUND_RATE,
} from './shared/techniqueResearchRefund.js';
import {
  resolveTechniqueResearchFragmentCost,
  TECHNIQUE_RESEARCH_BASE_FRAGMENT_COST,
  TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
  TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID,
} from './shared/techniqueResearchCost.js';
import { persistGeneratedTechniqueCandidateTx } from './shared/generatedTechniquePersistence.js';
import { getGeneratedTechniqueDefinitionById } from './generatedTechniqueConfigStore.js';
import {
  TECHNIQUE_BURNING_WORD_PROMPT_MAX_LENGTH,
  buildTechniqueBurningWordPromptContext,
  guardTechniqueBurningWordPrompt,
} from './shared/techniqueBurningWordPrompt.js';
import {
  TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT,
  buildTechniqueRecentSuccessfulDescriptionPromptContext,
  type TechniqueRecentSuccessfulDescriptionPromptContext,
} from './shared/techniqueRecentSuccessfulDescriptionPrompt.js';
import { buildTechniqueResearchCreativeDirectionPromptContext } from './shared/techniqueResearchCreativeDirectionPrompt.js';

export type TechniqueGenerationStatus =
  | 'pending'
  | 'generated_draft'
  | 'published'
  | 'failed'
  | 'refunded';

export type TechniqueQuality = TechniqueResearchQuality;

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
    triggerType: SkillTriggerType;
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

const TECHNIQUE_RESEARCH_FAILURE_RESULT_STATUSES = ['failed', 'refunded'] as const;

export type TechniqueResearchJobView = {
  generationId: string;
  status: TechniqueGenerationStatus;
  quality: TechniqueQuality;
  modelName: string | null;
  burningWordPrompt: string | null;
  draftTechniqueId: string | null;
  startedAt: string;
  finishedAt: string | null;
  draftExpireAt: string | null;
  preview: TechniquePreview | null;
  errorMessage: string | null;
};

type TechniqueResearchStatusData = {
  unlockRealm: string;
  unlocked: boolean;
  fragmentBalance: number;
  fragmentCost: number;
  cooldownBypassFragmentCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  cooldownBypassTokenBypassesCooldown: boolean;
  cooldownBypassTokenCost: number;
  cooldownBypassTokenItemName: string;
  cooldownBypassTokenAvailableQty: number;
  burningWordPromptMaxLength: number;
  currentDraft: GeneratedDraftRow | null;
  draftExpireAt: string | null;
  nameRules: ReturnType<typeof getTechniqueNameRulesView>;
  currentJob: TechniqueResearchJobView | null;
  hasUnreadResult: boolean;
  resultStatus: TechniqueResearchResultStatus | null;
  remainingUntilGuaranteedHeaven: number;
  qualityRates: TechniqueResearchQualityRateEntry[];
};

class TechniqueGenerationRollbackError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TechniqueGenerationRollbackError';
    this.code = code;
  }
}

const isTechniqueGenerationRollbackError = (
  error: unknown,
): error is TechniqueGenerationRollbackError => {
  return error instanceof TechniqueGenerationRollbackError;
};

const DRAFT_EXPIRE_HOURS = 24;
const GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID = 'book-generated-technique';
const DEFAULT_GENERATED_SKILL_ICON = '/assets/skills/icon_skill_44.png';
const TECHNIQUE_RESEARCH_REFUND_MAIL_TITLE = '洞府研修退款通知';
const TECHNIQUE_RESEARCH_REFUND_HINT = '对应返还已通过邮件发放，请前往邮箱领取。';
const TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE = '草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟';

const buildTechniqueResearchRefundMailContent = (
  reason: string,
  refundCooldownBypassToken: boolean,
): string => {
  const lines = [
    '本次洞府研修未能成法，系统已将本次返还通过邮件发放。',
  ];
  if (refundCooldownBypassToken) {
    lines.push('本次额外消耗的顿悟符也已一并返还。');
  }
  const normalizedReason = reason.trim();
  if (normalizedReason) {
    lines.push(`结算原因：${normalizedReason}`);
  }
  return lines.join('\n');
};

export const appendTechniqueResearchRefundHint = (reason: string): string => {
  const normalizedReason = reason.trim();
  if (!normalizedReason) return TECHNIQUE_RESEARCH_REFUND_HINT;
  if (normalizedReason.includes(TECHNIQUE_RESEARCH_REFUND_HINT)) return normalizedReason;
  return `${normalizedReason} ${TECHNIQUE_RESEARCH_REFUND_HINT}`;
};

const QUALITY_MAX_LAYER: Record<TechniqueQuality, number> = {
  黄: 3,
  玄: 5,
  地: 7,
  天: 9,
};

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

const resolveTechniqueTypeByRandom = (): GeneratedTechniqueType => {
  const index = Math.floor(Math.random() * GENERATED_TECHNIQUE_TYPE_LIST.length);
  return GENERATED_TECHNIQUE_TYPE_LIST[index]!;
};

const buildGenerationId = (): string => {
  return `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const getTechniqueResearchCooldownBypassTokenName = (): string => {
  const itemDef = getItemDefinitionById(TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID);
  const itemName = asString(itemDef?.name);
  if (!itemName) {
    throw new Error(
      `洞府研修冷却绕过道具未配置：${TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID}`,
    );
  }
  return itemName;
};

const buildGeneratedTechniqueId = (): string => {
  return `tech-gen-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
};

const isUndefinedTableError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '42P01';
};

const isUniqueViolation = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && (error as { code?: unknown }).code === '23505';
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

const validateCandidate = (
  candidate: TechniqueGenerationCandidate,
  expectedTechniqueType: GeneratedTechniqueType,
  expectedQuality: TechniqueQuality,
): ServiceResult<null> => {
  const validate = validateTechniqueGenerationCandidate({
    candidate,
    expectedTechniqueType,
    expectedQuality,
    expectedMaxLayer: QUALITY_MAX_LAYER[expectedQuality],
  });
  return validate.success
    ? { success: true, message: 'ok', data: null }
    : { success: false, message: validate.message, code: validate.code };
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

const generateCandidateWithRetry = async (args: {
  generationId: string;
  characterId: number;
  techniqueType: GeneratedTechniqueType;
  quality: TechniqueQuality;
  promptContext?: Record<string, unknown>;
}): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; attemptCount: number; promptSnapshot: string }> => {
  const { generationId, characterId, techniqueType, quality, promptContext } = args;
  return generateTechniqueCandidateWithRetryCore({
    generationId,
    characterId,
    techniqueType,
    quality,
    maxLayer: QUALITY_MAX_LAYER[quality],
    promptContext,
  });
};

const buildTechniqueResearchPromptContext = (params: {
  burningWordPrompt: string | null;
  recentSuccessfulDescriptionPromptContext?: TechniqueRecentSuccessfulDescriptionPromptContext;
}) => {
  const researchCreativeDirectionPromptContext = buildTechniqueResearchCreativeDirectionPromptContext();
  const burningWordPromptContext = buildTechniqueBurningWordPromptContext(params.burningWordPrompt);

  return {
    ...researchCreativeDirectionPromptContext,
    ...(burningWordPromptContext ?? {}),
    ...(params.recentSuccessfulDescriptionPromptContext ?? {}),
  };
};

const remapGeneratedSkillIds = (
  candidate: TechniqueGenerationCandidate,
): TechniqueGenerationCandidate => {
  return remapTechniqueCandidateSkillIds(candidate);
};

class TechniqueGenerationService {
  private async loadRecentSuccessfulTechniqueDescriptionPromptContext(
    characterId: number,
  ): Promise<TechniqueRecentSuccessfulDescriptionPromptContext | undefined> {
    const recentRes = await query<{
      technique_name: string;
      quality: TechniqueQuality;
      type: string;
      description: string;
      long_desc: string;
    }>(
      `
        SELECT
          d.name AS technique_name,
          d.quality,
          d.type,
          COALESCE(d.description, '') AS description,
          COALESCE(d.long_desc, '') AS long_desc
        FROM technique_generation_job j
        JOIN generated_technique_def d ON d.generation_id = j.id
        WHERE j.character_id = $1
          AND (COALESCE(d.description, '') <> '' OR COALESCE(d.long_desc, '') <> '')
        ORDER BY COALESCE(j.finished_at, j.created_at) DESC, j.id DESC
        LIMIT $2
      `,
      [characterId, TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT],
    );

    return buildTechniqueRecentSuccessfulDescriptionPromptContext(
      recentRes.rows.map((row) => ({
        name: asString(row.technique_name),
        quality: row.quality,
        type: asString(row.type),
        description: asString(row.description),
        longDesc: asString(row.long_desc),
      })),
    );
  }

  private async broadcastHeavenTechniquePublish(
    characterId: number,
    techniqueId: string,
    techniqueName: string,
  ): Promise<void> {
    const generatedTechnique = getGeneratedTechniqueDefinitionById(techniqueId);
    if (!generatedTechnique || generatedTechnique.quality !== '天') {
      return;
    }

    const nickname = await getCharacterNicknameById(characterId);
    if (!nickname) {
      return;
    }

    broadcastWorldSystemMessage({
      senderTitle: '天机传音',
      content: `【洞府研修】${nickname}抄写出天阶功法《${techniqueName}》，道韵惊世，声传九州！`,
    });
  }

  private async getTechniqueResearchUnlockStateTx(
    characterId: number,
  ): Promise<ServiceResult<TechniqueResearchUnlockState>> {
    const realmSnapshot = await loadCharacterRealmSnapshot(characterId);
    if (!realmSnapshot) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    return {
      success: true,
      message: '获取研修解锁态成功',
      data: buildTechniqueResearchUnlockState(
        realmSnapshot.realm,
        realmSnapshot.subRealm,
      ),
    };
  }

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

  private async loadTechniqueResearchGeneratedNonHeavenCount(
    characterId: number,
    forUpdate: boolean,
  ): Promise<number | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT technique_research_generated_non_heaven_count
        FROM characters
        WHERE id = $1
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    return Math.max(0, Math.floor(asNumber(
      (result.rows[0] as Record<string, unknown>).technique_research_generated_non_heaven_count,
      0,
    )));
  }

  private async loadCooldownBypassTokenAvailableQty(characterId: number, forUpdate: boolean): Promise<number> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const tokenRes = await query(
      `
        SELECT qty
        FROM item_instance
        WHERE owner_character_id = $1
          AND item_def_id = $2
          AND location IN ('bag', 'warehouse')
          AND locked = false
        ${lockSql}
      `,
      [characterId, TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID],
    );
    return tokenRes.rows.reduce((totalQty, row) => {
      const currentQty = Number((row as Record<string, unknown>).qty ?? 0);
      if (!Number.isFinite(currentQty) || currentQty <= 0) {
        return totalQty;
      }
      return totalQty + Math.floor(currentQty);
    }, 0);
  }

  private async loadLatestResearchCooldownStartedAt(
    characterId: number,
    forUpdate: boolean,
  ): Promise<string | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const latestRes = await query(
      `
        SELECT created_at
        FROM technique_generation_job
        WHERE character_id = $1
          AND status = ANY($2::text[])
          AND used_cooldown_bypass_token = false
        ORDER BY created_at DESC
        LIMIT 1
        ${lockSql}
      `,
      [characterId, [...TECHNIQUE_RESEARCH_COOLDOWN_APPLY_JOB_STATUSES]],
    );
    const row = latestRes.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return toIsoString(row.created_at);
  }

  private async loadCharacterUserId(characterId: number): Promise<number | null> {
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
    return userId > 0 ? userId : null;
  }

  private async refundRewardsByMailTx(
    characterId: number,
    generationId: string,
    refundFragments: number,
    refundCooldownBypassToken: boolean,
    reason: string,
  ): Promise<void> {
    const safeRefundFragments = Math.max(0, Math.floor(asNumber(refundFragments, 0)));
    const refundRewards = buildTechniqueResearchRefundRewardPayload({
      refundFragments: safeRefundFragments,
      refundCooldownBypassToken,
    });
    if (!hasGrantedRewardPayload(refundRewards)) return;

    const userId = await this.loadCharacterUserId(characterId);
    if (!userId) {
      throw new Error('退款邮件发送失败：角色不存在');
    }

    const refundMailResult = await mailService.sendMail({
      recipientUserId: userId,
      recipientCharacterId: characterId,
      senderType: 'system',
      senderName: '系统',
      mailType: 'reward',
      title: TECHNIQUE_RESEARCH_REFUND_MAIL_TITLE,
      content: buildTechniqueResearchRefundMailContent(reason, refundCooldownBypassToken),
      attachRewards: refundRewards,
      expireDays: 30,
      source: 'technique_research_refund',
      sourceRefId: generationId,
      metadata: {
        generationId,
        refundFragments: safeRefundFragments,
        refundCooldownBypassToken,
        reason,
      },
    });
    if (!refundMailResult.success) {
      throw new Error(refundMailResult.message || '退款邮件发送失败');
    }
  }

  private async applyGenerationRefundByMailTx(
    characterId: number,
    refundEntries: Array<{
      generationId: string;
      refundFragments: number;
      refundCooldownBypassToken: boolean;
      reason: string;
    }>,
  ): Promise<void> {
    const refundableEntries = refundEntries.filter((entry) => {
      return entry.generationId && (entry.refundFragments > 0 || entry.refundCooldownBypassToken);
    });
    for (const entry of refundableEntries) {
      await this.refundRewardsByMailTx(
        characterId,
        entry.generationId,
        entry.refundFragments,
        entry.refundCooldownBypassToken,
        entry.reason,
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

    await this.applyGenerationRefundByMailTx(
      characterId,
      (expiredRes.rows as Array<Record<string, unknown>>).map((row) => ({
        generationId: asString(row.id),
        refundFragments: resolveTechniqueResearchRefundFragments(
          asNumber(row.cost_points, 0),
          TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE,
        ),
        refundCooldownBypassToken: false,
        reason: TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE,
      })),
    );

    await query(
      `
        UPDATE technique_generation_job
        SET status = 'refunded',
            error_code = 'GENERATION_EXPIRED',
            error_message = $2,
            finished_at = COALESCE(finished_at, NOW()),
            failed_viewed_at = NULL,
            updated_at = NOW()
        WHERE character_id = $1
          AND status = 'generated_draft'
          AND draft_expire_at IS NOT NULL
          AND draft_expire_at <= NOW()
      `,
      [characterId, TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE],
    );
  }

  async getResearchStatus(characterId: number): Promise<ServiceResult<TechniqueResearchStatusData>> {
    await this.refundExpiredDraftJobsTx(characterId);

    const [
      unlockRes,
      fragmentBalance,
      draftRes,
      currentJobRes,
      cooldownBypassTokenAvailableQty,
      cooldownStartedAt,
      generatedNonHeavenCount,
    ] = await Promise.all([
      this.getTechniqueResearchUnlockStateTx(characterId),
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
            j.model_name,
            j.burning_word_prompt,
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
      this.loadCooldownBypassTokenAvailableQty(characterId, false),
      this.loadLatestResearchCooldownStartedAt(characterId, false),
      this.loadTechniqueResearchGeneratedNonHeavenCount(characterId, false),
    ]);
    if (!unlockRes.success) {
      return { success: false, message: unlockRes.message, code: unlockRes.code };
    }
    if (!unlockRes.data) {
      return { success: false, message: '获取研修解锁态失败', code: 'RESEARCH_UNLOCK_STATE_INVALID' };
    }
    if (generatedNonHeavenCount === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

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
            modelName: asString(currentJobRow.model_name) || null,
            burningWordPrompt: asString(currentJobRow.burning_word_prompt) || null,
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
    const cooldownBypassTokenItemName = getTechniqueResearchCooldownBypassTokenName();
    const cooldownReductionRate = await getActiveMonthCardCooldownReductionRate(characterId);
    const cooldownState = buildTechniqueResearchCooldownState(cooldownStartedAt, new Date(), {
      cooldownReductionRate,
    });
    const guaranteeState = resolveTechniqueResearchHeavenGuaranteeState(generatedNonHeavenCount);
    const qualityRates = resolveTechniqueResearchQualityRateEntries(generatedNonHeavenCount);

    return {
      success: true,
      message: '获取成功',
      data: {
        unlockRealm: unlockRes.data.unlockRealm,
        unlocked: unlockRes.data.unlocked,
        fragmentBalance,
        fragmentCost: TECHNIQUE_RESEARCH_BASE_FRAGMENT_COST,
        cooldownBypassFragmentCost: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
        cooldownHours: cooldownState.cooldownHours,
        cooldownUntil: cooldownState.cooldownUntil,
        cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
        cooldownBypassTokenBypassesCooldown: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN,
        cooldownBypassTokenCost: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
        cooldownBypassTokenItemName,
        cooldownBypassTokenAvailableQty,
        burningWordPromptMaxLength: TECHNIQUE_BURNING_WORD_PROMPT_MAX_LENGTH,
        currentDraft,
        draftExpireAt: currentDraft?.draftExpireAt ?? null,
        nameRules: getTechniqueNameRulesView(),
        currentJob: currentJobState.currentJob,
        hasUnreadResult: currentJobState.hasUnreadResult,
        resultStatus: currentJobState.resultStatus,
        remainingUntilGuaranteedHeaven: guaranteeState.remainingUntilGuaranteedHeaven,
        qualityRates,
      },
    };
  }

  @Transactional
  private async createGenerationJobTx(
    characterId: number,
    cooldownBypassEnabled: boolean,
    burningWordPrompt: string | null | undefined,
  ): Promise<ServiceResult<{
    generationId: string;
    techniqueType: GeneratedTechniqueType;
    quality: TechniqueQuality;
    costPoints: number;
    weekKey: string;
  }>> {
    await lockTechniqueResearchCreationMutex(characterId);
    await this.refundExpiredDraftJobsTx(characterId);
    const burningWordPromptValidation = await guardTechniqueBurningWordPrompt(burningWordPrompt);
    if (!burningWordPromptValidation.success) {
      return {
        success: false,
        message: burningWordPromptValidation.message,
        code: burningWordPromptValidation.code,
      };
    }

    const unlockRes = await this.getTechniqueResearchUnlockStateTx(characterId);
    if (!unlockRes.success) {
      return { success: false, message: unlockRes.message, code: unlockRes.code };
    }
    if (!unlockRes.data) {
      return { success: false, message: '获取研修解锁态失败', code: 'RESEARCH_UNLOCK_STATE_INVALID' };
    }
    if (!unlockRes.data.unlocked) {
      return {
        success: false,
        message: `需达到${unlockRes.data.unlockRealm}方可开启洞府研修`,
        code: 'RESEARCH_REALM_LOCKED',
      };
    }

    const latestJobRes = await query(
      `
        SELECT created_at, status
        FROM technique_generation_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [characterId],
    );
    const latestJobRow = latestJobRes.rows[0] as Record<string, unknown> | undefined;
    const latestJobStatus = asString(latestJobRow?.status) || null;
    if (latestJobStatus === 'pending') {
      return {
        success: false,
        message: '当前已有洞府推演进行中',
        code: 'RESEARCH_JOB_ACTIVE',
      };
    }
    if (latestJobStatus === 'generated_draft') {
      return {
        success: false,
        message: '当前已有待抄写的研修草稿',
        code: 'RESEARCH_DRAFT_ACTIVE',
      };
    }
    const cooldownReductionRate = await getActiveMonthCardCooldownReductionRate(characterId);
    const shouldUseCooldownBypassToken = shouldTechniqueResearchUseCooldownBypassToken(cooldownBypassEnabled);
    const shouldBypassCooldown = shouldTechniqueResearchBypassCooldownWithToken(cooldownBypassEnabled);
    const latestStartedAt = shouldBypassCooldown
      ? null
      : await this.loadLatestResearchCooldownStartedAt(characterId, false);
    const cooldownState = buildTechniqueResearchCooldownState(latestStartedAt, new Date(), {
      cooldownReductionRate,
    });
    if (cooldownState.isCoolingDown) {
      return {
        success: false,
        message: `洞府研修冷却中，还需等待${formatTechniqueResearchCooldownRemaining(cooldownState.cooldownRemainingSeconds)}`,
        code: 'RESEARCH_COOLDOWN_ACTIVE',
      };
    }

    if (shouldUseCooldownBypassToken) {
      const cooldownBypassTokenAvailableQty = await this.loadCooldownBypassTokenAvailableQty(characterId, true);
      if (cooldownBypassTokenAvailableQty < TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST) {
        const tokenItemName = getTechniqueResearchCooldownBypassTokenName();
        return {
          success: false,
          message: `${tokenItemName}不足，启用冷却豁免需消耗${TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST}枚`,
          code: 'RESEARCH_COOLDOWN_BYPASS_TOKEN_NOT_ENOUGH',
        };
      }
    }
    const weekKey = resolveWeekKey(new Date());

    const techniqueType = resolveTechniqueTypeByRandom();
    const generatedNonHeavenCount = await this.loadTechniqueResearchGeneratedNonHeavenCount(characterId, false);
    if (generatedNonHeavenCount === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }
    const quality = resolveTechniqueResearchQualityForGeneratedDraftSuccess(generatedNonHeavenCount);
    const costPoints = resolveTechniqueResearchFragmentCost(shouldUseCooldownBypassToken);
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

    if (shouldUseCooldownBypassToken) {
      const consumeTokenRes = await consumeMaterialByDefId(
        characterId,
        TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID,
        TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
      );
      if (!consumeTokenRes.success) {
        return {
          success: false,
          message: consumeTokenRes.message,
          code: 'RESEARCH_COOLDOWN_BYPASS_TOKEN_CONSUME_FAILED',
        };
      }
    }

    const generationId = buildGenerationId();
    await query(
      `
        INSERT INTO technique_generation_job (
          id,
          character_id,
          week_key,
          status,
          type_rolled,
          quality_rolled,
          cost_points,
          used_cooldown_bypass_token,
          burning_word_prompt,
          draft_expire_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, 'pending', $4, $5, $6, $7, $8,
          NULL,
          NOW(), NOW()
        )
      `,
      [
        generationId,
        characterId,
        weekKey,
        techniqueType,
        quality,
        costPoints,
        shouldUseCooldownBypassToken,
        burningWordPromptValidation.value,
      ],
    );

    return {
      success: true,
      message: '创建任务成功',
      data: { generationId, techniqueType, quality, costPoints, weekKey },
    };
  }

  @Transactional
  private async saveGeneratedDraftTx(args: {
    characterId: number;
    generationId: string;
    techniqueType: GeneratedTechniqueType;
    quality: TechniqueQuality;
    modelName: string;
    promptSnapshot: string;
    attemptCount: number;
    candidate: TechniqueGenerationCandidate;
  }): Promise<ServiceResult<{ draftTechniqueId: string; preview: TechniquePreview }>> {
    const {
      characterId,
      generationId,
      techniqueType,
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

    const validate = validateCandidate(candidate, techniqueType, quality);
    if (!validate.success) {
      return { success: false, message: validate.message, code: validate.code };
    }

    // 强制由系统重建技能ID，避免模型返回ID污染全局主键空间。
    const normalizedCandidate = remapGeneratedSkillIds(candidate);
    const validateNormalized = validateCandidate(normalizedCandidate, techniqueType, quality);
    if (!validateNormalized.success) {
      return { success: false, message: validateNormalized.message, code: validateNormalized.code };
    }

    const draftTechniqueId = buildGeneratedTechniqueId();
    await persistGeneratedTechniqueCandidateTx({
      generationId,
      techniqueId: draftTechniqueId,
      createdByCharacterId: characterId,
      candidate: normalizedCandidate,
      usageScope: 'character_only',
      isPublished: false,
      publishedAt: null,
      nameLocked: false,
      techniqueIcon: DEFAULT_GENERATED_SKILL_ICON,
    });

    const counterUpdateResult = await query(
      `
        UPDATE characters
        SET technique_research_generated_non_heaven_count = CASE
              WHEN $2 = '天' THEN 0
              ELSE technique_research_generated_non_heaven_count + 1
            END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING technique_research_generated_non_heaven_count
      `,
      [characterId, quality],
    );
    if (counterUpdateResult.rows.length === 0) {
      throw new Error('角色不存在');
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
    refundRate: number = TECHNIQUE_RESEARCH_FULL_REFUND_RATE,
  ): Promise<void> {
    const jobRes = await query(
      `
        SELECT status, cost_points, used_cooldown_bypass_token
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
    const usedCooldownBypassToken = row.used_cooldown_bypass_token === true;
    if (status === 'refunded' || status === 'failed' || status === 'published') return;

    const refundErrorMessage = appendTechniqueResearchRefundHint(reason);
    await this.applyGenerationRefundByMailTx(characterId, [
      {
        generationId,
        refundFragments: resolveTechniqueResearchRefundFragments(costPoints, refundRate),
        refundCooldownBypassToken: status === 'pending' && usedCooldownBypassToken,
        reason: refundErrorMessage,
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
      [generationId, nextStatus, errorCode, refundErrorMessage],
    );
  }

  async processPendingGenerationJob(args: {
    characterId: number;
    generationId: string;
    techniqueType: GeneratedTechniqueType;
    quality: TechniqueQuality;
  }): Promise<ServiceResult<{
    generationId: string;
    status: TechniqueResearchResultStatus;
    preview: TechniquePreview | null;
    errorMessage: string | null;
  }>> {
    const { characterId, generationId, techniqueType, quality } = args;

    try {
      const [jobRes, recentSuccessfulDescriptionPromptContext] = await Promise.all([
        query<{ burning_word_prompt: string | null }>(
          `
            SELECT burning_word_prompt
            FROM technique_generation_job
            WHERE id = $1 AND character_id = $2
            LIMIT 1
          `,
          [generationId, characterId],
        ),
        this.loadRecentSuccessfulTechniqueDescriptionPromptContext(characterId),
      ]);
      const burningWordPrompt = asString(
        jobRes.rows[0]?.burning_word_prompt ?? '',
      ) || null;
      const generated = await generateCandidateWithRetry({
        generationId,
        characterId,
        techniqueType,
        quality,
        promptContext: buildTechniqueResearchPromptContext({
          burningWordPrompt,
          recentSuccessfulDescriptionPromptContext,
        }),
      });
      const executionResult = await generateTechniqueCandidateWithIcons({
        quality,
        candidate: generated.candidate,
        defaultSkillIcon: DEFAULT_GENERATED_SKILL_ICON,
      });
      const saveRes = await this.saveGeneratedDraftTx({
        characterId,
        generationId,
        techniqueType,
        quality,
        modelName: generated.modelName,
        promptSnapshot: generated.promptSnapshot,
        attemptCount: generated.attemptCount,
        candidate: executionResult.candidate,
      });

      if (!saveRes.success || !saveRes.data) {
        const reason = saveRes.message || '草稿落库失败，已自动退款';
        const errorMessage = appendTechniqueResearchRefundHint(reason);
        await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', saveRes.code || 'GENERATION_FAILED');
        return {
          success: true,
          message: errorMessage,
          data: {
            generationId,
            status: 'failed',
            preview: null,
            errorMessage,
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
      const errorMessage = appendTechniqueResearchRefundHint(reason);
      if (!(error instanceof TechniqueGenerationExhaustedError)) {
        logTechniqueGenerationTaskFailure({
          generationId,
          characterId,
          quality,
          attemptCount: 0,
          reason: errorMessage,
        });
      }
      await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', 'GENERATION_FAILED');
      return {
        success: true,
        message: errorMessage,
        data: {
          generationId,
          status: 'failed',
          preview: null,
          errorMessage,
        },
      };
    }
  }

  async generateTechniqueDraft(
    characterId: number,
    cooldownBypassEnabled: boolean,
    burningWordPrompt: string | null | undefined,
  ): Promise<ServiceResult<{
    generationId: string;
    techniqueType: GeneratedTechniqueType;
    quality: TechniqueQuality;
    status: 'pending';
  }>> {
    const createRes = await this.createGenerationJobTx(
      characterId,
      cooldownBypassEnabled,
      burningWordPrompt,
    );
    if (!createRes.success) {
      return { success: false, message: createRes.message, code: createRes.code };
    }
    if (!createRes.data) {
      return { success: false, message: '创建生成任务失败', code: 'GENERATION_FAILED' };
    }

    const { generationId, techniqueType, quality } = createRes.data;
    return {
      success: true,
      message: '已加入洞府推演队列',
      data: {
        generationId,
        techniqueType,
        quality,
        status: 'pending',
      },
    };
  }

  async failPendingGenerationJob(characterId: number, generationId: string, reason: string): Promise<void> {
    await this.refundGenerationJobTx(characterId, generationId, reason, 'failed', 'GENERATION_FAILED');
  }

  @Transactional
  async discardGeneratedTechniqueDraft(
    characterId: number,
    generationId: string,
  ): Promise<ServiceResult<{ generationId: string }>> {
    await this.refundExpiredDraftJobsTx(characterId);

    const jobRes = await query(
      `
        SELECT status, error_code
        FROM technique_generation_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length === 0) {
      return { success: false, message: '研修任务不存在', code: 'GENERATION_NOT_FOUND' };
    }

    const row = jobRes.rows[0] as Record<string, unknown>;
    const status = asString(row.status);
    const errorCode = asString(row.error_code);

    if (status !== 'generated_draft') {
      if (status === 'refunded' && errorCode === 'GENERATION_EXPIRED') {
        return { success: false, message: '草稿已过期，请重新领悟', code: 'GENERATION_EXPIRED' };
      }
      return { success: false, message: '当前草稿不可放弃', code: 'GENERATION_STATE_INVALID' };
    }

    await this.refundGenerationJobTx(
      characterId,
      generationId,
      TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE,
      'refunded',
      'GENERATION_EXPIRED',
      TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE,
    );

    return {
      success: true,
      message: '已放弃本次研修草稿，并按过期规则结算',
      data: { generationId },
    };
  }

  @Transactional
  async markLatestResultViewed(characterId: number): Promise<ServiceResult<{ marked: boolean }>> {
    const jobRes = await this.markLatestTechniqueResultViewedTx(characterId);
    if (jobRes.rows.length === 0) {
      return { success: true, message: '无未查看结果', data: { marked: false } };
    }

    return {
      success: true,
      message: '已标记查看',
      data: { marked: true },
    };
  }

  /**
   * 标记洞府研修最新结果已查看
   *
   * 作用（做什么 / 不做什么）：
   * 1) 做什么：把“查找最新未查看结果 + 按状态补 viewed 时间”收敛成单条原子更新。
   * 2) 不做什么：不负责对外返回业务文案，不负责校验角色是否解锁洞府研修。
   *
   * 输入/输出：
   * - 输入：characterId。
   * - 输出：数据库 UPDATE 返回结果；有返回行表示本次成功标记了最新未查看结果。
   *
   * 数据流/状态流：
   * 角色 ID -> CTE 选出最新未查看结果 -> 按状态一次性更新 viewed_at / failed_viewed_at -> 返回是否命中。
   *
   * 关键边界条件与坑点：
   * 1) `generated_draft` 与 `failed/refunded` 走的是两套查看时间字段，必须在同一条 SQL 里按状态分支更新，避免再拆成两段。
   * 2) 这里故意不先 `FOR UPDATE` 预读任务行，减少“只为标记已查看却长时间占着结果行锁”的等待链。
   */
  private async markLatestTechniqueResultViewedTx(characterId: number) {
    return query(
      `
        WITH latest_unviewed_job AS (
          SELECT id, status
          FROM technique_generation_job
          WHERE character_id = $1
            AND (
              (status = 'generated_draft' AND viewed_at IS NULL)
              OR (status = ANY($2::text[]) AND failed_viewed_at IS NULL)
            )
          ORDER BY created_at DESC
          LIMIT 1
        )
        UPDATE technique_generation_job AS job
        SET viewed_at = CASE
              WHEN latest_unviewed_job.status = 'generated_draft' THEN COALESCE(job.viewed_at, NOW())
              ELSE job.viewed_at
            END,
            failed_viewed_at = CASE
              WHEN latest_unviewed_job.status = ANY($2::text[]) THEN COALESCE(job.failed_viewed_at, NOW())
              ELSE job.failed_viewed_at
            END,
            updated_at = NOW()
        FROM latest_unviewed_job
        WHERE job.id = latest_unviewed_job.id
        RETURNING job.id
      `,
      [characterId, [...TECHNIQUE_RESEARCH_FAILURE_RESULT_STATUSES]],
    );
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
      await this.refundGenerationJobTx(
        characterId,
        generationId,
        TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE,
        'refunded',
        'GENERATION_EXPIRED',
        TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE,
      );
      return { success: false, message: '草稿已过期，请重新领悟', code: 'GENERATION_EXPIRED' };
    }

    const nameCheck = await validateTechniqueCustomName(customName);
    if (!nameCheck.success) {
      return { success: false, message: nameCheck.message, code: nameCheck.code };
    }

    const staticConflict = getTechniqueDefinitions().some((entry) => {
      if (!isCharacterVisibleTechniqueDefinition(entry)) return false;
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
      const result = await this.publishGeneratedTechniqueTx(args);
      if (result.success && result.data) {
        await this.broadcastHeavenTechniquePublish(
          args.characterId,
          result.data.techniqueId,
          result.data.finalName,
        );
      }
      return result;
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
          unlockRealm: buildTechniqueResearchUnlockState('凡人', null).unlockRealm,
          unlocked: false,
          fragmentBalance: 0,
          fragmentCost: TECHNIQUE_RESEARCH_BASE_FRAGMENT_COST,
          cooldownBypassFragmentCost: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_FRAGMENT_COST,
          cooldownHours: buildTechniqueResearchCooldownState(null).cooldownHours,
          cooldownUntil: null,
          cooldownRemainingSeconds: 0,
          cooldownBypassTokenBypassesCooldown: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_BYPASSES_COOLDOWN,
          cooldownBypassTokenCost: TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
          cooldownBypassTokenItemName: getTechniqueResearchCooldownBypassTokenName(),
          cooldownBypassTokenAvailableQty: 0,
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
