use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::{build_minimal_pve_battle_state, restart_battle_runtime};
use crate::integrations::battle_character_profile::{
    hydrate_pve_battle_state_active_partner, hydrate_pve_battle_state_owner,
    hydrate_pve_battle_state_participants,
};
use crate::jobs::online_battle_settlement::{
    DungeonClearSettlementTaskPayload, enqueue_dungeon_clear_settlement_task,
};
use crate::realtime::battle::{
    build_battle_abandoned_payload, build_battle_cooldown_ready_payload,
    build_battle_started_payload,
};
use crate::realtime::public_socket::{
    emit_battle_cooldown_to_participants, emit_battle_update_to_participants,
};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::{AppState, OnlineBattleProjectionRecord};

#[derive(Debug, Clone, Serialize)]
pub struct DungeonCategoryDto {
    pub r#type: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonDefDto {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub background: Option<String>,
    pub min_players: i64,
    pub max_players: i64,
    pub min_realm: Option<String>,
    pub recommended_realm: Option<String>,
    pub unlock_condition: serde_json::Value,
    pub daily_limit: i64,
    pub weekly_limit: i64,
    pub stamina_cost: i64,
    pub time_limit_sec: i64,
    pub revive_limit: i64,
    pub tags: serde_json::Value,
    pub sort_weight: i64,
    pub enabled: bool,
    pub version: i64,
}

