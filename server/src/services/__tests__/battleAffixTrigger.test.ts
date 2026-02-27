import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractBattleAffixEffectsFromEquippedItems } from '../battleAffixEffectService.js';

type SeedAffixTier = {
  tier: number;
  min: number;
  max: number;
  realm_rank_min: number;
  description?: string;
};

type SeedAffix = {
  key: string;
  apply_type: string;
  tiers: SeedAffixTier[];
};

type SeedPool = {
  id: string;
  affixes: SeedAffix[];
};

type AffixPoolSeedFile = {
  pools: SeedPool[];
};

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

test('on_hit/on_be_hit/on_crit/on_turn_start四类触发词条可被识别', () => {
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
      ],
    },
  ]);

  const triggers = effects.map((effect) => effect.trigger).sort();
  assert.deepEqual(triggers, ['on_be_hit', 'on_crit', 'on_hit', 'on_turn_start']);
});

test('六个高品池触发词条应与方案一致且词条仅包含T5/T6', () => {
  const candidatePaths = [
    resolve(process.cwd(), 'server/src/data/seeds/affix_pool.json'),
    resolve(process.cwd(), 'src/data/seeds/affix_pool.json'),
  ];
  const seedPath = candidatePaths.find((filePath) => existsSync(filePath));
  assert.ok(seedPath, '未找到 affix_pool.json 种子文件');
  const seedFile = JSON.parse(readFileSync(seedPath, 'utf-8')) as AffixPoolSeedFile;

  const poolPlan: Array<{ id: string; keys: string[] }> = [
    { id: 'ap-weapon-uncommon', keys: ['proc_zhuihun', 'proc_baonu'] },
    { id: 'ap-weapon-rare', keys: ['proc_zhuihun', 'proc_tianlei', 'proc_baonu'] },
    { id: 'ap-armor-uncommon', keys: ['proc_hushen', 'proc_fansha'] },
    { id: 'ap-armor-rare', keys: ['proc_hushen', 'proc_fansha'] },
    { id: 'ap-accessory-uncommon', keys: ['proc_baonu', 'proc_lingchao'] },
    { id: 'ap-artifact-uncommon', keys: ['proc_tianlei', 'proc_lingchao'] },
  ];

  for (const plan of poolPlan) {
    const pool = seedFile.pools.find((row) => row.id === plan.id);
    assert.ok(pool, `缺少词条池: ${plan.id}`);

    const specialAffixes = pool.affixes.filter((affix) => affix.apply_type === 'special');
    const specialKeys = specialAffixes.map((affix) => affix.key).sort();
    assert.deepEqual(specialKeys, [...plan.keys].sort(), `${plan.id} 触发词条与方案不一致`);

    for (const affix of specialAffixes) {
      const tiers = affix.tiers.map((tier) => tier.tier).sort((a, b) => a - b);
      assert.deepEqual(tiers, [5, 6], `${plan.id}:${affix.key} 词条档位应仅有T5/T6`);
      for (const tier of affix.tiers) {
        assert.ok(
          typeof tier.description === 'string' && tier.description.trim().length > 0,
          `${plan.id}:${affix.key}:T${tier.tier} 缺少描述`
        );
      }
    }
  }
});
