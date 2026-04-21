use anyhow::Result;
use sqlx::Row;
use time::{Date, Duration};
use tokio::time::{Duration as TokioDuration, sleep};

use crate::state::AppState;

const ARENA_WEEKLY_SETTLEMENT_CHECK_INTERVAL_MS: u64 = 60_000;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .ok()
        .flatten()
        .map(i64::from)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArenaWeeklySettlementSummary {
    pub settled_week_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WeekBoundary {
    current_week_start_local_date: String,
    previous_week_start_local_date: String,
}

pub async fn run_arena_weekly_settlement_once(
    state: &AppState,
) -> Result<ArenaWeeklySettlementSummary> {
    let pending_weeks = collect_pending_week_starts(state).await?;
    let mut settled_week_count = 0_usize;
    for week_start in pending_weeks {
        let week_end = add_days_to_local_date(&week_start, 7)?;
        let top_character_ids =
            load_top_three_character_ids_for_week(state, &week_start, &week_end).await?;
        if persist_weekly_settlement(state, &week_start, &week_end, &top_character_ids).await? {
            settled_week_count += 1;
        }
    }
    Ok(ArenaWeeklySettlementSummary { settled_week_count })
}

pub fn spawn_arena_weekly_settlement_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(TokioDuration::from_millis(
                ARENA_WEEKLY_SETTLEMENT_CHECK_INTERVAL_MS,
            ))
            .await;
            match run_arena_weekly_settlement_once(&state).await {
                Ok(summary) => {
                    if summary.settled_week_count > 0 {
                        tracing::info!(
                            settled_week_count = summary.settled_week_count,
                            "arena weekly settlement loop iteration complete"
                        );
                    }
                }
                Err(error) => {
                    tracing::error!(error = %error, "arena weekly settlement loop iteration failed");
                }
            }
        }
    });
}

async fn collect_pending_week_starts(state: &AppState) -> Result<Vec<String>> {
    let boundary = get_week_boundary(state).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT MAX(week_start_local_date)::text AS last_week_start_local_date FROM arena_weekly_settlement",
            |q| q,
        )
        .await?;
    let last_settled = row.and_then(|row| {
        row.try_get::<Option<String>, _>("last_week_start_local_date")
            .ok()
            .flatten()
    });
    collect_pending_week_starts_from_inputs(
        &boundary.current_week_start_local_date,
        &boundary.previous_week_start_local_date,
        last_settled.as_deref(),
    )
}

async fn get_week_boundary(state: &AppState) -> Result<WeekBoundary> {
    let row = state
        .database
        .fetch_one(
            "SELECT date_trunc('week', timezone('Asia/Shanghai', NOW()))::date::text AS current_week_start_local_date, (date_trunc('week', timezone('Asia/Shanghai', NOW()))::date - INTERVAL '7 day')::date::text AS previous_week_start_local_date",
            |q| q,
        )
        .await?;
    Ok(WeekBoundary {
        current_week_start_local_date: row
            .try_get::<Option<String>, _>("current_week_start_local_date")?
            .unwrap_or_default(),
        previous_week_start_local_date: row
            .try_get::<Option<String>, _>("previous_week_start_local_date")?
            .unwrap_or_default(),
    })
}

fn collect_pending_week_starts_from_inputs(
    current_week_start_local_date: &str,
    previous_week_start_local_date: &str,
    last_settled_week_start_local_date: Option<&str>,
) -> Result<Vec<String>> {
    let first_pending_week = if let Some(last) =
        last_settled_week_start_local_date.filter(|value| !value.trim().is_empty())
    {
        add_days_to_local_date(last, 7)?
    } else {
        previous_week_start_local_date.trim().to_string()
    };
    let mut out = Vec::new();
    let mut cursor = first_pending_week;
    while !cursor.is_empty() && cursor.as_str() < current_week_start_local_date.trim() {
        out.push(cursor.clone());
        cursor = add_days_to_local_date(&cursor, 7)?;
    }
    Ok(out)
}

async fn load_top_three_character_ids_for_week(
    state: &AppState,
    week_start_local_date: &str,
    week_end_local_date: &str,
) -> Result<Vec<i64>> {
    let rows = state
        .database
        .fetch_all(
            "WITH weekly_participants AS ( SELECT ab.challenger_character_id AS character_id FROM arena_battle ab WHERE ab.status = 'finished' AND ab.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND ab.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') UNION SELECT ab.opponent_character_id AS character_id FROM arena_battle ab WHERE ab.status = 'finished' AND ab.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND ab.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') ) SELECT wp.character_id FROM weekly_participants wp LEFT JOIN arena_rating ar ON ar.character_id = wp.character_id ORDER BY COALESCE(ar.rating, 1000) DESC, COALESCE(ar.win_count, 0) DESC, COALESCE(ar.lose_count, 0) ASC, wp.character_id ASC LIMIT 3",
            |q| q.bind(week_start_local_date).bind(week_end_local_date),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| opt_i64_from_i32(&row, "character_id"))
        .filter(|id| *id > 0)
        .collect())
}

async fn persist_weekly_settlement(
    state: &AppState,
    week_start_local_date: &str,
    week_end_local_date: &str,
    top_character_ids: &[i64],
) -> Result<bool> {
    let champion = top_character_ids.first().copied();
    let runnerup = top_character_ids.get(1).copied();
    let third = top_character_ids.get(2).copied();
    let inserted = state
        .database
        .fetch_optional(
            "INSERT INTO arena_weekly_settlement (week_start_local_date, week_end_local_date, window_start_at, window_end_at, champion_character_id, runnerup_character_id, third_character_id, settled_at, updated_at) VALUES ($1::date, $2::date, ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai'), ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai'), $3, $4, $5, NOW(), NOW()) ON CONFLICT (week_start_local_date) DO NOTHING RETURNING week_start_local_date::text AS week_start_local_date_text",
            |q| q.bind(week_start_local_date).bind(week_end_local_date).bind(champion).bind(runnerup).bind(third),
        )
        .await?;
    Ok(inserted.is_some())
}

fn add_days_to_local_date(local_date: &str, days: i64) -> Result<String> {
    let date = Date::parse(
        local_date,
        &time::format_description::well_known::Iso8601::DATE,
    )
    .map_err(anyhow::Error::from)?;
    Ok(date.saturating_add(Duration::days(days)).to_string())
}

#[cfg(test)]
mod tests {
    use super::{ArenaWeeklySettlementSummary, collect_pending_week_starts_from_inputs};

    #[test]
    fn arena_weekly_settlement_summary_defaults_to_zero() {
        let summary = ArenaWeeklySettlementSummary::default();
        assert_eq!(summary.settled_week_count, 0);
    }

    #[test]
    fn collect_pending_week_starts_starts_from_previous_week_when_empty() {
        let weeks = collect_pending_week_starts_from_inputs("2026-04-27", "2026-04-20", None)
            .expect("pending weeks should collect");
        assert_eq!(weeks, vec!["2026-04-20".to_string()]);
    }

    #[test]
    fn collect_pending_week_starts_advances_in_seven_day_steps() {
        let weeks =
            collect_pending_week_starts_from_inputs("2026-05-11", "2026-05-04", Some("2026-04-20"))
                .expect("pending weeks should collect");
        assert_eq!(
            weeks,
            vec!["2026-04-27".to_string(), "2026-05-04".to_string()]
        );
    }
}
