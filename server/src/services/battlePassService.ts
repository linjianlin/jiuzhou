import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { addItemToInventory } from './inventory/index.js';
import { lockCharacterInventoryMutex } from './inventoryMutex.js';
import {
  loadCharacterWritebackRowByCharacterId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';
import {
  getBattlePassStaticConfig,
  type BattlePassRewardEntry,
} from './staticConfigLoader.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';
import {
  getRewardCurrencyDisplayName,
  resolveRewardItemDisplayMeta,
} from './shared/rewardDisplay.js';

export type BattlePassTaskDto = {
  id: string;
  code: string;
  name: string;
  description: string;
  taskType: 'daily' | 'weekly' | 'season';
  condition: unknown;
  targetValue: number;
  rewardExp: number;
  rewardExtra: unknown[];
  enabled: boolean;
  sortWeight: number;
  progressValue: number;
  completed: boolean;
  claimed: boolean;
};

export type BattlePassTasksOverviewDto = {
  seasonId: string;
  daily: BattlePassTaskDto[];
  weekly: BattlePassTaskDto[];
  season: BattlePassTaskDto[];
};

type BattlePassTaskType = BattlePassTaskDto['taskType'];

export type CompleteBattlePassTaskResult = {
  success: boolean;
  message: string;
  data?: {
    taskId: string;
    taskType: BattlePassTaskType;
    gainedExp: number;
    exp: number;
    level: number;
    maxLevel: number;
    expPerLevel: number;
  };
};

export type BattlePassStatusDto = {
  seasonId: string;
  seasonName: string;
  exp: number;
  level: number;
  maxLevel: number;
  expPerLevel: number;
  premiumUnlocked: boolean;
  claimedFreeLevels: number[];
  claimedPremiumLevels: number[];
};

export type BattlePassRewardItemDto =
  | {
      type: 'currency';
      currency: 'spirit_stones' | 'silver';
      amount: number;
      name: string;
      icon: null;
    }
  | {
      type: 'item';
      itemDefId: string;
      qty: number;
      name: string;
      icon: string | null;
    };

export type BattlePassRewardDto = {
  level: number;
  freeRewards: BattlePassRewardItemDto[];
  premiumRewards: BattlePassRewardItemDto[];
};

export type ClaimRewardResult = {
  success: boolean;
  message: string;
  data?: {
    level: number;
    track: 'free' | 'premium';
    rewards: BattlePassRewardItemDto[];
    spiritStones?: number;
    silver?: number;
  };
};

// --- 私有辅助函数（模块级） ---

const getTaskTypeOrder = (taskType: BattlePassTaskType): number => {
  if (taskType === 'daily') return 1;
  if (taskType === 'weekly') return 2;
  return 3;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
};

const isInCurrentCycle = (taskType: BattlePassTaskType, timestamp: Date | null, now: Date): boolean => {
  if (!timestamp) return false;
  if (taskType === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return timestamp.getTime() >= start.getTime();
  }
  if (taskType === 'weekly') {
    const start = new Date(now);
    const day = start.getDay();
    const offset = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - offset);
    start.setHours(0, 0, 0, 0);
    return timestamp.getTime() >= start.getTime();
  }
  return true;
};

const toBattlePassRewardItemDto = (
  reward: BattlePassRewardEntry,
): BattlePassRewardItemDto | null => {
  if (reward.type === 'currency') {
    if (reward.currency !== 'silver' && reward.currency !== 'spirit_stones') return null;
    const amount = Number.isFinite(Number(reward.amount)) ? Math.max(0, Number(reward.amount)) : 0;
    if (amount <= 0) return null;
    return {
      type: 'currency',
      currency: reward.currency,
      amount,
      name: getRewardCurrencyDisplayName(reward.currency),
      icon: null,
    };
  }

  if (reward.type !== 'item') return null;
  const itemDefId = String(reward.item_def_id || '').trim();
  const qty = Number.isFinite(Number(reward.qty)) ? Math.max(1, Number(reward.qty)) : 1;
  if (!itemDefId) return null;
  const itemMeta = resolveRewardItemDisplayMeta(itemDefId);
  return {
    type: 'item',
    itemDefId,
    qty,
    name: itemMeta.name,
    icon: itemMeta.icon,
  };
};

