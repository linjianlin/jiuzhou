use std::{collections::HashMap, future::Future, pin::Pin};

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::application::inventory::service::{
    InventoryBagSnapshotView, InventoryInfoView, InventoryItemsPageView, InventoryLocation,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, unauthorized_response};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * inventory 最小只读路由簇。
 *
 * 作用：
 * 1. 做什么：仅提供 `/info`、`/bag/snapshot`、`/items` 三个前端背包首屏读取端点。
 * 2. 做什么：复用现有 Bearer + session + character 读取链路，并把成功响应继续固定为 Node 当前 `success(data)` envelope。
 * 3. 不做什么：不扩展任何 inventory mutation、打造/镶嵌/穿脱/使用等其它路由群。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`/items` 额外接收 `location/page/pageSize` query。
 * - 输出：Node 兼容 `{ success:true, data:... }`；非法 `location` 返回 `400 location参数错误`；无角色返回 `404 角色不存在`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> session 校验 -> `AuthRouteServices::check_character` 获取当前角色
 * - -> `InventoryRouteServices` 读取 info / snapshot / paged items
 * - -> 路由层统一包装成功 envelope。
 *
 * 复用设计说明：
 * - 三个只读端点共享同一 `require_authenticated_character_id`，把会话校验与角色缺失语义收敛到单一入口，避免 handler 重复拼接鉴权流程。
 * - `InventoryRouteServices` 把 HTTP 协议和读模型实现解耦，后续若继续补 richer inventory query，只替换应用服务，不改现有合同测试。
 *
 * 关键边界条件与坑点：
 * 1. `/items` 的 `location` 文案必须继续是 `location参数错误`，不能改成通用 `参数错误`。
 * 2. `page/pageSize` 非法时要沿用 Node 的宽松默认策略，而不是新增 400 校验，否则会破坏当前前端请求容错。
 */
pub trait InventoryRouteServices: Send + Sync {
    fn get_inventory_info<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryInfoView, BusinessError>> + Send + 'a>>;

    fn get_bag_inventory_snapshot<'a>(
        &'a self,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryBagSnapshotView, BusinessError>> + Send + 'a>>;

    fn get_inventory_items<'a>(
        &'a self,
        character_id: i64,
        location: InventoryLocation,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryItemsPageView, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopInventoryRouteServices;

impl InventoryRouteServices for NoopInventoryRouteServices {
    fn get_inventory_info<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryInfoView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            Ok(InventoryInfoView {
                bag_capacity: 100,
                warehouse_capacity: 1000,
                bag_used: 0,
                warehouse_used: 0,
            })
        })
    }

    fn get_bag_inventory_snapshot<'a>(
        &'a self,
        _character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryBagSnapshotView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(InventoryBagSnapshotView {
                info: InventoryInfoView {
                    bag_capacity: 100,
                    warehouse_capacity: 1000,
                    bag_used: 0,
                    warehouse_used: 0,
                },
                bag_items: Vec::new(),
                equipped_items: Vec::new(),
            })
        })
    }

    fn get_inventory_items<'a>(
        &'a self,
        _character_id: i64,
        _location: InventoryLocation,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<InventoryItemsPageView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(InventoryItemsPageView {
                items: Vec::new(),
                total: 0,
                page,
                page_size,
            })
        })
    }
}

pub fn build_inventory_router() -> Router<AppState> {
    Router::new()
        .route("/info", get(inventory_info_handler))
        .route("/bag/snapshot", get(bag_inventory_snapshot_handler))
        .route("/items", get(inventory_items_handler))
}

async fn inventory_info_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let character_id = match require_authenticated_character_id(&state, &headers).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let info = state
        .inventory_services
        .get_inventory_info(character_id)
        .await?;
    Ok(success(info))
}

async fn bag_inventory_snapshot_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    let character_id = match require_authenticated_character_id(&state, &headers).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let snapshot = state
        .inventory_services
        .get_bag_inventory_snapshot(character_id)
        .await?;
    Ok(success(snapshot))
}

async fn inventory_items_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, BusinessError> {
    let character_id = match require_authenticated_character_id(&state, &headers).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let location = query
        .get("location")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or("bag");
    let Some(location) = InventoryLocation::parse(location) else {
        return Err(BusinessError::new("location参数错误"));
    };

    let page = parse_positive_i64(query.get("page").map(String::as_str)).unwrap_or(1);
    let page_size = parse_positive_i64(query.get("pageSize").map(String::as_str))
        .unwrap_or(100)
        .min(200);
    let result = state
        .inventory_services
        .get_inventory_items(character_id, location, page, page_size)
        .await?;

    Ok(success(result))
}

async fn require_authenticated_character_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<i64, Response> {
    let Some(token) = crate::edge::http::auth::read_bearer_token(headers) else {
        return Err(unauthorized_response());
    };
    let auth_result = state.auth_services.verify_token_and_session(&token).await;
    if !auth_result.valid {
        return match invalid_session_response(auth_result.kicked) {
            Ok(response) => Err(response),
            Err(error) => Err(error.into_response()),
        };
    }

    let Some(user_id) = auth_result.user_id else {
        return Err(unauthorized_response());
    };
    let character_result = match state.auth_services.check_character(user_id).await {
        Ok(result) => result,
        Err(error) => return Err(error.into_response()),
    };
    let Some(character) = character_result.character else {
        return Err(
            BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response(),
        );
    };
    if !character_result.has_character || character.id <= 0 {
        return Err(
            BusinessError::with_status("角色不存在", StatusCode::NOT_FOUND).into_response(),
        );
    }
    Ok(character.id)
}

fn parse_positive_i64(value: Option<&str>) -> Option<i64> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = raw.parse::<i64>().ok()?;
    if parsed > 0 {
        Some(parsed)
    } else {
        None
    }
}
