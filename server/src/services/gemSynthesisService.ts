import { query, getTransactionClient } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { randomInt } from 'crypto';
import { addItemToInventoryTx } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { getCharacterComputedByCharacterId } from './characterComputedService.js';
import {
  getEnabledItemDefinitions,
  getItemDefinitionsByIds,
  getItemRecipeDefinitionsByType,
} from './staticConfigLoader.js';

export type GemType = 'attack' | 'defense' | 'survival' | 'all';
type GemTypeToken = 'atk' | 'def' | 'sur' | 'all';

type GemRecipeRow = {
  id: string;
  name: string;
  product_item_def_id: string;
  product_qty: unknown;
  cost_silver: unknown;
  cost_spirit_stones: unknown;
  cost_items: unknown;
  success_rate: unknown;
};

type GemRecipeModel = {
  id: string;
  name: string;
  gemType: GemType;
  seriesKey: string;
  fromLevel: number;
  toLevel: number;
  inputItemDefId: string;
  inputQty: number;
  outputItemDefId: string;
  outputQty: number;
  costSilver: number;
  costSpiritStones: number;
  successRate: number;
};

type CharacterWallet = {
  silver: number;
  spiritStones: number;
};

type ItemCostEntry = {
  itemDefId: string;
  qty: number;
};

type ItemDefLite = {
  id: string;
  name: string;
  icon: string | null;
};

export type GemSynthesisRecipeView = {
  recipeId: string;
  name: string;
  gemType: GemType;
  seriesKey: string;
  fromLevel: number;
  toLevel: number;
  input: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
    owned: number;
  };
  output: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
  };
  costs: {
    silver: number;
    spiritStones: number;
  };
  successRate: number;
  maxSynthesizeTimes: number;
  canSynthesize: boolean;
};

export type GemSynthesisRecipeListResult =
  | {
      success: true;
      message: string;
      data: {
        character: CharacterWallet;
        recipes: GemSynthesisRecipeView[];
      };
    }
  | { success: false; message: string };

export type GemSynthesisExecuteResult =
  | {
      success: true;
      message: string;
      data: {
        recipeId: string;
        gemType: GemType;
        seriesKey: string;
        fromLevel: number;
        toLevel: number;
        times: number;
        successCount: number;
        failCount: number;
        successRate: number;
        consumed: {
          itemDefId: string;
          qty: number;
        };
        spent: {
          silver: number;
          spiritStones: number;
        };
        produced: {
          itemDefId: string;
          qty: number;
          itemIds: number[];
        } | null;
        character: unknown;
      };
    }
  | { success: false; message: string };

export type GemSynthesisBatchResult =
  | {
      success: true;
      message: string;
      data: {
        gemType: GemType;
        seriesKey: string;
        sourceLevel: number;
        targetLevel: number;
        totalSpent: {
          silver: number;
          spiritStones: number;
        };
        steps: Array<{
          recipeId: string;
          seriesKey: string;
          fromLevel: number;
          toLevel: number;
          times: number;
          successCount: number;
          failCount: number;
          successRate: number;
          consumed: {
            itemDefId: string;
            qty: number;
          };
          spent: {
            silver: number;
            spiritStones: number;
          };
          produced: {
            itemDefId: string;
            qty: number;
            itemIds: number[];
          };
        }>;
        character: unknown;
      };
    }
  | { success: false; message: string };

export type GemConvertOptionView = {
  inputLevel: number;
  outputLevel: number;
  inputGemQtyPerConvert: number;
  ownedInputGemQty: number;
  costSpiritStonesPerConvert: number;
  maxConvertTimes: number;
  canConvert: boolean;
  candidateGemCount: number;
};

export type GemConvertOptionListResult =
  | {
      success: true;
      message: string;
      data: {
        character: CharacterWallet;
        options: GemConvertOptionView[];
      };
    }
  | { success: false; message: string };

export type GemConvertExecuteResult =
  | {
      success: true;
      message: string;
      data: {
        inputLevel: number;
        outputLevel: number;
        times: number;
        consumed: {
          inputGemQty: number;
          selectedGemItemIds: number[];
        };
        spent: {
          spiritStones: number;
        };
        produced: {
          totalQty: number;
          items: Array<{
            itemDefId: string;
            name: string;
            icon: string | null;
            qty: number;
            itemIds: number[];
          }>;
        };
        character: unknown;
      };
    }
  | { success: false; message: string };

const GEM_TYPE_TOKEN_TO_TYPE: Record<GemTypeToken, GemType> = {
  atk: 'attack',
  def: 'defense',
  sur: 'survival',
  all: 'all',
};

const GEM_TYPE_SORT_WEIGHT: Record<GemType, number> = {
  attack: 1,
  defense: 2,
  survival: 3,
  all: 4,
};

const GEM_ITEM_DEF_RE = /^gem-(atk|def|sur|all)(?:-([a-z0-9_]+))?-([1-9]|10)$/;
type MaterialLocation = 'bag' | 'warehouse';
const DEFAULT_MATERIAL_LOCATIONS: readonly MaterialLocation[] = ['bag', 'warehouse'];
const GEM_CONVERT_MATERIAL_LOCATIONS: readonly MaterialLocation[] = ['bag'];
const GEM_CONVERT_INPUT_QTY = 2;
const GEM_CONVERT_MIN_LEVEL = 2;
const GEM_CONVERT_MAX_LEVEL = 10;
const GEM_MIN_LEVEL = 1;
const GEM_MAX_LEVEL = 10;
const GEM_CONVERT_OBTAINED_FROM = 'gem-convert';

const toInt = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
};

const clampInt = (value: unknown, min: number, max: number): number => {
  const n = toInt(value, min);
  if (n < min) return min;
  if (n > max) return max;
  return n;
};

const parseCostItems = (value: unknown): ItemCostEntry[] => {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const out: ItemCostEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { item_def_id?: unknown; qty?: unknown };
    const itemDefId = String(row.item_def_id || '').trim();
    const qty = clampInt(row.qty, 0, 999999);
    if (!itemDefId || qty <= 0) continue;
    out.push({ itemDefId, qty });
  }
  return out;
};

