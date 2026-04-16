import { lockCharacterInventoryMutexes } from '../inventoryMutex.js';
import {
  lockCharacterRowsInOrder,
  normalizeCharacterRowLockIds,
} from './characterRowLock.js';

/**
 * Character Reward Target Lock - 奖励结算目标统一加锁工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一奖励发放场景里的锁顺序，先拿角色背包互斥锁，再按角色 ID 升序锁定 `characters` 行。
 * - 不做什么：不计算奖励数值，不写入角色资源，也不负责事务开启与重试。
 *
 * 输入/输出：
 * - normalizeCharacterRewardTargetIds(characterIds)：输入角色 ID 列表，输出去重、过滤非法值并升序后的结果。
 * - lockCharacterRewardInventoryTargets(characterIds)：只锁库存相关 advisory lock，适合只会入包、不直写 `characters` 的奖励事务。
 * - lockCharacterRewardSettlementTargets(characterIds)：库存锁 + `characters` 行锁的完整协议，适合后续还会写角色行的奖励事务。
 *
 * 复用点：
 * - battleDropService 与 dungeon/combat 共用这一套加锁顺序，避免相同锁协议散落在多个奖励入口。
 *
 * 数据流/状态流：
 * - 奖励结算服务先收集参与角色 ID；
 * - 本模块先统一获取背包 advisory xact lock，确保背包写入串行化；
 * - 再对同一批角色执行 `SELECT ... FOR UPDATE`，把后续 `UPDATE characters` 的行锁顺序固定下来。
 *
 * 关键边界条件与坑点：
 * 1. 本模块必须运行在事务上下文中；背包互斥锁与行锁都依赖同一事务连接生命周期。
 * 2. 只锁合法正整数角色 ID；非法 ID 会被直接过滤，避免把无效参数带进锁语句。
 */
export const normalizeCharacterRewardTargetIds = (
  characterIds: number[],
): number[] => normalizeCharacterRowLockIds(characterIds);

/**
 * 统一锁定奖励相关的库存目标
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：只为奖励入包场景获取角色背包互斥锁，统一多角色奖励落库的库存串行化顺序。
 * - 不做什么：不锁 `characters` 行，不承担资源扣减/结算时的角色行写入保护。
 *
 * 输入/输出：
 * - 输入：角色 ID 列表。
 * - 输出：规范化后的升序角色 ID 列表；成功返回即表示这些角色的库存写入可安全继续。
 *
 * 数据流/状态流：
 * - 奖励服务先收集会真实入包的目标角色；
 * - 本方法做去重、过滤和升序规整；
 * - 然后统一获取 advisory xact lock，后续 item_instance / inventory 相关写入都复用这套既定顺序。
 *
 * 复用设计说明：
 * - battleDrop / idle 奖励会在事务内写背包，但角色资源本身走 after-commit Delta，不需要额外占住 `characters` 行。
 * - 把“只锁库存”的协议独立出来后，奖励链路可以避免为不发生的 `characters` 写入额外持锁。
 *
 * 关键边界条件与坑点：
 * 1. 这里只能用于事务内不会直写 `characters` 的奖励链路；若后续同事务要更新角色行，请改用完整的奖励目标锁。
 * 2. 多角色场景仍必须走统一升序，否则 advisory lock 本身也会因顺序反转形成等待环。
 */
export const lockCharacterRewardInventoryTargets = async (
  characterIds: number[],
): Promise<number[]> => {
  const normalizedCharacterIds = normalizeCharacterRewardTargetIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return normalizedCharacterIds;
  }

  await lockCharacterInventoryMutexes(normalizedCharacterIds);

  return normalizedCharacterIds;
};

export const lockCharacterRewardSettlementTargets = async (
  characterIds: number[],
): Promise<number[]> => {
  const normalizedCharacterIds = normalizeCharacterRewardTargetIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return normalizedCharacterIds;
  }

  await lockCharacterInventoryMutexes(normalizedCharacterIds);
  await lockCharacterRowsInOrder(normalizedCharacterIds);

  return normalizedCharacterIds;
};
