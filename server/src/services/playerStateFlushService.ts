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
 * 3. 背包/仓库槽位存在唯一索引；交换槽位或整理背包时必须先腾空旧槽位，再写最终槽位，避免中间态撞库。
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

type InventorySlotSnapshot = Pick<PlayerInventoryItemState, 'id' | 'location' | 'location_slot'>;

const buildSqlAssignment = (column: string, placeholder: string, kind: 'plain' | 'json' | 'timestamp'): string => {
  if (kind === 'json') {
    return `${column} = ${placeholder}::jsonb`;
  }
  if (kind === 'timestamp') {
    return `${column} = ${placeholder}::timestamptz`;
  }
  return `${column} = ${placeholder}`;
};

const isSlottedInventoryLocation = (location: string): location is 'bag' | 'warehouse' => {
  return location === 'bag' || location === 'warehouse';
};

const buildInventorySlotKey = (
  snapshot: InventorySlotSnapshot,
): string | null => {
  if (!isSlottedInventoryLocation(snapshot.location)) {
    return null;
  }
  if (snapshot.location_slot === null) {
    return null;
  }
  return `${snapshot.location}:${snapshot.location_slot}`;
};

const assertInventorySlotsUnique = (
  characterId: number,
  inventoryStates: PlayerInventoryItemState[],
): void => {
  const occupiedSlotMap = new Map<string, number>();

  for (const state of inventoryStates) {
    const slotKey = buildInventorySlotKey(state);
    if (slotKey === null) {
      continue;
    }
    const occupiedItemId = occupiedSlotMap.get(slotKey);
    if (occupiedItemId === undefined) {
      occupiedSlotMap.set(slotKey, state.id);
      continue;
    }
    throw new Error(
      `角色 ${characterId} 物品槽位冲突: 物品 ${occupiedItemId} 与 ${state.id} 同时占用 ${slotKey}`,
    );
  }
};

const clearMovedInventorySlots = async (
  characterId: number,
  dbStates: InventorySlotSnapshot[],
  inventoryStates: PlayerInventoryItemState[],
): Promise<void> => {
  const nextStateById = new Map(inventoryStates.map((state) => [state.id, state] as const));

  for (const dbState of dbStates) {
    const currentSlotKey = buildInventorySlotKey(dbState);
    if (currentSlotKey === null) {
      continue;
    }

    const nextState = nextStateById.get(dbState.id);
    if (!nextState) {
      continue;
    }

    const nextSlotKey = buildInventorySlotKey(nextState);
    if (nextSlotKey === currentSlotKey) {
      continue;
    }

    await query(
      `
        UPDATE item_instance
        SET location_slot = NULL,
            updated_at = NOW()
        WHERE owner_character_id = $1
          AND id = $2
          AND location IN ('bag', 'warehouse')
          AND location_slot IS NOT NULL
      `,
      [characterId, dbState.id],
    );
  }
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
  assertInventorySlotsUnique(characterId, inventoryStates);

  const result = await query(
    `
      SELECT id, location, location_slot
      FROM item_instance
      WHERE owner_character_id = $1
    `,
    [characterId],
  );
  const dbStates = (result.rows as Array<Record<string, unknown>>)
    .map((row) => ({
      id: Number(row.id),
      location: typeof row.location === 'string' ? row.location : '',
      location_slot:
        row.location_slot === null || row.location_slot === undefined
          ? null
          : Number(row.location_slot),
    }))
    .filter((row) => Number.isFinite(row.id) && row.id > 0);
  const dbIds = new Set(dbStates.map((row) => row.id));
  const redisIds = new Set(inventoryStates.map((item) => item.id));

  for (const itemId of dbIds) {
    if (redisIds.has(itemId)) continue;
    await query('DELETE FROM item_instance WHERE owner_character_id = $1 AND id = $2', [characterId, itemId]);
  }

  await clearMovedInventorySlots(characterId, dbStates, inventoryStates);

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

/**
 * 同步角色库存镜像到 PostgreSQL。
 *
 * 作用：
 * 1. 做什么：把当前 Redis 主状态中的库存快照立即刷到 `item_instance`，让数据库槽位唯一约束与运行时背包视图保持一致。
 * 2. 不做什么：不清理 dirty 标记，不处理角色主状态，也不替调用方分配槽位或创建新实例。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：无；保证当前事务里 PostgreSQL 库存镜像已对齐到 Redis 最新库存状态。
 *
 * 数据流/状态流：
 * 调用方 -> 读取 Redis inventory 主状态 -> `flushInventoryStates` -> PostgreSQL `item_instance` 镜像。
 *
 * 关键边界条件与坑点：
 * 1. 该入口只同步库存镜像，不会改写 meta.version/dirty；调用方不能把它当成完整 flush 完成信号。
 * 2. 调用方应先保证同角色背包写路径已串行化，否则并发改槽位时仍可能拿到相互覆盖的库存快照。
 */
export const syncInventoryMirrorByCharacterId = async (
  characterId: number,
): Promise<void> => {
  const inventoryStates = await loadPlayerInventoryStatesByCharacterId(characterId);
  await withTransaction(async () => {
    await flushInventoryStates(characterId, inventoryStates);
  });
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
