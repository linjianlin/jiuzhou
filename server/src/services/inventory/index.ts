/**
 * 九州修仙录 - 背包服务
 * 性能优化策略：
 * 1. 批量操作减少数据库往返
 * 2. 使用事务保证数据一致性
 * 3. 缓存背包容量信息
 * 4. 智能堆叠合并
 */
import { query, withTransaction } from "../../config/database.js";
import type { PoolClient } from "pg";
import { randomInt } from "crypto";
import { lockCharacterInventoryMutexTx } from "../inventoryMutex.js";
import {
  getCharacterComputedByCharacterId,
  invalidateCharacterComputedCache,
} from "../characterComputedService.js";
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getItemSetDefinitions,
} from "../staticConfigLoader.js";
import {
  ENHANCE_MAX_LEVEL,
  REFINE_MAX_LEVEL,
  buildEnhanceCostPlan,
  buildEquipmentDisplayBaseAttrs,
  buildRefineCostPlan,
  clampInt as clampGrowthInt,
  getEnhanceFailResultLevel,
  getEnhanceSuccessRatePercent,
  getRefineFailResultLevel,
  getRefineSuccessRatePercent,
  isGemTypeAllowedInSlot,
  parseSocketEffectsFromItemEffectDefs,
  parseSocketedGems,
  resolveSocketMax,
  type SocketEffect,
  type SocketedGemEntry,
} from "../equipmentGrowthRules.js";
import {
  buildAffixRerollCostPlan,
  normalizeAffixLockIndexes,
  validateAffixLockIndexes,
} from "../equipmentAffixRerollRules.js";
import {
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForRerollTx,
  parseGeneratedAffixesForReroll,
  rerollEquipmentAffixesWithLocks,
  resolveQualityForReroll,
} from "../equipmentAffixRerollService.js";
import { buildDisassembleRewardPlan } from "../disassembleRewardPlanner.js";
import type { GeneratedAffix } from "../equipmentService.js";
import { extractFlatAffixDeltas } from "../shared/affixModifier.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { normalizeItemInstanceObtainedFrom } from "../shared/itemInstanceSource.js";
import {
  isGemItemDefinition,
  resolveGemTypeFromItemDefinition,
} from "../shared/gemItemSemantics.js";
import { getRealmRankOneBasedStrict } from "../shared/realmRules.js";

// 背包位置类型
export type InventoryLocation = "bag" | "warehouse" | "equipped";
export type SlottedInventoryLocation = "bag" | "warehouse";

// 背包物品接口
export interface InventoryItem {
  id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  location: InventoryLocation;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number;
  refine_level: number;
  socketed_gems: unknown;
  affixes: any;
  identified: boolean;
  locked: boolean;
  bind_type: string;
  created_at: Date;
}

// 背包信息接口
export interface InventoryInfo {
  bag_capacity: number;
  warehouse_capacity: number;
  bag_used: number;
  warehouse_used: number;
}

type CharacterAttrKey =
  | "qixue"
  | "max_qixue"
  | "lingqi"
  | "max_lingqi"
  | "wugong"
  | "fagong"
  | "wufang"
  | "fafang"
  | "sudu"
  | "mingzhong"
  | "shanbi"
  | "zhaojia"
  | "baoji"
  | "baoshang"
  | "kangbao"
  | "zengshang"
  | "zhiliao"
  | "jianliao"
  | "xixue"
  | "lengque"
  | "shuxing_shuzhi"
  | "kongzhi_kangxing"
  | "jin_kangxing"
  | "mu_kangxing"
  | "shui_kangxing"
  | "huo_kangxing"
  | "tu_kangxing"
  | "qixue_huifu"
  | "lingqi_huifu";

const allowedCharacterAttrKeys = new Set<CharacterAttrKey>([
  "qixue",
  "max_qixue",
  "lingqi",
  "max_lingqi",
  "wugong",
  "fagong",
  "wufang",
  "fafang",
  "sudu",
  "mingzhong",
  "shanbi",
  "zhaojia",
  "baoji",
  "baoshang",
  "kangbao",
  "zengshang",
  "zhiliao",
  "jianliao",
  "xixue",
  "lengque",
  "shuxing_shuzhi",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
  "qixue_huifu",
  "lingqi_huifu",
]);

const clampInt = clampGrowthInt;
export const BAG_CAPACITY_MAX = 200;

const getSlottedCapacity = (
  info: InventoryInfo,
  location: SlottedInventoryLocation,
): number => (location === "bag" ? info.bag_capacity : info.warehouse_capacity);

const runQuery = (
  client: PoolClient | null,
  text: string,
  params?: unknown[],
) => {
  if (client) return client.query(text, params);
  return query(text, params);
};

const safeNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getStaticItemDef = (itemDefIdRaw: unknown) => {
  const itemDefId = String(itemDefIdRaw || "").trim();
  if (!itemDefId) return null;
  return getItemDefinitionById(itemDefId);
};

const getEnabledStaticItemDef = (itemDefIdRaw: unknown) => {
  const itemDef = getStaticItemDef(itemDefIdRaw);
  if (!itemDef || itemDef.enabled === false) return null;
  return itemDef;
};

const addToDelta = (
  delta: Map<CharacterAttrKey, number>,
  key: string,
  value: unknown,
) => {
  if (!allowedCharacterAttrKeys.has(key as CharacterAttrKey)) return;
  const v = safeNumber(value);
  if (v === 0) return;
  const k = key as CharacterAttrKey;
  delta.set(k, (delta.get(k) || 0) + v);
};

const mergeDelta = (
  a: Map<CharacterAttrKey, number>,
  b: Map<CharacterAttrKey, number>,
) => {
  for (const [k, v] of b.entries()) {
    if (v === 0) continue;
    a.set(k, (a.get(k) || 0) + v);
  }
};

const invertDelta = (delta: Map<CharacterAttrKey, number>) => {
  const out = new Map<CharacterAttrKey, number>();
  for (const [k, v] of delta.entries()) {
    if (v === 0) continue;
    out.set(k, -v);
  }
  return out;
};

const applyCharacterAttrDeltaTx = async (
  _client: PoolClient,
  _characterId: number,
  _delta: Map<CharacterAttrKey, number>,
): Promise<void> => {
  // 角色属性改为运行时计算后，不再把装备/词条差分写入 characters 表。
  return;
};

