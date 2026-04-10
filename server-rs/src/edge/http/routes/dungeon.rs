use axum::extract::{Path, Query};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde::Serialize;

use crate::application::static_data::dungeon::{
    get_dungeon_static_catalog, DungeonCategoryDto, DungeonDefDto, DungeonListFilter,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * dungeon 只读静态路由。
 *
 * 作用：
 * 1. 做什么：补齐 Node 当前公开的 `/categories`、`/list`、`/preview/:id` 三个只读秘境接口。
 * 2. 做什么：路由层只负责 query/path 解析与协议输出，所有种子扫描、难度预览与掉落聚合都统一复用静态索引。
 * 3. 不做什么：不处理实例创建、加入、开战、推进，也不伪造登录态下的剩余次数统计。
 *
 * 输入 / 输出：
 * - 输入：`type/q/realm` 查询参数与 `preview/:id?rank=` 路径参数。
 * - 输出：保持 Node 当前 `sendSuccess` 协议，分别返回 `{ categories }`、`{ dungeons }`、完整 preview 数据。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `DungeonStaticCatalog` 读取预构建索引 -> 路由层输出 Node 兼容 envelope。
 *
 * 复用设计说明：
 * - 三个只读接口共用同一份 `DungeonStaticCatalog`，避免每个 handler 各自枚举 `dungeon_*.json` 并重复做排序、筛选和掉落预览拼装。
 * - query 归一化逻辑集中在这里，后续若补前端首页推荐秘境或搜索联想，可直接复用同一套 filter 口径。
 *
 * 关键边界条件与坑点：
 * 1. 非法 `type` 在 Node 侧会被忽略而不是报错，这里必须保持同一语义。
 * 2. `preview` 只有秘境本体不存在时才返回 `404 秘境不存在`；缺失指定 rank 仍要返回 200 的空难度结构。
 */
#[derive(Debug, Deserialize)]
struct DungeonListQuery {
    #[serde(rename = "type")]
    dungeon_type: Option<String>,
    q: Option<String>,
    realm: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DungeonPreviewQuery {
    rank: Option<String>,
}

#[derive(Debug, Serialize)]
struct DungeonCategoriesPayload {
    categories: Vec<DungeonCategoryDto>,
}

#[derive(Debug, Serialize)]
struct DungeonListPayload {
    dungeons: Vec<DungeonDefDto>,
}

pub fn build_dungeon_router() -> Router<AppState> {
    Router::new()
        .route("/categories", get(list_dungeon_categories_handler))
        .route("/list", get(list_dungeons_handler))
        .route("/preview/{id}", get(get_dungeon_preview_handler))
}

async fn list_dungeon_categories_handler() -> Result<Response, BusinessError> {
    let catalog = get_dungeon_static_catalog().map_err(internal_business_error)?;
    Ok(success(DungeonCategoriesPayload {
        categories: catalog.categories().to_vec(),
    }))
}

async fn list_dungeons_handler(
    Query(query): Query<DungeonListQuery>,
) -> Result<Response, BusinessError> {
    let catalog = get_dungeon_static_catalog().map_err(internal_business_error)?;
    Ok(success(DungeonListPayload {
        dungeons: catalog.list(&DungeonListFilter {
            dungeon_type: query.dungeon_type,
            keyword: query.q,
            realm: query.realm,
        }),
    }))
}

async fn get_dungeon_preview_handler(
    Path(dungeon_id): Path<String>,
    Query(query): Query<DungeonPreviewQuery>,
) -> Result<Response, BusinessError> {
    let catalog = get_dungeon_static_catalog().map_err(internal_business_error)?;
    let difficulty_rank = query
        .rank
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|value| value.is_positive())
        .unwrap_or(1);
    let Some(preview) = catalog.preview(dungeon_id.trim(), difficulty_rank) else {
        return Err(BusinessError::with_status(
            "秘境不存在",
            axum::http::StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(preview))
}

fn internal_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
