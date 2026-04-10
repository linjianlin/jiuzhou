use std::sync::{Arc, Mutex};
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::application::character_technique::service::{
    AvailableSkillView, CharacterSkillSlotView, CharacterTechniqueEquippedView,
    CharacterTechniqueRouteServices, CharacterTechniqueServiceResult, CharacterTechniqueStatusView,
    CharacterTechniqueView, SharedCharacterTechniqueRouteServices, TechniqueUpgradeCostView,
    TechniqueUpgradeResultView,
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
use tower::ServiceExt;

#[tokio::test]
async fn character_technique_upgrade_route_returns_send_result_shape() {
    let upgrade_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeCharacterTechniqueServices::with_upgrade_calls(upgrade_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/3001/technique/tech-qingmu/upgrade")
                .header("authorization", "Bearer technique-upgrade-token")
                .body(Body::empty())
                .expect("character technique upgrade request"),
        )
        .await
        .expect("character technique upgrade response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "青木诀修炼至第2层",
            "data": {
                "newLayer": 2,
                "unlockedSkills": ["skill-qingmu-burst"],
                "upgradedSkills": ["skill-qingmu-guard"],
            }
        })
    );
    assert_eq!(
        upgrade_calls
            .lock()
            .expect("upgrade calls lock")
            .as_slice(),
        &[(3001, "tech-qingmu".to_string())]
    );
}

#[tokio::test]
async fn character_technique_upgrade_route_rejects_non_owned_character() {
    let upgrade_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(7),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        },
        FakeCharacterTechniqueServices::with_upgrade_calls(upgrade_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/character/4002/technique/tech-qingmu/upgrade")
                .header("authorization", "Bearer technique-upgrade-token")
                .body(Body::empty())
                .expect("character technique forbidden upgrade request"),
        )
        .await
        .expect("character technique forbidden upgrade response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "无权限访问该角色",
        })
    );
    assert!(
        upgrade_calls
            .lock()
            .expect("upgrade calls lock")
            .is_empty()
    );
}

#[derive(Clone)]
struct FakeCharacterTechniqueServices {
    upgrade_calls: Arc<Mutex<Vec<(i64, String)>>>,
}

impl FakeCharacterTechniqueServices {
    fn with_upgrade_calls(upgrade_calls: Arc<Mutex<Vec<(i64, String)>>>) -> Self {
        Self { upgrade_calls }
    }
}

impl CharacterTechniqueRouteServices for FakeCharacterTechniqueServices {
    fn get_character_techniques<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<Vec<CharacterTechniqueView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_character_techniques call") })
    }

    fn get_equipped_techniques<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<CharacterTechniqueEquippedView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_equipped_techniques call") })
    }

    fn get_technique_upgrade_cost<'a>(
        &'a self,
        _character_id: i64,
        _technique_id: &'a str,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<TechniqueUpgradeCostView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_technique_upgrade_cost call") })
    }

    fn upgrade_technique<'a>(
        &'a self,
        character_id: i64,
        technique_id: &'a str,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<TechniqueUpgradeResultView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let upgrade_calls = self.upgrade_calls.clone();
        let technique_id = technique_id.to_string();
        Box::pin(async move {
            upgrade_calls
                .lock()
                .expect("upgrade calls lock")
                .push((character_id, technique_id.clone()));
            Ok(CharacterTechniqueServiceResult {
                success: true,
                message: "青木诀修炼至第2层".to_string(),
                data: Some(TechniqueUpgradeResultView {
                    new_layer: 2,
                    unlocked_skills: vec!["skill-qingmu-burst".to_string()],
                    upgraded_skills: vec!["skill-qingmu-guard".to_string()],
                }),
            })
        })
    }

    fn equip_technique<'a>(
        &'a self,
        _character_id: i64,
        _technique_id: &'a str,
        _slot_type: &'a str,
        _slot_index: Option<i32>,
    ) -> Pin<Box<dyn Future<Output = Result<CharacterTechniqueServiceResult<()>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { panic!("unexpected equip_technique call") })
    }

    fn unequip_technique<'a>(
        &'a self,
        _character_id: i64,
        _technique_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<CharacterTechniqueServiceResult<()>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { panic!("unexpected unequip_technique call") })
    }

    fn dissipate_technique<'a>(
        &'a self,
        _character_id: i64,
        _technique_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<CharacterTechniqueServiceResult<()>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { panic!("unexpected dissipate_technique call") })
    }

    fn equip_skill<'a>(
        &'a self,
        _character_id: i64,
        _skill_id: &'a str,
        _slot_index: i32,
    ) -> Pin<Box<dyn Future<Output = Result<CharacterTechniqueServiceResult<()>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { panic!("unexpected equip_skill call") })
    }

    fn unequip_skill<'a>(
        &'a self,
        _character_id: i64,
        _slot_index: i32,
    ) -> Pin<Box<dyn Future<Output = Result<CharacterTechniqueServiceResult<()>, BusinessError>> + Send + 'a>> {
        Box::pin(async move { panic!("unexpected unequip_skill call") })
    }

    fn get_available_skills<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<Vec<AvailableSkillView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_available_skills call") })
    }

    fn get_equipped_skills<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<Vec<CharacterSkillSlotView>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_equipped_skills call") })
    }

    fn calculate_technique_passives<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<std::collections::BTreeMap<String, f64>>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected calculate_technique_passives call") })
    }

    fn get_character_technique_status<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        CharacterTechniqueServiceResult<CharacterTechniqueStatusView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { panic!("unexpected get_character_technique_status call") })
    }
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

