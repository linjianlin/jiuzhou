/**
 * 装备解绑服务
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：集中处理“将某件已绑定装备恢复为未绑定”的校验与 Redis 主状态写回。
 * - 不做什么：不负责消耗解绑道具，不处理背包刷新推送，不参与穿戴/卸下流程。
 *
 * 输入/输出：
 * - 输入：角色 ID、目标装备实例 ID、静态物品定义解析函数。
 * - 输出：解绑结果（成功/失败、提示文案、目标实例 ID）。
 *
 * 数据流/状态流：
 * - 读取 Redis 物品主状态 -> 校验装备类型/锁定状态/绑定状态 -> 通过共享写回入口提交解绑 patch。
 *
 * 关键边界条件与坑点：
 * 1) `bind_type` 只要不是 `none` 都视为“已绑定”，避免未来新增绑定类型时漏判。
 * 2) 目标装备被锁定时必须拒绝解绑，保持背包锁与使用道具语义一致。
 */
import { getStaticItemDef } from './shared/helpers.js';
import { loadPlayerInventoryStateByItemId } from '../playerStateRepository.js';
import { queueInventoryItemWritebackSnapshot } from '../playerWritebackCacheService.js';

type QueryResultLike = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
};

type StaticItemDefLike = {
  category?: unknown;
} | null;

export type EquipmentUnbindQueryRunner = (
  sql: string,
  params: unknown[],
) => Promise<QueryResultLike>;

type EquipmentUnbindParams = {
  characterId: number;
  itemInstanceId: number;
  queryRunner?: EquipmentUnbindQueryRunner;
  resolveItemDef?: (itemDefId: string) => StaticItemDefLike;
};

type EquipmentUnbindResult = {
  success: boolean;
  message: string;
  itemInstanceId?: number;
};

const normalizeBindType = (value: unknown): string => {
  if (typeof value !== 'string') return 'none';
  const normalized = value.trim().toLowerCase();
  return normalized || 'none';
};

export const unbindEquipmentBindingByInstanceId = async ({
  characterId,
  itemInstanceId,
  queryRunner: _queryRunner,
  resolveItemDef = getStaticItemDef,
}: EquipmentUnbindParams): Promise<EquipmentUnbindResult> => {
  const targetItem = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
  if (!targetItem) {
    return { success: false, message: '目标装备不存在' };
  }

  const itemDefId = typeof targetItem.item_def_id === 'string' ? targetItem.item_def_id.trim() : '';
  if (!itemDefId) {
    return { success: false, message: '目标装备数据异常' };
  }

  const itemDef = resolveItemDef(itemDefId);
  if (!itemDef || String(itemDef.category || '').trim() !== 'equipment') {
    return { success: false, message: '目标物品不是装备' };
  }

  if (Boolean(targetItem.locked)) {
    return { success: false, message: '目标装备已锁定' };
  }

  if (normalizeBindType(targetItem.bind_type) === 'none') {
    return { success: false, message: '目标装备尚未绑定' };
  }

  await queueInventoryItemWritebackSnapshot(characterId, targetItem, {
    bind_type: 'none',
    bind_owner_user_id: null,
    bind_owner_character_id: null,
  });

  return {
    success: true,
    message: '解绑成功',
    itemInstanceId,
  };
};
