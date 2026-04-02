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
} from './staticConfigLoader.js';
import { consumeCharacterCurrencies, consumeMaterialByDefId } from './inventory/shared/consume.js';
import { mailService } from './mailService.js';
import { partnerService } from './partnerService.js';
import {
  buildPartnerRecruitJobState,
  type PartnerRecruitJobStatus,
  type PartnerRecruitPreviewDto,
} from './shared/partnerRecruitJobShared.js';
import {
  buildGeneratedPartnerDefId,
  buildGeneratedPartnerPreviewByPartnerDefId,
  buildGeneratedPartnerTextModelRequest,
  executeGeneratedPartnerVisualGeneration,
  persistGeneratedPartnerPreviewTx,
  tryCallGeneratedPartnerTextModel,
  type GeneratedPartnerTechniqueDraft,
} from './shared/partnerGeneratedPreview.js';
import {
  buildPartnerRecruitStatusDto,
  type PartnerRecruitJobDto,
  type PartnerRecruitStatusDto,
} from './shared/partnerRecruitStatus.js';
import {
  PARTNER_RECRUIT_FIRST_PREVIEW_GUARANTEE_CONSUMED_JOB_STATUSES,
  PARTNER_RECRUIT_FIRST_PREVIEW_MINIMUM_QUALITY,
  buildPartnerRecruitCooldownState,
  buildPartnerRecruitPreviewExpireAt,
  formatPartnerRecruitCooldownRemaining,
  isPartnerRecruitPreviewExpired,
  PARTNER_RECRUIT_COOLDOWN_APPLY_JOB_STATUSES,
  PARTNER_RECRUIT_SPIRIT_STONES_COST,
  resolvePartnerRecruitHeavenGuaranteeState,
  resolvePartnerRecruitQualityForGeneratedPreviewSuccess,
  resolvePartnerRecruitQualityRateEntries,
  type PartnerRecruitDraft,
  type PartnerRecruitQuality,
} from './shared/partnerRecruitRules.js';
import { getActiveMonthCardCooldownReductionRate } from './shared/monthCardBenefits.js';
import {
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
  PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
  shouldPartnerRecruitBypassCooldownWithCustomBaseModel,
  shouldPartnerRecruitUseCustomBaseModelToken,
  validatePartnerRecruitRequestedBaseModelSelection,
} from './shared/partnerRecruitBaseModel.js';
import {
  buildPartnerRecruitUnlockState,
  type PartnerRecruitUnlockState,
} from './shared/partnerRecruitUnlock.js';
import { lockPartnerRecruitCreationMutex } from './shared/characterOperationMutex.js';
import { loadCharacterRealmSnapshot } from './shared/characterRealm.js';
import { broadcastHeavenPartnerAcquired } from './shared/partnerWorldBroadcast.js';
import { reviewPartnerRecruitCustomBaseModel } from './shared/partnerRecruitBaseModelReview.js';

