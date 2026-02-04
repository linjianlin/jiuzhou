import { Router, Request, Response } from 'express';
import { verifyToken } from '../services/authService.js';
import {
  getBattlePassTasksOverview,
  getBattlePassStatus,
  getBattlePassRewards,
  claimBattlePassReward,
} from '../services/battlePassService.js';

const router = Router();

type AuthedRequest = Request & { userId: number };

const authMiddleware = (req: Request, res: Response, next: () => void) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: '未登录' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const { valid, decoded } = verifyToken(token);

  if (!valid || !decoded) {
    res.status(401).json({ success: false, message: '登录已过期' });
    return;
  }

  (req as AuthedRequest).userId = decoded.id as number;
  next();
};

router.get('/tasks', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const seasonId = typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined;
    const data = await getBattlePassTasksOverview(userId, seasonId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取战令任务失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/status', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const data = await getBattlePassStatus(userId);
    if (!data) return res.status(404).json({ success: false, message: '战令数据不存在' });
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取战令状态失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/rewards', authMiddleware, async (req: Request, res: Response) => {
  try {
    const seasonId = typeof req.query.seasonId === 'string' ? req.query.seasonId : undefined;
    const data = await getBattlePassRewards(seasonId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取战令奖励失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/claim', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const { level, track } = req.body as { level?: number; track?: 'free' | 'premium' };
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1) {
      return res.status(400).json({ success: false, message: '等级参数无效' });
    }
    if (track !== 'free' && track !== 'premium') {
      return res.status(400).json({ success: false, message: '奖励轨道参数无效' });
    }
    const result = await claimBattlePassReward(userId, level, track);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (error) {
    console.error('领取战令奖励失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

export default router;

