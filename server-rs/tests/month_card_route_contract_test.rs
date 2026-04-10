use std::sync::{Arc, Mutex};
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
use jiuzhou_server_rs::edge::http::response::ServiceResultResponse;
use jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices;
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices;
use jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices;
use jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices;
use jiuzhou_server_rs::edge::http::routes::month_card::{
    MonthCardBenefitValuesView, MonthCardClaimDataView, MonthCardRouteServices,
    MonthCardStatusView, MonthCardUseItemDataView,
};
use jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices;
use jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices;
use jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn month_card_routes_require_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeMonthCardRouteServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/monthcard/status")
                .body(Body::empty())
                .expect("monthcard unauth request"),
        )
        .await
        .expect("monthcard unauth response");

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
async fn month_card_status_route_uses_default_month_card_id() {
    let requested_status_ids = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(3201),
        FakeMonthCardRouteServices {
            requested_status_ids: requested_status_ids.clone(),
            status_result: ServiceResultResponse::new(
                true,
                Some("获取成功".to_string()),
                Some(MonthCardStatusView {
                    month_card_id: "monthcard-001".to_string(),
                    name: "修行月卡".to_string(),
                    description: Some("有效期30天".to_string()),
                    duration_days: 30,
                    daily_spirit_stones: 10_000,
                    price_spirit_stones: 0,
                    benefits: MonthCardBenefitValuesView {
                        cooldown_reduction_rate: 0.1,
                        stamina_recovery_rate: 0.1,
                        fuyuan_bonus: 20,
                        idle_max_duration_hours: 12,
                    },
                    active: true,
                    expire_at: Some("2026-05-10T00:00:00.000Z".to_string()),
                    days_left: 30,
                    today: "2026-04-10".to_string(),
                    last_claim_date: None,
                    can_claim: true,
                    spirit_stones: 88_888,
                }),
            ),
            ..FakeMonthCardRouteServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/monthcard/status")
                .header("authorization", "Bearer monthcard-status-token")
                .body(Body::empty())
                .expect("monthcard status request"),
        )
        .await
        .expect("monthcard status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_status_ids
            .lock()
            .expect("requested status ids")
            .as_slice(),
        &["monthcard-001".to_string()]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {
                "monthCardId": "monthcard-001",
                "name": "修行月卡",
                "description": "有效期30天",
                "durationDays": 30,
                "dailySpiritStones": 10000,
                "priceSpiritStones": 0,
                "benefits": {
                    "cooldownReductionRate": 0.1,
                    "staminaRecoveryRate": 0.1,
                    "fuyuanBonus": 20,
                    "idleMaxDurationHours": 12
                },
                "active": true,
                "expireAt": "2026-05-10T00:00:00.000Z",
                "daysLeft": 30,
                "today": "2026-04-10",
                "lastClaimDate": null,
                "canClaim": true,
                "spiritStones": 88888
            }
        })
    );
}

#[tokio::test]
async fn month_card_use_item_route_accepts_string_item_instance_id() {
    let requested_use_item = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(3202),
        FakeMonthCardRouteServices {
            requested_use_item: requested_use_item.clone(),
            use_item_result: ServiceResultResponse::new(
                true,
                Some("使用成功".to_string()),
                Some(MonthCardUseItemDataView {
                    month_card_id: "monthcard-001".to_string(),
                    expire_at: "2026-05-10T00:00:00.000Z".to_string(),
                    days_left: 30,
                }),
            ),
            ..FakeMonthCardRouteServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/monthcard/use-item")
                .header("authorization", "Bearer monthcard-use-item-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "monthCardId": "monthcard-001",
                        "itemInstanceId": "42"
                    })
                    .to_string(),
                ))
                .expect("monthcard use-item request"),
        )
        .await
        .expect("monthcard use-item response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_use_item
            .lock()
            .expect("requested use item")
            .as_slice(),
        &[("monthcard-001".to_string(), Some(42))]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "使用成功",
            "data": {
                "monthCardId": "monthcard-001",
                "expireAt": "2026-05-10T00:00:00.000Z",
                "daysLeft": 30
            }
        })
    );
}

