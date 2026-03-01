import type { PoolClient } from 'pg';
import { query, getTransactionClient } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { addItemToInventoryTx } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { recordCraftItemEvent } from './taskService.js';
import { REALM_ORDER } from './shared/realmRules.js';
import { getItemDefinitionById, getItemDefinitionsByIds, getItemRecipeById, getItemRecipeDefinitionsByType } from './staticConfigLoader.js';

type CraftRecipeType = 'craft' | 'refine' | 'decompose' | 'upgrade' | string;

type RecipeCostItem = {
  item_def_id?: unknown;
  qty?: unknown;
};

type RecipeRow = {
  id: string;
  name: string;
  recipe_type: string;
  product_item_def_id: string;
  product_qty: unknown;
  cost_silver: unknown;
  cost_spirit_stones: unknown;
  cost_exp: unknown;
  cost_items: unknown;
  req_realm: unknown;
  req_level: unknown;
  req_building: unknown;
  success_rate: unknown;
  fail_return_rate: unknown;
  product_name: unknown;
  product_icon: unknown;
  product_category: unknown;
  product_sub_category: unknown;
};

export type CraftRecipeCostItemView = {
  itemDefId: string;
  itemName: string;
  required: number;
  owned: number;
  missing: number;
};

export type CraftRecipeView = {
  id: string;
  name: string;
  recipeType: CraftRecipeType;
  product: {
    itemDefId: string;
    name: string;
    icon: string | null;
    qty: number;
  };
  costs: {
    silver: number;
    spiritStones: number;
    exp: number;
    items: CraftRecipeCostItemView[];
  };
  requirements: {
    realm: string | null;
    level: number;
    building: string | null;
    realmMet: boolean;
  };
  successRate: number;
  failReturnRate: number;
  maxCraftTimes: number;
  craftable: boolean;
  craftKind: 'alchemy' | 'smithing' | 'craft';
};

export type CraftRecipeListResult =
  | {
      success: true;
      message: string;
      data: {
        character: {
          realm: string;
          exp: number;
          silver: number;
          spiritStones: number;
        };
        recipes: CraftRecipeView[];
      };
    }
  | { success: false; message: string };

export type CraftExecuteResult =
  | {
      success: true;
      message: string;
      data: {
        recipeId: string;
        recipeType: CraftRecipeType;
        craftKind: 'alchemy' | 'smithing' | 'craft';
        times: number;
        successCount: number;
        failCount: number;
        spent: {
          silver: number;
          spiritStones: number;
          exp: number;
          items: Array<{ itemDefId: string; qty: number }>;
        };
        returnedItems: Array<{ itemDefId: string; qty: number }>;
        produced: {
          itemDefId: string;
          itemName: string;
          itemIcon: string | null;
          qty: number;
          itemIds: number[];
        } | null;
        character: {
          exp: number;
          silver: number;
          spiritStones: number;
        };
      };
    }
  | { success: false; message: string };

const asString = (value: unknown, fallback = ''): string => {
  return typeof value === 'string' ? value.trim() : fallback;
};

const asNumber = (value: unknown, fallback = 0): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clampInt = (value: unknown, min: number, max: number): number => {
  const n = Math.floor(asNumber(value, min));
  if (n < min) return min;
  if (n > max) return max;
  return n;
};

const parseCostItems = (value: unknown): Array<{ itemDefId: string; qty: number }> => {
  if (!Array.isArray(value)) return [];
  const out: Array<{ itemDefId: string; qty: number }> = [];
  for (const raw of value as RecipeCostItem[]) {
    const itemDefId = asString(raw?.item_def_id);
    const qty = clampInt(raw?.qty, 0, 999999);
    if (!itemDefId || qty <= 0) continue;
    out.push({ itemDefId, qty });
  }
  return out;
};

const getRealmRank = (realm: string): number => {
  const idx = (REALM_ORDER as readonly string[]).indexOf(realm);
  return idx >= 0 ? idx : 0;
};

