/**
 * BagModal 共享类型、常量与工具函数
 * 桌面端和移动端 BagModal 均引用此文件
 */
import { resolveIconUrl } from "../../shared/resolveIcon";
import type {
  InventoryItemDto,
  InventoryLocation,
  InventoryUseLootResult,
  ItemDefLite,
} from "../../../../services/api";
import { buildEquipmentAffixDisplayText } from "../../shared/equipmentAffixText";
import {
  formatAffixRollPercent,
  getAffixRollColor,
  getAffixRollPercent,
} from "../../shared/equipmentAffixRoll";
import {
  formatSignedNumber,
  formatSignedPercent,
  formatPercent,
} from "../../shared/formatAttr";
import { coerceAffixes as coerceItemMetaAffixes } from "../../shared/itemMetaFormat";
import { ITEM_CATEGORY_LABELS } from "../../shared/itemTaxonomy";
import type { GameItemCategory as SharedGameItemCategory } from "../../shared/itemTaxonomy";

/* ───────── 类型 ───────── */

export type BagCategory = SharedGameItemCategory;
export type BagQuality = "黄" | "玄" | "地" | "天";
export type BagSort =
  | "default"
  | "nameAsc"
  | "nameDesc"
  | "qtyDesc"
  | "qualityDesc";
export type BagAction =
  | "use"
  | "compose"
  | "equip"
  | "disassemble"
  | "enhance"
  | "show";
export type BatchMode = "disassemble" | "remove";

export type EquipmentAffix = {
  key?: string;
  name?: string;
  modifiers?: Array<{ attr_key: string; value: number }>;
  apply_type?: string;
  trigger?: string;
  target?: string;
  effect_type?: string;
  duration_round?: number;
  params?: Record<string, string | number | boolean>;
  tier?: number;
  value?: number;
  roll_ratio?: number;
  roll_percent?: number;
  value_type?: "raw" | "rating" | string;
  rating_attr_key?: string;
  is_legendary?: boolean;
  description?: string;
};

export type SocketedGemEffect = {
  attrKey: string;
  value: number;
  applyType: "flat" | "percent" | "special";
};

export type SocketedGemEntry = {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketedGemEffect[];
  name?: string;
  icon?: string;
};

export type SetBonusLineGroup = {
  pieceCount: number;
  lines: string[];
  active: boolean;
};

export type SetInfo = {
  setId: string;
  setName: string;
  equippedCount: number;
  bonuses: SetBonusLineGroup[];
};

export type BagItem = {
  id: number;
  itemDefId: string;
  name: string;
  category: Exclude<BagCategory, "all">;
  subCategory: string | null;
  quality: BagQuality;
  tags: string[];
  icon: string;
  qty: number;
  stackMax: number;
  location: InventoryLocation;
  equippedSlot: string | null;
  locked: boolean;
  desc: string;
  effects: string[];
  hasSocketEffect: boolean;
  actions: BagAction[];
  setInfo: SetInfo | null;
  equip: {
    equipSlot: string | null;
    strengthenLevel: number;
    refineLevel: number;
    identified: boolean;
    baseAttrs: Record<string, number>;
    baseAttrsRaw: Record<string, number>;
    defQualityRank: number;
    resolvedQualityRank: number;
    affixes: EquipmentAffix[];
    socketMax: number;
    gemSlotTypes: unknown;
    socketedGems: SocketedGemEntry[];
    equipReqRealm: string | null;
  } | null;
};

/* ───────── 常量 ───────── */

export const categoryLabels: Record<string, string> = ITEM_CATEGORY_LABELS;

export const qualityLabels: BagQuality[] = ["黄", "玄", "地", "天"];

export const qualityRank: Record<BagQuality, number> = {
  黄: 1,
  玄: 2,
  地: 3,
  天: 4,
};

export const qualityColor: Record<BagQuality, string> = {
  天: "var(--rarity-tian)",
  地: "var(--rarity-di)",
  玄: "var(--rarity-xuan)",
  黄: "var(--rarity-huang)",
};

export const qualityLabelText: Record<BagQuality, string> = {
  天: "天品",
  地: "地品",
  玄: "玄品",
  黄: "黄品",
};

export const equipSlotLabelText: Record<string, string> = {
  weapon: "武器",
  head: "头部",
  clothes: "衣服",
  gloves: "护手",
  pants: "裤子",
  necklace: "项链",
  accessory: "饰品",
  artifact: "法宝",
};

export const getEquipSlotLabel = (slot: string) =>
  equipSlotLabelText[slot] ?? slot;

export const qualityClass: Record<BagQuality, string> = {
  天: "q-tian",
  地: "q-di",
  玄: "q-xuan",
  黄: "q-huang",
};

const RATING_SUFFIX = "_rating";

const RATING_BASE_ATTR_KEYS = [
  "shuxing_shuzhi",
  "mingzhong",
  "shanbi",
  "zhaojia",
  "baoji",
  "baoshang",
  "kangbao",
  "zengshang",
  "zhiliao",
  "jianliao",
  "xixue",
  "lengque",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
] as const;

const RATING_BASE_ATTR_KEY_SET = new Set<string>(RATING_BASE_ATTR_KEYS);

