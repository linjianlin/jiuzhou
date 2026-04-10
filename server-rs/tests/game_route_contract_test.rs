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
use jiuzhou_server_rs::edge::http::routes::auth::{
    AuthActionResult, AuthRouteServices, CaptchaChallenge, CaptchaProvider, LoginInput,
    RegisterInput, VerifyTokenAndSessionResult,
};
use jiuzhou_server_rs::edge::http::routes::game::{
    GameActionResult, GameHomeAchievementView, GameHomeDialogueStateView,
    GameHomeMainQuestChapterView, GameHomeMainQuestProgressView, GameHomeMainQuestSectionView,
    GameHomeOverviewView, GameHomeSignInView, GameHomeTaskSummaryItemView,
    GameHomeTaskSummaryView, GameHomeTeamOverviewView, GameMainQuestDialogueActionDataView,
    GameMainQuestSectionCompleteDataView, GameMainQuestTrackDataView, GameNpcTalkDataView, GameNpcTalkMainQuestOptionView,
    GameNpcTalkTaskOptionView, GameRouteServices, GameTaskClaimDataView,
    GameTaskClaimRewardView, GameTaskMutationDataView, GameTaskObjectiveView,
    GameTaskOverviewItemView, GameTaskOverviewView, GameTaskRewardView, GameTaskTrackDataView,
};
use jiuzhou_server_rs::edge::socket::game_socket::{
    GameSocketAuthFailure, GameSocketAuthProfile, GameSocketAuthServices,
};
use jiuzhou_server_rs::infra::config::settings::Settings;
use jiuzhou_server_rs::runtime::connection::session_registry::new_shared_session_registry;
use tower::ServiceExt;

#[tokio::test]
async fn game_home_overview_route_requires_authentication() {
    let app = build_router(build_app_state(
        FakeAuthServices::default(),
        FakeGameServices::new(),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/game/home-overview")
                .body(Body::empty())
                .expect("game unauth request"),
        )
        .await
        .expect("game unauth response");

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

#[tokio::test]
async fn game_home_overview_route_returns_success_payload() {
    let requested_ids = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_overview(requested_ids.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/game/home-overview")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("game overview request"),
        )
        .await
        .expect("game overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_ids.lock().expect("requested ids").as_slice(),
        &[(9001_i64, 3002_i64)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "signIn": {
                    "currentMonth": "2026-04",
                    "signedToday": true
                },
                "achievement": {
                    "claimableCount": 3
                },
                "phoneBinding": {
                    "enabled": true,
                    "isBound": true,
                    "maskedPhoneNumber": "138****1234"
                },
                "realmOverview": null,
                "equippedItems": [],
                "idleSession": null,
                "team": {
                    "info": null,
                    "role": null,
                    "applications": []
                },
                "task": {
                    "tasks": []
                },
                "mainQuest": {
                    "currentChapter": null,
                    "currentSection": null,
                    "completedChapters": [],
                    "completedSections": [],
                    "dialogueState": null,
                    "tracked": true
                }
            }
        })
    );
}

#[tokio::test]
async fn task_overview_summary_route_returns_success_payload_and_forwards_category() {
    let requested_categories = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_summary(requested_categories.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/task/overview/summary?category=daily")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("task summary request"),
        )
        .await
        .expect("task summary response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_categories
            .lock()
            .expect("task requested categories")
            .as_slice(),
        &[(3002_i64, Some("daily".to_string()))]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "tasks": [
                    {
                        "id": "daily-1",
                        "category": "daily",
                        "mapId": "map-1",
                        "roomId": "room-1",
                        "status": "ongoing",
                        "tracked": true
                    }
                ]
            }
        })
    );
}

#[tokio::test]
async fn task_overview_route_returns_full_payload_and_forwards_category() {
    let requested_categories = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_summary(requested_categories.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/task/overview?category=main")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("task overview request"),
        )
        .await
        .expect("task overview response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        requested_categories
            .lock()
            .expect("task overview requested categories")
            .as_slice(),
        &[(3002_i64, Some("main".to_string()))]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "data": {
                "tasks": [
                    {
                        "id": "task-main-001",
                        "category": "main",
                        "title": "初入青云村",
                        "realm": "凡人",
                        "giverNpcId": "npc-guide",
                        "mapId": "map-1",
                        "mapName": "青云村",
                        "roomId": "room-1",
                        "status": "ongoing",
                        "tracked": true,
                        "description": "与引路童子交谈。",
                        "objectives": [
                            {
                                "id": "obj-1",
                                "type": "talk_npc",
                                "text": "与引路童子交谈",
                                "done": 1,
                                "target": 1,
                                "params": {
                                    "npc_id": "npc-guide"
                                },
                                "mapName": "青云村",
                                "mapNameType": "map"
                            }
                        ],
                        "rewards": [
                            {
                                "type": "silver",
                                "name": "银两",
                                "amount": 100
                            },
                            {
                                "type": "item",
                                "name": "养气散",
                                "amount": 1,
                                "itemDefId": "item-1",
                                "icon": "/items/item-1.webp",
                                "amountMax": 2
                            }
                        ]
                    }
                ]
            }
        })
    );
}

