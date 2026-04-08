import { query } from "../config/database.js";
import { Transactional } from "../decorators/transactional.js";
import {
  addCharacterCurrenciesExact,
  consumeCharacterCurrenciesExact,
} from "./inventory/shared/consume.js";
import {
  lockCharacterInventoryMutex,
  lockCharacterInventoryMutexes,
} from "./inventoryMutex.js";
import { buildEquipmentDisplayBaseAttrs } from "./equipmentGrowthRules.js";
import {
  getItemDefinitionById,
  getItemDefinitions,
} from "./staticConfigLoader.js";
import { resolveQualityRankFromName } from "./shared/itemQuality.js";
import {
  enrichAffixesWithRollMeta,
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForReroll,
  parseGeneratedAffixesForReroll,
} from "./equipmentAffixRerollService.js";
import { parsePositiveInt } from "./shared/httpParam.js";
import {
  normalizeMarketCategoryFilter,
  resolveMarketItemCategory,
} from "./shared/marketItemCategory.js";
import {
  calculateMarketListingFeeSilver,
  calculateMarketListingRefundFee,
  calculateMarketTradeTotalPrice,
  getTaxAmount,
  normalizeMarketBuyQuantity,
} from "./shared/marketListingPurchaseShared.js";
import { createCacheLayer } from "./shared/cacheLayer.js";
import {
  createCacheVersionManager,
  parseVersionedCacheBaseKey,
} from "./shared/cacheVersion.js";
import { resolveGeneratedTechniqueBookDisplay } from "./shared/generatedTechniqueBookView.js";
import { buildAffixPoolSlotCacheKey } from "./shared/affixPoolSlotResolver.js";
import { mailService } from "./mailService.js";
import {
  bufferCharacterItemInstanceMutations,
  loadProjectedCharacterItemInstanceById,
  reserveItemInstanceIds,
  type CharacterItemInstanceSnapshot,
  upsertCharacterItemInstanceSnapshot,
} from "./shared/characterItemInstanceMutationService.js";

export type MarketSort = "timeDesc" | "priceAsc" | "priceDesc" | "qtyDesc";

export type MarketListingDto = {
  id: number;
  itemInstanceId: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string | null;
  subCategory: string | null;
  description: string | null;
  longDesc: string | null;
  tags: unknown;
  effectDefs: unknown;
  baseAttrs: Record<string, number>;
  equipSlot: string | null;
  equipReqRealm: string | null;
  useType: string | null;
  strengthenLevel: number;
  refineLevel: number;
  identified: boolean;
  affixes: unknown;
  socketedGems: unknown;
  generatedTechniqueId: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
};

export type MarketTradeRecordDto = {
  id: number;
  type: "买入" | "卖出";
  itemDefId: string;
  name: string;
  icon: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  counterparty: string;
  time: number;
};

type MarketListingsQuery = {
  category: string | null;
  quality: string;
  query: string;
  minPrice: number | null;
  maxPrice: number | null;
  sort: MarketSort;
  page: number;
  pageSize: number;
};

type MarketListingsCacheData = {
  listings: MarketListingDto[];
  total: number;
};

const MARKET_LISTINGS_CACHE_REDIS_TTL_SEC = 8;
const MARKET_LISTINGS_CACHE_MEMORY_TTL_MS = 2_000;

const clampInt = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

const parseNonNegativeInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
};

const parseMaybeString = (v: unknown): string =>
  (typeof v === "string" ? v : "").trim();

const marketListingsCacheVersion = createCacheVersionManager("market:listings");

const invalidateMarketListingsCache = async (): Promise<void> => {
  await marketListingsCacheVersion.bumpVersion();
  marketListingsCache.invalidateAll();
};

/**
 * 复用 item_instance 拆堆复制逻辑，避免“部分上架”和“部分购买”各写一份插入 SQL。
 */
const cloneItemInstanceWithQty = async (params: {
  sourceItem: CharacterItemInstanceSnapshot;
  ownerUserId: number;
  ownerCharacterId: number;
  qty: number;
  location: "auction" | "mail";
}): Promise<CharacterItemInstanceSnapshot> => {
  const [nextItemInstanceId] = await reserveItemInstanceIds(1);
  if (!Number.isInteger(nextItemInstanceId) || nextItemInstanceId <= 0) {
    throw new Error("复制坊市物品实例失败");
  }
  return {
    ...params.sourceItem,
    id: nextItemInstanceId,
    owner_user_id: params.ownerUserId,
    owner_character_id: params.ownerCharacterId,
    qty: params.qty,
    location: params.location,
    location_slot: null,
    equipped_slot: null,
    created_at: new Date(),
  };
};

