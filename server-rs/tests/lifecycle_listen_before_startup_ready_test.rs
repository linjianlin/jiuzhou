use std::sync::Arc;
use std::time::Duration;
use std::{future::Future, pin::Pin};

use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult,
};
use jiuzhou_server_rs::bootstrap::app::{
    build_router, new_shared_runtime_services, AppState, RuntimeServicesState,
};
use jiuzhou_server_rs::bootstrap::lifecycle::spawn_background_startup;
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
async fn health_endpoint_is_reachable_before_background_startup_finishes() {
    let readiness = ReadinessGate::new();
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    let auth_services = Arc::new(NoopAuthServices);
    let state = AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: auth_services.clone(),
        idle_services: Arc::new(NoopIdleRouteServices),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: auth_services,
        settings: Settings::from_map(Default::default()).expect("settings"),
        readiness: readiness.clone(),
        session_registry: new_shared_session_registry(),
        runtime_services,
    };

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let local_addr = listener.local_addr().expect("listener addr");
    let app = build_router(state);
    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve test app");
    });

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let startup_handle = spawn_background_startup(async move {
        ready_rx.await.expect("startup release signal");
        readiness.mark_ready();
        Ok(())
    });

    let health_before_ready = wait_for_health(local_addr, false).await;
    assert_eq!(health_before_ready["status"], "ok");
    assert_eq!(health_before_ready["ready"], false);

    ready_tx.send(()).expect("release startup");

    let mut health_after_ready = None;
    for _ in 0..20 {
        let response = request_health(local_addr).await;
        if response["ready"] == true {
            health_after_ready = Some(response);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let health_after_ready = health_after_ready.expect("health should become ready");
    assert_eq!(health_after_ready["status"], "ok");
    assert_eq!(health_after_ready["ready"], true);

    startup_handle.await.expect("startup task join");
    server_handle.abort();
}

async fn request_health(addr: std::net::SocketAddr) -> serde_json::Value {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .expect("build reqwest client");
    client
        .get(format!("http://{addr}/api/health"))
        .send()
        .await
        .expect("request health endpoint")
        .json::<serde_json::Value>()
        .await
        .expect("parse health json")
}

async fn wait_for_health(addr: std::net::SocketAddr, expected_ready: bool) -> serde_json::Value {
    for _ in 0..20 {
        match request_health(addr).await {
            response if response["ready"] == expected_ready => return response,
            _ => {}
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let response = request_health(addr).await;

    panic!(
        "health endpoint did not reach expected ready={expected_ready}: {:?}",
        response
    );
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
