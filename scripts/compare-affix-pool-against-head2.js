#!/usr/bin/env node

import {
  affixPoolPath,
  DEFAULT_COMPARE_TARGET_REV,
  compareCurrentAffixFileWithLegacy,
  readGitJson,
  readJson,
  roundNumber,
} from './shared/affix-pool-tools.js';

/**
 * 词缀旧版对比摘要脚本
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：输出当前词缀与 `HEAD~2` 旧版在同部位、同词缀、同 T 档下的强弱变化摘要，给修正脚本和人工复核共用。
 * - 不做什么：不修改任何 seed，也不负责修正配置。
 *
 * 输入/输出：
 * - 输入：当前 `affix_pool.json`、`HEAD~2` 的旧版词缀/装备定义。
 * - 输出：JSON 摘要，包含明显变弱数量、按旧池聚合结果、最弱词缀列表。
 *
 * 数据流/状态流：
 * 当前词缀文件 + 历史 git 种子 -> 公共对比逻辑 -> 控制台摘要。
 *
 * 关键边界条件与坑点：
 * 1. 这里比较的是“同部位 + 同 key”的可比组合，不是只按词缀 key 粗暴聚合。
 * 2. 低档小数值的相对误差会天然偏大，所以摘要优先看 `T6+` 的加权变化与是否存在逐档低于旧版的情况。
 */

const summarizeByLegacyPool = (rows) => {
  const poolMap = new Map();
  for (const row of rows) {
    const current = poolMap.get(row.oldPoolId) ?? {
      oldPoolId: row.oldPoolId,
      compared: 0,
      weakerRows: 0,
      avgWeightedHighRel: 0,
    };
    current.compared += 1;
    current.avgWeightedHighRel += row.weightedHighRel;
    if (row.weakerTierCount > 0) {
      current.weakerRows += 1;
    }
    poolMap.set(row.oldPoolId, current);
  }

  return Array.from(poolMap.values())
    .map((row) => ({
      ...row,
      avgWeightedHighRel: roundNumber(row.avgWeightedHighRel / Math.max(1, row.compared)),
    }))
    .sort((left, right) => left.oldPoolId.localeCompare(right.oldPoolId, 'zh-Hans-CN'));
};

const summarizeWeakestKeys = (rows) => {
  const keyMap = new Map();
  for (const row of rows.filter((entry) => entry.weakerTierCount > 0)) {
    const groupKey = `${row.oldPoolId}::${row.key}`;
    const current = keyMap.get(groupKey) ?? {
      oldPoolId: row.oldPoolId,
      key: row.key,
      slots: [],
      weightedHighRelTotal: 0,
      lastTierRelTotal: 0,
      count: 0,
      weakerTierCount: 0,
    };
    current.slots.push(row.slot);
    current.weightedHighRelTotal += row.weightedHighRel;
    current.lastTierRelTotal += row.lastTierRel;
    current.count += 1;
    current.weakerTierCount += row.weakerTierCount;
    keyMap.set(groupKey, current);
  }

  return Array.from(keyMap.values())
    .map((row) => ({
      oldPoolId: row.oldPoolId,
      key: row.key,
      slots: [...new Set(row.slots)].sort(),
      avgWeightedHighRel: roundNumber(row.weightedHighRelTotal / Math.max(1, row.count)),
      avgLastTierRel: roundNumber(row.lastTierRelTotal / Math.max(1, row.count)),
      weakerTierCount: row.weakerTierCount,
    }))
    .sort((left, right) => left.avgWeightedHighRel - right.avgWeightedHighRel)
    .slice(0, 30);
};

const summarizeStrongestKeys = (rows, threshold) => {
  const keyMap = new Map();
  for (const row of rows.filter((entry) => entry.weightedHighRel >= threshold)) {
    const groupKey = `${row.oldPoolId}::${row.key}`;
    const current = keyMap.get(groupKey) ?? {
      oldPoolId: row.oldPoolId,
      key: row.key,
      slots: [],
      weightedHighRelTotal: 0,
      lastTierRelTotal: 0,
      count: 0,
    };
    current.slots.push(row.slot);
    current.weightedHighRelTotal += row.weightedHighRel;
    current.lastTierRelTotal += row.lastTierRel;
    current.count += 1;
    keyMap.set(groupKey, current);
  }

  return Array.from(keyMap.values())
    .map((row) => ({
      oldPoolId: row.oldPoolId,
      key: row.key,
      slots: [...new Set(row.slots)].sort(),
      avgWeightedHighRel: roundNumber(row.weightedHighRelTotal / Math.max(1, row.count)),
      avgLastTierRel: roundNumber(row.lastTierRelTotal / Math.max(1, row.count)),
    }))
    .sort((left, right) => right.avgWeightedHighRel - left.avgWeightedHighRel)
    .slice(0, 30);
};

const main = () => {
  const currentAffixPoolFile = readJson(affixPoolPath);
  const legacyAffixPoolFile = readGitJson(DEFAULT_COMPARE_TARGET_REV, 'server/src/data/seeds/affix_pool.json');
  const legacyEquipmentDefFile = readGitJson(DEFAULT_COMPARE_TARGET_REV, 'server/src/data/seeds/equipment_def.json');
  const compareRows = compareCurrentAffixFileWithLegacy(currentAffixPoolFile, legacyAffixPoolFile, legacyEquipmentDefFile);
  const weakerRows = compareRows.filter((row) => row.weakerTierCount > 0);

  console.log(JSON.stringify({
    targetRevision: DEFAULT_COMPARE_TARGET_REV,
    totals: {
      compared: compareRows.length,
      weakerRows: weakerRows.length,
      stableOrStrongerRows: compareRows.length - weakerRows.length,
    },
    byLegacyPool: summarizeByLegacyPool(compareRows),
    obviousStrongerKeys: summarizeStrongestKeys(compareRows, 0.15),
    notableStrongerKeys: summarizeStrongestKeys(compareRows, 0.08).filter(
      (row) => row.avgWeightedHighRel < 0.15,
    ),
    weakestKeys: summarizeWeakestKeys(compareRows),
  }, null, 2));
};

main();
