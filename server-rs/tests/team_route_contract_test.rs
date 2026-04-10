/**
 * team 路由契约测试。
 *
 * 作用：
 * 1. 做什么：锁定 Rust `/api/team` 已迁移只读链路与 Node 当前协议的一致性，包括 `/my`、详情、申请、附近、大厅、邀请六条接口。
 * 2. 做什么：校验 query/path 参数校验顺序、`sendResult` 包体形状以及“无鉴权也可访问”的现有协议。
 * 3. 不做什么：不覆盖建队、申请、审批、邀请处理等写路径，也不验证数据库查询细节。
 *
 * 输入 / 输出：
 * - 输入：HTTP 请求路径、query 参数，以及假服务返回的队伍 DTO。
 * - 输出：HTTP 状态码、JSON 包体，以及假服务收到的参数记录。
 *
 * 数据流 / 状态流：
 * - 测试请求 -> Axum team 路由 -> `FakeTeamRouteServices` -> 返回 Node 兼容响应；
 * - 同时把参数写入内存记录，验证路由层没有擅自改写 `characterId/mapId/search/limit/teamId`。
 *
 * 复用设计说明：
 * - 该测试文件集中提供 `build_app_state`、假鉴权服务、假 team 服务与 JSON 解析 helper，后续补 team 写路径时可继续复用，避免重复搭测试外壳。
 * - 队伍 DTO 通过共享样例构造函数集中管理，首页聚合若继续复用同一字段形状，也可以直接沿用这里的契约样例。
 *
 * 关键边界条件与坑点：
 * 1. `/api/team/my` 当前不走 `sendResult`，未入队时必须保持 `200 + success:true + data:null + message:'未加入队伍'`，不能误测成 404/400。
 * 2. `team` 读链路当前不要求 Bearer 鉴权；测试必须显式在无鉴权头场景下验证成功，防止后续接入中间件时误收紧协议。
 */
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
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::game::{
    GameHomeTeamApplicationView, GameHomeTeamInfoView, GameHomeTeamMemberView,
};
use jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices;
use jiuzhou_server_rs::edge::http::routes::team::{
    TeamBrowseEntryView, TeamInvitationView, TeamMyTeamResponse, TeamRouteServices,
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
async fn team_my_route_keeps_not_joined_payload_without_authentication() {
    let app = build_router(build_app_state(FakeTeamRouteServices::with_my_team(
        TeamMyTeamResponse::not_joined(),
    )));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/my?characterId=1001")
                .body(Body::empty())
                .expect("team my request"),
        )
        .await
        .expect("team my response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "未加入队伍"
        })
    );
}

#[tokio::test]
async fn team_detail_route_preserves_service_result_shape() {
    let app = build_router(build_app_state(FakeTeamRouteServices::with_team_detail(
        ServiceResultResponse::new(true, None, Some(sample_team_info())),
    )));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/team-1")
                .body(Body::empty())
                .expect("team detail request"),
        )
        .await
        .expect("team detail response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["id"], serde_json::json!("team-1"));
    assert_eq!(json["data"]["leader"], serde_json::json!("韩立"));
    assert_eq!(
        json["data"]["members"][0]["monthCardActive"],
        serde_json::json!(true)
    );
}

#[tokio::test]
async fn team_applications_route_requires_character_id_before_service() {
    let team_services = FakeTeamRouteServices::default();
    let app = build_router(build_app_state(team_services.clone()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/applications/team-1")
                .body(Body::empty())
                .expect("team applications request"),
        )
        .await
        .expect("team applications response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "缺少角色ID"
        })
    );
    assert!(team_services
        .application_requests
        .lock()
        .expect("application requests")
        .is_empty());
}

