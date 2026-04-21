use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::{
    BattleStateDto, apply_minimal_pve_action, apply_minimal_pvp_action,
    build_minimal_pve_battle_state, resolve_minimal_pve_item_rewards,
};
use crate::integrations::battle_character_profile::hydrate_pve_battle_state_owner;
use crate::integrations::battle_persistence::{
    clear_battle_persistence, persist_battle_projection, persist_battle_session,
    persist_battle_snapshot,
};
use crate::jobs::online_battle_settlement::{
    ArenaBattleSettlementTaskPayload, GenericPveSettlementTaskPayload,
    TowerWinSettlementTaskPayload, enqueue_arena_battle_settlement_task,
    enqueue_generic_pve_settlement_task, enqueue_tower_win_settlement_task,
};
use crate::realtime::arena::build_arena_refresh_payload;
use crate::realtime::battle::{
    BattleCooldownPayload, BattleFinishedMeta, BattleRealtimePayload, BattleRewardsPayload,
    build_battle_abandoned_payload, build_battle_cooldown_ready_payload,
    build_battle_cooldown_sync_payload, build_battle_finished_payload,
    build_battle_started_payload, build_battle_state_payload, build_reward_item_values,
    build_single_player_reward_values,
};
use crate::realtime::public_socket::{
    emit_battle_cooldown_to_participants, emit_battle_update_to_participants,
    emit_game_character_full_to_user,
};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleStartPayload {
    pub monster_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleAbandonPayload {
    pub battle_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleActionPayload {
    pub battle_id: Option<String>,
    pub skill_id: Option<String>,
    pub target_ids: Option<Vec<String>>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleStartDataDto {
    pub battle_id: Option<String>,
    pub state: Option<serde_json::Value>,
    pub logs: Option<Vec<serde_json::Value>>,
    pub debug_realtime: Option<BattleRealtimePayload>,
    pub reason: Option<String>,
    pub is_team_battle: Option<bool>,
    pub team_member_count: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleActionDataDto {
    pub session: Option<BattleSessionSnapshotDto>,
    pub state: Option<BattleStateDto>,
    pub logs: Option<Vec<serde_json::Value>>,
    pub debug_realtime: Option<BattleRealtimePayload>,
    pub debug_cooldown_realtime: Option<BattleCooldownPayload>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleAbandonDataDto {
    pub finished: bool,
    pub session: Option<BattleSessionSnapshotDto>,
    pub debug_realtime: Option<BattleRealtimePayload>,
}

#[derive(Debug, Deserialize)]
struct MapSeedFile {
    maps: Vec<MapSeed>,
}

#[derive(Debug, Deserialize)]
struct MapSeed {
    id: String,
    enabled: Option<bool>,
    rooms: Vec<MapRoomSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomSeed {
    id: String,
    monsters: Vec<MapRoomMonsterSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomMonsterSeed {
    monster_def_id: String,
}

pub async fn start_pve_battle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BattleStartPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let monster_ids = payload
        .monster_ids
        .unwrap_or_default()
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .take(5)
        .collect::<Vec<_>>();
    if monster_ids.is_empty() {
        return Err(AppError::config("请指定战斗目标"));
    }
    let character_id = auth::get_character_id_by_user_id(&state, actor.user_id)
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;
    let (map_id, room_id) = load_character_location(&state, character_id).await?;
    if map_id.trim().is_empty() || room_id.trim().is_empty() {
        return Err(AppError::config("角色位置异常，无法战斗"));
    }
    let room_monster_ids = load_room_monster_ids(map_id.trim(), room_id.trim())?;
    if room_monster_ids.is_empty() {
        return Err(AppError::config("当前房间不存在可战斗目标"));
    }
    let room_monster_id_set = room_monster_ids.into_iter().collect::<BTreeSet<_>>();
    if monster_ids
        .iter()
        .any(|monster_id| !room_monster_id_set.contains(monster_id))
    {
        return Err(AppError::config("战斗目标不在当前房间"));
    }

    let battle_id = format!("pve-battle-{}-{}", actor.user_id, now_millis());
    let session = BattleSessionSnapshotDto {
        session_id: format!("pve-session-{}", battle_id),
        session_type: "pve".to_string(),
        owner_user_id: actor.user_id,
        participant_user_ids: vec![actor.user_id],
        current_battle_id: Some(battle_id.clone()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: BattleSessionContextDto::Pve { monster_ids },
    };
    let mut battle_state = build_minimal_pve_battle_state(
        &battle_id,
        character_id,
        match &session.context {
            BattleSessionContextDto::Pve { monster_ids } => monster_ids,
            _ => unreachable!(),
        },
    );
    hydrate_pve_battle_state_owner(&state, &mut battle_state, character_id).await?;
    state.battle_sessions.register(session);
    state.battle_runtime.register(battle_state.clone());
    let projection = OnlineBattleProjectionRecord {
        battle_id: battle_id.clone(),
        owner_user_id: actor.user_id,
        participant_user_ids: vec![actor.user_id],
        r#type: "pve".to_string(),
        session_id: Some(format!("pve-session-{}", battle_id)),
    };
    state.online_battle_projections.register(projection.clone());
    if let Some(session) = state.battle_sessions.get_by_battle_id(&battle_id) {
        persist_battle_session(&state, &session).await?;
    }
    persist_battle_snapshot(&state, &battle_state).await?;
    persist_battle_projection(&state, &projection).await?;
    let logs = vec![serde_json::json!({"type": "round_start", "round": 1})];
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        logs.clone(),
        state.battle_sessions.get_by_battle_id(&battle_id),
    );
    emit_battle_update_to_participants(&state, &[actor.user_id], &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(&state, &[actor.user_id], &debug_cooldown_realtime);
    Ok(send_result(ServiceResult {
        success: true,
        message: None,
        data: Some(BattleStartDataDto {
            battle_id: Some(battle_id),
            state: Some(serde_json::to_value(battle_state).map_err(|error| {
                AppError::config(format!("failed to serialize battle state: {error}"))
            })?),
            logs: Some(logs),
            debug_realtime: Some(debug_realtime),
            reason: None,
            is_team_battle: Some(false),
            team_member_count: Some(1),
        }),
    }))
}

pub async fn abandon_battle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BattleAbandonPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let battle_id = payload.battle_id.unwrap_or_default();
    if battle_id.trim().is_empty() {
        return Err(AppError::config("缺少战斗ID"));
    }
    let Some(session) = state.battle_sessions.get_by_battle_id(battle_id.trim()) else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("战斗不存在".to_string()),
            data: None,
        }));
    };
    if session.owner_user_id != actor.user_id
        && !session.participant_user_ids.contains(&actor.user_id)
    {
        return Err(AppError::unauthorized("无权操作该战斗"));
    }
    if let crate::state::BattleSessionContextDto::Dungeon { instance_id } = session.context.clone()
    {
        state.database.execute(
            "UPDATE dungeon_instance SET status = 'failed', end_time = NOW(), instance_data = COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId' WHERE id = $1",
            |q| q.bind(instance_id),
        ).await?;
    }
    let updated_session = state.battle_sessions.update(&session.session_id, |record| {
        record.current_battle_id = None;
        record.status = "abandoned".to_string();
        record.next_action = "none".to_string();
        record.can_advance = false;
    });
    state.battle_runtime.clear(battle_id.trim());
    state.online_battle_projections.clear(battle_id.trim());
    clear_battle_persistence(&state, battle_id.trim(), Some(&session.session_id)).await?;
    let debug_realtime = build_battle_abandoned_payload(
        battle_id.trim(),
        updated_session.clone(),
        true,
        "已放弃战斗",
    );
    emit_battle_update_to_participants(&state, &session.participant_user_ids, &debug_realtime);
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("已放弃战斗".to_string()),
        data: Some(BattleAbandonDataDto {
            finished: true,
            session: updated_session,
            debug_realtime: Some(debug_realtime),
        }),
    }))
}

