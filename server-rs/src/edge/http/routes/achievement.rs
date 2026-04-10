use std::{future::Future, pin::Pin};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * achievement 成就路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/achievement/list`、`/:achievementId`、`/claim`、`/points/rewards`、`/points/claim` 五条成就接口，并保持 `requireCharacter` 语义与响应 envelope 一致。
 * 2. 做什么：把 query/body 的宽松参数解析和 Node 可见报错文案集中在这一层，避免应用服务同时承担 HTTP 协议兼容。
 * 3. 不做什么：不在路由层拼 SQL，不处理 socket 推送，也不把奖励发放细节散落到 handler。
 *
 * 输入 / 输出：
 * - 输入：Bearer token；list 可带 `category/status/page/limit`；claim 接收 `{ achievementId } | { achievement_id }`；点数领取接收 `{ threshold } | { points_threshold }`。
 * - 输出：列表/详情/点数奖励列表走 `success(data)`；两个领取接口走 Node 兼容 `sendResult` 形状。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_character_context`
 * - -> `AchievementRouteServices`
 * - -> 路由层统一输出 Node 兼容 envelope。
 *
 * 复用设计说明：
 * - 成就列表、详情、奖励领取和点数奖励共享同一套 `AchievementRouteServices` 边界，后续首页红点、称号联动或 socket 推送都能复用相同 DTO，而不必再维护平行类型。
 * - query/body 解析集中在这里后，应用层只处理业务真值，避免分页默认值、旧字段别名和错误文案在多个调用点重复实现。
 *
 * 关键边界条件与坑点：
 * 1. `achievementId` 不存在时必须返回 `404 成就不存在`，不能退化成 `200 + null`。
 * 2. `threshold` 需要维持 Node 的宽松数值语义，字符串数字应被接受，非数字最终走业务失败文案 `阈值无效`。
 */
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AchievementRewardItemView {
    pub item_def_id: String,
    pub qty: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AchievementRewardView {
    #[serde(rename_all = "camelCase")]
    Silver { amount: i64 },
    #[serde(rename_all = "camelCase")]
    SpiritStones { amount: i64 },
    #[serde(rename_all = "camelCase")]
    Exp { amount: i64 },
    #[serde(rename_all = "camelCase")]
    Item {
        item_def_id: String,
        qty: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AchievementTitleRewardView {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AchievementProgressView {
    pub current: i64,
    pub target: i64,
    pub percent: f64,
    pub done: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AchievementItemView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub points: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub hidden: bool,
    pub status: String,
    pub claimable: bool,
    pub track_type: String,
    pub track_key: String,
    pub progress: AchievementProgressView,
    pub rewards: Vec<AchievementRewardView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_id: Option<String>,
    pub sort_weight: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AchievementPointsByCategoryView {
    pub combat: i64,
    pub cultivation: i64,
    pub exploration: i64,
    pub social: i64,
    pub collection: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AchievementPointsInfoView {
    pub total: i64,
    #[serde(rename = "byCategory")]
    pub by_category: AchievementPointsByCategoryView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementListDataView {
    pub achievements: Vec<AchievementItemView>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
    pub points: AchievementPointsInfoView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementDetailDataView {
    pub achievement: AchievementItemView,
    pub progress: AchievementProgressView,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementClaimDataView {
    #[serde(rename = "achievementId")]
    pub achievement_id: String,
    pub rewards: Vec<AchievementRewardView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<AchievementTitleRewardView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementPointRewardView {
    pub id: String,
    pub threshold: i64,
    pub name: String,
    pub description: String,
    pub rewards: Vec<AchievementRewardView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<AchievementTitleRewardView>,
    pub claimable: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementPointRewardListDataView {
    #[serde(rename = "totalPoints")]
    pub total_points: i64,
    #[serde(rename = "claimedThresholds")]
    pub claimed_thresholds: Vec<i64>,
    pub rewards: Vec<AchievementPointRewardView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AchievementPointRewardClaimDataView {
    pub threshold: i64,
    pub rewards: Vec<AchievementRewardView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<AchievementTitleRewardView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AchievementActionResult<T> {
    pub success: bool,
    pub message: String,
    pub data: Option<T>,
}

#[derive(Debug, Deserialize)]
pub struct AchievementListQuery {
    pub category: Option<String>,
    pub status: Option<String>,
    pub page: Option<String>,
    pub limit: Option<String>,
}

pub trait AchievementRouteServices: Send + Sync {
    fn get_achievement_list<'a>(
        &'a self,
        character_id: i64,
        query: AchievementListQuery,
    ) -> Pin<Box<dyn Future<Output = Result<AchievementListDataView, BusinessError>> + Send + 'a>>;

    fn get_achievement_detail<'a>(
        &'a self,
        character_id: i64,
        achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Option<AchievementDetailDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn claim_achievement<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;

    fn get_achievement_point_rewards<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementPointRewardListDataView, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn claim_achievement_point_reward<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        threshold: Option<Value>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementPointRewardClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopAchievementRouteServices;

impl AchievementRouteServices for NoopAchievementRouteServices {
    fn get_achievement_list<'a>(
        &'a self,
        _character_id: i64,
        _query: AchievementListQuery,
    ) -> Pin<Box<dyn Future<Output = Result<AchievementListDataView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(AchievementListDataView {
                achievements: Vec::new(),
                total: 0,
                page: 1,
                limit: 20,
                points: AchievementPointsInfoView {
                    total: 0,
                    by_category: AchievementPointsByCategoryView {
                        combat: 0,
                        cultivation: 0,
                        exploration: 0,
                        social: 0,
                        collection: 0,
                    },
                },
            })
        })
    }

    fn get_achievement_detail<'a>(
        &'a self,
        _character_id: i64,
        _achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Option<AchievementDetailDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Ok(None) })
    }

    fn claim_achievement<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _achievement_id: String,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementActionResult {
                success: false,
                message: "成就不存在或未解锁".to_string(),
                data: None,
            })
        })
    }

    fn get_achievement_point_rewards<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<AchievementPointRewardListDataView, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementPointRewardListDataView {
                total_points: 0,
                claimed_thresholds: Vec::new(),
                rewards: Vec::new(),
            })
        })
    }

    fn claim_achievement_point_reward<'a>(
        &'a self,
        _user_id: i64,
        _character_id: i64,
        _threshold: Option<Value>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        AchievementActionResult<AchievementPointRewardClaimDataView>,
                        BusinessError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(AchievementActionResult {
                success: false,
                message: "阈值无效".to_string(),
                data: None,
            })
        })
    }
}

