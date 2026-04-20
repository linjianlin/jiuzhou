use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamUpdatePayload {
    pub kind: String,
    pub source: String,
    pub team_id: Option<String>,
    pub message: Option<String>,
}

pub fn build_team_update_payload(
    source: &str,
    team_id: Option<&str>,
    message: Option<&str>,
) -> TeamUpdatePayload {
    TeamUpdatePayload {
        kind: "team:update".to_string(),
        source: source.to_string(),
        team_id: team_id.map(|value| value.to_string()),
        message: message.map(|value| value.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::build_team_update_payload;

    #[test]
    fn team_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_team_update_payload(
            "create_team",
            Some("team-1"),
            Some("队伍创建成功"),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "team:update");
        assert_eq!(payload["teamId"], "team-1");
        println!("TEAM_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