const getEquipmentAttrDeltaByInstanceIdTx = async (
  client: PoolClient,
  characterId: number,
  instanceId: number,
): Promise<Map<CharacterAttrKey, number> | null> => {
  const result = await client.query(
    `
      SELECT
        ii.id,
        ii.owner_character_id,
        ii.item_def_id,
        ii.affixes,
        ii.strengthen_level,
        ii.refine_level,
        ii.socketed_gems,
        ii.quality_rank
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      LIMIT 1
    `,
    [instanceId, characterId],
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0] as {
    item_def_id: string;
    affixes: unknown;
    strengthen_level: unknown;
    refine_level: unknown;
    socketed_gems: unknown;
    quality_rank: unknown;
  };
  const itemDef = getStaticItemDef(row.item_def_id);
  if (!itemDef || itemDef.category !== "equipment") return null;

  const delta = new Map<CharacterAttrKey, number>();

  const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
  const resolvedQualityRank = Number(row.quality_rank) || defQualityRank;
  const baseAttrs = buildEquipmentDisplayBaseAttrs({
    baseAttrsRaw: itemDef.base_attrs,
    defQualityRankRaw: defQualityRank,
    resolvedQualityRankRaw: resolvedQualityRank,
    strengthenLevelRaw: row.strengthen_level,
    refineLevelRaw: row.refine_level,
    socketedGemsRaw: row.socketed_gems,
  });

  for (const [k, v] of Object.entries(baseAttrs)) addToDelta(delta, k, v);

  const affixesRaw = row.affixes;
  const affixes: unknown[] = Array.isArray(affixesRaw)
    ? affixesRaw
    : typeof affixesRaw === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(affixesRaw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  for (const affix of affixes) {
    const rows = extractFlatAffixDeltas(affix);
    for (const row of rows) {
      addToDelta(delta, row.attrKey, row.value);
    }
  }

  return delta;
};

const consumeMaterialByDefIdTx = async (
  client: PoolClient,
  characterId: number,
  materialItemDefId: string,
  qty: number,
): Promise<{ success: boolean; message: string }> => {
  const need = clampInt(qty, 1, 999999);
  const rowResult = await client.query(
    `
      SELECT id, qty, locked
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND location IN ('bag', 'warehouse')
      ORDER BY qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, materialItemDefId],
  );

  if (rowResult.rows.length === 0) {
    return { success: false, message: "材料不足" };
  }

  const rows = rowResult.rows as Array<{
    id: number;
    qty: number;
    locked: boolean;
  }>;
  const unlockedRows = rows.filter(
    (row) => !row.locked && (Number(row.qty) || 0) > 0,
  );
  const unlockedTotal = unlockedRows.reduce(
    (sum, row) => sum + Math.max(0, Number(row.qty) || 0),
    0,
  );

  if (unlockedTotal < need) {
    if (unlockedTotal <= 0 && rows.some((row) => row.locked)) {
      return { success: false, message: "材料已锁定" };
    }
    return { success: false, message: "材料不足" };
  }

  let remaining = need;
  for (const row of unlockedRows) {
    if (remaining <= 0) break;
    const rowQty = Math.max(0, Number(row.qty) || 0);
    if (rowQty <= 0) continue;

    const consume = Math.min(rowQty, remaining);
    if (consume >= rowQty) {
      await client.query("DELETE FROM item_instance WHERE id = $1", [row.id]);
    } else {
      await client.query(
        "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2",
        [consume, row.id],
      );
    }
    remaining -= consume;
  }

  return { success: true, message: "扣除成功" };
};

const consumeSpecificItemInstanceTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  qty: number,
): Promise<{ success: boolean; message: string; itemDefId?: string }> => {
  const need = clampInt(qty, 1, 999999);
  const result = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );

  if (result.rows.length === 0)
    return { success: false, message: "道具不存在" };

  const row = result.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };
  if (row.locked) return { success: false, message: "道具已锁定" };
  if (!["bag", "warehouse"].includes(String(row.location))) {
    return { success: false, message: "道具当前位置不可消耗" };
  }
  if ((Number(row.qty) || 0) < need)
    return { success: false, message: "道具数量不足" };

  if ((Number(row.qty) || 0) === need) {
    await client.query("DELETE FROM item_instance WHERE id = $1", [row.id]);
  } else {
    await client.query(
      "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2",
      [need, row.id],
    );
  }
  return {
    success: true,
    message: "扣除成功",
    itemDefId: String(row.item_def_id),
  };
};

const consumeCharacterCurrenciesTx = async (
  client: PoolClient,
  characterId: number,
  costs: { silver?: number; spiritStones?: number },
): Promise<{ success: boolean; message: string }> => {
  const silverCost = Math.max(0, Math.floor(Number(costs.silver) || 0));
  const spiritCost = Math.max(0, Math.floor(Number(costs.spiritStones) || 0));
  if (silverCost <= 0 && spiritCost <= 0)
    return { success: true, message: "无需扣除货币" };

  const charResult = await client.query(
    `SELECT silver, spirit_stones FROM characters WHERE id = $1 FOR UPDATE LIMIT 1`,
    [characterId],
  );
  if (charResult.rows.length === 0)
    return { success: false, message: "角色不存在" };

  const curSilver = Number(charResult.rows[0].silver ?? 0) || 0;
  const curSpirit = Number(charResult.rows[0].spirit_stones ?? 0) || 0;
  if (curSilver < silverCost)
    return { success: false, message: `银两不足，需要${silverCost}` };
  if (curSpirit < spiritCost)
    return { success: false, message: `灵石不足，需要${spiritCost}` };

  await client.query(
    `
      UPDATE characters
      SET silver = silver - $2,
          spirit_stones = spirit_stones - $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [characterId, silverCost, spiritCost],
  );
  return { success: true, message: "扣除成功" };
};

const addCharacterCurrenciesTx = async (
  client: PoolClient,
  characterId: number,
  gains: { silver?: number; spiritStones?: number },
): Promise<{ success: boolean; message: string }> => {
  const silverGain = Math.max(0, Math.floor(Number(gains.silver) || 0));
  const spiritGain = Math.max(0, Math.floor(Number(gains.spiritStones) || 0));
  if (silverGain <= 0 && spiritGain <= 0)
    return { success: true, message: "无需增加货币" };

  const charResult = await client.query(
    `SELECT id FROM characters WHERE id = $1 FOR UPDATE LIMIT 1`,
    [characterId],
  );
  if (charResult.rows.length === 0)
    return { success: false, message: "角色不存在" };

  await client.query(
    `
      UPDATE characters
      SET silver = silver + $2,
          spirit_stones = spirit_stones + $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [characterId, silverGain, spiritGain],
  );
  return { success: true, message: "增加成功" };
};

const diffEquipmentAttrIfEquippedTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  location: unknown,
): Promise<{
  success: boolean;
  message: string;
  before?: Map<CharacterAttrKey, number>;
}> => {
  if (String(location) !== "equipped")
    return { success: true, message: "无需差分" };
  const before = await getEquipmentAttrDeltaByInstanceIdTx(
    client,
    characterId,
    itemInstanceId,
  );
  if (!before) return { success: false, message: "装备数据异常" };
  return { success: true, message: "ok", before };
};

const applyEquipmentDiffIfEquippedTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  location: unknown,
  before?: Map<CharacterAttrKey, number>,
): Promise<{ success: boolean; message: string }> => {
  if (String(location) !== "equipped")
    return { success: true, message: "无需差分" };
  if (!before) return { success: false, message: "装备数据异常" };
  const after = await getEquipmentAttrDeltaByInstanceIdTx(
    client,
    characterId,
    itemInstanceId,
  );
  if (!after) return { success: false, message: "装备数据异常" };
  const diff = new Map<CharacterAttrKey, number>();
  mergeDelta(diff, after);
  mergeDelta(diff, invertDelta(before));
  await applyCharacterAttrDeltaTx(client, characterId, diff);
  return { success: true, message: "ok" };
};

const getEnhanceItemStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    strengthenLevel: number;
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.strengthen_level,
        ii.item_def_id
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0)
    return { success: false, message: "物品不存在" };

  const row = itemResult.rows[0] as {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    strengthen_level: number;
    item_def_id: string;
  };

  const itemDef = getStaticItemDef(row.item_def_id);
  if (!itemDef || itemDef.category !== "equipment")
    return { success: false, message: "该物品不可强化" };
  if (row.locked) return { success: false, message: "物品已锁定" };
  if (String(row.location) === "auction")
    return { success: false, message: "交易中的装备不可强化" };
  if (!["bag", "warehouse", "equipped"].includes(String(row.location))) {
    return { success: false, message: "该物品当前位置不可强化" };
  }
  if ((Number(row.qty) || 0) !== 1)
    return { success: false, message: "装备数量异常" };

  return {
    success: true,
    message: "ok",
    item: {
      id: Number(row.id),
      qty: Number(row.qty) || 1,
      location: row.location,
      locked: Boolean(row.locked),
      strengthenLevel: clampInt(
        Number(row.strengthen_level) || 0,
        0,
        ENHANCE_MAX_LEVEL,
      ),
    },
  };
};

const getRefineItemStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    refineLevel: number;
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.refine_level,
        ii.item_def_id
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0)
    return { success: false, message: "物品不存在" };

  const row = itemResult.rows[0] as {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    refine_level: number;
    item_def_id: string;
  };

  const itemDef = getStaticItemDef(row.item_def_id);
  if (!itemDef || itemDef.category !== "equipment")
    return { success: false, message: "该物品不可精炼" };
  if (row.locked) return { success: false, message: "物品已锁定" };
  if (String(row.location) === "auction")
    return { success: false, message: "交易中的装备不可精炼" };
  if (!["bag", "warehouse", "equipped"].includes(String(row.location))) {
    return { success: false, message: "该物品当前位置不可精炼" };
  }
  if ((Number(row.qty) || 0) !== 1)
    return { success: false, message: "装备数量异常" };

  return {
    success: true,
    message: "ok",
    item: {
      id: Number(row.id),
      qty: Number(row.qty) || 1,
      location: row.location,
      locked: Boolean(row.locked),
      refineLevel: clampInt(Number(row.refine_level) || 0, 0, REFINE_MAX_LEVEL),
    },
  };
};

const getRerollItemStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    affixPoolId: string;
    affixes: GeneratedAffix[];
    resolvedQuality: string | null;
    resolvedQualityRank: number;
    defQuality: string | null;
    defQualityRank: number;
    equipReqRealm: string | null;
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.affixes,
        ii.item_def_id,
        ii.quality,
        ii.quality_rank
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0)
    return { success: false, message: "物品不存在" };

  const row = itemResult.rows[0] as {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    affixes: unknown;
    item_def_id: string;
    quality: string | null;
    quality_rank: number | null;
  };

  const itemDef = getStaticItemDef(row.item_def_id);
  if (!itemDef || itemDef.category !== "equipment")
    return { success: false, message: "该物品不可洗炼" };
  if (row.locked) return { success: false, message: "物品已锁定" };
  if (String(row.location) === "auction")
    return { success: false, message: "交易中的装备不可洗炼" };
  if (!["bag", "warehouse", "equipped"].includes(String(row.location))) {
    return { success: false, message: "该物品当前位置不可洗炼" };
  }
  if ((Number(row.qty) || 0) !== 1)
    return { success: false, message: "装备数量异常" };

  const affixPoolId = String(itemDef.affix_pool_id || "").trim();
  if (!affixPoolId) return { success: false, message: "该装备没有可用词条池" };

  const affixes = parseGeneratedAffixesForReroll(row.affixes);
  if (affixes.length <= 0)
    return { success: false, message: "该装备没有可洗炼词条" };

  return {
    success: true,
    message: "ok",
    item: {
      id: Number(row.id),
      qty: Number(row.qty) || 1,
      location: row.location,
      locked: Boolean(row.locked),
      affixPoolId,
      affixes,
      resolvedQuality:
        typeof row.quality === "string"
          ? row.quality
          : typeof itemDef.quality === "string"
            ? itemDef.quality
            : null,
      resolvedQualityRank: Math.max(
        1,
        Math.floor(
          Number(row.quality_rank) ||
            resolveQualityRankFromName(row.quality ?? itemDef.quality, 1),
        ),
      ),
      defQuality: typeof itemDef.quality === "string" ? itemDef.quality : null,
      defQualityRank: resolveQualityRankFromName(itemDef.quality, 1),
      equipReqRealm:
        typeof itemDef.equip_req_realm === "string"
          ? itemDef.equip_req_realm
          : null,
    },
  };
};

const loadGemItemForSocketTx = async (
  client: PoolClient,
  characterId: number,
  gemItemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  gem?: {
    itemInstanceId: number;
    itemDefId: string;
    name: string;
    icon: string | null;
    gemType: string;
    effects: SocketEffect[];
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [gemItemInstanceId, characterId],
  );

  if (itemResult.rows.length === 0)
    return { success: false, message: "宝石不存在" };

  const item = itemResult.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };

  if (item.locked) return { success: false, message: "宝石已锁定" };
  if (!["bag", "warehouse"].includes(String(item.location))) {
    return { success: false, message: "宝石当前位置不可消耗" };
  }
  if ((Number(item.qty) || 0) < 1)
    return { success: false, message: "宝石数量不足" };

  const gemDefId = String(item.item_def_id || "");
  if (!gemDefId) return { success: false, message: "宝石数据异常" };

  const row = getEnabledStaticItemDef(gemDefId);
  if (!row) return { success: false, message: "宝石不存在" };
  if (!isGemItemDefinition(row)) {
    return { success: false, message: "该物品不是宝石" };
  }
  const effects = parseSocketEffectsFromItemEffectDefs(row.effect_defs);
  if (effects.length === 0)
    return { success: false, message: "该宝石不可镶嵌" };

  return {
    success: true,
    message: "ok",
    gem: {
      itemInstanceId: Number(item.id),
      itemDefId: String(row.id),
      name: String(row.name || row.id),
      icon: row.icon ? String(row.icon) : null,
      gemType: resolveGemTypeFromItemDefinition(row),
      effects,
    },
  };
};

const normalizeGemSlotTypes = (raw: unknown): unknown => {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return normalizeGemSlotTypes(parsed);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw) || (typeof raw === "object" && raw !== null)) {
    return raw;
  }
  return null;
};

const normalizeSocketedGemEntries = (raw: unknown): SocketedGemEntry[] => {
  return parseSocketedGems(raw);
};

const toSocketedGemsJson = (entries: SocketedGemEntry[]): string => {
  const out = entries
    .map((entry) => ({
      slot: clampInt(Number(entry.slot) || 0, 0, 999),
      itemDefId: String(entry.itemDefId || "").trim(),
      gemType: String(entry.gemType || "").trim() || "all",
      effects: entry.effects
        .map((effect) => ({
          attrKey: String(effect.attrKey || "").trim(),
          value: Number(effect.value) || 0,
          applyType: effect.applyType,
        }))
        .filter(
          (effect) =>
            effect.attrKey &&
            Number.isFinite(effect.value) &&
            effect.value !== 0,
        ),
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : undefined,
      icon:
        typeof entry.icon === "string" && entry.icon.trim()
          ? entry.icon.trim()
          : undefined,
    }))
    .filter((entry) => entry.itemDefId && entry.effects.length > 0)
    .sort((a, b) => a.slot - b.slot);
  return JSON.stringify(out);
};

const findSocketEntryBySlot = (
  entries: SocketedGemEntry[],
  slot: number,
): SocketedGemEntry | null => {
  const target = clampInt(slot, 0, 999);
  return (
    entries.find(
      (entry) => clampInt(Number(entry.slot) || 0, 0, 999) === target,
    ) ?? null
  );
};

const getNextAvailableSocketSlot = (
  entries: SocketedGemEntry[],
  socketMax: number,
): number | null => {
  const max = clampInt(socketMax, 0, 99);
  if (max <= 0) return null;
  const used = new Set(
    entries.map((entry) => clampInt(Number(entry.slot) || 0, 0, 999)),
  );
  for (let slot = 0; slot < max; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
};

const upsertSocketEntry = (
  entries: SocketedGemEntry[],
  nextEntry: SocketedGemEntry,
): SocketedGemEntry[] => {
  const slot = clampInt(Number(nextEntry.slot) || 0, 0, 999);
  const filtered = entries.filter(
    (entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== slot,
  );
  return [...filtered, nextEntry].sort((a, b) => a.slot - b.slot);
};

const removeSocketEntryBySlot = (
  entries: SocketedGemEntry[],
  slot: number,
): SocketedGemEntry[] => {
  const target = clampInt(slot, 0, 999);
  return entries.filter(
    (entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== target,
  );
};

const readEquipmentSocketStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    location: string;
    qty: number;
    locked: boolean;
    socketMax: number;
    gemSlotTypes: unknown;
    socketedEntries: SocketedGemEntry[];
  };
}> => {
  const result = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.socketed_gems,
        ii.item_def_id,
        ii.quality_rank
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );
  if (result.rows.length === 0)
    return { success: false, message: "物品不存在" };
  const row = result.rows[0] as {
    id: number;
    qty: number;
    location: string;
    locked: boolean;
    socketed_gems: unknown;
    item_def_id: string;
    quality_rank: unknown;
  };

  const itemDef = getStaticItemDef(row.item_def_id);
  if (!itemDef || itemDef.category !== "equipment")
    return { success: false, message: "该物品不可镶嵌" };
  if (row.locked) return { success: false, message: "物品已锁定" };
  if ((Number(row.qty) || 0) !== 1)
    return { success: false, message: "装备数量异常" };
  if (String(row.location) === "auction")
    return { success: false, message: "交易中的装备不可镶嵌" };
  if (!["bag", "warehouse", "equipped"].includes(String(row.location))) {
    return { success: false, message: "该物品当前位置不可镶嵌" };
  }

  const resolvedQualityRank =
    Number(row.quality_rank) || resolveQualityRankFromName(itemDef.quality, 1);
  const socketMax = resolveSocketMax(itemDef.socket_max, resolvedQualityRank);
  if (socketMax <= 0) return { success: false, message: "该装备无可用镶嵌孔" };

  return {
    success: true,
    message: "ok",
    item: {
      id: Number(row.id),
      location: String(row.location),
      qty: Number(row.qty) || 1,
      locked: Boolean(row.locked),
      socketMax,
      gemSlotTypes: normalizeGemSlotTypes(itemDef.gem_slot_types),
      socketedEntries: normalizeSocketedGemEntries(row.socketed_gems),
    },
  };
};

const getEquippedSetBonusDeltaTx = async (
  client: PoolClient,
  characterId: number,
): Promise<Map<CharacterAttrKey, number>> => {
  const equippedResult = await client.query(
    `
      SELECT ii.item_def_id
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.location = 'equipped'
    `,
    [characterId],
  );

  const counts = new Map<string, number>();
  for (const row of equippedResult.rows as Array<{ item_def_id?: unknown }>) {
    const itemDef = getStaticItemDef(row.item_def_id);
    const setId = String(itemDef?.set_id || "");
    if (!setId) continue;
    counts.set(setId, (counts.get(setId) || 0) + 1);
  }

  const setIds = [...counts.keys()];
  if (setIds.length === 0) return new Map();

  const staticSetMap = new Map(
    getItemSetDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, entry] as const),
  );

  const delta = new Map<CharacterAttrKey, number>();

  for (const setId of setIds) {
    const pieces = counts.get(setId) || 0;
    const setDef = staticSetMap.get(setId);
    if (!setDef) continue;

    const bonuses = (Array.isArray(setDef.bonuses) ? setDef.bonuses : [])
      .map((bonus) => ({
        pieceCount: Math.max(1, Math.floor(Number(bonus.piece_count) || 1)),
        priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
        effectDefs: Array.isArray(bonus.effect_defs) ? bonus.effect_defs : [],
      }))
      .sort(
        (left, right) =>
          left.priority - right.priority || left.pieceCount - right.pieceCount,
      );

    for (const bonus of bonuses) {
      if (pieces < bonus.pieceCount) continue;
      for (const effect of bonus.effectDefs) {
        if (!effect || typeof effect !== "object") continue;
        const e = effect as {
          trigger?: unknown;
          target?: unknown;
          effect_type?: unknown;
          params?: unknown;
        };
        if (e.effect_type !== "buff") continue;
        if (e.trigger !== "equip") continue;
        if (e.target !== "self") continue;
        if (!e.params || typeof e.params !== "object") continue;

        const p = e.params as {
          attr_key?: unknown;
          value?: unknown;
          apply_type?: unknown;
        };
        if (p.apply_type !== "flat") continue;
        if (typeof p.attr_key !== "string") continue;
        addToDelta(delta, p.attr_key, p.value);
      }
    }
  }

  return delta;
};

// ============================================
// 获取背包信息（容量与使用情况）
// ============================================
export const getInventoryInfo = async (
  characterId: number,
): Promise<InventoryInfo> => {
  return getInventoryInfoWithClient(characterId, null);
};

export const getInventoryInfoWithClient = async (
  characterId: number,
  client: PoolClient | null,
): Promise<InventoryInfo> => {
  const sql = `
    SELECT
      i.bag_capacity,
      i.warehouse_capacity,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as bag_used,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'warehouse'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as warehouse_used
    FROM inventory i
    WHERE i.character_id = $1
  `;

  const result = await runQuery(client, sql, [characterId]);

  if (result.rows.length === 0) {
    await runQuery(
      client,
      "INSERT INTO inventory (character_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [characterId],
    );
    return {
      bag_capacity: 100,
      warehouse_capacity: 50,
      bag_used: 0,
      warehouse_used: 0,
    };
  }

  const info = result.rows[0];
  return info;
};

// ============================================
// 获取背包物品列表（分页优化）
// ============================================
export const getInventoryItems = async (
  characterId: number,
  location: InventoryLocation = "bag",
  page: number = 1,
  pageSize: number = 100,
): Promise<{ items: InventoryItem[]; total: number }> => {
  await getInventoryInfo(characterId);
  const offset = (page - 1) * pageSize;

  // 使用单次查询获取数据和总数
  const sql = `
    WITH items AS (
      SELECT 
        ii.id, ii.item_def_id, ii.qty, ii.location, ii.location_slot,
        ii.quality, ii.quality_rank,
        ii.equipped_slot, ii.strengthen_level, ii.refine_level,
        ii.socketed_gems,
        ii.affixes, ii.identified, ii.locked, ii.bind_type, ii.created_at
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.location = $2
      ORDER BY ii.location_slot NULLS LAST, ii.created_at DESC
      LIMIT $3 OFFSET $4
    ),
    total AS (
      SELECT COUNT(*) as cnt FROM item_instance 
      WHERE owner_character_id = $1 AND location = $2
    )
    SELECT items.*, total.cnt as total_count
    FROM items, total
  `;

  const result = await query(sql, [characterId, location, pageSize, offset]);

  const total =
    result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
  const items = result.rows.map((row) => {
    const { total_count, ...item } = row;
    return item as InventoryItem;
  });

  return { items, total };
};

// ============================================
// 查找空闲格子（性能优化版）
// ============================================
export const findEmptySlots = async (
  characterId: number,
  location: SlottedInventoryLocation,
  count: number = 1,
): Promise<number[]> => {
  return findEmptySlotsWithClient(characterId, location, count, null);
};

export const findEmptySlotsWithClient = async (
  characterId: number,
  location: SlottedInventoryLocation,
  count: number = 1,
  client: PoolClient | null,
): Promise<number[]> => {
  const info = await getInventoryInfoWithClient(characterId, client);
  const capacity = getSlottedCapacity(info, location);

  // 获取已占用的格子
  const sql = `
    SELECT location_slot FROM item_instance
    WHERE owner_character_id = $1 AND location = $2 AND location_slot IS NOT NULL
    ORDER BY location_slot
  `;
  const result = await runQuery(client, sql, [characterId, location]);
  const usedSlots = new Set(result.rows.map((r) => r.location_slot));

  // 找出空闲格子
  const emptySlots: number[] = [];
  for (let i = 0; i < capacity && emptySlots.length < count; i++) {
    if (!usedSlots.has(i)) {
      emptySlots.push(i);
    }
  }

  return emptySlots;
};

// ============================================
// 添加物品到背包（智能堆叠）
// ============================================
/**
 * 统一的库存写事务执行器。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：把库存写入逻辑统一包裹在 `BEGIN/COMMIT/ROLLBACK` 语义里。
 * - 不做什么：不吞掉执行器抛出的未知异常；业务失败由调用方返回 `success: false`。
 *
 * 输入/输出：
 * - 输入：已获取的 `PoolClient` 与执行器函数。
 * - 输出：执行器返回值；当 `success=false` 时自动回滚当前事务层。
 *
 * 数据流/状态流：
 * - 总是先执行 `BEGIN`；
 * - 执行器返回失败则 `ROLLBACK`；
 * - 执行器返回成功则 `COMMIT`；
 * - 执行器抛异常则 `ROLLBACK` 后继续抛出。
 *
 * 关键边界条件与坑点：
 * 1) 当外层已经在事务中时，此处 `BEGIN` 会由数据库层自动转换为 SAVEPOINT 语义，保证可嵌套。
 * 2) `pg_advisory_xact_lock` 必须处于事务中才有正确生命周期，因此锁操作必须放在该执行器内部。
 */
const runInventoryMutationTx = async <T extends { success: boolean }>(
  _client: PoolClient,
  executor: () => Promise<T>,
): Promise<T> => {
  // 调用者已经在事务中，不需要再次 BEGIN/COMMIT
  // 如果 result.success 为 false，调用者会处理 ROLLBACK
  return await executor();
};

export const addItemToInventoryTx = async (
  client: PoolClient,
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: SlottedInventoryLocation;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  const isUniqueViolation = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    return (error as { code?: unknown }).code === "23505";
  };

  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "数量参数错误" };
  }

  return runInventoryMutationTx(client, async () => {
    await lockCharacterInventoryMutexTx(client, characterId);

    const location = options.location || "bag";
    const bindType = options.bindType || "none";

    const itemDef = getStaticItemDef(itemDefId);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }

    const stack_max = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
    const def_bind_type = String(itemDef.bind_type || "none");
    const actualBindType = bindType !== "none" ? bindType : def_bind_type;
    const obtainedFrom = normalizeItemInstanceObtainedFrom(
      options.obtainedFrom,
    ).value;

    const info = await getInventoryInfoWithClient(characterId, client);
    const capacity = getSlottedCapacity(info, location);

    const itemIds: number[] = [];
    let remainingQty = qty;

    let stackRows: Array<{ id: number; qty: number }> = [];
    if (stack_max > 1) {
      const stackResult = await client.query(
        `
          SELECT id, qty FROM item_instance
          WHERE owner_character_id = $1 AND item_def_id = $2 
            AND location = $3 AND qty < $4 AND bind_type = $5
          ORDER BY qty DESC
          FOR UPDATE
        `,
        [characterId, itemDefId, location, stack_max, actualBindType],
      );
      stackRows = stackResult.rows.map((r) => ({
        id: Number(r.id),
        qty: Number(r.qty),
      }));
    }

    let remainingAfterStacks = remainingQty;
    if (stack_max > 1 && stackRows.length > 0) {
      let freeInStacks = 0;
      for (const row of stackRows) {
        const rowQty = Number(row.qty) || 0;
        const free = Math.max(0, stack_max - rowQty);
        freeInStacks += free;
      }
      remainingAfterStacks = Math.max(0, remainingQty - freeInStacks);
    }

    const neededSlots =
      remainingAfterStacks <= 0
        ? 0
        : Math.ceil(remainingAfterStacks / Math.max(1, stack_max));
    if (neededSlots > 0) {
      const emptySlots = await findEmptySlotsWithClient(
        characterId,
        location,
        neededSlots,
        client,
      );
      if (emptySlots.length < neededSlots) {
        return { success: false, message: "背包已满" };
      }
    }

    if (stack_max > 1 && stackRows.length > 0) {
      for (const row of stackRows) {
        if (remainingQty <= 0) break;

        const rowQty = Number(row.qty) || 0;
        const canAdd = Math.min(remainingQty, Math.max(0, stack_max - rowQty));
        if (canAdd <= 0) continue;

        await client.query(
          "UPDATE item_instance SET qty = qty + $1, updated_at = NOW() WHERE id = $2",
          [canAdd, row.id],
        );
        itemIds.push(row.id);
        remainingQty -= canAdd;
      }
    }

    while (remainingQty > 0) {
      const addQty = Math.min(remainingQty, Math.max(1, stack_max));
      let insertedId: number | null = null;
      let attempt = 0;

      while (insertedId === null && attempt < 6) {
        attempt += 1;
        const emptySlots = await findEmptySlotsWithClient(
          characterId,
          location,
          6,
          client,
        );
        if (emptySlots.length === 0) {
          return { success: false, message: "背包已满" };
        }

        for (const slot of emptySlots) {
          try {
            const insertResult = await client.query(
              `
                INSERT INTO item_instance (
                  owner_user_id, owner_character_id, item_def_id, qty,
                  location, location_slot, bind_type, affixes, obtained_from
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
              `,
              [
                userId,
                characterId,
                itemDefId,
                addQty,
                location,
                slot,
                actualBindType,
                options.affixes ? JSON.stringify(options.affixes) : null,
                obtainedFrom,
              ],
            );
            insertedId = Number(insertResult.rows[0]?.id);
            break;
          } catch (error) {
            if (isUniqueViolation(error)) continue;
            throw error;
          }
        }
      }

      if (insertedId === null || !Number.isFinite(insertedId)) {
        return { success: false, message: "背包已满" };
      }

      itemIds.push(insertedId);
      remainingQty -= addQty;
    }

    const usedSlots = location === "bag" ? info.bag_used : info.warehouse_used;
    if (usedSlots > capacity) {
      return { success: false, message: "背包数据异常" };
    }

    return { success: true, message: "添加成功", itemIds };
  });
};

export const addItemToInventory = async (
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: SlottedInventoryLocation;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
  } = {},
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  return await withTransaction(async (client) => {
    return await addItemToInventoryTx(
      client,
      characterId,
      userId,
      itemDefId,
      qty,
      options,
    );
  });
};

// ============================================
// 移除物品（支持部分移除）
// ============================================
export const removeItemFromInventory = async (
  characterId: number,
  itemInstanceId: number,
  qty: number = 1,
): Promise<{ success: boolean; message: string }> => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: "数量参数错误" };
  }

  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    // 获取物品信息并锁定
    const result = await client.query(
      `
      SELECT id, qty, locked FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
    `,
      [itemInstanceId, characterId],
    );
  
    if (result.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const item = result.rows[0];
  
    if (item.locked) {
      return { success: false, message: "物品已锁定" };
    }
  
    if (item.qty < qty) {
      return { success: false, message: "数量不足" };
    }
  
    if (item.qty === qty) {
      // 完全移除
      await client.query("DELETE FROM item_instance WHERE id = $1", [
        itemInstanceId,
      ]);
    } else {
      // 部分移除
      await client.query(
        "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2",
        [qty, itemInstanceId],
      );
    }
return { success: true, message: "移除成功" };
  });
};

// ============================================
// 锁定 / 解锁物品
// ============================================
export const setItemLocked = async (
  characterId: number,
  itemInstanceId: number,
  locked: boolean,
): Promise<{
  success: boolean;
  message: string;
  data?: { itemId: number; locked: boolean };
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemResult = await client.query(
      `
        SELECT id, location
        FROM item_instance
        WHERE id = $1 AND owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId],
    );
  
    if (itemResult.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const row = itemResult.rows[0] as { id: number; location: string };
    const location = String(row.location || "");
    if (location === "auction") {
      return { success: false, message: "该物品当前位置不可锁定" };
    }
    if (!["bag", "warehouse", "equipped"].includes(location)) {
      return { success: false, message: "该物品当前位置不可锁定" };
    }
  
    await client.query(
      `
        UPDATE item_instance
        SET locked = $1, updated_at = NOW()
        WHERE id = $2 AND owner_character_id = $3
      `,
      [locked, itemInstanceId, characterId],
    );
return {
      success: true,
      message: locked ? "已锁定" : "已解锁",
      data: { itemId: itemInstanceId, locked },
    };
  });
};

