import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
/**
 * 九州修仙录 - 角色功法路由
 * 提供功法学习、修炼、装备、技能配置等API
 */
import { requireAuth } from '../middleware/auth.js';
import {
  characterTechniqueService,
  techniqueGenerationService,
} from '../domains/character/index.js';
import type {
  ServiceResult
} from '../domains/character/index.js';
import { query } from '../config/database.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { getSingleParam, parsePositiveInt } from '../services/shared/httpParam.js';
import { sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  abortTechniqueGenerationJob,
  enqueueTechniqueGenerationJob,
} from '../services/techniqueGenerationJobRunner.js';

const router = Router();
const isTechniqueResearchEnabled = process.env.NODE_ENV !== 'production';

// 扩展Request类型以包含user和params
interface AuthRequest extends Request<{ characterId: string; techniqueId?: string }> {
  userId?: number;
}

const parseCharacterIdParam = (req: Request): number | null => {
  return parsePositiveInt(getSingleParam(req.params.characterId));
};


const characterOwnershipMiddleware = async (req: Request, res: Response, next: () => void) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    res.status(400).json({ success: false, message: '无效的角色ID' });
    return;
  }

  const userId = req.userId!;
  if (!userId) {
    res.status(401).json({ success: false, message: '登录状态无效，请重新登录' });
    return;
  }

  const result = await query('SELECT id FROM characters WHERE id = $1 AND user_id = $2 LIMIT 1', [characterId, userId]);
  if (result.rows.length === 0) {
    res.status(403).json({ success: false, message: '无权限访问该角色' });
    return;
  }

  next();
};

router.use('/:characterId', requireAuth, characterOwnershipMiddleware);
router.use('/:characterId/technique/research', (_req: Request, _res: Response, next: NextFunction) => {
  if (isTechniqueResearchEnabled) {
    next();
    return;
  }
  next(new BusinessError('洞府研修功能在生产环境暂时关闭', 403));
});


// ============================================
// 获取角色功法完整状态
// GET /api/character/:characterId/technique/status
// ============================================
router.get('/:characterId/technique/status', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getCharacterTechniqueStatus(characterId);
  sendResult(res, result);
}));

// ============================================
// 获取研修状态
// GET /api/character/:characterId/technique/research/status
// ============================================
router.get('/:characterId/technique/research/status', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await techniqueGenerationService.getResearchStatus(characterId);
  sendResult(res, result);
}));

// ============================================
// 生成研修功法草稿
// POST /api/character/:characterId/technique/research/generate
// ============================================
router.post('/:characterId/technique/research/generate', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }
  const userId = req.userId!;
  if (!userId) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }

  const result = await techniqueGenerationService.generateTechniqueDraft(characterId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    if (result.data) {
      try {
        await enqueueTechniqueGenerationJob({
          characterId,
          generationId: result.data.generationId,
          quality: result.data.quality,
          userId,
        });
      } catch (error) {
        await techniqueGenerationService.failPendingGenerationJob(
          characterId,
          result.data.generationId,
          `洞府推演任务投递失败：${error instanceof Error ? error.message : '未知异常'}`,
        );
        throw new BusinessError('洞府推演任务投递失败，请稍后重试');
      }
    }
  }
  sendResult(res, result);
}));

// ============================================
// 标记最新研修结果已查看
// POST /api/character/:characterId/technique/research/mark-result-viewed
// ============================================
router.post('/:characterId/technique/research/mark-result-viewed', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await techniqueGenerationService.markLatestResultViewed(characterId);
  sendResult(res, result);
}));

// ============================================
// 放弃当前研修任务
// POST /api/character/:characterId/technique/research/generate/:generationId/abandon
// ============================================
router.post('/:characterId/technique/research/generate/:generationId/abandon', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }
  const userId = req.userId!;
  if (!userId) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }

  const generationId = getSingleParam((req.params as Record<string, string | string[] | undefined>).generationId);
  if (!generationId) {
    throw new BusinessError('缺少生成任务ID');
  }

  const result = await techniqueGenerationService.abandonPendingGenerationJob(characterId, generationId);
  if (result.success) {
    await abortTechniqueGenerationJob(generationId);
    await safePushCharacterUpdate(userId);
  }
  sendResult(res, result);
}));

// ============================================
// 发布研修草稿（命名）
// POST /api/character/:characterId/technique/research/generate/:generationId/publish
// Body: { customName: string }
// ============================================
router.post('/:characterId/technique/research/generate/:generationId/publish', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }
  const userId = req.userId!;
  if (!userId) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }

  const generationId = getSingleParam((req.params as Record<string, string | string[] | undefined>).generationId);
  if (!generationId) {
    throw new BusinessError('缺少生成任务ID');
  }
  const customName = typeof req.body?.customName === 'string' ? req.body.customName : '';
  if (!customName.trim()) {
    throw new BusinessError('缺少自定义名称');
  }

  const result = await techniqueGenerationService.publishGeneratedTechnique({
    characterId,
    userId,
    generationId,
    customName,
  });
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  sendResult(res, result);
}));

