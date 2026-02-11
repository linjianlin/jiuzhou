/**
 * 九州修仙录 - 统一物品服务
 * 根据物品类型自动选择处理方式：
 * - 装备类：生成词条后创建实例
 * - 普通物品：直接创建实例（支持堆叠）
 */
import { query, pool } from '../config/database.js';
import type { PoolClient } from 'pg';
import { generateEquipment, createEquipmentInstance, createEquipmentInstanceTx, GenerateOptions, GeneratedEquipment } from './equipmentService.js';
import { addItemToInventory, addItemToInventoryTx, SlottedInventoryLocation } from './inventoryService.js';
import { buildEquipmentDisplayBaseAttrs } from './equipmentGrowthRules.js';

// 物品定义接口
export interface ItemDef {
  id: string;
  code: string;
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

const REALM_ORDER = [
  '凡人',
  '炼精化炁·养气期',
  '炼精化炁·通脉期',
  '炼精化炁·凝炁期',
  '炼炁化神·炼己期',
  '炼炁化神·采药期',
  '炼炁化神·结胎期',
  '炼神返虚·养神期',
  '炼神返虚·还虚期',
  '炼神返虚·合道期',
  '炼虚合道·证道期',
  '炼虚合道·历劫期',
  '炼虚合道·成圣期',
] as const;

const REALM_MAJOR_TO_FIRST: Record<string, string> = {
  凡人: '凡人',
  炼精化炁: '炼精化炁·养气期',
  炼炁化神: '炼炁化神·炼己期',
  炼神返虚: '炼神返虚·养神期',
  炼虚合道: '炼虚合道·证道期',
};

const REALM_SUB_TO_FULL: Record<string, string> = {
  养气期: '炼精化炁·养气期',
  通脉期: '炼精化炁·通脉期',
  凝炁期: '炼精化炁·凝炁期',
  炼己期: '炼炁化神·炼己期',
  采药期: '炼炁化神·采药期',
  结胎期: '炼炁化神·结胎期',
  养神期: '炼神返虚·养神期',
  还虚期: '炼神返虚·还虚期',
  合道期: '炼神返虚·合道期',
  证道期: '炼虚合道·证道期',
  历劫期: '炼虚合道·历劫期',
  成圣期: '炼虚合道·成圣期',
};

const normalizeRealm = (realmRaw: unknown, subRealmRaw?: unknown): string => {
  const realm = typeof realmRaw === 'string' ? realmRaw.trim() : '';
  const subRealm = typeof subRealmRaw === 'string' ? subRealmRaw.trim() : '';
  if (!realm && !subRealm) return '凡人';
  if (realm && REALM_ORDER.includes(realm as (typeof REALM_ORDER)[number])) return realm;
  if (realm && subRealm) {
    const full = `${realm}·${subRealm}`;
    if (REALM_ORDER.includes(full as (typeof REALM_ORDER)[number])) return full;
  }
  if (realm && REALM_MAJOR_TO_FIRST[realm]) return REALM_MAJOR_TO_FIRST[realm];
  if (realm && REALM_SUB_TO_FULL[realm]) return REALM_SUB_TO_FULL[realm];
  if (!realm && subRealm && REALM_SUB_TO_FULL[subRealm]) return REALM_SUB_TO_FULL[subRealm];
  return realm || '凡人';
};

const getRealmRank = (realmRaw: unknown, subRealmRaw?: unknown): number => {
  const normalized = normalizeRealm(realmRaw, subRealmRaw);
  const idx = REALM_ORDER.indexOf(normalized as (typeof REALM_ORDER)[number]);
  return idx >= 0 ? idx : 0;
};

const isRealmSufficient = (currentRealm: unknown, requiredRealm: unknown, currentSubRealm?: unknown): boolean => {
  const required = typeof requiredRealm === 'string' ? requiredRealm.trim() : '';
  if (!required) return true;
  return getRealmRank(currentRealm, currentSubRealm) >= getRealmRank(required);
};

/**
 * 获取物品定义
 */
export const getItemDef = async (itemDefId: string): Promise<ItemDef | null> => {
  const result = await query(
    `SELECT id, code, name, category, sub_category, quality, quality_rank, 
            stack_max, bind_type, icon
     FROM item_def WHERE id = $1 AND enabled = true`,
    [itemDefId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
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
  const executor = client ? client : { query };
  const result = await executor.query(
    `SELECT id, code, name, category, sub_category, quality, quality_rank, 
            stack_max, bind_type, icon
     FROM item_def WHERE id = $1 AND enabled = true`,
    [itemDefId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
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

    // 获取物品实例
    const instanceResult = await client.query(`
      SELECT ii.*, id.id as def_id, id.category, id.use_type, id.effect_defs, id.use_cd_round, id.use_cd_sec, id.use_limit_daily, id.use_limit_total
      FROM item_instance ii
      JOIN item_def id ON ii.item_def_id = id.id
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
    `, [instanceId, characterId]);

    if (instanceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const item = instanceResult.rows[0];

    // 检查是否可使用
    if (item.category === 'equipment' || item.category === 'material') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可使用' };
    }

    if (!item.use_type) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可使用' };
    }

    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }

    if (item.qty < qty) {
      await client.query('ROLLBACK');
      return { success: false, message: '数量不足' };
    }

    const itemDefId = typeof item.item_def_id === 'string' ? item.item_def_id : String(item.item_def_id || '');
    if (!itemDefId) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品数据异常' };
    }

    const cdRound = Number(item.use_cd_round) || 0;
    const cdSec = Number(item.use_cd_sec) || 0;
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

    const dailyLimit = Number(item.use_limit_daily) || 0;
    const totalLimit = Number(item.use_limit_total) || 0;

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

    const charResult = await client.query(
      'SELECT id, realm, sub_realm, qixue, max_qixue, lingqi, max_lingqi FROM characters WHERE id = $1 FOR UPDATE',
      [characterId]
    );
    if (charResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const charRow = charResult.rows[0];

    const effectDefs = Array.isArray(item.effect_defs) ? item.effect_defs : [];
    let deltaQixue = 0;
    let deltaLingqi = 0;
    let hasLoot = false;
    let hasLearnTechnique = false;
    const lootResults: { type: string; name?: string; amount: number }[] = [];
    const lootItemsToAdd: { itemDefId: string; qty: number }[] = [];
    let deltaSilver = 0;
    let deltaSpiritStones = 0;

    for (const rawEffect of effectDefs) {
      if (!rawEffect || typeof rawEffect !== 'object') continue;
      const effect: any = rawEffect;
      if (String(effect.trigger || '') !== 'use') continue;
      if (String(effect.target || 'self') !== 'self') continue;

      const effectType = typeof effect.effect_type === 'string' ? effect.effect_type : undefined;

      if (effectType === 'loot') {
        hasLoot = true;
        const params = effect.params && typeof effect.params === 'object' ? effect.params : {};
        const lootType = String(params.loot_type || '');

        if (lootType === 'currency') {
          const currency = String(params.currency || '');
          const min = Math.max(0, Math.floor(Number(params.min) || 0));
          const max = Math.max(min, Math.floor(Number(params.max) || 0));
          const amount = (min === max ? min : Math.floor(Math.random() * (max - min + 1)) + min) * qty;
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
          const items = Array.isArray(params.items) ? params.items : [];
          for (const li of items) {
            if (!li || typeof li !== 'object') continue;
            const itemDefId = String(li.item_id || '');
            const itemQty = Math.max(1, Math.floor(Number(li.qty) || 1)) * qty;
            if (itemDefId) {
              lootItemsToAdd.push({ itemDefId, qty: itemQty });
            }
          }
          const currency = params.currency && typeof params.currency === 'object' ? params.currency : {};
          const silverAmt = Math.max(0, Math.floor(Number(currency.silver) || 0)) * qty;
          const ssAmt = Math.max(0, Math.floor(Number(currency.spirit_stones) || 0)) * qty;
          if (silverAmt > 0) {
            deltaSilver += silverAmt;
            lootResults.push({ type: 'silver', name: '银两', amount: silverAmt });
          }
          if (ssAmt > 0) {
            deltaSpiritStones += ssAmt;
            lootResults.push({ type: 'spirit_stones', name: '灵石', amount: ssAmt });
          }
        }
        continue;
      }

      if (effectType === 'learn_technique') {
        const params = effect.params && typeof effect.params === 'object' ? effect.params : {};
        const techniqueId = String(params.technique_id || '').trim();
        if (!techniqueId) {
          await client.query('ROLLBACK');
          return { success: false, message: '功法书配置异常，缺少功法ID' };
        }

        const techniqueRes = await client.query(
          'SELECT id, name, required_realm FROM technique_def WHERE id = $1 AND enabled = true LIMIT 1',
          [techniqueId]
        );
        if (techniqueRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '目标功法不存在或未开放' };
        }

        const requiredRealm = String(techniqueRes.rows[0].required_realm || '').trim();
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
          name: String(techniqueRes.rows[0].name || techniqueId),
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
        const resource = effect.params && typeof effect.params === 'object' ? String(effect.params.resource || '') : '';
        if (resource === 'qixue') {
          deltaQixue += value * qty;
        }
        if (resource === 'lingqi') {
          deltaLingqi += value * qty;
        }
      }
    }

    if (deltaQixue === 0 && deltaLingqi === 0 && !hasLoot && !hasLearnTechnique) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品暂不支持使用效果' };
    }

    const nextQixue = Math.min(
      Number(charRow.max_qixue) || 0,
      Math.max(0, (Number(charRow.qixue) || 0) + deltaQixue)
    );
    const nextLingqi = Math.min(
      Number(charRow.max_lingqi) || 0,
      Math.max(0, (Number(charRow.lingqi) || 0) + deltaLingqi)
    );

    const setClauses = ['qixue = $2', 'lingqi = $3', 'updated_at = NOW()'];
    const setValues: any[] = [characterId, nextQixue, nextLingqi];
    let paramIdx = 4;

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
      `UPDATE characters SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id, qixue, max_qixue, lingqi, max_lingqi, silver, spirit_stones`,
      setValues
    );

