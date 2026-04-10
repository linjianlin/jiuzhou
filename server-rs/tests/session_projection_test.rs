use std::collections::HashMap;

use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{
    build_online_projection_registry, build_session_runtime_registry, StartupContext,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::projection::service::{
    build_online_projection_registry_from_snapshot, build_projection_character_status_payload,
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use jiuzhou_server_rs::runtime::session::service::{
    build_battle_session_registry_from_snapshot, build_battle_session_status_payload,
};
use sqlx::postgres::PgPoolOptions;

fn build_startup_context() -> StartupContext {
    StartupContext {
        settings: Settings::from_map(HashMap::new()).expect("settings"),
        postgres: AppPostgres {
            pool: PgPoolOptions::new()
                .connect_lazy("postgresql://postgres:postgres@localhost:5432/jiuzhou")
                .expect("pg pool"),
        },
        redis: AppRedis {
            client: redis::Client::open("redis://localhost:6379").expect("redis client"),
        },
        readiness: ReadinessGate::new(),
    }
}

fn build_recovery_source() -> RecoverySourceData {
    RecoverySourceData::default()
        .with_string(
            OnlineProjectionRedisKey::session("session-1").into_string(),
            r#"{
                "sessionId":"session-1",
                "type":"pve",
                "ownerUserId":77,
                "participantUserIds":[77,88],
                "currentBattleId":"battle-1",
                "status":"running",
                "nextAction":"advance",
                "canAdvance":true,
                "lastResult":null,
                "context":{"monsterIds":["wolf-1"]},
                "createdAt":1710000000000,
                "updatedAt":1710000001000
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session("session-2").into_string(),
            r#"{
                "sessionId":"session-2",
                "type":"tower",
                "ownerUserId":99,
                "participantUserIds":[99],
                "currentBattleId":null,
                "status":"waiting_transition",
                "nextAction":"advance",
                "canAdvance":false,
                "lastResult":"attacker_win",
                "context":{"runId":"tower-run-1","floor":12},
                "createdAt":1710000002000,
                "updatedAt":1710000003000
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session_battle("battle-1").into_string(),
            "session-1",
        )
        .with_string(
            OnlineProjectionRedisKey::character(9001).into_string(),
            r#"{
                "characterId":9001,
                "userId":77,
                "computed":{"id":9001,"user_id":77,"nickname":"甲","qixue":100},
                "loadout":{"weapon":"sword"},
                "activePartner":null,
                "teamId":"team-1",
                "isTeamLeader":true
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::character(9002).into_string(),
            r#"{
                "characterId":9002,
                "userId":88,
                "computed":{"id":9002,"user_id":88,"nickname":"乙","qixue":80},
                "loadout":{"weapon":"blade"},
                "activePartner":null,
                "teamId":"team-1",
                "isTeamLeader":false
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::arena(9001).into_string(),
            r#"{
                "characterId":9001,
                "score":1288,
                "winCount":12,
                "loseCount":3,
                "todayUsed":5,
                "todayLimit":20,
                "todayRemaining":15,
                "records":[
                    {
                        "id":"arena-battle-1",
                        "ts":1710000000000,
                        "opponentName":"乙",
                        "opponentRealm":"炼气期",
                        "opponentPower":9527,
                        "result":"win",
                        "deltaScore":18,
                        "scoreAfter":1288
                    }
                ]
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::arena(9002).into_string(),
            r#"{
                "characterId":9002,
                "score":1210,
                "winCount":8,
                "loseCount":6,
                "todayUsed":4,
                "todayLimit":20,
                "todayRemaining":16,
                "records":[]
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::user_character(77).into_string(),
            "9001",
        )
        .with_string(
            OnlineProjectionRedisKey::user_character(88).into_string(),
            "9002",
        )
        .with_string(
            OnlineProjectionRedisKey::team_member(77).into_string(),
            r#"{"teamId":"team-1","role":"leader","memberCharacterIds":[9001,9002]}"#,
        )
        .with_string(
            OnlineProjectionRedisKey::team_member(88).into_string(),
            r#"{"teamId":"team-1","role":"member","memberCharacterIds":[9001,9002]}"#,
        )
        .with_set(
            OnlineProjectionIndexKey::sessions().into_string(),
            ["session-1", "session-2"],
        )
        .with_set(
            OnlineProjectionIndexKey::arena().into_string(),
            ["9001", "9002"],
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001", "9002"],
        )
        .with_set(
            OnlineProjectionIndexKey::users().into_string(),
            ["77", "88"],
        )
}

#[tokio::test]
async fn session_runtime_registry_recovers_indexes_from_snapshot() {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let registry = build_battle_session_registry_from_snapshot(&recovered)
        .expect("build session runtime registry");

    assert_eq!(registry.len(), 2);
    assert_eq!(
        registry.session_ids(),
        vec!["session-1".to_string(), "session-2".to_string()]
    );
    assert_eq!(
        registry.find_session_id_by_battle_id("battle-1"),
        Some("session-1")
    );
    assert!(registry
        .find_session_id_by_battle_id("battle-missing")
        .is_none());

    let session = registry.get("session-1").expect("session-1 snapshot");
    let payload = build_battle_session_status_payload(session, true);
    assert!(payload.authoritative);
    assert_eq!(payload.session.session_id, "session-1");
    assert_eq!(
        payload.session.current_battle_id.as_deref(),
        Some("battle-1")
    );
}

#[tokio::test]
async fn online_projection_registry_recovers_character_user_and_session_indexes() {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let registry = build_online_projection_registry_from_snapshot(&recovered)
        .expect("build online projection registry");

    assert_eq!(registry.character_ids(), vec![9001, 9002]);
    assert_eq!(registry.arena_character_ids(), vec![9001, 9002]);
    assert_eq!(registry.find_character_id_by_user_id(77), Some(9001));
    assert_eq!(
        registry.find_session_ids_by_character_id(9001),
        vec!["session-1".to_string()]
    );
    assert_eq!(
        registry.find_session_ids_by_character_id(9002),
        vec!["session-1".to_string()]
    );

    let payload = build_projection_character_status_payload(&registry, 9001)
        .expect("projection status payload");
    assert_eq!(payload.character.character_id, 9001);
    assert_eq!(payload.user_id, 77);
    assert_eq!(payload.session_ids, vec!["session-1".to_string()]);
    assert_eq!(registry.get_arena(9001).map(|item| item.score), Some(1288));
    assert_eq!(
        registry
            .get_arena(9001)
            .map(|item| item.records[0].opponent_name.clone()),
        Some("乙".to_string())
    );

    assert_eq!(
        payload
            .team_member
            .expect("team member payload")
            .member_character_ids,
        vec![9001, 9002]
    );
}

#[tokio::test]
async fn startup_helpers_build_session_and_projection_registries() {
    let context = build_startup_context();
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let session_registry = build_session_runtime_registry(&context, &recovered)
        .expect("startup session runtime registry");
    let projection_registry = build_online_projection_registry(&context, &recovered)
        .expect("startup online projection registry");

    assert!(session_registry.get("session-2").is_some());
    assert!(projection_registry.get_character(9002).is_some());
    assert_eq!(
        projection_registry.get_arena(9002).map(|item| item.score),
        Some(1210)
    );
}
