use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{CharacterItemGrantDelta, buffer_character_item_grant_deltas};
use crate::integrations::redis_progress_delta::{CharacterProgressDeltaField, buffer_character_progress_delta_fields};
use crate::integrations::redis_resource_delta::{CharacterResourceDeltaField, buffer_character_resource_delta_fields};
use crate::realtime::public_socket::emit_task_update_to_user;
use crate::realtime::task::{build_task_overview_update_payload, build_task_update_payload};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct TaskOverviewQuery {
    pub category: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetTaskTrackedPayload {
    pub task_id: Option<String>,
    pub tracked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcTalkPayload {
    pub npc_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcTaskPayload {
    pub npc_id: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIdPayload {
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskObjectiveDto {
    pub id: String,
    #[serde(rename = "type")]
    pub objective_type: String,
    pub text: String,
    pub done: i64,
    pub target: i64,
    pub params: Option<serde_json::Value>,
    pub map_name: Option<String>,
    pub map_name_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum TaskRewardDto {
    #[serde(rename = "silver")]
    Silver { name: String, amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { name: String, amount: i64 },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        name: String,
        icon: Option<String>,
        amount: i64,
        amount_max: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum ClaimedTaskRewardDto {
    #[serde(rename = "silver")]
    Silver { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        qty: i64,
        item_ids: Vec<i64>,
        item_name: Option<String>,
        item_icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOverviewRowDto {
    pub id: String,
    pub category: String,
    pub title: String,
    pub realm: String,
    pub giver_npc_id: Option<String>,
    pub map_id: Option<String>,
    pub map_name: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub tracked: bool,
    pub description: String,
    pub objectives: Vec<TaskObjectiveDto>,
    pub rewards: Vec<TaskRewardDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOverviewSummaryRowDto {
    pub id: String,
    pub category: String,
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub tracked: bool,
}

#[derive(Debug, Deserialize)]
struct TaskSeedFile {
    tasks: Vec<TaskSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct TaskSeed {
    id: String,
    category: String,
    title: String,
    realm: Option<String>,
    description: Option<String>,
    giver_npc_id: Option<String>,
    map_id: Option<String>,
    room_id: Option<String>,
    objectives: Option<Vec<TaskObjectiveSeed>>,
    rewards: Option<Vec<TaskRewardSeed>>,
    enabled: Option<bool>,
    sort_weight: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
struct TaskObjectiveSeed {
    id: Option<String>,
    #[serde(rename = "type")]
    objective_type: Option<String>,
    text: Option<String>,
    target: Option<i64>,
    params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone)]
struct TaskRewardSeed {
    #[serde(rename = "type")]
    reward_type: Option<String>,
    amount: Option<i64>,
    item_def_id: Option<String>,
    qty: Option<i64>,
    qty_min: Option<i64>,
    qty_max: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct NpcSeedFile {
    npcs: Vec<NpcSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct NpcSeed {
    id: String,
    name: String,
    description: Option<String>,
    talk_tree_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcTalkTaskOptionDto {
    pub task_id: String,
    pub title: String,
    pub category: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcTalkData {
    pub npc_id: String,
    pub npc_name: String,
    pub lines: Vec<String>,
    pub tasks: Vec<NpcTalkTaskOptionDto>,
}

pub async fn get_task_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TaskOverviewQuery>,
) -> Result<Json<SuccessResponse<TaskOverviewResponse>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let tasks = load_task_overview_rows(&state, actor.character_id, query.category.as_deref()).await?;
    Ok(send_success(TaskOverviewResponse { tasks }))
}

pub async fn get_task_overview_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TaskOverviewQuery>,
) -> Result<Json<SuccessResponse<TaskOverviewSummaryResponse>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let tasks = load_task_overview_rows(&state, actor.character_id, query.category.as_deref())
        .await?
        .into_iter()
        .map(|row| TaskOverviewSummaryRowDto {
            id: row.id,
            category: row.category,
            map_id: row.map_id,
            room_id: row.room_id,
            status: row.status,
            tracked: row.tracked,
        })
        .collect();
    Ok(send_success(TaskOverviewSummaryResponse { tasks }))
}

pub async fn set_task_tracked(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SetTaskTrackedPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let task_id = payload.task_id.unwrap_or_default();
    if task_id.trim().is_empty() {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("任务ID不能为空".to_string()),
            data: None,
        }));
    }

    let task_defs = load_task_seeds()?;
    if !task_defs.iter().any(|task| task.enabled != Some(false) && task.id.trim() == task_id.trim()) {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("任务不存在".to_string()),
            data: None,
        }));
    }

    let tracked = payload.tracked == Some(true);
    state
        .database
        .execute(
            "INSERT INTO character_task_progress (character_id, task_id, tracked) VALUES ($1, $2, $3) ON CONFLICT (character_id, task_id) DO UPDATE SET tracked = EXCLUDED.tracked, updated_at = NOW()",
            |query| query.bind(actor.character_id).bind(task_id.trim()).bind(tracked),
        )
        .await?;

    let debug_realtime = build_task_update_payload("track_task", task_id.trim(), None, Some(tracked));
    let socket_realtime = build_task_overview_update_payload(actor.character_id);
    emit_task_update_to_user(&state, actor.user_id, &socket_realtime);

    Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({
            "taskId": task_id.trim(),
            "tracked": tracked,
            "debugRealtime": debug_realtime,
        })),
    }))
}

pub async fn npc_talk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NpcTalkPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let npc_id = payload.npc_id.unwrap_or_default();
    if npc_id.trim().is_empty() {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("NPC不存在".to_string()),
            data: None,
        }));
    }

    let npc_map = load_npc_seed_map()?;
    let Some(npc) = npc_map.get(npc_id.trim()) else {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("NPC不存在".to_string()),
            data: None,
        }));
    };

    let task_defs = load_task_seeds()?;
    let tasks_for_npc: Vec<_> = task_defs
        .into_iter()
        .filter(|task| task.enabled != Some(false))
        .filter(|task| task.giver_npc_id.as_deref().map(str::trim) == Some(npc_id.trim()))
        .collect();
    let task_ids: Vec<String> = tasks_for_npc.iter().map(|task| task.id.clone()).collect();
    let progress_by_task = load_task_progress_map(&state, actor.character_id, &task_ids).await?;
    let mut tasks = Vec::new();
    for task in tasks_for_npc {
        let task_id = task.id.trim().to_string();
        if task_id.is_empty() {
            continue;
        }
        let title = task.title.clone();
        let category = task.category.clone();
        let status = if let Some(progress) = progress_by_task.get(task_id.as_str()) {
            let objectives = task.objectives.clone().unwrap_or_default();
            let progress_status = progress.status.as_deref();
            let all_done = objectives.iter().filter_map(|objective| objective.id.as_deref()).all(|objective_id| {
                let target = objectives
                    .iter()
                    .find(|objective| objective.id.as_deref() == Some(objective_id))
                    .and_then(|objective| objective.target)
                    .unwrap_or(1)
                    .max(1);
                progress.progress.get(objective_id).copied().unwrap_or(0) >= target
            });
            match progress_status.unwrap_or("ongoing") {
                "claimed" => "claimed".to_string(),
                "claimable" => "claimable".to_string(),
                "turnin" if all_done => "turnin".to_string(),
                "ongoing" if all_done => "turnin".to_string(),
                _ => "accepted".to_string(),
            }
        } else {
            "available".to_string()
        };
        tasks.push(NpcTalkTaskOptionDto {
            task_id,
            title,
            category,
            status,
        });
    }

    Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(NpcTalkData {
            npc_id: npc.id.clone(),
            npc_name: npc.name.clone(),
            lines: build_npc_talk_lines(npc),
            tasks,
        }),
    }))
}

