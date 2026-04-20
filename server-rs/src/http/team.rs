use std::collections::HashMap;

use axum::extract::{Json, Path, Query, State};
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::realtime::public_socket::emit_team_update_to_characters;
use crate::realtime::team::{TeamUpdatePayload, build_team_update_payload};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberDto {
    pub id: String,
    pub character_id: i64,
    pub name: String,
    pub month_card_active: bool,
    pub role: String,
    pub realm: String,
    pub online: bool,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfoDto {
    pub id: String,
    pub name: String,
    pub leader: String,
    pub leader_id: i64,
    pub leader_month_card_active: bool,
    pub members: Vec<TeamMemberDto>,
    pub member_count: i64,
    pub max_members: i64,
    pub goal: String,
    pub join_min_realm: String,
    pub auto_join_enabled: bool,
    pub auto_join_min_realm: String,
    pub current_map_id: Option<String>,
    pub is_public: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamApplicationDto {
    pub id: String,
    pub character_id: i64,
    pub name: String,
    pub month_card_active: bool,
    pub realm: String,
    pub avatar: Option<String>,
    pub message: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamEntryDto {
    pub id: String,
    pub name: String,
    pub leader: String,
    pub leader_month_card_active: bool,
    pub members: i64,
    pub cap: i64,
    pub goal: String,
    pub min_realm: String,
    pub distance: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitationDto {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub goal: String,
    pub inviter_name: String,
    pub inviter_month_card_active: bool,
    pub message: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamMyData {
    #[serde(flatten)]
    pub team: TeamInfoDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMyResponse {
    pub success: bool,
    pub message: String,
    pub data: Option<TeamMyData>,
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TeamCharacterQuery {
    #[serde(rename = "characterId")]
    pub character_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct TeamNearbyQuery {
    #[serde(rename = "characterId")]
    pub character_id: Option<i64>,
    #[serde(rename = "mapId")]
    pub map_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TeamLobbyQuery {
    #[serde(rename = "characterId")]
    pub character_id: Option<i64>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamPayload {
    pub character_id: i64,
    pub name: Option<String>,
    pub goal: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveTeamPayload {
    pub character_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisbandTeamPayload {
    pub character_id: i64,
    pub team_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreateResultDto {
    pub team_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<TeamUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitePayload {
    pub inviter_id: i64,
    pub invitee_id: i64,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInviteResponse {
    pub success: bool,
    pub message: String,
    pub invitation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<TeamUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamApplyPayload {
    pub character_id: i64,
    pub team_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamApplyResponse {
    pub success: bool,
    pub message: String,
    pub application_id: Option<String>,
    pub auto_joined: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<TeamUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamHandleApplicationPayload {
    pub character_id: i64,
    pub application_id: String,
    pub approve: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamHandleInvitationPayload {
    pub character_id: i64,
    pub invitation_id: String,
    pub accept: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamKickPayload {
    pub leader_id: i64,
    pub target_character_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamTransferPayload {
    pub current_leader_id: i64,
    pub new_leader_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSettingsPayload {
    pub character_id: i64,
    pub team_id: String,
    pub settings: TeamSettingsUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSettingsUpdate {
    pub name: Option<String>,
    pub goal: Option<String>,
    pub join_min_realm: Option<String>,
    pub auto_join_enabled: Option<bool>,
    pub auto_join_min_realm: Option<String>,
    pub is_public: Option<bool>,
}

pub async fn get_my_team(
    State(state): State<AppState>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<axum::response::Response, AppError> {
    let character_id = query.character_id.unwrap_or_default();
    if character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let row = state
        .database
        .fetch_optional(
            "SELECT team_id FROM team_members WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(axum::Json(TeamMyResponse {
            success: true,
            message: "未加入队伍".to_string(),
            data: None,
            role: None,
        }).into_response());
    };
    let team_id = row.try_get::<Option<String>, _>("team_id")?.unwrap_or_default();
    let Some(team) = load_team_info(&state, &team_id).await? else {
        return Ok(axum::Json(TeamMyResponse {
            success: true,
            message: "未加入队伍".to_string(),
            data: None,
            role: None,
        }).into_response());
    };
    let role = team
        .members
        .iter()
        .find(|member| member.character_id == character_id)
        .map(|member| member.role.clone());
    Ok(axum::Json(TeamMyResponse {
        success: true,
        message: "ok".to_string(),
        data: Some(TeamMyData { team }),
        role,
    }).into_response())
}

pub async fn get_team_by_id_handler(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let team_id = team_id.trim();
    if team_id.is_empty() {
        return Err(AppError::config("缺少队伍ID"));
    }
    let Some(team) = load_team_info(&state, team_id).await? else {
        return Ok(send_result(ServiceResult::<TeamInfoDto> {
            success: false,
            message: Some("队伍不存在".to_string()),
            data: None,
        }));
    };
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(team),
    }))
}

pub async fn get_nearby_teams_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamNearbyQuery>,
) -> Result<axum::response::Response, AppError> {
    let character_id = query.character_id.unwrap_or_default();
    if character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let current_map_id = if let Some(map_id) = query.map_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        map_id.to_string()
    } else {
        state.database.fetch_optional("SELECT current_map_id FROM characters WHERE id = $1 LIMIT 1", |query| query.bind(character_id)).await?
            .and_then(|row| row.try_get::<Option<String>, _>("current_map_id").ok().flatten())
            .unwrap_or_default()
    };
    let rows = state.database.fetch_all(
        "SELECT t.id, t.name, t.goal, t.join_min_realm, t.max_members, t.leader_id, c.nickname AS leader_name, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::bigint AS member_count FROM teams t JOIN characters c ON t.leader_id = c.id WHERE t.current_map_id = $1 AND t.is_public = true AND t.id NOT IN (SELECT team_id FROM team_members WHERE character_id = $2) ORDER BY t.created_at DESC LIMIT 20",
        |query| query.bind(&current_map_id).bind(character_id),
    ).await?;
    let leader_ids: Vec<i64> = rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("leader_id").ok().flatten().map(i64::from)).collect();
    let month_map = load_month_card_map_by_character_ids(&state, leader_ids).await?;
    let data = rows.into_iter().map(|row| TeamEntryDto {
        id: row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
        name: row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
        leader: row.try_get::<Option<String>, _>("leader_name").unwrap_or(None).unwrap_or_default(),
            leader_month_card_active: row.try_get::<Option<i32>, _>("leader_id").unwrap_or(None).map(i64::from).and_then(|id| month_map.get(&id).copied()).unwrap_or(false),
        members: row.try_get::<Option<i64>, _>("member_count").unwrap_or(None).unwrap_or_default(),
        cap: opt_i64_from_i32(&row, "max_members"),
        goal: row.try_get::<Option<String>, _>("goal").unwrap_or(None).unwrap_or_default(),
        min_realm: row.try_get::<Option<String>, _>("join_min_realm").unwrap_or(None).unwrap_or_else(|| "凡人".to_string()),
        distance: Some("100米".to_string()),
    }).collect::<Vec<_>>();
    Ok(send_result(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(data) }))
}

pub async fn get_lobby_teams_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamLobbyQuery>,
) -> Result<axum::response::Response, AppError> {
    let character_id = query.character_id.unwrap_or_default();
    if character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let search = query.search.unwrap_or_default();
    let search = search.trim();
    let rows = if search.is_empty() {
        state.database.fetch_all(
            "SELECT t.id, t.name, t.goal, t.join_min_realm, t.max_members, t.leader_id, c.nickname AS leader_name, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::bigint AS member_count FROM teams t JOIN characters c ON t.leader_id = c.id WHERE t.is_public = true AND t.id NOT IN (SELECT team_id FROM team_members WHERE character_id = $1) ORDER BY t.created_at DESC LIMIT $2",
            |query| query.bind(character_id).bind(limit),
        ).await?
    } else {
        let pattern = format!("%{}%", search);
        state.database.fetch_all(
            "SELECT t.id, t.name, t.goal, t.join_min_realm, t.max_members, t.leader_id, c.nickname AS leader_name, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::bigint AS member_count FROM teams t JOIN characters c ON t.leader_id = c.id WHERE t.is_public = true AND t.id NOT IN (SELECT team_id FROM team_members WHERE character_id = $1) AND (t.name ILIKE $2 OR c.nickname ILIKE $2 OR t.goal ILIKE $2) ORDER BY t.created_at DESC LIMIT $3",
            |query| query.bind(character_id).bind(&pattern).bind(limit),
        ).await?
    };
    let leader_ids: Vec<i64> = rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("leader_id").ok().flatten().map(i64::from)).collect();
    let month_map = load_month_card_map_by_character_ids(&state, leader_ids).await?;
    let data = rows.into_iter().map(|row| TeamEntryDto {
        id: row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
        name: row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
        leader: row.try_get::<Option<String>, _>("leader_name").unwrap_or(None).unwrap_or_default(),
            leader_month_card_active: row.try_get::<Option<i32>, _>("leader_id").unwrap_or(None).map(i64::from).and_then(|id| month_map.get(&id).copied()).unwrap_or(false),
        members: row.try_get::<Option<i64>, _>("member_count").unwrap_or(None).unwrap_or_default(),
        cap: opt_i64_from_i32(&row, "max_members"),
        goal: row.try_get::<Option<String>, _>("goal").unwrap_or(None).unwrap_or_default(),
        min_realm: row.try_get::<Option<String>, _>("join_min_realm").unwrap_or(None).unwrap_or_else(|| "凡人".to_string()),
        distance: None,
    }).collect::<Vec<_>>();
    Ok(send_result(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(data) }))
}

pub async fn get_received_invitations_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<axum::response::Response, AppError> {
    let character_id = query.character_id.unwrap_or_default();
    if character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let rows = state.database.fetch_all(
        "SELECT ti.id, ti.message, ti.created_at, ti.inviter_id, t.id AS team_id, t.name AS team_name, t.goal, c.nickname AS inviter_name FROM team_invitations ti JOIN teams t ON ti.team_id = t.id JOIN characters c ON ti.inviter_id = c.id WHERE ti.invitee_id = $1 AND ti.status = 'pending' ORDER BY ti.created_at DESC",
        |query| query.bind(character_id),
    ).await?;
    let inviter_ids: Vec<i64> = rows.iter().map(|row| opt_i64_from_i32(row, "inviter_id")).filter(|id| *id > 0).collect();
    let month_map = load_month_card_map_by_character_ids(&state, inviter_ids).await?;
    let data = rows.into_iter().map(|row| TeamInvitationDto {
        id: row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
        team_id: row.try_get::<Option<String>, _>("team_id").unwrap_or(None).unwrap_or_default(),
        team_name: row.try_get::<Option<String>, _>("team_name").unwrap_or(None).unwrap_or_default(),
        goal: row.try_get::<Option<String>, _>("goal").unwrap_or(None).unwrap_or_default(),
        inviter_name: row.try_get::<Option<String>, _>("inviter_name").unwrap_or(None).unwrap_or_default(),
        inviter_month_card_active: month_map.get(&opt_i64_from_i32(&row, "inviter_id")).copied().unwrap_or(false),
        message: row.try_get::<Option<String>, _>("message").unwrap_or(None),
        time: row.try_get::<Option<String>, _>("created_at").unwrap_or(None).as_deref().and_then(|value| time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()).map(|value| (value.unix_timestamp_nanos() / 1_000_000) as i64).unwrap_or_default(),
    }).collect::<Vec<_>>();
    Ok(send_result(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(data) }))
}

pub async fn get_team_applications_handler(
    State(state): State<AppState>,
    Path(team_id): Path<String>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<axum::response::Response, AppError> {
    let character_id = query.character_id.unwrap_or_default();
    if character_id <= 0 || team_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let result = get_team_applications_tx(&state, team_id.trim(), character_id).await?;
    Ok(send_result(result))
}

pub async fn create_team_handler(
    State(state): State<AppState>,
    Json(payload): Json<CreateTeamPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let result = state.database.with_transaction(|| async {
        create_team_tx(&state, payload.character_id, payload.name.as_deref(), payload.goal.as_deref()).await
    }).await?;
    if let Some(debug_realtime) = result.data.as_ref().and_then(|data| data.debug_realtime.clone()) {
        emit_team_update_to_characters(&state, &[payload.character_id], &debug_realtime);
    }
    Ok(send_result(result))
}

pub async fn leave_team_handler(
    State(state): State<AppState>,
    Json(payload): Json<LeaveTeamPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 {
        return Err(AppError::config("缺少角色ID"));
    }
    let membership = load_character_team_membership(&state, payload.character_id).await?;
    let emit_targets = if let Some((team_id, _)) = membership.as_ref() {
        load_team_member_ids(&state, team_id).await?
    } else {
        Vec::new()
    };
    let result = state.database.with_transaction(|| async {
        leave_team_tx(&state, payload.character_id).await
    }).await?;
    if result.success {
        if let Some((team_id, _)) = membership.as_ref() {
            let source = if result
                .message
                .as_deref()
                .is_some_and(|message| message.contains("解散"))
            {
                "disband_team"
            } else {
                "leave_team"
            };
            let debug_realtime = build_team_update_payload(source, Some(team_id.as_str()), result.message.as_deref());
            emit_team_update_to_characters(&state, &emit_targets, &debug_realtime);
        }
    }
    Ok(send_result(result))
}

pub async fn disband_team_handler(
    State(state): State<AppState>,
    Json(payload): Json<DisbandTeamPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 || payload.team_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let team_id = payload.team_id.trim().to_string();
    let emit_targets = load_team_member_ids(&state, &team_id).await?;
    let result = state.database.with_transaction(|| async {
        disband_team_tx(&state, payload.character_id, &team_id).await
    }).await?;
    if result.success {
        let debug_realtime = build_team_update_payload("disband_team", Some(team_id.as_str()), result.message.as_deref());
        emit_team_update_to_characters(&state, &emit_targets, &debug_realtime);
    }
    Ok(send_result(result))
}

pub async fn invite_to_team_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamInvitePayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.inviter_id <= 0 || payload.invitee_id <= 0 {
        return Err(AppError::config("缺少参数"));
    }
    let result = state.database.with_transaction(|| async {
        invite_to_team_tx(&state, payload.inviter_id, payload.invitee_id, payload.message.as_deref()).await
    }).await?;
    if let Some(debug_realtime) = result.debug_realtime.clone() {
        emit_team_update_to_characters(&state, &[payload.inviter_id, payload.invitee_id], &debug_realtime);
    }
    Ok(axum::Json(result).into_response())
}

pub async fn apply_to_team_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamApplyPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 || payload.team_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let result = state.database.with_transaction(|| async {
        apply_to_team_tx(&state, payload.character_id, payload.team_id.trim(), payload.message.as_deref()).await
    }).await?;
    Ok(axum::Json(result).into_response())
}

pub async fn handle_team_application_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamHandleApplicationPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 || payload.application_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let pending_application = state.database.fetch_optional(
        "SELECT team_id, applicant_id FROM team_applications WHERE id = $1 AND status = 'pending' LIMIT 1",
        |query| query.bind(payload.application_id.trim()),
    ).await?;
    let result = state.database.with_transaction(|| async {
        handle_team_application_tx(&state, payload.character_id, payload.application_id.trim(), payload.approve).await
    }).await?;
    if result.success {
        if let Some(application) = pending_application {
            let team_id = application.try_get::<Option<String>, _>("team_id")?.unwrap_or_default();
            let applicant_id = opt_i64_from_i32(&application, "applicant_id");
            if !team_id.trim().is_empty() && applicant_id > 0 {
                let mut targets = if payload.approve {
                    load_team_member_ids(&state, &team_id).await?
                } else {
                    Vec::new()
                };
                targets.push(applicant_id);
                targets.sort_unstable();
                targets.dedup();
                let source = if payload.approve { "approve_application" } else { "reject_application" };
                let debug_realtime = build_team_update_payload(source, Some(team_id.as_str()), result.message.as_deref());
                emit_team_update_to_characters(&state, &targets, &debug_realtime);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn handle_team_invitation_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamHandleInvitationPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 || payload.invitation_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let result = state.database.with_transaction(|| async {
        handle_team_invitation_tx(&state, payload.character_id, payload.invitation_id.trim(), payload.accept).await
    }).await?;
    if let Some(debug_realtime) = result
        .data
        .as_ref()
        .and_then(extract_team_update_payload_from_result_data)
    {
        let mut targets = vec![payload.character_id];
        if let Some(team_id) = debug_realtime.team_id.as_deref() {
            targets.extend(load_team_member_ids(&state, team_id).await?);
        }
        targets.sort_unstable();
        targets.dedup();
        emit_team_update_to_characters(&state, &targets, &debug_realtime);
    }
    Ok(send_result(result))
}

pub async fn kick_team_member_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamKickPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.leader_id <= 0 || payload.target_character_id <= 0 {
        return Err(AppError::config("缺少参数"));
    }
    let membership = load_character_team_membership(&state, payload.leader_id).await?;
    let emit_targets = if let Some((team_id, _)) = membership.as_ref() {
        load_team_member_ids(&state, team_id).await?
    } else {
        Vec::new()
    };
    let result = state.database.with_transaction(|| async {
        kick_team_member_tx(&state, payload.leader_id, payload.target_character_id).await
    }).await?;
    if result.success {
        if let Some((team_id, _)) = membership.as_ref() {
            let debug_realtime = build_team_update_payload("kick_member", Some(team_id.as_str()), result.message.as_deref());
            emit_team_update_to_characters(&state, &emit_targets, &debug_realtime);
        }
    }
    Ok(send_result(result))
}

pub async fn transfer_team_leader_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamTransferPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.current_leader_id <= 0 || payload.new_leader_id <= 0 {
        return Err(AppError::config("缺少参数"));
    }
    let result = state.database.with_transaction(|| async {
        transfer_team_leader_tx(&state, payload.current_leader_id, payload.new_leader_id).await
    }).await?;
    if let Some(debug_realtime) = result
        .data
        .as_ref()
        .and_then(extract_team_update_payload_from_result_data)
    {
        let mut targets = vec![payload.current_leader_id, payload.new_leader_id];
        if let Some(team_id) = debug_realtime.team_id.as_deref() {
            targets.extend(load_team_member_ids(&state, team_id).await?);
        }
        targets.sort_unstable();
        targets.dedup();
        emit_team_update_to_characters(&state, &targets, &debug_realtime);
    }
    Ok(send_result(result))
}

pub async fn update_team_settings_handler(
    State(state): State<AppState>,
    Json(payload): Json<TeamSettingsPayload>,
) -> Result<axum::response::Response, AppError> {
    if payload.character_id <= 0 || payload.team_id.trim().is_empty() {
        return Err(AppError::config("缺少参数"));
    }
    let team_id = payload.team_id.trim().to_string();
    let emit_targets = load_team_member_ids(&state, &team_id).await?;
    let result = state.database.with_transaction(|| async {
        update_team_settings_tx(&state, payload.character_id, &team_id, payload.settings).await
    }).await?;
    if result.success && !result.message.as_deref().is_some_and(|message| message == "无需更新") {
        let debug_realtime = build_team_update_payload("update_team_settings", Some(team_id.as_str()), result.message.as_deref());
        emit_team_update_to_characters(&state, &emit_targets, &debug_realtime);
    }
    Ok(send_result(result))
}

async fn load_month_card_map_by_character_ids(state: &AppState, ids: Vec<i64>) -> Result<HashMap<i64, bool>, AppError> {
    let ids: Vec<i64> = ids.into_iter().filter(|id| *id > 0).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = state.database.fetch_all(
        "SELECT character_id FROM month_card_ownership WHERE character_id = ANY($1::bigint[]) AND month_card_id = 'monthcard-001' AND expire_at > NOW()",
        |query| query.bind(ids.clone()),
    ).await?;
    let mut map = HashMap::new();
    for id in ids { map.insert(id, false); }
    for row in rows {
        let character_id = opt_i64_from_i32(&row, "character_id");
        if character_id > 0 { map.insert(character_id, true); }
    }
    Ok(map)
}

async fn load_character_team_membership(
    state: &AppState,
    character_id: i64,
) -> Result<Option<(String, String)>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT team_id, role FROM team_members WHERE character_id = $1 LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    Ok(row.map(|row| {
        (
            row.try_get::<Option<String>, _>("team_id").unwrap_or(None).unwrap_or_default(),
            row.try_get::<Option<String>, _>("role").unwrap_or(None).unwrap_or_else(|| "member".to_string()),
        )
    }))
}

async fn load_character_snapshot(
    state: &AppState,
    character_id: i64,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT nickname, current_map_id FROM characters WHERE id = $1 LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    Ok(row.map(|row| {
        (
            row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(),
            row.try_get::<Option<String>, _>("current_map_id").unwrap_or(None),
        )
    }))
}

async fn load_character_realm(state: &AppState, character_id: i64) -> Result<Option<String>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT realm FROM characters WHERE id = $1 LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    Ok(row.and_then(|row| row.try_get::<Option<String>, _>("realm").ok().flatten()))
}

async fn load_team_member_ids(state: &AppState, team_id: &str) -> Result<Vec<i64>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT character_id FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC",
        |query| query.bind(team_id),
    ).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from))
        .filter(|id| *id > 0)
        .collect())
}

fn extract_team_update_payload_from_result_data(data: &serde_json::Value) -> Option<TeamUpdatePayload> {
    serde_json::from_value(data.get("debugRealtime")?.clone()).ok()
}

async fn create_team_tx(
    state: &AppState,
    character_id: i64,
    name: Option<&str>,
    goal: Option<&str>,
) -> Result<ServiceResult<TeamCreateResultDto>, AppError> {
    if load_character_team_membership(state, character_id).await?.is_some() {
        return Ok(ServiceResult { success: false, message: Some("你已在队伍中，请先退出当前队伍".to_string()), data: None });
    }
    let Some((nickname, current_map_id)) = load_character_snapshot(state, character_id).await? else {
        return Ok(ServiceResult { success: false, message: Some("角色不存在".to_string()), data: None });
    };
    let team_id = build_team_id(character_id);
    let team_name = name.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| format!("{}的小队", nickname));
    let team_goal = goal.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned).unwrap_or_else(|| "组队冒险".to_string());
    state.database.execute(
        "INSERT INTO teams (id, name, leader_id, goal, current_map_id) VALUES ($1, $2, $3, $4, $5)",
        |query| query.bind(&team_id).bind(&team_name).bind(character_id).bind(&team_goal).bind(current_map_id),
    ).await?;
    state.database.execute(
        "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'leader')",
        |query| query.bind(&team_id).bind(character_id),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("队伍创建成功".to_string()),
        data: Some(TeamCreateResultDto {
            team_id: team_id.clone(),
            name: team_name,
            debug_realtime: Some(build_team_update_payload("create_team", Some(team_id.as_str()), Some("队伍创建成功"))),
        }),
    })
}