// ============================================
// 获取角色已学习的功法列表
// GET /api/character/:characterId/techniques
// ============================================
router.get('/:characterId/techniques', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getCharacterTechniques(characterId);
  sendResult(res, result);
}));

// ============================================
// 获取角色已装备的功法
// GET /api/character/:characterId/techniques/equipped
// ============================================
router.get('/:characterId/techniques/equipped', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getEquippedTechniques(characterId);
  sendResult(res, result);
}));

// ============================================
// 学习功法
// POST /api/character/:characterId/technique/learn
// Body: { techniqueId: string, obtainedFrom?: string, obtainedRefId?: string }
// ============================================
router.post('/:characterId/technique/learn', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const { techniqueId, obtainedFrom, obtainedRefId } = req.body;
  if (!techniqueId) {
    throw new BusinessError('缺少功法ID');
  }
  const result = await characterTechniqueService.learnTechnique(characterId, techniqueId, obtainedFrom, obtainedRefId);

  if (result.success) {
    const userId = req.userId!;
    if (userId && Number.isFinite(userId)) {
      await safePushCharacterUpdate(userId);
    }
  }

  sendResult(res, result);
}));

// ============================================
// 获取功法升级消耗
// GET /api/character/:characterId/technique/:techniqueId/upgrade-cost
// ============================================
router.get('/:characterId/technique/:techniqueId/upgrade-cost', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  const techniqueId = getSingleParam(req.params.techniqueId);

  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getTechniqueUpgradeCost(characterId, techniqueId);
  sendResult(res, result);
}));


// ============================================
// 修炼升级功法
// POST /api/character/:characterId/technique/:techniqueId/upgrade
// ============================================
router.post('/:characterId/technique/:techniqueId/upgrade', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  const techniqueId = getSingleParam(req.params.techniqueId);

  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const userId = req.userId! || 0;
  if (!userId) {
    throw new BusinessError('登录状态无效，请重新登录', 401);
  }
  const result = await characterTechniqueService.upgradeTechnique(characterId, techniqueId);

  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  sendResult(res, result);
}));

// ============================================
// 装备功法
// POST /api/character/:characterId/technique/equip
// Body: { techniqueId: string, slotType: 'main' | 'sub', slotIndex?: number }
// ============================================
router.post('/:characterId/technique/equip', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const { techniqueId, slotType, slotIndex } = req.body;
  if (!techniqueId || !slotType) {
    throw new BusinessError('缺少必要参数');
  }

  if (slotType !== 'main' && slotType !== 'sub') {
    throw new BusinessError('无效的槽位类型');
  }
  const result = await characterTechniqueService.equipTechnique(characterId, techniqueId, slotType, slotIndex);

  if (result.success) {
    const userId = req.userId!;
    if (userId && Number.isFinite(userId)) {
      await safePushCharacterUpdate(userId);
    }
  }

  sendResult(res, result);
}));

// ============================================
// 卸下功法
// POST /api/character/:characterId/technique/unequip
// Body: { techniqueId: string }
// ============================================
router.post('/:characterId/technique/unequip', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const { techniqueId } = req.body;
  if (!techniqueId) {
    throw new BusinessError('缺少功法ID');
  }
  const result = await characterTechniqueService.unequipTechnique(characterId, techniqueId);

  if (result.success) {
    const userId = req.userId!;
    if (userId && Number.isFinite(userId)) {
      await safePushCharacterUpdate(userId);
    }
  }

  sendResult(res, result);
}));

// ============================================
// 获取可用技能列表
// GET /api/character/:characterId/skills/available
// ============================================
router.get('/:characterId/skills/available', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getAvailableSkills(characterId);
  sendResult(res, result);
}));

// ============================================
// 获取已装备的技能槽
// GET /api/character/:characterId/skills/equipped
// ============================================
router.get('/:characterId/skills/equipped', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.getEquippedSkills(characterId);
  sendResult(res, result);
}));


// ============================================
// 装备技能
// POST /api/character/:characterId/skill/equip
// Body: { skillId: string, slotIndex: number }
// ============================================
router.post('/:characterId/skill/equip', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const { skillId, slotIndex } = req.body;
  if (!skillId || slotIndex === undefined) {
    throw new BusinessError('缺少必要参数');
  }

  const result = await characterTechniqueService.equipSkill(characterId, skillId, slotIndex);
  sendResult(res, result);
}));

// ============================================
// 卸下技能
// POST /api/character/:characterId/skill/unequip
// Body: { slotIndex: number }
// ============================================
router.post('/:characterId/skill/unequip', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const { slotIndex } = req.body;
  if (slotIndex === undefined) {
    throw new BusinessError('缺少槽位索引');
  }

  const result = await characterTechniqueService.unequipSkill(characterId, slotIndex);
  sendResult(res, result);
}));

// ============================================
// 获取功法被动加成
// GET /api/character/:characterId/technique/passives
// ============================================
router.get('/:characterId/technique/passives', asyncHandler(async (req, res) => {
  const characterId = parseCharacterIdParam(req);
  if (characterId === null) {
    throw new BusinessError('无效的角色ID');
  }

  const result = await characterTechniqueService.calculateTechniquePassives(characterId);
  sendResult(res, result);
}));

export default router;
