use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::shared::error::AppError;

#[derive(Debug, Clone)]
pub struct InfoItemTarget {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub gender: String,
    pub realm: Option<String>,
    pub avatar: Option<String>,
    pub desc: Option<String>,
    pub stats: Vec<InfoStatRow>,
}

#[derive(Debug, Clone)]
pub struct InfoNpcTarget {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub gender: Option<String>,
    pub realm: Option<String>,
    pub avatar: Option<String>,
    pub desc: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InfoMonsterTarget {
    pub id: String,
    pub name: String,
    pub title: Option<String>,
    pub gender: String,
    pub realm: Option<String>,
    pub avatar: Option<String>,
    pub base_attrs: Option<serde_json::Value>,
    pub attr_variance: Option<f64>,
    pub attr_multiplier_min: Option<f64>,
    pub attr_multiplier_max: Option<f64>,
    pub stats: Vec<InfoStatRow>,
    pub drops: Vec<InfoDropRow>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InfoDropRow {
    pub name: String,
    pub quality: String,
    pub chance: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct InfoStatRow {
    pub label: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Deserialize, Clone)]
struct ItemSeedFile {
    items: Vec<ItemSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct ItemSeed {
    id: Option<String>,
    name: Option<String>,
    category: Option<String>,
    sub_category: Option<String>,
    quality: Option<String>,
    icon: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    equip_req_realm: Option<String>,
    use_req_realm: Option<String>,
    base_attrs: Option<serde_json::Value>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct NpcSeedFile {
    npcs: Vec<NpcSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct NpcSeed {
    id: Option<String>,
    name: Option<String>,
    title: Option<String>,
    gender: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterSeed {
    id: Option<String>,
    name: Option<String>,
    title: Option<String>,
    realm: Option<String>,
    avatar: Option<String>,
    kind: Option<String>,
    base_attrs: Option<serde_json::Value>,
    attr_variance: Option<serde_json::Value>,
    attr_multiplier_min: Option<serde_json::Value>,
    attr_multiplier_max: Option<serde_json::Value>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct DropPoolFile {
    pools: Vec<DropPoolSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct DropPoolSeed {
    id: Option<String>,
    mode: Option<String>,
    common_pool_ids: Option<Vec<String>>,
    entries: Option<Vec<DropPoolEntrySeed>>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct DropPoolEntrySeed {
    item_def_id: Option<String>,
    chance: Option<serde_json::Value>,
    weight: Option<serde_json::Value>,
    chance_add_by_monster_realm: Option<serde_json::Value>,
    qty_min: Option<serde_json::Value>,
    qty_max: Option<serde_json::Value>,
    qty_min_add_by_monster_realm: Option<serde_json::Value>,
    qty_max_add_by_monster_realm: Option<serde_json::Value>,
    qty_multiply_by_monster_realm: Option<serde_json::Value>,
    show_in_ui: Option<bool>,
    sort_order: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct ResolvedDropPool {
    mode: String,
    entries: Vec<ResolvedDropEntry>,
}

#[derive(Debug, Clone)]
struct ResolvedDropEntry {
    item_def_id: String,
    chance: f64,
    weight: i64,
    chance_add_by_monster_realm: f64,
    qty_min: i64,
    qty_max: i64,
    qty_min_add_by_monster_realm: f64,
    qty_max_add_by_monster_realm: f64,
    qty_multiply_by_monster_realm: f64,
    sort_order: i64,
    source_type: DropSourceType,
    source_pool_id: String,
    show_in_ui: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DropSourceType {
    Common,
    Exclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MonsterKind {
    Normal,
    Elite,
    Boss,
}

pub fn get_item_info_target(item_id: &str) -> Result<Option<InfoItemTarget>, AppError> {
    let normalized_id = item_id.trim();
    if normalized_id.is_empty() {
        return Ok(None);
    }

    let item = load_merged_items()?.into_iter().find(|item| {
        item.id.as_deref().map(str::trim) == Some(normalized_id) && item.enabled != Some(false)
    });

    let Some(item) = item else {
        return Ok(None);
    };

    let name = item.name.clone().unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Ok(None);
    }

    let desc = non_empty(item.long_desc.clone()).or_else(|| non_empty(item.description.clone()));
    let realm = non_empty(item.equip_req_realm.clone())
        .or_else(|| non_empty(item.use_req_realm.clone()))
        .or_else(|| gem_level_from_seed(&item).map(|level| format!("等级{level}")));

    Ok(Some(InfoItemTarget {
        id: normalized_id.to_string(),
        name,
        title: non_empty(item.quality.clone()),
        gender: "-".to_string(),
        realm,
        avatar: non_empty(item.icon.clone()),
        desc,
        stats: stats_from_base_attrs(item.base_attrs),
    }))
}

pub fn get_npc_info_target(npc_id: &str) -> Result<Option<InfoNpcTarget>, AppError> {
    let normalized_id = npc_id.trim();
    if normalized_id.is_empty() {
        return Ok(None);
    }

    let npc = read_npc_seed_file()?.npcs.into_iter().find(|entry| {
        entry.id.as_deref().map(str::trim) == Some(normalized_id) && entry.enabled != Some(false)
    });

    let Some(npc) = npc else {
        return Ok(None);
    };

    let name = npc.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Ok(None);
    }

    Ok(Some(InfoNpcTarget {
        id: normalized_id.to_string(),
        name,
        title: non_empty(npc.title),
        gender: non_empty(npc.gender),
        realm: non_empty(npc.realm),
        avatar: non_empty(npc.avatar),
        desc: non_empty(npc.description),
    }))
}

pub fn get_monster_info_target(monster_id: &str) -> Result<Option<InfoMonsterTarget>, AppError> {
    let normalized_id = monster_id.trim();
    if normalized_id.is_empty() {
        return Ok(None);
    }

    let monster = read_monster_seed_file()?
        .monsters
        .into_iter()
        .find(|entry| {
            entry.id.as_deref().map(str::trim) == Some(normalized_id)
                && entry.enabled != Some(false)
        });

    let Some(monster) = monster else {
        return Ok(None);
    };

    let name = monster.name.clone().unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Ok(None);
    }

    let base_attrs = monster
        .base_attrs
        .clone()
        .and_then(|value| value.as_object().map(|_| value.clone()));
    let mut stats = build_monster_stats(base_attrs.as_ref());
    let variance = as_f64(monster.attr_variance.as_ref());
    let mult_min = as_f64(monster.attr_multiplier_min.as_ref());
    let mult_max = as_f64(monster.attr_multiplier_max.as_ref());
    if let Some(variance) = variance {
        stats.push(InfoStatRow {
            label: "属性波动".to_string(),
            value: serde_json::Value::String(format!("±{}", format_percent(variance))),
        });
    }
    if let (Some(mult_min), Some(mult_max)) = (mult_min, mult_max) {
        stats.push(InfoStatRow {
            label: "整体倍率".to_string(),
            value: serde_json::Value::String(format!("{mult_min:.2} - {mult_max:.2}")),
        });
    }

    let drops = if let Some(drop_pool_id) = non_empty(monster.drop_pool_id.clone()) {
        build_monster_drop_preview(
            &drop_pool_id,
            normalize_monster_kind(monster.kind.as_deref()),
            monster.realm.as_deref(),
        )?
    } else {
        Vec::new()
    };

    Ok(Some(InfoMonsterTarget {
        id: normalized_id.to_string(),
        name,
        title: non_empty(monster.title),
        gender: "-".to_string(),
        realm: non_empty(monster.realm),
        avatar: non_empty(monster.avatar),
        base_attrs,
        attr_variance: variance,
        attr_multiplier_min: mult_min,
        attr_multiplier_max: mult_max,
        stats,
        drops,
    }))
}

fn load_merged_items() -> Result<Vec<ItemSeed>, AppError> {
    let mut by_id = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let file = read_seed_file(filename)?;
        for item in file.items {
            let id = item.id.as_deref().unwrap_or_default().trim().to_string();
            if id.is_empty() {
                continue;
            }
            by_id.insert(id, item);
        }
    }
    Ok(by_id.into_values().collect())
}

fn read_seed_file(filename: &str) -> Result<ItemSeedFile, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../server/src/data/seeds/{filename}"));
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))
}

fn read_npc_seed_file() -> Result<NpcSeedFile, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/npc_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read npc_def.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse npc_def.json: {error}")))
}

fn read_monster_seed_file() -> Result<MonsterSeedFile, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))
}

fn read_drop_pool_file(filename: &str) -> Result<DropPoolFile, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../server/src/data/seeds/{filename}"));
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))
}

