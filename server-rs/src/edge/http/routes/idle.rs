use std::{future::Future, pin::Pin};

use axum::extract::{Json, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json as AxumJson, Router};
use serde::{Deserialize, Serialize};

use crate::application::character::service::CharacterBasicInfo;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, unauthorized_response};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{ok, success};

/**
 * idle 最小 HTTP 路由集群。
 *
 * 作用：
 * 1. 做什么：暴露 `/start`、`/status`、`/stop`、`/history`、`/history/:id/viewed`、`/progress`、`/config`，覆盖当前前端挂机面板真实依赖的最小 HTTP 合同。
 * 2. 做什么：复用现有 Bearer/session 校验与角色存在性检查，并把 409 conflict、history viewed 标记与配置默认值语义固定在这一层，避免应用服务掺杂 HTTP 细节。
 * 3. 不做什么：不在这里实现挂机执行、收益结算或 socket 推送。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token，以及 start/config 请求体。
 * - 输出：Node 兼容的 `{ success, data? }` 与 `409 { success:false, message, existingSessionId }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 统一鉴权 / 角色检查 -> `IdleRouteServices` -> envelope 序列化。
 *
 * 复用设计说明：
 * - 角色鉴权 helper 沿用 character 路由的模式，只把 requireCharacter 风格的 404 语义补进来，避免 auth/character/idle 三处再长出不同的 bearer 校验分支。
 * - `IdleSessionView` 与 `IdleConfigView` 作为路由与应用服务共享 DTO，集中锁定当前客户端真正依赖的字段，后续引擎增强时也不必改 route contract。
 *
 * 关键边界条件与坑点：
 * 1. 角色不存在时这里必须保持 `404 { success:false, message:'角色不存在' }`，因为 idle 在 Node 端走的是 requireCharacter 语义。
 * 2. `existingSessionId` 只在 409 conflict 时出现，普通 400 失败不能误带该字段。
 * 3. 未配置挂机参数时必须返回固定默认值，而不是把空结果抹成 `{}`，否则前端草稿态会丢默认开关。
 */
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct IdleStartInput {
    #[serde(rename = "mapId")]
    pub map_id: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "maxDurationMs")]
    pub max_duration_ms: i64,
    #[serde(rename = "autoSkillPolicy")]
    pub auto_skill_policy: serde_json::Value,
    #[serde(rename = "targetMonsterDefId")]
    pub target_monster_def_id: String,
    #[serde(rename = "includePartnerInBattle")]
    pub include_partner_in_battle: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleAutoSkillSlot {
    pub skill_id: String,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdleAutoSkillPolicy {
    pub slots: Vec<IdleAutoSkillSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigView {
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub max_duration_ms: i64,
    pub auto_skill_policy: IdleAutoSkillPolicy,
    pub target_monster_def_id: Option<String>,
    pub include_partner_in_battle: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigUpdateInput {
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub max_duration_ms: Option<i64>,
    pub auto_skill_policy: Option<IdleAutoSkillPolicy>,
    pub target_monster_def_id: Option<String>,
    pub include_partner_in_battle: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleConfigResponseData {
    pub config: IdleConfigView,
    pub max_duration_limit_ms: i64,
    pub month_card_active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleDurationLimit {
    pub max_duration_ms: i64,
    pub month_card_active: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleSessionView {
    pub id: String,
    pub character_id: i64,
    pub status: String,
    pub map_id: String,
    pub room_id: String,
    pub max_duration_ms: i64,
    pub total_battles: i32,
    pub win_count: i32,
    pub lose_count: i32,
    pub total_exp: i32,
    pub total_silver: i32,
    pub bag_full_flag: bool,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub viewed_at: Option<String>,
    pub target_monster_def_id: Option<String>,
    pub target_monster_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleStartServiceResult {
    Started {
        session_id: String,
    },
    Conflict {
        message: String,
        existing_session_id: String,
    },
    Failure {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleStopServiceResult {
    Stopped,
    Failure { message: String },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct IdleStartResponseData {
    #[serde(rename = "sessionId")]
    session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct IdleStatusResponseData {
    session: Option<IdleSessionView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct IdleHistoryResponseData {
    history: Vec<IdleSessionView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct IdleConflictResponse {
    success: bool,
    message: String,
    #[serde(rename = "existingSessionId")]
    existing_session_id: String,
}

pub trait IdleRouteServices: Send + Sync {
    fn start_idle_session<'a>(
        &'a self,
        character_id: i64,
        user_id: i64,
        input: IdleStartInput,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStartServiceResult, BusinessError>> + Send + 'a>>;

    fn get_active_idle_session<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>;

    fn stop_idle_session<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStopServiceResult, BusinessError>> + Send + 'a>>;

    fn get_idle_history<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IdleSessionView>, BusinessError>> + Send + 'a>>;

    fn mark_idle_history_viewed<'a>(
        &'a self,
        character_id: i64,
        session_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>>;

    fn get_idle_progress<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>;

    fn get_idle_config<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleConfigResponseData, BusinessError>> + Send + 'a>>;

    fn update_idle_config<'a>(
        &'a self,
        character_id: i64,
        input: IdleConfigUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopIdleRouteServices;

impl IdleRouteServices for NoopIdleRouteServices {
    fn start_idle_session<'a>(
        &'a self,
        _character_id: i64,
        _user_id: i64,
        _input: IdleStartInput,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStartServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(IdleStartServiceResult::Failure {
                message: "挂机功能暂不可用".to_string(),
            })
        })
    }

    fn get_active_idle_session<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(None) })
    }

    fn stop_idle_session<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStopServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(IdleStopServiceResult::Failure {
                message: "没有活跃的挂机会话".to_string(),
            })
        })
    }

    fn get_idle_history<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn mark_idle_history_viewed<'a>(
        &'a self,
        _character_id: i64,
        _session_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
    }

    fn get_idle_progress<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(None) })
    }

    fn get_idle_config<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleConfigResponseData, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(default_idle_config_response()) })
    }

    fn update_idle_config<'a>(
        &'a self,
        _character_id: i64,
        _input: IdleConfigUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
    }
}

