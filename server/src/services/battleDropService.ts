/**
 * 九州修仙录 - 战斗掉落服务
 *
 * 功能：
 * 1. 从掉落池计算掉落物品
 * 2. 分发经验、银两给玩家（组队平分）
 * 3. 分发物品、装备给玩家（组队按战利品条目独立ROLL点分配）
 * 4. 装备通过装备生成模块生成
 */
import { query, withTransactionAuto } from '../config/database.js';
import { itemService, CreateItemOptions } from './itemService.js';
import { sendSystemMail, type MailAttachItem } from './mailService.js';
import { recordCollectItemEvent } from './taskService.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
} from './autoDisassembleRewardService.js';
import { normalizeAutoDisassembleSetting } from './autoDisassembleRules.js';
import type { MonsterData } from '../battle/battleFactory.js';
import { getItemDefinitionById, getMonsterDefinitions } from './staticConfigLoader.js';
import { resolveDropPoolById } from './dropPoolResolver.js';
import {
  getAdjustedChance,
  getAdjustedQuantity,
  getAdjustedWeight,
  normalizeMonsterKind,
  type MonsterKind,
} from './shared/dropRateMultiplier.js';
import {
  applyMonsterRealmDropQtyMultiplier,
  getMonsterRealmAdjustedBaseQuantityRange,
  shouldApplyDropQuantityMultiplier,
} from './shared/dropQuantityMultiplier.js';
import {
  addCharacterRewardDelta,
  applyCharacterRewardDeltas,
  type CharacterRewardDelta,
} from './shared/characterRewardSettlement.js';
import { resolveQualityRankFromName } from './shared/itemQuality.js';
import { lockCharacterRewardSettlementTargets } from './shared/characterRewardTargetLock.js';
import { getRealmOrderIndex } from './shared/realmRules.js';
import { loadCharacterWritebackRowByCharacterId } from './playerWritebackCacheService.js';

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
  chance_add_by_monster_realm: number;
  qty_min: number;
  qty_max: number;
  qty_min_add_by_monster_realm: number;
  qty_max_add_by_monster_realm: number;
  qty_multiply_by_monster_realm: number;
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
  monsterRealm?: string | null;
  playerRealm?: string | null;
  realmSuppressionMultiplier?: number;
};

type DistributeBattleRewardsOptions = {
  isDungeonBattle?: boolean;
};

type RewardItemMeta = {
  name: string;
  category: string;
  subCategory: string | null;
  effectDefs: unknown;
  qualityRank: number;
  disassemblable: boolean | null;
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
  realm: string;
  fuyuan?: number;
}

/**
 * BattleDropService
 *
 * 作用：
 *   战斗掉落与奖励分发的核心服务，负责掉落计算、经验银两分配、物品分发。
 *
 * 输入/输出：
 *   - getDropPool: 根据掉落池 ID 返回掉落池配置
 *   - rollDrops: 根据掉落池、福缘、战斗选项计算掉落结果
 *   - calculateAllDrops: 从多个怪物计算所有掉落并合并
 *   - distributeBattleRewards: 分发战斗奖励（经验、银两、物品），使用事务
 *   - quickDistributeRewards: 快速分发奖励（用于自动战斗等场景）
 *   - getItemDefInfo: 获取物品定义信息
 *
 * 数据流/状态流：
 *   怪物数据 → 掉落池解析 → 掉落计算（福缘、境界压制）→ 物品分发（背包/邮件）→ 任务事件记录
 *
 * 关键边界条件与坑点：
 *   1. distributeBattleRewards 使用 @Transactional 确保奖励分发的原子性
 *   2. 背包满时自动通过邮件补发，每封邮件最多 10 个附件
 *   3. 境界压制倍率影响掉落概率和经验银两，每超出 1 级倍率乘 0.5
 *   4. 装备掉落支持品质权重和自动分解规则
 */