#[derive(Debug, Deserialize)]
pub struct DungeonListQuery {
    pub r#type: Option<String>,
    pub q: Option<String>,
    pub realm: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DungeonPreviewQuery {
    pub rank: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonDifficultyDto {
    pub id: String,
    pub name: String,
    pub difficulty_rank: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewEntryDto {
    pub daily_limit: i64,
    pub weekly_limit: i64,
    pub daily_used: i64,
    pub weekly_used: i64,
    pub daily_remaining: Option<i64>,
    pub weekly_remaining: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewMonsterDto {
    pub id: String,
    pub name: String,
    pub realm: Option<String>,
    pub level: i64,
    pub avatar: Option<String>,
    pub kind: Option<String>,
    pub count: i64,
    pub drop_pool_id: Option<String>,
    pub drop_preview: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewWaveDto {
    pub wave_index: i64,
    pub spawn_delay_sec: i64,
    pub monsters: Vec<DungeonPreviewMonsterDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewStageDto {
    pub id: String,
    pub stage_index: i64,
    pub name: Option<String>,
    pub r#type: String,
    pub waves: Vec<DungeonPreviewWaveDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewDropItemDto {
    pub id: String,
    pub name: String,
    pub quality: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonPreviewDataDto {
    pub dungeon: Option<DungeonDefDto>,
    pub difficulty: Option<DungeonDifficultyDto>,
    pub entry: Option<DungeonPreviewEntryDto>,
    pub stages: Vec<DungeonPreviewStageDto>,
    pub drop_items: Vec<DungeonPreviewDropItemDto>,
    pub drop_sources: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDungeonInstancePayload {
    pub dungeon_id: Option<String>,
    pub difficulty_rank: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceParticipantDto {
    pub user_id: i64,
    pub character_id: i64,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDungeonInstanceDataDto {
    pub instance_id: String,
    pub status: String,
    pub participants: Vec<DungeonInstanceParticipantDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceActionPayload {
    pub instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceSnapshotDto {
    pub id: String,
    pub dungeon_id: String,
    pub difficulty_id: String,
    pub difficulty_rank: i64,
    pub status: String,
    pub current_stage: i64,
    pub current_wave: i64,
    pub participants: Vec<DungeonInstanceParticipantDto>,
    pub current_battle_id: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub time_spent_sec: i64,
    pub total_damage: i64,
    pub death_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceQueryDataDto {
    pub instance: DungeonInstanceSnapshotDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceStartDataDto {
    pub instance_id: String,
    pub status: String,
    pub battle_id: String,
    pub state: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonInstanceNextDataDto {
    pub instance_id: String,
    pub status: String,
    pub battle_id: Option<String>,
    pub state: Option<serde_json::Value>,
    pub finished: bool,
}

#[derive(Debug, Deserialize)]
struct DungeonSeedFile {
    dungeons: Vec<DungeonSeedEntry>,
}

#[derive(Debug, Deserialize)]
struct DungeonSeedEntry {
    def: serde_json::Value,
    difficulties: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ItemSeedFile {
    items: Vec<serde_json::Value>,
}

pub async fn get_dungeon_categories() -> Result<Json<SuccessResponse<serde_json::Value>>, AppError>
{
    let defs = load_all_dungeon_defs()?;
    let mut counts = BTreeMap::<String, i64>::new();
    for def in defs {
        *counts.entry(def.r#type.clone()).or_insert(0) += 1;
    }
    let ordered = [
        ("material", "材料秘境"),
        ("equipment", "装备秘境"),
        ("trial", "试炼秘境"),
        ("challenge", "挑战秘境"),
        ("event", "活动秘境"),
    ];
    let categories = ordered
        .into_iter()
        .map(|(kind, label)| DungeonCategoryDto {
            r#type: kind.to_string(),
            label: label.to_string(),
            count: counts.get(kind).copied().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    Ok(send_success(
        serde_json::json!({ "categories": categories }),
    ))
}

pub async fn get_dungeon_list(
    Query(query): Query<DungeonListQuery>,
) -> Result<Json<SuccessResponse<serde_json::Value>>, AppError> {
    let keyword = query.q.as_deref().unwrap_or_default().trim().to_lowercase();
    let realm = query
        .realm
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    let dungeon_type = query
        .r#type
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    let mut dungeons = load_all_dungeon_defs()?;
    dungeons.retain(|entry| {
        if !dungeon_type.is_empty() && entry.r#type != dungeon_type {
            return false;
        }
        if !keyword.is_empty() {
            let name = entry.name.to_lowercase();
            let category = entry.category.as_deref().unwrap_or_default().to_lowercase();
            if !name.contains(&keyword) && !category.contains(&keyword) {
                return false;
            }
        }
        if !realm.is_empty() {
            if let Some(min_realm) = entry.min_realm.as_deref() {
                if realm_rank(&realm) < realm_rank(min_realm) {
                    return false;
                }
            }
        }
        true
    });
    dungeons.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(send_success(serde_json::json!({ "dungeons": dungeons })))
}

pub async fn get_dungeon_preview(
    Path(id): Path<String>,
    Query(query): Query<DungeonPreviewQuery>,
) -> Result<Json<SuccessResponse<DungeonPreviewDataDto>>, AppError> {
    let rank = query.rank.unwrap_or(1).max(1);
    let Some(entry) = load_dungeon_entry(&id)? else {
        return Err(AppError::not_found("秘境不存在"));
    };
    let dungeon = map_dungeon_def(&entry.def)?;
    let difficulty = entry
        .difficulties
        .iter()
        .find(|row| {
            row.get("difficulty_rank")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                == rank
        })
        .cloned();
    let Some(difficulty) = difficulty else {
        return Ok(send_success(DungeonPreviewDataDto {
            dungeon: Some(dungeon),
            difficulty: None,
            entry: None,
            stages: Vec::new(),
            drop_items: Vec::new(),
            drop_sources: Vec::new(),
        }));
    };
    let monster_map = load_monster_seed_map()?;
    let item_map = load_item_seed_map()?;
    let stages_value = difficulty
        .get("stages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut drop_item_ids = BTreeMap::<String, DungeonPreviewDropItemDto>::new();
    let stages = stages_value
        .into_iter()
        .map(|stage| {
            let waves = stage
                .get("waves")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|wave| {
                    let monsters = wave
                        .get("monsters")
                        .and_then(|value| value.as_array())
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|monster| {
                            let monster_id = monster
                                .get("monster_def_id")
                                .and_then(|value| value.as_str())
                                .unwrap_or_default()
                                .to_string();
                            let meta = monster_map
                                .get(&monster_id)
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            if let Some(rewards) = difficulty
                                .get("first_clear_rewards")
                                .and_then(|v| v.get("items"))
                                .and_then(|v| v.as_array())
                            {
                                for reward in rewards {
                                    if let Some(item_id) =
                                        reward.get("item_def_id").and_then(|value| value.as_str())
                                    {
                                        if let Some(item_def) = item_map.get(item_id) {
                                            drop_item_ids.entry(item_id.to_string()).or_insert(
                                                DungeonPreviewDropItemDto {
                                                    id: item_id.to_string(),
                                                    name: item_def
                                                        .get("name")
                                                        .and_then(|value| value.as_str())
                                                        .unwrap_or(item_id)
                                                        .to_string(),
                                                    quality: item_def
                                                        .get("quality")
                                                        .and_then(|value| value.as_str())
                                                        .map(|value| value.to_string()),
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                            DungeonPreviewMonsterDto {
                                id: monster_id.clone(),
                                name: meta
                                    .get("name")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or(&monster_id)
                                    .to_string(),
                                realm: meta
                                    .get("realm")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string()),
                                level: meta
                                    .get("level")
                                    .and_then(|value| value.as_i64())
                                    .unwrap_or_default(),
                                avatar: meta
                                    .get("avatar")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string()),
                                kind: meta
                                    .get("kind")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string()),
                                count: monster
                                    .get("count")
                                    .and_then(|value| value.as_i64())
                                    .unwrap_or(1),
                                drop_pool_id: meta
                                    .get("drop_pool_id")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.to_string()),
                                drop_preview: Vec::new(),
                            }
                        })
                        .collect::<Vec<_>>();
                    DungeonPreviewWaveDto {
                        wave_index: wave
                            .get("wave_index")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(1),
                        spawn_delay_sec: wave
                            .get("spawn_delay_sec")
                            .and_then(|value| value.as_i64())
                            .unwrap_or_default(),
                        monsters,
                    }
                })
                .collect::<Vec<_>>();
            DungeonPreviewStageDto {
                id: stage
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                stage_index: stage
                    .get("stage_index")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1),
                name: stage
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                r#type: stage
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("battle")
                    .to_string(),
                waves,
            }
        })
        .collect::<Vec<_>>();
    let difficulty_dto = DungeonDifficultyDto {
        id: difficulty
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        name: difficulty
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        difficulty_rank: difficulty
            .get("difficulty_rank")
            .and_then(|value| value.as_i64())
            .unwrap_or(1),
    };
    Ok(send_success(DungeonPreviewDataDto {
        dungeon: Some(dungeon),
        difficulty: Some(difficulty_dto),
        entry: None,
        stages,
        drop_items: drop_item_ids.into_values().collect(),
        drop_sources: Vec::new(),
    }))
}

pub async fn create_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateDungeonInstancePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let dungeon_id = payload.dungeon_id.unwrap_or_default();
    let difficulty_rank = payload.difficulty_rank.unwrap_or(1).max(1);
    if dungeon_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<CreateDungeonInstanceDataDto> {
            success: false,
            message: Some("缺少秘境ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            create_dungeon_instance_tx(&state, actor.user_id, dungeon_id.trim(), difficulty_rank)
                .await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn get_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let result = get_dungeon_instance_tx(&state, actor.user_id, id.trim()).await?;
    Ok(send_result(result))
}

pub async fn join_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DungeonInstanceActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let instance_id = payload.instance_id.unwrap_or_default();
    if instance_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<CreateDungeonInstanceDataDto> {
            success: false,
            message: Some("缺少实例ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            join_dungeon_instance_tx(&state, actor.user_id, instance_id.trim()).await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn get_dungeon_instance_by_battle_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(battle_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let result =
        get_dungeon_instance_by_battle_id_tx(&state, actor.user_id, battle_id.trim()).await?;
    Ok(send_result(result))
}

pub async fn start_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DungeonInstanceActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let instance_id = payload.instance_id.unwrap_or_default();
    if instance_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<DungeonInstanceStartDataDto> {
            success: false,
            message: Some("缺少实例ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            start_dungeon_instance_tx(&state, actor.user_id, instance_id.trim()).await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn abandon_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DungeonInstanceActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let instance_id = payload.instance_id.unwrap_or_default();
    if instance_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<DungeonInstanceQueryDataDto> {
            success: false,
            message: Some("缺少实例ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            abandon_dungeon_instance_tx(&state, actor.user_id, instance_id.trim()).await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn next_dungeon_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DungeonInstanceActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let instance_id = payload.instance_id.unwrap_or_default();
    if instance_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<DungeonInstanceNextDataDto> {
            success: false,
            message: Some("缺少实例ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            next_dungeon_instance_tx(&state, actor.user_id, instance_id.trim()).await
        })
        .await?;
    Ok(send_result(result))
}

fn load_all_dungeon_defs() -> Result<Vec<DungeonDefDto>, AppError> {
    let mut out = Vec::new();
    for path in glob_dungeon_seed_paths()? {
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: DungeonSeedFile = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for entry in payload.dungeons {
            let def = map_dungeon_def(&entry.def)?;
            if def.enabled {
                out.push(def);
            }
        }
    }
    Ok(out)
}

fn load_dungeon_entry(dungeon_id: &str) -> Result<Option<DungeonSeedEntry>, AppError> {
    for path in glob_dungeon_seed_paths()? {
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: DungeonSeedFile = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for entry in payload.dungeons {
            if entry.def.get("id").and_then(|value| value.as_str()) == Some(dungeon_id) {
                return Ok(Some(entry));
            }
        }
    }
    Ok(None)
}

pub(crate) fn load_dungeon_wave_monster_ids(
    dungeon_id: &str,
    difficulty_id: &str,
    stage_index: i64,
    wave_index: i64,
) -> Result<Vec<String>, AppError> {
    let Some(entry) = load_dungeon_entry(dungeon_id)? else {
        return Ok(Vec::new());
    };
    let Some(difficulty) = entry
        .difficulties
        .iter()
        .find(|diff| diff.get("id").and_then(|v| v.as_str()) == Some(difficulty_id))
    else {
        return Ok(Vec::new());
    };
    let stages = difficulty
        .get("stages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let monster_ids = stages
        .iter()
        .find(|stage| stage.get("stage_index").and_then(|v| v.as_i64()) == Some(stage_index))
        .and_then(|stage| stage.get("waves").and_then(|v| v.as_array()))
        .and_then(|waves| {
            waves
                .iter()
                .find(|wave| wave.get("wave_index").and_then(|v| v.as_i64()) == Some(wave_index))
        })
        .map(build_wave_monster_ids)
        .unwrap_or_default();
    if monster_ids.is_empty() {
        return Ok(vec![format!(
            "dungeon-monster-{}-{}",
            stage_index.max(1),
            wave_index.max(1)
        )]);
    }
    Ok(monster_ids)
}

fn glob_dungeon_seed_paths() -> Result<Vec<PathBuf>, AppError> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds");
    let mut paths = fs::read_dir(&base)
        .map_err(|error| {
            AppError::config(format!(
                "failed to read dungeon seed dir {}: {error}",
                base.display()
            ))
        })?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|v| v.to_str())
                .map(|name| name.starts_with("dungeon_") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    paths.sort();
    Ok(paths)
}

fn map_dungeon_def(value: &serde_json::Value) -> Result<DungeonDefDto, AppError> {
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if id.is_empty() {
        return Err(AppError::config("dungeon def missing id"));
    }
    Ok(DungeonDefDto {
        id,
        name: value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        r#type: value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        category: value
            .get("category")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        description: value
            .get("description")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        icon: value
            .get("icon")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        background: value
            .get("background")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        min_players: value
            .get("min_players")
            .and_then(|v| v.as_i64())
            .unwrap_or(1),
        max_players: value
            .get("max_players")
            .and_then(|v| v.as_i64())
            .unwrap_or(5),
        min_realm: value
            .get("min_realm")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        recommended_realm: value
            .get("recommended_realm")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        unlock_condition: value
            .get("unlock_condition")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        daily_limit: value
            .get("daily_limit")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        weekly_limit: value
            .get("weekly_limit")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        stamina_cost: value
            .get("stamina_cost")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        time_limit_sec: value
            .get("time_limit_sec")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        revive_limit: value
            .get("revive_limit")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        tags: value
            .get("tags")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        sort_weight: value
            .get("sort_weight")
            .and_then(|v| v.as_i64())
            .unwrap_or_default(),
        enabled: value
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        version: value.get("version").and_then(|v| v.as_i64()).unwrap_or(1),
    })
}

fn load_monster_seed_map() -> Result<BTreeMap<String, serde_json::Value>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: MonsterSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    Ok(payload
        .monsters
        .into_iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(|v| v.as_str())
                .map(|id| (id.to_string(), row.clone()))
        })
        .collect())
}

fn load_item_seed_map() -> Result<BTreeMap<String, serde_json::Value>, AppError> {
    let mut out = BTreeMap::new();
    for filename in ["item_def.json", "equipment_def.json", "gem_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: ItemSeedFile = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for row in payload.items {
            if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
                out.insert(id.to_string(), row.clone());
            }
        }
    }
    Ok(out)
}

fn realm_rank(realm: &str) -> i64 {
    const ORDER: &[&str] = &[
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
    ORDER
        .iter()
        .position(|item| *item == realm.trim())
        .map(|idx| idx as i64 + 1)
        .unwrap_or(0)
}

async fn create_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    dungeon_id: &str,
    difficulty_rank: i64,
) -> Result<ServiceResult<CreateDungeonInstanceDataDto>, AppError> {
    let Some(character_row) = state
        .database
        .fetch_optional(
            "SELECT id, realm, sub_realm FROM characters WHERE user_id = $1 LIMIT 1",
            |q| q.bind(user_id),
        )
        .await?
    else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let character_id = i64::from(character_row.try_get::<i32, _>("id")?);
    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row
        .try_get::<Option<String>, _>("sub_realm")?
        .unwrap_or_default();
    let full_realm = if realm.trim() == "凡人" || sub_realm.trim().is_empty() {
        realm.clone()
    } else {
        format!("{}·{}", realm.trim(), sub_realm.trim())
    };

    let Some(entry) = load_dungeon_entry(dungeon_id)? else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境不存在".to_string()),
            data: None,
        });
    };
    let dungeon = map_dungeon_def(&entry.def)?;
    let difficulty = entry
        .difficulties
        .iter()
        .find(|row| {
            row.get("difficulty_rank")
                .and_then(|value| value.as_i64())
                .unwrap_or(1)
                == difficulty_rank
        })
        .cloned();
    let Some(difficulty) = difficulty else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境难度不存在".to_string()),
            data: None,
        });
    };

    let team_members = state.database.fetch_all(
        "SELECT tm.team_id, tm.role, tm.character_id, c.user_id FROM team_members tm JOIN characters c ON c.id = tm.character_id WHERE tm.team_id = (SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1) ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, tm.character_id ASC",
        |q| q.bind(character_id),
    ).await?;
    let mut team_id = None::<String>;
    let participants = if team_members.is_empty() {
        vec![DungeonInstanceParticipantDto {
            user_id,
            character_id,
            role: "leader".to_string(),
        }]
    } else {
        team_id = team_members
            .first()
            .and_then(|row| row.try_get::<Option<String>, _>("team_id").ok().flatten());
        let is_leader = team_members.iter().any(|row| {
            row.try_get::<Option<i32>, _>("character_id")
                .ok()
                .flatten()
                .map(i64::from)
                == Some(character_id)
                && row
                    .try_get::<Option<String>, _>("role")
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some("leader")
        });
        if !is_leader {
            return Ok(ServiceResult {
                success: false,
                message: Some("组队中只有队长可以创建秘境".to_string()),
                data: None,
            });
        }
        team_members
            .into_iter()
            .filter_map(|row| {
                let user_id = row
                    .try_get::<Option<i32>, _>("user_id")
                    .ok()
                    .flatten()
                    .map(i64::from)?;
                let character_id = row
                    .try_get::<Option<i32>, _>("character_id")
                    .ok()
                    .flatten()
                    .map(i64::from)?;
                let role = row
                    .try_get::<Option<String>, _>("role")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "member".to_string());
                Some(DungeonInstanceParticipantDto {
                    user_id,
                    character_id,
                    role,
                })
            })
            .collect::<Vec<_>>()
    };

    if participants.len() < dungeon.min_players.max(1) as usize {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("人数不足，需要至少{}人", dungeon.min_players)),
            data: None,
        });
    }
    if participants.len() > dungeon.max_players.max(1) as usize {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("人数超限，最多{}人", dungeon.max_players)),
            data: None,
        });
    }
    if let Some(min_realm) = dungeon.min_realm.as_deref()
        && realm_rank(&full_realm) < realm_rank(min_realm)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("境界不足，需要{}以上", min_realm)),
            data: None,
        });
    }
    if let Some(min_realm) = difficulty.get("min_realm").and_then(|value| value.as_str())
        && realm_rank(&full_realm) < realm_rank(min_realm)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("境界不足，需要{}以上", min_realm)),
            data: None,
        });
    }

    let instance_id = format!("dungeon-inst-{}-{}", character_id, now_millis());
    let difficulty_id = difficulty
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    state.database.execute(
        "INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, start_time, end_time, time_spent_sec, total_damage, death_count, rewards_claimed, instance_data, created_at) VALUES ($1, $2, $3, $4, $5, 'preparing', 1, 1, $6::jsonb, NULL, NULL, 0, 0, 0, FALSE, '{}'::jsonb, NOW())",
        |q| q.bind(&instance_id).bind(dungeon_id).bind(&difficulty_id).bind(character_id).bind(team_id).bind(serde_json::to_value(&participants).unwrap_or_else(|_| serde_json::json!([]))),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: None,
        data: Some(CreateDungeonInstanceDataDto {
            instance_id,
            status: "preparing".to_string(),
            participants,
        }),
    })
}

