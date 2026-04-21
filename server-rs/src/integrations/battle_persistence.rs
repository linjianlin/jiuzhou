use crate::battle_runtime::BattleStateDto;
use crate::integrations::redis::RedisRuntime;
use crate::shared::error::AppError;
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

const BATTLE_PERSIST_TTL_SEC: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BattlePersistenceRecoverySummary {
    pub recovered_battle_count: usize,
    pub pve_count: usize,
    pub pvp_count: usize,
    pub arena_count: usize,
    pub dungeon_count: usize,
    pub tower_count: usize,
}

pub fn build_battle_snapshot_key(battle_id: &str) -> String {
    format!("battle:snapshot:{battle_id}")
}

pub fn build_battle_projection_key(battle_id: &str) -> String {
    format!("battle:projection:{battle_id}")
}

pub fn build_battle_session_key(session_id: &str) -> String {
    format!("battle:session:{session_id}")
}

fn parse_battle_id_from_projection_key(key: &str) -> Option<&str> {
    key.strip_prefix("battle:projection:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn parse_session_id_from_session_key(key: &str) -> Option<&str> {
    key.strip_prefix("battle:session:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn redis_runtime_from_state(state: &AppState) -> Option<RedisRuntime> {
    state.redis.clone().map(RedisRuntime::new)
}

fn deserialize_battle_snapshot(raw: &str) -> Result<BattleStateDto, serde_json::Error> {
    serde_json::from_str::<BattleStateDto>(raw)
}

fn deserialize_battle_projection(
    raw: &str,
) -> Result<OnlineBattleProjectionRecord, serde_json::Error> {
    serde_json::from_str::<OnlineBattleProjectionRecord>(raw)
}

fn deserialize_battle_session(raw: &str) -> Result<BattleSessionSnapshotDto, serde_json::Error> {
    serde_json::from_str::<BattleSessionSnapshotDto>(raw)
}

pub async fn persist_battle_snapshot(
    state: &AppState,
    snapshot: &BattleStateDto,
) -> Result<(), AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(());
    };
    let payload = serde_json::to_string(snapshot).map_err(|error| {
        AppError::config(format!("failed to serialize battle snapshot: {error}"))
    })?;
    redis
        .set_string_ex(
            &build_battle_snapshot_key(&snapshot.battle_id),
            &payload,
            BATTLE_PERSIST_TTL_SEC,
        )
        .await
}

pub async fn persist_battle_projection(
    state: &AppState,
    projection: &OnlineBattleProjectionRecord,
) -> Result<(), AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(());
    };
    let payload = serde_json::to_string(projection).map_err(|error| {
        AppError::config(format!("failed to serialize battle projection: {error}"))
    })?;
    redis
        .set_string_ex(
            &build_battle_projection_key(&projection.battle_id),
            &payload,
            BATTLE_PERSIST_TTL_SEC,
        )
        .await
}

pub async fn persist_battle_session(
    state: &AppState,
    session: &BattleSessionSnapshotDto,
) -> Result<(), AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(());
    };
    let payload = serde_json::to_string(session).map_err(|error| {
        AppError::config(format!("failed to serialize battle session: {error}"))
    })?;
    redis
        .set_string_ex(
            &build_battle_session_key(&session.session_id),
            &payload,
            BATTLE_PERSIST_TTL_SEC,
        )
        .await
}

pub async fn load_battle_snapshot(
    state: &AppState,
    battle_id: &str,
) -> Result<Option<BattleStateDto>, AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(None);
    };
    let Some(raw) = redis
        .get_string(&build_battle_snapshot_key(battle_id))
        .await?
    else {
        return Ok(None);
    };
    let payload = deserialize_battle_snapshot(&raw).map_err(|error| {
        AppError::config(format!("failed to deserialize battle snapshot: {error}"))
    })?;
    Ok(Some(payload))
}

pub async fn load_battle_projection(
    state: &AppState,
    battle_id: &str,
) -> Result<Option<OnlineBattleProjectionRecord>, AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(None);
    };
    let Some(raw) = redis
        .get_string(&build_battle_projection_key(battle_id))
        .await?
    else {
        return Ok(None);
    };
    let payload = deserialize_battle_projection(&raw).map_err(|error| {
        AppError::config(format!("failed to deserialize battle projection: {error}"))
    })?;
    Ok(Some(payload))
}

pub async fn load_battle_session(
    state: &AppState,
    session_id: &str,
) -> Result<Option<BattleSessionSnapshotDto>, AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(None);
    };
    let Some(raw) = redis
        .get_string(&build_battle_session_key(session_id))
        .await?
    else {
        return Ok(None);
    };
    let payload = deserialize_battle_session(&raw).map_err(|error| {
        AppError::config(format!("failed to deserialize battle session: {error}"))
    })?;
    Ok(Some(payload))
}

