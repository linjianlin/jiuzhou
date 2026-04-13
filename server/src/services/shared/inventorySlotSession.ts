/**
 * InventorySlotSession - 事务级背包槽位规划会话
 *
 * 作用：
 * 1. 做什么：在单个事务内集中维护容量、已占槽位、普通可堆叠承载索引与 projected item 视图，给普通入包、装备创建、邮件实例回包提供统一规划基线。
 * 2. 不做什么：不负责开启事务，不直接执行 SQL 写入，也不区分 buffered / immediate 落库协议。
 *
 * 输入 / 输出：
 * 1. `createInventorySlotSession(characterIds)`：输入角色列表，输出一份可在同事务内复用的 InventorySlotSession。
 * 2. session 对外提供容量读取、空槽查询、普通堆叠查询、投影视图更新等接口；调用方负责把最终 mutation / SQL 提交到数据库。
 *
 * 数据流 / 状态流：
 * - 创建阶段先批量读取 inventory 容量与 projected item 视图；
 * - 会话内所有规划请求都复用同一份内存索引；
 * - 每次成功写库后由调用方回写 session，使后续规划看到最新事务内状态。
 *
 * 复用设计说明：
 * - 用单一会话替代原先分散的 CharacterBagSlotAllocator、CharacterInventoryMutationContext 与局部 projected scan，避免多套槽位语义并存。
 * - persistence adapter 仍然保留在 bag / characterItemInstanceMutationService 中，确保“怎么算”和“怎么写”职责分离。
 *
 * 关键边界条件与坑点：
 * 1. 本模块默认调用方已经持有角色库存互斥锁；否则会话内缓存无法抵御并发写入。
 * 2. session 只缓存当前事务内权威视图；一旦写库失败，调用方必须不要把失败尝试的副作用回写到 session。
 */
import { query } from '../../config/database.js';
import type { SlottedInventoryLocation } from '../inventory/shared/types.js';
import { isPlainStackingState } from '../inventory/shared/stacking.js';
import {
  applyCharacterItemInstanceMutations,
  loadProjectedCharacterItemInstances,
  type BufferedCharacterItemInstanceMutation,
  type CharacterItemInstanceMetadata,
  type CharacterItemInstanceSnapshot,
  type JsonValue,
} from './characterItemInstanceMutationService.js';
import { normalizeItemBindType } from './itemBindType.js';
import { normalizeCharacterRewardTargetIds } from './characterRewardTargetLock.js';

type InventoryCapacityRow = {
  character_id: number;
  bag_capacity: number;
  warehouse_capacity: number;
};

export type PlainAutoStackLookupRow = {
  id: number;
  qty: number;
};

export type PlainAutoStackLookupOptions = {
  characterId: number;
  itemDefId: string;
  location: SlottedInventoryLocation;
  stackMax: number;
  bindType: string;
  excludeItemId?: number;
};

type PlainAutoStackState = {
  id: number;
  qty: number;
};

const buildCapacityKey = (
  characterId: number,
  location: SlottedInventoryLocation,
): string => `${characterId}:${location}`;

const buildPlainAutoStackKey = (
  characterId: number,
  itemDefId: string,
  location: SlottedInventoryLocation,
  bindType: string,
): string => `${characterId}:${location}:${itemDefId}:${bindType}`;

const sortPlainAutoStackStates = (rows: PlainAutoStackState[]): void => {
  rows.sort((left, right) => {
    if (right.qty !== left.qty) {
      return right.qty - left.qty;
    }
    return left.id - right.id;
  });
};

const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    const next: { [key: string]: JsonValue } = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = cloneJsonValue(entry);
    }
    return next;
  }
  return value;
};

const cloneMetadata = (value: CharacterItemInstanceMetadata): CharacterItemInstanceMetadata => {
  if (value === null) {
    return null;
  }
  const next: { [key: string]: JsonValue } = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = cloneJsonValue(entry);
  }
  return next;
};

