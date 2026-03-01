import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth } from '../middleware/auth.js';
import { signInService } from '../services/signInService.js';

const router = Router();


router.get('/overview', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const monthRaw = typeof req.query.month === 'string' ? req.query.month : '';
    const now = new Date();
    const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const month = monthRaw || fallbackMonth;

    const result = await signInService.getOverview(userId, month);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'signInRoutes 路由异常', error);
  }
});

router.post('/do', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await signInService.doSignIn(userId);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'signInRoutes 路由异常', error);
  }
});

export default router;