// ============================================
// 移动物品（换位/移动到仓库）
// ============================================
export const moveItem = async (
  characterId: number,
  itemInstanceId: number,
  targetLocation: SlottedInventoryLocation,
  targetSlot?: number,
): Promise<{ success: boolean; message: string }> => {
  type MoveItemRow = {
    id: number;
    item_def_id: string;
    qty: number;
    location: string;
    location_slot: number | null;
    bind_type: string;
  };
  type StackTargetRow = { id: number; qty: number };
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    // 获取物品信息
    const itemResult = await client.query(
      `
      SELECT
        ii.id,
        ii.item_def_id,
        ii.qty,
        ii.location,
        ii.location_slot,
        ii.bind_type
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
    `,
      [itemInstanceId, characterId],
    );
  
    if (itemResult.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const item = itemResult.rows[0] as MoveItemRow;
    const itemDef = getStaticItemDef(item.item_def_id);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }
    const currentLocationText = String(item.location);
    if (currentLocationText !== "bag" && currentLocationText !== "warehouse") {
      return { success: false, message: "当前位置不支持移动" };
    }
    const currentLocation = currentLocationText as SlottedInventoryLocation;
    const currentSlotRaw = item.location_slot;
    if (currentSlotRaw === null) {
      return { success: false, message: "物品格子状态异常" };
    }
    const currentSlot = Number(currentSlotRaw);
    if (!Number.isInteger(currentSlot) || currentSlot < 0) {
      return { success: false, message: "物品格子状态异常" };
    }
    const stackMax = Math.max(1, Math.floor(Number(itemDef.stack_max) || 1));
    const originalQty = Math.max(0, Number(item.qty) || 0);
    if (originalQty <= 0) {
      return { success: false, message: "物品数量异常" };
    }
  
    let remainingQty = originalQty;
    if (currentLocation !== targetLocation && stackMax > 1) {
      const stackResult = await client.query(
        `
          SELECT id, qty FROM item_instance
          WHERE owner_character_id = $1
            AND location = $2
            AND item_def_id = $3
            AND bind_type = $4
            AND qty < $5
            AND id != $6
          ORDER BY qty DESC, id ASC
          FOR UPDATE
        `,
        [
          characterId,
          targetLocation,
          item.item_def_id,
          item.bind_type,
          stackMax,
          itemInstanceId,
        ],
      );
  
      const stackRows = stackResult.rows as StackTargetRow[];
      for (const row of stackRows) {
        if (remainingQty <= 0) break;
        const stackQty = Math.max(0, Number(row.qty) || 0);
        const canAdd = Math.min(remainingQty, Math.max(0, stackMax - stackQty));
        if (canAdd <= 0) continue;
  
        await client.query(
          `
            UPDATE item_instance
            SET qty = qty + $1, updated_at = NOW()
            WHERE id = $2 AND owner_character_id = $3
          `,
          [canAdd, Number(row.id), characterId],
        );
        remainingQty -= canAdd;
      }
  
      if (remainingQty <= 0) {
        await client.query(
          `
            DELETE FROM item_instance
            WHERE id = $1 AND owner_character_id = $2
          `,
          [itemInstanceId, characterId],
        );
return { success: true, message: "移动成功" };
      }
  
      if (remainingQty !== originalQty) {
        await client.query(
          `
            UPDATE item_instance
            SET qty = $1, updated_at = NOW()
            WHERE id = $2 AND owner_character_id = $3
          `,
          [remainingQty, itemInstanceId, characterId],
        );
      }
    }
  
    // 检查目标位置容量
    const info = await getInventoryInfoWithClient(characterId, client);
    const capacity = getSlottedCapacity(info, targetLocation);
    if (targetSlot !== undefined) {
      if (
        !Number.isInteger(targetSlot) ||
        targetSlot < 0 ||
        targetSlot >= capacity
      ) {
        return { success: false, message: "目标格子超出容量" };
      }
    }
  
    // 确定目标格子
    let finalSlot = targetSlot;
    if (finalSlot === undefined) {
      const emptySlots = await findEmptySlotsWithClient(
        characterId,
        targetLocation,
        1,
        client,
      );
      if (emptySlots.length === 0) {
        return { success: false, message: "目标位置已满" };
      }
      finalSlot = emptySlots[0];
    } else {
      // 检查目标格子是否被占用
      const slotCheck = await client.query(
        `
        SELECT id FROM item_instance
        WHERE owner_character_id = $1 AND location = $2 AND location_slot = $3 AND id != $4
        FOR UPDATE
      `,
        [characterId, targetLocation, finalSlot, itemInstanceId],
      );
  
      if (slotCheck.rows.length > 0) {
        // 交换位置
        const otherItemId = Number(slotCheck.rows[0].id);
        if (!Number.isInteger(otherItemId) || otherItemId <= 0) {
          return { success: false, message: "目标格子状态异常" };
        }
  
        // 先临时释放当前物品格子，再执行换位，避免唯一索引瞬时冲突
        await client.query(
          `
            UPDATE item_instance
            SET location_slot = NULL, updated_at = NOW()
            WHERE id = $1 AND owner_character_id = $2
          `,
          [itemInstanceId, characterId],
        );
  
        await client.query(
          `
          UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
          WHERE id = $3 AND owner_character_id = $4
        `,
          [currentLocation, currentSlot, otherItemId, characterId],
        );
      }
    }
  
    // 移动物品
    await client.query(
      `
      UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
      WHERE id = $3 AND owner_character_id = $4
    `,
      [targetLocation, finalSlot, itemInstanceId, characterId],
    );
return { success: true, message: "移动成功" };
  });
};

