import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, requireCharacter } from '../middleware/auth.js';
import { marketService, type MarketSort } from '../services/marketService.js';
import { sendResult } from '../middleware/response.js';

const router = Router();



const parseQueryNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
};

router.get('/listings', requireAuth, asyncHandler(async (req, res) => {
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

router.get('/my-listings', requireCharacter, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await marketService.getMyMarketListings({ characterId, status, page, pageSize });
    return sendResult(res, result);
}));

router.get('/records', requireCharacter, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);
    const result = await marketService.getMarketTradeRecords({ characterId, page, pageSize });
    return sendResult(res, result);
}));

router.post('/list', requireCharacter, asyncHandler(async (req, res) => {
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

router.post('/cancel', requireCharacter, asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { listingId } = req.body as { listingId?: unknown };
    const result = await marketService.cancelMarketListing({ userId, characterId, listingId: Number(listingId) });
    return sendResult(res, result);
}));

router.post('/buy', requireCharacter, asyncHandler(async (req, res) => {
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

export default router;
