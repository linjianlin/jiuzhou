use serde::Serialize;

use crate::http::arena::ArenaStatusDto;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaStatusPayload {
    pub kind: String,
    pub status: ArenaStatusDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRefreshPayload {
    pub kind: String,
}

pub fn build_arena_status_payload(status: ArenaStatusDto) -> ArenaStatusPayload {
    ArenaStatusPayload {
        kind: "arena_status".to_string(),
        status,
    }
}

pub fn build_arena_refresh_payload() -> ArenaRefreshPayload {
    ArenaRefreshPayload {
        kind: "arena_refresh".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_arena_refresh_payload, build_arena_status_payload};
    use crate::http::arena::ArenaStatusDto;

    #[test]
    fn arena_status_socket_payload_matches_contract() {
        let payload = serde_json::to_value(build_arena_status_payload(ArenaStatusDto {
            score: 1200,
            win_count: 12,
            lose_count: 3,
            today_used: 2,
            today_limit: 5,
            today_remaining: 3,
        }))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "arena_status");
        assert_eq!(payload["status"]["score"], 1200);
        println!("ARENA_SOCKET_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn arena_refresh_socket_payload_matches_contract() {
        let payload =
            serde_json::to_value(build_arena_refresh_payload()).expect("payload should serialize");
        assert_eq!(payload["kind"], "arena_refresh");
        println!("ARENA_SOCKET_REFRESH_RESPONSE={}", payload);
    }
}