#[tokio::test]
async fn team_nearby_route_forwards_character_and_map_query() {
    let team_services = FakeTeamRouteServices::with_nearby(ServiceResultResponse::new(
        true,
        None,
        Some(vec![TeamBrowseEntryView {
            id: "team-nearby-1".to_string(),
            name: "灵草采集队".to_string(),
            leader: "王林".to_string(),
            leader_month_card_active: false,
            members: 3,
            cap: 5,
            goal: "采药".to_string(),
            min_realm: "练气".to_string(),
            distance: Some("同地图".to_string()),
        }]),
    ));
    let app = build_router(build_app_state(team_services.clone()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/nearby/list?characterId=3001&mapId=map-bamboo")
                .body(Body::empty())
                .expect("team nearby request"),
        )
        .await
        .expect("team nearby response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["data"][0]["distance"], serde_json::json!("同地图"));
    assert_eq!(
        team_services
            .nearby_requests
            .lock()
            .expect("nearby requests")
            .as_slice(),
        &[(3001, Some("map-bamboo".to_string()))]
    );
}

#[tokio::test]
async fn team_lobby_route_preserves_search_and_limit_query() {
    let team_services = FakeTeamRouteServices::with_lobby(ServiceResultResponse::new(
        true,
        None,
        Some(vec![TeamBrowseEntryView {
            id: "team-lobby-1".to_string(),
            name: "天南第一队".to_string(),
            leader: "厉飞雨".to_string(),
            leader_month_card_active: true,
            members: 4,
            cap: 5,
            goal: "冲榜".to_string(),
            min_realm: "筑基".to_string(),
            distance: None,
        }]),
    ));
    let app = build_router(build_app_state(team_services.clone()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/lobby/list?characterId=3002&search=%E5%A4%A9%E5%8D%97&limit=12")
                .body(Body::empty())
                .expect("team lobby request"),
        )
        .await
        .expect("team lobby response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json["data"][0]["leaderMonthCardActive"],
        serde_json::json!(true)
    );
    assert_eq!(
        team_services
            .lobby_requests
            .lock()
            .expect("lobby requests")
            .as_slice(),
        &[(3002, Some("天南".to_string()), Some(12))]
    );
}

#[tokio::test]
async fn team_received_invitations_route_returns_node_success_shape() {
    let team_services = FakeTeamRouteServices::with_invitations(ServiceResultResponse::new(
        true,
        None,
        Some(vec![TeamInvitationView {
            id: "invite-1".to_string(),
            team_id: "team-9".to_string(),
            team_name: "妖兽讨伐队".to_string(),
            goal: "清图".to_string(),
            inviter_name: "柳如烟".to_string(),
            inviter_month_card_active: true,
            message: Some("一起打首领".to_string()),
            time: 1_712_345_678_900,
        }]),
    ));
    let app = build_router(build_app_state(team_services.clone()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/team/invitations/received?characterId=4001")
                .body(Body::empty())
                .expect("team invitation request"),
        )
        .await
        .expect("team invitation response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"][0]["teamName"], serde_json::json!("妖兽讨伐队"));
    assert_eq!(
        team_services
            .invitation_requests
            .lock()
            .expect("invitation requests")
            .as_slice(),
        &[4001]
    );
}

fn build_app_state(team_services: FakeTeamRouteServices) -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices,
        ),
        auth_services: Arc::new(FakeAuthServices),
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
        team_services: Arc::new(team_services),
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

#[derive(Clone)]
struct FakeTeamRouteServices {
    my_team_response: TeamMyTeamResponse,
    team_detail_response: ServiceResultResponse<GameHomeTeamInfoView>,
    applications_response: ServiceResultResponse<Vec<GameHomeTeamApplicationView>>,
    nearby_response: ServiceResultResponse<Vec<TeamBrowseEntryView>>,
    lobby_response: ServiceResultResponse<Vec<TeamBrowseEntryView>>,
    invitations_response: ServiceResultResponse<Vec<TeamInvitationView>>,
    application_requests: Arc<Mutex<Vec<(String, i64)>>>,
    nearby_requests: Arc<Mutex<Vec<(i64, Option<String>)>>>,
    lobby_requests: Arc<Mutex<Vec<(i64, Option<String>, Option<i64>)>>>,
    invitation_requests: Arc<Mutex<Vec<i64>>>,
}

impl Default for FakeTeamRouteServices {
    fn default() -> Self {
        Self {
            my_team_response: TeamMyTeamResponse::not_joined(),
            team_detail_response: ServiceResultResponse::new(
                false,
                Some("队伍不存在".to_string()),
                None,
            ),
            applications_response: ServiceResultResponse::new(true, None, Some(Vec::new())),
            nearby_response: ServiceResultResponse::new(true, None, Some(Vec::new())),
            lobby_response: ServiceResultResponse::new(true, None, Some(Vec::new())),
            invitations_response: ServiceResultResponse::new(true, None, Some(Vec::new())),
            application_requests: Arc::new(Mutex::new(Vec::new())),
            nearby_requests: Arc::new(Mutex::new(Vec::new())),
            lobby_requests: Arc::new(Mutex::new(Vec::new())),
            invitation_requests: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl FakeTeamRouteServices {
    fn with_my_team(my_team_response: TeamMyTeamResponse) -> Self {
        Self {
            my_team_response,
            ..Self::default()
        }
    }

    fn with_team_detail(team_detail_response: ServiceResultResponse<GameHomeTeamInfoView>) -> Self {
        Self {
            team_detail_response,
            ..Self::default()
        }
    }

    fn with_nearby(nearby_response: ServiceResultResponse<Vec<TeamBrowseEntryView>>) -> Self {
        Self {
            nearby_response,
            ..Self::default()
        }
    }

    fn with_lobby(lobby_response: ServiceResultResponse<Vec<TeamBrowseEntryView>>) -> Self {
        Self {
            lobby_response,
            ..Self::default()
        }
    }

    fn with_invitations(
        invitations_response: ServiceResultResponse<Vec<TeamInvitationView>>,
    ) -> Self {
        Self {
            invitations_response,
            ..Self::default()
        }
    }
}

impl TeamRouteServices for FakeTeamRouteServices {
    fn get_my_team<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<TeamMyTeamResponse, BusinessError>> + Send + 'a>> {
        let response = self.my_team_response.clone();
        Box::pin(async move { Ok(response) })
    }

    fn get_team_by_id<'a>(
        &'a self,
        _team_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<GameHomeTeamInfoView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let response = self.team_detail_response.clone();
        Box::pin(async move { Ok(response) })
    }

    fn get_team_applications<'a>(
        &'a self,
        team_id: String,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<Vec<GameHomeTeamApplicationView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let response = self.applications_response.clone();
        let requests = Arc::clone(&self.application_requests);
        Box::pin(async move {
            requests
                .lock()
                .expect("application requests")
                .push((team_id, character_id));
            Ok(response)
        })
    }

    fn get_nearby_teams<'a>(
        &'a self,
        character_id: i64,
        map_id: Option<String>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        let response = self.nearby_response.clone();
        let requests = Arc::clone(&self.nearby_requests);
        Box::pin(async move {
            requests
                .lock()
                .expect("nearby requests")
                .push((character_id, map_id));
            Ok(response)
        })
    }

    fn get_lobby_teams<'a>(
        &'a self,
        character_id: i64,
        search: Option<String>,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamBrowseEntryView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        let response = self.lobby_response.clone();
        let requests = Arc::clone(&self.lobby_requests);
        Box::pin(async move {
            requests
                .lock()
                .expect("lobby requests")
                .push((character_id, search, limit));
            Ok(response)
        })
    }

    fn get_received_invitations<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<Vec<TeamInvitationView>>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        let response = self.invitations_response.clone();
        let requests = Arc::clone(&self.invitation_requests);
        Box::pin(async move {
            requests
                .lock()
                .expect("invitation requests")
                .push(character_id);
            Ok(response)
        })
    }
}

