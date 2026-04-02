import { query } from '../config/database.js';
import { createCacheLayer } from './shared/cacheLayer.js';
import { getMonthCardActiveMapByCharacterIds } from './shared/monthCardBenefits.js';

const clampLimit = (limit?: number, fallback: number = 50): number => {
  const n = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : fallback;
  return Math.max(1, Math.min(200, n));
};

const normalizePartnerRankMetric = (
  metric: string | null | undefined,
): PartnerRankMetric | null => {
  const normalized = typeof metric === 'string' ? metric.trim().toLowerCase() : '';
  if (normalized === 'level') return 'level';
  if (normalized === 'power') return 'power';
  return null;
};

const RANK_CACHE_REDIS_TTL_SEC = 30;
const RANK_CACHE_MEMORY_TTL_MS = 5_000;

export type RealmRankRow = {
  rank: number;
  characterId: number;
  name: string;
  title: string;
  avatar: string | null;
  monthCardActive: boolean;
  realm: string;
  power: number;
};

export type SectRankRow = {
  rank: number;
  name: string;
  level: number;
  leader: string;
  leaderMonthCardActive: boolean;
  members: number;
  memberCap: number;
  power: number;
};

export type WealthRankRow = {
  rank: number;
  characterId: number;
  name: string;
  title: string;
  avatar: string | null;
  monthCardActive: boolean;
  realm: string;
  spiritStones: number;
  silver: number;
};

export type ArenaRankRow = {
  rank: number;
  characterId: number;
  name: string;
  title: string;
  avatar: string | null;
  monthCardActive: boolean;
  realm: string;
  score: number;
  winCount: number;
  loseCount: number;
};

export type PartnerRankMetric = 'level' | 'power';

export type PartnerRankRow = {
  rank: number;
  partnerId: number;
  characterId: number;
  ownerName: string;
  ownerMonthCardActive: boolean;
  partnerName: string;
  avatar: string | null;
  quality: string;
  element: string;
  role: string;
  level: number;
  power: number;
};

type RealmRankQueryRow = {
  rank: number | string;
  character_id: number | string;
  name: string;
  title: string | null;
  avatar: string | null;
  realm: string;
  power: string | number;
};

type WealthRankQueryRow = {
  rank: number | string;
  character_id: number | string;
  name: string;
  title: string | null;
  avatar: string | null;
  realm: string;
  spiritStones: number | string;
  silver: number | string;
};

type SectRankQueryRow = {
  rank: number | string;
  name: string;
  level: number | string;
  leader_id: number | string | null;
  leader: string;
  members: number | string;
  memberCap: number | string;
  power: number | string;
};

type ArenaRankQueryRow = {
  rank: number | string;
  character_id: number | string;
  name: string;
  title: string | null;
  avatar: string | null;
  realm: string;
  score: number | string;
  winCount: number | string;
  loseCount: number | string;
};

type PartnerRankQueryRow = {
  rank: number | string;
  partner_id: number | string;
  character_id: number | string;
  ownerName: string;
  partnerName: string;
  avatar: string | null;
  quality: string;
  element: string;
  role: string;
  level: number | string;
  power: number | string;
};

const loadRealmRanks = async (limit: number): Promise<RealmRankRow[]> => {
  const res = await query(
    `
      SELECT
        ROW_NUMBER() OVER (ORDER BY realm_rank DESC, power DESC, character_id ASC)::int AS rank,
        crs.character_id,
        crs.nickname AS name,
        c.title,
        c.avatar,
        crs.realm,
        crs.power
      FROM character_rank_snapshot crs
      JOIN characters c ON c.id = crs.character_id
      WHERE crs.nickname <> ''
      ORDER BY rank
      LIMIT $1
    `,
    [limit],
  );

  const rows = res.rows as RealmRankQueryRow[];
  const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    rows.map((row) => Number(row.character_id)),
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    characterId: Number(row.character_id),
    name: String(row.name),
    title: typeof row.title === 'string' ? row.title : '',
    avatar: typeof row.avatar === 'string' && row.avatar.trim().length > 0 ? row.avatar : null,
    monthCardActive: monthCardActiveMap.get(Number(row.character_id)) ?? false,
    realm: String(row.realm),
    power: Number(row.power),
  }));
};