const isRealmSufficient = (currentRealm: string, reqRealm: string | null): boolean => {
  if (!reqRealm) return true;
  return getRealmRank(currentRealm) >= getRealmRank(reqRealm);
};

const inferCraftKind = (recipeType: string, productCategory: string, productSubCategory: string): 'alchemy' | 'smithing' | 'craft' => {
  const rt = recipeType.trim();
  const category = productCategory.trim();
  const subCategory = productSubCategory.trim();
  if (rt === 'refine' || category === 'equipment') return 'smithing';
  if (category === 'consumable' && subCategory === 'pill') return 'alchemy';
  return 'craft';
};

const getCharacterByUserId = async (
  userId: number,
  forUpdate = false,
): Promise<
  | {
      id: number;
      realm: string;
      exp: number;
      silver: number;
      spiritStones: number;
    }
  | null
> => {
  const sql = `
    SELECT id, realm, exp, silver, spirit_stones
    FROM characters
    WHERE user_id = $1
    ${forUpdate ? 'FOR UPDATE' : ''}
    LIMIT 1
  `;
  const res = await query(sql, [userId]);
  if (!res.rows?.[0]) return null;
  const row = res.rows[0] as Record<string, unknown>;
  const id = clampInt(row.id, 0, Number.MAX_SAFE_INTEGER);
  if (id <= 0) return null;
  return {
    id,
    realm: asString(row.realm, '凡人') || '凡人',
    exp: clampInt(row.exp, 0, Number.MAX_SAFE_INTEGER),
    silver: clampInt(row.silver, 0, Number.MAX_SAFE_INTEGER),
    spiritStones: clampInt(row.spirit_stones, 0, Number.MAX_SAFE_INTEGER),
  };
};

const getRecipeRows = async (recipeType?: string): Promise<RecipeRow[]> => {
  return getItemRecipeDefinitionsByType(recipeType)
    .map((recipe) => {
      const product = getItemDefinitionById(recipe.product_item_def_id);
      return {
        id: String(recipe.id || '').trim(),
        name: String(recipe.name || '').trim(),
        recipe_type: String(recipe.recipe_type || 'craft').trim(),
        product_item_def_id: String(recipe.product_item_def_id || '').trim(),
        product_qty: recipe.product_qty ?? 1,
        cost_silver: recipe.cost_silver ?? 0,
        cost_spirit_stones: recipe.cost_spirit_stones ?? 0,
        cost_exp: recipe.cost_exp ?? 0,
        cost_items: Array.isArray(recipe.cost_items) ? recipe.cost_items : [],
        req_realm: recipe.req_realm ?? null,
        req_level: recipe.req_level ?? 0,
        req_building: recipe.req_building ?? null,
        success_rate: recipe.success_rate ?? 100,
        fail_return_rate: recipe.fail_return_rate ?? 0,
        product_name: product?.name ?? null,
        product_icon: product?.icon ?? null,
        product_category: product?.category ?? null,
        product_sub_category: product?.sub_category ?? null,
      } satisfies RecipeRow;
    })
    .filter((entry) => entry.id.length > 0)
    .sort((left, right) => left.recipe_type.localeCompare(right.recipe_type) || left.id.localeCompare(right.id));
};

const getUnlockedItemCounts = async (
  characterId: number,
  itemDefIds: string[],
): Promise<Map<string, number>> => {
  const ids = Array.from(new Set(itemDefIds.map((x) => x.trim()).filter(Boolean)));
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  const res = await query(
    `
      SELECT item_def_id, SUM(qty)::bigint AS qty
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = ANY($2::varchar[])
        AND location IN ('bag', 'warehouse')
        AND locked = false
      GROUP BY item_def_id
    `,
    [characterId, ids],
  );
  for (const row of res.rows ?? []) {
    const itemDefId = asString((row as Record<string, unknown>).item_def_id);
    if (!itemDefId) continue;
    map.set(itemDefId, clampInt((row as Record<string, unknown>).qty, 0, Number.MAX_SAFE_INTEGER));
  }
  return map;
};