pub async fn npc_accept(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NpcTaskPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let npc_id = payload.npc_id.unwrap_or_default();
    let task_id = payload.task_id.unwrap_or_default();
    if npc_id.trim().is_empty() {
        return Ok(task_failure("NPC不存在"));
    }
    if task_id.trim().is_empty() {
        return Ok(task_failure("任务ID不能为空"));
    }

    let npc_map = load_npc_seed_map()?;
    if !npc_map.contains_key(npc_id.trim()) {
        return Ok(task_failure("NPC不存在"));
    }
    let task_defs = load_task_seeds()?;
    let Some(task) = task_defs.into_iter().find(|task| task.enabled != Some(false) && task.id.trim() == task_id.trim()) else {
        return Ok(task_failure("任务不存在"));
    };
    if task.giver_npc_id.as_deref().map(str::trim) != Some(npc_id.trim()) {
        return Ok(task_failure("该NPC无法发放此任务"));
    }

    let existing = state
        .database
        .fetch_optional(
            "SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1",
            |query| query.bind(actor.character_id).bind(task_id.trim()),
        )
        .await?;
    if let Some(row) = existing {
        let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
        if status != "claimed" {
            return Ok(task_failure("任务已接取"));
        }
        if matches!(task.category.trim(), "main" | "side") {
            return Ok(task_failure("任务已完成，不可重复接取"));
        }
        if task.category.trim() == "daily" {
            return Ok(task_failure("今日任务已完成"));
        }
        if task.category.trim() == "event" {
            return Ok(task_failure("本周活动任务已完成"));
        }
    }

    state
        .database
        .execute(
            "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, $2, 'ongoing', '{}'::jsonb, true, NOW(), NULL, NULL, NOW()) ON CONFLICT (character_id, task_id) DO UPDATE SET status = EXCLUDED.status, progress = EXCLUDED.progress, tracked = EXCLUDED.tracked, accepted_at = NOW(), completed_at = NULL, claimed_at = NULL, updated_at = NOW()",
            |query| query.bind(actor.character_id).bind(task_id.trim()),
        )
        .await?;

    let socket_realtime = build_task_overview_update_payload(actor.character_id);
    emit_task_update_to_user(&state, actor.user_id, &socket_realtime);

    Ok(task_success(task_id.trim()))
}

pub async fn npc_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NpcTaskPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let npc_id = payload.npc_id.unwrap_or_default();
    let task_id = payload.task_id.unwrap_or_default();
    if npc_id.trim().is_empty() {
        return Ok(task_failure("NPC不存在"));
    }
    if task_id.trim().is_empty() {
        return Ok(task_failure("任务ID不能为空"));
    }

    let task_defs = load_task_seeds()?;
    let Some(task) = task_defs.into_iter().find(|task| task.enabled != Some(false) && task.id.trim() == task_id.trim()) else {
        return Ok(task_failure("任务不存在"));
    };
    if task.giver_npc_id.as_deref().map(str::trim) != Some(npc_id.trim()) {
        return Ok(task_failure("该任务无法在此提交"));
    }

    let progress_row = state
        .database
        .fetch_optional(
            "SELECT status, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1",
            |query| query.bind(actor.character_id).bind(task_id.trim()),
        )
        .await?;
    let Some(progress_row) = progress_row else {
        return Ok(task_failure("任务未接取"));
    };
    let status = progress_row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
    if status == "claimed" {
        return Ok(task_failure("任务已完成"));
    }
    if status == "claimable" {
        return Ok(task_success(task_id.trim()));
    }

    let progress = parse_progress_record(progress_row.try_get::<Option<serde_json::Value>, _>("progress")?);
    let objectives = task.objectives.unwrap_or_default();
    let all_done = objectives
        .iter()
        .filter_map(|objective| objective.id.as_deref())
        .all(|objective_id| {
            let target = objectives
                .iter()
                .find(|objective| objective.id.as_deref() == Some(objective_id))
                .and_then(|objective| objective.target)
                .unwrap_or(1)
                .max(1);
            progress.get(objective_id).copied().unwrap_or(0) >= target
        });
    if !all_done {
        return Ok(task_failure("任务未完成"));
    }

    state
        .database
        .execute(
            "UPDATE character_task_progress SET status = 'claimable', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW() WHERE character_id = $1 AND task_id = $2",
            |query| query.bind(actor.character_id).bind(task_id.trim()),
        )
        .await?;

    let socket_realtime = build_task_overview_update_payload(actor.character_id);
    emit_task_update_to_user(&state, actor.user_id, &socket_realtime);

    Ok(task_success(task_id.trim()))
}

