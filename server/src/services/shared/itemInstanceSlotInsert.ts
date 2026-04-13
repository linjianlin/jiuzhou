import { query } from '../../config/database.js';
import { ITEM_INSTANCE_SLOT_CONFLICT_CLAUSE } from './itemInstanceSlotUniqueIndex.js';

/**
 * item_instance 槽位冲突安全插入工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一封装 `item_instance(owner_character_id, location, location_slot)` 的冲突处理，
 *   通过 `ON CONFLICT ... DO NOTHING` 返回“成功插入 / 槽位冲突”两态，避免事务被唯一键异常打断。
 * - 不做什么：不负责分配空槽位，不负责业务层重试次数与背包满判定，不负责构造业务字段。
 *
 * 输入/输出：
 * - 输入：不带 `ON CONFLICT` / `RETURNING` 的 `INSERT INTO item_instance ... VALUES ...` SQL，以及参数数组。
 * - 输出：`number | null`。返回实例 ID 表示插入成功；返回 `null` 表示槽位冲突被安全忽略。
 *
 * 数据流/状态流：
 * - 业务层先计算候选槽位；
 * - 调用本工具执行“冲突不抛错”的插入；
 * - 成功则结束，冲突则由业务层继续尝试下一个槽位或下一轮候选槽位。
 *
 * 关键边界条件与坑点：
 * 1) 仅可用于 `item_instance` 的插入 SQL，且 SQL 必须不带结尾分号，避免拼接后语句非法。
 * 2) 该工具依赖与唯一索引一致的 conflict target；若索引谓词变更，必须同步更新本模块，避免失配。
 */

type ItemInstanceInsertParam = string | number | boolean | Date | null;

export const tryInsertItemInstanceWithSlot = async (
  insertSql: string,
  params: readonly ItemInstanceInsertParam[],
): Promise<number | null> => {
  const result = await query(
    `
      ${insertSql}
      ${ITEM_INSTANCE_SLOT_CONFLICT_CLAUSE}
      RETURNING id
    `,
    [...params],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const insertedRow = result.rows[0] as { id: number | string } | undefined;
  const insertedId = Number(insertedRow?.id);
  if (!Number.isInteger(insertedId) || insertedId <= 0) {
    throw new Error('item_instance 插入成功但返回 id 非法');
  }

  return insertedId;
};
