import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
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

export interface ItemDataCleanupSummary {
  validItemDefCount: number;
  removedItemInstanceCount: number;
  removedItemUseCooldownCount: number;
  removedItemUseCountCount: number;
}

class ItemDataCleanupService {
  /**
   * 收集所有有效的物品定义 ID
   *
   * 作用：从静态配置中提取所有非空的物品 ID
   * 输入：无（从 staticConfigLoader 读取）
   * 输出：去重后的物品 ID 数组
   *
   * 关键边界：
   * - 自动过滤空字符串和 null/undefined
   * - 使用 Set 去重
   */
  private collectValidItemDefIds(): string[] {
    const idSet = new Set<string>();
    for (const entry of getItemDefinitions()) {
      const id = String(entry.id || '').trim();
      if (!id) continue;
      idSet.add(id);
    }
    return Array.from(idSet);
  }

  /**
   * 删除指定表中未定义的物品数据
   *
   * 作用：执行单表清理 SQL，删除 item_def_id 不在有效列表中的行
   * 输入：表名、有效物品 ID 列表
   * 输出：删除的行数
   *
   * 关键边界：
   * - 使用参数化查询防止 SQL 注入
   * - 处理 rowCount 可能为 null 的情况
   */
  private async deleteUndefinedItemDefRows(
    table: CleanupTargetTable,
    validItemDefIds: string[]
  ): Promise<number> {
    const sql = DELETE_UNDEFINED_ITEM_SQL[table];
    const result = await query(sql, [validItemDefIds]);
    return result.rowCount ?? 0;
  }

  /**
   * 启动时清理未定义的物品数据
   *
   * 作用：在服务启动时清理三张物品相关表中的脏数据
   * 输入：无
   * 输出：清理统计信息
   *
   * 数据流：
   * 1. 从静态配置加载有效物品 ID
   * 2. 在事务中依次清理三张表
   * 3. 返回清理统计
   *
   * 关键边界：
   * - 若静态定义为空则抛错，防止误删全部数据
   * - 使用 @Transactional 保证三张表清理的原子性
   */
  @Transactional
  async cleanupUndefinedItemDataOnStartup(): Promise<ItemDataCleanupSummary> {
    const validItemDefIds = this.collectValidItemDefIds();
    if (validItemDefIds.length === 0) {
      throw new Error('静态物品定义为空，已阻止启动清理，避免误删数据库物品数据');
    }

    const removedItemInstanceCount = await this.deleteUndefinedItemDefRows('item_instance', validItemDefIds);
    const removedItemUseCooldownCount = await this.deleteUndefinedItemDefRows('item_use_cooldown', validItemDefIds);
    const removedItemUseCountCount = await this.deleteUndefinedItemDefRows('item_use_count', validItemDefIds);
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
  }
}

export const itemDataCleanupService = new ItemDataCleanupService();