const attrLabelBase: Record<string, string> = {
  max_qixue: "气血上限",
  max_lingqi: "灵气上限",
  wugong: "物攻",
  fagong: "法攻",
  wufang: "物防",
  fafang: "法防",
  mingzhong: "命中",
  shanbi: "闪避",
  zhaojia: "招架",
  baoji: "暴击",
  baoshang: "暴伤",
  kangbao: "抗暴",
  zengshang: "增伤",
  zhiliao: "治疗",
  jianliao: "减疗",
  xixue: "吸血",
  lengque: "冷却",
  sudu: "速度",
  qixue_huifu: "气血恢复",
  lingqi_huifu: "灵气恢复",
  kongzhi_kangxing: "控制抗性",
  jin_kangxing: "金抗性",
  mu_kangxing: "木抗性",
  shui_kangxing: "水抗性",
  huo_kangxing: "火抗性",
  tu_kangxing: "土抗性",
  fuyuan: "福源",
  shuxing_shuzhi: "属性数值",
};

const ratingAttrLabelEntries = RATING_BASE_ATTR_KEYS.map((key) => {
  const baseLabel = attrLabelBase[key] ?? key;
  return [`${key}${RATING_SUFFIX}`, `${baseLabel}等级`] as const;
});

export const attrLabel: Record<string, string> = {
  ...attrLabelBase,
  ...Object.fromEntries(ratingAttrLabelEntries),
};

const attrOrderBase = [
  "max_qixue",
  "max_lingqi",
  "wugong",
  "fagong",
  "wufang",
  "fafang",
  "mingzhong",
  "shanbi",
  "zhaojia",
  "baoji",
  "baoshang",
  "kangbao",
  "zengshang",
  "zhiliao",
  "jianliao",
  "xixue",
  "lengque",
  "sudu",
  "qixue_huifu",
  "lingqi_huifu",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
  "fuyuan",
  "shuxing_shuzhi",
] as const;

const attrOrderKeys = attrOrderBase.flatMap((key) =>
  RATING_BASE_ATTR_KEY_SET.has(key) ? [key, `${key}${RATING_SUFFIX}`] : [key],
);

export const attrOrder: Record<string, number> = Object.fromEntries(
  attrOrderKeys.map((k, idx) => [k, idx]),
);

export const percentAttrKeys = new Set<string>([
  "shuxing_shuzhi",
  "mingzhong",
  "shanbi",
  "zhaojia",
  "baoji",
  "baoshang",
  "kangbao",
  "zengshang",
  "zhiliao",
  "jianliao",
  "xixue",
  "lengque",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
]);

/* ───────── 图标解析 ───────── */

export const resolveIcon = (def?: Pick<ItemDefLite, "icon"> | null): string =>
  resolveIconUrl(def?.icon);

/* ───────── 通用工具 ───────── */

export const coerceStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
};

export const coerceAttrRecord = (value: unknown): Record<string, number> => {
  if (!value) return {};
  let obj: unknown = value;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string") {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) out[k] = parsed;
    }
  }
  return out;
};

export const coerceAffixes = (value: unknown): EquipmentAffix[] => {
  const rows = coerceItemMetaAffixes(value);
  return rows.map<EquipmentAffix>((row) => {
    const modifiersRaw = Array.isArray(row.modifiers) ? row.modifiers : [];
    const modifiers = modifiersRaw
      .map<{ attr_key: string; value: number } | null>((modifier) => {
        const attrKey =
          typeof modifier.attr_key === "string" ? modifier.attr_key.trim() : "";
        const modifierValue =
          typeof modifier.value === "number" ? modifier.value : NaN;
        if (!attrKey || !Number.isFinite(modifierValue)) return null;
        return { attr_key: attrKey, value: modifierValue };
      })
      .filter((modifier): modifier is { attr_key: string; value: number } =>
        Boolean(modifier),
      );

    return {
      key: row.key,
      name: row.name,
      modifiers: modifiers.length > 0 ? modifiers : undefined,
      apply_type: row.apply_type,
      tier: row.tier,
      value: row.value,
      roll_ratio: row.roll_ratio,
      roll_percent: row.roll_percent,
      value_type: row.value_type,
      rating_attr_key: row.rating_attr_key,
      is_legendary: row.is_legendary,
      description: row.description,
    };
  });
};

/* ───────── 格式化（统一从 shared/formatAttr 导入，见文件顶部 import + re-export）───────── */

/* ───────── 词条洗炼 ───────── */

export const normalizeAffixLockIndexes = (
  lockIndexes: number[] | null | undefined,
  affixCount?: number,
): number[] => {
  if (!Array.isArray(lockIndexes)) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of lockIndexes) {
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0) continue;
    if (typeof affixCount === "number" && idx >= affixCount) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  return out.sort((a, b) => a - b);
};

export const formatEquipmentAffixLine = (affix: EquipmentAffix): string => {
  const displayText = buildEquipmentAffixDisplayText(affix, {
    normalPrefix: "词条",
    legendaryPrefix: "传奇词条",
    keyLabelMap: attrLabel,
    fallbackLabel: "未知",
    percentKeys: percentAttrKeys,
    formatSignedNumber,
    formatSignedPercent,
  });
  return displayText ? displayText.fullText : "词条 T-：未知";
};
export { formatAffixRollPercent, getAffixRollColor, getAffixRollPercent };

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const normalizeCategoryToken = (value: unknown): string => {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
};

const coerceEffectDefs = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return [value as Record<string, unknown>];
  }
  return [];
};

/* ───────── 装备成长计算 ───────── */

export const getStrengthenMultiplier = (strengthenLevel: number): number => {
  const lv = Math.max(
    0,
    Math.min(15, Math.floor(Number(strengthenLevel) || 0)),
  );
  return 1 + lv * 0.03;
};

export const getRefineMultiplier = (refineLevel: number): number => {
  const lv = Math.max(0, Math.min(10, Math.floor(Number(refineLevel) || 0)));
  return 1 + lv * 0.02;
};