pub async fn clear_battle_persistence(
    state: &AppState,
    battle_id: &str,
    session_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(());
    };
    let battle_snapshot_key = build_battle_snapshot_key(battle_id);
    let battle_projection_key = build_battle_projection_key(battle_id);
    if let Some(session_id) = session_id {
        let session_key = build_battle_session_key(session_id);
        redis
            .del_many(&[
                battle_snapshot_key.as_str(),
                battle_projection_key.as_str(),
                session_key.as_str(),
            ])
            .await
    } else {
        redis
            .del_many(&[battle_snapshot_key.as_str(), battle_projection_key.as_str()])
            .await
    }
}

pub async fn recover_battle_bundle(state: &AppState, battle_id: &str) -> Result<bool, AppError> {
    if state.battle_runtime.get(battle_id).is_some()
        && state
            .online_battle_projections
            .get_by_battle_id(battle_id)
            .is_some()
    {
        return Ok(true);
    }
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(false);
    };
    let Some(projection_raw) = redis
        .get_string(&build_battle_projection_key(battle_id))
        .await?
    else {
        return Ok(false);
    };
    let projection = match deserialize_battle_projection(&projection_raw) {
        Ok(projection) => projection,
        Err(error) => {
            tracing::warn!(
                battle_id,
                error = %error,
                "discarding persisted battle bundle with invalid projection"
            );
            clear_battle_persistence(state, battle_id, None).await?;
            return Ok(false);
        }
    };
    let Some(snapshot_raw) = redis
        .get_string(&build_battle_snapshot_key(battle_id))
        .await?
    else {
        return Ok(false);
    };
    let snapshot = match deserialize_battle_snapshot(&snapshot_raw) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::warn!(
                battle_id,
                session_id = projection.session_id.as_deref().unwrap_or(""),
                error = %error,
                "discarding persisted battle bundle with invalid snapshot"
            );
            clear_battle_persistence(state, battle_id, projection.session_id.as_deref()).await?;
            return Ok(false);
        }
    };
    if let Some(session_id) = projection.session_id.as_deref() {
        if let Some(session_raw) = redis
            .get_string(&build_battle_session_key(session_id))
            .await?
        {
            match deserialize_battle_session(&session_raw) {
                Ok(session) => state.battle_sessions.register(session),
                Err(error) => {
                    tracing::warn!(
                        battle_id,
                        session_id,
                        error = %error,
                        "discarding persisted battle bundle with invalid session"
                    );
                    clear_battle_persistence(state, battle_id, Some(session_id)).await?;
                    return Ok(false);
                }
            }
        }
    }
    state.online_battle_projections.register(projection);
    state.battle_runtime.register(snapshot);
    Ok(true)
}

fn classify_recovered_battle_family(
    projection: &OnlineBattleProjectionRecord,
    session: Option<&BattleSessionSnapshotDto>,
) -> &'static str {
    if let Some(session) = session {
        match &session.context {
            BattleSessionContextDto::Dungeon { .. } => return "dungeon",
            BattleSessionContextDto::Tower { .. } => return "tower",
            BattleSessionContextDto::Pvp { mode, .. } if mode == "arena" => return "arena",
            BattleSessionContextDto::Pvp { .. } => return "pvp",
            BattleSessionContextDto::Pve { .. } => return "pve",
        }
    }
    match projection.r#type.trim() {
        "pvp" => "pvp",
        _ => "pve",
    }
}

pub async fn recover_all_battle_bundles(
    state: &AppState,
) -> Result<BattlePersistenceRecoverySummary, AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(BattlePersistenceRecoverySummary::default());
    };
    let keys = redis.scan_match("battle:projection:*", 200).await?;
    let mut summary = BattlePersistenceRecoverySummary::default();
    for key in keys {
        let Some(battle_id) = parse_battle_id_from_projection_key(&key) else {
            continue;
        };
        if recover_battle_bundle(state, battle_id).await? {
            summary.recovered_battle_count += 1;
            if let Some(projection) = state.online_battle_projections.get_by_battle_id(battle_id) {
                let session = projection
                    .session_id
                    .as_deref()
                    .and_then(|session_id| state.battle_sessions.get_by_session_id(session_id));
                match classify_recovered_battle_family(&projection, session.as_ref()) {
                    "arena" => summary.arena_count += 1,
                    "dungeon" => summary.dungeon_count += 1,
                    "tower" => summary.tower_count += 1,
                    "pvp" => summary.pvp_count += 1,
                    _ => summary.pve_count += 1,
                }
            }
        }
    }
    Ok(summary)
}

