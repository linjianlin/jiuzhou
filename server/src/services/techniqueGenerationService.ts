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
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { addItemToInventory } from './inventory/index.js';
import { consumeMaterialByDefId } from './inventory/shared/consume.js';
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
} from './shared/techniqueResearchCooldown.js';
import {
  buildTechniqueResearchUnlockState,
  type TechniqueResearchUnlockState,
} from './shared/techniqueResearchUnlock.js';
import { persistGeneratedTechniqueCandidateTx } from './shared/generatedTechniquePersistence.js';
import { getGeneratedTechniqueDefinitionById } from './generatedTechniqueConfigStore.js';

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
  unlockRealm: string;
  unlocked: boolean;
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

const resolveTechniqueTypeByRandom = (): GeneratedTechniqueType => {
  const index = Math.floor(Math.random() * GENERATED_TECHNIQUE_TYPE_LIST.length);
  return GENERATED_TECHNIQUE_TYPE_LIST[index]!;
};

const buildGenerationId = (): string => {
  return `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
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
}): Promise<{ candidate: TechniqueGenerationCandidate; modelName: string; attemptCount: number; promptSnapshot: string }> => {
  const { generationId, characterId, techniqueType, quality } = args;
  return generateTechniqueCandidateWithRetryCore({
    generationId,
    characterId,
    techniqueType,
    quality,
    maxLayer: QUALITY_MAX_LAYER[quality],
  });
};

const remapGeneratedSkillIds = (
  candidate: TechniqueGenerationCandidate,
): TechniqueGenerationCandidate => {
  return remapTechniqueCandidateSkillIds(candidate);
};

class TechniqueGenerationService {
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
    lockRow: boolean,
  ): Promise<ServiceResult<TechniqueResearchUnlockState>> {
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
    const charRes = await query(queryText, [characterId]);
    if (charRes.rows.length === 0) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    const row = charRes.rows[0] as { realm?: string | null; sub_realm?: string | null };
    return {
      success: true,
      message: '获取研修解锁态成功',
      data: buildTechniqueResearchUnlockState(
        typeof row.realm === 'string' ? row.realm.trim() : '',
        typeof row.sub_realm === 'string' && row.sub_realm.trim() ? row.sub_realm.trim() : null,
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

    const [unlockRes, fragmentBalance, draftRes, currentJobRes] = await Promise.all([
      this.getTechniqueResearchUnlockStateTx(characterId, false),
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
    if (!unlockRes.success) {
      return { success: false, message: unlockRes.message, code: unlockRes.code };
    }
    if (!unlockRes.data) {
      return { success: false, message: '获取研修解锁态失败', code: 'RESEARCH_UNLOCK_STATE_INVALID' };
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
        unlockRealm: unlockRes.data.unlockRealm,
        unlocked: unlockRes.data.unlocked,
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
  private async createGenerationJobTx(characterId: number): Promise<ServiceResult<{
    generationId: string;
    techniqueType: GeneratedTechniqueType;
    quality: TechniqueQuality;
    costPoints: number;
    weekKey: string;
  }>> {
    await this.refundExpiredDraftJobsTx(characterId);

    const unlockRes = await this.getTechniqueResearchUnlockStateTx(characterId, true);
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

    const techniqueType = resolveTechniqueTypeByRandom();
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
          type_rolled,
          quality_rolled,
          cost_points,
          draft_expire_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, 'pending', $4, $5, $6,
          NULL,
          NOW(), NOW()
        )
      `,
      [generationId, characterId, weekKey, techniqueType, quality, costPoints],
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
      const generated = await generateCandidateWithRetry({
        generationId,
        characterId,
        techniqueType,
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
        techniqueType,
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
    techniqueType: GeneratedTechniqueType;
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
