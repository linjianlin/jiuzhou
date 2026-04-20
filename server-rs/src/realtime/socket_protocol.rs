use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameAuthPayload {
    pub kind: String,
    pub user_id: i64,
    pub character_id: Option<i64>,
    pub session_token: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameReadyPayload {
    pub kind: String,
    pub user_id: i64,
    pub character_id: Option<i64>,
    pub server_timestamp_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameKickedPayload {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCharacterDelta {
    pub id: i64,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCharacterGlobalBuff {
    pub id: String,
    pub buff_key: String,
    pub label: String,
    pub icon_text: String,
    pub effect_text: String,
    pub started_at: String,
    pub expire_at: String,
    pub total_duration_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCharacterFullSnapshot {
    pub id: i64,
    pub user_id: i64,
    pub nickname: String,
    pub month_card_active: bool,
    pub title: String,
    pub gender: String,
    pub avatar: Option<String>,
    pub auto_cast_skills: bool,
    pub auto_disassemble_enabled: bool,
    pub dungeon_no_stamina_cost: bool,
    pub spirit_stones: i64,
    pub silver: i64,
    pub stamina: i64,
    pub stamina_max: i64,
    pub realm: String,
    pub sub_realm: Option<String>,
    pub exp: i64,
    pub attribute_points: i64,
    pub jing: i64,
    pub qi: i64,
    pub shen: i64,
    pub attribute_type: String,
    pub attribute_element: String,
    pub qixue: i64,
    pub max_qixue: i64,
    pub lingqi: i64,
    pub max_lingqi: i64,
    pub wugong: i64,
    pub fagong: i64,
    pub wufang: i64,
    pub fafang: i64,
    pub mingzhong: i64,
    pub shanbi: i64,
    pub zhaojia: i64,
    pub baoji: i64,
    pub baoshang: i64,
    pub jianbaoshang: i64,
    pub jianfantan: i64,
    pub kangbao: i64,
    pub zengshang: i64,
    pub zhiliao: i64,
    pub jianliao: i64,
    pub xixue: i64,
    pub lengque: i64,
    pub kongzhi_kangxing: i64,
    pub jin_kangxing: i64,
    pub mu_kangxing: i64,
    pub shui_kangxing: i64,
    pub huo_kangxing: i64,
    pub tu_kangxing: i64,
    pub qixue_huifu: i64,
    pub lingqi_huifu: i64,
    pub sudu: i64,
    pub fuyuan: i64,
    pub current_map_id: String,
    pub current_room_id: String,
    pub feature_unlocks: Vec<String>,
    pub global_buffs: Vec<GameCharacterGlobalBuff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCharacterPayload {
    pub kind: String,
    #[serde(rename = "type")]
    pub payload_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<GameCharacterDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<GameCharacterFullSnapshot>,
}

pub fn build_game_auth_payload(
    user_id: i64,
    character_id: Option<i64>,
    session_token: Option<&str>,
) -> GameAuthPayload {
    GameAuthPayload {
        kind: "game:auth".to_string(),
        user_id,
        character_id,
        session_token: session_token.map(|value| value.to_string()),
    }
}

pub fn build_game_ready_payload(
    user_id: i64,
    character_id: Option<i64>,
    server_timestamp_ms: i64,
) -> GameReadyPayload {
    GameReadyPayload {
        kind: "game:auth-ready".to_string(),
        user_id,
        character_id,
        server_timestamp_ms,
    }
}

pub fn build_game_kicked_payload(message: &str) -> GameKickedPayload {
    GameKickedPayload {
        kind: "game:kicked".to_string(),
        message: message.to_string(),
    }
}

pub fn build_game_character_delta_payload(id: i64, avatar: Option<&str>) -> GameCharacterPayload {
    GameCharacterPayload {
        kind: "game:character".to_string(),
        payload_type: "delta".to_string(),
        delta: Some(GameCharacterDelta {
            id,
            avatar: avatar.map(|value| value.to_string()),
        }),
        character: None,
    }
}

pub fn build_game_character_full_payload(
    character: Option<GameCharacterFullSnapshot>,
) -> GameCharacterPayload {
    GameCharacterPayload {
        kind: "game:character".to_string(),
        payload_type: "full".to_string(),
        delta: None,
        character,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_game_auth_payload, build_game_character_delta_payload,
        build_game_character_full_payload, build_game_kicked_payload, build_game_ready_payload,
        GameCharacterFullSnapshot, GameCharacterGlobalBuff,
    };

    #[test]
    fn game_auth_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_auth_payload(1, Some(2), Some("sess-token")))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:auth");
        println!("GAME_AUTH_RESPONSE={}", payload);
    }

    #[test]
    fn game_ready_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_ready_payload(1, Some(2), 1712800000000))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:auth-ready");
        println!("GAME_READY_RESPONSE={}", payload);
    }

    #[test]
    fn game_kicked_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_kicked_payload("账号已在其他设备登录"))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:kicked");
        assert_eq!(payload["message"], "账号已在其他设备登录");
        println!("GAME_KICKED_RESPONSE={}", payload);
    }

    #[test]
    fn game_character_delta_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_character_delta_payload(
            1,
            Some("/uploads/avatars/a.png"),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:character");
        assert_eq!(payload["type"], "delta");
        assert_eq!(payload["delta"]["id"], 1);
        println!("GAME_CHARACTER_DELTA_RESPONSE={}", payload);
    }

    #[test]
    fn game_character_full_payload_matches_contract() {
        let payload = serde_json::to_value(build_game_character_full_payload(Some(
            GameCharacterFullSnapshot {
                id: 1,
                user_id: 9,
                nickname: "韩立".to_string(),
                month_card_active: true,
                title: "散修".to_string(),
                gender: "male".to_string(),
                avatar: Some("/uploads/avatars/a.png".to_string()),
                auto_cast_skills: true,
                auto_disassemble_enabled: false,
                dungeon_no_stamina_cost: false,
                spirit_stones: 12,
                silver: 34,
                stamina: 56,
                stamina_max: 100,
                realm: "炼气期".to_string(),
                sub_realm: Some("一层".to_string()),
                exp: 78,
                attribute_points: 3,
                jing: 4,
                qi: 5,
                shen: 6,
                attribute_type: "physical".to_string(),
                attribute_element: "none".to_string(),
                qixue: 100,
                max_qixue: 120,
                lingqi: 80,
                max_lingqi: 90,
                wugong: 10,
                fagong: 11,
                wufang: 12,
                fafang: 13,
                mingzhong: 14,
                shanbi: 15,
                zhaojia: 0,
                baoji: 16,
                baoshang: 17,
                jianbaoshang: 0,
                jianfantan: 0,
                kangbao: 18,
                zengshang: 0,
                zhiliao: 0,
                jianliao: 0,
                xixue: 0,
                lengque: 0,
                kongzhi_kangxing: 0,
                jin_kangxing: 0,
                mu_kangxing: 0,
                shui_kangxing: 0,
                huo_kangxing: 0,
                tu_kangxing: 0,
                qixue_huifu: 0,
                lingqi_huifu: 0,
                sudu: 19,
                fuyuan: 20,
                current_map_id: "map-qingyun-village".to_string(),
                current_room_id: "room-village-center".to_string(),
                feature_unlocks: vec!["partner_system".to_string()],
                global_buffs: vec![GameCharacterGlobalBuff {
                    id: "fuyuan_flat|sect_blessing|blessing_hall".to_string(),
                    buff_key: "fuyuan_flat".to_string(),
                    label: "祈福".to_string(),
                    icon_text: "祈".to_string(),
                    effect_text: "福源 +2".to_string(),
                    started_at: "2026-04-13T00:00:00.000Z".to_string(),
                    expire_at: "2026-04-13T03:00:00.000Z".to_string(),
                    total_duration_ms: 10_800_000,
                }],
            },
        )))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:character");
        assert_eq!(payload["type"], "full");
        assert_eq!(payload["character"]["id"], 1);
        assert_eq!(payload["character"]["featureUnlocks"][0], "partner_system");
        assert_eq!(payload["character"]["globalBuffs"][0]["label"], "祈福");
        println!("GAME_CHARACTER_FULL_RESPONSE={}", payload);
    }
}
