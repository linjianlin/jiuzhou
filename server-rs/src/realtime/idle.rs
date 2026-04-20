use serde::Serialize;

use crate::http::idle::IdleSessionDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleRealtimePayload {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_gained: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silver_gained: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items_gained: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn build_idle_update_batch_payload(
    session_id: impl Into<String>,
    batch_index: i64,
    result: impl Into<String>,
    exp_gained: i64,
    silver_gained: i64,
    items_gained: Vec<serde_json::Value>,
    round_count: i64,
) -> IdleRealtimePayload {
    IdleRealtimePayload {
        kind: "idle:update".to_string(),
        session_id: Some(session_id.into()),
        batch_index: Some(batch_index),
        result: Some(result.into()),
        exp_gained: Some(exp_gained.max(0)),
        silver_gained: Some(silver_gained.max(0)),
        items_gained: Some(items_gained),
        round_count: Some(round_count.max(0)),
        reason: None,
    }
}

pub fn build_idle_update_payload(session: IdleSessionDto) -> IdleRealtimePayload {
    build_idle_update_batch_payload(
        session.id,
        session.total_battles,
        "draw",
        0,
        0,
        Vec::new(),
        0,
    )
}

pub fn build_idle_finished_payload(session: IdleSessionDto) -> IdleRealtimePayload {
    IdleRealtimePayload {
        kind: "idle:finished".to_string(),
        session_id: Some(session.id),
        batch_index: None,
        result: None,
        exp_gained: None,
        silver_gained: None,
        items_gained: None,
        round_count: None,
        reason: Some(match session.status.as_str() {
            "completed" => "completed".to_string(),
            "interrupted" => "interrupted".to_string(),
            other => other.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use crate::http::idle::IdleSessionDto;

    use super::{
        build_idle_finished_payload, build_idle_update_batch_payload, build_idle_update_payload,
    };

    fn sample_session(status: &str) -> IdleSessionDto {
        IdleSessionDto {
            id: "idle-1".to_string(),
            character_id: 1,
            status: status.to_string(),
            map_id: "map-qingyun-outskirts".to_string(),
            room_id: "room-south-forest".to_string(),
            max_duration_ms: 3_600_000,
            total_battles: 12,
            win_count: 10,
            lose_count: 2,
            total_exp: 1234,
            total_silver: 567,
            bag_full_flag: false,
            started_at: "2026-04-11T12:00:00Z".to_string(),
            ended_at: Some("2026-04-11T13:00:00Z".to_string()),
            viewed_at: None,
            target_monster_def_id: Some("monster-gray-wolf".to_string()),
            target_monster_name: Some("灰狼".to_string()),
            execution_snapshot: None,
            raw_snapshot: serde_json::json!({}),
            buffered_batch_deltas: Vec::new(),
            buffered_since_ms: None,
        }
    }

    #[test]
    fn idle_update_payload_matches_contract() {
        let payload = serde_json::to_value(build_idle_update_payload(sample_session("active")))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "idle:update");
        assert_eq!(payload["sessionId"], "idle-1");
        assert_eq!(payload["batchIndex"], 12);
        println!("IDLE_REALTIME_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn idle_finished_payload_matches_contract() {
        let payload =
            serde_json::to_value(build_idle_finished_payload(sample_session("completed")))
                .expect("payload should serialize");
        assert_eq!(payload["kind"], "idle:finished");
        assert_eq!(payload["sessionId"], "idle-1");
        assert_eq!(payload["reason"], "completed");
        println!("IDLE_REALTIME_FINISHED_RESPONSE={}", payload);
    }

    #[test]
    fn idle_update_batch_payload_preserves_non_zero_batch_fields() {
        let payload = serde_json::to_value(build_idle_update_batch_payload(
            "idle-2",
            4,
            "attacker_win",
            12,
            6,
            Vec::new(),
            3,
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "idle:update");
        assert_eq!(payload["result"], "attacker_win");
        assert_eq!(payload["expGained"], 12);
        assert_eq!(payload["silverGained"], 6);
        assert_eq!(payload["roundCount"], 3);
    }
}