// ============================================
// 装备 / 卸下装备
// ============================================
export const equipItem = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  equippedSlot?: string;
  swappedOutItemId?: number;
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const beforeSetBonus = await getEquippedSetBonusDeltaTx(
      client,
      characterId,
    );
  
    const itemResult = await client.query(
      `
        SELECT ii.id, ii.qty, ii.location, ii.location_slot, ii.locked, ii.item_def_id
        FROM item_instance ii
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId],
    );
  
    if (itemResult.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const item = itemResult.rows[0] as {
      id: number;
      qty: number;
      location: InventoryLocation;
      location_slot: number | null;
      locked: boolean;
      item_def_id: string;
    };
  
    const itemDef = getStaticItemDef(item.item_def_id);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }
  
    if (item.locked) {
      return { success: false, message: "物品已锁定" };
    }
  
    if (itemDef.category !== "equipment") {
      return { success: false, message: "该物品不可装备" };
    }
  
    const equipSlot = String(itemDef.equip_slot || "").trim();
    if (!equipSlot) {
      return { success: false, message: "装备槽位配置错误" };
    }
  
    if (item.qty !== 1) {
      return { success: false, message: "装备数量异常" };
    }
  
    if (item.location === "equipped") {
      return { success: false, message: "该装备已穿戴" };
    }
  
    if (item.location !== "bag" && item.location !== "warehouse") {
      return { success: false, message: "该物品当前位置不可装备" };
    }
  
    const equipRequiredRealm =
      typeof itemDef.equip_req_realm === "string"
        ? itemDef.equip_req_realm.trim()
        : "";
    if (equipRequiredRealm) {
      const characterRealmResult = await client.query(
        `
          SELECT realm, sub_realm
          FROM characters
          WHERE id = $1
          FOR UPDATE
          LIMIT 1
        `,
        [characterId],
      );
  
      if (characterRealmResult.rows.length === 0) {
        return { success: false, message: "角色不存在" };
      }
  
      const characterRealm = characterRealmResult.rows[0] as {
        realm: string;
        sub_realm: string | null;
      };
      const characterRealmRank = getRealmRankOneBasedStrict(
        characterRealm.realm,
        characterRealm.sub_realm,
      );
      const equipRequiredRealmRank =
        getEquipRealmRankForReroll(equipRequiredRealm);
      if (characterRealmRank < equipRequiredRealmRank) {
        return {
          success: false,
          message: `境界不足，需达到${equipRequiredRealm}`,
        };
      }
    }
  
    const newItemDelta = await getEquipmentAttrDeltaByInstanceIdTx(
      client,
      characterId,
      itemInstanceId,
    );
    if (!newItemDelta) {
      return { success: false, message: "装备数据异常" };
    }
  
    const currentlyEquippedResult = await client.query(
      `
        SELECT ii.id
        FROM item_instance ii
        WHERE ii.owner_character_id = $1 AND ii.location = 'equipped' AND ii.equipped_slot = $2
        FOR UPDATE
      `,
      [characterId, equipSlot],
    );
  
    let swappedOutItemId: number | undefined;
    if (currentlyEquippedResult.rows.length > 0) {
      swappedOutItemId = Number(currentlyEquippedResult.rows[0].id);
      if (Number.isFinite(swappedOutItemId)) {
        const oldDelta = await getEquipmentAttrDeltaByInstanceIdTx(
          client,
          characterId,
          swappedOutItemId,
        );
        if (!oldDelta) {
          return { success: false, message: "当前已穿戴装备数据异常" };
        }
  
        const emptySlots = await findEmptySlotsWithClient(
          characterId,
          "bag",
          1,
          client,
        );
        if (emptySlots.length === 0) {
          return { success: false, message: "背包已满，无法替换装备" };
        }
  
        await client.query(
          `
            UPDATE item_instance
            SET location = 'bag',
                location_slot = $1,
                equipped_slot = NULL,
                updated_at = NOW()
            WHERE id = $2 AND owner_character_id = $3
          `,
          [emptySlots[0], swappedOutItemId, characterId],
        );
  
        await applyCharacterAttrDeltaTx(
          client,
          characterId,
          invertDelta(oldDelta),
        );
      }
    }
  
    await client.query(
      `
        UPDATE item_instance
        SET location = 'equipped',
            location_slot = NULL,
            equipped_slot = $1,
            bind_type = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN 'equip'
              ELSE bind_type
            END,
            bind_owner_user_id = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN $3
              ELSE bind_owner_user_id
            END,
            bind_owner_character_id = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN $4
              ELSE bind_owner_character_id
            END,
            updated_at = NOW()
        WHERE id = $5 AND owner_character_id = $4
      `,
      [
        equipSlot,
        String(itemDef.bind_type || "none"),
        userId,
        characterId,
        itemInstanceId,
      ],
    );
  
    await applyCharacterAttrDeltaTx(client, characterId, newItemDelta);
  
    const afterSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);
    const setBonusDelta = new Map<CharacterAttrKey, number>();
    mergeDelta(setBonusDelta, afterSetBonus);
    mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
    await applyCharacterAttrDeltaTx(client, characterId, setBonusDelta);
await invalidateCharacterComputedCache(characterId);
    return {
      success: true,
      message: "穿戴成功",
      equippedSlot: equipSlot,
      swappedOutItemId,
    };
  });
};

export const unequipItem = async (
  characterId: number,
  itemInstanceId: number,
  options: { targetLocation?: SlottedInventoryLocation } = {},
): Promise<{
  success: boolean;
  message: string;
  movedTo?: { location: SlottedInventoryLocation; slot: number };
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const beforeSetBonus = await getEquippedSetBonusDeltaTx(
      client,
      characterId,
    );
  
    const itemResult = await client.query(
      `
        SELECT id, location, equipped_slot, locked
        FROM item_instance
        WHERE id = $1 AND owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId],
    );
  
    if (itemResult.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const item = itemResult.rows[0] as {
      id: number;
      location: InventoryLocation;
      equipped_slot: string | null;
      locked: boolean;
    };
  
    if (item.locked) {
      return { success: false, message: "物品已锁定" };
    }
  
    if (item.location !== "equipped") {
      return { success: false, message: "该物品未穿戴" };
    }
  
    const delta = await getEquipmentAttrDeltaByInstanceIdTx(
      client,
      characterId,
      itemInstanceId,
    );
    if (!delta) {
      return { success: false, message: "装备数据异常" };
    }
  
    const targetLocation = options.targetLocation || "bag";
    const emptySlots = await findEmptySlotsWithClient(
      characterId,
      targetLocation,
      1,
      client,
    );
    if (emptySlots.length === 0) {
      return {
        success: false,
        message: targetLocation === "bag" ? "背包已满" : "仓库已满",
      };
    }
  
    const slot = emptySlots[0];
  
    await client.query(
      `
        UPDATE item_instance
        SET location = $1,
            location_slot = $2,
            equipped_slot = NULL,
            updated_at = NOW()
        WHERE id = $3 AND owner_character_id = $4
      `,
      [targetLocation, slot, itemInstanceId, characterId],
    );
  
    await applyCharacterAttrDeltaTx(client, characterId, invertDelta(delta));
  
    const afterSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);
    const setBonusDelta = new Map<CharacterAttrKey, number>();
    mergeDelta(setBonusDelta, afterSetBonus);
    mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
    await applyCharacterAttrDeltaTx(client, characterId, setBonusDelta);
