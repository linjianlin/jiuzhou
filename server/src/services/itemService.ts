/**
 * 九州修仙录 - 统一物品服务
 *
 * 作用：根据物品类型自动选择处理方式
 * - 装备类：生成词条后创建实例
 * - 普通物品：直接创建实例（支持堆叠）
 *
 * 数据流：调用方 → ItemService 方法 → inventory / equipmentService 底层
 *
 * 边界条件：
 * 1) useItem 使用 @Transactional 保证物品使用与资源更新的原子性
 * 2) createItem 支持在事务/非事务上下文中调用，内部统一复用 inventoryService / equipmentService 的事务入口
 */
import { hasUsableTransactionContext, query, withTransaction } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { equipmentService, generateEquipment, type GenerateOptions, type GeneratedEquipment } from './equipmentService.js';
import {
  expandInventory,
  SlottedInventoryLocation,
} from './inventory/index.js';
import { inventoryService } from './inventory/service.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import { buildEquipmentDisplayBaseAttrs, type CharacterAttrRecord } from './equipmentGrowthRules.js';
import { loadCharacterRealmSnapshot } from './shared/characterRealm.js';
import { getRealmRankZeroBased } from './shared/realmRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { shouldValidateTechniqueLearnRealm } from './shared/techniqueLearnRule.js';
import { isCharacterVisibleTechniqueDefinition } from './shared/techniqueUsageScope.js';
import { resolveTechniqueBookLearning } from './shared/techniqueBookRules.js';
import { resolveItemUseResourceDelta, rollItemUseAmount } from './shared/itemUseValueRules.js';
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByCharacterId,
  type CharacterComputedRow,
} from './characterComputedService.js';
import { getItemDefinitionById, getItemDefinitions, getTechniqueDefinitions } from './staticConfigLoader.js';
import { getGemLevel, isGemItemDefinition } from './shared/gemItemSemantics.js';
import { unbindEquipmentBindingByInstanceId } from './inventory/equipmentUnbind.js';
import type { PartnerLearnTechniqueResultDto } from './partnerService.js';
import { partnerService } from './partnerService.js';
import { partnerReboneService } from './partnerReboneService.js';
import { recoverStaminaByCharacterId } from './staminaService.js';
import type { CharacterBagSlotAllocator } from './shared/characterBagSlotAllocator.js';
import type { CharacterInventoryMutationContext } from './shared/characterInventoryMutationContext.js';
import type { InventorySlotSession } from './shared/inventorySlotSession.js';
import { applyCharacterRewardDeltas, createCharacterRewardDelta } from './shared/characterRewardSettlement.js';
import { bufferSimpleCharacterItemGrants } from './shared/characterItemGrantDeltaService.js';
import { bufferCharacterItemInstanceMutations, loadProjectedCharacterItemInstanceById } from './shared/characterItemInstanceMutationService.js';
import { consumeSpecificItemInstance } from './inventory/shared/consume.js';

// 物品定义接口
export interface ItemDef {
  id: string;
  name: string;
  category: string;
  sub_category: string;
  quality: string;
  quality_rank: number;
  stack_max: number;
  bind_type: string;
  icon: string;
}

// 创建物品选项
export interface CreateItemOptions {
  location?: SlottedInventoryLocation;
  /** 奖励事务已统一锁背包时，可直接指定目标槽位，避免重复扫空槽。 */
  locationSlot?: number;
  bindType?: string;
  obtainedFrom?: string;
  metadata?: JsonObject | null;
  quality?: string | null;
  qualityRank?: number | null;
  /** 奖励链路共享的新槽位分配器，只负责 bag 位置的新格子消费。 */
  bagSlotAllocator?: CharacterBagSlotAllocator;
  /** 奖励事务内共享的库存视图缓存，用于复用容量与普通堆叠承载实例。 */
  inventoryMutationContext?: CharacterInventoryMutationContext;
  /** 事务级统一槽位会话，统一管理容量、空槽与普通堆叠视图。 */
  slotSession?: InventorySlotSession;
  /** 调用方已持有角色背包互斥锁时，跳过底层重复加锁 SQL。 */
  skipInventoryMutexLock?: boolean;
  /** 需要严格受当前事务 / savepoint 控制时，改为立即写入真实实例表。 */
  persistImmediately?: boolean;
  // 装备专用选项
  equipOptions?: GenerateOptions & {
    /**
     * 作用：
     * - 复用上游已经完成品质/词条判定的预生成装备，避免奖励热路径里重复随机生成同一件装备。
     * - 不负责缓存多件装备；仅用于“单件已预生成、随后立刻落库”的链路。
     *
     * 输入 / 输出：
     * - 输入：由上游生成好的装备快照。
     * - 输出：createItem 在命中时直接把该快照传给装备实例创建入口。
     *
     * 数据流 / 状态流：
     * - 奖励服务预生成装备 -> 通过 equipOptions 透传到 itemService -> createEquipmentInstance 落库。
     *
     * 复用设计说明：
     * - 继续复用 itemService 这个统一物品创建边界，不额外新增“奖励专用创建装备”入口，避免装备落库逻辑再分叉一套。
     * - 当前主要被自动分解奖励链路复用，后续其他需要“先判定后落库”的装备奖励也可复用同一入口。
     *
     * 关键边界条件与坑点：
     * 1. 仅首件装备允许消费该预生成结果，批量创建其余件仍需独立随机生成，避免多件装备复用同一随机种子。
     * 2. 预生成结果只解决“重复生成”，不绕开 createEquipmentInstance 的背包锁与落格校验。
     */
    preGeneratedEquipment?: GeneratedEquipment;
  };
}

