import { query } from '../config/database.js';
import type { PoolClient } from 'pg';
import { getTaskDefinitions, type TaskDefConfig } from './staticConfigLoader.js';

export type TaskDefinition = {
  id: string;
  category: string;
  title: string;
  realm: string;
  description: string;
  giver_npc_id: string | null;
  map_id: string | null;
  room_id: string | null;
  objectives: unknown[];
  rewards: unknown[];
  prereq_task_ids: string[];
  enabled: boolean;
  sort_weight: number;
  version: number;
  source: 'static' | 'dynamic';
};

type QueryRunner = Pick<PoolClient, 'query'>;

const DYNAMIC_TASK_ID_PREFIX = 'task-bounty-';

const isDynamicTaskId = (taskId: string): boolean => taskId.startsWith(DYNAMIC_TASK_ID_PREFIX);

const toStaticTaskDefinition = (task: TaskDefConfig): TaskDefinition => {
  return {
    id: String(task.id),
    category: String(task.category || 'main'),
    title: String(task.title || task.id),
    realm: String(task.realm || '凡人'),
    description: String(task.description || ''),
    giver_npc_id: typeof task.giver_npc_id === 'string' && task.giver_npc_id.trim() ? task.giver_npc_id.trim() : null,
    map_id: typeof task.map_id === 'string' && task.map_id.trim() ? task.map_id.trim() : null,
    room_id: typeof task.room_id === 'string' && task.room_id.trim() ? task.room_id.trim() : null,
    objectives: Array.isArray(task.objectives) ? task.objectives : [],
    rewards: Array.isArray(task.rewards) ? task.rewards : [],
    prereq_task_ids: Array.isArray(task.prereq_task_ids)
      ? task.prereq_task_ids.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0)
      : [],
    enabled: task.enabled !== false,
    sort_weight: Number.isFinite(Number(task.sort_weight)) ? Number(task.sort_weight) : 0,
    version: Number.isFinite(Number(task.version)) ? Number(task.version) : 1,
    source: 'static',
  };
};

const toDynamicTaskDefinition = (row: Record<string, unknown>): TaskDefinition => {
  return {
    id: String(row.id || ''),
    category: String(row.category || 'main'),
    title: String(row.title || row.id || ''),
    realm: String(row.realm || '凡人'),
    description: String(row.description || ''),
    giver_npc_id: typeof row.giver_npc_id === 'string' && row.giver_npc_id.trim() ? row.giver_npc_id.trim() : null,
    map_id: typeof row.map_id === 'string' && row.map_id.trim() ? row.map_id.trim() : null,
    room_id: typeof row.room_id === 'string' && row.room_id.trim() ? row.room_id.trim() : null,
    objectives: Array.isArray(row.objectives) ? row.objectives : [],
    rewards: Array.isArray(row.rewards) ? row.rewards : [],
    prereq_task_ids: Array.isArray(row.prereq_task_ids)
      ? row.prereq_task_ids.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0)
      : [],
    enabled: row.enabled !== false,
    sort_weight: Number.isFinite(Number(row.sort_weight)) ? Number(row.sort_weight) : 0,
    version: Number.isFinite(Number(row.version)) ? Number(row.version) : 1,
    source: 'dynamic',
  };
};

const getStaticTaskDefinitionSnapshot = (): { enabledMap: Map<string, TaskDefinition>; allIds: Set<string> } => {
  const enabledMap = new Map<string, TaskDefinition>();
  const allIds = new Set<string>();
  for (const task of getTaskDefinitions()) {
    const normalized = toStaticTaskDefinition(task);
    if (!normalized.id) continue;
    allIds.add(normalized.id);
    if (!normalized.enabled) continue;
    enabledMap.set(normalized.id, normalized);
  }
  return { enabledMap, allIds };
};

export const getStaticTaskDefinitions = (): TaskDefinition[] => {
  return Array.from(getStaticTaskDefinitionSnapshot().enabledMap.values()).sort(
    (left, right) => right.sort_weight - left.sort_weight || left.id.localeCompare(right.id),
  );
};

export const getTaskDefinitionById = async (
  taskId: string,
  runner?: QueryRunner,
): Promise<TaskDefinition | null> => {
  const id = String(taskId || '').trim();
  if (!id) return null;

  const staticSnapshot = getStaticTaskDefinitionSnapshot();
  const staticDef = staticSnapshot.enabledMap.get(id);
  if (staticDef) return staticDef;
  if (staticSnapshot.allIds.has(id)) return null;
  if (!isDynamicTaskId(id)) return null;

  const db = runner ?? { query };
  const res = await db.query(
    `
      SELECT id, category, title, realm, description, giver_npc_id, map_id, room_id,
             objectives, rewards, prereq_task_ids, enabled, sort_weight, version
      FROM task_def
      WHERE id = $1 AND enabled = true
      LIMIT 1
    `,
    [id],
  );

  const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  return row ? toDynamicTaskDefinition(row) : null;
};

export const getTaskDefinitionsByIds = async (
  taskIds: string[],
  runner?: QueryRunner,
): Promise<Map<string, TaskDefinition>> => {
  const ids = Array.from(new Set(taskIds.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0)));
  const out = new Map<string, TaskDefinition>();
  if (ids.length === 0) return out;

  const staticSnapshot = getStaticTaskDefinitionSnapshot();
  const missing: string[] = [];
  for (const id of ids) {
    const staticDef = staticSnapshot.enabledMap.get(id);
    if (staticDef) {
      out.set(id, staticDef);
    } else {
      if (staticSnapshot.allIds.has(id)) continue;
      if (!isDynamicTaskId(id)) continue;
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    const db = runner ?? { query };
    const res = await db.query(
      `
        SELECT id, category, title, realm, description, giver_npc_id, map_id, room_id,
               objectives, rewards, prereq_task_ids, enabled, sort_weight, version
        FROM task_def
        WHERE enabled = true AND id = ANY($1::varchar[])
      `,
      [missing],
    );

    for (const row of res.rows as Array<Record<string, unknown>>) {
      const normalized = toDynamicTaskDefinition(row);
      if (!normalized.id || !normalized.enabled) continue;
      out.set(normalized.id, normalized);
    }
  }

  return out;
};

export const getTaskDefinitionsByNpcIds = async (
  npcIds: string[],
  runner?: QueryRunner,
): Promise<TaskDefinition[]> => {
  void runner;
  const ids = Array.from(new Set(npcIds.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0)));
  if (ids.length === 0) return [];

  const out = new Map<string, TaskDefinition>();
  for (const task of getStaticTaskDefinitionSnapshot().enabledMap.values()) {
    if (!task.giver_npc_id) continue;
    if (!ids.includes(task.giver_npc_id)) continue;
    out.set(task.id, task);
  }

  return Array.from(out.values()).sort((left, right) => right.sort_weight - left.sort_weight || left.id.localeCompare(right.id));
};