const toListingDto = (
  row: Record<string, unknown>,
  affixPoolCache: Map<string, ReturnType<typeof loadAffixPoolForReroll>>,
): MarketListingDto | null => {
  const itemDefId = String(row.item_def_id || "").trim();
  if (!itemDefId) return null;
  const itemDef = getItemDefinitionById(itemDefId);
  if (!itemDef) return null;
  const generatedTechniqueBookDisplay = resolveGeneratedTechniqueBookDisplay(
    itemDefId,
    row.metadata,
  );

  const category = resolveMarketItemCategory(itemDef);
  const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
  const resolvedQualityRank =
    Number(row.instance_quality_rank) ||
    resolveQualityRankFromName(row.instance_quality, defQualityRank);
  const baseAttrsRaw =
    itemDef.base_attrs && typeof itemDef.base_attrs === "object"
      ? (itemDef.base_attrs as Record<string, number>)
      : {};
  const baseAttrs =
    category === "equipment"
      ? buildEquipmentDisplayBaseAttrs({
          baseAttrsRaw,
          defQualityRankRaw: defQualityRank,
          resolvedQualityRankRaw: resolvedQualityRank,
          strengthenLevelRaw: row.strengthen_level,
          refineLevelRaw: row.refine_level,
          // 坊市 Tooltip 会单独展示已镶嵌宝石，这里的基础属性只保留品质/强化/精炼后的装备本体数值，
          // 避免宝石收益在“基础属性”和“已镶嵌宝石”里重复展示。
          socketedGemsRaw: [],
        })
      : baseAttrsRaw;
  let normalizedAffixes = parseGeneratedAffixesForReroll(row.affixes);
  if (category === "equipment" && normalizedAffixes.length > 0) {
    const affixPoolId =
      typeof itemDef.affix_pool_id === "string"
        ? itemDef.affix_pool_id.trim()
        : "";
    const equipSlot =
      typeof itemDef.equip_slot === "string"
        ? itemDef.equip_slot.trim()
        : "";
    if (affixPoolId && equipSlot) {
      const affixPoolCacheKey = buildAffixPoolSlotCacheKey(affixPoolId, equipSlot);
      if (!affixPoolCache.has(affixPoolCacheKey)) {
        affixPoolCache.set(affixPoolCacheKey, loadAffixPoolForReroll(affixPoolId, equipSlot));
      }
      const affixPool = affixPoolCache.get(affixPoolCacheKey);
      if (affixPool) {
        const realmRank = getEquipRealmRankForReroll(itemDef.equip_req_realm);
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
  }

  return {
    id: Number(row.id),
    itemInstanceId: Number(row.item_instance_id),
    itemDefId,
    name: generatedTechniqueBookDisplay?.name ?? String(itemDef.name ?? ""),
    icon:
      itemDef.icon === null || itemDef.icon === undefined
        ? null
        : String(itemDef.icon),
    quality:
      row.instance_quality === null || row.instance_quality === undefined
        ? generatedTechniqueBookDisplay?.quality ??
          (itemDef.quality === null || itemDef.quality === undefined
            ? null
            : String(itemDef.quality))
        : String(row.instance_quality),
    category: category || null,
    subCategory:
      itemDef.sub_category === null || itemDef.sub_category === undefined
        ? null
        : String(itemDef.sub_category),
    description: generatedTechniqueBookDisplay
      ? generatedTechniqueBookDisplay.description
      : itemDef.description === null || itemDef.description === undefined
        ? null
        : String(itemDef.description),
    longDesc: generatedTechniqueBookDisplay
      ? generatedTechniqueBookDisplay.longDesc
      : itemDef.long_desc === null || itemDef.long_desc === undefined
        ? null
        : String(itemDef.long_desc),
    tags: generatedTechniqueBookDisplay?.tags ?? itemDef.tags ?? null,
    effectDefs: itemDef.effect_defs ?? null,
    baseAttrs,
    equipSlot:
      itemDef.equip_slot === null || itemDef.equip_slot === undefined
        ? null
        : String(itemDef.equip_slot),
    equipReqRealm:
      itemDef.equip_req_realm === null || itemDef.equip_req_realm === undefined
        ? null
        : String(itemDef.equip_req_realm),
    useType:
      itemDef.use_type === null || itemDef.use_type === undefined
        ? null
        : String(itemDef.use_type),
    strengthenLevel: Math.max(0, Math.floor(Number(row.strengthen_level) || 0)),
    refineLevel: Math.max(0, Math.floor(Number(row.refine_level) || 0)),
    identified: Boolean(row.identified),
    affixes:
      normalizedAffixes.length > 0 ? normalizedAffixes : (row.affixes ?? []),
    socketedGems: row.socketed_gems ?? null,
    generatedTechniqueId: generatedTechniqueBookDisplay?.generatedTechniqueId ?? null,
    qty: Number(row.qty),
    unitPriceSpiritStones: Number(row.unit_price_spirit_stones),
    sellerCharacterId: Number(row.seller_character_id),
    sellerName: String(row.seller_name ?? ""),
    listedAt: new Date(String(row.listed_at ?? "")).getTime(),
  };
};

const normalizeMarketListingsQuery = (params: {
  category?: string;
  quality?: string;
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: MarketSort;
  page?: number;
  pageSize?: number;
}): MarketListingsQuery => {
  return {
    category: normalizeMarketCategoryFilter(params.category),
    quality: parseMaybeString(params.quality),
    query: parseMaybeString(params.query),
    minPrice: parseNonNegativeInt(params.minPrice),
    maxPrice: parseNonNegativeInt(params.maxPrice),
    sort: (params.sort ?? "timeDesc") as MarketSort,
    page: clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000),
    pageSize: clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100),
  };
};

