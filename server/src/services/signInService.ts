import { HolidayUtil } from 'lunar-typescript';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import {
  loadCharacterWritebackRowByUserId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';

export interface SignInRecordDto {
  date: string;
  signedAt: string;
  reward: number;
  isHoliday: boolean;
  holidayName: string | null;
}

export interface SignInOverviewResult {
  success: boolean;
  message: string;
  data?: {
    today: string;
    signedToday: boolean;
    month: string;
    monthSignedCount: number;
    streakDays: number;
    records: Record<string, SignInRecordDto>;
  };
}

export interface DoSignInResult {
  success: boolean;
  message: string;
  data?: {
    date: string;
    reward: number;
    isHoliday: boolean;
    holidayName: string | null;
    spiritStones: number;
  };
}

type SignDateValue = Date | string | null;
type SignInHistoryRow = {
  sign_date: SignDateValue;
};
type SignInMonthRecordRow = {
  sign_date: SignDateValue;
  reward: number | string | null;
  is_holiday: boolean | null;
  holiday_name: string | null;
  created_at: Date | string | null;
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const SIGN_IN_HISTORY_LOOKBACK_DAYS = 366;
const SIGN_IN_REWARD_BASE = 1500;
const SIGN_IN_REWARD_STREAK_CAP = 30;
const SIGN_IN_REWARD_STEP = 100;

const buildDateKey = (d: Date) => {
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${year}-${month}-${day}`;
};

const normalizeDateKey = (v: unknown) => {
  if (v instanceof Date) return buildDateKey(v);
  if (typeof v === 'string') return v.slice(0, 10);
  return '';
};

const parseMonth = (month: string) => {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return null;
  return { year, month: mon };
};

const addDays = (date: Date, days: number) => {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
};

const buildSignedDateSet = (rows: SignInHistoryRow[]): Set<string> => {
  const signedSet = new Set<string>();
  for (const row of rows) {
    const key = normalizeDateKey(row.sign_date);
    if (key) signedSet.add(key);
  }
  return signedSet;
};

const countConsecutiveSignedDays = (signedSet: ReadonlySet<string>, startDate: Date, maxDays: number): number => {
  let streakDays = 0;
  let cursor = new Date(startDate.getTime());

  while (streakDays < maxDays) {
    const key = buildDateKey(cursor);
    if (!signedSet.has(key)) break;
    streakDays += 1;
    cursor = addDays(cursor, -1);
  }

  return streakDays;
};

/**
 * 连续签到奖励计算
 *
 * 作用：集中维护签到基础奖励、连签增量与 30 天封顶规则，避免数值逻辑在事务流程和展示层重复实现。
 * 不做：不读取数据库、不判断今日是否已签到，只根据“今天签到后的连续天数”产出奖励。
 *
 * 输入/输出：
 * - 输入：今天签到后的连续天数，最小业务值为 1。
 * - 输出：最终签到奖励数值。
 *
 * 数据流：
 * - 先把连续天数收敛到 `1..30`；
 * - 再用“基础 1500 + (连续天数 - 1) * 100”统一计算奖励；
 * - 最终结果由 `doSignIn` 写入签到记录并同步增加角色灵石。
 *
 * 关键边界条件与坑点：
 * 1) 首次签到仍应保持基础奖励 1500，因此增量从第 2 天开始生效，不能把第 1 天直接算成 1600。
 * 2) 连续天数超过 30 天后必须封顶，避免奖励无限增长导致经济系统失衡。
 */
const calculateSignInReward = (streakDaysAfterSignIn: number): number => {
  const effectiveStreakDays = Math.min(Math.max(streakDaysAfterSignIn, 1), SIGN_IN_REWARD_STREAK_CAP);
  return SIGN_IN_REWARD_BASE + (effectiveStreakDays - 1) * SIGN_IN_REWARD_STEP;
};

const getHolidayInfo = (date: Date) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const h = HolidayUtil.getHoliday(year, month, day);
  const rawName = h?.getTarget() === h?.getDay() ? h?.getName() : null;
  const name = rawName ?? null;
  return { isHoliday: Boolean(name), holidayName: name };
};

/**
 * 签到服务
 *
 * 作用：处理用户每日签到逻辑，包括签到概览查询与执行签到
 * 不做：不处理路由层参数校验、不做权限判断
 *
 * 数据流：
 * - getOverview：读取 sign_in_records 表，计算当月记录与连续签到天数
 * - doSignIn：在事务中插入签到记录并更新角色灵石
 *
 * 边界条件：
 * 1) doSignIn 使用 @Transactional 保证签到记录插入与灵石更新的原子性
 * 2) getOverview 为纯读方法，不需要事务
 */
class SignInService {
  // 纯读方法，不加 @Transactional
  async getOverview(userId: number, month: string): Promise<SignInOverviewResult> {
    const parsed = parseMonth(month);
    if (!parsed) return { success: false, message: '月份参数错误' };

    const start = `${month}-01`;
    const nextMonthDate = new Date(parsed.year, parsed.month, 1);
    const next = `${nextMonthDate.getFullYear()}-${pad2(nextMonthDate.getMonth() + 1)}-01`;

    const monthRows = await query(
      `
        SELECT sign_date, reward, is_holiday, holiday_name, created_at
        FROM sign_in_records
        WHERE user_id = $1 AND sign_date >= $2::date AND sign_date < $3::date
        ORDER BY sign_date ASC
      `,
      [userId, start, next]
    );

    const records: Record<string, SignInRecordDto> = {};
    for (const row of monthRows.rows as SignInMonthRecordRow[]) {
      const dateKey = normalizeDateKey(row.sign_date);
      if (!dateKey) continue;
      const signedAt =
        row.created_at instanceof Date ? row.created_at.toISOString() : typeof row.created_at === 'string' ? row.created_at : '';
      records[dateKey] = {
        date: dateKey,
        signedAt,
        reward: Number(row.reward ?? 0),
        isHoliday: Boolean(row.is_holiday),
        holidayName: typeof row.holiday_name === 'string' ? row.holiday_name : null,
      };
    }

    const todayKey = buildDateKey(new Date());
    const signedToday = Boolean(records[todayKey]) || (await query(
      'SELECT 1 FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1',
      [userId, todayKey]
    )).rows.length > 0;

    const historyRows = await query(
      `
        SELECT sign_date
        FROM sign_in_records
        WHERE user_id = $1 AND sign_date >= ($2::date - INTERVAL '366 days')
        ORDER BY sign_date DESC
        LIMIT 366
      `,
      [userId, todayKey]
    );

    const signedSet = buildSignedDateSet(historyRows.rows as SignInHistoryRow[]);
    const streakDays = countConsecutiveSignedDays(signedSet, new Date(), SIGN_IN_HISTORY_LOOKBACK_DAYS);

    return {
      success: true,
      message: '获取成功',
      data: {
        today: todayKey,
        signedToday,
        month,
        monthSignedCount: Object.keys(records).length,
        streakDays,
        records,
      },
    };
  }

  // 签到操作，需要事务保证原子性
  @Transactional
  async doSignIn(userId: number): Promise<DoSignInResult> {
    const today = new Date();
    const todayKey = buildDateKey(today);
    const holidayInfo = getHolidayInfo(today);

    const character = await loadCharacterWritebackRowByUserId(userId, { forUpdate: true });
    if (!character) {
      return { success: false, message: '角色不存在，无法签到' };
    }

    const exist = await query(
      'SELECT id FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1',
      [userId, todayKey]
    );
    if (exist.rows.length > 0) {
      return { success: false, message: '今日已签到' };
    }

    const historyRows = await query(
      `
        SELECT sign_date
        FROM sign_in_records
        WHERE user_id = $1 AND sign_date >= ($2::date - INTERVAL '366 days') AND sign_date < $2::date
        ORDER BY sign_date DESC
        LIMIT 366
      `,
      [userId, todayKey]
    );
    const signedSet = buildSignedDateSet(historyRows.rows as SignInHistoryRow[]);
    const previousStreakDays = countConsecutiveSignedDays(
      signedSet,
      addDays(today, -1),
      SIGN_IN_HISTORY_LOOKBACK_DAYS,
    );
    const reward = calculateSignInReward(previousStreakDays + 1);

    await query(
      `
        INSERT INTO sign_in_records (user_id, sign_date, reward, is_holiday, holiday_name)
        VALUES ($1, $2::date, $3, $4, $5)
      `,
      [userId, todayKey, reward, holidayInfo.isHoliday, holidayInfo.holidayName]
    );

    const nextSpiritStones = Math.max(0, Number(character.spirit_stones ?? 0)) + reward;
    await queueCharacterWritebackSnapshot(character.id, {
      spirit_stones: nextSpiritStones,
    });

    return {
      success: true,
      message: '签到成功',
      data: {
        date: todayKey,
        reward,
        isHoliday: holidayInfo.isHoliday,
        holidayName: holidayInfo.holidayName,
        spiritStones: nextSpiritStones,
      },
    };
  }
}

export const signInService = new SignInService();
