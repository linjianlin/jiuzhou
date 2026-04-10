use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CharacterRouteData, CheckCharacterResult, CreateCharacterResult,
    UpdateCharacterPositionResult,
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
async fn character_create_rejects_missing_nickname_or_gender() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(11),
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
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/create")
                .header("authorization", "Bearer token-create-missing")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"nickname":"","gender":"male"}"#))
                .expect("character create request"),
        )
        .await
        .expect("character create response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json, serde_json::json!({
        "success": false,
        "message": "道号和性别不能为空",
    }));
}

#[tokio::test]
async fn character_create_rejects_invalid_gender() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(12),
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
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/create")
                .header("authorization", "Bearer token-create-invalid-gender")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"nickname":"青云子","gender":"other"}"#))
                .expect("character create request"),
        )
        .await
        .expect("character create response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json, serde_json::json!({
        "success": false,
        "message": "性别参数错误",
    }));
}

#[tokio::test]
async fn character_create_returns_duplicate_character_failure() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(13),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: false,
            message: "已存在角色，无法重复创建".to_string(),
            data: None,
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/create")
                .header("authorization", "Bearer token-create-duplicate")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"nickname":"青云子","gender":"male"}"#))
                .expect("character create request"),
        )
        .await
        .expect("character create response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(json, serde_json::json!({
        "success": false,
        "message": "已存在角色，无法重复创建",
    }));
}

#[tokio::test]
async fn character_create_returns_node_compatible_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(14),
        },
        character_result: CheckCharacterResult {
            has_character: false,
            character: None,
        },
        create_result: CreateCharacterResult {
            success: true,
            message: "角色创建成功".to_string(),
            data: Some(CharacterRouteData {
                character: Some(sample_character()),
                has_character: true,
            }),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/create")
                .header("authorization", "Bearer token-create-success")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"nickname":"青云子","gender":"male"}"#))
                .expect("character create request"),
        )
        .await
        .expect("character create response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json, serde_json::json!({
        "success": true,
        "message": "角色创建成功",
        "data": {
            "character": {
                "id": 4001,
                "nickname": "青云子",
                "gender": "male",
                "title": "散修",
                "realm": "凡人",
                "sub_realm": serde_json::Value::Null,
                "auto_cast_skills": true,
                "auto_disassemble_enabled": false,
                "auto_disassemble_rules": [],
                "dungeon_no_stamina_cost": false,
                "spirit_stones": 0,
                "silver": 0,
            },
            "hasCharacter": true,
        }
    }));
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
    create_result: CreateCharacterResult,
}

fn build_app_state<T>(services: T) -> AppState
where
    T: AuthRouteServices + 'static,
{
    AppState {
        auth_services: Arc::new(services),
        idle_services: Arc::new(NoopIdleRouteServices),
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
        _current_map_id: String,
        _current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterPositionResult {
                success: false,
                message: "noop".to_string(),
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
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "character-create-route-test-session".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}

#[allow(dead_code)]
fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 4001,
        nickname: "青云子".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "凡人".to_string(),
        sub_realm: None,
        auto_cast_skills: true,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: Some(Vec::new()),
        dungeon_no_stamina_cost: false,
        spirit_stones: 0,
        silver: 0,
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
