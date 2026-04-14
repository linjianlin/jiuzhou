import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requireCharacter } from '../middleware/auth.js';
import { requirePartnerMarketBuyTicket } from '../middleware/requirePartnerMarketBuyTicket.js';
import { requireItemMarketBuyTicket } from '../middleware/requireItemMarketBuyTicket.js';
import { requireMarketPurchaseAttemptGuard } from '../middleware/requireMarketPurchaseAttemptGuard.js';
import { requireMarketPurchaseTencentCaptcha } from '../middleware/requireMarketPurchaseTencentCaptcha.js';
import { createQpsLimitMiddleware } from '../middleware/qpsLimit.js';
import { requireMarketPhoneBinding } from '../middleware/requireMarketPhoneBinding.js';
import { marketService, type MarketSort } from '../services/marketService.js';
import {
  consumeMarketBuyTicket,
  consumePartnerMarketBuyTicket,
  issueMarketBuyTickets,
  issuePartnerMarketBuyTickets,
} from '../services/marketRiskService.js';
import { partnerMarketService, type PartnerMarketSort } from '../services/partnerMarketService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult, sendSuccess } from '../middleware/response.js';
import { isMarketPurchaseTencentCaptchaEnabled, marketPurchaseTencentCaptchaConfig } from '../config/captchaConfig.js';
import { getSingleQueryValue, parseFiniteNumber, parseNonEmptyText } from '../services/shared/httpParam.js';

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
const partnerMarketTechniqueDetailQpsLimit = createMarketQpsLimit('partner-technique-detail', MARKET_QUERY_QPS_LIMIT);
const partnerMarketListMutationQpsLimit = createMarketQpsLimit('partner-list', MARKET_MUTATION_QPS_LIMIT);
const partnerMarketCancelMutationQpsLimit = createMarketQpsLimit('partner-cancel', MARKET_MUTATION_QPS_LIMIT);
const partnerMarketBuyMutationQpsLimit = createMarketQpsLimit('partner-buy', MARKET_MUTATION_QPS_LIMIT);
const marketAuthGuards = [requireAuth, requireMarketPhoneBinding];
const marketCharacterGuards = [requireCharacter, requireMarketPhoneBinding];

router.get('/listings', ...marketAuthGuards, marketListingsQpsLimit, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const category = parseNonEmptyText(getSingleQueryValue(req.query.category)) ?? undefined;
  const quality = parseNonEmptyText(getSingleQueryValue(req.query.quality)) ?? undefined;
  const queryText = parseNonEmptyText(getSingleQueryValue(req.query.query)) ?? undefined;
  const sortRaw = getSingleQueryValue(req.query.sort);
  const sort = sortRaw ? (sortRaw as MarketSort) : undefined;
  const minPrice = parseFiniteNumber(getSingleQueryValue(req.query.minPrice));
  const maxPrice = parseFiniteNumber(getSingleQueryValue(req.query.maxPrice));
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));
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
  if (result.success && result.data) {
    const ticketByListingId = await issueMarketBuyTickets({
      scene: 'item',
      userId,
      listingIds: result.data.listings.map((listing) => listing.id),
    });
    result.data = {
      ...result.data,
      listings: result.data.listings.map((listing) => ({
        ...listing,
        buyTicket: ticketByListingId.get(listing.id) ?? null,
      })),
    };
  }

  return sendResult(res, result);
}));

router.get('/captcha/config', ...marketAuthGuards, asyncHandler(async (_req, res) => {
  return sendSuccess(res, {
    enabled: isMarketPurchaseTencentCaptchaEnabled,
    ...(isMarketPurchaseTencentCaptchaEnabled
      ? { tencentAppId: marketPurchaseTencentCaptchaConfig.appId }
      : {}),
  });
}));

router.get('/my-listings', ...marketCharacterGuards, marketMyListingsQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const status = parseNonEmptyText(getSingleQueryValue(req.query.status)) ?? undefined;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));

  const result = await marketService.getMyMarketListings({ characterId, status, page, pageSize });
  return sendResult(res, result);
}));

router.get('/records', ...marketCharacterGuards, marketRecordsQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));
  const result = await marketService.getMarketTradeRecords({ characterId, page, pageSize });
  return sendResult(res, result);
}));

router.post('/list', ...marketCharacterGuards, marketListMutationQpsLimit, asyncHandler(async (req, res) => {
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
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  return sendResult(res, result);
}));

