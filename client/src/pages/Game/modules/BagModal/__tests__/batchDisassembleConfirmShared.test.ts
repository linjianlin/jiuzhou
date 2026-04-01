import { describe, expect, it } from 'vitest';

import { buildBatchDisassembleConfirmViewModel } from '../batchDisassembleConfirmShared';
import type { BagItem } from '../bagShared';

const createBagItem = (overrides: Partial<BagItem>): BagItem => ({
  id: 1,
  itemDefId: 'item-1',
  learnableTechniqueId: null,
  name: '玄铁剑',
  category: 'equipment',
  subCategory: 'sword',
  canDisassemble: true,
  quality: '黄',
  tags: [],
  icon: '',
  qty: 1,
  stackMax: 1,
  bind: {
    type: 'none',
    tone: 'none',
    isBound: false,
    detailLabel: '未绑定',
    cellBadgeLabel: null,
  },
  location: 'bag',
  equippedSlot: null,
  locked: false,
  desc: '',
  effects: [],
  useTargetType: 'none',
  hasSocketEffect: false,
  actions: ['disassemble', 'show'],
  setInfo: null,
  equip: null,
  ...overrides,
});

describe('batchDisassembleConfirmShared', () => {
  it('应按首个出现顺序聚合同名物品数量', () => {
    const viewModel = buildBatchDisassembleConfirmViewModel([
      createBagItem({ id: 1, name: '玄铁剑', qty: 1 }),
      createBagItem({ id: 2, name: '凝霜甲', qty: 2 }),
      createBagItem({ id: 3, name: '玄铁剑', qty: 3 }),
    ]);

    expect(viewModel.title).toBe('确认分解以下物品？');
    expect(viewModel.summaryText).toBe('本次将分解 2 种物品，共 6 件。');
    expect(viewModel.entries).toEqual([
      { name: '玄铁剑', qty: 4, label: '玄铁剑×4' },
      { name: '凝霜甲', qty: 2, label: '凝霜甲×2' },
    ]);
  });

  it('单件物品应保留原名称，不追加数量后缀', () => {
    const viewModel = buildBatchDisassembleConfirmViewModel([
      createBagItem({ id: 1, name: '赤炎佩', qty: 1 }),
    ]);

    expect(viewModel.entries).toEqual([
      { name: '赤炎佩', qty: 1, label: '赤炎佩' },
    ]);
  });
});