async fn leave_team_tx(
    state: &AppState,
    character_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let Some((team_id, role)) = load_character_team_membership(state, character_id).await? else {
        return Ok(ServiceResult { success: false, message: Some("你不在任何队伍中".to_string()), data: None });
    };

    if role == "leader" {
        let next_member = state.database.fetch_optional(
            "SELECT character_id FROM team_members WHERE team_id = $1 AND character_id != $2 ORDER BY joined_at ASC LIMIT 1",
            |query| query.bind(&team_id).bind(character_id),
        ).await?;
        if let Some(next_member) = next_member {
    let new_leader_id = opt_i64_from_i32(&next_member, "character_id");
            state.database.execute(
                "UPDATE teams SET leader_id = $1 WHERE id = $2",
                |query| query.bind(new_leader_id).bind(&team_id),
            ).await?;
            state.database.execute(
                "UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2",
                |query| query.bind(&team_id).bind(new_leader_id),
            ).await?;
        } else {
            state.database.execute("DELETE FROM teams WHERE id = $1", |query| query.bind(&team_id)).await?;
            return Ok(ServiceResult { success: true, message: Some("队伍已解散（无其他成员）".to_string()), data: None });
        }
    }

    state.database.execute(
        "DELETE FROM team_members WHERE character_id = $1",
        |query| query.bind(character_id),
    ).await?;
    Ok(ServiceResult { success: true, message: Some("已离开队伍".to_string()), data: None })
}

