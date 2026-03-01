import type { PoolClient } from 'pg';
import { query, getTransactionClient } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { itemService } from '../itemService.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  ensureCharacterAchievementPoints,
  normalizeRewards,
  parseClaimedThresholds,
} from './shared.js';
import type {
  AchievementClaimTitle,
  AchievementRewardConfig,
  AchievementRewardView,
  ClaimAchievementResult,
  ClaimPointRewardResult,
  PointRewardDef,
  PointRewardListResult,
} from './types.js';
import {
  getAchievementDefinitions,
  getAchievementPointsRewardDefinitions,
  getItemDefinitionsByIds,
  getTitleDefinitions,
} from '../staticConfigLoader.js';
import { grantPermanentTitleTx } from './titleOwnership.js';

/**
 * 成就领取服务
 *
 * 作用：处理成就奖励领取与成就点数奖励领取
 * 不做：不处理成就进度更新（由 progress.ts 负责）
 *
 * 数据流：
 * - claimAchievement：锁定成就记录 → 发放奖励 → 更新状态为已领取
 * - claimAchievementPointsReward：锁定点数记录 → 发放奖励 → 更新已领取阈值列表
 *
 * 边界条件：
 * 1) 使用 @Transactional 保证奖励发放与状态更新的原子性
 * 2) 物品发放失败时抛出异常触发回滚，避免部分奖励发放成功但状态未更新
 */
class AchievementClaimService {
  private asRewardType(value: unknown): 'silver' | 'spirit_stones' | 'exp' | 'item' | null {
    const raw = asNonEmptyString(value);
    if (!raw) return null;
    if (raw === 'silver') return 'silver';
    if (raw === 'spirit_stones') return 'spirit_stones';
    if (raw === 'exp') return 'exp';
    if (raw === 'item') return 'item';
    return null;
  }

  private async loadItemMetaMap(
    itemIds: string[],
  ): Promise<Map<string, { name: string; icon: string | null }>> {
    const dedup = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
    const out = new Map<string, { name: string; icon: string | null }>();
    if (dedup.length === 0) return out;
    const defs = getItemDefinitionsByIds(dedup);
    for (const id of dedup) {
      const def = defs.get(id);
      if (!def) continue;
      out.set(id, { name: asNonEmptyString(def.name) ?? id, icon: asNonEmptyString(def.icon) });
    }
    return out;
  }

  private collectItemRewardIds(rewards: AchievementRewardConfig[]): string[] {
    const out: string[] = [];
    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const row = reward as Record<string, unknown>;
      if (this.asRewardType(row.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(row.item_def_id);
      if (itemDefId) out.push(itemDefId);
    }
    return out;
  }

  private extractClaimBusinessErrorMessage(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const message = asNonEmptyString(error.message);
    if (!message) return null;
    if (message === '背包已满' || message === '仓库已满' || message === '背包数据异常') return message;
    return null;
  }

  private async applyRewardsTx(
    userId: number,
    characterId: number,
    rewards: AchievementRewardConfig[],
    obtainedFrom: 'achievement_reward' | 'achievement_points_reward',
  ): Promise<AchievementRewardView[]> {
    const client = getTransactionClient();
    if (!client) throw new Error('applyRewardsTx 必须在事务上下文中执行');

    const itemMeta = await this.loadItemMetaMap(this.collectItemRewardIds(rewards));
    const out: AchievementRewardView[] = [];

    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const row = reward as Record<string, unknown>;
      const type = this.asRewardType(row.type);
      if (!type) continue;

      if (type === 'silver' || type === 'spirit_stones' || type === 'exp') {
        const amount = asFiniteNonNegativeInt(row.amount, 0);
        if (amount <= 0) continue;

        const field = type === 'silver' ? 'silver' : type === 'spirit_stones' ? 'spirit_stones' : 'exp';
        await query(
          `UPDATE characters SET ${field} = ${field} + $1, updated_at = NOW() WHERE id = $2`,
          [amount, characterId],
        );
        out.push({ type, amount });
        continue;
      }

      if (type === 'item') {
        const itemDefId = asNonEmptyString(row.item_def_id);
        if (!itemDefId) continue;
        const qty = Math.max(1, asFiniteNonNegativeInt(row.qty, 1));

        const created = await itemService.createItem(userId, characterId, itemDefId, qty, {
          dbClient: client,
          obtainedFrom,
        });
        if (!created.success) {
          throw new Error(created.message || '发放成就物品失败');
        }

        const meta = itemMeta.get(itemDefId);
        out.push({
          type: 'item',
          itemDefId,
          qty,
          itemName: meta?.name ?? itemDefId,
          itemIcon: meta?.icon ?? null,
        });
      }
    }

    return out;
  }

