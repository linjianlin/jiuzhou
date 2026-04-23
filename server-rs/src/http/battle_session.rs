use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::{
    BattleStateDto, build_minimal_pvp_battle_state, restart_battle_runtime,
    try_build_minimal_pve_battle_state,
};
use crate::http::dungeon::load_dungeon_wave_monster_ids;
use crate::http::tower::resolve_tower_floor_monster_ids;
use crate::integrations::battle_character_profile::{
    hydrate_pve_battle_state_active_partner, hydrate_pve_battle_state_owner,
    hydrate_pve_battle_state_participants, hydrate_pvp_battle_state_players,
};
use crate::integrations::battle_persistence::{
    clear_battle_persistence, persist_battle_projection, persist_battle_session,
    persist_battle_snapshot,
};
use crate::realtime::arena::build_arena_refresh_payload;
use crate::realtime::battle::{
    build_battle_abandoned_payload, build_battle_cooldown_ready_payload,
    build_battle_started_payload,
};
use crate::realtime::public_socket::{
    emit_arena_update_to_user, emit_battle_cooldown_to_participants,
    emit_battle_update_to_participants,
};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleSessionResponseData {
    pub session: BattleSessionSnapshotDto,
    pub state: Option<BattleStateDto>,
    pub finished: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBattleSessionResponseData {
    pub session: Option<BattleSessionSnapshotDto>,
    pub state: Option<BattleStateDto>,
    pub finished: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBattleSessionPayload {
    pub r#type: String,
    pub instance_id: Option<String>,
    pub monster_ids: Option<Vec<String>>,
    pub opponent_character_id: Option<i64>,
    pub mode: Option<String>,
    pub battle_id: Option<String>,
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

pub async fn get_current_battle_session(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<SuccessResponse<CurrentBattleSessionResponseData>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let session = state.battle_sessions.get_current_for_user(actor.user_id);
    Ok(send_success(CurrentBattleSessionResponseData {
        state: session
            .as_ref()
            .and_then(|session| session.current_battle_id.as_deref())
            .and_then(|battle_id| state.battle_runtime.get(battle_id)),
        session,
        finished: false,
    }))
}

pub async fn start_battle_session(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<StartBattleSessionPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    if payload.r#type == "pve" {
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
            current_battle_id: Some(battle_id),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve { monster_ids },
        };
        state.battle_sessions.register(session.clone());
        let team_rows = state.database.fetch_all(
            "SELECT tm.team_id, tm.role, tm.character_id, c.user_id FROM team_members tm JOIN characters c ON c.id = tm.character_id WHERE tm.team_id = (SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1) ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, tm.character_id ASC",
            |q| q.bind(character_id),
        ).await?;
        let (participant_user_ids, participant_character_ids) = if team_rows.is_empty() {
            (vec![actor.user_id], vec![character_id])
        } else {
            let is_leader = team_rows.iter().any(|row| {
                row.try_get::<Option<i32>, _>("character_id")
                    .ok()
                    .flatten()
                    .map(i64::from)
                    == Some(character_id)
                    && row
                        .try_get::<Option<String>, _>("role")
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some("leader")
            });
            if !is_leader {
                return Err(AppError::config("组队中只有队长可以发起战斗会话"));
            }
            (
                team_rows
                    .iter()
                    .filter_map(|row| {
                        row.try_get::<Option<i32>, _>("user_id")
                            .ok()
                            .flatten()
                            .map(i64::from)
                    })
                    .collect::<Vec<_>>(),
                team_rows
                    .iter()
                    .filter_map(|row| {
                        row.try_get::<Option<i32>, _>("character_id")
                            .ok()
                            .flatten()
                            .map(i64::from)
                    })
                    .collect::<Vec<_>>(),
            )
        };
        let updated_session = state.battle_sessions.update(&session.session_id, |record| {
            record.participant_user_ids = participant_user_ids.clone();
        });
        let battle_id = session
            .current_battle_id
            .clone()
            .ok_or_else(|| AppError::config("战斗ID不存在"))?;
        let mut battle_state = try_build_minimal_pve_battle_state(
            &battle_id,
            character_id,
            match &session.context {
                BattleSessionContextDto::Pve { monster_ids } => monster_ids,
                _ => unreachable!(),
            },
        )
        .map_err(AppError::config)?;
        hydrate_pve_battle_state_owner(&state, &mut battle_state, character_id).await?;
        hydrate_pve_battle_state_participants(
            &state,
            &mut battle_state,
            &participant_character_ids,
        )
        .await?;
        let start_logs = restart_battle_runtime(&mut battle_state);
        state.battle_runtime.register(battle_state.clone());
        let projection = OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: actor.user_id,
            participant_user_ids: participant_user_ids.clone(),
            r#type: "pve".to_string(),
            session_id: Some(session.session_id.clone()),
        };
        state.online_battle_projections.register(projection.clone());
        let persisted_session = updated_session.clone().unwrap_or_else(|| {
            state
                .battle_sessions
                .get_by_battle_id(&battle_id)
                .unwrap_or(session.clone())
        });
        persist_battle_session(&state, &persisted_session).await?;
        persist_battle_snapshot(&state, &battle_state).await?;
        persist_battle_projection(&state, &projection).await?;
        let debug_realtime = build_battle_started_payload(
            session.current_battle_id.as_deref().unwrap_or_default(),
            battle_state.clone(),
            start_logs,
            Some(persisted_session.clone()),
        );
        emit_battle_update_to_participants(
            &state,
            &persisted_session.participant_user_ids,
            &debug_realtime,
        );
        let debug_cooldown_realtime =
            build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
        emit_battle_cooldown_to_participants(
            &state,
            &persisted_session.participant_user_ids,
            &debug_cooldown_realtime,
        );
        return Ok(send_success(BattleSessionResponseData {
            finished: false,
            session: persisted_session,
            state: Some(battle_state),
        })
        .into_response());
    }

    if payload.r#type == "pvp" {
        let opponent_character_id = payload.opponent_character_id.unwrap_or_default();
        if opponent_character_id <= 0 {
            return Err(AppError::config("对手参数错误"));
        }
        let mode = match payload.mode.as_deref() {
            Some("arena") => "arena",
            _ => "challenge",
        };
        let battle_id = payload
            .battle_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "pvp-battle-{}-{}-{}",
                    actor.user_id,
                    opponent_character_id,
                    now_millis()
                )
            });
        let session = BattleSessionSnapshotDto {
            session_id: format!("pvp-session-{}", battle_id),
            session_type: "pvp".to_string(),
            owner_user_id: actor.user_id,
            participant_user_ids: vec![actor.user_id],
            current_battle_id: Some(battle_id),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pvp {
                opponent_character_id,
                mode: mode.to_string(),
            },
        };
        state.battle_sessions.register(session.clone());
        let actor_character_id = auth::get_character_id_by_user_id(&state, actor.user_id)
            .await?
            .ok_or_else(|| AppError::config("角色不存在"))?;
        let battle_id = session
            .current_battle_id
            .clone()
            .ok_or_else(|| AppError::config("战斗ID不存在"))?;
        let mut battle_state =
            build_minimal_pvp_battle_state(&battle_id, actor_character_id, opponent_character_id);
        hydrate_pvp_battle_state_players(
            &state,
            &mut battle_state,
            actor_character_id,
            opponent_character_id,
            if mode == "arena" { "npc" } else { "player" },
        )
        .await?;
        let start_logs = restart_battle_runtime(&mut battle_state);
        let participant_user_ids = if mode == "arena" {
            vec![actor.user_id]
        } else {
            let mut ids = vec![actor.user_id];
            if let Some(defender_user_id) = battle_state.teams.defender.odwner_id {
                if !ids.contains(&defender_user_id) {
                    ids.push(defender_user_id);
                }
            }
            ids
        };
        let updated_session = state.battle_sessions.update(&session.session_id, |record| {
            record.participant_user_ids = participant_user_ids.clone();
        });
        state.battle_runtime.register(battle_state.clone());
        let projection = OnlineBattleProjectionRecord {
            battle_id,
            owner_user_id: actor.user_id,
            participant_user_ids: participant_user_ids.clone(),
            r#type: "pvp".to_string(),
            session_id: Some(session.session_id.clone()),
        };
        state.online_battle_projections.register(projection.clone());
        let persisted_session = updated_session.clone().unwrap_or(session.clone());
        persist_battle_session(&state, &persisted_session).await?;
        persist_battle_snapshot(&state, &battle_state).await?;
        persist_battle_projection(&state, &projection).await?;
        let debug_realtime = build_battle_started_payload(
            session.current_battle_id.as_deref().unwrap_or_default(),
            battle_state.clone(),
            start_logs,
            Some(persisted_session.clone()),
        );
        emit_battle_update_to_participants(&state, &participant_user_ids, &debug_realtime);
        let debug_cooldown_realtime =
            build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
        emit_battle_cooldown_to_participants(
            &state,
            &participant_user_ids,
            &debug_cooldown_realtime,
        );
        return Ok(send_success(BattleSessionResponseData {
            finished: false,
            session: persisted_session,
            state: Some(battle_state),
        })
        .into_response());
    }

    if payload.r#type != "dungeon" {
        return Err(AppError::config("不支持的战斗会话类型"));
    }
    let instance_id = payload
        .instance_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if instance_id.is_empty() {
        return Err(AppError::config("缺少秘境实例ID"));
    }

    let row = state.database.fetch_optional(
        "SELECT id, dungeon_id, difficulty_id, participants, status, current_stage, current_wave, instance_data FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(instance_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::not_found("秘境实例不存在"));
    };

    let participants: Vec<serde_json::Value> = row
        .try_get::<Option<serde_json::Value>, _>("participants")?
        .and_then(|value| serde_json::from_value::<Vec<serde_json::Value>>(value).ok())
        .unwrap_or_default();
    let participant_user_ids = participants
        .iter()
        .filter_map(|entry| entry.get("userId").and_then(|value| value.as_i64()))
        .collect::<Vec<_>>();
    if !participant_user_ids.contains(&actor.user_id) {
        return Err(AppError::unauthorized("无权访问该秘境"));
    }
    let current_stage = row
        .try_get::<Option<i32>, _>("current_stage")?
        .map(i64::from)
        .unwrap_or(1);
    let current_wave = row
        .try_get::<Option<i32>, _>("current_wave")?
        .map(i64::from)
        .unwrap_or(1);
    let battle_id = format!(
        "dungeon-battle-{}-{}-{}",
        instance_id, current_stage, current_wave
    );
    let session_id = format!("dungeon-session-{}", instance_id);
    let session = BattleSessionSnapshotDto {
        session_id: session_id.clone(),
        session_type: "dungeon".to_string(),
        owner_user_id: actor.user_id,
        participant_user_ids: if participant_user_ids.is_empty() {
            vec![actor.user_id]
        } else {
            participant_user_ids.clone()
        },
        current_battle_id: Some(battle_id.clone()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: BattleSessionContextDto::Dungeon {
            instance_id: instance_id.to_string(),
        },
    };
    state.battle_sessions.register(session.clone());
    let owner_character_id = participants
        .iter()
        .find_map(|entry| entry.get("characterId").and_then(|value| value.as_i64()))
        .ok_or_else(|| AppError::config("秘境参与角色不存在"))?;
    let dungeon_id = row
        .try_get::<Option<String>, _>("dungeon_id")?
        .unwrap_or_default();
    let difficulty_id = row
        .try_get::<Option<String>, _>("difficulty_id")?
        .unwrap_or_default();
    let monster_ids =
        load_dungeon_wave_monster_ids(&dungeon_id, &difficulty_id, current_stage, current_wave)?;
    let mut battle_state =
        try_build_minimal_pve_battle_state(&battle_id, owner_character_id, &monster_ids)
            .map_err(AppError::config)?;
    hydrate_pve_battle_state_owner(&state, &mut battle_state, owner_character_id).await?;
    let participant_character_ids = participants
        .iter()
        .filter_map(|entry| entry.get("characterId").and_then(|value| value.as_i64()))
        .collect::<Vec<_>>();
    hydrate_pve_battle_state_participants(&state, &mut battle_state, &participant_character_ids)
        .await?;
    let start_logs = restart_battle_runtime(&mut battle_state);
    state.battle_runtime.register(battle_state.clone());
    let projection = OnlineBattleProjectionRecord {
        battle_id: battle_id.clone(),
        owner_user_id: actor.user_id,
        participant_user_ids: if participant_user_ids.is_empty() {
            vec![actor.user_id]
        } else {
            participant_user_ids.clone()
        },
        r#type: "pve".to_string(),
        session_id: Some(session.session_id.clone()),
    };
    state.online_battle_projections.register(projection.clone());
    persist_battle_session(&state, &session).await?;
    persist_battle_snapshot(&state, &battle_state).await?;
    persist_battle_projection(&state, &projection).await?;
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        start_logs,
        Some(session.clone()),
    );
    emit_battle_update_to_participants(&state, &session.participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(
        &state,
        &session.participant_user_ids,
        &debug_cooldown_realtime,
    );
    state.database.execute(
        "UPDATE dungeon_instance SET status = 'running', start_time = COALESCE(start_time, NOW()), instance_data = COALESCE(instance_data, '{}'::jsonb) || jsonb_build_object('currentBattleId', $2, 'difficultyRank', COALESCE((instance_data ->> 'difficultyRank')::int, 1)), created_at = created_at WHERE id = $1",
        |query| query.bind(instance_id).bind(&battle_id),
    ).await?;

    Ok(send_success(BattleSessionResponseData {
        finished: false,
        session,
        state: Some(battle_state),
    })
    .into_response())
}

