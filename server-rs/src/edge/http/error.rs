use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessError {
    pub message: String,
    pub status_code: StatusCode,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ErrorResponse {
    pub success: bool,
    pub message: String,
}

impl BusinessError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status_code: StatusCode::BAD_REQUEST,
        }
    }

    pub fn with_status(message: impl Into<String>, status_code: StatusCode) -> Self {
        Self {
            message: message.into(),
            status_code,
        }
    }
}

impl IntoResponse for BusinessError {
    fn into_response(self) -> Response {
        (
            self.status_code,
            Json(ErrorResponse {
                success: false,
                message: self.message,
            }),
        )
            .into_response()
    }
}

pub fn internal_error_response() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            success: false,
            message: "服务器错误".to_string(),
        }),
    )
        .into_response()
}