const cloneSnapshot = (
  snapshot: CharacterItemInstanceSnapshot,
): CharacterItemInstanceSnapshot => ({
  ...snapshot,
  metadata: cloneMetadata(snapshot.metadata),
  socketed_gems: cloneJsonValue(snapshot.socketed_gems),
  affixes: cloneJsonValue(snapshot.affixes),
  affix_roll_meta: cloneJsonValue(snapshot.affix_roll_meta),
  created_at: new Date(snapshot.created_at),
  expire_at: snapshot.expire_at ? new Date(snapshot.expire_at) : null,
});

const cloneSnapshots = (
  snapshots: readonly CharacterItemInstanceSnapshot[],
): CharacterItemInstanceSnapshot[] => snapshots.map((snapshot) => cloneSnapshot(snapshot));

const isTrackedLocation = (location: string): location is SlottedInventoryLocation => {
  return location === 'bag' || location === 'warehouse';
};

const isTrackedSlot = (slot: number | null): slot is number => {
  if (slot === null) {
    return false;
  }
  return Number.isInteger(slot) && slot >= 0;
};

const isPlainStackCandidate = (snapshot: CharacterItemInstanceSnapshot): boolean => {
  return isTrackedLocation(snapshot.location)
    && isPlainStackingState({
      metadataText: snapshot.metadata === null ? null : JSON.stringify(snapshot.metadata),
      quality: snapshot.quality,
      qualityRank: snapshot.quality_rank,
    });
};

export interface InventorySlotSession {
  getSlottedCapacity(characterId: number, location: SlottedInventoryLocation): number | null;
  getPlainAutoStackRows(options: PlainAutoStackLookupOptions): PlainAutoStackLookupRow[];
  applyPlainAutoStackDelta(options: {
    characterId: number;
    itemDefId: string;
    location: SlottedInventoryLocation;
    bindType: string;
    itemId: number;
    addedQty: number;
  }): void;
  registerPlainAutoStackRow(options: {
    characterId: number;
    itemDefId: string;
    location: SlottedInventoryLocation;
    bindType: string;
    itemId: number;
    qty: number;
  }): void;
  listEmptySlots(characterId: number, location: SlottedInventoryLocation, count: number): number[];
  isSlotAvailable(characterId: number, location: SlottedInventoryLocation, slot: number): boolean;
  markSlotOccupied(characterId: number, location: SlottedInventoryLocation, slot: number): void;
  registerSnapshot(snapshot: CharacterItemInstanceSnapshot): void;
  applyBufferedMutations(characterId: number, mutations: readonly BufferedCharacterItemInstanceMutation[]): void;
  getProjectedItems(characterId: number): CharacterItemInstanceSnapshot[];
}

const EMPTY_SESSION: InventorySlotSession = {
  getSlottedCapacity: () => null,
  getPlainAutoStackRows: () => [],
  applyPlainAutoStackDelta: () => undefined,
  registerPlainAutoStackRow: () => undefined,
  listEmptySlots: () => [],
  isSlotAvailable: () => false,
  markSlotOccupied: () => undefined,
  registerSnapshot: () => undefined,
  applyBufferedMutations: () => undefined,
  getProjectedItems: () => [],
};

