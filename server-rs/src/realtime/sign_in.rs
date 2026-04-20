use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInUpdatePayload {
    pub kind: String,
    pub date: String,
    pub reward: i64,
    pub spirit_stones: i64,
}

pub fn build_sign_in_update_payload(
    date: &str,
    reward: i64,
    spirit_stones: i64,
) -> SignInUpdatePayload {
    SignInUpdatePayload {
        kind: "sign-in:update".to_string(),
        date: date.to_string(),
        reward,
        spirit_stones,
    }
}

#[cfg(test)]
mod tests {
    use super::build_sign_in_update_payload;

    #[test]
    fn sign_in_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_sign_in_update_payload("2026-04-11", 1600, 2600))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "sign-in:update");
        assert_eq!(payload["reward"], 1600);
        println!("SIGN_IN_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
