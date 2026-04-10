use std::{future::Future, pin::Pin};

use axum::extract::{Json, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::application::month_card::service::default_month_card_id;
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * month_card 月卡路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/monthcard/status|use-item|claim` 三个接口，并保持 `requireAuth + sendResult` 协议一致。
 * 2. 做什么：把 Bearer 鉴权、默认 `monthCardId`、`itemInstanceId` 宽松解析与统一响应封装固定在路由层。
 * 3. 不做什么：不在路由层解析 seed、不直接写数据库，也不重复实现月卡业务规则。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`status` 接收 query `monthCardId`，`use-item/claim` 接收 JSON body。
 * - 输出：统一 `{ success, message, data? }`，字段命名保持 Node 当前前端消费的 camelCase。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_user_id` -> 参数归一化 -> `MonthCardRouteServices` -> `service_result`。
 *
 * 复用设计说明：
 * - 默认月卡 ID 与 `itemInstanceId` 解析只维护一处，避免状态、激活、领取三个 handler 各自复制一套归一化逻辑。
 * - DTO 与服务 trait 统一集中在本文件，合同测试和应用服务共用同一份协议定义，减少字段漂移。
 *
 * 关键边界条件与坑点：
 * 1. `monthCardId` 缺失时必须回退默认值，不能把空值直接打成 400，否则会破坏 Node 当前前端请求语义。
 * 2. `itemInstanceId` 允许字符串数字，非法值要回落为 `None` 交给服务层走“自动挑选道具”规则，不能在路由层新增报错。
 */
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardBenefitValuesView {
    pub cooldown_reduction_rate: f64,
    pub stamina_recovery_rate: f64,
    pub fuyuan_bonus: i64,
    pub idle_max_duration_hours: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardStatusView {
    pub month_card_id: String,
    pub name: String,
    pub description: Option<String>,
    pub duration_days: i64,
    pub daily_spirit_stones: i64,
    pub price_spirit_stones: i64,
    pub benefits: MonthCardBenefitValuesView,
    pub active: bool,
    pub expire_at: Option<String>,
    pub days_left: i64,
    pub today: String,
    pub last_claim_date: Option<String>,
    pub can_claim: bool,
    pub spirit_stones: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardUseItemDataView {
    pub month_card_id: String,
    pub expire_at: String,
    pub days_left: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardClaimDataView {
    pub month_card_id: String,
    pub date: String,
    pub reward_spirit_stones: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthCardStatusQuery {
    month_card_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MonthCardBody {
    month_card_id: Option<String>,
    item_instance_id: Option<MonthCardBodyNumber>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum MonthCardBodyNumber {
    Number(i64),
    String(String),
}

pub trait MonthCardRouteServices: Send + Sync {
    fn get_status<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MonthCardStatusView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn use_item<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
        item_instance_id: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardUseItemDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn claim<'a>(
        &'a self,
        user_id: i64,
        month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardClaimDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopMonthCardRouteServices;

impl MonthCardRouteServices for NoopMonthCardRouteServices {
    fn get_status<'a>(
        &'a self,
        _user_id: i64,
        _month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MonthCardStatusView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("角色不存在".to_string()),
                None,
            ))
        })
    }

    fn use_item<'a>(
        &'a self,
        _user_id: i64,
        _month_card_id: String,
        _item_instance_id: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardUseItemDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("背包中没有可用的月卡道具".to_string()),
                None,
            ))
        })
    }

    fn claim<'a>(
        &'a self,
        _user_id: i64,
        _month_card_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<MonthCardClaimDataView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("未激活月卡".to_string()),
                None,
            ))
        })
    }
}

pub fn build_month_card_router() -> Router<AppState> {
    Router::new()
        .route("/status", get(status_handler))
        .route("/use-item", post(use_item_handler))
        .route("/claim", post(claim_handler))
}

async fn status_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MonthCardStatusQuery>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .month_card_services
        .get_status(user_id, normalize_month_card_id(query.month_card_id))
        .await?;
    Ok(service_result(result))
}

async fn use_item_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MonthCardBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .month_card_services
        .use_item(
            user_id,
            normalize_month_card_id(body.month_card_id),
            normalize_item_instance_id(body.item_instance_id),
        )
        .await?;
    Ok(service_result(result))
}

async fn claim_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MonthCardBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state
        .month_card_services
        .claim(user_id, normalize_month_card_id(body.month_card_id))
        .await?;
    Ok(service_result(result))
}

fn normalize_month_card_id(raw: Option<String>) -> String {
    raw.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_month_card_id().to_string())
}

fn normalize_item_instance_id(raw: Option<MonthCardBodyNumber>) -> Option<i64> {
    match raw {
        Some(MonthCardBodyNumber::Number(value)) if value > 0 => Some(value),
        Some(MonthCardBodyNumber::String(value)) => {
            value.trim().parse::<i64>().ok().filter(|id| *id > 0)
        }
        _ => None,
    }
}
