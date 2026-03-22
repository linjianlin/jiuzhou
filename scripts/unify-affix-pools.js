#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const affixPoolPath = path.resolve(projectRoot, 'server/src/data/seeds/affix_pool.json');
const equipmentDefPath = path.resolve(projectRoot, 'server/src/data/seeds/equipment_def.json');
const UNIFIED_POOL_ID = 'ap-equipment';

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const cloneJson = (value) => JSON.parse(JSON.stringify(value));

const normalizeMutexGroupKey = (group) => {
  return [...group].sort().join('::');
};

const mergeRules = (pools) => {
  const mutexGroupMap = new Map();
  let allowDuplicate = false;
  let legendaryChance = 0;

  for (const pool of pools) {
    if (pool.rules?.allow_duplicate === true) {
      allowDuplicate = true;
    }

    const chance = Number(pool.rules?.legendary_chance);
    if (Number.isFinite(chance)) {
      legendaryChance = Math.max(legendaryChance, chance);
    }

    for (const group of pool.rules?.mutex_groups ?? []) {
      if (!Array.isArray(group) || group.length <= 0) continue;
      const keys = group
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0);
      if (keys.length <= 0) continue;
      const dedupeKey = normalizeMutexGroupKey(keys);
      if (!mutexGroupMap.has(dedupeKey)) {
        mutexGroupMap.set(dedupeKey, keys);
      }
    }
  }

  return {
    allow_duplicate: allowDuplicate,
    ...(legendaryChance > 0 ? { legendary_chance: legendaryChance } : {}),
    ...(mutexGroupMap.size > 0 ? { mutex_groups: [...mutexGroupMap.values()] } : {}),
  };
};

const sortAffixes = (left, right) => {
  const leftGroup = typeof left.group === 'string' ? left.group : '';
  const rightGroup = typeof right.group === 'string' ? right.group : '';
  if (leftGroup !== rightGroup) {
    return leftGroup.localeCompare(rightGroup, 'zh-Hans-CN');
  }

  const leftKey = typeof left.key === 'string' ? left.key : '';
  const rightKey = typeof right.key === 'string' ? right.key : '';
  if (leftKey !== rightKey) {
    return leftKey.localeCompare(rightKey, 'zh-Hans-CN');
  }

  const leftSlots = Array.isArray(left.allowed_slots) ? left.allowed_slots.join(',') : '';
  const rightSlots = Array.isArray(right.allowed_slots) ? right.allowed_slots.join(',') : '';
  return leftSlots.localeCompare(rightSlots, 'zh-Hans-CN');
};

const main = () => {
  const affixPoolFile = readJson(affixPoolPath);
  const equipmentDefFile = readJson(equipmentDefPath);

  const sourcePools = (affixPoolFile.pools ?? []).filter((pool) => pool && pool.enabled !== false);
  if (sourcePools.length <= 0) {
    throw new Error('词缀池种子为空');
  }

  const unifiedAffixes = sourcePools
    .flatMap((pool) => (pool.affixes ?? []).map((affix) => cloneJson(affix)))
    .sort(sortAffixes);

  const nextAffixPoolFile = {
    ...affixPoolFile,
    pools: [
      {
        id: UNIFIED_POOL_ID,
        name: '装备总词条池',
        description: '装备统一总词条池，运行时按 allowed_slots 过滤',
        rules: mergeRules(sourcePools),
        affixes: unifiedAffixes,
      },
    ],
  };

  const nextEquipmentDefFile = {
    ...equipmentDefFile,
    items: (equipmentDefFile.items ?? []).map((item) => {
      if (String(item.category || '').trim() !== 'equipment') return item;
      return {
        ...item,
        affix_pool_id: UNIFIED_POOL_ID,
      };
    }),
  };

  fs.writeFileSync(affixPoolPath, `${JSON.stringify(nextAffixPoolFile, null, 2)}\n`, 'utf8');
  fs.writeFileSync(equipmentDefPath, `${JSON.stringify(nextEquipmentDefFile, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    poolId: UNIFIED_POOL_ID,
    affixCount: unifiedAffixes.length,
    equipmentCount: nextEquipmentDefFile.items.length,
  }, null, 2));
};

main();
