pub mod arena_weekly_settlement;
pub mod battle_expired_cleanup;
pub mod dungeon_cleanup;
pub mod idle_history_cleanup;
pub mod mail_history_cleanup;
pub mod online_battle_settlement;
pub mod partner_recruit_draft_cleanup;
pub mod rank_snapshot;
pub mod technique_draft_cleanup;
pub mod tower_frozen_pool;

use std::collections::{BTreeMap, BTreeSet};

use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::battle_runtime::build_minimal_pve_battle_state;
use crate::http::afdian;
use crate::http::character_technique;
use crate::http::dungeon::load_dungeon_wave_monster_ids;
use crate::http::idle;
use crate::http::inventory::{InventoryDefSeed, load_inventory_def_map};
use crate::http::partner;
use crate::http::tower::resolve_tower_floor_monster_ids;
use crate::http::wander;
use crate::integrations::battle_character_profile::hydrate_pve_battle_state_owner;
use crate::integrations::battle_persistence::{
    persist_battle_projection, persist_battle_session, persist_battle_snapshot,
    recover_battle_bundle,
};
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    DecodedCharacterItemGrantDelta, flush_character_item_grant_deltas,
};
use crate::integrations::redis_item_instance_mutation::{
    BufferedItemInstanceMutation, flush_item_instance_mutations,
};
use crate::integrations::redis_progress_delta::flush_character_progress_deltas;
use crate::integrations::redis_resource_delta::flush_character_resource_deltas;
use crate::realtime::battle::{build_battle_cooldown_ready_payload, build_battle_started_payload};
use crate::realtime::public_socket::emit_wander_update_to_user;
use crate::realtime::public_socket::{
    emit_battle_cooldown_to_participants, emit_battle_update_to_participants,
};
use crate::realtime::wander::build_wander_update_payload;
use crate::shared::error::AppError;
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

const IDLE_HEARTBEAT_TICK_SECONDS: u64 = 10;
const AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS: u64 = 60;
const AFDIAN_MESSAGE_RETRY_BATCH_SIZE: i64 = 10;
const PROGRESS_DELTA_FLUSH_INTERVAL_SECONDS: u64 = 5;
const ITEM_GRANT_DELTA_FLUSH_INTERVAL_SECONDS: u64 = 5;
const RESOURCE_DELTA_FLUSH_INTERVAL_SECONDS: u64 = 5;
const ITEM_INSTANCE_MUTATION_FLUSH_INTERVAL_SECONDS: u64 = 5;

#[derive(Debug, Clone, Default)]
pub struct JobRuntime;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobInitializationSummary {
    pub idle_session_count: usize,
    pub recovered_tower_battle_count: usize,
    pub recovered_dungeon_battle_count: usize,
    pub afdian_delivery_count: usize,
    pub arena_weekly_settlement_week_count: usize,
    pub rank_snapshot_character_count: usize,
    pub rank_snapshot_partner_count: usize,
    pub partner_recruit_job_count: usize,
    pub partner_fusion_job_count: usize,
    pub partner_rebone_job_count: usize,
    pub technique_generation_job_count: usize,
    pub wander_generation_job_count: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JobShutdownFlushSummary {
    pub progress_character_count: usize,
    pub item_grant_character_count: usize,
    pub item_instance_mutation_character_count: usize,
    pub resource_character_count: usize,
}

impl JobRuntime {
    pub fn new() -> Self {
        Self
    }

    pub async fn initialize(&self, state: AppState) -> anyhow::Result<JobInitializationSummary> {
        tracing::info!("job runtime initialized");
        let idle_session_count = recover_idle_sessions(state.clone()).await?;
        spawn_idle_reconcile_loop(state.clone());
        let battle_recovery = recover_active_battles(state.clone()).await?;
        let afdian_retry_enabled = load_afdian_message_retry_enabled();
        let afdian_delivery_count = if afdian_retry_enabled {
            recover_pending_afdian_message_deliveries(state.clone()).await?
        } else {
            0
        };
        if afdian_retry_enabled {
            spawn_afdian_message_retry_loop(state.clone());
        }
        let arena_weekly_settlement_summary =
            arena_weekly_settlement::run_arena_weekly_settlement_once(&state).await?;
        arena_weekly_settlement::spawn_arena_weekly_settlement_loop(state.clone());
        let rank_snapshot_summary = match rank_snapshot::refresh_all_rank_snapshots_once(&state)
            .await
        {
            Ok(summary) => summary,
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    "rank snapshot refresh failed during startup; continuing without blocking server boot"
                );
                rank_snapshot::RankSnapshotRefreshSummary::default()
            }
        };
        battle_expired_cleanup::spawn_battle_expired_cleanup_loop(state.clone());
        rank_snapshot::spawn_rank_snapshot_nightly_refresh_loop(state.clone());
        idle_history_cleanup::spawn_idle_history_cleanup_loop(state.clone());
        mail_history_cleanup::spawn_mail_history_cleanup_loop(state.clone());
        partner_recruit_draft_cleanup::spawn_partner_recruit_draft_cleanup_loop(state.clone());
        technique_draft_cleanup::spawn_technique_draft_cleanup_loop(state.clone());
        let partner_recovery = recover_pending_partner_jobs(state.clone()).await?;
        let technique_generation_job_count =
            recover_pending_technique_generation_jobs(state.clone()).await?;
        let wander_generation_job_count = recover_pending_wander_jobs(state.clone()).await?;
        dungeon_cleanup::spawn_dungeon_expired_instance_cleanup_loop(state.clone());
        online_battle_settlement::recover_pending_online_battle_settlement_tasks(state.clone())
            .await?;
        online_battle_settlement::spawn_online_battle_settlement_loop(state.clone());
        spawn_progress_delta_flush_loop(state.clone());
        spawn_item_grant_delta_flush_loop(state.clone());
        spawn_item_instance_mutation_flush_loop(state.clone());
        spawn_resource_delta_flush_loop(state.clone());
        Ok(JobInitializationSummary {
            idle_session_count,
            recovered_tower_battle_count: battle_recovery.recovered_tower_battle_count,
            recovered_dungeon_battle_count: battle_recovery.recovered_dungeon_battle_count,
            afdian_delivery_count,
            arena_weekly_settlement_week_count: arena_weekly_settlement_summary.settled_week_count,
            rank_snapshot_character_count: rank_snapshot_summary.character_snapshot_count,
            rank_snapshot_partner_count: rank_snapshot_summary.partner_snapshot_count,
            partner_recruit_job_count: partner_recovery.recruit_count,
            partner_fusion_job_count: partner_recovery.fusion_count,
            partner_rebone_job_count: partner_recovery.rebone_count,
            technique_generation_job_count,
            wander_generation_job_count,
        })
    }

    pub async fn shutdown(&self) {
        tracing::info!("job runtime stopped");
    }
}

