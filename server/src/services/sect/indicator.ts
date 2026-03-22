/**
 * 宗门首页指示器计算模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中计算首页宗门红点所需的轻量状态，避免首页、路由、Socket 各自重复拼装 `/sect/me + 申请列表`。
 * 2. 做什么：集中提供“宗门全员 / 宗门管理层”的角色 ID 列表，供推送层复用。
 * 3. 不做什么：不返回宗门详情、不发送 Socket、不处理 HTTP 参数校验。
 *
 * 输入/输出：
 * - 输入：characterId、sectId。
 * - 输出：SectIndicatorPayload、宗门成员角色 ID 列表、宗门管理层角色 ID 列表、角色到用户映射。
 *
 * 数据流/状态流：
 * - characterId -> 读取 sect_member 与 sect_application -> 计算 joined / 我的待处理申请数 / 是否可审批。
 * - 若当前角色可审批申请 -> 继续按 sect_id 统计宗门待处理申请总数。
 * - sectId -> 读取 sect_member -> 产出需要接收通知的角色集合。
 *
 * 关键边界条件与坑点：
 * 1. 首页红点只认 leader / vice_leader / elder 的审批权限，权限判定必须与业务规则保持单一来源。
 * 2. 已入宗角色正常情况下不应再有 pending 申请；这里仍按数据库真实值计算，便于在脏数据场景下快速暴露问题，而不是静默吞掉。
 */
import { query } from '../../config/database.js';
import { loadCharacterWritebackRowByCharacterId } from '../playerWritebackCacheService.js';
import type { SectPosition } from './types.js';

export interface SectIndicatorPayload {
  joined: boolean;
  myPendingApplicationCount: number;
  sectPendingApplicationCount: number;
  canManageApplications: boolean;
}

interface SectMemberPositionRow {
  sect_id: string;
  position: SectPosition;
}

interface SectMemberCharacterRow {
  character_id: number | string;
}

interface CharacterUserRow {
  id: number | string;
  user_id: number | string;
}

const APPLICATION_MANAGER_POSITIONS: readonly SectPosition[] = ['leader', 'vice_leader', 'elder'];

const normalizeCount = (value: number | string | null | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

export const normalizeCharacterIdList = (characterIds: number[]): number[] => {
  return Array.from(
    new Set(
      characterIds
        .map((characterId) => Math.floor(Number(characterId)))
        .filter((characterId) => Number.isFinite(characterId) && characterId > 0)
    )
  );
};

const canManageSectApplications = (position: SectPosition): boolean => {
  return APPLICATION_MANAGER_POSITIONS.includes(position);
};

const loadMyPendingApplicationCount = async (characterId: number): Promise<number> => {
  const result = await query<{ count: number | string }>(
    `
      SELECT COUNT(*)::int AS count
      FROM sect_application
      WHERE character_id = $1 AND status = 'pending'
    `,
    [characterId]
  );
  return normalizeCount(result.rows[0]?.count);
};

const loadSectPendingApplicationCount = async (sectId: string): Promise<number> => {
  const result = await query<{ count: number | string }>(
    `
      SELECT COUNT(*)::int AS count
      FROM sect_application
      WHERE sect_id = $1 AND status = 'pending'
    `,
    [sectId]
  );
  return normalizeCount(result.rows[0]?.count);
};

export const getSectIndicatorByCharacterId = async (characterId: number): Promise<SectIndicatorPayload> => {
  const [memberResult, myPendingApplicationCount] = await Promise.all([
    query<SectMemberPositionRow>(
      `
        SELECT sect_id, position
        FROM sect_member
        WHERE character_id = $1
        LIMIT 1
      `,
      [characterId]
    ),
    loadMyPendingApplicationCount(characterId),
  ]);

  const member = memberResult.rows[0];
  if (!member) {
    return {
      joined: false,
      myPendingApplicationCount,
      sectPendingApplicationCount: 0,
      canManageApplications: false,
    };
  }

  const canManageApplications = canManageSectApplications(member.position);
  const sectPendingApplicationCount = canManageApplications ? await loadSectPendingApplicationCount(member.sect_id) : 0;
  return {
    joined: true,
    myPendingApplicationCount,
    sectPendingApplicationCount,
    canManageApplications,
  };
};

const listSectCharacterIds = async (sectId: string, positions?: readonly SectPosition[]): Promise<number[]> => {
  const hasPositionFilter = Boolean(positions && positions.length > 0);
  const result = hasPositionFilter
    ? await query<SectMemberCharacterRow>(
        `
          SELECT character_id
          FROM sect_member
          WHERE sect_id = $1 AND position = ANY($2::text[])
        `,
        [sectId, positions]
      )
    : await query<SectMemberCharacterRow>(
        `
          SELECT character_id
          FROM sect_member
          WHERE sect_id = $1
        `,
        [sectId]
      );

  return normalizeCharacterIdList(result.rows.map((row) => normalizeCount(row.character_id)));
};

export const listSectMemberCharacterIds = async (sectId: string): Promise<number[]> => {
  return listSectCharacterIds(sectId);
};

export const listSectManagerCharacterIds = async (sectId: string): Promise<number[]> => {
  return listSectCharacterIds(sectId, APPLICATION_MANAGER_POSITIONS);
};

export const getCharacterUserIdMap = async (characterIds: number[]): Promise<Map<number, number>> => {
  const ids = normalizeCharacterIdList(characterIds);
  if (ids.length <= 0) return new Map<number, number>();

  const rows = await Promise.all(
    ids.map(async (characterId) => loadCharacterWritebackRowByCharacterId(characterId)),
  );

  const userIdMap = new Map<number, number>();
  for (const row of rows) {
    if (!row) continue;
    const characterId = normalizeCount(row.id);
    const userId = normalizeCount(row.user_id);
    if (characterId <= 0 || userId <= 0) continue;
    userIdMap.set(characterId, userId);
  }
  return userIdMap;
};
