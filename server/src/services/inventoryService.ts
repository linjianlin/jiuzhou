/**
 * 九州修仙录 - 背包服务
 * 性能优化策略：
 * 1. 批量操作减少数据库往返
 * 2. 使用事务保证数据一致性
 * 3. 缓存背包容量信息
 * 4. 智能堆叠合并
 */
import { query, pool } from '../config/database.js';
import type { PoolClient } from 'pg';
import { randomInt } from 'crypto';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import {
  ENHANCE_MAX_LEVEL,
  REFINE_MAX_LEVEL,
  buildEnhanceCostPlan,
  buildEquipmentDisplayBaseAttrs,
  buildRefineCostPlan,
  clampInt as clampGrowthInt,
  getEnhanceFailResultLevel,
  getEnhanceSuccessRatePermyriad,
  getRefineFailResultLevel,
  getRefineSuccessRatePermyriad,
  inferGemTypeFromEffects,
  isGemTypeAllowedInSlot,
  parseSocketEffectsFromItemEffectDefs,
  parseSocketedGems,
  resolveSocketMax,
  type SocketEffect,
  type SocketedGemEntry,
} from './equipmentGrowthRules.js';
import {
  resolveDisassembleRewardItemDefIdByQuality,
  resolveTechniqueBookDisassembleRewardByQuality,
} from './equipmentDisassembleRules.js';

// 背包位置类型
export type InventoryLocation = 'bag' | 'warehouse' | 'equipped';
export type SlottedInventoryLocation = 'bag' | 'warehouse';

// 背包物品接口
export interface InventoryItem {
  id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  location: InventoryLocation;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number;
  refine_level: number;
  socketed_gems: unknown;
  affixes: any;
  identified: boolean;
  locked: boolean;
  bind_type: string;
  created_at: Date;
}

// 背包信息接口
export interface InventoryInfo {
  bag_capacity: number;
  warehouse_capacity: number;
  bag_used: number;
  warehouse_used: number;
}

type CharacterAttrKey =
  | 'qixue'
  | 'max_qixue'
  | 'lingqi'
  | 'max_lingqi'
  | 'wugong'
  | 'fagong'
  | 'wufang'
  | 'fafang'
  | 'sudu'
  | 'mingzhong'
  | 'shanbi'
  | 'zhaojia'
  | 'baoji'
  | 'baoshang'
  | 'kangbao'
  | 'zengshang'
  | 'zhiliao'
  | 'jianliao'
  | 'xixue'
  | 'lengque'
  | 'shuxing_shuzhi'
  | 'kongzhi_kangxing'
  | 'jin_kangxing'
  | 'mu_kangxing'
  | 'shui_kangxing'
  | 'huo_kangxing'
  | 'tu_kangxing'
  | 'qixue_huifu'
  | 'lingqi_huifu';

const allowedCharacterAttrKeys = new Set<CharacterAttrKey>([
  'qixue',
  'max_qixue',
  'lingqi',
  'max_lingqi',
  'wugong',
  'fagong',
  'wufang',
  'fafang',
  'sudu',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'shuxing_shuzhi',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
  'qixue_huifu',
  'lingqi_huifu',
]);

const clampInt = clampGrowthInt;
export const BAG_CAPACITY_MAX = 200;

const getSlottedCapacity = (info: InventoryInfo, location: SlottedInventoryLocation): number =>
  location === 'bag' ? info.bag_capacity : info.warehouse_capacity;

const runQuery = (client: PoolClient | null, text: string, params?: unknown[]) => {
  if (client) return client.query(text, params);
  return query(text, params);
};

const safeNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const addToDelta = (delta: Map<CharacterAttrKey, number>, key: string, value: unknown) => {
  if (!allowedCharacterAttrKeys.has(key as CharacterAttrKey)) return;
  const v = safeNumber(value);
  if (v === 0) return;
  const k = key as CharacterAttrKey;
  delta.set(k, (delta.get(k) || 0) + v);
};

const mergeDelta = (a: Map<CharacterAttrKey, number>, b: Map<CharacterAttrKey, number>) => {
  for (const [k, v] of b.entries()) {
    if (v === 0) continue;
    a.set(k, (a.get(k) || 0) + v);
  }
};

const invertDelta = (delta: Map<CharacterAttrKey, number>) => {
  const out = new Map<CharacterAttrKey, number>();
  for (const [k, v] of delta.entries()) {
    if (v === 0) continue;
    out.set(k, -v);
  }
  return out;
};

const applyCharacterAttrDeltaTx = async (
  client: PoolClient,
  characterId: number,
  delta: Map<CharacterAttrKey, number>
): Promise<void> => {
  const entries = [...delta.entries()].filter(([, v]) => Number.isFinite(v) && v !== 0);
  if (entries.length === 0) return;

  const setSqlParts: string[] = [];
  const params: unknown[] = [];

  for (const [key, value] of entries) {
    params.push(value);
    setSqlParts.push(`${key} = GREATEST(0, ${key} + $${params.length})`);
  }

  params.push(characterId);
  setSqlParts.push(`updated_at = NOW()`);

  await client.query(
    `UPDATE characters SET ${setSqlParts.join(', ')} WHERE id = $${params.length}`,
    params
  );

  await client.query(
    `UPDATE characters
     SET qixue = LEAST(qixue, max_qixue),
         lingqi = LEAST(lingqi, max_lingqi),
         updated_at = NOW()
     WHERE id = $1`,
    [characterId]
  );
};

const getEquipmentAttrDeltaByInstanceIdTx = async (
  client: PoolClient,
  characterId: number,
  instanceId: number
): Promise<Map<CharacterAttrKey, number> | null> => {
  const result = await client.query(
    `
      SELECT
        ii.id,
        ii.owner_character_id,
        ii.affixes,
        ii.strengthen_level,
        ii.refine_level,
        ii.socketed_gems,
        id.category,
        id.base_attrs,
        id.quality_rank as def_quality_rank,
        COALESCE(ii.quality_rank, id.quality_rank) as resolved_quality_rank
      FROM item_instance ii
      JOIN item_def id ON id.id = ii.item_def_id
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      LIMIT 1
    `,
    [instanceId, characterId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (row.category !== 'equipment') return null;

  const delta = new Map<CharacterAttrKey, number>();

  const baseAttrs = buildEquipmentDisplayBaseAttrs({
    baseAttrsRaw: row.base_attrs,
    defQualityRankRaw: row.def_quality_rank,
    resolvedQualityRankRaw: row.resolved_quality_rank,
    strengthenLevelRaw: row.strengthen_level,
    refineLevelRaw: row.refine_level,
    socketedGemsRaw: row.socketed_gems,
  });

  for (const [k, v] of Object.entries(baseAttrs)) addToDelta(delta, k, v);

  const affixesRaw = row.affixes;
  const affixes: unknown[] = Array.isArray(affixesRaw)
    ? affixesRaw
    : typeof affixesRaw === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(affixesRaw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  for (const affix of affixes) {
    if (!affix || typeof affix !== 'object') continue;
    const a = affix as { attr_key?: unknown; apply_type?: unknown; value?: unknown };
    if (typeof a.attr_key !== 'string') continue;
    if (a.apply_type !== 'flat') continue;
    addToDelta(delta, a.attr_key, a.value);
  }

  return delta;
};

const consumeMaterialByDefIdTx = async (
  client: PoolClient,
  characterId: number,
  materialItemDefId: string,
  qty: number
): Promise<{ success: boolean; message: string }> => {
  const need = clampInt(qty, 1, 999999);
  const rowResult = await client.query(
    `
      SELECT id, qty, locked
      FROM item_instance
      WHERE owner_character_id = $1
        AND item_def_id = $2
        AND location IN ('bag', 'warehouse')
      ORDER BY qty DESC, id ASC
      FOR UPDATE
    `,
    [characterId, materialItemDefId]
  );

  if (rowResult.rows.length === 0) {
    return { success: false, message: '材料不足' };
  }

  const rows = rowResult.rows as Array<{ id: number; qty: number; locked: boolean }>;
  const unlockedRows = rows.filter((row) => !row.locked && (Number(row.qty) || 0) > 0);
  const unlockedTotal = unlockedRows.reduce((sum, row) => sum + Math.max(0, Number(row.qty) || 0), 0);

  if (unlockedTotal < need) {
    if (unlockedTotal <= 0 && rows.some((row) => row.locked)) {
      return { success: false, message: '材料已锁定' };
    }
    return { success: false, message: '材料不足' };
  }

  let remaining = need;
  for (const row of unlockedRows) {
    if (remaining <= 0) break;
    const rowQty = Math.max(0, Number(row.qty) || 0);
    if (rowQty <= 0) continue;

    const consume = Math.min(rowQty, remaining);
    if (consume >= rowQty) {
      await client.query('DELETE FROM item_instance WHERE id = $1', [row.id]);
    } else {
      await client.query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [consume, row.id]);
    }
    remaining -= consume;
  }

  return { success: true, message: '扣除成功' };
};

const consumeSpecificItemInstanceTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  qty: number
): Promise<{ success: boolean; message: string; itemDefId?: string }> => {
  const need = clampInt(qty, 1, 999999);
  const result = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId]
  );

  if (result.rows.length === 0) return { success: false, message: '道具不存在' };

  const row = result.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };
  if (row.locked) return { success: false, message: '道具已锁定' };
  if (!['bag', 'warehouse'].includes(String(row.location))) {
    return { success: false, message: '道具当前位置不可消耗' };
  }
  if ((Number(row.qty) || 0) < need) return { success: false, message: '道具数量不足' };

  if ((Number(row.qty) || 0) === need) {
    await client.query('DELETE FROM item_instance WHERE id = $1', [row.id]);
  } else {
    await client.query('UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2', [need, row.id]);
  }
  return { success: true, message: '扣除成功', itemDefId: String(row.item_def_id) };
};

