import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
/**
 * 九州修仙录 - 背包路由
 */
import { requireCharacter } from '../middleware/auth.js';
import {
  craftService,
  gemSynthesisService,
  inventoryService,
  type InventoryLocation,
  itemService,
} from '../domains/inventory/index.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { getSingleQueryValue, parseNonEmptyText, parsePositiveInt } from '../services/shared/httpParam.js';
import { getCharacterComputedByCharacterId } from '../services/characterComputedService.js';
import { enqueuePartnerReboneJob } from '../services/partnerReboneJobRunner.js';
import { notifyPartnerReboneStatus } from '../services/partnerRebonePush.js';
import { partnerReboneService } from '../services/partnerReboneService.js';
import { sendSuccess, sendResult } from '../middleware/response.js';
import { BusinessError } from '../middleware/BusinessError.js';

const router = Router();


const allowedLocations = ['bag', 'warehouse', 'equipped'] as const;
const allowedSlottedLocations = ['bag', 'warehouse'] as const;

const isAllowedLocation = (value: unknown): value is InventoryLocation =>
  typeof value === 'string' && (allowedLocations as readonly string[]).includes(value);

const isAllowedSlottedLocation = (value: unknown): value is (typeof allowedSlottedLocations)[number] =>
  typeof value === 'string' && (allowedSlottedLocations as readonly string[]).includes(value);

const parseOptionalPositiveInt = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parsePositiveInt(value);
  return parsed ?? NaN;
};

const parseOptionalNonNegativeInt = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return NaN;
  return parsed;
};

const parseNonNegativeIntArray = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const raw of value) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    out.push(parsed);
  }
  return out;
};

const parsePositiveIntArray = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const raw of value) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    out.push(parsed);
  }
  return out;
};

const parseBodyItemInstanceId = (body: {
  itemId?: unknown;
  itemInstanceId?: unknown;
  instanceId?: unknown;
}): number => {
  const rawItemInstanceId = body.itemInstanceId ?? body.instanceId ?? body.itemId;
  if (rawItemInstanceId === undefined || rawItemInstanceId === null) {
    throw new BusinessError('参数不完整');
  }
  const parsedItemId = Number(rawItemInstanceId);
  if (!Number.isInteger(parsedItemId) || parsedItemId <= 0) {
    throw new BusinessError('itemId参数错误');
  }
  return parsedItemId;
};


router.use(requireCharacter);
router.use(asyncHandler(async (req, _res, next) => {
  await inventoryService.prepareInventoryInteraction(req.characterId!);
  next();
}));

// ============================================
// 获取背包信息
// GET /api/inventory/info
// ============================================
router.get('/info', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const info = await inventoryService.getInventoryInfo(characterId);
    sendSuccess(res, info);
}));

// ============================================
// 获取背包弹窗快照
// GET /api/inventory/bag/snapshot
// ============================================
router.get('/bag/snapshot', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const snapshot = await inventoryService.getBagInventorySnapshot(characterId);
    sendSuccess(res, snapshot);
}));

// ============================================
// 获取背包物品列表
// GET /api/inventory/items?location=bag&page=1&pageSize=100
// ============================================
router.get('/items', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const location = parseNonEmptyText(getSingleQueryValue(req.query.location)) ?? 'bag';
    if (!isAllowedLocation(location)) {
      throw new BusinessError('location参数错误');
    }
    const page = parsePositiveInt(getSingleQueryValue(req.query.page)) ?? 1;
    const pageSize = Math.min(parsePositiveInt(getSingleQueryValue(req.query.pageSize)) ?? 100, 200);

    const result = await inventoryService.getInventoryItemsWithDefs(characterId, location, page, pageSize);

    sendSuccess(res, {
      items: result.items,
      total: result.total,
      page,
      pageSize,
    });
}));

// ============================================
// 获取炼制配方列表
// GET /api/inventory/craft/recipes?recipeType=craft
// ============================================
router.get('/craft/recipes', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const recipeType = parseNonEmptyText(getSingleQueryValue(req.query.recipeType)) ?? undefined;
    const result = await craftService.getCraftRecipeList(userId, { recipeType });
    return sendResult(res, result);
}));

