import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { findEmptySlotsWithClient } from './inventory/index.js';
import { lockCharacterInventoryMutexTx, lockCharacterInventoryMutexesTx } from './inventoryMutex.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';
import { getItemDefinitionById, getItemDefinitions } from './staticConfigLoader.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import {
  enrichAffixesWithRollMeta,
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForReroll,
  parseGeneratedAffixesForReroll,
} from './equipmentAffixRerollService.js';
import { normalizeMarketCategoryFilter, resolveMarketItemCategory } from './shared/marketItemCategory.js';
import { mailService } from './mailService.js';

export type MarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'qtyDesc';

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
  qty: number;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
};

export type MarketTradeRecordDto = {
  id: number;
  type: '买入' | '卖出';
  itemDefId: string;
  name: string;
  icon: string | null;
  qty: number;
  unitPriceSpiritStones: number;
  counterparty: string;
  time: number;
};

const clampInt = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const parsePositiveInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
};

const parseNonNegativeInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
};

const parseMaybeString = (v: unknown): string => (typeof v === 'string' ? v : '').trim();

const getTaxAmount = (totalPrice: bigint, taxRate: number): bigint => {
  if (!Number.isFinite(taxRate) || taxRate <= 0) return 0n;
  const rate = Math.max(0, Math.min(100, taxRate));
  return (totalPrice * BigInt(Math.floor(rate * 100))) / 10000n;
};

const requireBuyerBagSlot = async (buyerCharacterId: number): Promise<number | null> => {
  const slots = await findEmptySlotsWithClient(buyerCharacterId, 'bag', 1, null);
  if (slots.length < 1) return null;
  return slots[0];
};