#[derive(Debug, Deserialize)]
struct ClaimAchievementPayload {
    #[serde(rename = "achievementId")]
    achievement_id: Option<Value>,
    #[serde(rename = "achievement_id")]
    legacy_achievement_id: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ClaimAchievementPointRewardPayload {
    threshold: Option<Value>,
    #[serde(rename = "points_threshold")]
    legacy_threshold: Option<Value>,
}

pub fn build_achievement_router() -> Router<AppState> {
    Router::new()
        .route("/list", get(get_achievement_list_handler))
        .route("/claim", post(claim_achievement_handler))
        .route(
            "/points/rewards",
            get(get_achievement_point_rewards_handler),
        )
        .route(
            "/points/claim",
            post(claim_achievement_point_reward_handler),
        )
        .route("/{achievementId}", get(get_achievement_detail_handler))
}

async fn get_achievement_list_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AchievementListQuery>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let data = state
        .achievement_services
        .get_achievement_list(context.character.id, query)
        .await?;
    Ok(success(data))
}

async fn get_achievement_detail_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(achievement_id): Path<String>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let Some(data) = state
        .achievement_services
        .get_achievement_detail(context.character.id, achievement_id)
        .await?
    else {
        return Err(BusinessError::with_status(
            "成就不存在",
            StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(data))
}

async fn claim_achievement_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClaimAchievementPayload>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let achievement_id = parse_non_empty_text(
        payload
            .achievement_id
            .as_ref()
            .or(payload.legacy_achievement_id.as_ref()),
    )
    .ok_or_else(|| BusinessError::new("成就ID无效"))?;
    let result = state
        .achievement_services
        .claim_achievement(context.user_id, context.character.id, achievement_id)
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn get_achievement_point_rewards_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let data = state
        .achievement_services
        .get_achievement_point_rewards(context.character.id)
        .await?;
    Ok(success(data))
}

async fn claim_achievement_point_reward_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClaimAchievementPointRewardPayload>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let result = state
        .achievement_services
        .claim_achievement_point_reward(
            context.user_id,
            context.character.id,
            payload.threshold.or(payload.legacy_threshold),
        )
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

fn parse_non_empty_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}
