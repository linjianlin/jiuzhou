/**
 * 属性差分计算模块
 *
 * 作用：计算装备穿戴/卸下/强化/精炼/镶嵌/洗炼等操作前后的角色属性变化量。
 *       纯计算 + 查询，不修改角色表（角色属性已改为运行时计算）。
 *
 * 输入/输出：
 * - addToDelta(delta, key, value) — 向差分 map 添加属性
 * - mergeDelta(a, b) — 将 b 合并入 a
 * - invertDelta(delta) — 反向差分
 * - getEquipmentAttrDeltaByInstanceId(characterId, instanceId) — 计算单件装备属性差分
 * - diffEquipmentAttrIfEquipped(characterId, itemInstanceId, location) — 若装备中计算差分
 * - applyEquipmentDiffIfEquipped(characterId, itemInstanceId, location, before) — 若装备中应用差分
 * - getEquippedSetBonusDelta(characterId) — 计算套装加成差分
 * - applyCharacterAttrDelta(characterId, delta) — 应用角色属性差分（当前为空操作）
 *
 * 数据流：
 * - 从 item_instance 表查询装备实例 → 加载静态定义 → 计算基础属性/词条/宝石属性差分
 * - getEquippedSetBonusDelta 先查已装备物品，再匹配套装定义计算激活加成
 *
 * 被引用方：equipment.ts（强化/精炼/穿戴/卸下/洗炼）、socket.ts（镶嵌）
 *
 * 边界条件：
 * 1. applyCharacterAttrDelta 当前为空操作（属性改为运行时计算后不再写 characters 表），
 *    保留函数签名以兼容调用链，未来如需恢复直接实现即可
 * 2. 查询不到装备实例或非 equipment 类别时返回 null，调用方需检查
 */
import { query } from "../../../config/database.js";
import {
  buildEquipmentDisplayBaseAttrs,
} from "../../equipmentGrowthRules.js";
import {
  getItemSetDefinitions,
} from "../../staticConfigLoader.js";
import { extractFlatAffixDeltas } from "../../shared/affixModifier.js";
import { resolveQualityRankFromName } from "../../shared/itemQuality.js";
import type { CharacterAttrKey, InventoryLocation } from "./types.js";
import { allowedCharacterAttrKeys } from "./types.js";
import { safeNumber, getStaticItemDef } from "./helpers.js";
import { getEquippedSetPieceCountMap } from "./equippedSetCount.js";

/**
 * 向差分 map 添加属性值（仅白名单内的 key 生效）
 */
export const addToDelta = (
  delta: Map<CharacterAttrKey, number>,
  key: string,
  value: unknown,
): void => {
  if (!allowedCharacterAttrKeys.has(key as CharacterAttrKey)) return;
  const v = safeNumber(value);
  if (v === 0) return;
  const k = key as CharacterAttrKey;
  delta.set(k, (delta.get(k) || 0) + v);
};

/**
 * 将差分 b 合并入差分 a（就地修改 a）
 */
export const mergeDelta = (
  a: Map<CharacterAttrKey, number>,
  b: Map<CharacterAttrKey, number>,
): void => {
  for (const [k, v] of b.entries()) {
    if (v === 0) continue;
    a.set(k, (a.get(k) || 0) + v);
  }
};

/**
 * 返回差分的反向版本（所有值取负）
 */
export const invertDelta = (delta: Map<CharacterAttrKey, number>): Map<CharacterAttrKey, number> => {
  const out = new Map<CharacterAttrKey, number>();
  for (const [k, v] of delta.entries()) {
    if (v === 0) continue;
    out.set(k, -v);
  }
  return out;
};

/**
 * 应用角色属性差分
 * 角色属性改为运行时计算后，不再把装备/词条差分写入 characters 表。
 */
export const applyCharacterAttrDelta = async (
  _characterId: number,
  _delta: Map<CharacterAttrKey, number>,
): Promise<void> => {
  return;
};

/**
 * 计算单件装备的属性差分（基础属性 + 词条属性）
 * 返回 null 表示装备不存在或非 equipment 类别
 */
export const getEquipmentAttrDeltaByInstanceId = async (
  characterId: number,
  instanceId: number,
): Promise<Map<CharacterAttrKey, number> | null> => {
  const result = await query(
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

/**
 * 若装备处于"equipped"状态，计算操作前的属性差分快照
 * 返回 before map 供操作后对比
 */
export const diffEquipmentAttrIfEquipped = async (
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
  const before = await getEquipmentAttrDeltaByInstanceId(
    characterId,
    itemInstanceId,
  );
  if (!before) return { success: false, message: "装备数据异常" };
  return { success: true, message: "ok", before };
};

/**
 * 若装备处于"equipped"状态，计算操作前后差分并应用到角色属性
 */
export const applyEquipmentDiffIfEquipped = async (
  characterId: number,
  itemInstanceId: number,
  location: unknown,
  before?: Map<CharacterAttrKey, number>,
): Promise<{ success: boolean; message: string }> => {
  if (String(location) !== "equipped")
    return { success: true, message: "无需差分" };
  if (!before) return { success: false, message: "装备数据异常" };
  const after = await getEquipmentAttrDeltaByInstanceId(
    characterId,
    itemInstanceId,
  );
  if (!after) return { success: false, message: "装备数据异常" };
  const diff = new Map<CharacterAttrKey, number>();
  mergeDelta(diff, after);
  mergeDelta(diff, invertDelta(before));
  await applyCharacterAttrDelta(characterId, diff);
  return { success: true, message: "ok" };
};

/**
 * 计算角色已装备套装加成的属性差分
 * 遍历已装备物品 → 按套装 ID 统计件数 → 查找满足条件的加成 → 累加差分
 */
export const getEquippedSetBonusDelta = async (
  characterId: number,
): Promise<Map<CharacterAttrKey, number>> => {
  const counts = await getEquippedSetPieceCountMap(characterId);

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
