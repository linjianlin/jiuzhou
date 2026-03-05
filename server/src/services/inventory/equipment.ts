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
 * 2. 强化/精炼失败时等级可能回退（由 getEnhanceFailResultLevel/getRefineFailResultLevel 决定）
 */
import { query } from "../../config/database.js";
import { randomInt } from "crypto";
import {
  ENHANCE_MAX_LEVEL,
  REFINE_MAX_LEVEL,
  buildEnhanceCostPlan,
  buildRefineCostPlan,
  getEnhanceFailResultLevel,
  getEnhanceSuccessRatePercent,
  getRefineFailResultLevel,
  getRefineSuccessRatePercent,
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
import type { GeneratedAffix } from "../equipmentService.js";
import {
  getCharacterComputedByCharacterId,
  invalidateCharacterComputedCache,
} from "../characterComputedService.js";
import {
  getRealmRankOneBasedForEquipment,
  getRealmRankOneBasedStrict,
} from "../shared/realmRules.js";
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
import type { InventoryLocation, SlottedInventoryLocation } from "./shared/types.js";
import { consumeMaterialByDefId, consumeCharacterCurrencies } from "./shared/consume.js";
import { getEnhanceItemState, getRefineItemState, getRerollItemState } from "./shared/validation.js";
import { clampInt, getStaticItemDef } from "./shared/helpers.js";
import { findEmptySlots } from "./bag.js";

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

  const itemResult = await query(
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

  const currentlyEquippedResult = await query(
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

      await query(
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

      await applyCharacterAttrDelta(
        characterId,
        invertDelta(oldDelta),
      );
    }
  }

  await query(
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

  await applyCharacterAttrDelta(characterId, newItemDelta);

  const afterSetBonus = await getEquippedSetBonusDelta(characterId);
  const setBonusDelta = new Map<CharacterAttrKey, number>();
  mergeDelta(setBonusDelta, afterSetBonus);
  mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
  await applyCharacterAttrDelta(characterId, setBonusDelta);
  await invalidateCharacterComputedCache(characterId);
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

  const itemResult = await query(
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

  await query(
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

  await applyCharacterAttrDelta(characterId, invertDelta(delta));

  const afterSetBonus = await getEquippedSetBonusDelta(characterId);
  const setBonusDelta = new Map<CharacterAttrKey, number>();
  mergeDelta(setBonusDelta, afterSetBonus);
  mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
  await applyCharacterAttrDelta(characterId, setBonusDelta);
  await invalidateCharacterComputedCache(characterId);
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
    strengthenLevel: number;
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

  const itemState = await getEnhanceItemState(
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
  const costPlan = buildEnhanceCostPlan(
    targetLv,
    getRealmRankOneBasedForEquipment(item.equipReqRealm),
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

  const resultLevel = success
    ? targetLv
    : getEnhanceFailResultLevel(curLv, targetLv);

  if (resultLevel !== curLv) {
    await query(
      "UPDATE item_instance SET strengthen_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
      [resultLevel, itemInstanceId, characterId],
    );
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
  const costPlan = buildRefineCostPlan(
    targetLv,
    getRealmRankOneBasedForEquipment(item.equipReqRealm),
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
    await query(
      "UPDATE item_instance SET refine_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
      [resultLevel, itemInstanceId, characterId],
    );
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
      maxLevel: number;
      successRate: number;
      downgradeOnFail: boolean;
      costs: {
        materialItemDefId: string;
        materialQty: number;
        silverCost: number;
        spiritStoneCost: number;
      } | null;
    };
    refine: {
      currentLevel: number;
      targetLevel: number;
      maxLevel: number;
      successRate: number;
      downgradeOnFail: boolean;
      costs: {
        materialItemDefId: string;
        materialQty: number;
        silverCost: number;
        spiritStoneCost: number;
      } | null;
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

  const enhanceCurrentLevel = clampInt(
    enhanceState.item.strengthenLevel,
    0,
    ENHANCE_MAX_LEVEL,
  );
  const enhanceAtMaxLevel = enhanceCurrentLevel >= ENHANCE_MAX_LEVEL;
  const enhanceTargetLevel = enhanceAtMaxLevel
    ? ENHANCE_MAX_LEVEL
    : enhanceCurrentLevel + 1;
  const enhanceCostPlan = enhanceAtMaxLevel
    ? null
    : buildEnhanceCostPlan(enhanceTargetLevel, equipReqRealmRank);

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
    : buildRefineCostPlan(refineTargetLevel, equipReqRealmRank);

  return {
    success: true,
    message: "ok",
    data: {
      enhance: {
        currentLevel: enhanceCurrentLevel,
        targetLevel: enhanceTargetLevel,
        maxLevel: ENHANCE_MAX_LEVEL,
        successRate: enhanceAtMaxLevel
          ? 0
          : getEnhanceSuccessRatePercent(enhanceTargetLevel),
        downgradeOnFail: enhanceTargetLevel >= 8,
        costs: enhanceCostPlan,
      },
      refine: {
        currentLevel: refineCurrentLevel,
        targetLevel: refineTargetLevel,
        maxLevel: REFINE_MAX_LEVEL,
        successRate: refineAtMaxLevel
          ? 0
          : getRefineSuccessRatePercent(refineTargetLevel),
        downgradeOnFail: refineTargetLevel >= 6,
        costs: refineCostPlan,
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

    const affixPool = loadAffixPoolForReroll(item.affixPoolId);
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

    await query(
      `
        UPDATE item_instance
        SET affixes = $1::jsonb,
            affix_gen_version = 5,
            updated_at = NOW()
        WHERE id = $2 AND owner_character_id = $3
      `,
      [JSON.stringify(rerolledAffixes), itemInstanceId, characterId],
    );

    const applyDiffRes = await applyEquipmentDiffIfEquipped(
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
  } catch (error) {
    console.error("洗炼装备词条失败:", error);
    return { success: false, message: "洗炼装备词条失败" };
  }
};
