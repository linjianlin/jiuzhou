use std::{collections::HashMap, future::Future, pin::Pin};

use axum::extract::{Json, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::application::inventory::service::{
    InventoryBagSnapshotView, InventoryInfoView, InventoryItemsPageView, InventoryLocation,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::{invalid_session_response, unauthorized_response};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::{service_result, success, ServiceResultResponse};

/**
 * inventory 最小读写路由簇。
 *
 * 作用：
 * 1. 做什么：提供 `/info`、`/bag/snapshot`、`/items` 三个前端背包首屏读取端点，并补齐 `/remove`、`/lock`、`/expand` 这组最小 mutation。
 * 2. 做什么：复用现有 Bearer + session + character 读取链路，把只读请求继续固定为 Node 当前 `success(data)` envelope，把写接口固定为 `sendResult` 形状。
 * 3. 不做什么：不扩展其它 inventory mutation、打造/镶嵌/穿脱/使用等更重写链路。
 *
 * 输入 / 输出：
 * - 输入：Authorization Bearer token；`/items` 额外接收 `location/page/pageSize` query；`/remove` 接收 `{ itemId | itemInstanceId | instanceId, qty? }`；`/lock` 接收 `{ itemId | itemInstanceId | instanceId, locked }`。
 * - 输出：读取接口返回 Node 兼容 `{ success:true, data:... }`；写接口返回 Node 兼容 `{ success, message, data? }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> session 校验 -> `AuthRouteServices::check_character` 获取当前角色
 * - -> `InventoryRouteServices` 读取 info / snapshot / paged items / 执行物品移除与锁定
 * - -> 路由层统一包装成功 envelope。
 *
 * 复用设计说明：
 * - 三个只读端点共享同一 `require_authenticated_character_id`，把会话校验与角色缺失语义收敛到单一入口，避免 handler 重复拼接鉴权流程。
 * - `InventoryRouteServices` 把 HTTP 协议和背包读写实现解耦；本次把最轻量的 `remove/lock` 收进同一 trait，后续继续补 `move/remove-batch/sort` 时不需要再拆第二套路由服务。
 *
 * 关键边界条件与坑点：
 * 1. `/items` 的 `location` 文案必须继续是 `location参数错误`，不能改成通用 `参数错误`。
 * 2. `page/pageSize` 非法时要沿用 Node 的宽松默认策略，而不是新增 400 校验，否则会破坏当前前端请求容错。
 * 3. `/remove` 与 `/lock` 都要复用同一套物品 ID 别名解析，避免 `itemId/itemInstanceId/instanceId` 在不同 handler 漂移出不同口径。
 * 4. `/lock` 必须沿用 Node 的参数文案：缺少物品 ID 返回 `参数不完整`，ID 非法返回 `itemId参数错误`，`locked` 非布尔返回 `locked参数错误`。
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

    fn set_item_locked<'a>(
        &'a self,
        character_id: i64,
        item_instance_id: i64,
        locked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<InventoryLockDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    >;

    fn remove_item<'a>(
        &'a self,
        character_id: i64,
        item_instance_id: i64,
        qty: i32,
    ) -> Pin<Box<dyn Future<Output = Result<ServiceResultResponse<()>, BusinessError>> + Send + 'a>>;
}

#[derive(Debug, Clone, Default)]
pub struct NoopInventoryRouteServices;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InventoryLockDataView {
    pub item_id: i64,
    pub locked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryLockPayload {
    item_id: Option<Value>,
    item_instance_id: Option<Value>,
    instance_id: Option<Value>,
    locked: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryRemovePayload {
    item_id: Option<Value>,
    item_instance_id: Option<Value>,
    instance_id: Option<Value>,
    qty: Option<Value>,
}

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

    fn set_item_locked<'a>(
        &'a self,
        _character_id: i64,
        item_instance_id: i64,
        locked: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<InventoryLockDataView>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some(if locked { "已锁定" } else { "已解锁" }.to_string()),
                Some(InventoryLockDataView {
                    item_id: item_instance_id,
                    locked,
                }),
            ))
        })
    }

    fn remove_item<'a>(
        &'a self,
        _character_id: i64,
        _item_instance_id: i64,
        _qty: i32,
    ) -> Pin<Box<dyn Future<Output = Result<ServiceResultResponse<()>, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move {
            Ok(ServiceResultResponse::new(
                true,
                Some("移除成功".to_string()),
                None,
            ))
        })
    }
}

pub fn build_inventory_router() -> Router<AppState> {
    Router::new()
        .route("/info", get(inventory_info_handler))
        .route("/bag/snapshot", get(bag_inventory_snapshot_handler))
        .route("/items", get(inventory_items_handler))
        .route("/remove", post(inventory_remove_handler))
        .route("/lock", post(inventory_lock_handler))
        .route("/expand", post(inventory_expand_handler))
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

async fn inventory_lock_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryLockPayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_authenticated_character_id(&state, &headers).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let item_instance_id = parse_body_item_instance_id(
        payload.item_id.as_ref(),
        payload.item_instance_id.as_ref(),
        payload.instance_id.as_ref(),
    )?;
    let locked = parse_locked_flag(payload.locked.as_ref())?;
    let result = state
        .inventory_services
        .set_item_locked(character_id, item_instance_id, locked)
        .await?;

    Ok(service_result(result))
}

async fn inventory_remove_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryRemovePayload>,
) -> Result<Response, BusinessError> {
    let character_id = match require_authenticated_character_id(&state, &headers).await {
        Ok(character_id) => character_id,
        Err(response) => return Ok(response),
    };

    let item_instance_id = parse_body_item_instance_id(
        payload.item_id.as_ref(),
        payload.item_instance_id.as_ref(),
        payload.instance_id.as_ref(),
    )?;
    let qty = parse_remove_qty(payload.qty.as_ref())?;
    let result = state
        .inventory_services
        .remove_item(character_id, item_instance_id, qty)
        .await?;

    Ok(service_result(result))
}

async fn inventory_expand_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, BusinessError> {
    match require_authenticated_character_id(&state, &headers).await {
        Ok(_) => Err(BusinessError::with_status(
            "请通过使用扩容道具进行扩容",
            StatusCode::FORBIDDEN,
        )),
        Err(response) => Ok(response),
    }
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

fn parse_body_item_instance_id(
    item_id: Option<&Value>,
    item_instance_id: Option<&Value>,
    instance_id: Option<&Value>,
) -> Result<i64, BusinessError> {
    let raw_item_instance_id = item_instance_id.or(instance_id).or(item_id);
    let Some(raw_item_instance_id) = raw_item_instance_id else {
        return Err(BusinessError::new("参数不完整"));
    };
    parse_positive_i64_value(raw_item_instance_id)
        .ok_or_else(|| BusinessError::new("itemId参数错误"))
}

fn parse_locked_flag(value: Option<&Value>) -> Result<bool, BusinessError> {
    match value {
        None => Err(BusinessError::new("参数不完整")),
        Some(Value::Bool(locked)) => Ok(*locked),
        Some(_) => Err(BusinessError::new("locked参数错误")),
    }
}

fn parse_remove_qty(value: Option<&Value>) -> Result<i32, BusinessError> {
    match value {
        None => Ok(1),
        Some(raw_qty) => parse_positive_i64_value(raw_qty)
            .and_then(|qty| i32::try_from(qty).ok())
            .ok_or_else(|| BusinessError::new("qty参数错误")),
    }
}

fn parse_positive_i64_value(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().filter(|value| *value > 0),
        Value::String(text) => text.trim().parse::<i64>().ok().filter(|value| *value > 0),
        _ => None,
    }
}
