import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalItemInstanceMutationHash,
  buildItemInstanceIdArrayParam,
  buildItemInstanceMutationHashField,
  pruneSlotConflictingSortInventoryMutations,
  pruneStaleSortInventoryMutations,
  type BufferedCharacterItemInstanceMutation,
} from '../shared/characterItemInstanceMutationService.js';

test('实例 mutation 查询参数应保留 bigint 安全范围内的大 item id', () => {
  const result = buildItemInstanceIdArrayParam([
    3720829880934400,
    3720829880934400,
    42,
  ]);

  assert.deepEqual(result, ['3720829880934400', '42']);
});

test('实例 mutation hash field 应按 itemId 稳定覆盖', () => {
  assert.equal(buildItemInstanceMutationHashField(3720829880934400), '3720829880934400');
});

test('legacy mutation hash 应按 item 级最终态收敛', () => {
  const buildMutation = (overrides: Partial<BufferedCharacterItemInstanceMutation> & Pick<BufferedCharacterItemInstanceMutation, 'itemId' | 'characterId' | 'opId' | 'createdAt' | 'kind'>): BufferedCharacterItemInstanceMutation => ({
    snapshot: null,
    ...overrides,
  });

  const canonicalHash = buildCanonicalItemInstanceMutationHash([
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
    buildMutation({ itemId: 31, characterId: 1, opId: 'new', createdAt: 2, kind: 'delete' }),
  ]);

  assert.deepEqual(Object.keys(canonicalHash), ['31']);
  assert.match(canonicalHash['31'] ?? '', /"kind":"delete"/);
});

test('晚于 sort-inventory 的其他 mutation 出现后，应剔除过期整理快照', () => {
  const buildMutation = (overrides: Partial<BufferedCharacterItemInstanceMutation> & Pick<BufferedCharacterItemInstanceMutation, 'itemId' | 'characterId' | 'opId' | 'createdAt' | 'kind'>): BufferedCharacterItemInstanceMutation => ({
    snapshot: null,
    ...overrides,
  });

  const mutations = pruneStaleSortInventoryMutations([
    buildMutation({ itemId: 1, characterId: 1, opId: 'sort-inventory:1:100:0', createdAt: 100, kind: 'upsert', snapshot: {
      id: 1,
      owner_user_id: 1,
      owner_character_id: 1,
      item_def_id: 'cons-monthcard-001',
      qty: 1,
      quality: null,
      quality_rank: null,
      metadata: null,
      location: 'bag',
      location_slot: 96,
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
    buildMutation({ itemId: 1, characterId: 1, opId: 'consume-item-instance:1:200:0', createdAt: 200, kind: 'delete' }),
  ]);

  assert.equal(mutations.length, 1);
  assert.equal(mutations[0]?.opId, 'consume-item-instance:1:200:0');
});

test('同槽存在非 sort upsert 时，应裁掉同槽 sort-inventory mutation', () => {
  const buildMutation = (overrides: Partial<BufferedCharacterItemInstanceMutation> & Pick<BufferedCharacterItemInstanceMutation, 'itemId' | 'characterId' | 'opId' | 'createdAt' | 'kind'>): BufferedCharacterItemInstanceMutation => ({
    snapshot: null,
    ...overrides,
  });

  const normalized = pruneSlotConflictingSortInventoryMutations([
    buildMutation({ itemId: 1, characterId: 1, opId: 'sort-inventory:1:100:0', createdAt: 100, kind: 'upsert', snapshot: {
      id: 1,
      owner_user_id: 1,
      owner_character_id: 1,
      item_def_id: 'cons-monthcard-001',
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
    buildMutation({ itemId: 2, characterId: 1, opId: 'move-item:2:200:0', createdAt: 200, kind: 'upsert', snapshot: {
      id: 2,
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
  ]);

  assert.equal(normalized.droppedSortInventoryMutations, true);
  assert.equal(normalized.mutations.length, 1);
  assert.equal(normalized.mutations[0]?.opId, 'move-item:2:200:0');
});
