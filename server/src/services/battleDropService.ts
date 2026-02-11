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
  clampQualityRank,
  resolveDisassembleRewardItemDefIdByQualityRank,
  resolveQualityRank,
} from './equipmentDisassembleRules.js';
import type { MonsterData } from '../battle/BattleFactory.js';

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
}

// 掉落池
interface DropPool {
  id: string;
  name: string;
  mode: DropPoolMode;
  entries: DropPoolEntry[];
}

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

interface AutoDisassembleSetting {
  enabled: boolean;
  maxQualityRank: number;
}

// ============================================
// 掉落池查询
// ============================================

/**
 * 获取掉落池及其条目
 */
export const getDropPool = async (poolId: string): Promise<DropPool | null> => {
  // 获取掉落池基本信息
  const poolResult = await query(
    `SELECT id, name, mode FROM drop_pool WHERE id = $1 AND enabled = true`,
    [poolId]
  );
  
  if (poolResult.rows.length === 0) return null;
  
  const poolRow = poolResult.rows[0];
  
  // 获取掉落池条目
  const entriesResult = await query(
    `SELECT id, item_def_id, chance, weight, qty_min, qty_max, quality_weights, bind_type
     FROM drop_pool_entry
     WHERE drop_pool_id = $1
     ORDER BY id`,
    [poolId]
  );
  
  return {
    id: poolRow.id,
    name: poolRow.name,
    mode: poolRow.mode,
    entries: entriesResult.rows.map(row => ({
      id: row.id,
      item_def_id: row.item_def_id,
      chance: parseFloat(row.chance) || 0,
      weight: parseInt(row.weight) || 0,
      qty_min: parseInt(row.qty_min) || 1,
      qty_max: parseInt(row.qty_max) || 1,
      quality_weights: row.quality_weights,
      bind_type: row.bind_type || 'none',
    })),
  };
};

// ============================================
// 掉落计算
// ============================================

/**
 * 从掉落池计算掉落物品
 */