pub async fn battle_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BattleActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let battle_id = payload.battle_id.unwrap_or_default();
    let skill_id = payload.skill_id.unwrap_or_default();
    let target_ids = payload.target_ids.unwrap_or_default();
    if battle_id.trim().is_empty() {
        return Err(AppError::config("缺少战斗ID"));
    }
    if skill_id.trim().is_empty() {
        return Err(AppError::config("缺少技能ID"));
    }
    let projection = state
        .online_battle_projections
        .get_by_battle_id(battle_id.trim())
        .ok_or_else(|| AppError::config("战斗不存在"))?;
    if projection.owner_user_id != actor.user_id
        && !projection.participant_user_ids.contains(&actor.user_id)
    {
        return Err(AppError::unauthorized("无权操作此战斗"));
    }
    let character_id = auth::get_character_id_by_user_id(&state, actor.user_id)
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;
    let mut action_outcome = None;
    let state_snapshot = state
        .battle_runtime
        .update(battle_id.trim(), |state| {
            action_outcome = Some(match state.battle_type.as_str() {
                "pvp" => apply_minimal_pvp_action(state, character_id, &target_ids),
                _ => apply_minimal_pve_action(state, character_id, skill_id.trim(), &target_ids),
            });
        })
        .ok_or_else(|| AppError::config("战斗不存在"))?;
    let action_outcome = action_outcome
        .ok_or_else(|| AppError::config("战斗不存在"))?
        .map_err(AppError::config)?;

    let session = projection.session_id.as_deref().and_then(|session_id| {
        state.battle_sessions.update(session_id, |record| {
            if action_outcome.finished {
                match &record.context {
                    BattleSessionContextDto::Tower { .. }
                        if matches!(action_outcome.result.as_deref(), Some("attacker_win")) =>
                    {
                        record.status = "waiting_transition".to_string();
                        record.next_action = "advance".to_string();
                        record.can_advance = true;
                    }
                    _ => {
                        record.next_action = "return_to_map".to_string();
                        record.can_advance = true;
                    }
                }
                record.last_result = action_outcome.result.clone();
            }
        })
    });

    let mut defer_character_full_refresh = false;
    let reward_items = session
        .as_ref()
        .and_then(|session| match &session.context {
            BattleSessionContextDto::Pve { monster_ids }
                if action_outcome.finished
                    && matches!(state_snapshot.result.as_deref(), Some("attacker_win")) =>
            {
                resolve_minimal_pve_item_rewards(monster_ids).ok()
            }
            _ => None,
        })
        .unwrap_or_default();
    if action_outcome.finished {
        if let Some(session) = session.as_ref() {
            if let BattleSessionContextDto::Pvp {
                opponent_character_id,
                mode,
            } = &session.context
            {
                if mode == "arena" {
                    enqueue_arena_battle_settlement_task(
                        &state,
                        battle_id.trim(),
                        &ArenaBattleSettlementTaskPayload {
                            schema_version: 1,
                            challenger_character_id: character_id,
                            opponent_character_id: *opponent_character_id,
                            battle_result: state_snapshot
                                .result
                                .clone()
                                .unwrap_or_else(|| "draw".to_string()),
                        },
                    )
                    .await?;
                }
            }
            if let BattleSessionContextDto::Tower { run_id, floor } = &session.context {
                if matches!(state_snapshot.result.as_deref(), Some("attacker_win")) {
                    enqueue_tower_win_settlement_task(
                        &state,
                        battle_id.trim(),
                        &TowerWinSettlementTaskPayload {
                            schema_version: 1,
                            character_id,
                            user_id: actor.user_id,
                            run_id: run_id.clone(),
                            floor: *floor,
                            exp_gained: action_outcome.exp_gained,
                            silver_gained: action_outcome.silver_gained,
                        },
                    )
                    .await?;
                    defer_character_full_refresh = true;
                }
            } else if matches!(state_snapshot.battle_type.as_str(), "pve")
                && matches!(state_snapshot.result.as_deref(), Some("attacker_win"))
                && (action_outcome.exp_gained > 0 || action_outcome.silver_gained > 0)
            {
                enqueue_generic_pve_settlement_task(
                    &state,
                    battle_id.trim(),
                    &GenericPveSettlementTaskPayload {
                        schema_version: 1,
                        character_id,
                        user_id: actor.user_id,
                        exp_gained: action_outcome.exp_gained,
                        silver_gained: action_outcome.silver_gained,
                        reward_items: reward_items.clone(),
                    },
                )
                .await?;
                defer_character_full_refresh = true;
            }
        }
    }

    persist_battle_snapshot(&state, &state_snapshot).await?;
    persist_battle_projection(&state, &projection).await?;
    if let Some(session) = session.as_ref() {
        persist_battle_session(&state, session).await?;
    }

    let logs = vec![serde_json::json!({
        "type": if action_outcome.finished { "finish" } else { "action" },
        "round": state_snapshot.round_count,
        "result": action_outcome.result,
        "skillId": skill_id.trim(),
    })];
    let debug_realtime = if action_outcome.finished {
        build_battle_finished_payload(
            battle_id.trim(),
            state_snapshot.clone(),
            logs.clone(),
            session.clone(),
            BattleFinishedMeta {
                rewards: Some(BattleRewardsPayload {
                    exp: action_outcome.exp_gained,
                    silver: action_outcome.silver_gained,
                    total_exp: None,
                    total_silver: None,
                    participant_count: Some(projection.participant_user_ids.len() as i64),
                    items: Some(build_reward_item_values(&reward_items)),
                    per_player_rewards: Some(build_single_player_reward_values(
                        actor.user_id,
                        character_id,
                        action_outcome.exp_gained,
                        action_outcome.silver_gained,
                        &reward_items,
                    )),
                }),
                result: state_snapshot.result.clone(),
                success: Some(matches!(
                    state_snapshot.result.as_deref(),
                    Some("attacker_win")
                )),
                message: Some(match state_snapshot.result.as_deref() {
                    Some("attacker_win") => "战斗胜利".to_string(),
                    Some("defender_win") => "战斗失败".to_string(),
                    Some("draw") => "战斗平局".to_string(),
                    _ => "战斗结束".to_string(),
                }),
            },
        )
    } else {
        build_battle_state_payload(
            battle_id.trim(),
            state_snapshot.clone(),
            logs.clone(),
            session.clone(),
        )
    };
    emit_battle_update_to_participants(&state, &projection.participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime = if action_outcome.finished {
        build_battle_cooldown_ready_payload(state_snapshot.current_unit_id.as_deref())
    } else {
        build_battle_cooldown_sync_payload(state_snapshot.current_unit_id.as_deref(), 1500)
    };
    emit_battle_cooldown_to_participants(
        &state,
        &projection.participant_user_ids,
        &debug_cooldown_realtime,
    );
    if action_outcome.finished
        && projection.owner_user_id == actor.user_id
        && !defer_character_full_refresh
    {
        let _ = emit_game_character_full_to_user(&state, actor.user_id).await;
    }
    if let Some(owner_user_id) =
        arena_refresh_target_user_id(session.as_ref(), action_outcome.finished)
    {
        crate::realtime::public_socket::emit_arena_update_to_user(
            &state,
            owner_user_id,
            &build_arena_refresh_payload(),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: None,
        data: Some(BattleActionDataDto {
            session,
            state: Some(state_snapshot),
            logs: Some(logs),
            debug_realtime: Some(debug_realtime),
            debug_cooldown_realtime: Some(debug_cooldown_realtime),
        }),
    }))
}