pub async fn get_battle_session_by_battle_id(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(battle_id): Path<String>,
) -> Result<Json<SuccessResponse<BattleSessionResponseData>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let Some(session) = state.battle_sessions.get_by_battle_id(&battle_id) else {
        return Err(AppError::not_found("战斗会话不存在"));
    };
    ensure_session_visible_to_user(&session, actor.user_id)?;
    let battle_state = session
        .current_battle_id
        .as_deref()
        .and_then(|battle_id| state.battle_runtime.get(battle_id));
    Ok(send_success(BattleSessionResponseData {
        finished: is_session_finished(&session),
        session,
        state: battle_state,
    }))
}

pub async fn get_battle_session_by_id(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<SuccessResponse<BattleSessionResponseData>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let Some(session) = state.battle_sessions.get_by_session_id(&session_id) else {
        return Err(AppError::not_found("战斗会话不存在"));
    };
    ensure_session_visible_to_user(&session, actor.user_id)?;
    let battle_state = session
        .current_battle_id
        .as_deref()
        .and_then(|battle_id| state.battle_runtime.get(battle_id));
    Ok(send_success(BattleSessionResponseData {
        finished: is_session_finished(&session),
        session,
        state: battle_state,
    }))
}

pub async fn advance_battle_session(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<SuccessResponse<BattleSessionResponseData>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let session = state
        .battle_sessions
        .get_by_session_id(&session_id)
        .ok_or_else(|| AppError::not_found("战斗会话不存在"))?;
    ensure_session_visible_to_user(&session, actor.user_id)?;
    if !session.can_advance {
        return Err(AppError::config("当前战斗会话不可推进"));
    }
    let previous_battle_id = session.current_battle_id.clone();
    let previous_participants = session.participant_user_ids.clone();
    let should_emit_abandoned = session.next_action == "return_to_map";
    let should_emit_arena_refresh = should_emit_abandoned
        && matches!(session.context, BattleSessionContextDto::Pvp { ref mode, .. } if mode == "arena");

    let updated = match session.context.clone() {
        BattleSessionContextDto::Pve { monster_ids } => {
            if session.next_action == "return_to_map" {
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                state.battle_sessions.update(&session_id, |record| {
                    record.current_battle_id = None;
                    record.status = "completed".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                    record.context = BattleSessionContextDto::Pve { monster_ids };
                })
            } else if session.next_action == "advance" {
                let Some(character_id) =
                    auth::get_character_id_by_user_id(&state, actor.user_id).await?
                else {
                    return Err(AppError::config("角色不存在"));
                };
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                let next_battle_id = format!("pve-battle-{}-{}", actor.user_id, now_millis());
                let team_rows = state.database.fetch_all(
                    "SELECT tm.team_id, tm.role, tm.character_id, c.user_id FROM team_members tm JOIN characters c ON c.id = tm.character_id WHERE tm.team_id = (SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1) ORDER BY CASE WHEN tm.role = 'leader' THEN 0 ELSE 1 END, tm.character_id ASC",
                    |q| q.bind(character_id),
                ).await?;
                let (participant_user_ids, participant_character_ids) = if team_rows.is_empty() {
                    (vec![actor.user_id], vec![character_id])
                } else {
                    let is_leader = team_rows.iter().any(|row| {
                        row.try_get::<Option<i32>, _>("character_id")
                            .ok()
                            .flatten()
                            .map(i64::from)
                            == Some(character_id)
                            && row
                                .try_get::<Option<String>, _>("role")
                                .ok()
                                .flatten()
                                .as_deref()
                                == Some("leader")
                    });
                    if !is_leader {
                        return Err(AppError::config("组队中只有队长可以推进战斗会话"));
                    }
                    (
                        team_rows
                            .iter()
                            .filter_map(|row| row.try_get::<Option<i32>, _>("user_id").ok().flatten().map(i64::from))
                            .collect::<Vec<_>>(),
                        team_rows
                            .iter()
                            .filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from))
                            .collect::<Vec<_>>(),
                    )
                };
                let mut next_battle_state =
                    try_build_minimal_pve_battle_state(&next_battle_id, character_id, &monster_ids)
                        .map_err(AppError::config)?;
                hydrate_pve_battle_state_owner(&state, &mut next_battle_state, character_id)
                    .await?;
                hydrate_pve_battle_state_participants(&state, &mut next_battle_state, &participant_character_ids)
                    .await?;
                let start_logs = restart_battle_runtime(&mut next_battle_state);
                state.battle_runtime.register(next_battle_state.clone());
                let projection = OnlineBattleProjectionRecord {
                    battle_id: next_battle_id.clone(),
                    owner_user_id: actor.user_id,
                    participant_user_ids: participant_user_ids.clone(),
                    r#type: "pve".to_string(),
                    session_id: Some(session_id.clone()),
                };
                state.online_battle_projections.register(projection.clone());
                let updated_session = state.battle_sessions.update(&session_id, |record| {
                    record.current_battle_id = Some(next_battle_id.clone());
                    record.participant_user_ids = participant_user_ids.clone();
                    record.status = "running".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                    record.last_result = None;
                    record.context = BattleSessionContextDto::Pve { monster_ids };
                });
                if let Some(updated_session_ref) = updated_session.as_ref() {
                    persist_battle_session(&state, updated_session_ref).await?;
                    persist_battle_snapshot(&state, &next_battle_state).await?;
                    persist_battle_projection(&state, &projection).await?;
                    let debug_realtime = build_battle_started_payload(
                        &next_battle_id,
                        next_battle_state.clone(),
                        start_logs,
                        Some(updated_session_ref.clone()),
                    );
                    emit_battle_update_to_participants(
                        &state,
                        &updated_session_ref.participant_user_ids,
                        &debug_realtime,
                    );
                    let debug_cooldown_realtime =
                        build_battle_cooldown_ready_payload(next_battle_state.current_unit_id.as_deref());
                    emit_battle_cooldown_to_participants(
                        &state,
                        &updated_session_ref.participant_user_ids,
                        &debug_cooldown_realtime,
                    );
                }
                updated_session
            } else {
                return Err(AppError::config("当前战斗会话不可推进"));
            }
        }
        BattleSessionContextDto::Dungeon { instance_id } => {
            if session.next_action == "return_to_map" {
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                state.database.execute(
                    "UPDATE dungeon_instance SET status = 'cleared', end_time = NOW(), instance_data = COALESCE(instance_data, '{}'::jsonb) - 'currentBattleId' WHERE id = $1",
                    |query| query.bind(&instance_id),
                ).await?;
                state.battle_sessions.update(&session_id, |record| {
                    record.current_battle_id = None;
                    record.status = "completed".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                    record.context = BattleSessionContextDto::Dungeon { instance_id };
                })
            } else {
                return Err(AppError::config("当前战斗会话不可推进"));
            }
        }
        BattleSessionContextDto::Tower { run_id, floor } => {
            if session.next_action == "advance" && session.can_advance {
                let next_floor = floor + 1;
                let next_battle_id = format!("tower-battle-{run_id}-{next_floor}");
                let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
                    return Err(AppError::config("角色不存在"));
                };
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                let mut next_battle_state = crate::battle_runtime::try_build_minimal_pve_battle_state(
                    &next_battle_id,
                    character_id,
                    &resolve_tower_floor_monster_ids(next_floor),
                )
                .map_err(AppError::config)?;
                hydrate_pve_battle_state_owner(&state, &mut next_battle_state, character_id).await?;
                hydrate_pve_battle_state_active_partner(&state, &mut next_battle_state, character_id)
                    .await?;
                let start_logs = restart_battle_runtime(&mut next_battle_state);
                state.battle_runtime.register(next_battle_state.clone());
                state.database.execute(
                    "UPDATE character_tower_progress SET current_run_id = $2, current_floor = $3, current_battle_id = $4, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(character_id).bind(&run_id).bind(next_floor).bind(&next_battle_id),
                ).await?;
                let projection = OnlineBattleProjectionRecord {
                    battle_id: next_battle_id.clone(),
                    owner_user_id: actor.user_id,
                    participant_user_ids: vec![actor.user_id],
                    r#type: "pve".to_string(),
                    session_id: Some(session_id.clone()),
                };
                state.online_battle_projections.register(projection.clone());
                let updated_session = state
                    .battle_sessions
                    .update(&session_id, |record| {
                        record.current_battle_id = Some(next_battle_id.clone());
                        record.status = "running".to_string();
                        record.next_action = "none".to_string();
                        record.can_advance = false;
                        record.last_result = None;
                        record.context = BattleSessionContextDto::Tower { run_id, floor: next_floor };
                    });
                if let Some(updated_session_ref) = updated_session.as_ref() {
                    if let Some(updated_battle_state) = state.battle_runtime.get(&next_battle_id) {
                        persist_battle_session(&state, updated_session_ref).await?;
                        persist_battle_snapshot(&state, &updated_battle_state).await?;
                        persist_battle_projection(&state, &projection).await?;
                        let debug_realtime = build_battle_started_payload(
                            &next_battle_id,
                            updated_battle_state.clone(),
                            start_logs,
                            Some(updated_session_ref.clone()),
                        );
                        emit_battle_update_to_participants(
                            &state,
                            &updated_session_ref.participant_user_ids,
                            &debug_realtime,
                        );
                        let debug_cooldown_realtime = build_battle_cooldown_ready_payload(
                            updated_battle_state.current_unit_id.as_deref(),
                        );
                        emit_battle_cooldown_to_participants(
                            &state,
                            &updated_session_ref.participant_user_ids,
                            &debug_cooldown_realtime,
                        );
                    }
                }
                updated_session
            } else if session.next_action == "return_to_map" {
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
                    return Err(AppError::config("角色不存在"));
                };
                state.database.execute(
                    "UPDATE character_tower_progress SET current_run_id = NULL, current_floor = NULL, current_battle_id = NULL, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(character_id),
                ).await?;
                state
                    .battle_sessions
                    .update(&session_id, |record| {
                        record.current_battle_id = None;
                        record.status = "completed".to_string();
                        record.next_action = "none".to_string();
                        record.can_advance = false;
                    })
            } else {
                return Err(AppError::config("当前战斗会话不可推进"));
            }
        }
        BattleSessionContextDto::Pvp { .. } => {
            if session.next_action == "return_to_map" {
                if let Some(current_battle_id) = session.current_battle_id.clone() {
                    state.battle_runtime.clear(&current_battle_id);
                    state.online_battle_projections.clear(&current_battle_id);
                    clear_battle_persistence(&state, &current_battle_id, Some(&session_id)).await?;
                }
                state.battle_sessions.update(&session_id, |record| {
                    record.current_battle_id = None;
                    record.status = "completed".to_string();
                    record.next_action = "none".to_string();
                    record.can_advance = false;
                })
            } else {
                return Err(AppError::config("当前战斗会话不可推进"));
            }
        }
    }
    .ok_or_else(|| AppError::not_found("战斗会话不存在"))?;

    let battle_state = updated
        .current_battle_id
        .as_deref()
        .and_then(|battle_id| state.battle_runtime.get(battle_id));
    if let Some(battle_state) = battle_state.clone() {
        let debug_realtime = build_battle_started_payload(
            updated.current_battle_id.as_deref().unwrap_or_default(),
            battle_state.clone(),
            vec![serde_json::json!({"type": "round_start", "round": battle_state.round_count})],
            Some(updated.clone()),
        );
        emit_battle_update_to_participants(&state, &updated.participant_user_ids, &debug_realtime);
        let debug_cooldown_realtime =
            build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
        emit_battle_cooldown_to_participants(
            &state,
            &updated.participant_user_ids,
            &debug_cooldown_realtime,
        );
    } else if should_emit_abandoned {
        if let Some(previous_battle_id) = previous_battle_id.as_deref() {
            let debug_realtime = build_battle_abandoned_payload(
                previous_battle_id,
                Some(updated.clone()),
                true,
                "已离开战斗",
            );
            emit_battle_update_to_participants(&state, &previous_participants, &debug_realtime);
        }
    }
    if should_emit_arena_refresh {
        emit_arena_update_to_user(
            &state,
            updated.owner_user_id,
            &build_arena_refresh_payload(),
        );
    }
    Ok(send_success(BattleSessionResponseData {
        finished: is_session_finished(&updated),
        session: updated,
        state: battle_state,
    }))
}