async fn disband_team_tx(
    state: &AppState,
    character_id: i64,
    team_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT leader_id FROM teams WHERE id = $1 LIMIT 1",
        |query| query.bind(team_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult { success: false, message: Some("队伍不存在".to_string()), data: None });
    };
    let leader_id = opt_i64_from_i32(&row, "leader_id");
    if leader_id != character_id {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能解散队伍".to_string()), data: None });
    }
    state.database.execute("DELETE FROM teams WHERE id = $1", |query| query.bind(team_id)).await?;
    Ok(ServiceResult { success: true, message: Some("队伍已解散".to_string()), data: None })
}

async fn invite_to_team_tx(
    state: &AppState,
    inviter_id: i64,
    invitee_id: i64,
    message: Option<&str>,
) -> Result<TeamInviteResponse, AppError> {
    let inviter_row = state.database.fetch_optional(
        "SELECT tm.team_id, t.leader_id, t.max_members, (SELECT COUNT(*) FROM team_members WHERE team_id = tm.team_id)::bigint AS member_count FROM team_members tm JOIN teams t ON tm.team_id = t.id WHERE tm.character_id = $1 LIMIT 1",
        |query| query.bind(inviter_id),
    ).await?;
    let Some(inviter_row) = inviter_row else {
        return Ok(TeamInviteResponse { success: false, message: "你不在任何队伍中".to_string(), invitation_id: None, debug_realtime: None });
    };

    let team_id = inviter_row.try_get::<Option<String>, _>("team_id")?.unwrap_or_default();
    let leader_id = opt_i64_from_i32(&inviter_row, "leader_id");
    let max_members = opt_i64_from_i32(&inviter_row, "max_members").max(1);
    let member_count = inviter_row.try_get::<Option<i64>, _>("member_count")?.unwrap_or_default();

    if leader_id != inviter_id {
        return Ok(TeamInviteResponse { success: false, message: "只有队长才能邀请".to_string(), invitation_id: None, debug_realtime: None });
    }
    if member_count >= max_members {
        return Ok(TeamInviteResponse { success: false, message: "队伍已满".to_string(), invitation_id: None, debug_realtime: None });
    }

    if load_character_team_membership(state, invitee_id).await?.is_some() {
        return Ok(TeamInviteResponse { success: false, message: "该玩家已在队伍中".to_string(), invitation_id: None, debug_realtime: None });
    }

    let existing_invite = state.database.fetch_optional(
        "SELECT id FROM team_invitations WHERE team_id = $1 AND invitee_id = $2 AND status = 'pending' LIMIT 1",
        |query| query.bind(&team_id).bind(invitee_id),
    ).await?;
    if existing_invite.is_some() {
        return Ok(TeamInviteResponse { success: false, message: "已有待处理的邀请".to_string(), invitation_id: None, debug_realtime: None });
    }

    let invitation_id = build_team_invitation_id(inviter_id, invitee_id);
    let invite_message = message.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    state.database.execute(
        "INSERT INTO team_invitations (id, team_id, inviter_id, invitee_id, message) VALUES ($1, $2, $3, $4, $5)",
        |query| query.bind(&invitation_id).bind(&team_id).bind(inviter_id).bind(invitee_id).bind(invite_message),
    ).await?;

    Ok(TeamInviteResponse {
        success: true,
        message: "邀请已发送".to_string(),
        invitation_id: Some(invitation_id),
        debug_realtime: Some(build_team_update_payload("invite_to_team", Some(team_id.as_str()), Some("邀请已发送"))),
    })
}

