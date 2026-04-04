import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecialAffixDescription } from '../shared/affixPoolConfig.js';
import { loadNormalizedAffixPools } from './seedTestUtils.js';

const UNIFIED_POOL_IDS = ['ap-equipment'] as const;

const EXPECTED_TOTAL_TIER_ROWS = 852;

type SpecialDescriptionRule = {
  requiredTiers: number[];
};

const specialDescriptionRules: Record<string, SpecialDescriptionRule> = {
  proc_zhuihun: { requiredTiers: [7, 8] },
  proc_tianlei: { requiredTiers: [7, 8] },
  proc_baonu: { requiredTiers: [7, 8] },
  proc_hushen: { requiredTiers: [] },
  proc_fansha: { requiredTiers: [7, 8] },
  proc_lingchao: { requiredTiers: [7, 8] },
  proc_duanxing: { requiredTiers: [8] },
  proc_huixiang: { requiredTiers: [8] },
  proc_xuangang: { requiredTiers: [8] },
  proc_tongqi: { requiredTiers: [10, 11] },
};

test('词缀池应全量扩展到T11且tier门槛一致', () => {
  const pools = loadNormalizedAffixPools();
  let tierRowCount = 0;

  for (const pool of pools) {
    for (const affix of pool.affixes) {
      const tiers = [...affix.tiers].sort((a, b) => a.tier - b.tier);
      assert.ok(tiers.length > 0, `${pool.id}:${affix.key} tiers 不能为空`);
      assert.equal(
        tiers[tiers.length - 1]?.tier,
        11,
        `${pool.id}:${affix.key} maxTier 应为 T11`
      );

      for (const tier of tiers) {
        assert.equal(
          tier.realm_rank_min,
          tier.tier,
          `${pool.id}:${affix.key}:T${tier.tier} realm_rank_min 应与 tier 一致`
        );
        tierRowCount += 1;
      }
    }
  }

  assert.equal(tierRowCount, EXPECTED_TOTAL_TIER_ROWS, 'tier 总行数不符合预期');
});

test('统一池词缀应保留原起始档位并连续补到T11，且区间单调', () => {
  const pools = loadNormalizedAffixPools();

  for (const poolId of UNIFIED_POOL_IDS) {
    const pool = pools.find((row) => row.id === poolId);
    assert.ok(pool, `缺少词缀池: ${poolId}`);

    for (const affix of pool.affixes) {
      const tiers = [...affix.tiers].sort((a, b) => a.tier - b.tier);
      const tierValues = tiers.map((tier) => tier.tier);
      const firstTier = tierValues[0] ?? 1;
      const expectedTiers = Array.from({ length: 11 - firstTier + 1 }, (_, idx) => firstTier + idx);
      assert.deepEqual(
        tierValues,
        expectedTiers,
        `${poolId}:${affix.key} 档位应从现有起始档连续补到 T11`
      );

      let prevMin = Number.NEGATIVE_INFINITY;
      let prevMax = Number.NEGATIVE_INFINITY;
      for (const tier of tiers) {
        const min = Number(tier.min);
        const max = Number(tier.max);
        assert.ok(Number.isFinite(min) && Number.isFinite(max), `${poolId}:${affix.key}:T${tier.tier} 数值非法`);
        assert.ok(max > min, `${poolId}:${affix.key}:T${tier.tier} 应满足 max > min`);
        assert.ok(min >= prevMin, `${poolId}:${affix.key}:T${tier.tier} min 不应回退`);
        assert.ok(max >= prevMax, `${poolId}:${affix.key}:T${tier.tier} max 不应回退`);
        prevMin = min;
        prevMax = max;
      }
    }
  }
});

test('special词缀关键档位描述应与数值一致', () => {
  const pools = loadNormalizedAffixPools();

  for (const pool of pools) {
    for (const affix of pool.affixes) {
      if (affix.apply_type !== 'special') continue;

      const descriptionRule = specialDescriptionRules[affix.key];
      assert.ok(descriptionRule, `${pool.id}:${affix.key} 缺少描述模板`);
      const descriptionKey = affix.key as Parameters<typeof buildSpecialAffixDescription>[0];

      for (const targetTier of descriptionRule.requiredTiers) {
        const tier = affix.tiers.find((row) => row.tier === targetTier);
        assert.ok(tier, `${pool.id}:${affix.key} 缺少 T${targetTier}`);
        const expected = buildSpecialAffixDescription(descriptionKey, Number(tier.min), Number(tier.max));
        assert.equal(
          (tier.description ?? '').trim(),
          expected,
          `${pool.id}:${affix.key}:T${targetTier} 描述应与数值一致`
        );
      }
    }
  }
});

test('总词缀池应为所有词缀补齐T11，且special描述正确', () => {
  const pools = loadNormalizedAffixPools();

  for (const poolId of UNIFIED_POOL_IDS) {
    const pool = pools.find((row) => row.id === poolId);
    assert.ok(pool, `缺少词缀池: ${poolId}`);

    for (const affix of pool.affixes) {
      const tier11 = affix.tiers.find((row) => row.tier === 11);
      assert.ok(tier11, `${poolId}:${affix.key} 缺少 T11`);
      assert.equal(tier11?.realm_rank_min, 11, `${poolId}:${affix.key}:T11 realm_rank_min 应为 11`);

      if (affix.apply_type !== 'special') continue;
      const descriptionRule = specialDescriptionRules[affix.key];
      assert.ok(descriptionRule, `${poolId}:${affix.key} 缺少描述模板`);
      const descriptionKey = affix.key as Parameters<typeof buildSpecialAffixDescription>[0];
      const expected = buildSpecialAffixDescription(descriptionKey, Number(tier11?.min), Number(tier11?.max));
      assert.equal(
        (tier11?.description ?? '').trim(),
        expected,
        `${poolId}:${affix.key}:T11 描述应与数值一致`,
      );
    }
  }
});