const consumeCharacterCurrenciesTx = async (
  client: PoolClient,
  characterId: number,
  costs: { silver?: number; spiritStones?: number }
): Promise<{ success: boolean; message: string }> => {
  const silverCost = Math.max(0, Math.floor(Number(costs.silver) || 0));
  const spiritCost = Math.max(0, Math.floor(Number(costs.spiritStones) || 0));
  if (silverCost <= 0 && spiritCost <= 0) return { success: true, message: '无需扣除货币' };

  const charResult = await client.query(
    `SELECT silver, spirit_stones FROM characters WHERE id = $1 FOR UPDATE LIMIT 1`,
    [characterId]
  );
  if (charResult.rows.length === 0) return { success: false, message: '角色不存在' };

  const curSilver = Number(charResult.rows[0].silver ?? 0) || 0;
  const curSpirit = Number(charResult.rows[0].spirit_stones ?? 0) || 0;
  if (curSilver < silverCost) return { success: false, message: `银两不足，需要${silverCost}` };
  if (curSpirit < spiritCost) return { success: false, message: `灵石不足，需要${spiritCost}` };

  await client.query(
    `
      UPDATE characters
      SET silver = silver - $2,
          spirit_stones = spirit_stones - $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [characterId, silverCost, spiritCost]
  );
  return { success: true, message: '扣除成功' };
};

const getCharacterSnapshotTx = async (client: PoolClient, characterId: number, userId: number): Promise<unknown | null> => {
  const characterResult = await client.query('SELECT * FROM characters WHERE id = $1 AND user_id = $2 LIMIT 1', [
    characterId,
    userId,
  ]);
  return characterResult.rows.length > 0 ? characterResult.rows[0] : null;
};

const diffEquipmentAttrIfEquippedTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  location: unknown
): Promise<{ success: boolean; message: string; before?: Map<CharacterAttrKey, number> }> => {
  if (String(location) !== 'equipped') return { success: true, message: '无需差分' };
  const before = await getEquipmentAttrDeltaByInstanceIdTx(client, characterId, itemInstanceId);
  if (!before) return { success: false, message: '装备数据异常' };
  return { success: true, message: 'ok', before };
};

const applyEquipmentDiffIfEquippedTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number,
  location: unknown,
  before?: Map<CharacterAttrKey, number>
): Promise<{ success: boolean; message: string }> => {
  if (String(location) !== 'equipped') return { success: true, message: '无需差分' };
  if (!before) return { success: false, message: '装备数据异常' };
  const after = await getEquipmentAttrDeltaByInstanceIdTx(client, characterId, itemInstanceId);
  if (!after) return { success: false, message: '装备数据异常' };
  const diff = new Map<CharacterAttrKey, number>();
  mergeDelta(diff, after);
  mergeDelta(diff, invertDelta(before));
  await applyCharacterAttrDeltaTx(client, characterId, diff);
  return { success: true, message: 'ok' };
};

const getEnhanceItemStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    strengthenLevel: number;
    itemLevel: number;
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.strengthen_level,
        id.category,
        id.level
      FROM item_instance ii
      JOIN item_def id ON id.id = ii.item_def_id
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId]
  );

  if (itemResult.rows.length === 0) return { success: false, message: '物品不存在' };

  const row = itemResult.rows[0] as {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    strengthen_level: number;
    category: string;
    level: number | null;
  };

  if (row.category !== 'equipment') return { success: false, message: '该物品不可强化' };
  if (row.locked) return { success: false, message: '物品已锁定' };
  if (String(row.location) === 'auction') return { success: false, message: '交易中的装备不可强化' };
  if (!['bag', 'warehouse', 'equipped'].includes(String(row.location))) {
    return { success: false, message: '该物品当前位置不可强化' };
  }
  if ((Number(row.qty) || 0) !== 1) return { success: false, message: '装备数量异常' };

  return {
    success: true,
    message: 'ok',
    item: {
      id: Number(row.id),
      qty: Number(row.qty) || 1,
      location: row.location,
      locked: Boolean(row.locked),
      strengthenLevel: clampInt(Number(row.strengthen_level) || 0, 0, ENHANCE_MAX_LEVEL),
      itemLevel: Math.max(0, Math.floor(Number(row.level) || 0)),
    },
  };
};

const getRefineItemStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    refineLevel: number;
    itemLevel: number;
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.refine_level,
        id.category,
        id.level
      FROM item_instance ii
      JOIN item_def id ON id.id = ii.item_def_id
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId]
  );

  if (itemResult.rows.length === 0) return { success: false, message: '物品不存在' };

  const row = itemResult.rows[0] as {
    id: number;
    qty: number;
    location: InventoryLocation | string;
    locked: boolean;
    refine_level: number;
    category: string;
    level: number | null;
  };

  if (row.category !== 'equipment') return { success: false, message: '该物品不可精炼' };
  if (row.locked) return { success: false, message: '物品已锁定' };
  if (String(row.location) === 'auction') return { success: false, message: '交易中的装备不可精炼' };
  if (!['bag', 'warehouse', 'equipped'].includes(String(row.location))) {
    return { success: false, message: '该物品当前位置不可精炼' };
  }
  if ((Number(row.qty) || 0) !== 1) return { success: false, message: '装备数量异常' };

  return {
    success: true,
    message: 'ok',
    item: {
      id: Number(row.id),
      qty: Number(row.qty) || 1,
      location: row.location,
      locked: Boolean(row.locked),
      refineLevel: clampInt(Number(row.refine_level) || 0, 0, REFINE_MAX_LEVEL),
      itemLevel: Math.max(0, Math.floor(Number(row.level) || 0)),
    },
  };
};

const getEnhanceToolBonusPermyriad = async (
  client: PoolClient,
  characterId: number,
  toolItemInstanceId?: number
): Promise<{ success: boolean; message: string; bonusPermyriad: number; consumedToolItemDefId?: string }> => {
  if (!toolItemInstanceId) {
    return { success: true, message: '未使用强化符', bonusPermyriad: 0 };
  }

  const itemResult = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [toolItemInstanceId, characterId]
  );
  if (itemResult.rows.length === 0) {
    return { success: false, message: '强化符不存在', bonusPermyriad: 0 };
  }

  const item = itemResult.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };
  if (item.locked) return { success: false, message: '强化符已锁定', bonusPermyriad: 0 };
  if (!['bag', 'warehouse'].includes(String(item.location))) {
    return { success: false, message: '强化符当前位置不可消耗', bonusPermyriad: 0 };
  }
  if ((Number(item.qty) || 0) < 1) {
    return { success: false, message: '强化符数量不足', bonusPermyriad: 0 };
  }

  const toolDefId = String(item.item_def_id || '');
  if (!toolDefId) return { success: false, message: '强化符数据异常', bonusPermyriad: 0 };

  const defResult = await client.query(
    'SELECT effect_defs FROM item_def WHERE id = $1 AND enabled = true LIMIT 1',
    [toolDefId]
  );
  if (defResult.rows.length === 0) return { success: false, message: '强化符不存在', bonusPermyriad: 0 };

  const defs: unknown[] = Array.isArray(defResult.rows[0].effect_defs) ? defResult.rows[0].effect_defs : [];
  let bonus = 0;
  for (const raw of defs) {
    if (!raw || typeof raw !== 'object') continue;
    const effect = raw as {
      trigger?: unknown;
      effect_type?: unknown;
      params?: unknown;
    };
    if (String(effect.trigger || '') !== 'enhance') continue;
    if (String(effect.effect_type || '') !== 'buff') continue;
    const params = effect.params && typeof effect.params === 'object' ? (effect.params as Record<string, unknown>) : {};
    const v = Number(params.success_rate_bonus);
    if (Number.isFinite(v)) bonus += Math.floor(v);
  }

  if (bonus <= 0) {
    return { success: false, message: '该道具不是强化符', bonusPermyriad: 0 };
  }

  if ((Number(item.qty) || 0) === 1) {
    await client.query('DELETE FROM item_instance WHERE id = $1', [item.id]);
  } else {
    await client.query('UPDATE item_instance SET qty = qty - 1, updated_at = NOW() WHERE id = $1', [item.id]);
  }

  return {
    success: true,
    message: 'ok',
    bonusPermyriad: Math.max(0, bonus),
    consumedToolItemDefId: toolDefId,
  };
};

const consumeEnhanceProtectToolTx = async (
  client: PoolClient,
  characterId: number,
  toolItemInstanceId?: number
): Promise<{ success: boolean; message: string; protectDowngrade: boolean; consumedToolItemDefId?: string }> => {
  if (!toolItemInstanceId) {
    return { success: true, message: '未使用保护符', protectDowngrade: false };
  }

  const itemResult = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [toolItemInstanceId, characterId]
  );
  if (itemResult.rows.length === 0) {
    return { success: false, message: '保护符不存在', protectDowngrade: false };
  }

  const item = itemResult.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };
  if (item.locked) return { success: false, message: '保护符已锁定', protectDowngrade: false };
  if (!['bag', 'warehouse'].includes(String(item.location))) {
    return { success: false, message: '保护符当前位置不可消耗', protectDowngrade: false };
  }
  if ((Number(item.qty) || 0) < 1) {
    return { success: false, message: '保护符数量不足', protectDowngrade: false };
  }

  const toolDefId = String(item.item_def_id || '');
  if (!toolDefId) return { success: false, message: '保护符数据异常', protectDowngrade: false };

  const defResult = await client.query(
    'SELECT effect_defs FROM item_def WHERE id = $1 AND enabled = true LIMIT 1',
    [toolDefId]
  );
  if (defResult.rows.length === 0) return { success: false, message: '保护符不存在', protectDowngrade: false };

  const defs: unknown[] = Array.isArray(defResult.rows[0].effect_defs) ? defResult.rows[0].effect_defs : [];
  let protect = false;
  for (const raw of defs) {
    if (!raw || typeof raw !== 'object') continue;
    const effect = raw as {
      trigger?: unknown;
      effect_type?: unknown;
      params?: unknown;
    };
    if (String(effect.trigger || '') !== 'enhance') continue;
    if (String(effect.effect_type || '') !== 'protect') continue;
    const params = effect.params && typeof effect.params === 'object' ? (effect.params as Record<string, unknown>) : {};
    if (Boolean(params.protect_downgrade)) {
      protect = true;
      break;
    }
  }

  if (!protect) {
    return { success: false, message: '该道具不是保护符', protectDowngrade: false };
  }

  if ((Number(item.qty) || 0) === 1) {
    await client.query('DELETE FROM item_instance WHERE id = $1', [item.id]);
  } else {
    await client.query('UPDATE item_instance SET qty = qty - 1, updated_at = NOW() WHERE id = $1', [item.id]);
  }

  return {
    success: true,
    message: 'ok',
    protectDowngrade: protect,
    consumedToolItemDefId: toolDefId,
  };
};

const loadGemItemForSocketTx = async (
  client: PoolClient,
  characterId: number,
  gemItemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  gem?: {
    itemInstanceId: number;
    itemDefId: string;
    name: string;
    icon: string | null;
    gemType: string;
    effects: SocketEffect[];
  };
}> => {
  const itemResult = await client.query(
    `
      SELECT id, item_def_id, qty, locked, location
      FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [gemItemInstanceId, characterId]
  );

  if (itemResult.rows.length === 0) return { success: false, message: '宝石不存在' };

  const item = itemResult.rows[0] as {
    id: number;
    item_def_id: string;
    qty: number;
    locked: boolean;
    location: string;
  };

  if (item.locked) return { success: false, message: '宝石已锁定' };
  if (!['bag', 'warehouse'].includes(String(item.location))) {
    return { success: false, message: '宝石当前位置不可消耗' };
  }
  if ((Number(item.qty) || 0) < 1) return { success: false, message: '宝石数量不足' };

  const gemDefId = String(item.item_def_id || '');
  if (!gemDefId) return { success: false, message: '宝石数据异常' };

  const gemDefResult = await client.query(
    `
      SELECT id, name, icon, category, sub_category, effect_defs
      FROM item_def
      WHERE id = $1 AND enabled = true
      LIMIT 1
    `,
    [gemDefId]
  );
  if (gemDefResult.rows.length === 0) return { success: false, message: '宝石不存在' };
  const row = gemDefResult.rows[0] as {
    id: string;
    name: string;
    icon: string | null;
    category: string;
    sub_category: string | null;
    effect_defs: unknown;
  };

  const isGemSubCategory = (subCategoryRaw: unknown): boolean => {
    const subCategory = String(subCategoryRaw || '').trim().toLowerCase();
    if (!subCategory) return false;
    if (subCategory === 'gem') return true;
    return ['gem_attack', 'gem_defense', 'gem_survival', 'gem_all'].includes(subCategory);
  };

  const resolveGemTypeBySubCategory = (subCategoryRaw: unknown, effects: SocketEffect[]): string => {
    const subCategory = String(subCategoryRaw || '').trim().toLowerCase();
    if (subCategory === 'gem_attack') return 'attack';
    if (subCategory === 'gem_defense') return 'defense';
    if (subCategory === 'gem_survival') return 'survival';
    if (subCategory === 'gem_all') return 'all';
    return inferGemTypeFromEffects(effects);
  };

  if (row.category !== 'material' || !isGemSubCategory(row.sub_category)) {
    return { success: false, message: '该物品不是宝石' };
  }
  const effects = parseSocketEffectsFromItemEffectDefs(row.effect_defs);
  if (effects.length === 0) return { success: false, message: '该宝石不可镶嵌' };

  return {
    success: true,
    message: 'ok',
    gem: {
      itemInstanceId: Number(item.id),
      itemDefId: row.id,
      name: row.name,
      icon: row.icon,
      gemType: resolveGemTypeBySubCategory(row.sub_category, effects),
      effects,
    },
  };
};

