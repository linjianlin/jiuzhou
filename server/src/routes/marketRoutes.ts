import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requireCharacter } from '../middleware/auth.js';
import { createQpsLimitMiddleware } from '../middleware/qpsLimit.js';
import { marketService, type MarketSort } from '../services/marketService.js';
import { partnerMarketService, type PartnerMarketSort } from '../services/partnerMarketService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult } from '../middleware/response.js';

const router = Router();

const MARKET_QPS_WINDOW_MS = 1000;
const MARKET_QUERY_QPS_LIMIT = 5;
const MARKET_MUTATION_QPS_LIMIT = 2;
const MARKET_QPS_LIMIT_MESSAGE = '坊市请求过于频繁，请稍后再试';

const createMarketQpsLimit = (routeKey: string, limit: number) => createQpsLimitMiddleware({
  keyPrefix: `qps:market:${routeKey}`,
  limit,
  windowMs: MARKET_QPS_WINDOW_MS,
  message: MARKET_QPS_LIMIT_MESSAGE,
  resolveScope: (req) => req.userId!,
});

const marketListingsQpsLimit = createMarketQpsLimit('listings', MARKET_QUERY_QPS_LIMIT);
const marketMyListingsQpsLimit = createMarketQpsLimit('my-listings', MARKET_QUERY_QPS_LIMIT);
const marketRecordsQpsLimit = createMarketQpsLimit('records', MARKET_QUERY_QPS_LIMIT);
const marketListMutationQpsLimit = createMarketQpsLimit('list', MARKET_MUTATION_QPS_LIMIT);
const marketCancelMutationQpsLimit = createMarketQpsLimit('cancel', MARKET_MUTATION_QPS_LIMIT);
const marketBuyMutationQpsLimit = createMarketQpsLimit('buy', MARKET_MUTATION_QPS_LIMIT);
const partnerMarketListingsQpsLimit = createMarketQpsLimit('partner-listings', MARKET_QUERY_QPS_LIMIT);
const partnerMarketMyListingsQpsLimit = createMarketQpsLimit('partner-my-listings', MARKET_QUERY_QPS_LIMIT);
const partnerMarketRecordsQpsLimit = createMarketQpsLimit('partner-records', MARKET_QUERY_QPS_LIMIT);
const partnerMarketListMutationQpsLimit = createMarketQpsLimit('partner-list', MARKET_MUTATION_QPS_LIMIT);
const partnerMarketCancelMutationQpsLimit = createMarketQpsLimit('partner-cancel', MARKET_MUTATION_QPS_LIMIT);
const partnerMarketBuyMutationQpsLimit = createMarketQpsLimit('partner-buy', MARKET_MUTATION_QPS_LIMIT);

const parseQueryNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
};

router.get('/listings', requireAuth, marketListingsQpsLimit, asyncHandler(async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const quality = typeof req.query.quality === 'string' ? req.query.quality : undefined;
    const queryText = typeof req.query.query === 'string' ? req.query.query : undefined;
    const sort = typeof req.query.sort === 'string' ? (req.query.sort as MarketSort) : undefined;
    const minPrice = parseQueryNumber(req.query.minPrice);
    const maxPrice = parseQueryNumber(req.query.maxPrice);
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await marketService.getMarketListings({
      category,
      quality,
      query: queryText,
      sort,
      minPrice,
      maxPrice,
      page,
      pageSize,
    });

    return sendResult(res, result);
}));

router.get('/my-listings', requireCharacter, marketMyListingsQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await marketService.getMyMarketListings({ characterId, status, page, pageSize });
    return sendResult(res, result);
}));

router.get('/records', requireCharacter, marketRecordsQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);
    const result = await marketService.getMarketTradeRecords({ characterId, page, pageSize });
    return sendResult(res, result);
}));

router.post('/list', requireCharacter, marketListMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { itemInstanceId, qty, unitPriceSpiritStones } = req.body as {
      itemInstanceId?: unknown;
      qty?: unknown;
      unitPriceSpiritStones?: unknown;
    };

    const result = await marketService.createMarketListing({
      userId,
      characterId,
      itemInstanceId: Number(itemInstanceId),
      qty: Number(qty),
      unitPriceSpiritStones: Number(unitPriceSpiritStones),
    });

    return sendResult(res, result);
}));

router.post('/cancel', requireCharacter, marketCancelMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { listingId } = req.body as { listingId?: unknown };
    const result = await marketService.cancelMarketListing({ userId, characterId, listingId: Number(listingId) });
    return sendResult(res, result);
}));

router.post('/buy', requireCharacter, marketBuyMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { listingId, qty } = req.body as { listingId?: unknown; qty?: unknown };
    const result = await marketService.buyMarketListing({
      buyerUserId: userId,
      buyerCharacterId: characterId,
      listingId: Number(listingId),
      qty: Number(qty),
    });
    return sendResult(res, result);
}));

router.get('/partner-listings', requireAuth, partnerMarketListingsQpsLimit, asyncHandler(async (req, res) => {
    const quality = typeof req.query.quality === 'string' ? req.query.quality : undefined;
    const element = typeof req.query.element === 'string' ? req.query.element : undefined;
    const queryText = typeof req.query.query === 'string' ? req.query.query : undefined;
    const sort = typeof req.query.sort === 'string' ? (req.query.sort as PartnerMarketSort) : undefined;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await partnerMarketService.getPartnerListings({
      quality,
      element,
      query: queryText,
      sort,
      page,
      pageSize,
    });
    return sendResult(res, result);
}));

router.get('/partner-my-listings', requireCharacter, partnerMarketMyListingsQpsLimit, asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await partnerMarketService.getMyPartnerListings({
      characterId,
      status,
      page,
      pageSize,
    });
    return sendResult(res, result);
}));

router.get('/partner-records', requireCharacter, partnerMarketRecordsQpsLimit, asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await partnerMarketService.getPartnerTradeRecords({
      characterId,
      page,
      pageSize,
    });
    return sendResult(res, result);
}));

router.post('/partner/list', requireCharacter, partnerMarketListMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const { partnerId, unitPriceSpiritStones } = req.body as {
      partnerId?: unknown;
      unitPriceSpiritStones?: unknown;
    };

    const result = await partnerMarketService.createPartnerListing({
      userId,
      characterId,
      partnerId: Number(partnerId),
      unitPriceSpiritStones: Number(unitPriceSpiritStones),
    });
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return sendResult(res, result);
}));

router.post('/partner/cancel', requireCharacter, partnerMarketCancelMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const { listingId } = req.body as { listingId?: unknown };

    const result = await partnerMarketService.cancelPartnerListing({
      characterId,
      listingId: Number(listingId),
    });
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return sendResult(res, result);
}));

router.post('/partner/buy', requireCharacter, partnerMarketBuyMutationQpsLimit, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const { listingId } = req.body as { listingId?: unknown };

    const result = await partnerMarketService.buyPartnerListing({
      buyerUserId: userId,
      buyerCharacterId: characterId,
      listingId: Number(listingId),
    });
    if (result.success) {
      await safePushCharacterUpdate(userId);
      const sellerUserId = result.data?.sellerUserId ?? null;
      if (sellerUserId !== null && sellerUserId !== userId) {
        await safePushCharacterUpdate(sellerUserId);
      }
    }
    return sendResult(res, result);
}));

export default router;
