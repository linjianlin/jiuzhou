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
use jiuzhou_server_rs::edge::http::routes::attribute::{
    AttributeBatchInput, AttributeMutationPayload, AttributeResetResponse, AttributeRouteServices,
};
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
async fn attribute_add_route_preserves_send_result_payload() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeAttributeServices::new(calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/attribute/add")
                .method("POST")
                .header("authorization", "Bearer attribute-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "attribute": "jing",
                        "amount": 3
                    })
                    .to_string(),
                ))
                .expect("attribute add request"),
        )
        .await
        .expect("attribute add response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "加点成功",
            "data": {
                "attribute": "jing",
                "newValue": 9,
                "remainingPoints": 12
            }
        })
    );
    assert_eq!(
        calls.lock().expect("calls").as_slice(),
        &[RecordedCall::Add {
            user_id: 7,
            attribute: "jing".to_string(),
            amount: 3,
        }]
    );
}

#[tokio::test]
async fn attribute_remove_route_requires_attribute_name() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeAttributeServices::new(Arc::new(Mutex::new(Vec::new()))),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/attribute/remove")
                .method("POST")
                .header("authorization", "Bearer attribute-token")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("attribute remove request"),
        )
        .await
        .expect("attribute remove response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "请指定属性类型"
        })
    );
}

#[tokio::test]
async fn attribute_batch_route_forwards_three_attributes() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeAttributeServices::new(calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/attribute/batch")
                .method("POST")
                .header("authorization", "Bearer attribute-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "jing": 2,
                        "qi": 1,
                        "shen": 4
                    })
                    .to_string(),
                ))
                .expect("attribute batch request"),
        )
        .await
        .expect("attribute batch response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["message"], serde_json::json!("批量加点成功"));
    assert_eq!(
        calls.lock().expect("calls").as_slice(),
        &[RecordedCall::Batch {
            user_id: 7,
            input: AttributeBatchInput {
                jing: 2,
                qi: 1,
                shen: 4,
            },
        }]
    );
}

#[tokio::test]
async fn attribute_reset_route_keeps_total_points_at_top_level() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeAttributeServices::new(Arc::new(Mutex::new(Vec::new()))),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/attribute/reset")
                .method("POST")
                .header("authorization", "Bearer attribute-token")
                .body(Body::empty())
                .expect("attribute reset request"),
        )
        .await
        .expect("attribute reset response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "属性点已重置",
            "totalPoints": 15
        })
    );
}

#[tokio::test]
async fn attribute_routes_require_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeAttributeServices::new(Arc::new(Mutex::new(Vec::new()))),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/attribute/add")
                .method("POST")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "attribute": "jing",
                        "amount": 1
                    })
                    .to_string(),
                ))
                .expect("attribute unauthorized request"),
        )
        .await
        .expect("attribute unauthorized response");

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

fn build_app_state<TAuth, TAttribute>(
    auth_services: TAuth,
    attribute_services: TAttribute,
) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TAttribute: AttributeRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        attribute_services: Arc::new(attribute_services),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
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
    Add {
        user_id: i64,
        attribute: String,
        amount: i32,
    },
    Batch {
        user_id: i64,
        input: AttributeBatchInput,
    },
}

#[derive(Clone)]
struct FakeAttributeServices {
    calls: Arc<Mutex<Vec<RecordedCall>>>,
}

impl FakeAttributeServices {
    fn new(calls: Arc<Mutex<Vec<RecordedCall>>>) -> Self {
        Self { calls }
    }
}

impl AttributeRouteServices for FakeAttributeServices {
    fn add_attribute_point<'a>(
        &'a self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.calls.clone();
        Box::pin(async move {
            calls.lock().expect("calls").push(RecordedCall::Add {
                user_id,
                attribute,
                amount,
            });
            Ok(ServiceResultResponse::new(
                true,
                Some("加点成功".to_string()),
                Some(AttributeMutationPayload {
                    attribute: "jing".to_string(),
                    new_value: 9,
                    remaining_points: 12,
                }),
            ))
        })
    }

    fn remove_attribute_point<'a>(
        &'a self,
        _user_id: i64,
        _attribute: String,
        _amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("属性点不足以减少".to_string()),
                None,
            ))
        })
    }

    fn batch_add_points<'a>(
        &'a self,
        user_id: i64,
        input: AttributeBatchInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("calls")
                .push(RecordedCall::Batch { user_id, input });
            Ok(ServiceResultResponse::new(
                true,
                Some("批量加点成功".to_string()),
                Some(AttributeMutationPayload {
                    attribute: "jing".to_string(),
                    new_value: 11,
                    remaining_points: 5,
                }),
            ))
        })
    }

    fn reset_attribute_points<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<AttributeResetResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(AttributeResetResponse {
                success: true,
                message: "属性点已重置".to_string(),
                total_points: Some(15),
            })
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
            Ok(CaptchaChallenge {
                captcha_id: "captcha-attribute".to_string(),
                image_data: "data:image/svg+xml;base64,attribute".to_string(),
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
                message: "未使用".to_string(),
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
                message: "未使用".to_string(),
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
                user_id: 7,
                session_token: "attribute-session".to_string(),
                character_id: Some(1001),
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