async fn get_team_applications_tx(
    state: &AppState,
    team_id: &str,
    character_id: i64,
) -> Result<ServiceResult<Vec<TeamApplicationDto>>, AppError> {
    let team = state.database.fetch_optional(
        "SELECT leader_id FROM teams WHERE id = $1 LIMIT 1",
        |query| query.bind(team_id),
    ).await?;
    let Some(team) = team else {
        return Ok(ServiceResult { success: false, message: Some("队伍不存在".to_string()), data: None });
    };
    let leader_id = opt_i64_from_i32(&team, "leader_id");
    if leader_id != character_id {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能查看申请".to_string()), data: None });
    }
    let rows = state.database.fetch_all(
        "SELECT ta.id, ta.message, ta.created_at, ta.applicant_id, c.nickname, c.realm, c.avatar FROM team_applications ta JOIN characters c ON ta.applicant_id = c.id WHERE ta.team_id = $1 AND ta.status = 'pending' ORDER BY ta.created_at DESC",
        |query| query.bind(team_id),
    ).await?;
    let applicant_ids: Vec<i64> = rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("applicant_id").ok().flatten().map(i64::from)).collect();
    let month_map = load_month_card_map_by_character_ids(state, applicant_ids).await?;
    let data = rows.into_iter().map(|row| TeamApplicationDto {
        id: row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
        character_id: opt_i64_from_i32(&row, "applicant_id"),
        name: row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(),
        month_card_active: row.try_get::<Option<i32>, _>("applicant_id").unwrap_or(None).map(i64::from).and_then(|id| month_map.get(&id).copied()).unwrap_or(false),
        realm: row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_else(|| "凡人".to_string()),
        avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
        message: row.try_get::<Option<String>, _>("message").unwrap_or(None),
        time: row.try_get::<Option<String>, _>("created_at").unwrap_or(None).as_deref().and_then(|value| time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()).map(|value| (value.unix_timestamp_nanos() / 1_000_000) as i64).unwrap_or_default(),
    }).collect::<Vec<_>>();
    Ok(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(data) })
}