#[tokio::test]
async fn task_track_route_preserves_send_result_shape() {
    let track_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_track_calls(track_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/task/track")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"taskId":"daily-1","tracked":true}"#))
                .expect("task track request"),
        )
        .await
        .expect("task track response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        track_calls.lock().expect("task track calls").as_slice(),
        &[(3002_i64, "daily-1".to_string(), true)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "daily-1",
                "tracked": true
            }
        })
    );
}

#[tokio::test]
async fn task_npc_talk_route_preserves_send_result_shape() {
    let talk_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_talk_calls(talk_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/task/npc/talk")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"npcId":"npc-guide"}"#))
                .expect("task npc talk request"),
        )
        .await
        .expect("task npc talk response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        talk_calls.lock().expect("task npc talk calls").as_slice(),
        &[(3002_i64, "npc-guide".to_string())]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "npcId": "npc-guide",
                "npcName": "引路童子",
                "lines": [
                    "欢迎来到青云村！修行之路漫漫，先从认识这里开始吧。"
                ],
                "tasks": [
                    {
                        "taskId": "task-main-001",
                        "title": "初入青云村",
                        "category": "main",
                        "status": "turnin"
                    }
                ],
                "mainQuest": {
                    "sectionId": "section-main-001",
                    "sectionName": "初入青云",
                    "chapterName": "第一章",
                    "status": "dialogue",
                    "canStartDialogue": true,
                    "canComplete": false
                }
            }
        })
    );
}

#[tokio::test]
async fn task_npc_accept_route_preserves_send_result_shape() {
    let accept_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_accept_calls(accept_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/task/npc/accept")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"npcId":"npc-guide","taskId":"task-main-001"}"#,
                ))
                .expect("task npc accept request"),
        )
        .await
        .expect("task npc accept response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        accept_calls
            .lock()
            .expect("task npc accept calls")
            .as_slice(),
        &[(
            3002_i64,
            "task-main-001".to_string(),
            "npc-guide".to_string()
        )]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "task-main-001"
            }
        })
    );
}

#[tokio::test]
async fn task_npc_submit_route_preserves_send_result_shape() {
    let submit_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_submit_calls(submit_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/task/npc/submit")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"npcId":"npc-village-elder","taskId":"task-main-003"}"#,
                ))
                .expect("task npc submit request"),
        )
        .await
        .expect("task npc submit response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        submit_calls
            .lock()
            .expect("task npc submit calls")
            .as_slice(),
        &[(
            3002_i64,
            "task-main-003".to_string(),
            "npc-village-elder".to_string(),
        )]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "task-main-003"
            }
        })
    );
}

#[tokio::test]
async fn task_claim_route_preserves_send_result_shape() {
    let claim_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_task_claim_calls(claim_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/task/claim")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"taskId":"task-main-001"}"#))
                .expect("task claim request"),
        )
        .await
        .expect("task claim response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        claim_calls.lock().expect("task claim calls").as_slice(),
        &[(9001_i64, 3002_i64, "task-main-001".to_string())]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "task-main-001",
                "rewards": [
                    {
                        "type": "silver",
                        "amount": 100
                    },
                    {
                        "type": "item",
                        "itemDefId": "item-1",
                        "qty": 2,
                        "itemName": "养气散",
                        "itemIcon": "/items/item-1.webp"
                    }
                ]
            }
        })
    );
}

