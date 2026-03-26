#!/usr/bin/env tsx
/**
 * 防御收益模拟脚本（战斗减伤曲线）
 *
 * 作用：
 * - 复用战斗模块的统一减伤参数，离线模拟“攻防对抗曲线”在不同防御值下的收益变化。
 * - 支持同时对比多个系数（默认旧值 2.8 与当前配置值），直观看到每档防御的减伤率与承伤差异。
 * - 不接入数据库、不改战斗状态，仅输出控制台表格用于调参评估。
 *
 * 输入/输出：
 * - 输入：CLI 参数（攻击、防御区间、步长、系数列表、常量偏移、基准伤害）。
 * - 输出：标准输出表格（各防御档位在不同系数下的减伤率/预计承伤，以及对比提升）。
 *
 * 数据流：
 * - 解析参数 -> 归一化并校验区间 -> 基于统一公式计算减伤率 -> 计算预计承伤 -> 输出对比表格。
 *
 * 复用设计（避免重复）：
 * - 复用 BATTLE_CONSTANTS.DEFENSE_BASE_OFFSET 作为默认常量偏移，避免脚本与主逻辑重复维护同一个数字。
 * - 将减伤计算收敛到 calculateDefenseReductionByFormula，所有输出都走同一入口，避免多处散落公式。
 *
 * 关键边界条件与坑点：
 * 1) 攻击值最小为 1，避免出现 0 攻导致曲线含义失真（与战斗模块约束保持一致）。
 * 2) 防御区间必须满足 start <= end 且 step >= 1，非法参数直接报错退出，避免输出误导结果。
 */

import '../src/bootstrap/installConsoleLogger.js';
import { BATTLE_CONSTANTS } from '../src/battle/types.js';

interface ArgMap {
  [key: string]: string | undefined;
}

interface SimOptions {
  attack: number;
  defenseStart: number;
  defenseEnd: number;
  defenseStep: number;
  factors: number[];
  baseOffset: number;
  baseDamage: number;
}

type SimRow = Record<string, string | number>;

const EXIT_CODE_INVALID_ARGS = 1;
const DEFAULT_BASELINE_FACTOR = 2.8;

const DEFAULTS: SimOptions = {
  attack: 180,
  defenseStart: 60,
  defenseEnd: 360,
  defenseStep: 30,
  factors: [DEFAULT_BASELINE_FACTOR, BATTLE_CONSTANTS.DEFENSE_ATTACK_FACTOR],
  baseOffset: BATTLE_CONSTANTS.DEFENSE_BASE_OFFSET,
  baseDamage: 1000,
};

const usageText = `
用法：
  pnpm --filter ./server simulate:defense-reduction -- [参数]
  pnpm --filter ./server tsx scripts/simulate-defense-reduction.ts -- [参数]

参数：
  --attack <数字>           攻击值（默认 ${DEFAULTS.attack}）
  --def-start <数字>        防御起始值（默认 ${DEFAULTS.defenseStart}）
  --def-end <数字>          防御结束值（默认 ${DEFAULTS.defenseEnd}）
  --def-step <数字>         防御步长（默认 ${DEFAULTS.defenseStep}）
  --factors <a,b,...>       对比系数列表（默认 ${DEFAULTS.factors.join(',')}）
  --base-offset <数字>      常量偏移（默认 ${DEFAULTS.baseOffset}）
  --base-damage <数字>      基准来伤（默认 ${DEFAULTS.baseDamage}）
  --help                    显示帮助

示例：
  pnpm --filter ./server simulate:defense-reduction -- --attack 180 --def-start 120 --def-end 300 --def-step 30
  pnpm --filter ./server simulate:defense-reduction -- --attack 220 --factors 2.9,2.8,2.7 --base-damage 1500
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

const parseNumberStrict = (raw: string | undefined, fieldName: string): number | null => {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName} 必须是数字，当前为：${raw}`);
  }
  return parsed;
};

const parseIntStrict = (raw: string | undefined, fieldName: string): number | null => {
  const parsed = parseNumberStrict(raw, fieldName);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) {
    throw new Error(`${fieldName} 必须是整数，当前为：${raw}`);
  }
  return parsed;
};

const assertAtLeast = (value: number, min: number, fieldName: string): void => {
  if (value < min) {
    throw new Error(`${fieldName} 不能小于 ${min}，当前：${value}`);
  }
};

