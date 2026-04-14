/**
 * 物品聚合查询模块
 *
 * 作用：提供带物品定义、套装聚合、装备属性计算、词条元数据注入的物品列表查询。
 *       纯只读查询，不修改数据库。
 *
 * 输入/输出：
 * - getInventoryItemsWithDefs(characterId, location, page, pageSize) — 单 location 聚合查询
 * - getBagInventorySnapshot(characterId) — 背包弹窗所需快照（容量 + 背包物品 + 已穿戴物品）
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
import { resolveItemCanDisassemble } from "../shared/itemDisassembleRule.js";
import { resolveGeneratedTechniqueBookDisplay } from "../shared/generatedTechniqueBookView.js";
import { buildAffixPoolSlotCacheKey } from "../shared/affixPoolSlotResolver.js";
import type {
  InventoryInfo,
  InventoryItem,
  InventoryItemWithDef,
  InventoryLocation,
} from "./shared/types.js";
import { getInventoryInfo, getInventoryItems } from "./bag.js";
import { getEquippedSetPieceCountMap } from "./shared/equippedSetCount.js";
import { loadProjectedCharacterItemInstancesByLocation } from "../shared/characterItemInstanceMutationService.js";

type InventoryItemDefContext = {
  staticDefMap: Map<string, Record<string, unknown>>;
  setBonusMap: Map<string, Array<{ piece_count: number; effect_defs: unknown }>>;
  equippedSetCountMap: Map<string, number>;
  setNameMap: Map<string, string>;
};

type BuildInventoryItemDefContextOptions = {
  equippedItems?: readonly InventoryItem[];
};

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
  return (await loadProjectedCharacterItemInstancesByLocation(characterId, "equipped"))
    .map((row) => String(row.item_def_id || "").trim())
    .filter((id) => id.length > 0);
};

/**
 * 构建物品定义聚合上下文
 *
 * 作用：
 * - 统一预加载物品定义、套装定义、已穿戴套装件数，避免不同查询入口重复拼装同一份上下文。
 * - 为 `getInventoryItemsWithDefs` 与 `getBagInventorySnapshot` 共享同一套富化依赖，减少重复逻辑。
 *
 * 输入/输出：
 * - 输入：角色 ID、待富化的原始物品列表。
 * - 输出：物品定义、套装效果、套装已穿戴件数等只读上下文。
 *
 * 数据流/状态流：
 * 原始物品列表 -> 收集 item_def_id / set_id -> 预加载静态定义与已穿戴套装件数 -> 返回上下文。
 *
 * 关键边界条件与坑点：
 * 1. 传入空列表时必须直接返回空上下文，避免做无意义的静态定义与数据库查询。
 * 2. 套装已穿戴件数统计依赖角色当前全部已穿戴装备，不能只看传入列表，否则套装件数会失真。
 */
