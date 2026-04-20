use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerUpdatePayload {
    pub kind: String,
    pub source: String,
    pub generation_id: Option<String>,
    pub fusion_id: Option<String>,
    pub rebone_id: Option<String>,
    pub partner_id: Option<i64>,
}

pub fn build_partner_update_payload(
    source: &str,
    generation_id: Option<&str>,
    fusion_id: Option<&str>,
    rebone_id: Option<&str>,
    partner_id: Option<i64>,
) -> PartnerUpdatePayload {
    PartnerUpdatePayload {
        kind: "partner:update".to_string(),
        source: source.to_string(),
        generation_id: generation_id.map(|value| value.to_string()),
        fusion_id: fusion_id.map(|value| value.to_string()),
        rebone_id: rebone_id.map(|value| value.to_string()),
        partner_id,
    }
}

#[cfg(test)]
mod tests {
    use super::build_partner_update_payload;

    #[test]
    fn partner_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_partner_update_payload(
            "partner_recruit_confirm",
            Some("partner-recruit-1"),
            None,
            None,
            Some(101),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "partner:update");
        assert_eq!(payload["partnerId"], 101);
        println!("PARTNER_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
