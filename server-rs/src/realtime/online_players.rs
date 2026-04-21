use std::collections::BTreeMap;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlinePlayerDto {
    pub id: i64,
    pub nickname: String,
    pub month_card_active: bool,
    pub title: String,
    pub realm: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlinePlayersPayload {
    pub kind: String,
    #[serde(rename = "type")]
    pub payload_type: String,
    pub total: i64,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub players: Vec<OnlinePlayerDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub room_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub joined: Vec<OnlinePlayerDto>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub left: Vec<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub updated: Vec<OnlinePlayerDto>,
}

pub fn build_online_players_payload(total: i64, room_id: Option<&str>) -> OnlinePlayersPayload {
    OnlinePlayersPayload {
        kind: "game:onlinePlayers".to_string(),
        payload_type: "snapshot".to_string(),
        total,
        players: Vec::new(),
        room_id: room_id.map(|value| value.to_string()),
        joined: Vec::new(),
        left: Vec::new(),
        updated: Vec::new(),
    }
}

pub fn build_online_players_full_payload(players: Vec<OnlinePlayerDto>) -> OnlinePlayersPayload {
    OnlinePlayersPayload {
        kind: "game:onlinePlayers".to_string(),
        payload_type: "full".to_string(),
        total: players.len() as i64,
        players,
        room_id: None,
        joined: Vec::new(),
        left: Vec::new(),
        updated: Vec::new(),
    }
}

pub fn build_online_players_delta_payload(
    total: i64,
    joined: Vec<OnlinePlayerDto>,
    left: Vec<i64>,
    updated: Vec<OnlinePlayerDto>,
) -> OnlinePlayersPayload {
    OnlinePlayersPayload {
        kind: "game:onlinePlayers".to_string(),
        payload_type: "delta".to_string(),
        total,
        players: Vec::new(),
        room_id: None,
        joined,
        left,
        updated,
    }
}

pub fn build_online_players_broadcast_payload(
    previous: &BTreeMap<i64, OnlinePlayerDto>,
    current: &BTreeMap<i64, OnlinePlayerDto>,
) -> Option<OnlinePlayersPayload> {
    let mut joined = Vec::new();
    let mut left = Vec::new();
    let mut updated = Vec::new();

    for (id, dto) in current {
        match previous.get(id) {
            None => joined.push(dto.clone()),
            Some(old)
                if old.nickname != dto.nickname
                    || old.month_card_active != dto.month_card_active
                    || old.title != dto.title
                    || old.realm != dto.realm =>
            {
                updated.push(dto.clone());
            }
            _ => {}
        }
    }

    for id in previous.keys() {
        if !current.contains_key(id) {
            left.push(*id);
        }
    }

    let change_count = joined.len() + left.len() + updated.len();
    if change_count == 0 {
        return None;
    }

    let total = current.len() as i64;
    let use_full = previous.is_empty()
        || (change_count as f64) > (previous.len().max(current.len()) as f64 * 0.5);
    if use_full {
        let mut players = current.values().cloned().collect::<Vec<_>>();
        players.sort_by(|a, b| a.nickname.cmp(&b.nickname).then(a.id.cmp(&b.id)));
        Some(build_online_players_full_payload(players))
    } else {
        joined.sort_by(|a, b| a.nickname.cmp(&b.nickname).then(a.id.cmp(&b.id)));
        updated.sort_by(|a, b| a.nickname.cmp(&b.nickname).then(a.id.cmp(&b.id)));
        left.sort_unstable();
        Some(build_online_players_delta_payload(
            total, joined, left, updated,
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        OnlinePlayerDto, build_online_players_broadcast_payload,
        build_online_players_delta_payload, build_online_players_full_payload,
        build_online_players_payload,
    };

    #[test]
    fn online_players_payload_matches_contract() {
        let payload = serde_json::to_value(build_online_players_payload(
            12,
            Some("room-village-center"),
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:onlinePlayers");
        assert_eq!(payload["type"], "snapshot");
        assert_eq!(payload["total"], 12);
        println!("GAME_ONLINE_PLAYERS_RESPONSE={}", payload);
    }

    #[test]
    fn online_players_full_payload_matches_contract() {
        let payload =
            serde_json::to_value(build_online_players_full_payload(vec![OnlinePlayerDto {
                id: 1,
                nickname: "韩立".to_string(),
                month_card_active: true,
                title: "散修".to_string(),
                realm: "炼气期".to_string(),
            }]))
            .expect("payload should serialize");
        assert_eq!(payload["kind"], "game:onlinePlayers");
        assert_eq!(payload["type"], "full");
        assert_eq!(payload["players"][0]["nickname"], "韩立");
        println!("GAME_ONLINE_PLAYERS_FULL_RESPONSE={}", payload);
    }

    #[test]
    fn online_players_delta_payload_matches_contract() {
        let payload = serde_json::to_value(build_online_players_delta_payload(
            2,
            vec![OnlinePlayerDto {
                id: 1,
                nickname: "韩立".to_string(),
                month_card_active: true,
                title: "散修".to_string(),
                realm: "炼气期".to_string(),
            }],
            vec![2],
            vec![],
        ))
        .expect("payload should serialize");
        assert_eq!(payload["type"], "delta");
        assert_eq!(payload["joined"][0]["id"], 1);
        assert_eq!(payload["left"][0], 2);
        println!("GAME_ONLINE_PLAYERS_DELTA_RESPONSE={}", payload);
    }

    #[test]
    fn online_players_broadcast_payload_prefers_full_for_initial_snapshot() {
        let previous = BTreeMap::new();
        let current = BTreeMap::from([(
            1,
            OnlinePlayerDto {
                id: 1,
                nickname: "韩立".to_string(),
                month_card_active: true,
                title: "散修".to_string(),
                realm: "炼气期".to_string(),
            },
        )]);
        let payload = build_online_players_broadcast_payload(&previous, &current)
            .expect("payload should exist");
        assert_eq!(payload.payload_type, "full");
    }

    #[test]
    fn online_players_broadcast_payload_uses_delta_for_small_changes() {
        let previous = BTreeMap::from([
            (
                1,
                OnlinePlayerDto {
                    id: 1,
                    nickname: "韩立".to_string(),
                    month_card_active: true,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                2,
                OnlinePlayerDto {
                    id: 2,
                    nickname: "张铁".to_string(),
                    month_card_active: false,
                    title: "外门弟子".to_string(),
                    realm: "凡人".to_string(),
                },
            ),
            (
                3,
                OnlinePlayerDto {
                    id: 3,
                    nickname: "墨彩环".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                4,
                OnlinePlayerDto {
                    id: 4,
                    nickname: "李化元".to_string(),
                    month_card_active: true,
                    title: "长老".to_string(),
                    realm: "结丹期".to_string(),
                },
            ),
        ]);
        let current = BTreeMap::from([
            (
                1,
                OnlinePlayerDto {
                    id: 1,
                    nickname: "韩立".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                2,
                OnlinePlayerDto {
                    id: 2,
                    nickname: "张铁".to_string(),
                    month_card_active: false,
                    title: "外门弟子".to_string(),
                    realm: "凡人".to_string(),
                },
            ),
            (
                3,
                OnlinePlayerDto {
                    id: 3,
                    nickname: "墨彩环".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                4,
                OnlinePlayerDto {
                    id: 4,
                    nickname: "李化元".to_string(),
                    month_card_active: true,
                    title: "长老".to_string(),
                    realm: "结丹期".to_string(),
                },
            ),
        ]);
        let payload = build_online_players_broadcast_payload(&previous, &current)
            .expect("payload should exist");
        assert_eq!(payload.payload_type, "delta");
        assert_eq!(payload.joined.len(), 0);
        assert_eq!(payload.updated.len(), 1);
    }

    #[test]
    fn online_players_broadcast_lifecycle_matches_auth_refresh_disconnect_flow() {
        let empty = BTreeMap::new();
        let authed = BTreeMap::from([
            (
                1,
                OnlinePlayerDto {
                    id: 1,
                    nickname: "韩立".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                2,
                OnlinePlayerDto {
                    id: 2,
                    nickname: "张铁".to_string(),
                    month_card_active: false,
                    title: "外门弟子".to_string(),
                    realm: "凡人".to_string(),
                },
            ),
            (
                3,
                OnlinePlayerDto {
                    id: 3,
                    nickname: "墨彩环".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                4,
                OnlinePlayerDto {
                    id: 4,
                    nickname: "李化元".to_string(),
                    month_card_active: true,
                    title: "长老".to_string(),
                    realm: "结丹期".to_string(),
                },
            ),
        ]);

        let first_payload = build_online_players_broadcast_payload(&empty, &authed)
            .expect("auth broadcast should exist");
        assert_eq!(first_payload.payload_type, "full");
        assert_eq!(first_payload.players.len(), 4);

        let refreshed = BTreeMap::from([
            (
                1,
                OnlinePlayerDto {
                    id: 1,
                    nickname: "韩立".to_string(),
                    month_card_active: true,
                    title: "散修".to_string(),
                    realm: "筑基期".to_string(),
                },
            ),
            (
                2,
                OnlinePlayerDto {
                    id: 2,
                    nickname: "张铁".to_string(),
                    month_card_active: false,
                    title: "外门弟子".to_string(),
                    realm: "凡人".to_string(),
                },
            ),
            (
                3,
                OnlinePlayerDto {
                    id: 3,
                    nickname: "墨彩环".to_string(),
                    month_card_active: false,
                    title: "散修".to_string(),
                    realm: "炼气期".to_string(),
                },
            ),
            (
                4,
                OnlinePlayerDto {
                    id: 4,
                    nickname: "李化元".to_string(),
                    month_card_active: true,
                    title: "长老".to_string(),
                    realm: "结丹期".to_string(),
                },
            ),
        ]);
        let refresh_payload = build_online_players_broadcast_payload(&authed, &refreshed)
            .expect("refresh broadcast should exist");
        assert_eq!(refresh_payload.payload_type, "delta");
        assert_eq!(refresh_payload.joined.len(), 0);
        assert_eq!(refresh_payload.left.len(), 0);
        assert_eq!(refresh_payload.updated.len(), 1);
        assert_eq!(refresh_payload.updated[0].realm, "筑基期");
        assert!(refresh_payload.updated[0].month_card_active);

        let disconnect_payload = build_online_players_broadcast_payload(&refreshed, &empty)
            .expect("disconnect broadcast should exist");
        assert_eq!(disconnect_payload.payload_type, "full");
        assert_eq!(disconnect_payload.total, 0);
        assert!(disconnect_payload.players.is_empty());
    }
}
