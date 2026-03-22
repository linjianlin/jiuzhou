/**
 * 装备镶嵌模块
 *
 * 作用：处理装备宝石镶嵌/替换操作。
 *       包含宝石孔位解析、宝石加载校验、镶嵌主流程等功能。
 *       不做事务管理（由 service.ts 的 @Transactional 装饰器统一处理）。
 *
 * 输入/输出：
 * - socketEquipment(characterId, userId, itemInstanceId, gemItemInstanceId, options) — 镶嵌主流程
 * - readEquipmentSocketState(characterId, itemInstanceId) — 读取装备镶嵌状态
 * - loadGemItemForSocket(characterId, gemItemInstanceId) — 加载并校验宝石物品
 * - 纯函数辅助：normalizeGemSlotTypes / normalizeSocketedGemEntries / toSocketedGemsJson / ...
 *
 * 数据流：
 * 1. 从 Redis 主状态读取装备/宝石 → 2. 计算属性差分快照 → 3. 校验宝石 →
 * 4. 检查孔位匹配 → 5. 扣除宝石/货币 → 6. 写回 socketed_gems → 7. 应用属性差分
 *
 * 被引用方：service.ts（InventoryService.socketEquipment）
 *
 * 边界条件：
 * 1. 同一件装备不可镶嵌相同宝石（按 itemDefId 判断）
 * 2. 替换已有宝石时银两消耗为 100，新镶嵌为 50
 */
import {
  isGemTypeAllowedInSlot,
  parseSocketEffectsFromItemEffectDefs,
  parseSocketedGems,
  resolveSocketMax,
  type SocketEffect,
  type SocketedGemEntry,
} from "../equipmentGrowthRules.js";
import {
  getCharacterComputedByCharacterId,
  invalidateCharacterComputedCache,
} from "../characterComputedService.js";
import {
  isGemItemDefinition,
  resolveGemTypeFromItemDefinition,
} from "../shared/gemItemSemantics.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { lockCharacterInventoryMutex } from "../inventoryMutex.js";
import { consumeSpecificItemInstance } from "./shared/consume.js";
import { consumeCharacterCurrencies } from "./shared/consume.js";
import {
  diffEquipmentAttrIfEquipped,
  applyEquipmentDiffIfEquipped,
} from "./shared/attrDelta.js";
import { clampInt, getStaticItemDef, getEnabledStaticItemDef } from "./shared/helpers.js";
import { queueInventoryItemWritebackSnapshot } from "../playerWritebackCacheService.js";
import { loadPlayerInventoryStateByItemId } from "../playerStateRepository.js";
import type {
  PlayerInventoryItemState,
  PlayerStateJsonValue,
} from "../playerStateTypes.js";

// ============================================
// 宝石孔位纯函数工具
// ============================================

