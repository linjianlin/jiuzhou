use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use tracing::{error, info};

use crate::bootstrap::app::AppState;

/**
 * afdian webhook 协议路由。
 *
 * 作用：
 * 1. 做什么：实现 Node 当前 `/api/afdian/webhook` 的 GET/POST 协议，并固定 `{ ec, em }` 响应形状。
 * 2. 做什么：把“非订单测试请求直接成功”和“业务失败统一映射 400”的协议差异封装在单一出口，避免落回通用 `success/message` envelope。
 * 3. 不做什么：不在这里做 OpenAPI 回查、订单落库、兑换码生成，这些都应继续下沉到应用服务。
 *
 * 输入 / 输出：
 * - 输入：爱发电 webhook JSON 负载。
 * - 输出：成功固定 `200 { ec:200, em:'' }`；业务失败固定 `400 { ec:400, em:<message> }`。
 *
 * 数据流 / 状态流：
 * - HTTP webhook -> 判断是否为订单事件 -> `AfdianRouteServices::handle_webhook` -> `{ ec, em }` 协议响应。
 *
 * 复用设计说明：
 * - webhook 专用响应 DTO 和事件判断 helper 集中在这里，避免后续补后台重放工具或对拍测试时再复制一份 `{ ec, em }` 适配代码。
 * - 应用服务只接收已经判定为订单事件的 typed payload，减少上层/下层对“测试请求是否忽略”的重复判断。
 *
 * 关键边界条件与坑点：
 * 1. 非订单测试请求必须继续返回成功，不能误报 400，否则平台会反复重试。
 * 2. 这里不能复用通用业务错误 envelope；一旦输出成 `{ success:false, message }` 就会破坏 Node 兼容协议。
 */
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AfdianWebhookPayloadInput {
    pub ec: Option<i32>,
    pub em: Option<String>,
    pub sign: Option<String>,
    pub data: Option<AfdianWebhookDataInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AfdianWebhookDataInput {
    #[serde(rename = "type")]
    pub data_type: Option<String>,
    pub order: Option<AfdianWebhookOrderInput>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct AfdianWebhookOrderInput {
    pub out_trade_no: Option<String>,
    pub custom_order_id: Option<String>,
    pub user_id: Option<String>,
    pub user_private_id: Option<String>,
    pub plan_id: Option<String>,
    pub month: Option<i32>,
    pub total_amount: Option<String>,
    pub status: Option<serde_json::Number>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AfdianRouteError {
    pub message: String,
}

impl AfdianRouteError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

pub trait AfdianRouteServices: Send + Sync {
    fn handle_webhook<'a>(
        &'a self,
        payload: AfdianWebhookPayloadInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), AfdianRouteError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopAfdianRouteServices;

impl AfdianRouteServices for NoopAfdianRouteServices {
    fn handle_webhook<'a>(
        &'a self,
        _payload: AfdianWebhookPayloadInput,
    ) -> Pin<Box<dyn Future<Output = Result<(), AfdianRouteError>> + Send + 'a>> {
        Box::pin(async move { Ok(()) })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct AfdianWebhookResponse {
    ec: i32,
    em: String,
}

pub fn build_afdian_router() -> Router<AppState> {
    Router::new().route(
        "/webhook",
        get(get_webhook_handler).post(post_webhook_handler),
    )
}

async fn get_webhook_handler() -> Response {
    afdian_ok_response()
}

async fn post_webhook_handler(
    State(state): State<AppState>,
    Json(payload): Json<AfdianWebhookPayloadInput>,
) -> Response {
    if !has_afdian_webhook_order_payload(&payload) {
        info!("ignored non-order afdian webhook payload");
        return afdian_ok_response();
    }

    match state.afdian_services.handle_webhook(payload).await {
        Ok(()) => afdian_ok_response(),
        Err(error) => {
            error!(message = %error.message, "afdian webhook processing failed");
            afdian_error_response(error.message)
        }
    }
}

fn has_afdian_webhook_order_payload(payload: &AfdianWebhookPayloadInput) -> bool {
    payload
        .data
        .as_ref()
        .is_some_and(|data| data.data_type.as_deref() == Some("order") && data.order.is_some())
}

fn afdian_ok_response() -> Response {
    (
        StatusCode::OK,
        axum::Json(AfdianWebhookResponse {
            ec: 200,
            em: String::new(),
        }),
    )
        .into_response()
}

fn afdian_error_response(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(AfdianWebhookResponse {
            ec: 400,
            em: message,
        }),
    )
        .into_response()
}
