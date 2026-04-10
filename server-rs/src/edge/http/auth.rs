use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

pub const AUTH_INVALID_MESSAGE: &str = "登录状态无效，请重新登录";
pub const HTTP_USER_QUEUE_TIMEOUT_MESSAGE: &str = "当前账号请求排队超时，请稍后再试";
pub const MAX_CONCURRENT_HTTP_REQUESTS_PER_USER: usize = 6;
pub const HTTP_USER_QUEUE_WAIT_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AuthErrorResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KickedAuthErrorResponse {
    pub success: bool,
    pub message: String,
    pub kicked: bool,
}

pub fn read_bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(axum::http::header::AUTHORIZATION)?;
    let value = value.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub fn parse_positive_user_id(raw: &str) -> Option<i64> {
    let user_id = raw.parse::<i64>().ok()?;
    if user_id > 0 {
        Some(user_id)
    } else {
        None
    }
}

pub fn unauthorized_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(AuthErrorResponse {
            success: false,
            message: AUTH_INVALID_MESSAGE.to_string(),
        }),
    )
        .into_response()
}

pub fn queue_timeout_response() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(AuthErrorResponse {
            success: false,
            message: HTTP_USER_QUEUE_TIMEOUT_MESSAGE.to_string(),
        }),
    )
        .into_response()
}

pub fn kicked_session_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(KickedAuthErrorResponse {
            success: false,
            message: "账号已在其他设备登录".to_string(),
            kicked: true,
        }),
    )
        .into_response()
}

pub fn invalid_session_response(
    kicked: bool,
) -> Result<Response, crate::edge::http::error::BusinessError> {
    if kicked {
        return Ok(kicked_session_response());
    }

    Err(crate::edge::http::error::BusinessError::with_status(
        AUTH_INVALID_MESSAGE,
        StatusCode::UNAUTHORIZED,
    ))
}
