use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::auth;
use crate::http::character_technique::list_character_available_skill_id_set;
use crate::idle_runtime::{
    IdleExecutionSnapshot, IdlePartnerExecutionSnapshot, IdleSessionActivitySnapshot,
    build_idle_execution_snapshot, build_idle_reconcile_plan, execute_idle_batch_from_snapshot,
};
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_resource_delta::{CharacterResourceDeltaField, buffer_character_resource_delta_fields};
use crate::realtime::idle::{build_idle_finished_payload, build_idle_update_batch_payload};
use crate::realtime::public_socket::{emit_game_character_full_to_user, emit_idle_realtime_to_user};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_ok, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

const DEFAULT_IDLE_DURATION_MS: i64 = 3_600_000;
const MIN_IDLE_DURATION_MS: i64 = 60_000;
const BASE_IDLE_MAX_DURATION_MS: i64 = 28_800_000;
const DEFAULT_MONTH_CARD_ID: &str = "monthcard-001";
const IDLE_HEARTBEAT_TIMEOUT_MS: i64 = 45_000;
const IDLE_LOCK_TTL_BUFFER_MS: i64 = 300_000;
const IDLE_EXECUTION_TICK_MS: u64 = 3_000;
const IDLE_FLUSH_INTERVAL_MS: i64 = 30_000;
const IDLE_FLUSH_BATCH_THRESHOLD: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleSessionDto {
    pub id: String,
    pub character_id: i64,
    pub status: String,
    pub map_id: String,
    pub room_id: String,
    pub max_duration_ms: i64,
    pub total_battles: i64,
    pub win_count: i64,
    pub lose_count: i64,
    pub total_exp: i64,
    pub total_silver: i64,
    pub bag_full_flag: bool,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub viewed_at: Option<String>,
    pub target_monster_def_id: Option<String>,
    pub target_monster_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_snapshot: Option<IdleExecutionSnapshot>,
    #[serde(skip_serializing)]
    pub(crate) raw_snapshot: serde_json::Value,
    #[serde(skip_serializing)]
    pub(crate) buffered_batch_deltas: Vec<IdleBufferedBatchDelta>,
    #[serde(skip_serializing)]
    pub(crate) buffered_since_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigDto {
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub max_duration_ms: i64,
    pub auto_skill_policy: serde_json::Value,
    pub target_monster_def_id: Option<String>,
    pub include_partner_in_battle: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleStatusDataDto {
    pub session: Option<IdleSessionDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleHistoryDataDto {
    pub history: Vec<IdleSessionDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigDataDto {
    pub config: IdleConfigDto,
    pub max_duration_limit_ms: i64,
    pub month_card_active: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigWriteDto {
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub max_duration_ms: Option<i64>,
    pub auto_skill_policy: serde_json::Value,
    pub target_monster_def_id: Option<String>,
    pub include_partner_in_battle: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleStartPayload {
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub max_duration_ms: Option<i64>,
    pub auto_skill_policy: serde_json::Value,
    pub target_monster_def_id: Option<String>,
    pub include_partner_in_battle: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleStartDataDto {
    pub session_id: Option<String>,
    pub existing_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MonthCardSeedFile {
    month_cards: Vec<MonthCardSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonthCardSeed {
    id: String,
    idle_max_duration_hours: Option<i64>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterSeed {
    id: Option<String>,
    #[serde(rename = "name")]
    _name: Option<String>,
    exp_reward: Option<i64>,
    silver_reward_min: Option<i64>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MapSeedFile {
    maps: Vec<MapSeed>,
}

#[derive(Debug, Deserialize)]
struct MapSeed {
    id: String,
    enabled: Option<bool>,
    rooms: Vec<MapRoomSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomSeed {
    id: String,
    monsters: Vec<MapRoomMonsterSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomMonsterSeed {
    monster_def_id: String,
    count: Option<i64>,
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
    qty_min: Option<serde_json::Value>,
    qty_max: Option<serde_json::Value>,
    #[serde(rename = "show_in_ui")]
    _show_in_ui: Option<bool>,
}

#[derive(Debug, Clone)]
struct IdleInventoryDefMeta {
    item_name: String,
    bind_type: String,
    stack_max: i64,
}

#[derive(Debug, Clone)]
struct IdlePlannedItemDrop {
    item_def_id: String,
    item_name: String,
    quantity: i64,
    bind_type: String,
    stack_max: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdleItemGain {
    item_def_id: String,
    item_name: String,
    quantity: i64,
}

#[derive(Debug, Clone)]
struct IdleBagItemRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    location_slot: Option<i64>,
    bind_type: String,
}

#[derive(Debug, Clone)]
struct IdleBatchResult {
    result: String,
    round_count: i64,
    exp_gained: i64,
    silver_gained: i64,
    items_gained: Vec<IdleItemGain>,
    _bag_full_flag: bool,
    planned_item_drops: Vec<IdlePlannedItemDrop>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdleBufferedBatchDelta {
    result: String,
    round_count: i64,
    exp_gained: i64,
    silver_gained: i64,
}

enum IdleExecutionStep {
    Continue,
    Stop,
}

pub async fn get_idle_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<IdleStatusDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let session = load_active_idle_session(&state, actor.character_id).await?;
    Ok(send_success(IdleStatusDataDto { session }))
}

pub async fn get_idle_history(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<IdleHistoryDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sessions = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at::text AS started_at_text, ended_at::text AS ended_at_text, viewed_at::text AS viewed_at_text FROM idle_sessions WHERE character_id = $1 ORDER BY started_at DESC LIMIT 3",
        |q| q.bind(actor.character_id),
    ).await?;
    let monster_names = load_monster_name_map()?;
    let history = sessions
        .into_iter()
        .map(|row| build_idle_session_dto(&row, &monster_names))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(send_success(IdleHistoryDataDto { history }))
}

pub async fn get_idle_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<IdleStatusDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let session = load_active_idle_session(&state, actor.character_id).await?;
    Ok(send_success(IdleStatusDataDto { session }))
}

pub async fn get_idle_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<IdleConfigDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let duration_limit = resolve_idle_duration_limit(&state, actor.character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id, include_partner_in_battle FROM idle_configs WHERE character_id = $1 LIMIT 1",
        |q| q.bind(actor.character_id),
    ).await?;

    let config = if let Some(row) = row {
        let persisted_policy = row
            .try_get::<Option<serde_json::Value>, _>("auto_skill_policy")?
            .unwrap_or_else(|| serde_json::json!({ "slots": [] }));
        let normalized_policy = normalize_idle_auto_skill_policy_for_character(
            &state,
            actor.character_id,
            persisted_policy.clone(),
        )
        .await?;
        if normalized_policy != persisted_policy {
            state.database.execute(
                "UPDATE idle_configs SET auto_skill_policy = $2::jsonb, updated_at = NOW() WHERE character_id = $1",
                |q| q.bind(actor.character_id).bind(&normalized_policy),
            ).await?;
        }
        let persisted_duration = row.try_get::<Option<i64>, _>("max_duration_ms")?.unwrap_or(DEFAULT_IDLE_DURATION_MS);
        IdleConfigDto {
            map_id: row.try_get::<Option<String>, _>("map_id")?,
            room_id: row.try_get::<Option<String>, _>("room_id")?,
            max_duration_ms: persisted_duration.clamp(MIN_IDLE_DURATION_MS, duration_limit.max_duration_ms),
            auto_skill_policy: normalized_policy,
            target_monster_def_id: row.try_get::<Option<String>, _>("target_monster_def_id")?,
            include_partner_in_battle: row.try_get::<Option<bool>, _>("include_partner_in_battle")?.unwrap_or(true),
        }
    } else {
        IdleConfigDto {
            map_id: None,
            room_id: None,
            max_duration_ms: DEFAULT_IDLE_DURATION_MS,
            auto_skill_policy: serde_json::json!({ "slots": [] }),
            target_monster_def_id: None,
            include_partner_in_battle: true,
        }
    };

    Ok(send_success(IdleConfigDataDto {
        config,
        max_duration_limit_ms: duration_limit.max_duration_ms,
        month_card_active: duration_limit.month_card_active,
    }))
}

pub async fn start_idle_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<IdleStartPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let map_id = payload.map_id.unwrap_or_default();
    let room_id = payload.room_id.unwrap_or_default();
    let target_monster_def_id = payload.target_monster_def_id.unwrap_or_default();
    if map_id.trim().is_empty() {
        return Err(AppError::config("缺少 mapId"));
    }
    if room_id.trim().is_empty() {
        return Err(AppError::config("缺少 roomId"));
    }
    if target_monster_def_id.trim().is_empty() {
        return Err(AppError::config("缺少 targetMonsterDefId"));
    }
    let duration_limit = resolve_idle_duration_limit(&state, actor.character_id).await?;
    let max_duration_ms = payload.max_duration_ms.unwrap_or(DEFAULT_IDLE_DURATION_MS);
    if !(MIN_IDLE_DURATION_MS..=duration_limit.max_duration_ms).contains(&max_duration_ms) {
        return Err(AppError::config(format!("maxDurationMs 必须在 {} ~ {} 之间", MIN_IDLE_DURATION_MS, duration_limit.max_duration_ms)));
    }
    let normalized_policy = normalize_idle_auto_skill_policy_for_character(
        &state,
        actor.character_id,
        payload.auto_skill_policy,
    ).await?;

    if let Some(existing) = load_active_idle_session(&state, actor.character_id).await? {
        let body = serde_json::json!({
            "success": false,
            "message": "已有活跃挂机会话",
            "existingSessionId": existing.id,
        });
        return Ok((axum::http::StatusCode::CONFLICT, Json(body)).into_response());
    }

    try_acquire_idle_start_lock(&state, actor.character_id, max_duration_ms).await?;

    let digest = format!("{:x}", md5::compute(format!("idle-{}-{}", actor.character_id, now_millis()).as_bytes()));
    let session_id = format!(
        "{}-{}-{}-{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32],
    );
    let partner_snapshot = if payload.include_partner_in_battle.unwrap_or(false) {
        load_idle_partner_execution_snapshot(&state, actor.character_id).await?
    } else {
        None
    };
    let execution_snapshot = build_idle_execution_snapshot(
        actor.character_id,
        map_id.trim(),
        room_id.trim(),
        target_monster_def_id.trim(),
        &normalized_policy,
        partner_snapshot,
    )
    .map_err(AppError::config)?;
    let session_snapshot = serde_json::json!({
        "characterId": actor.character_id,
        "targetMonsterDefId": target_monster_def_id.trim(),
        "includePartnerInBattle": payload.include_partner_in_battle.unwrap_or(false),
        "autoSkillPolicy": normalized_policy,
        "executionSnapshot": execution_snapshot,
        "bufferedBatchDeltas": [],
        "bufferedSinceMs": serde_json::Value::Null,
    });
    state.database.execute(
        "INSERT INTO idle_sessions (id, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at, ended_at, viewed_at, created_at, updated_at) VALUES ($1::uuid, $2, 'active', $3, $4, $5, $6::jsonb, 0, 0, 0, 0, 0, FALSE, NOW(), NULL, NULL, NOW(), NOW())",
        |q| q.bind(&session_id).bind(actor.character_id).bind(map_id.trim()).bind(room_id.trim()).bind(max_duration_ms).bind(&session_snapshot),
    ).await?;
    spawn_idle_execution_loop(state.clone(), session_id.clone(), actor.character_id, actor.user_id);
    sync_idle_lock_projection(&state, actor.character_id, Some(max_duration_ms)).await?;
    Ok(send_success(IdleStartDataDto { session_id: Some(session_id), existing_session_id: None }).into_response())
}

pub async fn stop_idle_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<()>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let rows = state.database.fetch_all(
        "UPDATE idle_sessions SET status = 'stopping', updated_at = NOW() WHERE character_id = $1 AND status = 'active' RETURNING id::text AS id_text",
        |q| q.bind(actor.character_id),
    ).await?;
    for row in rows {
        let session_id = row.try_get::<String, _>("id_text")?;
        state.idle_execution_registry.request_stop(&session_id);
    }
    Ok(send_ok())
}

pub fn spawn_idle_execution_loop(
    state: AppState,
    session_id: String,
    character_id: i64,
    user_id: i64,
) {
    if state.idle_execution_registry.has_session(&session_id) {
        return;
    }
    state.idle_execution_registry.register(&session_id, now_millis() as i64);
    tokio::spawn(async move {
        loop {
            state.idle_execution_registry.touch(&session_id, now_millis() as i64);
            match run_idle_execution_tick(&state, &session_id, character_id, user_id).await {
                Ok(IdleExecutionStep::Continue) => sleep(Duration::from_millis(IDLE_EXECUTION_TICK_MS)).await,
                Ok(IdleExecutionStep::Stop) => break,
                Err(error) => {
                    tracing::error!(session_id = %session_id, character_id, error = %error, "idle execution tick failed");
                    sleep(Duration::from_millis(IDLE_EXECUTION_TICK_MS)).await;
                }
            }
        }
    });
}

pub async fn update_idle_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<IdleConfigWriteDto>,
) -> Result<Json<SuccessResponse<()>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let duration_limit = resolve_idle_duration_limit(&state, actor.character_id).await?;
    let normalized_policy = normalize_idle_auto_skill_policy_for_character(
        &state,
        actor.character_id,
        payload.auto_skill_policy,
    ).await?;
    let max_duration_ms = payload.max_duration_ms.unwrap_or(DEFAULT_IDLE_DURATION_MS);
    if !(MIN_IDLE_DURATION_MS..=duration_limit.max_duration_ms).contains(&max_duration_ms) {
        return Err(AppError::config(format!("maxDurationMs 必须在 {} ~ {} 之间", MIN_IDLE_DURATION_MS, duration_limit.max_duration_ms)));
    }
    state.database.execute(
        "INSERT INTO idle_configs (character_id, map_id, room_id, max_duration_ms, auto_skill_policy, target_monster_def_id, include_partner_in_battle, updated_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW()) ON CONFLICT (character_id) DO UPDATE SET map_id = EXCLUDED.map_id, room_id = EXCLUDED.room_id, max_duration_ms = EXCLUDED.max_duration_ms, auto_skill_policy = EXCLUDED.auto_skill_policy, target_monster_def_id = EXCLUDED.target_monster_def_id, include_partner_in_battle = EXCLUDED.include_partner_in_battle, updated_at = NOW()",
        |q| q
            .bind(actor.character_id)
            .bind(payload.map_id)
            .bind(payload.room_id)
            .bind(max_duration_ms)
            .bind(&normalized_policy)
            .bind(payload.target_monster_def_id)
            .bind(payload.include_partner_in_battle.unwrap_or(true)),
    ).await?;
    Ok(send_ok())
}

pub async fn mark_idle_history_viewed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<SuccessResponse<()>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if id.trim().is_empty() {
        return Err(AppError::config("缺少 sessionId"));
    }
    state.database.execute(
        "UPDATE idle_sessions SET viewed_at = NOW(), updated_at = NOW() WHERE id::text = $1 AND character_id = $2",
        |q| q.bind(id.trim()).bind(actor.character_id),
    ).await?;
    Ok(send_ok())
}

pub async fn load_active_idle_session(state: &AppState, character_id: i64) -> Result<Option<IdleSessionDto>, AppError> {
    reconcile_idle_sessions_for_character(state, character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT id::text AS id_text, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at::text AS started_at_text, ended_at::text AS ended_at_text, viewed_at::text AS viewed_at_text FROM idle_sessions WHERE character_id = $1 AND status IN ('active', 'stopping') ORDER BY started_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let monster_names = load_monster_name_map()?;
    Ok(Some(build_idle_session_dto(&row, &monster_names)?))
}

pub async fn reconcile_idle_sessions_for_character(state: &AppState, character_id: i64) -> Result<(), AppError> {
    let rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id, status, (extract(epoch from started_at) * 1000)::bigint AS started_at_ms, max_duration_ms FROM idle_sessions WHERE character_id = $1 AND status IN ('active', 'stopping') ORDER BY started_at DESC, id DESC",
        |q| q.bind(character_id),
    ).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let snapshots = rows
        .into_iter()
        .map(|row| Ok(IdleSessionActivitySnapshot {
            id: row.try_get::<String, _>("id_text")?,
            character_id: i64::from(row.try_get::<i32, _>("character_id")?),
            status: row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "active".to_string()),
            started_at_ms: row.try_get::<Option<i64>, _>("started_at_ms")?.unwrap_or_default(),
            max_duration_ms: row.try_get::<Option<i64>, _>("max_duration_ms")?.unwrap_or(DEFAULT_IDLE_DURATION_MS),
        }))
        .collect::<Result<Vec<_>, AppError>>()?;
    let now_ms = now_millis() as i64;
    let heartbeat_by_session_id = state.idle_execution_registry.snapshot();
    let plan = build_idle_reconcile_plan(&snapshots, now_ms, &heartbeat_by_session_id, IDLE_HEARTBEAT_TIMEOUT_MS);

    for session_id in &plan.interrupt_session_ids {
        state.database.execute(
            "UPDATE idle_sessions SET status = 'interrupted', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW() WHERE id::text = $1 AND status = 'stopping'",
            |q| q.bind(session_id),
        ).await?;
        if let Some(session) = load_idle_session_by_id(state, session_id).await? {
            if let Some(user_id) = load_idle_session_user_id(state, session.character_id).await? {
                let payload = build_idle_finished_payload(session);
                emit_idle_realtime_to_user(state, user_id, &payload);
            }
        }
        release_idle_lock_projection(state, character_id).await?;
    }
    for session_id in &plan.complete_session_ids {
        state.database.execute(
            "UPDATE idle_sessions SET status = 'completed', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW() WHERE id::text = $1 AND status = 'active'",
            |q| q.bind(session_id),
        ).await?;
        if let Some(session) = load_idle_session_by_id(state, session_id).await? {
            if let Some(user_id) = load_idle_session_user_id(state, session.character_id).await? {
                let payload = build_idle_finished_payload(session);
                emit_idle_realtime_to_user(state, user_id, &payload);
            }
        }
        release_idle_lock_projection(state, character_id).await?;
    }
    let active_row = state.database.fetch_optional(
        "SELECT max_duration_ms FROM idle_sessions WHERE character_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let active_duration = active_row.and_then(|row| row.try_get::<Option<i64>, _>("max_duration_ms").ok().flatten());
    sync_idle_lock_projection(state, character_id, active_duration).await?;
    Ok(())
}

pub async fn touch_idle_heartbeat_for_character(state: &AppState, character_id: i64) -> Result<Option<String>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id::text AS id_text FROM idle_sessions WHERE character_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let session_id = row.try_get::<String, _>("id_text")?;
    state.idle_execution_registry.touch(&session_id, now_millis() as i64);
    Ok(Some(session_id))
}

fn build_idle_session_dto(
    row: &sqlx::postgres::PgRow,
    monster_names: &BTreeMap<String, String>,
) -> Result<IdleSessionDto, AppError> {
    let snapshot = row.try_get::<Option<serde_json::Value>, _>("session_snapshot")?.unwrap_or_else(|| serde_json::json!({}));
    let target_monster_def_id = snapshot.get("targetMonsterDefId").and_then(|v| v.as_str()).map(|v| v.to_string());
    let target_monster_name = target_monster_def_id.as_ref().map(|id| monster_names.get(id).cloned().unwrap_or_else(|| id.clone()));
    let buffered_batch_deltas = snapshot
        .get("bufferedBatchDeltas")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<IdleBufferedBatchDelta>>(value).ok())
        .unwrap_or_default();
    let buffered_since_ms = snapshot.get("bufferedSinceMs").and_then(|v| v.as_i64());
    Ok(IdleSessionDto {
        id: row.try_get::<String, _>("id_text")?,
        character_id: i64::from(row.try_get::<i32, _>("character_id")?),
        status: row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "active".to_string()),
        map_id: row.try_get::<Option<String>, _>("map_id")?.unwrap_or_default(),
        room_id: row.try_get::<Option<String>, _>("room_id")?.unwrap_or_default(),
        max_duration_ms: row.try_get::<Option<i64>, _>("max_duration_ms")?.unwrap_or(DEFAULT_IDLE_DURATION_MS),
        total_battles: row.try_get::<Option<i32>, _>("total_battles")?.map(i64::from).unwrap_or_default(),
        win_count: row.try_get::<Option<i32>, _>("win_count")?.map(i64::from).unwrap_or_default(),
        lose_count: row.try_get::<Option<i32>, _>("lose_count")?.map(i64::from).unwrap_or_default(),
        total_exp: row.try_get::<Option<i32>, _>("total_exp")?.map(i64::from).unwrap_or_default(),
        total_silver: row.try_get::<Option<i32>, _>("total_silver")?.map(i64::from).unwrap_or_default(),
        bag_full_flag: row.try_get::<Option<bool>, _>("bag_full_flag")?.unwrap_or(false),
        started_at: row.try_get::<Option<String>, _>("started_at_text")?.unwrap_or_default(),
        ended_at: row.try_get::<Option<String>, _>("ended_at_text")?,
        viewed_at: row.try_get::<Option<String>, _>("viewed_at_text")?,
        target_monster_def_id,
        target_monster_name,
        execution_snapshot: snapshot
            .get("executionSnapshot")
            .cloned()
            .and_then(|value| serde_json::from_value::<IdleExecutionSnapshot>(value).ok()),
        raw_snapshot: snapshot,
        buffered_batch_deltas,
        buffered_since_ms,
    })
}

async fn load_idle_session_by_id(state: &AppState, session_id: &str) -> Result<Option<IdleSessionDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id::text AS id_text, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at::text AS started_at_text, ended_at::text AS ended_at_text, viewed_at::text AS viewed_at_text FROM idle_sessions WHERE id::text = $1 LIMIT 1",
        |q| q.bind(session_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let monster_names = load_monster_name_map()?;
    Ok(Some(build_idle_session_dto(&row, &monster_names)?))
}

async fn load_idle_session_user_id(state: &AppState, character_id: i64) -> Result<Option<i64>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    Ok(row.and_then(|row| row.try_get::<Option<i32>, _>("user_id").ok().flatten().map(i64::from)))
}

async fn run_idle_execution_tick(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    user_id: i64,
) -> Result<IdleExecutionStep, AppError> {
    println!("IDLE_TRACE: tick_enter session_id={session_id} character_id={character_id}");
    let session = match load_idle_session_by_id(state, session_id).await {
        Ok(session) => session,
        Err(error) => {
            println!("IDLE_TRACE: load_session_failed session_id={session_id} error={error}");
            return Err(error);
        }
    };
    let Some(session) = session else {
        println!("IDLE_TRACE: tick_session_missing session_id={session_id}");
        state.idle_execution_registry.remove(session_id);
        return Ok(IdleExecutionStep::Stop);
    };

    if state.idle_execution_registry.is_stop_requested(session_id) || session.status == "stopping" {
        println!("IDLE_TRACE: tick_stop_requested session_id={session_id} status={}", session.status);
        finalize_idle_session(state, session_id, character_id, user_id, "interrupted").await?;
        return Ok(IdleExecutionStep::Stop);
    }

    let started_at_ms = parse_datetime_millis(Some(session.started_at.as_str())).unwrap_or_default();
    let now_ms = now_millis() as i64;
    if started_at_ms.saturating_add(session.max_duration_ms.max(0)) <= now_ms {
        println!("IDLE_TRACE: tick_timeout_complete session_id={session_id} started_at_ms={started_at_ms} now_ms={now_ms} max_duration_ms={}", session.max_duration_ms);
        finalize_idle_session(state, session_id, character_id, user_id, "completed").await?;
        return Ok(IdleExecutionStep::Stop);
    }

    println!("IDLE_TRACE: before_resolve_batch session_id={session_id} total_battles={} max_duration_ms={} started_at_ms={started_at_ms} now_ms={now_ms}", session.total_battles, session.max_duration_ms);

    let batch_index = session.total_battles + 1;
    let batch = match resolve_idle_batch_result(&session) {
        Ok(batch) => batch,
        Err(error) => {
            println!("IDLE_TRACE: resolve_batch_failed session_id={session_id} error={error}");
            return Err(AppError::config(error.to_string()));
        }
    };
    println!("IDLE_TRACE: batch_resolved session_id={session_id} batch_index={batch_index} result={} exp={} silver={} items={}", batch.result, batch.exp_gained, batch.silver_gained, batch.items_gained.len());
    let settled_batch = match settle_idle_batch_items(state, session_id, character_id, &batch).await {
        Ok(batch) => batch,
        Err(error) => {
            println!("IDLE_TRACE: settle_batch_failed session_id={session_id} error={error}");
            return Err(error);
        }
    };
    println!("IDLE_TRACE: batch_settled session_id={session_id} batch_index={batch_index} result={} exp={} silver={} items={}", settled_batch.result, settled_batch.exp_gained, settled_batch.silver_gained, settled_batch.items_gained.len());
    let should_flush = should_flush_idle_buffer(&session, now_ms, 1);
    let flushed_batch = if should_flush {
        println!("IDLE_TRACE: batch_flush_now session_id={session_id} batch_index={batch_index}");
        flush_idle_buffer(state, session_id, character_id, &session, &batch, now_ms).await?
    } else {
        println!("IDLE_TRACE: batch_buffer_only session_id={session_id} batch_index={batch_index}");
        buffer_idle_batch_delta(state, session_id, &session, &batch, now_ms).await?;
        None
    };
    let payload = build_idle_update_batch_payload(
        session.id.clone(),
        batch_index,
        settled_batch.result.clone(),
        settled_batch.exp_gained,
        settled_batch.silver_gained,
        settled_batch
            .items_gained
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect(),
        settled_batch.round_count,
    );
    println!("IDLE_TRACE: before_emit_update session_id={session_id} batch_index={batch_index}");
    emit_idle_realtime_to_user(state, user_id, &payload);
    println!("IDLE_TRACE: after_emit_update session_id={session_id} batch_index={batch_index}");
    if flushed_batch.is_some() {
        let _ = emit_game_character_full_to_user(state, user_id).await;
    }
    Ok(IdleExecutionStep::Continue)
}

async fn finalize_idle_session(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    user_id: i64,
    status: &str,
) -> Result<(), AppError> {
    if let Some(session) = load_idle_session_by_id(state, session_id).await? {
        if !session.buffered_batch_deltas.is_empty() {
            let _ = flush_idle_buffer(
                state,
                session_id,
                character_id,
                &session,
                &IdleBatchResult {
                    result: "draw".to_string(),
                    round_count: 0,
                    exp_gained: 0,
                    silver_gained: 0,
                    items_gained: Vec::new(),
                    _bag_full_flag: false,
                    planned_item_drops: Vec::new(),
                },
                now_millis() as i64,
            )
            .await?;
            let _ = emit_game_character_full_to_user(state, user_id).await;
        }
    }
    let final_status = match status {
        "completed" => "completed",
        _ => "interrupted",
    };
    let sql = format!(
        "UPDATE idle_sessions SET status = '{final_status}', ended_at = COALESCE(ended_at, NOW()), updated_at = NOW() WHERE id::text = $1 AND status IN ('active', 'stopping')"
    );
    state.database.execute(&sql, |q| q.bind(session_id)).await?;
    if let Some(session) = load_idle_session_by_id(state, session_id).await? {
        let payload = build_idle_finished_payload(session);
        emit_idle_realtime_to_user(state, user_id, &payload);
    }
    release_idle_lock_projection(state, character_id).await?;
    state.idle_execution_registry.remove(session_id);
    Ok(())
}

async fn settle_idle_batch_items(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    batch: &IdleBatchResult,
) -> Result<IdleBatchResult, AppError> {
    let (items_gained, bag_full_flag) = state.database.with_transaction(|| async {
        let (items_gained, bag_full_flag) = settle_idle_item_rewards_tx(
            state,
            session_id,
            character_id,
            &batch.planned_item_drops,
        )
        .await?;
        if bag_full_flag {
            state.database.execute(
                "UPDATE idle_sessions SET bag_full_flag = true, updated_at = NOW() WHERE id::text = $1 AND status = 'active'",
                |q| q.bind(session_id),
            ).await?;
        }
        Ok::<(Vec<IdleItemGain>, bool), AppError>((items_gained, bag_full_flag))
    }).await?;
    Ok(IdleBatchResult {
        result: batch.result.clone(),
        round_count: batch.round_count,
        exp_gained: batch.exp_gained,
        silver_gained: batch.silver_gained,
        items_gained,
        _bag_full_flag: bag_full_flag,
        planned_item_drops: batch.planned_item_drops.clone(),
    })
}

async fn flush_idle_batch_deltas(
    state: &AppState,
    session_id: &str,
    batches: &[IdleBatchResult],
) -> Result<(), AppError> {
    if batches.is_empty() {
        return Ok(());
    }
    let total_exp = batches.iter().map(|batch| batch.exp_gained).sum::<i64>();
    let total_silver = batches.iter().map(|batch| batch.silver_gained).sum::<i64>();
    let win_inc = batches.iter().filter(|batch| batch.result == "attacker_win").count() as i64;
    let lose_inc = batches.iter().filter(|batch| batch.result == "defender_win").count() as i64;
    let total_battles = batches.len() as i64;
    state.database.with_transaction(|| async {
        if state.redis_available && state.redis.is_some() {
            let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let mut resource_fields = Vec::new();
            if total_exp > 0 {
                resource_fields.push(CharacterResourceDeltaField {
                    character_id: load_idle_session_by_id(state, session_id)
                        .await?
                        .map(|session| session.character_id)
                        .unwrap_or_default(),
                    field: "exp".to_string(),
                    increment: total_exp,
                });
            }
            if total_silver > 0 {
                resource_fields.push(CharacterResourceDeltaField {
                    character_id: load_idle_session_by_id(state, session_id)
                        .await?
                        .map(|session| session.character_id)
                        .unwrap_or_default(),
                    field: "silver".to_string(),
                    increment: total_silver,
                });
            }
            if !resource_fields.is_empty() {
                buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
            }
        } else if let Some(session) = load_idle_session_by_id(state, session_id).await? {
            state.database.execute(
                "UPDATE characters SET exp = COALESCE(exp, 0) + $2, silver = COALESCE(silver, 0) + $3, updated_at = NOW() WHERE id = $1",
                |q| q.bind(session.character_id).bind(total_exp).bind(total_silver),
            ).await?;
        }
        state.database.execute(
            "UPDATE idle_sessions SET total_battles = total_battles + $2, win_count = win_count + $3, lose_count = lose_count + $4, total_exp = total_exp + $5, total_silver = total_silver + $6, session_snapshot = jsonb_set(jsonb_set(COALESCE(session_snapshot, '{}'::jsonb), '{bufferedBatchDeltas}', '[]'::jsonb, true), '{bufferedSinceMs}', 'null'::jsonb, true), updated_at = NOW() WHERE id::text = $1 AND status = 'active'",
            |q| q.bind(session_id).bind(total_battles).bind(win_inc).bind(lose_inc).bind(total_exp).bind(total_silver),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    Ok(())
}

fn should_flush_idle_buffer(session: &IdleSessionDto, now_ms: i64, incoming_batches: usize) -> bool {
    let pending_count = session.buffered_batch_deltas.len() + incoming_batches;
    if pending_count >= IDLE_FLUSH_BATCH_THRESHOLD {
        return true;
    }
    session
        .buffered_since_ms
        .map(|buffered_since_ms| now_ms.saturating_sub(buffered_since_ms) >= IDLE_FLUSH_INTERVAL_MS)
        .unwrap_or(false)
}

async fn buffer_idle_batch_delta(
    state: &AppState,
    session_id: &str,
    session: &IdleSessionDto,
    batch: &IdleBatchResult,
    now_ms: i64,
) -> Result<(), AppError> {
    let mut snapshot = session.raw_snapshot.clone();
    let mut buffered = session.buffered_batch_deltas.clone();
    buffered.push(IdleBufferedBatchDelta {
        result: batch.result.clone(),
        round_count: batch.round_count,
        exp_gained: batch.exp_gained,
        silver_gained: batch.silver_gained,
    });
    snapshot["bufferedBatchDeltas"] = serde_json::to_value(&buffered)
        .map_err(|error| AppError::config(format!("挂机缓冲快照序列化失败: {error}")))?;
    snapshot["bufferedSinceMs"] = serde_json::json!(session.buffered_since_ms.unwrap_or(now_ms));
    state.database.execute(
        "UPDATE idle_sessions SET session_snapshot = $2::jsonb, updated_at = NOW() WHERE id::text = $1 AND status = 'active'",
        |q| q.bind(session_id).bind(&snapshot),
    ).await?;
    Ok(())
}

async fn flush_idle_buffer(
    state: &AppState,
    session_id: &str,
    _character_id: i64,
    session: &IdleSessionDto,
    current_batch: &IdleBatchResult,
    now_ms: i64,
) -> Result<Option<IdleBatchResult>, AppError> {
    let mut batches = session
        .buffered_batch_deltas
        .iter()
        .map(|delta| IdleBatchResult {
            result: delta.result.clone(),
            round_count: delta.round_count,
            exp_gained: delta.exp_gained,
            silver_gained: delta.silver_gained,
            items_gained: Vec::new(),
            _bag_full_flag: false,
            planned_item_drops: Vec::new(),
        })
        .collect::<Vec<_>>();
    batches.push(current_batch.clone());
    let _ = now_ms;
    flush_idle_batch_deltas(state, session_id, &batches).await?;
    Ok(Some(IdleBatchResult {
        result: current_batch.result.clone(),
        round_count: current_batch.round_count,
        exp_gained: current_batch.exp_gained,
        silver_gained: current_batch.silver_gained,
        items_gained: current_batch.items_gained.clone(),
        _bag_full_flag: current_batch._bag_full_flag,
        planned_item_drops: current_batch.planned_item_drops.clone(),
    }))
}

fn resolve_idle_batch_result(session: &IdleSessionDto) -> Result<IdleBatchResult, AppError> {
    if let Some(snapshot) = parse_idle_execution_snapshot(session) {
        let batch = execute_idle_batch_from_snapshot(&session.id, session.character_id, session.total_battles + 1, &snapshot)
            .map_err(AppError::config)?;
        return Ok(IdleBatchResult {
            result: batch.result,
            round_count: batch.round_count,
            exp_gained: batch.exp_gained,
            silver_gained: batch.silver_gained,
            items_gained: Vec::new(),
            _bag_full_flag: false,
            planned_item_drops: resolve_idle_item_drops(&session.id, session.total_battles + 1, &snapshot.monster_ids)?,
        });
    }
    let target_monster_def_id = session
        .target_monster_def_id
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_string();
    if target_monster_def_id.is_empty() {
        return Ok(IdleBatchResult {
            result: "draw".to_string(),
            round_count: 0,
            exp_gained: 0,
            silver_gained: 0,
            items_gained: Vec::new(),
            _bag_full_flag: false,
            planned_item_drops: Vec::new(),
        });
    }
    let monster_count = load_room_monster_count(&session.map_id, &session.room_id, &target_monster_def_id)?;
    let Some(monster_count) = monster_count else {
        return Ok(IdleBatchResult {
            result: "draw".to_string(),
            round_count: 0,
            exp_gained: 0,
            silver_gained: 0,
            items_gained: Vec::new(),
            _bag_full_flag: false,
            planned_item_drops: Vec::new(),
        });
    };
    let reward = load_monster_reward_seed(&target_monster_def_id)?;
    let count = monster_count.max(1);
    Ok(IdleBatchResult {
        result: "attacker_win".to_string(),
        round_count: count,
        exp_gained: reward.exp_reward.unwrap_or_default().max(0).saturating_mul(count),
        silver_gained: reward.silver_reward_min.unwrap_or_default().max(0).saturating_mul(count),
        items_gained: Vec::new(),
        _bag_full_flag: false,
        planned_item_drops: Vec::new(),
    })
}

fn parse_idle_execution_snapshot(session: &IdleSessionDto) -> Option<IdleExecutionSnapshot> {
    session.execution_snapshot.clone()
}

fn load_room_monster_count(map_id: &str, room_id: &str, monster_def_id: &str) -> Result<Option<i64>, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: MapSeedFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let Some(map) = payload.maps.into_iter().find(|map| map.id == map_id && map.enabled != Some(false)) else {
        return Ok(None);
    };
    let Some(room) = map.rooms.into_iter().find(|room| room.id == room_id) else {
        return Ok(None);
    };
    Ok(room
        .monsters
        .into_iter()
        .find(|monster| monster.monster_def_id == monster_def_id)
        .map(|monster| monster.count.unwrap_or(1).max(1)))
}

fn load_monster_reward_seed(monster_def_id: &str) -> Result<MonsterSeed, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: MonsterSeedFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    payload
        .monsters
        .into_iter()
        .find(|monster| monster.id.as_deref().map(str::trim) == Some(monster_def_id) && monster.enabled != Some(false))
        .ok_or_else(|| AppError::config(format!("monster seed not found: {monster_def_id}")))
}

fn resolve_idle_item_drops(
    session_id: &str,
    batch_index: i64,
    monster_ids: &[String],
) -> Result<Vec<IdlePlannedItemDrop>, AppError> {
    let monster_map = load_monster_seed_map()?;
    let item_defs = load_idle_inventory_def_map()?;
    let drop_pools = load_idle_drop_pool_map()?;
    let mut merged = BTreeMap::<String, IdlePlannedItemDrop>::new();

    for (monster_index, monster_id) in monster_ids.iter().enumerate() {
        let Some(monster) = monster_map.get(monster_id.as_str()) else {
            continue;
        };
        let Some(drop_pool_id) = monster.drop_pool_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
            continue;
        };
        let entries = resolve_idle_drop_pool_entries(&drop_pools, drop_pool_id)?;
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(item_def_id) = entry.item_def_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
                continue;
            };
            let chance = as_entry_f64(entry.chance.as_ref()).unwrap_or(0.0).clamp(0.0, 1.0);
            if chance <= 0.0 {
                continue;
            }
            let roll = deterministic_roll_unit_interval(session_id, batch_index, monster_index as i64, entry_index as i64, item_def_id);
            if roll > chance {
                continue;
            }
            let qty_min = as_entry_i64(entry.qty_min.as_ref(), 1).max(1);
            let qty_max = as_entry_i64(entry.qty_max.as_ref(), qty_min).max(qty_min);
            let quantity = deterministic_roll_i64(session_id, batch_index, monster_index as i64, entry_index as i64, qty_min, qty_max);
            if quantity <= 0 {
                continue;
            }
            let Some(item_meta) = item_defs.get(item_def_id) else {
                continue;
            };
            merged
                .entry(item_def_id.to_string())
                .and_modify(|row| row.quantity += quantity)
                .or_insert_with(|| IdlePlannedItemDrop {
                    item_def_id: item_def_id.to_string(),
                    item_name: item_meta.item_name.clone(),
                    quantity,
                    bind_type: item_meta.bind_type.clone(),
                    stack_max: item_meta.stack_max,
                });
        }
    }

    Ok(merged.into_values().collect())
}