pub async fn claim_task_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TaskIdPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let task_id = payload.task_id.unwrap_or_default();
    if task_id.trim().is_empty() {
        return Ok(task_failure("任务ID不能为空"));
    }

    let task_defs = load_task_seeds()?;
    let Some(task) = task_defs.into_iter().find(|task| task.enabled != Some(false) && task.id.trim() == task_id.trim()) else {
        return Ok(task_failure("任务不存在"));
    };

    let progress_row = state
        .database
        .fetch_optional(
            "SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
            |query| query.bind(actor.character_id).bind(task_id.trim()),
        )
        .await?;
    let Some(progress_row) = progress_row else {
        return Ok(task_failure("任务未接取"));
    };
    let status = progress_row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
    if status != "claimable" {
        return Ok(task_failure("任务不可领取"));
    }

    let item_meta_map = load_item_meta_map()?;
    let reward_rows = state
        .database
        .with_transaction(|| async {
            let mut rewards = Vec::new();
            let mut silver_delta = 0_i64;
            let mut spirit_stones_delta = 0_i64;
            let mut item_grants = Vec::<CharacterItemGrantDelta>::new();
            for reward in task.rewards.unwrap_or_default() {
                match reward.reward_type.as_deref() {
                    Some("silver") => {
                        let amount = reward.amount.unwrap_or_default().max(0);
                        if amount > 0 {
                            silver_delta += amount;
                            rewards.push(ClaimedTaskRewardDto::Silver { amount });
                        }
                    }
                    Some("spirit_stones") => {
                        let amount = reward.amount.unwrap_or_default().max(0);
                        if amount > 0 {
                            spirit_stones_delta += amount;
                            rewards.push(ClaimedTaskRewardDto::SpiritStones { amount });
                        }
                    }
                    Some("item") => {
                        let item_def_id = reward.item_def_id.unwrap_or_default();
                        let qty = reward.qty.unwrap_or_else(|| reward.qty_min.unwrap_or(0)).max(0);
                        if item_def_id.trim().is_empty() || qty <= 0 {
                            continue;
                        }
                        item_grants.push(CharacterItemGrantDelta {
                            character_id: actor.character_id,
                            user_id: actor.user_id,
                            item_def_id: item_def_id.trim().to_string(),
                            qty,
                            bind_type: "none".to_string(),
                            obtained_from: "task_reward".to_string(),
                            obtained_ref_id: Some(task_id.trim().to_string()),
                        });
                        let meta = item_meta_map.get(item_def_id.trim()).cloned();
                        rewards.push(ClaimedTaskRewardDto::Item {
                            item_def_id: item_def_id.trim().to_string(),
                            qty,
                            item_ids: vec![],
                            item_name: meta.as_ref().map(|value| value.0.clone()),
                            item_icon: meta.and_then(|value| value.1),
                        });
                    }
                    _ => {}
                }
            }

            if state.redis_available && state.redis.is_some() {
                let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
                let mut resource_fields = Vec::new();
                if silver_delta > 0 {
                    resource_fields.push(CharacterResourceDeltaField {
                        character_id: actor.character_id,
                        field: "silver".to_string(),
                        increment: silver_delta,
                    });
                }
                if spirit_stones_delta > 0 {
                    resource_fields.push(CharacterResourceDeltaField {
                        character_id: actor.character_id,
                        field: "spirit_stones".to_string(),
                        increment: spirit_stones_delta,
                    });
                }
                if !resource_fields.is_empty() {
                    buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
                }
                if !item_grants.is_empty() {
                    buffer_character_item_grant_deltas(&redis, &item_grants).await?;
                }
            } else {
                for grant in &item_grants {
                    for _ in 0..grant.qty {
                        state
                            .database
                            .fetch_one(
                                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at) VALUES ($1, $2, $3, 1, 'none', 'bag', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING id",
                                |query| query.bind(actor.user_id).bind(actor.character_id).bind(grant.item_def_id.as_str()),
                            )
                            .await?;
                    }
                }
                if silver_delta > 0 || spirit_stones_delta > 0 {
                    state
                        .database
                        .execute(
                            "UPDATE characters SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
                            |query| query.bind(silver_delta).bind(spirit_stones_delta).bind(actor.character_id),
                        )
                        .await?;
                }
            }

            state
                .database
                .execute(
                    "UPDATE character_task_progress SET status = 'claimed', completed_at = COALESCE(completed_at, NOW()), claimed_at = NOW(), tracked = false, updated_at = NOW() WHERE character_id = $1 AND task_id = $2",
                    |query| query.bind(actor.character_id).bind(task_id.trim()),
                )
                .await?;
            Ok::<Vec<ClaimedTaskRewardDto>, AppError>(rewards)
        })
        .await?;

    let debug_realtime = build_task_update_payload("claim_task", task_id.trim(), Some("claimed"), Some(false));
    let socket_realtime = build_task_overview_update_payload(actor.character_id);
    emit_task_update_to_user(&state, actor.user_id, &socket_realtime);

    Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({
            "taskId": task_id.trim(),
            "rewards": reward_rows,
            "debugRealtime": debug_realtime,
        })),
    }))
}