class BattleDropService {
  private dropPoolCache = new Map<string, DropPool | null>();
  private rewardMonsterDataCache = new Map<string, MonsterData | null>();
  private rewardItemMetaCache = new Map<string, RewardItemMeta>();

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  /**
   * 统一境界压制倍率：
   * - 玩家境界 <= 怪物境界+1：不压制（1）
   * - 每多超出 1 级：倍率乘 0.5
   * - 任一方境界无法识别：不压制（1）
   */
  private getRealmSuppressionMultiplier(
    playerRealmRaw: string | null | undefined,
    monsterRealmRaw: string | null | undefined,
  ): number {
    const playerRealm = typeof playerRealmRaw === 'string' ? playerRealmRaw.trim() : '';
    const monsterRealm = typeof monsterRealmRaw === 'string' ? monsterRealmRaw.trim() : '';
    if (!playerRealm || !monsterRealm) return 1;

    const playerRank = getRealmOrderIndex(playerRealm);
    const monsterRank = getRealmOrderIndex(monsterRealm);
    if (playerRank < 0 || monsterRank < 0) return 1;

    const extraLevels = playerRank - (monsterRank + 1);
    if (extraLevels <= 0) return 1;
    return 0.5 ** extraLevels;
  }

  /**
   * 生成范围内的随机整数
   */
  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * 合并相同物品的掉落
   */
  private mergeDrops(drops: DropResult[]): DropResult[] {
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
  }

  /**
   * 获取掉落池及其条目
   */
  async getDropPool(poolId: string): Promise<DropPool | null> {
    if (this.dropPoolCache.has(poolId)) {
      return this.dropPoolCache.get(poolId) ?? null;
    }

    const resolvedPool = resolveDropPoolById(poolId);
    if (!resolvedPool) {
      this.dropPoolCache.set(poolId, null);
      return null;
    }

    const dropPool: DropPool = {
      id: resolvedPool.id,
      name: resolvedPool.name,
      mode: resolvedPool.mode,
      entries: resolvedPool.entries.map((entry, idx) => ({
        id: idx + 1,
        item_def_id: entry.item_def_id,
        chance: entry.chance,
        weight: entry.weight,
        chance_add_by_monster_realm: entry.chance_add_by_monster_realm,
        qty_min: entry.qty_min,
        qty_max: entry.qty_max,
        qty_min_add_by_monster_realm: entry.qty_min_add_by_monster_realm,
        qty_max_add_by_monster_realm: entry.qty_max_add_by_monster_realm,
        qty_multiply_by_monster_realm: entry.qty_multiply_by_monster_realm,
        quality_weights: entry.quality_weights,
        bind_type: entry.bind_type,
        sourceType: entry.sourceType,
        sourcePoolId: entry.sourcePoolId,
      })),
    };
    this.dropPoolCache.set(poolId, dropPool);
    return dropPool;
  }

  /**
   * 解析奖励结算所需的怪物快照（按输入顺序保留重复怪物）。
   *
   * 作用：
   * - 统一承接 quickDistributeRewards 的怪物配置读取；
   * - 使用实例级缓存避免每场战斗都全量扫描 monster_def；
   * - 严格保留 monsterIds 中的重复项，确保多只同种怪会累计多份奖励。
   *
   * 边界条件：
   * 1. 未启用或不存在的怪物会被跳过，不制造占位数据。
   * 2. 返回值只读静态配置字段，不在后续流程中修改，适合做长生命周期缓存。
   */
  private resolveRewardMonsters(monsterIds: string[]): MonsterData[] {
    const monsters: MonsterData[] = [];

    for (const monsterId of monsterIds) {
      const normalizedMonsterId = String(monsterId || '').trim();
      if (!normalizedMonsterId) continue;

      if (!this.rewardMonsterDataCache.has(normalizedMonsterId)) {
        const definition = getMonsterDefinitions().find(
          (entry) => entry.enabled !== false && entry.id === normalizedMonsterId,
        );
        const rewardMonsterData = definition
          ? ({
              id: definition.id,
              name: definition.name,
              realm: definition.realm ?? '凡人',
              element: definition.element ?? 'none',
              base_attrs: definition.base_attrs ?? {},
              exp_reward: Number(definition.exp_reward ?? 0),
              silver_reward_min: Number(definition.silver_reward_min ?? 0),
              silver_reward_max: Number(definition.silver_reward_max ?? 0),
              kind: definition.kind,
              drop_pool_id: definition.drop_pool_id ?? null,
            } as MonsterData)
          : null;
        this.rewardMonsterDataCache.set(normalizedMonsterId, rewardMonsterData);
      }

      const rewardMonsterData = this.rewardMonsterDataCache.get(normalizedMonsterId);
      if (rewardMonsterData) {
        monsters.push(rewardMonsterData);
      }
    }

    return monsters;
  }