// ============================================
// 执行炼制
// POST /api/inventory/craft/execute
// Body: { recipeId: string, times?: number }
// ============================================
router.post('/craft/execute', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const recipeId = parseNonEmptyText(typeof req.body?.recipeId === 'string' ? req.body.recipeId : undefined);
    const parsedTimes = req.body?.times === undefined || req.body?.times === null ? undefined : parsePositiveInt(req.body.times);
    const times = parsedTimes ?? undefined;

    if (!recipeId) {
      throw new BusinessError('recipeId参数错误');
    }
    if (req.body?.times !== undefined && req.body?.times !== null && parsedTimes === null) {
      throw new BusinessError('times参数错误');
    }

    const result = await craftService.executeCraftRecipe(userId, { recipeId, ...(times !== undefined ? { times } : {}) });
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return sendResult(res, result);
}));

// ============================================
// 获取宝石合成配方列表
// GET /api/inventory/gem/recipes
// ============================================
router.get('/gem/recipes', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const result = await gemSynthesisService.getGemSynthesisRecipeList(characterId);
    return sendResult(res, result);
}));

// ============================================
// 获取宝石转换选项
// GET /api/inventory/gem/convert/options
// ============================================
router.get('/gem/convert/options', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const result = await gemSynthesisService.getGemConvertOptions(characterId);
    return sendResult(res, result);
}));

// ============================================
// 执行宝石转换
// POST /api/inventory/gem/convert
// Body: { selectedGemItemIds: number[], times?: number }（必须手动选择2个宝石）
// ============================================
router.post('/gem/convert', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const selectedGemItemIds = parsePositiveIntArray(req.body?.selectedGemItemIds);
    if (!selectedGemItemIds || selectedGemItemIds.length !== 2) {
      throw new BusinessError('selectedGemItemIds参数错误，需要手动选择2个宝石');
    }
    const parsedTimes = parseOptionalPositiveInt(req.body?.times);
    if (Number.isNaN(parsedTimes)) {
      throw new BusinessError('times参数错误');
    }

    const result = await gemSynthesisService.convertGem(characterId, userId, {
      selectedGemItemIds,
      ...(parsedTimes !== undefined ? { times: parsedTimes } : {}),
    });

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return sendResult(res, result);
}));

// ============================================
// 执行宝石合成
// POST /api/inventory/gem/synthesize
// Body: { recipeId: string, times?: number }
// ============================================
router.post('/gem/synthesize', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const recipeId = parseNonEmptyText(typeof req.body?.recipeId === 'string' ? req.body.recipeId : undefined);
    if (!recipeId) {
      throw new BusinessError('recipeId参数错误');
    }

    const parsedTimes = parseOptionalPositiveInt(req.body?.times);
    if (Number.isNaN(parsedTimes)) {
      throw new BusinessError('times参数错误');
    }

    const result = await gemSynthesisService.synthesizeGem(characterId, userId, {
      recipeId,
      ...(parsedTimes !== undefined ? { times: parsedTimes } : {}),
    });

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return sendResult(res, result);
}));

// ============================================
// 批量宝石合成到目标等级
// POST /api/inventory/gem/synthesize/batch
// Body: { gemType: string, targetLevel: number, sourceLevel?: number, seriesKey?: string }
// ============================================
router.post('/gem/synthesize/batch', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const gemType = parseNonEmptyText(typeof req.body?.gemType === 'string' ? req.body.gemType : undefined);
    if (!gemType) {
      throw new BusinessError('gemType参数错误');
    }

    const targetLevel = parsePositiveInt(req.body?.targetLevel);
    if (!targetLevel || targetLevel < 2 || targetLevel > 10) {
      throw new BusinessError('targetLevel参数错误');
    }

    const parsedSourceLevel = parseOptionalPositiveInt(req.body?.sourceLevel);
    if (Number.isNaN(parsedSourceLevel)) {
      throw new BusinessError('sourceLevel参数错误');
    }
    const seriesKey = parseNonEmptyText(typeof req.body?.seriesKey === 'string' ? req.body.seriesKey : undefined) ?? undefined;

    const result = await gemSynthesisService.synthesizeGemBatch(characterId, userId, {
      gemType,
      targetLevel,
      ...(parsedSourceLevel !== undefined ? { sourceLevel: parsedSourceLevel } : {}),
      ...(seriesKey ? { seriesKey } : {}),
    });

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return sendResult(res, result);
}));