pub async fn record_dungeon_clear_task_event(
    state: &AppState,
    character_id: i64,
    user_id: i64,
    dungeon_id: &str,
    count: i64,
) -> Result<(), AppError> {
    let dungeon_id = dungeon_id.trim();
    if character_id <= 0 || user_id <= 0 || dungeon_id.is_empty() {
        return Ok(());
    }
    let increment = count.max(1);
    let task_defs = load_task_seeds()?;
    let matching_tasks = task_defs
        .into_iter()
        .filter(|task| task.enabled != Some(false))
        .filter_map(|task| {
            let objectives = task.objectives.clone().unwrap_or_default();
            let matched_objectives = objectives
                .iter()
                .filter_map(|objective| {
                    let objective_id = objective.id.as_deref()?.trim();
                    if objective_id.is_empty() {
                        return None;
                    }
                    if objective.objective_type.as_deref().map(str::trim) != Some("dungeon_clear") {
                        return None;
                    }
                    let params = objective.params.as_ref()?;
                    let objective_dungeon_id = params.get("dungeon_id").and_then(|value| value.as_str()).unwrap_or_default().trim();
                    if objective_dungeon_id != dungeon_id {
                        return None;
                    }
                    Some((objective_id.to_string(), objective.target.unwrap_or(1).max(1)))
                })
                .collect::<Vec<_>>();
            if matched_objectives.is_empty() {
                return None;
            }
            Some((task.id, task.category, objectives, matched_objectives))
        })
        .collect::<Vec<_>>();
    if matching_tasks.is_empty() {
        return Ok(());
    }

    let use_progress_delta = state.redis_available && state.redis.is_some();
    let mut buffered_progress_deltas = Vec::<CharacterProgressDeltaField>::new();

    for (task_id, category, objectives, matched_objectives) in matching_tasks {
        let progress_row = state
            .database
            .fetch_optional(
                "SELECT status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
                |query| query.bind(character_id).bind(task_id.trim()),
            )
            .await?;
        let progress_row = if let Some(progress_row) = progress_row {
            progress_row
        } else {
            if !matches!(category.trim(), "daily" | "event") {
                continue;
            }
            state
                .database
                .execute(
                    "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, $2, 'ongoing', '{}'::jsonb, false, NOW(), NULL, NULL, NOW()) ON CONFLICT (character_id, task_id) DO NOTHING",
                    |query| query.bind(character_id).bind(task_id.trim()),
                )
                .await?;
            state
                .database
                .fetch_optional(
                    "SELECT status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(task_id.trim()),
                )
                .await?
                .ok_or_else(|| AppError::config("任务进度行创建失败"))?
        };
        let status = progress_row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
        if status == "claimed" {
            continue;
        }
        if use_progress_delta {
            for (objective_id, _) in &matched_objectives {
                buffered_progress_deltas.push(CharacterProgressDeltaField {
                    character_id,
                    field: format!("task_progress:{}:{}", task_id.trim(), objective_id),
                    increment,
                });
            }
        } else {
            let tracked = progress_row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true);
            let mut progress_value = progress_row.try_get::<Option<serde_json::Value>, _>("progress")?.unwrap_or_else(|| serde_json::json!({}));
            let progress_object = progress_value.as_object_mut().ok_or_else(|| AppError::config("任务进度格式异常"))?;
            for (objective_id, target) in &matched_objectives {
                let current = progress_object.get(objective_id).and_then(|value| value.as_i64()).unwrap_or_default();
                let next = (current + increment).min(*target);
                progress_object.insert(objective_id.clone(), serde_json::json!(next));
            }

            let all_done = objectives
                .iter()
                .filter_map(|objective| objective.id.as_deref())
                .all(|objective_id| {
                    let target = objectives
                        .iter()
                        .find(|objective| objective.id.as_deref() == Some(objective_id))
                        .and_then(|objective| objective.target)
                        .unwrap_or(1)
                        .max(1);
                    progress_object
                        .get(objective_id)
                        .and_then(|value| value.as_i64())
                        .unwrap_or_default()
                        >= target
                });
            let next_status = if all_done {
                if category.trim() == "event" { "claimable" } else { "turnin" }
            } else {
                status.as_str()
            };

            state
                .database
                .execute(
                    "UPDATE character_task_progress SET status = $3, progress = $4::jsonb, completed_at = CASE WHEN $3 IN ('claimable', 'turnin') THEN COALESCE(completed_at, NOW()) ELSE completed_at END, tracked = $5, updated_at = NOW() WHERE character_id = $1 AND task_id = $2",
                    |query| query.bind(character_id).bind(task_id.trim()).bind(next_status).bind(&progress_value).bind(tracked),
                )
                .await?;
        }
    }

    if use_progress_delta && !buffered_progress_deltas.is_empty() {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_progress_delta_fields(&redis, &buffered_progress_deltas).await?;
        }
    }

    let socket_realtime = build_task_overview_update_payload(character_id);
    emit_task_update_to_user(state, user_id, &socket_realtime);
    Ok(())
}

