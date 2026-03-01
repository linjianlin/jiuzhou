import {
  getDungeonDifficultiesByDungeonId,
  getDungeonDifficultyById,
  getDungeonDefinitions,
  getDungeonStagesByDifficultyId,
  getDungeonWavesByStageId,
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getMonsterDefinitions,
} from '../staticConfigLoader.js';
import { resolveDropPoolById } from '../dropPoolResolver.js';
import { getTransactionClient, query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import crypto from 'crypto';
import { getBattleState, startDungeonPVEBattle } from '../battle/index.js';
import { runDungeonStartFlow } from './shared/startFlow.js';
import { itemService } from '../itemService.js';
import { sendSystemMail, type MailAttachItem } from '../mailService.js';
import { recordDungeonClearEvent } from '../taskService.js';
import { applyStaminaRecoveryTx, STAMINA_MAX } from '../staminaService.js';
import { normalizeAutoDisassembleSetting } from '../autoDisassembleRules.js';
import { REALM_ORDER } from '../shared/realmRules.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
  type PendingMailItem,
} from '../autoDisassembleRewardService.js';
import {
  getAdjustedChance,
  getAdjustedWeight,
  normalizeMonsterKind,
  type DropEntrySourceType,
} from '../shared/dropRateMultiplier.js';
import { getAdjustedDropQuantityRange } from '../shared/dropQuantityMultiplier.js';
import { lockCharacterInventoryMutexesTx } from '../inventoryMutex.js';
import { resolveQualityRankFromName } from '../shared/itemQuality.js';
import { getCharacterIdByUserId } from '../shared/characterId.js';

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
  events: unknown;
};

type DungeonWaveRow = {
  id: string;
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

const getEnabledDungeonDefs = (): DungeonDefDto[] => {
  const list: DungeonDefDto[] = [];
  for (const entry of getDungeonDefinitions()) {
    if (entry.enabled === false) continue;
    const type = toDungeonType(entry.type);
    if (!type) continue;
    list.push({
      id: String(entry.id),
      name: String(entry.name),
      type,
      category: typeof entry.category === 'string' ? entry.category : null,
      description: typeof entry.description === 'string' ? entry.description : null,
      icon: typeof entry.icon === 'string' ? entry.icon : null,
      background: typeof entry.background === 'string' ? entry.background : null,
      min_players: asNumber(entry.min_players, 1),
      max_players: asNumber(entry.max_players, 4),
      min_realm: typeof entry.min_realm === 'string' ? entry.min_realm : null,
      recommended_realm: typeof entry.recommended_realm === 'string' ? entry.recommended_realm : null,
      unlock_condition: entry.unlock_condition ?? {},
      daily_limit: asNumber(entry.daily_limit, 0),
      weekly_limit: asNumber(entry.weekly_limit, 0),
      stamina_cost: asNumber(entry.stamina_cost, 0),
      time_limit_sec: asNumber(entry.time_limit_sec, 0),
      revive_limit: asNumber(entry.revive_limit, 0),
      tags: entry.tags ?? [],
      sort_weight: asNumber(entry.sort_weight, 0),
      enabled: true,
      version: asNumber(entry.version, 1),
    });
  }
  return list;
};

const getDungeonDefById = (dungeonId: string): DungeonDefDto | null => {
  return getEnabledDungeonDefs().find((entry) => entry.id === dungeonId) ?? null;
};

const getEnabledDungeonDifficultiesByDungeonId = (dungeonId: string): DungeonDifficultyRow[] => {
  return getDungeonDifficultiesByDungeonId(dungeonId)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: String(entry.id),
      dungeon_id: String(entry.dungeon_id),
      name: String(entry.name || entry.id),
      difficulty_rank: asNumber(entry.difficulty_rank, 1),
      monster_level_add: asNumber(entry.monster_level_add, 0),
      monster_attr_mult: asNumber(entry.monster_attr_mult, 1),
      reward_mult: asNumber(entry.reward_mult, 1),
      min_realm: typeof entry.min_realm === 'string' ? entry.min_realm : null,
      unlock_prev_difficulty: entry.unlock_prev_difficulty === true,
      first_clear_rewards: entry.first_clear_rewards ?? {},
      drop_pool_id: typeof entry.drop_pool_id === 'string' ? entry.drop_pool_id : null,
      enabled: true,
    }))
    .sort(
      (left, right) =>
        left.difficulty_rank - right.difficulty_rank || left.id.localeCompare(right.id),
    );
};

