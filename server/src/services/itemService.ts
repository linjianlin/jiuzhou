/**
 * 九州修仙录 - 统一物品服务
 * 根据物品类型自动选择处理方式：
 * - 装备类：生成词条后创建实例
 * - 普通物品：直接创建实例（支持堆叠）
 */
import { query, pool } from '../config/database.js';
import type { PoolClient } from 'pg';
import { generateEquipment, createEquipmentInstance, createEquipmentInstanceTx, GenerateOptions, GeneratedEquipment } from './equipmentService.js';
import {
  addItemToInventory,
  addItemToInventoryTx,
  expandInventoryWithClient,
  SlottedInventoryLocation,
} from './inventoryService.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';
import { getRealmRankZeroBased } from './shared/realmRules.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import {
  applyCharacterResourceDeltaByCharacterId,
  getCharacterComputedByCharacterId,
} from './characterComputedService.js';
import { getItemDefinitionById, getItemDefinitions, getTechniqueDefinitions } from './staticConfigLoader.js';
import { getGemLevel, isGemItemDefinition } from './shared/gemItemSemantics.js';

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
  bindType?: string;
  obtainedFrom?: string;
  // 装备专用选项
  equipOptions?: GenerateOptions;
  dbClient?: PoolClient;
}

// 创建物品结果
export interface CreateItemResult {
  success: boolean;
  message: string;
  itemIds?: number[];
  equipment?: GeneratedEquipment;
}

const DEFAULT_RANDOM_GEM_SUB_CATEGORIES = ['gem_attack', 'gem_defense', 'gem_survival'] as const;

const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  return getRealmRankZeroBased(realmRaw, subRealmRaw);
};

const isRealmSufficient = (currentRealm: unknown, requiredRealm: unknown, currentSubRealm?: unknown): boolean => {
  const required = typeof requiredRealm === 'string' ? requiredRealm.trim() : '';
  if (!required) return true;
  return getRealmRank(currentRealm, currentSubRealm) >= getRealmRank(required);
};

const toPositiveInt = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

/**
 * 获取物品定义
 */
export const getItemDef = async (itemDefId: string): Promise<ItemDef | null> => {
  return getItemDefWithClient(itemDefId);
};

/**
 * 统一创建物品接口
 * 根据物品类型自动选择处理方式
 */
export const createItem = async (
  userId: number,
  characterId: number,
  itemDefId: string,
  qty: number = 1,
  options: CreateItemOptions = {}
): Promise<CreateItemResult> => {
  // 1. 获取物品定义
  const itemDef = await getItemDefWithClient(itemDefId, options.dbClient);
  if (!itemDef) {
    return { success: false, message: `物品不存在: ${itemDefId}` };
  }

  // 2. 根据类型分发处理
  if (itemDef.category === 'equipment') {
    return createEquipmentItem(userId, characterId, itemDefId, qty, options);
  } else {
    return createNormalItem(userId, characterId, itemDefId, qty, options);
  }
};

export const getItemDefWithClient = async (itemDefId: string, client?: PoolClient): Promise<ItemDef | null> => {
  // 兼容旧签名，调用方可继续传入事务 client
  void client;

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

  // 装备不可堆叠，逐个生成
  for (let i = 0; i < qty; i++) {
    const generated = await generateEquipment(itemDefId, options.equipOptions);
    if (!generated) {
      return { success: false, message: '装备生成失败' };
    }

    const result = options.dbClient
      ? await createEquipmentInstanceTx(options.dbClient, userId, characterId, generated, {
          location: options.location || 'bag',
          bindType: options.bindType,
          obtainedFrom: options.obtainedFrom
        })
      : await createEquipmentInstance(userId, characterId, generated, {
          location: options.location || 'bag',
          bindType: options.bindType,
          obtainedFrom: options.obtainedFrom
        });

    if (!result.success) {
      return { success: false, message: result.message };
    }

    itemIds.push(result.instanceId!);
    lastEquipment = generated;
  }

  return {
    success: true,
    message: `成功创建${qty}件装备`,
    itemIds,
    equipment: lastEquipment
  };
};

/**
 * 创建普通物品（支持堆叠）
 */
