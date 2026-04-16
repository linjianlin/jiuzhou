/**
 * 装备操作模块
 *
 * 作用：处理装备穿戴/卸下/强化/精炼/词条洗炼/洗炼预览等操作。
 *       不做事务管理（由 service.ts 的 @Transactional 装饰器统一处理）。
 *
 * 输入/输出：
 * - equipItem(characterId, userId, itemInstanceId) — 穿戴装备
 * - unequipItem(characterId, itemInstanceId, options) — 卸下装备
 * - enhanceEquipment(characterId, userId, itemInstanceId) — 强化装备
 * - refineEquipment(characterId, userId, itemInstanceId) — 精炼装备
 * - rerollEquipmentAffixes(characterId, userId, itemInstanceId, lockIndexes) — 词条洗炼
 * - getRerollCostPreview(characterId, itemInstanceId) — 洗炼消耗预览（纯查询）
 * - getAffixPoolPreview(characterId, itemInstanceId) — 洗炼词条池预览（纯查询）
 *
 * 数据流：
 * - 穿戴/卸下：校验 → 属性差分 → 更新位置 → 应用差分 → 套装加成
 * - 强化/精炼：校验 → 差分快照 → 消耗材料/货币 → 随机判定 → 更新等级 → 应用差分
 * - 洗炼：校验 → 差分快照 → 消耗材料/货币 → 重 roll 词条 → 更新词条 → 应用差分
 *
 * 被引用方：service.ts（InventoryService 的对应方法）
 *
 * 边界条件：
 * 1. 穿戴替换已有装备时，若背包无空位则拒绝操作
 * 2. 强化在冲击 +15 及以上失败时会碎装，+14 及以下失败保留原装备；精炼失败仍按既有规则回退等级
 */
import { query } from "../../config/database.js";
import { randomInt } from "crypto";
import {
  type EquipmentGrowthFailMode,
  REFINE_MAX_LEVEL,
  buildEquipmentDisplayBaseAttrs,
  getEnhanceFailMode,
  getEnhanceSuccessRatePercent,
  getRefineFailResultLevel,
  getRefineSuccessRatePercent,
  normalizeEnhanceLevel,
} from "../equipmentGrowthRules.js";
import {
  buildAffixRerollCostPlan,
  normalizeAffixLockIndexes,
  REROLL_SCROLL_ITEM_DEF_ID,
  validateAffixLockIndexes,
} from "../equipmentAffixRerollRules.js";
import {
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForReroll,
  parseGeneratedAffixesForReroll,
  rerollEquipmentAffixesWithLocks,
  resolveQualityForReroll,
} from "../equipmentAffixRerollService.js";
import { getAffixPoolDefinitions } from "../staticConfigLoader.js";
import type { GeneratedAffix } from "../equipmentService.js";
import {
  getCharacterComputedByCharacterId,
} from "../characterComputedService.js";
import {
  getRealmRankOneBasedForEquipment,
  getRealmRankOneBasedStrict,
} from "../shared/realmRules.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import {
  resolveAffixPoolBySlot,
} from "../shared/affixPoolSlotResolver.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import {
  getEquipmentAttrDeltaByInstanceId,
  applyCharacterAttrDelta,
  invertDelta,
  mergeDelta,
  diffEquipmentAttrIfEquipped,
  applyEquipmentDiffIfEquipped,
  getEquippedSetBonusDelta,
} from "./shared/attrDelta.js";
import type { CharacterAttrKey } from "./shared/types.js";
import type { SlottedInventoryLocation } from "./shared/types.js";
import { consumeMaterialByDefId, consumeCharacterCurrencies } from "./shared/consume.js";
import { getEnhanceItemState, getRefineItemState, getRerollItemState } from "./shared/validation.js";
import { clampInt, getStaticItemDef } from "./shared/helpers.js";
import { refreshCharacterBattleStateAfterEquipmentChange } from "./shared/battleStateRefresh.js";
import { getEquippedSetPieceCountMap } from "./shared/equippedSetCount.js";
import {
  buildDiscountedEquipmentGrowthCostPlan,
  getSectEquipmentGrowthDiscountContext,
} from "./shared/equipmentGrowthCost.js";
import { updateAchievementProgress } from "../achievementService.js";
import { findEmptySlots } from "./bag.js";
import {
  applyCharacterItemInstanceMutationsImmediately,
  bufferCharacterItemInstanceMutations,
  type BufferedCharacterItemInstanceMutation,
  type ItemInstanceSlotResolution,
  type JsonValue,
  loadProjectedCharacterItemInstanceById,
  loadProjectedCharacterItemInstancesByLocation,
} from "../shared/characterItemInstanceMutationService.js";

