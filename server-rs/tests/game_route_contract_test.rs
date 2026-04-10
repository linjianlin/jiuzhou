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
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::game::{
    GameHomeAchievementView, GameHomeMainQuestProgressView, GameHomeOverviewView,
    GameHomeSignInView, GameHomeTaskSummaryView, GameHomeTeamOverviewView, GameRouteServices,
};
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn game_home_overview_route_requires_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeGameServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/game/home-overview")
                .body(Body::empty())
                .expect("game unauth request"),
        )
        .await
        .expect("game unauth response");

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
async fn game_home_overview_route_returns_success_payload() {
    let requested_ids = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_overview(requested_ids.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/game/home-overview")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("game overview request"),
        )
        .await
        .expect("game overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_ids.lock().expect("requested ids").as_slice(),
        &[(9001_i64, 3002_i64)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "signIn": {
                    "currentMonth": "2026-04",
                    "signedToday": true
                },
                "achievement": {
                    "claimableCount": 3
                },
                "phoneBinding": {
                    "enabled": true,
                    "isBound": true,
                    "maskedPhoneNumber": "138****1234"
                },
                "realmOverview": null,
                "equippedItems": [],
                "idleSession": null,
                "team": {
                    "info": null,
                    "role": null,
                    "applications": []
                },
                "task": {
                    "tasks": []
                },
                "mainQuest": {
                    "currentChapter": null,
                    "currentSection": null,
                    "completedChapters": [],
                    "completedSections": [],
                    "dialogueState": null,
                    "tracked": true
                }
            }
        })
    );
}

fn build_app_state<TAuth, TGame>(auth_services: TAuth, game_services: TGame) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TGame: GameRouteServices + 'static,
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
        game_services: Arc::new(game_services),
        idle_services: Arc::new(jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
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
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        upload_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices,
        ),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

impl FakeAuthServices {
    fn with_character(character: CharacterBasicInfo) -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(9001),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(character),
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
        let result = self.character_result.clone();
        Box::pin(async move { Ok(result) })
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
        _month: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::response::ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::SignInOverviewData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn do_sign_in<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::response::ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::DoSignInData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }
}

#[derive(Clone)]
struct FakeGameServices {
    overview: GameHomeOverviewView,
    requested_ids: Arc<Mutex<Vec<(i64, i64)>>>,
}

impl FakeGameServices {
    fn new() -> Self {
        Self::with_overview(Arc::new(Mutex::new(Vec::new())))
    }

    fn with_overview(requested_ids: Arc<Mutex<Vec<(i64, i64)>>>) -> Self {
        Self {
            overview: GameHomeOverviewView {
                sign_in: GameHomeSignInView {
                    current_month: "2026-04".to_string(),
                    signed_today: true,
                },
                achievement: GameHomeAchievementView { claimable_count: 3 },
                phone_binding:
                    jiuzhou_server_rs::edge::http::routes::account::PhoneBindingStatusDto {
                        enabled: true,
                        is_bound: true,
                        masked_phone_number: Some("138****1234".to_string()),
                    },
                realm_overview: None,
                equipped_items: Vec::new(),
                idle_session: None,
                team: GameHomeTeamOverviewView {
                    info: None,
                    role: None,
                    applications: Vec::new(),
                },
                task: GameHomeTaskSummaryView { tasks: Vec::new() },
                main_quest: GameHomeMainQuestProgressView {
                    current_chapter: None,
                    current_section: None,
                    completed_chapters: Vec::new(),
                    completed_sections: Vec::new(),
                    dialogue_state: None,
                    tracked: true,
                },
            },
            requested_ids,
        }
    }
}

impl GameRouteServices for FakeGameServices {
    fn get_home_overview<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeOverviewView, BusinessError>> + Send + 'a>>
    {
        let overview = self.overview.clone();
        let requested_ids = self.requested_ids.clone();
        Box::pin(async move {
            requested_ids
                .lock()
                .expect("record requested ids")
                .push((user_id, character_id));
            Ok(overview)
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
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "game-route-session".to_string(),
                character_id: Some(1),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 3002,
        nickname: "归云".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "凡人".to_string(),
        sub_realm: None,
        auto_cast_skills: false,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: Some(Vec::new()),
        dungeon_no_stamina_cost: false,
        spirit_stones: 500,
        silver: 800,
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
    let json = serde_json::from_slice::<serde_json::Value>(&body).expect("json body");
    (status, json)
}
