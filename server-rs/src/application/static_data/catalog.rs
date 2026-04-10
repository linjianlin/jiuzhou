/**
 * 静态配置聚合索引。
 *
 * 作用：
 * 1. 做什么：一次性读取 Node 后端使用的种子文件，并预构建物品分类、功法详情、地图详情三类高频只读索引。
 * 2. 做什么：把 JSON 读取、排序规则、`id -> 实体` 查找与房间怪物名补全收敛到单一入口，避免每个路由重复解析大文件。
 * 3. 不做什么：不负责数据库查询、不处理动态战斗/背包状态，也不伪造 Node 端尚未迁移的业务副作用。
 *
 * 输入 / 输出：
 * - 输入：`server/src/data/seeds/` 目录下的静态 JSON 种子文件。
 * - 输出：进程级只读 `StaticDataCatalog`，供 `/api/info`、`/api/technique`、`/api/map` 路由复用。
 *
 * 数据流 / 状态流：
 * - 启动后首次命中静态路由 -> `OnceLock` 加载种子文件 -> 构建 taxonomy / technique / map 索引
 * - 后续请求直接复用内存索引，不再重复读磁盘或重复做线性扫描。
 *
 * 复用设计说明：
 * - `info/item-taxonomy`、`technique`、`map` 都依赖同一批种子文件；集中在这里后，字段映射、排序与名称索引只维护一份。
 * - 功法层级材料补全与地图怪物中文名补全都在索引构建阶段前置，路由层只负责协议输出，避免热路径重复加工。
 *
 * 关键边界条件与坑点：
 * 1. 静态配置文件缺失或 JSON 结构损坏时必须直接报错，不能悄悄吞掉并返回空列表。
 * 2. `enabled` 只有显式为 `false` 才视为禁用；这与 Node 现状一致，不能把缺省字段误判成禁用。
 */
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::shared::error::AppError;

use super::seed::read_seed_json;

static STATIC_DATA_CATALOG: OnceLock<Result<StaticDataCatalog, String>> = OnceLock::new();

const CATEGORY_LABEL_FALLBACK: [(&str, &str); 6] = [
    ("consumable", "消耗品"),
    ("material", "材料"),
    ("gem", "宝石"),
    ("equipment", "装备"),
    ("quest", "任务"),
    ("other", "其他"),
];

const CATEGORY_PREFERRED_ORDER: [&str; 6] = [
    "consumable",
    "material",
    "gem",
    "equipment",
    "quest",
    "other",
];

const SUB_CATEGORY_LABEL_FALLBACK: [(&str, &str); 28] = [
    ("sword", "剑"),
    ("blade", "刀"),
    ("staff", "法杖"),
    ("shield", "盾牌"),
    ("helmet", "头盔"),
    ("hat", "帽子"),
    ("robe", "法袍"),
    ("gloves", "手套"),
    ("gauntlets", "臂甲"),
    ("pants", "下装"),
    ("legguards", "护腿"),
    ("ring", "戒指"),
    ("necklace", "项链"),
    ("talisman", "法宝（护符）"),
    ("mirror", "宝镜"),
    ("accessory", "饰品"),
    ("armor", "护甲"),
    ("battle_pass", "战令道具"),
    ("bone", "骨材"),
    ("box", "宝箱"),
    ("breakthrough", "突破道具"),
    ("collect", "采集物"),
    ("egg", "蛋类"),
    ("enhance", "强化道具"),
    ("essence", "精华"),
    ("forge", "锻造材料"),
    ("function", "功能道具"),
    ("gem_attack", "攻击宝石"),
];

