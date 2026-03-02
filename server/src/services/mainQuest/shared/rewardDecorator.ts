/**
 * 任务节奖励装饰器
 *
 * 作用：将奖励配置中的 item_def_id / technique id 关联到物品/功法定义，补充 name、icon 等展示字段。
 * 输入：奖励配置对象（含 items、techniques 等）。
 * 输出：增强后的奖励对象（追加 items_detail、techniques_detail）。
 *
 * 复用点：progress 查询和 sectionComplete 中展示下一任务节奖励时调用。
 *
 * 边界条件：
 * 1) 物品/功法 ID 不存在于定义表时仅使用 ID 作为 name，不抛异常。
 * 2) 不做数据库查询，完全基于静态配置（getItemDefinitionsByIds / getTechniqueDefinitions）。
 */
import {
  getItemDefinitionsByIds,
  getTechniqueDefinitions,
} from '../../staticConfigLoader.js';
import { asString, asNumber, asArray } from '../../shared/typeCoercion.js';

/** 将奖励数据关联到物品/功法定义，补充展示字段 */
export const decorateSectionRewards = async (rewards: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const items = asArray<{ item_def_id?: unknown; quantity?: unknown }>((rewards as { items?: unknown }).items);
  const itemIds = Array.from(
    new Set(items.map((it) => asString(it.item_def_id)).map((x) => x.trim()).filter(Boolean)),
  );

  const itemDefMap = new Map<string, { name: string; icon: string | null }>();
  if (itemIds.length > 0) {
    const itemDefs = getItemDefinitionsByIds(itemIds);
    for (const itemId of itemIds) {
      const itemDef = itemDefs.get(itemId);
      if (!itemDef) continue;
      itemDefMap.set(itemId, {
        name: asString(itemDef.name).trim(),
        icon: asString(itemDef.icon).trim() || null,
      });
    }
  }

  const itemsDetail = items
    .map((it) => {
      const itemDefId = asString(it.item_def_id).trim();
      const quantity = Math.max(1, Math.floor(asNumber(it.quantity, 1)));
      if (!itemDefId) return null;
      const def = itemDefMap.get(itemDefId);
      return {
        item_def_id: itemDefId,
        quantity,
        name: (def?.name || itemDefId).trim(),
        icon: def?.icon ?? null,
      };
    })
    .filter(Boolean);

  const techniques = asArray<string>((rewards as { techniques?: unknown }).techniques).map((x) => asString(x).trim()).filter(Boolean);
  const techniqueDefMap = new Map<string, { name: string; icon: string | null }>();
  if (techniques.length > 0) {
    const idSet = new Set(techniques);
    for (const entry of getTechniqueDefinitions()) {
      if (entry.enabled === false) continue;
      if (!idSet.has(entry.id)) continue;
      techniqueDefMap.set(entry.id, {
        name: asString(entry.name).trim(),
        icon: asString(entry.icon).trim() || null,
      });
    }
  }

  const techniquesDetail = techniques.map((id) => {
    const def = techniqueDefMap.get(id);
    return { id, name: (def?.name || id).trim(), icon: def?.icon ?? null };
  });

  const out: Record<string, unknown> = { ...rewards };
  if (itemsDetail.length > 0) out.items_detail = itemsDetail;
  if (techniquesDetail.length > 0) out.techniques_detail = techniquesDetail;
  return out;
};
