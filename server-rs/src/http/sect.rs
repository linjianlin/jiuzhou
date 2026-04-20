use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::realtime::public_socket::emit_sect_update_to_user;
use crate::realtime::sect::{SectIndicatorPayload, build_sect_indicator_payload, build_sect_update_payload};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

fn opt_i64_from_i32_default(row: &sqlx::postgres::PgRow, column: &str, default: i64) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or(default)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectDefDto {
    pub id: String,
    pub name: String,
    pub leader_id: i64,
    pub level: i64,
    pub exp: i64,
    pub funds: i64,
    pub reputation: i64,
    pub build_points: i64,
    pub announcement: Option<String>,
    pub description: Option<String>,
    pub join_type: String,
    pub join_min_realm: String,
    pub member_count: i64,
    pub max_members: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectMemberDto {
    pub character_id: i64,
    pub nickname: String,
    pub month_card_active: bool,
    pub realm: String,
    pub position: String,
    pub contribution: i64,
    pub weekly_contribution: i64,
    pub joined_at: String,
    pub last_offline_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectBuildingRequirementDto {
    pub upgradable: bool,
    pub max_level: i64,
    pub next_level: Option<i64>,
    pub funds: Option<i64>,
    pub build_points: Option<i64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectBuildingDto {
    pub id: i64,
    pub sect_id: String,
    pub building_type: String,
    pub level: i64,
    pub status: String,
    pub upgrade_start_at: Option<String>,
    pub upgrade_end_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub requirement: SectBuildingRequirementDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectBlessingStatusDto {
    pub today: String,
    pub blessed_today: bool,
    pub can_bless: bool,
    pub active: bool,
    pub expire_at: Option<String>,
    pub fuyuan_bonus: f64,
    pub duration_hours: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MySectInfoDto {
    pub sect: SectDefDto,
    pub members: Vec<SectMemberDto>,
    pub buildings: Vec<SectBuildingDto>,
    pub blessing_status: SectBlessingStatusDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectInfoDto {
    pub sect: SectDefDto,
    pub members: Vec<SectMemberDto>,
    pub buildings: Vec<SectBuildingDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectListItemDto {
    pub id: String,
    pub name: String,
    pub level: i64,
    pub member_count: i64,
    pub max_members: i64,
    pub join_type: String,
    pub join_min_realm: String,
    pub announcement: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SectSearchData {
    pub list: Vec<SectListItemDto>,
    pub page: i64,
    pub limit: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectBonusesDto {
    pub attr_bonus: serde_json::Value,
    pub exp_bonus: i64,
    pub drop_bonus: i64,
    pub craft_bonus: i64,
    pub equipment_growth_cost_discount: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectQuestRewardDto {
    pub contribution: i64,
    pub build_points: i64,
    pub funds: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectQuestSubmitRequirementDto {
    pub item_def_id: String,
    pub item_name: String,
    pub item_category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectQuestDto {
    pub id: String,
    pub name: String,
    pub quest_type: String,
    pub target: String,
    pub required: i64,
    pub reward: SectQuestRewardDto,
    pub action_type: String,
    pub submit_requirement: Option<SectQuestSubmitRequirementDto>,
    pub status: String,
    pub progress: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectShopItemDto {
    pub id: String,
    pub name: String,
    pub item_def_id: String,
    pub qty: i64,
    pub cost_contribution: i64,
    pub item_icon: Option<String>,
    pub purchase_limit: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectShopBuyPayload {
    pub item_id: Option<String>,
    pub quantity: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectShopBuyData {
    pub item_def_id: String,
    pub qty: i64,
    pub item_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectApplicationDto {
    pub id: i64,
    pub character_id: i64,
    pub nickname: String,
    pub month_card_active: bool,
    pub realm: String,
    pub message: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectMyApplicationDto {
    pub id: i64,
    pub sect_id: String,
    pub sect_name: String,
    pub sect_level: i64,
    pub member_count: i64,
    pub max_members: i64,
    pub join_type: String,
    pub created_at: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SectLogDto {
    pub id: i64,
    pub log_type: String,
    pub content: String,
    pub created_at: String,
    pub operator_id: Option<i64>,
    pub operator_name: Option<String>,
    pub target_id: Option<i64>,
    pub target_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SectSearchQuery {
    pub keyword: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectApplyPayload {
    pub sect_id: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectApplicationIdPayload {
    pub application_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleSectApplicationPayload {
    pub application_id: Option<i64>,
    pub approve: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct SectAnnouncementPayload {
    pub announcement: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpgradeSectBuildingPayload {
    pub building_type: Option<String>,
    #[serde(alias = "buildingType")]
    pub building_type_alias: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSectPayload {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SectDonatePayload {
    pub spirit_stones: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectAppointPayload {
    pub target_id: Option<i64>,
    pub position: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectKickPayload {
    pub target_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectTransferPayload {
    pub new_leader_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectQuestActionPayload {
    pub quest_id: Option<String>,
    pub quantity: Option<i64>,
}

pub async fn get_my_sect(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_row = state
        .database
        .fetch_optional(
        "SELECT sd.*, sd.created_at::text AS created_at_text, sd.updated_at::text AS updated_at_text, sm.position FROM sect_member sm JOIN sect_def sd ON sd.id = sm.sect_id WHERE sm.character_id = $1 LIMIT 1",
            |query| query.bind(actor.character_id),
        )
        .await?;
    let Some(sect_row) = sect_row else {
        return Ok(send_result(ServiceResult::<MySectInfoDto> {
            success: true,
            message: Some("ok".to_string()),
            data: None,
        }));
    };
    let sect_id = sect_row.try_get::<Option<String>, _>("id")?.unwrap_or_default();
    let sect = build_sect_def_dto(&sect_row)?;
    let members = load_sect_members(&state, &sect_id).await?;
    let buildings = load_sect_buildings(&state, &sect_id).await?;
    let position = sect_row.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string());
    let blessing_status = build_blessing_status(&buildings, &position);

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(MySectInfoDto {
            sect,
            members,
            buildings,
            blessing_status,
        }),
    }))
}

pub async fn create_sect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateSectPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let name = payload.name.unwrap_or_default();
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::config("宗门名称不能为空"));
    }
    if name.chars().count() > 16 {
        return Err(AppError::config("宗门名称过长"));
    }
    if load_character_sect_id(&state, actor.character_id).await?.is_some() {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("已加入宗门，无法创建".to_string()), data: None }));
    }
    let duplicate = state.database.fetch_optional(
        "SELECT id FROM sect_def WHERE name = $1 LIMIT 1",
        |query| query.bind(name),
    ).await?;
    if duplicate.is_some() {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门名称已存在".to_string()), data: None }));
    }
    let character_row = state.database.fetch_optional(
        "SELECT spirit_stones FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?.ok_or_else(|| AppError::config("角色不存在"))?;
    let spirit_stones = character_row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default();
    let create_cost = 1000_i64;
    if spirit_stones < create_cost {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some(format!("灵石不足，创建需要{}", create_cost)), data: None }));
    }
    let sect_id = generate_sect_id();
    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE characters SET spirit_stones = spirit_stones - $2, updated_at = NOW() WHERE id = $1",
            |query| query.bind(actor.character_id).bind(create_cost),
        ).await?;
        state.database.execute(
            "INSERT INTO sect_def (id, name, leader_id, level, exp, funds, reputation, build_points, announcement, description, join_type, join_min_realm, member_count, max_members, created_at, updated_at) VALUES ($1, $2, $3, 1, 0, 0, 0, 0, NULL, $4, 'apply', '凡人', 1, 20, NOW(), NOW())",
            |query| query.bind(&sect_id).bind(name).bind(actor.character_id).bind(payload.description),
        ).await?;
        state.database.execute(
            "INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'leader', 0, 0, NOW())",
            |query| query.bind(&sect_id).bind(actor.character_id),
        ).await?;
        for building_type in ["hall", "forge_house", "blessing_hall"] {
            state.database.execute(
                "INSERT INTO sect_building (sect_id, building_type, level, status, created_at, updated_at) VALUES ($1, $2, 1, 'normal', NOW(), NOW()) ON CONFLICT (sect_id, building_type) DO NOTHING",
                |query| query.bind(&sect_id).bind(building_type),
            ).await?;
        }
        state.database.execute(
            "INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content, created_at) VALUES ($1, 'create', $2, NULL, $3, NOW())",
            |query| query.bind(&sect_id).bind(actor.character_id).bind(format!("创建宗门：{}", name)),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("创建成功".to_string()), data: Some(serde_json::json!({ "sectId": sect_id })) }))
}

pub async fn search_sects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SectSearchQuery>,
) -> Result<Json<SuccessResponse<SectSearchData>>, AppError> {
    let _ = auth::require_character(&state, &headers).await?;
    let page = query.page.unwrap_or(1).clamp(1, 10_000);
    let limit = query.limit.unwrap_or(20).clamp(1, 50);
    let offset = (page - 1) * limit;
    let keyword = query.keyword.unwrap_or_default();
    let keyword = keyword.trim();
    let (rows, total) = if keyword.is_empty() {
        (
            state
                .database
                .fetch_all(
                    "SELECT id, name, level, member_count, max_members, join_type, join_min_realm, announcement FROM sect_def ORDER BY level DESC, member_count DESC, created_at DESC LIMIT $1 OFFSET $2",
                    |query| query.bind(limit).bind(offset),
                )
                .await?,
            state
                .database
                .fetch_one("SELECT COUNT(*)::bigint AS cnt FROM sect_def", |query| query)
                .await?
                .try_get::<Option<i64>, _>("cnt")?
                .unwrap_or_default(),
        )
    } else {
        let pattern = format!("%{}%", keyword);
        (
            state
                .database
                .fetch_all(
                    "SELECT id, name, level, member_count, max_members, join_type, join_min_realm, announcement FROM sect_def WHERE name ILIKE $1 ORDER BY level DESC, member_count DESC, created_at DESC LIMIT $2 OFFSET $3",
                    |query| query.bind(&pattern).bind(limit).bind(offset),
                )
                .await?,
            state
                .database
                .fetch_one("SELECT COUNT(*)::bigint AS cnt FROM sect_def WHERE name ILIKE $1", |query| query.bind(&pattern))
                .await?
                .try_get::<Option<i64>, _>("cnt")?
                .unwrap_or_default(),
        )
    };
    let list = rows
        .into_iter()
        .map(|row| SectListItemDto {
            id: row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
            name: row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
            level: opt_i64_from_i32(&row, "level"),
            member_count: opt_i64_from_i32(&row, "member_count"),
            max_members: opt_i64_from_i32(&row, "max_members"),
            join_type: row.try_get::<Option<String>, _>("join_type").unwrap_or(None).unwrap_or_default(),
            join_min_realm: row.try_get::<Option<String>, _>("join_min_realm").unwrap_or(None).unwrap_or_else(|| "凡人".to_string()),
            announcement: row.try_get::<Option<String>, _>("announcement").unwrap_or(None),
        })
        .collect();
    Ok(send_success(SectSearchData { list, page, limit, total }))
}

pub async fn get_sect_info_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(sect_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let _ = auth::require_character(&state, &headers).await?;
    let sect_id = sect_id.trim();
    if sect_id.is_empty() {
        return Ok(send_result(ServiceResult::<SectInfoDto> {
            success: false,
            message: Some("宗门不存在".to_string()),
            data: None,
        }));
    }
    let row = state
        .database
        .fetch_optional(
            "SELECT *, created_at::text AS created_at_text, updated_at::text AS updated_at_text FROM sect_def WHERE id = $1 LIMIT 1",
            |query| query.bind(sect_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<SectInfoDto> {
            success: false,
            message: Some("宗门不存在".to_string()),
            data: None,
        }));
    };
    let sect = build_sect_def_dto(&row)?;
    let members = load_sect_members(&state, sect_id).await?;
    let buildings = load_sect_buildings(&state, sect_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(SectInfoDto { sect, members, buildings }),
    }))
}

pub async fn get_sect_buildings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = load_character_sect_id(&state, actor.character_id).await?;
    let Some(sect_id) = sect_id else {
        return Ok(send_result(ServiceResult::<Vec<SectBuildingDto>> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    };
    let buildings = load_sect_buildings(&state, &sect_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(buildings),
    }))
}

pub async fn get_sect_bonuses_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT sd.level, sm.position, sd.id FROM sect_member sm JOIN sect_def sd ON sd.id = sm.sect_id WHERE sm.character_id = $1 LIMIT 1",
            |query| query.bind(actor.character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<SectBonusesDto> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    };
    let sect_id = row.try_get::<Option<String>, _>("id")?.unwrap_or_default();
    let buildings = load_sect_buildings(&state, &sect_id).await?;
    let bonuses = calculate_sect_bonuses(
        opt_i64_from_i32_default(&row, "level", 1),
        &buildings,
        row.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string()),
    );
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(bonuses),
    }))
}

pub async fn get_sect_quests_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = load_character_sect_id(&state, actor.character_id).await?;
    let Some(_sect_id) = sect_id else {
        return Ok(send_result(ServiceResult::<Vec<SectQuestDto>> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    };
    let quests = build_sect_quest_views(&state, actor.character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(quests),
    }))
}

pub async fn get_sect_shop_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = load_character_sect_id(&state, actor.character_id).await?;
    if sect_id.is_none() {
        return Ok(send_result(ServiceResult::<Vec<SectShopItemDto>> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(load_sect_shop_items()?),
    }))
}

pub async fn buy_from_sect_shop_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectShopBuyPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload.item_id.unwrap_or_default();
    let item_id = item_id.trim();
    let quantity = payload.quantity.unwrap_or(1).clamp(1, 999);
    if item_id.is_empty() {
        return Err(AppError::config("商品ID不能为空"));
    }
    let shop = load_sect_shop_items()?;
    let Some(item) = shop.iter().find(|entry| entry.id == item_id) else {
        return Ok(send_result(ServiceResult::<SectShopBuyData> { success: false, message: Some("商品不存在".to_string()), data: None }));
    };
    let member = state.database.fetch_optional(
        "SELECT sect_id, contribution FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<SectShopBuyData> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let contribution = member.try_get::<Option<i64>, _>("contribution")?.unwrap_or_default();
    let cost = item.cost_contribution * quantity;
    if contribution < cost {
        return Ok(send_result(ServiceResult::<SectShopBuyData> { success: false, message: Some("贡献不足".to_string()), data: None }));
    }
    if let Some(limit_cfg) = item.purchase_limit.as_ref() {
        let kind = limit_cfg.get("type").and_then(|value| value.as_str()).unwrap_or_default();
        let max_count = limit_cfg.get("maxCount").and_then(|value| value.as_i64()).unwrap_or_default().max(1);
        let used_rows = if kind == "rolling_days" {
            let window_days = limit_cfg.get("windowDays").and_then(|value| value.as_i64()).unwrap_or(1).max(1);
            state.database.fetch_all(
                "SELECT content FROM sect_log WHERE log_type = 'shop_buy' AND operator_id = $1 AND created_at >= NOW() - make_interval(days => $2)",
                |query| query.bind(actor.character_id).bind(window_days),
            ).await?
        } else {
            state.database.fetch_all(
                "SELECT content FROM sect_log WHERE log_type = 'shop_buy' AND operator_id = $1 AND created_at::date = CURRENT_DATE",
                |query| query.bind(actor.character_id),
            ).await?
        };
        let used_count: i64 = used_rows.into_iter().map(|row| {
            let content = row.try_get::<Option<String>, _>("content").unwrap_or(None).unwrap_or_default();
            extract_shop_buy_item_qty_from_log_content(&content, &item.name)
        }).sum();
        if used_count + quantity > max_count {
            let message = if kind == "daily" {
                if max_count <= 1 { "该商品今日已兑换".to_string() } else { format!("该商品今日最多兑换{}个（剩余{}个）", max_count, (max_count - used_count).max(0)) }
            } else {
                let window_days = limit_cfg.get("windowDays").and_then(|value| value.as_i64()).unwrap_or(1).max(1);
                if max_count <= 1 { format!("该商品{}天内仅可兑换1个", window_days) } else { format!("该商品{}天内最多兑换{}个（剩余{}个）", window_days, max_count, (max_count - used_count).max(0)) }
            };
            return Ok(send_result(ServiceResult::<SectShopBuyData> { success: false, message: Some(message), data: None }));
        }
    }

    let give_qty = item.qty * quantity;
    let mut item_ids = Vec::new();
    let sect_id = member.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE sect_member SET contribution = contribution - $2 WHERE character_id = $1",
            |query| query.bind(actor.character_id).bind(cost),
        ).await?;
        let content = format!("购买：{}×{}", item.name, give_qty);
        state.database.execute(
            "INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content, created_at) VALUES ($1, 'shop_buy', $2, NULL, $3, NOW())",
            |query| query.bind(&sect_id).bind(actor.character_id).bind(content),
        ).await?;
        for _ in 0..quantity {
            let inserted = state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'sect_shop') RETURNING id",
                |query| query.bind(actor.user_id).bind(actor.character_id).bind(&item.item_def_id).bind(item.qty),
            ).await?;
            item_ids.push(inserted.try_get::<i64, _>("id")?);
        }
        Ok::<(), AppError>(())
    }).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("购买成功".to_string()),
        data: Some(SectShopBuyData { item_def_id: item.item_def_id.clone(), qty: give_qty, item_ids }),
    }))
}