const loadWealthRanks = async (limit: number): Promise<WealthRankRow[]> => {
  const res = await query(
    `
      SELECT
        ROW_NUMBER() OVER (ORDER BY spirit_stones DESC, silver DESC, id ASC)::int AS rank,
        id AS character_id,
        nickname AS name,
        title,
        avatar,
        realm,
        COALESCE(spirit_stones, 0)::int AS "spiritStones",
        COALESCE(silver, 0)::int AS silver
      FROM characters
      WHERE nickname IS NOT NULL AND nickname <> ''
      ORDER BY rank
      LIMIT $1
    `,
    [limit],
  );

  const rows = res.rows as WealthRankQueryRow[];
  const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    rows.map((row) => Number(row.character_id)),
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    characterId: Number(row.character_id),
    name: String(row.name),
    title: typeof row.title === 'string' ? row.title : '',
    avatar: typeof row.avatar === 'string' && row.avatar.trim().length > 0 ? row.avatar : null,
    monthCardActive: monthCardActiveMap.get(Number(row.character_id)) ?? false,
    realm: String(row.realm),
    spiritStones: Number(row.spiritStones),
    silver: Number(row.silver),
  }));
};

const loadSectRanks = async (limit: number): Promise<SectRankRow[]> => {
  const res = await query(
    `
      SELECT
        ROW_NUMBER() OVER (
          ORDER BY sd.level DESC, sd.member_count DESC, COALESCE(sd.reputation, 0) DESC, COALESCE(sd.funds, 0) DESC, sd.created_at ASC
        )::int AS rank,
        sd.name AS name,
        sd.level::int AS level,
        sd.leader_id,
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
    [limit],
  );

  const rows = res.rows as SectRankQueryRow[];
  const leaderMonthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    rows.map((row) => Number(row.leader_id)).filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    name: String(row.name),
    level: Number(row.level),
    leader: String(row.leader),
    leaderMonthCardActive: leaderMonthCardActiveMap.get(Number(row.leader_id)) ?? false,
    members: Number(row.members),
    memberCap: Number(row.memberCap),
    power: Number(row.power),
  }));
};

const loadArenaRanks = async (limit: number): Promise<ArenaRankRow[]> => {
  const res = await query(
    `
      SELECT
        ROW_NUMBER() OVER (ORDER BY score DESC, win_count DESC, lose_count ASC, character_id ASC)::int AS rank,
        character_id,
        name,
        realm,
        score::int,
        win_count::int AS "winCount",
        lose_count::int AS "loseCount"
      FROM (
        SELECT
          c.id AS character_id,
          COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name,
          c.title,
          c.avatar,
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
    [limit],
  );

  const rows = res.rows as ArenaRankQueryRow[];
  const monthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    rows.map((row) => Number(row.character_id)),
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    characterId: Number(row.character_id),
    name: String(row.name),
    title: typeof row.title === 'string' ? row.title : '',
    avatar: typeof row.avatar === 'string' && row.avatar.trim().length > 0 ? row.avatar : null,
    monthCardActive: monthCardActiveMap.get(Number(row.character_id)) ?? false,
    realm: String(row.realm),
    score: Number(row.score),
    winCount: Number(row.winCount),
    loseCount: Number(row.loseCount),
  }));
};

const PARTNER_RANK_ORDER_SQL: Record<PartnerRankMetric, string> = {
  level: 'prs.level DESC, prs.power DESC, prs.partner_id ASC',
  power: 'prs.power DESC, prs.level DESC, prs.partner_id ASC',
};

