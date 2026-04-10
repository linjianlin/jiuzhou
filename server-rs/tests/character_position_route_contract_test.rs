use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
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
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn character_update_position_rejects_empty_params() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(21),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: false,
            message: "未使用".to_string(),
            data: None,
        },
        update_position_result: UpdateCharacterPositionResult {
            success: false,
            message: "未使用".to_string(),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updatePosition")
                .header("authorization", "Bearer token-position-empty")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"currentMapId":"","currentRoomId":"room-village-center"}"#,
                ))
                .expect("character update position request"),
        )
        .await
        .expect("character update position response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "位置参数不能为空",
        })
    );
}

#[tokio::test]
async fn character_update_position_rejects_overlong_params() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(22),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: false,
            message: "未使用".to_string(),
            data: None,
        },
        update_position_result: UpdateCharacterPositionResult {
            success: false,
            message: "未使用".to_string(),
        },
    }));

    let long_map_id = "m".repeat(65);
    let body = serde_json::json!({
        "currentMapId": long_map_id,
        "currentRoomId": "room-village-center",
    });

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updatePosition")
                .header("authorization", "Bearer token-position-overlong")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("character update position request"),
        )
        .await
        .expect("character update position response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "位置参数过长",
        })
    );
}

#[tokio::test]
async fn character_update_position_returns_missing_character_failure() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(23),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: false,
            message: "未使用".to_string(),
            data: None,
        },
        update_position_result: UpdateCharacterPositionResult {
            success: false,
            message: "角色不存在".to_string(),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updatePosition")
                .header("authorization", "Bearer token-position-missing")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"currentMapId":"map-qingyun-village","currentRoomId":"room-village-center"}"#,
                ))
                .expect("character update position request"),
        )
        .await
        .expect("character update position response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "角色不存在",
        })
    );
}

#[tokio::test]
async fn character_update_position_returns_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(24),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: false,
            message: "未使用".to_string(),
            data: None,
        },
        update_position_result: UpdateCharacterPositionResult {
            success: true,
            message: "位置更新成功".to_string(),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updatePosition")
                .header("authorization", "Bearer token-position-success")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"currentMapId":"map-qingyun-village","currentRoomId":"room-village-center"}"#,
                ))
                .expect("character update position request"),
        )
        .await
        .expect("character update position response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "位置更新成功",
        })
    );
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
    create_result: CreateCharacterResult,
    update_position_result: UpdateCharacterPositionResult,
}

fn build_app_state<T>(services: T) -> AppState
where
    T: AuthRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(services),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        month_card_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices),

        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        realm_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices),

        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

struct FakeGameSocketServices;

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
        Box::pin(async move { self.verify_result.clone() })
    }

    fn check_character<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.character_result.clone()) })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.create_result.clone()) })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        current_map_id: String,
        current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let map_id = current_map_id.trim();
            let room_id = current_room_id.trim();
            if map_id.is_empty() || room_id.is_empty() {
                return Ok(UpdateCharacterPositionResult {
                    success: false,
                    message: "位置参数不能为空".to_string(),
                });
            }
            if map_id.chars().count() > 64 || room_id.chars().count() > 64 {
                return Ok(UpdateCharacterPositionResult {
                    success: false,
                    message: "位置参数过长".to_string(),
                });
            }
            Ok(self.update_position_result.clone())
        })
    }
}

impl GameSocketAuthServices for FakeGameSocketServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "character-position-route-test-session".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json = if bytes.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json body")
    };
    (status, json)
}
