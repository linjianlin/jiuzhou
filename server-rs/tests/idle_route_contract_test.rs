use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult,
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
use jiuzhou_server_rs::edge::http::routes::idle::{
    IdleAutoSkillPolicy, IdleConfigResponseData, IdleConfigUpdateInput, IdleConfigView,
    IdleRouteServices, IdleSessionView, IdleStartInput, IdleStartServiceResult,
    IdleStopServiceResult,
};
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn idle_status_rejects_missing_bearer_header() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/idle/status")
                .body(Body::empty())
                .expect("idle status request"),
        )
        .await
        .expect("idle status response");

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
async fn idle_start_returns_conflict_with_existing_session_id() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices {
            start_result: IdleStartServiceResult::Conflict {
                message: "已有活跃挂机会话".to_string(),
                existing_session_id: "session-existing-1".to_string(),
            },
            ..FakeIdleServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/idle/start")
                .header("authorization", "Bearer token-idle-conflict")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "mapId": "map-1",
                        "roomId": "room-1",
                        "maxDurationMs": 60000,
                        "autoSkillPolicy": { "slots": [] },
                        "targetMonsterDefId": "monster-1",
                        "includePartnerInBattle": true,
                    })
                    .to_string(),
                ))
                .expect("idle start request"),
        )
        .await
        .expect("idle start response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "已有活跃挂机会话",
            "existingSessionId": "session-existing-1",
        })
    );
}

#[tokio::test]
async fn idle_status_returns_null_session_when_no_active_session() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/idle/status")
                .header("authorization", "Bearer token-idle-status")
                .body(Body::empty())
                .expect("idle status request"),
        )
        .await
        .expect("idle status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "session": serde_json::Value::Null,
            }
        })
    );
}

#[tokio::test]
async fn idle_stop_returns_business_failure_when_no_active_session() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/idle/stop")
                .header("authorization", "Bearer token-idle-stop")
                .body(Body::empty())
                .expect("idle stop request"),
        )
        .await
        .expect("idle stop response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "没有活跃的挂机会话",
        })
    );
}

#[tokio::test]
async fn idle_start_returns_success_envelope_when_session_starts() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices {
            start_result: IdleStartServiceResult::Started {
                session_id: "session-started-1".to_string(),
            },
            ..FakeIdleServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/idle/start")
                .header("authorization", "Bearer token-idle-start")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "mapId": "map-1",
                        "roomId": "room-1",
                        "maxDurationMs": 60000,
                        "autoSkillPolicy": { "slots": [] },
                        "targetMonsterDefId": "monster-1",
                        "includePartnerInBattle": true,
                    })
                    .to_string(),
                ))
                .expect("idle start request"),
        )
        .await
        .expect("idle start response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "sessionId": "session-started-1",
            }
        })
    );
}

#[tokio::test]
async fn idle_history_returns_recent_sessions_envelope() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices {
            history_result: vec![sample_idle_session("session-history-1")],
            ..FakeIdleServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/idle/history")
                .header("authorization", "Bearer token-idle-history")
                .body(Body::empty())
                .expect("idle history request"),
        )
        .await
        .expect("idle history response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(
        json["data"]["history"][0]["id"],
        serde_json::json!("session-history-1")
    );
    assert_eq!(
        json["data"]["history"][0]["targetMonsterDefId"],
        serde_json::json!("monster-1")
    );
}

#[tokio::test]
async fn idle_progress_reuses_session_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices {
            progress_result: Some(sample_idle_session("session-progress-1")),
            ..FakeIdleServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/idle/progress")
                .header("authorization", "Bearer token-idle-progress")
                .body(Body::empty())
                .expect("idle progress request"),
        )
        .await
        .expect("idle progress response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(
        json["data"]["session"]["id"],
        serde_json::json!("session-progress-1")
    );
}

#[tokio::test]
async fn idle_history_viewed_returns_ok_envelope() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/idle/history/session-viewed-1/viewed")
                .header("authorization", "Bearer token-idle-history-viewed")
                .body(Body::empty())
                .expect("idle history viewed request"),
        )
        .await
        .expect("idle history viewed response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json, serde_json::json!({ "success": true }));
}

