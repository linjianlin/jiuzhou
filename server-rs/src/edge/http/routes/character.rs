use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use axum::Json;
use serde::Deserialize;

use crate::application::character::service::CharacterRouteData;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, unauthorized_response};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * character 最小兼容路由。
 *
 * 作用：
 * 1. 做什么：提供 `/check`、`/info`、`/create`、`/updatePosition` 四个当前登录/角色落点同步主流程所需的最小接口。
 * 2. 做什么：复用现有 Bearer + session 校验语义，并把返回 envelope 保持为 Node 当前的 `sendResult` 形状。
 * 3. 不做什么：不扩展自动施法、改名等其它 mutation 接口。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；create 额外接收 `{ nickname, gender }`；updatePosition 额外接收 `{ currentMapId, currentRoomId }`。
 * - 输出：Node 兼容 `{ success, message, data? }`；其中 `data` 为 `{ character, hasCharacter }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 会话校验 -> `AuthRouteServices::{check_character,create_character,update_character_position}`
 * - -> application 层统一读取/写入角色最小快照 -> 这里做最薄 envelope 转换。
 *
 * 复用设计说明：
 * - `/auth/bootstrap`、`/character/check`、`/character/create` 共用同一套 session 校验与基础角色快照结构，避免登录后首创角链路和后续读取链路出现口径漂移。
 * - 只在路由层负责协议转换与 Node 可见参数校验，业务读写全部下沉，避免 handler 重复拼接道号规则和写库 SQL。
 *
 * 关键边界条件与坑点：
 * 1. 被踢下线必须继续返回 `401 + kicked:true`，不能被统一抹平成普通未登录。
 * 2. `/info` 无角色时必须维持 `400 { success:false, message:'角色不存在' }`，而不是返回 `200 + hasCharacter:false`。
 * 3. `/create` 路由层必须继续保留 Node 可见的参数报错文案：`道号和性别不能为空`、`性别参数错误`。
 * 4. `/updatePosition` 必须继续复用同一鉴权路径，并保持 service 返回的 `位置参数不能为空`、`位置参数过长`、`角色不存在`、`位置更新成功` 文案不变。
 */
#[derive(Debug, Deserialize)]
struct CreateCharacterPayload {
    nickname: Option<String>,
    gender: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateCharacterPositionPayload {
    #[serde(rename = "currentMapId")]
    current_map_id: Option<String>,
    #[serde(rename = "currentRoomId")]
    current_room_id: Option<String>,
}

pub fn build_character_router() -> Router<AppState> {
    Router::new()
        .route("/check", get(check_character_handler))
        .route("/info", get(get_character_info_handler))
        .route("/create", post(create_character_handler))
        .route("/updatePosition", post(update_character_position_handler))
}

async fn create_character_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCharacterPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let normalized_nickname = payload.nickname.unwrap_or_default().trim().to_string();
    let gender = payload.gender.unwrap_or_default();
    if normalized_nickname.is_empty() || gender.is_empty() {
        return Err(BusinessError::new("道号和性别不能为空"));
    }

    if gender != "male" && gender != "female" {
        return Err(BusinessError::new("性别参数错误"));
    }

    let result = state
        .auth_services
        .create_character(user_id, normalized_nickname, gender)
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn check_character_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state.auth_services.check_character(user_id).await?;
    let message = if result.has_character {
        "已有角色"
    } else {
        "未创建角色"
    };

    Ok(service_result(ServiceResultResponse::new(
        true,
        Some(message.to_string()),
        Some(CharacterRouteData {
            character: result.character,
            has_character: result.has_character,
        }),
    )))
}

async fn get_character_info_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state.auth_services.check_character(user_id).await?;
    if !result.has_character {
        return Ok(service_result(
            ServiceResultResponse::<CharacterRouteData>::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ),
        ));
    }

    Ok(service_result(ServiceResultResponse::new(
        true,
        Some("获取成功".to_string()),
        Some(CharacterRouteData {
            character: result.character,
            has_character: true,
        }),
    )))
}

async fn update_character_position_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateCharacterPositionPayload>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state
        .auth_services
        .update_character_position(
            user_id,
            payload.current_map_id.unwrap_or_default(),
            payload.current_room_id.unwrap_or_default(),
        )
        .await?;

    Ok(service_result(ServiceResultResponse::<serde_json::Value>::new(
        result.success,
        Some(result.message),
        None,
    )))
}

async fn require_authenticated_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<i64, Response> {
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

    result.user_id.ok_or_else(unauthorized_response)
}
