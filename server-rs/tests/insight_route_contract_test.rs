use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
    UpdateCharacterSettingResult,
};
use jiuzhou_server_rs::bootstrap::app::{
    build_router, new_shared_runtime_services, AppState, RuntimeServicesState,
};
use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::edge::http::error::BusinessError;
use jiuzhou_server_rs::edge::http::response::ServiceResultResponse;
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices;
use jiuzhou_server_rs::edge::http::routes::insight::{
    InsightInjectResultView, InsightOverviewView, InsightRouteServices,
};
use jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn insight_overview_route_returns_send_result_payload() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeInsightServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/insight/overview")
                .header("authorization", "Bearer insight-token")
                .body(Body::empty())
                .expect("insight overview request"),
        )
        .await
        .expect("insight overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("ok"));
    assert_eq!(json["data"]["currentLevel"], serde_json::json!(12));
    assert_eq!(json["data"]["currentBonusPct"], serde_json::json!(0.006));
}

#[tokio::test]
async fn insight_inject_route_accepts_numeric_string_exp() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeInsightServices::with_calls(calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/insight/inject")
                .method("POST")
                .header("authorization", "Bearer insight-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "exp": "500000" }).to_string(),
                ))
                .expect("insight inject request"),
        )
        .await
        .expect("insight inject response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["message"], serde_json::json!("悟道成功"));
    assert_eq!(
        calls.lock().expect("calls").as_slice(),
        &[RecordedCall::Inject {
            user_id: 7,
            exp: 500_000,
        }]
    );
}

#[tokio::test]
async fn insight_inject_route_rejects_invalid_exp_before_service() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeInsightServices::with_calls(calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/insight/inject")
                .method("POST")
                .header("authorization", "Bearer insight-token")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "exp": 0.5 }).to_string()))
                .expect("insight invalid inject request"),
        )
        .await
        .expect("insight invalid inject response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "exp 参数无效，需为大于 0 的整数"
        })
    );
    assert!(calls.lock().expect("calls").is_empty());
}

#[tokio::test]
async fn insight_routes_require_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeInsightServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/insight/overview")
                .body(Body::empty())
                .expect("insight unauthorized request"),
        )
        .await
        .expect("insight unauthorized response");

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
async fn insight_overview_route_preserves_business_failure_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeInsightServices::failure(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/insight/overview")
                .header("authorization", "Bearer insight-token")
                .body(Body::empty())
                .expect("insight failure request"),
        )
        .await
        .expect("insight failure response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "角色不存在"
        })
    );
}

fn build_app_state<TAuth, TInsight>(auth_services: TAuth, insight_services: TInsight) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TInsight: InsightRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        insight_services: Arc::new(insight_services),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
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
        time_services: Arc::new(NoopTimeRouteServices),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RecordedCall {
    Inject { user_id: i64, exp: i64 },
}

#[derive(Default)]
struct FakeInsightServices {
    calls: Arc<Mutex<Vec<RecordedCall>>>,
    failure_mode: bool,
}

impl FakeInsightServices {
    fn with_calls(calls: Arc<Mutex<Vec<RecordedCall>>>) -> Self {
        Self {
            calls,
            failure_mode: false,
        }
    }

    fn failure() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            failure_mode: true,
        }
    }
}

impl InsightRouteServices for FakeInsightServices {
    fn get_overview<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<InsightOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            if self.failure_mode {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("角色不存在".to_string()),
                    None,
                ));
            }
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(InsightOverviewView {
                    unlocked: true,
                    unlock_realm: "凡人".to_string(),
                    current_level: 12,
                    current_progress_exp: 250_000,
                    current_bonus_pct: 0.006,
                    next_level_cost_exp: 500_000,
                    character_exp: 1_500_000,
                    cost_stage_levels: 50,
                    cost_stage_base_exp: 500_000,
                    bonus_pct_per_level: 0.0005,
                }),
            ))
        })
    }

    fn inject_exp<'a>(
        &'a self,
        user_id: i64,
        exp: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightInjectResultView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("calls")
                .push(RecordedCall::Inject { user_id, exp });
            Ok(ServiceResultResponse::new(
                true,
                Some("悟道成功".to_string()),
                Some(InsightInjectResultView {
                    before_level: 12,
                    after_level: 13,
                    after_progress_exp: 0,
                    actual_injected_levels: 1,
                    spent_exp: 500_000,
                    remaining_exp: 1_000_000,
                    gained_bonus_pct: 0.0005,
                    current_bonus_pct: 0.0065,
                }),
            ))
        })
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
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::NOT_IMPLEMENTED,
            ))
        })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::NOT_IMPLEMENTED,
            ))
        })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::NOT_IMPLEMENTED,
            ))
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
                user_id: Some(7),
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
                    id: 1001,
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
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::NOT_IMPLEMENTED,
            ))
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
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::NOT_IMPLEMENTED,
            ))
        })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterSettingResult {
                success: false,
                message: "未实现".to_string(),
            })
        })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterSettingResult {
                success: false,
                message: "未实现".to_string(),
            })
        })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(UpdateCharacterSettingResult {
                success: false,
                message: "未实现".to_string(),
            })
        })
    }

    fn rename_character_with_card<'a>(
        &'a self,
        _user_id: i64,
        _item_instance_id: i64,
        _nickname: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult {
                    success: false,
                    message: "未实现".to_string(),
                },
            )
        })
    }

    fn get_phone_binding_status<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::account::service::PhoneBindingStatusDto,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::account::service::PhoneBindingStatusDto {
                    enabled: false,
                    is_bound: false,
                    masked_phone_number: None,
                },
            )
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
            Err(GameSocketAuthFailure {
                event: "game:error",
                message: "未实现".to_string(),
                disconnect_current: false,
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
    let json = serde_json::from_slice(&bytes).expect("parse json");
    (status, json)
}
