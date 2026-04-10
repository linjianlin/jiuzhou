use std::collections::HashMap;

use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{
    execute_with_recovery_and_observer, StartupContext, StartupStage,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
use jiuzhou_server_rs::runtime::idle::lock::IdleLockRedisKey;
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use sqlx::postgres::PgPoolOptions;

fn build_recovery_source() -> RecoverySourceData {
    RecoverySourceData::default()
        .with_string(
            BattleRedisKey::state("battle-1").into_string(),
            r#"{
                "roundCount":3,
                "currentTeam":"attacker",
                "currentUnitId":"unit-a",
                "phase":"running",
                "result":null,
                "rewards":null,
                "randomIndex":17,
                "logCursor":99,
                "teams":{
                    "attacker":{"totalSpeed":123,"units":[{"currentAttrs":{"max_qixue":100},"qixue":100,"lingqi":50,"shields":[],"buffs":[],"marks":[],"momentum":0,"skillCooldowns":{},"skillCooldownDiscountBank":{},"triggeredPhaseIds":[],"controlDiminishing":{},"isAlive":true,"canAct":true,"stats":{}}]},
                    "defender":{"totalSpeed":98,"units":[{"currentAttrs":{"max_qixue":120},"qixue":120,"lingqi":0,"shields":[],"buffs":[],"marks":[],"momentum":0,"skillCooldowns":{},"skillCooldownDiscountBank":{},"triggeredPhaseIds":[],"controlDiminishing":{},"isAlive":true,"canAct":true,"stats":{}}]}
                }
            }"#,
        )
        .with_string(
            BattleRedisKey::static_state("battle-1").into_string(),
            r#"{
                "battleId":"battle-1",
                "battleType":"pve",
                "cooldownTimingMode":"tick",
                "firstMover":"attacker",
                "randomSeed":"seed-1",
                "teams":{
                    "attacker":{"odwnerId":77,"units":[{"id":"unit-a","name":"甲","type":"player","sourceId":9001,"formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":100},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]},
                    "defender":{"odwnerId":0,"units":[{"id":"unit-b","name":"乙","type":"monster","sourceId":"wolf-1","formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":120},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]}
                }
            }"#,
        )
        .with_string(BattleRedisKey::participants("battle-1").into_string(), r#"[77,88]"#)
        .with_string(
            BattleRedisKey::character_runtime_resource(9001).into_string(),
            r#"{"qixue":88,"lingqi":21}"#,
        )
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
            OnlineProjectionRedisKey::session_battle("battle-1").into_string(),
            "session-1",
        )
        .with_string(
            OnlineProjectionRedisKey::character(9001).into_string(),
            r#"{
                "characterId":9001,
                "userId":77,
                "computed":{"id":9001,"user_id":77,"nickname":"测试角色","qixue":100,"lingqi":50},
                "loadout":{"weapon":"sword"},
                "activePartner":null,
                "teamId":"team-1",
                "isTeamLeader":true
            }"#,
        )
        .with_string(OnlineProjectionRedisKey::user_character(77).into_string(), "9001")
        .with_string(
            OnlineProjectionRedisKey::team_member(77).into_string(),
            r#"{"teamId":"team-1","role":"leader","memberCharacterIds":[9001,9002]}"#,
        )
        .with_string(
            IdleLockRedisKey::new(9001).into_string(),
            "idle-start:550e8400-e29b-41d4-a716-446655440000",
        )
        .with_set(
            OnlineProjectionIndexKey::sessions().into_string(),
            ["session-1"],
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001"],
        )
        .with_set(OnlineProjectionIndexKey::users().into_string(), ["77"])
}

#[tokio::test]
async fn startup_pipeline_preserves_expected_stage_order_and_builds_runtime_before_ready() {
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
        readiness: readiness.clone(),
    };
    let recovery = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let mut observed = Vec::new();
    let execution = execute_with_recovery_and_observer(&context, recovery, |stage| {
        if stage == StartupStage::Ready {
            assert!(observed.contains(&StartupStage::RecoveryPrepared));
        }
        observed.push(stage);
    })
    .await
    .expect("startup execute");

    assert_eq!(
        observed,
        vec![
            StartupStage::ConfigLoaded,
            StartupStage::PostgresReady,
            StartupStage::RedisReady,
            StartupStage::WarmupPrepared,
            StartupStage::RecoveryPrepared,
            StartupStage::Ready,
        ]
    );
    assert_eq!(execution.stages, observed);
    assert!(readiness.is_ready());
    let runtime_services = execution.runtime_services.read().await;
    assert_eq!(runtime_services.battle_registry.len(), 1);
    assert_eq!(
        runtime_services
            .session_registry
            .find_session_id_by_battle_id("battle-1"),
        Some("session-1")
    );
    assert_eq!(
        runtime_services
            .online_projection_registry
            .find_character_id_by_user_id(77),
        Some(9001)
    );
    assert!(runtime_services.idle_runtime_service.is_character_locked(9001));
}
