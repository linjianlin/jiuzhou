/**
 * 功法升层共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：统一解析功法层静态配置、升层消耗材料与品质倍率，供人物功法与伙伴功法共用。
 * 2) 不做什么：不负责数据库读写、不直接扣除资源，也不决定 HTTP 接口结构。
 *
 * 输入/输出：
 * - 输入：`technique_layer` 静态配置、物品定义、功法品质。
 * - 输出：标准化后的层级行、材料元信息映射、品质倍率与层级检索结果。
 *
 * 数据流/状态流：
 * staticConfigLoader -> 本模块 -> characterTechniqueService / partnerService。
 *
 * 关键边界条件与坑点：
 * 1) 层级配置里的材料、技能、被动都可能存在脏值，必须在这里一次性标准化，不能让调用方各自兜底。
 * 2) 人物功法和伙伴功法都复用这套规则，因此品质倍率与层级排序必须保持单一入口，避免两边升层消耗漂移。
 */
import { getItemDefinitionsByIds, getTechniqueLayerDefinitions } from '../staticConfigLoader.js';
import { resolveQualityRankFromName } from './itemQuality.js';

export type TechniqueStaticPassive = {
  key: string;
  value: number;
};

export type TechniqueLayerStaticRow = {
  techniqueId: string;
  layer: number;
  costSpiritStones: number;
  costExp: number;
  costMaterials: Array<{ itemId: string; qty: number }>;
  passives: TechniqueStaticPassive[];
  unlockSkillIds: string[];
  upgradeSkillIds: string[];
  requiredRealm: string | null;
};

const coerceCostMaterials = (raw: unknown): Array<{ itemId: string; qty: number }> => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const itemId = (entry as { itemId?: unknown }).itemId;
      const qty = (entry as { qty?: unknown }).qty;
      if (typeof itemId !== 'string') return null;
      if (typeof qty !== 'number') return null;
      return { itemId, qty };
    })
    .filter((entry): entry is { itemId: string; qty: number } => entry !== null);
};

export const getItemMetaMap = async (
  itemIds: string[],
): Promise<Map<string, { name: string; icon: string | null }>> => {
  const uniq = Array.from(new Set(itemIds.filter((entry) => entry.trim().length > 0)));
  if (uniq.length <= 0) return new Map();
  const defs = getItemDefinitionsByIds(uniq);
  const out = new Map<string, { name: string; icon: string | null }>();
  for (const itemId of uniq) {
    const def = defs.get(itemId);
    if (!def || def.enabled === false) continue;
    out.set(itemId, {
      name: String(def.name || itemId),
      icon: typeof def.icon === 'string' ? def.icon : null,
    });
  }
  return out;
};

export const resolveTechniqueCostMultiplierByQuality = (qualityRaw: unknown): number => {
  return Math.max(1, Math.floor(resolveQualityRankFromName(qualityRaw, 1)));
};

export const scaleTechniqueBaseCostByQuality = (
  baseCost: number,
  qualityMultiplier: number,
): number => {
  const normalizedBaseCost = Math.max(0, Math.floor(Number(baseCost) || 0));
  const normalizedMultiplier = Math.max(1, Math.floor(Number(qualityMultiplier) || 1));
  return normalizedBaseCost * normalizedMultiplier;
};

const normalizeInteger = (
  value: number | string | bigint | null | undefined,
  minimum: number = 0,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.floor(parsed));
};

type TechniqueLayerStaticSnapshot = {
  byTechniqueId: ReadonlyMap<string, readonly TechniqueLayerStaticRow[]>;
  rows: readonly TechniqueLayerStaticRow[];
  source: readonly ReturnType<typeof getTechniqueLayerDefinitions>[number][];
};

let techniqueLayerStaticSnapshot: TechniqueLayerStaticSnapshot | null = null;

const buildTechniqueLayerStaticSnapshot = (): TechniqueLayerStaticSnapshot => {
  const source = getTechniqueLayerDefinitions();
  if (techniqueLayerStaticSnapshot?.source === source) {
    return techniqueLayerStaticSnapshot;
  }

  const rows: TechniqueLayerStaticRow[] = [];
  const byTechniqueId = new Map<string, TechniqueLayerStaticRow[]>();

  for (const entry of source) {
    if (entry.enabled === false) continue;
    const techniqueId = typeof entry.technique_id === 'string' ? entry.technique_id.trim() : '';
    const layerRaw = Number(entry.layer);
    if (!techniqueId || !Number.isFinite(layerRaw) || layerRaw <= 0) continue;

    const passives = Array.isArray(entry.passives)
      ? entry.passives
          .map((raw) => {
            if (!raw || typeof raw !== 'object') return null;
            const key = typeof raw.key === 'string' ? raw.key.trim() : '';
            const value = typeof raw.value === 'number' ? raw.value : Number(raw.value);
            if (!key || !Number.isFinite(value)) return null;
            return { key, value } satisfies TechniqueStaticPassive;
          })
          .filter((raw): raw is TechniqueStaticPassive => raw !== null)
      : [];

    const unlockSkillIds = Array.isArray(entry.unlock_skill_ids)
      ? entry.unlock_skill_ids
          .map((skillId) => (typeof skillId === 'string' ? skillId.trim() : ''))
          .filter((skillId): skillId is string => skillId.length > 0)
      : [];

    const upgradeSkillIds = Array.isArray(entry.upgrade_skill_ids)
      ? entry.upgrade_skill_ids
          .map((skillId) => (typeof skillId === 'string' ? skillId.trim() : ''))
          .filter((skillId): skillId is string => skillId.length > 0)
      : [];

    const row: TechniqueLayerStaticRow = {
      techniqueId,
      layer: Math.floor(layerRaw),
      costSpiritStones: Math.max(0, Math.floor(Number(entry.cost_spirit_stones ?? 0))),
      costExp: Math.max(0, Math.floor(Number(entry.cost_exp ?? 0))),
      costMaterials: coerceCostMaterials(entry.cost_materials),
      passives,
      unlockSkillIds,
      upgradeSkillIds,
      requiredRealm:
        typeof entry.required_realm === 'string' && entry.required_realm.trim().length > 0
          ? entry.required_realm.trim()
          : null,
    };

    rows.push(row);
    const currentRows = byTechniqueId.get(techniqueId) ?? [];
    currentRows.push(row);
    byTechniqueId.set(techniqueId, currentRows);
  }

  for (const techniqueRows of byTechniqueId.values()) {
    techniqueRows.sort((left, right) => left.layer - right.layer);
  }

  techniqueLayerStaticSnapshot = {
    byTechniqueId,
    rows,
    source,
  };
  return techniqueLayerStaticSnapshot;
};