const getItemNameMap = async (itemDefIds: string[]): Promise<Map<string, string>> => {
  const ids = Array.from(new Set(itemDefIds.map((x) => x.trim()).filter(Boolean)));
  const map = new Map<string, string>();
  if (ids.length === 0) return map;

  const defs = getItemDefinitionsByIds(ids);
  for (const id of ids) {
    const name = asString(defs.get(id)?.name, id);
    map.set(id, name || id);
  }
  return map;
};

const getMaxCraftTimes = (
  recipe: {
    costSilver: number;
    costSpiritStones: number;
    costExp: number;
    costItems: Array<{ itemDefId: string; qty: number }>;
  },
  character: { silver: number; spiritStones: number; exp: number },
  ownedByItem: Map<string, number>,
): number => {
  let maxTimes = Number.MAX_SAFE_INTEGER;

  if (recipe.costSilver > 0) {
    maxTimes = Math.min(maxTimes, Math.floor(character.silver / recipe.costSilver));
  }
  if (recipe.costSpiritStones > 0) {
    maxTimes = Math.min(maxTimes, Math.floor(character.spiritStones / recipe.costSpiritStones));
  }
  if (recipe.costExp > 0) {
    maxTimes = Math.min(maxTimes, Math.floor(character.exp / recipe.costExp));
  }

  for (const cost of recipe.costItems) {
    if (cost.qty <= 0) continue;
    const owned = ownedByItem.get(cost.itemDefId) ?? 0;
    maxTimes = Math.min(maxTimes, Math.floor(owned / cost.qty));
  }

  if (maxTimes === Number.MAX_SAFE_INTEGER) return 999;
  if (!Number.isFinite(maxTimes) || maxTimes < 0) return 0;
  return Math.max(0, Math.min(999, Math.floor(maxTimes)));
};