const getEnabledDungeonStagesByDifficultyId = (difficultyId: string): DungeonStageRow[] => {
  return getDungeonStagesByDifficultyId(difficultyId)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: String(entry.id),
      difficulty_id: String(entry.difficulty_id),
      stage_index: asNumber(entry.stage_index, 1),
      name: typeof entry.name === 'string' ? entry.name : null,
      type: typeof entry.type === 'string' ? entry.type : 'battle',
      description: typeof entry.description === 'string' ? entry.description : null,
      time_limit_sec: asNumber(entry.time_limit_sec, 0),
      clear_condition: entry.clear_condition ?? {},
      fail_condition: entry.fail_condition ?? {},
      events: entry.events ?? [],
    }))
    .sort((left, right) => left.stage_index - right.stage_index || left.id.localeCompare(right.id));
};

const getEnabledDungeonWavesByStageId = (stageId: string): DungeonWaveRow[] => {
  return getDungeonWavesByStageId(stageId)
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: String(entry.id || `${stageId}#${asNumber(entry.wave_index, 1)}`),
      stage_id: String(entry.stage_id || stageId),
      wave_index: asNumber(entry.wave_index, 1),
      spawn_delay_sec: asNumber(entry.spawn_delay_sec, 0),
      monsters: Array.isArray(entry.monsters) ? entry.monsters : [],
      wave_rewards: entry.wave_rewards ?? {},
    }))
    .sort((left, right) => left.wave_index - right.wave_index || left.id.localeCompare(right.id));
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

const getRealmRank = (realm: string): number => {
  const idx = (REALM_ORDER as readonly string[]).indexOf(realm);
  return idx >= 0 ? idx : 0;
};