pub async fn flush_pending_runtime_deltas(
    state: &AppState,
) -> Result<JobShutdownFlushSummary, AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(JobShutdownFlushSummary::default());
    };

    let redis = RedisRuntime::new(redis_client);
    let mut summary = JobShutdownFlushSummary::default();

    loop {
        let flushed = flush_character_progress_deltas(&redis, 100, |character_id, deltas| {
            let state = state.clone();
            async move { apply_character_progress_delta_batch(&state, character_id, deltas).await }
        })
        .await?;
        if flushed.is_empty() {
            break;
        }
        summary.progress_character_count += flushed.len();
    }

    loop {
        let flushed = flush_character_item_grant_deltas(&redis, 100, |character_id, grants| {
            let state = state.clone();
            async move { apply_character_item_grant_delta_batch(&state, character_id, grants).await }
        })
        .await?;
        if flushed.is_empty() {
            break;
        }
        summary.item_grant_character_count += flushed.len();
    }

    loop {
        let flushed = flush_item_instance_mutations(&redis, 100, |character_id, mutations| {
            let state = state.clone();
            async move { apply_item_instance_mutation_batch(&state, character_id, mutations).await }
        })
        .await?;
        if flushed.is_empty() {
            break;
        }
        summary.item_instance_mutation_character_count += flushed.len();
    }

    loop {
        let flushed = flush_character_resource_deltas(&redis, 100, |character_id, deltas| {
            let state = state.clone();
            async move { apply_character_resource_delta_batch(&state, character_id, deltas).await }
        })
        .await?;
        if flushed.is_empty() {
            break;
        }
        summary.resource_character_count += flushed.len();
    }

    Ok(summary)
}

pub async fn enqueue_wander_generation_job(
    state: AppState,
    character_id: i64,
    generation_id: String,
) -> Result<(), AppError> {
    tokio::spawn(async move {
        match wander::process_pending_generation_job(&state, character_id, &generation_id).await {
            Ok(result) => {
                if let Ok(Some(user_id)) = load_character_user_id(&state, character_id).await {
                    if let Ok(overview) =
                        wander::load_wander_overview_data(&state, character_id).await
                    {
                        emit_wander_update_to_user(
                            &state,
                            user_id,
                            &build_wander_update_payload(overview),
                        );
                    }
                }
                tracing::info!(
                    character_id,
                    generation_id = %generation_id,
                    success = result.success,
                    message = ?result.message,
                    "wander pending generation job processed"
                );
            }
            Err(error) => {
                tracing::error!(
                    character_id,
                    generation_id = %generation_id,
                    error = %error,
                    "wander pending generation job failed unexpectedly"
                );
            }
        }
    });
    Ok(())
}

async fn load_character_user_id(
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
    Ok(row.and_then(|row| opt_i64_from_i32(&row, "user_id").ok().flatten()))
}

pub async fn enqueue_partner_recruit_job(
    state: AppState,
    character_id: i64,
    generation_id: String,
) -> Result<(), AppError> {
    if state.config.service.node_env == "test" {
        partner::process_pending_partner_recruit_job(&state, character_id, &generation_id).await?;
        return Ok(());
    }
    tokio::spawn(async move {
        let _ = partner::process_pending_partner_recruit_job(&state, character_id, &generation_id)
            .await;
    });
    Ok(())
}

pub async fn enqueue_technique_generation_job(
    state: AppState,
    character_id: i64,
    generation_id: String,
) -> Result<(), AppError> {
    if state.config.service.node_env == "test" {
        character_technique::process_pending_technique_generation_job(
            &state,
            character_id,
            &generation_id,
        )
        .await?;
        return Ok(());
    }
    tokio::spawn(async move {
        let _ = character_technique::process_pending_technique_generation_job(
            &state,
            character_id,
            &generation_id,
        )
        .await;
    });
    Ok(())
}

pub async fn enqueue_partner_fusion_job(
    state: AppState,
    character_id: i64,
    fusion_id: String,
) -> Result<(), AppError> {
    if state.config.service.node_env == "test" {
        partner::process_pending_partner_fusion_job(&state, character_id, &fusion_id).await?;
        return Ok(());
    }
    tokio::spawn(async move {
        let _ = partner::process_pending_partner_fusion_job(&state, character_id, &fusion_id).await;
    });
    Ok(())
}

pub async fn enqueue_partner_rebone_job(
    state: AppState,
    character_id: i64,
    rebone_id: String,
) -> Result<(), AppError> {
    if state.config.service.node_env == "test" {
        partner::process_pending_partner_rebone_job(&state, character_id, &rebone_id).await?;
        return Ok(());
    }
    tokio::spawn(async move {
        let _ = partner::process_pending_partner_rebone_job(&state, character_id, &rebone_id).await;
    });
    Ok(())
}

pub async fn enqueue_afdian_message_delivery(
    state: AppState,
    order_id: i64,
) -> Result<(), AppError> {
    tokio::spawn(async move {
        let _ = afdian::process_pending_afdian_message_delivery(&state, order_id).await;
    });
    Ok(())
}

