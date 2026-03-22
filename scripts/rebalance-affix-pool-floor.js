#!/usr/bin/env node

import {
  affixPoolPath,
  DEFAULT_COMPARE_TARGET_REV,
  cloneJson,
  compareCurrentAffixFileWithLegacy,
  expandSimplifiedAffixTiers,
  fitLowerBoundValueConfig,
  makeSlotAffixKey,
  readGitJson,
  readJson,
  resolvePrimaryValueSource,
  serializeTierSignature,
  sortAffixes,
  buildLegacySlotAffixMap,
  writeJson,
} from './shared/affix-pool-tools.js';

/**
 * 词缀旧版下限修正脚本
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：按 `HEAD~2` 的同部位旧版词缀曲线，为当前简化词缀配置建立逐档下限；只要当前更弱，就把当前配置抬到不低于旧版。
 * - 不做什么：不把当前配置精确回滚成旧版，也不改运行时逻辑与历史装备实例。
 *
 * 输入/输出：
 * - 输入：当前 `affix_pool.json`、`HEAD~2` 的 `affix_pool.json` 与 `equipment_def.json`。
 * - 输出：回写后的当前 `affix_pool.json`，以及修正摘要。
 *
 * 数据流/状态流：
 * 当前简化词缀 -> 按 slot+key 对上“旧版合并目标曲线” -> 反解成新的 base/growth -> 回写种子。
 *
 * 关键边界条件与坑点：
 * 1. 同一个 affix 若覆盖多个 `allowed_slots`，且旧版不同 slot 的曲线不同，必须先拆成多条定义再各自修正。
 * 2. 旧版同 slot+key 在多个品质池里可能重复出现；这里先合并成统一目标曲线，再做一次性拟合，避免被最后一个旧池覆盖。
 */

const legacyAffixPoolFile = readGitJson(DEFAULT_COMPARE_TARGET_REV, 'server/src/data/seeds/affix_pool.json');
const legacyEquipmentDefFile = readGitJson(DEFAULT_COMPARE_TARGET_REV, 'server/src/data/seeds/equipment_def.json');
const legacySlotAffixMap = buildLegacySlotAffixMap(legacyAffixPoolFile, legacyEquipmentDefFile);

const splitAffixByLegacySlotSignature = (affix) => {
  const allowedSlots = Array.isArray(affix.allowed_slots) ? affix.allowed_slots : [];
  if (allowedSlots.length <= 1) {
    return [cloneJson(affix)];
  }

  const groupMap = new Map();
  for (const slot of allowedSlots) {
    const legacyAffix = legacySlotAffixMap.get(makeSlotAffixKey(slot, affix.key));
    const signature = serializeTierSignature(legacyAffix?.tiers);
    const group = groupMap.get(signature) ?? [];
    group.push(slot);
    groupMap.set(signature, group);
  }

  return Array.from(groupMap.values()).map((slots) => ({
    ...cloneJson(affix),
    allowed_slots: [...slots].sort(),
  }));
};

const isTierSeriesEqual = (left, right) => {
  if (left.length !== right.length) return false;
  return left.every((tier, index) => (
    Number(tier.tier) === Number(right[index]?.tier)
    && Number(tier.min) === Number(right[index]?.min)
    && Number(tier.max) === Number(right[index]?.max)
  ));
};

const rebalanceAffix = (affix) => {
  const primaryValueSource = resolvePrimaryValueSource(affix);
  const currentTiers = expandSimplifiedAffixTiers(affix, primaryValueSource);
  const legacyTierGroups = (affix.allowed_slots ?? [])
    .map((slot) => legacySlotAffixMap.get(makeSlotAffixKey(slot, affix.key))?.tiers)
    .filter((tiers) => Array.isArray(tiers) && tiers.length > 0);

  if (legacyTierGroups.length <= 0) {
    return {
      affix,
      adjusted: false,
    };
  }

  const targetTiers = legacyTierGroups[0] ?? [];
  const comparableCurrentTiers = currentTiers.filter((tier) => targetTiers.some((targetTier) => targetTier.tier === tier.tier));
  if (isTierSeriesEqual(comparableCurrentTiers, targetTiers)) {
    return {
      affix,
      adjusted: false,
    };
  }

  const nextAffix = cloneJson(affix);
  nextAffix.values[primaryValueSource] = fitLowerBoundValueConfig(
    nextAffix.values[primaryValueSource],
    targetTiers,
    nextAffix.start_tier,
  );
  return {
    affix: nextAffix,
    adjusted: true,
  };
};

const main = () => {
  const currentAffixPoolFile = readJson(affixPoolPath);
  const splitAffixKeys = [];
  let adjustedAffixCount = 0;

  const nextFile = {
    ...currentAffixPoolFile,
    pools: (currentAffixPoolFile.pools ?? []).map((pool) => {
      const nextAffixes = [];
      for (const rawAffix of pool.affixes ?? []) {
        const splitAffixes = splitAffixByLegacySlotSignature(rawAffix);
        if (splitAffixes.length > 1) {
          splitAffixKeys.push(rawAffix.key);
        }

        for (const affix of splitAffixes) {
          const rebalanced = rebalanceAffix(affix);
          if (rebalanced.adjusted) {
            adjustedAffixCount += 1;
          }
          nextAffixes.push(rebalanced.affix);
        }
      }

      return {
        ...pool,
        affixes: nextAffixes.sort(sortAffixes),
      };
    }),
  };

  writeJson(affixPoolPath, nextFile);

  const compareRows = compareCurrentAffixFileWithLegacy(nextFile, legacyAffixPoolFile, legacyEquipmentDefFile);
  const weakerRows = compareRows.filter((row) => row.weakerTierCount > 0);

  console.log(JSON.stringify({
    targetRevision: DEFAULT_COMPARE_TARGET_REV,
    adjustedAffixCount,
    splitAffixKeys: [...new Set(splitAffixKeys)].sort(),
    compareTotals: {
      compared: compareRows.length,
      weakerRows: weakerRows.length,
    },
    weakestExamples: weakerRows.slice(0, 20),
  }, null, 2));
};

main();
