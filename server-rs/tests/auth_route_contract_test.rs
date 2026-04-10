use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult,
};
use jiuzhou_server_rs::bootstrap::app::{
    new_shared_runtime_services, AppState, RuntimeServicesState,
};
use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::edge::http::error::BusinessError;
use jiuzhou_server_rs::edge::http::routes::auth::{
    build_auth_router, AuthActionResult, AuthResponseData, AuthResponseUser, AuthRouteServices,
    CaptchaChallenge, CaptchaProvider, LoginInput, RegisterInput, VerifyTokenAndSessionResult,
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
async fn verify_route_returns_kicked_payload_when_session_conflicts() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 1,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: false,
            kicked: true,
            user_id: None,
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/verify")
                .header("authorization", "Bearer token-1")
                .body(Body::empty())
                .expect("verify request"),
        )
        .await
        .expect("verify response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "账号已在其他设备登录",
            "kicked": true,
        })
    );
}

#[tokio::test]
async fn bootstrap_route_returns_user_and_has_character_when_session_valid() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 1,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(7),
        },
        character_result: CheckCharacterResult {
            has_character: true,
            character: Some(sample_character()),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/bootstrap")
                .header("authorization", "Bearer token-2")
                .body(Body::empty())
                .expect("bootstrap request"),
        )
        .await
        .expect("bootstrap response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "userId": 7,
                "hasCharacter": true,
            }
        })
    );
}

#[tokio::test]
async fn verify_route_rejects_missing_bearer_header_with_401_business_error_shape() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 1,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(1),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/verify")
                .body(Body::empty())
                .expect("verify request"),
        )
        .await
        .expect("verify response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "登录状态无效，请重新登录",
        })
    );
}

#[tokio::test]
async fn captcha_route_returns_challenge_in_local_mode() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 123,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(1),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/captcha")
                .body(Body::empty())
                .expect("captcha request"),
        )
        .await
        .expect("captcha response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "captchaId": "captcha-1",
                "imageData": "data:image/svg+xml;base64,abc",
                "expiresAt": 123,
            }
        })
    );
}

#[tokio::test]
async fn captcha_route_rejects_tencent_mode() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Tencent,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 123,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(1),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/captcha")
                .body(Body::empty())
                .expect("captcha request"),
        )
        .await
        .expect("captcha response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "当前验证码模式不支持此操作",
        })
    );
}

#[tokio::test]
async fn login_and_register_routes_reject_missing_local_captcha_fields() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 123,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: None,
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(1),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let login_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/login")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"tester","password":"123456"}"#))
                .expect("login request"),
        )
        .await
        .expect("login response");
    let (login_status, login_json) = response_json(login_response).await;
    assert_eq!(login_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        login_json,
        serde_json::json!({
            "success": false,
            "message": "图片验证码不能为空",
        })
    );

    let register_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/register")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"username":"tester","password":"123456"}"#))
                .expect("register request"),
        )
        .await
        .expect("register response");
    let (register_status, register_json) = response_json(register_response).await;
    assert_eq!(register_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        register_json,
        serde_json::json!({
            "success": false,
            "message": "图片验证码不能为空",
        })
    );
}

#[tokio::test]
async fn login_route_returns_service_result_shape() {
    let app = build_auth_router().with_state(build_app_state(FakeAuthServices {
        captcha_provider: CaptchaProvider::Local,
        captcha_result: Ok(CaptchaChallenge {
            captcha_id: "captcha-1".to_string(),
            image_data: "data:image/svg+xml;base64,abc".to_string(),
            expires_at: 123,
        }),
        register_result: Ok(AuthActionResult {
            success: true,
            message: "注册成功".to_string(),
            data: None,
        }),
        login_result: Ok(AuthActionResult {
            success: true,
            message: "登录成功".to_string(),
            data: Some(AuthResponseData {
                user: AuthResponseUser {
                    id: 1,
                    username: "tester".to_string(),
                    status: 1,
                    created_at: None,
                    updated_at: None,
                    last_login: None,
                },
                token: "token-1".to_string(),
                session_token: "session-1".to_string(),
            }),
        }),
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(1),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"tester","password":"123456","captchaId":"captcha-1","captchaCode":"ABCD"}"#,
                ))
                .expect("login request"),
        )
        .await
        .expect("login response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "登录成功",
            "data": {
                "user": {
                    "id": 1,
                    "username": "tester",
                    "status": 1,
                },
                "token": "token-1",
                "sessionToken": "session-1",
            }
        })
    );
}

struct FakeAuthServices {
    captcha_provider: CaptchaProvider,
    captcha_result: Result<CaptchaChallenge, BusinessError>,
    register_result: Result<AuthActionResult, BusinessError>,
    login_result: Result<AuthActionResult, BusinessError>,
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
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
        self.captcha_provider
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.captcha_result.clone() })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.register_result.clone() })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { self.login_result.clone() })
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

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 3001,
        nickname: "青云子".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "炼气".to_string(),
        sub_realm: None,
        auto_cast_skills: false,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
        spirit_stones: 0,
        silver: 0,
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
                session_token: "auth-route-session".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