fn arena_refresh_target_user_id(
    session: Option<&BattleSessionSnapshotDto>,
    finished: bool,
) -> Option<i64> {
    if !finished {
        return None;
    }
    let session = session?;
    let crate::state::BattleSessionContextDto::Pvp { mode, .. } = &session.context else {
        return None;
    };
    if mode != "arena" {
        return None;
    }
    Some(session.owner_user_id)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

async fn load_character_location(
    state: &AppState,
    character_id: i64,
) -> Result<(String, String), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT current_map_id, current_room_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok((String::new(), String::new()));
    };
    Ok((
        row.try_get::<Option<String>, _>("current_map_id")?
            .unwrap_or_default(),
        row.try_get::<Option<String>, _>("current_room_id")?
            .unwrap_or_default(),
    ))
}

fn load_room_monster_ids(map_id: &str, room_id: &str) -> Result<Vec<String>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: MapSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let Some(map) = payload
        .maps
        .into_iter()
        .find(|map| map.id == map_id && map.enabled != Some(false))
    else {
        return Ok(Vec::new());
    };
    let Some(room) = map.rooms.into_iter().find(|room| room.id == room_id) else {
        return Ok(Vec::new());
    };
    Ok(room
        .monsters
        .into_iter()
        .map(|monster| monster.monster_def_id.trim().to_string())
        .filter(|monster_id| !monster_id.is_empty())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::load_room_monster_ids;

    #[test]
    fn battle_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"battleId": "pve-battle-1-123", "state": {"battleId": "pve-battle-1-123", "currentTeam": "attacker"}, "logs": [{"type": "round_start", "round": 1}], "debugRealtime": {"kind": "battle_started"}, "reason": null, "isTeamBattle": false, "teamMemberCount": 1}
        });
        assert_eq!(payload["data"]["battleId"], "pve-battle-1-123");
        assert_eq!(payload["data"]["state"]["currentTeam"], "attacker");
        assert_eq!(payload["data"]["logs"][0]["type"], "round_start");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "battle_started");
        println!("BATTLE_START_RESPONSE={}", payload);
    }

    #[test]
    fn battle_abandon_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已放弃战斗",
            "data": {"finished": true, "session": {"status": "abandoned"}, "debugRealtime": {"kind": "battle_abandoned"}}
        });
        assert_eq!(payload["message"], "已放弃战斗");
        assert_eq!(payload["data"]["finished"], true);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "battle_abandoned");
        println!("BATTLE_ABANDON_RESPONSE={}", payload);
    }

    #[test]
    fn battle_action_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "state": {
                    "battleId": "pve-battle-1-123",
                    "phase": "finished",
                    "result": "attacker_win"
                },
                "logs": [{"type": "finish", "round": 1, "result": "attacker_win"}],
                "debugRealtime": {"kind": "battle_finished"},
                "debugCooldownRealtime": {"kind": "battle:cooldown-ready", "cooldownMs": 0},
                "session": {
                    "sessionId": "pve-session-pve-battle-1-123",
                    "nextAction": "return_to_map",
                    "canAdvance": true,
                    "lastResult": "attacker_win"
                }
            }
        });
        assert_eq!(payload["data"]["session"]["nextAction"], "return_to_map");
        assert_eq!(payload["data"]["state"]["phase"], "finished");
        assert_eq!(payload["data"]["logs"][0]["type"], "finish");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "battle_finished");
        assert_eq!(
            payload["data"]["debugCooldownRealtime"]["kind"],
            "battle:cooldown-ready"
        );
        println!("BATTLE_ACTION_RESPONSE={}", payload);
    }

    #[test]
    fn room_monster_loader_only_returns_monsters_in_selected_room() {
        let monsters = load_room_monster_ids("map-qingyun-outskirts", "room-south-forest")
            .expect("room monsters should load");
        assert_eq!(monsters, vec!["monster-wild-rabbit".to_string()]);
    }
}
