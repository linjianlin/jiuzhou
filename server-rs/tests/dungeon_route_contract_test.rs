use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
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
async fn dungeon_categories_route_keeps_node_order_and_labels() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/dungeon/categories")
                .body(Body::empty())
                .expect("dungeon categories request"),
        )
        .await
        .expect("dungeon categories response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["categories"].as_array().map(Vec::len), Some(5));
    assert_eq!(
        json["data"]["categories"][0]["type"],
        serde_json::json!("material")
    );
    assert_eq!(
        json["data"]["categories"][0]["label"],
        serde_json::json!("材料秘境")
    );
    assert!(json["data"]["categories"][0]["count"].is_number());
    assert_eq!(
        json["data"]["categories"][2]["type"],
        serde_json::json!("trial")
    );
}

#[tokio::test]
async fn dungeon_list_route_filters_by_type_and_keyword() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/dungeon/list?type=trial&q=%E7%8B%BC")
                .body(Body::empty())
                .expect("dungeon list request"),
        )
        .await
        .expect("dungeon list response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    let dungeons = json["data"]["dungeons"].as_array().expect("dungeons array");
    assert!(dungeons
        .iter()
        .all(|entry| entry["type"] == serde_json::json!("trial")));
    assert!(dungeons
        .iter()
        .any(|entry| entry["id"] == serde_json::json!("dungeon-qiqi-wolf-den")));
}

#[tokio::test]
async fn dungeon_preview_route_returns_stage_and_drop_preview() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/dungeon/preview/dungeon-qiqi-wolf-den?rank=1")
                .body(Body::empty())
                .expect("dungeon preview request"),
        )
        .await
        .expect("dungeon preview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(
        json["data"]["dungeon"]["id"],
        serde_json::json!("dungeon-qiqi-wolf-den")
    );
    assert_eq!(
        json["data"]["difficulty"]["difficulty_rank"],
        serde_json::json!(1)
    );
    assert_eq!(
        json["data"]["stages"][0]["name"],
        serde_json::json!("林间伏影")
    );
    assert_eq!(
        json["data"]["stages"][0]["waves"][0]["monsters"][0]["name"],
        serde_json::json!("灰狼")
    );
    assert!(json["data"]["drop_items"]
        .as_array()
        .is_some_and(|entries| !entries.is_empty()));
}

#[tokio::test]
async fn dungeon_preview_route_returns_404_when_dungeon_missing() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/dungeon/preview/not-exists")
                .body(Body::empty())
                .expect("dungeon preview missing request"),
        )
        .await
        .expect("dungeon preview missing response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "秘境不存在",
        })
    );
}

fn build_app_state() -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(FakeAuthServices::default()),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(NoopTimeRouteServices),
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

#[derive(Default)]
struct FakeAuthServices;

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
                captcha_id: "captcha-dungeon".to_string(),
                image_data: "data:image/svg+xml;base64,dungeon".to_string(),
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
                message: "创建成功".to_string(),
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
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "session-token".to_string(),
                character_id: Some(1),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json = serde_json::from_slice(&body).expect("response json");
    (status, json)
}
