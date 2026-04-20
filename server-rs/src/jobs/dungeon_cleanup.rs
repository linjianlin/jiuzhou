use std::collections::BTreeSet;

use anyhow::Result;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::jobs::online_battle_settlement::ensure_online_battle_settlement_schema;
use crate::state::AppState;

const PREPARING_DUNGEON_EXPIRE_HOURS: i64 = 6;
const RUNNING_DUNGEON_EXPIRE_HOURS: i64 = 24;
const DUNGEON_CLEANUP_INTERVAL_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DungeonExpiredInstanceCleanupSummary {
    pub protected_instance_count: usize,
    pub abandoned_preparing_count: usize,
    pub abandoned_running_count: usize,
}

pub async fn run_dungeon_expired_instance_cleanup_once(
    state: &AppState,
) -> Result<DungeonExpiredInstanceCleanupSummary> {
    let protected_instance_ids = load_protected_dungeon_instance_ids(state).await?;
    let protected_instance_ids = protected_instance_ids.into_iter().collect::<Vec<_>>();
    let abandoned_preparing_count = abandon_expired_dungeon_instances(
        state,
        "preparing",
        PREPARING_DUNGEON_EXPIRE_HOURS,
        &protected_instance_ids,
    )
    .await?;
    let abandoned_running_count = abandon_expired_dungeon_instances(
        state,
        "running",
        RUNNING_DUNGEON_EXPIRE_HOURS,
        &protected_instance_ids,
    )
    .await?;
    Ok(DungeonExpiredInstanceCleanupSummary {
        protected_instance_count: protected_instance_ids.len(),
        abandoned_preparing_count,
        abandoned_running_count,
    })
}

pub fn spawn_dungeon_expired_instance_cleanup_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(DUNGEON_CLEANUP_INTERVAL_MS)).await;
            match run_dungeon_expired_instance_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        protected_instance_count = summary.protected_instance_count,
                        abandoned_preparing_count = summary.abandoned_preparing_count,
                        abandoned_running_count = summary.abandoned_running_count,
                        "expired dungeon instance cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "expired dungeon instance cleanup loop iteration failed");
                }
            }
        }
    });
}

async fn load_protected_dungeon_instance_ids(
    state: &AppState,
) -> Result<BTreeSet<String>> {
    ensure_online_battle_settlement_schema(state).await?;
    let rows = state
        .database
        .fetch_all(
            "SELECT payload ->> 'instanceId' AS instance_id FROM online_battle_settlement_task WHERE kind = 'dungeon_clear_v1' AND status <> 'completed'",
            |q| q,
        )
        .await?;
    let mut out = BTreeSet::new();
    for row in rows {
        let instance_id: Option<String> = row.try_get("instance_id")?;
        if let Some(instance_id) = instance_id.filter(|instance_id| !instance_id.trim().is_empty()) {
            out.insert(instance_id);
        }
    }
    Ok(out)
}

async fn abandon_expired_dungeon_instances(
    state: &AppState,
    status: &str,
    expire_hours: i64,
    protected_instance_ids: &[String],
) -> Result<usize> {
    let rows = state
        .database
        .fetch_all(
            "WITH stale_instance AS ( SELECT id FROM dungeon_instance WHERE status = $1 AND COALESCE(start_time, created_at) < NOW() - (($2::text || ' hours')::interval) AND NOT (id = ANY($3::varchar[])) ORDER BY COALESCE(start_time, created_at) ASC, id ASC LIMIT 2000 ), updated AS ( UPDATE dungeon_instance di SET status = 'abandoned', end_time = COALESCE(end_time, NOW()), instance_data = (COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId') - 'startResourceTaskId' FROM stale_instance si WHERE di.id = si.id RETURNING di.id ) SELECT id FROM updated",
            |q| q.bind(status).bind(expire_hours).bind(protected_instance_ids),
        )
        .await?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::DungeonExpiredInstanceCleanupSummary;

    #[test]
    fn dungeon_cleanup_summary_defaults_to_zero() {
        let summary = DungeonExpiredInstanceCleanupSummary::default();
        assert_eq!(summary.protected_instance_count, 0);
        assert_eq!(summary.abandoned_preparing_count, 0);
        assert_eq!(summary.abandoned_running_count, 0);
    }
}
