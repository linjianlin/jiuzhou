/**
 * 掉落池统一解析器
 *
 * 作用：
 * - 将怪物专属掉落池与通用掉落池合并为一个可直接消费的池
 * - 统一做字段标准化，避免业务层重复处理 chance/qty/bind 等细节
 * - 处理冲突覆盖：同 item_def_id 时，专属池条目覆盖通用池条目
 *
 * 输入：
 * - poolId: 专属掉落池 ID（来自 monster.drop_pool_id）
 *
 * 输出：
 * - ResolvedDropPool | null
 *   - null 表示该池不存在或未启用
 *
 * 关键约束：
 * - 只读取专属池上声明的 common_pool_ids，不做隐式默认池兜底
 * - 合并顺序固定：通用池 -> 专属池（后者覆盖前者）
 */
import {
  getCommonDropPoolDefinitions,
  getDropPoolDefinitions,
  type DropPoolDefConfig,
  type DropPoolEntryConfig,
} from './staticConfigLoader.js';

export type ResolvedDropPoolMode = 'prob' | 'weight';

export type ResolvedDropPoolEntry = {
  item_def_id: string;
  chance: number;
  weight: number;
  qty_min: number;
  qty_max: number;
  qty_multiply_by_monster_realm: number;
  quality_weights: Record<string, number> | null;
  bind_type: string;
  show_in_ui: boolean;
  sort_order: number;
  sourceType: 'common' | 'exclusive';
  sourcePoolId: string;
};

export type ResolvedDropPool = {
  id: string;
  name: string;
  mode: ResolvedDropPoolMode;
  common_pool_ids: string[];
  entries: ResolvedDropPoolEntry[];
};

const resolvedPoolCache = new Map<string, ResolvedDropPool | null>();

const toFiniteNumber = (value: number | string | null | undefined, fallback: number): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeQtyRange = (entry: DropPoolEntryConfig): { qtyMin: number; qtyMax: number } => {
  const qtyMin = Math.max(1, Math.floor(toFiniteNumber(entry.qty_min, 1)));
  const qtyMaxRaw = Math.floor(toFiniteNumber(entry.qty_max, qtyMin));
  const qtyMax = Math.max(qtyMin, qtyMaxRaw);
  return { qtyMin, qtyMax };
};

const normalizeQualityWeights = (value: DropPoolEntryConfig['quality_weights']): Record<string, number> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) continue;
    normalized[key] = num;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
};

const normalizeEntry = (entry: DropPoolEntryConfig): Omit<ResolvedDropPoolEntry, 'sourceType' | 'sourcePoolId'> | null => {
  const itemDefId = typeof entry.item_def_id === 'string' ? entry.item_def_id.trim() : '';
  if (!itemDefId) return null;

  const { qtyMin, qtyMax } = normalizeQtyRange(entry);
  const qtyMultiplyByMonsterRealmRaw = toFiniteNumber(entry.qty_multiply_by_monster_realm, 1);
  const qtyMultiplyByMonsterRealm = qtyMultiplyByMonsterRealmRaw > 0 ? qtyMultiplyByMonsterRealmRaw : 1;
  return {
    item_def_id: itemDefId,
    chance: Math.max(0, toFiniteNumber(entry.chance, 0)),
    weight: Math.max(0, Math.floor(toFiniteNumber(entry.weight, 0))),
    qty_min: qtyMin,
    qty_max: qtyMax,
    qty_multiply_by_monster_realm: qtyMultiplyByMonsterRealm,
    quality_weights: normalizeQualityWeights(entry.quality_weights),
    bind_type: typeof entry.bind_type === 'string' && entry.bind_type.trim().length > 0 ? entry.bind_type.trim() : 'none',
    show_in_ui: entry.show_in_ui !== false,
    sort_order: Math.max(0, Math.floor(toFiniteNumber(entry.sort_order, 0))),
  };
};

const withPoolSource = (
  entry: Omit<ResolvedDropPoolEntry, 'sourceType' | 'sourcePoolId'>,
  sourceType: ResolvedDropPoolEntry['sourceType'],
  sourcePoolId: string
): ResolvedDropPoolEntry => ({
  ...entry,
  sourceType,
  sourcePoolId,
});

const normalizeMode = (mode: DropPoolDefConfig['mode']): ResolvedDropPoolMode => {
  return mode === 'weight' ? 'weight' : 'prob';
};

const normalizeCommonPoolIds = (value: DropPoolDefConfig['common_pool_ids']): string[] => {
  if (!Array.isArray(value)) return [];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const rawId of value) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
};

const buildEnabledPoolMap = (definitions: DropPoolDefConfig[]): Map<string, DropPoolDefConfig> => {
  return new Map(
    definitions
      .filter((entry) => entry.enabled !== false)
      .map((entry) => [String(entry.id), entry] as const),
  );
};

/**
 * 解析并合并一个专属掉落池。
 * - 若池不存在或未启用，返回 null
 * - 结果已做字段标准化与覆盖处理，可直接给战斗和展示模块复用
 */
export const resolveDropPoolById = (poolId: string): ResolvedDropPool | null => {
  const id = String(poolId || '').trim();
  if (!id) return null;

  const cached = resolvedPoolCache.get(id);
  if (cached !== undefined) return cached;

  const exclusivePoolMap = buildEnabledPoolMap(getDropPoolDefinitions());
  const commonPoolMap = buildEnabledPoolMap(getCommonDropPoolDefinitions());

  const exclusivePool = exclusivePoolMap.get(id) ?? null;
  if (!exclusivePool) {
    resolvedPoolCache.set(id, null);
    return null;
  }

  const mergedByItemDefId = new Map<string, ResolvedDropPoolEntry>();
  const commonPoolIds = normalizeCommonPoolIds(exclusivePool.common_pool_ids);

  for (const commonPoolId of commonPoolIds) {
    const commonPool = commonPoolMap.get(commonPoolId);
    if (!commonPool) continue;
    const commonEntries = Array.isArray(commonPool.entries) ? commonPool.entries : [];
    for (const rawEntry of commonEntries) {
      const normalizedEntry = normalizeEntry(rawEntry);
      if (!normalizedEntry) continue;
      mergedByItemDefId.set(
        normalizedEntry.item_def_id,
        withPoolSource(normalizedEntry, 'common', commonPoolId),
      );
    }
  }

  const exclusiveEntries = Array.isArray(exclusivePool.entries) ? exclusivePool.entries : [];
  for (const rawEntry of exclusiveEntries) {
    const normalizedEntry = normalizeEntry(rawEntry);
    if (!normalizedEntry) continue;
    mergedByItemDefId.set(
      normalizedEntry.item_def_id,
      withPoolSource(normalizedEntry, 'exclusive', id),
    );
  }

  const entries = Array.from(mergedByItemDefId.values()).sort(
    (left, right) => left.sort_order - right.sort_order || left.item_def_id.localeCompare(right.item_def_id),
  );

  const resolved: ResolvedDropPool = {
    id,
    name: String(exclusivePool.name || id),
    mode: normalizeMode(exclusivePool.mode),
    common_pool_ids: commonPoolIds,
    entries,
  };
  resolvedPoolCache.set(id, resolved);
  return resolved;
};
