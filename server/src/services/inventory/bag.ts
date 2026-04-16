/**
 * 背包 CRUD 模块
 *
 * 作用：处理背包物品的增删改查、移动、排序、扩容等基础操作。
 *       不做事务管理（由 service.ts 的 @Transactional 装饰器统一处理）。
 *
 * 输入/输出：
 * - getInventoryInfo(characterId) — 查询背包容量与使用情况
 * - getInventoryItems(characterId, location, page, pageSize) — 分页查询物品列表
 * - findEmptySlots(characterId, location, count) — 查找空闲格子
 * - addItemToInventory(characterId, userId, itemDefId, qty, options) — 添加物品（智能堆叠）
 * - moveItemInstanceToBagWithStacking(characterId, itemInstanceId, options) — 实例入包（保留实例+智能堆叠）
 * - removeItemFromInventory(characterId, itemInstanceId, qty) — 移除物品
 * - setItemLocked(characterId, itemInstanceId, locked) — 锁定/解锁物品
 * - moveItem(characterId, itemInstanceId, targetLocation, targetSlot) — 移动物品
 * - removeItemsBatch(characterId, itemInstanceIds) — 批量丢弃物品
 * - expandInventory(characterId, location, expandSize) — 扩容背包
 * - sortInventory(characterId, location) — 整理背包
 *
 * 数据流：
 * - 读操作直接查询 inventory / item_instance 表
 * - 写操作在事务内执行（由外层 @Transactional 保证）
 *
 * 被引用方：service.ts、equipment.ts（findEmptySlots）、disassemble.ts（addItemToInventory）、
 *           marketService.ts / mailService.ts（moveItemInstanceToBagWithStacking）
 *
 * 边界条件：
 * 1. addItemToInventory 在 INSERT 遇到唯一约束冲突时会重试（最多 6 次），处理并发写入竞争
 * 2. sortInventory 采用两步更新（先写临时负数槽位，再写最终槽位）避免唯一索引瞬时冲突
 */
import { hasUsableTransactionContext, query, withTransaction } from "../../config/database.js";
import {
  getItemDefinitionsByIds,
} from "../staticConfigLoader.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import {
  buildNormalizedItemBindTypeSql,
  normalizeItemBindType,
} from "../shared/itemBindType.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { normalizeItemInstanceObtainedFrom } from "../shared/itemInstanceSource.js";
import { tryInsertItemInstanceWithSlot } from "../shared/itemInstanceSlotInsert.js";
import type {
  InventoryInfo,
  InventoryItem,
  InventoryLocation,
  SlottedInventoryLocation,
} from "./shared/types.js";
import {
  BAG_CAPACITY_MAX,
} from "./shared/types.js";
import {
  safeNumber,
  getStaticItemDef,
  clampInt,
  createDefaultInventoryInfo,
  getSlottedCapacity,
} from "./shared/helpers.js";
import {
  buildPlainStackingSqlPredicate,
  isPlainStackingState,
} from "./shared/stacking.js";
import type { CharacterBagSlotAllocator } from "../shared/characterBagSlotAllocator.js";
import type {
  CharacterInventoryMutationContext,
  PlainAutoStackLookupOptions,
  PlainAutoStackLookupRow,
} from "../shared/characterInventoryMutationContext.js";
import type { InventorySlotSession } from "../shared/inventorySlotSession.js";
import { loadCharacterPendingItemGrants } from "../shared/characterItemGrantDeltaService.js";
import {
  applyCharacterItemInstanceMutations,
  bufferCharacterItemInstanceMutations,
  type BufferedCharacterItemInstanceMutation,
  type ItemInstanceSlotResolution,
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstances,
  loadProjectedCharacterItemInstancesByLocation,
  type CharacterItemInstanceSnapshot,
  type JsonValue,
  tryApplyCharacterItemInstanceMutationsImmediately,
} from "../shared/characterItemInstanceMutationService.js";

// ============================================
// 获取背包信息（容量与使用情况）
// ============================================

/**
 * 查询角色背包/仓库容量与已使用格数
 * 若背包记录不存在则自动初始化
 */
const loadBaseInventoryInfo = async (
  characterId: number,
): Promise<InventoryInfo> => {
  const sql = `
    SELECT
      i.bag_capacity,
      i.warehouse_capacity,
      COALESCE(usage.bag_used, 0)::int AS bag_used,
      COALESCE(usage.warehouse_used, 0)::int AS warehouse_used
    FROM inventory i
    LEFT JOIN (
      SELECT
        owner_character_id,
        COUNT(DISTINCT location_slot) FILTER (WHERE location = 'bag') AS bag_used,
        COUNT(DISTINCT location_slot) FILTER (WHERE location = 'warehouse') AS warehouse_used
      FROM item_instance
      WHERE owner_character_id = $1
        AND location IN ('bag', 'warehouse')
        AND location_slot IS NOT NULL
        AND location_slot >= 0
      GROUP BY owner_character_id
    ) AS usage
      ON usage.owner_character_id = i.character_id
    WHERE i.character_id = $1
  `;

  const result = await query(sql, [characterId]);

  if (result.rows.length === 0) {
    await query(
      "INSERT INTO inventory (character_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [characterId],
    );
    return createDefaultInventoryInfo();
  }

  const info = result.rows[0];
  return info;
};

const sortInventoryItemsForDisplay = (items: InventoryItem[]): InventoryItem[] => {
  return [...items].sort((left, right) => {
    const leftSlot = left.location_slot;
    const rightSlot = right.location_slot;
    if (leftSlot === null && rightSlot !== null) return 1;
    if (leftSlot !== null && rightSlot === null) return -1;
    if (leftSlot !== null && rightSlot !== null && leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }
    return new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime();
  });
};

const loadAllInventoryItemsByLocation = async (
  characterId: number,
  location: InventoryLocation,
): Promise<InventoryItem[]> => {
  const result = await query(
    `
      SELECT
        ii.id, ii.item_def_id, ii.qty, ii.location, ii.location_slot,
        ii.quality, ii.quality_rank,
        ii.metadata,
        ii.equipped_slot, ii.strengthen_level, ii.refine_level,
        ii.socketed_gems,
        ii.affixes, ii.identified, ii.locked, ii.bind_type, ii.created_at
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.location = $2
      ORDER BY ii.location_slot NULLS LAST, ii.created_at DESC
    `,
    [characterId, location],
  );
  return result.rows.map((row) => row as InventoryItem);
};

const mapProjectedSnapshotToInventoryItem = (
  snapshot: CharacterItemInstanceSnapshot,
): InventoryItem => {
  return {
    id: snapshot.id,
    item_def_id: snapshot.item_def_id,
    qty: snapshot.qty,
    quality: snapshot.quality,
    quality_rank: snapshot.quality_rank,
    metadata: snapshot.metadata,
    location: snapshot.location as InventoryLocation,
    location_slot: snapshot.location_slot,
    equipped_slot: snapshot.equipped_slot,
    strengthen_level: snapshot.strengthen_level,
    refine_level: snapshot.refine_level,
    socketed_gems: snapshot.socketed_gems,
    affixes: snapshot.affixes,
    identified: snapshot.identified,
    locked: snapshot.locked,
    bind_type: snapshot.bind_type,
    created_at: snapshot.created_at,
  };
};

/**
 * projected 快照转库存展示实体。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把共享的 `CharacterItemInstanceSnapshot[]` 一次性映射为 `InventoryItem[]`，供容量统计、列表分页、快照查询复用。
 * 2. 不做什么：不做排序、不做分页，也不叠加 pending grant overlay；这些行为由上层查询入口决定。
 *
 * 输入 / 输出：
 * - 输入：同一位置下的 projected 实例快照数组。
 * - 输出：可直接参与库存展示与计数的 `InventoryItem[]`。
 *
 * 数据流 / 状态流：
 * projected snapshot -> 字段映射 -> InventoryItem 列表。
 *
 * 复用设计说明：
 * - 让 `getInventoryInfo`、`getInventoryItems`、`getBagInventorySnapshot` 共享同一份映射逻辑，避免每个入口各自 map 一遍。
 * - 后续如 InventoryItem 展示字段扩展，只需维护这里与 `mapProjectedSnapshotToInventoryItem` 的单一入口。
 *
 * 关键边界条件与坑点：
 * 1. 这里只做结构转换，不会保证 location 已经正确过滤；调用方必须传入目标位置的快照。
 * 2. 返回数组保持输入顺序，若要用于 UI 展示，仍需额外经过排序函数，避免把 DB/id 顺序直接暴露给前端。
 */
const mapProjectedSnapshotsToInventoryItems = (
  snapshots: readonly CharacterItemInstanceSnapshot[],
): InventoryItem[] => snapshots.map((snapshot) => mapProjectedSnapshotToInventoryItem(snapshot));

type GetInventoryInfoOptions = {
  bagProjectedItems?: readonly CharacterItemInstanceSnapshot[];
  warehouseProjectedItems?: readonly CharacterItemInstanceSnapshot[];
  knownPendingGrantsFlushed?: boolean;
};