const isRealmSufficient = (characterRealm: string, minRealm: string): boolean => {
  return getRealmRank(characterRealm) >= getRealmRank(minRealm);
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
  const defs = getEnabledDungeonDefs();
  const counter = new Map<DungeonType, number>();
  for (const def of defs) {
    counter.set(def.type, (counter.get(def.type) ?? 0) + 1);
  }
  const categories: DungeonCategoryDto[] = [];
  for (const [type, count] of counter.entries()) {
    categories.push({ type, label: DUNGEON_TYPE_LABEL[type], count });
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
        SELECT dungeon_id, is_first_clear
        FROM dungeon_record
        WHERE character_id = $1
          AND result = 'cleared'
          AND completed_at >= date_trunc('week', NOW())
          AND completed_at < date_trunc('week', NOW()) + interval '7 day'
      `,
      [characterId]
    );

    const dungeonTypeById = new Map(getEnabledDungeonDefs().map((entry) => [entry.id, entry.type] as const));
    let total = 0;
    let trial = 0;
    let material = 0;
    let equipment = 0;
    let firstClear = 0;

    for (const row of countRes.rows as Array<Record<string, unknown>>) {
      const dungeonId = typeof row.dungeon_id === 'string' ? row.dungeon_id : '';
      const type = dungeonTypeById.get(dungeonId);
      if (!type) continue;
      total += 1;
      if (row.is_first_clear === true) firstClear += 1;
      if (type === 'trial') trial += 1;
      if (type === 'material') material += 1;
      if (type === 'equipment') equipment += 1;
    }

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
  const keyword = typeof params.q === 'string' ? params.q.trim().toLowerCase() : '';
  const list: DungeonDefDto[] = [];
  for (const entry of getEnabledDungeonDefs()) {
    if (params.type && entry.type !== params.type) continue;
    if (keyword) {
      const name = entry.name.toLowerCase();
      const category = (entry.category ?? '').toLowerCase();
      if (!name.includes(keyword) && !category.includes(keyword)) continue;
    }
    const minRealm = entry.min_realm;
    if (params.realm && minRealm && !isRealmSufficient(params.realm, minRealm)) continue;
    list.push({
      ...entry,
      min_realm: minRealm,
    });
  }
  return list.sort((left, right) => right.sort_weight - left.sort_weight || left.id.localeCompare(right.id));
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
  const dungeon = getDungeonDefById(dungeonId);
  if (!dungeon) return null;

  const entry =
    typeof userId === 'number' && Number.isFinite(userId)
      ? await (async () => {
        const characterId = await getCharacterIdByUserId(userId);
        if (!characterId) return null;
        return getDungeonEntryRemaining(characterId, dungeonId, dungeon.daily_limit, dungeon.weekly_limit);
      })()
      : null;

  const diffRow =
    getEnabledDungeonDifficultiesByDungeonId(dungeonId).find((entry) => entry.difficulty_rank === difficultyRank) ??
    null;
  if (!diffRow) {
    return { dungeon, difficulty: null, entry, stages: [], monsters: [], drops: [] };
  }

  const stages = getEnabledDungeonStagesByDifficultyId(diffRow.id);

  const stageIds = stages.map((s) => s.id);
  const waves: DungeonWaveRow[] = stageIds.flatMap((stageId) => getEnabledDungeonWavesByStageId(stageId));

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
      : {
        rows: getMonsterDefinitions()
          .filter((entry) => entry.enabled !== false)
          .filter((entry) => monsterIds.includes(entry.id))
          .sort((left, right) => Number(left.level ?? 0) - Number(right.level ?? 0) || String(left.id).localeCompare(String(right.id)))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            realm: entry.realm ?? null,
            level: Number(entry.level ?? 0),
            avatar: entry.avatar ?? null,
            kind: entry.kind ?? null,
            drop_pool_id: entry.drop_pool_id ?? null,
          } as MonsterLiteRow)),
      };
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
    mode: 'prob' | 'weight';
    item_def_id: string;
    chance: number;
    weight: number;
    qty_min: number;
    qty_max: number;
    qty_multiply_by_monster_realm: number;
    quality_weights: Record<string, unknown> | null;
    bind_type: string | null;
    sourceType: DropEntrySourceType;
    sourcePoolId: string;
    sort_order: number;
  };

  const dropPreviewRows: DropPreviewRow[] = [];
  for (const poolId of monsterDropPoolIds) {
    const pool = resolveDropPoolById(poolId);
    if (!pool) continue;
    const mode: 'prob' | 'weight' = pool.mode;
    for (const entry of pool.entries) {
      if (!entry.show_in_ui) continue;
      const itemDefId = entry.item_def_id.trim();
      if (!itemDefId) continue;
      const qtyMin = Math.max(1, Math.floor(asNumber(entry.qty_min, 1)));
      const qtyMax = Math.max(qtyMin, Math.floor(asNumber(entry.qty_max, qtyMin)));
      dropPreviewRows.push({
        drop_pool_id: poolId,
        mode,
        item_def_id: itemDefId,
        chance: asNumber(entry.chance, 0),
        weight: asNumber(entry.weight, 0),
        qty_min: qtyMin,
        qty_max: qtyMax,
        qty_multiply_by_monster_realm: asNumber(entry.qty_multiply_by_monster_realm, 1),
        quality_weights: entry.quality_weights,
        bind_type: entry.bind_type,
        sourceType: entry.sourceType,
        sourcePoolId: entry.sourcePoolId,
        sort_order: Math.max(0, Math.floor(asNumber(entry.sort_order, 0))),
      });
    }
  }

  dropPreviewRows.sort(
    (left, right) =>
      left.drop_pool_id.localeCompare(right.drop_pool_id) ||
      left.sort_order - right.sort_order ||
      left.item_def_id.localeCompare(right.item_def_id),
  );

  const dropPreviewItemIds = Array.from(new Set(dropPreviewRows.map((row) => row.item_def_id)));
  const dropPreviewItemDefs = getItemDefinitionsByIds(dropPreviewItemIds);
  const dropPreviewItemMap = new Map<string, { id: string; name: string; quality: string | null; icon: string | null }>();
  for (const itemId of dropPreviewItemIds) {
    const def = dropPreviewItemDefs.get(itemId);
    if (!def || def.enabled === false) continue;
    dropPreviewItemMap.set(itemId, {
      id: itemId,
      name: String(def.name || itemId),
      quality: typeof def.quality === 'string' ? def.quality : null,
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }

  const dropPreviewByPoolId = new Map<
    string,
    Array<{
      mode: 'prob' | 'weight';
      item_def_id: string;
      chance: number;
      weight: number;
      qty_min: number;
      qty_max: number;
      qty_multiply_by_monster_realm: number;
      quality_weights: Record<string, unknown> | null;
      bind_type: string | null;
      sourceType: DropEntrySourceType;
      sourcePoolId: string;
      sort_order: number;
    }>
  >();

  for (const r of dropPreviewRows) {
    const poolId = String(r.drop_pool_id || '');
    if (!poolId) continue;
    const mode = r.mode;
    const list = dropPreviewByPoolId.get(poolId) ?? [];
    list.push({
      mode,
      item_def_id: r.item_def_id,
      chance: mode === 'prob' ? r.chance : 0,
      weight: mode === 'weight' ? r.weight : 0,
      qty_min: r.qty_min,
      qty_max: r.qty_max,
      qty_multiply_by_monster_realm: r.qty_multiply_by_monster_realm,
      quality_weights: r.quality_weights,
      bind_type: r.bind_type,
      sourceType: r.sourceType,
      sourcePoolId: r.sourcePoolId,
      sort_order: r.sort_order,
    });
    dropPreviewByPoolId.set(poolId, list);
  }

  const buildMonsterDropPreview = (
    rows: Array<{
      mode: 'prob' | 'weight';
      item_def_id: string;
      chance: number;
      weight: number;
      qty_min: number;
      qty_max: number;
      qty_multiply_by_monster_realm: number;
      quality_weights: Record<string, unknown> | null;
      bind_type: string | null;
      sourceType: DropEntrySourceType;
      sourcePoolId: string;
      sort_order: number;
    }>,
    monsterKind: string | null,
    monsterRealm: string | null,
  ): Array<{
    item: { id: string; name: string; quality: string | null; icon: string | null };
    mode: 'prob' | 'weight';
    chance: number | null;
    weight: number | null;
    qty_min: number;
    qty_max: number;
    quality_weights: Record<string, unknown> | null;
    bind_type: string | null;
  }> => {
    const kind = normalizeMonsterKind(monsterKind);
    const options = { isDungeonBattle: true, monsterKind: kind };
    return rows
      .map((r) => {
        const itemMeta = dropPreviewItemMap.get(r.item_def_id);
        const quantityRange = getAdjustedDropQuantityRange({
          itemDefId: r.item_def_id,
          qtyMin: r.qty_min,
          qtyMax: r.qty_max,
          sourceType: r.sourceType,
          sourcePoolId: r.sourcePoolId,
          dropMultiplierOptions: options,
          qtyMultiplyByMonsterRealm: r.qty_multiply_by_monster_realm,
          monsterRealm,
        });
        return {
          item: {
            id: r.item_def_id,
            name: itemMeta?.name ?? r.item_def_id,
            quality: itemMeta?.quality ?? null,
            icon: itemMeta?.icon ?? null,
          },
          mode: r.mode,
          chance: r.mode === 'prob' ? getAdjustedChance(r.chance, r.sourceType, r.sourcePoolId, options) : null,
          weight: r.mode === 'weight' ? getAdjustedWeight(r.weight, r.sourceType, r.sourcePoolId, options) : null,
          qty_min: quantityRange.qtyMin,
          qty_max: quantityRange.qtyMax,
          quality_weights: r.quality_weights,
          bind_type: r.bind_type,
        };
      });
  };

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
          const monsterKind = monster?.kind ?? null;
          const previewRows = poolId ? dropPreviewByPoolId.get(poolId) ?? [] : [];
          const dropPreview = previewRows.length > 0
            ? buildMonsterDropPreview(previewRows, monsterKind, monster?.realm ?? null)
            : [];
          waveMonsters.push({
            id: monsterId,
            name: monster?.name ?? monsterId,
            realm: monster?.realm ?? null,
            level: asNumber(monster?.level, 1),
            avatar: monster?.avatar ?? null,
            kind: monster?.kind ?? null,
            count,
            drop_pool_id: poolId,
            drop_preview: dropPreview,
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

  const dropIdSet = new Set<string>();
  const itemIds: string[] = [];
  for (const d of dropItems) {
    if (dropIdSet.has(d.item_def_id)) continue;
    dropIdSet.add(d.item_def_id);
    itemIds.push(d.item_def_id);
  }

  const itemDefs = getItemDefinitionsByIds(itemIds);
  const itemMap = new Map<string, ItemLiteRow>();
  for (const itemId of itemIds) {
    const def = itemDefs.get(itemId);
    if (!def || def.enabled === false) continue;
    itemMap.set(itemId, {
      id: itemId,
      name: String(def.name || itemId),
      quality: typeof def.quality === 'string' ? def.quality : null,
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }

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

const buildParticipantLabel = (
  participant: DungeonInstanceParticipant,
  nicknameMap: Map<number, string>
): string => {
  const roleLabel = participant.role === 'leader' ? '队长' : '队员';
  const nickname = nicknameMap.get(participant.characterId);
  if (nickname) return `${roleLabel}【${nickname}】(角色ID:${participant.characterId})`;
  return `${roleLabel}(角色ID:${participant.characterId})`;
};

const getParticipantNicknameMap = async (participants: DungeonInstanceParticipant[]): Promise<Map<number, string>> => {
  const characterIds = Array.from(
    new Set(
      participants
        .map((participant) => participant.characterId)
        .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
    ),
  );
  if (characterIds.length === 0) return new Map<number, string>();

  const rows = await query('SELECT id, nickname FROM characters WHERE id = ANY($1::int[])', [characterIds]);
  const nicknameMap = new Map<number, string>();
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const characterId = Number(row.id);
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    const nickname = asString(row.nickname, '').trim();
    if (!nickname) continue;
    nicknameMap.set(characterId, nickname);
  }
  return nicknameMap;
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
  const stages = getEnabledDungeonStagesByDifficultyId(difficultyId);
  const stageCount = stages.length;
  const stage = stages.find((entry) => entry.stage_index === stageIndex) ?? null;
  if (!stage) return { ok: false, message: '关卡不存在', stageCount };

  const waves = getEnabledDungeonWavesByStageId(stage.id);
  const maxWaveIndexInStage = waves.reduce((max, entry) => Math.max(max, entry.wave_index), 0);
  const wave = waves.find((entry) => entry.wave_index === waveIndex) ?? null;
  if (!wave) return { ok: false, message: '波次不存在', stageCount };

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
  const diffRow = getDungeonDifficultyById(def.difficulty.id);
  if (!diffRow || diffRow.enabled === false) return { ok: false, message: '难度不存在' };
  return {
    ok: true,
    dungeon: def.dungeon,
    difficulty: {
      id: String(diffRow.id || def.difficulty.id),
      name: String(diffRow.name || def.difficulty.name),
      difficulty_rank: asNumber(diffRow.difficulty_rank, difficultyRank),
      min_realm: typeof diffRow.min_realm === 'string' ? diffRow.min_realm : null,
    },
  };
};

const touchEntryCount = async (
  characterId: number,
  dungeonId: string,
  dailyLimit: number,
  weeklyLimit: number
): Promise<{ ok: true } | { ok: false; message: string }> => {
  if (dailyLimit <= 0 && weeklyLimit <= 0) return { ok: true };

  const res = await query(
    `
      INSERT INTO dungeon_entry_count (character_id, dungeon_id, daily_count, weekly_count, total_count, last_daily_reset, last_weekly_reset)
      VALUES ($1, $2, 0, 0, 0, CURRENT_DATE, CURRENT_DATE)
      ON CONFLICT (character_id, dungeon_id) DO NOTHING
    `,
    [characterId, dungeonId]
  );
  void res;

  await query(
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

  const cntRes = await query(
    `SELECT daily_count, weekly_count FROM dungeon_entry_count WHERE character_id = $1 AND dungeon_id = $2 LIMIT 1`,
    [characterId, dungeonId]
  );
  const dailyCount = asNumber(cntRes.rows?.[0]?.daily_count, 0);
  const weeklyCount = asNumber(cntRes.rows?.[0]?.weekly_count, 0);

  if (dailyLimit > 0 && dailyCount >= dailyLimit) return { ok: false, message: '今日进入次数已达上限' };
  if (weeklyLimit > 0 && weeklyCount >= weeklyLimit) return { ok: false, message: '本周进入次数已达上限' };
  return { ok: true };
};

const incEntryCount = async (characterId: number, dungeonId: string): Promise<void> => {
  await query(
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
  const client = getTransactionClient();
  if (!client) return { success: false, message: '事务上下文缺失' };

  try {
    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
    if (instRes.rows.length === 0) {
      return { success: false, message: '秘境实例不存在' };
    }
    const inst = instRes.rows[0] as DungeonInstanceRow;

    if (inst.status !== 'preparing') {
      return { success: false, message: '秘境已开始或已结束' };
    }
    if (inst.creator_id !== user.characterId) {
      return { success: false, message: '只有创建者可以开始秘境' };
    }

    const dungeonDef = getDungeonDefById(inst.dungeon_id);
    if (!dungeonDef) {
      return { success: false, message: '秘境不存在' };
    }
    const dailyLimit = dungeonDef.daily_limit;
    const weeklyLimit = dungeonDef.weekly_limit;
    const minPlayers = dungeonDef.min_players;
    const maxPlayers = dungeonDef.max_players;
    const staminaCost = dungeonDef.stamina_cost;

    const participants = parseParticipants(inst.participants);
    const participantNicknameMap = await getParticipantNicknameMap(participants);
    if (participants.length < minPlayers) {
      return { success: false, message: `人数不足，需要至少${minPlayers}人` };
    }
    if (participants.length > maxPlayers) {
      return { success: false, message: `人数超限，最多${maxPlayers}人` };
    }

    for (const p of participants) {
      const touch = await touchEntryCount(p.characterId, inst.dungeon_id, dailyLimit, weeklyLimit);
      if (!touch.ok) {
        return { success: false, message: touch.message };
      }
    }

    if (staminaCost > 0) {
      for (const p of participants) {
        const participantLabel = buildParticipantLabel(p, participantNicknameMap);
        const staminaState = await applyStaminaRecoveryTx(client, p.characterId);
        if (!staminaState) {
          return { success: false, message: `${participantLabel}不存在` };
        }
        const stamina = asNumber(staminaState.stamina, 0);
        if (stamina < staminaCost) {
          return { success: false, message: `${participantLabel}体力不足，需要${staminaCost}，当前${stamina}` };
        }
      }
    }

    const stageWave = await getStageAndWave(inst.difficulty_id, 1, 1);
    if (!stageWave.ok) {
      return { success: false, message: stageWave.message };
    }

    const monsterDefIds = buildMonsterDefIdsFromWave(stageWave.wave.monsters, 5);
    if (monsterDefIds.length === 0) {
      return { success: false, message: '该波次未配置怪物' };
    }

    return runDungeonStartFlow({
      startBattle: () => startDungeonPVEBattle(userId, monsterDefIds, { skipCooldown: true }),
      commitOnBattleStarted: async ({ battleId, state }) => {
        for (const p of participants) {
          await incEntryCount(p.characterId, inst.dungeon_id);
        }

        if (staminaCost > 0) {
          for (const p of participants) {
            const participantLabel = buildParticipantLabel(p, participantNicknameMap);
            const updRes = await query(
              `UPDATE characters
                  SET stamina = stamina - $1,
                      stamina_recover_at = CASE WHEN stamina >= $3 THEN NOW() ELSE stamina_recover_at END,
                      updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 AND stamina >= $1`,
              [staminaCost, p.characterId, STAMINA_MAX]
            );
            if ((updRes.rowCount ?? 0) === 0) {
              return { success: false, message: `${participantLabel}体力扣除失败` };
            }
          }
        }

        await query(
          `UPDATE dungeon_instance SET status = 'running', start_time = NOW(), current_stage = 1, current_wave = 1 WHERE id = $1`,
          [instanceId]
        );

        await query(
          `UPDATE dungeon_instance SET instance_data = jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($1::text), true) WHERE id = $2`,
          [battleId, instanceId]
        );
        return { success: true, data: { instanceId, status: 'running', battleId, state } };
      },
    });
  } catch (error) {
    console.error('开始秘境失败:', error);
    return { success: false, message: '开始秘境失败' };
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
      const pendingMailByCharacter = new Map<number, { userId: number; items: MailAttachItem[] }>();
      try {

        const instLockRes = await query(`SELECT status FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
        if (instLockRes.rows.length === 0) {
          return { success: false, message: '秘境实例不存在' };
        }
        const lockedStatus = asString(instLockRes.rows[0]?.status, '');
        if (lockedStatus !== 'running') {
          if (lockedStatus === 'cleared' || lockedStatus === 'failed' || lockedStatus === 'abandoned') {
            return { success: true, data: { instanceId, status: lockedStatus as DungeonInstanceStatus, finished: true } };
          }
          return { success: false, message: '秘境状态异常，无法结算' };
        }

        await query(
          `UPDATE dungeon_instance SET status = 'cleared', end_time = NOW(), time_spent_sec = $2, total_damage = $3, death_count = $4 WHERE id = $1`,
          [instanceId, timeSpentSec, totalDamage, deathCount]
        );

        const difficultyDef = getDungeonDifficultyById(inst.difficulty_id);
        const firstClearRewardConfig = difficultyDef?.first_clear_rewards ?? {};
        const participantCharacterIds = [...new Set(
          participants
            .map((p) => Number(p.characterId))
            .filter((id) => Number.isFinite(id) && id > 0)
        )].sort((a, b) => a - b);
        const clearCountMap = new Map<number, number>();
        const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();
        const itemMetaCache = new Map<
          string,
          {
            name: string;
            category: string;
            subCategory: string | null;
            effectDefs: unknown;
            qualityRank: number;
          }
        >();

        if (participantCharacterIds.length > 0) {
          // 发奖流程会同时更新 characters 并写入背包，先统一获取背包互斥锁，
          // 避免与”先背包锁再锁角色行”的事务出现锁顺序反转。
          await lockCharacterInventoryMutexesTx(null, participantCharacterIds);
        }

        const appendGrantedItem = (
          list: Array<{ item_def_id: string; qty: number; item_ids: number[] }>,
          itemDefId: string,
          qty: number,
          itemIds: number[]
        ) => {
          const normalizedQty = Math.max(0, Math.floor(qty));
          if (normalizedQty <= 0) return;
          const safeItemIds = itemIds.filter((id) => Number.isInteger(id) && id > 0);
          const existing = list.find((item) => item.item_def_id === itemDefId);
          if (existing) {
            existing.qty += normalizedQty;
            if (safeItemIds.length > 0) {
              existing.item_ids.push(...safeItemIds);
            }
            return;
          }
          list.push({
            item_def_id: itemDefId,
            qty: normalizedQty,
            item_ids: safeItemIds,
          });
        };

        const appendPendingMailItems = (characterId: number, userId: number, items: PendingMailItem[]) => {
          if (items.length <= 0) return;
          const pending = pendingMailByCharacter.get(characterId) || { userId, items: [] as MailAttachItem[] };
          for (const item of items) {
            const targetBindType = item.options?.bindType || 'none';
            const targetEquipOptionsKey = JSON.stringify(item.options?.equipOptions || null);
            const existing = pending.items.find((x) => {
              const bindType = x.options?.bindType || 'none';
              const equipOptionsKey = JSON.stringify(x.options?.equipOptions || null);
              return x.item_def_id === item.item_def_id && bindType === targetBindType && equipOptionsKey === targetEquipOptionsKey;
            });
            if (existing) {
              existing.qty += item.qty;
              continue;
            }
            pending.items.push({
              item_def_id: item.item_def_id,
              qty: item.qty,
              ...(item.options ? { options: { ...item.options } } : {}),
            });
          }
          pendingMailByCharacter.set(characterId, pending);
        };

        const getItemMeta = async (itemDefId: string): Promise<{
          name: string;
          category: string;
          subCategory: string | null;
          effectDefs: unknown;
          qualityRank: number;
        }> => {
          const cached = itemMetaCache.get(itemDefId);
          if (cached) return cached;
          const row = getItemDefinitionById(itemDefId);
          const meta = {
            name: typeof row?.name === 'string' && row.name.length > 0 ? row.name : itemDefId,
            category: typeof row?.category === 'string' ? row.category : '',
            subCategory: typeof row?.sub_category === 'string' && row.sub_category.length > 0 ? row.sub_category : null,
            effectDefs: row?.effect_defs ?? null,
            qualityRank: resolveQualityRankFromName(row?.quality, 1),
          };
          itemMetaCache.set(itemDefId, meta);
          return meta;
        };

        if (participantCharacterIds.length > 0) {
          const clearCountRes = await query(
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

          const settingRes = await query(
            `
              SELECT id, auto_disassemble_enabled, auto_disassemble_rules
              FROM characters
              WHERE id = ANY($1)
            `,
            [participantCharacterIds]
          );
          for (const row of settingRes.rows as Array<{
            id: unknown;
            auto_disassemble_enabled: boolean | null;
            auto_disassemble_rules: unknown;
          }>) {
            const id = asNumber(row.id, 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            autoDisassembleSettings.set(
              id,
              normalizeAutoDisassembleSetting({
                enabled: row.auto_disassemble_enabled,
                rules: row.auto_disassemble_rules,
              })
            );
          }
        }

        for (const p of participants) {
          const characterId = Number(p.characterId);
          if (!Number.isFinite(characterId) || characterId <= 0) continue;
          let rewardBundle: DungeonRewardBundle = { exp: 0, silver: 0, items: [] };

          const isFirstClear = asNumber(clearCountMap.get(characterId), 0) <= 0;
          if (isFirstClear) {
            rewardBundle = mergeDungeonRewardBundle(
              rewardBundle,
              rollDungeonRewardBundle(firstClearRewardConfig, 1)
            );
          }

          if (rewardBundle.exp > 0 || rewardBundle.silver > 0) {
            await query(
              `UPDATE characters SET exp = exp + $1, silver = silver + $2, updated_at = NOW() WHERE id = $3`,
              [rewardBundle.exp, rewardBundle.silver, characterId]
            );
          }

          const autoDisassembleSetting =
            autoDisassembleSettings.get(characterId) ||
            normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });
          const grantedItems: Array<{ item_def_id: string; qty: number; item_ids: number[] }> = [];
          let autoDisassembleSilverGained = 0;
          for (const rewardItem of rewardBundle.items) {
            const itemMeta = await getItemMeta(rewardItem.itemDefId);
            const grantResult = await grantRewardItemWithAutoDisassemble({
              characterId,
              itemDefId: rewardItem.itemDefId,
              qty: rewardItem.qty,
              ...(rewardItem.bindType ? { bindType: rewardItem.bindType } : {}),
              itemMeta: {
                itemName: itemMeta.name,
                category: itemMeta.category,
                subCategory: itemMeta.subCategory,
                effectDefs: itemMeta.effectDefs,
                qualityRank: itemMeta.qualityRank,
              },
              autoDisassembleSetting,
              sourceObtainedFrom: 'dungeon_clear_reward',
              createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
                return itemService.createItem(p.userId, characterId, itemDefId, qty, {
                  location: 'bag',
                  obtainedFrom,
                  ...(bindType ? { bindType } : {}),
                  ...(equipOptions ? { equipOptions } : {}),
                });
              },
              addSilver: async (ownerCharacterId, silverGain) => {
                const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
                if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
                const updateRes = await query(
                  `
                    UPDATE characters
                    SET silver = silver + $1,
                        updated_at = NOW()
                    WHERE id = $2
                  `,
                  [safeSilver, ownerCharacterId]
                );
                if (updateRes.rowCount === 0) return { success: false, message: '角色不存在' };
                return { success: true, message: '银两增加成功' };
              },
            });

            for (const warning of grantResult.warnings) {
              console.warn(`秘境结算发奖失败: ${warning}`);
            }
            for (const granted of grantResult.grantedItems) {
              appendGrantedItem(grantedItems, granted.itemDefId, granted.qty, granted.itemIds);
            }
            appendPendingMailItems(characterId, p.userId, grantResult.pendingMailItems);
            if (grantResult.gainedSilver > 0) {
              autoDisassembleSilverGained += grantResult.gainedSilver;
            }
          }

          const rewardsPayload = {
            exp: rewardBundle.exp,
            silver: rewardBundle.silver + autoDisassembleSilverGained,
            items: grantedItems,
            is_first_clear: isFirstClear,
          };

          await query(
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
        } catch { }

          return { success: true, data: { instanceId, status: 'cleared', finished: true } };
      } catch (error) {
        console.error('秘境结算失败:', error);
        return { success: false, message: '秘境结算失败' };
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

    const battleRes = await startDungeonPVEBattle(userId, monsterDefIds, { skipCooldown: true });
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

/**
 * 秘境服务 class
 *
 * 作用：将现有的秘境函数包装为 class 方法，支持 @Transactional 装饰器
 *
 * 数据流：委托给对应的独立函数
 *
 * 关键边界条件：
 * 1) startDungeonInstance 和 nextDungeonInstance 使用 @Transactional 保证事务原子性
 * 2) 其他方法直接委托给独立函数
 */
class DungeonService {
  async getDungeonCategories() {
    return getDungeonCategories();
  }

  async getDungeonWeeklyTargets(userId: number) {
    return getDungeonWeeklyTargets(userId);
  }

  async getDungeonList(params: Parameters<typeof getDungeonList>[0]) {
    return getDungeonList(params);
  }

  async getDungeonPreview(dungeonId: string, difficultyRank?: number, userId?: number) {
    return getDungeonPreview(dungeonId, difficultyRank, userId);
  }

  async createDungeonInstance(userId: number, dungeonId: string, difficultyRank: number) {
    return createDungeonInstance(userId, dungeonId, difficultyRank);
  }

  async joinDungeonInstance(userId: number, instanceId: string) {
    return joinDungeonInstance(userId, instanceId);
  }

  async getDungeonInstance(userId: number, instanceId: string) {
    return getDungeonInstance(userId, instanceId);
  }

  @Transactional
  async startDungeonInstance(userId: number, instanceId: string) {
    return startDungeonInstance(userId, instanceId);
  }

  @Transactional
  async nextDungeonInstance(userId: number, instanceId: string) {
    return nextDungeonInstance(userId, instanceId);
  }
}

export const dungeonService = new DungeonService();
