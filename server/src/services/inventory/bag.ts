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
 * 被引用方：service.ts、equipment.ts（findEmptySlots）、disassemble.ts（addItemToInventory）
 *
 * 边界条件：
 * 1. addItemToInventory 在 INSERT 遇到唯一约束冲突时会重试（最多 6 次），处理并发写入竞争
 * 2. sortInventory 采用两步更新（先写临时负数槽位，再写最终槽位）避免唯一索引瞬时冲突
 */
import { query } from "../../config/database.js";
import {
  getItemDefinitionsByIds,
} from "../staticConfigLoader.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { normalizeItemInstanceObtainedFrom } from "../shared/itemInstanceSource.js";
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
  const sql = `
    SELECT
      i.bag_capacity,
      i.warehouse_capacity,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as bag_used,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'warehouse'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as warehouse_used
    FROM inventory i
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

  const sql = `
    WITH items AS (
      SELECT
        ii.id, ii.item_def_id, ii.qty, ii.location, ii.location_slot,
        ii.quality, ii.quality_rank,
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
    result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
  const items = result.rows.map((row) => {
    const { total_count, ...item } = row;
    return item as InventoryItem;
  });

  return { items, total };
};

// ============================================
// 查找空闲格子
// ============================================

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

  const sql = `
    SELECT location_slot FROM item_instance
    WHERE owner_character_id = $1 AND location = $2 AND location_slot IS NOT NULL
    ORDER BY location_slot
  `;
  const result = await query(sql, [characterId, location]);
  const usedSlots = new Set(result.rows.map((r) => r.location_slot));

  const emptySlots: number[] = [];
  for (let i = 0; i < capacity && emptySlots.length < count; i++) {
    if (!usedSlots.has(i)) {
      emptySlots.push(i);
    }
  }

  return emptySlots;
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
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  const isUniqueViolation = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    return (error as { code?: unknown }).code === "23505";
  };

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

    const info = await getInventoryInfo(characterId);
    const capacity = getSlottedCapacity(info, location);

    const itemIds: number[] = [];
    let remainingQty = qty;

    let stackRows: Array<{ id: number; qty: number }> = [];
    if (stack_max > 1) {
      const stackResult = await query(
        `
          SELECT id, qty FROM item_instance
          WHERE owner_character_id = $1 AND item_def_id = $2
            AND location = $3 AND qty < $4 AND bind_type = $5
          ORDER BY qty DESC
          FOR UPDATE
        `,
        [characterId, itemDefId, location, stack_max, actualBindType],
      );
      stackRows = stackResult.rows.map((r) => ({
        id: Number(r.id),
        qty: Number(r.qty),
      }));
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
      const emptySlots = await findEmptySlots(
        characterId,
        location,
        neededSlots,
      );
      if (emptySlots.length < neededSlots) {
        return { success: false, message: "背包已满" };
      }
    }

    if (stack_max > 1 && stackRows.length > 0) {
      for (const row of stackRows) {
        if (remainingQty <= 0) break;

        const rowQty = Number(row.qty) || 0;
        const canAdd = Math.min(remainingQty, Math.max(0, stack_max - rowQty));
        if (canAdd <= 0) continue;

        await query(
          "UPDATE item_instance SET qty = qty + $1, updated_at = NOW() WHERE id = $2",
          [canAdd, row.id],
        );
        itemIds.push(row.id);
        remainingQty -= canAdd;
      }
    }

    while (remainingQty > 0) {
      const addQty = Math.min(remainingQty, Math.max(1, stack_max));
      let insertedId: number | null = null;
      let attempt = 0;

      while (insertedId === null && attempt < 6) {
        attempt += 1;
        const emptySlots = await findEmptySlots(
          characterId,
          location,
          6,
        );
        if (emptySlots.length === 0) {
          return { success: false, message: "背包已满" };
        }

        for (const slot of emptySlots) {
          try {
            const insertResult = await query(
              `
                INSERT INTO item_instance (
                  owner_user_id, owner_character_id, item_def_id, qty,
                  location, location_slot, bind_type, affixes, obtained_from
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
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
              ],
            );
            insertedId = Number(insertResult.rows[0]?.id);
            break;
          } catch (error) {
            if (isUniqueViolation(error)) continue;
            throw error;
          }
        }
      }

      if (insertedId === null || !Number.isFinite(insertedId)) {
        return { success: false, message: "背包已满" };
      }

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

  const result = await query(
    `
    SELECT id, qty, locked FROM item_instance
    WHERE id = $1 AND owner_character_id = $2
    FOR UPDATE
  `,
    [itemInstanceId, characterId],
  );

  if (result.rows.length === 0) {
    return { success: false, message: "物品不存在" };
  }

  const item = result.rows[0];

  if (item.locked) {
    return { success: false, message: "物品已锁定" };
  }

  if (item.qty < qty) {
    return { success: false, message: "数量不足" };
  }

  if (item.qty === qty) {
    await query("DELETE FROM item_instance WHERE id = $1", [
      itemInstanceId,
    ]);
  } else {
    await query(
      "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2",
      [qty, itemInstanceId],
    );
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
  type MoveItemRow = {
    id: number;
    item_def_id: string;
    qty: number;
    location: string;
    location_slot: number | null;
    bind_type: string;
  };
  type StackTargetRow = { id: number; qty: number };

  await lockCharacterInventoryMutex(characterId);

  const itemResult = await query(
    `
    SELECT
      ii.id,
      ii.item_def_id,
      ii.qty,
      ii.location,
      ii.location_slot,
      ii.bind_type
    FROM item_instance ii
    WHERE ii.id = $1 AND ii.owner_character_id = $2
    FOR UPDATE
  `,
    [itemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0) {
    return { success: false, message: "物品不存在" };
  }

  const item = itemResult.rows[0] as MoveItemRow;
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
    const stackResult = await query(
      `
        SELECT id, qty FROM item_instance
        WHERE owner_character_id = $1
          AND location = $2
          AND item_def_id = $3
          AND bind_type = $4
          AND qty < $5
          AND id != $6
        ORDER BY qty DESC, id ASC
        FOR UPDATE
      `,
      [
        characterId,
        targetLocation,
        item.item_def_id,
        item.bind_type,
        stackMax,
        itemInstanceId,
      ],
    );

    const stackRows = stackResult.rows as StackTargetRow[];
    for (const row of stackRows) {
      if (remainingQty <= 0) break;
      const stackQty = Math.max(0, Number(row.qty) || 0);
      const canAdd = Math.min(remainingQty, Math.max(0, stackMax - stackQty));
      if (canAdd <= 0) continue;

      await query(
        `
          UPDATE item_instance
          SET qty = qty + $1, updated_at = NOW()
          WHERE id = $2 AND owner_character_id = $3
        `,
        [canAdd, Number(row.id), characterId],
      );
      remainingQty -= canAdd;
    }

    if (remainingQty <= 0) {
      await query(
        `
          DELETE FROM item_instance
          WHERE id = $1 AND owner_character_id = $2
        `,
        [itemInstanceId, characterId],
      );
      return { success: true, message: "移动成功" };
    }

    if (remainingQty !== originalQty) {
      await query(
        `
          UPDATE item_instance
          SET qty = $1, updated_at = NOW()
          WHERE id = $2 AND owner_character_id = $3
        `,
        [remainingQty, itemInstanceId, characterId],
      );
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
    const emptySlots = await findEmptySlots(
      characterId,
      targetLocation,
      1,
    );
    if (emptySlots.length === 0) {
      return { success: false, message: "目标位置已满" };
    }
    finalSlot = emptySlots[0];
  } else {
    const slotCheck = await query(
      `
      SELECT id FROM item_instance
      WHERE owner_character_id = $1 AND location = $2 AND location_slot = $3 AND id != $4
      FOR UPDATE
    `,
      [characterId, targetLocation, finalSlot, itemInstanceId],
    );

    if (slotCheck.rows.length > 0) {
      const otherItemId = Number(slotCheck.rows[0].id);
      if (!Number.isInteger(otherItemId) || otherItemId <= 0) {
        return { success: false, message: "目标格子状态异常" };
      }

      await query(
        `
          UPDATE item_instance
          SET location_slot = NULL, updated_at = NOW()
          WHERE id = $1 AND owner_character_id = $2
        `,
        [itemInstanceId, characterId],
      );

      await query(
        `
        UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
        WHERE id = $3 AND owner_character_id = $4
      `,
        [currentLocation, currentSlot, otherItemId, characterId],
      );
    }
  }

  await query(
    `
    UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
    WHERE id = $3 AND owner_character_id = $4
  `,
    [targetLocation, finalSlot, itemInstanceId, characterId],
  );
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

  const itemResult = await query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.item_def_id
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.id = ANY($2)
      FOR UPDATE
    `,
    [characterId, uniqueIds],
  );

  if (itemResult.rows.length !== uniqueIds.length) {
    return { success: false, message: "包含不存在的物品" };
  }

  const staticDefMap = getItemDefinitionsByIds(
    itemResult.rows.map((row) =>
      String((row as { item_def_id?: unknown }).item_def_id || "").trim(),
    ),
  );

  const removableIds: number[] = [];
  let skippedLockedCount = 0;
  let skippedLockedQtyTotal = 0;
  let removedQtyTotal = 0;
  for (const row of itemResult.rows as Array<{
    id: number;
    qty: number;
    location: InventoryLocation;
    locked: boolean;
    item_def_id: string;
  }>) {
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

  await query(
    "DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)",
    [characterId, removableIds],
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

export const sortInventory = async (
  characterId: number,
  location: SlottedInventoryLocation = "bag",
): Promise<{ success: boolean; message: string }> => {
  await lockCharacterInventoryMutex(characterId);

  const info = await getInventoryInfo(characterId);
  const capacity = getSlottedCapacity(info, location);
  const itemResult = await query(
    `
      SELECT id, item_def_id, qty, quality_rank
      FROM item_instance
      WHERE owner_character_id = $1 AND location = $2
      FOR UPDATE
    `,
    [characterId, location],
  );

  const rows = itemResult.rows as Array<{
    id: number;
    item_def_id: string;
    qty: number;
    quality_rank: number | null;
  }>;
  const defMap = getItemDefinitionsByIds(
    rows.map((row) => String(row.item_def_id || "").trim()),
  );
  const sortableRows = rows.map((row) => {
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
    const tempSlot = index < capacity ? -1 - index : null;
    await query(
      `
        UPDATE item_instance
        SET location_slot = $1,
            updated_at = NOW()
        WHERE id = $2 AND owner_character_id = $3
      `,
      [tempSlot, row.id, characterId],
    );
  }

  for (let index = 0; index < sortableRows.length; index += 1) {
    const row = sortableRows[index];
    const finalSlot = index < capacity ? index : null;
    await query(
      `
        UPDATE item_instance
        SET location_slot = $1,
            updated_at = NOW()
        WHERE id = $2 AND owner_character_id = $3
      `,
      [finalSlot, row.id, characterId],
    );
  }
  return { success: true, message: "整理完成" };
};