type GetInventoryItemsOptions = {
  projectedItems?: readonly CharacterItemInstanceSnapshot[];
  pendingMutations?: readonly BufferedCharacterItemInstanceMutation[];
  /**
   * 作用：
   * 1. 调用方已确认当前角色的待 flush 奖励/实例变更都已落成真实 `item_instance` 时，
   *    允许直接走底表分页查询，避免先全量加载 projected 视图再内存切页。
   * 2. 仅用于依赖“真实实例视图”的热路径，例如已经执行过库存 preflight 的 HTTP 请求。
   *
   * 不做什么：
   * - 不会自动帮调用方刷新 pending grants / pending mutations。
   * - 不能用于仍需把未落库 mutation 叠加进可见列表的读路径。
   *
   * 关键边界条件与坑点：
   * 1. 只有在调用方已经把库存实体态收敛完成时才可开启，否则列表会漏掉尚未 flush 的实例变更。
   * 2. 开启后分页直接交给 SQL；若调用方还传入 `projectedItems`，这里会忽略该内存快照。
   */
  knownConcreteState?: boolean;
};

const loadProjectedInventoryItemsByLocation = async (
  characterId: number,
  location: InventoryLocation,
  projectedItems?: readonly CharacterItemInstanceSnapshot[],
  pendingMutations?: readonly BufferedCharacterItemInstanceMutation[],
): Promise<InventoryItem[]> => {
  const resolvedProjectedItems = projectedItems
    ? [...projectedItems]
    : await loadProjectedCharacterItemInstancesByLocation(characterId, location, {
      pendingMutations,
    });
  return mapProjectedSnapshotsToInventoryItems(resolvedProjectedItems);
};

/**
 * 实体态库存分页查询。
 *
 * 作用：
 * 1. 在调用方已确认 inventory/item_instance 不再依赖 projected overlay 时，直接用 SQL 做分页与计数。
 * 2. 复用 `idx_item_instance_slot` 热点索引，把“全量读出再 slice”的工作收回数据库，降低大背包场景的 CPU 和内存开销。
 *
 * 不做什么：
 * - 不叠加 pending grant / pending mutation。
 * - 不修改任何实例状态，也不保证调用前已经完成库存 preflight。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、库存位置、页码、分页大小。
 * - 输出：当前页库存实例与总数。
 *
 * 数据流 / 状态流：
 * characterId + location + page/pageSize -> item_instance SQL 分页 -> InventoryItem[]。
 *
 * 复用设计说明：
 * - `getInventoryItems` 在“实体态已确认”的热路径和老的非 projected location 查询都复用这一条 SQL 入口，避免分页 SQL 分叉两份。
 * - 后续如果库存列表字段扩展，只需同步这一个查询字段集合，不会遗漏快路径。
 *
 * 关键边界条件与坑点：
 * 1. 这里只返回真实实例；若调用方仍需要 projected 语义，必须继续走 `loadProjectedInventoryItemsByLocation`。
 * 2. 排序必须与 projected 读路径保持一致，否则同一背包在不同链路下会出现列表抖动。
 */
const loadConcreteInventoryItemsPage = async (
  characterId: number,
  location: InventoryLocation,
  page: number,
  pageSize: number,
): Promise<{ items: InventoryItem[]; total: number }> => {
  const offset = (page - 1) * pageSize;
  const sql = `
    WITH items AS (
      SELECT
        ii.id, ii.item_def_id, ii.qty, ii.location, ii.location_slot,
        ii.quality, ii.quality_rank,
        ii.metadata,
        ii.equipped_slot, ii.strengthen_level, ii.refine_level,
        ii.socketed_gems,
        ii.affixes, ii.identified, ii.locked, ii.bind_type, ii.created_at
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.location = $2
      ORDER BY ii.location_slot NULLS LAST, ii.created_at DESC
      LIMIT $3 OFFSET $4
    ),
    total AS (
      SELECT COUNT(*) as cnt FROM item_instance
      WHERE owner_character_id = $1 AND location = $2
    )
    SELECT items.*, total.cnt as total_count
    FROM items, total
  `;
  const result = await query(sql, [characterId, location, pageSize, offset]);
  const total =
    result.rows.length > 0 ? parseInt(String(result.rows[0].total_count), 10) : 0;
  const items = result.rows.map((row) => {
    const { total_count, ...item } = row;
    return item as InventoryItem;
  });
  return { items, total };
};

const buildItemInstanceMutationOpId = (
  prefix: string,
  itemId: number,
  index: number,
): string => `${prefix}:${itemId}:${Date.now()}:${index}`;

const buildUpsertItemMutation = (
  prefix: string,
  characterId: number,
  snapshot: CharacterItemInstanceSnapshot,
  index: number,
  slotResolution?: ItemInstanceSlotResolution,
): BufferedCharacterItemInstanceMutation => ({
  opId: buildItemInstanceMutationOpId(prefix, snapshot.id, index),
  characterId,
  itemId: snapshot.id,
  createdAt: Date.now() + index,
  kind: "upsert",
  snapshot,
  slotResolution,
});

const buildDeleteItemMutation = (
  prefix: string,
  characterId: number,
  itemId: number,
  index: number,
): BufferedCharacterItemInstanceMutation => ({
  opId: buildItemInstanceMutationOpId(prefix, itemId, index),
  characterId,
  itemId,
  createdAt: Date.now() + index,
  kind: "delete",
  snapshot: null,
});

const toMetadataText = (metadata: CharacterItemInstanceSnapshot["metadata"]): string | null => {
  if (!metadata) return null;
  return JSON.stringify(metadata);
};

const sortProjectedStackCandidates = (
  rows: readonly CharacterItemInstanceSnapshot[],
): CharacterItemInstanceSnapshot[] => {
  return [...rows].sort((left, right) => {
    if (right.qty !== left.qty) {
      return right.qty - left.qty;
    }
    return left.id - right.id;
  });
};

const applyBufferedMutationsToProjectedItems = (
  sourceItems: readonly CharacterItemInstanceSnapshot[],
  mutations: readonly BufferedCharacterItemInstanceMutation[],
): CharacterItemInstanceSnapshot[] => {
  return applyCharacterItemInstanceMutations(sourceItems, mutations);
};

const collectUsedSlotsFromProjectedItems = (
  items: readonly CharacterItemInstanceSnapshot[],
  location: SlottedInventoryLocation,
): Set<number> => {
  const usedSlots = new Set<number>();
  for (const item of items) {
    if (item.location !== location) {
      continue;
    }
    const slot = item.location_slot;
    if (slot === null || slot < 0) {
      continue;
    }
    usedSlots.add(slot);
  }
  return usedSlots;
};

const findEmptySlotsFromUsedSlots = (
  usedSlots: ReadonlySet<number>,
  capacity: number,
  count: number,
): number[] => {
  if (capacity <= 0 || count <= 0) {
    return [];
  }
  const emptySlots: number[] = [];
  for (let slot = 0; slot < capacity && emptySlots.length < count; slot += 1) {
    if (!usedSlots.has(slot)) {
      emptySlots.push(slot);
    }
  }
  return emptySlots;
};

type MoveItemInstanceToBagComputationResult = {
  success: boolean;
  message: string;
  itemId?: number;
  mutations?: BufferedCharacterItemInstanceMutation[];
  projectedItems?: CharacterItemInstanceSnapshot[];
};

