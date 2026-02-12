import { pool, query } from '../config/database.js';
import crypto from 'crypto';
import { getBattleState, startDungeonPVEBattle } from './battleService.js';
import { createItem, type CreateItemOptions } from './itemService.js';
import { sendSystemMail, type MailAttachItem } from './mailService.js';
import { recordDungeonClearEvent } from './taskService.js';
import { applyStaminaRecoveryTx, STAMINA_MAX } from './staminaService.js';
import type { PoolClient } from 'pg';

export type DungeonType = 'material' | 'equipment' | 'trial' | 'challenge' | 'event';

export type DungeonCategoryDto = {
  type: DungeonType;
  label: string;
  count: number;
};

export type DungeonWeeklyTargetDto = {
  id: string;
  title: string;
  description: string;
  target: number;
  current: number;
  done: boolean;
  progress: number;
};

export type DungeonDefDto = {
  id: string;
  name: string;
  type: DungeonType;
  category: string | null;
  description: string | null;
  icon: string | null;
  background: string | null;
  min_players: number;
  max_players: number;
  min_realm: string | null;
  recommended_realm: string | null;
  unlock_condition: unknown;
  daily_limit: number;
  weekly_limit: number;
  stamina_cost: number;
  time_limit_sec: number;
  revive_limit: number;
  tags: unknown;
  sort_weight: number;
  enabled: boolean;
  version: number;
};

type DungeonDifficultyRow = {
  id: string;
  dungeon_id: string;
  name: string;
  difficulty_rank: number;
  monster_level_add: number;
  monster_attr_mult: string | number;
  reward_mult: string | number;
  min_realm: string | null;
  unlock_prev_difficulty: boolean;
  first_clear_rewards: unknown;
  drop_pool_id: string | null;
  enabled: boolean;
};

type DungeonStageRow = {
  id: string;
  difficulty_id: string;
  stage_index: number;
  name: string | null;
  type: string;
  description: string | null;
  time_limit_sec: number;
  clear_condition: unknown;
  fail_condition: unknown;
  stage_rewards: unknown;
  events: unknown;
};

type DungeonWaveRow = {
  id: number;
  stage_id: string;
  wave_index: number;
  spawn_delay_sec: number;
  monsters: unknown;
  wave_rewards: unknown;
};

type MonsterLiteRow = {
  id: string;
  name: string;
  realm: string | null;
  level: number;
  avatar: string | null;
  kind: string | null;
  drop_pool_id?: string | null;
};

type ItemLiteRow = {
  id: string;
  name: string;
  quality: string | null;
  icon: string | null;
};

const DUNGEON_TYPE_LABEL: Record<DungeonType, string> = {
  material: '材料秘境',
  equipment: '装备秘境',
  trial: '试炼秘境',
  challenge: '挑战秘境',
  event: '活动秘境',
};

const toDungeonType = (v: unknown): DungeonType | null => {
  if (v === 'material' || v === 'equipment' || v === 'trial' || v === 'challenge' || v === 'event') return v;
  return null;
};

const asObject = (v: unknown): Record<string, unknown> | null => {
  if (!v) return null;
  if (typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
};

const asArray = (v: unknown): unknown[] => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const asNumber = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};

const REALM_ORDER = [
  '凡人',
  '炼精化炁·养气期',
  '炼精化炁·通脉期',
  '炼精化炁·凝炁期',
  '炼炁化神·炼己期',
  '炼炁化神·采药期',
  '炼炁化神·结胎期',
  '炼神返虚·养神期',
  '炼神返虚·还虚期',
  '炼神返虚·合道期',
  '炼虚合道·证道期',
  '炼虚合道·历劫期',
  '炼虚合道·成圣期',
];

const getRealmRank = (realm: string): number => {
  const idx = REALM_ORDER.indexOf(realm);
  return idx >= 0 ? idx : 0;
};

const isRealmSufficient = (characterRealm: string, minRealm: string): boolean => {
  return getRealmRank(characterRealm) >= getRealmRank(minRealm);
};

const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  const res = await query(`SELECT id FROM characters WHERE user_id = $1 LIMIT 1`, [userId]);
  if (res.rows.length === 0) return null;
  const id = Number(res.rows[0]?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
};

const getDungeonEntryRemaining = async (
  characterId: number,
  dungeonId: string,
  dailyLimit: number,
  weeklyLimit: number
): Promise<{
  daily_limit: number;
  weekly_limit: number;
  daily_used: number;
  weekly_used: number;
  daily_remaining: number | null;
  weekly_remaining: number | null;
}> => {
  const res = await query(
    `SELECT daily_count, weekly_count, last_daily_reset, last_weekly_reset FROM dungeon_entry_count WHERE character_id = $1 AND dungeon_id = $2 LIMIT 1`,
    [characterId, dungeonId]
  );
  const row = (res.rows[0] ?? null) as Record<string, unknown> | null;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const day = row?.last_daily_reset instanceof Date ? row.last_daily_reset.toISOString().slice(0, 10) : String(row?.last_daily_reset ?? '');
  const dailyUsed = day === todayStr ? asNumber(row?.daily_count, 0) : 0;

  const weekStart = new Date(today);
  const weekday = weekStart.getDay();
  const diffToMonday = (weekday + 6) % 7;
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  const lastWeekResetStr =
    row?.last_weekly_reset instanceof Date ? row.last_weekly_reset.toISOString().slice(0, 10) : String(row?.last_weekly_reset ?? '');
  const weeklyUsed = lastWeekResetStr && lastWeekResetStr >= weekStartStr ? asNumber(row?.weekly_count, 0) : 0;

  return {
    daily_limit: dailyLimit,
    weekly_limit: weeklyLimit,
    daily_used: dailyUsed,
    weekly_used: weeklyUsed,
    daily_remaining: dailyLimit > 0 ? Math.max(0, dailyLimit - dailyUsed) : null,
    weekly_remaining: weeklyLimit > 0 ? Math.max(0, weeklyLimit - weeklyUsed) : null,
  };
};

export const getDungeonCategories = async (): Promise<DungeonCategoryDto[]> => {
  const result = await query(
    `
      SELECT type, COUNT(1)::int AS count
      FROM dungeon_def
      WHERE enabled = true
      GROUP BY type
      ORDER BY COUNT(1) DESC, type ASC
    `
  );

  const categories: DungeonCategoryDto[] = [];
  for (const r of result.rows as Array<{ type: unknown; count: unknown }>) {
    const type = toDungeonType(r.type);
    if (!type) continue;
    categories.push({ type, label: DUNGEON_TYPE_LABEL[type], count: asNumber(r.count, 0) });
  }

  for (const t of Object.keys(DUNGEON_TYPE_LABEL) as DungeonType[]) {
    if (!categories.some((c) => c.type === t)) {
      categories.push({ type: t, label: DUNGEON_TYPE_LABEL[t], count: 0 });
    }
  }

  return categories;
};

export const getDungeonWeeklyTargets = async (
  userId: number
): Promise<
  | {
      success: true;
      data: {
        period: { weekStart: string; weekEnd: string };
        summary: { totalClears: number; targetClears: number };
        targets: DungeonWeeklyTargetDto[];
      };
    }
  | { success: false; message: string }
