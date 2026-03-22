/**
 * 槽位冲突镜像同步辅助回归测试
 *
 * 作用：
 * 1. 做什么：锁定“只有库存镜像脏了才允许触发 DB 同步”这条规则，避免后续把实例创建重新改回每次都刷库。
 * 2. 不做什么：不触发真实 PostgreSQL/Redis，也不覆盖完整的物品创建链路。
 *
 * 输入/输出：
 * - 输入：角色 ID，以及对库存 meta 读取/镜像同步函数的 mock。
 * - 输出：辅助函数返回值、镜像同步调用次数。
 *
 * 数据流/状态流：
 * 调用辅助函数 -> 读取 Redis meta -> 决定是否同步 inventory 镜像 -> 返回是否已同步。
 *
 * 关键边界条件与坑点：
 * 1. `dirtyInventory=false` 时必须直接短路，否则缓存主路径会被误拖回数据库。
 * 2. `dirtyInventory=true` 时必须返回 `true`，让调用方明确知道这次冲突已经完成一次镜像修正并可重试。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as playerStateRepository from '../playerStateRepository.js';
import * as playerStateFlushService from '../playerStateFlushService.js';
import { syncDirtyInventoryMirrorOnSlotConflict } from '../inventory/shared/inventoryMirrorSync.js';
import type { PlayerStateMeta } from '../playerStateTypes.js';

const createMeta = (dirtyInventory: boolean): PlayerStateMeta => ({
  version: 3,
  dirtyCharacter: false,
  dirtyInventory,
  hydratedAt: '2026-03-23T00:00:00.000Z',
  lastFlushAt: null,
});

test('槽位冲突时：库存未脏则不应同步数据库镜像', async (t) => {
  const metaMock = t.mock.method(
    playerStateRepository,
    'loadPlayerStateMetaByCharacterId',
    async () => createMeta(false),
  );
  const syncMock = t.mock.method(
    playerStateFlushService,
    'syncInventoryMirrorByCharacterId',
    async () => {},
  );
  const refreshMock = t.mock.method(
    playerStateRepository,
    'refreshPlayerStateFromDatabaseByCharacterId',
    async () => {},
  );

  const result = await syncDirtyInventoryMirrorOnSlotConflict(1001);

  assert.equal(result, true);
  assert.equal(metaMock.mock.callCount(), 1);
  assert.equal(syncMock.mock.callCount(), 0);
  assert.equal(refreshMock.mock.callCount(), 1);
  assert.deepEqual(refreshMock.mock.calls[0]?.arguments, [1001]);
});

test('槽位冲突时：库存已脏应同步数据库镜像并返回可重试信号', async (t) => {
  const metaMock = t.mock.method(
    playerStateRepository,
    'loadPlayerStateMetaByCharacterId',
    async () => createMeta(true),
  );
  const syncMock = t.mock.method(
    playerStateFlushService,
    'syncInventoryMirrorByCharacterId',
    async () => {},
  );
  const refreshMock = t.mock.method(
    playerStateRepository,
    'refreshPlayerStateFromDatabaseByCharacterId',
    async () => {},
  );

  const result = await syncDirtyInventoryMirrorOnSlotConflict(2002);

  assert.equal(result, true);
  assert.equal(metaMock.mock.callCount(), 1);
  assert.equal(syncMock.mock.callCount(), 1);
  assert.deepEqual(syncMock.mock.calls[0]?.arguments, [2002]);
  assert.equal(refreshMock.mock.callCount(), 0);
});
