import { pool, query, withTransaction } from '../config/database.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import { getPvpWeeklyTitleIdByRank } from './achievement/pvpWeeklyTitleConfig.js';
import { clearExpiredEquippedPvpWeeklyTitlesTx, grantExpiringTitleTx } from './achievement/titleOwnership.js';
import { sendSystemMail } from './mailService.js';
import { getTitleDefinitions } from './staticConfigLoader.js';

/**
 * 竞技场周结算服务（每周一 00:00，Asia/Shanghai）
 *
 * 作用：
 * 1. 周期性检查并执行“上周竞技场前三名”称号结算；
 * 2. 支持宕机补偿：根据最后结算周键补齐漏结算周；
 * 3. 清理已过期且仍装备的 PVP 周称号，确保角色属性与称号展示一致。
 *
 * 输入：
 * - 无外部参数（服务启动后自动运行）。
 *
 * 输出：
 * - 向 arena_weekly_settlement 写入每周幂等记录；
 * - 向 character_title 发放/续期限时称号；
 * - 清理过期装备称号并触发角色计算缓存失效。
 *
 * 数据流：
 * - startupPipeline -> initArenaWeeklySettlementService
 * - 定时触发 -> runWeeklySettlementCheck -> settlePendingWeeks -> settleSingleWeek
 *
 * 关键边界条件与坑点：
 * 1. 多实例部署时必须加数据库 advisory lock，避免同一周重复结算。
 * 2. 时间窗口必须统一按 Asia/Shanghai 计算周起点，不能使用服务器本地时区。
 */

const SHANGHAI_TIMEZONE = 'Asia/Shanghai';
const CHECK_INTERVAL_MS = 60 * 1000;
const ADVISORY_LOCK_KEY_1 = 2026;
const ADVISORY_LOCK_KEY_2 = 227;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let initialized = false;

interface WeekBoundary {
  currentWeekStartLocalDate: string;
  previousWeekStartLocalDate: string;
}

interface SettleSingleWeekResult {
  settled: boolean;
  weekStartLocalDate: string;
  weekEndLocalDate: string;
  topCharacterIds: number[];
  awards: WeeklyAwardInfo[];
  expiredEquippedCharacterIds: number[];
}

interface WeeklyAwardInfo {
  rank: number;
  characterId: number;
  titleId: string;
}

const toLocalDateString = (value: unknown, fieldName: string): string => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const raw = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  }
  throw new Error(`字段 ${fieldName} 不是有效日期`);
};

