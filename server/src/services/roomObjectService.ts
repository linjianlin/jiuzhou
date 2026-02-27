import { pool, query, withTransaction } from '../config/database.js';
import type { GridPosition, MapRoom } from './mapService.js';
import { getRoomInMap } from './mapService.js';
import { getGameServer } from '../game/gameServer.js';
import { addItemToInventoryTx } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { recordGatherResourceEvent } from './taskService.js';
import {
  getItemDefinitionsByIds,
  getMainQuestSectionById,
  getNpcDefinitions,
  getMonsterDefinitions,
  getSpawnRuleDefinitions,
} from './staticConfigLoader.js';
import { getTaskDefinitionsByIds, getTaskDefinitionsByNpcIds } from './taskDefinitionService.js';
import { getCharacterIdByUserId } from './shared/characterId.js';

export type MapObjectDto =
  | {
      type: 'npc';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'monster';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      base_attrs?: Record<string, number>;
      attr_variance?: number;
      attr_multiplier_min?: number;
      attr_multiplier_max?: number;
      stats?: Array<{ label: string; value: string | number }>;
      drops?: Array<{ name: string; quality: string; chance: string }>;
    }
  | {
      type: 'item';
      id: string;
      object_kind?: 'resource' | 'item' | 'board';
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      resource?: {
        collectLimit: number;
        usedCount: number;
        remaining: number;
        cooldownSec: number;
        respawnSec: number;
        cooldownUntil?: string | null;
      };
      name: string;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      desc?: string;
      stats?: Array<{ label: string; value: string | number }>;
    }
  | {
      type: 'player';
      id: string;
      name: string;
      task_marker?: '!' | '?';
      task_tracked?: boolean;
      title?: string;
      gender?: string;
      realm?: string;
      avatar?: string | null;
      equipment?: Array<{ slot: string; name: string; quality: string }>;
      techniques?: Array<{ name: string; level: string; type: string }>;
    };

type NpcLiteRow = {
  id: string;
  name: string;
  title: string | null;
  gender: string | null;
  realm: string | null;
  avatar: string | null;
  description: string | null;
};

type MonsterLiteRow = {
  id: string;
  name: string;
  title: string | null;
  realm: string | null;
  avatar: string | null;
  base_attrs: unknown;
  attr_variance: unknown;
  attr_multiplier_min: unknown;
  attr_multiplier_max: unknown;
  display_stats: unknown;
};

type ItemLiteRow = {
  id: string;
  name: string;
  quality: string | null;
  icon: string | null;
  description: string | null;
};

const asStatList = (value: unknown): Array<{ label: string; value: string | number }> | undefined => {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as Array<{ label: string; value: string | number }>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Array<{ label: string; value: string | number }>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const asNumberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!value) return undefined;
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const getNpcLiteByIds = async (ids: string[]): Promise<Map<string, NpcLiteRow>> => {
  if (ids.length === 0) return new Map();
  const idSet = new Set(ids);
  const rows = getNpcDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => idSet.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title ?? null,
      gender: entry.gender ?? null,
      realm: entry.realm ?? null,
      avatar: entry.avatar ?? null,
      description: entry.description ?? null,
    } satisfies NpcLiteRow));
  return new Map(rows.map((row) => [row.id, row]));
};

const getMonsterLiteByIds = async (ids: string[]): Promise<Map<string, MonsterLiteRow>> => {
  if (ids.length === 0) return new Map();
  const idSet = new Set(ids);
  const rows = getMonsterDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => idSet.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title ?? null,
      realm: entry.realm ?? null,
      avatar: entry.avatar ?? null,
      base_attrs: entry.base_attrs ?? null,
      attr_variance: entry.attr_variance ?? null,
      attr_multiplier_min: entry.attr_multiplier_min ?? null,
      attr_multiplier_max: entry.attr_multiplier_max ?? null,
      display_stats: entry.display_stats ?? null,
    } satisfies MonsterLiteRow));
  return new Map(rows.map((row) => [row.id, row]));
};

const getItemLiteByIds = async (ids: string[]): Promise<Map<string, ItemLiteRow>> => {
  if (ids.length === 0) return new Map();
  const defs = getItemDefinitionsByIds(ids);
  const rows = ids
    .map((id) => {
      const def = defs.get(id);
      if (!def || def.enabled === false) return null;
      const quality = typeof def.quality === 'string' ? def.quality : null;
      return {
        id,
        name: String(def.name || id),
        quality,
        icon: typeof def.icon === 'string' ? def.icon : null,
        description: typeof def.description === 'string' ? def.description : null,
      } satisfies ItemLiteRow;
    })
    .filter((row): row is ItemLiteRow => !!row);
  return new Map(rows.map((row) => [row.id, row]));
};

const normalizeRoomNpcIds = (room: MapRoom | null): string[] => {
  if (!room?.npcs) return [];
  return room.npcs.filter((x): x is string => typeof x === 'string' && x.length > 0);
};

const normalizeRoomMonsterIds = (room: MapRoom | null): string[] => {
  const entries = room?.monsters;
  if (!Array.isArray(entries)) return [];
  const ids = entries
    .map((m) => m?.monster_def_id)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
  return [...new Set(ids)];
};

type TaskMarker = '!' | '?';

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s : null;
};

const asFiniteNonNegativeInt = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
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

type RawObjective = { id?: unknown; type?: unknown; target?: unknown; params?: unknown };

