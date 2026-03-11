/**
 * 伙伴系统路由
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：暴露伙伴总览、出战切换、经验灌注、打书与功法升层接口，并统一做请求参数校验。
 * 2) 不做什么：不承载伙伴公式，不直接操作数据库，不自己消费物品效果。
 *
 * 输入/输出：
 * - 输入：鉴权后的 `userId/characterId`、`partnerId`、`techniqueId`、`exp`、`itemInstanceId`。
 * - 输出：标准业务响应 `{ success, message, data }`。
 *
 * 数据流/状态流：
 * router -> partnerService / itemService -> sendResult；灌注与功法升层成功后额外推送角色刷新。
 *
 * 关键边界条件与坑点：
 * 1) 伙伴升级会消耗角色经验，因此灌注成功后必须推送角色刷新。
 * 2) 打书实际通过物品使用链路消费道具，路由层不能重复扣背包数量。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { sendResult } from '../middleware/response.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { itemService } from '../services/itemService.js';
import { enqueuePartnerRecruitJob } from '../services/partnerRecruitJobRunner.js';
import { partnerRecruitService } from '../services/partnerRecruitService.js';
import { partnerService } from '../services/partnerService.js';
import { getItemDefinitionById } from '../services/staticConfigLoader.js';
import { resolveTechniqueBookLearning } from '../services/shared/techniqueBookRules.js';

const router = Router();

router.use(requireCharacter);

const parsePositiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseNonEmptyText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

router.get('/overview', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerService.getOverview(characterId);
  return sendResult(res, result);
}));

router.get('/recruit/status', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerRecruitService.getRecruitStatus(characterId);
  return sendResult(res, result);
}));

router.post('/recruit/generate', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const quality = partnerRecruitService.resolveQualityForNewRecruit();
  const result = await partnerRecruitService.createRecruitJob(characterId, quality);
  if (!result.success || !result.data) {
    return sendResult(res, result);
  }

  try {
    await enqueuePartnerRecruitJob({
      generationId: result.data.generationId,
      characterId,
      quality,
      userId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知异常';
    await partnerRecruitService.forceRefundPendingRecruitJob(
      characterId,
      result.data.generationId,
      `伙伴招募任务投递失败：${reason}`,
    );
    return sendResult(res, {
      success: false,
      message: '伙伴招募启动失败，已自动退还灵石',
    });
  }

  return sendResult(res, result);
}));

router.post('/recruit/:generationId/confirm', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const generationId = parseNonEmptyText(req.params?.generationId);
  if (!generationId) {
    sendResult(res, { success: false, message: 'generationId 参数无效' });
    return;
  }

  const result = await partnerRecruitService.confirmRecruitDraft(characterId, generationId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.post('/recruit/:generationId/discard', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const generationId = parseNonEmptyText(req.params?.generationId);
  if (!generationId) {
    sendResult(res, { success: false, message: 'generationId 参数无效' });
    return;
  }

  const result = await partnerRecruitService.discardRecruitDraft(characterId, generationId);
  return sendResult(res, result);
}));

router.post('/recruit/mark-result-viewed', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerRecruitService.markResultViewed(characterId);
  return sendResult(res, result);
}));

router.post('/activate', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.body?.partnerId);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }

  const result = await partnerService.activate(characterId, partnerId);
  return sendResult(res, result);
}));

router.post('/dismiss', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerService.dismiss(characterId);
  return sendResult(res, result);
}));

router.post('/inject-exp', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.body?.partnerId);
  const exp = parsePositiveInt(req.body?.exp);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }
  if (!exp) {
    sendResult(res, { success: false, message: 'exp 参数无效，需为大于 0 的整数' });
    return;
  }

  const result = await partnerService.injectExp(characterId, partnerId, exp);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.post('/learn-technique', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.body?.partnerId);
  const itemInstanceId = parsePositiveInt(req.body?.itemInstanceId ?? req.body?.itemId);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }
  if (!itemInstanceId) {
    sendResult(res, { success: false, message: 'itemInstanceId 参数无效' });
    return;
  }

  const itemInstance = await itemService.getItemInstance(itemInstanceId);
  if (!itemInstance) {
    sendResult(res, { success: false, message: '物品不存在' });
    return;
  }
  const itemDef = getItemDefinitionById(String(itemInstance.itemDefId || ''));
  const learnableTechniqueBook = resolveTechniqueBookLearning({
    itemDef,
    metadata:
      itemInstance && typeof itemInstance === 'object' && itemInstance.metadata && typeof itemInstance.metadata === 'object'
        ? (itemInstance.metadata as object)
        : null,
  });
  if (!learnableTechniqueBook) {
    sendResult(res, { success: false, message: '该道具不是可供伙伴学习的功法书' });
    return;
  }

  const result = await itemService.useItem(userId, characterId, itemInstanceId, 1, {
    partnerId,
  });
  if (!result.success) {
    return sendResult(res, result);
  }

  return sendResult(res, {
    success: true,
    message: result.message,
    data: result.partnerTechniqueResult,
  });
}));

router.get('/technique-upgrade-cost', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.query?.partnerId);
  const techniqueId = parseNonEmptyText(req.query?.techniqueId);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }
  if (!techniqueId) {
    sendResult(res, { success: false, message: 'techniqueId 参数无效' });
    return;
  }

  const result = await partnerService.getTechniqueUpgradeCost(characterId, partnerId, techniqueId);
  return sendResult(res, result);
}));

router.post('/upgrade-technique', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.body?.partnerId);
  const techniqueId = parseNonEmptyText(req.body?.techniqueId);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }
  if (!techniqueId) {
    sendResult(res, { success: false, message: 'techniqueId 参数无效' });
    return;
  }

  const result = await partnerService.upgradeTechnique(characterId, partnerId, techniqueId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

export default router;
