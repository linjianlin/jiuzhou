use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::application::arena::service::{
    get_arena_opponents, get_arena_records, get_arena_status,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::service_result;

/**
 * arena 竞技场路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/arena/status|opponents|records` 三条只读接口，并保持 `requireCharacter + sendResult` 的 HTTP 合同一致。
 * 2. 做什么：路由层只负责 Bearer 鉴权、角色上下文提取与 limit 归一化，具体 projection 读取与排序规则统一复用应用服务。
 * 3. 不做什么：不在这里发起竞技场匹配、不创建 PVP battle session，也不直接扫描 Redis。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`opponents/records` 可接收 `limit` 查询参数。
 * - 输出：统一 `{ success, message, data? }`，字段命名保持 Node 当前 camelCase 协议。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_character_context` -> arena 应用服务读取 runtime registry -> `service_result(...)` 输出。
 *
 * 复用设计说明：
 * - 竞技场只读接口共用一套角色鉴权与 limit 解析，后续补 `/challenge`、`/match` 时可以复用同一入口和 DTO，不必再写第二套合同定义。
 * - 只读逻辑全部收口到 `application::arena::service`，避免路由层重复读取 projection、重复解释 score/power/record 字段。
 *
 * 关键边界条件与坑点：
 * 1. 这里必须保持 `requireCharacter` 语义，未建角账号应直接返回 `404 角色不存在`，不能退化成只校验 token。
 * 2. `limit` 非法时要回退 Node 默认值，而不是直接报错，否则会破坏现有前端查询兼容性。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArenaStatusView {
    pub score: i64,
    pub win_count: i64,
    pub lose_count: i64,
    pub today_used: i64,
    pub today_limit: i64,
    pub today_remaining: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArenaOpponentView {
    pub id: i64,
    pub name: String,
    pub realm: String,
    pub power: i64,
    pub score: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRecordView {
    pub id: String,
    pub ts: i64,
    pub opponent_name: String,
    pub opponent_realm: String,
    pub opponent_power: i64,
    pub result: String,
    pub delta_score: i64,
    pub score_after: i64,
}

#[derive(Debug, Deserialize)]
pub struct ArenaLimitQuery {
    pub limit: Option<String>,
}

pub fn build_arena_router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status_handler))
        .route("/opponents", get(opponents_handler))
        .route("/records", get(records_handler))
}

async fn status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let character = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context.character,
        Err(response) => return Ok(response),
    };
    let result = get_arena_status(&state.runtime_services, character.id).await?;
    Ok(service_result(result))
}

async fn opponents_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ArenaLimitQuery>,
) -> Result<Response, BusinessError> {
    let character = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context.character,
        Err(response) => return Ok(response),
    };
    let result = get_arena_opponents(
        &state.runtime_services,
        character.id,
        parse_positive_i64(query.limit.as_deref()),
    )
    .await?;
    Ok(service_result(result))
}

async fn records_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ArenaLimitQuery>,
) -> Result<Response, BusinessError> {
    let character = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context.character,
        Err(response) => return Ok(response),
    };
    let result = get_arena_records(
        &state.runtime_services,
        character.id,
        parse_positive_i64(query.limit.as_deref()),
    )
    .await?;
    Ok(service_result(result))
}

fn parse_positive_i64(raw: Option<&str>) -> Option<i64> {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
}
