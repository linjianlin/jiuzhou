use std::{future::Future, pin::Pin};

use axum::extract::{Json, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * realm 境界突破路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/realm/overview` 与 `/api/realm/breakthrough` 两个接口，并保持 `requireAuth + sendResult` 的协议一致。
 * 2. 做什么：把 Bearer 鉴权、突破方向参数归一化与 HTTP 响应封装固定在路由层，业务规则全部交给应用服务。
 * 3. 不做什么：不在路由层读取种子、不直接写数据库，也不伪造主线/成就/投影刷新等尚未迁移的跨域副作用。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；突破接口接收 `{ direction?: string; targetRealm?: string }`。
 * - 输出：Node 兼容 `{ success, message, data? }`，字段命名保持 camelCase。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_user_id` -> 参数归一化 -> `RealmRouteServices` -> `service_result`。
 *
 * 复用设计说明：
 * - `RealmRouteServices` 让路由层只关心协议，后续若补角色面板聚合或 socket 推送入口，可直接复用同一套境界服务。
 * - 总览 DTO、消耗/奖励/条件视图与路由共享，避免应用层和路由层分别维护重复字段映射。
 *
 * 关键边界条件与坑点：
 * 1. `targetRealm` 优先级必须高于 `direction`，否则会破坏 Node 当前“指定目标境界优先”的分支顺序。
 * 2. 非 `next` 的方向值必须直接返回固定失败文案，不能默默兜底成下一境界突破。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RealmRequirementStatus {
    Done,
    Todo,
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmRequirementView {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub status: RealmRequirementStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmCostView {
    pub id: String,
    pub title: String,
    pub detail: String,
    #[serde(rename = "type")]
    pub cost_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<RealmRequirementStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_def_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmRewardView {
    pub id: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmOverviewView {
    pub config_path: Option<String>,
    pub realm_order: Vec<String>,
    pub current_realm: String,
    pub current_index: usize,
    pub next_realm: Option<String>,
    pub exp: i64,
    pub spirit_stones: i64,
    pub requirements: Vec<RealmRequirementView>,
    pub costs: Vec<RealmCostView>,
    pub rewards: Vec<RealmRewardView>,
    pub can_breakthrough: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmSpentItemView {
    pub item_def_id: String,
    pub qty: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmBreakthroughDataView {
    pub from_realm: String,
    pub new_realm: String,
    pub spent_exp: i64,
    pub spent_spirit_stones: i64,
    pub spent_items: Vec<RealmSpentItemView>,
    pub gained_attribute_points: i32,
    pub current_exp: i64,
    pub current_spirit_stones: i64,
}

#[derive(Debug, Deserialize)]
struct RealmBreakthroughBody {
    #[serde(default)]
    direction: Option<String>,
    #[serde(default, rename = "targetRealm")]
    target_realm: Option<String>,
}

pub trait RealmRouteServices: Send + Sync {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RealmOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn breakthrough_to_next_realm<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;

    fn breakthrough_to_target_realm<'a>(
        &'a self,
        user_id: i64,
        target_realm: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopRealmRouteServices;

impl RealmRouteServices for NoopRealmRouteServices {
    fn get_overview<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RealmOverviewView>, BusinessError>>
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

    fn breakthrough_to_next_realm<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("已达最高境界".to_string()),
                None,
            ))
        })
    }

    fn breakthrough_to_target_realm<'a>(
        &'a self,
        _user_id: i64,
        _target_realm: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        ServiceResultResponse<RealmBreakthroughDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("目标境界无效".to_string()),
                None,
            ))
        })
    }
}

pub fn build_realm_router() -> Router<AppState> {
    Router::new()
        .route("/overview", get(overview_handler))
        .route("/breakthrough", post(breakthrough_handler))
}

async fn overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let result = state.realm_services.get_overview(user_id).await?;
    Ok(service_result(result))
}

async fn breakthrough_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RealmBreakthroughBody>,
) -> Result<Response, BusinessError> {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return Ok(response),
    };
    let direction = body.direction.unwrap_or_default().trim().to_string();
    let target_realm = body.target_realm.unwrap_or_default().trim().to_string();
    let result = if !target_realm.is_empty() {
        state
            .realm_services
            .breakthrough_to_target_realm(user_id, target_realm)
            .await?
    } else if direction.is_empty() || direction == "next" {
        state
            .realm_services
            .breakthrough_to_next_realm(user_id)
            .await?
    } else {
        ServiceResultResponse::new(false, Some("突破方向无效".to_string()), None)
    };
    Ok(service_result(result))
}
