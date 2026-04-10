use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
    UpdateCharacterSettingResult,
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
async fn character_update_auto_cast_skills_returns_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(31),
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
        update_setting_result: UpdateCharacterSettingResult {
            success: true,
            message: "设置已保存".to_string(),
        },
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updateAutoCastSkills")
                .header("authorization", "Bearer token-auto-cast")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":true}"#))
                .expect("character update auto cast request"),
        )
        .await
        .expect("character update auto cast response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "设置已保存",
        })
    );
}

#[tokio::test]
async fn character_update_auto_disassemble_rejects_non_array_rules() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updateAutoDisassemble")
                .header("authorization", "Bearer token-auto-disassemble-shape")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":true,"rules":{"bad":true}}"#))
                .expect("character update auto disassemble request"),
        )
        .await
        .expect("character update auto disassemble response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "rules参数错误，需为数组",
        })
    );
}

#[tokio::test]
async fn character_update_auto_disassemble_rejects_non_object_rule_items() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updateAutoDisassemble")
                .header("authorization", "Bearer token-auto-disassemble-item")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":true,"rules":[1]}"#))
                .expect("character update auto disassemble request"),
        )
        .await
        .expect("character update auto disassemble response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "rules参数错误，规则项需为对象",
        })
    );
}

#[tokio::test]
async fn character_update_auto_disassemble_returns_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updateAutoDisassemble")
                .header("authorization", "Bearer token-auto-disassemble-success")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"enabled":true,"rules":[{"categories":["equipment"],"maxQualityRank":2}]}"#,
                ))
                .expect("character update auto disassemble request"),
        )
        .await
        .expect("character update auto disassemble response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "设置已保存",
        })
    );
}

#[tokio::test]
async fn character_update_dungeon_no_stamina_cost_returns_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/updateDungeonNoStaminaCost")
                .header("authorization", "Bearer token-no-stamina")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"enabled":false}"#))
                .expect("character update dungeon no stamina cost request"),
        )
        .await
        .expect("character update dungeon no stamina cost response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "设置已保存",
        })
    );
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
    create_result: CreateCharacterResult,
    update_position_result: UpdateCharacterPositionResult,
    update_setting_result: UpdateCharacterSettingResult,
}

impl FakeAuthServices {
    fn success() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(32),
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
            update_setting_result: UpdateCharacterSettingResult {
                success: true,
                message: "设置已保存".to_string(),
            },
        }
    }
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
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
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
        Box::pin(async move { Ok(self.update_position_result.clone()) })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(self.update_setting_result.clone()) })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(self.update_setting_result.clone()) })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(self.update_setting_result.clone()) })
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
                session_token: "character-settings-route-test-session".to_string(),
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