// ============================================
// 穿戴装备
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
  await lockCharacterInventoryMutex(characterId);

  const beforeSetBonus = await getEquippedSetBonusDelta(characterId);

  const item = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
  if (!item) {
    return { success: false, message: "物品不存在" };
  }

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
    const characterRealmResult = await query(
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

  const newItemDelta = await getEquipmentAttrDeltaByInstanceId(
    characterId,
    itemInstanceId,
  );
  if (!newItemDelta) {
    return { success: false, message: "装备数据异常" };
  }

  let swappedOutItemId: number | undefined;
  const currentEquippedItems = await loadProjectedCharacterItemInstancesByLocation(characterId, "equipped");
  const equippedInSlot = currentEquippedItems.find((entry) => entry.equipped_slot === equipSlot) ?? null;
  const pendingMutations: Array<BufferedCharacterItemInstanceMutation> = [];
  if (equippedInSlot) {
    swappedOutItemId = Number(equippedInSlot.id);
    if (Number.isFinite(swappedOutItemId)) {
      const oldDelta = await getEquipmentAttrDeltaByInstanceId(
        characterId,
        swappedOutItemId,
      );
      if (!oldDelta) {
        return { success: false, message: "当前已穿戴装备数据异常" };
      }

      const emptySlots = await findEmptySlots(characterId, "bag", 1);
      if (emptySlots.length === 0) {
        return { success: false, message: "背包已满，无法替换装备" };
      }

      pendingMutations.push({
        opId: `equip-swap-out:${swappedOutItemId}:${Date.now()}`,
        characterId,
        itemId: swappedOutItemId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...equippedInSlot,
          location: "bag",
          location_slot: null,
          equipped_slot: null,
        },
        slotResolution: { mode: 'auto' } satisfies ItemInstanceSlotResolution,
      });

      await applyCharacterAttrDelta(
        characterId,
        invertDelta(oldDelta),
      );
    }
  }

  pendingMutations.push({
    opId: `equip-item:${itemInstanceId}:${Date.now()}`,
    characterId,
    itemId: itemInstanceId,
    createdAt: Date.now() + pendingMutations.length,
    kind: "upsert",
    snapshot: {
      ...item,
      location: "equipped",
      location_slot: null,
      equipped_slot: equipSlot,
      bind_type:
        item.bind_type === "none" && String(itemDef.bind_type || "none") === "equip"
          ? "equip"
          : item.bind_type,
      bind_owner_user_id:
        item.bind_type === "none" && String(itemDef.bind_type || "none") === "equip"
          ? userId
          : item.bind_owner_user_id,
      bind_owner_character_id:
        item.bind_type === "none" && String(itemDef.bind_type || "none") === "equip"
          ? characterId
          : item.bind_owner_character_id,
    },
  });
  await bufferCharacterItemInstanceMutations(pendingMutations);

  await applyCharacterAttrDelta(characterId, newItemDelta);

  const afterSetBonus = await getEquippedSetBonusDelta(characterId);
  const setBonusDelta = new Map<CharacterAttrKey, number>();
  mergeDelta(setBonusDelta, afterSetBonus);
  mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
  await applyCharacterAttrDelta(characterId, setBonusDelta);
  const equippedSetPieceCountMap = await getEquippedSetPieceCountMap(characterId);
  for (const [setId, pieceCount] of equippedSetPieceCountMap.entries()) {
    if (pieceCount !== 4) continue;
    await updateAchievementProgress(characterId, `equipment:set:equipped:4:${setId}`, 1);
  }
  await refreshCharacterBattleStateAfterEquipmentChange(characterId);
  return {
    success: true,
    message: "穿戴成功",
    equippedSlot: equipSlot,
    swappedOutItemId,
  };
};

