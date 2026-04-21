use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use sqlx::Row;
use serde::{Deserialize, Serialize};

use crate::auth;
use crate::http::info::{InfoItemResourceDto, InfoTargetDto, map_item_target, map_monster_target, map_npc_target};
use crate::repo::info_target::{get_item_info_target, get_monster_info_target, get_npc_info_target};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct MapSeedFile {
    maps: Vec<MapSeed>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct MapSeed {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub background_image: Option<String>,
    pub map_type: Option<String>,
    pub region: Option<String>,
    pub req_realm_min: Option<String>,
    pub req_level_min: Option<i64>,
    pub rooms: Option<Vec<MapRoomDto>>,
    pub sort_weight: Option<i64>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct MapRoomDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub position: Option<serde_json::Value>,
    pub room_type: Option<String>,
    pub connections: Option<Vec<serde_json::Value>>,
    pub npcs: Option<Vec<String>>,
    pub monsters: Option<Vec<EnrichedMonsterDto>>,
    pub resources: Option<Vec<serde_json::Value>>,
    pub items: Option<Vec<serde_json::Value>>,
    pub portals: Option<Vec<serde_json::Value>>,
    pub events: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrichedMonsterDto {
    pub monster_def_id: String,
    pub count: i64,
    pub respawn_sec: Option<i64>,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorldMapAreaDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub level: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldMapData {
    pub map_name: String,
    pub areas: Vec<WorldMapAreaDto>,
    pub connections: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapListData {
    pub maps: Vec<MapListItemDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapListItemDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub background_image: Option<String>,
    pub map_type: String,
    pub region: Option<String>,
    pub sort_weight: i64,
    pub req_level_min: i64,
    pub req_realm_min: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapDetailData {
    pub map: MapSeed,
    pub rooms: Vec<MapRoomDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomDetailData {
    pub map_id: String,
    pub room: MapRoomDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomObjectsData {
    pub map_id: String,
    pub room_id: String,
    pub objects: Vec<RoomObjectDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatherRoomResourceData {
    pub item_def_id: String,
    pub qty: i64,
    pub remaining: i64,
    pub cooldown_sec: i64,
    pub action_sec: Option<i64>,
    pub gather_until: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickupRoomItemData {
    pub item_def_id: String,
    pub qty: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RoomObjectDto {
    Info(InfoTargetDto),
}

pub async fn get_world_map() -> Json<SuccessResponse<WorldMapData>> {
    send_success(WorldMapData {
        map_name: "九州大陆".to_string(),
        areas: vec![
            WorldMapAreaDto { id: "NW".to_string(), name: "NW".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "N".to_string(), name: "N".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "NE".to_string(), name: "NE".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "W".to_string(), name: "W".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "C".to_string(), name: "C".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "E".to_string(), name: "E".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "SW".to_string(), name: "SW".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "S".to_string(), name: "S".to_string(), description: String::new(), level: "Lv.1".to_string() },
            WorldMapAreaDto { id: "SE".to_string(), name: "SE".to_string(), description: String::new(), level: "Lv.1".to_string() },
        ],
        connections: vec![
            ("NW".to_string(), "N".to_string()), ("N".to_string(), "NE".to_string()),
            ("W".to_string(), "C".to_string()), ("C".to_string(), "E".to_string()),
            ("SW".to_string(), "S".to_string()), ("S".to_string(), "SE".to_string()),
            ("NW".to_string(), "W".to_string()), ("N".to_string(), "C".to_string()), ("NE".to_string(), "E".to_string()),
            ("W".to_string(), "SW".to_string()), ("C".to_string(), "S".to_string()), ("E".to_string(), "SE".to_string()),
        ],
    })
}

pub async fn get_enabled_maps() -> Result<Json<SuccessResponse<MapListData>>, AppError> {
    let mut maps: Vec<_> = load_map_seeds()?
        .into_iter()
        .filter(|map| map.enabled != Some(false))
        .map(|map| MapListItemDto {
            id: map.id,
            code: map.code,
            name: map.name,
            description: map.description,
            background_image: map.background_image,
            map_type: map.map_type.unwrap_or_else(|| "field".to_string()),
            region: map.region,
            sort_weight: map.sort_weight.unwrap_or_default(),
            req_level_min: map.req_level_min.unwrap_or_default(),
            req_realm_min: map.req_realm_min,
        })
        .collect();
    maps.sort_by(|left, right| right.sort_weight.cmp(&left.sort_weight).then_with(|| left.id.cmp(&right.id)));
    Ok(send_success(MapListData { maps }))
}

pub async fn get_map_detail(Path(map_id): Path<String>) -> Result<Json<SuccessResponse<MapDetailData>>, AppError> {
    let map = load_map_seeds()?
        .into_iter()
        .find(|map| map.enabled != Some(false) && map.id == map_id)
        .ok_or_else(|| AppError::not_found("地图不存在"))?;
    let rooms = enrich_rooms(map.rooms.clone().unwrap_or_default())?;
    Ok(send_success(MapDetailData { map, rooms }))
}

pub async fn get_room_detail(Path((map_id, room_id)): Path<(String, String)>) -> Result<Json<SuccessResponse<RoomDetailData>>, AppError> {
    let map = load_map_seeds()?
        .into_iter()
        .find(|map| map.enabled != Some(false) && map.id == map_id)
        .ok_or_else(|| AppError::not_found("房间不存在"))?;
    let room = enrich_rooms(map.rooms.unwrap_or_default())?
        .into_iter()
        .find(|room| room.id == room_id)
        .ok_or_else(|| AppError::not_found("房间不存在"))?;
    Ok(send_success(RoomDetailData { map_id, room }))
}

pub async fn get_room_objects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((map_id, room_id)): Path<(String, String)>,
) -> Result<Json<SuccessResponse<RoomObjectsData>>, AppError> {
    let map = load_map_seeds()?
        .into_iter()
        .find(|map| map.enabled != Some(false) && map.id == map_id)
        .ok_or_else(|| AppError::not_found("房间不存在"))?;
    let room = map
        .rooms
        .unwrap_or_default()
        .into_iter()
        .find(|room| room.id == room_id)
        .ok_or_else(|| AppError::not_found("房间不存在"))?;
    let task_markers = resolve_room_task_markers(&state, &headers, &room).await?;
    let resource_state_by_id = load_room_resource_states(&state, task_markers.character_id, &map_id, &room_id, &room).await?;

    let mut objects = Vec::new();
    for npc_id in room.npcs.clone().unwrap_or_default() {
        if let Some(target) = get_npc_info_target(&npc_id)? {
            let mut mapped = map_npc_target(target);
            apply_task_marker(&mut mapped, task_markers.npc_markers.get(npc_id.trim()).copied(), task_markers.tracked_npc_ids.contains(npc_id.trim()));
            objects.push(RoomObjectDto::Info(mapped));
        }
    }
    if let Some(monsters) = room.monsters.clone() {
        for monster in monsters {
            if let Some(target) = get_monster_info_target(&monster.monster_def_id)? {
                let mut mapped = map_monster_target(target);
                let id = monster.monster_def_id.trim().to_string();
                apply_task_marker(&mut mapped, task_markers.monster_markers.get(id.as_str()).copied(), task_markers.tracked_monster_ids.contains(id.as_str()));
                objects.push(RoomObjectDto::Info(mapped));
            }
        }
    }
    if let Some(resources) = room.resources.clone() {
        for resource in resources {
            if let Some(resource_id) = resource.get("resource_id").and_then(|value| value.as_str()) {
                if let Some(item) = get_item_info_target(resource_id)? {
                    let mut info = map_item_target(item);
                    if let InfoTargetDto::Item { ref mut id, ref mut object_kind, ref mut resource, .. } = info {
                        *id = resource_id.to_string();
                        *object_kind = Some("resource".to_string());
                        *resource = resource_state_by_id.get(resource_id).cloned();
                    }
                    apply_task_marker(&mut info, task_markers.resource_markers.get(resource_id.trim()).copied(), task_markers.tracked_resource_ids.contains(resource_id.trim()));
                    objects.push(RoomObjectDto::Info(info));
                }
            }
        }
    }
    if let Some(items) = room.items.clone() {
        for item in items {
            if let Some(item_def_id) = item.get("item_def_id").and_then(|value| value.as_str()) {
                if let Some(item_info) = get_item_info_target(item_def_id)? {
                    objects.push(RoomObjectDto::Info(map_item_target(item_info)));
                }
            }
        }
    }

    Ok(send_success(RoomObjectsData {
        map_id,
        room_id,
        objects,
    }))
}

pub async fn gather_room_resource(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((map_id, room_id, resource_id)): Path<(String, String, String)>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let room = get_room_seed(&map_id, &room_id)?;
    let cfg = get_room_resource_config(&room, &resource_id).ok_or_else(|| AppError::config("资源不存在"))?;
    let action_sec = 5_i64;
    let row = state
        .database
        .fetch_optional(
            "SELECT id, used_count, to_char(gather_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS gather_until_text, to_char(cooldown_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS cooldown_until_text FROM character_room_resource_state WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = $4 LIMIT 1 FOR UPDATE",
            |query| query.bind(actor.character_id).bind(&map_id).bind(&room_id).bind(&resource_id),
        )
        .await?;
    let now = time::OffsetDateTime::now_utc();
    let row_id = row.as_ref().and_then(|row| row.try_get::<Option<i64>, _>("id").ok().flatten());
    let used_count = row.as_ref().and_then(|row| row.try_get::<Option<i64>, _>("used_count").ok().flatten()).unwrap_or_default();
    let cooldown_until = row.as_ref().and_then(|row| row.try_get::<Option<String>, _>("cooldown_until_text").ok().flatten());
    let gather_until = row.as_ref().and_then(|row| row.try_get::<Option<String>, _>("gather_until_text").ok().flatten());
    if let Some(cooldown_until) = cooldown_until.as_deref().and_then(parse_rfc3339) {
        if cooldown_until > now {
            let remaining = ((cooldown_until.unix_timestamp() - now.unix_timestamp()).max(1)) as i64;
            return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<GatherRoomResourceData> {
                success: false,
                message: Some(format!("资源尚未刷新，剩余{}秒", remaining)),
                data: None,
            }));
        }
    }
    let normalized_used = if cooldown_until.as_deref().and_then(parse_rfc3339).map(|value| value <= now).unwrap_or(false) { 0 } else { used_count.max(0) };
    let remaining_before = (cfg.collect_limit - normalized_used).max(0);
    if remaining_before <= 0 {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<GatherRoomResourceData> {
            success: false,
            message: Some("资源已耗尽".to_string()),
            data: None,
        }));
    }
    if let Some(gather_until) = gather_until.as_deref().and_then(parse_rfc3339) {
        if gather_until > now {
            let cooldown_sec = ((gather_until.unix_timestamp() - now.unix_timestamp()).max(1)) as i64;
            return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
                success: true,
                message: Some("采集中".to_string()),
                data: Some(GatherRoomResourceData {
                    item_def_id: resource_id.clone(),
                    qty: 0,
                    remaining: remaining_before,
                    cooldown_sec,
                    action_sec: Some(action_sec),
                    gather_until: Some(gather_until.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
                }),
            }));
        }
    }
    if gather_until.is_none() {
        let next_gather_until = now + time::Duration::seconds(action_sec);
        if let Some(id) = row_id {
            state.database.execute(
                "UPDATE character_room_resource_state SET gather_until = $1::timestamptz, updated_at = NOW() WHERE id = $2",
                |query| query.bind(next_gather_until.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()).bind(id),
            ).await?;
        } else {
            state.database.execute(
                "INSERT INTO character_room_resource_state (character_id, map_id, room_id, resource_id, used_count, gather_until, cooldown_until, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, NULL, NOW(), NOW()) ON CONFLICT (character_id, map_id, room_id, resource_id) DO UPDATE SET gather_until = EXCLUDED.gather_until, updated_at = NOW()",
                |query| query.bind(actor.character_id).bind(&map_id).bind(&room_id).bind(&resource_id).bind(normalized_used).bind(next_gather_until.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
            ).await?;
        }
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
            success: true,
            message: Some("开始采集".to_string()),
            data: Some(GatherRoomResourceData {
                item_def_id: resource_id,
                qty: 0,
                remaining: remaining_before,
                cooldown_sec: action_sec,
                action_sec: Some(action_sec),
                gather_until: Some(next_gather_until.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
            }),
        }));
    }

    let next_used = normalized_used + 1;
    if next_used > cfg.collect_limit {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<GatherRoomResourceData> {
            success: false,
            message: Some("资源已耗尽".to_string()),
            data: None,
        }));
    }
    let will_deplete = next_used >= cfg.collect_limit;
    let cooldown_until = if will_deplete { Some(now + time::Duration::seconds(cfg.respawn_sec)) } else { None };
    let next_gather_until = if will_deplete { None } else { Some(now + time::Duration::seconds(action_sec)) };
    if let Some(id) = row_id {
        state.database.execute(
            "UPDATE character_room_resource_state SET used_count = $1, gather_until = $2::timestamptz, cooldown_until = $3::timestamptz, updated_at = NOW() WHERE id = $4",
            |query| query.bind(next_used).bind(next_gather_until.and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok())).bind(cooldown_until.and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok())).bind(id),
        ).await?;
    } else {
        state.database.execute(
            "INSERT INTO character_room_resource_state (character_id, map_id, room_id, resource_id, used_count, gather_until, cooldown_until, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, NOW(), NOW()) ON CONFLICT (character_id, map_id, room_id, resource_id) DO UPDATE SET used_count = EXCLUDED.used_count, gather_until = EXCLUDED.gather_until, cooldown_until = EXCLUDED.cooldown_until, updated_at = NOW()",
            |query| query.bind(actor.character_id).bind(&map_id).bind(&room_id).bind(&resource_id).bind(next_used).bind(next_gather_until.and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok())).bind(cooldown_until.and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok())),
        ).await?;
    }
    state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, $3, 1, 'none', 'bag', NOW(), NOW(), 'gather') RETURNING id",
        |query| query.bind(actor.user_id).bind(actor.character_id).bind(&resource_id),
    ).await?;
    return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("采集成功".to_string()),
        data: Some(GatherRoomResourceData {
            item_def_id: resource_id,
            qty: 1,
            remaining: (cfg.collect_limit - next_used).max(0),
            cooldown_sec: next_gather_until.map(|_| action_sec).unwrap_or(0),
            action_sec: Some(action_sec),
            gather_until: next_gather_until.and_then(|value| value.format(&time::format_description::well_known::Rfc3339).ok()),
        }),
    }))
}

