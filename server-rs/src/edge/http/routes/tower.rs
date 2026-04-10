use std::{future::Future, pin::Pin};

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};
use crate::runtime::session::BattleSessionSnapshotView;

/**
 * tower HTTP 路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/tower/overview` 与 `/api/tower/rank` 两个只读接口，保持 `requireAuth + sendResult` 的包体语义一致。
 * 2. 做什么：集中处理鉴权与 query 参数裁剪，再把塔概览与排行读取下沉到应用服务，避免 handler 重复拼装运行时快照和算法结果。
 * 3. 不做什么：不在路由层生成楼层怪物、不实现开战推进，也不扩展塔结算写入逻辑。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；排行接口可选 `limit` 查询参数。
 * - 输出：统一 `{ success, message, data }`，其中概览 `data` 含 `progress/activeSession/nextFloorPreview`，排行 `data` 为数组。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> Bearer 鉴权 -> 参数归一化 -> `TowerRouteServices` -> `service_result` 输出。
 *
 * 复用设计说明：
 * - `BattleSessionSnapshotView` 直接复用 battle-session 路由的公共视图，避免塔概览与战斗会话详情各维护一套 session 协议。
 * - 塔概览与排行 DTO 集中放在这里，路由合同与服务实现共享同一份结构，减少字段漂移。
 *
 * 关键边界条件与坑点：
 * 1. `limit` 非法时要和 Node 一样忽略并回退默认值，不能因为空值或非数字直接返回 400。
 * 2. 认证通过但角色不存在时，概览接口仍要返回 `success:false + 角色不存在`，不能偷改成 404。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TowerFloorPreviewView {
    pub floor: i32,
    pub kind: String,
    pub seed: String,
    pub realm: String,
    pub monster_ids: Vec<String>,
    pub monster_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TowerOverviewProgressView {
    pub best_floor: i32,
    pub next_floor: i32,
    pub current_run_id: Option<String>,
    pub current_floor: Option<i32>,
    pub last_settled_floor: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TowerOverviewView {
    pub progress: TowerOverviewProgressView,
    pub active_session: Option<BattleSessionSnapshotView>,
    pub next_floor_preview: TowerFloorPreviewView,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TowerRankRow {
    pub rank: i32,
    pub character_id: i64,
    pub name: String,
    pub realm: String,
    pub best_floor: i32,
    pub reached_at: Option<String>,
}

pub trait TowerRouteServices: Send + Sync {
    fn get_overview<'a>(
        &'a self,
        user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<TowerOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_rank_list<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<TowerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopTowerRouteServices;

impl TowerRouteServices for NoopTowerRouteServices {
    fn get_overview<'a>(
        &'a self,
        _user_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<TowerOverviewView>, BusinessError>>
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

    fn get_rank_list<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<TowerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(ServiceResultResponse::new(true, None, Some(Vec::new()))) })
    }
}

pub fn build_tower_router() -> Router<AppState> {
    Router::new()
        .route("/overview", get(tower_overview_handler))
        .route("/rank", get(tower_rank_handler))
}

async fn tower_overview_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };

    match state.tower_services.get_overview(user_id).await {
        Ok(result) => service_result(result),
        Err(error) => error.into_response(),
    }
}

async fn tower_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let _user_id = match require_authenticated_user_id(&state, &headers).await {
        Ok(user_id) => user_id,
        Err(response) => return response,
    };

    match state
        .tower_services
        .get_rank_list(parse_positive_i64(query.get("limit").map(String::as_str)))
        .await
    {
        Ok(result) => service_result(result),
        Err(error) => error.into_response(),
    }
}

fn parse_positive_i64(raw: Option<&str>) -> Option<i64> {
    let parsed = raw?.trim().parse::<i64>().ok()?;
    (parsed > 0).then_some(parsed)
}
