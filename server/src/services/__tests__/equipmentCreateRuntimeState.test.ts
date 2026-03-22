/**
 * 装备创建运行时主状态回归测试
 *
 * 作用：
 * 1. 做什么：锁定装备实例创建成功后必须同步 Redis 主状态，避免背包容量显示继续漏算装备占格。
 * 2. 不做什么：不覆盖完整的装备随机生成逻辑，也不连接真实数据库/Redis。
 *
 * 输入/输出：
 * - 输入：模拟生成好的装备、候选槽位、插入成功返回的实例 ID。
 * - 输出：`createEquipmentInstance` 的返回值，以及 Redis 主状态写入参数。
 *
 * 数据流/状态流：
 * 创建装备实例 -> 分配槽位 -> 插入 `item_instance` -> `upsertPlayerInventoryState` 写入 Redis 主状态。
 *
 * 关键边界条件与坑点：
 * 1. Redis 写回必须复用与 DB 一致的 `location/location_slot/random_seed/affixes`，否则后续背包查询仍会错位。
 * 2. 这里只锁定“成功后必须写 Redis”，不把 DB 插入细节耦合进测试断言。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as inventoryDomain from '../inventory/index.js';
import * as inventoryMirrorSync from '../inventory/shared/inventoryMirrorSync.js';
import * as inventorySlotInsert from '../shared/itemInstanceSlotInsert.js';
import * as playerStateRepository from '../playerStateRepository.js';
import * as inventoryMutex from '../inventoryMutex.js';
import { equipmentService } from '../equipmentService.js';

test('createEquipmentInstance: 成功后应同步 Redis 运行时库存状态', async (t) => {
  type UpsertInventoryArgs = Parameters<typeof playerStateRepository.upsertPlayerInventoryState>;

  const lockMock = t.mock.method(
    inventoryMutex,
    'lockCharacterInventoryMutex',
    async () => {},
  );
  const slotsMock = t.mock.method(
    inventoryDomain,
    'findEmptySlots',
    async () => [7],
  );
  const insertMock = t.mock.method(
    inventorySlotInsert,
    'tryInsertItemInstanceWithSlot',
    async () => 9001,
  );
  const syncMock = t.mock.method(
    inventoryMirrorSync,
    'syncDirtyInventoryMirrorOnSlotConflict',
    async () => {
      throw new Error('首轮插入成功时不应触发槽位冲突修复');
    },
  );
  const upsertMock = t.mock.method(
    playerStateRepository,
    'upsertPlayerInventoryState',
    async (...args: UpsertInventoryArgs) => args[1],
  );

  const result = await equipmentService.createEquipmentInstance(
    101,
    202,
    {
      itemDefId: 'weapon-001',
      quality: '玄',
      qualityRank: 2,
      seed: 3456,
      affixes: [],
      affixGenVersion: 9,
      name: '测试法剑',
      baseAttrs: {},
      setId: null,
    },
    {
      location: 'bag',
      bindType: 'bound',
      obtainedFrom: 'mail',
    },
  );

  assert.deepEqual(result, {
    success: true,
    instanceId: 9001,
    message: '装备创建成功',
  });
  assert.equal(lockMock.mock.callCount(), 1);
  assert.equal(slotsMock.mock.callCount(), 1);
  assert.equal(insertMock.mock.callCount(), 1);
  assert.equal(syncMock.mock.callCount(), 0);
  assert.equal(upsertMock.mock.callCount(), 1);

  const upsertArgs = upsertMock.mock.calls[0]?.arguments;
  assert.equal(upsertArgs?.[0], 202);
  assert.equal((upsertArgs?.[1] as { id: number }).id, 9001);
  assert.equal((upsertArgs?.[1] as { location: string }).location, 'bag');
  assert.equal((upsertArgs?.[1] as { location_slot: number | null }).location_slot, 7);
  assert.equal((upsertArgs?.[1] as { random_seed: number | null }).random_seed, 3456);
  assert.equal((upsertArgs?.[1] as { bind_type: string | null }).bind_type, 'bound');
});