async fn get_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    instance_id: &str,
) -> Result<ServiceResult<DungeonInstanceQueryDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, start_time::text AS start_time_text, end_time::text AS end_time_text, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1",
        |q| q.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let snapshot = build_dungeon_instance_snapshot(&row)?;
    if !snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权访问该秘境".to_string()),
            data: None,
        });
    }
    Ok(ServiceResult {
        success: true,
        message: None,
        data: Some(DungeonInstanceQueryDataDto { instance: snapshot }),
    })
}

async fn join_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    instance_id: &str,
) -> Result<ServiceResult<CreateDungeonInstanceDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, team_id, start_time::text AS start_time_text, end_time::text AS end_time_text, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let mut snapshot = build_dungeon_instance_snapshot(&row)?;
    if snapshot.status != "preparing" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该秘境已开始或已结束".to_string()),
            data: None,
        });
    }
    if snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: true,
            message: None,
            data: Some(CreateDungeonInstanceDataDto {
                instance_id: snapshot.id,
                status: snapshot.status,
                participants: snapshot.participants,
            }),
        });
    }

    let character_row = state.database.fetch_optional(
        "SELECT c.id, c.realm, c.sub_realm, tm.team_id FROM characters c LEFT JOIN team_members tm ON tm.character_id = c.id WHERE c.user_id = $1 LIMIT 1",
        |q| q.bind(user_id),
    ).await?;
    let Some(character_row) = character_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let _character_id = i64::from(character_row.try_get::<i32, _>("id")?);
    let participant_team_id = character_row.try_get::<Option<String>, _>("team_id")?;
    let instance_team_id = row.try_get::<Option<String>, _>("team_id")?;
    if instance_team_id.is_none() || participant_team_id != instance_team_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("不是同一队伍，无法加入".to_string()),
            data: None,
        });
    }

    let team_rows = state.database.fetch_all(
        "SELECT tm.character_id, tm.role, c.user_id FROM team_members tm JOIN characters c ON c.id = tm.character_id WHERE tm.team_id = $1 ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, tm.character_id ASC",
        |q| q.bind(instance_team_id.clone().unwrap_or_default()),
    ).await?;
    let participants = team_rows
        .into_iter()
        .filter_map(|row| {
            Some(DungeonInstanceParticipantDto {
                user_id: row
                    .try_get::<Option<i32>, _>("user_id")
                    .ok()
                    .flatten()
                    .map(i64::from)?,
                character_id: row
                    .try_get::<Option<i32>, _>("character_id")
                    .ok()
                    .flatten()
                    .map(i64::from)?,
                role: row
                    .try_get::<Option<String>, _>("role")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| "member".to_string()),
            })
        })
        .collect::<Vec<_>>();

    let Some(entry) = load_dungeon_entry(&snapshot.dungeon_id)? else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境不存在".to_string()),
            data: None,
        });
    };
    let dungeon = map_dungeon_def(&entry.def)?;
    if participants.len() > dungeon.max_players.max(1) as usize {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("人数超限，最多{}人", dungeon.max_players)),
            data: None,
        });
    }
    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row
        .try_get::<Option<String>, _>("sub_realm")?
        .unwrap_or_default();
    let full_realm = if realm.trim() == "凡人" || sub_realm.trim().is_empty() {
        realm
    } else {
        format!("{}·{}", realm.trim(), sub_realm.trim())
    };
    let difficulty_min_realm = entry
        .difficulties
        .iter()
        .find(|diff| {
            diff.get("id").and_then(|v| v.as_str()) == Some(snapshot.difficulty_id.as_str())
        })
        .and_then(|diff| diff.get("min_realm").and_then(|v| v.as_str()))
        .map(|v| v.to_string());
    if let Some(min_realm) = difficulty_min_realm.as_deref()
        && realm_rank(&full_realm) < realm_rank(min_realm)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("境界不足，需要{}以上", min_realm)),
            data: None,
        });
    }

    state
        .database
        .execute(
            "UPDATE dungeon_instance SET participants = $2::jsonb WHERE id = $1",
            |q| {
                q.bind(instance_id).bind(
                    serde_json::to_value(&participants).unwrap_or_else(|_| serde_json::json!([])),
                )
            },
        )
        .await?;
    snapshot.participants = participants.clone();
    Ok(ServiceResult {
        success: true,
        message: None,
        data: Some(CreateDungeonInstanceDataDto {
            instance_id: snapshot.id,
            status: snapshot.status,
            participants,
        }),
    })
}

