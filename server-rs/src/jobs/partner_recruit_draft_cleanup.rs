use anyhow::Result;
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::state::AppState;

const PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_1: i64 = 2026;
const PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_2: i64 = 402;
const PARTNER_RECRUIT_DRAFT_EXPIRE_HOURS: i64 = 24;
const PARTNER_RECRUIT_DRAFT_CLEANUP_INTERVAL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartnerRecruitDraftCleanupSummary {
    pub discarded_draft_count: usize,
}

pub async fn run_partner_recruit_draft_cleanup_once(
    state: &AppState,
) -> Result<PartnerRecruitDraftCleanupSummary> {
    let acquired = state
        .database
        .fetch_one(
            "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
            |query| {
                query
                    .bind(PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_1)
                    .bind(PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_2)
            },
        )
        .await?
        .try_get::<Option<bool>, _>("acquired")?
        .unwrap_or(false);
    if !acquired {
        return Ok(PartnerRecruitDraftCleanupSummary::default());
    }

    let rows = state
        .database
        .fetch_all(
            "UPDATE partner_recruit_job SET status = 'discarded', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE status = 'generated_draft' AND finished_at IS NOT NULL AND finished_at <= NOW() - (($1::text || ' hours')::interval) RETURNING id",
            |query| query.bind(PARTNER_RECRUIT_DRAFT_EXPIRE_HOURS),
        )
        .await;

    let _ = state
        .database
        .execute("SELECT pg_advisory_unlock($1::int, $2::int)", |query| {
            query
                .bind(PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_1)
                .bind(PARTNER_RECRUIT_DRAFT_CLEANUP_LOCK_KEY_2)
        })
        .await;

    Ok(PartnerRecruitDraftCleanupSummary {
        discarded_draft_count: rows?.len(),
    })
}

pub fn spawn_partner_recruit_draft_cleanup_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(
                PARTNER_RECRUIT_DRAFT_CLEANUP_INTERVAL_MS,
            ))
            .await;
            match run_partner_recruit_draft_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        discarded_draft_count = summary.discarded_draft_count,
                        "partner recruit draft cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "partner recruit draft cleanup loop iteration failed");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{PARTNER_RECRUIT_DRAFT_EXPIRE_HOURS, PartnerRecruitDraftCleanupSummary};

    #[test]
    fn partner_recruit_draft_cleanup_summary_defaults_to_zero() {
        assert_eq!(
            PartnerRecruitDraftCleanupSummary::default(),
            PartnerRecruitDraftCleanupSummary {
                discarded_draft_count: 0
            }
        );
        assert_eq!(PARTNER_RECRUIT_DRAFT_EXPIRE_HOURS, 24);
    }
}