export type ServiceResult<T = undefined> = {
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

type PartnerRecruitGuaranteeProgress = {
  generatedNonHeavenCount: number;
  hasGeneratedPreviewHistory: boolean;
};

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

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asNumber = (raw: unknown, fallback = 0): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const asBoolean = (raw: unknown): boolean => {
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
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
const PARTNER_RECRUIT_REFUND_MAIL_TITLE = '伙伴招募失败退还通知';
const PARTNER_RECRUIT_REFUND_HINT = '本次消耗已通过邮件退回，请前往邮箱领取。';
const getPartnerRecruitCustomBaseModelTokenName = (): string => {
  const itemDef = getItemDefinitionById(PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID);
  const itemName = asString(itemDef?.name);
  if (!itemName) {
    throw new Error(`伙伴招募自定义底模消耗道具未配置：${PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID}`);
  }
  return itemName;
};

const buildPartnerRecruitRefundMailContent = (reason: string): string => {
  const lines = [
    '本次伙伴招募未能成形，系统已将本次消耗通过邮件退回。',
  ];
  const normalizedReason = reason.trim();
  if (normalizedReason) {
    lines.push(`失败原因：${normalizedReason}`);
  }
  return lines.join('\n');
};

export const appendPartnerRecruitRefundHint = (reason: string): string => {
  const normalizedReason = reason.trim();
  if (!normalizedReason) return PARTNER_RECRUIT_REFUND_HINT;
  if (normalizedReason.includes(PARTNER_RECRUIT_REFUND_HINT)) return normalizedReason;
  return `${normalizedReason} ${PARTNER_RECRUIT_REFUND_HINT}`;
};

export type GeneratedRecruitTechniqueDraft = GeneratedPartnerTechniqueDraft;
export const executePartnerRecruitVisualGeneration = executeGeneratedPartnerVisualGeneration;
export const buildPartnerRecruitTextModelRequest = buildGeneratedPartnerTextModelRequest;

class PartnerRecruitService {
  private async broadcastHeavenPartnerRecruit(
    characterId: number,
    partnerId: number,
    partnerDefId: string,
    partnerName: string,
  ): Promise<void> {
    await broadcastHeavenPartnerAcquired({
      characterId,
      partnerId,
      partnerDefId,
      partnerName,
      sourceLabel: '伙伴招募',
    });
  }

  private async getPartnerRecruitUnlockStateTx(
    characterId: number,
  ): Promise<ServiceResult<PartnerRecruitUnlockState>> {
    const realmSnapshot = await loadCharacterRealmSnapshot(characterId);
    if (!realmSnapshot) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    return {
      success: true,
      message: '获取伙伴招募开放态成功',
      data: buildPartnerRecruitUnlockState(
        realmSnapshot.realm,
        realmSnapshot.subRealm,
      ),
    };
  }

  private async assertPartnerRecruitUnlocked(
    characterId: number,
  ): Promise<ServiceResult<{ featureCode: string }>> {
    const featureUnlocked = await isFeatureUnlocked(characterId, PARTNER_SYSTEM_FEATURE_CODE);
    if (!featureUnlocked) {
      return { success: false, message: '伙伴系统尚未解锁', code: 'PARTNER_SYSTEM_LOCKED' };
    }

    const unlockState = await this.getPartnerRecruitUnlockStateTx(characterId);
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
          AND used_custom_base_model_token = false
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

  private async loadCharacterSpiritStones(characterId: number): Promise<number | null> {
    const result = await query(
      `
        SELECT spirit_stones
        FROM characters
        WHERE id = $1
        LIMIT 1
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    return Math.max(0, Math.floor(asNumber((result.rows[0] as Record<string, unknown>).spirit_stones, 0)));
  }

  private async loadPartnerRecruitGuaranteeProgress(
    characterId: number,
    forUpdate: boolean,
  ): Promise<PartnerRecruitGuaranteeProgress | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT
          c.partner_recruit_generated_non_heaven_count,
          EXISTS (
            SELECT 1
            FROM partner_recruit_job job
            WHERE job.character_id = c.id
              AND job.status = ANY($2::text[])
            LIMIT 1
          ) AS has_generated_preview_history
        FROM characters c
        WHERE c.id = $1
        LIMIT 1
        ${lockSql}
      `,
      [characterId, [...PARTNER_RECRUIT_FIRST_PREVIEW_GUARANTEE_CONSUMED_JOB_STATUSES]],
    );
    if (result.rows.length <= 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      generatedNonHeavenCount: Math.max(0, Math.floor(asNumber(
        row.partner_recruit_generated_non_heaven_count,
        0,
      ))),
      hasGeneratedPreviewHistory: asBoolean(row.has_generated_preview_history),
    };
  }

  private async loadCharacterUserId(characterId: number): Promise<number | null> {
    const result = await query(
      `
        SELECT user_id
        FROM characters
        WHERE id = $1
        LIMIT 1
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
    const guaranteeProgress = await this.loadPartnerRecruitGuaranteeProgress(characterId, false);
    if (guaranteeProgress === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    const unlockState = await this.getPartnerRecruitUnlockStateTx(characterId);
    if (!unlockState.success || !unlockState.data) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    if (!unlockState.data.unlocked) {
      const cooldownState = buildPartnerRecruitCooldownState(null);
      const guaranteeState = resolvePartnerRecruitHeavenGuaranteeState(guaranteeProgress.generatedNonHeavenCount);
      const qualityRates = resolvePartnerRecruitQualityRateEntries(guaranteeProgress.generatedNonHeavenCount);
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
          remainingUntilGuaranteedHeaven: guaranteeState.remainingUntilGuaranteedHeaven,
          qualityRates,
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
    const guaranteeState = resolvePartnerRecruitHeavenGuaranteeState(guaranteeProgress.generatedNonHeavenCount);
    const qualityRates = resolvePartnerRecruitQualityRateEntries(guaranteeProgress.generatedNonHeavenCount);
    const preview = latestJob?.previewPartnerDefId
      ? await buildGeneratedPartnerPreviewByPartnerDefId(latestJob.previewPartnerDefId)
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
        remainingUntilGuaranteedHeaven: guaranteeState.remainingUntilGuaranteedHeaven,
        qualityRates,
      }),
    };
  }

  @Transactional
  private async createRecruitJobTx(
    characterId: number,
    customBaseModelEnabled: boolean,
    requestedBaseModel: string | null,
  ): Promise<ServiceResult<{ generationId: string; quality: PartnerRecruitQuality }>> {
    await lockPartnerRecruitCreationMutex(characterId);
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

    const unlockState = await this.assertPartnerRecruitUnlocked(characterId);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const latestJob = await this.loadLatestJobRow(characterId, false);
    if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'generated_draft')) {
      return {
        success: false,
        message: latestJob.status === 'pending' ? '当前已有伙伴招募进行中' : '当前已有待确认的伙伴预览',
        code: 'RECRUIT_JOB_ACTIVE',
      };
    }

    const shouldUseCustomBaseModelToken = shouldPartnerRecruitUseCustomBaseModelToken(customBaseModelEnabled);
    const shouldBypassCooldown = shouldPartnerRecruitBypassCooldownWithCustomBaseModel(customBaseModelEnabled);
    if (!shouldBypassCooldown) {
      const cooldownReductionRate = await getActiveMonthCardCooldownReductionRate(characterId);
      const latestCooldownStartedAt = await this.loadLatestRecruitCooldownStartedAt(characterId, false);
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

    const spiritStones = await this.loadCharacterSpiritStones(characterId);
    if (spiritStones === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }
    const guaranteeProgress = await this.loadPartnerRecruitGuaranteeProgress(characterId, false);
    if (guaranteeProgress === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }
    if (spiritStones < PARTNER_RECRUIT_SPIRIT_STONES_COST) {
      return {
        success: false,
        message: `灵石不足，需要${PARTNER_RECRUIT_SPIRIT_STONES_COST.toLocaleString()}，当前${spiritStones.toLocaleString()}`,
        code: 'SPIRIT_STONES_NOT_ENOUGH',
      };
    }

    if (shouldUseCustomBaseModelToken) {
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
    const minimumQuality = guaranteeProgress.hasGeneratedPreviewHistory
      ? '黄'
      : PARTNER_RECRUIT_FIRST_PREVIEW_MINIMUM_QUALITY;
    const quality = resolvePartnerRecruitQualityForGeneratedPreviewSuccess(
      guaranteeProgress.generatedNonHeavenCount,
      undefined,
      minimumQuality,
    );
    const consumeCurrencyResult = await consumeCharacterCurrencies(characterId, {
      spiritStones: PARTNER_RECRUIT_SPIRIT_STONES_COST,
    });
    if (!consumeCurrencyResult.success) {
      return {
        success: false,
        message: consumeCurrencyResult.message,
        code: consumeCurrencyResult.message === '角色不存在'
          ? 'CHARACTER_NOT_FOUND'
          : consumeCurrencyResult.message.startsWith('灵石不足')
            ? 'SPIRIT_STONES_NOT_ENOUGH'
            : 'SPIRIT_STONES_STATE_CHANGED',
      };
    }

    if (shouldUseCustomBaseModelToken) {
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
          used_custom_base_model_token,
          cooldown_started_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'pending', $3, $4, $5, $6, NOW(), NOW(), NOW()
        )
      `,
      [
        generationId,
        characterId,
        quality,
        PARTNER_RECRUIT_SPIRIT_STONES_COST,
        requestedBaseModelValidation.value,
        shouldUseCustomBaseModelToken,
      ],
    );

    return {
      success: true,
      message: '伙伴招募已开始',
      data: {
        generationId,
        quality,
      },
    };
  }

  async createRecruitJob(
    characterId: number,
    customBaseModelEnabled: boolean,
    requestedBaseModel: string | null,
  ): Promise<ServiceResult<{ generationId: string; quality: PartnerRecruitQuality }>> {
    return this.createRecruitJobTx(characterId, customBaseModelEnabled, requestedBaseModel);
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
        SELECT status, spirit_stones_cost, requested_base_model, used_custom_base_model_token
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
    const usedCustomBaseModelToken = asBoolean(row.used_custom_base_model_token);
    if (status === 'accepted' || status === 'discarded' || status === 'failed' || status === 'refunded') return;

    const userId = await this.loadCharacterUserId(characterId);
    if (!userId) {
      throw new Error('退款邮件发送失败：角色不存在');
    }

    const refundErrorMessage = appendPartnerRecruitRefundHint(reason);
    const refundMailResult = await mailService.sendMail({
      recipientUserId: userId,
      recipientCharacterId: characterId,
      senderType: 'system',
      senderName: '系统',
      mailType: 'reward',
      title: PARTNER_RECRUIT_REFUND_MAIL_TITLE,
      content: buildPartnerRecruitRefundMailContent(reason),
      attachSpiritStones: spiritStonesCost,
      attachItems: usedCustomBaseModelToken
        ? [
            {
              item_def_id: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID,
              item_name: getPartnerRecruitCustomBaseModelTokenName(),
              qty: PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST,
            },
          ]
        : undefined,
      expireDays: 30,
      source: 'partner_recruit_refund',
      sourceRefId: generationId,
      metadata: {
        generationId,
        reason,
      },
    });
    if (!refundMailResult.success) {
      throw new Error(refundMailResult.message || '退款邮件发送失败');
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
      [generationId, characterId, nextStatus, refundErrorMessage],
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
        SELECT id, status, quality_rolled
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
    const qualityRolled = (asString((jobRes.rows[0] as Record<string, unknown>).quality_rolled) as PartnerRecruitQuality) || '黄';

    const persist = await persistGeneratedPartnerPreviewTx({
      characterId,
      generationId,
      draft,
      partnerDefId,
      avatarUrl,
      techniques,
    });

    const counterUpdateResult = await query(
      `
        UPDATE characters
        SET partner_recruit_generated_non_heaven_count = CASE
              WHEN $2 = '天' THEN 0
              ELSE partner_recruit_generated_non_heaven_count + 1
            END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING partner_recruit_generated_non_heaven_count
      `,
      [characterId, qualityRolled],
    );
    if (counterUpdateResult.rows.length === 0) {
      throw new Error('角色不存在');
    }

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

    return {
      success: true,
      message: '伙伴预览已生成',
      data: {
        preview: persist.preview,
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
    const baseModelReviewResult = await reviewPartnerRecruitCustomBaseModel(
      requestedBaseModel,
    );
    if (!baseModelReviewResult.success) {
      const finalReason = baseModelReviewResult.message;
      const finalErrorMessage = appendPartnerRecruitRefundHint(finalReason);
      await this.refundRecruitJobTx(args.characterId, args.generationId, finalReason, 'refunded');
      return {
        success: true,
        message: finalErrorMessage,
        data: {
          status: 'refunded',
          preview: null,
          errorMessage: finalErrorMessage,
        },
      };
    }

    const maxAttempts = 3;
    let lastFailure = '伙伴生成失败';
    let lastModelName = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await tryCallGeneratedPartnerTextModel({
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
    const finalErrorMessage = appendPartnerRecruitRefundHint(finalReason);
    await this.refundRecruitJobTx(args.characterId, args.generationId, finalReason, 'refunded');
    return {
      success: true,
      message: finalErrorMessage,
      data: {
        status: 'refunded',
        preview: null,
        errorMessage: finalErrorMessage,
      },
    };
  }

  async confirmRecruitDraft(characterId: number, generationId: string): Promise<ServiceResult<PartnerRecruitConfirmResponse>> {
    const result = await this.confirmRecruitDraftTx(characterId, generationId);
    if (result.success && result.data) {
      await this.broadcastHeavenPartnerRecruit(
        characterId,
        result.data.partnerId,
        result.data.partnerDefId,
        result.data.partnerName,
      );
    }
    return result;
  }

  @Transactional
  private async confirmRecruitDraftTx(characterId: number, generationId: string): Promise<ServiceResult<PartnerRecruitConfirmResponse>> {
    const unlockState = await this.assertPartnerRecruitUnlocked(characterId);
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

    const definition = await getPartnerDefinitionById(previewPartnerDefId);
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

}

export const partnerRecruitService = new PartnerRecruitService();
export default partnerRecruitService;
