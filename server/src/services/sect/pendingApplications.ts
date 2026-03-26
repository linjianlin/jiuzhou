/**
 * 宗门待处理申请共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义“仍然有效的 pending 入门申请”判定，统一首页红点、申请列表、我的申请三个读口径，避免各处各写一份 `status = 'pending'`。
 * 2. 做什么：提供“角色入宗后清理旧 pending 申请”的复用查询入口，供创建宗门、开放加入、审批通过三条入宗链路共用。
 * 3. 不做什么：不负责 Socket 推送、不直接失效缓存，也不处理宗门权限。
 *
 * 输入/输出：
 * - 输入：characterId、applicationId。
 * - 输出：有效 pending 申请所属宗门 ID 列表、单条申请 scope、被清理的宗门 ID 列表。
 *
 * 数据流/状态流：
 * - 读侧：indicator/cache 等模块复用同一段 SQL 条件，只把“申请人当前未入宗”的 pending 记录视为有效。
 * - 写侧：角色加入宗门后调用清理函数，把该角色剩余的有效 pending 申请统一改为 cancelled，并把受影响宗门范围回传给上层做失效与推送。
 *
 * 关键边界条件与坑点：
 * 1. “角色已在 sect_member 中存在”时，对应 pending 申请必须整体视为失效；否则会出现红点、申请列表和真实宗门状态不一致。
 * 2. 审批通过当前申请时，必须排除当前 applicationId，避免把刚通过的申请错误改成 cancelled。
 */
import { query } from '../../config/database.js';

interface PendingApplicationSectIdRow {
  sect_id: string;
}

interface SectApplicationScopeRow {
  sect_id: string;
  character_id: number | string;
}

export const VISIBLE_PENDING_APPLICATION_CONDITION = `
  a.status = 'pending'
  AND NOT EXISTS (
    SELECT 1
    FROM sect_member sm
    WHERE sm.character_id = a.character_id
  )
`;

const normalizeCharacterId = (value: number | string): number => {
  const next = Number(value);
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.floor(next));
};

const normalizeSectIdList = (sectIds: readonly string[]): string[] => {
  return Array.from(new Set(sectIds.map((sectId) => sectId.trim()).filter((sectId) => sectId.length > 0)));
};

export const listVisiblePendingApplicationSectIdsByCharacterId = async (characterId: number): Promise<string[]> => {
  const result = await query<PendingApplicationSectIdRow>(
    `
      SELECT DISTINCT a.sect_id
      FROM sect_application a
      WHERE a.character_id = $1
        AND ${VISIBLE_PENDING_APPLICATION_CONDITION}
    `,
    [characterId]
  );
  return normalizeSectIdList(result.rows.map((row) => row.sect_id));
};

export const getSectApplicationScopeById = async (
  applicationId: number
): Promise<{ sectId: string; characterId: number } | null> => {
  const result = await query<SectApplicationScopeRow>(
    `
      SELECT sect_id, character_id
      FROM sect_application
      WHERE id = $1
      LIMIT 1
    `,
    [applicationId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const characterId = normalizeCharacterId(row.character_id);
  if (!row.sect_id || characterId <= 0) return null;

  return {
    sectId: row.sect_id,
    characterId,
  };
};

export const cancelVisiblePendingApplicationsByCharacterId = async (
  characterId: number,
  excludedApplicationId?: number
): Promise<string[]> => {
  const hasExcludedApplicationId = typeof excludedApplicationId === 'number' && Number.isFinite(excludedApplicationId);
  const params = hasExcludedApplicationId ? [characterId, Math.floor(excludedApplicationId)] : [characterId];
  const excludedClause = hasExcludedApplicationId ? 'AND a.id <> $2' : '';

  const result = await query<PendingApplicationSectIdRow>(
    `
      UPDATE sect_application a
      SET status = 'cancelled', handled_at = NOW(), handled_by = NULL
      WHERE a.character_id = $1
        AND ${VISIBLE_PENDING_APPLICATION_CONDITION}
        ${excludedClause}
      RETURNING a.sect_id
    `,
    params
  );

  return normalizeSectIdList(result.rows.map((row) => row.sect_id));
};