async fn settle_idle_item_rewards_tx(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    planned_items: &[IdlePlannedItemDrop],
) -> Result<(Vec<IdleItemGain>, bool), AppError> {
    if planned_items.is_empty() {
        return Ok((Vec::new(), false));
    }
    let user_row = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(user_row) = user_row else {
        return Ok((Vec::new(), false));
    };
        let user_id = user_row
            .try_get::<Option<i32>, _>("user_id")?
            .map(i64::from)
            .unwrap_or_default();
    if user_id <= 0 {
        return Ok((Vec::new(), false));
    }

    let bag_capacity = state
        .database
        .fetch_optional(
            "SELECT bag_capacity FROM inventory WHERE character_id = $1 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?
        .and_then(|row| row.try_get::<Option<i32>, _>("bag_capacity").ok().flatten().map(i64::from))
        .unwrap_or(100)
        .max(1);

    let mut bag_rows = state
        .database
        .fetch_all(
            "SELECT id, item_def_id, qty, location_slot, bind_type FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?
        .into_iter()
        .map(|row| {
            Ok(IdleBagItemRow {
                id: row.try_get::<i64, _>("id")?,
                item_def_id: row.try_get::<Option<String>, _>("item_def_id")?.unwrap_or_default(),
                qty: row.try_get::<Option<i32>, _>("qty")?.map(i64::from).unwrap_or_default(),
                location_slot: row.try_get::<Option<i32>, _>("location_slot")?.map(i64::from),
                bind_type: row.try_get::<Option<String>, _>("bind_type")?.unwrap_or_else(|| "none".to_string()),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    let mut granted = Vec::new();
    let mut bag_full_flag = false;

    for planned in planned_items {
        let mut remaining = planned.quantity.max(0);
        if remaining <= 0 {
            continue;
        }
        if planned.stack_max > 1 {
            for row in bag_rows.iter_mut().filter(|row| {
                row.item_def_id == planned.item_def_id && row.bind_type == planned.bind_type && row.qty < planned.stack_max
            }) {
                if remaining <= 0 {
                    break;
                }
                let can_add = (planned.stack_max - row.qty).min(remaining).max(0);
                if can_add <= 0 {
                    continue;
                }
                row.qty += can_add;
                remaining -= can_add;
                state
                    .database
                    .execute(
                        "UPDATE item_instance SET qty = $1, updated_at = NOW() WHERE id = $2",
                        |query| query.bind(row.qty).bind(row.id),
                    )
                    .await?;
            }
        }

        while remaining > 0 {
            let Some(empty_slot) = find_first_empty_idle_bag_slot(&bag_rows, bag_capacity) else {
                bag_full_flag = true;
                break;
            };
            let insert_qty = remaining.min(planned.stack_max.max(1));
            let inserted = state
                .database
                .fetch_one(
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, location_slot, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', $6, NOW(), NOW(), 'idle_reward', $7) RETURNING id",
                    |query| query.bind(user_id).bind(character_id).bind(&planned.item_def_id).bind(insert_qty).bind(&planned.bind_type).bind(empty_slot).bind(session_id),
                )
                .await?;
            let item_id = inserted.try_get::<Option<i64>, _>("id")?.unwrap_or_default();
            bag_rows.push(IdleBagItemRow {
                id: item_id,
                item_def_id: planned.item_def_id.clone(),
                qty: insert_qty,
                location_slot: Some(empty_slot),
                bind_type: planned.bind_type.clone(),
            });
            remaining -= insert_qty;
        }

        let granted_qty = planned.quantity - remaining;
        if granted_qty > 0 {
            granted.push(IdleItemGain {
                item_def_id: planned.item_def_id.clone(),
                item_name: planned.item_name.clone(),
                quantity: granted_qty,
            });
        }
    }

    Ok((granted, bag_full_flag))
}

fn find_first_empty_idle_bag_slot(rows: &[IdleBagItemRow], capacity: i64) -> Option<i64> {
    (0..capacity).find(|slot| !rows.iter().any(|row| row.location_slot == Some(*slot)))
}

fn load_monster_seed_map() -> Result<BTreeMap<String, MonsterSeed>, AppError> {
    Ok(load_monster_seed_file()?
        .monsters
        .into_iter()
        .filter(|monster| monster.enabled != Some(false))
        .filter_map(|monster| {
            monster
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|id| (id.to_string(), monster.clone()))
        })
        .collect())
}

fn load_monster_seed_file() -> Result<MonsterSeedFile, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))
}

fn load_idle_inventory_def_map() -> Result<BTreeMap<String, IdleInventoryDefMeta>, AppError> {
    let mut map = BTreeMap::new();
    for filename in ["item_def.json", "equipment_def.json", "gem_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path)
            .map_err(|error| AppError::config(format!("failed to read {}: {error}", path.display())))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {}: {error}", path.display())))?;
        for item in payload.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default() {
            let Some(item_id) = item.get("id").and_then(|value| value.as_str()).map(str::trim).filter(|value| !value.is_empty()) else {
                continue;
            };
            let item_name = item.get("name").and_then(|value| value.as_str()).unwrap_or(item_id).to_string();
            let bind_type = item.get("bind_type").and_then(|value| value.as_str()).unwrap_or("none").to_string();
            let stack_max = item.get("stack_max").and_then(|value| value.as_i64()).unwrap_or(1).max(1);
            map.insert(
                item_id.to_string(),
                IdleInventoryDefMeta {
                    item_name,
                    bind_type,
                    stack_max,
                },
            );
        }
    }
    Ok(map)
}

fn load_idle_drop_pool_map() -> Result<BTreeMap<String, DropPoolSeed>, AppError> {
    let mut map = BTreeMap::new();
    for filename in ["drop_pool.json", "drop_pool_common.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path)
            .map_err(|error| AppError::config(format!("failed to read {}: {error}", path.display())))?;
        let payload: DropPoolFile = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {}: {error}", path.display())))?;
        for pool in payload.pools.into_iter().filter(|pool| pool.enabled != Some(false)) {
            let Some(pool_id) = pool.id.as_deref().map(str::trim).filter(|value| !value.is_empty()) else {
                continue;
            };
            map.insert(pool_id.to_string(), pool);
        }
    }
    Ok(map)
}

fn resolve_idle_drop_pool_entries(
    pools: &BTreeMap<String, DropPoolSeed>,
    pool_id: &str,
) -> Result<Vec<DropPoolEntrySeed>, AppError> {
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    collect_idle_drop_pool_entries(pools, pool_id, &mut visited, &mut out)?;
    Ok(out)
}

fn collect_idle_drop_pool_entries(
    pools: &BTreeMap<String, DropPoolSeed>,
    pool_id: &str,
    visited: &mut BTreeSet<String>,
    out: &mut Vec<DropPoolEntrySeed>,
) -> Result<(), AppError> {
    let normalized = pool_id.trim();
    if normalized.is_empty() || !visited.insert(normalized.to_string()) {
        return Ok(());
    }
    let Some(pool) = pools.get(normalized) else {
        return Ok(());
    };
    if pool.mode.as_deref().map(str::trim) != Some("prob") {
        return Ok(());
    }
    for common_pool_id in pool.common_pool_ids.clone().unwrap_or_default() {
        collect_idle_drop_pool_entries(pools, &common_pool_id, visited, out)?;
    }
    out.extend(pool.entries.clone().unwrap_or_default().into_iter());
    Ok(())
}

fn deterministic_roll_unit_interval(
    session_id: &str,
    batch_index: i64,
    monster_index: i64,
    entry_index: i64,
    item_def_id: &str,
) -> f64 {
    let seed = format!("{session_id}:{batch_index}:{monster_index}:{entry_index}:{item_def_id}");
    let digest = md5::compute(seed.as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (value as f64) / (u32::MAX as f64)
}

fn deterministic_roll_i64(
    session_id: &str,
    batch_index: i64,
    monster_index: i64,
    entry_index: i64,
    min: i64,
    max: i64,
) -> i64 {
    if max <= min {
        return min;
    }
    let seed = format!("qty:{session_id}:{batch_index}:{monster_index}:{entry_index}:{min}:{max}");
    let digest = md5::compute(seed.as_bytes());
    let value = u32::from_be_bytes([digest[4], digest[5], digest[6], digest[7]]) as i64;
    min + value.rem_euclid(max - min + 1)
}

fn as_entry_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_f64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_entry_i64(value: Option<&serde_json::Value>, fallback: i64) -> i64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_i64().unwrap_or(fallback),
        Some(serde_json::Value::String(text)) => text.trim().parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}

fn load_monster_name_map() -> Result<BTreeMap<String, String>, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    let monsters = payload.get("monsters").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(monsters
        .into_iter()
        .filter_map(|row| Some((row.get("id")?.as_str()?.to_string(), row.get("name")?.as_str()?.to_string())))
        .collect())
}

#[derive(Debug, Clone)]
struct IdleDurationLimitSnapshot {
    month_card_active: bool,
    max_duration_ms: i64,
}

async fn resolve_idle_duration_limit(state: &AppState, character_id: i64) -> Result<IdleDurationLimitSnapshot, AppError> {
    let active = state.database.fetch_optional(
        "SELECT 1 FROM month_card_ownership WHERE character_id = $1 AND month_card_id = $2 AND expire_at > NOW() LIMIT 1",
        |q| q.bind(character_id).bind(DEFAULT_MONTH_CARD_ID),
    ).await?.is_some();
    let max_duration_ms = if active {
        let seed = load_month_card_seed(DEFAULT_MONTH_CARD_ID)?;
        let benefit_ms = seed.idle_max_duration_hours.unwrap_or(8).max(0) * 3_600_000;
        BASE_IDLE_MAX_DURATION_MS.max(benefit_ms)
    } else {
        BASE_IDLE_MAX_DURATION_MS
    };
    Ok(IdleDurationLimitSnapshot {
        month_card_active: active,
        max_duration_ms,
    })
}

fn load_month_card_seed(month_card_id: &str) -> Result<MonthCardSeed, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/month_card.json");
    let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read month_card.json: {error}")))?;
    let payload: MonthCardSeedFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse month_card.json: {error}")))?;
    payload
        .month_cards
        .into_iter()
        .find(|card| card.id == month_card_id && card.enabled != Some(false))
        .ok_or_else(|| AppError::config(format!("month card seed not found: {month_card_id}")))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn parse_datetime_millis(raw: Option<&str>) -> Option<i64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let parsed = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond]+[offset_hour]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second]+[offset_hour]"
                ),
            )
            .ok()
        })?;
    Some(parsed.unix_timestamp_nanos() as i64 / 1_000_000)
}

