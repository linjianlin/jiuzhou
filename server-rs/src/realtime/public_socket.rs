use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::OnceLock;
use tokio::time::{Duration, sleep};

use engineioxide_core::Sid;
use serde::Deserialize;
use serde::Serialize;
use socketioxide::{
    SocketIo,
    extract::{Data, SocketRef},
};
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::{
    BattleStateDto, MinimalBattleRewardParticipant, MinimalPveItemRewardResolveOptions,
    resolve_minimal_pve_item_rewards,
};
use crate::http::achievement::load_claimable_achievement_count;
use crate::http::character::local_sensitive_words_contain;
use crate::http::character_technique::load_technique_research_status_data;
use crate::http::market::assert_market_phone_bound;
use crate::http::partner::{
    load_partner_fusion_status_data, load_partner_rebone_status_data,
    load_partner_recruit_status_data,
};
use crate::http::sect::load_sect_indicator_payload;
use crate::integrations::battle_persistence::recover_battle_bundle;
use crate::realtime::achievement::AchievementIndicatorPayload;
use crate::realtime::achievement::build_achievement_indicator_payload;
use crate::realtime::battle::{
    BattleCooldownPayload, BattleFinishedMeta, BattleRealtimePayload, BattleRewardsPayload,
    build_battle_abandoned_payload, build_battle_cooldown_ready_payload,
    build_battle_cooldown_sync_payload, build_battle_finished_payload,
    build_battle_started_sync_payload, build_reward_item_values, build_single_player_reward_values,
};
use crate::realtime::chat::{build_chat_error_payload, build_chat_message_payload};
use crate::realtime::game_time::GameTimeSyncPayload;
use crate::realtime::idle::IdleRealtimePayload;
use crate::realtime::mail::MailUpdatePayload;
use crate::realtime::mail::build_mail_update_payload;
use crate::realtime::market::MarketUpdatePayload;
use crate::realtime::online_players::{
    build_online_players_broadcast_payload, build_online_players_full_payload,
};
use crate::realtime::partner_fusion::build_partner_fusion_status_payload;
use crate::realtime::partner_fusion::{PartnerFusionResultPayload, PartnerFusionStatusPayload};
use crate::realtime::partner_rebone::build_partner_rebone_status_payload;
use crate::realtime::partner_rebone::{PartnerReboneResultPayload, PartnerReboneStatusPayload};
use crate::realtime::partner_recruit::build_partner_recruit_status_payload;
use crate::realtime::partner_recruit::{PartnerRecruitResultPayload, PartnerRecruitStatusPayload};
use crate::realtime::rank::RankUpdatePayload;
use crate::realtime::sect::SectIndicatorPayload;
use crate::realtime::socket_protocol::{
    GameCharacterFullSnapshot, GameCharacterGlobalBuff, GameCharacterPayload,
    build_game_character_full_payload, build_game_kicked_payload,
};
use crate::realtime::task::TaskOverviewUpdatePayload;
use crate::realtime::task::build_task_overview_update_payload;
use crate::realtime::team::TeamUpdatePayload;
use crate::realtime::technique_research::build_technique_research_status_payload;
use crate::realtime::technique_research::{
    TechniqueResearchResultPayload, TechniqueResearchStatusPayload,
};
use crate::realtime::wander::WanderUpdatePayload;
use crate::shared::game_time::get_game_time_snapshot;
use crate::shared::mail_counter::load_mail_counter_snapshot;
use crate::state::{AppState, OnlinePlayerRecord, RealtimeSessionRecord};

#[derive(Debug, Serialize)]
struct GameErrorEvent<'a> {
    message: &'a str,
}

#[derive(Debug, Deserialize)]
struct AddPointPayload {
    attribute: String,
    amount: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BattleSyncPayload {
    battle_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSendPayload {
    channel: String,
    content: String,
    client_id: Option<String>,
    pm_target_character_id: Option<i64>,
}

pub fn mount_public_socket(io: &SocketIo, state: AppState) {
    let io_for_auth = (*io).clone();
    let io_for_refresh = (*io).clone();
    let io_for_disconnect = (*io).clone();
    io.ns("/", move |socket: SocketRef| {
        let state_for_auth = state.clone();
        let state_for_online_players = state.clone();
        let state_for_join_room = state.clone();
        let state_for_leave_room = state.clone();
        let state_for_refresh = state.clone();
        let state_for_add_point = state.clone();
        let state_for_battle_sync = state.clone();
        let state_for_chat_send = state.clone();
        let state_for_disconnect = state.clone();
        let io_for_auth = io_for_auth.clone();
        let io_for_refresh = io_for_refresh.clone();
        let io_for_disconnect = io_for_disconnect.clone();

        async move {
            tracing::debug!(socket_id = %socket.id, namespace = %socket.ns(), "socketioxide client connected");

            socket.on("game:auth", move |socket: SocketRef, Data::<String>(token)| {
                let state = state_for_auth.clone();
                let io = io_for_auth.clone();
                async move {
                    handle_game_auth(socket, token, state, io).await;
                }
            });

            socket.on("game:onlinePlayers:request", move |socket: SocketRef| {
                let state = state_for_online_players.clone();
                async move {
                    handle_online_players_request(socket, state).await;
                }
            });

            socket.on("game:refresh", move |socket: SocketRef| {
                let state = state_for_refresh.clone();
                let io = io_for_refresh.clone();
                async move {
                    handle_game_refresh(socket, state, io).await;
                }
            });

            socket.on("game:addPoint", move |socket: SocketRef, Data::<AddPointPayload>(payload)| {
                let state = state_for_add_point.clone();
                async move {
                    handle_game_add_point(socket, payload, state).await;
                }
            });

            socket.on("battle:sync", move |socket: SocketRef, Data::<BattleSyncPayload>(payload)| {
                let state = state_for_battle_sync.clone();
                async move {
                    handle_battle_sync(socket, payload, state).await;
                }
            });

            socket.on("chat:send", move |socket: SocketRef, Data::<ChatSendPayload>(payload)| {
                let state = state_for_chat_send.clone();
                async move {
                    handle_chat_send(socket, payload, state).await;
                }
            });

            socket.on("join:room", move |socket: SocketRef, Data::<String>(room_id)| {
                let state = state_for_join_room.clone();
                async move {
                    handle_join_room(socket, room_id, state).await;
                }
            });

            socket.on("leave:room", move |socket: SocketRef, Data::<String>(room_id)| {
                let state = state_for_leave_room.clone();
                async move {
                    handle_leave_room(socket, room_id, state).await;
                }
            });

            socket.on_disconnect(move |socket: SocketRef| {
                let state = state_for_disconnect.clone();
                let io = io_for_disconnect.clone();
                async move {
                    handle_socket_disconnect(socket, state, io).await;
                }
            });
        }
    });
}

async fn handle_join_room(socket: SocketRef, room_id: String, state: AppState) {
    let room_id = room_id.trim();
    if room_id.is_empty() {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "房间ID不能为空",
                },
            )
            .ok();
        return;
    }
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未认证"
                },
            )
            .ok();
        return;
    };
    socket.join(room_id.to_string());
    state
        .online_players
        .update_room(session.user_id, Some(room_id));
}

async fn handle_leave_room(socket: SocketRef, room_id: String, state: AppState) {
    let room_id = room_id.trim();
    if room_id.is_empty() {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "房间ID不能为空",
                },
            )
            .ok();
        return;
    }
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未认证"
                },
            )
            .ok();
        return;
    };
    socket.leave(room_id.to_string());
    state.online_players.update_room(session.user_id, None);
}

async fn handle_game_auth(socket: SocketRef, token: String, state: AppState, io: SocketIo) {
    println!("GAME_AUTH_TRACE: entered");
    let token = token.trim();
    if token.is_empty() {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "认证失败",
                },
            )
            .ok();
        return;
    }

    let claims = match auth::verify_token(token, &state.config.service.jwt_secret) {
        Ok(claims) => claims,
        Err(_) => {
            socket
                .emit(
                    "game:error",
                    &GameErrorEvent {
                        message: "认证失败",
                    },
                )
                .ok();
            return;
        }
    };
    println!("GAME_AUTH_TRACE: token_verified user_id={}", claims.id);

    if let Err(error) =
        auth::verify_session(&state, claims.id, claims.session_token.as_deref()).await
    {
        println!(
            "GAME_AUTH_TRACE: verify_session_failed={}",
            error.client_message()
        );
        let message = error.client_message();
        socket
            .emit("game:kicked", &serde_json::json!({ "message": message }))
            .ok();
        socket.disconnect().ok();
        return;
    }
    println!("GAME_AUTH_TRACE: verify_session_ok");

    let character = match load_game_character_full_by_user_id(&state, claims.id).await {
        Ok(character) => character,
        Err(error) => {
            println!("GAME_AUTH_TRACE: load_character_failed={error}");
            socket
                .emit(
                    "game:error",
                    &GameErrorEvent {
                        message: "服务器错误",
                    },
                )
                .ok();
            return;
        }
    };
    println!("GAME_AUTH_TRACE: load_character_ok={}", character.is_some());
    let character_id = character.as_ref().map(|value| value.id);

    let connected_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();

    let replaced = state.realtime_sessions.register(RealtimeSessionRecord {
        socket_id: socket.id.to_string(),
        user_id: claims.id,
        character_id,
        session_token: claims.session_token.clone(),
        connected_at_ms,
    });
    if let Some(previous_session) = replaced {
        if should_disconnect_replaced_socket(&previous_session.socket_id, &socket.id.to_string()) {
            disconnect_replaced_socket(&io, &previous_session.socket_id, "账号已在其他设备登录");
        }
    }

    state.online_players.register(OnlinePlayerRecord {
        user_id: claims.id,
        character_id,
        nickname: character.as_ref().map(|value| value.nickname.clone()),
        month_card_active: character
            .as_ref()
            .map(|value| value.month_card_active)
            .unwrap_or(false),
        title: character.as_ref().map(|value| value.title.clone()),
        realm: character.as_ref().map(|value| value.realm.clone()),
        room_id: character
            .as_ref()
            .map(|value| value.current_room_id.clone()),
        connected_at_ms,
    });
    socket.join(AUTHED_ROOM_ID.to_string());
    if let Some(character_id) = character_id {
        socket.join(character_chat_room_id(character_id));
    }

    println!("GAME_AUTH_TRACE: before_emit_character");
    socket
        .emit(
            "game:character",
            &build_game_character_full_payload(character.clone()),
        )
        .ok();
    if let Some(character_id) = character_id {
        println!("GAME_AUTH_TRACE: before_sync_overview");
        sync_auth_realtime_overview_payloads(&state, claims.id, character_id).await;
        println!("GAME_AUTH_TRACE: after_sync_overview");
    }
    println!("GAME_AUTH_TRACE: before_sync_battle");
    sync_battle_realtime_on_auth(&socket, &state, claims.id).await;
    println!("GAME_AUTH_TRACE: after_sync_battle");
    if let Ok(snapshot) = get_game_time_snapshot() {
        println!("GAME_AUTH_TRACE: before_emit_game_time");
        emit_game_time_sync_to_user(
            &state,
            claims.id,
            &crate::realtime::game_time::build_game_time_sync_payload(snapshot),
        );
        println!("GAME_AUTH_TRACE: after_emit_game_time");
    }
    println!("GAME_AUTH_TRACE: before_emit_auth_ready");
    socket.emit("game:auth-ready", &serde_json::json!({})).ok();
    println!("GAME_AUTH_TRACE: after_emit_auth_ready");
    schedule_emit_online_players(&state, &io, false);
}

