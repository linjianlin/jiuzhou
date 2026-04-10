use std::sync::Arc;
use std::time::Duration;
use std::{future::Future, pin::Pin};

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

#[tokio::test]
async fn health_endpoint_stays_unreachable_until_startup_marks_ready_and_server_binds() {
    let readiness = ReadinessGate::new();
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    let auth_services = Arc::new(NoopAuthServices);
    let state = AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: auth_services.clone(),
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
        game_socket_services: auth_services,
        settings: Settings::from_map(Default::default()).expect("settings"),
        readiness: readiness.clone(),
        session_registry: new_shared_session_registry(),
        runtime_services,
    };

    let app = build_router(state);
    let reserved = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve test listener");
    let local_addr = reserved.local_addr().expect("reserved listener addr");
    drop(reserved);

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let server_handle = tokio::spawn(async move {
        ready_rx.await.expect("startup release signal");
        readiness.mark_ready();
        let listener = tokio::net::TcpListener::bind(local_addr)
            .await
            .expect("bind test listener after startup");
        axum::serve(listener, app).await.expect("serve test app");
    });

    assert!(request_health(local_addr).await.is_err());

    ready_tx.send(()).expect("release startup");

    let health_after_ready = wait_for_health(local_addr).await;
    assert_eq!(health_after_ready["status"], "ok");
    assert_eq!(health_after_ready["ready"], true);

    server_handle.abort();
}

async fn request_health(addr: std::net::SocketAddr) -> Result<serde_json::Value, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("build reqwest client");
    client
        .get(format!("http://{addr}/api/health"))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await
}

async fn wait_for_health(addr: std::net::SocketAddr) -> serde_json::Value {
    for _ in 0..20 {
        if let Ok(response) = request_health(addr).await {
            return response;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    request_health(addr)
        .await
        .expect("health endpoint should become reachable after startup")
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
                captcha_id: "noop".to_string(),
                image_data: "data:image/svg+xml;base64,bm9vcA==".to_string(),
                expires_at: 0,
            })
        })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
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
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
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