const loadMarketListingsCacheData = async (
  params: MarketListingsQuery,
): Promise<MarketListingsCacheData> => {
  const offset = (params.page - 1) * params.pageSize;

  const allItemDefs = getItemDefinitions();
  const allItemDefIds = allItemDefs
    .map((entry) => String(entry.id || "").trim())
    .filter((id) => id.length > 0);
  if (allItemDefIds.length === 0) {
    return { listings: [], total: 0 };
  }

  const where: string[] = [`ml.status = 'active'`];
  const values: Array<string | number | string[]> = [];

  values.push(allItemDefIds);
  where.push(`ml.item_def_id = ANY($${values.length}::varchar[])`);

  if (params.category === null) {
    return { listings: [], total: 0 };
  }
  if (params.category !== "all") {
    const categoryDefIds = allItemDefs
      .filter((entry) => resolveMarketItemCategory(entry) === params.category)
      .map((entry) => String(entry.id || "").trim())
      .filter((id) => id.length > 0);
    if (categoryDefIds.length === 0) {
      return { listings: [], total: 0 };
    }
    values.push(categoryDefIds);
    where.push(`ml.item_def_id = ANY($${values.length}::varchar[])`);
  }
  if (params.quality && params.quality !== "all") {
    const qualityDefIds = allItemDefs
      .filter((entry) => String(entry.quality || "") === params.quality)
      .map((entry) => String(entry.id || "").trim())
      .filter((id) => id.length > 0);
    values.push(params.quality);
    const qualityParam = `$${values.length}`;
    values.push(qualityDefIds);
    const qualityDefParam = `$${values.length}`;
    where.push(
      `(ii.quality = ${qualityParam} OR (ii.quality IS NULL AND ml.item_def_id = ANY(${qualityDefParam}::varchar[])))`,
    );
  }
  if (params.query) {
    const queryLower = params.query.toLowerCase();
    const nameMatchedDefIds = allItemDefs
      .filter((entry) =>
        String(entry.name || "")
          .toLowerCase()
          .includes(queryLower),
      )
      .map((entry) => String(entry.id || "").trim())
      .filter((id) => id.length > 0);
    values.push(nameMatchedDefIds);
    const itemNameParam = `$${values.length}`;
    values.push(`%${params.query}%`);
    const sellerNameParam = `$${values.length}`;
    where.push(
      `(ml.item_def_id = ANY(${itemNameParam}::varchar[]) OR c.nickname ILIKE ${sellerNameParam})`,
    );
  }
  if (params.minPrice !== null) {
    values.push(params.minPrice);
    where.push(`ml.unit_price_spirit_stones >= $${values.length}`);
  }
  if (params.maxPrice !== null) {
    values.push(params.maxPrice);
    where.push(`ml.unit_price_spirit_stones <= $${values.length}`);
  }

  const orderBy =
    params.sort === "priceAsc"
      ? "ml.unit_price_spirit_stones ASC, ml.listed_at DESC"
      : params.sort === "priceDesc"
        ? "ml.unit_price_spirit_stones DESC, ml.listed_at DESC"
        : params.sort === "qtyDesc"
          ? "ml.qty DESC, ml.listed_at DESC"
          : "ml.listed_at DESC";

  values.push(params.pageSize);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const listSql = `
    SELECT
      ml.id,
      ml.item_instance_id,
      ml.item_def_id,
      ml.qty,
      ml.unit_price_spirit_stones,
      ml.seller_character_id,
      ml.listed_at,
      ii.quality AS instance_quality,
      ii.quality_rank AS instance_quality_rank,
      ii.strengthen_level,
      ii.refine_level,
      ii.socketed_gems,
      ii.identified,
      ii.affixes,
      ii.metadata,
      c.nickname AS seller_name
    FROM market_listing ml
    JOIN item_instance ii ON ii.id = ml.item_instance_id
    JOIN characters c ON c.id = ml.seller_character_id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM market_listing ml
    JOIN item_instance ii ON ii.id = ml.item_instance_id
    JOIN characters c ON c.id = ml.seller_character_id
    ${whereSql}
  `;

  const [listResult, countResult] = await Promise.all([
    query(listSql, values),
    query(countSql, values.slice(0, values.length - 2)),
  ]);
  const total = Number(countResult.rows[0]?.cnt ?? 0);
  const affixPoolCache = new Map<
    string,
    ReturnType<typeof loadAffixPoolForReroll>
  >();
  const listings: MarketListingDto[] = listResult.rows
    .map((row) =>
      toListingDto(row as Record<string, unknown>, affixPoolCache),
    )
    .filter((entry): entry is MarketListingDto => entry !== null);

  return { listings, total };
};

