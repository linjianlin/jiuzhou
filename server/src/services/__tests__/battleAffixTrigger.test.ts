import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBattleAffixEffectsFromEquippedItems } from '../battleAffixEffectService.js';
import type { AffixAllowedSlot } from '../shared/affixPoolConfig.js';
import { collectAffixesBySlot, loadNormalizedAffixPools } from './seedTestUtils.js';

test('special词条应转换为战斗触发效果并注入params.value', () => {
  const effects = extractBattleAffixEffectsFromEquippedItems([
    {
      itemInstanceId: 101,
      itemName: '赤焰枪',
      affixesRaw: [
        {
          key: 'proc_zhuihun',
          name: '追魂斩',
          apply_type: 'special',
          trigger: 'on_hit',
          target: 'enemy',
          effect_type: 'damage',
          value: 28,
          params: {
            damage_type: 'true',
            scale_key: 'wugong',
            scale_rate: 0.06,
            chance: 0.22,
          },
        },
      ],
    },
  ]);

  assert.equal(effects.length, 1);
  const effect = effects[0];
  assert.equal(effect.trigger, 'on_hit');
  assert.equal(effect.target, 'enemy');
  assert.equal(effect.effectType, 'damage');
  assert.equal(effect.setId, 'affix-101-proc_zhuihun');
  assert.equal(effect.setName, '赤焰枪·追魂斩');
  assert.equal(effect.pieceCount, 1);
  assert.equal(Number(effect.params.value), 28);
  assert.equal(String(effect.params.affix_key), 'proc_zhuihun');
  assert.equal(String(effect.params.scale_key), 'wugong');
});

test('非special或缺失关键字段的词条应被忽略', () => {
  const effects = extractBattleAffixEffectsFromEquippedItems([
    {
      itemInstanceId: 88,
      itemName: '玄铁甲',
      affixesRaw: [
        {
          key: 'wufang_flat',
          apply_type: 'flat',
          value: 30,
        },
        {
          key: 'proc_missing_trigger',
          apply_type: 'special',
          target: 'self',
          effect_type: 'buff',
          value: 100,
        },
        {
          key: 'proc_missing_effect',
          apply_type: 'special',
          trigger: 'on_be_hit',
          target: 'self',
          value: 40,
        },
        {
          key: 'proc_invalid_target',
          apply_type: 'special',
          trigger: 'on_hit',
          target: 'ally',
          effect_type: 'damage',
          value: 40,
        },
      ],
    },
  ]);

  assert.equal(effects.length, 0);
});

test('on_hit/on_be_hit/on_crit/on_turn_start/on_ally_hit五类触发词条可被识别', () => {
  const effects = extractBattleAffixEffectsFromEquippedItems([
    {
      itemInstanceId: 233,
      itemName: '混元佩',
      affixesRaw: [
        {
          key: 'a-hit',
          apply_type: 'special',
          trigger: 'on_hit',
          target: 'enemy',
          effect_type: 'damage',
          value: 20,
        },
        {
          key: 'a-be-hit',
          apply_type: 'special',
          trigger: 'on_be_hit',
          target: 'self',
          effect_type: 'heal',
          value: 20,
        },
        {
          key: 'a-crit',
          apply_type: 'special',
          trigger: 'on_crit',
          target: 'self',
          effect_type: 'buff',
          value: 20,
        },
        {
          key: 'a-turn',
          apply_type: 'special',
          trigger: 'on_turn_start',
          target: 'self',
          effect_type: 'resource',
          value: 8,
        },
        {
          key: 'a-ally-hit',
          apply_type: 'special',
          trigger: 'on_ally_hit',
          target: 'enemy',
          effect_type: 'pursuit',
          value: 0.42,
        },
      ],
    },
  ]);

  const triggers = effects.map((effect) => effect.trigger).sort();
  assert.deepEqual(triggers, ['on_ally_hit', 'on_be_hit', 'on_crit', 'on_hit', 'on_turn_start']);
});

test('总词缀池触发词条应按部位过滤后与方案一致且档位分层正确', () => {
  const pools = loadNormalizedAffixPools();
  const matchedPool = pools.find((row) => row.id === 'ap-equipment');
  assert.ok(matchedPool, '缺少词条池: ap-equipment');
  const pool = matchedPool;

  const poolPlan: Array<{ slot: AffixAllowedSlot; keys: string[] }> = [
    { slot: 'weapon', keys: ['proc_zhuihun', 'proc_tianlei', 'proc_baonu', 'proc_duanxing', 'proc_huixiang', 'proc_xuangang', 'proc_tongqi'] },
    { slot: 'head', keys: ['proc_hushen', 'proc_fansha', 'proc_duanxing', 'proc_huixiang', 'proc_xuangang'] },
    { slot: 'accessory', keys: ['proc_baonu', 'proc_lingchao', 'proc_duanxing', 'proc_huixiang', 'proc_xuangang', 'proc_tongqi'] },
    { slot: 'artifact', keys: ['proc_tianlei', 'proc_lingchao', 'proc_duanxing', 'proc_huixiang', 'proc_xuangang', 'proc_tongqi'] },
  ];
  const t8OnlySpecialKeys = new Set(['proc_duanxing', 'proc_huixiang', 'proc_xuangang']);
  const t10OnlySpecialKeys = new Set(['proc_tongqi']);

  for (const plan of poolPlan) {
    const specialAffixes = collectAffixesBySlot(pool, plan.slot).filter((affix) => affix.apply_type === 'special');
    const specialKeys = specialAffixes.map((affix) => affix.key).sort();
    assert.deepEqual(specialKeys, [...plan.keys].sort(), `${plan.slot} 触发词条与方案不一致`);

    for (const affix of specialAffixes) {
      const tiers = affix.tiers.map((tier) => tier.tier).sort((a, b) => a - b);
      const expectedTiers = t10OnlySpecialKeys.has(affix.key)
        ? [10, 11]
        : t8OnlySpecialKeys.has(affix.key)
          ? [8, 9, 10, 11]
          : [5, 6, 7, 8, 9, 10, 11];
      assert.deepEqual(tiers, expectedTiers, `${plan.slot}:${affix.key} 词条档位不符合分层规则`);
      for (const tier of affix.tiers) {
        assert.ok(
          typeof tier.description === 'string' && tier.description.trim().length > 0,
          `${plan.slot}:${affix.key}:T${tier.tier} 缺少描述`
        );
      }
    }
  }
});
