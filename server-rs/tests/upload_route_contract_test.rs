use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult,
};
use jiuzhou_server_rs::application::upload::service::RustUploadService;
use jiuzhou_server_rs::bootstrap::app::{
    build_router, new_shared_runtime_services, AppState, RuntimeServicesState,
};
use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::edge::http::error::BusinessError;
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn upload_avatar_sts_returns_same_contract_as_avatar_asset_sts() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-avatar-sts-success");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar/sts")
                .header("authorization", "Bearer token-upload-avatar-sts-success")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "contentType": "image/png",
                        "fileSize": 256,
                    })
                    .to_string(),
                ))
                .expect("upload avatar sts success request"),
        )
        .await
        .expect("upload avatar sts success response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "cosEnabled": false,
                "maxFileSizeBytes": 2_097_152,
            }
        })
    );
}

#[tokio::test]
async fn upload_avatar_asset_sts_rejects_invalid_content_type_with_frozen_message() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-invalid-type");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar-asset/sts")
                .header("authorization", "Bearer token-upload-invalid-type")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "contentType": "text/plain",
                        "fileSize": 128,
                    })
                    .to_string(),
                ))
                .expect("upload sts invalid type request"),
        )
        .await
        .expect("upload sts invalid type response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "只支持 JPG、PNG、GIF、WEBP 格式的图片",
        })
    );
}

#[tokio::test]
async fn upload_avatar_asset_sts_returns_send_success_envelope_for_local_fallback() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-sts-success");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar-asset/sts")
                .header("authorization", "Bearer token-upload-sts-success")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "contentType": "image/png",
                        "fileSize": 128,
                    })
                    .to_string(),
                ))
                .expect("upload sts success request"),
        )
        .await
        .expect("upload sts success response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "cosEnabled": false,
                "maxFileSizeBytes": 2_097_152,
            }
        })
    );
}

#[tokio::test]
async fn upload_avatar_asset_sts_rejects_oversized_file_with_frozen_message() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-invalid-size");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar-asset/sts")
                .header("authorization", "Bearer token-upload-invalid-size")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "contentType": "image/png",
                        "fileSize": 2_097_153,
                    })
                    .to_string(),
                ))
                .expect("upload sts invalid size request"),
        )
        .await
        .expect("upload sts invalid size response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "图片大小不能超过2MB",
        })
    );
}

#[tokio::test]
async fn upload_avatar_confirm_uses_character_avatar_success_message() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-avatar-confirm");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar/confirm")
                .header("authorization", "Bearer token-upload-avatar-confirm")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "avatarUrl": "/uploads/avatars/avatar-confirm.png",
                    })
                    .to_string(),
                ))
                .expect("upload avatar confirm request"),
        )
        .await
        .expect("upload avatar confirm response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "头像更新成功",
            "avatarUrl": "/uploads/avatars/avatar-confirm.png",
        })
    );
}

#[tokio::test]
async fn upload_avatar_asset_confirm_requires_avatar_url_field() {
    let temp_dir = std::env::temp_dir().join("jiuzhou-upload-route-contract-missing-avatar-url");
    let app = build_router(build_app_state(temp_dir));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar-asset/confirm")
                .header("authorization", "Bearer token-upload-confirm")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("upload confirm request"),
        )
        .await
        .expect("upload confirm response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "缺少 avatarUrl",
        })
    );
}

#[tokio::test]
async fn upload_avatar_returns_character_update_message_and_persists_local_file() {
    let temp_dir = std::env::temp_dir().join(format!(
        "jiuzhou-upload-route-contract-avatar-success-{}",
        std::process::id()
    ));
    let app = build_router(build_app_state(temp_dir.clone()));

    let boundary = "upload-boundary-avatar-success";
    let request_body = multipart_body(boundary, "avatar", "avatar.png", "image/png", b"png-bytes");
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar")
                .header("authorization", "Bearer token-upload-avatar-success")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(request_body))
                .expect("upload avatar request"),
        )
        .await
        .expect("upload avatar response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("头像更新成功"));

    let avatar_url = json["avatarUrl"]
        .as_str()
        .expect("avatarUrl should be present on success");
    assert!(avatar_url.starts_with("/uploads/avatars/avatar-"));
    assert!(avatar_url.ends_with(".png"));

    let file_name = avatar_url
        .split('/')
        .next_back()
        .expect("avatar url should contain file name");
    let stored_file = temp_dir.join(file_name);
    assert!(
        stored_file.exists(),
        "stored file should exist: {stored_file:?}"
    );
}

#[tokio::test]
async fn upload_avatar_asset_returns_success_shape_and_persists_local_file() {
    let temp_dir = std::env::temp_dir().join(format!(
        "jiuzhou-upload-route-contract-success-{}",
        std::process::id()
    ));
    let app = build_router(build_app_state(temp_dir.clone()));

    let boundary = "upload-boundary-success";
    let request_body = multipart_body(boundary, "avatar", "avatar.png", "image/png", b"png-bytes");
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/upload/avatar-asset")
                .header("authorization", "Bearer token-upload-success")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(request_body))
                .expect("upload asset request"),
        )
        .await
        .expect("upload asset response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("头像上传成功"));

    let avatar_url = json["avatarUrl"]
        .as_str()
        .expect("avatarUrl should be present on success");
    assert!(avatar_url.starts_with("/uploads/avatars/avatar-"));
    assert!(avatar_url.ends_with(".png"));

    let file_name = avatar_url
        .split('/')
        .next_back()
        .expect("avatar url should contain file name");
    let stored_file = temp_dir.join(file_name);
    assert!(
        stored_file.exists(),
        "stored file should exist: {stored_file:?}"
    );
}

fn build_app_state(upload_dir: std::path::PathBuf) -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(FakeAuthServices),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        upload_services: Arc::new(RustUploadService::with_local_storage_root(upload_dir)),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

struct FakeAuthServices;

impl AuthRouteServices for FakeAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "captcha-unused".to_string(),
                image_data: "data:image/svg+xml;base64,unused".to_string(),
                expires_at: 1,
            })
        })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(AuthActionResult {
                success: true,
                message: "注册成功".to_string(),
                data: None,
            })
        })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(AuthActionResult {
                success: true,
                message: "登录成功".to_string(),
                data: None,
            })
        })
    }

    fn verify_token_and_session<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<Box<dyn Future<Output = VerifyTokenAndSessionResult> + Send + 'a>> {
        Box::pin(async move {
            VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            }
        })
    }

    fn check_character<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            })
        })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(CreateCharacterResult {
                success: false,
                message: "noop".to_string(),
                data: None,
            })
        })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        _current_map_id: String,
        _current_room_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult, BusinessError>> + Send + 'a>>{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult {
                    success: false,
                    message: "noop".to_string(),
                },
            )
        })
    }
}

struct FakeGameSocketServices;

impl GameSocketAuthServices for FakeGameSocketServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(GameSocketAuthProfile {
                user_id: 7,
                session_token: "session-token".to_string(),
                character_id: Some(3001),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 3001,
        nickname: "青云子".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "炼气".to_string(),
        sub_realm: None,
        auto_cast_skills: true,
        auto_disassemble_enabled: true,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
        spirit_stones: 88,
        silver: 666,
    }
}

fn multipart_body(
    boundary: &str,
    field_name: &str,
    file_name: &str,
    content_type: &str,
    file_bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{file_name}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
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
