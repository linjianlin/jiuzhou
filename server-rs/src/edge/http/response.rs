use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SuccessResponse<T>
where
    T: Serialize,
{
    pub success: bool,
    pub data: T,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OkResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ServiceResultResponse<T>
where
    T: Serialize,
{
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

impl<T> SuccessResponse<T>
where
    T: Serialize,
{
    pub fn new(data: T) -> Self {
        Self {
            success: true,
            data,
        }
    }
}

impl OkResponse {
    pub fn new() -> Self {
        Self { success: true }
    }
}

impl<T> ServiceResultResponse<T>
where
    T: Serialize,
{
    pub fn new(success: bool, message: Option<String>, data: Option<T>) -> Self {
        Self {
            success,
            message,
            data,
        }
    }

    pub fn into_http_response(self) -> Response {
        let status = if self.success {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, Json(self)).into_response()
    }
}

pub fn success<T>(data: T) -> Response
where
    T: Serialize,
{
    Json(SuccessResponse::new(data)).into_response()
}

pub fn ok() -> Response {
    Json(OkResponse::new()).into_response()
}

pub fn service_result<T>(result: ServiceResultResponse<T>) -> Response
where
    T: Serialize,
{
    result.into_http_response()
}