pub fn build_idle_router() -> Router<AppState> {
    Router::new()
        .route("/start", post(start_idle_handler))
        .route("/status", get(idle_status_handler))
        .route("/stop", post(stop_idle_handler))
        .route("/history", get(idle_history_handler))
        .route(
            "/history/{id}/viewed",
            post(mark_idle_history_viewed_handler),
        )
        .route("/progress", get(idle_progress_handler))
        .route(
            "/config",
            get(idle_config_handler).put(update_idle_config_handler),
        )
}

async fn start_idle_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<IdleStartInput>,
) -> Result<Response, BusinessError> {
    let (user_id, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    validate_start_payload(&payload)?;
    let result = state
        .idle_services
        .start_idle_session(character.id, user_id, payload)
        .await?;

    match result {
        IdleStartServiceResult::Started { session_id } => {
            Ok(success(IdleStartResponseData { session_id }))
        }
        IdleStartServiceResult::Conflict {
            message,
            existing_session_id,
        } => Ok((
            StatusCode::CONFLICT,
            AxumJson(IdleConflictResponse {
                success: false,
                message,
                existing_session_id,
            }),
        )
            .into_response()),
        IdleStartServiceResult::Failure { message } => Err(BusinessError::new(message)),
    }
}

async fn idle_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let session = state
        .idle_services
        .get_active_idle_session(character.id)
        .await?;
    Ok(success(IdleStatusResponseData { session }))
}

async fn stop_idle_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let result = state.idle_services.stop_idle_session(character.id).await?;
    match result {
        IdleStopServiceResult::Stopped => Ok(ok()),
        IdleStopServiceResult::Failure { message } => Err(BusinessError::new(message)),
    }
}

async fn idle_history_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let history = state.idle_services.get_idle_history(character.id).await?;
    Ok(success(IdleHistoryResponseData { history }))
}

async fn idle_progress_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let session = state.idle_services.get_idle_progress(character.id).await?;
    Ok(success(IdleStatusResponseData { session }))
}

async fn mark_idle_history_viewed_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let normalized_session_id = session_id.trim().to_string();
    if normalized_session_id.is_empty() {
        return Err(BusinessError::new("缺少 sessionId"));
    }

    state
        .idle_services
        .mark_idle_history_viewed(character.id, normalized_session_id)
        .await?;
    Ok(ok())
}

async fn idle_config_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let config = state.idle_services.get_idle_config(character.id).await?;
    Ok(success(config))
}

async fn update_idle_config_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<IdleConfigUpdateInput>,
) -> Result<Response, BusinessError> {
    let (_, character) = match require_authenticated_character(&state, &headers).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    state
        .idle_services
        .update_idle_config(character.id, payload)
        .await?;
    Ok(ok())
}

async fn require_authenticated_character(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(i64, CharacterBasicInfo), Response> {
    let Some(token) = crate::edge::http::auth::read_bearer_token(headers) else {
        return Err(unauthorized_response());
    };

    let verify_result = state.auth_services.verify_token_and_session(&token).await;
    if !verify_result.valid {
        return match invalid_session_response(verify_result.kicked) {
            Ok(response) => Err(response),
            Err(error) => Err(error.into_response()),
        };
    }

    let user_id = verify_result.user_id.ok_or_else(unauthorized_response)?;
    let character_result = state
        .auth_services
        .check_character(user_id)
        .await
        .map_err(|error| error.into_response())?;
    if !character_result.has_character {
        return Err(
            BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response(),
        );
    }

    let Some(character) = character_result.character else {
        return Err(
            BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response(),
        );
    };

    Ok((user_id, character))
}

fn validate_start_payload(payload: &IdleStartInput) -> Result<(), BusinessError> {
    if payload.map_id.trim().is_empty() {
        return Err(BusinessError::new("缺少 mapId"));
    }
    if payload.room_id.trim().is_empty() {
        return Err(BusinessError::new("缺少 roomId"));
    }
    if payload.target_monster_def_id.trim().is_empty() {
        return Err(BusinessError::new("缺少 targetMonsterDefId"));
    }
    if payload.max_duration_ms <= 0 {
        return Err(BusinessError::new("maxDurationMs 必须大于 0"));
    }
    Ok(())
}

fn default_idle_config_response() -> IdleConfigResponseData {
    IdleConfigResponseData {
        config: IdleConfigView {
            map_id: None,
            room_id: None,
            max_duration_ms: 3_600_000,
            auto_skill_policy: IdleAutoSkillPolicy { slots: Vec::new() },
            target_monster_def_id: None,
            include_partner_in_battle: true,
        },
        max_duration_limit_ms: 28_800_000,
        month_card_active: false,
    }
}
