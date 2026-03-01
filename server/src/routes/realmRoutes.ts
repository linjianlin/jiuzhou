import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth } from '../middleware/auth.js';
import { realmService } from '../services/realmService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();


router.use(requireAuth);

router.get('/overview', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await realmService.getOverview(userId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'realmRoutes 路由异常', error);
  }
});

router.post('/breakthrough', async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const body = (req.body ?? {}) as { direction?: unknown; targetRealm?: unknown };
    const targetRealm = typeof body.targetRealm === 'string' ? body.targetRealm : '';
    const direction = typeof body.direction === 'string' ? body.direction : '';

    const result = targetRealm
      ? await realmService.breakthroughToTargetRealm(userId, targetRealm)
      : direction === 'next' || !direction
        ? await realmService.breakthroughToNextRealm(userId)
        : { success: false, message: '突破方向无效' };

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'realmRoutes 路由异常', error);
  }
});

export default router;

