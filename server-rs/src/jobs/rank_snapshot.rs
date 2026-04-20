use anyhow::Result;
use time::{Duration, OffsetDateTime, UtcOffset};
use tokio::time::{Duration as TokioDuration, sleep};

use crate::state::AppState;

const RANK_SNAPSHOT_NIGHTLY_HOUR_CN: i64 = 4;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RankSnapshotRefreshSummary {
    pub character_snapshot_count: usize,
    pub partner_snapshot_count: usize,
}

pub async fn refresh_all_rank_snapshots_once(
    state: &AppState,
) -> Result<RankSnapshotRefreshSummary> {
    let character_snapshot_count = refresh_character_rank_snapshots(state).await?;
    let partner_snapshot_count = refresh_partner_rank_snapshots(state).await?;
    Ok(RankSnapshotRefreshSummary {
        character_snapshot_count,
        partner_snapshot_count,
    })
}

pub fn spawn_rank_snapshot_nightly_refresh_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            let delay = duration_until_next_rank_snapshot_refresh();
            sleep(delay).await;
            match refresh_all_rank_snapshots_once(&state).await {
                Ok(summary) => {
                    tracing::info!(
                        character_snapshot_count = summary.character_snapshot_count,
                        partner_snapshot_count = summary.partner_snapshot_count,
                        "rank snapshot nightly refresh complete"
                    );
                }
                Err(error) => {
                    tracing::error!(error = %error, "rank snapshot nightly refresh failed");
                }
            }
        }
    });
}

async fn refresh_character_rank_snapshots(state: &AppState) -> Result<usize> {
    let rows = state.database.fetch_all(
        "INSERT INTO character_rank_snapshot (character_id, nickname, realm, realm_rank, power, wugong, fagong, wufang, fafang, max_qixue, max_lingqi, sudu, updated_at, created_at) SELECT c.id, COALESCE(c.nickname, ''), COALESCE(NULLIF(TRIM(CONCAT(COALESCE(c.realm, ''), CASE WHEN COALESCE(c.sub_realm, '') = '' THEN '' ELSE CONCAT('·', c.sub_realm) END)), ''), '凡人'), CASE COALESCE(c.realm, '凡人') WHEN '凡人' THEN 0 WHEN '炼精化炁' THEN 1 WHEN '炼炁化神' THEN 2 WHEN '炼神返虚' THEN 3 WHEN '炼虚合道' THEN 4 WHEN '大乘' THEN 5 ELSE 0 END, GREATEST(0, COALESCE(c.jing, 0) / 2 + COALESCE(c.qi, 0) / 2), 0, 0, 0, 0, COALESCE(c.jing, 0), COALESCE(c.qi, 0), 0, NOW(), COALESCE(crs.created_at, NOW()) FROM characters c LEFT JOIN character_rank_snapshot crs ON crs.character_id = c.id ON CONFLICT (character_id) DO UPDATE SET nickname = EXCLUDED.nickname, realm = EXCLUDED.realm, realm_rank = EXCLUDED.realm_rank, power = EXCLUDED.power, wugong = EXCLUDED.wugong, fagong = EXCLUDED.fagong, wufang = EXCLUDED.wufang, fafang = EXCLUDED.fafang, max_qixue = EXCLUDED.max_qixue, max_lingqi = EXCLUDED.max_lingqi, sudu = EXCLUDED.sudu, updated_at = NOW() RETURNING character_id",
        |q| q,
    ).await?;
    Ok(rows.len())
}

async fn refresh_partner_rank_snapshots(state: &AppState) -> Result<usize> {
    let rows = state.database.fetch_all(
        "INSERT INTO partner_rank_snapshot (partner_id, character_id, partner_name, avatar, quality, element, role, level, power, updated_at, created_at) SELECT cp.id, cp.character_id, COALESCE(NULLIF(cp.nickname, ''), '伙伴'), cp.avatar, COALESCE(gpd.quality, '黄'), COALESCE(gpd.attribute_element, 'none'), COALESCE(gpd.role, '伙伴'), COALESCE(cp.level, 1), GREATEST(0, COALESCE(cp.growth_wugong, 0) + COALESCE(cp.growth_fagong, 0) + COALESCE(cp.growth_wufang, 0) + COALESCE(cp.growth_fafang, 0) + COALESCE(cp.growth_max_qixue, 0) / 2 + COALESCE(cp.growth_sudu, 0) * 8 + COALESCE(cp.level, 1) * 10), NOW(), COALESCE(prs.created_at, NOW()) FROM character_partner cp LEFT JOIN generated_partner_def gpd ON gpd.id = cp.partner_def_id LEFT JOIN partner_rank_snapshot prs ON prs.partner_id = cp.id ON CONFLICT (partner_id) DO UPDATE SET character_id = EXCLUDED.character_id, partner_name = EXCLUDED.partner_name, avatar = EXCLUDED.avatar, quality = EXCLUDED.quality, element = EXCLUDED.element, role = EXCLUDED.role, level = EXCLUDED.level, power = EXCLUDED.power, updated_at = NOW() RETURNING partner_id",
        |q| q,
    ).await?;
    Ok(rows.len())
}

fn duration_until_next_rank_snapshot_refresh() -> TokioDuration {
    let now = OffsetDateTime::now_utc().to_offset(UtcOffset::from_hms(8, 0, 0).expect("+8 offset should exist"));
    let current_day = now.date();
    let scheduled_today = current_day.with_hms(RANK_SNAPSHOT_NIGHTLY_HOUR_CN as u8, 0, 0).expect("valid rank snapshot time").assume_offset(now.offset());
    let next_run = if now < scheduled_today {
        scheduled_today
    } else {
        current_day
            .saturating_add(Duration::days(1))
            .with_hms(RANK_SNAPSHOT_NIGHTLY_HOUR_CN as u8, 0, 0)
            .expect("valid next rank snapshot time")
            .assume_offset(now.offset())
    };
    let millis = (next_run - now).whole_milliseconds().max(1) as u64;
    TokioDuration::from_millis(millis)
}

#[cfg(test)]
mod tests {
    use super::{RankSnapshotRefreshSummary, duration_until_next_rank_snapshot_refresh};

    #[test]
    fn rank_snapshot_refresh_summary_defaults_to_zero() {
        let summary = RankSnapshotRefreshSummary::default();
        assert_eq!(summary.character_snapshot_count, 0);
        assert_eq!(summary.partner_snapshot_count, 0);
    }

    #[test]
    fn rank_snapshot_refresh_delay_is_positive() {
        assert!(duration_until_next_rank_snapshot_refresh().as_millis() > 0);
    }
}
