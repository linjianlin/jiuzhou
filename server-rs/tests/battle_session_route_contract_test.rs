use std::collections::HashMap;
use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult,
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
use jiuzhou_server_rs::runtime::battle::build_battle_runtime_registry_from_snapshot;
use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use jiuzhou_server_rs::runtime::session::build_battle_session_registry_from_snapshot;
use tower::ServiceExt;

#[tokio::test]
async fn current_battle_session_route_returns_null_when_user_has_no_active_session() {
    let app = build_router(build_app_state(FakeAuthServices::success(501), None));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battle-session/current")
                .header("authorization", "Bearer token-no-session")
                .body(Body::empty())
                .expect("current battle session request"),
        )
        .await
        .expect("current battle session response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "session": null,
            }
        })
    );
}

#[tokio::test]
async fn current_battle_session_route_returns_latest_active_session_without_runtime_timestamps() {
    let runtime_services = Some(build_runtime_services().await);
    let app = build_router(build_app_state(
        FakeAuthServices::success(77),
        runtime_services,
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battle-session/current")
                .header("authorization", "Bearer token-current")
                .body(Body::empty())
                .expect("current battle session request"),
        )
        .await
        .expect("current battle session response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "session": {
                    "sessionId": "session-2",
                    "type": "tower",
                    "ownerUserId": 77,
                    "participantUserIds": [77],
                    "currentBattleId": null,
                    "status": "waiting_transition",
                    "nextAction": "advance",
                    "canAdvance": false,
                    "lastResult": "attacker_win",
                    "context": {
                        "floor": 12,
                        "runId": "tower-run-1"
                    }
                },
                "finished": true
            }
        })
    );
}

#[tokio::test]
async fn battle_session_by_battle_id_route_returns_session_and_state_payload() {
    let runtime_services = Some(build_runtime_services().await);
    let app = build_router(build_app_state(
        FakeAuthServices::success(77),
        runtime_services,
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battle-session/by-battle/battle-1")
                .header("authorization", "Bearer token-battle")
                .body(Body::empty())
                .expect("battle session by battle request"),
        )
        .await
        .expect("battle session by battle response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(
        json["data"]["session"]["sessionId"],
        serde_json::json!("session-1")
    );
    assert_eq!(json["data"]["session"]["type"], serde_json::json!("pve"));
    assert_eq!(
        json["data"]["state"]["battleId"],
        serde_json::json!("battle-1")
    );
    assert_eq!(json["data"]["state"]["phase"], serde_json::json!("running"));
    assert_eq!(json["data"]["state"]["logCursor"], serde_json::json!(99));
    assert_eq!(json["data"]["finished"], serde_json::json!(false));
    assert!(json["data"]["session"].get("createdAt").is_none());
    assert!(json["data"]["session"].get("updatedAt").is_none());
}

#[tokio::test]
async fn battle_session_detail_route_rejects_session_without_access() {
    let runtime_services = Some(build_runtime_services().await);
    let app = build_router(build_app_state(
        FakeAuthServices::success(501),
        runtime_services,
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/battle-session/session-1")
                .header("authorization", "Bearer token-forbidden")
                .body(Body::empty())
                .expect("battle session detail request"),
        )
        .await
        .expect("battle session detail response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "战斗会话不存在或无权访问"
        })
    );
}

async fn build_runtime_services() -> jiuzhou_server_rs::bootstrap::app::SharedRuntimeServices {
    let recovered = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");
    let battle_registry = build_battle_runtime_registry_from_snapshot(&recovered)
        .expect("build battle runtime registry");
    let session_registry = build_battle_session_registry_from_snapshot(&recovered)
        .expect("build battle session runtime registry");

    new_shared_runtime_services(RuntimeServicesState {
        battle_registry,
        session_registry,
        ..RuntimeServicesState::default()
    })
}

