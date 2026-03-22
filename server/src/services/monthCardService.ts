import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { getGameServer } from '../game/gameServer.js';
import { updateAchievementProgress } from './achievementService.js';
import { consumeSpecificItemInstance } from './inventory/shared/consume.js';
import { loadPlayerInventoryStatesByCharacterId } from './playerStateRepository.js';
import {
  loadCharacterWritebackRowByUserId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';
import { invalidateStaminaCache } from './staminaCacheService.js';
import {
  DEFAULT_MONTH_CARD_ITEM_DEF_ID,
  getMonthCardBenefitValues,
  getMonthCardDefinitionById,
  type MonthCardBenefitValues,
} from './shared/monthCardBenefits.js';

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
    benefits: MonthCardBenefitValues;
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

const pickMonthCardItemInstanceId = async (
  characterId: number,
  itemDefId: string,
  options?: { itemInstanceId?: number; itemDefId?: string },
): Promise<number | null> => {
  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  const monthCardItems = inventoryStates.filter((item) => {
    return (
      item.item_def_id === itemDefId &&
      item.location === 'bag' &&
      !item.locked &&
      Number(item.qty) > 0
    );
  });

  if (Number.isInteger(options?.itemInstanceId) && Number(options?.itemInstanceId) > 0) {
    const selectedItem = monthCardItems.find((item) => item.id === Number(options?.itemInstanceId));
    return selectedItem ? selectedItem.id : null;
  }

  const [earliestItem] = monthCardItems.sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : Number.MAX_SAFE_INTEGER;
    const rightTime = right.created_at ? Date.parse(right.created_at) : Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id - right.id;
  });
  return earliestItem ? earliestItem.id : null;
};

