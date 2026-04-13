import {
  createInventorySlotSession,
  type InventorySlotSession,
} from './inventorySlotSession.js';

/**
 * CharacterBagSlotAllocator - 奖励链路背包空槽预分配器
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：在奖励事务已经统一持有角色背包互斥锁后，一次性读取多个角色的背包容量与已占用槽位，并在内存中按角色顺序预分配新空槽。
 * - 不做什么：不负责事务开启，不负责物品入包，不处理仓库/拍卖/mail 等非背包位置。
 *
 * 输入 / 输出：
 * - createCharacterBagSlotAllocator(characterIds)：输入角色 ID 列表，输出一个仅负责 `bag` 新槽位分配的分配器。
 * - reserveSlots(characterId, count)：输入角色 ID 与所需槽位数，输出按槽位升序保留的空槽列表；不足时只返回当前还能拿到的前缀结果。
 *
 * 数据流 / 状态流：
 * - 奖励服务先统一锁定角色背包；
 * - 本模块补齐 `inventory` 行并批量读取容量，再结合 projected item instance 视图收敛已占用槽位；
 * - 后续所有奖励入包只向本模块申请新槽位，避免每次创建物品都重新扫描一次 `item_instance.location_slot`。
 *
 * 复用设计说明：
 * - 把“奖励事务内的新槽位分配”集中到单一入口，battleDropService 与 onlineBattleSettlementRunner 共用同一份分配协议。
 * - 普通可堆叠物品和装备实例都通过同一个分配器消费新槽位，避免一边用缓存、一边继续实时扫表导致槽位视图分叉。
 *
 * 关键边界条件与坑点：
 * 1. 本模块只适用于调用链已经拿到角色背包互斥锁的事务；否则缓存的空槽视图会被并发写入打破。
 * 2. `reserveSlots` 只保留“新占用槽位”，不会感知已有堆叠扩容；调用方必须只在确实需要新槽位时才消费它。
 */
export interface CharacterBagSlotAllocator {
  reserveSlots(characterId: number, count: number): number[];
}

type CharacterBagSlotState = {
  emptySlots: number[];
  nextIndex: number;
};

const EMPTY_ALLOCATOR: CharacterBagSlotAllocator = {
  reserveSlots: (): number[] => [],
};

export const createCharacterBagSlotAllocatorFromSession = (
  slotSession: InventorySlotSession,
  characterIds: number[],
): CharacterBagSlotAllocator => {
  if (characterIds.length <= 0) {
    return EMPTY_ALLOCATOR;
  }

  const slotStateByCharacter = new Map<number, CharacterBagSlotState>();
  for (const characterId of characterIds) {
    const capacity = slotSession.getSlottedCapacity(characterId, 'bag') ?? 0;
    slotStateByCharacter.set(characterId, {
      emptySlots: slotSession.listEmptySlots(characterId, 'bag', capacity),
      nextIndex: 0,
    });
  }

  return {
    reserveSlots: (characterId: number, count: number): number[] => {
      if (!Number.isInteger(characterId) || characterId <= 0) {
        return [];
      }
      const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
      if (normalizedCount <= 0) {
        return [];
      }

      const state = slotStateByCharacter.get(characterId);
      if (!state || state.nextIndex >= state.emptySlots.length) {
        return [];
      }

      const startIndex = state.nextIndex;
      const endIndex = Math.min(state.emptySlots.length, startIndex + normalizedCount);
      state.nextIndex = endIndex;
      return state.emptySlots.slice(startIndex, endIndex);
    },
  };
};

export const createCharacterBagSlotAllocator = async (
  characterIds: number[],
): Promise<CharacterBagSlotAllocator> => {
  const slotSession = await createInventorySlotSession(characterIds);
  return createCharacterBagSlotAllocatorFromSession(slotSession, characterIds);
};
