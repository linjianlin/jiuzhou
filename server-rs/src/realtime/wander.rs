use serde::Serialize;

use crate::http::wander::WanderOverviewDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderUpdatePayload {
    pub overview: WanderOverviewDto,
}

pub fn build_wander_update_payload(overview: WanderOverviewDto) -> WanderUpdatePayload {
    WanderUpdatePayload { overview }
}

#[cfg(test)]
mod tests {
    use super::build_wander_update_payload;
    use crate::http::wander::WanderOverviewDto;

    #[test]
    fn wander_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_wander_update_payload(WanderOverviewDto {
            today: "2026-04-13".to_string(),
            ai_available: true,
            has_pending_episode: false,
            is_resolving_episode: false,
            can_generate: true,
            is_cooling_down: false,
            cooldown_until: None,
            cooldown_remaining_seconds: 0,
            current_generation_job: None,
            active_story: None,
            current_episode: None,
            latest_finished_story: None,
            generated_titles: vec![],
        }))
        .expect("payload should serialize");
        assert_eq!(payload["overview"]["today"], "2026-04-13");
        assert_eq!(payload["overview"]["canGenerate"], true);
        println!("WANDER_SOCKET_UPDATE_RESPONSE={}", payload);
    }
}
