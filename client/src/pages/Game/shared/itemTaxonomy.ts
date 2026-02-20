import type { GameItemTaxonomyDto } from '../../../services/api';

/**
 * 全局物品分类字典（前端单一消费入口）
 *
 * 作用：
 * - 维护“当前生效”的统一 taxonomy 快照，默认值来自本地基线，运行时由后端权威接口覆盖。
 * - 为背包、自动分解、坊市、仓库 Tooltip 提供同一份一级分类/子分类字典。
 *
 * 输入/输出：
 * - 输入：`applyGameItemTaxonomy` 接收后端下发 taxonomy DTO。
 * - 输出：可被全局复用的 `ITEM_CATEGORY_*`、`ITEM_SUB_CATEGORY_*` 与统一 label/归一函数。
 *
 * 数据流/状态流：
 * - 初始使用本地基线常量；
 * - 收到后端 taxonomy 后原地更新（保持引用稳定，避免各模块重复构建字典）。
 *
 * 关键边界条件与坑点：
 * 1) `all` 仅用于 UI 过滤态，业务规则应使用真实一级分类（`ITEM_CATEGORY_OPTIONS`）。
 * 2) 分类值以后端真实一级分类为准，前端不做别名映射与语义转换。
 */

export interface LabeledOption {
  label: string;
  value: string;
}

export type GameItemPrimaryCategory = string;
export type GameItemCategory = 'all' | GameItemPrimaryCategory;

const ITEM_CATEGORY_ALL_OPTION_BASE: LabeledOption = { value: 'all', label: '全部' };

const ITEM_CATEGORY_OPTIONS_BASE: LabeledOption[] = [
  { value: 'consumable', label: '消耗品' },
  { value: 'material', label: '材料' },
  { value: 'gem', label: '宝石' },
  { value: 'equipment', label: '装备' },
  { value: 'quest', label: '任务' },
  { value: 'other', label: '其他' },
];

const buildLabelMapFromOptions = (options: LabeledOption[]): Record<string, string> => {
  return Object.fromEntries(options.map((option) => [option.value, option.label]));
};

const ITEM_CATEGORY_LABELS_BASE: Record<string, string> = {
  all: ITEM_CATEGORY_ALL_OPTION_BASE.label,
  ...buildLabelMapFromOptions(ITEM_CATEGORY_OPTIONS_BASE),
};

const SUB_CATEGORY_OPTIONS_BASE: LabeledOption[] = [
  { label: '剑', value: 'sword' },
  { label: '刀', value: 'blade' },
  { label: '法杖', value: 'staff' },
  { label: '盾牌', value: 'shield' },
  { label: '头盔', value: 'helmet' },
  { label: '帽子', value: 'hat' },
  { label: '法袍', value: 'robe' },
  { label: '手套', value: 'gloves' },
  { label: '臂甲', value: 'gauntlets' },
  { label: '下装', value: 'pants' },
  { label: '护腿', value: 'legguards' },
  { label: '戒指', value: 'ring' },
  { label: '项链', value: 'necklace' },
  { label: '护符', value: 'talisman' },
  { label: '宝镜', value: 'mirror' },
  { label: '配饰', value: 'accessory' },
  { label: '护甲', value: 'armor' },
  { label: '战令道具', value: 'battle_pass' },
  { label: '骨材', value: 'bone' },
  { label: '宝箱', value: 'box' },
  { label: '突破道具', value: 'breakthrough' },
  { label: '采集物', value: 'collect' },
  { label: '蛋类', value: 'egg' },
  { label: '强化道具', value: 'enhance' },
  { label: '精华', value: 'essence' },
  { label: '锻造材料', value: 'forge' },
  { label: '功能道具', value: 'function' },
  { label: '宝石', value: 'gem' },
  { label: '攻击宝石', value: 'gem_attack' },
  { label: '防御宝石', value: 'gem_defense' },
  { label: '生存宝石', value: 'gem_survival' },
  { label: '通用宝石', value: 'gem_all' },
  { label: '灵草', value: 'herb' },
  { label: '钥匙', value: 'key' },
  { label: '皮革', value: 'leather' },
  { label: '月卡道具', value: 'month_card' },
  { label: '杂项道具', value: 'object' },
  { label: '矿石', value: 'ore' },
  { label: '丹药', value: 'pill' },
  { label: '遗物', value: 'relic' },
  { label: '卷轴', value: 'scroll' },
  { label: '功法', value: 'technique' },
  { label: '功法书', value: 'technique_book' },
  { label: '代币', value: 'token' },
  { label: '木材', value: 'wood' },
];

const SUB_CATEGORY_LABELS_BASE: Record<string, string> = buildLabelMapFromOptions(SUB_CATEGORY_OPTIONS_BASE);

const SUB_CATEGORY_VALUES_BY_CATEGORY_BASE: Record<string, string[]> = {
  all: [],
  ...Object.fromEntries(ITEM_CATEGORY_OPTIONS_BASE.map((option) => [option.value, [] as string[]])),
};

export const ITEM_CATEGORY_ALL_OPTION: LabeledOption = { ...ITEM_CATEGORY_ALL_OPTION_BASE };
export const ITEM_CATEGORY_OPTIONS: LabeledOption[] = [...ITEM_CATEGORY_OPTIONS_BASE];
export const ITEM_CATEGORY_LABELS: Record<string, string> = { ...ITEM_CATEGORY_LABELS_BASE };

