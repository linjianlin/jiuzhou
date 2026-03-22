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
 * - 容量信息仍读取 inventory 表
 * - 物品实时状态统一从 Redis 主状态仓库读取
 * - 写操作优先修改 Redis 主状态，再由 flush 服务同步 item_instance 镜像
 *
 * 被引用方：service.ts、equipment.ts（findEmptySlots）、disassemble.ts（addItemToInventory）、
 *           marketService.ts / mailService.ts（moveItemInstanceToBagWithStacking）
 *
 * 边界条件：
 * 1. addItemToInventory 在 INSERT 遇到唯一约束冲突时会重试（最多 6 次），处理并发写入竞争
 * 2. sortInventory 直接重排 Redis 槽位；数据库镜像由后续 flush 统一落盘
 */
import { query } from "../../config/database.js";
import {
  getItemDefinitionsByIds,
} from "../staticConfigLoader.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { normalizeItemInstanceObtainedFrom } from "../shared/itemInstanceSource.js";
import { tryInsertItemInstanceWithSlot } from "../shared/itemInstanceSlotInsert.js";
import {
  queueInventoryItemWritebackSnapshot,
} from "../playerWritebackCacheService.js";
import {
  deletePlayerInventoryState,
  loadPlayerCharacterStateByCharacterId,
  loadPlayerInventoryStateByItemId,
  loadPlayerInventoryStatesByCharacterId,
  patchPlayerInventoryState,
  upsertPlayerInventoryState,
} from "../playerStateRepository.js";
import type {
  InventoryInfo,
  InventoryItem,
  InventoryLocation,
  SlottedInventoryLocation,
} from "./shared/types.js";
import type { PlayerInventoryItemState, PlayerStateJsonValue } from "../playerStateTypes.js";
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
import { syncDirtyInventoryMirrorOnSlotConflict } from "./shared/inventoryMirrorSync.js";

const countUsedSlots = (
  inventoryStates: PlayerInventoryItemState[],
  location: SlottedInventoryLocation,
): number => {
  const usedSlots = new Set<number>();
  for (const item of inventoryStates) {
    if (item.location !== location) continue;
    if (item.location_slot === null || item.location_slot < 0) continue;
    usedSlots.add(item.location_slot);
  }
  return usedSlots.size;
};

const toInventoryItem = (
  state: PlayerInventoryItemState,
): InventoryItem => {
  return {
    id: state.id,
    item_def_id: state.item_def_id,
    qty: state.qty,
    quality: state.quality,
    quality_rank: state.quality_rank,
    metadata: state.metadata,
    location: state.location as InventoryLocation,
    location_slot: state.location_slot,
    equipped_slot: state.equipped_slot,
    strengthen_level: state.strengthen_level ?? 0,
    refine_level: state.refine_level ?? 0,
    socketed_gems: state.socketed_gems,
    affixes: state.affixes,
    identified: state.identified ?? false,
    locked: state.locked,
    bind_type: state.bind_type ?? "none",
    created_at: state.created_at ? new Date(state.created_at) : new Date(0),
  };
};

const compareInventoryItemsForList = (
  left: PlayerInventoryItemState,
  right: PlayerInventoryItemState,
): number => {
  const leftSlot = left.location_slot;
  const rightSlot = right.location_slot;
  if (leftSlot === null && rightSlot !== null) return 1;
  if (leftSlot !== null && rightSlot === null) return -1;
  if (leftSlot !== null && rightSlot !== null && leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }

  const leftCreatedAt = left.created_at ? new Date(left.created_at).getTime() : 0;
  const rightCreatedAt = right.created_at ? new Date(right.created_at).getTime() : 0;
  if (leftCreatedAt !== rightCreatedAt) {
    return rightCreatedAt - leftCreatedAt;
  }

  return right.id - left.id;
};

// ============================================
// 获取背包信息（容量与使用情况）
// ============================================

/**
 * 查询角色背包/仓库容量与已使用格数
 * 若背包记录不存在则自动初始化
 */
