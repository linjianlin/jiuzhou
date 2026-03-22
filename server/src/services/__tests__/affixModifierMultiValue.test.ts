/**
 * 多值词条 modifier 绑定测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：验证同一个词缀可把不同 `value_source` 绑定到不同属性，并保持单一计算入口。
 * - 不做什么：不覆盖装备掉落、不测试种子读取，也不验证特殊词条描述生成。
 *
 * 输入/输出：
 * - 输入：`buildAffixValueAndModifiers` 的多值源入参。
 * - 输出：主展示值与各 modifier 数值断言。
 *
 * 数据流/状态流：
 * 标准化后的多值 tiers -> `rollAffixValue` 组装多值采样结果 -> `buildAffixValueAndModifiers` 统一产出最终 modifiers。
 *
 * 关键边界条件与坑点：
 * 1) 不能让每个消费方自己根据 `value_source` 重新算一遍，否则复合属性词条会立刻出现行为分叉。
 * 2) 主展示值与 modifier 计算必须共享同一套 source 值输入，避免预览和落库结果不一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAffixValueAndModifiers } from '../shared/affixModifier.js';

test('buildAffixValueAndModifiers 应支持不同 modifier 绑定不同 value_source', () => {
  const result = buildAffixValueAndModifiers({
    applyType: 'flat',
    keyRaw: 'dual-demo',
    effectType: undefined,
    params: undefined,
    modifiersRaw: [
      { attr_key: 'wugong', value_source: 'atk' },
      { attr_key: 'max_qixue', value_source: 'hp', ratio: 1.5 },
    ],
    rawScaledValue: 15,
    rawScaledValueBySource: {
      atk: 15,
      hp: 80,
    },
    defaultValueSource: 'atk',
  });

  assert.ok(result);
  assert.equal(result.value, 15);
  assert.deepEqual(result.modifiers, [
    { attr_key: 'wugong', value: 15 },
    { attr_key: 'max_qixue', value: 120 },
  ]);
});
