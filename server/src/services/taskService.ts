import { query } from '../config/database.js';
import { itemService } from './itemService.js';
import type { PoolClient } from 'pg';
import { ensureMainQuestProgressForNewChapters, updateSectionProgress, updateSectionProgressBatch } from './mainQuest/index.js';
import { updateAchievementProgress } from './achievementService.js';
import { updateAchievementProgressBatch } from './achievement/progress.js';
import { Transactional } from '../decorators/transactional.js';
import {
  getDungeonDefinitions,
  getDungeonDifficultyById,
  getDungeonDifficultiesByDungeonId,
  getDungeonStagesByDifficultyId,
  getDungeonWavesByStageId,
  getMainQuestChapterById,
  getMainQuestSectionById,
  getMapDefinitions,
  getNpcDefinitions,
  getTalkTreeDefinitions,
} from './staticConfigLoader.js';
import {
  getStaticTaskDefinitions,
  getTaskDefinitionById,
  getTaskDefinitionsByIds,
  getTaskDefinitionsByNpcIds,
  type TaskDefinition,
} from './taskDefinitionService.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';
import {
  applyCharacterRewardDeltas,
  createCharacterRewardDelta,
  mergeCharacterRewardDelta,
  type CharacterRewardDelta,
} from './shared/characterRewardSettlement.js';
import {
  getRewardCurrencyDisplayName,
  resolveRewardItemDisplayMeta,
  resolveRewardItemDisplayMetaMap,
  type RewardItemDisplayMeta,
} from './shared/rewardDisplay.js';
import { resolveNpcTalkGreetingLines } from './shared/npcTalkGreeting.js';
import {
  getTaskStaticIndex,
  normalizeTaskObjectives,
} from './shared/taskStaticIndex.js';
import { buildTaskRecurringUnlockState } from './shared/taskRecurringUnlock.js';
import { notifyTaskOverviewUpdate } from './taskOverviewPush.js';
import {
  collectMatchedRecurringTaskIds,
  objectiveMatchesTaskEvent,
  type CharacterTaskRealmState,
  type TaskEvent,
  type TaskObjectiveLike,
} from './shared/taskRecurringEventMatcher.js';

export type TaskCategory = 'main' | 'side' | 'daily' | 'event';

export type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

export type TaskObjectiveDto = {
  id: string;
  type: string;
  text: string;
  done: number;
  target: number;
  params?: Record<string, unknown>;
  mapName: string | null;
  mapNameType: 'map' | 'dungeon' | null;
};

export type TaskRewardDto =
  | { type: 'silver'; name: string; amount: number }
  | { type: 'spirit_stones'; name: string; amount: number }
  | { type: 'item'; itemDefId: string; name: string; icon: string | null; amount: number; amountMax?: number };

export type TaskOverviewDto = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId: string | null;
  mapId: string | null;
  mapName: string | null;
  roomId: string | null;
  status: TaskStatus;
  tracked: boolean;
  description: string;
  objectives: TaskObjectiveDto[];
  rewards: TaskRewardDto[];
};

export type TaskOverviewSummaryDto = Pick<
  TaskOverviewDto,
  'id' | 'category' | 'mapId' | 'roomId' | 'status' | 'tracked'
>;

export type BountyTaskSourceType = 'daily' | 'player';

export type BountyTaskOverviewDto = Omit<TaskOverviewDto, 'category'> & {
  category: 'bounty';
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

export type BountyTaskOverviewSummaryDto = {
  id: string;
  status: TaskStatus;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

type RawReward = {
  type?: unknown;
  item_def_id?: unknown;
  qty?: unknown;
  qty_min?: unknown;
  qty_max?: unknown;
  amount?: unknown;
};

type RawObjective = TaskObjectiveLike;

type RecurringTaskResetPlan = {
  autoAcceptTaskIds: string[];
  dailyTaskIds: string[];
  eventTaskIds: string[];
};

type RecurringTaskResetInflightEntry = {
  promise: Promise<void>;
  realmStateKey: string | null;
};

type BountyClaimRewardRow = {
  claim_id: number | string | null;
  spirit_stones_reward: number | string | null;
  silver_reward: number | string | null;
};

type TaskProgressRecord = Record<string, number>;

type TaskOverviewSourceRow = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId: string | null;
  mapId: string | null;
  roomId: string | null;
  description: string;
  objectives: RawObjective[];
  rewards: RawReward[];
  progressStatus: string | null;
  tracked: boolean;
  progress: TaskProgressRecord | null;
};

type BountyTaskOverviewSourceRow = {
  taskId: string;
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  title: string;
  description: string;
  expiresAt: string | null;
  extraSpiritStonesReward: number;
  extraSilverReward: number;
  progressStatus: string | null;
  tracked: boolean;
  progress: TaskProgressRecord | null;
  taskDef: TaskDefinition;
};

const asNonEmptyString = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const asFiniteNonNegativeInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
};

const resolveRewardQtyRange = (reward: RawReward): { min: number; max: number } => {
  const fixedQty = asFiniteNonNegativeInt(reward?.qty, 0);
  if (fixedQty > 0) return { min: fixedQty, max: fixedQty };

  const minQty = Math.max(1, asFiniteNonNegativeInt(reward?.qty_min, 1));
  const maxQty = Math.max(minQty, asFiniteNonNegativeInt(reward?.qty_max, minQty));
  return { min: minQty, max: maxQty };
};

const rollRangeIntInclusive = (min: number, max: number): number => {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  return getCharacterIdByUserIdShared(userId);
};

const normalizeTaskCategory = (v: unknown): TaskCategory | null => {
  const s = asNonEmptyString(v);
  if (!s) return null;
  if (s === 'main' || s === 'side' || s === 'daily' || s === 'event') return s;
  return null;
};

const mapProgressStatusToUiStatus = (v: unknown): TaskStatus => {
  const s = asNonEmptyString(v) || 'ongoing';
  if (s === 'turnin') return 'turnin';
  if (s === 'claimable') return 'claimable';
  if (s === 'completed' || s === 'claimed') return 'completed';
  return 'ongoing';
};

const parseObjectives = (objectives: unknown): RawObjective[] => (Array.isArray(objectives) ? (objectives as RawObjective[]) : []);

const parseRewards = (rewards: unknown): RawReward[] => (Array.isArray(rewards) ? (rewards as RawReward[]) : []);

/** 根据 mapId 从地图定义中查找地图名称 */
const resolveMapName = (mapId: string | null): string | null => {
  if (!mapId) return null;
  const map = getMapDefinitions().find((m) => m.id === mapId);
  return map?.name ?? null;
};

/**
 * 从所有副本定义中构建 dungeon_id → 副本名称 的缓存
 * 用于让任务目标直接展示真实副本名，而不是笼统的“秘境”
 */
let dungeonNameCache: Map<string, string> | null = null;

const buildDungeonNameCache = (): Map<string, string> => {
  if (dungeonNameCache) return dungeonNameCache;
  const cache = new Map<string, string>();
  for (const dungeon of getDungeonDefinitions()) {
    if (!dungeon.id || !dungeon.name) continue;
    cache.set(dungeon.id, dungeon.name);
  }
  dungeonNameCache = cache;
  return cache;
};

/**
 * 从 map_def.json 的房间数据中构建 entity_id → 地图名称 的缓存
 * 用于将怪物/资源 ID 解析到其所在的地图
 */
let entityMapNameCache: Map<string, string> | null = null;

const buildEntityMapNameCache = (): Map<string, string> => {
  if (entityMapNameCache) return entityMapNameCache;
  const cache = new Map<string, string>();
  const maps = getMapDefinitions();
  for (const map of maps) {
    const rooms = map.rooms as Array<{
      monsters?: Array<{ monster_def_id: string }>;
      resources?: Array<{ resource_id: string }>;
    }> | undefined;
    if (!Array.isArray(rooms)) continue;
    for (const room of rooms) {
      if (Array.isArray(room.monsters)) {
        for (const m of room.monsters) {
          if (m.monster_def_id && !cache.has(m.monster_def_id)) {
            cache.set(m.monster_def_id, map.name);
          }
        }
      }
      if (Array.isArray(room.resources)) {
        for (const r of room.resources) {
          if (r.resource_id && !cache.has(r.resource_id)) {
            cache.set(r.resource_id, map.name);
          }
        }
      }
    }
  }
  entityMapNameCache = cache;
  return cache;
};

/**
 * 从所有副本的波次数据中构建 monster_id → 副本名称 的缓存
 * 用于将秘境内 boss/怪物解析到其所属副本
 */
