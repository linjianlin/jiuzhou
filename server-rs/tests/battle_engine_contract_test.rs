use jiuzhou_server_rs::domain::battle::engine::BattleRuntimeEngine;
use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
use jiuzhou_server_rs::runtime::battle::{build_battle_sync_payload, BattleRealtimeKind};
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};

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
        .with_string(
            OnlineProjectionRedisKey::user_character(77).into_string(),
            "9001",
        )
        .with_string(
            OnlineProjectionRedisKey::team_member(77).into_string(),
            r#"{"teamId":"team-1","role":"leader","memberCharacterIds":[9001,9002]}"#,
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
async fn battle_runtime_engine_builds_runtime_and_sync_payload_from_recovered_state() {
    let source = build_recovery_source();
    let recovered = RuntimeRecoveryLoader::load_from_source(&source)
        .await
        .expect("load recovery source");

    let runtime = BattleRuntimeEngine::assemble(&recovered, "battle-1")
        .expect("assemble recovered battle runtime");

    assert_eq!(runtime.identity.battle_id, "battle-1");
    assert_eq!(runtime.identity.battle_type, "pve");
    assert_eq!(runtime.identity.session_id.as_deref(), Some("session-1"));
    assert_eq!(runtime.participants.user_ids, vec![77, 88]);
    assert_eq!(runtime.participants.character_ids, vec![9001]);
    assert_eq!(runtime.participants.members.len(), 1);
    assert_eq!(runtime.participants.members[0].character_id, 9001);
    assert_eq!(runtime.participants.members[0].user_id, Some(77));
    assert_eq!(
        runtime.participants.members[0]
            .runtime_resource
            .as_ref()
            .map(|item| item.qixue),
        Some(88)
    );
    assert_eq!(
        runtime
            .session
            .as_ref()
            .map(|session| session.session_id.as_str()),
        Some("session-1")
    );

    let payload = build_battle_sync_payload(&runtime, true);
    assert_eq!(payload.kind, BattleRealtimeKind::BattleState);
    assert_eq!(payload.battle_id, "battle-1");
    assert!(payload.authoritative);
    assert_eq!(payload.log_start, 99);
    assert!(payload.log_delta);
    assert!(!payload.units_delta);
    assert!(payload.logs.is_empty());
    assert_eq!(payload.state.battle_id, "battle-1");
    assert_eq!(payload.state.battle_type, "pve");
    assert_eq!(payload.state.phase, "running");
    assert_eq!(payload.state.teams.attacker.units[0].id, "unit-a");
    assert_eq!(payload.state.teams.attacker.units[0].qixue, 100);
    assert_eq!(payload.state.teams.attacker.units[0].unit_type, "player");
    assert_eq!(payload.session, runtime.session.clone());
}