await invalidateCharacterComputedCache(characterId);
    return {
      success: true,
      message: "卸下成功",
      movedTo: { location: targetLocation, slot },
    };
  });
};

export const enhanceEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    strengthenLevel: number;
    targetLevel?: number;
    successRate?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    character?: unknown;
  };
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemState = await getEnhanceItemStateTx(
      client,
      characterId,
      itemInstanceId,
    );
    if (!itemState.success || !itemState.item) {
      return { success: false, message: itemState.message };
    }
    const item = itemState.item;
  
    const curLv = clampInt(item.strengthenLevel, 0, ENHANCE_MAX_LEVEL);
    if (curLv >= ENHANCE_MAX_LEVEL) {
      return {
        success: false,
        message: "强化已达上限",
        data: { strengthenLevel: curLv, targetLevel: curLv },
      };
    }
  
    const targetLv = curLv + 1;
    const costPlan = buildEnhanceCostPlan(targetLv);
  
    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
    );
    if (!beforeDiffRes.success) {
      return { success: false, message: beforeDiffRes.message };
    }
  
    const materialRes = await consumeMaterialByDefIdTx(
      client,
      characterId,
      costPlan.materialItemDefId,
      costPlan.materialQty,
    );
    if (!materialRes.success) {
      return { success: false, message: materialRes.message };
    }
  
    const currencyRes = await consumeCharacterCurrenciesTx(
      client,
      characterId,
      {
        silver: costPlan.silverCost,
        spiritStones: costPlan.spiritStoneCost,
      },
    );
    if (!currencyRes.success) {
      return { success: false, message: currencyRes.message };
    }
  
    const baseRate = getEnhanceSuccessRatePercent(targetLv);
    const finalRate = Math.max(0, Math.min(1, baseRate));
    const roll = randomInt(0, 10_000) / 10_000;
    const success = roll < finalRate;
  
    const resultLevel = success
      ? targetLv
      : getEnhanceFailResultLevel(curLv, targetLv);
  
    if (resultLevel !== curLv) {
      await client.query(
        "UPDATE item_instance SET strengthen_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        [resultLevel, itemInstanceId, characterId],
      );
    }
  
    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before,
    );
    if (!applyDiffRes.success) {
      return { success: false, message: applyDiffRes.message };
    }
