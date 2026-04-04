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
import { recordCollectItemEvent, recordCollectItemEvents } from './taskService.js';
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
import {
  lockCharacterRewardSettlementTargets,
  normalizeCharacterRewardTargetIds,
} from './shared/characterRewardTargetLock.js';
import { getRealmOrderIndex } from './shared/realmRules.js';
import type {
  IdleBattleRewardSettlementPlan,
  IdleRewardPlanDropEntry,
  RewardItemEntry,
} from './idle/types.js';
import { createSlowOperationLogger } from '../utils/slowOperationLogger.js';

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

const BATTLE_REWARD_SETTLEMENT_SLOW_THRESHOLD_MS = 200;

type RollDropsOptions = {
  isDungeonBattle?: boolean;
  monsterKind?: MonsterKind;
  monsterRealm?: string | null;
  playerRealm?: string | null;
  realmSuppressionMultiplier?: number;
  dungeonRewardMultiplier?: number;
};

type DistributeBattleRewardsOptions = {
  isDungeonBattle?: boolean;
  dungeonRewardMultiplier?: number;
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

export interface PlannedBattleRewardDrop {
  receiverCharacterId: number;
  receiverUserId: number;
  receiverFuyuan: number;
  itemDefId: string;
  quantity: number;
  bindType: string;
  qualityWeights?: Record<string, number>;
}

export interface PlannedBattlePlayerReward {
  characterId: number;
  userId: number;
  exp: number;
  silver: number;
  drops: PlannedBattleRewardDrop[];
}

export interface BattleRewardSettlementPlan {
  totalExp: number;
  totalSilver: number;
  drops: PlannedBattleRewardDrop[];
  perPlayerRewards: PlannedBattlePlayerReward[];
}

// 参与者信息
export interface BattleParticipant {
  userId: number;
  characterId: number;
  nickname: string;
  realm: string;
  fuyuan?: number;
}

export interface SinglePlayerRewardSettlementResult {
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  bagFullFlag: boolean;
}

type PendingMailBucket = {
  userId: number;
  items: MailAttachItem[];
  itemByKey: Map<string, MailAttachItem>;
};

const buildPendingMailItemMergeKey = (item: MailAttachItem): string => {
  return [
    item.item_def_id,
    item.options?.bindType || 'none',
    JSON.stringify(item.options?.equipOptions || null),
  ].join('|');
};

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
 *   - planBattleRewards: 生成一次性奖励计划，供即时预览与异步真实发奖复用
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
 *   3. 境界压制倍率影响经验银两，且仅普通战斗掉落概率会受影响；每超出 1 级倍率乘 0.5
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
   * 统一掉落用境界压制倍率。
   *
   * 作用：
   * 1. 把“普通战斗吃境界压制、秘境掉落不吃境界压制”的规则收敛到单一入口。
   * 2. 复用 rollDrops 在概率池/权重池两条分支的同一口径，避免场景判断散落。
   *
   * 输入/输出：
   * - 输入：rollDrops 的战斗场景、玩家/怪物境界，以及上游已计算好的覆盖倍率。
   * - 输出：本次掉落结算应使用的 0~1 倍率。
   *
   * 数据流/状态流：
   * - 单人奖励计划和组队奖励结算都先把场景参数传给 rollDrops；
   * - 本方法在 rollDrops 内统一解释“是否压制掉落”；
   * - 后续概率池与权重池都只消费这里返回的倍率。
   *
   * 关键边界条件与坑点：
   * 1. 秘境只豁免掉落压制，不豁免经验和银两压制，因此不能替换 getRealmSuppressionMultiplier 的通用语义。
   * 2. 组队场景会传入队伍平均倍率；普通战斗仍应优先尊重该显式输入，避免重复计算造成口径漂移。
   */
  private getDropRealmSuppressionMultiplier(options: RollDropsOptions): number {
    if (options.isDungeonBattle === true) {
      return 1;
    }

    const optionsSuppression = Number(options.realmSuppressionMultiplier);
    if (Number.isFinite(optionsSuppression)) {
      return this.clamp01(optionsSuppression);
    }

    const playerRealm = typeof options.playerRealm === 'string' ? options.playerRealm : null;
    const monsterRealm = typeof options.monsterRealm === 'string' ? options.monsterRealm : null;
    return this.getRealmSuppressionMultiplier(playerRealm, monsterRealm);
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
    const realmSuppressionMultiplier = this.getDropRealmSuppressionMultiplier(options);
    const dungeonRewardMultiplier = options.dungeonRewardMultiplier;

    if (dropPool.mode === 'prob') {
      // 概率模式：每个条目独立判定
      for (const entry of dropPool.entries) {
        const effectiveChance = this.clamp01(
          getAdjustedChance(entry.chance * chanceMultiplier, entry.sourceType, entry.sourcePoolId, {
            isDungeonBattle,
            monsterKind,
            monsterRealm,
            chanceAddByMonsterRealm: entry.chance_add_by_monster_realm,
            dungeonRewardMultiplier,
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
          dungeonRewardMultiplier,
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
            dungeonRewardMultiplier,
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

  private mergeIdleRewardDropPlans(
    dropPlans: IdleRewardPlanDropEntry[],
  ): IdleRewardPlanDropEntry[] {
    return this.mergeDrops(
      dropPlans.map((drop) => ({
        itemDefId: drop.itemDefId,
        quantity: drop.quantity,
        bindType: drop.bindType,
        ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
      })),
    ).map((drop) => ({
      itemDefId: drop.itemDefId,
      quantity: drop.quantity,
      bindType: drop.bindType,
      ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
    }));
  }

  private buildPreviewItemsFromDropPlans(
    dropPlans: IdleRewardPlanDropEntry[],
  ): RewardItemEntry[] {
    return dropPlans.map((drop) => ({
      itemDefId: drop.itemDefId,
      itemName: this.getRewardItemMeta(drop.itemDefId).name,
      quantity: drop.quantity,
    }));
  }

  private async buildSinglePlayerBattleRewardPlanFromMonsters(
    monsters: MonsterData[],
    participant: BattleParticipant,
    options: DistributeBattleRewardsOptions = {},
  ): Promise<IdleBattleRewardSettlementPlan> {
    const isDungeonBattle = options.isDungeonBattle === true;
    const dungeonRewardMultiplier = options.dungeonRewardMultiplier;
    const participantFuyuan = (() => {
      const raw = Number(participant.fuyuan ?? 1);
      return Number.isFinite(raw) ? raw : 1;
    })();

    let expGainedRaw = 0;
    let silverGainedRaw = 0;
    const dropPlans: IdleRewardPlanDropEntry[] = [];

    for (const monster of monsters) {
      const suppressionMultiplier = this.getRealmSuppressionMultiplier(
        participant.realm,
        monster.realm,
      );
      const monsterExp = Math.max(0, Number(monster.exp_reward) || 0);
      const silverMin = Math.max(0, Number(monster.silver_reward_min) || 0);
      const silverMax = Math.max(silverMin, Number(monster.silver_reward_max) || silverMin);

      expGainedRaw += monsterExp * suppressionMultiplier;
      silverGainedRaw += this.randomInt(silverMin, silverMax) * suppressionMultiplier;

      if (!monster.drop_pool_id) {
        continue;
      }

      const dropPool = await this.getDropPool(monster.drop_pool_id);
      if (!dropPool) {
        continue;
      }

      const drops = this.rollDrops(dropPool, participantFuyuan, {
        isDungeonBattle,
        monsterKind: normalizeMonsterKind(monster.kind),
        monsterRealm: monster.realm,
        playerRealm: participant.realm,
        realmSuppressionMultiplier: suppressionMultiplier,
        dungeonRewardMultiplier,
      });

      for (const drop of drops) {
        const quantity = Math.max(0, Math.floor(Number(drop.quantity) || 0));
        if (quantity <= 0) {
          continue;
        }
        dropPlans.push({
          itemDefId: drop.itemDefId,
          quantity,
          bindType: drop.bindType,
          ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
        });
      }
    }

    const mergedDropPlans = this.mergeIdleRewardDropPlans(dropPlans);

    return {
      expGained: Math.max(0, Math.floor(expGainedRaw)),
      silverGained: Math.max(0, Math.floor(silverGainedRaw)),
      previewItems: this.buildPreviewItemsFromDropPlans(mergedDropPlans),
      dropPlans: mergedDropPlans,
    };
  }

  async planSinglePlayerBattleRewards(
    monsterIds: string[],
    participant: BattleParticipant,
    isVictory: boolean,
    options: DistributeBattleRewardsOptions = {},
  ): Promise<IdleBattleRewardSettlementPlan> {
    if (!isVictory || monsterIds.length === 0) {
      return {
        expGained: 0,
        silverGained: 0,
        previewItems: [],
        dropPlans: [],
      };
    }

    const monsters = this.resolveRewardMonsters(monsterIds);
    if (monsters.length === 0) {
      return {
        expGained: 0,
        silverGained: 0,
        previewItems: [],
        dropPlans: [],
      };
    }

    return this.buildSinglePlayerBattleRewardPlanFromMonsters(
      monsters,
      participant,
      options,
    );
  }

  async settleSinglePlayerBattleRewardPlan(
    participant: BattleParticipant,
    plan: IdleBattleRewardSettlementPlan,
  ): Promise<SinglePlayerRewardSettlementResult> {
    return withTransactionAuto(() =>
      this.settleSinglePlayerBattleRewardPlanInTransaction(participant, plan),
    );
  }

  private async settleSinglePlayerBattleRewardPlanInTransaction(
    participant: BattleParticipant,
    plan: IdleBattleRewardSettlementPlan,
  ): Promise<SinglePlayerRewardSettlementResult> {
    const receiverCharacterId = Number(participant.characterId);
    if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) {
      return {
        expGained: 0,
        silverGained: 0,
        itemsGained: [],
        bagFullFlag: false,
      };
    }

    const pendingCharacterRewardDeltas = new Map<number, CharacterRewardDelta>();
    addCharacterRewardDelta(pendingCharacterRewardDeltas, receiverCharacterId, {
      exp: plan.expGained,
      silver: plan.silverGained,
    });

    const settledItems = new Map<string, RewardItemEntry>();
    const collectCounts = new Map<string, { itemDefId: string; qty: number }>();
    const pendingMailItems: MailAttachItem[] = [];

    const appendSettledItem = (
      itemDefId: string,
      itemName: string,
      quantity: number,
    ): void => {
      const existing = settledItems.get(itemDefId);
      if (existing) {
        existing.quantity += quantity;
        return;
      }
      settledItems.set(itemDefId, { itemDefId, itemName, quantity });
    };

    const appendCollectCount = (itemDefId: string, qty: number): void => {
      const existing = collectCounts.get(itemDefId);
      if (existing) {
        existing.qty += qty;
        return;
      }
      collectCounts.set(itemDefId, { itemDefId, qty });
    };

    let totalSilver = plan.silverGained;
    let autoDisassembleSetting = normalizeAutoDisassembleSetting({
      enabled: false,
      rules: undefined,
    });

    if (plan.dropPlans.length > 0) {
      await lockCharacterRewardSettlementTargets([receiverCharacterId]);

      const settingResult = await query(
        `
          SELECT auto_disassemble_enabled, auto_disassemble_rules
          FROM characters
          WHERE id = $1
          LIMIT 1
        `,
        [receiverCharacterId],
      );

      const row = settingResult.rows[0] as
        | { auto_disassemble_enabled: boolean | null; auto_disassemble_rules: unknown }
        | undefined;
      if (row) {
        autoDisassembleSetting = normalizeAutoDisassembleSetting({
          enabled: row.auto_disassemble_enabled,
          rules: row.auto_disassemble_rules,
        });
      }
    }

    for (const dropPlan of plan.dropPlans) {
      const sourceMeta = this.getRewardItemMeta(dropPlan.itemDefId);
      const createOptions: CreateItemOptions = {
        location: 'bag',
        bindType: dropPlan.bindType,
        obtainedFrom: 'battle_drop',
      };
      if (sourceMeta.category === 'equipment') {
        createOptions.equipOptions = {
          fuyuan: Number.isFinite(Number(participant.fuyuan)) ? Number(participant.fuyuan) : 1,
          ...(dropPlan.qualityWeights ? { qualityWeights: dropPlan.qualityWeights } : {}),
        };
      }

      const grantResult = await grantRewardItemWithAutoDisassemble({
        characterId: receiverCharacterId,
        itemDefId: dropPlan.itemDefId,
        qty: dropPlan.quantity,
        bindType: dropPlan.bindType,
        itemMeta: {
          itemName: sourceMeta.name,
          category: sourceMeta.category,
          subCategory: sourceMeta.subCategory,
          effectDefs: sourceMeta.effectDefs,
          qualityRank: sourceMeta.qualityRank,
          disassemblable: sourceMeta.disassemblable,
        },
        autoDisassembleSetting,
        sourceObtainedFrom: 'battle_drop',
        sourceEquipOptions: createOptions.equipOptions,
        createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
          return itemService.createItem(
            participant.userId,
            receiverCharacterId,
            itemDefId,
            qty,
            {
              location: 'bag',
              obtainedFrom,
              ...(bindType ? { bindType } : {}),
              ...(equipOptions ? { equipOptions } : {}),
            },
          );
        },
        addSilver: async (ownerCharacterId, silverGain) => {
          const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
          if (safeSilver <= 0) {
            return { success: true, message: '无需增加银两' };
          }
          addCharacterRewardDelta(pendingCharacterRewardDeltas, ownerCharacterId, {
            silver: safeSilver,
          });
          return { success: true, message: '银两增加成功' };
        },
      });

      for (const warning of grantResult.warnings) {
        console.warn(`挂机奖励兑现告警: ${warning}`);
      }

      for (const mailItem of grantResult.pendingMailItems) {
        pendingMailItems.push(mailItem);
      }

      if (grantResult.gainedSilver > 0) {
        totalSilver += grantResult.gainedSilver;
      }

      for (const granted of grantResult.grantedItems) {
        const grantedMeta =
          granted.itemDefId === dropPlan.itemDefId
            ? sourceMeta
            : this.getRewardItemMeta(granted.itemDefId);
        appendCollectCount(granted.itemDefId, granted.qty);
        appendSettledItem(granted.itemDefId, grantedMeta.name, granted.qty);
      }
    }

    for (const { itemDefId, qty } of collectCounts.values()) {
      await recordCollectItemEvent(receiverCharacterId, itemDefId, qty);
    }

    if (pendingMailItems.length > 0) {
      const chunkSize = 10;
      for (let index = 0; index < pendingMailItems.length; index += chunkSize) {
        const chunk = pendingMailItems.slice(index, index + chunkSize);
        const mailResult = await sendSystemMail(
          participant.userId,
          receiverCharacterId,
          '战斗掉落补发',
          '由于背包空间不足，部分战斗掉落已通过邮件补发，请前往邮箱领取。',
          { items: chunk },
          30,
        );
        if (!mailResult.success) {
          console.warn(`挂机掉落补发邮件发送失败: ${mailResult.message}`);
        }
      }
    }

    await applyCharacterRewardDeltas(pendingCharacterRewardDeltas);

    return {
      expGained: plan.expGained,
      silverGained: totalSilver,
      itemsGained: Array.from(settledItems.values()),
      bagFullFlag: pendingMailItems.length > 0,
    };
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
    const plan = await this.planBattleRewards(monsters, participants, isVictory, options);
    return this.settleBattleRewardPlan(plan);
  }

  async planBattleRewards(
    monsters: MonsterData[],
    participants: BattleParticipant[],
    isVictory: boolean,
    options: DistributeBattleRewardsOptions = {},
  ): Promise<BattleRewardSettlementPlan> {
    if (!isVictory || participants.length === 0) {
      return {
        totalExp: 0,
        totalSilver: 0,
        drops: [],
        perPlayerRewards: [],
      };
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
    const dungeonRewardMultiplier = options.dungeonRewardMultiplier;
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

    const mergedDropsByReceiver = new Map<string, PlannedBattleRewardDrop>();

    for (const monster of monsters) {
      if (!monster.drop_pool_id) continue;

      const dropPool = await this.getDropPool(monster.drop_pool_id);
      if (!dropPool) continue;

      // 掉落生成按“队伍平均福缘 + 掉落口径的队伍压制倍率”计算，
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
        dungeonRewardMultiplier,
      });
      for (const drop of drops) {
        const dropQty = Math.max(0, Math.floor(Number(drop.quantity) || 0));
        if (dropQty <= 0) continue;

        if (participantCount <= 1) {
          const singleReceiver = participants[0]!;
          const key = `${singleReceiver.characterId}|${drop.itemDefId}|${drop.bindType}|${stableQualityWeightsKey(drop.qualityWeights)}`;
          const existing = mergedDropsByReceiver.get(key);
          if (existing) {
            existing.quantity += dropQty;
          } else {
            mergedDropsByReceiver.set(key, {
              receiverCharacterId: Number(singleReceiver.characterId),
              receiverUserId: Number(singleReceiver.userId),
              receiverFuyuan: resolveParticipantFuyuan(singleReceiver),
              itemDefId: drop.itemDefId,
              quantity: dropQty,
              bindType: drop.bindType,
              ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
            });
          }
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
          const key = `${allocation.receiver.characterId}|${drop.itemDefId}|${drop.bindType}|${stableQualityWeightsKey(drop.qualityWeights)}`;
          const existing = mergedDropsByReceiver.get(key);
          if (existing) {
            existing.quantity += allocation.qty;
          } else {
            mergedDropsByReceiver.set(key, {
              receiverCharacterId: Number(allocation.receiver.characterId),
              receiverUserId: Number(allocation.receiver.userId),
              receiverFuyuan: allocation.receiverFuyuan,
              itemDefId: drop.itemDefId,
              quantity: allocation.qty,
              bindType: drop.bindType,
              ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
            });
          }
        }
      }
    }

    let totalExp = 0;
    let totalSilver = 0;
    const perPlayerRewards: PlannedBattlePlayerReward[] = [];

    for (const participant of participants) {
      const expGain = Math.max(0, Math.floor(baseExpAcc.get(participant.characterId) ?? 0));
      const silverGain = Math.max(0, Math.floor(baseSilverAcc.get(participant.characterId) ?? 0));
      perPlayerRewards.push({
        characterId: participant.characterId,
        userId: participant.userId,
        exp: expGain,
        silver: silverGain,
        drops: [],
      });
      totalExp += expGain;
      totalSilver += silverGain;
    }
    for (const drop of mergedDropsByReceiver.values()) {
      const playerReward = perPlayerRewards.find((reward) => reward.characterId === drop.receiverCharacterId);
      if (!playerReward) continue;
      playerReward.drops.push({ ...drop });
    }
    return {
      totalExp,
      totalSilver,
      drops: [...mergedDropsByReceiver.values()].map((drop) => ({ ...drop })),
      perPlayerRewards,
    };
  }

  buildDistributeResultFromBattleRewardPlan(
    plan: BattleRewardSettlementPlan,
  ): DistributeResult {
    const perPlayerRewards: NonNullable<DistributeResult['perPlayerRewards']> = plan.perPlayerRewards.map((reward) => ({
      characterId: reward.characterId,
      userId: reward.userId,
      exp: reward.exp,
      silver: reward.silver,
      items: [],
    }));
    const perPlayerRewardByCharacterId = new Map(
      perPlayerRewards.map((reward) => [reward.characterId, reward] as const),
    );
    const allItems: DistributeResult['rewards']['items'] = [];

    for (const drop of plan.drops) {
      const meta = this.getRewardItemMeta(drop.itemDefId);
      allItems.push({
        itemDefId: drop.itemDefId,
        itemName: meta.name,
        quantity: drop.quantity,
        instanceIds: [],
        receiverId: drop.receiverCharacterId,
      });
      const playerReward = perPlayerRewardByCharacterId.get(drop.receiverCharacterId);
      if (!playerReward) continue;
      playerReward.items.push({
        itemDefId: drop.itemDefId,
        itemName: meta.name,
        quantity: drop.quantity,
        instanceIds: [],
      });
    }

    return {
      success: true,
      message: '奖励预览生成成功',
      rewards: {
        exp: plan.totalExp,
        silver: plan.totalSilver,
        items: allItems,
      },
      perPlayerRewards,
    };
  }

  async settleBattleRewardPlan(
    plan: BattleRewardSettlementPlan,
  ): Promise<DistributeResult> {
    return withTransactionAuto(() =>
      this.settleBattleRewardPlanInTransaction(plan),
    );
  }

  private async settleBattleRewardPlanInTransaction(
    plan: BattleRewardSettlementPlan,
  ): Promise<DistributeResult> {
    if (plan.perPlayerRewards.length === 0) {
      return {
        success: true,
        message: '战斗失败，无奖励',
        rewards: { exp: 0, silver: 0, items: [] },
        perPlayerRewards: [],
      };
    }

    const pendingMailByReceiver = new Map<number, PendingMailBucket>();
    const collectEventMapByCharacter = new Map<number, Map<string, number>>();
    const pendingCharacterRewardDeltas = new Map<number, CharacterRewardDelta>();
    const participantCharacterIds = normalizeCharacterRewardTargetIds(
      plan.perPlayerRewards.map((reward) => Number(reward.characterId)),
    );
    const requiresInventoryMutation = plan.drops.length > 0;
    const slowLogger = createSlowOperationLogger({
      label: 'battleDropService.settleBattleRewardPlan',
      thresholdMs: BATTLE_REWARD_SETTLEMENT_SLOW_THRESHOLD_MS,
      fields: {
        rewardPlayerCount: plan.perPlayerRewards.length,
        dropCount: plan.drops.length,
        requiresInventoryMutation,
      },
    });
    let collectEventCount = 0;
    let pendingMailCount = 0;
    let success = false;

    try {
      for (const reward of plan.perPlayerRewards) {
        addCharacterRewardDelta(pendingCharacterRewardDeltas, reward.characterId, {
          exp: reward.exp,
          silver: reward.silver,
        });
      }
      slowLogger.mark('aggregateRewardDeltas', {
        rewardDeltaCharacterCount: pendingCharacterRewardDeltas.size,
      });

      if (requiresInventoryMutation && participantCharacterIds.length > 0) {
        await lockCharacterRewardSettlementTargets(participantCharacterIds);
        slowLogger.mark('lockCharacterRewardSettlementTargets', {
          lockedCharacterCount: participantCharacterIds.length,
        });
      }

      const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();
      if (requiresInventoryMutation && participantCharacterIds.length > 0) {
        const settingResult = await query(
          `
            SELECT id, auto_disassemble_enabled, auto_disassemble_rules
            FROM characters
            WHERE id = ANY($1)
          `,
          [participantCharacterIds],
        );
        for (const row of settingResult.rows as Array<{
          id: number;
          auto_disassemble_enabled: boolean | null;
          auto_disassemble_rules: unknown;
        }>) {
          autoDisassembleSettings.set(
            Number(row.id),
            normalizeAutoDisassembleSetting({
              enabled: row.auto_disassemble_enabled,
              rules: row.auto_disassemble_rules,
            }),
          );
        }
        slowLogger.mark('loadAutoDisassembleSettings', {
          settingCharacterCount: autoDisassembleSettings.size,
        });
      }

      const result = this.buildDistributeResultFromBattleRewardPlan(plan);
      const perPlayerRewardByCharacterId = new Map(
        (result.perPlayerRewards ?? []).map((reward) => [reward.characterId, reward] as const),
      );
      let totalSilver = plan.totalSilver;

      const appendCollectCount = (characterId: number, itemDefId: string, qty: number): void => {
        const collectEventMap = collectEventMapByCharacter.get(characterId) ?? new Map<string, number>();
        collectEventMap.set(itemDefId, (collectEventMap.get(itemDefId) ?? 0) + qty);
        collectEventMapByCharacter.set(characterId, collectEventMap);
      };

      const appendRewardRecord = (
        characterId: number,
        itemDefId: string,
        itemName: string,
        quantity: number,
        instanceIds: number[],
      ): void => {
        result.rewards.items.push({ itemDefId, itemName, quantity, instanceIds, receiverId: characterId });
        const playerReward = perPlayerRewardByCharacterId.get(characterId);
        if (playerReward) {
          playerReward.items.push({ itemDefId, itemName, quantity, instanceIds });
        }
      };

      const queuePendingMailItem = (
        receiverUserId: number,
        receiverCharacterId: number,
        attachItem: MailAttachItem,
      ): void => {
        const existing = pendingMailByReceiver.get(receiverCharacterId) ?? {
          userId: receiverUserId,
          items: [],
          itemByKey: new Map<string, MailAttachItem>(),
        };
        const found = existing.itemByKey.get(buildPendingMailItemMergeKey(attachItem));
        if (found) {
          found.qty += attachItem.qty;
        } else {
          const mailItem: MailAttachItem = {
            ...attachItem,
            ...(attachItem.options ? { options: { ...attachItem.options } } : {}),
          };
          existing.items.push(mailItem);
          existing.itemByKey.set(buildPendingMailItemMergeKey(mailItem), mailItem);
        }
        pendingMailByReceiver.set(receiverCharacterId, existing);
      };

      result.rewards.items = [];
      if (result.perPlayerRewards) {
        for (const playerReward of result.perPlayerRewards) {
          playerReward.items = [];
        }
      }

      for (const drop of plan.drops) {
        const receiverCharacterId = Number(drop.receiverCharacterId);
        if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) {
          console.warn(`奖励分发跳过：非法角色ID ${String(drop.receiverCharacterId)}`);
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
            fuyuan: drop.receiverFuyuan,
            ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
          };
        }

        const receiverAutoDisassemble =
          autoDisassembleSettings.get(receiverCharacterId)
          ?? normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });

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
            return itemService.createItem(drop.receiverUserId, receiverCharacterId, itemDefId, qty, {
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
          queuePendingMailItem(drop.receiverUserId, receiverCharacterId, mailItem);
        }

        if (grantResult.gainedSilver > 0) {
          totalSilver += grantResult.gainedSilver;
          result.rewards.silver += grantResult.gainedSilver;
          const playerReward = perPlayerRewardByCharacterId.get(receiverCharacterId);
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

      slowLogger.mark('grantRewardDrops', {
        grantedDropCount: result.rewards.items.length,
        pendingMailReceiverCount: pendingMailByReceiver.size,
      });

      collectEventCount = [...collectEventMapByCharacter.values()].reduce(
        (total, collectEventMap) => total + collectEventMap.size,
        0,
      );
      for (const [characterId, collectEventMap] of collectEventMapByCharacter.entries()) {
        await recordCollectItemEvents(
          characterId,
          [...collectEventMap.entries()].map(([itemId, count]) => ({
            itemId,
            count,
          })),
        );
      }
      slowLogger.mark('recordCollectItemEvents', {
        collectEventCount,
      });

      for (const [receiverCharacterId, entry] of pendingMailByReceiver.entries()) {
        const chunkSize = 10;
        for (let index = 0; index < entry.items.length; index += chunkSize) {
          const chunk = entry.items.slice(index, index + chunkSize);
          pendingMailCount += 1;
          const mailResult = await sendSystemMail(
            entry.userId,
            receiverCharacterId,
            '战斗掉落补发',
            '由于背包已满，部分战斗掉落已通过邮件补发，请前往邮箱领取。',
            { items: chunk },
            30,
          );
          if (!mailResult.success) {
            console.warn(`战斗掉落补发邮件发送失败: ${mailResult.message}`);
          }
        }
      }
      slowLogger.mark('sendPendingMail', {
        pendingMailCount,
        pendingMailReceiverCount: pendingMailByReceiver.size,
      });

      await applyCharacterRewardDeltas(pendingCharacterRewardDeltas);
      slowLogger.mark('applyCharacterRewardDeltas', {
        rewardDeltaCharacterCount: pendingCharacterRewardDeltas.size,
      });
      result.message = '奖励分发成功';
      result.rewards.silver = totalSilver;
      success = true;
      return result;
    } finally {
      slowLogger.flush({
        success,
        rewardPlayerCount: plan.perPlayerRewards.length,
        dropCount: plan.drops.length,
        collectEventCount,
        pendingMailCount,
      });
    }
  }

  async previewBattleRewards(
    monsters: MonsterData[],
    participants: BattleParticipant[],
    isVictory: boolean,
    options: DistributeBattleRewardsOptions = {},
  ): Promise<DistributeResult> {
    const plan = await this.planBattleRewards(monsters, participants, isVictory, options);
    return this.buildDistributeResultFromBattleRewardPlan(plan);
  }

  previewBattleRewardPlan(
    plan: BattleRewardSettlementPlan,
  ): DistributeResult {
    return this.buildDistributeResultFromBattleRewardPlan(plan);
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
