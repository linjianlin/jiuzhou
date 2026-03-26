/**
 * 宗门读缓存模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中承载宗门详情、宗门申请列表、我的宗门申请三类高频读缓存，避免在 core/applications/buildings/economy 各写一套。
 * 2. 做什么：把缓存键、TTL、失效入口收敛到单一模块，写路径只调用失效函数，不重复拼缓存实现细节。
 * 3. 不做什么：不处理权限校验，也不处理宗门写操作；这些仍由各业务服务负责。
 *
 * 输入/输出：
 * - 输入：sectId、characterId。
 * - 输出：SectInfo、SectApplicationListItem[]、MySectApplicationListItem[]。
 *
 * 数据流/状态流：
 * - 读：业务服务 -> 本模块缓存读取 -> 未命中时查询 DB -> 回填内存与 Redis。
 * - 写：业务服务完成 DB 更新 -> 调用本模块失效函数 -> 后续读请求自动回源到 DB。
 *
 * 关键边界条件与坑点：
 * 1. `getCharacterSect` 仍需先按 characterId 查一次所属 sectId；真正的大查询缓存落在 sectId 维度，避免一份宗门详情按成员重复缓存。
 * 2. 宗门详情包含 `sect_def + sect_member + sect_building` 三部分，任何成员、职位、公告、建筑、资金变更都必须失效同一份详情缓存。
 */

import { query } from '../../config/database.js';
import { createCacheLayer } from '../shared/cacheLayer.js';
import { getMonthCardActiveMapByCharacterIds } from '../shared/monthCardBenefits.js';
import { withBuildingRequirement } from './buildingRequirement.js';
import { toNumber } from './db.js';
import { VISIBLE_PENDING_APPLICATION_CONDITION } from './pendingApplications.js';
import type {
  MySectApplicationListItem,
  SectApplicationListItem,
  SectApplicationRow,
  SectBuildingRow,
  SectDefRow,
  SectInfo,
  SectPosition,
} from './types.js';

interface SectMemberInfoRow {
  character_id: number | string;
  position: SectPosition;
  contribution: number | string;
  weekly_contribution: number | string;
  joined_at: string;
  nickname: string;
  realm: string;
  last_offline_at: string | null;
}

interface SectApplicationWithCharacterRow extends SectApplicationRow {
  nickname: string;
  realm: string;
}

interface MySectApplicationRow {
  id: number;
  sect_id: string;
  message: string | null;
  created_at: string;
  sect_name: string;
  sect_level: number | string;
  member_count: number | string;
  max_members: number | string;
  join_type: 'open' | 'apply' | 'invite';
}

const SECT_INFO_CACHE_REDIS_TTL_SEC = 15;
const SECT_INFO_CACHE_MEMORY_TTL_MS = 3_000;
const SECT_APPLICATIONS_CACHE_REDIS_TTL_SEC = 8;
const SECT_APPLICATIONS_CACHE_MEMORY_TTL_MS = 2_000;
const MY_SECT_APPLICATIONS_CACHE_REDIS_TTL_SEC = 8;
const MY_SECT_APPLICATIONS_CACHE_MEMORY_TTL_MS = 2_000;

const loadSectInfo = async (sectId: string): Promise<SectInfo | null> => {
  const sectRes = await query('SELECT * FROM sect_def WHERE id = $1', [sectId]);
  if (sectRes.rows.length === 0) return null;
  const sect = sectRes.rows[0] as SectDefRow;

  const membersRes = await query<SectMemberInfoRow>(
    `
      SELECT sm.character_id, sm.position, sm.contribution, sm.weekly_contribution, sm.joined_at, c.nickname, c.realm, c.last_offline_at
      FROM sect_member sm
      JOIN characters c ON c.id = sm.character_id
      WHERE sm.sect_id = $1
      ORDER BY
        CASE sm.position
          WHEN 'leader' THEN 5
          WHEN 'vice_leader' THEN 4
          WHEN 'elder' THEN 3
          WHEN 'elite' THEN 2
          ELSE 1
        END DESC,
        sm.joined_at ASC
    `,
    [sectId],
  );

  const buildingsRes = await query<SectBuildingRow>(
    'SELECT * FROM sect_building WHERE sect_id = $1 ORDER BY building_type',
    [sectId],
  );
  const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    membersRes.rows.map((row) => toNumber(row.character_id)),
  );

  return {
    sect,
    members: membersRes.rows.map((row) => ({
      characterId: toNumber(row.character_id),
      nickname: row.nickname,
      monthCardActive: monthCardActiveMap.get(toNumber(row.character_id)) ?? false,
      realm: row.realm,
      position: row.position,
      contribution: toNumber(row.contribution),
      weeklyContribution: toNumber(row.weekly_contribution),
      joinedAt: String(row.joined_at),
      lastOfflineAt: row.last_offline_at ? String(row.last_offline_at) : null,
    })),
    buildings: buildingsRes.rows.map((row) => withBuildingRequirement(row)),
  };
};