  private async getTitleInfo(titleId: string): Promise<AchievementClaimTitle | undefined> {
    const id = asNonEmptyString(titleId);
    if (!id) return undefined;
    const row = getTitleDefinitions().find((entry) => entry.id === id && entry.enabled !== false);
    if (!row) return undefined;
    return {
      id,
      name: asNonEmptyString(row.name) ?? id,
      color: asNonEmptyString(row.color),
      icon: asNonEmptyString(row.icon),
    };
  }

  private async grantTitleTx(
    characterId: number,
    titleId: string | null,
  ): Promise<AchievementClaimTitle | undefined> {
    const client = getTransactionClient();
    if (!client) throw new Error('grantTitleTx 必须在事务上下文中执行');

    const id = asNonEmptyString(titleId);
    if (!id) return undefined;
    const titleDef = getTitleDefinitions().find((entry) => entry.id === id && entry.enabled !== false);
    if (!titleDef) return undefined;
    await grantPermanentTitleTx(client, characterId, id);

    return this.getTitleInfo(id);
  }

  @Transactional
  async claimAchievement(
    userId: number,
    characterId: number,
    achievementId: string,
  ): Promise<ClaimAchievementResult> {
    const uid = asFiniteNonNegativeInt(userId, 0);
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const aid = asNonEmptyString(achievementId);
    if (!uid) return { success: false, message: '未登录' };
    if (!cid) return { success: false, message: '角色不存在' };
    if (!aid) return { success: false, message: '成就ID不能为空' };

    const lockedRes = await query(
      `
        SELECT status
        FROM character_achievement
        WHERE character_id = $1
          AND achievement_id = $2
        FOR UPDATE
      `,
      [cid, aid],
    );

    if ((lockedRes.rows ?? []).length === 0) {
      return { success: false, message: '成就不存在或未解锁' };
    }

    const achievementDef = getAchievementDefinitions().find((entry) => entry.id === aid && entry.enabled !== false);
    if (!achievementDef) {
      return { success: false, message: '成就不存在或未解锁' };
    }

    const row = lockedRes.rows[0] as Record<string, unknown>;
    const status = asNonEmptyString(row.status) ?? 'in_progress';
    if (status === 'claimed') {
      return { success: false, message: '奖励已领取' };
    }
    if (status !== 'completed') {
      return { success: false, message: '成就尚未完成' };
    }

    const rewards = normalizeRewards(achievementDef.rewards);
    const rewardViews = await this.applyRewardsTx(uid, cid, rewards, 'achievement_reward');
    const title = await this.grantTitleTx(cid, asNonEmptyString(achievementDef.title_id));

    await query(
      `
        UPDATE character_achievement
        SET status = 'claimed',
            claimed_at = NOW(),
            updated_at = NOW()
        WHERE character_id = $1
          AND achievement_id = $2
      `,
      [cid, aid],
    );

    return {
      success: true,
      message: 'ok',
      data: {
        achievementId: aid,
        rewards: rewardViews,
        ...(title ? { title } : {}),
      },
    };
  }

  private async toPointRewardDef(
    row: Record<string, unknown>,
    totalPoints: number,
    claimedThresholds: number[],
  ): Promise<PointRewardDef | null> {
    const id = asNonEmptyString(row.id);
    if (!id) return null;

    const threshold = asFiniteNonNegativeInt(row.points_threshold, -1);
    if (threshold < 0) return null;

    const rewards = normalizeRewards(row.rewards);
    const itemMeta = await this.loadItemMetaMap(this.collectItemRewardIds(rewards));
    const rewardViews: AchievementRewardView[] = [];

    for (const reward of rewards) {
      if (!reward || typeof reward !== 'object') continue;
      const entry = reward as Record<string, unknown>;
      const type = this.asRewardType(entry.type);
      if (!type) continue;
      if (type === 'item') {
        const itemDefId = asNonEmptyString(entry.item_def_id);
        if (!itemDefId) continue;
        const qty = Math.max(1, asFiniteNonNegativeInt(entry.qty, 1));
        const meta = itemMeta.get(itemDefId);
        rewardViews.push({
          type,
          itemDefId,
          qty,
          itemName: meta?.name ?? itemDefId,
          itemIcon: meta?.icon ?? null,
        });
        continue;
      }
      const amount = asFiniteNonNegativeInt(entry.amount, 0);
      if (amount <= 0) continue;
      rewardViews.push({ type, amount });
    }

    const claimed = claimedThresholds.includes(threshold);
    const titleId = asNonEmptyString(row.title_id);
    const title = titleId ? await this.getTitleInfo(titleId) : undefined;

    return {
      id,
      threshold,
      name: asNonEmptyString(row.name) ?? id,
      description: String(row.description ?? ''),
      rewards: rewardViews,
      ...(title ? { title } : {}),
      claimable: totalPoints >= threshold && !claimed,
      claimed,
    };
  }

