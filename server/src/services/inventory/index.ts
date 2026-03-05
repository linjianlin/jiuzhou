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
 * 边界条件：
 * 1. 所有导出统一使用标准签名（不接受 transaction client 参数）
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
  moveItemInstanceToBagWithStacking,
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
  getEquipmentGrowthCostPreview,
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