const createNormalItem = async (
  userId: number,
  characterId: number,
  itemDefId: string,
  qty: number,
  options: CreateItemOptions
): Promise<CreateItemResult> => {
  const result = options.dbClient
    ? await addItemToInventoryTx(options.dbClient, characterId, userId, itemDefId, qty, {
        location: options.location || 'bag',
        bindType: options.bindType,
        obtainedFrom: options.obtainedFrom
      })
    : await addItemToInventory(characterId, userId, itemDefId, qty, {
        location: options.location || 'bag',
        bindType: options.bindType,
        obtainedFrom: options.obtainedFrom
      });

  return {
    success: result.success,
    message: result.message,
    itemIds: result.itemIds
  };
};

/**
 * 批量创建物品
 */
export const createItems = async (
  userId: number,
  characterId: number,
  items: Array<{ itemDefId: string; qty: number; options?: CreateItemOptions }>
): Promise<{ success: boolean; message: string; results: CreateItemResult[] }> => {
  const results: CreateItemResult[] = [];
  
  for (const item of items) {
    const result = await createItem(
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
};

/**
 * 使用物品
 */
export const useItem = async (
  userId: number,
  characterId: number,
  instanceId: number,
  qty: number = 1
): Promise<{ success: boolean; message: string; effects?: any[]; character?: any; lootResults?: { type: string; name?: string; amount: number }[] }> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const charResult = await client.query(
      'SELECT id, realm, sub_realm FROM characters WHERE id = $1 FOR UPDATE',
      [characterId]
    );
    if (charResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const charRow = charResult.rows[0];
    const computedBefore = await getCharacterComputedByCharacterId(characterId);
    if (!computedBefore) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色数据异常' };
    }

    // 获取物品实例
    const instanceResult = await client.query(
      `
      SELECT *
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
    `,
      [instanceId, characterId],
    );

    if (instanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const item = instanceResult.rows[0] as Record<string, unknown>;
    const itemDefId = typeof item.item_def_id === 'string' ? item.item_def_id : String(item.item_def_id || '');
    if (!itemDefId) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品数据异常' };
    }

    const itemDef = getItemDefinitionById(itemDefId);
    if (!itemDef) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }
    const category = String(itemDef.category || '');
    const useType = String(itemDef.use_type || '');
    const effectDefs = Array.isArray(itemDef.effect_defs) ? itemDef.effect_defs : [];

    // 检查是否可使用
    if (category === 'equipment' || category === 'material' || category === 'gem') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可使用' };
    }

    if (!useType) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可使用' };
    }

    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }

    if ((Number(item.qty) || 0) < qty) {
      await client.query('ROLLBACK');
      return { success: false, message: '数量不足' };
    }

    const cdRound = Number(itemDef.use_cd_round) || 0;
    const cdSec = Number(itemDef.use_cd_sec) || 0;
    const effectiveCdSec = Math.max(0, cdSec, cdRound);

    if (effectiveCdSec > 0) {
      const cdResult = await client.query(
        `SELECT cooldown_until FROM item_use_cooldown WHERE character_id = $1 AND item_def_id = $2`,
        [characterId, itemDefId]
      );
      if (cdResult.rows.length > 0) {
        const until = cdResult.rows[0]?.cooldown_until;
        const untilMs = until ? new Date(until).getTime() : 0;
        if (untilMs > Date.now()) {
          const remaining = Math.ceil((untilMs - Date.now()) / 1000);
          await client.query('ROLLBACK');
          return { success: false, message: `物品冷却中，剩余${remaining}秒` };
        }
      }
    }

    const dailyLimit = Number(itemDef.use_limit_daily) || 0;
    const totalLimit = Number(itemDef.use_limit_total) || 0;

    if (dailyLimit > 0 || totalLimit > 0) {
      const cntResult = await client.query(
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
        await client.query('ROLLBACK');
        return { success: false, message: '今日使用次数已达上限' };
      }

      if (totalLimit > 0 && totalUsed + qty > totalLimit) {
        await client.query('ROLLBACK');
        return { success: false, message: '使用次数已达上限' };
      }
    }

    let deltaQixue = 0;
    let deltaLingqi = 0;
    let deltaExp = 0;
    let hasLoot = false;
    let hasLearnTechnique = false;
    let hasExpandEffect = false;
    const lootResults: { type: string; name?: string; amount: number }[] = [];
    const lootItemsToAdd: { itemDefId: string; qty: number }[] = [];
    let totalExpandSize = 0;
    let deltaSilver = 0;
    let deltaSpiritStones = 0;

    for (const rawEffect of effectDefs) {
      if (!rawEffect || typeof rawEffect !== 'object') continue;
      const effect = rawEffect as Record<string, unknown>;
      if (String(effect.trigger || '') !== 'use') continue;
      if (String(effect.target || 'self') !== 'self') continue;

      const effectType = typeof effect.effect_type === 'string' ? effect.effect_type : undefined;

      if (effectType === 'loot') {
        hasLoot = true;
        const params =
          effect.params && typeof effect.params === 'object'
            ? (effect.params as Record<string, unknown>)
            : null;
        const lootType = params ? String(params.loot_type || '') : '';

        if (lootType === 'currency') {
          const currency = params ? String(params.currency || '') : '';
          const min = Math.max(0, Math.floor(params ? Number(params.min) || 0 : 0));
          const max = Math.max(min, Math.floor(params ? Number(params.max) || 0 : 0));
          let amount = 0;
          if (min === max) {
            amount = min * qty;
          } else {
            for (let i = 0; i < qty; i += 1) {
              amount += Math.floor(Math.random() * (max - min + 1)) + min;
            }
          }
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
          const items = params && Array.isArray(params.items) ? params.items : [];
          for (const li of items) {
            if (!li || typeof li !== 'object') continue;
            const row = li as Record<string, unknown>;
            const itemDefId = String(row.item_id || '');
            const itemQty = Math.max(1, Math.floor(Number(row.qty) || 1)) * qty;
            if (itemDefId) {
              lootItemsToAdd.push({ itemDefId, qty: itemQty });
            }
          }
          const currency =
            params && params.currency && typeof params.currency === 'object'
              ? (params.currency as Record<string, unknown>)
              : null;
          const silverAmt = Math.max(0, Math.floor(currency ? Number(currency.silver) || 0 : 0)) * qty;
          const ssAmt = Math.max(0, Math.floor(currency ? Number(currency.spirit_stones) || 0 : 0)) * qty;
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
            await client.query('ROLLBACK');
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
        const params =
          effect.params && typeof effect.params === 'object'
            ? (effect.params as Record<string, unknown>)
            : null;
        const expandType = params ? String(params.expand_type || '') : '';
        if (expandType !== 'bag') {
          await client.query('ROLLBACK');
          return { success: false, message: '该道具暂不支持当前扩容类型' };
        }

        const valueRaw = params ? Number(params.value) : NaN;
        const expandValue = Number.isInteger(valueRaw) ? valueRaw : Math.floor(valueRaw);
        if (!Number.isInteger(expandValue) || expandValue <= 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '扩容道具配置错误' };
        }

        totalExpandSize += expandValue * qty;
        hasExpandEffect = true;
        continue;
      }

      if (effectType === 'learn_technique') {
        const params =
          effect.params && typeof effect.params === 'object'
            ? (effect.params as Record<string, unknown>)
            : null;
        const techniqueId = params ? String(params.technique_id || '').trim() : '';
        if (!techniqueId) {
          await client.query('ROLLBACK');
          return { success: false, message: '功法书配置异常，缺少功法ID' };
        }

        const techniqueDef = getTechniqueDefinitions().find((entry) => entry.id === techniqueId && entry.enabled !== false) ?? null;
        if (!techniqueDef) {
          await client.query('ROLLBACK');
          return { success: false, message: '目标功法不存在或未开放' };
        }

        const requiredRealm = String(techniqueDef.required_realm || '').trim();
        if (!isRealmSufficient(charRow.realm, requiredRealm, charRow.sub_realm)) {
          await client.query('ROLLBACK');
          return { success: false, message: `境界不足，需要达到${requiredRealm}` };
        }

        const existsRes = await client.query(
          'SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1',
          [characterId, techniqueId]
        );
        if (existsRes.rows.length > 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '已学习该功法' };
        }

        await client.query(
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

      const value = Number(effect.value);
      if (!Number.isFinite(value)) continue;

      if (!effectType || effectType === 'heal') {
        deltaQixue += value * qty;
        continue;
      }

      if (effectType === 'resource') {
        const params =
          effect.params && typeof effect.params === 'object'
            ? (effect.params as Record<string, unknown>)
            : null;
        const resource = params ? String(params.resource || '') : '';
        if (resource === 'qixue') {
          deltaQixue += value * qty;
        }
        if (resource === 'lingqi') {
          deltaLingqi += value * qty;
        }
        if (resource === 'exp') {
          deltaExp += Math.floor(value * qty);
        }
      }
    }

    if (
      deltaQixue === 0 &&
      deltaLingqi === 0 &&
      deltaExp === 0 &&
      !hasLoot &&
      !hasLearnTechnique &&
      !hasExpandEffect
    ) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品暂不支持使用效果' };
    }

    if (hasExpandEffect) {
      const expandResult = await expandInventoryWithClient(client, characterId, 'bag', totalExpandSize);
      if (!expandResult.success) {
        await client.query('ROLLBACK');
        return { success: false, message: expandResult.message };
      }
    }

    const setClauses = ['updated_at = NOW()'];
    const setValues: any[] = [characterId];
    let paramIdx = 2;

    if (deltaExp !== 0) {
      setClauses.push(`exp = exp + $${paramIdx}`);
      setValues.push(deltaExp);
      paramIdx++;
    }
    if (deltaSilver > 0) {
      setClauses.push(`silver = silver + $${paramIdx}`);
      setValues.push(deltaSilver);
      paramIdx++;
    }
    if (deltaSpiritStones > 0) {
      setClauses.push(`spirit_stones = spirit_stones + $${paramIdx}`);
      setValues.push(deltaSpiritStones);
      paramIdx++;
    }

    const updatedCharResult = await client.query(
      `UPDATE characters SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id`,
      setValues
    );

    for (const lootItem of lootItemsToAdd) {
      const addRes = await addItemToInventoryTx(client, characterId, userId, lootItem.itemDefId, lootItem.qty, {
        location: 'bag',
        obtainedFrom: `use_item:${itemDef.id}`
      });
      if (addRes.success) {
        const itemName = getItemDefinitionById(lootItem.itemDefId)?.name || lootItem.itemDefId;
        lootResults.push({ type: 'item', name: itemName, amount: lootItem.qty });
      }
    }

    if (effectiveCdSec > 0) {
      await client.query(
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
      await client.query(
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
    if ((Number(item.qty) || 0) === qty) {
      await client.query('DELETE FROM item_instance WHERE id = $1', [instanceId]);
    } else {
      await client.query(
        'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
        [qty, instanceId]
      );
    }

    await client.query('COMMIT');
    if (deltaQixue !== 0 || deltaLingqi !== 0) {
      await applyCharacterResourceDeltaByCharacterId(characterId, {
        qixue: deltaQixue,
        lingqi: deltaLingqi,
      });
    }

    const updatedChar = updatedCharResult.rows.length > 0
      ? await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true })
      : undefined;
    return {
      success: true,
      message: '使用成功',
      effects: effectDefs,
      character: updatedChar,
      lootResults: lootResults.length > 0 ? lootResults : undefined
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('使用物品失败:', error);
    return { success: false, message: '使用物品失败' };
  } finally {
    client.release();
  }
};

