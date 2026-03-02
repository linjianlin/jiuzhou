/**
 * 物品聚合查询模块
 *
 * 作用：提供带物品定义、套装聚合、装备属性计算、词条元数据注入的物品列表查询。
 *       纯只读查询，不修改数据库。
 *
 * 输入/输出：
 * - getInventoryItemsWithDefs(characterId, location, page, pageSize) — 聚合查询
 * - getEquippedItemDefIds(characterId) — 已装备物品定义 ID 列表
 *
 * 数据流：
 * 1. getInventoryItems → 物品实例列表
 * 2. getItemDefinitionsByIds → 批量加载物品静态定义
 * 3. getItemSetDefinitions → 套装定义（仅当有套装 ID 时）
 * 4. getEquippedItemDefIds → 已装备物品（仅当有套装 ID 时）
 * 5. buildEquipmentDisplayBaseAttrs → 装备基础属性折算
 * 6. enrichAffixesWithRollMeta → 词条 roll 百分比注入
 *
 * 被引用方：service.ts（InventoryService 对应方法）
 *
 * 边界条件：
 * 1. 空物品列表直接返回，不执行后续查询
 * 2. 缺少物品定义的物品，def 设为 undefined
 */
import { query } from "../../config/database.js";
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getItemSetDefinitions,
} from "../staticConfigLoader.js";
import {
  buildEquipmentDisplayBaseAttrs,
} from "../equipmentGrowthRules.js";
import {
  enrichAffixesWithRollMeta,
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForReroll,
  parseGeneratedAffixesForReroll,
} from "../equipmentAffixRerollService.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import type {
  InventoryItemWithDef,
  InventoryLocation,
} from "./shared/types.js";
import { getInventoryItems } from "./bag.js";

/**
 * 查询角色已装备物品的 item_def_id 列表
 *
 * 作用：用于套装激活件数统计（判断当前查看的物品所在套装已装备多少件）。
 * 输入：characterId — 角色 ID
 * 输出：已装备物品的 item_def_id 字符串数组
 *
 * 边界条件：
 * - 若角色无装备，返回空数组
 * - item_def_id 为空/null 的行会被过滤
 */
export const getEquippedItemDefIds = async (
  characterId: number,
): Promise<string[]> => {
  const result = await query(
    `SELECT item_def_id FROM item_instance ii
     WHERE ii.owner_character_id = $1 AND ii.location = 'equipped'`,
    [characterId],
  );
  return (result.rows as Array<{ item_def_id?: unknown }>)
    .map((row) => String(row.item_def_id || "").trim())
    .filter((id) => id.length > 0);
};

/**
 * 带物品定义、套装聚合、装备属性计算、词条元数据注入的物品列表查询
 */
