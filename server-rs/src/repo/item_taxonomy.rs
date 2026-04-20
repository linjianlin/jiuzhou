use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::shared::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct ItemTaxonomyOptionDto {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameItemTaxonomyDto {
    pub categories: GameItemTaxonomyCategorySection,
    pub sub_categories: GameItemTaxonomySubCategorySection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameItemTaxonomyCategorySection {
    pub all: ItemTaxonomyOptionDto,
    pub options: Vec<ItemTaxonomyOptionDto>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameItemTaxonomySubCategorySection {
    pub options: Vec<ItemTaxonomyOptionDto>,
    pub labels: BTreeMap<String, String>,
    pub by_category: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct ItemDefFile {
    items: Vec<ItemDefSeed>,
}

#[derive(Debug, Deserialize)]
struct ItemDefSeed {
    id: Option<String>,
    category: Option<String>,
    sub_category: Option<String>,
    enabled: Option<bool>,
}

const CATEGORY_PREFERRED_ORDER: &[&str] = &[
    "consumable",
    "material",
    "gem",
    "equipment",
    "quest",
    "other",
];

pub fn build_game_item_taxonomy() -> Result<GameItemTaxonomyDto, AppError> {
    let seeds = load_merged_item_seeds()?;
    let mut category_set = BTreeSet::new();
    let mut sub_category_labels = BTreeMap::new();
    let mut by_category: BTreeMap<String, Vec<String>> =
        BTreeMap::from([("all".to_string(), Vec::new())]);

    for item in seeds
        .into_iter()
        .filter(|entry| entry.enabled != Some(false))
    {
        let category = normalize_token(item.category.as_deref());
        if !category.is_empty() {
            category_set.insert(category.clone());
            by_category.entry(category.clone()).or_default();
        }

        let sub_category = normalize_token(item.sub_category.as_deref());
        if sub_category.is_empty() {
            continue;
        }

        sub_category_labels
            .entry(sub_category.clone())
            .or_insert_with(|| sub_category_label(sub_category.as_str()));
        push_unique(
            by_category.entry("all".to_string()).or_default(),
            sub_category.clone(),
        );
        if !category.is_empty() {
            push_unique(by_category.entry(category).or_default(), sub_category);
        }
    }

    let category_values = sort_category_values(category_set.into_iter().collect());
    let mut category_labels = BTreeMap::from([("all".to_string(), "全部".to_string())]);
    for category in &category_values {
        category_labels.insert(category.clone(), category_label(category));
        by_category.entry(category.clone()).or_default();
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
        .collect();

    let mut sub_category_options: Vec<ItemTaxonomyOptionDto> = sub_category_labels
        .iter()
        .map(|(value, label)| ItemTaxonomyOptionDto {
            value: value.clone(),
            label: label.clone(),
        })
        .collect();
    sub_category_options.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.value.cmp(&right.value))
    });

    Ok(GameItemTaxonomyDto {
        categories: GameItemTaxonomyCategorySection {
            all: ItemTaxonomyOptionDto {
                value: "all".to_string(),
                label: "全部".to_string(),
            },
            options: category_options,
            labels: category_labels,
        },
        sub_categories: GameItemTaxonomySubCategorySection {
            options: sub_category_options,
            labels: sub_category_labels,
            by_category: by_category,
        },
    })
}

fn read_item_seed_file(filename: &str) -> Result<ItemDefFile, AppError> {
    let path = item_seed_path(filename);
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))
}

fn item_seed_path(filename: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}"))
}

fn load_merged_item_seeds() -> Result<Vec<ItemDefSeed>, AppError> {
    let mut by_id: BTreeMap<String, ItemDefSeed> = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let file = read_item_seed_file(filename)?;
        for item in file.items {
            let id = normalize_token(item.id.as_deref());
            if id.is_empty() {
                continue;
            }
            by_id.insert(id, item);
        }
    }
    Ok(by_id.into_values().collect())
}

fn normalize_token(raw: Option<&str>) -> String {
    raw.unwrap_or_default().trim().to_lowercase()
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

fn sort_category_values(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| {
        let left_rank = CATEGORY_PREFERRED_ORDER
            .iter()
            .position(|value| *value == left);
        let right_rank = CATEGORY_PREFERRED_ORDER
            .iter()
            .position(|value| *value == right);
        match (left_rank, right_rank) {
            (Some(l), Some(r)) => l.cmp(&r),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => left.cmp(right),
        }
    });
    values
}

fn category_label(value: &str) -> String {
    match value {
        "consumable" => "消耗品",
        "material" => "材料",
        "gem" => "宝石",
        "equipment" => "装备",
        "quest" => "任务",
        "other" => "其他",
        _ => value,
    }
    .to_string()
}

fn sub_category_label(value: &str) -> String {
    match value {
        "sword" => "剑",
        "blade" => "刀",
        "staff" => "法杖",
        "shield" => "盾牌",
        "helmet" => "头盔",
        "hat" => "帽子",
        "robe" => "法袍",
        "gloves" => "手套",
        "gauntlets" => "臂甲",
        "pants" => "下装",
        "legguards" => "护腿",
        "ring" => "戒指",
        "necklace" => "项链",
        "talisman" => "法宝（护符）",
        "mirror" => "宝镜",
        "accessory" => "饰品",
        "armor" => "护甲",
        "battle_pass" => "战令道具",
        "bone" => "骨材",
        "box" => "宝箱",
        "breakthrough" => "突破道具",
        "collect" => "采集物",
        "egg" => "蛋类",
        "enhance" => "强化道具",
        "essence" => "精华",
        "forge" => "锻造材料",
        "function" => "功能道具",
        "gem" => "宝石",
        "gem_attack" => "攻击宝石",
        "gem_defense" => "防御宝石",
        "gem_survival" => "生存宝石",
        "gem_all" => "通用宝石",
        "herb" => "灵草",
        "key" => "钥匙",
        "leather" => "皮革",
        "month_card" => "月卡道具",
        "object" => "杂项道具",
        "ore" => "矿石",
        "pill" => "丹药",
        "relic" => "遗物",
        "scroll" => "卷轴",
        "technique" => "功法材料",
        "technique_book" => "功法书",
        "token" => "法宝",
        "wood" => "木材",
        _ => value,
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    #[test]
    fn taxonomy_reads_seed_file() {
        let taxonomy = super::build_game_item_taxonomy().expect("taxonomy should build");
        assert!(!taxonomy.categories.options.is_empty());
        assert!(taxonomy.sub_categories.labels.contains_key("pill"));
        assert!(taxonomy.categories.labels.contains_key("equipment"));
        assert!(taxonomy.sub_categories.by_category.contains_key("gem"));
    }
}
