/**
 * 技能效果格式化回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证结构化 Buff 的特殊展示规则会通过统一格式化入口输出稳定文案，避免技能详情回退成原始 key 或错误数值。
 * 2) 不做什么：不覆盖技能卡布局、图标渲染或后端战斗结算，只锁定前端效果文本拼装。
 *
 * 输入/输出：
 * - 输入：技能 effects 数组中的结构化 Buff 对象。
 * - 输出：`formatSkillEffectLines` 返回的可展示文本数组。
 *
 * 数据流/状态流：
 * - 测试数据 -> `formatSkillEffectLines` -> Buff 特例规则表/通用格式化函数 -> 最终技能效果文案。
 *
 * 关键边界条件与坑点：
 * 1) `reflect_damage` 的 `value` 是比例值，展示时必须转成百分比，不能再被 `Math.floor` 截成 0。
 * 2) 技能详情需要展示语义化名称，不能把 `buff-reflect-damage` 这种内部 key 直接暴露给玩家。
 */

import { describe, expect, it } from 'vitest';
import { formatSkillEffectLines } from '../skillEffectFormatter';

describe('skillEffectFormatter', () => {
  it('应将 reflect_damage Buff 格式化为反震比例文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'buff',
        duration: 3,
        value: 0.3,
        buffKey: 'buff-reflect-damage',
        buffKind: 'reflect_damage',
      },
    ]);

    expect(lines).toEqual([
      '对自身施加增益：受击反震（反震本次实际受击伤害 30%），持续3回合',
    ]);
  });

  it('应在自增益 Buff 文案中标出施加给自身', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'buff',
        target: 'self',
        duration: 2,
        value: 0.15,
        buffKey: 'buff-zengshang-up',
        buffKind: 'attr',
        attrKey: 'zengshang',
        applyType: 'percent',
      },
    ]);

    expect(lines).toEqual([
      '对自身施加增益：增伤提升（幅度 15%），持续2回合',
    ]);
  });

  it('缺省目标的增益 Buff 文案应默认展示为施加给自身', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'buff',
        duration: 2,
        value: 0.15,
        buffKey: 'buff-zengshang-up',
        buffKind: 'attr',
        attrKey: 'zengshang',
        applyType: 'percent',
      },
    ]);

    expect(lines).toEqual([
      '对自身施加增益：增伤提升（幅度 15%），持续2回合',
    ]);
  });

  it('缺省目标的减益 Buff 文案应默认展示为施加给敌方目标', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'debuff',
        duration: 2,
        value: 0.2,
        buffKey: 'debuff-wufang-down',
        buffKind: 'attr',
        attrKey: 'wufang',
        applyType: 'percent',
      },
    ]);

    expect(lines).toEqual([
      '对敌方目标施加减益：物防降低（幅度 20%），持续2回合',
    ]);
  });

  it('伤害倍率描述不应再用括号包裹属性来源', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'damage',
        valueType: 'scale',
        scaleAttr: 'fagong',
        scaleRate: 1.2,
        damageType: 'magic',
        element: 'huo',
      },
    ]);

    expect(lines).toEqual([
      '造成 120% 法攻的火属性法术伤害',
    ]);
  });

  it('敌方指向技能里的缺省治疗文案应默认标记为对自身生效', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'heal',
        valueType: 'scale',
        scaleAttr: 'max_qixue',
        scaleRate: 0.3,
      },
    ], {
      targetType: 'single_enemy',
    });

    expect(lines).toEqual([
      '对自身恢复气血，倍率 30% 气血上限',
    ]);
  });

  it('显式指定 enemy 的治疗文案应标记为对敌方目标生效', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'heal',
        target: 'enemy',
        valueType: 'flat',
        value: 180,
      },
    ], {
      targetType: 'single_enemy',
    });

    expect(lines).toEqual([
      '对敌方目标恢复气血，固定 180',
    ]);
  });

  it('友方指向技能里的缺省治疗文案应继续跟随主目标', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'heal',
        valueType: 'scale',
        scaleAttr: 'fagong',
        scaleRate: 0.8,
      },
    ], {
      targetType: 'single_ally',
    });

    expect(lines).toEqual([
      '对友方目标恢复气血，倍率 80% 法攻',
    ]);
  });

  it('灼烧减益应直接展示倍率与属性来源，不再额外套括号', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'debuff',
        duration: 2,
        buffKey: 'debuff-burn',
        buffKind: 'dot',
        valueType: 'scale',
        scaleAttr: 'fagong',
        scaleRate: 0.3,
      },
    ]);

    expect(lines).toEqual([
      '对敌方目标施加减益：30% 法攻的灼烧效果，持续2回合',
    ]);
  });

  it('应将 mirror_crack 印记格式化为包含追击语义的中文文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'mark',
        operation: 'apply',
        markId: 'mirror_crack',
        maxStacks: 5,
        duration: 2,
      },
    ]);

    expect(lines).toEqual([
      '施加镜裂印（每次+1层，上限5层，不自动衰减；存在期间会放大后续镜律追击）',
    ]);
  });

  it('应将资源效果按技能目标类型格式化为明确的灵气调整文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'resource',
        resourceType: 'lingqi',
        value: 10,
      },
    ], {
      targetType: 'self',
    });

    expect(lines).toEqual([
      '调整自身灵气 +10',
    ]);
  });

  it('光环子效果展示时不应再带持续回合文案', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'buff',
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'self',
        auraEffects: [
          {
            type: 'buff',
            buffKind: 'attr',
            buffKey: 'buff-shanbi-up',
            attrKey: 'shanbi',
            applyType: 'percent',
            value: 0.2,
            duration: 2,
          },
        ],
      },
    ]);

    expect(lines).toEqual([
      '自身增益光环：闪避提升 20%',
    ]);
  });

  it('光环子效果中的属性 Buff 应展示中文属性名', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'buff',
        buffKind: 'aura',
        buffKey: 'buff-aura',
        auraTarget: 'all_ally',
        auraEffects: [
          {
            type: 'buff',
            buffKind: 'attr',
            buffKey: 'buff-zengshang-up',
            attrKey: 'zengshang',
            applyType: 'percent',
            value: 0.08,
          },
          {
            type: 'restore_lingqi',
            value: 4,
          },
        ],
      },
    ]);

    expect(lines).toEqual([
      '全体友方增益光环：增伤提升 8%；恢复灵气 4',
    ]);
  });

  it('减益光环详情不应误写成对自身施加减益', () => {
    const lines = formatSkillEffectLines([
      {
        type: 'debuff',
        target: 'self',
        buffKind: 'aura',
        buffKey: 'debuff-aura',
        auraTarget: 'all_enemy',
        auraEffects: [
          {
            type: 'debuff',
            buffKind: 'attr',
            buffKey: 'debuff-fagong-down',
            attrKey: 'fagong',
            applyType: 'percent',
            value: 0.12,
          },
        ],
      },
    ]);

    expect(lines).toEqual([
      '全体敌方减益光环：法攻降低 12%',
    ]);
  });
});