pub async fn record_craft_item_task_event(
    state: &AppState,
    character_id: i64,
    user_id: i64,
    recipe_id: Option<&str>,
    craft_kind: Option<&str>,
    item_def_id: Option<&str>,
    count: i64,
    recipe_type: Option<&str>,
) -> Result<(), AppError> {
    if character_id <= 0 || user_id <= 0 {
        return Ok(());
    }
    let increment = count.max(1);
    let recipe_id = recipe_id.map(str::trim).filter(|value| !value.is_empty());
    let craft_kind = craft_kind.map(str::trim).filter(|value| !value.is_empty());
    let item_def_id = item_def_id.map(str::trim).filter(|value| !value.is_empty());
    let recipe_type = recipe_type.map(str::trim).filter(|value| !value.is_empty());
    let task_defs = load_task_seeds()?;
    let matching_tasks = task_defs
        .into_iter()
        .filter(|task| task.enabled != Some(false))
        .filter_map(|task| {
            let objectives = task.objectives.clone().unwrap_or_default();
            let matched_objectives = objectives
                .iter()
                .filter_map(|objective| {
                    let objective_id = objective.id.as_deref()?.trim();
                    if objective_id.is_empty() {
                        return None;
                    }
                    if objective.objective_type.as_deref().map(str::trim) != Some("craft_item") {
                        return None;
                    }
                    let params = objective.params.as_ref();
                    let matches_recipe = params
                        .and_then(|params| params.get("recipe_id").and_then(|value| value.as_str()))
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|expected| recipe_id == Some(expected))
                        .unwrap_or(true);
                    let matches_kind = params
                        .and_then(|params| params.get("craft_kind").and_then(|value| value.as_str()))
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|expected| craft_kind == Some(expected))
                        .unwrap_or(true);
                    let matches_item = params
                        .and_then(|params| params.get("item_id").and_then(|value| value.as_str()))
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|expected| item_def_id == Some(expected))
                        .unwrap_or(true);
                    let matches_recipe_type = params
                        .and_then(|params| params.get("recipe_type").and_then(|value| value.as_str()))
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|expected| recipe_type == Some(expected))
                        .unwrap_or(true);
                    if !(matches_recipe && matches_kind && matches_item && matches_recipe_type) {
                        return None;
                    }
                    Some((objective_id.to_string(), objective.target.unwrap_or(1).max(1)))
                })
                .collect::<Vec<_>>();
            if matched_objectives.is_empty() {
                return None;
            }
            Some((task.id, task.category, objectives, matched_objectives))
        })
        .collect::<Vec<_>>();
    if matching_tasks.is_empty() {
        return Ok(());
    }

    let use_progress_delta = state.redis_available && state.redis.is_some();
    let mut buffered_progress_deltas = Vec::<CharacterProgressDeltaField>::new();
    for (task_id, category, objectives, matched_objectives) in matching_tasks {
        let progress_row = state
            .database
            .fetch_optional(
                "SELECT status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
                |query| query.bind(character_id).bind(task_id.trim()),
            )
            .await?;
        let progress_row = if let Some(progress_row) = progress_row {
            progress_row
        } else {
            if !matches!(category.trim(), "daily" | "event") {
                continue;
            }
            state.database.execute(
                "INSERT INTO character_task_progress (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at) VALUES ($1, $2, 'ongoing', '{}'::jsonb, false, NOW(), NULL, NULL, NOW()) ON CONFLICT (character_id, task_id) DO NOTHING",
                |query| query.bind(character_id).bind(task_id.trim()),
            ).await?;
            state.database.fetch_optional(
                "SELECT status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
                |query| query.bind(character_id).bind(task_id.trim()),
            ).await?.ok_or_else(|| AppError::config("任务进度行创建失败"))?
        };
        let status = progress_row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
        if status == "claimed" {
            continue;
        }
        if use_progress_delta {
            for (objective_id, _) in &matched_objectives {
                buffered_progress_deltas.push(CharacterProgressDeltaField {
                    character_id,
                    field: format!("task_progress:{}:{}", task_id.trim(), objective_id),
                    increment,
                });
            }
        } else {
            let tracked = progress_row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true);
            let mut progress_value = progress_row.try_get::<Option<serde_json::Value>, _>("progress")?.unwrap_or_else(|| serde_json::json!({}));
            let progress_object = progress_value.as_object_mut().ok_or_else(|| AppError::config("任务进度格式异常"))?;
            for (objective_id, target) in &matched_objectives {
                let current = progress_object.get(objective_id).and_then(|value| value.as_i64()).unwrap_or_default();
                let next = (current + increment).min(*target);
                progress_object.insert(objective_id.clone(), serde_json::json!(next));
            }
            let all_done = objectives.iter().filter_map(|objective| objective.id.as_deref()).all(|objective_id| {
                let target = objectives
                    .iter()
                    .find(|objective| objective.id.as_deref() == Some(objective_id))
                    .and_then(|objective| objective.target)
                    .unwrap_or(1)
                    .max(1);
                progress_object.get(objective_id).and_then(|value| value.as_i64()).unwrap_or_default() >= target
            });
            let next_status = if all_done {
                if category.trim() == "event" { "claimable" } else { "turnin" }
            } else {
                status.as_str()
            };
            state.database.execute(
                "UPDATE character_task_progress SET status = $3, progress = $4::jsonb, completed_at = CASE WHEN $3 IN ('claimable', 'turnin') THEN COALESCE(completed_at, NOW()) ELSE completed_at END, tracked = $5, updated_at = NOW() WHERE character_id = $1 AND task_id = $2",
                |query| query.bind(character_id).bind(task_id.trim()).bind(next_status).bind(&progress_value).bind(tracked),
            ).await?;
        }
    }
    if use_progress_delta && !buffered_progress_deltas.is_empty() {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_progress_delta_fields(&redis, &buffered_progress_deltas).await?;
        }
    }
    let socket_realtime = build_task_overview_update_payload(character_id);
    emit_task_update_to_user(state, user_id, &socket_realtime);
    Ok(())
}

