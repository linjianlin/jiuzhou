use std::collections::HashMap;
use std::sync::Arc;
use std::{future::Future, pin::Pin};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use jiuzhou_server_rs::application::character::service::{
    CharacterBasicInfo, CheckCharacterResult, CreateCharacterResult, UpdateCharacterPositionResult,
};
use jiuzhou_server_rs::application::reward_payload::GrantedRewardPreviewView;
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
use jiuzhou_server_rs::edge::http::routes::mail::{
    MailAttachItemOptionsView, MailAttachItemView, MailClaimAllResponse, MailClaimAllRewardSummary,
    MailClaimResponse, MailItemView, MailListView, MailMutationData, MailRouteServices,
    MailUnreadSummaryView,
};
use jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices;
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn mail_list_route_returns_success_envelope_and_query_paging() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/list?page=2&pageSize=20")
                .header("authorization", "Bearer mail-token")
                .body(Body::empty())
                .expect("mail list request"),
        )
        .await
        .expect("mail list response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["success"], serde_json::json!(true));
    assert_eq!(json["data"]["page"], serde_json::json!(2));
    assert_eq!(json["data"]["pageSize"], serde_json::json!(20));
    assert_eq!(
        json["data"]["mails"][0]["title"],
        serde_json::json!("补偿邮件")
    );
    assert_eq!(
        json["data"]["mails"][0]["attachRewards"][0]["type"],
        serde_json::json!("silver")
    );
    assert_eq!(
        json["data"]["mails"][0]["attachItems"][0]["options"]["quality"],
        serde_json::json!("天")
    );
    assert_eq!(
        json["data"]["mails"][0]["attachItems"][0]["options"]["qualityRank"],
        serde_json::json!(4)
    );
    assert_eq!(
        json["data"]["mails"][0]["attachItems"][0]["options"]["metadata"]["generatedTechniqueName"],
        serde_json::json!("太虚归元诀")
    );
}

#[tokio::test]
async fn mail_unread_route_returns_summary_payload() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/unread")
                .header("authorization", "Bearer mail-token")
                .body(Body::empty())
                .expect("mail unread request"),
        )
        .await
        .expect("mail unread response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "unreadCount": 3,
                "unclaimedCount": 1
            }
        })
    );
}

#[tokio::test]
async fn mail_read_route_rejects_invalid_mail_id_with_business_error() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/read")
                .method("POST")
                .header("authorization", "Bearer mail-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"mailId":"abc"}"#))
                .expect("mail read request"),
        )
        .await
        .expect("mail read response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        json,
        serde_json::json!({
            "success": false,
            "message": "参数错误"
        })
    );
}

#[tokio::test]
async fn mail_delete_all_route_preserves_send_result_shape() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/delete-all")
                .method("POST")
                .header("authorization", "Bearer mail-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"onlyRead":true}"#))
                .expect("mail delete all request"),
        )
        .await
        .expect("mail delete all response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "已删除2封邮件",
            "data": {
                "deletedCount": 2
            }
        })
    );
}

#[tokio::test]
async fn mail_claim_route_preserves_success_json_shape() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/claim")
                .method("POST")
                .header("authorization", "Bearer mail-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"mailId":"1","autoDisassemble":false}"#))
                .expect("mail claim request"),
        )
        .await
        .expect("mail claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "领取成功",
            "rewards": [
                {
                    "type": "silver",
                    "amount": 88
                },
                {
                    "type": "item",
                    "itemDefId": "item-1",
                    "quantity": 2,
                    "itemName": "灵草"
                }
            ]
        })
    );
}

#[tokio::test]
async fn mail_claim_all_route_preserves_summary_shape() {
    let app = build_router(build_app_state(FakeMailRouteServices));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/mail/claim-all")
                .method("POST")
                .header("authorization", "Bearer mail-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"autoDisassemble":false}"#))
                .expect("mail claim all request"),
        )
        .await
        .expect("mail claim all response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "成功领取2封邮件附件",
            "claimedCount": 2,
            "skippedCount": 0,
            "rewards": {
                "silver": 188,
                "spiritStones": 9,
                "itemCount": 5
            }
        })
    );
}