const parseObjectives = (objectives: unknown): RawObjective[] => (Array.isArray(objectives) ? (objectives as RawObjective[]) : []);

const parseStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

const isObjectiveCompleted = (objectives: RawObjective[], progressRecord: Record<string, number>): boolean => {
  const objectiveIds = objectives
    .map((objective) => asNonEmptyString(objective?.id))
    .filter((objectiveId): objectiveId is string => Boolean(objectiveId));
  if (objectiveIds.length === 0) return false;

  for (const objective of objectives) {
    const objectiveId = asNonEmptyString(objective?.id);
    if (!objectiveId) continue;
    const target = Math.max(1, asFiniteNonNegativeInt(objective?.target, 1));
    const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[objectiveId], 0));
    if (done < target) return false;
  }
  return true;
};

const isPrerequisiteSatisfied = (prereqTaskIds: string[], statusByTaskId: Map<string, string>): boolean => {
  if (prereqTaskIds.length === 0) return true;
  for (const prereqTaskId of prereqTaskIds) {
    const status = statusByTaskId.get(prereqTaskId);
    if (!status) return false;
    if (status !== 'turnin' && status !== 'claimable' && status !== 'claimed') return false;
  }
  return true;
};

const loadNpcTaskMarkers = async (characterId: number, npcIds: string[]): Promise<Map<string, TaskMarker>> => {
  if (!Number.isFinite(characterId) || characterId <= 0 || npcIds.length === 0) {
    return new Map();
  }

  const taskDefs = await getTaskDefinitionsByNpcIds(npcIds);
  if (taskDefs.length === 0) return new Map();
  const taskIds = taskDefs.map((entry) => entry.id);
  const progressRes = await query(
    `
      SELECT task_id, status AS progress_status, progress
      FROM character_task_progress
      WHERE character_id = $1
        AND task_id = ANY($2::varchar[])
    `,
    [characterId, taskIds],
  );
  const progressByTaskId = new Map<string, { progress_status?: unknown; progress?: unknown }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, {
      progress_status: row.progress_status,
      progress: row.progress,
    });
  }

  const setMarker = (markerByNpcId: Map<string, TaskMarker>, npcId: string, marker: TaskMarker): void => {
    const current = markerByNpcId.get(npcId);
    if (current === '?') return;
    if (marker === '?') {
      markerByNpcId.set(npcId, '?');
      return;
    }
    if (!current) markerByNpcId.set(npcId, '!');
  };

  const rows = taskDefs.map((taskDef) => {
    const progress = progressByTaskId.get(taskDef.id);
    return {
      task_id: taskDef.id,
      giver_npc_id: taskDef.giver_npc_id,
      prereq_task_ids: taskDef.prereq_task_ids,
      objectives: taskDef.objectives,
      progress_status: progress?.progress_status,
      progress: progress?.progress,
    };
  });

  const prerequisiteTaskIds = new Set<string>();
  for (const row of rows) {
    const progressStatus = asNonEmptyString(row.progress_status) ?? '';
    if (progressStatus.length > 0) continue;
    const prereqIds = parseStringArray(row.prereq_task_ids);
    for (const prereqId of prereqIds) prerequisiteTaskIds.add(prereqId);
  }

  const prerequisiteStatusByTaskId = new Map<string, string>();
  if (prerequisiteTaskIds.size > 0) {
    const prerequisiteRes = await query(
      `
        SELECT task_id, status
        FROM character_task_progress
        WHERE character_id = $1
          AND task_id = ANY($2::varchar[])
      `,
      [characterId, [...prerequisiteTaskIds]],
    );
    for (const row of prerequisiteRes.rows) {
      const taskId = asNonEmptyString(row?.task_id);
      if (!taskId) continue;
      const status = asNonEmptyString(row?.status) ?? '';
      prerequisiteStatusByTaskId.set(taskId, status);
    }
  }

  const markerByNpcId = new Map<string, TaskMarker>();
  for (const row of rows) {
    const npcId = asNonEmptyString(row.giver_npc_id);
    if (!npcId) continue;

    const progressStatus = asNonEmptyString(row.progress_status) ?? '';
    if (progressStatus.length === 0) {
      const prereqIds = parseStringArray(row.prereq_task_ids);
      if (isPrerequisiteSatisfied(prereqIds, prerequisiteStatusByTaskId)) {
        setMarker(markerByNpcId, npcId, '!');
      }
      continue;
    }

    if (progressStatus === 'claimed') continue;
    if (progressStatus === 'claimable') {
      setMarker(markerByNpcId, npcId, '?');
      continue;
    }

    if (progressStatus === 'turnin' || progressStatus === 'ongoing') {
      const objectives = parseObjectives(row.objectives);
      const progressRecord = parseProgressRecord(row.progress);
      if (isObjectiveCompleted(objectives, progressRecord)) {
        setMarker(markerByNpcId, npcId, '?');
      }
    }
  }

  return markerByNpcId;
};