> => {
  try {
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return { success: false, message: '角色不存在' };

    const countRes = await query(
      `
        SELECT
          COUNT(1)::int AS total,
          COUNT(1) FILTER (WHERE dd.type = 'trial')::int AS trial,
          COUNT(1) FILTER (WHERE dd.type = 'material')::int AS material,
          COUNT(1) FILTER (WHERE dd.type = 'equipment')::int AS equipment,
          COUNT(1) FILTER (WHERE COALESCE(dr.is_first_clear, false) = true)::int AS first_clear
        FROM dungeon_record dr
        JOIN dungeon_def dd ON dd.id = dr.dungeon_id
        WHERE dr.character_id = $1
          AND dr.result = 'cleared'
          AND dr.completed_at >= date_trunc('week', NOW())
          AND dr.completed_at < date_trunc('week', NOW()) + interval '7 day'
      `,
      [characterId]
    );

    const row = (countRes.rows?.[0] ?? {}) as Record<string, unknown>;
    const total = asNumber(row.total, 0);
    const trial = asNumber(row.trial, 0);
    const material = asNumber(row.material, 0);
    const equipment = asNumber(row.equipment, 0);
    const firstClear = asNumber(row.first_clear, 0);

    const toProgress = (current: number, target: number): number => {
      if (target <= 0) return 100;
      return Math.max(0, Math.min(100, Math.floor((current / target) * 100)));
    };

    const targets: DungeonWeeklyTargetDto[] = [
      {
        id: 'weekly-clear-total',
        title: '本周秘境历练',
        description: '通关任意秘境',
        target: 7,
        current: total,
        done: total >= 7,
        progress: toProgress(total, 7),
      },
      {
        id: 'weekly-clear-trial',
        title: '试炼专项',
        description: '通关试炼秘境',
        target: 3,
        current: trial,
        done: trial >= 3,
        progress: toProgress(trial, 3),
      },
      {
        id: 'weekly-clear-material',
        title: '材料储备',
        description: '通关材料秘境',
        target: 3,
        current: material,
        done: material >= 3,
        progress: toProgress(material, 3),
      },
      {
        id: 'weekly-clear-equipment',
        title: '装备搜集',
        description: '通关装备秘境',
        target: 2,
        current: equipment,
        done: equipment >= 2,
        progress: toProgress(equipment, 2),
      },
      {
        id: 'weekly-first-clear',
        title: '首通挑战',
        description: '完成本周首通记录',
        target: 1,
        current: firstClear,
        done: firstClear >= 1,
        progress: toProgress(firstClear, 1),
      },
    ];

    const weekRes = await query(
      `
        SELECT
          date_trunc('week', NOW())::date AS week_start,
          (date_trunc('week', NOW())::date + 6)::date AS week_end
      `
    );
    const weekRow = (weekRes.rows?.[0] ?? {}) as Record<string, unknown>;
    const weekStart =
      weekRow.week_start instanceof Date
        ? weekRow.week_start.toISOString().slice(0, 10)
        : String(weekRow.week_start ?? '');
    const weekEnd =
      weekRow.week_end instanceof Date
        ? weekRow.week_end.toISOString().slice(0, 10)
        : String(weekRow.week_end ?? '');

    return {
      success: true,
      data: {
        period: { weekStart, weekEnd },
        summary: { totalClears: total, targetClears: 7 },
        targets,
      },
    };
  } catch (error) {
    console.error('获取秘境周目标失败:', error);
    return { success: false, message: '获取秘境周目标失败' };
  }
};

export const getDungeonList = async (params: {
  type?: DungeonType;
  q?: string;
  realm?: string;
}): Promise<DungeonDefDto[]> => {
  const where: string[] = ['enabled = true'];
  const args: unknown[] = [];

  if (params.type) {
    args.push(params.type);
    where.push(`type = $${args.length}`);
  }

  if (params.q) {
    args.push(`%${params.q}%`);
    where.push(`(name ILIKE $${args.length} OR COALESCE(category,'') ILIKE $${args.length})`);
  }

  const result = await query(
    `
      SELECT
        id, name, type, category, description, icon, background,
        min_players, max_players, min_realm, recommended_realm, unlock_condition,
        daily_limit, weekly_limit, stamina_cost, time_limit_sec, revive_limit,
        tags, sort_weight, enabled, version
      FROM dungeon_def
      WHERE ${where.join(' AND ')}
      ORDER BY sort_weight DESC, id ASC
    `,
    args
  );

  const list: DungeonDefDto[] = [];
  for (const r of result.rows as Array<Record<string, unknown>>) {
    const type = toDungeonType(r.type);
    if (!type) continue;
    const minRealm = typeof r.min_realm === 'string' ? r.min_realm : null;
    if (params.realm && minRealm && !isRealmSufficient(params.realm, minRealm)) continue;
    list.push({
      id: String(r.id),
      name: String(r.name),
      type,
      category: typeof r.category === 'string' ? r.category : null,
      description: typeof r.description === 'string' ? r.description : null,
      icon: typeof r.icon === 'string' ? r.icon : null,
      background: typeof r.background === 'string' ? r.background : null,
      min_players: asNumber(r.min_players, 1),
      max_players: asNumber(r.max_players, 4),
      min_realm: minRealm,
      recommended_realm: typeof r.recommended_realm === 'string' ? r.recommended_realm : null,
      unlock_condition: r.unlock_condition ?? {},
      daily_limit: asNumber(r.daily_limit, 0),
      weekly_limit: asNumber(r.weekly_limit, 0),
      stamina_cost: asNumber(r.stamina_cost, 0),
      time_limit_sec: asNumber(r.time_limit_sec, 0),
      revive_limit: asNumber(r.revive_limit, 0),
      tags: r.tags ?? [],
      sort_weight: asNumber(r.sort_weight, 0),
      enabled: Boolean(r.enabled),
      version: asNumber(r.version, 1),
    });
  }

  return list;
};

