/**
 * BagModal 共享类型、常量与工具函数
 * 桌面端和移动端 BagModal 均引用此文件
 */
import { resolveIconUrl } from "../../shared/resolveIcon";
import {
  resolveItemBindMeta,
  type ItemBindMeta,
} from "../../shared/itemBind";
import type {
  InventoryItemDto,
  InventoryLocation,
  InventoryUseCharacterSnapshot,
  InventoryUseEffect,
  InventoryUseLootResult,
  ItemDefLite,
} from "../../../../services/api";
import { buildEquipmentAffixDisplayText } from "../../shared/equipmentAffixText";
import { formatMarkEffectText } from "../../shared/markEffectText";
import {
  formatAffixRollPercent,
  getAffixRollColor,
  getAffixRollColorVars,
  getAffixRollPercent,
} from "../../shared/equipmentAffixRoll";
import {
  formatSignedNumber,
  formatSignedPercent,
  formatPercent,
} from "../../shared/formatAttr";
import {
  attrLabel,
  percentAttrKeys,
  RATING_BASE_ATTR_KEYS,
  RATING_SUFFIX,
} from "../../shared/attrDisplay";
import {
  buildSocketedGemDisplayGroups,
  parseSocketedGems,
  type SocketedGemEntry,
} from "../../shared/socketedGemDisplay";
import { coerceAffixes as coerceItemMetaAffixes } from "../../shared/itemMetaFormat";
import { ITEM_CATEGORY_LABELS } from "../../shared/itemTaxonomy";
import type { GameItemCategory as SharedGameItemCategory } from "../../shared/itemTaxonomy";
import { getLearnableTechniqueId } from "../../shared/learnableTechnique";
import {
  resolveBagItemUseTargetType,
  type BagItemUseTargetType,
} from "./equipmentUnbind";

export { attrLabel, percentAttrKeys };

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
export type { SocketedGemEffect, SocketedGemEntry } from "../../shared/socketedGemDisplay";

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
  learnableTechniqueId: string | null;
  name: string;
  category: Exclude<BagCategory, "all">;
  subCategory: string | null;
  canDisassemble: boolean;
  quality: BagQuality;
  tags: string[];
  icon: string;
  qty: number;
  stackMax: number;
  bind: ItemBindMeta;
  location: InventoryLocation;
  equippedSlot: string | null;
  locked: boolean;
  desc: string;
  effects: string[];
  useTargetType: BagItemUseTargetType;
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
] as const;
const ratingBaseAttrKeySet = new Set<string>(RATING_BASE_ATTR_KEYS);

const attrOrderKeys = attrOrderBase.flatMap((key) =>
  ratingBaseAttrKeySet.has(key) ? [key, `${key}${RATING_SUFFIX}`] : [key],
);

export const attrOrder: Record<string, number> = Object.fromEntries(
  attrOrderKeys.map((k, idx) => [k, idx]),
);

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
export { formatAffixRollPercent, getAffixRollColor, getAffixRollColorVars, getAffixRollPercent };

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const formatIntegerOrRange = (
  minRaw: unknown,
  maxRaw: unknown,
  fallbackRaw: unknown,
): string => {
  const min = toFiniteNumber(minRaw);
  const max = toFiniteNumber(maxRaw);
  if (min !== null && max !== null) {
    const lower = Math.floor(Math.min(min, max));
    const upper = Math.floor(Math.max(min, max));
    return lower === upper ? `${lower}` : `${lower}~${upper}`;
  }
  return `${Math.floor(toFiniteNumber(fallbackRaw) ?? 0)}`;
};

const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const EFFECT_DISPLAY_RESERVED_KEYS = new Set<string>([
  "trigger",
  "target",
  "effect_type",
  "duration_round",
  "durationRound",
  "element",
  "params",
]);

/**
 * 作用：
 * - 做什么：把效果配置归一化成展示层统一结构，兼容“字段平铺”和“字段在 params 内”两种当前项目内实际输入。
 * - 不做什么：不改写业务语义，不推导战斗逻辑，只为静态中文文案提供单一读取入口。
 *
 * 输入/输出：
 * - 输入：原始效果对象，以及默认触发时机/是否需要把 mana 归一到 resource。
 * - 输出：保证 `params` 聚合了展示所需字段的标准化效果对象。
 *
 * 数据流/状态流：
 * - 物品 / 套装原始 effect -> 本函数归一化 -> formatSetEffectLine / formatBagItemEffectLine 共用。
 *
 * 关键边界条件与坑点：
 * 1. 当前项目里同类效果字段存在“平铺在顶层”和“嵌套在 params”两种形态，若不先合并，展示层会把 echo 误读成 `额外伤害 0`。
 * 2. 归一化只在 params 缺字段时补齐，不能覆盖原始 params，否则会把配置层显式值错误替换掉。
 */