export const getQualityMultiplier = (rank: number): number => {
  const r = Math.max(1, Math.min(4, Math.floor(Number(rank) || 1)));
  if (r >= 4) return 1.75;
  if (r === 3) return 1.45;
  if (r === 2) return 1.2;
  return 1;
};

export const buildGrowthPreviewAttrs = (
  params: {
    baseAttrsRaw: Record<string, number>;
    defQualityRankRaw: unknown;
    resolvedQualityRankRaw: unknown;
    strengthenLevelRaw: unknown;
    refineLevelRaw: unknown;
  },
  mode: "enhance" | "refine",
): Record<string, number> => {
  const baseAttrs = params.baseAttrsRaw;
  const defQualityRank = Math.max(
    1,
    Math.floor(Number(params.defQualityRankRaw) || 1),
  );
  const resolvedQualityRank = Math.max(
    1,
    Math.floor(Number(params.resolvedQualityRankRaw) || 1),
  );
  const strengthenLevel = Math.max(
    0,
    Math.min(15, Math.floor(Number(params.strengthenLevelRaw) || 0)),
  );
  const refineLevel = Math.max(
    0,
    Math.min(10, Math.floor(Number(params.refineLevelRaw) || 0)),
  );

  const targetStrengthenLevel =
    mode === "enhance" ? Math.min(15, strengthenLevel + 1) : strengthenLevel;
  const targetRefineLevel =
    mode === "refine" ? Math.min(10, refineLevel + 1) : refineLevel;

  const qualityFactor =
    getQualityMultiplier(resolvedQualityRank) /
    getQualityMultiplier(defQualityRank);
  const growthFactor =
    getStrengthenMultiplier(targetStrengthenLevel) *
    getRefineMultiplier(targetRefineLevel);
  const factor = qualityFactor * growthFactor;

  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(baseAttrs)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const scaled = n * factor;
    out[k] = percentAttrKeys.has(k)
      ? Number(scaled.toFixed(6))
      : Math.round(scaled);
  }
  return out;
};

export const getEnhanceSuccessRatePercent = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 1,
    2: 1,
    3: 1,
    4: 1,
    5: 1,
    6: 0.8,
    7: 0.7,
    8: 0.6,
    9: 0.5,
    10: 0.4,
    11: 0.35,
    12: 0.3,
    13: 0.25,
    14: 0.2,
    15: 0.15,
  };
  return (
    table[Math.max(1, Math.min(15, Math.floor(Number(targetLevel) || 1)))] ?? 0
  );
};

export const getRefineSuccessRatePercent = (targetLevel: number): number => {
  const table: Record<number, number> = {
    1: 1,
    2: 1,
    3: 1,
    4: 0.9,
    5: 0.8,
    6: 0.7,
    7: 0.6,
    8: 0.5,
    9: 0.4,
    10: 0.3,
  };
  return (
    table[Math.max(1, Math.min(10, Math.floor(Number(targetLevel) || 1)))] ?? 0
  );
};

export interface GrowthCostPlan {
  materialItemDefId: string;
  materialQty: number;
  silverCost: number;
  spiritStoneCost: number;
}

export const buildEnhanceCostPlan = (targetLevel: number): GrowthCostPlan => {
  const target = Math.max(
    1,
    Math.min(15, Math.floor(Number(targetLevel) || 1)),
  );
  return {
    materialItemDefId: target <= 10 ? "enhance-001" : "enhance-002",
    materialQty: 1,
    silverCost: Math.max(50, Math.floor(5 * 20 * target)),
    spiritStoneCost: Math.max(0, Math.floor(target / 5)),
  };
};

export const buildRefineCostPlan = (targetLevel: number): GrowthCostPlan => {
  const target = Math.max(
    1,
    Math.min(10, Math.floor(Number(targetLevel) || 1)),
  );
  return {
    materialItemDefId: "enhance-002",
    materialQty: target >= 8 ? 2 : 1,
    silverCost: Math.max(100, Math.floor(8 * 35 * target)),
    spiritStoneCost: Math.max(0, Math.floor((target + 1) / 3)),
  };
};

/* ───────── 宝石 ───────── */

export const parseSocketedGems = (raw: unknown): SocketedGemEntry[] => {
  let arr: unknown = raw;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];

  const out: SocketedGemEntry[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const row = it as Record<string, unknown>;
    const slot = Number(row.slot);
    const itemDefId = String(row.itemDefId ?? row.item_def_id ?? "").trim();
    const gemType =
      String(row.gemType ?? row.gem_type ?? "all").trim() || "all";
    const effectsRaw = Array.isArray(row.effects) ? row.effects : [];
    const effects: SocketedGemEffect[] = [];
    for (const fx of effectsRaw) {
      if (!fx || typeof fx !== "object") continue;
      const f = fx as Record<string, unknown>;
      const attrKey = String(f.attrKey ?? f.attr_key ?? f.attr ?? "").trim();
      const value = Number(f.value);
      const applyTypeRaw = String(f.applyType ?? f.apply_type ?? "flat")
        .trim()
        .toLowerCase();
      const applyType: SocketedGemEffect["applyType"] =
        applyTypeRaw === "percent"
          ? "percent"
          : applyTypeRaw === "special"
            ? "special"
            : "flat";
      if (!attrKey || !Number.isFinite(value)) continue;
      effects.push({ attrKey, value, applyType });
    }
    if (!Number.isInteger(slot) || slot < 0) continue;
    if (!itemDefId || effects.length === 0) continue;
    out.push({
      slot,
      itemDefId,
      gemType,
      effects,
      name: typeof row.name === "string" ? row.name : undefined,
      icon: typeof row.icon === "string" ? row.icon : undefined,
    });
  }
  return out.sort((a, b) => a.slot - b.slot);
};