async fn recover_pending_wander_jobs(state: AppState) -> anyhow::Result<usize> {
    let rows = state.database.fetch_all(
        "SELECT id, character_id FROM character_wander_generation_job WHERE status = 'pending' ORDER BY created_at ASC",
        |query| query,
    ).await?;

    let mut recovered = 0_usize;
    for row in rows {
        let generation_id = row.try_get::<Option<String>, _>("id")?.unwrap_or_default();
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if generation_id.is_empty() || character_id <= 0 {
            continue;
        }
        enqueue_wander_generation_job(state.clone(), character_id, generation_id).await?;
        recovered += 1;
    }

    Ok(recovered)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PendingPartnerJobRecoverySummary {
    recruit_count: usize,
    fusion_count: usize,
    rebone_count: usize,
}

async fn recover_pending_partner_jobs(
    state: AppState,
) -> anyhow::Result<PendingPartnerJobRecoverySummary> {
    let recruit_rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id FROM partner_recruit_job WHERE status = 'pending' ORDER BY created_at ASC",
        |q| q,
    ).await?;
    let mut summary = PendingPartnerJobRecoverySummary::default();
    for row in recruit_rows {
        let id = row
            .try_get::<Option<String>, _>("id_text")?
            .unwrap_or_default();
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if !id.is_empty() && character_id > 0 {
            enqueue_partner_recruit_job(state.clone(), character_id, id).await?;
            summary.recruit_count += 1;
        }
    }
    let fusion_rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id FROM partner_fusion_job WHERE status = 'pending' ORDER BY created_at ASC",
        |q| q,
    ).await?;
    for row in fusion_rows {
        let id = row
            .try_get::<Option<String>, _>("id_text")?
            .unwrap_or_default();
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if !id.is_empty() && character_id > 0 {
            enqueue_partner_fusion_job(state.clone(), character_id, id).await?;
            summary.fusion_count += 1;
        }
    }
    let rebone_rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id FROM partner_rebone_job WHERE status = 'pending' ORDER BY created_at ASC",
        |q| q,
    ).await?;
    for row in rebone_rows {
        let id = row
            .try_get::<Option<String>, _>("id_text")?
            .unwrap_or_default();
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if !id.is_empty() && character_id > 0 {
            enqueue_partner_rebone_job(state.clone(), character_id, id).await?;
            summary.rebone_count += 1;
        }
    }
    Ok(summary)
}

async fn recover_pending_technique_generation_jobs(state: AppState) -> anyhow::Result<usize> {
    let rows = state.database.fetch_all(
        "SELECT id::text AS id_text, character_id FROM technique_generation_job WHERE status = 'pending' ORDER BY created_at ASC",
        |q| q,
    ).await?;
    let mut recovered = 0_usize;
    for row in rows {
        let id = row
            .try_get::<Option<String>, _>("id_text")?
            .unwrap_or_default();
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if !id.is_empty() && character_id > 0 {
            enqueue_technique_generation_job(state.clone(), character_id, id).await?;
            recovered += 1;
        }
    }
    Ok(recovered)
}

pub(crate) async fn recover_pending_afdian_message_deliveries(
    state: AppState,
) -> anyhow::Result<usize> {
    let batch_size = load_afdian_message_retry_batch_size();
    let recovered = afdian::run_due_afdian_message_retries_once(&state, batch_size).await?;
    Ok(recovered)
}

fn spawn_afdian_message_retry_loop(state: AppState) {
    let interval_seconds = load_afdian_message_retry_interval_seconds();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(interval_seconds)).await;
            match recover_pending_afdian_message_deliveries(state.clone()).await {
                Ok(recovered) => {
                    if recovered > 0 {
                        tracing::info!(
                            recovered,
                            "afdian message retry loop dispatched due deliveries"
                        );
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "afdian message retry loop iteration failed");
                }
            }
        }
    });
}

fn load_afdian_message_retry_enabled() -> bool {
    std::env::var("AFDIAN_MESSAGE_RETRY_ENABLED")
        .ok()
        .map(|raw| raw.trim().to_ascii_lowercase())
        .map(|raw| match raw.as_str() {
            "true" => true,
            "false" => false,
            _ => true,
        })
        .unwrap_or(true)
}

