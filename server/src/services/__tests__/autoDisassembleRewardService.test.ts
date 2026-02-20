import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grantRewardItemWithAutoDisassemble,
  type GrantItemCreateFn,
  type GrantItemCreateResult,
} from '../autoDisassembleRewardService.js';

type CreateCall = Parameters<GrantItemCreateFn>[0];

const createCreateItemMock = (
  queue: GrantItemCreateResult[]
): { calls: CreateCall[]; fn: GrantItemCreateFn } => {
  const calls: CreateCall[] = [];
  const fn: GrantItemCreateFn = async (params) => {
    calls.push(params);
    const next = queue.shift();
    assert.ok(next, `createItem调用次数超出预期: ${JSON.stringify(params)}`);
    return next;
  };
  return { calls, fn };
};

test('命中自动分解时应发放分解材料', async () => {
  const { calls, fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [101],
      equipment: { qualityRank: 1 },
    },
    {
      success: true,
      message: 'ok',
      itemIds: [201],
    },
  ]);
  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 88,
    itemDefId: 'equip-weapon-001',
    qty: 1,
    itemMeta: { itemName: '青锋剑', category: 'equipment', qualityRank: 1 },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['equipment'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 2,
        },
      ],
    },
    sourceObtainedFrom: 'dungeon_clear_reward',
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.pendingMailItems, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'enhance-001', qty: 1, itemIds: [201] }]);
  assert.equal(result.gainedSilver, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.itemDefId, 'equip-weapon-001');
  assert.equal(calls[0]?.obtainedFrom, 'dungeon_clear_reward');
  assert.equal(calls[1]?.itemDefId, 'enhance-001');
  assert.equal(calls[1]?.obtainedFrom, 'auto_disassemble');
});

test('分解材料入包失败且背包满时应走邮件补发', async () => {
  const { fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [102],
      equipment: { qualityRank: 2 },
    },
    {
      success: false,
      message: '背包已满',
    },
  ]);
  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 99,
    itemDefId: 'equip-armor-001',
    qty: 1,
    itemMeta: { itemName: '护心甲', category: 'equipment', qualityRank: 2 },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['equipment'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 2,
        },
      ],
    },
    sourceObtainedFrom: 'dungeon_clear_reward',
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'enhance-001', qty: 1, itemIds: [] }]);
  assert.deepEqual(result.pendingMailItems, [{ item_def_id: 'enhance-001', qty: 1 }]);
  assert.equal(result.gainedSilver, 0);
});

test('未开启自动分解时应保持原奖励逻辑', async () => {
  const { calls, fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [501, 502],
      equipment: { qualityRank: 1 },
    },
  ]);

  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 77,
    itemDefId: 'equip-ring-001',
    qty: 2,
    bindType: 'bound',
    itemMeta: { itemName: '玉戒', category: 'equipment', qualityRank: 1 },
    autoDisassembleSetting: {
      enabled: false,
      rules: [
        {
          categories: ['equipment'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 4,
        },
      ],
    },
    sourceObtainedFrom: 'dungeon_clear_reward',
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.pendingMailItems, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'equip-ring-001', qty: 2, itemIds: [501, 502] }]);
  assert.equal(result.gainedSilver, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.qty, 2);
  assert.equal(calls[0]?.bindType, 'bound');
});

test('品质超过阈值时应保留原装备', async () => {
  const { calls, fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [303],
      equipment: { qualityRank: 4 },
    },
  ]);
  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 66,
    itemDefId: 'equip-necklace-001',
    qty: 1,
    itemMeta: { itemName: '龙纹项链', category: 'equipment', qualityRank: 4 },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['equipment'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 2,
        },
      ],
    },
    sourceObtainedFrom: 'dungeon_clear_reward',
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.pendingMailItems, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'equip-necklace-001', qty: 1, itemIds: [303] }]);
  assert.equal(result.gainedSilver, 0);
  assert.equal(calls.length, 1);
});

test('原装备入包失败且背包满时应补发原装备邮件', async () => {
  const { fn } = createCreateItemMock([
    {
      success: false,
      message: '背包已满',
    },
  ]);

  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 100,
    itemDefId: 'equip-legs-001',
    qty: 1,
    bindType: 'bound',
    itemMeta: { itemName: '玄铁护腿', category: 'equipment', qualityRank: 1 },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['equipment'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 4,
        },
      ],
    },
    sourceObtainedFrom: 'dungeon_clear_reward',
    sourceEquipOptions: { yellow: 70, purple: 30 },
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'equip-legs-001', qty: 1, itemIds: [] }]);
  assert.deepEqual(result.pendingMailItems, [
    {
      item_def_id: 'equip-legs-001',
      qty: 1,
      options: {
        bindType: 'bound',
        equipOptions: { yellow: 70, purple: 30 },
      },
    },
  ]);
  assert.equal(result.gainedSilver, 0);
});

test('非装备命中规则时应按默认公式转化银两', async () => {
  const { fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [701],
    },
  ]);
  const silverCalls: number[] = [];

  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 108,
    itemDefId: 'mat-herb-001',
    qty: 1,
    itemMeta: { itemName: '凝气草', category: 'material', qualityRank: 2 },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['material'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 3,
        },
      ],
    },
    sourceObtainedFrom: 'battle_drop',
    createItem: fn,
    addSilver: async (_characterId, silver) => {
      silverCalls.push(silver);
      return { success: true, message: 'ok' };
    },
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.grantedItems, []);
  assert.deepEqual(result.pendingMailItems, []);
  assert.equal(result.gainedSilver, 3);
  assert.deepEqual(silverCalls, [3]);
});

test('功法书规则应命中consumable+technique_book物品并转化为功法残页', async () => {
  const { calls, fn } = createCreateItemMock([
    {
      success: true,
      message: 'ok',
      itemIds: [801],
    },
  ]);

  const result = await grantRewardItemWithAutoDisassemble({
    characterId: 128,
    itemDefId: 'book-jichu-quanfa',
    qty: 1,
    itemMeta: {
      itemName: '《基础拳法》',
      category: 'consumable',
      subCategory: 'technique_book',
      qualityRank: 1,
    },
    autoDisassembleSetting: {
      enabled: true,
      rules: [
        {
          categories: ['skillbook'],
          subCategories: [],
          excludedSubCategories: [],
          includeNameKeywords: [],
          excludeNameKeywords: [],
          maxQualityRank: 4,
        },
      ],
    },
    sourceObtainedFrom: 'battle_drop',
    createItem: fn,
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.pendingMailItems, []);
  assert.deepEqual(result.grantedItems, [{ itemDefId: 'mat-gongfa-canye', qty: 2, itemIds: [801] }]);
  assert.equal(result.gainedSilver, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.itemDefId, 'mat-gongfa-canye');
});
