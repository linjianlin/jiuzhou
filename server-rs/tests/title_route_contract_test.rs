use std::collections::HashMap;
use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::application::title::service::TitleEquipResult;
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
use jiuzhou_server_rs::edge::http::routes::title::{
    TitleInfoView, TitleListView, TitleRouteServices,
};
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn title_list_route_returns_titles_and_equipped_id() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeTitleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/title/list")
                .header("authorization", "Bearer title-token")
                .body(Body::empty())
                .expect("title list request"),
        )
        .await
        .expect("title list response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(
        json["data"]["equipped"],
        serde_json::json!("title-team-pioneer")
    );
    assert_eq!(
        json["data"]["titles"][0]["name"],
        serde_json::json!("并肩先驱")
    );
    assert_eq!(
        json["data"]["titles"][0]["isEquipped"],
        serde_json::json!(true)
    );
}

#[tokio::test]
async fn title_equip_route_accepts_legacy_title_id_field() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeTitleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/title/equip")
                .method("POST")
                .header("authorization", "Bearer title-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "title_id": "title-team-pioneer" }).to_string(),
                ))
                .expect("title equip request"),
        )
        .await
        .expect("title equip response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
        })
    );
}

#[tokio::test]
async fn title_routes_return_404_when_character_missing() {
    let app = build_router(build_app_state(
        FakeAuthServices::without_character(),
        FakeTitleServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/title/list")
                .header("authorization", "Bearer title-token")
                .body(Body::empty())
                .expect("title list request"),
        )
        .await
        .expect("title list response");

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

fn build_app_state<TAuth, TTitle>(auth_services: TAuth, title_services: TTitle) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TTitle: TitleRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        idle_services: Arc::new(NoopIdleRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        time_services: Arc::new(NoopTimeRouteServices),
        title_services: Arc::new(title_services),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Default)]
struct FakeTitleServices;

impl TitleRouteServices for FakeTitleServices {
    fn list_titles<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TitleListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(TitleListView {
                titles: vec![TitleInfoView {
                    id: "title-team-pioneer".to_string(),
                    name: "并肩先驱".to_string(),
                    description: "创建并组织队伍的修士".to_string(),
                    color: Some("#4da6ff".to_string()),
                    icon: None,
                    effects: HashMap::from([
                        ("max_qixue".to_string(), 80),
                        ("wufang".to_string(), 10),
                    ]),
                    is_equipped: true,
                    obtained_at: "2026-04-10T08:00:00.000Z".to_string(),
                    expires_at: None,
                }],
                equipped: "title-team-pioneer".to_string(),
            })
        })
    }

    fn equip_title<'a>(
        &'a self,
        _character_id: i64,
        _title_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<TitleEquipResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(TitleEquipResult {
                success: true,
                message: "ok".to_string(),
            })
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
                captcha_id: "title-captcha".to_string(),
                image_data: "data:image/svg+xml;base64,title".to_string(),
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

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                    success: false,
                    message: "未实现".to_string(),
                },
            )
        })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                    success: false,
                    message: "未实现".to_string(),
                },
            )
        })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
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
                message: "unused".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
