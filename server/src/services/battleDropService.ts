/**
 * 九州修仙录 - 战斗掉落服务
 * 
 * 功能：
 * 1. 从掉落池计算掉落物品
 * 2. 分发经验、银两给玩家（组队平分）
 * 3. 分发物品、装备给玩家（组队随机分配）
 * 4. 装备通过装备生成模块生成
 */
import { query, pool } from '../config/database.js';
import { createItem, CreateItemOptions } from './itemService.js';
import { sendSystemMail, type MailAttachItem } from './mailService.js';
import { recordCollectItemEvent } from './taskService.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
} from './autoDisassembleRewardService.js';
import { normalizeAutoDisassembleSetting } from './autoDisassembleRules.js';
import type { MonsterData } from '../battle/BattleFactory.js';
import { getItemDefinitionById, getMonsterDefinitions } from './staticConfigLoader.js';
import { resolveDropPoolById } from './dropPoolResolver.js';
import {
  getAdjustedChance,
  getAdjustedWeight,
  normalizeMonsterKind,
  type MonsterKind,
} from './shared/dropRateMultiplier.js';

// ============================================
// 类型定义
// ============================================

// 掉落池模式
type DropPoolMode = 'prob' | 'weight';

// 掉落池条目
interface DropPoolEntry {
  id: number;
  item_def_id: string;
  chance: number;        // 概率模式下的掉落概率 (0-1)
  weight: number;        // 权重模式下的权重
  qty_min: number;
  qty_max: number;
  quality_weights: Record<string, number> | null;  // 装备品质权重
  bind_type: string;
  sourceType: 'common' | 'exclusive';
  sourcePoolId: string;
}

// 掉落池
interface DropPool {
  id: string;
  name: string;
  mode: DropPoolMode;
  entries: DropPoolEntry[];
}

type RollDropsOptions = {
  isDungeonBattle?: boolean;
  monsterKind?: MonsterKind;
};

type DistributeBattleRewardsOptions = {
  isDungeonBattle?: boolean;
};

// 掉落结果
export interface DropResult {
  itemDefId: string;
  quantity: number;
  qualityWeights?: Record<string, number>;
  bindType: string;
}

// 分发结果
export interface DistributeResult {
  success: boolean;
  message: string;
  rewards: {
    exp: number;
    silver: number;
    items: Array<{
      itemDefId: string;
      itemName: string;
      quantity: number;
      instanceIds: number[];
      receiverId: number;  // 接收者角色ID
    }>;
  };
  perPlayerRewards?: Array<{
    characterId: number;
    userId: number;
    exp: number;
    silver: number;
    items: Array<{
      itemDefId: string;
      itemName: string;
      quantity: number;
      instanceIds: number[];
    }>;
  }>;
}

// 参与者信息
export interface BattleParticipant {
  userId: number;
  characterId: number;
  nickname: string;
  fuyuan?: number;
}

// ============================================
// 掉落池查询
// ============================================

/**
 * 获取掉落池及其条目
 */
export const getDropPool = async (poolId: string): Promise<DropPool | null> => {
  const resolvedPool = resolveDropPoolById(poolId);
  if (!resolvedPool) return null;
  return {
    id: resolvedPool.id,
    name: resolvedPool.name,
    mode: resolvedPool.mode,
    entries: resolvedPool.entries.map((entry, idx) => ({
      id: idx + 1,
      item_def_id: entry.item_def_id,
      chance: entry.chance,
      weight: entry.weight,
      qty_min: entry.qty_min,
      qty_max: entry.qty_max,
      quality_weights: entry.quality_weights,
      bind_type: entry.bind_type,
      sourceType: entry.sourceType,
      sourcePoolId: entry.sourcePoolId,
    })),
  };
};

// ============================================
// 掉落计算
// ============================================

/**
 * 从掉落池计算掉落物品
 */
