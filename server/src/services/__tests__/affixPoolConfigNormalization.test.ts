/**
 * 词缀池简化配置标准化测试
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：验证 affix 层 `start_tier` + `values` 简化配置能稳定展开为运行时 `tiers`，并保留多值源与部位约束。
 * 2) 不做什么：不覆盖装备掉落概率，不验证洗炼消耗，也不做数值平衡评估。
 *
 * 输入/输出：
 * - 输入：内联简化词缀池样例、以及真实 `affix_pool.json` 种子。
 * - 输出：标准化后的词缀池断言结果，以及真实种子结构约束断言。
 *
 * 数据流/状态流：
 * 简化 seed -> `normalizeAffixPoolFile` -> 标准化 `tiers/value_tiers` -> 运行时生成/预览/洗炼共用。
 *
 * 关键边界条件与坑点：
 * 1) `start_tier` 只能放在词缀层，否则多数值词条会出现“同一个词缀不同值源起始档不一致”的配置漂移。
 * 2) 多值源词条虽然当前种子里还不多，但标准化器必须一次支持到位，避免以后再引入第二套 tiers 展开逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAffixPoolFile, type RawAffixPoolFile } from '../shared/affixPoolConfig.js';
import { findAffixByKeyAndSlot, loadSeed } from './seedTestUtils.js';

test('affix 层 start_tier 与 values 应展开 flat/percent 两类成长，并保留 value_tiers', () => {
  const raw: RawAffixPoolFile = {
    pools: [
      {
        id: 'ap-test',
        name: '测试词缀池',
        rules: { allow_duplicate: false },
        affixes: [
          {
            key: 'flat-demo',
            name: '固定成长',
            apply_type: 'flat',
            group: 'output',
            weight: 100,
            start_tier: 2,
            allowed_slots: ['artifact'],
            values: {
              main: {
                base: { min: 4, max: 8 },
                growth: { mode: 'flat', min_delta: 2, max_delta: 4 },
              },
            },
            modifiers: [{ attr_key: 'wugong', value_source: 'main' }],
          },
          {
            key: 'dual-demo',
            name: '双属性成长',
            apply_type: 'flat',
            group: 'output',
            weight: 60,
            start_tier: 3,
            primary_value_source: 'atk',
            values: {
              atk: {
                base: { min: 10, max: 20 },
                growth: { mode: 'flat', min_delta: 3, max_delta: 5 },
              },
              hp: {
                base: { min: 100, max: 200 },
                growth: { mode: 'percent', min_rate: 0.1, max_rate: 0.2 },
              },
            },
            modifiers: [
              { attr_key: 'wugong', value_source: 'atk' },
              { attr_key: 'max_qixue', value_source: 'hp' },
            ],
          },
          {
            key: 'special-demo',
            name: '特殊词条成长',
            apply_type: 'special',
            group: 'trigger',
            weight: 20,
            start_tier: 7,
            description_template: 'proc_lingchao',
            values: {
              energy: {
                base: { min: 30, max: 45 },
                growth: { mode: 'percent', min_rate: 0.1, max_rate: 0.1 },
              },
            },
            trigger: 'on_turn_start',
            target: 'self',
            effect_type: 'resource',
            params: {
              resource_type: 'lingqi',
              chance: 0.3,
            },
          },
        ],
      },
    ],
  };

  const normalized = normalizeAffixPoolFile(raw);
  const pool = normalized[0];
  assert.ok(pool);

  const flatAffix = pool.affixes.find((affix) => affix.key === 'flat-demo');
  assert.ok(flatAffix);
  assert.equal(flatAffix.start_tier, 2);
  assert.equal(flatAffix.primary_value_source, 'main');
  assert.deepEqual(flatAffix.allowed_slots, ['artifact']);
  assert.deepEqual(flatAffix.tiers, [
    { tier: 2, min: 4, max: 8, realm_rank_min: 2 },
    { tier: 3, min: 6, max: 12, realm_rank_min: 3 },
    { tier: 4, min: 8, max: 16, realm_rank_min: 4 },
    { tier: 5, min: 10, max: 20, realm_rank_min: 5 },
    { tier: 6, min: 12, max: 24, realm_rank_min: 6 },
    { tier: 7, min: 14, max: 28, realm_rank_min: 7 },
    { tier: 8, min: 16, max: 32, realm_rank_min: 8 },
    { tier: 9, min: 18, max: 36, realm_rank_min: 9 },
    { tier: 10, min: 20, max: 40, realm_rank_min: 10 },
    { tier: 11, min: 22, max: 44, realm_rank_min: 11 },
  ]);

  const dualAffix = pool.affixes.find((affix) => affix.key === 'dual-demo');
  assert.ok(dualAffix);
  assert.equal(dualAffix.primary_value_source, 'atk');
  assert.deepEqual(dualAffix.tiers, [
    { tier: 3, min: 10, max: 20, realm_rank_min: 3 },
    { tier: 4, min: 13, max: 25, realm_rank_min: 4 },
    { tier: 5, min: 16, max: 30, realm_rank_min: 5 },
    { tier: 6, min: 19, max: 35, realm_rank_min: 6 },
    { tier: 7, min: 22, max: 40, realm_rank_min: 7 },
    { tier: 8, min: 25, max: 45, realm_rank_min: 8 },
    { tier: 9, min: 28, max: 50, realm_rank_min: 9 },
    { tier: 10, min: 31, max: 55, realm_rank_min: 10 },
    { tier: 11, min: 34, max: 60, realm_rank_min: 11 },
  ]);
  assert.deepEqual(dualAffix.value_tiers.hp, [
    { tier: 3, min: 100, max: 200, realm_rank_min: 3 },
    { tier: 4, min: 110, max: 240, realm_rank_min: 4 },
    { tier: 5, min: 121, max: 288, realm_rank_min: 5 },
    { tier: 6, min: 133.1, max: 345.6, realm_rank_min: 6 },
    { tier: 7, min: 146.41, max: 414.72, realm_rank_min: 7 },
    { tier: 8, min: 161.051, max: 497.664, realm_rank_min: 8 },
    { tier: 9, min: 177.1561, max: 597.1968, realm_rank_min: 9 },
    { tier: 10, min: 194.87171, max: 716.63616, realm_rank_min: 10 },
    { tier: 11, min: 214.358881, max: 859.963392, realm_rank_min: 11 },
  ]);

  const specialAffix = pool.affixes.find((affix) => affix.key === 'special-demo');
  assert.ok(specialAffix);
  assert.equal(
    specialAffix.tiers.find((tier) => tier.tier === 7)?.description,
    '回合开始时30%概率引动灵潮，恢复30~45点灵气',
  );
  assert.equal(
    specialAffix.tiers.find((tier) => tier.tier === 10)?.description,
    '回合开始时30%概率引动灵潮，恢复39.93~59.895点灵气',
  );
  assert.equal(
    specialAffix.tiers.find((tier) => tier.tier === 11)?.description,
    '回合开始时30%概率引动灵潮，恢复43.923~65.8845点灵气',
  );
});

test('真实 affix_pool 种子应全部切到简化模型，不再直接手写 tiers', () => {
  const rawSeed = loadSeed('affix_pool.json') as RawAffixPoolFile;
  assert.ok(Array.isArray(rawSeed.pools) && rawSeed.pools.length > 0, '词缀池种子不能为空');
  assert.equal(rawSeed.pools.length, 1, '词缀池应收敛为单一总池');
  assert.equal(rawSeed.pools[0]?.id, 'ap-equipment', '总池 id 应为 ap-equipment');

  for (const pool of rawSeed.pools) {
    assert.ok(Array.isArray(pool.affixes) && pool.affixes.length > 0, `${pool.id} 缺少 affixes`);
    for (const affix of pool.affixes) {
      assert.equal('tiers' in affix, false, `${pool.id}:${affix.key} 不应继续手写 tiers`);
      assert.equal(typeof affix.start_tier, 'number', `${pool.id}:${affix.key} 缺少 affix 层 start_tier`);
      assert.ok(affix.start_tier >= 1, `${pool.id}:${affix.key} start_tier 非法`);
      assert.ok(affix.values && Object.keys(affix.values).length > 0, `${pool.id}:${affix.key} 缺少 values`);
    }
  }
});

test('真实 ap-equipment 应保留法宝词缀的部位约束并可正常展开到 T11', () => {
  const rawSeed = loadSeed('affix_pool.json') as RawAffixPoolFile;
  const pools = normalizeAffixPoolFile(rawSeed);
  const pool = pools.find((entry) => entry.id === 'ap-equipment');
  assert.ok(pool, '缺少 ap-equipment');

  const fagongFlat = findAffixByKeyAndSlot(pool, 'fagong_flat', 'artifact');
  assert.ok(fagongFlat, '缺少 fagong_flat');
  assert.deepEqual(fagongFlat.allowed_slots, ['artifact']);
  assert.equal(fagongFlat.start_tier, 2);
  assert.equal(fagongFlat.primary_value_source, 'main');
  assert.deepEqual(fagongFlat.value_tiers.main, fagongFlat.tiers);
  assert.ok(fagongFlat.tiers.some((tier) => tier.tier === 11), 'fagong_flat 应补齐 T11');
});
