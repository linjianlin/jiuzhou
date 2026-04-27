use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
#[cfg(test)]
use std::sync::{Mutex, MutexGuard};
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct FrozenTowerSnapshotSeedRow {
    kind: String,
    realm: String,
    monster_def_id: String,
}

static FROZEN_TOWER_POOL_CACHE: OnceLock<RwLock<FrozenTowerPoolCache>> = OnceLock::new();
#[cfg(test)]
static FROZEN_TOWER_POOL_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn frozen_tower_pool_cache() -> &'static RwLock<FrozenTowerPoolCache> {
    FROZEN_TOWER_POOL_CACHE.get_or_init(|| RwLock::new(FrozenTowerPoolCache::default()))
}

const FROZEN_TOWER_REALM_ORDER: &[&str] = &[
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

fn parse_frozen_tower_frontier_floor(value: Option<i64>) -> Result<i64> {
    let frozen_floor_max =
        value.ok_or_else(|| anyhow::anyhow!("千层塔冻结数据字段非法: frozen_floor_max"))?;
    if frozen_floor_max < 0 {
        anyhow::bail!("千层塔冻结数据字段非法: frozen_floor_max");
    }
    Ok(frozen_floor_max)
}

fn parse_required_frozen_tower_text(value: &str, field_name: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        anyhow::bail!("千层塔冻结怪物快照 {field_name} 非法");
    }
    Ok(trimmed.to_string())
}

fn build_frozen_tower_pool_cache_from_rows(
    frozen_floor_max: i64,
    rows: Vec<FrozenTowerSnapshotSeedRow>,
    monster_name_map: &BTreeMap<String, String>,
) -> Result<FrozenTowerPoolCache> {
    let normalized_frozen_floor_max = frozen_floor_max.max(0);
    if rows.is_empty() {
        if normalized_frozen_floor_max == 0 {
            return Ok(FrozenTowerPoolCache {
                frozen_floor_max: 0,
                pools: BTreeMap::new(),
            });
        }
        anyhow::bail!("千层塔冻结怪物池缺失: frozen_floor_max={normalized_frozen_floor_max}");
    }

    let mut pools = BTreeMap::<(String, String), Vec<FrozenTowerMonsterEntry>>::new();
    for row in rows {
        let kind = parse_required_frozen_tower_text(&row.kind, "kind")?;
        if kind != "normal" && kind != "elite" && kind != "boss" {
            anyhow::bail!("千层塔冻结怪物快照 kind 非法: {kind}");
        }
        let realm = parse_required_frozen_tower_text(&row.realm, "realm")?;
        if !FROZEN_TOWER_REALM_ORDER.contains(&realm.as_str()) {
            anyhow::bail!("千层塔冻结怪物快照 realm 非法: {realm}");
        }
        let monster_def_id =
            parse_required_frozen_tower_text(&row.monster_def_id, "monster_def_id")?;
        let monster_name = monster_name_map
            .get(monster_def_id.as_str())
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("千层塔冻结怪物定义不存在: {monster_def_id}"))?;

        pools
            .entry((kind, realm))
            .or_default()
            .push(FrozenTowerMonsterEntry {
                monster_def_id,
                monster_name,
            });
    }

    for monsters in pools.values_mut() {
        monsters.sort_by(|left, right| left.monster_def_id.cmp(&right.monster_def_id));
    }

    Ok(FrozenTowerPoolCache {
        frozen_floor_max: normalized_frozen_floor_max,
        pools,
    })
}

