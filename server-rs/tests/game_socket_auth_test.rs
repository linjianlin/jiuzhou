use std::sync::Arc;
use std::{future::Future, pin::Pin};

use jiuzhou_server_rs::edge::socket::events::{
    character_room, sect_room, team_room, user_room, CHAT_AUTHED_ROOM, GAME_AUTH_READY_EVENT,
    GAME_ERROR_EVENT, GAME_KICKED_EVENT,
};
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthOutcome, GameSocketAuthProfile, GameSocketAuthServices,
    GameSocketConnectionManager,
};
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;

#[tokio::test]
async fn game_socket_auth_success_returns_auth_ready_and_expected_rooms() {
    let registry = new_shared_session_registry();
    let manager = GameSocketConnectionManager::new(
        Arc::new(FakeGameSocketAuthServices::valid(GameSocketAuthProfile {
            user_id: 7,
            session_token: "session-7".to_string(),
            character_id: Some(101),
            team_id: Some("team-9".to_string()),
            sect_id: Some("sect-3".to_string()),
        })),
        registry.clone(),
    );

    let outcome = manager.authenticate("socket-1", "token-1").await;

    assert_eq!(
        outcome,
        GameSocketAuthOutcome::Authenticated {
            ready_event: GAME_AUTH_READY_EVENT,
            replaced_socket_id: None,
            joined_rooms: vec![
                CHAT_AUTHED_ROOM.to_string(),
                user_room(7),
                character_room(101),
                team_room("team-9"),
                sect_room("sect-3"),
            ],
        }
    );

    let registry = registry.lock().await;
    let session = registry
        .get_by_socket("socket-1")
        .expect("inserted socket session");
    assert_eq!(session.user_id, 7);
    assert_eq!(session.character_id, Some(101));
}

#[tokio::test]
async fn game_socket_auth_invalid_token_emits_game_error_without_registering_session() {
    let registry = new_shared_session_registry();
    let manager = GameSocketConnectionManager::new(
        Arc::new(FakeGameSocketAuthServices::invalid("认证失败")),
        registry.clone(),
    );

    let outcome = manager.authenticate("socket-2", "bad-token").await;

    assert_eq!(
        outcome,
        GameSocketAuthOutcome::Rejected {
            event: GAME_ERROR_EVENT,
            message: "认证失败".to_string(),
            disconnect_current: false,
        }
    );
    assert_eq!(registry.lock().await.len(), 0);
}

#[tokio::test]
async fn game_socket_auth_replaces_previous_socket_and_marks_old_connection_for_kick() {
    let registry = new_shared_session_registry();
    let manager = GameSocketConnectionManager::new(
        Arc::new(FakeGameSocketAuthServices::valid(GameSocketAuthProfile {
            user_id: 9,
            session_token: "session-9".to_string(),
            character_id: Some(909),
            team_id: None,
            sect_id: None,
        })),
        registry.clone(),
    );

    let first = manager.authenticate("socket-old", "token-old").await;
    let second = manager.authenticate("socket-new", "token-new").await;

    assert_eq!(
        first,
        GameSocketAuthOutcome::Authenticated {
            ready_event: GAME_AUTH_READY_EVENT,
            replaced_socket_id: None,
            joined_rooms: vec![
                CHAT_AUTHED_ROOM.to_string(),
                user_room(9),
                character_room(909),
            ],
        }
    );
    assert_eq!(
        second,
        GameSocketAuthOutcome::Authenticated {
            ready_event: GAME_AUTH_READY_EVENT,
            replaced_socket_id: Some("socket-old".to_string()),
            joined_rooms: vec![
                CHAT_AUTHED_ROOM.to_string(),
                user_room(9),
                character_room(909),
            ],
        }
    );

    let registry = registry.lock().await;
    assert!(registry.get_by_socket("socket-old").is_none());
    assert_eq!(registry.socket_id_by_user(9), Some("socket-new"));
}

#[tokio::test]
async fn game_socket_auth_returns_kicked_event_when_session_is_revoked() {
    let registry = new_shared_session_registry();
    let manager = GameSocketConnectionManager::new(
        Arc::new(FakeGameSocketAuthServices::kicked("账号已在其他设备登录")),
        registry.clone(),
    );

    let outcome = manager.authenticate("socket-3", "token-3").await;

    assert_eq!(
        outcome,
        GameSocketAuthOutcome::Rejected {
            event: GAME_KICKED_EVENT,
            message: "账号已在其他设备登录".to_string(),
            disconnect_current: true,
        }
    );
    assert_eq!(registry.lock().await.len(), 0);
}

struct FakeGameSocketAuthServices {
    result: Result<GameSocketAuthProfile, GameSocketAuthFailure>,
}

impl FakeGameSocketAuthServices {
    fn valid(profile: GameSocketAuthProfile) -> Self {
        Self {
            result: Ok(profile),
        }
    }

    fn invalid(message: &str) -> Self {
        Self {
            result: Err(GameSocketAuthFailure {
                event: GAME_ERROR_EVENT,
                message: message.to_string(),
                disconnect_current: false,
            }),
        }
    }

    fn kicked(message: &str) -> Self {
        Self {
            result: Err(GameSocketAuthFailure {
                event: GAME_KICKED_EVENT,
                message: message.to_string(),
                disconnect_current: true,
            }),
        }
    }
}

impl GameSocketAuthServices for FakeGameSocketAuthServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move { self.result.clone() })
    }
}