fn build_monster_drop_preview(
    drop_pool_id: &str,
    monster_kind: MonsterKind,
    monster_realm: Option<&str>,
) -> Result<Vec<InfoDropRow>, AppError> {
    let Some(pool) = resolve_drop_pool_by_id(drop_pool_id)? else {
        return Ok(Vec::new());
    };
    let rows: Vec<_> = pool
        .entries
        .into_iter()
        .filter(|entry| entry.show_in_ui)
        .collect();
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let item_defs = load_merged_items()?;
    let item_map: BTreeMap<String, ItemSeed> = item_defs
        .into_iter()
        .filter_map(|item| {
            item.id
                .as_ref()
                .map(|id| (id.trim().to_string(), item.clone()))
        })
        .collect();

    let total_weight: f64 = if pool.mode == "weight" {
        rows.iter()
            .map(|entry| {
                adjusted_weight(
                    entry.weight as f64,
                    entry.source_type,
                    &entry.source_pool_id,
                    monster_kind,
                )
            })
            .sum()
    } else {
        0.0
    };

    let mut drops = Vec::new();
    for entry in rows {
        let item_def = item_map.get(&entry.item_def_id);
        let base_name = item_def
            .and_then(|item| item.name.as_ref())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(entry.item_def_id.as_str());
        let quantity = adjusted_drop_quantity_range(&entry, monster_realm, monster_kind, item_def);
        let qty_text = if quantity.0 == quantity.1 {
            if quantity.0 > 1 {
                format!("×{}", quantity.0)
            } else {
                String::new()
            }
        } else {
            format!("×{}-{}", quantity.0.max(1), quantity.1.max(quantity.0))
        };
        let quality = item_def
            .and_then(|item| item.quality.as_ref())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "-".to_string());
        let chance = if pool.mode == "weight" {
            let weight = adjusted_weight(
                entry.weight as f64,
                entry.source_type,
                &entry.source_pool_id,
                monster_kind,
            );
            if total_weight <= 0.0 {
                "-".to_string()
            } else {
                format_percent(weight / total_weight)
            }
        } else {
            format_percent(adjusted_chance(
                entry.chance,
                entry.source_type,
                &entry.source_pool_id,
                monster_kind,
                monster_realm,
                entry.chance_add_by_monster_realm,
            ))
        };
        drops.push(InfoDropRow {
            name: format!("{base_name}{qty_text}"),
            quality,
            chance,
        });
    }
    Ok(drops)
}

