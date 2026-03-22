import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * 词缀池脚本公共工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一脚本层对旧版词缀、简化词缀、部位映射、下限对比的读取与计算，避免转换脚本、修正脚本、对比脚本各写一套。
 * - 不做什么：不参与运行时掉落与洗炼逻辑，也不直接修改历史装备实例。
 *
 * 输入/输出：
 * - 输入：当前/历史 `affix_pool.json`、历史 `equipment_def.json`、简化词缀配置对象。
 * - 输出：可复用的 tiers 展开结果、旧版按部位映射结果、下限对比摘要。
 *
 * 数据流/状态流：
 * 种子文件或 git 历史 -> 公共读取/展开 -> 转换脚本 / 修正脚本 / 对比脚本共用。
 *
 * 关键边界条件与坑点：
 * 1. 旧版词缀是否属于哪个部位，不看词缀自身，而是通过旧版 `equipment_def.json` 的 `affix_pool_id -> equip_slot` 映射来恢复。
 * 2. 当前简化模型允许同 key 多条定义并用 `allowed_slots` 区分曲线；脚本层必须保留这条能力，不能回退成“同 key 只算一条”。
 */

export const projectRoot = process.cwd();
export const affixPoolPath = path.resolve(projectRoot, 'server/src/data/seeds/affix_pool.json');
export const equipmentDefPath = path.resolve(projectRoot, 'server/src/data/seeds/equipment_def.json');
export const MAX_TIER = 10;
export const COMPARE_HIGH_TIER_START = 6;
export const DEFAULT_COMPARE_TARGET_REV = 'HEAD~2';
const FLOOR_EPSILON = 0.000001;

export const SPECIAL_TEMPLATE_KEYS = new Set([
  'proc_zhuihun',
  'proc_tianlei',
  'proc_baonu',
  'proc_hushen',
  'proc_fansha',
  'proc_lingchao',
  'proc_duanxing',
  'proc_huixiang',
  'proc_xuangang',
]);

export const roundNumber = (value) => Number(Number(value).toFixed(6));

export const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

export const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

export const cloneJson = (value) => JSON.parse(JSON.stringify(value));