const parseGemItemDefId = (
  itemDefId: string,
): { gemType: GemType; token: GemTypeToken; seriesKey: string; level: number } | null => {
  const matched = GEM_ITEM_DEF_RE.exec(String(itemDefId || '').trim());
  if (!matched) return null;
  const token = matched[1] as GemTypeToken;
  const subtype = String(matched[2] || '').trim().toLowerCase();
  const level = clampInt(matched[3], 1, 10);
  if (token !== 'all' && !subtype) return null;
  const seriesKey = subtype ? `${token}-${subtype}` : token;
  return {
    gemType: GEM_TYPE_TOKEN_TO_TYPE[token],
    token,
    seriesKey,
    level,
  };
};

const normalizeGemType = (value: unknown): GemType | null => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  if (['atk', 'attack', 'gem_attack', 'gem-atk'].includes(raw)) return 'attack';
  if (['def', 'defense', 'gem_defense', 'gem-def'].includes(raw)) return 'defense';
  if (['sur', 'survival', 'gem_survival', 'gem-sur'].includes(raw)) return 'survival';
  if (['all', 'gem_all', 'gem-all'].includes(raw)) return 'all';
  return null;
};

const parseRecipeModel = (row: GemRecipeRow): GemRecipeModel | null => {
  const inputCosts = parseCostItems(row.cost_items);
  if (inputCosts.length !== 1) return null;

  const input = inputCosts[0];
  const inputGem = parseGemItemDefId(input.itemDefId);
  const outputGem = parseGemItemDefId(String(row.product_item_def_id || '').trim());
  if (!inputGem || !outputGem) return null;
  if (inputGem.gemType !== outputGem.gemType) return null;
  if (inputGem.seriesKey !== outputGem.seriesKey) return null;
  if (outputGem.level !== inputGem.level + 1) return null;

  const outputQty = clampInt(row.product_qty, 1, 999999);
  if (outputQty <= 0) return null;
  const successRateRaw = typeof row.success_rate === 'number' ? row.success_rate : Number(row.success_rate);
  const successRate = Number.isFinite(successRateRaw)
    ? Math.max(0, Math.min(1, Math.round(successRateRaw * 10000) / 10000))
    : 1;

  return {
    id: String(row.id || '').trim(),
    name: String(row.name || '').trim() || `宝石合成 ${inputGem.level}→${outputGem.level}`,
    gemType: inputGem.gemType,
    seriesKey: inputGem.seriesKey,
    fromLevel: inputGem.level,
    toLevel: outputGem.level,
    inputItemDefId: input.itemDefId,
    inputQty: clampInt(input.qty, 1, 999999),
    outputItemDefId: String(row.product_item_def_id || '').trim(),
    outputQty,
    costSilver: clampInt(row.cost_silver, 0, Number.MAX_SAFE_INTEGER),
    costSpiritStones: clampInt(row.cost_spirit_stones, 0, Number.MAX_SAFE_INTEGER),
    successRate,
  };
};

const normalizeMaterialLocations = (
  locations: readonly MaterialLocation[] | undefined,
): MaterialLocation[] => {
  if (!locations || locations.length === 0) {
    return [...DEFAULT_MATERIAL_LOCATIONS];
  }
  return [...new Set(locations)];
};

const getCharacterWalletTx = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterWallet | null> => {
  const sql = `
    SELECT silver, spirit_stones
    FROM characters
    WHERE id = $1
    ${forUpdate ? 'FOR UPDATE' : ''}
    LIMIT 1
  `;
  const result = await query(sql, [characterId]);
  if (!result.rows[0]) return null;
  const row = result.rows[0] as { silver: unknown; spirit_stones: unknown };
  return {
    silver: clampInt(row.silver, 0, Number.MAX_SAFE_INTEGER),
    spiritStones: clampInt(row.spirit_stones, 0, Number.MAX_SAFE_INTEGER),
  };
};

const getGemRecipeRows = async (
  options: { recipeId?: string; gemType?: GemType } = {},
): Promise<GemRecipeRow[]> => {
  let recipes = getItemRecipeDefinitionsByType('gem_synthesis');

  if (options.recipeId) {
    const targetId = options.recipeId.trim();
    recipes = recipes.filter((entry) => String(entry.id || '').trim() === targetId);
  }

  if (options.gemType) {
    const token =
      options.gemType === 'attack'
        ? 'atk'
        : options.gemType === 'defense'
          ? 'def'
          : options.gemType === 'survival'
            ? 'sur'
            : 'all';
    const idPrefix = `gem-synth-${token}-`;
    recipes = recipes.filter((entry) => String(entry.id || '').trim().startsWith(idPrefix));
  }

  return recipes
    .map((recipe) => ({
      id: String(recipe.id || '').trim(),
      name: String(recipe.name || '').trim(),
      product_item_def_id: String(recipe.product_item_def_id || '').trim(),
      product_qty: recipe.product_qty ?? 1,
      cost_silver: recipe.cost_silver ?? 0,
      cost_spirit_stones: recipe.cost_spirit_stones ?? 0,
      cost_items: Array.isArray(recipe.cost_items) ? recipe.cost_items : [],
      success_rate: recipe.success_rate ?? 1,
    } satisfies GemRecipeRow))
    .filter((entry) => entry.id.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
};

const getItemDefMap = async (
  itemDefIds: string[],
): Promise<Map<string, ItemDefLite>> => {
  const ids = [...new Set(itemDefIds.map((x) => x.trim()).filter((x) => x.length > 0))];
  if (ids.length === 0) return new Map();

  const defs = getItemDefinitionsByIds(ids);
  const map = new Map<string, ItemDefLite>();
  for (const id of ids) {
    const def = defs.get(id);
    if (!def) continue;
    map.set(id, {
      id,
      name: String(def.name || '').trim(),
      icon: typeof def.icon === 'string' && def.icon.trim().length > 0 ? def.icon.trim() : null,
    });
  }
  return map;
};

const getItemOwnedQtyMapTx = async (
  characterId: number,
  itemDefIds: string[],
  options: { locations?: readonly MaterialLocation[] } = {},
): Promise<Map<string, number>> => {
  const ids = [...new Set(itemDefIds.map((x) => x.trim()).filter((x) => x.length > 0))];
  if (ids.length === 0) return new Map();
  const locations = normalizeMaterialLocations(options.locations);

  const result = await query(
    `
      SELECT item_def_id, SUM(qty)::bigint AS qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = ANY($2::text[])
        AND locked = false
        AND location = ANY($3::text[])
      GROUP BY item_def_id
    `,
    [characterId, ids, locations],
  );

  const map = new Map<string, number>();
  for (const row of result.rows as Array<{ item_def_id: string; qty: unknown }>) {
    map.set(String(row.item_def_id || '').trim(), clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER));
  }
  return map;
};