// ============================================
// 移动物品
// POST /api/inventory/move
// ============================================
router.post('/move', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const { itemId, targetLocation, targetSlot } = req.body;

    if (itemId === undefined || targetLocation === undefined) {
      throw new BusinessError('参数不完整');
    }

    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });

    if (!isAllowedSlottedLocation(targetLocation)) {
      throw new BusinessError('targetLocation参数错误');
    }

    const parsedTargetSlot = parseOptionalNonNegativeInt(targetSlot);
    if (Number.isNaN(parsedTargetSlot)) {
      throw new BusinessError('targetSlot参数错误');
    }

    const result = await inventoryService.moveItem(
      characterId,
      parsedItemId,
      targetLocation,
      parsedTargetSlot
    );

    sendResult(res, result);
}));

router.post('/use', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { itemId, itemInstanceId, instanceId, qty, targetItemInstanceId, partnerId } = req.body as {
      itemId?: unknown;
      itemInstanceId?: unknown;
      instanceId?: unknown;
      qty?: unknown;
      targetItemInstanceId?: unknown;
      partnerId?: unknown;
    };
    const parsedItemId = parseBodyItemInstanceId({ itemId, itemInstanceId, instanceId });
    const parsedQty = qty === undefined || qty === null ? 1 : parsePositiveInt(qty);
    if (!parsedQty) {
      throw new BusinessError('qty参数错误');
    }

    const parsedTargetItemInstanceId = parseOptionalPositiveInt(targetItemInstanceId);
    if (Number.isNaN(parsedTargetItemInstanceId)) {
      throw new BusinessError('targetItemInstanceId参数错误');
    }
    const parsedPartnerId = parseOptionalPositiveInt(partnerId);
    if (Number.isNaN(parsedPartnerId)) {
      throw new BusinessError('partnerId参数错误');
    }

    const result = await itemService.useItem(userId, characterId, parsedItemId, parsedQty, {
      ...(parsedTargetItemInstanceId !== undefined ? { targetItemInstanceId: parsedTargetItemInstanceId } : {}),
      ...(parsedPartnerId !== undefined ? { partnerId: parsedPartnerId } : {}),
    });
    if (!result.success) {
      return sendResult(res, result);
    }

    if (result.partnerReboneJob) {
      try {
        await enqueuePartnerReboneJob({
          reboneId: result.partnerReboneJob.reboneId,
          characterId,
          userId,
        });
        await notifyPartnerReboneStatus(characterId, userId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知异常';
        await partnerReboneService.forceFailPendingReboneJob(
          characterId,
          result.partnerReboneJob.reboneId,
          `归元洗髓任务投递失败：${reason}`,
        );
        await notifyPartnerReboneStatus(characterId, userId);
        await safePushCharacterUpdate(userId);
        return sendResult(res, {
          success: false,
          message: '归元洗髓启动失败，道具已退回背包',
        });
      }
    }

    await safePushCharacterUpdate(userId);

    return sendSuccess(res, {
      character: result.character,
      lootResults: result.lootResults,
      partnerTechniqueResult: result.partnerTechniqueResult,
    });
}));

// ============================================
// 穿戴装备
// POST /api/inventory/equip
// Body: { itemId: number }
// ============================================
router.post('/equip', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });

    const result = await inventoryService.equipItem(characterId, userId, parsedItemId);
    if (!result.success) {
      return sendResult(res, result);
    }

    const character = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });

    await safePushCharacterUpdate(userId);

    return sendSuccess(res, { character });
}));

// ============================================
// 卸下装备
// POST /api/inventory/unequip
// Body: { itemId: number, targetLocation?: 'bag' | 'warehouse' }
// ============================================
router.post('/unequip', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { targetLocation } = req.body;
    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });

    if (targetLocation !== undefined && !isAllowedSlottedLocation(targetLocation)) {
      throw new BusinessError('targetLocation参数错误');
    }

    const result = await inventoryService.unequipItem(characterId, parsedItemId, {
      targetLocation: targetLocation || 'bag',
    });
    if (!result.success) {
      return sendResult(res, result);
    }

    const character = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });

    await safePushCharacterUpdate(userId);

    return sendSuccess(res, { character });
}));

// ============================================
// 强化装备
// POST /api/inventory/enhance
// Body: { itemId: number }
// ============================================
router.post('/enhance', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(
      req.body as {
        itemId?: unknown;
        itemInstanceId?: unknown;
        instanceId?: unknown;
      },
    );

    const result = await inventoryService.enhanceEquipment(characterId, userId, parsedItemId);

    if (result.success || result.data?.destroyed || result.data?.failMode === 'downgrade') {
      await safePushCharacterUpdate(userId);
    }

    return res.json({
      success: result.success,
      message: result.message,
      data: result.data ?? {
        strengthenLevel: 0,
        character: null,
      },
    });
}));

