use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;

use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ItemDataCleanupSummary {
    pub valid_item_def_count: usize,
    pub removed_item_instance_count: usize,
    pub removed_item_use_cooldown_count: usize,
    pub removed_item_use_count_count: usize,
}

#[derive(Debug, Deserialize)]
struct ItemDataSeedFile {
    items: Vec<ItemDataSeed>,
}

#[derive(Debug, Deserialize)]
struct ItemDataSeed {
    id: Option<String>,
}

pub async fn cleanup_undefined_item_data_on_startup(
    state: &AppState,
) -> Result<ItemDataCleanupSummary, AppError> {
    let valid_item_def_ids = load_valid_item_def_ids()?;
    if valid_item_def_ids.is_empty() {
        return Err(AppError::config(
            "静态物品定义为空，已阻止启动清理，避免误删数据库物品数据",
        ));
    }

    state
        .database
        .with_transaction(|| async {
            let removed_item_instance_count = delete_undefined_item_def_rows(
                state,
                "item_instance",
                &valid_item_def_ids,
            )
            .await?;
            let removed_item_use_cooldown_count = delete_undefined_item_def_rows(
                state,
                "item_use_cooldown",
                &valid_item_def_ids,
            )
            .await?;
            let removed_item_use_count_count = delete_undefined_item_def_rows(
                state,
                "item_use_count",
                &valid_item_def_ids,
            )
            .await?;
            Ok(ItemDataCleanupSummary {
                valid_item_def_count: valid_item_def_ids.len(),
                removed_item_instance_count,
                removed_item_use_cooldown_count,
                removed_item_use_count_count,
            })
        })
        .await
}

fn load_valid_item_def_ids() -> Result<Vec<String>, AppError> {
    let mut ids = BTreeSet::new();
    for filename in ["item_def.json", "equipment_def.json", "gem_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: ItemDataSeedFile = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for item in payload.items {
            let Some(id) = item.id.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
                continue;
            };
            ids.insert(id.to_string());
        }
    }
    Ok(ids.into_iter().collect())
}

async fn delete_undefined_item_def_rows(
    state: &AppState,
    table: &str,
    valid_item_def_ids: &[String],
) -> Result<usize, AppError> {
    let sql = format!(
        "DELETE FROM {table} WHERE item_def_id IS NULL OR btrim(item_def_id) = '' OR NOT (btrim(item_def_id) = ANY($1::varchar[])) RETURNING 1"
    );
    let rows = state
        .database
        .fetch_all(&sql, |query| query.bind(valid_item_def_ids))
        .await?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::load_valid_item_def_ids;

    #[test]
    fn valid_item_def_ids_load_from_all_seed_files() {
        let ids = load_valid_item_def_ids().expect("item defs should load");
        assert!(!ids.is_empty());
        assert!(ids.iter().any(|id| id == "cons-001"));
        assert!(ids.iter().any(|id| id == "equip-weapon-001"));
        assert!(ids.iter().any(|id| id == "gem-atk-wg-1"));
        println!("ITEM_DATA_CLEANUP_VALID_IDS_COUNT={}", ids.len());
    }
}