const loadSectApplications = async (sectId: string): Promise<SectApplicationListItem[]> => {
  const res = await query<SectApplicationWithCharacterRow>(
    `
      SELECT a.*, c.nickname, c.realm
      FROM sect_application a
      JOIN characters c ON c.id = a.character_id
      WHERE a.sect_id = $1
        AND ${VISIBLE_PENDING_APPLICATION_CONDITION}
      ORDER BY a.created_at ASC
    `,
    [sectId],
  );
  const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    res.rows.map((row) => Number(row.character_id)),
  );
  return res.rows.map((row) => ({
    ...row,
    monthCardActive: monthCardActiveMap.get(Number(row.character_id)) ?? false,
  }));
};

const loadMySectApplications = async (characterId: number): Promise<MySectApplicationListItem[]> => {
  const res = await query<MySectApplicationRow>(
    `
      SELECT
        a.id,
        a.sect_id,
        a.message,
        a.created_at,
        sd.name AS sect_name,
        sd.level AS sect_level,
        sd.member_count,
        sd.max_members,
        sd.join_type
      FROM sect_application a
      JOIN sect_def sd ON sd.id = a.sect_id
      WHERE a.character_id = $1
        AND ${VISIBLE_PENDING_APPLICATION_CONDITION}
      ORDER BY a.created_at DESC
    `,
    [characterId],
  );

  return res.rows.map((row) => ({
    id: Number(row.id),
    sectId: row.sect_id,
    sectName: row.sect_name,
    sectLevel: toNumber(row.sect_level),
    memberCount: toNumber(row.member_count),
    maxMembers: toNumber(row.max_members),
    joinType: row.join_type,
    createdAt: row.created_at,
    message: row.message,
  }));
};

const sectInfoCache = createCacheLayer<string, SectInfo>({
  keyPrefix: 'sect:info:',
  redisTtlSec: SECT_INFO_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: SECT_INFO_CACHE_MEMORY_TTL_MS,
  loader: loadSectInfo,
});

const sectApplicationsCache = createCacheLayer<string, SectApplicationListItem[]>({
  keyPrefix: 'sect:applications:',
  redisTtlSec: SECT_APPLICATIONS_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: SECT_APPLICATIONS_CACHE_MEMORY_TTL_MS,
  loader: loadSectApplications,
});

const mySectApplicationsCache = createCacheLayer<number, MySectApplicationListItem[]>({
  keyPrefix: 'sect:applications:mine:',
  redisTtlSec: MY_SECT_APPLICATIONS_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: MY_SECT_APPLICATIONS_CACHE_MEMORY_TTL_MS,
  loader: loadMySectApplications,
});

export const getCachedSectInfo = async (sectId: string): Promise<SectInfo | null> => {
  return sectInfoCache.get(sectId);
};

export const invalidateSectInfoCache = async (sectId: string): Promise<void> => {
  await sectInfoCache.invalidate(sectId);
};

export const getCachedSectApplications = async (sectId: string): Promise<SectApplicationListItem[]> => {
  const data = await sectApplicationsCache.get(sectId);
  return data ?? [];
};

export const invalidateSectApplicationsCache = async (sectId: string): Promise<void> => {
  await sectApplicationsCache.invalidate(sectId);
};

export const getCachedMySectApplications = async (characterId: number): Promise<MySectApplicationListItem[]> => {
  const data = await mySectApplicationsCache.get(characterId);
  return data ?? [];
};

export const invalidateMySectApplicationsCache = async (characterId: number): Promise<void> => {
  await mySectApplicationsCache.invalidate(characterId);
};

export const invalidateSectApplicationCaches = async (
  sectId: string,
  characterId: number,
): Promise<void> => {
  await Promise.all([
    invalidateSectApplicationsCache(sectId),
    invalidateMySectApplicationsCache(characterId),
  ]);
};

export const invalidateSectApplicationCachesBySectIds = async (
  sectIds: readonly string[],
  characterId: number,
): Promise<void> => {
  const uniqueSectIds = Array.from(new Set(sectIds.map((sectId) => sectId.trim()).filter((sectId) => sectId.length > 0)));
  await Promise.all([
    ...uniqueSectIds.map((sectId) => invalidateSectApplicationsCache(sectId)),
    invalidateMySectApplicationsCache(characterId),
  ]);
};
