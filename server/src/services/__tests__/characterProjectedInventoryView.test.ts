/**
 * projected 库存视图回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证奖励链路的空槽分配器与普通堆叠上下文都会基于 projected item instance 视图，而不是只看数据库当前落库状态。
 * - 做什么：锁住“角色已缓冲的一键整理 / 迁移 mutation 也必须影响奖励入包决策”这条边界，避免异步 flush 窗口里再次占用旧槽位。
 * - 不做什么：不连接真实数据库，不执行完整奖励发放流程，也不覆盖路由层。
 *
 * 输入 / 输出：
 * - 输入：mock 的 inventory 容量查询，以及 mock 的 `loadProjectedCharacterItemInstances` 返回值。
 * - 输出：分配器预留的空槽列表、普通堆叠上下文返回的承载实例列表。
 *
 * 数据流 / 状态流：
 * - 测试先伪造角色 inventory 基础容量；
 * - 再把 projected item instance 视图直接注入 allocator / context；
 * - 最后断言两者都以 projected 结果为准，不再回退到旧 DB 占位视图。
 *
 * 关键边界条件与坑点：
 * 1. 只要 projected 视图里某个 bag 槽位已被占用，即使它还没 flush 到数据库，奖励链路也不能再把新物品分到这个槽位。
 * 2. 普通堆叠上下文必须沿用 projected 视图里的最终实例集合，避免把奖励叠加到已经被 pending mutation 删除或迁走的旧实例上。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as characterItemInstanceMutationService from '../shared/characterItemInstanceMutationService.js';
import { createCharacterBagSlotAllocator } from '../shared/characterBagSlotAllocator.js';
import { createCharacterInventoryMutationContext } from '../shared/characterInventoryMutationContext.js';

test('bag slot allocator 应基于 projected 视图跳过待 flush 占位槽', async (t) => {
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('INSERT INTO inventory')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT character_id, bag_capacity')) {
      return {
        rows: [
          { character_id: 1, bag_capacity: 5 },
        ],
      };
    }
    assert.fail(`未预期的 SQL: ${sql}`);
  });

  t.mock.method(
    characterItemInstanceMutationService,
    'loadProjectedCharacterItemInstances',
    async (characterId: number) => {
      assert.equal(characterId, 1);
      return [
        {
          id: 101,
          owner_user_id: 1,
          owner_character_id: 1,
          item_def_id: 'mat-001',
          qty: 1,
          quality: null,
          quality_rank: null,
          metadata: null,
          location: 'bag',
          location_slot: 0,
          equipped_slot: null,
          strengthen_level: 0,
          refine_level: 0,
          socketed_gems: [],
          affixes: [],
          identified: true,
          locked: false,
          bind_type: 'none',
          bind_owner_user_id: null,
          bind_owner_character_id: null,
          random_seed: null,
          affix_gen_version: 0,
          affix_roll_meta: null,
          custom_name: null,
          expire_at: null,
          obtained_from: 'sort',
          obtained_ref_id: null,
          created_at: new Date('2026-04-08T10:00:00.000Z'),
        },
        {
          id: 102,
          owner_user_id: 1,
          owner_character_id: 1,
          item_def_id: 'mat-002',
          qty: 1,
          quality: null,
          quality_rank: null,
          metadata: null,
          location: 'bag',
          location_slot: 2,
          equipped_slot: null,
          strengthen_level: 0,
          refine_level: 0,
          socketed_gems: [],
          affixes: [],
          identified: true,
          locked: false,
          bind_type: 'none',
          bind_owner_user_id: null,
          bind_owner_character_id: null,
          random_seed: null,
          affix_gen_version: 0,
          affix_roll_meta: null,
          custom_name: null,
          expire_at: null,
          obtained_from: 'sort',
          obtained_ref_id: null,
          created_at: new Date('2026-04-08T10:00:00.000Z'),
        },
      ];
    },
  );

  const allocator = await createCharacterBagSlotAllocator([1]);

  assert.deepEqual(allocator.reserveSlots(1, 2), [1, 3]);
});

test('inventory mutation context 应基于 projected 视图建立普通堆叠承载行', async (t) => {
  t.mock.method(database, 'query', async (sql: string) => {
    if (sql.includes('INSERT INTO inventory')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT character_id, bag_capacity, warehouse_capacity')) {
      return {
        rows: [
          { character_id: 1, bag_capacity: 30, warehouse_capacity: 100 },
        ],
      };
    }
    assert.fail(`未预期的 SQL: ${sql}`);
  });

  t.mock.method(
    characterItemInstanceMutationService,
    'loadProjectedCharacterItemInstances',
    async () => ([
      {
        id: 201,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'cons-001',
        qty: 7,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 4,
        equipped_slot: null,
        strengthen_level: 0,
        refine_level: 0,
        socketed_gems: [],
        affixes: [],
        identified: true,
        locked: false,
        bind_type: 'none',
        bind_owner_user_id: null,
        bind_owner_character_id: null,
        random_seed: null,
        affix_gen_version: 0,
        affix_roll_meta: null,
        custom_name: null,
        expire_at: null,
        obtained_from: 'bag',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T10:00:00.000Z'),
      },
      {
        id: 202,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'cons-001',
        qty: 3,
        quality: 'rare',
        quality_rank: 2,
        metadata: null,
        location: 'bag',
        location_slot: 6,
        equipped_slot: null,
        strengthen_level: 0,
        refine_level: 0,
        socketed_gems: [],
        affixes: [],
        identified: true,
        locked: false,
        bind_type: 'none',
        bind_owner_user_id: null,
        bind_owner_character_id: null,
        random_seed: null,
        affix_gen_version: 0,
        affix_roll_meta: null,
        custom_name: null,
        expire_at: null,
        obtained_from: 'bag',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T10:00:00.000Z'),
      },
    ]),
  );

  const context = await createCharacterInventoryMutationContext([1]);

  assert.equal(context.getSlottedCapacity(1, 'bag'), 30);
  assert.deepEqual(
    context.getPlainAutoStackRows({
      characterId: 1,
      itemDefId: 'cons-001',
      location: 'bag',
      stackMax: 10,
      bindType: 'none',
    }),
    [{ id: 201, qty: 7 }],
  );
});
