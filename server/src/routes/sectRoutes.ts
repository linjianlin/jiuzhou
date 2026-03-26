import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import {
  acceptSectQuest,
  applyToSect,
  appointPosition,
  buyFromSectShop,
  cancelMyApplication,
  claimSectQuest,
  createSect,
  disbandSect,
  donate,
  getBuildings,
  getCharacterSect,
  getSectBonuses,
  getSectInfo,
  getSectLogs,
  getSectQuests,
  getSectShop,
  handleApplication,
  kickMember,
  leaveSect,
  listApplications,
  listMyApplications,
  searchSects,
  submitSectQuest,
  transferLeader,
  updateSectAnnouncement,
  upgradeBuilding,
} from '../services/sectService.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { getCharacterSectId } from '../services/sect/db.js';
import { getSingleParam, getSingleQueryValue, parseFiniteNumber, parseNonEmptyText } from '../services/shared/httpParam.js';
import { listSectMemberCharacterIds } from '../services/sect/indicator.js';
import { getSectApplicationScopeById, listVisiblePendingApplicationSectIdsByCharacterId } from '../services/sect/pendingApplications.js';
import {
  notifySectIndicatorByApplicationId,
  notifySectIndicatorToCharacterIds,
  notifySectIndicatorToSectManagers,
} from '../services/sect/indicatorPush.js';

const router = Router();



const parseBodyNumber = (v: unknown): number | undefined => {
  return parseFiniteNumber(v);
};

const notifySectIndicatorToPendingManagers = (sectIds: readonly string[]): void => {
  const uniqueSectIds = Array.from(new Set(sectIds.map((sectId) => sectId.trim()).filter((sectId) => sectId.length > 0)));
  for (const sectId of uniqueSectIds) {
    notifySectIndicatorToSectManagers(sectId);
  }
};

router.use(requireCharacter);

router.get('/me', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await getCharacterSect(characterId);
  return sendResult(res, result);
}));

router.get('/search', asyncHandler(async (req, res) => {
  const keyword = parseNonEmptyText(getSingleQueryValue(req.query.keyword)) ?? undefined;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const limit = parseFiniteNumber(getSingleQueryValue(req.query.limit));
  const result = await searchSects(keyword, page, limit);
  return sendResult(res, result);
}));

router.post('/create', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;

  const body = req.body as { name?: unknown; description?: unknown };
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description : undefined;

  if (!name) throw new BusinessError('宗门名称不能为空');
  if (name.length > 16) throw new BusinessError('宗门名称过长');

  const pendingApplicationSectIds = await listVisiblePendingApplicationSectIdsByCharacterId(characterId);
  const result = await createSect(characterId, name, description);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    notifySectIndicatorToCharacterIds([characterId]);
    notifySectIndicatorToPendingManagers(pendingApplicationSectIds);
  }
  return sendResult(res, result);
}));

router.post('/apply', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { sectId?: unknown; message?: unknown };
  const sectId = typeof body?.sectId === 'string' ? body.sectId : '';
  const message = typeof body?.message === 'string' ? body.message : undefined;
  const pendingApplicationSectIds = await listVisiblePendingApplicationSectIdsByCharacterId(characterId);
  const result = await applyToSect(characterId, sectId, message);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    const joinedSectId = await getCharacterSectId(characterId);
    if (joinedSectId) {
      notifySectIndicatorToCharacterIds([characterId]);
      notifySectIndicatorToPendingManagers(pendingApplicationSectIds);
    } else {
      notifySectIndicatorToSectManagers(sectId, [characterId]);
    }
  }
  return sendResult(res, result);
}));

router.get('/applications/list', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await listApplications(characterId);
  return sendResult(res, result);
}));

router.get('/applications/mine', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await listMyApplications(characterId);
  return sendResult(res, result);
}));

router.post('/applications/handle', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { applicationId?: unknown; approve?: unknown };
  const applicationId = parseBodyNumber(body?.applicationId);
  const approve = typeof body?.approve === 'boolean' ? body.approve : body?.approve === 'true';
  if (!applicationId) throw new BusinessError('参数错误');
  const applicationScope = await getSectApplicationScopeById(applicationId);
  const pendingApplicationSectIds = applicationScope
    ? await listVisiblePendingApplicationSectIdsByCharacterId(applicationScope.characterId)
    : [];
  const result = await handleApplication(characterId, applicationId, approve);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    notifySectIndicatorByApplicationId(applicationId);
    if (applicationScope) {
      notifySectIndicatorToPendingManagers(
        pendingApplicationSectIds.filter((sectId) => sectId !== applicationScope.sectId)
      );
    }
  }
  return sendResult(res, result);
}));

router.post('/applications/cancel', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { applicationId?: unknown };
  const applicationId = parseBodyNumber(body?.applicationId);
  if (!applicationId) throw new BusinessError('参数错误');
  const result = await cancelMyApplication(characterId, applicationId);
  if (result.success) {
    notifySectIndicatorByApplicationId(applicationId);
  }
  return sendResult(res, result);
}));

