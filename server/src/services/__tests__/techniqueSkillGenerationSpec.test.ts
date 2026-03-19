/**
 * AI 功法技能机制共享规格测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证 AI 生成功法的 effect/upgrade 共享校验已覆盖 control、resource、mark 等新增技能机制。
 * 2) 不做什么：不调用外部模型、不走数据库落库，也不测试完整生成功法任务状态流。
 *
 * 输入/输出：
 * - 输入：单个 SkillEffect，与单个 upgrades 项对象。
 * - 输出：共享校验函数的成功/失败结果。
 *
 * 数据流/状态流：
 * 新技能机制样例 -> techniqueSkillGenerationSpec 校验入口 -> service/constraints 共同复用。
 *
 * 关键边界条件与坑点：
 * 1) 必须同时覆盖基础 effects 与 upgrades.addEffect/effects，避免只同步一半链路。
 * 2) 失败断言要尽量锁定具体原因，防止未来把严格校验又放松成“只看 type 名称”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { SkillEffect } from '../../battle/types.js';
import {
  validateTechniqueSkillEffect,
  validateTechniqueSkillTargetCount,
  validateTechniqueSkillUpgrade,
} from '../shared/techniqueSkillGenerationSpec.js';

test('resource 效果应支持 ally 灵气回复机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'resource',
    resourceType: 'lingqi',
    target: 'ally',
    value: 35,
  });

  assert.deepEqual(validation, { success: true });
});

test('momentum 效果应支持 gain 势机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'momentum',
    momentumId: 'battle_momentum',
    operation: 'gain',
    gainStacks: 1,
    maxStacks: 5,
  });

  assert.deepEqual(validation, { success: true });
});

test('mark:consume 效果应支持引爆印记机制', () => {
  const effect: SkillEffect = {
    type: 'mark',
    markId: 'void_erosion',
    operation: 'consume',
    consumeMode: 'all',
    resultType: 'damage',
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 0.9,
    perStackRate: 0.3,
  };

  assert.deepEqual(validateTechniqueSkillEffect(effect), { success: true });
});

test('damage 效果应支持使用主战属性作为倍率来源', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'damage',
    valueType: 'scale',
    scaleAttr: 'wugong',
    scaleRate: 1.2,
    damageType: 'physical',
  });

  assert.deepEqual(validation, { success: true });
});

test('非法 controlType 应被共享校验拦截', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'control',
    controlType: 'banish',
    chance: 0.25,
    duration: 1,
  });

  assert.deepEqual(validation, { success: false, reason: 'controlType 不在允许枚举中' });
});

test('升级项应支持 addEffect 追加控制效果', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 5,
      changes: {
        addEffect: {
          type: 'control',
          controlType: 'stun',
          chance: 0.2,
          duration: 1,
        },
      },
    },
    9,
    'random_enemy',
  );

  assert.deepEqual(validation, { success: true });
});

test('光环子效果不应再声明 duration', () => {
  const validation = validateTechniqueSkillEffect({
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
  });

  assert.deepEqual(validation, {
    success: false,
    reason: 'auraEffects 子效果不允许声明 duration，光环效果持续时间由宿主光环统一决定',
  });
});

test('升级项中的旧式 effectChanges 字段应被拒绝', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 3,
      effectChanges: [
        {
          effectIndex: 0,
          scaleRate: 1.8,
        },
      ],
      changes: {
        cooldown: -1,
      },
    },
    9,
    'single_enemy',
  );

  assert.deepEqual(validation, { success: false, reason: 'upgrades 不支持字段 effectChanges' });
});

test('single_enemy 不应允许 targetCount 大于 1', () => {
  const validation = validateTechniqueSkillTargetCount('single_enemy', 2, 'targetCount');

  assert.deepEqual(validation, {
    success: false,
    reason: 'targetCount 仅允许 random_enemy/random_ally 在 > 1 时使用，当前 targetType=single_enemy',
  });
});

test('single_enemy 升级项不应把 target_count 提升到 1 以上', () => {
  const validation = validateTechniqueSkillUpgrade(
    {
      layer: 3,
      changes: {
        target_count: 2,
      },
    },
    9,
    'single_enemy',
  );

  assert.deepEqual(validation, {
    success: false,
    reason: 'upgrades.changes.target_count 仅允许 random_enemy/random_ally 在 > 1 时使用，当前 targetType=single_enemy',
  });
});

test('delayed_burst 效果应支持延迟爆发机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'delayed_burst',
    duration: 2,
    valueType: 'scale',
    scaleAttr: 'fagong',
    scaleRate: 1.4,
    damageType: 'magic',
    element: 'huo',
  });

  assert.deepEqual(validation, { success: true });
});

test('fate_swap 效果应支持命运交换机制', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'fate_swap',
    swapMode: 'debuff_to_target',
    count: 2,
  });

  assert.deepEqual(validation, { success: true });
});

test('heal_forbid 结构化 Buff 应被允许用于禁疗效果', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'debuff',
    buffKind: 'heal_forbid',
    buffKey: 'debuff-heal-forbid',
    duration: 2,
  });

  assert.deepEqual(validation, { success: true });
});

test('next_skill_bonus 结构化 Buff 应支持下一次技能强化', () => {
  const validation = validateTechniqueSkillEffect({
    type: 'buff',
    buffKind: 'next_skill_bonus',
    buffKey: 'buff-next-skill-chaos',
    value: 0.5,
    duration: 1,
    bonusType: 'all',
  });

  assert.deepEqual(validation, { success: true });
});

test('扩充后的 markId 与 momentumId 应通过共享校验', () => {
  const markValidation = validateTechniqueSkillEffect({
    type: 'mark',
    markId: 'ember_brand',
    operation: 'apply',
    maxStacks: 5,
  });
  const momentumValidation = validateTechniqueSkillEffect({
    type: 'momentum',
    momentumId: 'blood_tide',
    operation: 'gain',
    gainStacks: 2,
    maxStacks: 6,
  });

  assert.deepEqual(markValidation, { success: true });
  assert.deepEqual(momentumValidation, { success: true });
});