async fn get_dungeon_instance_by_battle_id_tx(
    state: &AppState,
    user_id: i64,
    battle_id: &str,
) -> Result<ServiceResult<DungeonInstanceQueryDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, start_time::text AS start_time_text, end_time::text AS end_time_text, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE instance_data ->> 'currentBattleId' = $1 LIMIT 1",
        |q| q.bind(battle_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let snapshot = build_dungeon_instance_snapshot(&row)?;
    if !snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权访问该秘境".to_string()),
            data: None,
        });
    }
    Ok(ServiceResult {
        success: true,
        message: None,
        data: Some(DungeonInstanceQueryDataDto { instance: snapshot }),
    })
}

async fn start_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    instance_id: &str,
) -> Result<ServiceResult<DungeonInstanceStartDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let snapshot = build_dungeon_instance_snapshot(&row)?;
    if !snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权访问该秘境".to_string()),
            data: None,
        });
    }
    if snapshot.status != "preparing" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该秘境已开始或已结束".to_string()),
            data: None,
        });
    }
    let battle_id = format!(
        "dungeon-battle-{}-{}-{}",
        instance_id, snapshot.current_stage, snapshot.current_wave
    );
    let owner_character_id = snapshot
        .participants
        .first()
        .map(|participant| participant.character_id)
        .ok_or_else(|| AppError::config("秘境参与角色不存在"))?;
    let monster_ids = load_dungeon_wave_monster_ids(
        &snapshot.dungeon_id,
        &snapshot.difficulty_id,
        snapshot.current_stage,
        snapshot.current_wave,
    )?;
    let mut battle_state =
        build_minimal_pve_battle_state(&battle_id, owner_character_id, &monster_ids);
    hydrate_pve_battle_state_owner(state, &mut battle_state, owner_character_id).await?;
    let participant_character_ids = snapshot
        .participants
        .iter()
        .map(|participant| participant.character_id)
        .collect::<Vec<_>>();
    hydrate_pve_battle_state_participants(state, &mut battle_state, &participant_character_ids)
        .await?;
    let start_logs = restart_battle_runtime(&mut battle_state);
    state.battle_runtime.register(battle_state.clone());
    state.database.execute(
        "UPDATE dungeon_instance SET status = 'running', start_time = COALESCE(start_time, NOW()), instance_data = COALESCE(instance_data, '{}'::jsonb) || jsonb_build_object('currentBattleId', $2, 'difficultyRank', COALESCE((instance_data ->> 'difficultyRank')::int, 1)), created_at = created_at WHERE id = $1",
        |q| q.bind(instance_id).bind(&battle_id),
    ).await?;
    state
        .online_battle_projections
        .register(OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: user_id,
            participant_user_ids: snapshot
                .participants
                .iter()
                .map(|participant| participant.user_id)
                .collect(),
            r#type: "pve".to_string(),
            session_id: Some(format!("dungeon-session-{}", instance_id)),
        });
    let participant_user_ids = snapshot
        .participants
        .iter()
        .map(|participant| participant.user_id)
        .collect::<Vec<_>>();
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        start_logs,
        state.battle_sessions.get_by_battle_id(&battle_id),
    );
    emit_battle_update_to_participants(state, &participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(state, &participant_user_ids, &debug_cooldown_realtime);
    Ok(ServiceResult {
        success: true,
        message: None,
        data: Some(DungeonInstanceStartDataDto {
            instance_id: instance_id.to_string(),
            status: "running".to_string(),
            battle_id,
            state: Some(serde_json::to_value(battle_state).map_err(|error| {
                AppError::config(format!("failed to serialize dungeon start state: {error}"))
            })?),
        }),
    })
}

