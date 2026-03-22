/**
 * 玩家写回缓存测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定统一玩家写回缓存对角色字段和物品字段的 pending 覆盖行为，避免属性点、货币、装备状态在不同读取链路各写一套补丁逻辑。
 * 2. 做什么：锁定 flush 会把角色快照与物品快照批量写回 DB，并在成功后清空脏状态。
 * 3. 不做什么：不连接真实 Redis/数据库，不覆盖具体路由层与 Socket 事件参数解析。
 *
 * 输入/输出：
 * - 输入：角色基础行、物品基础行、pending 快照，以及模拟数据库 query 行为。
 * - 输出：覆盖后的读取结果、flush 期间发出的 SQL 调用。
 *
 * 数据流/状态流：
 * - 测试先写入 pending 角色/物品快照；
 * - 再调用共享覆盖入口验证立即可见；
 * - 最后调用 flush 验证脏数据落库并清空。
 *
 * 关键边界条件与坑点：
 * 1. 物品 pending 必须支持“删除后从读取结果中过滤掉”，否则材料扣成 0 或装备碎掉后仍会出现在背包里。
 * 2. flush 成功后必须清空 dirty 状态，否则同一批快照会在后续定时任务中重复落库。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

import * as database from '../../config/database.js';
import { closeRedis, redis } from '../../config/redis.js';
import {
  applyPendingCharacterWriteback,
  applyPendingInventoryItemWritebackRows,
  flushPlayerWritebackByCharacterId,
  getPendingInventoryItemState,
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
  queueInventoryItemWritebackSnapshot,
  resetPlayerWritebackStateForTests,
} from '../playerWritebackCacheService.js';
import { playerStateCharacterKey, playerStateInventoryKey } from '../playerStateKeys.js';

const createQueryResult = <TRow extends QueryResultRow>(rows: TRow[]): QueryResult<TRow> => {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  };
};

type SqlValue = boolean | Date | number | string | null;

type MockTransactionState = {
  clientId: number;
  depth: number;
  released: boolean;
  rollbackCause: null;
  rollbackOnly: boolean;
};

const isSqlConfigArg = (
  value: string | readonly SqlValue[] | { text: string } | undefined,
): value is { text: string } => {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'text' in value;
};

const createMockPoolClient = (
  handler: (sql: string, params?: readonly SqlValue[]) => Promise<QueryResult<QueryResultRow>>,
): PoolClient => {
  const txState: MockTransactionState = {
    clientId: 1,
    depth: 0,
    released: false,
    rollbackCause: null,
    rollbackOnly: false,
  };

  const client: Partial<PoolClient> & { __txState: MockTransactionState } = {
    __txState: txState,
    query: (async (...queryArgs: Array<string | readonly SqlValue[] | { text: string }>) => {
      const firstArg = queryArgs[0];
      const sql =
        typeof firstArg === 'string'
          ? firstArg
          : isSqlConfigArg(firstArg)
            ? firstArg.text
            : '';
      const secondArg = queryArgs[1];
      const params = Array.isArray(secondArg) ? (secondArg as readonly SqlValue[]) : undefined;

      if (sql === 'BEGIN') {
        txState.depth = 1;
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        txState.depth = 0;
      }
      return await handler(sql, params);
    }) as PoolClient['query'],
    release: () => undefined,
  };

  return client as PoolClient;
};

test.afterEach(() => {
  resetPlayerWritebackStateForTests();
});

test.after(async () => {
  await closeRedis();
  await database.pool.end();
});

test('applyPendingCharacterWriteback: 应优先返回 pending 角色快照字段', () => {
  queueCharacterWritebackSnapshot(88, {
    attribute_points: 7,
    jing: 11,
    qi: 22,
    shen: 33,
    silver: 456,
    spirit_stones: 789,
  });

  const row = applyPendingCharacterWriteback({
    id: 88,
    user_id: 1001,
    attribute_points: 1,
    jing: 2,
    qi: 3,
    shen: 4,
    silver: 5,
    spirit_stones: 6,
  });

  assert.deepEqual(row, {
    id: 88,
    user_id: 1001,
    attribute_points: 7,
    jing: 11,
    qi: 22,
    shen: 33,
    silver: 456,
    spirit_stones: 789,
  });
});

test('applyPendingInventoryItemWritebackRows: 应覆盖物品字段并过滤已删除物品', () => {
  queueInventoryItemWritebackSnapshot(
    88,
    {
      id: 501,
      owner_character_id: 88,
      item_def_id: 'mat-001',
      qty: 10,
      location: 'bag',
      location_slot: 2,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      affix_gen_version: 4,
    },
    {
      qty: 4,
      affixes: [{ key: 'crit', value: 18 }],
      affix_gen_version: 5,
    },
  );

  queueInventoryItemWritebackSnapshot(
    88,
    {
      id: 777,
      owner_character_id: 88,
      item_def_id: 'equip-001',
      qty: 1,
      location: 'equipped',
      location_slot: null,
      equipped_slot: 'weapon',
      strengthen_level: 12,
      refine_level: 4,
      affixes: [{ key: 'atk', value: 10 }],
      affix_gen_version: 4,
    },
    null,
  );

  const rows = applyPendingInventoryItemWritebackRows(88, [
    {
      id: 501,
      owner_character_id: 88,
      item_def_id: 'mat-001',
      qty: 10,
      location: 'bag',
      location_slot: 2,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      affix_gen_version: 4,
    },
    {
      id: 777,
      owner_character_id: 88,
      item_def_id: 'equip-001',
      qty: 1,
      location: 'equipped',
      location_slot: null,
      equipped_slot: 'weapon',
      strengthen_level: 12,
      refine_level: 4,
      affixes: [{ key: 'atk', value: 10 }],
      affix_gen_version: 4,
    },
  ]);

  assert.deepEqual(rows, [
    {
      id: 501,
      owner_character_id: 88,
      item_def_id: 'mat-001',
      qty: 4,
      location: 'bag',
      location_slot: 2,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [{ key: 'crit', value: 18 }],
      affix_gen_version: 5,
    },
  ]);
});

test('loadCharacterWritebackRowByCharacterId: 应把 Redis 角色整数数字串归一化为 number', async () => {
  const characterId = 18801;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1001,
      nickname: '修士甲',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: '789',
      silver: '456',
      stamina: '12',
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: '123',
      attribute_points: '4',
      jing: '11',
      qi: '22',
      shen: '33',
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  const row = await loadCharacterWritebackRowByCharacterId(characterId);

  assert.equal(row?.silver, 456);
  assert.equal(row?.spirit_stones, 789);
  assert.equal(row?.exp, 123);
  assert.equal(row?.attribute_points, 4);
  assert.equal(typeof row?.silver, 'number');

  await redis.del(playerStateCharacterKey(characterId));
});

test('loadCharacterWritebackRowByCharacterId: 遇到超出安全整数范围的角色字段应抛错', async () => {
  const characterId = 18802;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1002,
      nickname: '修士乙',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: 1,
      silver: '1355146241227134811981364',
      stamina: 12,
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: 123,
      attribute_points: 4,
      jing: 11,
      qi: 22,
      shen: 33,
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  await assert.rejects(
    () => loadCharacterWritebackRowByCharacterId(characterId),
    /silver/,
  );

  await redis.del(playerStateCharacterKey(characterId));
});

test('getPendingInventoryItemState: 应把 Redis 物品整数数字串归一化为 number', async () => {
  const characterId = 18803;
  const itemId = 9901;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1003,
      nickname: '修士丙',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: 1,
      silver: 1,
      stamina: 100,
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: 1,
      attribute_points: 0,
      jing: 1,
      qi: 1,
      shen: 1,
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  await redis.hset(
    playerStateInventoryKey(characterId),
    String(itemId),
    JSON.stringify({
      id: String(itemId),
      owner_user_id: '1003',
      owner_character_id: String(characterId),
      item_def_id: 'mat-001',
      qty: '12',
      locked: false,
      quality: null,
      quality_rank: '2',
      strengthen_level: '3',
      refine_level: '4',
      socketed_gems: [],
      affixes: [],
      affix_gen_version: '5',
      affix_roll_meta: {},
      identified: true,
      bind_type: null,
      bind_owner_user_id: '1003',
      bind_owner_character_id: String(characterId),
      location: 'bag',
      location_slot: '7',
      equipped_slot: null,
      random_seed: '123456',
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: {},
      created_at: null,
    }),
  );

  const state = await getPendingInventoryItemState(characterId, itemId);

  assert.equal(state?.base.qty, 12);
  assert.equal(state?.base.quality_rank, 2);
  assert.equal(state?.base.strengthen_level, 3);
  assert.equal(state?.base.random_seed, 123456);
  assert.equal(typeof state?.base.qty, 'number');

  await redis.del(playerStateCharacterKey(characterId));
  await redis.del(playerStateInventoryKey(characterId));
});

test('getPendingInventoryItemState: 遇到超出安全整数范围的物品字段应抛错', async () => {
  const characterId = 18804;
  const itemId = 9902;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1004,
      nickname: '修士丁',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: 1,
      silver: 1,
      stamina: 100,
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: 1,
      attribute_points: 0,
      jing: 1,
      qi: 1,
      shen: 1,
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  await redis.hset(
    playerStateInventoryKey(characterId),
    String(itemId),
    JSON.stringify({
      id: itemId,
      owner_user_id: 1004,
      owner_character_id: characterId,
      item_def_id: 'mat-002',
      qty: '1355146241227134811981364',
      locked: false,
      quality: null,
      quality_rank: null,
      strengthen_level: null,
      refine_level: null,
      socketed_gems: [],
      affixes: [],
      affix_gen_version: 1,
      affix_roll_meta: {},
      identified: true,
      bind_type: null,
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      location: 'bag',
      location_slot: null,
      equipped_slot: null,
      random_seed: null,
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: {},
      created_at: null,
    }),
  );

  await assert.rejects(
    () => getPendingInventoryItemState(characterId, itemId),
    /qty/,
  );

  await redis.del(playerStateCharacterKey(characterId));
  await redis.del(playerStateInventoryKey(characterId));
});

test('getPendingInventoryItemState: Redis 中 identified 为 null 时应归一化为 false', async () => {
  const characterId = 18805;
  const itemId = 9903;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1005,
      nickname: '修士戊',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: 1,
      silver: 1,
      stamina: 100,
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: 1,
      attribute_points: 0,
      jing: 1,
      qi: 1,
      shen: 1,
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  await redis.hset(
    playerStateInventoryKey(characterId),
    String(itemId),
    JSON.stringify({
      id: itemId,
      owner_user_id: 1005,
      owner_character_id: characterId,
      item_def_id: 'mat-003',
      qty: 3,
      locked: false,
      quality: null,
      quality_rank: null,
      strengthen_level: null,
      refine_level: null,
      socketed_gems: [],
      affixes: [],
      affix_gen_version: 1,
      affix_roll_meta: {},
      identified: null,
      bind_type: null,
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      location: 'bag',
      location_slot: 2,
      equipped_slot: null,
      random_seed: null,
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: {},
      created_at: null,
    }),
  );

  const state = await getPendingInventoryItemState(characterId, itemId);

  assert.equal(state?.base.identified, false);

  await redis.del(playerStateCharacterKey(characterId));
  await redis.del(playerStateInventoryKey(characterId));
});

test('getPendingInventoryItemState: Redis 中 affix_gen_version 为 null 时应归一化为 0', async () => {
  const characterId = 18806;
  const itemId = 9904;

  await redis.set(
    playerStateCharacterKey(characterId),
    JSON.stringify({
      id: characterId,
      user_id: 1006,
      nickname: '修士己',
      title: '散修',
      gender: 'male',
      avatar: null,
      auto_cast_skills: true,
      auto_disassemble_enabled: false,
      auto_disassemble_rules: [],
      dungeon_no_stamina_cost: false,
      spirit_stones: 1,
      silver: 1,
      stamina: 100,
      stamina_recover_at: null,
      realm: '凡人',
      sub_realm: null,
      exp: 1,
      attribute_points: 0,
      jing: 1,
      qi: 1,
      shen: 1,
      attribute_type: 'physical',
      attribute_element: 'none',
      current_map_id: 'starting_village',
      current_room_id: 'village_square',
      last_offline_at: null,
    }),
  );

  await redis.hset(
    playerStateInventoryKey(characterId),
    String(itemId),
    JSON.stringify({
      id: itemId,
      owner_user_id: 1006,
      owner_character_id: characterId,
      item_def_id: 'mat-004',
      qty: 2,
      locked: false,
      quality: null,
      quality_rank: null,
      strengthen_level: null,
      refine_level: null,
      socketed_gems: [],
      affixes: [],
      affix_gen_version: null,
      affix_roll_meta: {},
      identified: false,
      bind_type: null,
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      location: 'bag',
      location_slot: 3,
      equipped_slot: null,
      random_seed: null,
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: {},
      created_at: null,
    }),
  );

  const state = await getPendingInventoryItemState(characterId, itemId);

  assert.equal(state?.base.affix_gen_version, 0);

  await redis.del(playerStateCharacterKey(characterId));
  await redis.del(playerStateInventoryKey(characterId));
});

test('flushPlayerWritebackByCharacterId: 应写回角色与物品快照并清空脏状态', async (t) => {
  const sqlLog: string[] = [];

  t.mock.method(database.pool, 'connect', async () =>
    createMockPoolClient(async (sql) => {
      sqlLog.push(sql.replace(/\s+/g, ' ').trim());
      return createQueryResult([]);
    }),
  );

  queueCharacterWritebackSnapshot(99, {
    attribute_points: 3,
    jing: 9,
    qi: 8,
    shen: 7,
    silver: 666,
    spirit_stones: 888,
  });

  queueInventoryItemWritebackSnapshot(
    99,
    {
      id: 901,
      owner_character_id: 99,
      item_def_id: 'equip-901',
      qty: 1,
      location: 'equipped',
      location_slot: null,
      equipped_slot: 'weapon',
      strengthen_level: 10,
      refine_level: 2,
      affixes: [{ key: 'atk', value: 20 }],
      affix_gen_version: 4,
    },
    {
      strengthen_level: 11,
      refine_level: 3,
      affixes: [{ key: 'atk', value: 30 }],
      affix_gen_version: 5,
    },
  );

  queueInventoryItemWritebackSnapshot(
    99,
    {
      id: 902,
      owner_character_id: 99,
      item_def_id: 'mat-902',
      qty: 5,
      location: 'bag',
      location_slot: 7,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      affix_gen_version: 4,
    },
    null,
  );

  await flushPlayerWritebackByCharacterId(99);

  assert.equal(sqlLog[0], 'BEGIN');
  assert.equal(sqlLog[sqlLog.length - 1], 'COMMIT');
  assert.ok(sqlLog.some((sql) => /UPDATE characters SET/.test(sql)));
  assert.ok(sqlLog.some((sql) => /SELECT id, location, location_slot FROM item_instance/.test(sql)));
  assert.ok(sqlLog.some((sql) => /INSERT INTO item_instance/.test(sql)));
  assert.ok(sqlLog.some((sql) => /DELETE FROM item_instance/.test(sql)));

  const rowAfterFlush = applyPendingCharacterWriteback({
    id: 99,
    attribute_points: 1,
    jing: 1,
    qi: 1,
    shen: 1,
    silver: 1,
    spirit_stones: 1,
  });
  assert.deepEqual(rowAfterFlush, {
    id: 99,
    attribute_points: 1,
    jing: 1,
    qi: 1,
    shen: 1,
    silver: 1,
    spirit_stones: 1,
  });

  const itemsAfterFlush = applyPendingInventoryItemWritebackRows(99, [
    {
      id: 901,
      owner_character_id: 99,
      item_def_id: 'equip-901',
      qty: 1,
      location: 'equipped',
      location_slot: null,
      equipped_slot: 'weapon',
      strengthen_level: 10,
      refine_level: 2,
      affixes: [{ key: 'atk', value: 20 }],
      affix_gen_version: 4,
    },
  ]);
  assert.deepEqual(itemsAfterFlush, [
    {
      id: 901,
      owner_character_id: 99,
      item_def_id: 'equip-901',
      qty: 1,
      location: 'equipped',
      location_slot: null,
      equipped_slot: 'weapon',
      strengthen_level: 10,
      refine_level: 2,
      affixes: [{ key: 'atk', value: 20 }],
      affix_gen_version: 4,
    },
  ]);
});

test('flushPlayerWritebackByCharacterId: 交换背包槽位时应先腾空旧槽位再落最终状态', async (t) => {
  const sqlLog: string[] = [];

  type MockItemInstanceRow = {
    id: number;
    owner_user_id: number;
    owner_character_id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    quality: string | null;
    quality_rank: number | null;
    strengthen_level: number | null;
    refine_level: number | null;
    socketed_gems: string;
    affixes: string;
    affix_gen_version: number;
    affix_roll_meta: string;
    identified: boolean;
    bind_type: string | null;
    bind_owner_user_id: number | null;
    bind_owner_character_id: number | null;
    location: string;
    location_slot: number | null;
    equipped_slot: string | null;
    random_seed: number | null;
    custom_name: string | null;
    expire_at: string | null;
    obtained_from: string | null;
    obtained_ref_id: string | null;
    metadata: string;
    created_at: string | null;
  };

  const itemRows: MockItemInstanceRow[] = [
    {
      id: 1001,
      owner_user_id: 2001,
      owner_character_id: 199,
      item_def_id: 'mat-1001',
      qty: 1,
      locked: false,
      quality: null,
      quality_rank: null,
      strengthen_level: 0,
      refine_level: 0,
      socketed_gems: '[]',
      affixes: '[]',
      affix_gen_version: 1,
      affix_roll_meta: '{}',
      identified: true,
      bind_type: null,
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      location: 'bag',
      location_slot: 0,
      equipped_slot: null,
      random_seed: null,
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: '{}',
      created_at: null,
    },
    {
      id: 1002,
      owner_user_id: 2001,
      owner_character_id: 199,
      item_def_id: 'mat-1002',
      qty: 1,
      locked: false,
      quality: null,
      quality_rank: null,
      strengthen_level: 0,
      refine_level: 0,
      socketed_gems: '[]',
      affixes: '[]',
      affix_gen_version: 1,
      affix_roll_meta: '{}',
      identified: true,
      bind_type: null,
      bind_owner_user_id: null,
      bind_owner_character_id: null,
      location: 'bag',
      location_slot: 1,
      equipped_slot: null,
      random_seed: null,
      custom_name: null,
      expire_at: null,
      obtained_from: null,
      obtained_ref_id: null,
      metadata: '{}',
      created_at: null,
    },
  ];

  const buildCharacterRow = () => ({
    id: 199,
    user_id: 2001,
    nickname: '槽位交换测试',
    title: '散修',
    gender: 'male',
    avatar: null,
    auto_cast_skills: true,
    auto_disassemble_enabled: false,
    auto_disassemble_rules: [],
    dungeon_no_stamina_cost: false,
    spirit_stones: 1,
    silver: 2,
    stamina: 3,
    stamina_recover_at: null,
    realm: '凡人',
    sub_realm: null,
    exp: 4,
    attribute_points: 5,
    jing: 6,
    qi: 7,
    shen: 8,
    attribute_type: 'physical',
    attribute_element: 'none',
    current_map_id: 'starter',
    current_room_id: 'room-a',
    last_offline_at: null,
  });

  const findSlotOccupant = (
    ownerCharacterId: number,
    location: string,
    locationSlot: number,
    excludedId: number,
  ): MockItemInstanceRow | null => {
    return (
      itemRows.find((row) =>
        row.owner_character_id === ownerCharacterId &&
        row.location === location &&
        row.location_slot === locationSlot &&
        row.id !== excludedId,
      ) ?? null
    );
  };

  t.mock.method(database.pool, 'connect', async () =>
    createMockPoolClient(async (sql, params) => {
      const normalizedSql = sql.replace(/\s+/g, ' ').trim();
      sqlLog.push(normalizedSql);

      if (normalizedSql === 'BEGIN' || normalizedSql === 'COMMIT' || normalizedSql === 'ROLLBACK') {
        return createQueryResult([]);
      }

      if (normalizedSql.includes('FROM characters') && normalizedSql.includes('WHERE id = $1')) {
        return createQueryResult([buildCharacterRow()]);
      }

      if (normalizedSql.includes('SELECT * FROM item_instance WHERE owner_character_id = $1')) {
        return createQueryResult(itemRows.map((row) => ({ ...row })));
      }

      if (normalizedSql.includes('SELECT id, location, location_slot FROM item_instance WHERE owner_character_id = $1')) {
        return createQueryResult(
          itemRows.map((row) => ({
            id: row.id,
            location: row.location,
            location_slot: row.location_slot,
          })),
        );
      }

      if (normalizedSql.includes('UPDATE characters SET')) {
        return createQueryResult([]);
      }

      if (
        normalizedSql.includes('UPDATE item_instance') &&
        normalizedSql.includes('SET location_slot = NULL') &&
        normalizedSql.includes('WHERE owner_character_id = $1 AND id = $2')
      ) {
        const ownerCharacterId = Number(params?.[0]);
        const itemId = Number(params?.[1]);
        const target = itemRows.find((row) => row.owner_character_id === ownerCharacterId && row.id === itemId);
        assert.ok(target, `未找到待腾空槽位的物品: ${itemId}`);
        target.location_slot = null;
        return createQueryResult([]);
      }

      if (normalizedSql.includes('INSERT INTO item_instance')) {
        const columnMatches = normalizedSql.match(/INSERT INTO item_instance \((.+)\) VALUES/i);
        assert.ok(columnMatches, `未能解析物品写回列: ${normalizedSql}`);
        const columns = columnMatches[1]
          .split(',')
          .map((column) => column.trim())
          .filter((column) => column.length > 0);
        const rawParams = [...(params ?? [])];
        const nextRow = columns.reduce<Record<string, SqlValue>>((accumulator, column, index) => {
          accumulator[column] = rawParams[index] ?? null;
          return accumulator;
        }, {});

        const itemId = Number(nextRow.id);
        const ownerCharacterId = Number(nextRow.owner_character_id);
        const nextLocation = String(nextRow.location ?? '');
        const nextLocationSlotRaw = nextRow.location_slot;
        const nextLocationSlot =
          nextLocationSlotRaw === null || nextLocationSlotRaw === undefined
            ? null
            : Number(nextLocationSlotRaw);

        if (
          (nextLocation === 'bag' || nextLocation === 'warehouse') &&
          nextLocationSlot !== null
        ) {
          const occupant = findSlotOccupant(ownerCharacterId, nextLocation, nextLocationSlot, itemId);
          if (occupant) {
            const error = new Error('duplicate key value violates unique constraint "uq_item_instance_slot_occupied"');
            Object.assign(error, {
              code: '23505',
              detail: `Key (owner_character_id, location, location_slot)=(${ownerCharacterId}, ${nextLocation}, ${nextLocationSlot}) already exists.`,
              constraint: 'uq_item_instance_slot_occupied',
            });
            throw error;
          }
        }

        const target = itemRows.find((row) => row.id === itemId);
        if (target) {
          target.location = nextLocation;
          target.location_slot = nextLocationSlot;
          target.qty = Number(nextRow.qty);
          target.equipped_slot =
            nextRow.equipped_slot === null || nextRow.equipped_slot === undefined
              ? null
              : String(nextRow.equipped_slot);
          return createQueryResult([]);
        }

        itemRows.push({
          id: itemId,
          owner_user_id: Number(nextRow.owner_user_id),
          owner_character_id: ownerCharacterId,
          item_def_id: String(nextRow.item_def_id),
          qty: Number(nextRow.qty),
          locked: Boolean(nextRow.locked),
          quality: nextRow.quality === null ? null : String(nextRow.quality),
          quality_rank:
            nextRow.quality_rank === null || nextRow.quality_rank === undefined
              ? null
              : Number(nextRow.quality_rank),
          strengthen_level:
            nextRow.strengthen_level === null || nextRow.strengthen_level === undefined
              ? null
              : Number(nextRow.strengthen_level),
          refine_level:
            nextRow.refine_level === null || nextRow.refine_level === undefined
              ? null
              : Number(nextRow.refine_level),
          socketed_gems: String(nextRow.socketed_gems ?? '[]'),
          affixes: String(nextRow.affixes ?? '[]'),
          affix_gen_version:
            nextRow.affix_gen_version === null || nextRow.affix_gen_version === undefined
              ? 0
              : Number(nextRow.affix_gen_version),
          affix_roll_meta: String(nextRow.affix_roll_meta ?? '{}'),
          identified:
            nextRow.identified === null || nextRow.identified === undefined
              ? false
              : Boolean(nextRow.identified),
          bind_type: nextRow.bind_type === null ? null : String(nextRow.bind_type),
          bind_owner_user_id:
            nextRow.bind_owner_user_id === null || nextRow.bind_owner_user_id === undefined
              ? null
              : Number(nextRow.bind_owner_user_id),
          bind_owner_character_id:
            nextRow.bind_owner_character_id === null || nextRow.bind_owner_character_id === undefined
              ? null
              : Number(nextRow.bind_owner_character_id),
          location: nextLocation,
          location_slot: nextLocationSlot,
          equipped_slot:
            nextRow.equipped_slot === null || nextRow.equipped_slot === undefined
              ? null
              : String(nextRow.equipped_slot),
          random_seed:
            nextRow.random_seed === null || nextRow.random_seed === undefined
              ? null
              : Number(nextRow.random_seed),
          custom_name: nextRow.custom_name === null ? null : String(nextRow.custom_name),
          expire_at: nextRow.expire_at === null ? null : String(nextRow.expire_at),
          obtained_from: nextRow.obtained_from === null ? null : String(nextRow.obtained_from),
          obtained_ref_id: nextRow.obtained_ref_id === null ? null : String(nextRow.obtained_ref_id),
          metadata: String(nextRow.metadata ?? '{}'),
          created_at: nextRow.created_at === null ? null : String(nextRow.created_at),
        });
        return createQueryResult([]);
      }

      assert.fail(`未预期的 SQL: ${normalizedSql}`);
    }),
  );

  await queueInventoryItemWritebackSnapshot(
    199,
    {
      id: 1001,
      owner_user_id: 2001,
      owner_character_id: 199,
      item_def_id: 'mat-1001',
      qty: 1,
      location: 'bag',
      location_slot: 0,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      affix_gen_version: 1,
    },
    {
      location: 'bag',
      location_slot: 1,
    },
  );

  await queueInventoryItemWritebackSnapshot(
    199,
    {
      id: 1002,
      owner_user_id: 2001,
      owner_character_id: 199,
      item_def_id: 'mat-1002',
      qty: 1,
      location: 'bag',
      location_slot: 1,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      affix_gen_version: 1,
    },
    {
      location: 'bag',
      location_slot: 0,
    },
  );

  await flushPlayerWritebackByCharacterId(199);

  assert.deepEqual(
    itemRows
      .map((row) => ({ id: row.id, location: row.location, location_slot: row.location_slot }))
      .sort((left, right) => left.id - right.id),
    [
      { id: 1001, location: 'bag', location_slot: 1 },
      { id: 1002, location: 'bag', location_slot: 0 },
    ],
  );
  assert.ok(
    sqlLog.some((sql) => sql.includes('SET location_slot = NULL')),
    '交换槽位时应先执行腾空旧槽位的更新',
  );
});
