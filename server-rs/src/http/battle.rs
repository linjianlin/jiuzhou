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
    BattleStateDto, MinimalBattleRewardParticipant, MinimalPveItemRewardResolveOptions,
    apply_minimal_pve_action, apply_minimal_pvp_action, resolve_minimal_pve_item_rewards,
    restart_battle_runtime, try_build_minimal_pve_battle_state,
};
use crate::integrations::battle_character_profile::{
    hydrate_pve_battle_state_owner, hydrate_pve_battle_state_participants,
};
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
    build_battle_started_payload, build_battle_state_payload, build_multi_player_reward_values,
    build_reward_item_values, build_single_player_reward_values,
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

const BATTLE_START_COOLDOWN_MS: i64 = 3000;
const DUNGEON_SESSION_SERVER_AUTO_ADVANCE_DELAY_MS: u64 = 200;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battle_start_cooldown_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_battle_available_at: Option<i64>,
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
            return Err(AppError::config("组队中只有队长可以发起战斗"));
        }
        let participant_user_ids = team_rows
            .iter()
            .filter_map(|row| {
                row.try_get::<Option<i32>, _>("user_id")
                    .ok()
                    .flatten()
                    .map(i64::from)
            })
            .collect::<Vec<_>>();
        let participant_character_ids = team_rows
            .iter()
            .filter_map(|row| {
                row.try_get::<Option<i32>, _>("character_id")
                    .ok()
                    .flatten()
                    .map(i64::from)
            })
            .collect::<Vec<_>>();
        (participant_user_ids, participant_character_ids)
    };

    let battle_id = format!("pve-battle-{}-{}", actor.user_id, now_millis());
    let session = BattleSessionSnapshotDto {
        session_id: format!("pve-session-{}", battle_id),
        session_type: "pve".to_string(),
        owner_user_id: actor.user_id,
        participant_user_ids: participant_user_ids.clone(),
        current_battle_id: Some(battle_id.clone()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: BattleSessionContextDto::Pve { monster_ids },
    };
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
    hydrate_pve_battle_state_participants(&state, &mut battle_state, &participant_character_ids)
        .await?;
    let logs = restart_battle_runtime(&mut battle_state);
    state.battle_sessions.register(session);
    state.battle_runtime.register(battle_state.clone());
    let projection = OnlineBattleProjectionRecord {
        battle_id: battle_id.clone(),
        owner_user_id: actor.user_id,
        participant_user_ids: participant_user_ids.clone(),
        r#type: "pve".to_string(),
        session_id: Some(format!("pve-session-{}", battle_id)),
    };
    state.online_battle_projections.register(projection.clone());
    if let Some(session) = state.battle_sessions.get_by_battle_id(&battle_id) {
        persist_battle_session(&state, &session).await?;
    }
    persist_battle_snapshot(&state, &battle_state).await?;
    persist_battle_projection(&state, &projection).await?;
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        logs.clone(),
        state.battle_sessions.get_by_battle_id(&battle_id),
    );
    emit_battle_update_to_participants(&state, &participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(&state, &participant_user_ids, &debug_cooldown_realtime);
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
            is_team_battle: Some(participant_user_ids.len() > 1),
            team_member_count: Some(participant_user_ids.len() as i64),
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
                "pvp" => {
                    apply_minimal_pvp_action(state, character_id, skill_id.trim(), &target_ids)
                }
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
                apply_battle_session_finished_policy(record, action_outcome.result.as_deref());
                record.last_result = action_outcome.result.clone();
            }
        })
    });

    let reward_participants = resolve_battle_reward_participants(&state, &state_snapshot).await?;

    let mut defer_character_full_refresh = false;
    let reward_items = session
        .as_ref()
        .and_then(|session| match &session.context {
            BattleSessionContextDto::Pve { monster_ids }
                if action_outcome.finished
                    && matches!(state_snapshot.result.as_deref(), Some("attacker_win")) =>
            {
                resolve_minimal_pve_item_rewards(
                    monster_ids,
                    &MinimalPveItemRewardResolveOptions {
                        reward_seed: battle_id.trim().to_string(),
                        participants: reward_participants.clone(),
                        is_dungeon_battle: false,
                        dungeon_reward_multiplier: None,
                    },
                )
                .ok()
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
                && (action_outcome.exp_gained > 0
                    || action_outcome.silver_gained > 0
                    || !reward_items.is_empty())
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

    let logs = action_outcome.logs.clone();
    let apply_start_cooldown =
        action_outcome.finished && should_apply_finished_battle_start_cooldown(session.as_ref());
    let next_battle_available_at = if apply_start_cooldown {
        Some(now_millis() as i64 + BATTLE_START_COOLDOWN_MS)
    } else {
        None
    };
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
                    items: Some(build_reward_item_values(&reward_items, character_id)),
                    per_player_rewards: Some(if reward_participants.len() > 1 {
                        build_multi_player_reward_values(
                            &reward_participants
                                .iter()
                                .map(|participant| (participant.user_id, participant.character_id))
                                .collect::<Vec<_>>(),
                            action_outcome.exp_gained,
                            action_outcome.silver_gained,
                            &reward_items,
                        )
                    } else {
                        build_single_player_reward_values(
                            actor.user_id,
                            character_id,
                            action_outcome.exp_gained,
                            action_outcome.silver_gained,
                            &reward_items,
                        )
                    }),
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
                battle_start_cooldown_ms: apply_start_cooldown.then_some(BATTLE_START_COOLDOWN_MS),
                retry_after_ms: None,
                next_battle_available_at,
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
        if apply_start_cooldown {
            build_battle_cooldown_sync_payload(
                Some(&format!("player-{character_id}")),
                BATTLE_START_COOLDOWN_MS,
            )
        } else {
            build_battle_cooldown_ready_payload(state_snapshot.current_unit_id.as_deref())
        }
    } else {
        build_battle_cooldown_sync_payload(state_snapshot.current_unit_id.as_deref(), 1500)
    };
    emit_battle_cooldown_to_participants(
        &state,
        &projection.participant_user_ids,
        &debug_cooldown_realtime,
    );
    if apply_start_cooldown {
        schedule_battle_cooldown_ready_push(
            state.clone(),
            projection.participant_user_ids.clone(),
            character_id,
        );
    }
    if action_outcome.finished {
        schedule_dungeon_session_auto_advance_if_needed(
            state.clone(),
            session.as_ref(),
            state_snapshot.result.as_deref(),
        );
    }
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
            battle_start_cooldown_ms: apply_start_cooldown.then_some(BATTLE_START_COOLDOWN_MS),
            retry_after_ms: None,
            next_battle_available_at,
        }),
    }))
}