export const getDungeonPreview = async (
  dungeonId: string,
  difficultyRank: number = 1,
  userId?: number
): Promise<{
  dungeon: DungeonDefDto | null;
  difficulty: Pick<DungeonDifficultyRow, 'id' | 'name' | 'difficulty_rank'> | null;
  entry: {
    daily_limit: number;
    weekly_limit: number;
    daily_used: number;
    weekly_used: number;
    daily_remaining: number | null;
    weekly_remaining: number | null;
  } | null;
  stages: Array<
    Pick<DungeonStageRow, 'id' | 'stage_index' | 'name' | 'type'> & {
      waves: Array<{
        wave_index: number;
        spawn_delay_sec: number;
        monsters: Array<{
          id: string;
          name: string;
          realm: string | null;
          level: number;
          avatar: string | null;
          kind: string | null;
          count: number;
          drop_pool_id: string | null;
          drop_preview: Array<{
            item: { id: string; name: string; quality: string | null; icon: string | null };
            mode: 'prob' | 'weight';
            chance: number | null;
            weight: number | null;
            qty_min: number;
            qty_max: number;
            quality_weights: Record<string, unknown> | null;
            bind_type: string | null;
          }>;
        }>;
      }>;
    }
  >;
  monsters: MonsterLiteRow[];
  drops: Array<{ id: string; name: string; quality: string | null; icon: string | null; from: string }>;
} | null> => {
  const defRes = await query(
    `
      SELECT
        id, name, type, category, description, icon, background,
        min_players, max_players, min_realm, recommended_realm, unlock_condition,
        daily_limit, weekly_limit, stamina_cost, time_limit_sec, revive_limit,
        tags, sort_weight, enabled, version
      FROM dungeon_def
      WHERE id = $1 AND enabled = true
      LIMIT 1
    `,
    [dungeonId]
  );

  const defRow = (defRes.rows[0] ?? null) as Record<string, unknown> | null;
  if (!defRow) return null;
  const type = toDungeonType(defRow.type);
  if (!type) return null;

  const dungeon: DungeonDefDto = {
    id: String(defRow.id),
    name: String(defRow.name),
    type,
    category: typeof defRow.category === 'string' ? defRow.category : null,
    description: typeof defRow.description === 'string' ? defRow.description : null,
    icon: typeof defRow.icon === 'string' ? defRow.icon : null,
    background: typeof defRow.background === 'string' ? defRow.background : null,
    min_players: asNumber(defRow.min_players, 1),
    max_players: asNumber(defRow.max_players, 4),
    min_realm: typeof defRow.min_realm === 'string' ? defRow.min_realm : null,
    recommended_realm: typeof defRow.recommended_realm === 'string' ? defRow.recommended_realm : null,
    unlock_condition: defRow.unlock_condition ?? {},
    daily_limit: asNumber(defRow.daily_limit, 0),
    weekly_limit: asNumber(defRow.weekly_limit, 0),
    stamina_cost: asNumber(defRow.stamina_cost, 0),
    time_limit_sec: asNumber(defRow.time_limit_sec, 0),
    revive_limit: asNumber(defRow.revive_limit, 0),
    tags: defRow.tags ?? [],
    sort_weight: asNumber(defRow.sort_weight, 0),
    enabled: Boolean(defRow.enabled),
    version: asNumber(defRow.version, 1),
  };

  const entry =
    typeof userId === 'number' && Number.isFinite(userId)
      ? await (async () => {
          const characterId = await getCharacterIdByUserId(userId);
          if (!characterId) return null;
          return getDungeonEntryRemaining(characterId, dungeonId, dungeon.daily_limit, dungeon.weekly_limit);
        })()
      : null;

  const diffRes = await query(
    `
      SELECT id, dungeon_id, name, difficulty_rank, monster_level_add, monster_attr_mult, reward_mult,
             min_realm, unlock_prev_difficulty, first_clear_rewards, drop_pool_id, enabled
      FROM dungeon_difficulty
      WHERE dungeon_id = $1 AND enabled = true AND difficulty_rank = $2
      LIMIT 1
    `,
    [dungeonId, difficultyRank]
  );
  const diffRow = (diffRes.rows[0] ?? null) as DungeonDifficultyRow | null;
  if (!diffRow) {
    return { dungeon, difficulty: null, entry, stages: [], monsters: [], drops: [] };
  }

  const stageRes = await query(
    `
      SELECT id, difficulty_id, stage_index, name, type, description, time_limit_sec, clear_condition, fail_condition, stage_rewards, events
      FROM dungeon_stage
      WHERE difficulty_id = $1
      ORDER BY stage_index ASC
    `,
    [diffRow.id]
  );
  const stages = stageRes.rows as DungeonStageRow[];

  const stageIds = stages.map((s) => s.id);
  const waveRes =
    stageIds.length === 0
      ? { rows: [] as DungeonWaveRow[] }
      : await query(
          `
            SELECT id, stage_id, wave_index, spawn_delay_sec, monsters, wave_rewards
            FROM dungeon_wave
            WHERE stage_id = ANY($1)
            ORDER BY stage_id ASC, wave_index ASC
          `,
          [stageIds]
        );
  const waves = waveRes.rows as DungeonWaveRow[];

  const monsterIdSet = new Set<string>();
  for (const w of waves) {
    for (const m of asArray(w.monsters)) {
      const obj = asObject(m);
      const monsterId = obj?.monster_def_id;
      if (typeof monsterId === 'string' && monsterId) monsterIdSet.add(monsterId);
    }
  }
  const monsterIds = Array.from(monsterIdSet);

  const monstersRes =
    monsterIds.length === 0
      ? { rows: [] as MonsterLiteRow[] }
      : await query(
          `
            SELECT id, name, realm, level, avatar, kind, drop_pool_id
            FROM monster_def
            WHERE enabled = true AND id = ANY($1)
            ORDER BY level ASC, id ASC
          `,
          [monsterIds]
        );
  const monsters = monstersRes.rows as MonsterLiteRow[];

  const stageNameById = new Map(stages.map((s) => [s.id, s.name ?? `第${s.stage_index}关`]));
  const monsterById = new Map(monsters.map((m) => [m.id, m]));

  const monsterDropPoolIds: string[] = [];
  const monsterDropPoolIdSet = new Set<string>();
  for (const m of monsters) {
    const poolId = typeof m.drop_pool_id === 'string' ? m.drop_pool_id : null;
    if (!poolId) continue;
    if (monsterDropPoolIdSet.has(poolId)) continue;
    monsterDropPoolIdSet.add(poolId);
    monsterDropPoolIds.push(poolId);
  }

  type DropPreviewRow = {
    drop_pool_id: string;
    mode: string;
    item_def_id: string;
    chance: unknown;
    weight: unknown;
    qty_min: unknown;
    qty_max: unknown;
    quality_weights: unknown;
    bind_type: unknown;
    name: string;
    quality: string | null;
    icon: string | null;
  };

  const dropPreviewRes =
    monsterDropPoolIds.length === 0
      ? { rows: [] as DropPreviewRow[] }
      : await query(
          `
            SELECT
              dp.id AS drop_pool_id,
              dp.mode,
              dpe.item_def_id,
              dpe.chance,
              dpe.weight,
              dpe.qty_min,
              dpe.qty_max,
              dpe.quality_weights,
              dpe.bind_type,
              it.name,
              it.quality,
              it.icon
            FROM drop_pool dp
            JOIN drop_pool_entry dpe ON dpe.drop_pool_id = dp.id
            JOIN item_def it ON it.id = dpe.item_def_id
            WHERE dp.enabled = true
              AND dpe.show_in_ui = true
              AND it.enabled = true
              AND dp.id = ANY($1)
            ORDER BY dp.id ASC, dpe.sort_order ASC, dpe.id ASC
          `,
          [monsterDropPoolIds]
        );

  const dropPreviewByPoolId = new Map<
    string,
    Array<{
      item: { id: string; name: string; quality: string | null; icon: string | null };
      mode: 'prob' | 'weight';
      chance: number | null;
      weight: number | null;
      qty_min: number;
      qty_max: number;
      quality_weights: Record<string, unknown> | null;
      bind_type: string | null;
    }>
  >();

  for (const r of dropPreviewRes.rows as unknown as DropPreviewRow[]) {
    const poolId = String((r as Record<string, unknown>).drop_pool_id || '');
    if (!poolId) continue;
    const mode = r.mode === 'weight' ? 'weight' : 'prob';
    const chanceNum = mode === 'prob' ? asNumber(r.chance, 0) : null;
    const weightNum = mode === 'weight' ? asNumber(r.weight, 0) : null;
    const qtyMin = Math.max(1, Math.floor(asNumber(r.qty_min, 1)));
    const qtyMax = Math.max(qtyMin, Math.floor(asNumber(r.qty_max, qtyMin)));
    const list = dropPreviewByPoolId.get(poolId) ?? [];
    list.push({
      item: { id: r.item_def_id, name: r.name, quality: r.quality ?? null, icon: r.icon ?? null },
      mode,
      chance: chanceNum,
      weight: weightNum,
      qty_min: qtyMin,
      qty_max: qtyMax,
      quality_weights: asObject(r.quality_weights),
      bind_type: typeof r.bind_type === 'string' ? r.bind_type : null,
    });
    dropPreviewByPoolId.set(poolId, list);
  }

  const wavesByStageId = new Map<string, DungeonWaveRow[]>();
  for (const w of waves) {
    const sid = asString(w.stage_id, '');
    if (!sid) continue;
    const list = wavesByStageId.get(sid) ?? [];
    list.push(w);
    wavesByStageId.set(sid, list);
  }

  const stagesWithWaves = stages.map((s) => {
    const stageWaves = wavesByStageId.get(s.id) ?? [];
    return {
      id: s.id,
      stage_index: s.stage_index,
      name: s.name,
      type: s.type,
      waves: stageWaves.map((w) => {
        const waveIndex = asNumber(w.wave_index, 1);
        const spawnDelaySec = asNumber(w.spawn_delay_sec, 0);
        const waveMonsters: Array<{
          id: string;
          name: string;
          realm: string | null;
          level: number;
          avatar: string | null;
          kind: string | null;
          count: number;
          drop_pool_id: string | null;
          drop_preview: Array<{
            item: { id: string; name: string; quality: string | null; icon: string | null };
            mode: 'prob' | 'weight';
            chance: number | null;
            weight: number | null;
            qty_min: number;
            qty_max: number;
            quality_weights: Record<string, unknown> | null;
            bind_type: string | null;
          }>;
        }> = [];

        for (const m of asArray(w.monsters)) {
          const obj = asObject(m);
          if (!obj) continue;
          const monsterId = asString(obj.monster_def_id, '');
          if (!monsterId) continue;
          const count = Math.max(1, Math.floor(asNumber(obj.count, 1)));
          const monster = monsterById.get(monsterId) ?? null;
          const poolId = monster && typeof monster.drop_pool_id === 'string' ? monster.drop_pool_id : null;
          waveMonsters.push({
            id: monsterId,
            name: monster?.name ?? monsterId,
            realm: monster?.realm ?? null,
            level: asNumber(monster?.level, 1),
            avatar: monster?.avatar ?? null,
            kind: monster?.kind ?? null,
            count,
            drop_pool_id: poolId,
            drop_preview: poolId ? dropPreviewByPoolId.get(poolId) ?? [] : [],
          });
        }

        return {
          wave_index: waveIndex,
          spawn_delay_sec: spawnDelaySec,
          monsters: waveMonsters,
        };
      }),
    };
  });

  const dropItems: Array<{ item_def_id: string; from: string }> = [];
  const firstClear = asObject(diffRow.first_clear_rewards);
  for (const it of asArray(firstClear?.items)) {
    const obj = asObject(it);
    const itemDefId = obj?.item_def_id;
    if (typeof itemDefId === 'string' && itemDefId) {
      dropItems.push({ item_def_id: itemDefId, from: `${diffRow.name}·首通` });
    }
  }

  for (const s of stages) {
    const sr = asObject(s.stage_rewards);
    for (const it of asArray(sr?.items)) {
      const obj = asObject(it);
      const itemDefId = obj?.item_def_id;
      if (typeof itemDefId === 'string' && itemDefId) {
        dropItems.push({ item_def_id: itemDefId, from: stageNameById.get(s.id) ?? '关卡奖励' });
      }
    }
  }

  const dropIdSet = new Set<string>();
  const itemIds: string[] = [];
  for (const d of dropItems) {
    if (dropIdSet.has(d.item_def_id)) continue;
    dropIdSet.add(d.item_def_id);
    itemIds.push(d.item_def_id);
  }

  const itemRes =
    itemIds.length === 0
      ? { rows: [] as ItemLiteRow[] }
      : await query(
          `
            SELECT id, name, quality, icon
            FROM item_def
            WHERE enabled = true AND id = ANY($1)
            ORDER BY id ASC
          `,
          [itemIds]
        );
  const itemMap = new Map((itemRes.rows as ItemLiteRow[]).map((r) => [r.id, r]));

  const drops = dropItems
    .map((d) => {
      const it = itemMap.get(d.item_def_id);
      if (!it) return null;
      return { id: it.id, name: it.name, quality: it.quality ?? null, icon: it.icon ?? null, from: d.from };
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return {
    dungeon,
    difficulty: { id: diffRow.id, name: diffRow.name, difficulty_rank: diffRow.difficulty_rank },
    entry,
    stages: stagesWithWaves,
    monsters,
    drops,
  };
};

type DungeonInstanceStatus = 'preparing' | 'running' | 'cleared' | 'failed' | 'abandoned';

type DungeonInstanceParticipant = {
  userId: number;
  characterId: number;
  role: 'leader' | 'member';
};

type DungeonInstanceRow = {
  id: string;
  dungeon_id: string;
  difficulty_id: string;
  creator_id: number;
  team_id: string | null;
  status: DungeonInstanceStatus;
  current_stage: number;
  current_wave: number;
  participants: unknown;
  start_time: string | null;
  end_time: string | null;
  time_spent_sec: number;
  total_damage: number;
  death_count: number;
  rewards_claimed: boolean;
  instance_data: unknown;
  created_at: string;
};

const asString = (v: unknown, fallback: string = ''): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return fallback;
};

const parseParticipants = (v: unknown): DungeonInstanceParticipant[] => {
  const arr = asArray(v);
  const list: DungeonInstanceParticipant[] = [];
  for (const it of arr) {
    const obj = asObject(it);
    if (!obj) continue;
    const userId = Number(obj.userId);
    const characterId = Number(obj.characterId);
    const role = obj.role === 'leader' ? 'leader' : obj.role === 'member' ? 'member' : null;
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!role) continue;
    list.push({ userId, characterId, role });
  }
  const uniq = new Map<number, DungeonInstanceParticipant>();
  for (const p of list) uniq.set(p.userId, p);
  return Array.from(uniq.values());
};

