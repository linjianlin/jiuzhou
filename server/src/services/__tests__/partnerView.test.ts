import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPartnerBattleSkillData,
  toPartnerBattleSkillData,
  type PartnerEffectiveSkillEntry,
} from '../shared/partnerView.js';

/**
 * 伙伴有效技能转战斗技能回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁住伙伴技能从有效条目转成战斗 SkillData 时，必须保留当前层数强化后的光环效果与 AI 优先级。
 * 2. 做什么：覆盖在线战斗与挂机共用的转换入口，避免后续再从静态技能表回查导致退回初始层。
 * 3. 不做什么：不连数据库，不验证伙伴属性成长，也不覆盖战斗引擎完整结算。
 *
 * 输入/输出：
 * - 输入：已完成层数强化的伙伴有效技能条目。
 * - 输出：可直接进入 battleFactory 的 SkillData。
 *
 * 数据流/状态流：
 * partnerView.buildPartnerEffectiveSkillEntries -> toPartnerBattleSkillData/buildPartnerBattleSkillData -> partnerBattleMember -> 在线战斗 / 挂机快照。
 *
 * 关键边界条件与坑点：
 * 1. 转换时不能重新按 `skillId` 回查静态技能表，否则 upgrade 后新增的 aura 子效果会丢失。
 * 2. 输出 `effects` 必须是独立数组，避免多场战斗共用同一份伙伴技能效果引用。
 */

const createUpgradedAuraSkillEntry = (): PartnerEffectiveSkillEntry => ({
  skillId: 'skill-partner-upgraded-aura',
  skillName: '曜金灵环',
  skillIcon: '/partner-aura.png',
  skillDescription: '升级后会额外提供增伤光环',
  cost_lingqi: 0,
  cost_lingqi_rate: 0,
  cost_qixue: 0,
  cost_qixue_rate: 0,
  cooldown: 0,
  target_type: 'self',
  target_count: 1,
  damage_type: 'none',
  element: 'huo',
  effects: [
    {
      type: 'buff',
      buffKind: 'aura',
      auraTarget: 'all_ally',
      auraEffects: [
        {
          type: 'buff',
          buffKind: 'attr',
          attrKey: 'fagong',
          applyType: 'percent',
          value: 0.06,
        },
        {
          type: 'buff',
          buffKind: 'attr',
          attrKey: 'zengshang',
          applyType: 'flat',
          value: 0.1,
        },
      ],
    },
  ],
  trigger_type: 'passive',
  ai_priority: 17,
  sourceTechniqueId: 'tech-partner-aura',
  sourceTechniqueName: '曜金诀',
  sourceTechniqueQuality: '玄',
});

test('toPartnerBattleSkillData: 应保留伙伴当前层数强化后的光环效果', () => {
  const entry = createUpgradedAuraSkillEntry();

  const result = toPartnerBattleSkillData(entry);

  assert.equal(result.id, entry.skillId);
  assert.equal(result.trigger_type, 'passive');
  assert.equal(result.ai_priority, 17);
  assert.notEqual(result.effects, entry.effects);
  assert.deepEqual(result.effects, entry.effects);
});

test('buildPartnerBattleSkillData: 应按传入顺序输出完整伙伴战斗技能数据', () => {
  const activeEntry: PartnerEffectiveSkillEntry = {
    skillId: 'skill-partner-active',
    skillName: '落星式',
    skillIcon: '/partner-active.png',
    cost_lingqi: 18,
    cooldown: 1,
    target_type: 'single_enemy',
    target_count: 1,
    damage_type: 'physical',
    element: 'jin',
    effects: [{ type: 'damage', value: 120 }],
    trigger_type: 'active',
    ai_priority: 60,
    sourceTechniqueId: 'tech-partner-active',
    sourceTechniqueName: '落星诀',
    sourceTechniqueQuality: '黄',
  };

  const result = buildPartnerBattleSkillData([
    activeEntry,
    createUpgradedAuraSkillEntry(),
  ]);

  assert.deepEqual(
    result.map((skill) => [skill.id, skill.trigger_type, skill.ai_priority]),
    [
      ['skill-partner-active', 'active', 60],
      ['skill-partner-upgraded-aura', 'passive', 17],
    ],
  );
});