struct FakeAuthServices;

impl AuthRouteServices for FakeAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "captcha-team".to_string(),
                image_data: "data:image/svg+xml;base64,team".to_string(),
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
                user_id: Some(1),
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
                    nickname: "队伍测试角色".to_string(),
                    gender: "male".to_string(),
                    title: "外门弟子".to_string(),
                    realm: "练气".to_string(),
                    sub_realm: Some("一层".to_string()),
                    auto_cast_skills: false,
                    auto_disassemble_enabled: false,
                    auto_disassemble_rules: None,
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
                character_id: Some(1),
                session_token: "team-session".to_string(),
                team_id: Some("team-1".to_string()),
                sect_id: None,
            })
        })
    }
}

fn sample_team_info() -> GameHomeTeamInfoView {
    GameHomeTeamInfoView {
        id: "team-1".to_string(),
        name: "七玄门远征队".to_string(),
        leader: "韩立".to_string(),
        leader_id: 1001,
        leader_month_card_active: true,
        members: vec![GameHomeTeamMemberView {
            id: "tm-1001".to_string(),
            character_id: 1001,
            name: "韩立".to_string(),
            month_card_active: true,
            role: "leader".to_string(),
            realm: "筑基·初期".to_string(),
            online: true,
            avatar: Some("/uploads/avatars/hanli.png".to_string()),
        }],
        member_count: 1,
        max_members: 5,
        goal: "试炼秘境".to_string(),
        join_min_realm: "练气".to_string(),
        auto_join_enabled: true,
        auto_join_min_realm: "筑基".to_string(),
        current_map_id: Some("map-bamboo".to_string()),
        is_public: true,
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
    let json = serde_json::from_slice::<serde_json::Value>(&bytes).expect("json body");
    (status, json)
}
