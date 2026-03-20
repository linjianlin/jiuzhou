/**
 * 三魂归契伙伴占用状态共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“伙伴是否已被三魂归契任务占用”的查询与映射，供总览展示、培养校验、坊市校验与融合服务复用。
 * 2. 做什么：把阻断状态统一收口为单一入口，避免多个业务各自手写 `pending/generated_preview` 条件。
 * 3. 不做什么：不创建融合任务，不落预览结果，也不拼装前端状态 DTO。
 *
 * 输入/输出：
 * - 输入：伙伴 ID 列表或单个伙伴 ID，以及是否需要加锁。
 * - 输出：伙伴归契占用状态映射、单个有效占用任务摘要、角色当前有效融合任务摘要。
 *
 * 数据流/状态流：
 * 融合任务物料表 + 融合任务表 -> 本模块统一查询 -> 伙伴总览 / 市场 / 培养 / 三魂归契入口复用。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `pending/generated_preview` 才应阻断操作；`accepted/failed` 不能继续把伙伴标成归契中。
 * 2. 同一个伙伴历史上可能参与过多次融合，因此查询时必须显式联表过滤当前有效任务，不能只查物料表存在性。
 */
import { query } from '../../config/database.js';

export type PartnerFusionLockStatus = 'none' | 'fusion_locked';
export type PartnerFusionActiveJobStatus = 'pending' | 'generated_preview';

export type PartnerFusionLockState = {
  fusionStatus: PartnerFusionLockStatus;
  fusionJobId: string | null;
};

export type ActivePartnerFusionMaterialRow = {
  fusionJobId: string;
  characterId: number;
  status: PartnerFusionActiveJobStatus;
  partnerId: number;
};

export type ActiveCharacterPartnerFusionJobRow = {
  fusionJobId: string;
  characterId: number;
  status: PartnerFusionActiveJobStatus;
};

export const PARTNER_FUSION_ACTIVE_JOB_STATUSES: PartnerFusionActiveJobStatus[] = [
  'pending',
  'generated_preview',
];

export const createPartnerFusionLockState = (
  fusionJobId: string | null,
): PartnerFusionLockState => ({
  fusionStatus: fusionJobId ? 'fusion_locked' : 'none',
  fusionJobId,
});

export const loadPartnerFusionLockStateMap = async (
  partnerIds: number[],
): Promise<Map<number, PartnerFusionLockState>> => {
  const normalizedPartnerIds = [...new Set(
    partnerIds
      .map((partnerId) => Number(partnerId))
      .filter((partnerId) => Number.isInteger(partnerId) && partnerId > 0),
  )];
  const resultMap = new Map<number, PartnerFusionLockState>();
  if (normalizedPartnerIds.length <= 0) return resultMap;

  const result = await query(
    `
      SELECT m.partner_id, j.id AS fusion_job_id
      FROM partner_fusion_job_material m
      JOIN partner_fusion_job j ON j.id = m.fusion_job_id
      WHERE m.partner_id = ANY($1)
        AND j.status = ANY($2::text[])
      ORDER BY j.created_at DESC
    `,
    [normalizedPartnerIds, PARTNER_FUSION_ACTIVE_JOB_STATUSES],
  );

  for (const row of result.rows as Array<{ partner_id: number; fusion_job_id: string }>) {
    const partnerId = Number(row.partner_id);
    if (resultMap.has(partnerId)) continue;
    resultMap.set(partnerId, createPartnerFusionLockState(String(row.fusion_job_id)));
  }

  for (const partnerId of normalizedPartnerIds) {
    if (!resultMap.has(partnerId)) {
      resultMap.set(partnerId, createPartnerFusionLockState(null));
    }
  }

  return resultMap;
};

export const loadActivePartnerFusionMaterial = async (
  partnerId: number,
  forUpdate: boolean,
): Promise<ActivePartnerFusionMaterialRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT
        j.id AS fusion_job_id,
        j.character_id,
        j.status,
        m.partner_id
      FROM partner_fusion_job_material m
      JOIN partner_fusion_job j ON j.id = m.fusion_job_id
      WHERE m.partner_id = $1
        AND j.status = ANY($2::text[])
      ORDER BY j.created_at DESC
      LIMIT 1
      ${lockSql}
    `,
    [partnerId, PARTNER_FUSION_ACTIVE_JOB_STATUSES],
  );
  if (result.rows.length <= 0) return null;
  const row = result.rows[0] as {
    fusion_job_id: string;
    character_id: number;
    status: PartnerFusionActiveJobStatus;
    partner_id: number;
  };
  return {
    fusionJobId: String(row.fusion_job_id),
    characterId: Number(row.character_id),
    status: row.status,
    partnerId: Number(row.partner_id),
  };
};

export const loadCharacterActivePartnerFusionJob = async (
  characterId: number,
  forUpdate: boolean,
): Promise<ActiveCharacterPartnerFusionJobRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, character_id, status
      FROM partner_fusion_job
      WHERE character_id = $1
        AND status = ANY($2::text[])
      ORDER BY created_at DESC
      LIMIT 1
      ${lockSql}
    `,
    [characterId, PARTNER_FUSION_ACTIVE_JOB_STATUSES],
  );
  if (result.rows.length <= 0) return null;
  const row = result.rows[0] as {
    id: string;
    character_id: number;
    status: PartnerFusionActiveJobStatus;
  };
  return {
    fusionJobId: String(row.id),
    characterId: Number(row.character_id),
    status: row.status,
  };
};
