use anyhow::Result;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::state::AppState;

const MAIL_HISTORY_CLEANUP_LOCK_KEY_1: i64 = 2026;
const MAIL_HISTORY_CLEANUP_LOCK_KEY_2: i64 = 312;
const DEFAULT_RETENTION_DAYS: i64 = 7;
const DEFAULT_INTERVAL_SECONDS: u64 = 600;
const DEFAULT_DELETE_BATCH_SIZE: i64 = 5_000;
const DEFAULT_MAX_DELETE_BATCHES_PER_RUN: i64 = 20;

const MAIL_SOFT_DELETED_CLEANUP_SQL: &str = "WITH stale_mail AS ( SELECT id FROM mail WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - (($1::text || ' days')::interval) ORDER BY deleted_at ASC, id ASC LIMIT $2 ) DELETE FROM mail WHERE id IN (SELECT id FROM stale_mail) RETURNING id";
const MAIL_EXPIRED_HISTORY_CLEANUP_SQL: &str = "WITH stale_mail AS ( SELECT id FROM mail WHERE deleted_at IS NULL AND expire_at IS NOT NULL AND expire_at < NOW() - (($1::text || ' days')::interval) ORDER BY expire_at ASC, id ASC LIMIT $2 ) DELETE FROM mail WHERE id IN (SELECT id FROM stale_mail) RETURNING id";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailHistoryCleanupConfig {
    pub enabled: bool,
    pub retention_days: i64,
    pub interval_ms: u64,
    pub delete_batch_size: i64,
    pub max_delete_batches_per_run: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MailHistoryCleanupSummary {
    pub deleted_soft_deleted_count: usize,
    pub deleted_expired_count: usize,
}

pub fn load_mail_history_cleanup_config() -> MailHistoryCleanupConfig {
    let enabled = std::env::var("MAIL_HISTORY_CLEANUP_ENABLED")
        .ok()
        .and_then(|value| value.parse::<bool>().ok())
        .unwrap_or(true);
    let retention_days = std::env::var("MAIL_HISTORY_RETENTION_DAYS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_RETENTION_DAYS)
        .clamp(1, 365);
    let interval_seconds = std::env::var("MAIL_HISTORY_CLEANUP_INTERVAL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECONDS)
        .clamp(60, 86_400);
    let delete_batch_size = std::env::var("MAIL_HISTORY_CLEANUP_DELETE_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DELETE_BATCH_SIZE)
        .clamp(100, 50_000);
    let max_delete_batches_per_run = std::env::var("MAIL_HISTORY_CLEANUP_MAX_BATCHES_PER_RUN")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(DEFAULT_MAX_DELETE_BATCHES_PER_RUN)
        .clamp(1, 200);
    MailHistoryCleanupConfig {
        enabled,
        retention_days,
        interval_ms: interval_seconds * 1000,
        delete_batch_size,
        max_delete_batches_per_run,
    }
}

pub async fn run_mail_history_cleanup_once(state: &AppState) -> Result<MailHistoryCleanupSummary> {
    let config = load_mail_history_cleanup_config();
    if !config.enabled {
        return Ok(MailHistoryCleanupSummary::default());
    }

    let acquired = state
        .database
        .fetch_one(
            "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
            |query| {
                query
                    .bind(MAIL_HISTORY_CLEANUP_LOCK_KEY_1)
                    .bind(MAIL_HISTORY_CLEANUP_LOCK_KEY_2)
            },
        )
        .await?
        .try_get::<Option<bool>, _>("acquired")?
        .unwrap_or(false);
    if !acquired {
        return Ok(MailHistoryCleanupSummary::default());
    }

    let mut summary = MailHistoryCleanupSummary::default();
    let result = async {
        for _ in 0..config.max_delete_batches_per_run {
            let deleted_soft_rows = state
                .database
                .fetch_all(MAIL_SOFT_DELETED_CLEANUP_SQL, |query| {
                    query
                        .bind(config.retention_days)
                        .bind(config.delete_batch_size)
                })
                .await?;
            summary.deleted_soft_deleted_count += deleted_soft_rows.len();
            if deleted_soft_rows.len() as i64 >= config.delete_batch_size {
                continue;
            }

            let deleted_expired_rows = state
                .database
                .fetch_all(MAIL_EXPIRED_HISTORY_CLEANUP_SQL, |query| {
                    query
                        .bind(config.retention_days)
                        .bind(config.delete_batch_size)
                })
                .await?;
            summary.deleted_expired_count += deleted_expired_rows.len();
            if (deleted_expired_rows.len() as i64) < config.delete_batch_size {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    let _ = state
        .database
        .execute("SELECT pg_advisory_unlock($1::int, $2::int)", |query| {
            query
                .bind(MAIL_HISTORY_CLEANUP_LOCK_KEY_1)
                .bind(MAIL_HISTORY_CLEANUP_LOCK_KEY_2)
        })
        .await;

    result?;
    Ok(summary)
}

pub fn spawn_mail_history_cleanup_loop(state: AppState) {
    let config = load_mail_history_cleanup_config();
    if !config.enabled {
        return;
    }
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(config.interval_ms)).await;
            match run_mail_history_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        deleted_soft_deleted_count = summary.deleted_soft_deleted_count,
                        deleted_expired_count = summary.deleted_expired_count,
                        "mail history cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "mail history cleanup loop iteration failed");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_DELETE_BATCH_SIZE, DEFAULT_MAX_DELETE_BATCHES_PER_RUN, DEFAULT_RETENTION_DAYS,
        MailHistoryCleanupSummary, load_mail_history_cleanup_config,
    };

    #[test]
    fn mail_history_cleanup_summary_defaults_to_zero() {
        let summary = MailHistoryCleanupSummary::default();
        assert_eq!(summary.deleted_soft_deleted_count, 0);
        assert_eq!(summary.deleted_expired_count, 0);
    }

    #[test]
    fn mail_history_cleanup_config_uses_defaults() {
        let config = load_mail_history_cleanup_config();
        assert_eq!(config.retention_days, DEFAULT_RETENTION_DAYS);
        assert_eq!(config.delete_batch_size, DEFAULT_DELETE_BATCH_SIZE);
        assert_eq!(
            config.max_delete_batches_per_run,
            DEFAULT_MAX_DELETE_BATCHES_PER_RUN
        );
        println!("MAIL_HISTORY_CLEANUP_INTERVAL_MS={}", config.interval_ms);
    }
}
