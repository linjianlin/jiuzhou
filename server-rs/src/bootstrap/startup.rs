use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use sqlx::Row;

use crate::bootstrap::app::build_router;
use crate::bootstrap::avatar_cleanup::clear_all_avatars_once;
use crate::bootstrap::generated_content_refresh::refresh_generated_content_on_startup;
use crate::bootstrap::item_data_cleanup::cleanup_undefined_item_data_on_startup;
use crate::bootstrap::performance_indexes::ensure_performance_indexes;
use crate::config::AppConfig;
use crate::integrations::battle_persistence::{
    recover_all_battle_bundles, recover_all_orphan_battle_sessions,
};
use crate::integrations::{database, http_client, redis};
use crate::jobs::JobRuntime;
use crate::jobs::battle_expired_cleanup::run_battle_expired_cleanup_once;
use crate::jobs::dungeon_cleanup::run_dungeon_expired_instance_cleanup_once;
use crate::jobs::idle_history_cleanup::run_idle_history_cleanup_once;
use crate::jobs::mail_history_cleanup::run_mail_history_cleanup_once;
use crate::jobs::partner_recruit_draft_cleanup::run_partner_recruit_draft_cleanup_once;
use crate::jobs::technique_draft_cleanup::run_technique_draft_cleanup_once;
use crate::jobs::tower_frozen_pool::warmup_frozen_tower_pool_cache;
use crate::realtime::RealtimeRuntime;
use crate::shared::error::AppError;
use crate::shared::game_time::initialize_game_time_runtime;
use crate::shared::mail_counter::backfill_mail_counter_if_empty;
use crate::shared::tracing::init_tracing;
use crate::state::{
    AppState, ArenaProjectionRecord, BattleSessionContextDto, CharacterSnapshotRecord,
    DungeonEntryProjectionRecord, DungeonProjectionRecord, TeamProjectionRecord,
    TowerProjectionRecord,
};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OnlineBattleProjectionWarmupSummary {
    pub(crate) battle_projection_count: usize,
    pub(crate) session_count: usize,
    pub(crate) arena_count: usize,
    pub(crate) arena_projection_count: usize,
    pub(crate) character_snapshot_count: usize,
    pub(crate) dungeon_count: usize,
    pub(crate) dungeon_projection_count: usize,
    pub(crate) tower_count: usize,
    pub(crate) orphan_projection_count: usize,
    pub(crate) team_projection_count: usize,
    pub(crate) dungeon_entry_projection_count: usize,
}

pub struct BootstrappedApplication {
    pub state: AppState,
    pub router: Router,
    pub realtime_runtime: RealtimeRuntime,
    pub job_runtime: JobRuntime,
}