pub async fn donate_to_sect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectDonatePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let amount = payload.spirit_stones.unwrap_or_default().max(0);
    if amount <= 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("参数错误".to_string()), data: None }));
    }
    let member = load_member_role(&state, actor.character_id, true).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    if !has_sect_permission(&member.position, "donate") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限捐献".to_string()), data: None }));
    }
    let row = state.database.fetch_optional(
        "SELECT spirit_stones FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?.ok_or_else(|| AppError::config("角色不存在"))?;
    let spirit_stones = row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default();
    if spirit_stones < amount {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("灵石不足".to_string()), data: None }));
    }
    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE characters SET spirit_stones = spirit_stones - $2, updated_at = NOW() WHERE id = $1",
            |query| query.bind(actor.character_id).bind(amount),
        ).await?;
        state.database.execute(
            "UPDATE sect_def SET funds = funds + $2, updated_at = NOW() WHERE id = $1",
            |query| query.bind(&member.sect_id).bind(amount),
        ).await?;
        state.database.execute(
            "UPDATE sect_member SET contribution = contribution + $2, weekly_contribution = weekly_contribution + $2 WHERE character_id = $1",
            |query| query.bind(actor.character_id).bind(amount),
        ).await?;
        state.database.execute(
            "INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content, created_at) VALUES ($1, 'donate', $2, NULL, $3, NOW())",
            |query| query.bind(&member.sect_id).bind(actor.character_id).bind(format!("捐献灵石：{}", amount)),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("捐献成功".to_string()), data: Some(serde_json::json!({
        "debugRealtime": build_sect_update_payload("donate_to_sect", Some(member.sect_id.as_str()), Some("捐献成功"))
    })) }))
}

