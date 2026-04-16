import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildItemInstanceMutationFlushPlan,
  collapseBufferedCharacterItemInstanceMutations,
  resolveItemInstanceFlushInput,
  type BufferedCharacterItemInstanceMutation,
} from '../shared/characterItemInstanceMutationService.js';

const buildMutation = (overrides: Partial<BufferedCharacterItemInstanceMutation> & Pick<BufferedCharacterItemInstanceMutation, 'itemId' | 'characterId' | 'opId' | 'createdAt' | 'kind'>): BufferedCharacterItemInstanceMutation => ({
  snapshot: null,
  ...overrides,
});

const DEFAULT_CAPACITIES = {
  bagCapacity: 200,
  warehouseCapacity: 1000,
};

test('flush plan 应先释放将被其他实例占用的旧槽位', () => {
  const plan = buildItemInstanceMutationFlushPlan(
    [
      { id: 10, owner_character_id: 1, location: 'bag', location_slot: 1 },
      { id: 11, owner_character_id: 1, location: 'mail', location_slot: null },
    ],
    [
      buildMutation({ itemId: 11, characterId: 1, opId: 'm1', createdAt: 1, kind: 'upsert', snapshot: {
        id: 11,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 10, characterId: 1, opId: 'm2', createdAt: 2, kind: 'delete' }),
    ],
  );

  assert.deepEqual(plan.slotReleaseItemIds, [10]);
  assert.deepEqual(plan.duplicateTargetKeys, []);
});

test('flush plan 应识别两个不同实例最终写入同一槽位的冲突', () => {
  const plan = buildItemInstanceMutationFlushPlan(
    [],
    [
      buildMutation({ itemId: 21, characterId: 1, opId: 'a', createdAt: 1, kind: 'upsert', snapshot: {
        id: 21,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 22, characterId: 1, opId: 'b', createdAt: 2, kind: 'upsert', snapshot: {
        id: 22,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.deepEqual(plan.slotReleaseItemIds, []);
  assert.deepEqual(plan.duplicateTargetKeys, ['1:bag:1']);
});

test('flush 应只保留同一实例的最终 mutation，避免执行过期槽位状态', () => {
  const collapsed = collapseBufferedCharacterItemInstanceMutations([
    buildMutation({ itemId: 31, characterId: 1, opId: 'old', createdAt: 1, kind: 'upsert', snapshot: {
      id: 31,
      owner_user_id: 1,
      owner_character_id: 1,
      item_def_id: 'equip-weapon-001',
      qty: 1,
      quality: null,
      quality_rank: null,
      metadata: null,
      location: 'bag',
      location_slot: 1,
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
      obtained_from: 'mail',
      obtained_ref_id: null,
      created_at: new Date('2026-04-08T09:00:00.000Z'),
    } }),
    buildMutation({ itemId: 31, characterId: 1, opId: 'new', createdAt: 2, kind: 'upsert', snapshot: {
      id: 31,
      owner_user_id: 1,
      owner_character_id: 1,
      item_def_id: 'equip-weapon-001',
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
      obtained_from: 'mail',
      obtained_ref_id: null,
      created_at: new Date('2026-04-08T09:00:00.000Z'),
    } }),
  ]);

  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]?.snapshot?.location_slot, 2);
});

test('flush plan 应识别目标槽位与未改动旧实例的直接冲突', () => {
  const plan = buildItemInstanceMutationFlushPlan(
    [
      { id: 40, owner_character_id: 1, location: 'bag', location_slot: 1 },
    ],
    [
      buildMutation({ itemId: 41, characterId: 1, opId: 'm1', createdAt: 1, kind: 'upsert', snapshot: {
        id: 41,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.deepEqual(plan.duplicateTargetKeys, ['1:bag:1']);
});

test('flush plan 应允许同一批 mutation 完成整包换位', () => {
  const plan = buildItemInstanceMutationFlushPlan(
    [
      { id: 101, owner_character_id: 1, location: 'bag', location_slot: 0 },
      { id: 102, owner_character_id: 1, location: 'bag', location_slot: 1 },
      { id: 103, owner_character_id: 1, location: 'bag', location_slot: 2 },
    ],
    [
      buildMutation({ itemId: 101, characterId: 1, opId: 'sort-a', createdAt: 1, kind: 'upsert', snapshot: {
        id: 101,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 102, characterId: 1, opId: 'sort-b', createdAt: 2, kind: 'upsert', snapshot: {
        id: 102,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
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
        obtained_from: 'bag',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 103, characterId: 1, opId: 'sort-c', createdAt: 3, kind: 'upsert', snapshot: {
        id: 103,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-003',
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
        obtained_from: 'bag',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.deepEqual(plan.slotReleaseItemIds, [101, 102, 103]);
  assert.deepEqual(plan.duplicateTargetKeys, []);
});

test('flush 应在整理快照与当前库存冲突时丢弃 sort-inventory mutation', () => {
  const resolved = resolveItemInstanceFlushInput(
    [
      { id: 301, owner_character_id: 1, location: 'bag', location_slot: 0 },
      { id: 302, owner_character_id: 1, location: 'bag', location_slot: 1 },
    ],
    DEFAULT_CAPACITIES,
    [
      buildMutation({ itemId: 301, characterId: 1, opId: 'sort-inventory:1:100:0', createdAt: 100, kind: 'upsert', snapshot: {
        id: 301,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 1,
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
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.droppedSortInventoryMutations, true);
  assert.deepEqual(resolved.effectiveMutations, []);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 应在同槽存在非 sort upsert 时保留非 sort 并裁掉 sort', () => {
  const resolved = resolveItemInstanceFlushInput(
    [],
    DEFAULT_CAPACITIES,
    [
      buildMutation({ itemId: 401, characterId: 1, opId: 'sort-inventory:401:100:0', createdAt: 100, kind: 'upsert', snapshot: {
        id: 401,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 402, characterId: 1, opId: 'move-item:402:200:0', createdAt: 200, kind: 'upsert', snapshot: {
        id: 402,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.droppedSortInventoryMutations, true);
  assert.equal(resolved.effectiveMutations.length, 1);
  assert.equal(resolved.effectiveMutations[0]?.itemId, 402);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 遇到两个非 sort upsert 同槽时应只保留最新 mutation', () => {
  const resolved = resolveItemInstanceFlushInput(
    [],
    DEFAULT_CAPACITIES,
    [
      buildMutation({ itemId: 501, characterId: 1, opId: 'move-item:501:100:0', createdAt: 100, kind: 'upsert', snapshot: {
        id: 501,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 502, characterId: 1, opId: 'grant-item:502:200:0', createdAt: 200, kind: 'upsert', snapshot: {
        id: 502,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        obtained_from: 'grant',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.droppedSortInventoryMutations, false);
  assert.equal(resolved.effectiveMutations.length, 1);
  assert.equal(resolved.effectiveMutations[0]?.itemId, 502);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 裁掉旧的非 sort 同槽 mutation 后若仍撞上现有库存则继续报冲突', () => {
  const resolved = resolveItemInstanceFlushInput(
    [
      { id: 900, owner_character_id: 1, location: 'bag', location_slot: 11 },
    ],
    DEFAULT_CAPACITIES,
    [
      buildMutation({ itemId: 501, characterId: 1, opId: 'move-item:501:100:0', createdAt: 100, kind: 'upsert', snapshot: {
        id: 501,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        obtained_from: 'mail',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 502, characterId: 1, opId: 'grant-item:502:200:0', createdAt: 200, kind: 'upsert', snapshot: {
        id: 502,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        obtained_from: 'grant',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.droppedSortInventoryMutations, false);
  assert.equal(resolved.effectiveMutations.length, 2);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, ['1:bag:11']);
});

test('flush plan 应把数据库字符串 id 视为同一实例的原地更新', () => {
  const resolved = resolveItemInstanceFlushInput(
    [
      { id: '21', owner_character_id: '1', location: 'bag', location_slot: '11' },
    ],
    DEFAULT_CAPACITIES,
    [
      buildMutation({ itemId: 21, characterId: 1, opId: 'consume-item-instance:21:100:0', createdAt: 100, kind: 'upsert', snapshot: {
        id: 21,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'mat-gongfa-canye',
        qty: 9666,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: 11,
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
        affix_gen_version: 1,
        affix_roll_meta: null,
        custom_name: null,
        expire_at: null,
        obtained_from: 'technique_research_refund:gen-mmivgme6-a2ec790f',
        obtained_ref_id: null,
        created_at: new Date('2026-03-10T08:02:58.186Z'),
      } }),
    ],
  );

  assert.equal(resolved.droppedSortInventoryMutations, false);
  assert.deepEqual(resolved.flushPlan.slotReleaseItemIds, []);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 应为 auto bag mutation 自动分配避开数据库占槽的最终槽位', () => {
  const resolved = resolveItemInstanceFlushInput(
    [
      { id: 800, owner_character_id: 1, location: 'bag', location_slot: 0 },
      { id: 801, owner_character_id: 1, location: 'bag', location_slot: 1 },
    ],
    { bagCapacity: 4, warehouseCapacity: 1000 },
    [
      buildMutation({ itemId: 900, characterId: 1, opId: 'equipment-create:900:100', createdAt: 100, kind: 'upsert', slotResolution: { mode: 'auto' }, snapshot: {
        id: 900,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: null,
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
        obtained_from: 'battle_drop',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.missingAutoSlotItemIds.length, 0);
  assert.equal(resolved.effectiveMutations[0]?.snapshot?.location_slot, 2);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 应兼容旧格式 battle_drop equipment-create mutation 的自动槽位分配', () => {
  const resolved = resolveItemInstanceFlushInput(
    [
      { id: 850, owner_character_id: 1, location: 'bag', location_slot: 0 },
      { id: 851, owner_character_id: 1, location: 'bag', location_slot: 1 },
    ],
    { bagCapacity: 4, warehouseCapacity: 1000 },
    [
      buildMutation({ itemId: 901, characterId: 1, opId: 'equipment-create:901:100', createdAt: 100, kind: 'upsert', snapshot: {
        id: 901,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
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
        obtained_from: 'battle_drop',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.missingAutoSlotItemIds.length, 0);
  assert.equal(resolved.effectiveMutations[0]?.slotResolution?.mode, 'auto');
  assert.equal(resolved.effectiveMutations[0]?.snapshot?.location_slot, 2);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});

test('flush 应让 explicit 槽位优先，auto 槽位自动避开 explicit 目标', () => {
  const resolved = resolveItemInstanceFlushInput(
    [],
    { bagCapacity: 4, warehouseCapacity: 1000 },
    [
      buildMutation({ itemId: 910, characterId: 1, opId: 'move-item:910:100', createdAt: 100, kind: 'upsert', snapshot: {
        id: 910,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-001',
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
        obtained_from: 'move',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
      buildMutation({ itemId: 911, characterId: 1, opId: 'equipment-create:911:200', createdAt: 200, kind: 'upsert', slotResolution: { mode: 'auto' }, snapshot: {
        id: 911,
        owner_user_id: 1,
        owner_character_id: 1,
        item_def_id: 'equip-weapon-002',
        qty: 1,
        quality: null,
        quality_rank: null,
        metadata: null,
        location: 'bag',
        location_slot: null,
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
        obtained_from: 'battle_drop',
        obtained_ref_id: null,
        created_at: new Date('2026-04-08T09:00:00.000Z'),
      } }),
    ],
  );

  assert.equal(resolved.effectiveMutations[0]?.snapshot?.location_slot, 0);
  assert.equal(resolved.effectiveMutations[1]?.snapshot?.location_slot, 1);
  assert.deepEqual(resolved.flushPlan.duplicateTargetKeys, []);
});
