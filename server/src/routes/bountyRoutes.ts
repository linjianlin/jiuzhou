import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth, requireCharacter } from '../middleware/auth.js';
import { bountyService } from '../services/bountyService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';

const router = Router();


router.get('/board', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const pool = typeof req.query.pool === 'string' ? req.query.pool : 'daily';
    const resolvedPool = pool === 'all' || pool === 'player' || pool === 'daily' ? pool : 'daily';
    const result = await bountyService.getBountyBoard(characterId, resolvedPool);
    if (!result.success) return res.status(400).json(result);
    return res.json({ success: true, message: 'ok', data: result.data });
  } catch (error) {
    return withRouteError(res, 'bountyRoutes 路由异常', error);
  }
});

router.post('/claim', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { bountyInstanceId?: unknown };
    const bountyInstanceId = Number(body?.bountyInstanceId);
    const result = await bountyService.claimBounty(characterId, bountyInstanceId);
    if (!result.success) return res.status(400).json(result);
    await safePushCharacterUpdate(userId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'bountyRoutes 路由异常', error);
  }
});

router.post('/publish', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as {
      taskId?: unknown;
      title?: unknown;
      description?: unknown;
      claimPolicy?: unknown;
      maxClaims?: unknown;
      expiresAt?: unknown;
      spiritStonesReward?: unknown;
      silverReward?: unknown;
      requiredItems?: unknown;
    };
    const taskId = typeof body?.taskId === 'string' ? body.taskId : undefined;
    const title = typeof body?.title === 'string' ? body.title : '';
    const description = typeof body?.description === 'string' ? body.description : undefined;
    const claimPolicy = typeof body?.claimPolicy === 'string' ? (body.claimPolicy as any) : undefined;
    const maxClaims = Number.isFinite(Number(body?.maxClaims)) ? Number(body.maxClaims) : undefined;
    const expiresAt = typeof body?.expiresAt === 'string' ? body.expiresAt : undefined;
    const spiritStonesReward = Number.isFinite(Number(body?.spiritStonesReward)) ? Number(body.spiritStonesReward) : undefined;
    const silverReward = Number.isFinite(Number(body?.silverReward)) ? Number(body.silverReward) : undefined;
    const requiredItems = Array.isArray(body?.requiredItems) ? (body.requiredItems as any[]) : undefined;

    const result = await bountyService.publishBounty(characterId, {
      taskId,
      title,
      description,
      claimPolicy,
      maxClaims,
      expiresAt,
      spiritStonesReward,
      silverReward,
      requiredItems,
    });
    if (!result.success) return res.status(400).json(result);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'bountyRoutes 路由异常', error);
  }
});

router.get('/items/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
    const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 20;
    const result = await bountyService.searchItemDefsForBounty(keyword, limit);
    if (!result.success) return res.status(400).json(result);
    return res.json({ success: true, message: 'ok', data: result.data });
  } catch (error) {
    return withRouteError(res, 'bountyRoutes 路由异常', error);
  }
});

router.post('/submit-materials', requireCharacter, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const body = req.body as { taskId?: unknown };
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    const result = await bountyService.submitBountyMaterials(characterId, taskId);
    if (!result.success) return res.status(400).json(result);
    await safePushCharacterUpdate(userId);
    return res.json(result);
  } catch (error) {
    return withRouteError(res, 'bountyRoutes 路由异常', error);
  }
});

export default router;