fn resolve_drop_pool_by_id(pool_id: &str) -> Result<Option<ResolvedDropPool>, AppError> {
    let exclusive = read_drop_pool_file("drop_pool.json")?;
    let common = read_drop_pool_file("drop_pool_common.json")?;
    let exclusive_map: BTreeMap<String, DropPoolSeed> = exclusive
        .pools
        .into_iter()
        .filter(|pool| pool.enabled != Some(false))
        .filter_map(|pool| {
            pool.id
                .as_ref()
                .map(|id| (id.trim().to_string(), pool.clone()))
        })
        .collect();
    let common_map: BTreeMap<String, DropPoolSeed> = common
        .pools
        .into_iter()
        .filter(|pool| pool.enabled != Some(false))
        .filter_map(|pool| {
            pool.id
                .as_ref()
                .map(|id| (id.trim().to_string(), pool.clone()))
        })
        .collect();
    let Some(exclusive_pool) = exclusive_map.get(pool_id) else {
        return Ok(None);
    };

    let mut merged: BTreeMap<String, ResolvedDropEntry> = BTreeMap::new();
    for common_pool_id in exclusive_pool.common_pool_ids.clone().unwrap_or_default() {
        if let Some(common_pool) = common_map.get(common_pool_id.trim()) {
            for entry in common_pool.entries.clone().unwrap_or_default() {
                if let Some(normalized) =
                    normalize_drop_entry(entry, DropSourceType::Common, common_pool_id.trim())
                {
                    merged.insert(normalized.item_def_id.clone(), normalized);
                }
            }
        }
    }
    for entry in exclusive_pool.entries.clone().unwrap_or_default() {
        if let Some(normalized) = normalize_drop_entry(entry, DropSourceType::Exclusive, pool_id) {
            merged.insert(normalized.item_def_id.clone(), normalized);
        }
    }

    let mut entries: Vec<_> = merged.into_values().collect();
    entries.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.item_def_id.cmp(&right.item_def_id))
    });

    Ok(Some(ResolvedDropPool {
        mode: exclusive_pool
            .mode
            .clone()
            .unwrap_or_else(|| "prob".to_string())
            .trim()
            .to_lowercase(),
        entries,
    }))
}