const toBattlePassRewardItemDtos = (
  rewards: BattlePassRewardEntry[],
): BattlePassRewardItemDto[] => {
  return rewards
    .map((reward) => toBattlePassRewardItemDto(reward))
    .filter((reward): reward is BattlePassRewardItemDto => reward !== null);
};

const applyBattlePassCurrencyRewards = async (
  characterId: number,
  forUpdate: boolean,
  rewardEntries: BattlePassRewardEntry[],
): Promise<{ spiritStones: number; silver: number } | null> => {
  const current = await loadCharacterWritebackRowByCharacterId(characterId, { forUpdate });
  if (!current) return null;

  let nextSpiritStones = Number(current.spirit_stones ?? 0);
  let nextSilver = Number(current.silver ?? 0);
  let hasCurrencyReward = false;

  for (const reward of rewardEntries) {
    if (reward.type !== 'currency') continue;
    const amount = Math.max(0, Number(reward.amount) || 0);
    if (amount <= 0) continue;
    hasCurrencyReward = true;
    if (reward.currency === 'spirit_stones') {
      nextSpiritStones += amount;
    } else if (reward.currency === 'silver') {
      nextSilver += amount;
    }
  }

  if (hasCurrencyReward) {
    await queueCharacterWritebackSnapshot(characterId, {
      spirit_stones: nextSpiritStones,
      silver: nextSilver,
    });
  }

  return {
    spiritStones: nextSpiritStones,
    silver: nextSilver,
  };
};

const getResolvedSeasonFromStaticConfig = (seasonId?: string, now: Date = new Date()) => {
  const config = getBattlePassStaticConfig();
  if (!config || config.season.enabled === false) return null;

  if (typeof seasonId === 'string' && seasonId.trim()) {
    return config.season.id === seasonId.trim() ? config.season : null;
  }

  const startAt = new Date(config.season.start_at);
  const endAt = new Date(config.season.end_at);
  const inActiveRange = !Number.isNaN(startAt.getTime()) && !Number.isNaN(endAt.getTime())
    ? startAt.getTime() <= now.getTime() && endAt.getTime() > now.getTime()
    : false;
  return inActiveRange ? config.season : config.season;
};

const getActiveBattlePassSeasonIdImpl = async (now: Date = new Date()): Promise<string | null> => {
  const season = getResolvedSeasonFromStaticConfig(undefined, now);
  if (!season) return null;
  const startAt = new Date(season.start_at);
  const endAt = new Date(season.end_at);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return startAt.getTime() <= now.getTime() && endAt.getTime() > now.getTime() ? season.id : null;
};

const getFallbackBattlePassSeasonId = async (): Promise<string | null> => {
  return getBattlePassStaticConfig()?.season?.enabled === false ? null : getBattlePassStaticConfig()?.season?.id ?? null;
};

// --- BattlePassService 类 ---
/**
 * 战令服务
 *
 * 作用：战令赛季任务查询、完成、奖励领取等核心逻辑
 * 纯读方法不加 @Transactional，写操作方法加 @Transactional
 *
 * 边界条件：
 * 1) claimBattlePassReward 通过 @Transactional + query 自动复用事务上下文，并在发奖前获取背包互斥锁
 * 2) completeBattlePassTask 内的 FOR UPDATE 查询依赖事务上下文，由 @Transactional 保证
 */
class BattlePassService {
  // 纯读方法，不加 @Transactional
  async getCharacterIdByUserId(userId: number): Promise<number | null> {
    return getCharacterIdByUserIdShared(userId);
  }