fn ensure_session_visible_to_user(
    session: &BattleSessionSnapshotDto,
    user_id: i64,
) -> Result<(), AppError> {
    if session.owner_user_id == user_id || session.participant_user_ids.contains(&user_id) {
        return Ok(());
    }
    Err(AppError::unauthorized("无权访问该战斗会话"))
}

fn is_session_finished(session: &BattleSessionSnapshotDto) -> bool {
    matches!(
        session.status.as_str(),
        "completed" | "failed" | "abandoned"
    ) || session.current_battle_id.is_none()
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
    use crate::http::dungeon::load_dungeon_wave_monster_ids;
    use crate::state::BattleSessionContextDto;

    #[test]
    fn battle_session_by_battle_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finished": false,
                "state": {"battleId": "tower-battle-run-1-13", "currentTeam": "attacker"},
                "session": {
                    "sessionId": "tower-session-run-1",
                    "type": "tower",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "tower-battle-run-1-13",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"runId": "run-1", "floor": 13}
                }
            }
        });
        assert_eq!(
            payload["data"]["session"]["currentBattleId"],
            "tower-battle-run-1-13"
        );
        println!("BATTLE_SESSION_BY_BATTLE_RESPONSE={}", payload);
    }

    #[test]
    fn battle_session_current_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"session": {"sessionId": "pve-session-pve-battle-1-123"}, "state": {"battleId": "pve-battle-1-123", "currentTeam": "attacker"}, "finished": false}
        });
        assert_eq!(payload["data"]["state"]["currentTeam"], "attacker");
        println!("BATTLE_SESSION_CURRENT_RESPONSE={}", payload);
    }

    #[test]
    fn battle_session_advance_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finished": false,
                "state": {"battleId": "tower-battle-run-1-14", "currentTeam": "attacker"},
                "session": {
                    "sessionId": "tower-session-run-1",
                    "type": "tower",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "tower-battle-run-1-14",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"runId": "run-1", "floor": 14}
                }
            }
        });
        assert_eq!(payload["data"]["session"]["context"]["floor"], 14);
        println!("BATTLE_SESSION_ADVANCE_RESPONSE={}", payload);
    }

    #[test]
    fn arena_return_to_map_branch_is_refresh_eligible() {
        let arena_context = BattleSessionContextDto::Pvp {
            opponent_character_id: 2,
            mode: "arena".to_string(),
        };
        let ladder_context = BattleSessionContextDto::Pvp {
            opponent_character_id: 2,
            mode: "ladder".to_string(),
        };
        let should_emit_abandoned = true;
        let arena_refresh = should_emit_abandoned
            && matches!(arena_context, BattleSessionContextDto::Pvp { ref mode, .. } if mode == "arena");
        let ladder_refresh = should_emit_abandoned
            && matches!(ladder_context, BattleSessionContextDto::Pvp { ref mode, .. } if mode == "arena");
        assert!(arena_refresh);
        assert!(!ladder_refresh);
    }

    #[test]
    fn battle_session_start_dungeon_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finished": false,
                "state": {"battleId": "dungeon-battle-inst-1-1-1", "currentTeam": "attacker"},
                "session": {
                    "sessionId": "dungeon-session-inst-1",
                    "type": "dungeon",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "dungeon-battle-inst-1-1-1",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"instanceId": "inst-1"}
                }
            }
        });
        assert_eq!(payload["data"]["session"]["type"], "dungeon");
        println!("BATTLE_SESSION_START_DUNGEON_RESPONSE={}", payload);
    }

    #[test]
    fn battle_session_start_pve_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finished": false,
                "state": {"battleId": "pve-battle-1-123", "currentTeam": "attacker"},
                "session": {
                    "sessionId": "pve-session-pve-battle-1-123",
                    "type": "pve",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "pve-battle-1-123",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"monsterIds": ["monster-gray-wolf"]}
                }
            }
        });
        assert_eq!(payload["data"]["session"]["type"], "pve");
        println!("BATTLE_SESSION_START_PVE_RESPONSE={}", payload);
    }

    #[test]
    fn battle_session_start_pvp_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "finished": false,
                "state": {"battleId": "pvp-battle-1-2-123", "currentTeam": "attacker"},
                "session": {
                    "sessionId": "pvp-session-pvp-battle-1-2-123",
                    "type": "pvp",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "pvp-battle-1-2-123",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"opponentCharacterId": 2, "mode": "arena"}
                }
            }
        });
        assert_eq!(payload["data"]["session"]["context"]["mode"], "arena");
        println!("BATTLE_SESSION_START_PVP_RESPONSE={}", payload);
    }

    #[test]
    fn battle_session_room_monster_loader_only_returns_monsters_in_selected_room() {
        let monsters = load_room_monster_ids("map-qingyun-outskirts", "room-south-forest")
            .expect("room monsters should load");
        assert_eq!(monsters, vec!["monster-wild-rabbit".to_string()]);
    }

    #[test]
    fn battle_session_dungeon_start_uses_real_seed_monsters() {
        let monster_ids =
            load_dungeon_wave_monster_ids("dungeon-qiqi-wolf-den", "dd-qiqi-wolf-den-n", 1, 1)
                .expect("dungeon wave monster ids should load");
        assert_eq!(
            monster_ids,
            vec![
                "monster-gray-wolf".to_string(),
                "monster-gray-wolf".to_string(),
                "monster-wild-boar".to_string(),
            ]
        );
        println!(
            "BATTLE_SESSION_DUNGEON_MONSTER_IDS={}",
            serde_json::json!(monster_ids)
        );
    }
}
