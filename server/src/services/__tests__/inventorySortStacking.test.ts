/**
 * inventory.sortInventory 自动堆叠回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证背包一键整理会先自动合并可堆叠物品，再把剩余实例从 0 开始连续重排槽位。
 * - 做什么：锁住“带 metadata / quality / quality_rank 的实例不参与普通堆叠”这一边界，避免整理把特殊实例错误合并。
 * - 不做什么：不连接真实数据库，不覆盖路由层，也不执行项目 test 命令。
 *
 * 输入/输出：
 * - 输入：mock 后的 inventory 查询结果、静态物品定义，以及 `sortInventory(characterId, 'bag')` 调用。
 * - 输出：整理结果，以及内存态 `item_instance` 列表的数量、堆叠数量和槽位分布。
 *
 * 数据流/状态流：
 * - 测试通过 mock `database.query` 构造背包实例的内存镜像；
 * - `sortInventory` 在镜像上执行“读取 -> 自动堆叠 -> 删除空实例 -> 两段式写槽位”；
 * - 最后断言整理后的实例状态与业务预期一致。
 *
 * 关键边界条件与坑点：
 * 1) 自动堆叠必须只合并普通堆叠实例，不能把带 metadata / quality / quality_rank 的特殊实例吞掉。
 * 2) 整理后的槽位必须连续，避免只做了数量合并却留下稀疏槽位，导致 UI 仍然表现为“没整理干净”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import * as database from '../../config/database.js';
import * as inventoryMutex from '../inventoryMutex.js';
import * as staticConfigLoader from '../staticConfigLoader.js';
import { sortInventory } from '../inventory/bag.js';

type MockInventoryRow = {
  id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  bind_type: string;
  metadata_text: string | null;
  location: 'bag' | 'warehouse';
  location_slot: number | null;
};

const createInventoryQueryMock = (
  t: TestContext,
  itemRows: MockInventoryRow[],
) => {
  t.mock.method(inventoryMutex, 'lockCharacterInventoryMutex', async () => {});
  t.mock.method(staticConfigLoader, 'getItemDefinitionsByIds', (itemDefIds: string[]) => {
    const map = new Map<string, {
      category: string;
      sub_category: string | null;
      quality: string | null;
      stack_max: number;
    }>();
    for (const itemDefId of itemDefIds) {
      if (itemDefId === 'cons-001') {
        map.set(itemDefId, {
          category: 'consumable',
          sub_category: 'elixir',
          quality: 'common',
          stack_max: 10,
        });
      }
      if (itemDefId === 'mat-001') {
        map.set(itemDefId, {
          category: 'material',
          sub_category: 'ore',
          quality: 'common',
          stack_max: 99,
        });
      }
      if (itemDefId === 'mat-9999') {
        map.set(itemDefId, {
          category: 'material',
          sub_category: 'ore',
          quality: 'common',
          stack_max: 9999,
        });
      }
    }
    return map;
  });

  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM inventory i')) {
      return {
        rows: [
          {
            bag_capacity: 30,
            warehouse_capacity: 1000,
            bag_used: itemRows.filter((row) => row.location === 'bag').length,
            warehouse_used: itemRows.filter((row) => row.location === 'warehouse').length,
          },
        ],
      };
    }

    if (
      sql.includes('FROM item_instance') &&
      sql.includes('owner_character_id = $1') &&
      sql.includes('location = $2') &&
      sql.includes('FOR UPDATE')
    ) {
      const location = params?.[1];
      return {
        rows: itemRows
          .filter((row) => row.location === location)
          .map((row) => ({
            id: row.id,
            item_def_id: row.item_def_id,
            qty: row.qty,
            quality: row.quality,
            quality_rank: row.quality_rank,
            bind_type: row.bind_type,
            metadata_text: row.metadata_text,
            location_slot: row.location_slot,
          })),
      };
    }

    if (sql.includes('UPDATE item_instance') && sql.includes('SET qty = $1')) {
      const nextQty = Number(params?.[0]);
      const hasBindTypeUpdate = sql.includes('bind_type = $2');
      const nextBindType = hasBindTypeUpdate ? String(params?.[1] ?? '') : null;
      const itemId = Number(params?.[hasBindTypeUpdate ? 2 : 1]);
      const target = itemRows.find((row) => row.id === itemId);
      assert.ok(target, `未找到待更新数量的物品: ${itemId}`);
      target.qty = nextQty;
      if (hasBindTypeUpdate) {
        target.bind_type = nextBindType || 'none';
      }
      if (sql.includes('metadata = NULL')) {
        target.metadata_text = null;
        target.quality = null;
        target.quality_rank = null;
      }
      return { rows: [] };
    }

    if (sql.includes('DELETE FROM item_instance') && sql.includes('WHERE id = $1')) {
      const itemId = Number(params?.[0]);
      const index = itemRows.findIndex((row) => row.id === itemId);
      assert.notEqual(index, -1, `未找到待删除的物品: ${itemId}`);
      itemRows.splice(index, 1);
      return { rows: [] };
    }

    if (sql.includes('UPDATE item_instance') && sql.includes('SET location_slot = $1')) {
      const nextSlotRaw = params?.[0];
      const itemId = Number(params?.[1]);
      const target = itemRows.find((row) => row.id === itemId);
      assert.ok(target, `未找到待更新格子的物品: ${itemId}`);
      target.location_slot = nextSlotRaw === null ? null : Number(nextSlotRaw);
      return { rows: [] };
    }

    assert.fail(`未预期的 SQL: ${sql}`);
  });
};

test('整理背包时应先合并普通可堆叠物品，再连续重排槽位', async (t) => {
  const itemRows: MockInventoryRow[] = [
    {
      id: 11,
      item_def_id: 'cons-001',
      qty: 3,
      quality: null,
      quality_rank: null,
      bind_type: 'bound',
      metadata_text: null,
      location: 'bag',
      location_slot: 5,
    },
    {
      id: 12,
      item_def_id: 'cons-001',
      qty: 6,
      quality: null,
      quality_rank: null,
      bind_type: 'bound',
      metadata_text: null,
      location: 'bag',
      location_slot: 1,
    },
    {
      id: 13,
      item_def_id: 'cons-001',
      qty: 10,
      quality: null,
      quality_rank: null,
      bind_type: 'bound',
      metadata_text: null,
      location: 'bag',
      location_slot: 8,
    },
    {
      id: 14,
      item_def_id: 'mat-001',
      qty: 1,
      quality: null,
      quality_rank: null,
      bind_type: 'none',
      metadata_text: null,
      location: 'bag',
      location_slot: 3,
    },
  ];
  createInventoryQueryMock(t, itemRows);

  const result = await sortInventory(1001, 'bag');

  assert.equal(result.success, true);
  assert.equal(result.message, '整理完成');
  assert.deepEqual(
    itemRows
      .slice()
      .sort((left, right) => (left.location_slot ?? 999) - (right.location_slot ?? 999))
      .map(({ id, qty, location_slot }) => ({ id, qty, location_slot })),
    [
      { id: 13, qty: 10, location_slot: 0 },
      { id: 12, qty: 9, location_slot: 1 },
      { id: 14, qty: 1, location_slot: 2 },
    ],
  );
});

test('整理背包时不应合并带 metadata 或品质信息的特殊实例', async (t) => {
  const itemRows: MockInventoryRow[] = [
    {
      id: 21,
      item_def_id: 'mat-001',
      qty: 7,
      quality: null,
      quality_rank: null,
      bind_type: 'none',
      metadata_text: null,
      location: 'bag',
      location_slot: 4,
    },
    {
      id: 22,
      item_def_id: 'mat-001',
      qty: 5,
      quality: null,
      quality_rank: null,
      bind_type: 'none',
      metadata_text: '{"rolled":1}',
      location: 'bag',
      location_slot: 0,
    },
    {
      id: 23,
      item_def_id: 'mat-001',
      qty: 2,
      quality: 'rare',
      quality_rank: 2,
      bind_type: 'none',
      metadata_text: null,
      location: 'bag',
      location_slot: 6,
    },
  ];
  createInventoryQueryMock(t, itemRows);

  const result = await sortInventory(1002, 'bag');

  assert.equal(result.success, true);
  assert.equal(itemRows.length, 3);
  assert.deepEqual(
    itemRows
      .slice()
      .sort((left, right) => (left.location_slot ?? 999) - (right.location_slot ?? 999))
      .map(({ id, qty, location_slot }) => ({ id, qty, location_slot })),
    [
      { id: 23, qty: 2, location_slot: 0 },
      { id: 21, qty: 7, location_slot: 1 },
      { id: 22, qty: 5, location_slot: 2 },
    ],
  );
});

test('整理背包时应把空语义字段的 9999 堆上限实例继续视为普通可堆叠物品', async (t) => {
  const itemRows: MockInventoryRow[] = [
    {
      id: 31,
      item_def_id: 'mat-9999',
      qty: 9900,
      quality: '',
      quality_rank: 0,
      bind_type: 'none',
      metadata_text: 'null',
      location: 'bag',
      location_slot: 7,
    },
    {
      id: 32,
      item_def_id: 'mat-9999',
      qty: 9099,
      quality: null,
      quality_rank: null,
      bind_type: 'none',
      metadata_text: null,
      location: 'bag',
      location_slot: 2,
    },
  ];
  createInventoryQueryMock(t, itemRows);

  const result = await sortInventory(1003, 'bag');

  assert.equal(result.success, true);
  assert.equal(result.message, '整理完成');
  assert.deepEqual(
    itemRows
      .slice()
      .sort((left, right) => (left.location_slot ?? 999) - (right.location_slot ?? 999))
      .map(({ id, qty, quality, quality_rank, metadata_text, location_slot }) => ({
        id,
        qty,
        quality,
        quality_rank,
        metadata_text,
        location_slot,
      })),
    [
      {
        id: 31,
        qty: 9999,
        quality: null,
        quality_rank: null,
        metadata_text: null,
        location_slot: 0,
      },
      {
        id: 32,
        qty: 9000,
        quality: null,
        quality_rank: null,
        metadata_text: null,
        location_slot: 1,
      },
    ],
  );
});

test('整理背包时应把未标准化的未绑定 bind_type 归一后继续合并', async (t) => {
  const itemRows: MockInventoryRow[] = [
    {
      id: 41,
      item_def_id: 'mat-9999',
      qty: 9000,
      quality: null,
      quality_rank: null,
      bind_type: '',
      metadata_text: null,
      location: 'bag',
      location_slot: 9,
    },
    {
      id: 42,
      item_def_id: 'mat-9999',
      qty: 2000,
      quality: null,
      quality_rank: null,
      bind_type: ' NONE ',
      metadata_text: null,
      location: 'bag',
      location_slot: 1,
    },
  ];
  createInventoryQueryMock(t, itemRows);

  const result = await sortInventory(1004, 'bag');

  assert.equal(result.success, true);
  assert.equal(result.message, '整理完成');
  assert.deepEqual(
    itemRows
      .slice()
      .sort((left, right) => (left.location_slot ?? 999) - (right.location_slot ?? 999))
      .map(({ id, qty, bind_type, location_slot }) => ({
        id,
        qty,
        bind_type,
        location_slot,
      })),
    [
      { id: 41, qty: 9999, bind_type: 'none', location_slot: 0 },
      { id: 42, qty: 1001, bind_type: 'none', location_slot: 1 },
    ],
  );
});
