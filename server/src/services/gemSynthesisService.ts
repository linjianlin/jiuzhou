import { query, getTransactionClient } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { randomInt } from 'crypto';
import { addItemToInventoryTx } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { getCharacterComputedByCharacterId } from './characterComputedService.js';
import { getItemDefinitionsByIds, getItemRecipeDefinitionsByType } from './staticConfigLoader.js';

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
): Promise<Map<string, number>> => {
  const ids = [...new Set(itemDefIds.map((x) => x.trim()).filter((x) => x.length > 0))];
  if (ids.length === 0) return new Map();

  const result = await query(
    `
      SELECT item_def_id, SUM(qty)::bigint AS qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = ANY($2::text[])
        AND locked = false
        AND location IN ('bag', 'warehouse')
      GROUP BY item_def_id
    `,
    [characterId, ids],
  );

  const map = new Map<string, number>();
  for (const row of result.rows as Array<{ item_def_id: string; qty: unknown }>) {
    map.set(String(row.item_def_id || '').trim(), clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER));
  }
  return map;
};

const consumeItemDefQtyTx = async (
  characterId: number,
  itemDefId: string,
  qty: number,
): Promise<{ success: boolean; message: string }> => {
  const need = clampInt(qty, 1, Number.MAX_SAFE_INTEGER);
  if (need <= 0) return { success: true, message: '无需扣除材料' };

  const result = await query(
    `
      SELECT id, qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND locked = false
        AND location IN ('bag', 'warehouse')
      ORDER BY CASE WHEN location = 'bag' THEN 0 ELSE 1 END ASC, qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, itemDefId],
  );

  const rows = result.rows as Array<{ id: number; qty: unknown }>;
  const total = rows.reduce((sum, row) => sum + clampInt(row.qty, 0, Number.MAX_SAFE_INTEGER), 0);
  if (total < need) {
    return { success: false, message: '宝石数量不足' };
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

/**
 * 宝石合成服务
 *
 * 作用：提供宝石合成相关功能，包括配方列表查询、单次合成、批量合成
 *
 * 输入/输出：
 * - getGemSynthesisRecipeList: 输入角色ID，输出配方列表及角色钱包信息
 * - synthesizeGem: 输入角色ID、用户ID、配方ID和次数，输出合成结果
 * - synthesizeGemBatch: 输入角色ID、用户ID、宝石类型和目标等级，输出批量合成结果
 *
 * 数据流/状态流：
 * - 查询配方 → 检查材料和货币 → 扣除材料 → 执行合成（概率判定）→ 产出物品 → 更新角色状态
 *
 * 关键边界条件与坑点：
 * 1) synthesizeGem 和 synthesizeGemBatch 使用 @Transactional 确保事务一致性
 * 2) getGemSynthesisRecipeList 为纯读操作，不需要事务装饰器
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