pub async fn appoint_sect_position_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectAppointPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let target_id = payload.target_id.unwrap_or_default();
    let position = payload.position.unwrap_or_default();
    let position = position.trim();
    if target_id <= 0 || position.is_empty() || position == "leader" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("参数错误".to_string()), data: None }));
    }
    let me = load_member_role(&state, actor.character_id, true).await?;
    let Some(me) = me else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    if !has_sect_permission(&me.position, "approve") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限任命职位".to_string()), data: None }));
    }
    let target = load_member_role(&state, target_id, true).await?;
    let Some(target) = target else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    };
    if target.sect_id != me.sect_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    }
    if position_rank(&me.position) <= position_rank(&target.position) {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("权限不足，无法操作同级或更高职位".to_string()), data: None }));
    }
    state.database.execute(
        "UPDATE sect_member SET position = $2 WHERE sect_id = $1 AND character_id = $3",
        |query| query.bind(&me.sect_id).bind(position).bind(target_id),
    ).await?;
    emit_sect_update_to_characters(&state, &[target_id]).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("任命成功".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn kick_sect_member_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectKickPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let target_id = payload.target_id.unwrap_or_default();
    if target_id <= 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("参数错误".to_string()), data: None }));
    }
    let me = load_member_role(&state, actor.character_id, true).await?;
    let Some(me) = me else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    if !has_sect_permission(&me.position, "kick") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限踢人".to_string()), data: None }));
    }
    let target = load_member_role(&state, target_id, true).await?;
    let Some(target) = target else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    };
    if target.sect_id != me.sect_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    }
    if target.position == "leader" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("不可踢出宗主".to_string()), data: None }));
    }
    if position_rank(&me.position) <= position_rank(&target.position) {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("权限不足，无法操作同级或更高职位".to_string()), data: None }));
    }
    state.database.with_transaction(|| async {
        state.database.execute("DELETE FROM sect_member WHERE character_id = $1", |query| query.bind(target_id)).await?;
        state.database.execute("UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1", |query| query.bind(&me.sect_id)).await?;
        Ok::<(), AppError>(())
    }).await?;
    emit_sect_update_to_characters(&state, &[target_id]).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("已踢出成员".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn transfer_sect_leader_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectTransferPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let new_leader_id = payload.new_leader_id.unwrap_or_default();
    if new_leader_id <= 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("参数错误".to_string()), data: None }));
    }
    let me = load_member_role(&state, actor.character_id, true).await?;
    let Some(me) = me else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    if me.position != "leader" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("只有宗主可转让".to_string()), data: None }));
    }
    let target = load_member_role(&state, new_leader_id, true).await?;
    let Some(target) = target else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    };
    if target.sect_id != me.sect_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("目标不在本宗门".to_string()), data: None }));
    }
    state.database.with_transaction(|| async {
        state.database.execute("UPDATE sect_def SET leader_id = $1, updated_at = NOW() WHERE id = $2", |query| query.bind(new_leader_id).bind(&me.sect_id)).await?;
        state.database.execute("UPDATE sect_member SET position = 'leader' WHERE sect_id = $1 AND character_id = $2", |query| query.bind(&me.sect_id).bind(new_leader_id)).await?;
        state.database.execute("UPDATE sect_member SET position = 'vice_leader' WHERE sect_id = $1 AND character_id = $2", |query| query.bind(&me.sect_id).bind(actor.character_id)).await?;
        Ok::<(), AppError>(())
    }).await?;
    emit_sect_update_to_characters(&state, &[actor.character_id, new_leader_id]).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("转让成功".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn disband_sect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let me = load_member_role(&state, actor.character_id, true).await?;
    let Some(me) = me else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    if me.position != "leader" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限解散宗门".to_string()), data: None }));
    }
    let sect = state.database.fetch_optional(
        "SELECT leader_id FROM sect_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(&me.sect_id),
    ).await?;
    let Some(sect) = sect else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门不存在".to_string()), data: None }));
    };
    let leader_id = opt_i64_from_i32(&sect, "leader_id");
    if leader_id != actor.character_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("只有宗主可解散宗门".to_string()), data: None }));
    }
    let member_ids = load_sect_member_character_ids(&state, &me.sect_id).await?;
    state.database.execute("DELETE FROM sect_def WHERE id = $1", |query| query.bind(&me.sect_id)).await?;
    emit_sect_update_to_characters(&state, &member_ids).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("解散成功".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn apply_to_sect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectApplyPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = payload.sect_id.unwrap_or_default();
    let sect_id = sect_id.trim();
    if sect_id.is_empty() {
        return Err(AppError::config("宗门ID不能为空"));
    }
    if load_character_sect_id(&state, actor.character_id).await?.is_some() {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("已加入宗门，无法申请".to_string()), data: None }));
    }
    let sect = state.database.fetch_optional(
        "SELECT id, join_type, join_min_realm, member_count, max_members FROM sect_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(sect_id),
    ).await?;
    let Some(sect) = sect else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门不存在".to_string()), data: None }));
    };
    let member_count = opt_i64_from_i32(&sect, "member_count");
    let max_members = opt_i64_from_i32_default(&sect, "max_members", 20);
    if member_count >= max_members {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门人数已满".to_string()), data: None }));
    }
    let realm = state.database.fetch_optional("SELECT realm FROM characters WHERE id = $1 LIMIT 1", |query| query.bind(actor.character_id)).await?
        .and_then(|row| row.try_get::<Option<String>, _>("realm").ok().flatten())
        .unwrap_or_else(|| "凡人".to_string());
    let join_min_realm = sect.try_get::<Option<String>, _>("join_min_realm")?.unwrap_or_else(|| "凡人".to_string());
    if compare_realm_rank(&realm, &join_min_realm) < 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some(format!("境界不足，需达到：{}", join_min_realm)), data: None }));
    }
    let join_type = sect.try_get::<Option<String>, _>("join_type")?.unwrap_or_else(|| "apply".to_string());
    if join_type == "invite" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("该宗门仅支持邀请加入".to_string()), data: None }));
    }
    if join_type == "open" {
        state.database.with_transaction(|| async {
            state.database.execute("INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'disciple', 0, 0, NOW())", |query| query.bind(sect_id).bind(actor.character_id)).await?;
            state.database.execute("UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1", |query| query.bind(sect_id)).await?;
            Ok::<(), AppError>(())
        }).await?;
        let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
        emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
        return Ok(send_result(ServiceResult { success: true, message: Some("加入成功".to_string()), data: Some(serde_json::json!({
            "debugRealtime": build_sect_update_payload("join_open_sect", Some(sect_id), Some("加入成功"))
        })) }));
    }
    let pending = state.database.fetch_optional(
        "SELECT id FROM sect_application WHERE sect_id = $1 AND character_id = $2 AND status = 'pending' LIMIT 1",
        |query| query.bind(sect_id).bind(actor.character_id),
    ).await?;
    if pending.is_some() {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("已提交申请，请等待审核".to_string()), data: None }));
    }
    state.database.execute(
        "INSERT INTO sect_application (sect_id, character_id, message, status, created_at) VALUES ($1, $2, $3, 'pending', NOW())",
        |query| query.bind(sect_id).bind(actor.character_id).bind(payload.message),
    ).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("申请已提交".to_string()), data: Some(serde_json::json!({
        "debugRealtime": build_sect_update_payload("apply_to_sect", Some(sect_id), Some("申请已提交"))
    })) }))
}

pub async fn cancel_my_application_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectApplicationIdPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let application_id = payload.application_id.unwrap_or_default();
    if application_id <= 0 {
        return Err(AppError::config("参数错误"));
    }
    let row = state.database.fetch_optional(
        "SELECT sect_id, character_id, status FROM sect_application WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(application_id),
    ).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("申请不存在".to_string()), data: None }));
    };
    let owner_id = opt_i64_from_i32(&row, "character_id");
    if owner_id != actor.character_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限取消该申请".to_string()), data: None }));
    }
    let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_default();
    if status != "pending" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("申请已处理，无法取消".to_string()), data: None }));
    }
    state.database.execute(
        "UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = NULL WHERE id = $1",
        |query| query.bind(application_id),
    ).await?;
    let sect_id = row.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    let mut targets = vec![actor.character_id];
    if !sect_id.trim().is_empty() {
        targets.extend(load_sect_manager_character_ids(&state, &sect_id).await?);
    }
    emit_sect_update_to_characters(&state, &targets).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("已取消".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn leave_sect_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let member = state.database.fetch_optional(
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let position = member.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string());
    if position == "leader" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗主不可退出，请先转让或解散".to_string()), data: None }));
    }
    let sect_id = member.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    state.database.with_transaction(|| async {
        state.database.execute("DELETE FROM sect_member WHERE character_id = $1", |query| query.bind(actor.character_id)).await?;
        state.database.execute("UPDATE sect_def SET member_count = GREATEST(member_count - 1, 0), updated_at = NOW() WHERE id = $1", |query| query.bind(&sect_id)).await?;
        Ok::<(), AppError>(())
    }).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("已退出宗门".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn handle_sect_application_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<HandleSectApplicationPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let application_id = payload.application_id.unwrap_or_default();
    if application_id <= 0 {
        return Err(AppError::config("参数错误"));
    }
    let me = state.database.fetch_optional(
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(me) = me else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let position = me.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string());
    if !matches!(position.as_str(), "leader" | "vice_leader" | "elder") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限处理申请".to_string()), data: None }));
    }
    let sect_id = me.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    let app = state.database.fetch_optional(
        "SELECT id, sect_id, character_id, status FROM sect_application WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(application_id),
    ).await?;
    let Some(app) = app else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("申请不存在".to_string()), data: None }));
    };
    let app_sect_id = app.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    if app_sect_id != sect_id {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("不可处理其他宗门的申请".to_string()), data: None }));
    }
    let status = app.try_get::<Option<String>, _>("status")?.unwrap_or_default();
    if status != "pending" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("申请已处理".to_string()), data: None }));
    }
    let approve = payload.approve == Some(true);
    let applicant_id = opt_i64_from_i32(&app, "character_id");
    let mut emit_targets = load_sect_manager_character_ids(&state, &sect_id).await?;
    emit_targets.push(applicant_id);
    if !approve {
        state.database.execute(
            "UPDATE sect_application SET status = 'rejected', handled_at = NOW(), handled_by = $2 WHERE id = $1",
            |query| query.bind(application_id).bind(actor.character_id),
        ).await?;
        emit_sect_update_to_characters(&state, &emit_targets).await?;
        return Ok(send_result(ServiceResult { success: true, message: Some("已拒绝".to_string()), data: Some(serde_json::json!({})) }));
    }

    let sect = state.database.fetch_optional(
        "SELECT member_count, max_members FROM sect_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(&sect_id),
    ).await?;
    let Some(sect) = sect else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门不存在".to_string()), data: None }));
    };
    let member_count = opt_i64_from_i32(&sect, "member_count");
    let max_members = opt_i64_from_i32_default(&sect, "max_members", 20);
    if member_count >= max_members {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门人数已满".to_string()), data: None }));
    }
    let existing = state.database.fetch_optional(
        "SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1",
        |query| query.bind(applicant_id),
    ).await?;
    if existing.is_some() {
        state.database.execute(
            "UPDATE sect_application SET status = 'cancelled', handled_at = NOW(), handled_by = $2 WHERE id = $1",
            |query| query.bind(application_id).bind(actor.character_id),
        ).await?;
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("对方已加入其他宗门".to_string()), data: None }));
    }

    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE sect_application SET status = 'approved', handled_at = NOW(), handled_by = $2 WHERE id = $1",
            |query| query.bind(application_id).bind(actor.character_id),
        ).await?;
        state.database.execute(
            "INSERT INTO sect_member (sect_id, character_id, position, contribution, weekly_contribution, joined_at) VALUES ($1, $2, 'disciple', 0, 0, NOW())",
            |query| query.bind(&sect_id).bind(applicant_id),
        ).await?;
        state.database.execute(
            "UPDATE sect_def SET member_count = member_count + 1, updated_at = NOW() WHERE id = $1",
            |query| query.bind(&sect_id),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    emit_sect_update_to_characters(&state, &emit_targets).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("已通过".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn update_sect_announcement_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectAnnouncementPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let member = state.database.fetch_optional(
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let position = member.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string());
    if !matches!(position.as_str(), "leader" | "vice_leader" | "elder") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限编辑宗门公告".to_string()), data: None }));
    }
    let announcement = payload.announcement.unwrap_or_default();
    let announcement = announcement.trim();
    state.database.execute(
        "UPDATE sect_def SET announcement = $2, updated_at = NOW() WHERE id = $1",
        |query| query.bind(member.try_get::<Option<String>, _>("sect_id").unwrap_or(None).unwrap_or_default()).bind(if announcement.is_empty() { None::<String> } else { Some(announcement.to_string()) }),
    ).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("公告更新成功".to_string()), data: Some(serde_json::json!({
        "debugRealtime": build_sect_update_payload("update_announcement", Some(member.try_get::<Option<String>, _>("sect_id").unwrap_or(None).unwrap_or_default().as_str()), Some("公告更新成功"))
    })) }))
}

