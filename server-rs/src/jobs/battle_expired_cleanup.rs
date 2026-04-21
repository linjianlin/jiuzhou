use anyhow::Result;
use tokio::time::{Duration, sleep};

use crate::integrations::battle_persistence::clear_battle_persistence;
use crate::state::AppState;

pub const BATTLE_EXPIRED_CLEANUP_INTERVAL_MS: u64 = 5 * 60 * 1000;
const BATTLE_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const MIN_UNIX_MS: i64 = 1_000_000_000_000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BattleExpiredCleanupSummary {
    pub expired_battle_count: usize,
}

pub async fn run_battle_expired_cleanup_once(
    state: &AppState,
) -> Result<BattleExpiredCleanupSummary> {
    let now_ms = current_timestamp_ms();
    let projections = state.online_battle_projections.snapshot();
    let mut expired_battle_count = 0_usize;

    for projection in projections {
        let Some(battle_time_ms) = parse_battle_timestamp_ms(&projection.battle_id) else {
            continue;
        };
        if now_ms - battle_time_ms <= BATTLE_MAX_AGE_MS {
            continue;
        }
        state.battle_runtime.clear(&projection.battle_id);
        state.online_battle_projections.clear(&projection.battle_id);
        if let Some(session_id) = projection.session_id.as_deref() {
            let _ = state.battle_sessions.update(session_id, |record| {
                if record.current_battle_id.as_deref() == Some(projection.battle_id.as_str()) {
                    record.current_battle_id = None;
                }
            });
            clear_battle_persistence(state, &projection.battle_id, Some(session_id)).await?;
        } else {
            clear_battle_persistence(state, &projection.battle_id, None).await?;
        }
        expired_battle_count += 1;
    }

    Ok(BattleExpiredCleanupSummary {
        expired_battle_count,
    })
}

pub fn spawn_battle_expired_cleanup_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_millis(BATTLE_EXPIRED_CLEANUP_INTERVAL_MS)).await;
            match run_battle_expired_cleanup_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        expired_battle_count = summary.expired_battle_count,
                        "battle expired cleanup loop iteration complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "battle expired cleanup loop iteration failed");
                }
            }
        }
    });
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn parse_battle_timestamp_ms(battle_id: &str) -> Option<i64> {
    battle_id
        .split('-')
        .rev()
        .filter_map(|segment| segment.parse::<i64>().ok())
        .find(|value| *value >= MIN_UNIX_MS)
}

#[cfg(test)]
mod tests {
    use super::{BATTLE_MAX_AGE_MS, BattleExpiredCleanupSummary, parse_battle_timestamp_ms};

    #[test]
    fn battle_expired_cleanup_summary_defaults_to_zero() {
        assert_eq!(
            BattleExpiredCleanupSummary::default(),
            BattleExpiredCleanupSummary {
                expired_battle_count: 0,
            }
        );
    }

    #[test]
    fn battle_timestamp_parser_only_accepts_unix_ms_suffixes() {
        assert_eq!(
            parse_battle_timestamp_ms("pve-battle-12-1713000000000"),
            Some(1713000000000)
        );
        assert_eq!(parse_battle_timestamp_ms("dungeon-battle-inst-3-1"), None);
        assert_eq!(parse_battle_timestamp_ms("tower-battle-run-14"), None);
        println!("BATTLE_EXPIRED_MAX_AGE_MS={BATTLE_MAX_AGE_MS}");
    }
}
