import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth, requireCharacter } from '../middleware/auth.js';
import { marketService, type MarketSort } from '../services/marketService.js';

const router = Router();



const parseQueryNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
};

router.get('/listings', requireAuth, async (req: Request, res: Response) => {
  try {
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

    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

router.get('/my-listings', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);

    const result = await marketService.getMyMarketListings({ characterId, status, page, pageSize });
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

router.get('/records', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const page = parseQueryNumber(req.query.page);
    const pageSize = parseQueryNumber(req.query.pageSize);
    const result = await marketService.getMarketTradeRecords({ characterId, page, pageSize });
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

router.post('/list', requireCharacter, async (req: Request, res: Response) => {
  try {
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

    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

router.post('/cancel', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { listingId } = req.body as { listingId?: unknown };
    const result = await marketService.cancelMarketListing({ userId, characterId, listingId: Number(listingId) });
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

router.post('/buy', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { listingId } = req.body as { listingId?: unknown };
    const result = await marketService.buyMarketListing({ buyerUserId: userId, buyerCharacterId: characterId, listingId: Number(listingId) });
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'marketRoutes 路由异常', error);
  }
});

export default router;

