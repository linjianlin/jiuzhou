use serde::Serialize;

use crate::shared::game_time::GameTimeSnapshot;

#[derive(Debug, Clone, Serialize)]
pub struct GameTimeSyncPayload {
    pub era_name: String,
    pub base_year: i64,
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub shichen: String,
    pub weather: String,
    pub scale: i64,
    pub server_now_ms: i64,
    pub game_elapsed_ms: i64,
}

pub fn build_game_time_sync_payload(snapshot: GameTimeSnapshot) -> GameTimeSyncPayload {
    GameTimeSyncPayload {
        era_name: snapshot.era_name,
        base_year: snapshot.base_year,
        year: snapshot.year,
        month: snapshot.month,
        day: snapshot.day,
        hour: snapshot.hour,
        minute: snapshot.minute,
        second: snapshot.second,
        shichen: snapshot.shichen,
        weather: snapshot.weather,
        scale: snapshot.scale,
        server_now_ms: snapshot.server_now_ms,
        game_elapsed_ms: snapshot.game_elapsed_ms,
    }
}

#[cfg(test)]
mod tests {
    use crate::shared::game_time::GameTimeSnapshot;

    use super::build_game_time_sync_payload;

    #[test]
    fn game_time_sync_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_time_sync_payload(GameTimeSnapshot {
            era_name: "末法纪元".to_string(),
            base_year: 1000,
            year: 2026,
            month: 4,
            day: 11,
            hour: 7,
            minute: 30,
            second: 0,
            shichen: "辰时".to_string(),
            weather: "晴".to_string(),
            scale: 60,
            server_now_ms: 1712800000000,
            game_elapsed_ms: 1712800000000,
        }))
        .expect("payload should serialize");
        assert_eq!(payload["era_name"], "末法纪元");
        assert_eq!(payload["base_year"], 1000);
        assert_eq!(payload["year"], 2026);
        assert_eq!(payload["weather"], "晴");
        assert_eq!(payload["server_now_ms"], 1712800000000i64);
        assert_eq!(payload["game_elapsed_ms"], 1712800000000i64);
        assert!(payload.get("kind").is_none());
        assert!(payload.get("eraName").is_none());
        assert!(payload.get("serverTimestampMs").is_none());
        println!("GAME_TIME_SYNC_RESPONSE={}", payload);
    }
}