await invalidateCharacterComputedCache(characterId);
    const character = await getCharacterComputedByCharacterId(characterId, {
      bypassStaticCache: true,
    });
    return {
      success,
      message: success ? "强化成功" : "强化失败",
      data: {
        strengthenLevel: resultLevel,
        targetLevel: targetLv,
        successRate: finalRate,
        roll,
        usedMaterial: {
          itemDefId: costPlan.materialItemDefId,
          qty: costPlan.materialQty,
        },
        costs: {
          silver: costPlan.silverCost,
          spiritStones: costPlan.spiritStoneCost,
        },
        character: character ?? null,
      },
    };
  });
};

export const refineEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    refineLevel: number;
    targetLevel?: number;
    successRate?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    character?: unknown;
  };
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemState = await getRefineItemStateTx(
      client,
      characterId,
      itemInstanceId,
    );
    if (!itemState.success || !itemState.item) {
      return { success: false, message: itemState.message };
    }
    const item = itemState.item;
  
    const curLv = clampInt(item.refineLevel, 0, REFINE_MAX_LEVEL);
    if (curLv >= REFINE_MAX_LEVEL) {
      return {
        success: false,
        message: "精炼已达上限",
        data: { refineLevel: curLv, targetLevel: curLv },
      };
    }
  
    const targetLv = curLv + 1;
    const costPlan = buildRefineCostPlan(targetLv);
  
    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
    );
    if (!beforeDiffRes.success) {
      return { success: false, message: beforeDiffRes.message };
    }
  
    const materialRes = await consumeMaterialByDefIdTx(
      client,
      characterId,
      costPlan.materialItemDefId,
      costPlan.materialQty,
    );
    if (!materialRes.success) {
      return { success: false, message: materialRes.message };
    }
  
    const currencyRes = await consumeCharacterCurrenciesTx(
      client,
      characterId,
      {
        silver: costPlan.silverCost,
        spiritStones: costPlan.spiritStoneCost,
      },
    );
    if (!currencyRes.success) {
      return { success: false, message: currencyRes.message };
    }
  
    const finalRate = getRefineSuccessRatePercent(targetLv);
    const roll = randomInt(0, 10_000) / 10_000;
    const success = roll < finalRate;
    const resultLevel = success
      ? targetLv
      : getRefineFailResultLevel(curLv, targetLv);
  
    if (resultLevel !== curLv) {
      await client.query(
        "UPDATE item_instance SET refine_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        [resultLevel, itemInstanceId, characterId],
      );
    }
  
    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before,
    );
    if (!applyDiffRes.success) {
      return { success: false, message: applyDiffRes.message };
    }
await invalidateCharacterComputedCache(characterId);
    const character = await getCharacterComputedByCharacterId(characterId, {
      bypassStaticCache: true,
    });
    return {
      success,
      message: success ? "精炼成功" : "精炼失败",
      data: {
        refineLevel: resultLevel,
        targetLevel: targetLv,
        successRate: finalRate,
        roll,
        usedMaterial: {
          itemDefId: costPlan.materialItemDefId,
          qty: costPlan.materialQty,
        },
        costs: {
          silver: costPlan.silverCost,
          spiritStones: costPlan.spiritStoneCost,
        },
        character: character ?? null,
      },
    };
  });
};

export const rerollEquipmentAffixes = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
  lockIndexes: number[] = [],
): Promise<{
  success: boolean;
  message: string;
  data?: {
    affixes: GeneratedAffix[];
    lockIndexes: number[];
    costs: {
      silver: number;
      spiritStones: number;
      rerollScroll: { itemDefId: string; qty: number };
    };
    character?: unknown;
  };
}> => {
  try {
    return await withTransaction(async (client) => {
  await lockCharacterInventoryMutexTx(client, characterId);
  
      const itemState = await getRerollItemStateTx(
        client,
        characterId,
        itemInstanceId,
      );
      if (!itemState.success || !itemState.item) {
        return { success: false, message: itemState.message };
      }
      const item = itemState.item;
  
      const normalizedLockIndexes = normalizeAffixLockIndexes(lockIndexes);
      const lockValidation = validateAffixLockIndexes(
        item.affixes.length,
        normalizedLockIndexes,
      );
      if (!lockValidation.success) {
        return { success: false, message: lockValidation.message };
      }
  
      const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(
        client,
        characterId,
        itemInstanceId,
        item.location,
      );
      if (!beforeDiffRes.success) {
        return { success: false, message: beforeDiffRes.message };
      }
  
      const affixPool = await loadAffixPoolForRerollTx(client, item.affixPoolId);
      if (!affixPool) {
        return { success: false, message: "该装备没有可用词条池" };
      }
  
      const quality = resolveQualityForReroll(
        item.resolvedQuality,
        item.resolvedQualityRank,
        item.defQuality,
        item.defQualityRank,
      );
      const realmRank = getEquipRealmRankForReroll(item.equipReqRealm);
      const costPlan = buildAffixRerollCostPlan(
        item.equipReqRealm,
        lockValidation.normalizedLockIndexes.length,
      );
      const resolvedQualityMultiplier = getQualityMultiplierForReroll(
        item.resolvedQualityRank,
      );
      const defQualityMultiplier = getQualityMultiplierForReroll(
        item.defQualityRank,
      );
      const attrFactor =
        Number.isFinite(defQualityMultiplier) && defQualityMultiplier > 0
          ? resolvedQualityMultiplier / defQualityMultiplier
          : 1;
  
      const rerollRes = rerollEquipmentAffixesWithLocks({
        currentAffixes: item.affixes,
        lockIndexes: lockValidation.normalizedLockIndexes,
        pool: affixPool,
        quality,
        realmRank,
        attrFactor,
      });
      if (!rerollRes.success || !rerollRes.affixes) {
        return { success: false, message: rerollRes.message };
      }
  
      const rerolledAffixes = rerollRes.affixes;
      if (rerolledAffixes.length !== item.affixes.length) {
        return {
          success: false,
          message: "当前锁定组合无法完成洗炼，请减少锁定词条",
        };
      }
  
      if (costPlan.rerollScrollQty > 0) {
        const rerollScrollRes = await consumeMaterialByDefIdTx(
          client,
          characterId,
          costPlan.rerollScrollItemDefId,
          costPlan.rerollScrollQty,
        );
        if (!rerollScrollRes.success) {
          return { success: false, message: rerollScrollRes.message };
        }
      }
  
      const currencyRes = await consumeCharacterCurrenciesTx(
        client,
        characterId,
        {
          silver: costPlan.silverCost,
          spiritStones: costPlan.spiritStoneCost,
        },
      );
      if (!currencyRes.success) {
        return { success: false, message: currencyRes.message };
      }
  
      await client.query(
        `
          UPDATE item_instance
          SET affixes = $1::jsonb,
              affix_gen_version = 4,
              updated_at = NOW()
          WHERE id = $2 AND owner_character_id = $3
        `,
        [JSON.stringify(rerolledAffixes), itemInstanceId, characterId],
      );
  
      const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
        client,
        characterId,
        itemInstanceId,
        item.location,
        beforeDiffRes.before,
      );
      if (!applyDiffRes.success) {
        return { success: false, message: applyDiffRes.message };
      }
  await invalidateCharacterComputedCache(characterId);
      const character = await getCharacterComputedByCharacterId(characterId, {
        bypassStaticCache: true,
      });
      return {
        success: true,
        message: "洗炼成功",
        data: {
          affixes: rerolledAffixes,
          lockIndexes: lockValidation.normalizedLockIndexes,
          costs: {
            silver: costPlan.silverCost,
            spiritStones: costPlan.spiritStoneCost,
            rerollScroll: {
              itemDefId: costPlan.rerollScrollItemDefId,
              qty: costPlan.rerollScrollQty,
            },
          },
          character: character ?? null,
        },
      };
    });
  } catch (error) {
console.error("洗炼装备词条失败:", error);
    return { success: false, message: "洗炼装备词条失败" };
  }
};

export const socketEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
  gemItemInstanceId: number,
  options: { slot?: number } = {},
): Promise<{
  success: boolean;
  message: string;
  data?: {
    socketedGems: SocketedGemEntry[];
    socketMax: number;
    slot: number;
    gem: {
      itemDefId: string;
      name: string;
      icon: string | null;
      gemType: string;
    };
    replacedGem?: SocketedGemEntry;
    costs?: { silver: number };
    character?: unknown;
  };
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const socketState = await readEquipmentSocketStateTx(
      client,
      characterId,
      itemInstanceId,
    );
    if (!socketState.success || !socketState.item) {
      return { success: false, message: socketState.message };
    }
    const equip = socketState.item;
  
    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      equip.location,
    );
    if (!beforeDiffRes.success) {
      return { success: false, message: beforeDiffRes.message };
    }
  
    let slot =
      options.slot === undefined || options.slot === null
        ? null
        : clampInt(
            Number(options.slot) || 0,
            0,
            Math.max(0, equip.socketMax - 1),
          );
    if (slot === null) {
      slot = getNextAvailableSocketSlot(equip.socketedEntries, equip.socketMax);
      if (slot === null) {
        return { success: false, message: "镶嵌孔已满，请指定替换孔位" };
      }
    }
  
    if (slot < 0 || slot >= equip.socketMax) {
      return { success: false, message: "孔位参数错误" };
    }
  
    const gemRes = await loadGemItemForSocketTx(
      client,
      characterId,
      gemItemInstanceId,
    );
    if (!gemRes.success || !gemRes.gem) {
      return { success: false, message: gemRes.message };
    }
    const gem = gemRes.gem;
  
    if (!isGemTypeAllowedInSlot(equip.gemSlotTypes, slot, gem.gemType)) {
      return { success: false, message: "该宝石类型与孔位不匹配" };
    }
  
    const duplicatedGem = equip.socketedEntries.find(
      (entry) =>
        String(entry.itemDefId || "") === String(gem.itemDefId || "") &&
        clampInt(Number(entry.slot) || 0, 0, 999) !== slot,
    );
    if (duplicatedGem) {
      return { success: false, message: "同一件装备不可镶嵌相同宝石" };
    }
  
    const replacedGem = findSocketEntryBySlot(equip.socketedEntries, slot);
  
    const silverCost = replacedGem ? 100 : 50;
    const currencyRes = await consumeCharacterCurrenciesTx(
      client,
      characterId,
      {
        silver: silverCost,
      },
    );
    if (!currencyRes.success) {
      return { success: false, message: currencyRes.message };
    }
  
    const nextEntries = upsertSocketEntry(equip.socketedEntries, {
      slot,
      itemDefId: gem.itemDefId,
      gemType: gem.gemType,
      effects: gem.effects,
      name: gem.name,
      icon: gem.icon ?? undefined,
    });
  
    if ((Number(gem.itemInstanceId) || 0) > 0) {
      const consumeGemRes = await consumeSpecificItemInstanceTx(
        client,
        characterId,
        Number(gem.itemInstanceId),
        1,
      );
      if (!consumeGemRes.success) {
        return { success: false, message: consumeGemRes.message };
      }
    }
  
    await client.query(
      `UPDATE item_instance SET socketed_gems = $1::jsonb, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3`,
      [toSocketedGemsJson(nextEntries), itemInstanceId, characterId],
    );
  
    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      equip.location,
      beforeDiffRes.before,
    );
    if (!applyDiffRes.success) {
      return { success: false, message: applyDiffRes.message };
    }
