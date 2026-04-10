use std::collections::HashMap;

use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{
    build_battle_runtime_registry, load_runtime_recovery, StartupContext,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::battle::build_battle_runtime_registry_from_snapshot;
use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
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
        .with_string(
            BattleRedisKey::participants("battle-1").into_string(),
            r#"[77,88]"#,
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
        .with_string(
            OnlineProjectionRedisKey::user_character(77).into_string(),
            "9001",
        )
        .with_set(
            OnlineProjectionIndexKey::sessions().into_string(),
            ["session-1"],
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001"],
        )
        .with_set(
            OnlineProjectionIndexKey::users().into_string(),
            ["77"],
        )
}

#[tokio::test]
async fn battle_runtime_recovery_builds_deterministic_registry_from_snapshot() {
    let source = build_recovery_source();
    let recovered = RuntimeRecoveryLoader::load_from_source(&source)
        .await
        .expect("load recovery source");

    let registry = build_battle_runtime_registry_from_snapshot(&recovered)
        .expect("build battle runtime registry");

    assert_eq!(registry.len(), 1);
    assert_eq!(registry.battle_ids(), vec!["battle-1".to_string()]);
    assert_eq!(
        registry.find_battle_id_by_character_id(9001),
        Some("battle-1")
    );
    assert_eq!(
        registry.find_battle_ids_by_user_id(77),
        vec!["battle-1".to_string()]
    );

    let runtime = registry.get("battle-1").expect("battle runtime entry");
    assert_eq!(runtime.identity.session_id.as_deref(), Some("session-1"));
}

#[tokio::test]
async fn startup_hook_can_transform_recovery_snapshot_into_runtime_registry() {
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

    let source = build_recovery_source();
    let recovered = RuntimeRecoveryLoader::load_from_source(&source)
        .await
        .expect("load recovery source");

    let registry = build_battle_runtime_registry(&context, &recovered)
        .expect("startup battle runtime registry");

    assert_eq!(registry.len(), 1);
    assert!(registry.get("battle-1").is_some());

    let _ = load_runtime_recovery;
}
