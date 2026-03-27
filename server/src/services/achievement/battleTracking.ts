/**
 * 战斗成就状态追踪模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一维护“战斗连胜状态 + 低血胜利判定”的成就追踪逻辑，避免 battle settlement 各分支重复写判定和持久化。
 * 2. 做什么：为同一 battleId 提供幂等保护，防止战斗终态重复结算时把连胜与低血成就重复记入。
 * 3. 不做什么：不处理掉落、任务、秘境通关奖励，也不替代通用 `updateAchievementProgress` 的定义匹配能力。
 *
 * 输入/输出：
 * - 输入：`battleId`、`battleResult`、本次战斗中攻击方玩家的终态快照
 * - 输出：无；副作用是更新战斗成就状态表，并在命中条件时推进成就进度
 *
 * 数据流/状态流：
 * 战斗结算终态 -> 本模块锁定角色战斗成就状态 -> 内存归并连胜与低血命中 -> 批量更新 battle 状态表 -> 批量推进成就进度。
 *
 * 关键边界条件与坑点：
 * 1. 连胜是强顺序状态，必须按 battleId 做幂等；同一战斗重复进入结算链时只能处理一次。
 * 2. 低血胜利必须基于战斗终态快照判断，且要求角色存活并满足剩余气血比例 `<= 10%`，不能用战前或过程态替代。
 */

import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { updateAchievementProgressBatch } from './progress.js';

export type AchievementBattleParticipantSnapshot = {
  characterId: number;
  finalQixue: number;
  finalMaxQixue: number;
};

type AchievementBattleStateRow = {
  character_id: number;
  current_win_streak: number;
  last_processed_battle_id: string | null;
};

type AchievementBattleStateMutationRow = {
  character_id: number;
  current_win_streak: number;
  last_processed_battle_id: string;
};

const LOW_HP_VICTORY_RATIO = 0.1;
const WIN_STREAK_TARGET = 10;

const normalizePositiveInt = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
};

export const isLowHpVictorySnapshot = (
  snapshot: AchievementBattleParticipantSnapshot,
): boolean => {
  const finalMaxQixue = normalizePositiveInt(snapshot.finalMaxQixue);
  const finalQixue = normalizePositiveInt(snapshot.finalQixue);
  if (finalMaxQixue <= 0 || finalQixue <= 0) return false;
  return finalQixue / finalMaxQixue <= LOW_HP_VICTORY_RATIO;
};

class AchievementBattleTrackingService {
  private normalizeSnapshots(
    snapshots: AchievementBattleParticipantSnapshot[],
  ): AchievementBattleParticipantSnapshot[] {
    const snapshotByCharacterId = new Map<number, AchievementBattleParticipantSnapshot>();

    for (const snapshot of snapshots) {
      const characterId = normalizePositiveInt(snapshot.characterId);
      if (characterId <= 0) continue;

      snapshotByCharacterId.set(characterId, {
        characterId,
        finalQixue: normalizePositiveInt(snapshot.finalQixue),
        finalMaxQixue: normalizePositiveInt(snapshot.finalMaxQixue),
      });
    }

    return [...snapshotByCharacterId.values()];
  }

  @Transactional
  async recordBattleOutcomeAchievements(
    battleId: string,
    battleResult: 'attacker_win' | 'defender_win' | 'draw',
    snapshots: AchievementBattleParticipantSnapshot[],
  ): Promise<void> {
    const normalizedBattleId = battleId.trim();
    if (!normalizedBattleId) return;

    const normalizedSnapshots = this.normalizeSnapshots(snapshots);
    if (normalizedSnapshots.length <= 0) return;

    const characterIds = normalizedSnapshots.map((snapshot) => snapshot.characterId);
    await query(
      `
        INSERT INTO character_achievement_battle_state (character_id)
        SELECT x.character_id
        FROM unnest($1::int[]) AS x(character_id)
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterIds],
    );

    const stateResult = await query<AchievementBattleStateRow>(
      `
        SELECT character_id, current_win_streak, last_processed_battle_id
        FROM character_achievement_battle_state
        WHERE character_id = ANY($1::int[])
        FOR UPDATE
      `,
      [characterIds],
    );

    const stateByCharacterId = new Map<number, AchievementBattleStateRow>();
    for (const row of stateResult.rows) {
      stateByCharacterId.set(row.character_id, row);
    }

    const isVictory = battleResult === 'attacker_win';
    const battleStateMutationRows: AchievementBattleStateMutationRow[] = [];
    const achievementProgressInputs: Array<{ characterId: number; trackKey: string; increment: number }> = [];

    for (const snapshot of normalizedSnapshots) {
      const state = stateByCharacterId.get(snapshot.characterId);
      if (!state) continue;
      if (state.last_processed_battle_id === normalizedBattleId) continue;

      const previousWinStreak = normalizePositiveInt(state.current_win_streak);
      const nextWinStreak = isVictory ? previousWinStreak + 1 : 0;

      battleStateMutationRows.push({
        character_id: snapshot.characterId,
        current_win_streak: nextWinStreak,
        last_processed_battle_id: normalizedBattleId,
      });

      if (isVictory && previousWinStreak < WIN_STREAK_TARGET && nextWinStreak >= WIN_STREAK_TARGET) {
        achievementProgressInputs.push({
          characterId: snapshot.characterId,
          trackKey: 'battle:win:streak:10',
          increment: 1,
        });
      }

      if (isVictory && isLowHpVictorySnapshot(snapshot)) {
        achievementProgressInputs.push({
          characterId: snapshot.characterId,
          trackKey: 'battle:win:low_hp',
          increment: 1,
        });
      }
    }

    if (battleStateMutationRows.length > 0) {
      await query(
        `
          WITH updates AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS x(
                character_id int,
                current_win_streak int,
                last_processed_battle_id varchar(128)
              )
          )
          UPDATE character_achievement_battle_state state
          SET current_win_streak = updates.current_win_streak,
              last_processed_battle_id = updates.last_processed_battle_id,
              updated_at = NOW()
          FROM updates
          WHERE state.character_id = updates.character_id
        `,
        [JSON.stringify(battleStateMutationRows)],
      );
    }

    if (achievementProgressInputs.length > 0) {
      await updateAchievementProgressBatch(achievementProgressInputs);
    }
  }
}

export const achievementBattleTrackingService = new AchievementBattleTrackingService();

export const recordBattleOutcomeAchievements =
  achievementBattleTrackingService.recordBattleOutcomeAchievements.bind(achievementBattleTrackingService);