fn build_app_state(mail_services: FakeMailRouteServices) -> AppState {
    AppState {
        afdian_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::afdian::NoopAfdianRouteServices,
        ),
        achievement_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::achievement::NoopAchievementRouteServices,
        ),
        auth_services: Arc::new(FakeAuthServices::default()),
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
        mail_services: Arc::new(mail_services),
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
        team_services: Arc::new(jiuzhou_server_rs::edge::http::routes::team::NoopTeamRouteServices),
        time_services: Arc::new(jiuzhou_server_rs::edge::http::routes::time::NoopTimeRouteServices),
        tower_services: Arc::new(
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
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Clone, Copy)]
struct FakeMailRouteServices;

impl MailRouteServices for FakeMailRouteServices {
    fn list_mails<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(MailListView {
                mails: vec![MailItemView {
                    id: 1,
                    sender_type: "system".to_string(),
                    sender_name: "系统".to_string(),
                    mail_type: "reward".to_string(),
                    title: "补偿邮件".to_string(),
                    content: "请查收附件".to_string(),
                    attach_silver: 88,
                    attach_spirit_stones: 0,
                    attach_items: vec![MailAttachItemView {
                        item_def_id: "item-1".to_string(),
                        item_name: Some("灵草".to_string()),
                        qty: 2,
                        options: Some(MailAttachItemOptionsView {
                            bind_type: Some("none".to_string()),
                            equip_options: None,
                            metadata: Some(serde_json::json!({
                                "generatedTechniqueId": "tech-gen-mail-1",
                                "generatedTechniqueName": "太虚归元诀"
                            })),
                            quality: Some("天".to_string()),
                            quality_rank: Some(4),
                        }),
                    }],
                    attach_rewards: vec![GrantedRewardPreviewView::Silver { amount: 88 }],
                    has_attachments: true,
                    has_claimable_attachments: true,
                    read_at: None,
                    claimed_at: None,
                    expire_at: None,
                    created_at: "2026-04-10T08:00:00+00:00".to_string(),
                }],
                total: 1,
                unread_count: 1,
                unclaimed_count: 1,
                page,
                page_size,
            })
        })
    }

    fn get_unread_summary<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailUnreadSummaryView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(MailUnreadSummaryView {
                unread_count: 3,
                unclaimed_count: 1,
            })
        })
    }

    fn read_mail<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("已读".to_string()),
                None,
            ))
        })
    }

    fn claim_mail_attachments<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
        _auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(MailClaimResponse {
                success: true,
                message: "领取成功".to_string(),
                rewards: Some(vec![
                    GrantedRewardPreviewView::Silver { amount: 88 },
                    GrantedRewardPreviewView::Item {
                        item_def_id: "item-1".to_string(),
                        quantity: 2,
                        item_name: Some("灵草".to_string()),
                        item_icon: None,
                    },
                ]),
            })
        })
    }

    fn claim_all_mail_attachments<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _auto_disassemble: bool,
    ) -> Pin<Box<dyn Future<Output = Result<MailClaimAllResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(MailClaimAllResponse {
                success: true,
                message: "成功领取2封邮件附件".to_string(),
                claimed_count: 2,
                skipped_count: Some(0),
                rewards: Some(MailClaimAllRewardSummary {
                    silver: 188,
                    spirit_stones: 9,
                    item_count: 5,
                }),
            })
        })
    }

    fn delete_mail<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("邮件已删除".to_string()),
                None,
            ))
        })
    }

    fn delete_all_mails<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _only_read: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("已删除2封邮件".to_string()),
                Some(MailMutationData {
                    deleted_count: Some(2),
                    read_count: None,
                }),
            ))
        })
    }

    fn mark_all_read<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("已读3封邮件".to_string()),
                Some(MailMutationData {
                    deleted_count: None,
                    read_count: Some(3),
                }),
            ))
        })
    }
}

#[derive(Default)]
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
                captcha_id: "mail-captcha".to_string(),
                image_data: "data:image/svg+xml;base64,mail".to_string(),
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
                    id: 2,
                    nickname: "青云".to_string(),
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
            Err(GameSocketAuthFailure {
                event: "game:error",
                message: "socket 未实现".to_string(),
                disconnect_current: false,
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
    let json = serde_json::from_slice(&bytes).expect("json body");
    (status, json)
}