  async getAchievementPointsRewards(characterId: number): Promise<PointRewardListResult> {
    const cid = asFiniteNonNegativeInt(characterId, 0);
    if (!cid) return { totalPoints: 0, claimedThresholds: [], rewards: [] };

    await ensureCharacterAchievementPoints(cid);

    const pointsRes = await query(
      `
      SELECT total_points, claimed_thresholds
      FROM character_achievement_points
      WHERE character_id = $1
      LIMIT 1
    `,
      [cid],
    );

    const pointRow = (pointsRes.rows?.[0] ?? {}) as Record<string, unknown>;
    const totalPoints = asFiniteNonNegativeInt(pointRow.total_points, 0);
    const claimedThresholds = parseClaimedThresholds(pointRow.claimed_thresholds);

    const rewards: PointRewardDef[] = [];
    const defs = getAchievementPointsRewardDefinitions()
      .filter((entry) => entry.enabled !== false)
      .sort((left, right) => {
        const thresholdDelta = asFiniteNonNegativeInt(left.points_threshold, 0) - asFiniteNonNegativeInt(right.points_threshold, 0);
        if (thresholdDelta !== 0) return thresholdDelta;
        const leftSortWeight = asFiniteNonNegativeInt(left.sort_weight, 0);
        const rightSortWeight = asFiniteNonNegativeInt(right.sort_weight, 0);
        if (leftSortWeight !== rightSortWeight) return rightSortWeight - leftSortWeight;
        return String(left.id || '').localeCompare(String(right.id || ''));
      });

    for (const row of defs as Array<Record<string, unknown>>) {
      const parsed = await this.toPointRewardDef(row, totalPoints, claimedThresholds);
      if (parsed) rewards.push(parsed);
    }

    return {
      totalPoints,
      claimedThresholds,
      rewards,
    };
  }

  @Transactional
  async claimAchievementPointsReward(
    userId: number,
    characterId: number,
    threshold: number,
  ): Promise<ClaimPointRewardResult> {
    const uid = asFiniteNonNegativeInt(userId, 0);
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const th = asFiniteNonNegativeInt(threshold, -1);
    if (!uid) return { success: false, message: '未登录' };
    if (!cid) return { success: false, message: '角色不存在' };
    if (th < 0) return { success: false, message: '阈值无效' };

    try {
      await ensureCharacterAchievementPoints(cid);

      const pointsRes = await query(
        `
          SELECT total_points, claimed_thresholds
          FROM character_achievement_points
          WHERE character_id = $1
          FOR UPDATE
        `,
        [cid],
      );

      const pointRow = (pointsRes.rows?.[0] ?? {}) as Record<string, unknown>;
      const totalPoints = asFiniteNonNegativeInt(pointRow.total_points, 0);
      const claimedThresholds = parseClaimedThresholds(pointRow.claimed_thresholds);

      if (claimedThresholds.includes(th)) {
        return { success: false, message: '该点数奖励已领取' };
      }

      if (totalPoints < th) {
        return { success: false, message: '成就点数不足' };
      }

      const defRow = getAchievementPointsRewardDefinitions().find(
        (entry) => entry.enabled !== false && asFiniteNonNegativeInt(entry.points_threshold, -1) === th,
      );

      if (!defRow) {
        return { success: false, message: '点数奖励不存在' };
      }

      const rewards = normalizeRewards(defRow.rewards);
      const rewardViews = await this.applyRewardsTx(uid, cid, rewards, 'achievement_points_reward');
      const title = await this.grantTitleTx(cid, asNonEmptyString(defRow.title_id));

      const nextThresholds = Array.from(new Set([...claimedThresholds, th])).sort((a, b) => a - b);

      await query(
        `
          UPDATE character_achievement_points
          SET claimed_thresholds = $2::jsonb,
              updated_at = NOW()
          WHERE character_id = $1
        `,
        [cid, JSON.stringify(nextThresholds)],
      );

      return {
        success: true,
        message: 'ok',
        data: {
          threshold: th,
          rewards: rewardViews,
          ...(title ? { title } : {}),
        },
      };
    } catch (error) {
      const businessMessage = this.extractClaimBusinessErrorMessage(error);
      if (businessMessage) {
        return { success: false, message: businessMessage };
      }
      console.error('领取成就点奖励失败:', error);
      return { success: false, message: '领取成就点奖励失败' };
    }
  }
}

export const achievementClaimService = new AchievementClaimService();

// 向后兼容的命名导出
export const claimAchievement = achievementClaimService.claimAchievement.bind(achievementClaimService);
export const getAchievementPointsRewards = achievementClaimService.getAchievementPointsRewards.bind(achievementClaimService);
export const claimAchievementPointsReward = achievementClaimService.claimAchievementPointsReward.bind(achievementClaimService);