const getFullRealm = (realm: string, subRealm: string | null): string => {
  if (!subRealm || realm === '凡人') return realm;
  return `${realm}·${subRealm}`;
};

const getUserAndCharacter = async (
  userId: number
): Promise<
  | { ok: true; userId: number; characterId: number; realm: string; teamId: string | null; isLeader: boolean }
  | { ok: false; message: string }
> => {
  const charRes = await query(`SELECT id, realm, sub_realm FROM characters WHERE user_id = $1 LIMIT 1`, [userId]);
  if (charRes.rows.length === 0) return { ok: false, message: '角色不存在' };
  const characterId = Number(charRes.rows[0]?.id);
  if (!Number.isFinite(characterId) || characterId <= 0) return { ok: false, message: '角色不存在' };
  const realm = getFullRealm(String(charRes.rows[0]?.realm || '凡人'), (charRes.rows[0]?.sub_realm ?? null) as string | null);

  const memberRes = await query(`SELECT team_id, role FROM team_members WHERE character_id = $1 LIMIT 1`, [characterId]);
  const teamId = memberRes.rows.length > 0 ? asString(memberRes.rows[0]?.team_id, '') : '';
  const role = memberRes.rows.length > 0 ? asString(memberRes.rows[0]?.role, '') : '';
  return { ok: true, userId, characterId, realm, teamId: teamId || null, isLeader: role === 'leader' };
};

const getTeamParticipants = async (teamId: string): Promise<DungeonInstanceParticipant[]> => {
  const res = await query(
    `
      SELECT c.user_id, c.id AS character_id, tm.role
      FROM team_members tm
      JOIN characters c ON c.id = tm.character_id
      WHERE tm.team_id = $1
      ORDER BY tm.role DESC, tm.joined_at ASC
    `,
    [teamId]
  );
  const list: DungeonInstanceParticipant[] = [];
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const userId = Number(row.user_id);
    const characterId = Number(row.character_id);
    const role = row.role === 'leader' ? 'leader' : 'member';
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    list.push({ userId, characterId, role });
  }
  return list;
};

