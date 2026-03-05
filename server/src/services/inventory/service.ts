/**
 * 背包服务类（使用 @Transactional 装饰器）
 *
 * 作用：将各拆分模块的函数式 API 统一包装为类方法。
 *       读操作直接委托，写操作通过 @Transactional 保证事务原子性。
 *
 * 输入/输出：与各模块导出函数签名一致
 *
 * 数据流：
 * - 所有写操作方法使用 @Transactional 保证原子性
 * - 读操作方法直接调用原有函数
 *
 * 边界条件：
 * 1) @Transactional 装饰器自动处理事务开启、提交与回滚
 * 2) 嵌套事务由 withTransaction 的复用语义处理（内层直接使用外层连接）
 */
import { Transactional } from "../../decorators/transactional.js";
import type {
  InventoryInfo,
  InventoryItem,
  InventoryItemWithDef,
  InventoryLocation,
  SlottedInventoryLocation,
} from "./shared/types.js";
import type { GeneratedAffix } from "../equipmentService.js";
import type { SocketedGemEntry } from "../equipmentGrowthRules.js";

import {
  getInventoryInfo,
  getInventoryItems,
  findEmptySlots,
  addItemToInventory,
  removeItemFromInventory,
  setItemLocked,
  moveItem,
  removeItemsBatch,
  expandInventory,
  sortInventory,
} from "./bag.js";
import {
  equipItem,
  unequipItem,
  enhanceEquipment,
  getEquipmentGrowthCostPreview,
  refineEquipment,
  rerollEquipmentAffixes,
  getRerollCostPreview,
} from "./equipment.js";
import { socketEquipment } from "./socket.js";
import {
  disassembleEquipment,
  disassembleEquipmentBatch,
} from "./disassemble.js";
import {
  getInventoryItemsWithDefs,
  getEquippedItemDefIds,
} from "./itemQuery.js";

class InventoryService {
  // ============================================
  // 读操作（无需事务）
  // ============================================

  async getInventoryInfo(characterId: number): Promise<InventoryInfo> {
    return getInventoryInfo(characterId);
  }

  async getInventoryItems(
    characterId: number,
    location: InventoryLocation = "bag",
    page: number = 1,
    pageSize: number = 100,
  ): Promise<{ items: InventoryItem[]; total: number }> {
    return getInventoryItems(characterId, location, page, pageSize);
  }

  async getInventoryItemsWithDefs(
    characterId: number,
    location: InventoryLocation,
    page: number,
    pageSize: number,
  ): Promise<{ items: InventoryItemWithDef[]; total: number }> {
    return getInventoryItemsWithDefs(characterId, location, page, pageSize);
  }

  async getEquippedItemDefIds(characterId: number): Promise<string[]> {
    return getEquippedItemDefIds(characterId);
  }

