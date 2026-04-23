use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use anyhow::Result;
use serde::Deserialize;
use sqlx::Row;

use crate::state::AppState;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FrozenTowerPoolWarmupSummary {
    pub frozen_floor_max: i64,
    pub snapshot_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenTowerMonsterEntry {
    pub monster_def_id: String,
    pub monster_name: String,
}

#[derive(Debug, Clone, Default)]
struct FrozenTowerPoolCache {
    frozen_floor_max: i64,
    pools: BTreeMap<(String, String), Vec<FrozenTowerMonsterEntry>>,
}

#[derive(Debug, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Deserialize)]
struct MonsterSeed {
    id: Option<String>,
    name: Option<String>,
    enabled: Option<bool>,
}

static FROZEN_TOWER_POOL_CACHE: OnceLock<RwLock<FrozenTowerPoolCache>> = OnceLock::new();

fn frozen_tower_pool_cache() -> &'static RwLock<FrozenTowerPoolCache> {
    FROZEN_TOWER_POOL_CACHE.get_or_init(|| RwLock::new(FrozenTowerPoolCache::default()))
}

pub async fn warmup_frozen_tower_pool_cache(
    state: &AppState,
) -> Result<FrozenTowerPoolWarmupSummary> {
    let frontier_row = state
        .database
        .fetch_optional(
            "SELECT frozen_floor_max FROM tower_frozen_frontier WHERE scope = 'tower' LIMIT 1",
            |q| q,
        )
        .await?;
    let frozen_floor_max = frontier_row
        .and_then(|row| {
            row.try_get::<Option<i64>, _>("frozen_floor_max")
                .ok()
                .flatten()
        })
        .unwrap_or_default()
        .max(0);

    let snapshot_rows = if frozen_floor_max > 0 {
        state
            .database
            .fetch_all(
                "SELECT kind, realm, monster_def_id FROM tower_frozen_monster_snapshot WHERE frozen_floor_max = $1 ORDER BY kind ASC, realm ASC, monster_def_id ASC",
                |q| q.bind(frozen_floor_max),
            )
            .await?
    } else {
        Vec::new()
    };

    let monster_name_map = load_monster_name_map()?;
    let mut pools = BTreeMap::<(String, String), Vec<FrozenTowerMonsterEntry>>::new();
    for row in &snapshot_rows {
        let kind = row
            .try_get::<Option<String>, _>("kind")?
            .unwrap_or_default();
        let realm = row
            .try_get::<Option<String>, _>("realm")?
            .unwrap_or_default();
        let monster_def_id = row
            .try_get::<Option<String>, _>("monster_def_id")?
            .unwrap_or_default();
        if kind.trim().is_empty() || realm.trim().is_empty() || monster_def_id.trim().is_empty() {
            continue;
        }
        let monster_name = monster_name_map
            .get(monster_def_id.as_str())
            .cloned()
            .unwrap_or_else(|| monster_def_id.clone());
        pools
            .entry((kind, realm))
            .or_default()
            .push(FrozenTowerMonsterEntry {
                monster_def_id,
                monster_name,
            });
    }

    *frozen_tower_pool_cache()
        .write()
        .expect("frozen tower cache write lock should acquire") = FrozenTowerPoolCache {
        frozen_floor_max,
        pools,
    };

    Ok(FrozenTowerPoolWarmupSummary {
        frozen_floor_max,
        snapshot_count: snapshot_rows.len(),
    })
}

pub fn lookup_frozen_tower_monsters(
    floor: i64,
    kind: &str,
    realm: &str,
) -> Vec<FrozenTowerMonsterEntry> {
    let cache = frozen_tower_pool_cache()
        .read()
        .expect("frozen tower cache read lock should acquire")
        .clone();
    if floor > cache.frozen_floor_max.max(0) {
        return Vec::new();
    }
    cache
        .pools
        .get(&(kind.trim().to_string(), realm.trim().to_string()))
        .cloned()
        .unwrap_or_default()
}

const TOWER_REALM_ORDER: &[&str] = &[
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
    "大乘",
];

pub fn resolve_frozen_tower_monsters_for_floor(
    floor: i64,
    kind: &str,
) -> Option<(String, Vec<FrozenTowerMonsterEntry>)> {
    let normalized_floor = floor.max(1);
    let cache = frozen_tower_pool_cache()
        .read()
        .expect("frozen tower cache read lock should acquire")
        .clone();
    if normalized_floor > cache.frozen_floor_max.max(0) {
        return None;
    }

    let realms = TOWER_REALM_ORDER
        .iter()
        .copied()
        .filter(|realm| {
            cache
                .pools
                .contains_key(&(kind.trim().to_string(), (*realm).to_string()))
        })
        .collect::<Vec<_>>();
    if realms.is_empty() {
        return Some((String::new(), Vec::new()));
    }

    let cycle_index = ((normalized_floor - 1) / 10).max(0) as usize;
    let realm = realms[cycle_index.min(realms.len() - 1)].to_string();
    let monsters = cache
        .pools
        .get(&(kind.trim().to_string(), realm.clone()))
        .cloned()
        .unwrap_or_default();
    Some((realm, monsters))
}

#[cfg(test)]
pub fn replace_frozen_tower_pool_cache_for_tests(
    frozen_floor_max: i64,
    pools: BTreeMap<(String, String), Vec<FrozenTowerMonsterEntry>>,
) {
    *frozen_tower_pool_cache()
        .write()
        .expect("frozen tower cache write lock should acquire") = FrozenTowerPoolCache {
        frozen_floor_max,
        pools,
    };
}

fn load_monster_name_map() -> Result<BTreeMap<String, String>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)?;
    let payload: MonsterSeedFile = serde_json::from_str(&content)?;
    Ok(payload
        .monsters
        .into_iter()
        .filter(|monster| monster.enabled != Some(false))
        .filter_map(|monster| {
            monster
                .id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(|id| {
                    (
                        id.to_string(),
                        monster.name.unwrap_or_else(|| id.to_string()),
                    )
                })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        FrozenTowerMonsterEntry, FrozenTowerPoolCache, FrozenTowerPoolWarmupSummary,
        lookup_frozen_tower_monsters,
    };
    use std::collections::BTreeMap;

    #[test]
    fn frozen_tower_pool_summary_defaults_to_zero() {
        let summary = FrozenTowerPoolWarmupSummary::default();
        assert_eq!(summary.frozen_floor_max, 0);
        assert_eq!(summary.snapshot_count, 0);
    }

    #[test]
    fn lookup_frozen_tower_monsters_respects_frontier_and_pool_key() {
        let mut pools = BTreeMap::new();
        pools.insert(
            ("normal".to_string(), "炼精化炁·养气期".to_string()),
            vec![FrozenTowerMonsterEntry {
                monster_def_id: "monster-gray-wolf".to_string(),
                monster_name: "灰狼".to_string(),
            }],
        );
        *super::frozen_tower_pool_cache()
            .write()
            .expect("cache write lock") = FrozenTowerPoolCache {
            frozen_floor_max: 10,
            pools,
        };

        assert_eq!(
            lookup_frozen_tower_monsters(5, "normal", "炼精化炁·养气期").len(),
            1
        );
        assert!(lookup_frozen_tower_monsters(11, "normal", "炼精化炁·养气期").is_empty());
    }
}
