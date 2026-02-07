import type { PoolClient } from 'pg';
import { pool, query } from '../../config/database.js';
import { createItem } from '../itemService.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  ensureCharacterAchievementPoints,
  normalizeRewards,
  parseClaimedThresholds,
  parseJsonObject,
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

const asRewardType = (value: unknown): 'silver' | 'spirit_stones' | 'exp' | 'item' | null => {
  const raw = asNonEmptyString(value);
  if (!raw) return null;
  if (raw === 'silver') return 'silver';
  if (raw === 'spirit_stones') return 'spirit_stones';
  if (raw === 'exp') return 'exp';
  if (raw === 'item') return 'item';
  return null;
};

const loadItemMetaMap = async (
  itemIds: string[],
  client?: PoolClient,
): Promise<Map<string, { name: string; icon: string | null }>> => {
  const dedup = Array.from(new Set(itemIds.map((id) => id.trim()).filter(Boolean)));
  const out = new Map<string, { name: string; icon: string | null }>();
  if (dedup.length === 0) return out;
  const runner = client ?? { query };
  const res = await runner.query(`SELECT id, name, icon FROM item_def WHERE id = ANY($1::varchar[])`, [dedup]);
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const id = asNonEmptyString(row.id);
    if (!id) continue;
    out.set(id, { name: asNonEmptyString(row.name) ?? id, icon: asNonEmptyString(row.icon) });
  }
  return out;
};

const collectItemRewardIds = (rewards: AchievementRewardConfig[]): string[] => {
  const out: string[] = [];
  for (const reward of rewards) {
    if (!reward || typeof reward !== 'object') continue;
    const row = reward as Record<string, unknown>;
    if (asRewardType(row.type) !== 'item') continue;
    const itemDefId = asNonEmptyString(row.item_def_id);
    if (itemDefId) out.push(itemDefId);
  }
  return out;
};

