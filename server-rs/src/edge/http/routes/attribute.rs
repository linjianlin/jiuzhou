use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json as AxumJson, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * attribute 属性加点路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/attribute/add|remove|batch|reset` 四个接口，并保持 `requireAuth + sendResult` 的合同一致。
 * 2. 做什么：只负责 Bearer/session 鉴权、请求体字段归一化和响应封装，把点数校验与写库全部下沉到应用服务。
 * 3. 不做什么：不推送角色刷新事件，不在路由层拼接 SQL，也不扩展属性面板读取接口。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`add/remove` 接收 `{ attribute, amount? }`，`batch` 接收 `{ jing?, qi?, shen? }`。
 * - 输出：Node 兼容 `{ success, message, data? }`；`reset` 额外保持顶层 `totalPoints` 字段。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_user_id` -> 路由层做最小参数归一化 -> `AttributeRouteServices`
 * - -> 统一输出 `sendResult` 兼容 JSON。
 *
 * 复用设计说明：
 * - 四个 handler 共用同一鉴权入口和数值解析 helper，避免每条写路由各自拼登录态校验与 JSON 取值逻辑。
 * - `AttributeRouteServices` 把 HTTP 协议与写库实现解耦，后续若补 Socket 或后台批处理入口，可以直接复用同一服务层。
 *
 * 关键边界条件与坑点：
 * 1. `attribute` 缺失时必须返回 `400 请指定属性类型`，不能默默兜底成默认属性。
 * 2. `reset` 的 `totalPoints` 必须保留在顶层，不能塞进 `data`，否则会破坏前端现有类型契约。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AttributeMutationPayload {
    pub attribute: String,
    #[serde(rename = "newValue")]
    pub new_value: i32,
    #[serde(rename = "remainingPoints")]
    pub remaining_points: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AttributeResetResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "totalPoints", skip_serializing_if = "Option::is_none")]
    pub total_points: Option<i32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttributeBatchInput {
    pub jing: i32,
    pub qi: i32,
    pub shen: i32,
}

#[derive(Debug, Deserialize)]
struct AttributeMutationBody {
    #[serde(default)]
    attribute: Option<String>,
    #[serde(default)]
    amount: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct AttributeBatchBody {
    #[serde(default)]
    jing: Option<Value>,
    #[serde(default)]
    qi: Option<Value>,
    #[serde(default)]
    shen: Option<Value>,
}

pub trait AttributeRouteServices: Send + Sync {
    fn add_attribute_point<'a>(
        &'a self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn remove_attribute_point<'a>(
        &'a self,
        user_id: i64,
        attribute: String,
        amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn batch_add_points<'a>(
        &'a self,
        user_id: i64,
        input: AttributeBatchInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn reset_attribute_points<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<AttributeResetResponse, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopAttributeRouteServices;

impl AttributeRouteServices for NoopAttributeRouteServices {
    fn add_attribute_point<'a>(
        &'a self,
        _user_id: i64,
        _attribute: String,
        _amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("无效的属性类型".to_string()),
                None,
            ))
        })
    }

    fn remove_attribute_point<'a>(
        &'a self,
        _user_id: i64,
        _attribute: String,
        _amount: i32,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("无效的属性类型".to_string()),
                None,
            ))
        })
    }

    fn batch_add_points<'a>(
        &'a self,
        _user_id: i64,
        _input: AttributeBatchInput,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<AttributeMutationPayload>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("请指定加点数量".to_string()),
                None,
            ))
        })
    }

    fn reset_attribute_points<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<AttributeResetResponse, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(AttributeResetResponse {
                success: false,
                message: "重置失败".to_string(),
                total_points: None,
            })
        })
    }
}

pub fn build_attribute_router() -> Router<AppState> {
    Router::new()
        .route("/add", post(add_attribute_handler))
        .route("/remove", post(remove_attribute_handler))
        .route("/batch", post(batch_add_points_handler))
        .route("/reset", post(reset_attribute_handler))
}

async fn add_attribute_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AttributeMutationBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let attribute = normalize_required_attribute(body.attribute)?;
    let amount = parse_amount(body.amount, 1);
    let result = state
        .attribute_services
        .add_attribute_point(user_id, attribute, amount)
        .await?;
    Ok(service_result(result))
}

async fn remove_attribute_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AttributeMutationBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let attribute = normalize_required_attribute(body.attribute)?;
    let amount = parse_amount(body.amount, 1);
    let result = state
        .attribute_services
        .remove_attribute_point(user_id, attribute, amount)
        .await?;
    Ok(service_result(result))
}

async fn batch_add_points_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AttributeBatchBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .attribute_services
        .batch_add_points(
            user_id,
            AttributeBatchInput {
                jing: parse_amount(body.jing, 0),
                qi: parse_amount(body.qi, 0),
                shen: parse_amount(body.shen, 0),
            },
        )
        .await?;
    Ok(service_result(result))
}

async fn reset_attribute_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .attribute_services
        .reset_attribute_points(user_id)
        .await?;
    Ok((
        if result.success {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        AxumJson(result),
    )
        .into_response())
}

fn normalize_required_attribute(attribute: Option<String>) -> Result<String, BusinessError> {
    let normalized = attribute.unwrap_or_default().trim().to_string();
    if normalized.is_empty() {
        return Err(BusinessError::new("请指定属性类型"));
    }
    Ok(normalized)
}

fn parse_amount(value: Option<Value>, default_value: i32) -> i32 {
    let Some(value) = value else {
        return default_value;
    };
    match value {
        Value::Number(number) => number.as_i64().and_then(|v| i32::try_from(v).ok()),
        Value::String(text) => text.trim().parse::<i32>().ok(),
        _ => None,
    }
    .unwrap_or(default_value)
}
