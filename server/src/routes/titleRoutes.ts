import { Router, type Request, type Response } from 'express';
import { verifyToken } from '../services/authService.js';
import { getCharacterIdByUserId } from '../services/taskService.js';
import { equipTitle, getTitleList } from '../services/achievementService.js';
import { getGameServer } from '../game/GameServer.js';

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

router.get('/list', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const data = await getTitleList(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取称号列表失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/equip', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const body = req.body as { titleId?: unknown; title_id?: unknown };
    const titleId =
      typeof body?.titleId === 'string'
        ? body.titleId
        : typeof body?.title_id === 'string'
          ? body.title_id
          : '';

    const result = await equipTitle(characterId, titleId);
    if (!result.success) return res.status(400).json(result);

    try {
      const gameServer = getGameServer();
      await gameServer.pushCharacterUpdate(userId);
    } catch {}

    return res.json(result);
  } catch (error) {
    console.error('装备称号失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

export default router;