const buildMonsterDefIdsFromWave = (monstersConfig: unknown, maxCount: number): string[] => {
  const ids: string[] = [];
  for (const it of asArray(monstersConfig)) {
    const obj = asObject(it);
    if (!obj) continue;
    const monsterDefId = obj.monster_def_id;
    const count = asNumber(obj.count, 1);
    if (typeof monsterDefId !== 'string' || !monsterDefId) continue;
    const safeCount = Math.max(1, Math.min(99, count));
    for (let i = 0; i < safeCount; i += 1) {
      ids.push(monsterDefId);
      if (ids.length >= maxCount) return ids;
    }
  }
  return ids.slice(0, maxCount);
};

const getStageAndWave = async (
  difficultyId: string,
  stageIndex: number,
  waveIndex: number
): Promise<
  | {
      ok: true;
      stage: Pick<DungeonStageRow, 'id' | 'stage_index' | 'name' | 'type'>;
      wave: Pick<DungeonWaveRow, 'id' | 'wave_index' | 'monsters'>;
      stageCount: number;
      maxWaveIndexInStage: number;
    }
  | { ok: false; message: string; stageCount: number }
> => {
  const stageCountRes = await query(`SELECT COUNT(1)::int AS cnt FROM dungeon_stage WHERE difficulty_id = $1`, [difficultyId]);
  const stageCount = asNumber(stageCountRes.rows?.[0]?.cnt, 0);

  const stageRes = await query(
    `SELECT id, difficulty_id, stage_index, name, type FROM dungeon_stage WHERE difficulty_id = $1 AND stage_index = $2 LIMIT 1`,
    [difficultyId, stageIndex]
  );
  if (stageRes.rows.length === 0) return { ok: false, message: '关卡不存在', stageCount };
  const stage = stageRes.rows[0] as DungeonStageRow;

  const maxWaveRes = await query(
    `SELECT COALESCE(MAX(wave_index), 0)::int AS mx FROM dungeon_wave WHERE stage_id = $1`,
    [stage.id]
  );
  const maxWaveIndexInStage = asNumber(maxWaveRes.rows?.[0]?.mx, 0);

  const waveRes = await query(
    `SELECT id, stage_id, wave_index, spawn_delay_sec, monsters, wave_rewards FROM dungeon_wave WHERE stage_id = $1 AND wave_index = $2 LIMIT 1`,
    [stage.id, waveIndex]
  );
  if (waveRes.rows.length === 0) return { ok: false, message: '波次不存在', stageCount };
  const wave = waveRes.rows[0] as DungeonWaveRow;

  return {
    ok: true,
    stage: { id: stage.id, stage_index: stage.stage_index, name: stage.name, type: stage.type },
    wave: { id: wave.id, wave_index: wave.wave_index, monsters: wave.monsters },
    stageCount,
    maxWaveIndexInStage,
  };
};

const getDungeonAndDifficulty = async (
  dungeonId: string,
  difficultyRank: number
): Promise<
  | { ok: true; dungeon: DungeonDefDto; difficulty: Pick<DungeonDifficultyRow, 'id' | 'name' | 'difficulty_rank' | 'min_realm'> }
  | { ok: false; message: string }
> => {
  const def = await getDungeonPreview(dungeonId, difficultyRank);
  if (!def?.dungeon) return { ok: false, message: '秘境不存在' };
  if (!def.difficulty) return { ok: false, message: '难度不存在' };
  const diffRes = await query(
    `SELECT id, name, difficulty_rank, min_realm FROM dungeon_difficulty WHERE id = $1 LIMIT 1`,
    [def.difficulty.id]
  );
  if (diffRes.rows.length === 0) return { ok: false, message: '难度不存在' };
  const diffRow = diffRes.rows[0] as Record<string, unknown>;
  return {
    ok: true,
    dungeon: def.dungeon,
    difficulty: {
      id: String(diffRow.id),
      name: String(diffRow.name),
      difficulty_rank: asNumber(diffRow.difficulty_rank, difficultyRank),
      min_realm: typeof diffRow.min_realm === 'string' ? diffRow.min_realm : null,
    },
  };
};

const touchEntryCount = async (
  client: PoolClient,
  characterId: number,
  dungeonId: string,
  dailyLimit: number,
  weeklyLimit: number
): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (dailyLimit <= 0 && weeklyLimit <= 0) return { ok: true };

  const res = await client.query(
    `
      INSERT INTO dungeon_entry_count (character_id, dungeon_id, daily_count, weekly_count, total_count, last_daily_reset, last_weekly_reset)
      VALUES ($1, $2, 0, 0, 0, CURRENT_DATE, CURRENT_DATE)
      ON CONFLICT (character_id, dungeon_id) DO NOTHING
    `,
    [characterId, dungeonId]
  );
  void res;

  await client.query(
    `
      UPDATE dungeon_entry_count
      SET
        daily_count = CASE WHEN last_daily_reset IS DISTINCT FROM CURRENT_DATE THEN 0 ELSE daily_count END,
        weekly_count = CASE WHEN last_weekly_reset IS NULL OR last_weekly_reset < date_trunc('week', CURRENT_DATE)::date THEN 0 ELSE weekly_count END,
        last_daily_reset = COALESCE(last_daily_reset, CURRENT_DATE),
        last_weekly_reset = COALESCE(last_weekly_reset, CURRENT_DATE)
      WHERE character_id = $1 AND dungeon_id = $2
    `,
    [characterId, dungeonId]
  );

  const cntRes = await client.query(
    `SELECT daily_count, weekly_count FROM dungeon_entry_count WHERE character_id = $1 AND dungeon_id = $2 LIMIT 1`,
    [characterId, dungeonId]
  );
  const dailyCount = asNumber(cntRes.rows?.[0]?.daily_count, 0);
  const weeklyCount = asNumber(cntRes.rows?.[0]?.weekly_count, 0);

  if (dailyLimit > 0 && dailyCount >= dailyLimit) return { ok: false, message: '今日进入次数已达上限' };
  if (weeklyLimit > 0 && weeklyCount >= weeklyLimit) return { ok: false, message: '本周进入次数已达上限' };
  return { ok: true };
};

const incEntryCount = async (client: PoolClient, characterId: number, dungeonId: string): Promise<void> => {
  await client.query(
    `
      UPDATE dungeon_entry_count
      SET
        daily_count = daily_count + 1,
        weekly_count = weekly_count + 1,
        total_count = total_count + 1
      WHERE character_id = $1 AND dungeon_id = $2
    `,
    [characterId, dungeonId]
  );
};

const countPlayerDeaths = (logs: unknown): number => {
  const list = asArray(logs);
  let count = 0;
  for (const it of list) {
    const obj = asObject(it);
    if (!obj) continue;
    if (obj.type !== 'death') continue;
    const unitId = obj.unitId;
    if (typeof unitId === 'string' && unitId.startsWith('player-')) count += 1;
  }
  return count;
};

type DungeonRewardItem = {
  itemDefId: string;
  qty: number;
  bindType?: string;
};

type DungeonRewardBundle = {
  exp: number;
  silver: number;
  items: DungeonRewardItem[];
};

const randomIntInclusive = (min: number, max: number): number => {
  const safeMin = Math.floor(Math.min(min, max));
  const safeMax = Math.floor(Math.max(min, max));
  if (safeMin === safeMax) return safeMin;
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
};

const normalizeRewardAmount = (value: unknown): number => {
  if (typeof value === 'number' || typeof value === 'string') {
    return Math.max(0, Math.floor(asNumber(value, 0)));
  }
  const obj = asObject(value);
  if (!obj) return 0;
  const min = Math.max(0, Math.floor(asNumber(obj.min, 0)));
  const max = Math.max(min, Math.floor(asNumber(obj.max, min)));
  return randomIntInclusive(min, max);
};