const normalizeGemSlotTypes = (raw: unknown): unknown => {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return normalizeGemSlotTypes(parsed);
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
    return raw;
  }
  return null;
};

const normalizeSocketedGemEntries = (raw: unknown): SocketedGemEntry[] => {
  return parseSocketedGems(raw);
};

const toSocketedGemsJson = (entries: SocketedGemEntry[]): string => {
  const out = entries
    .map((entry) => ({
      slot: clampInt(Number(entry.slot) || 0, 0, 999),
      itemDefId: String(entry.itemDefId || '').trim(),
      gemType: String(entry.gemType || '').trim() || 'all',
      effects: entry.effects
        .map((effect) => ({
          attrKey: String(effect.attrKey || '').trim(),
          value: Number(effect.value) || 0,
          applyType: effect.applyType,
        }))
        .filter((effect) => effect.attrKey && Number.isFinite(effect.value) && effect.value !== 0),
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      icon: typeof entry.icon === 'string' && entry.icon.trim() ? entry.icon.trim() : undefined,
    }))
    .filter((entry) => entry.itemDefId && entry.effects.length > 0)
    .sort((a, b) => a.slot - b.slot);
  return JSON.stringify(out);
};

const findSocketEntryBySlot = (entries: SocketedGemEntry[], slot: number): SocketedGemEntry | null => {
  const target = clampInt(slot, 0, 999);
  return entries.find((entry) => clampInt(Number(entry.slot) || 0, 0, 999) === target) ?? null;
};

