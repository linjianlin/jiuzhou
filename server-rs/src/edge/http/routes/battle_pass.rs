use std::{future::Future, pin::Pin};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * battlepass 战令路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/battlepass/tasks`、`/api/battlepass/tasks/:taskId/complete`、`/api/battlepass/status`、`/api/battlepass/rewards` 四个接口。
 * 2. 做什么：统一复用 `requireAuth` 鉴权与成功/失败 envelope，避免各 handler 重复拼 session 校验和 query 解析。
 * 3. 不做什么：不在这里实现奖励领取、副作用推送或事件驱动任务累加；这些保留给后续战令剩余迁移。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`tasks/rewards` 可选 `seasonId` query；完成任务走 `:taskId` path。
 * - 输出：`tasks/status/rewards` 走 `sendSuccess` 形状，`complete` 走 `sendResult` 形状。
 *
 * 数据流 / 状态流：
 * - 请求 -> `require_authenticated_user_id` -> `BattlePassRouteServices`
 * - 只读接口直接输出成功包；完成接口透传业务结果。
 *
 * 复用设计说明：
 * - `BattlePass*View` 在路由、应用服务、合同测试之间共用，字段协议只维护一份。
 * - query/path 解析集中在这一层，后续若首页聚合也需要读战令，只要复用服务层，不必再重复处理鉴权和参数归一化。
 *
 * 关键边界条件与坑点：
 * 1. `status` 在 Node 里数据不存在会抛 404，不能退化成 `200 + null`。
 * 2. `seasonId` 只做去空白，不在路由层擅自追加回退逻辑，保持 Node 的赛季解析仍由服务层统一负责。
 */
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassTaskView {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "taskType")]
    pub task_type: String,
    pub condition: Value,
    #[serde(rename = "targetValue")]
    pub target_value: i64,
    #[serde(rename = "rewardExp")]
    pub reward_exp: i64,
    #[serde(rename = "rewardExtra")]
    pub reward_extra: Vec<Value>,
    pub enabled: bool,
    #[serde(rename = "sortWeight")]
    pub sort_weight: i64,
    #[serde(rename = "progressValue")]
    pub progress_value: i64,
    pub completed: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassTasksOverviewView {
    pub season_id: String,
    pub daily: Vec<BattlePassTaskView>,
    pub weekly: Vec<BattlePassTaskView>,
    pub season: Vec<BattlePassTaskView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassStatusView {
    pub season_id: String,
    pub season_name: String,
    pub exp: i64,
    pub level: i64,
    pub max_level: i64,
    pub exp_per_level: i64,
    pub premium_unlocked: bool,
    pub claimed_free_levels: Vec<i64>,
    pub claimed_premium_levels: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassRewardItemView {
    #[serde(rename = "type")]
    pub reward_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_def_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassRewardView {
    pub level: i64,
    pub free_rewards: Vec<BattlePassRewardItemView>,
    pub premium_rewards: Vec<BattlePassRewardItemView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteBattlePassTaskDataView {
    pub task_id: String,
    pub task_type: String,
    pub gained_exp: i64,
    pub exp: i64,
    pub level: i64,
    pub max_level: i64,
    pub exp_per_level: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct BattlePassSeasonQuery {
    #[serde(rename = "seasonId")]
    season_id: Option<String>,
}

pub trait BattlePassRouteServices: Send + Sync {
    fn get_tasks_overview<'a>(
        &'a self,
        user_id: i64,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<BattlePassTasksOverviewView, BusinessError>> + Send + 'a>>;

    fn complete_task<'a>(
        &'a self,
        user_id: i64,
        task_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<CompleteBattlePassTaskDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;

    fn get_status<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<BattlePassStatusView>, BusinessError>> + Send + 'a>,
    >;

    fn get_rewards<'a>(
        &'a self,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<BattlePassRewardView>, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopBattlePassRouteServices;

impl BattlePassRouteServices for NoopBattlePassRouteServices {
    fn get_tasks_overview<'a>(
        &'a self,
        _user_id: i64,
        season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<BattlePassTasksOverviewView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(BattlePassTasksOverviewView {
                season_id: season_id.unwrap_or_default(),
                daily: Vec::new(),
                weekly: Vec::new(),
                season: Vec::new(),
            })
        })
    }

    fn complete_task<'a>(
        &'a self,
        _user_id: i64,
        _task_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<CompleteBattlePassTaskDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("任务不存在或未启用".to_string()),
                None,
            ))
        })
    }

    fn get_status<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<BattlePassStatusView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(None) })
    }

    fn get_rewards<'a>(
        &'a self,
        _season_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<BattlePassRewardView>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { Ok(Vec::new()) })
    }
}

pub fn build_battle_pass_router() -> Router<AppState> {
    Router::new()
        .route("/tasks", get(get_tasks_handler))
        .route("/tasks/{task_id}/complete", post(complete_task_handler))
        .route("/status", get(get_status_handler))
        .route("/rewards", get(get_rewards_handler))
}

async fn get_tasks_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BattlePassSeasonQuery>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let view = state
        .battle_pass_services
        .get_tasks_overview(user_id, normalize_optional_query_text(query.season_id))
        .await?;
    Ok(success(view))
}

async fn complete_task_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .battle_pass_services
        .complete_task(user_id, task_id)
        .await?;
    Ok(service_result(result))
}

async fn get_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let Some(view) = state.battle_pass_services.get_status(user_id).await? else {
        return Err(BusinessError::with_status(
            "战令数据不存在",
            StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(view))
}

async fn get_rewards_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BattlePassSeasonQuery>,
) -> Result<Response, BusinessError> {
    let _user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let view = state
        .battle_pass_services
        .get_rewards(normalize_optional_query_text(query.season_id))
        .await?;
    Ok(success(view))
}

fn normalize_optional_query_text(value: Option<String>) -> Option<String> {
    value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}