export const getTechniqueLayerStaticRows = (): TechniqueLayerStaticRow[] => {
  return [...buildTechniqueLayerStaticSnapshot().rows];
};

export const getTechniqueLayersByTechniqueIdStatic = (
  techniqueId: string,
): TechniqueLayerStaticRow[] => {
  const normalizedTechniqueId = String(techniqueId || '').trim();
  if (!normalizedTechniqueId) return [];
  return [...(buildTechniqueLayerStaticSnapshot().byTechniqueId.get(normalizedTechniqueId) ?? [])];
};

export const getTechniqueLayersByTechniqueIdsStatic = (
  techniqueIds: string[],
): TechniqueLayerStaticRow[] => {
  const normalizedTechniqueIds = Array.from(
    new Set(
      techniqueIds
        .map((techniqueId) => String(techniqueId || '').trim())
        .filter((techniqueId) => techniqueId.length > 0),
    ),
  );
  if (normalizedTechniqueIds.length <= 0) return [];
  const byTechniqueId = buildTechniqueLayerStaticSnapshot().byTechniqueId;
  return normalizedTechniqueIds.flatMap((techniqueId) => [...(byTechniqueId.get(techniqueId) ?? [])]);
};

export const buildTechniqueSkillUpgradeCountMap = (
  layerRows: readonly TechniqueLayerStaticRow[],
  currentLayerRaw: number | string | bigint | null | undefined,
): Map<string, number> => {
  const currentLayer = Math.max(0, normalizeInteger(currentLayerRaw, 0));
  const upgradeCountBySkillId = new Map<string, number>();
  if (currentLayer <= 0) return upgradeCountBySkillId;

  for (const row of layerRows) {
    if (row.layer <= 0 || row.layer > currentLayer) continue;
    for (const skillId of row.upgradeSkillIds) {
      const normalizedSkillId = String(skillId || '').trim();
      if (!normalizedSkillId) continue;
      upgradeCountBySkillId.set(
        normalizedSkillId,
        (upgradeCountBySkillId.get(normalizedSkillId) ?? 0) + 1,
      );
    }
  }

  return upgradeCountBySkillId;
};

export const buildTechniqueUnlockedSkillIdSet = (
  layerRows: readonly TechniqueLayerStaticRow[],
  currentLayerRaw: number | string | bigint | null | undefined,
): Set<string> => {
  const currentLayer = Math.max(0, normalizeInteger(currentLayerRaw, 0));
  const unlockedSkillIdSet = new Set<string>();
  if (currentLayer <= 0) return unlockedSkillIdSet;

  for (const row of layerRows) {
    if (row.layer <= 0 || row.layer > currentLayer) continue;

    for (const skillId of row.unlockSkillIds) {
      const normalizedSkillId = String(skillId || '').trim();
      if (!normalizedSkillId) continue;
      unlockedSkillIdSet.add(normalizedSkillId);
    }

    // 首次仅出现在 upgradeSkillIds 的技能，也从该层开始进入正式解锁集合。
    for (const skillId of row.upgradeSkillIds) {
      const normalizedSkillId = String(skillId || '').trim();
      if (!normalizedSkillId) continue;
      unlockedSkillIdSet.add(normalizedSkillId);
    }
  }

  return unlockedSkillIdSet;
};

export const getTechniqueLayerByTechniqueAndLayerStatic = (
  techniqueId: string,
  layer: number,
): TechniqueLayerStaticRow | null => {
  const normalizedTechniqueId = String(techniqueId || '').trim();
  const normalizedLayer = Number.isFinite(layer) ? Math.floor(layer) : 0;
  if (!normalizedTechniqueId || normalizedLayer <= 0) return null;
  return (
    getTechniqueLayerStaticRows().find(
      (entry) => entry.techniqueId === normalizedTechniqueId && entry.layer === normalizedLayer,
    ) ?? null
  );
};