const marketListingsCache = createCacheLayer<string, MarketListingsCacheData>({
  keyPrefix: "market:listings:",
  redisTtlSec: MARKET_LISTINGS_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: MARKET_LISTINGS_CACHE_MEMORY_TTL_MS,
  loader: async (versionedKey) => {
    const queryParams = parseVersionedCacheBaseKey<MarketListingsQuery>(versionedKey);
    if (!queryParams) return null;
    return loadMarketListingsCacheData(queryParams);
  },
});

class MarketService {
  // 纯读方法，不加 @Transactional
  async getMarketListings(params: {
    category?: string;
    quality?: string;
    query?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: MarketSort;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listings: MarketListingDto[]; total: number };
  }> {
    const normalizedQuery = normalizeMarketListingsQuery(params);
    const versionedKey = await marketListingsCacheVersion.buildVersionedKey(
      JSON.stringify(normalizedQuery),
    );
    const data = (await marketListingsCache.get(versionedKey)) ?? {
      listings: [],
      total: 0,
    };
    return { success: true, message: "ok", data };
  }

  // 纯读方法，不加 @Transactional
  async getMyMarketListings(params: {
    characterId: number;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listings: MarketListingDto[]; total: number };
  }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;
    const status = parseMaybeString(params.status) || "active";

    const listResult = await query(
      `
        SELECT
          ml.id,
          ml.item_instance_id,
          ml.item_def_id,
          ml.qty,
          ml.unit_price_spirit_stones,
          ml.seller_character_id,
          ml.listed_at,
          ii.quality AS instance_quality,
          ii.quality_rank AS instance_quality_rank,
          ii.strengthen_level,
          ii.refine_level,
          ii.socketed_gems,
          ii.identified,
          ii.affixes,
          ii.metadata,
          c.nickname AS seller_name
        FROM market_listing ml
        LEFT JOIN item_instance ii ON ii.id = ml.item_instance_id
        JOIN characters c ON c.id = ml.seller_character_id
        WHERE ml.seller_character_id = $1 AND ml.status = $2
        ORDER BY ml.listed_at DESC
        LIMIT $3 OFFSET $4
      `,
      [params.characterId, status, pageSize, offset],
    );

