use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;
use std::{future::Future, pin::Pin};

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::application::static_data::catalog::{
    GameItemTaxonomyDto, ItemTaxonomyCategoryDto, ItemTaxonomyOptionDto, ItemTaxonomySubCategoryDto,
};
use crate::application::static_data::seed::read_seed_json;
use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::info::{
    InfoRouteServices, InfoTargetDropEntry, InfoTargetEquipmentEntry, InfoTargetStatsEntry,
    InfoTargetTechniqueEntry, InfoTargetType, InfoTargetView,
};
use crate::shared::error::AppError;

static INFO_STATIC_INDEX: OnceLock<Result<InfoStaticIndex, String>> = OnceLock::new();

const CATEGORY_LABEL_FALLBACK: [(&str, &str); 6] = [
    ("consumable", "消耗品"),
    ("material", "材料"),
    ("gem", "宝石"),
    ("equipment", "装备"),
    ("quest", "任务"),
    ("other", "其他"),
];
const CATEGORY_PREFERRED_ORDER: [&str; 6] = ["consumable", "material", "gem", "equipment", "quest", "other"];
const SUB_CATEGORY_LABEL_FALLBACK: [(&str, &str); 42] = [
    ("accessory", "饰品"),
    ("armor", "护甲"),
    ("battle_pass", "战令道具"),
    ("blade", "刀"),
    ("bone", "骨材"),
    ("box", "宝箱"),
    ("breakthrough", "突破道具"),
    ("collect", "采集物"),
    ("egg", "蛋类"),
    ("enhance", "强化道具"),
    ("essence", "精华"),
    ("forge", "锻造材料"),
    ("function", "功能道具"),
    ("gauntlets", "臂甲"),
    ("gem_all", "通用宝石"),
    ("gem_attack", "攻击宝石"),
    ("gem_defense", "防御宝石"),
    ("gem_survival", "生存宝石"),
    ("gloves", "手套"),
    ("hat", "帽子"),
    ("head", "头盔"),
    ("helmet", "头盔"),
    ("herb", "灵草"),
    ("key", "钥匙"),
    ("leather", "皮革"),
    ("legguards", "护腿"),
    ("material", "材料"),
    ("mirror", "宝镜"),
    ("month_card", "月卡道具"),
    ("necklace", "项链"),
    ("object", "杂项道具"),
    ("ore", "矿石"),
    ("pants", "下装"),
    ("pill", "丹药"),
    ("quest", "任务物品"),
    ("relic", "遗物"),
    ("ring", "戒指"),
    ("robe", "法袍"),
    ("scroll", "卷轴"),
    ("shield", "盾牌"),
    ("staff", "法杖"),
    ("sword", "剑"),
    ("talisman", "法宝（护符）"),
];
const EXTRA_SUB_CATEGORY_LABEL_FALLBACK: [(&str, &str); 2] = [("technique", "功法材料"), ("technique_book", "功法书")];

const RATIO_ATTR_KEYS: [&str; 12] = [
    "mingzhong",
    "shanbi",
    "zhaojia",
    "baoji",
    "baoshang",
    "jianbaoshang",
    "jianfantan",
    "kangbao",
    "zengshang",
    "zhiliao",
    "jianliao",
    "xixue",
];

const ATTR_LABELS: [(&str, &str); 18] = [
    ("jing", "精"),
    ("qi", "气"),
    ("shen", "神"),
    ("qixue", "气血"),
    ("max_qixue", "气血上限"),
    ("lingqi", "灵气"),
    ("max_lingqi", "灵气上限"),
    ("wugong", "物攻"),
    ("fagong", "法攻"),
    ("wufang", "物防"),
    ("fafang", "法防"),
    ("sudu", "速度"),
    ("mingzhong", "命中"),
    ("shanbi", "闪避"),
    ("baoji", "暴击"),
    ("baoshang", "暴伤"),
    ("kangbao", "抗暴"),
    ("zengshang", "增伤"),
];

const REALM_ORDER: [&str; 13] = [
    "凡人",
    "炼精化炁·养气期",
    "炼精化炁·通脉期",
    "炼精化炁·凝炁期",
    "炼炁化神·炼己期",
    "炼炁化神·采药期",
    "炼炁化神·结胎期",
    "炼神返虚·养神期",
    "炼神返虚·还虚期",
    "炼神返虚·合道期",
    "炼虚合道·证道期",
    "炼虚合道·历劫期",
    "炼虚合道·成圣期",
];

