use axum::extract::{Json, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * task 独立路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/task/overview/summary` 与 `/api/task/track` 两个已被首页/任务面板复用的最小 HTTP 合同。
 * 2. 做什么：统一复用 `require_authenticated_character_context`，保持 requireCharacter 的鉴权与 `404 角色不存在` 语义一致。
 * 3. 不做什么：不在这里扩展 NPC 接取、提交、领奖等完整任务写链路；这些仍等待后续领域迁移。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；summary 可带 `category` query；track 接收 `{ taskId, tracked }`。
 * - 输出：summary 返回 `{ success:true, data:{ tasks } }`；track 返回 Node 兼容 `sendResult` 包体。
 *
 * 数据流 / 状态流：
 * - HTTP -> 鉴权/角色解析 -> `GameRouteServices` 任务摘要/追踪接口 -> 统一 envelope。
 *
 * 复用设计说明：
 * - 首页聚合与任务摘要共用同一份 `GameHomeTaskSummaryView`，避免 `game/task` 两条读链路各自维护任务状态映射。
 * - track 写接口继续复用同一服务边界，把 `任务ID不能为空`、`任务不存在`、解锁文案收敛到一处，后续完整任务路由可以直接沿用。
 *
 * 关键边界条件与坑点：
 * 1. `tracked` 必须保持 Node 的宽松布尔语义，只有显式 `true` 才写入 true，其它值都视为 false。
 * 2. `taskId` 为空时不能在路由层改造成异常包，必须继续走 `sendResult` 的业务失败形状。
 */
#[derive(Debug, Deserialize)]
struct TaskOverviewSummaryQuery {
    category: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskTrackPayload {
    task_id: Option<String>,
    tracked: Option<bool>,
}

pub fn build_task_router() -> Router<AppState> {
    Router::new()
        .route("/overview/summary", get(task_overview_summary_handler))
        .route("/track", post(task_track_handler))
}

async fn task_overview_summary_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TaskOverviewSummaryQuery>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let data = state
        .game_services
        .get_task_overview_summary(context.character.id, query.category)
        .await?;
    Ok(success(data))
}

async fn task_track_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TaskTrackPayload>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let result = state
        .game_services
        .set_task_tracked(
            context.character.id,
            payload.task_id.unwrap_or_default(),
            payload.tracked == Some(true),
        )
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}
