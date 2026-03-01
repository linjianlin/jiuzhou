import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth } from '../middleware/auth.js';
import { monthCardService } from '../services/monthCardService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();


const defaultMonthCardId = 'monthcard-001';

router.get('/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const monthCardId = typeof req.query.monthCardId === 'string' ? req.query.monthCardId : defaultMonthCardId;
    const result = await monthCardService.getMonthCardStatus(userId, monthCardId);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'monthCardRoutes 路由异常', error);
  }
});

router.post('/buy', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as { monthCardId?: unknown };
    const monthCardId = typeof body?.monthCardId === 'string' ? body.monthCardId : defaultMonthCardId;
    const result = await monthCardService.buyMonthCard(userId, monthCardId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'monthCardRoutes 路由异常', error);
  }
});

router.post('/use-item', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as { monthCardId?: unknown; itemInstanceId?: unknown };
    const monthCardId = typeof body?.monthCardId === 'string' ? body.monthCardId : defaultMonthCardId;
    const itemInstanceId =
      typeof body?.itemInstanceId === 'number'
        ? body.itemInstanceId
        : typeof body?.itemInstanceId === 'string'
          ? Number(body.itemInstanceId)
          : undefined;
    const result = await monthCardService.useMonthCardItem(userId, monthCardId, { itemInstanceId });
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'monthCardRoutes 路由异常', error);
  }
});

router.post('/claim', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = req.body as { monthCardId?: unknown };
    const monthCardId = typeof body?.monthCardId === 'string' ? body.monthCardId : defaultMonthCardId;
    const result = await monthCardService.claimMonthCardReward(userId, monthCardId);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'monthCardRoutes 路由异常', error);
  }
});

export default router;
