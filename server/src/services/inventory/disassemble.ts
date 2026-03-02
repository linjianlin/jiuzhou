/**
 * 装备拆解模块
 *
 * 作用：处理单件/批量装备拆解，计算拆解奖励（银两+材料）并发放。
 *       不做事务管理（由 service.ts 的 @Transactional 装饰器统一处理）。
 *
 * 输入/输出：
 * - disassembleEquipment(characterId, userId, itemInstanceId, qty) — 单件拆解
 * - disassembleEquipmentBatch(characterId, userId, items) — 批量拆解
 *
 * 数据流：
 * 1. 查询物品实例（FOR UPDATE）→ 2. 加载静态定义 → 3. 计算拆解奖励 →
 * 4. 扣除物品 → 5. 发放奖励物品/银两
 *
 * 被引用方：service.ts（InventoryService.disassembleEquipment / disassembleEquipmentBatch）
 *
 * 边界条件：
 * 1. 穿戴中的装备不可拆解（equipped 位置）
 * 2. 已锁定物品在批量拆解中自动跳过，不报错
 */
import { query } from "../../config/database.js";
import {
  getItemDefinitionsByIds,
} from "../staticConfigLoader.js";
import { buildDisassembleRewardPlan } from "../disassembleRewardPlanner.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { consumeSpecificItemInstance, addCharacterCurrencies } from "./shared/consume.js";
import { getStaticItemDef } from "./shared/helpers.js";
import type {
  InventoryLocation,
  DisassembleGrantedItemReward,
  DisassembleRewardsPayload,
} from "./shared/types.js";
import { addItemToInventory } from "./bag.js";

// ============================================
// 单件拆解
// ============================================

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
  await lockCharacterInventoryMutex(characterId);

  const itemResult = await query(
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

  const consumeRes = await consumeSpecificItemInstance(
    characterId,
    itemInstanceId,
    consumeQty,
  );
  if (!consumeRes.success) {
    return { success: false, message: consumeRes.message };
  }

  const grantedItemRewards: DisassembleGrantedItemReward[] = [];
  for (const itemReward of rewardPlan.rewards.items) {
    const addResult = await addItemToInventory(
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
    const addCurrencyRes = await addCharacterCurrencies(
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
};

// ============================================
// 批量拆解
// ============================================

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

  await lockCharacterInventoryMutex(characterId);

  const itemResult = await query(
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
      await query(
        "DELETE FROM item_instance WHERE owner_character_id = $1 AND id = $2",
        [characterId, op.id],
      );
    } else {
      await query(
        "UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE owner_character_id = $2 AND id = $3",
        [op.consumeQty, characterId, op.id],
      );
    }
  }

  const grantedItemRewards: DisassembleGrantedItemReward[] = [];
  for (const [itemDefId, rewardQty] of rewardItemQtyByDefId.entries()) {
    if (rewardQty <= 0) continue;
    const addRes = await addItemToInventory(
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
    const addCurrencyRes = await addCharacterCurrencies(
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
};