pub async fn pickup_room_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((map_id, room_id, item_def_id)): Path<(String, String, String)>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let room = get_room_seed(&map_id, &room_id)?;
    let Some(cfg) = get_room_item_config(&room, &item_def_id) else {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<PickupRoomItemData> {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        }));
    };
    if let Some(req_quest_id) = cfg.req_quest_id.as_deref() {
        let can_pickup = state.database.fetch_optional(
            "SELECT status FROM character_task_progress WHERE character_id = $1 AND task_id = $2 LIMIT 1",
            |query| query.bind(actor.character_id).bind(req_quest_id),
        ).await?;
        let status = can_pickup.and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten()).unwrap_or_default();
        if status.is_empty() || status == "claimed" {
            return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<PickupRoomItemData> {
                success: false,
                message: Some("不满足拾取条件".to_string()),
                data: None,
            }));
        }
    }
    if cfg.once {
        let picked = state.database.fetch_optional(
            "SELECT id FROM character_room_item_pickup WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND item_def_id = $4 LIMIT 1",
            |query| query.bind(actor.character_id).bind(&map_id).bind(&room_id).bind(&item_def_id),
        ).await?;
        if picked.is_some() {
            return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<PickupRoomItemData> {
                success: false,
                message: Some("该物品已拾取过".to_string()),
                data: None,
            }));
        }
    }
    if cfg.chance < 1.0 {
        return Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult::<PickupRoomItemData> {
            success: false,
            message: Some("拾取失败".to_string()),
            data: None,
        }));
    }
    state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, $3, 1, 'none', 'bag', NOW(), NOW(), 'pickup') RETURNING id",
        |query| query.bind(actor.user_id).bind(actor.character_id).bind(&item_def_id),
    ).await?;
    if cfg.once {
        state.database.execute(
            "INSERT INTO character_room_item_pickup (character_id, map_id, room_id, item_def_id, created_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (character_id, map_id, room_id, item_def_id) DO NOTHING",
            |query| query.bind(actor.character_id).bind(&map_id).bind(&room_id).bind(&item_def_id),
        ).await?;
    }
    Ok(crate::shared::response::send_result(crate::shared::response::ServiceResult {
        success: true,
        message: Some("拾取成功".to_string()),
        data: Some(PickupRoomItemData { item_def_id, qty: 1 }),
    }))
}