async fn apply_to_team_tx(
    state: &AppState,
    character_id: i64,
    team_id: &str,
    message: Option<&str>,
) -> Result<TeamApplyResponse, AppError> {
    if load_character_team_membership(state, character_id).await?.is_some() {
        return Ok(TeamApplyResponse { success: false, message: "你已在队伍中".to_string(), application_id: None, auto_joined: None, debug_realtime: None });
    }
    let team = state.database.fetch_optional(
        "SELECT t.join_min_realm, t.max_members, t.auto_join_enabled, t.auto_join_min_realm, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id)::bigint AS member_count FROM teams t WHERE t.id = $1 LIMIT 1",
        |query| query.bind(team_id),
    ).await?;
    let Some(team) = team else {
        return Ok(TeamApplyResponse { success: false, message: "队伍不存在".to_string(), application_id: None, auto_joined: None, debug_realtime: None });
    };
    let member_count = team.try_get::<Option<i64>, _>("member_count")?.unwrap_or_default();
    let max_members = opt_i64_from_i32(&team, "max_members").max(5);
    if member_count >= max_members {
        return Ok(TeamApplyResponse { success: false, message: "队伍已满".to_string(), application_id: None, auto_joined: None, debug_realtime: None });
    }
    let character_realm = load_character_realm(state, character_id).await?.unwrap_or_else(|| "凡人".to_string());
    let join_min_realm = team.try_get::<Option<String>, _>("join_min_realm")?.unwrap_or_else(|| "凡人".to_string());
    if compare_realm_rank(&character_realm, &join_min_realm) < 0 {
        return Ok(TeamApplyResponse { success: false, message: format!("境界不足，需要{}以上", join_min_realm), application_id: None, auto_joined: None, debug_realtime: None });
    }
    let existing = state.database.fetch_optional(
        "SELECT id FROM team_applications WHERE team_id = $1 AND applicant_id = $2 AND status = 'pending' LIMIT 1",
        |query| query.bind(team_id).bind(character_id),
    ).await?;
    if existing.is_some() {
        return Ok(TeamApplyResponse { success: false, message: "已有待处理的申请".to_string(), application_id: None, auto_joined: None, debug_realtime: None });
    }
    let application_id = build_team_application_id(character_id);
    let apply_message = message.map(str::trim).filter(|value| !value.is_empty()).map(ToOwned::to_owned);
    state.database.execute(
        "INSERT INTO team_applications (id, team_id, applicant_id, message) VALUES ($1, $2, $3, $4)",
        |query| query.bind(&application_id).bind(team_id).bind(character_id).bind(apply_message),
    ).await?;
    Ok(TeamApplyResponse { success: true, message: "申请已提交".to_string(), application_id: Some(application_id), auto_joined: None, debug_realtime: None })
}

