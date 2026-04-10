use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * insight 悟道路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/insight/overview` 与 `/api/insight/inject` 两个接口，并保持 `requireAuth + sendResult` 的 HTTP 合同一致。
 * 2. 做什么：把 `exp` 的 JS Number 风格解析和 Bearer 鉴权固定在路由层，业务公式与写库全部下沉到应用服务。
 * 3. 不做什么：不在路由层判断境界解锁、不直接拼 SQL，也不补任何额外兜底字段。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；注入接口接收 `{ exp }`。
 * - 输出：统一 `{ success, message, data? }`，字段命名与 Node 当前接口保持 camelCase。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `require_authenticated_user_id`
 * - overview 直接读取应用服务结果；inject 先完成参数归一化，再委托应用服务做事务写入。
 *
 * 复用设计说明：
 * - `InsightRouteServices` 将鉴权后的用户上下文与悟道业务实现解耦，后续若补 socket 推送或角色面板聚合，可以直接复用同一服务层。
 * - 视图 DTO 与合同测试共用，避免路由层和业务层各维护一套字段清单。
 *
 * 关键边界条件与坑点：
 * 1. `exp` 参数校验必须保持 Node 行为：只接受可转成大于 0 整数的值，非法值直接返回固定文案。
 * 2. overview 使用 `requireAuth` 而不是 `requireCharacter`；角色不存在要走业务失败包，不是 404。
 */
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InsightOverviewView {
    pub unlocked: bool,
    pub unlock_realm: String,
    pub current_level: i64,
    pub current_progress_exp: i64,
    pub current_bonus_pct: f64,
    pub next_level_cost_exp: i64,
    pub character_exp: i64,
    pub cost_stage_levels: i64,
    pub cost_stage_base_exp: i64,
    pub bonus_pct_per_level: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InsightInjectResultView {
    pub before_level: i64,
    pub after_level: i64,
    pub after_progress_exp: i64,
    pub actual_injected_levels: i64,
    pub spent_exp: i64,
    pub remaining_exp: i64,
    pub gained_bonus_pct: f64,
    pub current_bonus_pct: f64,
}

#[derive(Debug, Deserialize)]
struct InsightInjectBody {
    #[serde(default)]
    exp: Option<Value>,
}

pub trait InsightRouteServices: Send + Sync {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightOverviewView>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;

    fn inject_exp<'a>(
        &'a self,
        user_id: i64,
        exp: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightInjectResultView>, BusinessError>,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopInsightRouteServices;

impl InsightRouteServices for NoopInsightRouteServices {
    fn get_overview<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightOverviewView>, BusinessError>,
                > + Send
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

    fn inject_exp<'a>(
        &'a self,
        _user_id: i64,
        _exp: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<ServiceResultResponse<InsightInjectResultView>, BusinessError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("注入经验无效，需大于 0".to_string()),
                None,
            ))
        })
    }
}

pub fn build_insight_router() -> Router<AppState> {
    Router::new()
        .route("/overview", get(overview_handler))
        .route("/inject", post(inject_handler))
}

async fn overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state.insight_services.get_overview(user_id).await?;
    Ok(service_result(result))
}

async fn inject_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<InsightInjectBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let Some(exp) = parse_positive_integer_like(body.exp.as_ref()) else {
        return Ok(service_result(ServiceResultResponse::<InsightInjectResultView>::new(
            false,
            Some("exp 参数无效，需为大于 0 的整数".to_string()),
            None,
        )));
    };
    let result = state.insight_services.inject_exp(user_id, exp).await?;
    Ok(service_result(result))
}

fn parse_positive_integer_like(value: Option<&Value>) -> Option<i64> {
    let numeric = match value? {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| {
                number
                    .as_f64()
                    .and_then(|value| is_positive_integer(value).then_some(value as i64))
            }),
        Value::String(text) => text
            .trim()
            .parse::<f64>()
            .ok()
            .and_then(|value| is_positive_integer(value).then_some(value as i64)),
        Value::Bool(value) => (*value).then_some(1),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }?;
    (numeric > 0).then_some(numeric)
}

fn is_positive_integer(value: f64) -> bool {
    value.is_finite() && value.fract().abs() < f64::EPSILON && value >= 1.0
}
