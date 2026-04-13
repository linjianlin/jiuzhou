import type { SlottedInventoryLocation } from '../inventory/shared/types.js';
import {
  createInventorySlotSession,
  type InventorySlotSession,
  type PlainAutoStackLookupOptions,
  type PlainAutoStackLookupRow,
} from './inventorySlotSession.js';

/**
 * CharacterInventoryMutationContext - 奖励事务库存视图缓存
 *
 * 作用：
 * 1. 做什么：作为 InventorySlotSession 的兼容包装层，继续向旧调用方暴露容量与普通可堆叠承载查询接口。
 * 2. 不做什么：不再自行加载 projected inventory，也不再独立维护第二份槽位/堆叠缓存。
 *
 * 输入 / 输出：
 * 1. `createCharacterInventoryMutationContext(characterIds)`：按角色列表创建共享会话后，返回兼容旧接口的上下文对象。
 * 2. `createCharacterInventoryMutationContextFromSession(slotSession)`：把现成的事务级 session 包装为旧上下文接口。
 *
 * 数据流 / 状态流：
 * - 调用方先创建 InventorySlotSession；
 * - 本模块只把读取/更新请求转发到同一个 session；
 * - 后续普通入包、装备入包、邮件同步入包都看到同一份事务内库存视图。
 *
 * 复用设计说明：
 * - 保留旧接口是为了让 reward/mail/createItem 链路可以渐进迁移，不必一口气改掉所有调用点。
 * - 真正的权威状态已经集中到 InventorySlotSession，避免 capacity 与 plain stack index 再维护第二份副本。
 *
 * 关键边界条件与坑点：
 * 1. 兼容包装层本身不做并发保护，调用方仍必须在已持锁的事务里使用。
 * 2. 新代码应优先直接传递 slotSession；这里只有过渡期兼容价值。
 */

export type { PlainAutoStackLookupOptions, PlainAutoStackLookupRow };

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

export const createCharacterInventoryMutationContextFromSession = (
  slotSession: InventorySlotSession,
): CharacterInventoryMutationContext => ({
  getSlottedCapacity: (characterId, location) => slotSession.getSlottedCapacity(characterId, location),
  getPlainAutoStackRows: (options) => slotSession.getPlainAutoStackRows(options),
  applyPlainAutoStackDelta: (options) => {
    slotSession.applyPlainAutoStackDelta(options);
  },
  registerPlainAutoStackRow: (options) => {
    slotSession.registerPlainAutoStackRow(options);
  },
});

export const createCharacterInventoryMutationContext = async (
  characterIds: number[],
): Promise<CharacterInventoryMutationContext> => {
  if (characterIds.length <= 0) {
    return EMPTY_CONTEXT;
  }
  const slotSession = await createInventorySlotSession(characterIds);
  return createCharacterInventoryMutationContextFromSession(slotSession);
};