fn normalize_drop_entry(
    entry: DropPoolEntrySeed,
    source_type: DropSourceType,
    source_pool_id: &str,
) -> Option<ResolvedDropEntry> {
    let item_def_id = entry.item_def_id?.trim().to_string();
    if item_def_id.is_empty() {
        return None;
    }
    let qty_min = as_i64(entry.qty_min.as_ref()).unwrap_or(1).max(1);
    let qty_max = as_i64(entry.qty_max.as_ref())
        .unwrap_or(qty_min)
        .max(qty_min);
    Some(ResolvedDropEntry {
        item_def_id,
        chance: as_f64(entry.chance.as_ref()).unwrap_or(0.0).max(0.0),
        weight: as_i64(entry.weight.as_ref()).unwrap_or(0).max(0),
        chance_add_by_monster_realm: as_f64(entry.chance_add_by_monster_realm.as_ref())
            .unwrap_or(0.0)
            .max(0.0),
        qty_min,
        qty_max,
        qty_min_add_by_monster_realm: as_f64(entry.qty_min_add_by_monster_realm.as_ref())
            .unwrap_or(0.0)
            .max(0.0),
        qty_max_add_by_monster_realm: as_f64(entry.qty_max_add_by_monster_realm.as_ref())
            .unwrap_or(as_f64(entry.qty_min_add_by_monster_realm.as_ref()).unwrap_or(0.0))
            .max(
                as_f64(entry.qty_min_add_by_monster_realm.as_ref())
                    .unwrap_or(0.0)
                    .max(0.0),
            ),
        qty_multiply_by_monster_realm: as_f64(entry.qty_multiply_by_monster_realm.as_ref())
            .unwrap_or(1.0)
            .max(0.0),
        sort_order: as_i64(entry.sort_order.as_ref()).unwrap_or(0).max(0),
        source_type,
        source_pool_id: source_pool_id.to_string(),
        show_in_ui: entry.show_in_ui != Some(false),
    })
}

fn build_monster_stats(base_attrs: Option<&serde_json::Value>) -> Vec<InfoStatRow> {
    let Some(object) = base_attrs.and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for key in [
        "qixue",
        "max_qixue",
        "lingqi",
        "max_lingqi",
        "wugong",
        "fagong",
        "wufang",
        "fafang",
        "mingzhong",
        "shanbi",
        "baoji",
        "baoshang",
        "sudu",
        "kongzhi_kangxing",
    ] {
        if let Some(value) = object.get(key) {
            rows.push(InfoStatRow {
                label: attr_label(key).to_string(),
                value: if ratio_attr(key) {
                    serde_json::Value::String(format_percent(
                        value
                            .as_f64()
                            .unwrap_or_else(|| value.as_i64().unwrap_or_default() as f64),
                    ))
                } else {
                    value.clone()
                },
            });
        }
    }
    for (key, value) in object {
        if rows.iter().any(|row| row.label == attr_label(key)) {
            continue;
        }
        rows.push(InfoStatRow {
            label: attr_label(key).to_string(),
            value: value.clone(),
        });
    }
    rows
}

fn ratio_attr(key: &str) -> bool {
    matches!(
        key,
        "mingzhong" | "shanbi" | "baoji" | "baoshang" | "kongzhi_kangxing"
    )
}