const consumeMaterialByDefIdTx = async (
  characterId: number,
  itemDefId: string,
  qty: number,
): Promise<{ success: boolean; message: string }> => {
  const need = clampInt(qty, 1, 999999);
  const rowsRes = await query(
    `
      SELECT id, qty, locked
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND location IN ('bag', 'warehouse')
      ORDER BY qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, itemDefId],
  );

  if (!rowsRes.rows?.length) {
    return { success: false, message: `${itemDefId}数量不足` };
  }

  const rows = rowsRes.rows as Array<{ id: number; qty: number; locked: boolean }>;
  const available = rows.filter((row) => !row.locked).reduce((sum, row) => sum + clampInt(row.qty, 0, 999999), 0);
  if (available < need) return { success: false, message: `${itemDefId}数量不足` };

  let remaining = need;
  for (const row of rows) {
    if (remaining <= 0) break;
    if (row.locked) continue;
    const rowQty = clampInt(row.qty, 0, 999999);
    if (rowQty <= 0) continue;
    const consume = Math.min(rowQty, remaining);
    if (consume >= rowQty) {
      await query(`DELETE FROM item_instance WHERE id = $1`, [row.id]);
    } else {
      await query(`UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2`, [consume, row.id]);
    }
    remaining -= consume;
  }

  return { success: true, message: 'ok' };
};

/**
 * 炼制服务
 * 作用：处理配方查询与炼制执行，包括材料消耗、成功率判定、产物生成
 *
 * 数据流：
 * - getCraftRecipeList: 查询配方列表 → 计算可炼制次数 → 返回视图
 * - executeCraftRecipe: 锁定角色 → 扣除材料 → 判定成功/失败 → 生成产物/返还材料 → 记录事件
 *
 * 边界条件：
 * 1) executeCraftRecipe 使用 @Transactional 保证原子性，失败自动回滚
 * 2) 材料消耗优先扣除未锁定物品，按数量降序处理
 */
class CraftService {
  async getCraftRecipeList(
    userId: number,
    options?: { recipeType?: string },
  ): Promise<CraftRecipeListResult> {
    const user = clampInt(userId, 0, Number.MAX_SAFE_INTEGER);
    if (user <= 0) return { success: false, message: '未登录' };

    const character = await getCharacterByUserId(user);
    if (!character) return { success: false, message: '角色不存在' };

    const recipeRows = await getRecipeRows(options?.recipeType);
    const allCostItemIds = recipeRows.flatMap((row) => parseCostItems(row.cost_items).map((x) => x.itemDefId));
    const [ownedByItem, itemNameMap] = await Promise.all([
      getUnlockedItemCounts(character.id, allCostItemIds),
      getItemNameMap(allCostItemIds),
    ]);

    const recipes: CraftRecipeView[] = recipeRows.map((row) => {
      const reqRealm = asString(row.req_realm) || null;
      const reqLevel = clampInt(row.req_level, 0, 9999);
      const reqBuilding = asString(row.req_building) || null;
      const recipeType = asString(row.recipe_type, 'craft') || 'craft';
      const costItems = parseCostItems(row.cost_items);

      const costItemViews: CraftRecipeCostItemView[] = costItems.map((cost) => {
        const owned = ownedByItem.get(cost.itemDefId) ?? 0;
        return {
          itemDefId: cost.itemDefId,
          itemName: itemNameMap.get(cost.itemDefId) ?? cost.itemDefId,
          required: cost.qty,
          owned,
          missing: Math.max(0, cost.qty - owned),
        };
      });

      const realmMet = isRealmSufficient(character.realm, reqRealm);
      const maxCraftTimes = realmMet
        ? getMaxCraftTimes(
            {
              costSilver: clampInt(row.cost_silver, 0, Number.MAX_SAFE_INTEGER),
              costSpiritStones: clampInt(row.cost_spirit_stones, 0, Number.MAX_SAFE_INTEGER),
              costExp: clampInt(row.cost_exp, 0, Number.MAX_SAFE_INTEGER),
              costItems,
            },
            character,
            ownedByItem,
          )
        : 0;

      const successRate = Math.max(0, Math.min(100, asNumber(row.success_rate, 100)));
      const failReturnRate = Math.max(0, Math.min(100, asNumber(row.fail_return_rate, 0)));
      const productCategory = asString(row.product_category);
      const productSubCategory = asString(row.product_sub_category);
      const craftKind = inferCraftKind(recipeType, productCategory, productSubCategory);

      return {
        id: asString(row.id),
        name: asString(row.name),
        recipeType,
        product: {
          itemDefId: asString(row.product_item_def_id),
          name: asString(row.product_name) || asString(row.product_item_def_id),
          icon: asString(row.product_icon) || null,
          qty: Math.max(1, clampInt(row.product_qty, 1, 9999)),
        },
        costs: {
          silver: clampInt(row.cost_silver, 0, Number.MAX_SAFE_INTEGER),
          spiritStones: clampInt(row.cost_spirit_stones, 0, Number.MAX_SAFE_INTEGER),
          exp: clampInt(row.cost_exp, 0, Number.MAX_SAFE_INTEGER),
          items: costItemViews,
        },
        requirements: {
          realm: reqRealm,
          level: reqLevel,
          building: reqBuilding,
          realmMet,
        },
        successRate,
        failReturnRate,
        maxCraftTimes,
        craftable: realmMet && maxCraftTimes > 0,
        craftKind,
      };
    });

    return {
      success: true,
      message: 'ok',
      data: {
        character: {
          realm: character.realm,
          exp: character.exp,
          silver: character.silver,
          spiritStones: character.spiritStones,
        },
        recipes,
      },
    };
  }

  @Transactional
  async executeCraftRecipe(
    userId: number,
    payload: { recipeId: string; times?: number },
  ): Promise<CraftExecuteResult> {
    const recipeId = asString(payload.recipeId);
    if (!recipeId) return { success: false, message: '配方ID不能为空' };

    const user = clampInt(userId, 0, Number.MAX_SAFE_INTEGER);
    if (user <= 0) return { success: false, message: '未登录' };

    const times = clampInt(payload.times, 1, 99);

    const client = getTransactionClient();
    if (!client) {
      throw new Error('executeCraftRecipe 必须在事务上下文中执行');
    }

    const characterSnapshot = await getCharacterByUserId(user, false);
    if (!characterSnapshot) {
      return { success: false, message: '角色不存在' };
    }
    await lockCharacterInventoryMutexTx(null, characterSnapshot.id);

    const character = await getCharacterByUserId(user, true);
    if (!character) {
      return { success: false, message: '角色不存在' };
    }

    const recipeDef = getItemRecipeById(recipeId);
    if (!recipeDef || recipeDef.enabled === false) {
      return { success: false, message: '配方不存在' };
    }

    const recipeProductDef = getItemDefinitionById(String(recipeDef.product_item_def_id || '').trim());
    const recipe = {
      id: String(recipeDef.id || '').trim(),
      name: String(recipeDef.name || '').trim(),
      recipe_type: String(recipeDef.recipe_type || 'craft').trim(),
      product_item_def_id: String(recipeDef.product_item_def_id || '').trim(),
      product_qty: recipeDef.product_qty ?? 1,
      cost_silver: recipeDef.cost_silver ?? 0,
      cost_spirit_stones: recipeDef.cost_spirit_stones ?? 0,
      cost_exp: recipeDef.cost_exp ?? 0,
      cost_items: Array.isArray(recipeDef.cost_items) ? recipeDef.cost_items : [],
      req_realm: recipeDef.req_realm ?? null,
      req_level: recipeDef.req_level ?? 0,
      req_building: recipeDef.req_building ?? null,
      success_rate: recipeDef.success_rate ?? 100,
      fail_return_rate: recipeDef.fail_return_rate ?? 0,
      product_name: recipeProductDef?.name ?? null,
      product_icon: recipeProductDef?.icon ?? null,
      product_category: recipeProductDef?.category ?? null,
      product_sub_category: recipeProductDef?.sub_category ?? null,
    } satisfies RecipeRow;
    const reqRealm = asString(recipe.req_realm) || null;
    if (!isRealmSufficient(character.realm, reqRealm)) {
      return { success: false, message: `境界不足，需要${reqRealm}` };
    }

    const recipeType = asString(recipe.recipe_type, 'craft') || 'craft';
    const productQty = Math.max(1, clampInt(recipe.product_qty, 1, 9999));
    const costSilverPerCraft = clampInt(recipe.cost_silver, 0, Number.MAX_SAFE_INTEGER);
    const costSpiritPerCraft = clampInt(recipe.cost_spirit_stones, 0, Number.MAX_SAFE_INTEGER);
    const costExpPerCraft = clampInt(recipe.cost_exp, 0, Number.MAX_SAFE_INTEGER);
    const costItems = parseCostItems(recipe.cost_items);

    const totalSilverCost = costSilverPerCraft * times;
    const totalSpiritCost = costSpiritPerCraft * times;
    const totalExpCost = costExpPerCraft * times;

    if (character.silver < totalSilverCost) {
      return { success: false, message: '银两不足' };
    }
    if (character.spiritStones < totalSpiritCost) {
      return { success: false, message: '灵石不足' };
    }
    if (character.exp < totalExpCost) {
      return { success: false, message: '经验不足' };
    }

    for (const itemCost of costItems) {
      const totalQty = itemCost.qty * times;
      const consume = await consumeMaterialByDefIdTx(character.id, itemCost.itemDefId, totalQty);
      if (!consume.success) {
        return { success: false, message: consume.message };
      }
    }

    if (totalSilverCost > 0 || totalSpiritCost > 0 || totalExpCost > 0) {
      await query(
        `
          UPDATE characters
          SET
            silver = silver - $2,
            spirit_stones = spirit_stones - $3,
            exp = exp - $4,
            updated_at = NOW()
          WHERE id = $1
        `,
        [character.id, totalSilverCost, totalSpiritCost, totalExpCost],
      );
    }

    const successRate = Math.max(0, Math.min(100, asNumber(recipe.success_rate, 100)));
    const failReturnRate = Math.max(0, Math.min(100, asNumber(recipe.fail_return_rate, 0)));
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < times; i += 1) {
      const roll = Math.random() * 100;
      if (roll < successRate) successCount += 1;
      else failCount += 1;
    }

    let produced: {
      itemDefId: string;
      itemName: string;
      itemIcon: string | null;
      qty: number;
      itemIds: number[];
    } | null = null;

    if (successCount > 0) {
      const totalProductQty = productQty * successCount;
      const addResult = await addItemToInventoryTx(
        client,
        character.id,
        user,
        asString(recipe.product_item_def_id),
        totalProductQty,
        { location: 'bag', obtainedFrom: `craft:${recipe.id}` },
      );
      if (!addResult.success) {
        return { success: false, message: addResult.message || '背包空间不足' };
      }

      produced = {
        itemDefId: asString(recipe.product_item_def_id),
        itemName: asString(recipe.product_name) || asString(recipe.product_item_def_id),
        itemIcon: asString(recipe.product_icon) || null,
        qty: totalProductQty,
        itemIds: addResult.itemIds ?? [],
      };
    }

    const returnedItems: Array<{ itemDefId: string; qty: number }> = [];
    if (failCount > 0 && failReturnRate > 0 && costItems.length > 0) {
      for (const itemCost of costItems) {
        const rollbackQty = Math.floor(itemCost.qty * failCount * (failReturnRate / 100));
        if (rollbackQty <= 0) continue;
        const addResult = await addItemToInventoryTx(
          client,
          character.id,
          user,
          itemCost.itemDefId,
          rollbackQty,
          { location: 'bag', obtainedFrom: `craft-refund:${recipe.id}` },
        );
        if (!addResult.success) {
          return { success: false, message: addResult.message || '返还材料失败' };
        }
        returnedItems.push({ itemDefId: itemCost.itemDefId, qty: rollbackQty });
      }
    }

    const characterRes = await query(
      `SELECT exp, silver, spirit_stones FROM characters WHERE id = $1 LIMIT 1`,
      [character.id],
    );
    const charRow = (characterRes.rows?.[0] ?? {}) as Record<string, unknown>;
    const productCategory = asString(recipe.product_category);
    const productSubCategory = asString(recipe.product_sub_category);
    const craftKind = inferCraftKind(recipeType, productCategory, productSubCategory);

    if (successCount > 0) {
      await recordCraftItemEvent(
        character.id,
        asString(recipe.id),
        craftKind,
        asString(recipe.product_item_def_id),
        successCount,
        recipeType,
      );
    }

    return {
      success: true,
      message: successCount > 0 ? '炼制完成' : '炼制失败',
      data: {
        recipeId: asString(recipe.id),
        recipeType,
        craftKind,
        times,
        successCount,
        failCount,
        spent: {
          silver: totalSilverCost,
          spiritStones: totalSpiritCost,
          exp: totalExpCost,
          items: costItems.map((x) => ({ itemDefId: x.itemDefId, qty: x.qty * times })),
        },
        returnedItems,
        produced,
        character: {
          exp: clampInt(charRow.exp, 0, Number.MAX_SAFE_INTEGER),
          silver: clampInt(charRow.silver, 0, Number.MAX_SAFE_INTEGER),
          spiritStones: clampInt(charRow.spirit_stones, 0, Number.MAX_SAFE_INTEGER),
        },
      },
    };
  }
}

export const craftService = new CraftService();
export default craftService;
