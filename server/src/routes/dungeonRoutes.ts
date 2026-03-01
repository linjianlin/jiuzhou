import { Router, Request, Response } from 'express';
import { withRouteError } from '../middleware/routeError.js';
import { requireAuth, getOptionalUserId } from '../middleware/auth.js';
import {
  dungeonService,
  type DungeonType,
} from '../domains/dungeon/index.js';
import { getSingleParam, getSingleQueryValue } from '../services/shared/httpParam.js';

const router = Router();



const toType = (v: unknown): DungeonType | undefined => {
  if (v === 'material' || v === 'equipment' || v === 'trial' || v === 'challenge' || v === 'event') return v;
  return undefined;
};

router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const categories = await dungeonService.getDungeonCategories();
    res.json({ success: true, data: { categories } });
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.get('/list', async (req: Request, res: Response) => {
  try {
    const type = toType(getSingleQueryValue(req.query.type));
    const qValue = getSingleQueryValue(req.query.q).trim();
    const realmValue = getSingleQueryValue(req.query.realm).trim();
    const q = qValue || undefined;
    const realm = realmValue || undefined;
    const dungeons = await dungeonService.getDungeonList({ type, q, realm });
    res.json({ success: true, data: { dungeons } });
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.get('/preview/:id', async (req: Request, res: Response) => {
  try {
    const id = getSingleParam(req.params.id);
    const rankRaw = getSingleQueryValue(req.query.rank).trim();
    const rankCandidate = rankRaw ? Number(rankRaw) : 1;
    const rank = Number.isFinite(rankCandidate) ? rankCandidate : 1;
    const userId = getOptionalUserId(req);
    const preview = await dungeonService.getDungeonPreview(id, rank, userId);
    if (!preview) {
      res.status(404).json({ success: false, message: '秘境不存在' });
      return;
    }
    res.json({ success: true, data: preview });
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.get('/weekly-targets', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const result = await dungeonService.getDungeonWeeklyTargets(userId);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.post('/instance/create', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const dungeonId = typeof req.body?.dungeonId === 'string' ? req.body.dungeonId : '';
    const difficultyRankRaw = req.body?.difficultyRank;
    const difficultyRank = typeof difficultyRankRaw === 'number' ? difficultyRankRaw : Number(difficultyRankRaw ?? 1);
    if (!dungeonId) {
      res.status(400).json({ success: false, message: '缺少秘境ID' });
      return;
    }
    const result = await dungeonService.createDungeonInstance(
      userId,
      dungeonId,
      Number.isFinite(difficultyRank) ? difficultyRank : 1
    );
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.post('/instance/join', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
    if (!instanceId) {
      res.status(400).json({ success: false, message: '缺少实例ID' });
      return;
    }
    const result = await dungeonService.joinDungeonInstance(userId, instanceId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.post('/instance/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
    if (!instanceId) {
      res.status(400).json({ success: false, message: '缺少实例ID' });
      return;
    }
    const result = await dungeonService.startDungeonInstance(userId, instanceId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.post('/instance/next', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const instanceId = typeof req.body?.instanceId === 'string' ? req.body.instanceId : '';
    if (!instanceId) {
      res.status(400).json({ success: false, message: '缺少实例ID' });
      return;
    }
    const result = await dungeonService.nextDungeonInstance(userId, instanceId);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

router.get('/instance/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const id = getSingleParam(req.params.id);
    if (!id) {
      res.status(400).json({ success: false, message: '缺少实例ID' });
      return;
    }
    const result = await dungeonService.getDungeonInstance(userId, id);
    res.json(result);
  } catch (error) {
    return withRouteError(res, 'dungeonRoutes 路由异常', error);
  }
});

export default router;