const getNextAvailableSocketSlot = (entries: SocketedGemEntry[], socketMax: number): number | null => {
  const max = clampInt(socketMax, 0, 99);
  if (max <= 0) return null;
  const used = new Set(entries.map((entry) => clampInt(Number(entry.slot) || 0, 0, 999)));
  for (let slot = 0; slot < max; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
};

const upsertSocketEntry = (
  entries: SocketedGemEntry[],
  nextEntry: SocketedGemEntry
): SocketedGemEntry[] => {
  const slot = clampInt(Number(nextEntry.slot) || 0, 0, 999);
  const filtered = entries.filter((entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== slot);
  return [...filtered, nextEntry].sort((a, b) => a.slot - b.slot);
};

const removeSocketEntryBySlot = (entries: SocketedGemEntry[], slot: number): SocketedGemEntry[] => {
  const target = clampInt(slot, 0, 999);
  return entries.filter((entry) => clampInt(Number(entry.slot) || 0, 0, 999) !== target);
};

const readEquipmentSocketStateTx = async (
  client: PoolClient,
  characterId: number,
  itemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  item?: {
    id: number;
    location: string;
    qty: number;
    locked: boolean;
    socketMax: number;
    gemSlotTypes: unknown;
    socketedEntries: SocketedGemEntry[];
  };
}> => {
  const result = await client.query(
    `
      SELECT
        ii.id,
        ii.qty,
        ii.location,
        ii.locked,
        ii.socketed_gems,
        id.category,
        id.socket_max,
        id.gem_slot_types,
        COALESCE(ii.quality_rank, id.quality_rank) AS resolved_quality_rank
      FROM item_instance ii
      JOIN item_def id ON id.id = ii.item_def_id
      WHERE ii.id = $1 AND ii.owner_character_id = $2
      FOR UPDATE
      LIMIT 1
    `,
    [itemInstanceId, characterId]
  );
  if (result.rows.length === 0) return { success: false, message: '物品不存在' };
  const row = result.rows[0] as {
    id: number;
    qty: number;
    location: string;
    locked: boolean;
    socketed_gems: unknown;
    category: string;
    socket_max: unknown;
    gem_slot_types: unknown;
    resolved_quality_rank: unknown;
  };

  if (row.category !== 'equipment') return { success: false, message: '该物品不可镶嵌' };
  if (row.locked) return { success: false, message: '物品已锁定' };
  if ((Number(row.qty) || 0) !== 1) return { success: false, message: '装备数量异常' };
  if (String(row.location) === 'auction') return { success: false, message: '交易中的装备不可镶嵌' };
  if (!['bag', 'warehouse', 'equipped'].includes(String(row.location))) {
    return { success: false, message: '该物品当前位置不可镶嵌' };
  }

  const socketMax = resolveSocketMax(row.socket_max, row.resolved_quality_rank);
  if (socketMax <= 0) return { success: false, message: '该装备无可用镶嵌孔' };

  return {
    success: true,
    message: 'ok',
    item: {
      id: Number(row.id),
      location: String(row.location),
      qty: Number(row.qty) || 1,
      locked: Boolean(row.locked),
      socketMax,
      gemSlotTypes: normalizeGemSlotTypes(row.gem_slot_types),
      socketedEntries: normalizeSocketedGemEntries(row.socketed_gems),
    },
  };
};

const getEquippedSetBonusDeltaTx = async (
  client: PoolClient,
  characterId: number
): Promise<Map<CharacterAttrKey, number>> => {
  const equippedResult = await client.query(
    `
      SELECT id.set_id
      FROM item_instance ii
      JOIN item_def id ON id.id = ii.item_def_id
      WHERE ii.owner_character_id = $1 AND ii.location = 'equipped' AND id.set_id IS NOT NULL
    `,
    [characterId]
  );

  const counts = new Map<string, number>();
  for (const row of equippedResult.rows) {
    const setId = String(row.set_id || '');
    if (!setId) continue;
    counts.set(setId, (counts.get(setId) || 0) + 1);
  }

  const setIds = [...counts.keys()];
  if (setIds.length === 0) return new Map();

  const bonusResult = await client.query(
    `
      SELECT set_id, piece_count, effect_defs
      FROM item_set_bonus
      WHERE set_id = ANY($1)
      ORDER BY priority ASC, piece_count ASC
    `,
    [setIds]
  );

  const delta = new Map<CharacterAttrKey, number>();

  for (const row of bonusResult.rows) {
    const setId = String(row.set_id || '');
    const pieces = counts.get(setId) || 0;
    const need = safeNumber(row.piece_count);
    if (pieces < need) continue;

    const effects: unknown[] = Array.isArray(row.effect_defs) ? row.effect_defs : [];
    for (const effect of effects) {
      if (!effect || typeof effect !== 'object') continue;
      const e = effect as {
        trigger?: unknown;
        target?: unknown;
        effect_type?: unknown;
        params?: unknown;
      };
      if (e.effect_type !== 'buff') continue;
      if (e.trigger !== 'equip') continue;
      if (e.target !== 'self') continue;
      if (!e.params || typeof e.params !== 'object') continue;

      const p = e.params as { attr_key?: unknown; value?: unknown; apply_type?: unknown };
      if (p.apply_type !== 'flat') continue;
      if (typeof p.attr_key !== 'string') continue;
      addToDelta(delta, p.attr_key, p.value);
    }
  }

  return delta;
};

// ============================================
// 获取背包信息（容量与使用情况）
// ============================================
export const getInventoryInfo = async (characterId: number): Promise<InventoryInfo> => {
  return getInventoryInfoWithClient(characterId, null);
};

export const getInventoryInfoWithClient = async (
  characterId: number,
  client: PoolClient | null
): Promise<InventoryInfo> => {
  const sql = `
    SELECT
      i.bag_capacity,
      i.warehouse_capacity,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'bag'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as bag_used,
      (SELECT COUNT(DISTINCT location_slot)::int
         FROM item_instance
        WHERE owner_character_id = $1
          AND location = 'warehouse'
          AND location_slot IS NOT NULL
          AND location_slot >= 0) as warehouse_used
    FROM inventory i
    WHERE i.character_id = $1
  `;

  const result = await runQuery(client, sql, [characterId]);

  if (result.rows.length === 0) {
    await runQuery(
      client,
      'INSERT INTO inventory (character_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [characterId]
    );
    return { bag_capacity: 100, warehouse_capacity: 50, bag_used: 0, warehouse_used: 0 };
  }

  const info = result.rows[0];
  return info;
};

// ============================================
// 获取背包物品列表（分页优化）
// ============================================
export const getInventoryItems = async (
  characterId: number,
  location: InventoryLocation = 'bag',
  page: number = 1,
  pageSize: number = 100
): Promise<{ items: InventoryItem[]; total: number }> => {
  await getInventoryInfo(characterId);
  const offset = (page - 1) * pageSize;
  
  // 使用单次查询获取数据和总数
  const sql = `
    WITH items AS (
      SELECT 
        ii.id, ii.item_def_id, ii.qty, ii.location, ii.location_slot,
        ii.quality, ii.quality_rank,
        ii.equipped_slot, ii.strengthen_level, ii.refine_level,
        ii.socketed_gems,
        ii.affixes, ii.identified, ii.locked, ii.bind_type, ii.created_at
      FROM item_instance ii
      WHERE ii.owner_character_id = $1 AND ii.location = $2
      ORDER BY ii.location_slot NULLS LAST, ii.created_at DESC
      LIMIT $3 OFFSET $4
    ),
    total AS (
      SELECT COUNT(*) as cnt FROM item_instance 
      WHERE owner_character_id = $1 AND location = $2
    )
    SELECT items.*, total.cnt as total_count
    FROM items, total
  `;
  
  const result = await query(sql, [characterId, location, pageSize, offset]);
  
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count) : 0;
  const items = result.rows.map(row => {
    const { total_count, ...item } = row;
    return item as InventoryItem;
  });
  
  return { items, total };
};

// ============================================
// 查找空闲格子（性能优化版）
// ============================================
export const findEmptySlots = async (
  characterId: number,
  location: SlottedInventoryLocation,
  count: number = 1
): Promise<number[]> => {
  return findEmptySlotsWithClient(characterId, location, count, null);
};

export const findEmptySlotsWithClient = async (
  characterId: number,
  location: SlottedInventoryLocation,
  count: number = 1,
  client: PoolClient | null
): Promise<number[]> => {
  const info = await getInventoryInfoWithClient(characterId, client);
  const capacity = getSlottedCapacity(info, location);
  
  // 获取已占用的格子
  const sql = `
    SELECT location_slot FROM item_instance
    WHERE owner_character_id = $1 AND location = $2 AND location_slot IS NOT NULL
    ORDER BY location_slot
  `;
  const result = await runQuery(client, sql, [characterId, location]);
  const usedSlots = new Set(result.rows.map(r => r.location_slot));
  
  // 找出空闲格子
  const emptySlots: number[] = [];
  for (let i = 0; i < capacity && emptySlots.length < count; i++) {
    if (!usedSlots.has(i)) {
      emptySlots.push(i);
    }
  }
  
  return emptySlots;
};

// ============================================
// 添加物品到背包（智能堆叠）
// ============================================
export const addItemToInventoryTx = async (
  client: PoolClient,
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: SlottedInventoryLocation;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
  } = {}
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  const isUniqueViolation = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === '23505';
  };

  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: '数量参数错误' };
  }

  await lockCharacterInventoryMutexTx(client, characterId);

  const location = options.location || 'bag';
  const bindType = options.bindType || 'none';

  const defResult = await client.query(
    'SELECT stack_max, bind_type as def_bind_type FROM item_def WHERE id = $1',
    [itemDefId]
  );

  if (defResult.rows.length === 0) {
    return { success: false, message: '物品不存在' };
  }

  const { stack_max, def_bind_type } = defResult.rows[0];
  const actualBindType = bindType !== 'none' ? bindType : def_bind_type;

  const info = await getInventoryInfoWithClient(characterId, client);
  const capacity = getSlottedCapacity(info, location);

  const savepointName = 'sp_add_item_to_inventory_tx';
  await client.query(`SAVEPOINT ${savepointName}`);

  const itemIds: number[] = [];
  let remainingQty = qty;

  const rollbackToSavepointAndReturn = async (message: string) => {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    return { success: false, message };
  };

  try {
    let stackRows: Array<{ id: number; qty: number }> = [];
    if (stack_max > 1) {
      const stackResult = await client.query(
        `
          SELECT id, qty FROM item_instance
          WHERE owner_character_id = $1 AND item_def_id = $2 
            AND location = $3 AND qty < $4 AND bind_type = $5
          ORDER BY qty DESC
          FOR UPDATE
        `,
        [characterId, itemDefId, location, stack_max, actualBindType]
      );
      stackRows = stackResult.rows.map((r) => ({ id: Number(r.id), qty: Number(r.qty) }));
    }

    let remainingAfterStacks = remainingQty;
    if (stack_max > 1 && stackRows.length > 0) {
      let freeInStacks = 0;
      for (const row of stackRows) {
        const rowQty = Number(row.qty) || 0;
        const free = Math.max(0, stack_max - rowQty);
        freeInStacks += free;
      }
      remainingAfterStacks = Math.max(0, remainingQty - freeInStacks);
    }

    const neededSlots =
      remainingAfterStacks <= 0 ? 0 : Math.ceil(remainingAfterStacks / Math.max(1, stack_max));
    if (neededSlots > 0) {
      const emptySlots = await findEmptySlotsWithClient(characterId, location, neededSlots, client);
      if (emptySlots.length < neededSlots) {
        return await rollbackToSavepointAndReturn('背包已满');
      }
    }

    if (stack_max > 1 && stackRows.length > 0) {
      for (const row of stackRows) {
        if (remainingQty <= 0) break;

        const rowQty = Number(row.qty) || 0;
        const canAdd = Math.min(remainingQty, Math.max(0, stack_max - rowQty));
        if (canAdd <= 0) continue;

        await client.query('UPDATE item_instance SET qty = qty + $1, updated_at = NOW() WHERE id = $2', [
          canAdd,
          row.id,
        ]);
        itemIds.push(row.id);
        remainingQty -= canAdd;
      }
    }

    while (remainingQty > 0) {
      const addQty = Math.min(remainingQty, Math.max(1, stack_max));
      let insertedId: number | null = null;
      let attempt = 0;

      while (insertedId === null && attempt < 6) {
        attempt += 1;
        const emptySlots = await findEmptySlotsWithClient(characterId, location, 6, client);
        if (emptySlots.length === 0) {
          return await rollbackToSavepointAndReturn('背包已满');
        }

        for (const slot of emptySlots) {
          try {
            const insertResult = await client.query(
              `
                INSERT INTO item_instance (
                  owner_user_id, owner_character_id, item_def_id, qty,
                  location, location_slot, bind_type, affixes, obtained_from
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
              `,
              [
                userId,
                characterId,
                itemDefId,
                addQty,
                location,
                slot,
                actualBindType,
                options.affixes ? JSON.stringify(options.affixes) : null,
                options.obtainedFrom || 'system',
              ]
            );
            insertedId = Number(insertResult.rows[0]?.id);
            break;
          } catch (error) {
            if (isUniqueViolation(error)) continue;
            throw error;
          }
        }
      }

      if (insertedId === null || !Number.isFinite(insertedId)) {
        return await rollbackToSavepointAndReturn('背包已满');
      }

      itemIds.push(insertedId);
      remainingQty -= addQty;
    }

    const usedSlots = location === 'bag' ? info.bag_used : info.warehouse_used;
    if (usedSlots > capacity) {
      return await rollbackToSavepointAndReturn('背包数据异常');
    }

    await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    return { success: true, message: '添加成功', itemIds };
  } catch (error) {
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    } catch {
    }
    throw error;
  }
};