#[tokio::test]
async fn main_quest_progress_and_chapters_routes_return_success_payloads() {
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_views(),
    ));

    let progress_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/main-quest/progress")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("main quest progress request"),
        )
        .await
        .expect("main quest progress response");
    let (progress_status, progress_json) = response_json(progress_response).await;
    assert_eq!(progress_status, StatusCode::OK);
    assert_eq!(
        progress_json,
        serde_json::json!({
            "success": true,
            "data": {
                "currentChapter": null,
                "currentSection": null,
                "completedChapters": ["chapter-1"],
                "completedSections": ["section-1"],
                "dialogueState": null,
                "tracked": true
            }
        })
    );

    let chapters_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/main-quest/chapters")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("main quest chapters request"),
        )
        .await
        .expect("main quest chapters response");
    let (chapters_status, chapters_json) = response_json(chapters_response).await;
    assert_eq!(chapters_status, StatusCode::OK);
    assert_eq!(
        chapters_json,
        serde_json::json!({
            "success": true,
            "data": {
                "chapters": [
                    {
                        "id": "chapter-1",
                        "chapterNum": 1,
                        "name": "初入仙途",
                        "description": "踏上修行",
                        "background": null,
                        "minRealm": "凡人",
                        "isCompleted": true
                    }
                ]
            }
        })
    );

    let sections_response = app
        .oneshot(
            Request::builder()
                .uri("/api/main-quest/chapters/chapter-1/sections")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("main quest sections request"),
        )
        .await
        .expect("main quest sections response");
    let (sections_status, sections_json) = response_json(sections_response).await;
    assert_eq!(sections_status, StatusCode::OK);
    assert_eq!(
        sections_json,
        serde_json::json!({
            "success": true,
            "data": {
                "sections": [
                    {
                        "id": "section-1",
                        "chapterId": "chapter-1",
                        "sectionNum": 1,
                        "name": "拜入山门",
                        "description": "完成入门试炼",
                        "brief": "去找长老",
                        "npcId": "npc-1",
                        "mapId": "map-1",
                        "roomId": "room-1",
                        "status": "completed",
                        "objectives": [],
                        "rewards": {},
                        "isChapterFinal": false
                    }
                ]
            }
        })
    );
}

#[tokio::test]
async fn main_quest_track_route_preserves_send_result_shape() {
    let track_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_track_calls(track_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/track")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"tracked":false}"#))
                .expect("main quest track request"),
        )
        .await
        .expect("main quest track response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        track_calls
            .lock()
            .expect("main quest track calls")
            .as_slice(),
        &[(3002_i64, false)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "tracked": false
            }
        })
    );
}

#[tokio::test]
async fn main_quest_dialogue_start_route_forwards_optional_dialogue_id() {
    let start_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_dialogue_start_calls(start_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/dialogue/start")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"dialogueId":" dlg-main-custom "}"#))
                .expect("main quest dialogue start request"),
        )
        .await
        .expect("main quest dialogue start response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        start_calls
            .lock()
            .expect("main quest dialogue start calls")
            .as_slice(),
        &[(3002_i64, Some("dlg-main-custom".to_string()))]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "dialogueState": {
                    "dialogueId": "dlg-main-custom",
                    "currentNodeId": "start",
                    "currentNode": {
                        "id": "start",
                        "type": "npc",
                        "text": "前往青云村。"
                    },
                    "selectedChoices": [],
                    "isComplete": false,
                    "pendingEffects": []
                }
            }
        })
    );
}

#[tokio::test]
async fn main_quest_dialogue_advance_route_preserves_send_result_shape() {
    let advance_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_dialogue_advance_calls(advance_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/dialogue/advance")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("main quest dialogue advance request"),
        )
        .await
        .expect("main quest dialogue advance response");

    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        advance_calls
            .lock()
            .expect("main quest dialogue advance calls")
            .as_slice(),
        &[(9001_i64, 3002_i64)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "dialogueState": {
                    "dialogueId": "dlg-main-001",
                    "currentNodeId": "start",
                    "currentNode": {
                        "id": "start",
                        "type": "npc",
                        "text": "前往青云村。"
                    },
                    "selectedChoices": [],
                    "isComplete": false,
                    "pendingEffects": []
                },
                "effectResults": []
            }
        })
    );
}