pub async fn bootstrap_application() -> anyhow::Result<BootstrappedApplication> {
    let config = AppConfig::load().context("failed to load Rust backend configuration")?;
    init_tracing(&config.logging.level, &config.service.node_env)
        .context("failed to initialize Rust backend tracing")?;

    tracing::info!(
        service = %config.service.name,
        version = %config.service.version,
        env = %config.service.node_env,
        "bootstrapping Rust backend"
    );

    let config = Arc::new(config);

    tracing::info!("→ database probe");
    let database = database::connect(&config.database).await?;
    tracing::info!("✓ database ready");

    tracing::info!("→ sqlx schema migration");
    let migration_summary = database.apply_migrations().await?;
    tracing::info!(
        adopted_existing_schema_as_baseline = migration_summary.adopted_existing_schema_as_baseline,
        previously_applied_migration_count = migration_summary.previously_applied_migration_count,
        total_applied_migration_count = migration_summary.total_applied_migration_count,
        newly_applied_migration_count = migration_summary.newly_applied_migration_count,
        "✓ sqlx schema migration complete"
    );

    tracing::info!("→ redis probe");
    let (redis_client, redis_available) = redis::connect(&config.redis).await?;
    if redis_available {
        tracing::info!("✓ redis ready");
    } else {
        tracing::warn!("⚠ redis unavailable, runtime will start in degraded mode");
    }

    tracing::info!("→ outbound http client setup");
    let outbound_http = http_client::build(&config.outbound_http)?;
    tracing::info!("✓ outbound http client ready");

    tracing::info!(uploads_dir = %config.storage.uploads_dir.display(), "→ uploads directory check");
    tokio::fs::create_dir_all(&config.storage.uploads_dir)
        .await
        .with_context(|| {
            format!(
                "failed to ensure uploads directory {}",
                config.storage.uploads_dir.display()
            )
        })?;
    tracing::info!("✓ uploads directory ready");

    let state = AppState::new(
        config,
        database,
        Some(redis_client),
        outbound_http,
        redis_available,
    );

    let realtime_runtime = RealtimeRuntime::new();
    realtime_runtime.initialize().await?;

    tracing::info!("→ item data cleanup");
    let item_data_cleanup_summary = cleanup_undefined_item_data_on_startup(&state).await?;
    tracing::info!(
        valid_item_def_count = item_data_cleanup_summary.valid_item_def_count,
        removed_item_instance_count = item_data_cleanup_summary.removed_item_instance_count,
        removed_item_use_cooldown_count = item_data_cleanup_summary.removed_item_use_cooldown_count,
        removed_item_use_count_count = item_data_cleanup_summary.removed_item_use_count_count,
        "✓ item data cleanup complete"
    );

    tracing::info!("→ generated content refresh");
    let generated_content_refresh_summary = refresh_generated_content_on_startup(&state).await?;
    tracing::info!(
        published_generated_technique_count =
            generated_content_refresh_summary.published_generated_technique_count,
        enabled_generated_skill_count =
            generated_content_refresh_summary.enabled_generated_skill_count,
        enabled_generated_technique_layer_count =
            generated_content_refresh_summary.enabled_generated_technique_layer_count,
        enabled_generated_partner_count =
            generated_content_refresh_summary.enabled_generated_partner_count,
        "✓ generated content refresh complete"
    );

    tracing::info!("→ avatar cleanup check");
    let avatar_cleanup_summary = clear_all_avatars_once(&state).await?;
    tracing::info!(
        enabled = avatar_cleanup_summary.enabled,
        cleared_avatar_row_count = avatar_cleanup_summary.cleared_avatar_row_count,
        deleted_local_file_count = avatar_cleanup_summary.deleted_local_file_count,
        "✓ avatar cleanup check complete"
    );

    tracing::info!("→ performance index sync");
    let performance_index_summary = ensure_performance_indexes(&state).await?;
    tracing::info!(
        ensured_index_count = performance_index_summary.ensured_index_count,
        rebuilt_index_count = performance_index_summary.rebuilt_index_count,
        "✓ performance index sync complete"
    );

    tracing::info!("→ expired dungeon instance cleanup");
    let dungeon_cleanup_summary = run_dungeon_expired_instance_cleanup_once(&state).await?;
    tracing::info!(
        protected_instance_count = dungeon_cleanup_summary.protected_instance_count,
        abandoned_preparing_count = dungeon_cleanup_summary.abandoned_preparing_count,
        abandoned_running_count = dungeon_cleanup_summary.abandoned_running_count,
        "✓ expired dungeon instance cleanup complete"
    );

    tracing::info!("→ idle history cleanup");
    let idle_history_cleanup_summary = run_idle_history_cleanup_once(&state).await?;
    tracing::info!(
        deleted_session_count = idle_history_cleanup_summary.deleted_session_count,
        "✓ idle history cleanup complete"
    );

    tracing::info!("→ battle expired cleanup");
    let battle_expired_cleanup_summary = run_battle_expired_cleanup_once(&state).await?;
    tracing::info!(
        expired_battle_count = battle_expired_cleanup_summary.expired_battle_count,
        "✓ battle expired cleanup complete"
    );

    tracing::info!("→ partner recruit draft cleanup");
    let partner_recruit_draft_cleanup_summary =
        run_partner_recruit_draft_cleanup_once(&state).await?;
    tracing::info!(
        discarded_draft_count = partner_recruit_draft_cleanup_summary.discarded_draft_count,
        "✓ partner recruit draft cleanup complete"
    );

    tracing::info!("→ technique draft cleanup");
    let technique_draft_cleanup_summary = run_technique_draft_cleanup_once(&state).await?;
    tracing::info!(
        refunded_draft_count = technique_draft_cleanup_summary.refunded_draft_count,
        "✓ technique draft cleanup complete"
    );

    tracing::info!("→ mail history cleanup");
    let mail_history_cleanup_summary = run_mail_history_cleanup_once(&state).await?;
    tracing::info!(
        deleted_soft_deleted_count = mail_history_cleanup_summary.deleted_soft_deleted_count,
        deleted_expired_count = mail_history_cleanup_summary.deleted_expired_count,
        "✓ mail history cleanup complete"
    );

    tracing::info!("→ frozen tower pool warmup");
    let frozen_tower_pool_summary = warmup_frozen_tower_pool_cache(&state).await?;
    tracing::info!(
        frozen_floor_max = frozen_tower_pool_summary.frozen_floor_max,
        snapshot_count = frozen_tower_pool_summary.snapshot_count,
        "✓ frozen tower pool warmup complete"
    );

    tracing::info!("→ persisted battle recovery");
    let recovered_battle_summary = recover_all_battle_bundles(&state).await?;
    tracing::info!(
        recovered_battle_count = recovered_battle_summary.recovered_battle_count,
        recovered_pve_count = recovered_battle_summary.pve_count,
        recovered_pvp_count = recovered_battle_summary.pvp_count,
        recovered_arena_count = recovered_battle_summary.arena_count,
        recovered_dungeon_count = recovered_battle_summary.dungeon_count,
        recovered_tower_count = recovered_battle_summary.tower_count,
        "✓ persisted battle recovery complete"
    );

    tracing::info!("→ orphan battle session recovery");
    let recovered_orphan_session_count = recover_all_orphan_battle_sessions(&state).await?;
    tracing::info!(
        recovered_orphan_session_count,
        "✓ orphan battle session recovery complete"
    );

    let job_runtime = JobRuntime::new();
    let job_summary = job_runtime.initialize(state.clone()).await?;
    tracing::info!(
        idle_session_count = job_summary.idle_session_count,
        recovered_tower_battle_count = job_summary.recovered_tower_battle_count,
        recovered_dungeon_battle_count = job_summary.recovered_dungeon_battle_count,
        afdian_delivery_count = job_summary.afdian_delivery_count,
        arena_weekly_settlement_week_count = job_summary.arena_weekly_settlement_week_count,
        rank_snapshot_character_count = job_summary.rank_snapshot_character_count,
        rank_snapshot_partner_count = job_summary.rank_snapshot_partner_count,
        partner_recruit_job_count = job_summary.partner_recruit_job_count,
        partner_fusion_job_count = job_summary.partner_fusion_job_count,
        partner_rebone_job_count = job_summary.partner_rebone_job_count,
        technique_generation_job_count = job_summary.technique_generation_job_count,
        wander_generation_job_count = job_summary.wander_generation_job_count,
        "✓ job recovery summary"
    );
    backfill_mail_counter_if_empty(&state).await?;

    let online_battle_warmup_summary = warmup_online_battle_projection_runtime(&state).await?;
    tracing::info!(
        battle_projection_count = online_battle_warmup_summary.battle_projection_count,
        session_count = online_battle_warmup_summary.session_count,
        arena_count = online_battle_warmup_summary.arena_count,
        arena_projection_count = online_battle_warmup_summary.arena_projection_count,
        character_snapshot_count = online_battle_warmup_summary.character_snapshot_count,
        dungeon_count = online_battle_warmup_summary.dungeon_count,
        dungeon_projection_count = online_battle_warmup_summary.dungeon_projection_count,
        tower_count = online_battle_warmup_summary.tower_count,
        team_projection_count = online_battle_warmup_summary.team_projection_count,
        dungeon_entry_projection_count =
            online_battle_warmup_summary.dungeon_entry_projection_count,
        orphan_projection_count = online_battle_warmup_summary.orphan_projection_count,
        "✓ online battle projection warmup summary"
    );

    tracing::info!("→ game time runtime init");
    let game_time_summary = initialize_game_time_runtime(state.clone()).await?;
    tracing::info!(
        initialized = game_time_summary.initialized,
        loaded_from_db = game_time_summary.loaded_from_db,
        persisted_default_row = game_time_summary.persisted_default_row,
        "✓ game time runtime ready"
    );

    tracing::info!(
        recovered_battle_count = recovered_battle_summary.recovered_battle_count,
        recovered_orphan_session_count,
        idle_session_count = job_summary.idle_session_count,
        recovered_tower_battle_count = job_summary.recovered_tower_battle_count,
        recovered_dungeon_battle_count = job_summary.recovered_dungeon_battle_count,
        rank_snapshot_character_count = job_summary.rank_snapshot_character_count,
        rank_snapshot_partner_count = job_summary.rank_snapshot_partner_count,
        arena_weekly_settlement_week_count = job_summary.arena_weekly_settlement_week_count,
        frozen_tower_snapshot_count = frozen_tower_pool_summary.snapshot_count,
        online_battle_projection_count = online_battle_warmup_summary.battle_projection_count,
        session_count = online_battle_warmup_summary.session_count,
        "✓ startup warmup pipeline complete"
    );

    let router = build_router(state.clone())?;

    Ok(BootstrappedApplication {
        state,
        router,
        realtime_runtime,
        job_runtime,
    })
}