/**
 * 获取物品实例详情（通用）
 */
export const getItemInstance = async (instanceId: number): Promise<any | null> => {
  const result = await query(
    `
    SELECT *
    FROM item_instance
    WHERE id = $1
  `,
    [instanceId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const itemDefId = String(row.item_def_id || '').trim();
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
    icon: itemDef.icon,
    category: itemDef.category,
    subCategory: itemDef.sub_category,
    quality: resolvedQuality,
    qualityRank: resolvedQualityRank,
    qty: row.qty,
    stackMax: itemDef.stack_max,
    description: itemDef.description,
    // 装备专用
    equipSlot: itemDef.equip_slot,
    equipReqRealm: itemDef.equip_req_realm,
    baseAttrs: itemDef.category === 'equipment' ? displayBaseAttrs : (itemDef.base_attrs ?? {}),
    affixes: row.affixes || [],
    setId: itemDef.set_id,
    strengthenLevel: row.strengthen_level,
    refineLevel: row.refine_level,
    socketedGems: row.socketed_gems,
    identified: row.identified,
    // 通用
    locked: row.locked,
    bindType: row.bind_type,
    location: row.location,
    locationSlot: row.location_slot,
    equippedSlot: row.equipped_slot,
    createdAt: row.created_at
  };
};

export default {
  getItemDef,
  createItem,
  createItems,
  useItem,
  getItemInstance
};