const parseFactors = (raw: string | undefined): number[] => {
  if (!raw) return [...DEFAULTS.factors];
  const factors = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  if (factors.length === 0) {
    throw new Error(`factors 非法：${raw}，请使用逗号分隔数字，例如 2.8,2.7`);
  }
  for (const factor of factors) {
    assertAtLeast(factor, 0.000001, 'factors 中的系数');
  }
  return factors;
};

const toSimOptions = (args: ArgMap): SimOptions => {
  const attack = parseIntStrict(args.attack, 'attack') ?? DEFAULTS.attack;
  const defenseStart = parseIntStrict(args['def-start'], 'def-start') ?? DEFAULTS.defenseStart;
  const defenseEnd = parseIntStrict(args['def-end'], 'def-end') ?? DEFAULTS.defenseEnd;
  const defenseStep = parseIntStrict(args['def-step'], 'def-step') ?? DEFAULTS.defenseStep;
  const baseOffset = parseNumberStrict(args['base-offset'], 'base-offset') ?? DEFAULTS.baseOffset;
  const baseDamage = parseIntStrict(args['base-damage'], 'base-damage') ?? DEFAULTS.baseDamage;
  const factors = parseFactors(args.factors);

  assertAtLeast(attack, 1, 'attack');
  assertAtLeast(defenseStart, 0, 'def-start');
  assertAtLeast(defenseEnd, 0, 'def-end');
  assertAtLeast(defenseStep, 1, 'def-step');
  assertAtLeast(baseOffset, 0, 'base-offset');
  assertAtLeast(baseDamage, 1, 'base-damage');
  if (defenseStart > defenseEnd) {
    throw new Error(`def-start 不能大于 def-end，当前：${defenseStart} > ${defenseEnd}`);
  }

  return {
    attack,
    defenseStart,
    defenseEnd,
    defenseStep,
    factors,
    baseOffset,
    baseDamage,
  };
};

const formatPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;

const calculateDefenseReductionByFormula = (
  defense: number,
  attack: number,
  factor: number,
  baseOffset: number,
): number => {
  const normalizedAttack = Math.max(1, attack);
  const normalizedDefense = Math.max(0, defense);
  const denominator = normalizedDefense + normalizedAttack * factor + baseOffset;
  if (denominator <= 0) return 0;
  return normalizedDefense / denominator;
};

const buildRows = (options: SimOptions): SimRow[] => {
  const rows: SimRow[] = [];
  const baselineFactor = options.factors[0];
  const targetFactor = options.factors.length > 1 ? options.factors[1] : null;

  for (
    let defense = options.defenseStart;
    defense <= options.defenseEnd;
    defense += options.defenseStep
  ) {
    const row: SimRow = { 防御: defense };
    let baselineReduction = 0;
    let targetReduction = 0;

    for (const factor of options.factors) {
      const reduction = calculateDefenseReductionByFormula(
        defense,
        options.attack,
        factor,
        options.baseOffset,
      );
      const expectedDamage = Math.floor(options.baseDamage * (1 - reduction));
      row[`减伤(系数=${factor.toFixed(2)})`] = formatPercent(reduction);
      row[`承伤(系数=${factor.toFixed(2)})`] = expectedDamage;

      if (factor === baselineFactor) baselineReduction = reduction;
      if (targetFactor !== null && factor === targetFactor) targetReduction = reduction;
    }

    if (targetFactor !== null) {
      const delta = (targetReduction - baselineReduction) * 100;
      row[`减伤提升(${baselineFactor.toFixed(2)}→${targetFactor.toFixed(2)})`] = `${delta.toFixed(2)}pt`;
    }

    rows.push(row);
  }
  return rows;
};

const main = (): void => {
  const args = parseArgMap(process.argv.slice(2));
  if (args.help === 'true') {
    console.log(usageText.trim());
    return;
  }

  try {
    const options = toSimOptions(args);
    console.log(`攻击值: ${options.attack}`);
    console.log(`防御区间: ${options.defenseStart}..${options.defenseEnd} (步长 ${options.defenseStep})`);
    console.log(`对比系数: ${options.factors.join(', ')}`);
    console.log(`常量偏移: ${options.baseOffset}`);
    console.log(`基准来伤: ${options.baseDamage}`);
    console.log('');

    const rows = buildRows(options);
    console.table(rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : '参数解析失败';
    console.error(`参数错误: ${message}`);
    console.error('\n' + usageText.trim());
    process.exit(EXIT_CODE_INVALID_ARGS);
  }
};

main();
