use std::collections::HashMap;

use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{build_tower_runtime_registry, StartupContext};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use jiuzhou_server_rs::runtime::tower::build_tower_runtime_registry_from_snapshot;
use sqlx::postgres::PgPoolOptions;

fn build_recovery_source() -> RecoverySourceData {
    RecoverySourceData::default()
        .with_string(
            OnlineProjectionRedisKey::tower(9001).into_string(),
            r#"{
                "characterId":9001,
                "bestFloor":18,
                "nextFloor":19,
                "currentRunId":"tower-run-1",
                "currentFloor":18,
                "currentBattleId":"tower-battle-1",
                "lastSettledFloor":17,
                "updatedAt":"2026-04-10T08:00:00.000Z",
                "reachedAt":"2026-04-10T07:50:00.000Z"
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::tower_runtime("tower-battle-1").into_string(),
            r#"{
                "battleId":"tower-battle-1",
                "characterId":9001,
                "userId":77,
                "runId":"tower-run-1",
                "floor":18,
                "monsters":[{"id":"tower-monster-1","name":"青木狼妖"}],
                "preview":{
                    "floor":18,
                    "kind":"elite",
                    "seed":"tower:18",
                    "realm":"炼气期",
                    "monsterIds":["tower-monster-1"],
                    "monsterNames":["青木狼妖"]
                }
            }"#,
        )
        .with_set(OnlineProjectionIndexKey::towers().into_string(), ["9001"])
        .with_set(
            OnlineProjectionIndexKey::tower_runtimes().into_string(),
            ["tower-battle-1"],
        )
}

#[tokio::test]
async fn tower_runtime_registry_recovers_progress_and_runtime_indexes() {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let registry = build_tower_runtime_registry_from_snapshot(&recovered)
        .expect("build tower runtime registry");

    assert_eq!(registry.len_progressions(), 1);
    assert_eq!(registry.len_runtimes(), 1);
    assert_eq!(registry.progress_character_ids(), vec![9001]);
    assert_eq!(
        registry.runtime_battle_ids(),
        vec!["tower-battle-1".to_string()]
    );
    assert_eq!(
        registry
            .get_progress(9001)
            .and_then(|item| item.current_run_id.as_deref()),
        Some("tower-run-1")
    );
    assert_eq!(
        registry
            .get_runtime("tower-battle-1")
            .map(|item| item.preview.monster_names.clone()),
        Some(vec!["青木狼妖".to_string()])
    );
}

#[tokio::test]
async fn startup_helper_builds_tower_runtime_registry() {
    let settings = Settings::from_map(HashMap::new()).expect("settings");
    let readiness = ReadinessGate::new();
    let postgres = AppPostgres {
        pool: PgPoolOptions::new()
            .connect_lazy("postgresql://postgres:postgres@localhost:5432/jiuzhou")
            .expect("pg pool"),
    };
    let redis = AppRedis {
        client: redis::Client::open("redis://localhost:6379").expect("redis client"),
    };
    let context = StartupContext {
        settings,
        postgres,
        redis,
        readiness,
    };

    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let registry = build_tower_runtime_registry(&context, &recovered)
        .expect("build startup tower runtime registry");

    assert_eq!(
        registry
            .get_runtime("tower-battle-1")
            .map(|item| item.floor),
        Some(18)
    );
}
