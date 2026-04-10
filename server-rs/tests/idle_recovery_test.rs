use std::collections::HashMap;

use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{build_idle_runtime_service, StartupContext};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::idle::lock::IdleLockRedisKey;
use jiuzhou_server_rs::runtime::idle::{
    build_idle_lock_status_payload, build_idle_runtime_service_from_snapshot,
};
use jiuzhou_server_rs::runtime::projection::service::{RecoverySourceData, RuntimeRecoveryLoader};
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
            IdleLockRedisKey::new(9001).into_string(),
            "idle-start:550e8400-e29b-41d4-a716-446655440000",
        )
        .with_string(
            IdleLockRedisKey::new(9002).into_string(),
            "idle-start:550e8400-e29b-41d4-a716-446655440001",
        )
        .with_string(IdleLockRedisKey::new(9999).into_string(), "broken-token")
}

#[tokio::test]
async fn idle_runtime_service_recovers_character_lock_registry() {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let service =
        build_idle_runtime_service_from_snapshot(&recovered).expect("build idle runtime service");

    assert!(service.is_character_locked(9001));
    assert!(service.is_character_locked(9002));
    assert!(!service.is_character_locked(9999));
    assert_eq!(service.locked_character_ids(), vec![9001, 9002]);

    let lock = service.lock_registry().get(9001).expect("idle lock entry");
    let payload = build_idle_lock_status_payload(lock, true);
    assert!(payload.authoritative);
    assert_eq!(payload.character_id, 9001);
    assert_eq!(payload.lock_token_kind, "idle-start");
    assert_eq!(
        payload.lock_token,
        "idle-start:550e8400-e29b-41d4-a716-446655440000"
    );
}

#[tokio::test]
async fn startup_helper_builds_idle_runtime_service() {
    let context = build_startup_context();
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let service =
        build_idle_runtime_service(&context, &recovered).expect("startup idle runtime service");

    assert!(service.lock_registry().get(9002).is_some());
}
