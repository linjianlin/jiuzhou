use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketUpdatePayload {
    pub kind: String,
    pub source: String,
    pub listing_id: Option<i64>,
    pub market_type: String,
}

pub fn build_market_update_payload(
    source: &str,
    listing_id: Option<i64>,
    market_type: &str,
) -> MarketUpdatePayload {
    MarketUpdatePayload {
        kind: "market:update".to_string(),
        source: source.to_string(),
        listing_id,
        market_type: market_type.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::build_market_update_payload;

    #[test]
    fn market_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_market_update_payload(
            "buy_market_listing",
            Some(1),
            "item",
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "market:update");
        assert_eq!(payload["marketType"], "item");
        println!("MARKET_REALTIME_UPDATE_RESPONSE={}", payload);
    }
}