#[tokio::test]
async fn main_quest_dialogue_choice_route_validates_and_forwards_choice_id() {
    let choice_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_dialogue_choice_calls(choice_calls.clone()),
    ));

    let invalid_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/dialogue/choice")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"choiceId":"   "}"#))
                .expect("main quest dialogue invalid choice request"),
        )
        .await
        .expect("main quest dialogue invalid choice response");
    let (invalid_status, invalid_json) = response_json(invalid_response).await;
    assert_eq!(invalid_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid_json,
        serde_json::json!({
            "success": false,
            "message": "选项ID不能为空"
        })
    );
    assert!(
        choice_calls
            .lock()
            .expect("main quest dialogue choice calls after invalid request")
            .is_empty()
    );

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/dialogue/choice")
                .header("authorization", "Bearer game-token")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"choiceId":" choice-1 "}"#))
                .expect("main quest dialogue choice request"),
        )
        .await
        .expect("main quest dialogue choice response");
    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        choice_calls
            .lock()
            .expect("main quest dialogue choice calls")
            .as_slice(),
        &[(9001_i64, 3002_i64, "choice-1".to_string())]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "dialogueState": {
                    "dialogueId": "dlg-main-001",
                    "currentNodeId": "start",
                    "currentNode": {
                        "id": "start",
                        "type": "npc",
                        "text": "前往青云村。"
                    },
                    "selectedChoices": [],
                    "isComplete": false,
                    "pendingEffects": []
                },
                "effectResults": [
                    {
                        "type": "item",
                        "itemDefId": "cons-001",
                        "quantity": 1
                    }
                ]
            }
        })
    );
}

#[tokio::test]
async fn main_quest_section_complete_route_preserves_send_result_shape() {
    let complete_calls = Arc::new(Mutex::new(Vec::new()));
    let app = build_router(build_app_state(
        FakeAuthServices::with_character(sample_character()),
        FakeGameServices::with_main_quest_section_complete_calls(complete_calls.clone()),
    ));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/main-quest/section/complete")
                .header("authorization", "Bearer game-token")
                .body(Body::empty())
                .expect("main quest section complete request"),
        )
        .await
        .expect("main quest section complete response");
    let (status, json) = response_json(response).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        complete_calls
            .lock()
            .expect("main quest section complete calls")
            .as_slice(),
        &[(9001_i64, 3002_i64)]
    );
    assert_eq!(
        json,
        serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "rewards": [
                    {
                        "type": "silver",
                        "amount": 180
                    },
                    {
                        "type": "item",
                        "itemDefId": "cons-001",
                        "quantity": 2
                    }
                ],
                "nextSection": {
                    "id": "section-1",
                    "chapterId": "chapter-1",
                    "sectionNum": 1,
                    "name": "拜入山门",
                    "description": "完成入门试炼",
                    "brief": "去找长老",
                    "npcId": "npc-1",
                    "mapId": "map-1",
                    "roomId": "room-1",
                    "status": "completed",
                    "objectives": [],
                    "rewards": {},
                    "isChapterFinal": false
                },
                "chapterCompleted": false
            }
        })
    );
}

fn build_app_state<TAuth, TGame>(auth_services: TAuth, game_services: TGame) -> AppState
where
    TAuth: AuthRouteServices + 'static,
    TGame: GameRouteServices + 'static,
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
        character_technique_service: Default::default(),
        game_services: Arc::new(game_services),
        idle_services: Arc::new(jiuzhou_server_rs::edge::http::routes::idle::NoopIdleRouteServices),
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
        upload_services: Arc::new(
            jiuzhou_server_rs::edge::http::routes::upload::NoopUploadRouteServices,
        ),
        game_socket_services: Arc::new(FakeGameSocketServices),
        settings: Settings::from_map(std::collections::HashMap::new()).expect("settings"),
        readiness: ReadinessGate::new(),
        session_registry: new_shared_session_registry(),
        runtime_services: new_shared_runtime_services(RuntimeServicesState::default()),
    }
}

#[derive(Clone)]
struct FakeAuthServices {
    verify_result: VerifyTokenAndSessionResult,
    character_result: CheckCharacterResult,
}

impl FakeAuthServices {
    fn with_character(character: CharacterBasicInfo) -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: true,
                kicked: false,
                user_id: Some(9001),
            },
            character_result: CheckCharacterResult {
                has_character: true,
                character: Some(character),
            },
        }
    }
}

impl Default for FakeAuthServices {
    fn default() -> Self {
        Self {
            verify_result: VerifyTokenAndSessionResult {
                valid: false,
                kicked: false,
                user_id: None,
            },
            character_result: CheckCharacterResult {
                has_character: false,
                character: None,
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
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn register<'a>(
        &'a self,
        _input: RegisterInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn login<'a>(
        &'a self,
        _input: LoginInput,
    ) -> Pin<Box<dyn Future<Output = Result<AuthActionResult, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
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
        let result = self.character_result.clone();
        Box::pin(async move { Ok(result) })
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

    fn get_sign_in_overview<'a>(
        &'a self,
        _user_id: i64,
        _month: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::response::ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::SignInOverviewData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }

    fn do_sign_in<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        jiuzhou_server_rs::edge::http::response::ServiceResultResponse<
                            jiuzhou_server_rs::application::sign_in::service::DoSignInData,
                        >,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Err(BusinessError::with_status(
                "未实现",
                StatusCode::INTERNAL_SERVER_ERROR,
            ))
        })
    }
}