const toListingDto = (
  row: Record<string, unknown>,
  affixPoolCache: Map<string, ReturnType<typeof loadAffixPoolForReroll>>,
): MarketListingDto | null => {
  const itemDefId = String(row.item_def_id || '').trim();
  if (!itemDefId) return null;
  const itemDef = getItemDefinitionById(itemDefId);
  if (!itemDef) return null;

  const category = resolveMarketItemCategory(itemDef);
  const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
  const resolvedQualityRank =
    Number(row.instance_quality_rank) || resolveQualityRankFromName(row.instance_quality, defQualityRank);
  const baseAttrsRaw =
    itemDef.base_attrs && typeof itemDef.base_attrs === 'object'
      ? (itemDef.base_attrs as Record<string, number>)
      : {};
  const baseAttrs =
    category === 'equipment'
      ? buildEquipmentDisplayBaseAttrs({
          baseAttrsRaw,
          defQualityRankRaw: defQualityRank,
          resolvedQualityRankRaw: resolvedQualityRank,
          strengthenLevelRaw: row.strengthen_level,
          refineLevelRaw: row.refine_level,
          socketedGemsRaw: row.socketed_gems,
        })
      : baseAttrsRaw;
  let normalizedAffixes = parseGeneratedAffixesForReroll(row.affixes);
  if (category === 'equipment' && normalizedAffixes.length > 0) {
    const affixPoolId = typeof itemDef.affix_pool_id === 'string' ? itemDef.affix_pool_id.trim() : '';
    if (affixPoolId) {
      if (!affixPoolCache.has(affixPoolId)) {
        affixPoolCache.set(affixPoolId, loadAffixPoolForReroll(affixPoolId));
      }
      const affixPool = affixPoolCache.get(affixPoolId);
      if (affixPool) {
        const realmRank = getEquipRealmRankForReroll(itemDef.equip_req_realm);
        const resolvedQualityMultiplier = getQualityMultiplierForReroll(resolvedQualityRank);
        const defQualityMultiplier = getQualityMultiplierForReroll(defQualityRank);
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
    name: String(itemDef.name ?? ''),
    icon: itemDef.icon === null || itemDef.icon === undefined ? null : String(itemDef.icon),
    quality:
      row.instance_quality === null || row.instance_quality === undefined
        ? (itemDef.quality === null || itemDef.quality === undefined ? null : String(itemDef.quality))
        : String(row.instance_quality),
    category: category || null,
    subCategory: itemDef.sub_category === null || itemDef.sub_category === undefined ? null : String(itemDef.sub_category),
    description: itemDef.description === null || itemDef.description === undefined ? null : String(itemDef.description),
    longDesc: itemDef.long_desc === null || itemDef.long_desc === undefined ? null : String(itemDef.long_desc),
    tags: itemDef.tags ?? null,
    effectDefs: itemDef.effect_defs ?? null,
    baseAttrs,
    equipSlot: itemDef.equip_slot === null || itemDef.equip_slot === undefined ? null : String(itemDef.equip_slot),
    equipReqRealm:
      itemDef.equip_req_realm === null || itemDef.equip_req_realm === undefined ? null : String(itemDef.equip_req_realm),
    useType: itemDef.use_type === null || itemDef.use_type === undefined ? null : String(itemDef.use_type),
    strengthenLevel: Math.max(0, Math.floor(Number(row.strengthen_level) || 0)),
    refineLevel: Math.max(0, Math.floor(Number(row.refine_level) || 0)),
    identified: Boolean(row.identified),
    affixes: normalizedAffixes.length > 0 ? normalizedAffixes : row.affixes ?? [],
    qty: Number(row.qty),
    unitPriceSpiritStones: Number(row.unit_price_spirit_stones),
    sellerCharacterId: Number(row.seller_character_id),
    sellerName: String(row.seller_name ?? ''),
    listedAt: new Date(String(row.listed_at ?? '')).getTime(),
  };
};

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
  }): Promise<{ success: boolean; message: string; data?: { listings: MarketListingDto[]; total: number } }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;

    const category = normalizeMarketCategoryFilter(params.category);
    const quality = parseMaybeString(params.quality);
    const q = parseMaybeString(params.query);
    const minPrice = parseNonNegativeInt(params.minPrice);
    const maxPrice = parseNonNegativeInt(params.maxPrice);
    const sort: MarketSort = (params.sort ?? 'timeDesc') as MarketSort;

    const allItemDefs = getItemDefinitions();
    const allItemDefIds = allItemDefs.map((entry) => String(entry.id || '').trim()).filter((id) => id.length > 0);
    if (allItemDefIds.length === 0) {
      return { success: true, message: 'ok', data: { listings: [], total: 0 } };
    }

    const where: string[] = [`ml.status = 'active'`];
    const values: Array<string | number | string[]> = [];

    values.push(allItemDefIds);
    where.push(`ml.item_def_id = ANY($${values.length}::varchar[])`);

    if (category === null) {
      return { success: true, message: 'ok', data: { listings: [], total: 0 } };
    }
    if (category !== 'all') {
      const categoryDefIds = allItemDefs
        .filter((entry) => resolveMarketItemCategory(entry) === category)
        .map((entry) => String(entry.id || '').trim())
        .filter((id) => id.length > 0);
      if (categoryDefIds.length === 0) {
        return { success: true, message: 'ok', data: { listings: [], total: 0 } };
      }
      values.push(categoryDefIds);
      where.push(`ml.item_def_id = ANY($${values.length}::varchar[])`);
    }
    if (quality && quality !== 'all') {
      const qualityDefIds = allItemDefs
        .filter((entry) => String(entry.quality || '') === quality)
        .map((entry) => String(entry.id || '').trim())
        .filter((id) => id.length > 0);
      values.push(quality);
      const qualityParam = `$${values.length}`;
      values.push(qualityDefIds);
      const qualityDefParam = `$${values.length}`;
      where.push(`(ii.quality = ${qualityParam} OR (ii.quality IS NULL AND ml.item_def_id = ANY(${qualityDefParam}::varchar[])))`);
    }
    if (q) {
      const queryLower = q.toLowerCase();
      const nameMatchedDefIds = allItemDefs
        .filter((entry) => String(entry.name || '').toLowerCase().includes(queryLower))
        .map((entry) => String(entry.id || '').trim())
        .filter((id) => id.length > 0);
      values.push(nameMatchedDefIds);
      const itemNameParam = `$${values.length}`;
      values.push(`%${q}%`);
      const sellerNameParam = `$${values.length}`;
      where.push(`(ml.item_def_id = ANY(${itemNameParam}::varchar[]) OR c.nickname ILIKE ${sellerNameParam})`);
    }
    if (minPrice !== null) {
      values.push(minPrice);
      where.push(`ml.unit_price_spirit_stones >= $${values.length}`);
    }
    if (maxPrice !== null) {
      values.push(maxPrice);
      where.push(`ml.unit_price_spirit_stones <= $${values.length}`);
    }
    const orderBy =
      sort === 'priceAsc'
        ? 'ml.unit_price_spirit_stones ASC, ml.listed_at DESC'
        : sort === 'priceDesc'
          ? 'ml.unit_price_spirit_stones DESC, ml.listed_at DESC'
          : sort === 'qtyDesc'
            ? 'ml.qty DESC, ml.listed_at DESC'
            : 'ml.listed_at DESC';

    values.push(pageSize);
    const limitParam = `$${values.length}`;
    values.push(offset);
    const offsetParam = `$${values.length}`;

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

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

    const [listResult, countResult] = await Promise.all([query(listSql, values), query(countSql, values.slice(0, values.length - 2))]);
    const total = Number(countResult.rows[0]?.cnt ?? 0);
    const affixPoolCache = new Map<string, ReturnType<typeof loadAffixPoolForReroll>>();
    const listings: MarketListingDto[] = listResult.rows
      .map((row) => toListingDto(row as Record<string, unknown>, affixPoolCache))
      .filter((entry): entry is MarketListingDto => entry !== null);
    return { success: true, message: 'ok', data: { listings, total } };
  }

  // 纯读方法，不加 @Transactional
  async getMyMarketListings(params: {
    characterId: number;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ success: boolean; message: string; data?: { listings: MarketListingDto[]; total: number } }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;
    const status = parseMaybeString(params.status) || 'active';

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
    const affixPoolCache = new Map<string, ReturnType<typeof loadAffixPoolForReroll>>();
    const listings: MarketListingDto[] = listResult.rows
      .map((row) => toListingDto(row as Record<string, unknown>, affixPoolCache))
      .filter((entry): entry is MarketListingDto => entry !== null);

    return { success: true, message: 'ok', data: { listings, total } };
  }

  @Transactional
  async createMarketListing(params: {
    userId: number;
    characterId: number;
    itemInstanceId: number;
    qty: number;
    unitPriceSpiritStones: number;
  }): Promise<{ success: boolean; message: string; data?: { listingId: number } }> {
    const itemInstanceId = parsePositiveInt(params.itemInstanceId);
    const qty = parsePositiveInt(params.qty);
    const unitPrice = parsePositiveInt(params.unitPriceSpiritStones);

    if (itemInstanceId === null) return { success: false, message: 'itemInstanceId参数错误' };
    if (qty === null) return { success: false, message: 'qty参数错误' };
    if (unitPrice === null) return { success: false, message: 'unitPriceSpiritStones参数错误' };

    await lockCharacterInventoryMutexTx(null, params.characterId);

    const itemResult = await query(
      `
        SELECT
          ii.id,
          ii.owner_user_id,
          ii.owner_character_id,
          ii.item_def_id,
          ii.qty,
          ii.location,
          ii.location_slot,
          ii.equipped_slot,
          ii.strengthen_level,
          ii.refine_level,
          ii.socketed_gems,
          ii.random_seed,
          ii.affixes,
          ii.identified,
          ii.custom_name,
          ii.locked,
          ii.expire_at,
          ii.obtained_from,
          ii.obtained_ref_id,
          ii.metadata,
          ii.bind_type
        FROM item_instance ii
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, params.characterId],
    );

    if (itemResult.rows.length === 0) {
      return { success: false, message: '物品不存在' };
    }
    const row = itemResult.rows[0];
    const itemDefId = String(row.item_def_id || '').trim();
    const itemDef = itemDefId ? getItemDefinitionById(itemDefId) : null;
    if (!itemDef) {
      return { success: false, message: '物品不存在' };
    }
    if (itemDef.tradeable !== true) {
      return { success: false, message: '该物品不可交易' };
    }
    if (String(row.bind_type) !== 'none') {
      return { success: false, message: '该物品已绑定，无法上架' };
    }
    if (row.locked) {
      return { success: false, message: '该物品已锁定，无法上架' };
    }
    if (String(row.location) === 'equipped' || row.equipped_slot) {
      return { success: false, message: '已穿戴物品无法上架' };
    }
    if (!['bag', 'warehouse'].includes(String(row.location))) {
      return { success: false, message: '该物品当前位置无法上架' };
    }

    const curQty = Number(row.qty) || 0;
    if (qty > curQty) {
      return { success: false, message: '数量不足' };
    }

    let listingItemInstanceId = itemInstanceId;

    if (qty < curQty) {
      await query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [qty, itemInstanceId]);

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
          SELECT
            owner_user_id, owner_character_id, item_def_id, $1,
            bind_type, bind_owner_user_id, bind_owner_character_id,
            'auction', NULL, NULL,
            strengthen_level, refine_level,
            socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta,
            custom_name, locked, expire_at,
            obtained_from, obtained_ref_id, metadata,
            NOW(), NOW()
          FROM item_instance
          WHERE id = $2
          RETURNING id
        `,
        [qty, itemInstanceId],
      );

      listingItemInstanceId = Number(insertResult.rows[0]?.id);
    } else {
      await query(
        `UPDATE item_instance SET location = 'auction', location_slot = NULL, equipped_slot = NULL, updated_at = NOW() WHERE id = $1`,
        [itemInstanceId],
      );
    }
    const listingResult = await query(
      `
        INSERT INTO market_listing (
          seller_user_id, seller_character_id,
          item_instance_id, item_def_id,
          qty, unit_price_spirit_stones,
          status
        ) VALUES (
          $1, $2,
          $3, $4,
          $5, $6,
          'active'
        )
        RETURNING id
      `,
      [params.userId, params.characterId, listingItemInstanceId, itemDefId, qty, unitPrice],
    );
    return { success: true, message: '上架成功', data: { listingId: Number(listingResult.rows[0].id) } };
  }

  @Transactional
  async cancelMarketListing(params: {
    userId: number;
    characterId: number;
    listingId: number;
  }): Promise<{ success: boolean; message: string }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null) return { success: false, message: 'listingId参数错误' };

    await lockCharacterInventoryMutexTx(null, params.characterId);

    const listingResult = await query(
      `
        SELECT id, seller_character_id, item_instance_id, qty, status
        FROM market_listing
        WHERE id = $1
        FOR UPDATE
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      return { success: false, message: '上架记录不存在' };
    }

    const listing = listingResult.rows[0];
    if (Number(listing.seller_character_id) !== params.characterId) {
      return { success: false, message: '无权限操作该上架记录' };
    }
    if (String(listing.status) !== 'active') {
      return { success: false, message: '该上架记录不可下架' };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const itemResult = await query(
      `
        SELECT id, owner_character_id, location
        FROM item_instance
        WHERE id = $1
        FOR UPDATE
      `,
      [itemInstanceId],
    );
    if (itemResult.rows.length === 0) {
      return { success: false, message: '物品不存在' };
    }
    const item = itemResult.rows[0];
    if (Number(item.owner_character_id) !== params.characterId) {
      return { success: false, message: '物品归属异常，无法下架' };
    }
    if (String(item.location) !== 'auction') {
      return { success: false, message: '物品不在坊市中，无法下架' };
    }

    const slot = await requireBuyerBagSlot(params.characterId);
    if (slot === null) {
      return { success: false, message: '背包已满，无法下架' };
    }
    await query(
      `
        UPDATE item_instance
        SET location = 'bag', location_slot = $1, equipped_slot = NULL, updated_at = NOW()
        WHERE id = $2
      `,
      [slot, itemInstanceId],
    );

    await query(
      `
        UPDATE market_listing
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [listingId],
    );
    return { success: true, message: '下架成功' };
  }

  @Transactional
  async buyMarketListing(params: {
    buyerUserId: number;
    buyerCharacterId: number;
    listingId: number;
  }): Promise<{ success: boolean; message: string }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null) return { success: false, message: 'listingId参数错误' };

    const listingOwnerResult = await query(
      `
        SELECT seller_character_id
        FROM market_listing
        WHERE id = $1
      `,
      [listingId],
    );
    if (listingOwnerResult.rows.length === 0) {
      return { success: false, message: '上架记录不存在' };
    }
    const sellerCharacterIdFromMeta = Number(listingOwnerResult.rows[0].seller_character_id);
    if (!Number.isInteger(sellerCharacterIdFromMeta) || sellerCharacterIdFromMeta <= 0) {
      return { success: false, message: '上架数据异常' };
    }
    if (sellerCharacterIdFromMeta === params.buyerCharacterId) {
      return { success: false, message: '不能购买自己上架的物品' };
    }
    await lockCharacterInventoryMutexesTx(null, [params.buyerCharacterId, sellerCharacterIdFromMeta]);

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
      return { success: false, message: '上架记录不存在' };
    }

    const listing = listingResult.rows[0];
    if (String(listing.status) !== 'active') {
      return { success: false, message: '该物品已被购买或下架' };
    }
    const sellerCharacterId = Number(listing.seller_character_id);
    const sellerUserId = Number(listing.seller_user_id);
    if (sellerCharacterId !== sellerCharacterIdFromMeta) {
      return { success: false, message: '上架数据异常，请刷新后重试' };
    }
    if (sellerCharacterId === params.buyerCharacterId) {
      return { success: false, message: '不能购买自己上架的物品' };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const itemDefId = String(listing.item_def_id);
    const qty = Number(listing.qty);
    const unitPrice = BigInt(listing.unit_price_spirit_stones);
    const totalPrice = unitPrice * BigInt(qty);

    const itemRowResult = await query(
      `SELECT id, owner_character_id, location, qty FROM item_instance WHERE id = $1 FOR UPDATE`,
      [itemInstanceId],
    );
    if (itemRowResult.rows.length === 0) {
      return { success: false, message: '物品不存在' };
    }
    const itemRow = itemRowResult.rows[0];
    if (String(itemRow.location) !== 'auction') {
      return { success: false, message: '物品不在坊市中' };
    }
    if (Number(itemRow.qty) !== qty) {
      return { success: false, message: '物品数量异常，请刷新后重试' };
    }
    if (Number(itemRow.owner_character_id) !== sellerCharacterId) {
      return { success: false, message: '物品归属异常，请刷新后重试' };
    }

    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) {
      return { success: false, message: '物品配置不存在，请稍后重试' };
    }
    const taxRate = Number(itemDef.tax_rate) || 0;
    const taxAmount = getTaxAmount(totalPrice, taxRate);
    const sellerGain = totalPrice - taxAmount;

    const buyerCharResult = await query(
      `SELECT spirit_stones FROM characters WHERE id = $1 FOR UPDATE`,
      [params.buyerCharacterId],
    );
    if (buyerCharResult.rows.length === 0) {
      return { success: false, message: '角色不存在' };
    }
    const buyerStones = BigInt(buyerCharResult.rows[0].spirit_stones ?? 0);
    if (buyerStones < totalPrice) {
      return { success: false, message: `灵石不足，需要${totalPrice.toString()}` };
    }

    await query(
      `UPDATE characters SET spirit_stones = spirit_stones - $1, updated_at = NOW() WHERE id = $2`,
      [totalPrice.toString(), params.buyerCharacterId],
    );
    await query(
      `UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`,
      [sellerGain.toString(), sellerCharacterId],
    );

    await query(
      `
        UPDATE item_instance
        SET owner_user_id = $1,
            owner_character_id = $2,
            -- 坊市成交后先进入邮件附件池，不直接写入背包，避免背包容量成为交易阻断点。
            location = 'mail',
            location_slot = NULL,
            equipped_slot = NULL,
            updated_at = NOW()
        WHERE id = $3
      `,
      [params.buyerUserId, params.buyerCharacterId, itemInstanceId],
    );

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
        qty,
        unitPrice.toString(),
        totalPrice.toString(),
        taxAmount.toString(),
      ],
    );

    // 统一复用邮件服务发放成交物品，避免在坊市模块重复实现“附件写库 + 领取流转”逻辑。
    const mailTitle = '坊市购买到账通知';
    const itemName = String(itemDef.name || itemDefId);
    const mailContent = `你在坊市购买的【${itemName}】已通过邮件发放，请及时领取附件。`;
    const mailResult = await mailService.sendMail({
      recipientUserId: params.buyerUserId,
      recipientCharacterId: params.buyerCharacterId,
      senderType: 'system',
      senderName: '坊市',
      mailType: 'trade',
      title: mailTitle,
      content: mailContent,
      attachItems: [
        {
          item_def_id: itemDefId,
          item_name: itemName,
          qty,
        },
      ],
      attachInstanceIds: [itemInstanceId],
      expireDays: 30,
      source: 'market',
      sourceRefId: String(listingId),
      metadata: {
        listingId,
      },
    });
    if (!mailResult.success) {
      throw new Error(`坊市购买邮件发送失败: ${mailResult.message}`);
    }

    return { success: true, message: '购买成功，物品已通过邮件发放' };
  }

  // 纯读方法，不加 @Transactional
  async getMarketTradeRecords(params: {
    characterId: number;
    page?: number;
    pageSize?: number;
  }): Promise<{ success: boolean; message: string; data?: { records: MarketTradeRecordDto[]; total: number } }> {
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
      const type: '买入' | '卖出' = params.characterId === buyerId ? '买入' : '卖出';
      const counterparty = type === '买入' ? String(r.seller_name ?? '') : String(r.buyer_name ?? '');
      const itemDefId = String(r.item_def_id || '').trim();
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

    return { success: true, message: 'ok', data: { records, total } };
  }
}

export const marketService = new MarketService();