export const resolveSocketMax = (
  socketMaxRaw: unknown,
  qualityRaw: unknown,
): number => {
  const configured = Number(socketMaxRaw);
  if (Number.isInteger(configured) && configured > 0)
    return Math.max(0, Math.min(12, configured));
  const qualityRankVal = Math.max(1, Math.min(4, Number(qualityRaw) || 1));
  if (qualityRankVal >= 4) return 4;
  if (qualityRankVal === 3) return 3;
  if (qualityRankVal === 2) return 2;
  return 1;
};

export const normalizeGemType = (value: unknown): string => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "all";
  if (raw === "gem") return "all";
  if (raw.startsWith("gem_")) return normalizeGemType(raw.slice(4));
  if (raw.startsWith("gem-")) return normalizeGemType(raw.slice(4));
  if (["all", "any", "*", "universal"].includes(raw)) return "all";
  if (["atk", "attack", "gongji", "offense"].includes(raw)) return "attack";
  if (["def", "defense", "fangyu"].includes(raw)) return "defense";
  if (["hp", "life", "survival", "shengming"].includes(raw)) return "survival";
  if (["util", "utility", "support"].includes(raw)) return "utility";
  return raw;
};

export const getAllowedGemTypesBySlot = (
  gemSlotTypesRaw: unknown,
  slot: number,
): string[] | null => {
  let raw: unknown = gemSlotTypesRaw;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (Array.isArray(raw)) {
    const slotBased = raw[slot];
    if (Array.isArray(slotBased)) {
      const normalized = slotBased
        .map((v) => normalizeGemType(v))
        .filter(Boolean);
      return normalized.length > 0 ? normalized : null;
    }
    if (raw.every((v) => typeof v === "string")) {
      const normalized = raw.map((v) => normalizeGemType(v)).filter(Boolean);
      return normalized.length > 0 ? normalized : null;
    }
    return null;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const exact = obj[String(slot)];
    if (Array.isArray(exact)) {
      const normalized = exact.map((v) => normalizeGemType(v)).filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
    const fallback = obj.default;
    if (Array.isArray(fallback)) {
      const normalized = fallback
        .map((v) => normalizeGemType(v))
        .filter(Boolean);
      if (normalized.length > 0) return normalized;
    }
  }
  return null;
};

export const isGemTypeAllowedInSlot = (
  gemSlotTypesRaw: unknown,
  slot: number,
  gemTypeRaw: unknown,
): boolean => {
  const allowed = getAllowedGemTypesBySlot(gemSlotTypesRaw, slot);
  if (!allowed || allowed.length === 0) return true;
  const gemType = normalizeGemType(gemTypeRaw);
  if (!gemType) return false;
  return (
    allowed.includes("all") || gemType === "all" || allowed.includes(gemType)
  );
};

const hasSocketBuffEffect = (effectDefsRaw: unknown): boolean => {
  return coerceEffectDefs(effectDefsRaw).some((effect) => {
    const row = effect as { trigger?: unknown; effect_type?: unknown };
    return (
      String(row.trigger || "")
        .trim()
        .toLowerCase() === "socket" &&
      String(row.effect_type || "")
        .trim()
        .toLowerCase() === "buff"
    );
  });
};

export const collectGemCandidates = (items: BagItem[]): BagItem[] => {
  const out: BagItem[] = [];
  for (const it of items) {
    if (it.location !== "bag") continue;
    if (it.locked) continue;
    if (it.category !== "gem") continue;
    if (!it.hasSocketEffect) continue;
    out.push(it);
  }
  return out;
};

/* ───────── 构建装备详情行 ───────── */

export type EquipmentDetailLineKind =
  | "progress"
  | "base"
  | "socket"
  | "gem"
  | "gem_effect"
  | "status"
  | "text"
  | "affix";

type EquipmentDetailAffixLine = {
  kind: "affix";
  text: string;
  affix: {
    tierText: string;
    tagText: string;
    bodyText: string;
    rollPercent: number | null;
  };
};

type EquipmentDetailTextLine = {
  kind: Exclude<EquipmentDetailLineKind, "affix">;
  text: string;
  label?: string;
  value?: string;
};

export type EquipmentDetailLine =
  | EquipmentDetailAffixLine
  | EquipmentDetailTextLine;

const buildDetailLine = (
  kind: Exclude<EquipmentDetailLineKind, "affix">,
  label: string,
  value: string,
  text?: string,
): EquipmentDetailTextLine => {
  return {
    kind,
    label,
    value,
    text: text ?? `${label}：${value}`,
  };
};

export const buildEquipmentDetailLines = (
  item: BagItem | null,
): EquipmentDetailLine[] => {
  if (!item?.equip) return [];
  const {
    strengthenLevel,
    refineLevel,
    identified,
    baseAttrs,
    affixes,
    socketMax,
    socketedGems,
  } = item.equip;

  const lines: EquipmentDetailLine[] = [];
  const strengthenText =
    strengthenLevel > 0 ? `+${strengthenLevel}` : String(strengthenLevel);
  const refineText = refineLevel > 0 ? `+${refineLevel}` : String(refineLevel);
  lines.push(buildDetailLine("progress", "强化", strengthenText));
  lines.push(buildDetailLine("progress", "精炼", refineText));

  const toSortedEntries = (rec: Record<string, number>) =>
    Object.entries(rec).sort(
      ([a], [b]) =>
        (attrOrder[a] ?? 9999) - (attrOrder[b] ?? 9999) || a.localeCompare(b),
    );

  for (const [k, v] of toSortedEntries(baseAttrs)) {
    const label = attrLabel[k] ?? k;
    const valText = percentAttrKeys.has(k)
      ? formatSignedPercent(v)
      : formatSignedNumber(v);
    lines.push(
      buildDetailLine("base", label, valText, `基础：${label} ${valText}`),
    );
  }

  lines.push(
    buildDetailLine("socket", "孔位", `${socketedGems.length}/${socketMax}`),
  );
  for (const gem of socketedGems) {
    const gemName = gem.name || gem.itemDefId;
    const displaySlot = gem.slot + 1;
    const gemLabel = `宝石[${displaySlot}]`;
    lines.push(buildDetailLine("gem", gemLabel, gemName));
    for (const effect of gem.effects) {
      const label = attrLabel[effect.attrKey] ?? effect.attrKey;
      const valText =
        effect.applyType === "percent"
          ? formatSignedPercent(effect.value)
          : formatSignedNumber(effect.value);
      lines.push(
        buildDetailLine(
          "gem_effect",
          label,
          valText,
          `  - ${label} ${valText}`,
        ),
      );
    }
  }

  if (!identified) {
    lines.push(buildDetailLine("status", "词条", "未鉴定"));
    return lines;
  }

  const sortedAffixes = [...affixes].sort(
    (a, b) => (b.tier ?? 0) - (a.tier ?? 0),
  );
  for (const affix of sortedAffixes) {
    const displayText = buildEquipmentAffixDisplayText(affix, {
      normalPrefix: "词条",
      legendaryPrefix: "传奇词条",
      keyLabelMap: attrLabel,
      fallbackLabel: "未知",
      percentKeys: percentAttrKeys,
      formatSignedNumber,
      formatSignedPercent,
    });
    if (!displayText) {
      lines.push(buildDetailLine("status", "词条", "T- 未知", "词条 T-：未知"));
      continue;
    }
    const rollPercent = getAffixRollPercent(affix);
    const bodyText = `${displayText.label}${displayText.valueText ? ` ${displayText.valueText}` : ""}`;

    lines.push({
      kind: "affix",
      text: `${displayText.tierText}(${displayText.prefixText}) ${formatAffixRollPercent(rollPercent)}（ROLL）：${bodyText}`,
      affix: {
        tierText: displayText.tierText,
        tagText: displayText.prefixText,
        bodyText,
        rollPercent,
      },
    });
  }

  return lines;
};

export const buildEquipmentLines = (item: BagItem | null): string[] => {
  return buildEquipmentDetailLines(item).map((line) => line.text);
};

/* ───────── 效果 / 分类映射 ───────── */

const hasLearnTechniqueEffect = (effectDefs: unknown): boolean => {
  return coerceEffectDefs(effectDefs).some((raw) => {
    return normalizeCategoryToken(raw.effect_type) === "learn_technique";
  });
};

export const isTechniqueBookSubCategory = (
  subCategoryValue: unknown,
): boolean => {
  return normalizeCategoryToken(subCategoryValue) === "technique_book";
};

export const isDisassemblableBagItem = (item: {
  category: Exclude<BagCategory, "all">;
  subCategory: string | null;
}): boolean => {
  // 当前版本规则：除锁定/位置限制外，所有类型物品均可分解。
  void item;
  return true;
};

export const collectBatchDisassembleCandidates = (
  items: BagItem[],
  rules?: {
    categories?: Array<Exclude<BagCategory, "all">>;
    subCategories?: string[];
    qualities?: BagQuality[];
    keyword?: string;
    includeKeywords?: string[];
    excludeKeywords?: string[];
  },
): BagItem[] => {
  const categorySet =
    Array.isArray(rules?.categories) && rules.categories.length > 0
      ? new Set(rules.categories)
      : null;
  const subCategorySet =
    Array.isArray(rules?.subCategories) && rules.subCategories.length > 0
      ? new Set(
          rules.subCategories
            .map((value) =>
              String(value ?? "")
                .trim()
                .toLowerCase(),
            )
            .filter((value) => value.length > 0),
        )
      : null;
  const qualitySet =
    Array.isArray(rules?.qualities) && rules.qualities.length > 0
      ? new Set(rules.qualities)
      : null;
  const includeKeywords =
    Array.isArray(rules?.includeKeywords) && rules.includeKeywords.length > 0
      ? rules.includeKeywords
          .map((value) =>
            String(value ?? "")
              .trim()
              .toLowerCase(),
          )
          .filter((value) => value.length > 0)
      : [];
  const excludeKeywords =
    Array.isArray(rules?.excludeKeywords) && rules.excludeKeywords.length > 0
      ? rules.excludeKeywords
          .map((value) =>
            String(value ?? "")
              .trim()
              .toLowerCase(),
          )
          .filter((value) => value.length > 0)
      : [];
  const keyword = String(rules?.keyword ?? "")
    .trim()
    .toLowerCase();

  const out: BagItem[] = [];
  for (const item of items) {
    if (item.location !== "bag") continue;
    if (item.locked) continue;
    if (!isDisassemblableBagItem(item)) continue;
    if (categorySet && !categorySet.has(item.category)) continue;
    if (subCategorySet) {
      const subCategory = String(item.subCategory ?? "")
        .trim()
        .toLowerCase();
      if (!subCategorySet.has(subCategory)) continue;
    }
    if (qualitySet && !qualitySet.has(item.quality)) continue;
    const searchableText =
      `${item.name} ${item.tags.join(" ")} ${item.subCategory ?? ""}`.toLowerCase();
    if (
      includeKeywords.length > 0 &&
      !includeKeywords.some((value) => searchableText.includes(value))
    )
      continue;
    if (excludeKeywords.some((value) => searchableText.includes(value)))
      continue;
    if (keyword) {
      if (!searchableText.includes(keyword)) continue;
    }
    out.push(item);
  }
  return out;
};

/**
 * 构建批量分解请求体条目
 *
 * 输入：候选 BagItem 列表
 * 输出：满足后端接口约束的 { itemId, qty } 数组
 * 约束：
 * - itemId 必须为正整数
 * - qty 必须为正整数
 * - 同一个 itemId 会在前端先合并，减少后端重复校验与报错概率
 */
export const buildBatchDisassemblePayloadItems = (
  items: BagItem[],
): Array<{ itemId: number; qty: number }> => {
  const qtyById = new Map<number, number>();

  for (const item of items) {
    const itemId = Number(item.id);
    const qty = Math.max(1, Math.floor(Number(item.qty) || 1));

    if (!Number.isInteger(itemId) || itemId <= 0) continue;
    if (!Number.isInteger(qty) || qty <= 0) continue;

    const prevQty = qtyById.get(itemId) ?? 0;
    qtyById.set(itemId, prevQty + qty);
  }

  return [...qtyById.entries()].map(([itemId, qty]) => ({ itemId, qty }));
};

const mapCategory = (value: unknown): Exclude<BagCategory, "all"> => {
  const category = normalizeCategoryToken(value);
  if (!category || category === "all") return "other";
  return category;
};

const mapActions = (
  category: Exclude<BagCategory, "all">,
  _subCategoryValue: unknown,
  _effectDefs: unknown,
): BagAction[] => {
  if (category === "consumable") {
    return ["use", "disassemble", "show"];
  }
  if (category === "equipment")
    return ["equip", "enhance", "disassemble", "show"];
  if (category === "material" || category === "gem")
    return ["compose", "disassemble", "show"];
  if (category === "quest") return ["disassemble", "show"];
  return ["disassemble", "show"];
};

const normalizeDisplayTags = (
  rawTags: string[],
  category: Exclude<BagCategory, "all">,
  quality: BagQuality,
): string[] => {
  const blocked = new Set<string>([
    categoryLabels[category],
    qualityLabelText[quality],
    `${quality}品`,
  ]);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of rawTags) {
    const tag = raw.trim();
    if (!tag || blocked.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
};

const formatSetEffectLine = (raw: unknown): string | null => {
  const row = toRecord(raw);
  const effectType = typeof row.effect_type === "string" ? row.effect_type : "";
  if (!effectType) return null;

  const trigger = typeof row.trigger === "string" ? row.trigger : "equip";
  const triggerLabel: Record<string, string> = {
    equip: "穿戴",
    on_turn_start: "回合开始",
    on_skill: "施法",
    on_hit: "命中",
    on_crit: "暴击",
    on_be_hit: "受击",
    on_heal: "治疗",
  };
  const params = toRecord(row.params);
  const chance = toFiniteNumber(params.chance);
  const durationRound = toFiniteNumber(row.duration_round);

  // 缩放描述：当 value 为 0 或很小但有 scale_key+scale_rate 时，用百分比属性描述
  const scaleKey = typeof params.scale_key === "string" ? params.scale_key : "";
  const scaleRate = toFiniteNumber(params.scale_rate);
  const formatScalePart = (): string => {
    if (!scaleKey || scaleRate === null || scaleRate <= 0) return "";
    const scaleLabel = attrLabel[scaleKey] ?? scaleKey;
    return `${formatPercent(scaleRate)}${scaleLabel}`;
  };
  const formatValueWithScale = (baseValue: number, prefix: string): string => {
    const scalePart = formatScalePart();
    const hasBase = baseValue > 0;
    if (hasBase && scalePart)
      return `${prefix} ${Math.floor(baseValue)}+${scalePart}`;
    if (scalePart) return `${prefix} ${scalePart}`;
    return `${prefix} ${Math.floor(baseValue)}`;
  };

  let main = "";
  if (effectType === "buff" || effectType === "debuff") {
    const attrKey = typeof params.attr_key === "string" ? params.attr_key : "";
    const value = toFiniteNumber(params.value);
    const applyType =
      typeof params.apply_type === "string" ? params.apply_type : "flat";
    if (attrKey && value !== null) {
      const label = attrLabel[attrKey] ?? attrKey;
      const isPercent = applyType === "percent" || percentAttrKeys.has(attrKey);
      const valText = isPercent
        ? formatSignedPercent(value)
        : formatSignedNumber(value);
      main = `${label} ${valText}`;
    } else {
      const debuffType =
        typeof params.debuff_type === "string" ? params.debuff_type : "";
      if (debuffType) main = `附加${debuffType}`;
    }
  } else if (effectType === "damage") {
    const value = toFiniteNumber(params.value) ?? 0;
    const damageType =
      typeof params.damage_type === "string" ? params.damage_type : "";
    if (damageType === "reflect") {
      // 反弹伤害：value 是比例（如 0.22 = 22%）
      main = `反弹 ${formatPercent(value)}伤害`;
    } else {
      main = formatValueWithScale(value, "额外伤害");
    }
  } else if (effectType === "heal") {
    const value = toFiniteNumber(params.value) ?? 0;
    main = formatValueWithScale(value, "恢复气血");
  } else if (effectType === "shield") {
    const value = toFiniteNumber(params.value) ?? 0;
    const absorbTypeRaw =
      typeof params.absorb_type === "string" ? params.absorb_type : "";
    const absorbLabel: Record<string, string> = {
      magic: "法术",
      physical: "物理",
      all: "全部",
    };
    const absorbText = absorbLabel[absorbTypeRaw]
      ? `（${absorbLabel[absorbTypeRaw]}吸收）`
      : "";
    main = `${formatValueWithScale(value, "护盾")}${absorbText}`;
  } else if (effectType === "resource") {
    const value = toFiniteNumber(params.value) ?? 0;
    const resource =
      typeof params.resource_type === "string"
        ? params.resource_type
        : typeof params.resource === "string"
          ? params.resource
          : "";
    const resourceName =
      resource === "lingqi"
        ? "灵气"
        : resource === "qixue"
          ? "气血"
          : resource === "exp"
            ? "经验"
            : "资源";
    const action = resource === "exp" ? "获得" : "恢复";
    main = `${action}${resourceName} ${Math.floor(value)}`;
  } else {
    main = effectType;
  }

  if (!main) return null;

  const parts: string[] = [];
  if (trigger !== "equip")
    parts.push(`触发：${triggerLabel[trigger] ?? trigger}`);
  parts.push(main);
  if (chance !== null) parts.push(`概率 ${formatPercent(chance)}`);
  if (durationRound !== null && durationRound > 0) {
    parts.push(`持续 ${Math.floor(durationRound)} 回合`);
  }
  return parts.join("，");
};

const buildSetInfo = (def: ItemDefLite): SetInfo | null => {
  const setId = typeof def.set_id === "string" ? def.set_id.trim() : "";
  if (!setId) return null;

  const setNameRaw =
    typeof def.set_name === "string" ? def.set_name.trim() : "";
  const setName = setNameRaw || setId;
  const equippedCount = Math.max(
    0,
    Math.floor(Number(def.set_equipped_count) || 0),
  );
  const rawBonuses = Array.isArray(def.set_bonuses) ? def.set_bonuses : [];
  const bonuses: SetBonusLineGroup[] = [];

  for (const bonusRaw of rawBonuses) {
    const bonus = toRecord(bonusRaw);
    const pieceCount = Math.max(
      1,
      Math.floor(toFiniteNumber(bonus.piece_count) ?? 1),
    );
    const effectDefs = Array.isArray(bonus.effect_defs)
      ? bonus.effect_defs
      : [];
    const lines = effectDefs
      .map((effect) => formatSetEffectLine(effect))
      .filter((line): line is string => Boolean(line));
    if (lines.length === 0) continue;
    bonuses.push({
      pieceCount,
      lines,
      active: equippedCount >= pieceCount,
    });
  }

  bonuses.sort((a, b) => a.pieceCount - b.pieceCount);
  return {
    setId,
    setName,
    equippedCount,
    bonuses,
  };
};

const buildEffects = (def?: ItemDefLite): string[] => {
  const effects: string[] = [];
  const effectDefs = coerceEffectDefs(def?.effect_defs);

  for (const e of effectDefs) {
    if (!e || typeof e !== "object") continue;
    const effectType = (e as { effect_type?: unknown }).effect_type;
    const value = (e as { value?: unknown }).value;
    const durationRound = (e as { duration_round?: unknown }).duration_round;

    if (effectType === "heal" && typeof value === "number")
      effects.push(`恢复气血 ${value}`);
    else if (effectType === "resource" && typeof value === "number") {
      const params =
        (e as { params?: unknown }).params &&
        typeof (e as { params?: unknown }).params === "object"
          ? ((e as { params?: Record<string, unknown> }).params as Record<
              string,
              unknown
            >)
          : null;
      const resource = params
        ? String(params.resource || params.resource_type || "")
        : "";
      const resourceName =
        resource === "lingqi"
          ? "灵气"
          : resource === "qixue"
            ? "气血"
            : resource === "exp"
              ? "经验"
              : "资源";
      const action = resource === "exp" ? "获得" : "恢复";
      effects.push(`${action}${resourceName} ${value}`);
    } else if (
      (effectType === "restore_mana" || effectType === "mana") &&
      typeof value === "number"
    )
      effects.push(`恢复灵气 ${value}`);
    else if (effectType === "learn_technique") effects.push("学习功法");
    else if (typeof effectType === "string")
      effects.push(`效果：${effectType}`);

    if (typeof durationRound === "number" && durationRound > 0)
      effects.push(`持续 ${durationRound} 回合`);
  }

  const isTechniqueBook =
    isTechniqueBookSubCategory(def?.sub_category) ||
    hasLearnTechniqueEffect(def?.effect_defs);
  const reqRealm =
    typeof def?.use_req_realm === "string" ? def.use_req_realm.trim() : "";
  const reqLevelRaw =
    typeof def?.use_req_level === "number"
      ? def.use_req_level
      : Number(def?.use_req_level);
  const reqLevel = Number.isFinite(reqLevelRaw)
    ? Math.max(0, Math.floor(reqLevelRaw))
    : 0;
  const reqParts: string[] = [];
  if (reqRealm) reqParts.push(`境界≥${reqRealm}`);
  if (reqLevel > 0) reqParts.push(`等级≥${reqLevel}`);
  if (reqParts.length > 0) {
    effects.push(
      `${isTechniqueBook ? "学习要求" : "使用要求"}：${reqParts.join("，")}`,
    );
  }

  const dailyLimitRaw =
    typeof def?.use_limit_daily === "number"
      ? def.use_limit_daily
      : Number(def?.use_limit_daily);
  const totalLimitRaw =
    typeof def?.use_limit_total === "number"
      ? def.use_limit_total
      : Number(def?.use_limit_total);
  const dailyLimit = Number.isFinite(dailyLimitRaw)
    ? Math.max(0, Math.floor(dailyLimitRaw))
    : 0;
  const totalLimit = Number.isFinite(totalLimitRaw)
    ? Math.max(0, Math.floor(totalLimitRaw))
    : 0;
  const useLimitParts: string[] = [];
  if (dailyLimit > 0) useLimitParts.push(`每日最多${dailyLimit}次`);
  if (totalLimit > 0) useLimitParts.push(`总计最多${totalLimit}次`);
  if (useLimitParts.length > 0) {
    effects.push(`使用限制：${useLimitParts.join("，")}`);
  }

  return effects;
};

/* ───────── 构建 BagItem ───────── */

export const buildBagItem = (it: InventoryItemDto): BagItem | null => {
  const def = it.def;
  if (!def) return null;

  const rawQuality =
    typeof it.quality === "string" && it.quality.trim().length > 0
      ? it.quality.trim()
      : def.quality;
  const quality = qualityLabels.includes(rawQuality as BagQuality)
    ? (rawQuality as BagQuality)
    : "黄";
  const defQualityName = qualityLabels.includes(def.quality as BagQuality)
    ? (def.quality as BagQuality)
    : "黄";
  const defQualityRank = qualityRank[defQualityName];
  const resolvedQualityRank = Number(it.quality_rank) || qualityRank[quality];
  const category = mapCategory(def.category);
  const tags = normalizeDisplayTags(
    coerceStringArray(def.tags),
    category,
    quality,
  );
  const isEquip = category === "equipment";
  const hasSocketEffect = hasSocketBuffEffect(def.effect_defs);

  return {
    id: Number(it.id),
    itemDefId: it.item_def_id,
    name: def.name,
    category,
    subCategory: def.sub_category ?? null,
    quality,
    tags,
    icon: resolveIcon(def),
    qty: it.qty,
    stackMax: def.stack_max,
    location: it.location,
    equippedSlot: it.equipped_slot ?? null,
    locked: !!it.locked,
    desc: def.long_desc || def.description || "",
    effects: buildEffects(def),
    hasSocketEffect,
    actions: mapActions(category, def.sub_category, def.effect_defs),
    setInfo: buildSetInfo(def),
    equip: isEquip
      ? {
          equipSlot: def.equip_slot ?? null,
          strengthenLevel: Number(it.strengthen_level) || 0,
          refineLevel: Number(it.refine_level) || 0,
          identified: !!it.identified,
          baseAttrs: coerceAttrRecord(def.base_attrs),
          baseAttrsRaw: coerceAttrRecord(def.base_attrs_raw ?? def.base_attrs),
          defQualityRank,
          resolvedQualityRank,
          affixes: coerceAffixes(it.affixes),
          socketMax: resolveSocketMax(def.socket_max, resolvedQualityRank),
          gemSlotTypes: def.gem_slot_types,
          socketedGems: parseSocketedGems(it.socketed_gems),
          equipReqRealm:
            typeof def.equip_req_realm === "string"
              ? def.equip_req_realm
              : null,
        }
      : null,
  };
};

/**
 * 按物品名合并掉落结果，保持首次出现顺序，避免同一物品在文案里重复出现。
 */
export const mergeLootResultsByItemName = (
  lootResults: readonly InventoryUseLootResult[],
): Array<{ itemName: string; amount: number }> => {
  const merged = new Map<string, { itemName: string; amount: number }>();
  for (const loot of lootResults) {
    const itemName = loot.name || loot.type;
    const prev = merged.get(itemName);
    if (prev) {
      prev.amount += loot.amount;
      continue;
    }
    merged.set(itemName, { itemName, amount: loot.amount });
  }
  return Array.from(merged.values());
};

/**
 * 把合并后的掉落结果格式化为聊天文案片段，如：灵石袋×6。
 */
export const formatMergedLootResultParts = (
  lootResults: readonly InventoryUseLootResult[],
): string[] => {
  return mergeLootResultsByItemName(lootResults).map(
    (entry) => `${entry.itemName}×${entry.amount}`,
  );
};

/* ───────── 使用效果计算 ───────── */

export const pickNumber = (obj: unknown, keys: string[]): number | null => {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

export const calcUseEffectDelta = (
  effects: unknown,
  qty: number,
): { qixue: number; lingqi: number; exp: number } => {
  if (!Array.isArray(effects)) return { qixue: 0, lingqi: 0, exp: 0 };
  let deltaQixue = 0;
  let deltaLingqi = 0;
  let deltaExp = 0;
  const safeQty = Math.max(1, Math.floor(Number(qty) || 1));

  for (const rawEffect of effects) {
    if (!rawEffect || typeof rawEffect !== "object") continue;
    const e = rawEffect as Record<string, unknown>;
    if (String(e.trigger || "") !== "use") continue;
    if (String(e.target || "self") !== "self") continue;

    const effectType =
      typeof e.effect_type === "string" ? e.effect_type : undefined;
    const value = typeof e.value === "number" ? e.value : Number(e.value);
    if (!Number.isFinite(value)) continue;

    if (!effectType || effectType === "heal") {
      deltaQixue += value * safeQty;
      continue;
    }
    if (effectType === "resource") {
      const params =
        e.params && typeof e.params === "object"
          ? (e.params as Record<string, unknown>)
          : null;
      const resource = params ? String(params.resource || "") : "";
      if (resource === "qixue") deltaQixue += value * safeQty;
      if (resource === "lingqi") deltaLingqi += value * safeQty;
      if (resource === "exp") deltaExp += value * safeQty;
    }
  }
  return {
    qixue: Math.floor(deltaQixue),
    lingqi: Math.floor(deltaLingqi),
    exp: Math.floor(deltaExp),
  };
};
