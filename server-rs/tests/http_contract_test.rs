use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use http_body_util::BodyExt;
use jiuzhou_server_rs::edge::http::auth::{
    parse_positive_user_id, queue_timeout_response, read_bearer_token, unauthorized_response,
    AUTH_INVALID_MESSAGE, HTTP_USER_QUEUE_TIMEOUT_MESSAGE,
};
use jiuzhou_server_rs::edge::http::error::{internal_error_response, BusinessError};
use jiuzhou_server_rs::edge::http::qps_limit::{
    limit_exceeded_response, QpsLimitConfig, QpsLimitScope, DEFAULT_LIMIT_MESSAGE,
};
use jiuzhou_server_rs::edge::http::response::{ok, service_result, success, ServiceResultResponse};

#[tokio::test]
async fn response_helpers_match_current_http_contract_shape() {
    let success_response = success(serde_json::json!({ "userId": 1 }));
    let success_json = response_json(success_response).await;
    assert_eq!(success_json.0, StatusCode::OK);
    assert_eq!(
        success_json.1,
        serde_json::json!({ "success": true, "data": { "userId": 1 } })
    );

    let ok_response = ok();
    let ok_json = response_json(ok_response).await;
    assert_eq!(ok_json.0, StatusCode::OK);
    assert_eq!(ok_json.1, serde_json::json!({ "success": true }));

    let result_ok = service_result(ServiceResultResponse::new(
        true,
        Some("ok".to_string()),
        Some(serde_json::json!({ "value": 1 })),
    ));
    let result_ok_json = response_json(result_ok).await;
    assert_eq!(result_ok_json.0, StatusCode::OK);
    assert_eq!(
        result_ok_json.1,
        serde_json::json!({ "success": true, "message": "ok", "data": { "value": 1 } })
    );

    let result_fail = service_result(ServiceResultResponse::<serde_json::Value>::new(
        false,
        Some("bad".to_string()),
        None,
    ));
    let result_fail_json = response_json(result_fail).await;
    assert_eq!(result_fail_json.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        result_fail_json.1,
        serde_json::json!({ "success": false, "message": "bad" })
    );
}

#[tokio::test]
async fn error_helpers_match_current_http_contract_shape() {
    let business_error_response =
        BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response();
    let business_error_json = response_json(business_error_response).await;
    assert_eq!(business_error_json.0, StatusCode::NOT_FOUND);
    assert_eq!(
        business_error_json.1,
        serde_json::json!({ "success": false, "message": "角色不存在" })
    );

    let internal_error_json = response_json(internal_error_response()).await;
    assert_eq!(internal_error_json.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        internal_error_json.1,
        serde_json::json!({ "success": false, "message": "服务器错误" })
    );
}

#[tokio::test]
async fn auth_helpers_preserve_bearer_and_fixed_messages() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_static("Bearer token-123"),
    );
    assert_eq!(read_bearer_token(&headers).as_deref(), Some("token-123"));
    assert_eq!(parse_positive_user_id("42"), Some(42));
    assert_eq!(parse_positive_user_id("0"), None);

    let unauthorized_json = response_json(unauthorized_response()).await;
    assert_eq!(unauthorized_json.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        unauthorized_json.1,
        serde_json::json!({ "success": false, "message": AUTH_INVALID_MESSAGE })
    );

    let queue_timeout_json = response_json(queue_timeout_response()).await;
    assert_eq!(queue_timeout_json.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        queue_timeout_json.1,
        serde_json::json!({ "success": false, "message": HTTP_USER_QUEUE_TIMEOUT_MESSAGE })
    );
}

#[tokio::test]
async fn qps_limit_helpers_preserve_key_shape_and_429_message() {
    let default_config =
        QpsLimitConfig::new("qps:auth:login", 12, 60_000, None).expect("default config");
    assert_eq!(default_config.message, DEFAULT_LIMIT_MESSAGE);
    assert_eq!(
        default_config
            .redis_key(QpsLimitScope::Text("127.0.0.1".to_string()), 120_500)
            .expect("redis key"),
        "qps:auth:login:127.0.0.1:2"
    );

    let user_scope_key = default_config
        .redis_key(QpsLimitScope::Number(9), 121_000)
        .expect("user scope key");
    assert_eq!(user_scope_key, "qps:auth:login:9:2");

    let custom_message_response = limit_exceeded_response("认证请求过于频繁，请稍后再试");
    let custom_message_json = response_json(custom_message_response).await;
    assert_eq!(custom_message_json.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        custom_message_json.1,
        serde_json::json!({ "success": false, "message": "认证请求过于频繁，请稍后再试" })
    );
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
