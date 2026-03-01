/**
 * 背包领域门面
 * 作用：集中暴露背包相关服务，降低 routes 对 services 目录耦合。
 */
import {
  addItemToInventory,
  disassembleEquipment,
  disassembleEquipmentBatch,
  enhanceEquipment,
  equipItem,
  expandInventory,
  findEmptySlots,
  getInventoryInfo,
  getInventoryItems,
  getRerollCostPreview,
  moveItem,
  refineEquipment,
  removeItemFromInventory,
  removeItemsBatch,
  rerollEquipmentAffixes,
  setItemLocked,
  socketEquipment,
  sortInventory,
  unequipItem,
} from '../../services/inventory/index.js';
export { itemService } from '../../services/itemService.js';
export { craftService } from '../../services/craftService.js';
export { gemSynthesisService } from '../../services/gemSynthesisService.js';

export const inventoryService = {
  getInventoryInfo,
  getInventoryItems,
  getRerollCostPreview,
  findEmptySlots,
  addItemToInventory,
  removeItemFromInventory,
  setItemLocked,
  moveItem,
  equipItem,
  unequipItem,
  enhanceEquipment,
  refineEquipment,
  rerollEquipmentAffixes,
  socketEquipment,
  disassembleEquipment,
  disassembleEquipmentBatch,
  removeItemsBatch,
  expandInventory,
  sortInventory,
};

export type {
  InventoryInfo,
  InventoryItem,
  InventoryLocation,
  SlottedInventoryLocation,
} from '../../services/inventory/index.js';

export * from '../../services/inventory/index.js';
export * from '../../services/itemService.js';
export * from '../../services/craftService.js';
export * from '../../services/gemSynthesisService.js';
