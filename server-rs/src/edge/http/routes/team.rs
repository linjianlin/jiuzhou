use std::{future::Future, pin::Pin};

use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};
use crate::edge::http::routes::game::{GameHomeTeamApplicationView, GameHomeTeamInfoView};

/**
 * team 只读 HTTP 路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/team/my|:teamId|applications/:teamId|nearby/list|lobby/list|invitations/received` 六条只读链路。
 * 2. 做什么：集中处理 query/path 参数归一化和 Node 文案兼容，把真实查询下沉给 `TeamRouteServices`。
 * 3. 不做什么：不在这里承接建队、申请、审批、邀请等写路径，也不偷偷附带鉴权兜底。
 *
 * 输入 / 输出：
 * - 输入：query 中的 `characterId/mapId/search/limit`，以及 path 中的 `teamId`。
 * - 输出：Node 兼容 `{ success, message?, data?, role? }` 包体。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 参数解析/校验 -> `TeamRouteServices` -> 统一序列化为 Node `sendResult` 形状。
 *
 * 复用设计说明：
 * - 首页聚合已复用同一份 team 应用服务；独立路由继续走同一 trait，可避免首页和面板看到不同的队伍真值。
 * - `my` 与其它只读接口共享参数解析 helper，后续补写路径时也能沿用相同的 teamId/characterId 规则。
 *
 * 关键边界条件与坑点：
 * 1. Node 当前 `team` 读链路不要求 Bearer 鉴权，Rust 端不能擅自加 `requireAuth/requireCharacter` 改协议。
 * 2. `/my` 在未加入队伍时是 `success:true + data:null`，不能改成 404 或 `success:false`。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamBrowseEntryView {
    pub id: String,
    pub name: String,
    pub leader: String,
    pub leader_month_card_active: bool,
    pub members: i32,
    pub cap: i32,
    pub goal: String,
    pub min_realm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvitationView {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub goal: String,
    pub inviter_name: String,
    pub inviter_month_card_active: bool,
    pub message: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMyTeamResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<GameHomeTeamInfoView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

impl TeamMyTeamResponse {
    pub fn not_joined() -> Self {
        Self {
            success: true,
            message: Some("未加入队伍".to_string()),
            data: None,
            role: None,
        }
    }
}

pub trait TeamRouteServices: Send + Sync {
    fn get_my_team<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMyTeamResponse, BusinessError>> + Send + 'a>>;

    fn get_team_by_id<'a>(
        &'a self,
        team_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<GameHomeTeamInfoView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_team_applications<'a>(
        &'a self,
        team_id: String,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<Vec<GameHomeTeamApplicationView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;

    fn get_nearby_teams<'a>(
        &'a self,
        character_id: i64,
        map_id: Option<String>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn get_lobby_teams<'a>(
        &'a self,
        character_id: i64,
        search: Option<String>,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn get_received_invitations<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamInvitationView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopTeamRouteServices;

impl TeamRouteServices for NoopTeamRouteServices {
    fn get_my_team<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMyTeamResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(TeamMyTeamResponse::not_joined()) })
    }

    fn get_team_by_id<'a>(
        &'a self,
        _team_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<GameHomeTeamInfoView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("队伍不存在".to_string()),
                None,
            ))
        })
    }

    fn get_team_applications<'a>(
        &'a self,
        _team_id: String,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<Vec<GameHomeTeamApplicationView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(ServiceResultResponse::new(true, None, Some(Vec::new()))) })
    }

    fn get_nearby_teams<'a>(
        &'a self,
        _character_id: i64,
        _map_id: Option<String>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(ServiceResultResponse::new(true, None, Some(Vec::new()))) })
    }

    fn get_lobby_teams<'a>(
        &'a self,
        _character_id: i64,
        _search: Option<String>,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(ServiceResultResponse::new(true, None, Some(Vec::new()))) })
    }

    fn get_received_invitations<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamInvitationView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(ServiceResultResponse::new(true, None, Some(Vec::new()))) })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamCharacterQuery {
    character_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamNearbyQuery {
    character_id: Option<i64>,
    map_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamLobbyQuery {
    character_id: Option<i64>,
    search: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamPathParams {
    team_id: String,
}

pub fn build_team_router() -> Router<AppState> {
    Router::new()
        .route("/my", get(get_my_team_handler))
        .route("/applications/{teamId}", get(get_team_applications_handler))
        .route("/nearby/list", get(get_nearby_teams_handler))
        .route("/lobby/list", get(get_lobby_teams_handler))
        .route(
            "/invitations/received",
            get(get_received_invitations_handler),
        )
        .route("/{teamId}", get(get_team_by_id_handler))
}

async fn get_my_team_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<Json<TeamMyTeamResponse>, BusinessError> {
    let character_id = require_character_id(query.character_id)?;
    Ok(Json(state.team_services.get_my_team(character_id).await?))
}

async fn get_team_by_id_handler(
    State(state): State<AppState>,
    Path(params): Path<TeamPathParams>,
) -> Result<Response, BusinessError> {
    let team_id = require_team_id(params.team_id)?;
    Ok(service_result(
        state.team_services.get_team_by_id(team_id).await?,
    ))
}

async fn get_team_applications_handler(
    State(state): State<AppState>,
    Path(params): Path<TeamPathParams>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<Response, BusinessError> {
    let team_id = require_team_id(params.team_id)?;
    let character_id = require_character_id(query.character_id)?;
    Ok(service_result(
        state
            .team_services
            .get_team_applications(team_id, character_id)
            .await?,
    ))
}

async fn get_nearby_teams_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamNearbyQuery>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(query.character_id)?;
    Ok(service_result(
        state
            .team_services
            .get_nearby_teams(character_id, query.map_id)
            .await?,
    ))
}

async fn get_lobby_teams_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamLobbyQuery>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(query.character_id)?;
    Ok(service_result(
        state
            .team_services
            .get_lobby_teams(character_id, query.search, query.limit)
            .await?,
    ))
}

async fn get_received_invitations_handler(
    State(state): State<AppState>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(query.character_id)?;
    Ok(service_result(
        state
            .team_services
            .get_received_invitations(character_id)
            .await?,
    ))
}

fn require_character_id(character_id: Option<i64>) -> Result<i64, BusinessError> {
    character_id
        .filter(|value| *value > 0)
        .ok_or_else(|| BusinessError::new("缺少角色ID"))
}

fn require_team_id(team_id: String) -> Result<String, BusinessError> {
    let trimmed = team_id.trim().to_string();
    if trimmed.is_empty() {
        Err(BusinessError::new("缺少队伍ID"))
    } else {
        Ok(trimmed)
    }
}