#[derive(Debug, Clone, Default)]
pub struct RustInfoService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone)]
struct InfoStaticIndex {
    taxonomy: GameItemTaxonomyDto,
    items_by_id: HashMap<String, ItemStaticMeta>,
    npcs_by_id: HashMap<String, NpcStaticMeta>,
    monsters_by_id: HashMap<String, MonsterStaticMeta>,
    techniques_by_id: HashMap<String, TechniqueStaticMeta>,
    exclusive_pools_by_id: HashMap<String, DropPoolSeed>,
    common_pools_by_id: HashMap<String, DropPoolSeed>,
}

#[derive(Debug, Clone)]
struct ItemStaticMeta {
    id: String,
    name: String,
    category: Option<String>,
    sub_category: Option<String>,
    quality: Option<String>,
    icon: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    equip_req_realm: Option<String>,
    use_req_realm: Option<String>,
    base_attrs: Option<Value>,
}

#[derive(Debug, Clone)]
struct NpcStaticMeta {
    id: String,
    name: String,
    title: Option<String>,
    gender: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
    drop_pool_id: Option<String>,
}

#[derive(Debug, Clone)]
struct MonsterStaticMeta {
    id: String,
    name: String,
    title: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    kind: Option<String>,
    base_attrs: Option<Value>,
    attr_variance: Option<f64>,
    attr_multiplier_min: Option<f64>,
    attr_multiplier_max: Option<f64>,
    drop_pool_id: Option<String>,
}