async fn abandon_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    instance_id: &str,
) -> Result<ServiceResult<DungeonInstanceQueryDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, start_time::text AS start_time_text, end_time::text AS end_time_text, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let mut snapshot = build_dungeon_instance_snapshot(&row)?;
    if !snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权访问该秘境".to_string()),
            data: None,
        });
    }
    if matches!(
        snapshot.status.as_str(),
        "completed" | "failed" | "abandoned"
    ) {
        return Ok(ServiceResult {
            success: false,
            message: Some("该秘境已结束".to_string()),
            data: None,
        });
    }
    state.database.execute(
        "UPDATE dungeon_instance SET status = 'abandoned', end_time = COALESCE(end_time, NOW()), instance_data = COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId' WHERE id = $1",
        |q| q.bind(instance_id),
    ).await?;
    let updated_session =
        state
            .battle_sessions
            .update(&format!("dungeon-session-{}", instance_id), |record| {
                record.current_battle_id = None;
                record.status = "abandoned".to_string();
                record.next_action = "none".to_string();
                record.can_advance = false;
                record.last_result = Some("abandoned".to_string());
            });
    if let Some(battle_id) = snapshot.current_battle_id.clone() {
        state.online_battle_projections.clear(&battle_id);
        let participant_user_ids = snapshot
            .participants
            .iter()
            .map(|participant| participant.user_id)
            .collect::<Vec<_>>();
        let debug_realtime =
            build_battle_abandoned_payload(&battle_id, updated_session, true, "已放弃秘境");
        emit_battle_update_to_participants(state, &participant_user_ids, &debug_realtime);
    }
    snapshot.status = "abandoned".to_string();
    snapshot.current_battle_id = None;
    snapshot.end_time = Some(
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    );
    Ok(ServiceResult {
        success: true,
        message: Some("已放弃秘境".to_string()),
        data: Some(DungeonInstanceQueryDataDto { instance: snapshot }),
    })
}