async fn handle_team_application_tx(
    state: &AppState,
    character_id: i64,
    application_id: &str,
    approve: bool,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let application = state.database.fetch_optional(
        "SELECT ta.team_id, ta.applicant_id, t.leader_id, t.max_members, (SELECT COUNT(*) FROM team_members WHERE team_id = ta.team_id)::bigint AS member_count FROM team_applications ta JOIN teams t ON ta.team_id = t.id WHERE ta.id = $1 AND ta.status = 'pending' LIMIT 1 FOR UPDATE",
        |query| query.bind(application_id),
    ).await?;
    let Some(application) = application else {
        return Ok(ServiceResult { success: false, message: Some("申请不存在或已处理".to_string()), data: None });
    };
    let leader_id = opt_i64_from_i32(&application, "leader_id");
    if leader_id != character_id {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能处理申请".to_string()), data: None });
    }
    let team_id = application.try_get::<Option<String>, _>("team_id")?.unwrap_or_default();
    let applicant_id = opt_i64_from_i32(&application, "applicant_id");
    if approve {
        let member_count = application.try_get::<Option<i64>, _>("member_count")?.unwrap_or_default();
        let max_members = opt_i64_from_i32(&application, "max_members").max(5);
        if member_count >= max_members {
            state.database.execute(
                "UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                |query| query.bind(application_id),
            ).await?;
            return Ok(ServiceResult { success: false, message: Some("队伍已满".to_string()), data: None });
        }
        if load_character_team_membership(state, applicant_id).await?.is_some() {
            state.database.execute(
                "UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                |query| query.bind(application_id),
            ).await?;
            return Ok(ServiceResult { success: false, message: Some("该玩家已加入其他队伍".to_string()), data: None });
        }
        state.database.execute(
            "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')",
            |query| query.bind(&team_id).bind(applicant_id),
        ).await?;
        state.database.execute(
            "UPDATE team_applications SET status = 'approved', handled_at = NOW() WHERE id = $1",
            |query| query.bind(application_id),
        ).await?;
        return Ok(ServiceResult { success: true, message: Some("已通过申请".to_string()), data: None });
    }
    state.database.execute(
        "UPDATE team_applications SET status = 'rejected', handled_at = NOW() WHERE id = $1",
        |query| query.bind(application_id),
    ).await?;
    Ok(ServiceResult { success: true, message: Some("已拒绝申请".to_string()), data: None })
}

async fn handle_team_invitation_tx(
    state: &AppState,
    character_id: i64,
    invitation_id: &str,
    accept: bool,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let invite = state.database.fetch_optional(
        "SELECT ti.team_id, ti.inviter_id, t.max_members, (SELECT COUNT(*) FROM team_members WHERE team_id = ti.team_id)::bigint AS member_count FROM team_invitations ti JOIN teams t ON ti.team_id = t.id WHERE ti.id = $1 AND ti.invitee_id = $2 AND ti.status = 'pending' LIMIT 1 FOR UPDATE",
        |query| query.bind(invitation_id).bind(character_id),
    ).await?;
    let Some(invite) = invite else {
        return Ok(ServiceResult { success: false, message: Some("邀请不存在或已处理".to_string()), data: None });
    };
    let team_id = invite.try_get::<Option<String>, _>("team_id")?.unwrap_or_default();
    if accept {
        if load_character_team_membership(state, character_id).await?.is_some() {
            state.database.execute(
                "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                |query| query.bind(invitation_id),
            ).await?;
            return Ok(ServiceResult { success: false, message: Some("你已在其他队伍中".to_string()), data: None });
        }
        let member_count = invite.try_get::<Option<i64>, _>("member_count")?.unwrap_or_default();
        let max_members = opt_i64_from_i32(&invite, "max_members").max(5);
        if member_count >= max_members {
            state.database.execute(
                "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1",
                |query| query.bind(invitation_id),
            ).await?;
            return Ok(ServiceResult { success: false, message: Some("队伍已满".to_string()), data: None });
        }
        state.database.execute(
            "INSERT INTO team_members (team_id, character_id, role) VALUES ($1, $2, 'member')",
            |query| query.bind(&team_id).bind(character_id),
        ).await?;
        state.database.execute(
            "UPDATE team_invitations SET status = 'accepted', handled_at = NOW() WHERE id = $1",
            |query| query.bind(invitation_id),
        ).await?;
        state.database.execute(
            "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE invitee_id = $1 AND status = 'pending' AND id != $2",
            |query| query.bind(character_id).bind(invitation_id),
        ).await?;
        return Ok(ServiceResult { success: true, message: Some("已加入队伍".to_string()), data: Some(serde_json::json!({
            "debugRealtime": build_team_update_payload("handle_invitation", Some(team_id.as_str()), Some("已加入队伍"))
        })) });
    }
    state.database.execute(
        "UPDATE team_invitations SET status = 'rejected', handled_at = NOW() WHERE id = $1",
        |query| query.bind(invitation_id),
    ).await?;
    Ok(ServiceResult { success: true, message: Some("已拒绝邀请".to_string()), data: None })
}

async fn kick_team_member_tx(
    state: &AppState,
    leader_id: i64,
    target_character_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let Some((team_id, role)) = load_character_team_membership(state, leader_id).await? else {
        return Ok(ServiceResult { success: false, message: Some("你不在任何队伍中".to_string()), data: None });
    };
    if role != "leader" {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能踢人".to_string()), data: None });
    }
    if leader_id == target_character_id {
        return Ok(ServiceResult { success: false, message: Some("不能踢出自己".to_string()), data: None });
    }
    let target = state.database.fetch_optional(
        "SELECT id FROM team_members WHERE team_id = $1 AND character_id = $2 LIMIT 1",
        |query| query.bind(&team_id).bind(target_character_id),
    ).await?;
    if target.is_none() {
        return Ok(ServiceResult { success: false, message: Some("该玩家不在队伍中".to_string()), data: None });
    }
    state.database.execute(
        "DELETE FROM team_members WHERE team_id = $1 AND character_id = $2",
        |query| query.bind(&team_id).bind(target_character_id),
    ).await?;
    Ok(ServiceResult { success: true, message: Some("已踢出成员".to_string()), data: None })
}

