use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::application::inventory::service::{
    InventoryBagSnapshotView, InventoryInfoView, InventoryItemDefinitionView, InventoryItemView,
    InventoryItemsPageView, InventoryLocation,
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
use jiuzhou_server_rs::edge::http::routes::inventory::InventoryRouteServices;
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn inventory_info_route_returns_success_envelope() {
    let app = build_router(build_app_state(FakeInventoryServices::sample()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/inventory/info")
                .header(header::AUTHORIZATION, "Bearer token")
                .body(Body::empty())
                .expect("inventory info request"),
        )
        .await
        .expect("inventory info response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "bag_capacity": 120,
                "warehouse_capacity": 1500,
                "bag_used": 23,
                "warehouse_used": 8,
            }
        })
    );
}

#[tokio::test]
async fn inventory_items_route_rejects_invalid_location_with_node_message() {
    let app = build_router(build_app_state(FakeInventoryServices::sample()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/inventory/items?location=trash")
                .header(header::AUTHORIZATION, "Bearer token")
                .body(Body::empty())
                .expect("inventory items invalid location request"),
        )
        .await
        .expect("inventory items invalid location response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "location参数错误",
        })
    );
}

#[tokio::test]
async fn inventory_items_route_keeps_paginated_success_shape() {
    let app = build_router(build_app_state(FakeInventoryServices::sample()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/inventory/items?location=bag&page=2&pageSize=50")
                .header(header::AUTHORIZATION, "Bearer token")
                .body(Body::empty())
                .expect("inventory items request"),
        )
        .await
        .expect("inventory items response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["page"], serde_json::json!(2));
    assert_eq!(json["data"]["pageSize"], serde_json::json!(50));
    assert_eq!(json["data"]["total"], serde_json::json!(1));
    assert_eq!(
        json["data"]["items"][0]["location"],
        serde_json::json!("bag")
    );
    assert_eq!(
        json["data"]["items"][0]["def"]["id"],
        serde_json::json!("cons-001")
    );
}

#[tokio::test]
async fn inventory_bag_snapshot_route_keeps_combined_success_shape() {
    let app = build_router(build_app_state(FakeInventoryServices::sample()));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/inventory/bag/snapshot")
                .header(header::AUTHORIZATION, "Bearer token")
                .body(Body::empty())
                .expect("inventory bag snapshot request"),
        )
        .await
        .expect("inventory bag snapshot response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["info"]["bag_capacity"], serde_json::json!(120));
    assert_eq!(
        json["data"]["bagItems"][0]["location"],
        serde_json::json!("bag")
    );
    assert_eq!(
        json["data"]["equippedItems"][0]["location"],
        serde_json::json!("equipped")
    );
}

fn build_app_state<T>(inventory_services: T) -> AppState
where
    T: InventoryRouteServices + 'static,
{
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        auth_services: Arc::new(FakeAuthServices::default()),
        attribute_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::attribute::NoopAttributeRouteServices,
        ),
        idle_services: Arc::new(NoopIdleRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        info_services: Arc::new(jiuzhou_server_rs::edge::http::routes::info::NoopInfoRouteServices),
        insight_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::insight::NoopInsightRouteServices,
        ),
        inventory_services: Arc::new(inventory_services),
        title_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::title::NoopTitleRouteServices,
        ),
        rank_services: Arc::new(jiuzhou_server_rs::edge::http::routes::rank::NoopRankRouteServices),
        redeem_code_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::redeem_code::NoopRedeemCodeRouteServices,
        ),
        upload_services: Arc::new(NoopUploadRouteServices),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

#[derive(Clone)]
struct FakeInventoryServices {
    info: InventoryInfoView,
    items: InventoryItemsPageView,
    snapshot: InventoryBagSnapshotView,
}

impl FakeInventoryServices {
    fn sample() -> Self {
        let info = InventoryInfoView {
            bag_capacity: 120,
            warehouse_capacity: 1500,
            bag_used: 23,
            warehouse_used: 8,
        };
        let bag_item = sample_inventory_item(InventoryLocation::Bag, 7, Some(3), None);
        let equipped_item = sample_inventory_item(
            InventoryLocation::Equipped,
            8,
            None,
            Some("weapon".to_string()),
        );
        Self {
            info: info.clone(),
            items: InventoryItemsPageView {
                items: vec![bag_item.clone()],
                total: 1,
                page: 2,
                page_size: 50,
            },
            snapshot: InventoryBagSnapshotView {
                info,
                bag_items: vec![bag_item],
                equipped_items: vec![equipped_item],
            },
        }
    }
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(1),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(sample_character()),
            },
        }
    }
}

impl InventoryRouteServices for FakeInventoryServices {
    fn get_inventory_info<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryInfoView, BusinessError>> + Send + 'a>> {
        Box::pin(async move { Ok(self.info.clone()) })
    }

    fn get_bag_inventory_snapshot<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryBagSnapshotView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.snapshot.clone()) })
    }

    fn get_inventory_items<'a>(
        &'a self,
        _character_id: i64,
        _location: InventoryLocation,
        _page: i64,
        _page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryItemsPageView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(self.items.clone()) })
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
                session_token: "inventory-route-test-session".to_string(),
                character_id: Some(1001),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 1001,
        nickname: "韩立".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "凡人".to_string(),
        sub_realm: None,
        auto_cast_skills: true,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: None,
        dungeon_no_stamina_cost: false,
        spirit_stones: 88,
        silver: 666,
    }
}

fn sample_inventory_item(
    location: InventoryLocation,
    id: i64,
    location_slot: Option<i32>,
    equipped_slot: Option<String>,
) -> InventoryItemView {
    InventoryItemView {
        id,
        item_def_id: "cons-001".to_string(),
        qty: 5,
        quality: Some("黄".to_string()),
        quality_rank: Some(1),
        location,
        location_slot,
        equipped_slot,
        strengthen_level: 0,
        refine_level: 0,
        affixes: serde_json::json!([]),
        identified: true,
        locked: false,
        bind_type: "none".to_string(),
        socketed_gems: serde_json::json!([]),
        created_at: "2026-04-10T12:00:00.000Z".to_string(),
        def: Some(InventoryItemDefinitionView {
            id: "cons-001".to_string(),
            name: "清灵丹".to_string(),
            icon: Some("/assets/danyao/bing_xin_dan.png".to_string()),
            quality: Some("黄".to_string()),
            category: "consumable".to_string(),
            sub_category: Some("pill".to_string()),
            can_disassemble: true,
            stack_max: Some(9999),
            description: Some("入门级丹药，服用后恢复少量气血".to_string()),
            long_desc: Some("清灵丹乃修仙入门之丹药，以灵草炼制而成，可恢复气血50点。".to_string()),
            tags: serde_json::json!(["丹药", "回复", "入门"]),
            effect_defs: serde_json::json!([{ "trigger": "use", "target": "self", "effect_type": "heal", "value": 50 }]),
            base_attrs: serde_json::json!(null),
            equip_slot: None,
            use_type: Some("instant".to_string()),
            use_req_realm: None,
            equip_req_realm: None,
            use_req_level: None,
            use_limit_daily: None,
            use_limit_total: None,
            socket_max: None,
            gem_slot_types: serde_json::json!(null),
            gem_level: None,
            set_id: None,
        }),
    }
}

async fn response_json(response: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("collect response body");
    let json: serde_json::Value = serde_json::from_slice(&body.to_bytes()).expect("json body");
    (status, json)
}