fn load_afdian_message_retry_interval_seconds() -> u64 {
    std::env::var("AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|value| value.clamp(10, 3600))
        .unwrap_or(AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS)
}

fn load_afdian_message_retry_batch_size() -> i64 {
    std::env::var("AFDIAN_MESSAGE_RETRY_BATCH_SIZE")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map(|value| value.clamp(1, 50))
        .unwrap_or(AFDIAN_MESSAGE_RETRY_BATCH_SIZE)
}

fn spawn_progress_delta_flush_loop(state: AppState) {
    let Some(redis_client) = state.redis.clone() else {
        return;
    };
    tokio::spawn(async move {
        let redis = RedisRuntime::new(redis_client);
        loop {
            sleep(Duration::from_secs(PROGRESS_DELTA_FLUSH_INTERVAL_SECONDS)).await;
            match flush_character_progress_deltas(&redis, 100, |character_id, deltas| {
                let state = state.clone();
                async move { apply_character_progress_delta_batch(&state, character_id, deltas).await }
            }).await {
                Ok(flushed_character_ids) => {
                    if !flushed_character_ids.is_empty() {
                        tracing::info!(count = flushed_character_ids.len(), "progress delta flush loop applied claimed deltas");
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "progress delta flush loop iteration failed");
                }
            }
        }
    });
}

fn spawn_item_grant_delta_flush_loop(state: AppState) {
    let Some(redis_client) = state.redis.clone() else {
        return;
    };
    tokio::spawn(async move {
        let redis = RedisRuntime::new(redis_client);
        loop {
            sleep(Duration::from_secs(ITEM_GRANT_DELTA_FLUSH_INTERVAL_SECONDS)).await;
            match flush_character_item_grant_deltas(&redis, 100, |character_id, grants| {
                let state = state.clone();
                async move { apply_character_item_grant_delta_batch(&state, character_id, grants).await }
            }).await {
                Ok(flushed_character_ids) => {
                    if !flushed_character_ids.is_empty() {
                        tracing::info!(count = flushed_character_ids.len(), "item grant delta flush loop applied claimed deltas");
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "item grant delta flush loop iteration failed");
                }
            }
        }
    });
}

fn spawn_item_instance_mutation_flush_loop(state: AppState) {
    let Some(redis_client) = state.redis.clone() else {
        return;
    };
    tokio::spawn(async move {
        let redis = RedisRuntime::new(redis_client);
        loop {
            sleep(Duration::from_secs(
                ITEM_INSTANCE_MUTATION_FLUSH_INTERVAL_SECONDS,
            ))
            .await;
            match flush_item_instance_mutations(&redis, 100, |character_id, mutations| {
                let state = state.clone();
                async move { apply_item_instance_mutation_batch(&state, character_id, mutations).await }
            }).await {
                Ok(flushed_character_ids) => {
                    if !flushed_character_ids.is_empty() {
                        tracing::info!(count = flushed_character_ids.len(), "item instance mutation flush loop applied claimed deltas");
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "item instance mutation flush loop iteration failed");
                }
            }
        }
    });
}

fn spawn_resource_delta_flush_loop(state: AppState) {
    let Some(redis_client) = state.redis.clone() else {
        return;
    };
    tokio::spawn(async move {
        let redis = RedisRuntime::new(redis_client);
        loop {
            sleep(Duration::from_secs(RESOURCE_DELTA_FLUSH_INTERVAL_SECONDS)).await;
            match flush_character_resource_deltas(&redis, 100, |character_id, deltas| {
                let state = state.clone();
                async move { apply_character_resource_delta_batch(&state, character_id, deltas).await }
            }).await {
                Ok(flushed_character_ids) => {
                    if !flushed_character_ids.is_empty() {
                        tracing::info!(count = flushed_character_ids.len(), "resource delta flush loop applied claimed deltas");
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "resource delta flush loop iteration failed");
                }
            }
        }
    });
}

async fn apply_character_progress_delta_batch(
    state: &AppState,
    character_id: i64,
    deltas: std::collections::HashMap<String, i64>,
) -> Result<(), AppError> {
    if character_id <= 0 || deltas.is_empty() {
        return Ok(());
    }
    let (
        total_points,
        combat_points,
        cultivation_points,
        exploration_points,
        social_points,
        collection_points,
    ) = extract_achievement_point_delta_tuple(&deltas);
    if total_points > 0
        || combat_points > 0
        || cultivation_points > 0
        || exploration_points > 0
        || social_points > 0
        || collection_points > 0
    {
        state.database.execute(
            "INSERT INTO character_achievement_points (character_id, total_points, combat_points, cultivation_points, exploration_points, social_points, collection_points, claimed_thresholds, updated_at) VALUES ($1, 0, 0, 0, 0, 0, 0, '[]'::jsonb, NOW()) ON CONFLICT (character_id) DO NOTHING",
            |query| query.bind(character_id),
        ).await?;
        state.database.execute(
            "UPDATE character_achievement_points SET total_points = total_points + $2, combat_points = combat_points + $3, cultivation_points = cultivation_points + $4, exploration_points = exploration_points + $5, social_points = social_points + $6, collection_points = collection_points + $7, updated_at = NOW() WHERE character_id = $1",
            |query| query
                .bind(character_id)
                .bind(total_points)
                .bind(combat_points)
                .bind(cultivation_points)
                .bind(exploration_points)
                .bind(social_points)
                .bind(collection_points),
        ).await?;
    }
    crate::http::task::apply_task_progress_delta_fields(state, character_id, &deltas).await?;
    Ok(())
}

async fn apply_character_item_grant_delta_batch(
    state: &AppState,
    character_id: i64,
    grants: Vec<DecodedCharacterItemGrantDelta>,
) -> Result<(), AppError> {
    if character_id <= 0 || grants.is_empty() {
        return Ok(());
    }
    let defs = load_inventory_def_map()?;
    state
        .database
        .with_transaction(|| async {
            for grant in grants {
                if grant.user_id <= 0
                    || grant.qty <= 0
                    || grant.item_def_id.trim().is_empty()
                    || grant.obtained_from.trim().is_empty()
                {
                    continue;
                }
                apply_single_item_grant_delta_tx(state, character_id, &defs, &grant).await?;
            }
            Ok::<(), AppError>(())
        })
        .await
}

#[derive(Debug, Clone)]
struct GrantBagItemRow {
    location_slot: Option<i64>,
}

async fn apply_single_item_grant_delta_tx(
    state: &AppState,
    character_id: i64,
    defs: &BTreeMap<String, InventoryDefSeed>,
    grant: &DecodedCharacterItemGrantDelta,
) -> Result<(), AppError> {
    let item_def_id = grant.item_def_id.trim();
    let bind_type = normalize_grant_bind_type(&grant.bind_type);
    let stack_max = defs
        .get(item_def_id)
        .and_then(|seed| seed.row.get("stack_max"))
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
        .max(1);
    let bag_capacity = state
        .database
        .fetch_optional(
            "SELECT bag_capacity FROM inventory WHERE character_id = $1 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?
        .and_then(|row| opt_i64_from_i32(&row, "bag_capacity").ok().flatten())
        .unwrap_or(100)
        .max(1);
    let mut bag_rows = load_grant_bag_rows_tx(state, character_id).await?;
    let mut remaining = grant.qty.max(0);
    while remaining > 0 {
        let chunk_qty = remaining.min(stack_max);
        if let Some(slot) = find_first_grant_bag_slot(&bag_rows, bag_capacity) {
            state.database.execute(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, location, location_slot, metadata, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'bag', $8, $9::jsonb, NOW(), NOW(), $10, $11)",
                |query| query
                    .bind(grant.user_id)
                    .bind(character_id)
                    .bind(item_def_id)
                    .bind(chunk_qty)
                    .bind(grant.quality.as_deref())
                    .bind(grant.quality_rank)
                    .bind(bind_type.as_str())
                    .bind(slot)
                    .bind(grant.metadata.as_ref())
                    .bind(grant.obtained_from.as_str())
                    .bind(grant.obtained_ref_id.as_deref()),
            ).await?;
            bag_rows.push(GrantBagItemRow {
                location_slot: Some(slot),
            });
        } else {
            insert_item_grant_mail_attachment_tx(
                state,
                character_id,
                grant,
                item_def_id,
                bind_type.as_str(),
                remaining,
            )
            .await?;
            if let Some(idle_session_id) = grant.idle_session_id.as_deref() {
                mark_idle_session_bag_full_tx(state, idle_session_id).await?;
            }
            break;
        }
        remaining -= chunk_qty;
    }
    Ok(())
}

async fn load_grant_bag_rows_tx(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<GrantBagItemRow>, AppError> {
    state.database.fetch_all(
        "SELECT location_slot FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' FOR UPDATE",
        |query| query.bind(character_id),
    ).await?
    .into_iter()
    .map(|row| {
        Ok(GrantBagItemRow {
            location_slot: row.try_get::<Option<i32>, _>("location_slot")?.map(i64::from),
        })
    })
    .collect::<Result<Vec<_>, AppError>>()
}

fn find_first_grant_bag_slot(rows: &[GrantBagItemRow], capacity: i64) -> Option<i64> {
    (0..capacity).find(|slot| !rows.iter().any(|row| row.location_slot == Some(*slot)))
}

async fn insert_item_grant_mail_attachment_tx(
    state: &AppState,
    character_id: i64,
    grant: &DecodedCharacterItemGrantDelta,
    item_def_id: &str,
    bind_type: &str,
    qty: i64,
) -> Result<(), AppError> {
    let inserted = state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, location, metadata, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'mail', $8::jsonb, NOW(), NOW(), $9, $10) RETURNING id",
        |query| query
            .bind(grant.user_id)
            .bind(character_id)
            .bind(item_def_id)
            .bind(qty.max(1))
            .bind(grant.quality.as_deref())
            .bind(grant.quality_rank)
            .bind(bind_type)
            .bind(grant.metadata.as_ref())
            .bind(grant.obtained_from.as_str())
            .bind(grant.obtained_ref_id.as_deref()),
    ).await?;
    let item_id = inserted.try_get::<i64, _>("id")?;
    state.database.execute(
        "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_instance_ids, expire_at, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '奖励补发', '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。', $3::jsonb, NOW() + INTERVAL '30 days', 'character_item_grant_delta', $4, $5::jsonb, NOW(), NOW())",
        |query| query
            .bind(grant.user_id)
            .bind(character_id)
            .bind(serde_json::json!([item_id]))
            .bind(grant.obtained_ref_id.as_deref())
            .bind(serde_json::json!({
                "idleSessionId": grant.idle_session_id,
                "obtainedFrom": grant.obtained_from,
            })),
    ).await?;
    Ok(())
}

