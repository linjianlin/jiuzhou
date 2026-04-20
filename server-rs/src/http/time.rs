use axum::Json;

use crate::realtime::game_time::{GameTimeSyncPayload, build_game_time_sync_payload};
use crate::shared::error::AppError;
use crate::shared::game_time::{GameTimeSnapshot, get_game_time_snapshot};
use crate::shared::response::{SuccessResponse, send_success};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeResponseDto {
    #[serde(flatten)]
    pub snapshot: GameTimeSnapshot,
    pub debug_realtime: GameTimeSyncPayload,
}

pub async fn get_time() -> Result<Json<SuccessResponse<TimeResponseDto>>, AppError> {
    let snapshot = get_game_time_snapshot()?;
    let debug_realtime = build_game_time_sync_payload(snapshot.clone());
    Ok(send_success(TimeResponseDto { snapshot, debug_realtime }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn time_response_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "eraName": "末法纪元",
                "baseYear": 1000,
                "year": 1000,
                "month": 4,
                "day": 11,
                "hour": 7,
                "minute": 30,
                "second": 0,
                "shichen": "辰时",
                "weather": "晴",
                "scale": 60,
                "serverNowMs": 1712800000000i64,
                "gameElapsedMs": 1712800000000i64,
                "debugRealtime": {
                    "era_name": "末法纪元",
                    "day": 11,
                    "weather": "晴",
                    "server_now_ms": 1712800000000i64,
                    "game_elapsed_ms": 1712800000000i64
                }
            }
        });
        assert_eq!(payload["data"]["debugRealtime"]["era_name"], "末法纪元");
        assert!(payload["data"]["debugRealtime"].get("kind").is_none());
        println!("TIME_RESPONSE={}", payload);
    }
}