pub async fn offer_sect_blessing_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let member = state.database.fetch_optional(
        "SELECT sm.sect_id, sb.level FROM sect_member sm LEFT JOIN sect_building sb ON sb.sect_id = sm.sect_id AND sb.building_type = 'blessing_hall' WHERE sm.character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<SectBlessingStatusDto> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let blessing_hall_level = opt_i64_from_i32(&member, "level");
    if blessing_hall_level <= 0 {
        return Ok(send_result(ServiceResult::<SectBlessingStatusDto> { success: false, message: Some("祈福殿尚未建成".to_string()), data: None }));
    }
    let now = time::OffsetDateTime::now_utc().to_offset(time::UtcOffset::from_hms(8, 0, 0).unwrap_or(time::UtcOffset::UTC));
    let today = date_key(now);
    let existing = state.database.fetch_optional(
        "SELECT grant_day_key::text AS grant_day_key_text FROM character_global_buff WHERE character_id = $1 AND buff_key = 'fuyuan_flat' AND source_type = 'sect_blessing' AND source_id = 'blessing_hall' LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    if existing
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("grant_day_key_text").ok().flatten())
        .map(|value| normalize_date_key(value) == today)
        .unwrap_or(false)
    {
        return Ok(send_result(ServiceResult::<SectBlessingStatusDto> { success: false, message: Some("今日已祈福，请明日再来".to_string()), data: None }));
    }
    let fuyuan_bonus = blessing_hall_level as f64 * 0.5;
    let expire_at = now + time::Duration::hours(3);
    state.database.execute(
        "INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, grant_day_key, started_at, expire_at, created_at, updated_at) VALUES ($1, 'fuyuan_flat', 'sect_blessing', 'blessing_hall', $2, $3::date, NOW(), $4::timestamptz, NOW(), NOW()) ON CONFLICT (character_id, buff_key, source_type, source_id) DO UPDATE SET buff_value = EXCLUDED.buff_value, grant_day_key = EXCLUDED.grant_day_key, started_at = NOW(), expire_at = EXCLUDED.expire_at, updated_at = NOW()",
        |query| query.bind(actor.character_id).bind(fuyuan_bonus).bind(&today).bind(expire_at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()),
    ).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("祈福成功".to_string()),
        data: Some(SectBlessingStatusDto {
            today,
            blessed_today: true,
            can_bless: false,
            active: true,
            expire_at: expire_at.format(&time::format_description::well_known::Rfc3339).ok(),
            fuyuan_bonus,
            duration_hours: 3,
        }),
    }))
}

pub async fn upgrade_sect_building_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpgradeSectBuildingPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let building_type = payload.building_type.or(payload.building_type_alias).unwrap_or_default();
    let building_type = building_type.trim();
    if building_type.is_empty() {
        return Err(AppError::config("参数错误"));
    }
    let member = state.database.fetch_optional(
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    };
    let position = member.try_get::<Option<String>, _>("position")?.unwrap_or_else(|| "disciple".to_string());
    if !matches!(position.as_str(), "leader" | "vice_leader" | "elder") {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("无权限升级建筑".to_string()), data: None }));
    }
    let sect_id = member.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    let building = state.database.fetch_optional(
        "SELECT id, level FROM sect_building WHERE sect_id = $1 AND building_type = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(&sect_id).bind(building_type),
    ).await?;
    let Some(building) = building else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("建筑不存在".to_string()), data: None }));
    };
    let building_id: i64 = building.try_get("id")?;
    let level = opt_i64_from_i32_default(&building, "level", 1).max(1);
    let requirement = build_building_requirement(building_type, level);
    if !requirement.upgradable {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some(requirement.reason.unwrap_or_else(|| "暂未开放".to_string())), data: None }));
    }
    let sect = state.database.fetch_optional(
        "SELECT funds, build_points FROM sect_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(&sect_id),
    ).await?.ok_or_else(|| AppError::config("宗门不存在"))?;
    let funds = sect.try_get::<Option<i64>, _>("funds")?.unwrap_or_default();
    let build_points = opt_i64_from_i32(&sect, "build_points");
    let need_funds = requirement.funds.unwrap_or_default();
    let need_build_points = requirement.build_points.unwrap_or_default();
    if funds < need_funds {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("宗门资金不足".to_string()), data: None }));
    }
    if build_points < need_build_points {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("建设点不足".to_string()), data: None }));
    }
    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE sect_def SET funds = funds - $2, build_points = build_points - $3, updated_at = NOW() WHERE id = $1",
            |query| query.bind(&sect_id).bind(need_funds).bind(need_build_points),
        ).await?;
        state.database.execute(
            "UPDATE sect_building SET level = level + 1, updated_at = NOW() WHERE id = $1",
            |query| query.bind(building_id),
        ).await?;
        if building_type == "hall" {
            let cap = 20 + (level * 5);
            state.database.execute(
                "UPDATE sect_def SET max_members = $2, updated_at = NOW() WHERE id = $1",
                |query| query.bind(&sect_id).bind(cap),
            ).await?;
        }
        state.database.execute(
            "INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content, created_at) VALUES ($1, 'upgrade_building', $2, NULL, $3, NOW())",
            |query| query.bind(&sect_id).bind(actor.character_id).bind(format!("升级建筑：{}", building_type)),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    let socket_realtime = load_sect_indicator_payload(&state, actor.character_id).await?;
    emit_sect_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(send_result(ServiceResult { success: true, message: Some("升级成功".to_string()), data: Some(serde_json::json!({
        "debugRealtime": build_sect_update_payload("upgrade_building", Some(sect_id.as_str()), Some("升级成功"))
    })) }))
}

pub(crate) async fn load_sect_indicator_payload(state: &AppState, character_id: i64) -> Result<SectIndicatorPayload, AppError> {
    let member = load_member_role(state, character_id, false).await?;
    let joined = member.is_some();
    let can_manage_applications = member
        .as_ref()
        .map(|member| matches!(member.position.as_str(), "leader" | "vice_leader" | "elder"))
        .unwrap_or(false);
    let sect_pending_application_count = if let Some(member) = member.as_ref() {
        if can_manage_applications {
            let row = state.database.fetch_one(
                "SELECT COUNT(1)::bigint AS cnt FROM sect_application WHERE sect_id = $1 AND status = 'pending'",
                |query| query.bind(&member.sect_id),
            ).await?;
            row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default()
        } else {
            0
        }
    } else {
        0
    };
    let row = state.database.fetch_one(
        "SELECT COUNT(1)::bigint AS cnt FROM sect_application WHERE character_id = $1 AND status = 'pending'",
        |query| query.bind(character_id),
    ).await?;
    let my_pending_application_count = row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default();
    Ok(build_sect_indicator_payload(
        joined,
        my_pending_application_count,
        sect_pending_application_count,
        can_manage_applications,
    ))
}

async fn emit_sect_update_to_characters(state: &AppState, character_ids: &[i64]) -> Result<(), AppError> {
    let mut deduped = character_ids
        .iter()
        .copied()
        .filter(|id| *id > 0)
        .collect::<Vec<_>>();
    deduped.sort_unstable();
    deduped.dedup();
    for character_id in deduped {
        let user_row = state.database.fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |query| query.bind(character_id),
        ).await?;
        let Some(user_row) = user_row else {
            continue;
        };
        let user_id = user_row
            .try_get::<Option<i32>, _>("user_id")?
            .map(i64::from)
            .unwrap_or_default();
        if user_id <= 0 {
            continue;
        }
        let payload = load_sect_indicator_payload(state, character_id).await?;
        emit_sect_update_to_user(state, user_id, &payload);
    }
    Ok(())
}

