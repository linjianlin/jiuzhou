import { describe, expect, it } from 'vitest';
import { formatSkillEffectLines } from '../skillEffectFormatter';
import { formatSetEffectLine } from '../BagModal/bagShared';

describe('mark 文案格式化', () => {
  it('技能入口应稳定输出 mark:apply 文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'apply',
        markId: 'void_erosion',
        maxStacks: 5,
        duration: 2,
      },
    ]);

    expect(lines).toEqual([
      '施加虚蚀印记（每次+1层，上限5层，不自动衰减；同源层数额外提升伤害）',
    ]);
  });

  it('技能入口应稳定输出 mark:consume 文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'consume',
        markId: 'void_erosion',
        consumeMode: 'fixed',
        consumeStacks: 2,
        perStackRate: 0.92,
        resultType: 'shield_self',
      },
    ]);

    expect(lines).toEqual([
      '消耗虚蚀印记（固定2层，每层系数92%），转化为自身护盾',
    ]);
  });

  it('技能入口应将 moon_echo 统一展示为月痕印记', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'apply',
        markId: 'moon_echo',
        maxStacks: 3,
        duration: 2,
      },
    ]);

    expect(lines).toEqual([
      '施加月痕印记（每次+1层，上限3层，不自动衰减；被消耗时返还灵气并强化下一次技能）',
    ]);
  });

  it('技能入口应为灼痕与蚀心锁展示各自语义', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'apply',
        markId: 'ember_brand',
        maxStacks: 4,
        duration: 2,
      },
      {
        type: 'mark',
        operation: 'apply',
        markId: 'soul_shackle',
        maxStacks: 5,
        duration: 2,
      },
    ]);

    expect(lines).toEqual([
      '施加灼痕（每次+1层，上限4层，不自动衰减；被消耗时附加灼烧与余烬潜爆）',
      '施加蚀心锁（每次+1层，上限5层，不自动衰减；压低受疗与回灵效率，消耗时抽取灵气）',
    ]);
  });

  it('技能入口应为各印记 consume 文案展示新增联动', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'consume',
        markId: 'ember_brand',
        consumeMode: 'all',
        perStackRate: 1.1,
        resultType: 'damage',
      },
      {
        type: 'mark',
        operation: 'consume',
        markId: 'soul_shackle',
        consumeMode: 'fixed',
        consumeStacks: 2,
        perStackRate: 0.8,
        resultType: 'damage',
      },
      {
        type: 'mark',
        operation: 'consume',
        markId: 'moon_echo',
        consumeMode: 'all',
        perStackRate: 1,
        resultType: 'damage',
      },
    ]);

    expect(lines).toEqual([
      '消耗灼痕（全部层数，每层系数110%），转化为伤害，并附加灼烧与余烬潜爆',
      '消耗蚀心锁（固定2层，每层系数80%），转化为伤害，并抽取灵气',
      '消耗月痕印记（全部层数，每层系数100%），转化为伤害，并返还灵气、强化下一次技能',
    ]);
  });

  it('套装入口应稳定输出 snake_case mark 文案与触发前缀', () => {
    const line = formatSetEffectLine({
      trigger: 'on_be_hit',
      effect_type: 'mark',
      duration_round: 2,
      params: {
        operation: 'consume',
        mark_id: 'void_erosion',
        consume_mode: 'fixed',
        consume_stacks: 2,
        per_stack_rate: 0.95,
        result_type: 'shield_self',
        chance: 0.45,
      },
    });

    expect(line).toBe(
      '触发：受击，消耗虚蚀印记（固定2层，每层系数95%），转化为自身护盾，概率 45%，持续 2 回合',
    );
  });

  it('套装入口应将 damage_echo 护盾展示为受击伤害比例文案', () => {
    const line = formatSetEffectLine({
      trigger: 'on_be_hit',
      effect_type: 'shield',
      duration_round: 2,
      params: {
        shield_mode: 'damage_echo',
        value: 0.42,
        chance: 0.35,
      },
    });

    expect(line).toBe(
      '触发：受击，获得相当于本次受击伤害42%的护盾，概率 35%，持续 2 回合',
    );
  });

  it('套装入口应将 echo 伤害展示为命中伤害比例文案', () => {
    const line = formatSetEffectLine({
      trigger: 'on_skill',
      effect_type: 'damage',
      params: {
        damage_type: 'echo',
        value: 0.26,
        chance: 0.32,
      },
    });

    expect(line).toBe(
      '触发：施法，追加本次命中伤害26%的真伤，概率 32%',
    );
  });
});
