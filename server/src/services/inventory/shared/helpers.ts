/**
 * 背包领域内部通用辅助函数
 *
 * 作用：提供背包子模块共享的数值安全转换、静态物品定义加载等纯函数工具。
 *       不做数据库操作，不做业务逻辑判断。
 *
 * 被引用方：shared/attrDelta、shared/consume、shared/validation、
 *           bag、equipment、socket、disassemble
 *
 * 边界条件：
 * 1. safeNumber 对 NaN/Infinity 返回 0，不抛异常
 * 2. getEnabledStaticItemDef 在 enabled === false 时返回 null
 */
import { getItemDefinitionById } from "../../staticConfigLoader.js";
import {
  clampInt as clampGrowthInt,
} from "../../equipmentGrowthRules.js";
import type {
  InventoryInfo,
  SlottedInventoryLocation,
} from "./types.js";
import {
  DEFAULT_BAG_CAPACITY,
  DEFAULT_WAREHOUSE_CAPACITY,
} from "./types.js";

export const clampInt = clampGrowthInt;

export const safeNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

export const getStaticItemDef = (itemDefIdRaw: unknown) => {
  const itemDefId = String(itemDefIdRaw || "").trim();
  if (!itemDefId) return null;
  return getItemDefinitionById(itemDefId);
};

export const getEnabledStaticItemDef = (itemDefIdRaw: unknown) => {
  const itemDef = getStaticItemDef(itemDefIdRaw);
  if (!itemDef || itemDef.enabled === false) return null;
  return itemDef;
};

export const createDefaultInventoryInfo = (): InventoryInfo => ({
  bag_capacity: DEFAULT_BAG_CAPACITY,
  warehouse_capacity: DEFAULT_WAREHOUSE_CAPACITY,
  bag_used: 0,
  warehouse_used: 0,
});

export const getSlottedCapacity = (
  info: InventoryInfo,
  location: SlottedInventoryLocation,
): number => (location === "bag" ? info.bag_capacity : info.warehouse_capacity);
