use axum::extract::Path;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::application::static_data::catalog::{
    get_static_data_catalog, MapDefDto, MapRoomDto, MapSummaryDto,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * map 只读静态路由。
 *
 * 作用：
 * 1. 做什么：补齐 `/world`、`/maps`、`/:mapId`、`/:mapId/rooms/:roomId` 四个公开读接口。
 * 2. 做什么：地图与房间详情统一走共享静态索引，并在索引层前置完成怪物中文名补全，避免每次请求重复建映射。
 * 3. 不做什么：不实现 `objects/gather/pickup` 这类依赖动态房间状态的接口。
 *
 * 输入 / 输出：
 * - 输入：`mapId`、`roomId`。
 * - 输出：保持 Node 的 `{ mapName, areas, connections }`、`{ maps }`、`{ map, rooms }`、`{ mapId, room }` 协议。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `StaticDataCatalog.world_map / maps / map_detail` -> 直接输出。
 *
 * 复用设计说明：
 * - 地图摘要、地图详情、房间详情共用同一份 map 索引与 room 索引，避免不同 handler 各自遍历 `maps -> rooms`。
 *
 * 关键边界条件与坑点：
 * 1. 地图不存在必须返回 `404 地图不存在`，房间不存在必须返回 `404 房间不存在`。
 * 2. 地图详情里的 `rooms` 需要保留怪物 `name` 补全，而不是把前端展示逻辑重新下放到客户端。
 */
#[derive(Debug, Clone, Serialize)]
struct MapsPayload {
    maps: Vec<MapSummaryDto>,
}

#[derive(Debug, Clone, Serialize)]
struct MapDetailPayload {
    map: MapDefDto,
    rooms: Vec<MapRoomDto>,
}

#[derive(Debug, Clone, Serialize)]
struct RoomDetailPayload {
    #[serde(rename = "mapId")]
    map_id: String,
    room: MapRoomDto,
}

pub fn build_map_router() -> Router<AppState> {
    Router::new()
        .route("/world", get(world_map_handler))
        .route("/maps", get(list_maps_handler))
        .route("/{mapId}/rooms/{roomId}", get(get_room_handler))
        .route("/{mapId}", get(get_map_detail_handler))
}

async fn world_map_handler() -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    Ok(success(catalog.world_map().clone()))
}

async fn list_maps_handler() -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    Ok(success(MapsPayload {
        maps: catalog.maps().to_vec(),
    }))
}

async fn get_map_detail_handler(Path(map_id): Path<String>) -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    let detail = catalog.map_detail(map_id.trim()).cloned();
    let Some(detail) = detail else {
        return Err(BusinessError::with_status(
            "地图不存在",
            axum::http::StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(MapDetailPayload {
        map: detail.map,
        rooms: detail.rooms,
    }))
}

async fn get_room_handler(
    Path((map_id, room_id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    let Some(detail) = catalog.map_detail(map_id.trim()) else {
        return Err(BusinessError::with_status(
            "房间不存在",
            axum::http::StatusCode::NOT_FOUND,
        ));
    };
    let Some(room) = detail.room(room_id.trim()).cloned() else {
        return Err(BusinessError::with_status(
            "房间不存在",
            axum::http::StatusCode::NOT_FOUND,
        ));
    };
    Ok(success(RoomDetailPayload { map_id, room }))
}

fn internal_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
