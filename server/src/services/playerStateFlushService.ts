/**
 * 玩家状态 flush 服务
 *
 * 作用：
 * 1. 做什么：把 Redis 主状态按角色刷回 PostgreSQL，并基于版本号决定是否清理 dirty。
 * 2. 做什么：统一承接定时 flush、按角色 flush、全量 flush 的底层实现，避免业务层直接拼刷库 SQL。
 * 3. 不做什么：不负责业务层 patch，不处理角色/物品数值规则。
 *
 * 输入/输出：
 * - 输入：characterId 或 dirty 角色集合。
 * - 输出：flush 完成后的版本清理结果。
 *
 * 数据流/状态流：
 * Redis 主状态 -> flush lock -> PostgreSQL -> 版本比对 -> 清 dirty 或保留 dirty。
 *
 * 关键边界条件与坑点：
 * 1. flush 前必须读取 meta.version；否则无法判断刷库期间是否有新写入。
 * 2. 物品刷库不能只更新存在的行，还必须删除 Redis 中已移除的旧 DB 行。
 */
import { query, withTransaction } from '../config/database.js';
import {
  PLAYER_CHARACTER_JSON_FIELDS,
  PLAYER_CHARACTER_TIMESTAMP_FIELDS,
  PLAYER_INVENTORY_JSON_FIELDS,
  PLAYER_INVENTORY_TIMESTAMP_FIELDS,
  type PlayerCharacterState,
  type PlayerInventoryItemState,
} from './playerStateTypes.js';
import {
  loadDirtyPlayerStateCharacterIds,
  loadPlayerCharacterStateByCharacterId,
  loadPlayerInventoryStatesByCharacterId,
  loadPlayerStateMetaByCharacterId,
  markPlayerStateFlushedIfVersionUnchanged,
  withPlayerStateFlushLock,
} from './playerStateRepository.js';

const buildSqlAssignment = (column: string, placeholder: string, kind: 'plain' | 'json' | 'timestamp'): string => {
  if (kind === 'json') {
    return `${column} = ${placeholder}::jsonb`;
  }
  if (kind === 'timestamp') {
    return `${column} = ${placeholder}::timestamptz`;
  }
  return `${column} = ${placeholder}`;
};

const flushCharacterState = async (state: PlayerCharacterState): Promise<void> => {
  const params: Array<boolean | number | string | null> = [state.id];
  const clauses: string[] = [];
  let paramIndex = 2;

  for (const [column, rawValue] of Object.entries(state)) {
    if (column === 'id' || column === 'user_id') continue;
    const key = column as keyof PlayerCharacterState;
    const placeholder = `$${paramIndex}`;
    const kind = PLAYER_CHARACTER_JSON_FIELDS.has(key)
      ? 'json'
      : PLAYER_CHARACTER_TIMESTAMP_FIELDS.has(key)
        ? 'timestamp'
        : 'plain';
    clauses.push(buildSqlAssignment(column, placeholder, kind));
    params.push(kind === 'json' ? JSON.stringify(rawValue) : (rawValue as boolean | number | string | null));
    paramIndex += 1;
  }

  if (clauses.length <= 0) return;
  await query(
    `
      UPDATE characters
      SET ${clauses.join(', ')},
          updated_at = NOW()
      WHERE id = $1
    `,
    params,
  );
};

const flushInventoryStates = async (
  characterId: number,
  inventoryStates: PlayerInventoryItemState[],
): Promise<void> => {
  const result = await query(
    `
      SELECT id
      FROM item_instance
      WHERE owner_character_id = $1
    `,
    [characterId],
  );
  const dbIds = new Set(
    (result.rows as Array<Record<string, unknown>>)
      .map((row) => Number(row.id))
      .filter((itemId) => Number.isFinite(itemId) && itemId > 0),
  );
  const redisIds = new Set(inventoryStates.map((item) => item.id));

  for (const itemId of dbIds) {
    if (redisIds.has(itemId)) continue;
    await query('DELETE FROM item_instance WHERE owner_character_id = $1 AND id = $2', [characterId, itemId]);
  }

  for (const state of inventoryStates) {
    const columns = Object.keys(state);
    const insertColumns = columns.join(', ');
    const insertValues: Array<boolean | number | string | null> = [];
    const placeholders = columns.map((column, index) => {
      const key = column as keyof PlayerInventoryItemState;
      const value = state[key];
      const kind = PLAYER_INVENTORY_JSON_FIELDS.has(key)
        ? 'json'
        : PLAYER_INVENTORY_TIMESTAMP_FIELDS.has(key)
          ? 'timestamp'
          : 'plain';
      insertValues.push(kind === 'json' ? JSON.stringify(value) : (value as boolean | number | string | null));
      if (kind === 'json') return `$${index + 1}::jsonb`;
      if (kind === 'timestamp') return `$${index + 1}::timestamptz`;
      return `$${index + 1}`;
    });
    const updateClauses = columns
      .filter((column) => column !== 'id' && column !== 'owner_character_id' && column !== 'created_at')
      .map((column) => `${column} = EXCLUDED.${column}`);

    await query(
      `
        INSERT INTO item_instance (${insertColumns})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT (id)
        DO UPDATE SET
          ${updateClauses.join(', ')},
          updated_at = NOW()
      `,
      insertValues,
    );
  }
};

export const flushPlayerStateByCharacterId = async (characterId: number): Promise<void> => {
  await withPlayerStateFlushLock(characterId, async () => {
    const meta = await loadPlayerStateMetaByCharacterId(characterId);
    if (!meta) return;
    if (!meta.dirtyCharacter && !meta.dirtyInventory) return;

    const [characterState, inventoryStates] = await Promise.all([
      loadPlayerCharacterStateByCharacterId(characterId),
      loadPlayerInventoryStatesByCharacterId(characterId),
    ]);
    if (!characterState) return;

    await withTransaction(async () => {
      await flushCharacterState(characterState);
      await flushInventoryStates(characterId, inventoryStates);
    });

    await markPlayerStateFlushedIfVersionUnchanged(characterId, meta.version);
  });
};

export const flushAllPlayerStates = async (): Promise<void> => {
  const dirtyCharacterIds = await loadDirtyPlayerStateCharacterIds();
  for (const characterId of dirtyCharacterIds) {
    await flushPlayerStateByCharacterId(characterId);
  }
};