fn build_online_battle_projection_warmup_summary(
    state: &AppState,
) -> OnlineBattleProjectionWarmupSummary {
    let sessions = state.battle_sessions.snapshot();
    let projections = state.online_battle_projections.snapshot();
    build_online_battle_projection_warmup_summary_from_snapshots(&sessions, &projections)
}

pub(crate) async fn warmup_online_battle_projection_runtime(
    state: &AppState,
) -> Result<OnlineBattleProjectionWarmupSummary, AppError> {
    fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
        row.try_get::<Option<i32>, _>(column)
            .unwrap_or(None)
            .map(i64::from)
            .unwrap_or_default()
    }

    for row in state
        .database
        .fetch_all(
            "WITH recent_characters AS ( SELECT c.id AS character_id, c.user_id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS nickname, COALESCE(c.realm, '凡人') AS realm, COALESCE(crs.power, 0)::bigint AS power FROM characters c LEFT JOIN character_rank_snapshot crs ON crs.character_id = c.id JOIN users u ON u.id = c.user_id WHERE GREATEST( COALESCE(c.updated_at::timestamptz, c.created_at::timestamptz, to_timestamp(0)), COALESCE(c.last_offline_at, to_timestamp(0)), COALESCE(u.last_login::timestamptz, to_timestamp(0)) ) >= NOW() - (7 * INTERVAL '1 day') ), running_dungeon_participants AS ( SELECT DISTINCT (participant ->> 'characterId')::bigint AS character_id FROM dungeon_instance di CROSS JOIN LATERAL jsonb_array_elements(COALESCE(di.participants::jsonb, '[]'::jsonb)) participant WHERE di.status IN ('preparing', 'running') ), running_tower_characters AS ( SELECT character_id FROM character_tower_progress WHERE current_run_id IS NOT NULL OR current_battle_id IS NOT NULL ), candidate AS ( SELECT character_id FROM recent_characters UNION SELECT creator_id AS character_id FROM dungeon_instance WHERE status IN ('preparing', 'running') UNION SELECT character_id FROM running_dungeon_participants UNION SELECT character_id FROM running_tower_characters ) SELECT c.id AS character_id, c.user_id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS nickname, COALESCE(c.realm, '凡人') AS realm, COALESCE(crs.power, 0)::bigint AS power FROM candidate x JOIN characters c ON c.id = x.character_id LEFT JOIN character_rank_snapshot crs ON crs.character_id = c.id WHERE c.id > 0 ORDER BY c.id ASC",
            |query| query,
        )
        .await?
    {
        let character_id = opt_i64_from_i32(&row, "character_id");
        let user_id = opt_i64_from_i32(&row, "user_id");
        if character_id <= 0 || user_id <= 0 {
            continue;
        }
        state.character_snapshots.register(CharacterSnapshotRecord {
            character_id,
            user_id,
            nickname: row.try_get::<Option<String>, _>("nickname")?.unwrap_or_default(),
            realm: row.try_get::<Option<String>, _>("realm")?.unwrap_or_else(|| "凡人".to_string()),
            power: row.try_get::<Option<i64>, _>("power")?.unwrap_or_default().max(0),
        });
    }

    for row in state
        .database
        .fetch_all(
            "SELECT id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants::jsonb AS participants, instance_data::jsonb AS instance_data FROM dungeon_instance WHERE status IN ('preparing', 'running')",
            |query| query,
        )
        .await?
    {
        let instance_id = row.try_get::<Option<String>, _>("id")?.unwrap_or_default();
        if instance_id.trim().is_empty() {
            continue;
        }
        let participants = row
            .try_get::<Option<serde_json::Value>, _>("participants")?
            .unwrap_or_else(|| serde_json::json!([]));
        let participant_character_ids = participants
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("characterId").and_then(|value| value.as_i64()))
            .filter(|value| *value > 0)
            .collect::<Vec<_>>();
        let instance_data = row
            .try_get::<Option<serde_json::Value>, _>("instance_data")?
            .unwrap_or_else(|| serde_json::json!({}));
        state.dungeon_projections.register(DungeonProjectionRecord {
            instance_id,
            dungeon_id: row.try_get::<Option<String>, _>("dungeon_id")?.unwrap_or_default(),
            difficulty_id: row.try_get::<Option<String>, _>("difficulty_id")?.unwrap_or_default(),
            creator_character_id: opt_i64_from_i32(&row, "creator_id"),
            team_id: row.try_get::<Option<String>, _>("team_id")?,
            status: row.try_get::<Option<String>, _>("status")?.unwrap_or_default(),
            current_stage: opt_i64_from_i32(&row, "current_stage").max(1),
            current_wave: opt_i64_from_i32(&row, "current_wave").max(1),
            participant_character_ids,
            current_battle_id: instance_data.get("currentBattleId").and_then(|value| value.as_str()).map(|value| value.to_string()),
        });
    }

    for row in state
        .database
        .fetch_all(
            "WITH rating_rows AS (SELECT character_id, rating, win_count, lose_count FROM arena_rating), today_usage AS (SELECT challenger_character_id AS character_id, COUNT(*)::bigint AS cnt FROM arena_battle WHERE created_at >= date_trunc('day', NOW()) GROUP BY challenger_character_id), character_ids AS (SELECT character_id FROM rating_rows UNION SELECT character_id FROM today_usage) SELECT cid.character_id, COALESCE(rr.rating, 1000)::bigint AS score, COALESCE(rr.win_count, 0)::bigint AS win_count, COALESCE(rr.lose_count, 0)::bigint AS lose_count, COALESCE(tu.cnt, 0)::bigint AS today_used FROM character_ids cid LEFT JOIN rating_rows rr ON rr.character_id = cid.character_id LEFT JOIN today_usage tu ON tu.character_id = cid.character_id ORDER BY cid.character_id ASC",
            |query| query,
        )
        .await?
    {
        let character_id = opt_i64_from_i32(&row, "character_id");
        if character_id <= 0 {
            continue;
        }
        state.arena_projections.register(ArenaProjectionRecord {
            character_id,
            score: row.try_get::<Option<i64>, _>("score")?.unwrap_or(1000).max(0),
            win_count: row.try_get::<Option<i64>, _>("win_count")?.unwrap_or_default().max(0),
            lose_count: row.try_get::<Option<i64>, _>("lose_count")?.unwrap_or_default().max(0),
            today_used: row.try_get::<Option<i64>, _>("today_used")?.unwrap_or_default().max(0),
            today_limit: 5,
        });
    }

    for row in state
        .database
        .fetch_all(
            "SELECT c.user_id, tm.character_id, tm.team_id, tm.role FROM team_members tm JOIN characters c ON c.id = tm.character_id ORDER BY tm.team_id ASC, tm.role DESC, tm.joined_at ASC",
            |query| query,
        )
        .await?
    {
        let user_id = opt_i64_from_i32(&row, "user_id");
        let character_id = opt_i64_from_i32(&row, "character_id");
        let team_id = row.try_get::<Option<String>, _>("team_id")?;
        if user_id <= 0 || character_id <= 0 || team_id.as_deref().unwrap_or_default().is_empty() {
            continue;
        }
        let role = row.try_get::<Option<String>, _>("role")?.unwrap_or_else(|| "member".to_string());
        let member_character_ids = state
            .database
            .fetch_all(
                "SELECT character_id FROM team_members WHERE team_id = $1 ORDER BY role DESC, joined_at ASC",
                |query| query.bind(team_id.as_deref().unwrap_or_default()),
            )
            .await?
            .into_iter()
            .filter_map(|member_row| member_row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from))
            .filter(|value| *value > 0)
            .collect::<Vec<_>>();
        state.team_projections.register(TeamProjectionRecord {
            user_id,
            team_id,
            role,
            member_character_ids,
        });
    }

    for row in state
        .database
        .fetch_all(
            "SELECT character_id, dungeon_id, daily_count, weekly_count, total_count, last_daily_reset::text AS last_daily_reset, last_weekly_reset::text AS last_weekly_reset FROM dungeon_entry_count",
            |query| query,
        )
        .await?
    {
        let character_id = opt_i64_from_i32(&row, "character_id");
        let dungeon_id = row.try_get::<Option<String>, _>("dungeon_id")?.unwrap_or_default();
        if character_id <= 0 || dungeon_id.trim().is_empty() {
            continue;
        }
        state.dungeon_entry_projections.register(DungeonEntryProjectionRecord {
            character_id,
            dungeon_id,
            daily_count: opt_i64_from_i32(&row, "daily_count").max(0),
            weekly_count: opt_i64_from_i32(&row, "weekly_count").max(0),
            total_count: opt_i64_from_i32(&row, "total_count").max(0),
            last_daily_reset: row.try_get::<Option<String>, _>("last_daily_reset")?.unwrap_or_default(),
            last_weekly_reset: row.try_get::<Option<String>, _>("last_weekly_reset")?.unwrap_or_default(),
        });
    }

    for row in state
        .database
        .fetch_all(
            "SELECT character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at::text AS updated_at_text, reached_at::text AS reached_at_text FROM character_tower_progress",
            |query| query,
        )
        .await?
    {
        let character_id = opt_i64_from_i32(&row, "character_id");
        if character_id <= 0 {
            continue;
        }
        state.tower_projections.register(TowerProjectionRecord {
            character_id,
            best_floor: opt_i64_from_i32(&row, "best_floor").max(0),
            next_floor: opt_i64_from_i32(&row, "next_floor").max(1),
            current_run_id: row.try_get::<Option<String>, _>("current_run_id")?,
            current_floor: row.try_get::<Option<i32>, _>("current_floor")?.map(i64::from),
            current_battle_id: row.try_get::<Option<String>, _>("current_battle_id")?,
            last_settled_floor: opt_i64_from_i32(&row, "last_settled_floor").max(0),
            updated_at: row.try_get::<Option<String>, _>("updated_at_text")?,
            reached_at: row.try_get::<Option<String>, _>("reached_at_text")?,
        });
    }

    let mut summary = build_online_battle_projection_warmup_summary(state);
    summary.character_snapshot_count = state.character_snapshots.snapshot().len();
    summary.arena_projection_count = state.arena_projections.snapshot().len();
    summary.dungeon_projection_count = state.dungeon_projections.snapshot().len();
    summary.team_projection_count = state.team_projections.snapshot().len();
    summary.dungeon_entry_projection_count = state.dungeon_entry_projections.snapshot().len();
    summary.tower_count = state.tower_projections.snapshot().len();
    Ok(summary)
}

