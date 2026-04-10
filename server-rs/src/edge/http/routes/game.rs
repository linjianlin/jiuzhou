use std::{future::Future, pin::Pin};

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::application::account::service::PhoneBindingStatusDto;
use crate::application::inventory::service::InventoryItemView;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;
use crate::edge::http::routes::idle::IdleSessionView;
use crate::edge::http::routes::realm::RealmOverviewView;

/**
 * game 首页聚合路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/game/home-overview`，把首页首屏初始化需要的聚合快照通过单一接口返回。
 * 2. 做什么：统一复用 `require_authenticated_character_context`，保持 requireCharacter 的鉴权与“角色不存在”语义一致。
 * 3. 不做什么：不在路由层拼 SQL，不重写签到/境界/背包等领域规则，也不扩展成首页以外的通用聚合网关。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token。
 * - 输出：`{ success: true, data }`，其中 `data` 为 Node 兼容首页聚合 DTO。
 *
 * 数据流 / 状态流：
 * - HTTP -> 统一鉴权/角色校验 -> `GameRouteServices` -> `success(...)` 输出。
 *
 * 复用设计说明：
 * - 首页首屏与后续可能的预热场景都依赖同一聚合协议；把 DTO 与 trait 固定在这里后，应用服务和 contract test 共用一份结构，避免 shape 漂移。
 * - 该路由只依赖 `AppState.game_services`，后续继续扩展 `game` 命名空间路由时可复用同一接线模式，而不是在 `bootstrap/app.rs` 里继续堆匿名 handler。
 *
 * 关键边界条件与坑点：
 * 1. 这里必须保持 `requireCharacter` 语义，不能退化成仅 requireAuth，否则首页会在“未创建角色”时错误返回空快照。
 * 2. 成功响应固定走 `success(data)`，不能误用 `service_result` 带上 message，否则会和 Node 当前首页接口包体不一致。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeSignInView {
    pub current_month: String,
    pub signed_today: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeAchievementView {
    pub claimable_count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeTeamMemberView {
    pub id: String,
    pub character_id: i64,
    pub name: String,
    pub month_card_active: bool,
    pub role: String,
    pub realm: String,
    pub online: bool,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeTeamInfoView {
    pub id: String,
    pub name: String,
    pub leader: String,
    pub leader_id: i64,
    pub leader_month_card_active: bool,
    pub members: Vec<GameHomeTeamMemberView>,
    pub member_count: i32,
    pub max_members: i32,
    pub goal: String,
    pub join_min_realm: String,
    pub auto_join_enabled: bool,
    pub auto_join_min_realm: String,
    pub current_map_id: Option<String>,
    pub is_public: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeTeamApplicationView {
    pub id: String,
    pub character_id: i64,
    pub name: String,
    pub month_card_active: bool,
    pub realm: String,
    pub avatar: Option<String>,
    pub message: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeTeamOverviewView {
    pub info: Option<GameHomeTeamInfoView>,
    pub role: Option<String>,
    pub applications: Vec<GameHomeTeamApplicationView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeTaskSummaryItemView {
    pub id: String,
    pub category: String,
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub tracked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GameHomeTaskSummaryView {
    pub tasks: Vec<GameHomeTaskSummaryItemView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskObjectiveView {
    pub id: String,
    pub r#type: String,
    pub text: String,
    pub done: i32,
    pub target: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    pub map_name: Option<String>,
    pub map_name_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskRewardView {
    pub r#type: String,
    pub name: String,
    pub amount: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_def_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_max: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskOverviewItemView {
    pub id: String,
    pub category: String,
    pub title: String,
    pub realm: String,
    pub giver_npc_id: Option<String>,
    pub map_id: Option<String>,
    pub map_name: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub tracked: bool,
    pub description: String,
    pub objectives: Vec<GameTaskObjectiveView>,
    pub rewards: Vec<GameTaskRewardView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GameTaskOverviewView {
    pub tasks: Vec<GameTaskOverviewItemView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeDialogueStateView {
    pub dialogue_id: String,
    pub current_node_id: String,
    pub current_node: Option<serde_json::Value>,
    pub selected_choices: Vec<String>,
    pub is_complete: bool,
    pub pending_effects: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeMainQuestChapterView {
    pub id: String,
    pub chapter_num: i32,
    pub name: Option<String>,
    pub description: Option<String>,
    pub background: Option<String>,
    pub min_realm: String,
    pub is_completed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeMainQuestSectionObjectiveView {
    pub id: Option<String>,
    pub r#type: Option<String>,
    pub text: Option<String>,
    pub target: i32,
    pub done: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeMainQuestSectionView {
    pub id: String,
    pub chapter_id: Option<String>,
    pub section_num: i32,
    pub name: Option<String>,
    pub description: Option<String>,
    pub brief: Option<String>,
    pub npc_id: Option<String>,
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub objectives: Vec<GameHomeMainQuestSectionObjectiveView>,
    pub rewards: serde_json::Value,
    pub is_chapter_final: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeMainQuestProgressView {
    pub current_chapter: Option<GameHomeMainQuestChapterView>,
    pub current_section: Option<GameHomeMainQuestSectionView>,
    pub completed_chapters: Vec<String>,
    pub completed_sections: Vec<String>,
    pub dialogue_state: Option<GameHomeDialogueStateView>,
    pub tracked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeOverviewView {
    pub sign_in: GameHomeSignInView,
    pub achievement: GameHomeAchievementView,
    pub phone_binding: PhoneBindingStatusDto,
    pub realm_overview: Option<RealmOverviewView>,
    pub equipped_items: Vec<InventoryItemView>,
    pub idle_session: Option<IdleSessionView>,
    pub team: GameHomeTeamOverviewView,
    pub task: GameHomeTaskSummaryView,
    pub main_quest: GameHomeMainQuestProgressView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameActionResult<T> {
    pub success: bool,
    pub message: String,
    pub data: Option<T>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskTrackDataView {
    pub task_id: String,
    pub tracked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskMutationDataView {
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameNpcTalkTaskOptionView {
    pub task_id: String,
    pub title: String,
    pub category: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameNpcTalkMainQuestOptionView {
    pub section_id: String,
    pub section_name: String,
    pub chapter_name: String,
    pub status: String,
    pub can_start_dialogue: bool,
    pub can_complete: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameNpcTalkDataView {
    pub npc_id: String,
    pub npc_name: String,
    pub lines: Vec<String>,
    pub tasks: Vec<GameNpcTalkTaskOptionView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_quest: Option<GameNpcTalkMainQuestOptionView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GameTaskClaimRewardView {
    Silver {
        amount: i64,
    },
    SpiritStones {
        amount: i64,
    },
    #[serde(rename_all = "camelCase")]
    Item {
        item_def_id: String,
        qty: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameTaskClaimDataView {
    pub task_id: String,
    pub rewards: Vec<GameTaskClaimRewardView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GameMainQuestTrackDataView {
    pub tracked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameMainQuestDialogueActionDataView {
    pub dialogue_state: GameHomeDialogueStateView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_results: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GameMainQuestSectionCompleteDataView {
    pub rewards: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_section: Option<GameHomeMainQuestSectionView>,
    pub chapter_completed: bool,
}

pub trait GameRouteServices: Send + Sync {
    fn get_home_overview<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeOverviewView, BusinessError>> + Send + 'a>>;

    fn get_task_overview<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameTaskOverviewView, BusinessError>> + Send + 'a>>;

    fn get_task_overview_summary<'a>(
        &'a self,
        character_id: i64,
        category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeTaskSummaryView, BusinessError>> + Send + 'a>>;

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
    >;

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
    >;

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
    >;

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
    >;

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
    >;

    fn get_main_quest_progress<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<GameHomeMainQuestProgressView, BusinessError>> + Send + 'a>,
    >;

    fn get_main_quest_chapters<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestChapterView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_main_quest_sections<'a>(
        &'a self,
        character_id: i64,
        chapter_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<GameHomeMainQuestSectionView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

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
    >;

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
    >;

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
    >;

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
    >;

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
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopGameRouteServices;

impl GameRouteServices for NoopGameRouteServices {
    fn get_home_overview<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(GameHomeOverviewView {
                sign_in: GameHomeSignInView {
                    current_month: String::new(),
                    signed_today: false,
                },
                achievement: GameHomeAchievementView { claimable_count: 0 },
                phone_binding: PhoneBindingStatusDto {
                    enabled: false,
                    is_bound: false,
                    masked_phone_number: None,
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
            })
        })
    }

    fn get_task_overview<'a>(
        &'a self,
        _character_id: i64,
        _category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameTaskOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(GameTaskOverviewView { tasks: Vec::new() }) })
    }

    fn get_task_overview_summary<'a>(
        &'a self,
        _character_id: i64,
        _category: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<GameHomeTaskSummaryView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(GameHomeTaskSummaryView { tasks: Vec::new() }) })
    }

    fn set_task_tracked<'a>(
        &'a self,
        _character_id: i64,
        task_id: String,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskTrackDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskTrackDataView { task_id, tracked }),
            })
        })
    }

    fn accept_task_from_npc<'a>(
        &'a self,
        _character_id: i64,
        task_id: String,
        _npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskMutationDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskMutationDataView { task_id }),
            })
        })
    }

    fn claim_task_reward<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        task_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskClaimDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameTaskClaimDataView {
                    task_id,
                    rewards: Vec::new(),
                }),
            })
        })
    }

    fn npc_talk<'a>(
        &'a self,
        _character_id: i64,
        npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameNpcTalkDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameNpcTalkDataView {
                    npc_id,
                    npc_name: "引路童子".to_string(),
                    lines: vec!["欢迎来到青云村！".to_string()],
                    tasks: Vec::new(),
                    main_quest: None,
                }),
            })
        })
    }

    fn submit_task_to_npc<'a>(
        &'a self,
        _character_id: i64,
        task_id: String,
        _npc_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameTaskMutationDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
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
        Box::pin(async move {
            Ok(GameHomeMainQuestProgressView {
                current_chapter: None,
                current_section: None,
                completed_chapters: Vec::new(),
                completed_sections: Vec::new(),
                dialogue_state: None,
                tracked: true,
            })
        })
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
        Box::pin(async move { Ok(Vec::new()) })
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
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn set_main_quest_tracked<'a>(
        &'a self,
        _character_id: i64,
        tracked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<GameActionResult<GameMainQuestTrackDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestTrackDataView { tracked }),
            })
        })
    }

    fn start_main_quest_dialogue<'a>(
        &'a self,
        _character_id: i64,
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
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_main_quest_dialogue_state(
                        dialogue_id.unwrap_or_else(|| "dialogue-noop".to_string()),
                    ),
                    effect_results: None,
                }),
            })
        })
    }

    fn advance_main_quest_dialogue<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
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
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_main_quest_dialogue_state("dialogue-noop".to_string()),
                    effect_results: Some(Vec::new()),
                }),
            })
        })
    }

    fn choose_main_quest_dialogue<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _choice_id: String,
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
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestDialogueActionDataView {
                    dialogue_state: sample_main_quest_dialogue_state("dialogue-noop".to_string()),
                    effect_results: Some(Vec::new()),
                }),
            })
        })
    }

    fn complete_main_quest_section<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
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
        Box::pin(async move {
            Ok(GameActionResult {
                success: true,
                message: "ok".to_string(),
                data: Some(GameMainQuestSectionCompleteDataView {
                    rewards: vec![serde_json::json!({
                        "type": "silver",
                        "amount": 100
                    })],
                    next_section: None,
                    chapter_completed: false,
                }),
            })
        })
    }
}

pub fn build_game_router() -> Router<AppState> {
    Router::new().route("/home-overview", get(home_overview_handler))
}

async fn home_overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };

    let overview = state
        .game_services
        .get_home_overview(context.user_id, context.character.id)
        .await?;
    Ok(success(overview))
}

fn sample_main_quest_dialogue_state(dialogue_id: String) -> GameHomeDialogueStateView {
    GameHomeDialogueStateView {
        dialogue_id,
        current_node_id: "start".to_string(),
        current_node: Some(serde_json::json!({
            "id": "start",
            "type": "npc",
            "text": "noop",
        })),
        selected_choices: Vec::new(),
        is_complete: false,
        pending_effects: Vec::new(),
    }
}
