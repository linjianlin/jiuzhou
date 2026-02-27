import { pool, query, withTransaction } from '../config/database.js';
import { createItem } from './itemService.js';
import type { PoolClient } from 'pg';
import { ensureMainQuestProgressForNewChapters, updateSectionProgress } from './mainQuest/index.js';
import { updateAchievementProgress } from './achievementService.js';
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getMainQuestChapterById,
  getMainQuestSectionById,
  getNpcDefinitions,
  getTalkTreeDefinitions,
} from './staticConfigLoader.js';
import {
  getStaticTaskDefinitions,
  getTaskDefinitionById,
  getTaskDefinitionsByIds,
  getTaskDefinitionsByNpcIds,
} from './taskDefinitionService.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';

export type TaskCategory = 'main' | 'side' | 'daily' | 'event';

type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

type TaskObjectiveDto = {
  id: string;
  type: string;
  text: string;
  done: number;
  target: number;
  params?: Record<string, unknown>;
};

type TaskRewardDto =
  | { type: 'silver'; name: string; amount: number }
  | { type: 'spirit_stones'; name: string; amount: number }
  | { type: 'item'; itemDefId: string; name: string; icon: string | null; amount: number; amountMax?: number };

type TaskOverviewDto = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId: string | null;
  mapId: string | null;
  roomId: string | null;
  status: TaskStatus;
  tracked: boolean;
  description: string;
  objectives: TaskObjectiveDto[];
  rewards: TaskRewardDto[];
};

type BountyTaskSourceType = 'daily' | 'player';

type BountyTaskOverviewDto = Omit<TaskOverviewDto, 'category'> & {
  category: 'bounty';
  bountyInstanceId: number;
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

type RawObjective = {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  target?: unknown;
  params?: unknown;
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

const getProgressValue = (progress: unknown, objectiveId: string): number => {
  if (!objectiveId) return 0;
  if (!progress || typeof progress !== 'object') return 0;
  const record = progress as Record<string, unknown>;
  return asFiniteNonNegativeInt(record[objectiveId], 0);
};

const computeRemainingSeconds = (expiresAt: unknown): number | null => {
  if (!expiresAt) return null;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
};

const resetRecurringTaskProgressIfNeeded = async (
  characterId: number,
  dbClient?: PoolClient,
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  const runner = dbClient ?? { query };
  const autoAcceptRecurringTaskIds = getStaticTaskDefinitions()
    .filter((entry) => entry.enabled && (entry.category === 'daily' || entry.category === 'event'))
    .map((entry) => entry.id)
    .filter((taskId) => taskId.trim().length > 0);

  if (autoAcceptRecurringTaskIds.length > 0) {
    // 日常/周常任务为自动接取：缺失进度行时自动补齐，避免首次必须手动“接取”。
    await runner.query(
      `
        INSERT INTO character_task_progress
          (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
        SELECT
          $1,
          daily_task.task_id,
          'ongoing',
          '{}'::jsonb,
          false,
          NOW(),
          NULL,
          NULL,
          NOW()
        FROM unnest($2::varchar[]) AS daily_task(task_id)
        ON CONFLICT (character_id, task_id) DO NOTHING
      `,
      [cid, autoAcceptRecurringTaskIds],
    );
  }

  const progressRes = await runner.query(
    `
      SELECT task_id
      FROM character_task_progress
      WHERE character_id = $1
    `,
    [cid],
  );

  const taskIds = (progressRes.rows as Array<Record<string, unknown>>)
    .map((row) => asNonEmptyString(row.task_id))
    .filter((taskId): taskId is string => Boolean(taskId));
  if (taskIds.length === 0) return;

  const taskDefMap = await getTaskDefinitionsByIds(taskIds, dbClient);
  const dailyTaskIds = new Set<string>();
  const eventTaskIds = new Set<string>();

  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef || !taskDef.enabled) continue;
    if (taskDef.category === 'daily') dailyTaskIds.add(taskId);
    if (taskDef.category === 'event') eventTaskIds.add(taskId);
  }

  const dailyIds = Array.from(dailyTaskIds);
  const eventIds = Array.from(eventTaskIds);
  if (dailyIds.length === 0 && eventIds.length === 0) return;

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
    [cid, dailyIds, eventIds],
  );
};