#[tokio::test]
async fn month_card_claim_route_preserves_business_failure_shape() {
    let requested_claim_ids = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::authorized(3203),
        FakeMonthCardRouteServices {
            requested_claim_ids: requested_claim_ids.clone(),
            claim_result: ServiceResultResponse::new(false, Some("今日已领取".to_string()), None),
            ..FakeMonthCardRouteServices::default()
        },
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/monthcard/claim")
                .header("authorization", "Bearer monthcard-claim-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "monthCardId": "monthcard-001"
                    })
                    .to_string(),
                ))
                .expect("monthcard claim request"),
        )
        .await
        .expect("monthcard claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        requested_claim_ids
            .lock()
            .expect("requested claim ids")
            .as_slice(),
        &["monthcard-001".to_string()]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "今日已领取"
        })
    );
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

impl FakeAuthServices {
    fn authorized(user_id: i64) -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(user_id),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        }
    }
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        }
    }
}

#[derive(Clone)]
struct FakeMonthCardRouteServices {
    requested_status_ids: Arc<Mutex<Vec<String>>>,
    requested_use_item: Arc<Mutex<Vec<(String, Option<i64>)>>>,
    requested_claim_ids: Arc<Mutex<Vec<String>>>,
    status_result: ServiceResultResponse<MonthCardStatusView>,
    use_item_result: ServiceResultResponse<MonthCardUseItemDataView>,
    claim_result: ServiceResultResponse<MonthCardClaimDataView>,
}

impl Default for FakeMonthCardRouteServices {
    fn default() -> Self {
        Self {
            requested_status_ids: Arc::new(Mutex::new(Vec::new())),
            requested_use_item: Arc::new(Mutex::new(Vec::new())),
            requested_claim_ids: Arc::new(Mutex::new(Vec::new())),
            status_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
            use_item_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
            claim_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
        }
    }
}

fn build_app_state<TAuth, TMonthCard>(
    auth_services: TAuth,
    month_card_services: TMonthCard,
) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TMonthCard: MonthCardRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(NoopAfdianRouteServices),
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
        info_services: Arc::new(NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(NoopInventoryRouteServices),
        month_card_services: Arc::new(month_card_services),
        rank_services: Arc::new(NoopRankRouteServices),
        realm_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices,
        ),
        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        time_services: Arc::new(NoopTimeRouteServices),
        title_services: Arc::new(NoopTitleRouteServices),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

impl MonthCardRouteServices for FakeMonthCardRouteServices {
    fn get_status<'a>(
        &'a self,
        _user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MonthCardStatusView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requested_status_ids
                .lock()
                .expect("requested status ids")
                .push(month_card_id);
            Ok(self.status_result.clone())
        })
    }

    fn use_item<'a>(
        &'a self,
        _user_id: i64,
        month_card_id: String,
        item_instance_id: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardUseItemDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requested_use_item
                .lock()
                .expect("requested use item")
                .push((month_card_id, item_instance_id));
            Ok(self.use_item_result.clone())
        })
    }

    fn claim<'a>(
        &'a self,
        _user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardClaimDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requested_claim_ids
                .lock()
                .expect("requested claim ids")
                .push(month_card_id);
            Ok(self.claim_result.clone())
        })
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
                captcha_id: "monthcard-captcha".to_string(),
                image_data: "data:image/svg+xml;base64,bW9udGhjYXJk".to_string(),
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
                session_token: "monthcard-route-test-session".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}

struct FakeGameSocketServices;

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 9101,
        nickname: "月卡测试".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "炼气期".to_string(),
        sub_realm: Some("炼气境一层".to_string()),
        auto_cast_skills: true,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
        spirit_stones: 88_888,
        silver: 66_666,
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect response body")
        .to_bytes();
    let json = serde_json::from_slice(&body).expect("response json");
    (status, json)
}