const addDaysToLocalDate = (localDate: string, days: number): string => {
  const base = new Date(`${localDate}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`无效的日期字符串: ${localDate}`);
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

const rankLabelMap: Record<number, string> = {
  1: '冠军',
  2: '亚军',
  3: '季军',
};

/**
 * 发送周结算称号邮件通知。
 *
 * 作用：
 * 1. 在周结算事务提交后通知获奖玩家称号已发放；
 * 2. 复用统一邮件服务，避免在结算逻辑里重复拼接 SQL。
 *
 * 输入：
 * - weekStartLocalDate/weekEndLocalDate：结算窗口（上海时区日期）；
 * - awards：本周获奖信息（名次/角色ID/称号ID）。
 *
 * 输出：
 * - 无返回值；发送失败仅记录日志，不回滚已完成的周结算。
 *
 * 数据流：
 * - settlePendingWeeks -> sendWeeklyTitleAwardMails。
 *
 * 关键边界条件与坑点：
 * 1. 邮件发送在事务提交后执行，避免“邮件成功但结算回滚”的状态不一致。
 * 2. 角色可能在结算后被删除，发送前必须再次读取角色与用户归属并逐条校验。
 */
const sendWeeklyTitleAwardMails = async (
  weekStartLocalDate: string,
  weekEndLocalDate: string,
  awards: WeeklyAwardInfo[],
): Promise<void> => {
  if (awards.length === 0) return;

  const characterIds = awards.map((item) => item.characterId);
  const characterRes = await query(
    `
      SELECT id, user_id
      FROM characters
      WHERE id = ANY($1::int[])
    `,
    [characterIds],
  );

  const userIdByCharacterId = new Map<number, number>();
  for (const row of characterRes.rows as Array<Record<string, unknown>>) {
    const characterId = Number(row.id);
    const userId = Number(row.user_id);
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (!Number.isFinite(userId) || userId <= 0) continue;
    userIdByCharacterId.set(Math.floor(characterId), Math.floor(userId));
  }

  const titleNameById = new Map(
    getTitleDefinitions()
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [entry.id, String(entry.name || '').trim() || entry.id]),
  );

  const periodEndLocalDate = addDaysToLocalDate(weekEndLocalDate, -1);
  const expireAtText = `${weekEndLocalDate} 00:00`;

  for (const award of awards) {
    const userId = userIdByCharacterId.get(award.characterId);
    if (!userId) continue;

    const rankLabel = rankLabelMap[award.rank] ?? `第${award.rank}名`;
    const titleName = titleNameById.get(award.titleId) ?? award.titleId;

    const mailTitle = `竞技场周结算奖励：${rankLabel}`;
    const mailContent =
      `你在竞技场周结算（${weekStartLocalDate} 至 ${periodEndLocalDate}）中获得${rankLabel}，` +
      `奖励称号「${titleName}」已发放。` +
      `该称号有效期至 ${expireAtText}（Asia/Shanghai），请前往成就-称号面板查看并手动装备。`;

    const mailRes = await sendSystemMail(userId, award.characterId, mailTitle, mailContent, undefined, 30);
    if (!mailRes.success) {
      console.warn(
        `[PVP周结算] 奖励邮件发送失败，characterId=${award.characterId}, rank=${award.rank}, message=${mailRes.message}`,
      );
    }
  }
};

const getWeekBoundary = async (): Promise<WeekBoundary> => {
  const res = await query(
    `
      SELECT
        date_trunc('week', timezone($1, NOW()))::date AS current_week_start_local_date,
        (date_trunc('week', timezone($1, NOW()))::date - INTERVAL '7 day')::date AS previous_week_start_local_date
    `,
    [SHANGHAI_TIMEZONE],
  );

  const row = (res.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    currentWeekStartLocalDate: toLocalDateString(row.current_week_start_local_date, 'current_week_start_local_date'),
    previousWeekStartLocalDate: toLocalDateString(row.previous_week_start_local_date, 'previous_week_start_local_date'),
  };
};

/**
 * 计算本轮待结算周列表。
 *
 * 规则：
 * - 结算目标永远是“已经结束的完整周”，即 week_start < current_week_start；
 * - 若从未结算过，首轮仅从“上一个完整周”开始，避免首次上线回溯历史全部周。
 */
const collectPendingWeekStarts = async (): Promise<string[]> => {
  const [boundary, lastRes] = await Promise.all([
    getWeekBoundary(),
    query(`SELECT MAX(week_start_local_date) AS last_week_start_local_date FROM arena_weekly_settlement`),
  ]);

  const lastRow = (lastRes.rows?.[0] ?? {}) as Record<string, unknown>;
  const lastSettledRaw = lastRow.last_week_start_local_date;

  const firstPendingWeek =
    lastSettledRaw === null
      ? boundary.previousWeekStartLocalDate
      : addDaysToLocalDate(toLocalDateString(lastSettledRaw, 'last_week_start_local_date'), 7);

  const out: string[] = [];
  for (
    let cursor = firstPendingWeek;
    cursor < boundary.currentWeekStartLocalDate;
    cursor = addDaysToLocalDate(cursor, 7)
  ) {
    out.push(cursor);
  }

  return out;
};

const loadTopThreeCharacterIdsForWeekTx = async (
  weekStartLocalDate: string,
  weekEndLocalDate: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<number[]> => {
  const rankRes = await client.query(
    `
      WITH weekly_participants AS (
        SELECT ab.challenger_character_id AS character_id
        FROM arena_battle ab
        WHERE ab.status = 'finished'
          AND ab.created_at >= ($1::date::timestamp AT TIME ZONE $3)
          AND ab.created_at < ($2::date::timestamp AT TIME ZONE $3)
        UNION
        SELECT ab.opponent_character_id AS character_id
        FROM arena_battle ab
        WHERE ab.status = 'finished'
          AND ab.created_at >= ($1::date::timestamp AT TIME ZONE $3)
          AND ab.created_at < ($2::date::timestamp AT TIME ZONE $3)
      )
      SELECT wp.character_id
      FROM weekly_participants wp
      LEFT JOIN arena_rating ar ON ar.character_id = wp.character_id
      ORDER BY
        COALESCE(ar.rating, 1000) DESC,
        COALESCE(ar.win_count, 0) DESC,
        COALESCE(ar.lose_count, 0) ASC,
        wp.character_id ASC
      LIMIT 3
    `,
    [weekStartLocalDate, weekEndLocalDate, SHANGHAI_TIMEZONE],
  );

  return rankRes.rows
    .map((row) => Number(row.character_id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id));
};

const getExpireAtByWeekEndTx = async (
  weekEndLocalDate: string,
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<Date> => {
  const res = await client.query(
    `
      SELECT ($1::date::timestamp AT TIME ZONE $2) AS expire_at
    `,
    [weekEndLocalDate, SHANGHAI_TIMEZONE],
  );

  const row = (res.rows?.[0] ?? {}) as Record<string, unknown>;
  if (!(row.expire_at instanceof Date)) {
    throw new Error('计算称号过期时间失败');
  }

  return row.expire_at;
};

const settleSingleWeek = async (weekStartLocalDate: string): Promise<SettleSingleWeekResult> => {
  const weekEndLocalDate = addDaysToLocalDate(weekStartLocalDate, 7);

  try {
    return await withTransaction(async (client) => {
  const existingRes = await client.query(
        `SELECT 1 FROM arena_weekly_settlement WHERE week_start_local_date = $1::date LIMIT 1 FOR UPDATE`,
        [weekStartLocalDate],
      );
  
      if ((existingRes.rows?.length ?? 0) > 0) {
        await client.query('ROLLBACK');
        return {
          settled: false,
          weekStartLocalDate,
          weekEndLocalDate,
          topCharacterIds: [],
          awards: [],
          expiredEquippedCharacterIds: [],
        };
      }
  
      const expiredEquippedCharacterIds = await clearExpiredEquippedPvpWeeklyTitlesTx(client);
      const topCharacterIds = await loadTopThreeCharacterIdsForWeekTx(weekStartLocalDate, weekEndLocalDate, client);
      const awards: WeeklyAwardInfo[] = [];
  
      if (topCharacterIds.length > 0) {
        const expireAt = await getExpireAtByWeekEndTx(weekEndLocalDate, client);
        for (let rank = 1; rank <= topCharacterIds.length; rank += 1) {
          const titleId = getPvpWeeklyTitleIdByRank(rank);
          if (!titleId) {
            throw new Error(`PVP周称号配置缺失，rank=${rank}`);
          }
          const characterId = topCharacterIds[rank - 1]!;
          await grantExpiringTitleTx(client, characterId, titleId, expireAt);
          awards.push({ rank, characterId, titleId });
        }
      }
  
      const championCharacterId = topCharacterIds[0] ?? null;
      const runnerupCharacterId = topCharacterIds[1] ?? null;
      const thirdCharacterId = topCharacterIds[2] ?? null;
  
      await client.query(
        `
          INSERT INTO arena_weekly_settlement (
            week_start_local_date,
            week_end_local_date,
            window_start_at,
            window_end_at,
            champion_character_id,
            runnerup_character_id,
            third_character_id,
            settled_at,
            updated_at
          )
          VALUES (
            $1::date,
            $2::date,
            ($1::date::timestamp AT TIME ZONE $6),
            ($2::date::timestamp AT TIME ZONE $6),
            $3,
            $4,
            $5,
            NOW(),
            NOW()
          )
        `,
        [
          weekStartLocalDate,
          weekEndLocalDate,
          championCharacterId,
          runnerupCharacterId,
          thirdCharacterId,
          SHANGHAI_TIMEZONE,
        ],
      );
  return {
        settled: true,
        weekStartLocalDate,
        weekEndLocalDate,
        topCharacterIds,
        awards,
        expiredEquippedCharacterIds,
      };
    });
  } catch (error) {
throw error;
  }
};

const invalidateCharacterCaches = async (characterIds: number[]): Promise<void> => {
  const ids = Array.from(new Set(characterIds));
  await Promise.all(ids.map((characterId) => invalidateCharacterComputedCache(characterId)));
};

const settlePendingWeeks = async (): Promise<void> => {
  const pendingWeekStarts = await collectPendingWeekStarts();
  if (pendingWeekStarts.length === 0) return;

  const idsNeedInvalidate: number[] = [];

  for (const weekStartLocalDate of pendingWeekStarts) {
    const result = await settleSingleWeek(weekStartLocalDate);
    if (!result.settled) continue;

    idsNeedInvalidate.push(...result.expiredEquippedCharacterIds);
    try {
      await sendWeeklyTitleAwardMails(result.weekStartLocalDate, result.weekEndLocalDate, result.awards);
    } catch (error) {
      console.warn(`[PVP周结算] 奖励邮件发送异常，weekStart=${result.weekStartLocalDate}`, error);
    }

    console.log(
      `[PVP周结算] ${result.weekStartLocalDate} 完成，前三角色：${result.topCharacterIds.join(', ') || '无'}`,
    );
  }

  if (idsNeedInvalidate.length > 0) {
    await invalidateCharacterCaches(idsNeedInvalidate);
  }
};

const runWeeklySettlementCheck = async (): Promise<void> => {
  if (inFlight) return;
  inFlight = true;

  try {
    const lockRes = await query(`SELECT pg_try_advisory_lock($1, $2) AS locked`, [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]);
    const lockRow = (lockRes.rows?.[0] ?? {}) as Record<string, unknown>;
    if (lockRow.locked !== true) {
      return;
    }

    try {
      await settlePendingWeeks();
    } finally {
      await query(`SELECT pg_advisory_unlock($1, $2)`, [ADVISORY_LOCK_KEY_1, ADVISORY_LOCK_KEY_2]);
    }
  } catch (error) {
    console.error('PVP周结算检查失败:', error);
  } finally {
    inFlight = false;
  }
};

/**
 * 初始化 PVP 周结算定时服务。
 *
 * 启动行为：
 * 1. 立即执行一次检查（用于宕机补偿）；
 * 2. 之后每 60 秒检查一次。
 */
export const initArenaWeeklySettlementService = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;

  await runWeeklySettlementCheck();

  if (!timer) {
    timer = setInterval(() => {
      void runWeeklySettlementCheck();
    }, CHECK_INTERVAL_MS);
  }
};
