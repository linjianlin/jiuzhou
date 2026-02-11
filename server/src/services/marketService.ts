import { pool, query } from '../config/database.js';
import type { PoolClient } from 'pg';
import { findEmptySlotsWithClient } from './inventoryService.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';

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

const requireBuyerBagSlot = async (client: PoolClient, buyerCharacterId: number): Promise<number | null> => {
  const slots = await findEmptySlotsWithClient(buyerCharacterId, 'bag', 1, client);
  if (slots.length < 1) return null;
  return slots[0];
};

export const getMarketListings = async (params: {
  category?: string;
  quality?: string;
  query?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: MarketSort;
  page?: number;
  pageSize?: number;
}): Promise<{ success: boolean; message: string; data?: { listings: MarketListingDto[]; total: number } }> => {
  const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
  const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
  const offset = (page - 1) * pageSize;

  const category = parseMaybeString(params.category);
  const quality = parseMaybeString(params.quality);
  const q = parseMaybeString(params.query);
  const minPrice = parseNonNegativeInt(params.minPrice);
  const maxPrice = parseNonNegativeInt(params.maxPrice);
  const sort: MarketSort = (params.sort ?? 'timeDesc') as MarketSort;

  const where: string[] = [`ml.status = 'active'`];
  const values: Array<string | number> = [];

  if (category && category !== 'all') {
    values.push(category);
    where.push(`id.category = $${values.length}`);
  }
  if (quality && quality !== 'all') {
    values.push(quality);
    where.push(`COALESCE(ii.quality, id.quality) = $${values.length}`);
  }
  if (q) {
    values.push(`%${q}%`);
    const p = `$${values.length}`;
    where.push(`(id.name ILIKE ${p} OR c.nickname ILIKE ${p})`);
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
      id.name,
      id.icon,
      COALESCE(ii.quality, id.quality) AS resolved_quality,
      id.category,
      id.sub_category,
      id.description,
      id.long_desc,
      id.tags,
      id.effect_defs,
      id.base_attrs,
      id.equip_slot,
      id.equip_req_realm,
      id.use_type,
      id.socket_max,
      id.gem_slot_types,
      id.quality_rank AS def_quality_rank,
      COALESCE(ii.quality_rank, id.quality_rank) AS resolved_quality_rank,
      ii.strengthen_level,
      ii.refine_level,
      ii.socketed_gems,
      ii.identified,
      ii.affixes,
      c.nickname AS seller_name
    FROM market_listing ml
    JOIN item_instance ii ON ii.id = ml.item_instance_id
    JOIN item_def id ON id.id = ml.item_def_id
    JOIN characters c ON c.id = ml.seller_character_id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM market_listing ml
    JOIN item_instance ii ON ii.id = ml.item_instance_id
    JOIN item_def id ON id.id = ml.item_def_id
    JOIN characters c ON c.id = ml.seller_character_id
    ${whereSql}
  `;

  try {
    const [listResult, countResult] = await Promise.all([query(listSql, values), query(countSql, values.slice(0, values.length - 2))]);
    const total = Number(countResult.rows[0]?.cnt ?? 0);
    const listings: MarketListingDto[] = listResult.rows.map((r) => {
      const category = r.category === null || r.category === undefined ? null : String(r.category);
      const baseAttrs =
        category === 'equipment'
          ? buildEquipmentDisplayBaseAttrs({
              baseAttrsRaw: r.base_attrs,
              defQualityRankRaw: r.def_quality_rank,
              resolvedQualityRankRaw: r.resolved_quality_rank,
              strengthenLevelRaw: r.strengthen_level,
              refineLevelRaw: r.refine_level,
              socketedGemsRaw: r.socketed_gems,
            })
          : (r.base_attrs && typeof r.base_attrs === 'object' ? (r.base_attrs as Record<string, number>) : {});

      return {
        id: Number(r.id),
        itemInstanceId: Number(r.item_instance_id),
        itemDefId: String(r.item_def_id),
        name: String(r.name ?? ''),
        icon: r.icon === null || r.icon === undefined ? null : String(r.icon),
        quality: r.resolved_quality === null || r.resolved_quality === undefined ? null : String(r.resolved_quality),
        category,
        subCategory: r.sub_category === null || r.sub_category === undefined ? null : String(r.sub_category),
        description: r.description === null || r.description === undefined ? null : String(r.description),
        longDesc: r.long_desc === null || r.long_desc === undefined ? null : String(r.long_desc),
        tags: r.tags ?? null,
        effectDefs: r.effect_defs ?? null,
        baseAttrs,
        equipSlot: r.equip_slot === null || r.equip_slot === undefined ? null : String(r.equip_slot),
        equipReqRealm: r.equip_req_realm === null || r.equip_req_realm === undefined ? null : String(r.equip_req_realm),
        useType: r.use_type === null || r.use_type === undefined ? null : String(r.use_type),
        strengthenLevel: Math.max(0, Math.floor(Number(r.strengthen_level) || 0)),
        refineLevel: Math.max(0, Math.floor(Number(r.refine_level) || 0)),
        identified: Boolean(r.identified),
        affixes: r.affixes ?? [],
        qty: Number(r.qty),
        unitPriceSpiritStones: Number(r.unit_price_spirit_stones),
        sellerCharacterId: Number(r.seller_character_id),
        sellerName: String(r.seller_name ?? ''),
        listedAt: new Date(r.listed_at).getTime(),
      };
    });
    return { success: true, message: 'ok', data: { listings, total } };
  } catch (error) {
    console.error('获取坊市列表失败:', error);
    return { success: false, message: '获取坊市列表失败' };
  }
};

export const getMyMarketListings = async (params: {
  characterId: number;
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ success: boolean; message: string; data?: { listings: MarketListingDto[]; total: number } }> => {
  const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
  const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
  const offset = (page - 1) * pageSize;
  const status = parseMaybeString(params.status) || 'active';

  try {
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
          id.name,
          id.icon,
          COALESCE(ii.quality, id.quality) AS resolved_quality,
          id.category,
          id.sub_category,
          id.description,
          id.long_desc,
          id.tags,
          id.effect_defs,
          id.base_attrs,
          id.equip_slot,
          id.equip_req_realm,
          id.use_type,
          id.socket_max,
          id.gem_slot_types,
          id.quality_rank AS def_quality_rank,
          COALESCE(ii.quality_rank, id.quality_rank) AS resolved_quality_rank,
          ii.strengthen_level,
          ii.refine_level,
          ii.socketed_gems,
          ii.identified,
          ii.affixes,
          c.nickname AS seller_name
        FROM market_listing ml
        LEFT JOIN item_instance ii ON ii.id = ml.item_instance_id
        JOIN item_def id ON id.id = ml.item_def_id
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
    const listings: MarketListingDto[] = listResult.rows.map((r) => {
      const category = r.category === null || r.category === undefined ? null : String(r.category);
      const baseAttrs =
        category === 'equipment'
          ? buildEquipmentDisplayBaseAttrs({
              baseAttrsRaw: r.base_attrs,
              defQualityRankRaw: r.def_quality_rank,
              resolvedQualityRankRaw: r.resolved_quality_rank,
              strengthenLevelRaw: r.strengthen_level,
              refineLevelRaw: r.refine_level,
              socketedGemsRaw: r.socketed_gems,
            })
          : (r.base_attrs && typeof r.base_attrs === 'object' ? (r.base_attrs as Record<string, number>) : {});

      return {
        id: Number(r.id),
        itemInstanceId: Number(r.item_instance_id),
        itemDefId: String(r.item_def_id),
        name: String(r.name ?? ''),
        icon: r.icon === null || r.icon === undefined ? null : String(r.icon),
        quality: r.resolved_quality === null || r.resolved_quality === undefined ? null : String(r.resolved_quality),
        category,
        subCategory: r.sub_category === null || r.sub_category === undefined ? null : String(r.sub_category),
        description: r.description === null || r.description === undefined ? null : String(r.description),
        longDesc: r.long_desc === null || r.long_desc === undefined ? null : String(r.long_desc),
        tags: r.tags ?? null,
        effectDefs: r.effect_defs ?? null,
        baseAttrs,
        equipSlot: r.equip_slot === null || r.equip_slot === undefined ? null : String(r.equip_slot),
        equipReqRealm: r.equip_req_realm === null || r.equip_req_realm === undefined ? null : String(r.equip_req_realm),
        useType: r.use_type === null || r.use_type === undefined ? null : String(r.use_type),
        strengthenLevel: Math.max(0, Math.floor(Number(r.strengthen_level) || 0)),
        refineLevel: Math.max(0, Math.floor(Number(r.refine_level) || 0)),
        identified: Boolean(r.identified),
        affixes: r.affixes ?? [],
        qty: Number(r.qty),
        unitPriceSpiritStones: Number(r.unit_price_spirit_stones),
        sellerCharacterId: Number(r.seller_character_id),
        sellerName: String(r.seller_name ?? ''),
        listedAt: new Date(r.listed_at).getTime(),
      };
    });

    return { success: true, message: 'ok', data: { listings, total } };
  } catch (error) {
    console.error('获取我的上架失败:', error);
    return { success: false, message: '获取我的上架失败' };
  }
};

export const createMarketListing = async (params: {
  userId: number;
  characterId: number;
  itemInstanceId: number;
  qty: number;
  unitPriceSpiritStones: number;
}): Promise<{ success: boolean; message: string; data?: { listingId: number } }> => {
  const itemInstanceId = parsePositiveInt(params.itemInstanceId);
  const qty = parsePositiveInt(params.qty);
  const unitPrice = parsePositiveInt(params.unitPriceSpiritStones);

  if (itemInstanceId === null) return { success: false, message: 'itemInstanceId参数错误' };
  if (qty === null) return { success: false, message: 'qty参数错误' };
  if (unitPrice === null) return { success: false, message: 'unitPriceSpiritStones参数错误' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemResult = await client.query(
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
          ii.bind_type,
          id.tradeable
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, params.characterId],
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const row = itemResult.rows[0];
    if (!row.tradeable) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可交易' };
    }
    if (String(row.bind_type) !== 'none') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品已绑定，无法上架' };
    }
    if (row.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品已锁定，无法上架' };
    }
    if (String(row.location) === 'equipped' || row.equipped_slot) {
      await client.query('ROLLBACK');
      return { success: false, message: '已穿戴物品无法上架' };
    }
    if (!['bag', 'warehouse'].includes(String(row.location))) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品当前位置无法上架' };
    }

    const curQty = Number(row.qty) || 0;
    if (qty > curQty) {
      await client.query('ROLLBACK');
      return { success: false, message: '数量不足' };
    }

    const itemDefId = String(row.item_def_id);
    let listingItemInstanceId = itemInstanceId;

    if (qty < curQty) {
      await client.query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [qty, itemInstanceId]);

      const insertResult = await client.query(
        `
          INSERT INTO item_instance (
            owner_user_id, owner_character_id, item_def_id, qty,
            bind_type, bind_owner_user_id, bind_owner_character_id,
            location, location_slot, equipped_slot,
            strengthen_level, refine_level,
            socketed_gems, random_seed, affixes, identified,
            custom_name, locked, expire_at,
            obtained_from, obtained_ref_id, metadata,
            created_at, updated_at
          )
          SELECT
            owner_user_id, owner_character_id, item_def_id, $1,
            bind_type, bind_owner_user_id, bind_owner_character_id,
            'auction', NULL, NULL,
            strengthen_level, refine_level,
            socketed_gems, random_seed, affixes, identified,
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
      await client.query(
        `UPDATE item_instance SET location = 'auction', location_slot = NULL, equipped_slot = NULL, updated_at = NOW() WHERE id = $1`,
        [itemInstanceId],
      );
    }

    const listingResult = await client.query(
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

    await client.query('COMMIT');
    return { success: true, message: '上架成功', data: { listingId: Number(listingResult.rows[0].id) } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('物品上架失败:', error);
    return { success: false, message: '物品上架失败' };
  } finally {
    client.release();
  }
};

export const cancelMarketListing = async (params: {
  userId: number;
  characterId: number;
  listingId: number;
}): Promise<{ success: boolean; message: string }> => {
  const listingId = parsePositiveInt(params.listingId);
  if (listingId === null) return { success: false, message: 'listingId参数错误' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const listingResult = await client.query(
      `
        SELECT id, seller_character_id, item_instance_id, qty, status
        FROM market_listing
        WHERE id = $1
        FOR UPDATE
      `,
      [listingId],
    );

    if (listingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '上架记录不存在' };
    }

    const listing = listingResult.rows[0];
    if (Number(listing.seller_character_id) !== params.characterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '无权限操作该上架记录' };
    }
    if (String(listing.status) !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, message: '该上架记录不可下架' };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const itemResult = await client.query(
      `
        SELECT id, owner_character_id, location
        FROM item_instance
        WHERE id = $1
        FOR UPDATE
      `,
      [itemInstanceId],
    );
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }
    const item = itemResult.rows[0];
    if (Number(item.owner_character_id) !== params.characterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品归属异常，无法下架' };
    }
    if (String(item.location) !== 'auction') {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不在坊市中，无法下架' };
    }

    const slot = await requireBuyerBagSlot(client, params.characterId);
    if (slot === null) {
      await client.query('ROLLBACK');
      return { success: false, message: '背包已满，无法下架' };
    }

    await client.query(
      `
        UPDATE item_instance
        SET location = 'bag', location_slot = $1, equipped_slot = NULL, updated_at = NOW()
        WHERE id = $2
      `,
      [slot, itemInstanceId],
    );

    await client.query(
      `
        UPDATE market_listing
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE id = $1
      `,
      [listingId],
    );

    await client.query('COMMIT');
    return { success: true, message: '下架成功' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('下架失败:', error);
    return { success: false, message: '下架失败' };
  } finally {
    client.release();
  }
};

