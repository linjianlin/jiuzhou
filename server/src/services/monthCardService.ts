import { pool, query } from '../config/database.js';
import { updateAchievementProgress } from './achievementService.js';

export type MonthCardStatusResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    name: string;
    description: string | null;
    durationDays: number;
    dailySpiritStones: number;
    priceSpiritStones: number;
    active: boolean;
    expireAt: string | null;
    daysLeft: number;
    today: string;
    lastClaimDate: string | null;
    canClaim: boolean;
    spiritStones: number;
  };
};

export type MonthCardBuyResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
    spiritStones: number;
  };
};

export type MonthCardUseItemResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    expireAt: string;
    daysLeft: number;
  };
};

export type MonthCardClaimResult = {
  success: boolean;
  message: string;
  data?: {
    monthCardId: string;
    date: string;
    rewardSpiritStones: number;
    spiritStones: number;
  };
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const buildDateKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const normalizeDateKey = (v: unknown) => {
  if (v instanceof Date) return buildDateKey(v);
  if (typeof v === 'string') return v.slice(0, 10);
  return '';
};

const asNumber = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const defaultMonthCardItemDefId = 'cons-monthcard-001';

export const getMonthCardStatus = async (userId: number, monthCardId: string): Promise<MonthCardStatusResult> => {
  try {
    const charRes = await query(`SELECT id, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1`, [userId]);
    if (charRes.rows.length === 0) return { success: false, message: '角色不存在' };
    const characterId = Number(charRes.rows[0].id);
    const spiritStones = Number(charRes.rows[0].spirit_stones ?? 0);

    const defRes = await query(
      `
        SELECT id, name, description, duration_days, daily_spirit_stones, price_spirit_stones
        FROM month_card_def
        WHERE id = $1 AND enabled = true
        LIMIT 1
      `,
      [monthCardId],
    );
    if (defRes.rows.length === 0) return { success: false, message: '月卡不存在' };
    const def = defRes.rows[0] as Record<string, unknown>;

    const ownRes = await query(
      `
        SELECT expire_at, last_claim_date
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
      `,
      [characterId, monthCardId],
    );

    const now = new Date();
    const todayKey = buildDateKey(now);

    const expireAtRaw = ownRes.rows[0]?.expire_at;
    const expireAt = expireAtRaw instanceof Date ? expireAtRaw : expireAtRaw ? new Date(String(expireAtRaw)) : null;
    const lastClaimDateKey = normalizeDateKey(ownRes.rows[0]?.last_claim_date);

    const active = Boolean(expireAt && expireAt.getTime() > now.getTime());
    const daysLeft = active && expireAt ? Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))) : 0;
    const canClaim = active && todayKey !== lastClaimDateKey;

    return {
      success: true,
      message: '获取成功',
      data: {
        monthCardId,
        name: String(def.name || ''),
        description: typeof def.description === 'string' ? def.description : null,
        durationDays: asNumber(def.duration_days, 30),
        dailySpiritStones: asNumber(def.daily_spirit_stones, 100),
        priceSpiritStones: asNumber(def.price_spirit_stones, 0),
        active,
        expireAt: expireAt ? expireAt.toISOString() : null,
        daysLeft,
        today: todayKey,
        lastClaimDate: lastClaimDateKey || null,
        canClaim,
        spiritStones,
      },
    };
  } catch (error) {
    console.error('获取月卡状态失败:', error);
    return { success: false, message: '获取月卡状态失败' };
  }
};

