use std::collections::HashMap;

use jiuzhou_server_rs::application::character::service::CheckCharacterResult;
use jiuzhou_server_rs::bootstrap::app::AppState;
use jiuzhou_server_rs::bootstrap::readiness::ReadinessGate;
use jiuzhou_server_rs::bootstrap::startup::{execute_with_recovery, StartupContext};
use jiuzhou_server_rs::edge::http::error::BusinessError;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::infra::postgres::pool::AppPostgres;
use jiuzhou_server_rs::infra::redis::client::AppRedis;
use jiuzhou_server_rs::runtime::battle::persistence::BattleRedisKey;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use jiuzhou_server_rs::runtime::idle::lock::IdleLockRedisKey;
use jiuzhou_server_rs::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData, RuntimeRecoveryLoader,
};
use sqlx::postgres::PgPoolOptions;

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
        .with_string(BattleRedisKey::participants("battle-1").into_string(), r#"[77,88]"#)
        .with_string(
            BattleRedisKey::character_runtime_resource(9001).into_string(),
            r#"{"qixue":88,"lingqi":21}"#,
        )
        .with_string(
            OnlineProjectionRedisKey::session("session-1").into_string(),
            r#"{
                "sessionId":"session-1",
                "type":"pve",
                "ownerUserId":77,
                "participantUserIds":[77,88],
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
        .with_string(OnlineProjectionRedisKey::user_character(77).into_string(), "9001")
        .with_string(
            IdleLockRedisKey::new(9001).into_string(),
            "idle-start:550e8400-e29b-41d4-a716-446655440000",
        )
        .with_set(
            OnlineProjectionIndexKey::sessions().into_string(),
            ["session-1"],
        )
        .with_set(
            OnlineProjectionIndexKey::characters().into_string(),
            ["9001"],
        )
        .with_set(OnlineProjectionIndexKey::users().into_string(), ["77"])
}

#[tokio::test]
async fn startup_execution_result_can_be_attached_to_application_state() {
    let context = StartupContext {
        settings: Settings::from_map(HashMap::new()).expect("settings"),
        postgres: AppPostgres {
            pool: PgPoolOptions::new()
                .connect_lazy("postgresql://postgres:postgres@localhost:5432/jiuzhou")
                .expect("pg pool"),
        },
        redis: AppRedis {
            client: redis::Client::open("redis://localhost:6379").expect("redis client"),
        },
        readiness: ReadinessGate::new(),
    };
    let recovery = RuntimeRecoveryLoader::load_from_source(&build_recovery_source())
        .await
        .expect("load recovery source");

    let execution = execute_with_recovery(&context, recovery)
        .await
        .expect("startup execute with recovery");
    let state = AppState {
        afdian_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: std::sync::Arc::new(NoopAuthServices),
        attribute_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices,
        ),
        time_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices,
        ),
        info_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices,
        ),
        insight_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::inventory::NoopInventoryRouteServices,
        ),
        title_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        month_card_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::month_card::NoopMonthCardRouteServices),

        rank_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices,
        ),
        realm_services: std::sync::Arc::new(jiuzhou_server_rs::edge::http::routes::realm::NoopRealmRouteServices),

        redeem_code_services: std::sync::Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        upload_services: std::sync::Arc::new(NoopUploadRouteServices),
        game_socket_services: std::sync::Arc::new(NoopAuthServices),
        settings: context.settings.clone(),
        readiness: context.readiness.clone(),
        session_registry: new_shared_session_registry(),
        runtime_services: execution.runtime_services.clone(),
    };

    let runtime_services = state.runtime_services.read().await;
    assert!(runtime_services.battle_registry.get("battle-1").is_some());
    assert_eq!(
        runtime_services
            .session_registry
            .find_session_id_by_battle_id("battle-1"),
        Some("session-1")
    );
    assert!(runtime_services
        .idle_runtime_service
        .is_character_locked(9001));
}

struct NoopAuthServices;

impl jiuzhou_server_rs::edge::http::routes::auth::AuthRouteServices for NoopAuthServices {
    fn captcha_provider(&self) -> jiuzhou_server_rs::edge::http::routes::auth::CaptchaProvider {
        jiuzhou_server_rs::edge::http::routes::auth::CaptchaProvider::Local
    }

    fn create_captcha<'a>(
        &'a self,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::routes::auth::CaptchaChallenge,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::edge::http::routes::auth::CaptchaChallenge {
                    captcha_id: "noop".to_string(),
                    image_data: "noop".to_string(),
                    expires_at: 0,
                },
            )
        })
    }

    fn register<'a>(
        &'a self,
        _input: jiuzhou_server_rs::edge::http::routes::auth::RegisterInput,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::routes::auth::AuthActionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::edge::http::routes::auth::AuthActionResult {
                    success: true,
                    message: "ok".to_string(),
                    data: None,
                },
            )
        })
    }

    fn login<'a>(
        &'a self,
        _input: jiuzhou_server_rs::edge::http::routes::auth::LoginInput,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::routes::auth::AuthActionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::edge::http::routes::auth::AuthActionResult {
                    success: true,
                    message: "ok".to_string(),
                    data: None,
                },
            )
        })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::CreateCharacterResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::CreateCharacterResult {
                    success: false,
                    message: "noop".to_string(),
                    data: None,
                },
            )
        })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        _current_map_id: String,
        _current_room_id: String,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult,
                        jiuzhou_server_rs::edge::http::error::BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::application::character::service::UpdateCharacterPositionResult {
                    success: false,
                    message: "noop".to_string(),
                },
            )
        })
    }

    fn verify_token_and_session<'a>(
        &'a self,
        _token: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = jiuzhou_server_rs::edge::http::routes::auth::VerifyTokenAndSessionResult,
                > + Send
                + 'a,
        >,
    >{
        Box::pin(async move {
            jiuzhou_server_rs::edge::http::routes::auth::VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            }
        })
    }

    fn check_character<'a>(
        &'a self,
        _user_id: i64,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<CheckCharacterResult, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(CheckCharacterResult {
                has_character: false,
                character: None,
            })
        })
    }
}

impl jiuzhou_server_rs::edge::socket::game_socket::GameSocketAuthServices for NoopAuthServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::socket::game_socket::GameSocketAuthProfile,
                        jiuzhou_server_rs::edge::socket::game_socket::GameSocketAuthFailure,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(
                jiuzhou_server_rs::edge::socket::game_socket::GameSocketAuthProfile {
                    user_id: 1,
                    session_token: "noop-session".to_string(),
                    character_id: None,
                    team_id: None,
                    sect_id: None,
                },
            )
        })
    }
}