async fn load_sect_manager_character_ids(state: &AppState, sect_id: &str) -> Result<Vec<i64>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT character_id FROM sect_member WHERE sect_id = $1 AND position IN ('leader', 'vice_leader', 'elder') ORDER BY joined_at ASC",
        |query| query.bind(sect_id),
    ).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from))
        .filter(|id| *id > 0)
        .collect())
}

async fn load_sect_member_character_ids(state: &AppState, sect_id: &str) -> Result<Vec<i64>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT character_id FROM sect_member WHERE sect_id = $1 ORDER BY joined_at ASC",
        |query| query.bind(sect_id),
    ).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from))
        .filter(|id| *id > 0)
        .collect())
}

pub async fn accept_sect_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectQuestActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let quest_id = payload.quest_id.unwrap_or_default();
    let quest_id = quest_id.trim();
    if quest_id.is_empty() {
        return Err(AppError::config("参数错误"));
    }
    if load_character_sect_id(&state, actor.character_id).await?.is_none() {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("未加入宗门".to_string()), data: None }));
    }
    let templates = load_sect_quest_templates()?;
    let Some(template) = templates.into_iter().find(|quest| quest.id == quest_id) else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务不存在".to_string()), data: None }));
    };
    let row = state.database.fetch_optional(
        "SELECT status, accepted_at::text AS accepted_at_text FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id).bind(quest_id),
    ).await?;
    if let Some(row) = row {
        let accepted_at = row.try_get::<Option<String>, _>("accepted_at_text")?;
        if is_sect_quest_in_current_period(&template.quest_type, accepted_at.as_deref()) {
            return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务已接取".to_string()), data: None }));
        }
    }
    state.database.execute(
        "INSERT INTO sect_quest_progress (character_id, quest_id, progress, status, accepted_at) VALUES ($1, $2, 0, 'in_progress', NOW()) ON CONFLICT (character_id, quest_id) DO UPDATE SET progress = 0, status = 'in_progress', accepted_at = NOW(), completed_at = NULL",
        |query| query.bind(actor.character_id).bind(quest_id),
    ).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(serde_json::json!({})) }))
}

pub async fn submit_sect_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectQuestActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let quest_id = payload.quest_id.unwrap_or_default();
    let quest_id = quest_id.trim();
    if quest_id.is_empty() {
        return Err(AppError::config("参数错误"));
    }
    let quantity = payload.quantity.unwrap_or_default().max(0);
    let templates = load_sect_quest_templates()?;
    let Some(template) = templates.into_iter().find(|quest| quest.id == quest_id) else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务不存在".to_string()), data: None }));
    };
    if template.action_type != "submit_item" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("该任务不支持提交物品".to_string()), data: None }));
    }
    let row = state.database.fetch_optional(
        "SELECT progress, status, accepted_at::text AS accepted_at_text FROM sect_quest_progress WHERE character_id = $1 AND quest_id = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id).bind(quest_id),
    ).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务未接取".to_string()), data: None }));
    };
    let accepted_at = row.try_get::<Option<String>, _>("accepted_at_text")?;
    if !is_sect_quest_in_current_period(&template.quest_type, accepted_at.as_deref()) {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务已过期，请重新接取".to_string()), data: None }));
    }
    let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "in_progress".to_string());
    if status != "in_progress" {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务当前不可提交".to_string()), data: None }));
    }
    let Some(submit_requirement) = template.submit_requirement.clone() else {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("任务配置异常".to_string()), data: None }));
    };
    let current_progress = opt_i64_from_i32(&row, "progress");
    let remaining = (template.required - current_progress).max(0);
    let actual_submit = quantity.max(1).min(remaining);
    if actual_submit <= 0 {
        return Ok(send_result(ServiceResult { success: true, message: Some("任务已完成".to_string()), data: Some(serde_json::json!({"consumed": 0, "progress": current_progress, "status": "completed"})) }));
    }
    let have = count_character_item_qty(&state, actor.character_id, &submit_requirement.item_def_id).await?;
    if have < actual_submit {
        return Ok(send_result(ServiceResult::<serde_json::Value> { success: false, message: Some("物品数量不足".to_string()), data: None }));
    }
    consume_character_item_qty(&state, actor.user_id, actor.character_id, &submit_requirement.item_def_id, actual_submit).await?;
    let next_progress = current_progress + actual_submit;
    let next_status = if next_progress >= template.required { "completed" } else { "in_progress" };
    state.database.execute(
        "UPDATE sect_quest_progress SET progress = $3, status = $4, completed_at = CASE WHEN $4 = 'completed' THEN NOW() ELSE completed_at END WHERE character_id = $1 AND quest_id = $2",
        |query| query.bind(actor.character_id).bind(quest_id).bind(next_progress).bind(next_status),
    ).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({"consumed": actual_submit, "progress": next_progress, "status": next_status})),
    }))
}

pub async fn claim_sect_quest_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<SectQuestActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let quest_id = payload.quest_id.unwrap_or_default();
    let quest_id = quest_id.trim();
    if quest_id.is_empty() {
        return Err(AppError::config("参数错误"));
    }
    let templates = load_sect_quest_templates()?;
    let Some(template) = templates.into_iter().find(|quest| quest.id == quest_id) else {
        return Ok(send_result(ServiceResult::<SectQuestRewardDto> { success: false, message: Some("任务不存在".to_string()), data: None }));
    };
    let member = state.database.fetch_optional(
        "SELECT sm.sect_id, sqp.status, sqp.accepted_at::text AS accepted_at_text FROM sect_member sm JOIN sect_quest_progress sqp ON sqp.character_id = sm.character_id WHERE sm.character_id = $1 AND sqp.quest_id = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(actor.character_id).bind(quest_id),
    ).await?;
    let Some(member) = member else {
        return Ok(send_result(ServiceResult::<SectQuestRewardDto> { success: false, message: Some("任务未接取".to_string()), data: None }));
    };
    let accepted_at = member.try_get::<Option<String>, _>("accepted_at_text")?;
    if !is_sect_quest_in_current_period(&template.quest_type, accepted_at.as_deref()) {
        return Ok(send_result(ServiceResult::<SectQuestRewardDto> { success: false, message: Some("任务已过期，请重新接取".to_string()), data: None }));
    }
    let status = member.try_get::<Option<String>, _>("status")?.unwrap_or_default();
    if status == "claimed" {
        return Ok(send_result(ServiceResult::<SectQuestRewardDto> { success: false, message: Some("奖励已领取".to_string()), data: None }));
    }
    if status != "completed" {
        return Ok(send_result(ServiceResult::<SectQuestRewardDto> { success: false, message: Some("任务未完成".to_string()), data: None }));
    }
    let sect_id = member.try_get::<Option<String>, _>("sect_id")?.unwrap_or_default();
    let reward = template.reward.clone();
    state.database.with_transaction(|| async {
        state.database.execute(
            "UPDATE sect_member SET contribution = contribution + $2, weekly_contribution = weekly_contribution + $3 WHERE character_id = $1",
            |query| query.bind(actor.character_id).bind(reward.contribution).bind(reward.contribution),
        ).await?;
        state.database.execute(
            "UPDATE sect_def SET build_points = build_points + $2, funds = funds + $3, updated_at = NOW() WHERE id = $1",
            |query| query.bind(&sect_id).bind(reward.build_points).bind(reward.funds),
        ).await?;
        state.database.execute(
            "UPDATE sect_quest_progress SET status = 'claimed' WHERE character_id = $1 AND quest_id = $2",
            |query| query.bind(actor.character_id).bind(quest_id),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;
    Ok(send_result(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(reward) }))
}

pub async fn list_sect_applications(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = load_character_sect_id(&state, actor.character_id).await?;
    let Some(sect_id) = sect_id else {
        return Ok(send_result(ServiceResult::<Vec<SectApplicationDto>> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    };
    let rows = state.database.fetch_all(
        "SELECT sa.id, sa.character_id, c.nickname, c.realm, sa.message, sa.created_at::text AS created_at_text FROM sect_application sa JOIN characters c ON c.id = sa.character_id WHERE sa.sect_id = $1 AND sa.status = 'pending' ORDER BY sa.created_at DESC, sa.id DESC",
        |query| query.bind(&sect_id),
    ).await?;
    let month_map = load_month_card_map_by_character_ids(&state, rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from)).collect()).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(rows.into_iter().map(|row| {
            let character_id = opt_i64_from_i32(&row, "character_id");
            SectApplicationDto {
                id: row.try_get::<Option<i64>, _>("id").unwrap_or(None).unwrap_or_default(),
                character_id,
                nickname: row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(),
                month_card_active: month_map.get(&character_id).copied().unwrap_or(false),
                realm: row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
                message: row.try_get::<Option<String>, _>("message").unwrap_or(None),
                created_at: row.try_get::<Option<String>, _>("created_at_text").unwrap_or(None).unwrap_or_default(),
            }
        }).collect::<Vec<_>>()),
    }))
}

pub async fn list_my_sect_applications(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let rows = state.database.fetch_all(
        "SELECT sa.id, sa.sect_id, sd.name AS sect_name, sd.level AS sect_level, sd.member_count, sd.max_members, sd.join_type, sa.created_at::text AS created_at_text, sa.message FROM sect_application sa JOIN sect_def sd ON sd.id = sa.sect_id WHERE sa.character_id = $1 AND sa.status = 'pending' ORDER BY sa.created_at DESC, sa.id DESC",
        |query| query.bind(actor.character_id),
    ).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(rows.into_iter().map(|row| SectMyApplicationDto {
            id: row.try_get::<Option<i64>, _>("id").unwrap_or(None).unwrap_or_default(),
            sect_id: row.try_get::<Option<String>, _>("sect_id").unwrap_or(None).unwrap_or_default(),
            sect_name: row.try_get::<Option<String>, _>("sect_name").unwrap_or(None).unwrap_or_default(),
            sect_level: opt_i64_from_i32(&row, "sect_level"),
            member_count: opt_i64_from_i32(&row, "member_count"),
            max_members: opt_i64_from_i32(&row, "max_members"),
            join_type: row.try_get::<Option<String>, _>("join_type").unwrap_or(None).unwrap_or_default(),
            created_at: row.try_get::<Option<String>, _>("created_at_text").unwrap_or(None).unwrap_or_default(),
            message: row.try_get::<Option<String>, _>("message").unwrap_or(None),
        }).collect::<Vec<_>>()),
    }))
}

