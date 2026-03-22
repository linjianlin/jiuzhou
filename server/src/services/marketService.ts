import { query } from "../config/database.js";
import { Transactional } from "../decorators/transactional.js";
import { moveItemInstanceToBagWithStacking } from "./inventory/index.js";
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
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
} from "./playerWritebackCacheService.js";
import type { PlayerInventoryItemState } from "./playerStateTypes.js";
import { loadPlayerInventoryStatesByCharacterId } from "./playerStateRepository.js";
import {
  loadPlayerInventoryStateByItemId,
  deletePlayerInventoryState,
  patchPlayerInventoryState,
  upsertPlayerInventoryState,
} from "./playerStateRepository.js";

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

type MarketWalletState = {
  id: number;
  user_id: number;
  silver: number;
  spirit_stones: number;
};

type MarketListingQueryRow = {
  id: number | string | null;
  item_instance_id: number | string | null;
  item_def_id: string | null;
  qty: number | string | null;
  unit_price_spirit_stones: number | string | null;
  seller_character_id: number | string | null;
  listed_at: string | Date | null;
  instance_quality: string | null;
  instance_quality_rank: number | string | null;
  strengthen_level: number | string | null;
  refine_level: number | string | null;
  socketed_gems: PlayerInventoryItemState["socketed_gems"];
  identified: boolean | null;
  affixes: PlayerInventoryItemState["affixes"];
  metadata: PlayerInventoryItemState["metadata"];
  seller_name: string | null;
  instance_owner_character_id: number | string | null;
};