export const useMonthCardItem = async (
  userId: number,
  monthCardId: string,
  options?: { itemInstanceId?: number; itemDefId?: string },
): Promise<MonthCardUseItemResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const defRes = await client.query(
      `
        SELECT id, duration_days, enabled
        FROM month_card_def
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [monthCardId],
    );
    if (defRes.rows.length === 0 || defRes.rows[0]?.enabled === false) {
      await client.query('ROLLBACK');
      return { success: false, message: '月卡不存在或未启用' };
    }
    const durationDays = asNumber(defRes.rows[0]?.duration_days, 30);

    const charRes = await client.query(`SELECT id FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE`, [userId]);
    if (charRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(charRes.rows[0].id);

    const itemDefId = options?.itemDefId || defaultMonthCardItemDefId;

    let itemInstanceRow: { id: number; qty: number } | null = null;
    if (Number.isInteger(options?.itemInstanceId) && Number(options?.itemInstanceId) > 0) {
      const instanceResult = await client.query(
        `
          SELECT id, qty
          FROM item_instance
          WHERE id = $1
            AND owner_character_id = $2
            AND item_def_id = $3
            AND location = 'bag'
          LIMIT 1
          FOR UPDATE
        `,
        [Number(options?.itemInstanceId), characterId, itemDefId],
      );
      if (instanceResult.rows.length > 0) {
        itemInstanceRow = { id: Number(instanceResult.rows[0].id), qty: Number(instanceResult.rows[0].qty) };
      }
    } else {
      const instanceResult = await client.query(
        `
          SELECT id, qty
          FROM item_instance
          WHERE owner_character_id = $1
            AND item_def_id = $2
            AND location = 'bag'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE
        `,
        [characterId, itemDefId],
      );
      if (instanceResult.rows.length > 0) {
        itemInstanceRow = { id: Number(instanceResult.rows[0].id), qty: Number(instanceResult.rows[0].qty) };
      }
    }

    if (!itemInstanceRow || !Number.isFinite(itemInstanceRow.qty) || itemInstanceRow.qty <= 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '背包中没有可用的月卡道具' };
    }

    if (itemInstanceRow.qty === 1) {
      await client.query(`DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2`, [itemInstanceRow.id, characterId]);
    } else {
      await client.query(`UPDATE item_instance SET qty = qty - 1, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2`, [
        itemInstanceRow.id,
        characterId,
      ]);
    }

    const ownRes = await client.query(
      `
        SELECT id, start_at, expire_at
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, monthCardId],
    );

    const now = new Date();
    const ownExpireAtRaw = ownRes.rows[0]?.expire_at;
    const ownExpireAt = ownExpireAtRaw ? new Date(ownExpireAtRaw) : null;
    const baseMs = ownExpireAt && ownExpireAt.getTime() > now.getTime() ? ownExpireAt.getTime() : now.getTime();
    const nextExpireAt = new Date(baseMs + durationDays * 24 * 60 * 60 * 1000);

    if (ownRes.rows.length > 0) {
      const shouldResetStart = !ownExpireAt || ownExpireAt.getTime() <= now.getTime();
      if (shouldResetStart) {
        await client.query(`UPDATE month_card_ownership SET start_at = NOW(), expire_at = $1, updated_at = NOW() WHERE id = $2`, [
          nextExpireAt.toISOString(),
          ownRes.rows[0].id,
        ]);
      } else {
        await client.query(`UPDATE month_card_ownership SET expire_at = $1, updated_at = NOW() WHERE id = $2`, [
          nextExpireAt.toISOString(),
          ownRes.rows[0].id,
        ]);
      }
    } else {
      await client.query(
        `
          INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
          VALUES ($1, $2, NOW(), $3)
        `,
        [characterId, monthCardId, nextExpireAt.toISOString()],
      );
    }

    await client.query('COMMIT');

    try {
      await updateAchievementProgress(characterId, 'monthcard:activate', 1);
    } catch {}

    const daysLeft = Math.max(0, Math.ceil((nextExpireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      success: true,
      message: '使用成功',
      data: {
        monthCardId,
        expireAt: nextExpireAt.toISOString(),
        daysLeft,
      },
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('使用月卡道具失败:', error);
    return { success: false, message: '使用月卡道具失败' };
  } finally {
    client.release();
  }
};

export const buyMonthCard = async (userId: number, monthCardId: string): Promise<MonthCardBuyResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const defRes = await client.query(
      `
        SELECT id, duration_days, price_spirit_stones, enabled
        FROM month_card_def
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [monthCardId],
    );
    if (defRes.rows.length === 0 || defRes.rows[0]?.enabled === false) {
      await client.query('ROLLBACK');
      return { success: false, message: '月卡不存在或未启用' };
    }
    const durationDays = asNumber(defRes.rows[0]?.duration_days, 30);
    const priceSpiritStones = BigInt(defRes.rows[0]?.price_spirit_stones ?? 0);

    const charRes = await client.query(`SELECT id, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE`, [userId]);
    if (charRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(charRes.rows[0].id);
    const curStones = BigInt(charRes.rows[0]?.spirit_stones ?? 0);
    if (priceSpiritStones > 0n && curStones < priceSpiritStones) {
      await client.query('ROLLBACK');
      return { success: false, message: `灵石不足，需要${priceSpiritStones.toString()}` };
    }

    let nextStones = curStones;
    if (priceSpiritStones > 0n) {
      const updated = await client.query(
        `UPDATE characters SET spirit_stones = spirit_stones - $1, updated_at = NOW() WHERE id = $2 RETURNING spirit_stones`,
        [priceSpiritStones.toString(), characterId],
      );
      nextStones = BigInt(updated.rows[0]?.spirit_stones ?? nextStones);
    }

    const ownRes = await client.query(
      `
        SELECT id, expire_at
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, monthCardId],
    );

    const now = new Date();
    const baseMs = ownRes.rows[0]?.expire_at ? new Date(ownRes.rows[0].expire_at).getTime() : 0;
    const startMs = Math.max(now.getTime(), baseMs);
    const expireAt = new Date(startMs + durationDays * 24 * 60 * 60 * 1000);

    if (ownRes.rows.length > 0) {
      await client.query(`UPDATE month_card_ownership SET expire_at = $1, updated_at = NOW() WHERE id = $2`, [
        expireAt.toISOString(),
        ownRes.rows[0].id,
      ]);
    } else {
      await client.query(
        `
          INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
          VALUES ($1, $2, NOW(), $3)
        `,
        [characterId, monthCardId, expireAt.toISOString()],
      );
    }

    await client.query('COMMIT');

    try {
      await updateAchievementProgress(characterId, 'monthcard:activate', 1);
    } catch {}

    const daysLeft = Math.max(0, Math.ceil((expireAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      success: true,
      message: '购买成功',
      data: {
        monthCardId,
        expireAt: expireAt.toISOString(),
        daysLeft,
        spiritStones: Number(nextStones),
      },
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('购买月卡失败:', error);
    return { success: false, message: '购买月卡失败' };
  } finally {
    client.release();
  }
};

export const claimMonthCardReward = async (userId: number, monthCardId: string): Promise<MonthCardClaimResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const charRes = await client.query(`SELECT id FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE`, [userId]);
    if (charRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(charRes.rows[0].id);

    const defRes = await client.query(
      `
        SELECT daily_spirit_stones, enabled
        FROM month_card_def
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [monthCardId],
    );
    if (defRes.rows.length === 0 || defRes.rows[0]?.enabled === false) {
      await client.query('ROLLBACK');
      return { success: false, message: '月卡不存在或未启用' };
    }
    const reward = asNumber(defRes.rows[0]?.daily_spirit_stones, 100);

    const ownRes = await client.query(
      `
        SELECT id, expire_at, last_claim_date
        FROM month_card_ownership
        WHERE character_id = $1 AND month_card_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [characterId, monthCardId],
    );
    if (ownRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, message: '未激活月卡' };
    }

    const now = new Date();
    const todayKey = buildDateKey(now);
    const expireAt = ownRes.rows[0]?.expire_at ? new Date(ownRes.rows[0].expire_at) : null;
    if (!expireAt || expireAt.getTime() <= now.getTime()) {
      await client.query('ROLLBACK');
      return { success: false, message: '月卡已到期' };
    }

    const lastClaimDateKey = normalizeDateKey(ownRes.rows[0]?.last_claim_date);
    if (lastClaimDateKey === todayKey) {
      await client.query('ROLLBACK');
      return { success: false, message: '今日已领取' };
    }

    await client.query(
      `
        INSERT INTO month_card_claim_record (character_id, month_card_id, claim_date, reward_spirit_stones)
        VALUES ($1, $2, $3::date, $4)
        ON CONFLICT (character_id, month_card_id, claim_date) DO NOTHING
      `,
      [characterId, monthCardId, todayKey, reward],
    );

    const updated = await client.query(
      `UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2 RETURNING spirit_stones`,
      [reward, characterId],
    );

    await client.query(
      `UPDATE month_card_ownership SET last_claim_date = $1::date, updated_at = NOW() WHERE id = $2`,
      [todayKey, ownRes.rows[0].id],
    );

    await client.query('COMMIT');

    return {
      success: true,
      message: '领取成功',
      data: {
        monthCardId,
        date: todayKey,
        rewardSpiritStones: reward,
        spiritStones: Number(updated.rows[0]?.spirit_stones ?? 0),
      },
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    console.error('领取月卡奖励失败:', error);
    return { success: false, message: '领取月卡奖励失败' };
  } finally {
    client.release();
  }
};

export default { getMonthCardStatus, useMonthCardItem, buyMonthCard, claimMonthCardReward };