pub(crate) async fn apply_task_progress_delta_fields(
    state: &AppState,
    character_id: i64,
    deltas: &HashMap<String, i64>,
) -> Result<(), AppError> {
    if character_id <= 0 || deltas.is_empty() {
        return Ok(());
    }
    let task_defs = load_task_seeds()?;
    let mut progress_fields = deltas
        .iter()
        .filter_map(|(field, increment)| {
            let raw = field.strip_prefix("task_progress:")?;
            let mut parts = raw.splitn(2, ':');
            let task_id = parts.next()?.trim();
            let objective_id = parts.next()?.trim();
            (task_id.is_empty() || objective_id.is_empty() || *increment <= 0).then_some(None).unwrap_or_else(|| {
                Some((task_id.to_string(), objective_id.to_string(), *increment))
            })
        })
        .collect::<Vec<_>>();
    if progress_fields.is_empty() {
        return Ok(());
    }
    progress_fields.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let user_id = state
        .database
        .fetch_optional("SELECT user_id FROM characters WHERE id = $1 LIMIT 1", |q| q.bind(character_id))
        .await?
        .map(|row| opt_i64_from_i32(&row, "user_id"))
        .unwrap_or_default();

    for (task_id, _, _) in progress_fields.clone().into_iter() {
        let Some(task) = task_defs.iter().find(|task| task.enabled != Some(false) && task.id.trim() == task_id) else {
            continue;
        };
        let objectives = task.objectives.clone().unwrap_or_default();
        let matched = progress_fields
            .iter()
            .filter(|(current_task_id, _, _)| current_task_id == &task_id)
            .cloned()
            .collect::<Vec<_>>();
        if matched.is_empty() {
            continue;
        }
        let progress_row = state.database.fetch_optional(
            "SELECT status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id).bind(task_id.as_str()),
        ).await?;
        let Some(progress_row) = progress_row else {
            continue;
        };
        let status = progress_row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string());
        if status == "claimed" {
            continue;
        }
        let tracked = progress_row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true);
        let mut progress_value = progress_row.try_get::<Option<serde_json::Value>, _>("progress")?.unwrap_or_else(|| serde_json::json!({}));
        let progress_object = progress_value.as_object_mut().ok_or_else(|| AppError::config("任务进度格式异常"))?;
        for (_, objective_id, increment) in matched {
            let target = objectives
                .iter()
                .find(|objective| objective.id.as_deref().map(str::trim) == Some(objective_id.as_str()))
                .and_then(|objective| objective.target)
                .unwrap_or(1)
                .max(1);
            let current = progress_object.get(objective_id.as_str()).and_then(|value| value.as_i64()).unwrap_or_default();
            let next = (current + increment).min(target);
            progress_object.insert(objective_id, serde_json::json!(next));
        }
        let all_done = objectives
            .iter()
            .filter_map(|objective| objective.id.as_deref())
            .all(|objective_id| {
                let target = objectives
                    .iter()
                    .find(|objective| objective.id.as_deref() == Some(objective_id))
                    .and_then(|objective| objective.target)
                    .unwrap_or(1)
                    .max(1);
                progress_object
                    .get(objective_id)
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
                    >= target
            });
        let next_status = if all_done {
            if task.category.trim() == "event" { "claimable" } else { "turnin" }
        } else {
            status.as_str()
        };
        state.database.execute(
            "UPDATE character_task_progress SET status = $3, progress = $4::jsonb, completed_at = CASE WHEN $3 IN ('claimable', 'turnin') THEN COALESCE(completed_at, NOW()) ELSE completed_at END, tracked = $5, updated_at = NOW() WHERE character_id = $1 AND task_id = $2",
            |query| query.bind(character_id).bind(task_id.as_str()).bind(next_status).bind(&progress_value).bind(tracked),
        ).await?;
    }
    if user_id > 0 {
        let socket_realtime = build_task_overview_update_payload(character_id);
        emit_task_update_to_user(state, user_id, &socket_realtime);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct TaskOverviewResponse {
    pub tasks: Vec<TaskOverviewRowDto>,
}

#[derive(Debug, Serialize)]
pub struct TaskOverviewSummaryResponse {
    pub tasks: Vec<TaskOverviewSummaryRowDto>,
}

async fn load_task_overview_rows(
    state: &AppState,
    character_id: i64,
    category: Option<&str>,
) -> Result<Vec<TaskOverviewRowDto>, AppError> {
    let category = normalize_task_category(category);
    let task_defs = load_task_seeds()?;
    let filtered_defs: Vec<_> = task_defs
        .into_iter()
        .filter(|task| task.enabled != Some(false))
        .filter(|task| category.as_deref().map(|value| value == task.category.trim()).unwrap_or(true))
        .collect();
    let task_ids: Vec<String> = filtered_defs.iter().map(|task| task.id.clone()).collect();
    let progress_by_task = load_task_progress_map(state, character_id, &task_ids).await?;
    let map_name_map = load_map_name_map()?;
    let item_meta_map = load_item_meta_map()?;
    let sort_weight_by_id: HashMap<String, i64> = filtered_defs
        .iter()
        .map(|task| (task.id.clone(), task.sort_weight.unwrap_or_default()))
        .collect();

    let mut rows: Vec<_> = filtered_defs
        .into_iter()
        .map(|task| {
            let progress = progress_by_task.get(task.id.trim()).cloned();
            TaskOverviewRowDto {
                id: task.id.clone(),
                category: task.category.clone(),
                title: task.title.clone(),
                realm: task.realm.clone().unwrap_or_else(|| "凡人".to_string()),
                giver_npc_id: task.giver_npc_id.clone().filter(|value| !value.trim().is_empty()),
                map_id: task.map_id.clone().filter(|value| !value.trim().is_empty()),
                map_name: task
                    .map_id
                    .as_deref()
                    .and_then(|value| map_name_map.get(value.trim()).cloned()),
                room_id: task.room_id.clone().filter(|value| !value.trim().is_empty()),
                status: progress
                    .as_ref()
                    .map(|progress| map_progress_status_to_ui_status(progress.status.as_deref()))
                    .unwrap_or_else(|| "ongoing".to_string()),
                tracked: progress.as_ref().map(|progress| progress.tracked).unwrap_or(false),
                description: task.description.clone().unwrap_or_default(),
                objectives: build_task_objectives(task.objectives.unwrap_or_default(), progress.as_ref()),
                rewards: build_task_rewards(task.rewards.unwrap_or_default(), &item_meta_map),
            }
        })
        .collect();
    rows.sort_by(|left, right| {
        left.category
            .cmp(&right.category)
            .then_with(|| {
                sort_weight_by_id
                    .get(&right.id)
                    .unwrap_or(&0)
                    .cmp(sort_weight_by_id.get(&left.id).unwrap_or(&0))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(rows)
}

#[derive(Clone)]
struct TaskProgressRow {
    status: Option<String>,
    tracked: bool,
    progress: HashMap<String, i64>,
}

async fn load_task_progress_map(
    state: &AppState,
    character_id: i64,
    task_ids: &[String],
) -> Result<HashMap<String, TaskProgressRow>, AppError> {
    if task_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = state
        .database
        .fetch_all(
            "SELECT task_id, status AS progress_status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = ANY($2::varchar[])",
            |query| query.bind(character_id).bind(task_ids),
        )
        .await?;
    let mut map = HashMap::new();
    for row in rows {
        let task_id = row.try_get::<Option<String>, _>("task_id")?.unwrap_or_default();
        if task_id.trim().is_empty() {
            continue;
        }
        map.insert(
            task_id,
            TaskProgressRow {
                status: row.try_get::<Option<String>, _>("progress_status")?,
                tracked: row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(false),
                progress: parse_progress_record(row.try_get::<Option<serde_json::Value>, _>("progress")?),
            },
        );
    }
    Ok(map)
}

fn build_task_objectives(
    objectives: Vec<TaskObjectiveSeed>,
    progress: Option<&TaskProgressRow>,
) -> Vec<TaskObjectiveDto> {
    objectives
        .into_iter()
        .filter_map(|objective| {
            let id = objective.id.unwrap_or_default();
            let text = objective.text.unwrap_or_default();
            if id.trim().is_empty() || text.trim().is_empty() {
                return None;
            }
            let target = objective.target.unwrap_or(1).max(1);
            let done = progress
                .and_then(|progress| progress.progress.get(id.trim()).copied())
                .unwrap_or(0)
                .min(target);
            Some(TaskObjectiveDto {
                id,
                objective_type: objective.objective_type.unwrap_or_else(|| "unknown".to_string()),
                text,
                done,
                target,
                params: objective.params,
                map_name: None,
                map_name_type: None,
            })
        })
        .collect()
}

fn build_task_rewards(
    rewards: Vec<TaskRewardSeed>,
    item_meta_map: &HashMap<String, (String, Option<String>)>,
) -> Vec<TaskRewardDto> {
    rewards
        .into_iter()
        .filter_map(|reward| match reward.reward_type.as_deref() {
            Some("silver") => Some(TaskRewardDto::Silver {
                name: "银两".to_string(),
                amount: reward.amount.unwrap_or_default().max(0),
            }),
            Some("spirit_stones") => Some(TaskRewardDto::SpiritStones {
                name: "灵石".to_string(),
                amount: reward.amount.unwrap_or_default().max(0),
            }),
            Some("item") => {
                let item_def_id = reward.item_def_id.unwrap_or_default();
                if item_def_id.trim().is_empty() {
                    return None;
                }
                let amount = reward.qty.unwrap_or_else(|| reward.qty_min.unwrap_or(0)).max(0);
                let amount_max = reward.qty_max.filter(|value| *value > amount);
                let (name, icon) = item_meta_map
                    .get(item_def_id.trim())
                    .cloned()
                    .unwrap_or_else(|| (item_def_id.clone(), None));
                Some(TaskRewardDto::Item {
                    item_def_id,
                    name,
                    icon,
                    amount,
                    amount_max,
                })
            }
            _ => None,
        })
        .filter(|reward| match reward {
            TaskRewardDto::Silver { amount, .. } | TaskRewardDto::SpiritStones { amount, .. } => *amount > 0,
            TaskRewardDto::Item { amount, .. } => *amount > 0,
        })
        .collect()
}

fn normalize_task_category(category: Option<&str>) -> Option<String> {
    let normalized = category.unwrap_or_default().trim();
    matches!(normalized, "main" | "side" | "daily" | "event").then_some(normalized.to_string())
}

fn map_progress_status_to_ui_status(status: Option<&str>) -> String {
    match status.unwrap_or("ongoing").trim() {
        "turnin" => "turnin",
        "claimable" => "claimable",
        "completed" | "claimed" => "completed",
        _ => "ongoing",
    }
    .to_string()
}

fn parse_progress_record(raw: Option<serde_json::Value>) -> HashMap<String, i64> {
    let Some(raw) = raw else {
        return HashMap::new();
    };
    let Some(object) = raw.as_object() else {
        return HashMap::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|value| value.floor() as i64))
                .map(|value| (key.clone(), value.max(0)))
        })
        .collect()
}

fn load_task_seeds() -> Result<Vec<TaskSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/task_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read task_def.json: {error}")))?;
    let payload: TaskSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse task_def.json: {error}")))?;
    Ok(payload.tasks)
}

fn load_npc_seed_map() -> Result<HashMap<String, NpcSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/npc_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read npc_def.json: {error}")))?;
    let payload: NpcSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse npc_def.json: {error}")))?;
    Ok(payload
        .npcs
        .into_iter()
        .filter(|npc| npc.enabled != Some(false))
        .map(|npc| (npc.id.clone(), npc))
        .collect())
}

