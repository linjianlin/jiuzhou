use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
use jiuzhou_server_rs::runtime::idle::lock::IdleLockRedisKey;
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};

#[tokio::test]
async fn recovery_kernel_groups_runtime_state_by_subsystem() {
    let source = RecoverySourceData::default()
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
                    "attacker":{"odwnerId":1,"units":[{"id":"unit-a","name":"甲","type":"player","sourceId":9001,"formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":100},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]},
                    "defender":{"odwnerId":0,"units":[{"id":"unit-b","name":"乙","type":"monster","sourceId":"wolf-1","formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":120},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]}
                }
            }"#,
        )
        .with_string(
            BattleRedisKey::participants("battle-1").into_string(),
            r#"[77,88]"#,
        )
        .with_string(
            BattleRedisKey::pve_resume_intent(77).into_string(),
            r#"{
                "ownerUserId":77,
                "sessionId":"session-1",
                "monsterIds":["wolf-1"],
                "participantUserIds":[77,88],
                "battleId":"battle-1",
                "updatedAt":1710000001000
            }"#,
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
        .with_set(OnlineProjectionIndexKey::towers().into_string(), ["9001"])
        .with_set(
            OnlineProjectionIndexKey::tower_runtimes().into_string(),
            ["tower-battle-1"],
        );

    let recovered = RuntimeRecoveryLoader::load_from_source(&source)
        .await
        .expect("load recovery source");

    assert_eq!(recovered.battles.len(), 1);
    assert_eq!(recovered.battles[0].battle_id, "battle-1");
    assert_eq!(recovered.battles[0].participants, vec![77, 88]);
    assert_eq!(recovered.battle_sessions.pve_resume_intents.len(), 1);
    assert_eq!(recovered.battle_sessions.projections.len(), 1);
    assert_eq!(recovered.online_projection.character_snapshots.len(), 1);
    assert_eq!(recovered.online_projection.user_character_links.len(), 1);
    assert_eq!(recovered.online_projection.team_members.len(), 1);
    assert_eq!(recovered.online_projection.session_battle_links.len(), 1);
    assert_eq!(recovered.online_projection.tower_progressions.len(), 1);
    assert_eq!(recovered.online_projection.tower_runtime_projections.len(), 1);
    assert_eq!(recovered.online_projection.tower_progressions[0].best_floor, 18);
    assert_eq!(
        recovered.online_projection.tower_runtime_projections[0]
            .preview
            .monster_names,
        vec!["青木狼妖"]
    );
    assert_eq!(recovered.runtime_resources.len(), 1);
    assert_eq!(recovered.idle_locks.len(), 1);
    assert_eq!(
        recovered.idle_locks[0].token.as_str(),
        "idle-start:550e8400-e29b-41d4-a716-446655440000"
    );
}
