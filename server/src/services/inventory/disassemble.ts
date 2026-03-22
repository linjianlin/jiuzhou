/**
 * 装备拆解模块
 *
 * 作用：处理单件/批量装备拆解，计算拆解奖励（银两+材料）并发放。
 *       不做事务管理（由 service.ts 的 @Transactional 装饰器统一处理）。
 *
 * 输入/输出：
 * - getDisassembleRewardPreview(characterId, itemInstanceId, qty) — 单件拆解奖励预览
 * - disassembleEquipment(characterId, userId, itemInstanceId, qty) — 单件拆解
 * - disassembleEquipmentBatch(characterId, userId, items) — 批量拆解
 *
 * 数据流：
 * 1. 查询物品实例（预览为只读查询，实际拆解为 FOR UPDATE）→ 2. 加载静态定义 →
 * 3. 复用同一份 buildDisassembleRewardPlan 计算奖励 → 4. 预览直接返回 / 实际拆解扣除物品并发奖
 *
 * 被引用方：service.ts（InventoryService.getDisassembleRewardPreview / disassembleEquipment / disassembleEquipmentBatch）
 *
 * 边界条件：
 * 1. 穿戴中的装备不可拆解，预览与实际拆解都会命中同一校验结果
 * 2. 前端不再自行推导产物，若奖励物品静态定义缺失，服务端直接返回配置错误，避免展示与结算继续漂移
 */
import {
  getItemDefinitionsByIds,
} from "../staticConfigLoader.js";
import {
  buildDisassembleRewardPlan,
  type DisassembleItemRewardPlan,
  type DisassembleRewardsPlan,
} from "../disassembleRewardPlanner.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import {
  loadPlayerInventoryStateByItemId,
  loadPlayerInventoryStatesByCharacterId,
} from "../playerStateRepository.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { resolveItemCanDisassemble } from "../shared/itemDisassembleRule.js";
import { consumeSpecificItemInstance, addCharacterCurrencies } from "./shared/consume.js";
import { getStaticItemDef } from "./shared/helpers.js";
import type {
  InventoryLocation,
  DisassembleGrantedItemReward,
  DisassembleRewardsPayload,
} from "./shared/types.js";
import { addItemToInventory } from "./bag.js";

type SingleDisassembleItemRow = {
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

type ResolvedNamedDisassembleRewardItem = {
  itemDefId: string;
  name: string;
  qty: number;
};

const loadSingleDisassembleRewardPlan = async (
  characterId: number,
  itemInstanceId: number,
  qty: number,
  _options: { forUpdate: boolean },
): Promise<
  | { success: true; rewards: DisassembleRewardsPlan }
  | { success: false; message: string }
> => {
  const item = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
  if (!item) {
    return { success: false, message: "物品不存在" };
  }
  const itemDef = getStaticItemDef(item.item_def_id);
  if (!itemDef) {
    return { success: false, message: "物品不存在" };
  }

  const itemCategory = String(itemDef.category || "");
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
  if (!resolveItemCanDisassemble(itemDef)) {
    return { success: false, message: "该物品不可分解" };
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
    subCategory: itemDef.sub_category ?? null,
    effectDefs: itemDef.effect_defs ?? null,
    qualityRankRaw:
      item.quality_rank ??
      resolveQualityRankFromName(itemDef.quality, 1),
    strengthenLevelRaw: item.strengthen_level,
    refineLevelRaw: item.refine_level,
    affixesRaw: item.affixes,
    qty: consumeQty,
  });
  if (!rewardPlan.success) {
    return { success: false, message: rewardPlan.message };
  }

  return {
    success: true,
    rewards: rewardPlan.rewards,
  };
};

const resolveNamedDisassembleRewardItems = (
  items: DisassembleItemRewardPlan[],
): {
  success: boolean;
  message: string;
  items?: ResolvedNamedDisassembleRewardItem[];
} => {
  const rewardDefMap = getItemDefinitionsByIds(items.map((item) => item.itemDefId));
  const resolvedItems: ResolvedNamedDisassembleRewardItem[] = [];

  for (const item of items) {
    const rewardDef = rewardDefMap.get(item.itemDefId);
    if (!rewardDef) {
      return { success: false, message: "分解奖励配置错误" };
    }
    const rewardName = typeof rewardDef.name === "string" ? rewardDef.name.trim() : "";
    if (!rewardName) {
      return { success: false, message: "分解奖励名称配置错误" };
    }
    resolvedItems.push({
      itemDefId: item.itemDefId,
      name: rewardName,
      qty: item.qty,
    });
  }

  return {
    success: true,
    message: "ok",
    items: resolvedItems,
  };
};