export const readGitJson = (revision, relativePath) => {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const raw = execSync(`git show ${revision}:${normalizedPath}`, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return JSON.parse(raw);
};

export const makeSlotAffixKey = (slot, key) => `${String(slot).trim()}::${String(key).trim()}`;

export const buildPoolSlotMap = (equipmentDefFile) => {
  const slotMap = new Map();
  for (const item of equipmentDefFile.items ?? []) {
    const poolId = typeof item.affix_pool_id === 'string' ? item.affix_pool_id.trim() : '';
    const equipSlot = typeof item.equip_slot === 'string' ? item.equip_slot.trim() : '';
    if (!poolId || !equipSlot) continue;
    const slots = slotMap.get(poolId) ?? new Set();
    slots.add(equipSlot);
    slotMap.set(poolId, slots);
  }

  return new Map(
    Array.from(slotMap.entries()).map(([poolId, slotSet]) => [poolId, Array.from(slotSet).sort()]),
  );
};

const findLegacyGrowthStep = (growthSteps, tier) => {
  const step = growthSteps.find((entry) => tier >= entry.from_tier && tier <= entry.to_tier);
  if (!step) {
    throw new Error(`缺少 T${tier} 的 legacy growth step`);
  }
  return step;
};

export const buildLegacyTierRows = (pool, affix) => {
  if (Array.isArray(affix.tiers)) {
    return affix.tiers.map((tier) => ({
      tier: Number(tier.tier),
      min: Number(tier.min),
      max: Number(tier.max),
      realm_rank_min: Number(tier.realm_rank_min),
      ...(typeof tier.description === 'string' ? { description: tier.description } : {}),
    }));
  }

  if (!affix.tier_rule) {
    throw new Error(`${pool.id}:${affix.key} 既没有 tiers 也没有 tier_rule`);
  }

  const presetName = typeof affix.tier_rule.preset === 'string' ? affix.tier_rule.preset.trim() : '';
  const preset = presetName ? pool.tier_rule_presets?.[presetName] : undefined;
  const growthSteps = [
    ...(Array.isArray(preset?.growth) ? preset.growth : []),
    ...(Array.isArray(affix.tier_rule.growth) ? affix.tier_rule.growth : []),
  ];
  const endTier = Number(affix.tier_rule.end_tier ?? preset?.end_tier ?? MAX_TIER);
  const overrides = Array.isArray(affix.tier_rule.overrides) ? affix.tier_rule.overrides : [];

  let currentMin = roundNumber(Number(affix.tier_rule.base.min));
  let currentMax = roundNumber(Number(affix.tier_rule.base.max));
  const tiers = [];

  for (let tier = Number(affix.tier_rule.start_tier); tier <= endTier; tier += 1) {
    const override = overrides.find((entry) => Number(entry.tier) === tier);
    tiers.push({
      tier,
      min: override?.min === undefined ? currentMin : roundNumber(Number(override.min)),
      max: override?.max === undefined ? currentMax : roundNumber(Number(override.max)),
      realm_rank_min: tier,
      ...(typeof override?.description === 'string' ? { description: override.description } : {}),
    });

    if (tier >= endTier) continue;
    const step = findLegacyGrowthStep(growthSteps, tier + 1);
    if (step.mode === 'flat') {
      currentMin = roundNumber(currentMin + Number(step.min_delta));
      currentMax = roundNumber(currentMax + Number(step.max_delta));
      continue;
    }

    currentMin = roundNumber(currentMin * (1 + Number(step.min_rate)));
    currentMax = roundNumber(currentMax * (1 + Number(step.max_rate)));
  }

  return tiers;
};

export const buildFlatSeries = (baseValue, delta, length) => {
  const values = [];
  let current = roundNumber(baseValue);
  for (let index = 0; index < length; index += 1) {
    values.push(current);
    if (index >= length - 1) continue;
    current = roundNumber(current + delta);
  }
  return values;
};

export const buildPercentSeries = (baseValue, rate, length) => {
  const values = [];
  let current = roundNumber(baseValue);
  for (let index = 0; index < length; index += 1) {
    values.push(current);
    if (index >= length - 1) continue;
    current = roundNumber(current * (1 + rate));
  }
  return values;
};

const calcSeriesError = (actualValues, predictedValues) => {
  let totalError = 0;
  for (let index = 0; index < actualValues.length; index += 1) {
    const actual = Number(actualValues[index]);
    const predicted = Number(predictedValues[index]);
    const scale = Math.max(1, Math.abs(actual));
    totalError += Math.abs(predicted - actual) / scale;
  }
  return totalError / Math.max(1, actualValues.length);
};

const fitDimension = (actualValues, mode) => {
  if (actualValues.length <= 1) {
    return {
      parameter: 0,
      error: 0,
      predicted: [roundNumber(actualValues[0] ?? 0)],
    };
  }

  const baseValue = Number(actualValues[0]);
  if (!Number.isFinite(baseValue)) {
    throw new Error('非法的 baseValue');
  }

  if (mode === 'flat') {
    const delta = roundNumber((Number(actualValues[actualValues.length - 1]) - baseValue) / (actualValues.length - 1));
    const predicted = buildFlatSeries(baseValue, delta, actualValues.length);
    return {
      parameter: delta,
      error: calcSeriesError(actualValues, predicted),
      predicted,
    };
  }

  const hasInvalid = actualValues.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0);
  if (hasInvalid || baseValue <= 0) {
    return {
      parameter: 0,
      error: Number.POSITIVE_INFINITY,
      predicted: actualValues.map((value) => roundNumber(Number(value))),
    };
  }

  const rate = roundNumber(
    Math.exp(
      (Math.log(Number(actualValues[actualValues.length - 1])) - Math.log(baseValue)) / (actualValues.length - 1),
    ) - 1,
  );
  const predicted = buildPercentSeries(baseValue, rate, actualValues.length);
  return {
    parameter: rate,
    error: calcSeriesError(actualValues, predicted),
    predicted,
  };
};

