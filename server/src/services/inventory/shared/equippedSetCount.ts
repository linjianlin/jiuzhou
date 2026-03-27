/**
 * 已穿戴套装件数查询模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一查询角色当前已穿戴装备对应的套装件数，作为套装展示、套装属性结算、成就触发的单一数据源。
 * 2. 做什么：把“装备实例 -> 装备定义 -> set_id -> 件数聚合”的高频逻辑收敛到一处，避免 itemQuery / attrDelta / equipment 各写一套。
 * 3. 不做什么：不判断套装是否激活，不计算套装属性，也不修改任何背包或角色状态。
 *
 * 输入/输出：
 * - 输入：`characterId`
 * - 输出：`Map<setId, equippedPieceCount>`
 *
 * 数据流/状态流：
 * `item_instance(location='equipped')` -> 读取 item_def_id -> 解析静态装备定义中的 `set_id` -> 聚合件数 -> 返回只读 Map。
 *
 * 关键边界条件与坑点：
 * 1. 只有 location='equipped' 的实例参与统计，背包与仓库里的同套装装备不能混入。
 * 2. 缺少静态定义或未配置 `set_id` 的装备必须直接忽略，不能让脏配置污染套装件数。
 */

import { query } from '../../../config/database.js';
import { getStaticItemDef } from './helpers.js';

type EquippedItemDefRow = {
  item_def_id: string | null;
};

export const getEquippedSetPieceCountMap = async (
  characterId: number,
): Promise<Map<string, number>> => {
  const equippedResult = await query<EquippedItemDefRow>(
    `
      SELECT ii.item_def_id
      FROM item_instance ii
      WHERE ii.owner_character_id = $1
        AND ii.location = 'equipped'
    `,
    [characterId],
  );

  const setPieceCountMap = new Map<string, number>();
  for (const row of equippedResult.rows) {
    const itemDefId = typeof row.item_def_id === 'string' ? row.item_def_id.trim() : '';
    if (!itemDefId) continue;

    const itemDef = getStaticItemDef(itemDefId);
    const setId = typeof itemDef?.set_id === 'string' ? itemDef.set_id.trim() : '';
    if (!setId) continue;

    setPieceCountMap.set(setId, (setPieceCountMap.get(setId) ?? 0) + 1);
  }

  return setPieceCountMap;
};