fn build_app_state<T, U>(auth_services: T, character_technique_service: U) -> AppState
where
    T: AuthRouteServices + 'static,
    U: CharacterTechniqueRouteServices + 'static,
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
        battle_pass_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::battle_pass::NoopBattlePassRouteServices,
        ),
        character_technique_service: SharedCharacterTechniqueRouteServices::from(
            character_technique_service,
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
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(Default::default()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
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
                captcha_id: "captcha-unused".to_string(),
                image_data: "data:image/svg+xml;base64,unused".to_string(),
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
        let verify_result = self.verify_result.clone();
        Box::pin(async move { verify_result })
    }

    fn check_character<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<CheckCharacterResult, BusinessError>> + Send + 'a>> {
        let character_result = self.character_result.clone();
        Box::pin(async move { Ok(character_result) })
    }

    fn create_character<'a>(
        &'a self,
        _user_id: i64,
        _nickname: String,
        _gender: String,
    ) -> Pin<Box<dyn Future<Output = Result<CreateCharacterResult, BusinessError>> + Send + 'a>> {
        Box::pin(async { panic!("create_character should not be called") })
    }

    fn update_character_position<'a>(
        &'a self,
        _user_id: i64,
        _current_map_id: String,
        _current_room_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<UpdateCharacterPositionResult, BusinessError>> + Send + 'a,
        >,
    > {
        Box::pin(async { panic!("update_character_position should not be called") })
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
    > {
        Box::pin(async { panic!("rename_character_with_card should not be called") })
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
    > {
        Box::pin(async { panic!("update_auto_cast_skills should not be called") })
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
    > {
        Box::pin(async { panic!("update_auto_disassemble should not be called") })
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
    > {
        Box::pin(async { panic!("update_dungeon_no_stamina_cost should not be called") })
    }
}

struct FakeGameSocketServices;

impl GameSocketAuthServices for FakeGameSocketServices {
    fn resolve_game_socket_auth<'a>(
        &'a self,
        _token: &'a str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameSocketAuthProfile, GameSocketAuthFailure>> + Send + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameSocketAuthProfile {
                user_id: 7,
                session_token: "character-technique-route-test-session".to_string(),
                character_id: Some(3001),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 3001,
        nickname: "青云子".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "炼气".to_string(),
        sub_realm: None,
        spirit_stones: 678,
        silver: 910,
        auto_cast_skills: true,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("response body")
        .to_bytes();
    let json = serde_json::from_slice(&bytes).expect("response json");
    (status, json)
}
