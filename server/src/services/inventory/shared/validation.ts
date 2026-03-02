/**
 * 装备状态验证模块
 *
 * 作用：在强化/精炼/洗炼操作前，查询并校验装备实例的状态（存在性、锁定、位置、类别等），
 *       返回规范化的状态对象供后续操作使用。
 *
 * 输入/输出：
 * - getEnhanceItemState(characterId, itemInstanceId) — 强化前校验
 * - getRefineItemState(characterId, itemInstanceId) — 精炼前校验
 * - getRerollItemState(characterId, itemInstanceId) — 洗炼前校验
 *
 * 数据流：
 * - 查询 item_instance 表（FOR UPDATE 行锁）→ 加载静态定义 → 校验各项条件 → 返回状态
 *
 * 被引用方：equipment.ts（enhanceEquipment、refineEquipment、rerollEquipmentAffixes）
 *
 * 边界条件：
 * 1. 所有查询均使用 FOR UPDATE 行锁，必须在事务上下文中调用
 * 2. auction 位置的装备不可操作（交易中）
 */
import { query } from "../../../config/database.js";
import {
  ENHANCE_MAX_LEVEL,
  REFINE_MAX_LEVEL,
} from "../../equipmentGrowthRules.js";
import {
  parseGeneratedAffixesForReroll,
} from "../../equipmentAffixRerollService.js";
import { resolveQualityRankFromName } from "../../shared/itemQuality.js";
import type { GeneratedAffix } from "../../equipmentService.js";
import type { InventoryLocation } from "./types.js";
import { clampInt, getStaticItemDef } from "./helpers.js";

/**
 * 强化前装备状态校验
 * 返回装备的 id、qty、location、locked、strengthenLevel
 */
export const getEnhanceItemState = async (
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
  const itemResult = await query(
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

/**
 * 精炼前装备状态校验
 * 返回装备的 id、qty、location、locked、refineLevel
 */
export const getRefineItemState = async (
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
  const itemResult = await query(
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

/**
 * 洗炼前装备状态校验
 * 返回装备完整的洗炼所需状态（词条池、品质、境界等）
 */
export const getRerollItemState = async (
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
  const itemResult = await query(
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