export const getRoomObjects = async (mapId: string, roomId: string, excludeUserId?: number): Promise<MapObjectDto[]> => {
  const room = await getRoomInMap(mapId, roomId);
  if (!room) return [];

  const npcIds = normalizeRoomNpcIds(room);
  const monsterIds = normalizeRoomMonsterIds(room);
  const itemIds = [
    ...new Set(
      [
        ...(Array.isArray(room.items) ? room.items.map((it) => it?.item_def_id) : []),
        ...(Array.isArray(room.resources) ? room.resources.map((r) => r?.resource_id) : []),
      ].filter((x): x is string => typeof x === 'string' && x.length > 0)
    ),
  ];

  const excludeUid = Number(excludeUserId);
  const characterId =
    Number.isFinite(excludeUid) && excludeUid > 0 ? await getCharacterIdByUserId(excludeUid) : null;

  const taskMarkerByNpcId = new Map<string, TaskMarker>();
  const taskMarkerByMonsterId = new Map<string, TaskMarker>();
  const taskMarkerByResourceId = new Map<string, TaskMarker>();
  const trackedNpcIds = new Set<string>();
  const trackedMonsterIds = new Set<string>();
  const trackedResourceIds = new Set<string>();

  if (characterId) {
    const setMarker = (map: Map<string, TaskMarker>, id: string, marker: TaskMarker) => {
      const current = map.get(id);
      if (current === '?') return;
      if (marker === '?') {
        map.set(id, '?');
        return;
      }
      if (!current) map.set(id, '!');
    };

    const npcTaskMarkers = await loadNpcTaskMarkers(characterId, npcIds);
    for (const [npcId, marker] of npcTaskMarkers.entries()) {
      setMarker(taskMarkerByNpcId, npcId, marker);
    }

    try {
      const activeRes = await query(
        `
          SELECT p.task_id, p.progress
          FROM character_task_progress p
          WHERE p.character_id = $1
            AND COALESCE(p.status, 'ongoing') <> 'claimed'
        `,
        [characterId],
      );

      const taskDefMap = await getTaskDefinitionsByIds(
        (activeRes.rows as Array<Record<string, unknown>>)
          .map((row) => asNonEmptyString(row.task_id))
          .filter((taskId): taskId is string => Boolean(taskId)),
      );

      for (const row of activeRes.rows ?? []) {
        const taskId = asNonEmptyString((row as Record<string, unknown>).task_id);
        if (!taskId) continue;
        const taskDef = taskDefMap.get(taskId);
        if (!taskDef) continue;
        const objectives = parseObjectives(taskDef.objectives);
        const progressRecord = parseProgressRecord(row?.progress);
        for (const o of objectives) {
          const oid = asNonEmptyString(o?.id);
          if (!oid) continue;
          const type = asNonEmptyString(o?.type) ?? '';
          const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
          const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[oid], 0));
          if (done >= target) continue;
          const params = o?.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : null;
          if (type === 'talk_npc') {
            const npcId = asNonEmptyString(params?.npc_id);
            if (npcId) setMarker(taskMarkerByNpcId, npcId, '!');
          }
          if (type === 'kill_monster') {
            const monsterId = asNonEmptyString(params?.monster_id);
            if (monsterId) setMarker(taskMarkerByMonsterId, monsterId, '!');
          }
          if (type === 'gather_resource') {
            const resourceId = asNonEmptyString(params?.resource_id);
            if (resourceId) setMarker(taskMarkerByResourceId, resourceId, '!');
          }
        }
      }
    } catch {
      // 忽略
    }

    try {
      const trackedTaskRes = await query(
        `
          SELECT p.task_id, p.progress
          FROM character_task_progress p
          WHERE p.character_id = $1
            AND p.tracked = true
            AND COALESCE(p.status, 'ongoing') <> 'claimed'
        `,
        [characterId],
      );

      const taskDefMap = await getTaskDefinitionsByIds(
        (trackedTaskRes.rows as Array<Record<string, unknown>>)
          .map((row) => asNonEmptyString(row.task_id))
          .filter((taskId): taskId is string => Boolean(taskId)),
      );

      for (const row of trackedTaskRes.rows ?? []) {
        const taskId = asNonEmptyString((row as Record<string, unknown>).task_id);
        if (!taskId) continue;
        const taskDef = taskDefMap.get(taskId);
        if (!taskDef) continue;
        const objectives = parseObjectives(taskDef.objectives);
        const progressRecord = parseProgressRecord(row?.progress);
        for (const o of objectives) {
          const oid = asNonEmptyString(o?.id);
          if (!oid) continue;
          const type = asNonEmptyString(o?.type) ?? '';
          const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
          const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[oid], 0));
          if (done >= target) continue;
          const params = o?.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : null;
          if (!params) continue;

          if (type === 'talk_npc') {
            const npcId = asNonEmptyString(params.npc_id);
            if (npcId) trackedNpcIds.add(npcId);
          }
          if (type === 'kill_monster') {
            const monsterId = asNonEmptyString(params.monster_id);
            if (monsterId) trackedMonsterIds.add(monsterId);
          }
          if (type === 'gather_resource') {
            const resourceId = asNonEmptyString(params.resource_id);
            if (resourceId) trackedResourceIds.add(resourceId);
          }
        }
      }
    } catch {
      // 忽略
    }

    try {
      const mqRes = await query(
        `SELECT section_status, tracked, objectives_progress, current_section_id FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`,
        [characterId],
      );

      const progressRow = mqRes.rows?.[0] as
        | { section_status?: unknown; tracked?: unknown; objectives_progress?: unknown; current_section_id?: unknown }
        | undefined;
      const sectionId = asNonEmptyString(progressRow?.current_section_id);
      const section = sectionId ? getMainQuestSectionById(sectionId) : null;
      if (section && section.enabled !== false) {
        const tracked = progressRow?.tracked !== false;
        const status = typeof progressRow?.section_status === 'string'
          ? progressRow.section_status.trim()
          : String(progressRow?.section_status ?? '').trim();
        const mainQuestNpcId = asNonEmptyString(section.npc_id);
        if (tracked && mainQuestNpcId) {
          if (status === 'turnin') {
            setMarker(taskMarkerByNpcId, mainQuestNpcId, '?');
          } else if (status === 'not_started' || status === 'dialogue') {
            setMarker(taskMarkerByNpcId, mainQuestNpcId, '!');
          }
          if (status === 'not_started' || status === 'dialogue' || status === 'turnin' || status === 'objectives') {
            trackedNpcIds.add(mainQuestNpcId);
          }
        }
        if (tracked && status === 'objectives') {
          const objectives = parseObjectives(section.objectives);
          const progressRecord = parseProgressRecord(progressRow?.objectives_progress);
          for (const o of objectives) {
            const oid = asNonEmptyString(o?.id);
            if (!oid) continue;
            const type = asNonEmptyString(o?.type) ?? '';
            const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
            const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[oid], 0));
            if (done >= target) continue;
            const params = o?.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : null;
            if (!params) continue;

            if (type === 'talk_npc') {
              const npcId = asNonEmptyString(params.npc_id);
              if (npcId) trackedNpcIds.add(npcId);
            }
            if (type === 'kill_monster') {
              const monsterId = asNonEmptyString(params.monster_id);
              if (monsterId) trackedMonsterIds.add(monsterId);
            }
            if (type === 'gather_resource') {
              const resourceId = asNonEmptyString(params.resource_id);
              if (resourceId) trackedResourceIds.add(resourceId);
            }
            if (type === 'collect') {
              const itemId = asNonEmptyString(params.item_id);
              if (itemId) trackedResourceIds.add(itemId);
            }

            if (type === 'kill_monster') {
              const monsterId = asNonEmptyString(params.monster_id);
              if (monsterId) setMarker(taskMarkerByMonsterId, monsterId, '!');
            }
            if (type === 'gather_resource') {
              const resourceId = asNonEmptyString(params.resource_id);
              if (resourceId) setMarker(taskMarkerByResourceId, resourceId, '!');
            }
            if (type === 'collect') {
              const itemId = asNonEmptyString(params.item_id);
              if (itemId) setMarker(taskMarkerByResourceId, itemId, '!');
            }
          }
        }
      }
    } catch {
    }
  }

  const [npcMap, monsterMap, itemMap] = await Promise.all([
    getNpcLiteByIds(npcIds),
    getMonsterLiteByIds(monsterIds),
    getItemLiteByIds(itemIds),
  ]);

  const objects: MapObjectDto[] = [];

  for (const npcId of npcIds) {
    const npc = npcMap.get(npcId);
    if (!npc) continue;
    if (npc.id === 'npc-bounty-board') {
      objects.push({
        type: 'item',
        id: npc.id,
        object_kind: 'board',
        name: npc.name,
        task_marker: taskMarkerByNpcId.get(npc.id),
        task_tracked: trackedNpcIds.has(npc.id),
        title: npc.title ?? undefined,
        gender: npc.gender ?? undefined,
        realm: npc.realm ?? undefined,
        avatar: npc.avatar ?? null,
        desc: npc.description ?? undefined,
      });
    } else {
      objects.push({
        type: 'npc',
        id: npc.id,
        name: npc.name,
        task_marker: taskMarkerByNpcId.get(npc.id),
        task_tracked: trackedNpcIds.has(npc.id),
        title: npc.title ?? undefined,
        gender: npc.gender ?? undefined,
        realm: npc.realm ?? undefined,
        avatar: npc.avatar ?? null,
        desc: npc.description ?? undefined,
      });
    }
  }

  const monsters = Array.isArray(room.monsters) ? room.monsters : [];
  for (const m of monsters) {
    const defId = m?.monster_def_id;
    if (typeof defId !== 'string' || !defId) continue;
    const def = monsterMap.get(defId);
    if (!def) continue;
    objects.push({
      type: 'monster',
      id: def.id,
      name: def.name,
      task_marker: taskMarkerByMonsterId.get(def.id),
      task_tracked: trackedMonsterIds.has(def.id),
      title: def.title ?? undefined,
      gender: '-',
      realm: def.realm ?? undefined,
      avatar: def.avatar ?? null,
      base_attrs: asNumberRecord(def.base_attrs),
      attr_variance: asNumber(def.attr_variance),
      attr_multiplier_min: asNumber(def.attr_multiplier_min),
      attr_multiplier_max: asNumber(def.attr_multiplier_max),
      stats: asStatList(def.display_stats),
    });
  }

  const items = Array.isArray(room.items) ? room.items : [];
  const pickedOnceItemIds = new Set<string>();
  const allowedQuestItemIds = new Set<string>();
  if (characterId && items.length > 0) {
    const itemDefIds = [
      ...new Set(items.map((it) => it?.item_def_id).filter((x): x is string => typeof x === 'string' && x.length > 0)),
    ];

    const onceIds = itemDefIds.filter((id) => {
      const cfg = getRoomItemConfig(room, id);
      return cfg?.once === true;
    });
    if (onceIds.length > 0) {
      const usedRes = await query(
        `
          SELECT resource_id, used_count
          FROM character_room_resource_state
          WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = ANY($4)
        `,
        [characterId, mapId, roomId, onceIds],
      );
      for (const r of usedRes.rows ?? []) {
        const rid = typeof r?.resource_id === 'string' ? r.resource_id : '';
        const usedRaw = r?.used_count === null || r?.used_count === undefined ? 0 : Number(r.used_count);
        const usedCount = Number.isFinite(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
        if (rid && usedCount >= 1) pickedOnceItemIds.add(rid);
      }
    }

    const reqQuestIds: string[] = [];
    const questIdByItemId = new Map<string, string>();
    for (const id of itemDefIds) {
      const cfg = getRoomItemConfig(room, id);
      if (!cfg?.reqQuestId) continue;
      questIdByItemId.set(id, cfg.reqQuestId);
      reqQuestIds.push(cfg.reqQuestId);
    }

    const uniqueReqQuestIds = [...new Set(reqQuestIds)];
    if (uniqueReqQuestIds.length > 0) {
      const taskRes = await query(
        `
          SELECT task_id, status
          FROM character_task_progress
          WHERE character_id = $1 AND task_id = ANY($2::varchar[])
        `,
        [characterId, uniqueReqQuestIds],
      );
      const statusByTaskId = new Map<string, string>();
      for (const r of taskRes.rows ?? []) {
        const tid = typeof r?.task_id === 'string' ? r.task_id : '';
        const st = typeof r?.status === 'string' ? r.status : '';
        if (tid) statusByTaskId.set(tid, st);
      }
      for (const [itemId, questId] of questIdByItemId.entries()) {
        const st = statusByTaskId.get(questId) ?? '';
        if (st && st !== 'claimed') allowedQuestItemIds.add(itemId);
      }
    }
  }

  for (const it of items) {
    const itemDefId = it?.item_def_id;
    if (typeof itemDefId !== 'string' || !itemDefId) continue;
    const cfg = getRoomItemConfig(room, itemDefId);
    if (characterId && cfg?.once === true && pickedOnceItemIds.has(itemDefId)) continue;
    if (characterId && cfg?.reqQuestId && !allowedQuestItemIds.has(itemDefId)) continue;
    const def = itemMap.get(itemDefId);
    objects.push({
      type: 'item',
      id: itemDefId,
      task_tracked: trackedResourceIds.has(itemDefId),
      name: def?.name ?? itemDefId,
      title: def?.quality ?? undefined,
      gender: '-',
      realm: '-',
      avatar: def?.icon ?? null,
      desc: def?.description ?? undefined,
    });
  }

  const resources = Array.isArray(room.resources) ? room.resources : [];
  const resourceIdList = [
    ...new Set(
      resources.map((r) => r?.resource_id).filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  ];
  const resourceStateById = new Map<
    string,
    { collectLimit: number; usedCount: number; remaining: number; cooldownSec: number; respawnSec: number; cooldownUntil?: string | null }
  >();
  if (characterId && resourceIdList.length > 0) {
      const stateRes = await query(
        `
          SELECT resource_id, used_count, cooldown_until
          FROM character_room_resource_state
          WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = ANY($4)
        `,
        [characterId, mapId, roomId, resourceIdList],
      );
      const nowMs = Date.now();
      const rowByResourceId = new Map<
        string,
        { used_count?: unknown; cooldown_until?: unknown }
      >(
        stateRes.rows.map((r: { resource_id: string; used_count?: unknown; cooldown_until?: unknown }) => [
          r.resource_id,
          { used_count: r.used_count, cooldown_until: r.cooldown_until },
        ]),
      );

      for (const rid of resourceIdList) {
        const cfg = getRoomResourceConfig(room, rid);
        if (!cfg) continue;
        const row = rowByResourceId.get(rid);
        const rawUsed = row?.used_count === null || row?.used_count === undefined ? 0 : Number(row.used_count);
        const usedCountRaw = Number.isFinite(rawUsed) && rawUsed > 0 ? Math.floor(rawUsed) : 0;
        const cdUntil = row?.cooldown_until ? new Date(row.cooldown_until as any) : null;
        const cdUntilMs = cdUntil ? cdUntil.getTime() : 0;
        const inCooldown = cdUntilMs && Number.isFinite(cdUntilMs) && nowMs < cdUntilMs;
        const usedCount = cdUntilMs && Number.isFinite(cdUntilMs) && nowMs >= cdUntilMs ? 0 : usedCountRaw;
        const remaining = Math.max(0, cfg.collectLimit - usedCount);
        const cooldownSec = inCooldown ? Math.max(1, Math.ceil((cdUntilMs - nowMs) / 1000)) : 0;
        resourceStateById.set(rid, {
          collectLimit: cfg.collectLimit,
          usedCount,
          remaining,
          cooldownSec,
          respawnSec: cfg.respawnSec,
          cooldownUntil: inCooldown ? cdUntil!.toISOString() : null,
        });
      }
  }
  for (const r of resources) {
    const resourceId = r?.resource_id;
    if (typeof resourceId !== 'string' || !resourceId) continue;
    const def = itemMap.get(resourceId);
    const cfg = getRoomResourceConfig(room, resourceId);
    const fallbackResource = cfg
      ? {
          collectLimit: cfg.collectLimit,
          usedCount: 0,
          remaining: cfg.collectLimit,
          cooldownSec: 0,
          respawnSec: cfg.respawnSec,
          cooldownUntil: null,
        }
      : undefined;
    objects.push({
      type: 'item',
      id: resourceId,
      object_kind: 'resource',
      task_marker: taskMarkerByResourceId.get(resourceId) ?? (trackedResourceIds.has(resourceId) ? '!' : undefined),
      task_tracked: trackedResourceIds.has(resourceId),
      resource: resourceStateById.get(resourceId) ?? fallbackResource,
      name: def?.name ?? resourceId,
      title: def?.quality ?? undefined,
      gender: '-',
      realm: '-',
      avatar: def?.icon ?? null,
      desc: def?.description ?? undefined,
    });
  }

  try {
    const gameServer = getGameServer();
    const players = gameServer.getOnlinePlayersInRoom(mapId, roomId, excludeUserId);
    const seen = new Set<string>();
    for (const p of players) {
      const pid = String(p.id);
      if (seen.has(pid)) continue;
      seen.add(pid);
      const realmText = p.subRealm ? `${p.realm}·${p.subRealm}` : p.realm;
      objects.push({
        type: 'player',
        id: pid,
        name: p.nickname,
        title: p.title || undefined,
        gender: p.gender || undefined,
        realm: realmText || undefined,
        avatar: p.avatar ?? null,
      });
    }
  } catch {
    // 忽略
  }

  return objects;
};

type SpawnRuleRow = {
  id: string;
  area: string;
  pool_type: string;
  pool_entries: unknown;
  max_alive: number;
  respawn_sec: number;
  enabled: boolean;
};

type SpawnEntry = { monster_def_id?: string; npc_def_id?: string; weight?: number };

const parseSpawnEntries = (value: unknown): SpawnEntry[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value as SpawnEntry[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as SpawnEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

export const getAreaObjects = async (area: GridPosition): Promise<MapObjectDto[]> => {
  const npcRows: NpcLiteRow[] = getNpcDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => String(entry.area ?? '') === area)
    .sort((left, right) => {
      const leftSortWeight = Number(left.sort_weight ?? 0);
      const rightSortWeight = Number(right.sort_weight ?? 0);
      if (leftSortWeight !== rightSortWeight) return rightSortWeight - leftSortWeight;
      return String(left.id || '').localeCompare(String(right.id || ''));
    })
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      title: entry.title ?? null,
      gender: entry.gender ?? null,
      realm: entry.realm ?? null,
      avatar: entry.avatar ?? null,
      description: entry.description ?? null,
    }));

  const spawnRules: SpawnRuleRow[] = getSpawnRuleDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => String(entry.area ?? '') === area)
    .filter((entry) => String(entry.pool_type ?? 'monster') === 'monster')
    .map((entry) => ({
      id: entry.id,
      area: entry.area,
      pool_type: entry.pool_type ?? 'monster',
      pool_entries: entry.pool_entries ?? [],
      max_alive: Number(entry.max_alive ?? 0),
      respawn_sec: Number(entry.respawn_sec ?? 0),
      enabled: entry.enabled !== false,
    }));
  const monsterIds = [
    ...new Set(
      spawnRules
        .flatMap((r) => parseSpawnEntries(r.pool_entries))
        .map((e) => e.monster_def_id)
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
    ),
  ];

  const monsterMap = await getMonsterLiteByIds(monsterIds);

  const objects: MapObjectDto[] = [];

  for (const npc of npcRows) {
    objects.push({
      type: 'npc',
      id: npc.id,
      name: npc.name,
      title: npc.title ?? undefined,
      gender: npc.gender ?? undefined,
      realm: npc.realm ?? undefined,
      avatar: npc.avatar ?? null,
      desc: npc.description ?? undefined,
    });
  }

  for (const id of monsterIds) {
    const m = monsterMap.get(id);
    if (!m) continue;
    objects.push({
      type: 'monster',
      id: m.id,
      name: m.name,
      title: m.title ?? undefined,
      gender: '-',
      realm: m.realm ?? undefined,
      avatar: m.avatar ?? null,
      base_attrs: asNumberRecord(m.base_attrs),
      attr_variance: asNumber(m.attr_variance),
      attr_multiplier_min: asNumber(m.attr_multiplier_min),
      attr_multiplier_max: asNumber(m.attr_multiplier_max),
      stats: asStatList(m.display_stats),
    });
  }

  return objects;
};