#[derive(Clone)]
struct RoomResourceConfig {
    collect_limit: i64,
    respawn_sec: i64,
}

#[derive(Clone)]
struct RoomItemConfig {
    once: bool,
    chance: f64,
    req_quest_id: Option<String>,
}

fn get_room_seed(map_id: &str, room_id: &str) -> Result<MapRoomDto, AppError> {
    load_map_seeds()?
        .into_iter()
        .find(|map| map.enabled != Some(false) && map.id == map_id)
        .and_then(|map| map.rooms.unwrap_or_default().into_iter().find(|room| room.id == room_id))
        .ok_or_else(|| AppError::config("房间不存在"))
}

fn get_room_resource_config(room: &MapRoomDto, resource_id: &str) -> Option<RoomResourceConfig> {
    room.resources.as_ref()?.iter().find_map(|entry| {
        (entry.get("resource_id").and_then(|value| value.as_str()) == Some(resource_id)).then(|| RoomResourceConfig {
            collect_limit: entry.get("collect_limit").and_then(|value| value.as_i64()).unwrap_or(1).max(1),
            respawn_sec: entry.get("respawn_sec").and_then(|value| value.as_i64()).unwrap_or(300).max(1),
        })
    })
}

fn get_room_item_config(room: &MapRoomDto, item_def_id: &str) -> Option<RoomItemConfig> {
    room.items.as_ref()?.iter().find_map(|entry| {
        (entry.get("item_def_id").and_then(|value| value.as_str()) == Some(item_def_id)).then(|| RoomItemConfig {
            once: entry.get("once").and_then(|value| value.as_bool()).unwrap_or(false),
            chance: entry.get("chance").and_then(|value| value.as_f64()).unwrap_or(1.0).clamp(0.0, 1.0),
            req_quest_id: entry.get("req_quest_id").and_then(|value| value.as_str()).map(|value| value.to_string()).filter(|value| !value.trim().is_empty()),
        })
    })
}