#[tokio::test]
async fn idle_config_returns_default_config_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/idle/config")
                .header("authorization", "Bearer token-idle-config")
                .body(Body::empty())
                .expect("idle config request"),
        )
        .await
        .expect("idle config response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "config": {
                    "mapId": serde_json::Value::Null,
                    "roomId": serde_json::Value::Null,
                    "maxDurationMs": 3_600_000,
                    "autoSkillPolicy": { "slots": [] },
                    "targetMonsterDefId": serde_json::Value::Null,
                    "includePartnerInBattle": true,
                },
                "maxDurationLimitMs": 28_800_000,
                "monthCardActive": false,
            }
        })
    );
}

#[tokio::test]
async fn idle_config_update_returns_ok_envelope() {
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeIdleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/idle/config")
                .header("authorization", "Bearer token-idle-config-update")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "mapId": "map-1",
                        "roomId": "room-1",
                        "maxDurationMs": 60000,
                        "autoSkillPolicy": { "slots": [] },
                        "targetMonsterDefId": "monster-1",
                        "includePartnerInBattle": true,
                    })
                    .to_string(),
                ))
                .expect("idle config update request"),
        )
        .await
        .expect("idle config update response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json, serde_json::json!({ "success": true }));
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

#[derive(Clone)]
struct FakeIdleServices {
    start_result: IdleStartServiceResult,
    status_result: Option<IdleSessionView>,
    stop_result: IdleStopServiceResult,
    history_result: Vec<IdleSessionView>,
    progress_result: Option<IdleSessionView>,
    config_result: IdleConfigResponseData,
}

impl Default for FakeIdleServices {
    fn default() -> Self {
        Self {
            start_result: IdleStartServiceResult::Failure {
                message: "挂机功能暂不可用".to_string(),
            },
            status_result: None,
            stop_result: IdleStopServiceResult::Failure {
                message: "没有活跃的挂机会话".to_string(),
            },
            history_result: Vec::new(),
            progress_result: None,
            config_result: IdleConfigResponseData {
                config: IdleConfigView {
                    map_id: None,
                    room_id: None,
                    max_duration_ms: 3_600_000,
                    auto_skill_policy: IdleAutoSkillPolicy { slots: Vec::new() },
                    target_monster_def_id: None,
                    include_partner_in_battle: true,
                },
                max_duration_limit_ms: 28_800_000,
                month_card_active: false,
            },
        }
    }
}

fn build_app_state<T, I>(services: T, idle_services: I) -> AppState
where
    T: AuthRouteServices + 'static,
    I: IdleRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices,
        ),
        auth_services: Arc::new(services),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
        game_services: Arc::new(jiuzhou_server_rs::edge::http::routes::game::NoopGameRouteServices),
        idle_services: Arc::new(idle_services),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        team_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices,
        ),
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
        team_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices,
        ),
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

impl IdleRouteServices for FakeIdleServices {
    fn start_idle_session<'a>(
        &'a self,
        _character_id: i64,
        _user_id: i64,
        _input: IdleStartInput,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStartServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.start_result.clone()) })
    }

    fn get_active_idle_session<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.status_result.clone()) })
    }

    fn stop_idle_session<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleStopServiceResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.stop_result.clone()) })
    }

    fn get_idle_history<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.history_result.clone()) })
    }

    fn mark_idle_history_viewed<'a>(
        &'a self,
        _character_id: i64,
        _session_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
    }

    fn get_idle_progress<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<Option<IdleSessionView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.progress_result.clone()) })
    }

    fn get_idle_config<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<IdleConfigResponseData, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.config_result.clone()) })
    }

    fn update_idle_config<'a>(
        &'a self,
        _character_id: i64,
        _input: IdleConfigUpdateInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
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
        auto_cast_skills: true,
        auto_disassemble_enabled: true,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
        spirit_stones: 88,
        silver: 666,
    }
}

fn sample_idle_session(session_id: &str) -> IdleSessionView {
    IdleSessionView {
        id: session_id.to_string(),
        character_id: 3001,
        status: "active".to_string(),
        map_id: "map-1".to_string(),
        room_id: "room-1".to_string(),
        max_duration_ms: 60_000,
        total_battles: 3,
        win_count: 2,
        lose_count: 1,
        total_exp: 120,
        total_silver: 88,
        bag_full_flag: false,
        started_at: "2026-04-10 00:00:00+08".to_string(),
        ended_at: None,
        viewed_at: None,
        target_monster_def_id: Some("monster-1".to_string()),
        target_monster_name: Some("monster-1".to_string()),
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
                session_token: "idle-route-test-session".to_string(),
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
