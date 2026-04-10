use chrono::{Datelike, Local};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::service_result;

/**
 * signIn 签到路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/signin/overview` 与 `/api/signin/do` 两个接口，并保持 `requireAuth + sendResult` 的协议一致。
 * 2. 做什么：只负责 Bearer/session 校验、月份默认值归一化与响应序列化，把签到规则全部下沉到应用服务。
 * 3. 不做什么：不在路由层计算连签奖励、不拼数据库查询，也不处理角色资源推送。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`overview` 可选 `month=YYYY-MM`。
 * - 输出：Node 兼容 `{ success, message, data? }`。
 *
 * 数据流 / 状态流：
 * - HTTP -> 鉴权 -> 月份归一化 -> `AuthRouteServices::{get_sign_in_overview,do_sign_in}` -> `service_result`。
 *
 * 复用设计说明：
 * - 登录态校验复用共享 `require_authenticated_user_id`，避免 account/rank/character/signin 再复制一套 session 校验。
 * - 签到月份默认值统一集中在这里，首页聚合与签到页直连都会拿到一致的默认月份口径。
 *
 * 关键边界条件与坑点：
 * 1. `overview` 缺省月份必须回退到当前本地年月，不能改成 UTC 月份，否则会和 Node 当前行为错位。
 * 2. 签到业务失败仍走 `sendResult` 语义，不得擅自改成异常抛 400。
 */
#[derive(Debug, Deserialize)]
struct SignInOverviewQuery {
    month: Option<String>,
}

pub fn build_sign_in_router() -> Router<AppState> {
    Router::new()
        .route("/overview", get(sign_in_overview_handler))
        .route("/do", post(do_sign_in_handler))
}

async fn sign_in_overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SignInOverviewQuery>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state
        .auth_services
        .get_sign_in_overview(user_id, resolve_month(query.month))
        .await?;
    Ok(service_result(result))
}

async fn do_sign_in_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let result = state.auth_services.do_sign_in(user_id).await?;
    Ok(service_result(result))
}

fn resolve_month(month: Option<String>) -> String {
    let raw = month.unwrap_or_default();
    let normalized = raw.trim();
    if !normalized.is_empty() {
        return normalized.to_string();
    }

    let now = Local::now();
    format!("{:04}-{:02}", now.year(), now.month())
}