fn adjusted_chance(
    chance: f64,
    source_type: DropSourceType,
    source_pool_id: &str,
    monster_kind: MonsterKind,
    monster_realm: Option<&str>,
    chance_add_by_monster_realm: f64,
) -> f64 {
    if chance <= 0.0 {
        return 0.0;
    }
    let multiplied = chance * common_pool_multiplier(source_type, source_pool_id, monster_kind);
    let realm_bonus = realm_scaled_chance_bonus(chance_add_by_monster_realm, monster_realm);
    (multiplied + realm_bonus).clamp(0.0, 1.0)
}

fn adjusted_weight(
    weight: f64,
    source_type: DropSourceType,
    source_pool_id: &str,
    monster_kind: MonsterKind,
) -> f64 {
    if weight <= 0.0 {
        return 0.0;
    }
    weight * common_pool_multiplier(source_type, source_pool_id, monster_kind)
}

fn common_pool_multiplier(
    source_type: DropSourceType,
    source_pool_id: &str,
    monster_kind: MonsterKind,
) -> f64 {
    if source_type != DropSourceType::Common {
        return 1.0;
    }
    if matches!(
        source_pool_id,
        "dp-common-monster-elite"
            | "dp-common-monster-boss"
            | "dp-common-dungeon-boss-unbind"
            | "dp-common-dungeon-boss-advanced-recruit-token"
    ) {
        return 1.0;
    }
    match monster_kind {
        MonsterKind::Normal => 1.0,
        MonsterKind::Elite => 2.0,
        MonsterKind::Boss => 4.0,
    }
}

fn realm_scaled_chance_bonus(chance_add_by_monster_realm: f64, monster_realm: Option<&str>) -> f64 {
    if chance_add_by_monster_realm <= 0.0 {
        return 0.0;
    }
    get_realm_rank_zero_based(monster_realm) as f64 * chance_add_by_monster_realm
}

fn adjusted_drop_quantity_range(
    entry: &ResolvedDropEntry,
    monster_realm: Option<&str>,
    monster_kind: MonsterKind,
    item_def: Option<&ItemSeed>,
) -> (i64, i64) {
    let realm_rank = get_realm_rank_zero_based(monster_realm) as f64;
    let base_min = (entry.qty_min as f64 + realm_rank * entry.qty_min_add_by_monster_realm)
        .floor()
        .max(1.0) as i64;
    let base_max = (entry.qty_max as f64 + realm_rank * entry.qty_max_add_by_monster_realm)
        .floor()
        .max(base_min as f64) as i64;
    let apply_qty_multiplier = should_apply_drop_quantity_multiplier(item_def);
    let common_multiplier = if apply_qty_multiplier {
        common_pool_multiplier(entry.source_type, &entry.source_pool_id, monster_kind)
    } else {
        1.0
    };
    let min_after_common = (base_min as f64 * common_multiplier).floor().max(1.0) as i64;
    let max_after_common = (base_max as f64 * common_multiplier)
        .floor()
        .max(min_after_common as f64) as i64;
    let realm_mult =
        effective_realm_quantity_multiplier(entry.qty_multiply_by_monster_realm, monster_realm);
    let final_min = (min_after_common as f64 * realm_mult).floor().max(1.0) as i64;
    let final_max = (max_after_common as f64 * realm_mult)
        .floor()
        .max(final_min as f64) as i64;
    (final_min, final_max)
}

fn should_apply_drop_quantity_multiplier(item_def: Option<&ItemSeed>) -> bool {
    let Some(item_def) = item_def else {
        return true;
    };
    let category = item_def
        .category
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let sub_category = item_def
        .sub_category
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    category != "equipment" && sub_category != "technique" && sub_category != "technique_book"
}

fn effective_realm_quantity_multiplier(multiplier: f64, monster_realm: Option<&str>) -> f64 {
    if multiplier <= 0.0 {
        return 1.0;
    }
    if (multiplier - 1.0).abs() < f64::EPSILON {
        return 1.0;
    }
    if multiplier < 1.0 {
        return multiplier.max(0.0);
    }
    let realm_rank = get_realm_rank_one_based_strict(monster_realm) as f64;
    1.0 + (multiplier - 1.0) * realm_rank
}