export const buildMoveItemInstanceToBagMutations = async (
  projectedItems: CharacterItemInstanceSnapshot[],
  characterId: number,
  itemInstanceId: number,
  options: {
    expectedSourceLocation: MoveToBagSourceLocation;
    expectedOwnerUserId?: number;
    slotSession?: InventorySlotSession;
  },
): Promise<MoveItemInstanceToBagComputationResult> => {
  const source = projectedItems.find((item) => item.id === itemInstanceId);
  if (!source) {
    return { success: false, message: "物品不存在" };
  }
  if (Number(source.owner_character_id) !== characterId) {
    return { success: false, message: "物品归属异常" };
  }
  if (
    options.expectedOwnerUserId !== undefined &&
    Number(source.owner_user_id) !== options.expectedOwnerUserId
  ) {
    return { success: false, message: "物品归属异常" };
  }

  const location = String(source.location || "");
  if (location !== options.expectedSourceLocation) {
    return { success: false, message: "物品不在预期位置" };
  }

  const itemDefId = String(source.item_def_id || "").trim();
  const itemDef = getStaticItemDef(itemDefId);
  if (!itemDef) {
    return { success: false, message: "物品不存在" };
  }

  const stackMax = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
  const sourceQty = Math.max(1, Math.floor(Number(source.qty) || 1));
  const bindType = normalizeItemBindType(
    typeof source.bind_type === "string" ? source.bind_type : null,
  );
  const sourceCanAutoStack =
    stackMax > 1 &&
    isPlainStackingState({
      metadataText: toMetadataText(source.metadata),
      quality: source.quality,
      qualityRank: source.quality_rank,
    });

  let stackRows: CharacterItemInstanceSnapshot[] = [];
  if (sourceCanAutoStack) {
    stackRows = sortProjectedStackCandidates(
      projectedItems.filter((item) => {
        if (item.id === itemInstanceId) return false;
        if (item.location !== "bag") return false;
        if (item.item_def_id !== itemDefId) return false;
        if (normalizeItemBindType(item.bind_type) !== bindType) return false;
        return isPlainStackingState({
          metadataText: toMetadataText(item.metadata),
          quality: item.quality,
          qualityRank: item.quality_rank,
        }) && item.qty < stackMax;
      }),
    );
  }

  let freeInStacks = 0;
  for (const row of stackRows) {
    freeInStacks += Math.max(0, stackMax - row.qty);
  }
  const needsEmptySlot = Math.max(0, sourceQty - freeInStacks) > 0;

  let remainingQty = sourceQty;
  let representativeItemId: number | null = null;
  const pendingMutations: BufferedCharacterItemInstanceMutation[] = [];
  for (const row of stackRows) {
    if (remainingQty <= 0) break;
    const canAdd = Math.min(remainingQty, Math.max(0, stackMax - row.qty));
    if (canAdd <= 0) continue;

    pendingMutations.push(buildUpsertItemMutation(
      "move-instance-to-bag",
      characterId,
      {
        ...row,
        qty: row.qty + canAdd,
        bind_type: bindType,
        metadata: null,
        quality: null,
        quality_rank: null,
      },
      pendingMutations.length,
    ));

    if (representativeItemId === null) {
      representativeItemId = row.id;
    }
    remainingQty -= canAdd;
  }

  if (remainingQty <= 0) {
    pendingMutations.push(buildDeleteItemMutation(
      "move-instance-to-bag",
      characterId,
      itemInstanceId,
      pendingMutations.length,
    ));
    if (representativeItemId === null) {
      throw new Error("实例堆叠后缺少承载目标，数据状态异常");
    }
    return {
      success: true,
      message: "移动成功",
      itemId: representativeItemId,
      mutations: pendingMutations,
      projectedItems: applyBufferedMutationsToProjectedItems(projectedItems, pendingMutations),
    };
  }

  let targetSlot: number | null = null;
  if (needsEmptySlot) {
    const localProjectedItems = applyBufferedMutationsToProjectedItems(projectedItems, pendingMutations);
    const bagCapacity = options.slotSession?.getSlottedCapacity(characterId, "bag")
      ?? getSlottedCapacity(await getInventoryInfo(characterId), "bag");
    targetSlot = findFirstEmptyProjectedSlot(
      localProjectedItems,
      "bag",
      bagCapacity,
    );
    if (targetSlot === null) {
      return { success: false, message: "背包已满" };
    }
  }

  if (targetSlot === null) {
    throw new Error("实例剩余数量需落格但未分配格子，数据状态异常");
  }

  pendingMutations.push(buildUpsertItemMutation(
    "move-instance-to-bag",
    characterId,
    {
      ...source,
      qty: remainingQty,
      location: "bag",
      location_slot: null,
      equipped_slot: null,
      bind_type: bindType,
      metadata: sourceCanAutoStack ? null : source.metadata,
      quality: sourceCanAutoStack ? null : source.quality,
      quality_rank: sourceCanAutoStack ? null : source.quality_rank,
    },
    pendingMutations.length,
    { mode: 'auto' },
  ));

  return {
    success: true,
    message: "移动成功",
    itemId: itemInstanceId,
    mutations: pendingMutations,
    projectedItems: applyBufferedMutationsToProjectedItems(projectedItems, pendingMutations),
  };
};

const findFirstEmptyProjectedSlot = (
  items: readonly CharacterItemInstanceSnapshot[],
  location: SlottedInventoryLocation,
  capacity: number,
): number | null => {
  return findEmptySlotsFromUsedSlots(
    collectUsedSlotsFromProjectedItems(items, location),
    capacity,
    1,
  )[0] ?? null;
};

const buildPendingGrantItemDefMap = (
  pendingGrants: Array<{ itemDefId: string }>,
) => {
  const itemDefIds = [
    ...new Set(
      pendingGrants
        .map((grant) => grant.itemDefId)
        .filter((itemDefId) => itemDefId.length > 0),
    ),
  ];
  return getItemDefinitionsByIds(itemDefIds);
};

const countPendingEquipmentSlots = (
  pendingGrants: Array<{ itemDefId: string; qty: number }>,
  itemDefMap: ReturnType<typeof getItemDefinitionsByIds>,
): number => {
  let pendingEquipmentSlots = 0;
  for (const grant of pendingGrants) {
    if (itemDefMap.get(grant.itemDefId)?.category !== "equipment") continue;
    pendingEquipmentSlots += Math.max(0, Math.floor(Number(grant.qty) || 0));
  }
  return pendingEquipmentSlots;
};

const applyPendingBagGrantOverlay = (
  baseItems: InventoryItem[],
  pendingGrants: Awaited<ReturnType<typeof loadCharacterPendingItemGrants>>,
  bagCapacity: number,
  itemDefMap: ReturnType<typeof getItemDefinitionsByIds>,
): InventoryItem[] => {
  if (pendingGrants.length <= 0) {
    return baseItems;
  }
  const overlayItems = sortInventoryItemsForDisplay(baseItems);
  const usedSlots = new Set(
    overlayItems
      .map((item) => item.location_slot)
      .filter((slot): slot is number => slot !== null && slot >= 0),
  );
  let nextSyntheticId = -1;

  const allocateSlot = (): number | null => {
    for (let slot = 0; slot < bagCapacity; slot += 1) {
      if (usedSlots.has(slot)) continue;
      usedSlots.add(slot);
      return slot;
    }
    return null;
  };

  for (const grant of pendingGrants) {
    let remainingQty = Math.max(0, Math.floor(Number(grant.qty) || 0));
    if (remainingQty <= 0) continue;

    const itemDef = itemDefMap.get(grant.itemDefId);
    if (itemDef?.category === "equipment") {
      continue;
    }
    const stackMax = Math.max(1, Math.floor(Number(itemDef?.stack_max) || 1));
    const canAutoStack =
      stackMax > 1 &&
      grant.metadata === null &&
      grant.quality === null &&
      grant.qualityRank === null;

    if (canAutoStack) {
      for (const item of overlayItems) {
        if (remainingQty <= 0) break;
        if (item.item_def_id !== grant.itemDefId) continue;
        if (normalizeItemBindType(item.bind_type) !== grant.bindType) continue;
        if (item.metadata !== null) continue;
        if (item.quality !== null || item.quality_rank !== null) continue;
        const available = Math.max(0, stackMax - Math.max(0, Number(item.qty) || 0));
        if (available <= 0) continue;
        const mergedQty = Math.min(available, remainingQty);
        item.qty += mergedQty;
        remainingQty -= mergedQty;
      }
    }

    while (remainingQty > 0) {
      const locationSlot = allocateSlot();
      if (locationSlot === null) {
        break;
      }
      const chunkQty = Math.min(remainingQty, stackMax);
      overlayItems.push({
        id: nextSyntheticId,
        item_def_id: grant.itemDefId,
        qty: chunkQty,
        quality: grant.quality,
        quality_rank: grant.qualityRank,
        metadata: grant.metadata,
        location: "bag",
        location_slot: locationSlot,
        equipped_slot: null,
        strengthen_level: 0,
        refine_level: 0,
        socketed_gems: null,
        affixes: [],
        identified: false,
        locked: false,
        bind_type: grant.bindType,
        created_at: new Date(),
      });
      nextSyntheticId -= 1;
      remainingQty -= chunkQty;
    }
  }

  return sortInventoryItemsForDisplay(overlayItems);
};

export const getInventoryInfo = async (
  characterId: number,
  options: GetInventoryInfoOptions = {},
): Promise<InventoryInfo> => {
  const infoPromise = loadBaseInventoryInfo(characterId);
  const bagProjectedItemsPromise = options.bagProjectedItems
    ? Promise.resolve([...options.bagProjectedItems])
    : loadProjectedCharacterItemInstancesByLocation(characterId, "bag");
  const warehouseProjectedItemsPromise = options.warehouseProjectedItems
    ? Promise.resolve([...options.warehouseProjectedItems])
    : loadProjectedCharacterItemInstancesByLocation(characterId, "warehouse");
  const [info, bagProjectedItems, warehouseProjectedItems, pendingGrants] = await Promise.all([
    infoPromise,
    bagProjectedItemsPromise,
    warehouseProjectedItemsPromise,
    options.knownPendingGrantsFlushed
      ? Promise.resolve([])
      : loadCharacterPendingItemGrants(characterId),
  ]);
  const itemDefMap = buildPendingGrantItemDefMap(pendingGrants);
  const projectedBagItems = mapProjectedSnapshotsToInventoryItems(bagProjectedItems);
  const projectedWarehouseItems = mapProjectedSnapshotsToInventoryItems(warehouseProjectedItems);
  if (pendingGrants.length <= 0) {
    return {
      ...info,
      bag_used: projectedBagItems.filter((item) => item.location_slot !== null && item.location_slot >= 0).length,
      warehouse_used: projectedWarehouseItems.filter((item) => item.location_slot !== null && item.location_slot >= 0).length,
    };
  }
  const overlayBagItems = applyPendingBagGrantOverlay(
    projectedBagItems,
    pendingGrants,
    Number(info.bag_capacity) || 0,
    itemDefMap,
  );
  return {
    ...info,
    bag_used:
      overlayBagItems.filter((item) => item.location_slot !== null && item.location_slot >= 0).length +
      countPendingEquipmentSlots(pendingGrants, itemDefMap),
    warehouse_used: projectedWarehouseItems.filter((item) => item.location_slot !== null && item.location_slot >= 0).length,
  };
};

// ============================================
// 获取背包物品列表（分页优化）
// ============================================