export const getInventoryItemsWithDefs = async (
  characterId: number,
  location: InventoryLocation,
  page: number,
  pageSize: number,
): Promise<{ items: InventoryItemWithDef[]; total: number }> => {
  const result = await getInventoryItems(characterId, location, page, pageSize);

  if (result.items.length === 0) {
    return { items: [], total: 0 };
  }

  // 1. 批量加载物品定义
  const itemDefIds = [
    ...new Set(
      result.items
        .map((item) => String(item.item_def_id || "").trim())
        .filter((id) => id.length > 0),
    ),
  ];
  const staticDefMap = getItemDefinitionsByIds(itemDefIds);

  // 2. 收集套装 ID
  const setIds = [
    ...new Set(
      Array.from(staticDefMap.values())
        .map((d: Record<string, unknown>) =>
          typeof d.set_id === "string" ? d.set_id.trim() : "",
        )
        .filter((x) => x.length > 0),
    ),
  ];

  const setBonusMap = new Map<
    string,
    Array<{ piece_count: number; effect_defs: unknown }>
  >();
  const equippedSetCountMap = new Map<string, number>();
  const setNameMap = new Map<string, string>();

  // 3. 加载套装定义 + 已装备件数统计
  if (setIds.length > 0) {
    const setIdSet = new Set(setIds);
    const staticSetMap = new Map(
      getItemSetDefinitions()
        .filter((entry: Record<string, unknown>) => entry.enabled !== false)
        .map(
          (entry: Record<string, unknown>) =>
            [entry.id, entry] as const,
        ),
    );
    for (const setId of setIds) {
      const setDef = staticSetMap.get(setId) as
        | Record<string, unknown>
        | undefined;
      if (!setDef) continue;
      setNameMap.set(setId, String(setDef.name || setId));
      const normalizedBonuses = (
        Array.isArray(setDef.bonuses) ? setDef.bonuses : []
      )
        .map(
          (bonus: {
            piece_count?: unknown;
            priority?: unknown;
            effect_defs?: unknown;
          }) => ({
            piece_count: Math.max(
              1,
              Math.floor(Number(bonus.piece_count) || 1),
            ),
            priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
            effect_defs: Array.isArray(bonus.effect_defs)
              ? bonus.effect_defs
              : [],
          }),
        )
        .sort(
          (
            left: { priority: number; piece_count: number },
            right: { priority: number; piece_count: number },
          ) => left.priority - right.priority || left.piece_count - right.piece_count,
        )
        .map((bonus: { piece_count: number; effect_defs: unknown }) => ({
          piece_count: bonus.piece_count,
          effect_defs: bonus.effect_defs,
        }));
      setBonusMap.set(setId, normalizedBonuses);
    }

    const equippedDefIds = await getEquippedItemDefIds(characterId);
    for (const equippedItemDefId of equippedDefIds) {
      const equippedDef = getItemDefinitionById(equippedItemDefId);
      const setId = String(
        (equippedDef as Record<string, unknown> | null)?.set_id || "",
      ).trim();
      if (!setId || !setIdSet.has(setId)) continue;
      equippedSetCountMap.set(
        setId,
        (equippedSetCountMap.get(setId) || 0) + 1,
      );
    }
  }

  // 4. 逐物品聚合定义、套装、属性、词条
  const affixPoolCache = new Map<
    string,
    ReturnType<typeof loadAffixPoolForReroll>
  >();

  const items: InventoryItemWithDef[] = result.items.map((item) => {
    const def = staticDefMap.get(item.item_def_id) as
      | Record<string, unknown>
      | undefined;
    if (!def) return { ...item, def: undefined };

    const setId =
      typeof def.set_id === "string" ? (def.set_id as string).trim() : "";
    const setBonuses = setId ? (setBonusMap.get(setId) || []) : [];
    const setEquippedCount = setId
      ? (equippedSetCountMap.get(setId) || 0)
      : 0;
    const baseDef = {
      ...def,
      set_id: setId || null,
      set_name: setId ? (setNameMap.get(setId) ?? null) : null,
      set_bonuses: setBonuses,
      set_equipped_count: setEquippedCount,
    };

    if (def.category !== "equipment") return { ...item, def: baseDef };

    const defQualityRank = resolveQualityRankFromName(
      def.quality as string | undefined,
      1,
    );
    const resolvedQualityRank = Math.max(
      1,
      Math.floor(Number(item.quality_rank) || defQualityRank),
    );

    const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: def.base_attrs,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: item.strengthen_level,
      refineLevelRaw: item.refine_level,
      socketedGemsRaw: item.socketed_gems,
    });

    let normalizedAffixes = parseGeneratedAffixesForReroll(item.affixes);
    const affixPoolId =
      typeof def.affix_pool_id === "string"
        ? (def.affix_pool_id as string).trim()
        : "";
    if (normalizedAffixes.length > 0 && affixPoolId) {
      if (!affixPoolCache.has(affixPoolId)) {
        affixPoolCache.set(affixPoolId, loadAffixPoolForReroll(affixPoolId));
      }
      const affixPool = affixPoolCache.get(affixPoolId);
      if (affixPool) {
        const realmRank = getEquipRealmRankForReroll(
          def.equip_req_realm as string | undefined,
        );
        const resolvedQualityMultiplier =
          getQualityMultiplierForReroll(resolvedQualityRank);
        const defQualityMultiplier =
          getQualityMultiplierForReroll(defQualityRank);
        const attrFactor =
          Number.isFinite(defQualityMultiplier) && defQualityMultiplier > 0
            ? resolvedQualityMultiplier / defQualityMultiplier
            : 1;
        normalizedAffixes = enrichAffixesWithRollMeta({
          affixes: normalizedAffixes,
          affixDefs: affixPool.affixes,
          realmRank,
          attrFactor,
        });
      }
    }

    const mergedDef = {
      ...baseDef,
      base_attrs_raw: def.base_attrs,
      base_attrs: displayBaseAttrs,
    };

    return {
      ...item,
      affixes:
        normalizedAffixes.length > 0 ? normalizedAffixes : item.affixes,
      def: mergedDef,
    };
  });

  return { items, total: result.total };
};