async fn mark_idle_session_bag_full_tx(
    state: &AppState,
    idle_session_id: &str,
) -> Result<(), AppError> {
    let normalized = idle_session_id.trim();
    if normalized.is_empty() {
        return Ok(());
    }
    state
        .database
        .execute(
            "UPDATE idle_sessions SET bag_full_flag = true, updated_at = NOW() WHERE id::text = $1",
            |query| query.bind(normalized),
        )
        .await?;
    Ok(())
}

fn normalize_grant_bind_type(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        "none".to_string()
    } else {
        value.to_string()
    }
}

async fn apply_character_resource_delta_batch(
    state: &AppState,
    character_id: i64,
    deltas: std::collections::HashMap<String, i64>,
) -> Result<(), AppError> {
    if character_id <= 0 || deltas.is_empty() {
        return Ok(());
    }
    let silver_delta = deltas.get("silver").copied().unwrap_or_default().max(0);
    let spirit_stones_delta = deltas
        .get("spirit_stones")
        .copied()
        .unwrap_or_default()
        .max(0);
    let exp_delta = deltas.get("exp").copied().unwrap_or_default().max(0);
    if silver_delta <= 0 && spirit_stones_delta <= 0 && exp_delta <= 0 {
        return Ok(());
    }
    state.database.execute(
        "UPDATE characters SET silver = COALESCE(silver, 0) + $2, spirit_stones = COALESCE(spirit_stones, 0) + $3, exp = COALESCE(exp, 0) + $4, updated_at = NOW() WHERE id = $1",
        |query| query.bind(character_id).bind(silver_delta).bind(spirit_stones_delta).bind(exp_delta),
    ).await?;
    Ok(())
}

async fn apply_item_instance_mutation_batch(
    state: &AppState,
    character_id: i64,
    mutations: Vec<BufferedItemInstanceMutation>,
) -> Result<(), AppError> {
    if character_id <= 0 || mutations.is_empty() {
        return Ok(());
    }
    let slot_release_ids = mutations
        .iter()
        .map(|mutation| mutation.item_id)
        .collect::<Vec<_>>();
    ensure_no_duplicate_item_instance_slot_targets(
        character_id,
        mutations
            .iter()
            .filter_map(|mutation| mutation.snapshot.as_ref()),
    )?;
    ensure_no_existing_item_instance_slot_conflicts(
        state,
        character_id,
        &slot_release_ids,
        mutations
            .iter()
            .filter_map(|mutation| mutation.snapshot.as_ref()),
    )
    .await?;
    release_item_instance_slots_for_update(state, character_id, &slot_release_ids).await?;

    for mutation in mutations {
        match mutation.kind.as_str() {
            "delete" => {
                state
                    .database
                    .execute(
                        "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
                        |query| query.bind(mutation.item_id).bind(character_id),
                    )
                    .await?;
            }
            _ => {
                let Some(snapshot) = mutation.snapshot else {
                    continue;
                };
                state.database.execute(
                    "UPDATE item_instance SET owner_user_id = $2, owner_character_id = $3, item_def_id = $4, qty = $5, quality = $6, quality_rank = $7, bind_type = $8, bind_owner_user_id = $9, bind_owner_character_id = $10, location = $11, location_slot = $12, equipped_slot = $13, strengthen_level = $14, refine_level = $15, socketed_gems = $16::jsonb, random_seed = $17, affixes = $18::jsonb, identified = $19, affix_gen_version = $20, affix_roll_meta = $21::jsonb, custom_name = $22, locked = $23, expire_at = $24::timestamptz, obtained_from = $25, obtained_ref_id = $26, metadata = $27::jsonb, updated_at = NOW() WHERE id = $1 AND owner_character_id = $28",
                    |query| query
                        .bind(snapshot.id)
                        .bind(snapshot.owner_user_id)
                        .bind(snapshot.owner_character_id)
                        .bind(snapshot.item_def_id.as_str())
                        .bind(snapshot.qty)
                        .bind(snapshot.quality.as_deref())
                        .bind(snapshot.quality_rank)
                        .bind(snapshot.bind_type.as_str())
                        .bind(snapshot.bind_owner_user_id)
                        .bind(snapshot.bind_owner_character_id)
                        .bind(snapshot.location.as_str())
                        .bind(snapshot.location_slot)
                        .bind(snapshot.equipped_slot.as_deref())
                        .bind(snapshot.strengthen_level)
                        .bind(snapshot.refine_level)
                        .bind(snapshot.socketed_gems)
                        .bind(snapshot.random_seed)
                        .bind(snapshot.affixes)
                        .bind(snapshot.identified)
                        .bind(snapshot.affix_gen_version)
                        .bind(snapshot.affix_roll_meta)
                        .bind(snapshot.custom_name.as_deref())
                        .bind(snapshot.locked)
                        .bind(snapshot.expire_at.as_deref())
                        .bind(snapshot.obtained_from.as_deref())
                        .bind(snapshot.obtained_ref_id.as_deref())
                        .bind(snapshot.metadata)
                        .bind(character_id),
                ).await?;
            }
        }
    }
    Ok(())
}

async fn release_item_instance_slots_for_update(
    state: &AppState,
    character_id: i64,
    item_ids: &[i64],
) -> Result<(), AppError> {
    if character_id <= 0 || item_ids.is_empty() {
        return Ok(());
    }
    state.database.execute(
        "UPDATE item_instance SET location_slot = NULL, updated_at = NOW() WHERE owner_character_id = $1 AND id = ANY($2) AND location IN ('bag', 'warehouse') AND location_slot IS NOT NULL",
        |query| query.bind(character_id).bind(item_ids),
    ).await?;
    Ok(())
}

