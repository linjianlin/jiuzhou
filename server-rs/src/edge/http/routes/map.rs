use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;
use serde_json::Value;

use crate::application::static_data::catalog::{
    get_static_data_catalog, MapDefDto, MapResourceDto, MapRoomDto, MapSummaryDto,
};
use crate::bootstrap::app::AppState;
use crate::edge::http::auth::read_bearer_token;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * map 只读静态路由。
 *
 * 作用：
 * 1. 做什么：补齐 `/world`、`/maps`、`/:mapId`、`/:mapId/rooms/:roomId`、`/:mapId/rooms/:roomId/objects` 五个公开读接口。
 * 2. 做什么：地图详情、房间详情与房间对象统一复用共享静态索引，并叠加在线投影里的房间内玩家信息，避免每次请求重复扫种子和在线角色快照。
 * 3. 不做什么：不实现 `gather/pickup` 这类依赖数据库写入的接口，也不在这里重做任务系统的动态标记计算。
 *
 * 输入 / 输出：
 * - 输入：`mapId`、`roomId`，以及 `objects` 接口可选 Bearer token。
 * - 输出：保持 Node 的 `{ mapName, areas, connections }`、`{ maps }`、`{ map, rooms }`、`{ mapId, room }`、`{ mapId, roomId, objects }` 协议。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `StaticDataCatalog.world_map / maps / map_detail / room meta` -> `runtime.online_projection_registry` 在线玩家补充 -> 直接输出。
 *
 * 复用设计说明：
 * - 地图摘要、地图详情、房间详情、房间对象共用同一份 map 索引与 NPC / monster / item 元数据索引，避免不同 handler 各自遍历 `maps -> rooms` 或重复扫多份 seed。
 * - 在线玩家对象和静态房间对象都在这个路由簇里收口，后续补 `gather/pickup` 时可以继续复用同一套房间对象 DTO，不需要再造第二套协议。
 *
 * 关键边界条件与坑点：
 * 1. `/:mapId` 与 `/:mapId/rooms/:roomId` 仍需维持 `404`；只有 `objects` 接口保留 Node 当前的宽松空数组协议。
 * 2. 地图详情里的 `rooms` 需要保留怪物 `name` 补全，而不是把前端展示逻辑重新下放到客户端。
 * 3. `objects` 接口在 Node 侧遇到不存在的房间会返回空数组而不是 404；Rust 这里必须保持 `200 + { objects: [] }` 的宽松读协议。
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

