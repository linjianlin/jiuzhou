import { query, getTransactionClient } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  buildTrackKeyCandidates,
  ensureCharacterAchievementPoints,
  getPointColumnForCategory,
  normalizeAchievementStatus,
  parseAchievementDefRow,
  parseCharacterAchievementRow,
  parseJsonObject,
} from './shared.js';
import type { AchievementDefRow } from './types.js';
import { getAchievementDefinitions } from '../staticConfigLoader.js';

/**
 * 成就进度更新服务
 *
 * 作用：处理成就进度追踪与自动完成检测
 * 不做：不处理奖励领取（由 claim.ts 负责）
 *
 * 数据流：
 * - updateAchievementProgress：根据 trackKey 匹配成就定义 → 锁定进度记录 → 更新进度 → 检测完成条件 → 更新点数
 *
 * 边界条件：
 * 1) 使用 @Transactional 保证进度更新与点数增加的原子性
 * 2) 支持嵌套调用（被其他服务在事务中调用时复用同一事务）
 */
class AchievementProgressService {
  private normalizeIncrement(value: number): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
  }

  private trackPatternMatches(pattern: string, actual: string): boolean {
    const p = pattern.trim();
    const a = actual.trim();
    if (!p || !a) return false;
    if (p === '*' || p === a) return true;

    const pParts = p.split(':');
    const aParts = a.split(':');
    if (pParts.length !== aParts.length) return false;

    for (let i = 0; i < pParts.length; i += 1) {
      if (pParts[i] === '*') continue;
      if (pParts[i] !== aParts[i]) return false;
    }

    return true;
  }

  private extractMultiTargetKeys(achievement: AchievementDefRow): string[] {
    const out = new Set<string>();
    for (const item of achievement.target_list) {
      if (typeof item === 'string') {
        const key = item.trim();
        if (key) out.add(key);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const key = asNonEmptyString(record.key) ?? asNonEmptyString(record.track_key) ?? asNonEmptyString(record.trackKey);
      if (key) out.add(key);
    }
    return Array.from(out);
  }

  private mergeProgressForMulti(
    baseProgressData: Record<string, number | boolean | string>,
    targetKeys: string[],
    trackKey: string,
  ): { nextProgressData: Record<string, number | boolean | string>; nextProgress: number; changed: boolean } {
    if (targetKeys.length === 0) {
      return { nextProgressData: baseProgressData, nextProgress: 0, changed: false };
    }

    const next = { ...baseProgressData };
    let changed = false;

    for (const targetKey of targetKeys) {
      if (!this.trackPatternMatches(targetKey, trackKey)) continue;
      if (next[targetKey] === true || next[targetKey] === 1) continue;
      next[targetKey] = true;
      changed = true;
    }

    let completed = 0;
    for (const targetKey of targetKeys) {
      if (next[targetKey] === true || next[targetKey] === 1) completed += 1;
    }

    return { nextProgressData: next, nextProgress: completed, changed };
  }

  private isPrerequisiteSatisfied(
    prerequisiteId: string | null,
    statusByAchievement: Map<string, 'in_progress' | 'completed' | 'claimed'>,
  ): boolean {
    if (!prerequisiteId) return true;
    const status = statusByAchievement.get(prerequisiteId);
    return status === 'completed' || status === 'claimed';
  }

  private async applyPointsDeltaTx(
    characterId: number,
    categoryToPoints: Map<string, number>,
    totalAdd: number,
  ): Promise<void> {
    if (totalAdd <= 0) return;
    const combat = categoryToPoints.get('combat') ?? 0;
    const cultivation = categoryToPoints.get('cultivation') ?? 0;
    const exploration = categoryToPoints.get('exploration') ?? 0;
    const social = categoryToPoints.get('social') ?? 0;
    const collection = categoryToPoints.get('collection') ?? 0;

    await query(
      `
      UPDATE character_achievement_points
      SET total_points = total_points + $2,
          combat_points = combat_points + $3,
          cultivation_points = cultivation_points + $4,
          exploration_points = exploration_points + $5,
          social_points = social_points + $6,
          collection_points = collection_points + $7,
          updated_at = NOW()
      WHERE character_id = $1
    `,
      [characterId, totalAdd, combat, cultivation, exploration, social, collection],
    );
  }

  @Transactional
  async updateAchievementProgress(
    characterId: number,
    trackKey: string,
    increment = 1,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    const cid = asFiniteNonNegativeInt(characterId, 0);
    const key = asNonEmptyString(trackKey);
    if (!cid || !key) return;

    const candidates = buildTrackKeyCandidates(key);
    if (candidates.length === 0) return;

    await ensureCharacterAchievementPoints(cid);

    const defs = getAchievementDefinitions()
      .filter((row) => candidates.includes(String(row.track_key ?? '')))
      .filter((row) => row.enabled !== false)
      .map(parseAchievementDefRow)
      .filter((row): row is AchievementDefRow => row !== null);

    if (defs.length === 0) {
      return;
    }

    const achievementIds = defs.map((d) => d.id);

    const progressRes = await query(
      `
        SELECT *
        FROM character_achievement
        WHERE character_id = $1
          AND achievement_id = ANY($2::varchar[])
        FOR UPDATE
      `,
      [cid, achievementIds],
    );

    const progressById = new Map(
      (progressRes.rows as Array<Record<string, unknown>>)
        .map(parseCharacterAchievementRow)
        .filter((row): row is NonNullable<ReturnType<typeof parseCharacterAchievementRow>> => row !== null)
        .map((row) => [row.achievement_id, row]),
    );

    const missingIds = achievementIds.filter((id) => !progressById.has(id));
    if (missingIds.length > 0) {
      await query(
        `
          INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)
          SELECT $1, x.achievement_id, 'in_progress', 0, '{}'::jsonb
          FROM unnest($2::varchar[]) AS x(achievement_id)
          ON CONFLICT (character_id, achievement_id) DO NOTHING
        `,
        [cid, missingIds],
      );

      const createdRes = await query(
        `
          SELECT *
          FROM character_achievement
          WHERE character_id = $1
            AND achievement_id = ANY($2::varchar[])
          FOR UPDATE
        `,
        [cid, missingIds],
      );

      for (const row of createdRes.rows as Array<Record<string, unknown>>) {
        const parsed = parseCharacterAchievementRow(row);
        if (parsed) progressById.set(parsed.achievement_id, parsed);
      }
    }

    const prereqIds = defs.map((d) => d.prerequisite_id).filter((id): id is string => !!id);
    const prereqStatus = new Map<string, 'in_progress' | 'completed' | 'claimed'>();
    if (prereqIds.length > 0) {
      const prereqRes = await query(
        `
          SELECT achievement_id, status
          FROM character_achievement
          WHERE character_id = $1
            AND achievement_id = ANY($2::varchar[])
        `,
        [cid, prereqIds],
      );
      for (const row of prereqRes.rows as Array<Record<string, unknown>>) {
        const aid = asNonEmptyString(row.achievement_id);
        if (!aid) continue;
        prereqStatus.set(aid, normalizeAchievementStatus(row.status));
      }
    }

    const categoryToPoints = new Map<string, number>();
    let totalPointsToAdd = 0;
    const delta = this.normalizeIncrement(increment);

    for (const def of defs) {
      const row = progressById.get(def.id);
      if (!row) continue;
      if (!this.isPrerequisiteSatisfied(def.prerequisite_id, prereqStatus)) continue;
      if (row.status === 'completed' || row.status === 'claimed') continue;

      let nextProgress = row.progress;
      let nextProgressData = parseJsonObject<Record<string, number | boolean | string>>(row.progress_data);
      let changed = false;

      if (def.track_type === 'counter') {
        const target = Math.max(1, def.target_value);
        const current = Math.max(0, row.progress);
        const next = Math.min(target, current + delta);
        if (next !== current) {
          nextProgress = next;
          changed = true;
        }
      } else if (def.track_type === 'flag') {
        const target = Math.max(1, def.target_value);
        if (row.progress < target) {
          nextProgress = target;
          changed = true;
        }
      } else {
        const targetKeys = this.extractMultiTargetKeys(def);
        const merged = this.mergeProgressForMulti(nextProgressData, targetKeys, key);
        nextProgressData = merged.nextProgressData;
        nextProgress = merged.nextProgress;
        changed = merged.changed;

        if (targetKeys.length === 0) {
          const target = Math.max(1, def.target_value);
          const current = Math.max(0, row.progress);
          const next = Math.min(target, current + delta);
          if (next !== current) {
            nextProgress = next;
            changed = true;
          }
        }
      }

      if (!changed) continue;

      const target = def.track_type === 'multi'
        ? (() => {
            const keys = this.extractMultiTargetKeys(def);
            return keys.length > 0 ? keys.length : Math.max(1, def.target_value);
          })()
        : Math.max(1, def.target_value);

      const done = nextProgress >= target;
      const nextStatus = done ? 'completed' : 'in_progress';

      await query(
        `
          UPDATE character_achievement
          SET status = $4::varchar(32),
              progress = $3,
              progress_data = $5::jsonb,
              completed_at = CASE
                WHEN $4::varchar(32) = 'completed'::varchar(32) THEN COALESCE(completed_at, NOW())
                ELSE completed_at
              END,
              updated_at = NOW()
          WHERE character_id = $1
            AND achievement_id = $2
        `,
        [cid, def.id, nextProgress, nextStatus, JSON.stringify(nextProgressData)],
      );

      if (nextStatus === 'completed') {
        totalPointsToAdd += Math.max(0, def.points);
        const bucket = getPointColumnForCategory(def.category);
        if (bucket) {
          categoryToPoints.set(bucket, (categoryToPoints.get(bucket) ?? 0) + Math.max(0, def.points));
        }
        prereqStatus.set(def.id, 'completed');
      }
    }

    await this.applyPointsDeltaTx(cid, categoryToPoints, totalPointsToAdd);
  }
}

export const achievementProgressService = new AchievementProgressService();

// 向后兼容的命名导出
export const updateAchievementProgress = achievementProgressService.updateAchievementProgress.bind(achievementProgressService);