const mergeRewardItems = (items: DungeonRewardItem[]): DungeonRewardItem[] => {
  const merged = new Map<string, DungeonRewardItem>();
  for (const item of items) {
    const key = `${item.itemDefId}|${item.bindType ?? ''}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qty += item.qty;
      continue;
    }
    merged.set(key, { ...item });
  }
  return Array.from(merged.values());
};

const rollRewardItems = (itemsValue: unknown): DungeonRewardItem[] => {
  const items: DungeonRewardItem[] = [];
  for (const raw of asArray(itemsValue)) {
    const obj = asObject(raw);
    if (!obj) continue;
    const itemDefId = asString(obj.item_def_id, '').trim();
    if (!itemDefId) continue;
    const chance = Math.max(0, Math.min(1, asNumber(obj.chance, 1)));
    if (chance <= 0 || Math.random() > chance) continue;

    const qtyExact = Math.floor(asNumber(obj.qty, 0));
    const qtyMin = Math.max(1, Math.floor(asNumber(obj.qty_min, qtyExact > 0 ? qtyExact : 1)));
    const qtyMax = Math.max(qtyMin, Math.floor(asNumber(obj.qty_max, qtyExact > 0 ? qtyExact : qtyMin)));
    const qty = qtyExact > 0 ? qtyExact : randomIntInclusive(qtyMin, qtyMax);
    if (qty <= 0) continue;

    const bindType = asString(obj.bind_type, '').trim();
    items.push({
      itemDefId,
      qty,
      ...(bindType ? { bindType } : {}),
    });
  }
  return mergeRewardItems(items);
};

const rollDungeonRewardBundle = (rewardConfig: unknown, rewardMult: number): DungeonRewardBundle => {
  const rewardObj = asObject(rewardConfig);
  if (!rewardObj) return { exp: 0, silver: 0, items: [] };
  const mult = rewardMult > 0 ? rewardMult : 1;
  return {
    exp: Math.max(0, Math.floor(normalizeRewardAmount(rewardObj.exp) * mult)),
    silver: Math.max(0, Math.floor(normalizeRewardAmount(rewardObj.silver) * mult)),
    items: rollRewardItems(rewardObj.items),
  };
};

const mergeDungeonRewardBundle = (base: DungeonRewardBundle, append: DungeonRewardBundle): DungeonRewardBundle => {
  return {
    exp: base.exp + append.exp,
    silver: base.silver + append.silver,
    items: mergeRewardItems([...base.items, ...append.items]),
  };
};

export const createDungeonInstance = async (
  userId: number,
  dungeonId: string,
  difficultyRank: number
): Promise<
  | { success: true; data: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] } }
  | { success: false; message: string }
> => {
  try {
    const user = await getUserAndCharacter(userId);
    if (!user.ok) return { success: false, message: user.message };

    const dd = await getDungeonAndDifficulty(dungeonId, difficultyRank);
    if (!dd.ok) return { success: false, message: dd.message };

    if (user.teamId && !user.isLeader) {
      return { success: false, message: '组队中只有队长可以创建秘境' };
    }

    const participants: DungeonInstanceParticipant[] = user.teamId
      ? await getTeamParticipants(user.teamId)
      : [{ userId, characterId: user.characterId, role: 'leader' as const }];

    if (participants.length < dd.dungeon.min_players) {
      return { success: false, message: `人数不足，需要至少${dd.dungeon.min_players}人` };
    }
    if (participants.length > dd.dungeon.max_players) {
      return { success: false, message: `人数超限，最多${dd.dungeon.max_players}人` };
    }

    const instanceId = crypto.randomUUID();
    await query(
      `
        INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, instance_data)
        VALUES ($1, $2, $3, $4, $5, 'preparing', 1, 1, $6::jsonb, '{}'::jsonb)
      `,
      [instanceId, dungeonId, dd.difficulty.id, user.characterId, user.teamId, JSON.stringify(participants)]
    );

    return { success: true, data: { instanceId, status: 'preparing', participants } };
  } catch (error) {
    console.error('创建秘境实例失败:', error);
    return { success: false, message: '创建秘境实例失败' };
  }
};

export const joinDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | { success: true; data: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] } }
  | { success: false; message: string }
> => {
  try {
    const user = await getUserAndCharacter(userId);
    if (!user.ok) return { success: false, message: user.message };
    if (!user.teamId) return { success: false, message: '未加入队伍，无法加入秘境' };

    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
    if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
    const inst = instRes.rows[0] as DungeonInstanceRow;
    if (inst.status !== 'preparing') return { success: false, message: '该秘境已开始或已结束' };
    if (!inst.team_id || inst.team_id !== user.teamId) return { success: false, message: '不是同一队伍，无法加入' };

    const curParticipants = parseParticipants(inst.participants);
    if (curParticipants.some((p) => p.userId === userId)) {
      return { success: true, data: { instanceId, status: inst.status, participants: curParticipants } };
    }

    const ddRes = await query(`SELECT dungeon_id, difficulty_id FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
    const dungeonId = asString(ddRes.rows?.[0]?.dungeon_id, '');
    const dd = await getDungeonAndDifficulty(dungeonId, 1);
    if (!dd.ok) return { success: false, message: dd.message };

    const nextParticipants = [...curParticipants, { userId, characterId: user.characterId, role: 'member' as const }];
    if (nextParticipants.length > dd.dungeon.max_players) {
      return { success: false, message: `人数超限，最多${dd.dungeon.max_players}人` };
    }

    await query(`UPDATE dungeon_instance SET participants = $1::jsonb WHERE id = $2`, [JSON.stringify(nextParticipants), instanceId]);
    return { success: true, data: { instanceId, status: inst.status, participants: nextParticipants } };
  } catch (error) {
    console.error('加入秘境实例失败:', error);
    return { success: false, message: '加入秘境实例失败' };
  }
};

export const getDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
      success: true;
      data: {
        instance: {
          id: string;
          dungeonId: string;
          difficultyId: string;
          status: DungeonInstanceStatus;
          currentStage: number;
          currentWave: number;
          participants: DungeonInstanceParticipant[];
          currentBattleId: string | null;
          startTime: string | null;
          endTime: string | null;
        };
      };
    }
  | { success: false; message: string }
> => {
  try {
    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
    if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
    const inst = instRes.rows[0] as DungeonInstanceRow;
    const participants = parseParticipants(inst.participants);
    if (!participants.some((p) => p.userId === userId)) return { success: false, message: '无权访问该秘境' };

    const dataObj = asObject(inst.instance_data) ?? {};
    const currentBattleId = typeof dataObj.currentBattleId === 'string' ? dataObj.currentBattleId : null;

    return {
      success: true,
      data: {
        instance: {
          id: inst.id,
          dungeonId: inst.dungeon_id,
          difficultyId: inst.difficulty_id,
          status: inst.status,
          currentStage: asNumber(inst.current_stage, 1),
          currentWave: asNumber(inst.current_wave, 1),
          participants,
          currentBattleId,
          startTime: inst.start_time ?? null,
          endTime: inst.end_time ?? null,
        },
      },
    };
  } catch (error) {
    console.error('获取秘境实例失败:', error);
    return { success: false, message: '获取秘境实例失败' };
  }
};

export const startDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
      success: true;
      data: {
        instanceId: string;
        status: DungeonInstanceStatus;
        battleId: string;
        state: unknown;
      };
    }
  | { success: false; message: string }
