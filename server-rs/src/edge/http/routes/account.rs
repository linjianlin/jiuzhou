use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{require_authenticated_user_id, resolve_request_ip};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * account 账号级只读路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node 当前已经公开且前端依赖的 `/current-ip` 与 `/phone-binding/status` 两个账号级读取接口。
 * 2. 做什么：复用现有 Bearer + session 鉴权链，并把手机号绑定状态读取下沉到应用服务，避免其它聚合接口重复查 `users.phone_number`。
 * 3. 不做什么：不实现短信发送、手机号绑定提交与密码修改，这些仍依赖额外外部服务与风控链路。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`current-ip` 额外读取 `x-forwarded-for/x-real-ip`。
 * - 输出：`/current-ip` 返回 `{ ip }`，`/phone-binding/status` 返回 `{ enabled, isBound, maskedPhoneNumber }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> 统一 session 校验 -> 应用服务读取账号状态 / 直接解析请求 IP -> Node 兼容 success envelope。
 *
 * 复用设计说明：
 * - 认证结果与手机号绑定状态后续会被首页聚合、坊市守卫等能力复用；这里先固定账号级只读协议，后续其它模块直接复用同一服务即可，不必再复制 `user_id -> phone_number` 查询。
 * - 请求 IP 解析复用共享 helper，避免 auth/account/审计链路各自长一套 `x-forwarded-for` 取值规则。
 *
 * 关键边界条件与坑点：
 * 1. 鉴权失败必须继续返回 Node 现有 `401 登录状态无效，请重新登录`，被踢下线时保留 `kicked:true`。
 * 2. `x-forwarded-for` 可能包含多个 IP，这里必须继续取第一个值，保持和 Node 当前网关口径一致。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct CurrentIpPayload {
    ip: String,
}

pub fn build_account_router() -> Router<AppState> {
    Router::new()
        .route("/current-ip", get(current_ip_handler))
        .route("/phone-binding/status", get(phone_binding_status_handler))
}

async fn current_ip_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(success(CurrentIpPayload {
        ip: resolve_request_ip(&headers),
    }))
}

async fn phone_binding_status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };

    let status = state
        .auth_services
        .get_phone_binding_status(user_id)
        .await?;
    Ok(success(status))
}