export const rollDrops = (
  dropPool: DropPool,
  fuyuan: number = 0,
  options: RollDropsOptions = {}
): DropResult[] => {
  const results: DropResult[] = [];
  const cappedFuyuan = Math.min(200, Math.max(0, Number(fuyuan ?? 0)));
  const chanceMultiplier = 1 + cappedFuyuan * 0.0025;
  const isDungeonBattle = options.isDungeonBattle === true;
  const monsterKind = normalizeMonsterKind(options.monsterKind);
  
  if (dropPool.mode === 'prob') {
    // 概率模式：每个条目独立判定
    for (const entry of dropPool.entries) {
      const effectiveChance = getAdjustedChance(entry.chance * chanceMultiplier, entry.sourceType, entry.sourcePoolId, {
        isDungeonBattle,
        monsterKind,
      });
      if (Math.random() < effectiveChance) {
        const quantity = randomInt(entry.qty_min, entry.qty_max);
        results.push({
          itemDefId: entry.item_def_id,
          quantity,
          qualityWeights: entry.quality_weights || undefined,
          bindType: entry.bind_type,
        });
      }
    }
  } else if (dropPool.mode === 'weight') {
    // 权重模式：按权重随机选择一个
    const totalWeight = dropPool.entries.reduce((sum, entry) => {
      return sum + getAdjustedWeight(entry.weight, entry.sourceType, entry.sourcePoolId, {
        isDungeonBattle,
        monsterKind,
      });
    }, 0);
    if (totalWeight > 0) {
      let roll = Math.random() * totalWeight;
      for (const entry of dropPool.entries) {
        roll -= getAdjustedWeight(entry.weight, entry.sourceType, entry.sourcePoolId, {
          isDungeonBattle,
          monsterKind,
        });
        if (roll <= 0) {
          const quantity = randomInt(entry.qty_min, entry.qty_max);
          results.push({
            itemDefId: entry.item_def_id,
            quantity,
            qualityWeights: entry.quality_weights || undefined,
            bindType: entry.bind_type,
          });
          break;
        }
      }
    }
  }
  
  return results;
};

/**
 * 从多个怪物计算所有掉落
 */
export const calculateAllDrops = async (monsters: MonsterData[]): Promise<DropResult[]> => {
  const allDrops: DropResult[] = [];
  
  for (const monster of monsters) {
    if (!monster.drop_pool_id) continue;
    
    const dropPool = await getDropPool(monster.drop_pool_id);
    if (!dropPool) continue;
    
    const monsterKind = normalizeMonsterKind(monster.kind);
    const drops = rollDrops(dropPool, 0, { monsterKind });
    allDrops.push(...drops);
  }
  
  // 合并相同物品
  return mergeDrops(allDrops);
};

/**
 * 合并相同物品的掉落
 */
const mergeDrops = (drops: DropResult[]): DropResult[] => {
  const merged = new Map<string, DropResult>();
  
  for (const drop of drops) {
    const qualityWeightsKey = drop.qualityWeights
      ? JSON.stringify(
          Object.keys(drop.qualityWeights)
            .sort()
            .reduce<Record<string, number>>((acc, k) => {
              acc[k] = drop.qualityWeights![k]!;
              return acc;
            }, {})
        )
      : '';
    const key = `${drop.itemDefId}-${drop.bindType}-${qualityWeightsKey}`;
    const existing = merged.get(key);
    
    if (existing) {
      existing.quantity += drop.quantity;
    } else {
      merged.set(key, { ...drop });
    }
  }
  
  return Array.from(merged.values());
};

// ============================================
// 奖励分发
// ============================================

/**
 * 分发战斗奖励（经验、银两、物品）
 * 
 * @param monsters 击杀的怪物列表
 * @param participants 参与战斗的玩家列表
 * @param isVictory 是否胜利
 */
