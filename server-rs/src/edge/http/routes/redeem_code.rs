use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::application::reward_payload::GrantedRewardPreviewView;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{require_authenticated_character_context, resolve_request_ip};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * redeem-code 兑换码路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/redeem-code/redeem` 的角色鉴权、空码校验与 `sendResult` 响应合同。
 * 2. 做什么：把登录态、角色上下文和请求 IP 解析统一收敛到入口，避免 handler 再拼重复鉴权逻辑。
 * 3. 不做什么：不直接操作数据库，不处理奖励发放细节，也不在这里维护防爆破状态。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token，请求体 `{ code }`。
 * - 输出：成功或失败都走 Node 兼容 `{ success, message, data? }`；角色缺失继续返回 `404 角色不存在`。
 *
 * 数据流 / 状态流：
 * - 请求 -> `require_authenticated_character_context`
 * - -> `RedeemCodeRouteServices::redeem_code`
 * - -> 路由层统一包装 `sendResult` 语义。
 *
 * 复用设计说明：
 * - 角色上下文与请求 IP 都复用共享 helper，后续补 `mail / market / game` 等登录态接口时可继续沿用，不需要再各自拼一套。
 * - `RedeemCodeRewardView` 与 `RedeemCodeSuccessData` 由路由、服务、合同测试共用，确保奖励返回 shape 只有一个真值定义。
 *
 * 关键边界条件与坑点：
 * 1. 空兑换码必须继续是业务失败文案 `兑换码不能为空`，不能在路由层 silent trim 后伪造成功。
 * 2. 兑换失败仍要返回 HTTP 200 + `success:false`，不能擅自改成 4xx。
 */
#[derive(Debug, Deserialize)]
pub struct RedeemCodePayload {
    pub code: Option<String>,
}

pub type RedeemCodeRewardView = GrantedRewardPreviewView;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RedeemCodeSuccessData {
    pub code: String,
    pub rewards: Vec<RedeemCodeRewardView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct RedeemCodeFailureResponse {
    success: bool,
    message: String,
}

pub trait RedeemCodeRouteServices: Send + Sync {
    fn redeem_code<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        code: String,
        request_ip: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopRedeemCodeRouteServices;

impl RedeemCodeRouteServices for NoopRedeemCodeRouteServices {
    fn redeem_code<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _code: String,
        _request_ip: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("兑换码不存在".to_string()),
                None,
            ))
        })
    }
}

pub fn build_redeem_code_router() -> Router<AppState> {
    Router::new().route("/redeem", post(redeem_code_handler))
}

async fn redeem_code_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RedeemCodePayload>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };

    let code = payload.code.unwrap_or_default();
    if code.trim().is_empty() {
        return Ok(Json(RedeemCodeFailureResponse {
            success: false,
            message: "兑换码不能为空".to_string(),
        })
        .into_response());
    }

    let result = state
        .redeem_code_services
        .redeem_code(
            context.user_id,
            context.character.id,
            code,
            resolve_request_ip(&headers),
        )
        .await?;
    Ok(service_result(result))
}
