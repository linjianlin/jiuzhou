/**
 * 背包服务导出聚合
 *
 * 作用：集中导出背包领域所有子模块的公共 API，
 *       作为外部消费背包功能的唯一入口。
 *
 * 导出来源：
 * - shared/types.ts — 公共类型/接口/常量
 * - bag.ts — 背包 CRUD（增删改查、移动、排序、扩容）
 * - equipment.ts — 装备操作（穿戴/卸下/强化/精炼/洗炼）
 * - socket.ts — 装备镶嵌
 * - disassemble.ts — 装备拆解
 * - itemQuery.ts — 物品聚合查询
 * - service.ts — InventoryService 单例（@Transactional 装饰器）
 *
 * 向后兼容导出：
 * - addItemToInventoryTx — 旧签名别名，内部忽略 client 参数
 * - findEmptySlotsWithClient — 旧签名别名
 * - getInventoryInfoWithClient — 旧签名别名
 * - expandInventoryWithClient — 旧签名别名
 *
 * 边界条件：
 * 1. 旧别名仅供尚未改造的外部调用方过渡使用，新代码应直接使用无 client 版本
 * 2. 所有类型导出均来自 shared/types.ts，避免循环引用
 */

// ============================================
// 类型导出
// ============================================
export type {
  InventoryLocation,
  SlottedInventoryLocation,
  InventoryItem,
  InventoryItemWithDef,
  InventoryInfo,
  CharacterAttrKey,
  DisassembleGrantedItemReward,
  DisassembleRewardsPayload,
} from "./shared/types.js";

export {
  BAG_CAPACITY_MAX,
  allowedCharacterAttrKeys,
} from "./shared/types.js";

// ============================================
// 背包 CRUD
// ============================================
export {
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

// ============================================
// 装备操作
// ============================================
export {
  equipItem,
  unequipItem,
  enhanceEquipment,
  refineEquipment,
  rerollEquipmentAffixes,
  getRerollCostPreview,
} from "./equipment.js";

// ============================================
// 镶嵌
// ============================================
export { socketEquipment } from "./socket.js";

// ============================================
// 拆解
// ============================================
export {
  disassembleEquipment,
  disassembleEquipmentBatch,
} from "./disassemble.js";

// ============================================
// 物品聚合查询
// ============================================
export {
  getInventoryItemsWithDefs,
  getEquippedItemDefIds,
} from "./itemQuery.js";

// ============================================
// 服务类单例
// ============================================
export { inventoryService } from "./service.js";

// ============================================
// 向后兼容别名：旧签名接受 client 参数但内部忽略
// ============================================
import type { PoolClient } from "pg";
import { addItemToInventory } from "./bag.js";
import { findEmptySlots } from "./bag.js";
import { getInventoryInfo } from "./bag.js";
import { expandInventory as _expandInventory } from "./bag.js";
import type { SlottedInventoryLocation as _SIL, InventoryInfo as _II } from "./shared/types.js";

/**
 * addItemToInventoryTx 向后兼容别名
 * 接受 client 参数但忽略，内部委托 addItemToInventory
 */
export const addItemToInventoryTx = async (
  _client: PoolClient,
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: _SIL;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  return addItemToInventory(characterId, userId, itemDefId, qty, options);
};

/**
 * findEmptySlotsWithClient 向后兼容别名
 * 接受 client 参数但忽略
 */
export const findEmptySlotsWithClient = async (
  characterId: number,
  location: _SIL,
  count: number = 1,
  _client: PoolClient | null,
): Promise<number[]> => {
  return findEmptySlots(characterId, location, count);
};

/**
 * getInventoryInfoWithClient 向后兼容别名
 * 接受 client 参数但忽略
 */
export const getInventoryInfoWithClient = async (
  characterId: number,
  _client: PoolClient | null,
): Promise<_II> => {
  return getInventoryInfo(characterId);
};

/**
 * expandInventoryWithClient 向后兼容别名
 * 接受 client 参数但忽略
 */
export const expandInventoryWithClient = async (
  _client: PoolClient,
  characterId: number,
  location: _SIL,
  expandSize: number = 10,
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  return _expandInventory(characterId, location, expandSize);
};