async fn sync_auth_realtime_overview_payloads(state: &AppState, user_id: i64, character_id: i64) {
    if let Ok(payload) = load_sect_indicator_payload(state, character_id).await {
        emit_sect_update_to_user(state, user_id, &payload);
    }

    emit_task_update_to_user(
        state,
        user_id,
        &build_task_overview_update_payload(character_id),
    );

    if let Ok(claimable_count) = load_claimable_achievement_count(state, character_id).await {
        emit_achievement_update_to_user(
            state,
            user_id,
            &build_achievement_indicator_payload(character_id, claimable_count),
        );
    }

    if let Ok(counter) = load_mail_counter_snapshot(state, character_id, user_id).await {
        emit_mail_update_to_user(
            state,
            user_id,
            &build_mail_update_payload(counter.unread_count, counter.unclaimed_count, "auth_sync"),
        );
    }

    if let Ok(status) = load_partner_recruit_status_data(state, character_id).await {
        emit_partner_recruit_status_to_user(
            state,
            user_id,
            &build_partner_recruit_status_payload(character_id, status),
        );
    }

    if let Ok(status) = load_partner_fusion_status_data(state, character_id).await {
        emit_partner_fusion_status_to_user(
            state,
            user_id,
            &build_partner_fusion_status_payload(character_id, status),
        );
    }

    if let Ok(status) = load_partner_rebone_status_data(state, character_id).await {
        emit_partner_rebone_status_to_user(
            state,
            user_id,
            &build_partner_rebone_status_payload(character_id, status),
        );
    }

    if let Ok(status) = load_technique_research_status_data(state, character_id).await {
        emit_technique_research_status_to_user(
            state,
            user_id,
            &build_technique_research_status_payload(character_id, status),
        );
    }
}

async fn sync_battle_realtime_on_auth(socket: &SocketRef, state: &AppState, user_id: i64) {
    let current_battle_id = state
        .battle_sessions
        .get_current_for_user(user_id)
        .and_then(|session| session.current_battle_id)
        .or_else(|| {
            state
                .online_battle_projections
                .get_current_for_user(user_id)
                .map(|projection| projection.battle_id)
        });

    let Some(battle_id) = current_battle_id else {
        return;
    };

    if state.battle_runtime.get(&battle_id).is_none() {
        let _ = recover_battle_bundle(state, &battle_id).await;
    }

    if let Some(cooldown_payload) = build_battle_sync_cooldown_payload(state, &battle_id) {
        socket.emit(&cooldown_payload.kind, &cooldown_payload).ok();
    }

    let payload = build_battle_sync_payload_for_user(state, user_id, &battle_id);
    socket.emit("battle:update", &payload).ok();
}

fn disconnect_replaced_socket(io: &SocketIo, socket_id: &str, message: &str) {
    let Ok(sid) = Sid::from_str(socket_id) else {
        return;
    };
    let Some(previous_socket) = io.get_socket(sid) else {
        return;
    };
    previous_socket
        .emit("game:kicked", &build_game_kicked_payload(message))
        .ok();
    previous_socket.disconnect().ok();
}

fn should_disconnect_replaced_socket(previous_socket_id: &str, current_socket_id: &str) -> bool {
    let previous_socket_id = previous_socket_id.trim();
    let current_socket_id = current_socket_id.trim();
    !previous_socket_id.is_empty() && previous_socket_id != current_socket_id
}

async fn handle_socket_disconnect(socket: SocketRef, state: AppState, io: SocketIo) {
    let removed = state
        .realtime_sessions
        .remove_by_socket_id(&socket.id.to_string());
    if let Some(record) = removed {
        state.online_players.remove(record.user_id);
        schedule_emit_online_players(&state, &io, false);
    }
}

async fn handle_online_players_request(socket: SocketRef, state: AppState) {
    if state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
        .is_none()
    {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未认证"
                },
            )
            .ok();
        return;
    }

    let payload = load_online_players_full_payload(&state);

    socket.emit("game:onlinePlayers", &payload).ok();
}

async fn handle_game_refresh(socket: SocketRef, state: AppState, io: SocketIo) {
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未认证"
                },
            )
            .ok();
        return;
    };

    let character = load_game_character_full_by_user_id(&state, session.user_id)
        .await
        .unwrap_or(None);
    let character_id = character.as_ref().map(|value| value.id);

    state.realtime_sessions.register(RealtimeSessionRecord {
        socket_id: session.socket_id.clone(),
        user_id: session.user_id,
        character_id,
        session_token: session.session_token.clone(),
        connected_at_ms: session.connected_at_ms,
    });
    if let Some(character_id) = character_id {
        state.online_players.register(OnlinePlayerRecord {
            user_id: session.user_id,
            character_id: Some(character_id),
            nickname: character.as_ref().map(|value| value.nickname.clone()),
            month_card_active: character
                .as_ref()
                .map(|value| value.month_card_active)
                .unwrap_or(false),
            title: character.as_ref().map(|value| value.title.clone()),
            realm: character.as_ref().map(|value| value.realm.clone()),
            room_id: character
                .as_ref()
                .map(|value| value.current_room_id.clone()),
            connected_at_ms: session.connected_at_ms,
        });
        socket.join(AUTHED_ROOM_ID.to_string());
        socket.join(character_chat_room_id(character_id));
    } else {
        state.online_players.remove(session.user_id);
    }

    socket
        .emit(
            "game:character",
            &build_game_character_full_payload(character),
        )
        .ok();
    schedule_emit_online_players(&state, &io, false);
}

async fn handle_game_add_point(socket: SocketRef, payload: AddPointPayload, state: AppState) {
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未找到角色",
                },
            )
            .ok();
        return;
    };

    let Some(_) = session.character_id else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未找到角色",
                },
            )
            .ok();
        return;
    };

    let Some((attribute, amount)) = validate_add_point_payload(&payload) else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "无效的属性",
                },
            )
            .ok();
        return;
    };

    let updated =
        match mutate_character_attribute_points(&state, session.user_id, attribute, amount).await {
            Ok(updated) => updated,
            Err(_) => {
                socket
                    .emit(
                        "game:error",
                        &GameErrorEvent {
                            message: "服务器错误",
                        },
                    )
                    .ok();
                return;
            }
        };
    if !updated {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "属性点不足",
                },
            )
            .ok();
        return;
    }

    let character = load_game_character_full_by_user_id(&state, session.user_id)
        .await
        .unwrap_or(None);
    let character_id = character.as_ref().map(|value| value.id);
    state.realtime_sessions.register(RealtimeSessionRecord {
        socket_id: session.socket_id.clone(),
        user_id: session.user_id,
        character_id,
        session_token: session.session_token.clone(),
        connected_at_ms: session.connected_at_ms,
    });
    if let Some(character_id) = character_id {
        state.online_players.register(OnlinePlayerRecord {
            user_id: session.user_id,
            character_id: Some(character_id),
            nickname: character.as_ref().map(|value| value.nickname.clone()),
            month_card_active: character
                .as_ref()
                .map(|value| value.month_card_active)
                .unwrap_or(false),
            title: character.as_ref().map(|value| value.title.clone()),
            realm: character.as_ref().map(|value| value.realm.clone()),
            room_id: character
                .as_ref()
                .map(|value| value.current_room_id.clone()),
            connected_at_ms: session.connected_at_ms,
        });
    }

    socket
        .emit(
            "game:character",
            &build_game_character_full_payload(character),
        )
        .ok();
}

async fn handle_battle_sync(socket: SocketRef, payload: BattleSyncPayload, state: AppState) {
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "未认证"
                },
            )
            .ok();
        return;
    };

    let Some(battle_id) = validate_battle_sync_payload(&payload) else {
        socket
            .emit(
                "game:error",
                &GameErrorEvent {
                    message: "缺少战斗ID",
                },
            )
            .ok();
        return;
    };

    if state.battle_runtime.get(battle_id).is_none() {
        let _ = recover_battle_bundle(&state, battle_id).await;
    }

    let payload = build_battle_sync_payload_for_user(&state, session.user_id, battle_id);
    if let Some(cooldown_payload) = build_battle_sync_cooldown_payload(&state, battle_id) {
        if let Some(io) = state.socket_io() {
            if let Ok(sid) = Sid::from_str(&socket.id.to_string()) {
                if let Some(target_socket) = io.get_socket(sid) {
                    let adjusted_payload = adjust_battle_cooldown_payload_for_character(
                        &cooldown_payload,
                        session.character_id,
                    );
                    target_socket
                        .emit(&adjusted_payload.kind, &adjusted_payload)
                        .ok();
                }
            }
        }
    }

    socket.emit("battle:update", &payload).ok();
}

fn build_battle_sync_cooldown_payload(
    state: &AppState,
    battle_id: &str,
) -> Option<crate::realtime::battle::BattleCooldownPayload> {
    let battle_state = state.battle_runtime.get(battle_id)?;
    if battle_state.phase == "finished" || battle_state.current_unit_id.is_none() {
        Some(build_battle_cooldown_ready_payload(
            battle_state.current_unit_id.as_deref(),
        ))
    } else {
        Some(build_battle_cooldown_sync_payload(
            battle_state.current_unit_id.as_deref(),
            1500,
        ))
    }
}

