#!/usr/bin/env node

import {
  SPECIAL_TEMPLATE_KEYS,
  affixPoolPath,
  equipmentDefPath,
  buildLegacyTierRows,
  buildPoolSlotMap,
  fitGrowthConfig,
  readJson,
  roundNumber,
  writeJson,
} from './shared/affix-pool-tools.js';

const buildSimplifiedAffix = (pool, affix, poolSlotMap, fitReport) => {
  const tiers = buildLegacyTierRows(pool, affix)
    .sort((left, right) => Number(left.tier) - Number(right.tier))
    .filter((tier) => Number.isFinite(Number(tier.tier)));
  if (tiers.length <= 0) {
    throw new Error(`${pool.id}:${affix.key} 没有可用 tiers`);
  }

  const startTier = Number(tiers[0].tier);
  const fit = fitGrowthConfig(tiers);
  const allowedSlots = Array.isArray(affix.allowed_slots) && affix.allowed_slots.length > 0
    ? affix.allowed_slots
    : (poolSlotMap.get(pool.id) ?? []);

  fitReport.push({
    poolId: pool.id,
    affixKey: affix.key,
    startTier,
    mode: fit.growth.mode,
    avgRelativeError: roundNumber(fit.error),
  });

  const nextAffix = {
    key: affix.key,
    name: affix.name,
    apply_type: affix.apply_type,
    group: affix.group,
    weight: affix.weight,
    start_tier: startTier,
    ...(allowedSlots.length > 0 ? { allowed_slots: allowedSlots } : {}),
    values: {
      main: {
        base: {
          min: roundNumber(Number(tiers[0].min)),
          max: roundNumber(Number(tiers[0].max)),
        },
        growth: fit.growth,
      },
    },
    ...(Array.isArray(affix.modifiers) && affix.modifiers.length > 0 ? { modifiers: affix.modifiers } : {}),
    ...(affix.is_legendary ? { is_legendary: true } : {}),
    ...(typeof affix.trigger === 'string' ? { trigger: affix.trigger } : {}),
    ...(typeof affix.target === 'string' ? { target: affix.target } : {}),
    ...(typeof affix.effect_type === 'string' ? { effect_type: affix.effect_type } : {}),
    ...(typeof affix.duration_round === 'number' ? { duration_round: affix.duration_round } : {}),
    ...(affix.params ? { params: affix.params } : {}),
    ...(SPECIAL_TEMPLATE_KEYS.has(affix.key) ? { description_template: affix.key } : {}),
  };

  return nextAffix;
};

const main = () => {
  const rawFile = readJson(affixPoolPath);
  const equipmentDefFile = readJson(equipmentDefPath);
  const poolSlotMap = buildPoolSlotMap(equipmentDefFile);
  const fitReport = [];

  const nextFile = {
    version: 3,
    description: '词条池种子数据 - 简化成长配置版',
    pools: (rawFile.pools ?? []).map((pool) => ({
      id: pool.id,
      name: pool.name,
      description: pool.description,
      rules: pool.rules,
      affixes: (pool.affixes ?? []).map((affix) => buildSimplifiedAffix(pool, affix, poolSlotMap, fitReport)),
      ...(typeof pool.enabled === 'boolean' ? { enabled: pool.enabled } : {}),
      ...(typeof pool.version === 'number' ? { version: pool.version } : {}),
    })),
  };

  writeJson(affixPoolPath, nextFile);

  const sortedReport = [...fitReport].sort((left, right) => right.avgRelativeError - left.avgRelativeError);
  const topRows = sortedReport.slice(0, 15);
  const avgError = roundNumber(
    sortedReport.reduce((sum, row) => sum + row.avgRelativeError, 0) / Math.max(1, sortedReport.length),
  );

  console.log(JSON.stringify({
    convertedPools: nextFile.pools.length,
    convertedAffixes: fitReport.length,
    avgRelativeError: avgError,
    topRelativeErrors: topRows,
  }, null, 2));
};

main();
