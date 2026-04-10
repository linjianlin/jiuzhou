use jiuzhou_server_rs::infra::redis::codecs::decode_json;
use jiuzhou_server_rs::runtime::battle::persistence::{
    BattleDynamicStateRedis, BattleRedisKey, BattleStaticStateRedis, CharacterRuntimeResourceRedis,
    PveResumeIntentRedis,
};
use jiuzhou_server_rs::runtime::idle::lock::{IdleLockRedisKey, IdleLockToken};
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineBattleCharacterSnapshotRedis, OnlineProjectionIndexKey, OnlineProjectionRedisKey,
    TeamMemberProjectionRedis,
};
use jiuzhou_server_rs::runtime::session::projection::OnlineBattleSessionSnapshotRedis;
use jiuzhou_server_rs::runtime::tower::{
    TowerBattleRuntimeProjectionRedis, TowerProgressProjectionRedis,
};

#[test]
fn redis_key_codecs_preserve_compatibility_matrix_names() {
    assert_eq!(
        BattleRedisKey::state("battle-1").as_ref(),
        "battle:state:battle-1"
    );
    assert_eq!(
        BattleRedisKey::parse("battle:state:battle-1"),
        Some(BattleRedisKey::state("battle-1"))
    );
    assert_eq!(
        BattleRedisKey::static_state("battle-1").as_ref(),
        "battle:state:static:battle-1"
    );
    assert_eq!(
        BattleRedisKey::participants("battle-1").as_ref(),
        "battle:participants:battle-1"
    );
    assert_eq!(
        BattleRedisKey::pve_resume_intent(77).as_ref(),
        "battle:session:pve-resume:77"
    );
    assert_eq!(
        BattleRedisKey::character_runtime_resource(9001).as_ref(),
        "character:runtime:resource:v1:9001"
    );

    assert_eq!(
        OnlineProjectionRedisKey::character(9001).as_ref(),
        "online-battle:character:9001"
    );
    assert_eq!(
        OnlineProjectionRedisKey::user_character(88).as_ref(),
        "online-battle:user-character:88"
    );
    assert_eq!(
        OnlineProjectionRedisKey::team_member(88).as_ref(),
        "online-battle:team-member:88"
    );
    assert_eq!(
        OnlineProjectionRedisKey::session("session-1").as_ref(),
        "online-battle:session:session-1"
    );
    assert_eq!(
        OnlineProjectionRedisKey::session_battle("battle-1").as_ref(),
        "online-battle:session-battle:battle-1"
    );
    assert_eq!(
        OnlineProjectionRedisKey::arena(9001).as_ref(),
        "online-battle:arena:9001"
    );
    assert_eq!(
        OnlineProjectionRedisKey::dungeon("instance-1").as_ref(),
        "online-battle:dungeon:instance-1"
    );
    assert_eq!(
        OnlineProjectionRedisKey::dungeon_battle("battle-2").as_ref(),
        "online-battle:dungeon-battle:battle-2"
    );
    assert_eq!(
        OnlineProjectionRedisKey::dungeon_entry(9001, "dungeon-a").as_ref(),
        "online-battle:dungeon-entry:9001:dungeon-a"
    );
    assert_eq!(
        OnlineProjectionRedisKey::tower(9001).as_ref(),
        "online-battle:tower:9001"
    );
    assert_eq!(
        OnlineProjectionRedisKey::tower_runtime("battle-3").as_ref(),
        "online-battle:tower-runtime:battle-3"
    );
    assert_eq!(
        OnlineProjectionRedisKey::settlement_task("task-1").as_ref(),
        "online-battle:settlement-task:task-1"
    );

    assert_eq!(
        OnlineProjectionIndexKey::characters().as_ref(),
        "online-battle:index:characters"
    );
    assert_eq!(
        OnlineProjectionIndexKey::users().as_ref(),
        "online-battle:index:users"
    );
    assert_eq!(
        OnlineProjectionIndexKey::sessions().as_ref(),
        "online-battle:index:sessions"
    );
    assert_eq!(
        OnlineProjectionIndexKey::arena().as_ref(),
        "online-battle:index:arena"
    );
    assert_eq!(
        OnlineProjectionIndexKey::dungeons().as_ref(),
        "online-battle:index:dungeons"
    );
    assert_eq!(
        OnlineProjectionIndexKey::dungeon_entries().as_ref(),
        "online-battle:index:dungeon-entries"
    );
    assert_eq!(
        OnlineProjectionIndexKey::towers().as_ref(),
        "online-battle:index:towers"
    );
    assert_eq!(
        OnlineProjectionIndexKey::tower_runtimes().as_ref(),
        "online-battle:index:tower-runtimes"
    );
    assert_eq!(
        OnlineProjectionIndexKey::settlement_tasks().as_ref(),
        "online-battle:index:settlement-tasks"
    );

    assert_eq!(IdleLockRedisKey::new(9001).as_ref(), "idle:lock:9001");
}

