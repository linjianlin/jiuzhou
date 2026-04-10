/**
 * 地图房间对象路由合同测试。
 *
 * 作用：
 * 1. 做什么：校验 Rust `/api/map/:mapId/rooms/:roomId/objects` 已对齐 Node 的基础读协议，能返回静态怪物/资源与在线玩家对象。
 * 2. 做什么：验证带 Bearer token 时会过滤当前登录用户自身，避免房间玩家列表把自己重复回显。
 * 3. 不做什么：不覆盖任务标记、资源冷却落库、采集/拾取写链路，这些动态逻辑仍由后续迁移补齐。
 *
 * 输入 / 输出：
 * - 输入：构造后的最小 `AppState`、在线投影快照，以及两个 HTTP 请求样例。
 * - 输出：断言 `objects` 数组中的关键对象类型、字段与缺失房间时的空数组协议。
 *
 * 数据流 / 状态流：
 * - 测试请求 -> `build_router` -> `/api/map/.../objects` -> 静态目录 + 在线投影 registry -> JSON 响应断言。
 *
 * 复用设计说明：
 * - 这里直接复用 `build_router` 与真实 `AppState` 结构，保证 HTTP 接线、鉴权读取和运行态投影使用同一条代码路径。
 * - `NoopAuthServices` 只实现当前测试真实依赖的最小 trait 子集，避免跟业务无关的 auth 接口签名在多个测试文件重复漂移。
 *
 * 关键边界条件与坑点：
 * 1. 当前用户过滤依赖 `verify_token_and_session` 返回的 `user_id`，如果测试桩返回值变化，玩家过滤断言会同步失效。
 * 2. 缺失房间时这里断言的是 Node 现状 `200 + objects=[]`，不是 `404`；后续若协议调整，测试需要一起更新。
 */
use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
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
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use jiuzhou_server_rs::runtime::projection::service::{
    build_online_projection_registry_from_snapshot, OnlineBattleCharacterSnapshotRedis,
    OnlineProjectionRecoveryState, RuntimeRecoverySnapshot,
};
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn room_objects_route_returns_static_objects_and_filters_current_player() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/map/map-qingyun-outskirts/rooms/room-south-forest/objects")
                .header("Authorization", "Bearer test-token")
                .body(Body::empty())
                .expect("map objects request"),
        )
        .await
        .expect("map objects response");

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response
        .into_body()
        .collect()
        .await
        .expect("map objects body")
        .to_bytes();
    let json = serde_json::from_slice::<Value>(&payload).expect("map objects json");

    assert_eq!(json.get("success").and_then(Value::as_bool), Some(true));
    let objects = json
        .get("data")
        .and_then(|data| data.get("objects"))
        .and_then(Value::as_array)
        .expect("objects array");

    assert!(objects.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("monster")
            && item.get("id").and_then(Value::as_str) == Some("monster-wild-rabbit")
    }));
    assert!(objects.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("item")
            && item.get("object_kind").and_then(Value::as_str) == Some("resource")
            && item.get("id").and_then(Value::as_str) == Some("res-wild-herb")
    }));
    assert!(objects.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("item")
            && item.get("object_kind").and_then(Value::as_str) == Some("board")
            && item.get("id").and_then(Value::as_str) == Some("npc-bounty-board")
    }));
    assert!(objects.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("player")
            && item.get("id").and_then(Value::as_str) == Some("2002")
            && item.get("name").and_then(Value::as_str) == Some("林间访客")
    }));
    assert!(!objects.iter().any(|item| {
        item.get("type").and_then(Value::as_str) == Some("player")
            && item.get("id").and_then(Value::as_str) == Some("1001")
    }));
}

#[tokio::test]
async fn room_objects_route_returns_empty_list_for_missing_room() {
    let app = build_router(build_app_state());

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/map/map-qingyun-outskirts/rooms/not-found/objects")
                .body(Body::empty())
                .expect("missing room objects request"),
        )
        .await
        .expect("missing room objects response");

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response
        .into_body()
        .collect()
        .await
        .expect("missing room objects body")
        .to_bytes();
    let json = serde_json::from_slice::<Value>(&payload).expect("missing room objects json");
    let objects = json
        .get("data")
        .and_then(|data| data.get("objects"))
        .and_then(Value::as_array)
        .expect("objects array");
    assert!(objects.is_empty());
}

fn build_app_state() -> AppState {
    let auth_services = Arc::new(NoopAuthServices);
    let runtime_services = RuntimeServicesState {
        online_projection_registry: build_online_projection_registry_from_snapshot(
            &RuntimeRecoverySnapshot {
                online_projection: OnlineProjectionRecoveryState {
                    character_snapshots: vec![
                        build_character_snapshot(
                            1001,
                            1,
                            "map-qingyun-outskirts",
                            "room-south-forest",
                            "自己",
                        ),
                        build_character_snapshot(
                            2002,
                            2,
                            "map-qingyun-outskirts",
                            "room-south-forest",
                            "林间访客",
                        ),
                        build_character_snapshot(
                            3003,
                            3,
                            "map-qingyun-village",
                            "room-village-entrance",
                            "村口来客",
                        ),
                    ],
                    user_character_links: vec![(1, 1001), (2, 2002), (3, 3003)],
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .expect("online projection registry"),
        ..Default::default()
    };

    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices,
        ),
        auth_services: auth_services.clone(),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
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
        mail_services: Arc::new(jiuzhou_server_rs::edge::http::routes::mail::NoopMailRouteServices),
        month_card_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices,
        ),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        realm_services: Arc::new(jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices),
        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        team_services: Arc::new(jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        title_services: Arc::new(jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices),
        tower_services: Arc::new(jiuzhou_server_rs::edge::http::routes::tower::NoopTowerRouteServices),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: auth_services,
        settings: Settings::from_map(Default::default()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(runtime_services),
    }
}

fn build_character_snapshot(
    character_id: i64,
    user_id: i64,
    map_id: &str,
    room_id: &str,
    nickname: &str,
) -> OnlineBattleCharacterSnapshotRedis {
    OnlineBattleCharacterSnapshotRedis {
        character_id,
        user_id,
        computed: json!({
            "nickname": nickname,
            "current_map_id": map_id,
            "current_room_id": room_id,
            "title": "测试称号",
            "gender": "male",
            "realm": "炼气",
            "sub_realm": "一层",
            "avatar": "/avatars/test.png",
            "month_card_active": true
        }),
        loadout: json!({}),
        active_partner: None,
        team_id: None,
        is_team_leader: false,
    }
}

struct NoopAuthServices;

impl AuthRouteServices for NoopAuthServices {
    fn captcha_provider(&self) -> CaptchaProvider {
        CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = Result<CaptchaChallenge, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(CaptchaChallenge {
                captcha_id: "captcha".to_string(),
                image_data: "data:image/svg+xml;base64,abc".to_string(),
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
}

impl GameSocketAuthServices for NoopAuthServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(GameSocketAuthProfile {
                user_id: 1,
                session_token: "session-token".to_string(),
                character_id: None,
                team_id: None,
                sect_id: None,
            })
        })
    }
}
