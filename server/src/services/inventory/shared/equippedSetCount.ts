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
import {
  buildItemInstanceIdArrayParam,
  loadCharacterPendingItemInstanceMutations,
  type BufferedCharacterItemInstanceMutation,
} from '../../shared/characterItemInstanceMutationService.js';

type EquippedItemDefRow = {
  id?: number;
  item_def_id: string | null;
  location?: string | null;
};

const cloneEquippedItemDefRow = (row: EquippedItemDefRow): EquippedItemDefRow => ({
  id: typeof row.id === 'number' ? row.id : undefined,
  item_def_id: typeof row.item_def_id === 'string' ? row.item_def_id : null,
  location: typeof row.location === 'string' ? row.location : null,
});

/**
 * 套装件数轻量投影视图。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：仅以 `id / item_def_id / location` 三个最小字段构建 equipped 套装件数所需的 projected 视图。
 * 2. 做什么：复用 pending mutation，避免 `/items` 为了 `set_equipped_count` 再把整套 equipped snapshot 全字段加载一遍。
 * 3. 不做什么：不返回完整库存实例，也不参与装备属性、词条或展示字段富化。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、可选的已加载 pending mutations。
 * - 输出：最终仍处于 `equipped` 位置的轻量行数组。
 *
 * 数据流 / 状态流：
 * pending mutations -> 查询 equipped/相关 itemId 的最小底表行 -> 叠加 mutation 最终位置与 item_def_id -> 过滤出 equipped。
 *
 * 关键边界条件与坑点：
 * 1. 只读取最小字段，调用方不能把返回值当作完整实例使用。
 * 2. mutation 若把实例移出 equipped，必须在这里被剔除，否则套装件数会被高估。
 */
const loadProjectedEquippedItemDefRows = async (
  characterId: number,
  pendingMutations: readonly BufferedCharacterItemInstanceMutation[],
): Promise<EquippedItemDefRow[]> => {
  const relatedItemIds = pendingMutations.map((mutation) => mutation.itemId);
  const params = relatedItemIds.length > 0
    ? [characterId, 'equipped', buildItemInstanceIdArrayParam(relatedItemIds)]
    : [characterId, 'equipped'];
  const sql = relatedItemIds.length > 0
    ? `
      SELECT id, item_def_id, location
      FROM item_instance
      WHERE owner_character_id = $1
        AND (
          location = $2
          OR id = ANY($3::bigint[])
        )
      ORDER BY id ASC
    `
    : `
      SELECT id, item_def_id, location
      FROM item_instance
      WHERE owner_character_id = $1
        AND location = $2
      ORDER BY id ASC
    `;
  const result = await query(sql, params);
  const rowById = new Map<number, EquippedItemDefRow>();
  for (const row of result.rows) {
    const normalizedId = Math.floor(Number((row as { id?: unknown }).id));
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      continue;
    }
    rowById.set(normalizedId, {
      id: normalizedId,
      item_def_id: typeof (row as { item_def_id?: unknown }).item_def_id === 'string'
        ? (row as { item_def_id?: string }).item_def_id ?? null
        : null,
      location: typeof (row as { location?: unknown }).location === 'string'
        ? (row as { location?: string }).location ?? null
        : null,
    });
  }

  for (const mutation of pendingMutations) {
    if (mutation.kind === 'delete' || !mutation.snapshot) {
      rowById.delete(mutation.itemId);
      continue;
    }
    rowById.set(mutation.itemId, {
      id: mutation.itemId,
      item_def_id: mutation.snapshot.item_def_id,
      location: mutation.snapshot.location,
    });
  }

  return [...rowById.values()]
    .filter((row) => row.location === 'equipped')
    .map((row) => cloneEquippedItemDefRow(row));
};

/**
 * 已穿戴物品集合 -> 套装件数字典。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把任意来源的已穿戴物品行统一聚合成 `setId -> 件数`，让快照查询与普通查询共用同一套统计逻辑。
 * 2. 不做什么：不负责读取 projected inventory，也不校验“是否真的是 equipped 位置”；调用方必须保证输入来源正确。
 *
 * 输入 / 输出：
 * - 输入：至少包含 `item_def_id` 的已穿戴物品数组。
 * - 输出：`Map<string, number>`。
 *
 * 数据流 / 状态流：
 * equipped rows -> 静态定义查 `set_id` -> 计数聚合 -> 返回只读 Map。
 *
 * 复用设计说明：
 * - 把“从已穿戴物品计算套装件数”的核心逻辑收敛后，`itemQuery` 传入已预加载的 equippedItems 时无需再次查 projected loader。
 * - 其他仍只知道 `characterId` 的调用方则继续走默认查询入口，不会分叉出两套规则。
 *
 * 关键边界条件与坑点：
 * 1. 输入若混入非已穿戴位置物品，会直接污染件数；因此只能复用在已经确保来源正确的调用链里。
 * 2. 缺少静态定义或 `set_id` 为空的物品必须忽略，不能把脏配置统计成有效套装件数。
 */
const buildEquippedSetPieceCountMap = (
  equippedItems: readonly EquippedItemDefRow[],
): Map<string, number> => {
  const setPieceCountMap = new Map<string, number>();
  for (const row of equippedItems) {
    const itemDefId = typeof row.item_def_id === 'string' ? row.item_def_id.trim() : '';
    if (!itemDefId) continue;

    const itemDef = getStaticItemDef(itemDefId);
    const setId = typeof itemDef?.set_id === 'string' ? itemDef.set_id.trim() : '';
    if (!setId) continue;

    setPieceCountMap.set(setId, (setPieceCountMap.get(setId) ?? 0) + 1);
  }
  return setPieceCountMap;
};

export const getEquippedSetPieceCountMap = async (
  characterId: number,
  equippedItems?: readonly EquippedItemDefRow[],
  options: {
    pendingMutations?: readonly BufferedCharacterItemInstanceMutation[];
  } = {},
): Promise<Map<string, number>> => {
  const resolvedEquippedItems = equippedItems
    ? [...equippedItems]
    : await loadProjectedEquippedItemDefRows(
      characterId,
      options.pendingMutations
        ? [...options.pendingMutations]
        : await loadCharacterPendingItemInstanceMutations(characterId),
    );
  return buildEquippedSetPieceCountMap(resolvedEquippedItems);
};