export const getDisassembleRewardPreview = async (
  characterId: number,
  itemInstanceId: number,
  qty: number,
): Promise<{
  success: boolean;
  message: string;
  rewards?: DisassembleRewardsPayload;
}> => {
  const rewardPlanResult = await loadSingleDisassembleRewardPlan(
    characterId,
    itemInstanceId,
    qty,
    { forUpdate: false },
  );
  if (!rewardPlanResult.success) {
    return rewardPlanResult;
  }

  const resolvedRewardItems = resolveNamedDisassembleRewardItems(
    rewardPlanResult.rewards.items,
  );
  if (!resolvedRewardItems.success || !resolvedRewardItems.items) {
    return { success: false, message: resolvedRewardItems.message };
  }

  return {
    success: true,
    message: "获取预览成功",
    rewards: {
      silver: rewardPlanResult.rewards.silver,
      items: resolvedRewardItems.items,
    },
  };
};

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

  const rewardPlanResult = await loadSingleDisassembleRewardPlan(
    characterId,
    itemInstanceId,
    qty,
    { forUpdate: true },
  );
  if (!rewardPlanResult.success) {
    return rewardPlanResult;
  }

  const resolvedRewardItems = resolveNamedDisassembleRewardItems(
    rewardPlanResult.rewards.items,
  );
  if (!resolvedRewardItems.success || !resolvedRewardItems.items) {
    return { success: false, message: resolvedRewardItems.message };
  }

  const consumeQty = Math.max(1, Math.floor(Number(qty) || 0));
  const consumeRes = await consumeSpecificItemInstance(
    characterId,
    itemInstanceId,
    consumeQty,
  );
  if (!consumeRes.success) {
    return { success: false, message: consumeRes.message };
  }

  const grantedItemRewards: DisassembleGrantedItemReward[] = [];
  for (let index = 0; index < rewardPlanResult.rewards.items.length; index += 1) {
    const itemReward = rewardPlanResult.rewards.items[index];
    const resolvedReward = resolvedRewardItems.items[index];
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
      name: resolvedReward.name,
      qty: itemReward.qty,
      itemIds: addResult.itemIds,
    });
  }

  if (rewardPlanResult.rewards.silver > 0) {
    const addCurrencyRes = await addCharacterCurrencies(
      characterId,
      {
        silver: rewardPlanResult.rewards.silver,
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
      silver: rewardPlanResult.rewards.silver,
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

  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  const itemRows = inventoryStates.filter((state) => uniqueIds.includes(state.id));

  if (itemRows.length !== uniqueIds.length) {
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
  const rewardItemsByDefId = new Map<string, ResolvedNamedDisassembleRewardItem>();
  const staticDefMap = getItemDefinitionsByIds(
    itemRows.map((row) => String(row.item_def_id || "").trim()),
  );

  for (const row of itemRows as Array<{
    id: number;
    item_def_id: string;
    qty: number;
    location: string;
    locked: boolean;
    quality_rank: number | null;
    strengthen_level: number | null;
    refine_level: number | null;
    affixes: unknown;
  }>) {
    const itemDefId = String(row.item_def_id || "").trim();
    const itemDef = staticDefMap.get(itemDefId);
    if (!itemDef) {
      return { success: false, message: "包含不存在的物品" };
    }

    const requestQty = qtyById.get(row.id) ?? 0;
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
    if (!resolveItemCanDisassemble(itemDef)) {
      return { success: false, message: "包含不可分解的物品" };
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
        row.quality_rank ??
        resolveQualityRankFromName(itemDef.quality, 1),
      strengthenLevelRaw: row.strengthen_level,
      refineLevelRaw: row.refine_level,
      affixesRaw: row.affixes,
      qty: requestQty,
    });
    if (!rewardPlan.success) {
      return { success: false, message: rewardPlan.message };
    }

    const namedRewardsResult = resolveNamedDisassembleRewardItems(
      rewardPlan.rewards.items,
    );
    if (!namedRewardsResult.success || !namedRewardsResult.items) {
      return { success: false, message: namedRewardsResult.message };
    }

    totalSilver += rewardPlan.rewards.silver;
    for (const itemReward of namedRewardsResult.items) {
      const existing = rewardItemsByDefId.get(itemReward.itemDefId);
      if (existing) {
        existing.qty += itemReward.qty;
        continue;
      }
      rewardItemsByDefId.set(itemReward.itemDefId, { ...itemReward });
    }

    consumeOperations.push({ id: row.id, rowQty, consumeQty: requestQty });
    disassembledQtyTotal += requestQty;
  }

  if (consumeOperations.length === 0) {
    return { success: false, message: "没有可分解的物品" };
  }

  for (const op of consumeOperations) {
    const consumeRes = await consumeSpecificItemInstance(
      characterId,
      op.id,
      op.consumeQty,
    );
    if (!consumeRes.success) {
      return { success: false, message: consumeRes.message };
    }
  }

  const grantedItemRewards: DisassembleGrantedItemReward[] = [];
  for (const rewardItem of rewardItemsByDefId.values()) {
    if (rewardItem.qty <= 0) continue;
    const addRes = await addItemToInventory(
      characterId,
      userId,
      rewardItem.itemDefId,
      rewardItem.qty,
      {
        location: "bag",
        obtainedFrom: "disassemble",
      },
    );
    if (!addRes.success) {
      return addRes as { success: false; message: string };
    }
    grantedItemRewards.push({
      itemDefId: rewardItem.itemDefId,
      name: rewardItem.name,
      qty: rewardItem.qty,
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