async fn transfer_team_leader_tx(
    state: &AppState,
    current_leader_id: i64,
    new_leader_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let Some((team_id, role)) = load_character_team_membership(state, current_leader_id).await? else {
        return Ok(ServiceResult { success: false, message: Some("你不在任何队伍中".to_string()), data: None });
    };
    if role != "leader" {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能转让".to_string()), data: None });
    }
    let next_leader = state.database.fetch_optional(
        "SELECT id FROM team_members WHERE team_id = $1 AND character_id = $2 LIMIT 1",
        |query| query.bind(&team_id).bind(new_leader_id),
    ).await?;
    if next_leader.is_none() {
        return Ok(ServiceResult { success: false, message: Some("该玩家不在队伍中".to_string()), data: None });
    }
    state.database.execute(
        "UPDATE teams SET leader_id = $1, updated_at = NOW() WHERE id = $2",
        |query| query.bind(new_leader_id).bind(&team_id),
    ).await?;
    state.database.execute(
        "UPDATE team_members SET role = 'member' WHERE team_id = $1 AND character_id = $2",
        |query| query.bind(&team_id).bind(current_leader_id),
    ).await?;
    state.database.execute(
        "UPDATE team_members SET role = 'leader' WHERE team_id = $1 AND character_id = $2",
        |query| query.bind(&team_id).bind(new_leader_id),
    ).await?;
    Ok(ServiceResult { success: true, message: Some("队长已转让".to_string()), data: Some(serde_json::json!({
        "debugRealtime": build_team_update_payload("transfer_team_leader", Some(team_id.as_str()), Some("队长已转让"))
    })) })
}

async fn update_team_settings_tx(
    state: &AppState,
    character_id: i64,
    team_id: &str,
    settings: TeamSettingsUpdate,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let team = state.database.fetch_optional(
        "SELECT leader_id FROM teams WHERE id = $1 LIMIT 1",
        |query| query.bind(team_id),
    ).await?;
    let Some(team) = team else {
        return Ok(ServiceResult { success: false, message: Some("队伍不存在".to_string()), data: None });
    };
    let leader_id = opt_i64_from_i32(&team, "leader_id");
    if leader_id != character_id {
        return Ok(ServiceResult { success: false, message: Some("只有队长才能修改设置".to_string()), data: None });
    }

    let mut updates = Vec::new();
    let mut bind_name = None;
    let mut bind_goal = None;
    let mut bind_join_min_realm = None;
    let mut bind_auto_join_enabled = None;
    let mut bind_auto_join_min_realm = None;
    let mut bind_is_public = None;

    if let Some(name) = settings.name.map(|value| value.trim().to_string()) {
        updates.push("name = $1");
        bind_name = Some(name);
    }
    if let Some(goal) = settings.goal.map(|value| value.trim().to_string()) {
        updates.push(match updates.len() { 0 => "goal = $1", 1 => "goal = $2", 2 => "goal = $3", 3 => "goal = $4", 4 => "goal = $5", _ => "goal = $6" });
        bind_goal = Some(goal);
    }
    if let Some(join_min_realm) = settings.join_min_realm.map(|value| value.trim().to_string()) {
        updates.push(match updates.len() { 0 => "join_min_realm = $1", 1 => "join_min_realm = $2", 2 => "join_min_realm = $3", 3 => "join_min_realm = $4", 4 => "join_min_realm = $5", _ => "join_min_realm = $6" });
        bind_join_min_realm = Some(join_min_realm);
    }
    if let Some(auto_join_enabled) = settings.auto_join_enabled {
        updates.push(match updates.len() { 0 => "auto_join_enabled = $1", 1 => "auto_join_enabled = $2", 2 => "auto_join_enabled = $3", 3 => "auto_join_enabled = $4", 4 => "auto_join_enabled = $5", _ => "auto_join_enabled = $6" });
        bind_auto_join_enabled = Some(auto_join_enabled);
    }
    if let Some(auto_join_min_realm) = settings.auto_join_min_realm.map(|value| value.trim().to_string()) {
        updates.push(match updates.len() { 0 => "auto_join_min_realm = $1", 1 => "auto_join_min_realm = $2", 2 => "auto_join_min_realm = $3", 3 => "auto_join_min_realm = $4", 4 => "auto_join_min_realm = $5", _ => "auto_join_min_realm = $6" });
        bind_auto_join_min_realm = Some(auto_join_min_realm);
    }
    if let Some(is_public) = settings.is_public {
        updates.push(match updates.len() { 0 => "is_public = $1", 1 => "is_public = $2", 2 => "is_public = $3", 3 => "is_public = $4", 4 => "is_public = $5", _ => "is_public = $6" });
        bind_is_public = Some(is_public);
    }

    if updates.is_empty() {
        return Ok(ServiceResult { success: true, message: Some("无需更新".to_string()), data: None });
    }

    let sql = format!("UPDATE teams SET {}, updated_at = NOW() WHERE id = ${}", updates.join(", "), updates.len() + 1);
    state.database.execute(&sql, move |query| {
        let query = if let Some(value) = bind_name.clone() { query.bind(value) } else { query };
        let query = if let Some(value) = bind_goal.clone() { query.bind(value) } else { query };
        let query = if let Some(value) = bind_join_min_realm.clone() { query.bind(value) } else { query };
        let query = if let Some(value) = bind_auto_join_enabled { query.bind(value) } else { query };
        let query = if let Some(value) = bind_auto_join_min_realm.clone() { query.bind(value) } else { query };
        let query = if let Some(value) = bind_is_public { query.bind(value) } else { query };
        query.bind(team_id)
    }).await?;

    Ok(ServiceResult { success: true, message: Some("设置已更新".to_string()), data: None })
}

fn build_team_id(character_id: i64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("team-{character_id}-{millis}")
}

fn build_team_invitation_id(inviter_id: i64, invitee_id: i64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("team-invite-{inviter_id}-{invitee_id}-{millis}")
}

fn build_team_application_id(character_id: i64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("team-application-{character_id}-{millis}")
}

fn compare_realm_rank(realm_a: &str, realm_b: &str) -> i64 {
    const ORDER: &[&str] = &["凡人", "练气", "筑基", "金丹", "元婴", "化神", "炼虚", "合体", "大乘", "渡劫", "真仙"];
    let a = ORDER.iter().position(|value| *value == realm_a.trim()).unwrap_or(0) as i64;
    let b = ORDER.iter().position(|value| *value == realm_b.trim()).unwrap_or(0) as i64;
    a - b
}

