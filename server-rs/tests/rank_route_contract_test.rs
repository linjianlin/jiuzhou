use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CharacterRouteData, CheckCharacterResult, CreateCharacterResult,
    UpdateCharacterPositionResult,
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
use jiuzhou_server_rs::edge::http::routes::rank::{
    ArenaRankRow, PartnerRankRow, RankOverviewView, RankRouteServices, RealmRankRow, SectRankRow,
    WealthRankRow,
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
async fn rank_overview_route_preserves_node_response_shape() {
    let app = build_router(build_app_state(
        FakeAuthServices::success(),
        FakeRankRouteServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/rank/overview?limitPlayers=12&limitSects=8")
                .header("authorization", "Bearer rank-token")
                .body(Body::empty())
                .expect("rank overview request"),
        )
        .await
        .expect("rank overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "realm": [{
                    "rank": 1,
                    "characterId": 1001,
                    "name": "青云子",
                    "title": "散修",
                    "avatar": "/uploads/avatar.webp",
                    "monthCardActive": true,
                    "realm": "炼精化炁·养气期",
                    "power": 9527
                }],
                "sect": [{
                    "rank": 1,
                    "name": "太虚门",
                    "level": 6,
                    "leader": "玄霄",
                    "leaderMonthCardActive": false,
                    "members": 28,
                    "memberCap": 40,
                    "power": 603210
                }],
                "wealth": [{
                    "rank": 1,
                    "characterId": 1001,
                    "name": "青云子",
                    "title": "散修",
                    "avatar": "/uploads/avatar.webp",
                    "monthCardActive": true,
                    "realm": "炼精化炁·养气期",
                    "spiritStones": 88888,
                    "silver": 6666
                }]
            }
        })
    );
}

#[tokio::test]
async fn rank_partner_route_returns_business_failure_for_invalid_metric() {
    let app = build_router(build_app_state(
        FakeAuthServices::success(),
        FakeRankRouteServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/rank/partner?metric=invalid")
                .header("authorization", "Bearer rank-token")
                .body(Body::empty())
                .expect("rank partner invalid metric request"),
        )
        .await
        .expect("rank partner invalid metric response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "伙伴排行维度不合法"
        })
    );
}

#[tokio::test]
async fn rank_routes_require_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::success(),
        FakeRankRouteServices::default(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/rank/realm")
                .body(Body::empty())
                .expect("rank unauthorized request"),
        )
        .await
        .expect("rank unauthorized response");

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

fn build_app_state<TAuth, TRank>(auth_services: TAuth, rank_services: TRank) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TRank: RankRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(auth_services),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(NoopTimeRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        inventory_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        rank_services: Arc::new(rank_services),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Default)]
struct FakeRankRouteServices;

impl RankRouteServices for FakeRankRouteServices {
    fn get_rank_overview<'a>(
        &'a self,
        _limit_players: Option<i64>,
        _limit_sects: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RankOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(RankOverviewView {
                    realm: vec![RealmRankRow {
                        rank: 1,
                        character_id: 1001,
                        name: "青云子".to_string(),
                        title: Some("散修".to_string()),
                        avatar: Some("/uploads/avatar.webp".to_string()),
                        month_card_active: true,
                        realm: "炼精化炁·养气期".to_string(),
                        power: 9527,
                    }],
                    sect: vec![SectRankRow {
                        rank: 1,
                        name: "太虚门".to_string(),
                        level: 6,
                        leader: "玄霄".to_string(),
                        leader_month_card_active: false,
                        members: 28,
                        member_cap: 40,
                        power: 603210,
                    }],
                    wealth: vec![WealthRankRow {
                        rank: 1,
                        character_id: 1001,
                        name: "青云子".to_string(),
                        title: Some("散修".to_string()),
                        avatar: Some("/uploads/avatar.webp".to_string()),
                        month_card_active: true,
                        realm: "炼精化炁·养气期".to_string(),
                        spirit_stones: 88888,
                        silver: 6666,
                    }],
                }),
            ))
        })
    }

    fn get_realm_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<RealmRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_sect_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<SectRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_wealth_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<WealthRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_arena_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<ArenaRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_partner_ranks<'a>(
        &'a self,
        metric: Option<String>,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<PartnerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            if metric.as_deref() != Some("power") && metric.as_deref() != Some("level") {
                return Ok(ServiceResultResponse::new(
                    false,
                    Some("伙伴排行维度不合法".to_string()),
                    None,
                ));
            }

            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(vec![PartnerRankRow {
                    rank: 1,
                    partner_id: 9001,
                    character_id: 1001,
                    owner_name: "青云子".to_string(),
                    owner_month_card_active: true,
                    partner_name: "玄灵狐".to_string(),
                    avatar: Some("/uploads/partner.webp".to_string()),
                    quality: "epic".to_string(),
                    element: "wood".to_string(),
                    role: "support".to_string(),
                    level: 45,
                    power: 12000,
                }]),
            ))
        })
    }
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
}

impl FakeAuthServices {
    fn success() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
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
                captcha_id: "rank-captcha".to_string(),
                image_data: "data:image/svg+xml;base64,rank".to_string(),
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
                success: true,
                message: "创建角色成功".to_string(),
                data: Some(CharacterRouteData {
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
                    has_character: true,
                }),
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
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json = serde_json::from_slice::<serde_json::Value>(&body).expect("json body");
    (status, json)
}