const asNumber = (v: unknown, fallback: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const defaultDailySpiritStones = 10000;

class MonthCardService {
  async getMonthCardStatus(userId: number, monthCardId: string): Promise<MonthCardStatusResult> {
    const characterRow = await loadCharacterWritebackRowByUserId(userId);
    if (!characterRow) return { success: false, message: '角色不存在' };
    const characterId = Number(characterRow.id);
    const spiritStones = Number(characterRow.spirit_stones ?? 0);

    const def = getMonthCardDefinitionById(monthCardId);
    if (!def) return { success: false, message: '月卡不存在' };
    const benefits = getMonthCardBenefitValues(monthCardId);

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
        dailySpiritStones: asNumber(def.daily_spirit_stones, defaultDailySpiritStones),
        priceSpiritStones: asNumber(def.price_spirit_stones, 0),
        benefits,
        active,
        expireAt: expireAt ? expireAt.toISOString() : null,
        daysLeft,
        today: todayKey,
        lastClaimDate: lastClaimDateKey || null,
        canClaim,
        spiritStones,
      },
    };
  }

  @Transactional
  async useMonthCardItem(
    userId: number,
    monthCardId: string,
    options?: { itemInstanceId?: number; itemDefId?: string },
  ): Promise<MonthCardUseItemResult> {
    const monthCardDef = getMonthCardDefinitionById(monthCardId);
    if (!monthCardDef) {
      return { success: false, message: '月卡不存在或未启用' };
    }

    const durationDays = asNumber(monthCardDef.duration_days, 30);

    const characterRow = await loadCharacterWritebackRowByUserId(userId, { forUpdate: true });
    if (!characterRow) {
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(characterRow.id);

    const itemDefId = options?.itemDefId || DEFAULT_MONTH_CARD_ITEM_DEF_ID;
    const itemInstanceId = await pickMonthCardItemInstanceId(characterId, itemDefId, options);
    if (!itemInstanceId) {
      return { success: false, message: '背包中没有可用的月卡道具' };
    }
    const consumeRes = await consumeSpecificItemInstance(characterId, itemInstanceId, 1);
    if (!consumeRes.success) {
      return { success: false, message: consumeRes.message };
    }

    const ownRes = await query(
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
        await query(`UPDATE month_card_ownership SET start_at = NOW(), expire_at = $1, updated_at = NOW() WHERE id = $2`, [
          nextExpireAt.toISOString(),
          ownRes.rows[0].id,
        ]);
      } else {
        await query(`UPDATE month_card_ownership SET expire_at = $1, updated_at = NOW() WHERE id = $2`, [
          nextExpireAt.toISOString(),
          ownRes.rows[0].id,
        ]);
      }
    } else {
      await query(
        `
          INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
          VALUES ($1, $2, NOW(), $3)
        `,
        [characterId, monthCardId, nextExpireAt.toISOString()],
      );
    }
    await updateAchievementProgress(characterId, 'monthcard:activate', 1);
    await invalidateStaminaCache(characterId);
    void getGameServer().pushCharacterUpdate(userId);

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
  }

  @Transactional
  async buyMonthCard(userId: number, monthCardId: string): Promise<MonthCardBuyResult> {
    const monthCardDef = getMonthCardDefinitionById(monthCardId);
    if (!monthCardDef) {
      return { success: false, message: '月卡不存在或未启用' };
    }

    const durationDays = asNumber(monthCardDef.duration_days, 30);
    const priceSpiritStones = BigInt(monthCardDef.price_spirit_stones ?? 0);

    const currentCharacterRow = await loadCharacterWritebackRowByUserId(userId, { forUpdate: true });
    if (!currentCharacterRow) {
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(currentCharacterRow.id);
    const curStones = BigInt(Number(currentCharacterRow.spirit_stones ?? 0));
    if (priceSpiritStones > 0n && curStones < priceSpiritStones) {
      return { success: false, message: `灵石不足，需要${priceSpiritStones.toString()}` };
    }

    const nextStones = curStones - priceSpiritStones;
    await queueCharacterWritebackSnapshot(characterId, {
      ...currentCharacterRow,
      spirit_stones: Number(nextStones),
    });

    const ownRes = await query(
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
      await query(`UPDATE month_card_ownership SET expire_at = $1, updated_at = NOW() WHERE id = $2`, [
        expireAt.toISOString(),
        ownRes.rows[0].id,
      ]);
    } else {
      await query(
        `
          INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at)
          VALUES ($1, $2, NOW(), $3)
        `,
        [characterId, monthCardId, expireAt.toISOString()],
      );
    }
    await updateAchievementProgress(characterId, 'monthcard:activate', 1);
    await invalidateStaminaCache(characterId);
    void getGameServer().pushCharacterUpdate(userId);

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
  }

  @Transactional
  async claimMonthCardReward(userId: number, monthCardId: string): Promise<MonthCardClaimResult> {
    const monthCardDef = getMonthCardDefinitionById(monthCardId);
    if (!monthCardDef) {
      return { success: false, message: '月卡不存在或未启用' };
    }

    const currentCharacterRow = await loadCharacterWritebackRowByUserId(userId, { forUpdate: true });
    if (!currentCharacterRow) {
      return { success: false, message: '角色不存在' };
    }
    const characterId = Number(currentCharacterRow.id);

    const reward = asNumber(monthCardDef.daily_spirit_stones, defaultDailySpiritStones);

    const ownRes = await query(
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
      return { success: false, message: '未激活月卡' };
    }

    const now = new Date();
    const todayKey = buildDateKey(now);
    const expireAt = ownRes.rows[0]?.expire_at ? new Date(ownRes.rows[0].expire_at) : null;
    if (!expireAt || expireAt.getTime() <= now.getTime()) {
      return { success: false, message: '月卡已到期' };
    }

    const lastClaimDateKey = normalizeDateKey(ownRes.rows[0]?.last_claim_date);
    if (lastClaimDateKey === todayKey) {
      return { success: false, message: '今日已领取' };
    }
    await query(
      `
        INSERT INTO month_card_claim_record (character_id, month_card_id, claim_date, reward_spirit_stones)
        VALUES ($1, $2, $3::date, $4)
        ON CONFLICT (character_id, month_card_id, claim_date) DO NOTHING
      `,
      [characterId, monthCardId, todayKey, reward],
    );

    const nextSpiritStones = Number(currentCharacterRow.spirit_stones ?? 0) + reward;
    await queueCharacterWritebackSnapshot(characterId, {
      ...currentCharacterRow,
      spirit_stones: nextSpiritStones,
    });

    await query(
      `UPDATE month_card_ownership SET last_claim_date = $1::date, updated_at = NOW() WHERE id = $2`,
      [todayKey, ownRes.rows[0].id],
    );

    return {
      success: true,
      message: '领取成功',
      data: {
        monthCardId,
        date: todayKey,
        rewardSpiritStones: reward,
        spiritStones: nextSpiritStones,
      },
    };
  }
}

export const monthCardService = new MonthCardService();
