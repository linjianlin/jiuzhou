/**
 * 易名符语义与扣除共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中识别一个物品定义是否为“易名符”，供角色改名与伙伴改名共同复用，避免同一 effect_type 判断散落在多个服务里。
 * 2. 做什么：集中处理“读取 Redis 物品主状态 -> 校验易名符 -> 通过共享消耗入口扣除 1 张”，避免两条改名链路重复维护扣卡逻辑。
 * 3. 不做什么：不负责名称合法性校验、不推送前端刷新，也不决定改名对象是谁。
 *
 * 输入/输出：
 * - 输入：静态物品定义，或角色 ID + 易名符实例 ID。
 * - 输出：是否具备“易名符”语义，或统一的扣卡结果。
 *
 * 数据流/状态流：
 * item_def.effect_defs -> 本模块识别 `rename_character` 效果 -> 读取 Redis 物品主状态 -> 调用共享消耗入口 -> 易名符数量减少 1。
 *
 * 关键边界条件与坑点：
 * 1. 不能只按物品名称判断，否则后续改文案或做多张改名卡时会失真。
 * 2. 扣卡前必须先锁定具体实例并校验归属，否则并发改名时可能出现重复扣除或串用他人道具。
 */
import { consumeSpecificItemInstance } from '../inventory/shared/consume.js';
import type { ItemDefConfig } from '../staticConfigLoader.js';
import { getItemDefinitionById } from '../staticConfigLoader.js';
import { loadPlayerInventoryStateByItemId } from '../playerStateRepository.js';

type RenameCardConsumeResult =
  | {
      success: true;
      itemDefId: string;
    }
  | {
      success: false;
      message: string;
    };

export const RENAME_CARD_EFFECT_TYPE = 'rename_character';

export const isRenameCardItemDefinition = (
  itemDef: ItemDefConfig | null,
): boolean => {
  if (!itemDef) {
    return false;
  }

  const effectDefs = Array.isArray(itemDef.effect_defs) ? itemDef.effect_defs : [];
  for (const effectDef of effectDefs) {
    if (!effectDef || typeof effectDef !== 'object' || Array.isArray(effectDef)) {
      continue;
    }

    const effectType = 'effect_type' in effectDef ? String(effectDef.effect_type || '').trim() : '';
    if (effectType === RENAME_CARD_EFFECT_TYPE) {
      return true;
    }
  }

  return false;
};

export const consumeRenameCardItemInstance = async (
  characterId: number,
  itemInstanceId: number,
): Promise<RenameCardConsumeResult> => {
  const itemState = await loadPlayerInventoryStateByItemId(characterId, itemInstanceId);
  if (!itemState) {
    return { success: false, message: '易名符不存在' };
  }

  const itemDefId = String(itemState.item_def_id || '').trim();
  const itemDef = getItemDefinitionById(itemDefId);
  if (!isRenameCardItemDefinition(itemDef)) {
    return { success: false, message: '该物品不能用于改名' };
  }

  const itemQty = Math.max(0, Math.floor(Number(itemState.qty) || 0));
  if (itemQty <= 0) {
    return { success: false, message: '易名符数量不足' };
  }

  const consumeResult = await consumeSpecificItemInstance(characterId, itemInstanceId, 1);
  if (!consumeResult.success) {
    return { success: false, message: consumeResult.message };
  }

  return {
    success: true,
    itemDefId,
  };
};
