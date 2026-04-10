use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::error::AppError;

use super::realm::{get_realm_rank_one_based_strict, get_realm_rank_zero_based};
use super::seed::{list_seed_files_with_prefix, read_seed_json};

static DUNGEON_STATIC_CATALOG: OnceLock<Result<DungeonStaticCatalog, String>> = OnceLock::new();

const DUNGEON_TYPE_ORDER: [&str; 5] = ["material", "equipment", "trial", "challenge", "event"];
const COMMON_POOL_EXCLUDED_MULTIPLIER_IDS: [&str; 4] = [
    "dp-common-monster-elite",
    "dp-common-monster-boss",
    "dp-common-dungeon-boss-unbind",
    "dp-common-dungeon-boss-advanced-recruit-token",
];
const DUNGEON_REWARD_EXCLUDED_POOL_IDS: [&str; 2] = [
    "dp-common-dungeon-boss-unbind",
    "dp-common-dungeon-boss-advanced-recruit-token",
];
/**
 * 秘境静态索引。
 *
 * 作用：
 * 1. 做什么：一次性把 Node 权威的 `dungeon_*.json`、怪物、物品、掉落池等种子收敛成 `/api/dungeon/categories|list|preview` 可直接复用的只读索引。
 * 2. 做什么：把分类统计、列表筛选、预览阶段波次与掉落预览的高开销拼装前置到进程级缓存，避免每次请求重复遍历多份大 JSON。
 * 3. 不做什么：不读取数据库、不推导用户实例剩余次数，也不处理秘境创建/加入/开战等动态流程。
 *
 * 输入 / 输出：
 * - 输入：Node 后端种子目录中的秘境、怪物、物品、掉落池配置。
 * - 输出：只读 `DungeonStaticCatalog`，提供分类、列表与预览读取能力。
 *
 * 数据流 / 状态流：
 * - 首次命中 dungeon 只读接口 -> 本模块加载并解析所有种子 -> 构建分类/列表/预览索引 -> 后续请求直接复用内存结果。
 *
 * 复用设计说明：
 * - `/api/dungeon/categories`、`/api/dungeon/list`、`/api/dungeon/preview/:id` 共用同一份秘境定义与掉落预览索引，避免三个 handler 各自扫种子、各自做 realm 过滤与掉落倍率解释。
 * - 掉落池合并、怪物境界倍率、难度奖励倍率集中在这里，后续若补秘境详情面板或首屏静态预览，可直接复用，不必再复制一套 preview 规则。
 *
 * 关键边界条件与坑点：
 * 1. 所有 `enabled === false` 的定义、难度、关卡、波次、物品、怪物、掉落池都必须在索引阶段剔除，不能让路由层补过滤。
 * 2. `preview` 缺失指定难度时必须返回 Node 兼容的“空难度 + 空 stages/drop_*”结构，而不是直接 404；只有秘境本体不存在时才返回 `None`。
 */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DungeonCategoryDto {
    #[serde(rename = "type")]
    pub dungeon_type: String,
    pub label: String,
    pub count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonDefDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub dungeon_type: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub background: Option<String>,
    pub min_players: i32,
    pub max_players: i32,
    pub min_realm: Option<String>,
    pub recommended_realm: Option<String>,
    pub unlock_condition: Value,
    pub daily_limit: i32,
    pub weekly_limit: i32,
    pub stamina_cost: i32,
    pub time_limit_sec: i32,
    pub revive_limit: i32,
    pub tags: Value,
    pub sort_weight: i32,
    pub enabled: bool,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DungeonDifficultyPreviewDto {
    pub id: String,
    pub name: String,
    pub difficulty_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewDropEntryDto {
    pub item_id: String,
    pub mode: String,
    pub chance: Option<f64>,
    pub weight: Option<f64>,
    pub qty_min: i32,
    pub qty_max: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewMonsterDto {
    pub id: String,
    pub name: String,
    pub realm: Option<String>,
    pub level: i32,
    pub avatar: Option<String>,
    pub kind: Option<String>,
    pub count: i32,
    pub drop_pool_id: Option<String>,
    pub drop_preview: Vec<DungeonPreviewDropEntryDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewWaveDto {
    pub wave_index: i32,
    pub spawn_delay_sec: i32,
    pub monsters: Vec<DungeonPreviewMonsterDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewStageDto {
    pub id: String,
    pub stage_index: i32,
    pub name: String,
    #[serde(rename = "type")]
    pub stage_type: String,
    pub waves: Vec<DungeonPreviewWaveDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewDropItemDto {
    pub id: String,
    pub name: String,
    pub quality: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DungeonPreviewDropSourceDto {
    pub pool_id: String,
    pub from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DungeonPreviewDto {
    pub dungeon: Option<DungeonDefDto>,
    pub difficulty: Option<DungeonDifficultyPreviewDto>,
    pub entry: Option<Value>,
    pub stages: Vec<DungeonPreviewStageDto>,
    pub drop_items: Vec<DungeonPreviewDropItemDto>,
    pub drop_sources: Vec<DungeonPreviewDropSourceDto>,
}

#[derive(Debug, Clone, Default)]
pub struct DungeonListFilter {
    pub dungeon_type: Option<String>,
    pub keyword: Option<String>,
    pub realm: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DungeonStaticCatalog {
    categories: Vec<DungeonCategoryDto>,
    dungeons: Vec<DungeonDefDto>,
    previews_by_dungeon_id: BTreeMap<String, DungeonPreviewIndex>,
}

#[derive(Debug, Clone)]
struct DungeonPreviewIndex {
    dungeon: DungeonDefDto,
    by_rank: BTreeMap<i32, DungeonPreviewPrepared>,
}

#[derive(Debug, Clone)]
struct DungeonPreviewPrepared {
    difficulty: DungeonDifficultyPreviewDto,
    stages: Vec<DungeonPreviewStageDto>,
    drop_items: Vec<DungeonPreviewDropItemDto>,
    drop_sources: Vec<DungeonPreviewDropSourceDto>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedFile {
    items: Vec<ItemSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeed {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    quality: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    sub_category: Option<String>,
    effect_defs: Option<Vec<Value>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterSeed {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    realm: Option<String>,
    level: Option<i32>,
    avatar: Option<String>,
    kind: Option<String>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonSeedFile {
    dungeons: Option<Vec<DungeonSeedEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonSeedEntry {
    def: Option<DungeonDefSeed>,
    difficulties: Option<Vec<DungeonDifficultySeed>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonDefSeed {
    id: String,
    name: String,
    #[serde(rename = "type")]
    dungeon_type: String,
    category: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    background: Option<String>,
    min_players: Option<i32>,
    max_players: Option<i32>,
    min_realm: Option<String>,
    recommended_realm: Option<String>,
    unlock_condition: Option<Value>,
    daily_limit: Option<i32>,
    weekly_limit: Option<i32>,
    stamina_cost: Option<i32>,
    time_limit_sec: Option<i32>,
    revive_limit: Option<i32>,
    tags: Option<Value>,
    sort_weight: Option<i32>,
    enabled: Option<bool>,
    version: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonDifficultySeed {
    id: String,
    dungeon_id: Option<String>,
    name: Option<String>,
    difficulty_rank: Option<i32>,
    reward_mult: Option<f64>,
    first_clear_rewards: Option<Value>,
    enabled: Option<bool>,
    stages: Option<Vec<DungeonStageSeed>>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonStageSeed {
    id: String,
    difficulty_id: Option<String>,
    stage_index: Option<i32>,
    name: Option<String>,
    #[serde(rename = "type")]
    stage_type: Option<String>,
    waves: Option<Vec<DungeonWaveSeed>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonWaveSeed {
    id: Option<String>,
    wave_index: Option<i32>,
    spawn_delay_sec: Option<i32>,
    monsters: Option<Vec<DungeonWaveMonsterSeed>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DungeonWaveMonsterSeed {
    monster_def_id: Option<String>,
    count: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolSeedFile {
    pools: Vec<DropPoolSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolSeed {
    #[serde(default)]
    id: String,
    name: Option<String>,
    mode: Option<String>,
    common_pool_ids: Option<Vec<String>>,
    entries: Option<Vec<DropPoolEntrySeed>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolEntrySeed {
    item_def_id: String,
    chance: Option<f64>,
    weight: Option<f64>,
    chance_add_by_monster_realm: Option<f64>,
    qty_min: Option<i32>,
    qty_max: Option<i32>,
    qty_min_add_by_monster_realm: Option<f64>,
    qty_max_add_by_monster_realm: Option<f64>,
    qty_multiply_by_monster_realm: Option<f64>,
    show_in_ui: Option<bool>,
    sort_order: Option<i32>,
}

#[derive(Debug, Clone)]
struct ItemMeta {
    name: String,
    quality: Option<String>,
    icon: Option<String>,
    category: String,
    sub_category: String,
    effect_defs: Vec<Value>,
}

#[derive(Debug, Clone)]
struct MonsterMeta {
    name: String,
    realm: Option<String>,
    level: i32,
    avatar: Option<String>,
    kind: Option<String>,
    drop_pool_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedDropPool {
    id: String,
    mode: String,
    entries: Vec<ResolvedDropPoolEntry>,
}

#[derive(Debug, Clone)]
struct ResolvedDropPoolEntry {
    item_def_id: String,
    mode: String,
    chance: f64,
    weight: f64,
    chance_add_by_monster_realm: f64,
    qty_min: i32,
    qty_max: i32,
    qty_min_add_by_monster_realm: f64,
    qty_max_add_by_monster_realm: f64,
    qty_multiply_by_monster_realm: f64,
    source_type: String,
    source_pool_id: String,
    sort_order: i32,
}

pub fn get_dungeon_static_catalog() -> Result<&'static DungeonStaticCatalog, AppError> {
    match DUNGEON_STATIC_CATALOG
        .get_or_init(|| build_dungeon_static_catalog().map_err(|error| error.to_string()))
    {
        Ok(catalog) => Ok(catalog),
        Err(message) => Err(AppError::Config(message.clone())),
    }
}

impl DungeonStaticCatalog {
    pub fn categories(&self) -> &[DungeonCategoryDto] {
        &self.categories
    }

    pub fn list(&self, filter: &DungeonListFilter) -> Vec<DungeonDefDto> {
        let keyword = filter
            .keyword
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_lowercase());
        let realm = filter
            .realm
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let dungeon_type = filter
            .dungeon_type
            .as_deref()
            .map(str::trim)
            .filter(|value| is_supported_dungeon_type(value));

        self.dungeons
            .iter()
            .filter(|entry| {
                if let Some(dungeon_type) = dungeon_type {
                    if entry.dungeon_type != dungeon_type {
                        return false;
                    }
                }
                if let Some(keyword) = keyword.as_deref() {
                    let name = entry.name.to_lowercase();
                    let category = entry.category.as_deref().unwrap_or_default().to_lowercase();
                    if !name.contains(keyword) && !category.contains(keyword) {
                        return false;
                    }
                }
                if let Some(realm) = realm {
                    if let Some(min_realm) = entry.min_realm.as_deref() {
                        if !is_realm_sufficient(realm, min_realm) {
                            return false;
                        }
                    }
                }
                true
            })
            .cloned()
            .collect()
    }

    pub fn preview(&self, dungeon_id: &str, difficulty_rank: i32) -> Option<DungeonPreviewDto> {
        let entry = self.previews_by_dungeon_id.get(dungeon_id)?;
        let prepared = entry.by_rank.get(&difficulty_rank);
        Some(match prepared {
            Some(prepared) => DungeonPreviewDto {
                dungeon: Some(entry.dungeon.clone()),
                difficulty: Some(prepared.difficulty.clone()),
                entry: None,
                stages: prepared.stages.clone(),
                drop_items: prepared.drop_items.clone(),
                drop_sources: prepared.drop_sources.clone(),
            },
            None => DungeonPreviewDto {
                dungeon: Some(entry.dungeon.clone()),
                difficulty: None,
                entry: None,
                stages: Vec::new(),
                drop_items: Vec::new(),
                drop_sources: Vec::new(),
            },
        })
    }
}

fn build_dungeon_static_catalog() -> Result<DungeonStaticCatalog, AppError> {
    let item_meta_by_id = read_seed_json::<ItemSeedFile>("item_def.json")?
        .items
        .into_iter()
        .filter_map(|entry| {
            if !is_enabled(entry.enabled) {
                return None;
            }
            let item_id = entry.id.trim().to_string();
            let item_name = entry.name.trim().to_string();
            if item_id.is_empty() || item_name.is_empty() {
                return None;
            }
            (
                item_id,
                ItemMeta {
                    name: item_name,
                    quality: entry.quality,
                    icon: entry.icon,
                    category: normalize_token(entry.category.as_deref()),
                    sub_category: normalize_token(entry.sub_category.as_deref()),
                    effect_defs: entry.effect_defs.unwrap_or_default(),
                },
            )
                .into()
        })
        .collect::<HashMap<_, _>>();

    let monster_meta_by_id = read_seed_json::<MonsterSeedFile>("monster_def.json")?
        .monsters
        .into_iter()
        .filter_map(|entry| {
            if !is_enabled(entry.enabled) {
                return None;
            }
            let monster_id = entry.id.trim().to_string();
            let monster_name = entry.name.trim().to_string();
            if monster_id.is_empty() || monster_name.is_empty() {
                return None;
            }
            (
                monster_id,
                MonsterMeta {
                    name: monster_name,
                    realm: entry.realm,
                    level: entry.level.unwrap_or(0),
                    avatar: entry.avatar,
                    kind: entry.kind,
                    drop_pool_id: entry.drop_pool_id,
                },
            )
                .into()
        })
        .collect::<HashMap<_, _>>();

    let exclusive_pool_map = read_enabled_drop_pool_map("drop_pool.json")?;
    let common_pool_map = read_enabled_drop_pool_map("drop_pool_common.json")?;
    let mut dungeon_defs = Vec::<DungeonDefDto>::new();
    let mut previews_by_dungeon_id = BTreeMap::<String, DungeonPreviewIndex>::new();

    for file_name in list_seed_files_with_prefix("dungeon_")? {
        let seed_file = read_seed_json::<DungeonSeedFile>(&file_name)?;
        let entries = seed_file.dungeons.unwrap_or_default();
        for entry in entries {
            let Some(def_seed) = entry.def else {
                continue;
            };
            if !is_enabled(def_seed.enabled)
                || !is_supported_dungeon_type(def_seed.dungeon_type.as_str())
            {
                continue;
            }
            let dungeon = map_dungeon_definition(def_seed);
            let dungeon_id = dungeon.id.clone();
            dungeon_defs.push(dungeon.clone());

            let mut by_rank = BTreeMap::<i32, DungeonPreviewPrepared>::new();
            for difficulty_seed in entry.difficulties.unwrap_or_default() {
                if !is_enabled(difficulty_seed.enabled) {
                    continue;
                }
                let difficulty_rank = difficulty_seed.difficulty_rank.unwrap_or(1).max(1);
                let difficulty = DungeonDifficultyPreviewDto {
                    id: difficulty_seed.id.clone(),
                    name: difficulty_seed
                        .name
                        .clone()
                        .unwrap_or_else(|| difficulty_seed.id.clone()),
                    difficulty_rank,
                };
                let reward_multiplier =
                    resolve_dungeon_reward_multiplier(difficulty_seed.reward_mult.unwrap_or(1.0));
                let prepared = build_dungeon_preview_prepared(
                    &difficulty_seed,
                    &difficulty,
                    reward_multiplier,
                    &item_meta_by_id,
                    &monster_meta_by_id,
                    &exclusive_pool_map,
                    &common_pool_map,
                );
                by_rank.insert(difficulty_rank, prepared);
            }
            previews_by_dungeon_id.insert(dungeon_id, DungeonPreviewIndex { dungeon, by_rank });
        }
    }

    dungeon_defs.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| left.id.cmp(&right.id))
    });

    Ok(DungeonStaticCatalog {
        categories: build_dungeon_categories(&dungeon_defs),
        dungeons: dungeon_defs,
        previews_by_dungeon_id,
    })
}

fn build_dungeon_categories(dungeons: &[DungeonDefDto]) -> Vec<DungeonCategoryDto> {
    let mut counter = HashMap::<String, i32>::new();
    for dungeon in dungeons {
        *counter.entry(dungeon.dungeon_type.clone()).or_insert(0) += 1;
    }

    DUNGEON_TYPE_ORDER
        .into_iter()
        .map(|dungeon_type| DungeonCategoryDto {
            dungeon_type: dungeon_type.to_string(),
            label: dungeon_type_label(dungeon_type).to_string(),
            count: *counter.get(dungeon_type).unwrap_or(&0),
        })
        .collect()
}

fn build_dungeon_preview_prepared(
    difficulty_seed: &DungeonDifficultySeed,
    difficulty: &DungeonDifficultyPreviewDto,
    reward_multiplier: f64,
    item_meta_by_id: &HashMap<String, ItemMeta>,
    monster_meta_by_id: &HashMap<String, MonsterMeta>,
    exclusive_pool_map: &HashMap<String, DropPoolSeed>,
    common_pool_map: &HashMap<String, DropPoolSeed>,
) -> DungeonPreviewPrepared {
    let mut drop_items = Vec::<DungeonPreviewDropItemDto>::new();
    let mut drop_item_seen = HashSet::<String>::new();
    let mut monster_drop_pool_ids = BTreeSet::<String>::new();

    let mut stages = difficulty_seed
        .stages
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|stage| is_enabled(stage.enabled))
        .map(|stage| {
            let stage_id = stage.id.clone();
            let stage_name = stage
                .name
                .clone()
                .unwrap_or_else(|| format!("第{}关", stage.stage_index.unwrap_or(1).max(1)));
            let stage_type = stage
                .stage_type
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "battle".to_string());
            let waves = stage
                .waves
                .clone()
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .filter(|(_, wave)| is_enabled(wave.enabled))
                .map(|(index, wave)| {
                    let monsters = wave
                        .monsters
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|monster_seed| {
                            let monster_id = monster_seed.monster_def_id?.trim().to_string();
                            if monster_id.is_empty() {
                                return None;
                            }
                            let monster_meta = monster_meta_by_id.get(monster_id.as_str())?;
                            let mut drop_preview = Vec::<DungeonPreviewDropEntryDto>::new();
                            if let Some(drop_pool_id) = monster_meta.drop_pool_id.as_deref() {
                                monster_drop_pool_ids.insert(drop_pool_id.to_string());
                                if let Some(resolved_pool) = resolve_drop_pool(
                                    drop_pool_id,
                                    exclusive_pool_map,
                                    common_pool_map,
                                ) {
                                    for preview_entry in build_monster_drop_preview(
                                        &resolved_pool,
                                        monster_meta,
                                        reward_multiplier,
                                        item_meta_by_id,
                                    ) {
                                        if drop_item_seen.insert(preview_entry.0.id.clone()) {
                                            drop_items.push(preview_entry.0);
                                        }
                                        drop_preview.push(preview_entry.1);
                                    }
                                }
                            }
                            Some(DungeonPreviewMonsterDto {
                                id: monster_id,
                                name: monster_meta.name.clone(),
                                realm: monster_meta.realm.clone(),
                                level: monster_meta.level,
                                avatar: monster_meta.avatar.clone(),
                                kind: monster_meta.kind.clone(),
                                count: monster_seed.count.unwrap_or(1).max(1),
                                drop_pool_id: monster_meta.drop_pool_id.clone(),
                                drop_preview,
                            })
                        })
                        .collect::<Vec<_>>();

                    DungeonPreviewWaveDto {
                        wave_index: wave.wave_index.unwrap_or((index + 1) as i32).max(1),
                        spawn_delay_sec: wave.spawn_delay_sec.unwrap_or(0).max(0),
                        monsters,
                    }
                })
                .collect::<Vec<_>>();

            DungeonPreviewStageDto {
                id: stage_id,
                stage_index: stage.stage_index.unwrap_or(1).max(1),
                name: stage_name,
                stage_type,
                waves,
            }
        })
        .collect::<Vec<_>>();

    stages.sort_by(|left, right| {
        left.stage_index
            .cmp(&right.stage_index)
            .then_with(|| left.id.cmp(&right.id))
    });
    for stage in &mut stages {
        stage
            .waves
            .sort_by(|left, right| left.wave_index.cmp(&right.wave_index));
    }
    drop_items.sort_by(|left, right| left.id.cmp(&right.id));

    DungeonPreviewPrepared {
        difficulty: difficulty.clone(),
        stages,
        drop_items,
        drop_sources: build_dungeon_drop_sources(
            difficulty_seed,
            difficulty.name.as_str(),
            &monster_drop_pool_ids,
        ),
    }
}

fn build_monster_drop_preview(
    resolved_pool: &ResolvedDropPool,
    monster_meta: &MonsterMeta,
    reward_multiplier: f64,
    item_meta_by_id: &HashMap<String, ItemMeta>,
) -> Vec<(DungeonPreviewDropItemDto, DungeonPreviewDropEntryDto)> {
    let mut output = Vec::new();
    for entry in &resolved_pool.entries {
        let Some(item_meta) = item_meta_by_id.get(entry.item_def_id.as_str()) else {
            continue;
        };
        let adjusted_chance = if entry.mode == "prob" {
            let value = get_adjusted_chance(
                entry.chance,
                entry.source_type.as_str(),
                entry.source_pool_id.as_str(),
                monster_meta.kind.as_deref(),
                monster_meta.realm.as_deref(),
                entry.chance_add_by_monster_realm,
                reward_multiplier,
            );
            Some(value)
        } else {
            None
        };
        let adjusted_weight = if entry.mode == "weight" {
            Some(get_adjusted_weight(
                entry.weight,
                entry.source_type.as_str(),
                entry.source_pool_id.as_str(),
                monster_meta.kind.as_deref(),
                reward_multiplier,
            ))
        } else {
            None
        };
        let (qty_min, qty_max) = get_adjusted_drop_quantity_range(
            item_meta,
            entry,
            monster_meta.realm.as_deref(),
            monster_meta.kind.as_deref(),
            reward_multiplier,
        );
        output.push((
            DungeonPreviewDropItemDto {
                id: entry.item_def_id.clone(),
                name: item_meta.name.clone(),
                quality: item_meta.quality.clone(),
            },
            DungeonPreviewDropEntryDto {
                item_id: entry.item_def_id.clone(),
                mode: entry.mode.clone(),
                chance: adjusted_chance,
                weight: adjusted_weight,
                qty_min,
                qty_max,
            },
        ));
    }
    output
}

fn build_dungeon_drop_sources(
    difficulty_seed: &DungeonDifficultySeed,
    difficulty_name: &str,
    monster_drop_pool_ids: &BTreeSet<String>,
) -> Vec<DungeonPreviewDropSourceDto> {
    let mut drop_sources = monster_drop_pool_ids
        .iter()
        .map(|pool_id| DungeonPreviewDropSourceDto {
            pool_id: pool_id.clone(),
            from: "击杀掉落".to_string(),
        })
        .collect::<Vec<_>>();

    let first_clear_items = difficulty_seed
        .first_clear_rewards
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|rewards| rewards.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in first_clear_items {
        let Some(item_def_id) = item
            .as_object()
            .and_then(|value| value.get("item_def_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        drop_sources.push(DungeonPreviewDropSourceDto {
            pool_id: item_def_id.to_string(),
            from: format!("{difficulty_name}·首通"),
        });
    }

    drop_sources
}

fn read_enabled_drop_pool_map(file_name: &str) -> Result<HashMap<String, DropPoolSeed>, AppError> {
    Ok(read_seed_json::<DropPoolSeedFile>(file_name)?
        .pools
        .into_iter()
        .filter_map(|entry| {
            if !is_enabled(entry.enabled) {
                return None;
            }
            let pool_id = entry.id.trim().to_string();
            if pool_id.is_empty() {
                return None;
            }
            Some((pool_id, entry))
        })
        .collect())
}

fn resolve_drop_pool<'a>(
    pool_id: &str,
    exclusive_pool_map: &'a HashMap<String, DropPoolSeed>,
    common_pool_map: &'a HashMap<String, DropPoolSeed>,
) -> Option<ResolvedDropPool> {
    exclusive_pool_map
        .get(pool_id)
        .map(|exclusive_pool| build_resolved_drop_pool(exclusive_pool, common_pool_map))
}

fn build_resolved_drop_pool(
    exclusive_pool: &DropPoolSeed,
    common_pool_map: &HashMap<String, DropPoolSeed>,
) -> ResolvedDropPool {
    let mut entries_by_item_id = BTreeMap::<String, ResolvedDropPoolEntry>::new();

    for common_pool_id in exclusive_pool
        .common_pool_ids
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
    {
        let Some(common_pool) = common_pool_map.get(common_pool_id.as_str()) else {
            continue;
        };
        for entry in common_pool.entries.clone().unwrap_or_default() {
            let Some(normalized) =
                normalize_drop_pool_entry(entry, "common", common_pool_id.as_str())
            else {
                continue;
            };
            entries_by_item_id.insert(normalized.item_def_id.clone(), normalized);
        }
    }

    for entry in exclusive_pool.entries.clone().unwrap_or_default() {
        let Some(normalized) =
            normalize_drop_pool_entry(entry, "exclusive", exclusive_pool.id.as_str())
        else {
            continue;
        };
        entries_by_item_id.insert(normalized.item_def_id.clone(), normalized);
    }

    ResolvedDropPool {
        id: exclusive_pool.id.clone(),
        mode: normalize_drop_pool_mode(exclusive_pool.mode.as_deref()),
        entries: {
            let mut entries = entries_by_item_id.into_values().collect::<Vec<_>>();
            entries.sort_by(|left, right| {
                left.sort_order
                    .cmp(&right.sort_order)
                    .then_with(|| left.item_def_id.cmp(&right.item_def_id))
            });
            entries
        },
    }
}

fn normalize_drop_pool_entry(
    entry: DropPoolEntrySeed,
    source_type: &str,
    source_pool_id: &str,
) -> Option<ResolvedDropPoolEntry> {
    let item_def_id = entry.item_def_id.trim().to_string();
    if item_def_id.is_empty() {
        return None;
    }
    if entry.show_in_ui == Some(false) {
        return None;
    }
    let qty_min = entry.qty_min.unwrap_or(1).max(1);
    let qty_max = entry.qty_max.unwrap_or(qty_min).max(qty_min);
    Some(ResolvedDropPoolEntry {
        item_def_id,
        mode: if entry.weight.unwrap_or(0.0) > 0.0 {
            "weight".to_string()
        } else {
            "prob".to_string()
        },
        chance: entry.chance.unwrap_or(0.0).max(0.0),
        weight: entry.weight.unwrap_or(0.0).max(0.0),
        chance_add_by_monster_realm: entry.chance_add_by_monster_realm.unwrap_or(0.0).max(0.0),
        qty_min,
        qty_max,
        qty_min_add_by_monster_realm: entry.qty_min_add_by_monster_realm.unwrap_or(0.0).max(0.0),
        qty_max_add_by_monster_realm: entry
            .qty_max_add_by_monster_realm
            .unwrap_or(entry.qty_min_add_by_monster_realm.unwrap_or(0.0))
            .max(entry.qty_min_add_by_monster_realm.unwrap_or(0.0).max(0.0)),
        qty_multiply_by_monster_realm: {
            let value = entry.qty_multiply_by_monster_realm.unwrap_or(1.0);
            if value > 0.0 {
                value
            } else {
                1.0
            }
        },
        source_type: source_type.to_string(),
        source_pool_id: source_pool_id.to_string(),
        sort_order: entry.sort_order.unwrap_or(0).max(0),
    })
}

fn map_dungeon_definition(seed: DungeonDefSeed) -> DungeonDefDto {
    DungeonDefDto {
        id: seed.id,
        name: seed.name,
        dungeon_type: seed.dungeon_type,
        category: seed.category,
        description: seed.description,
        icon: seed.icon,
        background: seed.background,
        min_players: seed.min_players.unwrap_or(1),
        max_players: seed.max_players.unwrap_or(5),
        min_realm: seed.min_realm,
        recommended_realm: seed.recommended_realm,
        unlock_condition: seed
            .unlock_condition
            .unwrap_or(Value::Object(Default::default())),
        daily_limit: seed.daily_limit.unwrap_or(0),
        weekly_limit: seed.weekly_limit.unwrap_or(0),
        stamina_cost: seed.stamina_cost.unwrap_or(0),
        time_limit_sec: seed.time_limit_sec.unwrap_or(0),
        revive_limit: seed.revive_limit.unwrap_or(0),
        tags: seed.tags.unwrap_or(Value::Array(Vec::new())),
        sort_weight: seed.sort_weight.unwrap_or(0),
        enabled: true,
        version: seed.version.unwrap_or(1),
    }
}

fn normalize_drop_pool_mode(mode: Option<&str>) -> String {
    if mode == Some("weight") {
        "weight".to_string()
    } else {
        "prob".to_string()
    }
}

fn normalize_token(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

fn is_enabled(value: Option<bool>) -> bool {
    value != Some(false)
}

fn is_supported_dungeon_type(value: &str) -> bool {
    DUNGEON_TYPE_ORDER
        .iter()
        .any(|candidate| candidate == &value)
}

fn dungeon_type_label(value: &str) -> &'static str {
    match value {
        "material" => "材料秘境",
        "equipment" => "装备秘境",
        "trial" => "试炼秘境",
        "challenge" => "挑战秘境",
        "event" => "活动秘境",
        _ => "",
    }
}

fn resolve_dungeon_reward_multiplier(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        1.0
    }
}

fn is_realm_sufficient(current_realm: &str, min_realm: &str) -> bool {
    get_realm_rank_zero_based(Some(current_realm), None) as i32
        >= get_realm_rank_zero_based(Some(min_realm), None) as i32
}

fn normalize_monster_kind(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim().to_lowercase().as_str() {
        "elite" => "elite",
        "boss" => "boss",
        _ => "normal",
    }
}

fn get_common_pool_multiplier(
    source_type: &str,
    source_pool_id: &str,
    monster_kind: Option<&str>,
) -> f64 {
    if source_type != "common"
        || COMMON_POOL_EXCLUDED_MULTIPLIER_IDS
            .iter()
            .any(|candidate| candidate == &source_pool_id)
    {
        return 1.0;
    }

    match normalize_monster_kind(monster_kind) {
        "elite" => 4.0,
        "boss" => 6.0,
        _ => 2.0,
    }
}

fn get_dungeon_reward_rate_multiplier(source_pool_id: &str, reward_multiplier: f64) -> f64 {
    if DUNGEON_REWARD_EXCLUDED_POOL_IDS
        .iter()
        .any(|candidate| candidate == &source_pool_id)
    {
        1.0
    } else {
        reward_multiplier
    }
}

fn get_adjusted_chance(
    chance: f64,
    source_type: &str,
    source_pool_id: &str,
    monster_kind: Option<&str>,
    monster_realm: Option<&str>,
    chance_add_by_monster_realm: f64,
    reward_multiplier: f64,
) -> f64 {
    if !chance.is_finite() || chance <= 0.0 {
        return 0.0;
    }
    let multiplied = chance * get_common_pool_multiplier(source_type, source_pool_id, monster_kind);
    let realm_bonus =
        chance_add_by_monster_realm.max(0.0)
            * f64::from(get_realm_rank_zero_based(monster_realm, None) as i32);
    ((multiplied + realm_bonus)
        * get_dungeon_reward_rate_multiplier(source_pool_id, reward_multiplier))
    .clamp(0.0, 1.0)
}

fn get_adjusted_weight(
    weight: f64,
    source_type: &str,
    source_pool_id: &str,
    monster_kind: Option<&str>,
    reward_multiplier: f64,
) -> f64 {
    if !weight.is_finite() || weight <= 0.0 {
        return 0.0;
    }
    weight
        * get_common_pool_multiplier(source_type, source_pool_id, monster_kind)
        * get_dungeon_reward_rate_multiplier(source_pool_id, reward_multiplier)
}

fn should_apply_drop_quantity_multiplier(item_meta: &ItemMeta) -> bool {
    let has_learn_technique_effect = item_meta.effect_defs.iter().any(|entry| {
        entry
            .as_object()
            .and_then(|value| value.get("effect_type"))
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("learn_technique"))
    });

    item_meta.category != "equipment"
        && item_meta.sub_category != "technique"
        && item_meta.sub_category != "technique_book"
        && !has_learn_technique_effect
}

fn apply_monster_realm_drop_qty_multiplier(
    quantity: i32,
    multiplier: f64,
    monster_realm: Option<&str>,
) -> i32 {
    let base = quantity.max(1);
    if !multiplier.is_finite() || multiplier <= 0.0 {
        return base;
    }
    if (multiplier - 1.0).abs() < f64::EPSILON {
        return base;
    }

    let realm_rank = f64::from(get_realm_rank_one_based_strict(monster_realm, None).max(1));
    let effective_multiplier = if multiplier < 1.0 {
        multiplier
    } else {
        1.0 + (multiplier - 1.0) * realm_rank
    };
    (f64::from(base) * effective_multiplier).floor().max(1.0) as i32
}

fn get_adjusted_drop_quantity_range(
    item_meta: &ItemMeta,
    entry: &ResolvedDropPoolEntry,
    monster_realm: Option<&str>,
    monster_kind: Option<&str>,
    reward_multiplier: f64,
) -> (i32, i32) {
    let realm_rank = f64::from(get_realm_rank_zero_based(monster_realm, None) as i32);
    let base_min = (f64::from(entry.qty_min) + realm_rank * entry.qty_min_add_by_monster_realm)
        .floor()
        .max(1.0) as i32;
    let base_max = (f64::from(entry.qty_max) + realm_rank * entry.qty_max_add_by_monster_realm)
        .floor()
        .max(f64::from(base_min)) as i32;
    let should_apply_multiplier = should_apply_drop_quantity_multiplier(item_meta);
    let quantity_multiplier = if should_apply_multiplier {
        get_common_pool_multiplier(
            entry.source_type.as_str(),
            entry.source_pool_id.as_str(),
            monster_kind,
        )
    } else {
        1.0
    };
    let reward_rate_multiplier =
        get_dungeon_reward_rate_multiplier(entry.source_pool_id.as_str(), reward_multiplier);
    let min_after_pool = (f64::from(base_min) * quantity_multiplier).floor().max(1.0) as i32;
    let max_after_pool = (f64::from(base_max) * quantity_multiplier)
        .floor()
        .max(f64::from(min_after_pool)) as i32;
    let min_after_reward = if should_apply_multiplier {
        (f64::from(min_after_pool) * reward_rate_multiplier)
            .floor()
            .max(1.0) as i32
    } else {
        min_after_pool
    };
    let max_after_reward = if should_apply_multiplier {
        (f64::from(max_after_pool) * reward_rate_multiplier)
            .floor()
            .max(f64::from(min_after_reward)) as i32
    } else {
        max_after_pool
    };
    let final_min = apply_monster_realm_drop_qty_multiplier(
        min_after_reward,
        entry.qty_multiply_by_monster_realm,
        monster_realm,
    );
    let final_max = apply_monster_realm_drop_qty_multiplier(
        max_after_reward.max(final_min),
        entry.qty_multiply_by_monster_realm,
        monster_realm,
    );
    (final_min, final_max.max(final_min))
}