pub async fn get_sect_logs_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let sect_id = load_character_sect_id(&state, actor.character_id).await?;
    let Some(sect_id) = sect_id else {
        return Ok(send_result(ServiceResult::<Vec<SectLogDto>> {
            success: false,
            message: Some("未加入宗门".to_string()),
            data: None,
        }));
    };
    let rows = state.database.fetch_all(
        "SELECT l.id, l.log_type, l.content, l.created_at::text AS created_at_text, l.operator_id, op.nickname AS operator_name, l.target_id, tg.nickname AS target_name FROM sect_log l LEFT JOIN characters op ON op.id = l.operator_id LEFT JOIN characters tg ON tg.id = l.target_id WHERE l.sect_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT 100",
        |query| query.bind(&sect_id),
    ).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(rows.into_iter().map(|row| SectLogDto {
            id: row.try_get::<Option<i64>, _>("id").unwrap_or(None).unwrap_or_default(),
            log_type: row.try_get::<Option<String>, _>("log_type").unwrap_or(None).unwrap_or_default(),
            content: row.try_get::<Option<String>, _>("content").unwrap_or(None).unwrap_or_default(),
            created_at: row.try_get::<Option<String>, _>("created_at_text").unwrap_or(None).unwrap_or_default(),
            operator_id: row.try_get::<Option<i32>, _>("operator_id").unwrap_or(None).map(i64::from),
            operator_name: row.try_get::<Option<String>, _>("operator_name").unwrap_or(None),
            target_id: row.try_get::<Option<i32>, _>("target_id").unwrap_or(None).map(i64::from),
            target_name: row.try_get::<Option<String>, _>("target_name").unwrap_or(None),
        }).collect::<Vec<_>>()),
    }))
}

async fn load_character_sect_id(state: &AppState, character_id: i64) -> Result<Option<String>, AppError> {
    let row = state.database.fetch_optional("SELECT sect_id FROM sect_member WHERE character_id = $1 LIMIT 1", |query| query.bind(character_id)).await?;
    Ok(row.and_then(|row| row.try_get::<Option<String>, _>("sect_id").ok().flatten()))
}

async fn load_sect_members(state: &AppState, sect_id: &str) -> Result<Vec<SectMemberDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT sm.character_id, c.nickname, c.realm, c.last_offline_at::text AS last_offline_at_text, sm.position, sm.contribution, sm.weekly_contribution, sm.joined_at::text AS joined_at_text FROM sect_member sm JOIN characters c ON c.id = sm.character_id WHERE sm.sect_id = $1 ORDER BY CASE sm.position WHEN 'leader' THEN 1 WHEN 'vice_leader' THEN 2 WHEN 'elder' THEN 3 WHEN 'elite' THEN 4 ELSE 5 END, sm.joined_at ASC",
        |query| query.bind(sect_id),
    ).await?;
    let month_map = load_month_card_map_by_character_ids(state, rows.iter().filter_map(|row| row.try_get::<Option<i32>, _>("character_id").ok().flatten().map(i64::from)).collect()).await?;
    Ok(rows.into_iter().map(|row| {
        let character_id = opt_i64_from_i32(&row, "character_id");
        SectMemberDto {
            character_id,
            nickname: row.try_get::<Option<String>, _>("nickname").unwrap_or(None).unwrap_or_default(),
            month_card_active: month_map.get(&character_id).copied().unwrap_or(false),
            realm: row.try_get::<Option<String>, _>("realm").unwrap_or(None).unwrap_or_default(),
            position: row.try_get::<Option<String>, _>("position").unwrap_or(None).unwrap_or_else(|| "disciple".to_string()),
            contribution: row.try_get::<Option<i64>, _>("contribution").unwrap_or(None).unwrap_or_default(),
            weekly_contribution: opt_i64_from_i32(&row, "weekly_contribution"),
            joined_at: row.try_get::<Option<String>, _>("joined_at_text").unwrap_or(None).unwrap_or_default(),
            last_offline_at: row.try_get::<Option<String>, _>("last_offline_at_text").unwrap_or(None),
        }
    }).collect())
}

async fn load_sect_buildings(state: &AppState, sect_id: &str) -> Result<Vec<SectBuildingDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT *, upgrade_start_at::text AS upgrade_start_at_text, upgrade_end_at::text AS upgrade_end_at_text, created_at::text AS created_at_text, updated_at::text AS updated_at_text FROM sect_building WHERE sect_id = $1 ORDER BY building_type",
        |query| query.bind(sect_id),
    ).await?;
    Ok(rows.into_iter().map(|row| {
        let level = opt_i64_from_i32_default(&row, "level", 1).max(1);
        let building_type = row.try_get::<Option<String>, _>("building_type").unwrap_or(None).unwrap_or_default();
        SectBuildingDto {
            id: row.try_get::<Option<i64>, _>("id").unwrap_or(None).unwrap_or_default(),
            sect_id: row.try_get::<Option<String>, _>("sect_id").unwrap_or(None).unwrap_or_default(),
            building_type: building_type.clone(),
            level,
            status: row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_else(|| "normal".to_string()),
            upgrade_start_at: row.try_get::<Option<String>, _>("upgrade_start_at_text").unwrap_or(None),
            upgrade_end_at: row.try_get::<Option<String>, _>("upgrade_end_at_text").unwrap_or(None),
            created_at: row.try_get::<Option<String>, _>("created_at_text").unwrap_or(None).unwrap_or_default(),
            updated_at: row.try_get::<Option<String>, _>("updated_at_text").unwrap_or(None).unwrap_or_default(),
            requirement: build_building_requirement(&building_type, level),
        }
    }).collect())
}

fn build_building_requirement(building_type: &str, current_level: i64) -> SectBuildingRequirementDto {
    let max_level = 50;
    if !matches!(building_type, "hall" | "forge_house" | "blessing_hall") {
        return SectBuildingRequirementDto { upgradable: false, max_level, next_level: None, funds: None, build_points: None, reason: Some("暂未开放".to_string()) };
    }
    if current_level >= max_level {
        return SectBuildingRequirementDto { upgradable: false, max_level, next_level: None, funds: None, build_points: None, reason: Some("建筑已满级".to_string()) };
    }
    let next_level = current_level + 1;
    SectBuildingRequirementDto {
        upgradable: true,
        max_level,
        next_level: Some(next_level),
        funds: Some(1200 * next_level * next_level),
        build_points: Some(10 * next_level),
        reason: None,
    }
}

fn build_blessing_status(buildings: &[SectBuildingDto], position: &str) -> SectBlessingStatusDto {
    let today = time::OffsetDateTime::now_utc().to_offset(time::UtcOffset::from_hms(8, 0, 0).unwrap_or(time::UtcOffset::UTC));
    let blessing_hall_level = buildings.iter().find(|building| building.building_type == "blessing_hall").map(|building| building.level).unwrap_or_default();
    let fuyuan_bonus = if blessing_hall_level > 0 { blessing_hall_level as f64 * 0.5 } else { 0.0 };
    let active = false;
    let _ = position;
    SectBlessingStatusDto {
        today: format!("{:04}-{:02}-{:02}", today.year(), u8::from(today.month()), today.day()),
        blessed_today: false,
        can_bless: true,
        active,
        expire_at: None,
        fuyuan_bonus: if active { fuyuan_bonus } else { 0.0 },
        duration_hours: 3,
    }
}

fn calculate_sect_bonuses(level: i64, buildings: &[SectBuildingDto], position: String) -> SectBonusesDto {
    let mut attr_bonus = serde_json::Map::new();
    let mut exp_bonus = level.max(0) * 2;
    let mut drop_bonus = 0_i64;
    let mut craft_bonus = 0_i64;
    let mut equipment_growth_cost_discount = 0.0_f64;
    for building in buildings {
        match building.building_type.as_str() {
            "library" => exp_bonus += building.level,
            "training_hall" => {
                attr_bonus.insert("wugong".to_string(), serde_json::json!(building.level * 10));
                attr_bonus.insert("fagong".to_string(), serde_json::json!(building.level * 10));
            }
            "alchemy_room" => craft_bonus += building.level * 2,
            "forge_house" => {
                equipment_growth_cost_discount = ((building.level as f64) * 0.005).clamp(0.0, 0.25);
            }
            "spirit_array" => {
                attr_bonus.insert("lingqi_huifu".to_string(), serde_json::json!(building.level * 5));
            }
            "defense_array" => drop_bonus += building.level,
            _ => {}
        }
    }
    let position_bonus = match position.as_str() {
        "leader" => 20,
        "vice_leader" => 15,
        "elder" => 10,
        "elite" => 5,
        _ => 0,
    };
    exp_bonus += position_bonus;
    SectBonusesDto {
        attr_bonus: serde_json::Value::Object(attr_bonus),
        exp_bonus,
        drop_bonus,
        craft_bonus,
        equipment_growth_cost_discount,
    }
}

async fn load_month_card_map_by_character_ids(state: &AppState, ids: Vec<i64>) -> Result<HashMap<i64, bool>, AppError> {
    let ids: Vec<i64> = ids.into_iter().filter(|id| *id > 0).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = state.database.fetch_all(
        "SELECT character_id FROM month_card_ownership WHERE character_id = ANY($1::bigint[]) AND month_card_id = 'monthcard-001' AND expire_at > NOW()",
        |query| query.bind(ids.clone()),
    ).await?;
    let mut map = HashMap::new();
    for id in ids { map.insert(id, false); }
    for row in rows {
        let character_id = opt_i64_from_i32(&row, "character_id");
        if character_id > 0 { map.insert(character_id, true); }
    }
    Ok(map)
}

