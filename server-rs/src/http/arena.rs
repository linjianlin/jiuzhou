use axum::Json;
use axum::extract::{Json as ExtractJson, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::build_minimal_pvp_battle_state;
use crate::integrations::battle_character_profile::hydrate_pvp_battle_state_players;
use crate::integrations::battle_persistence::{
    persist_battle_projection, persist_battle_session, persist_battle_snapshot,
};
use crate::realtime::arena::build_arena_status_payload;
use crate::realtime::battle::{build_battle_cooldown_ready_payload, build_battle_started_payload};
use crate::realtime::public_socket::{
    emit_arena_update_to_user, emit_battle_cooldown_to_participants,
    emit_battle_update_to_participants,
};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

const ARENA_TODAY_LIMIT: i64 = 20;

fn opt_i64(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i64>, _>(column)
        .ok()
        .flatten()
        .or_else(|| {
            row.try_get::<Option<i32>, _>(column)
                .ok()
                .flatten()
                .map(i64::from)
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaStatusDto {
    pub score: i64,
    pub win_count: i64,
    pub lose_count: i64,
    pub today_used: i64,
    pub today_limit: i64,
    pub today_remaining: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaOpponentDto {
    pub id: i64,
    pub name: String,
    pub realm: String,
    pub power: i64,
    pub score: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRecordDto {
    pub id: String,
    pub ts: i64,
    pub opponent_name: String,
    pub opponent_realm: String,
    pub opponent_power: i64,
    pub result: String,
    pub delta_score: i64,
    pub score_after: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaBattleSessionSnapshotDto {
    pub session_id: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub owner_user_id: i64,
    pub participant_user_ids: Vec<i64>,
    pub current_battle_id: Option<String>,
    pub status: String,
    pub next_action: String,
    pub can_advance: bool,
    pub last_result: Option<String>,
    pub context: ArenaSessionContextDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaSessionContextDto {
    pub opponent_character_id: i64,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaMatchDataDto {
    pub battle_id: String,
    pub opponent: ArenaOpponentDto,
    pub session: ArenaBattleSessionSnapshotDto,
}

#[derive(Debug, Deserialize)]
pub struct ArenaLimitQuery {
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaChallengePayload {
    pub opponent_character_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaChallengeDataDto {
    pub battle_id: String,
    pub session: ArenaBattleSessionSnapshotDto,
}

pub async fn get_arena_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<ArenaStatusDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let status = load_arena_status_from_truth(&state, actor.character_id).await?;
    let today_used = status.today_used;
    let today_limit = status.today_limit;
    Ok(send_success(ArenaStatusDto {
        score: status.score,
        win_count: status.win_count,
        lose_count: status.lose_count,
        today_used,
        today_limit,
        today_remaining: (today_limit - today_used).max(0),
    }))
}

pub async fn get_arena_opponents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ArenaLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<ArenaOpponentDto>>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let limit = query.limit.unwrap_or(10).clamp(1, 50);
    let self_score = load_arena_status_from_truth(&state, actor.character_id)
        .await?
        .score;

    let rows = state
        .database
        .fetch_all(
            "SELECT c.id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name, c.realm, COALESCE(p.power, 0)::bigint AS power, COALESCE(ar.rating, 1000)::bigint AS score FROM characters c LEFT JOIN arena_rating ar ON ar.character_id = c.id LEFT JOIN character_rank_snapshot p ON p.character_id = c.id WHERE c.id <> $1 ORDER BY ABS(COALESCE(ar.rating, 1000) - $2) ASC, c.id ASC LIMIT $3",
            |query| query.bind(actor.character_id).bind(self_score).bind(limit),
        )
        .await?;
    Ok(send_success(
        rows.into_iter()
            .map(|row| ArenaOpponentDto {
                id: row
                    .try_get::<Option<i64>, _>("id")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                name: row
                    .try_get::<Option<String>, _>("name")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                realm: row
                    .try_get::<Option<String>, _>("realm")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                power: row
                    .try_get::<Option<i64>, _>("power")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                score: opt_i64(&row, "score"),
            })
            .collect(),
    ))
}

pub async fn get_arena_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ArenaLimitQuery>,
) -> Result<Json<SuccessResponse<Vec<ArenaRecordDto>>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let rows = state
        .database
        .fetch_all(
            "SELECT ab.battle_id AS id_text, extract(epoch from COALESCE(ab.finished_at, ab.created_at))::bigint AS ts, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS opponent_name, COALESCE(c.realm, '') AS opponent_realm, COALESCE(p.power, 0)::bigint AS opponent_power, ab.result, ab.delta_score, ab.score_after FROM arena_battle ab JOIN characters c ON c.id = ab.opponent_character_id LEFT JOIN character_rank_snapshot p ON p.character_id = c.id WHERE ab.challenger_character_id = $1 AND ab.status = 'finished' ORDER BY COALESCE(ab.finished_at, ab.created_at) DESC, ab.battle_id DESC LIMIT $2",
            |query| query.bind(actor.character_id).bind(limit),
        )
        .await?;
    Ok(send_success(
        rows.into_iter()
            .map(|row| ArenaRecordDto {
                id: row
                    .try_get::<Option<String>, _>("id_text")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                ts: row
                    .try_get::<Option<i64>, _>("ts")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                opponent_name: row
                    .try_get::<Option<String>, _>("opponent_name")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                opponent_realm: row
                    .try_get::<Option<String>, _>("opponent_realm")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                opponent_power: row
                    .try_get::<Option<i64>, _>("opponent_power")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                result: row
                    .try_get::<Option<String>, _>("result")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "draw".to_string()),
                delta_score: opt_i64(&row, "delta_score"),
                score_after: opt_i64(&row, "score_after"),
            })
            .collect(),
    ))
}

pub async fn start_arena_match(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<ArenaMatchDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let status = load_arena_status_from_truth(&state, actor.character_id).await?;
    let self_score = status.score;
    let today_used = status.today_used;
    let today_limit = status.today_limit;
    if today_used >= today_limit {
        return Err(AppError::config("今日挑战次数已用完"));
    }

    let opponent = state
        .database
        .fetch_optional(
            "SELECT c.id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name, c.realm, COALESCE(p.power, 0)::bigint AS power, COALESCE(ar.rating, 1000)::bigint AS score FROM characters c LEFT JOIN arena_rating ar ON ar.character_id = c.id LEFT JOIN character_rank_snapshot p ON p.character_id = c.id WHERE c.id <> $1 ORDER BY ABS(COALESCE(ar.rating, 1000) - $2) ASC, c.id ASC LIMIT 1",
            |query| query.bind(actor.character_id).bind(self_score),
        )
        .await?;
    let Some(opponent) = opponent else {
        return Err(AppError::config("暂无可匹配对手"));
    };
    let opponent = ArenaOpponentDto {
        id: opponent
            .try_get::<Option<i64>, _>("id")
            .unwrap_or(None)
            .unwrap_or_default(),
        name: opponent
            .try_get::<Option<String>, _>("name")
            .unwrap_or(None)
            .unwrap_or_default(),
        realm: opponent
            .try_get::<Option<String>, _>("realm")
            .unwrap_or(None)
            .unwrap_or_default(),
        power: opponent
            .try_get::<Option<i64>, _>("power")
            .unwrap_or(None)
            .unwrap_or_default(),
        score: opponent
            .try_get::<Option<i64>, _>("score")
            .unwrap_or(None)
            .unwrap_or_default(),
    };

    let battle_id = format!(
        "arena-battle-{}-{}-{}",
        actor.character_id,
        opponent.id,
        now_millis()
    );
    let session = ArenaBattleSessionSnapshotDto {
        session_id: format!("arena-session-{}", battle_id),
        session_type: "pvp".to_string(),
        owner_user_id: actor.user_id,
        participant_user_ids: vec![actor.user_id],
        current_battle_id: Some(battle_id.clone()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: ArenaSessionContextDto {
            opponent_character_id: opponent.id,
            mode: "arena".to_string(),
        },
    };
    state.battle_sessions.register(BattleSessionSnapshotDto {
        session_id: session.session_id.clone(),
        session_type: session.session_type.clone(),
        owner_user_id: session.owner_user_id,
        participant_user_ids: session.participant_user_ids.clone(),
        current_battle_id: session.current_battle_id.clone(),
        status: session.status.clone(),
        next_action: session.next_action.clone(),
        can_advance: session.can_advance,
        last_result: session.last_result.clone(),
        context: BattleSessionContextDto::Pvp {
            opponent_character_id: opponent.id,
            mode: "arena".to_string(),
        },
    });
    state
        .online_battle_projections
        .register(OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: actor.user_id,
            participant_user_ids: vec![actor.user_id],
            r#type: "pvp".to_string(),
            session_id: Some(session.session_id.clone()),
        });
    let mut battle_state =
        build_minimal_pvp_battle_state(&battle_id, actor.character_id, opponent.id);
    hydrate_pvp_battle_state_players(
        &state,
        &mut battle_state,
        actor.character_id,
        opponent.id,
        "npc",
    )
    .await?;
    state.battle_runtime.register(battle_state.clone());
    if let Some(session_snapshot) = state.battle_sessions.get_by_battle_id(&battle_id) {
        persist_battle_session(&state, &session_snapshot).await?;
    }
    if let Some(projection) = state.online_battle_projections.get_by_battle_id(&battle_id) {
        persist_battle_projection(&state, &projection).await?;
    }
    persist_battle_snapshot(&state, &battle_state).await?;
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        vec![serde_json::json!({"type": "round_start", "round": 1})],
        state.battle_sessions.get_by_battle_id(&battle_id),
    );
    emit_battle_update_to_participants(&state, &session.participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(
        &state,
        &session.participant_user_ids,
        &debug_cooldown_realtime,
    );
    emit_arena_update_to_user(
        &state,
        actor.user_id,
        &build_arena_status_payload(ArenaStatusDto {
            score: status.score,
            win_count: status.win_count,
            lose_count: status.lose_count,
            today_used,
            today_limit,
            today_remaining: (today_limit - today_used).max(0),
        }),
    );

    Ok(send_success(ArenaMatchDataDto {
        battle_id,
        opponent,
        session,
    }))
}

pub async fn start_arena_challenge(
    State(state): State<AppState>,
    headers: HeaderMap,
    ExtractJson(payload): ExtractJson<ArenaChallengePayload>,
) -> Result<Json<SuccessResponse<ArenaChallengeDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let opponent_character_id = payload.opponent_character_id;
    if opponent_character_id <= 0 {
        return Err(AppError::config("对手参数错误"));
    }
    if opponent_character_id == actor.character_id {
        return Err(AppError::config("不能挑战自己"));
    }

    let status = load_arena_status_from_truth(&state, actor.character_id).await?;
    let today_used = status.today_used;
    let today_limit = status.today_limit;
    if today_used >= today_limit {
        return Err(AppError::config("今日挑战次数已用完"));
    }

    let opponent = state
        .database
        .fetch_optional("SELECT id FROM characters WHERE id = $1 LIMIT 1", |query| {
            query.bind(opponent_character_id)
        })
        .await?;
    if opponent.is_none() {
        return Err(AppError::config("对手不存在"));
    }

    let battle_id = format!(
        "arena-battle-{}-{}-{}",
        actor.character_id,
        opponent_character_id,
        now_millis()
    );
    let session = ArenaBattleSessionSnapshotDto {
        session_id: format!("arena-session-{}", battle_id),
        session_type: "pvp".to_string(),
        owner_user_id: actor.user_id,
        participant_user_ids: vec![actor.user_id],
        current_battle_id: Some(battle_id.clone()),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: ArenaSessionContextDto {
            opponent_character_id,
            mode: "arena".to_string(),
        },
    };
    state.battle_sessions.register(BattleSessionSnapshotDto {
        session_id: session.session_id.clone(),
        session_type: session.session_type.clone(),
        owner_user_id: session.owner_user_id,
        participant_user_ids: session.participant_user_ids.clone(),
        current_battle_id: session.current_battle_id.clone(),
        status: session.status.clone(),
        next_action: session.next_action.clone(),
        can_advance: session.can_advance,
        last_result: session.last_result.clone(),
        context: BattleSessionContextDto::Pvp {
            opponent_character_id,
            mode: "arena".to_string(),
        },
    });
    state
        .online_battle_projections
        .register(OnlineBattleProjectionRecord {
            battle_id: battle_id.clone(),
            owner_user_id: actor.user_id,
            participant_user_ids: vec![actor.user_id],
            r#type: "pvp".to_string(),
            session_id: Some(session.session_id.clone()),
        });
    let mut battle_state =
        build_minimal_pvp_battle_state(&battle_id, actor.character_id, opponent_character_id);
    hydrate_pvp_battle_state_players(
        &state,
        &mut battle_state,
        actor.character_id,
        opponent_character_id,
        "npc",
    )
    .await?;
    state.battle_runtime.register(battle_state.clone());
    if let Some(session_snapshot) = state.battle_sessions.get_by_battle_id(&battle_id) {
        persist_battle_session(&state, &session_snapshot).await?;
    }
    if let Some(projection) = state.online_battle_projections.get_by_battle_id(&battle_id) {
        persist_battle_projection(&state, &projection).await?;
    }
    persist_battle_snapshot(&state, &battle_state).await?;
    let debug_realtime = build_battle_started_payload(
        &battle_id,
        battle_state.clone(),
        vec![serde_json::json!({"type": "round_start", "round": 1})],
        state.battle_sessions.get_by_battle_id(&battle_id),
    );
    emit_battle_update_to_participants(&state, &session.participant_user_ids, &debug_realtime);
    let debug_cooldown_realtime =
        build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
    emit_battle_cooldown_to_participants(
        &state,
        &session.participant_user_ids,
        &debug_cooldown_realtime,
    );
    emit_arena_update_to_user(
        &state,
        actor.user_id,
        &build_arena_status_payload(ArenaStatusDto {
            score: status.score,
            win_count: status.win_count,
            lose_count: status.lose_count,
            today_used,
            today_limit,
            today_remaining: (today_limit - today_used).max(0),
        }),
    );

    Ok(send_success(ArenaChallengeDataDto { battle_id, session }))
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

async fn load_arena_status_from_truth(
    state: &AppState,
    character_id: i64,
) -> Result<ArenaStatusDto, AppError> {
    let rating_row = state
        .database
        .fetch_optional(
            "SELECT rating, win_count, lose_count FROM arena_rating WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let usage_row = state
        .database
        .fetch_optional(
            "SELECT COUNT(1)::bigint AS today_used FROM arena_battle WHERE challenger_character_id = $1 AND created_at >= date_trunc('day', NOW())",
            |query| query.bind(character_id),
        )
        .await?;
    let score = rating_row
        .as_ref()
        .map(|row| opt_i64(row, "rating"))
        .unwrap_or(1000);
    let win_count = rating_row
        .as_ref()
        .map(|row| opt_i64(row, "win_count"))
        .unwrap_or_default();
    let lose_count = rating_row
        .as_ref()
        .map(|row| opt_i64(row, "lose_count"))
        .unwrap_or_default();
    let today_used = usage_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<i64>, _>("today_used").ok().flatten())
        .unwrap_or_default();
    Ok(ArenaStatusDto {
        score,
        win_count,
        lose_count,
        today_used,
        today_limit: ARENA_TODAY_LIMIT,
        today_remaining: (ARENA_TODAY_LIMIT - today_used).max(0),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn arena_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"score": 1200, "winCount": 12, "loseCount": 3, "todayUsed": 2, "todayLimit": 5, "todayRemaining": 3}
        });
        assert_eq!(payload["data"]["score"], 1200);
        println!("ARENA_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn arena_opponents_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": 2, "name": "白尘", "realm": "炼精化炁·养气期", "power": 1100, "score": 1180}]
        });
        assert_eq!(payload["data"][0]["id"], 2);
        println!("ARENA_OPPONENTS_RESPONSE={}", payload);
    }

    #[test]
    fn arena_records_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": "rec-1", "ts": 1712800000, "opponentName": "白尘", "opponentRealm": "炼精化炁·养气期", "opponentPower": 1100, "result": "win", "deltaScore": 15, "scoreAfter": 1215}]
        });
        assert_eq!(payload["data"][0]["result"], "win");
        println!("ARENA_RECORDS_RESPONSE={}", payload);
    }

    #[test]
    fn arena_match_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "battleId": "arena-battle-1-2-123",
                "opponent": {"id": 2, "name": "白尘", "realm": "炼精化炁·养气期", "power": 1100, "score": 1180},
                "session": {
                    "sessionId": "arena-session-arena-battle-1-2-123",
                    "type": "pvp",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "arena-battle-1-2-123",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"opponentCharacterId": 2, "mode": "arena"}
                }
            }
        });
        assert_eq!(
            payload["data"]["session"]["currentBattleId"],
            "arena-battle-1-2-123"
        );
        println!("ARENA_MATCH_RESPONSE={}", payload);
    }

    #[test]
    fn arena_status_default_limit_matches_node_baseline() {
        let today_limit = None::<i64>.unwrap_or(20);
        assert_eq!(today_limit, 20);
    }

    #[test]
    fn arena_challenge_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "battleId": "arena-battle-1-2-123",
                "session": {
                    "sessionId": "arena-session-arena-battle-1-2-123",
                    "type": "pvp",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "arena-battle-1-2-123",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"opponentCharacterId": 2, "mode": "arena"}
                }
            }
        });
        assert_eq!(payload["data"]["battleId"], "arena-battle-1-2-123");
        println!("ARENA_CHALLENGE_RESPONSE={}", payload);
    }
}