export const distributeBattleRewards = async (
  monsters: MonsterData[],
  participants: BattleParticipant[],
  isVictory: boolean,
  options: DistributeBattleRewardsOptions = {}
): Promise<DistributeResult> => {
  if (!isVictory || participants.length === 0) {
    return {
      success: true,
      message: '战斗失败，无奖励',
      rewards: { exp: 0, silver: 0, items: [] },
    };
  }
  
  const client = await pool.connect();
  const pendingMailByReceiver = new Map<number, { userId: number; items: MailAttachItem[] }>();
  const collectCounts = new Map<string, { characterId: number; itemDefId: string; qty: number }>();
  
  try {
    await client.query('BEGIN');

    const participantCharacterIds = [...new Set(
      participants
        .map((p) => Number(p.characterId))
        .filter((id) => Number.isInteger(id) && id > 0)
    )].sort((a, b) => a - b);
    if (participantCharacterIds.length > 0) {
      // 统一角色行锁顺序，避免与其他事务在 characters/item_instance 间出现锁顺序反转。
      await client.query(
        `
          SELECT id
          FROM characters
          WHERE id = ANY($1)
          ORDER BY id
          FOR UPDATE
        `,
        [participantCharacterIds]
      );
    }
    
    // 1. 计算总经验和银两
    let totalExp = 0;
    let totalSilver = 0;
    
    for (const monster of monsters) {
      totalExp += monster.exp_reward || 0;
      const silverMin = monster.silver_reward_min || 0;
      const silverMax = monster.silver_reward_max || 0;
      totalSilver += randomInt(silverMin, silverMax);
    }
    
    const stableQualityWeightsKey = (weights?: Record<string, number>): string => {
      if (!weights) return '';
      return JSON.stringify(
        Object.keys(weights)
          .sort()
          .reduce<Record<string, number>>((acc, k) => {
            acc[k] = weights[k]!;
            return acc;
          }, {})
      );
    };

    const participantCount = participants.length;
    const isDungeonBattle = options.isDungeonBattle === true;
    const mergedDropsByReceiver = new Map<
      string,
      { receiver: BattleParticipant; drop: DropResult; receiverFuyuan: number }
    >();

    for (const monster of monsters) {
      if (!monster.drop_pool_id) continue;

      const dropPool = await getDropPool(monster.drop_pool_id);
      if (!dropPool) continue;

      const receiverIndex = participantCount > 1 ? Math.floor(Math.random() * participantCount) : 0;
      const receiver = participants[receiverIndex];
      const receiverFuyuan = Number(receiver.fuyuan ?? 1);

      const drops = rollDrops(dropPool, receiverFuyuan, {
        isDungeonBattle,
        monsterKind: normalizeMonsterKind(monster.kind),
      });
      for (const drop of drops) {
        const key = `${receiver.characterId}|${drop.itemDefId}|${drop.bindType}|${stableQualityWeightsKey(drop.qualityWeights)}`;
        const existing = mergedDropsByReceiver.get(key);
        if (existing) {
          existing.drop.quantity += drop.quantity;
        } else {
          mergedDropsByReceiver.set(key, { receiver, drop: { ...drop }, receiverFuyuan });
        }
      }
    }
    
    // 3. 分发经验和银两（平分）
    const expPerPlayer = Math.floor(totalExp / participantCount);
    const silverPerPlayer = Math.floor(totalSilver / participantCount);
    
    const perPlayerRewards: DistributeResult['perPlayerRewards'] = [];
    
    for (const participant of participants) {
      // 更新角色经验和银两
      await client.query(`
        UPDATE characters 
        SET exp = exp + $1, silver = silver + $2, updated_at = NOW()
        WHERE id = $3
      `, [expPerPlayer, silverPerPlayer, participant.characterId]);
      
      perPlayerRewards.push({
        characterId: participant.characterId,
        userId: participant.userId,
        exp: expPerPlayer,
        silver: silverPerPlayer,
        items: [],
      });
    }
    
    // 4. 分发物品（组队随机分配，单人全部获得）
    const allItems: DistributeResult['rewards']['items'] = [];
    const itemMetaCache = new Map<
      string,
      {
        name: string;
        category: string;
        subCategory: string | null;
        effectDefs: unknown;
        level: number;
        qualityRank: number;
      }
    >();
    const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();

    if (participantCharacterIds.length > 0) {
      const settingResult = await client.query(
        `
          SELECT id, auto_disassemble_enabled, auto_disassemble_max_quality_rank, auto_disassemble_rules
          FROM characters
          WHERE id = ANY($1)
        `,
        [participantCharacterIds]
      );
      for (const row of settingResult.rows as Array<{
        id: number;
        auto_disassemble_enabled: boolean | null;
        auto_disassemble_max_quality_rank: number | null;
        auto_disassemble_rules: unknown;
      }>) {
        autoDisassembleSettings.set(
          Number(row.id),
          normalizeAutoDisassembleSetting({
            enabled: row.auto_disassemble_enabled,
            maxQualityRank: row.auto_disassemble_max_quality_rank,
            rules: row.auto_disassemble_rules,
          })
        );
      }
    }

    const appendCollectCount = (characterId: number, itemDefId: string, qty: number) => {
      const key = `${characterId}|${itemDefId}`;
      const existing = collectCounts.get(key);
      if (existing) {
        existing.qty += qty;
      } else {
        collectCounts.set(key, { characterId, itemDefId, qty });
      }
    };

    const appendRewardRecord = (
      characterId: number,
      itemDefId: string,
      itemName: string,
      quantity: number,
      instanceIds: number[]
    ) => {
      allItems.push({ itemDefId, itemName, quantity, instanceIds, receiverId: characterId });
      const playerReward = perPlayerRewards.find((p) => p.characterId === characterId);
      if (playerReward) {
        playerReward.items.push({ itemDefId, itemName, quantity, instanceIds });
      }
    };

    const queuePendingMailItem = (
      receiver: BattleParticipant,
      receiverCharacterId: number,
      attachItem: MailAttachItem
    ) => {
      const existing = pendingMailByReceiver.get(receiverCharacterId) || {
        userId: receiver.userId,
        items: [],
      };
      const keyA = JSON.stringify(attachItem.options?.equipOptions || null);
      const found = existing.items.find((x) => {
        const keyB = JSON.stringify(x.options?.equipOptions || null);
        return (
          x.item_def_id === attachItem.item_def_id &&
          (x.options?.bindType || 'none') === (attachItem.options?.bindType || 'none') &&
          keyB === keyA
        );
      });
      if (found) {
        found.qty += attachItem.qty;
      } else {
        existing.items.push(attachItem);
      }
      pendingMailByReceiver.set(receiverCharacterId, existing);
    };

    const getItemMeta = async (itemDefId: string): Promise<{
      name: string;
      category: string;
      subCategory: string | null;
      effectDefs: unknown;
      level: number;
      qualityRank: number;
    }> => {
      const cached = itemMetaCache.get(itemDefId);
      if (cached) return cached;
      const def = getItemDefinitionById(itemDefId);
      const meta = {
        name: def?.name || itemDefId,
        category: def?.category || 'misc',
        subCategory: def?.sub_category ?? null,
        effectDefs: def?.effect_defs ?? null,
        level: Math.max(0, Math.floor(Number(def?.level) || 0)),
        qualityRank: Math.max(1, Math.floor(Number(def?.quality_rank) || 1)),
      };
      itemMetaCache.set(itemDefId, meta);
      return meta;
    };

    for (const entry of mergedDropsByReceiver.values()) {
      const drop = entry.drop;
      const receiver = entry.receiver;
      const receiverCharacterId = Number(receiver.characterId);
      if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) {
        console.warn(`奖励分发跳过：非法角色ID ${String(receiver.characterId)}`);
        continue;
      }

      const sourceMeta = await getItemMeta(drop.itemDefId);
      const createOptions: CreateItemOptions = {
        location: 'bag',
        bindType: drop.bindType,
        obtainedFrom: 'battle_drop',
        dbClient: client,
      };
      if (sourceMeta.category === 'equipment') {
        createOptions.equipOptions = {
          fuyuan: entry.receiverFuyuan,
          ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights as Record<string, number> } : {}),
        };
      }

      const receiverAutoDisassemble =
        autoDisassembleSettings.get(receiverCharacterId) ||
        normalizeAutoDisassembleSetting({ enabled: false, maxQualityRank: 1, rules: undefined });

      const grantResult = await grantRewardItemWithAutoDisassemble({
        characterId: receiverCharacterId,
        itemDefId: drop.itemDefId,
        qty: drop.quantity,
        bindType: drop.bindType,
        itemMeta: {
          itemName: sourceMeta.name,
          category: sourceMeta.category,
          subCategory: sourceMeta.subCategory,
          effectDefs: sourceMeta.effectDefs,
          level: sourceMeta.level,
          qualityRank: sourceMeta.qualityRank,
        },
        autoDisassembleSetting: receiverAutoDisassemble,
        sourceObtainedFrom: 'battle_drop',
        sourceEquipOptions: createOptions.equipOptions,
        createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
          return createItem(receiver.userId, receiverCharacterId, itemDefId, qty, {
            location: 'bag',
            obtainedFrom,
            ...(bindType ? { bindType } : {}),
            ...(equipOptions ? { equipOptions } : {}),
            dbClient: client,
          });
        },
        addSilver: async (ownerCharacterId, silverGain) => {
          const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
          if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
          const updateResult = await client.query(
            `
              UPDATE characters
              SET silver = silver + $1,
                  updated_at = NOW()
              WHERE id = $2
            `,
            [safeSilver, ownerCharacterId]
          );
          if (updateResult.rowCount === 0) return { success: false, message: '角色不存在' };
          return { success: true, message: '银两增加成功' };
        },
      });

      for (const warning of grantResult.warnings) {
        console.warn(`战斗掉落自动分解失败: ${warning}`);
      }

      for (const mailItem of grantResult.pendingMailItems) {
        queuePendingMailItem(receiver, receiverCharacterId, mailItem);
      }

      if (grantResult.gainedSilver > 0) {
        totalSilver += grantResult.gainedSilver;
        const playerReward = perPlayerRewards.find((p) => p.characterId === receiverCharacterId);
        if (playerReward) {
          playerReward.silver += grantResult.gainedSilver;
        }
      }

      for (const granted of grantResult.grantedItems) {
        const grantedMeta =
          granted.itemDefId === drop.itemDefId ? sourceMeta : await getItemMeta(granted.itemDefId);
        appendCollectCount(receiverCharacterId, granted.itemDefId, granted.qty);
        appendRewardRecord(receiverCharacterId, granted.itemDefId, grantedMeta.name, granted.qty, granted.itemIds);
      }
    }
    
    await client.query('COMMIT');

    for (const entry of collectCounts.values()) {
      try {
        await recordCollectItemEvent(entry.characterId, entry.itemDefId, entry.qty);
      } catch {}
    }

    for (const [receiverCharacterId, entry] of pendingMailByReceiver.entries()) {
      const items = entry.items;
      const chunkSize = 10;
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        try {
          const mailResult = await sendSystemMail(
            entry.userId,
            receiverCharacterId,
            '战斗掉落补发',
            '由于背包已满，部分战斗掉落已通过邮件补发，请前往邮箱领取。',
            { items: chunk },
            30
          );
          if (!mailResult.success) {
            console.warn(`战斗掉落补发邮件发送失败: ${mailResult.message}`);
          }
        } catch (error) {
          console.warn('战斗掉落补发邮件发送异常:', error);
        }
      }
    }
    
    return {
      success: true,
      message: '奖励分发成功',
      rewards: {
        exp: totalExp,
        silver: totalSilver,
        items: allItems,
      },
      perPlayerRewards,
    };
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('分发战斗奖励失败:', error);
    return {
      success: false,
      message: '奖励分发失败',
      rewards: { exp: 0, silver: 0, items: [] },
    };
  } finally {
    client.release();
  }
};

