/**
 * 体力恢复服务
 *
 * 作用：
 *   管理角色体力的恢复计算与持久化。读取和写回都统一走角色写回缓存入口，
 *   让体力状态与角色主状态保持同一数据源。
 *
 * 输入：characterId / userId
 * 输出：StaminaRecoveryState（当前体力、恢复量、是否变更）
 *
 * 数据流：
 *   读取：角色写回缓存 → 计算恢复 → 如有变化则写回角色写回缓存
 *   事务内（applyStaminaRecoveryTx）：复用同一套角色写回入口，不再直读 `characters`
 *
 * 关键边界条件：
 *   1. 体力恢复依赖月卡有效窗口，窗口信息只从月卡 ownership 读取，不从角色表推导
 *   2. 体力上限依赖悟道等级，统一通过角色计算结果读取，避免在本文件里再查 `characters`
 */

import { query } from '../config/database.js';
import { getCharacterComputedByCharacterId } from './characterComputedService.js';
import {
  loadCharacterWritebackRowByCharacterId,
  loadCharacterWritebackRowByUserId,
  queueCharacterWritebackSnapshot,
} from './playerWritebackCacheService.js';
import {
  DEFAULT_MONTH_CARD_ID,
  getMonthCardStaminaRecoveryRate,
  normalizeMonthCardBenefitWindow,
} from './shared/monthCardBenefits.js';
import {
  resolveStaminaRecoveryState,
  STAMINA_BASE_MAX,
  type StaminaRecoverySpeedWindow,
} from './shared/staminaRules.js';

const toPositiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v > 0 ? v : fallback;
};

const toNonNegativeInt = (value: unknown, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  return v >= 0 ? v : fallback;
};

const parseTime = (value: unknown, fallbackMs: number): { ms: number; fallbackUsed: boolean } => {
  if (value instanceof Date) return { ms: value.getTime(), fallbackUsed: false };
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return { ms: parsed, fallbackUsed: false };
  }
  return { ms: fallbackMs, fallbackUsed: true };
};

export const STAMINA_MAX = STAMINA_BASE_MAX;
export const STAMINA_RECOVER_PER_TICK = toPositiveInt(process.env.STAMINA_RECOVER_PER_TICK, 1);
export const STAMINA_RECOVER_INTERVAL_SEC = toPositiveInt(process.env.STAMINA_RECOVER_INTERVAL_SEC, 300);
const STAMINA_RECOVER_INTERVAL_MS = STAMINA_RECOVER_INTERVAL_SEC * 1000;

export type StaminaRecoveryState = {
  characterId: number;
  stamina: number;
  maxStamina: number;
  recovered: number;
  changed: boolean;
  staminaRecoverAt: Date;
  recoverySpeedWindow: StaminaRecoverySpeedWindow;
};

type MonthCardOwnershipRow = {
  start_at: Date | string | number | null;
  expire_at: Date | string | number | null;
};

type CharacterRecoveryStateRow = {
  id: number;
  stamina: number;
  stamina_recover_at: string | null;
};

/**
 * 从统一角色状态和月卡窗口计算恢复结果。
 *
 * 作用：把体力计算逻辑收口成单一入口，避免读取侧和写回侧各自拼一套恢复公式。
 * 输入：角色快照、体力上限、月卡窗口、当前时间。
 * 输出：计算后的体力状态，必要时由调用方再写回角色快照。
 * 边界条件：
 * 1. 角色快照不能为空，否则无法继续恢复计算。
 * 2. 月卡窗口可能为空或已过期，`resolveStaminaRecoveryState` 会自行按窗口判断是否加速。
 */
const applyRecoveryFromState = (
  characterId: number,
  stamina: number,
  staminaRecoverAt: string | null,
  staminaMax: number,
  recoverySpeedWindow: StaminaRecoverySpeedWindow,
): StaminaRecoveryState => {
  const nowMs = Date.now();
  const currentStamina = Math.min(staminaMax, toNonNegativeInt(stamina, 0));
  const parsedRecoverAt = parseTime(staminaRecoverAt, nowMs);
  const recoveryResult = resolveStaminaRecoveryState({
    stamina: currentStamina,
    maxStamina: staminaMax,
    recoverAtMs: parsedRecoverAt.ms,
    nowMs,
    recoverPerTick: STAMINA_RECOVER_PER_TICK,
    recoverIntervalMs: STAMINA_RECOVER_INTERVAL_MS,
    recoverySpeedRate: getMonthCardStaminaRecoveryRate(),
    recoverySpeedWindow,
  });
  const nextStamina = recoveryResult.stamina;
  const nextRecoverAtMs = recoveryResult.nextRecoverAtMs;
  const recovered = recoveryResult.recovered;

  const staminaChanged = currentStamina !== nextStamina;
  const recoverAtChanged = parsedRecoverAt.fallbackUsed || nextRecoverAtMs !== parsedRecoverAt.ms;
  const changed = staminaChanged || recoverAtChanged;
  return {
    characterId,
    stamina: nextStamina,
    maxStamina: staminaMax,
    recovered,
    changed,
    staminaRecoverAt: new Date(nextRecoverAtMs),
    recoverySpeedWindow,
  };
};