const applyRewardsTx = async (
  client: PoolClient,
  userId: number,
  characterId: number,
  rewards: AchievementRewardConfig[],
  obtainedFrom: 'achievement_reward' | 'achievement_points_reward',
): Promise<AchievementRewardView[]> => {
  const itemMeta = await loadItemMetaMap(collectItemRewardIds(rewards), client);
  const out: AchievementRewardView[] = [];

  for (const reward of rewards) {
    if (!reward || typeof reward !== 'object') continue;
    const row = reward as Record<string, unknown>;
    const type = asRewardType(row.type);
    if (!type) continue;

    if (type === 'silver' || type === 'spirit_stones' || type === 'exp') {
      const amount = asFiniteNonNegativeInt(row.amount, 0);
      if (amount <= 0) continue;

      const field = type === 'silver' ? 'silver' : type === 'spirit_stones' ? 'spirit_stones' : 'exp';
      await client.query(
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

      const created = await createItem(userId, characterId, itemDefId, qty, {
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
};

const getTitleInfo = async (titleId: string, client?: PoolClient): Promise<AchievementClaimTitle | undefined> => {
  const id = asNonEmptyString(titleId);
  if (!id) return undefined;
  const runner = client ?? { query };
  const res = await runner.query(
    `
      SELECT id, name, rarity, color, icon
      FROM title_def
      WHERE id = $1
        AND enabled = true
      LIMIT 1
    `,
    [id],
  );
  if ((res.rows ?? []).length === 0) return undefined;
  const row = res.rows[0] as Record<string, unknown>;
  return {
    id,
    name: asNonEmptyString(row.name) ?? id,
    rarity: asNonEmptyString(row.rarity) ?? 'common',
    color: asNonEmptyString(row.color),
    icon: asNonEmptyString(row.icon),
  };
};

const grantTitleTx = async (
  client: PoolClient,
  characterId: number,
  titleId: string | null,
): Promise<AchievementClaimTitle | undefined> => {
  const id = asNonEmptyString(titleId);
  if (!id) return undefined;

  const existsRes = await client.query(`SELECT id FROM title_def WHERE id = $1 AND enabled = true LIMIT 1`, [id]);
  if ((existsRes.rows ?? []).length === 0) return undefined;

  await client.query(
    `
      INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, updated_at)
      VALUES ($1, $2, false, NOW(), NOW())
      ON CONFLICT (character_id, title_id)
      DO UPDATE SET updated_at = NOW()
    `,
    [characterId, id],
  );

  return getTitleInfo(id, client);
};

export const claimAchievement = async (
  userId: number,
  characterId: number,
  achievementId: string,
): Promise<ClaimAchievementResult> => {
  const uid = asFiniteNonNegativeInt(userId, 0);
  const cid = asFiniteNonNegativeInt(characterId, 0);
  const aid = asNonEmptyString(achievementId);
  if (!uid) return { success: false, message: '未登录' };
  if (!cid) return { success: false, message: '角色不存在' };
  if (!aid) return { success: false, message: '成就ID不能为空' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockedRes = await client.query(
      `
        SELECT
          ca.status,
          ad.rewards,
          ad.title_id
        FROM character_achievement ca
        JOIN achievement_def ad ON ad.id = ca.achievement_id
        WHERE ca.character_id = $1
          AND ca.achievement_id = $2
          AND ad.enabled = true
        FOR UPDATE
      `,
      [cid, aid],
    );

    if ((lockedRes.rows ?? []).length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '成就不存在或未解锁' };
    }

    const row = lockedRes.rows[0] as Record<string, unknown>;
    const status = asNonEmptyString(row.status) ?? 'in_progress';
    if (status === 'claimed') {
      await client.query('ROLLBACK');
      return { success: false, message: '奖励已领取' };
    }
    if (status !== 'completed') {
      await client.query('ROLLBACK');
      return { success: false, message: '成就尚未完成' };
    }

    const rewards = normalizeRewards(row.rewards);
    const rewardViews = await applyRewardsTx(client, uid, cid, rewards, 'achievement_reward');
    const title = await grantTitleTx(client, cid, asNonEmptyString(row.title_id));

    await client.query(
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

    await client.query('COMMIT');
    return {
      success: true,
      message: 'ok',
      data: {
        achievementId: aid,
        rewards: rewardViews,
        ...(title ? { title } : {}),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('领取成就奖励失败:', error);
    return { success: false, message: '领取成就奖励失败' };
  } finally {
    client.release();
  }
};

const toPointRewardDef = async (
  row: Record<string, unknown>,
  totalPoints: number,
  claimedThresholds: number[],
): Promise<PointRewardDef | null> => {
  const id = asNonEmptyString(row.id);
  if (!id) return null;

  const threshold = asFiniteNonNegativeInt(row.points_threshold, -1);
  if (threshold < 0) return null;

  const rewards = normalizeRewards(row.rewards);
  const itemMeta = await loadItemMetaMap(collectItemRewardIds(rewards));
  const rewardViews: AchievementRewardView[] = [];

  for (const reward of rewards) {
    if (!reward || typeof reward !== 'object') continue;
    const entry = reward as Record<string, unknown>;
    const type = asRewardType(entry.type);
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
  const title = titleId ? await getTitleInfo(titleId) : undefined;

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
};

export const getAchievementPointsRewards = async (characterId: number): Promise<PointRewardListResult> => {
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

  const defRes = await query(
    `
      SELECT id, points_threshold, name, description, rewards, title_id
      FROM achievement_points_reward_def
      WHERE enabled = true
      ORDER BY points_threshold ASC, sort_weight DESC, id ASC
    `,
  );

  const rewards: PointRewardDef[] = [];
  for (const row of defRes.rows as Array<Record<string, unknown>>) {
    const parsed = await toPointRewardDef(row, totalPoints, claimedThresholds);
    if (parsed) rewards.push(parsed);
  }

  return {
    totalPoints,
    claimedThresholds,
    rewards,
  };
};

export const claimAchievementPointsReward = async (
  userId: number,
  characterId: number,
  threshold: number,
): Promise<ClaimPointRewardResult> => {
  const uid = asFiniteNonNegativeInt(userId, 0);
  const cid = asFiniteNonNegativeInt(characterId, 0);
  const th = asFiniteNonNegativeInt(threshold, -1);
  if (!uid) return { success: false, message: '未登录' };
  if (!cid) return { success: false, message: '角色不存在' };
  if (th < 0) return { success: false, message: '阈值无效' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await ensureCharacterAchievementPoints(cid, client);

    const pointsRes = await client.query(
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
      await client.query('ROLLBACK');
      return { success: false, message: '该点数奖励已领取' };
    }

    if (totalPoints < th) {
      await client.query('ROLLBACK');
      return { success: false, message: '成就点数不足' };
    }

    const defRes = await client.query(
      `
        SELECT rewards, title_id
        FROM achievement_points_reward_def
        WHERE enabled = true
          AND points_threshold = $1
        LIMIT 1
        FOR UPDATE
      `,
      [th],
    );

    if ((defRes.rows ?? []).length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '点数奖励不存在' };
    }

    const defRow = defRes.rows[0] as Record<string, unknown>;
    const rewards = normalizeRewards(defRow.rewards);
    const rewardViews = await applyRewardsTx(client, uid, cid, rewards, 'achievement_points_reward');
    const title = await grantTitleTx(client, cid, asNonEmptyString(defRow.title_id));

    const nextThresholds = Array.from(new Set([...claimedThresholds, th])).sort((a, b) => a - b);

    await client.query(
      `
        UPDATE character_achievement_points
        SET claimed_thresholds = $2::jsonb,
            updated_at = NOW()
        WHERE character_id = $1
      `,
      [cid, JSON.stringify(nextThresholds)],
    );

    await client.query('COMMIT');
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
    await client.query('ROLLBACK');
    console.error('领取成就点奖励失败:', error);
    return { success: false, message: '领取成就点奖励失败' };
  } finally {
    client.release();
  }
};

export const normalizeTitleEffectsForApi = (effects: unknown): Record<string, number> => {
  const source = parseJsonObject<Record<string, unknown>>(effects);
  const flat = parseJsonObject<Record<string, unknown>>(source.flat);
  const input = Object.keys(flat).length > 0 ? flat : source;
  const out: Record<string, number> = {};

  for (const [key, value] of Object.entries(input)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const v = Math.floor(n);
    if (v === 0) continue;
    out[key] = v;
  }
  return out;
};