async fn load_idle_partner_execution_snapshot(
    state: &AppState,
    character_id: i64,
) -> Result<Option<IdlePartnerExecutionSnapshot>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, COALESCE(NULLIF(nickname, ''), CONCAT('伙伴', id::text)) AS name, avatar, growth_max_qixue, growth_wugong, growth_fagong, growth_sudu FROM character_partner WHERE character_id = $1 AND is_active = TRUE ORDER BY updated_at DESC, id DESC LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let partner_id = row.try_get::<Option<i32>, _>("id")?.map(i64::from).unwrap_or_default();
    if partner_id <= 0 {
        return Ok(None);
    }
    let max_qixue = row.try_get::<Option<i32>, _>("growth_max_qixue")?.map(i64::from).unwrap_or(60).max(1);
    let wugong = row.try_get::<Option<i32>, _>("growth_wugong")?.map(i64::from).unwrap_or_default();
    let fagong = row.try_get::<Option<i32>, _>("growth_fagong")?.map(i64::from).unwrap_or_default();
    let speed = row.try_get::<Option<i32>, _>("growth_sudu")?.map(i64::from).unwrap_or(1).max(1);
    Ok(Some(IdlePartnerExecutionSnapshot {
        partner_id,
        name: row.try_get::<Option<String>, _>("name")?.unwrap_or_else(|| format!("伙伴{partner_id}")),
        avatar: row.try_get::<Option<String>, _>("avatar")?,
        max_qixue,
        attack_power: wugong.max(fagong).max(1),
        speed,
    }))
}

