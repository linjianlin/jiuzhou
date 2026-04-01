/**
 * 功法结构化 Buff 目录测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证 AI 生成功法共享目录已经收录 reflect_damage，以及当前明确开放的内置光环属性白名单。
 * 2) 不做什么：不测试外部模型调用、不覆盖完整 prompt 文本，仅锁定目录提炼与白名单校验。
 *
 * 输入/输出：
 * - 输入：静态技能种子 + 内置光环属性白名单提炼出的结构化 Buff 目录，以及若干 Buff 效果样例。
 * - 输出：目录包含关系断言，以及 validateTechniqueStructuredBuffEffect 的校验结果。
 *
 * 数据流/状态流：
 * - skill_def.json 中的静态技能效果 + techniqueStructuredBuffCatalog 内置白名单 -> 目录提炼 -> AI prompt/结果校验复用
 * - 本测试直接验证提炼产物，确保新 Buff/新属性不会只在战斗层可用、却被 AI 白名单挡掉
 *
 * 关键边界条件与坑点：
 * 1) 目录来源必须是真实静态种子，避免只改约束文案却没有可提炼样例。
 * 2) 内置光环属性不能散落在 prompt 或测试里手填，必须走目录单一入口，否则 attrKey/buffKey 很容易漏一半。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getTechniqueStructuredBuffCatalog, validateTechniqueStructuredBuffEffect } from '../shared/techniqueStructuredBuffCatalog.js';

test('结构化 Buff 目录应包含反弹伤害 Buff 样例', () => {
  const catalog = getTechniqueStructuredBuffCatalog();

  assert.equal(catalog.kindEnum.includes('reflect_damage'), true);
  assert.equal(catalog.buffKeyEnumByType.buff.includes('buff-reflect-damage'), true);
  assert.equal(catalog.exampleByTypeAndKind.buff.reflect_damage?.buffKey, 'buff-reflect-damage');
});

test('reflect_damage Buff 应通过 AI 生成功法结果校验', () => {
  const validation = validateTechniqueStructuredBuffEffect({
    type: 'buff',
    buffKind: 'reflect_damage',
    buffKey: 'buff-reflect-damage',
    value: 0.35,
  });

  assert.deepEqual(validation, { success: true });
});

test('结构化 Buff 目录应包含新增的内置光环属性白名单', () => {
  const catalog = getTechniqueStructuredBuffCatalog();

  assert.equal(catalog.attrKeyEnum.includes('max_qixue'), true);
  assert.equal(catalog.attrKeyEnum.includes('baoji'), true);
  assert.equal(catalog.attrKeyEnum.includes('baoshang'), true);
  assert.equal(catalog.attrKeyEnum.includes('kangbao'), true);
  assert.equal(catalog.attrKeyEnum.includes('lengque'), true);
  assert.equal(catalog.buffKeyEnumByType.buff.includes('buff-max-qixue-up'), true);
  assert.equal(catalog.buffKeyEnumByType.buff.includes('buff-baoji-up'), true);
  assert.equal(catalog.buffKeyEnumByType.buff.includes('buff-baoshang-up'), true);
  assert.equal(catalog.buffKeyEnumByType.debuff.includes('debuff-kangbao-down'), true);
  assert.equal(catalog.buffKeyEnumByType.debuff.includes('debuff-lengque-down'), true);
});

test('新增内置光环属性应通过结构化 Buff 校验', () => {
  const cases = [
    {
      type: 'buff' as const,
      buffKind: 'attr',
      buffKey: 'buff-max-qixue-up',
      attrKey: 'max_qixue',
      applyType: 'percent' as const,
      value: 0.18,
    },
    {
      type: 'buff' as const,
      buffKind: 'attr',
      buffKey: 'buff-baoji-up',
      attrKey: 'baoji',
      applyType: 'flat' as const,
      value: 0.12,
    },
    {
      type: 'buff' as const,
      buffKind: 'attr',
      buffKey: 'buff-baoshang-up',
      attrKey: 'baoshang',
      applyType: 'percent' as const,
      value: 0.1,
    },
    {
      type: 'debuff' as const,
      buffKind: 'attr',
      buffKey: 'debuff-kangbao-down',
      attrKey: 'kangbao',
      applyType: 'flat' as const,
      value: 0.15,
    },
    {
      type: 'buff' as const,
      buffKind: 'attr',
      buffKey: 'buff-lengque-up',
      attrKey: 'lengque',
      applyType: 'flat' as const,
      value: 0.08,
    },
  ];

  cases.forEach((effect) => {
    assert.deepEqual(validateTechniqueStructuredBuffEffect(effect), { success: true });
  });
});
