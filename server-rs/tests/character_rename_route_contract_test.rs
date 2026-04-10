use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, RenameCharacterWithCardResult,
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
async fn character_rename_with_card_rejects_invalid_item_instance_id() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/renameWithCard")
                .header("authorization", "Bearer token-rename-invalid-item")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"itemInstanceId":"abc","nickname":"青云子"}"#,
                ))
                .expect("character rename request"),
        )
        .await
        .expect("character rename response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "itemInstanceId参数错误",
        })
    );
}

#[tokio::test]
async fn character_rename_with_card_rejects_empty_nickname() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/renameWithCard")
                .header("authorization", "Bearer token-rename-empty-name")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"itemInstanceId":99,"nickname":"   "}"#))
                .expect("character rename request"),
        )
        .await
        .expect("character rename response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "道号不能为空",
        })
    );
}

#[tokio::test]
async fn character_rename_with_card_returns_business_failure_envelope() {
    let app = build_router(build_app_state(FakeAuthServices {
        rename_result: RenameCharacterWithCardResult {
            success: false,
            message: "角色不存在".to_string(),
        },
        ..FakeAuthServices::success()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/renameWithCard")
                .header("authorization", "Bearer token-rename-missing-character")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"itemInstanceId":"101","nickname":"凌霄子"}"#,
                ))
                .expect("character rename request"),
        )
        .await
        .expect("character rename response");

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
async fn character_rename_with_card_returns_success_envelope() {
    let app = build_router(build_app_state(FakeAuthServices::success()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/renameWithCard")
                .header("authorization", "Bearer token-rename-success")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"itemInstanceId":88,"nickname":"凌霄子"}"#))
                .expect("character rename request"),
        )
        .await
        .expect("character rename response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "改名成功",
        })
    );
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
    create_result: CreateCharacterResult,
    update_position_result: UpdateCharacterPositionResult,
    rename_result: RenameCharacterWithCardResult,
}

impl FakeAuthServices {
    fn success() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(41),
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
            rename_result: RenameCharacterWithCardResult {
                success: true,
                message: "改名成功".to_string(),
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

    fn rename_character_with_card<'a>(
        &'a self,
        _user_id: i64,
        _item_instance_id: i64,
        _nickname: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<RenameCharacterWithCardResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(self.rename_result.clone()) })
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
                session_token: "character-rename-route-test-session".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("parse response json");
    (status, json)
}