let monsterDungeonNameCache: Map<string, string> | null = null;

const buildMonsterDungeonNameCache = (): Map<string, string> => {
  if (monsterDungeonNameCache) return monsterDungeonNameCache;
  const cache = new Map<string, string>();
  for (const dungeon of getDungeonDefinitions()) {
    const diffs = getDungeonDifficultiesByDungeonId(dungeon.id);
    for (const diff of diffs) {
      for (const stage of getDungeonStagesByDifficultyId(diff.id)) {
        for (const wave of getDungeonWavesByStageId(stage.id)) {
          for (const m of wave.monsters ?? []) {
            const mid = typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).monster_def_id === 'string'
              ? String((m as Record<string, unknown>).monster_def_id)
              : '';
            if (mid && !cache.has(mid)) {
              cache.set(mid, dungeon.name);
            }
          }
        }
      }
    }
  }
  monsterDungeonNameCache = cache;
  return cache;
};

/**
 * 根据目标参数解析该目标实际执行的地点标签及类型
 * - dungeon_clear：有具体 dungeon_id 时返回对应副本名称；配置缺失时返回 null
 * - kill_monster：优先从副本波次查找所属副本名，其次从地图房间查找地图名
 * - gather_resource：从地图房间查找地图名
 * - 无具体目标：返回 null
 */
const resolveObjectiveMapName = (
  params: Record<string, unknown> | undefined,
): { name: string; type: 'map' | 'dungeon' } | null => {
  if (!params) return null;
  const dungeonId = asNonEmptyString(params.dungeon_id);
  if (dungeonId) {
    const dungeonName = buildDungeonNameCache().get(dungeonId);
    return dungeonName ? { name: dungeonName, type: 'dungeon' } : null;
  }
  const monsterId = asNonEmptyString(params.monster_id);
  if (monsterId) {
    const dungeonName = buildMonsterDungeonNameCache().get(monsterId);
    if (dungeonName) return { name: dungeonName, type: 'dungeon' };
    const mapName = buildEntityMapNameCache().get(monsterId);
    if (mapName) return { name: mapName, type: 'map' };
    return null;
  }
  const resourceId = asNonEmptyString(params.resource_id);
  if (resourceId) {
    const mapName = buildEntityMapNameCache().get(resourceId);
    if (mapName) return { name: mapName, type: 'map' };
    return null;
  }
  return null;
};