const normalizePositiveInt = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (i <= 0) return null;
  return i;
};

const getRoomResourceConfig = (
  room: MapRoom,
  resourceId: string,
): { collectLimit: number; respawnSec: number } | null => {
  const entries = Array.isArray(room.resources) ? room.resources : [];
  const entry = entries.find((e) => e?.resource_id === resourceId);
  if (!entry) return null;

  const collectLimit = normalizePositiveInt(entry.collect_limit) ?? normalizePositiveInt(entry.count) ?? 1;
  const respawnSec = normalizePositiveInt(entry.respawn_sec) ?? 60;

  return { collectLimit, respawnSec };
};

export const gatherRoomResource = async (params: {
  mapId: string;
  roomId: string;
  resourceId: string;
  userId: number;
  characterId: number;
}): Promise<{
  success: boolean;
  message: string;
  data?: { itemDefId: string; qty: number; remaining: number; cooldownSec: number; actionSec?: number; gatherUntil?: string | null };
}> => {
  const mapId = String(params.mapId || '').trim();
  const roomId = String(params.roomId || '').trim();
  const resourceId = String(params.resourceId || '').trim();
  const userId = Number(params.userId);
  const characterId = Number(params.characterId);

  if (!mapId || !roomId || !resourceId) return { success: false, message: '参数错误' };
  if (!Number.isFinite(userId) || userId <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(characterId) || characterId <= 0) return { success: false, message: '角色不存在' };

  const room = await getRoomInMap(mapId, roomId);
  if (!room) return { success: false, message: '房间不存在' };

  const cfg = getRoomResourceConfig(room, resourceId);
  if (!cfg) return { success: false, message: '资源不存在' };

  const actionSec = 5;

  try {
    return await withTransaction(async (client) => {
  await lockCharacterInventoryMutexTx(client, characterId);
  
      const stateRes = await client.query(
        `
          SELECT id, used_count, gather_until, cooldown_until
          FROM character_room_resource_state
          WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = $4
          LIMIT 1
          FOR UPDATE
        `,
        [characterId, mapId, roomId, resourceId],
      );
  
      const now = new Date();
      const row = stateRes.rows[0] as { id?: number; used_count?: unknown; gather_until?: unknown; cooldown_until?: unknown } | undefined;
      const rowId = row?.id ? Number(row.id) : null;
      const rowUsed = row?.used_count === null || row?.used_count === undefined ? 0 : Number(row.used_count);
      const usedCount = Number.isFinite(rowUsed) && rowUsed > 0 ? Math.floor(rowUsed) : 0;
      const cdUntilMs = row?.cooldown_until ? new Date(row.cooldown_until as any).getTime() : 0;
      const gatherUntilMs = row?.gather_until ? new Date(row.gather_until as any).getTime() : 0;
  
      if (cdUntilMs && Number.isFinite(cdUntilMs) && now.getTime() < cdUntilMs) {
        const remaining = Math.max(1, Math.ceil((cdUntilMs - now.getTime()) / 1000));
        await client.query('ROLLBACK');
        return { success: false, message: `资源尚未刷新，剩余${remaining}秒` };
      }
  
      const normalizedUsed = cdUntilMs && now.getTime() >= cdUntilMs ? 0 : usedCount;
      const remainingBefore = Math.max(0, cfg.collectLimit - normalizedUsed);
      if (remainingBefore <= 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '资源已耗尽' };
      }
  
      if (gatherUntilMs && Number.isFinite(gatherUntilMs) && now.getTime() < gatherUntilMs) {
        const remainingSec = Math.max(1, Math.ceil((gatherUntilMs - now.getTime()) / 1000));
  return {
          success: true,
          message: '采集中',
          data: {
            itemDefId: resourceId,
            qty: 0,
            remaining: remainingBefore,
            cooldownSec: remainingSec,
            actionSec,
            gatherUntil: new Date(gatherUntilMs).toISOString(),
          },
        };
      }
  
      if (!gatherUntilMs || !Number.isFinite(gatherUntilMs)) {
        const nextGatherUntil = new Date(now.getTime() + actionSec * 1000);
        if (rowId && Number.isFinite(rowId)) {
          await client.query(
            `
              UPDATE character_room_resource_state
              SET gather_until = $1,
                  updated_at = NOW()
              WHERE id = $2
            `,
            [nextGatherUntil.toISOString(), rowId],
          );
        } else {
          await client.query(
            `
              INSERT INTO character_room_resource_state (character_id, map_id, room_id, resource_id, used_count, gather_until, cooldown_until)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (character_id, map_id, room_id, resource_id)
              DO UPDATE SET gather_until = EXCLUDED.gather_until, updated_at = NOW()
            `,
            [characterId, mapId, roomId, resourceId, normalizedUsed, nextGatherUntil.toISOString(), null],
          );
        }
  return {
          success: true,
          message: '开始采集',
          data: {
            itemDefId: resourceId,
            qty: 0,
            remaining: remainingBefore,
            cooldownSec: actionSec,
            actionSec,
            gatherUntil: nextGatherUntil.toISOString(),
          },
        };
      }
  
      const nextUsed = normalizedUsed + 1;
      if (nextUsed > cfg.collectLimit) {
        await client.query('ROLLBACK');
        return { success: false, message: '资源已耗尽' };
      }
  
      const willDeplete = nextUsed >= cfg.collectLimit;
      const cooldownUntil = willDeplete ? new Date(now.getTime() + cfg.respawnSec * 1000) : null;
      const nextGatherUntil = willDeplete ? null : new Date(now.getTime() + actionSec * 1000);
  
      if (rowId && Number.isFinite(rowId)) {
        await client.query(
          `
            UPDATE character_room_resource_state
            SET used_count = $1,
                gather_until = $2,
                cooldown_until = $3,
                updated_at = NOW()
            WHERE id = $4
          `,
          [nextUsed, nextGatherUntil ? nextGatherUntil.toISOString() : null, cooldownUntil ? cooldownUntil.toISOString() : null, rowId],
        );
      } else {
        await client.query(
          `
            INSERT INTO character_room_resource_state (character_id, map_id, room_id, resource_id, used_count, gather_until, cooldown_until)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (character_id, map_id, room_id, resource_id)
            DO UPDATE SET used_count = EXCLUDED.used_count, gather_until = EXCLUDED.gather_until, cooldown_until = EXCLUDED.cooldown_until, updated_at = NOW()
          `,
          [
            characterId,
            mapId,
            roomId,
            resourceId,
            nextUsed,
            nextGatherUntil ? nextGatherUntil.toISOString() : null,
            cooldownUntil ? cooldownUntil.toISOString() : null,
          ],
        );
      }
  
      const addResult = await addItemToInventoryTx(client, characterId, userId, resourceId, 1, {
        location: 'bag',
        obtainedFrom: 'gather',
      });
      if (!addResult.success) {
        await client.query('ROLLBACK');
        return { success: false, message: addResult.message || '采集失败' };
      }
  try {
        await recordGatherResourceEvent(characterId, resourceId, 1);
      } catch {}
      return {
        success: true,
        message: '采集成功',
        data: {
          itemDefId: resourceId,
          qty: 1,
          remaining: Math.max(0, cfg.collectLimit - nextUsed),
          cooldownSec: nextGatherUntil ? actionSec : 0,
          actionSec,
          gatherUntil: nextGatherUntil ? nextGatherUntil.toISOString() : null,
        },
      };
    });
  } catch (error) {
console.error('采集资源失败:', error);
    return { success: false, message: '采集失败' };
  }
};