const buildModeFit = (tiers, mode) => {
  const minValues = tiers.map((tier) => Number(tier.min));
  const maxValues = tiers.map((tier) => Number(tier.max));
  const minFit = fitDimension(minValues, mode);
  const maxFit = fitDimension(maxValues, mode);

  if (mode === 'percent') {
    return {
      growth: {
        mode: 'percent',
        min_rate: minFit.parameter,
        max_rate: maxFit.parameter,
      },
      error: (minFit.error + maxFit.error) / 2,
      predictedMin: minFit.predicted,
      predictedMax: maxFit.predicted,
    };
  }

  return {
    growth: {
      mode: 'flat',
      min_delta: minFit.parameter,
      max_delta: maxFit.parameter,
    },
    error: (minFit.error + maxFit.error) / 2,
    predictedMin: minFit.predicted,
    predictedMax: maxFit.predicted,
  };
};

export const fitGrowthConfig = (tiers) => {
  const flatFit = buildModeFit(tiers, 'flat');
  const percentFit = buildModeFit(tiers, 'percent');
  return percentFit.error < flatFit.error ? percentFit : flatFit;
};

export const resolvePrimaryValueSource = (affix) => {
  const configuredKey = typeof affix.primary_value_source === 'string' ? affix.primary_value_source.trim() : '';
  if (configuredKey) {
    if (!affix.values?.[configuredKey]) {
      throw new Error(`${affix.key} primary_value_source=${configuredKey} 未在 values 中定义`);
    }
    return configuredKey;
  }

  const firstKey = Object.keys(affix.values ?? {})[0]?.trim() ?? '';
  if (!firstKey) {
    throw new Error(`${affix.key} 缺少可用的 value source`);
  }
  return firstKey;
};

export const expandValueConfigSeries = (startTier, valueConfig, maxTier = MAX_TIER) => {
  const tiers = [];
  let currentMin = roundNumber(Number(valueConfig.base.min));
  let currentMax = roundNumber(Number(valueConfig.base.max));

  for (let tier = Number(startTier); tier <= maxTier; tier += 1) {
    tiers.push({
      tier,
      min: currentMin,
      max: currentMax,
      realm_rank_min: tier,
    });

    if (tier >= maxTier) continue;
    if (valueConfig.growth.mode === 'flat') {
      currentMin = roundNumber(currentMin + Number(valueConfig.growth.min_delta));
      currentMax = roundNumber(currentMax + Number(valueConfig.growth.max_delta));
      continue;
    }

    currentMin = roundNumber(currentMin * (1 + Number(valueConfig.growth.min_rate)));
    currentMax = roundNumber(currentMax * (1 + Number(valueConfig.growth.max_rate)));
  }

  return tiers;
};

export const expandSimplifiedAffixTiers = (affix, valueSource = resolvePrimaryValueSource(affix)) => {
  const valueConfig = affix.values?.[valueSource];
  if (!valueConfig) {
    throw new Error(`${affix.key} 缺少 value source=${valueSource}`);
  }
  return expandValueConfigSeries(Number(affix.start_tier), valueConfig);
};