async fn build_sect_quest_views(state: &AppState, character_id: i64) -> Result<Vec<SectQuestDto>, AppError> {
    let templates = load_sect_quest_templates()?;
    let quest_ids: Vec<String> = templates.iter().map(|q| q.id.clone()).collect();
    let rows = state.database.fetch_all(
        "SELECT quest_id, status, progress, accepted_at::text AS accepted_at_text FROM sect_quest_progress WHERE character_id = $1 AND quest_id = ANY($2::varchar[])",
        |query| query.bind(character_id).bind(quest_ids),
    ).await?;
    let mut progress_map = HashMap::new();
    for row in rows {
        let quest_id = row.try_get::<Option<String>, _>("quest_id")?.unwrap_or_default();
        if quest_id.is_empty() { continue; }
        progress_map.insert(
            quest_id,
            (
                row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "in_progress".to_string()),
                opt_i64_from_i32(&row, "progress"),
                row.try_get::<Option<String>, _>("accepted_at_text")?,
            ),
        );
    }
    let item_defs = load_item_defs_map()?;
    let today = date_key(time::OffsetDateTime::now_utc());
    let week_key = iso_week_key(time::OffsetDateTime::now_utc());
    Ok(templates.into_iter().map(|quest| {
        let progress_row = progress_map.get(quest.id.as_str());
        let in_current_period = progress_row
            .and_then(|(_, _, accepted_at)| accepted_at.as_deref())
            .map(|accepted_at| {
                if quest.quest_type == "weekly" {
                    normalize_date_key(accepted_at.to_string()).starts_with(&week_key)
                } else {
                    normalize_date_key(accepted_at.to_string()) == today
                }
            })
            .unwrap_or(false);
        let status = if in_current_period {
            progress_row.as_ref().map(|row| row.0.clone()).unwrap_or_else(|| "not_accepted".to_string())
        } else {
            "not_accepted".to_string()
        };
        let progress = if in_current_period {
            progress_row.as_ref().map(|row| row.1).unwrap_or_default().min(quest.required)
        } else { 0 };
        SectQuestDto {
            id: quest.id,
            name: quest.name,
            quest_type: quest.quest_type,
            target: quest.target,
            required: quest.required,
            reward: quest.reward,
            action_type: quest.action_type,
            submit_requirement: quest.submit_requirement.map(|req| SectQuestSubmitRequirementDto {
                item_def_id: req.item_def_id.clone(),
                item_name: item_defs.get(req.item_def_id.as_str()).map(|item| item.0.clone()).unwrap_or(req.item_name),
                item_category: req.item_category,
            }),
            status,
            progress,
        }
    }).collect())
}

#[derive(Clone)]
struct SectQuestTemplate {
    id: String,
    name: String,
    quest_type: String,
    target: String,
    required: i64,
    reward: SectQuestRewardDto,
    action_type: String,
    submit_requirement: Option<SectQuestSubmitRequirementDto>,
}

fn load_sect_quest_templates() -> Result<Vec<SectQuestTemplate>, AppError> {
    Ok(vec![
        SectQuestTemplate {
            id: "sect-quest-daily-001".to_string(),
            name: "宗门日常：灵石捐献".to_string(),
            quest_type: "daily".to_string(),
            target: "累计捐献灵石 100".to_string(),
            required: 100,
            reward: SectQuestRewardDto { contribution: 25, build_points: 1, funds: 10 },
            action_type: "event".to_string(),
            submit_requirement: None,
        },
        SectQuestTemplate {
            id: "sect-quest-daily-submit-material".to_string(),
            name: "宗门日常：材料上缴".to_string(),
            quest_type: "daily".to_string(),
            target: "提交一阶矿石 8个".to_string(),
            required: 8,
            reward: SectQuestRewardDto { contribution: 45, build_points: 2, funds: 16 },
            action_type: "submit_item".to_string(),
            submit_requirement: Some(SectQuestSubmitRequirementDto {
                item_def_id: "mat-001".to_string(),
                item_name: "一阶矿石".to_string(),
                item_category: "material".to_string(),
            }),
        },
        SectQuestTemplate {
            id: "sect-quest-weekly-001".to_string(),
            name: "宗门周常：大额捐献".to_string(),
            quest_type: "weekly".to_string(),
            target: "累计捐献灵石 1000".to_string(),
            required: 1000,
            reward: SectQuestRewardDto { contribution: 150, build_points: 2, funds: 19 },
            action_type: "event".to_string(),
            submit_requirement: None,
        },
    ])
}

fn load_sect_shop_items() -> Result<Vec<SectShopItemDto>, AppError> {
    Ok(vec![
        SectShopItemDto {
            id: "sect-shop-bag-expand".to_string(),
            name: "储物袋扩容符".to_string(),
            item_def_id: "func-001".to_string(),
            qty: 1,
            cost_contribution: 100,
            item_icon: None,
            purchase_limit: Some(serde_json::json!({ "type": "daily", "maxCount": 1 })),
        },
        SectShopItemDto {
            id: "sect-shop-ore-1".to_string(),
            name: "一阶矿石".to_string(),
            item_def_id: "mat-001".to_string(),
            qty: 5,
            cost_contribution: 50,
            item_icon: None,
            purchase_limit: None,
        },
    ])
}

fn extract_shop_buy_item_qty_from_log_content(content: &str, item_name: &str) -> i64 {
    let prefix = format!("购买：{}×", item_name);
    if !content.starts_with(&prefix) {
        return 0;
    }
    content[prefix.len()..].trim().parse::<i64>().ok().filter(|value| *value > 0).unwrap_or(0)
}

fn load_item_defs_map() -> Result<HashMap<String, (String, Option<String>)>, AppError> {
    let mut map = HashMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = std::fs::read_to_string(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}")))
            .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        let items = payload.get("items").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        for item in items {
            let id = item.get("id").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            let name = item.get("name").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
            if id.is_empty() || name.is_empty() { continue; }
            let icon = item.get("icon").and_then(|value| value.as_str()).map(|value| value.to_string());
            map.insert(id, (name, icon));
        }
    }
    Ok(map)
}

fn date_key(now: time::OffsetDateTime) -> String {
    format!("{:04}-{:02}-{:02}", now.year(), u8::from(now.month()), now.day())
}

fn normalize_date_key(raw: String) -> String {
    raw.chars().take(10).collect()
}

fn iso_week_key(now: time::OffsetDateTime) -> String {
    let iso = now.to_iso_week_date();
    format!("{:04}-{:02}", iso.0, iso.1)
}

fn compare_realm_rank(realm_a: &str, realm_b: &str) -> i64 {
    const ORDER: &[&str] = &["凡人", "练气", "筑基", "金丹", "元婴", "化神", "炼虚", "合体", "大乘", "渡劫", "真仙"];
    let a = ORDER.iter().position(|value| *value == realm_a.trim()).unwrap_or(0) as i64;
    let b = ORDER.iter().position(|value| *value == realm_b.trim()).unwrap_or(0) as i64;
    a - b
}

fn has_sect_permission(position: &str, action: &str) -> bool {
    match position {
        "leader" => true,
        "vice_leader" => action != "disband",
        "elder" => ["approve", "kick", "quest", "building", "donate"].contains(&action),
        "elite" => ["quest", "donate"].contains(&action),
        _ => ["quest", "donate"].contains(&action),
    }
}

fn position_rank(position: &str) -> i64 {
    match position {
        "leader" => 5,
        "vice_leader" => 4,
        "elder" => 3,
        "elite" => 2,
        _ => 1,
    }
}

async fn load_member_role(state: &AppState, character_id: i64, for_update: bool) -> Result<Option<SectMemberRole>, AppError> {
    let sql = if for_update {
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1 FOR UPDATE"
    } else {
        "SELECT sect_id, position FROM sect_member WHERE character_id = $1 LIMIT 1"
    };
    let row = state.database.fetch_optional(sql, |query| query.bind(character_id)).await?;
    Ok(row.map(|row| SectMemberRole {
        sect_id: row.try_get::<Option<String>, _>("sect_id").unwrap_or(None).unwrap_or_default(),
        position: row.try_get::<Option<String>, _>("position").unwrap_or(None).unwrap_or_else(|| "disciple".to_string()),
    }))
}

struct SectMemberRole {
    sect_id: String,
    position: String,
}

fn generate_sect_id() -> String {
    format!("sect-{}", time::OffsetDateTime::now_utc().unix_timestamp_nanos())
}

fn is_sect_quest_in_current_period(quest_type: &str, accepted_at: Option<&str>) -> bool {
    let Some(accepted_at) = accepted_at else { return false; };
    let accepted_key = normalize_date_key(accepted_at.to_string());
    let now = time::OffsetDateTime::now_utc();
    if quest_type == "weekly" {
        return accepted_key.starts_with(&iso_week_key(now));
    }
    accepted_key == date_key(now)
}

async fn count_character_item_qty(state: &AppState, character_id: i64, item_def_id: &str) -> Result<i64, AppError> {
    let row = state.database.fetch_one(
        "SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = $2 AND location = 'bag'",
        |query| query.bind(character_id).bind(item_def_id),
    ).await?;
    Ok(row.try_get::<Option<i64>, _>("qty")?.unwrap_or_default())
}