async fn handle_chat_send(socket: SocketRef, payload: ChatSendPayload, state: AppState) {
    let Some(session) = state
        .realtime_sessions
        .get_by_socket_id(&socket.id.to_string())
    else {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_UNAUTHORIZED", "未认证"),
            )
            .ok();
        return;
    };

    let channel = payload.channel.trim();
    let content = payload.content.trim();
    if content.is_empty() {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_EMPTY", "消息内容不能为空"),
            )
            .ok();
        return;
    }
    if content.chars().count() > 200 {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_TOO_LONG", "消息过长"),
            )
            .ok();
        return;
    }
    if channel == "system" {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_SYSTEM_READONLY", "系统频道不允许发言"),
            )
            .ok();
        return;
    }
    if channel == "battle" {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_BATTLE_READONLY", "战况频道不允许发言"),
            )
            .ok();
        return;
    }
    if channel == "all"
        || (channel != "world" && channel != "private" && channel != "team" && channel != "sect")
    {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_UNSUPPORTED", "无效频道"),
            )
            .ok();
        return;
    }
    if let Err(error) = assert_market_phone_bound(&state, session.user_id).await {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_PHONE_REQUIRED", error.to_string().as_str()),
            )
            .ok();
        return;
    }
    match local_sensitive_words_contain(content) {
        Ok(true) => {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_SENSITIVE", "消息包含敏感词，请重新发送"),
                )
                .ok();
            return;
        }
        Ok(false) => {}
        Err(_) => {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload(
                        "CHAT_SENSITIVE_UNAVAILABLE",
                        "敏感词检测服务暂不可用，请稍后重试",
                    ),
                )
                .ok();
            return;
        }
    }

    let sender_record = state.online_players.get(session.user_id);
    let sender_character_id = session.character_id.unwrap_or_default();
    let sender_name = sender_record
        .as_ref()
        .and_then(|record| record.nickname.clone())
        .unwrap_or_else(|| format!("修士{}", sender_character_id.max(1)));
    let sender_title = sender_record
        .as_ref()
        .and_then(|record| record.title.clone())
        .unwrap_or_else(|| "散修".to_string());
    let sender_month_card_active = sender_record
        .as_ref()
        .map(|record| record.month_card_active)
        .unwrap_or(false);
    let timestamp_ms = current_timestamp_ms();
    let message_id = format!("chat-{}-{}", session.user_id, timestamp_ms);

    let message = build_chat_message_payload(
        &message_id,
        payload.client_id.as_deref(),
        channel,
        session.user_id,
        sender_character_id,
        &sender_name,
        sender_month_card_active,
        &sender_title,
        content,
        timestamp_ms,
        payload.pm_target_character_id,
    );

    if channel == "world" {
        if let Some(io) = state.socket_io() {
            io.to(AUTHED_ROOM_ID)
                .emit("chat:message", &message)
                .await
                .ok();
        }
        return;
    } else if channel == "team" {
        if sender_character_id <= 0 {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_TEAM_REQUIRED", "当前不在队伍中"),
                )
                .ok();
            return;
        }
        let Some(team_socket_ids) =
            load_team_chat_recipient_socket_ids(&state, sender_character_id)
                .await
                .ok()
                .flatten()
        else {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_TEAM_REQUIRED", "当前不在队伍中"),
                )
                .ok();
            return;
        };
        if let Some(io) = state.socket_io() {
            for socket_id in team_socket_ids {
                let Ok(sid) = Sid::from_str(&socket_id) else {
                    continue;
                };
                if let Some(target_socket) = io.get_socket(sid) {
                    target_socket.emit("chat:message", &message).ok();
                }
            }
        }
        return;
    } else if channel == "sect" {
        if sender_character_id <= 0 {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_SECT_REQUIRED", "当前不在宗门中"),
                )
                .ok();
            return;
        }
        let Some(sect_socket_ids) =
            load_sect_chat_recipient_socket_ids(&state, sender_character_id)
                .await
                .ok()
                .flatten()
        else {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_SECT_REQUIRED", "当前不在宗门中"),
                )
                .ok();
            return;
        };
        if let Some(io) = state.socket_io() {
            for socket_id in sect_socket_ids {
                let Ok(sid) = Sid::from_str(&socket_id) else {
                    continue;
                };
                if let Some(target_socket) = io.get_socket(sid) {
                    target_socket.emit("chat:message", &message).ok();
                }
            }
        }
        return;
    } else if let Some(target_character_id) = payload.pm_target_character_id {
        if target_character_id <= 0 {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_TARGET_INVALID", "私聊对象无效"),
                )
                .ok();
            return;
        }
        if state
            .realtime_sessions
            .get_by_character_id(target_character_id)
            .is_none()
        {
            socket
                .emit(
                    "chat:error",
                    &build_chat_error_payload("CHAT_TARGET_OFFLINE", "对方不在线"),
                )
                .ok();
            return;
        }
        if let Some(io) = state.socket_io() {
            io.to(character_chat_room_id(sender_character_id))
                .emit("chat:message", &message)
                .await
                .ok();
            io.to(character_chat_room_id(target_character_id))
                .emit("chat:message", &message)
                .await
                .ok();
        }
        return;
    } else {
        socket
            .emit(
                "chat:error",
                &build_chat_error_payload("CHAT_TARGET_MISSING", "缺少私聊对象"),
            )
            .ok();
        return;
    }
}

