use axum::extract::Path;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::application::static_data::catalog::{get_static_data_catalog, TechniqueDefDto};
use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * technique 静态功法路由。
 *
 * 作用：
 * 1. 做什么：提供 `/` 列表与 `/:techniqueId` 详情，只输出 Node 当前前端消费的静态功法协议。
 * 2. 做什么：把功法、层级、技能的过滤/排序/材料补全复用到共享静态索引，避免请求期重复扫描多个大 JSON 文件。
 * 3. 不做什么：不扩展角色配技、研究、升级等动态接口；这些仍属于后续业务迁移范围。
 *
 * 输入 / 输出：
 * - 输入：详情接口接收 `techniqueId`。
 * - 输出：列表返回 `{ techniques }`；详情返回 `{ technique, layers, skills }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `StaticDataCatalog.techniques / technique_detail` -> 直接序列化为 Node 兼容 envelope。
 *
 * 复用设计说明：
 * - 列表与详情共用同一份 technique 索引，避免“列表可见”和“详情可见”规则分叉。
 * - 层级预览裁剪在索引构建阶段统一完成，后续若接角色已学习视图，只需要在索引层增加另一条分支。
 *
 * 关键边界条件与坑点：
 * 1. `partner_only` 功法不能出现在角色侧公开列表里。
 * 2. 详情未命中时必须维持 `404 { success:false, message:'未找到功法' }`，不能回成空成功包。
 */
#[derive(Debug, Clone, Serialize)]
struct TechniqueListPayload {
    techniques: Vec<TechniqueDefDto>,
}

pub fn build_technique_router() -> Router<AppState> {
    Router::new()
        .route("/", get(list_techniques_handler))
        .route("/{techniqueId}", get(get_technique_detail_handler))
}

async fn list_techniques_handler() -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    Ok(success(TechniqueListPayload {
        techniques: catalog.techniques().to_vec(),
    }))
}

async fn get_technique_detail_handler(
    Path(technique_id): Path<String>,
) -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    let detail = catalog.technique_detail(technique_id.trim()).cloned();
    let Some(detail) = detail else {
        return Err(BusinessError::with_status(
            "未找到功法",
            axum::http::StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(detail))
}

fn internal_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