export const getInventoryInfo = async (
  characterId: number,
): Promise<InventoryInfo> => {
  const result = await query(
    `
      SELECT
        i.bag_capacity,
        i.warehouse_capacity
      FROM inventory i
      WHERE i.character_id = $1
    `,
    [characterId],
  );

  if (result.rows.length === 0) {
    await query(
      "INSERT INTO inventory (character_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [characterId],
    );
    return createDefaultInventoryInfo();
  }

  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  const row = result.rows[0] as Pick<InventoryInfo, "bag_capacity" | "warehouse_capacity">;
  return {
    bag_capacity: Number(row.bag_capacity) || 0,
    warehouse_capacity: Number(row.warehouse_capacity) || 0,
    bag_used: countUsedSlots(inventoryStates, "bag"),
    warehouse_used: countUsedSlots(inventoryStates, "warehouse"),
  };
};

// ============================================
// 获取背包物品列表（分页优化）
// ============================================

export const getInventoryItems = async (
  characterId: number,
  location: InventoryLocation = "bag",
  page: number = 1,
  pageSize: number = 100,
): Promise<{ items: InventoryItem[]; total: number }> => {
  await getInventoryInfo(characterId);
  const offset = (page - 1) * pageSize;
  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  const filteredStates = inventoryStates
    .filter((state) => state.location === location)
    .sort(compareInventoryItemsForList);
  const total = filteredStates.length;
  const items = filteredStates
    .slice(offset, offset + pageSize)
    .map((state) => toInventoryItem(state));

  return { items, total };
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
 * - 本函数直接读取 Redis inventory 主状态；
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

  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  const usedSlots = new Set<number>();
  for (const item of inventoryStates) {
    if (item.location !== location) {
      continue;
    }
    if (item.location_slot === null || item.location_slot < 0) {
      continue;
    }
    usedSlots.add(item.location_slot);
  }

  const emptySlots: number[] = [];
  for (let slot = 0; slot < capacity && emptySlots.length < count; slot += 1) {
    if (!usedSlots.has(slot)) {
      emptySlots.push(slot);
    }
  }

  return emptySlots;
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

const isEmptyInventoryMetadata = (
  metadata: PlayerInventoryItemState["metadata"],
): boolean => {
  if (metadata === null) {
    return true;
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return Object.keys(metadata).length === 0;
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
    affixes?: PlayerStateJsonValue;
    obtainedFrom?: string;
    metadata?: PlayerStateJsonValue;
    quality?: string | null;
    qualityRank?: number | null;
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "数量参数错误" };
  }

  return runInventoryMutation(async () => {
    await lockCharacterInventoryMutex(characterId);

    const location = options.location || "bag";
    const bindType = options.bindType || "none";

    const itemDef = getStaticItemDef(itemDefId);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }

    const stack_max = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
    const def_bind_type = String(itemDef.bind_type || "none");
    const actualBindType = bindType !== "none" ? bindType : def_bind_type;
    const obtainedFrom = normalizeItemInstanceObtainedFrom(
      options.obtainedFrom,
    ).value;
    const metadataJson =
      options.metadata !== undefined && options.metadata !== null
        ? JSON.stringify(options.metadata)
        : null;
    const quality = typeof options.quality === "string" && options.quality.trim().length > 0
      ? options.quality.trim()
      : null;
    const qualityRank =
      options.qualityRank !== undefined && options.qualityRank !== null
        ? Math.max(1, Math.floor(Number(options.qualityRank) || 1))
        : null;
    const canStackByOption = !metadataJson && !quality && qualityRank === null;

    const info = await getInventoryInfo(characterId);
    const capacity = getSlottedCapacity(info, location);
    const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);

    const itemIds: number[] = [];
    let remainingQty = qty;

    let stackRows: Array<{ id: number; qty: number }> = [];
    if (stack_max > 1 && canStackByOption) {
      stackRows = inventoryStates
        .filter((item) =>
          item.location === location &&
          item.item_def_id === itemDefId &&
          item.qty < stack_max &&
          item.bind_type === actualBindType &&
          isEmptyInventoryMetadata(item.metadata) &&
          item.quality === null &&
          item.quality_rank === null,
        )
        .map((item) => ({
          id: item.id,
          qty: item.qty,
        }))
        .sort((left, right) => {
          if (right.qty !== left.qty) {
            return right.qty - left.qty;
          }
          return left.id - right.id;
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
    if (neededSlots > 0) {
      const emptySlots = await findEmptySlotsByCapacity(
        characterId,
        location,
        capacity,
        neededSlots,
      );
      if (emptySlots.length < neededSlots) {
        return { success: false, message: "背包已满" };
      }
    }

    if (stack_max > 1 && canStackByOption && stackRows.length > 0) {
      for (const row of stackRows) {
        if (remainingQty <= 0) break;

        const rowQty = Number(row.qty) || 0;
        const canAdd = Math.min(remainingQty, Math.max(0, stack_max - rowQty));
        if (canAdd <= 0) continue;

        await patchPlayerInventoryState(characterId, row.id, {
          qty: rowQty + canAdd,
        });
        itemIds.push(row.id);
        remainingQty -= canAdd;
      }
    }

    while (remainingQty > 0) {
      const addQty = Math.min(remainingQty, Math.max(1, stack_max));
      let insertedId: number | null = null;
      let insertedSlot: number | null = null;
      let attempt = 0;
      let mirrorSyncAttempted = false;

      while (insertedId === null && attempt < 6) {
        attempt += 1;
        const emptySlots = await findEmptySlotsByCapacity(
          characterId,
          location,
          capacity,
          6,
        );
        if (emptySlots.length === 0) {
          return { success: false, message: "背包已满" };
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
              options.affixes !== undefined && options.affixes !== null
                ? JSON.stringify(options.affixes)
                : null,
              obtainedFrom,
              metadataJson,
              quality,
              qualityRank,
            ],
          );
          if (inserted !== null) {
            insertedId = inserted;
            insertedSlot = slot;
            break;
          }
        }

        if (insertedId === null && !mirrorSyncAttempted) {
          mirrorSyncAttempted = await syncDirtyInventoryMirrorOnSlotConflict(
            characterId,
          );
        }
      }

      if (insertedId === null || !Number.isFinite(insertedId)) {
        return { success: false, message: "背包已满" };
      }

      await upsertPlayerInventoryState(characterId, {
        id: insertedId,
        owner_user_id: userId,
        owner_character_id: characterId,
        item_def_id: itemDefId,
        qty: addQty,
        locked: false,
        quality,
        quality_rank: qualityRank,
        strengthen_level: null,
        refine_level: null,
        socketed_gems: [],
        affixes:
          options.affixes !== undefined && options.affixes !== null
            ? options.affixes
            : [],
        affix_gen_version: 0,
        affix_roll_meta: {},
        identified: false,
        bind_type: actualBindType,
        bind_owner_user_id: null,
        bind_owner_character_id: null,
        location,
        location_slot: insertedSlot,
        equipped_slot: null,
        random_seed: null,
        custom_name: null,
        expire_at: null,
        obtained_from: obtainedFrom,
        obtained_ref_id: null,
        metadata:
          options.metadata !== undefined && options.metadata !== null
            ? options.metadata
            : {},
        created_at: new Date().toISOString(),
      });
      itemIds.push(insertedId);
      remainingQty -= addQty;
    }

    const usedSlots = location === "bag" ? info.bag_used : info.warehouse_used;
    if (usedSlots > capacity) {
      return { success: false, message: "背包数据异常" };
    }

    return { success: true, message: "添加成功", itemIds };
  });
};