async fn load_team_chat_recipient_socket_ids(
    state: &AppState,
    sender_character_id: i64,
) -> Result<Option<Vec<String>>, crate::shared::error::AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1",
            |query| query.bind(sender_character_id),
        )
        .await?;
    let Some(team_id) =
        row.and_then(|row| row.try_get::<Option<String>, _>("team_id").ok().flatten())
    else {
        return Ok(None);
    };
    let rows = state
        .database
        .fetch_all(
            "SELECT character_id FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC",
            |query| query.bind(team_id),
        )
        .await?;
    let character_ids = rows
        .into_iter()
        .filter_map(|row| {
            row.try_get::<Option<i32>, _>("character_id")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .collect::<Vec<_>>();
    Ok(Some(collect_connected_socket_ids_for_characters(
        state,
        &character_ids,
    )))
}

async fn load_sect_chat_recipient_socket_ids(
    state: &AppState,
    sender_character_id: i64,
) -> Result<Option<Vec<String>>, crate::shared::error::AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1",
            |query| query.bind(sender_character_id),
        )
        .await?;
    let Some(sect_id) =
        row.and_then(|row| row.try_get::<Option<String>, _>("sect_id").ok().flatten())
    else {
        return Ok(None);
    };
    let rows = state
        .database
        .fetch_all(
            "SELECT character_id FROM sect_member WHERE sect_id = $1 ORDER BY joined_at ASC",
            |query| query.bind(sect_id),
        )
        .await?;
    let character_ids = rows
        .into_iter()
        .filter_map(|row| {
            row.try_get::<Option<i32>, _>("character_id")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .collect::<Vec<_>>();
    Ok(Some(collect_connected_socket_ids_for_characters(
        state,
        &character_ids,
    )))
}

fn collect_connected_socket_ids_for_characters(
    state: &AppState,
    character_ids: &[i64],
) -> Vec<String> {
    let mut socket_ids = Vec::new();
    for character_id in character_ids {
        if let Some(record) = state.realtime_sessions.get_by_character_id(*character_id) {
            if !socket_ids
                .iter()
                .any(|existing| existing == &record.socket_id)
            {
                socket_ids.push(record.socket_id);
            }
        }
    }
    socket_ids
}

fn build_battle_sync_payload_for_user(
    state: &AppState,
    user_id: i64,
    battle_id: &str,
) -> crate::realtime::battle::BattleRealtimePayload {
    let state_snapshot = state.battle_runtime.get(battle_id);
    let session_snapshot = state.battle_sessions.get_by_battle_id(battle_id);

    match state_snapshot {
        Some(state_snapshot) => {
            let logs = Vec::new();
            if state_snapshot.phase == "finished" {
                let (reward_exp, reward_silver) = derive_finished_battle_rewards(&state_snapshot);
                let reward_items = session_snapshot
                    .as_ref()
                    .and_then(|session| match &session.context {
                        crate::state::BattleSessionContextDto::Pve { monster_ids }
                            if matches!(state_snapshot.result.as_deref(), Some("attacker_win")) =>
                        {
                            let owner_character_id =
                                parse_battle_owner_character_id(&state_snapshot);
                            resolve_minimal_pve_item_rewards(
                                monster_ids,
                                &MinimalPveItemRewardResolveOptions {
                                    reward_seed: battle_id.to_string(),
                                    participants: vec![MinimalBattleRewardParticipant {
                                        character_id: owner_character_id,
                                        user_id,
                                        fuyuan: 0.0,
                                        realm: state_snapshot
                                            .teams
                                            .attacker
                                            .units
                                            .first()
                                            .and_then(|unit| unit.current_attrs.realm.clone()),
                                    }],
                                    is_dungeon_battle: false,
                                    dungeon_reward_multiplier: None,
                                },
                            )
                            .ok()
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                build_battle_finished_payload(
                    battle_id,
                    state_snapshot.clone(),
                    logs,
                    session_snapshot.clone(),
                    BattleFinishedMeta {
                        rewards: Some(BattleRewardsPayload {
                            exp: reward_exp,
                            silver: reward_silver,
                            total_exp: None,
                            total_silver: None,
                            participant_count: session_snapshot
                                .as_ref()
                                .map(|s| s.participant_user_ids.len() as i64),
                            items: Some(build_reward_item_values(
                                &reward_items,
                                parse_battle_owner_character_id(&state_snapshot),
                            )),
                            per_player_rewards: Some(build_single_player_reward_values(
                                user_id,
                                parse_battle_owner_character_id(&state_snapshot),
                                reward_exp,
                                reward_silver,
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
                        battle_start_cooldown_ms: None,
                        retry_after_ms: None,
                        next_battle_available_at: None,
                    },
                )
            } else {
                build_battle_started_sync_payload(battle_id, state_snapshot, logs, session_snapshot)
            }
        }
        None => build_battle_abandoned_payload(
            battle_id,
            state.battle_sessions.get_current_for_user(user_id),
            false,
            "战斗不存在或已结束",
        ),
    }
}

fn derive_finished_battle_rewards(state_snapshot: &BattleStateDto) -> (i64, i64) {
    if !matches!(state_snapshot.result.as_deref(), Some("attacker_win")) {
        return (0, 0);
    }
    state_snapshot.teams.defender.units.iter().fold(
        (0_i64, 0_i64),
        |(exp, silver): (i64, i64), unit| {
            let reward_exp = unit
                .reward_exp
                .filter(|value| *value > 0)
                .unwrap_or_else(|| (unit.current_attrs.max_qixue / 10).max(1));
            let reward_silver = unit
                .reward_silver
                .filter(|value| *value > 0)
                .unwrap_or_else(|| (unit.current_attrs.max_qixue / 30).max(1));
            (
                exp.saturating_add(reward_exp),
                silver.saturating_add(reward_silver),
            )
        },
    )
}

fn parse_battle_owner_character_id(state_snapshot: &BattleStateDto) -> i64 {
    state_snapshot
        .teams
        .attacker
        .units
        .first()
        .and_then(|unit| unit.id.strip_prefix("player-"))
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(0)
}

async fn load_game_character_full_by_user_id(
    state: &AppState,
    user_id: i64,
) -> Result<Option<GameCharacterFullSnapshot>, crate::shared::error::AppError> {
    let character_row = state
        .database
        .fetch_optional(
            "SELECT c.id, c.user_id, c.nickname, c.title, c.gender, c.avatar, c.auto_cast_skills, c.auto_disassemble_enabled, c.dungeon_no_stamina_cost, c.spirit_stones, c.silver, c.realm, c.sub_realm, c.exp, c.attribute_points, c.jing, c.qi, c.shen, c.attribute_type, c.attribute_element, COALESCE(c.jing, 0)::bigint AS qixue, COALESCE(c.jing, 0)::bigint AS max_qixue, COALESCE(c.qi, 0)::bigint AS lingqi, COALESCE(c.qi, 0)::bigint AS max_lingqi, 0::bigint AS wugong, 0::bigint AS fagong, 0::bigint AS wufang, 0::bigint AS fafang, 0::bigint AS mingzhong, 0::bigint AS shanbi, 0::bigint AS zhaojia, 0::bigint AS baoji, 0::bigint AS baoshang, 0::bigint AS jianbaoshang, 0::bigint AS jianfantan, 0::bigint AS kangbao, 0::bigint AS zengshang, 0::bigint AS zhiliao, 0::bigint AS jianliao, 0::bigint AS xixue, 0::bigint AS lengque, 0::bigint AS kongzhi_kangxing, 0::bigint AS jin_kangxing, 0::bigint AS mu_kangxing, 0::bigint AS shui_kangxing, 0::bigint AS huo_kangxing, 0::bigint AS tu_kangxing, 0::bigint AS qixue_huifu, 0::bigint AS lingqi_huifu, 0::bigint AS sudu, 0::bigint AS fuyuan, c.current_map_id, c.current_room_id, c.stamina, c.stamina_recover_at::text AS stamina_recover_at_text, COALESCE(cip.level, 0) AS insight_level, mco.start_at::text AS month_card_start_at_text, mco.expire_at::text AS month_card_expire_at_text FROM characters c LEFT JOIN character_insight_progress cip ON cip.character_id = c.id LEFT JOIN month_card_ownership mco ON mco.character_id = c.id AND mco.month_card_id = 'monthcard-001' AND mco.expire_at > NOW() WHERE c.user_id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?;

    let Some(row) = character_row else {
        return Ok(None);
    };

    let character_id = i64::from(row.try_get::<i32, _>("id")?);
    let feature_unlocks = load_character_feature_unlocks(state, character_id).await?;
    let global_buffs = load_character_global_buffs(state, character_id).await?;

    let current_stamina = row
        .try_get::<Option<i32>, _>("stamina")?
        .map(i64::from)
        .unwrap_or_default();
    let insight_level = row
        .try_get::<Option<i64>, _>("insight_level")?
        .unwrap_or_default();
    let stamina_recover_at_text = row.try_get::<Option<String>, _>("stamina_recover_at_text")?;
    let month_card_start_at_text = row.try_get::<Option<String>, _>("month_card_start_at_text")?;
    let month_card_expire_at_text =
        row.try_get::<Option<String>, _>("month_card_expire_at_text")?;
    let month_card_active = month_card_expire_at_text
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());
    let stamina_state = resolve_realtime_stamina_state(
        current_stamina,
        calc_character_stamina_max_by_insight_level(insight_level),
        stamina_recover_at_text.as_deref(),
        month_card_start_at_text.as_deref(),
        month_card_expire_at_text.as_deref(),
        load_default_month_card_stamina_recovery_rate(),
    );

    Ok(Some(GameCharacterFullSnapshot {
        id: character_id,
        user_id: row
            .try_get::<Option<i32>, _>("user_id")?
            .map(i64::from)
            .unwrap_or_default(),
        nickname: row
            .try_get::<Option<String>, _>("nickname")?
            .unwrap_or_default(),
        month_card_active,
        title: row
            .try_get::<Option<String>, _>("title")?
            .unwrap_or_else(|| "散修".to_string()),
        gender: row
            .try_get::<Option<String>, _>("gender")?
            .unwrap_or_else(|| "male".to_string()),
        avatar: row.try_get::<Option<String>, _>("avatar")?,
        auto_cast_skills: row
            .try_get::<Option<bool>, _>("auto_cast_skills")?
            .unwrap_or(true),
        auto_disassemble_enabled: row
            .try_get::<Option<bool>, _>("auto_disassemble_enabled")?
            .unwrap_or(false),
        dungeon_no_stamina_cost: row
            .try_get::<Option<bool>, _>("dungeon_no_stamina_cost")?
            .unwrap_or(false),
        spirit_stones: row
            .try_get::<Option<i64>, _>("spirit_stones")?
            .unwrap_or_default(),
        silver: row.try_get::<Option<i64>, _>("silver")?.unwrap_or_default(),
        stamina: stamina_state.0,
        stamina_max: stamina_state.1,
        realm: row
            .try_get::<Option<String>, _>("realm")?
            .unwrap_or_else(|| "凡人".to_string()),
        sub_realm: row.try_get::<Option<String>, _>("sub_realm")?,
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
        attribute_points: row
            .try_get::<Option<i32>, _>("attribute_points")?
            .map(i64::from)
            .unwrap_or_default(),
        jing: row
            .try_get::<Option<i32>, _>("jing")?
            .map(i64::from)
            .unwrap_or_default(),
        qi: row
            .try_get::<Option<i32>, _>("qi")?
            .map(i64::from)
            .unwrap_or_default(),
        shen: row
            .try_get::<Option<i32>, _>("shen")?
            .map(i64::from)
            .unwrap_or_default(),
        attribute_type: row
            .try_get::<Option<String>, _>("attribute_type")?
            .unwrap_or_else(|| "physical".to_string()),
        attribute_element: row
            .try_get::<Option<String>, _>("attribute_element")?
            .unwrap_or_else(|| "none".to_string()),
        qixue: row.try_get::<Option<i64>, _>("qixue")?.unwrap_or_default(),
        max_qixue: row
            .try_get::<Option<i64>, _>("max_qixue")?
            .unwrap_or_default(),
        lingqi: row.try_get::<Option<i64>, _>("lingqi")?.unwrap_or_default(),
        max_lingqi: row
            .try_get::<Option<i64>, _>("max_lingqi")?
            .unwrap_or_default(),
        wugong: row.try_get::<Option<i64>, _>("wugong")?.unwrap_or_default(),
        fagong: row.try_get::<Option<i64>, _>("fagong")?.unwrap_or_default(),
        wufang: row.try_get::<Option<i64>, _>("wufang")?.unwrap_or_default(),
        fafang: row.try_get::<Option<i64>, _>("fafang")?.unwrap_or_default(),
        mingzhong: row
            .try_get::<Option<i64>, _>("mingzhong")?
            .unwrap_or_default(),
        shanbi: row.try_get::<Option<i64>, _>("shanbi")?.unwrap_or_default(),
        zhaojia: row
            .try_get::<Option<i64>, _>("zhaojia")?
            .unwrap_or_default(),
        baoji: row.try_get::<Option<i64>, _>("baoji")?.unwrap_or_default(),
        baoshang: row
            .try_get::<Option<i64>, _>("baoshang")?
            .unwrap_or_default(),
        jianbaoshang: row
            .try_get::<Option<i64>, _>("jianbaoshang")?
            .unwrap_or_default(),
        jianfantan: row
            .try_get::<Option<i64>, _>("jianfantan")?
            .unwrap_or_default(),
        kangbao: row
            .try_get::<Option<i64>, _>("kangbao")?
            .unwrap_or_default(),
        zengshang: row
            .try_get::<Option<i64>, _>("zengshang")?
            .unwrap_or_default(),
        zhiliao: row
            .try_get::<Option<i64>, _>("zhiliao")?
            .unwrap_or_default(),
        jianliao: row
            .try_get::<Option<i64>, _>("jianliao")?
            .unwrap_or_default(),
        xixue: row.try_get::<Option<i64>, _>("xixue")?.unwrap_or_default(),
        lengque: row
            .try_get::<Option<i64>, _>("lengque")?
            .unwrap_or_default(),
        kongzhi_kangxing: row
            .try_get::<Option<i64>, _>("kongzhi_kangxing")?
            .unwrap_or_default(),
        jin_kangxing: row
            .try_get::<Option<i64>, _>("jin_kangxing")?
            .unwrap_or_default(),
        mu_kangxing: row
            .try_get::<Option<i64>, _>("mu_kangxing")?
            .unwrap_or_default(),
        shui_kangxing: row
            .try_get::<Option<i64>, _>("shui_kangxing")?
            .unwrap_or_default(),
        huo_kangxing: row
            .try_get::<Option<i64>, _>("huo_kangxing")?
            .unwrap_or_default(),
        tu_kangxing: row
            .try_get::<Option<i64>, _>("tu_kangxing")?
            .unwrap_or_default(),
        qixue_huifu: row
            .try_get::<Option<i64>, _>("qixue_huifu")?
            .unwrap_or_default(),
        lingqi_huifu: row
            .try_get::<Option<i64>, _>("lingqi_huifu")?
            .unwrap_or_default(),
        sudu: row.try_get::<Option<i64>, _>("sudu")?.unwrap_or_default(),
        fuyuan: row.try_get::<Option<i64>, _>("fuyuan")?.unwrap_or_default(),
        current_map_id: row
            .try_get::<Option<String>, _>("current_map_id")?
            .unwrap_or_else(|| "map-qingyun-village".to_string()),
        current_room_id: row
            .try_get::<Option<String>, _>("current_room_id")?
            .unwrap_or_else(|| "room-village-center".to_string()),
        feature_unlocks,
        global_buffs,
    }))
}

async fn load_character_feature_unlocks(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<String>, crate::shared::error::AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT feature_code FROM character_feature_unlocks WHERE character_id = $1 ORDER BY unlocked_at ASC, id ASC",
            |query| query.bind(character_id),
        )
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            row.try_get::<Option<String>, _>("feature_code")
                .ok()
                .flatten()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect())
}

async fn load_character_global_buffs(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<GameCharacterGlobalBuff>, crate::shared::error::AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT id, buff_key, source_type, source_id, buff_value, started_at::text AS started_at_text, expire_at::text AS expire_at_text FROM character_global_buff WHERE character_id = $1 AND expire_at > NOW() ORDER BY expire_at ASC, started_at ASC, id ASC",
            |query| query.bind(character_id),
        )
        .await?;

    let mut buffs = Vec::new();
    for row in rows {
        let buff_key = row
            .try_get::<Option<String>, _>("buff_key")?
            .unwrap_or_default();
        let source_type = row
            .try_get::<Option<String>, _>("source_type")?
            .unwrap_or_default();
        let source_id = row
            .try_get::<Option<String>, _>("source_id")?
            .unwrap_or_default();
        let started_at = row
            .try_get::<Option<String>, _>("started_at_text")?
            .unwrap_or_default();
        let expire_at = row
            .try_get::<Option<String>, _>("expire_at_text")?
            .unwrap_or_default();
        if buff_key.trim().is_empty() || started_at.trim().is_empty() || expire_at.trim().is_empty()
        {
            continue;
        }
        let total_duration_ms = calculate_duration_ms(&started_at, &expire_at);
        if total_duration_ms <= 0 {
            continue;
        }
        let buff_value = row
            .try_get::<Option<f64>, _>("buff_value")?
            .unwrap_or_default();
        if let Some((label, icon_text, effect_text)) = format_known_global_buff(
            buff_key.trim(),
            source_type.trim(),
            source_id.trim(),
            buff_value,
        ) {
            buffs.push(GameCharacterGlobalBuff {
                id: format!(
                    "{}|{}|{}",
                    buff_key.trim(),
                    source_type.trim(),
                    source_id.trim()
                ),
                buff_key: buff_key.trim().to_string(),
                label,
                icon_text,
                effect_text,
                started_at,
                expire_at,
                total_duration_ms,
            });
        }
    }
    Ok(buffs)
}

fn format_known_global_buff(
    buff_key: &str,
    source_type: &str,
    source_id: &str,
    buff_value: f64,
) -> Option<(String, String, String)> {
    if buff_key == "fuyuan_flat" && source_type == "sect_blessing" && source_id == "blessing_hall" {
        return Some((
            "祈福".to_string(),
            "祈".to_string(),
            format_fuyuan_effect_text(buff_value),
        ));
    }
    if source_type == "item_use" {
        let normalized = if (buff_value.fract()).abs() < f64::EPSILON {
            format!("{}", buff_value as i64)
        } else {
            format!("{buff_value:.1}")
        };
        return match buff_key {
            "wugong_flat" => Some((
                "力力散".to_string(),
                "力".to_string(),
                format!("物攻 +{normalized}"),
            )),
            "fagong_flat" => Some((
                "灵慧散".to_string(),
                "慧".to_string(),
                format!("法攻 +{normalized}"),
            )),
            "sudu_flat" => Some((
                "御风丹".to_string(),
                "风".to_string(),
                format!("速度 +{normalized}"),
            )),
            "poison" => Some((
                "中毒".to_string(),
                "毒".to_string(),
                format!("中毒 {normalized}"),
            )),
            _ => None,
        };
    }
    None
}

fn calc_character_stamina_max_by_insight_level(insight_level: i64) -> i64 {
    100 + (insight_level.max(0) / 10)
}

fn load_default_month_card_stamina_recovery_rate() -> f64 {
    static RATE: OnceLock<f64> = OnceLock::new();
    *RATE.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/month_card.json");
        let content = fs::read_to_string(path).unwrap_or_default();
        let payload: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        payload
            .get("month_cards")
            .and_then(|value| value.as_array())
            .and_then(|cards| {
                cards.iter().find(|card| {
                    card.get("id").and_then(|value| value.as_str()) == Some("monthcard-001")
                })
            })
            .and_then(|card| card.get("stamina_recovery_rate"))
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0)
    })
}

fn resolve_realtime_stamina_state(
    stamina: i64,
    max_stamina: i64,
    recover_at_text: Option<&str>,
    month_card_start_at_text: Option<&str>,
    month_card_expire_at_text: Option<&str>,
    recovery_speed_rate: f64,
) -> (i64, i64) {
    resolve_realtime_stamina_state_at(
        stamina,
        max_stamina,
        recover_at_text,
        month_card_start_at_text,
        month_card_expire_at_text,
        recovery_speed_rate,
        current_timestamp_ms(),
    )
}

fn resolve_realtime_stamina_state_at(
    stamina: i64,
    max_stamina: i64,
    recover_at_text: Option<&str>,
    month_card_start_at_text: Option<&str>,
    month_card_expire_at_text: Option<&str>,
    recovery_speed_rate: f64,
    now_ms: i64,
) -> (i64, i64) {
    let safe_max_stamina = max_stamina.max(1);
    let safe_stamina = stamina.clamp(0, safe_max_stamina);
    let recover_at_ms = parse_datetime_millis(recover_at_text).unwrap_or(now_ms);
    if safe_stamina >= safe_max_stamina || now_ms <= recover_at_ms {
        return (safe_stamina, safe_max_stamina);
    }

    let effective_elapsed_ms = calc_effective_stamina_elapsed_ms(
        recover_at_ms,
        now_ms,
        parse_datetime_millis(month_card_start_at_text),
        parse_datetime_millis(month_card_expire_at_text),
        recovery_speed_rate.clamp(0.0, 1.0),
    );
    let ticks = (effective_elapsed_ms / 300_000.0).floor() as i64;
    if ticks <= 0 {
        return (safe_stamina, safe_max_stamina);
    }

    let recovered_total = ticks;
    (
        (safe_stamina + recovered_total).clamp(0, safe_max_stamina),
        safe_max_stamina,
    )
}

fn calc_effective_stamina_elapsed_ms(
    start_ms: i64,
    end_ms: i64,
    window_start_ms: Option<i64>,
    window_expire_ms: Option<i64>,
    recovery_speed_rate: f64,
) -> f64 {
    if end_ms <= start_ms {
        return 0.0;
    }
    let real_elapsed_ms = (end_ms - start_ms) as f64;
    if recovery_speed_rate <= 0.0 {
        return real_elapsed_ms;
    }
    let Some(expire_ms) = window_expire_ms else {
        return real_elapsed_ms;
    };
    let active_start_ms = window_start_ms.unwrap_or(start_ms);
    let overlap_start_ms = start_ms.max(active_start_ms);
    let overlap_end_ms = end_ms.min(expire_ms);
    let overlap_ms = (overlap_end_ms - overlap_start_ms).max(0);
    real_elapsed_ms + (overlap_ms as f64) * recovery_speed_rate
}

fn parse_datetime_millis(raw: Option<&str>) -> Option<i64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let parsed = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .ok()
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond][offset_hour sign:mandatory]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second][offset_hour sign:mandatory]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond][offset_hour sign:mandatory]:[offset_minute]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second][offset_hour sign:mandatory]:[offset_minute]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond][offset_hour sign:mandatory]:[offset_minute]:[offset_second]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                text,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second][offset_hour sign:mandatory]:[offset_minute]:[offset_second]"
                ),
            )
            .ok()
        })?;
    Some(parsed.unix_timestamp_nanos() as i64 / 1_000_000)
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

