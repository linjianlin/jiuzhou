use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult,
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
use std::sync::Arc;
use std::{future::Future, pin::Pin};
use tower::ServiceExt;

#[tokio::test]
async fn root_and_health_routes_match_current_contract_shape() {
    let settings = Settings::from_map(std::collections::HashMap::new()).expect("settings");
    let readiness = ReadinessGate::new();
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    let app = build_router(AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(NoopAuthServices),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
        game_services: Arc::new(jiuzhou_server_rs::edge::http::routes::game::NoopGameRouteServices),
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
        month_card_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices,
        ),

        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        realm_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices,
        ),

        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(NoopAuthServices),
        settings,
        readiness,
        session_registry: new_shared_session_registry(),
        runtime_services: runtime_services.clone(),
    });

    let runtime_snapshot = runtime_services.read().await;
    assert!(runtime_snapshot.battle_registry.is_empty());
    assert!(runtime_snapshot.session_registry.is_empty());
    assert!(runtime_snapshot
        .online_projection_registry
        .character_ids()
        .is_empty());
    assert!(runtime_snapshot
        .idle_runtime_service
        .locked_character_ids()
        .is_empty());

    let root_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("root request"),
        )
        .await
        .expect("root response");
    assert_eq!(root_response.status(), StatusCode::OK);

    let root_body = root_response
        .into_body()
        .collect()
        .await
        .expect("collect root body")
        .to_bytes();
    let root_json: serde_json::Value = serde_json::from_slice(&root_body).expect("root json");
    assert_eq!(root_json["name"], "九州修仙录");
    assert_eq!(root_json["version"], "1.0.0");
    assert_eq!(root_json["status"], "running");

    let health_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .expect("health request"),
        )
        .await
        .expect("health response");
    assert_eq!(health_response.status(), StatusCode::OK);

    let health_body = health_response
        .into_body()
        .collect()
        .await
        .expect("collect health body")
        .to_bytes();
    let health_json: serde_json::Value = serde_json::from_slice(&health_body).expect("health json");
    assert_eq!(health_json["status"], "ok");
    assert!(health_json["timestamp"].is_number());
    assert_eq!(
        health_json,
        serde_json::json!({
            "status": "ok",
            "timestamp": health_json["timestamp"].clone(),
        })
    );

    let auth_verify_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/verify")
                .body(Body::empty())
                .expect("auth verify request"),
        )
        .await
        .expect("auth verify response");
    assert_eq!(auth_verify_response.status(), StatusCode::UNAUTHORIZED);

    let auth_verify_body = auth_verify_response
        .into_body()
        .collect()
        .await
        .expect("collect auth verify body")
        .to_bytes();
    let auth_verify_json: serde_json::Value =
        serde_json::from_slice(&auth_verify_body).expect("auth verify json");
    assert_eq!(
        auth_verify_json,
        serde_json::json!({
            "success": false,
            "message": "登录状态无效，请重新登录",
        })
    );

    let captcha_config_response = app
        .oneshot(
            Request::builder()
                .uri("/api/captcha/config")
                .body(Body::empty())
                .expect("captcha config request"),
        )
        .await
        .expect("captcha config response");
    assert_eq!(captcha_config_response.status(), StatusCode::OK);

    let captcha_config_body = captcha_config_response
        .into_body()
        .collect()
        .await
        .expect("collect captcha config body")
        .to_bytes();
    let captcha_config_json: serde_json::Value =
        serde_json::from_slice(&captcha_config_body).expect("captcha config json");
    assert_eq!(
        captcha_config_json,
        serde_json::json!({
            "success": true,
            "data": {
                "provider": "local",
            }
        })
    );
}

struct NoopAuthServices;

impl AuthRouteServices for NoopAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CaptchaChallenge,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "noop".to_string(),
                image_data: "data:image/svg+xml;base64,bm9vcA==".to_string(),
                expires_at: 0,
            })
        })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AuthActionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AuthActionResult {
                success: false,
                message: "noop".to_string(),
                data: None,
            })
        })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AuthActionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AuthActionResult {
                success: false,
                message: "noop".to_string(),
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
                valid: false,
                kicked: false,
                user_id: None,
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
                has_character: false,
                character: None,
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
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
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

impl GameSocketAuthServices for NoopAuthServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "noop-session".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}
