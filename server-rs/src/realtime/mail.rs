use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailUpdatePayload {
    pub kind: String,
    pub unread_count: i64,
    pub unclaimed_count: i64,
    pub source: String,
}

pub fn build_mail_update_payload(
    unread_count: i64,
    unclaimed_count: i64,
    source: &str,
) -> MailUpdatePayload {
    MailUpdatePayload {
        kind: "mail:update".to_string(),
        unread_count,
        unclaimed_count,
        source: source.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_mail_update_payload;

    #[test]
    fn mail_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_mail_update_payload(3, 1, "claim_mail"))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "mail:update");
        assert_eq!(payload["source"], "claim_mail");
        println!("MAIL_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
