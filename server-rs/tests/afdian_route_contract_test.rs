use std::sync::atomic::{AtomicUsize, Ordering};
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
use jiuzhou_server_rs::edge::http::routes::afdian::{AfdianRouteError, AfdianRouteServices};
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
async fn afdian_webhook_get_returns_fixed_ec_em_shape() {
    let app = build_router(build_app_state(FakeAfdianRouteServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/afdian/webhook")
                .body(Body::empty())
                .expect("afdian webhook get request"),
        )
        .await
        .expect("afdian webhook get response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "ec": 200,
            "em": "",
        })
    );
}

#[tokio::test]
async fn afdian_webhook_post_ignores_non_order_payload_without_invoking_service() {
    let services = FakeAfdianRouteServices::success();
    let call_count = services.call_count.clone();
    let app = build_router(build_app_state(services));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/afdian/webhook")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "data": {
                            "type": "ping",
                        }
                    })
                    .to_string(),
                ))
                .expect("afdian webhook non-order request"),
        )
        .await
        .expect("afdian webhook non-order response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "ec": 200,
            "em": "",
        })
    );
    assert_eq!(call_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn afdian_webhook_post_returns_ok_when_order_is_processed() {
    let services = FakeAfdianRouteServices::success();
    let call_count = services.call_count.clone();
    let app = build_router(build_app_state(services));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/afdian/webhook")
                .header("content-type", "application/json")
                .body(Body::from(valid_order_payload().to_string()))
                .expect("afdian webhook order request"),
        )
        .await
        .expect("afdian webhook order response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "ec": 200,
            "em": "",
        })
    );
    assert_eq!(call_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn afdian_webhook_post_maps_service_failure_to_400_ec_em_shape() {
    let app = build_router(build_app_state(FakeAfdianRouteServices::failure(
        "爱发电订单回查失败：未找到对应订单",
    )));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/afdian/webhook")
                .header("content-type", "application/json")
                .body(Body::from(valid_order_payload().to_string()))
                .expect("afdian webhook failure request"),
        )
        .await
        .expect("afdian webhook failure response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "ec": 400,
            "em": "爱发电订单回查失败：未找到对应订单",
        })
    );
}

fn build_app_state<T>(afdian_services: T) -> AppState
where
    T: AfdianRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(afdian_services),
        auth_services: Arc::new(NoopAuthServices),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
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
        game_socket_services: Arc::new(NoopAuthServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

fn valid_order_payload() -> serde_json::Value {
    serde_json::json!({
        "data": {
            "type": "order",
            "order": {
                "out_trade_no": "afdian-order-1",
                "user_id": "user-1",
                "plan_id": "plan-1",
                "month": 1,
                "total_amount": "30.00",
                "status": 2
            }
        }
    })
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect response body")
        .to_bytes();
    let json = serde_json::from_slice(&body).expect("response json");
    (status, json)
}

#[derive(Clone)]
struct FakeAfdianRouteServices {
    result: Result<(), AfdianRouteError>,
    call_count: Arc<AtomicUsize>,
}

impl FakeAfdianRouteServices {
    fn success() -> Self {
        Self {
            result: Ok(()),
            call_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn failure(message: &str) -> Self {
        Self {
            result: Err(AfdianRouteError::new(message)),
            call_count: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl AfdianRouteServices for FakeAfdianRouteServices {
    fn handle_webhook<'a>(
        &'a self,
        _payload: jiuzhou_server_rs::edge::http::routes::afdian::AfdianWebhookPayloadInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), AfdianRouteError>> + Send + 'a>> {
        let result = self.result.clone();
        let call_count = self.call_count.clone();
        Box::pin(async move {
            call_count.fetch_add(1, Ordering::SeqCst);
            result
        })
    }
}

struct NoopAuthServices;

impl AuthRouteServices for NoopAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "captcha".to_string(),
                image_data: "data:image/svg+xml;base64,abc".to_string(),
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
                message: "ok".to_string(),
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
                message: "ok".to_string(),
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
                user_id: Some(1),
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
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterPositionResult {
                success: true,
                message: "ok".to_string(),
            })
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
                session_token: "session-token".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}
