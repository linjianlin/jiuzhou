import { query } from '../../config/database.js';
import type { SlottedInventoryLocation } from '../inventory/shared/types.js';
import { isPlainStackingState } from '../inventory/shared/stacking.js';
import { normalizeItemBindType } from './itemBindType.js';
import { normalizeCharacterRewardTargetIds } from './characterRewardTargetLock.js';
import { loadProjectedCharacterItemInstances } from './characterItemInstanceMutationService.js';

/**
 * CharacterInventoryMutationContext - 奖励事务库存视图缓存
 *
 * 作用：
 * 1. 在奖励事务已经统一持锁后，一次性缓存角色背包/仓库容量与“普通可堆叠实例”视图。
 * 2. 为同一事务内的多次 `createItem` 复用容量与堆叠承载行，避免每次入包重复扫 `inventory` 和 `item_instance`。
 *
 * 不做：
 * 1. 不负责事务开启与提交。
 * 2. 不负责真实落库；数据库写入仍由 bag/equipment 服务执行。
 *
 * 输入 / 输出：
 * 1. `createCharacterInventoryMutationContext(characterIds)` 输入角色 ID 列表，输出一份可在同事务内复用的缓存上下文。
 * 2. `getSlottedCapacity/getPlainAutoStackRows/applyPlainAutoStackDelta/registerPlainAutoStackRow` 负责读取和更新内存态视图。
 *
 * 数据流 / 状态流：
 * 角色列表 -> 一次批量读取容量与 projected 可堆叠实例
 * -> 奖励链路多次 createItem 复用同一份内存索引
 * -> 每次成功堆叠/插入后同步回写内存态，保证后续调用看到最新视图。
 *
 * 复用设计说明：
 * 1. 把“奖励事务内的容量 + 堆叠承载缓存”集中到单一模块，battleDropService 与 onlineBattleSettlementRunner 统一复用。
 * 2. bag.ts 仍保留原 SQL 入口作为唯一落库实现，只把热点重复读取前移到这里，避免库存规则再分叉一套。
 *
 * 关键边界条件与坑点：
 * 1. 本模块只适用于调用链已经拿到角色库存互斥锁的事务；否则缓存视图会被并发写入打破。
 * 2. 这里只缓存“普通可堆叠语义”的实例；带 metadata/quality 的实例仍必须走原有精确逻辑，避免错误合堆。
 */

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

type InventoryCapacityRow = {
  character_id: number;
  bag_capacity: number;
  warehouse_capacity: number;
};

type PlainAutoStackState = {
  id: number;
  qty: number;
};

export interface CharacterInventoryMutationContext {
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
}

const EMPTY_CONTEXT: CharacterInventoryMutationContext = {
  getSlottedCapacity: () => null,
  getPlainAutoStackRows: () => [],
  applyPlainAutoStackDelta: () => undefined,
  registerPlainAutoStackRow: () => undefined,
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

export const createCharacterInventoryMutationContext = async (
  characterIds: number[],
): Promise<CharacterInventoryMutationContext> => {
  const normalizedCharacterIds = normalizeCharacterRewardTargetIds(characterIds);
  if (normalizedCharacterIds.length <= 0) {
    return EMPTY_CONTEXT;
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
    if (!Number.isInteger(characterId) || characterId <= 0) continue;
    capacityByKey.set(
      buildCapacityKey(characterId, 'bag'),
      Math.max(0, Math.floor(Number(row.bag_capacity) || 0)),
    );
    capacityByKey.set(
      buildCapacityKey(characterId, 'warehouse'),
      Math.max(0, Math.floor(Number(row.warehouse_capacity) || 0)),
    );
  }

  const plainAutoStackRowsByKey = new Map<string, PlainAutoStackState[]>();
  for (const group of projectedItemGroups) {
    for (const item of group.items) {
      const itemId = Number(item.id);
      const qty = Math.max(0, Math.floor(Number(item.qty) || 0));
      const itemDefId = String(item.item_def_id || '').trim();
      const location = String(item.location || '').trim();
      const bindType = normalizeItemBindType(item.bind_type);
      if (!Number.isInteger(itemId) || itemId <= 0) continue;
      if (!itemDefId) continue;
      if (location !== 'bag' && location !== 'warehouse') continue;
      if (!bindType) continue;
      if (!isPlainStackingState({
        metadataText: item.metadata === null ? null : JSON.stringify(item.metadata),
        quality: item.quality,
        qualityRank: item.quality_rank,
      })) {
        continue;
      }

      const key = buildPlainAutoStackKey(
        group.characterId,
        itemDefId,
        location,
        bindType,
      );
      const rows = plainAutoStackRowsByKey.get(key) ?? [];
      rows.push({ id: itemId, qty });
      plainAutoStackRowsByKey.set(key, rows);
    }
  }

  for (const rows of plainAutoStackRowsByKey.values()) {
    sortPlainAutoStackStates(rows);
  }

  return {
    getSlottedCapacity: (characterId, location) => {
      if (!Number.isInteger(characterId) || characterId <= 0) {
        return null;
      }
      const capacity = capacityByKey.get(buildCapacityKey(characterId, location));
      return capacity ?? null;
    },
    getPlainAutoStackRows: ({
      characterId,
      itemDefId,
      location,
      stackMax,
      bindType,
      excludeItemId,
    }) => {
      if (stackMax <= 1) {
        return [];
      }
      const key = buildPlainAutoStackKey(characterId, itemDefId, location, bindType);
      const rows = plainAutoStackRowsByKey.get(key);
      if (!rows || rows.length <= 0) {
        return [];
      }
      return rows
        .filter((row) => row.qty < stackMax && (excludeItemId === undefined || row.id !== excludeItemId))
        .map((row) => ({ id: row.id, qty: row.qty }));
    },
    applyPlainAutoStackDelta: ({
      characterId,
      itemDefId,
      location,
      bindType,
      itemId,
      addedQty,
    }) => {
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return;
      }
      const key = buildPlainAutoStackKey(characterId, itemDefId, location, bindType);
      const rows = plainAutoStackRowsByKey.get(key);
      if (!rows || rows.length <= 0) {
        return;
      }
      const target = rows.find((row) => row.id === itemId);
      if (!target) {
        return;
      }
      target.qty += Math.max(0, Math.floor(Number(addedQty) || 0));
      sortPlainAutoStackStates(rows);
    },
    registerPlainAutoStackRow: ({
      characterId,
      itemDefId,
      location,
      bindType,
      itemId,
      qty,
    }) => {
      if (!Number.isInteger(itemId) || itemId <= 0) {
        return;
      }
      const key = buildPlainAutoStackKey(characterId, itemDefId, location, bindType);
      const rows = plainAutoStackRowsByKey.get(key) ?? [];
      rows.push({
        id: itemId,
        qty: Math.max(0, Math.floor(Number(qty) || 0)),
      });
      sortPlainAutoStackStates(rows);
      plainAutoStackRowsByKey.set(key, rows);
    },
  };
};
