import { query } from '../config/database.js';
import { REALM_ORDER } from './shared/realmRules.js';
import { getCharacterComputedBatchByCharacterIds } from './characterComputedService.js';

const clampLimit = (limit?: number, fallback: number = 50): number => {
  const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : fallback;
  return Math.max(1, Math.min(200, n));
};

const REALM_RANK_MAP = new Map<string, number>(REALM_ORDER.map((r, idx) => [r, idx]));

const getRealmRank = (realmRaw: unknown): number => {
  const realm = String(realmRaw || '').trim();
  return REALM_RANK_MAP.get(realm) ?? 0;
};

const computePower = (row: {
  wugong?: number;
  fagong?: number;
  wufang?: number;
  fafang?: number;
  max_qixue?: number;
  max_lingqi?: number;
  sudu?: number;
}): number => {
  return (
    (Number(row.wugong ?? 0) || 0)
    + (Number(row.fagong ?? 0) || 0)
    + (Number(row.wufang ?? 0) || 0)
    + (Number(row.fafang ?? 0) || 0)
    + (Number(row.max_qixue ?? 0) || 0)
    + (Number(row.max_lingqi ?? 0) || 0)
    + (Number(row.sudu ?? 0) || 0)
  );
};

export type RealmRankRow = {
  rank: number;
  name: string;
  realm: string;
  power: number;
};

export type SectRankRow = {
  rank: number;
  name: string;
  level: number;
  leader: string;
  members: number;
  memberCap: number;
  power: number;
};

export type WealthRankRow = {
  rank: number;
  name: string;
  realm: string;
  spiritStones: number;
  silver: number;
};

export type ArenaRankRow = {
  rank: number;
  name: string;
  realm: string;
  score: number;
  winCount: number;
  loseCount: number;
};

export const getRealmRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: RealmRankRow[] }> => {
  const l = clampLimit(limit, 50);
  try {
    const res = await query(
      `
        SELECT id, nickname, realm
        FROM characters
        WHERE nickname IS NOT NULL AND nickname <> ''
      `,
      []
    );

    const ids = res.rows
      .map((row) => Number((row as Record<string, unknown>).id))
      .filter((id) => Number.isFinite(id) && id > 0);
    const computedMap = await getCharacterComputedBatchByCharacterIds(ids);

    const rows = res.rows.map((row) => {
      const record = row as Record<string, unknown>;
      const id = Number(record.id);
      const computed = computedMap.get(id);
      const power = computed ? Math.max(0, computePower(computed)) : 0;
      return {
        id,
        name: String(record.nickname ?? ''),
        realm: String(record.realm ?? '凡人'),
        power,
        realmRank: getRealmRank(record.realm),
      };
    });

    rows.sort((a, b) => {
      if (a.realmRank !== b.realmRank) return b.realmRank - a.realmRank;
      if (a.power !== b.power) return b.power - a.power;
      return a.id - b.id;
    });

    const data: RealmRankRow[] = rows.slice(0, l).map((row, index) => ({
      rank: index + 1,
      name: row.name,
      realm: row.realm,
      power: row.power,
    }));
    return { success: true, message: 'ok', data };
  } catch (error) {
    console.error('获取境界排行榜失败:', error);
    return { success: false, message: '获取境界排行榜失败' };
  }
};

export const getWealthRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: WealthRankRow[] }> => {
  const l = clampLimit(limit, 50);
  try {
    const res = await query(
      `
        SELECT
          ROW_NUMBER() OVER (ORDER BY spirit_stones DESC, silver DESC, id ASC)::int AS rank,
          nickname AS name,
          realm,
          COALESCE(spirit_stones, 0)::int AS "spiritStones",
          COALESCE(silver, 0)::int AS silver
        FROM characters
        WHERE nickname IS NOT NULL AND nickname <> ''
        ORDER BY rank
        LIMIT $1
      `,
      [l]
    );

    return { success: true, message: 'ok', data: res.rows as any };
  } catch (error) {
    console.error('获取财富排行榜失败:', error);
    return { success: false, message: '获取财富排行榜失败' };
  }
};

export const getSectRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: SectRankRow[] }> => {
  const l = clampLimit(limit, 30);
  try {
    const res = await query(
      `
        SELECT
          ROW_NUMBER() OVER (
            ORDER BY sd.level DESC, sd.member_count DESC, COALESCE(sd.reputation, 0) DESC, COALESCE(sd.funds, 0) DESC, sd.created_at ASC
          )::int AS rank,
          sd.name AS name,
          sd.level::int AS level,
          COALESCE(c.nickname, '—') AS leader,
          sd.member_count::int AS members,
          sd.max_members::int AS "memberCap",
          (
            sd.level::bigint * 100000
            + sd.member_count::bigint * 1000
            + COALESCE(sd.reputation, 0)::bigint
            + (COALESCE(sd.funds, 0)::bigint / 10)
          )::bigint AS power
        FROM sect_def sd
        LEFT JOIN characters c ON c.id = sd.leader_id
        ORDER BY rank
        LIMIT $1
      `,
      [l]
    );

    return { success: true, message: 'ok', data: res.rows as any };
  } catch (error) {
    console.error('获取宗门排行榜失败:', error);
    return { success: false, message: '获取宗门排行榜失败' };
  }
};

export const getArenaRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: ArenaRankRow[] }> => {
  const l = clampLimit(limit, 50);
  try {
    const res = await query(
      `
        SELECT
          ROW_NUMBER() OVER (ORDER BY score DESC, win_count DESC, lose_count ASC, id ASC)::int AS rank,
          name,
          realm,
          score::int,
          win_count::int AS "winCount",
          lose_count::int AS "loseCount"
        FROM (
          SELECT
            c.id,
            COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name,
            c.realm,
            COALESCE(ar.rating, 1000)::int AS score,
            COALESCE(ar.win_count, 0)::int AS win_count,
            COALESCE(ar.lose_count, 0)::int AS lose_count
          FROM characters c
          LEFT JOIN arena_rating ar ON ar.character_id = c.id
        ) t
        ORDER BY rank
        LIMIT $1
      `,
      [l]
    );
    return { success: true, message: 'ok', data: res.rows as any };
  } catch (error) {
    console.error('获取竞技场排行榜失败:', error);
    return { success: false, message: '获取竞技场排行榜失败' };
  }
};

export const getRankOverview = async (
  limitPlayers?: number,
  limitSects?: number
): Promise<{
  success: boolean;
  message: string;
  data?: { realm: RealmRankRow[]; sect: SectRankRow[]; wealth: WealthRankRow[] };
}> => {
  try {
    const [realmRes, sectRes, wealthRes] = await Promise.all([
      getRealmRanks(limitPlayers),
      getSectRanks(limitSects),
      getWealthRanks(limitPlayers),
    ]);

    if (!realmRes.success) return { success: false, message: realmRes.message };
    if (!sectRes.success) return { success: false, message: sectRes.message };
    if (!wealthRes.success) return { success: false, message: wealthRes.message };

    return {
      success: true,
      message: 'ok',
      data: {
        realm: realmRes.data ?? [],
        sect: sectRes.data ?? [],
        wealth: wealthRes.data ?? [],
      },
    };
  } catch (error) {
    console.error('获取排行榜总览失败:', error);
    return { success: false, message: '获取排行榜总览失败' };
  }
};