await invalidateCharacterComputedCache(characterId);
    const character = await getCharacterComputedByCharacterId(characterId, {
      bypassStaticCache: true,
    });
    return {
      success: true,
      message: replacedGem ? "替换镶嵌成功" : "镶嵌成功",
      data: {
        socketedGems: nextEntries,
        socketMax: equip.socketMax,
        slot,
        gem: {
          itemDefId: gem.itemDefId,
          name: gem.name,
          icon: gem.icon,
          gemType: gem.gemType,
        },
        replacedGem: replacedGem ?? undefined,
        costs: { silver: silverCost },
        character: character ?? null,
      },
    };
  });
};

// ============================================
// 扩容背包
// ============================================
export const expandInventoryWithClient = async (
  client: PoolClient,
  characterId: number,
  location: SlottedInventoryLocation,
  expandSize: number = 10,
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  const validExpandSize = Number.isInteger(expandSize)
    ? expandSize
    : Math.floor(Number(expandSize));
  if (!Number.isInteger(validExpandSize) || validExpandSize <= 0) {
    return { success: false, message: "expandSize参数错误" };
  }

  const column = location === "bag" ? "bag_capacity" : "warehouse_capacity";
  const countColumn =
    location === "bag" ? "bag_expand_count" : "warehouse_expand_count";

  const infoResult = await client.query(
    `
      SELECT bag_capacity, warehouse_capacity
      FROM inventory
      WHERE character_id = $1
      FOR UPDATE
    `,
    [characterId],
  );

  if (infoResult.rows.length === 0) {
    return { success: false, message: "背包不存在" };
  }

  const currentBagCapacity = Number(infoResult.rows[0]?.bag_capacity) || 0;
  const currentWarehouseCapacity =
    Number(infoResult.rows[0]?.warehouse_capacity) || 0;
  const currentCapacity =
    location === "bag" ? currentBagCapacity : currentWarehouseCapacity;
  const nextCapacity = currentCapacity + validExpandSize;

  if (location === "bag") {
    if (currentCapacity >= BAG_CAPACITY_MAX) {
      return {
        success: false,
        message: `背包容量已达上限（${BAG_CAPACITY_MAX}格）`,
      };
    }
    if (nextCapacity > BAG_CAPACITY_MAX) {
      return {
        success: false,
        message: `扩容后超过上限（${BAG_CAPACITY_MAX}格）`,
      };
    }
  }

  const result = await client.query(
    `
      UPDATE inventory
      SET ${column} = ${column} + $1,
          ${countColumn} = ${countColumn} + 1,
          updated_at = NOW()
      WHERE character_id = $2
      RETURNING ${column} as new_capacity
    `,
    [validExpandSize, characterId],
  );

  if (result.rows.length === 0) {
    return { success: false, message: "背包不存在" };
  }

  return {
    success: true,
    message: "扩容成功",
    newCapacity: Number(result.rows[0].new_capacity) || nextCapacity,
  };
};

export const expandInventory = async (
  characterId: number,
  location: SlottedInventoryLocation,
  expandSize: number = 10,
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const result = await expandInventoryWithClient(
      client,
      characterId,
      location,
      expandSize,
    );
    if (!result.success) {
      return result;
    }
return result;
  });
};

// ============================================
type DisassembleGrantedItemReward = {
  itemDefId: string;
  qty: number;
  itemIds?: number[];
};

type DisassembleRewardsPayload = {
  silver: number;
  items: DisassembleGrantedItemReward[];
};

export const disassembleEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
  qty: number,
): Promise<{
  success: boolean;
  message: string;
  rewards?: DisassembleRewardsPayload;
}> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.item_def_id,
          ii.qty,
          ii.location,
          ii.locked,
          ii.quality_rank AS instance_quality_rank,
          ii.strengthen_level,
          ii.refine_level,
          ii.affixes
        FROM item_instance ii
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId],
    );
  
    if (itemResult.rows.length === 0) {
      return { success: false, message: "物品不存在" };
    }
  
    const item = itemResult.rows[0] as {
      id: number;
      item_def_id: string;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      instance_quality_rank: number | null;
      strengthen_level: number;
      refine_level: number;
      affixes: unknown;
    };
  
    const itemDef = getStaticItemDef(item.item_def_id);
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }
    const itemCategory = String(itemDef.category || "");
    const itemSubCategory = itemDef.sub_category ?? null;
    const itemEffectDefs = itemDef.effect_defs ?? null;
    const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
    const resolvedQualityRank = item.instance_quality_rank ?? defQualityRank;
  
    if (item.locked) {
      return { success: false, message: "物品已锁定" };
    }
  
    if (item.location === "equipped") {
      if (itemCategory !== "equipment") {
        return { success: false, message: "该物品当前位置不可分解" };
      }
      return { success: false, message: "穿戴中的装备不可分解" };
    }
  
    if (item.location !== "bag" && item.location !== "warehouse") {
      return { success: false, message: "该物品当前位置不可分解" };
    }
  
    const rowQty = Math.max(0, Number(item.qty) || 0);
    if (rowQty < 1) {
      return { success: false, message: "物品数量异常" };
    }
  
    const consumeQty = Math.max(1, Math.floor(Number(qty) || 0));
    if (consumeQty > rowQty) {
      return { success: false, message: "道具数量不足" };
    }
  
    const rewardPlan = buildDisassembleRewardPlan({
      category: itemCategory,
      subCategory: itemSubCategory,
      effectDefs: itemEffectDefs,
      qualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: item.strengthen_level,
      refineLevelRaw: item.refine_level,
      affixesRaw: item.affixes,
      qty: consumeQty,
    });
    if (!rewardPlan.success) {
      return { success: false, message: rewardPlan.message };
    }
  
    const consumeRes = await consumeSpecificItemInstanceTx(
      client,
      characterId,
      itemInstanceId,
      consumeQty,
    );
    if (!consumeRes.success) {
      return { success: false, message: consumeRes.message };
    }
  
    const grantedItemRewards: DisassembleGrantedItemReward[] = [];
    for (const itemReward of rewardPlan.rewards.items) {
      const addResult = await addItemToInventoryTx(
        client,
        characterId,
        userId,
        itemReward.itemDefId,
        itemReward.qty,
        {
          location: "bag",
          obtainedFrom: "disassemble",
        },
      );
      if (!addResult.success) {
        return addResult as { success: false; message: string };
      }
      grantedItemRewards.push({
        itemDefId: itemReward.itemDefId,
        qty: itemReward.qty,
        itemIds: addResult.itemIds,
      });
    }
  
    if (rewardPlan.rewards.silver > 0) {
      const addCurrencyRes = await addCharacterCurrenciesTx(
        client,
        characterId,
        {
          silver: rewardPlan.rewards.silver,
        },
      );
      if (!addCurrencyRes.success) {
        return { success: false, message: addCurrencyRes.message };
      }
    }
return {
      success: true,
      message: "分解成功",
      rewards: {
        silver: rewardPlan.rewards.silver,
        items: grantedItemRewards,
      },
    };
  });
};