// ============================================
// 卸下装备
// ============================================

export const unequipItem = async (
  characterId: number,
  itemInstanceId: number,
  options: { targetLocation?: SlottedInventoryLocation } = {},
): Promise<{
  success: boolean;
  message: string;
  movedTo?: { location: SlottedInventoryLocation; slot: number };
}> => {
  await lockCharacterInventoryMutex(characterId);

  const beforeSetBonus = await getEquippedSetBonusDelta(characterId);

  const item = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
  if (!item) {
    return { success: false, message: "物品不存在" };
  }

  if (item.locked) {
    return { success: false, message: "物品已锁定" };
  }

  if (item.location !== "equipped") {
    return { success: false, message: "该物品未穿戴" };
  }

  const delta = await getEquipmentAttrDeltaByInstanceId(
    characterId,
    itemInstanceId,
  );
  if (!delta) {
    return { success: false, message: "装备数据异常" };
  }

  const targetLocation = options.targetLocation || "bag";
  const emptySlots = await findEmptySlots(
    characterId,
    targetLocation,
    1,
  );
  if (emptySlots.length === 0) {
    return {
      success: false,
      message: targetLocation === "bag" ? "背包已满" : "仓库已满",
    };
  }

  const slot = emptySlots[0];

  await bufferCharacterItemInstanceMutations([
    {
      opId: `unequip-item:${itemInstanceId}:${Date.now()}`,
      characterId,
      itemId: itemInstanceId,
      createdAt: Date.now(),
      kind: "upsert",
      snapshot: {
        ...item,
        location: targetLocation,
        location_slot: null,
        equipped_slot: null,
      },
      slotResolution: { mode: 'auto' } satisfies ItemInstanceSlotResolution,
    },
  ]);

  await applyCharacterAttrDelta(characterId, invertDelta(delta));

  const afterSetBonus = await getEquippedSetBonusDelta(characterId);
  const setBonusDelta = new Map<CharacterAttrKey, number>();
  mergeDelta(setBonusDelta, afterSetBonus);
  mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
  await applyCharacterAttrDelta(characterId, setBonusDelta);
  await refreshCharacterBattleStateAfterEquipmentChange(characterId);
  return {
    success: true,
    message: "卸下成功",
    movedTo: { location: targetLocation, slot },
  };
};

// ============================================
// 强化装备
// ============================================