export const addItemToInventory = async (
  characterId: number,
  userId: number,
  itemDefId: string,
  qty: number,
  options: {
    location?: SlottedInventoryLocation;
    bindType?: string;
    affixes?: any;
    obtainedFrom?: string;
  } = {}
): Promise<{ success: boolean; message: string; itemIds?: number[] }> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const txResult = await addItemToInventoryTx(client, characterId, userId, itemDefId, qty, options);
    if (!txResult.success) {
      await client.query('ROLLBACK');
      return txResult;
    }

    await client.query('COMMIT');
    return txResult;
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('添加物品失败:', error);
    return { success: false, message: '添加物品失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 移除物品（支持部分移除）
// ============================================
export const removeItemFromInventory = async (
  characterId: number,
  itemInstanceId: number,
  qty: number = 1
): Promise<{ success: boolean; message: string }> => {
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, message: '数量参数错误' };
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);
    
    // 获取物品信息并锁定
    const result = await client.query(`
      SELECT id, qty, locked FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
    `, [itemInstanceId, characterId]);
    
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }
    
    const item = result.rows[0];
    
    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }
    
    if (item.qty < qty) {
      await client.query('ROLLBACK');
      return { success: false, message: '数量不足' };
    }
    
    if (item.qty === qty) {
      // 完全移除
      await client.query('DELETE FROM item_instance WHERE id = $1', [itemInstanceId]);
    } else {
      // 部分移除
      await client.query(
        'UPDATE item_instance SET qty = qty - $1, updated_at = NOW() WHERE id = $2',
        [qty, itemInstanceId]
      );
    }
    
    await client.query('COMMIT');
    return { success: true, message: '移除成功' };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('移除物品失败:', error);
    return { success: false, message: '移除物品失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 移动物品（换位/移动到仓库）
// ============================================
export const moveItem = async (
  characterId: number,
  itemInstanceId: number,
  targetLocation: SlottedInventoryLocation,
  targetSlot?: number
): Promise<{ success: boolean; message: string }> => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);
    
    // 获取物品信息
    const itemResult = await client.query(`
      SELECT id, location, location_slot FROM item_instance
      WHERE id = $1 AND owner_character_id = $2
      FOR UPDATE
    `, [itemInstanceId, characterId]);
    
    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    if (itemResult.rows[0].location_slot === null) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品格子状态异常' };
    }
    
    // 检查目标位置容量
    const info = await getInventoryInfo(characterId);
    const capacity = getSlottedCapacity(info, targetLocation);
    if (targetSlot !== undefined) {
      if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot >= capacity) {
        await client.query('ROLLBACK');
        return { success: false, message: '目标格子超出容量' };
      }
    }
    
    // 确定目标格子
    let finalSlot = targetSlot;
    if (finalSlot === undefined) {
      const emptySlots = await findEmptySlotsWithClient(characterId, targetLocation, 1, client);
      if (emptySlots.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '目标位置已满' };
      }
      finalSlot = emptySlots[0];
    } else {
      // 检查目标格子是否被占用
      const slotCheck = await client.query(`
        SELECT id FROM item_instance
        WHERE owner_character_id = $1 AND location = $2 AND location_slot = $3 AND id != $4
        FOR UPDATE
      `, [characterId, targetLocation, finalSlot, itemInstanceId]);
      
      if (slotCheck.rows.length > 0) {
        // 交换位置
        const otherItemId = slotCheck.rows[0].id;
        const currentItem = itemResult.rows[0];

        // 先临时释放当前物品格子，再执行换位，避免唯一索引瞬时冲突
        await client.query(
          `
            UPDATE item_instance
            SET location_slot = NULL, updated_at = NOW()
            WHERE id = $1 AND owner_character_id = $2
          `,
          [itemInstanceId, characterId]
        );
        
        await client.query(`
          UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
          WHERE id = $3 AND owner_character_id = $4
        `, [currentItem.location, currentItem.location_slot, otherItemId, characterId]);
      }
    }
    
    // 移动物品
    await client.query(`
      UPDATE item_instance SET location = $1, location_slot = $2, updated_at = NOW()
      WHERE id = $3 AND owner_character_id = $4
    `, [targetLocation, finalSlot, itemInstanceId, characterId]);
    
    await client.query('COMMIT');
    return { success: true, message: '移动成功' };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('移动物品失败:', error);
    return { success: false, message: '移动物品失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 装备 / 卸下装备
// ============================================
export const equipItem = async (
  characterId: number,
  userId: number,
  itemInstanceId: number
): Promise<{ success: boolean; message: string; equippedSlot?: string; swappedOutItemId?: number }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const beforeSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);

    const itemResult = await client.query(
      `
        SELECT ii.id, ii.qty, ii.location, ii.location_slot, ii.locked, id.category, id.equip_slot, id.bind_type
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const item = itemResult.rows[0] as {
      id: number;
      qty: number;
      location: InventoryLocation;
      location_slot: number | null;
      locked: boolean;
      category: string;
      equip_slot: string | null;
      bind_type: string;
    };

    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }

    if (item.category !== 'equipment') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可装备' };
    }

    if (!item.equip_slot) {
      await client.query('ROLLBACK');
      return { success: false, message: '装备槽位配置错误' };
    }

    if (item.qty !== 1) {
      await client.query('ROLLBACK');
      return { success: false, message: '装备数量异常' };
    }

    if (item.location === 'equipped') {
      await client.query('ROLLBACK');
      return { success: false, message: '该装备已穿戴' };
    }

    if (item.location !== 'bag' && item.location !== 'warehouse') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品当前位置不可装备' };
    }

    const newItemDelta = await getEquipmentAttrDeltaByInstanceIdTx(client, characterId, itemInstanceId);
    if (!newItemDelta) {
      await client.query('ROLLBACK');
      return { success: false, message: '装备数据异常' };
    }

    const currentlyEquippedResult = await client.query(
      `
        SELECT ii.id
        FROM item_instance ii
        WHERE ii.owner_character_id = $1 AND ii.location = 'equipped' AND ii.equipped_slot = $2
        FOR UPDATE
      `,
      [characterId, item.equip_slot]
    );

    let swappedOutItemId: number | undefined;
    if (currentlyEquippedResult.rows.length > 0) {
      swappedOutItemId = Number(currentlyEquippedResult.rows[0].id);
      if (Number.isFinite(swappedOutItemId)) {
        const oldDelta = await getEquipmentAttrDeltaByInstanceIdTx(client, characterId, swappedOutItemId);
        if (!oldDelta) {
          await client.query('ROLLBACK');
          return { success: false, message: '当前已穿戴装备数据异常' };
        }

        const emptySlots = await findEmptySlotsWithClient(characterId, 'bag', 1, client);
        if (emptySlots.length === 0) {
          await client.query('ROLLBACK');
          return { success: false, message: '背包已满，无法替换装备' };
        }

        await client.query(
          `
            UPDATE item_instance
            SET location = 'bag',
                location_slot = $1,
                equipped_slot = NULL,
                updated_at = NOW()
            WHERE id = $2 AND owner_character_id = $3
          `,
          [emptySlots[0], swappedOutItemId, characterId]
        );

        await applyCharacterAttrDeltaTx(client, characterId, invertDelta(oldDelta));
      }
    }

    await client.query(
      `
        UPDATE item_instance
        SET location = 'equipped',
            location_slot = NULL,
            equipped_slot = $1,
            bind_type = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN 'equip'
              ELSE bind_type
            END,
            bind_owner_user_id = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN $3
              ELSE bind_owner_user_id
            END,
            bind_owner_character_id = CASE
              WHEN bind_type = 'none' AND $2 = 'equip' THEN $4
              ELSE bind_owner_character_id
            END,
            updated_at = NOW()
        WHERE id = $5 AND owner_character_id = $4
      `,
      [item.equip_slot, item.bind_type, userId, characterId, itemInstanceId]
    );

    await applyCharacterAttrDeltaTx(client, characterId, newItemDelta);

    const afterSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);
    const setBonusDelta = new Map<CharacterAttrKey, number>();
    mergeDelta(setBonusDelta, afterSetBonus);
    mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
    await applyCharacterAttrDeltaTx(client, characterId, setBonusDelta);

    await client.query('COMMIT');
    return { success: true, message: '穿戴成功', equippedSlot: item.equip_slot, swappedOutItemId };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('穿戴装备失败:', error);
    return { success: false, message: '穿戴装备失败' };
  } finally {
    client.release();
  }
};

export const unequipItem = async (
  characterId: number,
  itemInstanceId: number,
  options: { targetLocation?: SlottedInventoryLocation } = {}
): Promise<{ success: boolean; message: string; movedTo?: { location: SlottedInventoryLocation; slot: number } }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const beforeSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);

    const itemResult = await client.query(
      `
        SELECT id, location, equipped_slot, locked
        FROM item_instance
        WHERE id = $1 AND owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const item = itemResult.rows[0] as {
      id: number;
      location: InventoryLocation;
      equipped_slot: string | null;
      locked: boolean;
    };

    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }

    if (item.location !== 'equipped') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品未穿戴' };
    }

    const delta = await getEquipmentAttrDeltaByInstanceIdTx(client, characterId, itemInstanceId);
    if (!delta) {
      await client.query('ROLLBACK');
      return { success: false, message: '装备数据异常' };
    }

    const targetLocation = options.targetLocation || 'bag';
    const emptySlots = await findEmptySlotsWithClient(characterId, targetLocation, 1, client);
    if (emptySlots.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: targetLocation === 'bag' ? '背包已满' : '仓库已满' };
    }

    const slot = emptySlots[0];

    await client.query(
      `
        UPDATE item_instance
        SET location = $1,
            location_slot = $2,
            equipped_slot = NULL,
            updated_at = NOW()
        WHERE id = $3 AND owner_character_id = $4
      `,
      [targetLocation, slot, itemInstanceId, characterId]
    );

    await applyCharacterAttrDeltaTx(client, characterId, invertDelta(delta));

    const afterSetBonus = await getEquippedSetBonusDeltaTx(client, characterId);
    const setBonusDelta = new Map<CharacterAttrKey, number>();
    mergeDelta(setBonusDelta, afterSetBonus);
    mergeDelta(setBonusDelta, invertDelta(beforeSetBonus));
    await applyCharacterAttrDeltaTx(client, characterId, setBonusDelta);

    await client.query('COMMIT');
    return { success: true, message: '卸下成功', movedTo: { location: targetLocation, slot } };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('卸下装备失败:', error);
    return { success: false, message: '卸下装备失败' };
  } finally {
    client.release();
  }
};

