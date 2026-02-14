import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeneratedAffixesForReroll,
  rerollEquipmentAffixesWithLocks,
  type RerollAffixPool,
} from '../equipmentAffixRerollService.js';
import type { GeneratedAffix } from '../equipmentService.js';

test('special词条缺失attr_key时应在解析阶段按key回填', () => {
  const parsed = parseGeneratedAffixesForReroll([
    {
      key: 'proc_lingchao',
      name: '灵潮',
      apply_type: 'special',
      tier: 6,
      value: 0.25,
      trigger: 'on_turn_start',
      target: 'self',
      effect_type: 'resource',
      params: {
        attr_key: 'lingqi_restore_percent',
      },
    },
    {
      key: 'proc_baonu',
      name: '暴怒',
      apply_type: 'special',
      tier: 5,
      value: 12,
      trigger: 'on_hit',
      target: 'enemy',
      effect_type: 'damage',
    },
  ]);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.key, 'proc_lingchao');
  assert.equal(parsed[1]?.key, 'proc_baonu');
});

test('洗炼生成special词条时不应写入外层attr_key', () => {
  const currentAffixes: GeneratedAffix[] = [
    {
      key: 'wugong_flat',
      name: '物攻+',
      modifiers: [{ attr_key: 'wugong', value: 5 }],
      apply_type: 'flat',
      tier: 1,
      value: 5,
    },
  ];

  const pool: RerollAffixPool = {
    rules: {
      allow_duplicate: false,
    },
    affixes: [
      {
        key: 'proc_test',
        name: '测试触发',
        apply_type: 'special',
        group: 'trigger',
        weight: 100,
        trigger: 'on_hit',
        target: 'enemy',
        effect_type: 'damage',
        params: { damage_type: 'true' },
        tiers: [
          {
            tier: 5,
            min: 10,
            max: 10,
            realm_rank_min: 1,
          },
        ],
      },
    ],
  };

  const rerollResult = rerollEquipmentAffixesWithLocks({
    currentAffixes,
    lockIndexes: [],
    pool,
    quality: '黄',
    realmRank: 1,
    attrFactor: 1,
  });

  assert.equal(rerollResult.success, true);
  assert.ok(rerollResult.affixes);
  assert.equal(rerollResult.affixes?.length, 1);
  assert.equal('attr_key' in (rerollResult.affixes?.[0] ?? {}), false);
});

test('解析flat词条时应保留复合modifiers结构', () => {
  const parsed = parseGeneratedAffixesForReroll([
    {
      key: 'dual_atk',
      name: '双攻并进',
      apply_type: 'flat',
      tier: 6,
      value: 20,
      modifiers: [
        { attr_key: 'wugong', value: 20 },
        { attr_key: 'fagong', value: 10 },
      ],
    },
  ]);

  assert.equal(parsed.length, 1);
  assert.equal('attr_key' in (parsed[0] ?? {}), false);
  assert.equal(parsed[0]?.modifiers?.length, 2);
  assert.equal(parsed[0]?.modifiers?.[0]?.attr_key, 'wugong');
  assert.equal(parsed[0]?.modifiers?.[1]?.attr_key, 'fagong');
});

test('洗炼生成flat词条时应支持复合modifiers', () => {
  const currentAffixes: GeneratedAffix[] = [
    {
      key: 'single_atk',
      name: '单攻',
      modifiers: [{ attr_key: 'wugong', value: 5 }],
      apply_type: 'flat',
      tier: 1,
      value: 5,
    },
  ];

  const pool: RerollAffixPool = {
    rules: {
      allow_duplicate: false,
    },
    affixes: [
      {
        key: 'dual_atk',
        name: '双攻并进',
        modifiers: [
          { attr_key: 'wugong' },
          { attr_key: 'fagong', ratio: 0.5 },
        ],
        apply_type: 'flat',
        group: 'output',
        weight: 100,
        tiers: [
          {
            tier: 6,
            min: 20,
            max: 20,
            realm_rank_min: 1,
          },
        ],
      },
    ],
  };

  const rerollResult = rerollEquipmentAffixesWithLocks({
    currentAffixes,
    lockIndexes: [],
    pool,
    quality: '黄',
    realmRank: 1,
    attrFactor: 1,
  });

  assert.equal(rerollResult.success, true);
  assert.equal('attr_key' in (rerollResult.affixes?.[0] ?? {}), false);
  assert.equal(rerollResult.affixes?.[0]?.value, 20);
  assert.equal(rerollResult.affixes?.[0]?.modifiers?.length, 2);
  assert.equal(rerollResult.affixes?.[0]?.modifiers?.[0]?.value, 20);
  assert.equal(rerollResult.affixes?.[0]?.modifiers?.[1]?.value, 10);
});
