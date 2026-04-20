use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementUpdatePayload {
    pub kind: String,
    pub source: String,
    pub achievement_id: Option<String>,
    pub threshold: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementIndicatorPayload {
    pub character_id: i64,
    pub claimable_count: i64,
}

pub fn build_achievement_update_payload(
    source: &str,
    achievement_id: Option<&str>,
    threshold: Option<i64>,
) -> AchievementUpdatePayload {
    AchievementUpdatePayload {
        kind: "achievement:update".to_string(),
        source: source.to_string(),
        achievement_id: achievement_id.map(|value| value.to_string()),
        threshold,
    }
}

pub fn build_achievement_indicator_payload(
    character_id: i64,
    claimable_count: i64,
) -> AchievementIndicatorPayload {
    AchievementIndicatorPayload {
        character_id,
        claimable_count: claimable_count.max(0),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_achievement_indicator_payload, build_achievement_update_payload};

    #[test]
    fn achievement_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_achievement_update_payload(
            "claim_achievement",
            Some("ach-rabbit-001"),
            None,
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "achievement:update");
        assert_eq!(payload["achievementId"], "ach-rabbit-001");
        println!("ACHIEVEMENT_REALTIME_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn achievement_indicator_payload_matches_socket_contract() {
        let payload = serde_json::to_value(build_achievement_indicator_payload(101, 3))
            .expect("payload should serialize");
        assert_eq!(payload["characterId"], 101);
        assert_eq!(payload["claimableCount"], 3);
        println!("ACHIEVEMENT_SOCKET_UPDATE_RESPONSE={}", payload);
    }
}