export const enhanceEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
  options: { enhanceToolItemId?: number; protectToolItemId?: number } = {}
): Promise<{
  success: boolean;
  message: string;
  data?: {
    strengthenLevel: number;
    targetLevel?: number;
    successRatePermyriad?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    usedEnhanceToolItemDefId?: string;
    usedProtectToolItemDefId?: string;
    protectedDowngrade?: boolean;
    character?: unknown;
  };
}> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const itemState = await getEnhanceItemStateTx(client, characterId, itemInstanceId);
    if (!itemState.success || !itemState.item) {
      await client.query('ROLLBACK');
      return { success: false, message: itemState.message };
    }
    const item = itemState.item;

    const curLv = clampInt(item.strengthenLevel, 0, ENHANCE_MAX_LEVEL);
    if (curLv >= ENHANCE_MAX_LEVEL) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: '强化已达上限',
        data: { strengthenLevel: curLv, targetLevel: curLv },
      };
    }

    const targetLv = curLv + 1;
    const costPlan = buildEnhanceCostPlan(item.itemLevel, targetLv);

    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(client, characterId, itemInstanceId, item.location);
    if (!beforeDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: beforeDiffRes.message };
    }

    const materialRes = await consumeMaterialByDefIdTx(
      client,
      characterId,
      costPlan.materialItemDefId,
      costPlan.materialQty
    );
    if (!materialRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: materialRes.message };
    }

    const currencyRes = await consumeCharacterCurrenciesTx(client, characterId, {
      silver: costPlan.silverCost,
      spiritStones: costPlan.spiritStoneCost,
    });
    if (!currencyRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: currencyRes.message };
    }

    const enhanceToolRes = await getEnhanceToolBonusPermyriad(
      client,
      characterId,
      options.enhanceToolItemId
    );
    if (!enhanceToolRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: enhanceToolRes.message };
    }

    const protectToolRes = await consumeEnhanceProtectToolTx(
      client,
      characterId,
      options.protectToolItemId
    );
    if (!protectToolRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: protectToolRes.message };
    }

    const baseRate = getEnhanceSuccessRatePermyriad(targetLv);
    const finalRate = clampInt(baseRate + enhanceToolRes.bonusPermyriad, 0, 10000);
    const roll = randomInt(1, 10001);
    const success = roll <= finalRate;

    const resultLevel = success
      ? targetLv
      : getEnhanceFailResultLevel(curLv, targetLv, protectToolRes.protectDowngrade);

    if (resultLevel !== curLv) {
      await client.query(
        'UPDATE item_instance SET strengthen_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3',
        [resultLevel, itemInstanceId, characterId]
      );
    }

    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before
    );
    if (!applyDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: applyDiffRes.message };
    }

    const character = await getCharacterSnapshotTx(client, characterId, userId);

    await client.query('COMMIT');
    return {
      success,
      message: success ? '强化成功' : '强化失败',
      data: {
        strengthenLevel: resultLevel,
        targetLevel: targetLv,
        successRatePermyriad: finalRate,
        roll,
        usedMaterial: { itemDefId: costPlan.materialItemDefId, qty: costPlan.materialQty },
        costs: {
          silver: costPlan.silverCost,
          spiritStones: costPlan.spiritStoneCost,
        },
        usedEnhanceToolItemDefId: enhanceToolRes.consumedToolItemDefId,
        usedProtectToolItemDefId: protectToolRes.consumedToolItemDefId,
        protectedDowngrade: !success && protectToolRes.protectDowngrade,
        character: character ?? null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('强化装备失败:', error);
    return { success: false, message: '强化装备失败' };
  } finally {
    client.release();
  }
};

export const refineEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  data?: {
    refineLevel: number;
    targetLevel?: number;
    successRatePermyriad?: number;
    roll?: number;
    usedMaterial?: { itemDefId: string; qty: number };
    costs?: { silver: number; spiritStones: number };
    character?: unknown;
  };
}> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const itemState = await getRefineItemStateTx(client, characterId, itemInstanceId);
    if (!itemState.success || !itemState.item) {
      await client.query('ROLLBACK');
      return { success: false, message: itemState.message };
    }
    const item = itemState.item;

    const curLv = clampInt(item.refineLevel, 0, REFINE_MAX_LEVEL);
    if (curLv >= REFINE_MAX_LEVEL) {
      await client.query('ROLLBACK');
      return {
        success: false,
        message: '精炼已达上限',
        data: { refineLevel: curLv, targetLevel: curLv },
      };
    }

    const targetLv = curLv + 1;
    const costPlan = buildRefineCostPlan(item.itemLevel, targetLv);

    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(client, characterId, itemInstanceId, item.location);
    if (!beforeDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: beforeDiffRes.message };
    }

    const materialRes = await consumeMaterialByDefIdTx(
      client,
      characterId,
      costPlan.materialItemDefId,
      costPlan.materialQty
    );
    if (!materialRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: materialRes.message };
    }

    const currencyRes = await consumeCharacterCurrenciesTx(client, characterId, {
      silver: costPlan.silverCost,
      spiritStones: costPlan.spiritStoneCost,
    });
    if (!currencyRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: currencyRes.message };
    }

    const finalRate = getRefineSuccessRatePermyriad(targetLv);
    const roll = randomInt(1, 10001);
    const success = roll <= finalRate;
    const resultLevel = success ? targetLv : getRefineFailResultLevel(curLv, targetLv);

    if (resultLevel !== curLv) {
      await client.query(
        'UPDATE item_instance SET refine_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3',
        [resultLevel, itemInstanceId, characterId]
      );
    }

    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      item.location,
      beforeDiffRes.before
    );
    if (!applyDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: applyDiffRes.message };
    }

    const character = await getCharacterSnapshotTx(client, characterId, userId);

    await client.query('COMMIT');
    return {
      success,
      message: success ? '精炼成功' : '精炼失败',
      data: {
        refineLevel: resultLevel,
        targetLevel: targetLv,
        successRatePermyriad: finalRate,
        roll,
        usedMaterial: { itemDefId: costPlan.materialItemDefId, qty: costPlan.materialQty },
        costs: {
          silver: costPlan.silverCost,
          spiritStones: costPlan.spiritStoneCost,
        },
        character: character ?? null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('精炼装备失败:', error);
    return { success: false, message: '精炼装备失败' };
  } finally {
    client.release();
  }
};

