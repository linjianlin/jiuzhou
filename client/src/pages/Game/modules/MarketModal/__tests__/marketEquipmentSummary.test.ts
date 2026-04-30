import { describe, expect, it } from 'vitest';
import { buildMarketEquipmentSummary } from '../marketEquipmentSummaryData';

describe('marketEquipmentSummary', () => {
  it('装备应输出强化精炼与宝石数量摘要', () => {
    expect(
      buildMarketEquipmentSummary({
        category: 'equipment',
        strengthenLevel: 12,
        refineLevel: 4,
        socketedGems: JSON.stringify([
          {
            slot: 0,
            itemDefId: 'gem-atk-1',
            effects: [{ attrKey: 'wugong', value: 18, applyType: 'flat' }],
          },
          {
            slot: 1,
            itemDefId: 'gem-def-1',
            effects: [{ attrKey: 'wufang', value: 12, applyType: 'flat' }],
          },
        ]),
      }),
    ).toStrictEqual([
      { key: 'strengthen', text: '强化+12' },
      { key: 'refine', text: '精炼+4' },
      { key: 'gems', text: '宝石2' },
    ]);
  });

  it('数值为 0 的成长项不应显示在摘要里', () => {
    expect(
      buildMarketEquipmentSummary({
        category: 'equipment',
        strengthenLevel: 0,
        refineLevel: 4,
        socketedGems: JSON.stringify([
          {
            slot: 0,
            itemDefId: 'gem-survival-1',
            effects: [{ attrKey: 'max_qixue', value: 120, applyType: 'flat' }],
          },
        ]),
      }),
    ).toStrictEqual([
      { key: 'refine', text: '精炼+4' },
      { key: 'gems', text: '宝石1' },
    ]);
  });

  it('非装备物品不应输出摘要', () => {
    expect(
      buildMarketEquipmentSummary({
        category: 'material',
        strengthenLevel: 8,
        refineLevel: 3,
        socketedGems: null,
      }),
    ).toStrictEqual([]);
  });

  it('宝石数量应过滤无效结构后再统计', () => {
    expect(
      buildMarketEquipmentSummary({
        category: 'equipment',
        strengthenLevel: 0,
        refineLevel: 0,
        socketedGems: JSON.stringify([
          null,
          {
            slot: -1,
            itemDefId: 'bad-slot',
            effects: [{ attrKey: 'wugong', value: 10, applyType: 'flat' }],
          },
          {
            slot: 1,
            itemDefId: 'bad-empty-effects',
            effects: [],
          },
          {
            slot: 0,
            itemDefId: 'gem-survival-1',
            effects: [{ attrKey: 'max_qixue', value: 120, applyType: 'flat' }],
          },
        ]),
      }),
    ).toStrictEqual([{ key: 'gems', text: '宝石1' }]);
  });
});