fn build_online_battle_projection_warmup_summary_from_snapshots(
    sessions: &[crate::state::BattleSessionSnapshotDto],
    projections: &[crate::state::OnlineBattleProjectionRecord],
) -> OnlineBattleProjectionWarmupSummary {
    let session_ids = sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let mut summary = OnlineBattleProjectionWarmupSummary {
        battle_projection_count: projections.len(),
        session_count: sessions.len(),
        ..Default::default()
    };

    for session in sessions {
        match &session.context {
            BattleSessionContextDto::Dungeon { .. } => summary.dungeon_count += 1,
            BattleSessionContextDto::Tower { .. } => summary.tower_count += 1,
            BattleSessionContextDto::Pvp { mode, .. } if mode == "arena" => {
                summary.arena_count += 1
            }
            _ => {}
        }
    }

    for projection in projections {
        if projection
            .session_id
            .as_deref()
            .is_some_and(|session_id| !session_ids.contains(session_id))
        {
            summary.orphan_projection_count += 1;
        }
    }

    summary
}

#[cfg(test)]
mod tests {
    use super::{
        OnlineBattleProjectionWarmupSummary,
        build_online_battle_projection_warmup_summary_from_snapshots,
    };
    use crate::state::{
        BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
    };

    #[test]
    fn online_battle_projection_warmup_summary_counts_contexts_and_orphans() {
        let sessions = vec![
            BattleSessionSnapshotDto {
                session_id: "arena-session-1".to_string(),
                session_type: "pvp".to_string(),
                owner_user_id: 1,
                participant_user_ids: vec![1],
                current_battle_id: Some("battle-1".to_string()),
                status: "running".to_string(),
                next_action: "none".to_string(),
                can_advance: false,
                last_result: None,
                context: BattleSessionContextDto::Pvp {
                    opponent_character_id: 2,
                    mode: "arena".to_string(),
                },
            },
            BattleSessionSnapshotDto {
                session_id: "tower-session-1".to_string(),
                session_type: "tower".to_string(),
                owner_user_id: 3,
                participant_user_ids: vec![3],
                current_battle_id: Some("battle-2".to_string()),
                status: "running".to_string(),
                next_action: "none".to_string(),
                can_advance: false,
                last_result: None,
                context: BattleSessionContextDto::Tower {
                    run_id: "run-1".to_string(),
                    floor: 5,
                },
            },
        ];
        let projections = vec![
            OnlineBattleProjectionRecord {
                battle_id: "battle-1".to_string(),
                owner_user_id: 1,
                participant_user_ids: vec![1],
                r#type: "pvp".to_string(),
                session_id: Some("arena-session-1".to_string()),
            },
            OnlineBattleProjectionRecord {
                battle_id: "battle-orphan".to_string(),
                owner_user_id: 9,
                participant_user_ids: vec![9],
                r#type: "pve".to_string(),
                session_id: Some("missing-session".to_string()),
            },
        ];

        let summary =
            build_online_battle_projection_warmup_summary_from_snapshots(&sessions, &projections);
        assert_eq!(
            summary,
            OnlineBattleProjectionWarmupSummary {
                battle_projection_count: 2,
                session_count: 2,
                arena_count: 1,
                arena_projection_count: 0,
                character_snapshot_count: 0,
                dungeon_count: 0,
                dungeon_projection_count: 0,
                tower_count: 1,
                orphan_projection_count: 1,
                team_projection_count: 0,
                dungeon_entry_projection_count: 0,
            }
        );
    }
}
