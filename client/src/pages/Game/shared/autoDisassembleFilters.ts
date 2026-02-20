/**
 * 自动分解筛选项（前端共享）
 *
 * 作用：
 * - 统一“品类/子类”的中文显示，避免各页面重复维护导致英文直出。
 * - 统一筛选值归一化，确保提交给服务端的 value 始终是稳定英文编码。
 * - 对历史规则做最小迁移：旧的 `skillbook` 分类自动迁移为 `skill`。
 *
 * 输入：
 * - 原始值列表（可能包含空值、大小写不一致、重复项）。
 *
 * 输出：
 * - 去重、转小写后的稳定数组；
 * - 用于 Select 的 options（label 中文、value 英文编码）。
 */
import {
  BAG_CATEGORY_OPTIONS,
  BAG_SUB_CATEGORY_OPTIONS,
  BAG_SUB_CATEGORY_VALUES_BY_CATEGORY,
  type BagCategory,
  type LabeledOption,
} from './itemTaxonomy';

export type AutoDisassembleBagCategory = BagCategory;

export const AUTO_DISASSEMBLE_CATEGORY_OPTIONS: LabeledOption[] = [...BAG_CATEGORY_OPTIONS];
export const AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS: LabeledOption[] = [...BAG_SUB_CATEGORY_OPTIONS];

const AUTO_DISASSEMBLE_CATEGORY_VALUE_SET = new Set(
  AUTO_DISASSEMBLE_CATEGORY_OPTIONS.map((option) => option.value)
);

const AUTO_DISASSEMBLE_SUB_CATEGORY_VALUE_SET = new Set(
  AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS.map((option) => option.value)
);

const AUTO_DISASSEMBLE_SUB_CATEGORY_LABEL_MAP = new Map(
  AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS.map((option) => [option.value, option.label] as const)
);

const normalizeStringList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of raw) {
    const value = String(row ?? '').trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const normalizeAutoDisassembleCategoryValue = (raw: string): string => {
  if (raw === 'skillbook' || raw === 'technique' || raw === 'technique_book') return 'skill';
  return raw;
};

export const normalizeAutoDisassembleCategoryList = (raw: unknown): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of normalizeStringList(raw).map(normalizeAutoDisassembleCategoryValue)) {
    if (!AUTO_DISASSEMBLE_CATEGORY_VALUE_SET.has(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

export const normalizeAutoDisassembleSubCategoryList = (raw: unknown): string[] => {
  return normalizeStringList(raw).filter((value) => AUTO_DISASSEMBLE_SUB_CATEGORY_VALUE_SET.has(value));
};

export const getAutoDisassembleSubCategoryLabel = (subCategoryValue: string): string => {
  const normalized = String(subCategoryValue || '').trim().toLowerCase();
  if (!normalized) return '未分类';
  return AUTO_DISASSEMBLE_SUB_CATEGORY_LABEL_MAP.get(normalized) ?? normalized;
};

export const buildAutoDisassembleSubCategoryOptions = (rawValues: string[]): LabeledOption[] => {
  const values = normalizeStringList(rawValues);
  const options = values.map((value) => ({
    value,
    label: getAutoDisassembleSubCategoryLabel(value),
  }));
  options.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN') || a.value.localeCompare(b.value));
  return options;
};

/**
 * 按主分类构建“完整子类型”选项（可附加动态子类型）
 *
 * 输入：
 * - category：当前主分类
 * - extraRawValues：额外子类型（通常来自背包实时数据，用于兜住未来新增值）
 *
 * 输出：
 * - 适配 Select 的 options（value 稳定英文编码，label 中文）
 */
export const buildAutoDisassembleSubCategoryOptionsByCategory = (
  category: AutoDisassembleBagCategory,
  extraRawValues: string[] = [],
): LabeledOption[] => {
  const defaults = BAG_SUB_CATEGORY_VALUES_BY_CATEGORY[category] ?? BAG_SUB_CATEGORY_VALUES_BY_CATEGORY.all;
  return buildAutoDisassembleSubCategoryOptions([...defaults, ...extraRawValues]);
};