export const enhanceEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    strengthenLevel: number | null;
    targetLevel?: number;
    successRate?: number;
    roll?: number;
    failMode?: EquipmentGrowthFailMode;
    destroyed?: boolean;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    character?: unknown;
  };
}> => {
  void userId;
  await lockCharacterInventoryMutex(characterId);

  const itemState = await getEnhanceItemState(
    characterId,
    itemInstanceId,
  );
  if (!itemState.success || !itemState.item) {
    return { success: false, message: itemState.message };
  }
  const item = itemState.item;

  const curLv = normalizeEnhanceLevel(item.strengthenLevel);
  const targetLv = curLv + 1;
  const equipReqRealmRank = getRealmRankOneBasedForEquipment(item.equipReqRealm);
  const { discountRate } = await getSectEquipmentGrowthDiscountContext(characterId);
  const costPlan = buildDiscountedEquipmentGrowthCostPlan(
    "enhance",
    targetLv,
    equipReqRealmRank,
    discountRate,
  );

  const beforeDiffRes = await diffEquipmentAttrIfEquipped(
    characterId,
    itemInstanceId,
    item.location,
  );
  if (!beforeDiffRes.success) {
    return { success: false, message: beforeDiffRes.message };
  }

  const materialRes = await consumeMaterialByDefId(
    characterId,
    costPlan.materialItemDefId,
    costPlan.materialQty,
  );
  if (!materialRes.success) {
    return { success: false, message: materialRes.message };
  }

  const currencyRes = await consumeCharacterCurrencies(
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
  const failMode = success ? "none" : getEnhanceFailMode(targetLv);
  const destroyed = !success && failMode === "destroy";
  const downgraded = !success && failMode === "downgrade";
  const resultLevel = success
    ? targetLv
    : destroyed
      ? null
      : downgraded
        ? Math.max(0, curLv - 1)
        : curLv;

  if (success) {
    const latestItem = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
    if (!latestItem) {
      return { success: false, message: "装备不存在" };
    }
    await applyCharacterItemInstanceMutationsImmediately([
      {
        opId: `enhance-equipment-success:${itemInstanceId}:${Date.now()}`,
        characterId,
        itemId: itemInstanceId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...latestItem,
          strengthen_level: targetLv,
        },
      },
    ]);
  } else if (downgraded) {
    const latestItem = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
    if (!latestItem) {
      return { success: false, message: "装备不存在" };
    }
    await bufferCharacterItemInstanceMutations([
      {
        opId: `enhance-equipment:${itemInstanceId}:${Date.now()}`,
        characterId,
        itemId: itemInstanceId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...latestItem,
          strengthen_level: resultLevel ?? 0,
        },
      },
    ]);
  } else if (destroyed) {
    if (String(item.location) === "equipped") {
      const beforeSetBonus = await getEquippedSetBonusDelta(characterId);
      await bufferCharacterItemInstanceMutations([
        {
          opId: `enhance-destroy:${itemInstanceId}:${Date.now()}`,
          characterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "delete",
          snapshot: null,
        },
      ]);
      if (beforeDiffRes.before) {
        await applyCharacterAttrDelta(
          characterId,
          invertDelta(beforeDiffRes.before),
        );
      }
      const afterSetBonus = await getEquippedSetBonusDelta(characterId);
      const setBonusDelta = new Map<CharacterAttrKey, number>();
      mergeDelta(setBonusDelta, afterSetBonus);
      mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
      await applyCharacterAttrDelta(characterId, setBonusDelta);
    } else {
      await bufferCharacterItemInstanceMutations([
        {
          opId: `enhance-destroy:${itemInstanceId}:${Date.now()}`,
          characterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "delete",
          snapshot: null,
        },
      ]);
    }
  }

  if (success || downgraded) {
    const applyDiffRes = await applyEquipmentDiffIfEquipped(
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before,
    );
    if (!applyDiffRes.success) {
      return { success: false, message: applyDiffRes.message };
    }
  }
  await refreshCharacterBattleStateAfterEquipmentChange(characterId);
  const character = await getCharacterComputedByCharacterId(characterId, {
    bypassStaticCache: true,
  });
  return {
    success,
    message: success ? "强化成功" : destroyed ? "强化失败，装备已碎" : "强化失败",
    data: {
      strengthenLevel: resultLevel,
      targetLevel: targetLv,
      successRate: finalRate,
      roll,
      failMode,
      destroyed,
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
};

// ============================================
// 精炼装备
// ============================================

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
  void userId;
  await lockCharacterInventoryMutex(characterId);

  const itemState = await getRefineItemState(
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
  const equipReqRealmRank = getRealmRankOneBasedForEquipment(item.equipReqRealm);
  const { discountRate } = await getSectEquipmentGrowthDiscountContext(characterId);
  const costPlan = buildDiscountedEquipmentGrowthCostPlan(
    "refine",
    targetLv,
    equipReqRealmRank,
    discountRate,
  );

  const beforeDiffRes = await diffEquipmentAttrIfEquipped(
    characterId,
    itemInstanceId,
    item.location,
  );
  if (!beforeDiffRes.success) {
    return { success: false, message: beforeDiffRes.message };
  }

  const materialRes = await consumeMaterialByDefId(
    characterId,
    costPlan.materialItemDefId,
    costPlan.materialQty,
  );
  if (!materialRes.success) {
    return { success: false, message: materialRes.message };
  }

  const currencyRes = await consumeCharacterCurrencies(
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
    const latestItem = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
    if (!latestItem) {
      return { success: false, message: "装备不存在" };
    }
    await bufferCharacterItemInstanceMutations([
      {
        opId: `refine-equipment:${itemInstanceId}:${Date.now()}`,
        characterId,
        itemId: itemInstanceId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...latestItem,
          refine_level: resultLevel,
        },
      },
    ]);
  }

  const applyDiffRes = await applyEquipmentDiffIfEquipped(
    characterId,
    itemInstanceId,
    item.location,
    beforeDiffRes.before,
  );
  if (!applyDiffRes.success) {
    return { success: false, message: applyDiffRes.message };
  }
  await refreshCharacterBattleStateAfterEquipmentChange(characterId);
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
};