// 创建物品结果
export interface CreateItemResult {
  success: boolean;
  message: string;
  itemIds?: number[];
  equipment?: GeneratedEquipment;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

type ItemUseEffect = JsonObject;

type ItemUseCooldownRow = {
  cooldown_until: Date | string | null;
};

type ItemUseCountRow = {
  daily_count: number;
  total_count: number;
  last_daily_reset: Date | string | null;
};

const buildCreateItemSavepointName = (): string => {
  return `item_create_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
};

type ItemInstanceRow = {
  id: number;
  item_def_id: string;
  qty: number;
  locked: boolean;
  quality: string | null;
  quality_rank: number | null;
  strengthen_level: number | null;
  refine_level: number | null;
  socketed_gems: JsonValue | null;
  affixes: JsonValue[] | null;
  identified: boolean | null;
  bind_type: string | null;
  location: string | null;
  location_slot: number | null;
  equipped_slot: string | null;
  metadata: JsonObject | null;
  created_at: Date | string | null;
};

/**
 * 统一 itemService 对外返回结构，避免“使用结果”和“物品详情”在路由层各自拼装第二套类型。
 * 这样 partnerRoutes / inventoryRoutes 只消费单一出口，后续物品字段增减也只需在服务边界调整一次。
 */
export interface ItemUseLootResult {
  type: string;
  name?: string;
  amount: number;
}

export interface ItemUseResult {
  success: boolean;
  message: string;
  effects?: ItemUseEffect[];
  character?: CharacterComputedRow | null;
  lootResults?: ItemUseLootResult[];
  partnerTechniqueResult?: PartnerLearnTechniqueResultDto;
  partnerReboneJob?: {
    reboneId: string;
    partnerId: number;
  };
}

export interface ItemInstanceDetail {
  id: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  category: string;
  subCategory: string;
  quality: string | null;
  qualityRank: number;
  qty: number;
  stackMax: number;
  description: string | null;
  equipSlot: string | null;
  equipReqRealm: string | null;
  baseAttrs: CharacterAttrRecord;
  affixes: JsonValue[];
  setId: string | null;
  strengthenLevel: number | null;
  refineLevel: number | null;
  socketedGems: JsonValue | null;
  identified: boolean;
  locked: boolean;
  bindType: string | null;
  location: string | null;
  locationSlot: number | null;
  equippedSlot: string | null;
  metadata: JsonObject | null;
  createdAt: Date | string | null;
}

const DEFAULT_RANDOM_GEM_SUB_CATEGORIES = ['gem_attack', 'gem_defense', 'gem_survival'] as const;

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asJsonObject = (value: JsonValue | undefined): JsonObject | null => {
  return isJsonObject(value) ? value : null;
};

const asJsonArray = (value: JsonValue | undefined): JsonValue[] => {
  return Array.isArray(value) ? value : [];
};

const asTrimmedString = (value: JsonValue | undefined): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const asFiniteNumber = (value: JsonValue | undefined): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const getRealmRank = (realmRaw: JsonValue | undefined, subRealmRaw?: JsonValue | undefined): number => {
  return getRealmRankZeroBased(realmRaw, subRealmRaw);
};

const isRealmSufficient = (
  currentRealm: JsonValue | undefined,
  requiredRealm: JsonValue | undefined,
  currentSubRealm?: JsonValue | undefined,
): boolean => {
  const required = asTrimmedString(requiredRealm);
  if (!required) return true;
  return getRealmRank(currentRealm, currentSubRealm) >= getRealmRank(required);
};

const toPositiveInt = (value: JsonValue | undefined, fallback: number): number => {
  const n = asFiniteNumber(value);
  if (n === null) return fallback;
  return Math.max(1, Math.floor(n));
};

const toStringArray = (value: JsonValue | undefined): string[] => {
  return asJsonArray(value)
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry.length > 0);
};

type ItemUseTargetType = 'none' | 'bound_equipment';

const getItemUseTargetType = (effectDefs: readonly ItemUseEffect[]): ItemUseTargetType => {
  for (const effect of effectDefs) {
    if (String(effect.trigger || '') !== 'use') continue;
    if (asTrimmedString(effect.effect_type) !== 'unbind') continue;
    const params = asJsonObject(effect.params);
    if (asTrimmedString(params?.target_type) !== 'equipment') continue;
    if (asTrimmedString(params?.bind_state) !== 'bound') continue;
    return 'bound_equipment';
  }
  return 'none';
};

/**
 * 从静态配置获取物品定义（纯同步读取，无需数据库连接）
 */
const getItemDefSync = (itemDefId: string): ItemDef | null => {
  const def = getItemDefinitionById(itemDefId);
  if (!def || def.enabled === false) return null;

  return {
    id: def.id,
    name: String(def.name || def.id),
    category: String(def.category || ''),
    sub_category: String(def.sub_category || ''),
    quality: String(def.quality || ''),
    quality_rank: resolveQualityRankFromName(def.quality, 1),
    stack_max: Math.max(1, Number(def.stack_max) || 1),
    bind_type: String(def.bind_type || 'none'),
    icon: String(def.icon || ''),
  };
};

/**
 * 创建装备物品（生成词条）
 */
const createEquipmentItem = async (
  userId: number,
  characterId: number,
  itemDefId: string,
  qty: number,
  options: CreateItemOptions
): Promise<CreateItemResult> => {
  const itemIds: number[] = [];
  let lastEquipment: GeneratedEquipment | undefined;
  const preGeneratedEquipment = options.equipOptions?.preGeneratedEquipment;
  const location = options.location || 'bag';
  const reservedBagSlots =
    location === 'bag' && !options.slotSession && options.bagSlotAllocator
      ? options.bagSlotAllocator.reserveSlots(characterId, qty)
      : [];

  if (location === 'bag' && !options.slotSession && options.bagSlotAllocator && reservedBagSlots.length < qty) {
    return { success: false, message: '背包已满' };
  }

  const executeBatch = async (): Promise<CreateItemResult> => {
    const pendingMutations = [] as NonNullable<Awaited<ReturnType<typeof equipmentService.createEquipmentInstanceTx>>['pendingMutation']>[];
    for (let i = 0; i < qty; i++) {
      const generated =
        i === 0 && preGeneratedEquipment
          ? preGeneratedEquipment
          : await generateEquipment(itemDefId, options.equipOptions);
      if (!generated) {
        return { success: false, message: '装备生成失败' };
      }

      const result = await equipmentService.createEquipmentInstanceTx(userId, characterId, generated, {
        location,
        ...(options.slotSession ? { slotSession: options.slotSession } : {}),
        ...(reservedBagSlots[i] !== undefined ? { locationSlot: reservedBagSlots[i] } : {}),
        ...(options.locationSlot !== undefined ? { locationSlot: options.locationSlot } : {}),
        ...(reservedBagSlots[i] !== undefined && options.locationSlot === undefined
          ? { fallbackOnSlotConflict: true }
          : {}),
        bindType: options.bindType,
        obtainedFrom: options.obtainedFrom,
        ...(options.skipInventoryMutexLock ? { skipInventoryMutexLock: true } : {}),
        ...(options.persistImmediately ? { persistImmediately: true } : {}),
        ...(!options.persistImmediately ? { deferBufferedMutation: true } : {}),
      });

      if (!result.success) {
        return { success: false, message: result.message };
      }

      itemIds.push(result.instanceId!);
      lastEquipment = generated;
      if (!options.persistImmediately) {
        if (!result.pendingMutation) {
          return { success: false, message: '装备创建失败' };
        }
        pendingMutations.push(result.pendingMutation);
      }
    }

    if (!options.persistImmediately && pendingMutations.length > 0) {
      await bufferCharacterItemInstanceMutations(pendingMutations);
      if (options.slotSession) {
        for (const mutation of pendingMutations) {
          if (mutation.snapshot) {
            options.slotSession.registerSnapshot(mutation.snapshot);
          }
        }
      }
    }

    return {
      success: true,
      message: `成功创建${qty}件装备`,
      itemIds,
      equipment: lastEquipment,
    };
  };

  const runBatch = async (): Promise<CreateItemResult> => {
    if (!hasUsableTransactionContext()) {
      try {
        return await withTransaction(async () => {
          const result = await executeBatch();
          if (!result.success) {
            throw new Error(`create-equipment-item-failed:${result.message}`);
          }
          return result;
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('create-equipment-item-failed:')) {
          return {
            success: false,
            message: error.message.replace('create-equipment-item-failed:', ''),
          };
        }
        throw error;
      }
    }

    const savepointName = buildCreateItemSavepointName();
    await query(`SAVEPOINT ${savepointName}`);
    try {
      const result = await executeBatch();
      if (!result.success) {
        await query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        await query(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      }
      await query(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      await query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await query(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  };

  return runBatch();
};

/**
 * 创建普通物品（支持堆叠）
 *
 * 设计说明：
 * - 这里必须复用 inventoryService 的 @Transactional 入口，而不是直接调用 bag 底层函数。
 * - 这样 createItem 在“外层已有事务”时会自动复用事务，在“独立调用”时也会自行开启事务，
 *   避免奖励发放、邮件领取等普通物品写入路径再次散落事务判断逻辑。
 */
const createNormalItem = async (
  userId: number,
  characterId: number,
  itemDefId: string,
  qty: number,
  options: CreateItemOptions
): Promise<CreateItemResult> => {
  const result = await inventoryService.addItemToInventory(characterId, userId, itemDefId, qty, {
    location: options.location || 'bag',
    bindType: options.bindType,
    obtainedFrom: options.obtainedFrom,
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.qualityRank !== undefined && options.qualityRank !== null ? { qualityRank: options.qualityRank } : {}),
    ...(options.bagSlotAllocator ? { bagSlotAllocator: options.bagSlotAllocator } : {}),
    ...(options.inventoryMutationContext ? { inventoryMutationContext: options.inventoryMutationContext } : {}),
    ...(options.slotSession ? { slotSession: options.slotSession } : {}),
    ...(options.skipInventoryMutexLock ? { skipInventoryMutexLock: true } : {}),
  });

  return {
    success: result.success,
    message: result.message,
    itemIds: result.itemIds
  };
};

/**
 * 物品服务
 *
 * 作用：处理物品创建、使用、查询等核心逻辑
 * 不做：不处理路由层参数校验、不做权限判断
 *
 * 数据流：
 * - createItem：根据物品类型调用装备或普通物品创建逻辑，并统一复用对应领域服务的事务入口
 * - useItem：在事务中处理物品使用效果（资源、掉落、扩容、学习功法等）
 * - getItemInstance：读取物品实例详情
 *
 * 边界条件：
 * 1) useItem 使用 @Transactional 保证物品使用与资源更新的原子性
 * 2) createItem 不加 @Transactional，由内部复用的 inventoryService / equipmentService 统一处理事务
 */
class ItemService {
  /**
   * 获取物品定义
   */
  async getItemDef(itemDefId: string): Promise<ItemDef | null> {
    return getItemDefSync(itemDefId);
  }

  /**
   * 统一创建物品接口
   * 根据物品类型自动选择处理方式
   */
  async createItem(
    userId: number,
    characterId: number,
    itemDefId: string,
    qty: number = 1,
    options: CreateItemOptions = {}
  ): Promise<CreateItemResult> {
    const itemDef = await getItemDefSync(itemDefId);
    if (!itemDef) {
      return { success: false, message: `物品不存在: ${itemDefId}` };
    }

    if (itemDef.category === 'equipment') {
      return createEquipmentItem(userId, characterId, itemDefId, qty, options);
    } else {
      return createNormalItem(userId, characterId, itemDefId, qty, options);
    }
  }

  /**
   * 批量创建物品
   */
  async createItems(
    userId: number,
    characterId: number,
    items: Array<{ itemDefId: string; qty: number; options?: CreateItemOptions }>
  ): Promise<{ success: boolean; message: string; results: CreateItemResult[] }> {
    const results: CreateItemResult[] = [];

    for (const item of items) {
      const result = await this.createItem(
        userId, characterId, item.itemDefId, item.qty, item.options || {}
      );
      results.push(result);

      if (!result.success) {
        return {
          success: false,
          message: `创建物品 ${item.itemDefId} 失败: ${result.message}`,
          results
        };
      }
    }

    return { success: true, message: '批量创建成功', results };
  }

  /**
   * 使用物品
   */
  @Transactional
  async useItem(
    userId: number,
    characterId: number,
    instanceId: number,
    qty: number = 1,
    options: { targetItemInstanceId?: number; partnerId?: number } = {},
  ): Promise<ItemUseResult> {
    const realmSnapshot = await loadCharacterRealmSnapshot(characterId);
    if (!realmSnapshot) {
      return { success: false, message: '角色不存在' };
    }
    const computedBefore = await getCharacterComputedByCharacterId(characterId);
    if (!computedBefore) {
      return { success: false, message: '角色数据异常' };
    }

    await lockCharacterInventoryMutex(characterId);

    // 获取物品实例
    const item = await loadProjectedCharacterItemInstanceById(characterId, instanceId);
    if (!item) {
      return { success: false, message: '物品不存在' };
    }
    const itemDefId = item.item_def_id.trim();
    if (!itemDefId) {
      return { success: false, message: '物品数据异常' };
    }

    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) {
      return { success: false, message: '物品不存在' };
    }
    const resolvedTechniqueBook = resolveTechniqueBookLearning({
      itemDef,
      metadata: item.metadata,
    });
    const category = String(itemDef.category || '');
    const useType = String(itemDef.use_type || '');
    const effectDefs = Array.isArray(itemDef.effect_defs)
      ? itemDef.effect_defs.filter((effect): effect is ItemUseEffect => isJsonObject(effect as JsonValue | undefined))
      : [];
    const itemUseTargetType = getItemUseTargetType(effectDefs);

    // 检查是否可使用
    if (category === 'equipment' || category === 'material' || category === 'gem') {
      return { success: false, message: '该物品不可使用' };
    }

    if (!useType) {
      return { success: false, message: '该物品不可使用' };
    }

    if (item.locked) {
      return { success: false, message: '物品已锁定' };
    }

    if ((Number(item.qty) || 0) < qty) {
      return { success: false, message: '数量不足' };
    }

    if (
      itemUseTargetType === 'bound_equipment' &&
      (!Number.isInteger(options.targetItemInstanceId) || Number(options.targetItemInstanceId) <= 0)
    ) {
      return { success: false, message: '请选择要解绑的装备' };
    }

    const cdRound = Number(itemDef.use_cd_round) || 0;
    const cdSec = Number(itemDef.use_cd_sec) || 0;
    const effectiveCdSec = Math.max(0, cdSec, cdRound);

    if (effectiveCdSec > 0) {
      const cdResult = await query<ItemUseCooldownRow>(
        `SELECT cooldown_until FROM item_use_cooldown WHERE character_id = $1 AND item_def_id = $2`,
        [characterId, itemDefId]
      );
      if (cdResult.rows.length > 0) {
        const until = cdResult.rows[0]?.cooldown_until;
        const untilMs = until ? new Date(until).getTime() : 0;
        if (untilMs > Date.now()) {
          const remaining = Math.ceil((untilMs - Date.now()) / 1000);
          return { success: false, message: `物品冷却中，剩余${remaining}秒` };
        }
      }
    }

    const dailyLimit = Number(itemDef.use_limit_daily) || 0;
    const totalLimit = Number(itemDef.use_limit_total) || 0;

    if (dailyLimit > 0 || totalLimit > 0) {
      const cntResult = await query<ItemUseCountRow>(
        `SELECT daily_count, total_count, last_daily_reset
         FROM item_use_count
         WHERE character_id = $1 AND item_def_id = $2
         FOR UPDATE`,
        [characterId, itemDefId]
      );

      const todayStr = new Date().toISOString().slice(0, 10);
      const row = cntResult.rows[0] ?? null;
      const lastResetStr =
        row?.last_daily_reset instanceof Date
          ? row.last_daily_reset.toISOString().slice(0, 10)
          : String(row?.last_daily_reset ?? '');
      const dailyUsed = lastResetStr === todayStr ? Number(row?.daily_count) || 0 : 0;
      const totalUsed = Number(row?.total_count) || 0;

      if (dailyLimit > 0 && dailyUsed + qty > dailyLimit) {
        return { success: false, message: '今日使用次数已达上限' };
      }

      if (totalLimit > 0 && totalUsed + qty > totalLimit) {
        return { success: false, message: '使用次数已达上限' };
      }
    }

    let deltaQixue = 0;
    let deltaLingqi = 0;
    let deltaStamina = 0;
    let deltaExp = 0;
    let hasLoot = false;
    let hasLearnTechnique = false;
    let hasLearnPartnerTechnique = false;
    let hasExpandEffect = false;
    let hasEquipmentUnbindEffect = false;
    let hasPartnerBaseAttrRerollEffect = false;
    let partnerReboneJob: ItemUseResult['partnerReboneJob'];
    let partnerTechniqueResult: PartnerLearnTechniqueResultDto | undefined;
    const normalizedEffects: ItemUseEffect[] = [];
    const lootResults: ItemUseLootResult[] = [];
    const lootItemsToAdd: { itemDefId: string; qty: number }[] = [];
    let totalExpandSize = 0;
    let deltaSilver = 0;
    let deltaSpiritStones = 0;

    for (const effect of effectDefs) {
      normalizedEffects.push(effect);
      if (String(effect.trigger || '') !== 'use') continue;

      const effectType = typeof effect.effect_type === 'string' ? effect.effect_type : undefined;
      const params = asJsonObject(effect.params);

      if (effectType === 'unbind') {
        const targetType = String(params?.target_type || '').trim();
        const bindState = String(params?.bind_state || '').trim();
        if (targetType !== 'equipment' || bindState !== 'bound') {
          return { success: false, message: '解绑道具配置错误' };
        }

        const targetItemInstanceId = Number(options.targetItemInstanceId);
        if (!Number.isInteger(targetItemInstanceId) || targetItemInstanceId <= 0) {
          return { success: false, message: '请选择要解绑的装备' };
        }

        const unbindResult = await unbindEquipmentBindingByInstanceId({
          characterId,
          itemInstanceId: targetItemInstanceId,
        });
        if (!unbindResult.success) {
          return { success: false, message: unbindResult.message };
        }
        hasEquipmentUnbindEffect = true;
        continue;
      }

      if (effectType === 'reroll_partner_base_attrs') {
        const partnerId = Number(options.partnerId);
        if (!Number.isInteger(partnerId) || partnerId <= 0) {
          return { success: false, message: '请选择目标伙伴' };
        }
        const rerollResult = await partnerReboneService.createPendingReboneJob({
          characterId,
          itemDefId,
          itemQty: qty,
          partnerId,
        });
        if (!rerollResult.success || !rerollResult.data) {
          return { success: false, message: rerollResult.message };
        }
        partnerReboneJob = rerollResult.data;
        hasPartnerBaseAttrRerollEffect = true;
        continue;
      }

      if (String(effect.target || 'self') !== 'self') continue;

      if (effectType === 'loot') {
        hasLoot = true;
        const lootType = params ? String(params.loot_type || '') : '';

        if (lootType === 'currency') {
          const currency = params ? String(params.currency || '') : '';
          const amount = rollItemUseAmount({
            qty,
            min: typeof params?.min === 'number' || typeof params?.min === 'string' ? params.min : undefined,
            max: typeof params?.max === 'number' || typeof params?.max === 'string' ? params.max : undefined,
          });
          if (amount > 0) {
            if (currency === 'spirit_stones') {
              deltaSpiritStones += amount;
              lootResults.push({ type: 'spirit_stones', name: '灵石', amount });
            } else if (currency === 'silver') {
              deltaSilver += amount;
              lootResults.push({ type: 'silver', name: '银两', amount });
            }
          }
        } else if (lootType === 'multi') {
          const items = asJsonArray(params?.items);
          for (const li of items) {
            const row = asJsonObject(li);
            if (!row) continue;
            const itemDefId = String(row.item_id || '');
            const itemQty = Math.max(1, Math.floor(asFiniteNumber(row.qty) ?? 1)) * qty;
            if (itemDefId) {
              lootItemsToAdd.push({ itemDefId, qty: itemQty });
            }
          }
          const currency = asJsonObject(params?.currency);
          const silverAmt = Math.max(0, Math.floor(asFiniteNumber(currency?.silver) ?? 0)) * qty;
          const ssAmt = Math.max(0, Math.floor(asFiniteNumber(currency?.spirit_stones) ?? 0)) * qty;
          if (silverAmt > 0) {
            deltaSilver += silverAmt;
            lootResults.push({ type: 'silver', name: '银两', amount: silverAmt });
          }
          if (ssAmt > 0) {
            deltaSpiritStones += ssAmt;
            lootResults.push({ type: 'spirit_stones', name: '灵石', amount: ssAmt });
          }
        } else if (lootType === 'random_gem') {
          const subCategoriesRaw = toStringArray(params?.sub_categories);
          const subCategories = subCategoriesRaw.length > 0 ? subCategoriesRaw : [...DEFAULT_RANDOM_GEM_SUB_CATEGORIES];
          const minLevel = toPositiveInt(params?.min_level, 1);
          const maxLevel = Math.max(minLevel, toPositiveInt(params?.max_level, 3));
          const gemsPerUse = toPositiveInt(params?.gems_per_use, 1);
          const rollCount = qty * gemsPerUse;

          const subCategorySet = new Set(subCategories);
          const gemIds = getItemDefinitions()
            .filter((entry) => {
              if (entry.enabled === false) return false;
              if (!isGemItemDefinition(entry)) return false;
              const subCategory = String(entry.sub_category || '');
              if (!subCategorySet.has(subCategory)) return false;
              const gemLevel = getGemLevel(entry);
              return gemLevel !== null && gemLevel >= minLevel && gemLevel <= maxLevel;
            })
            .map((entry) => String(entry.id || '').trim())
            .filter((id): id is string => id.length > 0);

          if (gemIds.length === 0) {
            return { success: false, message: '宝石袋配置异常：没有可掉落宝石' };
          }

          const rolledGemCounts = new Map<string, number>();
          for (let i = 0; i < rollCount; i += 1) {
            const rolledGemId = gemIds[Math.floor(Math.random() * gemIds.length)];
            if (!rolledGemId) continue;
            rolledGemCounts.set(rolledGemId, (rolledGemCounts.get(rolledGemId) ?? 0) + 1);
          }

          for (const [rolledGemId, rolledQty] of rolledGemCounts.entries()) {
            if (rolledQty <= 0) continue;
            lootItemsToAdd.push({ itemDefId: rolledGemId, qty: rolledQty });
          }
        }
        continue;
      }

      if (effectType === 'expand') {
        const expandType = params ? String(params.expand_type || '') : '';
        if (expandType !== 'bag') {
          return { success: false, message: '该道具暂不支持当前扩容类型' };
        }

        const valueRaw = asFiniteNumber(params?.value) ?? Number.NaN;
        const expandValue = Number.isInteger(valueRaw) ? valueRaw : Math.floor(valueRaw);
        if (!Number.isInteger(expandValue) || expandValue <= 0) {
          return { success: false, message: '扩容道具配置错误' };
        }

        totalExpandSize += expandValue * qty;
        hasExpandEffect = true;
        continue;
      }

      if (effectType === 'learn_technique') {
        const techniqueId =
          resolvedTechniqueBook?.effectType === 'learn_technique'
            ? resolvedTechniqueBook.techniqueId
            : '';
        if (!techniqueId) {
          return { success: false, message: '功法书配置异常，缺少功法ID' };
        }

        const partnerId = Number(options.partnerId);
        if (Number.isInteger(partnerId) && partnerId > 0) {
          const learnResult = await partnerService.learnTechniqueByItem({
            characterId,
            partnerId,
            itemDefId,
            techniqueId,
          });
          if (!learnResult.success || !learnResult.data) {
            return { success: false, message: learnResult.message };
          }

          partnerTechniqueResult = learnResult.data;
          hasLearnPartnerTechnique = true;
          lootResults.push({
            type: 'partner_technique',
            name: learnResult.data.learnedTechnique.name,
            amount: 1,
          });
          continue;
        }

        const techniqueDef = getTechniqueDefinitions().find((entry) => (
          entry.id === techniqueId &&
          entry.enabled !== false &&
          isCharacterVisibleTechniqueDefinition(entry)
        )) ?? null;
        if (!techniqueDef) {
          return { success: false, message: '目标功法不存在或未开放' };
        }

        const requiredRealm = String(techniqueDef.required_realm || '').trim();
        if (
          shouldValidateTechniqueLearnRealm({ effectType: 'learn_technique', itemDefId }) &&
          !isRealmSufficient(realmSnapshot.realm, requiredRealm, realmSnapshot.subRealm)
        ) {
          return { success: false, message: `境界不足，需要达到${requiredRealm}` };
        }

        const existsRes = await query(
          'SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1',
          [characterId, techniqueId]
        );
        if (existsRes.rows.length > 0) {
          return { success: false, message: '已学习该功法' };
        }

        await query(
          `INSERT INTO character_technique (
            character_id, technique_id, current_layer, obtained_from, obtained_ref_id, acquired_at
          ) VALUES ($1, $2, 1, $3, $4, NOW())`,
          [characterId, techniqueId, `use_item:${itemDefId}`, itemDefId]
        );
        hasLearnTechnique = true;
        lootResults.push({
          type: 'technique',
          name: String(techniqueDef.name || techniqueId),
          amount: 1,
        });
        continue;
      }

      if (effectType === 'learn_generated_technique') {
        const generatedTechniqueId =
          resolvedTechniqueBook?.effectType === 'learn_generated_technique'
            ? resolvedTechniqueBook.techniqueId
            : '';
        if (!generatedTechniqueId) {
          return { success: false, message: '生成功法书数据异常，缺少功法标识' };
        }

        const partnerId = Number(options.partnerId);
        if (Number.isInteger(partnerId) && partnerId > 0) {
          const learnResult = await partnerService.learnTechniqueByItem({
            characterId,
            partnerId,
            itemDefId,
            techniqueId: generatedTechniqueId,
          });
          if (!learnResult.success || !learnResult.data) {
            return { success: false, message: learnResult.message };
          }

          partnerTechniqueResult = learnResult.data;
          hasLearnPartnerTechnique = true;
          lootResults.push({
            type: 'partner_technique',
            name: learnResult.data.learnedTechnique.name,
            amount: 1,
          });
          continue;
        }

        const techniqueDef =
          getTechniqueDefinitions().find((entry) => (
            entry.id === generatedTechniqueId &&
            entry.enabled !== false &&
            isCharacterVisibleTechniqueDefinition(entry)
          )) ?? null;
        if (!techniqueDef) {
          return { success: false, message: '目标生成功法不存在或未发布' };
        }

        const requiredRealm = String(techniqueDef.required_realm || '').trim();
        if (
          shouldValidateTechniqueLearnRealm({ effectType: 'learn_generated_technique', itemDefId }) &&
          !isRealmSufficient(realmSnapshot.realm, requiredRealm, realmSnapshot.subRealm)
        ) {
          return { success: false, message: `境界不足，需要达到${requiredRealm}` };
        }

        const existsRes = await query(
          'SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1',
          [characterId, generatedTechniqueId]
        );
        if (existsRes.rows.length > 0) {
          return { success: false, message: '已学习该功法' };
        }

        await query(
          `INSERT INTO character_technique (
            character_id, technique_id, current_layer, obtained_from, obtained_ref_id, acquired_at
          ) VALUES ($1, $2, 1, $3, $4, NOW())`,
          [characterId, generatedTechniqueId, `use_item:${itemDefId}`, itemDefId]
        );
        hasLearnTechnique = true;
        lootResults.push({
          type: 'technique',
          name: String(techniqueDef.name || generatedTechniqueId),
          amount: 1,
        });
        continue;
      }

      const resourceDelta = resolveItemUseResourceDelta(
        {
          trigger: typeof effect.trigger === 'string' ? effect.trigger : undefined,
          target: typeof effect.target === 'string' ? effect.target : undefined,
          effect_type: effectType,
          value: typeof effect.value === 'number' || typeof effect.value === 'string' ? effect.value : undefined,
          params: {
            resource: typeof params?.resource === 'string' ? params.resource : undefined,
            resource_type: typeof params?.resource_type === 'string' ? params.resource_type : undefined,
            min: typeof params?.min === 'number' || typeof params?.min === 'string' ? params.min : undefined,
            max: typeof params?.max === 'number' || typeof params?.max === 'string' ? params.max : undefined,
          },
        },
        qty,
      );
      deltaQixue += resourceDelta.qixue;
      deltaLingqi += resourceDelta.lingqi;
      deltaStamina += resourceDelta.stamina;
      deltaExp += resourceDelta.exp;
    }

    if (
      deltaQixue === 0 &&
      deltaLingqi === 0 &&
      deltaStamina === 0 &&
      deltaExp === 0 &&
      !hasLoot &&
      !hasLearnTechnique &&
      !hasLearnPartnerTechnique &&
      !hasExpandEffect &&
      !hasEquipmentUnbindEffect &&
      !hasPartnerBaseAttrRerollEffect
    ) {
      return { success: false, message: '该物品暂不支持使用效果' };
    }

    if (hasExpandEffect) {
      const expandResult = await expandInventory(characterId, 'bag', totalExpandSize);
      if (!expandResult.success) {
        return { success: false, message: expandResult.message };
      }
    }

    const rewardDelta = createCharacterRewardDelta();
    rewardDelta.exp += deltaExp;
    rewardDelta.silver += deltaSilver;
    rewardDelta.spiritStones += deltaSpiritStones;
    if (rewardDelta.exp !== 0 || rewardDelta.silver !== 0 || rewardDelta.spiritStones !== 0) {
      await applyCharacterRewardDeltas(new Map([[characterId, rewardDelta]]));
    }

    if (lootItemsToAdd.length > 0) {
      await bufferSimpleCharacterItemGrants(
        characterId,
        userId,
        lootItemsToAdd.map((lootItem) => ({
          itemDefId: lootItem.itemDefId,
          qty: lootItem.qty,
          obtainedFrom: `use_item:${itemDef.id}`,
        })),
      );
    }

    for (const lootItem of lootItemsToAdd) {
      const itemName = getItemDefinitionById(lootItem.itemDefId)?.name || lootItem.itemDefId;
      lootResults.push({ type: 'item', name: itemName, amount: lootItem.qty });
    }

    if (effectiveCdSec > 0) {
      await query(
        `
          INSERT INTO item_use_cooldown (character_id, item_def_id, cooldown_until)
          VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'))
          ON CONFLICT (character_id, item_def_id)
          DO UPDATE SET cooldown_until = NOW() + ($3::int * INTERVAL '1 second'), updated_at = NOW()
        `,
        [characterId, itemDefId, Math.floor(effectiveCdSec)]
      );
    }

    if (dailyLimit > 0 || totalLimit > 0) {
      await query(
        `
          INSERT INTO item_use_count (character_id, item_def_id, daily_count, total_count, last_daily_reset)
          VALUES ($1, $2, $3, $3, CURRENT_DATE)
          ON CONFLICT (character_id, item_def_id)
          DO UPDATE SET
            daily_count = CASE
              WHEN item_use_count.last_daily_reset = CURRENT_DATE THEN item_use_count.daily_count + EXCLUDED.daily_count
              ELSE EXCLUDED.daily_count
            END,
            total_count = item_use_count.total_count + EXCLUDED.total_count,
            last_daily_reset = CURRENT_DATE,
            updated_at = NOW()
        `,
        [characterId, itemDefId, qty]
      );
    }

    // 扣除物品
    const consumeItemResult = await consumeSpecificItemInstance(characterId, instanceId, qty);
    if (!consumeItemResult.success) {
      return { success: false, message: consumeItemResult.message };
    }
    if (partnerTechniqueResult) {
      partnerTechniqueResult = {
        ...partnerTechniqueResult,
        remainingBooks: await partnerService.listLearnTechniqueBooks(characterId),
      };
    }
    if (deltaQixue !== 0 || deltaLingqi !== 0) {
      await applyCharacterResourceDeltaByCharacterId(characterId, {
        qixue: deltaQixue,
        lingqi: deltaLingqi,
      });
    }
    if (deltaStamina !== 0) {
      const staminaResult = await recoverStaminaByCharacterId(characterId, deltaStamina);
      if (!staminaResult) {
        throw new Error('角色体力数据异常');
      }
    }

    const updatedCharBase = await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true });
    const updatedChar = updatedCharBase
      ? {
          ...updatedCharBase,
          exp: updatedCharBase.exp + rewardDelta.exp,
          silver: updatedCharBase.silver + rewardDelta.silver,
          spirit_stones: updatedCharBase.spirit_stones + rewardDelta.spiritStones,
        }
      : undefined;
    return {
      success: true,
      message: '使用成功',
      effects: normalizedEffects.length > 0 ? normalizedEffects : undefined,
      character: updatedChar,
      lootResults: lootResults.length > 0 ? lootResults : undefined,
      partnerTechniqueResult,
      partnerReboneJob,
    };
  }

  /**
   * 获取物品实例详情（通用）
   */
  async getItemInstance(instanceId: number): Promise<ItemInstanceDetail | null> {
    const result = await query<ItemInstanceRow>(
      `
      SELECT *
      FROM item_instance
      WHERE id = $1
    `,
      [instanceId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    const itemDefId = row.item_def_id.trim();
    if (!itemDefId) return null;
    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) return null;

    const resolvedQuality = row.quality ?? itemDef.quality ?? null;
    const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
    const resolvedQualityRank = row.quality_rank ?? resolveQualityRankFromName(resolvedQuality, defQualityRank);
    const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: itemDef.base_attrs,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: row.strengthen_level,
      refineLevelRaw: row.refine_level,
      socketedGemsRaw: row.socketed_gems,
    });
    return {
      id: row.id,
      itemDefId: row.item_def_id,
      name: itemDef.name,
      icon: itemDef.icon ?? null,
      category: itemDef.category,
      subCategory: itemDef.sub_category ?? '',
      quality: resolvedQuality,
      qualityRank: resolvedQualityRank,
      qty: row.qty,
      stackMax: Math.max(1, Number(itemDef.stack_max) || 1),
      description: itemDef.description ?? null,
      // 装备专用
      equipSlot: itemDef.equip_slot ?? null,
      equipReqRealm: itemDef.equip_req_realm ?? null,
      baseAttrs: itemDef.category === 'equipment' ? displayBaseAttrs : (itemDef.base_attrs ?? {}),
      affixes: row.affixes || [],
      setId: itemDef.set_id ?? null,
      strengthenLevel: row.strengthen_level,
      refineLevel: row.refine_level,
      socketedGems: row.socketed_gems,
      identified: row.identified === true,
      // 通用
      locked: row.locked,
      bindType: row.bind_type,
      location: row.location,
      locationSlot: row.location_slot,
      equippedSlot: row.equipped_slot,
      metadata: row.metadata,
      createdAt: row.created_at
    };
  }
}

export const itemService = new ItemService();
export default itemService;
