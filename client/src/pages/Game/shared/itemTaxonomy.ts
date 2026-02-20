/**
 * 物品分类/子类公用字典
 *
 * 作用：
 * - 统一背包、自动分解等模块对“主分类/子类”枚举与中文文案的单一来源，避免各模块独自维护导致口径漂移。
 * - 提供稳定可复用的 options 与按分类分组的子类白名单，减少重复映射逻辑。
 *
 * 输入/输出：
 * - 输入：无（纯静态配置模块）。
 * - 输出：
 *   1) `BagCategory`、`BagPrimaryCategory` 类型；
 *   2) 主分类文案、主分类 options；
 *   3) 子类 options、子类按主分类白名单。
 *
 * 数据流/状态流：
 * - 业务模块仅消费本模块导出的常量与类型，不在模块外改写；
 * - 自动分解与背包筛选都复用同一字典，实现“改一处、全链路同步”。
 *
 * 关键边界条件与坑点：
 * 1) `all` 仅用于界面筛选态，不应进入自动分解规则持久化数据。
 * 2) `technique_book` 与 `technique` 必须保持在 `skill` 主分类白名单中，避免功法相关筛选失效。
 */

export interface LabeledOption {
  label: string;
  value: string;
}

export type BagCategory =
  | 'all'
  | 'consumable'
  | 'material'
  | 'gem'
  | 'equipment'
  | 'skill'
  | 'quest';

export type BagPrimaryCategory = Exclude<BagCategory, 'all'>;

export const BAG_CATEGORY_LABELS: Record<BagCategory, string> = {
  all: '全部',
  consumable: '丹药',
  material: '材料',
  gem: '宝石',
  equipment: '装备',
  skill: '功法',
  quest: '任务',
};

const BAG_CATEGORY_OPTION_ORDER: BagPrimaryCategory[] = [
  'equipment',
  'consumable',
  'material',
  'gem',
  'skill',
  'quest',
];

export const BAG_CATEGORY_OPTIONS: LabeledOption[] = BAG_CATEGORY_OPTION_ORDER.map((value) => ({
  value,
  label: BAG_CATEGORY_LABELS[value],
}));

export const BAG_SUB_CATEGORY_OPTIONS: LabeledOption[] = [
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

export const BAG_SUB_CATEGORY_VALUES_BY_CATEGORY: Record<BagCategory, string[]> = {
  all: BAG_SUB_CATEGORY_OPTIONS.map((option) => option.value),
  consumable: ['pill', 'box', 'function', 'enhance', 'scroll', 'month_card', 'battle_pass', 'token'],
  material: [
    'herb',
    'ore',
    'wood',
    'leather',
    'essence',
    'bone',
    'relic',
    'forge',
    'breakthrough',
    'egg',
    'accessory',
    'armor',
    'object',
  ],
  gem: ['gem', 'gem_attack', 'gem_defense', 'gem_survival', 'gem_all'],
  equipment: [
    'sword',
    'blade',
    'staff',
    'shield',
    'helmet',
    'hat',
    'robe',
    'gloves',
    'gauntlets',
    'pants',
    'legguards',
    'ring',
    'necklace',
    'talisman',
    'mirror',
    'accessory',
    'armor',
    'token',
  ],
  skill: ['technique', 'technique_book'],
  quest: ['key', 'collect'],
};