export const socketEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number,
  gemItemInstanceId: number,
  options: { slot?: number } = {}
): Promise<{
  success: boolean;
  message: string;
  data?: {
    socketedGems: SocketedGemEntry[];
    socketMax: number;
    slot: number;
    gem: { itemDefId: string; name: string; icon: string | null; gemType: string };
    replacedGem?: SocketedGemEntry;
    costs?: { silver: number };
    character?: unknown;
  };
}> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const socketState = await readEquipmentSocketStateTx(client, characterId, itemInstanceId);
    if (!socketState.success || !socketState.item) {
      await client.query('ROLLBACK');
      return { success: false, message: socketState.message };
    }
    const equip = socketState.item;

    const beforeDiffRes = await diffEquipmentAttrIfEquippedTx(client, characterId, itemInstanceId, equip.location);
    if (!beforeDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: beforeDiffRes.message };
    }

    let slot =
      options.slot === undefined || options.slot === null
        ? null
        : clampInt(Number(options.slot) || 0, 0, Math.max(0, equip.socketMax - 1));
    if (slot === null) {
      slot = getNextAvailableSocketSlot(equip.socketedEntries, equip.socketMax);
      if (slot === null) {
        await client.query('ROLLBACK');
        return { success: false, message: '镶嵌孔已满，请指定替换孔位' };
      }
    }

    if (slot < 0 || slot >= equip.socketMax) {
      await client.query('ROLLBACK');
      return { success: false, message: '孔位参数错误' };
    }

    const gemRes = await loadGemItemForSocketTx(client, characterId, gemItemInstanceId);
    if (!gemRes.success || !gemRes.gem) {
      await client.query('ROLLBACK');
      return { success: false, message: gemRes.message };
    }
    const gem = gemRes.gem;

    if (!isGemTypeAllowedInSlot(equip.gemSlotTypes, slot, gem.gemType)) {
      await client.query('ROLLBACK');
      return { success: false, message: '该宝石类型与孔位不匹配' };
    }

    const duplicatedGem = equip.socketedEntries.find(
      (entry) =>
        String(entry.itemDefId || '') === String(gem.itemDefId || '') &&
        clampInt(Number(entry.slot) || 0, 0, 999) !== slot
    );
    if (duplicatedGem) {
      await client.query('ROLLBACK');
      return { success: false, message: '同一件装备不可镶嵌相同宝石' };
    }

    const replacedGem = findSocketEntryBySlot(equip.socketedEntries, slot);

    const silverCost = replacedGem ? 100 : 50;
    const currencyRes = await consumeCharacterCurrenciesTx(client, characterId, {
      silver: silverCost,
    });
    if (!currencyRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: currencyRes.message };
    }

    const nextEntries = upsertSocketEntry(equip.socketedEntries, {
      slot,
      itemDefId: gem.itemDefId,
      gemType: gem.gemType,
      effects: gem.effects,
      name: gem.name,
      icon: gem.icon ?? undefined,
    });

    if ((Number(gem.itemInstanceId) || 0) > 0) {
      const consumeGemRes = await consumeSpecificItemInstanceTx(client, characterId, Number(gem.itemInstanceId), 1);
      if (!consumeGemRes.success) {
        await client.query('ROLLBACK');
        return { success: false, message: consumeGemRes.message };
      }
    }

    await client.query(
      `UPDATE item_instance SET socketed_gems = $1::jsonb, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3`,
      [toSocketedGemsJson(nextEntries), itemInstanceId, characterId]
    );

    const applyDiffRes = await applyEquipmentDiffIfEquippedTx(
      client,
      characterId,
      itemInstanceId,
      equip.location,
      beforeDiffRes.before
    );
    if (!applyDiffRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: applyDiffRes.message };
    }

    const character = await getCharacterSnapshotTx(client, characterId, userId);

    await client.query('COMMIT');
    return {
      success: true,
      message: replacedGem ? '替换镶嵌成功' : '镶嵌成功',
      data: {
        socketedGems: nextEntries,
        socketMax: equip.socketMax,
        slot,
        gem: {
          itemDefId: gem.itemDefId,
          name: gem.name,
          icon: gem.icon,
          gemType: gem.gemType,
        },
        replacedGem: replacedGem ?? undefined,
        costs: { silver: silverCost },
        character: character ?? null,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('镶嵌宝石失败:', error);
    return { success: false, message: '镶嵌宝石失败' };
  } finally {
    client.release();
  }
};

// ============================================
// 扩容背包
// ============================================
export const expandInventoryWithClient = async (
  client: PoolClient,
  characterId: number,
  location: SlottedInventoryLocation,
  expandSize: number = 10
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  const validExpandSize = Number.isInteger(expandSize) ? expandSize : Math.floor(Number(expandSize));
  if (!Number.isInteger(validExpandSize) || validExpandSize <= 0) {
    return { success: false, message: 'expandSize参数错误' };
  }

  const column = location === 'bag' ? 'bag_capacity' : 'warehouse_capacity';
  const countColumn = location === 'bag' ? 'bag_expand_count' : 'warehouse_expand_count';

  const infoResult = await client.query(
    `
      SELECT bag_capacity, warehouse_capacity
      FROM inventory
      WHERE character_id = $1
      FOR UPDATE
    `,
    [characterId]
  );

  if (infoResult.rows.length === 0) {
    return { success: false, message: '背包不存在' };
  }

  const currentBagCapacity = Number(infoResult.rows[0]?.bag_capacity) || 0;
  const currentWarehouseCapacity = Number(infoResult.rows[0]?.warehouse_capacity) || 0;
  const currentCapacity = location === 'bag' ? currentBagCapacity : currentWarehouseCapacity;
  const nextCapacity = currentCapacity + validExpandSize;

  if (location === 'bag') {
    if (currentCapacity >= BAG_CAPACITY_MAX) {
      return { success: false, message: `背包容量已达上限（${BAG_CAPACITY_MAX}格）` };
    }
    if (nextCapacity > BAG_CAPACITY_MAX) {
      return { success: false, message: `扩容后超过上限（${BAG_CAPACITY_MAX}格）` };
    }
  }

  const result = await client.query(
    `
      UPDATE inventory
      SET ${column} = ${column} + $1,
          ${countColumn} = ${countColumn} + 1,
          updated_at = NOW()
      WHERE character_id = $2
      RETURNING ${column} as new_capacity
    `,
    [validExpandSize, characterId]
  );

  if (result.rows.length === 0) {
    return { success: false, message: '背包不存在' };
  }

  return {
    success: true,
    message: '扩容成功',
    newCapacity: Number(result.rows[0].new_capacity) || nextCapacity,
  };
};

export const expandInventory = async (
  characterId: number,
  location: SlottedInventoryLocation,
  expandSize: number = 10
): Promise<{ success: boolean; message: string; newCapacity?: number }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const result = await expandInventoryWithClient(client, characterId, location, expandSize);
    if (!result.success) {
      await client.query('ROLLBACK');
      return result;
    }

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('扩容背包失败:', error);
    return { success: false, message: '扩容背包失败' };
  } finally {
    client.release();
  }
};

// ============================================
const hasLearnTechniqueEffect = (effectDefs: unknown): boolean => {
  if (!Array.isArray(effectDefs)) return false;
  return effectDefs.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const row = raw as { effect_type?: unknown };
    return String(row.effect_type || '') === 'learn_technique';
  });
};

const isTechniqueBookItem = (item: { subCategory: string | null; effectDefs: unknown }): boolean => {
  const subCategory = String(item.subCategory || '').trim();
  if (subCategory === 'technique_book') return true;
  return hasLearnTechniqueEffect(item.effectDefs);
};

