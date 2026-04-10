use std::collections::HashMap;
use std::{future::Future, pin::Pin};

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_user_id;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, ServiceResultResponse};

/**
 * rank 排行 HTTP 路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/rank/overview|realm|sect|wealth|arena|partner` 6 个只读接口，并保持 `requireAuth + sendResult` 的 HTTP 合同一致。
 * 2. 做什么：集中处理 query 参数裁剪与鉴权，再把排行读取下沉到应用服务，避免各个 handler 复制 session 校验和包体拼装。
 * 3. 不做什么：不在路由层拼 SQL、不做缓存，也不扩展排行之外的首页聚合能力。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；可选 `limitPlayers`、`limitSects`、`limit`、`metric` 查询参数。
 * - 输出：统一 `{ success, message, data }`，与 Node `sendResult` 兼容。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> Bearer/session 校验 -> query 归一化 -> `RankRouteServices` -> `service_result` 输出。
 *
 * 复用设计说明：
 * - 各榜单共用同一套 `require_authenticated_user_id` 与 query 解析 helper，后续继续补其它 `requireAuth` 只读路由时可直接复用相同模式。
 * - 所有排行 DTO 都集中定义在这里，应用服务与合同测试共享同一份字段协议，避免前后端看到的 shape 漂移。
 *
 * 关键边界条件与坑点：
 * 1. Node 这里虽然不直接使用 `userId`，但仍强制 `requireAuth`；Rust 端不能因为“只读”就放开匿名访问。
 * 2. 非法 limit 需要保持 Node 口径自动忽略并回退默认值，不能把空值或非数字直接打成 400。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RealmRankRow {
    pub rank: i32,
    pub character_id: i64,
    pub name: String,
    pub title: Option<String>,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectRankRow {
    pub rank: i32,
    pub name: String,
    pub level: i32,
    pub leader: String,
    pub leader_month_card_active: bool,
    pub members: i32,
    pub member_cap: i32,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WealthRankRow {
    pub rank: i32,
    pub character_id: i64,
    pub name: String,
    pub title: Option<String>,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub spirit_stones: i32,
    pub silver: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArenaRankRow {
    pub rank: i32,
    pub character_id: i64,
    pub name: String,
    pub title: Option<String>,
    pub avatar: Option<String>,
    pub month_card_active: bool,
    pub realm: String,
    pub score: i32,
    pub win_count: i32,
    pub lose_count: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRankRow {
    pub rank: i32,
    pub partner_id: i64,
    pub character_id: i64,
    pub owner_name: String,
    pub owner_month_card_active: bool,
    pub partner_name: String,
    pub avatar: Option<String>,
    pub quality: String,
    pub element: String,
    pub role: String,
    pub level: i32,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RankOverviewView {
    pub realm: Vec<RealmRankRow>,
    pub sect: Vec<SectRankRow>,
    pub wealth: Vec<WealthRankRow>,
}

pub trait RankRouteServices: Send + Sync {
    fn get_rank_overview<'a>(
        &'a self,
        limit_players: Option<i64>,
        limit_sects: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RankOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_realm_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<RealmRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_sect_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<SectRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_wealth_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<WealthRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_arena_ranks<'a>(
        &'a self,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<ArenaRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn get_partner_ranks<'a>(
        &'a self,
        metric: Option<String>,
        limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<PartnerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopRankRouteServices;

impl RankRouteServices for NoopRankRouteServices {
    fn get_rank_overview<'a>(
        &'a self,
        _limit_players: Option<i64>,
        _limit_sects: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RankOverviewView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(RankOverviewView {
                    realm: Vec::new(),
                    sect: Vec::new(),
                    wealth: Vec::new(),
                }),
            ))
        })
    }

    fn get_realm_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<RealmRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_sect_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<SectRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_wealth_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<WealthRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_arena_ranks<'a>(
        &'a self,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<ArenaRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("ok".to_string()),
                Some(Vec::new()),
            ))
        })
    }

    fn get_partner_ranks<'a>(
        &'a self,
        _metric: Option<String>,
        _limit: Option<i64>,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<Vec<PartnerRankRow>>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                false,
                Some("伙伴排行维度不合法".to_string()),
                None,
            ))
        })
    }
}

pub fn build_rank_router() -> Router<AppState> {
    Router::new()
        .route("/overview", get(rank_overview_handler))
        .route("/realm", get(realm_rank_handler))
        .route("/sect", get(sect_rank_handler))
        .route("/wealth", get(wealth_rank_handler))
        .route("/arena", get(arena_rank_handler))
        .route("/partner", get(partner_rank_handler))
}

async fn rank_overview_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_rank_overview(
                parse_positive_i64(query.get("limitPlayers")),
                parse_positive_i64(query.get("limitSects")),
            )
            .await?,
    ))
}

async fn realm_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_realm_ranks(parse_positive_i64(query.get("limit")))
            .await?,
    ))
}

async fn sect_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_sect_ranks(parse_positive_i64(query.get("limit")))
            .await?,
    ))
}

async fn wealth_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_wealth_ranks(parse_positive_i64(query.get("limit")))
            .await?,
    ))
}

async fn arena_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_arena_ranks(parse_positive_i64(query.get("limit")))
            .await?,
    ))
}

async fn partner_rank_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    if let Err(response) = require_authenticated_user_id(&state, &headers).await {
        return Ok(response);
    }

    Ok(service_result(
        state
            .rank_services
            .get_partner_ranks(
                query.get("metric").cloned(),
                parse_positive_i64(query.get("limit")),
            )
            .await?,
    ))
}

fn parse_positive_i64(value: Option<&String>) -> Option<i64> {
    let parsed = value?.trim().parse::<i64>().ok()?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}