> => {
  const user = await getUserAndCharacter(userId);
  if (!user.ok) return { success: false, message: user.message };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const instRes = await client.query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
    if (instRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '秘境实例不存在' };
    }
    const inst = instRes.rows[0] as DungeonInstanceRow;

    if (inst.status !== 'preparing') {
      await client.query('ROLLBACK');
      return { success: false, message: '秘境已开始或已结束' };
    }
    if (inst.creator_id !== user.characterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '只有创建者可以开始秘境' };
    }

    const dungeonDefRes = await client.query(
      `SELECT id, daily_limit, weekly_limit, min_players, max_players, stamina_cost FROM dungeon_def WHERE id = $1 LIMIT 1`,
      [inst.dungeon_id]
    );
    if (dungeonDefRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '秘境不存在' };
    }
    const dailyLimit = asNumber(dungeonDefRes.rows[0]?.daily_limit, 0);
    const weeklyLimit = asNumber(dungeonDefRes.rows[0]?.weekly_limit, 0);
    const minPlayers = asNumber(dungeonDefRes.rows[0]?.min_players, 1);
    const maxPlayers = asNumber(dungeonDefRes.rows[0]?.max_players, 4);
    const staminaCost = asNumber(dungeonDefRes.rows[0]?.stamina_cost, 0);

    const participants = parseParticipants(inst.participants);
    if (participants.length < minPlayers) {
      await client.query('ROLLBACK');
      return { success: false, message: `人数不足，需要至少${minPlayers}人` };
    }
    if (participants.length > maxPlayers) {
      await client.query('ROLLBACK');
      return { success: false, message: `人数超限，最多${maxPlayers}人` };
    }

    for (const p of participants) {
      const touch = await touchEntryCount(client, p.characterId, inst.dungeon_id, dailyLimit, weeklyLimit);
      if (!touch.ok) {
        await client.query('ROLLBACK');
        return { success: false, message: touch.message };
      }
    }

    if (staminaCost > 0) {
      for (const p of participants) {
        const staminaState = await applyStaminaRecoveryTx(client, p.characterId);
        if (!staminaState) {
          await client.query('ROLLBACK');
          return { success: false, message: '角色不存在' };
        }
        const stamina = asNumber(staminaState.stamina, 0);
        if (stamina < staminaCost) {
          await client.query('ROLLBACK');
          return { success: false, message: `体力不足，需要${staminaCost}，当前${stamina}` };
        }
      }
    }

    for (const p of participants) {
      await incEntryCount(client, p.characterId, inst.dungeon_id);
    }

    if (staminaCost > 0) {
      for (const p of participants) {
        const updRes = await client.query(
          `UPDATE characters
              SET stamina = stamina - $1,
                  stamina_recover_at = CASE WHEN stamina >= $3 THEN NOW() ELSE stamina_recover_at END,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND stamina >= $1`,
          [staminaCost, p.characterId, STAMINA_MAX]
        );
        if ((updRes.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '体力扣除失败' };
        }
      }
    }

    const stageWave = await getStageAndWave(inst.difficulty_id, 1, 1);
    if (!stageWave.ok) {
      await client.query('ROLLBACK');
      return { success: false, message: stageWave.message };
    }

    const monsterDefIds = buildMonsterDefIdsFromWave(stageWave.wave.monsters, 5);
    if (monsterDefIds.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '该波次未配置怪物' };
    }

    await client.query(`UPDATE dungeon_instance SET status = 'running', start_time = NOW(), current_stage = 1, current_wave = 1 WHERE id = $1`, [
      instanceId,
    ]);

    const battleRes = await startDungeonPVEBattle(userId, monsterDefIds, { resourceSyncClient: client });
    if (!battleRes.success || !battleRes.data?.battleId) {
      await client.query('ROLLBACK');
      return { success: false, message: battleRes.message || '开启战斗失败' };
    }

    const battleId = String(battleRes.data.battleId);
    await client.query(
      `UPDATE dungeon_instance SET instance_data = jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($1::text), true) WHERE id = $2`,
      [battleId, instanceId]
    );

    await client.query('COMMIT');
    return { success: true, data: { instanceId, status: 'running', battleId, state: battleRes.data.state } };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('开始秘境失败:', error);
    return { success: false, message: '开始秘境失败' };
  } finally {
    client.release();
  }
};

export const nextDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
      success: true;
      data: {
        instanceId: string;
        status: DungeonInstanceStatus;
        battleId?: string;
        state?: unknown;
        finished?: boolean;
      };
    }
  | { success: false; message: string }
