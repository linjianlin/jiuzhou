use jiuzhou_server_rs::edge::socket::events::{
    character_room, sect_room, team_room, user_room, CHAT_AUTHED_ROOM,
};
use jiuzhou_server_rs::runtime::connection::session_registry::{RealtimeSession, SessionRegistry};

#[test]
fn session_registry_builds_expected_rooms_and_replaces_previous_user_socket() {
    let mut registry = SessionRegistry::new();

    let first = RealtimeSession {
        socket_id: "socket-1".to_string(),
        user_id: 7,
        session_token: "session-a".to_string(),
        character_id: Some(101),
        team_id: Some("team-9".to_string()),
        sect_id: Some("sect-3".to_string()),
        last_update_ms: 1,
    };

    let first_result = registry.insert(first);
    assert_eq!(first_result.replaced_socket_id, None);
    assert_eq!(
        first_result.joined_rooms,
        vec![
            CHAT_AUTHED_ROOM.to_string(),
            user_room(7),
            character_room(101),
            team_room("team-9"),
            sect_room("sect-3"),
        ]
    );
    assert_eq!(registry.socket_id_by_user(7), Some("socket-1"));
    assert_eq!(registry.socket_id_by_character(101), Some("socket-1"));

    let second = RealtimeSession {
        socket_id: "socket-2".to_string(),
        user_id: 7,
        session_token: "session-b".to_string(),
        character_id: Some(101),
        team_id: None,
        sect_id: None,
        last_update_ms: 2,
    };

    let second_result = registry.insert(second);
    assert_eq!(
        second_result.replaced_socket_id,
        Some("socket-1".to_string())
    );
    assert_eq!(registry.socket_id_by_user(7), Some("socket-2"));
    assert_eq!(registry.socket_id_by_character(101), Some("socket-2"));
    assert!(registry.get_by_socket("socket-1").is_none());
    assert_eq!(registry.len(), 1);
}

#[test]
fn session_registry_removes_user_and_character_indexes_with_socket() {
    let mut registry = SessionRegistry::new();
    registry.insert(RealtimeSession {
        socket_id: "socket-9".to_string(),
        user_id: 9,
        session_token: "session".to_string(),
        character_id: Some(909),
        team_id: None,
        sect_id: None,
        last_update_ms: 10,
    });

    let removed = registry.remove("socket-9").expect("removed session");
    assert_eq!(removed.user_id, 9);
    assert_eq!(registry.socket_id_by_user(9), None);
    assert_eq!(registry.socket_id_by_character(909), None);
    assert_eq!(registry.len(), 0);
}