#[cfg(test)]
pub fn frozen_tower_pool_test_guard() -> MutexGuard<'static, ()> {
    FROZEN_TOWER_POOL_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("frozen tower pool test lock should acquire")
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
    let frozen_floor_max = match frontier_row {
        Some(row) => {
            parse_frozen_tower_frontier_floor(row.try_get::<Option<i64>, _>("frozen_floor_max")?)?
        }
        None => 0,
    };

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
    let snapshot_seed_rows = snapshot_rows
        .iter()
        .map(|row| {
            Ok(FrozenTowerSnapshotSeedRow {
                kind: match row.try_get::<Option<String>, _>("kind")? {
                    Some(value) => value,
                    None => String::new(),
                },
                realm: match row.try_get::<Option<String>, _>("realm")? {
                    Some(value) => value,
                    None => String::new(),
                },
                monster_def_id: match row.try_get::<Option<String>, _>("monster_def_id")? {
                    Some(value) => value,
                    None => String::new(),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let next_cache = build_frozen_tower_pool_cache_from_rows(
        frozen_floor_max,
        snapshot_seed_rows,
        &monster_name_map,
    )?;
    let snapshot_count = next_cache.pools.values().map(Vec::len).sum();

    *frozen_tower_pool_cache()
        .write()
        .expect("frozen tower cache write lock should acquire") = next_cache;

    Ok(FrozenTowerPoolWarmupSummary {
        frozen_floor_max,
        snapshot_count,
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
    match cache
        .pools
        .get(&(kind.trim().to_string(), realm.trim().to_string()))
    {
        Some(monsters) => monsters.clone(),
        None => Vec::new(),
    }
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
    let overflow_tier_count = cycle_index.saturating_sub(realms.len().saturating_sub(1));
    if overflow_tier_count > 0 {
        let mut monsters = Vec::new();
        for realm in realms {
            monsters.extend(
                cache
                    .pools
                    .get(&(kind.trim().to_string(), realm.to_string()))
                    .cloned()
                    .unwrap_or(Vec::new()),
            );
        }
        return Some((format!("{realm}·混池"), monsters));
    }
    Some((
        realm.clone(),
        cache
            .pools
            .get(&(kind.trim().to_string(), realm))
            .cloned()
            .unwrap_or(Vec::new()),
    ))
}

pub fn resolve_frozen_tower_overflow_tier_count_for_floor(floor: i64, kind: &str) -> Option<i64> {
    let normalized_floor = floor.max(1);
    let cache = frozen_tower_pool_cache()
        .read()
        .expect("frozen tower cache read lock should acquire")
        .clone();
    if normalized_floor > cache.frozen_floor_max.max(0) {
        return None;
    }
    let realm_count = TOWER_REALM_ORDER
        .iter()
        .copied()
        .filter(|realm| {
            cache
                .pools
                .contains_key(&(kind.trim().to_string(), (*realm).to_string()))
        })
        .count();
    if realm_count == 0 {
        return Some(0);
    }
    let cycle_index = ((normalized_floor - 1) / 10).max(0);
    Some((cycle_index - (realm_count as i64 - 1)).max(0))
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
    build_monster_name_map_from_seeds(payload.monsters)
}

fn build_monster_name_map_from_seeds(
    monsters: Vec<MonsterSeed>,
) -> Result<BTreeMap<String, String>> {
    let mut monster_name_map = BTreeMap::new();
    for monster in monsters {
        if monster.enabled != Some(false) {
            let id = match monster.id.as_deref().map(str::trim) {
                Some(id) if !id.is_empty() => id,
                _ => anyhow::bail!("怪物定义 id 不能为空"),
            };
            let name = match monster.name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => name,
                _ => anyhow::bail!("怪物定义 name 不能为空: {id}"),
            };
            monster_name_map.insert(id.to_string(), name.to_string());
        }
    }
    Ok(monster_name_map)
}

#[cfg(test)]
mod tests {
    use super::{
        FrozenTowerMonsterEntry, FrozenTowerPoolCache, FrozenTowerPoolWarmupSummary,
        FrozenTowerSnapshotSeedRow, lookup_frozen_tower_monsters,
    };
    use std::collections::BTreeMap;

    #[test]
    fn frozen_tower_pool_summary_defaults_to_zero() {
        let summary = FrozenTowerPoolWarmupSummary::default();
        assert_eq!(summary.frozen_floor_max, 0);
        assert_eq!(summary.snapshot_count, 0);
    }

    #[test]
    fn frozen_tower_pool_rejects_missing_snapshot_rows_when_frontier_is_positive() {
        let monster_name_map =
            BTreeMap::from([("monster-gray-wolf".to_string(), "灰狼".to_string())]);

        let error =
            super::build_frozen_tower_pool_cache_from_rows(10, Vec::new(), &monster_name_map)
                .expect_err("positive frontier without snapshot rows must fail");

        assert_eq!(
            error.to_string(),
            "千层塔冻结怪物池缺失: frozen_floor_max=10"
        );
    }

    #[test]
    fn frozen_tower_pool_rejects_blank_snapshot_fields() {
        let monster_name_map =
            BTreeMap::from([("monster-gray-wolf".to_string(), "灰狼".to_string())]);

        let cases = [
            (
                FrozenTowerSnapshotSeedRow {
                    kind: " ".to_string(),
                    realm: "炼精化炁·养气期".to_string(),
                    monster_def_id: "monster-gray-wolf".to_string(),
                },
                "千层塔冻结怪物快照 kind 非法",
            ),
            (
                FrozenTowerSnapshotSeedRow {
                    kind: "normal".to_string(),
                    realm: " ".to_string(),
                    monster_def_id: "monster-gray-wolf".to_string(),
                },
                "千层塔冻结怪物快照 realm 非法",
            ),
            (
                FrozenTowerSnapshotSeedRow {
                    kind: "normal".to_string(),
                    realm: "炼精化炁·养气期".to_string(),
                    monster_def_id: " ".to_string(),
                },
                "千层塔冻结怪物快照 monster_def_id 非法",
            ),
        ];

        for (row, expected_error) in cases {
            let error =
                super::build_frozen_tower_pool_cache_from_rows(10, vec![row], &monster_name_map)
                    .expect_err("blank snapshot field must fail");

            assert_eq!(error.to_string(), expected_error);
        }
    }

    #[test]
    fn frozen_tower_pool_rejects_unknown_realm() {
        let monster_name_map =
            BTreeMap::from([("monster-gray-wolf".to_string(), "灰狼".to_string())]);

        let error = super::build_frozen_tower_pool_cache_from_rows(
            10,
            vec![FrozenTowerSnapshotSeedRow {
                kind: "normal".to_string(),
                realm: "大乘".to_string(),
                monster_def_id: "monster-gray-wolf".to_string(),
            }],
            &monster_name_map,
        )
        .expect_err("unknown realm must fail");

        assert_eq!(error.to_string(), "千层塔冻结怪物快照 realm 非法: 大乘");
    }

    #[test]
    fn frozen_tower_pool_rejects_unknown_monster_definition() {
        let monster_name_map =
            BTreeMap::from([("monster-gray-wolf".to_string(), "灰狼".to_string())]);

        let error = super::build_frozen_tower_pool_cache_from_rows(
            10,
            vec![FrozenTowerSnapshotSeedRow {
                kind: "normal".to_string(),
                realm: "炼精化炁·养气期".to_string(),
                monster_def_id: "monster-missing".to_string(),
            }],
            &monster_name_map,
        )
        .expect_err("unknown monster definition must fail");

        assert_eq!(
            error.to_string(),
            "千层塔冻结怪物定义不存在: monster-missing"
        );
    }

    #[test]
    fn frozen_tower_pool_frontier_floor_rejects_negative_value() {
        let error = super::parse_frozen_tower_frontier_floor(Some(-1))
            .expect_err("negative frozen frontier must fail");

        assert_eq!(
            error.to_string(),
            "千层塔冻结数据字段非法: frozen_floor_max"
        );
    }

    #[test]
    fn frozen_tower_pool_monster_name_map_rejects_enabled_monster_with_blank_id_or_name() {
        let blank_id_error = super::build_monster_name_map_from_seeds(vec![super::MonsterSeed {
            id: Some(" ".to_string()),
            name: Some("灰狼".to_string()),
            enabled: None,
        }])
        .expect_err("blank id must fail");

        assert_eq!(blank_id_error.to_string(), "怪物定义 id 不能为空");

        let blank_name_error = super::build_monster_name_map_from_seeds(vec![super::MonsterSeed {
            id: Some("monster-gray-wolf".to_string()),
            name: Some(" ".to_string()),
            enabled: None,
        }])
        .expect_err("blank name must fail");

        assert_eq!(
            blank_name_error.to_string(),
            "怪物定义 name 不能为空: monster-gray-wolf"
        );
    }

    #[test]
    fn lookup_frozen_tower_monsters_respects_frontier_and_pool_key() {
        let _guard = super::frozen_tower_pool_test_guard();
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