fn build_recovery_source() -> RecoverySourceData {
    RecoverySourceData::default()
        .with_string(
            BattleRedisKey::state("battle-1").into_string(),
            r#"{
                "roundCount":3,
                "currentTeam":"attacker",
                "currentUnitId":"unit-a",
                "phase":"running",
                "result":null,
                "rewards":null,
                "randomIndex":17,
                "logCursor":99,
                "teams":{
                    "attacker":{"totalSpeed":123,"units":[{"currentAttrs":{"max_qixue":100},"qixue":100,"lingqi":50,"shields":[],"buffs":[],"marks":[],"momentum":0,"skillCooldowns":{},"skillCooldownDiscountBank":{},"triggeredPhaseIds":[],"controlDiminishing":{},"isAlive":true,"canAct":true,"stats":{}}]},
                    "defender":{"totalSpeed":98,"units":[{"currentAttrs":{"max_qixue":120},"qixue":120,"lingqi":0,"shields":[],"buffs":[],"marks":[],"momentum":0,"skillCooldowns":{},"skillCooldownDiscountBank":{},"triggeredPhaseIds":[],"controlDiminishing":{},"isAlive":true,"canAct":true,"stats":{}}]}
                }
            }"#,
        )
        .with_string(
            BattleRedisKey::static_state("battle-1").into_string(),
            r#"{
                "battleId":"battle-1",
                "battleType":"pve",
                "cooldownTimingMode":"tick",
                "firstMover":"attacker",
                "randomSeed":"seed-1",
                "teams":{
                    "attacker":{"odwnerId":77,"units":[{"id":"unit-a","name":"甲","type":"player","sourceId":9001,"formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":100},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]},
                    "defender":{"odwnerId":0,"units":[{"id":"unit-b","name":"乙","type":"monster","sourceId":"wolf-1","formationOrder":1,"ownerUnitId":null,"baseAttrs":{"max_qixue":120},"skills":[],"setBonusEffects":[],"aiProfile":null,"partnerSkillPolicy":null,"isSummon":false,"summonerId":null}]}
                }
            }"#,
        )
        .with_string(
            BattleRedisKey::participants("battle-1").into_string(),
            r#"[77]"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session("session-1").into_string(),
            r#"{
                "sessionId":"session-1",
                "type":"pve",
                "ownerUserId":77,
                "participantUserIds":[77],
                "currentBattleId":"battle-1",
                "status":"running",
                "nextAction":"advance",
                "canAdvance":true,
                "lastResult":null,
                "context":{"monsterIds":["wolf-1"]},
                "createdAt":1710000000000,
                "updatedAt":1710000001000
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session("session-2").into_string(),
            r#"{
                "sessionId":"session-2",
                "type":"tower",
                "ownerUserId":77,
                "participantUserIds":[77],
                "currentBattleId":null,
                "status":"waiting_transition",
                "nextAction":"advance",
                "canAdvance":false,
                "lastResult":"attacker_win",
                "context":{"runId":"tower-run-1","floor":12},
                "createdAt":1710000002000,
                "updatedAt":1710000003000
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session_battle("battle-1").into_string(),
            "session-1",
        )
        .with_string(
            OnlineProjectionRedisKey::character(9001).into_string(),
            r#"{
                "characterId":9001,
                "userId":77,
                "computed":{"id":9001,"user_id":77,"nickname":"测试角色","qixue":100,"lingqi":50},
                "loadout":{"weapon":"sword"},
                "activePartner":null,
                "teamId":"team-1",
                "isTeamLeader":true
            }"#,
        )
        .with_string(
            OnlineProjectionRedisKey::user_character(77).into_string(),
            "9001",
        )
        .with_set(
            OnlineProjectionIndexKey::sessions().into_string(),
            ["session-1", "session-2"],
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001"],
        )
        .with_set(
            OnlineProjectionIndexKey::users().into_string(),
            ["77"],
        )
}

fn build_app_state(
    auth_services: FakeAuthServices,
    runtime_services: Option<jiuzhou_server_rs::bootstrap::app::SharedRuntimeServices>,
) -> AppState {
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
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
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
        settings: Settings::from_map(HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: runtime_services
            .unwrap_or_else(|| new_shared_runtime_services(RuntimeServicesState::default())),
    }
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
}

impl FakeAuthServices {
    fn success(user_id: i64) -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(user_id),
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
                captcha_id: "captcha".to_string(),
                image_data: "data:image/svg+xml;base64,stub".to_string(),
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
        Box::pin(async move {
            Ok(CheckCharacterResult {
                has_character: true,
                character: Some(CharacterBasicInfo {
                    id: 9001,
                    nickname: "测试角色".to_string(),
                    gender: "male".to_string(),
                    title: "无名修士".to_string(),
                    realm: "炼气期".to_string(),
                    sub_realm: None,
                    auto_cast_skills: false,
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
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult {
                    success: true,
                    message: "位置更新成功".to_string(),
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
                message: "未实现".to_string(),
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
    let json = serde_json::from_slice(&bytes).expect("parse response json");
    (status, json)
}