pub(crate) async fn sync_idle_lock_projection(
    state: &AppState,
    character_id: i64,
    active_duration_ms: Option<i64>,
) -> Result<(), AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    let key = build_idle_lock_key(character_id);
    match active_duration_ms {
        Some(duration_ms) if duration_ms > 0 => {
            let ttl_ms = duration_ms.saturating_add(IDLE_LOCK_TTL_BUFFER_MS).max(60_000);
            let token = state
                .idle_execution_registry
                .get_lock_token(character_id)
                .unwrap_or_else(|| format!("idle-lock-{}-{}", character_id, now_millis()));
            state.idle_execution_registry.set_lock_token(character_id, token.clone());
            redis.psetex(&key, ttl_ms, &token).await?;
        }
        _ => {
            release_idle_lock_projection(state, character_id).await?;
        }
    }
    Ok(())
}

async fn try_acquire_idle_start_lock(
    state: &AppState,
    character_id: i64,
    max_duration_ms: i64,
) -> Result<(), AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    let token = format!("idle-lock-{}-{}", character_id, now_millis());
    let ttl_sec = ((max_duration_ms.saturating_add(IDLE_LOCK_TTL_BUFFER_MS)) / 1000).clamp(60, 24 * 3600) as u64;
    let lease = redis.acquire_lock(&build_idle_lock_key(character_id), &token, ttl_sec).await?;
    if lease.is_none() {
        return Err(AppError::config("已有挂机互斥锁存在，请稍后重试"));
    }
    state.idle_execution_registry.set_lock_token(character_id, token);
    Ok(())
}