// ============================================
// 精炼装备
// POST /api/inventory/refine
// Body: { itemId: number }
// ============================================
router.post('/refine', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(
      req.body as {
        itemId?: unknown;
        itemInstanceId?: unknown;
        instanceId?: unknown;
      },
    );

    const result = await inventoryService.refineEquipment(characterId, userId, parsedItemId);

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return res.json({
      success: result.success,
      message: result.message,
      data: result.data ?? {
        refineLevel: 0,
        character: null,
      },
    });
}));

// ============================================
// 强化/精炼消耗预览
// POST /api/inventory/growth/cost-preview
// Body: { itemId: number }
// ============================================
router.post('/growth/cost-preview', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(
      req.body as {
        itemId?: unknown;
        itemInstanceId?: unknown;
        instanceId?: unknown;
      },
    );

    const result = await inventoryService.getEquipmentGrowthCostPreview(characterId, parsedItemId);
    return sendResult(res, result);
}));

// ============================================
// 洗炼消耗预览
// POST /api/inventory/reroll-affixes/cost-preview
// Body: { itemId: number }
// ============================================
router.post('/reroll-affixes/cost-preview', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });
    const result = await inventoryService.getRerollCostPreview(characterId, parsedItemId);
    return sendResult(res, result);
}));

// ============================================
// 洗炼词条池预览
// POST /api/inventory/reroll-affixes/pool-preview
// Body: { itemId: number }
// ============================================
router.post('/reroll-affixes/pool-preview', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });
    const result = await inventoryService.getAffixPoolPreview(characterId, parsedItemId);
    return sendResult(res, result);
}));

// ============================================
// 装备词条洗炼
// POST /api/inventory/reroll-affixes
// Body: { itemId: number, lockIndexes?: number[] }
// ============================================
router.post('/reroll-affixes', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { lockIndexes } = req.body as {
      itemId?: unknown;
      lockIndexes?: unknown;
    };
    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });

    let parsedLockIndexes: number[] = [];
    if (lockIndexes !== undefined) {
      const normalized = parseNonNegativeIntArray(lockIndexes);
      if (!normalized) {
        throw new BusinessError('lockIndexes参数错误');
      }
      parsedLockIndexes = normalized;
    }

    const result = await inventoryService.rerollEquipmentAffixes(
      characterId,
      userId,
      parsedItemId,
      parsedLockIndexes
    );

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return res.json({
      success: result.success,
      message: result.message,
      data: result.data ?? null,
    });
}));

// ============================================
// 镶嵌宝石
// POST /api/inventory/socket
// Body: { itemId: number, gemItemId: number, slot?: number }
// ============================================
router.post('/socket', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const {
      itemId,
      itemInstanceId,
      instanceId,
      gemItemId,
      gemItemInstanceId,
      gemInstanceId,
      slot,
    } = req.body as {
      itemId?: unknown;
      itemInstanceId?: unknown;
      instanceId?: unknown;
      gemItemId?: unknown;
      gemItemInstanceId?: unknown;
      gemInstanceId?: unknown;
      slot?: unknown;
    };

    const parsedItemId = parseBodyItemInstanceId({ itemId, itemInstanceId, instanceId });
    const parsedGemItemId = parseBodyItemInstanceId({
      itemId: gemItemId,
      itemInstanceId: gemItemInstanceId,
      instanceId: gemInstanceId,
    });

    const parsedSlot = parseOptionalNonNegativeInt(slot);
    if (Number.isNaN(parsedSlot)) {
      throw new BusinessError('slot参数错误');
    }

    const result = await inventoryService.socketEquipment(characterId, userId, parsedItemId, parsedGemItemId, {
      slot: parsedSlot,
    });

    if (result.success) {
      await safePushCharacterUpdate(userId);
    }

    return res.json({
      success: result.success,
      message: result.message,
      data: result.data ?? null,
    });
}));

