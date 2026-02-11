import { Router, Request, Response } from 'express';
import { verifyToken } from '../services/authService.js';
import {
  getMainQuestProgress,
  startDialogue,
  advanceDialogue,
  selectDialogueChoice,
  completeCurrentSection,
  getChapterList,
  getSectionList,
  setMainQuestTracked
} from '../services/mainQuestService.js';
import { query } from '../config/database.js';
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

const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;
  const res = await query('SELECT id FROM characters WHERE user_id = $1 LIMIT 1', [uid]);
  const characterId = Number(res.rows?.[0]?.id);
  return Number.isFinite(characterId) && characterId > 0 ? characterId : null;
};

// 获取主线进度
router.get('/progress', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const data = await getMainQuestProgress(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取主线进度失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 获取章节列表
router.get('/chapters', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const data = await getChapterList(characterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取章节列表失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 获取章节下的任务节列表
router.get('/chapters/:chapterId/sections', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const chapterId = typeof req.params.chapterId === 'string' ? req.params.chapterId : '';
    const data = await getSectionList(characterId, chapterId);
    return res.json({ success: true, message: 'ok', data });
  } catch (error) {
    console.error('获取任务节列表失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 开始对话
router.post('/dialogue/start', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const body = req.body as { dialogueId?: string };
    const dialogueId = typeof body?.dialogueId === 'string' ? body.dialogueId : undefined;

    const result = await startDialogue(characterId, dialogueId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('开始对话失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 推进对话
router.post('/dialogue/advance', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const result = await advanceDialogue(userId, characterId);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('推进对话失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 选择对话选项
router.post('/dialogue/choice', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const body = req.body as { choiceId?: string };
    const choiceId = typeof body?.choiceId === 'string' ? body.choiceId : '';

    if (!choiceId) {
      return res.status(400).json({ success: false, message: '选项ID不能为空' });
    }

    const result = await selectDialogueChoice(userId, characterId, choiceId);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('选择对话选项失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 完成任务节并领取奖励
router.post('/section/complete', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const result = await completeCurrentSection(userId, characterId);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('完成任务节失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

// 设置主线任务追踪状态
router.post('/track', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterIdByUserId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const body = req.body as { tracked?: boolean };
    const tracked = body?.tracked === true;

    const result = await setMainQuestTracked(characterId, tracked);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('设置主线追踪失败:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

export default router;
