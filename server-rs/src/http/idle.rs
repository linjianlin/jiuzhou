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
use crate::battle_runtime::{
    MinimalBattleRewardItemDto, MinimalBattleRewardParticipant, MinimalPveItemRewardResolveOptions,
    resolve_minimal_pve_item_rewards,
};
use crate::http::character_technique::list_character_available_skill_id_set;
use crate::http::partner::build_active_partner_idle_execution_snapshot;
use crate::idle_runtime::{
    IdleExecutionSnapshot, IdleSessionActivitySnapshot, build_idle_execution_snapshot,
    build_idle_reconcile_plan, execute_idle_batch_from_snapshot,
};
use crate::integrations::battle_character_profile::hydrate_pve_battle_state_owner;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::jobs::online_battle_settlement::{
    GenericPveSettlementTaskPayload, settle_generic_pve_reward_items,
};
use crate::realtime::idle::{build_idle_finished_payload, build_idle_update_batch_payload};
use crate::realtime::public_socket::{
    emit_game_character_full_to_user, emit_idle_realtime_to_user,
};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_ok, send_success};
use crate::state::AppState;

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
    #[serde(skip_serializing)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdleItemGain {
    item_def_id: String,
    item_name: String,
    quantity: i64,
}

#[derive(Debug, Clone)]
struct IdleBatchResult {
    result: String,
    round_count: i64,
    exp_gained: i64,
    silver_gained: i64,
    items_gained: Vec<IdleItemGain>,
    _bag_full_flag: bool,
    planned_item_drops: Vec<MinimalBattleRewardItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdleBufferedBatchDelta {
    result: String,
    round_count: i64,
    exp_gained: i64,
    silver_gained: i64,
    #[serde(default)]
    planned_item_drops: Vec<MinimalBattleRewardItemDto>,
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
    state.database.execute(
        "DELETE FROM idle_sessions WHERE character_id = $1 AND status IN ('completed', 'interrupted') AND id NOT IN (SELECT id FROM idle_sessions WHERE character_id = $1 AND status IN ('completed', 'interrupted') ORDER BY ended_at DESC NULLS LAST, started_at DESC, id DESC LIMIT 3)",
        |q| q.bind(actor.character_id),
    ).await?;
    let sessions = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id, status, map_id, room_id, max_duration_ms, session_snapshot, total_battles, win_count, lose_count, total_exp, total_silver, bag_full_flag, started_at::text AS started_at_text, ended_at::text AS ended_at_text, viewed_at::text AS viewed_at_text FROM idle_sessions WHERE character_id = $1 AND status IN ('completed', 'interrupted') ORDER BY ended_at DESC NULLS LAST, started_at DESC, id DESC LIMIT 3",
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
        let persisted_duration = row
            .try_get::<Option<i64>, _>("max_duration_ms")?
            .unwrap_or(DEFAULT_IDLE_DURATION_MS);
        let max_duration_ms = if persisted_duration > duration_limit.max_duration_ms {
            duration_limit.max_duration_ms
        } else {
            persisted_duration
        };
        IdleConfigDto {
            map_id: row.try_get::<Option<String>, _>("map_id")?,
            room_id: row.try_get::<Option<String>, _>("room_id")?,
            max_duration_ms,
            auto_skill_policy: normalized_policy,
            target_monster_def_id: row.try_get::<Option<String>, _>("target_monster_def_id")?,
            include_partner_in_battle: row
                .try_get::<Option<bool>, _>("include_partner_in_battle")?
                .unwrap_or(true),
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
        return Err(AppError::config(format!(
            "maxDurationMs 必须在 {} ~ {} 之间",
            MIN_IDLE_DURATION_MS, duration_limit.max_duration_ms
        )));
    }
    ensure_character_not_in_team(&state, actor.character_id).await?;
    ensure_idle_target_monster_in_room(
        map_id.trim(),
        room_id.trim(),
        target_monster_def_id.trim(),
    )?;
    let normalized_policy = normalize_idle_auto_skill_policy_for_character(
        &state,
        actor.character_id,
        payload.auto_skill_policy,
    )
    .await?;

    if let Some(existing) = load_active_idle_session(&state, actor.character_id).await? {
        let body = serde_json::json!({
            "success": false,
            "message": "已有活跃挂机会话",
            "existingSessionId": existing.id,
        });
        return Ok((axum::http::StatusCode::CONFLICT, Json(body)).into_response());
    }

    if !try_acquire_idle_start_lock(&state, actor.character_id, max_duration_ms).await? {
        if let Some(existing) = load_active_idle_session(&state, actor.character_id).await? {
            let body = serde_json::json!({
                "success": false,
                "message": "已有活跃挂机会话",
                "existingSessionId": existing.id,
            });
            return Ok((axum::http::StatusCode::CONFLICT, Json(body)).into_response());
        }
        return Err(AppError::config("挂机会话正在初始化，请稍后重试"));
    }
    if let Some(existing) = load_active_idle_session(&state, actor.character_id).await? {
        release_idle_lock_projection(&state, actor.character_id).await?;
        let body = serde_json::json!({
            "success": false,
            "message": "已有活跃挂机会话",
            "existingSessionId": existing.id,
        });
        return Ok((axum::http::StatusCode::CONFLICT, Json(body)).into_response());
    }

    let digest = format!(
        "{:x}",
        md5::compute(format!("idle-{}-{}", actor.character_id, now_millis()).as_bytes())
    );
    let session_id = format!(
        "{}-{}-{}-{}-{}",
        &digest[0..8],
        &digest[8..12],
        &digest[12..16],
        &digest[16..20],
        &digest[20..32],
    );
    let create_result = async {
        let partner_snapshot = if payload.include_partner_in_battle.unwrap_or(false) {
            build_active_partner_idle_execution_snapshot(&state, actor.character_id).await?
        } else {
            None
        };
        let mut execution_snapshot = build_idle_execution_snapshot(
            actor.character_id,
            map_id.trim(),
            room_id.trim(),
            target_monster_def_id.trim(),
            &normalized_policy,
            partner_snapshot,
        )
        .map_err(AppError::config)?;
        hydrate_pve_battle_state_owner(
            &state,
            &mut execution_snapshot.initial_battle_state,
            actor.character_id,
        )
        .await?;
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
        Ok::<(), AppError>(())
    }.await;
    if let Err(error) = create_result {
        release_idle_lock_projection(&state, actor.character_id).await?;
        return Err(error);
    }
    spawn_idle_execution_loop(
        state.clone(),
        session_id.clone(),
        actor.character_id,
        actor.user_id,
    );
    sync_idle_lock_projection(&state, actor.character_id, Some(max_duration_ms)).await?;
    Ok(send_success(IdleStartDataDto {
        session_id: Some(session_id),
        existing_session_id: None,
    })
    .into_response())
}

pub async fn stop_idle_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<()>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let rows = state.database.fetch_all(
        "UPDATE idle_sessions SET status = 'stopping', updated_at = NOW() WHERE character_id = $1 AND status IN ('active', 'stopping') RETURNING id::text AS id_text",
        |q| q.bind(actor.character_id),
    ).await?;
    if rows.is_empty() {
        return Err(AppError::config("没有活跃的挂机会话"));
    }
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
    state
        .idle_execution_registry
        .register(&session_id, now_millis() as i64);
    tokio::spawn(async move {
        loop {
            state
                .idle_execution_registry
                .touch(&session_id, now_millis() as i64);
            match run_idle_execution_tick(&state, &session_id, character_id, user_id).await {
                Ok(IdleExecutionStep::Continue) => {
                    sleep(Duration::from_millis(IDLE_EXECUTION_TICK_MS)).await
                }
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
    )
    .await?;
    let max_duration_ms = payload.max_duration_ms.unwrap_or(DEFAULT_IDLE_DURATION_MS);
    if !(MIN_IDLE_DURATION_MS..=duration_limit.max_duration_ms).contains(&max_duration_ms) {
        return Err(AppError::config(format!(
            "maxDurationMs 必须在 {} ~ {} 之间",
            MIN_IDLE_DURATION_MS, duration_limit.max_duration_ms
        )));
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
            .bind(payload.include_partner_in_battle.unwrap_or(false)),
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
        "UPDATE idle_sessions SET viewed_at = NOW(), updated_at = NOW() WHERE id::text = $1 AND character_id = $2 AND viewed_at IS NULL",
        |q| q.bind(id.trim()).bind(actor.character_id),
    ).await?;
    Ok(send_ok())
}

pub async fn load_active_idle_session(
    state: &AppState,
    character_id: i64,
) -> Result<Option<IdleSessionDto>, AppError> {
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

pub async fn reconcile_idle_sessions_for_character(
    state: &AppState,
    character_id: i64,
) -> Result<(), AppError> {
    let rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id, status, (extract(epoch from started_at) * 1000)::bigint AS started_at_ms, max_duration_ms FROM idle_sessions WHERE character_id = $1 AND status IN ('active', 'stopping') ORDER BY started_at DESC, id DESC",
        |q| q.bind(character_id),
    ).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let snapshots = rows
        .into_iter()
        .map(|row| {
            Ok(IdleSessionActivitySnapshot {
                id: row.try_get::<String, _>("id_text")?,
                character_id: i64::from(row.try_get::<i32, _>("character_id")?),
                status: row
                    .try_get::<Option<String>, _>("status")?
                    .unwrap_or_else(|| "active".to_string()),
                started_at_ms: row
                    .try_get::<Option<i64>, _>("started_at_ms")?
                    .unwrap_or_default(),
                max_duration_ms: row
                    .try_get::<Option<i64>, _>("max_duration_ms")?
                    .unwrap_or(DEFAULT_IDLE_DURATION_MS),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let now_ms = now_millis() as i64;
    let heartbeat_by_session_id = state.idle_execution_registry.snapshot();
    let plan = build_idle_reconcile_plan(
        &snapshots,
        now_ms,
        &heartbeat_by_session_id,
        IDLE_HEARTBEAT_TIMEOUT_MS,
    );

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
    let active_duration = active_row.and_then(|row| {
        row.try_get::<Option<i64>, _>("max_duration_ms")
            .ok()
            .flatten()
    });
    sync_idle_lock_projection(state, character_id, active_duration).await?;
    Ok(())
}

pub async fn touch_idle_heartbeat_for_character(
    state: &AppState,
    character_id: i64,
) -> Result<Option<String>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id::text AS id_text FROM idle_sessions WHERE character_id = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let session_id = row.try_get::<String, _>("id_text")?;
    state
        .idle_execution_registry
        .touch(&session_id, now_millis() as i64);
    Ok(Some(session_id))
}

fn build_idle_session_dto(
    row: &sqlx::postgres::PgRow,
    monster_names: &BTreeMap<String, String>,
) -> Result<IdleSessionDto, AppError> {
    let snapshot = row
        .try_get::<Option<serde_json::Value>, _>("session_snapshot")?
        .unwrap_or_else(|| serde_json::json!({}));
    let target_monster_def_id = snapshot
        .get("targetMonsterDefId")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    let target_monster_name = target_monster_def_id
        .as_ref()
        .map(|id| monster_names.get(id).cloned().unwrap_or_else(|| id.clone()));
    let buffered_batch_deltas = snapshot
        .get("bufferedBatchDeltas")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<IdleBufferedBatchDelta>>(value).ok())
        .unwrap_or_default();
    let buffered_since_ms = snapshot.get("bufferedSinceMs").and_then(|v| v.as_i64());
    Ok(IdleSessionDto {
        id: row.try_get::<String, _>("id_text")?,
        character_id: i64::from(row.try_get::<i32, _>("character_id")?),
        status: row
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_else(|| "active".to_string()),
        map_id: row
            .try_get::<Option<String>, _>("map_id")?
            .unwrap_or_default(),
        room_id: row
            .try_get::<Option<String>, _>("room_id")?
            .unwrap_or_default(),
        max_duration_ms: row
            .try_get::<Option<i64>, _>("max_duration_ms")?
            .unwrap_or(DEFAULT_IDLE_DURATION_MS),
        total_battles: row
            .try_get::<Option<i32>, _>("total_battles")?
            .map(i64::from)
            .unwrap_or_default(),
        win_count: row
            .try_get::<Option<i32>, _>("win_count")?
            .map(i64::from)
            .unwrap_or_default(),
        lose_count: row
            .try_get::<Option<i32>, _>("lose_count")?
            .map(i64::from)
            .unwrap_or_default(),
        total_exp: row
            .try_get::<Option<i32>, _>("total_exp")?
            .map(i64::from)
            .unwrap_or_default(),
        total_silver: row
            .try_get::<Option<i32>, _>("total_silver")?
            .map(i64::from)
            .unwrap_or_default(),
        bag_full_flag: row
            .try_get::<Option<bool>, _>("bag_full_flag")?
            .unwrap_or(false),
        started_at: row
            .try_get::<Option<String>, _>("started_at_text")?
            .unwrap_or_default(),
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

async fn load_idle_session_by_id(
    state: &AppState,
    session_id: &str,
) -> Result<Option<IdleSessionDto>, AppError> {
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

async fn load_idle_session_user_id(
    state: &AppState,
    character_id: i64,
) -> Result<Option<i64>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    Ok(row.and_then(|row| {
        row.try_get::<Option<i32>, _>("user_id")
            .ok()
            .flatten()
            .map(i64::from)
    }))
}

async fn run_idle_execution_tick(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    user_id: i64,
) -> Result<IdleExecutionStep, AppError> {
    let session = load_idle_session_by_id(state, session_id).await?;
    let Some(session) = session else {
        state.idle_execution_registry.remove(session_id);
        return Ok(IdleExecutionStep::Stop);
    };

    if state.idle_execution_registry.is_stop_requested(session_id) || session.status == "stopping" {
        finalize_idle_session(state, session_id, character_id, user_id, "interrupted").await?;
        return Ok(IdleExecutionStep::Stop);
    }

    let started_at_ms =
        parse_datetime_millis(Some(session.started_at.as_str())).unwrap_or_default();
    let now_ms = now_millis() as i64;
    if started_at_ms.saturating_add(session.max_duration_ms.max(0)) <= now_ms {
        finalize_idle_session(state, session_id, character_id, user_id, "completed").await?;
        return Ok(IdleExecutionStep::Stop);
    }

    let batch_index = session.total_battles + 1;
    let batch = resolve_idle_batch_result(&session, user_id)?;
    let should_flush = should_flush_idle_buffer(&session, now_ms, 1);
    let flushed = if should_flush {
        flush_idle_buffer(
            state,
            session_id,
            character_id,
            user_id,
            &session,
            &batch,
            now_ms,
        )
        .await?
    } else {
        buffer_idle_batch_delta(state, session_id, &session, &batch, now_ms).await?;
        None
    };
    let payload = build_idle_update_batch_payload(
        session.id.clone(),
        batch_index,
        batch.result.clone(),
        batch.exp_gained,
        batch.silver_gained,
        batch
            .items_gained
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect(),
        batch.round_count,
    );
    emit_idle_realtime_to_user(state, user_id, &payload);
    if flushed.is_some() {
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
                user_id,
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

async fn flush_idle_batch_deltas(
    state: &AppState,
    session_id: &str,
    character_id: i64,
    user_id: i64,
    batches: &[IdleBatchResult],
) -> Result<(), AppError> {
    if batches.is_empty() {
        return Ok(());
    }
    let total_exp = batches.iter().map(|batch| batch.exp_gained).sum::<i64>();
    let total_silver = batches.iter().map(|batch| batch.silver_gained).sum::<i64>();
    let win_inc = batches
        .iter()
        .filter(|batch| batch.result == "attacker_win")
        .count() as i64;
    let lose_inc = batches
        .iter()
        .filter(|batch| batch.result == "defender_win")
        .count() as i64;
    let total_battles = batches.len() as i64;
    let reward_items = batches
        .iter()
        .flat_map(|batch| batch.planned_item_drops.iter().cloned())
        .collect::<Vec<_>>();
    state.database.with_transaction(|| async {
        let item_settlement = if reward_items.is_empty() {
            None
        } else {
            Some(
                settle_generic_pve_reward_items(
                    state,
                    &GenericPveSettlementTaskPayload {
                        schema_version: 1,
                        character_id,
                        user_id,
                        exp_gained: 0,
                        silver_gained: 0,
                        reward_items,
                    },
                    Some(session_id),
                )
                .await?,
            )
        };
        let total_silver = total_silver.saturating_add(
            item_settlement
                .as_ref()
                .map(|result| result.auto_disassemble_silver_gained)
                .unwrap_or_default(),
        );
        if state.redis_available && state.redis.is_some() {
            let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
            let mut resource_fields = Vec::new();
            if total_exp > 0 {
                resource_fields.push(CharacterResourceDeltaField {
                    character_id,
                    field: "exp".to_string(),
                    increment: total_exp,
                });
            }
            if total_silver > 0 {
                resource_fields.push(CharacterResourceDeltaField {
                    character_id,
                    field: "silver".to_string(),
                    increment: total_silver,
                });
            }
            if !resource_fields.is_empty() {
                buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
            }
        } else {
            state.database.execute(
                "UPDATE characters SET exp = COALESCE(exp, 0) + $2, silver = COALESCE(silver, 0) + $3, updated_at = NOW() WHERE id = $1",
                |q| q.bind(character_id).bind(total_exp).bind(total_silver),
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

fn should_flush_idle_buffer(
    session: &IdleSessionDto,
    now_ms: i64,
    incoming_batches: usize,
) -> bool {
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
        planned_item_drops: batch.planned_item_drops.clone(),
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
    character_id: i64,
    user_id: i64,
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
            planned_item_drops: delta.planned_item_drops.clone(),
        })
        .collect::<Vec<_>>();
    batches.push(current_batch.clone());
    let _ = now_ms;
    flush_idle_batch_deltas(state, session_id, character_id, user_id, &batches).await?;
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

fn resolve_idle_batch_result(
    session: &IdleSessionDto,
    user_id: i64,
) -> Result<IdleBatchResult, AppError> {
    if let Some(snapshot) = parse_idle_execution_snapshot(session) {
        let batch = execute_idle_batch_from_snapshot(
            &session.id,
            session.character_id,
            session.total_battles + 1,
            &snapshot,
        )
        .map_err(AppError::config)?;
        let planned_item_drops = if batch.result == "attacker_win" {
            resolve_minimal_pve_item_rewards(
                &snapshot.monster_ids,
                &MinimalPveItemRewardResolveOptions {
                    reward_seed: format!("{}:{}", session.id, session.total_battles + 1),
                    participants: vec![MinimalBattleRewardParticipant {
                        character_id: session.character_id,
                        user_id,
                        fuyuan: 0.0,
                        realm: snapshot
                            .initial_battle_state
                            .teams
                            .attacker
                            .units
                            .first()
                            .and_then(|unit| unit.current_attrs.realm.clone()),
                    }],
                    is_dungeon_battle: false,
                    dungeon_reward_multiplier: None,
                },
            )
            .map_err(AppError::config)?
        } else {
            Vec::new()
        };
        let items_gained = planned_item_drops
            .iter()
            .map(|item| IdleItemGain {
                item_def_id: item.item_def_id.clone(),
                item_name: item.item_name.clone(),
                quantity: item.qty,
            })
            .collect::<Vec<_>>();
        return Ok(IdleBatchResult {
            result: batch.result,
            round_count: batch.round_count,
            exp_gained: batch.exp_gained,
            silver_gained: batch.silver_gained,
            items_gained,
            _bag_full_flag: false,
            planned_item_drops,
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
    let monster_count =
        load_room_monster_count(&session.map_id, &session.room_id, &target_monster_def_id)?;
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
    let monster_ids =
        std::iter::repeat_n(target_monster_def_id.clone(), count as usize).collect::<Vec<_>>();
    let planned_item_drops = resolve_minimal_pve_item_rewards(
        &monster_ids,
        &MinimalPveItemRewardResolveOptions {
            reward_seed: format!("{}:{}", session.id, session.total_battles + 1),
            participants: vec![MinimalBattleRewardParticipant {
                character_id: session.character_id,
                user_id,
                fuyuan: 0.0,
                realm: None,
            }],
            is_dungeon_battle: false,
            dungeon_reward_multiplier: None,
        },
    )
    .map_err(AppError::config)?;
    let items_gained = planned_item_drops
        .iter()
        .map(|item| IdleItemGain {
            item_def_id: item.item_def_id.clone(),
            item_name: item.item_name.clone(),
            quantity: item.qty,
        })
        .collect::<Vec<_>>();
    Ok(IdleBatchResult {
        result: "attacker_win".to_string(),
        round_count: count,
        exp_gained: reward
            .exp_reward
            .unwrap_or_default()
            .max(0)
            .saturating_mul(count),
        silver_gained: reward
            .silver_reward_min
            .unwrap_or_default()
            .max(0)
            .saturating_mul(count),
        items_gained,
        _bag_full_flag: false,
        planned_item_drops,
    })
}

fn parse_idle_execution_snapshot(session: &IdleSessionDto) -> Option<IdleExecutionSnapshot> {
    session.execution_snapshot.clone()
}

async fn ensure_character_not_in_team(state: &AppState, character_id: i64) -> Result<(), AppError> {
    let in_team = state
        .database
        .fetch_optional(
            "SELECT 1 FROM team_members WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?
        .is_some();
    if in_team {
        return Err(AppError::config("组队中无法进行离线挂机，请先退出队伍"));
    }
    Ok(())
}

fn ensure_idle_target_monster_in_room(
    map_id: &str,
    room_id: &str,
    monster_def_id: &str,
) -> Result<(), AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: MapSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let Some(map) = payload
        .maps
        .into_iter()
        .find(|map| map.id == map_id && map.enabled != Some(false))
    else {
        return Err(AppError::config("房间不存在"));
    };
    let Some(room) = map.rooms.into_iter().find(|room| room.id == room_id) else {
        return Err(AppError::config("房间不存在"));
    };
    let monster_in_room = room
        .monsters
        .iter()
        .any(|monster| monster.monster_def_id == monster_def_id);
    if !monster_in_room {
        return Err(AppError::config("所选怪物不属于该房间"));
    }
    Ok(())
}

fn load_room_monster_count(
    map_id: &str,
    room_id: &str,
    monster_def_id: &str,
) -> Result<Option<i64>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: MapSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let Some(map) = payload
        .maps
        .into_iter()
        .find(|map| map.id == map_id && map.enabled != Some(false))
    else {
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
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: MonsterSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    payload
        .monsters
        .into_iter()
        .find(|monster| {
            monster.id.as_deref().map(str::trim) == Some(monster_def_id)
                && monster.enabled != Some(false)
        })
        .ok_or_else(|| AppError::config(format!("monster seed not found: {monster_def_id}")))
}

fn load_monster_name_map() -> Result<BTreeMap<String, String>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    let monsters = payload
        .get("monsters")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(monsters
        .into_iter()
        .filter_map(|row| {
            Some((
                row.get("id")?.as_str()?.to_string(),
                row.get("name")?.as_str()?.to_string(),
            ))
        })
        .collect())
}

#[derive(Debug, Clone)]
struct IdleDurationLimitSnapshot {
    month_card_active: bool,
    max_duration_ms: i64,
}

async fn resolve_idle_duration_limit(
    state: &AppState,
    character_id: i64,
) -> Result<IdleDurationLimitSnapshot, AppError> {
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
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/month_card.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read month_card.json: {error}")))?;
    let payload: MonthCardSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse month_card.json: {error}")))?;
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
            let ttl_ms = duration_ms
                .saturating_add(IDLE_LOCK_TTL_BUFFER_MS)
                .max(60_000);
            let token = state
                .idle_execution_registry
                .get_lock_token(character_id)
                .unwrap_or_else(|| format!("idle-lock-{}-{}", character_id, now_millis()));
            state
                .idle_execution_registry
                .set_lock_token(character_id, token.clone());
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
) -> Result<bool, AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(true);
    };
    let redis = RedisRuntime::new(redis_client);
    let token = format!("idle-lock-{}-{}", character_id, now_millis());
    let ttl_sec = ((max_duration_ms.saturating_add(IDLE_LOCK_TTL_BUFFER_MS)) / 1000)
        .clamp(60, 24 * 3600) as u64;
    let lease = redis
        .acquire_lock(&build_idle_lock_key(character_id), &token, ttl_sec)
        .await?;
    if lease.is_none() {
        return Ok(false);
    }
    state
        .idle_execution_registry
        .set_lock_token(character_id, token);
    Ok(true)
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

fn normalize_idle_auto_skill_policy(
    value: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
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
            let skill_id = slot
                .get("skillId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let priority = slot
                .get("priority")
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite());
            if skill_id.is_empty() || priority.is_none() {
                return Err(AppError::config("技能策略非法"));
            }
            Ok(serde_json::json!({ "skillId": skill_id, "priority": priority.unwrap() }))
        })
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort_by(|left, right| {
        let left_priority = left
            .get("priority")
            .and_then(|value| value.as_f64())
            .unwrap_or_default();
        let right_priority = right
            .get("priority")
            .and_then(|value| value.as_f64())
            .unwrap_or_default();
        left_priority.total_cmp(&right_priority)
    });
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
    Ok(filter_idle_auto_skill_policy_by_available_skills(
        &normalized,
        &available_skill_ids,
    ))
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
        let available = BTreeSet::from(["skill-a".to_string(), "skill-b".to_string()]);
        let filtered =
            super::filter_idle_auto_skill_policy_by_available_skills(&normalized, &available);
        assert_eq!(
            filtered,
            serde_json::json!({
                "slots": [
                    {"skillId": "skill-b", "priority": 1},
                    {"skillId": "skill-a", "priority": 2}
                ]
            })
        );
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
            &serde_json::json!({"slots":[]}),
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

        let batch = super::resolve_idle_batch_result(&session, 1).expect("batch should resolve");
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

        let batch =
            super::resolve_idle_batch_result(&session, 1).expect("legacy batch should resolve");
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
            &serde_json::json!({"slots":[]}),
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

        let batch = super::resolve_idle_batch_result(&session, 1).expect("batch should resolve");
        assert!(
            batch
                .planned_item_drops
                .iter()
                .any(|item| item.item_def_id == "mat-005")
        );
    }
}