// ============================================
// 分解奖励预览
// POST /api/inventory/disassemble/preview
// Body: { itemId: number, qty: number }
// ============================================
router.post('/disassemble/preview', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const parsedItemId = parseBodyItemInstanceId(
      req.body as {
        itemId?: unknown;
        itemInstanceId?: unknown;
        instanceId?: unknown;
      },
    );
    const parsedQty = parsePositiveInt((req.body as { qty?: unknown }).qty);
    if (parsedQty === null) {
      throw new BusinessError('qty参数错误');
    }

    const result = await inventoryService.getDisassembleRewardPreview(characterId, parsedItemId, parsedQty);
    return sendResult(res, result);
}));

// ============================================
// 分解物品
// POST /api/inventory/disassemble
// Body: { itemId: number, qty: number }
// ============================================
router.post('/disassemble', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { qty } = req.body as { itemId?: unknown; qty?: unknown };
    if (qty === undefined || qty === null) {
      throw new BusinessError('参数不完整');
    }

    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });
    const parsedQty = parsePositiveInt(qty);
    if (!parsedQty) {
      throw new BusinessError('qty参数错误');
    }

    const result = await inventoryService.disassembleEquipment(characterId, userId, parsedItemId, parsedQty);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return sendResult(res, result);
}));

// ============================================
// 批量分解物品
// POST /api/inventory/disassemble/batch
// Body: { items: Array<{ itemId: number; qty: number }> }
// ============================================
router.post('/disassemble/batch', asyncHandler(async (req, res) => {
    const userId = req.userId!;
    const characterId = req.characterId!;

    const { items } = req.body as { items?: unknown };
    if (!Array.isArray(items) || items.length === 0) {
      throw new BusinessError('items参数错误');
    }

    const parsedItems: Array<{ itemId: number; qty: number }> = [];
    for (const row of items) {
      if (!row || typeof row !== 'object') {
        throw new BusinessError('items参数错误');
      }
      const itemId = parsePositiveInt((row as { itemId?: unknown }).itemId);
      const qty = parsePositiveInt((row as { qty?: unknown }).qty);
      if (!itemId || !qty) {
        throw new BusinessError('items参数错误');
      }
      parsedItems.push({ itemId, qty });
    }

    const result = await inventoryService.disassembleEquipmentBatch(characterId, userId, parsedItems);
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
    return sendResult(res, result);
}));

// ============================================
// 丢弃/删除物品
// POST /api/inventory/remove
// ============================================
router.post('/remove', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const { qty } = req.body;
    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });
    const parsedQty = qty === undefined || qty === null ? 1 : parsePositiveInt(qty);
    if (!parsedQty) {
      throw new BusinessError('qty参数错误');
    }

    const result = await inventoryService.removeItemFromInventory(
      characterId,
      parsedItemId,
      parsedQty
    );

    sendResult(res, result);
}));

// ============================================
// 批量丢弃/删除物品
// POST /api/inventory/remove/batch
// Body: { itemIds: number[] }
// ============================================
router.post('/remove/batch', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const { itemIds } = req.body as { itemIds?: unknown };
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      throw new BusinessError('itemIds参数错误');
    }

    const parsedIds = parsePositiveIntArray(itemIds);
    if (!parsedIds || parsedIds.length === 0) {
      throw new BusinessError('itemIds参数错误');
    }

    const result = await inventoryService.removeItemsBatch(characterId, parsedIds);
    return sendResult(res, result);
}));

// ============================================
// 整理背包
// POST /api/inventory/sort
// ============================================
router.post('/sort', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const { location } = req.body;
    const resolvedLocation = location === undefined || location === null ? 'bag' : location;
    if (!isAllowedSlottedLocation(resolvedLocation)) {
      throw new BusinessError('location参数错误');
    }
    const result = await inventoryService.sortInventory(characterId, resolvedLocation);

    sendResult(res, result);
}));

// ============================================
// 扩容背包
// POST /api/inventory/expand
// ============================================
router.post('/expand', asyncHandler(async (req, res) => {
  throw new BusinessError('请通过使用扩容道具进行扩容', 403);
}));

// ============================================
// 锁定/解锁物品
// POST /api/inventory/lock
// ============================================
router.post('/lock', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const { locked } = req.body;

    if (locked === undefined) {
      throw new BusinessError('参数不完整');
    }

    const parsedItemId = parseBodyItemInstanceId(req.body as { itemId?: unknown });

    if (typeof locked !== 'boolean') {
      throw new BusinessError('locked参数错误');
    }

    const result = await inventoryService.setItemLocked(characterId, parsedItemId, locked);
    return sendResult(res, result);
}));

export default router;