export const disassembleEquipmentBatch = async (
  characterId: number,
  userId: number,
  items: Array<{ itemId: number; qty: number }>,
): Promise<{
  success: boolean;
  message: string;
  disassembledCount?: number;
  disassembledQtyTotal?: number;
  skippedLockedCount?: number;
  skippedLockedQtyTotal?: number;
  rewards?: DisassembleRewardsPayload;
}> => {
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, message: "items参数错误" };
  }

  const qtyById = new Map<number, number>();
  for (const row of items) {
    const itemId = Number(row?.itemId);
    const qty = Number(row?.qty);
    if (
      !Number.isInteger(itemId) ||
      itemId <= 0 ||
      !Number.isInteger(qty) ||
      qty <= 0
    ) {
      return { success: false, message: "items参数错误" };
    }
    const prev = qtyById.get(itemId) ?? 0;
    qtyById.set(itemId, prev + qty);
  }

  const uniqueIds = [...qtyById.keys()];
  if (uniqueIds.length === 0) {
    return { success: false, message: "items参数错误" };
  }
  if (uniqueIds.length > 200) {
    return { success: false, message: "一次最多分解200个物品" };
  }

  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.item_def_id,
          ii.qty,
          ii.location,
          ii.locked,
          ii.quality_rank AS instance_quality_rank,
          ii.strengthen_level,
          ii.refine_level,
          ii.affixes
        FROM item_instance ii
        WHERE ii.owner_character_id = $1 AND ii.id = ANY($2)
        FOR UPDATE
      `,
      [characterId, uniqueIds],
    );
  
    if (itemResult.rows.length !== uniqueIds.length) {
      return { success: false, message: "包含不存在的物品" };
    }
  
    const consumeOperations: Array<{
      id: number;
      rowQty: number;
      consumeQty: number;
    }> = [];
    let skippedEquippedCount = 0;
    let skippedLockedCount = 0;
    let skippedLockedQtyTotal = 0;
    let disassembledQtyTotal = 0;
    let totalSilver = 0;
    const rewardItemQtyByDefId = new Map<string, number>();
    const staticDefMap = getItemDefinitionsByIds(
      itemResult.rows.map((row) =>
        String((row as { item_def_id?: unknown }).item_def_id || "").trim(),
      ),
    );
  
    for (const row of itemResult.rows as Array<{
      id: number | string;
      item_def_id: string;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      instance_quality_rank: number | null;
      strengthen_level: number;
      refine_level: number;
      affixes: unknown;
    }>) {
      const itemDefId = String(row.item_def_id || "").trim();
      const itemDef = staticDefMap.get(itemDefId);
      if (!itemDef) {
        return { success: false, message: "包含不存在的物品" };
      }
  
      // item_instance.id 为 BIGSERIAL，pg 在部分配置下会返回 string。
      // 这里统一转为 number 再参与 Map<number, number> 查找，避免误报 items参数错误。
      const rowId = Number(row.id);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        return { success: false, message: "items参数错误" };
      }
  
      const requestQty = qtyById.get(rowId) ?? 0;
      if (requestQty <= 0) {
        return { success: false, message: "items参数错误" };
      }
      const rowQty = Math.max(0, Number(row.qty) || 0);
      if (rowQty < requestQty) {
        return { success: false, message: "包含数量不足的物品" };
      }
      if (row.location === "equipped") {
        skippedEquippedCount += 1;
        continue;
      }
      if (row.location !== "bag" && row.location !== "warehouse") {
        return { success: false, message: "包含不可分解位置的物品" };
      }
      if (row.locked) {
        skippedLockedCount += 1;
        skippedLockedQtyTotal += requestQty;
        continue;
      }
  
      const rewardPlan = buildDisassembleRewardPlan({
        category: String(itemDef.category || ""),
        subCategory: itemDef.sub_category ?? null,
        effectDefs: itemDef.effect_defs ?? null,
        qualityRankRaw:
          row.instance_quality_rank ??
          resolveQualityRankFromName(itemDef.quality, 1),
        strengthenLevelRaw: row.strengthen_level,
        refineLevelRaw: row.refine_level,
        affixesRaw: row.affixes,
        qty: requestQty,
      });
      if (!rewardPlan.success) {
        return { success: false, message: rewardPlan.message };
      }
  
      totalSilver += rewardPlan.rewards.silver;
      for (const itemReward of rewardPlan.rewards.items) {
        const prevQty = rewardItemQtyByDefId.get(itemReward.itemDefId) ?? 0;
        rewardItemQtyByDefId.set(
          itemReward.itemDefId,
          prevQty + itemReward.qty,
        );
      }
  
      consumeOperations.push({ id: rowId, rowQty, consumeQty: requestQty });
      disassembledQtyTotal += requestQty;
    }
  
    if (consumeOperations.length === 0) {
      return { success: false, message: "没有可分解的物品" };
    }
  
    for (const op of consumeOperations) {
      if (op.consumeQty >= op.rowQty) {
        await client.query(
          "DELETE FROM item_instance WHERE owner_character_id = $1 AND id = $2",
          [characterId, op.id],
        );
      } else {
        await client.query(
          "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE owner_character_id = $2 AND id = $3",
          [op.consumeQty, characterId, op.id],
        );
      }
    }
  
    const grantedItemRewards: DisassembleGrantedItemReward[] = [];
    for (const [itemDefId, rewardQty] of rewardItemQtyByDefId.entries()) {
      if (rewardQty <= 0) continue;
      const addRes = await addItemToInventoryTx(
        client,
        characterId,
        userId,
        itemDefId,
        rewardQty,
        {
          location: "bag",
          obtainedFrom: "disassemble",
        },
      );
      if (!addRes.success) {
        return addRes as { success: false; message: string };
      }
      grantedItemRewards.push({
        itemDefId,
        qty: rewardQty,
        itemIds: addRes.itemIds,
      });
    }
  
    if (totalSilver > 0) {
      const addCurrencyRes = await addCharacterCurrenciesTx(
        client,
        characterId,
        { silver: totalSilver },
      );
      if (!addCurrencyRes.success) {
        return { success: false, message: addCurrencyRes.message };
      }
    }
const skippedMessages: string[] = [];
    if (skippedLockedCount > 0)
      skippedMessages.push(`已跳过已锁定×${skippedLockedCount}`);
    if (skippedEquippedCount > 0)
      skippedMessages.push(`已跳过已穿戴装备×${skippedEquippedCount}`);
    const msg =
      skippedMessages.length > 0
        ? `分解成功（${skippedMessages.join("，")}）`
        : "分解成功";
    return {
      success: true,
      message: msg,
      disassembledCount: consumeOperations.length,
      disassembledQtyTotal,
      skippedLockedCount,
      skippedLockedQtyTotal,
      rewards: { silver: totalSilver, items: grantedItemRewards },
    };
  });
};

export const removeItemsBatch = async (
  characterId: number,
  itemInstanceIds: number[],
): Promise<{
  success: boolean;
  message: string;
  removedCount?: number;
  removedQtyTotal?: number;
  skippedLockedCount?: number;
  skippedLockedQtyTotal?: number;
}> => {
  if (!Array.isArray(itemInstanceIds) || itemInstanceIds.length === 0) {
    return { success: false, message: "itemIds参数错误" };
  }

  const uniqueIds = [
    ...new Set(
      itemInstanceIds
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
  if (uniqueIds.length === 0) {
    return { success: false, message: "itemIds参数错误" };
  }
  if (uniqueIds.length > 200) {
    return { success: false, message: "一次最多丢弃200个物品" };
  }

  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.qty,
          ii.location,
          ii.locked,
          ii.item_def_id
        FROM item_instance ii
        WHERE ii.owner_character_id = $1 AND ii.id = ANY($2)
        FOR UPDATE
      `,
      [characterId, uniqueIds],
    );
  
    if (itemResult.rows.length !== uniqueIds.length) {
      return { success: false, message: "包含不存在的物品" };
    }
  
    const staticDefMap = getItemDefinitionsByIds(
      itemResult.rows.map((row) =>
        String((row as { item_def_id?: unknown }).item_def_id || "").trim(),
      ),
    );
  
    const removableIds: number[] = [];
    let skippedLockedCount = 0;
    let skippedLockedQtyTotal = 0;
    let removedQtyTotal = 0;
    for (const row of itemResult.rows as Array<{
      id: number;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      item_def_id: string;
    }>) {
      const itemDef = staticDefMap.get(String(row.item_def_id || "").trim());
      if (!itemDef) {
        return { success: false, message: "包含不存在的物品" };
      }
      if (row.location === "equipped") {
        return { success: false, message: "包含穿戴中的物品" };
      }
      if (row.location !== "bag" && row.location !== "warehouse") {
        return { success: false, message: "包含不可丢弃位置的物品" };
      }
      if (itemDef.destroyable !== true) {
        return { success: false, message: "包含不可丢弃的物品" };
      }
      const rowId = Number(row.id);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        return { success: false, message: "itemIds参数错误" };
      }
  
      const rowQty = Math.max(0, Number(row.qty) || 0);
      if (row.locked) {
        skippedLockedCount += 1;
        skippedLockedQtyTotal += rowQty;
        continue;
      }
  
      removedQtyTotal += rowQty;
      removableIds.push(rowId);
    }
  
    if (removableIds.length === 0) {
      return { success: false, message: "没有可丢弃的物品" };
    }
  
    await client.query(
      "DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)",
      [characterId, removableIds],
    );
const msg =
      skippedLockedCount > 0
        ? `丢弃成功（已跳过已锁定×${skippedLockedCount}）`
        : "丢弃成功";
    return {
      success: true,
      message: msg,
      removedCount: removableIds.length,
      removedQtyTotal,
      skippedLockedCount,
      skippedLockedQtyTotal,
    };
  });
};

// 整理背包（重新排列物品）
// ============================================
export const sortInventory = async (
  characterId: number,
  location: SlottedInventoryLocation = "bag",
): Promise<{ success: boolean; message: string }> => {
  return await withTransaction(async (client) => {
await lockCharacterInventoryMutexTx(client, characterId);
  
    const info = await getInventoryInfoWithClient(characterId, client);
    const capacity = getSlottedCapacity(info, location);
    const itemResult = await client.query(
      `
        SELECT id, item_def_id, qty, quality_rank
        FROM item_instance
        WHERE owner_character_id = $1 AND location = $2
        FOR UPDATE
      `,
      [characterId, location],
    );
  
    const rows = itemResult.rows as Array<{
      id: number;
      item_def_id: string;
      qty: number;
      quality_rank: number | null;
    }>;
    const defMap = getItemDefinitionsByIds(
      rows.map((row) => String(row.item_def_id || "").trim()),
    );
    const sortableRows = rows.map((row) => {
      const itemDef = defMap.get(String(row.item_def_id || "").trim()) ?? null;
      const category = itemDef?.category ? String(itemDef.category) : null;
      const subCategory = itemDef?.sub_category
        ? String(itemDef.sub_category)
        : null;
      const resolvedQualityRank =
        Number(row.quality_rank) ||
        resolveQualityRankFromName(itemDef?.quality, 0);
      return { ...row, category, subCategory, resolvedQualityRank };
    });
  
    sortableRows.sort((left, right) => {
      const leftCategory = left.category;
      const rightCategory = right.category;
      if (leftCategory === null && rightCategory !== null) return 1;
      if (leftCategory !== null && rightCategory === null) return -1;
      if (leftCategory !== rightCategory)
        return String(leftCategory).localeCompare(String(rightCategory));
  
      if (left.resolvedQualityRank !== right.resolvedQualityRank) {
        return right.resolvedQualityRank - left.resolvedQualityRank;
      }
  
      const leftSubCategory = left.subCategory;
      const rightSubCategory = right.subCategory;
      if (leftSubCategory === null && rightSubCategory !== null) return 1;
      if (leftSubCategory !== null && rightSubCategory === null) return -1;
      if (leftSubCategory !== rightSubCategory) {
        return String(leftSubCategory).localeCompare(String(rightSubCategory));
      }
  
      const itemDefCompare = String(left.item_def_id).localeCompare(
        String(right.item_def_id),
      );
      if (itemDefCompare !== 0) return itemDefCompare;
  
      const qtyCompare = (Number(right.qty) || 0) - (Number(left.qty) || 0);
      if (qtyCompare !== 0) return qtyCompare;
  
      return Number(left.id) - Number(right.id);
    });
  
    // 分两步更新：先写入不冲突的临时槽位，再写回最终槽位，避免唯一索引冲突
    for (let index = 0; index < sortableRows.length; index += 1) {
      const row = sortableRows[index];
      const tempSlot = index < capacity ? -1 - index : null;
      await client.query(
        `
          UPDATE item_instance
          SET location_slot = $1,
              updated_at = NOW()
          WHERE id = $2 AND owner_character_id = $3
        `,
        [tempSlot, row.id, characterId],
      );
    }
  
    for (let index = 0; index < sortableRows.length; index += 1) {
      const row = sortableRows[index];
      const finalSlot = index < capacity ? index : null;
      await client.query(
        `
          UPDATE item_instance
          SET location_slot = $1,
              updated_at = NOW()
          WHERE id = $2 AND owner_character_id = $3
        `,
        [finalSlot, row.id, characterId],
      );
    }
return { success: true, message: "整理完成" };
  });
};