#[derive(Debug, Clone, Serialize)]
struct RoomObjectsPayload {
    #[serde(rename = "mapId")]
    map_id: String,
    #[serde(rename = "roomId")]
    room_id: String,
    objects: Vec<MapObjectView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type")]
enum MapObjectView {
    #[serde(rename = "npc")]
    Npc {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(rename = "desc", skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    #[serde(rename = "monster")]
    Monster {
        id: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(rename = "base_attrs", skip_serializing_if = "Option::is_none")]
        base_attrs: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_variance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_multiplier_min: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attr_multiplier_max: Option<f64>,
    },
    #[serde(rename = "item")]
    Item {
        id: String,
        #[serde(rename = "object_kind", skip_serializing_if = "Option::is_none")]
        object_kind: Option<String>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
        #[serde(rename = "desc", skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resource: Option<MapResourceStateView>,
    },
    #[serde(rename = "player")]
    Player {
        id: String,
        name: String,
        #[serde(rename = "monthCardActive")]
        month_card_active: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gender: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        realm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        avatar: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MapResourceStateView {
    collect_limit: i32,
    used_count: i32,
    remaining: i32,
    cooldown_sec: i32,
    respawn_sec: i32,
}

pub fn build_map_router() -> Router<AppState> {
    Router::new()
        .route("/world", get(world_map_handler))
        .route("/maps", get(list_maps_handler))
        .route("/{mapId}/rooms/{roomId}/objects", get(get_room_objects_handler))
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

async fn get_room_objects_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((map_id, room_id)): Path<(String, String)>,
) -> Result<Response, BusinessError> {
    let normalized_map_id = map_id.trim().to_string();
    let normalized_room_id = room_id.trim().to_string();
    let catalog = get_static_data_catalog().map_err(internal_business_error)?;
    let exclude_user_id = extract_optional_authenticated_user_id(&state, &headers).await;
    let objects = catalog
        .map_detail(normalized_map_id.as_str())
        .and_then(|detail| detail.room(normalized_room_id.as_str()));

    let objects = match objects {
        Some(room) => {
            build_room_objects(
                room,
                catalog,
                &state,
                exclude_user_id,
                normalized_map_id.as_str(),
                normalized_room_id.as_str(),
            )
            .await
        }
        None => Vec::new(),
    };

    Ok(success(RoomObjectsPayload {
        map_id: normalized_map_id,
        room_id: normalized_room_id,
        objects,
    }))
}

async fn build_room_objects(
    room: &MapRoomDto,
    catalog: &crate::application::static_data::catalog::StaticDataCatalog,
    state: &AppState,
    exclude_user_id: Option<i64>,
    map_id: &str,
    room_id: &str,
) -> Vec<MapObjectView> {
    let npc_entries = room.npcs.as_deref().unwrap_or(&[]);
    let monster_entries = room.monsters.as_deref().unwrap_or(&[]);
    let item_entries = room.items.as_deref().unwrap_or(&[]);
    let resource_entries = room.resources.as_deref().unwrap_or(&[]);
    let mut objects = Vec::with_capacity(
        npc_entries.len()
            + monster_entries.len()
            + item_entries.len()
            + resource_entries.len(),
    );

    for npc_id in npc_entries {
        let Some(npc) = catalog.npc_meta(npc_id.as_str()) else {
            continue;
        };
        if npc.id == "npc-bounty-board" {
            objects.push(MapObjectView::Item {
                id: npc.id.clone(),
                object_kind: Some("board".to_string()),
                name: npc.name.clone(),
                title: npc.title.clone(),
                gender: npc.gender.clone(),
                realm: npc.realm.clone(),
                avatar: npc.avatar.clone(),
                description: npc.description.clone(),
                resource: None,
            });
            continue;
        }

        objects.push(MapObjectView::Npc {
            id: npc.id.clone(),
            name: npc.name.clone(),
            title: npc.title.clone(),
            gender: npc.gender.clone(),
            realm: npc.realm.clone(),
            avatar: npc.avatar.clone(),
            description: npc.description.clone(),
        });
    }

    for monster in monster_entries {
        let Some(meta) = catalog.monster_meta(monster.monster_def_id.as_str()) else {
            continue;
        };
        objects.push(MapObjectView::Monster {
            id: meta.id.clone(),
            name: meta.name.clone(),
            title: meta.title.clone(),
            gender: Some("-".to_string()),
            realm: meta.realm.clone(),
            avatar: meta.avatar.clone(),
            base_attrs: meta.base_attrs.clone(),
            attr_variance: meta.attr_variance,
            attr_multiplier_min: meta.attr_multiplier_min,
            attr_multiplier_max: meta.attr_multiplier_max,
        });
    }

    for item in item_entries {
        let meta = catalog.item_meta(item.item_def_id.as_str());
        objects.push(MapObjectView::Item {
            id: item.item_def_id.clone(),
            object_kind: None,
            name: meta
                .map(|value| value.name.clone())
                .unwrap_or_else(|| item.item_def_id.clone()),
            title: meta.and_then(|value| value.quality.clone()),
            gender: Some("-".to_string()),
            realm: Some("-".to_string()),
            avatar: meta.and_then(|value| value.icon.clone()),
            description: meta.and_then(|value| value.description.clone()),
            resource: None,
        });
    }

    for resource in resource_entries {
        let meta = catalog.item_meta(resource.resource_id.as_str());
        objects.push(MapObjectView::Item {
            id: resource.resource_id.clone(),
            object_kind: Some("resource".to_string()),
            name: meta
                .map(|value| value.name.clone())
                .unwrap_or_else(|| resource.resource_id.clone()),
            title: meta.and_then(|value| value.quality.clone()),
            gender: Some("-".to_string()),
            realm: Some("-".to_string()),
            avatar: meta.and_then(|value| value.icon.clone()),
            description: meta.and_then(|value| value.description.clone()),
            resource: Some(build_default_resource_state(resource)),
        });
    }

    let runtime_services = state.runtime_services.read().await;
    for character_id in runtime_services.online_projection_registry.character_ids() {
        let Some(snapshot) = runtime_services
            .online_projection_registry
            .get_character(character_id)
        else {
            continue;
        };
        if exclude_user_id == Some(snapshot.user_id) {
            continue;
        }
        if !matches_computed_string(&snapshot.computed, "current_map_id", map_id) {
            continue;
        }
        if !matches_computed_string(&snapshot.computed, "current_room_id", room_id) {
            continue;
        }

        objects.push(MapObjectView::Player {
            id: snapshot.character_id.to_string(),
            name: read_computed_string(&snapshot.computed, "nickname")
                .unwrap_or_else(|| format!("修士{}", snapshot.character_id)),
            month_card_active: read_computed_bool(&snapshot.computed, "month_card_active")
                .unwrap_or(false),
            title: read_computed_string(&snapshot.computed, "title"),
            gender: read_computed_string(&snapshot.computed, "gender"),
            realm: build_realm_text(
                read_computed_string(&snapshot.computed, "realm"),
                read_computed_string(&snapshot.computed, "sub_realm"),
            ),
            avatar: read_computed_string(&snapshot.computed, "avatar"),
        });
    }

    objects
}

async fn extract_optional_authenticated_user_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Option<i64> {
    let token = read_bearer_token(headers)?;
    let result = state.auth_services.verify_token_and_session(token.as_str()).await;
    if result.valid {
        result.user_id.filter(|user_id| *user_id > 0)
    } else {
        None
    }
}

fn build_default_resource_state(resource: &MapResourceDto) -> MapResourceStateView {
    let collect_limit = resource.collect_limit.unwrap_or(resource.count).max(1);
    MapResourceStateView {
        collect_limit,
        used_count: 0,
        remaining: collect_limit,
        cooldown_sec: 0,
        respawn_sec: resource.respawn_sec.unwrap_or(60).max(0),
    }
}

fn read_computed_string(computed: &Value, key: &str) -> Option<String> {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn read_computed_bool(computed: &Value, key: &str) -> Option<bool> {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_bool)
}

fn matches_computed_string(computed: &Value, key: &str, expected: &str) -> bool {
    computed
        .as_object()
        .and_then(|map| map.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty() && value == expected)
}

fn build_realm_text(realm: Option<String>, sub_realm: Option<String>) -> Option<String> {
    match (realm, sub_realm) {
        (Some(realm), Some(sub_realm)) if !sub_realm.is_empty() => {
            Some(format!("{realm}·{sub_realm}"))
        }
        (Some(realm), _) if !realm.is_empty() => Some(realm),
        _ => None,
    }
}

fn internal_business_error(error: crate::shared::error::AppError) -> BusinessError {
    let _ = error;
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
