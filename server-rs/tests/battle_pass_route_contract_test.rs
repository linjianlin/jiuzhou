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
use jiuzhou_server_rs::edge::http::response::ServiceResultResponse;
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::battle_pass::{
    BattlePassClaimDataView, BattlePassRewardItemView, BattlePassRewardView,
    BattlePassRouteServices, BattlePassStatusView, BattlePassTaskView, BattlePassTasksOverviewView,
    CompleteBattlePassTaskDataView,
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
async fn battle_pass_tasks_route_returns_grouped_tasks() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_user(),
        FakeBattlePassServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battlepass/tasks?seasonId=bp-season-001")
                .header("authorization", "Bearer bp-token")
                .body(Body::empty())
                .expect("battle pass tasks request"),
        )
        .await
        .expect("battle pass tasks response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["seasonId"], serde_json::json!("bp-season-001"));
    assert_eq!(
        json["data"]["daily"][0]["taskType"],
        serde_json::json!("daily")
    );
    assert_eq!(
        json["data"]["weekly"][0]["name"],
        serde_json::json!("周常胜利")
    );
    assert_eq!(
        json["data"]["season"][0]["rewardExp"],
        serde_json::json!(6000)
    );
}

#[tokio::test]
async fn battle_pass_complete_route_returns_service_result_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_user(),
        FakeBattlePassServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battlepass/tasks/bp-task-daily-001/complete")
                .method("POST")
                .header("authorization", "Bearer bp-token")
                .body(Body::empty())
                .expect("battle pass complete request"),
        )
        .await
        .expect("battle pass complete response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("任务完成"));
    assert_eq!(
        json["data"]["taskId"],
        serde_json::json!("bp-task-daily-001")
    );
    assert_eq!(json["data"]["gainedExp"], serde_json::json!(100));
}

#[tokio::test]
async fn battle_pass_status_route_returns_404_when_status_missing() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_user(),
        FakeBattlePassServices::without_status(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battlepass/status")
                .header("authorization", "Bearer bp-token")
                .body(Body::empty())
                .expect("battle pass status request"),
        )
        .await
        .expect("battle pass status response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "战令数据不存在",
        })
    );
}

#[tokio::test]
async fn battle_pass_claim_route_returns_service_result_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_user(),
        FakeBattlePassServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battlepass/claim")
                .method("POST")
                .header("authorization", "Bearer bp-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "level": 3,
                        "track": "premium"
                    })
                    .to_string(),
                ))
                .expect("battle pass claim request"),
        )
        .await
        .expect("battle pass claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("领取成功"));
    assert_eq!(json["data"]["level"], serde_json::json!(3));
    assert_eq!(json["data"]["track"], serde_json::json!("premium"));
    assert_eq!(json["data"]["spiritStones"], serde_json::json!(88));
    assert_eq!(json["data"]["silver"], serde_json::json!(666));
}

#[tokio::test]
async fn battle_pass_claim_route_rejects_non_numeric_level() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_user(),
        FakeBattlePassServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battlepass/claim")
                .method("POST")
                .header("authorization", "Bearer bp-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "level": "3",
                        "track": "free"
                    })
                    .to_string(),
                ))
                .expect("battle pass invalid claim request"),
        )
        .await
        .expect("battle pass invalid claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "等级参数无效",
        })
    );
}

fn build_app_state<TAuth, TBattlePass>(
    auth_services: TAuth,
    battle_pass_services: TBattlePass,
) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TBattlePass: BattlePassRouteServices + 'static,
{
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
        battle_pass_services: Arc::new(battle_pass_services),
        character_technique_service: Default::default(),
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
        time_services: Arc::new(NoopTimeRouteServices),
        team_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices,
        ),
        tower_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::tower::NoopTowerRouteServices,
        ),
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

struct FakeBattlePassServices {
    include_status: bool,
}

impl FakeBattlePassServices {
    fn new() -> Self {
        Self {
            include_status: true,
        }
    }

    fn without_status() -> Self {
        Self {
            include_status: false,
        }
    }
}