  async getRerollCostPreview(
    characterId: number,
    itemInstanceId: number,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      rerollScrollItemDefId: string;
      maxLockCount: number;
      costTable: Array<{
        lockCount: number;
        rerollScrollQty: number;
        silverCost: number;
        spiritStoneCost: number;
      }>;
    };
  }> {
    return getRerollCostPreview(characterId, itemInstanceId);
  }

  async getEquipmentGrowthCostPreview(
    characterId: number,
    itemInstanceId: number,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      enhance: {
        currentLevel: number;
        targetLevel: number;
        maxLevel: number;
        successRate: number;
        downgradeOnFail: boolean;
        costs: {
          materialItemDefId: string;
          materialQty: number;
          silverCost: number;
          spiritStoneCost: number;
        } | null;
      };
      refine: {
        currentLevel: number;
        targetLevel: number;
        maxLevel: number;
        successRate: number;
        downgradeOnFail: boolean;
        costs: {
          materialItemDefId: string;
          materialQty: number;
          silverCost: number;
          spiritStoneCost: number;
        } | null;
      };
    };
  }> {
    return getEquipmentGrowthCostPreview(characterId, itemInstanceId);
  }

  async findEmptySlots(
    characterId: number,
    location: SlottedInventoryLocation,
    count: number = 1,
  ): Promise<number[]> {
    return findEmptySlots(characterId, location, count);
  }

  // ============================================
  // 写操作（使用 @Transactional）
  // ============================================

  @Transactional
  async addItemToInventory(
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
    } = {},
  ): Promise<{ success: boolean; message: string; itemIds?: number[] }> {
    return await addItemToInventory(
      characterId,
      userId,
      itemDefId,
      qty,
      options,
    );
  }

  @Transactional
  async removeItemFromInventory(
    characterId: number,
    itemInstanceId: number,
    qty: number = 1,
  ): Promise<{ success: boolean; message: string }> {
    return await removeItemFromInventory(characterId, itemInstanceId, qty);
  }

  @Transactional
  async setItemLocked(
    characterId: number,
    itemInstanceId: number,
    locked: boolean,
  ): Promise<{
    success: boolean;
    message: string;
    data?: { itemId: number; locked: boolean };
  }> {
    return await setItemLocked(characterId, itemInstanceId, locked);
  }

  @Transactional
  async moveItem(
    characterId: number,
    itemInstanceId: number,
    targetLocation: SlottedInventoryLocation,
    targetSlot?: number,
  ): Promise<{ success: boolean; message: string }> {
    return await moveItem(characterId, itemInstanceId, targetLocation, targetSlot);
  }

  @Transactional
  async equipItem(
    characterId: number,
    userId: number,
    itemInstanceId: number,
  ): Promise<{ success: boolean; message: string }> {
    return await equipItem(characterId, userId, itemInstanceId);
  }

  @Transactional
  async unequipItem(
    characterId: number,
    itemInstanceId: number,
    options: { targetLocation?: SlottedInventoryLocation } = {},
  ): Promise<{
    success: boolean;
    message: string;
    movedTo?: { location: SlottedInventoryLocation; slot: number };
  }> {
    return await unequipItem(characterId, itemInstanceId, options);
  }

  @Transactional
  async enhanceEquipment(
    characterId: number,
    userId: number,
    itemInstanceId: number,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      strengthenLevel: number;
      targetLevel?: number;
      successRate?: number;
      roll?: number;
      usedMaterial?: { itemDefId: string; qty: number };
      costs?: { silver: number; spiritStones: number };
      character?: unknown;
    };
  }> {
    return await enhanceEquipment(characterId, userId, itemInstanceId);
  }

  @Transactional
  async refineEquipment(
    characterId: number,
    userId: number,
    itemInstanceId: number,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      refineLevel: number;
      targetLevel?: number;
      successRate?: number;
      roll?: number;
      usedMaterial?: { itemDefId: string; qty: number };
      costs?: { silver: number; spiritStones: number };
      character?: unknown;
    };
  }> {
    return await refineEquipment(characterId, userId, itemInstanceId);
  }

  @Transactional
  async rerollEquipmentAffixes(
    characterId: number,
    userId: number,
    itemInstanceId: number,
    lockIndexes: number[] = [],
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      affixes: GeneratedAffix[];
      lockIndexes: number[];
      costs: {
        silver: number;
        spiritStones: number;
        rerollScroll: { itemDefId: string; qty: number };
      };
      character?: unknown;
    };
  }> {
    return await rerollEquipmentAffixes(characterId, userId, itemInstanceId, lockIndexes);
  }

  @Transactional
  async socketEquipment(
    characterId: number,
    userId: number,
    equipmentInstanceId: number,
    gemInstanceId: number,
    options: { slot?: number } = {},
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      socketedGems: SocketedGemEntry[];
      socketMax: number;
      slot: number;
      gem: {
        itemDefId: string;
        name: string;
        icon: string | null;
        gemType: string;
      };
      replacedGem?: SocketedGemEntry;
      costs?: { silver: number };
      character?: unknown;
    };
  }> {
    return await socketEquipment(
      characterId,
      userId,
      equipmentInstanceId,
      gemInstanceId,
      options,
    );
  }

  @Transactional
  async disassembleEquipment(
    characterId: number,
    userId: number,
    itemInstanceId: number,
    qty: number,
  ): Promise<{
    success: boolean;
    message: string;
    rewards?: any;
  }> {
    return await disassembleEquipment(characterId, userId, itemInstanceId, qty);
  }

  @Transactional
  async disassembleEquipmentBatch(
    characterId: number,
    userId: number,
    items: Array<{ itemId: number; qty: number }>,
  ): Promise<{
    success: boolean;
    message: string;
    disassembledCount?: number;
    disassembledQtyTotal?: number;
    skippedLockedCount?: number;
    skippedLockedQtyTotal?: number;
    rewards?: any;
  }> {
    return await disassembleEquipmentBatch(characterId, userId, items);
  }

  @Transactional
  async removeItemsBatch(
    characterId: number,
    itemInstanceIds: number[],
  ): Promise<{
    success: boolean;
    message: string;
    removedCount?: number;
    removedQtyTotal?: number;
    skippedLockedCount?: number;
    skippedLockedQtyTotal?: number;
  }> {
    return await removeItemsBatch(characterId, itemInstanceIds);
  }

  @Transactional
  async expandInventory(
    characterId: number,
    location: SlottedInventoryLocation,
    expandSize: number = 10,
  ): Promise<{ success: boolean; message: string; newCapacity?: number }> {
    return await expandInventory(characterId, location, expandSize);
  }

  @Transactional
  async sortInventory(
    characterId: number,
    location: SlottedInventoryLocation = "bag",
  ): Promise<{ success: boolean; message: string }> {
    return await sortInventory(characterId, location);
  }
}

// 单例导出
export const inventoryService = new InventoryService();
