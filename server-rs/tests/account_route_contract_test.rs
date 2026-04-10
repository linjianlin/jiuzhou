use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::account::service::{
    BindPhoneNumberResult, ChangePasswordResult, PhoneBindingStatusDto, SendPhoneBindingCodeResult,
};
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
async fn account_current_ip_route_uses_first_forwarded_ip() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/current-ip")
                .header("authorization", "Bearer account-token")
                .header("x-forwarded-for", "203.0.113.9, 10.0.0.1")
                .body(Body::empty())
                .expect("account current-ip request"),
        )
        .await
        .expect("account current-ip response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "ip": "203.0.113.9"
            }
        })
    );
}

#[tokio::test]
async fn account_phone_binding_status_route_preserves_node_payload() {
    let app = build_router(build_app_state(FakeAuthServices {
        phone_binding_status: PhoneBindingStatusDto {
            enabled: true,
            is_bound: true,
            masked_phone_number: Some("138****8000".to_string()),
        },
        ..FakeAuthServices::default()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/phone-binding/status")
                .header("authorization", "Bearer account-token")
                .body(Body::empty())
                .expect("account phone binding status request"),
        )
        .await
        .expect("account phone binding status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "enabled": true,
                "isBound": true,
                "maskedPhoneNumber": "138****8000"
            }
        })
    );
}

#[tokio::test]
async fn account_phone_binding_send_code_route_reuses_camel_case_payload_and_request_ip() {
    let requested_payloads = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(FakeAuthServices {
        requested_send_code_payloads: requested_payloads.clone(),
        send_code_result: SendPhoneBindingCodeResult {
            cooldown_seconds: 60,
        },
        ..FakeAuthServices::default()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/account/phone-binding/send-code")
                .header("authorization", "Bearer account-token")
                .header("x-real-ip", "198.51.100.7")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "phoneNumber": "13800138000",
                        "captchaId": "captcha-1",
                        "captchaCode": "ABCD"
                    })
                    .to_string(),
                ))
                .expect("account phone binding send-code request"),
        )
        .await
        .expect("account phone binding send-code response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_payloads
            .lock()
            .expect("requested send-code payloads")
            .as_slice(),
        &[(
            "13800138000".to_string(),
            "198.51.100.7".to_string(),
            "captcha-1".to_string(),
            "ABCD".to_string(),
        )]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "cooldownSeconds": 60
            }
        })
    );
}

#[tokio::test]
async fn account_phone_binding_send_code_route_requires_local_captcha_fields() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/account/phone-binding/send-code")
                .header("authorization", "Bearer account-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "phoneNumber": "13800138000"
                    })
                    .to_string(),
                ))
                .expect("account phone binding send-code missing captcha request"),
        )
        .await
        .expect("account phone binding send-code missing captcha response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "图片验证码不能为空"
        })
    );
}

#[tokio::test]
async fn account_phone_binding_bind_route_preserves_success_payload_shape() {
    let requested_payloads = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(FakeAuthServices {
        requested_bind_payloads: requested_payloads.clone(),
        bind_result: BindPhoneNumberResult {
            masked_phone_number: "138****8000".to_string(),
        },
        ..FakeAuthServices::default()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/account/phone-binding/bind")
                .header("authorization", "Bearer account-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "phoneNumber": "13800138000",
                        "code": "123456"
                    })
                    .to_string(),
                ))
                .expect("account phone binding bind request"),
        )
        .await
        .expect("account phone binding bind response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_payloads
            .lock()
            .expect("requested bind payloads")
            .as_slice(),
        &[("13800138000".to_string(), "123456".to_string())]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "maskedPhoneNumber": "138****8000"
            }
        })
    );
}

#[tokio::test]
async fn account_change_password_route_preserves_send_result_shape() {
    let requested_payloads = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(FakeAuthServices {
        requested_change_password_payloads: requested_payloads.clone(),
        change_password_result: ChangePasswordResult {
            success: true,
            message: "密码修改成功".to_string(),
        },
        ..FakeAuthServices::default()
    }));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/account/password/change")
                .header("authorization", "Bearer account-token")
                .header("x-forwarded-for", "198.51.100.9, 10.0.0.2")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "currentPassword": "old-pass",
                        "newPassword": "new-pass"
                    })
                    .to_string(),
                ))
                .expect("account change password request"),
        )
        .await
        .expect("account change password response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_payloads
            .lock()
            .expect("requested change password payloads")
            .as_slice(),
        &[(
            "old-pass".to_string(),
            "new-pass".to_string(),
            "198.51.100.9".to_string(),
        )]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "密码修改成功"
        })
    );
}