const buildInventoryItemDefContext = async (
  characterId: number,
  sourceItems: InventoryItem[],
  options: BuildInventoryItemDefContextOptions = {},
): Promise<InventoryItemDefContext> => {
  if (sourceItems.length <= 0) {
    return {
      staticDefMap: new Map<string, Record<string, unknown>>(),
      setBonusMap: new Map<string, Array<{ piece_count: number; effect_defs: unknown }>>(),
      equippedSetCountMap: new Map<string, number>(),
      setNameMap: new Map<string, string>(),
    };
  }

  const itemDefIds = [
    ...new Set(
      sourceItems
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

    const rawEquippedSetCountMap = await getEquippedSetPieceCountMap(characterId, options.equippedItems);
    for (const [setId, pieceCount] of rawEquippedSetCountMap.entries()) {
      if (!setIdSet.has(setId)) continue;
      equippedSetCountMap.set(setId, pieceCount);
    }
  }

  return {
    staticDefMap,
    setBonusMap,
    equippedSetCountMap,
    setNameMap,
  };
};

/**
 * 为物品实例列表注入定义、套装、装备成长显示属性与词条元数据
 *
 * 作用：
 * - 让单 location 查询与背包快照查询共用同一份富化流程，避免在多个入口重复写映射逻辑。
 * - 将高频变化的“物品展示规则”集中在一处，后续新增展示字段时只改这里。
 *
 * 输入/输出：
 * - 输入：原始物品列表、预构建的定义聚合上下文。
 * - 输出：可直接返回给前端的 `InventoryItemWithDef[]`。
 *
 * 数据流/状态流：
 * 原始实例列表 + 预加载上下文 -> 逐项富化定义/套装/属性/词条 -> 返回展示态物品列表。
 *
 * 关键边界条件与坑点：
 * 1. 缺少静态定义时仍需保留原物品实例，避免因为静态表遗漏把物品直接吞掉。
 * 2. 词条 roll 元数据依赖词条池缓存，必须在单次富化流程内共享缓存，避免同池装备重复加载。
 */
const enrichInventoryItemsWithDefs = (
  sourceItems: InventoryItem[],
  context: InventoryItemDefContext,
): InventoryItemWithDef[] => {
  const affixPoolCache = new Map<
    string,
    ReturnType<typeof loadAffixPoolForReroll>
  >();

  return sourceItems.map((item) => {
    const def = context.staticDefMap.get(item.item_def_id) as
      | Record<string, unknown>
      | undefined;
    if (!def) return { ...item, def: undefined };

    const generatedTechniqueBookDisplay = resolveGeneratedTechniqueBookDisplay(
      item.item_def_id,
      item.metadata,
    );
    const normalizedDef = generatedTechniqueBookDisplay
      ? {
          ...def,
          name: generatedTechniqueBookDisplay.name,
          quality: generatedTechniqueBookDisplay.quality ?? def.quality,
          description: generatedTechniqueBookDisplay.description,
          long_desc: generatedTechniqueBookDisplay.longDesc,
          tags: generatedTechniqueBookDisplay.tags,
          generated_technique_id: generatedTechniqueBookDisplay.generatedTechniqueId,
          generated_technique_name: generatedTechniqueBookDisplay.generatedTechniqueName,
        }
      : def;

    const setId =
      typeof normalizedDef.set_id === "string"
        ? (normalizedDef.set_id as string).trim()
        : "";
    const setBonuses = setId ? (context.setBonusMap.get(setId) || []) : [];
    const setEquippedCount = setId
      ? (context.equippedSetCountMap.get(setId) || 0)
      : 0;
    const baseDef = {
      ...normalizedDef,
      can_disassemble: resolveItemCanDisassemble(normalizedDef),
      set_id: setId || null,
      set_name: setId ? (context.setNameMap.get(setId) ?? null) : null,
      set_bonuses: setBonuses,
      set_equipped_count: setEquippedCount,
    };

    if (normalizedDef.category !== "equipment") return { ...item, def: baseDef };

    const defQualityRank = resolveQualityRankFromName(
      normalizedDef.quality as string | undefined,
      1,
    );
    const resolvedQualityRank = Math.max(
      1,
      Math.floor(Number(item.quality_rank) || defQualityRank),
    );

    const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: normalizedDef.base_attrs,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: item.strengthen_level,
      refineLevelRaw: item.refine_level,
      socketedGemsRaw: item.socketed_gems,
    });

    let normalizedAffixes = parseGeneratedAffixesForReroll(item.affixes);
    const affixPoolId =
      typeof normalizedDef.affix_pool_id === "string"
        ? (normalizedDef.affix_pool_id as string).trim()
        : "";
    const equipSlot =
      typeof normalizedDef.equip_slot === "string"
        ? (normalizedDef.equip_slot as string).trim()
        : "";
    if (normalizedAffixes.length > 0 && affixPoolId && equipSlot) {
      const affixPoolCacheKey = buildAffixPoolSlotCacheKey(affixPoolId, equipSlot);
      if (!affixPoolCache.has(affixPoolCacheKey)) {
        affixPoolCache.set(affixPoolCacheKey, loadAffixPoolForReroll(affixPoolId, equipSlot));
      }
      const affixPool = affixPoolCache.get(affixPoolCacheKey);
      if (affixPool) {
        const realmRank = getEquipRealmRankForReroll(
          normalizedDef.equip_req_realm as string | undefined,
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
      base_attrs_raw: normalizedDef.base_attrs,
      base_attrs: displayBaseAttrs,
    };

    return {
      ...item,
      affixes:
        normalizedAffixes.length > 0 ? normalizedAffixes : item.affixes,
      def: mergedDef,
    };
  });
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

  const context = await buildInventoryItemDefContext(characterId, result.items, {
    equippedItems: location === 'equipped' ? result.items : undefined,
  });
  const items = enrichInventoryItemsWithDefs(result.items, context);

  return { items, total: result.total };
};

/**
 * 背包弹窗快照查询
 *
 * 作用：
 * - 一次性返回背包弹窗首屏所需的容量信息、背包物品与已穿戴物品，收敛前端打开弹窗时的多次请求。
 * - 共享同一套物品定义聚合上下文，避免背包物品与已穿戴物品分别富化造成重复计算。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：`info`、`bagItems`、`equippedItems` 三段只读快照数据。
 *
 * 数据流/状态流：
 * getInventoryInfo + getInventoryItems(bag/equipped) -> 共享上下文富化 -> 返回弹窗快照。
 *
 * 关键边界条件与坑点：
 * 1. 背包和已穿戴需要共用一份上下文，否则套装件数、静态定义加载会被重复计算。
 * 2. 空背包也必须返回容量信息，不能因为物品为空就跳过 `info`。
 */
export const getBagInventorySnapshot = async (
  characterId: number,
): Promise<{
  info: InventoryInfo;
  bagItems: InventoryItemWithDef[];
  equippedItems: InventoryItemWithDef[];
}> => {
  const bagProjectedItemsPromise = loadProjectedCharacterItemInstancesByLocation(characterId, "bag");
  const equippedProjectedItemsPromise = loadProjectedCharacterItemInstancesByLocation(characterId, "equipped");
  const warehouseProjectedItemsPromise = loadProjectedCharacterItemInstancesByLocation(characterId, "warehouse");

  const [bagProjectedItems, equippedProjectedItems, warehouseProjectedItems] = await Promise.all([
    bagProjectedItemsPromise,
    equippedProjectedItemsPromise,
    warehouseProjectedItemsPromise,
  ]);

  const [info, bagResult, equippedResult] = await Promise.all([
    getInventoryInfo(characterId, {
      bagProjectedItems,
      warehouseProjectedItems,
    }),
    getInventoryItems(characterId, "bag", 1, 200, {
      projectedItems: bagProjectedItems,
    }),
    getInventoryItems(characterId, "equipped", 1, 200, {
      projectedItems: equippedProjectedItems,
    }),
  ]);

  const sourceItems = [...bagResult.items, ...equippedResult.items];
  if (sourceItems.length <= 0) {
    return {
      info,
      bagItems: [],
      equippedItems: [],
    };
  }

  const context = await buildInventoryItemDefContext(characterId, sourceItems, {
    equippedItems: equippedResult.items,
  });

  return {
    info,
    bagItems: enrichInventoryItemsWithDefs(bagResult.items, context),
    equippedItems: enrichInventoryItemsWithDefs(equippedResult.items, context),
  };
};