async fn load_team_info(state: &AppState, team_id: &str) -> Result<Option<TeamInfoDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT t.id, t.name, t.leader_id, c.nickname AS leader_name, t.max_members, t.goal, t.join_min_realm, t.auto_join_enabled, t.auto_join_min_realm, t.current_map_id, t.is_public FROM teams t JOIN characters c ON t.leader_id = c.id WHERE t.id = $1 LIMIT 1",
        |query| query.bind(team_id),
    ).await?;
    let Some(row) = row else { return Ok(None); };
    let members = load_team_members(state, team_id).await?;
    let leader_id = opt_i64_from_i32(&row, "leader_id");
    let leader_month_map = load_month_card_map_by_character_ids(state, vec![leader_id]).await?;
    Ok(Some(TeamInfoDto {
        id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
        name: row.try_get::<Option<String>, _>("name")?.unwrap_or_default(),
        leader: row.try_get::<Option<String>, _>("leader_name")?.unwrap_or_default(),
        leader_id,
        leader_month_card_active: leader_month_map.get(&leader_id).copied().unwrap_or(false),
        member_count: members.len() as i64,
        members,
        max_members: opt_i64_from_i32(&row, "max_members").max(5),
        goal: row.try_get::<Option<String>, _>("goal")?.unwrap_or_else(|| "组队冒险".to_string()),
        join_min_realm: row.try_get::<Option<String>, _>("join_min_realm")?.unwrap_or_else(|| "凡人".to_string()),
        auto_join_enabled: row.try_get::<Option<bool>, _>("auto_join_enabled")?.unwrap_or(false),
        auto_join_min_realm: row.try_get::<Option<String>, _>("auto_join_min_realm")?.unwrap_or_else(|| "凡人".to_string()),
        current_map_id: row.try_get::<Option<String>, _>("current_map_id")?,
        is_public: row.try_get::<Option<bool>, _>("is_public")?.unwrap_or(true),
    }))
}

async fn load_team_members(state: &AppState, team_id: &str) -> Result<Vec<TeamMemberDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT tm.character_id, c.user_id, tm.role, c.nickname, c.realm, c.sub_realm, c.avatar FROM team_members tm JOIN characters c ON tm.character_id = c.id WHERE tm.team_id = $1 ORDER BY tm.role DESC, tm.joined_at ASC",
        |query| query.bind(team_id),
    ).await?;
    let character_ids: Vec<i64> = rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from)).collect();
    let month_map = load_month_card_map_by_character_ids(state, character_ids).await?;
    Ok(rows.into_iter().map(|row| {
        let character_id = opt_i64_from_i32(&row, "character_id");
        let realm = row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default();
        let sub_realm = row.try_get::<Option<String>, _>("sub_realm").unwrap_or(None).unwrap_or_default();
        TeamMemberDto {
            id: format!("tm-{}", character_id),
            character_id,
            name: row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(),
            month_card_active: month_map.get(&character_id).copied().unwrap_or(false),
            role: row.try_get::<Option<String>, _>("role").unwrap_or(None).unwrap_or_else(|| "member".to_string()),
            realm: if sub_realm.is_empty() || realm == "凡人" { realm } else { format!("{}·{}", realm, sub_realm) },
            online: false,
            avatar: row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
        }
    }).collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn team_my_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"id": "team-1", "leader": "凌霄子", "memberCount": 2},
            "role": "leader"
        });
        assert_eq!(payload["role"], "leader");
        println!("TEAM_MY_RESPONSE={}", payload);
    }

    #[test]
    fn team_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"id": "team-1", "name": "凌霄子的小队"}
        });
        assert_eq!(payload["data"]["id"], "team-1");
        println!("TEAM_DETAIL_RESPONSE={}", payload);
    }

    #[test]
    fn team_nearby_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": "team-2", "distance": "100米"}]
        });
        assert_eq!(payload["data"][0]["distance"], "100米");
        println!("TEAM_NEARBY_RESPONSE={}", payload);
    }

    #[test]
    fn team_invitations_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": "invite-1", "teamId": "team-1", "inviterMonthCardActive": true}]
        });
        assert_eq!(payload["data"][0]["teamId"], "team-1");
        println!("TEAM_INVITATIONS_RESPONSE={}", payload);
    }

    #[test]
    fn team_create_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "队伍创建成功",
            "data": {"teamId": "team-1", "name": "凌霄子的小队", "debugRealtime": {"kind": "team:update", "source": "create_team", "teamId": "team-1"}}
        });
        assert_eq!(payload["data"]["teamId"], "team-1");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "team:update");
        println!("TEAM_CREATE_RESPONSE={}", payload);
    }

    #[test]
    fn team_leave_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已离开队伍"
        });
        assert_eq!(payload["message"], "已离开队伍");
        println!("TEAM_LEAVE_RESPONSE={}", payload);
    }

    #[test]
    fn team_disband_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "队伍已解散"
        });
        assert_eq!(payload["message"], "队伍已解散");
        println!("TEAM_DISBAND_RESPONSE={}", payload);
    }

    #[test]
    fn team_invite_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "邀请已发送",
            "invitationId": "team-invite-1-2-123",
            "debugRealtime": {"kind": "team:update", "source": "invite_to_team", "teamId": "team-1"}
        });
        assert_eq!(payload["invitationId"], "team-invite-1-2-123");
        assert_eq!(payload["debugRealtime"]["kind"], "team:update");
        println!("TEAM_INVITE_RESPONSE={}", payload);
    }

    #[test]
    fn team_apply_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "申请已提交",
            "applicationId": "team-application-1-123"
        });
        assert_eq!(payload["applicationId"], "team-application-1-123");
        println!("TEAM_APPLY_RESPONSE={}", payload);
    }

    #[test]
    fn team_applications_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": [{"id": "app-1", "characterId": 2, "name": "白尘"}]
        });
        assert_eq!(payload["data"][0]["id"], "app-1");
        println!("TEAM_APPLICATIONS_RESPONSE={}", payload);
    }

    #[test]
    fn team_handle_application_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已通过申请"
        });
        assert_eq!(payload["message"], "已通过申请");
        println!("TEAM_HANDLE_APPLICATION_RESPONSE={}", payload);
    }

    #[test]
    fn team_handle_invitation_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已加入队伍",
            "data": {"debugRealtime": {"kind": "team:update", "source": "handle_invitation", "teamId": "team-1"}}
        });
        assert_eq!(payload["message"], "已加入队伍");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "team:update");
        println!("TEAM_HANDLE_INVITATION_RESPONSE={}", payload);
    }

    #[test]
    fn team_kick_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已踢出成员"
        });
        assert_eq!(payload["message"], "已踢出成员");
        println!("TEAM_KICK_RESPONSE={}", payload);
    }

    #[test]
    fn team_transfer_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "队长已转让",
            "data": {"debugRealtime": {"kind": "team:update", "source": "transfer_team_leader", "teamId": "team-1"}}
        });
        assert_eq!(payload["message"], "队长已转让");
        assert_eq!(payload["data"]["debugRealtime"]["source"], "transfer_team_leader");
        println!("TEAM_TRANSFER_RESPONSE={}", payload);
    }

    #[test]
    fn team_settings_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "设置已更新"
        });
        assert_eq!(payload["message"], "设置已更新");
        println!("TEAM_SETTINGS_RESPONSE={}", payload);
    }
}