/**
 * 快速分发奖励（用于自动战斗等场景）
 */
export const quickDistributeRewards = async (
  monsterIds: string[],
  participants: BattleParticipant[],
  isVictory: boolean
): Promise<DistributeResult> => {
  if (!isVictory || participants.length === 0 || monsterIds.length === 0) {
    return {
      success: true,
      message: '无奖励',
      rewards: { exp: 0, silver: 0, items: [] },
    };
  }
  
  // 获取怪物数据
  const idSet = new Set(monsterIds);
  const monsters = getMonsterDefinitions()
    .filter((entry) => entry.enabled !== false)
    .filter((entry) => idSet.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      exp_reward: Number(entry.exp_reward ?? 0),
      silver_reward_min: Number(entry.silver_reward_min ?? 0),
      silver_reward_max: Number(entry.silver_reward_max ?? 0),
      drop_pool_id: entry.drop_pool_id ?? null,
    })) as MonsterData[];
  
  return distributeBattleRewards(monsters, participants, isVictory);
};

// ============================================
// 工具函数
// ============================================

/**
 * 生成范围内的随机整数
 */
const randomInt = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * 获取物品定义信息
 */
export const getItemDefInfo = async (itemDefId: string): Promise<{
  name: string;
  category: string;
  quality: string;
  icon: string;
} | null> => {
  const def = getItemDefinitionById(itemDefId);
  if (!def) return null;
  return {
    name: String(def.name || itemDefId),
    category: String(def.category || ''),
    quality: String(def.quality || ''),
    icon: String(def.icon || ''),
  };
};
