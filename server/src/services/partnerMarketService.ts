/**
 * 伙伴坊市服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：处理伙伴坊市挂单查询、上架、下架、购买与交易记录。
 * 2. 做什么：把伙伴交易与物品交易彻底分层，避免把伙伴实例硬塞进 `item_instance / market_listing` 链路。
 * 3. 不做什么：不处理路由层参数解析，不负责前端事件派发，也不处理物品坊市逻辑。
 *
 * 输入/输出：
 * - 输入：买卖双方角色/用户 ID、伙伴 ID、价格、筛选条件。
 * - 输出：伙伴坊市 DTO、标准 `{ success, message, data }` 结果。
 *
 * 数据流/状态流：
 * - route -> partnerMarketService -> partnerView / market shared rules / SQL -> DTO -> route 推送角色刷新。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴交易的是完整实例，因此购买时只能转移 `character_partner` 所有权，绝不能重建新伙伴或丢失已学功法。
 * 2. 出战伙伴严禁上架，且成交后必须强制 `is_active = FALSE`，避免队伍状态残留在新主人身上。
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { createCacheLayer } from './shared/cacheLayer.js';
import {
  createCacheVersionManager,
  parseVersionedCacheBaseKey,
} from './shared/cacheVersion.js';
import {
  buildPartnerDisplay,
  loadPartnerTechniqueRows,
  loadSinglePartnerRow,
  loadSinglePartnerRowById,
  normalizeInteger,
  normalizeText,
  toPartnerBaseAttrsDto,
  type PartnerDisplayDto,
} from './shared/partnerView.js';
import type { PartnerOwnerRealmContext } from './shared/partnerLevelLimit.js';
import {
  calculateMarketListingFeeSilver,
  calculateMarketTradeTotalPrice,
  getTaxAmount,
} from './shared/marketListingPurchaseShared.js';
import { parsePositiveInt } from './shared/httpParam.js';
import { loadActivePartnerMarketListing } from './shared/partnerMarketState.js';
import { loadActivePartnerFusionMaterial } from './shared/partnerFusionState.js';
import { getPartnerDefinitionById } from './staticConfigLoader.js';

export type PartnerMarketSort = 'timeDesc' | 'priceAsc' | 'priceDesc' | 'levelDesc';

export interface MarketPartnerListingDto {
  id: number;
  partner: PartnerDisplayDto;
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
}

export interface MarketPartnerTradeRecordDto {
  id: number;
  type: '买入' | '卖出';
  partner: PartnerDisplayDto;
  unitPriceSpiritStones: number;
  totalPriceSpiritStones: number;
  counterparty: string;
  time: number;
}

type PartnerListingsQuery = {
  quality: string;
  element: string;
  query: string;
  sort: PartnerMarketSort;
  page: number;
  pageSize: number;
};

type PartnerListingsCacheData = {
  listings: MarketPartnerListingDto[];
  total: number;
};

type PartnerListingRow = {
  id: number;
  partner_snapshot: PartnerDisplayDto | null;
  unit_price_spirit_stones: number | string | bigint;
  seller_character_id: number;
  seller_name: string;
  listed_at: Date | string;
};

type PartnerTradeRecordRow = {
  id: number;
  partner_snapshot: PartnerDisplayDto | null;
  unit_price_spirit_stones: number | string | bigint;
  total_price_spirit_stones: number | string | bigint;
  buyer_character_id: number;
  buyer_name: string;
  seller_name: string;
  created_at: Date | string;
};

type CharacterWalletRow = {
  id: number;
  user_id: number;
  spirit_stones: number | string | bigint;
  silver: number | string | bigint;
};

const PARTNER_MARKET_TAX_RATE = 0;
const PARTNER_MARKET_LISTINGS_CACHE_REDIS_TTL_SEC = 8;
const PARTNER_MARKET_LISTINGS_CACHE_MEMORY_TTL_MS = 2_000;

const clampInt = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

const parseMaybeString = (v: string | null | undefined): string =>
  (typeof v === 'string' ? v : '').trim();

const partnerMarketListingsCacheVersion = createCacheVersionManager('partner-market:listings');

const invalidatePartnerMarketListingsCache = async (): Promise<void> => {
  await partnerMarketListingsCacheVersion.bumpVersion();
  partnerMarketListingsCache.invalidateAll();
};

const readPartnerSnapshot = async (snapshot: PartnerDisplayDto | null): Promise<PartnerDisplayDto | null> => {
  if (!snapshot) return null;
  if (!Number.isInteger(snapshot.id) || snapshot.id <= 0) return null;
  const partnerDefId = normalizeText(snapshot.partnerDefId);
  if (!partnerDefId) return null;
  const definition = await getPartnerDefinitionById(partnerDefId);
  if (!definition) return null;
  return {
    ...snapshot,
    levelAttrGains: toPartnerBaseAttrsDto(definition.level_attr_gains),
  };
};

const buildListingDto = async (row: PartnerListingRow): Promise<MarketPartnerListingDto | null> => {
  const partner = await readPartnerSnapshot(row.partner_snapshot);
  if (!partner) return null;
  return {
    id: Number(row.id),
    partner,
    unitPriceSpiritStones: Number(row.unit_price_spirit_stones),
    sellerCharacterId: Number(row.seller_character_id),
    sellerName: String(row.seller_name ?? ''),
    listedAt: new Date(String(row.listed_at ?? '')).getTime(),
  };
};

const normalizePartnerListingsQuery = (params: {
  quality?: string;
  element?: string;
  query?: string;
  sort?: PartnerMarketSort;
  page?: number;
  pageSize?: number;
}): PartnerListingsQuery => {
  return {
    quality: parseMaybeString(params.quality),
    element: parseMaybeString(params.element),
    query: parseMaybeString(params.query),
    sort: params.sort ?? 'timeDesc',
    page: clampInt(parsePositiveInt(params.page) ?? 1, 1, 1_000_000),
    pageSize: clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100),
  };
};

const loadPartnerListingsCacheData = async (
  params: PartnerListingsQuery,
): Promise<PartnerListingsCacheData> => {
  const offset = (params.page - 1) * params.pageSize;
  const where: string[] = [`mpl.status = 'active'`];
  const values: Array<string | number> = [];

  if (params.quality && params.quality !== 'all') {
    values.push(params.quality);
    where.push(`mpl.partner_quality = $${values.length}`);
  }
  if (params.element && params.element !== 'all') {
    values.push(params.element);
    where.push(`mpl.partner_element = $${values.length}`);
  }
  if (params.query) {
    values.push(`%${params.query}%`);
    const searchParam = `$${values.length}`;
    where.push(
      `(mpl.partner_name ILIKE ${searchParam} OR mpl.partner_nickname ILIKE ${searchParam} OR seller.nickname ILIKE ${searchParam})`,
    );
  }

  const orderBy =
    params.sort === 'priceAsc'
      ? 'mpl.unit_price_spirit_stones ASC, mpl.listed_at DESC'
      : params.sort === 'priceDesc'
        ? 'mpl.unit_price_spirit_stones DESC, mpl.listed_at DESC'
        : params.sort === 'levelDesc'
          ? 'mpl.partner_level DESC, mpl.listed_at DESC'
          : 'mpl.listed_at DESC';

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  values.push(params.pageSize);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;

  const listSql = `
    SELECT
      mpl.id,
      mpl.partner_snapshot,
      mpl.unit_price_spirit_stones,
      mpl.seller_character_id,
      seller.nickname AS seller_name,
      mpl.listed_at
    FROM market_partner_listing mpl
    JOIN characters seller ON seller.id = mpl.seller_character_id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;
  const countSql = `
    SELECT COUNT(*)::int AS cnt
    FROM market_partner_listing mpl
    JOIN characters seller ON seller.id = mpl.seller_character_id
    ${whereSql}
  `;

  const [listResult, countResult] = await Promise.all([
    query(listSql, values),
    query(countSql, values.slice(0, values.length - 2)),
  ]);

  const listings = (await Promise.all((listResult.rows as PartnerListingRow[])
    .map((row) => buildListingDto(row))))
    .filter((row): row is MarketPartnerListingDto => row !== null);

  return {
    listings,
    total: Number(countResult.rows[0]?.cnt ?? 0),
  };
};

const partnerMarketListingsCache = createCacheLayer<string, PartnerListingsCacheData>({
  keyPrefix: 'partner-market:listings:',
  redisTtlSec: PARTNER_MARKET_LISTINGS_CACHE_REDIS_TTL_SEC,
  memoryTtlMs: PARTNER_MARKET_LISTINGS_CACHE_MEMORY_TTL_MS,
  loader: async (versionedKey) => {
    const queryParams = parseVersionedCacheBaseKey<PartnerListingsQuery>(versionedKey);
    if (!queryParams) return null;
    return loadPartnerListingsCacheData(queryParams);
  },
});

const buildTradeRecordDto = async (
  row: PartnerTradeRecordRow,
  viewerCharacterId: number,
): Promise<MarketPartnerTradeRecordDto | null> => {
  const partner = await readPartnerSnapshot(row.partner_snapshot);
  if (!partner) return null;
  const buyerCharacterId = Number(row.buyer_character_id);
  const type: '买入' | '卖出' =
    buyerCharacterId === viewerCharacterId ? '买入' : '卖出';
  return {
    id: Number(row.id),
    type,
    partner,
    unitPriceSpiritStones: Number(row.unit_price_spirit_stones),
    totalPriceSpiritStones: Number(row.total_price_spirit_stones),
    counterparty:
      type === '买入'
        ? String(row.seller_name ?? '')
        : String(row.buyer_name ?? ''),
    time: new Date(String(row.created_at ?? '')).getTime(),
  };
};

const buildPartnerSnapshot = async (partnerId: number): Promise<PartnerDisplayDto> => {
  const partnerRow = await loadSinglePartnerRowById(partnerId, false);
  if (!partnerRow) {
    throw new Error('伙伴不存在');
  }
  const ownerRealmResult = await query(
    `
      SELECT realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [partnerRow.character_id],
  );
  if (ownerRealmResult.rows.length <= 0) {
    throw new Error(`伙伴所属角色不存在: ${partnerRow.character_id}`);
  }
  const definition = await getPartnerDefinitionById(partnerRow.partner_def_id);
  if (!definition) {
    throw new Error(`伙伴模板不存在: ${partnerRow.partner_def_id}`);
  }
  const techniqueMap = await loadPartnerTechniqueRows([partnerId], false);
  const ownerRealmRow = ownerRealmResult.rows[0] as { realm: string | null; sub_realm: string | null };
  const ownerRealm: PartnerOwnerRealmContext = {
    realm: normalizeText(ownerRealmRow.realm) || '凡人',
    subRealm: normalizeText(ownerRealmRow.sub_realm) || null,
  };
  return buildPartnerDisplay({
    row: partnerRow,
    definition,
    techniqueRows: techniqueMap.get(partnerId) ?? [],
    ownerRealm,
  });
};

const loadCharacterWallet = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterWalletRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, user_id, spirit_stones, silver
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as CharacterWalletRow;
};

class PartnerMarketService {
  async getPartnerListings(params: {
    quality?: string;
    element?: string;
    query?: string;
    sort?: PartnerMarketSort;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listings: MarketPartnerListingDto[]; total: number };
  }> {
    const normalizedQuery = normalizePartnerListingsQuery(params);
    const versionedKey = await partnerMarketListingsCacheVersion.buildVersionedKey(
      JSON.stringify(normalizedQuery),
    );
    const data = (await partnerMarketListingsCache.get(versionedKey)) ?? {
      listings: [],
      total: 0,
    };
    return {
      success: true,
      message: 'ok',
      data,
    };
  }

  async getMyPartnerListings(params: {
    characterId: number;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listings: MarketPartnerListingDto[]; total: number };
  }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1_000_000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;
    const status = parseMaybeString(params.status) || 'active';

    const listResult = await query(
      `
        SELECT
          mpl.id,
          mpl.partner_snapshot,
          mpl.unit_price_spirit_stones,
          mpl.seller_character_id,
          seller.nickname AS seller_name,
          mpl.listed_at
        FROM market_partner_listing mpl
        JOIN characters seller ON seller.id = mpl.seller_character_id
        WHERE mpl.seller_character_id = $1
          AND mpl.status = $2
        ORDER BY mpl.listed_at DESC
        LIMIT $3 OFFSET $4
      `,
      [params.characterId, status, pageSize, offset],
    );
    const countResult = await query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM market_partner_listing
        WHERE seller_character_id = $1
          AND status = $2
      `,
      [params.characterId, status],
    );

    const listings = (await Promise.all((listResult.rows as PartnerListingRow[])
      .map((row) => buildListingDto(row))))
      .filter((row): row is MarketPartnerListingDto => row !== null);

    return {
      success: true,
      message: 'ok',
      data: {
        listings,
        total: Number(countResult.rows[0]?.cnt ?? 0),
      },
    };
  }

  async getPartnerTradeRecords(params: {
    characterId: number;
    page?: number;
    pageSize?: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { records: MarketPartnerTradeRecordDto[]; total: number };
  }> {
    const page = clampInt(parsePositiveInt(params.page) ?? 1, 1, 1_000_000);
    const pageSize = clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, 100);
    const offset = (page - 1) * pageSize;

    const listResult = await query(
      `
        SELECT
          tr.id,
          tr.partner_snapshot,
          tr.unit_price_spirit_stones,
          tr.total_price_spirit_stones,
          tr.buyer_character_id,
          buyer.nickname AS buyer_name,
          seller.nickname AS seller_name,
          tr.created_at
        FROM market_partner_trade_record tr
        JOIN characters buyer ON buyer.id = tr.buyer_character_id
        JOIN characters seller ON seller.id = tr.seller_character_id
        WHERE tr.buyer_character_id = $1 OR tr.seller_character_id = $1
        ORDER BY tr.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [params.characterId, pageSize, offset],
    );
    const countResult = await query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM market_partner_trade_record
        WHERE buyer_character_id = $1 OR seller_character_id = $1
      `,
      [params.characterId],
    );

    const records = (await Promise.all((listResult.rows as PartnerTradeRecordRow[])
      .map((row) => buildTradeRecordDto(row, params.characterId))))
      .filter((row): row is MarketPartnerTradeRecordDto => row !== null);

    return {
      success: true,
      message: 'ok',
      data: {
        records,
        total: Number(countResult.rows[0]?.cnt ?? 0),
      },
    };
  }

  @Transactional
  async createPartnerListing(params: {
    userId: number;
    characterId: number;
    partnerId: number;
    unitPriceSpiritStones: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: { listingId: number };
  }> {
    const partnerId = parsePositiveInt(params.partnerId);
    const unitPrice = parsePositiveInt(params.unitPriceSpiritStones);
    if (partnerId === null) return { success: false, message: 'partnerId参数错误' };
    if (unitPrice === null) {
      return { success: false, message: 'unitPriceSpiritStones参数错误' };
    }

    const seller = await loadCharacterWallet(params.characterId, true);
    if (!seller) return { success: false, message: '角色不存在' };
    if (Number(seller.user_id) !== params.userId) {
      return { success: false, message: '角色归属异常' };
    }

    const partnerRow = await loadSinglePartnerRow(params.characterId, partnerId, true);
    if (!partnerRow) return { success: false, message: '伙伴不存在' };
    if (partnerRow.is_active) {
      return { success: false, message: '出战中的伙伴不可上架' };
    }
    if (await loadActivePartnerFusionMaterial(partnerId, true)) {
      return { success: false, message: '归契中的伙伴不可上架' };
    }
    const activeListing = await loadActivePartnerMarketListing(partnerId, true);
    if (activeListing) {
      return { success: false, message: '该伙伴已在坊市挂单中' };
    }

    const snapshot = await buildPartnerSnapshot(partnerId);
    const totalPrice = calculateMarketTradeTotalPrice(BigInt(unitPrice), 1);
    const listingFeeSilver = calculateMarketListingFeeSilver(totalPrice);
    const sellerSilver = BigInt(seller.silver ?? 0);
    if (sellerSilver < listingFeeSilver) {
      return {
        success: false,
        message: `银两不足，上架手续费需要${listingFeeSilver.toString()}`,
      };
    }

    if (listingFeeSilver > 0n) {
      await query(
        `
          UPDATE characters
          SET silver = silver - $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [listingFeeSilver.toString(), params.characterId],
      );
    }

    const listingResult = await query(
      `
        INSERT INTO market_partner_listing (
          seller_user_id,
          seller_character_id,
          partner_id,
          partner_snapshot,
          partner_def_id,
          partner_name,
          partner_nickname,
          partner_quality,
          partner_element,
          partner_level,
          unit_price_spirit_stones,
          listing_fee_silver,
          status
        )
        VALUES (
          $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, 'active'
        )
        RETURNING id
      `,
      [
        params.userId,
        params.characterId,
        partnerId,
        JSON.stringify(snapshot),
        snapshot.partnerDefId,
        snapshot.name,
        snapshot.nickname,
        snapshot.quality,
        snapshot.element,
        snapshot.level,
        unitPrice,
        listingFeeSilver.toString(),
      ],
    );

    await invalidatePartnerMarketListingsCache();
    return {
      success: true,
      message: `上架成功，已收取${listingFeeSilver.toString()}银两手续费（未卖出下架将退还）`,
      data: {
        listingId: Number(listingResult.rows[0]?.id ?? 0),
      },
    };
  }

  @Transactional
  async cancelPartnerListing(params: {
    characterId: number;
    listingId: number;
  }): Promise<{ success: boolean; message: string }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null) return { success: false, message: 'listingId参数错误' };

    const seller = await loadCharacterWallet(params.characterId, true);
    if (!seller) return { success: false, message: '角色不存在' };

    const listingResult = await query(
      `
        SELECT id, seller_character_id, status, listing_fee_silver
        FROM market_partner_listing
        WHERE id = $1
        FOR UPDATE
      `,
      [listingId],
    );
    if (listingResult.rows.length <= 0) {
      return { success: false, message: '上架记录不存在' };
    }
    const listing = listingResult.rows[0] as {
      id: number;
      seller_character_id: number;
      status: string;
      listing_fee_silver: string | number | bigint;
    };
    if (Number(listing.seller_character_id) !== params.characterId) {
      return { success: false, message: '无权限操作该上架记录' };
    }
    if (String(listing.status) !== 'active') {
      return { success: false, message: '该上架记录不可下架' };
    }

    await query(
      `
        UPDATE market_partner_listing
        SET status = 'cancelled',
            cancelled_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [listingId],
    );

    const refundFeeSilver = BigInt(listing.listing_fee_silver ?? 0);
    if (refundFeeSilver > 0n) {
      await query(
        `
          UPDATE characters
          SET silver = silver + $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [refundFeeSilver.toString(), params.characterId],
      );
    }

    await invalidatePartnerMarketListingsCache();
    return {
      success: true,
      message: `下架成功，已退还${refundFeeSilver.toString()}银两手续费`,
    };
  }

  @Transactional
  async buyPartnerListing(params: {
    buyerUserId: number;
    buyerCharacterId: number;
    listingId: number;
  }): Promise<{
    success: boolean;
    message: string;
    data?: {
      sellerUserId: number;
    };
  }> {
    const listingId = parsePositiveInt(params.listingId);
    if (listingId === null) return { success: false, message: 'listingId参数错误' };

    const listingResult = await query(
      `
        SELECT seller_character_id
        FROM market_partner_listing
        WHERE id = $1
      `,
      [listingId],
    );
    if (listingResult.rows.length <= 0) {
      return { success: false, message: '上架记录不存在' };
    }
    const sellerCharacterId = Number(listingResult.rows[0]?.seller_character_id ?? 0);
    if (!Number.isInteger(sellerCharacterId) || sellerCharacterId <= 0) {
      return { success: false, message: '上架数据异常' };
    }
    if (sellerCharacterId === params.buyerCharacterId) {
      return { success: false, message: '不能购买自己上架的伙伴' };
    }

    const [buyerLockId, sellerLockId] =
      params.buyerCharacterId < sellerCharacterId
        ? [params.buyerCharacterId, sellerCharacterId]
        : [sellerCharacterId, params.buyerCharacterId];
    const firstCharacter = await loadCharacterWallet(buyerLockId, true);
    const secondCharacter = await loadCharacterWallet(sellerLockId, true);
    if (!firstCharacter || !secondCharacter) {
      return { success: false, message: '角色不存在' };
    }

    const buyer =
      Number(firstCharacter.id) === params.buyerCharacterId
        ? firstCharacter
        : secondCharacter;
    const seller =
      Number(firstCharacter.id) === sellerCharacterId
        ? firstCharacter
        : secondCharacter;
    if (!buyer || !seller) {
      return { success: false, message: '角色不存在' };
    }

    const lockedListingResult = await query(
      `
        SELECT
          id,
          seller_user_id,
          seller_character_id,
          partner_id,
          status,
          unit_price_spirit_stones
        FROM market_partner_listing
        WHERE id = $1
        FOR UPDATE
      `,
      [listingId],
    );
    if (lockedListingResult.rows.length <= 0) {
      return { success: false, message: '上架记录不存在' };
    }
    const lockedListing = lockedListingResult.rows[0] as {
      id: number;
      seller_user_id: number;
      seller_character_id: number;
      partner_id: number;
      status: string;
      unit_price_spirit_stones: string | number | bigint;
    };
    if (String(lockedListing.status) !== 'active') {
      return { success: false, message: '该伙伴已被购买或下架' };
    }
    if (Number(lockedListing.seller_character_id) !== sellerCharacterId) {
      return { success: false, message: '上架数据异常，请刷新后重试' };
    }

    const partnerId = Number(lockedListing.partner_id);
    const partnerRow = await loadSinglePartnerRowById(partnerId, true);
    if (!partnerRow) return { success: false, message: '伙伴不存在' };
    if (Number(partnerRow.character_id) !== sellerCharacterId) {
      return { success: false, message: '伙伴归属异常，请刷新后重试' };
    }
    if (partnerRow.is_active) {
      return { success: false, message: '出战中的伙伴不可交易' };
    }
    if (await loadActivePartnerFusionMaterial(partnerId, true)) {
      return { success: false, message: '归契中的伙伴不可交易' };
    }

    const totalPrice = calculateMarketTradeTotalPrice(
      BigInt(lockedListing.unit_price_spirit_stones),
      1,
    );
    const taxAmount = getTaxAmount(totalPrice, PARTNER_MARKET_TAX_RATE);
    const sellerGain = totalPrice - taxAmount;
    const buyerStones = BigInt(buyer.spirit_stones ?? 0);
    if (buyerStones < totalPrice) {
      return {
        success: false,
        message: `灵石不足，需要${totalPrice.toString()}`,
      };
    }

    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones - $1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [totalPrice.toString(), params.buyerCharacterId],
    );
    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones + $1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [sellerGain.toString(), sellerCharacterId],
    );

    await query(
      `
        UPDATE character_partner
        SET character_id = $1,
            is_active = FALSE,
            updated_at = NOW()
        WHERE id = $2
      `,
      [params.buyerCharacterId, partnerId],
    );

    const soldSnapshot = await buildPartnerSnapshot(partnerId);

    await query(
      `
        UPDATE market_partner_listing
        SET status = 'sold',
            buyer_user_id = $1,
            buyer_character_id = $2,
            partner_snapshot = $3::jsonb,
            sold_at = NOW(),
            updated_at = NOW()
        WHERE id = $4
      `,
      [
        params.buyerUserId,
        params.buyerCharacterId,
        JSON.stringify(soldSnapshot),
        listingId,
      ],
    );

    await query(
      `
        INSERT INTO market_partner_trade_record (
          listing_id,
          buyer_user_id,
          buyer_character_id,
          seller_user_id,
          seller_character_id,
          partner_id,
          partner_def_id,
          partner_snapshot,
          unit_price_spirit_stones,
          total_price_spirit_stones,
          tax_spirit_stones
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
        )
      `,
      [
        listingId,
        params.buyerUserId,
        params.buyerCharacterId,
        Number(lockedListing.seller_user_id),
        sellerCharacterId,
        partnerId,
        soldSnapshot.partnerDefId,
        JSON.stringify(soldSnapshot),
        totalPrice.toString(),
        totalPrice.toString(),
        taxAmount.toString(),
      ],
    );

    await invalidatePartnerMarketListingsCache();
    return {
      success: true,
      message: '购买成功，伙伴已转入麾下',
      data: {
        sellerUserId: Number(lockedListing.seller_user_id),
      },
    };
  }
}

export const partnerMarketService = new PartnerMarketService();
export default partnerMarketService;