pub(crate) async fn next_dungeon_instance_tx(
    state: &AppState,
    user_id: i64,
    instance_id: &str,
) -> Result<ServiceResult<DungeonInstanceNextDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, status, current_stage, current_wave, participants, start_time::text AS start_time_text, end_time::text AS end_time_text, time_spent_sec, total_damage, death_count, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境实例不存在".to_string()),
            data: None,
        });
    };
    let snapshot = build_dungeon_instance_snapshot(&row)?;
    if !snapshot
        .participants
        .iter()
        .any(|participant| participant.user_id == user_id)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权访问该秘境".to_string()),
            data: None,
        });
    }
    if snapshot.status != "running" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该秘境当前不可推进".to_string()),
            data: None,
        });
    }
    let Some(current_battle_id) = snapshot.current_battle_id.clone() else {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前秘境没有进行中的战斗".to_string()),
            data: None,
        });
    };
    let battle_state = state
        .battle_runtime
        .get(&current_battle_id)
        .ok_or_else(|| AppError::config("当前战斗状态不存在"))?;
    let Some(result) = battle_state.result.as_deref() else {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前战斗尚未结束".to_string()),
            data: None,
        });
    };

    state.battle_runtime.clear(&current_battle_id);
    state.online_battle_projections.clear(&current_battle_id);

    if result != "attacker_win" {
        state.database.execute(
        "UPDATE dungeon_instance SET status = 'failed', end_time = COALESCE(end_time, NOW()), instance_data = COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId' WHERE id = $1",
            |q| q.bind(instance_id),
        ).await?;
        let updated_session =
            state
                .battle_sessions
                .update(&format!("dungeon-session-{}", instance_id), |record| {
                    record.current_battle_id = None;
                    record.status = "failed".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                    record.last_result = Some(result.to_string());
                });
        let participant_user_ids = snapshot
            .participants
            .iter()
            .map(|participant| participant.user_id)
            .collect::<Vec<_>>();
        let debug_realtime = build_battle_abandoned_payload(
            &current_battle_id,
            updated_session,
            false,
            "秘境挑战失败",
        );
        emit_battle_update_to_participants(state, &participant_user_ids, &debug_realtime);
        return Ok(ServiceResult {
            success: true,
            message: Some("秘境挑战失败".to_string()),
            data: Some(DungeonInstanceNextDataDto {
                instance_id: instance_id.to_string(),
                status: "failed".to_string(),
                battle_id: None,
                state: None,
                finished: true,
            }),
        });
    }

    let Some(entry) = load_dungeon_entry(&snapshot.dungeon_id)? else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境不存在".to_string()),
            data: None,
        });
    };
    let Some(difficulty) = entry.difficulties.iter().find(|diff| {
        diff.get("id").and_then(|v| v.as_str()) == Some(snapshot.difficulty_id.as_str())
    }) else {
        return Ok(ServiceResult {
            success: false,
            message: Some("秘境难度不存在".to_string()),
            data: None,
        });
    };
    let stages = difficulty
        .get("stages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let next_cursor =
        find_next_dungeon_cursor(&stages, snapshot.current_stage, snapshot.current_wave);

    if let Some((next_stage, next_wave, monster_ids)) = next_cursor {
        let next_battle_id = format!(
            "dungeon-battle-{}-{}-{}",
            instance_id, next_stage, next_wave
        );
        let owner_character_id = snapshot
            .participants
            .first()
            .map(|participant| participant.character_id)
            .ok_or_else(|| AppError::config("秘境参与角色不存在"))?;
        let mut battle_state =
            build_minimal_pve_battle_state(&next_battle_id, owner_character_id, &monster_ids);
        hydrate_pve_battle_state_owner(state, &mut battle_state, owner_character_id).await?;
        let participant_character_ids = snapshot
            .participants
            .iter()
            .map(|participant| participant.character_id)
            .collect::<Vec<_>>();
        hydrate_pve_battle_state_participants(state, &mut battle_state, &participant_character_ids)
            .await?;
        let start_logs = restart_battle_runtime(&mut battle_state);
        state.battle_runtime.register(battle_state.clone());
        state
            .online_battle_projections
            .register(OnlineBattleProjectionRecord {
                battle_id: next_battle_id.clone(),
                owner_user_id: user_id,
                participant_user_ids: snapshot
                    .participants
                    .iter()
                    .map(|participant| participant.user_id)
                    .collect(),
                r#type: "pve".to_string(),
                session_id: Some(format!("dungeon-session-{}", instance_id)),
            });
        let participant_user_ids = snapshot
            .participants
            .iter()
            .map(|participant| participant.user_id)
            .collect::<Vec<_>>();
        state.database.execute(
            "UPDATE dungeon_instance SET current_stage = $2, current_wave = $3, status = 'running', instance_data = COALESCE(instance_data, '{}'::jsonb) || jsonb_build_object('currentBattleId', $4) WHERE id = $1",
            |q| q.bind(instance_id).bind(next_stage).bind(next_wave).bind(&next_battle_id),
        ).await?;
        let _ =
            state
                .battle_sessions
                .update(&format!("dungeon-session-{}", instance_id), |record| {
                    record.current_battle_id = Some(next_battle_id.clone());
                    record.status = "running".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                    record.last_result = Some("attacker_win".to_string());
                });
        let debug_realtime = build_battle_started_payload(
            &next_battle_id,
            battle_state.clone(),
            start_logs,
            state.battle_sessions.get_by_battle_id(&next_battle_id),
        );
        emit_battle_update_to_participants(state, &participant_user_ids, &debug_realtime);
        let debug_cooldown_realtime =
            build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
        emit_battle_cooldown_to_participants(
            state,
            &participant_user_ids,
            &debug_cooldown_realtime,
        );
        return Ok(ServiceResult {
            success: true,
            message: None,
            data: Some(DungeonInstanceNextDataDto {
                instance_id: instance_id.to_string(),
                status: "running".to_string(),
                battle_id: Some(next_battle_id),
                state: Some(serde_json::to_value(battle_state).map_err(|error| {
                    AppError::config(format!("failed to serialize dungeon battle state: {error}"))
                })?),
                finished: false,
            }),
        });
    }

    state.database.execute(
        "UPDATE dungeon_instance SET status = 'completed', end_time = COALESCE(end_time, NOW()), instance_data = COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId' WHERE id = $1",
        |q| q.bind(instance_id),
    ).await?;
    let updated_session =
        state
            .battle_sessions
            .update(&format!("dungeon-session-{}", instance_id), |record| {
                record.current_battle_id = None;
                record.status = "completed".to_string();
                record.next_action = "none".to_string();
                record.can_advance = false;
                record.last_result = Some("attacker_win".to_string());
            });
    let participant_user_ids = snapshot
        .participants
        .iter()
        .map(|participant| participant.user_id)
        .collect::<Vec<_>>();
    let debug_realtime =
        build_battle_abandoned_payload(&current_battle_id, updated_session, true, "秘境已通关");
    emit_battle_update_to_participants(state, &participant_user_ids, &debug_realtime);
    let participant_character_ids = snapshot
        .participants
        .iter()
        .map(|participant| participant.character_id)
        .filter(|character_id| *character_id > 0)
        .collect::<Vec<_>>();
    let reward_recipients = snapshot
        .participants
        .iter()
        .filter(|participant| participant.character_id > 0 && participant.user_id > 0)
        .map(|participant| {
            crate::jobs::online_battle_settlement::DungeonSettlementRewardRecipient {
                character_id: participant.character_id,
                user_id: participant.user_id,
            }
        })
        .collect::<Vec<_>>();
    enqueue_dungeon_clear_settlement_task(
        state,
        &current_battle_id,
        &DungeonClearSettlementTaskPayload {
            instance_id: instance_id.to_string(),
            dungeon_id: snapshot.dungeon_id.clone(),
            difficulty_id: snapshot.difficulty_id.clone(),
            reward_recipients,
            participant_character_ids,
            participant_user_ids: participant_user_ids.clone(),
            time_spent_sec: snapshot.time_spent_sec,
            total_damage: snapshot.total_damage,
            death_count: snapshot.death_count,
        },
    )
    .await?;
    Ok(ServiceResult {
        success: true,
        message: Some("秘境已通关".to_string()),
        data: Some(DungeonInstanceNextDataDto {
            instance_id: instance_id.to_string(),
            status: "completed".to_string(),
            battle_id: None,
            state: None,
            finished: true,
        }),
    })
}