export const createInventorySlotSession = async (
  characterIds: number[],
): Promise<InventorySlotSession> => {
  const normalizedCharacterIds = normalizeCharacterRewardTargetIds(characterIds);
  if (normalizedCharacterIds.length <= 0) {
    return EMPTY_SESSION;
  }

  await query(
    `
      INSERT INTO inventory (character_id)
      SELECT DISTINCT UNNEST($1::integer[])
      ON CONFLICT (character_id) DO NOTHING
    `,
    [normalizedCharacterIds],
  );

  const [capacityResult, projectedItemGroups] = await Promise.all([
    query<InventoryCapacityRow>(
      `
        SELECT character_id, bag_capacity, warehouse_capacity
        FROM inventory
        WHERE character_id = ANY($1)
      `,
      [normalizedCharacterIds],
    ),
    Promise.all(
      normalizedCharacterIds.map(async (characterId) => ({
        characterId,
        items: await loadProjectedCharacterItemInstances(characterId),
      })),
    ),
  ]);

  const capacityByKey = new Map<string, number>();
  for (const row of capacityResult.rows) {
    const characterId = Number(row.character_id);
    if (!Number.isInteger(characterId) || characterId <= 0) {
      continue;
    }
    capacityByKey.set(buildCapacityKey(characterId, 'bag'), Math.max(0, Math.floor(Number(row.bag_capacity) || 0)));
    capacityByKey.set(buildCapacityKey(characterId, 'warehouse'), Math.max(0, Math.floor(Number(row.warehouse_capacity) || 0)));
  }

  const projectedByCharacter = new Map<number, CharacterItemInstanceSnapshot[]>();
  const usedSlotsByKey = new Map<string, Set<number>>();
  const plainAutoStackRowsByKey = new Map<string, PlainAutoStackState[]>();

  const rebuildCharacterIndexes = (characterId: number): void => {
    const snapshots = projectedByCharacter.get(characterId) ?? [];
    usedSlotsByKey.set(buildCapacityKey(characterId, 'bag'), new Set<number>());
    usedSlotsByKey.set(buildCapacityKey(characterId, 'warehouse'), new Set<number>());

    for (const [key] of plainAutoStackRowsByKey) {
      if (key.startsWith(`${characterId}:`)) {
        plainAutoStackRowsByKey.delete(key);
      }
    }

    for (const snapshot of snapshots) {
      if (isTrackedLocation(snapshot.location) && isTrackedSlot(snapshot.location_slot)) {
        const usedSlots = usedSlotsByKey.get(buildCapacityKey(characterId, snapshot.location)) ?? new Set<number>();
        usedSlots.add(snapshot.location_slot);
        usedSlotsByKey.set(buildCapacityKey(characterId, snapshot.location), usedSlots);
      }

      if (!isTrackedLocation(snapshot.location) || !isPlainStackCandidate(snapshot)) {
        continue;
      }
      const trackedLocation: SlottedInventoryLocation = snapshot.location === 'warehouse' ? 'warehouse' : 'bag';

      const key = buildPlainAutoStackKey(
        characterId,
        String(snapshot.item_def_id || '').trim(),
        trackedLocation,
        normalizeItemBindType(snapshot.bind_type),
      );
      const rows = plainAutoStackRowsByKey.get(key) ?? [];
      rows.push({ id: snapshot.id, qty: Math.max(0, Math.floor(Number(snapshot.qty) || 0)) });
      plainAutoStackRowsByKey.set(key, rows);
    }

    for (const [key, rows] of plainAutoStackRowsByKey.entries()) {
      if (key.startsWith(`${characterId}:`)) {
        sortPlainAutoStackStates(rows);
      }
    }
  };

  for (const group of projectedItemGroups) {
    projectedByCharacter.set(group.characterId, cloneSnapshots(group.items));
    rebuildCharacterIndexes(group.characterId);
  }

  return {
    getSlottedCapacity: (characterId, location) => {
      if (!Number.isInteger(characterId) || characterId <= 0) {
        return null;
      }
      return capacityByKey.get(buildCapacityKey(characterId, location)) ?? null;
    },
    getPlainAutoStackRows: ({ characterId, itemDefId, location, stackMax, bindType, excludeItemId }) => {
      if (stackMax <= 1) {
        return [];
      }
      const rows = plainAutoStackRowsByKey.get(buildPlainAutoStackKey(characterId, itemDefId, location, bindType));
      if (!rows || rows.length <= 0) {
        return [];
      }
      return rows
        .filter((row) => row.qty < stackMax && (excludeItemId === undefined || row.id !== excludeItemId))
        .map((row) => ({ id: row.id, qty: row.qty }));
    },
    applyPlainAutoStackDelta: ({ characterId, itemDefId, location, bindType, itemId, addedQty }) => {
      const normalizedItemId = Math.floor(Number(itemId));
      if (!Number.isInteger(normalizedItemId) || normalizedItemId <= 0) {
        return;
      }
      const rows = plainAutoStackRowsByKey.get(buildPlainAutoStackKey(characterId, itemDefId, location, bindType));
      if (rows) {
        const targetRow = rows.find((row) => row.id === normalizedItemId);
        if (targetRow) {
          targetRow.qty += Math.max(0, Math.floor(Number(addedQty) || 0));
          sortPlainAutoStackStates(rows);
        }
      }

      const snapshots = projectedByCharacter.get(characterId) ?? [];
      const targetSnapshot = snapshots.find((snapshot) => snapshot.id === normalizedItemId);
      if (!targetSnapshot) {
        return;
      }
      targetSnapshot.qty += Math.max(0, Math.floor(Number(addedQty) || 0));
      targetSnapshot.bind_type = bindType;
      targetSnapshot.metadata = null;
      targetSnapshot.quality = null;
      targetSnapshot.quality_rank = null;
    },
    registerPlainAutoStackRow: ({ characterId, itemDefId, location, bindType, itemId, qty }) => {
      const normalizedItemId = Math.floor(Number(itemId));
      if (!Number.isInteger(normalizedItemId) || normalizedItemId <= 0) {
        return;
      }
      const key = buildPlainAutoStackKey(characterId, itemDefId, location, bindType);
      const rows = plainAutoStackRowsByKey.get(key) ?? [];
      rows.push({ id: normalizedItemId, qty: Math.max(0, Math.floor(Number(qty) || 0)) });
      sortPlainAutoStackStates(rows);
      plainAutoStackRowsByKey.set(key, rows);
    },
    listEmptySlots: (characterId, location, count) => {
      const capacity = capacityByKey.get(buildCapacityKey(characterId, location)) ?? 0;
      const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
      if (capacity <= 0 || normalizedCount <= 0) {
        return [];
      }
      const usedSlots = usedSlotsByKey.get(buildCapacityKey(characterId, location)) ?? new Set<number>();
      const emptySlots: number[] = [];
      for (let slot = 0; slot < capacity && emptySlots.length < normalizedCount; slot += 1) {
        if (!usedSlots.has(slot)) {
          emptySlots.push(slot);
        }
      }
      return emptySlots;
    },
    isSlotAvailable: (characterId, location, slot) => {
      if (!isTrackedSlot(slot)) {
        return false;
      }
      const capacity = capacityByKey.get(buildCapacityKey(characterId, location)) ?? 0;
      if (slot >= capacity) {
        return false;
      }
      const usedSlots = usedSlotsByKey.get(buildCapacityKey(characterId, location)) ?? new Set<number>();
      return !usedSlots.has(slot);
    },
    markSlotOccupied: (characterId, location, slot) => {
      if (!isTrackedSlot(slot)) {
        return;
      }
      const usedSlots = usedSlotsByKey.get(buildCapacityKey(characterId, location)) ?? new Set<number>();
      usedSlots.add(slot);
      usedSlotsByKey.set(buildCapacityKey(characterId, location), usedSlots);
    },
    registerSnapshot: (snapshot) => {
      const characterId = Math.floor(Number(snapshot.owner_character_id));
      if (!Number.isInteger(characterId) || characterId <= 0) {
        return;
      }
      const snapshots = projectedByCharacter.get(characterId) ?? [];
      const nextSnapshot = cloneSnapshot(snapshot);
      const targetIndex = snapshots.findIndex((entry) => entry.id === nextSnapshot.id);
      if (targetIndex >= 0) {
        snapshots[targetIndex] = nextSnapshot;
      } else {
        snapshots.push(nextSnapshot);
      }
      projectedByCharacter.set(characterId, snapshots);
      rebuildCharacterIndexes(characterId);
    },
    applyBufferedMutations: (characterId, mutations) => {
      const base = projectedByCharacter.get(characterId) ?? [];
      projectedByCharacter.set(characterId, applyCharacterItemInstanceMutations(base, mutations));
      rebuildCharacterIndexes(characterId);
    },
    getProjectedItems: (characterId) => {
      return cloneSnapshots(projectedByCharacter.get(characterId) ?? []);
    },
  };
};