  // 纯读方法，不加 @Transactional
  async getActiveBattlePassSeasonId(now: Date = new Date()): Promise<string | null> {
    return getActiveBattlePassSeasonIdImpl(now);
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassTasksOverview(userId: number, seasonId?: string): Promise<BattlePassTasksOverviewDto> {
    const config = getBattlePassStaticConfig();
    const resolvedSeasonId =
      (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
      (await getActiveBattlePassSeasonIdImpl()) ??
      (await getFallbackBattlePassSeasonId()) ??
      '';

    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) {
      return { seasonId: resolvedSeasonId, daily: [], weekly: [], season: [] };
    }

    if (!resolvedSeasonId) {
      return { seasonId: '', daily: [], weekly: [], season: [] };
    }

    const taskRows = (config?.tasks ?? [])
      .filter((task) => task.enabled !== false)
      .filter((task) => resolvedSeasonId === (config?.season.id ?? ''));

    const progressRes = await query(
      `
        SELECT task_id, progress_value, completed, completed_at, claimed, claimed_at, updated_at
        FROM battle_pass_task_progress
        WHERE season_id = $1 AND character_id = $2
      `,
      [resolvedSeasonId, characterId],
    );
    const progressByTaskId = new Map<string, Record<string, unknown>>();
    for (const row of progressRes.rows ?? []) {
      const taskId = String(row.task_id || '');
      if (!taskId) continue;
      progressByTaskId.set(taskId, row as Record<string, unknown>);
    }

    const now = new Date();
    const rows: BattlePassTaskDto[] = taskRows.map((task) => {
      const progress = progressByTaskId.get(task.id);
      const completedAt = toDate(progress?.completed_at);
      const claimedAt = toDate(progress?.claimed_at);
      const updatedAt = toDate(progress?.updated_at);
      const completed = progress?.completed === true && isInCurrentCycle(task.task_type, completedAt, now);
      const claimed = progress?.claimed === true && isInCurrentCycle(task.task_type, claimedAt, now);
      const rawProgressValue = Number(progress?.progress_value ?? 0);
      const normalizedRawProgress = Number.isFinite(rawProgressValue) ? Math.max(0, rawProgressValue) : 0;
      const progressValue = updatedAt && isInCurrentCycle(task.task_type, updatedAt, now) ? normalizedRawProgress : 0;
      return {
        id: task.id,
        code: task.code,
        name: task.name,
        description: String(task.description || ''),
        taskType: task.task_type,
        condition: task.condition ?? {},
        targetValue: Number.isFinite(Number(task.target_value)) ? Number(task.target_value) : 1,
        rewardExp: Number.isFinite(Number(task.reward_exp)) ? Number(task.reward_exp) : 0,
        rewardExtra: Array.isArray(task.reward_extra) ? task.reward_extra : [],
        enabled: task.enabled !== false,
        sortWeight: Number.isFinite(Number(task.sort_weight)) ? Number(task.sort_weight) : 0,
        progressValue: Number.isFinite(progressValue) ? progressValue : 0,
        completed,
        claimed,
      };
    }).sort((left, right) => {
      const typeOrder = getTaskTypeOrder(left.taskType) - getTaskTypeOrder(right.taskType);
      if (typeOrder !== 0) return typeOrder;
      if (left.sortWeight !== right.sortWeight) return right.sortWeight - left.sortWeight;
      return left.id.localeCompare(right.id);
    });

    return {
      seasonId: resolvedSeasonId,
      daily: rows.filter((x) => x.taskType === 'daily'),
      weekly: rows.filter((x) => x.taskType === 'weekly'),
      season: rows.filter((x) => x.taskType === 'season'),
    };
  }

  // 写操作方法，加 @Transactional
  @Transactional
  async completeBattlePassTask(userId: number, taskId: string): Promise<CompleteBattlePassTaskResult> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) return { success: false, message: '任务ID无效' };

    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return { success: false, message: '角色不存在' };

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

    const config = getBattlePassStaticConfig();
    const season = config?.season?.id === seasonId ? config.season : null;
    if (!season) return { success: false, message: '赛季配置不存在' };

    const task = (config?.tasks ?? []).find((entry) => entry.id === normalizedTaskId && entry.enabled !== false);
    if (!task) return { success: false, message: '任务不存在或未启用' };

    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;
    const maxExp = Math.max(0, maxLevel * expPerLevel);