fn ensure_no_duplicate_item_instance_slot_targets<'a>(
    character_id: i64,
    snapshots: impl Iterator<
        Item = &'a crate::integrations::redis_item_instance_mutation::ItemInstanceMutationSnapshot,
    >,
) -> Result<(), AppError> {
    let mut seen = BTreeSet::new();
    for snapshot in snapshots {
        if snapshot.owner_character_id != character_id {
            continue;
        }
        if !matches!(snapshot.location.as_str(), "bag" | "warehouse") {
            continue;
        }
        let Some(location_slot) = snapshot.location_slot else {
            continue;
        };
        let key = format!(
            "{}:{}:{}",
            snapshot.owner_character_id, snapshot.location, location_slot
        );
        if !seen.insert(key.clone()) {
            return Err(AppError::config(format!(
                "实例 mutation 目标槽位冲突: {key}"
            )));
        }
    }
    Ok(())
}

async fn ensure_no_existing_item_instance_slot_conflicts(
    state: &AppState,
    character_id: i64,
    batch_item_ids: &[i64],
    snapshots: impl Iterator<
        Item = &crate::integrations::redis_item_instance_mutation::ItemInstanceMutationSnapshot,
    >,
) -> Result<(), AppError> {
    if character_id <= 0 {
        return Ok(());
    }
    let occupied_rows = state.database.fetch_all(
        "SELECT id, location, location_slot FROM item_instance WHERE owner_character_id = $1 AND location IN ('bag', 'warehouse') AND location_slot IS NOT NULL",
        |query| query.bind(character_id),
    ).await?;
    let occupied_keys = occupied_rows
        .into_iter()
        .filter_map(|row| {
            let id = row.try_get::<i64, _>("id").ok()?;
            if batch_item_ids.contains(&id) {
                return None;
            }
            let location = row
                .try_get::<Option<String>, _>("location")
                .ok()
                .flatten()?;
            let location_slot = row
                .try_get::<Option<i32>, _>("location_slot")
                .ok()
                .flatten()?;
            Some((
                format!("{}:{}:{}", character_id, location, location_slot),
                id,
            ))
        })
        .collect::<BTreeMap<_, _>>();

    for snapshot in snapshots {
        if snapshot.owner_character_id != character_id {
            continue;
        }
        if !matches!(snapshot.location.as_str(), "bag" | "warehouse") {
            continue;
        }
        let Some(location_slot) = snapshot.location_slot else {
            continue;
        };
        let key = format!(
            "{}:{}:{}",
            snapshot.owner_character_id, snapshot.location, location_slot
        );
        if let Some(occupant_id) = occupied_keys.get(&key) {
            return Err(AppError::config(format!(
                "实例 mutation 目标槽位冲突: {key} 已被物品 {occupant_id} 占用"
            )));
        }
    }
    Ok(())
}

fn extract_achievement_point_delta_tuple(
    deltas: &std::collections::HashMap<String, i64>,
) -> (i64, i64, i64, i64, i64, i64) {
    (
        deltas
            .get("achievement_points:total")
            .copied()
            .unwrap_or_default()
            .max(0),
        deltas
            .get("achievement_points:combat_points")
            .copied()
            .unwrap_or_default()
            .max(0),
        deltas
            .get("achievement_points:cultivation_points")
            .copied()
            .unwrap_or_default()
            .max(0),
        deltas
            .get("achievement_points:exploration_points")
            .copied()
            .unwrap_or_default()
            .max(0),
        deltas
            .get("achievement_points:social_points")
            .copied()
            .unwrap_or_default()
            .max(0),
        deltas
            .get("achievement_points:collection_points")
            .copied()
            .unwrap_or_default()
            .max(0),
    )
}

async fn recover_idle_sessions(state: AppState) -> anyhow::Result<usize> {
    let rows = state.database.fetch_all(
        "SELECT DISTINCT character_id FROM idle_sessions WHERE status IN ('active', 'stopping') ORDER BY character_id ASC",
        |query| query,
    ).await?;

    let mut recovered = 0_usize;
    for row in rows {
        let character_id = opt_i64_from_i32(&row, "character_id")?.unwrap_or_default();
        if character_id <= 0 {
            continue;
        }
        idle::reconcile_idle_sessions_for_character(&state, character_id).await?;
        let session_row = state.database.fetch_optional(
            "SELECT s.id::text AS id_text, c.user_id FROM idle_sessions s JOIN characters c ON c.id = s.character_id WHERE s.character_id = $1 AND s.status IN ('active', 'stopping') ORDER BY s.started_at DESC LIMIT 1",
            |query| query.bind(character_id),
        ).await?;
        let Some(session_row) = session_row else {
            continue;
        };
        let session_id = session_row
            .try_get::<Option<String>, _>("id_text")?
            .unwrap_or_default();
        let user_id = opt_i64_from_i32(&session_row, "user_id")?.unwrap_or_default();
        if !session_id.is_empty() && user_id > 0 {
            let max_duration_row = state
                .database
                .fetch_optional(
                    "SELECT max_duration_ms FROM idle_sessions WHERE id::text = $1 LIMIT 1",
                    |query| query.bind(&session_id),
                )
                .await?;
            let max_duration_ms = max_duration_row
                .and_then(|row| {
                    row.try_get::<Option<i64>, _>("max_duration_ms")
                        .ok()
                        .flatten()
                })
                .unwrap_or_default();
            idle::spawn_idle_execution_loop(state.clone(), session_id, character_id, user_id);
            idle::sync_idle_lock_projection(&state, character_id, Some(max_duration_ms)).await?;
            recovered += 1;
        }
    }

    Ok(recovered)
}

fn spawn_idle_reconcile_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(15)).await;
            if let Err(error) = recover_idle_sessions(state.clone()).await {
                tracing::error!(error = %error, "idle reconcile loop iteration failed");
            }
        }
    });
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ActiveBattleRecoverySummary {
    recovered_tower_battle_count: usize,
    recovered_dungeon_battle_count: usize,
}

async fn recover_active_battles(state: AppState) -> anyhow::Result<ActiveBattleRecoverySummary> {
    let recovered_tower_battle_count = recover_tower_battles(state.clone()).await?;
    let recovered_dungeon_battle_count = recover_dungeon_battles(state).await?;
    Ok(ActiveBattleRecoverySummary {
        recovered_tower_battle_count,
        recovered_dungeon_battle_count,
    })
}