#[derive(Clone)]
struct FakeGameServices {
    overview: GameHomeOverviewView,
    task_overview: GameTaskOverviewView,
    task_summary: GameHomeTaskSummaryView,
    task_npc_talk: GameNpcTalkDataView,
    main_quest_progress: GameHomeMainQuestProgressView,
    main_quest_chapters: Vec<GameHomeMainQuestChapterView>,
    main_quest_sections: Vec<GameHomeMainQuestSectionView>,
    requested_ids: Arc<Mutex<Vec<(i64, i64)>>>,
    task_summary_requests: Arc<Mutex<Vec<(i64, Option<String>)>>>,
    task_track_calls: Arc<Mutex<Vec<(i64, String, bool)>>>,
    task_talk_calls: Arc<Mutex<Vec<(i64, String)>>>,
    task_accept_calls: Arc<Mutex<Vec<(i64, String, String)>>>,
    task_claim_calls: Arc<Mutex<Vec<(i64, i64, String)>>>,
    task_submit_calls: Arc<Mutex<Vec<(i64, String, String)>>>,
    main_quest_track_calls: Arc<Mutex<Vec<(i64, bool)>>>,
    main_quest_dialogue_start_calls: Arc<Mutex<Vec<(i64, Option<String>)>>>,
    main_quest_dialogue_advance_calls: Arc<Mutex<Vec<(i64, i64)>>>,
    main_quest_dialogue_choice_calls: Arc<Mutex<Vec<(i64, i64, String)>>>,
    main_quest_section_complete_calls: Arc<Mutex<Vec<(i64, i64)>>>,
}

impl FakeGameServices {
    fn new() -> Self {
        Self::with_overview(Arc::new(Mutex::new(Vec::new())))
    }

