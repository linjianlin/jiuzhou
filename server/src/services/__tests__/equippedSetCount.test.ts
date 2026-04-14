/**
 * 已穿戴套装件数轻量查询回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证套装件数查询只依赖最小字段投影，也能正确反映 pending mutation 后的最终 equipped 集合。
 * 2. 做什么：锁住“移出 equipped / 移入 equipped / 删除 equipped”都会影响 `set_equipped_count`”这条边界。
 * 3. 不做什么：不覆盖完整背包列表富化，也不连接真实数据库或 Redis。
 *
 * 输入 / 输出：
 * - 输入：mock 的 item_instance 最小查询结果、pending mutations、静态 item def。
 * - 输出：`Map<setId, count>` 聚合结果。
 *
 * 数据流 / 状态流：
 * - 先伪造 equipped 最小底表行；
 * - 再注入 pending mutation 覆盖最终位置与 item_def_id；
 * - 最后断言套装件数只按最终 equipped 集合聚合。
 *
 * 关键边界条件与坑点：
 * 1. 被 mutation 移出 equipped 的底表行必须被剔除，否则件数会虚高。
 * 2. 新移入 equipped 的实例即使底表原本不在 equipped，也必须被计入件数。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as characterItemInstanceMutationService from '../shared/characterItemInstanceMutationService.js';
import * as inventoryHelpers from '../inventory/shared/helpers.js';
import { getEquippedSetPieceCountMap } from '../inventory/shared/equippedSetCount.js';

test('getEquippedSetPieceCountMap 应基于轻量 projected equipped 结果聚合套装件数', async (t) => {
  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    assert.match(sql, /SELECT id, item_def_id, location\s+FROM item_instance/);
    assert.deepEqual(params, [1, 'equipped']);
    return {
      rows: [
        { id: 101, item_def_id: 'equip-set-a-1', location: 'equipped' },
        { id: 102, item_def_id: 'equip-set-a-2', location: 'equipped' },
        { id: 103, item_def_id: 'equip-set-b-1', location: 'equipped' },
      ],
    };
  });

  t.mock.method(
    characterItemInstanceMutationService,
    'loadCharacterPendingItemInstanceMutations',
    async () => [],
  );

  t.mock.method(inventoryHelpers, 'getStaticItemDef', (itemDefId: string) => {
    if (itemDefId === 'equip-set-a-1' || itemDefId === 'equip-set-a-2') {
      return { set_id: 'set-a' };
    }
    if (itemDefId === 'equip-set-b-1') {
      return { set_id: 'set-b' };
    }
    return null;
  });

  const result = await getEquippedSetPieceCountMap(1);

  assert.equal(result.get('set-a'), 2);
  assert.equal(result.get('set-b'), 1);
});

test('getEquippedSetPieceCountMap 应按 pending mutation 的最终 equipped 集合聚合套装件数', async (t) => {
  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    assert.match(sql, /SELECT id, item_def_id, location\s+FROM item_instance/);
    assert.deepEqual(params, [1, 'equipped', ['101', '102', '201']]);
    return {
      rows: [
        { id: 101, item_def_id: 'equip-set-a-1', location: 'equipped' },
        { id: 102, item_def_id: 'equip-set-b-1', location: 'bag' },
      ],
    };
  });

  t.mock.method(inventoryHelpers, 'getStaticItemDef', (itemDefId: string) => {
    if (itemDefId === 'equip-set-a-1' || itemDefId === 'equip-set-a-2') {
      return { set_id: 'set-a' };
    }
    if (itemDefId === 'equip-set-b-1') {
      return { set_id: 'set-b' };
    }
    return null;
  });

  const pendingMutations: characterItemInstanceMutationService.BufferedCharacterItemInstanceMutation[] = [
    {
      opId: 'move-out:101',
      characterId: 1,
      itemId: 101,
      createdAt: 1,
      kind: 'upsert',
      snapshot: {
        id: 101,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-set-a-1',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 3,
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
        created_at: new Date('2026-04-14T00:00:00.000Z'),
      },
    },
    {
      opId: 'move-in:102',
      characterId: 1,
      itemId: 102,
      createdAt: 2,
      kind: 'upsert',
      snapshot: {
        id: 102,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-set-b-1',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'equipped',
        location_slot: null,
        equipped_slot: 'weapon',
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
        obtained_from: 'equip',
        obtained_ref_id: null,
        created_at: new Date('2026-04-14T00:00:01.000Z'),
      },
    },
    {
      opId: 'add-equipped:201',
      characterId: 1,
      itemId: 201,
      createdAt: 3,
      kind: 'upsert',
      snapshot: {
        id: 201,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-set-a-2',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'equipped',
        location_slot: null,
        equipped_slot: 'helmet',
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
        obtained_from: 'equip',
        obtained_ref_id: null,
        created_at: new Date('2026-04-14T00:00:02.000Z'),
      },
    },
  ];

  const result = await getEquippedSetPieceCountMap(1, undefined, {
    pendingMutations,
  });

  assert.equal(result.get('set-a'), 1);
  assert.equal(result.get('set-b'), 1);
  assert.equal(result.size, 2);
});
