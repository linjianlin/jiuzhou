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
      '施加虚蚀印记（每次+1层，上限5层，持续2回合）',
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
});
