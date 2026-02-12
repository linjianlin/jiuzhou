import type { PoolClient } from 'pg';
import { query } from '../config/database.js';

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

export const STAMINA_MAX = toPositiveInt(process.env.STAMINA_MAX, 100);
export const STAMINA_RECOVER_PER_TICK = toPositiveInt(process.env.STAMINA_RECOVER_PER_TICK, 1);
export const STAMINA_RECOVER_INTERVAL_SEC = toPositiveInt(process.env.STAMINA_RECOVER_INTERVAL_SEC, 300);
const STAMINA_RECOVER_INTERVAL_MS = STAMINA_RECOVER_INTERVAL_SEC * 1000;

export type StaminaRecoveryState = {
  characterId: number;
  stamina: number;
  recovered: number;
  changed: boolean;
  staminaRecoverAt: Date;
};

type QueryRunner = (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

const applyRecoveryFromRow = async (
  runQuery: QueryRunner,
  row: Record<string, unknown>,
): Promise<StaminaRecoveryState | null> => {
  const characterId = toNonNegativeInt(row.id, 0);
  if (characterId <= 0) return null;

  const nowMs = Date.now();
  const rawStamina = toNonNegativeInt(row.stamina, 0);
  const currentStamina = Math.min(STAMINA_MAX, rawStamina);
  const parsedRecoverAt = parseTime(row.stamina_recover_at, nowMs);

  let nextStamina = currentStamina;
  let nextRecoverAtMs = parsedRecoverAt.ms;
  let recovered = 0;

  if (currentStamina < STAMINA_MAX && STAMINA_RECOVER_INTERVAL_MS > 0 && STAMINA_RECOVER_PER_TICK > 0) {
    const elapsedMs = Math.max(0, nowMs - parsedRecoverAt.ms);
    const ticks = Math.floor(elapsedMs / STAMINA_RECOVER_INTERVAL_MS);
    if (ticks > 0) {
      const recoveredTotal = ticks * STAMINA_RECOVER_PER_TICK;
      nextStamina = Math.min(STAMINA_MAX, currentStamina + recoveredTotal);
      nextRecoverAtMs = nextStamina >= STAMINA_MAX ? nowMs : parsedRecoverAt.ms + ticks * STAMINA_RECOVER_INTERVAL_MS;
      recovered = Math.max(0, nextStamina - currentStamina);
    }
  }

  const staminaChanged = rawStamina !== nextStamina;
  const recoverAtChanged = parsedRecoverAt.fallbackUsed || nextRecoverAtMs !== parsedRecoverAt.ms;
  const changed = staminaChanged || recoverAtChanged;

  if (changed) {
    if (staminaChanged) {
      await runQuery(
        'UPDATE characters SET stamina = $2, stamina_recover_at = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [characterId, nextStamina, new Date(nextRecoverAtMs)],
      );
    } else {
      await runQuery('UPDATE characters SET stamina_recover_at = $2 WHERE id = $1', [characterId, new Date(nextRecoverAtMs)]);
    }
  }

  return {
    characterId,
    stamina: nextStamina,
    recovered,
    changed,
    staminaRecoverAt: new Date(nextRecoverAtMs),
  };
};

const applyRecoveryByCharacterIdWithRunner = async (
  runQuery: QueryRunner,
  characterId: number,
  lockRow: boolean,
): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(characterId) || characterId <= 0) return null;
  const selectSql = lockRow
    ? 'SELECT id, stamina, stamina_recover_at FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE'
    : 'SELECT id, stamina, stamina_recover_at FROM characters WHERE id = $1 LIMIT 1';
  const rowRes = await runQuery(selectSql, [characterId]);
  const row = rowRes.rows[0];
  if (!row) return null;
  return applyRecoveryFromRow(runQuery, row);
};

export const applyStaminaRecoveryByCharacterId = async (characterId: number): Promise<StaminaRecoveryState | null> => {
  return applyRecoveryByCharacterIdWithRunner((text, params) => query(text, params), characterId, false);
};

export const applyStaminaRecoveryByUserId = async (userId: number): Promise<StaminaRecoveryState | null> => {
  if (!Number.isFinite(userId) || userId <= 0) return null;
  const rowRes = await query('SELECT id, stamina, stamina_recover_at FROM characters WHERE user_id = $1 LIMIT 1', [userId]);
  const row = rowRes.rows[0];
  if (!row) return null;
  return applyRecoveryFromRow((text, params) => query(text, params), row);
};

export const applyStaminaRecoveryTx = async (client: PoolClient, characterId: number): Promise<StaminaRecoveryState | null> => {
  const runQuery: QueryRunner = (text, params) => client.query(text, params);
  return applyRecoveryByCharacterIdWithRunner(runQuery, characterId, true);
};