async fn recover_tower_battles(state: AppState) -> anyhow::Result<usize> {
    let rows = state.database.fetch_all(
        "SELECT c.user_id, c.id AS character_id, p.current_run_id, p.current_floor, p.current_battle_id FROM character_tower_progress p JOIN characters c ON c.id = p.character_id WHERE p.current_run_id IS NOT NULL AND p.current_floor IS NOT NULL AND p.current_battle_id IS NOT NULL",
        |q| q,
    ).await?;
    let mut recovered = 0_usize;
    for row in rows {
        let Some(user_id) = opt_i64_from_i32(&row, "user_id")? else {
            continue;
        };
        let Some(character_id) = opt_i64_from_i32(&row, "character_id")? else {
            continue;
        };
        let Some(run_id) = row.try_get::<Option<String>, _>("current_run_id")? else {
            continue;
        };
        let Some(floor) = opt_i64_from_i32(&row, "current_floor")? else {
            continue;
        };
        let Some(battle_id) = row.try_get::<Option<String>, _>("current_battle_id")? else {
            continue;
        };
        if recover_battle_bundle(&state, &battle_id).await? {
            if let Some(projection) = state.online_battle_projections.get_by_battle_id(&battle_id) {
                if let Some(session) = projection
                    .session_id
                    .as_deref()
                    .and_then(|session_id| state.battle_sessions.get_by_session_id(session_id))
                {
                    if let Some(battle_state) = state.battle_runtime.get(&battle_id) {
                        emit_recovered_battle_realtime(&state, &session, battle_state);
                    }
                }
            }
            recovered += 1;
            continue;
        }
        let session_id = format!("tower-session-{}", run_id);
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "tower".to_string(),
            owner_user_id: user_id,
            participant_user_ids: vec![user_id],
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Tower {
                run_id: run_id.clone(),
                floor,
            },
        };
        let mut battle_state = build_minimal_pve_battle_state(
            &battle_id,
            character_id,
            &resolve_tower_floor_monster_ids(floor),
        );
        hydrate_pve_battle_state_owner(&state, &mut battle_state, character_id).await?;
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        let projection = OnlineBattleProjectionRecord {
            battle_id,
            owner_user_id: user_id,
            participant_user_ids: vec![user_id],
            r#type: "pve".to_string(),
            session_id: Some(session_id),
        };
        state.online_battle_projections.register(projection.clone());
        persist_battle_session(&state, &session).await?;
        persist_battle_snapshot(&state, &battle_state).await?;
        persist_battle_projection(&state, &projection).await?;
        emit_recovered_battle_realtime(&state, &session, battle_state);
        recovered += 1;
    }
    Ok(recovered)
}

