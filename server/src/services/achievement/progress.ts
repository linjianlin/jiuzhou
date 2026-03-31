import { afterTransactionCommit, query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import {
  asFiniteNonNegativeInt,
  asNonEmptyString,
  buildTrackKeyCandidates,
  getPointColumnForCategory,
  parseAchievementDefRow,
  parseCharacterAchievementRow,
  parseJsonObject,
} from './shared.js';
import type { AchievementDefRow, AchievementStatus } from './types.js';
import { getAchievementDefinitions } from '../staticConfigLoader.js';
import { notifyAchievementUpdate } from '../achievementPush.js';

type AchievementProgressBatchInput = {
  characterId: number;
  trackKey: string;
  increment?: number;
};

type NormalizedAchievementProgressBatchInput = {
  characterId: number;
  trackKey: string;
  increment: number;
  candidates: string[];
};

type ParsedCharacterAchievementRow = NonNullable<ReturnType<typeof parseCharacterAchievementRow>>;

type AchievementContribution = {
  characterId: number;
  achievementId: string;
  matchedTrackKeys: Set<string>;
  totalDelta: number;
};

type AchievementProgressSeedRow = {
  character_id: number;
  achievement_id: string;
};

type AchievementProgressMutationRow = {
  character_id: number;
  achievement_id: string;
  status: AchievementStatus;
  progress: number;
  progress_data: Record<string, number | boolean | string>;
  completed_now: boolean;
};

type AchievementPointsDeltaRow = {
  character_id: number;
  total_points: number;
  combat_points: number;
  cultivation_points: number;
  exploration_points: number;
  social_points: number;
  collection_points: number;
};

/**
 * 成就进度更新服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把成就事件推进收敛为“批量归并 -> 批量锁定 -> 批量写回”的单一入口，避免热点链路在循环里逐条写 SQL。
 * 2. 做什么：统一处理通配 trackKey 命中、`multi` 去重、前置成就判定、点数累加与推送通知。
 * 3. 不做什么：不处理奖励领取，不负责称号发放，也不把静态成就定义写回数据库。
 *
 * 输入/输出：
 * - 输入：单条 `updateAchievementProgress` 或批量 `updateAchievementProgressBatch` 的角色事件。
 * - 输出：无；副作用是更新 `character_achievement` / `character_achievement_points`，并在事务提交后推送成就状态更新。
 *
 * 数据流/状态流：
 * 事件列表 -> 按角色与 trackKey 归并 -> 匹配静态成就定义 -> 批量补齐/锁定进度 -> 内存计算新状态 -> 批量写回 -> 事务后推送。
 *
 * 关键边界条件与坑点：
 * 1. 同一批次里如果前置成就先完成，后续依赖它的成就必须能在同一事务内继续推进，所以这里按“多轮内存结算”处理依赖链，而不是依赖配置顺序碰运气。
 * 2. `multi` 成就既要保留现有去重语义，又不能在高频路径反复打库，因此只允许把命中的 trackKey 先归并，再一次性合并进 `progress_data`。
 */
class AchievementProgressService {
  private normalizeIncrement(value: number): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 1;
    return n;
  }

  private buildProgressPairKey(characterId: number, achievementId: string): string {
    return `${characterId}:${achievementId}`;
  }

  private buildTrackAggregateKey(characterId: number, trackKey: string): string {
    return `${characterId}:${trackKey}`;
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
    trackKeys: Iterable<string>,
  ): { nextProgressData: Record<string, number | boolean | string>; nextProgress: number; changed: boolean } {
    if (targetKeys.length === 0) {
      return { nextProgressData: baseProgressData, nextProgress: 0, changed: false };
    }

    const next = { ...baseProgressData };
    let changed = false;

    for (const trackKey of trackKeys) {
      for (const targetKey of targetKeys) {
        if (!this.trackPatternMatches(targetKey, trackKey)) continue;
        if (next[targetKey] === true || next[targetKey] === 1) continue;
        next[targetKey] = true;
        changed = true;
      }
    }

    let completed = 0;
    for (const targetKey of targetKeys) {
      if (next[targetKey] === true || next[targetKey] === 1) completed += 1;
    }

    return { nextProgressData: next, nextProgress: completed, changed };
  }

  private getAchievementTarget(def: AchievementDefRow): number {
    if (def.track_type !== 'multi') {
      return Math.max(1, def.target_value);
    }
    const targetKeys = this.extractMultiTargetKeys(def);
    return targetKeys.length > 0 ? targetKeys.length : Math.max(1, def.target_value);
  }

  private isPrerequisiteSatisfied(
    characterId: number,
    prerequisiteId: string | null,
    statusByPair: Map<string, AchievementStatus>,
  ): boolean {
    if (!prerequisiteId) return true;
    const status = statusByPair.get(this.buildProgressPairKey(characterId, prerequisiteId));
    return status === 'completed' || status === 'claimed';
  }

  private async ensureCharacterAchievementPointsBatch(characterIds: number[]): Promise<void> {
    if (characterIds.length <= 0) return;

    await query(
      `
        INSERT INTO character_achievement_points (character_id)
        SELECT DISTINCT x.character_id
        FROM unnest($1::int[]) AS x(character_id)
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterIds],
    );
  }

  private async loadProgressRowsForUpdate(
    rows: AchievementProgressSeedRow[],
  ): Promise<Map<string, ParsedCharacterAchievementRow>> {
    if (rows.length <= 0) {
      return new Map<string, ParsedCharacterAchievementRow>();
    }

    const progressRes = await query(
      `
        WITH target_rows AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS x(character_id int, achievement_id varchar(64))
        )
        SELECT ca.*
        FROM character_achievement ca
        INNER JOIN target_rows tr
          ON tr.character_id = ca.character_id
         AND tr.achievement_id = ca.achievement_id
        FOR UPDATE OF ca
      `,
      [JSON.stringify(rows)],
    );

    const progressByPair = new Map<string, ParsedCharacterAchievementRow>();
    for (const row of progressRes.rows as Array<Record<string, unknown>>) {
      const parsed = parseCharacterAchievementRow(row);
      if (!parsed) continue;
      progressByPair.set(this.buildProgressPairKey(parsed.character_id, parsed.achievement_id), parsed);
    }

    return progressByPair;
  }

  private async ensureCharacterAchievementProgressRowsBatch(
    rows: AchievementProgressSeedRow[],
  ): Promise<void> {
    if (rows.length <= 0) {
      return;
    }

    await query(
      `
        INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)
        SELECT tr.character_id, tr.achievement_id, 'in_progress', 0, '{}'::jsonb
        FROM jsonb_to_recordset($1::jsonb)
          AS tr(character_id int, achievement_id varchar(64))
        ON CONFLICT (character_id, achievement_id) DO NOTHING
      `,
      [JSON.stringify(rows)],
    );
  }

  @Transactional
  async updateAchievementProgressBatch(inputs: AchievementProgressBatchInput[]): Promise<void> {
    const aggregatedInputs = new Map<string, NormalizedAchievementProgressBatchInput>();

    for (const input of inputs) {
      const characterId = asFiniteNonNegativeInt(input.characterId, 0);
      const trackKey = asNonEmptyString(input.trackKey);
      if (!characterId || !trackKey) continue;

      const aggregateKey = this.buildTrackAggregateKey(characterId, trackKey);
      const increment = this.normalizeIncrement(input.increment ?? 1);
      const existing = aggregatedInputs.get(aggregateKey);
      if (existing) {
        existing.increment += increment;
        continue;
      }

      const candidates = buildTrackKeyCandidates(trackKey);
      if (candidates.length <= 0) continue;

      aggregatedInputs.set(aggregateKey, {
        characterId,
        trackKey,
        increment,
        candidates,
      });
    }

    if (aggregatedInputs.size <= 0) return;

    const candidateTrackKeys = new Set<string>();
    for (const input of aggregatedInputs.values()) {
      for (const candidate of input.candidates) {
        candidateTrackKeys.add(candidate);
      }
    }

    const defs = getAchievementDefinitions()
      .filter((row) => candidateTrackKeys.has(String(row.track_key ?? '')))
      .filter((row) => row.enabled !== false)
      .map(parseAchievementDefRow)
      .filter((row): row is AchievementDefRow => row !== null);

    if (defs.length <= 0) return;

    const defsByTrackKey = new Map<string, AchievementDefRow[]>();
    for (const def of defs) {
      const matchedDefs = defsByTrackKey.get(def.track_key);
      if (matchedDefs) {
        matchedDefs.push(def);
        continue;
      }
      defsByTrackKey.set(def.track_key, [def]);
    }

    const contributionByPair = new Map<string, AchievementContribution>();
    for (const input of aggregatedInputs.values()) {
      const matchedAchievementIds = new Set<string>();

      for (const candidate of input.candidates) {
        const matchedDefs = defsByTrackKey.get(candidate);
        if (!matchedDefs) continue;

        for (const def of matchedDefs) {
          if (matchedAchievementIds.has(def.id)) continue;
          matchedAchievementIds.add(def.id);

          const pairKey = this.buildProgressPairKey(input.characterId, def.id);
          const existing = contributionByPair.get(pairKey);
          if (existing) {
            existing.totalDelta += input.increment;
            existing.matchedTrackKeys.add(input.trackKey);
            continue;
          }

          contributionByPair.set(pairKey, {
            characterId: input.characterId,
            achievementId: def.id,
            matchedTrackKeys: new Set<string>([input.trackKey]),
            totalDelta: input.increment,
          });
        }
      }
    }

    if (contributionByPair.size <= 0) return;

    const progressSeedRows: AchievementProgressSeedRow[] = [];
    const characterIdSet = new Set<number>();
    const contributionByCharacterId = new Map<number, Map<string, AchievementContribution>>();

    for (const contribution of contributionByPair.values()) {
      progressSeedRows.push({
        character_id: contribution.characterId,
        achievement_id: contribution.achievementId,
      });
      characterIdSet.add(contribution.characterId);

      const characterContributionMap = contributionByCharacterId.get(contribution.characterId);
      if (characterContributionMap) {
        characterContributionMap.set(contribution.achievementId, contribution);
      } else {
        contributionByCharacterId.set(
          contribution.characterId,
          new Map<string, AchievementContribution>([[contribution.achievementId, contribution]]),
        );
      }
    }

    const characterIds = Array.from(characterIdSet);
    await this.ensureCharacterAchievementPointsBatch(characterIds);
    await this.ensureCharacterAchievementProgressRowsBatch(progressSeedRows);
    const progressByPair = await this.loadProgressRowsForUpdate(progressSeedRows);

    const prerequisiteSeedRows: AchievementProgressSeedRow[] = [];
    const prerequisiteSeedKeySet = new Set<string>();
    for (const characterId of characterIds) {
      for (const def of defs) {
        if (!def.prerequisite_id) continue;

        const pairKey = this.buildProgressPairKey(characterId, def.prerequisite_id);
        if (prerequisiteSeedKeySet.has(pairKey)) continue;
        prerequisiteSeedKeySet.add(pairKey);
        prerequisiteSeedRows.push({
          character_id: characterId,
          achievement_id: def.prerequisite_id,
        });
      }
    }

    const prerequisiteStatusByPair = new Map<string, AchievementStatus>();
    if (prerequisiteSeedRows.length > 0) {
      const prerequisiteRes = await query(
        `
          WITH target_rows AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS x(character_id int, achievement_id varchar(64))
          )
          SELECT ca.character_id, ca.achievement_id, ca.status
          FROM character_achievement ca
          INNER JOIN target_rows tr
            ON tr.character_id = ca.character_id
           AND tr.achievement_id = ca.achievement_id
        `,
        [JSON.stringify(prerequisiteSeedRows)],
      );

      for (const row of prerequisiteRes.rows as Array<Record<string, unknown>>) {
        const characterId = asFiniteNonNegativeInt(row.character_id, 0);
        const achievementId = asNonEmptyString(row.achievement_id);
        const status = asNonEmptyString(row.status);
        if (!characterId || !achievementId || !status) continue;
        if (status !== 'in_progress' && status !== 'completed' && status !== 'claimed') continue;
        prerequisiteStatusByPair.set(this.buildProgressPairKey(characterId, achievementId), status);
      }
    }

    const progressMutationRows: AchievementProgressMutationRow[] = [];
    const pointDeltaByCharacterId = new Map<number, AchievementPointsDeltaRow>();
    const changedCharacterIds = new Set<number>();

    for (const characterId of characterIds) {
      const contributionMap = contributionByCharacterId.get(characterId);
      if (!contributionMap || contributionMap.size <= 0) continue;

      const pendingAchievementIds = new Set<string>(contributionMap.keys());
      let resolvedInCurrentPass = true;

      while (resolvedInCurrentPass && pendingAchievementIds.size > 0) {
        resolvedInCurrentPass = false;

        for (const def of defs) {
          if (!pendingAchievementIds.has(def.id)) continue;
          if (!this.isPrerequisiteSatisfied(characterId, def.prerequisite_id, prerequisiteStatusByPair)) continue;

          const progressPairKey = this.buildProgressPairKey(characterId, def.id);
          const row = progressByPair.get(progressPairKey);
          const contribution = contributionMap.get(def.id);
          pendingAchievementIds.delete(def.id);
          resolvedInCurrentPass = true;

          if (!row || !contribution) continue;

          if (row.status === 'completed' || row.status === 'claimed') {
            prerequisiteStatusByPair.set(progressPairKey, row.status);
            continue;
          }

          let nextProgress = row.progress;
          let nextProgressData = parseJsonObject<Record<string, number | boolean | string>>(row.progress_data);
          let changed = false;

          if (def.track_type === 'counter') {
            const target = Math.max(1, def.target_value);
            const current = Math.max(0, row.progress);
            const next = Math.min(target, current + contribution.totalDelta);
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
            const merged = this.mergeProgressForMulti(nextProgressData, targetKeys, contribution.matchedTrackKeys);
            nextProgressData = merged.nextProgressData;
            nextProgress = merged.nextProgress;
            changed = merged.changed;

            if (targetKeys.length === 0) {
              const target = Math.max(1, def.target_value);
              const current = Math.max(0, row.progress);
              const next = Math.min(target, current + contribution.totalDelta);
              if (next !== current) {
                nextProgress = next;
                changed = true;
              }
            }
          }

          if (!changed) {
            prerequisiteStatusByPair.set(progressPairKey, row.status);
            continue;
          }

          const nextStatus: AchievementStatus = nextProgress >= this.getAchievementTarget(def) ? 'completed' : 'in_progress';
          const completedNow = nextStatus === 'completed';

          progressMutationRows.push({
            character_id: characterId,
            achievement_id: def.id,
            status: nextStatus,
            progress: nextProgress,
            progress_data: nextProgressData,
            completed_now: completedNow,
          });

          progressByPair.set(progressPairKey, {
            ...row,
            status: nextStatus,
            progress: nextProgress,
            progress_data: nextProgressData,
          });
          prerequisiteStatusByPair.set(progressPairKey, nextStatus);
          changedCharacterIds.add(characterId);

          if (!completedNow) continue;

          const pointsDelta = Math.max(0, def.points);
          let pointDeltaRow = pointDeltaByCharacterId.get(characterId);
          if (!pointDeltaRow) {
            pointDeltaRow = {
              character_id: characterId,
              total_points: 0,
              combat_points: 0,
              cultivation_points: 0,
              exploration_points: 0,
              social_points: 0,
              collection_points: 0,
            };
            pointDeltaByCharacterId.set(characterId, pointDeltaRow);
          }

          pointDeltaRow.total_points += pointsDelta;
          const bucket = getPointColumnForCategory(def.category);
          if (bucket === 'combat') {
            pointDeltaRow.combat_points += pointsDelta;
          } else if (bucket === 'cultivation') {
            pointDeltaRow.cultivation_points += pointsDelta;
          } else if (bucket === 'exploration') {
            pointDeltaRow.exploration_points += pointsDelta;
          } else if (bucket === 'social') {
            pointDeltaRow.social_points += pointsDelta;
          } else if (bucket === 'collection') {
            pointDeltaRow.collection_points += pointsDelta;
          }
        }
      }
    }

    if (progressMutationRows.length <= 0) return;

    await query(
      `
        WITH updates AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS x(
              character_id int,
              achievement_id varchar(64),
              status varchar(32),
              progress int,
              progress_data jsonb,
              completed_now boolean
            )
        )
        UPDATE character_achievement ca
        SET status = updates.status,
            progress = updates.progress,
            progress_data = updates.progress_data,
            completed_at = CASE
              WHEN updates.completed_now THEN COALESCE(ca.completed_at, NOW())
              ELSE ca.completed_at
            END,
            updated_at = NOW()
        FROM updates
        WHERE ca.character_id = updates.character_id
          AND ca.achievement_id = updates.achievement_id
      `,
      [JSON.stringify(progressMutationRows)],
    );

    const pointDeltaRows = Array.from(pointDeltaByCharacterId.values()).filter((row) => row.total_points > 0);
    if (pointDeltaRows.length > 0) {
      await query(
        `
          WITH deltas AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS x(
                character_id int,
                total_points int,
                combat_points int,
                cultivation_points int,
                exploration_points int,
                social_points int,
                collection_points int
              )
          )
          UPDATE character_achievement_points cap
          SET total_points = cap.total_points + deltas.total_points,
              combat_points = cap.combat_points + deltas.combat_points,
              cultivation_points = cap.cultivation_points + deltas.cultivation_points,
              exploration_points = cap.exploration_points + deltas.exploration_points,
              social_points = cap.social_points + deltas.social_points,
              collection_points = cap.collection_points + deltas.collection_points,
              updated_at = NOW()
          FROM deltas
          WHERE cap.character_id = deltas.character_id
        `,
        [JSON.stringify(pointDeltaRows)],
      );
    }

    const changedCharacterIdList = Array.from(changedCharacterIds);
    if (changedCharacterIdList.length <= 0) return;

    await afterTransactionCommit(async () => {
      await Promise.all(changedCharacterIdList.map((characterId) => notifyAchievementUpdate(characterId)));
    });
  }

  async updateAchievementProgress(
    characterId: number,
    trackKey: string,
    increment = 1,
    _metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.updateAchievementProgressBatch([{ characterId, trackKey, increment }]);
  }
}

export const achievementProgressService = new AchievementProgressService();

// 向后兼容的命名导出
export const updateAchievementProgress = achievementProgressService.updateAchievementProgress.bind(achievementProgressService);
export const updateAchievementProgressBatch =
  achievementProgressService.updateAchievementProgressBatch.bind(achievementProgressService);
