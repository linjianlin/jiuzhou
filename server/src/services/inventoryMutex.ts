import type { PoolClient } from 'pg';
import { query } from '../config/database.js';

const INVENTORY_MUTEX_NAMESPACE = 3101;

const normalizeCharacterIds = (characterIds: number[]): number[] =>
  [...new Set(characterIds)]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

export const lockCharacterInventoryMutexTx = async (
  client: PoolClient | null,
  characterId: number
): Promise<void> => {
  const sql = 'SELECT pg_advisory_xact_lock($1::integer, $2::integer)';
  const params = [INVENTORY_MUTEX_NAMESPACE, characterId];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
};

export const lockCharacterInventoryMutexesTx = async (
  client: PoolClient | null,
  characterIds: number[]
): Promise<void> => {
  const ids = normalizeCharacterIds(characterIds);
  for (const characterId of ids) {
    await lockCharacterInventoryMutexTx(client, characterId);
  }
};