// ============================================
// 强化/精炼消耗预览（纯查询，不需要事务）
// ============================================

export const getEquipmentGrowthCostPreview = async (
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    enhance: {
      currentLevel: number;
      targetLevel: number;
      maxLevel: number | null;
      successRate: number;
      failMode: EquipmentGrowthFailMode;
      costs: {
        materialItemDefId: string;
        materialName: string;
        materialQty: number;
        silverCost: number;
        spiritStoneCost: number;
      } | null;
      previewBaseAttrs: Record<string, number>;
    };
    refine: {
      currentLevel: number;
      targetLevel: number;
      maxLevel: number;
      successRate: number;
      failMode: EquipmentGrowthFailMode;
      costs: {
        materialItemDefId: string;
        materialName: string;
        materialQty: number;
        silverCost: number;
        spiritStoneCost: number;
      } | null;
      previewBaseAttrs: Record<string, number>;
    };
  };
}> => {
  const enhanceState = await getEnhanceItemState(characterId, itemInstanceId);
  if (!enhanceState.success || !enhanceState.item) {
    return { success: false, message: enhanceState.message };
  }
  const refineState = await getRefineItemState(characterId, itemInstanceId);
  if (!refineState.success || !refineState.item) {
    return { success: false, message: refineState.message };
  }

  const equipReqRealmRank = getRealmRankOneBasedForEquipment(
    enhanceState.item.equipReqRealm ?? refineState.item.equipReqRealm,
  );
  const { discountRate } = await getSectEquipmentGrowthDiscountContext(characterId);

  const enhanceCurrentLevel = normalizeEnhanceLevel(
    enhanceState.item.strengthenLevel,
  );
  const enhanceTargetLevel = enhanceCurrentLevel + 1;
  const enhanceCostPlan = buildDiscountedEquipmentGrowthCostPlan(
    "enhance",
    enhanceTargetLevel,
    equipReqRealmRank,
    discountRate,
  );

  const refineCurrentLevel = clampInt(
    refineState.item.refineLevel,
    0,
    REFINE_MAX_LEVEL,
  );
  const refineAtMaxLevel = refineCurrentLevel >= REFINE_MAX_LEVEL;
  const refineTargetLevel = refineAtMaxLevel
    ? REFINE_MAX_LEVEL
    : refineCurrentLevel + 1;
  const refineCostPlan = refineAtMaxLevel
    ? null
    : buildDiscountedEquipmentGrowthCostPlan(
        "refine",
        refineTargetLevel,
        equipReqRealmRank,
        discountRate,
      );

  const itemRowResult = await query(
    `
      SELECT ii.item_def_id, ii.quality, ii.quality_rank, ii.socketed_gems
      FROM item_instance ii
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      LIMIT 1
    `,
    [itemInstanceId, characterId],
  );
  if (itemRowResult.rows.length <= 0) {
    return { success: false, message: "物品不存在" };
  }
  const itemRow = itemRowResult.rows[0] as {
    item_def_id: string;
    quality: string | null;
    quality_rank: number | null;
    socketed_gems: unknown;
  };
  const itemDef = getStaticItemDef(itemRow.item_def_id);
  if (!itemDef || itemDef.category !== "equipment") {
    return { success: false, message: "该物品不可强化" };
  }
  const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
  const resolvedQualityRank = Math.max(
    1,
    Math.floor(
      Number(itemRow.quality_rank) || resolveQualityRankFromName(itemRow.quality, defQualityRank),
    ),
  );
  const baseAttrsRaw = itemDef.base_attrs ?? {};

  const enhancePreviewBaseAttrs = buildEquipmentDisplayBaseAttrs({
    baseAttrsRaw,
    defQualityRankRaw: defQualityRank,
    resolvedQualityRankRaw: resolvedQualityRank,
    strengthenLevelRaw: enhanceTargetLevel,
    refineLevelRaw: refineCurrentLevel,
    socketedGemsRaw: itemRow.socketed_gems,
  });
  const refinePreviewBaseAttrs = buildEquipmentDisplayBaseAttrs({
    baseAttrsRaw,
    defQualityRankRaw: defQualityRank,
    resolvedQualityRankRaw: resolvedQualityRank,
    strengthenLevelRaw: enhanceCurrentLevel,
    refineLevelRaw: refineTargetLevel,
    socketedGemsRaw: itemRow.socketed_gems,
  });

  const enhanceMaterialDef = getStaticItemDef(enhanceCostPlan.materialItemDefId);
  const enhanceCostsWithName = {
    ...enhanceCostPlan,
    materialName: enhanceMaterialDef?.name ?? enhanceCostPlan.materialItemDefId,
  };
  const refineCostsWithName = refineCostPlan
    ? {
        ...refineCostPlan,
        materialName: getStaticItemDef(refineCostPlan.materialItemDefId)?.name ?? refineCostPlan.materialItemDefId,
      }
    : null;

  return {
    success: true,
    message: "ok",
    data: {
      enhance: {
        currentLevel: enhanceCurrentLevel,
        targetLevel: enhanceTargetLevel,
        maxLevel: null,
        successRate: getEnhanceSuccessRatePercent(enhanceTargetLevel),
        failMode: getEnhanceFailMode(enhanceTargetLevel),
        costs: enhanceCostsWithName,
        previewBaseAttrs: enhancePreviewBaseAttrs,
      },
      refine: {
        currentLevel: refineCurrentLevel,
        targetLevel: refineTargetLevel,
        maxLevel: REFINE_MAX_LEVEL,
        successRate: refineAtMaxLevel
          ? 0
          : getRefineSuccessRatePercent(refineTargetLevel),
        failMode: refineTargetLevel >= 6 ? "downgrade" : "none",
        costs: refineCostsWithName,
        previewBaseAttrs: refinePreviewBaseAttrs,
      },
    },
  };
};

