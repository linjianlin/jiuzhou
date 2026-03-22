/**
 * 玩家状态仓库类型
 *
 * 作用：
 * 1. 做什么：集中声明 Redis 主状态仓库使用的角色、物品、元数据与 JSON 值类型，避免各模块各写一套弱类型对象。
 * 2. 做什么：为 hydrate、仓库读写、flush 三层共享同一份结构，减少字段扩展时的重复修改点。
 * 3. 不做什么：不承载业务规则，不负责 Redis/DB 访问，不做字段默认值推断。
 *
 * 输入/输出：
 * - 输入：无；本模块仅导出类型与字段常量。
 * - 输出：玩家角色状态、物品状态、元数据状态与 JSON 值类型。
 *
 * 数据流/状态流：
 * DB hydrate -> PlayerCharacterState / PlayerInventoryItemState -> Redis
 * Redis read/patch -> flush -> PostgreSQL。
 *
 * 关键边界条件与坑点：
 * 1. 角色与物品状态必须保留 flush 所需字段；否则 Redis 成为主状态后会在刷库时丢列。
 * 2. JSON 字段必须显式标记，避免 flush 时把对象误当普通文本列写回。
 */

export type PlayerStateJsonPrimitive = boolean | number | string | null;
export type PlayerStateJsonValue =
  | PlayerStateJsonPrimitive
  | PlayerStateJsonValue[]
  | { [key: string]: PlayerStateJsonValue | undefined }
  | object;

export type PlayerCharacterState = {
  id: number;
  user_id: number;
  nickname: string;
  title: string;
  gender: string;
  avatar: string | null;
  auto_cast_skills: boolean;
  auto_disassemble_enabled: boolean;
  auto_disassemble_rules: PlayerStateJsonValue;
  dungeon_no_stamina_cost: boolean;
  spirit_stones: number;
  silver: number;
  stamina: number;
  stamina_recover_at: string | null;
  realm: string;
  sub_realm: string | null;
  exp: number;
  attribute_points: number;
  jing: number;
  qi: number;
  shen: number;
  attribute_type: string;
  attribute_element: string;
  current_map_id: string;
  current_room_id: string;
  last_offline_at: string | null;
};

export type PlayerCharacterStatePatch = Partial<Omit<PlayerCharacterState, 'id' | 'user_id'>>;

export type PlayerInventoryItemState = {
  id: number;
  owner_user_id: number;
  owner_character_id: number;
  item_def_id: string;
  qty: number;
  locked: boolean;
  quality: string | null;
  quality_rank: number | null;
  strengthen_level: number | null;
  refine_level: number | null;
  socketed_gems: PlayerStateJsonValue;
  affixes: PlayerStateJsonValue;
  affix_gen_version: number | null;
  affix_roll_meta: PlayerStateJsonValue;
  identified: boolean | null;
  bind_type: string | null;
  bind_owner_user_id: number | null;
  bind_owner_character_id: number | null;
  location: string;
  location_slot: number | null;
  equipped_slot: string | null;
  random_seed: number | null;
  custom_name: string | null;
  expire_at: string | null;
  obtained_from: string | null;
  obtained_ref_id: string | null;
  metadata: PlayerStateJsonValue;
  created_at: string | null;
};

export type PlayerInventoryItemStatePatch = Partial<Omit<PlayerInventoryItemState, 'id' | 'owner_user_id' | 'owner_character_id'>>;

export type PlayerStateMeta = {
  version: number;
  dirtyCharacter: boolean;
  dirtyInventory: boolean;
  hydratedAt: string;
  lastFlushAt: string | null;
};

export const PLAYER_CHARACTER_JSON_FIELDS = new Set<keyof PlayerCharacterState>([
  'auto_disassemble_rules',
]);

export const PLAYER_CHARACTER_TIMESTAMP_FIELDS = new Set<keyof PlayerCharacterState>([
  'stamina_recover_at',
  'last_offline_at',
]);

export const PLAYER_INVENTORY_JSON_FIELDS = new Set<keyof PlayerInventoryItemState>([
  'socketed_gems',
  'affixes',
  'affix_roll_meta',
  'metadata',
]);

export const PLAYER_INVENTORY_TIMESTAMP_FIELDS = new Set<keyof PlayerInventoryItemState>([
  'created_at',
  'expire_at',
]);
