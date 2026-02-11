/**
 * 种子数据加载服务
 * 用于从JSON文件加载并插入/更新数据库中的配置数据
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { query } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEDS_DIR = [
  path.join(process.cwd(), 'src', 'data', 'seeds'),
  path.join(process.cwd(), 'dist', 'data', 'seeds'),
  path.join(__dirname, '../data/seeds'),
].find((p) => fs.existsSync(p)) ?? path.join(__dirname, '../data/seeds');

// 读取JSON文件
const readJsonFile = <T>(filename: string): T | null => {
  try {
    const filePath = path.join(SEEDS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      console.log(`种子文件不存在: ${filename}`);
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`读取种子文件失败 ${filename}:`, error);
    return null;
  }
};

// 物品定义接口
interface ItemDefSeed {
  id: string;
  code?: string;
  name: string;
  category: string;
  sub_category?: string;
  quality: string;
  quality_rank: number;
  quality_min?: string;
  quality_max?: string;
  rarity?: string;
  level: number;
  stack_max: number;
  bind_type: string;
  tradeable: boolean;
  sellable: boolean;
  sell_price_silver: number;
  sell_price_spirit_stones?: number;
  icon?: string;
  model?: string;
  description?: string;
  long_desc?: string;
  tags?: string[];
  use_type?: string;
  use_cd_round?: number;
  use_cd_sec?: number;
  use_limit_daily?: number;
  use_limit_total?: number;
  use_req_realm?: string;
  use_req_level?: number;
  use_req_attrs?: Record<string, number>;
  equip_slot?: string;
  equip_req_realm?: string;
  equip_req_attrs?: Record<string, number>;
  battle_skill_ids?: string[];
  effect_defs?: unknown[];
  base_attrs?: Record<string, number>;
  growth_attrs?: Record<string, unknown>;
  affix_pool_id?: string;
  affix_count_min?: number;
  affix_count_max?: number;
  socket_max?: number;
  gem_slot_types?: string[];
  set_id?: string;
  composed_from?: string[];
  source_hint?: string[];
  market_min_price?: number;
  market_max_price?: number;
  tax_rate?: number;
  expire_seconds?: number;
  unique_type?: string;
  unique_limit?: number;
  quest_only?: boolean;
  droppable?: boolean;
  destroyable?: boolean;
  mailable?: boolean;
  storageable?: boolean;
  sort_weight?: number;
}

interface TaskObjectiveSeed {
  id: string;
  type: string;
  text: string;
  target: number;
  params?: Record<string, unknown>;
}

interface TaskRewardSeed {
  type: string;
  item_def_id?: string;
  qty?: number;
  amount?: number;
}

interface TaskDefSeed {
  id: string;
  category: string;
  title: string;
  realm: string;
  description?: string;
  giver_npc_id?: string;
  map_id?: string;
  room_id?: string;
  objectives?: TaskObjectiveSeed[];
  rewards?: TaskRewardSeed[];
  prereq_task_ids?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
}

interface BountyDefSeed {
  id: string;
  pool?: string;
  task_id: string;
  title: string;
  description?: string;
  claim_policy?: string;
  max_claims?: number;
  weight?: number;
  enabled?: boolean;
  version?: number;
}

interface AchievementDefSeed {
  id: string;
  name: string;
  description?: string;
  category?: string;
  rarity?: string;
  points?: number;
  icon?: string;
  hidden?: boolean;
  prerequisite_id?: string | null;
  track_type?: string;
  track_key: string;
  target_value?: number;
  target_list?: unknown[];
  rewards?: unknown[];
  title_id?: string | null;
  sort_weight?: number;
  enabled?: boolean;
  version?: number;
}

interface TitleDefSeed {
  id: string;
  name: string;
  description?: string;
  rarity?: string;
  color?: string;
  icon?: string;
  effects?: Record<string, unknown>;
  source_type?: string;
  source_id?: string;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
}

interface AchievementPointsRewardSeed {
  id: string;
  points_threshold: number;
  name: string;
  description?: string;
  rewards?: unknown[];
  title_id?: string | null;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
}

// 加载物品定义
export const loadItemDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ items: ItemDefSeed[] }>('item_def.json');
  if (!data?.items) return 0;

  let count = 0;
  for (const item of data.items) {
    try {
      const sql = `
        INSERT INTO item_def (
          id, code, name, category, sub_category, quality, quality_rank, rarity, level,
          stack_max, bind_type, tradeable, sellable, sell_price_silver, sell_price_spirit_stones,
          icon, model, description, long_desc, tags, use_type, use_cd_round, use_cd_sec,
          use_limit_daily, use_limit_total, use_req_realm, use_req_level, use_req_attrs,
          equip_slot, equip_req_realm, equip_req_attrs, battle_skill_ids, effect_defs,
          base_attrs, growth_attrs, affix_pool_id, affix_count_min, affix_count_max,
          socket_max, gem_slot_types, set_id, composed_from, source_hint,
          market_min_price, market_max_price, tax_rate, expire_seconds,
          unique_type, unique_limit, quest_only, droppable, destroyable, mailable, storageable,
          quality_min, quality_max, sort_weight, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22, $23,
          $24, $25, $26, $27, $28,
          $29, $30, $31, $32, $33,
          $34, $35, $36, $37, $38,
          $39, $40, $41, $42, $43,
          $44, $45, $46, $47,
          $48, $49, $50, $51, $52, $53, $54,
          $55, $56, $57, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          sub_category = EXCLUDED.sub_category,
          quality = EXCLUDED.quality,
          quality_rank = EXCLUDED.quality_rank,
          quality_min = EXCLUDED.quality_min,
          quality_max = EXCLUDED.quality_max,
          rarity = EXCLUDED.rarity,
          level = EXCLUDED.level,
          stack_max = EXCLUDED.stack_max,
          bind_type = EXCLUDED.bind_type,
          tradeable = EXCLUDED.tradeable,
          sellable = EXCLUDED.sellable,
          sell_price_silver = EXCLUDED.sell_price_silver,
          sell_price_spirit_stones = EXCLUDED.sell_price_spirit_stones,
          icon = EXCLUDED.icon,
          description = EXCLUDED.description,
          tags = EXCLUDED.tags,
          effect_defs = EXCLUDED.effect_defs,
          base_attrs = EXCLUDED.base_attrs,
          affix_pool_id = EXCLUDED.affix_pool_id,
          affix_count_min = EXCLUDED.affix_count_min,
          affix_count_max = EXCLUDED.affix_count_max,
          source_hint = EXCLUDED.source_hint,
          updated_at = NOW()
      `;

      await query(sql, [
        item.id, item.code || null, item.name, item.category, item.sub_category || null,
        item.quality, item.quality_rank, item.rarity || null, item.level,
        item.stack_max, item.bind_type, item.tradeable, item.sellable,
        item.sell_price_silver, item.sell_price_spirit_stones || 0,
        item.icon || null, item.model || null, item.description || null, item.long_desc || null,
        item.tags ? JSON.stringify(item.tags) : null,
        item.use_type || null, item.use_cd_round || 0, item.use_cd_sec || 0,
        item.use_limit_daily || 0, item.use_limit_total || 0,
        item.use_req_realm || null, item.use_req_level || 0,
        item.use_req_attrs ? JSON.stringify(item.use_req_attrs) : null,
        item.equip_slot || null, item.equip_req_realm || null,
        item.equip_req_attrs ? JSON.stringify(item.equip_req_attrs) : null,
        item.battle_skill_ids ? JSON.stringify(item.battle_skill_ids) : null,
        item.effect_defs ? JSON.stringify(item.effect_defs) : null,
        item.base_attrs ? JSON.stringify(item.base_attrs) : null,
        item.growth_attrs ? JSON.stringify(item.growth_attrs) : null,
        item.affix_pool_id || null, item.affix_count_min || 0, item.affix_count_max || 0,
        item.socket_max || 0, item.gem_slot_types ? JSON.stringify(item.gem_slot_types) : null,
        item.set_id || null, item.composed_from ? JSON.stringify(item.composed_from) : null,
        item.source_hint ? JSON.stringify(item.source_hint) : null,
        item.market_min_price || 0, item.market_max_price || 0, item.tax_rate || 0,
        item.expire_seconds || 0, item.unique_type || 'none', item.unique_limit || 0,
        item.quest_only || false, item.droppable !== false, item.destroyable !== false,
        item.mailable !== false, item.storageable !== false,
        item.quality_min || null, item.quality_max || null,
        item.sort_weight || 0
      ]);
      count++;
    } catch (error) {
      console.error(`插入物品定义失败 ${item.id}:`, error);
    }
  }
  return count;
};

// 加载装备定义
export const loadEquipmentDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ items: ItemDefSeed[] }>('equipment_def.json');
  if (!data?.items) return 0;

  let count = 0;
  for (const item of data.items) {
    // 跳过注释对象（没有id字段的对象）
    if (!item.id) {
      continue;
    }
    
    try {
      // 复用物品定义的插入逻辑
      const sql = `
        INSERT INTO item_def (
          id, code, name, category, sub_category, quality, quality_rank, rarity, level,
          stack_max, bind_type, tradeable, sellable, sell_price_silver, sell_price_spirit_stones,
          icon, description, equip_slot, equip_req_realm, equip_req_attrs,
          base_attrs, affix_pool_id, affix_count_min, affix_count_max,
          set_id, tags, quality_min, quality_max, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25, $26, $27, $28, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          category = EXCLUDED.category,
          sub_category = EXCLUDED.sub_category,
          quality = EXCLUDED.quality,
          quality_rank = EXCLUDED.quality_rank,
          quality_min = EXCLUDED.quality_min,
          quality_max = EXCLUDED.quality_max,
          rarity = EXCLUDED.rarity,
          level = EXCLUDED.level,
          stack_max = EXCLUDED.stack_max,
          bind_type = EXCLUDED.bind_type,
          tradeable = EXCLUDED.tradeable,
          sellable = EXCLUDED.sellable,
          sell_price_silver = EXCLUDED.sell_price_silver,
          sell_price_spirit_stones = EXCLUDED.sell_price_spirit_stones,
          icon = EXCLUDED.icon,
          description = EXCLUDED.description,
          equip_slot = EXCLUDED.equip_slot,
          equip_req_realm = EXCLUDED.equip_req_realm,
          equip_req_attrs = EXCLUDED.equip_req_attrs,
          base_attrs = EXCLUDED.base_attrs,
          affix_pool_id = EXCLUDED.affix_pool_id,
          affix_count_min = EXCLUDED.affix_count_min,
          affix_count_max = EXCLUDED.affix_count_max,
          set_id = EXCLUDED.set_id,
          tags = EXCLUDED.tags,
          updated_at = NOW()
      `;

      await query(sql, [
        item.id, item.code || null, item.name, item.category, item.sub_category || null,
        item.quality, item.quality_rank, item.rarity || null, item.level,
        item.stack_max, item.bind_type, item.tradeable, item.sellable,
        item.sell_price_silver, item.sell_price_spirit_stones || 0,
        item.icon || null, item.description || null,
        item.equip_slot || null, item.equip_req_realm || null,
        item.equip_req_attrs ? JSON.stringify(item.equip_req_attrs) : null,
        item.base_attrs ? JSON.stringify(item.base_attrs) : null,
        item.affix_pool_id || null, item.affix_count_min || 0, item.affix_count_max || 0,
        item.set_id || null, item.tags ? JSON.stringify(item.tags) : null,
        item.quality_min || null, item.quality_max || null
      ]);
      count++;
    } catch (error) {
      console.error(`插入装备定义失败 ${item.id}:`, error);
    }
  }
  return count;
};


// 词条池接口
interface AffixPoolSeed {
  id: string;
  name: string;
  description?: string;
  rules: Record<string, unknown>;
  affixes: unknown[];
}

// 加载词条池
export const loadAffixPoolSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ pools: AffixPoolSeed[] }>('affix_pool.json');
  if (!data?.pools) return 0;

  let count = 0;
  for (const pool of data.pools) {
    try {
      const sql = `
        INSERT INTO affix_pool (id, name, description, rules, affixes, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          rules = EXCLUDED.rules,
          affixes = EXCLUDED.affixes,
          updated_at = NOW()
      `;

      await query(sql, [
        pool.id,
        pool.name,
        pool.description || null,
        JSON.stringify(pool.rules),
        JSON.stringify(pool.affixes)
      ]);
      count++;
    } catch (error) {
      console.error(`插入词条池失败 ${pool.id}:`, error);
    }
  }
  return count;
};

// 套装接口
interface ItemSetSeed {
  id: string;
  name: string;
  description?: string;
  quality_rank: number;
  min_realm?: string;
  pieces: Array<{
    equip_slot: string;
    item_def_id: string;
    piece_key: string;
  }>;
  bonuses: Array<{
    piece_count: number;
    effect_defs: unknown[];
    priority: number;
  }>;
}

// 加载套装定义
export const loadItemSetSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ sets: ItemSetSeed[] }>('item_set.json');
  if (!data?.sets) return 0;

  let count = 0;
  for (const set of data.sets) {
    try {
      // 插入套装定义
      const setSql = `
        INSERT INTO item_set (id, name, description, quality_rank, min_realm, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          quality_rank = EXCLUDED.quality_rank,
          min_realm = EXCLUDED.min_realm,
          updated_at = NOW()
      `;

      await query(setSql, [
        set.id,
        set.name,
        set.description || null,
        set.quality_rank,
        set.min_realm || null
      ]);

      // 删除旧的套装件和加成
      await query('DELETE FROM item_set_piece WHERE set_id = $1', [set.id]);
      await query('DELETE FROM item_set_bonus WHERE set_id = $1', [set.id]);

      // 插入套装件（需要先确保item_def存在）
      for (const piece of set.pieces) {
        try {
          // 检查item_def是否存在
          const checkResult = await query('SELECT id FROM item_def WHERE id = $1', [piece.item_def_id]);
          if (checkResult.rows.length === 0) {
            console.log(`套装件物品不存在，跳过: ${piece.item_def_id}`);
            continue;
          }

          const pieceSql = `
            INSERT INTO item_set_piece (set_id, equip_slot, item_def_id, piece_key)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (set_id, equip_slot) DO UPDATE SET
              item_def_id = EXCLUDED.item_def_id,
              piece_key = EXCLUDED.piece_key
          `;
          await query(pieceSql, [set.id, piece.equip_slot, piece.item_def_id, piece.piece_key]);
        } catch (pieceError) {
          console.log(`插入套装件跳过 ${piece.item_def_id}: 物品定义不存在`);
        }
      }

      // 插入套装加成
      for (const bonus of set.bonuses) {
        const bonusSql = `
          INSERT INTO item_set_bonus (set_id, piece_count, effect_defs, priority)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (set_id, piece_count) DO UPDATE SET
            effect_defs = EXCLUDED.effect_defs,
            priority = EXCLUDED.priority
        `;
        await query(bonusSql, [
          set.id,
          bonus.piece_count,
          JSON.stringify(bonus.effect_defs),
          bonus.priority
        ]);
      }

      count++;
    } catch (error) {
      console.error(`插入套装定义失败 ${set.id}:`, error);
    }
  }
  return count;
};

// NPC定义接口
interface NpcDefSeed {
  id: string;
  code?: string;
  name: string;
  title?: string;
  gender?: string;
  realm?: string;
  avatar?: string;
  description?: string;
  npc_type: string;
  base_attrs?: Record<string, number>;
  technique_slots?: Record<string, string | null>;
  technique_layers?: Record<string, number>;
  skill_ids?: string[];
  talk_tree_id?: string;
  shop_id?: string;
  exchange_id?: string;
  quest_giver_id?: string;
  area?: string;
  position_x?: number;
  position_y?: number;
  drop_pool_id?: string;
  sort_weight?: number;
  enabled?: boolean;
}

// 加载NPC定义
export const loadNpcDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ npcs: NpcDefSeed[] }>('npc_def.json');
  if (!data?.npcs) return 0;

  let count = 0;
  for (const npc of data.npcs) {
    try {
      const sql = `
        INSERT INTO npc_def (
          id, code, name, title, gender, realm, avatar, description,
          npc_type, base_attrs, technique_slots, technique_layers, skill_ids,
          talk_tree_id, shop_id, exchange_id, quest_giver_id,
          area, position_x, position_y, drop_pool_id, sort_weight, enabled, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13,
          $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          title = EXCLUDED.title,
          gender = EXCLUDED.gender,
          realm = EXCLUDED.realm,
          avatar = EXCLUDED.avatar,
          description = EXCLUDED.description,
          npc_type = EXCLUDED.npc_type,
          base_attrs = EXCLUDED.base_attrs,
          talk_tree_id = EXCLUDED.talk_tree_id,
          shop_id = EXCLUDED.shop_id,
          quest_giver_id = EXCLUDED.quest_giver_id,
          area = EXCLUDED.area,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        npc.id, npc.code || null, npc.name, npc.title || null,
        npc.gender || null, npc.realm || null, npc.avatar || null, npc.description || null,
        npc.npc_type,
        npc.base_attrs ? JSON.stringify(npc.base_attrs) : null,
        npc.technique_slots ? JSON.stringify(npc.technique_slots) : null,
        npc.technique_layers ? JSON.stringify(npc.technique_layers) : null,
        npc.skill_ids ? JSON.stringify(npc.skill_ids) : null,
        npc.talk_tree_id || null, npc.shop_id || null, npc.exchange_id || null, npc.quest_giver_id || null,
        npc.area || null, npc.position_x || null, npc.position_y || null,
        npc.drop_pool_id || null, npc.sort_weight || 0, npc.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入NPC定义失败 ${npc.id}:`, error);
    }
  }
  return count;
};

interface TalkTreeSeed {
  id: string;
  name: string;
  greeting_lines?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
}

export const loadTalkTreeSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ talk_trees?: TalkTreeSeed[] }>('npc_def.json');
  const trees = Array.isArray(data?.talk_trees) ? data?.talk_trees : [];
  if (trees.length === 0) return 0;

  let count = 0;
  for (const tree of trees) {
    try {
      if (!tree?.id || !tree?.name) continue;
      const sql = `
        INSERT INTO talk_tree_def (id, name, greeting_lines, enabled, sort_weight, version, updated_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          greeting_lines = EXCLUDED.greeting_lines,
          enabled = EXCLUDED.enabled,
          sort_weight = EXCLUDED.sort_weight,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      await query(sql, [
        tree.id,
        tree.name,
        JSON.stringify(Array.isArray(tree.greeting_lines) ? tree.greeting_lines : []),
        tree.enabled !== false,
        Number.isFinite(Number(tree.sort_weight)) ? Number(tree.sort_weight) : 0,
        Number.isFinite(Number(tree.version)) ? Number(tree.version) : 1,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入对话树失败 ${tree?.id}:`, error);
    }
  }

  return count;
};

// 怪物定义接口
interface MonsterDefSeed {
  id: string;
  code?: string;
  name: string;
  title?: string;
  realm?: string;
  level: number;
  avatar?: string;
  kind: string;
  element?: string;
  base_attrs: Record<string, number>;
  attr_variance?: number;
  attr_multiplier_min?: number;
  attr_multiplier_max?: number;
  display_stats?: Array<{ label: string; value: number | string }>;
  ai_profile?: Record<string, unknown>;
  technique_slots?: Record<string, string | null>;
  technique_layers?: Record<string, number>;
  skill_ids?: string[];
  drop_pool_id?: string;
  exp_reward?: number;
  silver_reward_min?: number;
  silver_reward_max?: number;
  enabled?: boolean;
}

// 加载怪物定义
export const loadMonsterDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ monsters: MonsterDefSeed[] }>('monster_def.json');
  if (!data?.monsters) return 0;

  let count = 0;
  for (const monster of data.monsters) {
    try {
      const sql = `
        INSERT INTO monster_def (
          id, code, name, title, realm, level, avatar, kind, element,
          base_attrs, attr_variance, attr_multiplier_min, attr_multiplier_max, display_stats, ai_profile,
          technique_slots, technique_layers, skill_ids,
          drop_pool_id, exp_reward, silver_reward_min, silver_reward_max, enabled, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          title = EXCLUDED.title,
          realm = EXCLUDED.realm,
          level = EXCLUDED.level,
          avatar = EXCLUDED.avatar,
          kind = EXCLUDED.kind,
          element = EXCLUDED.element,
          base_attrs = EXCLUDED.base_attrs,
          attr_variance = EXCLUDED.attr_variance,
          attr_multiplier_min = EXCLUDED.attr_multiplier_min,
          attr_multiplier_max = EXCLUDED.attr_multiplier_max,
          display_stats = EXCLUDED.display_stats,
          ai_profile = EXCLUDED.ai_profile,
          drop_pool_id = EXCLUDED.drop_pool_id,
          exp_reward = EXCLUDED.exp_reward,
          silver_reward_min = EXCLUDED.silver_reward_min,
          silver_reward_max = EXCLUDED.silver_reward_max,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        monster.id, monster.code || null, monster.name, monster.title || null,
        monster.realm || null, monster.level, monster.avatar || null, monster.kind, monster.element || null,
        JSON.stringify(monster.base_attrs),
        monster.attr_variance ?? 0.05,
        monster.attr_multiplier_min ?? 0.9,
        monster.attr_multiplier_max ?? 1.1,
        monster.display_stats ? JSON.stringify(monster.display_stats) : null,
        monster.ai_profile ? JSON.stringify(monster.ai_profile) : null,
        monster.technique_slots ? JSON.stringify(monster.technique_slots) : null,
        monster.technique_layers ? JSON.stringify(monster.technique_layers) : null,
        monster.skill_ids ? JSON.stringify(monster.skill_ids) : null,
        monster.drop_pool_id || null, monster.exp_reward || 0,
        monster.silver_reward_min || 0, monster.silver_reward_max || 0, monster.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入怪物定义失败 ${monster.id}:`, error);
    }
  }
  return count;
};

// 掉落池接口
interface DropPoolSeed {
  id: string;
  name: string;
  mode: string;
  entries: Array<{
    item_def_id: string;
    chance?: number;
    weight?: number;
    qty_min: number;
    qty_max: number;
    quality_weights?: Record<string, number>;
    bind_type?: string;
    show_in_ui?: boolean;
    sort_order?: number;
  }>;
}

// 加载掉落池
export const loadDropPoolSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ pools: DropPoolSeed[] }>('drop_pool.json');
  if (!data?.pools) return 0;

  let count = 0;
  for (const pool of data.pools) {
    try {
      // 插入掉落池
      const poolSql = `
        INSERT INTO drop_pool (id, name, mode, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          mode = EXCLUDED.mode,
          updated_at = NOW()
      `;
      await query(poolSql, [pool.id, pool.name, pool.mode]);

      // 删除旧条目
      await query('DELETE FROM drop_pool_entry WHERE drop_pool_id = $1', [pool.id]);

      // 插入条目
      for (let i = 0; i < pool.entries.length; i++) {
        const entry = pool.entries[i];
        const entrySql = `
          INSERT INTO drop_pool_entry (
            drop_pool_id, item_def_id, chance, weight, qty_min, qty_max,
            quality_weights, bind_type, show_in_ui, sort_order
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        await query(entrySql, [
          pool.id, entry.item_def_id, entry.chance ?? 1.0, entry.weight ?? 100,
          entry.qty_min, entry.qty_max,
          entry.quality_weights ? JSON.stringify(entry.quality_weights) : null,
          entry.bind_type || 'none', entry.show_in_ui !== false, entry.sort_order ?? i
        ]);
      }
      count++;
    } catch (error) {
      console.error(`插入掉落池失败 ${pool.id}:`, error);
    }
  }
  return count;
};

// 刷新规则接口
interface SpawnRuleSeed {
  id: string;
  area: string;
  pool_type: string;
  pool_entries: Array<{ monster_def_id?: string; npc_def_id?: string; weight: number }>;
  max_alive: number;
  respawn_sec: number;
  elite_chance?: number;
  boss_window?: Record<string, unknown>;
  req_realm_min?: string;
  req_quest_id?: string;
  enabled?: boolean;
}

// 加载刷新规则
export const loadSpawnRuleSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ rules: SpawnRuleSeed[] }>('spawn_rule.json');
  if (!data?.rules) return 0;

  let count = 0;
  for (const rule of data.rules) {
    try {
      const sql = `
        INSERT INTO spawn_rule (
          id, area, pool_type, pool_entries, max_alive, respawn_sec,
          elite_chance, boss_window, req_realm_min, req_quest_id, enabled, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (id) DO UPDATE SET
          area = EXCLUDED.area,
          pool_type = EXCLUDED.pool_type,
          pool_entries = EXCLUDED.pool_entries,
          max_alive = EXCLUDED.max_alive,
          respawn_sec = EXCLUDED.respawn_sec,
          elite_chance = EXCLUDED.elite_chance,
          boss_window = EXCLUDED.boss_window,
          req_realm_min = EXCLUDED.req_realm_min,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        rule.id, rule.area, rule.pool_type, JSON.stringify(rule.pool_entries),
        rule.max_alive, rule.respawn_sec, rule.elite_chance || 0,
        rule.boss_window ? JSON.stringify(rule.boss_window) : null,
        rule.req_realm_min || null, rule.req_quest_id || null, rule.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入刷新规则失败 ${rule.id}:`, error);
    }
  }
  return count;
};

// 地图定义接口
interface MapDefSeed {
  id: string;
  code?: string;
  name: string;
  description?: string;
  background_image?: string;
  map_type: string;
  parent_map_id?: string;
  world_position?: { x: number; y: number };
  region?: string;
  req_realm_min?: string;
  req_level_min?: number;
  req_quest_id?: string;
  req_item_id?: string;
  safe_zone?: boolean;
  pk_mode?: string;
  revive_map_id?: string;
  revive_room_id?: string;
  rooms: unknown[];
  sort_weight?: number;
  enabled?: boolean;
}

// 加载地图定义
export const loadMapDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ maps: MapDefSeed[] }>('map_def.json');
  if (!data?.maps) return 0;

  let count = 0;
  for (const map of data.maps) {
    try {
      const sql = `
        INSERT INTO map_def (
          id, code, name, description, background_image, map_type, parent_map_id,
          world_position, region, req_realm_min, req_level_min, req_quest_id, req_item_id,
          safe_zone, pk_mode, revive_map_id, revive_room_id, rooms, sort_weight, enabled, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          background_image = EXCLUDED.background_image,
          map_type = EXCLUDED.map_type,
          parent_map_id = EXCLUDED.parent_map_id,
          world_position = EXCLUDED.world_position,
          region = EXCLUDED.region,
          req_realm_min = EXCLUDED.req_realm_min,
          req_level_min = EXCLUDED.req_level_min,
          req_quest_id = EXCLUDED.req_quest_id,
          req_item_id = EXCLUDED.req_item_id,
          safe_zone = EXCLUDED.safe_zone,
          pk_mode = EXCLUDED.pk_mode,
          revive_map_id = EXCLUDED.revive_map_id,
          revive_room_id = EXCLUDED.revive_room_id,
          rooms = EXCLUDED.rooms,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        map.id, map.code || null, map.name, map.description || null,
        map.background_image || null, map.map_type, map.parent_map_id || null,
        map.world_position ? JSON.stringify(map.world_position) : null,
        map.region || null, map.req_realm_min || null, map.req_level_min || 0,
        map.req_quest_id || null, map.req_item_id || null,
        map.safe_zone || false, map.pk_mode || 'normal',
        map.revive_map_id || null, map.revive_room_id || null,
        JSON.stringify(map.rooms), map.sort_weight || 0, map.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入地图定义失败 ${map.id}:`, error);
    }
  }
  return count;
};

interface DungeonDefSeed {
  id: string;
  name: string;
  type: string;
  category?: string | null;
  description?: string | null;
  icon?: string | null;
  background?: string | null;
  min_players?: number;
  max_players?: number;
  min_realm?: string | null;
  recommended_realm?: string | null;
  unlock_condition?: unknown;
  daily_limit?: number;
  weekly_limit?: number;
  stamina_cost?: number;
  time_limit_sec?: number;
  revive_limit?: number;
  tags?: unknown;
  sort_weight?: number;
  enabled?: boolean;
  version?: number;
}

interface DungeonWaveSeed {
  wave_index: number;
  spawn_delay_sec?: number;
  monsters?: unknown;
  wave_rewards?: unknown;
}

interface DungeonStageSeed {
  id: string;
  difficulty_id: string;
  stage_index: number;
  name?: string | null;
  type: string;
  description?: string | null;
  time_limit_sec?: number;
  clear_condition?: unknown;
  fail_condition?: unknown;
  stage_rewards?: unknown;
  events?: unknown;
  waves?: DungeonWaveSeed[];
}

interface DungeonDifficultySeed {
  id: string;
  dungeon_id: string;
  name: string;
  difficulty_rank: number;
  monster_level_add?: number;
  monster_attr_mult?: number;
  reward_mult?: number;
  min_realm?: string | null;
  unlock_prev_difficulty?: boolean;
  first_clear_rewards?: unknown;
  drop_pool_id?: string | null;
  enabled?: boolean;
  stages?: DungeonStageSeed[];
}

interface DungeonSeedFile {
  version?: number;
  description?: string;
  dungeons?: Array<{
    def: DungeonDefSeed;
    difficulties?: DungeonDifficultySeed[];
  }>;
}

export const loadDungeonSeeds = async (): Promise<number> => {
  if (!fs.existsSync(SEEDS_DIR)) return 0;
  const files = fs
    .readdirSync(SEEDS_DIR)
    .filter((f) => /^dungeon_.*\.json$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  let inserted = 0;

  for (const filename of files) {
    const data = readJsonFile<DungeonSeedFile>(filename);
    if (!data?.dungeons?.length) continue;

    for (const d of data.dungeons) {
      const def = d.def;
      if (!def?.id) continue;

      try {
        await query(
          `
            INSERT INTO dungeon_def (
              id, name, type, category, description, icon, background,
              min_players, max_players, min_realm, recommended_realm, unlock_condition,
              daily_limit, weekly_limit, stamina_cost, time_limit_sec, revive_limit,
              tags, sort_weight, enabled, version
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7,
              $8, $9, $10, $11, $12,
              $13, $14, $15, $16, $17,
              $18, $19, $20, $21
            )
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              type = EXCLUDED.type,
              category = EXCLUDED.category,
              description = EXCLUDED.description,
              icon = EXCLUDED.icon,
              background = EXCLUDED.background,
              min_players = EXCLUDED.min_players,
              max_players = EXCLUDED.max_players,
              min_realm = EXCLUDED.min_realm,
              recommended_realm = EXCLUDED.recommended_realm,
              unlock_condition = EXCLUDED.unlock_condition,
              daily_limit = EXCLUDED.daily_limit,
              weekly_limit = EXCLUDED.weekly_limit,
              stamina_cost = EXCLUDED.stamina_cost,
              time_limit_sec = EXCLUDED.time_limit_sec,
              revive_limit = EXCLUDED.revive_limit,
              tags = EXCLUDED.tags,
              sort_weight = EXCLUDED.sort_weight,
              enabled = EXCLUDED.enabled,
              version = EXCLUDED.version
          `,
          [
            def.id,
            def.name,
            def.type,
            def.category ?? null,
            def.description ?? null,
            def.icon ?? null,
            def.background ?? null,
            def.min_players ?? 1,
            def.max_players ?? 4,
            def.min_realm ?? null,
            def.recommended_realm ?? null,
            JSON.stringify(def.unlock_condition ?? {}),
            def.daily_limit ?? 0,
            def.weekly_limit ?? 0,
            def.stamina_cost ?? 0,
            def.time_limit_sec ?? 0,
            def.revive_limit ?? 3,
            JSON.stringify(def.tags ?? []),
            def.sort_weight ?? 0,
            def.enabled !== false,
            def.version ?? 1,
          ]
        );

        const difficultyIds = (d.difficulties ?? [])
          .map((x) => x?.id)
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
        if (difficultyIds.length > 0) {
          await query(
            `
              DELETE FROM dungeon_difficulty dd
              WHERE
                dd.dungeon_id = $1
                AND dd.id <> ALL($2::text[])
                AND NOT EXISTS (SELECT 1 FROM dungeon_instance di WHERE di.difficulty_id = dd.id)
                AND NOT EXISTS (SELECT 1 FROM dungeon_record dr WHERE dr.difficulty_id = dd.id)
            `,
            [def.id, difficultyIds]
          );
        }

        const difficulties = d.difficulties ?? [];
        for (const diff of difficulties) {
          await query(
            `
              INSERT INTO dungeon_difficulty (
                id, dungeon_id, name, difficulty_rank, monster_level_add, monster_attr_mult, reward_mult,
                min_realm, unlock_prev_difficulty, first_clear_rewards, drop_pool_id, enabled
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12
              )
              ON CONFLICT (id) DO UPDATE SET
                dungeon_id = EXCLUDED.dungeon_id,
                name = EXCLUDED.name,
                difficulty_rank = EXCLUDED.difficulty_rank,
                monster_level_add = EXCLUDED.monster_level_add,
                monster_attr_mult = EXCLUDED.monster_attr_mult,
                reward_mult = EXCLUDED.reward_mult,
                min_realm = EXCLUDED.min_realm,
                unlock_prev_difficulty = EXCLUDED.unlock_prev_difficulty,
                first_clear_rewards = EXCLUDED.first_clear_rewards,
                drop_pool_id = EXCLUDED.drop_pool_id,
                enabled = EXCLUDED.enabled
            `,
            [
              diff.id,
              diff.dungeon_id,
              diff.name,
              diff.difficulty_rank,
              diff.monster_level_add ?? 0,
              diff.monster_attr_mult ?? 1.0,
              diff.reward_mult ?? 1.0,
              diff.min_realm ?? null,
              diff.unlock_prev_difficulty ?? false,
              JSON.stringify(diff.first_clear_rewards ?? {}),
              diff.drop_pool_id ?? null,
              diff.enabled !== false,
            ]
          );

          const stages = diff.stages ?? [];
          for (const stage of stages) {
            await query(
              `
                INSERT INTO dungeon_stage (
                  id, difficulty_id, stage_index, name, type, description, time_limit_sec,
                  clear_condition, fail_condition, stage_rewards, events
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7,
                  $8, $9, $10, $11
                )
                ON CONFLICT (id) DO UPDATE SET
                  difficulty_id = EXCLUDED.difficulty_id,
                  stage_index = EXCLUDED.stage_index,
                  name = EXCLUDED.name,
                  type = EXCLUDED.type,
                  description = EXCLUDED.description,
                  time_limit_sec = EXCLUDED.time_limit_sec,
                  clear_condition = EXCLUDED.clear_condition,
                  fail_condition = EXCLUDED.fail_condition,
                  stage_rewards = EXCLUDED.stage_rewards,
                  events = EXCLUDED.events
              `,
              [
                stage.id,
                stage.difficulty_id,
                stage.stage_index,
                stage.name ?? null,
                stage.type,
                stage.description ?? null,
                stage.time_limit_sec ?? 0,
                JSON.stringify(stage.clear_condition ?? {}),
                JSON.stringify(stage.fail_condition ?? {}),
                JSON.stringify(stage.stage_rewards ?? {}),
                JSON.stringify(stage.events ?? []),
              ]
            );

            const waves = stage.waves ?? [];
            for (const wave of waves) {
              await query(
                `
                  INSERT INTO dungeon_wave (
                    stage_id, wave_index, spawn_delay_sec, monsters, wave_rewards
                  ) VALUES (
                    $1, $2, $3, $4, $5
                  )
                  ON CONFLICT (stage_id, wave_index) DO UPDATE SET
                    spawn_delay_sec = EXCLUDED.spawn_delay_sec,
                    monsters = EXCLUDED.monsters,
                    wave_rewards = EXCLUDED.wave_rewards
                `,
                [
                  stage.id,
                  wave.wave_index,
                  wave.spawn_delay_sec ?? 0,
                  JSON.stringify(wave.monsters ?? []),
                  JSON.stringify(wave.wave_rewards ?? {}),
                ]
              );
            }
          }
        }

        inserted += 1;
      } catch (error) {
        console.error(`插入秘境种子失败 ${def.id} (${filename}):`, error);
      }
    }
  }

  return inserted;
};

type MonthCardDefSeed = {
  id: string;
  code?: string;
  name: string;
  description?: string;
  duration_days?: number;
  daily_spirit_stones?: number;
  price_spirit_stones?: number | string;
  enabled?: boolean;
  sort_weight?: number;
};

export const loadMonthCardSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ month_cards: MonthCardDefSeed[] }>('month_card.json');
  if (!data?.month_cards) return 0;

  let count = 0;
  for (const card of data.month_cards) {
    try {
      const sql = `
        INSERT INTO month_card_def (
          id, code, name, description, duration_days, daily_spirit_stones, price_spirit_stones,
          enabled, sort_weight, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          duration_days = EXCLUDED.duration_days,
          daily_spirit_stones = EXCLUDED.daily_spirit_stones,
          price_spirit_stones = EXCLUDED.price_spirit_stones,
          enabled = EXCLUDED.enabled,
          sort_weight = EXCLUDED.sort_weight,
          updated_at = NOW()
      `;

      const price =
        typeof card.price_spirit_stones === 'string'
          ? card.price_spirit_stones
          : Number.isFinite(Number(card.price_spirit_stones))
            ? Number(card.price_spirit_stones)
            : 0;

      await query(sql, [
        card.id,
        card.code || null,
        card.name,
        card.description || null,
        card.duration_days ?? 30,
        card.daily_spirit_stones ?? 100,
        price,
        card.enabled !== false,
        card.sort_weight ?? 0,
      ]);

      count += 1;
    } catch (error) {
      console.error(`插入月卡定义失败 ${card.id}:`, error);
    }
  }

  return count;
};

type BattlePassRewardSeedEntry =
  | { type: 'item'; item_def_id: string; qty: number }
  | { type: 'currency'; currency: 'spirit_stones' | 'silver'; amount: number };

type BattlePassRewardSeedFile = {
  season: {
    id: string;
    name: string;
    start_at: string;
    end_at: string;
    max_level?: number;
    exp_per_level?: number;
    enabled?: boolean;
    sort_weight?: number;
  };
  rewards: Array<{
    level: number;
    free?: BattlePassRewardSeedEntry[];
    premium?: BattlePassRewardSeedEntry[];
  }>;
};

export const loadBattlePassRewardSeeds = async (): Promise<number> => {
  const data = readJsonFile<BattlePassRewardSeedFile>('battle_pass_rewards.json');
  if (!data?.season?.id || !data?.rewards) return 0;

  const season = data.season;
  const maxLevel = Number.isFinite(Number(season.max_level)) ? Number(season.max_level) : 30;
  const expPerLevel = Number.isFinite(Number(season.exp_per_level)) ? Number(season.exp_per_level) : 1000;
  const enabled = season.enabled !== false;
  const sortWeight = Number.isFinite(Number(season.sort_weight)) ? Number(season.sort_weight) : 0;

  try {
    await query(
      `
        INSERT INTO battle_pass_season_def (
          id, name, start_at, end_at, max_level, exp_per_level, enabled, sort_weight, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          start_at = EXCLUDED.start_at,
          end_at = EXCLUDED.end_at,
          max_level = EXCLUDED.max_level,
          exp_per_level = EXCLUDED.exp_per_level,
          enabled = EXCLUDED.enabled,
          sort_weight = EXCLUDED.sort_weight,
          updated_at = NOW()
      `,
      [season.id, season.name, season.start_at, season.end_at, maxLevel, expPerLevel, enabled, sortWeight],
    );
  } catch (error) {
    console.error(`插入战令赛季定义失败 ${season.id}:`, error);
    return 0;
  }

  let count = 0;
  for (const row of data.rewards) {
    const level = Number.isFinite(Number(row.level)) ? Math.floor(Number(row.level)) : 0;
    if (level <= 0) continue;
    const freeRewards = Array.isArray(row.free) ? row.free : [];
    const premiumRewards = Array.isArray(row.premium) ? row.premium : [];
    try {
      await query(
        `
          INSERT INTO battle_pass_reward_def (season_id, level, free_rewards, premium_rewards, updated_at)
          VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
          ON CONFLICT (season_id, level) DO UPDATE SET
            free_rewards = EXCLUDED.free_rewards,
            premium_rewards = EXCLUDED.premium_rewards,
            updated_at = NOW()
        `,
        [season.id, level, JSON.stringify(freeRewards), JSON.stringify(premiumRewards)],
      );
      count += 1;
    } catch (error) {
      console.error(`插入战令奖励失败 ${season.id} Lv.${level}:`, error);
    }
  }

  return count;
};

type BattlePassTaskSeedCondition = {
  event: string;
  params?: Record<string, unknown>;
};

type BattlePassTaskSeedRewardExtra =
  | { type: 'item'; item_def_id: string; qty: number }
  | { type: 'currency'; currency: 'spirit_stones' | 'silver'; amount: number };

type BattlePassTaskSeedFile = {
  season_id: string;
  tasks: Array<{
    id: string;
    code: string;
    name: string;
    description?: string;
    task_type: 'daily' | 'weekly' | 'season';
    condition: BattlePassTaskSeedCondition;
    target_value: number;
    reward_exp: number;
    reward_extra?: BattlePassTaskSeedRewardExtra[];
    enabled?: boolean;
    sort_weight?: number;
  }>;
};

export const loadBattlePassTaskSeeds = async (): Promise<number> => {
  const data = readJsonFile<BattlePassTaskSeedFile>('battle_pass_tasks.json');
  if (!data?.season_id || !Array.isArray(data.tasks)) return 0;

  let count = 0;
  for (const task of data.tasks) {
    if (!task?.id || !task?.code || !task?.name || !task?.task_type) continue;
    try {
      await query(
        `
          INSERT INTO battle_pass_task_def (
            id, season_id, code, name, description, task_type, condition, target_value,
            reward_exp, reward_extra, enabled, sort_weight, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
            $9, $10::jsonb, $11, $12, NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            season_id = EXCLUDED.season_id,
            code = EXCLUDED.code,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            task_type = EXCLUDED.task_type,
            condition = EXCLUDED.condition,
            target_value = EXCLUDED.target_value,
            reward_exp = EXCLUDED.reward_exp,
            reward_extra = EXCLUDED.reward_extra,
            enabled = EXCLUDED.enabled,
            sort_weight = EXCLUDED.sort_weight,
            updated_at = NOW()
        `,
        [
          task.id,
          data.season_id,
          task.code,
          task.name,
          task.description || null,
          task.task_type,
          JSON.stringify(task.condition ?? {}),
          Number.isFinite(Number(task.target_value)) ? Math.floor(Number(task.target_value)) : 1,
          Number.isFinite(Number(task.reward_exp)) ? Number(task.reward_exp) : 0,
          JSON.stringify(Array.isArray(task.reward_extra) ? task.reward_extra : []),
          task.enabled !== false,
          Number.isFinite(Number(task.sort_weight)) ? Number(task.sort_weight) : 0,
        ],
      );
      count += 1;
    } catch (error) {
      console.error(`插入战令任务失败 ${task.id}:`, error);
    }
  }

  return count;
};

export const loadTaskDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ tasks: TaskDefSeed[] }>('task_def.json');
  if (!data?.tasks) return 0;

  let count = 0;
  for (const task of data.tasks) {
    if (!task?.id) continue;

    try {
      const sql = `
        INSERT INTO task_def (
          id, category, title, realm, description,
          giver_npc_id, map_id, room_id,
          objectives, rewards, prereq_task_ids,
          enabled, sort_weight, version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          category = EXCLUDED.category,
          title = EXCLUDED.title,
          realm = EXCLUDED.realm,
          description = EXCLUDED.description,
          giver_npc_id = EXCLUDED.giver_npc_id,
          map_id = EXCLUDED.map_id,
          room_id = EXCLUDED.room_id,
          objectives = EXCLUDED.objectives,
          rewards = EXCLUDED.rewards,
          prereq_task_ids = EXCLUDED.prereq_task_ids,
          enabled = EXCLUDED.enabled,
          sort_weight = EXCLUDED.sort_weight,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      const category = typeof task.category === 'string' && task.category ? task.category : 'main';
      const title = typeof task.title === 'string' && task.title ? task.title : task.id;
      const realm = typeof task.realm === 'string' && task.realm.trim() ? task.realm.trim() : '凡人';

      await query(sql, [
        task.id,
        category,
        title,
        realm,
        task.description || null,
        task.giver_npc_id || null,
        task.map_id || null,
        task.room_id || null,
        JSON.stringify(Array.isArray(task.objectives) ? task.objectives : []),
        JSON.stringify(Array.isArray(task.rewards) ? task.rewards : []),
        JSON.stringify(Array.isArray(task.prereq_task_ids) ? task.prereq_task_ids : []),
        task.enabled !== false,
        Number.isFinite(Number(task.sort_weight)) ? Number(task.sort_weight) : 0,
        Number.isFinite(Number(task.version)) ? Number(task.version) : 1,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入任务定义失败 ${task.id}:`, error);
    }
  }

  return count;
};

export const loadBountyDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ bounties: BountyDefSeed[] }>('bounty_def.json');
  if (!data?.bounties) return 0;

  let count = 0;
  for (const b of data.bounties) {
    try {
      if (!b?.id || !b?.task_id || !b?.title) continue;

      const sql = `
        INSERT INTO bounty_def (
          id, pool, task_id, title, description,
          claim_policy, max_claims, weight, enabled, version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          pool = EXCLUDED.pool,
          task_id = EXCLUDED.task_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          claim_policy = EXCLUDED.claim_policy,
          max_claims = EXCLUDED.max_claims,
          weight = EXCLUDED.weight,
          enabled = EXCLUDED.enabled,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      const pool = typeof b.pool === 'string' && b.pool.trim() ? b.pool.trim() : 'daily';
      const claimPolicy = typeof b.claim_policy === 'string' && b.claim_policy.trim() ? b.claim_policy.trim() : 'limited';
      const maxClaims = Number.isFinite(Number(b.max_claims)) ? Number(b.max_claims) : 0;
      const weight = Number.isFinite(Number(b.weight)) ? Number(b.weight) : 1;
      const version = Number.isFinite(Number(b.version)) ? Number(b.version) : 1;

      await query(sql, [
        b.id,
        pool,
        b.task_id,
        b.title,
        b.description || null,
        claimPolicy,
        maxClaims,
        weight,
        b.enabled !== false,
        version,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入悬赏定义失败 ${String(b?.id ?? '')}:`, error);
    }
  }

  return count;
};

export const loadAchievementDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ achievements: AchievementDefSeed[] }>('achievement_def.json');
  if (!data?.achievements) return 0;

  let count = 0;
  for (const ach of data.achievements) {
    if (!ach?.id || !ach?.track_key || !ach?.name) continue;

    try {
      const sql = `
        INSERT INTO achievement_def (
          id, name, description, category, rarity, points, icon, hidden,
          prerequisite_id, track_type, track_key, target_value, target_list, rewards,
          title_id, sort_weight, enabled, version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          rarity = EXCLUDED.rarity,
          points = EXCLUDED.points,
          icon = EXCLUDED.icon,
          hidden = EXCLUDED.hidden,
          prerequisite_id = EXCLUDED.prerequisite_id,
          track_type = EXCLUDED.track_type,
          track_key = EXCLUDED.track_key,
          target_value = EXCLUDED.target_value,
          target_list = EXCLUDED.target_list,
          rewards = EXCLUDED.rewards,
          title_id = EXCLUDED.title_id,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      await query(sql, [
        ach.id,
        ach.name,
        ach.description || '',
        ach.category || 'combat',
        ach.rarity || 'common',
        Number.isFinite(Number(ach.points)) ? Math.max(0, Math.floor(Number(ach.points))) : 0,
        ach.icon || null,
        ach.hidden === true,
        ach.prerequisite_id || null,
        ach.track_type || 'counter',
        ach.track_key,
        Number.isFinite(Number(ach.target_value)) ? Math.max(1, Math.floor(Number(ach.target_value))) : 1,
        JSON.stringify(Array.isArray(ach.target_list) ? ach.target_list : []),
        JSON.stringify(Array.isArray(ach.rewards) ? ach.rewards : []),
        ach.title_id || null,
        Number.isFinite(Number(ach.sort_weight)) ? Number(ach.sort_weight) : 0,
        ach.enabled !== false,
        Number.isFinite(Number(ach.version)) ? Number(ach.version) : 1,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入成就定义失败 ${ach.id}:`, error);
    }
  }

  return count;
};

export const loadTitleDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ titles: TitleDefSeed[] }>('title_def.json');
  if (!data?.titles) return 0;

  let count = 0;
  for (const title of data.titles) {
    if (!title?.id || !title?.name) continue;

    try {
      const sql = `
        INSERT INTO title_def (
          id, name, description, rarity, color, icon, effects,
          source_type, source_id, enabled, sort_weight, version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          rarity = EXCLUDED.rarity,
          color = EXCLUDED.color,
          icon = EXCLUDED.icon,
          effects = EXCLUDED.effects,
          source_type = EXCLUDED.source_type,
          source_id = EXCLUDED.source_id,
          enabled = EXCLUDED.enabled,
          sort_weight = EXCLUDED.sort_weight,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      await query(sql, [
        title.id,
        title.name,
        title.description || '',
        title.rarity || 'common',
        title.color || null,
        title.icon || null,
        JSON.stringify(title.effects ?? {}),
        title.source_type || null,
        title.source_id || null,
        title.enabled !== false,
        Number.isFinite(Number(title.sort_weight)) ? Number(title.sort_weight) : 0,
        Number.isFinite(Number(title.version)) ? Number(title.version) : 1,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入称号定义失败 ${title.id}:`, error);
    }
  }

  return count;
};

export const loadAchievementPointsRewardSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ rewards: AchievementPointsRewardSeed[] }>('achievement_points_rewards.json');
  if (!data?.rewards) return 0;

  let count = 0;
  for (const reward of data.rewards) {
    if (!reward?.id || !reward?.name) continue;

    try {
      const threshold = Number.isFinite(Number(reward.points_threshold))
        ? Math.max(0, Math.floor(Number(reward.points_threshold)))
        : -1;
      if (threshold < 0) continue;

      const sql = `
        INSERT INTO achievement_points_reward_def (
          id, points_threshold, name, description, rewards, title_id,
          sort_weight, enabled, version, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          points_threshold = EXCLUDED.points_threshold,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          rewards = EXCLUDED.rewards,
          title_id = EXCLUDED.title_id,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          version = EXCLUDED.version,
          updated_at = NOW()
      `;

      await query(sql, [
        reward.id,
        threshold,
        reward.name,
        reward.description || '',
        JSON.stringify(Array.isArray(reward.rewards) ? reward.rewards : []),
        reward.title_id || null,
        Number.isFinite(Number(reward.sort_weight)) ? Number(reward.sort_weight) : threshold,
        reward.enabled !== false,
        Number.isFinite(Number(reward.version)) ? Number(reward.version) : 1,
      ]);
      count += 1;
    } catch (error) {
      console.error(`插入成就点数奖励失败 ${reward.id}:`, error);
    }
  }

  return count;
};

// 主线任务章节接口
interface MainQuestChapterSeed {
  id: string;
  chapter_num: number;
  name: string;
  description?: string;
  background?: string;
  min_realm?: string;
  chapter_rewards?: Record<string, unknown>;
  unlock_features?: string[];
  sort_weight?: number;
  enabled?: boolean;
}

// 主线任务节接口
interface MainQuestSectionSeed {
  id: string;
  chapter_id: string;
  section_num: number;
  name: string;
  description?: string;
  brief?: string;
  npc_id?: string;
  map_id?: string;
  room_id?: string;
  min_realm?: string;
  dialogue_id?: string;
  dialogue_complete_id?: string;
  objectives?: Array<{
    id: string;
    type: string;
    text: string;
    target: number;
    params?: Record<string, unknown>;
  }>;
  rewards?: Record<string, unknown>;
  auto_accept?: boolean;
  auto_complete?: boolean;
  is_chapter_final?: boolean;
  sort_weight?: number;
  enabled?: boolean;
}

// 对话定义接口
interface DialogueDefSeed {
  id: string;
  name: string;
  nodes: Array<{
    id: string;
    type: string;
    speaker?: string;
    text?: string;
    emotion?: string;
    choices?: Array<{
      id: string;
      text: string;
      next: string;
      condition?: Record<string, unknown>;
      effects?: Array<Record<string, unknown>>;
    }>;
    next?: string;
    effects?: Array<Record<string, unknown>>;
  }>;
  enabled?: boolean;
}

// 加载主线任务种子数据
export const loadMainQuestSeeds = async (): Promise<{ chapters: number; sections: number; dialogues: number }> => {
  let chaptersCount = 0;
  let sectionsCount = 0;
  let dialoguesCount = 0;

  // 加载章节和任务节
  const chapterData = readJsonFile<{ chapters: MainQuestChapterSeed[]; sections: MainQuestSectionSeed[] }>('main_quest_chapter1.json');
  
  if (chapterData?.chapters) {
    for (const chapter of chapterData.chapters) {
      try {
        const sql = `
          INSERT INTO main_quest_chapter (
            id, chapter_num, name, description, background, min_realm,
            chapter_rewards, unlock_features, sort_weight, enabled
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (id) DO UPDATE SET
            chapter_num = EXCLUDED.chapter_num,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            background = EXCLUDED.background,
            min_realm = EXCLUDED.min_realm,
            chapter_rewards = EXCLUDED.chapter_rewards,
            unlock_features = EXCLUDED.unlock_features,
            sort_weight = EXCLUDED.sort_weight,
            enabled = EXCLUDED.enabled
        `;
        await query(sql, [
          chapter.id,
          chapter.chapter_num,
          chapter.name,
          chapter.description || null,
          chapter.background || null,
          chapter.min_realm || '凡人',
          chapter.chapter_rewards ? JSON.stringify(chapter.chapter_rewards) : '{}',
          chapter.unlock_features ? JSON.stringify(chapter.unlock_features) : '[]',
          chapter.sort_weight || 0,
          chapter.enabled !== false
        ]);
        chaptersCount++;
      } catch (error) {
        console.error(`插入主线章节失败 ${chapter.id}:`, error);
      }
    }
  }

  if (chapterData?.sections) {
    for (const section of chapterData.sections) {
      try {
        const sql = `
          INSERT INTO main_quest_section (
            id, chapter_id, section_num, name, description, brief,
            npc_id, map_id, room_id, min_realm,
            dialogue_id, dialogue_complete_id, objectives, rewards,
            auto_accept, auto_complete, is_chapter_final, sort_weight, enabled
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          ON CONFLICT (id) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id,
            section_num = EXCLUDED.section_num,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            brief = EXCLUDED.brief,
            npc_id = EXCLUDED.npc_id,
            map_id = EXCLUDED.map_id,
            room_id = EXCLUDED.room_id,
            min_realm = EXCLUDED.min_realm,
            dialogue_id = EXCLUDED.dialogue_id,
            dialogue_complete_id = EXCLUDED.dialogue_complete_id,
            objectives = EXCLUDED.objectives,
            rewards = EXCLUDED.rewards,
            auto_accept = EXCLUDED.auto_accept,
            auto_complete = EXCLUDED.auto_complete,
            is_chapter_final = EXCLUDED.is_chapter_final,
            sort_weight = EXCLUDED.sort_weight,
            enabled = EXCLUDED.enabled
        `;
        await query(sql, [
          section.id,
          section.chapter_id,
          section.section_num,
          section.name,
          section.description || null,
          section.brief || null,
          section.npc_id || null,
          section.map_id || null,
          section.room_id || null,
          section.min_realm || null,
          section.dialogue_id || null,
          section.dialogue_complete_id || null,
          section.objectives ? JSON.stringify(section.objectives) : '[]',
          section.rewards ? JSON.stringify(section.rewards) : '{}',
          section.auto_accept !== false,
          section.auto_complete || false,
          section.is_chapter_final || false,
          section.sort_weight || 0,
          section.enabled !== false
        ]);
        sectionsCount++;
      } catch (error) {
        console.error(`插入主线任务节失败 ${section.id}:`, error);
      }
    }
  }

  await query(`
    WITH chapter_section_counts AS (
      SELECT
        c.id,
        c.chapter_num,
        COUNT(s.id) FILTER (WHERE s.enabled = true)::int AS enabled_sections
      FROM main_quest_chapter c
      LEFT JOIN main_quest_section s ON s.chapter_id = c.id
      WHERE c.enabled = true
      GROUP BY c.id, c.chapter_num
    ),
    best AS (
      SELECT chapter_num, MAX(enabled_sections)::int AS max_sections
      FROM chapter_section_counts
      GROUP BY chapter_num
    )
    UPDATE main_quest_chapter c
    SET enabled = false
    FROM chapter_section_counts cs
    JOIN best b ON b.chapter_num = cs.chapter_num
    WHERE c.id = cs.id
      AND b.max_sections > 0
      AND cs.enabled_sections < b.max_sections
  `);

  // 加载对话定义
  const dialogueData = readJsonFile<{ dialogues: DialogueDefSeed[] }>('dialogue_main_chapter1.json');
  
  if (dialogueData?.dialogues) {
    for (const dialogue of dialogueData.dialogues) {
      try {
        const sql = `
          INSERT INTO dialogue_def (id, name, nodes, enabled)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            nodes = EXCLUDED.nodes,
            enabled = EXCLUDED.enabled
        `;
        await query(sql, [
          dialogue.id,
          dialogue.name,
          JSON.stringify(dialogue.nodes),
          dialogue.enabled !== false
        ]);
        dialoguesCount++;
      } catch (error) {
        console.error(`插入对话定义失败 ${dialogue.id}:`, error);
      }
    }
  }

  return { chapters: chaptersCount, sections: sectionsCount, dialogues: dialoguesCount };
};

// 加载所有种子数据
export const loadAllSeeds = async (): Promise<void> => {
  console.log('--- 加载种子数据 ---');

  // 1. 加载物品定义
  const itemCount = await loadItemDefSeeds();
  console.log(`  物品定义: ${itemCount} 条`);

  // 2. 加载装备定义
  const equipCount = await loadEquipmentDefSeeds();
  console.log(`  装备定义: ${equipCount} 条`);

  // 3. 加载词条池
  const affixCount = await loadAffixPoolSeeds();
  console.log(`  词条池: ${affixCount} 条`);

  // 4. 加载套装定义
  const setCount = await loadItemSetSeeds();
  console.log(`  套装定义: ${setCount} 条`);

  // 5. 加载配方
  const recipeCount = await loadRecipeSeeds();
  console.log(`  配方: ${recipeCount} 条`);

  // 6. 加载NPC定义
  const npcCount = await loadNpcDefSeeds();
  console.log(`  NPC定义: ${npcCount} 条`);

  // 6.1 加载对话树定义
  const talkTreeCount = await loadTalkTreeSeeds();
  console.log(`  对话树定义: ${talkTreeCount} 条`);

  // 7. 加载怪物定义
  const monsterCount = await loadMonsterDefSeeds();
  console.log(`  怪物定义: ${monsterCount} 条`);

  // 8. 加载掉落池
  const dropPoolCount = await loadDropPoolSeeds();
  console.log(`  掉落池: ${dropPoolCount} 条`);

  // 9. 加载刷新规则
  const spawnRuleCount = await loadSpawnRuleSeeds();
  console.log(`  刷新规则: ${spawnRuleCount} 条`);

  // 10. 加载地图定义
  const mapCount = await loadMapDefSeeds();
  console.log(`  地图定义: ${mapCount} 条`);

  // 11. 加载任务定义
  const taskCount = await loadTaskDefSeeds();
  console.log(`  任务定义: ${taskCount} 条`);
  const bountyDefCount = await loadBountyDefSeeds();
  console.log(`  悬赏定义: ${bountyDefCount} 条`);

  // 11.1 加载成就系统定义
  const achievementDefCount = await loadAchievementDefSeeds();
  console.log(`  成就定义: ${achievementDefCount} 条`);
  const titleDefCount = await loadTitleDefSeeds();
  console.log(`  称号定义: ${titleDefCount} 条`);
  const achievementPointsRewardCount = await loadAchievementPointsRewardSeeds();
  console.log(`  成就点奖励: ${achievementPointsRewardCount} 条`);

  // 12. 加载月卡定义
  const monthCardCount = await loadMonthCardSeeds();
  console.log(`  月卡定义: ${monthCardCount} 条`);

  // 13. 加载战令奖励
  const battlePassRewardCount = await loadBattlePassRewardSeeds();
  console.log(`  战令奖励: ${battlePassRewardCount} 条`);

  // 14. 加载战令任务
  const battlePassTaskCount = await loadBattlePassTaskSeeds();
  console.log(`  战令任务: ${battlePassTaskCount} 条`);

  // 15. 加载秘境定义
  const dungeonCount = await loadDungeonSeeds();
  console.log(`  秘境定义: ${dungeonCount} 组`);

  // 16. 加载功法定义
  const techCount = await loadTechniqueDefSeeds();
  console.log(`  功法定义: ${techCount} 条`);

  // 17. 加载技能定义（需在功法之后，因为技能引用功法）
  const skillCount = await loadSkillDefSeeds();
  console.log(`  技能定义: ${skillCount} 条`);

  // 18. 加载功法层级（需在功法和技能之后）
  const layerCount = await loadTechniqueLayerSeeds();
  console.log(`  功法层级: ${layerCount} 条`);

  // 19. 加载主线任务章节和对话
  const mainQuestCount = await loadMainQuestSeeds();
  console.log(`  主线任务: ${mainQuestCount.chapters} 章, ${mainQuestCount.sections} 节, ${mainQuestCount.dialogues} 对话`);

  console.log('✓ 种子数据加载完成');
};

// 配方接口
interface RecipeSeed {
  id: string;
  name: string;
  recipe_type: string;
  product_item_def_id: string;
  product_qty: number;
  product_quality_min?: string;
  product_quality_max?: string;
  cost_silver: number;
  cost_spirit_stones: number;
  cost_exp?: number;
  cost_items?: Array<{ item_def_id: string; qty: number }>;
  req_realm?: string;
  req_level?: number;
  req_building?: string;
  success_rate: number;
  fail_return_rate?: number;
}

// 加载配方
export const loadRecipeSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ recipes: RecipeSeed[] }>('item_recipe.json');
  if (!data?.recipes) return 0;

  let count = 0;
  for (const recipe of data.recipes) {
    try {
      const sql = `
        INSERT INTO item_recipe (
          id, name, recipe_type, product_item_def_id, product_qty,
          product_quality_min, product_quality_max,
          cost_silver, cost_spirit_stones, cost_exp, cost_items,
          req_realm, req_level, req_building, success_rate, fail_return_rate,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          recipe_type = EXCLUDED.recipe_type,
          product_item_def_id = EXCLUDED.product_item_def_id,
          product_qty = EXCLUDED.product_qty,
          cost_silver = EXCLUDED.cost_silver,
          cost_spirit_stones = EXCLUDED.cost_spirit_stones,
          cost_items = EXCLUDED.cost_items,
          req_realm = EXCLUDED.req_realm,
          req_building = EXCLUDED.req_building,
          success_rate = EXCLUDED.success_rate,
          fail_return_rate = EXCLUDED.fail_return_rate,
          updated_at = NOW()
      `;

      await query(sql, [
        recipe.id,
        recipe.name,
        recipe.recipe_type,
        recipe.product_item_def_id,
        recipe.product_qty,
        recipe.product_quality_min || null,
        recipe.product_quality_max || null,
        recipe.cost_silver,
        recipe.cost_spirit_stones,
        recipe.cost_exp || 0,
        recipe.cost_items ? JSON.stringify(recipe.cost_items) : null,
        recipe.req_realm || null,
        recipe.req_level || 0,
        recipe.req_building || null,
        recipe.success_rate,
        recipe.fail_return_rate || 0
      ]);
      count++;
    } catch (error) {
      console.error(`插入配方失败 ${recipe.id}:`, error);
    }
  }
  return count;
};

// ============================================
// 功法系统种子数据
// ============================================

// 功法定义接口
interface TechniqueDefSeed {
  id: string;
  code?: string;
  name: string;
  type: string;
  quality: string;
  quality_rank: number;
  max_layer: number;
  required_realm: string;
  attribute_type?: string;
  attribute_element?: string;
  tags?: string[];
  description?: string;
  long_desc?: string;
  icon?: string;
  obtain_type?: string;
  obtain_hint?: string[];
  sort_weight?: number;
  enabled?: boolean;
}

// 加载功法定义
export const loadTechniqueDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ techniques: TechniqueDefSeed[] }>('technique_def.json');
  if (!data?.techniques) return 0;

  let count = 0;
  for (const tech of data.techniques) {
    try {
      const sql = `
        INSERT INTO technique_def (
          id, code, name, type, quality, quality_rank, max_layer, required_realm,
          attribute_type, attribute_element,
          tags, description, long_desc, icon, obtain_type, obtain_hint, sort_weight, enabled, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          quality = EXCLUDED.quality,
          quality_rank = EXCLUDED.quality_rank,
          max_layer = EXCLUDED.max_layer,
          required_realm = EXCLUDED.required_realm,
          attribute_type = EXCLUDED.attribute_type,
          attribute_element = EXCLUDED.attribute_element,
          tags = EXCLUDED.tags,
          description = EXCLUDED.description,
          long_desc = EXCLUDED.long_desc,
          icon = EXCLUDED.icon,
          obtain_type = EXCLUDED.obtain_type,
          obtain_hint = EXCLUDED.obtain_hint,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        tech.id, tech.code || null, tech.name, tech.type, tech.quality, tech.quality_rank,
        tech.max_layer, tech.required_realm,
        tech.attribute_type || 'physical', tech.attribute_element || 'none',
        tech.tags || [], tech.description || null, tech.long_desc || null, tech.icon || null,
        tech.obtain_type || 'drop', tech.obtain_hint || [],
        tech.sort_weight || 0, tech.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入功法定义失败 ${tech.id}:`, error);
    }
  }
  return count;
};

// 功法层级接口
interface TechniqueLayerSeed {
  technique_id: string;
  layer: number;
  cost_spirit_stones: number;
  cost_exp: number;
  cost_materials?: Array<{ itemId: string; qty: number }>;
  passives?: Array<{ key: string; value: number }>;
  unlock_skill_ids?: string[];
  upgrade_skill_ids?: string[];
  required_realm?: string;
  required_quest_id?: string;
  layer_desc?: string;
}

// 加载功法层级
export const loadTechniqueLayerSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ layers: TechniqueLayerSeed[] }>('technique_layer.json');
  if (!data?.layers) return 0;

  let count = 0;
  for (const layer of data.layers) {
    try {
      const sql = `
        INSERT INTO technique_layer (
          technique_id, layer, cost_spirit_stones, cost_exp, cost_materials,
          passives, unlock_skill_ids, upgrade_skill_ids, required_realm, required_quest_id, layer_desc
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        ON CONFLICT (technique_id, layer) DO UPDATE SET
          cost_spirit_stones = EXCLUDED.cost_spirit_stones,
          cost_exp = EXCLUDED.cost_exp,
          cost_materials = EXCLUDED.cost_materials,
          passives = EXCLUDED.passives,
          unlock_skill_ids = EXCLUDED.unlock_skill_ids,
          upgrade_skill_ids = EXCLUDED.upgrade_skill_ids,
          required_realm = EXCLUDED.required_realm,
          required_quest_id = EXCLUDED.required_quest_id,
          layer_desc = EXCLUDED.layer_desc
      `;

      await query(sql, [
        layer.technique_id, layer.layer, layer.cost_spirit_stones, layer.cost_exp,
        layer.cost_materials ? JSON.stringify(layer.cost_materials) : '[]',
        layer.passives ? JSON.stringify(layer.passives) : '[]',
        layer.unlock_skill_ids || [], layer.upgrade_skill_ids || [],
        layer.required_realm || null, layer.required_quest_id || null, layer.layer_desc || null
      ]);
      count++;
    } catch (error) {
      console.error(`插入功法层级失败 ${layer.technique_id}-${layer.layer}:`, error);
    }
  }
  return count;
};

// 技能定义接口
interface SkillDefSeed {
  id: string;
  code?: string;
  name: string;
  description?: string;
  icon?: string;
  source_type: string;
  source_id?: string;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type: string;
  target_count?: number;
  damage_type?: string;
  element?: string;
  effects?: unknown[];
  trigger_type?: string;
  conditions?: unknown;
  ai_priority?: number;
  ai_conditions?: unknown;
  upgrades?: unknown[];
  sort_weight?: number;
  enabled?: boolean;
}

// 加载技能定义
export const loadSkillDefSeeds = async (): Promise<number> => {
  const data = readJsonFile<{ skills: SkillDefSeed[] }>('skill_def.json');
  if (!data?.skills) return 0;

  let count = 0;
  for (const skill of data.skills) {
    try {
      const sql = `
        INSERT INTO skill_def (
          id, code, name, description, icon, source_type, source_id,
          cost_lingqi, cost_qixue, cooldown, target_type, target_count,
          damage_type, element,
          effects, trigger_type, conditions, ai_priority, ai_conditions, upgrades,
          sort_weight, enabled, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          code = EXCLUDED.code,
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          icon = EXCLUDED.icon,
          source_type = EXCLUDED.source_type,
          source_id = EXCLUDED.source_id,
          cost_lingqi = EXCLUDED.cost_lingqi,
          cost_qixue = EXCLUDED.cost_qixue,
          cooldown = EXCLUDED.cooldown,
          target_type = EXCLUDED.target_type,
          target_count = EXCLUDED.target_count,
          damage_type = EXCLUDED.damage_type,
          element = EXCLUDED.element,
          effects = EXCLUDED.effects,
          trigger_type = EXCLUDED.trigger_type,
          conditions = EXCLUDED.conditions,
          ai_priority = EXCLUDED.ai_priority,
          ai_conditions = EXCLUDED.ai_conditions,
          upgrades = EXCLUDED.upgrades,
          sort_weight = EXCLUDED.sort_weight,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `;

      await query(sql, [
        skill.id, skill.code || null, skill.name, skill.description || null, skill.icon || null,
        skill.source_type, skill.source_id || null,
        skill.cost_lingqi || 0, skill.cost_qixue || 0, skill.cooldown || 0,
        skill.target_type, skill.target_count || 1,
        skill.damage_type || null, skill.element || 'none',
        skill.effects ? JSON.stringify(skill.effects) : '[]',
        skill.trigger_type || 'active',
        skill.conditions ? JSON.stringify(skill.conditions) : null,
        skill.ai_priority || 50,
        skill.ai_conditions ? JSON.stringify(skill.ai_conditions) : null,
        skill.upgrades ? JSON.stringify(skill.upgrades) : '[]',
        skill.sort_weight || 0, skill.enabled !== false
      ]);
      count++;
    } catch (error) {
      console.error(`插入技能定义失败 ${skill.id}:`, error);
    }
  }
  return count;
};


const isDirectRun = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  return import.meta.url === pathToFileURL(arg).href;
})();

if (isDirectRun) {
  void (async () => {
    try {
      await loadAllSeeds();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
}