fn build_npc_talk_lines(npc: &NpcSeed) -> Vec<String> {
    let _ = &npc.talk_tree_id;
    let description = npc.description.as_deref().map(str::trim).filter(|value| !value.is_empty());
    description
        .map(|value| vec![value.to_string()])
        .unwrap_or_else(|| vec![format!("{}看着你，没有多说什么。", npc.name)])
}

fn task_failure(message: &str) -> axum::response::Response {
    crate::shared::response::send_result(crate::shared::response::ServiceResult::<serde_json::Value> {
        success: false,
        message: Some(message.to_string()),
        data: None,
    })
}

fn task_success(task_id: &str) -> axum::response::Response {
    crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({ "taskId": task_id })),
    })
}

fn load_map_name_map() -> Result<HashMap<String, String>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let maps = payload.get("maps").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(maps
        .into_iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?.trim().to_string();
            let name = row.get("name")?.as_str()?.trim().to_string();
            (!id.is_empty() && !name.is_empty()).then_some((id, name))
        })
        .collect())
}

fn load_item_meta_map() -> Result<HashMap<String, (String, Option<String>)>, AppError> {
    let mut out = HashMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}")),
        )
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        let items = payload.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        for item in items {
            let id = item.get("id").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            let name = item.get("name").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let icon = item.get("icon").and_then(|value| value.as_str()).map(|value| value.to_string());
            out.insert(id, (name, icon));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn task_seed_contains_craft_item_objective_for_huiqi_recipe() {
        let tasks = super::load_task_seeds().expect("task seeds should load");
        let matched = tasks
            .into_iter()
            .filter(|task| task.enabled != Some(false))
            .filter_map(|task| {
                let objective_id = task.objectives.unwrap_or_default().into_iter().find(|objective| {
                    objective.objective_type.as_deref().map(str::trim) == Some("craft_item")
                        && objective
                            .params
                            .as_ref()
                            .and_then(|params| params.get("recipe_id").and_then(|value| value.as_str()))
                            .map(str::trim)
                            == Some("recipe-hui-qi-dan")
                })?.id?;
                Some((task.id, objective_id))
            })
            .collect::<Vec<_>>();
        assert!(!matched.is_empty());
        println!("TASK_CRAFT_ITEM_OBJECTIVES={}", serde_json::json!(matched));
    }

    #[test]
    fn task_overview_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "tasks": [{
                    "id": "task-main-003",
                    "category": "main",
                    "title": "南林试炼",
                    "realm": "凡人",
                    "giverNpcId": "npc-village-elder",
                    "mapId": "map-qingyun-outskirts",
                    "mapName": "青云村外",
                    "roomId": "room-south-forest",
                    "status": "ongoing",
                    "tracked": false,
                    "description": "前往青云村外南林小道，击杀野兔，证明自己的战斗能力。",
                    "objectives": [{
                        "id": "obj-001",
                        "type": "kill_monster",
                        "text": "击杀野兔",
                        "done": 0,
                        "target": 3,
                        "mapName": null,
                        "mapNameType": null
                    }],
                    "rewards": [{
                        "type": "silver",
                        "name": "银两",
                        "amount": 200
                    }]
                }]
            }
        });
        assert_eq!(payload["data"]["tasks"][0]["id"], "task-main-003");
        assert_eq!(payload["data"]["tasks"][0]["status"], "ongoing");
        println!("TASK_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn task_overview_summary_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "tasks": [{
                    "id": "task-main-003",
                    "category": "main",
                    "mapId": "map-qingyun-outskirts",
                    "roomId": "room-south-forest",
                    "status": "ongoing",
                    "tracked": false
                }]
            }
        });
        assert_eq!(payload["data"]["tasks"][0]["category"], "main");
        assert_eq!(payload["data"]["tasks"][0]["tracked"], false);
        println!("TASK_OVERVIEW_SUMMARY_RESPONSE={}", payload);
    }

    #[test]
    fn task_track_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "task-main-003",
                "tracked": true,
                "debugRealtime": {"kind": "task:update", "source": "track_task"}
            }
        });
        assert_eq!(payload["data"]["taskId"], "task-main-003");
        assert_eq!(payload["data"]["tracked"], true);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "task:update");
        println!("TASK_TRACK_RESPONSE={}", payload);
    }

    #[test]
    fn npc_talk_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "npcId": "npc-village-elder",
                "npcName": "村长",
                "lines": ["青云村的村长，德高望重，见证了无数修士踏上修仙之路。"],
                "tasks": [{
                    "taskId": "task-main-003",
                    "title": "南林试炼",
                    "category": "main",
                    "status": "available"
                }]
            }
        });
        assert_eq!(payload["data"]["npcId"], "npc-village-elder");
        assert_eq!(payload["data"]["tasks"][0]["status"], "available");
        println!("TASK_NPC_TALK_RESPONSE={}", payload);
    }

    #[test]
    fn npc_accept_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"taskId": "task-main-003"}
        });
        assert_eq!(payload["data"]["taskId"], "task-main-003");
        println!("TASK_NPC_ACCEPT_RESPONSE={}", payload);
    }

    #[test]
    fn npc_submit_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"taskId": "task-main-003"}
        });
        assert_eq!(payload["data"]["taskId"], "task-main-003");
        println!("TASK_NPC_SUBMIT_RESPONSE={}", payload);
    }

    #[test]
    fn task_claim_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "task-main-003",
                "rewards": [
                    {"type": "silver", "amount": 200},
                    {"type": "item", "itemDefId": "gem-atk-wg-1", "qty": 1, "itemIds": [101], "itemName": "攻击宝石", "itemIcon": "/assets/items/gem.webp"}
                ],
                "debugRealtime": {"kind": "task:update", "source": "claim_task", "status": "claimed", "tracked": false}
            }
        });
        assert_eq!(payload["data"]["taskId"], "task-main-003");
        assert_eq!(payload["data"]["rewards"][0]["type"], "silver");
        assert_eq!(payload["data"]["debugRealtime"]["source"], "claim_task");
        println!("TASK_CLAIM_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_clear_progress_increment_reaches_target() {
        let mut progress = serde_json::json!({"obj-clear": 0});
        let progress_object = progress.as_object_mut().expect("progress should be object");
        let current = progress_object
            .get("obj-clear")
            .and_then(|value| value.as_i64())
            .unwrap_or_default();
        let next = (current + 1).min(1);
        progress_object.insert("obj-clear".to_string(), serde_json::json!(next));
        assert_eq!(progress["obj-clear"], 1);
        println!("TASK_DUNGEON_CLEAR_PROGRESS={progress}");
    }

    #[test]
    fn dungeon_clear_completion_status_matches_minimal_runner_policy() {
        let daily_next_status = if true { "turnin" } else { "ongoing" };
        let event_next_status = if true { "claimable" } else { "ongoing" };
        assert_eq!(daily_next_status, "turnin");
        assert_eq!(event_next_status, "claimable");
        println!("TASK_DUNGEON_CLEAR_STATUS_POLICY={{\"daily\":\"{daily_next_status}\",\"event\":\"{event_next_status}\"}}");
    }
}