const ONLINE_PLAYERS_EMIT_INTERVAL_MS: i64 = 800;
const AUTHED_ROOM_ID: &str = "chat:authed";
const CHARACTER_CHAT_ROOM_PREFIX: &str = "chat:character:";

fn character_chat_room_id(character_id: i64) -> String {
    format!("{CHARACTER_CHAT_ROOM_PREFIX}{character_id}")
}

fn schedule_emit_online_players(state: &AppState, io: &SocketIo, force: bool) {
    if state.online_players.mark_online_players_emit_timer_active() {
        state.online_players.mark_online_players_emit_queued();
        return;
    }
    let now = current_timestamp_ms();
    let last_emit_at = state.online_players.online_players_last_emit_at_ms();
    let wait_ms = if force {
        0
    } else {
        (ONLINE_PLAYERS_EMIT_INTERVAL_MS - (now - last_emit_at)).max(0)
    };
    let state = state.clone();
    let io = io.clone();
    tokio::spawn(async move {
        if wait_ms > 0 {
            sleep(Duration::from_millis(wait_ms as u64)).await;
        }
        state
            .online_players
            .set_online_players_last_emit_at_ms(current_timestamp_ms());
        emit_online_players_now(&io, &state);
        state
            .online_players
            .clear_online_players_emit_timer_active();
        if state.online_players.take_online_players_emit_queued() {
            schedule_emit_online_players(&state, &io, false);
        }
    });
}

fn emit_online_players_now(io: &SocketIo, state: &AppState) {
    let previous = state.online_players.take_last_broadcasted_players();
    let current = state.online_players.snapshot_dto_map();
    let Some(payload) = build_online_players_broadcast_payload(&previous, &current) else {
        return;
    };
    state
        .online_players
        .replace_last_broadcasted_players(current);

    let io = io.clone();
    tokio::spawn(async move {
        io.to(AUTHED_ROOM_ID)
            .emit("game:onlinePlayers", &payload)
            .await
            .ok();
    });
}

fn load_online_players_full_payload(
    state: &AppState,
) -> crate::realtime::online_players::OnlinePlayersPayload {
    let mut players = state
        .online_players
        .snapshot_dto_map()
        .into_values()
        .collect::<Vec<_>>();
    players.sort_by(|a, b| a.nickname.cmp(&b.nickname).then(a.id.cmp(&b.id)));
    build_online_players_full_payload(players)
}

async fn mutate_character_attribute_points(
    state: &AppState,
    user_id: i64,
    attribute: &str,
    amount: i64,
) -> Result<bool, crate::shared::error::AppError> {
    let sql = format!(
        "WITH target_character AS ( SELECT id FROM characters WHERE user_id = $1 LIMIT 1 ), updated_character AS ( UPDATE characters SET {attribute} = {attribute} + $2, attribute_points = attribute_points - $2, updated_at = CURRENT_TIMESTAMP FROM target_character WHERE characters.id = target_character.id AND characters.attribute_points >= $2 RETURNING characters.id ) SELECT EXISTS(SELECT 1 FROM updated_character) AS updated"
    );
    let row = state
        .database
        .fetch_one(&sql, |query| query.bind(user_id).bind(amount))
        .await?;
    Ok(row.try_get::<bool, _>("updated").unwrap_or(false))
}

pub fn emit_battle_update_to_participants(
    state: &AppState,
    participant_user_ids: &[i64],
    payload: &BattleRealtimePayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    for socket_id in collect_connected_socket_ids_for_users(state, participant_user_ids) {
        let Ok(sid) = Sid::from_str(&socket_id) else {
            continue;
        };
        if let Some(socket) = io.get_socket(sid) {
            socket.emit("battle:update", payload).ok();
        }
    }
}

pub fn emit_mail_update_to_user(state: &AppState, user_id: i64, payload: &MailUpdatePayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("mail:update", payload).ok();
    }
}

pub fn emit_game_character_to_user(state: &AppState, user_id: i64, payload: &GameCharacterPayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("game:character", payload).ok();
    }
}

pub async fn emit_game_character_full_to_user(
    state: &AppState,
    user_id: i64,
) -> Result<(), crate::shared::error::AppError> {
    let payload = build_game_character_full_payload(
        load_game_character_full_by_user_id(state, user_id).await?,
    );
    emit_game_character_to_user(state, user_id, &payload);
    Ok(())
}

pub fn emit_idle_realtime_to_user(state: &AppState, user_id: i64, payload: &IdleRealtimePayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit(&payload.kind, payload).ok();
    }
}

pub fn emit_achievement_update_to_user(
    state: &AppState,
    user_id: i64,
    payload: &AchievementIndicatorPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("achievement:update", payload).ok();
    }
}

pub fn emit_arena_update_to_user<T: serde::Serialize>(state: &AppState, user_id: i64, payload: &T) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("arena:update", payload).ok();
    }
}

pub fn emit_sect_update_to_user(state: &AppState, user_id: i64, payload: &SectIndicatorPayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("sect:update", payload).ok();
    }
}

pub fn emit_team_update_to_characters(
    state: &AppState,
    character_ids: &[i64],
    payload: &TeamUpdatePayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let mut socket_ids = Vec::new();
    for character_id in character_ids {
        if let Some(record) = state.realtime_sessions.get_by_character_id(*character_id) {
            if !socket_ids
                .iter()
                .any(|existing| existing == &record.socket_id)
            {
                socket_ids.push(record.socket_id);
            }
        }
    }
    for socket_id in socket_ids {
        let Ok(sid) = Sid::from_str(&socket_id) else {
            continue;
        };
        if let Some(socket) = io.get_socket(sid) {
            socket.emit("team:update", payload).ok();
        }
    }
}

pub fn emit_task_update_to_user(
    state: &AppState,
    user_id: i64,
    payload: &TaskOverviewUpdatePayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("task:update", payload).ok();
    }
}

pub fn emit_game_time_sync_to_user(state: &AppState, user_id: i64, payload: &GameTimeSyncPayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("game:time-sync", payload).ok();
    }
}

pub fn emit_wander_update_to_user(state: &AppState, user_id: i64, payload: &WanderUpdatePayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("wander:update", payload).ok();
    }
}

pub fn emit_market_update_to_user(state: &AppState, user_id: i64, payload: &MarketUpdatePayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("market:update", payload).ok();
    }
}

pub fn emit_rank_update_to_user(state: &AppState, user_id: i64, payload: &RankUpdatePayload) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("rank:update", payload).ok();
    }
}

pub fn emit_partner_recruit_status_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerRecruitStatusPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerRecruit:update", payload).ok();
    }
}

pub fn emit_partner_recruit_result_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerRecruitResultPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerRecruitResult", payload).ok();
    }
}

pub fn emit_partner_fusion_status_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerFusionStatusPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerFusion:update", payload).ok();
    }
}

pub fn emit_partner_fusion_result_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerFusionResultPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerFusionResult", payload).ok();
    }
}

pub fn emit_partner_rebone_status_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerReboneStatusPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerRebone:update", payload).ok();
    }
}

pub fn emit_partner_rebone_result_to_user(
    state: &AppState,
    user_id: i64,
    payload: &PartnerReboneResultPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("partnerReboneResult", payload).ok();
    }
}

