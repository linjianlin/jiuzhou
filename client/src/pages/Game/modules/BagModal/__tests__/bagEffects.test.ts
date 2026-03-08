import { describe, expect, it } from 'vitest';
import { buildBagItem, formatBagItemEffectLine } from '../bagShared';

describe('bagEffects', () => {
  it('formatBagItemEffectLine: 生成功法书效果应映射为中文', () => {
    expect(
      formatBagItemEffectLine({
        trigger: 'use',
        target: 'self',
        effect_type: 'learn_generated_technique',
      }),
    ).toBe('学习功法');
  });

  it('formatBagItemEffectLine: 增益效果应复用中文属性文案', () => {
    expect(
      formatBagItemEffectLine({
        trigger: 'use',
        target: 'self',
        effect_type: 'buff',
        duration_round: 3,
        params: {
          attr_key: 'wugong',
          value: 10,
          apply_type: 'flat',
        },
      }),
    ).toBe('物攻 +10，持续 3 回合');
  });

  it('formatBagItemEffectLine: 随机宝石奖励应输出中文范围描述', () => {
    expect(
      formatBagItemEffectLine({
        trigger: 'use',
        target: 'self',
        effect_type: 'loot',
        params: {
          loot_type: 'random_gem',
          min_level: 1,
          max_level: 4,
          gems_per_use: 1,
        },
      }),
    ).toBe('随机获得1~4级宝石');
  });

  it('buildBagItem: 效果列表应走共享中文映射', () => {
    const bagItem = buildBagItem({
      id: 1,
      item_def_id: 'book-generated-technique',
      qty: 1,
      location: 'bag',
      location_slot: 1,
      equipped_slot: null,
      strengthen_level: 0,
      refine_level: 0,
      affixes: [],
      identified: false,
      locked: false,
      bind_type: 'none',
      created_at: '2026-03-08T00:00:00.000Z',
      def: {
        id: 'book-generated-technique',
        name: '《无名功法秘卷》',
        icon: '/assets/items/icon_bygj.png',
        quality: '玄',
        category: 'consumable',
        sub_category: 'technique_book',
        stack_max: 1,
        description: 'AI研修生成的功法秘卷，使用后学习对应功法',
        long_desc: '通过洞府研修推演而成的秘卷。',
        tags: ['秘籍', '功法', '研修生成'],
        effect_defs: [
          {
            trigger: 'use',
            target: 'self',
            effect_type: 'learn_generated_technique',
          },
        ],
        base_attrs: {},
        equip_slot: null,
        use_type: 'instant',
      },
    });

    expect(bagItem?.effects).toEqual(['学习功法']);
  });
});