const EXTRA_SUB_CATEGORY_LABEL_FALLBACK: [(&str, &str); 14] = [
    ("gem_defense", "防御宝石"),
    ("gem_survival", "生存宝石"),
    ("gem_all", "通用宝石"),
    ("herb", "灵草"),
    ("key", "钥匙"),
    ("leather", "皮革"),
    ("month_card", "月卡道具"),
    ("object", "杂项道具"),
    ("ore", "矿石"),
    ("pill", "丹药"),
    ("relic", "遗物"),
    ("scroll", "卷轴"),
    ("technique", "功法材料"),
    ("technique_book", "功法书"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ItemTaxonomyOptionDto {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StaticItemMetaDto {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ItemTaxonomyCategoryDto {
    pub all: ItemTaxonomyOptionDto,
    pub options: Vec<ItemTaxonomyOptionDto>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ItemTaxonomySubCategoryDto {
    pub options: Vec<ItemTaxonomyOptionDto>,
    pub labels: BTreeMap<String, String>,
    #[serde(rename = "byCategory")]
    pub by_category: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameItemTaxonomyDto {
    pub categories: ItemTaxonomyCategoryDto,
    #[serde(rename = "subCategories")]
    pub sub_categories: ItemTaxonomySubCategoryDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TechniqueDefDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub technique_type: String,
    pub quality: String,
    pub quality_rank: i32,
    pub max_layer: i32,
    pub required_realm: String,
    pub attribute_type: String,
    pub attribute_element: String,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub long_desc: Option<String>,
    pub icon: Option<String>,
    pub obtain_type: Option<String>,
    pub obtain_hint: Vec<String>,
    pub sort_weight: i32,
    pub version: i32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TechniqueLayerCostMaterialDto {
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub qty: i32,
    #[serde(rename = "itemName", skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(rename = "itemIcon", skip_serializing_if = "Option::is_none")]
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TechniqueLayerDto {
    pub technique_id: String,
    pub layer: i32,
    pub cost_spirit_stones: i32,
    pub cost_exp: i32,
    pub cost_materials: Vec<TechniqueLayerCostMaterialDto>,
    pub passives: Vec<Value>,
    pub unlock_skill_ids: Vec<String>,
    pub upgrade_skill_ids: Vec<String>,
    pub required_realm: Option<String>,
    pub required_quest_id: Option<String>,
    pub layer_desc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillDefDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub source_type: String,
    pub source_id: Option<String>,
    pub cost_lingqi: i32,
    pub cost_lingqi_rate: f64,
    pub cost_qixue: i32,
    pub cost_qixue_rate: f64,
    pub cooldown: i32,
    pub target_type: String,
    pub target_count: i32,
    pub damage_type: Option<String>,
    pub element: String,
    pub effects: Vec<Value>,
    pub trigger_type: String,
    pub conditions: Option<Value>,
    pub ai_priority: i32,
    pub ai_conditions: Option<Value>,
    pub upgrades: Value,
    pub sort_weight: i32,
    pub version: i32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TechniqueDetailDto {
    pub technique: TechniqueDefDto,
    pub layers: Vec<TechniqueLayerDto>,
    pub skills: Vec<SkillDefDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorldMapAreaDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorldMapDto {
    #[serde(rename = "mapName")]
    pub map_name: String,
    pub areas: Vec<WorldMapAreaDto>,
    pub connections: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapMonsterDto {
    pub monster_def_id: String,
    pub count: i32,
    pub respawn_sec: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapConnectionDto {
    pub direction: String,
    pub target_room_id: String,
    pub target_map_id: Option<String>,
    pub req_item_id: Option<String>,
    pub req_realm_min: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapResourceDto {
    pub resource_id: String,
    pub count: i32,
    pub respawn_sec: Option<i32>,
    pub collect_limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapItemDto {
    pub item_def_id: String,
    pub once: Option<bool>,
    pub chance: Option<f64>,
    pub req_quest_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapPortalDto {
    pub target_map_id: String,
    pub target_room_id: String,
    pub name: String,
    pub req_realm_min: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapEventDto {
    pub event_id: String,
    pub trigger: String,
    pub once: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapRoomDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub position: Option<Value>,
    pub room_type: Option<String>,
    pub connections: Option<Vec<MapConnectionDto>>,
    pub npcs: Option<Vec<String>>,
    pub monsters: Option<Vec<MapMonsterDto>>,
    pub resources: Option<Vec<MapResourceDto>>,
    pub items: Option<Vec<MapItemDto>>,
    pub portals: Option<Vec<MapPortalDto>>,
    pub events: Option<Vec<MapEventDto>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapDefDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub background_image: Option<String>,
    pub map_type: String,
    pub parent_map_id: Option<String>,
    pub world_position: Option<Value>,
    pub region: Option<String>,
    pub req_realm_min: Option<String>,
    pub req_level_min: i32,
    pub req_quest_id: Option<String>,
    pub req_item_id: Option<String>,
    pub safe_zone: bool,
    pub pk_mode: Option<String>,
    pub revive_map_id: Option<String>,
    pub revive_room_id: Option<String>,
    pub rooms: Vec<MapRoomDto>,
    pub sort_weight: i32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MapSummaryDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub background_image: Option<String>,
    pub map_type: String,
    pub region: Option<String>,
    pub req_level_min: i32,
    pub req_realm_min: Option<String>,
    pub sort_weight: i32,
}

#[derive(Debug, Clone)]
pub struct MapDetailDto {
    pub map: MapDefDto,
    pub rooms: Vec<MapRoomDto>,
    rooms_by_id: BTreeMap<String, MapRoomDto>,
}

#[derive(Debug, Clone)]
pub struct StaticDataCatalog {
    item_taxonomy: GameItemTaxonomyDto,
    item_meta_by_id: BTreeMap<String, StaticItemMetaDto>,
    skill_by_id: BTreeMap<String, SkillDefDto>,
    techniques: Vec<TechniqueDefDto>,
    technique_details_by_id: BTreeMap<String, TechniqueDetailDto>,
    world_map: WorldMapDto,
    maps: Vec<MapSummaryDto>,
    map_details_by_id: BTreeMap<String, MapDetailDto>,
}

impl StaticDataCatalog {
    pub fn item_taxonomy(&self) -> &GameItemTaxonomyDto {
        &self.item_taxonomy
    }

    pub fn item_meta(&self, item_id: &str) -> Option<&StaticItemMetaDto> {
        self.item_meta_by_id.get(item_id)
    }

    pub fn skill(&self, skill_id: &str) -> Option<&SkillDefDto> {
        self.skill_by_id.get(skill_id)
    }

    pub fn techniques(&self) -> &[TechniqueDefDto] {
        &self.techniques
    }

    pub fn technique_detail(&self, technique_id: &str) -> Option<&TechniqueDetailDto> {
        self.technique_details_by_id.get(technique_id)
    }

    pub fn world_map(&self) -> &WorldMapDto {
        &self.world_map
    }

    pub fn maps(&self) -> &[MapSummaryDto] {
        &self.maps
    }

    pub fn map_detail(&self, map_id: &str) -> Option<&MapDetailDto> {
        self.map_details_by_id.get(map_id)
    }
}

impl MapDetailDto {
    pub fn room(&self, room_id: &str) -> Option<&MapRoomDto> {
        self.rooms_by_id.get(room_id)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedFile {
    items: Vec<ItemDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemDefinitionSeed {
    id: String,
    name: String,
    category: Option<String>,
    sub_category: Option<String>,
    quality: Option<String>,
    icon: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueSeedFile {
    techniques: Vec<TechniqueDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueDefinitionSeed {
    id: String,
    code: Option<String>,
    name: String,
    #[serde(rename = "type")]
    technique_type: String,
    quality: String,
    max_layer: Option<i32>,
    required_realm: Option<String>,
    attribute_type: Option<String>,
    attribute_element: Option<String>,
    tags: Option<Vec<String>>,
    description: Option<String>,
    long_desc: Option<String>,
    icon: Option<String>,
    obtain_type: Option<String>,
    obtain_hint: Option<Vec<String>>,
    sort_weight: Option<i32>,
    version: Option<i32>,
    enabled: Option<bool>,
    usage_scope: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueLayerSeedFile {
    layers: Vec<TechniqueLayerDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueLayerDefinitionSeed {
    technique_id: String,
    layer: i32,
    cost_spirit_stones: Option<i32>,
    cost_exp: Option<i32>,
    cost_materials: Option<Vec<TechniqueLayerCostMaterialSeed>>,
    passives: Option<Vec<Value>>,
    unlock_skill_ids: Option<Vec<String>>,
    upgrade_skill_ids: Option<Vec<String>>,
    required_realm: Option<String>,
    required_quest_id: Option<String>,
    layer_desc: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueLayerCostMaterialSeed {
    #[serde(rename = "itemId")]
    item_id: String,
    qty: i32,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillSeedFile {
    skills: Vec<SkillDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillDefinitionSeed {
    id: String,
    code: Option<String>,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    source_type: String,
    source_id: Option<String>,
    cost_lingqi: Option<i32>,
    cost_lingqi_rate: Option<f64>,
    cost_qixue: Option<i32>,
    cost_qixue_rate: Option<f64>,
    cooldown: Option<i32>,
    target_type: String,
    target_count: Option<i32>,
    damage_type: Option<String>,
    element: Option<String>,
    effects: Option<Vec<Value>>,
    trigger_type: Option<String>,
    conditions: Option<Value>,
    ai_priority: Option<i32>,
    ai_conditions: Option<Value>,
    upgrades: Option<Value>,
    sort_weight: Option<i32>,
    version: Option<i32>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterDefinitionSeed {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MapSeedFile {
    maps: Vec<MapDefinitionSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct MapDefinitionSeed {
    id: String,
    code: Option<String>,
    name: String,
    description: Option<String>,
    background_image: Option<String>,
    map_type: Option<String>,
    parent_map_id: Option<String>,
    world_position: Option<Value>,
    region: Option<String>,
    req_realm_min: Option<String>,
    req_level_min: Option<i32>,
    req_quest_id: Option<String>,
    req_item_id: Option<String>,
    safe_zone: Option<bool>,
    pk_mode: Option<String>,
    revive_map_id: Option<String>,
    revive_room_id: Option<String>,
    rooms: Option<Vec<MapRoomDto>>,
    sort_weight: Option<i32>,
    enabled: Option<bool>,
}

pub fn get_static_data_catalog() -> Result<&'static StaticDataCatalog, AppError> {
    match STATIC_DATA_CATALOG
        .get_or_init(|| build_static_data_catalog().map_err(|error| error.to_string()))
    {
        Ok(catalog) => Ok(catalog),
        Err(message) => Err(AppError::Config(message.clone())),
    }
}

fn build_static_data_catalog() -> Result<StaticDataCatalog, AppError> {
    let items = read_seed_json::<ItemSeedFile>("item_def.json")?.items;
    let techniques = read_seed_json::<TechniqueSeedFile>("technique_def.json")?.techniques;
    let layers = read_seed_json::<TechniqueLayerSeedFile>("technique_layer.json")?.layers;
    let skills = read_seed_json::<SkillSeedFile>("skill_def.json")?.skills;
    let map_definitions = read_seed_json::<MapSeedFile>("map_def.json")?.maps;
    let monsters = read_seed_json::<MonsterSeedFile>("monster_def.json")?.monsters;

    let item_taxonomy = build_item_taxonomy(&items);
    let item_meta_by_id = build_item_meta_index(&items);
    let skill_by_id = build_skill_index(&skills);
    let technique_dtos = build_technique_list(&techniques);
    let technique_details_by_id =
        build_technique_detail_index(&techniques, &layers, &skills, &item_meta_by_id);
    let monster_name_by_id = monsters
        .into_iter()
        .map(|monster| (monster.id, monster.name))
        .collect::<HashMap<_, _>>();
    let world_map = build_world_map();
    let maps = build_enabled_map_summaries(&map_definitions);
    let map_details_by_id = build_map_detail_index(&map_definitions, &monster_name_by_id);

    Ok(StaticDataCatalog {
        item_taxonomy,
        item_meta_by_id,
        skill_by_id,
        techniques: technique_dtos,
        technique_details_by_id,
        world_map,
        maps,
        map_details_by_id,
    })
}

fn build_item_taxonomy(items: &[ItemDefinitionSeed]) -> GameItemTaxonomyDto {
    let category_labels_fallback = CATEGORY_LABEL_FALLBACK
        .into_iter()
        .collect::<HashMap<_, _>>();
    let mut sub_category_labels_fallback = SUB_CATEGORY_LABEL_FALLBACK
        .into_iter()
        .collect::<HashMap<_, _>>();
    sub_category_labels_fallback.extend(EXTRA_SUB_CATEGORY_LABEL_FALLBACK);

    let mut category_set = BTreeSet::new();
    let mut sub_category_labels = BTreeMap::new();
    let mut sub_category_by_category = BTreeMap::from([("all".to_string(), Vec::<String>::new())]);

    for item in items.iter().filter(|item| is_enabled(item.enabled)) {
        let category = normalize_token(item.category.as_deref());
        if !category.is_empty() {
            category_set.insert(category.clone());
            sub_category_by_category
                .entry(category.clone())
                .or_insert_with(Vec::new);
        }

        let sub_category = normalize_token(item.sub_category.as_deref());
        if sub_category.is_empty() {
            continue;
        }

        sub_category_labels
            .entry(sub_category.clone())
            .or_insert_with(|| {
                sub_category_labels_fallback
                    .get(sub_category.as_str())
                    .copied()
                    .unwrap_or(sub_category.as_str())
                    .to_string()
            });
        push_unique(
            sub_category_by_category
                .entry("all".to_string())
                .or_insert_with(Vec::new),
            &sub_category,
        );
        if !category.is_empty() {
            push_unique(
                sub_category_by_category
                    .entry(category.clone())
                    .or_insert_with(Vec::new),
                &sub_category,
            );
        }
    }

    let mut category_values = category_set.into_iter().collect::<Vec<_>>();
    category_values.sort_by(|left, right| compare_category_order(left, right));

    let mut category_labels = BTreeMap::from([("all".to_string(), "全部".to_string())]);
    for category in &category_values {
        let label = category_labels_fallback
            .get(category.as_str())
            .copied()
            .unwrap_or(category.as_str())
            .to_string();
        category_labels.insert(category.clone(), label);
        sub_category_by_category
            .entry(category.clone())
            .or_insert_with(Vec::new);
    }

    let category_options = category_values
        .iter()
        .map(|value| ItemTaxonomyOptionDto {
            value: value.clone(),
            label: category_labels
                .get(value)
                .cloned()
                .unwrap_or_else(|| value.clone()),
        })
        .collect::<Vec<_>>();

    let mut sub_category_options = sub_category_labels
        .iter()
        .map(|(value, label)| ItemTaxonomyOptionDto {
            value: value.clone(),
            label: label.clone(),
        })
        .collect::<Vec<_>>();
    sub_category_options.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.value.cmp(&right.value))
    });

    GameItemTaxonomyDto {
        categories: ItemTaxonomyCategoryDto {
            all: ItemTaxonomyOptionDto {
                value: "all".to_string(),
                label: "全部".to_string(),
            },
            options: category_options,
            labels: category_labels,
        },
        sub_categories: ItemTaxonomySubCategoryDto {
            options: sub_category_options,
            labels: sub_category_labels,
            by_category: sub_category_by_category,
        },
    }
}

fn build_item_meta_index(
    items: &[ItemDefinitionSeed],
) -> BTreeMap<String, StaticItemMetaDto> {
    items
        .iter()
        .filter(|item| is_enabled(item.enabled))
        .map(|item| {
            (
                item.id.clone(),
                StaticItemMetaDto {
                    id: item.id.clone(),
                    name: item.name.clone(),
                    icon: item.icon.clone(),
                },
            )
        })
        .collect()
}

fn build_skill_index(skills: &[SkillDefinitionSeed]) -> BTreeMap<String, SkillDefDto> {
    skills
        .iter()
        .filter(|skill| is_enabled(skill.enabled))
        .map(|skill| (skill.id.clone(), map_skill_definition(skill)))
        .collect()
}

fn build_technique_list(techniques: &[TechniqueDefinitionSeed]) -> Vec<TechniqueDefDto> {
    let mut output = techniques
        .iter()
        .filter(|technique| is_enabled(technique.enabled))
        .filter(|technique| is_character_visible_technique(technique.usage_scope.as_deref()))
        .map(map_technique_definition)
        .collect::<Vec<_>>();
    output.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| right.quality_rank.cmp(&left.quality_rank))
            .then_with(|| left.id.cmp(&right.id))
    });
    output
}

fn build_technique_detail_index(
    techniques: &[TechniqueDefinitionSeed],
    layers: &[TechniqueLayerDefinitionSeed],
    skills: &[SkillDefinitionSeed],
    item_meta_by_id: &BTreeMap<String, StaticItemMetaDto>,
) -> BTreeMap<String, TechniqueDetailDto> {
    let technique_by_id = techniques
        .iter()
        .filter(|technique| is_enabled(technique.enabled))
        .filter(|technique| is_character_visible_technique(technique.usage_scope.as_deref()))
        .map(|technique| (technique.id.clone(), map_technique_definition(technique)))
        .collect::<BTreeMap<_, _>>();

    let mut layers_by_technique_id = BTreeMap::<String, Vec<TechniqueLayerDto>>::new();
    for layer in layers.iter().filter(|layer| is_enabled(layer.enabled)) {
        if !technique_by_id.contains_key(layer.technique_id.as_str()) {
            continue;
        }
        layers_by_technique_id
            .entry(layer.technique_id.clone())
            .or_default()
            .push(map_technique_layer_definition(layer, item_meta_by_id));
    }
    for layers in layers_by_technique_id.values_mut() {
        layers.sort_by(|left, right| left.layer.cmp(&right.layer));
    }

    let mut skills_by_technique_id = BTreeMap::<String, Vec<SkillDefDto>>::new();
    for skill in skills
        .iter()
        .filter(|skill| is_enabled(skill.enabled))
        .filter(|skill| skill.source_type == "technique")
    {
        let Some(source_id) = skill.source_id.as_deref() else {
            continue;
        };
        if !technique_by_id.contains_key(source_id) {
            continue;
        }
        skills_by_technique_id
            .entry(source_id.to_string())
            .or_default()
            .push(map_skill_definition(skill));
    }
    for skills in skills_by_technique_id.values_mut() {
        skills.sort_by(|left, right| {
            right
                .sort_weight
                .cmp(&left.sort_weight)
                .then_with(|| left.id.cmp(&right.id))
        });
    }

    technique_by_id
        .into_iter()
        .map(|(technique_id, technique)| {
            (
                technique_id.clone(),
                TechniqueDetailDto {
                    technique,
                    layers: apply_preview_visibility(
                        layers_by_technique_id
                            .remove(&technique_id)
                            .unwrap_or_default(),
                    ),
                    skills: skills_by_technique_id
                        .remove(&technique_id)
                        .unwrap_or_default(),
                },
            )
        })
        .collect()
}

fn build_enabled_map_summaries(maps: &[MapDefinitionSeed]) -> Vec<MapSummaryDto> {
    let mut output = maps
        .iter()
        .filter(|map| is_enabled(map.enabled))
        .map(|map| MapSummaryDto {
            id: map.id.clone(),
            code: map.code.clone(),
            name: map.name.clone(),
            description: map.description.clone(),
            background_image: map.background_image.clone(),
            map_type: map.map_type.clone().unwrap_or_else(|| "field".to_string()),
            region: map.region.clone(),
            req_level_min: map.req_level_min.unwrap_or(0),
            req_realm_min: map.req_realm_min.clone(),
            sort_weight: map.sort_weight.unwrap_or(0),
        })
        .collect::<Vec<_>>();
    output.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| left.id.cmp(&right.id))
    });
    output
}

fn build_map_detail_index(
    maps: &[MapDefinitionSeed],
    monster_name_by_id: &HashMap<String, String>,
) -> BTreeMap<String, MapDetailDto> {
    maps.iter()
        .filter(|map| is_enabled(map.enabled))
        .map(|map| {
            let rooms = map
                .rooms
                .clone()
                .unwrap_or_default()
                .into_iter()
                .map(|room| enrich_room_monster_names(room, monster_name_by_id))
                .collect::<Vec<_>>();
            let rooms_by_id = rooms
                .iter()
                .cloned()
                .map(|room| (room.id.clone(), room))
                .collect::<BTreeMap<_, _>>();
            let map_detail = MapDetailDto {
                map: MapDefDto {
                    id: map.id.clone(),
                    code: map.code.clone(),
                    name: map.name.clone(),
                    description: map.description.clone(),
                    background_image: map.background_image.clone(),
                    map_type: map.map_type.clone().unwrap_or_else(|| "field".to_string()),
                    parent_map_id: map.parent_map_id.clone(),
                    world_position: map.world_position.clone(),
                    region: map.region.clone(),
                    req_realm_min: map.req_realm_min.clone(),
                    req_level_min: map.req_level_min.unwrap_or(0),
                    req_quest_id: map.req_quest_id.clone(),
                    req_item_id: map.req_item_id.clone(),
                    safe_zone: map.safe_zone.unwrap_or(false),
                    pk_mode: map.pk_mode.clone(),
                    revive_map_id: map.revive_map_id.clone(),
                    revive_room_id: map.revive_room_id.clone(),
                    rooms: map.rooms.clone().unwrap_or_default(),
                    sort_weight: map.sort_weight.unwrap_or(0),
                    enabled: is_enabled(map.enabled),
                },
                rooms,
                rooms_by_id,
            };
            (map.id.clone(), map_detail)
        })
        .collect()
}

fn build_world_map() -> WorldMapDto {
    let all_positions = ["NW", "N", "NE", "W", "C", "E", "SW", "S", "SE"];
    let position_coord = HashMap::from([
        ("NW", (-1, 1)),
        ("N", (0, 1)),
        ("NE", (1, 1)),
        ("W", (-1, 0)),
        ("C", (0, 0)),
        ("E", (1, 0)),
        ("SW", (-1, -1)),
        ("S", (0, -1)),
        ("SE", (1, -1)),
    ]);
    let coord_to_position = position_coord
        .iter()
        .map(|(position, coord)| (format!("{},{}", coord.0, coord.1), (*position).to_string()))
        .collect::<HashMap<_, _>>();

    let areas = all_positions
        .iter()
        .map(|position| WorldMapAreaDto {
            id: (*position).to_string(),
            name: (*position).to_string(),
            description: String::new(),
            level: "Lv.1".to_string(),
        })
        .collect::<Vec<_>>();

    let mut added = BTreeSet::new();
    let mut connections = Vec::new();
    for position in all_positions {
        let (x, y) = position_coord.get(position).copied().unwrap_or((0, 0));
        for neighbor in [(x, y + 1), (x, y - 1), (x - 1, y), (x + 1, y)] {
            let Some(other) =
                coord_to_position.get(format!("{},{}", neighbor.0, neighbor.1).as_str())
            else {
                continue;
            };
            let (left, right) = if position < other.as_str() {
                (position.to_string(), other.clone())
            } else {
                (other.clone(), position.to_string())
            };
            let edge_key = format!("{left}-{right}");
            if added.insert(edge_key) {
                connections.push((left, right));
            }
        }
    }

    WorldMapDto {
        map_name: "九州大陆".to_string(),
        areas,
        connections,
    }
}

fn map_technique_definition(entry: &TechniqueDefinitionSeed) -> TechniqueDefDto {
    TechniqueDefDto {
        id: entry.id.clone(),
        code: entry.code.clone(),
        name: entry.name.clone(),
        technique_type: entry.technique_type.clone(),
        quality: entry.quality.clone(),
        quality_rank: resolve_quality_rank(entry.quality.as_str()),
        max_layer: entry.max_layer.unwrap_or(1),
        required_realm: entry
            .required_realm
            .clone()
            .unwrap_or_else(|| "凡人".to_string()),
        attribute_type: entry
            .attribute_type
            .clone()
            .unwrap_or_else(|| "physical".to_string()),
        attribute_element: entry
            .attribute_element
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        tags: entry.tags.clone().unwrap_or_default(),
        description: entry.description.clone(),
        long_desc: entry.long_desc.clone(),
        icon: entry.icon.clone(),
        obtain_type: entry.obtain_type.clone(),
        obtain_hint: entry.obtain_hint.clone().unwrap_or_default(),
        sort_weight: entry.sort_weight.unwrap_or(0),
        version: entry.version.unwrap_or(1),
        enabled: true,
    }
}

fn map_technique_layer_definition(
    entry: &TechniqueLayerDefinitionSeed,
    item_meta_by_id: &BTreeMap<String, StaticItemMetaDto>,
) -> TechniqueLayerDto {
    TechniqueLayerDto {
        technique_id: entry.technique_id.clone(),
        layer: entry.layer,
        cost_spirit_stones: entry.cost_spirit_stones.unwrap_or(0),
        cost_exp: entry.cost_exp.unwrap_or(0),
        cost_materials: entry
            .cost_materials
            .clone()
            .unwrap_or_default()
            .into_iter()
            .map(|material| {
                let item_meta = item_meta_by_id.get(material.item_id.as_str());
                TechniqueLayerCostMaterialDto {
                    item_id: material.item_id,
                    qty: material.qty,
                    item_name: item_meta.map(|meta| meta.name.clone()),
                    item_icon: item_meta.and_then(|meta| meta.icon.clone()),
                }
            })
            .collect(),
        passives: entry.passives.clone().unwrap_or_default(),
        unlock_skill_ids: entry.unlock_skill_ids.clone().unwrap_or_default(),
        upgrade_skill_ids: entry.upgrade_skill_ids.clone().unwrap_or_default(),
        required_realm: entry.required_realm.clone(),
        required_quest_id: entry.required_quest_id.clone(),
        layer_desc: entry.layer_desc.clone(),
    }
}

fn map_skill_definition(entry: &SkillDefinitionSeed) -> SkillDefDto {
    let effects = entry.effects.clone().unwrap_or_default();
    SkillDefDto {
        id: entry.id.clone(),
        code: entry.code.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        icon: entry.icon.clone(),
        source_type: entry.source_type.clone(),
        source_id: entry.source_id.clone(),
        cost_lingqi: entry.cost_lingqi.unwrap_or(0),
        cost_lingqi_rate: entry.cost_lingqi_rate.unwrap_or(0.0),
        cost_qixue: entry.cost_qixue.unwrap_or(0),
        cost_qixue_rate: entry.cost_qixue_rate.unwrap_or(0.0),
        cooldown: entry.cooldown.unwrap_or(0),
        target_type: entry.target_type.clone(),
        target_count: entry.target_count.unwrap_or(1),
        damage_type: entry.damage_type.clone(),
        element: entry.element.clone().unwrap_or_else(|| "none".to_string()),
        trigger_type: resolve_skill_trigger_type(entry.trigger_type.as_deref(), &effects),
        effects,
        conditions: entry.conditions.clone(),
        ai_priority: entry.ai_priority.unwrap_or(50),
        ai_conditions: entry.ai_conditions.clone(),
        upgrades: entry
            .upgrades
            .clone()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        sort_weight: entry.sort_weight.unwrap_or(0),
        version: entry.version.unwrap_or(1),
        enabled: true,
    }
}

fn enrich_room_monster_names(
    mut room: MapRoomDto,
    monster_name_by_id: &HashMap<String, String>,
) -> MapRoomDto {
    if let Some(monsters) = room.monsters.as_mut() {
        for monster in monsters {
            monster.name = monster_name_by_id
                .get(monster.monster_def_id.as_str())
                .cloned()
                .or_else(|| Some(monster.monster_def_id.clone()));
        }
    }
    room
}

fn apply_preview_visibility(layers: Vec<TechniqueLayerDto>) -> Vec<TechniqueLayerDto> {
    layers
        .into_iter()
        .map(|mut layer| {
            layer.cost_spirit_stones = 0;
            layer.cost_exp = 0;
            layer.cost_materials.clear();
            layer.passives.clear();
            layer.unlock_skill_ids.clear();
            layer.upgrade_skill_ids.clear();
            layer
        })
        .collect()
}

fn is_character_visible_technique(usage_scope: Option<&str>) -> bool {
    usage_scope.unwrap_or("character_only") != "partner_only"
}

fn resolve_quality_rank(quality: &str) -> i32 {
    match quality.trim() {
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 1,
    }
}

fn resolve_skill_trigger_type(trigger_type: Option<&str>, effects: &[Value]) -> String {
    if skill_has_aura_effect(effects) {
        return "passive".to_string();
    }
    match trigger_type.unwrap_or_default().trim() {
        "passive" | "counter" | "chase" => trigger_type.unwrap_or_default().trim().to_string(),
        _ => "active".to_string(),
    }
}

fn skill_has_aura_effect(effects: &[Value]) -> bool {
    effects.iter().any(|effect| {
        let Some(effect_type) = effect.get("type").and_then(Value::as_str) else {
            return false;
        };
        if effect_type != "buff" && effect_type != "debuff" {
            return false;
        }
        effect
            .get("buffKind")
            .and_then(Value::as_str)
            .map(|buff_kind| buff_kind == "aura")
            .unwrap_or(false)
    })
}

fn normalize_token(raw: Option<&str>) -> String {
    raw.unwrap_or_default().trim().to_lowercase()
}

fn push_unique(list: &mut Vec<String>, value: &str) {
    if value.is_empty() || list.iter().any(|item| item == value) {
        return;
    }
    list.push(value.to_string());
}

fn compare_category_order(left: &str, right: &str) -> std::cmp::Ordering {
    let left_rank = CATEGORY_PREFERRED_ORDER
        .iter()
        .position(|value| value == &left);
    let right_rank = CATEGORY_PREFERRED_ORDER
        .iter()
        .position(|value| value == &right);
    match (left_rank, right_rank) {
        (Some(left_rank), Some(right_rank)) => left_rank.cmp(&right_rank),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.cmp(right),
    }
}

fn is_enabled(enabled: Option<bool>) -> bool {
    enabled != Some(false)
}