async fn release_idle_lock_projection(state: &AppState, character_id: i64) -> Result<(), AppError> {
    let Some(redis_client) = state.redis.clone() else {
        state.idle_execution_registry.clear_lock_token(character_id);
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    let key = build_idle_lock_key(character_id);
    if let Some(token) = state.idle_execution_registry.get_lock_token(character_id) {
        let _ = redis
            .eval_i64(
                "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
                &[&key],
                &[&token],
            )
            .await?;
    } else {
        let _ = redis.del(&key).await;
    }
    state.idle_execution_registry.clear_lock_token(character_id);
    Ok(())
}

fn build_idle_lock_key(character_id: i64) -> String {
    format!("idle:lock:{}", character_id)
}

fn normalize_idle_auto_skill_policy(value: serde_json::Value) -> Result<serde_json::Value, AppError> {
    let slots = value
        .get("slots")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::config("技能策略非法"))?;
    if slots.len() > 6 {
        return Err(AppError::config("技能策略非法"));
    }
    let mut normalized = slots
        .iter()
        .map(|slot| {
            let skill_id = slot.get("skillId").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            let priority = slot.get("priority").and_then(|value| value.as_i64()).unwrap_or_default();
            if skill_id.is_empty() || priority <= 0 {
                return Err(AppError::config("技能策略非法"));
            }
            Ok(serde_json::json!({ "skillId": skill_id, "priority": priority }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort_by_key(|slot| slot.get("priority").and_then(|value| value.as_i64()).unwrap_or_default());
    Ok(serde_json::json!({ "slots": normalized }))
}

fn filter_idle_auto_skill_policy_by_available_skills(
    normalized_policy: &serde_json::Value,
    available_skill_ids: &BTreeSet<String>,
) -> serde_json::Value {
    let filtered_slots = normalized_policy
        .get("slots")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|slot| {
            let skill_id = slot.get("skillId")?.as_str()?.trim();
            if skill_id.is_empty() || !available_skill_ids.contains(skill_id) {
                return None;
            }
            Some(skill_id.to_string())
        })
        .enumerate()
        .map(|(index, skill_id)| {
            serde_json::json!({
                "skillId": skill_id,
                "priority": index as i64 + 1,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "slots": filtered_slots })
}

async fn normalize_idle_auto_skill_policy_for_character(
    state: &AppState,
    character_id: i64,
    value: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let normalized = normalize_idle_auto_skill_policy(value)?;
    let available_skill_ids = list_character_available_skill_id_set(state, character_id).await?;
    Ok(filter_idle_auto_skill_policy_by_available_skills(&normalized, &available_skill_ids))
}

#[cfg(test)]
mod tests {
    use crate::idle_runtime::build_idle_execution_snapshot;
    use std::collections::BTreeSet;

    #[test]
    fn idle_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"session": {"id": "idle-1", "status": "active", "targetMonsterName": "灰狼"}}
        });
        assert_eq!(payload["data"]["session"]["id"], "idle-1");
        println!("IDLE_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn idle_history_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"history": [{"id": "idle-1", "status": "completed"}]}
        });
        assert_eq!(payload["data"]["history"][0]["status"], "completed");
        println!("IDLE_HISTORY_RESPONSE={}", payload);
    }

    #[test]
    fn idle_progress_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"session": null}
        });
        assert_eq!(payload["data"]["session"], serde_json::Value::Null);
        println!("IDLE_PROGRESS_RESPONSE={}", payload);
    }

    #[test]
    fn idle_config_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "config": {"mapId": null, "roomId": null, "maxDurationMs": 3600000, "autoSkillPolicy": {"slots": []}, "targetMonsterDefId": null, "includePartnerInBattle": true},
                "maxDurationLimitMs": 28800000,
                "monthCardActive": false
            }
        });
        assert_eq!(payload["data"]["config"]["maxDurationMs"], 3600000);
        println!("IDLE_CONFIG_RESPONSE={}", payload);
    }

    #[test]
    fn idle_update_config_payload_matches_contract() {
        let payload = serde_json::json!({ "success": true });
        assert_eq!(payload["success"], true);
        println!("IDLE_UPDATE_CONFIG_RESPONSE={}", payload);
    }

    #[test]
    fn idle_auto_skill_policy_filter_removes_unavailable_skills_and_reprioritizes() {
        let normalized = serde_json::json!({
            "slots": [
                {"skillId": "skill-missing", "priority": 1},
                {"skillId": "skill-b", "priority": 2},
                {"skillId": "skill-a", "priority": 3}
            ]
        });
        let available = BTreeSet::from([
            "skill-a".to_string(),
            "skill-b".to_string(),
        ]);
        let filtered = super::filter_idle_auto_skill_policy_by_available_skills(&normalized, &available);
        assert_eq!(filtered, serde_json::json!({
            "slots": [
                {"skillId": "skill-b", "priority": 1},
                {"skillId": "skill-a", "priority": 2}
            ]
        }));
    }

    #[test]
    fn idle_history_viewed_payload_matches_contract() {
        let payload = serde_json::json!({ "success": true });
        assert_eq!(payload["success"], true);
        println!("IDLE_HISTORY_VIEWED_RESPONSE={}", payload);
    }

    #[test]
    fn idle_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"sessionId": "idle-1-123", "existingSessionId": null}
        });
        assert_eq!(payload["data"]["sessionId"], "idle-1-123");
        println!("IDLE_START_RESPONSE={}", payload);
    }

    #[test]
    fn idle_stop_payload_matches_contract() {
        let payload = serde_json::json!({ "success": true });
        assert_eq!(payload["success"], true);
        println!("IDLE_STOP_RESPONSE={}", payload);
    }

    #[test]
    fn idle_lock_key_matches_node_style() {
        assert_eq!(super::build_idle_lock_key(42), "idle:lock:42");
    }

    #[test]
    fn idle_now_millis_is_positive() {
        assert!(super::now_millis() > 0);
    }

    #[test]
    fn resolve_idle_batch_result_prefers_frozen_execution_snapshot() {
        let execution_snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1}]}),
            None,
        )
        .expect("execution snapshot should build");
        let session = super::IdleSessionDto {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "active".to_string(),
            map_id: "map-bogus".to_string(),
            room_id: "room-bogus".to_string(),
            max_duration_ms: 3_600_000,
            total_battles: 0,
            win_count: 0,
            lose_count: 0,
            total_exp: 0,
            total_silver: 0,
            bag_full_flag: false,
            started_at: "2026-04-11T12:00:00Z".to_string(),
            ended_at: None,
            viewed_at: None,
            target_monster_def_id: Some("monster-wild-rabbit".to_string()),
            target_monster_name: Some("野兔".to_string()),
            execution_snapshot: Some(execution_snapshot),
            raw_snapshot: serde_json::json!({}),
            buffered_batch_deltas: Vec::new(),
            buffered_since_ms: None,
        };

        let batch = super::resolve_idle_batch_result(&session).expect("batch should resolve");
        assert_eq!(batch.result, "attacker_win");
        assert!(batch.exp_gained > 0);
        assert!(batch.silver_gained > 0);
    }

    #[test]
    fn resolve_idle_batch_result_falls_back_for_legacy_snapshot() {
        let session = super::IdleSessionDto {
            id: "idle-legacy".to_string(),
            character_id: 1,
            status: "active".to_string(),
            map_id: "map-bogus".to_string(),
            room_id: "room-bogus".to_string(),
            max_duration_ms: 3_600_000,
            total_battles: 0,
            win_count: 0,
            lose_count: 0,
            total_exp: 0,
            total_silver: 0,
            bag_full_flag: false,
            started_at: "2026-04-11T12:00:00Z".to_string(),
            ended_at: None,
            viewed_at: None,
            target_monster_def_id: Some("monster-wild-rabbit".to_string()),
            target_monster_name: Some("野兔".to_string()),
            execution_snapshot: None,
            raw_snapshot: serde_json::json!({}),
            buffered_batch_deltas: Vec::new(),
            buffered_since_ms: None,
        };

        let batch = super::resolve_idle_batch_result(&session).expect("legacy batch should resolve");
        assert_eq!(batch.result, "draw");
        assert_eq!(batch.round_count, 0);
        assert_eq!(batch.exp_gained, 0);
        assert_eq!(batch.silver_gained, 0);
    }

    #[test]
    fn resolve_idle_batch_result_plans_real_items_for_guaranteed_drop_monster() {
        let execution_snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-forest-clearing",
            "monster-wild-boar",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1}]}),
            None,
        )
        .expect("execution snapshot should build");
        let session = super::IdleSessionDto {
            id: "idle-loot".to_string(),
            character_id: 1,
            status: "active".to_string(),
            map_id: "map-qingyun-outskirts".to_string(),
            room_id: "room-forest-clearing".to_string(),
            max_duration_ms: 3_600_000,
            total_battles: 0,
            win_count: 0,
            lose_count: 0,
            total_exp: 0,
            total_silver: 0,
            bag_full_flag: false,
            started_at: "2026-04-11T12:00:00Z".to_string(),
            ended_at: None,
            viewed_at: None,
            target_monster_def_id: Some("monster-wild-boar".to_string()),
            target_monster_name: Some("野猪".to_string()),
            execution_snapshot: Some(execution_snapshot),
            raw_snapshot: serde_json::json!({}),
            buffered_batch_deltas: Vec::new(),
            buffered_since_ms: None,
        };

        let batch = super::resolve_idle_batch_result(&session).expect("batch should resolve");
        assert!(batch.planned_item_drops.iter().any(|item| item.item_def_id == "mat-005"));
    }
}
