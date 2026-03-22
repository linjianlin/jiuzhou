/**
 * 词缀池按部位过滤入口
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：把“总词缀池 + `allowed_slots` 过滤”收敛为单一入口，供装备生成、洗炼、预览、展示共用。
 * - 不做什么：不负责 tier 展开，不负责词条掉落权重计算，也不负责装备定义加载。
 *
 * 输入/输出：
 * - 输入：词缀池列表、目标 `poolId`、目标 `equipSlot`。
 * - 输出：按部位过滤后的词缀池副本，以及稳定的缓存 key。
 *
 * 数据流/状态流：
 * 静态词缀池 -> `resolveAffixPoolBySlot` -> 部位过滤后的 affixes -> 生成/洗炼/预览/展示复用。
 *
 * 关键边界条件与坑点：
 * 1) 总池里允许出现“同 key 不同部位不同曲线”的词缀定义，因此所有消费方必须先过滤 slot，再按 key 索引。
 * 2) 词缀池缓存不能只按 `poolId` 建 key；总池模式下还必须把 `equipSlot` 带上，否则不同部位会串缓存。
 */

export interface SlotScopedAffix {
  allowed_slots?: string[];
}

export interface SlotScopedPool<TAffix extends SlotScopedAffix, TRules> {
  id: string;
  name: string;
  rules: TRules;
  affixes: TAffix[];
  enabled?: boolean;
}

const normalizeSlotKey = (equipSlotRaw: string): string => equipSlotRaw.trim();

export const buildAffixPoolSlotCacheKey = (
  poolIdRaw: string,
  equipSlotRaw: string,
): string => {
  return `${poolIdRaw.trim()}::${normalizeSlotKey(equipSlotRaw)}`;
};

export const isAffixAllowedOnSlot = <TAffix extends SlotScopedAffix>(
  affix: TAffix,
  equipSlotRaw: string,
): boolean => {
  const equipSlot = normalizeSlotKey(equipSlotRaw);
  if (!equipSlot) return false;
  if (!Array.isArray(affix.allowed_slots) || affix.allowed_slots.length <= 0) {
    return false;
  }
  return affix.allowed_slots.some((slot) => typeof slot === 'string' && slot.trim() === equipSlot);
};

export const resolveAffixPoolBySlot = <
  TAffix extends SlotScopedAffix,
  TRules,
  TPool extends SlotScopedPool<TAffix, TRules>,
>(
  pools: TPool[],
  poolIdRaw: string,
  equipSlotRaw: string,
): TPool | null => {
  const poolId = poolIdRaw.trim();
  const equipSlot = normalizeSlotKey(equipSlotRaw);
  if (!poolId || !equipSlot) return null;

  const pool = pools.find((entry) => entry.enabled !== false && entry.id === poolId) ?? null;
  if (!pool) return null;

  return {
    ...pool,
    affixes: pool.affixes.filter((affix) => isAffixAllowedOnSlot(affix, equipSlot)),
  };
};