const collectRewardItemDefIds = (rewardGroups: Iterable<RawReward[]>): string[] => {
  const itemRewardIds = new Set<string>();
  for (const rewards of rewardGroups) {
    for (const reward of rewards) {
      if (asNonEmptyString(reward?.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(reward?.item_def_id);
      if (!itemDefId) continue;
      itemRewardIds.add(itemDefId);
    }
  }
  return Array.from(itemRewardIds);
};

const toTaskRewardItemMetaMap = (
  itemDefIds: Iterable<string>,
): Map<string, RewardItemDisplayMeta> => {
  return resolveRewardItemDisplayMetaMap(itemDefIds);
};

const toTaskRewardDto = (
  reward: RawReward,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskRewardDto | null => {
  const type = asNonEmptyString(reward?.type) ?? '';
  if (type === 'silver') {
    return {
      type: 'silver',
      name: getRewardCurrencyDisplayName('silver'),
      amount: asFiniteNonNegativeInt(reward?.amount, 0),
    };
  }
  if (type === 'spirit_stones') {
    return {
      type: 'spirit_stones',
      name: getRewardCurrencyDisplayName('spirit_stones'),
      amount: asFiniteNonNegativeInt(reward?.amount, 0),
    };
  }
  if (type !== 'item') return null;

  const itemDefId = asNonEmptyString(reward?.item_def_id);
  if (!itemDefId) return null;
  const qtyRange = resolveRewardQtyRange(reward);
  const meta = itemMeta.get(itemDefId) ?? resolveRewardItemDisplayMeta(itemDefId);
  const amountMax = qtyRange.max > qtyRange.min ? qtyRange.max : undefined;
  return {
    type: 'item',
    itemDefId,
    name: meta.name,
    icon: meta.icon,
    amount: qtyRange.min,
    ...(amountMax ? { amountMax } : {}),
  };
};

const toTaskProgressRecord = (value: unknown): TaskProgressRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: TaskProgressRecord = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    record[key] = asFiniteNonNegativeInt(entryValue, 0);
  }
  return record;
};

const getProgressValue = (progress: TaskProgressRecord | null | undefined, objectiveId: string): number => {
  if (!objectiveId) return 0;
  if (!progress) return 0;
  return asFiniteNonNegativeInt(progress[objectiveId], 0);
};

const computeRemainingSeconds = (expiresAt: unknown): number | null => {
  if (!expiresAt) return null;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
};

const buildTaskObjectiveDtos = (
  objectives: RawObjective[],
  progress: TaskProgressRecord | null,
): TaskObjectiveDto[] => {
  return objectives
    .map((objective) => {
      const objectiveId = asNonEmptyString(objective.id) ?? '';
      const text = String(objective.text ?? '');
      const target = Math.max(1, asFiniteNonNegativeInt(objective.target, 1));
      const done = Math.min(target, getProgressValue(progress, objectiveId));
      const type = String(objective.type ?? 'unknown');
      const paramsValue = objective.params;
      const params = paramsValue && typeof paramsValue === 'object'
        ? (paramsValue as Record<string, unknown>)
        : undefined;
      const objectiveMapName = resolveObjectiveMapName(params);
      return {
        id: objectiveId,
        type,
        text,
        done,
        target,
        mapName: objectiveMapName?.name ?? null,
        mapNameType: objectiveMapName?.type ?? null,
        ...(params ? { params } : {}),
      };
    })
    .filter((objective) => objective.text);
};

const buildTaskRewardDtos = (
  rewards: RawReward[],
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskRewardDto[] => {
  return rewards
    .map((reward) => toTaskRewardDto(reward, itemMeta))
    .filter((reward): reward is TaskRewardDto => reward !== null && reward.amount > 0);
};

const normalizeBountyTaskSourceType = (value: unknown): BountyTaskSourceType => {
  return asNonEmptyString(value) === 'player' ? 'player' : 'daily';
};

const loadCharacterTaskRealmState = async (
  characterId: number,
  dbClient?: PoolClient,
): Promise<CharacterTaskRealmState | null> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return null;

  const runner = dbClient ?? { query };
  const res = await runner.query(
    `
      SELECT realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [cid],
  );

  const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    realm: asNonEmptyString(row.realm) ?? '凡人',
    subRealm: asNonEmptyString(row.sub_realm),
  };
};

const buildRecurringTaskResetPlan = (
  characterRealmState: CharacterTaskRealmState,
): RecurringTaskResetPlan => {
  const autoAcceptTaskIds: string[] = [];
  const dailyTaskIds: string[] = [];
  const eventTaskIds: string[] = [];

  for (const taskDef of getStaticTaskDefinitions()) {
    if (!taskDef.enabled) continue;
    if (taskDef.category !== 'daily' && taskDef.category !== 'event') continue;
    if (!isTaskDefinitionUnlockedForCharacter(taskDef, characterRealmState)) continue;
    const taskId = taskDef.id.trim();
    if (!taskId) continue;

    autoAcceptTaskIds.push(taskId);
    if (taskDef.category === 'daily') {
      dailyTaskIds.push(taskId);
      continue;
    }
    eventTaskIds.push(taskId);
  }

  return {
    autoAcceptTaskIds,
    dailyTaskIds,
    eventTaskIds,
  };
};

const buildCharacterTaskRealmStateKey = (
  characterRealmState?: CharacterTaskRealmState,
): string | null => {
  if (!characterRealmState) return null;
  return `${characterRealmState.realm}::${characterRealmState.subRealm ?? ''}`;
};

const recurringTaskResetInflight = new Map<number, RecurringTaskResetInflightEntry>();

const insertMissingTaskProgressRows = async (
  runner: Pick<PoolClient, 'query'>,
  characterId: number,
  taskIds: readonly string[],
  tracked: boolean,
): Promise<boolean> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return false;
  const normalizedTaskIds = Array.from(new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean)));
  if (normalizedTaskIds.length === 0) return false;

  const insertResult = await runner.query(
    `
      INSERT INTO character_task_progress
        (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
      SELECT
        $1,
        recurring_task.task_id,
        'ongoing',
        '{}'::jsonb,
        $3,
        NOW(),
        NULL,
        NULL,
        NOW()
      FROM unnest($2::varchar[]) AS recurring_task(task_id)
      ON CONFLICT (character_id, task_id) DO NOTHING
    `,
    [cid, normalizedTaskIds, tracked],
  );

  return (insertResult.rowCount ?? 0) > 0;
};

const runRecurringTaskProgressReset = async (
  characterId: number,
  dbClient?: PoolClient,
  characterRealmState?: CharacterTaskRealmState,
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  const runner = dbClient ?? { query };
  const resolvedCharacterRealmState = characterRealmState ?? await loadCharacterTaskRealmState(cid, dbClient);
  if (!resolvedCharacterRealmState) return;

  const resetPlan = buildRecurringTaskResetPlan(resolvedCharacterRealmState);

  if (resetPlan.autoAcceptTaskIds.length > 0) {
    // 日常/周常任务为自动接取：缺失进度行时自动补齐，避免首次必须手动“接取”。
    await insertMissingTaskProgressRows(runner, cid, resetPlan.autoAcceptTaskIds, false);
  }

  if (resetPlan.dailyTaskIds.length === 0 && resetPlan.eventTaskIds.length === 0) return;

  await runner.query(
    `
      UPDATE character_task_progress
      SET status = 'ongoing',
          progress = '{}'::jsonb,
          accepted_at = NOW(),
          completed_at = NULL,
          claimed_at = NULL,
          updated_at = NOW()
      WHERE character_id = $1
        AND (
          (task_id = ANY($2::varchar[]) AND accepted_at < date_trunc('day', NOW()))
          OR
          (task_id = ANY($3::varchar[]) AND accepted_at < date_trunc('week', NOW()))
        )
    `,
    [cid, resetPlan.dailyTaskIds, resetPlan.eventTaskIds],
  );
};

const isTaskDefinitionUnlockedForCharacter = (
  taskDef: Pick<TaskDefinition, 'category' | 'realm'>,
  characterRealm: CharacterTaskRealmState,
): boolean => {
  return buildTaskRecurringUnlockState(
    taskDef.category,
    taskDef.realm,
    characterRealm.realm,
    characterRealm.subRealm,
  ).unlocked;
};

const getTaskDefinitionUnlockFailureMessage = (
  taskDef: Pick<TaskDefinition, 'category' | 'realm'>,
  characterRealm: CharacterTaskRealmState,
): string | null => {
  const unlockState = buildTaskRecurringUnlockState(
    taskDef.category,
    taskDef.realm,
    characterRealm.realm,
    characterRealm.subRealm,
  );
  if (unlockState.unlocked || !unlockState.requiredRealm) return null;
  return `需达到${unlockState.requiredRealm}后开放`;
};

const resetRecurringTaskProgressIfNeeded = async (
  characterId: number,
  dbClient?: PoolClient,
  characterRealmState?: CharacterTaskRealmState,
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  if (dbClient) {
    await runRecurringTaskProgressReset(cid, dbClient, characterRealmState);
    return;
  }

  const realmStateKey = buildCharacterTaskRealmStateKey(characterRealmState);
  const inflight = recurringTaskResetInflight.get(cid);
  if (inflight && inflight.realmStateKey === realmStateKey) {
    await inflight.promise;
    return;
  }

  const entry: RecurringTaskResetInflightEntry = {
    promise: Promise.resolve(),
    realmStateKey,
  };
  const request = runRecurringTaskProgressReset(cid, undefined, characterRealmState).finally(() => {
    const latest = recurringTaskResetInflight.get(cid);
    if (latest === entry) {
      recurringTaskResetInflight.delete(cid);
    }
  });
  entry.promise = request;
  recurringTaskResetInflight.set(cid, entry);
  await request;
};

const buildTaskOverviewSourceRows = async (
  characterId: number,
  category?: TaskCategory,
): Promise<TaskOverviewSourceRow[]> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return [];
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return [];
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const resolvedCategory = normalizeTaskCategory(category);
  const defs = getStaticTaskDefinitions().filter((entry) => {
    if (!entry.enabled) return false;
    if (resolvedCategory && entry.category !== resolvedCategory) return false;
    return isTaskDefinitionUnlockedForCharacter(entry, characterRealmState);
  });

  const taskIds = defs.map((entry) => entry.id);
  const progressRes =
    taskIds.length === 0
      ? { rows: [] as Array<Record<string, unknown>> }
      : await query(
          `
            SELECT task_id, status AS progress_status, tracked, progress
            FROM character_task_progress
            WHERE character_id = $1
              AND task_id = ANY($2::varchar[])
          `,
          [cid, taskIds],
        );

  const progressByTaskId = new Map<string, {
    progressStatus: string | null;
    tracked: boolean;
    progress: TaskProgressRecord | null;
  }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, {
      progressStatus: asNonEmptyString(row.progress_status),
      tracked: row.tracked === true,
      progress: toTaskProgressRecord(row.progress),
    });
  }

  return defs
    .sort((left, right) => left.category.localeCompare(right.category) || right.sort_weight - left.sort_weight || left.id.localeCompare(right.id))
    .map((def) => {
      const progress = progressByTaskId.get(def.id);
      return {
        id: def.id,
        category: normalizeTaskCategory(def.category) ?? 'main',
        title: String(def.title ?? def.id),
        realm: asNonEmptyString(def.realm) ?? '凡人',
        giverNpcId: asNonEmptyString(def.giver_npc_id),
        mapId: asNonEmptyString(def.map_id),
        roomId: asNonEmptyString(def.room_id),
        description: String(def.description ?? ''),
        objectives: parseObjectives(def.objectives),
        rewards: parseRewards(def.rewards),
        progressStatus: progress?.progressStatus ?? null,
        tracked: progress?.tracked === true,
        progress: progress?.progress ?? null,
      };
    });
};

const buildTaskOverviewRewardMeta = (
  rows: TaskOverviewSourceRow[],
): Map<string, RewardItemDisplayMeta> => {
  return toTaskRewardItemMetaMap(collectRewardItemDefIds(rows.map((row) => row.rewards)));
};

const mapTaskOverviewDetail = (
  row: TaskOverviewSourceRow,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskOverviewDto => {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    realm: row.realm,
    giverNpcId: row.giverNpcId,
    mapId: row.mapId,
    mapName: resolveMapName(row.mapId),
    roomId: row.roomId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
    description: row.description,
    objectives: buildTaskObjectiveDtos(row.objectives, row.progress),
    rewards: buildTaskRewardDtos(row.rewards, itemMeta),
  };
};

const mapTaskOverviewSummary = (
  row: TaskOverviewSourceRow,
): TaskOverviewSummaryDto => {
  return {
    id: row.id,
    category: row.category,
    mapId: row.mapId,
    roomId: row.roomId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
  };
};

const buildBountyTaskOverviewSourceRows = async (
  characterId: number,
): Promise<BountyTaskOverviewSourceRow[]> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return [];
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return [];
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const res = await query(
    `
      SELECT
        i.id AS bounty_instance_id,
        i.source_type,
        i.task_id,
        i.title AS bounty_title,
        COALESCE(i.description, '') AS bounty_description,
        CASE
          WHEN i.source_type = 'daily' AND i.expires_at IS NULL THEN (date_trunc('day', NOW()) + interval '1 day')
          ELSE i.expires_at
        END AS expires_at,
        i.spirit_stones_reward,
        i.silver_reward,
        COALESCE(p.status, 'ongoing') AS progress_status,
        COALESCE(p.tracked, false) AS tracked,
        COALESCE(p.progress, '{}'::jsonb) AS progress
      FROM bounty_claim c
      JOIN bounty_instance i ON i.id = c.bounty_instance_id
      LEFT JOIN character_task_progress p
        ON p.task_id = i.task_id
       AND p.character_id = $1
      WHERE c.character_id = $1
        AND c.status IN ('claimed','completed')
        AND (
          i.source_type <> 'daily'
          OR (
            i.refresh_date = CURRENT_DATE
            AND (i.expires_at IS NULL OR i.expires_at > NOW())
          )
        )
        AND (
          i.source_type <> 'player'
          OR i.expires_at IS NULL
          OR i.expires_at > NOW()
        )
      ORDER BY c.claimed_at DESC, i.id DESC
    `,
    [cid],
  );

  const queryRows = (res.rows ?? []) as Array<Record<string, unknown>>;
  const taskDefMap = await getTaskDefinitionsByIds(
    queryRows
      .map((row) => asNonEmptyString(row.task_id))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );

  return queryRows.flatMap((row) => {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) return [];
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef) return [];

    const bountyInstanceIdRaw = typeof row.bounty_instance_id === 'number'
      ? row.bounty_instance_id
      : Number(row.bounty_instance_id);
    const bountyInstanceId = Number.isFinite(bountyInstanceIdRaw) ? Math.trunc(bountyInstanceIdRaw) : 0;
    const expiresAt = row.expires_at ? new Date(String(row.expires_at)).toISOString() : null;

    return [{
      taskId,
      bountyInstanceId,
      sourceType: normalizeBountyTaskSourceType(row.source_type),
      title: String(row.bounty_title ?? taskId),
      description: String(row.bounty_description ?? ''),
      expiresAt,
      extraSpiritStonesReward: asFiniteNonNegativeInt(row.spirit_stones_reward, 0),
      extraSilverReward: asFiniteNonNegativeInt(row.silver_reward, 0),
      progressStatus: asNonEmptyString(row.progress_status),
      tracked: row.tracked === true,
      progress: toTaskProgressRecord(row.progress),
      taskDef,
    }];
  });
};

const buildBountyTaskOverviewRewardMeta = (
  rows: BountyTaskOverviewSourceRow[],
): Map<string, RewardItemDisplayMeta> => {
  return toTaskRewardItemMetaMap(
    collectRewardItemDefIds(rows.map((row) => parseRewards(row.taskDef.rewards))),
  );
};

const mapBountyTaskOverviewDetail = (
  row: BountyTaskOverviewSourceRow,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): BountyTaskOverviewDto => {
  const rewardOut: TaskRewardDto[] = [];
  if (row.extraSilverReward > 0) {
    rewardOut.push({
      type: 'silver',
      name: getRewardCurrencyDisplayName('silver'),
      amount: row.extraSilverReward,
    });
  }
  if (row.extraSpiritStonesReward > 0) {
    rewardOut.push({
      type: 'spirit_stones',
      name: getRewardCurrencyDisplayName('spirit_stones'),
      amount: row.extraSpiritStonesReward,
    });
  }
  rewardOut.push(...buildTaskRewardDtos(parseRewards(row.taskDef.rewards), itemMeta));

  return {
    id: row.taskId,
    category: 'bounty',
    title: row.title,
    realm: asNonEmptyString(row.taskDef.realm) ?? '凡人',
    giverNpcId: asNonEmptyString(row.taskDef.giver_npc_id),
    mapId: asNonEmptyString(row.taskDef.map_id),
    mapName: resolveMapName(asNonEmptyString(row.taskDef.map_id)),
    roomId: asNonEmptyString(row.taskDef.room_id),
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
    description: row.description,
    objectives: buildTaskObjectiveDtos(parseObjectives(row.taskDef.objectives), row.progress),
    rewards: rewardOut,
    bountyInstanceId: row.bountyInstanceId,
    sourceType: row.sourceType,
    expiresAt: row.expiresAt,
    remainingSeconds: computeRemainingSeconds(row.expiresAt),
  };
};

const mapBountyTaskOverviewSummary = (
  row: BountyTaskOverviewSourceRow,
): BountyTaskOverviewSummaryDto => {
  return {
    id: row.taskId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    sourceType: row.sourceType,
    expiresAt: row.expiresAt,
    remainingSeconds: computeRemainingSeconds(row.expiresAt),
  };
};

export const getTaskOverview = async (
  characterId: number,
  category?: TaskCategory,
): Promise<{ tasks: TaskOverviewDto[] }> => {
  const rows = await buildTaskOverviewSourceRows(characterId, category);
  const itemMeta = buildTaskOverviewRewardMeta(rows);
  return {
    tasks: rows.map((row) => mapTaskOverviewDetail(row, itemMeta)),
  };
};

export const getTaskOverviewSummary = async (
  characterId: number,
  category?: TaskCategory,
): Promise<{ tasks: TaskOverviewSummaryDto[] }> => {
  const rows = await buildTaskOverviewSourceRows(characterId, category);
  return {
    tasks: rows.map(mapTaskOverviewSummary),
  };
};

export const getBountyTaskOverview = async (
  characterId: number,
): Promise<{ tasks: BountyTaskOverviewDto[] }> => {
  const rows = await buildBountyTaskOverviewSourceRows(characterId);
  const itemMeta = buildBountyTaskOverviewRewardMeta(rows);
  return {
    tasks: rows.map((row) => mapBountyTaskOverviewDetail(row, itemMeta)),
  };
};

export const getBountyTaskOverviewSummary = async (
  characterId: number,
): Promise<{ tasks: BountyTaskOverviewSummaryDto[] }> => {
  const rows = await buildBountyTaskOverviewSourceRows(characterId);
  return {
    tasks: rows.map(mapBountyTaskOverviewSummary),
  };
};

export const setTaskTracked = async (
  characterId: number,
  taskId: string,
  tracked: boolean
): Promise<{ success: boolean; message: string; data?: { taskId: string; tracked: boolean } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };

  const res = await query(
    `
      INSERT INTO character_task_progress (character_id, task_id, tracked)
      VALUES ($1, $2, $3)
      ON CONFLICT (character_id, task_id) DO UPDATE SET
        tracked = EXCLUDED.tracked,
        updated_at = NOW()
      RETURNING tracked
    `,
    [cid, tid, tracked]
  );

  const saved = res.rows?.[0]?.tracked === true;
  return { success: true, message: 'ok', data: { taskId: tid, tracked: saved } };
};

type ClaimedRewardResult =
  | { type: 'silver'; amount: number }
  | { type: 'spirit_stones'; amount: number }
  | { type: 'item'; itemDefId: string; qty: number; itemIds?: number[]; itemName?: string; itemIcon?: string };

const appendClaimedCurrencyReward = (
  rewards: ClaimedRewardResult[],
  rewardDelta: CharacterRewardDelta,
  type: 'silver' | 'spirit_stones',
  amount: number,
): void => {
  if (amount <= 0) return;
  if (type === 'silver') {
    mergeCharacterRewardDelta(rewardDelta, { silver: amount });
  } else {
    mergeCharacterRewardDelta(rewardDelta, { spiritStones: amount });
  }
  rewards.push({ type, amount });
};

export const claimTaskReward = async (
  userId: number,
  characterId: number,
  taskId: string
): Promise<{ success: boolean; message: string; data?: { taskId: string; rewards: ClaimedRewardResult[] } }> => {
  return taskService.claimTaskReward(userId, characterId, taskId);
};

type TaskProgressStatusDb = 'ongoing' | 'turnin' | 'claimable' | 'claimed';

const asTaskProgressStatusDb = (v: unknown): TaskProgressStatusDb => {
  const s = asNonEmptyString(v) || 'ongoing';
  if (s === 'turnin') return 'turnin';
  if (s === 'claimable') return 'claimable';
  if (s === 'claimed') return 'claimed';
  return 'ongoing';
};

const asStringArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
};

const parseProgressRecord = (progress: unknown): Record<string, number> => {
  if (!progress || typeof progress !== 'object') return {};
  const record = progress as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.floor(n));
  }
  return out;
};

const computeAllObjectivesDone = (objectives: readonly RawObjective[], progressRecord: Record<string, number>): boolean => {
  const list = objectives.filter((o) => asNonEmptyString(o?.id));
  if (list.length === 0) return false;
  for (const o of list) {
    const oid = asNonEmptyString(o?.id) ?? '';
    const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
    const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[oid], 0));
    if (done < target) return false;
  }
  return true;
};

const checkPrereqSatisfied = async (characterId: number, prereqTaskIds: string[]): Promise<boolean> => {
  const prereqIds = prereqTaskIds.map((x) => x.trim()).filter(Boolean);
  if (prereqIds.length === 0) return true;
  const res = await query(
    `
      SELECT task_id, status
      FROM character_task_progress
      WHERE character_id = $1 AND task_id = ANY($2::varchar[])
    `,
    [characterId, prereqIds],
  );
  const statusById = new Map<string, TaskProgressStatusDb>();
  for (const r of res.rows ?? []) {
    const tid = asNonEmptyString(r?.task_id);
    if (!tid) continue;
    statusById.set(tid, asTaskProgressStatusDb(r?.status));
  }
  for (const tid of prereqIds) {
    const st = statusById.get(tid);
    if (!st) return false;
    if (st !== 'turnin' && st !== 'claimable' && st !== 'claimed') return false;
  }
  return true;
};

export const acceptTaskFromNpc = async (
  characterId: number,
  taskId: string,
  npcId: string,
): Promise<{ success: boolean; message: string; data?: { taskId: string } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };
  const taskCategory = normalizeTaskCategory(taskDef.category) ?? 'main';
  const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
  if (!giverNpcId || giverNpcId !== nid) return { success: false, message: '该NPC无法发放此任务' };
  const prereqTaskIds = asStringArray(taskDef.prereq_task_ids);
  const prereqOk = await checkPrereqSatisfied(cid, prereqTaskIds);
  if (!prereqOk) return { success: false, message: '前置任务未完成' };

  const existsRes = await query(
    `SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1`,
    [cid, tid],
  );
  if ((existsRes.rows ?? []).length > 0) {
    const st = asTaskProgressStatusDb(existsRes.rows[0]?.status);
    if (st !== 'claimed') return { success: false, message: '任务已接取' };
    if (taskCategory === 'main' || taskCategory === 'side') return { success: false, message: '任务已完成，不可重复接取' };
    if (taskCategory === 'daily') return { success: false, message: '今日任务已完成' };
    if (taskCategory === 'event') return { success: false, message: '本周活动任务已完成' };
  }

  await query(
    `
      INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
      VALUES ($1, $2, 'ongoing', '{}'::jsonb, true, NOW(), NULL, NULL, NOW())
      ON CONFLICT (character_id, task_id) DO UPDATE SET
        status = EXCLUDED.status,
        progress = EXCLUDED.progress,
        tracked = EXCLUDED.tracked,
        accepted_at = NOW(),
        completed_at = NULL,
        claimed_at = NULL,
        updated_at = NOW()
    `,
    [cid, tid],
  );

  return { success: true, message: 'ok', data: { taskId: tid } };
};

export const submitTask = async (
  characterId: number,
  taskId: string,
  npcId: string,
): Promise<{ success: boolean; message: string; data?: { taskId: string } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const res = await query(
    `
      SELECT status, progress
      FROM character_task_progress
      WHERE character_id = $1 AND task_id = $2
      LIMIT 1
    `,
    [cid, tid],
  );
  if ((res.rows ?? []).length === 0) return { success: false, message: '任务未接取' };

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };

  const row = res.rows[0] as { status?: unknown; progress?: unknown };
  const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
  if (!giverNpcId || giverNpcId !== nid) return { success: false, message: '该任务无法在此提交' };
  const status = asTaskProgressStatusDb(row?.status);
  if (status === 'claimed') return { success: false, message: '任务已完成' };
  if (status === 'claimable') return { success: true, message: 'ok', data: { taskId: tid } };

  const objectives = parseObjectives(taskDef.objectives);
  const progressRecord = parseProgressRecord(row?.progress);
  const allDone = computeAllObjectivesDone(objectives, progressRecord);
  if (!allDone) return { success: false, message: '任务未完成' };

  await query(
    `
      UPDATE character_task_progress
      SET status = 'claimable',
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE character_id = $1 AND task_id = $2
    `,
    [cid, tid],
  );
  return { success: true, message: 'ok', data: { taskId: tid } };
};

const applyTaskEvent = async (
  characterId: number,
  event: TaskEvent,
  characterRealmState?: CharacterTaskRealmState,
): Promise<boolean> => {
  return applyTaskEvents(characterId, [event], characterRealmState);
};

type TaskProgressEventMutation = {
  taskId: string;
  progress: TaskProgressRecord;
  nextStatus: TaskProgressStatusDb;
};

/**
 * 批量推进任务事件，供同一角色的一组战斗/收集事件复用。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把同一角色的一组任务事件收敛为“一次境界读取、一次任务进度读取、一次批量写回”，避免热路径重复扫全量任务进度。
 * 2. 做什么：保留 recurring 任务自动补齐、目标命中、交付 NPC 直达 claimable 等既有语义。
 * 3. 不做什么：不处理主线批量推进，也不负责成就更新；这些仍由调用方在外层统一调度。
 *
 * 输入/输出：
 * - 输入：`characterId` 与一组已归一化的 `TaskEvent`。
 * - 输出：是否有任务概览相关数据发生变化。
 *
 * 数据流/状态流：
 * 事件数组 -> recurring 任务命中收敛 -> 补齐缺失进度行 -> 一次性读取角色任务进度
 * -> 内存合并所有事件命中 -> 批量 UPDATE 落库。
 *
 * 关键边界条件与坑点：
 * 1. `talk_npc` 必须允许与同批次里的“已完成目标”组合后直接进入 `claimable`，否则会把原本同链路可交付的任务错误卡在 `turnin`。
 * 2. 这里只对单角色做批量；多角色仍应由上层按角色拆分，避免把不同角色的任务锁和推送口径混在一起。
 */
const applyTaskEvents = async (
  characterId: number,
  events: readonly TaskEvent[],
  characterRealmState?: CharacterTaskRealmState,
): Promise<boolean> => {
  if (events.length <= 0) return false;
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return false;
  const resolvedCharacterRealmState = characterRealmState ?? await loadCharacterTaskRealmState(cid);
  if (!resolvedCharacterRealmState) return false;

  const taskStaticIndex = getTaskStaticIndex();
  const matchedRecurringTaskIdSet = new Set<string>();
  for (const event of events) {
    const matchedRecurringTaskIds = collectMatchedRecurringTaskIds(
      taskStaticIndex.recurringTaskDefinitions,
      resolvedCharacterRealmState,
      event,
    );
    for (const taskId of matchedRecurringTaskIds) {
      matchedRecurringTaskIdSet.add(taskId);
    }
  }
  const insertedRecurringTask = await insertMissingTaskProgressRows(
    { query },
    cid,
    Array.from(matchedRecurringTaskIdSet),
    false,
  );

  const res = await query(
    `
      SELECT
        p.task_id,
        p.status,
        p.progress
      FROM character_task_progress p
      WHERE p.character_id = $1
        AND COALESCE(p.status, 'ongoing') <> 'claimed'
    `,
    [cid],
  );

  const taskDefMap = await getTaskDefinitionsByIds(
    (res.rows as Array<Record<string, unknown>>)
      .map((row) => asNonEmptyString(row.task_id))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );

  const taskProgressMutations: TaskProgressEventMutation[] = [];
  let changedAnyTask = insertedRecurringTask;
  for (const row of res.rows ?? []) {
    const taskId = asNonEmptyString(row?.task_id);
    if (!taskId) continue;
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef) continue;
    if (!isTaskDefinitionUnlockedForCharacter(taskDef, resolvedCharacterRealmState)) continue;
    const status = asTaskProgressStatusDb(row?.status);
    if (status === 'claimed') continue;

    const objectives = taskDef.source === 'static'
      ? (taskStaticIndex.objectivesByTaskId.get(taskId) ?? [])
      : parseObjectives(taskDef.objectives);
    const progressRecord = parseProgressRecord(row?.progress);
    const category = normalizeTaskCategory(taskDef.category) ?? 'main';
    const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);

    const normalizedObjectives = taskDef.source === 'static'
      ? (taskStaticIndex.normalizedObjectivesByTaskId.get(taskId) ?? [])
      : normalizeTaskObjectives(objectives);

    let changed = false;
    let giverTalkMatched = false;
    for (const event of events) {
      if (event.type === 'talk_npc' && giverNpcId && giverNpcId === event.npcId) {
        giverTalkMatched = true;
      }
      for (const objectiveEntry of normalizedObjectives) {
        const match = objectiveMatchesTaskEvent(objectiveEntry.objective, event);
        if (!match.matched) continue;
        const current = asFiniteNonNegativeInt(progressRecord[objectiveEntry.objectiveId], 0);
        const next = Math.min(objectiveEntry.target, current + match.delta);
        if (next !== current) {
          progressRecord[objectiveEntry.objectiveId] = next;
          changed = true;
        }
      }
    }

    const allDone = computeAllObjectivesDone(objectives, progressRecord);

    let nextStatus: TaskProgressStatusDb = status;
    if (allDone) {
      if (category === 'event') {
        nextStatus = 'claimable';
      } else {
        if (status === 'ongoing') nextStatus = 'turnin';
        if (giverTalkMatched && (status === 'turnin' || nextStatus === 'turnin' || status === 'claimable')) {
          nextStatus = 'claimable';
        }
      }
    }

    if (!changed && nextStatus === status) continue;
    taskProgressMutations.push({
      taskId,
      progress: progressRecord,
      nextStatus,
    });
    changedAnyTask = true;
  }

  if (taskProgressMutations.length > 0) {
    await query(
      `
        WITH next_rows AS (
          SELECT *
          FROM jsonb_to_recordset($2::jsonb)
            AS x(task_id varchar(64), progress jsonb, next_status varchar(16))
        )
        UPDATE character_task_progress AS progress_row
        SET progress = next_rows.progress,
            status = next_rows.next_status,
            completed_at = CASE
              WHEN next_rows.next_status = 'claimable'::varchar(16)
                THEN COALESCE(progress_row.completed_at, NOW())
              ELSE progress_row.completed_at
            END,
            updated_at = NOW()
        FROM next_rows
        WHERE progress_row.character_id = $1
          AND progress_row.task_id = next_rows.task_id
      `,
      [
        cid,
        JSON.stringify(taskProgressMutations.map((mutation) => ({
          task_id: mutation.taskId,
          progress: mutation.progress,
          next_status: mutation.nextStatus,
        }))),
      ],
    );
  }

  return changedAnyTask;
};

const normalizePositiveInt = (value: unknown, fallback = 1): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floor = Math.floor(n);
  return floor > 0 ? floor : fallback;
};

type KillMonsterEventInput = {
  monsterId: string;
  count: number;
};

/**
 * 统一规整怪物击杀事件，供战斗结算和单次击杀都走同一入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：过滤非法 monsterId、合并重复怪物、累计正整数击杀次数。
 * 2. 不做什么：不触发任务更新、不写数据库，只负责把输入整理成单一数据源。
 *
 * 输入/输出：
 * - 输入：`events`，允许包含重复 monsterId 和非规范 count。
 * - 输出：按 monsterId 聚合后的击杀事件数组。
 *
 * 数据流/状态流：
 * - 战斗结算/单次调用 -> 归一化怪物击杀事件 -> 统一进入任务/主线/成就更新。
 *
 * 关键边界条件与坑点：
 * 1. 空 monsterId 会被直接丢弃，避免把脏数据写进任务进度。
 * 2. 同一场战斗可能出现重复怪物定义，必须先聚合，避免重复通知和重复主线写入。
 */
const normalizeKillMonsterEvents = (
  events: KillMonsterEventInput[],
): KillMonsterEventInput[] => {
  const countByMonsterId = new Map<string, number>();

  for (const event of events) {
    const monsterId = asNonEmptyString(event.monsterId);
    if (!monsterId) continue;
    const count = normalizePositiveInt(event.count, 1);
    countByMonsterId.set(monsterId, (countByMonsterId.get(monsterId) ?? 0) + count);
  }

  return [...countByMonsterId.entries()].map(([monsterId, count]) => ({
    monsterId,
    count,
  }));
};

const recordTalkNpcEvent = async (characterId: number, npcId: string): Promise<void> => {
  const nid = asNonEmptyString(npcId);
  if (!nid) return;

  const taskOverviewChanged = await applyTaskEvent(characterId, { type: 'talk_npc', npcId: nid });

  await updateSectionProgress(characterId, { type: 'talk_npc', npcId: nid });

  await updateAchievementProgress(characterId, `talk:npc:${nid}`, 1);
  if (taskOverviewChanged) {
    await notifyTaskOverviewUpdate(characterId, ['task']);
  }
};

export const recordKillMonsterEvent = async (characterId: number, monsterId: string, count: number): Promise<void> => {
  await recordKillMonsterEvents(characterId, [{ monsterId, count }]);
};

/**
 * 批量记录怪物击杀事件，供战斗结算统一复用。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把一场战斗内的多只怪击杀统一推进到任务、主线和成就系统。
 * 2. 不做什么：不推断战斗来源，也不负责战斗奖励结算。
 *
 * 输入/输出：
 * - 输入：`characterId` 与一组怪物击杀事件。
 * - 输出：无；副作用是更新任务/主线/成就并按需推送任务总览。
 *
 * 数据流/状态流：
 * - 战斗结算拿到怪物列表 -> 本函数聚合 -> applyTaskEvents/updateSectionProgressBatch/updateAchievementProgress。
 *
 * 关键边界条件与坑点：
 * 1. 必须先聚合同怪多次击杀，否则同一场战斗会产生多次任务总览刷新。
 * 2. 主线目标支持批量推进，因此这里必须走 batch 入口，避免对同一角色重复锁进度行。
 */
export const recordKillMonsterEvents = async (
  characterId: number,
  events: KillMonsterEventInput[],
): Promise<void> => {
  const normalizedEvents = normalizeKillMonsterEvents(events);
  if (normalizedEvents.length <= 0) return;

  const taskOverviewChanged = await applyTaskEvents(
    characterId,
    normalizedEvents.map((event) => ({
      type: 'kill_monster',
      monsterId: event.monsterId,
      count: event.count,
    })),
  );

  await updateSectionProgressBatch(
    characterId,
    normalizedEvents.map((event) => ({
      type: 'kill_monster' as const,
      monsterId: event.monsterId,
      count: event.count,
    })),
  );

  await updateAchievementProgressBatch(
    normalizedEvents.map((event) => ({
      characterId,
      trackKey: `kill:monster:${event.monsterId}`,
      increment: event.count,
    })),
  );

  if (taskOverviewChanged) {
    await notifyTaskOverviewUpdate(characterId, ['task']);
  }
};

export const recordGatherResourceEvent = async (characterId: number, resourceId: string, count: number): Promise<void> => {
  const rid = asNonEmptyString(resourceId);
  if (!rid) return;
  const c = normalizePositiveInt(count, 1);

  const taskOverviewChanged = await applyTaskEvent(characterId, { type: 'gather_resource', resourceId: rid, count: c });

  await updateSectionProgressBatch(characterId, [
    { type: 'gather_resource', resourceId: rid, count: c },
    { type: 'collect', itemId: rid, count: c },
  ]);

  await updateAchievementProgress(characterId, `gather:resource:${rid}`, c);
  await updateAchievementProgress(characterId, `item:obtain:${rid}`, c);
  if (taskOverviewChanged) {
    await notifyTaskOverviewUpdate(characterId, ['task']);
  }
};

export const recordCollectItemEvent = async (characterId: number, itemId: string, count: number): Promise<void> => {
  return taskService.recordCollectItemEvent(characterId, itemId, count);
};

type CollectItemEventInput = {
  itemId: string;
  count: number;
};

const normalizeCollectItemEvents = (
  events: CollectItemEventInput[],
): CollectItemEventInput[] => {
  const countByItemId = new Map<string, number>();

  for (const event of events) {
    const itemId = asNonEmptyString(event.itemId);
    if (!itemId) continue;
    const count = normalizePositiveInt(event.count, 1);
    countByItemId.set(itemId, (countByItemId.get(itemId) ?? 0) + count);
  }

  return [...countByItemId.entries()].map(([itemId, count]) => ({
    itemId,
    count,
  }));
};

/**
 * 批量记录收集物品事件，供掉落/邮件等多物品入口复用。
 *
 * 作用：
 * 1. 把同一角色的一批收集事件聚合成一次 recurring 任务推进、一次主线批量推进和一次成就批量推进，减少掉落热路径的重复读写。
 * 2. 统一让战斗掉落、邮件补发等所有“获得物品”入口都走同一套任务命中口径，避免某些收集型周常永远不加进度。
 *
 * 输入 / 输出：
 * - 输入：角色 ID 与一组可能重复的 `itemId/count` 收集事件。
 * - 输出：无；副作用是推进 recurring 任务、主线章节收集目标与物品获取成就。
 *
 * 数据流 / 状态流：
 * 收集事件数组 -> 先按 itemId 聚合 -> recurring 周期任务重置检查
 * -> `applyTaskEvents` 命中收集目标 -> `updateSectionProgressBatch` 回填主线
 * -> `updateAchievementProgressBatch` 推进成就 -> 按需推送任务总览。
 *
 * 复用设计说明：
 * 1. recurring 任务推进继续复用 `applyTaskEvents`，不额外新写一套 collect 判定分支，避免 kill/gather/collect 三条链路规则漂移。
 * 2. 主线与成就仍复用既有批量入口，让同一批物品只做一次聚合，减少重复遍历与数据库交互。
 *
 * 关键边界条件与坑点：
 * 1. 同一批里重复 itemId 必须先合并，否则 recurring / 主线 / 成就都会被重复累加。
 * 2. 收集事件也可能发生在新周期开始后的第一场掉落前，因此必须先做 recurring 重置检查，避免写进过期周常。
 */
export const recordCollectItemEvents = async (
  characterId: number,
  events: CollectItemEventInput[],
): Promise<void> => {
  return taskService.recordCollectItemEvents(characterId, events);
};

export const recordDungeonClearEvent = async (
  characterId: number,
  dungeonId: string,
  count: number,
  participantCount: number,
  difficultyId?: string,
): Promise<void> => {
  const did = asNonEmptyString(dungeonId);
  if (!did) return;
  const diffId = asNonEmptyString(difficultyId) ?? undefined;
  const c = normalizePositiveInt(count, 1);

  await resetRecurringTaskProgressIfNeeded(characterId);
  const taskOverviewChanged = await applyTaskEvent(characterId, {
    type: 'dungeon_clear',
    dungeonId: did,
    difficultyId: diffId,
    count: c,
  });

  await updateSectionProgress(characterId, { type: 'dungeon_clear', dungeonId: did, difficultyId: diffId, count: c });

  const achievementProgressInputs: Array<{
    characterId: number;
    trackKey: string;
    increment: number;
  }> = [
    {
      characterId,
      trackKey: `dungeon:clear:${did}`,
      increment: c,
    },
  ];
  if (diffId) {
    const difficultyDef = getDungeonDifficultyById(diffId);
    const difficultyName = typeof difficultyDef?.name === 'string' ? difficultyDef.name.trim() : '';
    if (difficultyName === '噩梦') {
      achievementProgressInputs.push({
        characterId,
        trackKey: 'dungeon:clear:difficulty:nightmare',
        increment: c,
      });
    }
  }
  if (participantCount > 1) {
    achievementProgressInputs.push({
      characterId,
      trackKey: `team:dungeon:clear:${did}`,
      increment: c,
    });
  }
  await updateAchievementProgressBatch(achievementProgressInputs);
  if (taskOverviewChanged) {
    await notifyTaskOverviewUpdate(characterId, ['task']);
  }
};

export const recordCraftItemEvent = async (
  characterId: number,
  recipeId: string | undefined,
  craftKind: string | undefined,
  itemId: string | undefined,
  count: number,
  recipeType?: string,
): Promise<void> => {
  const rid = asNonEmptyString(recipeId) ?? undefined;
  const kind = asNonEmptyString(craftKind) ?? undefined;
  const iid = asNonEmptyString(itemId) ?? undefined;
  const rtype = asNonEmptyString(recipeType) ?? undefined;
  const c = normalizePositiveInt(count, 1);

  await resetRecurringTaskProgressIfNeeded(characterId);
  const taskOverviewChanged = await applyTaskEvent(characterId, {
    type: 'craft_item',
    recipeId: rid,
    recipeType: rtype,
    craftKind: kind,
    itemId: iid,
    count: c,
  });

  await updateSectionProgress(characterId, {
    type: 'craft_item',
    recipeId: rid,
    recipeType: rtype,
    craftKind: kind,
    itemId: iid,
    count: c,
  });

  if (rid) await updateAchievementProgress(characterId, `craft:recipe:${rid}`, c);
  if (kind) await updateAchievementProgress(characterId, `craft:kind:${kind}`, c);
  if (iid) await updateAchievementProgress(characterId, `craft:item:${iid}`, c);
  if (taskOverviewChanged) {
    await notifyTaskOverviewUpdate(characterId, ['task']);
  }
};

type NpcTalkTaskOption = {
  taskId: string;
  title: string;
  category: TaskCategory;
  status: 'locked' | 'available' | 'accepted' | 'turnin' | 'claimable' | 'claimed';
};

type NpcTalkMainQuestOption = {
  sectionId: string;
  sectionName: string;
  chapterName: string;
  status: 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';
  canStartDialogue: boolean;
  canComplete: boolean;
};

export const npcTalk = async (
  characterId: number,
  npcId: string,
): Promise<{
  success: boolean;
  message: string;
  data?: { 
    npcId: string; 
    npcName: string; 
    lines: string[]; 
    tasks: NpcTalkTaskOption[];
    mainQuest?: NpcTalkMainQuestOption;
  };
}> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);
  await ensureMainQuestProgressForNewChapters(cid);

  const npcDef = getNpcDefinitions().find((entry) => entry.enabled !== false && entry.id === nid);
  if (!npcDef) return { success: false, message: 'NPC不存在' };
  const npcName = String(npcDef.name || nid);
  const talkTreeId = asNonEmptyString(npcDef.talk_tree_id);

  await recordTalkNpcEvent(cid, nid);

  const mainQuestRes = await query(
    `SELECT current_section_id, section_status FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`,
    [cid],
  );
  const currentSectionId = asNonEmptyString(mainQuestRes.rows?.[0]?.current_section_id);
  const sectionStatus = (mainQuestRes.rows?.[0]?.section_status ?? 'not_started') as
    | 'not_started'
    | 'dialogue'
    | 'objectives'
    | 'turnin'
    | 'completed';

  let talkTreeLines: string[] = [];
  if (talkTreeId) {
    const talkTree = getTalkTreeDefinitions().find((entry) => entry.enabled !== false && entry.id === talkTreeId);
    if (talkTree && Array.isArray(talkTree.greeting_lines)) {
      talkTreeLines = talkTree.greeting_lines.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
  }
  const lines = resolveNpcTalkGreetingLines({
    npcId: nid,
    currentSectionId,
    currentSectionStatus: sectionStatus,
    talkTreeLines,
  });
  if (lines.length === 0) {
    lines.push(`${npcName}看着你，没有多说什么。`);
  }

  const taskDefs = await getTaskDefinitionsByNpcIds([nid]);
  const taskIds = taskDefs.map((entry) => entry.id);
  const progressRes =
    taskIds.length === 0
      ? { rows: [] as Array<Record<string, unknown>> }
      : await query(
          `
            SELECT task_id, status, progress
            FROM character_task_progress
            WHERE character_id = $1
              AND task_id = ANY($2::varchar[])
          `,
          [cid, taskIds],
        );
  const progressByTaskId = new Map<string, { status?: unknown; progress?: unknown }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, { status: row.status, progress: row.progress });
  }

  const tasks: NpcTalkTaskOption[] = [];
  for (const def of taskDefs) {
    if (!isTaskDefinitionUnlockedForCharacter(def, characterRealmState)) continue;
    const tid = asNonEmptyString(def.id);
    if (!tid) continue;
    const title = String(def.title ?? tid);
    const category = normalizeTaskCategory(def.category) ?? 'main';
    const progress = progressByTaskId.get(tid);
    const status = asTaskProgressStatusDb(progress?.status);

    const objectives = parseObjectives(def.objectives);
    const progressRecord = parseProgressRecord(progress?.progress);
    const allDone = computeAllObjectivesDone(objectives, progressRecord);

    if (!progress?.status) {
      const prereqTaskIds = asStringArray(def.prereq_task_ids);
      const prereqOk = await checkPrereqSatisfied(cid, prereqTaskIds);
      tasks.push({ taskId: tid, title, category, status: prereqOk ? 'available' : 'locked' });
      continue;
    }

    if (status === 'claimed') {
      tasks.push({ taskId: tid, title, category, status: 'claimed' });
      continue;
    }
    if (status === 'claimable') {
      tasks.push({ taskId: tid, title, category, status: 'claimable' });
      continue;
    }
    if ((status === 'turnin' && allDone) || (status === 'ongoing' && allDone)) {
      tasks.push({ taskId: tid, title, category, status: 'turnin' });
      continue;
    }
    tasks.push({ taskId: tid, title, category, status: 'accepted' });
  }

  // 查询主线任务
  let mainQuest: NpcTalkMainQuestOption | undefined;
  if (mainQuestRes.rows?.[0]) {
    const section = currentSectionId ? getMainQuestSectionById(currentSectionId) : null;
    const chapter = section ? getMainQuestChapterById(section.chapter_id) : null;
    if (section && section.enabled !== false && chapter && chapter.enabled !== false && section.npc_id === nid) {
      // 判断是否可以开始对话（未开始或对话中）
      const canStartDialogue = sectionStatus === 'not_started' || sectionStatus === 'dialogue';
      // 判断是否可以完成（可交付状态）
      const canComplete = sectionStatus === 'turnin';

      mainQuest = {
        sectionId: section.id,
        sectionName: String(section.name || section.id),
        chapterName: String(chapter.name || chapter.id),
        status: sectionStatus,
        canStartDialogue,
        canComplete,
      };
    }
  }

  return { success: true, message: 'ok', data: { npcId: nid, npcName, lines, tasks, mainQuest } };
};

/**
 * TaskService 类
 *
 * 作用：封装任务相关的核心业务逻辑，使用 @Transactional 装饰器管理事务
 *
 * 关键方法：
 * - claimTaskReward: 领取任务奖励（事务）
 * - recordCollectItemEvent: 记录收集物品事件（事务）
 *
 * 数据流：
 * - 输入：用户ID、角色ID、任务ID等业务参数
 * - 处理：校验状态、发放奖励、更新进度
 * - 输出：操作结果与奖励详情
 *
 * 边界条件：
 * - 使用 @Transactional 自动管理事务，无需手动 commit/rollback
 * - 所有 client.query 调用已替换为 query
 */
class TaskService {
  /**
   * 领取任务奖励
   *
   * @Transactional 自动管理事务边界
   *
   * 流程：
   * 1. 校验任务状态为 claimable
   * 2. 发放任务奖励（银两、灵石、物品）
   * 3. 发放悬赏奖励（如果有）
   * 4. 更新任务状态为 claimed
   */
  @Transactional
  async claimTaskReward(
    userId: number,
    characterId: number,
    taskId: string
  ): Promise<{ success: boolean; message: string; data?: { taskId: string; rewards: ClaimedRewardResult[] } }> {
    const uid = Number(userId);
    const cid = Number(characterId);
    if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
    const tid = asNonEmptyString(taskId);
    if (!tid) return { success: false, message: '任务ID不能为空' };

    const characterRealmState = await loadCharacterTaskRealmState(cid);
    if (!characterRealmState) return { success: false, message: '角色不存在' };
    await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

    const progressRes = await query(
      `SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 FOR UPDATE`,
      [cid, tid]
    );
    if ((progressRes.rows ?? []).length === 0) {
      return { success: false, message: '任务未接取' };
    }
    const status = asNonEmptyString(progressRes.rows[0]?.status) ?? 'ongoing';
    if (status !== 'claimable') {
      return { success: false, message: '任务不可领取' };
    }

    const taskDef = await getTaskDefinitionById(tid);
    if (!taskDef) {
      return { success: false, message: '任务不存在' };
    }
    const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
    if (unlockFailureMessage) {
      return { success: false, message: unlockFailureMessage };
    }

    const rewards = parseRewards(taskDef.rewards);
    const applyResult = await this.applyTaskRewards(uid, cid, rewards);
    if (!applyResult.success) {
      return { success: false, message: applyResult.message };
    }

    const bountyResult = await this.applyBountyRewardOnTaskClaim(cid, tid);
    if (bountyResult.rewards.length > 0) {
      applyResult.rewards.push(...bountyResult.rewards);
    }
    mergeCharacterRewardDelta(applyResult.rewardDelta, bountyResult.rewardDelta);
    await applyCharacterRewardDeltas(new Map([[cid, applyResult.rewardDelta]]));

    await query(
      `
        UPDATE character_task_progress
        SET status = 'claimed',
            completed_at = COALESCE(completed_at, NOW()),
            claimed_at = NOW(),
            tracked = false,
            updated_at = NOW()
        WHERE character_id = $1 AND task_id = $2
      `,
      [cid, tid]
    );
    return { success: true, message: 'ok', data: { taskId: tid, rewards: applyResult.rewards } };
  }

  /**
   * 应用任务奖励（内部方法，在事务中调用）
   */
  private async applyTaskRewards(
    userId: number,
    characterId: number,
    rewards: RawReward[]
  ): Promise<{ success: boolean; message: string; rewards: ClaimedRewardResult[]; rewardDelta: CharacterRewardDelta }> {
    const out: ClaimedRewardResult[] = [];
    const rewardDelta = createCharacterRewardDelta();

    for (const rw of rewards) {
      const type = asNonEmptyString(rw?.type) ?? '';
      if (type === 'silver') {
        const amount = asFiniteNonNegativeInt(rw?.amount, 0);
        if (amount <= 0) continue;
        appendClaimedCurrencyReward(out, rewardDelta, 'silver', amount);
        continue;
      }
      if (type === 'spirit_stones') {
        const amount = asFiniteNonNegativeInt(rw?.amount, 0);
        if (amount <= 0) continue;
        appendClaimedCurrencyReward(out, rewardDelta, 'spirit_stones', amount);
        continue;
      }
      if (type === 'item') {
        const itemDefId = asNonEmptyString(rw?.item_def_id);
        if (!itemDefId) continue;
        const qtyRange = resolveRewardQtyRange(rw);
        const qty = rollRangeIntInclusive(qtyRange.min, qtyRange.max);
        const itemMeta = resolveRewardItemDisplayMeta(itemDefId);
        const result = await itemService.createItem(userId, characterId, itemDefId, qty, { obtainedFrom: 'task_reward' });
        if (!result.success) return { success: false, message: result.message, rewards: out, rewardDelta };
        out.push({
          type: 'item',
          itemDefId,
          qty,
          itemIds: result.itemIds,
          itemName: itemMeta.name || undefined,
          itemIcon: itemMeta.icon || undefined,
        });
        continue;
      }
    }

    return { success: true, message: 'ok', rewards: out, rewardDelta };
  }

  /**
   * 应用悬赏奖励（内部方法，在事务中调用）
   */
  private async applyBountyRewardOnTaskClaim(
    characterId: number,
    taskId: string
  ): Promise<{ rewards: ClaimedRewardResult[]; rewardDelta: CharacterRewardDelta }> {
    const res = await query<BountyClaimRewardRow>(
      `
        SELECT
          c.id AS claim_id,
          i.spirit_stones_reward,
          i.silver_reward
        FROM bounty_claim c
        JOIN bounty_instance i ON i.id = c.bounty_instance_id
        WHERE c.character_id = $1
          AND i.task_id = $2
          AND c.status IN ('claimed','completed')
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, taskId]
    );
    if ((res.rows ?? []).length === 0) {
      return { rewards: [], rewardDelta: createCharacterRewardDelta() };
    }

    const row = res.rows[0];
    const claimId = Number(row?.claim_id);
    if (!Number.isFinite(claimId) || claimId <= 0) {
      return { rewards: [], rewardDelta: createCharacterRewardDelta() };
    }

    const out: ClaimedRewardResult[] = [];
    const rewardDelta = createCharacterRewardDelta();
    const spirit = asFiniteNonNegativeInt(row?.spirit_stones_reward, 0);
    const silver = asFiniteNonNegativeInt(row?.silver_reward, 0);

    if (spirit > 0) {
      appendClaimedCurrencyReward(out, rewardDelta, 'spirit_stones', spirit);
    }
    if (silver > 0) {
      appendClaimedCurrencyReward(out, rewardDelta, 'silver', silver);
    }

    await query(`UPDATE bounty_claim SET status = 'rewarded', updated_at = NOW() WHERE id = $1`, [claimId]);
    return { rewards: out, rewardDelta };
  }

  /**
   * 记录收集物品事件
   *
   * @Transactional 自动管理事务边界
   *
   * 流程：
   * 1. 更新主线任务进度
   * 2. 更新成就进度
   */
  @Transactional
  async recordCollectItemEvent(characterId: number, itemId: string, count: number): Promise<void> {
    await this.recordCollectItemEvents(characterId, [{ itemId, count }]);
  }

  /**
   * 批量记录收集物品事件。
   *
   * 作用：
   * 1. 把同一角色的一批收集事件聚合成一次主线推进和一次成就推进。
   * 2. 保持在同一事务中完成，避免结算链路里出现“主线已写、成就未写”的半成功状态。
   *
   * 边界条件：
   * 1. 重复 itemId 必须先合并，避免同一批次重复更新同一目标。
   * 2. 空事件或非法 itemId 直接忽略，和单条入口保持同一口径。
   */
  @Transactional
  async recordCollectItemEvents(characterId: number, events: CollectItemEventInput[]): Promise<void> {
    const normalizedEvents = normalizeCollectItemEvents(events);
    if (normalizedEvents.length <= 0) return;

    const characterRealmState = await loadCharacterTaskRealmState(characterId);
    if (!characterRealmState) return;

    await resetRecurringTaskProgressIfNeeded(characterId, undefined, characterRealmState);
    const taskOverviewChanged = await applyTaskEvents(
      characterId,
      normalizedEvents.map((event) => ({
        type: 'collect' as const,
        itemId: event.itemId,
        count: event.count,
      })),
      characterRealmState,
    );

    await updateSectionProgressBatch(
      characterId,
      normalizedEvents.map((event) => ({
        type: 'collect' as const,
        itemId: event.itemId,
        count: event.count,
      })),
    );

    await updateAchievementProgressBatch(
      normalizedEvents.map((event) => ({
        characterId,
        trackKey: `item:obtain:${event.itemId}`,
        increment: event.count,
      })),
    );

    if (taskOverviewChanged) {
      await notifyTaskOverviewUpdate(characterId, ['task']);
    }
  }
}

// 单例导出
export const taskService = new TaskService();