export const ITEM_SUB_CATEGORY_OPTIONS: LabeledOption[] = [...SUB_CATEGORY_OPTIONS_BASE];
export const ITEM_SUB_CATEGORY_LABELS: Record<string, string> = { ...SUB_CATEGORY_LABELS_BASE };
export const ITEM_SUB_CATEGORY_VALUES_BY_CATEGORY: Record<string, string[]> = Object.fromEntries(
  Object.entries(SUB_CATEGORY_VALUES_BY_CATEGORY_BASE).map(([key, values]) => [key, [...values]])
);

const replaceArrayInPlace = <T>(target: T[], source: T[]): void => {
  target.splice(0, target.length, ...source);
};

const replaceRecordInPlace = (target: Record<string, string>, source: Record<string, string>): void => {
  for (const key of Object.keys(target)) {
    if (source[key] !== undefined) continue;
    delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
};

const replaceStringArrayRecordInPlace = (target: Record<string, string[]>, source: Record<string, string[]>): void => {
  for (const key of Object.keys(target)) {
    if (source[key] !== undefined) continue;
    delete target[key];
  }
  for (const [key, values] of Object.entries(source)) {
    target[key] = [...values];
  }
};

const normalizeToken = (raw: unknown): string => String(raw ?? '').trim().toLowerCase();

const normalizeOptions = (raw: unknown): LabeledOption[] => {
  if (!Array.isArray(raw)) return [];
  const out: LabeledOption[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const value = normalizeToken((row as { value?: unknown })?.value);
    const label = String((row as { label?: unknown })?.label ?? '').trim();
    if (!value || !label || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label });
  }
  return out;
};

const normalizeOption = (raw: unknown): LabeledOption | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = normalizeToken((raw as { value?: unknown }).value);
  const label = String((raw as { label?: unknown }).label ?? '').trim();
  if (!value || !label) return null;
  return { value, label };
};

const normalizeStringMap = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeToken(key);
    const normalizedValue = String(value ?? '').trim();
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return out;
};

const normalizeStringArrayMap = (raw: unknown): Record<string, string[]> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = normalizeToken(key);
    if (!normalizedKey || !Array.isArray(value)) continue;
    const seen = new Set<string>();
    const values: string[] = [];
    for (const row of value) {
      const normalizedValue = normalizeToken(row);
      if (!normalizedValue || seen.has(normalizedValue)) continue;
      seen.add(normalizedValue);
      values.push(normalizedValue);
    }
    out[normalizedKey] = values;
  }
  return out;
};

export const applyGameItemTaxonomy = (taxonomy: GameItemTaxonomyDto): void => {
  const allOption = normalizeOption(taxonomy?.categories?.all);
  const categoryOptions = normalizeOptions(taxonomy?.categories?.options);
  const categoryLabels = normalizeStringMap(taxonomy?.categories?.labels);

  const subCategoryOptions = normalizeOptions(taxonomy?.subCategories?.options);
  const subCategoryLabels = normalizeStringMap(taxonomy?.subCategories?.labels);
  const byCategory = normalizeStringArrayMap(taxonomy?.subCategories?.byCategory);

  if (allOption && allOption.value === 'all') {
    ITEM_CATEGORY_ALL_OPTION.label = allOption.label;
    ITEM_CATEGORY_ALL_OPTION.value = allOption.value;
  }

  if (categoryOptions.length > 0) {
    replaceArrayInPlace(ITEM_CATEGORY_OPTIONS, categoryOptions);
  }

  const nextCategoryLabels: Record<string, string> = {
    ...categoryLabels,
    all: categoryLabels.all ?? ITEM_CATEGORY_ALL_OPTION.label,
  };
  for (const option of ITEM_CATEGORY_OPTIONS) {
    if (!nextCategoryLabels[option.value]) {
      nextCategoryLabels[option.value] = option.label;
    }
  }
  replaceRecordInPlace(ITEM_CATEGORY_LABELS, nextCategoryLabels);

  if (subCategoryOptions.length > 0) {
    replaceArrayInPlace(ITEM_SUB_CATEGORY_OPTIONS, subCategoryOptions);
  }

  const nextSubCategoryLabels: Record<string, string> = {
    ...subCategoryLabels,
  };
  for (const option of ITEM_SUB_CATEGORY_OPTIONS) {
    if (!nextSubCategoryLabels[option.value]) {
      nextSubCategoryLabels[option.value] = option.label;
    }
  }
  replaceRecordInPlace(ITEM_SUB_CATEGORY_LABELS, nextSubCategoryLabels);

  const nextByCategory: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(byCategory)) {
    nextByCategory[key] = [...values];
  }
  if (!nextByCategory.all || nextByCategory.all.length === 0) {
    nextByCategory.all = ITEM_SUB_CATEGORY_OPTIONS.map((option) => option.value);
  }
  for (const option of ITEM_CATEGORY_OPTIONS) {
    if (!nextByCategory[option.value]) {
      nextByCategory[option.value] = [];
    }
  }
  replaceStringArrayRecordInPlace(ITEM_SUB_CATEGORY_VALUES_BY_CATEGORY, nextByCategory);
};

export const getItemTaxonomyLabel = (value: unknown): string => {
  const key = normalizeToken(value);
  if (!key) return '';
  return ITEM_SUB_CATEGORY_LABELS[key] || ITEM_CATEGORY_LABELS[key] || key;
};
