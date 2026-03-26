#!/usr/bin/env tsx
/**
 * 装备消耗模拟脚本（强化/精炼/洗炼）
 *
 * 作用：
 * - 复用服务端真实成本函数，按传入参数输出强化/精炼/洗炼消耗表，便于调参对比。
 * - 仅做离线模拟展示，不写库、不改配置、不触发游戏流程。
 *
 * 输入/输出：
 * - 输入：CLI 参数（mode、realm/realm-rank、等级区间、锁定上限）。
 * - 输出：标准输出表格（强化成本表、精炼成本表、洗炼成本表）。
 *
 * 数据流：
 * - 解析参数 -> 归一化境界 -> 调用 buildEnhanceCostPlan/buildRefineCostPlan/buildAffixRerollCostPlan -> 格式化输出。
 *
 * 关键边界条件与坑点：
 * 1) realm-rank 仅支持 1..REALM_ORDER.length，超出会直接报错退出，避免误判为“凡人”。
 * 2) 强化/精炼等级范围与锁定词条上限会做硬校验，非法参数直接报错，避免输出误导数据。
 */

import '../src/bootstrap/installConsoleLogger.js';
import { buildEnhanceCostPlan, buildRefineCostPlan, REFINE_MAX_LEVEL } from '../src/services/equipmentGrowthRules.js';
import { buildAffixRerollCostPlan } from '../src/services/equipmentAffixRerollRules.js';
import { getRealmRankOneBasedForEquipment, REALM_ORDER } from '../src/services/shared/realmRules.js';

type SimMode = 'enhance' | 'refine' | 'reroll' | 'all';

interface SimOptions {
  mode: SimMode;
  realmRaw: string;
  startEnhanceLevel: number;
  endEnhanceLevel: number;
  startRefineLevel: number;
  endRefineLevel: number;
  maxLock: number;
}

interface ArgMap {
  [key: string]: string | undefined;
}

const DEFAULTS = {
  mode: 'all' as SimMode,
  realmRaw: '炼虚合道·成圣期',
  startEnhanceLevel: 1,
  endEnhanceLevel: 20,
  startRefineLevel: 1,
  endRefineLevel: REFINE_MAX_LEVEL,
  maxLock: 5,
};

const MATERIAL_NAME_BY_ID: Record<string, string> = {
  'enhance-001': '淬灵石',
  'enhance-002': '蕴灵石',
};

const EXIT_CODE_INVALID_ARGS = 1;

const usageText = `
用法：
  pnpm --filter ./server simulate:equipment-cost -- [参数]
  pnpm --filter ./server tsx scripts/simulate-equipment-costs.ts -- [参数]

参数：
  --mode <enhance|refine|reroll|all> 模拟类型（默认 all）
  --realm <境界文本>                装备需求境界（默认 炼虚合道·成圣期）
  --realm-rank <数字>              装备需求境界档位（1..${REALM_ORDER.length}，优先级高于 --realm）
  --start-level <数字>             强化起始目标等级（默认 1）
  --end-level <数字>               强化结束目标等级（默认 ${DEFAULTS.endEnhanceLevel}）
  --start-refine-level <数字>      精炼起始目标等级（默认 1）
  --end-refine-level <数字>        精炼结束目标等级（默认 ${REFINE_MAX_LEVEL}）
  --max-lock <数字>                洗炼最大锁定词条数（默认 5）
  --help                           显示帮助

示例：
  pnpm --filter ./server simulate:equipment-cost -- --mode enhance --realm-rank 13
  pnpm --filter ./server simulate:equipment-cost -- --mode refine --start-refine-level 1 --end-refine-level 10
  pnpm --filter ./server simulate:equipment-cost -- --mode reroll --realm 炼炁化神·炼己期 --max-lock 4
`;

const parseArgMap = (argv: string[]): ArgMap => {
  const map: ArgMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      map[key] = 'true';
      continue;
    }
    map[key] = next;
    i += 1;
  }
  return map;
};