router.post('/leave', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const result = await leaveSect(characterId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    notifySectIndicatorToCharacterIds([characterId]);
  }
  return sendResult(res, result);
}));

router.post('/kick', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { targetId?: unknown };
  const targetId = parseBodyNumber(body?.targetId);
  if (!targetId) throw new BusinessError('参数错误');
  const result = await kickMember(characterId, targetId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
    notifySectIndicatorToCharacterIds([targetId]);
  }
  return sendResult(res, result);
}));

router.post('/appoint', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { targetId?: unknown; position?: unknown };
  const targetId = parseBodyNumber(body?.targetId);
  const position = typeof body?.position === 'string' ? body.position : '';
  if (!targetId || !position) throw new BusinessError('参数错误');
  const result = await appointPosition(characterId, targetId, position);
  if (result.success) {
    notifySectIndicatorToCharacterIds([targetId]);
  }
  return sendResult(res, result);
}));

router.post('/transfer', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { newLeaderId?: unknown };
  const newLeaderId = parseBodyNumber(body?.newLeaderId);
  if (!newLeaderId) throw new BusinessError('参数错误');
  const result = await transferLeader(characterId, newLeaderId);
  if (result.success) {
    notifySectIndicatorToCharacterIds([characterId, newLeaderId]);
  }
  return sendResult(res, result);
}));

router.post('/disband', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const formerSectId = await getCharacterSectId(characterId);
  const formerMemberIds = formerSectId ? await listSectMemberCharacterIds(formerSectId) : [characterId];
  const result = await disbandSect(characterId);
  if (result.success) {
    notifySectIndicatorToCharacterIds(formerMemberIds);
  }
  return sendResult(res, result);
}));

router.post('/announcement/update', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { announcement?: unknown };
  const announcement = typeof body?.announcement === 'string' ? body.announcement : '';
  const result = await updateSectAnnouncement(characterId, announcement);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.post('/donate', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { spiritStones?: unknown };
  const result = await donate(characterId, parseBodyNumber(body?.spiritStones));
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.get('/buildings/list', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await getBuildings(characterId);
  return sendResult(res, result);
}));

router.post('/buildings/upgrade', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { buildingType?: unknown };
  const buildingType = typeof body?.buildingType === 'string' ? body.buildingType.trim() : '';
  if (!buildingType) throw new BusinessError('参数错误');
  if (buildingType !== 'hall') {
    throw new BusinessError('当前仅开放宗门大殿升级');
  }
  const result = await upgradeBuilding(characterId, buildingType);
  return sendResult(res, result);
}));

router.get('/bonuses', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await getSectBonuses(characterId);
  return sendResult(res, result);
}));

router.get('/quests', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await getSectQuests(characterId);
  return sendResult(res, result);
}));

router.post('/quests/accept', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = req.body as { questId?: unknown };
  const questId = typeof body?.questId === 'string' ? body.questId : '';
  if (!questId) throw new BusinessError('参数错误');
  const result = await acceptSectQuest(characterId, questId);
  return sendResult(res, result);
}));

router.post('/quests/claim', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { questId?: unknown };
  const questId = typeof body?.questId === 'string' ? body.questId : '';
  if (!questId) throw new BusinessError('参数错误');
  const result = await claimSectQuest(characterId, questId);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.post('/quests/submit', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { questId?: unknown; quantity?: unknown };
  const questId = typeof body?.questId === 'string' ? body.questId : '';
  const quantity = parseBodyNumber(body?.quantity);
  if (!questId) throw new BusinessError('参数错误');
  const result = await submitSectQuest(characterId, questId, quantity);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.get('/shop', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const result = await getSectShop(characterId);
  return sendResult(res, result);
}));

router.post('/shop/buy', asyncHandler(async (req, res) => {
  const userId = req.userId!;
  const characterId = req.characterId!;
  const body = req.body as { itemId?: unknown; quantity?: unknown };
  const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
  const quantity = parseBodyNumber(body?.quantity) ?? 1;
  if (!itemId) throw new BusinessError('参数错误');
  const result = await buyFromSectShop(characterId, itemId, quantity);
  if (result.success) {
    await safePushCharacterUpdate(userId);
  }
  return sendResult(res, result);
}));

router.get('/logs', asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const limit = parseFiniteNumber(getSingleQueryValue(req.query.limit));
  const result = await getSectLogs(characterId, limit);
  return sendResult(res, result);
}));

router.get('/:sectId', asyncHandler(async (req, res) => {
  const sectId = parseNonEmptyText(getSingleParam(req.params.sectId));
  if (!sectId) throw new BusinessError('参数错误');
  const result = await getSectInfo(sectId);
  return res.status(result.success ? 200 : 404).json(result);
}));

export default router;