> => {
  try {
    const user = await getUserAndCharacter(userId);
    if (!user.ok) return { success: false, message: user.message };

    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
    if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
    const inst = instRes.rows[0] as DungeonInstanceRow;

    if (inst.status !== 'running') return { success: false, message: '秘境未在进行中' };
    if (inst.creator_id !== user.characterId) return { success: false, message: '只有创建者可以推进秘境' };

    const participants = parseParticipants(inst.participants);
    if (!participants.some((p) => p.userId === userId)) return { success: false, message: '无权访问该秘境' };

    const dataObj = asObject(inst.instance_data) ?? {};
    const currentBattleId = typeof dataObj.currentBattleId === 'string' ? dataObj.currentBattleId : '';
    if (!currentBattleId) return { success: false, message: '当前战斗不存在' };

    const battleStateRes = await getBattleState(currentBattleId);
    if (!battleStateRes.success) return { success: false, message: battleStateRes.message || '获取战斗状态失败' };
    const battleData = asObject(battleStateRes.data) ?? {};
    const result = asString(battleData.result, '');
    if (result !== 'attacker_win' && result !== 'defender_win' && result !== 'draw') {
      return { success: false, message: '战斗未结束' };
    }

    if (result !== 'attacker_win') {
      await query(`UPDATE dungeon_instance SET status = 'failed', end_time = NOW() WHERE id = $1`, [instanceId]);
      return { success: true, data: { instanceId, status: 'failed', finished: true } };
    }

    const currentStage = asNumber(inst.current_stage, 1);
    const currentWave = asNumber(inst.current_wave, 1);
    const stageWave = await getStageAndWave(inst.difficulty_id, currentStage, currentWave);
    if (!stageWave.ok) return { success: false, message: stageWave.message };

    let nextStage = currentStage;
    let nextWave = currentWave + 1;
    if (nextWave > stageWave.maxWaveIndexInStage) {
      nextStage = currentStage + 1;
      nextWave = 1;
    }

    if (nextStage > stageWave.stageCount) {
      const logs = battleData.logs;
      const deathCount = countPlayerDeaths(logs);
      const stats = asObject(battleData.stats) ?? {};
      const attackerStats = asObject(stats.attacker) ?? {};
      const totalDamage = Math.floor(asNumber(attackerStats.damageDealt, 0));
      const timeSpentSec = Math.max(0, Math.floor((Date.now() - new Date(inst.start_time || inst.created_at).getTime()) / 1000));
      const client = await pool.connect();
      const pendingMailByCharacter = new Map<number, { userId: number; items: MailAttachItem[] }>();
      try {
        await client.query('BEGIN');

        const instLockRes = await client.query(`SELECT status FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
        if (instLockRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '秘境实例不存在' };
        }
        const lockedStatus = asString(instLockRes.rows[0]?.status, '');
        if (lockedStatus !== 'running') {
          await client.query('ROLLBACK');
          if (lockedStatus === 'cleared' || lockedStatus === 'failed' || lockedStatus === 'abandoned') {
            return { success: true, data: { instanceId, status: lockedStatus as DungeonInstanceStatus, finished: true } };
          }
          return { success: false, message: '秘境状态异常，无法结算' };
        }

        await client.query(
          `UPDATE dungeon_instance SET status = 'cleared', end_time = NOW(), time_spent_sec = $2, total_damage = $3, death_count = $4 WHERE id = $1`,
          [instanceId, timeSpentSec, totalDamage, deathCount]
        );

        const difficultyRes = await client.query(
          `SELECT first_clear_rewards, reward_mult FROM dungeon_difficulty WHERE id = $1 LIMIT 1`,
          [inst.difficulty_id]
        );
        const firstClearRewardConfig = difficultyRes.rows[0]?.first_clear_rewards ?? {};
        const stageRewardMult = Math.max(0, asNumber(difficultyRes.rows[0]?.reward_mult, 1));
        const stageRes = await client.query(
          `SELECT stage_index, stage_rewards FROM dungeon_stage WHERE difficulty_id = $1 ORDER BY stage_index ASC`,
          [inst.difficulty_id]
        );
        const participantCharacterIds = participants.map((p) => Number(p.characterId)).filter((id) => Number.isFinite(id) && id > 0);
        const clearCountMap = new Map<number, number>();
        if (participantCharacterIds.length > 0) {
          const clearCountRes = await client.query(
            `
              SELECT character_id, COUNT(1)::int AS cnt
              FROM dungeon_record
              WHERE character_id = ANY($1)
                AND dungeon_id = $2
                AND difficulty_id = $3
                AND result = 'cleared'
              GROUP BY character_id
            `,
            [participantCharacterIds, inst.dungeon_id, inst.difficulty_id]
          );
          for (const row of clearCountRes.rows as Array<{ character_id: unknown; cnt: unknown }>) {
            clearCountMap.set(asNumber(row.character_id, 0), asNumber(row.cnt, 0));
          }
        }

        for (const p of participants) {
          const characterId = Number(p.characterId);
          if (!Number.isFinite(characterId) || characterId <= 0) continue;
          let rewardBundle: DungeonRewardBundle = { exp: 0, silver: 0, items: [] };
          for (const row of stageRes.rows as Array<{ stage_rewards: unknown }>) {
            rewardBundle = mergeDungeonRewardBundle(
              rewardBundle,
              rollDungeonRewardBundle(row.stage_rewards, stageRewardMult)
            );
          }

          const isFirstClear = asNumber(clearCountMap.get(characterId), 0) <= 0;
          if (isFirstClear) {
            rewardBundle = mergeDungeonRewardBundle(
              rewardBundle,
              rollDungeonRewardBundle(firstClearRewardConfig, 1)
            );
          }

          if (rewardBundle.exp > 0 || rewardBundle.silver > 0) {
            await client.query(
              `UPDATE characters SET exp = exp + $1, silver = silver + $2, updated_at = NOW() WHERE id = $3`,
              [rewardBundle.exp, rewardBundle.silver, characterId]
            );
          }

          const grantedItems: Array<{ item_def_id: string; qty: number; item_ids: number[] }> = [];
          for (const rewardItem of rewardBundle.items) {
            const createOptions: CreateItemOptions = {
              location: 'bag',
              obtainedFrom: 'dungeon_clear_reward',
              ...(rewardItem.bindType ? { bindType: rewardItem.bindType } : {}),
              dbClient: client,
            };
            const createResult = await createItem(p.userId, characterId, rewardItem.itemDefId, rewardItem.qty, createOptions);
            if (createResult.success) {
              grantedItems.push({
                item_def_id: rewardItem.itemDefId,
                qty: rewardItem.qty,
                item_ids: createResult.itemIds || [],
              });
              continue;
            }

            if (createResult.message === '背包已满') {
              const pending = pendingMailByCharacter.get(characterId) || { userId: p.userId, items: [] };
              const existing = pending.items.find(
                (x) =>
                  x.item_def_id === rewardItem.itemDefId &&
                  (x.options?.bindType || 'none') === (rewardItem.bindType || 'none')
              );
              if (existing) {
                existing.qty += rewardItem.qty;
              } else {
                pending.items.push({
                  item_def_id: rewardItem.itemDefId,
                  qty: rewardItem.qty,
                  ...(rewardItem.bindType ? { options: { bindType: rewardItem.bindType } } : {}),
                });
              }
              pendingMailByCharacter.set(characterId, pending);
              grantedItems.push({
                item_def_id: rewardItem.itemDefId,
                qty: rewardItem.qty,
                item_ids: [],
              });
              continue;
            }

            console.warn(`秘境结算发奖失败: ${rewardItem.itemDefId}, ${createResult.message}`);
          }

          const rewardsPayload = {
            exp: rewardBundle.exp,
            silver: rewardBundle.silver,
            items: grantedItems,
            is_first_clear: isFirstClear,
          };

          await client.query(
            `
              INSERT INTO dungeon_record (character_id, dungeon_id, difficulty_id, instance_id, result, time_spent_sec, damage_dealt, death_count, rewards, is_first_clear)
              VALUES ($1, $2, $3, $4, 'cleared', $5, $6, $7, $8::jsonb, $9)
            `,
            [
              characterId,
              inst.dungeon_id,
              inst.difficulty_id,
              instanceId,
              timeSpentSec,
              totalDamage,
              deathCount,
              JSON.stringify(rewardsPayload),
              isFirstClear,
            ]
          );
        }

        await client.query('COMMIT');

        for (const [receiverCharacterId, entry] of pendingMailByCharacter.entries()) {
          const chunkSize = 10;
          for (let i = 0; i < entry.items.length; i += chunkSize) {
            const chunk = entry.items.slice(i, i + chunkSize);
            const mailRes = await sendSystemMail(
              entry.userId,
              receiverCharacterId,
              '秘境通关奖励补发',
              '由于背包已满，部分秘境通关奖励已通过邮件补发，请及时领取。',
              { items: chunk },
              30
            );
            if (!mailRes.success) {
              console.warn(`秘境奖励补发邮件发送失败: ${mailRes.message}`);
            }
          }
        }

        try {
          for (const p of participants) {
            const characterId = Number(p.characterId);
            if (!Number.isFinite(characterId) || characterId <= 0) continue;
            await recordDungeonClearEvent(characterId, inst.dungeon_id, 1, inst.difficulty_id);
          }
        } catch {}

        return { success: true, data: { instanceId, status: 'cleared', finished: true } };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {}
        console.error('秘境结算失败:', error);
        return { success: false, message: '秘境结算失败' };
      } finally {
        client.release();
      }
    }

    const nextStageWave = await getStageAndWave(inst.difficulty_id, nextStage, nextWave);
    if (!nextStageWave.ok) return { success: false, message: nextStageWave.message };

    const monsterDefIds = buildMonsterDefIdsFromWave(nextStageWave.wave.monsters, 5);
    if (monsterDefIds.length === 0) return { success: false, message: '该波次未配置怪物' };

    await query(`UPDATE dungeon_instance SET current_stage = $2, current_wave = $3 WHERE id = $1`, [
      instanceId,
      nextStage,
      nextWave,
    ]);

    const battleRes = await startDungeonPVEBattle(userId, monsterDefIds);
    if (!battleRes.success || !battleRes.data?.battleId) return { success: false, message: battleRes.message || '开启战斗失败' };

    const battleId = String(battleRes.data.battleId);
    await query(
      `UPDATE dungeon_instance SET instance_data = jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($1::text), true) WHERE id = $2`,
      [battleId, instanceId]
    );

    return { success: true, data: { instanceId, status: 'running', battleId, state: battleRes.data.state } };
  } catch (error) {
    console.error('推进秘境失败:', error);
    return { success: false, message: '推进秘境失败' };
  }
};