/**
 * 获取可操作的库存实例列表。
 *
 * 作用：
 * 1. 只返回已经进入 projected item instance 视图的真实实例，供背包弹窗、仓库弹窗等可执行操作的 UI 直接消费。
 * 2. 不把待 flush 的奖励 Delta 混入返回结果，避免前端拿到负数临时 ID 或被提前叠加后的伪数量。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、位置、分页参数。
 * - 输出：按展示顺序排序后的真实库存实例列表与总数。
 *
 * 数据流 / 状态流：
 * characterId + location -> projected item instance 视图 -> 展示排序 -> 分页返回。
 *
 * 复用设计说明：
 * - 把“可操作列表只暴露真实实例”的约束集中在这里，避免 BagModal / WarehouseModal / 快照查询各自再过滤伪物品。
 * - 待 flush 奖励仍由 `getInventoryInfo` 参与容量占用统计，列表侧则保持纯实例语义，减少展示态与写入态不一致。
 *
 * 关键边界条件与坑点：
 * 1. 待 flush 奖励不能出现在可点击列表里，否则使用 / 移动 / 上锁等操作会拿到不存在的实例 ID。
 * 2. 待 flush 可堆叠奖励也不能提前合并进真实实例数量，否则前端会显示出服务端尚不可消费的数量，触发“数量不足”假象。
 */
export const getInventoryItems = async (
  characterId: number,
  location: InventoryLocation = "bag",
  page: number = 1,
  pageSize: number = 100,
  options: GetInventoryItemsOptions = {},
): Promise<{ items: InventoryItem[]; total: number }> => {
  if (options.knownConcreteState) {
    return loadConcreteInventoryItemsPage(characterId, location, page, pageSize);
  }

  if (location === "bag") {
    const rawItems = sortInventoryItemsForDisplay(
      await loadProjectedInventoryItemsByLocation(
        characterId,
        location,
        options.projectedItems,
        options.pendingMutations,
      ),
    );
    const offset = (page - 1) * pageSize;
    return {
      items: rawItems.slice(offset, offset + pageSize),
      total: rawItems.length,
    };
  }
  if (location === "warehouse" || location === "equipped") {
    const rawItems = sortInventoryItemsForDisplay(
      await loadProjectedInventoryItemsByLocation(
        characterId,
        location,
        options.projectedItems,
        options.pendingMutations,
      ),
    );
    const offset = (page - 1) * pageSize;
    return {
      items: rawItems.slice(offset, offset + pageSize),
      total: rawItems.length,
    };
  }
  return loadConcreteInventoryItemsPage(characterId, location, page, pageSize);
};

// ============================================
// 查找空闲格子
// ============================================

/**
 * 按已知容量查找空闲格子。
 *
 * 作用：
 * - 复用“读取已占用槽位并推导空槽”的公共逻辑；
 * - 让已提前拿到容量的调用链避免重复查询 `inventory` 表。
 *
 * 输入/输出：
 * - 输入：角色 ID、位置、已解析出的容量、所需空格数。
 * - 输出：按槽位升序返回最多 `count` 个空槽。
 *
 * 数据流：
 * - 调用方负责先拿到容量；
 * - 本函数只查询 `item_instance.location_slot`；
 * - 依据容量线性扫描缺口，返回可用槽位。
 *
 * 关键边界条件与坑点：
 * 1. `capacity <= 0` 时直接返回空数组，避免无意义 SQL。
 * 2. 本函数不校验位置容量来源，调用方必须保证 `capacity` 与 `location` 对应。
 */
const findEmptySlotsByCapacity = async (
  characterId: number,
  location: SlottedInventoryLocation,
  capacity: number,
  count: number,
): Promise<number[]> => {
  if (capacity <= 0 || count <= 0) {
    return [];
  }

  const projectedItems = await loadProjectedCharacterItemInstancesByLocation(characterId, location);
  return findEmptySlotsFromUsedSlots(
    collectUsedSlotsFromProjectedItems(projectedItems, location),
    capacity,
    count,
  );
};

/**
 * 查找指定位置的空闲格子
 * 统一使用 query() 自动走事务连接
 */
export const findEmptySlots = async (
  characterId: number,
  location: SlottedInventoryLocation,
  count: number = 1,
): Promise<number[]> => {
  const info = await getInventoryInfo(characterId);
  const capacity = getSlottedCapacity(info, location);
  return findEmptySlotsByCapacity(characterId, location, capacity, count);
};

// ============================================
// 添加物品到背包（智能堆叠）
// ============================================

/**
 * 统一的库存写事务执行器。
 * 调用者已经在事务中，直接执行。
 */
const runInventoryMutation = async <T extends { success: boolean }>(
  executor: () => Promise<T>,
): Promise<T> => {
  return await executor();
};

