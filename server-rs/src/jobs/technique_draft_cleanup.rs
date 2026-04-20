use anyhow::Result;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::shared::mail_counter::{apply_mail_counter_deltas, build_new_mail_counter_deltas};
use crate::state::AppState;

const TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_1: i64 = 2026;
const TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_2: i64 = 401;
const TECHNIQUE_DRAFT_CLEANUP_INTERVAL_MS: u64 = 10 * 60 * 1000;
const TECHNIQUE_DRAFT_EXPIRED_MESSAGE: &str = "草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟";
const TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE: f64 = 0.5;
const TECHNIQUE_FRAGMENT_ITEM_DEF_ID: &str = "mat-gongfa-canye";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TechniqueDraftCleanupSummary {
    pub refunded_draft_count: usize,
}

pub async fn run_technique_draft_cleanup_once(
    state: &AppState,
) -> Result<TechniqueDraftCleanupSummary> {
    let acquired = state
        .database
        .fetch_one(
            "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
            |query| query.bind(TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_1).bind(TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_2),
        )
        .await?
        .try_get::<Option<bool>, _>("acquired")?
        .unwrap_or(false);
    if !acquired {
        return Ok(TechniqueDraftCleanupSummary::default());
    }

    let mut refunded_draft_count = 0_usize;
    let result = async {
        let rows = state
            .database
            .fetch_all(
                "SELECT j.id, j.character_id, j.cost_points, c.user_id FROM technique_generation_job j JOIN characters c ON c.id = j.character_id WHERE j.status = 'generated_draft' AND j.draft_expire_at IS NOT NULL AND j.draft_expire_at <= NOW() FOR UPDATE",
                |query| query,
            )
            .await?;
        for row in rows {
            let generation_id = row.try_get::<String, _>("id")?;
            let character_id = i64::from(row.try_get::<i32, _>("character_id")?);
            let user_id = i64::from(row.try_get::<i32, _>("user_id")?);
            let cost_points = row
                .try_get::<Option<i32>, _>("cost_points")?
                .map(i64::from)
                .unwrap_or_default()
                .max(0);
            let refund_fragments = ((cost_points as f64) * TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE).floor() as i64;
            if refund_fragments > 0 {
                state.database.execute(
                    "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_items, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '功法残页返还', $3, $4::jsonb, 'technique_generation', $5, '{}'::jsonb, NOW(), NOW())",
                    |query| query
                        .bind(user_id)
                        .bind(character_id)
                        .bind(TECHNIQUE_DRAFT_EXPIRED_MESSAGE)
                        .bind(serde_json::json!([{ "item_def_id": TECHNIQUE_FRAGMENT_ITEM_DEF_ID, "qty": refund_fragments }]))
                        .bind(&generation_id),
                ).await?;
                apply_mail_counter_deltas(
                    state,
                    &build_new_mail_counter_deltas(user_id, Some(character_id), true),
                )
                .await?;
            }
            state.database.execute(
                "UPDATE technique_generation_job SET status = 'refunded', error_code = 'GENERATION_EXPIRED', error_message = $2, finished_at = COALESCE(finished_at, NOW()), failed_viewed_at = NULL, updated_at = NOW() WHERE id = $1",
                |query| query.bind(&generation_id).bind(TECHNIQUE_DRAFT_EXPIRED_MESSAGE),
            ).await?;
            refunded_draft_count += 1;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    let _ = state
        .database
        .execute(
                "SELECT pg_advisory_unlock($1::int, $2::int)",
            |query| query.bind(TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_1).bind(TECHNIQUE_DRAFT_CLEANUP_LOCK_KEY_2),
        )
        .await;

    result?;
    Ok(TechniqueDraftCleanupSummary { refunded_draft_count })
}

pub fn spawn_technique_draft_cleanup_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(TECHNIQUE_DRAFT_CLEANUP_INTERVAL_MS)).await;
            match run_technique_draft_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        refunded_draft_count = summary.refunded_draft_count,
                        "technique draft cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "technique draft cleanup loop iteration failed");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{TECHNIQUE_DRAFT_EXPIRED_MESSAGE, TechniqueDraftCleanupSummary};

    #[test]
    fn technique_draft_cleanup_summary_defaults_to_zero() {
        assert_eq!(
            TechniqueDraftCleanupSummary::default(),
            TechniqueDraftCleanupSummary {
                refunded_draft_count: 0,
            }
        );
        assert!(TECHNIQUE_DRAFT_EXPIRED_MESSAGE.contains("草稿已过期"));
    }
}