router.post('/cancel', ...marketCharacterGuards, marketCancelMutationQpsLimit, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;

  const { listingId } = req.body as { listingId?: unknown };
  const result = await marketService.cancelMarketListing({ userId, characterId, listingId: Number(listingId) });
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.post('/buy', ...marketCharacterGuards, marketBuyMutationQpsLimit, requireItemMarketBuyTicket, requireMarketPurchaseAttemptGuard, requireMarketPurchaseTencentCaptcha, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;

  const { listingId, qty } = req.body as { listingId?: unknown; qty?: unknown };
  const result = await marketService.buyMarketListing({
    buyerUserId: userId,
    buyerCharacterId: characterId,
    listingId: Number(listingId),
    qty: Number(qty),
  });
  if (result.success) {
    const sellerUserId = result.data?.sellerUserId ?? null;
    await consumeMarketBuyTicket('item', req.marketRiskContext?.buyTicket ?? '');

    await safePushCharacterUpdate(userId);
    if (sellerUserId !== null && sellerUserId !== userId) {
      await safePushCharacterUpdate(sellerUserId);
    }
  }
  return sendResult(res, result);
}));

router.get('/partner-listings', ...marketAuthGuards, partnerMarketListingsQpsLimit, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const quality = parseNonEmptyText(getSingleQueryValue(req.query.quality)) ?? undefined;
  const element = parseNonEmptyText(getSingleQueryValue(req.query.element)) ?? undefined;
  const queryText = parseNonEmptyText(getSingleQueryValue(req.query.query)) ?? undefined;
  const sortRaw = getSingleQueryValue(req.query.sort);
  const sort = sortRaw ? (sortRaw as PartnerMarketSort) : undefined;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));
  const result = await partnerMarketService.getPartnerListings({
    quality,
    element,
    query: queryText,
    sort,
    page,
    pageSize,
  });
  if (result.success && result.data) {
    const ticketByListingId = await issuePartnerMarketBuyTickets({
      userId,
      listingIds: result.data.listings.map((listing) => listing.id),
    });
    result.data = {
      ...result.data,
      listings: result.data.listings.map((listing) => ({
        ...listing,
        buyTicket: ticketByListingId.get(listing.id) ?? null,
      })),
    };
  }
  return sendResult(res, result);
}));

router.get('/partner-my-listings', ...marketCharacterGuards, partnerMarketMyListingsQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const status = parseNonEmptyText(getSingleQueryValue(req.query.status)) ?? undefined;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));

  const result = await partnerMarketService.getMyPartnerListings({
    characterId,
    status,
    page,
    pageSize,
  });
  return sendResult(res, result);
}));

router.get('/partner-records', ...marketCharacterGuards, partnerMarketRecordsQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const pageSize = parseFiniteNumber(getSingleQueryValue(req.query.pageSize));

  const result = await partnerMarketService.getPartnerTradeRecords({
    characterId,
    page,
    pageSize,
  });
  return sendResult(res, result);
}));

router.get('/partner/technique-detail', ...marketCharacterGuards, partnerMarketTechniqueDetailQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const listingId = parseFiniteNumber(getSingleQueryValue(req.query.listingId));
  const techniqueId = parseNonEmptyText(getSingleQueryValue(req.query.techniqueId));
  if (!listingId) {
    sendResult(res, { success: false, message: 'listingId 参数无效' });
    return;
  }
  if (!techniqueId) {
    sendResult(res, { success: false, message: 'techniqueId 参数无效' });
    return;
  }

  const result = await partnerMarketService.getPartnerTechniqueDetail({
    characterId,
    listingId,
    techniqueId,
  });
  return sendResult(res, result);
}));

router.post('/partner/list', ...marketCharacterGuards, partnerMarketListMutationQpsLimit, asyncHandler(async (req, res) => {
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

router.post('/partner/cancel', ...marketCharacterGuards, partnerMarketCancelMutationQpsLimit, asyncHandler(async (req, res) => {
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

router.post('/partner/buy', ...marketCharacterGuards, partnerMarketBuyMutationQpsLimit, requirePartnerMarketBuyTicket, requireMarketPurchaseAttemptGuard, requireMarketPurchaseTencentCaptcha, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const { listingId } = req.body as { listingId?: unknown };

  const result = await partnerMarketService.buyPartnerListing({
    buyerUserId: userId,
    buyerCharacterId: characterId,
    listingId: Number(listingId),
  });
  if (result.success) {
    const sellerUserId = result.data?.sellerUserId ?? null;
    await consumePartnerMarketBuyTicket(req.marketRiskContext?.buyTicket ?? req.marketRiskContext?.partnerBuyTicket ?? '');
    await safePushCharacterUpdate(userId);
    if (sellerUserId !== null && sellerUserId !== userId) {
      await safePushCharacterUpdate(sellerUserId);
    }
  }
  return sendResult(res, result);
}));

export default router;