function normalizeChance(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function getRoomItemConfig(
  room: MapRoom,
  itemDefId: string,
): { once: boolean; chance: number; reqQuestId: string | null } | null {
  const entries = Array.isArray(room.items) ? room.items : [];
  const entry = entries.find((e) => e?.item_def_id === itemDefId);
  if (!entry) return null;

  const once = entry.once === true;
  const chance = normalizeChance(entry.chance);
  const reqQuestId = typeof entry.req_quest_id === 'string' && entry.req_quest_id.trim() ? entry.req_quest_id.trim() : null;
  return { once, chance, reqQuestId };
}

const canPickupQuestItem = async (characterId: number, reqQuestId: string): Promise<boolean> => {
  const cid = Number(characterId);
  const tid = String(reqQuestId || '').trim();
  if (!Number.isFinite(cid) || cid <= 0) return false;
  if (!tid) return false;

  const res = await query(
    `
      SELECT status
      FROM character_task_progress
      WHERE character_id = $1 AND task_id = $2
      LIMIT 1
    `,
    [cid, tid],
  );
  if ((res.rows ?? []).length === 0) return false;
  const status = String(res.rows[0]?.status ?? '').trim();
  return status !== 'claimed';
};

export const pickupRoomItem = async (params: {
  mapId: string;
  roomId: string;
  itemDefId: string;
  userId: number;
  characterId: number;
}): Promise<{
  success: boolean;
  message: string;
  data?: { itemDefId: string; qty: number };
}> => {
  const mapId = String(params.mapId || '').trim();
  const roomId = String(params.roomId || '').trim();
  const itemDefId = String(params.itemDefId || '').trim();
  const userId = Number(params.userId);
  const characterId = Number(params.characterId);

  if (!mapId || !roomId || !itemDefId) return { success: false, message: '参数错误' };
  if (!Number.isFinite(userId) || userId <= 0) return { success: false, message: '未登录' };
  if (!Number.isFinite(characterId) || characterId <= 0) return { success: false, message: '角色不存在' };

  const room = await getRoomInMap(mapId, roomId);
  if (!room) return { success: false, message: '房间不存在' };

  const cfg = getRoomItemConfig(room, itemDefId);
  if (!cfg) return { success: false, message: '该物品不可拾取' };

  if (cfg.reqQuestId) {
    const ok = await canPickupQuestItem(characterId, cfg.reqQuestId);
    if (!ok) return { success: false, message: '任务未接取或已完成' };
  }

  if (cfg.chance <= 0) return { success: true, message: '什么都没有', data: { itemDefId, qty: 0 } };

  const roll = Math.random();
  const willGain = roll <= cfg.chance;
  if (!willGain) return { success: true, message: '什么都没捡到', data: { itemDefId, qty: 0 } };

  try {
    return await withTransaction(async (client) => {
  await lockCharacterInventoryMutexTx(client, characterId);
  
      if (cfg.once) {
        const stateRes = await client.query(
          `
            SELECT id, used_count
            FROM character_room_resource_state
            WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = $4
            LIMIT 1
            FOR UPDATE
          `,
          [characterId, mapId, roomId, itemDefId],
        );
  
        const row = stateRes.rows[0] as { id?: unknown; used_count?: unknown } | undefined;
        const rowId = typeof row?.id === 'number' ? row.id : typeof row?.id === 'string' ? Number(row.id) : NaN;
        const usedRaw = row?.used_count === null || row?.used_count === undefined ? 0 : Number(row.used_count);
        const usedCount = Number.isFinite(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
        if (usedCount >= 1) {
          await client.query('ROLLBACK');
          return { success: false, message: '该物品已拾取' };
        }
  
        if (Number.isFinite(rowId) && rowId > 0) {
          await client.query(
            `
              UPDATE character_room_resource_state
              SET used_count = 1,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [rowId],
          );
        } else {
          await client.query(
            `
              INSERT INTO character_room_resource_state (character_id, map_id, room_id, resource_id, used_count, gather_until, cooldown_until)
              VALUES ($1, $2, $3, $4, 1, NULL, NULL)
              ON CONFLICT (character_id, map_id, room_id, resource_id)
              DO UPDATE SET used_count = EXCLUDED.used_count, updated_at = NOW()
            `,
            [characterId, mapId, roomId, itemDefId],
          );
        }
      }
  
      const addResult = await addItemToInventoryTx(client, characterId, userId, itemDefId, 1, {
        location: 'bag',
        obtainedFrom: 'pickup',
      });
      if (!addResult.success) {
        await client.query('ROLLBACK');
        return { success: false, message: addResult.message || '拾取失败' };
      }
  try {
        await recordGatherResourceEvent(characterId, itemDefId, 1);
      } catch {}
      return { success: true, message: '拾取成功', data: { itemDefId, qty: 1 } };
    });
  } catch (error) {
console.error('拾取房间物品失败:', error);
    return { success: false, message: '拾取失败' };
  }
};