    fn with_overview(requested_ids: Arc<Mutex<Vec<(i64, i64)>>>) -> Self {
        Self {
            overview: GameHomeOverviewView {
                sign_in: GameHomeSignInView {
                    current_month: "2026-04".to_string(),
                    signed_today: true,
                },
                achievement: GameHomeAchievementView { claimable_count: 3 },
                phone_binding:
                    jiuzhou_server_rs::edge::http::routes::account::PhoneBindingStatusDto {
                        enabled: true,
                        is_bound: true,
                        masked_phone_number: Some("138****1234".to_string()),
                    },
                realm_overview: None,
                equipped_items: Vec::new(),
                idle_session: None,
                team: GameHomeTeamOverviewView {
                    info: None,
                    role: None,
                    applications: Vec::new(),
                },
                task: GameHomeTaskSummaryView { tasks: Vec::new() },
                main_quest: GameHomeMainQuestProgressView {
                    current_chapter: None,
                    current_section: None,
                    completed_chapters: Vec::new(),
                    completed_sections: Vec::new(),
                    dialogue_state: None,
                    tracked: true,
                },
            },
            task_overview: GameTaskOverviewView {
                tasks: vec![GameTaskOverviewItemView {
                    id: "task-main-001".to_string(),
                    category: "main".to_string(),
                    title: "初入青云村".to_string(),
                    realm: "凡人".to_string(),
                    giver_npc_id: Some("npc-guide".to_string()),
                    map_id: Some("map-1".to_string()),
                    map_name: Some("青云村".to_string()),
                    room_id: Some("room-1".to_string()),
                    status: "ongoing".to_string(),
                    tracked: true,
                    description: "与引路童子交谈。".to_string(),
                    objectives: vec![GameTaskObjectiveView {
                        id: "obj-1".to_string(),
                        r#type: "talk_npc".to_string(),
                        text: "与引路童子交谈".to_string(),
                        done: 1,
                        target: 1,
                        params: Some(serde_json::json!({
                            "npc_id": "npc-guide"
                        })),
                        map_name: Some("青云村".to_string()),
                        map_name_type: Some("map".to_string()),
                    }],
                    rewards: vec![
                        GameTaskRewardView {
                            r#type: "silver".to_string(),
                            name: "银两".to_string(),
                            amount: 100,
                            item_def_id: None,
                            icon: None,
                            amount_max: None,
                        },
                        GameTaskRewardView {
                            r#type: "item".to_string(),
                            name: "养气散".to_string(),
                            amount: 1,
                            item_def_id: Some("item-1".to_string()),
                            icon: Some("/items/item-1.webp".to_string()),
                            amount_max: Some(2),
                        },
                    ],
                }],
            },
            task_summary: GameHomeTaskSummaryView {
                tasks: vec![GameHomeTaskSummaryItemView {
                    id: "daily-1".to_string(),
                    category: "daily".to_string(),
                    map_id: Some("map-1".to_string()),
                    room_id: Some("room-1".to_string()),
                    status: "ongoing".to_string(),
                    tracked: true,
                }],
            },
            task_npc_talk: GameNpcTalkDataView {
                npc_id: "npc-guide".to_string(),
                npc_name: "引路童子".to_string(),
                lines: vec!["欢迎来到青云村！修行之路漫漫，先从认识这里开始吧。".to_string()],
                tasks: vec![GameNpcTalkTaskOptionView {
                    task_id: "task-main-001".to_string(),
                    title: "初入青云村".to_string(),
                    category: "main".to_string(),
                    status: "turnin".to_string(),
                }],
                main_quest: Some(GameNpcTalkMainQuestOptionView {
                    section_id: "section-main-001".to_string(),
                    section_name: "初入青云".to_string(),
                    chapter_name: "第一章".to_string(),
                    status: "dialogue".to_string(),
                    can_start_dialogue: true,
                    can_complete: false,
                }),
            },
            main_quest_progress: GameHomeMainQuestProgressView {
                current_chapter: None,
                current_section: None,
                completed_chapters: vec!["chapter-1".to_string()],
                completed_sections: vec!["section-1".to_string()],
                dialogue_state: None,
                tracked: true,
            },
            main_quest_chapters: vec![GameHomeMainQuestChapterView {
                id: "chapter-1".to_string(),
                chapter_num: 1,
                name: Some("初入仙途".to_string()),
                description: Some("踏上修行".to_string()),
                background: None,
                min_realm: "凡人".to_string(),
                is_completed: true,
            }],
            main_quest_sections: vec![GameHomeMainQuestSectionView {
                id: "section-1".to_string(),
                chapter_id: Some("chapter-1".to_string()),
                section_num: 1,
                name: Some("拜入山门".to_string()),
                description: Some("完成入门试炼".to_string()),
                brief: Some("去找长老".to_string()),
                npc_id: Some("npc-1".to_string()),
                map_id: Some("map-1".to_string()),
                room_id: Some("room-1".to_string()),
                status: "completed".to_string(),
                objectives: Vec::new(),
                rewards: serde_json::json!({}),
                is_chapter_final: false,
            }],
            requested_ids,
            task_summary_requests: Arc::new(Mutex::new(Vec::new())),
            task_track_calls: Arc::new(Mutex::new(Vec::new())),
            task_talk_calls: Arc::new(Mutex::new(Vec::new())),
            task_accept_calls: Arc::new(Mutex::new(Vec::new())),
            task_claim_calls: Arc::new(Mutex::new(Vec::new())),
            task_submit_calls: Arc::new(Mutex::new(Vec::new())),
            main_quest_track_calls: Arc::new(Mutex::new(Vec::new())),
            main_quest_dialogue_start_calls: Arc::new(Mutex::new(Vec::new())),
            main_quest_dialogue_advance_calls: Arc::new(Mutex::new(Vec::new())),
            main_quest_dialogue_choice_calls: Arc::new(Mutex::new(Vec::new())),
            main_quest_section_complete_calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn with_task_summary(requested_categories: Arc<Mutex<Vec<(i64, Option<String>)>>>) -> Self {
        let mut services = Self::new();
        services.task_summary_requests = requested_categories;
        services
    }

    fn with_task_track_calls(track_calls: Arc<Mutex<Vec<(i64, String, bool)>>>) -> Self {
        let mut services = Self::new();
        services.task_track_calls = track_calls;
        services
    }

    fn with_task_accept_calls(accept_calls: Arc<Mutex<Vec<(i64, String, String)>>>) -> Self {
        let mut services = Self::new();
        services.task_accept_calls = accept_calls;
        services
    }

    fn with_task_talk_calls(talk_calls: Arc<Mutex<Vec<(i64, String)>>>) -> Self {
        let mut services = Self::new();
        services.task_talk_calls = talk_calls;
        services
    }

    fn with_task_claim_calls(claim_calls: Arc<Mutex<Vec<(i64, i64, String)>>>) -> Self {
        let mut services = Self::new();
        services.task_claim_calls = claim_calls;
        services
    }

    fn with_task_submit_calls(submit_calls: Arc<Mutex<Vec<(i64, String, String)>>>) -> Self {
        let mut services = Self::new();
        services.task_submit_calls = submit_calls;
        services
    }

    fn with_main_quest_views() -> Self {
        Self::new()
    }

    fn with_main_quest_track_calls(track_calls: Arc<Mutex<Vec<(i64, bool)>>>) -> Self {
        let mut services = Self::new();
        services.main_quest_track_calls = track_calls;
        services
    }

    fn with_main_quest_dialogue_start_calls(
        start_calls: Arc<Mutex<Vec<(i64, Option<String>)>>>,
    ) -> Self {
        let mut services = Self::new();
        services.main_quest_dialogue_start_calls = start_calls;
        services
    }

    fn with_main_quest_dialogue_advance_calls(
        advance_calls: Arc<Mutex<Vec<(i64, i64)>>>,
    ) -> Self {
        let mut services = Self::new();
        services.main_quest_dialogue_advance_calls = advance_calls;
        services
    }

    fn with_main_quest_dialogue_choice_calls(
        choice_calls: Arc<Mutex<Vec<(i64, i64, String)>>>,
    ) -> Self {
        let mut services = Self::new();
        services.main_quest_dialogue_choice_calls = choice_calls;
        services
    }

    fn with_main_quest_section_complete_calls(
        complete_calls: Arc<Mutex<Vec<(i64, i64)>>>,
    ) -> Self {
        let mut services = Self::new();
        services.main_quest_section_complete_calls = complete_calls;
        services
    }
}

impl GameRouteServices for FakeGameServices {
    fn get_home_overview<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeOverviewView, BusinessError>> + Send + 'a>>
    {
        let overview = self.overview.clone();
        let requested_ids = self.requested_ids.clone();
        Box::pin(async move {
            requested_ids
                .lock()
                .expect("record requested ids")
                .push((user_id, character_id));
            Ok(overview)
        })
    }

    fn get_task_overview_summary<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeTaskSummaryView, BusinessError>> + Send + 'a>>
    {
        let task_summary = self.task_summary.clone();
        let requests = self.task_summary_requests.clone();
        Box::pin(async move {
            requests
                .lock()
                .expect("record task summary request")
                .push((character_id, category));
            Ok(task_summary)
        })
    }

    fn get_task_overview<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameTaskOverviewView, BusinessError>> + Send + 'a>>
    {
        let task_overview = self.task_overview.clone();
        let requests = self.task_summary_requests.clone();
        Box::pin(async move {
            requests
                .lock()
                .expect("record task overview request")
                .push((character_id, category));
            Ok(task_overview)
        })
    }

    fn set_task_tracked<'a>(
        &'a self,
        character_id: i64,
        task_id: String,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskTrackDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.task_track_calls.clone();
        Box::pin(async move {
            calls.lock().expect("record task track call").push((
                character_id,
                task_id.clone(),
                tracked,
            ));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskTrackDataView { task_id, tracked }),
            })
        })
    }

    fn accept_task_from_npc<'a>(
        &'a self,
        character_id: i64,
        task_id: String,
        npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskMutationDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.task_accept_calls.clone();
        Box::pin(async move {
            calls.lock().expect("record task accept call").push((
                character_id,
                task_id.clone(),
                npc_id,
            ));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskMutationDataView { task_id }),
            })
        })
    }

    fn npc_talk<'a>(
        &'a self,
        character_id: i64,
        npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameNpcTalkDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.task_talk_calls.clone();
        let payload = self.task_npc_talk.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("record task talk call")
                .push((character_id, npc_id));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(payload),
            })
        })
    }

    fn claim_task_reward<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        task_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskClaimDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.task_claim_calls.clone();
        Box::pin(async move {
            calls.lock().expect("record task claim call").push((
                user_id,
                character_id,
                task_id.clone(),
            ));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskClaimDataView {
                    task_id,
                    rewards: vec![
                        GameTaskClaimRewardView::Silver { amount: 100 },
                        GameTaskClaimRewardView::Item {
                            item_def_id: "item-1".to_string(),
                            qty: 2,
                            item_name: Some("养气散".to_string()),
                            item_icon: Some("/items/item-1.webp".to_string()),
                        },
                    ],
                }),
            })
        })
    }

    fn submit_task_to_npc<'a>(
        &'a self,
        character_id: i64,
        task_id: String,
        npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskMutationDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.task_submit_calls.clone();
        Box::pin(async move {
            calls.lock().expect("record task submit call").push((
                character_id,
                task_id.clone(),
                npc_id,
            ));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskMutationDataView { task_id }),
            })
        })
    }

    fn get_main_quest_progress<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameHomeMainQuestProgressView, BusinessError>> + Send + 'a>,
    > {
        let progress = self.main_quest_progress.clone();
        Box::pin(async move { Ok(progress) })
    }

    fn get_main_quest_chapters<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestChapterView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let chapters = self.main_quest_chapters.clone();
        Box::pin(async move { Ok(chapters) })
    }

    fn get_main_quest_sections<'a>(
        &'a self,
        _character_id: i64,
        _chapter_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestSectionView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let sections = self.main_quest_sections.clone();
        Box::pin(async move { Ok(sections) })
    }

    fn set_main_quest_tracked<'a>(
        &'a self,
        character_id: i64,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameMainQuestTrackDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        let calls = self.main_quest_track_calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("record main quest track call")
                .push((character_id, tracked));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestTrackDataView { tracked }),
            })
        })
    }

    fn start_main_quest_dialogue<'a>(
        &'a self,
        character_id: i64,
        dialogue_id: Option<String>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        GameActionResult<GameMainQuestDialogueActionDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.main_quest_dialogue_start_calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("record main quest dialogue start call")
                .push((character_id, dialogue_id.clone()));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_dialogue_state(
                        dialogue_id.unwrap_or_else(|| "dlg-main-001".to_string()),
                    ),
                    effect_results: None,
                }),
            })
        })
    }

    fn advance_main_quest_dialogue<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        GameActionResult<GameMainQuestDialogueActionDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.main_quest_dialogue_advance_calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("record main quest dialogue advance call")
                .push((user_id, character_id));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_dialogue_state("dlg-main-001".to_string()),
                    effect_results: Some(Vec::new()),
                }),
            })
        })
    }

    fn choose_main_quest_dialogue<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        choice_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        GameActionResult<GameMainQuestDialogueActionDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.main_quest_dialogue_choice_calls.clone();
        Box::pin(async move {
            calls
                .lock()
                .expect("record main quest dialogue choice call")
                .push((user_id, character_id, choice_id));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_dialogue_state("dlg-main-001".to_string()),
                    effect_results: Some(vec![serde_json::json!({
                        "type": "item",
                        "itemDefId": "cons-001",
                        "quantity": 1
                    })]),
                }),
            })
        })
    }

    fn complete_main_quest_section<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        GameActionResult<GameMainQuestSectionCompleteDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        let calls = self.main_quest_section_complete_calls.clone();
        let next_section = self.main_quest_sections.first().cloned();
        Box::pin(async move {
            calls
                .lock()
                .expect("record main quest section complete call")
                .push((user_id, character_id));
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestSectionCompleteDataView {
                    rewards: vec![
                        serde_json::json!({
                            "type": "silver",
                            "amount": 180
                        }),
                        serde_json::json!({
                            "type": "item",
                            "itemDefId": "cons-001",
                            "quantity": 2
                        }),
                    ],
                    next_section,
                    chapter_completed: false,
                }),
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
                session_token: "game-route-session".to_string(),
                character_id: Some(1),
                team_id: None,
                sect_id: None,
            })
        })
    }
}

fn sample_character() -> CharacterBasicInfo {
    CharacterBasicInfo {
        id: 3002,
        nickname: "归云".to_string(),
        gender: "male".to_string(),
        title: "散修".to_string(),
        realm: "凡人".to_string(),
        sub_realm: None,
        auto_cast_skills: false,
        auto_disassemble_enabled: false,
        auto_disassemble_rules: Some(Vec::new()),
        dungeon_no_stamina_cost: false,
        spirit_stones: 500,
        silver: 800,
    }
}

fn sample_dialogue_state(dialogue_id: String) -> GameHomeDialogueStateView {
    GameHomeDialogueStateView {
        dialogue_id,
        current_node_id: "start".to_string(),
        current_node: Some(serde_json::json!({
            "id": "start",
            "type": "npc",
            "text": "前往青云村。"
        })),
        selected_choices: Vec::new(),
        is_complete: false,
        pending_effects: Vec::new(),
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
