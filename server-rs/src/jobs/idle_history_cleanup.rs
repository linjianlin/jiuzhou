use anyhow::Result;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::state::AppState;

const IDLE_CLEANUP_LOCK_KEY_1: i64 = 2026;
const IDLE_CLEANUP_LOCK_KEY_2: i64 = 311;
const DEFAULT_IDLE_HISTORY_KEEP_COUNT: i64 = 3;
const DEFAULT_INTERVAL_SECONDS: u64 = 600;
const DEFAULT_DELETE_SESSION_BATCH_SIZE: i64 = 20;
const DEFAULT_MAX_DELETE_BATCHES_PER_RUN: i64 = 20;

const IDLE_FINISHED_SESSION_STATUSES: &[&str] = &["completed", "interrupted"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleHistoryCleanupConfig {
    pub enabled: bool,
    pub keep_session_count: i64,
    pub interval_ms: u64,
    pub delete_session_batch_size: i64,
    pub max_delete_batches_per_run: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdleHistoryCleanupSummary {
    pub deleted_session_count: usize,
}

pub fn load_idle_history_cleanup_config() -> IdleHistoryCleanupConfig {
    let enabled = std::env::var("IDLE_HISTORY_CLEANUP_ENABLED")
        .ok()
        .and_then(|value| value.parse::<bool>().ok())
        .unwrap_or(true);
    let keep_session_count = std::env::var("IDLE_HISTORY_KEEP_COUNT")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_IDLE_HISTORY_KEEP_COUNT)
        .clamp(1, 30);
    let interval_seconds = std::env::var("IDLE_HISTORY_CLEANUP_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECONDS)
        .clamp(60, 86_400);
    let delete_session_batch_size = std::env::var("IDLE_HISTORY_CLEANUP_DELETE_SESSION_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DELETE_SESSION_BATCH_SIZE)
        .clamp(1, 1000);
    let max_delete_batches_per_run = std::env::var("IDLE_HISTORY_CLEANUP_MAX_BATCHES_PER_RUN")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_MAX_DELETE_BATCHES_PER_RUN)
        .clamp(1, 200);
    IdleHistoryCleanupConfig {
        enabled,
        keep_session_count,
        interval_ms: interval_seconds * 1000,
        delete_session_batch_size,
        max_delete_batches_per_run,
    }
}

pub async fn run_idle_history_cleanup_once(
    state: &AppState,
) -> Result<IdleHistoryCleanupSummary> {
    let config = load_idle_history_cleanup_config();
    if !config.enabled {
        return Ok(IdleHistoryCleanupSummary::default());
    }

    let acquired = state
        .database
        .fetch_one(
            "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
            |query| query.bind(IDLE_CLEANUP_LOCK_KEY_1).bind(IDLE_CLEANUP_LOCK_KEY_2),
        )
        .await?
        .try_get::<Option<bool>, _>("acquired")?
        .unwrap_or(false);
    if !acquired {
        return Ok(IdleHistoryCleanupSummary::default());
    }

    let mut summary = IdleHistoryCleanupSummary::default();
    let result = async {
        for _ in 0..config.max_delete_batches_per_run {
            let rows = state
                .database
                .fetch_all(
                    "WITH ranked_session AS ( SELECT s.id, s.started_at, ROW_NUMBER() OVER ( PARTITION BY s.character_id ORDER BY s.started_at DESC, s.id DESC ) AS rank_no FROM idle_sessions s WHERE s.status = ANY($1::varchar[]) ), stale_session AS ( SELECT rs.id FROM ranked_session rs WHERE rs.rank_no > $2 ORDER BY rs.started_at ASC, rs.id ASC LIMIT $3 ) DELETE FROM idle_sessions s USING stale_session WHERE s.id = stale_session.id RETURNING s.id",
                    |query| query.bind(IDLE_FINISHED_SESSION_STATUSES).bind(config.keep_session_count).bind(config.delete_session_batch_size),
                )
                .await?;
            summary.deleted_session_count += rows.len();
            if (rows.len() as i64) < config.delete_session_batch_size {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    let _ = state
        .database
        .execute(
                "SELECT pg_advisory_unlock($1::int, $2::int)",
            |query| query.bind(IDLE_CLEANUP_LOCK_KEY_1).bind(IDLE_CLEANUP_LOCK_KEY_2),
        )
        .await;

    result?;
    Ok(summary)
}

pub fn spawn_idle_history_cleanup_loop(state: AppState) {
    let config = load_idle_history_cleanup_config();
    if !config.enabled {
        return;
    }
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(config.interval_ms)).await;
            match run_idle_history_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        deleted_session_count = summary.deleted_session_count,
                        "idle history cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "idle history cleanup loop iteration failed");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_DELETE_SESSION_BATCH_SIZE, DEFAULT_IDLE_HISTORY_KEEP_COUNT, DEFAULT_MAX_DELETE_BATCHES_PER_RUN, IdleHistoryCleanupSummary, load_idle_history_cleanup_config};

    #[test]
    fn idle_history_cleanup_summary_defaults_to_zero() {
        let summary = IdleHistoryCleanupSummary::default();
        assert_eq!(summary.deleted_session_count, 0);
    }

    #[test]
    fn idle_history_cleanup_config_uses_defaults() {
        let config = load_idle_history_cleanup_config();
        assert_eq!(config.keep_session_count, DEFAULT_IDLE_HISTORY_KEEP_COUNT);
        assert_eq!(config.delete_session_batch_size, DEFAULT_DELETE_SESSION_BATCH_SIZE);
        assert_eq!(config.max_delete_batches_per_run, DEFAULT_MAX_DELETE_BATCHES_PER_RUN);
        println!("IDLE_HISTORY_CLEANUP_INTERVAL_MS={}", config.interval_ms);
    }
}