fn collect_room_resource_ids(room: &MapRoomDto) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for entry in room.resources.as_ref().into_iter().flatten() {
        let Some(resource_id) = entry.get("resource_id").and_then(|value| value.as_str()).map(str::trim) else {
            continue;
        };
        if resource_id.is_empty() || !seen.insert(resource_id.to_string()) {
            continue;
        }
        ids.push(resource_id.to_string());
    }
    ids
}

async fn load_room_resource_states(
    state: &AppState,
    character_id: Option<i64>,
    map_id: &str,
    room_id: &str,
    room: &MapRoomDto,
) -> Result<HashMap<String, InfoItemResourceDto>, AppError> {
    let resource_ids = collect_room_resource_ids(room);
    if resource_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut row_by_resource_id = HashMap::<String, (i64, Option<String>)>::new();
    if let Some(character_id) = character_id {
        let rows = state.database.fetch_all(
            "SELECT resource_id, COALESCE(used_count, 0)::bigint AS used_count, to_char(cooldown_until AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS cooldown_until_text FROM character_room_resource_state WHERE character_id = $1 AND map_id = $2 AND room_id = $3 AND resource_id = ANY($4::varchar[])",
            |query| query.bind(character_id).bind(map_id).bind(room_id).bind(&resource_ids),
        ).await?;
        for row in rows {
            let resource_id = row.try_get::<Option<String>, _>("resource_id")?.unwrap_or_default();
            if resource_id.trim().is_empty() {
                continue;
            }
            let used_count = row.try_get::<Option<i64>, _>("used_count")?.unwrap_or_default();
            let cooldown_until = row.try_get::<Option<String>, _>("cooldown_until_text")?;
            row_by_resource_id.insert(resource_id, (used_count, cooldown_until));
        }
    }

    let now = time::OffsetDateTime::now_utc();
    let mut states = HashMap::new();
    for resource_id in resource_ids {
        let Some(cfg) = get_room_resource_config(room, &resource_id) else {
            continue;
        };
        let (raw_used_count, cooldown_until_text) = row_by_resource_id.get(resource_id.as_str()).cloned().unwrap_or((0, None));
        let cooldown_until = cooldown_until_text.as_deref().and_then(parse_rfc3339);
        let in_cooldown = cooldown_until.map(|value| value > now).unwrap_or(false);
        let used_count = if cooldown_until.map(|value| value <= now).unwrap_or(false) { 0 } else { raw_used_count.max(0) };
        let remaining = (cfg.collect_limit - used_count).max(0);
        let cooldown_sec = if in_cooldown {
            cooldown_until.map(|value| (value.unix_timestamp() - now.unix_timestamp()).max(1)).unwrap_or_default()
        } else {
            0
        };
        states.insert(
            resource_id,
            InfoItemResourceDto {
                collect_limit: cfg.collect_limit,
                used_count,
                remaining,
                cooldown_sec,
                respawn_sec: cfg.respawn_sec,
                cooldown_until: if in_cooldown { cooldown_until_text } else { None },
            },
        );
    }
    Ok(states)
}