fn find_next_dungeon_cursor(
    stages: &[serde_json::Value],
    current_stage: i64,
    current_wave: i64,
) -> Option<(i64, i64, Vec<String>)> {
    let mut found_current = false;
    for stage in stages {
        let stage_index = stage
            .get("stage_index")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let waves = stage
            .get("waves")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for wave in waves {
            let wave_index = wave
                .get("wave_index")
                .and_then(|v| v.as_i64())
                .unwrap_or_default();
            if !found_current {
                if stage_index == current_stage && wave_index == current_wave {
                    found_current = true;
                }
                continue;
            }
            let monster_ids = wave
                .get("monsters")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .flat_map(|monster| {
                    let id = monster
                        .get("monster_def_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let count = monster
                        .get("count")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1)
                        .max(1);
                    std::iter::repeat_n(id, count as usize)
                })
                .filter(|id| !id.trim().is_empty())
                .collect::<Vec<_>>();
            return Some((stage_index, wave_index, monster_ids));
        }
    }
    None
}

fn build_wave_monster_ids(wave: &serde_json::Value) -> Vec<String> {
    wave.get("monsters")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|monster| {
            let id = monster
                .get("monster_def_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let count = monster
                .get("count")
                .and_then(|v| v.as_i64())
                .unwrap_or(1)
                .max(1);
            std::iter::repeat_n(id, count as usize)
        })
        .filter(|id| !id.trim().is_empty())
        .collect()
}