export const disassembleEquipment = async (
  characterId: number,
  userId: number,
  itemInstanceId: number
): Promise<{
  success: boolean;
  message: string;
  rewards?: { itemDefId: string; qty: number; itemIds?: number[] };
}> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.qty,
          ii.location,
          ii.locked,
          id.category,
          id.sub_category,
          id.effect_defs,
          COALESCE(ii.quality, id.quality) as quality
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.id = $1 AND ii.owner_character_id = $2
        FOR UPDATE
      `,
      [itemInstanceId, characterId]
    );

    if (itemResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品不存在' };
    }

    const item = itemResult.rows[0] as {
      id: number;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      category: string;
      sub_category: string | null;
      effect_defs: unknown;
      quality: string;
    };

    if (item.locked) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品已锁定' };
    }

    const isTechniqueBook = isTechniqueBookItem({
      subCategory: item.sub_category,
      effectDefs: item.effect_defs,
    });
    const isEquipment = item.category === 'equipment';

    if (!isEquipment && !isTechniqueBook) {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品不可分解' };
    }

    if (item.location === 'equipped') {
      if (!isEquipment) {
        await client.query('ROLLBACK');
        return { success: false, message: '该物品当前位置不可分解' };
      }
      await client.query('ROLLBACK');
      return { success: false, message: '穿戴中的装备不可分解' };
    }

    if (item.location !== 'bag' && item.location !== 'warehouse') {
      await client.query('ROLLBACK');
      return { success: false, message: '该物品当前位置不可分解' };
    }

    const rowQty = Math.max(0, Number(item.qty) || 0);
    if (isEquipment && rowQty !== 1) {
      await client.query('ROLLBACK');
      return { success: false, message: '装备数量异常' };
    }
    if (!isEquipment && rowQty < 1) {
      await client.query('ROLLBACK');
      return { success: false, message: '物品数量异常' };
    }

    let rewardItemDefId: string | null = null;
    let rewardQty = 0;
    if (isEquipment) {
      rewardItemDefId = resolveDisassembleRewardItemDefIdByQuality(item.quality);
      rewardQty = 1;
      if (!rewardItemDefId) {
        await client.query('ROLLBACK');
        return { success: false, message: '装备品质异常' };
      }
    } else {
      const reward = resolveTechniqueBookDisassembleRewardByQuality(item.quality);
      if (!reward) {
        await client.query('ROLLBACK');
        return { success: false, message: '功法书品质异常' };
      }
      rewardItemDefId = reward.itemDefId;
      rewardQty = reward.qty;
    }
    if (!rewardItemDefId || rewardQty <= 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '分解奖励配置异常' };
    }

    const consumeRes = await consumeSpecificItemInstanceTx(client, characterId, itemInstanceId, 1);
    if (!consumeRes.success) {
      await client.query('ROLLBACK');
      return { success: false, message: consumeRes.message };
    }

    const addResult = await addItemToInventoryTx(client, characterId, userId, rewardItemDefId, rewardQty, {
      location: 'bag',
      obtainedFrom: 'disassemble',
    });

    if (!addResult.success) {
      await client.query('ROLLBACK');
      return addResult as { success: false; message: string };
    }

    await client.query('COMMIT');
    return {
      success: true,
      message: '分解成功',
      rewards: { itemDefId: rewardItemDefId, qty: rewardQty, itemIds: addResult.itemIds },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('分解物品失败:', error);
    return { success: false, message: '分解失败' };
  } finally {
    client.release();
  }
};

export const disassembleEquipmentBatch = async (
  characterId: number,
  userId: number,
  itemInstanceIds: number[]
): Promise<{
  success: boolean;
  message: string;
  disassembledCount?: number;
  rewards?: Array<{ itemDefId: string; qty: number; itemIds?: number[] }>;
}> => {
  if (!Array.isArray(itemInstanceIds) || itemInstanceIds.length === 0) {
    return { success: false, message: 'itemIds参数错误' };
  }

  const uniqueIds = [...new Set(itemInstanceIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) {
    return { success: false, message: 'itemIds参数错误' };
  }
  if (uniqueIds.length > 200) {
    return { success: false, message: '一次最多分解200件装备' };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.qty,
          ii.location,
          ii.locked,
          id.category,
          COALESCE(ii.quality, id.quality) as quality
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.owner_character_id = $1 AND ii.id = ANY($2)
        FOR UPDATE
      `,
      [characterId, uniqueIds]
    );

    if (itemResult.rows.length !== uniqueIds.length) {
      await client.query('ROLLBACK');
      return { success: false, message: '包含不存在的物品' };
    }

    const idsToDisassemble: number[] = [];
    let skippedEquippedCount = 0;
    let cuiLingCount = 0;
    let yunLingCount = 0;

    for (const row of itemResult.rows as Array<{
      id: number;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      category: string;
      quality: string;
    }>) {
      if (row.locked) {
        await client.query('ROLLBACK');
        return { success: false, message: '包含已锁定的物品' };
      }
      if (row.category !== 'equipment') {
        await client.query('ROLLBACK');
        return { success: false, message: '包含不可分解的物品' };
      }
      if (row.location === 'equipped') {
        skippedEquippedCount += 1;
        continue;
      }
      if (row.location !== 'bag' && row.location !== 'warehouse') {
        await client.query('ROLLBACK');
        return { success: false, message: '包含不可分解位置的物品' };
      }
      if (Number(row.qty) !== 1) {
        await client.query('ROLLBACK');
        return { success: false, message: '包含数量异常的装备' };
      }

      const rewardItemDefId = resolveDisassembleRewardItemDefIdByQuality(row.quality);
      if (rewardItemDefId === 'enhance-001') {
        cuiLingCount += 1;
      } else if (rewardItemDefId === 'enhance-002') {
        yunLingCount += 1;
      } else {
        await client.query('ROLLBACK');
        return { success: false, message: '包含品质异常的装备' };
      }

      idsToDisassemble.push(row.id);
    }

    if (idsToDisassemble.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '没有可分解的装备' };
    }

    await client.query('DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)', [
      characterId,
      idsToDisassemble,
    ]);

    const rewards: Array<{ itemDefId: string; qty: number; itemIds?: number[] }> = [];

    if (cuiLingCount > 0) {
      const addRes = await addItemToInventoryTx(client, characterId, userId, 'enhance-001', cuiLingCount, {
        location: 'bag',
        obtainedFrom: 'disassemble',
      });
      if (!addRes.success) {
        await client.query('ROLLBACK');
        return addRes as { success: false; message: string };
      }
      rewards.push({ itemDefId: 'enhance-001', qty: cuiLingCount, itemIds: addRes.itemIds });
    }

    if (yunLingCount > 0) {
      const addRes = await addItemToInventoryTx(client, characterId, userId, 'enhance-002', yunLingCount, {
        location: 'bag',
        obtainedFrom: 'disassemble',
      });
      if (!addRes.success) {
        await client.query('ROLLBACK');
        return addRes as { success: false; message: string };
      }
      rewards.push({ itemDefId: 'enhance-002', qty: yunLingCount, itemIds: addRes.itemIds });
    }

    await client.query('COMMIT');
    const msg = skippedEquippedCount > 0 ? `分解成功（已跳过已穿戴装备×${skippedEquippedCount}）` : '分解成功';
    return { success: true, message: msg, disassembledCount: idsToDisassemble.length, rewards };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('批量分解装备失败:', error);
    return { success: false, message: '分解装备失败' };
  } finally {
    client.release();
  }
};

export const removeItemsBatch = async (
  characterId: number,
  itemInstanceIds: number[]
): Promise<{
  success: boolean;
  message: string;
  removedCount?: number;
  removedQtyTotal?: number;
}> => {
  if (!Array.isArray(itemInstanceIds) || itemInstanceIds.length === 0) {
    return { success: false, message: 'itemIds参数错误' };
  }

  const uniqueIds = [...new Set(itemInstanceIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
  if (uniqueIds.length === 0) {
    return { success: false, message: 'itemIds参数错误' };
  }
  if (uniqueIds.length > 200) {
    return { success: false, message: '一次最多丢弃200个物品' };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const itemResult = await client.query(
      `
        SELECT
          ii.id,
          ii.qty,
          ii.location,
          ii.locked,
          id.destroyable
        FROM item_instance ii
        JOIN item_def id ON id.id = ii.item_def_id
        WHERE ii.owner_character_id = $1 AND ii.id = ANY($2)
        FOR UPDATE
      `,
      [characterId, uniqueIds]
    );

    if (itemResult.rows.length !== uniqueIds.length) {
      await client.query('ROLLBACK');
      return { success: false, message: '包含不存在的物品' };
    }

    let removedQtyTotal = 0;
    for (const row of itemResult.rows as Array<{
      id: number;
      qty: number;
      location: InventoryLocation;
      locked: boolean;
      destroyable: boolean;
    }>) {
      if (row.locked) {
        await client.query('ROLLBACK');
        return { success: false, message: '包含已锁定的物品' };
      }
      if (row.location === 'equipped') {
        await client.query('ROLLBACK');
        return { success: false, message: '包含穿戴中的物品' };
      }
      if (row.location !== 'bag' && row.location !== 'warehouse') {
        await client.query('ROLLBACK');
        return { success: false, message: '包含不可丢弃位置的物品' };
      }
      if (!row.destroyable) {
        await client.query('ROLLBACK');
        return { success: false, message: '包含不可丢弃的物品' };
      }
      removedQtyTotal += Math.max(0, Number(row.qty) || 0);
    }

    await client.query('DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)', [
      characterId,
      uniqueIds,
    ]);

    await client.query('COMMIT');
    return { success: true, message: '丢弃成功', removedCount: uniqueIds.length, removedQtyTotal };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('批量丢弃物品失败:', error);
    return { success: false, message: '丢弃物品失败' };
  } finally {
    client.release();
  }
};

// 整理背包（重新排列物品）
// ============================================
export const sortInventory = async (
  characterId: number,
  location: SlottedInventoryLocation = 'bag'
): Promise<{ success: boolean; message: string }> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockCharacterInventoryMutexTx(client, characterId);

    const info = await getInventoryInfoWithClient(characterId, client);
    const capacity = getSlottedCapacity(info, location);

    // 分两步更新：先写入不冲突的临时槽位，再写回最终槽位，避免唯一索引冲突
    await client.query(
      `
        WITH ordered AS (
          SELECT
            ii.id,
            ROW_NUMBER() OVER (
              ORDER BY
                id.category NULLS LAST,
                COALESCE(ii.quality_rank, id.quality_rank, 0) DESC,
                id.sub_category NULLS LAST,
                ii.item_def_id,
                ii.qty DESC,
                ii.id
            ) - 1 AS new_slot
          FROM item_instance ii
          LEFT JOIN item_def id ON ii.item_def_id = id.id
          WHERE ii.owner_character_id = $1 AND ii.location = $2
        )
        UPDATE item_instance ii
        SET location_slot = CASE
              WHEN ordered.new_slot < $3 THEN -1 - ordered.new_slot
              ELSE NULL
            END,
            updated_at = NOW()
        FROM ordered
        WHERE ii.id = ordered.id
        RETURNING ii.id
      `,
      [characterId, location, capacity]
    );

    await client.query(
      `
        WITH ordered AS (
          SELECT
            ii.id,
            ROW_NUMBER() OVER (
              ORDER BY
                id.category NULLS LAST,
                COALESCE(ii.quality_rank, id.quality_rank, 0) DESC,
                id.sub_category NULLS LAST,
                ii.item_def_id,
                ii.qty DESC,
                ii.id
            ) - 1 AS new_slot
          FROM item_instance ii
          LEFT JOIN item_def id ON ii.item_def_id = id.id
          WHERE ii.owner_character_id = $1 AND ii.location = $2
        )
        UPDATE item_instance ii
        SET location_slot = CASE
              WHEN ordered.new_slot < $3 THEN ordered.new_slot
              ELSE NULL
            END,
            updated_at = NOW()
        FROM ordered
        WHERE ii.id = ordered.id
        RETURNING ii.id
      `,
      [characterId, location, capacity]
    );

    await client.query('COMMIT');
    return { success: true, message: '整理完成' };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('整理背包失败:', error);
    return { success: false, message: '整理背包失败' };
  } finally {
    client.release();
  }
};

export default {
  getInventoryInfo,
  getInventoryItems,
  findEmptySlots,
  addItemToInventory,
  removeItemFromInventory,
  moveItem,
  equipItem,
  unequipItem,
  enhanceEquipment,
  refineEquipment,
  socketEquipment,
  disassembleEquipment,
  disassembleEquipmentBatch,
  removeItemsBatch,
  expandInventory,
  sortInventory
};
