import { query, pool, withTransaction } from '../config/database.js';
import { addItemToInventoryTx } from './inventory/index.js';
import { lockCharacterInventoryMutexTx } from './inventoryMutex.js';
import { getBattlePassStaticConfig } from './staticConfigLoader.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';

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

export const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  return getCharacterIdByUserIdShared(userId);
};

export const getActiveBattlePassSeasonId = async (now: Date = new Date()): Promise<string | null> => {
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

export const getBattlePassTasksOverview = async (userId: number, seasonId?: string): Promise<BattlePassTasksOverviewDto> => {
  const config = getBattlePassStaticConfig();
  const resolvedSeasonId =
    (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
    (await getActiveBattlePassSeasonId()) ??
    (await getFallbackBattlePassSeasonId()) ??
    '';

  const characterId = await getCharacterIdByUserId(userId);
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
};

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

export const completeBattlePassTask = async (userId: number, taskId: string): Promise<CompleteBattlePassTaskResult> => {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) return { success: false, message: '任务ID无效' };

  const characterId = await getCharacterIdByUserId(userId);
  if (!characterId) return { success: false, message: '角色不存在' };

  const seasonId = (await getActiveBattlePassSeasonId()) ?? (await getFallbackBattlePassSeasonId());
  if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

  const config = getBattlePassStaticConfig();
  const season = config?.season?.id === seasonId ? config.season : null;
  if (!season) return { success: false, message: '赛季配置不存在' };

  const task = (config?.tasks ?? []).find((entry) => entry.id === normalizedTaskId && entry.enabled !== false);
  if (!task) return { success: false, message: '任务不存在或未启用' };

  try {
    return await withTransaction(async (client) => {
  const maxLevel = Number(season.max_level) || 30;
      const expPerLevel = Number(season.exp_per_level) || 1000;
      const maxExp = Math.max(0, maxLevel * expPerLevel);
  
      const taskType = String(task.task_type || 'daily') as BattlePassTaskType;
      if (taskType !== 'daily' && taskType !== 'weekly' && taskType !== 'season') {
        await client.query('ROLLBACK');
        return { success: false, message: '任务类型不支持' };
      }
      const targetValue = Math.max(1, Number(task.target_value) || 1);
      const rewardExp = Math.max(0, Number(task.reward_exp) || 0);
  
      const taskProgressRes = await client.query(
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
        await client.query('ROLLBACK');
        return { success: false, message: '任务已完成' };
      }
      const progressInCycle = progressRow?.updated_at ? isInCurrentCycle(taskType, toDate(progressRow.updated_at), now) : false;
      const rawProgressValue = progressInCycle ? Number(progressRow?.progress_value ?? 0) : 0;
      const currentProgressValue = Number.isFinite(rawProgressValue) ? Math.max(0, rawProgressValue) : 0;
      if (currentProgressValue < targetValue) {
        await client.query('ROLLBACK');
        return { success: false, message: '任务目标未达成，无法完成' };
      }
  
      await client.query(
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
  
      const bpProgressRes = await client.query(
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
    });
  } catch (error) {
console.error('完成战令任务失败:', error);
    return { success: false, message: '服务器错误' };
  }
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

export const getBattlePassStatus = async (userId: number): Promise<BattlePassStatusDto | null> => {
  const characterId = await getCharacterIdByUserId(userId);
  if (!characterId) return null;

  const seasonId = (await getActiveBattlePassSeasonId()) ?? (await getFallbackBattlePassSeasonId());
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
};

export type BattlePassRewardDto = {
  level: number;
  freeRewards: Array<{ type: string; currency?: string; amount?: number; itemDefId?: string; qty?: number }>;
  premiumRewards: Array<{ type: string; currency?: string; amount?: number; itemDefId?: string; qty?: number }>;
};

export const getBattlePassRewards = async (seasonId?: string): Promise<BattlePassRewardDto[]> => {
  const config = getBattlePassStaticConfig();
  const resolvedSeasonId =
    (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
    (await getActiveBattlePassSeasonId()) ??
    (await getFallbackBattlePassSeasonId()) ??
    '';
  if (!resolvedSeasonId) return [];

  if (!config || config.season.id !== resolvedSeasonId) return [];
  return config.rewards.map((row) => ({
    level: Number(row.level),
    freeRewards: Array.isArray(row.free) ? row.free : [],
    premiumRewards: Array.isArray(row.premium) ? row.premium : [],
  }));
};

export type ClaimRewardResult = {
  success: boolean;
  message: string;
  data?: {
    level: number;
    track: 'free' | 'premium';
    rewards: Array<{ type: string; currency?: string; amount?: number; itemDefId?: string; qty?: number }>;
    spiritStones?: number;
    silver?: number;
  };
};

export const claimBattlePassReward = async (
  userId: number,
  level: number,
  track: 'free' | 'premium',
): Promise<ClaimRewardResult> => {
  const characterId = await getCharacterIdByUserId(userId);
  if (!characterId) return { success: false, message: '角色不存在' };

  const seasonId = (await getActiveBattlePassSeasonId()) ?? (await getFallbackBattlePassSeasonId());
  if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

  const config = getBattlePassStaticConfig();
  const season = config?.season?.id === seasonId ? config.season : null;
  if (!season) return { success: false, message: '赛季配置不存在' };

  try {
    return await withTransaction(async (client) => {
  await lockCharacterInventoryMutexTx(client, characterId);
  
      // 获取赛季配置
      const maxLevel = Number(season.max_level) || 30;
      const expPerLevel = Number(season.exp_per_level) || 1000;
  
      if (level < 1 || level > maxLevel) {
        await client.query('ROLLBACK');
        return { success: false, message: '等级无效' };
      }
  
      // 获取玩家战令进度
      const progressRes = await client.query(
        `SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 FOR UPDATE`,
        [characterId, seasonId],
      );
      const exp = Number(progressRes.rows[0]?.exp ?? 0);
      const premiumUnlocked = progressRes.rows[0]?.premium_unlocked === true;
      const currentLevel = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);
  
      if (level > currentLevel) {
        await client.query('ROLLBACK');
        return { success: false, message: '等级未解锁' };
      }
  
      if (track === 'premium' && !premiumUnlocked) {
        await client.query('ROLLBACK');
        return { success: false, message: '未解锁特权通行证' };
      }
  
      // 检查是否已领取
      const claimCheck = await client.query(
        `SELECT 1 FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2 AND level = $3 AND track = $4`,
        [characterId, seasonId, level, track],
      );
      if (claimCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return { success: false, message: '该等级奖励已领取' };
      }
  
      // 获取奖励配置
      const rewardRow = (config?.rewards ?? []).find((entry) => Number(entry.level) === level);
      if (!rewardRow) {
        await client.query('ROLLBACK');
        return { success: false, message: '奖励配置不存在' };
      }
  
      const rewards: Array<{ type: string; currency?: string; amount?: number; itemDefId?: string; item_def_id?: string; qty?: number }> =
        track === 'free'
          ? (Array.isArray(rewardRow.free) ? rewardRow.free : [])
          : (Array.isArray(rewardRow.premium) ? rewardRow.premium : []);
  
      // 发放奖励
      let spiritStonesGained = 0;
      let silverGained = 0;
  
      for (const reward of rewards) {
        if (reward.type === 'currency') {
          const amount = Number(reward.amount) || 0;
          if (reward.currency === 'spirit_stones' && amount > 0) {
            await client.query(
              `UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2`,
              [amount, characterId],
            );
            spiritStonesGained += amount;
          } else if (reward.currency === 'silver' && amount > 0) {
            await client.query(
              `UPDATE characters SET silver = silver + $1, updated_at = NOW() WHERE id = $2`,
              [amount, characterId],
            );
            silverGained += amount;
          }
        } else if (reward.type === 'item') {
          const itemDefId = reward.itemDefId ?? reward.item_def_id;
          const qty = Number(reward.qty) || 1;
          if (itemDefId && qty > 0) {
            const addResult = await addItemToInventoryTx(client, characterId, userId, itemDefId, qty, {
              location: 'bag',
              obtainedFrom: 'battle_pass',
            });
            if (!addResult.success) {
              await client.query('ROLLBACK');
              return { success: false, message: addResult.message || '添加物品失败' };
            }
          }
        }
      }
  
      // 记录领取
      await client.query(
        `INSERT INTO battle_pass_claim_record (character_id, season_id, level, track, claimed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [characterId, seasonId, level, track],
      );
  
      // 获取更新后的灵石和银两数量
      const charRes = await client.query(
        `SELECT spirit_stones, silver FROM characters WHERE id = $1`,
        [characterId],
      );
  return {
        success: true,
        message: '领取成功',
        data: {
          level,
          track,
          rewards,
          spiritStones: Number(charRes.rows[0]?.spirit_stones ?? 0),
          silver: Number(charRes.rows[0]?.silver ?? 0),
        },
      };
    });
  } catch (error) {
console.error('领取战令奖励失败:', error);
    return { success: false, message: '服务器错误' };
  }
};