pub async fn recover_all_orphan_battle_sessions(state: &AppState) -> Result<usize, AppError> {
    let Some(redis) = redis_runtime_from_state(state) else {
        return Ok(0);
    };
    let keys = redis.scan_match("battle:session:*", 200).await?;
    let mut recovered = 0_usize;
    for key in keys {
        let Some(session_id) = parse_session_id_from_session_key(&key) else {
            continue;
        };
        if state
            .battle_sessions
            .get_by_session_id(session_id)
            .is_some()
        {
            continue;
        }
        let Some(raw) = redis
            .get_string(&build_battle_session_key(session_id))
            .await?
        else {
            continue;
        };
        let session = match deserialize_battle_session(&raw) {
            Ok(session) => session,
            Err(error) => {
                tracing::warn!(
                    session_id,
                    error = %error,
                    "discarding invalid orphan battle session"
                );
                let session_key = build_battle_session_key(session_id);
                redis.del_many(&[session_key.as_str()]).await?;
                continue;
            }
        };
        if session
            .current_battle_id
            .as_deref()
            .is_some_and(|battle_id| {
                state
                    .online_battle_projections
                    .get_by_battle_id(battle_id)
                    .is_some()
            })
        {
            continue;
        }
        state.battle_sessions.register(session);
        recovered += 1;
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::{
        BattlePersistenceRecoverySummary, build_battle_projection_key, build_battle_session_key,
        build_battle_snapshot_key, classify_recovered_battle_family, deserialize_battle_snapshot,
        parse_battle_id_from_projection_key, parse_session_id_from_session_key,
    };
    use crate::battle_runtime::build_minimal_pve_battle_state;
    use crate::state::{
        BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
    };

    #[test]
    fn battle_persistence_keys_are_stable() {
        assert_eq!(
            build_battle_snapshot_key("battle-1"),
            "battle:snapshot:battle-1"
        );
        assert_eq!(
            build_battle_projection_key("battle-1"),
            "battle:projection:battle-1"
        );
        assert_eq!(
            build_battle_session_key("session-1"),
            "battle:session:session-1"
        );
    }

    #[test]
    fn projection_key_parser_extracts_battle_id() {
        assert_eq!(
            parse_battle_id_from_projection_key("battle:projection:battle-1"),
            Some("battle-1")
        );
        assert_eq!(
            parse_battle_id_from_projection_key("battle:projection:"),
            None
        );
        assert_eq!(
            parse_battle_id_from_projection_key("battle:snapshot:battle-1"),
            None
        );
    }

    #[test]
    fn session_key_parser_extracts_session_id() {
        assert_eq!(
            parse_session_id_from_session_key("battle:session:session-1"),
            Some("session-1")
        );
        assert_eq!(parse_session_id_from_session_key("battle:session:"), None);
        assert_eq!(
            parse_session_id_from_session_key("battle:projection:battle-1"),
            None
        );
    }

    #[test]
    fn recovered_battle_family_classification_prefers_session_context() {
        let projection = OnlineBattleProjectionRecord {
            battle_id: "battle-1".to_string(),
            owner_user_id: 1,
            participant_user_ids: vec![1],
            r#type: "pve".to_string(),
            session_id: Some("tower-session-1".to_string()),
        };
        let tower_session = BattleSessionSnapshotDto {
            session_id: "tower-session-1".to_string(),
            session_type: "tower".to_string(),
            owner_user_id: 1,
            participant_user_ids: vec![1],
            current_battle_id: Some("battle-1".to_string()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Tower {
                run_id: "run-1".to_string(),
                floor: 3,
            },
        };
        assert_eq!(
            classify_recovered_battle_family(&projection, Some(&tower_session)),
            "tower"
        );
        assert_eq!(classify_recovered_battle_family(&projection, None), "pve");
    }

    #[test]
    fn battle_snapshot_deserializer_accepts_current_contract() {
        let snapshot = build_minimal_pve_battle_state(
            "battle-current-contract",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let raw = serde_json::to_string(&snapshot).expect("snapshot should serialize");
        let decoded = deserialize_battle_snapshot(&raw).expect("snapshot should deserialize");
        assert_eq!(decoded.battle_id, "battle-current-contract");
        assert!(decoded.teams.attacker.units[0].current_attrs.wugong > 0);
    }

    #[test]
    fn battle_snapshot_deserializer_rejects_old_unit_contract() {
        let raw = r#"{"battleId":"battle-old-contract","battleType":"pve","cooldownTimingMode":"self_action_end","teams":{"attacker":{"odwnerId":1,"units":[{"id":"player-1","name":"修士1","type":"player","sourceId":1,"baseAttrs":{"max_qixue":180,"max_lingqi":100},"qixue":180,"lingqi":100,"currentAttrs":{"max_qixue":180,"max_lingqi":100},"shields":[],"isAlive":true,"canAct":true,"buffs":[],"marks":[],"momentum":null,"setBonusEffects":[],"skills":[],"skillCooldowns":{},"skillCooldownDiscountBank":{},"controlDiminishing":{},"stats":{"damageDealt":0,"damageTaken":0,"healingDone":0,"healingReceived":0,"killCount":0}}],"totalSpeed":1},"defender":{"odwnerId":null,"units":[],"totalSpeed":0}},"roundCount":1,"currentTeam":"attacker","currentUnitId":"player-1","phase":"action","firstMover":"attacker","result":null,"randomSeed":1,"randomIndex":0}"#;
        assert!(deserialize_battle_snapshot(raw).is_err());
    }

    #[test]
    fn battle_persistence_recovery_summary_defaults_to_zero() {
        assert_eq!(
            BattlePersistenceRecoverySummary::default(),
            BattlePersistenceRecoverySummary {
                recovered_battle_count: 0,
                pve_count: 0,
                pvp_count: 0,
                arena_count: 0,
                dungeon_count: 0,
                tower_count: 0,
            }
        );
    }
}