fn build_dungeon_instance_snapshot(
    row: &sqlx::postgres::PgRow,
) -> Result<DungeonInstanceSnapshotDto, AppError> {
    let participants = row
        .try_get::<Option<serde_json::Value>, _>("participants")?
        .and_then(|value| serde_json::from_value::<Vec<DungeonInstanceParticipantDto>>(value).ok())
        .unwrap_or_default();
    let instance_data = row
        .try_get::<Option<serde_json::Value>, _>("instance_data")?
        .unwrap_or_else(|| serde_json::json!({}));
    Ok(DungeonInstanceSnapshotDto {
        id: row.try_get::<String, _>("id")?,
        dungeon_id: row.try_get::<String, _>("dungeon_id")?,
        difficulty_id: row.try_get::<String, _>("difficulty_id")?,
        difficulty_rank: extract_difficulty_rank(&instance_data),
        status: row
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_else(|| "preparing".to_string()),
        current_stage: row
            .try_get::<Option<i32>, _>("current_stage")?
            .map(i64::from)
            .unwrap_or(1),
        current_wave: row
            .try_get::<Option<i32>, _>("current_wave")?
            .map(i64::from)
            .unwrap_or(1),
        participants,
        current_battle_id: instance_data
            .get("currentBattleId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        start_time: row.try_get::<Option<String>, _>("start_time_text")?,
        end_time: row.try_get::<Option<String>, _>("end_time_text")?,
        time_spent_sec: row
            .try_get::<Option<i32>, _>("time_spent_sec")?
            .map(i64::from)
            .unwrap_or_default(),
        total_damage: row
            .try_get::<Option<i64>, _>("total_damage")?
            .unwrap_or_default(),
        death_count: row
            .try_get::<Option<i32>, _>("death_count")?
            .map(i64::from)
            .unwrap_or_default(),
    })
}

fn extract_difficulty_rank(instance_data: &serde_json::Value) -> i64 {
    instance_data
        .get("difficultyRank")
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn dungeon_wave_monster_loader_reads_real_seed_monsters() {
        let monster_ids = super::load_dungeon_wave_monster_ids(
            "dungeon-qiqi-wolf-den",
            "dd-qiqi-wolf-den-n",
            1,
            1,
        )
        .expect("dungeon wave monsters should load");
        assert_eq!(
            monster_ids,
            vec![
                "monster-gray-wolf".to_string(),
                "monster-gray-wolf".to_string(),
                "monster-wild-boar".to_string(),
            ]
        );
        println!(
            "DUNGEON_WAVE_MONSTER_IDS={}",
            serde_json::json!(monster_ids)
        );
    }

    #[test]
    fn dungeon_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"dungeons": [{"id": "dungeon-qiqi-wolf-den", "name": "苍狼巢穴", "type": "trial"}]}
        });
        assert_eq!(
            payload["data"]["dungeons"][0]["id"],
            "dungeon-qiqi-wolf-den"
        );
        println!("DUNGEON_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_preview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "dungeon": {"id": "dungeon-qiqi-wolf-den", "name": "苍狼巢穴"},
                "difficulty": {"id": "dd-qiqi-wolf-den-n", "difficultyRank": 1, "name": "普通"},
                "entry": null,
                "stages": [{"id": "ds-qiqi-wolf-den-n-1", "stageIndex": 1, "type": "battle", "waves": []}],
                "dropItems": [],
                "dropSources": []
            }
        });
        assert_eq!(payload["data"]["difficulty"]["difficultyRank"], 1);
        println!("DUNGEON_PREVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_create_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instanceId": "dungeon-inst-1-123", "status": "preparing", "participants": [{"userId": 1, "characterId": 1, "role": "leader"}]}
        });
        assert_eq!(payload["data"]["instanceId"], "dungeon-inst-1-123");
        println!("DUNGEON_INSTANCE_CREATE_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_get_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instance": {"id": "inst-1", "dungeonId": "dungeon-qiqi-wolf-den", "status": "preparing", "participants": []}}
        });
        assert_eq!(payload["data"]["instance"]["id"], "inst-1");
        println!("DUNGEON_INSTANCE_GET_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_join_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instanceId": "inst-1", "status": "preparing", "participants": [{"userId": 1, "characterId": 1, "role": "leader"}, {"userId": 2, "characterId": 2, "role": "member"}]}
        });
        assert_eq!(payload["data"]["participants"][1]["role"], "member");
        println!("DUNGEON_INSTANCE_JOIN_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_by_battle_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instance": {"id": "inst-1", "currentBattleId": "battle-1", "status": "running"}}
        });
        assert_eq!(payload["data"]["instance"]["currentBattleId"], "battle-1");
        println!("DUNGEON_INSTANCE_BY_BATTLE_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instanceId": "inst-1", "status": "running", "battleId": "dungeon-battle-inst-1-1-1", "state": {"battleId": "dungeon-battle-inst-1-1-1", "currentTeam": "attacker"}}
        });
        assert_eq!(payload["data"]["battleId"], "dungeon-battle-inst-1-1-1");
        assert_eq!(payload["data"]["state"]["currentTeam"], "attacker");
        println!("DUNGEON_INSTANCE_START_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_abandon_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已放弃秘境",
            "data": {"instance": {"id": "inst-1", "status": "abandoned", "currentBattleId": null}}
        });
        assert_eq!(payload["data"]["instance"]["status"], "abandoned");
        println!("DUNGEON_INSTANCE_ABANDON_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_instance_next_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"instanceId": "inst-1", "status": "running", "battleId": "dungeon-battle-inst-1-1-2", "state": {"battleId": "dungeon-battle-inst-1-1-2", "currentTeam": "attacker"}, "finished": false}
        });
        assert_eq!(payload["data"]["battleId"], "dungeon-battle-inst-1-1-2");
        assert_eq!(payload["data"]["state"]["currentTeam"], "attacker");
        println!("DUNGEON_INSTANCE_NEXT_RESPONSE={}", payload);
    }
}