async fn recover_dungeon_battles(state: AppState) -> anyhow::Result<usize> {
    let rows = state.database.fetch_all(
        "SELECT id, dungeon_id, difficulty_id, participants, current_stage, current_wave, instance_data FROM dungeon_instance WHERE status = 'running' AND instance_data ->> 'currentBattleId' IS NOT NULL",
        |q| q,
    ).await?;
    let mut recovered = 0_usize;
    for row in rows {
        let instance_id = row.try_get::<String, _>("id")?;
        let participants = row
            .try_get::<Option<serde_json::Value>, _>("participants")?
            .and_then(|value| serde_json::from_value::<Vec<serde_json::Value>>(value).ok())
            .unwrap_or_default();
        let participant_user_ids = participants
            .iter()
            .filter_map(|entry| entry.get("userId").and_then(|v| v.as_i64()))
            .collect::<Vec<_>>();
        let owner_user_id = participant_user_ids.first().copied().unwrap_or_default();
        if owner_user_id <= 0 {
            continue;
        }
        let current_stage = opt_i64_from_i32(&row, "current_stage")?.unwrap_or(1);
        let current_wave = opt_i64_from_i32(&row, "current_wave")?.unwrap_or(1);
        let dungeon_id = row
            .try_get::<Option<String>, _>("dungeon_id")?
            .unwrap_or_default();
        let difficulty_id = row
            .try_get::<Option<String>, _>("difficulty_id")?
            .unwrap_or_default();
        let instance_data = row
            .try_get::<Option<serde_json::Value>, _>("instance_data")?
            .unwrap_or_else(|| serde_json::json!({}));
        let Some(battle_id) = instance_data
            .get("currentBattleId")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
        else {
            continue;
        };
        if recover_battle_bundle(&state, &battle_id).await? {
            if let Some(projection) = state.online_battle_projections.get_by_battle_id(&battle_id) {
                if let Some(session) = projection
                    .session_id
                    .as_deref()
                    .and_then(|session_id| state.battle_sessions.get_by_session_id(session_id))
                {
                    if let Some(battle_state) = state.battle_runtime.get(&battle_id) {
                        emit_recovered_battle_realtime(&state, &session, battle_state);
                    }
                }
            }
            recovered += 1;
            continue;
        }
        let Some(owner_character_id) = participants
            .iter()
            .find_map(|entry| entry.get("characterId").and_then(|v| v.as_i64()))
        else {
            continue;
        };
        let session_id = format!("dungeon-session-{}", instance_id);
        let session = BattleSessionSnapshotDto {
            session_id: session_id.clone(),
            session_type: "dungeon".to_string(),
            owner_user_id,
            participant_user_ids: participant_user_ids.clone(),
            current_battle_id: Some(battle_id.clone()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Dungeon {
                instance_id: instance_id.clone(),
            },
        };
        let monster_ids = load_dungeon_wave_monster_ids(
            &dungeon_id,
            &difficulty_id,
            current_stage,
            current_wave,
        )?;
        let mut battle_state =
            build_minimal_pve_battle_state(&battle_id, owner_character_id, &monster_ids);
        hydrate_pve_battle_state_owner(&state, &mut battle_state, owner_character_id).await?;
        state.battle_sessions.register(session.clone());
        state.battle_runtime.register(battle_state.clone());
        let projection = OnlineBattleProjectionRecord {
            battle_id,
            owner_user_id,
            participant_user_ids,
            r#type: "pve".to_string(),
            session_id: Some(session_id),
        };
        state.online_battle_projections.register(projection.clone());
        persist_battle_session(&state, &session).await?;
        persist_battle_snapshot(&state, &battle_state).await?;
        persist_battle_projection(&state, &projection).await?;
        emit_recovered_battle_realtime(&state, &session, battle_state);
        recovered += 1;
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::{
        ActiveBattleRecoverySummary, JobInitializationSummary, PendingPartnerJobRecoverySummary,
        extract_achievement_point_delta_tuple,
    };
    use std::collections::HashMap;

    #[test]
    fn job_initialization_summary_defaults_to_zero() {
        let summary = JobInitializationSummary::default();
        assert_eq!(summary.idle_session_count, 0);
        assert_eq!(summary.recovered_tower_battle_count, 0);
        assert_eq!(summary.recovered_dungeon_battle_count, 0);
        assert_eq!(summary.afdian_delivery_count, 0);
        assert_eq!(summary.arena_weekly_settlement_week_count, 0);
        assert_eq!(summary.rank_snapshot_character_count, 0);
        assert_eq!(summary.rank_snapshot_partner_count, 0);
        assert_eq!(summary.partner_recruit_job_count, 0);
        assert_eq!(summary.partner_fusion_job_count, 0);
        assert_eq!(summary.partner_rebone_job_count, 0);
        assert_eq!(summary.technique_generation_job_count, 0);
        assert_eq!(summary.wander_generation_job_count, 0);
    }

    #[test]
    fn nested_recovery_summaries_default_to_zero() {
        assert_eq!(
            PendingPartnerJobRecoverySummary::default(),
            PendingPartnerJobRecoverySummary {
                recruit_count: 0,
                fusion_count: 0,
                rebone_count: 0,
            }
        );
        assert_eq!(
            ActiveBattleRecoverySummary::default(),
            ActiveBattleRecoverySummary {
                recovered_tower_battle_count: 0,
                recovered_dungeon_battle_count: 0,
            }
        );
    }

    #[test]
    fn afdian_retry_interval_is_positive() {
        assert!(super::AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS > 0);
    }

    #[test]
    fn afdian_retry_batch_size_defaults_and_clamps_like_node() {
        let key = "AFDIAN_MESSAGE_RETRY_BATCH_SIZE";
        let original = std::env::var(key).ok();

        unsafe {
            std::env::remove_var(key);
        }
        assert_eq!(
            super::load_afdian_message_retry_batch_size(),
            super::AFDIAN_MESSAGE_RETRY_BATCH_SIZE
        );

        unsafe {
            std::env::set_var(key, "0");
        }
        assert_eq!(super::load_afdian_message_retry_batch_size(), 1);

        unsafe {
            std::env::set_var(key, "999");
        }
        assert_eq!(super::load_afdian_message_retry_batch_size(), 50);

        unsafe {
            std::env::set_var(key, "7");
        }
        assert_eq!(super::load_afdian_message_retry_batch_size(), 7);

        match original {
            Some(value) => unsafe {
                std::env::set_var(key, value);
            },
            None => unsafe {
                std::env::remove_var(key);
            },
        }

        println!(
            "AFDIAN_RETRY_BATCH_SIZE={{\"default\":{},\"minClamp\":1,\"maxClamp\":50,\"custom\":7}}",
            super::AFDIAN_MESSAGE_RETRY_BATCH_SIZE
        );
    }

    #[test]
    fn afdian_retry_enabled_defaults_and_parses_like_node() {
        let key = "AFDIAN_MESSAGE_RETRY_ENABLED";
        let original = std::env::var(key).ok();

        unsafe {
            std::env::remove_var(key);
        }
        assert!(super::load_afdian_message_retry_enabled());

        unsafe {
            std::env::set_var(key, "false");
        }
        assert!(!super::load_afdian_message_retry_enabled());

        unsafe {
            std::env::set_var(key, "true");
        }
        assert!(super::load_afdian_message_retry_enabled());

        unsafe {
            std::env::set_var(key, "garbage");
        }
        assert!(super::load_afdian_message_retry_enabled());

        match original {
            Some(value) => unsafe {
                std::env::set_var(key, value);
            },
            None => unsafe {
                std::env::remove_var(key);
            },
        }

        println!(
            "AFDIAN_RETRY_ENABLED={{\"default\":true,\"false\":false,\"true\":true,\"garbageFallsBack\":true}}"
        );
    }

    #[test]
    fn afdian_retry_interval_defaults_and_clamps_like_node() {
        let key = "AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS";
        let original = std::env::var(key).ok();

        unsafe {
            std::env::remove_var(key);
        }
        assert_eq!(
            super::load_afdian_message_retry_interval_seconds(),
            super::AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS
        );

        unsafe {
            std::env::set_var(key, "1");
        }
        assert_eq!(super::load_afdian_message_retry_interval_seconds(), 10);

        unsafe {
            std::env::set_var(key, "999999");
        }
        assert_eq!(super::load_afdian_message_retry_interval_seconds(), 3600);

        unsafe {
            std::env::set_var(key, "45");
        }
        assert_eq!(super::load_afdian_message_retry_interval_seconds(), 45);

        match original {
            Some(value) => unsafe {
                std::env::set_var(key, value);
            },
            None => unsafe {
                std::env::remove_var(key);
            },
        }

        println!(
            "AFDIAN_RETRY_INTERVAL={{\"default\":{},\"minClamp\":10,\"maxClamp\":3600,\"custom\":45}}",
            super::AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS
        );
    }

    #[test]
    fn achievement_point_delta_tuple_extracts_known_fields() {
        let deltas = HashMap::from([
            ("achievement_points:total".to_string(), 40),
            ("achievement_points:exploration_points".to_string(), 40),
            ("achievement_points:combat_points".to_string(), -3),
        ]);
        let tuple = extract_achievement_point_delta_tuple(&deltas);
        assert_eq!(tuple, (40, 0, 0, 40, 0, 0));
        println!(
            "ACHIEVEMENT_POINT_DELTA_TUPLE={{\"total\":{},\"combat\":{},\"cultivation\":{},\"exploration\":{},\"social\":{},\"collection\":{}}}",
            tuple.0, tuple.1, tuple.2, tuple.3, tuple.4, tuple.5
        );
    }
}

fn emit_recovered_battle_realtime(
    state: &AppState,
    session: &BattleSessionSnapshotDto,
    battle_state: crate::battle_runtime::BattleStateDto,
) {
    let debug_realtime = build_battle_started_payload(
        session.current_battle_id.as_deref().unwrap_or_default(),
        battle_state.clone(),
        vec![serde_json::json!({"type": "round_start", "round": 1})],
        Some(session.clone()),
    );
    emit_battle_update_to_participants(state, &session.participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(
        state,
        &session.participant_user_ids,
        &debug_cooldown_realtime,
    );
}

pub fn spawn_idle_heartbeat_loop(state: AppState, character_id: i64) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(IDLE_HEARTBEAT_TICK_SECONDS)).await;
            match idle::touch_idle_heartbeat_for_character(&state, character_id).await {
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(character_id, error = %error, "idle heartbeat loop iteration failed");
                    break;
                }
            }
        }
    });
}