type ItemInstanceMaterialRow = {
  id: number;
  itemDefId: string;
  qty: number;
  locked: boolean;
  location: string;
};

const getItemInstanceRowsByIdsForUpdateTx = async (
  characterId: number,
  itemInstanceIds: number[],
): Promise<ItemInstanceMaterialRow[]> => {
  const ids = [...new Set(itemInstanceIds.map((id) => clampInt(id, 1, Number.MAX_SAFE_INTEGER)).filter((id) => id > 0))];
  if (ids.length === 0) return [];

  const result = await query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE owner_character_id = $1
        AND id = ANY($2::int[])
      FOR UPDATE
    `,
    [characterId, ids],
  );

  return (result.rows as Array<{
    id: unknown;
    item_def_id: unknown;
    qty: unknown;
    locked: unknown;
    location: unknown;
  }>).map((row) => ({
    id: clampInt(row.id, 0, Number.MAX_SAFE_INTEGER),
    itemDefId: String(row.item_def_id || '').trim(),
    qty: clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER),
    locked: Boolean(row.locked),
    location: String(row.location || '').trim(),
  }));
};

const consumeSelectedItemInstancesTx = async (
  consumeQtyByItemId: Map<number, number>,
  rowsByItemId: Map<number, ItemInstanceMaterialRow>,
): Promise<{ success: boolean; message: string }> => {
  for (const [itemId, consumeQtyRaw] of consumeQtyByItemId.entries()) {
    const consumeQty = clampInt(consumeQtyRaw, 1, Number.MAX_SAFE_INTEGER);
    const row = rowsByItemId.get(itemId);
    if (!row) return { success: false, message: '所选宝石不存在' };
    if (row.qty < consumeQty) return { success: false, message: '所选宝石数量不足' };

    if (row.qty === consumeQty) {
      await query('DELETE FROM item_instance WHERE id = $1', [itemId]);
      continue;
    }
    await query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [consumeQty, itemId]);
  }

  return { success: true, message: '扣除材料成功' };
};

const calcMaxConvertTimesBySelectedItems = (
  consumeBaseQtyByItemId: Map<number, number>,
  rowsByItemId: Map<number, ItemInstanceMaterialRow>,
): number => {
  let maxTimes = Number.MAX_SAFE_INTEGER;
  for (const [itemId, baseQty] of consumeBaseQtyByItemId.entries()) {
    const row = rowsByItemId.get(itemId);
    if (!row || baseQty <= 0) return 0;
    const byItem = Math.floor(row.qty / baseQty);
    maxTimes = Math.min(maxTimes, byItem);
  }
  if (!Number.isFinite(maxTimes) || maxTimes <= 0) return 0;
  return maxTimes;
};

const consumeItemDefIdsQtyTx = async (
  characterId: number,
  itemDefIds: string[],
  qty: number,
  options: {
    locations?: readonly MaterialLocation[];
    insufficientMessage?: string;
  } = {},
): Promise<{ success: boolean; message: string }> => {
  const need = clampInt(qty, 1, Number.MAX_SAFE_INTEGER);
  if (need <= 0) return { success: true, message: '无需扣除材料' };
  const ids = [...new Set(itemDefIds.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0))];
  if (ids.length === 0) {
    return { success: false, message: options.insufficientMessage || '材料不足' };
  }
  const locations = normalizeMaterialLocations(options.locations);

  const result = await query(
    `
      SELECT id, qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = ANY($2::text[])
        AND locked = false
        AND location = ANY($3::text[])
      ORDER BY CASE WHEN location = 'bag' THEN 0 ELSE 1 END ASC, qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, ids, locations],
  );

  const rows = result.rows as Array<{ id: number; qty: unknown }>;
  const total = rows.reduce((sum, row) => sum + clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER), 0);
  if (total < need) {
    return { success: false, message: options.insufficientMessage || '材料不足' };
  }

  let remaining = need;
  for (const row of rows) {
    if (remaining <= 0) break;
    const rowQty = clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER);
    if (rowQty <= 0) continue;

    if (rowQty <= remaining) {
      await query('DELETE FROM item_instance WHERE id = $1', [row.id]);
      remaining -= rowQty;
      continue;
    }

    await query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [remaining, row.id]);
    remaining = 0;
  }

  return { success: true, message: '扣除材料成功' };
};

const consumeItemDefQtyTx = async (
  characterId: number,
  itemDefId: string,
  qty: number,
  options: {
    locations?: readonly MaterialLocation[];
    insufficientMessage?: string;
  } = {},
): Promise<{ success: boolean; message: string }> => {
  return consumeItemDefIdsQtyTx(characterId, [itemDefId], qty, {
    insufficientMessage: options.insufficientMessage || '宝石数量不足',
    ...(options.locations ? { locations: options.locations } : {}),
  });
};

const calcMaxSynthesizeTimes = (params: {
  ownedInputQty: number;
  needInputQty: number;
  wallet: CharacterWallet;
  silverCost: number;
  spiritStoneCost: number;
}): number => {
  const byItems = params.needInputQty > 0 ? Math.floor(params.ownedInputQty / params.needInputQty) : 0;
  const bySilver =
    params.silverCost > 0 ? Math.floor(params.wallet.silver / params.silverCost) : Number.MAX_SAFE_INTEGER;
  const bySpirit =
    params.spiritStoneCost > 0
      ? Math.floor(params.wallet.spiritStones / params.spiritStoneCost)
      : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(byItems, bySilver, bySpirit));
};

