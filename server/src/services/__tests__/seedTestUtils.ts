/**
 * 种子测试共享工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一提供种子文件读取、JSON 结构收窄、对象索引和合并掉落池读取能力，减少多个种子测试重复抄写同一套解析逻辑。
 * - 不做什么：不负责业务断言、不执行随机掉落结算，也不替测试偷偷兜底缺失配置。
 *
 * 输入/输出：
 * - 输入：种子文件名、JSON 字段值、掉落池 ID。
 * - 输出：解析后的 JSON 对象、对象映射表、合并公共池后的掉落物品 ID 集合。
 *
 * 数据流/状态流：
 * - 先通过统一路径规则定位 `server/src/data/seeds` 下的文件；
 * - 再把原始 JSON 收窄为测试可消费的 `JsonObject / JsonValue[] / string`；
 * - 最后在需要时把专属掉落池与公共掉落池合并，向测试暴露单一数据源。
 *
 * 关键边界条件与坑点：
 * 1) 种子测试运行目录可能在仓库根目录，也可能在 `server` 目录，路径解析必须同时兼容这两种入口，否则测试会误报文件缺失。
 * 2) 掉落判断不能只看专属池，公共池里的条目同样会进入最终掉落预览，因此这里直接提供合并结果，避免各测试再次各写一遍。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeAffixPoolFile,
  type AffixAllowedSlot,
  type NormalizedAffixDefConfig,
  type NormalizedAffixPoolDefConfig,
  type RawAffixPoolFile,
} from '../shared/affixPoolConfig.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export const resolveSeedPath = (filename: string): string => {
  const candidatePaths = [
    resolve(process.cwd(), `server/src/data/seeds/${filename}`),
    resolve(process.cwd(), `src/data/seeds/${filename}`),
  ];
  const seedPath = candidatePaths.find((filePath) => existsSync(filePath));
  assert.ok(seedPath, `未找到种子文件: ${filename}`);
  return seedPath;
};

export const loadSeed = (filename: string): JsonObject => {
  const seedPath = resolveSeedPath(filename);
  return JSON.parse(readFileSync(seedPath, 'utf-8')) as JsonObject;
};

export const loadNormalizedAffixPools = (): NormalizedAffixPoolDefConfig[] => {
  const seedPath = resolveSeedPath('affix_pool.json');
  const file = JSON.parse(readFileSync(seedPath, 'utf-8')) as RawAffixPoolFile;
  return normalizeAffixPoolFile(file);
};

export const findAffixByKeyAndSlot = (
  pool: NormalizedAffixPoolDefConfig,
  affixKey: string,
  equipSlot: AffixAllowedSlot,
): NormalizedAffixDefConfig | undefined => {
  return pool.affixes.find((affix) => {
    if (affix.key !== affixKey) return false;
    if (!Array.isArray(affix.allowed_slots)) return false;
    return affix.allowed_slots.includes(equipSlot);
  });
};

export const collectAffixesBySlot = (
  pool: NormalizedAffixPoolDefConfig,
  equipSlot: AffixAllowedSlot,
): NormalizedAffixDefConfig[] => {
  return pool.affixes.filter((affix) => Array.isArray(affix.allowed_slots) && affix.allowed_slots.includes(equipSlot));
};

export const asObject = (value: JsonValue | undefined): JsonObject | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonObject;
};

export const asArray = (value: JsonValue | undefined): JsonValue[] => {
  if (!Array.isArray(value)) return [];
  return value;
};

export const asText = (value: JsonValue | undefined): string => (typeof value === 'string' ? value.trim() : '');

export const collectDungeonSeedFileNames = (): string[] => {
  const seedDir = resolveSeedPath('item_def.json').replace(/item_def\.json$/, '');
  return readdirSync(seedDir)
    .filter((fileName) => /^dungeon_.*\.json$/.test(fileName))
    .sort();
};

export const collectDungeonBossMonsterIds = (): string[] => {
  const bossMonsterIds = new Set<string>();

  for (const fileName of collectDungeonSeedFileNames()) {
    const dungeonSeed = loadSeed(fileName);
    const raw = JSON.stringify(dungeonSeed);
    const monsterDefIdMatches = raw.matchAll(/"monster_def_id"\s*:\s*"([^"]+)"/g);
    for (const match of monsterDefIdMatches) {
      const monsterDefId = match[1]?.trim();
      if (!monsterDefId?.startsWith('monster-boss-')) continue;
      bossMonsterIds.add(monsterDefId);
    }
  }

  return Array.from(bossMonsterIds).sort();
};

export const buildObjectMap = (values: JsonValue[] | undefined, key: string): Map<string, JsonObject> => {
  const objectMap = new Map<string, JsonObject>();
  for (const value of values ?? []) {
    const objectValue = asObject(value);
    const objectId = asText(objectValue?.[key]);
    if (!objectValue || !objectId) continue;
    objectMap.set(objectId, objectValue);
  }
  return objectMap;
};

export const collectMergedPoolItemIds = (
  poolId: string,
  dropPoolById: Map<string, JsonObject>,
  commonPoolById: Map<string, JsonObject>,
): Set<string> => {
  const mergedEntries = collectMergedPoolEntries(poolId, dropPoolById, commonPoolById);
  const mergedItemIds = new Set<string>();
  for (const entry of mergedEntries) {
    const itemDefId = asText(asObject(entry)?.item_def_id);
    if (itemDefId) mergedItemIds.add(itemDefId);
  }
  return mergedItemIds;
};

export const collectMergedPoolEntries = (
  poolId: string,
  dropPoolById: Map<string, JsonObject>,
  commonPoolById: Map<string, JsonObject>,
): JsonValue[] => {
  const pool = dropPoolById.get(poolId);
  assert.ok(pool, `缺少掉落池: ${poolId}`);

  const mergedEntries: JsonValue[] = [];
  for (const commonPoolIdValue of asArray(pool.common_pool_ids)) {
    const commonPoolId = asText(commonPoolIdValue);
    if (!commonPoolId) continue;
    const commonPool = commonPoolById.get(commonPoolId);
    assert.ok(commonPool, `缺少公共掉落池: ${commonPoolId}`);
    mergedEntries.push(...asArray(commonPool.entries));
  }

  mergedEntries.push(...asArray(pool.entries));
  return mergedEntries;
};