// ============================================
// 洗炼消耗预览（纯查询，不需要事务）
// ============================================

/**
 * 返回指定装备所有锁定数（0..maxLockCount）对应的消耗表
 * 不走事务/行锁，仅读取静态定义 + 词条数量
 */
export const getRerollCostPreview = async (
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    rerollScrollItemDefId: string;
    maxLockCount: number;
    costTable: Array<{
      lockCount: number;
      rerollScrollQty: number;
      silverCost: number;
      spiritStoneCost: number;
    }>;
  };
}> => {
  const row = await query(
    `SELECT ii.item_def_id, ii.affixes, ii.locked, ii.location, ii.qty
     FROM item_instance ii
     WHERE ii.id = $1 AND ii.owner_character_id = $2
     LIMIT 1`,
    [itemInstanceId, characterId],
  );
  if (row.rows.length === 0) return { success: false, message: '物品不存在' };

  const r = row.rows[0] as {
    item_def_id: string;
    affixes: unknown;
    locked: boolean;
    location: string;
    qty: number;
  };

  const itemDef = getStaticItemDef(r.item_def_id);
  if (!itemDef || itemDef.category !== 'equipment')
    return { success: false, message: '该物品不可洗炼' };
  if (r.locked) return { success: false, message: '物品已锁定' };
  if (String(r.location) === 'auction')
    return { success: false, message: '交易中的装备不可洗炼' };
  if (!['bag', 'warehouse', 'equipped'].includes(String(r.location)))
    return { success: false, message: '该物品当前位置不可洗炼' };

  const affixes = parseGeneratedAffixesForReroll(r.affixes);
  if (affixes.length <= 0)
    return { success: false, message: '该装备没有可洗炼词条' };

  const maxLockCount = Math.max(0, affixes.length - 1);
  const equipReqRealm =
    typeof itemDef.equip_req_realm === 'string' ? itemDef.equip_req_realm : null;

  const costTable: Array<{
    lockCount: number;
    rerollScrollQty: number;
    silverCost: number;
    spiritStoneCost: number;
  }> = [];

  for (let n = 0; n <= maxLockCount; n++) {
    const plan = buildAffixRerollCostPlan(equipReqRealm, n);
    costTable.push({
      lockCount: n,
      rerollScrollQty: plan.rerollScrollQty,
      silverCost: plan.silverCost,
      spiritStoneCost: plan.spiritStoneCost,
    });
  }

  return {
    success: true,
    message: 'ok',
    data: {
      rerollScrollItemDefId: REROLL_SCROLL_ITEM_DEF_ID,
      maxLockCount,
      costTable,
    },
  };
};