#[derive(Debug, Clone)]
struct TechniqueStaticMeta {
    name: String,
    technique_type: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeedFile {
    items: Vec<ItemSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct NpcSeedFile {
    npcs: Vec<NpcSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueSeedFile {
    techniques: Vec<TechniqueSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolSeedFile {
    pools: Vec<DropPoolSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct ItemSeed {
    id: String,
    name: String,
    category: Option<String>,
    sub_category: Option<String>,
    quality: Option<String>,
    icon: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    equip_req_realm: Option<String>,
    use_req_realm: Option<String>,
    base_attrs: Option<Value>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct NpcSeed {
    id: String,
    name: String,
    title: Option<String>,
    gender: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct MonsterSeed {
    id: String,
    name: String,
    title: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    kind: Option<String>,
    base_attrs: Option<Value>,
    attr_variance: Option<f64>,
    attr_multiplier_min: Option<f64>,
    attr_multiplier_max: Option<f64>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TechniqueSeed {
    id: String,
    name: String,
    #[serde(rename = "type")]
    technique_type: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolSeed {
    id: String,
    mode: Option<String>,
    common_pool_ids: Option<Vec<String>>,
    entries: Option<Vec<DropPoolEntrySeed>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct DropPoolEntrySeed {
    item_def_id: Option<String>,
    chance: Option<f64>,
    weight: Option<f64>,
    chance_add_by_monster_realm: Option<f64>,
    qty_min: Option<i32>,
    qty_max: Option<i32>,
    qty_min_add_by_monster_realm: Option<f64>,
    qty_max_add_by_monster_realm: Option<f64>,
    qty_multiply_by_monster_realm: Option<f64>,
    sort_order: Option<i32>,
    show_in_ui: Option<bool>,
}

#[derive(Debug, Clone)]
struct ResolvedDropEntry {
    mode: String,
    item_def_id: String,
    chance: f64,
    weight: f64,
    chance_add_by_monster_realm: f64,
    qty_min: i32,
    qty_max: i32,
    qty_min_add_by_monster_realm: f64,
    qty_max_add_by_monster_realm: f64,
    qty_multiply_by_monster_realm: f64,
    sort_order: i32,
    source_type: String,
    source_pool_id: String,
}

impl RustInfoService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn get_player_target_detail(&self, id: &str) -> Result<Option<InfoTargetView>, BusinessError> {
        let character_id = id.trim().parse::<i64>().ok().filter(|value| *value > 0);
        let Some(character_id) = character_id else {
            return Ok(None);
        };

        let row = sqlx::query(
            r#"
            SELECT id, nickname, gender, title, realm, sub_realm, avatar
            FROM characters
            WHERE id = $1
            LIMIT 1
            "#,
        )
        .bind(character_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            return Ok(None);
        };

        let index = info_static_index().map_err(internal_business_error)?;
        let technique_rows = sqlx::query(
            r#"
            SELECT technique_id, current_layer
            FROM character_technique
            WHERE character_id = $1 AND slot_type IS NOT NULL
            ORDER BY slot_type ASC, slot_index ASC
            "#,
        )
        .bind(character_id)
        .fetch_all(&self.pool)
        .await
        .map_err(internal_business_error)?;

        let techniques = technique_rows
            .into_iter()
            .filter_map(|entry| {
                let technique_id = entry.try_get::<String, _>("technique_id").ok()?.trim().to_string();
                if technique_id.is_empty() {
                    return None;
                }
                let meta = index.techniques_by_id.get(technique_id.as_str())?;
                let current_layer = entry.try_get::<Option<i32>, _>("current_layer").ok().flatten().unwrap_or(0);
                Some(InfoTargetTechniqueEntry {
                    name: meta.name.clone(),
                    level: if current_layer > 0 { format!("{current_layer}重") } else { "-".to_string() },
                    technique_type: if meta.technique_type.trim().is_empty() {
                        "功法".to_string()
                    } else {
                        meta.technique_type.clone()
                    },
                })
            })
            .collect::<Vec<_>>();

        let nickname = row.try_get::<String, _>("nickname").unwrap_or_default();
        let title = row.try_get::<String, _>("title").unwrap_or_default();
        let realm = row.try_get::<String, _>("realm").unwrap_or_default();
        let sub_realm = row.try_get::<Option<String>, _>("sub_realm").ok().flatten();
        let avatar = row.try_get::<Option<String>, _>("avatar").ok().flatten();
        let gender = row.try_get::<String, _>("gender").unwrap_or_default();
        let resolved_title = title.trim();

        Ok(Some(InfoTargetView::Player {
            id: character_id.to_string(),
            name: if nickname.trim().is_empty() {
                format!("修士{character_id}")
            } else {
                nickname.trim().to_string()
            },
            month_card_active: None,
            title: Some(if resolved_title.is_empty() { "散修".to_string() } else { resolved_title.to_string() }),
            title_description: None,
            gender: Some(normalize_gender(Some(gender.as_str())).unwrap_or_else(|| "-".to_string())),
            realm: Some(build_full_realm(Some(realm.as_str()), sub_realm.as_deref())),
            avatar,
            stats: None,
            equipment: Some(Vec::<InfoTargetEquipmentEntry>::new()),
            techniques: Some(techniques),
        }))
    }
}

impl InfoRouteServices for RustInfoService {
    fn get_item_taxonomy<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<GameItemTaxonomyDto, BusinessError>> + Send + 'a>> {
        Box::pin(async move { get_item_taxonomy_snapshot() })
    }

    fn get_target_detail<'a>(
        &'a self,
        target_type: InfoTargetType,
        id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Option<InfoTargetView>, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            match target_type {
                InfoTargetType::Player => self.get_player_target_detail(id).await,
                _ => get_static_target_detail(target_type, id),
            }
        })
    }
}

pub fn get_item_taxonomy_snapshot() -> Result<GameItemTaxonomyDto, BusinessError> {
    Ok(info_static_index().map_err(internal_business_error)?.taxonomy.clone())
}

pub fn get_static_target_detail(
    target_type: InfoTargetType,
    id: &str,
) -> Result<Option<InfoTargetView>, BusinessError> {
    let target_id = id.trim();
    if target_id.is_empty() {
        return Ok(None);
    }

    let index = info_static_index().map_err(internal_business_error)?;
    let detail = match target_type {
        InfoTargetType::Npc => index.npcs_by_id.get(target_id).map(|entry| build_npc_target(entry, index)),
        InfoTargetType::Monster => index
            .monsters_by_id
            .get(target_id)
            .map(|entry| build_monster_target(entry, index)),
        InfoTargetType::Item => index.items_by_id.get(target_id).map(build_item_target),
        InfoTargetType::Player => None,
    };
    Ok(detail)
}

fn info_static_index() -> Result<&'static InfoStaticIndex, AppError> {
    let result = INFO_STATIC_INDEX.get_or_init(|| build_info_static_index().map_err(|error| error.to_string()));
    match result {
        Ok(index) => Ok(index),
        Err(message) => Err(AppError::Config(message.clone())),
    }
}

fn build_info_static_index() -> Result<InfoStaticIndex, AppError> {
    let items = read_seed_json::<ItemSeedFile>("item_def.json")?.items;
    let npcs = read_seed_json::<NpcSeedFile>("npc_def.json")?.npcs;
    let monsters = read_seed_json::<MonsterSeedFile>("monster_def.json")?.monsters;
    let techniques = read_seed_json::<TechniqueSeedFile>("technique_def.json")?.techniques;
    let exclusive_pools = read_seed_json::<DropPoolSeedFile>("drop_pool.json")?.pools;
    let common_pools = read_seed_json::<DropPoolSeedFile>("drop_pool_common.json")?.pools;

    let enabled_items = items.into_iter().filter(|entry| is_enabled(entry.enabled)).collect::<Vec<_>>();
    let enabled_npcs = npcs.into_iter().filter(|entry| is_enabled(entry.enabled)).collect::<Vec<_>>();
    let enabled_monsters = monsters.into_iter().filter(|entry| is_enabled(entry.enabled)).collect::<Vec<_>>();

    let taxonomy = build_item_taxonomy(&enabled_items);
    let items_by_id = enabled_items
        .into_iter()
        .map(|entry| {
            let id = entry.id.trim().to_string();
            (
                id.clone(),
                ItemStaticMeta {
                    id,
                    name: entry.name,
                    category: normalize_optional_text(entry.category),
                    sub_category: normalize_optional_text(entry.sub_category),
                    quality: normalize_optional_text(entry.quality),
                    icon: normalize_optional_text(entry.icon),
                    description: normalize_optional_text(entry.description),
                    long_desc: normalize_optional_text(entry.long_desc),
                    equip_req_realm: normalize_optional_text(entry.equip_req_realm),
                    use_req_realm: normalize_optional_text(entry.use_req_realm),
                    base_attrs: entry.base_attrs,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let npcs_by_id = enabled_npcs
        .into_iter()
        .map(|entry| {
            let id = entry.id.trim().to_string();
            (
                id.clone(),
                NpcStaticMeta {
                    id,
                    name: entry.name,
                    title: normalize_optional_text(entry.title),
                    gender: normalize_optional_text(entry.gender),
                    realm: normalize_optional_text(entry.realm),
                    avatar: normalize_optional_text(entry.avatar),
                    description: normalize_optional_text(entry.description),
                    drop_pool_id: normalize_optional_text(entry.drop_pool_id),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let monsters_by_id = enabled_monsters
        .into_iter()
        .map(|entry| {
            let id = entry.id.trim().to_string();
            (
                id.clone(),
                MonsterStaticMeta {
                    id,
                    name: entry.name,
                    title: normalize_optional_text(entry.title),
                    realm: normalize_optional_text(entry.realm),
                    avatar: normalize_optional_text(entry.avatar),
                    kind: normalize_optional_text(entry.kind),
                    base_attrs: entry.base_attrs,
                    attr_variance: entry.attr_variance,
                    attr_multiplier_min: entry.attr_multiplier_min,
                    attr_multiplier_max: entry.attr_multiplier_max,
                    drop_pool_id: normalize_optional_text(entry.drop_pool_id),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let techniques_by_id = techniques
        .into_iter()
        .filter(|entry| is_enabled(entry.enabled))
        .map(|entry| {
            (
                entry.id.trim().to_string(),
                TechniqueStaticMeta {
                    name: entry.name.trim().to_string(),
                    technique_type: normalize_optional_text(entry.technique_type).unwrap_or_else(|| "功法".to_string()),
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let exclusive_pools_by_id = exclusive_pools
        .into_iter()
        .filter(|entry| is_enabled(entry.enabled))
        .map(|entry| (entry.id.trim().to_string(), entry))
        .collect::<HashMap<_, _>>();
    let common_pools_by_id = common_pools
        .into_iter()
        .filter(|entry| is_enabled(entry.enabled))
        .map(|entry| (entry.id.trim().to_string(), entry))
        .collect::<HashMap<_, _>>();

    Ok(InfoStaticIndex {
        taxonomy,
        items_by_id,
        npcs_by_id,
        monsters_by_id,
        techniques_by_id,
        exclusive_pools_by_id,
        common_pools_by_id,
    })
}

fn build_item_taxonomy(items: &[ItemSeed]) -> GameItemTaxonomyDto {
    let mut category_set = BTreeSet::<String>::new();
    let mut sub_category_labels = BTreeMap::<String, String>::new();
    let mut sub_category_by_category = BTreeMap::<String, Vec<String>>::from([("all".to_string(), Vec::new())]);

    for item in items {
        let category = normalize_token(item.category.as_deref());
        if let Some(category) = category.as_ref() {
            category_set.insert(category.clone());
            sub_category_by_category.entry(category.clone()).or_default();
        }

        let Some(sub_category) = normalize_token(item.sub_category.as_deref()) else {
            continue;
        };

        if !sub_category_labels.contains_key(sub_category.as_str()) {
            let label = lookup_sub_category_label(sub_category.as_str());
            sub_category_labels.insert(sub_category.clone(), label.to_string());
        }
        push_unique(sub_category_by_category.entry("all".to_string()).or_default(), sub_category.as_str());
        if let Some(category) = category.as_ref() {
            push_unique(sub_category_by_category.entry(category.clone()).or_default(), sub_category.as_str());
        }
    }

    let category_values = sort_category_values(category_set.into_iter().collect());
    let mut category_labels = BTreeMap::<String, String>::from([("all".to_string(), "全部".to_string())]);
    for category in &category_values {
        category_labels.insert(category.clone(), lookup_category_label(category).to_string());
        sub_category_by_category.entry(category.clone()).or_default();
    }

    let category_options = category_values
        .iter()
        .map(|value| ItemTaxonomyOptionDto {
            value: value.clone(),
            label: category_labels.get(value).cloned().unwrap_or_else(|| value.clone()),
        })
        .collect::<Vec<_>>();
    let sub_category_options = sub_category_labels
        .iter()
        .map(|(value, label)| ItemTaxonomyOptionDto {
            value: value.clone(),
            label: label.clone(),
        })
        .collect::<Vec<_>>();

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

fn build_npc_target(entry: &NpcStaticMeta, index: &InfoStaticIndex) -> InfoTargetView {
    let drops = entry
        .drop_pool_id
        .as_deref()
        .map(|drop_pool_id| build_drop_entries(drop_pool_id, index, None))
        .filter(|entries| !entries.is_empty());
    InfoTargetView::Npc {
        id: entry.id.clone(),
        name: entry.name.clone(),
        title: entry.title.clone(),
        title_description: None,
        gender: entry.gender.clone(),
        realm: entry.realm.clone(),
        avatar: entry.avatar.clone(),
        desc: entry.description.clone(),
        drops,
    }
}

fn build_monster_target(entry: &MonsterStaticMeta, index: &InfoStaticIndex) -> InfoTargetView {
    let mut stats = to_stats_from_attrs(entry.base_attrs.as_ref(), "");
    if let Some(value) = entry.attr_variance {
        stats.push(InfoTargetStatsEntry {
            label: "属性波动".to_string(),
            value: json!(format!("±{}", format_percent(value))),
        });
    }
    if let (Some(min), Some(max)) = (entry.attr_multiplier_min, entry.attr_multiplier_max) {
        stats.push(InfoTargetStatsEntry {
            label: "整体倍率".to_string(),
            value: json!(format!("{min:.2} - {max:.2}")),
        });
    }
    let drops = entry
        .drop_pool_id
        .as_deref()
        .map(|drop_pool_id| build_drop_entries(drop_pool_id, index, Some(entry)))
        .filter(|entries| !entries.is_empty());
    InfoTargetView::Monster {
        id: entry.id.clone(),
        name: entry.name.clone(),
        title: entry.title.clone(),
        title_description: None,
        gender: Some("-".to_string()),
        realm: entry.realm.clone(),
        avatar: entry.avatar.clone(),
        base_attrs: value_to_number_map(entry.base_attrs.as_ref()),
        attr_variance: entry.attr_variance,
        attr_multiplier_min: entry.attr_multiplier_min,
        attr_multiplier_max: entry.attr_multiplier_max,
        stats: (!stats.is_empty()).then_some(stats),
        drops,
    }
}

fn build_item_target(entry: &ItemStaticMeta) -> InfoTargetView {
    let desc = entry.long_desc.clone().or_else(|| entry.description.clone());
    let realm = entry
        .equip_req_realm
        .clone()
        .or_else(|| entry.use_req_realm.clone());
    let stats = to_stats_from_attrs(entry.base_attrs.as_ref(), "");
    InfoTargetView::Item {
        id: entry.id.clone(),
        object_kind: None,
        name: entry.name.clone(),
        title: entry.quality.clone(),
        title_description: None,
        gender: Some("-".to_string()),
        realm,
        avatar: entry.icon.clone(),
        desc,
        stats: (!stats.is_empty()).then_some(stats),
    }
}

fn build_drop_entries(
    drop_pool_id: &str,
    index: &InfoStaticIndex,
    monster: Option<&MonsterStaticMeta>,
) -> Vec<InfoTargetDropEntry> {
    let Some(pool) = resolve_drop_pool(drop_pool_id, index) else {
        return Vec::new();
    };
    let total_weight = if pool.mode == "weight" {
        pool.entries
            .iter()
            .map(|entry| adjusted_weight(entry, monster))
            .sum::<f64>()
    } else {
        0.0
    };

    pool.entries
        .into_iter()
        .filter_map(|entry| {
            let item = index.items_by_id.get(entry.item_def_id.as_str())?;
            let quantity = adjusted_quantity_range(&entry, item, monster);
            let quantity_suffix = if quantity.0 == quantity.1 {
                if quantity.0 > 1 {
                    format!("×{}", quantity.0)
                } else {
                    String::new()
                }
            } else {
                format!("×{}-{}", quantity.0.max(1), quantity.1.max(quantity.0))
            };
            let chance = if entry.mode == "weight" {
                if total_weight <= 0.0 {
                    "-".to_string()
                } else {
                    format_percent(adjusted_weight(&entry, monster) / total_weight)
                }
            } else {
                format_percent(adjusted_chance(&entry, monster))
            };
            Some(InfoTargetDropEntry {
                name: format!("{}{}", item.name, quantity_suffix),
                quality: item.quality.clone().unwrap_or_else(|| "-".to_string()),
                chance,
            })
        })
        .collect()
}

fn resolve_drop_pool(drop_pool_id: &str, index: &InfoStaticIndex) -> Option<ResolvedDropPoolView> {
    let pool_id = drop_pool_id.trim();
    let exclusive = index.exclusive_pools_by_id.get(pool_id)?;
    let mut merged = BTreeMap::<String, ResolvedDropEntry>::new();
    for common_pool_id in exclusive.common_pool_ids.clone().unwrap_or_default() {
        let common_pool_id = common_pool_id.trim();
        let Some(common_pool) = index.common_pools_by_id.get(common_pool_id) else {
            continue;
        };
        for entry in common_pool.entries.clone().unwrap_or_default() {
            let Some(normalized) = normalize_drop_entry(entry, common_pool.mode.as_deref().unwrap_or("prob"), "common", common_pool_id) else {
                continue;
            };
            merged.insert(normalized.item_def_id.clone(), normalized);
        }
    }
    for entry in exclusive.entries.clone().unwrap_or_default() {
        let Some(normalized) = normalize_drop_entry(entry, exclusive.mode.as_deref().unwrap_or("prob"), "exclusive", pool_id) else {
            continue;
        };
        merged.insert(normalized.item_def_id.clone(), normalized);
    }
    let mut entries = merged.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.sort_order.cmp(&right.sort_order).then_with(|| left.item_def_id.cmp(&right.item_def_id)));
    Some(ResolvedDropPoolView {
        mode: exclusive.mode.clone().unwrap_or_else(|| "prob".to_string()),
        entries,
    })
}

#[derive(Debug, Clone)]
struct ResolvedDropPoolView {
    mode: String,
    entries: Vec<ResolvedDropEntry>,
}

fn normalize_drop_entry(
    entry: DropPoolEntrySeed,
    mode: &str,
    source_type: &str,
    source_pool_id: &str,
) -> Option<ResolvedDropEntry> {
    if entry.show_in_ui == Some(false) {
        return None;
    }
    let item_def_id = entry.item_def_id?.trim().to_string();
    if item_def_id.is_empty() {
        return None;
    }
    let qty_min = entry.qty_min.unwrap_or(1).max(1);
    let qty_max = entry.qty_max.unwrap_or(qty_min).max(qty_min);
    Some(ResolvedDropEntry {
        mode: if mode == "weight" { "weight".to_string() } else { "prob".to_string() },
        item_def_id,
        chance: entry.chance.unwrap_or(0.0).max(0.0),
        weight: entry.weight.unwrap_or(0.0).max(0.0),
        chance_add_by_monster_realm: entry.chance_add_by_monster_realm.unwrap_or(0.0).max(0.0),
        qty_min,
        qty_max,
        qty_min_add_by_monster_realm: entry.qty_min_add_by_monster_realm.unwrap_or(0.0).max(0.0),
        qty_max_add_by_monster_realm: entry.qty_max_add_by_monster_realm.unwrap_or(entry.qty_min_add_by_monster_realm.unwrap_or(0.0)).max(entry.qty_min_add_by_monster_realm.unwrap_or(0.0)),
        qty_multiply_by_monster_realm: entry.qty_multiply_by_monster_realm.unwrap_or(1.0).max(1.0),
        sort_order: entry.sort_order.unwrap_or(0).max(0),
        source_type: source_type.to_string(),
        source_pool_id: source_pool_id.to_string(),
    })
}

fn adjusted_chance(entry: &ResolvedDropEntry, monster: Option<&MonsterStaticMeta>) -> f64 {
    let realm_bonus = monster
        .map(|meta| get_realm_rank_zero_based(meta.realm.as_deref()) as f64 * entry.chance_add_by_monster_realm)
        .unwrap_or(0.0);
    let common_multiplier = if entry.source_type == "common" {
        get_common_pool_multiplier(entry.source_pool_id.as_str(), monster)
    } else {
        1.0
    };
    (entry.chance * common_multiplier + realm_bonus).clamp(0.0, 1.0)
}

fn adjusted_weight(entry: &ResolvedDropEntry, monster: Option<&MonsterStaticMeta>) -> f64 {
    let common_multiplier = if entry.source_type == "common" {
        get_common_pool_multiplier(entry.source_pool_id.as_str(), monster)
    } else {
        1.0
    };
    entry.weight * common_multiplier
}

fn adjusted_quantity_range(
    entry: &ResolvedDropEntry,
    item: &ItemStaticMeta,
    monster: Option<&MonsterStaticMeta>,
) -> (i32, i32) {
    let realm_rank = monster.map(|meta| get_realm_rank_zero_based(meta.realm.as_deref()) as f64).unwrap_or(0.0);
    let base_min = (entry.qty_min as f64 + realm_rank * entry.qty_min_add_by_monster_realm).floor().max(1.0) as i32;
    let base_max = (entry.qty_max as f64 + realm_rank * entry.qty_max_add_by_monster_realm)
        .floor()
        .max(base_min as f64) as i32;
    if !should_apply_drop_quantity_multiplier(item) {
        return (base_min, base_max);
    }
    let common_multiplier = if entry.source_type == "common" {
        get_common_pool_multiplier(entry.source_pool_id.as_str(), monster)
    } else {
        1.0
    };
    let min_after_common = ((base_min as f64) * common_multiplier).floor().max(1.0) as i32;
    let max_after_common = ((base_max as f64) * common_multiplier).floor().max(min_after_common as f64) as i32;
    let realm_multiplier = if entry.qty_multiply_by_monster_realm <= 1.0 {
        1.0
    } else {
        1.0 + (entry.qty_multiply_by_monster_realm - 1.0) * (realm_rank + 1.0)
    };
    let final_min = ((min_after_common as f64) * realm_multiplier).floor().max(1.0) as i32;
    let final_max = ((max_after_common as f64) * realm_multiplier).floor().max(final_min as f64) as i32;
    (final_min, final_max)
}

fn get_common_pool_multiplier(source_pool_id: &str, monster: Option<&MonsterStaticMeta>) -> f64 {
    const EXCLUDED: [&str; 4] = [
        "dp-common-monster-elite",
        "dp-common-monster-boss",
        "dp-common-dungeon-boss-unbind",
        "dp-common-dungeon-boss-advanced-recruit-token",
    ];
    if EXCLUDED.contains(&source_pool_id) {
        return 1.0;
    }
    match normalize_monster_kind(monster.and_then(|meta| meta.kind.as_deref())) {
        "elite" => 2.0,
        "boss" => 4.0,
        _ => 1.0,
    }
}

fn normalize_monster_kind(value: Option<&str>) -> &'static str {
    match value.unwrap_or_default().trim().to_lowercase().as_str() {
        "elite" => "elite",
        "boss" => "boss",
        _ => "normal",
    }
}

fn should_apply_drop_quantity_multiplier(item: &ItemStaticMeta) -> bool {
    let category = item.category.as_deref().unwrap_or_default();
    let sub_category = item.sub_category.as_deref().unwrap_or_default();
    category != "equipment" && sub_category != "technique" && sub_category != "technique_book"
}

fn to_stats_from_attrs(value: Option<&Value>, prefix: &str) -> Vec<InfoTargetStatsEntry> {
    let Some(Value::Object(map)) = value else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, value)| {
            let label = lookup_attr_label(key).unwrap_or(key.as_str()).to_string();
            match value {
                Value::Number(number) => Some(InfoTargetStatsEntry {
                    label: format!("{prefix}{label}"),
                    value: if is_ratio_attr(key) {
                        json!(format_percent(number.as_f64().unwrap_or(0.0)))
                    } else {
                        json!(number)
                    },
                }),
                Value::String(text) => Some(InfoTargetStatsEntry {
                    label: format!("{prefix}{label}"),
                    value: if is_ratio_attr(key) {
                        json!(format_percent(text.parse::<f64>().unwrap_or(0.0)))
                    } else {
                        json!(text)
                    },
                }),
                _ => None,
            }
        })
        .collect()
}

fn value_to_number_map(value: Option<&Value>) -> Option<BTreeMap<String, f64>> {
    let Value::Object(map) = value? else {
        return None;
    };
    let output = map
        .iter()
        .filter_map(|(key, value)| match value {
            Value::Number(number) => number.as_f64().map(|number| (key.clone(), number)),
            Value::String(text) => text.parse::<f64>().ok().map(|number| (key.clone(), number)),
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    (!output.is_empty()).then_some(output)
}

fn normalize_gender(value: Option<&str>) -> Option<String> {
    match value.unwrap_or_default().trim() {
        "male" => Some("男".to_string()),
        "female" => Some("女".to_string()),
        "" => None,
        raw => Some(raw.to_string()),
    }
}

fn build_full_realm(realm: Option<&str>, sub_realm: Option<&str>) -> String {
    let major = realm.unwrap_or_default().trim();
    let minor = sub_realm.unwrap_or_default().trim();
    if major.is_empty() {
        return "凡人".to_string();
    }
    if major == "凡人" || minor.is_empty() {
        return major.to_string();
    }
    format!("{major}·{minor}")
}

fn format_percent(value: f64) -> String {
    let percent = value * 100.0;
    let text = if (percent - percent.round()).abs() < 1e-9 {
        format!("{percent:.0}")
    } else {
        format!("{percent:.2}")
    };
    format!("{}%", text.trim_end_matches('0').trim_end_matches('.'))
}

fn get_realm_rank_zero_based(realm: Option<&str>) -> usize {
    let normalized = realm.unwrap_or("凡人").trim();
    REALM_ORDER.iter().position(|entry| *entry == normalized).unwrap_or(0)
}

fn is_enabled(value: Option<bool>) -> bool {
    value != Some(false)
}

fn lookup_category_label(value: &str) -> &str {
    CATEGORY_LABEL_FALLBACK
        .iter()
        .find_map(|(key, label)| (*key == value).then_some(*label))
        .unwrap_or(value)
}

fn lookup_sub_category_label(value: &str) -> &str {
    SUB_CATEGORY_LABEL_FALLBACK
        .iter()
        .chain(EXTRA_SUB_CATEGORY_LABEL_FALLBACK.iter())
        .find_map(|(key, label)| (*key == value).then_some(*label))
        .unwrap_or(value)
}

fn lookup_attr_label(value: &str) -> Option<&str> {
    ATTR_LABELS
        .iter()
        .find_map(|(key, label)| (*key == value).then_some(*label))
}

fn normalize_token(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim().to_lowercase();
    (!normalized.is_empty()).then_some(normalized)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim().to_string();
    (!normalized.is_empty()).then_some(normalized)
}

fn sort_category_values(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| {
        let left_index = CATEGORY_PREFERRED_ORDER.iter().position(|value| *value == left).unwrap_or(usize::MAX);
        let right_index = CATEGORY_PREFERRED_ORDER.iter().position(|value| *value == right).unwrap_or(usize::MAX);
        left_index.cmp(&right_index).then_with(|| left.cmp(right))
    });
    values
}

fn push_unique(target: &mut Vec<String>, value: &str) {
    if !target.iter().any(|entry| entry == value) {
        target.push(value.to_string());
    }
}

fn is_ratio_attr(value: &str) -> bool {
    RATIO_ATTR_KEYS.contains(&value)
}

fn internal_business_error(error: AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
