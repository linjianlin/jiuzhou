import { HolidayUtil } from 'lunar-typescript';
import { pool, query, withTransaction } from '../config/database.js';
import { rollbackAndReturn, safeRollback } from './shared/transaction.js';

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

const pad2 = (n: number) => String(n).padStart(2, '0');

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

const getHolidayInfo = (date: Date) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const h = HolidayUtil.getHoliday(year, month, day);
  const rawName = h?.getTarget() === h?.getDay() ? h?.getName() : null;
  const name = rawName ?? null;
  return { isHoliday: Boolean(name), holidayName: name };
};

export const getSignInOverview = async (userId: number, month: string): Promise<SignInOverviewResult> => {
  try {
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
    for (const row of monthRows.rows as Array<Record<string, unknown>>) {
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

    const signedSet = new Set<string>();
    for (const row of historyRows.rows as Array<Record<string, unknown>>) {
      const key = normalizeDateKey(row.sign_date);
      if (key) signedSet.add(key);
    }

    let streakDays = 0;
    let cursor = new Date();
    while (streakDays < 366) {
      const key = buildDateKey(cursor);
      if (!signedSet.has(key)) break;
      streakDays += 1;
      cursor = addDays(cursor, -1);
    }

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
  } catch (error) {
    console.error('获取签到信息失败:', error);
    return { success: false, message: '获取签到信息失败' };
  }
};

export const doSignIn = async (userId: number): Promise<DoSignInResult> => {
  const todayKey = buildDateKey(new Date());
  const holidayInfo = getHolidayInfo(new Date());
  const reward = holidayInfo.isHoliday ? 50 : 10;

  try {
    return await withTransaction(async (client) => {
  const characterCheck = await client.query('SELECT id FROM characters WHERE user_id = $1 FOR UPDATE', [userId]);
      if (characterCheck.rows.length === 0) {
        return rollbackAndReturn(client, { success: false, message: '角色不存在，无法签到' });
      }
  
      const exist = await client.query(
        'SELECT id FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1',
        [userId, todayKey]
      );
      if (exist.rows.length > 0) {
        return rollbackAndReturn(client, { success: false, message: '今日已签到' });
      }
  
      await client.query(
        `
          INSERT INTO sign_in_records (user_id, sign_date, reward, is_holiday, holiday_name)
          VALUES ($1, $2::date, $3, $4, $5)
        `,
        [userId, todayKey, reward, holidayInfo.isHoliday, holidayInfo.holidayName]
      );
  
      const updated = await client.query(
        'UPDATE characters SET spirit_stones = spirit_stones + $1 WHERE user_id = $2 RETURNING spirit_stones',
        [reward, userId]
      );
  return {
        success: true,
        message: '签到成功',
        data: {
          date: todayKey,
          reward,
          isHoliday: holidayInfo.isHoliday,
          holidayName: holidayInfo.holidayName,
          spiritStones: Number(updated.rows[0]?.spirit_stones ?? 0),
        },
      };
    });
  } catch (error) {
    console.error('签到失败:', error);
    return { success: false, message: '签到失败' };
  }
};