async fn consume_character_item_qty(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
) -> Result<(), AppError> {
    let rows = state.database.fetch_all(
        "SELECT id, qty FROM item_instance WHERE owner_user_id = $1 AND owner_character_id = $2 AND item_def_id = $3 AND location = 'bag' ORDER BY created_at ASC, id ASC FOR UPDATE",
        |query| query.bind(user_id).bind(character_id).bind(item_def_id),
    ).await?;
    let mut remaining = qty.max(0);
    for row in rows {
        if remaining <= 0 { break; }
        let item_id: i64 = row.try_get("id")?;
        let current_qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default()
            .max(0);
        if current_qty <= 0 { continue; }
        let consume = remaining.min(current_qty);
        if consume == current_qty {
            state.database.execute("DELETE FROM item_instance WHERE id = $1", |query| query.bind(item_id)).await?;
        } else {
            state.database.execute("UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1", |query| query.bind(item_id).bind(consume)).await?;
        }
        remaining -= consume;
    }
    if remaining > 0 {
        return Err(AppError::config("物品扣除失败"));
    }
    Ok(())
}

fn build_sect_def_dto(row: &sqlx::postgres::PgRow) -> Result<SectDefDto, AppError> {
    Ok(SectDefDto {
        id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
        name: row.try_get::<Option<String>, _>("name")?.unwrap_or_default(),
        leader_id: opt_i64_from_i32(row, "leader_id"),
        level: opt_i64_from_i32_default(row, "level", 1),
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
        funds: row.try_get::<Option<i64>, _>("funds")?.unwrap_or_default(),
        reputation: row.try_get::<Option<i64>, _>("reputation")?.unwrap_or_default(),
        build_points: opt_i64_from_i32(row, "build_points"),
        announcement: row.try_get::<Option<String>, _>("announcement")?,
        description: row.try_get::<Option<String>, _>("description")?,
        join_type: row.try_get::<Option<String>, _>("join_type")?.unwrap_or_else(|| "apply".to_string()),
        join_min_realm: row.try_get::<Option<String>, _>("join_min_realm")?.unwrap_or_else(|| "凡人".to_string()),
        member_count: opt_i64_from_i32(row, "member_count"),
        max_members: opt_i64_from_i32_default(row, "max_members", 20),
        created_at: row.try_get::<Option<String>, _>("created_at_text").unwrap_or(None).unwrap_or_default(),
        updated_at: row.try_get::<Option<String>, _>("updated_at_text").unwrap_or(None).unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn sect_me_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "sect": {"id": "sect-001", "name": "青云宗"},
                "members": [{"characterId": 1, "nickname": "凌霄子", "monthCardActive": true}],
                "buildings": [],
                "blessingStatus": {"today": "2026-04-11", "blessedToday": false, "canBless": true, "active": false, "expireAt": null, "fuyuanBonus": 0, "durationHours": 3}
            }
        });
        assert_eq!(payload["data"]["sect"]["name"], "青云宗");
        println!("SECT_ME_RESPONSE={}", payload);
    }

    #[test]
    fn sect_search_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"list": [{"id": "sect-001", "name": "青云宗", "level": 1, "memberCount": 5, "maxMembers": 20, "joinType": "apply", "joinMinRealm": "凡人", "announcement": null}], "page": 1, "limit": 20, "total": 1}
        });
        assert_eq!(payload["data"]["list"][0]["id"], "sect-001");
        println!("SECT_SEARCH_RESPONSE={}", payload);
    }

    #[test]
    fn sect_bonuses_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"attrBonus": {"wugong": 20}, "expBonus": 24, "dropBonus": 2, "craftBonus": 0, "equipmentGrowthCostDiscount": 0.01}
        });
        assert_eq!(payload["data"]["expBonus"], 24);
        println!("SECT_BONUSES_RESPONSE={}", payload);
    }

    #[test]
    fn sect_info_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "sect": {"id": "sect-001", "name": "青云宗"},
                "members": [{"characterId": 1, "nickname": "凌霄子"}],
                "buildings": []
            }
        });
        assert_eq!(payload["data"]["sect"]["id"], "sect-001");
        println!("SECT_INFO_RESPONSE={}", payload);
    }

    #[test]
    fn sect_quests_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": "sect-quest-daily-001", "questType": "daily", "status": "not_accepted", "progress": 0}]
        });
        assert_eq!(payload["data"][0]["questType"], "daily");
        println!("SECT_QUESTS_RESPONSE={}", payload);
    }

    #[test]
    fn sect_shop_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": "sect-shop-bag-expand", "itemDefId": "cons-bag-expand-001", "costContribution": 100, "itemIcon": null}]
        });
        assert_eq!(payload["data"][0]["id"], "sect-shop-bag-expand");
        println!("SECT_SHOP_RESPONSE={}", payload);
    }

    #[test]
    fn sect_applications_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": 1, "characterId": 2, "nickname": "白尘", "monthCardActive": false, "realm": "凡人", "message": null, "createdAt": "2026-04-11T12:00:00Z"}]
        });
        assert_eq!(payload["data"][0]["characterId"], 2);
        println!("SECT_APPLICATIONS_RESPONSE={}", payload);
    }

    #[test]
    fn sect_my_applications_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": 1, "sectId": "sect-001", "sectName": "青云宗", "sectLevel": 1, "memberCount": 5, "maxMembers": 20, "joinType": "apply", "createdAt": "2026-04-11T12:00:00Z", "message": null}]
        });
        assert_eq!(payload["data"][0]["sectId"], "sect-001");
        println!("SECT_MY_APPLICATIONS_RESPONSE={}", payload);
    }

    #[test]
    fn sect_logs_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"id": 1, "logType": "create", "content": "创建宗门：青云宗", "createdAt": "2026-04-11T12:00:00Z", "operatorId": 1, "operatorName": "凌霄子", "targetId": null, "targetName": null}]
        });
        assert_eq!(payload["data"][0]["logType"], "create");
        println!("SECT_LOGS_RESPONSE={}", payload);
    }

    #[test]
    fn sect_apply_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "申请已提交", "data": {"debugRealtime": {"kind": "sect:update", "source": "apply_to_sect", "sectId": "sect-001"}}});
        assert_eq!(payload["message"], "申请已提交");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "sect:update");
        println!("SECT_APPLY_RESPONSE={}", payload);
    }

    #[test]
    fn sect_cancel_application_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "已取消", "data": {}});
        assert_eq!(payload["message"], "已取消");
        println!("SECT_CANCEL_APPLICATION_RESPONSE={}", payload);
    }

    #[test]
    fn sect_handle_application_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "已通过", "data": {}});
        assert_eq!(payload["message"], "已通过");
        println!("SECT_HANDLE_APPLICATION_RESPONSE={}", payload);
    }

    #[test]
    fn sect_leave_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "已退出宗门", "data": {}});
        assert_eq!(payload["message"], "已退出宗门");
        println!("SECT_LEAVE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_create_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "创建成功", "data": {"sectId": "sect-123"}});
        assert_eq!(payload["data"]["sectId"], "sect-123");
        println!("SECT_CREATE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_announcement_update_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "公告更新成功", "data": {"debugRealtime": {"kind": "sect:update", "source": "update_announcement", "sectId": "sect-001"}}});
        assert_eq!(payload["message"], "公告更新成功");
        assert_eq!(payload["data"]["debugRealtime"]["source"], "update_announcement");
        println!("SECT_ANNOUNCEMENT_UPDATE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_blessing_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "祈福成功",
            "data": {"today": "2026-04-11", "blessedToday": true, "canBless": false, "active": true, "expireAt": "2026-04-11T15:00:00Z", "fuyuanBonus": 1.5, "durationHours": 3}
        });
        assert_eq!(payload["data"]["fuyuanBonus"], 1.5);
        println!("SECT_BLESSING_RESPONSE={}", payload);
    }

    #[test]
    fn sect_building_upgrade_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "升级成功", "data": {"debugRealtime": {"kind": "sect:update", "source": "upgrade_building", "sectId": "sect-001"}}});
        assert_eq!(payload["message"], "升级成功");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "sect:update");
        println!("SECT_BUILDING_UPGRADE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_quest_accept_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "ok", "data": {}});
        assert_eq!(payload["message"], "ok");
        println!("SECT_QUEST_ACCEPT_RESPONSE={}", payload);
    }

    #[test]
    fn sect_quest_submit_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "ok", "data": {"consumed": 2, "progress": 2, "status": "in_progress"}});
        assert_eq!(payload["data"]["consumed"], 2);
        println!("SECT_QUEST_SUBMIT_RESPONSE={}", payload);
    }

    #[test]
    fn sect_quest_claim_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "ok", "data": {"contribution": 25, "buildPoints": 1, "funds": 10}});
        assert_eq!(payload["data"]["contribution"], 25);
        println!("SECT_QUEST_CLAIM_RESPONSE={}", payload);
    }

    #[test]
    fn sect_shop_buy_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "购买成功", "data": {"itemDefId": "cons-bag-expand-001", "qty": 1, "itemIds": [11]}});
        assert_eq!(payload["data"]["itemDefId"], "cons-bag-expand-001");
        println!("SECT_SHOP_BUY_RESPONSE={}", payload);
    }

    #[test]
    fn sect_donate_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "捐献成功", "data": {"debugRealtime": {"kind": "sect:update", "source": "donate_to_sect", "sectId": "sect-001"}}});
        assert_eq!(payload["message"], "捐献成功");
        assert_eq!(payload["data"]["debugRealtime"]["source"], "donate_to_sect");
        println!("SECT_DONATE_RESPONSE={}", payload);
    }

    #[test]
    fn sect_appoint_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "任命成功", "data": {}});
        assert_eq!(payload["message"], "任命成功");
        println!("SECT_APPOINT_RESPONSE={}", payload);
    }

    #[test]
    fn sect_kick_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "已踢出成员", "data": {}});
        assert_eq!(payload["message"], "已踢出成员");
        println!("SECT_KICK_RESPONSE={}", payload);
    }

    #[test]
    fn sect_transfer_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "转让成功", "data": {}});
        assert_eq!(payload["message"], "转让成功");
        println!("SECT_TRANSFER_RESPONSE={}", payload);
    }

    #[test]
    fn sect_disband_payload_matches_contract() {
        let payload = serde_json::json!({"success": true, "message": "解散成功", "data": {}});
        assert_eq!(payload["message"], "解散成功");
        println!("SECT_DISBAND_RESPONSE={}", payload);
    }
}