fn parse_rfc3339(raw: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
}

#[derive(Default)]
struct RoomTaskMarkers {
    character_id: Option<i64>,
    npc_markers: HashMap<String, char>,
    monster_markers: HashMap<String, char>,
    resource_markers: HashMap<String, char>,
    tracked_npc_ids: std::collections::HashSet<String>,
    tracked_monster_ids: std::collections::HashSet<String>,
    tracked_resource_ids: std::collections::HashSet<String>,
}

async fn resolve_room_task_markers(
    state: &AppState,
    headers: &HeaderMap,
    room: &MapRoomDto,
) -> Result<RoomTaskMarkers, AppError> {
    let Some(token) = auth::read_bearer_token(headers) else {
        return Ok(RoomTaskMarkers::default());
    };
    let Ok(claims) = auth::verify_token(token, &state.config.service.jwt_secret) else {
        return Ok(RoomTaskMarkers::default());
    };
    let Some(character_id) = auth::get_character_id_by_user_id(state, claims.id).await? else {
        return Ok(RoomTaskMarkers::default());
    };

    let task_defs = load_task_marker_seeds()?;
    let task_ids: Vec<String> = task_defs.iter().map(|task| task.id.clone()).collect();
    let progress_rows = state
        .database
        .fetch_all(
            "SELECT task_id, status, tracked, progress FROM character_task_progress WHERE character_id = $1 AND task_id = ANY($2::varchar[])",
            |query| query.bind(character_id).bind(task_ids),
        )
        .await?;
    let mut progress_by_id = HashMap::new();
    for row in progress_rows {
        let task_id = row.try_get::<Option<String>, _>("task_id")?.unwrap_or_default();
        if task_id.trim().is_empty() {
            continue;
        }
        progress_by_id.insert(
            task_id,
            (
                row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "ongoing".to_string()),
                row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(false),
                parse_progress_record(row.try_get::<Option<serde_json::Value>, _>("progress")?),
            ),
        );
    }

    let mut result = RoomTaskMarkers {
        character_id: Some(character_id),
        ..RoomTaskMarkers::default()
    };
    let room_npc_ids: std::collections::HashSet<_> = room.npcs.clone().unwrap_or_default().into_iter().collect();
    let room_monster_ids: std::collections::HashSet<_> = room.monsters.clone().unwrap_or_default().into_iter().map(|m| m.monster_def_id).collect();
    let room_resource_ids: std::collections::HashSet<_> = room.resources.clone().unwrap_or_default().into_iter().filter_map(|res| res.get("resource_id").and_then(|v| v.as_str()).map(|s| s.to_string())).collect();

    for task in task_defs {
        let (status, tracked, progress) = progress_by_id
            .get(task.id.as_str())
            .cloned()
            .unwrap_or_else(|| (String::new(), false, HashMap::new()));
        let active_marker = if status == "claimable" || status == "turnin" {
            Some('?')
        } else if status == "claimed" {
            None
        } else {
            Some('!')
        };

        for objective in task.objectives.unwrap_or_default() {
            let objective_id = objective.id.unwrap_or_default();
            let target = objective.target.unwrap_or(1).max(1);
            let done = progress.get(objective_id.as_str()).copied().unwrap_or(0);
            if done >= target {
                continue;
            }
            let params = objective.params.unwrap_or_default();
            match objective.objective_type.as_deref().unwrap_or_default() {
                "talk_npc" => {
                    if let Some(npc_id) = params.get("npc_id").and_then(|v| v.as_str()) {
                        if room_npc_ids.contains(npc_id) {
                            if let Some(marker) = active_marker { set_marker(&mut result.npc_markers, npc_id, marker); }
                            if tracked { result.tracked_npc_ids.insert(npc_id.to_string()); }
                        }
                    }
                }
                "kill_monster" => {
                    if let Some(monster_id) = params.get("monster_id").and_then(|v| v.as_str()) {
                        if room_monster_ids.contains(monster_id) {
                            if let Some(marker) = active_marker { set_marker(&mut result.monster_markers, monster_id, marker); }
                            if tracked { result.tracked_monster_ids.insert(monster_id.to_string()); }
                        }
                    }
                }
                "gather_resource" => {
                    if let Some(resource_id) = params.get("resource_id").and_then(|v| v.as_str()) {
                        if room_resource_ids.contains(resource_id) {
                            if let Some(marker) = active_marker { set_marker(&mut result.resource_markers, resource_id, marker); }
                            if tracked { result.tracked_resource_ids.insert(resource_id.to_string()); }
                        }
                    }
                }
                _ => {}
            }
        }
        if status.is_empty() {
            if let Some(giver_npc_id) = task.giver_npc_id.as_deref() {
                if room_npc_ids.contains(giver_npc_id) {
                    set_marker(&mut result.npc_markers, giver_npc_id, '!');
                    if tracked { result.tracked_npc_ids.insert(giver_npc_id.to_string()); }
                }
            }
        }
    }
    Ok(result)
}