type MarketListingReadOverlay = {
  sellerNameByCharacterId: Map<number, string>;
  itemStateByOwnerCharacterId: Map<number, Map<number, PlayerInventoryItemState>>;
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

const loadMarketWallet = async (
  characterId: number,
): Promise<MarketWalletState | null> => {
  const wallet = await loadCharacterWritebackRowByCharacterId(characterId, {
    forUpdate: true,
  });
  if (!wallet) return null;
  return {
    id: Number(wallet.id),
    user_id: Number(wallet.user_id),
    silver: Number(wallet.silver ?? 0),
    spirit_stones: Number(wallet.spirit_stones ?? 0),
  };
};

const applyMarketWalletDelta = async (
  characterId: number,
  current: MarketWalletState,
  delta: { silver?: number; spiritStones?: number },
): Promise<MarketWalletState> => {
  const nextWallet: MarketWalletState = {
    ...current,
    silver: Number(current.silver ?? 0) + (delta.silver ?? 0),
    spirit_stones: Number(current.spirit_stones ?? 0) + (delta.spiritStones ?? 0),
  };
  await queueCharacterWritebackSnapshot(characterId, {
    silver: nextWallet.silver,
    spirit_stones: nextWallet.spirit_stones,
  });
  return nextWallet;
};

/**
 * 复用上架实例复制逻辑。
 *
 * 作用：
 * - 做什么：把一个已有物品实例按指定数量复制成新的拍卖实例，并同步写入 Redis 库存状态。
 * - 不做什么：不处理下架和购买，不负责决定该实例是否真的可以交易。
 *
 * 输入/输出：
 * - 输入：源实例 ID、源 Redis 物品状态、归属角色/账号、复制数量、目标位置。
 * - 输出：新拍卖实例的数据库 ID。
 *
 * 数据流/状态流：
 * - 业务层先完成 Redis 库存状态变更，再用源 Redis 实例字段生成数据库镜像行，最后把新实例状态写回 Redis。
 *
 * 关键边界条件与坑点：
 * 1. 源 Redis 物品状态必须已存在，否则克隆出来的拍卖实例无法与主状态对齐。
 * 2. 新实例状态的 `location` 必须与数据库插入结果一致，否则 overlay 会读到错位状态。
 */
const cloneItemInstanceWithQty = async (params: {
  sourceItemState?: PlayerInventoryItemState;
  ownerUserId: number;
  ownerCharacterId: number;
  qty: number;
  location: "auction" | "mail";
}): Promise<number> => {
  if (!params.sourceItemState) {
    throw new Error("复制坊市物品实例缺少源状态");
  }
  const insertResult = await query(
    `
      INSERT INTO item_instance (
        owner_user_id, owner_character_id, item_def_id, qty,
        bind_type, bind_owner_user_id, bind_owner_character_id,
        location, location_slot, equipped_slot,
        strengthen_level, refine_level,
        socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta,
        custom_name, locked, expire_at,
        obtained_from, obtained_ref_id, metadata,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, NULL, NULL,
        $9, $10,
        $11::jsonb, $12, $13::jsonb, $14, $15, $16::jsonb,
        $17, $18, $19::timestamptz,
        $20, $21, $22::jsonb,
        NOW(), NOW()
      )
      RETURNING id
    `,
    [
      params.ownerUserId,
      params.ownerCharacterId,
      params.sourceItemState.item_def_id,
      params.qty,
      params.sourceItemState.bind_type,
      params.sourceItemState.bind_owner_user_id,
      params.sourceItemState.bind_owner_character_id,
      params.location,
      params.sourceItemState.strengthen_level,
      params.sourceItemState.refine_level,
      JSON.stringify(params.sourceItemState.socketed_gems),
      params.sourceItemState.random_seed,
      JSON.stringify(params.sourceItemState.affixes),
      params.sourceItemState.identified,
      params.sourceItemState.affix_gen_version,
      JSON.stringify(params.sourceItemState.affix_roll_meta),
      params.sourceItemState.custom_name,
      params.sourceItemState.locked,
      params.sourceItemState.expire_at,
      params.sourceItemState.obtained_from,
      params.sourceItemState.obtained_ref_id,
      JSON.stringify(params.sourceItemState.metadata),
    ],
  );

  const nextItemInstanceId = Number(insertResult.rows[0]?.id);
  if (!Number.isInteger(nextItemInstanceId) || nextItemInstanceId <= 0) {
    throw new Error("复制坊市物品实例失败");
  }

  if (params.sourceItemState) {
    await upsertPlayerInventoryState(params.ownerCharacterId, {
      ...params.sourceItemState,
      id: nextItemInstanceId,
      owner_user_id: params.ownerUserId,
      owner_character_id: params.ownerCharacterId,
      qty: params.qty,
      location: params.location,
      location_slot: null,
      equipped_slot: null,
      created_at: new Date().toISOString(),
    });
  }
  return nextItemInstanceId;
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

const loadMarketListingReadOverlay = async (
  rows: MarketListingQueryRow[],
): Promise<MarketListingReadOverlay> => {
  const sellerCharacterIds = [...new Set(
    rows
      .map((row) => Number(row.seller_character_id))
      .filter((characterId) => Number.isInteger(characterId) && characterId > 0),
  )];
  const sellerNameEntries = await Promise.all(
    sellerCharacterIds.map(async (characterId) => {
      const row = await loadCharacterWritebackRowByCharacterId(characterId);
      if (!row) {
        throw new Error(`角色不存在: ${characterId}`);
      }
      return [characterId, row.nickname] as const;
    }),
  );

  const ownerCharacterIds = [...new Set(
    rows
      .map((row) => Number(row.instance_owner_character_id))
      .filter((characterId) => Number.isInteger(characterId) && characterId > 0),
  )];
  const itemStateEntries = await Promise.all(
    ownerCharacterIds.map(async (ownerCharacterId) => {
      const itemStates = await loadPlayerInventoryStatesByCharacterId(ownerCharacterId);
      return [
        ownerCharacterId,
        new Map<number, PlayerInventoryItemState>(
          itemStates.map((itemState: PlayerInventoryItemState) => [itemState.id, itemState] as const),
        ),
      ] as const;
    }),
  );

  return {
    sellerNameByCharacterId: new Map(sellerNameEntries),
    itemStateByOwnerCharacterId: new Map(itemStateEntries),
  };
};

const applyMarketListingReadOverlay = (
  row: MarketListingQueryRow,
  overlay: MarketListingReadOverlay,
): MarketListingQueryRow => {
  const sellerCharacterId = Number(row.seller_character_id);
  const sellerName = overlay.sellerNameByCharacterId.get(sellerCharacterId);
  if (!sellerName) {
    throw new Error(`角色不存在: ${sellerCharacterId}`);
  }

  const ownerCharacterId = Number(row.instance_owner_character_id);
  if (!Number.isInteger(ownerCharacterId) || ownerCharacterId <= 0) {
    throw new Error(`角色物品归属异常: ${row.item_instance_id}`);
  }
  const itemStateById = overlay.itemStateByOwnerCharacterId.get(ownerCharacterId);
  if (!itemStateById) {
    throw new Error(`角色物品状态不存在: ${ownerCharacterId}`);
  }

  const itemInstanceId = Number(row.item_instance_id);
  const itemState = itemStateById.get(itemInstanceId);
  if (!itemState) {
    throw new Error(`物品状态不存在: ${itemInstanceId}`);
  }

  return {
    ...row,
    seller_name: sellerName,
    instance_quality: itemState.quality,
    instance_quality_rank: itemState.quality_rank,
    strengthen_level: itemState.strengthen_level,
    refine_level: itemState.refine_level,
    socketed_gems: itemState.socketed_gems,
    identified: itemState.identified,
    affixes: itemState.affixes,
    metadata: itemState.metadata,
  };
};

const buildMarketListingDtosWithReadOverlay = async (
  rows: MarketListingQueryRow[],
  affixPoolCache: Map<string, ReturnType<typeof loadAffixPoolForReroll>>,
): Promise<MarketListingDto[]> => {
  if (rows.length === 0) return [];
  const overlay = await loadMarketListingReadOverlay(rows);
  return rows
    .map((row) => applyMarketListingReadOverlay(row, overlay))
    .map((row) => toListingDto(row as Record<string, unknown>, affixPoolCache))
    .filter((entry): entry is MarketListingDto => entry !== null);
};

const buildMarketListingDtosFromRows = (
  rows: MarketListingQueryRow[],
  affixPoolCache: Map<string, ReturnType<typeof loadAffixPoolForReroll>>,
): MarketListingDto[] => {
  return rows
    .map((row) => toListingDto(row as Record<string, unknown>, affixPoolCache))
    .filter((entry): entry is MarketListingDto => entry !== null);
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
      ml.seller_character_id AS instance_owner_character_id,
      NULL AS instance_quality,
      NULL AS instance_quality_rank,
      NULL AS strengthen_level,
      NULL AS refine_level,
      '[]'::jsonb AS socketed_gems,
      NULL AS identified,
      '[]'::jsonb AS affixes,
      '{}'::jsonb AS metadata,
      NULL AS seller_name
    FROM market_listing ml
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM market_listing ml
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
  const listings = await buildMarketListingDtosWithReadOverlay(
    listResult.rows as MarketListingQueryRow[],
    affixPoolCache,
  );

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
    const useLiveOverlay = status === "active";

    const listResult = await query(
      useLiveOverlay
        ? `
          SELECT
            ml.id,
            ml.item_instance_id,
            ml.item_def_id,
            ml.qty,
            ml.unit_price_spirit_stones,
            ml.seller_character_id,
            ml.listed_at,
            CASE
              WHEN ml.status = 'sold' THEN ml.buyer_character_id
              ELSE ml.seller_character_id
            END AS instance_owner_character_id,
            NULL AS instance_quality,
            NULL AS instance_quality_rank,
            NULL AS strengthen_level,
            NULL AS refine_level,
            '[]'::jsonb AS socketed_gems,
            NULL AS identified,
            '[]'::jsonb AS affixes,
            '{}'::jsonb AS metadata,
            NULL AS seller_name
          FROM market_listing ml
          WHERE ml.seller_character_id = $1 AND ml.status = $2
          ORDER BY ml.listed_at DESC
          LIMIT $3 OFFSET $4
        `
        : `
          SELECT
            ml.id,
            ml.item_instance_id,
            ml.item_def_id,
            ml.qty,
            ml.unit_price_spirit_stones,
            ml.seller_character_id,
            ml.listed_at,
            NULL AS instance_owner_character_id,
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
    const listingRows = listResult.rows as MarketListingQueryRow[];
    const listings = useLiveOverlay
      ? await buildMarketListingDtosWithReadOverlay(listingRows, affixPoolCache)
      : buildMarketListingDtosFromRows(listingRows, affixPoolCache);

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

    const sourceItemState = await loadPlayerInventoryStateByItemId(
      params.characterId,
      itemInstanceId,
    );
    if (!sourceItemState) {
      return { success: false, message: "物品不存在" };
    }
    const itemDefId = String(sourceItemState.item_def_id || "").trim();
    const itemDef = itemDefId ? getItemDefinitionById(itemDefId) : null;
    if (!itemDef) {
      return { success: false, message: "物品不存在" };
    }
    if (itemDef.tradeable !== true) {
      return { success: false, message: "该物品不可交易" };
    }
    if (String(sourceItemState.bind_type) !== "none") {
      return { success: false, message: "该物品已绑定，无法上架" };
    }
    if (sourceItemState.locked) {
      return { success: false, message: "该物品已锁定，无法上架" };
    }
    if (
      String(sourceItemState.location) === "equipped" ||
      sourceItemState.equipped_slot
    ) {
      return { success: false, message: "已穿戴物品无法上架" };
    }
    if (!["bag", "warehouse"].includes(String(sourceItemState.location))) {
      return { success: false, message: "该物品当前位置无法上架" };
    }

    const curQty = Number(sourceItemState.qty) || 0;
    if (qty > curQty) {
      return { success: false, message: "数量不足" };
    }

    const sellerWallet = await loadMarketWallet(params.characterId);
    if (!sellerWallet) {
      return { success: false, message: "角色不存在" };
    }
    const currentSilver = BigInt(sellerWallet.silver ?? 0);
    if (currentSilver < listingFeeSilver) {
      return {
        success: false,
        message: `银两不足，上架手续费需要${listingFeeSilver.toString()}`,
      };
    }
    if (listingFeeSilver > 0n) {
      await applyMarketWalletDelta(params.characterId, sellerWallet, {
        silver: -Number(listingFeeSilver),
      });
    }

    let listingItemInstanceId = itemInstanceId;

    if (qty < curQty) {
      await patchPlayerInventoryState(params.characterId, itemInstanceId, {
        qty: curQty - qty,
      });

      listingItemInstanceId = await cloneItemInstanceWithQty({
        sourceItemState,
        ownerUserId: params.userId,
        ownerCharacterId: params.characterId,
        qty,
        location: "auction",
      });
    } else {
      await patchPlayerInventoryState(params.characterId, itemInstanceId, {
        location: "auction",
        location_slot: null,
        equipped_slot: null,
      });
    }
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

    await lockCharacterInventoryMutex(params.characterId);

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

    const sellerWallet = await loadMarketWallet(params.characterId);
    if (!sellerWallet) {
      return { success: false, message: "角色不存在" };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const item = await loadPlayerInventoryStateByItemId(
      params.characterId,
      itemInstanceId,
    );
    if (!item) {
      return { success: false, message: "物品不存在" };
    }
    if (Number(item.owner_character_id) !== params.characterId) {
      return { success: false, message: "物品归属异常，无法下架" };
    }
    if (String(item.location) !== "auction") {
      return { success: false, message: "物品不在坊市中，无法下架" };
    }

    // 统一复用背包实例入包逻辑：先尝试堆叠已有同类堆，再决定是否占新格子。
    const moveResult = await moveItemInstanceToBagWithStacking(
      params.characterId,
      itemInstanceId,
      {
        expectedSourceLocation: "auction",
        expectedOwnerUserId: params.userId,
      },
    );
    if (!moveResult.success) {
      return {
        success: false,
        message:
          moveResult.message === "背包已满"
            ? "背包已满，无法下架"
            : moveResult.message,
      };
    }

    await query(
      `
        UPDATE market_listing
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [listingId],
    );

    if (refundFeeSilver > 0n) {
      await applyMarketWalletDelta(params.characterId, sellerWallet, {
        silver: Number(refundFeeSilver),
      });
    }

    await invalidateMarketListingsCache();
    return {
      success: true,
      message: `下架成功，已退还${refundFeeSilver.toString()}银两手续费`,
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

    const sourceItemState = await loadPlayerInventoryStateByItemId(
      sellerCharacterId,
      itemInstanceId,
    );
    if (!sourceItemState) {
      return { success: false, message: "物品不存在" };
    }
    if (String(sourceItemState.location) !== "auction") {
      return { success: false, message: "物品不在坊市中" };
    }
    if (Number(sourceItemState.qty) !== listingQty) {
      return { success: false, message: "物品数量异常，请刷新后重试" };
    }
    if (Number(sourceItemState.owner_character_id) !== sellerCharacterId) {
      return { success: false, message: "物品归属异常，请刷新后重试" };
    }

    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) {
      return { success: false, message: "物品配置不存在，请稍后重试" };
    }
    const taxRate = Number(itemDef.tax_rate) || 0;
    const taxAmount = getTaxAmount(totalPrice, taxRate);
    const sellerGain = totalPrice - taxAmount;

    const [buyerWallet, sellerWallet] = await Promise.all([
      loadMarketWallet(params.buyerCharacterId),
      loadMarketWallet(sellerCharacterId),
    ]);
    if (!buyerWallet || !sellerWallet) {
      return { success: false, message: "角色不存在" };
    }
    const buyerStones = BigInt(buyerWallet.spirit_stones ?? 0);
    if (buyerStones < totalPrice) {
      return {
        success: false,
        message: `灵石不足，需要${totalPrice.toString()}`,
      };
    }

    await applyMarketWalletDelta(params.buyerCharacterId, buyerWallet, {
      spiritStones: -Number(totalPrice),
    });
    await applyMarketWalletDelta(sellerCharacterId, sellerWallet, {
      spiritStones: Number(sellerGain),
    });

    let deliveredItemInstanceId = itemInstanceId;
    if (isPartialPurchase) {
      await patchPlayerInventoryState(sellerCharacterId, itemInstanceId, {
        qty: listingQty - buyQty,
      });
      deliveredItemInstanceId = await cloneItemInstanceWithQty({
        sourceItemState,
        ownerUserId: params.buyerUserId,
        ownerCharacterId: params.buyerCharacterId,
        qty: buyQty,
        location: "mail",
      });
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
      await deletePlayerInventoryState(sellerCharacterId, itemInstanceId);
      await upsertPlayerInventoryState(params.buyerCharacterId, {
        ...sourceItemState,
        id: itemInstanceId,
        owner_user_id: params.buyerUserId,
        owner_character_id: params.buyerCharacterId,
        location: "mail",
        location_slot: null,
        equipped_slot: null,
      });

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
          tr.created_at
        FROM market_trade_record tr
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
    const playerIds = [...new Set(
      listResult.rows
        .flatMap((row) => [Number(row.buyer_character_id), Number(row.seller_character_id)])
        .filter((characterId) => Number.isInteger(characterId) && characterId > 0),
    )];
    const nicknameEntries = await Promise.all(
      playerIds.map(async (characterId) => {
        const row = await loadCharacterWritebackRowByCharacterId(characterId);
        if (!row) {
          throw new Error(`角色不存在: ${characterId}`);
        }
        return [characterId, row.nickname] as const;
      }),
    );
    const nicknameMap = new Map(nicknameEntries);
    const records: MarketTradeRecordDto[] = listResult.rows.map((r) => {
      const buyerId = Number(r.buyer_character_id);
      const type: "买入" | "卖出" =
        params.characterId === buyerId ? "买入" : "卖出";
      const counterpartyId =
        type === "买入" ? Number(r.seller_character_id) : buyerId;
      const counterparty = nicknameMap.get(counterpartyId);
      if (!counterparty) {
        throw new Error(`角色不存在: ${counterpartyId}`);
      }
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