export const normalizeGemSlotTypes = (raw: unknown): unknown => {
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

export const normalizeSocketedGemEntries = (raw: unknown): SocketedGemEntry[] => {
  return parseSocketedGems(raw);
};

export const toSocketedGemsJson = (entries: SocketedGemEntry[]): string => {
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

export const findSocketEntryBySlot = (
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

export const getNextAvailableSocketSlot = (
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

export const upsertSocketEntry = (
  entries: SocketedGemEntry[],
  nextEntry: SocketedGemEntry,
): SocketedGemEntry[] => {
  const slot = clampInt(Number(nextEntry.slot) || 0, 0, 999);
  const filtered = entries.filter(
    (entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== slot,
  );
  return [...filtered, nextEntry].sort((a, b) => a.slot - b.slot);
};

export const removeSocketEntryBySlot = (
  entries: SocketedGemEntry[],
  slot: number,
): SocketedGemEntry[] => {
  const target = clampInt(slot, 0, 999);
  return entries.filter(
    (entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== target,
  );
};

// ============================================
// 读取装备镶嵌状态
// ============================================

/**
 * 查询装备实例的镶嵌状态
 * 直接从 Redis 主状态读取装备实例，再根据静态配置计算孔位与宝石类型限制
 */
export const readEquipmentSocketState = async (
  characterId: number,
  itemInstanceId: number,
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    owner_user_id: number;
    owner_character_id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    quality: string | null;
    quality_rank: number | null;
    strengthen_level: number | null;
    refine_level: number | null;
    socketed_gems: PlayerStateJsonValue;
    affixes: PlayerStateJsonValue;
    affix_gen_version: number | null;
    affix_roll_meta: PlayerStateJsonValue;
    identified: boolean | null;
    bind_type: string | null;
    bind_owner_user_id: number | null;
    bind_owner_character_id: number | null;
    location: string;
    location_slot: number | null;
    equipped_slot: string | null;
    random_seed: number | null;
    custom_name: string | null;
    expire_at: string | null;
    obtained_from: string | null;
    obtained_ref_id: string | null;
    metadata: PlayerStateJsonValue;
    created_at: string | null;
    socketMax: number;
    gemSlotTypes: unknown;
    socketedEntries: SocketedGemEntry[];
  };
}> => {
  const itemState = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
  if (!itemState)
    return { success: false, message: "物品不存在" };
  const itemDef = getStaticItemDef(itemState.item_def_id);
  if (!itemDef || itemDef.category !== "equipment")
    return { success: false, message: "该物品不可镶嵌" };
  if (itemState.locked) return { success: false, message: "物品已锁定" };
  if ((Number(itemState.qty) || 0) !== 1)
    return { success: false, message: "装备数量异常" };
  if (String(itemState.location) === "auction")
    return { success: false, message: "交易中的装备不可镶嵌" };
  if (!["bag", "warehouse", "equipped"].includes(String(itemState.location))) {
    return { success: false, message: "该物品当前位置不可镶嵌" };
  }

  const resolvedQualityRank =
    Number(itemState.quality_rank) || resolveQualityRankFromName(itemDef.quality, 1);
  const socketMax = resolveSocketMax(itemDef.socket_max, resolvedQualityRank);
  if (socketMax <= 0) return { success: false, message: "该装备无可用镶嵌孔" };

  return {
    success: true,
    message: "ok",
    item: {
      ...itemState,
      socketMax,
      gemSlotTypes: normalizeGemSlotTypes(itemDef.gem_slot_types),
      socketedEntries: normalizeSocketedGemEntries(itemState.socketed_gems),
    },
  };
};

// ============================================
// 加载宝石物品
// ============================================

/**
 * 加载并校验用于镶嵌的宝石物品
 * 直接从 Redis 主状态读取宝石实例，再校验静态配置中的宝石定义
 */
export const loadGemItemForSocket = async (
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
  const itemState = await loadPlayerInventoryStateByItemId(characterId, gemItemInstanceId);
  if (!itemState)
    return { success: false, message: "宝石不存在" };

  if (itemState.locked) return { success: false, message: "宝石已锁定" };
  if (!["bag", "warehouse"].includes(String(itemState.location))) {
    return { success: false, message: "宝石当前位置不可消耗" };
  }
  if ((Number(itemState.qty) || 0) < 1)
    return { success: false, message: "宝石数量不足" };

  const gemDefId = String(itemState.item_def_id || "");
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
      itemInstanceId: Number(itemState.id),
      itemDefId: String(row.id),
      name: String(row.name || row.id),
      icon: row.icon ? String(row.icon) : null,
      gemType: resolveGemTypeFromItemDefinition(row),
      effects,
    },
  };
};

// ============================================
// 镶嵌主流程
// ============================================

/**
 * 装备镶嵌宝石
 *
 * 流程：校验装备 → 属性快照 → 校验宝石 → 孔位匹配 →
 *       扣除货币/宝石 → 更新 socketed_gems → 应用属性差分
 */
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
  void userId;
  await lockCharacterInventoryMutex(characterId);

  const socketState = await readEquipmentSocketState(
    characterId,
    itemInstanceId,
  );
  if (!socketState.success || !socketState.item) {
    return { success: false, message: socketState.message };
  }
  const equip = socketState.item;

  const beforeDiffRes = await diffEquipmentAttrIfEquipped(
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

  const gemRes = await loadGemItemForSocket(
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
  const currencyRes = await consumeCharacterCurrencies(
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
    const consumeGemRes = await consumeSpecificItemInstance(
      characterId,
      Number(gem.itemInstanceId),
      1,
    );
    if (!consumeGemRes.success) {
      return { success: false, message: consumeGemRes.message };
    }
  }

  await queueInventoryItemWritebackSnapshot(
    characterId,
    equip as PlayerInventoryItemState,
    {
      socketed_gems: nextEntries,
    },
  );

  const applyDiffRes = await applyEquipmentDiffIfEquipped(
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
};