pub fn emit_technique_research_status_to_user(
    state: &AppState,
    user_id: i64,
    payload: &TechniqueResearchStatusPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("techniqueResearch:update", payload).ok();
    }
}

pub fn emit_technique_research_result_to_user(
    state: &AppState,
    user_id: i64,
    payload: &TechniqueResearchResultPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    let Some(socket_id) = connected_socket_id_for_user(state, user_id) else {
        return;
    };
    let Ok(sid) = Sid::from_str(&socket_id) else {
        return;
    };
    if let Some(socket) = io.get_socket(sid) {
        socket.emit("techniqueResearchResult", payload).ok();
    }
}

pub fn emit_battle_cooldown_to_participants(
    state: &AppState,
    participant_user_ids: &[i64],
    payload: &BattleCooldownPayload,
) {
    let Some(io) = state.socket_io() else {
        return;
    };
    for (socket_id, adjusted_payload) in
        build_battle_cooldown_recipient_payloads(state, participant_user_ids, payload)
    {
        let Ok(sid) = Sid::from_str(&socket_id) else {
            continue;
        };
        if let Some(socket) = io.get_socket(sid) {
            socket.emit(&adjusted_payload.kind, &adjusted_payload).ok();
        }
    }
}

fn build_battle_cooldown_recipient_payloads(
    state: &AppState,
    participant_user_ids: &[i64],
    payload: &BattleCooldownPayload,
) -> Vec<(String, BattleCooldownPayload)> {
    let mut values = Vec::new();
    for user_id in participant_user_ids {
        let Some(record) = state.realtime_sessions.get_by_user_id(*user_id) else {
            continue;
        };
        values.push((
            record.socket_id,
            adjust_battle_cooldown_payload_for_character(payload, record.character_id),
        ));
    }
    values
}

fn adjust_battle_cooldown_payload_for_character(
    payload: &BattleCooldownPayload,
    character_id: Option<i64>,
) -> BattleCooldownPayload {
    BattleCooldownPayload {
        kind: payload.kind.clone(),
        character_id: character_id.unwrap_or(payload.character_id).max(0),
        remaining_ms: payload.remaining_ms,
        timestamp: payload.timestamp,
    }
}

fn collect_connected_socket_ids_for_users(
    state: &AppState,
    participant_user_ids: &[i64],
) -> Vec<String> {
    let mut socket_ids = Vec::new();
    for user_id in participant_user_ids {
        if let Some(record) = state.realtime_sessions.get_by_user_id(*user_id) {
            if !socket_ids
                .iter()
                .any(|existing| existing == &record.socket_id)
            {
                socket_ids.push(record.socket_id);
            }
        }
    }
    socket_ids
}

fn connected_socket_id_for_user(state: &AppState, user_id: i64) -> Option<String> {
    state
        .realtime_sessions
        .get_by_user_id(user_id)
        .map(|record| record.socket_id)
}

fn validate_add_point_payload(payload: &AddPointPayload) -> Option<(&str, i64)> {
    let attribute = payload.attribute.trim();
    let amount = payload.amount.unwrap_or(1);
    if !matches!(attribute, "jing" | "qi" | "shen") {
        return None;
    }
    if !(1..=100).contains(&amount) {
        return None;
    }
    Some((attribute, amount))
}

fn validate_battle_sync_payload(payload: &BattleSyncPayload) -> Option<&str> {
    let battle_id = payload.battle_id.as_deref()?.trim();
    if battle_id.is_empty() {
        return None;
    }
    Some(battle_id)
}

#[cfg(test)]
mod tests {
    use super::{
        AddPointPayload, BattleSyncPayload, build_battle_cooldown_recipient_payloads,
        build_battle_sync_payload_for_user, collect_connected_socket_ids_for_characters,
        collect_connected_socket_ids_for_users, connected_socket_id_for_user,
        should_disconnect_replaced_socket, validate_add_point_payload,
        validate_battle_sync_payload,
    };
    use crate::battle_runtime::build_minimal_pve_battle_state;
    use crate::config::{
        AppConfig, CaptchaConfig, CaptchaProvider, CosConfig, DatabaseConfig, HttpConfig,
        LoggingConfig, MarketPhoneBindingConfig, OutboundHttpConfig, RedisConfig, ServiceConfig,
        StorageConfig, WanderConfig,
    };
    use crate::http::arena::ArenaStatusDto;
    use crate::http::character_technique::{
        TechniqueResearchNameRulesDto, TechniqueResearchStatusDto,
    };
    use crate::http::partner::PartnerFusionStatusDto;
    use crate::http::partner::PartnerRecruitStatusDto;
    use crate::integrations::database::DatabaseRuntime;
    use crate::realtime::achievement::AchievementIndicatorPayload;
    use crate::realtime::arena::{ArenaRefreshPayload, ArenaStatusPayload};
    use crate::realtime::battle::BattleCooldownPayload;
    use crate::realtime::game_time::GameTimeSyncPayload;
    use crate::realtime::idle::IdleRealtimePayload;
    use crate::realtime::mail::MailUpdatePayload;
    use crate::realtime::partner_fusion::{PartnerFusionResultPayload, PartnerFusionStatusPayload};
    use crate::realtime::partner_rebone::PartnerReboneResultPayload;
    use crate::realtime::partner_recruit::PartnerRecruitResultPayload;
    use crate::realtime::partner_recruit::PartnerRecruitStatusPayload;
    use crate::realtime::sect::SectIndicatorPayload;
    use crate::realtime::task::TaskOverviewUpdatePayload;
    use crate::realtime::team::TeamUpdatePayload;
    use crate::realtime::technique_research::{
        TechniqueResearchResultPayload, TechniqueResearchStatusPayload,
    };
    use crate::realtime::wander::WanderUpdatePayload;
    use crate::state::{
        AppState, BattleSessionContextDto, BattleSessionSnapshotDto, RealtimeSessionRecord,
    };
    use std::sync::Arc;

    const NOW_2026_04_27_00_10_00_UTC_MS: i64 = 1_777_248_600_000;

    #[test]
    fn duplicate_login_does_not_disconnect_same_socket_id() {
        assert!(!should_disconnect_replaced_socket(
            "same-socket-1234",
            "same-socket-1234"
        ));
        assert!(should_disconnect_replaced_socket(
            "old-socket-1234",
            "new-socket-5678"
        ));
        assert!(!should_disconnect_replaced_socket("", "new-socket-5678"));
    }

    #[test]
    fn realtime_stamina_recovery_counts_month_card_speed_window() {
        let result = super::resolve_realtime_stamina_state_at(
            10,
            100,
            Some("2026-04-27T00:00:00Z"),
            Some("2026-04-27T00:00:00Z"),
            Some("2026-04-27T00:10:00Z"),
            0.5,
            NOW_2026_04_27_00_10_00_UTC_MS,
        );

        assert_eq!(result, (13, 100));
    }

    #[test]
    fn realtime_stamina_recovery_clamps_month_card_rate_to_one() {
        let result = super::resolve_realtime_stamina_state_at(
            10,
            100,
            Some("2026-04-27T00:00:00Z"),
            Some("2026-04-27T00:00:00Z"),
            Some("2026-04-27T00:10:00Z"),
            9.0,
            NOW_2026_04_27_00_10_00_UTC_MS,
        );

        assert_eq!(result, (14, 100));
    }

    #[test]
    fn realtime_stamina_recovery_uses_now_for_invalid_recover_at() {
        let result = super::resolve_realtime_stamina_state_at(
            10,
            100,
            Some("not-a-date"),
            Some("2026-04-27T00:00:00Z"),
            Some("2026-04-27T00:10:00Z"),
            0.5,
            NOW_2026_04_27_00_10_00_UTC_MS,
        );

        assert_eq!(result, (10, 100));
    }

    #[test]
    fn realtime_stamina_recovery_parses_postgresql_datetime_text() {
        let result = super::resolve_realtime_stamina_state_at(
            10,
            100,
            Some("2026-04-27 00:00:00+00"),
            Some("2026-04-27 00:00:00+00"),
            Some("2026-04-27 00:10:00+00"),
            0.5,
            NOW_2026_04_27_00_10_00_UTC_MS,
        );

        assert_eq!(result, (13, 100));
    }

    #[test]
    fn realtime_stamina_recovery_parses_postgresql_offset_variants() {
        assert_eq!(
            super::parse_datetime_millis(Some("2026-04-27 00:00:00-07")),
            super::parse_datetime_millis(Some("2026-04-27T07:00:00Z"))
        );
        assert_eq!(
            super::parse_datetime_millis(Some("2026-04-27 05:45:00+05:45")),
            super::parse_datetime_millis(Some("2026-04-27T00:00:00Z"))
        );
        assert_eq!(
            super::parse_datetime_millis(Some("2026-04-27 05:45:30+05:45:30")),
            super::parse_datetime_millis(Some("2026-04-27T00:00:00Z"))
        );
    }

    #[test]
    fn realtime_stamina_recovery_keeps_fractional_elapsed_until_tick_floor() {
        let effective =
            super::calc_effective_stamina_elapsed_ms(0, 299_999, Some(299_994), Some(299_999), 0.1);

        assert!((effective - 299_999.5).abs() < 1e-9);
        assert_eq!((effective / 300_000.0).floor() as i64, 0);
    }

    #[test]
    fn add_point_payload_validation_matches_contract() {
        assert_eq!(
            validate_add_point_payload(&AddPointPayload {
                attribute: "jing".to_string(),
                amount: Some(2)
            })
            .map(|(attribute, amount)| (attribute.to_string(), amount)),
            Some(("jing".to_string(), 2))
        );
        assert!(
            validate_add_point_payload(&AddPointPayload {
                attribute: "xxx".to_string(),
                amount: Some(1)
            })
            .is_none()
        );
        assert!(
            validate_add_point_payload(&AddPointPayload {
                attribute: "jing".to_string(),
                amount: Some(0)
            })
            .is_none()
        );
    }

    #[test]
    fn battle_sync_payload_validation_matches_contract() {
        assert_eq!(
            validate_battle_sync_payload(&BattleSyncPayload {
                battle_id: Some("battle-1".to_string())
            }),
            Some("battle-1")
        );
        assert!(
            validate_battle_sync_payload(&BattleSyncPayload {
                battle_id: Some("  ".to_string())
            })
            .is_none()
        );
        assert!(validate_battle_sync_payload(&BattleSyncPayload { battle_id: None }).is_none());
    }