export const getTaskOverview = async (
  characterId: number,
  category?: TaskCategory
): Promise<{ tasks: TaskOverviewDto[] }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { tasks: [] };
  await resetRecurringTaskProgressIfNeeded(cid);

  const resolvedCategory = normalizeTaskCategory(category);
  const defs = getStaticTaskDefinitions().filter((entry) => {
    if (!entry.enabled) return false;
    if (resolvedCategory && entry.category !== resolvedCategory) return false;
    return true;
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

  const progressByTaskId = new Map<string, { progress_status: unknown; tracked: unknown; progress: unknown }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, {
      progress_status: row.progress_status,
      tracked: row.tracked,
      progress: row.progress,
    });
  }

  const rows = defs
    .sort((left, right) => left.category.localeCompare(right.category) || right.sort_weight - left.sort_weight || left.id.localeCompare(right.id))
    .map((def) => {
      const progress = progressByTaskId.get(def.id);
      return {
        id: def.id,
        category: def.category,
        title: def.title,
        realm: def.realm,
        giver_npc_id: def.giver_npc_id,
        map_id: def.map_id,
        room_id: def.room_id,
        description: def.description,
        objectives: def.objectives,
        rewards: def.rewards,
        progress_status: progress?.progress_status,
        tracked: progress?.tracked,
        progress: progress?.progress,
      };
    });

  const itemRewardIds = new Set<string>();
  for (const r of rows) {
    const rewards = parseRewards(r.rewards);
    for (const rw of rewards) {
      if (asNonEmptyString(rw?.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(rw?.item_def_id);
      if (itemDefId) itemRewardIds.add(itemDefId);
    }
  }

  const itemMeta = new Map<string, { name: string; icon: string | null }>();
  if (itemRewardIds.size > 0) {
    const ids = Array.from(itemRewardIds);
    const defs = getItemDefinitionsByIds(ids);
    for (const id of ids) {
      const def = defs.get(id);
      if (!def) continue;
      itemMeta.set(id, {
        name: String(def.name ?? id),
        icon: typeof def.icon === 'string' ? def.icon : null,
      });
    }
  }

  const tasks: TaskOverviewDto[] = rows
    .map((r) => {
      const id = asNonEmptyString(r.id) ?? '';
      const category = normalizeTaskCategory(r.category) ?? 'main';
      const title = String(r.title ?? id);
      const realm = asNonEmptyString(r.realm) ?? '凡人';
      const giverNpcId = asNonEmptyString(r.giver_npc_id);
      const mapId = asNonEmptyString(r.map_id);
      const roomId = asNonEmptyString(r.room_id);
      const description = String(r.description ?? '');
      const tracked = r.tracked === true;
      const status = mapProgressStatusToUiStatus(r.progress_status);

      const objectives = parseObjectives(r.objectives)
        .map((o) => {
          const oid = asNonEmptyString(o?.id) ?? '';
          const text = String(o?.text ?? '');
          const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
          const done = Math.min(target, getProgressValue(r.progress, oid));
          const type = String(o?.type ?? 'unknown');
          const paramsValue = o?.params;
          const params = paramsValue && typeof paramsValue === 'object' ? (paramsValue as Record<string, unknown>) : undefined;
          return { id: oid, type, text, done, target, ...(params ? { params } : {}) };
        })
        .filter((x) => x.text);

      const rewards = parseRewards(r.rewards)
        .map((rw): TaskRewardDto | null => {
          const type = asNonEmptyString(rw?.type) ?? '';
          if (type === 'silver') {
            return { type: 'silver', name: '银两', amount: asFiniteNonNegativeInt(rw?.amount, 0) };
          }
          if (type === 'spirit_stones') {
            return { type: 'spirit_stones', name: '灵石', amount: asFiniteNonNegativeInt(rw?.amount, 0) };
          }
          if (type === 'item') {
            const itemDefId = asNonEmptyString(rw?.item_def_id);
            if (!itemDefId) return null;
            const qtyRange = resolveRewardQtyRange(rw);
            const meta = itemMeta.get(itemDefId) ?? { name: itemDefId, icon: null };
            const amountMax = qtyRange.max > qtyRange.min ? qtyRange.max : undefined;
            return {
              type: 'item',
              itemDefId,
              name: meta.name,
              icon: meta.icon,
              amount: qtyRange.min,
              ...(amountMax ? { amountMax } : {}),
            };
          }
          return null;
        })
        .filter((x): x is TaskRewardDto => x !== null && x.amount > 0);

      return { id, category, title, realm, giverNpcId, mapId, roomId, status, tracked, description, objectives, rewards };
    })
    .filter((t) => t.id);

  return { tasks };
};

export const getBountyTaskOverview = async (characterId: number): Promise<{ tasks: BountyTaskOverviewDto[] }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { tasks: [] };
  await resetRecurringTaskProgressIfNeeded(cid);

  await query(
    `
      DELETE FROM bounty_instance
      WHERE source_type = 'daily'
        AND (
          (expires_at IS NOT NULL AND expires_at <= NOW())
          OR (refresh_date IS NOT NULL AND refresh_date < CURRENT_DATE)
        )
    `,
  );

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
          OR i.expires_at IS NULL
          OR i.expires_at > NOW()
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

  const rows = (res.rows ?? []) as Array<{
    bounty_instance_id: unknown;
    source_type: unknown;
    task_id: unknown;
    bounty_title: unknown;
    bounty_description: unknown;
    expires_at: unknown;
    spirit_stones_reward: unknown;
    silver_reward: unknown;
    progress_status: unknown;
    tracked: unknown;
    progress: unknown;
  }>;

  const taskDefMap = await getTaskDefinitionsByIds(
    rows
      .map((row) => asNonEmptyString(row.task_id))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );

  const itemRewardIds = new Set<string>();
  for (const r of rows) {
    const taskId = asNonEmptyString(r.task_id);
    if (!taskId) continue;
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef) continue;
    const rewards = parseRewards(taskDef.rewards);
    for (const rw of rewards) {
      if (asNonEmptyString(rw?.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(rw?.item_def_id);
      if (itemDefId) itemRewardIds.add(itemDefId);
    }
  }

  const itemMeta = new Map<string, { name: string; icon: string | null }>();
  if (itemRewardIds.size > 0) {
    const ids = Array.from(itemRewardIds);
    const defs = getItemDefinitionsByIds(ids);
    for (const id of ids) {
      const def = defs.get(id);
      if (!def) continue;
      itemMeta.set(id, {
        name: String(def.name ?? id),
        icon: typeof def.icon === 'string' ? def.icon : null,
      });
    }
  }

  const tasks: BountyTaskOverviewDto[] = rows
    .map((r) => {
      const taskId = asNonEmptyString(r.task_id) ?? '';
      if (!taskId) return null;

      const bountyInstanceIdRaw = typeof r.bounty_instance_id === 'number' ? r.bounty_instance_id : Number(r.bounty_instance_id);
      const bountyInstanceId = Number.isFinite(bountyInstanceIdRaw) ? Math.trunc(bountyInstanceIdRaw) : 0;
      const sourceType = (asNonEmptyString(r.source_type) ?? 'daily') as BountyTaskSourceType;
      const expiresAt = r.expires_at ? new Date(r.expires_at as any).toISOString() : null;
      const remainingSeconds = computeRemainingSeconds(expiresAt);

      const title = String(r.bounty_title ?? taskId);
      const taskDef = taskDefMap.get(taskId);
      if (!taskDef) return null;
      const realm = taskDef.realm ?? '凡人';
      const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
      const mapId = taskDef.map_id;
      const roomId = taskDef.room_id;
      const description = String(r.bounty_description ?? '');
      const tracked = r.tracked === true;
      const status = mapProgressStatusToUiStatus(r.progress_status);

      const objectives = parseObjectives(taskDef.objectives)
        .map((o) => {
          const oid = asNonEmptyString(o?.id) ?? '';
          const text = String(o?.text ?? '');
          const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
          const done = Math.min(target, getProgressValue(r.progress, oid));
          const type = String(o?.type ?? 'unknown');
          const paramsValue = o?.params;
          const params = paramsValue && typeof paramsValue === 'object' ? (paramsValue as Record<string, unknown>) : undefined;
          return { id: oid, type, text, done, target, ...(params ? { params } : {}) };
        })
        .filter((x) => x.text);

      const rewardOut: TaskRewardDto[] = [];
      const extraSpirit = asFiniteNonNegativeInt(r.spirit_stones_reward, 0);
      const extraSilver = asFiniteNonNegativeInt(r.silver_reward, 0);
      if (extraSilver > 0) rewardOut.push({ type: 'silver', name: '银两', amount: extraSilver });
      if (extraSpirit > 0) rewardOut.push({ type: 'spirit_stones', name: '灵石', amount: extraSpirit });

      const taskRewards = parseRewards(taskDef.rewards)
        .map((rw): TaskRewardDto | null => {
          const type = asNonEmptyString(rw?.type) ?? '';
          if (type === 'silver') return { type: 'silver', name: '银两', amount: asFiniteNonNegativeInt(rw?.amount, 0) };
          if (type === 'spirit_stones') return { type: 'spirit_stones', name: '灵石', amount: asFiniteNonNegativeInt(rw?.amount, 0) };
          if (type === 'item') {
            const itemDefId = asNonEmptyString(rw?.item_def_id);
            if (!itemDefId) return null;
            const qtyRange = resolveRewardQtyRange(rw);
            const meta = itemMeta.get(itemDefId) ?? { name: itemDefId, icon: null };
            const amountMax = qtyRange.max > qtyRange.min ? qtyRange.max : undefined;
            return {
              type: 'item',
              itemDefId,
              name: meta.name,
              icon: meta.icon,
              amount: qtyRange.min,
              ...(amountMax ? { amountMax } : {}),
            };
          }
          return null;
        })
        .filter((x): x is TaskRewardDto => x !== null && x.amount > 0);

      rewardOut.push(...taskRewards);

      return {
        id: taskId,
        category: 'bounty',
        title,
        realm,
        giverNpcId,
        mapId,
        roomId,
        status,
        tracked,
        description,
        objectives,
        rewards: rewardOut,
        bountyInstanceId,
        sourceType,
        expiresAt,
        remainingSeconds,
      };
    })
    .filter((x): x is BountyTaskOverviewDto => x !== null);

  return { tasks };
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

const applyTaskRewardsTx = async (
  client: PoolClient,
  userId: number,
  characterId: number,
  rewards: RawReward[]
): Promise<{ success: boolean; message: string; rewards: ClaimedRewardResult[] }> => {
  const out: ClaimedRewardResult[] = [];

  for (const rw of rewards) {
    const type = asNonEmptyString(rw?.type) ?? '';
    if (type === 'silver') {
      const amount = asFiniteNonNegativeInt(rw?.amount, 0);
      if (amount <= 0) continue;
      await client.query(`UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`, [amount, characterId]);
      out.push({ type: 'silver', amount });
      continue;
    }
    if (type === 'spirit_stones') {
      const amount = asFiniteNonNegativeInt(rw?.amount, 0);
      if (amount <= 0) continue;
      await client.query(`UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`, [amount, characterId]);
      out.push({ type: 'spirit_stones', amount });
      continue;
    }
    if (type === 'item') {
      const itemDefId = asNonEmptyString(rw?.item_def_id);
      if (!itemDefId) continue;
      const qtyRange = resolveRewardQtyRange(rw);
      const qty = rollRangeIntInclusive(qtyRange.min, qtyRange.max);
      const itemDef = getItemDefinitionById(itemDefId);
      const itemName = asNonEmptyString(itemDef?.name);
      const itemIcon = asNonEmptyString(itemDef?.icon);
      const result = await createItem(userId, characterId, itemDefId, qty, { dbClient: client, obtainedFrom: 'task_reward' });
      if (!result.success) return { success: false, message: result.message, rewards: out };
      out.push({
        type: 'item',
        itemDefId,
        qty,
        itemIds: result.itemIds,
        itemName: itemName || undefined,
        itemIcon: itemIcon || undefined,
      });
      continue;
    }
  }

  return { success: true, message: 'ok', rewards: out };
};

const applyBountyRewardOnTaskClaimTx = async (
  client: PoolClient,
  characterId: number,
  taskId: string
): Promise<ClaimedRewardResult[]> => {
  const res = await client.query(
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
  if ((res.rows ?? []).length === 0) return [];

  const row = res.rows[0] as any;
  const claimId = Number(row?.claim_id);
  if (!Number.isFinite(claimId) || claimId <= 0) return [];

  const spirit = asFiniteNonNegativeInt(row?.spirit_stones_reward, 0);
  const silver = asFiniteNonNegativeInt(row?.silver_reward, 0);
  const out: ClaimedRewardResult[] = [];

  if (spirit > 0) {
    await client.query(`UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`, [
      spirit,
      characterId,
    ]);
    out.push({ type: 'spirit_stones', amount: spirit });
  }
  if (silver > 0) {
    await client.query(`UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`, [silver, characterId]);
    out.push({ type: 'silver', amount: silver });
  }

  await client.query(`UPDATE bounty_claim SET status = 'rewarded', updated_at = NOW() WHERE id = $1`, [claimId]);
  return out;
};

export const claimTaskReward = async (
  userId: number,
  characterId: number,
  taskId: string
): Promise<{ success: boolean; message: string; data?: { taskId: string; rewards: ClaimedRewardResult[] } }> => {
  const uid = Number(userId);
  const cid = Number(characterId);
  if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };

  try {
    return await withTransaction(async (client) => {
  await resetRecurringTaskProgressIfNeeded(cid, client);
  
      const progressRes = await client.query(
        `SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 FOR UPDATE`,
        [cid, tid]
      );
      if ((progressRes.rows ?? []).length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '任务未接取' };
      }
      const status = asNonEmptyString(progressRes.rows[0]?.status) ?? 'ongoing';
      if (status !== 'claimable') {
        await client.query('ROLLBACK');
        return { success: false, message: '任务不可领取' };
      }
  
      const taskDef = await getTaskDefinitionById(tid, client);
      if (!taskDef) {
        await client.query('ROLLBACK');
        return { success: false, message: '任务不存在' };
      }
  
      const rewards = parseRewards(taskDef.rewards);
      const applyResult = await applyTaskRewardsTx(client, uid, cid, rewards);
      if (!applyResult.success) {
        await client.query('ROLLBACK');
        return { success: false, message: applyResult.message };
      }
  
      const bountyRewards = await applyBountyRewardOnTaskClaimTx(client, cid, tid);
      if (bountyRewards.length > 0) applyResult.rewards.push(...bountyRewards);
  
      await client.query(
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
    });
  } catch (error) {
console.error('领取任务奖励失败:', error);
    return { success: false, message: '服务器错误' };
  }
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

type TaskEvent =
  | { type: 'talk_npc'; npcId: string }
  | { type: 'kill_monster'; monsterId: string; count: number }
  | { type: 'gather_resource'; resourceId: string; count: number }
  | { type: 'dungeon_clear'; dungeonId: string; difficultyId?: string; count: number }
  | { type: 'craft_item'; recipeId?: string; recipeType?: string; craftKind?: string; itemId?: string; count: number };

const objectiveMatchesEvent = (
  objective: RawObjective,
  event: TaskEvent,
): { matched: boolean; delta: number } => {
  const type = String(objective?.type ?? '').trim();
  const params = objective?.params && typeof objective.params === 'object' ? (objective.params as Record<string, unknown>) : {};
  if (event.type === 'talk_npc') {
    if (type !== 'talk_npc') return { matched: false, delta: 0 };
    const npcId = asNonEmptyString(params?.npc_id);
    if (!npcId || npcId !== event.npcId) return { matched: false, delta: 0 };
    return { matched: true, delta: 1 };
  }
  if (event.type === 'kill_monster') {
    if (type !== 'kill_monster') return { matched: false, delta: 0 };
    const monsterId = asNonEmptyString(params?.monster_id);
    if (!monsterId || monsterId !== event.monsterId) return { matched: false, delta: 0 };
    return { matched: true, delta: Math.max(1, Math.floor(event.count)) };
  }
  if (event.type === 'gather_resource') {
    if (type !== 'gather_resource') return { matched: false, delta: 0 };
    const resourceId = asNonEmptyString(params?.resource_id);
    if (!resourceId || resourceId !== event.resourceId) return { matched: false, delta: 0 };
    return { matched: true, delta: Math.max(1, Math.floor(event.count)) };
  }
  if (event.type === 'dungeon_clear') {
    if (type !== 'dungeon_clear') return { matched: false, delta: 0 };
    const dungeonId = asNonEmptyString(params?.dungeon_id);
    if (dungeonId && dungeonId !== event.dungeonId) return { matched: false, delta: 0 };

    const difficultyId = asNonEmptyString(params?.difficulty_id);
    if (difficultyId && (!event.difficultyId || difficultyId !== event.difficultyId)) {
      return { matched: false, delta: 0 };
    }

    return { matched: true, delta: Math.max(1, Math.floor(event.count)) };
  }
  if (event.type === 'craft_item') {
    if (type !== 'craft_item') return { matched: false, delta: 0 };
    const recipeId = asNonEmptyString(params?.recipe_id);
    if (recipeId && recipeId !== asNonEmptyString(event.recipeId)) return { matched: false, delta: 0 };
    const recipeType = asNonEmptyString(params?.recipe_type);
    if (recipeType && recipeType !== asNonEmptyString(event.recipeType)) return { matched: false, delta: 0 };
    const craftKind = asNonEmptyString(params?.craft_kind);
    if (craftKind && craftKind !== asNonEmptyString(event.craftKind)) return { matched: false, delta: 0 };
    const itemId = asNonEmptyString(params?.item_id);
    if (itemId && itemId !== asNonEmptyString(event.itemId)) return { matched: false, delta: 0 };
    return { matched: true, delta: Math.max(1, Math.floor(event.count)) };
  }
  return { matched: false, delta: 0 };
};

const computeAllObjectivesDone = (objectives: RawObjective[], progressRecord: Record<string, number>): boolean => {
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
  await resetRecurringTaskProgressIfNeeded(cid);

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
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
  await resetRecurringTaskProgressIfNeeded(cid);

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
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;

  const eventTaskDefs = getStaticTaskDefinitions().filter((def) => def.enabled && def.category === 'event');
  for (const eventTaskDef of eventTaskDefs) {
    await query(
      `
        INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
        VALUES ($1, $2, 'ongoing', '{}'::jsonb, true, NOW(), NULL, NULL, NOW())
        ON CONFLICT (character_id, task_id) DO NOTHING
      `,
      [cid, eventTaskDef.id],
    );
  }

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

  for (const row of res.rows ?? []) {
    const taskId = asNonEmptyString(row?.task_id);
    if (!taskId) continue;
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef) continue;
    const status = asTaskProgressStatusDb(row?.status);
    if (status === 'claimed') continue;

    const objectives = parseObjectives(taskDef.objectives);
    const progressRecord = parseProgressRecord(row?.progress);
    const category = normalizeTaskCategory(taskDef.category) ?? 'main';

    let changed = false;
    for (const o of objectives) {
      const oid = asNonEmptyString(o?.id);
      if (!oid) continue;
      const match = objectiveMatchesEvent(o, event);
      if (!match.matched) continue;
      const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
      const cur = asFiniteNonNegativeInt(progressRecord[oid], 0);
      const next = Math.min(target, cur + match.delta);
      if (next !== cur) {
        progressRecord[oid] = next;
        changed = true;
      }
    }

    const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
    const allDone = computeAllObjectivesDone(objectives, progressRecord);

    let nextStatus: TaskProgressStatusDb = status;
    let promoteToClaimable = false;
    if (event.type === 'talk_npc' && giverNpcId && giverNpcId === event.npcId) {
      if (status === 'turnin' && allDone) promoteToClaimable = true;
    }
    if (allDone) {
      if (category === 'event') {
        nextStatus = 'claimable';
      } else {
        if (status === 'ongoing') nextStatus = 'turnin';
        if (promoteToClaimable) nextStatus = 'claimable';
      }
    }

    if (!changed && nextStatus === status) continue;

    await query(
      `
        UPDATE character_task_progress
        SET progress = $3::jsonb,
            status = $4::varchar(16),
            completed_at = CASE WHEN $4::varchar(16) = 'claimable'::varchar(16) THEN COALESCE(completed_at, NOW()) ELSE completed_at END,
            updated_at = NOW()
        WHERE character_id = $1 AND task_id = $2
      `,
      [cid, taskId, JSON.stringify(progressRecord), nextStatus],
    );
  }
};

const normalizePositiveInt = (value: unknown, fallback = 1): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floor = Math.floor(n);
  return floor > 0 ? floor : fallback;
};

const recordTalkNpcEvent = async (characterId: number, npcId: string): Promise<void> => {
  const nid = asNonEmptyString(npcId);
  if (!nid) return;

  try {
    await applyTaskEvent(characterId, { type: 'talk_npc', npcId: nid });
  } catch (error) {
    console.error('记录任务事件（对话）失败:', error);
  }

  try {
    await updateSectionProgress(characterId, { type: 'talk_npc', npcId: nid });
  } catch (error) {
    console.error('记录主线事件（对话）失败:', error);
  }

  try {
    await updateAchievementProgress(characterId, `talk:npc:${nid}`, 1);
  } catch (error) {
    console.error('记录成就事件（对话）失败:', error);
  }
};

export const recordKillMonsterEvent = async (characterId: number, monsterId: string, count: number): Promise<void> => {
  const mid = asNonEmptyString(monsterId);
  if (!mid) return;
  const c = normalizePositiveInt(count, 1);

  try {
    await applyTaskEvent(characterId, { type: 'kill_monster', monsterId: mid, count: c });
  } catch (error) {
    console.error('记录任务事件（击杀）失败:', error);
  }

  try {
    await updateSectionProgress(characterId, { type: 'kill_monster', monsterId: mid, count: c });
  } catch (error) {
    console.error('记录主线事件（击杀）失败:', error);
  }

  try {
    await updateAchievementProgress(characterId, `kill:monster:${mid}`, c);
  } catch (error) {
    console.error('记录成就事件（击杀）失败:', error);
  }
};

export const recordGatherResourceEvent = async (characterId: number, resourceId: string, count: number): Promise<void> => {
  const rid = asNonEmptyString(resourceId);
  if (!rid) return;
  const c = normalizePositiveInt(count, 1);

  try {
    await applyTaskEvent(characterId, { type: 'gather_resource', resourceId: rid, count: c });
  } catch (error) {
    console.error('记录任务事件（采集）失败:', error);
  }

  try {
    await updateSectionProgress(characterId, { type: 'gather_resource', resourceId: rid, count: c });
    await updateSectionProgress(characterId, { type: 'collect', itemId: rid, count: c });
  } catch (error) {
    console.error('记录主线事件（采集）失败:', error);
  }

  try {
    await updateAchievementProgress(characterId, `gather:resource:${rid}`, c);
    await updateAchievementProgress(characterId, `item:obtain:${rid}`, c);
  } catch (error) {
    console.error('记录成就事件（采集）失败:', error);
  }
};

export const recordCollectItemEvent = async (characterId: number, itemId: string, count: number): Promise<void> => {
  const iid = asNonEmptyString(itemId);
  if (!iid) return;
  const c = normalizePositiveInt(count, 1);

  try {
    await updateSectionProgress(characterId, { type: 'collect', itemId: iid, count: c });
  } catch (error) {
    console.error('记录主线事件（收集）失败:', error);
  }

  try {
    await updateAchievementProgress(characterId, `item:obtain:${iid}`, c);
  } catch (error) {
    console.error('记录成就事件（收集）失败:', error);
  }
};

export const recordDungeonClearEvent = async (
  characterId: number,
  dungeonId: string,
  count: number,
  difficultyId?: string,
): Promise<void> => {
  const did = asNonEmptyString(dungeonId);
  if (!did) return;
  const diffId = asNonEmptyString(difficultyId) ?? undefined;
  const c = normalizePositiveInt(count, 1);

  try {
    await resetRecurringTaskProgressIfNeeded(characterId);
    await applyTaskEvent(characterId, { type: 'dungeon_clear', dungeonId: did, difficultyId: diffId, count: c });
  } catch (error) {
    console.error('记录任务事件（秘境通关）失败:', error);
  }

  try {
    await updateSectionProgress(characterId, { type: 'dungeon_clear', dungeonId: did, difficultyId: diffId, count: c });
  } catch (error) {
    console.error('记录主线事件（秘境通关）失败:', error);
  }

  try {
    await updateAchievementProgress(characterId, `dungeon:clear:${did}`, c);
  } catch (error) {
    console.error('记录成就事件（秘境通关）失败:', error);
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

  try {
    await resetRecurringTaskProgressIfNeeded(characterId);
    await applyTaskEvent(characterId, {
      type: 'craft_item',
      recipeId: rid,
      recipeType: rtype,
      craftKind: kind,
      itemId: iid,
      count: c,
    });
  } catch (error) {
    console.error('记录任务事件（炼制）失败:', error);
  }

  try {
    await updateSectionProgress(characterId, {
      type: 'craft_item',
      recipeId: rid,
      recipeType: rtype,
      craftKind: kind,
      itemId: iid,
      count: c,
    });
  } catch (error) {
    console.error('记录主线事件（炼制）失败:', error);
  }

  try {
    if (rid) await updateAchievementProgress(characterId, `craft:recipe:${rid}`, c);
    if (kind) await updateAchievementProgress(characterId, `craft:kind:${kind}`, c);
    if (iid) await updateAchievementProgress(characterId, `craft:item:${iid}`, c);
  } catch (error) {
    console.error('记录成就事件（炼制）失败:', error);
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
  await resetRecurringTaskProgressIfNeeded(cid);
  await ensureMainQuestProgressForNewChapters(cid);

  const npcDef = getNpcDefinitions().find((entry) => entry.enabled !== false && entry.id === nid);
  if (!npcDef) return { success: false, message: 'NPC不存在' };
  const npcName = String(npcDef.name || nid);
  const talkTreeId = asNonEmptyString(npcDef.talk_tree_id);

  await recordTalkNpcEvent(cid, nid);

  const lines: string[] = [];
  if (talkTreeId) {
    const talkTree = getTalkTreeDefinitions().find((entry) => entry.enabled !== false && entry.id === talkTreeId);
    if (talkTree && Array.isArray(talkTree.greeting_lines)) {
      lines.push(...talkTree.greeting_lines.map((x) => String(x ?? '').trim()).filter(Boolean));
    }
  }
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
  const mainQuestRes = await query(
    `SELECT current_section_id, section_status FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`,
    [cid],
  );

  if (mainQuestRes.rows?.[0]) {
    const currentSectionId = asNonEmptyString(mainQuestRes.rows[0].current_section_id);
    const section = currentSectionId ? getMainQuestSectionById(currentSectionId) : null;
    const chapter = section ? getMainQuestChapterById(section.chapter_id) : null;
    if (section && section.enabled !== false && chapter && chapter.enabled !== false && section.npc_id === nid) {
      const sectionStatus = (mainQuestRes.rows[0].section_status ?? 'not_started') as
        | 'not_started'
        | 'dialogue'
        | 'objectives'
        | 'turnin'
        | 'completed';

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
