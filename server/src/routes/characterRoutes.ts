import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';
import {
  checkCharacter,
  createCharacter,
  getCharacter,
  updateCharacterAutoCastSkills,
  updateCharacterAutoDisassembleSettings,
  updateCharacterDungeonNoStaminaCostSetting,
  updateCharacterPosition,
} from '../domains/character/index.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';

const router = Router();

// 检查是否有角色
router.get('/check', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await checkCharacter(userId);
  sendResult(res, result);
}));

// 创建角色
router.post('/create', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { nickname, gender } = req.body;

  // 参数验证
  if (!nickname || !gender) {
    throw new BusinessError('道号和性别不能为空');
  }

  if (nickname.length < 2 || nickname.length > 12) {
    throw new BusinessError('道号长度需在2-12个字符之间');
  }

  if (!['male', 'female'].includes(gender)) {
    throw new BusinessError('性别参数错误');
  }

  const result = await createCharacter(userId, nickname, gender);
  sendResult(res, result);
}));

// 获取角色信息
router.get('/info', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const result = await getCharacter(userId);
  sendResult(res, result);
}));

// 更新玩家位置
router.post('/updatePosition', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const { currentMapId, currentRoomId } = req.body as { currentMapId?: string; currentRoomId?: string };

  const result = await updateCharacterPosition(userId, currentMapId ?? '', currentRoomId ?? '');

  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  sendResult(res, result);
}));

router.post('/updateAutoCastSkills', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);

  const result = await updateCharacterAutoCastSkills(userId, enabled);

  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  sendResult(res, result);
}));

router.post('/updateAutoDisassemble', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const body = req.body as { enabled?: unknown; rules?: unknown };

  const enabled = Boolean(body?.enabled);
  const parsedRules = body?.rules;

  if (parsedRules !== undefined && !Array.isArray(parsedRules)) {
    throw new BusinessError('rules参数错误，需为数组');
  }
  if (
    Array.isArray(parsedRules) &&
    parsedRules.some((rule) => rule === null || typeof rule !== 'object' || Array.isArray(rule))
  ) {
    throw new BusinessError('rules参数错误，规则项需为对象');
  }

  const result = await updateCharacterAutoDisassembleSettings(userId, enabled, parsedRules);

  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  return sendResult(res, result);
}));

router.post('/updateDungeonNoStaminaCost', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);

  const result = await updateCharacterDungeonNoStaminaCostSetting(userId, enabled);

  if (result.success) {
    await safePushCharacterUpdate(userId);
  }

  return sendResult(res, result);
}));

export default router;