const updateCharacterWalletTx = async (characterId: number, wallet: CharacterWallet): Promise<void> => {
  await query(
    `
      UPDATE characters
      SET silver = $2,
          spirit_stones = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [characterId, wallet.silver, wallet.spiritStones],
  );
};

type GemConvertContext = {
  gemItemDefIdsByLevel: Map<number, string[]>;
  gemLevelByItemDefId: Map<string, number>;
  spiritCostByInputLevel: Map<number, number>;
};

type GemConvertContextResult =
  | { success: true; data: GemConvertContext }
  | { success: false; message: string };

/**
 * 收集当前开启状态下的宝石定义并按等级分组
 *
 * 作用：
 * - 构造“等级 → 宝石定义ID数组”索引，供转换随机池与材料统计复用
 *
 * 输入：
 * - 无（读取静态配置 item_def/gem_def/equipment_def 合并快照）
 *
 * 输出：
 * - Map<number, string[]>，键为宝石等级，值为稳定排序后的宝石定义 ID 列表
 *
 * 关键边界条件与坑点：
 * 1) 仅纳入 enabled !== false 且 category = gem 的定义，避免关闭条目进入随机池
 * 2) 仅接受可被 parseGemItemDefId 解析的标准宝石 ID，避免脏数据影响等级索引
 */
const buildGemItemDefIdsByLevel = (): Map<number, string[]> => {
  const setByLevel = new Map<number, Set<string>>();
  for (let level = GEM_MIN_LEVEL; level <= GEM_MAX_LEVEL; level += 1) {
    setByLevel.set(level, new Set<string>());
  }

  const enabledItemDefs = getEnabledItemDefinitions();
  for (const itemDef of enabledItemDefs) {
    const category = String(itemDef.category || '').trim().toLowerCase();
    if (category !== 'gem') continue;

    const itemDefId = String(itemDef.id || '').trim();
    const parsed = parseGemItemDefId(itemDefId);
    if (!parsed) continue;

    const levelSet = setByLevel.get(parsed.level);
    if (!levelSet) continue;
    levelSet.add(itemDefId);
  }

  const map = new Map<number, string[]>();
  for (let level = GEM_MIN_LEVEL; level <= GEM_MAX_LEVEL; level += 1) {
    const ids = [...(setByLevel.get(level) ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
    map.set(level, ids);
  }
  return map;
};

/**
 * 构建宝石转换上下文
 *
 * 作用：
 * - 提供转换所需的单一数据源：等级随机池 + 等级灵石消耗映射
 *
 * 输入：
 * - 已解析的宝石合成配方模型（仅 gem_synthesis）
 *
 * 输出：
 * - 成功时返回 GemConvertContext
 * - 配置冲突/缺失时返回失败消息（不做兜底）
 *
 * 数据流：
 * - recipes -> spiritCostByInputLevel（toLevel 作为转换输入等级）
 * - item definitions -> gemItemDefIdsByLevel
 *
 * 关键边界条件与坑点：
 * 1) 同一输入等级若映射出多个灵石消耗，视为配置冲突并直接失败
 * 2) 输入等级 2~10 必须都有消耗定义，否则视为配置缺失
 */
const buildGemConvertContext = (recipes: GemRecipeModel[]): GemConvertContextResult => {
  const spiritCostByInputLevel = new Map<number, number>();
  for (const recipe of recipes) {
    const inputLevel = recipe.toLevel;
    if (inputLevel < GEM_CONVERT_MIN_LEVEL || inputLevel > GEM_CONVERT_MAX_LEVEL) continue;
    const existing = spiritCostByInputLevel.get(inputLevel);
    if (existing === undefined) {
      spiritCostByInputLevel.set(inputLevel, recipe.costSpiritStones);
      continue;
    }
    if (existing !== recipe.costSpiritStones) {
      return {
        success: false,
        message: `宝石转换配置冲突：${inputLevel}级存在多个灵石消耗`,
      };
    }
  }

  for (let level = GEM_CONVERT_MIN_LEVEL; level <= GEM_CONVERT_MAX_LEVEL; level += 1) {
    if (!spiritCostByInputLevel.has(level)) {
      return {
        success: false,
        message: `宝石转换配置缺失：${level}级灵石消耗未定义`,
      };
    }
  }

  const gemItemDefIdsByLevel = buildGemItemDefIdsByLevel();
  const gemLevelByItemDefId = new Map<string, number>();
  for (const [level, itemDefIds] of gemItemDefIdsByLevel.entries()) {
    for (const itemDefId of itemDefIds) {
      gemLevelByItemDefId.set(itemDefId, level);
    }
  }

  return {
    success: true,
    data: {
      gemItemDefIdsByLevel,
      gemLevelByItemDefId,
      spiritCostByInputLevel,
    },
  };
};

const getGemConvertContext = async (): Promise<GemConvertContextResult> => {
  const recipeRows = await getGemRecipeRows();
  const recipes = recipeRows
    .map((row) => parseRecipeModel(row))
    .filter((row): row is GemRecipeModel => !!row);

  if (recipes.length <= 0) {
    return { success: false, message: '宝石转换配置缺失：未找到宝石合成配方' };
  }

  return buildGemConvertContext(recipes);
};

/**
 * 按等级聚合角色宝石持有数量
 *
 * 作用：
 * - 统计指定位置（默认背包）中、未锁定宝石的等级总数
 *
 * 输入：
 * - characterId：角色 ID
 * - context：转换上下文（包含 itemDefId -> level 索引）
 * - locations：统计位置
 *
 * 输出：
 * - Map<number, number>（等级 -> 持有总数）
 */
const getOwnedGemQtyByLevelTx = async (
  characterId: number,
  context: GemConvertContext,
  locations: readonly MaterialLocation[],
): Promise<Map<number, number>> => {
  const allGemItemDefIds = [...context.gemLevelByItemDefId.keys()];
  const ownedByItemDefId = await getItemOwnedQtyMapTx(characterId, allGemItemDefIds, { locations });
  const ownedByLevel = new Map<number, number>();

  for (const [itemDefId, qty] of ownedByItemDefId.entries()) {
    const level = context.gemLevelByItemDefId.get(itemDefId);
    if (!level) continue;
    ownedByLevel.set(level, (ownedByLevel.get(level) ?? 0) + qty);
  }

  return ownedByLevel;
};

/**
 * 等概率随机抽取宝石并聚合数量
 *
 * 作用：
 * - 在候选宝石池中执行等概率随机，输出 itemDefId -> qty 聚合映射
 *
 * 输入：
 * - candidateItemDefIds：候选宝石定义 ID 列表（必须非空）
 * - times：随机次数
 *
 * 输出：
 * - Map<string, number>（宝石定义 ID -> 数量）
 */
const rollRandomGemOutputCounts = (
  candidateItemDefIds: string[],
  times: number,
): Map<string, number> => {
  const out = new Map<string, number>();
  for (let i = 0; i < times; i += 1) {
    const rolledIndex = randomInt(0, candidateItemDefIds.length);
    const itemDefId = candidateItemDefIds[rolledIndex];
    if (!itemDefId) continue;
    out.set(itemDefId, (out.get(itemDefId) ?? 0) + 1);
  }
  return out;
};

/**
 * 宝石合成服务
 *
 * 作用：提供宝石合成/转换相关功能，包括配方列表查询、单次合成、批量合成、宝石转换
 *
 * 输入/输出：
 * - getGemSynthesisRecipeList: 输入角色ID，输出配方列表及角色钱包信息
 * - getGemConvertOptions: 输入角色ID，输出宝石转换选项
 * - convertGem: 输入角色ID、用户ID、手动选择的2个宝石实例ID，输出宝石转换结果
 * - synthesizeGem: 输入角色ID、用户ID、配方ID和次数，输出合成结果
 * - synthesizeGemBatch: 输入角色ID、用户ID、宝石类型和目标等级，输出批量合成结果
 *
 * 数据流/状态流：
 * - 查询配方/转换配置 → 检查材料和货币 → 扣除材料 → 执行合成或转换 → 产出物品 → 更新角色状态
 *
 * 关键边界条件与坑点：
 * 1) synthesizeGem / synthesizeGemBatch / convertGem 使用 @Transactional 确保事务一致性
 * 2) getGemSynthesisRecipeList / getGemConvertOptions 为纯读操作，不需要事务装饰器
 */
class GemSynthesisService {
  async getGemSynthesisRecipeList(characterId: number): Promise<GemSynthesisRecipeListResult> {
    const wallet = await getCharacterWalletTx(characterId, false);
    if (!wallet) return { success: false, message: '角色不存在' };

    const recipeRows = await getGemRecipeRows();
    const recipes = recipeRows
      .map((row) => parseRecipeModel(row))
      .filter((row): row is GemRecipeModel => !!row)
      .sort((a, b) => {
        const typeDiff = GEM_TYPE_SORT_WEIGHT[a.gemType] - GEM_TYPE_SORT_WEIGHT[b.gemType];
        if (typeDiff !== 0) return typeDiff;
        const seriesDiff = a.seriesKey.localeCompare(b.seriesKey);
        if (seriesDiff !== 0) return seriesDiff;
        return a.fromLevel - b.fromLevel;
      });

    if (recipes.length === 0) {
      return {
        success: true,
        message: 'ok',
        data: {
          character: wallet,
          recipes: [],
        },
      };
    }

    const itemDefIds = recipes.flatMap((recipe) => [recipe.inputItemDefId, recipe.outputItemDefId]);
    const [itemDefMap, ownedMap] = await Promise.all([
      getItemDefMap(itemDefIds),
      getItemOwnedQtyMapTx(
        characterId,
        recipes.map((recipe) => recipe.inputItemDefId),
      ),
    ]);

    const views: GemSynthesisRecipeView[] = recipes.map((recipe) => {
      const owned = ownedMap.get(recipe.inputItemDefId) ?? 0;
      const maxTimes = calcMaxSynthesizeTimes({
        ownedInputQty: owned,
        needInputQty: recipe.inputQty,
        wallet,
        silverCost: recipe.costSilver,
        spiritStoneCost: recipe.costSpiritStones,
      });
      const inputDef = itemDefMap.get(recipe.inputItemDefId);
      const outputDef = itemDefMap.get(recipe.outputItemDefId);

      return {
        recipeId: recipe.id,
        name: recipe.name,
        gemType: recipe.gemType,
        seriesKey: recipe.seriesKey,
        fromLevel: recipe.fromLevel,
        toLevel: recipe.toLevel,
        input: {
          itemDefId: recipe.inputItemDefId,
          name: inputDef?.name || recipe.inputItemDefId,
          icon: inputDef?.icon || null,
          qty: recipe.inputQty,
          owned,
        },
        output: {
          itemDefId: recipe.outputItemDefId,
          name: outputDef?.name || recipe.outputItemDefId,
          icon: outputDef?.icon || null,
          qty: recipe.outputQty,
        },
        costs: {
          silver: recipe.costSilver,
          spiritStones: recipe.costSpiritStones,
        },
        successRate: recipe.successRate,
        maxSynthesizeTimes: maxTimes,
        canSynthesize: maxTimes > 0,
      };
    });

    return {
      success: true,
      message: 'ok',
      data: {
        character: wallet,
        recipes: views,
      },
    };
  }

  /**
   * 获取宝石转换可执行选项
   *
   * 作用：
   * - 返回输入等级 2~10 的完整选项集（包含不可转换等级）
   * - 为前端提供可转换次数、灵石消耗、随机池规模等可视化信息
   *
   * 输入：
   * - characterId：角色 ID
   *
   * 输出：
   * - GemConvertOptionListResult：角色钱包 + 各等级转换选项
   *
   * 数据流：
   * - 读取角色钱包 -> 构建转换上下文 -> 统计背包内各等级宝石数量 -> 计算 maxConvertTimes
   *
   * 关键边界条件与坑点：
   * 1) 选项固定输出 2~10 级，不因背包资源为 0 而删除等级
   * 2) 转换成本来自 gem_synthesis 配方映射，配置冲突/缺失会直接失败
   */
  async getGemConvertOptions(characterId: number): Promise<GemConvertOptionListResult> {
    const wallet = await getCharacterWalletTx(characterId, false);
    if (!wallet) return { success: false, message: '角色不存在' };

    const contextResult = await getGemConvertContext();
    if (!contextResult.success) {
      return { success: false, message: contextResult.message };
    }

    const context = contextResult.data;
    const ownedByLevel = await getOwnedGemQtyByLevelTx(characterId, context, GEM_CONVERT_MATERIAL_LOCATIONS);
    const options: GemConvertOptionView[] = [];

    for (let inputLevel = GEM_CONVERT_MIN_LEVEL; inputLevel <= GEM_CONVERT_MAX_LEVEL; inputLevel += 1) {
      const outputLevel = inputLevel - 1;
      const ownedInputGemQty = ownedByLevel.get(inputLevel) ?? 0;
      const costSpiritStonesPerConvert = context.spiritCostByInputLevel.get(inputLevel);
      if (costSpiritStonesPerConvert === undefined) {
        return {
          success: false,
          message: `宝石转换配置缺失：${inputLevel}级灵石消耗未定义`,
        };
      }

      const candidateGemCount = (context.gemItemDefIdsByLevel.get(outputLevel) ?? []).length;
      const maxConvertTimes = calcMaxSynthesizeTimes({
        ownedInputQty: ownedInputGemQty,
        needInputQty: GEM_CONVERT_INPUT_QTY,
        wallet,
        silverCost: 0,
        spiritStoneCost: costSpiritStonesPerConvert,
      });

      options.push({
        inputLevel,
        outputLevel,
        inputGemQtyPerConvert: GEM_CONVERT_INPUT_QTY,
        ownedInputGemQty,
        costSpiritStonesPerConvert,
        maxConvertTimes,
        canConvert: maxConvertTimes > 0 && candidateGemCount > 0,
        candidateGemCount,
      });
    }

    return {
      success: true,
      message: 'ok',
      data: {
        character: wallet,
        options,
      },
    };
  }

  /**
   * 执行宝石转换
   *
   * 规则：
   * - 输入：手动选择 2 颗同等级宝石（允许混搭）
   * - 消耗：按输入等级映射的灵石消耗（固定 1 次）
   * - 产出：1 颗低 1 级的随机宝石（目标等级全宝石等概率）
   *
   * 输入：
   * - characterId：角色 ID
   * - userId：用户 ID
   * - params.selectedGemItemIds：手动选择的 2 个宝石实例 ID（支持同一堆叠重复选择）
   * - params.times：按同一组手选宝石重复转换次数（默认 1）
   *
   * 输出：
   * - GemConvertExecuteResult：消耗、产出、角色快照
   *
   * 数据流：
   * - 事务加锁 -> 校验所选宝石 -> 扣指定宝石 -> 扣灵石 -> 随机产出入包 -> 返回角色最新数据
   *
   * 关键边界条件与坑点：
   * 1) 随机池为空时直接失败，不做默认产物兜底
   * 2) 所选宝石必须都在背包且未锁定，且等级一致，否则直接失败
   */
  @Transactional
  async convertGem(
    characterId: number,
    userId: number,
    params: { selectedGemItemIds: number[]; times?: number },
  ): Promise<GemConvertExecuteResult> {
    const selectedGemItemIdsRaw = Array.isArray(params.selectedGemItemIds) ? params.selectedGemItemIds : [];
    if (selectedGemItemIdsRaw.length !== GEM_CONVERT_INPUT_QTY) {
      return { success: false, message: `请选择${GEM_CONVERT_INPUT_QTY}个宝石` };
    }

    const selectedGemItemIds = selectedGemItemIdsRaw
      .map((value) => clampInt(value, 1, Number.MAX_SAFE_INTEGER))
      .filter((value) => value > 0);
    if (selectedGemItemIds.length !== GEM_CONVERT_INPUT_QTY) {
      return { success: false, message: 'selectedGemItemIds参数错误' };
    }

    const consumeBaseQtyByItemId = new Map<number, number>();
    for (const itemId of selectedGemItemIds) {
      consumeBaseQtyByItemId.set(itemId, (consumeBaseQtyByItemId.get(itemId) ?? 0) + 1);
    }

    const requestedTimes = clampInt(params.times ?? 1, 1, 999999);

    const client = getTransactionClient();
    if (!client) return { success: false, message: '事务上下文缺失' };

    await lockCharacterInventoryMutexTx(client, characterId);

    const wallet = await getCharacterWalletTx(characterId, true);
    if (!wallet) {
      return { success: false, message: '角色不存在' };
    }

    const contextResult = await getGemConvertContext();
    if (!contextResult.success) {
      return { success: false, message: contextResult.message };
    }
    const context = contextResult.data;

    const selectedRows = await getItemInstanceRowsByIdsForUpdateTx(characterId, [...consumeBaseQtyByItemId.keys()]);
    if (selectedRows.length !== consumeBaseQtyByItemId.size) {
      return { success: false, message: '所选宝石不存在' };
    }

    const rowsByItemId = new Map<number, ItemInstanceMaterialRow>();
    const selectedLevels = new Set<number>();
    for (const row of selectedRows) {
      rowsByItemId.set(row.id, row);

      if (row.locked) {
        return { success: false, message: '所选宝石已锁定' };
      }
      if (row.location !== 'bag') {
        return { success: false, message: '仅可选择背包内宝石进行转换' };
      }

      const requestedQty = consumeBaseQtyByItemId.get(row.id) ?? 0;
      if (requestedQty <= 0 || row.qty < requestedQty) {
        return { success: false, message: '所选宝石数量不足' };
      }

      const level = context.gemLevelByItemDefId.get(row.itemDefId);
      if (!level) {
        return { success: false, message: '所选物品不是有效宝石' };
      }
      selectedLevels.add(level);
    }

    if (selectedLevels.size !== 1) {
      return { success: false, message: '请选择2个同等级宝石' };
    }

    const [inputLevel] = [...selectedLevels];
    if (!inputLevel || inputLevel < GEM_CONVERT_MIN_LEVEL || inputLevel > GEM_CONVERT_MAX_LEVEL) {
      return { success: false, message: '所选宝石等级不支持转换' };
    }
    const outputLevel = inputLevel - 1;

    const candidateOutputItemDefIds = context.gemItemDefIdsByLevel.get(outputLevel) ?? [];
    if (candidateOutputItemDefIds.length <= 0) {
      return { success: false, message: `宝石转换配置异常：${outputLevel}级随机池为空` };
    }

    const costSpiritStonesPerConvert = context.spiritCostByInputLevel.get(inputLevel);
    if (costSpiritStonesPerConvert === undefined) {
      return { success: false, message: `宝石转换配置缺失：${inputLevel}级灵石消耗未定义` };
    }

    const maxBySelectedItems = calcMaxConvertTimesBySelectedItems(consumeBaseQtyByItemId, rowsByItemId);
    const maxBySpirit =
      costSpiritStonesPerConvert > 0
        ? Math.floor(wallet.spiritStones / costSpiritStonesPerConvert)
        : Number.MAX_SAFE_INTEGER;
    const maxConvertTimes = Math.max(0, Math.min(maxBySelectedItems, maxBySpirit));
    if (maxConvertTimes <= 0) {
      return { success: false, message: '所选宝石或灵石不足' };
    }
    if (requestedTimes > maxConvertTimes) {
      return { success: false, message: `当前最多可转换${maxConvertTimes}次` };
    }

    const consumeQtyByItemId = new Map<number, number>();
    for (const [itemId, baseQty] of consumeBaseQtyByItemId.entries()) {
      consumeQtyByItemId.set(itemId, baseQty * requestedTimes);
    }

    const consumeRes = await consumeSelectedItemInstancesTx(consumeQtyByItemId, rowsByItemId);
    if (!consumeRes.success) {
      return { success: false, message: consumeRes.message };
    }

    const consumeInputGemQty = GEM_CONVERT_INPUT_QTY * requestedTimes;
    const spentSpiritStones = costSpiritStonesPerConvert * requestedTimes;
    wallet.spiritStones -= spentSpiritStones;
    await updateCharacterWalletTx(characterId, wallet);

    const rolledOutputCounts = rollRandomGemOutputCounts(candidateOutputItemDefIds, requestedTimes);
    const producedItemDefIds = [...rolledOutputCounts.keys()].sort((a, b) => a.localeCompare(b));
    const outputDefMap = await getItemDefMap(producedItemDefIds);
    const producedItems: Array<{
      itemDefId: string;
      name: string;
      icon: string | null;
      qty: number;
      itemIds: number[];
    }> = [];

    for (const itemDefId of producedItemDefIds) {
      const produceQty = rolledOutputCounts.get(itemDefId) ?? 0;
      if (produceQty <= 0) continue;

      const addRes = await addItemToInventoryTx(client, characterId, userId, itemDefId, produceQty, {
        location: 'bag',
        obtainedFrom: GEM_CONVERT_OBTAINED_FROM,
      });
      if (!addRes.success) {
        return { success: false, message: addRes.message };
      }

      const def = outputDefMap.get(itemDefId);
      producedItems.push({
        itemDefId,
        name: def?.name || itemDefId,
        icon: def?.icon || null,
        qty: produceQty,
        itemIds: addRes.itemIds ?? [],
      });
    }

    const character = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });
    return {
      success: true,
      message: '宝石转换成功',
      data: {
        inputLevel,
        outputLevel,
        times: requestedTimes,
        consumed: {
          inputGemQty: consumeInputGemQty,
          selectedGemItemIds,
        },
        spent: {
          spiritStones: spentSpiritStones,
        },
        produced: {
          totalQty: requestedTimes,
          items: producedItems,
        },
        character,
      },
    };
  }

  @Transactional
  async synthesizeGem(
    characterId: number,
    userId: number,
    params: { recipeId: string; times?: number },
  ): Promise<GemSynthesisExecuteResult> {
    const recipeId = String(params.recipeId || '').trim();
    const times = clampInt(params.times ?? 1, 1, 999999);
    if (!recipeId) return { success: false, message: 'recipeId参数错误' };

    const client = getTransactionClient();
    if (!client) return { success: false, message: '事务上下文缺失' };

    await lockCharacterInventoryMutexTx(client, characterId);

    const wallet = await getCharacterWalletTx(characterId, true);
    if (!wallet) {
      return { success: false, message: '角色不存在' };
    }

    const recipeRows = await getGemRecipeRows({ recipeId });
    const recipe = recipeRows.length > 0 ? parseRecipeModel(recipeRows[0]) : null;
    if (!recipe) {
      return { success: false, message: '宝石配方不存在' };
    }

    const ownedMap = await getItemOwnedQtyMapTx(characterId, [recipe.inputItemDefId]);
    const ownedInputQty = ownedMap.get(recipe.inputItemDefId) ?? 0;
    const maxTimes = calcMaxSynthesizeTimes({
      ownedInputQty,
      needInputQty: recipe.inputQty,
      wallet,
      silverCost: recipe.costSilver,
      spiritStoneCost: recipe.costSpiritStones,
    });

    if (maxTimes <= 0) {
      return { success: false, message: '材料或货币不足' };
    }

    if (times > maxTimes) {
      return { success: false, message: `当前最多可合成${maxTimes}次` };
    }

    const consumeQty = recipe.inputQty * times;
    const consumeRes = await consumeItemDefQtyTx(characterId, recipe.inputItemDefId, consumeQty);
    if (!consumeRes.success) {
      return { success: false, message: consumeRes.message };
    }

    const totalSilverCost = recipe.costSilver * times;
    const totalSpiritStoneCost = recipe.costSpiritStones * times;
    wallet.silver -= totalSilverCost;
    wallet.spiritStones -= totalSpiritStoneCost;

    if (wallet.silver < 0 || wallet.spiritStones < 0) {
      return { success: false, message: '货币不足' };
    }

    await updateCharacterWalletTx(characterId, wallet);

    const successRate = Math.max(0, Math.min(1, Number(recipe.successRate) || 0));
    let successCount = 0;
    for (let i = 0; i < times; i += 1) {
      const roll = randomInt(0, 10_000) / 10_000;
      if (roll < successRate) successCount += 1;
    }
    const failCount = times - successCount;

    const produceQty = recipe.outputQty * successCount;
    let produced: { itemDefId: string; qty: number; itemIds: number[] } | null = null;
    if (produceQty > 0) {
      const addRes = await addItemToInventoryTx(client, characterId, userId, recipe.outputItemDefId, produceQty, {
        location: 'bag',
        obtainedFrom: 'gem-synthesis',
      });
      if (!addRes.success) {
        return { success: false, message: addRes.message };
      }
      produced = {
        itemDefId: recipe.outputItemDefId,
        qty: produceQty,
        itemIds: addRes.itemIds ?? [],
      };
    }

    const character = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });
    const message =
      successCount <= 0
        ? '宝石合成失败，材料已损失'
        : failCount <= 0
          ? '宝石合成成功'
          : `宝石合成完成（成功${successCount}次，失败${failCount}次）`;
    return {
      success: true,
      message,
      data: {
        recipeId: recipe.id,
        gemType: recipe.gemType,
        seriesKey: recipe.seriesKey,
        fromLevel: recipe.fromLevel,
        toLevel: recipe.toLevel,
        times,
        successCount,
        failCount,
        successRate: recipe.successRate,
        consumed: {
          itemDefId: recipe.inputItemDefId,
          qty: consumeQty,
        },
        spent: {
          silver: totalSilverCost,
          spiritStones: totalSpiritStoneCost,
        },
        produced,
        character,
      },
    };
  }

  @Transactional
  async synthesizeGemBatch(
    characterId: number,
    userId: number,
    params: { gemType: string; targetLevel: number; sourceLevel?: number; seriesKey?: string },
  ): Promise<GemSynthesisBatchResult> {
    const gemType = normalizeGemType(params.gemType);
    const sourceLevel = clampInt(params.sourceLevel ?? 1, 1, 9);
    const targetLevel = clampInt(params.targetLevel, 2, 10);
    const requestedSeriesKey = String(params.seriesKey || '').trim().toLowerCase();

    if (!gemType) return { success: false, message: 'gemType参数错误' };
    if (sourceLevel >= targetLevel) return { success: false, message: 'targetLevel必须大于sourceLevel' };

    const client = getTransactionClient();
    if (!client) return { success: false, message: '事务上下文缺失' };

    await lockCharacterInventoryMutexTx(client, characterId);

    const wallet = await getCharacterWalletTx(characterId, true);
    if (!wallet) {
      return { success: false, message: '角色不存在' };
    }

    const recipeRows = await getGemRecipeRows({ gemType });
    const recipes = recipeRows
      .map((row) => parseRecipeModel(row))
      .filter((row): row is GemRecipeModel => !!row)
      .filter((row) => row.gemType === gemType);

    if (recipes.length === 0) {
      return { success: false, message: '宝石配方不存在' };
    }

    const seriesKeySet = new Set(recipes.map((recipe) => recipe.seriesKey));
    let selectedSeriesKey = requestedSeriesKey;
    if (selectedSeriesKey) {
      if (!seriesKeySet.has(selectedSeriesKey)) {
        return { success: false, message: '宝石子类型参数错误' };
      }
    } else if (seriesKeySet.size > 1) {
      return { success: false, message: '该类型包含多个子类型，请先选择具体宝石后再批量合成' };
    } else {
      selectedSeriesKey = recipes[0]?.seriesKey || '';
    }

    const selectedSeriesRecipes = recipes.filter((recipe) => recipe.seriesKey === selectedSeriesKey);
    const recipeByFromLevel = new Map<number, GemRecipeModel>();
    for (const recipe of selectedSeriesRecipes) {
      recipeByFromLevel.set(recipe.fromLevel, recipe);
    }

    const steps: Array<{
      recipeId: string;
      seriesKey: string;
      fromLevel: number;
      toLevel: number;
      times: number;
      successCount: number;
      failCount: number;
      successRate: number;
      consumed: {
        itemDefId: string;
        qty: number;
      };
      spent: {
        silver: number;
        spiritStones: number;
      };
      produced: {
        itemDefId: string;
        qty: number;
        itemIds: number[];
      };
    }> = [];

    let spentSilver = 0;
    let spentSpiritStones = 0;

    for (let level = sourceLevel; level < targetLevel; level += 1) {
      const recipe = recipeByFromLevel.get(level);
      if (!recipe) continue;

      const ownedMap = await getItemOwnedQtyMapTx(characterId, [recipe.inputItemDefId]);
      const ownedInputQty = ownedMap.get(recipe.inputItemDefId) ?? 0;
      const maxTimes = calcMaxSynthesizeTimes({
        ownedInputQty,
        needInputQty: recipe.inputQty,
        wallet,
        silverCost: recipe.costSilver,
        spiritStoneCost: recipe.costSpiritStones,
      });

      if (maxTimes <= 0) continue;

      const consumeQty = recipe.inputQty * maxTimes;
      const consumeRes = await consumeItemDefQtyTx(characterId, recipe.inputItemDefId, consumeQty);
      if (!consumeRes.success) {
        return { success: false, message: consumeRes.message };
      }

      const totalSilverCost = recipe.costSilver * maxTimes;
      const totalSpiritCost = recipe.costSpiritStones * maxTimes;

      wallet.silver -= totalSilverCost;
      wallet.spiritStones -= totalSpiritCost;
      if (wallet.silver < 0 || wallet.spiritStones < 0) {
        return { success: false, message: '货币不足' };
      }

      spentSilver += totalSilverCost;
      spentSpiritStones += totalSpiritCost;

      const successRate = Math.max(0, Math.min(1, Number(recipe.successRate) || 0));
      let successCount = 0;
      for (let i = 0; i < maxTimes; i += 1) {
        const roll = randomInt(0, 10_000) / 10_000;
        if (roll < successRate) successCount += 1;
      }
      const failCount = maxTimes - successCount;

      const produceQty = recipe.outputQty * successCount;
      let itemIds: number[] = [];
      if (produceQty > 0) {
        const addRes = await addItemToInventoryTx(client, characterId, userId, recipe.outputItemDefId, produceQty, {
          location: 'bag',
          obtainedFrom: 'gem-synthesis',
        });
        if (!addRes.success) {
          return { success: false, message: addRes.message };
        }
        itemIds = addRes.itemIds ?? [];
      }

      steps.push({
        recipeId: recipe.id,
        seriesKey: recipe.seriesKey,
        fromLevel: recipe.fromLevel,
        toLevel: recipe.toLevel,
        times: maxTimes,
        successCount,
        failCount,
        successRate: recipe.successRate,
        consumed: {
          itemDefId: recipe.inputItemDefId,
          qty: consumeQty,
        },
        spent: {
          silver: totalSilverCost,
          spiritStones: totalSpiritCost,
        },
        produced: {
          itemDefId: recipe.outputItemDefId,
          qty: produceQty,
          itemIds,
        },
      });
    }

    if (steps.length === 0) {
      return { success: false, message: '材料或货币不足，无法批量合成' };
    }

    await updateCharacterWalletTx(characterId, wallet);

    const character = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });
    const totalSuccess = steps.reduce((sum, step) => sum + step.successCount, 0);
    const totalFail = steps.reduce((sum, step) => sum + step.failCount, 0);
    const message =
      totalSuccess <= 0
        ? '批量合成完成，但全部失败，材料已损失'
        : totalFail <= 0
          ? '批量合成成功'
          : `批量合成完成（成功${totalSuccess}次，失败${totalFail}次）`;
    return {
      success: true,
      message,
      data: {
        gemType,
        seriesKey: selectedSeriesKey,
        sourceLevel,
        targetLevel,
        totalSpent: {
          silver: spentSilver,
          spiritStones: spentSpiritStones,
        },
        steps,
        character,
      },
    };
  }
}

export const gemSynthesisService = new GemSynthesisService();
export default gemSynthesisService;
