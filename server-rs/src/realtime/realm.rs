use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmUpdatePayload {
    pub kind: String,
    pub source: String,
    pub from_realm: String,
    pub new_realm: String,
}

pub fn build_realm_update_payload(
    source: &str,
    from_realm: &str,
    new_realm: &str,
) -> RealmUpdatePayload {
    RealmUpdatePayload {
        kind: "realm:update".to_string(),
        source: source.to_string(),
        from_realm: from_realm.to_string(),
        new_realm: new_realm.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_realm_update_payload;

    #[test]
    fn realm_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_realm_update_payload(
            "breakthrough",
            "凡人",
            "炼精化炁·养气期",
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "realm:update");
        assert_eq!(payload["newRealm"], "炼精化炁·养气期");
        println!("REALM_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
