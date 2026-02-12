import { Router, Request, Response } from 'express';
import { verifyToken } from '../services/authService.js';
import {
  acceptSectQuest,
  applyToSect,
  appointPosition,
  buyFromSectShop,
  cancelMyApplication,
  createSect,
  disbandSect,
  donate,
  getBuildings,
  getCharacterSect,
  getSectBonuses,
  getSectInfo,
  getSectQuests,
  getSectShop,
  handleApplication,
  kickMember,
  leaveSect,
  listApplications,
  searchSects,
  transferLeader,
  upgradeBuilding,
} from '../services/sectService.js';
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

  (req as AuthedRequest).userId = decoded.id;
  next();
};

const getCharacterId = async (userId: number): Promise<number | null> => {
  const result = await query('SELECT id FROM characters WHERE user_id = $1', [userId]);
  return result.rows.length > 0 ? Number(result.rows[0].id) : null;
};

const parseBodyNumber = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

router.use(authMiddleware);

router.get('/me', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await getCharacterSect(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('获取我的宗门接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/search', async (req: Request, res: Response) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : undefined;
    const page = typeof req.query.page === 'string' ? Number(req.query.page) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const result = await searchSects(keyword, page, limit);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('搜索宗门接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/create', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });

    const body = req.body as { name?: unknown; description?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const description = typeof body?.description === 'string' ? body.description : undefined;

    if (!name) return res.status(400).json({ success: false, message: '宗门名称不能为空' });
    if (name.length > 16) return res.status(400).json({ success: false, message: '宗门名称过长' });

    const result = await createSect(characterId, name, description);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('创建宗门接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/apply', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { sectId?: unknown; message?: unknown };
    const sectId = typeof body?.sectId === 'string' ? body.sectId : '';
    const message = typeof body?.message === 'string' ? body.message : undefined;
    const result = await applyToSect(characterId, sectId, message);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('申请加入接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/applications/list', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await listApplications(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('申请列表接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/applications/handle', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { applicationId?: unknown; approve?: unknown };
    const applicationId = parseBodyNumber(body?.applicationId);
    const approve = typeof body?.approve === 'boolean' ? body.approve : body?.approve === 'true';
    if (!applicationId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await handleApplication(characterId, applicationId, approve);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('处理申请接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/applications/cancel', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { applicationId?: unknown };
    const applicationId = parseBodyNumber(body?.applicationId);
    if (!applicationId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await cancelMyApplication(characterId, applicationId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('取消申请接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/leave', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await leaveSect(characterId);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('退出宗门接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/kick', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { targetId?: unknown };
    const targetId = parseBodyNumber(body?.targetId);
    if (!targetId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await kickMember(characterId, targetId);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('踢人接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/appoint', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { targetId?: unknown; position?: unknown };
    const targetId = parseBodyNumber(body?.targetId);
    const position = typeof body?.position === 'string' ? body.position : '';
    if (!targetId || !position) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await appointPosition(characterId, targetId, position);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('任命接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/transfer', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { newLeaderId?: unknown };
    const newLeaderId = parseBodyNumber(body?.newLeaderId);
    if (!newLeaderId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await transferLeader(characterId, newLeaderId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('转让宗主接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/disband', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await disbandSect(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('解散宗门接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/donate', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { spiritStones?: unknown };
    const result = await donate(characterId, parseBodyNumber(body?.spiritStones));
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('捐献接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/buildings/list', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await getBuildings(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('建筑列表接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/buildings/upgrade', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { buildingType?: unknown };
    const buildingType = typeof body?.buildingType === 'string' ? body.buildingType.trim() : '';
    if (!buildingType) return res.status(400).json({ success: false, message: '参数错误' });
    if (buildingType !== 'hall') {
      return res.status(400).json({ success: false, message: '当前仅开放宗门大殿升级' });
    }
    const result = await upgradeBuilding(characterId, buildingType);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('升级建筑接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/bonuses', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await getSectBonuses(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('福利接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/quests', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await getSectQuests(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('任务列表接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/quests/accept', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { questId?: unknown };
    const questId = typeof body?.questId === 'string' ? body.questId : '';
    if (!questId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await acceptSectQuest(characterId, questId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('接取任务接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/shop', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const result = await getSectShop(characterId);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('商店接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.post('/shop/buy', async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthedRequest).userId;
    const characterId = await getCharacterId(userId);
    if (!characterId) return res.status(404).json({ success: false, message: '角色不存在' });
    const body = req.body as { itemId?: unknown; quantity?: unknown };
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const quantity = parseBodyNumber(body?.quantity) ?? 1;
    if (!itemId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await buyFromSectShop(characterId, itemId, quantity);
    if (result.success) {
      try {
        const gameServer = getGameServer();
        await gameServer.pushCharacterUpdate(userId);
      } catch {}
    }
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error) {
    console.error('商店购买接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

router.get('/:sectId', async (req: Request, res: Response) => {
  try {
    const sectIdRaw = req.params.sectId;
    const sectId = Array.isArray(sectIdRaw) ? sectIdRaw[0] : sectIdRaw;
    if (!sectId) return res.status(400).json({ success: false, message: '参数错误' });
    const result = await getSectInfo(sectId);
    return res.status(result.success ? 200 : 404).json(result);
  } catch (error) {
    console.error('获取宗门信息接口错误:', error);
    return res.status(500).json({ success: false, message: '服务器错误' });
  }
});

export default router;
