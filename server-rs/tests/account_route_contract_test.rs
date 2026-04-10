use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::account::service::PhoneBindingStatusDto;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
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
use jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn account_current_ip_route_uses_first_forwarded_ip() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/current-ip")
                .header("authorization", "Bearer account-token")
                .header("x-forwarded-for", "203.0.113.9, 10.0.0.1")
                .body(Body::empty())
                .expect("account current-ip request"),
        )
        .await
        .expect("account current-ip response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "ip": "203.0.113.9"
            }
        })
    );
}

#[tokio::test]
async fn account_phone_binding_status_route_preserves_node_payload() {
    let app = build_router(build_app_state(FakeAuthServices {
        phone_binding_status: PhoneBindingStatusDto {
            enabled: true,
            is_bound: true,
            masked_phone_number: Some("138****8000".to_string()),
        },
        ..FakeAuthServices::default()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/phone-binding/status")
                .header("authorization", "Bearer account-token")
                .body(Body::empty())
                .expect("account phone binding status request"),
        )
        .await
        .expect("account phone binding status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "enabled": true,
                "isBound": true,
                "maskedPhoneNumber": "138****8000"
            }
        })
    );
}

#[tokio::test]
async fn account_routes_require_authentication() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/current-ip")
                .body(Body::empty())
                .expect("account unauthorized request"),
        )
        .await
        .expect("account unauthorized response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "登录状态无效，请重新登录"
        })
    );
}

fn build_app_state(auth_services: FakeAuthServices) -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(NoopTimeRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Clone)]
struct FakeAuthServices {
    phone_binding_status: PhoneBindingStatusDto,
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            phone_binding_status: PhoneBindingStatusDto {
                enabled: false,
                is_bound: false,
                masked_phone_number: None,
            },
        }
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
                captcha_id: "captcha-account".to_string(),
                image_data: "data:image/svg+xml;base64,account".to_string(),
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
                character: Some(CharacterBasicInfo {
                    id: 1,
                    nickname: "青云子".to_string(),
                    gender: "male".to_string(),
                    title: "散修".to_string(),
                    realm: "炼精化炁·养气期".to_string(),
                    sub_realm: Some("养气期".to_string()),
                    auto_cast_skills: true,
                    auto_disassemble_enabled: false,
                    auto_disassemble_rules: Some(Vec::new()),
                    dungeon_no_stamina_cost: false,
                    spirit_stones: 0,
                    silver: 0,
                }),
            })
        })
    }

    fn get_phone_binding_status<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<PhoneBindingStatusDto, BusinessError>> + Send + 'a>>
    {
        let status = self.phone_binding_status.clone();
        Box::pin(async move { Ok(status) })
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
                success: true,
                message: "角色创建成功".to_string(),
                data: None,
            })
        })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        _current_map_id: String,
        _current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterPositionResult {
                success: true,
                message: "位置更新成功".to_string(),
            })
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
            Err(GameSocketAuthFailure {
                event: "game:error",
                message: "socket disabled in test".to_string(),
                disconnect_current: true,
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
