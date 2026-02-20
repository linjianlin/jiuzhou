import { getItemDefinitions } from './staticConfigLoader.js';

/**
 * 全局物品分类字典服务（后端权威）
 *
 * 作用：
 * - 提供全游戏统一 taxonomy（categories/subCategories），所有模块消费同一份后端真实一级分类。
 * - 不做任何别名/转换：一级分类直接来源于 `item_def.category`。
 *
 * 输入/输出：
 * - 输入：静态物品定义（item_def）。
 * - 输出：统一 taxonomy DTO（主分类 options/labels + 子分类 options/labels/byCategory）。
 *
 * 数据流/状态流：
 * - 读取静态定义 -> 提取真实一级分类与子分类 -> 生成只读 DTO。
 * - 无持久状态、无副作用，路由层按需调用。
 *
 * 关键边界条件与坑点：
 * 1) 空 `category` 会被忽略，不进入一级分类集合。
 * 2) 未登记中文名的子分类会回退显示为其编码本身，避免遗漏。
 */

export interface ItemTaxonomyOptionDto {
  value: string;
  label: string;
}

export interface GameItemTaxonomyDto {
  categories: {
    all: ItemTaxonomyOptionDto;
    options: ItemTaxonomyOptionDto[];
    labels: Record<string, string>;
  };
  subCategories: {
    options: ItemTaxonomyOptionDto[];
    labels: Record<string, string>;
    byCategory: Record<string, string[]>;
  };
}

const CATEGORY_LABEL_FALLBACK: Record<string, string> = {
  consumable: '消耗品',
  material: '材料',
  gem: '宝石',
  equipment: '装备',
  quest: '任务',
  other: '其他',
};

const CATEGORY_PREFERRED_ORDER = ['consumable', 'material', 'gem', 'equipment', 'quest', 'other'] as const;

const SUB_CATEGORY_LABEL_FALLBACK: Record<string, string> = {
  sword: '剑',
  blade: '刀',
  staff: '法杖',
  shield: '盾牌',
  helmet: '头盔',
  hat: '帽子',
  robe: '法袍',
  gloves: '手套',
  gauntlets: '臂甲',
  pants: '下装',
  legguards: '护腿',
  ring: '戒指',
  necklace: '项链',
  talisman: '护符',
  mirror: '宝镜',
  accessory: '配饰',
  armor: '护甲',
  battle_pass: '战令道具',
  bone: '骨材',
  box: '宝箱',
  breakthrough: '突破道具',
  collect: '采集物',
  egg: '蛋类',
  enhance: '强化道具',
  essence: '精华',
  forge: '锻造材料',
  function: '功能道具',
  gem: '宝石',
  gem_attack: '攻击宝石',
  gem_defense: '防御宝石',
  gem_survival: '生存宝石',
  gem_all: '通用宝石',
  herb: '灵草',
  key: '钥匙',
  leather: '皮革',
  month_card: '月卡道具',
  object: '杂项道具',
  ore: '矿石',
  pill: '丹药',
  relic: '遗物',
  scroll: '卷轴',
  technique: '功法',
  technique_book: '功法书',
  token: '代币',
  wood: '木材',
};

const normalizeToken = (raw: unknown): string => {
  return String(raw ?? '').trim().toLowerCase();
};

const pushUnique = (list: string[], value: string): void => {
  if (!value) return;
  if (list.includes(value)) return;
  list.push(value);
};

const sortCategoryValues = (values: string[]): string[] => {
  const rank = new Map<string, number>(CATEGORY_PREFERRED_ORDER.map((value, index) => [value, index]));
  return [...values].sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return left.localeCompare(right, 'zh-Hans-CN');
  });
};

export const buildGameItemTaxonomy = (): GameItemTaxonomyDto => {
  const itemDefs = getItemDefinitions().filter((entry) => entry.enabled !== false);

  const categorySet = new Set<string>();
  const subCategoryLabels: Record<string, string> = {};
  const subCategoryByCategory: Record<string, string[]> = { all: [] };

  for (const itemDef of itemDefs) {
    const category = normalizeToken(itemDef.category);
    if (category) {
      categorySet.add(category);
      if (!subCategoryByCategory[category]) {
        subCategoryByCategory[category] = [];
      }
    }

    const subCategory = normalizeToken(itemDef.sub_category);
    if (!subCategory) continue;

    if (!subCategoryLabels[subCategory]) {
      subCategoryLabels[subCategory] = SUB_CATEGORY_LABEL_FALLBACK[subCategory] ?? subCategory;
    }

    pushUnique(subCategoryByCategory.all, subCategory);
    if (category) {
      pushUnique(subCategoryByCategory[category] ?? (subCategoryByCategory[category] = []), subCategory);
    }
  }

  const categoryValues = sortCategoryValues(Array.from(categorySet));
  const categoryLabels: Record<string, string> = { all: '全部' };
  for (const category of categoryValues) {
    categoryLabels[category] = CATEGORY_LABEL_FALLBACK[category] ?? category;
    if (!subCategoryByCategory[category]) {
      subCategoryByCategory[category] = [];
    }
  }

  const categoryOptions = categoryValues.map((value) => ({
    value,
    label: categoryLabels[value] ?? value,
  }));

  const subCategoryOptions = Object.entries(subCategoryLabels)
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN') || left.value.localeCompare(right.value));

  return {
    categories: {
      all: { value: 'all', label: categoryLabels.all },
      options: categoryOptions,
      labels: categoryLabels,
    },
    subCategories: {
      options: subCategoryOptions,
      labels: subCategoryLabels,
      byCategory: subCategoryByCategory,
    },
  };
};