    const taskType = String(task.task_type || 'daily') as BattlePassTaskType;
    if (taskType !== 'daily' && taskType !== 'weekly' && taskType !== 'season') {
      return { success: false, message: '任务类型不支持' };
    }
    const targetValue = Math.max(1, Number(task.target_value) || 1);
    const rewardExp = Math.max(0, Number(task.reward_exp) || 0);

    const taskProgressRes = await query(
      `
        SELECT progress_value, completed, completed_at, updated_at
        FROM battle_pass_task_progress
        WHERE character_id = $1
          AND season_id = $2
          AND task_id = $3
        FOR UPDATE
      `,
      [characterId, seasonId, normalizedTaskId],
    );
    const now = new Date();
    const progressRow = taskProgressRes.rows[0] as
      | { progress_value?: unknown; completed?: unknown; completed_at?: unknown; updated_at?: unknown }
      | undefined;
    const completedInCycle = progressRow?.completed === true && isInCurrentCycle(taskType, toDate(progressRow?.completed_at), now);
    if (completedInCycle) {
      return { success: false, message: '任务已完成' };
    }
    const progressInCycle = progressRow?.updated_at ? isInCurrentCycle(taskType, toDate(progressRow.updated_at), now) : false;
    const rawProgressValue = progressInCycle ? Number(progressRow?.progress_value ?? 0) : 0;
    const currentProgressValue = Number.isFinite(rawProgressValue) ? Math.max(0, rawProgressValue) : 0;
    if (currentProgressValue < targetValue) {
      return { success: false, message: '任务目标未达成，无法完成' };
    }

    await query(
      `
        INSERT INTO battle_pass_task_progress (
          character_id, season_id, task_id, progress_value, completed, completed_at, claimed, claimed_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, true, NOW(), true, NOW(), NOW(), NOW())
        ON CONFLICT (character_id, season_id, task_id)
        DO UPDATE SET
          progress_value = EXCLUDED.progress_value,
          completed = true,
          completed_at = NOW(),
          claimed = true,
          claimed_at = NOW(),
          updated_at = NOW()
      `,
      [characterId, seasonId, normalizedTaskId, targetValue],
    );

    const bpProgressRes = await query(
      `
        INSERT INTO battle_pass_progress (character_id, season_id, exp, created_at, updated_at)
        VALUES ($1, $2, LEAST($3::bigint, $4::bigint), NOW(), NOW())
        ON CONFLICT (character_id, season_id)
        DO UPDATE SET
          exp = LEAST($4::bigint, battle_pass_progress.exp + $3::bigint),
          updated_at = NOW()
        RETURNING exp
      `,
      [characterId, seasonId, rewardExp, maxExp],
    );

