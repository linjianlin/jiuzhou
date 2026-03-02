/**
 * 背包领域公共类型与常量定义
 *
 * 作用：集中维护所有背包子模块共享的类型和常量，
 *       避免循环依赖和散落重复定义。
 *
 * 被引用方：shared/attrDelta、shared/consume、shared/validation、
 *           bag、equipment、socket、disassemble、itemQuery、service
 *
 * 边界条件：
 * 1. CharacterAttrKey 必须与 characters 表的可写属性列严格匹配
 * 2. allowedCharacterAttrKeys 集合是属性差分写入的白名单，新增属性必须同步维护
 */

// 背包位置类型
export type InventoryLocation = "bag" | "warehouse" | "equipped";
export type SlottedInventoryLocation = "bag" | "warehouse";

// 背包物品接口
export interface InventoryItem {
  id: number;
  item_def_id: string;
  qty: number;
  quality: string | null;
  quality_rank: number | null;
  location: InventoryLocation;
  location_slot: number | null;
  equipped_slot: string | null;
  strengthen_level: number;
  refine_level: number;
  socketed_gems: unknown;
  affixes: any;
  identified: boolean;
  locked: boolean;
  bind_type: string;
  created_at: Date;
}

// 带定义聚合的物品接口
export interface InventoryItemWithDef extends InventoryItem {
  def?: Record<string, unknown>;
}

// 背包信息接口
export interface InventoryInfo {
  bag_capacity: number;
  warehouse_capacity: number;
  bag_used: number;
  warehouse_used: number;
}

// 角色属性 key 类型（用于属性差分计算）
export type CharacterAttrKey =
  | "qixue"
  | "max_qixue"
  | "lingqi"
  | "max_lingqi"
  | "wugong"
  | "fagong"
  | "wufang"
  | "fafang"
  | "sudu"
  | "mingzhong"
  | "shanbi"
  | "zhaojia"
  | "baoji"
  | "baoshang"
  | "kangbao"
  | "zengshang"
  | "zhiliao"
  | "jianliao"
  | "xixue"
  | "lengque"
  | "shuxing_shuzhi"
  | "kongzhi_kangxing"
  | "jin_kangxing"
  | "mu_kangxing"
  | "shui_kangxing"
  | "huo_kangxing"
  | "tu_kangxing"
  | "qixue_huifu"
  | "lingqi_huifu";

// 角色属性白名单集合
export const allowedCharacterAttrKeys = new Set<CharacterAttrKey>([
  "qixue",
  "max_qixue",
  "lingqi",
  "max_lingqi",
  "wugong",
  "fagong",
  "wufang",
  "fafang",
  "sudu",
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
  "shuxing_shuzhi",
  "kongzhi_kangxing",
  "jin_kangxing",
  "mu_kangxing",
  "shui_kangxing",
  "huo_kangxing",
  "tu_kangxing",
  "qixue_huifu",
  "lingqi_huifu",
]);

// 背包容量常量
export const BAG_CAPACITY_MAX = 200;
export const DEFAULT_BAG_CAPACITY = 100;
export const DEFAULT_WAREHOUSE_CAPACITY = 1000;

// 拆解奖励类型
export type DisassembleGrantedItemReward = {
  itemDefId: string;
  qty: number;
  itemIds?: number[];
};

export type DisassembleRewardsPayload = {
  silver: number;
  items: DisassembleGrantedItemReward[];
};
