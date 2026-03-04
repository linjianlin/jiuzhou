import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSkill } from '../../battle/modules/skill.js';
import { VOID_EROSION_MARK_ID } from '../../battle/modules/mark.js';
import type { BattleSkill } from '../../battle/types.js';
import { asActionLog, createState, createUnit } from './battleTestUtils.js';

test('技能 mark:apply 在单体目标应正确施加并写入日志目标结果', () => {
  const caster = createUnit({ id: 'player-1', name: '测试法修' });
  const target = createUnit({ id: 'monster-1', name: '木桩妖', type: 'monster' });
  const state = createState({ attacker: [caster], defender: [target] });

  const skill: BattleSkill = {
    id: 'skill-mark-apply-single',
    name: '虚蚀缠印',
    source: 'technique',
    sourceId: 'tech-test',
    cost: {},
    cooldown: 0,
    targetType: 'single_enemy',
    targetCount: 1,
    damageType: 'magic',
    element: 'an',
    effects: [
      {
        type: 'mark',
        markId: VOID_EROSION_MARK_ID,
        operation: 'apply',
        maxStacks: 5,
        duration: 2,
      },
    ],
    triggerType: 'active',
    aiPriority: 80,
  };

  const result = executeSkill(state, caster, skill, [target.id]);
  assert.equal(result.success, true);
  const actionLog = asActionLog(result.log);
  assert.equal(actionLog.targets.length, 1);
  assert.equal(actionLog.targets[0]?.marksApplied?.length, 1);
  assert.match(actionLog.targets[0]?.marksApplied?.[0] ?? '', /虚蚀印记/);

  const mark = target.marks?.find((row) => row.id === VOID_EROSION_MARK_ID && row.sourceUnitId === caster.id);
  assert.equal(mark?.stacks, 1);
  assert.equal(mark?.remainingDuration, 2);
});

test('技能 mark:consume 在群体目标应按各目标独立结算并写入消耗日志', () => {
  const caster = createUnit({ id: 'player-2', name: '测试法修' });
  const targetA = createUnit({ id: 'monster-2', name: '木桩甲', type: 'monster' });
  const targetB = createUnit({ id: 'monster-3', name: '木桩乙', type: 'monster' });
  targetA.marks = [
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: caster.id,
      stacks: 3,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];
  targetB.marks = [
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: caster.id,
      stacks: 1,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];
  const state = createState({ attacker: [caster], defender: [targetA, targetB] });

  const skill: BattleSkill = {
    id: 'skill-mark-consume-all-enemy',
    name: '归墟湮灭',
    source: 'technique',
    sourceId: 'tech-test',
    cost: {},
    cooldown: 0,
    targetType: 'all_enemy',
    targetCount: 2,
    damageType: 'magic',
    element: 'an',
    effects: [
      {
        type: 'mark',
        markId: VOID_EROSION_MARK_ID,
        operation: 'consume',
        consumeMode: 'all',
        perStackRate: 0.3,
        resultType: 'damage',
        valueType: 'flat',
        value: 100,
      },
    ],
    triggerType: 'active',
    aiPriority: 88,
  };

  const result = executeSkill(state, caster, skill);
  assert.equal(result.success, true);
  const actionLog = asActionLog(result.log);
  assert.equal(actionLog.targets.length, 2);

  const targetResultA = actionLog.targets.find((row) => row.targetId === targetA.id);
  const targetResultB = actionLog.targets.find((row) => row.targetId === targetB.id);
  assert.ok(targetResultA, '缺少目标A结果');
  assert.ok(targetResultB, '缺少目标B结果');

  assert.equal((targetResultA?.marksConsumed ?? []).length, 1);
  assert.equal((targetResultB?.marksConsumed ?? []).length, 1);
  assert.ok((targetResultA?.damage ?? 0) > 0);
  assert.ok((targetResultB?.damage ?? 0) > 0);
  assert.equal(targetA.marks?.length, 0);
  assert.equal(targetB.marks?.length, 0);
});
