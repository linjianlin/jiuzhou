use axum::extract::{Json, Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};

use crate::bootstrap::app::AppState;
use crate::edge::http::auth::require_authenticated_character_context;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};
use crate::edge::http::routes::game::{GameHomeMainQuestChapterView, GameHomeMainQuestSectionView};

/**
 * main-quest 最小独立路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node `/api/main-quest/progress`、`/api/main-quest/chapters` 与 `/api/main-quest/track` 三个前端已直接依赖的主线合同。
 * 2. 做什么：复用 `GameRouteServices` 中已经沉淀的主线查询与追踪写入逻辑，避免首页聚合和独立主线页再各写一套读表逻辑。
 * 3. 不做什么：不在这里迁移对话推进、选项、章节结算等完整主线流程；这些仍属于后续高副作用链路。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；track 接收 `{ tracked }`。
 * - 输出：progress/chapters 返回 `success(data)`；track 返回 Node 兼容 `sendResult` 包体。
 *
 * 数据流 / 状态流：
 * - HTTP -> `require_authenticated_character_context` -> `GameRouteServices` 主线查询/追踪写入 -> envelope。
 *
 * 复用设计说明：
 * - 主线进度 DTO、章节 DTO 直接复用首页聚合使用的同一批结构，避免 `game/home-overview` 与 `main-quest` 独立路由的字段口径漂移。
 * - 追踪写入沿用单一服务入口，后续补 dialogue/section 完成后仍能共用同一份 progress 初始化逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 主线进度不存在时必须先初始化再写 tracked，不能因为缺少记录直接返回失败。
 * 2. `tracked` 必须延续 Node 的布尔归一化规则，只有显式 `true` 才会写入 true。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct MainQuestChapterListView {
    chapters: Vec<GameHomeMainQuestChapterView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct MainQuestSectionListView {
    sections: Vec<GameHomeMainQuestSectionView>,
}

#[derive(Debug, Deserialize)]
struct MainQuestTrackPayload {
    tracked: Option<bool>,
}

pub fn build_main_quest_router() -> Router<AppState> {
    Router::new()
        .route("/progress", get(main_quest_progress_handler))
        .route("/chapters", get(main_quest_chapters_handler))
        .route(
            "/chapters/{chapter_id}/sections",
            get(main_quest_sections_handler),
        )
        .route("/track", post(main_quest_track_handler))
}

async fn main_quest_progress_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let data = state
        .game_services
        .get_main_quest_progress(context.character.id)
        .await?;
    Ok(success(data))
}

async fn main_quest_chapters_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let chapters = state
        .game_services
        .get_main_quest_chapters(context.character.id)
        .await?;
    Ok(success(MainQuestChapterListView { chapters }))
}

async fn main_quest_track_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MainQuestTrackPayload>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let result = state
        .game_services
        .set_main_quest_tracked(context.character.id, payload.tracked == Some(true))
        .await?;
    Ok(service_result(ServiceResultResponse::new(
        result.success,
        Some(result.message),
        result.data,
    )))
}

async fn main_quest_sections_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chapter_id): Path<String>,
) -> Result<Response, BusinessError> {
    let context = match require_authenticated_character_context(&state, &headers).await {
        Ok(context) => context,
        Err(response) => return Ok(response),
    };
    let normalized_chapter_id = chapter_id.trim().to_string();
    if normalized_chapter_id.is_empty() {
        return Err(BusinessError::new("章节ID不能为空"));
    }
    let sections = state
        .game_services
        .get_main_quest_sections(context.character.id, normalized_chapter_id)
        .await?;
    Ok(success(MainQuestSectionListView { sections }))
}