export const buyMarketListing = async (params: {
  buyerUserId: number;
  buyerCharacterId: number;
  listingId: number;
}): Promise<{ success: boolean; message: string }> => {
  const listingId = parsePositiveInt(params.listingId);
  if (listingId === null) return { success: false, message: 'listingId参数错误' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const listingResult = await client.query(
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
      await client.query('ROLLBACK');
      return { success: false, message: '上架记录不存在' };
    }

    const listing = listingResult.rows[0];
    if (String(listing.status) !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品已被购买或下架' };
    }

    const sellerCharacterId = Number(listing.seller_character_id);
    const sellerUserId = Number(listing.seller_user_id);
    if (sellerCharacterId === params.buyerCharacterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '不能购买自己上架的物品' };
    }

    const itemInstanceId = Number(listing.item_instance_id);
    const itemDefId = String(listing.item_def_id);
    const qty = Number(listing.qty);
    const unitPrice = BigInt(listing.unit_price_spirit_stones);
    const totalPrice = unitPrice * BigInt(qty);

    const itemRowResult = await client.query(
      `SELECT id, owner_character_id, location, qty FROM item_instance WHERE id = $1 FOR UPDATE`,
      [itemInstanceId],
    );
    if (itemRowResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }
    const itemRow = itemRowResult.rows[0];
    if (String(itemRow.location) !== 'auction') {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不在坊市中' };
    }
    if (Number(itemRow.qty) !== qty) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品数量异常，请刷新后重试' };
    }
    if (Number(itemRow.owner_character_id) !== sellerCharacterId) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品归属异常，请刷新后重试' };
    }

    const taxRateResult = await client.query(`SELECT COALESCE(tax_rate, 0)::numeric AS tax_rate FROM item_def WHERE id = $1`, [itemDefId]);
    const taxRate = Number(taxRateResult.rows[0]?.tax_rate ?? 0);
    const taxAmount = getTaxAmount(totalPrice, taxRate);
    const sellerGain = totalPrice - taxAmount;

    const buyerCharResult = await client.query(
      `SELECT spirit_stones FROM characters WHERE id = $1 FOR UPDATE`,
      [params.buyerCharacterId],
    );
    if (buyerCharResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const buyerStones = BigInt(buyerCharResult.rows[0].spirit_stones ?? 0);
    if (buyerStones < totalPrice) {
      await client.query('ROLLBACK');
      return { success: false, message: `灵石不足，需要${totalPrice.toString()}` };
    }

    const slot = await requireBuyerBagSlot(client, params.buyerCharacterId);
    if (slot === null) {
      await client.query('ROLLBACK');
      return { success: false, message: '背包已满，无法购买' };
    }

    await client.query(
      `UPDATE characters SET spirit_stones = spirit_stones - $1, updated_at = NOW() WHERE id = $2`,
      [totalPrice.toString(), params.buyerCharacterId],
    );
    await client.query(
      `UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`,
      [sellerGain.toString(), sellerCharacterId],
    );

    await client.query(
      `
        UPDATE item_instance
        SET owner_user_id = $1,
            owner_character_id = $2,
            location = 'bag',
            location_slot = $3,
            equipped_slot = NULL,
            updated_at = NOW()
        WHERE id = $4
      `,
      [params.buyerUserId, params.buyerCharacterId, slot, itemInstanceId],
    );

    await client.query(
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

    await client.query(
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

    await client.query('COMMIT');
    return { success: true, message: '购买成功' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('购买失败:', error);
    return { success: false, message: '购买失败' };
  } finally {
    client.release();
  }
};

export const getMarketTradeRecords = async (params: {
  characterId: number;
  page?: number;
  pageSize?: number;
}): Promise<{ success: boolean; message: string; data?: { records: MarketTradeRecordDto[]; total: number } }> => {
  const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1000000);
  const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
  const offset = (page - 1) * pageSize;

  try {
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
          id.name,
          id.icon,
          cb.nickname AS buyer_name,
          cs.nickname AS seller_name
        FROM market_trade_record tr
        JOIN item_def id ON id.id = tr.item_def_id
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
      return {
        id: Number(r.id),
        type,
        itemDefId: String(r.item_def_id),
        name: String(r.name ?? ''),
        icon: r.icon === null || r.icon === undefined ? null : String(r.icon),
        qty: Number(r.qty),
        unitPriceSpiritStones: Number(r.unit_price_spirit_stones),
        counterparty,
        time: new Date(r.created_at).getTime(),
      };
    });

    return { success: true, message: 'ok', data: { records, total } };
  } catch (error) {
    console.error('获取交易记录失败:', error);
    return { success: false, message: '获取交易记录失败' };
  }
};