const buildInventoryMutationSavepointName = (): string => {
  return `inventory_mutation_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
};

const serializeInventoryMetadata = (
  metadata: object | null | undefined,
): string | null => {
  if (!metadata) {
    return null;
  }

  return Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null;
};

const ITEM_INSTANCE_STACKABLE_BIND_TYPE_SQL = buildNormalizedItemBindTypeSql(
  "bind_type",
);
const ITEM_INSTANCE_STACKABLE_PREDICATE_SQL = buildPlainStackingSqlPredicate({
  metadata: "metadata",
  quality: "quality",
  qualityRank: "quality_rank",
});
const PLAIN_STACKING_CANONICAL_SET_SQL = `
bind_type = $2,
metadata = NULL,
quality = NULL,
quality_rank = NULL,
updated_at = NOW()
`;

/**
 * 读取当前入包链路可复用的普通堆叠承载实例。
 *
 * 作用：
 * - 统一复用“旧空语义 + 标准绑定态”的 SQL 判定，避免新增入包、实例回包各写一套兼容查询。
 * - 查询结果只覆盖语义上属于普通可堆叠的实例，真正的数据归一化在写入时一次完成。
 *
 * 边界条件：
 * 1. SQL 结构必须与性能索引保持同构，确保兼容旧数据后依然走热点索引。
 * 2. `excludeItemId` 只用于回包场景排除来源实例，普通掉落/奖励入包不传即可。
 */
const loadPlainAutoStackRows = async ({
  characterId,
  itemDefId,
  location,
  stackMax,
  bindType,
  excludeItemId,
  inventoryMutationContext,
  slotSession,
}: PlainAutoStackLookupOptions & {
  inventoryMutationContext?: CharacterInventoryMutationContext;
  slotSession?: InventorySlotSession;
}): Promise<PlainAutoStackLookupRow[]> => {
  if (stackMax <= 1) {
    return [];
  }

  if (slotSession) {
    return slotSession.getPlainAutoStackRows({
      characterId,
      itemDefId,
      location,
      stackMax,
      bindType,
      ...(excludeItemId !== undefined ? { excludeItemId } : {}),
    });
  }

  if (inventoryMutationContext) {
    return inventoryMutationContext.getPlainAutoStackRows({
      characterId,
      itemDefId,
      location,
      stackMax,
      bindType,
      ...(excludeItemId !== undefined ? { excludeItemId } : {}),
    });
  }

  const params: Array<number | string> = [
    characterId,
    itemDefId,
    location,
    stackMax,
    bindType,
  ];
  const excludeItemClause =
    excludeItemId === undefined
      ? ""
      : `
          AND id != $6
        `;
  if (excludeItemId !== undefined) {
    params.push(excludeItemId);
  }

  const stackResult = await query(
    `
      SELECT id, qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND location = $3
        AND qty < $4
        AND ${ITEM_INSTANCE_STACKABLE_BIND_TYPE_SQL} = $5
        AND ${ITEM_INSTANCE_STACKABLE_PREDICATE_SQL}
        ${excludeItemClause}
      ORDER BY qty DESC, id ASC
      FOR UPDATE
    `,
    params,
  );

  return stackResult.rows.map((row) => ({
    id: Number(row.id),
    qty: Math.max(0, Math.floor(Number(row.qty) || 0)),
  }));
};

/**
 * 添加物品到背包/仓库
 * 支持智能堆叠：优先填充已有堆叠行，不够再创建新行
 */
export const addItemToInventory = async (
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: SlottedInventoryLocation;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
    metadata?: Record<string, unknown> | null;
    quality?: string | null;
    qualityRank?: number | null;
    bagSlotAllocator?: CharacterBagSlotAllocator;
    inventoryMutationContext?: CharacterInventoryMutationContext;
    slotSession?: InventorySlotSession;
    skipInventoryMutexLock?: boolean;
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "数量参数错误" };
  }

  return runInventoryMutation(async () => {
    if (!options.skipInventoryMutexLock) {
      await lockCharacterInventoryMutex(characterId);
    }

    const location = options.location || "bag";
    const requestedBindType = normalizeItemBindType(options.bindType);

    const itemDef = getStaticItemDef(itemDefId);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }

    const stack_max = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
    const defaultBindType = normalizeItemBindType(
      typeof itemDef.bind_type === "string" ? itemDef.bind_type : null,
    );
    const actualBindType =
      requestedBindType !== "none" ? requestedBindType : defaultBindType;
    const obtainedFrom = normalizeItemInstanceObtainedFrom(
      options.obtainedFrom,
    ).value;
    const metadataJson = serializeInventoryMetadata(options.metadata);
    const quality = typeof options.quality === "string" && options.quality.trim().length > 0
      ? options.quality.trim()
      : null;
    const qualityRank =
      options.qualityRank !== undefined && options.qualityRank !== null
        ? Math.max(1, Math.floor(Number(options.qualityRank) || 1))
        : null;
    const canStackByOption = !metadataJson && !quality && qualityRank === null;
    const slotSession = options.slotSession;
    const snapshotMetadata = metadataJson === null
      ? null
      : JSON.parse(metadataJson) as { [key: string]: JsonValue };
    const snapshotAffixes = options.affixes
      ? JSON.parse(JSON.stringify(options.affixes)) as JsonValue
      : [];

    const cachedCapacity = slotSession?.getSlottedCapacity(characterId, location)
      ?? options.inventoryMutationContext?.getSlottedCapacity(characterId, location)
      ?? null;
    const info = cachedCapacity === null || cachedCapacity === undefined
      ? await getInventoryInfo(characterId)
      : null;
    const capacity =
      cachedCapacity === null || cachedCapacity === undefined
        ? getSlottedCapacity(info!, location)
        : cachedCapacity;

    const itemIds: number[] = [];
    let remainingQty = qty;

    let stackRows: PlainAutoStackLookupRow[] = [];
    if (stack_max > 1 && canStackByOption) {
      stackRows = await loadPlainAutoStackRows({
        characterId,
        itemDefId,
          location,
          stackMax: stack_max,
          bindType: actualBindType,
          ...(slotSession ? { slotSession } : {}),
          ...(options.inventoryMutationContext
            ? { inventoryMutationContext: options.inventoryMutationContext }
            : {}),
      });
    }

    let remainingAfterStacks = remainingQty;
    if (stack_max > 1 && stackRows.length > 0) {
      let freeInStacks = 0;
      for (const row of stackRows) {
        const rowQty = Number(row.qty) || 0;
        const free = Math.max(0, stack_max - rowQty);
        freeInStacks += free;
      }
      remainingAfterStacks = Math.max(0, remainingQty - freeInStacks);
    }

    const neededSlots =
      remainingAfterStacks <= 0
        ? 0
        : Math.ceil(remainingAfterStacks / Math.max(1, stack_max));
    const reservedBagSlots =
      location === "bag" && !slotSession && options.bagSlotAllocator
        ? options.bagSlotAllocator.reserveSlots(characterId, neededSlots)
        : [];
    if (neededSlots > 0) {
      const emptySlots =
        slotSession
          ? slotSession.listEmptySlots(characterId, location, neededSlots)
          : location === "bag" && options.bagSlotAllocator
          ? reservedBagSlots
          : await findEmptySlotsByCapacity(
              characterId,
              location,
              capacity,
              neededSlots,
            );
      if (emptySlots.length < neededSlots) {
        return { success: false, message: "背包已满" };
      }
    }

    const executeWritePlan = async (): Promise<{
      success: boolean;
      message: string;
      itemIds?: number[];
      appliedStackDeltas: Array<{ itemId: number; addedQty: number }>;
      insertedRows: Array<{ itemId: number; qty: number; slot: number }>;
    }> => {
      const writeItemIds: number[] = [];
      const appliedStackDeltas: Array<{ itemId: number; addedQty: number }> = [];
      const insertedRows: Array<{ itemId: number; qty: number; slot: number }> = [];
      const locallyOccupiedSlots = new Set<number>();
      const locallyRejectedSlots = new Set<number>();
      let writeRemainingQty = remainingQty;

      if (stack_max > 1 && canStackByOption && stackRows.length > 0) {
        for (const row of stackRows) {
          if (writeRemainingQty <= 0) break;

          const rowQty = Number(row.qty) || 0;
          const canAdd = Math.min(writeRemainingQty, Math.max(0, stack_max - rowQty));
          if (canAdd <= 0) continue;

          await query(
            `
              UPDATE item_instance
              SET qty = qty + $1,
                  ${PLAIN_STACKING_CANONICAL_SET_SQL}
              WHERE id = $3
            `,
            [canAdd, actualBindType, row.id],
          );
          appliedStackDeltas.push({ itemId: row.id, addedQty: canAdd });
          writeItemIds.push(row.id);
          writeRemainingQty -= canAdd;
        }
      }

      let nextReservedBagSlotIndex = 0;
      while (writeRemainingQty > 0) {
        const addQty = Math.min(writeRemainingQty, Math.max(1, stack_max));
        let insertedId: number | null = null;
        let insertedSlot: number | null = null;
        let attempt = 0;

        while (insertedId === null && attempt < 6) {
          attempt += 1;
          const emptySlots = slotSession
            ? slotSession
              .listEmptySlots(characterId, location, capacity)
              .filter((slot) => !locallyOccupiedSlots.has(slot) && !locallyRejectedSlots.has(slot))
              .slice(0, 6)
            : location === "bag" && options.bagSlotAllocator
              ? reservedBagSlots.slice(nextReservedBagSlotIndex, nextReservedBagSlotIndex + 1)
              : await findEmptySlotsByCapacity(
                  characterId,
                  location,
                  capacity,
                  6,
                );
          if (emptySlots.length === 0) {
            throw new Error('inventory-add-failed:背包已满');
          }

          for (const slot of emptySlots) {
            const inserted = await tryInsertItemInstanceWithSlot(
              `
                  INSERT INTO item_instance (
                    owner_user_id, owner_character_id, item_def_id, qty,
                    location, location_slot, bind_type, affixes, obtained_from,
                    metadata, quality, quality_rank
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
              `,
              [
                userId,
                characterId,
                itemDefId,
                addQty,
                location,
                slot,
                actualBindType,
                options.affixes ? JSON.stringify(options.affixes) : null,
                obtainedFrom,
                metadataJson,
                quality,
                qualityRank,
              ],
            );
            if (inserted !== null) {
              insertedId = inserted;
              insertedSlot = slot;
              locallyOccupiedSlots.add(slot);
              if (location === "bag" && options.bagSlotAllocator) {
                nextReservedBagSlotIndex += 1;
              }
              insertedRows.push({ itemId: inserted, qty: addQty, slot });
              break;
            }
            locallyRejectedSlots.add(slot);
          }
        }

        if (insertedId === null || insertedSlot === null || !Number.isFinite(insertedId)) {
          throw new Error('inventory-add-failed:背包已满');
        }

        writeItemIds.push(insertedId);
        writeRemainingQty -= addQty;
      }

      return {
        success: true,
        message: "添加成功",
        itemIds: writeItemIds,
        appliedStackDeltas,
        insertedRows,
      };
    };

    try {
      const result = !hasUsableTransactionContext()
        ? await withTransaction(async () => executeWritePlan())
        : await (async () => {
            const savepointName = buildInventoryMutationSavepointName();
            await query(`SAVEPOINT ${savepointName}`);
            try {
              const savepointResult = await executeWritePlan();
              await query(`RELEASE SAVEPOINT ${savepointName}`);
              return savepointResult;
            } catch (error) {
              await query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
              await query(`RELEASE SAVEPOINT ${savepointName}`);
              throw error;
            }
          })();

      for (const delta of result.appliedStackDeltas) {
        if (slotSession) {
          slotSession.applyPlainAutoStackDelta({
            characterId,
            itemDefId,
            location,
            bindType: actualBindType,
            itemId: delta.itemId,
            addedQty: delta.addedQty,
          });
        } else {
          options.inventoryMutationContext?.applyPlainAutoStackDelta({
            characterId,
            itemDefId,
            location,
            bindType: actualBindType,
            itemId: delta.itemId,
            addedQty: delta.addedQty,
          });
        }
      }

      for (const row of result.insertedRows) {
        if (canStackByOption) {
          if (slotSession) {
            slotSession.registerPlainAutoStackRow({
              characterId,
              itemDefId,
              location,
              bindType: actualBindType,
              itemId: row.itemId,
              qty: row.qty,
            });
          } else {
            options.inventoryMutationContext?.registerPlainAutoStackRow({
              characterId,
              itemDefId,
              location,
              bindType: actualBindType,
              itemId: row.itemId,
              qty: row.qty,
            });
          }
        }
        slotSession?.registerSnapshot({
          id: row.itemId,
          owner_user_id: userId,
          owner_character_id: characterId,
          item_def_id: itemDefId,
          qty: row.qty,
          quality,
          quality_rank: qualityRank,
          metadata: snapshotMetadata,
          location,
          location_slot: row.slot,
          equipped_slot: null,
          strengthen_level: 0,
          refine_level: 0,
          socketed_gems: [],
          affixes: snapshotAffixes,
          identified: true,
          locked: false,
          bind_type: actualBindType,
          bind_owner_user_id: null,
          bind_owner_character_id: null,
          random_seed: null,
          affix_gen_version: 0,
          affix_roll_meta: null,
          custom_name: null,
          expire_at: null,
          obtained_from: obtainedFrom,
          obtained_ref_id: null,
          created_at: new Date(),
        });
      }

      itemIds.push(...(result.itemIds ?? []));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('inventory-add-failed:')) {
        return {
          success: false,
          message: error.message.replace('inventory-add-failed:', ''),
        };
      }
      throw error;
    }

    if (info) {
      const usedSlots = location === "bag" ? info.bag_used : info.warehouse_used;
      if (usedSlots > capacity) {
        return { success: false, message: "背包数据异常" };
      }
    }

    return { success: true, message: "添加成功", itemIds };
  });
};

type MoveToBagSourceLocation = "auction" | "mail";

type MoveToBagSourceRow = {
  id: number;
  owner_user_id: number;
  owner_character_id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  metadata_text: string | null;
  location: string;
  bind_type: string;
};

/**
 * 实例入包并自动堆叠（保留原实例属性）
 *
 * 作用：
 * - 将来源为 `auction/mail` 的实例移入背包；
 * - 若为可堆叠物品，优先合并到背包同类堆叠，再决定是否占用新格子。
 *
 * 输入/输出：
 * - 输入：角色ID、实例ID、来源位置与可选 ownerUserId 校验
 * - 输出：成功时返回最终承载该数量的实例ID（可能是原实例，也可能是被合并目标）
 *
 * 数据流：
 * 1) 先锁定来源实例 + 目标可堆叠实例，计算是否需要新格子；
 * 2) 再执行数量合并；
 * 3) 若数量未合并完，则把来源实例迁移到背包空格。
 *
 * 边界条件：
 * 1) 所有“可能失败”的条件（来源状态、空格不足）必须在写入前完成校验，避免事务提交半状态。
 * 2) 该函数不主动加背包互斥锁，调用方必须先持有同角色背包锁，确保并发下空格与堆叠计算稳定。
 */
export const moveItemInstanceToBagWithStacking = async (
  characterId: number,
  itemInstanceId: number,
  options: {
    expectedSourceLocation: MoveToBagSourceLocation;
    expectedOwnerUserId?: number;
    slotSession?: InventorySlotSession;
  },
): Promise<{ success: boolean; message: string; itemId?: number }> => {
  const projectedItems = options.slotSession?.getProjectedItems(characterId)
    ?? await loadProjectedCharacterItemInstances(characterId);
  const result = await buildMoveItemInstanceToBagMutations(
    projectedItems,
    characterId,
    itemInstanceId,
    options,
  );
  if (!result.success || !result.mutations) {
    return { success: result.success, message: result.message, itemId: result.itemId };
  }
  await bufferCharacterItemInstanceMutations(result.mutations);
  options.slotSession?.applyBufferedMutations(characterId, result.mutations);
  return { success: true, message: result.message, itemId: result.itemId };
};

export const moveItemInstancesToBagWithStacking = async (
  characterId: number,
  itemInstanceIds: number[],
  options: {
    expectedSourceLocation: MoveToBagSourceLocation;
    expectedOwnerUserId?: number;
    persistImmediately?: boolean;
    slotSession?: InventorySlotSession;
  },
): Promise<{ success: boolean; message: string; itemIds: number[] }> => {
  const buildBatchMutations = async (): Promise<{
    success: boolean;
    message: string;
    itemIds: number[];
    mutations: BufferedCharacterItemInstanceMutation[];
  }> => {
    let projectedItems = options.slotSession?.getProjectedItems(characterId)
      ?? await loadProjectedCharacterItemInstances(characterId);
    const bufferedMutations: BufferedCharacterItemInstanceMutation[] = [];
    const itemIds: number[] = [];

    for (const itemInstanceId of itemInstanceIds) {
      const result = await buildMoveItemInstanceToBagMutations(
        projectedItems,
        characterId,
        itemInstanceId,
        options,
      );
      if (!result.success || !result.mutations || !result.projectedItems) {
        return { success: false, message: result.message, itemIds, mutations: [] };
      }
      bufferedMutations.push(...result.mutations);
      projectedItems = result.projectedItems;
      if (result.itemId !== undefined) {
        itemIds.push(result.itemId);
      }
    }

    return {
      success: true,
      message: '移动成功',
      itemIds,
      mutations: bufferedMutations,
    };
  };

  if (!options.persistImmediately) {
    const batchResult = await buildBatchMutations();
    if (!batchResult.success) {
      return { success: false, message: batchResult.message, itemIds: batchResult.itemIds };
    }
    await bufferCharacterItemInstanceMutations(batchResult.mutations);
    options.slotSession?.applyBufferedMutations(characterId, batchResult.mutations);
    return { success: true, message: batchResult.message, itemIds: batchResult.itemIds };
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const batchResult = await buildBatchMutations();
    if (!batchResult.success) {
      return { success: false, message: batchResult.message, itemIds: batchResult.itemIds };
    }

    const applied = await tryApplyCharacterItemInstanceMutationsImmediately(batchResult.mutations);
    if (applied) {
      options.slotSession?.applyBufferedMutations(characterId, batchResult.mutations);
      return { success: true, message: batchResult.message, itemIds: batchResult.itemIds };
    }
  }

  return { success: false, message: '背包槽位冲突，请稍后重试', itemIds: [] };
};

// ============================================
// 移除物品（支持部分移除）
// ============================================

export const removeItemFromInventory = async (
  characterId: number,
  itemInstanceId: number,
  qty: number = 1,
): Promise<{ success: boolean; message: string }> => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "数量参数错误" };
  }
  
  await lockCharacterInventoryMutex(characterId);

  const item = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
  if (!item) {
    return { success: false, message: "物品不存在" };
  }

  if (item.locked) {
    return { success: false, message: "物品已锁定" };
  }

  if (item.qty < qty) {
    return { success: false, message: "数量不足" };
  }

  if (item.qty === qty) {
    await bufferCharacterItemInstanceMutations([
      buildDeleteItemMutation("remove-item", characterId, itemInstanceId, 0),
    ]);
  } else {
    await bufferCharacterItemInstanceMutations([
      buildUpsertItemMutation(
        "remove-item",
        characterId,
        {
          ...item,
          qty: item.qty - qty,
        },
        0,
      ),
    ]);
  }
  return { success: true, message: "移除成功" };
};

// ============================================
// 锁定 / 解锁物品
// ============================================

export const setItemLocked = async (
  characterId: number,
  itemInstanceId: number,
  locked: boolean,
): Promise<{
  success: boolean;
  message: string;
  data?: { itemId: number; locked: boolean };
}> => {
  await lockCharacterInventoryMutex(characterId);

  const itemResult = await query(
    `
      SELECT id, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
    `,
    [itemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0) {
    return { success: false, message: "物品不存在" };
  }

  const row = itemResult.rows[0] as { id: number; location: string };
  const location = String(row.location || "");
  if (location === "auction") {
    return { success: false, message: "该物品当前位置不可锁定" };
  }
  if (!["bag", "warehouse", "equipped"].includes(location)) {
    return { success: false, message: "该物品当前位置不可锁定" };
  }

  await query(
    `
      UPDATE item_instance
      SET locked = $1, updated_at = NOW()
      WHERE id = $2 AND owner_character_id = $3
    `,
    [locked, itemInstanceId, characterId],
  );
  return {
    success: true,
    message: locked ? "已锁定" : "已解锁",
    data: { itemId: itemInstanceId, locked },
  };
};

// ============================================
// 移动物品（换位/移动到仓库）
// ============================================

export const moveItem = async (
  characterId: number,
  itemInstanceId: number,
  targetLocation: SlottedInventoryLocation,
  targetSlot?: number,
): Promise<{ success: boolean; message: string }> => {
  await lockCharacterInventoryMutex(characterId);

  const projectedItems = await loadProjectedCharacterItemInstances(characterId);
  const item = projectedItems.find((entry) => entry.id === itemInstanceId);
  if (!item) {
    return { success: false, message: "物品不存在" };
  }
  const itemDef = getStaticItemDef(item.item_def_id);
  if (!itemDef) {
    return { success: false, message: "物品不存在" };
  }
  const currentLocationText = String(item.location);
  if (currentLocationText !== "bag" && currentLocationText !== "warehouse") {
    return { success: false, message: "当前位置不支持移动" };
  }
  const currentLocation = currentLocationText as SlottedInventoryLocation;
  const currentSlotRaw = item.location_slot;
  if (currentSlotRaw === null) {
    return { success: false, message: "物品格子状态异常" };
  }
  const currentSlot = Number(currentSlotRaw);
  if (!Number.isInteger(currentSlot) || currentSlot < 0) {
    return { success: false, message: "物品格子状态异常" };
  }
  const stackMax = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
  const originalQty = Math.max(0, Number(item.qty) || 0);
  if (originalQty <= 0) {
    return { success: false, message: "物品数量异常" };
  }
  const normalizedBindType = normalizeItemBindType(item.bind_type);
  const sourceCanAutoStack =
    stackMax > 1 &&
    isPlainStackingState({
      metadataText: toMetadataText(item.metadata),
      quality: item.quality,
      qualityRank: item.quality_rank,
    });

  let remainingQty = originalQty;
  const pendingMutations: BufferedCharacterItemInstanceMutation[] = [];
  if (currentLocation !== targetLocation && sourceCanAutoStack) {
    const stackRows = sortProjectedStackCandidates(
      projectedItems.filter((entry) => {
        if (entry.id === itemInstanceId) return false;
        if (entry.location !== targetLocation) return false;
        if (entry.item_def_id !== item.item_def_id) return false;
        if (normalizeItemBindType(entry.bind_type) !== normalizedBindType) return false;
        return isPlainStackingState({
          metadataText: toMetadataText(entry.metadata),
          quality: entry.quality,
          qualityRank: entry.quality_rank,
        }) && entry.qty < stackMax;
      }),
    );
    for (const row of stackRows) {
      if (remainingQty <= 0) break;
      const stackQty = Math.max(0, Number(row.qty) || 0);
      const canAdd = Math.min(remainingQty, Math.max(0, stackMax - stackQty));
      if (canAdd <= 0) continue;

      pendingMutations.push(buildUpsertItemMutation(
        "move-item",
        characterId,
        {
          ...row,
          qty: row.qty + canAdd,
          bind_type: normalizedBindType,
          metadata: null,
          quality: null,
          quality_rank: null,
        },
        pendingMutations.length,
      ));
      remainingQty -= canAdd;
    }

    if (remainingQty <= 0) {
      pendingMutations.push(buildDeleteItemMutation(
        "move-item",
        characterId,
        itemInstanceId,
        pendingMutations.length,
      ));
      await bufferCharacterItemInstanceMutations(pendingMutations);
      return { success: true, message: "移动成功" };
    }
  }

  const info = await getInventoryInfo(characterId);
  const capacity = getSlottedCapacity(info, targetLocation);
  if (targetSlot !== undefined) {
    if (
      !Number.isInteger(targetSlot) ||
      targetSlot < 0 ||
      targetSlot >= capacity
    ) {
      return { success: false, message: "目标格子超出容量" };
    }
  }

  let finalSlot: number | null | undefined = targetSlot;
  const localProjectedItems = applyBufferedMutationsToProjectedItems(projectedItems, pendingMutations);
  const shouldAutoResolveTargetSlot = finalSlot === undefined;
  if (finalSlot === undefined) {
    finalSlot = findFirstEmptyProjectedSlot(localProjectedItems, targetLocation, capacity);
    if (finalSlot === null) {
      return { success: false, message: "目标位置已满" };
    }
  } else {
    const slotOccupant = localProjectedItems.find((entry) => (
      entry.id !== itemInstanceId
      && entry.location === targetLocation
      && entry.location_slot === finalSlot
    ));
    if (slotOccupant) {
      pendingMutations.push(buildUpsertItemMutation(
        "move-item",
        characterId,
        {
          ...slotOccupant,
          location: currentLocation,
          location_slot: currentSlot,
        },
        pendingMutations.length,
      ));
    }
  }

  if (finalSlot === undefined || finalSlot === null) {
    return { success: false, message: "目标格子状态异常" };
  }

  pendingMutations.push(buildUpsertItemMutation(
    "move-item",
    characterId,
    {
      ...item,
      qty: remainingQty,
      location: targetLocation,
      location_slot: shouldAutoResolveTargetSlot ? null : finalSlot,
      bind_type: normalizedBindType,
      metadata: sourceCanAutoStack ? null : item.metadata,
      quality: sourceCanAutoStack ? null : item.quality,
      quality_rank: sourceCanAutoStack ? null : item.quality_rank,
    },
    pendingMutations.length,
    shouldAutoResolveTargetSlot ? { mode: 'auto' } : undefined,
  ));
  await bufferCharacterItemInstanceMutations(pendingMutations);
  return { success: true, message: "移动成功" };
};

// ============================================
// 批量丢弃物品
// ============================================

export const removeItemsBatch = async (
  characterId: number,
  itemInstanceIds: number[],
): Promise<{
  success: boolean;
  message: string;
  removedCount?: number;
  removedQtyTotal?: number;
  skippedLockedCount?: number;
  skippedLockedQtyTotal?: number;
}> => {
  if (!Array.isArray(itemInstanceIds) || itemInstanceIds.length === 0) {
    return { success: false, message: "itemIds参数错误" };
  }

  const uniqueIds = [
    ...new Set(
      itemInstanceIds
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  if (uniqueIds.length === 0) {
    return { success: false, message: "itemIds参数错误" };
  }
  if (uniqueIds.length > 200) {
    return { success: false, message: "一次最多丢弃200个物品" };
  }
  
  await lockCharacterInventoryMutex(characterId);

  const projectedItems = await loadProjectedCharacterItemInstances(characterId);
  const targetRows = uniqueIds
    .map((itemId) => projectedItems.find((item) => item.id === itemId) ?? null)
    .filter((row): row is CharacterItemInstanceSnapshot => row !== null);

  if (targetRows.length !== uniqueIds.length) {
    return { success: false, message: "包含不存在的物品" };
  }

  const staticDefMap = getItemDefinitionsByIds(
    targetRows.map((row) => String(row.item_def_id || "").trim()),
  );

  const removableIds: number[] = [];
  let skippedLockedCount = 0;
  let skippedLockedQtyTotal = 0;
  let removedQtyTotal = 0;
  for (const row of targetRows) {
    const itemDef = staticDefMap.get(String(row.item_def_id || "").trim());
    if (!itemDef) {
      return { success: false, message: "包含不存在的物品" };
    }
    if (row.location === "equipped") {
      return { success: false, message: "包含穿戴中的物品" };
    }
    if (row.location !== "bag" && row.location !== "warehouse") {
      return { success: false, message: "包含不可丢弃位置的物品" };
    }
    if (itemDef.destroyable !== true) {
      return { success: false, message: "包含不可丢弃的物品" };
    }
    const rowId = Number(row.id);
    if (!Number.isInteger(rowId) || rowId <= 0) {
      return { success: false, message: "itemIds参数错误" };
    }

    const rowQty = Math.max(0, Number(row.qty) || 0);
    if (row.locked) {
      skippedLockedCount += 1;
      skippedLockedQtyTotal += rowQty;
      continue;
    }

    removedQtyTotal += rowQty;
    removableIds.push(rowId);
  }

  if (removableIds.length === 0) {
    return { success: false, message: "没有可丢弃的物品" };
  }

  await bufferCharacterItemInstanceMutations(
    removableIds.map((itemId, index) => buildDeleteItemMutation(
      "remove-items-batch",
      characterId,
      itemId,
      index,
    )),
  );
  const msg =
    skippedLockedCount > 0
      ? `丢弃成功（已跳过已锁定×${skippedLockedCount}）`
      : "丢弃成功";
  return {
    success: true,
    message: msg,
    removedCount: removableIds.length,
    removedQtyTotal,
    skippedLockedCount,
    skippedLockedQtyTotal,
  };
};

// ============================================
// 扩容背包
// ============================================

export const expandInventory = async (
  characterId: number,
  location: SlottedInventoryLocation,
  expandSize: number = 10,
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  await lockCharacterInventoryMutex(characterId);

  const validExpandSize = Number.isInteger(expandSize)
    ? expandSize
    : Math.floor(Number(expandSize));
  if (!Number.isInteger(validExpandSize) || validExpandSize <= 0) {
    return { success: false, message: "expandSize参数错误" };
  }

  const column = location === "bag" ? "bag_capacity" : "warehouse_capacity";
  const countColumn =
    location === "bag" ? "bag_expand_count" : "warehouse_expand_count";

  const infoResult = await query(
    `
      SELECT bag_capacity, warehouse_capacity
      FROM inventory
      WHERE character_id = $1
      FOR UPDATE
    `,
    [characterId],
  );

  if (infoResult.rows.length === 0) {
    return { success: false, message: "背包不存在" };
  }

  const currentBagCapacity = Number(infoResult.rows[0]?.bag_capacity) || 0;
  const currentWarehouseCapacity =
    Number(infoResult.rows[0]?.warehouse_capacity) || 0;
  const currentCapacity =
    location === "bag" ? currentBagCapacity : currentWarehouseCapacity;
  const nextCapacity = currentCapacity + validExpandSize;

  if (location === "bag") {
    if (currentCapacity >= BAG_CAPACITY_MAX) {
      return {
        success: false,
        message: `背包容量已达上限（${BAG_CAPACITY_MAX}格）`,
      };
    }
    if (nextCapacity > BAG_CAPACITY_MAX) {
      return {
        success: false,
        message: `扩容后超过上限（${BAG_CAPACITY_MAX}格）`,
      };
    }
  }

  const result = await query(
    `
      UPDATE inventory
      SET ${column} = ${column} + $1,
          ${countColumn} = ${countColumn} + 1,
          updated_at = NOW()
      WHERE character_id = $2
      RETURNING ${column} as new_capacity
    `,
    [validExpandSize, characterId],
  );

  if (result.rows.length === 0) {
    return { success: false, message: "背包不存在" };
  }

  return {
    success: true,
    message: "扩容成功",
    newCapacity: Number(result.rows[0].new_capacity) || nextCapacity,
  };
};

// ============================================
// 整理背包（重新排列物品）
// ============================================

type SortInventoryRow = {
  id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  bind_type: string;
  metadata_text: string | null;
  location_slot: number | null;
};

type SortInventoryCompactedRow = SortInventoryRow & {
  category: string | null;
  subCategory: string | null;
  resolvedQualityRank: number;
};

type SortInventoryRowUpdate = {
  itemId: number;
  nextQty: number;
  nextBindType: string;
  clearPlainFields: boolean;
};

/**
 * 整理阶段普通堆叠实例归并器
 *
 * 作用：
 * 1. 做什么：在一键整理前，先把“普通可堆叠实例”按统一口径合并，减少同类物品占格。
 * 2. 做什么：把“哪些实例允许自动堆叠”的判定集中到这里，避免整理逻辑里到处散落同样条件。
 * 3. 不做什么：不负责数据库写入、不负责槽位排序，也不改变带 metadata/品质信息的特殊实例。
 *
 * 输入/输出：
 * - 输入：当前背包/仓库内已锁定的实例列表，以及每个 `item_def_id` 对应的 `stack_max`。
 * - 输出：归并后的实例列表、需要更新数量的实例计划、以及需要删除的空实例 ID。
 *
 * 数据流：
 * - sortInventory 先查出当前位置全部实例；
 * - 本函数只在内存里按 `item_def_id + bind_type` 合并普通堆叠实例；
 * - sortInventory 再统一执行数量更新、删除空实例、最后重排槽位。
 *
 * 关键边界条件与坑点：
 * 1. 仅 `metadata/quality/quality_rank` 都为空的普通实例允许自动堆叠，和统一入包口径保持一致，避免特殊实例被误合并。
 * 2. 整理阶段会同步把保留下来的 `bind_type` 规范回标准值，避免历史脏值导致玩家视角相同的未绑定物品继续分裂成多组。
 */
const compactRowsForSortStacking = (
  rows: SortInventoryRow[],
  stackMaxByItemDefId: Map<string, number>,
): {
  compactedRows: SortInventoryRow[];
  rowUpdates: SortInventoryRowUpdate[];
  deleteIds: number[];
} => {
  const compactedRows: SortInventoryRow[] = [];
  const deleteIds: number[] = [];
  const stackableGroups = new Map<string, SortInventoryRow[]>();
  const sourceRowById = new Map<number, SortInventoryRow>();

  for (const row of rows) {
    sourceRowById.set(Number(row.id), row);
    const stackMax = stackMaxByItemDefId.get(String(row.item_def_id || "").trim()) ?? 1;
    const normalizedBindType = normalizeItemBindType(row.bind_type);
    const sourceIsPlainStacking = isPlainStackingState({
      metadataText: row.metadata_text,
      quality: row.quality,
      qualityRank: row.quality_rank,
    });
    const normalizedRow =
      normalizedBindType === row.bind_type &&
      (!sourceIsPlainStacking ||
        (row.metadata_text === null &&
          row.quality === null &&
          row.quality_rank === null))
        ? row
        : {
            ...row,
            bind_type: normalizedBindType,
            metadata_text: sourceIsPlainStacking ? null : row.metadata_text,
            quality: sourceIsPlainStacking ? null : row.quality,
            quality_rank: sourceIsPlainStacking ? null : row.quality_rank,
          };
    const canAutoStack =
      stackMax > 1 &&
      isPlainStackingState({
        metadataText: normalizedRow.metadata_text,
        quality: normalizedRow.quality,
        qualityRank: normalizedRow.quality_rank,
      });
    if (!canAutoStack) {
      compactedRows.push(normalizedRow);
      continue;
    }

    const groupKey = `${String(normalizedRow.item_def_id || "").trim()}::${normalizedBindType}`;
    const group = stackableGroups.get(groupKey);
    if (group) {
      group.push(normalizedRow);
      continue;
    }
    stackableGroups.set(groupKey, [normalizedRow]);
  }

  for (const groupRows of stackableGroups.values()) {
    const anchorRow = groupRows[0];
    const stackMax = stackMaxByItemDefId.get(String(anchorRow.item_def_id || "").trim()) ?? 1;
    const sortedGroupRows = [...groupRows].sort((left, right) => {
      const qtyCompare = (Number(right.qty) || 0) - (Number(left.qty) || 0);
      if (qtyCompare !== 0) return qtyCompare;
      return Number(left.id) - Number(right.id);
    });

    let remainingQty = sortedGroupRows.reduce(
      (sum, row) => sum + Math.max(0, Number(row.qty) || 0),
      0,
    );

    for (const row of sortedGroupRows) {
      if (remainingQty <= 0) {
        deleteIds.push(Number(row.id));
        continue;
      }

      const nextQty = Math.min(stackMax, remainingQty);
      remainingQty -= nextQty;
      compactedRows.push({
        ...row,
        qty: nextQty,
      });
    }
  }

  const rowUpdates: SortInventoryRowUpdate[] = [];
  for (const row of compactedRows) {
    const sourceRow = sourceRowById.get(Number(row.id));
    if (!sourceRow) {
      continue;
    }
    if (
      row.qty === sourceRow.qty &&
      row.bind_type === sourceRow.bind_type &&
      row.quality === sourceRow.quality &&
      row.quality_rank === sourceRow.quality_rank &&
      row.metadata_text === sourceRow.metadata_text
    ) {
      continue;
    }
    rowUpdates.push({
      itemId: Number(row.id),
      nextQty: row.qty,
      nextBindType: row.bind_type,
      clearPlainFields: isPlainStackingState({
        metadataText: sourceRow.metadata_text,
        quality: sourceRow.quality,
        qualityRank: sourceRow.quality_rank,
      }),
    });
  }

  return {
    compactedRows,
    rowUpdates,
    deleteIds,
  };
};

export const sortInventory = async (
  characterId: number,
  location: SlottedInventoryLocation = "bag",
): Promise<{ success: boolean; message: string }> => {
  await lockCharacterInventoryMutex(characterId);

  const info = await getInventoryInfo(characterId);
  const capacity = getSlottedCapacity(info, location);
  const rows = (await loadProjectedCharacterItemInstancesByLocation(characterId, location)).map((row) => ({
    id: row.id,
    item_def_id: row.item_def_id,
    qty: row.qty,
    quality: row.quality,
    quality_rank: row.quality_rank,
    bind_type: row.bind_type,
    metadata_text: toMetadataText(row.metadata),
    location_slot: row.location_slot,
  })) as SortInventoryRow[];
  const defMap = getItemDefinitionsByIds(
    rows.map((row) => String(row.item_def_id || "").trim()),
  );
  const stackMaxByItemDefId = new Map<string, number>();
  for (const row of rows) {
    const itemDefId = String(row.item_def_id || "").trim();
    if (stackMaxByItemDefId.has(itemDefId)) {
      continue;
    }
    const itemDef = defMap.get(itemDefId);
    stackMaxByItemDefId.set(
      itemDefId,
      Math.max(1, Math.floor(Number(itemDef?.stack_max) || 1)),
    );
  }
  const { compactedRows, rowUpdates, deleteIds } = compactRowsForSortStacking(
    rows,
    stackMaxByItemDefId,
  );

  const projectedItems = await loadProjectedCharacterItemInstances(characterId);

  let minExistingSlot = 0;
  for (const row of compactedRows) {
    const slot = Number(row.location_slot);
    if (Number.isInteger(slot) && slot < minExistingSlot) {
      minExistingSlot = slot;
    }
  }
  const tempSlotStart = minExistingSlot - compactedRows.length - 1;

  const sortableRows: SortInventoryCompactedRow[] = compactedRows.map((row) => {
    const itemDef = defMap.get(String(row.item_def_id || "").trim()) ?? null;
    const category = itemDef?.category ? String(itemDef.category) : null;
    const subCategory = itemDef?.sub_category
      ? String(itemDef.sub_category)
      : null;
    const resolvedQualityRank =
      Number(row.quality_rank) ||
      resolveQualityRankFromName(itemDef?.quality, 0);
    return { ...row, category, subCategory, resolvedQualityRank };
  });

  sortableRows.sort((left, right) => {
    const leftCategory = left.category;
    const rightCategory = right.category;
    if (leftCategory === null && rightCategory !== null) return 1;
    if (leftCategory !== null && rightCategory === null) return -1;
    if (leftCategory !== rightCategory)
      return String(leftCategory).localeCompare(String(rightCategory));

    if (left.resolvedQualityRank !== right.resolvedQualityRank) {
      return right.resolvedQualityRank - left.resolvedQualityRank;
    }

    const leftSubCategory = left.subCategory;
    const rightSubCategory = right.subCategory;
    if (leftSubCategory === null && rightSubCategory !== null) return 1;
    if (leftSubCategory !== null && rightSubCategory === null) return -1;
    if (leftSubCategory !== rightSubCategory) {
      return String(leftSubCategory).localeCompare(String(rightSubCategory));
    }

    const itemDefCompare = String(left.item_def_id).localeCompare(
      String(right.item_def_id),
    );
    if (itemDefCompare !== 0) return itemDefCompare;

    const qtyCompare = (Number(right.qty) || 0) - (Number(left.qty) || 0);
    if (qtyCompare !== 0) return qtyCompare;

    return Number(left.id) - Number(right.id);
  });

  const mutationByItemId = new Map<number, BufferedCharacterItemInstanceMutation>();
  for (const { itemId, nextQty, nextBindType, clearPlainFields } of rowUpdates) {
    const source = projectedItems.find((item) => item.id === itemId);
    if (!source) continue;
    mutationByItemId.set(itemId, buildUpsertItemMutation(
      "sort-inventory",
      characterId,
      {
        ...source,
        qty: nextQty,
        bind_type: nextBindType,
        metadata: clearPlainFields ? null : source.metadata,
        quality: clearPlainFields ? null : source.quality,
        quality_rank: clearPlainFields ? null : source.quality_rank,
      },
      mutationByItemId.size,
    ));
  }
  for (const deleteId of deleteIds) {
    mutationByItemId.set(deleteId, buildDeleteItemMutation(
      "sort-inventory",
      characterId,
      deleteId,
      mutationByItemId.size,
    ));
  }
  for (let index = 0; index < sortableRows.length; index += 1) {
    const row = sortableRows[index];
    const source = projectedItems.find((item) => item.id === row.id);
    if (!source) continue;
    mutationByItemId.set(row.id, buildUpsertItemMutation(
      "sort-inventory",
      characterId,
      {
        ...source,
        qty: row.qty,
        bind_type: row.bind_type,
        metadata: row.metadata_text === null ? null : source.metadata,
        quality: row.quality,
        quality_rank: row.quality_rank,
        location_slot: index < capacity ? index : null,
      },
      mutationByItemId.size,
    ));
  }
  await bufferCharacterItemInstanceMutations([...mutationByItemId.values()]);
  return { success: true, message: "整理完成" };
};
