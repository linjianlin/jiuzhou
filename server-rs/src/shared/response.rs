use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SuccessResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceResult<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

pub fn send_success<T: Serialize>(data: T) -> Json<SuccessResponse<T>> {
    Json(SuccessResponse {
        success: true,
        message: None,
        data: Some(data),
    })
}

pub fn send_ok() -> Json<SuccessResponse<()>> {
    Json(SuccessResponse {
        success: true,
        message: None,
        data: None,
    })
}

pub fn send_result<T: Serialize>(result: ServiceResult<T>) -> Response {
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };

    (status, Json(result)).into_response()
}

#[cfg(test)]
mod tests {
    use axum::response::IntoResponse;

    use super::{ServiceResult, send_ok, send_result, send_success};

    #[test]
    fn send_success_wraps_data() {
        let response = send_success(serde_json::json!({"value": 1}));
        let payload = serde_json::to_value(&response.0).expect("response should serialize");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["value"], 1);
    }

    #[test]
    fn send_ok_omits_data() {
        let response = send_ok();
        let payload = serde_json::to_value(&response.0).expect("response should serialize");
        assert_eq!(payload["success"], true);
        assert!(payload.get("data").is_none());
    }

    #[test]
    fn send_result_uses_400_for_business_failure() {
        let response = send_result(ServiceResult::<()> {
            success: false,
            message: Some("失败".to_string()),
            data: None,
        })
        .into_response();

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
    }
}