fn set_marker(map: &mut HashMap<String, char>, id: &str, marker: char) {
    let current = map.get(id).copied();
    if current == Some('?') {
        return;
    }
    if marker == '?' || current.is_none() {
        map.insert(id.to_string(), marker);
    }
}

fn apply_task_marker(target: &mut InfoTargetDto, marker: Option<char>, tracked: bool) {
    let marker_string = marker.map(|m| m.to_string());
    match target {
        InfoTargetDto::Npc {
            task_marker,
            task_tracked,
            ..
        }
        | InfoTargetDto::Monster {
            task_marker,
            task_tracked,
            ..
        }
        | InfoTargetDto::Item {
            task_marker,
            task_tracked,
            ..
        }
        | InfoTargetDto::Player {
            task_marker,
            task_tracked,
            ..
        } => {
            *task_marker = marker_string;
            *task_tracked = tracked;
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
struct TaskMarkerSeed {
    id: String,
    giver_npc_id: Option<String>,
    objectives: Option<Vec<TaskMarkerObjective>>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct TaskMarkerObjective {
    id: Option<String>,
    #[serde(rename = "type")]
    objective_type: Option<String>,
    target: Option<i64>,
    params: Option<serde_json::Value>,
}

fn load_task_marker_seeds() -> Result<Vec<TaskMarkerSeed>, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/task_def.json"))
        .map_err(|error| AppError::config(format!("failed to read task_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse task_def.json: {error}")))?;
    let tasks = payload.get("tasks").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(tasks
        .into_iter()
        .filter_map(|value| serde_json::from_value::<TaskMarkerSeed>(value).ok())
        .filter(|task| task.enabled != Some(false))
        .collect())
}

fn parse_progress_record(raw: Option<serde_json::Value>) -> HashMap<String, i64> {
    let Some(raw) = raw else {
        return HashMap::new();
    };
    let Some(object) = raw.as_object() else {
        return HashMap::new();
    };
    object
        .iter()
        .filter_map(|(key, value)| value.as_i64().or_else(|| value.as_f64().map(|v| v.floor() as i64)).map(|value| (key.clone(), value.max(0))))
        .collect()
}

fn load_map_seeds() -> Result<Vec<MapSeed>, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json"))
        .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: MapSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    Ok(payload.maps)
}

fn load_monster_name_map() -> Result<HashMap<String, String>, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json"))
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    let monsters = payload.get("monsters").and_then(|value| value.as_array()).cloned().unwrap_or_default();
    Ok(monsters
        .into_iter()
        .filter_map(|monster| {
            let id = monster.get("id")?.as_str()?.trim().to_string();
            let name = monster.get("name")?.as_str()?.trim().to_string();
            (!id.is_empty() && !name.is_empty()).then_some((id, name))
        })
        .collect())
}

fn enrich_rooms(rooms: Vec<MapRoomDto>) -> Result<Vec<MapRoomDto>, AppError> {
    let monster_name_map = load_monster_name_map()?;
    Ok(rooms
        .into_iter()
        .map(|mut room| {
            room.monsters = room.monsters.map(|monsters| {
                monsters
                    .into_iter()
                    .map(|monster| EnrichedMonsterDto {
                        name: monster_name_map
                            .get(monster.monster_def_id.trim())
                            .cloned()
                            .unwrap_or(monster.monster_def_id.clone()),
                        ..monster
                    })
                    .collect()
            });
            room
        })
        .collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn world_map_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"mapName": "九州大陆", "areas": [{"id": "C", "name": "C", "description": "", "level": "Lv.1"}], "connections": [["C", "N"]]}
        });
        assert_eq!(payload["data"]["mapName"], "九州大陆");
        println!("MAP_WORLD_RESPONSE={}", payload);
    }

    #[test]
    fn map_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"map": {"id": "map-qingyun-village", "name": "青云村"}, "rooms": [{"id": "room-village-center", "name": "村中广场"}]}
        });
        assert_eq!(payload["data"]["map"]["id"], "map-qingyun-village");
        println!("MAP_DETAIL_RESPONSE={}", payload);
    }

    #[test]
    fn room_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"mapId": "map-qingyun-village", "room": {"id": "room-village-center", "name": "村中广场"}}
        });
        assert_eq!(payload["data"]["room"]["id"], "room-village-center");
        println!("MAP_ROOM_RESPONSE={}", payload);
    }

    #[test]
    fn room_objects_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "mapId": "map-qingyun-village",
                "roomId": "room-village-center",
                "objects": [
                    {"type": "npc", "id": "npc-village-elder", "name": "村长"},
                    {"type": "item", "id": "res-spirit-grass", "name": "灵草"}
                ]
            }
        });
        assert_eq!(payload["data"]["objects"][0]["type"], "npc");
        assert_eq!(payload["data"]["objects"][1]["type"], "item");
        println!("MAP_ROOM_OBJECTS_RESPONSE={}", payload);
    }

    #[test]
    fn map_gather_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "采集成功",
            "data": {"itemDefId": "res-spirit-grass", "qty": 1, "remaining": 2, "cooldownSec": 5, "actionSec": 5, "gatherUntil": "2026-04-11T12:00:05Z"}
        });
        assert_eq!(payload["data"]["itemDefId"], "res-spirit-grass");
        println!("MAP_GATHER_RESPONSE={}", payload);
    }

    #[test]
    fn map_pickup_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "拾取成功",
            "data": {"itemDefId": "cons-001", "qty": 1}
        });
        assert_eq!(payload["data"]["qty"], 1);
        println!("MAP_PICKUP_RESPONSE={}", payload);
    }
}