#[tokio::test]
async fn account_change_password_route_keeps_node_pre_validation_order() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/account/password/change")
                .header("authorization", "Bearer account-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "currentPassword": "same-pass",
                        "newPassword": "same-pass"
                    })
                    .to_string(),
                ))
                .expect("account change password same request"),
        )
        .await
        .expect("account change password same response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "新密码不能与当前密码相同"
        })
    );
}

#[tokio::test]
async fn account_routes_require_authentication() {
    let app = build_router(build_app_state(FakeAuthServices::default()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/account/current-ip")
                .body(Body::empty())
                .expect("account unauthorized request"),
        )
        .await
        .expect("account unauthorized response");

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

fn build_app_state(auth_services: FakeAuthServices) -> AppState {
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

#[derive(Clone)]
struct FakeAuthServices {
    phone_binding_status: PhoneBindingStatusDto,
    send_code_result: SendPhoneBindingCodeResult,
    bind_result: BindPhoneNumberResult,
    change_password_result: ChangePasswordResult,
    requested_send_code_payloads: Arc<Mutex<Vec<(String, String, String, String)>>>,
    requested_bind_payloads: Arc<Mutex<Vec<(String, String)>>>,
    requested_change_password_payloads: Arc<Mutex<Vec<(String, String, String)>>>,
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            phone_binding_status: PhoneBindingStatusDto {
                enabled: false,
                is_bound: false,
                masked_phone_number: None,
            },
            send_code_result: SendPhoneBindingCodeResult {
                cooldown_seconds: 60,
            },
            bind_result: BindPhoneNumberResult {
                masked_phone_number: "138****8000".to_string(),
            },
            change_password_result: ChangePasswordResult {
                success: true,
                message: "密码修改成功".to_string(),
            },
            requested_send_code_payloads: Arc::new(Mutex::new(Vec::new())),
            requested_bind_payloads: Arc::new(Mutex::new(Vec::new())),
            requested_change_password_payloads: Arc::new(Mutex::new(Vec::new())),
        }
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
                captcha_id: "captcha-account".to_string(),
                image_data: "data:image/svg+xml;base64,account".to_string(),
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

    fn get_phone_binding_status<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<PhoneBindingStatusDto, BusinessError>> + Send + 'a>>
    {
        let status = self.phone_binding_status.clone();
        Box::pin(async move { Ok(status) })
    }

    fn send_phone_binding_code<'a>(
        &'a self,
        _user_id: i64,
        phone_number: String,
        user_ip: String,
        captcha: jiuzhou_server_rs::edge::http::routes::auth::CaptchaVerifyPayload,
    ) -> Pin<Box<dyn Future<Output = Result<SendPhoneBindingCodeResult, BusinessError>> + Send + 'a>>
    {
        let requested_payloads = self.requested_send_code_payloads.clone();
        let result = self.send_code_result.clone();
        Box::pin(async move {
            let jiuzhou_server_rs::edge::http::routes::auth::CaptchaVerifyPayload::Local {
                captcha_id,
                captcha_code,
            } = captcha
            else {
                return Err(BusinessError::new("测试仅支持 local captcha"));
            };
            requested_payloads
                .lock()
                .expect("requested send-code payloads")
                .push((phone_number, user_ip, captcha_id, captcha_code));
            Ok(result)
        })
    }

    fn bind_phone_number<'a>(
        &'a self,
        _user_id: i64,
        phone_number: String,
        code: String,
    ) -> Pin<Box<dyn Future<Output = Result<BindPhoneNumberResult, BusinessError>> + Send + 'a>>
    {
        let requested_payloads = self.requested_bind_payloads.clone();
        let result = self.bind_result.clone();
        Box::pin(async move {
            requested_payloads
                .lock()
                .expect("requested bind payloads")
                .push((phone_number, code));
            Ok(result)
        })
    }

    fn change_password<'a>(
        &'a self,
        _user_id: i64,
        current_password: String,
        new_password: String,
        user_ip: String,
    ) -> Pin<Box<dyn Future<Output = Result<ChangePasswordResult, BusinessError>> + Send + 'a>>
    {
        let requested_payloads = self.requested_change_password_payloads.clone();
        let result = self.change_password_result.clone();
        Box::pin(async move {
            requested_payloads
                .lock()
                .expect("requested change password payloads")
                .push((current_password, new_password, user_ip));
            Ok(result)
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
                message: "角色创建成功".to_string(),
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
            Err(GameSocketAuthFailure {
                event: "game:error",
                message: "socket disabled in test".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