const loadPartnerRanks = async (
  metric: PartnerRankMetric,
  limit: number,
): Promise<PartnerRankRow[]> => {
  const orderSql = PARTNER_RANK_ORDER_SQL[metric];
  const res = await query(
    `
      SELECT
        ROW_NUMBER() OVER (ORDER BY ${orderSql})::int AS rank,
        prs.partner_id,
        prs.character_id,
        COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS "ownerName",
        prs.partner_name AS "partnerName",
        prs.avatar,
        prs.quality,
        prs.element,
        prs.role,
        prs.level::int AS level,
        prs.power::bigint AS power
      FROM partner_rank_snapshot prs
      JOIN characters c ON c.id = prs.character_id
      ORDER BY rank
      LIMIT $1
    `,
    [limit],
  );

  const rows = res.rows as PartnerRankQueryRow[];
  const ownerMonthCardActiveMap = await getMonthCardActiveMapByCharacterIds(
    rows.map((row) => Number(row.character_id)),
  );

  return rows.map((row) => ({
    rank: Number(row.rank),
    partnerId: Number(row.partner_id),
    characterId: Number(row.character_id),
    ownerName: String(row.ownerName),
    ownerMonthCardActive: ownerMonthCardActiveMap.get(Number(row.character_id)) ?? false,
    partnerName: String(row.partnerName),
    avatar: typeof row.avatar === 'string' && row.avatar.trim().length > 0 ? row.avatar : null,
    quality: String(row.quality),
    element: String(row.element),
    role: String(row.role),
    level: Number(row.level),
    power: Number(row.power),
  }));
};

const realmRankCache = createCacheLayer<number, RealmRankRow[]>({
  keyPrefix: 'rank:realm:',
  redisTtlSec: RANK_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: RANK_CACHE_MEMORY_TTL_MS,
  loader: loadRealmRanks,
});

const wealthRankCache = createCacheLayer<number, WealthRankRow[]>({
  keyPrefix: 'rank:wealth:',
  redisTtlSec: RANK_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: RANK_CACHE_MEMORY_TTL_MS,
  loader: loadWealthRanks,
});

const sectRankCache = createCacheLayer<number, SectRankRow[]>({
  keyPrefix: 'rank:sect:',
  redisTtlSec: RANK_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: RANK_CACHE_MEMORY_TTL_MS,
  loader: loadSectRanks,
});

const arenaRankCache = createCacheLayer<number, ArenaRankRow[]>({
  keyPrefix: 'rank:arena:',
  redisTtlSec: RANK_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: RANK_CACHE_MEMORY_TTL_MS,
  loader: loadArenaRanks,
});

const createPartnerRankCache = (
  metric: PartnerRankMetric,
) => createCacheLayer<number, PartnerRankRow[]>({
  keyPrefix: `rank:partner:${metric}:`,
  redisTtlSec: RANK_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: RANK_CACHE_MEMORY_TTL_MS,
  loader: (limit) => loadPartnerRanks(metric, limit),
});

const partnerRankCaches: Record<PartnerRankMetric, ReturnType<typeof createPartnerRankCache>> = {
  level: createPartnerRankCache('level'),
  power: createPartnerRankCache('power'),
};

export const getRealmRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: RealmRankRow[] }> => {
  const l = clampLimit(limit, 50);
  const data = (await realmRankCache.get(l)) ?? [];
  return { success: true, message: 'ok', data };
};

export const getWealthRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: WealthRankRow[] }> => {
  const l = clampLimit(limit, 50);
  const data = (await wealthRankCache.get(l)) ?? [];
  return { success: true, message: 'ok', data };
};

export const getSectRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: SectRankRow[] }> => {
  const l = clampLimit(limit, 30);
  const data = (await sectRankCache.get(l)) ?? [];
  return { success: true, message: 'ok', data };
};

export const getArenaRanks = async (
  limit?: number
): Promise<{ success: boolean; message: string; data?: ArenaRankRow[] }> => {
  const l = clampLimit(limit, 50);
  const data = (await arenaRankCache.get(l)) ?? [];
  return { success: true, message: 'ok', data };
};

export const getPartnerRanks = async (
  metricRaw: string | null | undefined,
  limit?: number,
): Promise<{ success: boolean; message: string; data?: PartnerRankRow[] }> => {
  const metric = normalizePartnerRankMetric(metricRaw);
  if (!metric) {
    return { success: false, message: '伙伴排行维度不合法' };
  }

  const l = clampLimit(limit, 50);
  const data = (await partnerRankCaches[metric].get(l)) ?? [];
  return { success: true, message: 'ok', data };
};

export const getRankOverview = async (
  limitPlayers?: number,
  limitSects?: number
): Promise<{
  success: boolean;
  message: string;
  data?: { realm: RealmRankRow[]; sect: SectRankRow[]; wealth: WealthRankRow[] };
}> => {
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
};
