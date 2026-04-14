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
  DisassembleRewardsPayload,
  InventoryLocation,
  SlottedInventoryLocation,
} from "./shared/types.js";
import type { GeneratedAffix } from "../equipmentService.js";
import type { SocketedGemEntry } from "../equipmentGrowthRules.js";
import type { CharacterBagSlotAllocator } from "../shared/characterBagSlotAllocator.js";
import type { CharacterInventoryMutationContext } from "../shared/characterInventoryMutationContext.js";
import type { InventorySlotSession } from "../shared/inventorySlotSession.js";

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
  getAffixPoolPreview,
} from "./equipment.js";
import { socketEquipment } from "./socket.js";
import {
  getDisassembleRewardPreview as fetchDisassembleRewardPreview,
  disassembleEquipment,
  disassembleEquipmentBatch,
} from "./disassemble.js";
import { flushCharacterPendingItemGrantsNow } from "../shared/characterItemGrantDeltaService.js";
import {
  getBagInventorySnapshot,
  getInventoryItemsWithDefs,
  getEquippedItemDefIds,
} from "./itemQuery.js";

class InventoryService {
  // ============================================
  // 读操作（无需事务）
  // ============================================

  /**
   * 库存交互前置准备。
   *
   * 作用：
   * 1. 在背包/仓库/使用道具等库存交互开始前，把当前角色待 flush 的奖励同步落成真实库存实例。
   * 2. 让后续所有库存读写只面对同一套 `item_instance` 权威数据，避免列表展示与实际可操作数量不一致。
   *
   * 输入 / 输出：
   * - 输入：角色 ID。
   * - 输出：`Promise<void>`；成功后表示当前角色的库存交互可以只依赖真实实例继续执行。
   *
   * 关键边界条件与坑点：
   * 1. 这是非事务 preflight，必须在具体库存事务开始前调用，避免外层业务回滚时提前 finalize 奖励。
   * 2. 只负责奖励结算前置，不负责角色鉴权与参数校验。
   */
  async prepareInventoryInteraction(characterId: number): Promise<void> {
    await flushCharacterPendingItemGrantsNow(characterId);
  }

  async getInventoryInfo(characterId: number): Promise<InventoryInfo> {
    return getInventoryInfo(characterId, { knownPendingGrantsFlushed: true });
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

  async getBagInventorySnapshot(characterId: number): Promise<{
    info: InventoryInfo;
    bagItems: InventoryItemWithDef[];
    equippedItems: InventoryItemWithDef[];
  }> {
    return getBagInventorySnapshot(characterId);
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

  async getAffixPoolPreview(
    characterId: number,
    itemInstanceId: number,
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      poolName: string;
      affixes: Array<{
        key: string;
        name: string;
        group: string;
        is_legendary: boolean;
        apply_type: string;
        tiers: Array<{ tier: number; min: number; max: number }>;
        owned: boolean;
      }>;
    };
  }> {
    return getAffixPoolPreview(characterId, itemInstanceId);
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
        maxLevel: number | null;
        successRate: number;
        failMode: "none" | "downgrade" | "destroy";
        costs: {
          materialItemDefId: string;
          materialName: string;
          materialQty: number;
          silverCost: number;
          spiritStoneCost: number;
        } | null;
        previewBaseAttrs: Record<string, number>;
      };
      refine: {
        currentLevel: number;
        targetLevel: number;
        maxLevel: number;
        successRate: number;
        failMode: "none" | "downgrade" | "destroy";
        costs: {
          materialItemDefId: string;
          materialName: string;
          materialQty: number;
          silverCost: number;
          spiritStoneCost: number;
        } | null;
        previewBaseAttrs: Record<string, number>;
      };
    };
  }> {
    return getEquipmentGrowthCostPreview(characterId, itemInstanceId);
  }

  async getDisassembleRewardPreview(
    characterId: number,
    itemInstanceId: number,
    qty: number,
  ): Promise<{
    success: boolean;
    message: string;
    rewards?: DisassembleRewardsPayload;
  }> {
    return fetchDisassembleRewardPreview(characterId, itemInstanceId, qty);
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
      bagSlotAllocator?: CharacterBagSlotAllocator;
      inventoryMutationContext?: CharacterInventoryMutationContext;
      slotSession?: InventorySlotSession;
      skipInventoryMutexLock?: boolean;
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
      strengthenLevel: number | null;
      targetLevel?: number;
      successRate?: number;
      roll?: number;
      failMode?: "none" | "downgrade" | "destroy";
      destroyed?: boolean;
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
    rewards?: DisassembleRewardsPayload;
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
    rewards?: DisassembleRewardsPayload;
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