export const sortAffixes = (left, right) => {
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

export const buildLegacySlotAffixMap = (legacyAffixPoolFile, legacyEquipmentDefFile) => {
  const poolSlotMap = buildPoolSlotMap(legacyEquipmentDefFile);
  const slotAffixMap = new Map();

  for (const pool of legacyAffixPoolFile.pools ?? []) {
    const slots = poolSlotMap.get(pool.id) ?? [];
    for (const affix of pool.affixes ?? []) {
      const tiers = buildLegacyTierRows(pool, affix).sort((left, right) => left.tier - right.tier);
      for (const slot of slots) {
        const slotAffixKey = makeSlotAffixKey(slot, affix.key);
        const current = slotAffixMap.get(slotAffixKey) ?? {
          slot,
          key: affix.key,
          poolIds: [],
          tierGroups: [],
          tiers: [],
        };
        current.poolIds.push(pool.id);
        current.tierGroups.push(tiers);
        slotAffixMap.set(slotAffixKey, current);
      }
    }
  }

  for (const entry of slotAffixMap.values()) {
    const tierMap = new Map();
    for (const tierGroup of entry.tierGroups) {
      for (const tier of tierGroup) {
        const currentTier = tierMap.get(tier.tier);
        if (!currentTier) {
          tierMap.set(tier.tier, {
            tier: Number(tier.tier),
            min: Number(tier.min),
            max: Number(tier.max),
            realm_rank_min: Number(tier.realm_rank_min),
          });
          continue;
        }

        tierMap.set(tier.tier, {
          tier: Number(tier.tier),
          min: Math.max(Number(currentTier.min), Number(tier.min)),
          max: Math.max(Number(currentTier.max), Number(tier.max)),
          realm_rank_min: Number(tier.realm_rank_min),
        });
      }
    }

    entry.poolIds = [...new Set(entry.poolIds)].sort();
    entry.tiers = Array.from(tierMap.values()).sort((left, right) => left.tier - right.tier);
  }

  return slotAffixMap;
};

export const buildCurrentSlotAffixMap = (currentAffixPoolFile) => {
  const slotAffixMap = new Map();

  for (const pool of currentAffixPoolFile.pools ?? []) {
    for (const affix of pool.affixes ?? []) {
      const tiers = expandSimplifiedAffixTiers(affix);
      for (const slot of affix.allowed_slots ?? []) {
        slotAffixMap.set(makeSlotAffixKey(slot, affix.key), {
          slot,
          key: affix.key,
          poolId: pool.id,
          tiers,
        });
      }
    }
  }

  return slotAffixMap;
};

export const serializeTierSignature = (tiers) => {
  if (!tiers) return 'none';
  return JSON.stringify(
    tiers.map((tier) => [Number(tier.tier), roundNumber(Number(tier.min)), roundNumber(Number(tier.max))]),
  );
};

export const compareCurrentAffixFileWithLegacy = (
  currentAffixPoolFile,
  legacyAffixPoolFile,
  legacyEquipmentDefFile,
  highTierStart = COMPARE_HIGH_TIER_START,
) => {
  const legacySlotAffixMap = buildLegacySlotAffixMap(legacyAffixPoolFile, legacyEquipmentDefFile);
  const currentSlotAffixMap = buildCurrentSlotAffixMap(currentAffixPoolFile);
  const rows = [];

  for (const [slotAffixKey, legacyAffix] of legacySlotAffixMap.entries()) {
    const currentAffix = currentSlotAffixMap.get(slotAffixKey);
    if (!currentAffix) continue;

    const currentTierMap = new Map(currentAffix.tiers.map((tier) => [tier.tier, tier]));
    const overlap = legacyAffix.tiers
      .map((legacyTier) => ({ legacyTier, currentTier: currentTierMap.get(legacyTier.tier) }))
      .filter((row) => row.currentTier);
    if (overlap.length <= 0) continue;

    const pickedHighTiers = overlap.filter((row) => row.legacyTier.tier >= highTierStart);
    const weightedRows = pickedHighTiers.length > 0 ? pickedHighTiers : overlap;
    const oldWeightedMid = weightedRows.reduce((sum, row) => sum + (row.legacyTier.min + row.legacyTier.max) / 2, 0);
    const currentWeightedMid = weightedRows.reduce((sum, row) => sum + (row.currentTier.min + row.currentTier.max) / 2, 0);
    const lastRow = overlap[overlap.length - 1];
    const oldLastMid = (lastRow.legacyTier.min + lastRow.legacyTier.max) / 2;
    const currentLastMid = (lastRow.currentTier.min + lastRow.currentTier.max) / 2;

    rows.push({
      slot: legacyAffix.slot,
      key: legacyAffix.key,
      oldPoolId: legacyAffix.poolIds.join('|'),
      currentPoolId: currentAffix.poolId,
      overlapCount: overlap.length,
      weightedHighRel: oldWeightedMid === 0 ? 0 : (currentWeightedMid - oldWeightedMid) / oldWeightedMid,
      lastTier: lastRow.legacyTier.tier,
      lastTierRel: oldLastMid === 0 ? 0 : (currentLastMid - oldLastMid) / oldLastMid,
      weakerTierCount: overlap.filter(
        (row) => row.currentTier.min < row.legacyTier.min || row.currentTier.max < row.legacyTier.max,
      ).length,
    });
  }

  return rows;
};

const buildConstrainedValueConfig = (startTier, floorTiers, mode) => {
  const fittedGrowth = buildModeFit(floorTiers, mode).growth;
  const minFloors = floorTiers.map((tier) => Number(tier.min));
  const maxFloors = floorTiers.map((tier) => Number(tier.max));

  if (fittedGrowth.mode === 'flat') {
    const minDelta = roundNumber(Number(fittedGrowth.min_delta));
    const maxDelta = roundNumber(Number(fittedGrowth.max_delta));
    let baseMin = roundNumber(minFloors[0]);
    let baseMax = roundNumber(maxFloors[0]);

    for (let index = 0; index < floorTiers.length; index += 1) {
      const stepIndex = Number(floorTiers[index].tier) - Number(startTier);
      baseMin = roundNumber(Math.max(baseMin, minFloors[index] - stepIndex * minDelta + FLOOR_EPSILON));
      baseMax = roundNumber(Math.max(baseMax, maxFloors[index] - stepIndex * maxDelta + FLOOR_EPSILON));
    }

    return {
      base: {
        min: baseMin,
        max: baseMax,
      },
      growth: {
        mode: 'flat',
        min_delta: minDelta,
        max_delta: maxDelta,
      },
    };
  }

  let baseMin = roundNumber(minFloors[0]);
  let baseMax = roundNumber(maxFloors[0]);
  if (baseMin <= 0 || baseMax <= 0) {
    throw new Error('percent 模式的 floor 首档必须大于 0');
  }

  const minRate = roundNumber(Number(fittedGrowth.min_rate));
  const maxRate = roundNumber(Number(fittedGrowth.max_rate));
  for (let index = 0; index < floorTiers.length; index += 1) {
    if (minFloors[index] <= 0 || maxFloors[index] <= 0) {
      throw new Error('percent 模式的 floor 全部档位必须大于 0');
    }
    const stepIndex = Number(floorTiers[index].tier) - Number(startTier);
    baseMin = roundNumber(Math.max(baseMin, minFloors[index] / Math.pow(1 + minRate, stepIndex) + FLOOR_EPSILON));
    baseMax = roundNumber(Math.max(baseMax, maxFloors[index] / Math.pow(1 + maxRate, stepIndex) + FLOOR_EPSILON));
  }

  return {
    base: {
      min: baseMin,
      max: baseMax,
    },
    growth: {
      mode: 'percent',
      min_rate: minRate,
      max_rate: maxRate,
    },
  };
};

const scoreValueConfigAgainstFloors = (startTier, valueConfig, floorTiers) => {
  const expanded = expandValueConfigSeries(startTier, valueConfig, Math.max(...floorTiers.map((tier) => Number(tier.tier))));
  const expandedMap = new Map(expanded.map((tier) => [tier.tier, tier]));
  let excessScore = 0;

  for (const floorTier of floorTiers) {
    const expandedTier = expandedMap.get(Number(floorTier.tier));
    if (!expandedTier) {
      return Number.POSITIVE_INFINITY;
    }
    if (expandedTier.min < Number(floorTier.min) || expandedTier.max < Number(floorTier.max)) {
      return Number.POSITIVE_INFINITY;
    }

    const minScale = Math.max(1, Math.abs(Number(floorTier.min)));
    const maxScale = Math.max(1, Math.abs(Number(floorTier.max)));
    excessScore += (expandedTier.min - Number(floorTier.min)) / minScale;
    excessScore += (expandedTier.max - Number(floorTier.max)) / maxScale;
  }

  return excessScore;
};

export const fitLowerBoundValueConfig = (valueConfig, floorTiers, startTier) => {
  if (!Array.isArray(floorTiers) || floorTiers.length <= 0) {
    throw new Error('floorTiers 不能为空');
  }

  const normalizedStartTier = Number(startTier ?? floorTiers[0]?.tier ?? 1);
  const candidateModes = ['flat', 'percent'];
  const candidates = [];

  for (const mode of candidateModes) {
    try {
      const candidate = buildConstrainedValueConfig(normalizedStartTier, floorTiers, mode);
      candidates.push({
        valueConfig: candidate,
        score: scoreValueConfigAgainstFloors(normalizedStartTier, candidate, floorTiers),
        sameMode: candidate.growth.mode === valueConfig.growth.mode,
      });
    } catch {
      continue;
    }
  }

  const validCandidates = candidates
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      if (left.sameMode !== right.sameMode) {
        return left.sameMode ? -1 : 1;
      }
      return 0;
    });

  const bestCandidate = validCandidates[0];
  if (!bestCandidate) {
    throw new Error('无法构造满足旧版下限的成长配置');
  }

  return bestCandidate.valueConfig;
};
