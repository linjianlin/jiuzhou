/**
 * equipment buffered 创建槽位收敛测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证装备实例 buffered 创建在 projected 视图与数据库底表暂时不一致时，会跳过数据库仍占用的槽位。
 * 2. 不做什么：不触达真实数据库、不测试完整装备生成或 Redis flush，只覆盖槽位收敛决策。
 *
 * 输入 / 输出：
 * - 输入：候选空槽列表、数据库占槽判断、是否允许 fallback。
 * - 输出：最终选中的 `locationSlot`，或明确的失败消息。
 *
 * 数据流 / 状态流：
 * - 调用方先基于 projected/session 给出候选槽位；
 * - helper 再用数据库当前占槽状态过滤冲突槽位；
 * - 若允许 fallback，则选择第一个真实可用槽，否则直接失败。
 *
 * 复用设计说明：
 * - 把 buffered equipment-create 的“projected 选槽 + DB 占槽二次校验”收敛到单一入口，避免 createEquipmentInstanceTx 自己散落重试判断。
 * - 该入口只负责槽位决策，不接管装备生成、实例 ID 预留或 mutation buffer，边界清晰。
 *
 * 关键边界条件与坑点：
 * 1. projected 视图可能因为 pending mutation 提前释放旧槽，导致看起来空闲但数据库仍占用；这是本测试覆盖的核心场景。
 * 2. 不允许 fallback 的显式槽位必须保持严格失败语义，不能被 helper 偷偷改到别的格子。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveBufferedEquipmentCreateSlot } from '../equipmentService.js';

test('buffered 装备创建在显式槽位撞上数据库占槽且允许 fallback 时应改用下一个真实空槽', async () => {
  const result = await resolveBufferedEquipmentCreateSlot(
    {
      location: 'bag',
      locationSlot: 11,
      shouldFallbackOnSlotConflict: true,
    },
    {
      getCapacity: async () => 200,
      listEmptySlots: async () => [11, 12, 14, 15],
      isConcreteSlotOccupied: async (slot) => slot === 11 || slot === 12,
    },
  );

  assert.deepEqual(result, {
    success: true,
    locationSlot: 14,
  });
});

test('buffered 装备创建在显式槽位撞上数据库占槽且不允许 fallback 时应直接失败', async () => {
  const result = await resolveBufferedEquipmentCreateSlot(
    {
      location: 'bag',
      locationSlot: 11,
      shouldFallbackOnSlotConflict: false,
    },
    {
      getCapacity: async () => 200,
      listEmptySlots: async () => [11, 12, 14, 15],
      isConcreteSlotOccupied: async (slot) => slot === 11,
    },
  );

  assert.deepEqual(result, {
    success: false,
    message: '目标格子已被占用',
  });
});

test('buffered 装备创建在未指定槽位时应跳过数据库仍占用的 projected 空槽', async () => {
  const result = await resolveBufferedEquipmentCreateSlot(
    {
      location: 'bag',
      locationSlot: null,
      shouldFallbackOnSlotConflict: true,
    },
    {
      getCapacity: async () => 200,
      listEmptySlots: async () => [11, 12, 14, 15],
      isConcreteSlotOccupied: async (slot) => slot === 11 || slot === 12 || slot === 14,
    },
  );

  assert.deepEqual(result, {
    success: true,
    locationSlot: 15,
  });
});
