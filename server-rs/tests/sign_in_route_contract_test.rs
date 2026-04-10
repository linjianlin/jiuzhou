use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::application::sign_in::service::{
    DoSignInData, SignInOverviewData, SignInRecordDto,
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
async fn sign_in_overview_route_uses_current_month_when_query_missing() {
    let requested_months = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(2001),
        },
        overview_result: ServiceResultResponse::new(
            true,
            Some("获取成功".to_string()),
            Some(SignInOverviewData {
                today: "2026-04-10".to_string(),
                signed_today: true,
                month: current_month(),
                month_signed_count: 1,
                streak_days: 5,
                records: [(
                    "2026-04-10".to_string(),
                    SignInRecordDto {
                        date: "2026-04-10".to_string(),
                        signed_at: "2026-04-10T08:00:00.000Z".to_string(),
                        reward: 1900,
                        is_holiday: false,
                        holiday_name: None,
                    },
                )]
                .into_iter()
                .collect(),
            }),
        ),
        do_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
        requested_months: requested_months.clone(),
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/signin/overview")
                .header("authorization", "Bearer signin-token")
                .body(Body::empty())
                .expect("signin overview request"),
        )
        .await
        .expect("signin overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_months
            .lock()
            .expect("requested months")
            .as_slice(),
        &[current_month()]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {
                "today": "2026-04-10",
                "signedToday": true,
                "month": current_month(),
                "monthSignedCount": 1,
                "streakDays": 5,
                "records": {
                    "2026-04-10": {
                        "date": "2026-04-10",
                        "signedAt": "2026-04-10T08:00:00.000Z",
                        "reward": 1900,
                        "isHoliday": false,
                        "holidayName": null
                    }
                }
            }
        })
    );
}

#[tokio::test]
async fn sign_in_routes_require_authentication() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/signin/overview")
                .body(Body::empty())
                .expect("signin unauth request"),
        )
        .await
        .expect("signin unauth response");

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
async fn sign_in_do_route_preserves_business_failure_shape() {
    let app = build_router(build_app_state(FakeAuthServices {
        verify_result: VerifyTokenAndSessionResult {
            valid: true,
            kicked: false,
            user_id: Some(2002),
        },
        overview_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
        do_result: ServiceResultResponse::new(
            false,
            Some("角色不存在，无法签到".to_string()),
            None,
        ),
        requested_months: Arc::new(Mutex::new(Vec::new())),
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/signin/do")
                .header("authorization", "Bearer signin-do-token")
                .body(Body::empty())
                .expect("signin do request"),
        )
        .await
        .expect("signin do response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "角色不存在，无法签到"
        })
    );
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    overview_result: ServiceResultResponse<SignInOverviewData>,
    do_result: ServiceResultResponse<DoSignInData>,
    requested_months: Arc<Mutex<Vec<String>>>,
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            },
            overview_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
            do_result: ServiceResultResponse::new(false, Some("未使用".to_string()), None),
            requested_months: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

fn build_app_state(auth_services: FakeAuthServices) -> AppState {
    AppState {
        afdian_services: Arc::new(NoopAfdianRouteServices),
        auth_services: Arc::new(auth_services),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        info_services: Arc::new(NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(NoopInventoryRouteServices),
        month_card_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices),

        rank_services: Arc::new(NoopRankRouteServices),
        realm_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices),

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
                StatusCode::INTERNAL_SERVER_ERROR,
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
                StatusCode::INTERNAL_SERVER_ERROR,
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
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn verify_token_and_session<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<Box<dyn Future<Output = VerifyTokenAndSessionResult> + Send + 'a>> {
        let result = self.verify_result.clone();
        Box::pin(async move { result })
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

    fn get_sign_in_overview<'a>(
        &'a self,
        _user_id: i64,
        month: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<SignInOverviewData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let requested_months = self.requested_months.clone();
        let result = self.overview_result.clone();
        Box::pin(async move {
            requested_months
                .lock()
                .expect("record requested month")
                .push(month);
            Ok(result)
        })
    }

    fn do_sign_in<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<DoSignInData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let result = self.do_result.clone();
        Box::pin(async move { Ok(result) })
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
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "signin-route-test-session".to_string(),
                character_id: Some(1),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn current_month() -> String {
    use chrono::Datelike;

    let now = chrono::Local::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json = serde_json::from_slice::<serde_json::Value>(&body).expect("json body");
    (status, json)
}

#[allow(dead_code)]
fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 1,
        nickname: "测试角色".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "凡人".to_string(),
        sub_realm: None,
        auto_cast_skills: false,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: Some(Vec::new()),
        dungeon_no_stamina_cost: false,
        spirit_stones: 0,
        silver: 0,
    }
}
