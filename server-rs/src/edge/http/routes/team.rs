use std::{future::Future, pin::Pin};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};
use crate::edge::http::routes::game::{GameHomeTeamApplicationView, GameHomeTeamInfoView};

/**
 * team HTTP 路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/team` 的读写协议，覆盖当前队伍、详情、申请、邀请、建队、退队、踢人、转让和设置修改等全部接口。
 * 2. 做什么：把 query/body/path 参数校验、Node 文案兼容和 action response 顶层字段序列化集中在这一层，避免应用服务反复处理 HTTP 细节。
 * 3. 不做什么：不在路由层拼 SQL，不直接操作运行时投影，也不擅自增加鉴权/容错兜底。
 *
 * 输入 / 输出：
 * - 输入：query 中的 `characterId/mapId/search/limit`，path 中的 `teamId`，以及各写接口 body。
 * - 输出：Node 兼容 `{ success, message?, data?, role?, autoJoined?, applicationId?, invitationId? }` 包体。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 参数解析/校验 -> `TeamRouteServices` -> 统一序列化为 Node `sendResult` 形状。
 *
 * 复用设计说明：
 * - 首页聚合和 `/api/team` 共用同一套 DTO 与 service trait，避免队伍详情、申请列表、邀请列表在两处各维护一份 shape。
 * - 写接口响应统一收敛到 `TeamMutationResponse`，把 create/apply/invite 等不同 top-level 字段集中管理，后续继续补 socket 推送时只需复用同一条服务边界。
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

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreateDataView {
    pub team_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMutationResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<TeamCreateDataView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_joined: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub application_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invitation_id: Option<String>,
}

impl TeamMutationResponse {
    pub fn success(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
            data: None,
            auto_joined: None,
            application_id: None,
            invitation_id: None,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            data: None,
            auto_joined: None,
            application_id: None,
            invitation_id: None,
        }
    }

    pub fn with_data(mut self, data: TeamCreateDataView) -> Self {
        self.data = Some(data);
        self
    }

    pub fn with_auto_joined(mut self, auto_joined: bool) -> Self {
        self.auto_joined = Some(auto_joined);
        self
    }

    pub fn with_application_id(mut self, application_id: String) -> Self {
        self.application_id = Some(application_id);
        self
    }

    pub fn with_invitation_id(mut self, invitation_id: String) -> Self {
        self.invitation_id = Some(invitation_id);
        self
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TeamSettingsUpdateInput {
    pub name: Option<String>,
    pub goal: Option<String>,
    pub join_min_realm: Option<String>,
    pub auto_join_enabled: Option<bool>,
    pub auto_join_min_realm: Option<String>,
    pub is_public: Option<bool>,
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

    fn create_team<'a>(
        &'a self,
        character_id: i64,
        name: Option<String>,
        goal: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn disband_team<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn leave_team<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn apply_to_team<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
        message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

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

    fn handle_application<'a>(
        &'a self,
        character_id: i64,
        application_id: String,
        approve: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn kick_member<'a>(
        &'a self,
        leader_id: i64,
        target_character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn transfer_leader<'a>(
        &'a self,
        current_leader_id: i64,
        new_leader_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

    fn update_team_settings<'a>(
        &'a self,
        character_id: i64,
        team_id: String,
        settings: TeamSettingsUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

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

    fn invite_to_team<'a>(
        &'a self,
        inviter_id: i64,
        invitee_id: i64,
        message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;

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

    fn handle_invitation<'a>(
        &'a self,
        character_id: i64,
        invitation_id: String,
        accept: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>;
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

    fn create_team<'a>(
        &'a self,
        _character_id: i64,
        _name: Option<String>,
        _goal: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn disband_team<'a>(
        &'a self,
        _character_id: i64,
        _team_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn leave_team<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn apply_to_team<'a>(
        &'a self,
        _character_id: i64,
        _team_id: String,
        _message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
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

    fn handle_application<'a>(
        &'a self,
        _character_id: i64,
        _application_id: String,
        _approve: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn kick_member<'a>(
        &'a self,
        _leader_id: i64,
        _target_character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn transfer_leader<'a>(
        &'a self,
        _current_leader_id: i64,
        _new_leader_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
    }

    fn update_team_settings<'a>(
        &'a self,
        _character_id: i64,
        _team_id: String,
        _settings: TeamSettingsUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
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

    fn invite_to_team<'a>(
        &'a self,
        _inviter_id: i64,
        _invitee_id: i64,
        _message: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
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

    fn handle_invitation<'a>(
        &'a self,
        _character_id: i64,
        _invitation_id: String,
        _accept: bool,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMutationResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(TeamMutationResponse::failure("功能暂不可用")) })
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamCreateBody {
    character_id: Option<i64>,
    name: Option<String>,
    goal: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamDisbandBody {
    character_id: Option<i64>,
    team_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamLeaveBody {
    character_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamApplyBody {
    character_id: Option<i64>,
    team_id: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamHandleApplicationBody {
    character_id: Option<i64>,
    application_id: Option<String>,
    approve: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamKickBody {
    leader_id: Option<i64>,
    target_character_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamTransferBody {
    current_leader_id: Option<i64>,
    new_leader_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamSettingsBody {
    character_id: Option<i64>,
    team_id: Option<String>,
    settings: Option<TeamSettingsUpdateInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamInviteBody {
    inviter_id: Option<i64>,
    invitee_id: Option<i64>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TeamHandleInvitationBody {
    character_id: Option<i64>,
    invitation_id: Option<String>,
    accept: Option<bool>,
}

pub fn build_team_router() -> Router<AppState> {
    Router::new()
        .route("/my", get(get_my_team_handler))
        .route("/create", post(create_team_handler))
        .route("/disband", post(disband_team_handler))
        .route("/leave", post(leave_team_handler))
        .route("/apply", post(apply_to_team_handler))
        .route("/applications/{teamId}", get(get_team_applications_handler))
        .route("/application/handle", post(handle_application_handler))
        .route("/kick", post(kick_member_handler))
        .route("/transfer", post(transfer_leader_handler))
        .route("/settings", post(update_team_settings_handler))
        .route("/nearby/list", get(get_nearby_teams_handler))
        .route("/lobby/list", get(get_lobby_teams_handler))
        .route("/invite", post(invite_to_team_handler))
        .route(
            "/invitations/received",
            get(get_received_invitations_handler),
        )
        .route("/invitation/handle", post(handle_invitation_handler))
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
    let team_id = require_team_id(Some(params.team_id))?;
    Ok(service_result(
        state.team_services.get_team_by_id(team_id).await?,
    ))
}

async fn create_team_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamCreateBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    Ok(mutation_response(
        state
            .team_services
            .create_team(character_id, body.name, body.goal)
            .await?,
    ))
}

async fn disband_team_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamDisbandBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    let team_id = require_team_id(body.team_id)?;
    Ok(mutation_response(
        state
            .team_services
            .disband_team(character_id, team_id)
            .await?,
    ))
}

async fn leave_team_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamLeaveBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    Ok(mutation_response(
        state.team_services.leave_team(character_id).await?,
    ))
}

async fn apply_to_team_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamApplyBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    let team_id = require_team_id(body.team_id)?;
    Ok(mutation_response(
        state
            .team_services
            .apply_to_team(character_id, team_id, body.message)
            .await?,
    ))
}

async fn get_team_applications_handler(
    State(state): State<AppState>,
    Path(params): Path<TeamPathParams>,
    Query(query): Query<TeamCharacterQuery>,
) -> Result<Response, BusinessError> {
    let team_id = require_team_id(Some(params.team_id))?;
    let character_id = require_character_id(query.character_id)?;
    Ok(service_result(
        state
            .team_services
            .get_team_applications(team_id, character_id)
            .await?,
    ))
}

async fn handle_application_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamHandleApplicationBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    let application_id = require_application_id(body.application_id)?;
    let approve = require_bool(body.approve, "缺少参数")?;
    Ok(mutation_response(
        state
            .team_services
            .handle_application(character_id, application_id, approve)
            .await?,
    ))
}

async fn kick_member_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamKickBody>,
) -> Result<Response, BusinessError> {
    let leader_id = require_character_id_with_message(body.leader_id, "缺少参数")?;
    let target_character_id =
        require_character_id_with_message(body.target_character_id, "缺少参数")?;
    Ok(mutation_response(
        state
            .team_services
            .kick_member(leader_id, target_character_id)
            .await?,
    ))
}

async fn transfer_leader_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamTransferBody>,
) -> Result<Response, BusinessError> {
    let current_leader_id =
        require_character_id_with_message(body.current_leader_id, "缺少参数")?;
    let new_leader_id = require_character_id_with_message(body.new_leader_id, "缺少参数")?;
    Ok(mutation_response(
        state
            .team_services
            .transfer_leader(current_leader_id, new_leader_id)
            .await?,
    ))
}

async fn update_team_settings_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamSettingsBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    let team_id = require_team_id(body.team_id)?;
    let settings = body.settings.unwrap_or_default();
    Ok(mutation_response(
        state
            .team_services
            .update_team_settings(character_id, team_id, settings)
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

async fn invite_to_team_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamInviteBody>,
) -> Result<Response, BusinessError> {
    let inviter_id = require_character_id_with_message(body.inviter_id, "缺少参数")?;
    let invitee_id = require_character_id_with_message(body.invitee_id, "缺少参数")?;
    Ok(mutation_response(
        state
            .team_services
            .invite_to_team(inviter_id, invitee_id, body.message)
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

async fn handle_invitation_handler(
    State(state): State<AppState>,
    Json(body): Json<TeamHandleInvitationBody>,
) -> Result<Response, BusinessError> {
    let character_id = require_character_id(body.character_id)?;
    let invitation_id = require_invitation_id(body.invitation_id)?;
    let accept = require_bool(body.accept, "缺少参数")?;
    Ok(mutation_response(
        state
            .team_services
            .handle_invitation(character_id, invitation_id, accept)
            .await?,
    ))
}

fn mutation_response(result: TeamMutationResponse) -> Response {
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, Json(result)).into_response()
}

fn require_character_id(character_id: Option<i64>) -> Result<i64, BusinessError> {
    require_character_id_with_message(character_id, "缺少角色ID")
}

fn require_character_id_with_message(
    character_id: Option<i64>,
    message: &str,
) -> Result<i64, BusinessError> {
    character_id
        .filter(|value| *value > 0)
        .ok_or_else(|| BusinessError::new(message))
}

fn require_team_id(team_id: Option<String>) -> Result<String, BusinessError> {
    let trimmed = team_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    trimmed.ok_or_else(|| BusinessError::new("缺少队伍ID"))
}

fn require_application_id(application_id: Option<String>) -> Result<String, BusinessError> {
    let trimmed = application_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    trimmed.ok_or_else(|| BusinessError::new("缺少参数"))
}

fn require_invitation_id(invitation_id: Option<String>) -> Result<String, BusinessError> {
    let trimmed = invitation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    trimmed.ok_or_else(|| BusinessError::new("缺少参数"))
}

fn require_bool(value: Option<bool>, message: &str) -> Result<bool, BusinessError> {
    value.ok_or_else(|| BusinessError::new(message))
}