    fn test_state() -> AppState {
        let config = Arc::new(AppConfig {
            service: ServiceConfig {
                name: "九州修仙录 Rust Backend".to_string(),
                version: "0.1.0".to_string(),
                node_env: "test".to_string(),
                jwt_secret: "test-secret".to_string(),
                jwt_expires_in: "7d".to_string(),
            },
            http: HttpConfig {
                host: "127.0.0.1".to_string(),
                port: 6011,
                cors_origin: "*".to_string(),
            },
            wander: WanderConfig {
                ai_enabled: false,
                model_provider: String::new(),
                model_url: String::new(),
                model_key: String::new(),
                model_name: String::new(),
            },
            captcha: CaptchaConfig {
                provider: CaptchaProvider::Local,
                tencent_app_id: 0,
                tencent_app_secret_key: String::new(),
                tencent_secret_id: String::new(),
                tencent_secret_key: String::new(),
            },
            market_phone_binding: MarketPhoneBindingConfig {
                enabled: false,
                aliyun_access_key_id: String::new(),
                aliyun_access_key_secret: String::new(),
                sign_name: String::new(),
                template_code: String::new(),
                code_expire_seconds: 300,
                send_cooldown_seconds: 60,
                send_hourly_limit: 5,
                send_daily_limit: 10,
            },
            database: DatabaseConfig {
                url: "postgresql://postgres:postgres@localhost:5432/jiuzhou".to_string(),
            },
            redis: RedisConfig {
                url: "redis://127.0.0.1:6379".to_string(),
            },
            outbound_http: OutboundHttpConfig { timeout_ms: 1_000 },
            storage: StorageConfig {
                uploads_dir: std::env::temp_dir().join("server-rs-test-uploads"),
            },
            cos: CosConfig {
                secret_id: String::new(),
                secret_key: String::new(),
                bucket: String::new(),
                region: String::new(),
                avatar_prefix: "avatars/".to_string(),
                generated_image_prefix: "generated/".to_string(),
                domain: String::new(),
                sts_duration_seconds: 600,
            },
            logging: LoggingConfig {
                level: "debug".to_string(),
            },
        });

        let database = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy(&config.database.url)
            .expect("lazy postgres pool should build for tests");
        let redis = Some(
            redis::Client::open(config.redis.url.clone()).expect("test redis client should build"),
        );
        let http_client = reqwest::Client::new();

        AppState::new(
            config,
            DatabaseRuntime::new(database),
            redis,
            http_client,
            true,
        )
    }

