use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankUpdatePayload {
    pub kind: String,
    pub source: String,
    pub domains: Vec<String>,
}

pub fn build_rank_update_payload(source: &str, domains: &[&str]) -> RankUpdatePayload {
    RankUpdatePayload {
        kind: "rank:update".to_string(),
        source: source.to_string(),
        domains: domains.iter().map(|value| value.to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_rank_update_payload;

    #[test]
    fn rank_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_rank_update_payload(
            "breakthrough",
            &["realm", "power"],
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "rank:update");
        assert_eq!(payload["domains"][0], "realm");
        println!("RANK_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
