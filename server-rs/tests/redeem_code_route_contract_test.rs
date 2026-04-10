use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, RenameCharacterWithCardResult,
    UpdateCharacterPositionResult, UpdateCharacterSettingResult,
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
use jiuzhou_server_rs::edge::http::routes::redeem_code::{
    RedeemCodeRewardView, RedeemCodeRouteServices, RedeemCodeSuccessData,
};
use jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    auth_failed_failure, GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn redeem_code_route_returns_success_result() {
    let redeem_services = FakeRedeemCodeRouteServices::success();
    let recorded_request_ip = redeem_services.recorded_request_ip.clone();
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        redeem_services,
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/redeem-code/redeem")
                .method("POST")
                .header("authorization", "Bearer redeem-token")
                .header("content-type", "application/json")
                .header("x-forwarded-for", "203.0.113.8, 10.0.0.1")
                .body(Body::from(
                    serde_json::json!({ "code": "jzgift" }).to_string(),
                ))
                .expect("redeem request"),
        )
        .await
        .expect("redeem response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "兑换成功，奖励已通过邮件发放",
            "data": {
                "code": "JZGIFT",
                "rewards": [
                    { "type": "silver", "amount": 888 },
                    { "type": "item", "itemDefId": "item_spirit_pill", "quantity": 2, "itemName": "聚灵丹" }
                ]
            }
        })
    );
    assert_eq!(
        recorded_request_ip
            .lock()
            .expect("request ip lock")
            .clone()
            .as_deref(),
        Some("203.0.113.8")
    );
}

#[tokio::test]
async fn redeem_code_route_returns_business_failure_for_blank_code() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeRedeemCodeRouteServices::success(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/redeem-code/redeem")
                .method("POST")
                .header("authorization", "Bearer redeem-token")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "code": "   " }).to_string()))
                .expect("redeem request"),
        )
        .await
        .expect("redeem response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "兑换码不能为空",
        })
    );
}

#[tokio::test]
async fn redeem_code_route_returns_404_when_character_missing() {
    let app = build_router(build_app_state(
        FakeAuthServices::without_character(),
        FakeRedeemCodeRouteServices::success(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/redeem-code/redeem")
                .method("POST")
                .header("authorization", "Bearer redeem-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "code": "JZGIFT" }).to_string(),
                ))
                .expect("redeem request"),
        )
        .await
        .expect("redeem response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "角色不存在",
        })
    );
}

#[tokio::test]
async fn redeem_code_route_returns_401_when_session_invalid() {
    let app = build_router(build_app_state(
        FakeAuthServices::invalid_session(),
        FakeRedeemCodeRouteServices::success(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/redeem-code/redeem")
                .method("POST")
                .header("authorization", "Bearer redeem-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "code": "JZGIFT" }).to_string(),
                ))
                .expect("redeem request"),
        )
        .await
        .expect("redeem response");

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

fn build_app_state<TAuth, TRedeem>(auth_services: TAuth, redeem_code_services: TRedeem) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TRedeem: RedeemCodeRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices),
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
        month_card_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices,
        ),

        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        realm_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices,
        ),

        redeem_code_services: Arc::new(redeem_code_services),
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

struct FakeRedeemCodeRouteServices {
    recorded_request_ip: Arc<Mutex<Option<String>>>,
}

impl FakeRedeemCodeRouteServices {
    fn success() -> Self {
        Self {
            recorded_request_ip: Arc::new(Mutex::new(None)),
        }
    }
}

impl RedeemCodeRouteServices for FakeRedeemCodeRouteServices {
    fn redeem_code<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        code: String,
        request_ip: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            *self.recorded_request_ip.lock().expect("request ip lock") = Some(request_ip);
            Ok(ServiceResultResponse::new(
                true,
                Some("兑换成功，奖励已通过邮件发放".to_string()),
                Some(RedeemCodeSuccessData {
                    code: code.trim().to_uppercase(),
                    rewards: vec![
                        RedeemCodeRewardView::Silver { amount: 888 },
                        RedeemCodeRewardView::Item {
                            item_def_id: "item_spirit_pill".to_string(),
                            quantity: 2,
                            item_name: Some("聚灵丹".to_string()),
                            item_icon: None,
                        },
                    ],
                }),
            ))
        })
    }
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

impl FakeAuthServices {
    fn with_character() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        }
    }

    fn without_character() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: false,
                character: None,
            },
        }
    }

    fn invalid_session() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            },
            character_result: CheckCharacterResult {
                has_character: false,
                character: None,
            },
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
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
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
        let result = self.character_result.clone();
        Box::pin(async move { Ok(result) })
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
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        _current_map_id: String,
        _current_room_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn rename_character_with_card<'a>(
        &'a self,
        _user_id: i64,
        _item_instance_id: i64,
        _nickname: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<RenameCharacterWithCardResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<dyn Future<Output = Result<UpdateCharacterSettingResult, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn get_sign_in_overview<'a>(
        &'a self,
        _user_id: i64,
        _month: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::SignInOverviewData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
    }

    fn do_sign_in<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::DoSignInData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Err(BusinessError::new("未实现")) })
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
        Box::pin(async move { Err(auth_failed_failure()) })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
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
        spirit_stones: 120,
        silver: 888,
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response.into_body().collect().await.expect("collect body");
    let json = serde_json::from_slice::<serde_json::Value>(&body.to_bytes()).expect("parse json");
    (status, json)
}