// ============================================
// 洗炼词条池预览
// ============================================

export const getAffixPoolPreview = async (
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  data?: {
    poolName: string;
    affixes: Array<{
      key: string;
      name: string;
      group: string;
      is_legendary: boolean;
      apply_type: string;
      tiers: Array<{
        tier: number;
        min: number;
        max: number;
      }>;
      owned: boolean;
    }>;
  };
}> => {
  const row = await query(
    `SELECT ii.item_def_id, ii.affixes, ii.locked, ii.location, ii.qty, ii.quality_rank
     FROM item_instance ii
     WHERE ii.id = $1 AND ii.owner_character_id = $2
     LIMIT 1`,
    [itemInstanceId, characterId],
  );
  if (row.rows.length === 0) return { success: false, message: '物品不存在' };

  const r = row.rows[0] as {
    item_def_id: string;
    affixes: unknown;
    locked: boolean;
    location: string;
    qty: number;
    quality_rank: number | null;
  };

  const itemDef = getStaticItemDef(r.item_def_id);
  if (!itemDef || itemDef.category !== 'equipment')
    return { success: false, message: '该物品不可洗炼' };
  if (r.locked) return { success: false, message: '物品已锁定' };
  if (String(r.location) === 'auction')
    return { success: false, message: '交易中的装备不可洗炼' };
  if (!['bag', 'warehouse', 'equipped'].includes(String(r.location)))
    return { success: false, message: '该物品当前位置不可洗炼' };

  const affixes = parseGeneratedAffixesForReroll(r.affixes);
  if (affixes.length <= 0)
    return { success: false, message: '该装备没有可洗炼词条' };

  const affixPoolId = String(itemDef.affix_pool_id || '').trim();
  if (!affixPoolId) return { success: false, message: '该装备没有可用词条池' };

  const equipSlot = String(itemDef.equip_slot || '').trim();
  const poolDef = resolveAffixPoolBySlot(getAffixPoolDefinitions(), affixPoolId, equipSlot);
  if (!poolDef || poolDef.affixes.length <= 0) return { success: false, message: '词条池不存在' };

  const realmRank = getEquipRealmRankForReroll(itemDef.equip_req_realm);
  const ownedKeys = new Set(affixes.map((a) => a.key));

  // 计算 attrFactor，与实际洗炼时的计算逻辑保持一致
  const resolvedQualityMultiplier = getQualityMultiplierForReroll(r.quality_rank);
  const defQualityMultiplier = getQualityMultiplierForReroll(resolveQualityRankFromName(itemDef.quality, 1));
  const attrFactor =
    Number.isFinite(defQualityMultiplier) && defQualityMultiplier > 0
      ? resolvedQualityMultiplier / defQualityMultiplier
      : 1;

  const previewAffixes = poolDef.affixes.map((affix) => ({
    key: affix.key,
    name: affix.name,
    group: affix.group,
    is_legendary: Boolean(affix.is_legendary),
    apply_type: affix.apply_type,
    tiers: affix.tiers
      .filter((tier) => Number(tier.realm_rank_min ?? 0) <= realmRank)
      .map((tier) => {
        const min = Number(tier.min ?? 0);
        const max = Number(tier.max ?? 0);
        // 应用 attrFactor 缩放，与 rollAffixValue 保持一致
        return {
          tier: Number(tier.tier ?? 1),
          min: Number.isFinite(attrFactor) && attrFactor !== 1 ? min * attrFactor : min,
          max: Number.isFinite(attrFactor) && attrFactor !== 1 ? max * attrFactor : max,
        };
      }),
    owned: ownedKeys.has(affix.key),
  }));

  return {
    success: true,
    message: 'ok',
    data: {
      poolName: poolDef.name,
      affixes: previewAffixes,
    },
  };
};

