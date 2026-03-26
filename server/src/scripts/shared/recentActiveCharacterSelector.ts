/**
 * 近期活跃角色筛选共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义“近期活跃角色”的筛选口径，统一复用 `users.last_login`、`characters.updated_at`、`characters.last_offline_at` 三个时间源。
 * 2. 做什么：把活跃角色查询与结果归一化收口到单一入口，避免各个运维脚本各写一套近 N 天活跃 SQL。
 * 3. 不做什么：不发送邮件、不生成补偿文案，也不决定最终发奖策略。
 *
 * 输入/输出：
 * - 输入：活跃窗口天数 `activeWindowDays`。
 * - 输出：按最近活跃时间倒序排列的角色列表，包含 userId、characterId、昵称及活跃时间明细。
 *
 * 数据流/状态流：
 * 运维脚本参数 -> 本模块按统一 SQL 读取近期活跃角色 -> 返回标准化目标列表 -> 上游脚本决定 dry-run/execute。
 *
 * 关键边界条件与坑点：
 * 1. 活跃口径必须和 `onlineBattleProjectionService` 的预热逻辑保持一致，否则“活跃玩家”在运营脚本与运行时会出现两套定义。
 * 2. 这里只返回当前存在角色记录的账号；没有角色的纯账号登录记录不会进入补偿名单。
 */

import { query } from '../../config/database.js';

export const DEFAULT_RECENT_ACTIVE_CHARACTER_WINDOW_DAYS = 7;

type RecentActiveCharacterRow = {
  user_id: number | string;
  character_id: number | string;
  character_nickname: string;
  user_last_login_at: Date | string | null;
  character_updated_at: Date | string | null;
  character_last_offline_at: Date | string | null;
  last_active_at: Date | string;
};

export type RecentActiveCharacter = {
  userId: number;
  characterId: number;
  characterNickname: string;
  userLastLoginAt: string | null;
  characterUpdatedAt: string | null;
  characterLastOfflineAt: string | null;
  lastActiveAt: string;
};

const toIsoString = (value: Date | string): string => {
  return value instanceof Date ? value.toISOString() : String(value);
};

const toNullableIsoString = (value: Date | string | null): string | null => {
  if (value === null) {
    return null;
  }
  return toIsoString(value);
};

export const loadRecentActiveCharacters = async (
  activeWindowDays: number,
): Promise<RecentActiveCharacter[]> => {
  if (!Number.isInteger(activeWindowDays) || activeWindowDays <= 0) {
    throw new Error('活跃窗口天数必须为正整数');
  }

  const result = await query<RecentActiveCharacterRow>(
    `
      SELECT
        c.user_id,
        c.id AS character_id,
        c.nickname AS character_nickname,
        u.last_login AS user_last_login_at,
        c.updated_at AS character_updated_at,
        c.last_offline_at AS character_last_offline_at,
        GREATEST(
          COALESCE(c.updated_at::timestamptz, c.created_at::timestamptz, to_timestamp(0)),
          COALESCE(c.last_offline_at, to_timestamp(0)),
          COALESCE(u.last_login::timestamptz, to_timestamp(0))
        ) AS last_active_at
      FROM characters c
      JOIN users u
        ON u.id = c.user_id
      WHERE GREATEST(
        COALESCE(c.updated_at::timestamptz, c.created_at::timestamptz, to_timestamp(0)),
        COALESCE(c.last_offline_at, to_timestamp(0)),
        COALESCE(u.last_login::timestamptz, to_timestamp(0))
      ) >= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY last_active_at DESC, c.id DESC
    `,
    [activeWindowDays],
  );

  const targets: RecentActiveCharacter[] = [];
  for (const row of result.rows) {
    const userId = Number(row.user_id);
    const characterId = Number(row.character_id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    if (!Number.isInteger(characterId) || characterId <= 0) continue;

    targets.push({
      userId,
      characterId,
      characterNickname: row.character_nickname,
      userLastLoginAt: toNullableIsoString(row.user_last_login_at),
      characterUpdatedAt: toNullableIsoString(row.character_updated_at),
      characterLastOfflineAt: toNullableIsoString(row.character_last_offline_at),
      lastActiveAt: toIsoString(row.last_active_at),
    });
  }

  return targets;
};
