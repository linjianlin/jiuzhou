/**
 * 三魂归契伙伴融合服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供三魂归契状态查询、融合发起、异步生成预览、结果确认与已读标记。
 * 2) 做什么：把素材校验、归契占用态、结果品质抽取与预览状态机统一收口，避免路由和前端各自猜业务条件。
 * 3) 不做什么：不解析 HTTP 参数，也不在这里维护 worker 生命周期；线程调度交给独立 runner。
 *
 * 输入/输出：
 * - 输入：characterId、fusionId、素材伙伴 ID 列表。
 * - 输出：统一 `{ success, message, data }` 结果，以及三魂归契状态 DTO / 确认结果 DTO。
 *
 * 数据流/状态流：
 * route -> partnerFusionService.start -> runner.enqueue -> worker -> processPendingFusionJob -> preview -> confirm -> 新伙伴入队。
 *
 * 关键边界条件与坑点：
 * 1) 素材伙伴在发起后并不立即删行，而是通过任务物料表进入“归契中”阻断态；这样失败时无需补写回滚数据，只需结束任务即可恢复可用。
 * 2) 只有 confirm 才真正删除 3 个素材伙伴并创建新伙伴实例，因此确认逻辑必须在事务里重新锁定任务和素材，防止并发穿透。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from './featureUnlockService.js';
import { partnerService } from './partnerService.js';
import {
  buildGeneratedPartnerDefId,
  buildGeneratedPartnerPreviewByPartnerDefId,
  executeGeneratedPartnerVisualGeneration,
  persistGeneratedPartnerPreviewTx,
  tryCallGeneratedPartnerTextModel,
  type GeneratedPartnerPreviewDto,
  type GeneratedPartnerTechniqueDraft,
} from './shared/partnerGeneratedPreview.js';
import {
  buildPartnerFusionJobState,
  type PartnerFusionJobStatus,
} from './shared/partnerFusionJobShared.js';
import {
  buildPartnerFusionStatusDto,
  type PartnerFusionStatusDto,
} from './shared/partnerFusionStatus.js';
import {
  loadActivePartnerFusionMaterial,
  loadCharacterActivePartnerFusionJob,
} from './shared/partnerFusionState.js';
import {
  PARTNER_FUSION_MATERIAL_COUNT,
  rollPartnerFusionResultQuality,
} from './shared/partnerFusionRules.js';
import type { PartnerRecruitDraft } from './shared/partnerRecruitRules.js';
import {
  loadPartnerTechniqueRows,
  normalizeText,
  type PartnerRow,
  type PartnerTechniqueRow,
} from './shared/partnerView.js';
import { loadActivePartnerMarketListing } from './shared/partnerMarketState.js';
import { broadcastHeavenPartnerAcquired } from './shared/partnerWorldBroadcast.js';
import { getPartnerDefinitionById } from './staticConfigLoader.js';
import { isQualityName, type QualityName } from './shared/itemQuality.js';

export type PartnerFusionResult<T = undefined> = {
  success: boolean;
  message: string;
  data?: T;
  code?: string;
};

export interface PartnerFusionStartResultDto {
  fusionId: string;
  sourceQuality: QualityName;
  resultQuality: QualityName;
}

export interface PartnerFusionConfirmResponseDto {
  fusionId: string;
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
  activated: boolean;
}

type FusionJobRow = {
  fusionId: string;
  status: PartnerFusionJobStatus;
  sourceQuality: QualityName;
  resultQuality: QualityName | null;
  previewPartnerDefId: string | null;
  errorMessage: string | null;
  viewedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

type FusionMaterialRow = {
  id: number;
  fusion_job_id: string;
  partner_id: number;
  character_id: number;
  material_order: number;
  partner_snapshot: object;
};

type CharacterExistRow = {
  id: number;
};

type PartnerFusionMaterialSnapshot = {
  partnerId: number;
  partnerDefId: string;
  nickname: string;
  quality: QualityName;
  level: number;
  techniqueIds: string[];
};

const normalizeGeneratedId = (prefix: string): string => {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const buildPartnerFusionJobId = (): string => normalizeGeneratedId('partner-fusion');

const normalizePartnerIdList = (partnerIds: number[]): number[] => {
  return [...new Set(
    partnerIds
      .map((partnerId) => Number(partnerId))
      .filter((partnerId) => Number.isInteger(partnerId) && partnerId > 0),
  )];
};

const toIsoString = (raw: Date | string | null | undefined): string | null => {
  if (!raw) return null;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const buildMaterialSnapshot = (
  row: PartnerRow,
  quality: QualityName,
  techniqueRows: PartnerTechniqueRow[],
): PartnerFusionMaterialSnapshot => {
  return {
    partnerId: Number(row.id),
    partnerDefId: normalizeText(row.partner_def_id),
    nickname: normalizeText(row.nickname),
    quality,
    level: Number(row.level),
    techniqueIds: techniqueRows.map((entry) => normalizeText(entry.technique_id)).filter(Boolean),
  };
};

const getPartnerQualityByRow = (row: PartnerRow): QualityName | null => {
  const definition = getPartnerDefinitionById(row.partner_def_id);
  if (!definition) {
    throw new Error(`伙伴模板不存在: ${row.partner_def_id}`);
  }
  return isQualityName(definition.quality) ? definition.quality : null;
};

const loadCharacterExists = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterExistRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as CharacterExistRow;
};

const loadCharacterPartnersByIds = async (
  characterId: number,
  partnerIds: number[],
  forUpdate: boolean,
): Promise<PartnerRow[]> => {
  const normalizedPartnerIds = normalizePartnerIdList(partnerIds);
  if (normalizedPartnerIds.length <= 0) return [];
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT *
      FROM character_partner
      WHERE character_id = $1
        AND id = ANY($2)
      ORDER BY created_at ASC, id ASC
      ${lockSql}
    `,
    [characterId, normalizedPartnerIds],
  );
  return result.rows as PartnerRow[];
};

const loadFusionMaterialRows = async (
  fusionId: string,
  forUpdate: boolean,
): Promise<FusionMaterialRow[]> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, fusion_job_id, partner_id, character_id, material_order, partner_snapshot
      FROM partner_fusion_job_material
      WHERE fusion_job_id = $1
      ORDER BY material_order ASC, id ASC
      ${lockSql}
    `,
    [fusionId],
  );
  return result.rows as FusionMaterialRow[];
};

class PartnerFusionService {
  private async assertPartnerSystemUnlocked(
    characterId: number,
  ): Promise<PartnerFusionResult<{ featureCode: string }>> {
    const unlocked = await isFeatureUnlocked(characterId, PARTNER_SYSTEM_FEATURE_CODE);
    if (!unlocked) {
      return { success: false, message: '伙伴系统尚未解锁', code: 'PARTNER_SYSTEM_LOCKED' };
    }
    return {
      success: true,
      message: 'ok',
      data: {
        featureCode: PARTNER_SYSTEM_FEATURE_CODE,
      },
    };
  }

  private async loadLatestFusionJobRow(
    characterId: number,
    forUpdate: boolean,
  ): Promise<FusionJobRow | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT
          id,
          status,
          source_quality,
          result_quality,
          preview_partner_def_id,
          error_message,
          viewed_at,
          finished_at,
          created_at
        FROM partner_fusion_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    const row = result.rows[0] as {
      id: string;
      status: PartnerFusionJobStatus;
      source_quality: QualityName;
      result_quality: QualityName | null;
      preview_partner_def_id: string | null;
      error_message: string | null;
      viewed_at: Date | string | null;
      finished_at: Date | string | null;
      created_at: Date | string;
    };
    return {
      fusionId: String(row.id),
      status: row.status,
      sourceQuality: row.source_quality,
      resultQuality: row.result_quality,
      previewPartnerDefId: row.preview_partner_def_id ? String(row.preview_partner_def_id) : null,
      errorMessage: row.error_message ? String(row.error_message) : null,
      viewedAt: toIsoString(row.viewed_at),
      finishedAt: toIsoString(row.finished_at),
      createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    };
  }

  async getFusionStatus(characterId: number): Promise<PartnerFusionResult<PartnerFusionStatusDto>> {
    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success || !unlockState.data) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const latestJob = await this.loadLatestFusionJobRow(characterId, false);
    const materialRows = latestJob ? await loadFusionMaterialRows(latestJob.fusionId, false) : [];
    const preview = latestJob?.previewPartnerDefId
      ? buildGeneratedPartnerPreviewByPartnerDefId(latestJob.previewPartnerDefId)
      : null;
    const state = buildPartnerFusionJobState(latestJob
      ? {
          fusionId: latestJob.fusionId,
          status: latestJob.status,
          startedAt: latestJob.createdAt,
          finishedAt: latestJob.finishedAt,
          viewedAt: latestJob.viewedAt,
          errorMessage: latestJob.errorMessage,
          sourceQuality: latestJob.sourceQuality,
          resultQuality: latestJob.resultQuality,
          materialPartnerIds: materialRows.map((row) => Number(row.partner_id)),
          preview,
        }
      : null);

    return {
      success: true,
      message: '获取成功',
      data: buildPartnerFusionStatusDto({
        featureCode: unlockState.data.featureCode,
        state,
      }),
    };
  }

  @Transactional
  async startFusion(
    characterId: number,
    partnerIds: number[],
  ): Promise<PartnerFusionResult<PartnerFusionStartResultDto>> {
    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const normalizedPartnerIds = normalizePartnerIdList(partnerIds);
    if (normalizedPartnerIds.length !== PARTNER_FUSION_MATERIAL_COUNT) {
      return {
        success: false,
        message: `必须选择${PARTNER_FUSION_MATERIAL_COUNT}个不同伙伴进行归契`,
        code: 'FUSION_MATERIAL_COUNT_INVALID',
      };
    }

    const character = await loadCharacterExists(characterId, true);
    if (!character) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }

    const activeJob = await loadCharacterActivePartnerFusionJob(characterId, true);
    if (activeJob) {
      return {
        success: false,
        message: activeJob.status === 'pending' ? '当前已有三魂归契进行中' : '当前已有待确认的三魂归契结果',
        code: 'FUSION_JOB_ACTIVE',
      };
    }

    const partnerRows = await loadCharacterPartnersByIds(characterId, normalizedPartnerIds, true);
    if (partnerRows.length !== PARTNER_FUSION_MATERIAL_COUNT) {
      return { success: false, message: '归契素材伙伴不存在', code: 'FUSION_PARTNER_NOT_FOUND' };
    }

    const techniqueMap = await loadPartnerTechniqueRows(normalizedPartnerIds, true);
    let sourceQuality: QualityName | null = null;
    for (const row of partnerRows) {
      if (row.is_active) {
        return { success: false, message: '出战中的伙伴不可参与三魂归契', code: 'FUSION_PARTNER_ACTIVE' };
      }
      if (await loadActivePartnerMarketListing(Number(row.id), true)) {
        return { success: false, message: '坊市中的伙伴不可参与三魂归契', code: 'FUSION_PARTNER_MARKET' };
      }
      if (await loadActivePartnerFusionMaterial(Number(row.id), true)) {
        return { success: false, message: '归契中的伙伴不可重复参与三魂归契', code: 'FUSION_PARTNER_LOCKED' };
      }

      const quality = getPartnerQualityByRow(row);
      if (!quality) {
        return { success: false, message: '伙伴品级配置非法', code: 'FUSION_PARTNER_QUALITY_INVALID' };
      }
      if (sourceQuality && quality !== sourceQuality) {
        return { success: false, message: '三魂归契素材必须为同品级伙伴', code: 'FUSION_PARTNER_QUALITY_MISMATCH' };
      }
      sourceQuality = quality;
    }

    if (!sourceQuality) {
      return { success: false, message: '三魂归契素材品级非法', code: 'FUSION_PARTNER_QUALITY_INVALID' };
    }

    const fusionId = buildPartnerFusionJobId();
    const resultQuality = rollPartnerFusionResultQuality(sourceQuality);

    await query(
      `
        INSERT INTO partner_fusion_job (
          id,
          character_id,
          status,
          source_quality,
          result_quality,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'pending', $3, $4, NOW(), NOW()
        )
      `,
      [fusionId, characterId, sourceQuality, resultQuality],
    );

    for (const [index, row] of partnerRows.entries()) {
      const quality = getPartnerQualityByRow(row);
      if (!quality) {
        return { success: false, message: '伙伴品级配置非法', code: 'FUSION_PARTNER_QUALITY_INVALID' };
      }
      const snapshot = buildMaterialSnapshot(
        row,
        quality,
        techniqueMap.get(Number(row.id)) ?? [],
      );
      await query(
        `
          INSERT INTO partner_fusion_job_material (
            fusion_job_id,
            partner_id,
            character_id,
            material_order,
            partner_snapshot,
            created_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, NOW()
          )
        `,
        [fusionId, Number(row.id), characterId, index + 1, JSON.stringify(snapshot)],
      );
    }

    return {
      success: true,
      message: '三魂归契已开始',
      data: {
        fusionId,
        sourceQuality,
        resultQuality,
      },
    };
  }

  @Transactional
  private async markFusionJobFailedTx(
    characterId: number,
    fusionId: string,
    reason: string,
  ): Promise<void> {
    const result = await query(
      `
        SELECT status
        FROM partner_fusion_job
        WHERE id = $1
          AND character_id = $2
        FOR UPDATE
      `,
      [fusionId, characterId],
    );
    if (result.rows.length <= 0) return;
    const row = result.rows[0] as { status: PartnerFusionJobStatus };
    if (row.status === 'accepted' || row.status === 'failed') return;

    await query(
      `
        UPDATE partner_fusion_job
        SET status = 'failed',
            error_message = $3,
            finished_at = COALESCE(finished_at, NOW()),
            viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND character_id = $2
      `,
      [fusionId, characterId, reason],
    );
  }

  async forceFailPendingFusionJob(
    characterId: number,
    fusionId: string,
    reason: string,
  ): Promise<void> {
    await this.markFusionJobFailedTx(characterId, fusionId, reason);
  }

  @Transactional
  private async persistGeneratedFusionPreviewTx(args: {
    characterId: number;
    fusionId: string;
    draft: PartnerRecruitDraft;
    partnerDefId: string;
    avatarUrl: string;
    techniques: GeneratedPartnerTechniqueDraft[];
  }): Promise<PartnerFusionResult<{ preview: GeneratedPartnerPreviewDto }>> {
    const { characterId, fusionId, draft, partnerDefId, avatarUrl, techniques } = args;
    const jobResult = await query(
      `
        SELECT status
        FROM partner_fusion_job
        WHERE id = $1
          AND character_id = $2
        FOR UPDATE
      `,
      [fusionId, characterId],
    );
    if (jobResult.rows.length <= 0) {
      return { success: false, message: '归契任务不存在', code: 'FUSION_JOB_NOT_FOUND' };
    }
    const row = jobResult.rows[0] as { status: PartnerFusionJobStatus };
    if (row.status !== 'pending') {
      return { success: false, message: '归契任务状态异常', code: 'FUSION_JOB_STATE_INVALID' };
    }

    const persist = await persistGeneratedPartnerPreviewTx({
      characterId,
      generationId: fusionId,
      draft,
      partnerDefId,
      avatarUrl,
      techniques,
    });

    await query(
      `
        UPDATE partner_fusion_job
        SET status = 'generated_preview',
            preview_partner_def_id = $3,
            finished_at = NOW(),
            viewed_at = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $1
          AND character_id = $2
      `,
      [fusionId, characterId, partnerDefId],
    );

    return {
      success: true,
      message: '归契预览已生成',
      data: {
        preview: persist.preview,
      },
    };
  }

  async processPendingFusionJob(args: {
    characterId: number;
    fusionId: string;
  }): Promise<PartnerFusionResult<{
    status: Extract<PartnerFusionJobStatus, 'generated_preview' | 'failed'>;
    preview: GeneratedPartnerPreviewDto | null;
    errorMessage: string | null;
  }>> {
    const jobResult = await query(
      `
        SELECT status, result_quality
        FROM partner_fusion_job
        WHERE id = $1
          AND character_id = $2
        LIMIT 1
      `,
      [args.fusionId, args.characterId],
    );
    if (jobResult.rows.length <= 0) {
      return {
        success: true,
        message: '归契任务不存在',
        data: {
          status: 'failed',
          preview: null,
          errorMessage: '归契任务不存在',
        },
      };
    }

    const jobRow = jobResult.rows[0] as {
      status: PartnerFusionJobStatus;
      result_quality: QualityName | null;
    };
    if (jobRow.status !== 'pending') {
      return {
        success: true,
        message: '归契任务状态异常',
        data: {
          status: 'failed',
          preview: null,
          errorMessage: '归契任务状态异常',
        },
      };
    }
    if (!jobRow.result_quality || !isQualityName(jobRow.result_quality)) {
      const reason = '归契结果品质非法';
      await this.markFusionJobFailedTx(args.characterId, args.fusionId, reason);
      return {
        success: true,
        message: reason,
        data: {
          status: 'failed',
          preview: null,
          errorMessage: reason,
        },
      };
    }

    const maxAttempts = 3;
    let lastFailure = '伙伴生成失败';
    let lastModelName = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await tryCallGeneratedPartnerTextModel({
        quality: jobRow.result_quality,
      });
      if (!result.success) {
        lastFailure = result.reason;
        lastModelName = result.modelName;
        continue;
      }

      try {
        const partnerDefId = buildGeneratedPartnerDefId();
        const { techniques, avatarUrl } = await executeGeneratedPartnerVisualGeneration({
          characterId: args.characterId,
          generationId: args.fusionId,
          draft: result.draft,
          partnerDefId,
        });

        const persist = await this.persistGeneratedFusionPreviewTx({
          characterId: args.characterId,
          fusionId: args.fusionId,
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
          message: '归契预览生成成功',
          data: {
            status: 'generated_preview',
            preview: persist.data.preview,
            errorMessage: null,
          },
        };
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : '伙伴归契生成异常';
        lastModelName = result.modelName;
      }
    }

    const finalReason = lastModelName ? `三魂归契失败：${lastFailure}（model=${lastModelName}）` : `三魂归契失败：${lastFailure}`;
    await this.markFusionJobFailedTx(args.characterId, args.fusionId, finalReason);
    return {
      success: true,
      message: finalReason,
      data: {
        status: 'failed',
        preview: null,
        errorMessage: finalReason,
      },
    };
  }

  async confirmFusionPreview(
    characterId: number,
    fusionId: string,
  ): Promise<PartnerFusionResult<PartnerFusionConfirmResponseDto>> {
    const result = await this.confirmFusionPreviewTx(characterId, fusionId);
    if (result.success && result.data) {
      await broadcastHeavenPartnerAcquired({
        characterId,
        partnerDefId: result.data.partnerDefId,
        partnerName: result.data.partnerName,
        sourceLabel: '三魂归契',
      });
    }
    return result;
  }

  @Transactional
  private async confirmFusionPreviewTx(
    characterId: number,
    fusionId: string,
  ): Promise<PartnerFusionResult<PartnerFusionConfirmResponseDto>> {
    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const jobResult = await query(
      `
        SELECT status, preview_partner_def_id
        FROM partner_fusion_job
        WHERE id = $1
          AND character_id = $2
        FOR UPDATE
      `,
      [fusionId, characterId],
    );
    if (jobResult.rows.length <= 0) {
      return { success: false, message: '归契任务不存在', code: 'FUSION_JOB_NOT_FOUND' };
    }
    const jobRow = jobResult.rows[0] as {
      status: PartnerFusionJobStatus;
      preview_partner_def_id: string | null;
    };
    if (jobRow.status !== 'generated_preview' || !jobRow.preview_partner_def_id) {
      return { success: false, message: '当前归契结果不可确认', code: 'FUSION_JOB_STATE_INVALID' };
    }

    const definition = getPartnerDefinitionById(jobRow.preview_partner_def_id);
    if (!definition) {
      return { success: false, message: '归契预览伙伴定义不存在', code: 'FUSION_PREVIEW_NOT_FOUND' };
    }

    const materialRows = await loadFusionMaterialRows(fusionId, true);
    if (materialRows.length !== PARTNER_FUSION_MATERIAL_COUNT) {
      return { success: false, message: '归契素材数据异常', code: 'FUSION_MATERIAL_INVALID' };
    }
    const materialPartnerIds = materialRows.map((row) => Number(row.partner_id));
    const partnerRows = await loadCharacterPartnersByIds(characterId, materialPartnerIds, true);
    if (partnerRows.length !== PARTNER_FUSION_MATERIAL_COUNT) {
      return { success: false, message: '归契素材伙伴已失效', code: 'FUSION_PARTNER_NOT_FOUND' };
    }
    for (const row of partnerRows) {
      if (row.is_active) {
        return { success: false, message: '归契素材状态异常，请稍后重试', code: 'FUSION_PARTNER_STATE_INVALID' };
      }
      if (await loadActivePartnerMarketListing(Number(row.id), true)) {
        return { success: false, message: '归契素材状态异常，请稍后重试', code: 'FUSION_PARTNER_STATE_INVALID' };
      }
    }

    await query(
      `
        DELETE FROM character_partner
        WHERE character_id = $1
          AND id = ANY($2)
      `,
      [characterId, materialPartnerIds],
    );

    const created = await partnerService.createPartnerInstanceFromDefinition({
      characterId,
      definition,
      obtainedFrom: 'partner_fusion',
      obtainedRefId: fusionId,
      nickname: definition.name,
    });

    await query(
      `
        UPDATE partner_fusion_job
        SET status = 'accepted',
            viewed_at = COALESCE(viewed_at, NOW()),
            finished_at = COALESCE(finished_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
          AND character_id = $2
      `,
      [fusionId, characterId],
    );

    return {
      success: true,
      message: '已确认收下归契伙伴',
      data: {
        fusionId,
        partnerId: created.reward.partnerId,
        partnerDefId: created.reward.partnerDefId,
        partnerName: created.reward.partnerName,
        partnerAvatar: created.reward.partnerAvatar,
        activated: created.activated,
      },
    };
  }

  @Transactional
  async markResultViewed(
    characterId: number,
  ): Promise<PartnerFusionResult<{ fusionId: string | null }>> {
    const result = await query(
      `
        SELECT id
        FROM partner_fusion_job
        WHERE character_id = $1
          AND status = ANY($2::text[])
          AND viewed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, ['generated_preview', 'failed']],
    );
    if (result.rows.length <= 0) {
      return {
        success: true,
        message: '无需标记',
        data: {
          fusionId: null,
        },
      };
    }

    const row = result.rows[0] as { id: string };
    await query(
      `
        UPDATE partner_fusion_job
        SET viewed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
          AND character_id = $2
      `,
      [String(row.id), characterId],
    );

    return {
      success: true,
      message: '已标记归契结果',
      data: {
        fusionId: String(row.id),
      },
    };
  }
}

export const partnerFusionService = new PartnerFusionService();
export default partnerFusionService;