export const rollDrops = (dropPool: DropPool, fuyuan: number = 0): DropResult[] => {
  const results: DropResult[] = [];
  const cappedFuyuan = Math.min(200, Math.max(0, Number(fuyuan ?? 0)));
  const chanceMultiplier = 1 + cappedFuyuan * 0.0025;
  
  if (dropPool.mode === 'prob') {
    // 概率模式：每个条目独立判定
    for (const entry of dropPool.entries) {
      const effectiveChance = Math.max(0, Math.min(1, entry.chance * chanceMultiplier));
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
    const totalWeight = dropPool.entries.reduce((sum, e) => sum + e.weight, 0);
    if (totalWeight > 0) {
      let roll = Math.random() * totalWeight;
      for (const entry of dropPool.entries) {
        roll -= entry.weight;
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
    
    const drops = rollDrops(dropPool);
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
  isVictory: boolean
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

      const drops = rollDrops(dropPool, receiverFuyuan);
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
    const itemMetaCache = new Map<string, { name: string; category: string }>();
    const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();

    const participantCharacterIds = [...new Set(participants.map((p) => Number(p.characterId)).filter((id) => Number.isInteger(id) && id > 0))];
    if (participantCharacterIds.length > 0) {
      const settingResult = await client.query(
        `
          SELECT id, auto_disassemble_enabled, auto_disassemble_max_quality_rank
          FROM characters
          WHERE id = ANY($1)
        `,
        [participantCharacterIds]
      );
      for (const row of settingResult.rows as Array<{
        id: number;
        auto_disassemble_enabled: boolean | null;
        auto_disassemble_max_quality_rank: number | null;
      }>) {
        autoDisassembleSettings.set(Number(row.id), {
          enabled: Boolean(row.auto_disassemble_enabled),
          maxQualityRank: clampQualityRank(row.auto_disassemble_max_quality_rank, 1),
        });
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

    const queuePendingMailItem = (receiver: BattleParticipant, attachItem: MailAttachItem) => {
      const existing = pendingMailByReceiver.get(receiver.characterId) || {
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
      pendingMailByReceiver.set(receiver.characterId, existing);
    };

    const getItemMeta = async (itemDefId: string): Promise<{ name: string; category: string }> => {
      const cached = itemMetaCache.get(itemDefId);
      if (cached) return cached;
      const result = await client.query('SELECT name, category FROM item_def WHERE id = $1', [itemDefId]);
      const meta = {
        name: result.rows[0]?.name || itemDefId,
        category: result.rows[0]?.category || 'misc',
      };
      itemMetaCache.set(itemDefId, meta);
      return meta;
    };

    for (const entry of mergedDropsByReceiver.values()) {
      const drop = entry.drop;
      const receiver = entry.receiver;
      const { name: itemName, category: itemCategory } = await getItemMeta(drop.itemDefId);

      const createOptions: CreateItemOptions = {
        location: 'bag',
        bindType: drop.bindType,
        obtainedFrom: 'battle_drop',
        dbClient: client,
      };

      if (itemCategory === 'equipment') {
        createOptions.equipOptions = {
          fuyuan: entry.receiverFuyuan,
          ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights as any } : {}),
        };
      }

      const receiverAutoDisassemble = autoDisassembleSettings.get(receiver.characterId) || {
        enabled: false,
        maxQualityRank: 1,
      };
      const shouldTryAutoDisassemble = itemCategory === 'equipment' && receiverAutoDisassemble.enabled;

      if (shouldTryAutoDisassemble) {
        for (let i = 0; i < drop.quantity; i++) {
          const createResult = await createItem(
            receiver.userId,
            receiver.characterId,
            drop.itemDefId,
            1,
            createOptions
          );

          if (!createResult.success) {
            if (createResult.message === '背包已满') {
              queuePendingMailItem(receiver, {
                item_def_id: drop.itemDefId,
                qty: 1,
                options: {
                  bindType: createOptions.bindType,
                  equipOptions: createOptions.equipOptions,
                },
              });
              appendRewardRecord(receiver.characterId, drop.itemDefId, itemName, 1, []);
            } else {
              console.warn(`物品创建失败: ${drop.itemDefId}, ${createResult.message}`);
            }
            continue;
          }

          const generatedQualityRank = (() => {
            const raw = Number(createResult.equipment?.qualityRank);
            if (Number.isInteger(raw) && raw > 0) return raw;
            return resolveQualityRank(createResult.equipment?.quality);
          })();
          const disassembleRewardItemDefId = resolveDisassembleRewardItemDefIdByQualityRank(generatedQualityRank);
          const shouldDisassembleCurrent =
            Boolean(disassembleRewardItemDefId) &&
            generatedQualityRank > 0 &&
            generatedQualityRank <= receiverAutoDisassemble.maxQualityRank;

          if (shouldDisassembleCurrent && disassembleRewardItemDefId) {
            const rewardCreateResult = await createItem(
              receiver.userId,
              receiver.characterId,
              disassembleRewardItemDefId,
              1,
              {
                location: 'bag',
                obtainedFrom: 'auto_disassemble',
                dbClient: client,
              }
            );

            if (rewardCreateResult.success || rewardCreateResult.message === '背包已满') {
              const sourceItemIds = (createResult.itemIds || []).filter((id) => Number.isInteger(id) && id > 0);
              if (sourceItemIds.length > 0) {
                await client.query(
                  'DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)',
                  [receiver.characterId, sourceItemIds]
                );
              }

              const rewardMeta = await getItemMeta(disassembleRewardItemDefId);
              if (rewardCreateResult.success) {
                appendCollectCount(receiver.characterId, disassembleRewardItemDefId, 1);
                appendRewardRecord(
                  receiver.characterId,
                  disassembleRewardItemDefId,
                  rewardMeta.name,
                  1,
                  rewardCreateResult.itemIds || []
                );
              } else {
                queuePendingMailItem(receiver, {
                  item_def_id: disassembleRewardItemDefId,
                  qty: 1,
                });
                appendRewardRecord(receiver.characterId, disassembleRewardItemDefId, rewardMeta.name, 1, []);
              }
              continue;
            }

            console.warn(`自动分解入包失败，保留原装备: ${disassembleRewardItemDefId}, ${rewardCreateResult.message}`);
          }

          appendCollectCount(receiver.characterId, drop.itemDefId, 1);
          appendRewardRecord(receiver.characterId, drop.itemDefId, itemName, 1, createResult.itemIds || []);
        }
        continue;
      }

      const createResult = await createItem(
        receiver.userId,
        receiver.characterId,
        drop.itemDefId,
        drop.quantity,
        createOptions
      );

      if (createResult.success) {
        appendCollectCount(receiver.characterId, drop.itemDefId, drop.quantity);
        appendRewardRecord(receiver.characterId, drop.itemDefId, itemName, drop.quantity, createResult.itemIds || []);
      } else if (createResult.message === '背包已满') {
        queuePendingMailItem(receiver, {
          item_def_id: drop.itemDefId,
          qty: drop.quantity,
          options: {
            bindType: createOptions.bindType,
            equipOptions: createOptions.equipOptions,
          },
        });
        appendRewardRecord(receiver.characterId, drop.itemDefId, itemName, drop.quantity, []);
      } else {
        console.warn(`物品创建失败: ${drop.itemDefId}, ${createResult.message}`);
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
  const monsterResult = await query(
    `SELECT id, name, exp_reward, silver_reward_min, silver_reward_max, drop_pool_id
     FROM monster_def WHERE id = ANY($1)`,
    [monsterIds]
  );
  
  const monsters = monsterResult.rows as MonsterData[];
  
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
  const result = await query(
    'SELECT name, category, quality, icon FROM item_def WHERE id = $1',
    [itemDefId]
  );
  return result.rows[0] || null;
};