    #[tokio::test]
    async fn battle_sync_missing_battle_builds_abandoned_payload_without_database() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-77".to_string(),
            user_id: 77,
            character_id: Some(770),
            session_token: Some("sess-77".to_string()),
            connected_at_ms: 1,
        });
        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: "session-77".to_string(),
            session_type: "pve".to_string(),
            owner_user_id: 77,
            participant_user_ids: vec![77],
            current_battle_id: Some("current-battle".to_string()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        });

        let payload = serde_json::to_value(build_battle_sync_payload_for_user(
            &state,
            77,
            "missing-battle",
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_abandoned");
        assert_eq!(payload["battleId"], "missing-battle");
        assert_eq!(payload["message"], "战斗不存在或已结束");
        println!("BATTLE_SYNC_MISSING_PAYLOAD={payload}");
    }

    #[tokio::test]
    async fn battle_sync_existing_battle_builds_started_snapshot_without_database() {
        let state = test_state();
        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: "session-88".to_string(),
            session_type: "pve".to_string(),
            owner_user_id: 88,
            participant_user_ids: vec![88],
            current_battle_id: Some("battle-88".to_string()),
            status: "running".to_string(),
            next_action: "none".to_string(),
            can_advance: false,
            last_result: None,
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        });
        state
            .battle_runtime
            .register(build_minimal_pve_battle_state(
                "battle-88",
                880,
                &["monster-gray-wolf".to_string()],
            ));

        let payload =
            serde_json::to_value(build_battle_sync_payload_for_user(&state, 88, "battle-88"))
                .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_started");
        assert_eq!(payload["battleId"], "battle-88");
        assert_eq!(payload["authoritative"], true);
        assert!(payload.get("unitsDelta").is_none());
        assert!(
            payload["state"]["teams"]["attacker"]["units"][0]
                .get("baseAttrs")
                .is_some()
        );
        println!("BATTLE_SYNC_EXISTING_PAYLOAD={payload}");
    }

    #[tokio::test]
    async fn battle_sync_finished_battle_includes_rewards_without_database() {
        let state = test_state();
        state.battle_sessions.register(BattleSessionSnapshotDto {
            session_id: "session-finished".to_string(),
            session_type: "pve".to_string(),
            owner_user_id: 88,
            participant_user_ids: vec![88],
            current_battle_id: Some("battle-finished".to_string()),
            status: "running".to_string(),
            next_action: "return_to_map".to_string(),
            can_advance: true,
            last_result: Some("attacker_win".to_string()),
            context: BattleSessionContextDto::Pve {
                monster_ids: vec!["monster-gray-wolf".to_string()],
            },
        });
        state
            .battle_runtime
            .register(build_minimal_pve_battle_state(
                "battle-finished",
                880,
                &["monster-gray-wolf".to_string()],
            ));
        state.battle_runtime.update("battle-finished", |battle| {
            battle.phase = "finished".to_string();
            battle.result = Some("attacker_win".to_string());
        });

        let payload = serde_json::to_value(build_battle_sync_payload_for_user(
            &state,
            88,
            "battle-finished",
        ))
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "battle_finished");
        assert_eq!(payload["result"], "attacker_win");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["rewards"]["participantCount"], 1);
        assert!(payload["rewards"]["exp"].as_i64().unwrap_or_default() > 0);
        assert!(payload["rewards"]["silver"].as_i64().unwrap_or_default() > 0);
        println!("BATTLE_SYNC_FINISHED_PAYLOAD={payload}");
    }

    #[tokio::test]
    async fn battle_realtime_collects_only_connected_participant_sockets() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-1".to_string(),
            user_id: 1,
            character_id: Some(11),
            session_token: Some("sess-1".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-2".to_string(),
            user_id: 2,
            character_id: Some(22),
            session_token: Some("sess-2".to_string()),
            connected_at_ms: 2,
        });

        let socket_ids = collect_connected_socket_ids_for_users(&state, &[2, 3, 2, 1]);
        assert_eq!(
            socket_ids,
            vec!["socket-2".to_string(), "socket-1".to_string()]
        );
    }

    #[tokio::test]
    async fn team_chat_collects_only_connected_member_sockets() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-team-1".to_string(),
            user_id: 1,
            character_id: Some(101),
            session_token: Some("sess-1".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-team-2".to_string(),
            user_id: 2,
            character_id: Some(202),
            session_token: Some("sess-2".to_string()),
            connected_at_ms: 2,
        });

        let socket_ids = collect_connected_socket_ids_for_characters(&state, &[202, 303, 202, 101]);
        assert_eq!(
            socket_ids,
            vec!["socket-team-2".to_string(), "socket-team-1".to_string()]
        );
    }

    #[tokio::test]
    async fn sect_chat_collects_only_connected_member_sockets() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-sect-1".to_string(),
            user_id: 3,
            character_id: Some(303),
            session_token: Some("sess-3".to_string()),
            connected_at_ms: 3,
        });
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-sect-2".to_string(),
            user_id: 4,
            character_id: Some(404),
            session_token: Some("sess-4".to_string()),
            connected_at_ms: 4,
        });

        let socket_ids = collect_connected_socket_ids_for_characters(&state, &[404, 505, 303]);
        assert_eq!(
            socket_ids,
            vec!["socket-sect-2".to_string(), "socket-sect-1".to_string()]
        );
    }

    #[tokio::test]
    async fn battle_cooldown_payload_uses_recipient_character_id() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-1".to_string(),
            user_id: 1,
            character_id: Some(101),
            session_token: Some("sess-1".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-2".to_string(),
            user_id: 2,
            character_id: Some(202),
            session_token: Some("sess-2".to_string()),
            connected_at_ms: 2,
        });

        let payloads = build_battle_cooldown_recipient_payloads(
            &state,
            &[1, 2],
            &BattleCooldownPayload {
                kind: "battle:cooldown-sync".to_string(),
                character_id: 999,
                remaining_ms: Some(1500),
                timestamp: 123456,
            },
        );

        assert_eq!(payloads.len(), 2);
        assert_eq!(payloads[0].0, "socket-1");
        assert_eq!(payloads[0].1.character_id, 101);
        assert_eq!(payloads[1].0, "socket-2");
        assert_eq!(payloads[1].1.character_id, 202);
    }

    #[tokio::test]
    async fn mail_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-mail-1".to_string(),
            user_id: 11,
            character_id: Some(111),
            session_token: Some("sess-11".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 11);
        assert_eq!(socket_id.as_deref(), Some("socket-mail-1"));

        let missing = connected_socket_id_for_user(&state, 99);
        assert!(missing.is_none());

        let payload = serde_json::to_value(MailUpdatePayload {
            kind: "mail:update".to_string(),
            unread_count: 3,
            unclaimed_count: 1,
            source: "claim_mail".to_string(),
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "mail:update");
    }

    #[tokio::test]
    async fn idle_update_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-idle-1".to_string(),
            user_id: 12,
            character_id: Some(121),
            session_token: Some("sess-12".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 12);
        assert_eq!(socket_id.as_deref(), Some("socket-idle-1"));

        let payload = serde_json::to_value(IdleRealtimePayload {
            kind: "idle:update".to_string(),
            session_id: Some("idle-1".to_string()),
            batch_index: Some(3),
            result: Some("attacker_win".to_string()),
            exp_gained: Some(30),
            silver_gained: Some(12),
            items_gained: Some(Vec::new()),
            round_count: Some(1),
            reason: None,
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "idle:update");
        assert_eq!(payload["sessionId"], "idle-1");
        assert_eq!(payload["result"], "attacker_win");
    }

    #[tokio::test]
    async fn idle_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-idle-1".to_string(),
            user_id: 12,
            character_id: Some(121),
            session_token: Some("sess-12".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 12);
        assert_eq!(socket_id.as_deref(), Some("socket-idle-1"));

        let payload = serde_json::to_value(IdleRealtimePayload {
            kind: "idle:finished".to_string(),
            session_id: Some("idle-1".to_string()),
            batch_index: None,
            result: None,
            exp_gained: None,
            silver_gained: None,
            items_gained: None,
            round_count: None,
            reason: Some("completed".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "idle:finished");
        assert_eq!(payload["sessionId"], "idle-1");
        assert_eq!(payload["reason"], "completed");
    }

    #[tokio::test]
    async fn team_realtime_routes_to_connected_character_sockets() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-team-1".to_string(),
            user_id: 11,
            character_id: Some(111),
            session_token: Some("sess-11".to_string()),
            connected_at_ms: 1,
        });
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-team-2".to_string(),
            user_id: 22,
            character_id: Some(222),
            session_token: Some("sess-22".to_string()),
            connected_at_ms: 2,
        });

        let payload = serde_json::to_value(TeamUpdatePayload {
            kind: "team:update".to_string(),
            source: "transfer_team_leader".to_string(),
            team_id: Some("team-1".to_string()),
            message: Some("队长已转让".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "team:update");
        assert_eq!(payload["teamId"], "team-1");

        let first = state
            .realtime_sessions
            .get_by_character_id(111)
            .map(|record| record.socket_id);
        let second = state
            .realtime_sessions
            .get_by_character_id(222)
            .map(|record| record.socket_id);
        assert_eq!(first.as_deref(), Some("socket-team-1"));
        assert_eq!(second.as_deref(), Some("socket-team-2"));
    }

    #[tokio::test]
    async fn task_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-task-1".to_string(),
            user_id: 31,
            character_id: Some(311),
            session_token: Some("sess-31".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 31);
        assert_eq!(socket_id.as_deref(), Some("socket-task-1"));

        let payload = serde_json::to_value(TaskOverviewUpdatePayload {
            character_id: 311,
            scopes: vec!["task".to_string()],
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 311);
        assert_eq!(payload["scopes"][0], "task");
    }

    #[tokio::test]
    async fn achievement_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-achievement-1".to_string(),
            user_id: 41,
            character_id: Some(411),
            session_token: Some("sess-41".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 41);
        assert_eq!(socket_id.as_deref(), Some("socket-achievement-1"));

        let payload = serde_json::to_value(AchievementIndicatorPayload {
            character_id: 411,
            claimable_count: 2,
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 411);
        assert_eq!(payload["claimableCount"], 2);
    }

    #[tokio::test]
    async fn arena_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-arena-1".to_string(),
            user_id: 91,
            character_id: Some(911),
            session_token: Some("sess-91".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 91);
        assert_eq!(socket_id.as_deref(), Some("socket-arena-1"));

        let payload = serde_json::to_value(ArenaStatusPayload {
            kind: "arena_status".to_string(),
            status: ArenaStatusDto {
                score: 1200,
                win_count: 12,
                lose_count: 3,
                today_used: 2,
                today_limit: 5,
                today_remaining: 3,
            },
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "arena_status");
        assert_eq!(payload["status"]["score"], 1200);
    }

    #[tokio::test]
    async fn arena_refresh_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-arena-refresh-1".to_string(),
            user_id: 92,
            character_id: Some(9201),
            session_token: Some("sess-92".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 92);
        assert_eq!(socket_id.as_deref(), Some("socket-arena-refresh-1"));

        let payload = serde_json::to_value(ArenaRefreshPayload {
            kind: "arena_refresh".to_string(),
        })
        .expect("payload should serialize");
        assert_eq!(payload["kind"], "arena_refresh");
    }

    #[tokio::test]
    async fn sect_realtime_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-sect-1".to_string(),
            user_id: 61,
            character_id: Some(611),
            session_token: Some("sess-61".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 61);
        assert_eq!(socket_id.as_deref(), Some("socket-sect-1"));

        let payload = serde_json::to_value(SectIndicatorPayload {
            joined: true,
            my_pending_application_count: 1,
            sect_pending_application_count: 3,
            can_manage_applications: true,
        })
        .expect("payload should serialize");
        assert_eq!(payload["joined"], true);
        assert_eq!(payload["myPendingApplicationCount"], 1);
        assert_eq!(payload["sectPendingApplicationCount"], 3);
        assert_eq!(payload["canManageApplications"], true);
    }

    #[tokio::test]
    async fn game_time_sync_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-time-1".to_string(),
            user_id: 51,
            character_id: Some(511),
            session_token: Some("sess-51".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 51);
        assert_eq!(socket_id.as_deref(), Some("socket-time-1"));

        let payload = serde_json::to_value(GameTimeSyncPayload {
            era_name: "末法纪元".to_string(),
            base_year: 1000,
            year: 2026,
            month: 4,
            day: 11,
            hour: 7,
            minute: 30,
            second: 0,
            shichen: "辰时".to_string(),
            weather: "晴".to_string(),
            scale: 60,
            server_now_ms: 1712800000000,
            game_elapsed_ms: 1712800000000,
        })
        .expect("payload should serialize");
        assert_eq!(payload["day"], 11);
        assert_eq!(payload["weather"], "晴");
        assert_eq!(payload["server_now_ms"], 1712800000000i64);
        assert!(payload.get("kind").is_none());
    }

    #[tokio::test]
    async fn wander_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-wander-1".to_string(),
            user_id: 95,
            character_id: Some(9501),
            session_token: Some("sess-95".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 95);
        assert_eq!(socket_id.as_deref(), Some("socket-wander-1"));

        let payload = serde_json::to_value(WanderUpdatePayload {
            overview: crate::http::wander::WanderOverviewDto {
                today: "2026-04-13".to_string(),
                ai_available: true,
                has_pending_episode: false,
                is_resolving_episode: false,
                can_generate: true,
                is_cooling_down: false,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                current_generation_job: None,
                active_story: None,
                current_episode: None,
                latest_finished_story: None,
                generated_titles: vec![],
            },
        })
        .expect("payload should serialize");
        assert_eq!(payload["overview"]["today"], "2026-04-13");
        assert_eq!(payload["overview"]["canGenerate"], true);
    }

    #[tokio::test]
    async fn technique_research_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-technique-1".to_string(),
            user_id: 71,
            character_id: Some(711),
            session_token: Some("sess-71".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 71);
        assert_eq!(socket_id.as_deref(), Some("socket-technique-1"));

        let payload = serde_json::to_value(TechniqueResearchStatusPayload {
            character_id: 711,
            status: TechniqueResearchStatusDto {
                unlock_realm: "炼炁化神·结胎期".to_string(),
                unlocked: true,
                fragment_balance: 4000,
                fragment_cost: 3500,
                cooldown_bypass_fragment_cost: 2800,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                cooldown_bypass_token_bypasses_cooldown: true,
                cooldown_bypass_token_cost: 1,
                cooldown_bypass_token_item_name: "冷却绕过令牌".to_string(),
                cooldown_bypass_token_available_qty: 1,
                burning_word_prompt_max_length: 2,
                current_draft: None,
                draft_expire_at: None,
                name_rules: TechniqueResearchNameRulesDto {
                    min_length: 2,
                    max_length: 14,
                    fixed_prefix: "『研』".to_string(),
                    pattern_hint: "仅支持纯中文".to_string(),
                    immutable_after_publish: true,
                },
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 711);
        assert_eq!(payload["status"]["unlockRealm"], "炼炁化神·结胎期");
    }

    #[tokio::test]
    async fn technique_research_result_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-technique-result-1".to_string(),
            user_id: 72,
            character_id: Some(721),
            session_token: Some("sess-72".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 72);
        assert_eq!(socket_id.as_deref(), Some("socket-technique-result-1"));

        let payload = serde_json::to_value(TechniqueResearchResultPayload {
            character_id: 721,
            generation_id: "tech-gen-1".to_string(),
            status: "failed".to_string(),
            has_unread_result: true,
            message: "洞府推演失败，请前往功法查看".to_string(),
            preview: None,
            error_message: Some("已放弃本次研修草稿，并按过期规则结算".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 721);
        assert_eq!(payload["generationId"], "tech-gen-1");
        assert_eq!(payload["status"], "failed");
    }

    #[tokio::test]
    async fn partner_recruit_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-partner-recruit-1".to_string(),
            user_id: 81,
            character_id: Some(811),
            session_token: Some("sess-81".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 81);
        assert_eq!(socket_id.as_deref(), Some("socket-partner-recruit-1"));

        let payload = serde_json::to_value(PartnerRecruitStatusPayload {
            character_id: 811,
            status: PartnerRecruitStatusDto {
                feature_code: "partner_system".to_string(),
                unlock_realm: "炼神返虚·养神期".to_string(),
                unlocked: true,
                spirit_stone_cost: 0,
                cooldown_hours: 72,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                custom_base_model_bypasses_cooldown: true,
                custom_base_model_max_length: 12,
                custom_base_model_token_cost: 1,
                custom_base_model_token_item_name: "自定义底模令".to_string(),
                custom_base_model_token_available_qty: 1,
                current_job: None,
                has_unread_result: false,
                result_status: None,
                remaining_until_guaranteed_heaven: 20,
                quality_rates: vec![],
            },
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 811);
        assert_eq!(payload["status"]["featureCode"], "partner_system");
    }

    #[tokio::test]
    async fn partner_recruit_result_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-partner-recruit-result-1".to_string(),
            user_id: 84,
            character_id: Some(841),
            session_token: Some("sess-84".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 84);
        assert_eq!(
            socket_id.as_deref(),
            Some("socket-partner-recruit-result-1")
        );

        let payload = serde_json::to_value(PartnerRecruitResultPayload {
            character_id: 841,
            generation_id: "partner-recruit-1".to_string(),
            status: "refunded".to_string(),
            has_unread_result: true,
            message: "伙伴招募失败，请前往伙伴界面查看".to_string(),
            error_message: Some("伙伴招募生成链尚未迁移，已自动终结并退款".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 841);
        assert_eq!(payload["generationId"], "partner-recruit-1");
        assert_eq!(payload["status"], "refunded");
    }

    #[tokio::test]
    async fn partner_fusion_result_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-partner-fusion-result-1".to_string(),
            user_id: 85,
            character_id: Some(851),
            session_token: Some("sess-85".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 85);
        assert_eq!(socket_id.as_deref(), Some("socket-partner-fusion-result-1"));

        let payload = serde_json::to_value(PartnerFusionResultPayload {
            character_id: 851,
            fusion_id: "partner-fusion-1".to_string(),
            status: "failed".to_string(),
            has_unread_result: true,
            message: "三魂归契失败，请前往伙伴界面查看".to_string(),
            preview: None,
            error_message: Some("三魂归契生成链尚未迁移，已自动终结".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 851);
        assert_eq!(payload["fusionId"], "partner-fusion-1");
        assert_eq!(payload["status"], "failed");
    }

    #[tokio::test]
    async fn partner_rebone_result_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-partner-rebone-result-1".to_string(),
            user_id: 86,
            character_id: Some(861),
            session_token: Some("sess-86".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 86);
        assert_eq!(socket_id.as_deref(), Some("socket-partner-rebone-result-1"));

        let payload = serde_json::to_value(PartnerReboneResultPayload {
            character_id: 861,
            rebone_id: "partner-rebone-1".to_string(),
            partner_id: 7,
            status: "failed".to_string(),
            has_unread_result: true,
            message: "归元洗髓失败，请前往伙伴界面查看".to_string(),
            error_message: Some("归元洗髓执行链尚未迁移，已自动终结并退款".to_string()),
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 861);
        assert_eq!(payload["reboneId"], "partner-rebone-1");
        assert_eq!(payload["status"], "failed");
    }

    #[tokio::test]
    async fn partner_fusion_routes_to_connected_user_socket() {
        let state = test_state();
        state.realtime_sessions.register(RealtimeSessionRecord {
            socket_id: "socket-partner-fusion-1".to_string(),
            user_id: 82,
            character_id: Some(821),
            session_token: Some("sess-82".to_string()),
            connected_at_ms: 1,
        });

        let socket_id = connected_socket_id_for_user(&state, 82);
        assert_eq!(socket_id.as_deref(), Some("socket-partner-fusion-1"));

        let payload = serde_json::to_value(PartnerFusionStatusPayload {
            character_id: 821,
            status: PartnerFusionStatusDto {
                feature_code: "partner_system".to_string(),
                unlocked: true,
                current_job: None,
                has_unread_result: false,
                result_status: None,
            },
        })
        .expect("payload should serialize");
        assert_eq!(payload["characterId"], 821);
        assert_eq!(payload["status"]["featureCode"], "partner_system");
    }
}

fn calculate_duration_ms(started_at: &str, expire_at: &str) -> i64 {
    let started =
        time::OffsetDateTime::parse(started_at, &time::format_description::well_known::Rfc3339)
            .ok();
    let expire =
        time::OffsetDateTime::parse(expire_at, &time::format_description::well_known::Rfc3339).ok();
    match (started, expire) {
        (Some(started), Some(expire)) => (expire - started)
            .whole_milliseconds()
            .max(0)
            .try_into()
            .unwrap_or(i64::MAX),
        _ => 0,
    }
}

fn format_fuyuan_effect_text(buff_value: f64) -> String {
    let normalized = if (buff_value.fract()).abs() < f64::EPSILON {
        format!("{}", buff_value as i64)
    } else {
        format!("{buff_value:.1}")
    };
    format!("福源 +{normalized}")
}
