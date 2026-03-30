import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerSetBonusEffects } from '../../battle/modules/setBonus.js';
import {
  resolveSkillAffixTriggerChanceScale,
  resolveSkillAffixTriggerTotalCoefficient,
} from '../../battle/utils/affixTriggerBudget.js';
import type { BattleSetBonusEffect, BattleSkill } from '../../battle/types.js';
import { createState, createUnit } from './battleTestUtils.js';

const createDamageSkill = (hitCount: number): BattleSkill => ({
  id: `skill-hit-${hitCount}`,
  name: `连击${hitCount}`,
  source: 'innate',
  cost: {},
  cooldown: 0,
  targetType: 'single_enemy',
  targetCount: 1,
  damageType: 'physical',
  element: 'none',
  effects: [{
    type: 'damage',
    value: 60,
    valueType: 'flat',
    hit_count: hitCount,
  }],
  triggerType: 'active',
  aiPriority: 50,
});

test('多段伤害技能应按递减曲线提升总触发预算，而非固定上限', () => {
  assert.equal(resolveSkillAffixTriggerTotalCoefficient(1), 1);
  assert.equal(resolveSkillAffixTriggerTotalCoefficient(2), 1.3);
  assert.ok(Math.abs(resolveSkillAffixTriggerTotalCoefficient(6) - 1.670820393249937) < 1e-12);
  assert.ok(Math.abs(resolveSkillAffixTriggerTotalCoefficient(20) - 2.307669683062202) < 1e-12);
});

test('多段伤害技能应按总段数分摊曲线预算，段数越多单段缩放越低', () => {
  assert.equal(resolveSkillAffixTriggerChanceScale(createDamageSkill(1)), 1);
  assert.ok(Math.abs(resolveSkillAffixTriggerChanceScale(createDamageSkill(6)) - 0.2784700655416562) < 1e-12);
  assert.ok(Math.abs(resolveSkillAffixTriggerChanceScale(createDamageSkill(20)) - 0.1153834841531101) < 1e-12);
});

test('多段技能缩放只作用于装备特殊词条，不影响套装效果触发', () => {
  const setEffect: BattleSetBonusEffect = {
    setId: 'set-taixu',
    setName: '太虚套装',
    pieceCount: 4,
    trigger: 'on_hit',
    target: 'enemy',
    effectType: 'damage',
    params: {
      chance: 1,
      value: 120,
      damage_type: 'true',
    },
  };
  const owner = createUnit({ id: 'player-601', name: '太虚剑修', setBonusEffects: [setEffect] });
  const target = createUnit({ id: 'monster-601', name: '木桩妖', type: 'monster' });
  const state = createState({ attacker: [owner], defender: [target] });

  const logs = triggerSetBonusEffects(state, 'on_hit', owner, {
    target,
    damage: 120,
    affixTriggerChanceScale: 0.1153834841531101,
  });

  assert.equal(logs.length, 1);
});