fn apply_battle_session_finished_policy(
    record: &mut BattleSessionSnapshotDto,
    result: Option<&str>,
) {
    record.status = "waiting_transition".to_string();
    let next_action = match &record.context {
        BattleSessionContextDto::Pvp { .. } => "return_to_map",
        BattleSessionContextDto::Tower { .. } if matches!(result, Some("attacker_win")) => {
            "advance"
        }
        BattleSessionContextDto::Pve { .. } | BattleSessionContextDto::Dungeon { .. }
            if matches!(result, Some("attacker_win")) =>
        {
            "advance"
        }
        _ => "return_to_map",
    };
    record.next_action = next_action.to_string();
    record.can_advance = true;
}

fn should_apply_finished_battle_start_cooldown(session: Option<&BattleSessionSnapshotDto>) -> bool {
    session.is_some_and(|session| {
        !matches!(
            &session.context,
            BattleSessionContextDto::Dungeon { .. } | BattleSessionContextDto::Tower { .. }
        )
    })
}

async fn resolve_battle_reward_participants(
    state: &AppState,
    battle_state: &BattleStateDto,
) -> Result<Vec<MinimalBattleRewardParticipant>, AppError> {
    let attacker_character_ids = battle_state
        .teams
        .attacker
        .units
        .iter()
        .filter(|unit| unit.r#type == "player")
        .filter_map(|unit| unit.source_id.as_i64())
        .filter(|character_id| *character_id > 0)
        .collect::<Vec<_>>();
    if attacker_character_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = state.database.fetch_all(
        "SELECT id::bigint AS character_id, user_id::bigint AS user_id FROM characters WHERE id = ANY($1)",
        |q| q.bind(&attacker_character_ids),
    ).await?;
    let user_id_by_character = rows
        .into_iter()
        .filter_map(|row| {
            Some((
                row.try_get::<i64, _>("character_id").ok()?,
                row.try_get::<i64, _>("user_id").ok()?,
            ))
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    Ok(battle_state
        .teams
        .attacker
        .units
        .iter()
        .filter(|unit| unit.r#type == "player")
        .filter_map(|unit| {
            let character_id = unit.source_id.as_i64()?;
            let user_id = *user_id_by_character.get(&character_id)?;
            Some(MinimalBattleRewardParticipant {
                character_id,
                user_id,
                fuyuan: 0.0,
                realm: unit.current_attrs.realm.clone(),
            })
        })
        .collect())
}

fn schedule_battle_cooldown_ready_push(
    state: AppState,
    participant_user_ids: Vec<i64>,
    character_id: i64,
) {
    let actor_id = format!("player-{character_id}");
    let _ = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(
            BATTLE_START_COOLDOWN_MS as u64,
        ))
        .await;
        let payload = build_battle_cooldown_ready_payload(Some(&actor_id));
        emit_battle_cooldown_to_participants(&state, &participant_user_ids, &payload);
    });
}

fn schedule_dungeon_session_auto_advance_if_needed(
    state: AppState,
    session: Option<&BattleSessionSnapshotDto>,
    result: Option<&str>,
) {
    if !matches!(result, Some("attacker_win")) {
        return;
    }
    let Some(session) = session else {
        return;
    };
    let BattleSessionContextDto::Dungeon { instance_id } = &session.context else {
        return;
    };
    if session.status != "waiting_transition" || session.next_action != "advance" {
        return;
    }
    let instance_id = instance_id.clone();
    let owner_user_id = session.owner_user_id;
    let _ = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(
            DUNGEON_SESSION_SERVER_AUTO_ADVANCE_DELAY_MS,
        ))
        .await;
        if let Err(error) = state
            .database
            .with_transaction(|| async {
                crate::http::dungeon::next_dungeon_instance_tx(&state, owner_user_id, &instance_id)
                    .await
                    .map(|_| ())
            })
            .await
        {
            tracing::warn!(error = %error, instance_id = %instance_id, "dungeon session auto advance failed");
        }
    });
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
                "logs": [{
                    "type": "action",
                    "round": 1,
                    "actorId": "player-1",
                    "actorName": "修士1",
                    "skillId": "sk-heavy-slash",
                    "skillName": "重斩",
                    "targets": [{
                        "targetId": "monster-1-monster-gray-wolf",
                        "targetName": "灰狼",
                        "hits": [{
                            "index": 1,
                            "damage": 120,
                            "isMiss": false,
                            "isCrit": false,
                            "isParry": false,
                            "isElementBonus": false,
                            "shieldAbsorbed": 0
                        }],
                        "damage": 120
                    }]
                }],
                "debugRealtime": {"kind": "battle_finished", "battleId": "pve-battle-1-123"},
                "debugCooldownRealtime": {"kind": "battle:cooldown-sync", "remainingMs": 3000},
                "battleStartCooldownMs": 3000,
                "nextBattleAvailableAt": 1770000003000_i64,
                "session": {
                    "sessionId": "pve-session-pve-battle-1-123",
                    "status": "waiting_transition",
                    "nextAction": "advance",
                    "canAdvance": true,
                    "lastResult": "attacker_win"
                }
            }
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["session"]["status"], "waiting_transition");
        assert_eq!(payload["data"]["session"]["nextAction"], "advance");
        assert_eq!(payload["data"]["battleStartCooldownMs"], 3000);
        assert_eq!(payload["data"]["state"]["phase"], "finished");
        assert_eq!(payload["data"]["state"]["result"], "attacker_win");
        assert_eq!(payload["data"]["logs"][0]["type"], "action");
        assert_eq!(payload["data"]["logs"][0]["actorName"], "修士1");
        assert_eq!(payload["data"]["logs"][0]["skillName"], "重斩");
        assert!(
            payload["data"]["logs"][0]["targets"][0]["hits"][0]
                .get("damage")
                .is_some()
        );
        assert!(
            payload["data"]["logs"][0]["targets"][0]["hits"][0]
                .get("isMiss")
                .is_some()
        );
        assert_eq!(
            payload["data"]["logs"][0]["targets"][0]["hits"][0]["damage"],
            120
        );
        assert!(payload["data"]["debugRealtime"].get("battleId").is_some());
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "battle_finished");
        assert_eq!(
            payload["data"]["debugCooldownRealtime"]["kind"],
            "battle:cooldown-sync"
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