const buildEffectDisplayRecord = (
  raw: Record<string, unknown>,
  options?: {
    defaultTrigger?: string;
    normalizeManaAsResource?: boolean;
  },
): Record<string, unknown> => {
  const params = toRecord(raw.params);
  const nextParams: Record<string, unknown> = { ...params };

  for (const [key, value] of Object.entries(raw)) {
    if (EFFECT_DISPLAY_RESERVED_KEYS.has(key)) continue;
    if (nextParams[key] === undefined) {
      nextParams[key] = value;
    }
  }

  const effectType =
    typeof raw.effect_type === "string" ? raw.effect_type.trim() : "";
  const normalizedEffectType =
    options?.normalizeManaAsResource &&
    (effectType === "mana" || effectType === "restore_mana")
      ? "resource"
      : effectType;

  if (
    normalizedEffectType === "resource" &&
    nextParams.resource === undefined &&
    nextParams.resource_type === undefined &&
    (effectType === "mana" || effectType === "restore_mana")
  ) {
    nextParams.resource = "lingqi";
  }

  const durationRound =
    raw.duration_round !== undefined ? raw.duration_round : raw.durationRound;

  return {
    ...raw,
    effect_type: normalizedEffectType,
    trigger:
      typeof raw.trigger === "string"
        ? raw.trigger
        : options?.defaultTrigger ?? "equip",
    duration_round: durationRound,
    params: nextParams,
  };
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

/* ───────── 宝石 ───────── */

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
  const socketedGemGroups = buildSocketedGemDisplayGroups(socketedGems, {
    labelResolver: (attrKey) => attrLabel[attrKey] ?? attrKey,
    formatSignedNumber,
    formatSignedPercent,
  });
  for (const gem of socketedGemGroups) {
    lines.push(buildDetailLine("gem", gem.slotText, gem.gemName));
    for (const effect of gem.effects) {
      lines.push(
        buildDetailLine(
          "gem_effect",
          effect.label,
          effect.valueText,
          `  - ${effect.text}`,
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
  canDisassemble: boolean;
}): boolean => {
  // 分解可用性由后端统一下发规范化字段，前端只消费结果，不再重复解释默认值。
  void item.category;
  void item.subCategory;
  return item.canDisassemble;
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
  canDisassemble: boolean,
  _subCategoryValue: unknown,
  _effectDefs: unknown,
): BagAction[] => {
  if (category === "consumable") {
    return canDisassemble ? ["use", "disassemble", "show"] : ["use", "show"];
  }
  if (category === "equipment")
    return canDisassemble
      ? ["equip", "enhance", "disassemble", "show"]
      : ["equip", "enhance", "show"];
  if (category === "material" || category === "gem")
    return canDisassemble ? ["compose", "disassemble", "show"] : ["compose", "show"];
  if (category === "quest") return canDisassemble ? ["disassemble", "show"] : ["show"];
  return canDisassemble ? ["disassemble", "show"] : ["show"];
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

export const formatSetEffectLine = (raw: unknown): string | null => {
  const row = buildEffectDisplayRecord(toRecord(raw), {
    defaultTrigger: "equip",
  });
  const effectType = typeof row.effect_type === "string" ? row.effect_type : "";
  if (!effectType) return null;

  const trigger = typeof row.trigger === "string" ? row.trigger : "equip";
  const triggerLabel: Record<string, string> = {
    equip: "穿戴",
    on_turn_start: "回合开始",
    on_skill: "施法",
    after_skill: "结算后",
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
  const formatShieldMain = (): string => {
    const value = toFiniteNumber(params.value) ?? 0;
    const shieldMode =
      typeof params.shield_mode === "string" ? params.shield_mode : "";
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

    if (shieldMode === "damage_echo") {
      return `获得相当于本次受击伤害${formatPercent(value)}的护盾${absorbText}`;
    }

    return `${formatValueWithScale(value, "护盾")}${absorbText}`;
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
    } else if (damageType === "echo") {
      main = `追加本次命中伤害${formatPercent(value)}的真伤`;
    } else {
      main = formatValueWithScale(value, "额外伤害");
    }
  } else if (effectType === "heal") {
    const value = toFiniteNumber(params.value) ?? 0;
    main = formatValueWithScale(value, "恢复气血");
  } else if (effectType === "shield") {
    main = formatShieldMain();
  } else if (effectType === "resource") {
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
          : resource === "stamina"
            ? "体力"
          : resource === "exp"
            ? "经验"
            : "资源";
    const action = resource === "exp" ? "获得" : "恢复";
    const amountText = formatIntegerOrRange(
      params.min,
      params.max,
      params.value,
    );
    main = `${action}${resourceName} ${amountText}`;
  } else if (effectType === "mark") {
    main =
      formatMarkEffectText({
        ...params,
        duration_round: row.duration_round,
      }) ?? "印记效果";
  } else if (effectType === "spell_projection") {
    const singleSplitRate = Math.max(0, toFiniteNumber(params.single_split_rate) ?? 0);
    const multiFocusRate = Math.max(0, toFiniteNumber(params.multi_focus_rate) ?? 0);
    const singleReturnRate = Math.max(0, toFiniteNumber(params.single_return_rate) ?? 0);
    const multiReturnRate = Math.max(0, toFiniteNumber(params.multi_return_rate) ?? 0);
    const ignoreFafangRate = Math.max(0, toFiniteNumber(params.ignore_fafang_rate) ?? 0);
    const lingqiRestore = Math.max(0, Math.floor(toFiniteNumber(params.lingqi_restore) ?? 0));
    const cooldownReduceIfFull = Math.max(0, Math.floor(toFiniteNumber(params.cooldown_reduce_if_full) ?? 0));
    const parts = [
      `周天衍光：单体分光 ${formatPercent(singleSplitRate)}，群体归曜 ${formatPercent(multiFocusRate)}`,
    ];
    if (singleReturnRate > 0 || multiReturnRate > 0) {
      parts.push(`两仪流照：回天照 ${formatPercent(singleReturnRate)}，流辉照 ${formatPercent(multiReturnRate)}`);
    }
    if (ignoreFafangRate > 0) {
      parts.push(`衍光伤害无视 ${formatPercent(ignoreFafangRate)}法防`);
    }
    if (lingqiRestore > 0 || cooldownReduceIfFull > 0) {
      parts.push(`衍光命中2个及以上目标时回灵 ${lingqiRestore}，灵气已满则当前技能冷却-${cooldownReduceIfFull}回合`);
    }
    main = parts.join("；");
  } else if (effectType === "defer_damage") {
    const thresholdRate = Math.max(0, toFiniteNumber(params.threshold_max_qixue_rate) ?? 0);
    const convertRate = Math.max(0, toFiniteNumber(params.convert_rate) ?? 0);
    const settleRate = Math.max(0, toFiniteNumber(params.settle_rate) ?? 0);
    const shieldRate = Math.max(0, toFiniteNumber(params.shield_rate) ?? 0);
    const remainingRounds = Math.max(0, Math.floor(toFiniteNumber(params.remaining_rounds) ?? 0));
    const reflectOnAbsorb = Boolean(params.reflect_on_absorb);
    if (convertRate > 0) {
      main = `承劫：单次受击达到最大气血 ${formatPercent(thresholdRate)}时，将其中 ${formatPercent(convertRate)} 化为劫痕，${remainingRounds}回合内回落`;
    } else {
      const parts = [`承劫：回合开始获得相当于当前劫痕 ${formatPercent(shieldRate)} 的护盾`];
      if (settleRate > 0) {
        parts.push(`劫痕回落比例 ${formatPercent(settleRate)}`);
      }
      if (reflectOnAbsorb) {
        parts.push("护盾承下劫痕时触发还劫反震");
      }
      main = parts.join("；");
    }
  } else if (effectType === "extra_action") {
    const thresholdRate = Math.max(0, toFiniteNumber(params.damage_threshold_max_qixue_rate) ?? 0);
    const maxActionsPerRound = Math.max(0, Math.floor(toFiniteNumber(params.max_actions_per_round) ?? 0));
    const ignoreWufangRate = Math.max(0, toFiniteNumber(params.ignore_wufang_rate) ?? 0);
    const lowQixueRefundRate = Math.max(0, toFiniteNumber(params.low_qixue_refund_rate) ?? 0);
    const freeCast = Boolean(params.free_cast);
    const killRefund = Boolean(params.kill_refund);
    const parts = [`踏虚：单次命中达到目标最大气血 ${formatPercent(thresholdRate)} 时获得额外行动`];
    if (freeCast || ignoreWufangRate > 0) {
      parts.push(`踏虚行动${freeCast ? "不消耗灵气" : ""}${freeCast && ignoreWufangRate > 0 ? "，" : ""}${ignoreWufangRate > 0 ? `无视 ${formatPercent(ignoreWufangRate)} 物防` : ""}`);
    }
    if (killRefund || lowQixueRefundRate > 0) {
      parts.push(`踏虚行动击杀或首次压至 ${formatPercent(lowQixueRefundRate)} 气血以下时返还 1 次踏虚`);
    }
    if (maxActionsPerRound > 0) {
      parts.push(`每回合最多触发 ${maxActionsPerRound} 次`);
    }
    main = parts.join("；");
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

const stripSetTriggerPrefix = (line: string): string => {
  return line.replace(/^触发：[^，]+，/, "");
};

const DISPEL_TYPE_LABELS: Record<string, string> = {
  poison: "中毒",
};

const CURRENCY_LABELS: Record<string, string> = {
  silver: "银两",
  spirit_stones: "灵石",
};

const buildItemEffectDisplayRecord = (
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  return buildEffectDisplayRecord(raw, {
    defaultTrigger: "equip",
    normalizeManaAsResource: true,
  });
};

const formatLootEffectLine = (params: Record<string, unknown>): string => {
  const lootType =
    typeof params.loot_type === "string" ? params.loot_type.trim() : "";
  if (lootType === "currency") {
    const currency =
      typeof params.currency === "string" ? params.currency.trim() : "";
    const min = toFiniteNumber(params.min);
    const max = toFiniteNumber(params.max);
    const currencyLabel = CURRENCY_LABELS[currency] ?? "货币";
    if (min !== null && max !== null) {
      const minText = Math.floor(min);
      const maxText = Math.floor(max);
      return minText === maxText
        ? `获得${currencyLabel} ${minText}`
        : `获得${currencyLabel} ${minText}~${maxText}`;
    }
    return `获得${currencyLabel}奖励`;
  }

  if (lootType === "random_gem") {
    const minLevel = toFiniteNumber(params.min_level);
    const maxLevel = toFiniteNumber(params.max_level);
    const gemsPerUse = toFiniteNumber(params.gems_per_use);
    const countText =
      gemsPerUse !== null && Math.floor(gemsPerUse) > 1
        ? `×${Math.floor(gemsPerUse)}`
        : "";
    if (minLevel !== null && maxLevel !== null) {
      const minText = Math.floor(minLevel);
      const maxText = Math.floor(maxLevel);
      return minText === maxText
        ? `随机获得${minText}级宝石${countText}`
        : `随机获得${minText}~${maxText}级宝石${countText}`;
    }
    return `随机获得宝石${countText}`;
  }

  if (lootType === "multi") {
    return "获得礼包奖励";
  }

  return "获得物品奖励";
};

const formatExpandEffectLine = (params: Record<string, unknown>): string => {
  const expandType =
    typeof params.expand_type === "string" ? params.expand_type.trim() : "";
  const value = toFiniteNumber(params.value);
  if (expandType === "bag" && value !== null) {
    return `背包扩容 ${Math.floor(value)} 格`;
  }
  if (expandType === "bag") return "扩容背包容量";
  return "扩展功能容量";
};

const formatRerollEffectLine = (params: Record<string, unknown>): string => {
  const targetType =
    typeof params.target_type === "string" ? params.target_type.trim() : "";
  const rerollType =
    typeof params.reroll_type === "string" ? params.reroll_type.trim() : "";
  if (targetType === "equipment" && rerollType === "affixes") {
    return "重洗装备词条";
  }
  return "重置目标属性";
};

/**
 * 作用：
 * - 做什么：把物品 effect_defs 的原始 effect_type 映射成背包详情可直接展示的中文文案。
 * - 不做什么：不执行物品效果、不读取角色状态、不推导掉落结果，只负责静态展示格式化。
 *
 * 输入/输出：
 * - 输入：单条物品 effect_def 原始记录。
 * - 输出：中文效果文案；无法识别时回退“效果：xxx”。
 *
 * 数据流/状态流：
 * - ItemDef.effect_defs -> formatBagItemEffectLine -> buildEffects -> Bag/Market/移动端详情面板。
 *
 * 关键边界条件与坑点：
 * 1. `heal/resource` 等效果在物品定义里常把 `value` 放在顶层，而套装/技能格式化器使用 `params.value`，这里必须先归一化，避免中文格式化失效。
 * 2. 物品效果不需要展示 trigger，因此复用 `formatSetEffectLine` 时要去掉触发前缀，否则会出现“触发：equip”之类的错误文案。
 */
export const formatBagItemEffectLine = (
  raw: Record<string, unknown>,
): string => {
  const effectType =
    typeof raw.effect_type === "string" ? raw.effect_type.trim() : "";
  const params = toRecord(raw.params);
  const normalizedRaw = buildItemEffectDisplayRecord(raw);

  if (
    effectType === "heal" ||
    effectType === "resource" ||
    effectType === "restore_mana" ||
    effectType === "mana" ||
    effectType === "buff" ||
    effectType === "debuff" ||
    effectType === "mark"
  ) {
    const line = formatSetEffectLine(normalizedRaw);
    if (line) return stripSetTriggerPrefix(line);
  }

  if (effectType === "dispel") {
    const dispelType =
      typeof params.dispel_type === "string" ? params.dispel_type.trim() : "";
    const dispelLabel = DISPEL_TYPE_LABELS[dispelType];
    return dispelLabel ? `解除${dispelLabel}状态` : "解除负面状态";
  }

  if (effectType === "loot") return formatLootEffectLine(params);
  if (effectType === "expand") return formatExpandEffectLine(params);
  if (effectType === "reroll") return formatRerollEffectLine(params);
  if (effectType === "learn_technique") return "学习功法";
  if (effectType === "learn_generated_technique") return "学习功法";
  if (effectType === "unbind") return "解除一件已绑定装备的绑定状态";
  if (effectType === "rename_character") return "修改角色道号";
  if (effectType === "activate_month_card") return "激活月卡";
  if (effectType === "activate_battle_pass") return "激活战令";

  return effectType ? `效果：${effectType}` : "效果：未知";
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
    effects.push(formatBagItemEffectLine(e));
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
  const bind = resolveItemBindMeta(it.bind_type);
  const canDisassemble = def.can_disassemble;

  return {
    id: Number(it.id),
    itemDefId: it.item_def_id,
    learnableTechniqueId: getLearnableTechniqueId(def),
    name: def.name,
    category,
    subCategory: def.sub_category ?? null,
    canDisassemble,
    quality,
    tags,
    icon: resolveIcon(def),
    qty: it.qty,
    stackMax: def.stack_max,
    bind,
    location: it.location,
    equippedSlot: it.equipped_slot ?? null,
    locked: !!it.locked,
    desc: def.long_desc || def.description || "",
    effects: buildEffects(def),
    useTargetType: resolveBagItemUseTargetType(def),
    hasSocketEffect,
    actions: mapActions(category, canDisassemble, def.sub_category, def.effect_defs),
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
  effects: InventoryUseEffect[] | null | undefined,
  qty: number,
): { qixue: number; lingqi: number; stamina: number; exp: number } => {
  if (!Array.isArray(effects)) return { qixue: 0, lingqi: 0, stamina: 0, exp: 0 };
  let deltaQixue = 0;
  let deltaLingqi = 0;
  let deltaStamina = 0;
  let deltaExp = 0;
  const safeQty = Math.max(1, Math.floor(Number(qty) || 1));

  for (const rawEffect of effects) {
    if (String(rawEffect.trigger || "") !== "use") continue;
    if (String(rawEffect.target || "self") !== "self") continue;

    const effectType =
      typeof rawEffect.effect_type === "string" ? rawEffect.effect_type : undefined;
    const params = rawEffect.params ?? null;
    const hasRange = params !== null && (params.min !== undefined || params.max !== undefined);
    const value =
      typeof rawEffect.value === "number" ? rawEffect.value : Number(rawEffect.value);
    if (!hasRange && !Number.isFinite(value)) continue;

    if (!effectType || effectType === "heal") {
      if (Number.isFinite(value)) {
        deltaQixue += value * safeQty;
      }
      continue;
    }
    if (effectType === "resource") {
      const resource = params ? String(params.resource || "") : "";
      if (!Number.isFinite(value)) continue;
      if (resource === "qixue") deltaQixue += value * safeQty;
      if (resource === "lingqi") deltaLingqi += value * safeQty;
      if (resource === "stamina") deltaStamina += value * safeQty;
      if (resource === "exp") deltaExp += value * safeQty;
    }
  }
  return {
    qixue: Math.floor(deltaQixue),
    lingqi: Math.floor(deltaLingqi),
    stamina: Math.floor(deltaStamina),
    exp: Math.floor(deltaExp),
  };
};

type UseItemChatContentArgs = {
  itemName: string;
  itemCategory: string;
  useCount: number;
  remaining: number;
  lootResults?: readonly InventoryUseLootResult[];
  beforeCharacter?: InventoryUseCharacterSnapshot | null;
  afterCharacter?: InventoryUseCharacterSnapshot | null;
  effects?: InventoryUseEffect[] | null;
};

/**
 * 作用：
 * - 做什么：统一生成背包使用物品后的系统聊天文案，供桌面端和移动端共享。
 * - 不做什么：不触发请求、不修改角色状态，只根据入参拼装展示文本。
 *
 * 输入/输出：
 * - 输入：物品名称、分类、使用数量、剩余数量，以及使用前后角色快照 / effect / 掉落结果。
 * - 输出：可直接写入系统频道的中文文案。
 *
 * 数据流/状态流：
 * - inventory/use 响应 + gameSocket 当前角色快照 -> formatUseItemChatContent -> BagModal / MobileBagModal -> chat:append。
 *
 * 关键边界条件与坑点：
 * 1. 随机体力恢复要优先读前后角色差值，不能直接读 effect_defs 配置，否则会把 10~20 的区间误当成固定值。
 * 2. 桌面端和移动端都依赖这段文案，必须把“掉落型文案”和“资源恢复型文案”放在同一入口，避免两边继续分叉。
 */
export const formatUseItemChatContent = ({
  itemName,
  itemCategory,
  useCount,
  remaining,
  lootResults,
  beforeCharacter,
  afterCharacter,
  effects,
}: UseItemChatContentArgs): string => {
  const qtyPart = useCount > 1 ? `×${useCount}` : "";
  if (lootResults && lootResults.length > 0) {
    const rewardParts = formatMergedLootResultParts(lootResults);
    return `打开【${itemName}】${qtyPart}，获得${rewardParts.join("、")}。`;
  }

  const beforeQixue = pickNumber(beforeCharacter, ["qixue"]);
  const beforeLingqi = pickNumber(beforeCharacter, ["lingqi"]);
  const beforeExp = pickNumber(beforeCharacter, ["exp"]);
  const beforeStamina = pickNumber(beforeCharacter, ["stamina"]);
  const afterQixue = pickNumber(afterCharacter, ["qixue"]);
  const afterLingqi = pickNumber(afterCharacter, ["lingqi"]);
  const afterExp = pickNumber(afterCharacter, ["exp"]);
  const afterStamina = pickNumber(afterCharacter, ["stamina", "stamina_max"]);
  const effectDelta = calcUseEffectDelta(effects, useCount);

  const qixueByStat =
    beforeQixue !== null && afterQixue !== null ? Math.max(0, Math.floor(afterQixue - beforeQixue)) : null;
  const lingqiByStat =
    beforeLingqi !== null && afterLingqi !== null ? Math.max(0, Math.floor(afterLingqi - beforeLingqi)) : null;
  const expByStat =
    beforeExp !== null && afterExp !== null ? Math.max(0, Math.floor(afterExp - beforeExp)) : null;
  const staminaByStat =
    beforeStamina !== null && afterStamina !== null ? Math.max(0, Math.floor(afterStamina - beforeStamina)) : null;

  const restoredQixue = qixueByStat !== null ? qixueByStat : Math.max(0, Math.floor(effectDelta.qixue));
  const restoredLingqi = lingqiByStat !== null ? lingqiByStat : Math.max(0, Math.floor(effectDelta.lingqi));
  const restoredStamina = staminaByStat !== null ? staminaByStat : Math.max(0, Math.floor(effectDelta.stamina));
  const gainedExp = expByStat !== null ? expByStat : Math.max(0, Math.floor(effectDelta.exp));

  const effectParts: string[] = [];
  if (restoredQixue > 0) effectParts.push(`恢复了${restoredQixue}点气血`);
  if (restoredLingqi > 0) effectParts.push(`恢复了${restoredLingqi}点灵气`);
  if (restoredStamina > 0) effectParts.push(`恢复了${restoredStamina}点体力`);
  if (gainedExp > 0) effectParts.push(`获得了${gainedExp}点经验`);

  if (itemCategory === "consumable") {
    return effectParts.length > 0
      ? `使用【${itemName}】${qtyPart}成功，${effectParts.join("，")}，背包剩余${remaining}。`
      : `使用【${itemName}】${qtyPart}成功，背包剩余${remaining}。`;
  }
  return `使用【${itemName}】成功，背包剩余${remaining}。`;
};