    const countResult = await query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM market_listing
        WHERE seller_character_id = $1 AND status = $2
      `,
      [params.characterId, status],
    );

    const total = Number(countResult.rows[0]?.cnt ?? 0);
    const affixPoolCache = new Map<
      string,
      ReturnType<typeof loadAffixPoolForReroll>
    >();
    const listings: MarketListingDto[] = listResult.rows
      .map((row) =>
        toListingDto(row as Record<string, unknown>, affixPoolCache),
      )
      .filter((entry): entry is MarketListingDto => entry !== null);

    return { success: true, message: "ok", data: { listings, total } };
  }

  @Transactional
  async createMarketListing(params: {
    userId: number;
    characterId: number;
    itemInstanceId: number;
    qty: number;
    unitPriceSpiritStones: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listingId: number };
  }> {
    const itemInstanceId = parsePositiveInt(params.itemInstanceId);
    const qty = parsePositiveInt(params.qty);
    const unitPrice = parsePositiveInt(params.unitPriceSpiritStones);

    if (itemInstanceId === null)
      return { success: false, message: "itemInstanceId参数错误" };
    if (qty === null) return { success: false, message: "qty参数错误" };
    if (unitPrice === null)
      return { success: false, message: "unitPriceSpiritStones参数错误" };
    const totalPriceSpiritStones = calculateMarketTradeTotalPrice(
      BigInt(unitPrice),
      qty,
    );
    const listingFeeSilver =
      calculateMarketListingFeeSilver(totalPriceSpiritStones);

    await lockCharacterInventoryMutex(params.characterId);

    const row = await loadProjectedCharacterItemInstanceById(params.characterId, itemInstanceId);
    if (!row) {
      return { success: false, message: "物品不存在" };
    }
    const itemDefId = String(row.item_def_id || "").trim();
    const itemDef = itemDefId ? getItemDefinitionById(itemDefId) : null;
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }
    if (itemDef.tradeable !== true) {
      return { success: false, message: "该物品不可交易" };
    }
    if (String(row.bind_type) !== "none") {
      return { success: false, message: "该物品已绑定，无法上架" };
    }
    if (row.locked) {
      return { success: false, message: "该物品已锁定，无法上架" };
    }
    if (String(row.location) === "equipped" || row.equipped_slot) {
      return { success: false, message: "已穿戴物品无法上架" };
    }
    if (!["bag", "warehouse"].includes(String(row.location))) {
      return { success: false, message: "该物品当前位置无法上架" };
    }

    const curQty = Number(row.qty) || 0;
    if (qty > curQty) {
      return { success: false, message: "数量不足" };
    }

    if (listingFeeSilver > 0n) {
      const consumeResult = await consumeCharacterCurrenciesExact(params.characterId, {
        silver: listingFeeSilver,
      });
      if (!consumeResult.success) {
        if (consumeResult.message.startsWith("银两不足")) {
          return {
            success: false,
            message: `银两不足，上架手续费需要${listingFeeSilver.toString()}`,
          };
        }
        return { success: false, message: consumeResult.message };
      }
    }

    let listingItemInstanceId = itemInstanceId;
    let listingItemSnapshot: CharacterItemInstanceSnapshot;

    if (qty < curQty) {
      const clonedItem = await cloneItemInstanceWithQty({
        sourceItem: row,
        ownerUserId: params.userId,
        ownerCharacterId: params.characterId,
        qty,
        location: "auction",
      });
      listingItemSnapshot = clonedItem;
      listingItemInstanceId = clonedItem.id;
      await bufferCharacterItemInstanceMutations([
        {
          opId: `market-listing-source:${itemInstanceId}:${Date.now()}`,
          characterId: params.characterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "upsert",
          snapshot: {
            ...row,
            qty: curQty - qty,
          },
        },
        {
          opId: `market-listing-clone:${listingItemInstanceId}:${Date.now()}`,
          characterId: params.characterId,
          itemId: listingItemInstanceId,
          createdAt: Date.now(),
          kind: "upsert",
          snapshot: clonedItem,
        },
      ]);
    } else {
      listingItemSnapshot = {
        ...row,
        location: "auction",
        location_slot: null,
        equipped_slot: null,
      };
      await bufferCharacterItemInstanceMutations([
        {
          opId: `market-listing-move:${itemInstanceId}:${Date.now()}`,
          characterId: params.characterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "upsert",
          snapshot: listingItemSnapshot,
        },
      ]);
    }
    await upsertCharacterItemInstanceSnapshot(listingItemSnapshot);
    const listingResult = await query(
      `
        INSERT INTO market_listing (
          seller_user_id, seller_character_id,
          item_instance_id, item_def_id,
          qty, original_qty, unit_price_spirit_stones, listing_fee_silver,
          status
        ) VALUES (
          $1, $2,
          $3, $4,
          $5, $6, $7, $8,
          'active'
        )
        RETURNING id
      `,
      [
        params.userId,
        params.characterId,
        listingItemInstanceId,
        itemDefId,
        qty,
        qty,
        unitPrice,
        listingFeeSilver.toString(),
      ],
    );
    await invalidateMarketListingsCache();
    return {
      success: true,
      message: `上架成功，已收取${listingFeeSilver.toString()}银两手续费（未卖出下架将退还）`,
      data: { listingId: Number(listingResult.rows[0].id) },
    };
  }

  @Transactional
  async cancelMarketListing(params: {
    userId: number;
    characterId: number;
    listingId: number;
  }): Promise<{ success: boolean; message: string }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null)
      return { success: false, message: "listingId参数错误" };

    const listingResult = await query(
      `
        SELECT
          id,
          seller_character_id,
          item_instance_id,
          qty,
          original_qty,
          status,
          listing_fee_silver
        FROM market_listing
        WHERE id = $1
        FOR UPDATE
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return { success: false, message: "上架记录不存在" };
    }

    const listing = listingResult.rows[0];
    if (Number(listing.seller_character_id) !== params.characterId) {
      return { success: false, message: "无权限操作该上架记录" };
    }
    if (String(listing.status) !== "active") {
      return { success: false, message: "该上架记录不可下架" };
    }
    const listingFeeSilver = BigInt(listing.listing_fee_silver ?? 0);
    const originalQty = Number(listing.original_qty);
    const remainingQty = Number(listing.qty);
    const refundFeeSilver = calculateMarketListingRefundFee(
      listingFeeSilver,
      originalQty,
      remainingQty,
    );

    const itemInstanceId = Number(listing.item_instance_id);
    const item = await loadProjectedCharacterItemInstanceById(params.characterId, itemInstanceId);
    if (!item) {
      return { success: false, message: "物品不存在" };
    }
    if (Number(item.owner_character_id) !== params.characterId) {
      return { success: false, message: "物品归属异常，无法下架" };
    }
    if (String(item.location) !== "auction") {
      return { success: false, message: "物品不在坊市中，无法下架" };
    }

    await bufferCharacterItemInstanceMutations([
      {
        opId: `market-cancel:${itemInstanceId}:${Date.now()}`,
        characterId: params.characterId,
        itemId: itemInstanceId,
        createdAt: Date.now(),
        kind: "upsert",
        snapshot: {
          ...item,
          location: "mail",
          location_slot: null,
          equipped_slot: null,
        },
      },
    ]);

    await query(
      `
        UPDATE market_listing
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [listingId],
    );

    if (refundFeeSilver > 0n) {
      const addResult = await addCharacterCurrenciesExact(params.characterId, {
        silver: refundFeeSilver,
      });
      if (!addResult.success) {
        return { success: false, message: addResult.message };
      }
    }

    const mailResult = await mailService.sendMail({
      recipientUserId: params.userId,
      recipientCharacterId: params.characterId,
      senderType: "system",
      senderName: "坊市",
      mailType: "trade",
      title: "坊市下架返还通知",
      content: "你下架的坊市物品已通过邮件返还，请及时领取附件。",
      attachInstanceIds: [itemInstanceId],
      expireDays: 30,
      source: "market",
      sourceRefId: String(listingId),
      metadata: {
        listingId,
        action: "cancel",
      },
    });
    if (!mailResult.success) {
      throw new Error(`坊市下架邮件发送失败: ${mailResult.message}`);
    }

    await invalidateMarketListingsCache();
    return {
      success: true,
      message: `下架成功，物品已通过邮件返还，并退还${refundFeeSilver.toString()}银两手续费`,
    };
  }

  @Transactional
  async buyMarketListing(params: {
    buyerUserId: number;
    buyerCharacterId: number;
    listingId: number;
    qty: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: {
      sellerUserId: number;
    };
  }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null)
      return { success: false, message: "listingId参数错误" };
    const requestedQty = parsePositiveInt(params.qty);
    if (requestedQty === null) return { success: false, message: "qty参数错误" };

    const listingOwnerResult = await query(
      `
        SELECT seller_character_id
        FROM market_listing
        WHERE id = $1
      `,
      [listingId],
    );
    if (listingOwnerResult.rows.length === 0) {
      return { success: false, message: "上架记录不存在" };
    }
    const sellerCharacterIdFromMeta = Number(
      listingOwnerResult.rows[0].seller_character_id,
    );
    if (
      !Number.isInteger(sellerCharacterIdFromMeta) ||
      sellerCharacterIdFromMeta <= 0
    ) {
      return { success: false, message: "上架数据异常" };
    }
    if (sellerCharacterIdFromMeta === params.buyerCharacterId) {
      return { success: false, message: "不能购买自己上架的物品" };
    }
    await lockCharacterInventoryMutexes([
      params.buyerCharacterId,
      sellerCharacterIdFromMeta,
    ]);

    const listingResult = await query(
      `
        SELECT
          ml.id,
          ml.seller_user_id,
          ml.seller_character_id,
          ml.item_instance_id,
          ml.item_def_id,
          ml.qty,
          ml.unit_price_spirit_stones,
          ml.status
        FROM market_listing ml
        WHERE ml.id = $1
        FOR UPDATE
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return { success: false, message: "上架记录不存在" };
    }

    const listing = listingResult.rows[0];
    if (String(listing.status) !== "active") {
      return { success: false, message: "该物品已被购买或下架" };
    }
    const sellerCharacterId = Number(listing.seller_character_id);
    const sellerUserId = Number(listing.seller_user_id);
    if (sellerCharacterId !== sellerCharacterIdFromMeta) {
      return { success: false, message: "上架数据异常，请刷新后重试" };
    }
    if (sellerCharacterId === params.buyerCharacterId) {
      return { success: false, message: "不能购买自己上架的物品" };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const itemDefId = String(listing.item_def_id);
    const listingQty = Number(listing.qty);
    const buyQty = normalizeMarketBuyQuantity(requestedQty, listingQty);
    if (buyQty === null) {
      return { success: false, message: "购买数量不合法，请刷新后重试" };
    }
    const unitPrice = BigInt(listing.unit_price_spirit_stones);
    const totalPrice = calculateMarketTradeTotalPrice(unitPrice, buyQty);
    const isPartialPurchase = buyQty < listingQty;

    const itemRow = await loadProjectedCharacterItemInstanceById(sellerCharacterId, itemInstanceId);
    if (!itemRow) {
      return { success: false, message: "物品不存在" };
    }
    if (String(itemRow.location) !== "auction") {
      return { success: false, message: "物品不在坊市中" };
    }
    if (Number(itemRow.qty) !== listingQty) {
      return { success: false, message: "物品数量异常，请刷新后重试" };
    }
    if (Number(itemRow.owner_character_id) !== sellerCharacterId) {
      return { success: false, message: "物品归属异常，请刷新后重试" };
    }

    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) {
      return { success: false, message: "物品配置不存在，请稍后重试" };
    }
    const taxRate = Number(itemDef.tax_rate) || 0;
    const taxAmount = getTaxAmount(totalPrice, taxRate);
    const sellerGain = totalPrice - taxAmount;

    const buyerConsumeResult = await consumeCharacterCurrenciesExact(params.buyerCharacterId, {
      spiritStones: totalPrice,
    });
    if (!buyerConsumeResult.success) {
      return { success: false, message: buyerConsumeResult.message };
    }
    const sellerAddResult = await addCharacterCurrenciesExact(sellerCharacterId, {
      spiritStones: sellerGain,
    });
    if (!sellerAddResult.success) {
      return { success: false, message: sellerAddResult.message };
    }

    let deliveredItemInstanceId = itemInstanceId;
    if (isPartialPurchase) {
      const deliveredItem = await cloneItemInstanceWithQty({
        sourceItem: itemRow,
        ownerUserId: params.buyerUserId,
        ownerCharacterId: params.buyerCharacterId,
        qty: buyQty,
        location: "mail",
      });
      deliveredItemInstanceId = deliveredItem.id;
      await bufferCharacterItemInstanceMutations([
        {
          opId: `market-buy-partial-source:${itemInstanceId}:${Date.now()}`,
          characterId: sellerCharacterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "upsert",
          snapshot: {
            ...itemRow,
            qty: listingQty - buyQty,
          },
        },
        {
          opId: `market-buy-partial:${deliveredItemInstanceId}:${Date.now()}`,
          characterId: params.buyerCharacterId,
          itemId: deliveredItemInstanceId,
          createdAt: Date.now(),
          kind: "upsert",
          snapshot: deliveredItem,
        },
      ]);
      await query(
        `
          UPDATE market_listing
          SET qty = qty - $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [buyQty, listingId],
      );
    } else {
      await bufferCharacterItemInstanceMutations([
        {
          opId: `market-buy-full-source-delete:${itemInstanceId}:${Date.now()}`,
          characterId: sellerCharacterId,
          itemId: itemInstanceId,
          createdAt: Date.now(),
          kind: "delete",
          snapshot: null,
        },
        {
          opId: `market-buy-full:${itemInstanceId}:${Date.now()}`,
          characterId: params.buyerCharacterId,
          itemId: itemInstanceId,
          createdAt: Date.now() + 1,
          kind: "upsert",
          snapshot: {
            ...itemRow,
            owner_user_id: params.buyerUserId,
            owner_character_id: params.buyerCharacterId,
            location: "mail",
            location_slot: null,
            equipped_slot: null,
          },
        },
      ]);

      await query(
        `
          UPDATE market_listing
          SET status = 'sold',
              buyer_user_id = $1,
              buyer_character_id = $2,
              sold_at = NOW(),
              updated_at = NOW()
          WHERE id = $3
        `,
        [params.buyerUserId, params.buyerCharacterId, listingId],
      );
    }

    await query(
      `
        INSERT INTO market_trade_record (
          listing_id,
          buyer_user_id, buyer_character_id,
          seller_user_id, seller_character_id,
          item_def_id,
          qty,
          unit_price_spirit_stones,
          total_price_spirit_stones,
          tax_spirit_stones
        ) VALUES (
          $1,
          $2, $3,
          $4, $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )
      `,
      [
        listingId,
        params.buyerUserId,
        params.buyerCharacterId,
        sellerUserId,
        sellerCharacterId,
        itemDefId,
        buyQty,
        unitPrice.toString(),
        totalPrice.toString(),
        taxAmount.toString(),
      ],
    );

    // 统一复用邮件服务发放成交物品，避免在坊市模块重复实现“附件写库 + 领取流转”逻辑。
    const mailTitle = "坊市购买到账通知";
    const itemName = String(itemDef.name || itemDefId);
    const mailContent = `你在坊市购买的【${itemName}】已通过邮件发放，请及时领取附件。`;
    const mailResult = await mailService.sendMail({
      recipientUserId: params.buyerUserId,
      recipientCharacterId: params.buyerCharacterId,
      senderType: "system",
      senderName: "坊市",
      mailType: "trade",
      title: mailTitle,
      content: mailContent,
      attachItems: [
        {
          item_def_id: itemDefId,
          item_name: itemName,
          qty: buyQty,
        },
      ],
      attachInstanceIds: [deliveredItemInstanceId],
      expireDays: 30,
      source: "market",
      sourceRefId: String(listingId),
      metadata: {
        listingId,
      },
    });
    if (!mailResult.success) {
      throw new Error(`坊市购买邮件发送失败: ${mailResult.message}`);
    }

    await invalidateMarketListingsCache();
    return {
      success: true,
      message: "购买成功，物品已通过邮件发放",
      data: {
        sellerUserId,
      },
    };
  }

  // 纯读方法，不加 @Transactional
  async getMarketTradeRecords(params: {
    characterId: number;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { records: MarketTradeRecordDto[]; total: number };
  }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;

    const listResult = await query(
      `
        SELECT
          tr.id,
          tr.item_def_id,
          tr.qty,
          tr.unit_price_spirit_stones,
          tr.buyer_character_id,
          tr.seller_character_id,
          tr.created_at,
          cb.nickname AS buyer_name,
          cs.nickname AS seller_name
        FROM market_trade_record tr
        JOIN characters cb ON cb.id = tr.buyer_character_id
        JOIN characters cs ON cs.id = tr.seller_character_id
        WHERE tr.buyer_character_id = $1 OR tr.seller_character_id = $1
        ORDER BY tr.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [params.characterId, pageSize, offset],
    );

    const countResult = await query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM market_trade_record
        WHERE buyer_character_id = $1 OR seller_character_id = $1
      `,
      [params.characterId],
    );

    const total = Number(countResult.rows[0]?.cnt ?? 0);
    const records: MarketTradeRecordDto[] = listResult.rows.map((r) => {
      const buyerId = Number(r.buyer_character_id);
      const type: "买入" | "卖出" =
        params.characterId === buyerId ? "买入" : "卖出";
      const counterparty =
        type === "买入"
          ? String(r.seller_name ?? "")
          : String(r.buyer_name ?? "");
      const itemDefId = String(r.item_def_id || "").trim();
      const itemDef = itemDefId ? getItemDefinitionById(itemDefId) : null;
      return {
        id: Number(r.id),
        type,
        itemDefId,
        name: String(itemDef?.name || itemDefId),
        icon: itemDef?.icon ? String(itemDef.icon) : null,
        qty: Number(r.qty),
        unitPriceSpiritStones: Number(r.unit_price_spirit_stones),
        counterparty,
        time: new Date(r.created_at).getTime(),
      };
    });

    return { success: true, message: "ok", data: { records, total } };
  }
}

export const marketService = new MarketService();
