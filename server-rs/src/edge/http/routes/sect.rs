use std::{future::Future, pin::Pin};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;

/**
 * sect HTTP 只读路由。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/sect/me`、`/api/sect/search`、`/api/sect/:sectId` 三个已被宗门面板和排行页复用的只读接口。
 * 2. 做什么：统一收敛 requireCharacter 鉴权、query/path 参数归一化与 404/200 响应语义，避免 handler 重复拼装包体。
 * 3. 不做什么：不在这里补宗门创建、申请、建筑升级等写链路，也不处理宗门 Socket 推送。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；搜索接口可选 `keyword/page/limit`；详情接口接收 `sectId` path。
 * - 输出：保持 Node 兼容包体，其中 `/me` 返回 `{ success, message, data }`，`/search` 返回 `{ success, message, list, page, limit, total }`，`/:sectId` 返回 `{ success, message, data? }`。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_character_context`
 * - -> `SectRouteServices` 统一读取宗门详情/搜索结果
 * - -> 路由层按 Node 约定输出 JSON。
 *
 * 复用设计说明：
 * - 宗门详情、我的宗门和搜索列表共用同一份 DTO 与服务边界，后续继续补 `/api/sect/buildings/list`、`/api/sect/bonuses` 时可直接复用详情装配结果，不必重复查成员、建筑、月卡状态。
 * - 404 语义只在 `/:sectId` 入口集中处理，避免服务层和多个 handler 各自维护一套“宗门不存在”的 HTTP 约定。
 *
 * 关键边界条件与坑点：
 * 1. `/me` 在角色未加入宗门时必须继续返回 `success:true + data:null`，不能抬成 404。
 * 2. `/search` 的 `page/limit` 非法时要和 Node 一样回退到默认值，不能把空值或非数字改造成参数错误。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SectDefView {
    pub id: String,
    #[serde(rename = "leader_id")]
    pub leader_id: i64,
    pub name: String,
    pub level: i32,
    pub exp: i64,
    pub funds: i64,
    pub reputation: i64,
    #[serde(rename = "build_points")]
    pub build_points: i32,
    pub announcement: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    #[serde(rename = "join_type")]
    pub join_type: String,
    #[serde(rename = "join_min_realm")]
    pub join_min_realm: String,
    #[serde(rename = "member_count")]
    pub member_count: i32,
    #[serde(rename = "max_members")]
    pub max_members: i32,
    #[serde(rename = "created_at")]
    pub created_at: String,
    #[serde(rename = "updated_at")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectMemberView {
    pub character_id: i64,
    pub nickname: String,
    pub month_card_active: bool,
    pub realm: String,
    pub position: String,
    pub contribution: i64,
    pub weekly_contribution: i64,
    pub joined_at: String,
    pub last_offline_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectBuildingRequirementView {
    pub upgradable: bool,
    pub max_level: i32,
    pub next_level: Option<i32>,
    pub funds: Option<i64>,
    pub build_points: Option<i64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SectBuildingView {
    pub id: i64,
    #[serde(rename = "sect_id")]
    pub sect_id: String,
    #[serde(rename = "building_type")]
    pub building_type: String,
    pub level: i32,
    pub status: String,
    #[serde(rename = "upgrade_start_at")]
    pub upgrade_start_at: Option<String>,
    #[serde(rename = "upgrade_end_at")]
    pub upgrade_end_at: Option<String>,
    #[serde(rename = "created_at")]
    pub created_at: String,
    #[serde(rename = "updated_at")]
    pub updated_at: String,
    pub requirement: SectBuildingRequirementView,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SectInfoView {
    pub sect: SectDefView,
    pub members: Vec<SectMemberView>,
    pub buildings: Vec<SectBuildingView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectBlessingStatusView {
    pub today: String,
    pub blessed_today: bool,
    pub can_bless: bool,
    pub active: bool,
    pub expire_at: Option<String>,
    pub fuyuan_bonus: f64,
    pub duration_hours: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MySectInfoView {
    #[serde(flatten)]
    pub info: SectInfoView,
    pub blessing_status: SectBlessingStatusView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SectMyResponse {
    pub success: bool,
    pub message: String,
    pub data: Option<MySectInfoView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SectInfoResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<SectInfoView>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectSearchItemView {
    pub id: String,
    pub name: String,
    pub level: i32,
    pub member_count: i32,
    pub max_members: i32,
    pub join_type: String,
    pub join_min_realm: String,
    pub announcement: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SectSearchResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list: Option<Vec<SectSearchItemView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct SectSearchQuery {
    pub keyword: Option<String>,
    pub page: Option<String>,
    pub limit: Option<String>,
}

pub trait SectRouteServices: Send + Sync {
    fn get_my_sect<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<SectMyResponse, BusinessError>> + Send + 'a>>;

    fn search_sects<'a>(
        &'a self,
        keyword: Option<String>,
        page: Option<i64>,
        limit: Option<i64>,
    ) -> Pin<Box<dyn Future<Output = Result<SectSearchResponse, BusinessError>> + Send + 'a>>;

    fn get_sect_info<'a>(
        &'a self,
        sect_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<SectInfoResponse, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopSectRouteServices;

impl SectRouteServices for NoopSectRouteServices {
    fn get_my_sect<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<SectMyResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(SectMyResponse {
                success: true,
                message: "ok".to_string(),
                data: None,
            })
        })
    }

    fn search_sects<'a>(
        &'a self,
        _keyword: Option<String>,
        _page: Option<i64>,
        _limit: Option<i64>,
    ) -> Pin<Box<dyn Future<Output = Result<SectSearchResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(SectSearchResponse {
                success: true,
                message: "ok".to_string(),
                list: Some(Vec::new()),
                page: Some(1),
                limit: Some(20),
                total: Some(0),
            })
        })
    }

    fn get_sect_info<'a>(
        &'a self,
        _sect_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<SectInfoResponse, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(SectInfoResponse {
                success: false,
                message: "宗门不存在".to_string(),
                data: None,
            })
        })
    }
}

pub fn build_sect_router() -> Router<AppState> {
    Router::new()
        .route("/me", get(get_my_sect_handler))
        .route("/search", get(search_sects_handler))
        .route("/{sectId}", get(get_sect_info_handler))
}

async fn get_my_sect_handler(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    match state.sect_services.get_my_sect(context.character.id).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn search_sects_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SectSearchQuery>,
) -> Response {
    let _context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return response,
    };

    match state
        .sect_services
        .search_sects(
            normalize_optional_text(query.keyword),
            parse_positive_i64(query.page.as_deref()),
            parse_positive_i64(query.limit.as_deref()),
        )
        .await
    {
        Ok(result) => Json(result).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn get_sect_info_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sect_id): Path<String>,
) -> Response {
    let _context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return response,
    };
    let Some(sect_id) = normalize_optional_text(Some(sect_id)) else {
        return BusinessError::new("参数错误").into_response();
    };

    match state.sect_services.get_sect_info(sect_id).await {
        Ok(result) if result.success => Json(result).into_response(),
        Ok(result) => (StatusCode::NOT_FOUND, Json(result)).into_response(),
        Err(error) => error.into_response(),
    }
}

fn parse_positive_i64(raw: Option<&str>) -> Option<i64> {
    let parsed = raw?.trim().parse::<i64>().ok()?;
    (parsed > 0).then_some(parsed)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}