    const exp = Number(bpProgressRes.rows[0]?.exp ?? 0);
    const level = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);
    return {
      success: true,
      message: '任务完成',
      data: {
        taskId: normalizedTaskId,
        taskType,
        gainedExp: rewardExp,
        exp,
        level,
        maxLevel,
        expPerLevel,
      },
    };
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassStatus(userId: number): Promise<BattlePassStatusDto | null> {
    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return null;

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return null;

    const season = getBattlePassStaticConfig()?.season;
    if (!season || season.id !== seasonId) return null;
    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;

    const progressRes = await query(
      `SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2`,
      [characterId, seasonId],
    );
    const exp = Number(progressRes.rows[0]?.exp ?? 0);
    const premiumUnlocked = progressRes.rows[0]?.premium_unlocked === true;

    const claimRes = await query(
      `SELECT level, track FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2`,
      [characterId, seasonId],
    );
    const claimedFreeLevels: number[] = [];
    const claimedPremiumLevels: number[] = [];
    for (const row of claimRes.rows) {
      if (row.track === 'free') claimedFreeLevels.push(Number(row.level));
      else if (row.track === 'premium') claimedPremiumLevels.push(Number(row.level));
    }

    const level = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);

    return {
      seasonId,
      seasonName: String(season.name || ''),
      exp,
      level,
      maxLevel,
      expPerLevel,
      premiumUnlocked,
      claimedFreeLevels: claimedFreeLevels.sort((a, b) => a - b),
      claimedPremiumLevels: claimedPremiumLevels.sort((a, b) => a - b),
    };
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassRewards(seasonId?: string): Promise<BattlePassRewardDto[]> {
    const config = getBattlePassStaticConfig();
    const resolvedSeasonId =
      (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
      (await getActiveBattlePassSeasonIdImpl()) ??
      (await getFallbackBattlePassSeasonId()) ??
      '';
    if (!resolvedSeasonId) return [];

    if (!config || config.season.id !== resolvedSeasonId) return [];
    return config.rewards.map((row) => ({
      level: Number(row.level),
      freeRewards: toBattlePassRewardItemDtos(Array.isArray(row.free) ? row.free : []),
      premiumRewards: toBattlePassRewardItemDtos(Array.isArray(row.premium) ? row.premium : []),
    }));
  }

  // 写操作方法，加 @Transactional
  @Transactional
  async claimBattlePassReward(
    userId: number,
    level: number,
    track: 'free' | 'premium',
  ): Promise<ClaimRewardResult> {
    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return { success: false, message: '角色不存在' };

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

    const config = getBattlePassStaticConfig();
    const season = config?.season?.id === seasonId ? config.season : null;
    if (!season) return { success: false, message: '赛季配置不存在' };

    await lockCharacterInventoryMutex(characterId);

    // 获取赛季配置
    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;

    if (level < 1 || level > maxLevel) {
      return { success: false, message: '等级无效' };
    }

    // 获取玩家战令进度
    const progressRes = await query(
      `SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 FOR UPDATE`,
      [characterId, seasonId],
    );
    const exp = Number(progressRes.rows[0]?.exp ?? 0);
    const premiumUnlocked = progressRes.rows[0]?.premium_unlocked === true;
    const currentLevel = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);

    if (level > currentLevel) {
      return { success: false, message: '等级未解锁' };
    }

    if (track === 'premium' && !premiumUnlocked) {
      return { success: false, message: '未解锁特权通行证' };
    }
    // 检查是否已领取
    const claimCheck = await query(
      `SELECT 1 FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2 AND level = $3 AND track = $4`,
      [characterId, seasonId, level, track],
    );
    if (claimCheck.rows.length > 0) {
      return { success: false, message: '该等级奖励已领取' };
    }

    // 获取奖励配置
    const rewardRow = (config?.rewards ?? []).find((entry) => Number(entry.level) === level);
    if (!rewardRow) {
      return { success: false, message: '奖励配置不存在' };
    }

    const rewardEntries: BattlePassRewardEntry[] =
      track === 'free'
        ? (Array.isArray(rewardRow.free) ? rewardRow.free : [])
        : (Array.isArray(rewardRow.premium) ? rewardRow.premium : []);
    const rewards = toBattlePassRewardItemDtos(rewardEntries);

    // 发放奖励

    for (const reward of rewardEntries) {
      if (reward.type === 'item') {
        const itemDefId = reward.item_def_id;
        const qty = Number(reward.qty) || 1;
        if (itemDefId && qty > 0) {
          const addResult = await addItemToInventory(characterId, userId, itemDefId, qty, {
            location: 'bag',
            obtainedFrom: 'battle_pass',
          });
          if (!addResult.success) {
            return { success: false, message: addResult.message || '添加物品失败' };
          }
        }
      }
    }
    // 记录领取
    await query(
      `INSERT INTO battle_pass_claim_record (character_id, season_id, level, track, claimed_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [characterId, seasonId, level, track],
    );

    const currencyState = await applyBattlePassCurrencyRewards(characterId, true, rewardEntries);
    if (!currencyState) {
      return { success: false, message: '角色不存在' };
    }
    return {
      success: true,
      message: '领取成功',
      data: {
        level,
        track,
        rewards,
        spiritStones: currencyState.spiritStones,
        silver: currencyState.silver,
      },
    };
  }
}

export const battlePassService = new BattlePassService();
