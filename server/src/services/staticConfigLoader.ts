import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEDS_DIR = [
  path.join(process.cwd(), 'src', 'data', 'seeds'),
  path.join(process.cwd(), 'dist', 'data', 'seeds'),
  path.join(__dirname, '../data/seeds'),
].find((p) => fs.existsSync(p)) ?? path.join(__dirname, '../data/seeds');

const readJsonFile = <T>(filename: string): T | null => {
  try {
    const filePath = path.join(SEEDS_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
};

export type BattlePassRewardEntry =
  | { type: 'item'; item_def_id: string; qty: number }
  | { type: 'currency'; currency: 'spirit_stones' | 'silver'; amount: number };

export type BattlePassSeasonConfig = {
  id: string;
  name: string;
  start_at: string;
  end_at: string;
  max_level: number;
  exp_per_level: number;
  enabled: boolean;
  sort_weight: number;
};

export type BattlePassTaskConfig = {
  id: string;
  code: string;
  name: string;
  description?: string;
  task_type: 'daily' | 'weekly' | 'season';
  condition: { event: string; params?: Record<string, unknown> };
  target_value: number;
  reward_exp: number;
  reward_extra?: BattlePassRewardEntry[];
  enabled?: boolean;
  sort_weight?: number;
};

type BattlePassRewardFile = {
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
  rewards: Array<{ level: number; free?: BattlePassRewardEntry[]; premium?: BattlePassRewardEntry[] }>;
};

type BattlePassTaskFile = {
  season_id: string;
  tasks: BattlePassTaskConfig[];
};

export type BattlePassStaticConfig = {
  season: BattlePassSeasonConfig;
  rewards: Array<{ level: number; free: BattlePassRewardEntry[]; premium: BattlePassRewardEntry[] }>;
  tasks: BattlePassTaskConfig[];
};

type MonthCardDef = {
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

type MonthCardFile = { month_cards: MonthCardDef[] };

export type AchievementRewardEntry =
  | { type: 'item'; item_def_id: string; qty?: number }
  | { type: 'silver' | 'spirit_stones' | 'exp'; amount: number }
  | Record<string, unknown>;

export type AchievementDefConfig = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  points?: number;
  icon?: string;
  hidden?: boolean;
  prerequisite_id?: string | null;
  track_type?: 'counter' | 'flag' | 'multi';
  track_key: string;
  target_value?: number;
  target_list?: unknown[];
  rewards?: AchievementRewardEntry[];
  title_id?: string | null;
  sort_weight?: number;
  enabled?: boolean;
  version?: number;
};

export type TitleDefConfig = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  icon?: string;
  effects?: Record<string, unknown>;
  source_type?: string;
  source_id?: string;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

export type AchievementPointsRewardConfig = {
  id: string;
  points_threshold: number;
  name: string;
  description?: string;
  rewards?: AchievementRewardEntry[];
  title_id?: string | null;
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type AchievementDefFile = { achievements: AchievementDefConfig[] };
type TitleDefFile = { titles: TitleDefConfig[] };
type AchievementPointsRewardFile = { rewards: AchievementPointsRewardConfig[] };

export type NpcDefConfig = {
  id: string;
  code?: string;
  name: string;
  title?: string;
  gender?: string;
  realm?: string;
  avatar?: string;
  description?: string;
  npc_type?: string;
  area?: string;
  talk_tree_id?: string;
  shop_id?: string;
  quest_giver_id?: string;
  drop_pool_id?: string;
  base_attrs?: Record<string, unknown>;
  enabled?: boolean;
  sort_weight?: number;
};

export type TalkTreeDefConfig = {
  id: string;
  name: string;
  greeting_lines?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

export type MapDefConfig = {
  id: string;
  code?: string;
  name: string;
  description?: string;
  background_image?: string;
  map_type?: string;
  parent_map_id?: string;
  world_position?: unknown;
  region?: string;
  req_realm_min?: string | null;
  req_level_min?: number;
  req_quest_id?: string | null;
  req_item_id?: string | null;
  safe_zone?: boolean;
  pk_mode?: string;
  revive_map_id?: string | null;
  revive_room_id?: string | null;
  rooms?: unknown;
  sort_weight?: number;
  enabled?: boolean;
};

export type MonsterPhaseTriggerConfig = {
  hp_percent?: number;
  action?: string;
  effects?: unknown[];
  summon_id?: string;
  summon_count?: number;
};

export type MonsterAIProfileConfig = {
  skills?: string[];
  skill_weights?: Record<string, number>;
  phase_triggers?: MonsterPhaseTriggerConfig[];
};

export type MonsterDefConfig = {
  id: string;
  code?: string;
  name: string;
  title?: string;
  realm?: string;
  level?: number;
  avatar?: string;
  kind?: string;
  element?: string;
  base_attrs?: Record<string, unknown>;
  attr_variance?: number;
  attr_multiplier_min?: number;
  attr_multiplier_max?: number;
  display_stats?: unknown[];
  ai_profile?: MonsterAIProfileConfig;
  drop_pool_id?: string;
  exp_reward?: number;
  silver_reward_min?: number;
  silver_reward_max?: number;
  enabled?: boolean;
};

export type SpawnRuleConfig = {
  id: string;
  area: string;
  pool_type?: string;
  pool_entries?: Array<{ monster_def_id?: string; npc_def_id?: string; weight?: number }>;
  max_alive?: number;
  respawn_sec?: number;
  elite_chance?: number;
  boss_window?: Record<string, unknown>;
  req_realm_min?: string;
  req_quest_id?: string;
  enabled?: boolean;
};

type NpcDefFile = { npcs: NpcDefConfig[]; talk_trees?: TalkTreeDefConfig[] };
type MapDefFile = { maps: MapDefConfig[] };
type MonsterDefFile = { monsters: MonsterDefConfig[] };
type SpawnRuleFile = { rules: SpawnRuleConfig[] };

export type BountyDefConfig = {
  id: string;
  pool?: string;
  task_id: string;
  title: string;
  description?: string | null;
  claim_policy?: string;
  max_claims?: number;
  weight?: number;
  enabled?: boolean;
  version?: number;
};

export type DungeonDefConfig = {
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
};

export type DungeonWaveConfig = {
  id?: string;
  stage_id?: string;
  wave_index: number;
  spawn_delay_sec?: number;
  monsters?: unknown[];
  wave_rewards?: unknown;
  enabled?: boolean;
};

export type DungeonStageConfig = {
  id: string;
  difficulty_id: string;
  stage_index: number;
  name?: string | null;
  type: string;
  description?: string | null;
  time_limit_sec?: number;
  clear_condition?: unknown;
  fail_condition?: unknown;
  events?: unknown;
  waves?: DungeonWaveConfig[];
  enabled?: boolean;
};

export type DungeonDifficultyConfig = {
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
  stages?: DungeonStageConfig[];
};

export type DialogueDefConfig = {
  id: string;
  name: string;
  nodes?: unknown[];
  enabled?: boolean;
};

type BountyDefFile = { bounties: BountyDefConfig[] };
type DungeonSeedFile = {
  dungeons?: Array<{
    def?: DungeonDefConfig;
    difficulties?: DungeonDifficultyConfig[];
  }>;
};
type DialogueFile = { dialogues: DialogueDefConfig[] };

export type TechniqueDefConfig = {
  id: string;
  code?: string;
  name: string;
  type: string;
  quality: string;
  max_layer?: number;
  required_realm?: string;
  attribute_type?: string;
  attribute_element?: string;
  tags?: string[];
  description?: string | null;
  long_desc?: string | null;
  icon?: string | null;
  obtain_type?: string | null;
  obtain_hint?: string[];
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
};

export type SkillDefConfig = {
  id: string;
  code?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  source_type: string;
  source_id?: string | null;
  cost_lingqi?: number;
  cost_qixue?: number;
  cooldown?: number;
  target_type: string;
  target_count?: number;
  damage_type?: string | null;
  element?: string;
  effects?: unknown[];
  trigger_type?: string;
  conditions?: unknown;
  ai_priority?: number;
  ai_conditions?: unknown;
  upgrades?: unknown;
  sort_weight?: number;
  version?: number;
  enabled?: boolean;
};

export type TaskDefConfig = {
  id: string;
  category: string;
  title: string;
  realm: string;
  description?: string;
  giver_npc_id?: string;
  map_id?: string;
  room_id?: string;
  objectives?: Array<{
    id: string;
    type: string;
    text: string;
    target: number;
    params?: Record<string, unknown>;
  }>;
  rewards?: Array<{
    type: string;
    item_def_id?: string;
    qty?: number;
    qty_min?: number;
    qty_max?: number;
    amount?: number;
  }>;
  prereq_task_ids?: string[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type TechniqueDefFile = { techniques: TechniqueDefConfig[] };
type SkillDefFile = { skills: SkillDefConfig[] };
type TaskDefFile = { tasks: TaskDefConfig[] };

export type ItemDefConfig = {
  id: string;
  name: string;
  category: string;
  sub_category?: string;
  quality?: string;
  gem_level?: number;
  stack_max?: number;
  bind_type?: string;
  tradeable?: boolean;
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
  enabled?: boolean;
};

type ItemDefFile = { items: ItemDefConfig[] };

export type ItemRecipeCostItemConfig = {
  item_def_id: string;
  qty: number;
};

export type ItemRecipeConfig = {
  id: string;
  name: string;
  recipe_type: string;
  product_item_def_id: string;
  product_qty: number;
  product_quality_min?: string;
  product_quality_max?: string;
  cost_silver?: number;
  cost_spirit_stones?: number;
  cost_exp?: number;
  cost_items?: ItemRecipeCostItemConfig[];
  req_realm?: string;
  req_level?: number;
  req_building?: string;
  success_rate?: number;
  fail_return_rate?: number;
  enabled?: boolean;
};

type ItemRecipeFile = {
  recipes: ItemRecipeConfig[];
};

export type MainQuestChapterConfig = {
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
};

export type MainQuestSectionObjectiveConfig = {
  id: string;
  type: string;
  text: string;
  target: number;
  params?: Record<string, unknown>;
};

export type MainQuestSectionConfig = {
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
  objectives?: MainQuestSectionObjectiveConfig[];
  rewards?: Record<string, unknown>;
  auto_accept?: boolean;
  auto_complete?: boolean;
  is_chapter_final?: boolean;
  sort_weight?: number;
  enabled?: boolean;
};

type MainQuestFile = {
  chapters?: MainQuestChapterConfig[];
  sections?: MainQuestSectionConfig[];
};

export type DropPoolEntryConfig = {
  item_def_id: string;
  chance?: number;
  weight?: number;
  qty_min?: number;
  qty_max?: number;
  qty_multiply_by_monster_realm?: number;
  quality_weights?: Record<string, unknown> | null;
  bind_type?: string;
  show_in_ui?: boolean;
  sort_order?: number;
};

export type DropPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  mode?: 'prob' | 'weight';
  common_pool_ids?: string[];
  entries?: DropPoolEntryConfig[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type DropPoolFile = {
  pools: DropPoolDefConfig[];
};

type CommonDropPoolFile = {
  pools: DropPoolDefConfig[];
};

export type AffixTierConfig = {
  tier: number;
  min: number;
  max: number;
  realm_rank_min: number;
  description?: string;
};

export type AffixModifierConfig = {
  attr_key: string;
  ratio?: number;
};

export type AffixDefConfig = {
  key: string;
  name: string;
  modifiers?: AffixModifierConfig[];
  apply_type: 'flat' | 'percent' | 'special';
  group: string;
  weight: number;
  is_legendary?: boolean;
  trigger?: 'on_turn_start' | 'on_skill' | 'on_hit' | 'on_crit' | 'on_be_hit' | 'on_heal';
  target?: 'self' | 'enemy';
  effect_type?: 'buff' | 'debuff' | 'damage' | 'heal' | 'resource' | 'shield' | 'mark';
  duration_round?: number;
  params?: Record<string, string | number | boolean>;
  tiers: AffixTierConfig[];
};

export type AffixPoolRulesConfig = {
  allow_duplicate?: boolean;
  mutex_groups?: string[][];
  legendary_chance?: number;
};

export type AffixPoolDefConfig = {
  id: string;
  name: string;
  description?: string;
  rules: AffixPoolRulesConfig;
  affixes: AffixDefConfig[];
  enabled?: boolean;
  version?: number;
};

type AffixPoolFile = {
  pools: AffixPoolDefConfig[];
};

export type ItemSetPieceConfig = {
  equip_slot: string;
  item_def_id: string;
  piece_key: string;
};

export type ItemSetBonusConfig = {
  piece_count: number;
  effect_defs: unknown[];
  priority?: number;
};

export type ItemSetDefConfig = {
  id: string;
  name: string;
  description?: string;
  quality_rank?: number;
  min_realm?: string;
  pieces?: ItemSetPieceConfig[];
  bonuses?: ItemSetBonusConfig[];
  enabled?: boolean;
  sort_weight?: number;
  version?: number;
};

type ItemSetFile = {
  sets: ItemSetDefConfig[];
};

export type TechniqueLayerCostMaterialConfig = {
  itemId: string;
  qty: number;
};

export type TechniqueLayerPassiveConfig = {
  key: string;
  value: number;
};

export type TechniqueLayerConfig = {
  technique_id: string;
  layer: number;
  cost_spirit_stones?: number;
  cost_exp?: number;
  cost_materials?: TechniqueLayerCostMaterialConfig[];
  passives?: TechniqueLayerPassiveConfig[];
  unlock_skill_ids?: string[];
  upgrade_skill_ids?: string[];
  required_realm?: string | null;
  required_quest_id?: string | null;
  layer_desc?: string | null;
  enabled?: boolean;
};

type TechniqueLayerFile = {
  layers: TechniqueLayerConfig[];
};

export type InsightGrowthConfig = {
  unlock_realm: string;
  cost_stage_levels: number;
  cost_stage_base_exp: number;
  bonus_pct_per_level: number;
};

type InsightGrowthFile = {
  unlock_realm?: unknown;
  cost_stage_levels?: unknown;
  cost_stage_base_exp?: unknown;
  bonus_pct_per_level?: unknown;
};

let battlePassCache: BattlePassStaticConfig | null | undefined;
let monthCardCache: MonthCardDef[] | null | undefined;
let itemDefCache: ItemDefConfig[] | null | undefined;
let itemDefByIdCache: Map<string, ItemDefConfig> | null | undefined;
let itemRecipeCache: ItemRecipeConfig[] | null | undefined;
let itemRecipeByIdCache: Map<string, ItemRecipeConfig> | null | undefined;
let achievementDefCache: AchievementDefConfig[] | null | undefined;
let titleDefCache: TitleDefConfig[] | null | undefined;
let achievementPointsRewardCache: AchievementPointsRewardConfig[] | null | undefined;
let npcDefCache: NpcDefConfig[] | null | undefined;
let talkTreeDefCache: TalkTreeDefConfig[] | null | undefined;
let mapDefCache: MapDefConfig[] | null | undefined;
let monsterDefCache: MonsterDefConfig[] | null | undefined;
let spawnRuleCache: SpawnRuleConfig[] | null | undefined;
let bountyDefCache: BountyDefConfig[] | null | undefined;
let dungeonDefCache: DungeonDefConfig[] | null | undefined;
let dungeonDifficultyCache: DungeonDifficultyConfig[] | null | undefined;
let dungeonDifficultyByIdCache: Map<string, DungeonDifficultyConfig> | null | undefined;
let dungeonDifficultiesByDungeonIdCache: Map<string, DungeonDifficultyConfig[]> | null | undefined;
let dungeonStageCache: DungeonStageConfig[] | null | undefined;
let dungeonStagesByDifficultyIdCache: Map<string, DungeonStageConfig[]> | null | undefined;
let dungeonWaveCache: DungeonWaveConfig[] | null | undefined;
let dungeonWavesByStageIdCache: Map<string, DungeonWaveConfig[]> | null | undefined;
let dialogueDefCache: DialogueDefConfig[] | null | undefined;
let techniqueDefCache: TechniqueDefConfig[] | null | undefined;
let skillDefCache: SkillDefConfig[] | null | undefined;
let taskDefCache: TaskDefConfig[] | null | undefined;
let dropPoolDefCache: DropPoolDefConfig[] | null | undefined;
let commonDropPoolDefCache: DropPoolDefConfig[] | null | undefined;
let affixPoolDefCache: AffixPoolDefConfig[] | null | undefined;
let itemSetDefCache: ItemSetDefConfig[] | null | undefined;
let techniqueLayerCache: TechniqueLayerConfig[] | null | undefined;
let insightGrowthCache: InsightGrowthConfig | undefined;
let mainQuestChapterCache: MainQuestChapterConfig[] | null | undefined;
let mainQuestSectionCache: MainQuestSectionConfig[] | null | undefined;
let mainQuestChapterByIdCache: Map<string, MainQuestChapterConfig> | null | undefined;
let mainQuestSectionByIdCache: Map<string, MainQuestSectionConfig> | null | undefined;

const ensureItemDefinitionSnapshot = (): { list: ItemDefConfig[]; byId: Map<string, ItemDefConfig> } => {
  if (itemDefCache !== undefined && itemDefByIdCache !== undefined) {
    return {
      list: itemDefCache ?? [],
      byId: itemDefByIdCache ?? new Map<string, ItemDefConfig>(),
    };
  }

  const mergedMap = new Map<string, ItemDefConfig>();
  const files: string[] = ['item_def.json', 'gem_def.json', 'equipment_def.json'];
  for (const filename of files) {
    const file = readJsonFile<ItemDefFile>(filename);
    const items = Array.isArray(file?.items) ? file.items : [];
    for (const entry of items) {
      const id = String(entry?.id ?? '').trim();
      if (!id) continue;
      mergedMap.set(id, {
        ...entry,
        id,
        enabled: entry.enabled !== false,
      });
    }
  }

  itemDefCache = Array.from(mergedMap.values());
  itemDefByIdCache = mergedMap;
  return { list: itemDefCache, byId: itemDefByIdCache };
};

const ensureItemRecipeSnapshot = (): { list: ItemRecipeConfig[]; byId: Map<string, ItemRecipeConfig> } => {
  if (itemRecipeCache !== undefined && itemRecipeByIdCache !== undefined) {
    return {
      list: itemRecipeCache ?? [],
      byId: itemRecipeByIdCache ?? new Map<string, ItemRecipeConfig>(),
    };
  }

  const mergedMap = new Map<string, ItemRecipeConfig>();
  const files: string[] = ['item_recipe.json', 'gem_synthesis_recipe.json'];
  for (const filename of files) {
    const file = readJsonFile<ItemRecipeFile>(filename);
    const recipes = Array.isArray(file?.recipes) ? file.recipes : [];
    for (const entry of recipes) {
      const id = String(entry?.id ?? '').trim();
      if (!id) continue;
      mergedMap.set(id, {
        ...entry,
        id,
        enabled: entry.enabled !== false,
      });
    }
  }

  itemRecipeCache = Array.from(mergedMap.values());
  itemRecipeByIdCache = mergedMap;
  return { list: itemRecipeCache, byId: itemRecipeByIdCache };
};

const ensureMainQuestSnapshot = (): {
  chapters: MainQuestChapterConfig[];
  sections: MainQuestSectionConfig[];
  chapterById: Map<string, MainQuestChapterConfig>;
  sectionById: Map<string, MainQuestSectionConfig>;
} => {
  if (
    mainQuestChapterCache !== undefined &&
    mainQuestSectionCache !== undefined &&
    mainQuestChapterByIdCache !== undefined &&
    mainQuestSectionByIdCache !== undefined
  ) {
    return {
      chapters: mainQuestChapterCache ?? [],
      sections: mainQuestSectionCache ?? [],
      chapterById: mainQuestChapterByIdCache ?? new Map<string, MainQuestChapterConfig>(),
      sectionById: mainQuestSectionByIdCache ?? new Map<string, MainQuestSectionConfig>(),
    };
  }

  const chapterById = new Map<string, MainQuestChapterConfig>();
  const sectionById = new Map<string, MainQuestSectionConfig>();
  const files = fs.existsSync(SEEDS_DIR)
    ? fs
        .readdirSync(SEEDS_DIR)
        .filter((filename) => /^main_quest_chapter\d+\.json$/i.test(filename))
        .sort((left, right) => left.localeCompare(right))
    : [];

  for (const filename of files) {
    const file = readJsonFile<MainQuestFile>(filename);
    const chapters = Array.isArray(file?.chapters) ? file.chapters : [];
    const sections = Array.isArray(file?.sections) ? file.sections : [];

    for (const chapter of chapters) {
      const id = String(chapter?.id ?? '').trim();
      if (!id) continue;
      const chapterNum = Number(chapter?.chapter_num);
      chapterById.set(id, {
        ...chapter,
        id,
        chapter_num: Number.isFinite(chapterNum) ? Math.max(0, Math.floor(chapterNum)) : 0,
        enabled: chapter.enabled !== false,
      });
    }

    for (const section of sections) {
      const id = String(section?.id ?? '').trim();
      const chapterId = String(section?.chapter_id ?? '').trim();
      if (!id || !chapterId) continue;
      const sectionNum = Number(section?.section_num);
      sectionById.set(id, {
        ...section,
        id,
        chapter_id: chapterId,
        section_num: Number.isFinite(sectionNum) ? Math.max(0, Math.floor(sectionNum)) : 0,
        enabled: section.enabled !== false,
      });
    }
  }

  const enabledSectionCountByChapterId = new Map<string, number>();
  for (const section of sectionById.values()) {
    if (section.enabled === false) continue;
    enabledSectionCountByChapterId.set(
      section.chapter_id,
      (enabledSectionCountByChapterId.get(section.chapter_id) ?? 0) + 1,
    );
  }

  const maxEnabledSectionCountByChapterNum = new Map<number, number>();
  for (const chapter of chapterById.values()) {
    if (chapter.enabled === false) continue;
    const chapterNum = Number(chapter.chapter_num);
    if (!Number.isFinite(chapterNum) || chapterNum <= 0) continue;
    const count = enabledSectionCountByChapterId.get(chapter.id) ?? 0;
    const previous = maxEnabledSectionCountByChapterNum.get(chapterNum) ?? 0;
    if (count > previous) maxEnabledSectionCountByChapterNum.set(chapterNum, count);
  }

  const chapterList = Array.from(chapterById.values()).map((chapter) => {
    if (chapter.enabled === false) return chapter;
    const chapterNum = Number(chapter.chapter_num);
    if (!Number.isFinite(chapterNum) || chapterNum <= 0) return chapter;
    const enabledCount = enabledSectionCountByChapterId.get(chapter.id) ?? 0;
    const maxEnabledCount = maxEnabledSectionCountByChapterNum.get(chapterNum) ?? 0;
    if (maxEnabledCount > 0 && enabledCount < maxEnabledCount) {
      return { ...chapter, enabled: false };
    }
    return chapter;
  });

  const patchedChapterById = new Map(chapterList.map((chapter) => [chapter.id, chapter]));
  mainQuestChapterCache = chapterList;
  mainQuestSectionCache = Array.from(sectionById.values());
  mainQuestChapterByIdCache = patchedChapterById;
  mainQuestSectionByIdCache = sectionById;

  return {
    chapters: mainQuestChapterCache,
    sections: mainQuestSectionCache,
    chapterById: mainQuestChapterByIdCache,
    sectionById: mainQuestSectionByIdCache,
  };
};

const ensureDungeonSnapshot = (): {
  defs: DungeonDefConfig[];
  difficulties: DungeonDifficultyConfig[];
  difficultyById: Map<string, DungeonDifficultyConfig>;
  difficultiesByDungeonId: Map<string, DungeonDifficultyConfig[]>;
  stages: DungeonStageConfig[];
  stagesByDifficultyId: Map<string, DungeonStageConfig[]>;
  waves: DungeonWaveConfig[];
  wavesByStageId: Map<string, DungeonWaveConfig[]>;
} => {
  if (
    dungeonDefCache !== undefined &&
    dungeonDifficultyCache !== undefined &&
    dungeonDifficultyByIdCache !== undefined &&
    dungeonDifficultiesByDungeonIdCache !== undefined &&
    dungeonStageCache !== undefined &&
    dungeonStagesByDifficultyIdCache !== undefined &&
    dungeonWaveCache !== undefined &&
    dungeonWavesByStageIdCache !== undefined
  ) {
    return {
      defs: dungeonDefCache ?? [],
      difficulties: dungeonDifficultyCache ?? [],
      difficultyById: dungeonDifficultyByIdCache ?? new Map<string, DungeonDifficultyConfig>(),
      difficultiesByDungeonId: dungeonDifficultiesByDungeonIdCache ?? new Map<string, DungeonDifficultyConfig[]>(),
      stages: dungeonStageCache ?? [],
      stagesByDifficultyId: dungeonStagesByDifficultyIdCache ?? new Map<string, DungeonStageConfig[]>(),
      waves: dungeonWaveCache ?? [],
      wavesByStageId: dungeonWavesByStageIdCache ?? new Map<string, DungeonWaveConfig[]>(),
    };
  }

  const toSafeInt = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
  };

  const files = fs.existsSync(SEEDS_DIR)
    ? fs
        .readdirSync(SEEDS_DIR)
        .filter((filename) => /^dungeon_.*\.json$/i.test(filename))
        .sort((left, right) => left.localeCompare(right))
    : [];

  const defById = new Map<string, DungeonDefConfig>();
  const difficultyById = new Map<string, DungeonDifficultyConfig>();
  const stageById = new Map<string, DungeonStageConfig>();
  const waveByKey = new Map<string, DungeonWaveConfig>();

  for (const filename of files) {
    const file = readJsonFile<DungeonSeedFile>(filename);
    const list = Array.isArray(file?.dungeons) ? file.dungeons : [];
    for (const entry of list) {
      const defId = String(entry?.def?.id ?? '').trim();
      if (!defId) continue;

      const def = entry.def;
      if (def) {
        defById.set(defId, {
          ...def,
          id: defId,
          enabled: def.enabled !== false,
        });
      }

      const difficulties = Array.isArray(entry.difficulties) ? entry.difficulties : [];
      for (const difficultyRaw of difficulties) {
        const difficultyId = String(difficultyRaw?.id ?? '').trim();
        const dungeonId = String(difficultyRaw?.dungeon_id ?? defId).trim();
        if (!difficultyId || !dungeonId) continue;

        const difficulty: DungeonDifficultyConfig = {
          ...difficultyRaw,
          id: difficultyId,
          dungeon_id: dungeonId,
          name: String(difficultyRaw?.name ?? difficultyId),
          difficulty_rank: Math.max(1, toSafeInt(difficultyRaw?.difficulty_rank, 1)),
          monster_level_add: toSafeInt(difficultyRaw?.monster_level_add, 0),
          monster_attr_mult: Number(difficultyRaw?.monster_attr_mult ?? 1) || 1,
          reward_mult: Number(difficultyRaw?.reward_mult ?? 1) || 1,
          min_realm: typeof difficultyRaw?.min_realm === 'string' ? difficultyRaw.min_realm : null,
          unlock_prev_difficulty: difficultyRaw?.unlock_prev_difficulty === true,
          first_clear_rewards: difficultyRaw?.first_clear_rewards ?? {},
          drop_pool_id: typeof difficultyRaw?.drop_pool_id === 'string' ? difficultyRaw.drop_pool_id : null,
          enabled: difficultyRaw?.enabled !== false,
        };
        difficultyById.set(difficultyId, difficulty);

        const stages = Array.isArray(difficultyRaw?.stages) ? difficultyRaw.stages : [];
        for (const stageRaw of stages) {
          const stageId = String(stageRaw?.id ?? '').trim();
          const stageDifficultyId = String(stageRaw?.difficulty_id ?? difficultyId).trim();
          if (!stageId || !stageDifficultyId) continue;

          const stage: DungeonStageConfig = {
            ...stageRaw,
            id: stageId,
            difficulty_id: stageDifficultyId,
            stage_index: Math.max(1, toSafeInt(stageRaw?.stage_index, 1)),
            name: typeof stageRaw?.name === 'string' ? stageRaw.name : null,
            type: typeof stageRaw?.type === 'string' && stageRaw.type.trim() ? stageRaw.type : 'battle',
            description: typeof stageRaw?.description === 'string' ? stageRaw.description : null,
            time_limit_sec: Math.max(0, toSafeInt(stageRaw?.time_limit_sec, 0)),
            clear_condition: stageRaw?.clear_condition ?? {},
            fail_condition: stageRaw?.fail_condition ?? {},
            events: Array.isArray(stageRaw?.events) ? stageRaw.events : [],
            enabled: stageRaw?.enabled !== false,
          };
          stageById.set(stageId, stage);

          const waves = Array.isArray(stageRaw?.waves) ? stageRaw.waves : [];
          for (let index = 0; index < waves.length; index += 1) {
            const waveRaw = waves[index];
            const waveIndex = Math.max(1, toSafeInt(waveRaw?.wave_index, index + 1));
            const waveIdRaw = typeof waveRaw?.id === 'string' ? waveRaw.id : '';
            const waveId = waveIdRaw.trim() || `${stageId}#${waveIndex}`;
            const waveKey = `${stageId}::${waveIndex}`;
            waveByKey.set(waveKey, {
              ...waveRaw,
              id: waveId,
              stage_id: stageId,
              wave_index: waveIndex,
              spawn_delay_sec: Math.max(0, toSafeInt(waveRaw?.spawn_delay_sec, 0)),
              monsters: Array.isArray(waveRaw?.monsters) ? waveRaw.monsters : [],
              wave_rewards: waveRaw?.wave_rewards ?? {},
              enabled: waveRaw?.enabled !== false,
            });
          }
        }
      }
    }
  }

  const defs = Array.from(defById.values());
  const difficulties = Array.from(difficultyById.values()).sort(
    (left, right) =>
      left.dungeon_id.localeCompare(right.dungeon_id) ||
      Number(left.difficulty_rank ?? 0) - Number(right.difficulty_rank ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const stages = Array.from(stageById.values()).sort(
    (left, right) =>
      left.difficulty_id.localeCompare(right.difficulty_id) ||
      Number(left.stage_index ?? 0) - Number(right.stage_index ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const waves = Array.from(waveByKey.values()).sort(
    (left, right) =>
      String(left.stage_id ?? '').localeCompare(String(right.stage_id ?? '')) ||
      Number(left.wave_index ?? 0) - Number(right.wave_index ?? 0) ||
      String(left.id ?? '').localeCompare(String(right.id ?? '')),
  );

  const difficultiesByDungeonId = new Map<string, DungeonDifficultyConfig[]>();
  for (const difficulty of difficulties) {
    const list = difficultiesByDungeonId.get(difficulty.dungeon_id) ?? [];
    list.push(difficulty);
    difficultiesByDungeonId.set(difficulty.dungeon_id, list);
  }

  const stagesByDifficultyId = new Map<string, DungeonStageConfig[]>();
  for (const stage of stages) {
    const list = stagesByDifficultyId.get(stage.difficulty_id) ?? [];
    list.push(stage);
    stagesByDifficultyId.set(stage.difficulty_id, list);
  }

  const wavesByStageId = new Map<string, DungeonWaveConfig[]>();
  for (const wave of waves) {
    const stageId = String(wave.stage_id ?? '').trim();
    if (!stageId) continue;
    const list = wavesByStageId.get(stageId) ?? [];
    list.push(wave);
    wavesByStageId.set(stageId, list);
  }

  dungeonDefCache = defs;
  dungeonDifficultyCache = difficulties;
  dungeonDifficultyByIdCache = new Map(difficulties.map((entry) => [entry.id, entry]));
  dungeonDifficultiesByDungeonIdCache = difficultiesByDungeonId;
  dungeonStageCache = stages;
  dungeonStagesByDifficultyIdCache = stagesByDifficultyId;
  dungeonWaveCache = waves;
  dungeonWavesByStageIdCache = wavesByStageId;

  return {
    defs,
    difficulties,
    difficultyById: new Map(difficulties.map((entry) => [entry.id, entry])),
    difficultiesByDungeonId,
    stages,
    stagesByDifficultyId,
    waves,
    wavesByStageId,
  };
};

export const getBattlePassStaticConfig = (): BattlePassStaticConfig | null => {
  if (battlePassCache !== undefined) return battlePassCache;

  const rewardFile = readJsonFile<BattlePassRewardFile>('battle_pass_rewards.json');
  const taskFile = readJsonFile<BattlePassTaskFile>('battle_pass_tasks.json');
  if (!rewardFile?.season?.id || !Array.isArray(rewardFile.rewards) || !taskFile?.season_id || !Array.isArray(taskFile.tasks)) {
    battlePassCache = null;
    return battlePassCache;
  }

  const season: BattlePassSeasonConfig = {
    id: String(rewardFile.season.id),
    name: String(rewardFile.season.name || ''),
    start_at: String(rewardFile.season.start_at),
    end_at: String(rewardFile.season.end_at),
    max_level: Number.isFinite(Number(rewardFile.season.max_level)) ? Number(rewardFile.season.max_level) : 30,
    exp_per_level: Number.isFinite(Number(rewardFile.season.exp_per_level)) ? Number(rewardFile.season.exp_per_level) : 1000,
    enabled: rewardFile.season.enabled !== false,
    sort_weight: Number.isFinite(Number(rewardFile.season.sort_weight)) ? Number(rewardFile.season.sort_weight) : 0,
  };

  const rewards = rewardFile.rewards
    .map((entry) => ({
      level: Number(entry.level),
      free: Array.isArray(entry.free) ? entry.free : [],
      premium: Array.isArray(entry.premium) ? entry.premium : [],
    }))
    .filter((entry) => Number.isFinite(entry.level) && entry.level > 0)
    .sort((a, b) => a.level - b.level);

  if (String(taskFile.season_id) !== season.id) {
    battlePassCache = null;
    return battlePassCache;
  }

  const tasks = taskFile.tasks;

  battlePassCache = {
    season,
    rewards,
    tasks,
  };
  return battlePassCache;
};

export const getMonthCardDefinitions = (): MonthCardDef[] => {
  if (monthCardCache !== undefined) return monthCardCache ?? [];
  const file = readJsonFile<MonthCardFile>('month_card.json');
  monthCardCache = Array.isArray(file?.month_cards) ? file.month_cards : [];
  return monthCardCache;
};

export const getItemDefinitions = (): ItemDefConfig[] => {
  return ensureItemDefinitionSnapshot().list;
};

export const getEnabledItemDefinitions = (): ItemDefConfig[] => {
  return ensureItemDefinitionSnapshot().list.filter((entry) => entry.enabled !== false);
};

export const getItemDefinitionById = (itemDefId: string): ItemDefConfig | null => {
  const id = String(itemDefId || '').trim();
  if (!id) return null;
  return ensureItemDefinitionSnapshot().byId.get(id) ?? null;
};

export const getItemDefinitionsByIds = (itemDefIds: string[]): Map<string, ItemDefConfig> => {
  const ids = Array.from(new Set(itemDefIds.map((entry) => String(entry || '').trim()).filter((entry) => entry.length > 0)));
  const map = new Map<string, ItemDefConfig>();
  if (ids.length === 0) return map;

  const byId = ensureItemDefinitionSnapshot().byId;
  for (const id of ids) {
    const def = byId.get(id);
    if (def) map.set(id, def);
  }
  return map;
};

export const getItemRecipeDefinitions = (): ItemRecipeConfig[] => {
  return ensureItemRecipeSnapshot().list;
};

export const getItemRecipeById = (recipeId: string): ItemRecipeConfig | null => {
  const id = String(recipeId || '').trim();
  if (!id) return null;
  return ensureItemRecipeSnapshot().byId.get(id) ?? null;
};

export const getItemRecipeDefinitionsByType = (recipeType?: string): ItemRecipeConfig[] => {
  const type = String(recipeType || '').trim();
  const list = ensureItemRecipeSnapshot().list.filter((entry) => entry.enabled !== false);
  if (!type) return list;
  return list.filter((entry) => String(entry.recipe_type || '').trim() === type);
};

export const getMainQuestChapterDefinitions = (): MainQuestChapterConfig[] => {
  return ensureMainQuestSnapshot().chapters;
};

export const getMainQuestSectionDefinitions = (): MainQuestSectionConfig[] => {
  return ensureMainQuestSnapshot().sections;
};

export const getMainQuestChapterById = (chapterId: string): MainQuestChapterConfig | null => {
  const id = String(chapterId || '').trim();
  if (!id) return null;
  return ensureMainQuestSnapshot().chapterById.get(id) ?? null;
};

export const getMainQuestSectionById = (sectionId: string): MainQuestSectionConfig | null => {
  const id = String(sectionId || '').trim();
  if (!id) return null;
  return ensureMainQuestSnapshot().sectionById.get(id) ?? null;
};

export const getAchievementDefinitions = (): AchievementDefConfig[] => {
  if (achievementDefCache !== undefined) return achievementDefCache ?? [];
  const file = readJsonFile<AchievementDefFile>('achievement_def.json');
  achievementDefCache = Array.isArray(file?.achievements) ? file.achievements : [];
  return achievementDefCache;
};

export const getTitleDefinitions = (): TitleDefConfig[] => {
  if (titleDefCache !== undefined) return titleDefCache ?? [];
  const file = readJsonFile<TitleDefFile>('title_def.json');
  titleDefCache = Array.isArray(file?.titles) ? file.titles : [];
  return titleDefCache;
};

export const getAchievementPointsRewardDefinitions = (): AchievementPointsRewardConfig[] => {
  if (achievementPointsRewardCache !== undefined) return achievementPointsRewardCache ?? [];
  const file = readJsonFile<AchievementPointsRewardFile>('achievement_points_rewards.json');
  achievementPointsRewardCache = Array.isArray(file?.rewards) ? file.rewards : [];
  return achievementPointsRewardCache;
};

export const getNpcDefinitions = (): NpcDefConfig[] => {
  if (npcDefCache !== undefined) return npcDefCache ?? [];
  const file = readJsonFile<NpcDefFile>('npc_def.json');
  npcDefCache = Array.isArray(file?.npcs) ? file.npcs : [];
  return npcDefCache;
};

export const getTalkTreeDefinitions = (): TalkTreeDefConfig[] => {
  if (talkTreeDefCache !== undefined) return talkTreeDefCache ?? [];
  const file = readJsonFile<NpcDefFile>('npc_def.json');
  talkTreeDefCache = Array.isArray(file?.talk_trees) ? file.talk_trees : [];
  return talkTreeDefCache;
};

export const getMapDefinitions = (): MapDefConfig[] => {
  if (mapDefCache !== undefined) return mapDefCache ?? [];
  const file = readJsonFile<MapDefFile>('map_def.json');
  mapDefCache = Array.isArray(file?.maps) ? file.maps : [];
  return mapDefCache;
};

export const getMonsterDefinitions = (): MonsterDefConfig[] => {
  if (monsterDefCache !== undefined) return monsterDefCache ?? [];
  const file = readJsonFile<MonsterDefFile>('monster_def.json');
  monsterDefCache = Array.isArray(file?.monsters) ? file.monsters : [];
  return monsterDefCache;
};

export const getSpawnRuleDefinitions = (): SpawnRuleConfig[] => {
  if (spawnRuleCache !== undefined) return spawnRuleCache ?? [];
  const file = readJsonFile<SpawnRuleFile>('spawn_rule.json');
  spawnRuleCache = Array.isArray(file?.rules) ? file.rules : [];
  return spawnRuleCache;
};

export const getBountyDefinitions = (): BountyDefConfig[] => {
  if (bountyDefCache !== undefined) return bountyDefCache ?? [];
  const file = readJsonFile<BountyDefFile>('bounty_def.json');
  bountyDefCache = Array.isArray(file?.bounties) ? file.bounties : [];
  return bountyDefCache;
};

export const getDungeonDefinitions = (): DungeonDefConfig[] => {
  return ensureDungeonSnapshot().defs;
};

export const getDungeonDifficultyDefinitions = (): DungeonDifficultyConfig[] => {
  return ensureDungeonSnapshot().difficulties;
};

export const getDungeonDifficultyById = (difficultyId: string): DungeonDifficultyConfig | null => {
  const id = String(difficultyId || '').trim();
  if (!id) return null;
  return ensureDungeonSnapshot().difficultyById.get(id) ?? null;
};

export const getDungeonDifficultiesByDungeonId = (dungeonId: string): DungeonDifficultyConfig[] => {
  const id = String(dungeonId || '').trim();
  if (!id) return [];
  return ensureDungeonSnapshot().difficultiesByDungeonId.get(id) ?? [];
};

export const getDungeonStageDefinitions = (): DungeonStageConfig[] => {
  return ensureDungeonSnapshot().stages;
};

export const getDungeonStagesByDifficultyId = (difficultyId: string): DungeonStageConfig[] => {
  const id = String(difficultyId || '').trim();
  if (!id) return [];
  return ensureDungeonSnapshot().stagesByDifficultyId.get(id) ?? [];
};

export const getDungeonWaveDefinitions = (): DungeonWaveConfig[] => {
  return ensureDungeonSnapshot().waves;
};

export const getDungeonWavesByStageId = (stageId: string): DungeonWaveConfig[] => {
  const id = String(stageId || '').trim();
  if (!id) return [];
  return ensureDungeonSnapshot().wavesByStageId.get(id) ?? [];
};

export const getDialogueDefinitions = (): DialogueDefConfig[] => {
  if (dialogueDefCache !== undefined) return dialogueDefCache ?? [];

  const files = fs.existsSync(SEEDS_DIR)
    ? fs
        .readdirSync(SEEDS_DIR)
        .filter((filename) => /^dialogue_main_chapter\d+\.json$/i.test(filename))
        .sort((left, right) => left.localeCompare(right))
    : [];

  const dialogues: DialogueDefConfig[] = [];
  for (const filename of files) {
    const file = readJsonFile<DialogueFile>(filename);
    if (!Array.isArray(file?.dialogues)) continue;
    dialogues.push(...file.dialogues);
  }

  dialogueDefCache = dialogues;
  return dialogueDefCache;
};

export const getTechniqueDefinitions = (): TechniqueDefConfig[] => {
  if (techniqueDefCache !== undefined) return techniqueDefCache ?? [];
  const file = readJsonFile<TechniqueDefFile>('technique_def.json');
  techniqueDefCache = Array.isArray(file?.techniques) ? file.techniques : [];
  return techniqueDefCache;
};

export const getSkillDefinitions = (): SkillDefConfig[] => {
  if (skillDefCache !== undefined) return skillDefCache ?? [];
  const file = readJsonFile<SkillDefFile>('skill_def.json');
  skillDefCache = Array.isArray(file?.skills) ? file.skills : [];
  return skillDefCache;
};

export const getTaskDefinitions = (): TaskDefConfig[] => {
  if (taskDefCache !== undefined) return taskDefCache ?? [];
  const file = readJsonFile<TaskDefFile>('task_def.json');
  taskDefCache = Array.isArray(file?.tasks) ? file.tasks : [];
  return taskDefCache;
};

export const getDropPoolDefinitions = (): DropPoolDefConfig[] => {
  if (dropPoolDefCache !== undefined) return dropPoolDefCache ?? [];
  const file = readJsonFile<DropPoolFile>('drop_pool.json');
  dropPoolDefCache = Array.isArray(file?.pools) ? file.pools : [];
  return dropPoolDefCache;
};

export const getCommonDropPoolDefinitions = (): DropPoolDefConfig[] => {
  if (commonDropPoolDefCache !== undefined) return commonDropPoolDefCache ?? [];
  const file = readJsonFile<CommonDropPoolFile>('drop_pool_common.json');
  commonDropPoolDefCache = Array.isArray(file?.pools) ? file.pools : [];
  return commonDropPoolDefCache;
};

export const getAffixPoolDefinitions = (): AffixPoolDefConfig[] => {
  if (affixPoolDefCache !== undefined) return affixPoolDefCache ?? [];
  const file = readJsonFile<AffixPoolFile>('affix_pool.json');
  affixPoolDefCache = Array.isArray(file?.pools) ? file.pools : [];
  return affixPoolDefCache;
};

export const getItemSetDefinitions = (): ItemSetDefConfig[] => {
  if (itemSetDefCache !== undefined) return itemSetDefCache ?? [];
  const file = readJsonFile<ItemSetFile>('item_set.json');
  itemSetDefCache = Array.isArray(file?.sets) ? file.sets : [];
  return itemSetDefCache;
};

export const getTechniqueLayerDefinitions = (): TechniqueLayerConfig[] => {
  if (techniqueLayerCache !== undefined) return techniqueLayerCache ?? [];
  const file = readJsonFile<TechniqueLayerFile>('technique_layer.json');
  techniqueLayerCache = Array.isArray(file?.layers) ? file.layers : [];
  return techniqueLayerCache;
};

/**
 * 严格读取悟道成长配置。
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：从 `insight_growth.json` 读取并校验悟道核心参数；校验通过后缓存。
 * 2) 不做什么：不提供默认值、不做字段兜底、不兼容旧结构。
 *
 * 输入/输出：
 * - 输入：无。
 * - 输出：完整且合法的悟道配置对象。
 *
 * 数据流/状态流：
 * getInsightGrowthConfig() -> 读取 seeds 文件 -> JSON 解析 -> 字段校验 -> 返回缓存对象。
 *
 * 关键边界条件与坑点：
 * 1) 任意字段缺失或类型非法都会抛错，调用方必须显式处理失败。
 * 2) `bonus_pct_per_level` 要求在 (0, 1) 区间，防止把百分比写成 5 这类数量级错误。
 */
export const getInsightGrowthConfig = (): InsightGrowthConfig => {
  if (insightGrowthCache) return insightGrowthCache;

  const filePath = path.join(SEEDS_DIR, 'insight_growth.json');
  if (!fs.existsSync(filePath)) {
    throw new Error('insight_growth.json 不存在');
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: InsightGrowthFile;
  try {
    parsed = JSON.parse(raw) as InsightGrowthFile;
  } catch {
    throw new Error('insight_growth.json JSON 解析失败');
  }

  const unlockRealm = typeof parsed.unlock_realm === 'string' ? parsed.unlock_realm.trim() : '';
  if (!unlockRealm) {
    throw new Error('insight_growth.unlock_realm 非法');
  }

  const costStageLevels = Number(parsed.cost_stage_levels);
  if (!Number.isFinite(costStageLevels) || costStageLevels <= 0 || !Number.isInteger(costStageLevels)) {
    throw new Error('insight_growth.cost_stage_levels 非法');
  }

  const costStageBaseExp = Number(parsed.cost_stage_base_exp);
  if (!Number.isFinite(costStageBaseExp) || costStageBaseExp <= 0 || !Number.isInteger(costStageBaseExp)) {
    throw new Error('insight_growth.cost_stage_base_exp 非法');
  }

  const bonusPctPerLevel = Number(parsed.bonus_pct_per_level);
  if (!Number.isFinite(bonusPctPerLevel) || bonusPctPerLevel <= 0 || bonusPctPerLevel >= 1) {
    throw new Error('insight_growth.bonus_pct_per_level 非法');
  }

  insightGrowthCache = {
    unlock_realm: unlockRealm,
    cost_stage_levels: costStageLevels,
    cost_stage_base_exp: costStageBaseExp,
    bonus_pct_per_level: bonusPctPerLevel,
  };
  return insightGrowthCache;
};