const loadMonthCardRecoveryWindow = async (characterId: number): Promise<StaminaRecoverySpeedWindow> => {
  const rowRes = await query<MonthCardOwnershipRow>(
    `
      SELECT start_at, expire_at
      FROM month_card_ownership
      WHERE character_id = $1 AND month_card_id = $2
      LIMIT 1
    `,
    [characterId, DEFAULT_MONTH_CARD_ID],
  );
  const row = rowRes.rows[0] ?? null;
  return normalizeMonthCardBenefitWindow(row?.start_at ?? null, row?.expire_at ?? null);
};

const loadRecoveryStateByCharacterState = async (
  character: CharacterRecoveryStateRow,
): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(character.id) || character.id <= 0) return null;
  const computed = await getCharacterComputedByCharacterId(character.id, { bypassStaticCache: true });
  if (!computed) return null;
  const characterId = character.id;
  const recoverySpeedWindow = await loadMonthCardRecoveryWindow(characterId);
  return applyRecoveryFromState(
    characterId,
    character.stamina,
    character.stamina_recover_at,
    computed.stamina_max,
    recoverySpeedWindow,
  );
};

const loadRecoveryStateByCharacterId = async (
  characterId: number,
): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  const character = await loadCharacterWritebackRowByCharacterId(characterId);
  if (!character) return null;
  return loadRecoveryStateByCharacterState(character);
};

/**
 * 按角色 ID 获取体力状态（含恢复计算）
 *
 * 统一从角色写回快照读取，不再直查 `characters`
 */
export const applyStaminaRecoveryByCharacterId = async (characterId: number): Promise<StaminaRecoveryState | null> => {
  const current = await loadRecoveryStateByCharacterId(characterId);
  if (!current) return null;
  if (!current.changed) return current;
  await queueCharacterWritebackSnapshot(characterId, {
    stamina: current.stamina,
    stamina_recover_at: current.staminaRecoverAt.toISOString(),
  });
  return current;
};

/**
 * 按用户 ID 获取体力状态（含恢复计算）
 *
 * 先走角色写回缓存，再按统一体力公式计算。
 */
export const applyStaminaRecoveryByUserId = async (userId: number): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const character = await loadCharacterWritebackRowByUserId(userId);
  if (!character) return null;
  return loadRecoveryStateByCharacterState(character);
};

/**
 * 兼容旧调用名的体力状态读取入口。
 *
 * 统一读取角色写回快照，不再直查 `characters`。
 */
export const applyStaminaRecoveryTx = async (characterId: number): Promise<StaminaRecoveryState | null> => {
  return loadRecoveryStateByCharacterId(characterId);
};

/**
 * 按角色 ID 恢复体力（事务内）
 *
 * 设计说明：
 * 1. 先复用 `applyStaminaRecoveryTx` 拿到带行锁的当前体力，避免直接对过期值做加法。
 * 2. 体力恢复道具与自然恢复共用同一份 `stamina_recover_at` 状态：未回满时保留原计时，回满时写入当前时间并同步缓存。
 */
export const recoverStaminaByCharacterId = async (
  characterId: number,
  amount: number,
): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;

  const delta = toNonNegativeInt(amount, 0);
  const current = await loadRecoveryStateByCharacterId(characterId);
  if (!current) return null;
  if (delta <= 0) return current;

  const nextStamina = Math.min(current.maxStamina, current.stamina + delta);
  const nextRecoverAt =
    nextStamina >= current.maxStamina ? new Date() : current.staminaRecoverAt;
  const changed =
    nextStamina !== current.stamina ||
    nextRecoverAt.getTime() !== current.staminaRecoverAt.getTime();

  if (!changed) return current;

  await queueCharacterWritebackSnapshot(characterId, {
    stamina: nextStamina,
    stamina_recover_at: nextRecoverAt.toISOString(),
  });

  return {
    ...current,
    stamina: nextStamina,
    recovered: current.recovered + Math.max(0, nextStamina - current.stamina),
    changed: true,
    staminaRecoverAt: nextRecoverAt,
    recoverySpeedWindow: current.recoverySpeedWindow,
  };
};