  /**
   * 获取奖励物品元数据缓存。
   *
   * 作用：
   * - 把物品名称、品质、自动分解判定字段收敛到统一缓存入口；
   * - 避免高频奖励结算反复读取同一份 item_def 静态配置。
   */
  private getRewardItemMeta(itemDefId: string): RewardItemMeta {
    const cachedMeta = this.rewardItemMetaCache.get(itemDefId);
    if (cachedMeta) {
      return cachedMeta;
    }

    const def = getItemDefinitionById(itemDefId);
    const meta: RewardItemMeta = {
      name: def?.name || itemDefId,
      category: typeof def?.category === 'string' ? def.category : '',
      subCategory: def?.sub_category ?? null,
      effectDefs: def?.effect_defs ?? null,
      qualityRank: resolveQualityRankFromName(def?.quality, 1),
      disassemblable:
        typeof def?.disassemblable === 'boolean' ? def.disassemblable : null,
    };
    this.rewardItemMetaCache.set(itemDefId, meta);
    return meta;
  }

  /**
   * 从掉落池计算掉落物品
   */
  rollDrops(
    dropPool: DropPool,
    fuyuan: number = 0,
    options: RollDropsOptions = {}
  ): DropResult[] {
    const results: DropResult[] = [];
    const cappedFuyuan = Math.min(200, Math.max(0, Number(fuyuan ?? 0)));
    const chanceMultiplier = 1 + cappedFuyuan * 0.0025;
    const isDungeonBattle = options.isDungeonBattle === true;
    const monsterKind = normalizeMonsterKind(options.monsterKind);
    const monsterRealm = typeof options.monsterRealm === 'string' ? options.monsterRealm : null;
    const playerRealm = typeof options.playerRealm === 'string' ? options.playerRealm : null;
    const optionsSuppression = Number(options.realmSuppressionMultiplier);
    const realmSuppressionMultiplier = Number.isFinite(optionsSuppression)
      ? this.clamp01(optionsSuppression)
      : this.getRealmSuppressionMultiplier(playerRealm, monsterRealm);

    if (dropPool.mode === 'prob') {
      // 概率模式：每个条目独立判定
      for (const entry of dropPool.entries) {
        const effectiveChance = this.clamp01(
          getAdjustedChance(entry.chance * chanceMultiplier, entry.sourceType, entry.sourcePoolId, {
            isDungeonBattle,
            monsterKind,
            monsterRealm,
            chanceAddByMonsterRealm: entry.chance_add_by_monster_realm,
          }) * realmSuppressionMultiplier,
        );
        if (Math.random() < effectiveChance) {
          const baseQuantityRange = getMonsterRealmAdjustedBaseQuantityRange({
            qtyMin: entry.qty_min,
            qtyMax: entry.qty_max,
            qtyMinAddByMonsterRealm: entry.qty_min_add_by_monster_realm,
            qtyMaxAddByMonsterRealm: entry.qty_max_add_by_monster_realm,
            monsterRealm,
          });
          const adjustedQuantity = getAdjustedQuantity(
            this.randomInt(baseQuantityRange.qtyMin, baseQuantityRange.qtyMax),
            entry.sourceType,
            entry.sourcePoolId,
            { isDungeonBattle, monsterKind },
            shouldApplyDropQuantityMultiplier(entry.item_def_id),
          );
          const quantity = applyMonsterRealmDropQtyMultiplier(
            adjustedQuantity,
            entry.qty_multiply_by_monster_realm,
            monsterRealm,
          );
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
        // 权重池原逻辑是”必出其一”，这里先做一次整体触发判定，再进入选条目流程。
        if (Math.random() >= realmSuppressionMultiplier) return results;
        let roll = Math.random() * totalWeight;
        for (const entry of dropPool.entries) {
          roll -= getAdjustedWeight(entry.weight, entry.sourceType, entry.sourcePoolId, {
            isDungeonBattle,
            monsterKind,
          });
          if (roll <= 0) {
            const baseQuantityRange = getMonsterRealmAdjustedBaseQuantityRange({
              qtyMin: entry.qty_min,
              qtyMax: entry.qty_max,
              qtyMinAddByMonsterRealm: entry.qty_min_add_by_monster_realm,
              qtyMaxAddByMonsterRealm: entry.qty_max_add_by_monster_realm,
              monsterRealm,
            });
            const adjustedQuantity = getAdjustedQuantity(
              this.randomInt(baseQuantityRange.qtyMin, baseQuantityRange.qtyMax),
              entry.sourceType,
              entry.sourcePoolId,
              { isDungeonBattle, monsterKind },
              shouldApplyDropQuantityMultiplier(entry.item_def_id),
            );
            const quantity = applyMonsterRealmDropQtyMultiplier(
              adjustedQuantity,
              entry.qty_multiply_by_monster_realm,
              monsterRealm,
            );
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
  }

  /**
   * 从多个怪物计算所有掉落
   */
  async calculateAllDrops(monsters: MonsterData[]): Promise<DropResult[]> {
    const allDrops: DropResult[] = [];

    for (const monster of monsters) {
      if (!monster.drop_pool_id) continue;

      const dropPool = await this.getDropPool(monster.drop_pool_id);
      if (!dropPool) continue;

      const monsterKind = normalizeMonsterKind(monster.kind);
      const drops = this.rollDrops(dropPool, 0, { monsterKind, monsterRealm: monster.realm });
      allDrops.push(...drops);
    }

    // 合并相同物品
    return this.mergeDrops(allDrops);
  }

/**
   * 分发战斗奖励（经验、银两、物品）
   *
   * @param monsters 击杀的怪物列表
   * @param participants 参与战斗的玩家列表
   * @param isVictory 是否胜利
   */
  async distributeBattleRewards(
    monsters: MonsterData[],
    participants: BattleParticipant[],
    isVictory: boolean,
    options: DistributeBattleRewardsOptions = {}
  ): Promise<DistributeResult> {
    return withTransactionAuto(() =>
      this.distributeBattleRewardsInTransaction(monsters, participants, isVictory, options),
    );
  }

  private async distributeBattleRewardsInTransaction(
    monsters: MonsterData[],
    participants: BattleParticipant[],
    isVictory: boolean,
    options: DistributeBattleRewardsOptions = {}
  ): Promise<DistributeResult> {
    if (!isVictory || participants.length === 0) {
      return {
        success: true,
        message: '战斗失败，无奖励',
        rewards: { exp: 0, silver: 0, items: [] },
      };
    }

    const pendingMailByReceiver = new Map<number, { userId: number; items: MailAttachItem[] }>();
    const collectCounts = new Map<string, { characterId: number; itemDefId: string; qty: number }>();
    const pendingCharacterRewardDeltas = new Map<number, CharacterRewardDelta>();

    const participantCharacterIds = [...new Set(
      participants
        .map((p) => Number(p.characterId))
        .filter((id) => Number.isInteger(id) && id > 0)
    )].sort((a, b) => a - b);
    
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
    const pickRollPointWinner = (): BattleParticipant => {
      const winnerIndex = participantCount > 1 ? Math.floor(Math.random() * participantCount) : 0;
      return participants[winnerIndex]!;
    };
    const resolveParticipantFuyuan = (participant: BattleParticipant): number => {
      const parsed = Number(participant.fuyuan ?? 1);
      return Number.isFinite(parsed) ? parsed : 1;
    };
    const teamAverageFuyuan =
      participants.reduce((sum, participant) => sum + resolveParticipantFuyuan(participant), 0) / participantCount;
    const isDungeonBattle = options.isDungeonBattle === true;
    const baseExpAcc = new Map<number, number>();
    const baseSilverAcc = new Map<number, number>();
    for (const participant of participants) {
      baseExpAcc.set(participant.characterId, 0);
      baseSilverAcc.set(participant.characterId, 0);
    }

    // 1. 先按“怪物逐条 + 个人境界压制”累加经验与基础银两。
    for (const monster of monsters) {
      const monsterExp = Math.max(0, Number(monster.exp_reward) || 0);
      const silverMin = Math.max(0, Number(monster.silver_reward_min) || 0);
      const silverMax = Math.max(silverMin, Number(monster.silver_reward_max) || silverMin);
      const silverRoll = this.randomInt(silverMin, silverMax);
      const expShare = monsterExp / participantCount;
      const silverShare = silverRoll / participantCount;

      for (const participant of participants) {
        const penalty = this.getRealmSuppressionMultiplier(participant.realm, monster.realm);
        baseExpAcc.set(participant.characterId, (baseExpAcc.get(participant.characterId) ?? 0) + expShare * penalty);
        baseSilverAcc.set(
          participant.characterId,
          (baseSilverAcc.get(participant.characterId) ?? 0) + silverShare * penalty,
        );
      }
    }

    const mergedDropsByReceiver = new Map<
      string,
      { receiver: BattleParticipant; drop: DropResult; receiverFuyuan: number }
    >();
    const appendMergedDropByReceiver = (
      receiver: BattleParticipant,
      drop: DropResult,
      quantity: number,
      receiverFuyuan: number,
    ): void => {
      const normalizedQty = Math.max(0, Math.floor(quantity));
      if (normalizedQty <= 0) return;
      const key = `${receiver.characterId}|${drop.itemDefId}|${drop.bindType}|${stableQualityWeightsKey(drop.qualityWeights)}`;
      const existing = mergedDropsByReceiver.get(key);
      if (existing) {
        existing.drop.quantity += normalizedQty;
      } else {
        mergedDropsByReceiver.set(key, {
          receiver,
          receiverFuyuan,
          drop: {
            ...drop,
            quantity: normalizedQty,
          },
        });
      }
    };

    for (const monster of monsters) {
      if (!monster.drop_pool_id) continue;

      const dropPool = await this.getDropPool(monster.drop_pool_id);
      if (!dropPool) continue;

      // 掉落生成按“队伍平均福缘 + 队伍平均境界压制”计算，
      // 但战利品归属改为“每个掉落条目按数量逐件独立ROLL点”。
      const teamRealmSuppressionMultiplier =
        participants.reduce(
          (sum, participant) => sum + this.getRealmSuppressionMultiplier(participant.realm, monster.realm),
          0,
        ) / participantCount;

      const drops = this.rollDrops(dropPool, teamAverageFuyuan, {
        isDungeonBattle,
        monsterKind: normalizeMonsterKind(monster.kind),
        monsterRealm: monster.realm,
        realmSuppressionMultiplier: teamRealmSuppressionMultiplier,
      });
      for (const drop of drops) {
        const dropQty = Math.max(0, Math.floor(Number(drop.quantity) || 0));
        if (dropQty <= 0) continue;

        if (participantCount <= 1) {
          const singleReceiver = participants[0]!;
          appendMergedDropByReceiver(
            singleReceiver,
            drop,
            dropQty,
            resolveParticipantFuyuan(singleReceiver),
          );
          continue;
        }

        const qtyByReceiver = new Map<number, { receiver: BattleParticipant; qty: number; receiverFuyuan: number }>();
        for (let i = 0; i < dropQty; i++) {
          const rollWinner = pickRollPointWinner();
          const receiverCharacterId = Number(rollWinner.characterId);
          if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) continue;
          const existing = qtyByReceiver.get(receiverCharacterId);
          if (existing) {
            existing.qty += 1;
            continue;
          }
          qtyByReceiver.set(receiverCharacterId, {
            receiver: rollWinner,
            qty: 1,
            receiverFuyuan: resolveParticipantFuyuan(rollWinner),
          });
        }

        for (const allocation of qtyByReceiver.values()) {
          appendMergedDropByReceiver(
            allocation.receiver,
            drop,
            allocation.qty,
            allocation.receiverFuyuan,
          );
        }
      }
    }

    const requiresInventoryMutation = mergedDropsByReceiver.size > 0;

    if (requiresInventoryMutation && participantCharacterIds.length > 0) {
      // 奖励结算统一固定为“先背包互斥锁，再按升序锁 characters 行”。
      // 这样可以避免同角色并发发奖时，在入包阶段与最终资源落库阶段出现反向等待。
      await lockCharacterRewardSettlementTargets(participantCharacterIds);
    }
    
    // 3. 先汇总经验和银两，等入包/补发/事件记录流程结束后再统一写回，
    //    避免把角色资源更新散落在多个奖励分支里。
    let totalExp = 0;
    let totalSilver = 0;
    
    const perPlayerRewards: DistributeResult['perPlayerRewards'] = [];
    
    for (const participant of participants) {
      const expGain = Math.max(0, Math.floor(baseExpAcc.get(participant.characterId) ?? 0));
      const silverGain = Math.max(0, Math.floor(baseSilverAcc.get(participant.characterId) ?? 0));

      addCharacterRewardDelta(pendingCharacterRewardDeltas, participant.characterId, {
        exp: expGain,
        silver: silverGain,
      });
      
      perPlayerRewards.push({
        characterId: participant.characterId,
        userId: participant.userId,
        exp: expGain,
        silver: silverGain,
        items: [],
      });
      totalExp += expGain;
      totalSilver += silverGain;
    }
    
    // 4. 分发物品（组队按“每个战利品条目独立ROLL点”分配，单人全部获得）
    const allItems: DistributeResult['rewards']['items'] = [];
    const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();

    if (requiresInventoryMutation && participantCharacterIds.length > 0) {
      const settingRows = await Promise.all(
        participantCharacterIds.map(async (characterId) => loadCharacterWritebackRowByCharacterId(characterId)),
      );
      for (const row of settingRows) {
        if (!row) continue;
        autoDisassembleSettings.set(
          Number(row.id),
          normalizeAutoDisassembleSetting({
            enabled: row.auto_disassemble_enabled,
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

    for (const entry of mergedDropsByReceiver.values()) {
      const drop = entry.drop;
      const receiver = entry.receiver;
      const receiverCharacterId = Number(receiver.characterId);
      if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) {
        console.warn(`奖励分发跳过：非法角色ID ${String(receiver.characterId)}`);
        continue;
      }

      const sourceMeta = this.getRewardItemMeta(drop.itemDefId);
      const createOptions: CreateItemOptions = {
        location: 'bag',
        bindType: drop.bindType,
        obtainedFrom: 'battle_drop',
      };
      if (sourceMeta.category === 'equipment') {
        createOptions.equipOptions = {
          fuyuan: entry.receiverFuyuan,
          ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights as Record<string, number> } : {}),
        };
      }

      const receiverAutoDisassemble =
        autoDisassembleSettings.get(receiverCharacterId) ||
        normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });

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
          qualityRank: sourceMeta.qualityRank,
          disassemblable: sourceMeta.disassemblable,
        },
        autoDisassembleSetting: receiverAutoDisassemble,
        sourceObtainedFrom: 'battle_drop',
        sourceEquipOptions: createOptions.equipOptions,
        createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
          return itemService.createItem(receiver.userId, receiverCharacterId, itemDefId, qty, {
            location: 'bag',
            obtainedFrom,
            ...(bindType ? { bindType } : {}),
            ...(equipOptions ? { equipOptions } : {}),
          });
        },
        addSilver: async (ownerCharacterId, silverGain) => {
          const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
          if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
          addCharacterRewardDelta(pendingCharacterRewardDeltas, ownerCharacterId, {
            silver: safeSilver,
          });
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
          granted.itemDefId === drop.itemDefId
            ? sourceMeta
            : this.getRewardItemMeta(granted.itemDefId);
        appendCollectCount(receiverCharacterId, granted.itemDefId, granted.qty);
        appendRewardRecord(receiverCharacterId, granted.itemDefId, grantedMeta.name, granted.qty, granted.itemIds);
      }
    }
    
    for (const entry of collectCounts.values()) {
      await recordCollectItemEvent(entry.characterId, entry.itemDefId, entry.qty);
    }

    for (const [receiverCharacterId, entry] of pendingMailByReceiver.entries()) {
      const items = entry.items;
      const chunkSize = 10;
      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
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
      }
    }

    await applyCharacterRewardDeltas(pendingCharacterRewardDeltas);
    
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
  }

  /**
   * 快速分发奖励（用于自动战斗等场景）
   */
  async quickDistributeRewards(
    monsterIds: string[],
    participants: BattleParticipant[],
    isVictory: boolean
  ): Promise<DistributeResult> {
    if (!isVictory || participants.length === 0 || monsterIds.length === 0) {
      return {
        success: true,
        message: '无奖励',
        rewards: { exp: 0, silver: 0, items: [] },
      };
    }

    const monsters = this.resolveRewardMonsters(monsterIds);
    if (monsters.length === 0) {
      return {
        success: true,
        message: '无奖励',
        rewards: { exp: 0, silver: 0, items: [] },
      };
    }

    return this.distributeBattleRewards(monsters, participants, isVictory);
  }

  /**
   * 获取物品定义信息
   */
  async getItemDefInfo(itemDefId: string): Promise<{
    name: string;
    category: string;
    quality: string;
    icon: string;
  } | null> {
    const def = getItemDefinitionById(itemDefId);
    if (!def) return null;
    return {
      name: String(def.name || itemDefId),
      category: String(def.category || ''),
      quality: String(def.quality || ''),
      icon: String(def.icon || ''),
    };
  }
}

export const battleDropService = new BattleDropService();