const parseIntStrict = (raw: string | undefined, fieldName: string): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} 必须是整数，当前为：${raw}`);
  }
  return parsed;
};

const assertRange = (value: number, min: number, max: number, fieldName: string): void => {
  if (value < min || value > max) {
    throw new Error(`${fieldName} 超出范围，允许区间：${min}..${max}，当前：${value}`);
  }
};

const resolveMode = (raw: string | undefined): SimMode => {
  const value = (raw ?? DEFAULTS.mode).trim();
  if (value === 'enhance' || value === 'refine' || value === 'reroll' || value === 'all') return value;
  throw new Error(`mode 非法：${value}，可选值：enhance | refine | reroll | all`);
};

const resolveRealmRaw = (args: ArgMap): string => {
  const rankArg = parseIntStrict(args['realm-rank'], 'realm-rank');
  if (rankArg !== null) {
    assertRange(rankArg, 1, REALM_ORDER.length, 'realm-rank');
    return REALM_ORDER[rankArg - 1] ?? DEFAULTS.realmRaw;
  }
  const realmArg = args.realm?.trim();
  if (realmArg) return realmArg;
  return DEFAULTS.realmRaw;
};

const toSimOptions = (args: ArgMap): SimOptions => {
  const mode = resolveMode(args.mode);
  const realmRaw = resolveRealmRaw(args);
  const startEnhanceLevel = parseIntStrict(args['start-level'], 'start-level') ?? DEFAULTS.startEnhanceLevel;
  const endEnhanceLevel = parseIntStrict(args['end-level'], 'end-level') ?? DEFAULTS.endEnhanceLevel;
  const startRefineLevel = parseIntStrict(args['start-refine-level'], 'start-refine-level') ?? DEFAULTS.startRefineLevel;
  const endRefineLevel = parseIntStrict(args['end-refine-level'], 'end-refine-level') ?? DEFAULTS.endRefineLevel;
  const maxLock = parseIntStrict(args['max-lock'], 'max-lock') ?? DEFAULTS.maxLock;

  assertRange(startEnhanceLevel, 1, Number.MAX_SAFE_INTEGER, 'start-level');
  assertRange(endEnhanceLevel, 1, Number.MAX_SAFE_INTEGER, 'end-level');
  if (startEnhanceLevel > endEnhanceLevel) {
    throw new Error(`start-level 不能大于 end-level，当前：${startEnhanceLevel} > ${endEnhanceLevel}`);
  }

  assertRange(startRefineLevel, 1, REFINE_MAX_LEVEL, 'start-refine-level');
  assertRange(endRefineLevel, 1, REFINE_MAX_LEVEL, 'end-refine-level');
  if (startRefineLevel > endRefineLevel) {
    throw new Error(`start-refine-level 不能大于 end-refine-level，当前：${startRefineLevel} > ${endRefineLevel}`);
  }
  assertRange(maxLock, 0, 30, 'max-lock');

  return {
    mode,
    realmRaw,
    startEnhanceLevel,
    endEnhanceLevel,
    startRefineLevel,
    endRefineLevel,
    maxLock,
  };
};

const padRight = (value: string, width: number): string => {
  if (value.length >= width) return value;
  return value + ' '.repeat(width - value.length);
};

const renderTable = (headers: string[], rows: Array<Array<string | number>>): string => {
  const stringRows = rows.map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((header, col) => {
    const bodyMax = stringRows.reduce((max, row) => Math.max(max, row[col]?.length ?? 0), 0);
    return Math.max(header.length, bodyMax);
  });

  const headerLine = headers.map((header, col) => padRight(header, widths[col] ?? header.length)).join(' | ');
  const splitLine = widths.map((w) => '-'.repeat(w)).join('-|-');
  const bodyLines = stringRows.map((row) => row.map((cell, col) => padRight(cell, widths[col] ?? cell.length)).join(' | '));

  return [headerLine, splitLine, ...bodyLines].join('\n');
};

const printEnhanceTable = (options: SimOptions): void => {
  const rows: Array<Array<string | number>> = [];
  const realmRank = getRealmRankOneBasedForEquipment(options.realmRaw);
  for (let level = options.startEnhanceLevel; level <= options.endEnhanceLevel; level += 1) {
    const plan = buildEnhanceCostPlan(level, realmRank);
    const materialName = MATERIAL_NAME_BY_ID[plan.materialItemDefId] ?? plan.materialItemDefId;
    rows.push([
      level,
      materialName,
      plan.materialQty,
      plan.silverCost,
      plan.spiritStoneCost,
    ]);
  }

  console.log('\n[强化消耗模拟]');
  console.log(renderTable(['目标等级', '材料', '数量', '银两', '灵石'], rows));
};

const printRefineTable = (options: SimOptions): void => {
  const rows: Array<Array<string | number>> = [];
  const realmRank = getRealmRankOneBasedForEquipment(options.realmRaw);
  for (let level = options.startRefineLevel; level <= options.endRefineLevel; level += 1) {
    const plan = buildRefineCostPlan(level, realmRank);
    const materialName = MATERIAL_NAME_BY_ID[plan.materialItemDefId] ?? plan.materialItemDefId;
    rows.push([
      level,
      materialName,
      plan.materialQty,
      plan.silverCost,
      plan.spiritStoneCost,
    ]);
  }

  console.log('\n[精炼消耗模拟]');
  console.log(renderTable(['目标等级', '材料', '数量', '银两', '灵石'], rows));
};

const printRerollTable = (options: SimOptions): void => {
  const rows: Array<Array<string | number>> = [];
  for (let lockCount = 0; lockCount <= options.maxLock; lockCount += 1) {
    const plan = buildAffixRerollCostPlan(options.realmRaw, lockCount);
    rows.push([
      lockCount,
      plan.rerollScrollQty,
      plan.silverCost,
      plan.spiritStoneCost,
    ]);
  }

  console.log('\n[洗炼消耗模拟]');
  console.log(renderTable(['锁定词条数', '洗炼符数量', '银两', '灵石'], rows));
};

const main = (): void => {
  const args = parseArgMap(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(usageText.trim());
    return;
  }

  try {
    const options = toSimOptions(args);
    const realmRank = getRealmRankOneBasedForEquipment(options.realmRaw);
    console.log(`模拟模式: ${options.mode}`);
    console.log(`装备需求境界: ${options.realmRaw}`);
    console.log(`解析境界档位: ${realmRank}`);

    if (options.mode === 'enhance' || options.mode === 'all') {
      printEnhanceTable(options);
    }
    if (options.mode === 'refine' || options.mode === 'all') {
      printRefineTable(options);
    }
    if (options.mode === 'reroll' || options.mode === 'all') {
      printRerollTable(options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '参数解析失败';
    console.error(`参数错误: ${message}`);
    console.error('\n' + usageText.trim());
    process.exit(EXIT_CODE_INVALID_ARGS);
  }
};

main();
