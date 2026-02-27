import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../config/database.js';
import { getItemDefinitions } from './staticConfigLoader.js';

/**
 * 启动时物品脏数据清理服务
 *
 * 作用：
 * - 清理数据库中 item_def_id 已经无法在静态定义中找到的数据；
 * - 仅处理“物品实例 + 物品运行时状态”三张表，避免误删无关业务数据。
 *
 * 输入：
 * - 无（启动流程直接调用）。
 *
 * 输出：
 * - 返回本次清理统计（每张表删除条数 + 有效定义数量）。
 *
 * 关键约束：
 * - 若静态物品定义为空，直接抛错中止清理，避免“全量误删”。
 * - 使用事务，保证三张表清理要么全部成功，要么全部回滚。
 */

type CleanupTargetTable = 'item_instance' | 'item_use_cooldown' | 'item_use_count';

interface ItemDataCleanupSqlMap {
  [key: string]: string;
}

const DELETE_UNDEFINED_ITEM_SQL: ItemDataCleanupSqlMap = {
  item_instance: `
    DELETE FROM item_instance
    WHERE item_def_id IS NULL
      OR btrim(item_def_id) = ''
      OR NOT (btrim(item_def_id) = ANY($1::varchar[]))
  `,
  item_use_cooldown: `
    DELETE FROM item_use_cooldown
    WHERE item_def_id IS NULL
      OR btrim(item_def_id) = ''
      OR NOT (btrim(item_def_id) = ANY($1::varchar[]))
  `,
  item_use_count: `
    DELETE FROM item_use_count
    WHERE item_def_id IS NULL
      OR btrim(item_def_id) = ''
      OR NOT (btrim(item_def_id) = ANY($1::varchar[]))
  `,
};

const collectValidItemDefIds = (): string[] => {
  const idSet = new Set<string>();
  for (const entry of getItemDefinitions()) {
    const id = String(entry.id || '').trim();
    if (!id) continue;
    idSet.add(id);
  }
  return Array.from(idSet);
};

const deleteUndefinedItemDefRows = async (
  client: PoolClient,
  table: CleanupTargetTable,
  validItemDefIds: string[]
): Promise<number> => {
  const sql = DELETE_UNDEFINED_ITEM_SQL[table];
  const result = await client.query(sql, [validItemDefIds]);
  return result.rowCount ?? 0;
};

export interface ItemDataCleanupSummary {
  validItemDefCount: number;
  removedItemInstanceCount: number;
  removedItemUseCooldownCount: number;
  removedItemUseCountCount: number;
}

export const cleanupUndefinedItemDataOnStartup = async (): Promise<ItemDataCleanupSummary> => {
  const validItemDefIds = collectValidItemDefIds();
  if (validItemDefIds.length === 0) {
    throw new Error('静态物品定义为空，已阻止启动清理，避免误删数据库物品数据');
  }

  try {
    return await withTransaction(async (client) => {
  const removedItemInstanceCount = await deleteUndefinedItemDefRows(client, 'item_instance', validItemDefIds);
      const removedItemUseCooldownCount = await deleteUndefinedItemDefRows(client, 'item_use_cooldown', validItemDefIds);
      const removedItemUseCountCount = await deleteUndefinedItemDefRows(client, 'item_use_count', validItemDefIds);
  const totalRemoved = removedItemInstanceCount + removedItemUseCooldownCount + removedItemUseCountCount;
      if (totalRemoved > 0) {
        console.log(
          `✓ 启动物品脏数据清理完成：共删除 ${totalRemoved} 条（实例 ${removedItemInstanceCount}，冷却 ${removedItemUseCooldownCount}，计数 ${removedItemUseCountCount}）`
        );
      } else {
        console.log('✓ 启动物品脏数据清理完成：未发现无定义物品数据');
      }
  
      return {
        validItemDefCount: validItemDefIds.length,
        removedItemInstanceCount,
        removedItemUseCooldownCount,
        removedItemUseCountCount,
      };
    });
  } catch (error) {
    try {
} catch (rollbackError) {
      console.error('启动清理回滚失败:', rollbackError);
    }
    throw error;
  }
};
