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
import { enqueuePartnerFusionJob } from '../services/partnerFusionJobRunner.js';
import { notifyPartnerFusionStatus } from '../services/partnerFusionPush.js';
import { partnerFusionService } from '../services/partnerFusionService.js';
import { enqueuePartnerRecruitJob } from '../services/partnerRecruitJobRunner.js';
import { notifyPartnerRecruitStatus } from '../services/partnerRecruitPush.js';
import { partnerRecruitService } from '../services/partnerRecruitService.js';
import { partnerService } from '../services/partnerService.js';
import { getItemDefinitionById } from '../services/staticConfigLoader.js';
import { getSingleParam, getSingleQueryValue, parseNonEmptyText, parsePositiveInt } from '../services/shared/httpParam.js';
import { resolveTechniqueBookLearning } from '../services/shared/techniqueBookRules.js';

const router = Router();

router.use(requireCharacter);

const parsePartnerSkillPolicySlots = (
  value: Array<{ skillId?: string; priority?: number; enabled?: boolean }> | undefined,
): Array<{ skillId: string; priority: number; enabled: boolean }> | null => {
  if (!Array.isArray(value)) return null;
  const slots: Array<{ skillId: string; priority: number; enabled: boolean }> = [];
  for (const rawSlot of value) {
    if (!rawSlot || typeof rawSlot !== 'object' || Array.isArray(rawSlot)) {
      return null;
    }
    const skillId = parseNonEmptyText(rawSlot.skillId);
    const priority = parsePositiveInt(rawSlot.priority);
    if (!skillId || !priority || typeof rawSlot.enabled !== 'boolean') {
      return null;
    }
    slots.push({
      skillId,
      priority,
      enabled: rawSlot.enabled,
    });
  }
  return slots;
};

const parsePartnerIdList = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const partnerIds = value.map((entry) => parsePositiveInt(entry));
  if (partnerIds.some((entry) => !entry)) {
    return null;
  }
  return partnerIds as number[];
};

router.get('/overview', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerService.getOverview(characterId);
  return sendResult(res, result);
}));

router.get('/skill-policy', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.query?.partnerId);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }

  const result = await partnerService.getSkillPolicy(characterId, partnerId);
  return sendResult(res, result);
}));

router.put('/skill-policy', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const partnerId = parsePositiveInt(req.body?.partnerId);
  const slots = parsePartnerSkillPolicySlots(req.body?.slots);
  if (!partnerId) {
    sendResult(res, { success: false, message: 'partnerId 参数无效' });
    return;
  }
  if (!slots) {
    sendResult(res, { success: false, message: 'slots 参数无效' });
    return;
  }

  const result = await partnerService.updateSkillPolicy(characterId, partnerId, slots);
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
  const customBaseModelEnabledRaw = req.body?.customBaseModelEnabled;
  const requestedBaseModelRaw = req.body?.requestedBaseModel;
  if (customBaseModelEnabledRaw !== undefined && customBaseModelEnabledRaw !== null && typeof customBaseModelEnabledRaw !== 'boolean') {
    return sendResult(res, { success: false, message: 'customBaseModelEnabled 参数无效' });
  }
  if (requestedBaseModelRaw !== undefined && requestedBaseModelRaw !== null && typeof requestedBaseModelRaw !== 'string') {
    return sendResult(res, { success: false, message: 'requestedBaseModel 参数无效' });
  }

  const quality = partnerRecruitService.resolveQualityForNewRecruit();
  const result = await partnerRecruitService.createRecruitJob(
    characterId,
    quality,
    customBaseModelEnabledRaw === true,
    typeof requestedBaseModelRaw === 'string' ? requestedBaseModelRaw : null,
  );
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
    await notifyPartnerRecruitStatus(characterId, userId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知异常';
    await partnerRecruitService.forceRefundPendingRecruitJob(
      characterId,
      result.data.generationId,
      `伙伴招募任务投递失败：${reason}`,
    );
    await notifyPartnerRecruitStatus(characterId, userId);
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
  const generationId = parseNonEmptyText(getSingleParam(req.params?.generationId));
  if (!generationId) {
    sendResult(res, { success: false, message: 'generationId 参数无效' });
    return;
  }

  const result = await partnerRecruitService.confirmRecruitDraft(characterId, generationId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    await notifyPartnerRecruitStatus(characterId, userId);
  }
  return sendResult(res, result);
}));

router.post('/recruit/:generationId/discard', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const generationId = parseNonEmptyText(getSingleParam(req.params?.generationId));
  if (!generationId) {
    sendResult(res, { success: false, message: 'generationId 参数无效' });
    return;
  }

  const result = await partnerRecruitService.discardRecruitDraft(characterId, generationId);
  if (result.success) {
    await notifyPartnerRecruitStatus(characterId, req.userId);
  }
  return sendResult(res, result);
}));

router.post('/recruit/mark-result-viewed', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerRecruitService.markResultViewed(characterId);
  if (result.success) {
    await notifyPartnerRecruitStatus(characterId, req.userId);
  }
  return sendResult(res, result);
}));

router.get('/fusion/status', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerFusionService.getFusionStatus(characterId);
  return sendResult(res, result);
}));

router.post('/fusion/start', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const partnerIds = parsePartnerIdList(req.body?.partnerIds);
  if (!partnerIds) {
    return sendResult(res, { success: false, message: 'partnerIds 参数无效' });
  }

  const result = await partnerFusionService.startFusion(characterId, partnerIds);
  if (!result.success || !result.data) {
    return sendResult(res, result);
  }

  try {
    await enqueuePartnerFusionJob({
      fusionId: result.data.fusionId,
      characterId,
      userId,
    });
    await notifyPartnerFusionStatus(characterId, userId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知异常';
    await partnerFusionService.forceFailPendingFusionJob(
      characterId,
      result.data.fusionId,
      `三魂归契任务投递失败：${reason}`,
    );
    await notifyPartnerFusionStatus(characterId, userId);
    return sendResult(res, {
      success: false,
      message: '三魂归契启动失败，请稍后重试',
    });
  }

  return sendResult(res, result);
}));

router.post('/fusion/:fusionId/confirm', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const fusionId = parseNonEmptyText(getSingleParam(req.params?.fusionId));
  if (!fusionId) {
    return sendResult(res, { success: false, message: 'fusionId 参数无效' });
  }

  const result = await partnerFusionService.confirmFusionPreview(characterId, fusionId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    await notifyPartnerFusionStatus(characterId, userId);
  }
  return sendResult(res, result);
}));

router.post('/fusion/mark-result-viewed', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await partnerFusionService.markResultViewed(characterId);
  if (result.success) {
    await notifyPartnerFusionStatus(characterId, req.userId);
  }
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
    metadata: itemInstance.metadata,
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
  const techniqueId = parseNonEmptyText(getSingleQueryValue(req.query?.techniqueId));
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
  const techniqueId = parseNonEmptyText(typeof req.body?.techniqueId === 'string' ? req.body.techniqueId : undefined);
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