impl BattlePassRouteServices for FakeBattlePassServices {
    fn get_tasks_overview<'a>(
        &'a self,
        _user_id: i64,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<BattlePassTasksOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(BattlePassTasksOverviewView {
                season_id: season_id.unwrap_or_else(|| "bp-season-001".to_string()),
                daily: vec![BattlePassTaskView {
                    id: "bp-task-daily-001".to_string(),
                    code: "daily_login".to_string(),
                    name: "每日登录".to_string(),
                    description: "登录游戏1次".to_string(),
                    task_type: "daily".to_string(),
                    condition: serde_json::json!({ "event": "login" }),
                    target_value: 1,
                    reward_exp: 100,
                    reward_extra: vec![serde_json::json!({
                        "type": "currency",
                        "currency": "silver",
                        "amount": 50
                    })],
                    enabled: true,
                    sort_weight: 10,
                    progress_value: 1,
                    completed: false,
                    claimed: false,
                }],
                weekly: vec![BattlePassTaskView {
                    id: "bp-task-weekly-001".to_string(),
                    code: "weekly_battle_win".to_string(),
                    name: "周常胜利".to_string(),
                    description: "战斗胜利20次".to_string(),
                    task_type: "weekly".to_string(),
                    condition: serde_json::json!({ "event": "battle_win" }),
                    target_value: 20,
                    reward_exp: 1200,
                    reward_extra: Vec::new(),
                    enabled: true,
                    sort_weight: 110,
                    progress_value: 5,
                    completed: false,
                    claimed: false,
                }],
                season: vec![BattlePassTaskView {
                    id: "bp-task-season-001".to_string(),
                    code: "season_battle_win".to_string(),
                    name: "赛季挑战".to_string(),
                    description: "战斗胜利100次".to_string(),
                    task_type: "season".to_string(),
                    condition: serde_json::json!({ "event": "battle_win" }),
                    target_value: 100,
                    reward_exp: 6000,
                    reward_extra: Vec::new(),
                    enabled: true,
                    sort_weight: 210,
                    progress_value: 32,
                    completed: false,
                    claimed: false,
                }],
            })
        })
    }

    fn complete_task<'a>(
        &'a self,
        _user_id: i64,
        task_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<CompleteBattlePassTaskDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("任务完成".to_string()),
                Some(CompleteBattlePassTaskDataView {
                    task_id,
                    task_type: "daily".to_string(),
                    gained_exp: 100,
                    exp: 1200,
                    level: 2,
                    max_level: 30,
                    exp_per_level: 1000,
                }),
            ))
        })
    }

    fn get_status<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<BattlePassStatusView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move {
            if !self.include_status {
                return Ok(None);
            }
            Ok(Some(BattlePassStatusView {
                season_id: "bp-season-001".to_string(),
                season_name: "第一赛季".to_string(),
                exp: 2400,
                level: 3,
                max_level: 30,
                exp_per_level: 1000,
                premium_unlocked: false,
                claimed_free_levels: vec![1, 2],
                claimed_premium_levels: Vec::new(),
            }))
        })
    }

    fn get_rewards<'a>(
        &'a self,
        _season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<BattlePassRewardView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(vec![BattlePassRewardView {
                level: 1,
                free_rewards: vec![BattlePassRewardItemView {
                    reward_type: "currency".to_string(),
                    currency: Some("silver".to_string()),
                    amount: Some(100),
                    item_def_id: None,
                    qty: None,
                    name: "银两".to_string(),
                    icon: None,
                }],
                premium_rewards: vec![BattlePassRewardItemView {
                    reward_type: "item".to_string(),
                    currency: None,
                    amount: None,
                    item_def_id: Some("mat-001".to_string()),
                    qty: Some(20),
                    name: "赤炎砂".to_string(),
                    icon: Some("mat-001.png".to_string()),
                }],
            }])
        })
    }

    fn claim_reward<'a>(
        &'a self,
        _user_id: i64,
        level: i64,
        track: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<BattlePassClaimDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("领取成功".to_string()),
                Some(BattlePassClaimDataView {
                    level,
                    track,
                    rewards: vec![BattlePassRewardItemView {
                        reward_type: "item".to_string(),
                        currency: None,
                        amount: None,
                        item_def_id: Some("mat-001".to_string()),
                        qty: Some(20),
                        name: "赤炎砂".to_string(),
                        icon: Some("mat-001.png".to_string()),
                    }],
                    spirit_stones: 88,
                    silver: 666,
                }),
            ))
        })
    }
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
}

impl FakeAuthServices {
    fn with_user() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
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
            Ok(CaptchaChallenge {
                captcha_id: "captcha-id".to_string(),
                image_data: "data:image/svg+xml;base64,captcha".to_string(),
                expires_at: 60,
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
                message: "ok".to_string(),
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
                message: "ok".to_string(),
                data: None,
            })
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
            Ok(CreateCharacterResult {
                success: false,
                message: "unused".to_string(),
                data: None,
            })
        })
    }

    fn rename_character_with_card<'a>(
        &'a self,
        _user_id: i64,
        _item_instance_id: i64,
        _nickname: String,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult, BusinessError>> + Send + 'a>>{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult {
                    success: false,
                    message: "unused".to_string(),
                },
            )
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
                message: "unused".to_string(),
            })
        })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>>{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                    success: false,
                    message: "unused".to_string(),
                },
            )
        })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<serde_json::Value>>,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>>{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                    success: false,
                    message: "unused".to_string(),
                },
            )
        })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>>{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                    success: false,
                    message: "unused".to_string(),
                },
            )
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
                message: "invalid".to_string(),
                disconnect_current: true,
            })
        })
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response.into_body().collect().await.expect("collect body");
    let json = serde_json::from_slice::<serde_json::Value>(&body.to_bytes()).expect("json body");
    (status, json)
}