#[test]
fn redis_payload_codecs_decode_current_node_contract_samples() {
    let dynamic: BattleDynamicStateRedis = decode_json(
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
    .expect("decode dynamic battle state");
    assert_eq!(dynamic.round_count, 3);
    assert_eq!(dynamic.current_team, "attacker");
    assert_eq!(dynamic.log_cursor, 99);

    let static_state: BattleStaticStateRedis = decode_json(
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
    .expect("decode static battle state");
    assert_eq!(static_state.battle_id, "battle-1");
    assert_eq!(static_state.teams.attacker.odwner_id, Some(1));

    let pve_resume: PveResumeIntentRedis = decode_json(
        r#"{
            "ownerUserId":77,
            "sessionId":"session-1",
            "monsterIds":["wolf-1","wolf-2"],
            "participantUserIds":[77,88],
            "battleId":"battle-1",
            "updatedAt":1710000000000
        }"#,
    )
    .expect("decode pve resume intent");
    assert_eq!(pve_resume.owner_user_id, 77);
    assert_eq!(pve_resume.monster_ids, vec!["wolf-1", "wolf-2"]);

    let session: OnlineBattleSessionSnapshotRedis = decode_json(
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
    .expect("decode session projection");
    assert_eq!(session.session_id, "session-1");
    assert_eq!(session.participant_user_ids, vec![77, 88]);

    let character: OnlineBattleCharacterSnapshotRedis = decode_json(
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
    .expect("decode online character snapshot");
    assert_eq!(character.character_id, 9001);
    assert_eq!(character.user_id, 77);

    let team: TeamMemberProjectionRedis = decode_json(
        r#"{
            "teamId":"team-1",
            "role":"leader",
            "memberCharacterIds":[9001,9002]
        }"#,
    )
    .expect("decode team member projection");
    assert_eq!(team.member_character_ids, vec![9001, 9002]);

    let resource: CharacterRuntimeResourceRedis =
        decode_json(r#"{"qixue":88,"lingqi":21}"#).expect("decode character runtime resource");
    assert_eq!(resource.qixue, 88);
    assert_eq!(resource.lingqi, 21);

    let tower_progress: TowerProgressProjectionRedis = decode_json(
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
    .expect("decode tower progress projection");
    assert_eq!(tower_progress.character_id, 9001);
    assert_eq!(tower_progress.best_floor, 18);
    assert_eq!(
        tower_progress.current_battle_id.as_deref(),
        Some("tower-battle-1")
    );

    let tower_runtime: TowerBattleRuntimeProjectionRedis = decode_json(
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
    .expect("decode tower runtime projection");
    assert_eq!(tower_runtime.battle_id, "tower-battle-1");
    assert_eq!(tower_runtime.preview.kind, "elite");
    assert_eq!(tower_runtime.preview.monster_ids, vec!["tower-monster-1"]);

    let idle_lock = IdleLockToken::parse("idle-start:550e8400-e29b-41d4-a716-446655440000")
        .expect("parse idle lock token");
    assert_eq!(idle_lock.kind(), "idle-start");
    assert_eq!(
        idle_lock.as_str(),
        "idle-start:550e8400-e29b-41d4-a716-446655440000"
    );
}