// ============================================
// 词条洗炼
// ============================================

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
  void userId;
  try {
    await lockCharacterInventoryMutex(characterId);

    const itemState = await getRerollItemState(
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

    const beforeDiffRes = await diffEquipmentAttrIfEquipped(
      characterId,
      itemInstanceId,
      item.location,
    );
    if (!beforeDiffRes.success) {
      return { success: false, message: beforeDiffRes.message };
    }

    const affixPool = loadAffixPoolForReroll(item.affixPoolId, item.equipSlot ?? "");
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
      const rerollScrollRes = await consumeMaterialByDefId(
        characterId,
        costPlan.rerollScrollItemDefId,
        costPlan.rerollScrollQty,
      );
      if (!rerollScrollRes.success) {
        return { success: false, message: rerollScrollRes.message };
      }
    }

    const currencyRes = await consumeCharacterCurrencies(
      characterId,
      {
        silver: costPlan.silverCost,
        spiritStones: costPlan.spiritStoneCost,
      },
    );
    if (!currencyRes.success) {
      return { success: false, message: currencyRes.message };
    }

    const latestItem = await loadProjectedCharacterItemInstanceById(characterId, itemInstanceId);
    if (!latestItem) {
      return { success: false, message: "装备不存在" };
    }
    await bufferCharacterItemInstanceMutations([
      {
        opId: `reroll-equipment:${itemInstanceId}:${Date.now()}`,
        characterId,
        itemId: itemInstanceId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...latestItem,
          affixes: JSON.parse(JSON.stringify(rerolledAffixes)) as JsonValue,
        },
      },
    ]);

    const applyDiffRes = await applyEquipmentDiffIfEquipped(
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before,
    );
    if (!applyDiffRes.success) {
      return { success: false, message: applyDiffRes.message };
    }
    await refreshCharacterBattleStateAfterEquipmentChange(characterId);
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
  } catch (error) {
    console.error("洗炼装备词条失败:", error);
    return { success: false, message: "洗炼装备词条失败" };
  }
};
