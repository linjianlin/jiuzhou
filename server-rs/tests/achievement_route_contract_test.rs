use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::bootstrap::app::{
    build_router, new_shared_runtime_services, AppState, RuntimeServicesState,
};
use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::edge::http::error::BusinessError;
use jiuzhou_server_rs::edge::http::routes::achievement::{
    AchievementActionResult, AchievementClaimDataView, AchievementDetailDataView,
    AchievementItemView, AchievementListDataView, AchievementListQuery,
    AchievementPointRewardClaimDataView, AchievementPointRewardListDataView,
    AchievementPointRewardView, AchievementPointsByCategoryView, AchievementPointsInfoView,
    AchievementProgressView, AchievementRewardView, AchievementRouteServices,
    AchievementTitleRewardView,
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
async fn achievement_list_route_keeps_node_success_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeAchievementServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/achievement/list?status=claimable")
                .header("authorization", "Bearer achievement-token")
                .body(Body::empty())
                .expect("achievement list request"),
        )
        .await
        .expect("achievement list response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["total"], serde_json::json!(1));
    assert_eq!(json["data"]["achievements"][0]["id"], serde_json::json!("ach-team-create-1"));
    assert_eq!(json["data"]["points"]["total"], serde_json::json!(60));
}

#[tokio::test]
async fn achievement_claim_route_accepts_legacy_achievement_id_field() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeAchievementServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/achievement/claim")
                .method("POST")
                .header("authorization", "Bearer achievement-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "achievement_id": "ach-team-create-1" }).to_string(),
                ))
                .expect("achievement claim request"),
        )
        .await
        .expect("achievement claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["message"], serde_json::json!("ok"));
    assert_eq!(
        json["data"]["title"]["id"],
        serde_json::json!("title-team-pioneer")
    );
}

#[tokio::test]
async fn achievement_detail_route_returns_404_when_service_yields_none() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(),
        FakeAchievementServices::without_detail(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/achievement/unknown-id")
                .header("authorization", "Bearer achievement-token")
                .body(Body::empty())
                .expect("achievement detail request"),
        )
        .await
        .expect("achievement detail response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "成就不存在",
        })
    );
}

fn build_app_state<TAuth, TAchievement>(
    auth_services: TAuth,
    achievement_services: TAchievement,
) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TAchievement: AchievementRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(achievement_services),
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

#[derive(Debug, Clone)]
struct FakeAchievementServices {
    detail: Option<AchievementDetailDataView>,
}

impl Default for FakeAchievementServices {
    fn default() -> Self {
        Self {
            detail: Some(sample_achievement_detail()),
        }
    }
}

impl FakeAchievementServices {
    fn without_detail() -> Self {
        Self { detail: None }
    }
}

impl AchievementRouteServices for FakeAchievementServices {
    fn get_achievement_list<'a>(
        &'a self,
        _character_id: i64,
        _query: AchievementListQuery,
    ) -> Pin<Box<dyn Future<Output = Result<AchievementListDataView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(AchievementListDataView {
                achievements: vec![sample_achievement_item()],
                total: 1,
                page: 1,
                limit: 20,
                points: AchievementPointsInfoView {
                    total: 60,
                    by_category: AchievementPointsByCategoryView {
                        combat: 0,
                        cultivation: 0,
                        exploration: 0,
                        social: 60,
                        collection: 0,
                    },
                },
            })
        })
    }

    fn get_achievement_detail<'a>(
        &'a self,
        _character_id: i64,
        _achievement_id: String,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<AchievementDetailDataView>, BusinessError>> + Send + 'a>,
    > {
        let detail = self.detail.clone();
        Box::pin(async move { Ok(detail) })
    }

    fn claim_achievement<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementActionResult<AchievementClaimDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(AchievementClaimDataView {
                    achievement_id: "ach-team-create-1".to_string(),
                    rewards: vec![AchievementRewardView::SpiritStones { amount: 40 }],
                    title: Some(AchievementTitleRewardView {
                        id: "title-team-pioneer".to_string(),
                        name: "并肩先驱".to_string(),
                        color: Some("#4da6ff".to_string()),
                        icon: None,
                    }),
                }),
            })
        })
    }

    fn get_achievement_point_rewards<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementPointRewardListDataView, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementPointRewardListDataView {
                total_points: 60,
                claimed_thresholds: Vec::new(),
                rewards: vec![AchievementPointRewardView {
                    id: "apr-100".to_string(),
                    threshold: 100,
                    name: "成就点奖励 I".to_string(),
                    description: "累计成就点达到 100".to_string(),
                    rewards: vec![AchievementRewardView::Silver { amount: 2000 }],
                    title: None,
                    claimable: false,
                    claimed: false,
                }],
            })
        })
    }

    fn claim_achievement_point_reward<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _threshold: Option<serde_json::Value>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementPointRewardClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementActionResult {
                success: false,
                message: "成就点数不足".to_string(),
                data: None,
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
                character: Some(sample_character()),
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
                image_data: "data:image/svg+xml;base64,fake".to_string(),
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
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>> {
        let result = self.character_result.clone();
        Box::pin(async move { Ok(result) })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>> {
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
    ) -> Pin<Box<dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(UpdateCharacterPositionResult {
                success: true,
                message: "位置更新成功".to_string(),
            })
        })
    }

    fn rename_character_with_card<'a>(
        &'a self,
        _user_id: i64,
        _item_instance_id: i64,
        _nickname: String,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(jiuzhou_server_rs::application::character::service::RenameCharacterWithCardResult {
                success: false,
                message: "未实现".to_string(),
            })
        })
    }

    fn update_auto_cast_skills<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                success: true,
                message: "设置已保存".to_string(),
            })
        })
    }

    fn update_auto_disassemble<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
        _rules: Option<Vec<Value>>,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                success: true,
                message: "设置已保存".to_string(),
            })
        })
    }

    fn update_dungeon_no_stamina_cost<'a>(
        &'a self,
        _user_id: i64,
        _enabled: bool,
    ) -> Pin<Box<dyn Future<Output = Result<jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(jiuzhou_server_rs::application::character::service::UpdateCharacterSettingResult {
                success: true,
                message: "设置已保存".to_string(),
            })
        })
    }
}

struct FakeGameSocketServices;

impl GameSocketAuthServices for FakeGameSocketServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(GameSocketAuthFailure {
                event: "auth:error",
                message: "socket auth unused".to_string(),
                disconnect_current: true,
            })
        })
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
        silver: 600,
    }
}

fn sample_achievement_item() -> AchievementItemView {
    AchievementItemView {
        id: "ach-team-create-1".to_string(),
        name: "并肩的起点".to_string(),
        description: "创建 1 次队伍".to_string(),
        category: "social".to_string(),
        points: 60,
        icon: None,
        hidden: false,
        status: "completed".to_string(),
        claimable: true,
        track_type: "flag".to_string(),
        track_key: "team:create".to_string(),
        progress: AchievementProgressView {
            current: 1,
            target: 1,
            percent: 100.0,
            done: true,
            status: "completed".to_string(),
            progress_data: None,
        },
        rewards: vec![AchievementRewardView::SpiritStones { amount: 40 }],
        title_id: Some("title-team-pioneer".to_string()),
        sort_weight: 880,
    }
}

fn sample_achievement_detail() -> AchievementDetailDataView {
    let achievement = sample_achievement_item();
    AchievementDetailDataView {
        progress: achievement.progress.clone(),
        achievement,
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response.into_body().collect().await.expect("collect body");
    let json = serde_json::from_slice::<serde_json::Value>(&body.to_bytes()).expect("json body");
    (status, json)
}