    for (const lootItem of lootItemsToAdd) {
      const addRes = await addItemToInventoryTx(client, characterId, userId, lootItem.itemDefId, lootItem.qty, {
        location: 'bag',
        obtainedFrom: `use_item:${item.def_id}`
      });
      if (addRes.success) {
        const nameResult = await client.query('SELECT name FROM item_def WHERE id = $1', [lootItem.itemDefId]);
        const itemName = nameResult.rows[0]?.name || lootItem.itemDefId;
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
    if (item.qty === qty) {
      await client.query('DELETE FROM item_instance WHERE id = $1', [instanceId]);
    } else {
      await client.query(
        'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
        [qty, instanceId]
      );
    }

    await client.query('COMMIT');

    const updatedChar = updatedCharResult.rows.length > 0 ? updatedCharResult.rows[0] : undefined;
    return {
      success: true,
      message: '使用成功',
      effects: item.effect_defs || [],
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
  const result = await query(`
    SELECT 
      ii.*,
      id.name, id.code, id.icon, id.category, id.sub_category,
      COALESCE(ii.quality, id.quality) as resolved_quality,
      COALESCE(ii.quality_rank, id.quality_rank) as resolved_quality_rank,
      id.quality_rank as def_quality_rank,
      id.stack_max, id.description,
      id.use_type, id.effect_defs, id.equip_slot, id.equip_req_realm,
      id.base_attrs, id.set_id
    FROM item_instance ii
    JOIN item_def id ON ii.item_def_id = id.id
    WHERE ii.id = $1
  `, [instanceId]);

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
    baseAttrsRaw: row.base_attrs,
    defQualityRankRaw: row.def_quality_rank,
    resolvedQualityRankRaw: row.resolved_quality_rank,
    strengthenLevelRaw: row.strengthen_level,
    refineLevelRaw: row.refine_level,
    socketedGemsRaw: row.socketed_gems,
  });
  return {
    id: row.id,
    itemDefId: row.item_def_id,
    name: row.name,
    code: row.code,
    icon: row.icon,
    category: row.category,
    subCategory: row.sub_category,
    quality: row.resolved_quality,
    qualityRank: row.resolved_quality_rank,
    qty: row.qty,
    stackMax: row.stack_max,
    description: row.description,
    // 装备专用
    equipSlot: row.equip_slot,
    equipReqRealm: row.equip_req_realm,
    baseAttrs: row.category === 'equipment' ? displayBaseAttrs : (row.base_attrs ?? {}),
    affixes: row.affixes || [],
    setId: row.set_id,
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