fn normalize_monster_kind(raw: Option<&str>) -> MonsterKind {
    match raw.unwrap_or_default().trim().to_lowercase().as_str() {
        "elite" => MonsterKind::Elite,
        "boss" => MonsterKind::Boss,
        _ => MonsterKind::Normal,
    }
}

fn get_realm_rank_zero_based(realm: Option<&str>) -> i64 {
    REALM_ORDER
        .iter()
        .position(|value| *value == realm.unwrap_or_default().trim())
        .unwrap_or(0) as i64
}

fn get_realm_rank_one_based_strict(realm: Option<&str>) -> i64 {
    REALM_ORDER
        .iter()
        .position(|value| *value == realm.unwrap_or_default().trim())
        .map(|index| index as i64 + 1)
        .unwrap_or(1)
}

fn format_percent(value: f64) -> String {
    let percent = value * 100.0;
    let rounded = if (percent - percent.round()).abs() < 1e-9 {
        format!("{:.0}", percent)
    } else {
        let text = format!("{:.2}", percent);
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    };
    format!("{rounded}%")
}

fn as_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_i64().map(|v| v as f64))
            .or_else(|| value.as_str().and_then(|v| v.parse::<f64>().ok()))
    })
}

fn as_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().map(|v| v as i64))
            .or_else(|| value.as_f64().map(|v| v.floor() as i64))
            .or_else(|| value.as_str().and_then(|v| v.parse::<i64>().ok()))
    })
}

const REALM_ORDER: &[&str] = &[
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

fn stats_from_base_attrs(base_attrs: Option<serde_json::Value>) -> Vec<InfoStatRow> {
    let Some(base_attrs) = base_attrs else {
        return Vec::new();
    };
    let Some(object) = base_attrs.as_object() else {
        return Vec::new();
    };

    object
        .iter()
        .filter_map(|(key, value)| {
            if value.is_null() {
                return None;
            }
            Some(InfoStatRow {
                label: attr_label(key).to_string(),
                value: value.clone(),
            })
        })
        .collect()
}

fn attr_label(key: &str) -> &str {
    match key {
        "qixue" => "气血",
        "lingqi" => "灵气",
        "wugong" => "物攻",
        "fagong" => "法攻",
        "wufang" => "物防",
        "fafang" => "法防",
        "mingzhong" => "命中",
        "shanbi" => "闪避",
        "baoji" => "暴击",
        "kangbao" => "抗暴",
        "sudu" => "速度",
        _ => key,
    }
}

fn gem_level_from_seed(item: &ItemSeed) -> Option<i64> {
    if item.category.as_deref().map(|value| value.trim()) != Some("gem") {
        return None;
    }
    let id = item.id.as_deref()?.trim();
    id.rsplit('-').next()?.parse::<i64>().ok()
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    #[test]
    fn item_target_can_be_loaded_from_seed() {
        let target = super::get_item_info_target("cons-001")
            .expect("item load should succeed")
            .expect("item should exist");
        assert_eq!(target.name, "清灵丹");
        assert_eq!(target.gender, "-");
    }

    #[test]
    fn npc_target_can_be_loaded_from_seed() {
        let target = super::get_npc_info_target("npc-village-elder")
            .expect("npc load should succeed")
            .expect("npc should exist");
        assert_eq!(target.name, "村长");
        assert_eq!(target.gender.as_deref(), Some("男"));
    }

    #[test]
    fn monster_target_builds_world_drop_preview() {
        let target = super::get_monster_info_target("monster-duzhang-guchong")
            .expect("monster load should succeed")
            .expect("monster should exist");
        assert_eq!(target.name, "毒瘴蛊虫");
        let spirit_bag = target
            .drops
            .iter()
            .find(|entry| entry.name.starts_with("灵石袋"))
            .expect("spirit bag should exist");
        let bone = target
            .drops
            .iter()
            .find(|entry| entry.name == "幽冥骨片×1-2")
            .expect("bone should exist");
        assert_eq!(spirit_bag.quality, "黄");
        assert_eq!(bone.chance, "60%");
    }
}
