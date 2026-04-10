use std::collections::HashMap;
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
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use jiuzhou_server_rs::runtime::projection::service::{
    build_online_projection_registry_from_snapshot, OnlineProjectionIndexKey,
    OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use tower::ServiceExt;

#[tokio::test]
async fn arena_routes_require_character_authentication() {
    let app = build_router(build_app_state(FakeAuthServices::default(), None));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/arena/status")
                .body(Body::empty())
                .expect("arena status unauth request"),
        )
        .await
        .expect("arena status unauth response");

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

#[tokio::test]
async fn arena_status_route_returns_runtime_projection_snapshot() {
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(77, 9001),
        Some(build_runtime_services().await),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/arena/status")
                .header("authorization", "Bearer arena-status-token")
                .body(Body::empty())
                .expect("arena status request"),
        )
        .await
        .expect("arena status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "score": 1288,
                "winCount": 12,
                "loseCount": 3,
                "todayUsed": 5,
                "todayLimit": 20,
                "todayRemaining": 15
            }
        })
    );
}

#[tokio::test]
async fn arena_opponents_route_sorts_by_nearest_score_gap_and_clamps_limit() {
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(77, 9001),
        Some(build_runtime_services().await),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/arena/opponents?limit=2")
                .header("authorization", "Bearer arena-opponents-token")
                .body(Body::empty())
                .expect("arena opponents request"),
        )
        .await
        .expect("arena opponents response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": [
                {
                    "id": 9002,
                    "name": "乙",
                    "realm": "炼气期",
                    "power": 9527,
                    "score": 1210
                },
                {
                    "id": 9003,
                    "name": "丙",
                    "realm": "筑基期",
                    "power": 18888,
                    "score": 1505
                }
            ]
        })
    );
}

#[tokio::test]
async fn arena_records_route_returns_projection_records_with_node_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(77, 9001),
        Some(build_runtime_services().await),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/arena/records?limit=1")
                .header("authorization", "Bearer arena-records-token")
                .body(Body::empty())
                .expect("arena records request"),
        )
        .await
        .expect("arena records response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": [
                {
                    "id": "arena-battle-1",
                    "ts": 1710000000000_i64,
                    "opponentName": "乙",
                    "opponentRealm": "炼气期",
                    "opponentPower": 9527,
                    "result": "win",
                    "deltaScore": 18,
                    "scoreAfter": 1288
                }
            ]
        })
    );
}

#[tokio::test]
async fn arena_status_route_preserves_projection_missing_failure_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(77, 9009),
        Some(build_runtime_services().await),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/arena/status")
                .header("authorization", "Bearer arena-missing-token")
                .body(Body::empty())
                .expect("arena missing request"),
        )
        .await
        .expect("arena missing response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "竞技场投影不存在"
        })
    );
}

async fn build_runtime_services() -> jiuzhou_server_rs::bootstrap::app::SharedRuntimeServices {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");
    let online_projection_registry = build_online_projection_registry_from_snapshot(&recovered)
        .expect("build online projection registry");

    new_shared_runtime_services(RuntimeServicesState {
        online_projection_registry,
        ..RuntimeServicesState::default()
    })
}

fn build_recovery_source() -> RecoverySourceData {
    RecoverySourceData::default()
        .with_string(
            OnlineProjectionRedisKey::character(9001).into_string(),
            r#"{
                "characterId":9001,
                "userId":77,
                "computed":{"id":9001,"user_id":77,"nickname":"甲","realm":"炼气期","power":12345},
                "loadout":{"weapon":"sword"},
                "activePartner":null,
                "teamId":null,
                "isTeamLeader":false
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::character(9002).into_string(),
            r#"{
                "characterId":9002,
                "userId":88,
                "computed":{"id":9002,"user_id":88,"nickname":"乙","realm":"炼气期","power":9527},
                "loadout":{"weapon":"blade"},
                "activePartner":null,
                "teamId":null,
                "isTeamLeader":false
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::character(9003).into_string(),
            r#"{
                "characterId":9003,
                "userId":99,
                "computed":{"id":9003,"user_id":99,"nickname":"丙","realm":"筑基期","power":18888},
                "loadout":{"weapon":"fan"},
                "activePartner":null,
                "teamId":null,
                "isTeamLeader":false
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::arena(9001).into_string(),
            r#"{
                "characterId":9001,
                "score":1288,
                "winCount":12,
                "loseCount":3,
                "todayUsed":5,
                "todayLimit":20,
                "todayRemaining":15,
                "records":[
                    {
                        "id":"arena-battle-1",
                        "ts":1710000000000,
                        "opponentName":"乙",
                        "opponentRealm":"炼气期",
                        "opponentPower":9527,
                        "result":"win",
                        "deltaScore":18,
                        "scoreAfter":1288
                    },
                    {
                        "id":"arena-battle-2",
                        "ts":1710000005000,
                        "opponentName":"丙",
                        "opponentRealm":"筑基期",
                        "opponentPower":18888,
                        "result":"lose",
                        "deltaScore":-12,
                        "scoreAfter":1276
                    }
                ]
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::arena(9002).into_string(),
            r#"{
                "characterId":9002,
                "score":1210,
                "winCount":8,
                "loseCount":6,
                "todayUsed":4,
                "todayLimit":20,
                "todayRemaining":16,
                "records":[]
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::arena(9003).into_string(),
            r#"{
                "characterId":9003,
                "score":1505,
                "winCount":20,
                "loseCount":9,
                "todayUsed":7,
                "todayLimit":20,
                "todayRemaining":13,
                "records":[]
            }"#,
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001", "9002", "9003"],
        )
        .with_set(
            OnlineProjectionIndexKey::arena().into_string(),
            ["9001", "9002", "9003"],
        )
}

fn build_app_state(
    auth_services: FakeAuthServices,
    runtime_services: Option<jiuzhou_server_rs::bootstrap::app::SharedRuntimeServices>,
) -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
        game_services: Arc::new(jiuzhou_server_rs::edge::http::routes::game::NoopGameRouteServices),
        idle_services: Arc::new(NoopIdleRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        mail_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::mail::NoopMailRouteServices),
        month_card_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices,
        ),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        realm_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices,
        ),
        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        team_services: Arc::new(jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: runtime_services
            .unwrap_or_else(|| new_shared_runtime_services(RuntimeServicesState::default())),
    }
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_id: i64,
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            },
            character_id: 0,
        }
    }
}

impl FakeAuthServices {
    fn authorized(user_id: i64, character_id: i64) -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(user_id),
            },
            character_id,
        }
    }
}

impl AuthRouteServices for FakeAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "captcha".to_string(),
                image_data: "data:image/svg+xml;base64,stub".to_string(),
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
        Box::pin(async move {
            if self.character_id <= 0 {
                return Ok(CheckCharacterResult {
                    has_character: false,
                    character: None,
                });
            }

            Ok(CheckCharacterResult {
                has_character: true,
                character: Some(CharacterBasicInfo {
                    id: self.character_id,
                    nickname: "测试角色".to_string(),
                    gender: "male".to_string(),
                    title: "无名修士".to_string(),
                    realm: "炼气期".to_string(),
                    sub_realm: None,
                    auto_cast_skills: false,
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
                success: false,
                message: "未实现".to_string(),
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

struct FakeGameSocketServices;

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
                message: "未实现".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("parse response json");
    (status, json)
}
