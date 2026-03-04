import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOID_EROSION_MARK_ID,
  applyMarkStacks,
  consumeMarkStacks,
  decayUnitMarksAtRoundStart,
  getVoidErosionDamageBonusRate,
  resolveMarkEffectConfig,
} from '../../battle/modules/mark.js';
import { createUnit } from './battleTestUtils.js';

test('虚蚀印记应遵循叠层上限并按施加者来源隔离', () => {
  const target = createUnit({ id: 'monster-1', name: '木桩妖', type: 'monster' });
  const config = resolveMarkEffectConfig({
    operation: 'apply',
    markId: VOID_EROSION_MARK_ID,
    maxStacks: 5,
    duration: 2,
  });
  assert.ok(config, 'mark 配置解析失败');

  for (let i = 0; i < 7; i += 1) {
    applyMarkStacks(target, 'player-1', config);
  }
  for (let i = 0; i < 3; i += 1) {
    applyMarkStacks(target, 'player-2', config);
  }

  const fromP1 = target.marks?.find((mark) => mark.sourceUnitId === 'player-1');
  const fromP2 = target.marks?.find((mark) => mark.sourceUnitId === 'player-2');
  assert.equal(fromP1?.stacks, 5);
  assert.equal(fromP2?.stacks, 3);
  assert.equal(target.marks?.length, 2);
});

test('虚蚀印记应在回合开始衰减并在持续归零时移除', () => {
  const target = createUnit({ id: 'monster-2', name: '木桩妖', type: 'monster' });
  target.marks = [
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: 'player-1',
      stacks: 2,
      maxStacks: 5,
      remainingDuration: 2,
    },
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: 'player-2',
      stacks: 1,
      maxStacks: 5,
      remainingDuration: 1,
    },
  ];

  decayUnitMarksAtRoundStart(target);
  assert.equal(target.marks?.length, 1);
  assert.equal(target.marks?.[0]?.sourceUnitId, 'player-1');
  assert.equal(target.marks?.[0]?.remainingDuration, 1);

  decayUnitMarksAtRoundStart(target);
  assert.equal(target.marks?.length, 0);
});

test('虚蚀印记应支持 fixed/all 两种消耗模式', () => {
  const target = createUnit({ id: 'monster-3', name: '木桩妖', type: 'monster' });
  target.currentAttrs.max_qixue = 10_000;

  const applyConfig = resolveMarkEffectConfig({
    operation: 'apply',
    markId: VOID_EROSION_MARK_ID,
    maxStacks: 5,
    applyStacks: 4,
    duration: 2,
  });
  assert.ok(applyConfig, 'apply 配置解析失败');
  applyMarkStacks(target, 'player-1', applyConfig);

  const fixedConsumeConfig = resolveMarkEffectConfig({
    operation: 'consume',
    markId: VOID_EROSION_MARK_ID,
    consumeMode: 'fixed',
    consumeStacks: 2,
    perStackRate: 0.5,
    resultType: 'damage',
  });
  assert.ok(fixedConsumeConfig, 'fixed consume 配置解析失败');
  const fixedResult = consumeMarkStacks(target, 'player-1', fixedConsumeConfig, 100, target.currentAttrs.max_qixue);
  assert.equal(fixedResult.consumed, true);
  assert.equal(fixedResult.consumedStacks, 2);
  assert.equal(fixedResult.remainingStacks, 2);
  assert.equal(fixedResult.finalValue, 100);

  const allConsumeConfig = resolveMarkEffectConfig({
    operation: 'consume',
    markId: VOID_EROSION_MARK_ID,
    consumeMode: 'all',
    perStackRate: 0.5,
    resultType: 'damage',
  });
  assert.ok(allConsumeConfig, 'all consume 配置解析失败');
  const allResult = consumeMarkStacks(target, 'player-1', allConsumeConfig, 100, target.currentAttrs.max_qixue);
  assert.equal(allResult.consumed, true);
  assert.equal(allResult.consumedStacks, 2);
  assert.equal(allResult.remainingStacks, 0);
  assert.equal(target.marks?.length, 0);
});

test('虚蚀引爆伤害应命中单次 35% 气血上限', () => {
  const target = createUnit({ id: 'monster-4', name: '木桩妖', type: 'monster' });
  target.currentAttrs.max_qixue = 1_000;

  const applyConfig = resolveMarkEffectConfig({
    operation: 'apply',
    markId: VOID_EROSION_MARK_ID,
    maxStacks: 5,
    applyStacks: 5,
    duration: 2,
  });
  assert.ok(applyConfig, 'apply 配置解析失败');
  applyMarkStacks(target, 'player-1', applyConfig);

  const consumeConfig = resolveMarkEffectConfig({
    operation: 'consume',
    markId: VOID_EROSION_MARK_ID,
    consumeMode: 'all',
    perStackRate: 1,
    resultType: 'damage',
  });
  assert.ok(consumeConfig, 'consume 配置解析失败');

  const result = consumeMarkStacks(target, 'player-1', consumeConfig, 200, target.currentAttrs.max_qixue);
  assert.equal(result.consumed, true);
  assert.equal(result.finalValue, 350);
  assert.equal(result.wasCapped, true);
});

test('虚蚀增伤应按层数 +2% 且封顶 10%', () => {
  const attacker = createUnit({ id: 'player-9', name: '剑修' });
  const defender = createUnit({ id: 'monster-9', name: '木桩妖', type: 'monster' });
  defender.marks = [
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: attacker.id,
      stacks: 7,
      maxStacks: 5,
      remainingDuration: 2,
    },
    {
      id: VOID_EROSION_MARK_ID,
      sourceUnitId: 'player-other',
      stacks: 5,
      maxStacks: 5,
      remainingDuration: 2,
    },
  ];

  const bonus = getVoidErosionDamageBonusRate(attacker, defender);
  assert.equal(bonus, 0.1);
});