type MoveToBagSourceLocation = "auction" | "mail";

type MoveToBagStackRow = {
  id: number;
  qty: number;
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
 * 1) 先从 Redis 主状态读取来源实例与目标堆叠实例，计算是否需要新格子；
 * 2) 先更新 Redis 物品状态，数据库镜像交给后续 flush；
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
  },
): Promise<{ success: boolean; message: string; itemId?: number }> => {
  const source = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
  if (!source) {
    return { success: false, message: "物品不存在" };
  }
  if (Number(source.owner_character_id) !== characterId) {
    return { success: false, message: "物品归属异常" };
  }
  if (options.expectedOwnerUserId !== undefined) {
    const ownerCharacter = await loadPlayerCharacterStateByCharacterId(characterId);
    if (!ownerCharacter || ownerCharacter.user_id !== options.expectedOwnerUserId) {
      return { success: false, message: "物品归属异常" };
    }
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
  const bindType = String(source.bind_type || "none");

  let stackRows: MoveToBagStackRow[] = [];
  if (stackMax > 1) {
    const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
    stackRows = inventoryStates
      .filter((item) => {
        if (item.id === itemInstanceId) {
          return false;
        }
        if (item.location !== "bag") {
          return false;
        }
        if (String(item.item_def_id || "").trim() !== itemDefId) {
          return false;
        }
        if (String(item.bind_type || "none") !== bindType) {
          return false;
        }
        return Math.max(0, Math.floor(Number(item.qty) || 0)) < stackMax;
      })
      .map((item) => ({
        id: item.id,
        qty: Math.max(0, Math.floor(Number(item.qty) || 0)),
      }))
      .sort((left, right) => {
        if (right.qty !== left.qty) {
          return right.qty - left.qty;
        }
        return left.id - right.id;
      });
  }

  let freeInStacks = 0;
  for (const row of stackRows) {
    freeInStacks += Math.max(0, stackMax - row.qty);
  }
  const needsEmptySlot = Math.max(0, sourceQty - freeInStacks) > 0;
  let targetSlot: number | null = null;
  if (needsEmptySlot) {
    const emptySlots = await findEmptySlots(characterId, "bag", 1);
    if (emptySlots.length < 1) {
      return { success: false, message: "背包已满" };
    }
    targetSlot = emptySlots[0];
  }

  let remainingQty = sourceQty;
  let representativeItemId: number | null = null;
  for (const row of stackRows) {
    if (remainingQty <= 0) break;
    const canAdd = Math.min(remainingQty, Math.max(0, stackMax - row.qty));
    if (canAdd <= 0) continue;

    const nextQty = row.qty + canAdd;
    await patchPlayerInventoryState(characterId, row.id, { qty: nextQty });

    if (representativeItemId === null) {
      representativeItemId = row.id;
    }
    remainingQty -= canAdd;
  }

  if (remainingQty <= 0) {
    await deletePlayerInventoryState(characterId, itemInstanceId);
    if (representativeItemId === null) {
      throw new Error("实例堆叠后缺少承载目标，数据状态异常");
    }
    return { success: true, message: "移动成功", itemId: representativeItemId };
  }

  if (targetSlot === null) {
    throw new Error("实例剩余数量需落格但未分配格子，数据状态异常");
  }

  if (remainingQty !== sourceQty) {
    await patchPlayerInventoryState(characterId, itemInstanceId, { qty: remainingQty });
  }

  await patchPlayerInventoryState(characterId, itemInstanceId, {
    location: "bag",
    location_slot: targetSlot,
    equipped_slot: null,
  });
  return {
    success: true,
    message: "移动成功",
    itemId: itemInstanceId,
  };
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

  const item = await loadPlayerInventoryStateByItemId(
    characterId,
    itemInstanceId,
  );
  if (!item) {
    return { success: false, message: "物品不存在" };
  }

  if (item.locked) {
    return { success: false, message: "物品已锁定" };
  }

  const currentQty = Math.max(0, Number(item.qty) || 0);
  if (currentQty < qty) {
    return { success: false, message: "数量不足" };
  }

  if (currentQty === qty) {
    await queueInventoryItemWritebackSnapshot(characterId, item, null);
  } else {
    await queueInventoryItemWritebackSnapshot(characterId, item, {
      qty: currentQty - qty,
    });
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

  const item = await loadPlayerInventoryStateByItemId(
    characterId,
    itemInstanceId,
  );
  if (!item) {
    return { success: false, message: "物品不存在" };
  }

  const location = String(item.location || "");
  if (location === "auction") {
    return { success: false, message: "该物品当前位置不可锁定" };
  }
  if (!["bag", "warehouse", "equipped"].includes(location)) {
    return { success: false, message: "该物品当前位置不可锁定" };
  }

  await queueInventoryItemWritebackSnapshot(characterId, item, {
    locked,
  });
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
  type StackTargetRow = { id: number; qty: number };

  await lockCharacterInventoryMutex(characterId);
  const item = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
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

  let remainingQty = originalQty;
  if (currentLocation !== targetLocation && stackMax > 1) {
    const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
    const inventoryStateMap = new Map(
      inventoryStates.map((state) => [state.id, state] as const),
    );
    const stackRows: StackTargetRow[] = inventoryStates
      .filter((state) => {
        if (state.id === itemInstanceId) {
          return false;
        }
        if (state.location !== targetLocation) {
          return false;
        }
        if (String(state.item_def_id || "").trim() !== item.item_def_id) {
          return false;
        }
        if (String(state.bind_type || "none") !== String(item.bind_type || "none")) {
          return false;
        }
        return Math.max(0, Number(state.qty) || 0) < stackMax;
      })
      .map((state) => ({
        id: state.id,
        qty: Math.max(0, Number(state.qty) || 0),
      }))
      .sort((left, right) => {
        if (right.qty !== left.qty) {
          return right.qty - left.qty;
        }
        return left.id - right.id;
      });

    for (const row of stackRows) {
      if (remainingQty <= 0) break;
      const stackQty = Math.max(0, Number(row.qty) || 0);
      const canAdd = Math.min(remainingQty, Math.max(0, stackMax - stackQty));
      if (canAdd <= 0) continue;
      const stackTargetState = inventoryStateMap.get(Number(row.id));
      if (!stackTargetState) {
        return { success: false, message: "目标堆叠物品不存在" };
      }

      await queueInventoryItemWritebackSnapshot(characterId, stackTargetState, {
        qty: stackQty + canAdd,
      });
      remainingQty -= canAdd;
    }

    if (remainingQty <= 0) {
      await queueInventoryItemWritebackSnapshot(characterId, item, null);
      return { success: true, message: "移动成功" };
    }

    if (remainingQty !== originalQty) {
      await queueInventoryItemWritebackSnapshot(characterId, item, {
        qty: remainingQty,
      });
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

  let finalSlot = targetSlot;
  if (finalSlot === undefined) {
    const emptySlots = await findEmptySlotsByCapacity(
      characterId,
      targetLocation,
      capacity,
      1,
    );
    if (emptySlots.length === 0) {
      return { success: false, message: "目标位置已满" };
    }
    finalSlot = emptySlots[0];
  } else {
    const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
    const otherItem = inventoryStates.find((state) =>
      state.id !== itemInstanceId &&
      state.location === targetLocation &&
      state.location_slot === finalSlot,
    );

    if (otherItem) {
      const otherItemId = Number(otherItem.id);
      if (!Number.isInteger(otherItemId) || otherItemId <= 0) {
        return { success: false, message: "目标格子状态异常" };
      }

      await queueInventoryItemWritebackSnapshot(characterId, otherItem, {
        location: currentLocation,
        location_slot: currentSlot,
      });
    }
  }

  await queueInventoryItemWritebackSnapshot(characterId, item, {
    qty: remainingQty,
    location: targetLocation,
    location_slot: finalSlot,
  });
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

  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(
    characterId,
  );
  const stateMap = new Map(
    inventoryStates.map((state) => [state.id, state] as const),
  );

  for (const rowId of uniqueIds) {
    if (!stateMap.has(rowId)) {
      return { success: false, message: "包含不存在的物品" };
    }
  }

  const staticDefMap = getItemDefinitionsByIds(
    uniqueIds
      .map((rowId) => String(stateMap.get(rowId)?.item_def_id || "").trim())
      .filter((itemDefId) => itemDefId.length > 0),
  );

  const removableIds: number[] = [];
  let skippedLockedCount = 0;
  let skippedLockedQtyTotal = 0;
  let removedQtyTotal = 0;
  for (const rowId of uniqueIds) {
    const row = stateMap.get(rowId);
    if (!row) {
      return { success: false, message: "包含不存在的物品" };
    }

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

  for (const rowId of removableIds) {
    const row = stateMap.get(rowId);
    if (!row) {
      return { success: false, message: "包含不存在的物品" };
    }
    await queueInventoryItemWritebackSnapshot(characterId, row, null);
  }
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
  metadata: PlayerInventoryItemState["metadata"];
  location_slot: number | null;
};

type SortInventoryCompactedRow = SortInventoryRow & {
  category: string | null;
  subCategory: string | null;
  resolvedQualityRank: number;
};

type SortInventoryQtyUpdate = {
  itemId: number;
  nextQty: number;
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
 * - sortInventory 先从 Redis 主状态读取当前位置全部实例；
 * - 本函数只在内存里按 `item_def_id + bind_type` 合并普通堆叠实例；
 * - sortInventory 再统一回写 Redis 状态，并由 flush 服务把最终镜像刷回数据库。
 *
 * 关键边界条件与坑点：
 * 1. 仅 `metadata/quality/quality_rank` 都为空的普通实例允许自动堆叠，和统一入包口径保持一致，避免特殊实例被误合并。
 * 2. 归并时优先保留数量更大的旧实例，尽量减少写操作与实例 ID 抖动，降低整理后的列表波动。
 */
const compactRowsForSortStacking = (
  rows: SortInventoryRow[],
  stackMaxByItemDefId: Map<string, number>,
): {
  compactedRows: SortInventoryRow[];
  qtyUpdates: SortInventoryQtyUpdate[];
  deleteIds: number[];
} => {
  const compactedRows: SortInventoryRow[] = [];
  const qtyUpdates: SortInventoryQtyUpdate[] = [];
  const deleteIds: number[] = [];
  const stackableGroups = new Map<string, SortInventoryRow[]>();

  for (const row of rows) {
    const stackMax = stackMaxByItemDefId.get(String(row.item_def_id || "").trim()) ?? 1;
    const canAutoStack =
      stackMax > 1 &&
      isEmptyInventoryMetadata(row.metadata) &&
      row.quality === null &&
      row.quality_rank === null;
    if (!canAutoStack) {
      compactedRows.push(row);
      continue;
    }

    const groupKey = `${String(row.item_def_id || "").trim()}::${String(row.bind_type || "none").trim()}`;
    const group = stackableGroups.get(groupKey);
    if (group) {
      group.push(row);
      continue;
    }
    stackableGroups.set(groupKey, [row]);
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
      if (nextQty !== row.qty) {
        qtyUpdates.push({
          itemId: Number(row.id),
          nextQty,
        });
      }
      compactedRows.push({
        ...row,
        qty: nextQty,
      });
    }
  }

  return {
    compactedRows,
    qtyUpdates,
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
  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(
    characterId,
  );
  const stateMap = new Map(
    inventoryStates.map((state) => [state.id, state] as const),
  );
  const rows: SortInventoryRow[] = inventoryStates
    .filter((state) => state.location === location)
    .map((state) => ({
      id: state.id,
      item_def_id: state.item_def_id,
      qty: state.qty,
      quality: state.quality,
      quality_rank: state.quality_rank,
      bind_type: state.bind_type ?? "none",
      metadata: state.metadata,
      location_slot: state.location_slot,
    }));
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
  const { compactedRows, qtyUpdates, deleteIds } = compactRowsForSortStacking(
    rows,
    stackMaxByItemDefId,
  );

  for (const { itemId, nextQty } of qtyUpdates) {
    const itemState = stateMap.get(itemId);
    if (!itemState) {
      return { success: false, message: "整理目标不存在" };
    }
    await queueInventoryItemWritebackSnapshot(characterId, itemState, {
      qty: nextQty,
    });
  }

  for (const deleteId of deleteIds) {
    const itemState = stateMap.get(deleteId);
    if (!itemState) {
      return { success: false, message: "整理目标不存在" };
    }
    await queueInventoryItemWritebackSnapshot(characterId, itemState, null);
  }

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

  for (let index = 0; index < sortableRows.length; index += 1) {
    const row = sortableRows[index];
    const finalSlot = index < capacity ? index : null;
    const itemState = stateMap.get(row.id);
    if (!itemState) {
      return { success: false, message: "整理目标不存在" };
    }
    await queueInventoryItemWritebackSnapshot(characterId, itemState, {
      qty: row.qty,
      location_slot: finalSlot,
    });
  }
  return { success: true, message: "整理完成" };
};
