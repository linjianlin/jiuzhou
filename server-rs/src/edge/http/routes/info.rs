use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::application::static_data::catalog::{get_static_data_catalog, GameItemTaxonomyDto};
use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * info 静态配置路由。
 *
 * 作用：
 * 1. 做什么：提供 `/item-taxonomy`，复刻 Node 当前对外暴露的全局物品分类字典协议。
 * 2. 做什么：只消费共享静态索引，不重复读种子文件，也不在请求期重新做分类聚合。
 * 3. 不做什么：不实现 `/api/info/:type/:id` 的动态详情查询，因为那部分仍依赖数据库与运行态服务。
 *
 * 输入 / 输出：
 * - 输入：无。
 * - 输出：`{ success:true, data:{ taxonomy } }`，其中 `taxonomy` 字段结构与 Node 保持一致。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `StaticDataCatalog.item_taxonomy` -> 直接序列化返回。
 *
 * 复用设计说明：
 * - taxonomy 的聚合规则已集中在静态索引层，这里只做协议装配，避免未来 map/market/inventory 再各自实现一份分类规则。
 *
 * 关键边界条件与坑点：
 * 1. 分类字典必须来自后端种子文件，不能在路由层硬编码选项。
 * 2. 静态索引装载失败时要显式返回服务错误，不能把失败伪装成空 taxonomy。
 */
#[derive(Debug, Clone, Serialize)]
struct ItemTaxonomyPayload {
    taxonomy: GameItemTaxonomyDto,
}

pub fn build_info_router() -> Router<AppState> {
    Router::new().route("/item-taxonomy", get(item_taxonomy_handler))
}

async fn item_taxonomy_handler() -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    Ok(success(ItemTaxonomyPayload {
        taxonomy: catalog.item_taxonomy().clone(),
    }))
}

fn internal_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
