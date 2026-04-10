use std::collections::HashMap;
use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::application::character::service::CharacterBasicInfo;
use crate::application::title::service::TitleEquipResult;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, unauthorized_response};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * title 称号路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node 当前公开的 `/api/title/list` 与 `/api/title/equip` 两个称号接口。
 * 2. 做什么：统一复用 Bearer + 角色上下文校验，把 `404 角色不存在`、`success envelope` 与 `sendResult` 形状收敛在这一层。
 * 3. 不做什么：不处理称号发放、成就推送或在线角色广播，这些仍留在各自业务模块。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；装备接口额外接收 `{ titleId } | { title_id }`。
 * - 输出：列表返回 `{ success:true, data:{ titles, equipped } }`；装备返回 `{ success, message }`。
 *
 * 数据流 / 状态流：
 * - 请求 -> session 校验 -> `check_character` 获取角色上下文 -> `TitleRouteServices`
 * - 列表直接返回读取结果，装备则输出 Node 兼容 `sendResult` 包体。
 *
 * 复用设计说明：
 * - 角色上下文解析只做一次，列表与装备共享同一入口，避免每个 handler 各自拼 `verify + check_character`。
 * - `TitleInfoView` 与 `TitleListView` 由路由、应用服务、合同测试共用，字段协议集中维护，后续前端不会因为 shape 漂移反复改适配。
 *
 * 关键边界条件与坑点：
 * 1. `requireCharacter` 在 Node 侧是 `404 角色不存在`，这里不能退化成 `400` 或 `200 + 空列表`。
 * 2. `equip` 路由层不主动补默认 titleId，空字符串要继续交给服务层输出固定业务文案。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TitleInfoView {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub effects: HashMap<String, i64>,
    pub is_equipped: bool,
    pub obtained_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TitleListView {
    pub titles: Vec<TitleInfoView>,
    pub equipped: String,
}

#[derive(Debug, Deserialize)]
struct EquipTitlePayload {
    #[serde(rename = "titleId")]
    title_id: Option<String>,
    #[serde(rename = "title_id")]
    legacy_title_id: Option<String>,
}

pub trait TitleRouteServices: Send + Sync {
    fn list_titles<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TitleListView, BusinessError>> + Send + 'a>>;

    fn equip_title<'a>(
        &'a self,
        character_id: i64,
        title_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TitleEquipResult, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopTitleRouteServices;

impl TitleRouteServices for NoopTitleRouteServices {
    fn list_titles<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TitleListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(TitleListView {
                titles: Vec::new(),
                equipped: String::new(),
            })
        })
    }

    fn equip_title<'a>(
        &'a self,
        _character_id: i64,
        _title_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TitleEquipResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(TitleEquipResult {
                success: false,
                message: "未拥有该称号".to_string(),
            })
        })
    }
}

pub fn build_title_router() -> Router<AppState> {
    Router::new()
        .route("/list", get(list_titles_handler))
        .route("/equip", post(equip_title_handler))
}

async fn list_titles_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let character = match require_character_context(&state, &headers).await {
        Ok(character) => character,
        Err(response) => return Ok(response),
    };
    let view = state.title_services.list_titles(character.id).await?;
    Ok(success(view))
}

async fn equip_title_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<EquipTitlePayload>,
) -> Result<Response, BusinessError> {
    let character = match require_character_context(&state, &headers).await {
        Ok(character) => character,
        Err(response) => return Ok(response),
    };
    let title_id = payload
        .title_id
        .or(payload.legacy_title_id)
        .unwrap_or_default();
    let result = state
        .title_services
        .equip_title(character.id, title_id)
        .await?;
    Ok(service_result(
        ServiceResultResponse::<serde_json::Value>::new(result.success, Some(result.message), None),
    ))
}

async fn require_character_context(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<CharacterBasicInfo, Response> {
    let Some(token) = crate::edge::http::auth::read_bearer_token(headers) else {
        return Err(unauthorized_response());
    };

    let result = state.auth_services.verify_token_and_session(&token).await;
    if !result.valid {
        return match invalid_session_response(result.kicked) {
            Ok(response) => Err(response),
            Err(error) => Err(error.into_response()),
        };
    }

    let Some(user_id) = result.user_id else {
        return Err(unauthorized_response());
    };

    let character = state
        .auth_services
        .check_character(user_id)
        .await
        .map_err(IntoResponse::into_response)?;
    let Some(character) = character.character else {
        return Err(
            BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response(),
        );
    };
    Ok(character)
}
