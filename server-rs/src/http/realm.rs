use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::realtime::rank::{RankUpdatePayload, build_rank_update_payload};
use crate::realtime::realm::{RealmUpdatePayload, build_realm_update_payload};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

#[derive(Debug, Deserialize)]
struct RealmBreakthroughConfigFile {
    #[serde(rename = "realmOrder")]
    realm_order: Vec<String>,
    breakthroughs: Vec<BreakthroughConfig>,
}

#[derive(Debug, Deserialize, Clone)]
struct BreakthroughConfig {
    from: String,
    requirements: Option<Vec<BreakthroughRequirement>>,
    costs: Option<Vec<BreakthroughCost>>,
    rewards: Option<BreakthroughRewards>,
}

#[derive(Debug, Deserialize, Clone)]
struct BreakthroughRequirement {
    id: Option<String>,
    #[serde(rename = "type")]
    requirement_type: String,
    title: Option<String>,
    min: Option<i64>,
    #[serde(rename = "minLayer")]
    min_layer: Option<i64>,
    #[serde(rename = "minCount")]
    min_count: Option<i64>,
    #[serde(rename = "techniqueId")]
    technique_id: Option<String>,
    #[serde(rename = "itemDefId")]
    item_def_id: Option<String>,
    qty: Option<i64>,
    #[serde(rename = "dungeonId")]
    dungeon_id: Option<String>,
    #[serde(rename = "difficultyId")]
    difficulty_id: Option<String>,
    #[serde(rename = "chapterId")]
    chapter_id: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type")]
enum BreakthroughCost {
    #[serde(rename = "exp")]
    Exp { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "items")]
    Items { items: Vec<ItemCost> },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize, Clone)]
struct ItemCost {
    #[serde(rename = "itemDefId")]
    item_def_id: String,
    qty: i64,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct BreakthroughRewards {
    #[serde(rename = "attributePoints")]
    attribute_points: Option<i64>,
    flat: Option<BTreeMap<String, f64>>,
    pct: Option<BTreeMap<String, f64>>,
    #[serde(rename = "addPercent")]
    add_percent: Option<BTreeMap<String, f64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmOverviewDto {
    pub config_path: Option<String>,
    pub realm_order: Vec<String>,
    pub current_realm: String,
    pub current_index: i64,
    pub next_realm: Option<String>,
    pub exp: i64,
    pub spirit_stones: i64,
    pub requirements: Vec<RealmRequirementView>,
    pub costs: Vec<RealmCostView>,
    pub rewards: Vec<RealmRewardView>,
    pub can_breakthrough: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmRequirementView {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmCostView {
    pub id: String,
    pub title: String,
    pub detail: String,
    #[serde(rename = "type")]
    pub cost_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_def_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qty: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RealmRewardView {
    pub id: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
pub struct RealmBreakthroughPayload {
    pub direction: Option<String>,
    #[serde(rename = "targetRealm")]
    pub target_realm: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmBreakthroughData {
    pub from_realm: String,
    pub new_realm: String,
    pub spent_exp: i64,
    pub spent_spirit_stones: i64,
    pub spent_items: Vec<RealmSpentItem>,
    pub gained_attribute_points: i64,
    pub current_exp: i64,
    pub current_spirit_stones: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<RealmUpdatePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_rank_realtime: Option<RankUpdatePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealmSpentItem {
    pub item_def_id: String,
    pub qty: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TechniqueDefFile {
    techniques: Vec<TechniqueDef>,
}

#[derive(Debug, Deserialize)]
struct TechniqueDef {
    id: String,
    name: String,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct DungeonSeedFile {
    dungeons: Vec<DungeonSeed>,
}

#[derive(Debug, Deserialize)]
struct DungeonSeed {
    def: DungeonDef,
    difficulties: Vec<DungeonDifficultyDef>,
}

#[derive(Debug, Deserialize)]
struct DungeonDef {
    id: String,
    name: String,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct DungeonDifficultyDef {
    id: String,
    name: String,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct MainQuestChapterFile {
    chapters: Vec<MainQuestChapterDef>,
}

#[derive(Debug, Deserialize)]
struct MainQuestChapterDef {
    id: String,
    name: String,
    enabled: Option<bool>,
}

pub async fn get_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<RealmOverviewDto>>, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let (config, config_path) = load_realm_breakthrough_config()?;

    let row = state
        .database
        .fetch_optional(
            "SELECT id, realm, sub_realm, exp, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(user.user_id),
        )
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;

    let character_id: i64 = row.try_get("id")?;
    let realm: String = row.try_get::<Option<String>, _>("realm")?.unwrap_or_else(|| "凡人".to_string());
    let sub_realm: String = row.try_get::<Option<String>, _>("sub_realm")?.unwrap_or_default();
    let exp: i64 = row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default();
    let spirit_stones: i64 = row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default();

    let current_realm = if realm.trim() == "凡人" || sub_realm.trim().is_empty() {
        realm.trim().to_string()
    } else {
        format!("{}·{}", realm.trim(), sub_realm.trim())
    };
    let current_index = config
        .realm_order
        .iter()
        .position(|value| value == &current_realm)
        .unwrap_or(0) as i64;
    let next_realm = config.realm_order.get(current_index as usize + 1).cloned();
    let breakthrough = next_realm
        .as_ref()
        .and_then(|_| config.breakthroughs.iter().find(|entry| entry.from.trim() == current_realm).cloned());

    let requirements = if let Some(breakthrough) = &breakthrough {
        evaluate_requirements(&state, character_id, exp, spirit_stones, breakthrough.requirements.clone().unwrap_or_default()).await?
    } else {
        Vec::new()
    };
    let costs_built = if let Some(breakthrough) = &breakthrough {
        build_costs_view(&state, character_id, exp, spirit_stones, breakthrough.costs.clone().unwrap_or_default()).await?
    } else {
        BuiltCosts { view: Vec::new() }
    };
    let rewards = build_rewards_view(breakthrough.as_ref().and_then(|entry| entry.rewards.clone()));
    Ok(send_success(build_realm_overview_dto(
        config_path,
        config.realm_order,
        current_realm,
        exp,
        spirit_stones,
        requirements,
        costs_built.view,
        rewards,
    )))
}

pub async fn breakthrough(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RealmBreakthroughPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let target_realm = payload.target_realm.unwrap_or_default();
    let direction = payload.direction.unwrap_or_default();

    let result = if !target_realm.trim().is_empty() {
        breakthrough_to_target_realm(&state, user.user_id, target_realm.trim()).await?
    } else if direction.trim().is_empty() || direction.trim() == "next" {
        breakthrough_to_next_realm(&state, user.user_id).await?
    } else {
        failure_result::<RealmBreakthroughData>("突破方向无效")
    };

    Ok(crate::shared::response::send_result(result))
}

#[derive(Debug, Clone)]
struct BreakthroughCharacterState {
    character_id: i64,
    from_realm: String,
    exp: i64,
    spirit_stones: i64,
    attribute_points: i64,
    next_realm: Option<String>,
    breakthrough: Option<BreakthroughConfig>,
}

async fn breakthrough_to_target_realm(
    state: &AppState,
    user_id: i64,
    target_realm: &str,
) -> Result<ServiceResult<RealmBreakthroughData>, AppError> {
    let (config, _) = load_realm_breakthrough_config()?;
    if !config.realm_order.iter().any(|realm| realm == target_realm) {
        return Ok(failure_result("目标境界未开放"));
    }
    let overview_state = load_breakthrough_character_state(state, user_id, false).await?;
    let Some(state_preview) = overview_state else {
        return Ok(failure_result("角色不存在"));
    };
    let Some(next_realm) = state_preview.next_realm.clone() else {
        return Ok(failure_result("已达最高境界"));
    };
    if next_realm != target_realm {
        return Ok(failure_result("只能突破到下一境界"));
    }
    breakthrough_to_next_realm(state, user_id).await
}

async fn breakthrough_to_next_realm(
    state: &AppState,
    user_id: i64,
) -> Result<ServiceResult<RealmBreakthroughData>, AppError> {
    let preview_state = load_breakthrough_character_state(state, user_id, false).await?;
    let Some(preview_state) = preview_state else {
        return Ok(failure_result("角色不存在"));
    };
    let Some(next_realm) = preview_state.next_realm.clone() else {
        return Ok(failure_result("已达最高境界"));
    };
    let Some(breakthrough) = preview_state.breakthrough.clone() else {
        return Ok(failure_result("下一境界配置不存在"));
    };

    let preview_requirements = evaluate_requirements(
        state,
        preview_state.character_id,
        preview_state.exp,
        preview_state.spirit_stones,
        breakthrough.requirements.clone().unwrap_or_default(),
    )
    .await?;
    if let Some(unmet) = preview_requirements.iter().find(|item| item.status != "done") {
        return Ok(build_requirement_failure_result(unmet));
    }

    let preview_costs = build_costs_view(
        state,
        preview_state.character_id,
        preview_state.exp,
        preview_state.spirit_stones,
        breakthrough.costs.clone().unwrap_or_default(),
    )
    .await?;
    let (cost_exp, cost_spirit_stones, cost_items) = extract_cost_totals(&preview_costs.view);
    if preview_state.exp < cost_exp {
        return Ok(failure_result(&format!("经验不足，需要 {cost_exp}")));
    }
    if preview_state.spirit_stones < cost_spirit_stones {
        return Ok(failure_result(&format!("灵石不足，需要 {cost_spirit_stones}")));
    }

    let item_map = load_item_name_icon_map()?;
    for item in &cost_items {
        let have = get_item_qty_in_bag(state, preview_state.character_id, &item.item_def_id).await?;
        if have < item.qty {
            let item_name = item_map.get(&item.item_def_id).map(|item| item.0.clone()).unwrap_or_else(|| item.item_def_id.clone());
            return Ok(failure_result(&format!("材料不足：{item_name}")));
        }
    }

    let from_realm = preview_state.from_realm.clone();
    let rewards = breakthrough.rewards.clone().unwrap_or_default();
    let gained_attribute_points = rewards.attribute_points.unwrap_or_default().max(0);
    let spent_items_for_response: Vec<RealmSpentItem> = cost_items
        .iter()
        .map(|item| RealmSpentItem {
            item_def_id: item.item_def_id.clone(),
            qty: item.qty,
            name: item_map.get(&item.item_def_id).map(|item| item.0.clone()),
            icon: item_map.get(&item.item_def_id).and_then(|item| item.1.clone()),
        })
        .collect();

    state
        .database
        .with_transaction(|| async {
            let locked_state = load_breakthrough_character_state(state, user_id, true).await?;
            let Some(locked_state) = locked_state else {
                return Ok(failure_result::<RealmBreakthroughData>("角色不存在"));
            };
            if locked_state.from_realm != from_realm {
                return Ok(failure_result("角色状态已变化，请重试"));
            }

            let volatile_requirements = filter_volatile_requirements(
                breakthrough.requirements.clone().unwrap_or_default(),
            );
            if !volatile_requirements.is_empty() {
                let rechecked = evaluate_requirements(
                    state,
                    locked_state.character_id,
                    locked_state.exp,
                    locked_state.spirit_stones,
                    volatile_requirements,
                )
                .await?;
                if let Some(unmet) = rechecked.iter().find(|item| item.status != "done") {
                    return Ok(build_requirement_failure_result(unmet));
                }
            }

            if locked_state.exp < cost_exp {
                return Ok(failure_result(&format!("经验不足，需要 {cost_exp}")));
            }
            if locked_state.spirit_stones < cost_spirit_stones {
                return Ok(failure_result(&format!("灵石不足，需要 {cost_spirit_stones}")));
            }

            for item in &cost_items {
                let consumed = consume_item_from_bag_tx(state, locked_state.character_id, &item.item_def_id, item.qty).await?;
                if !consumed {
                    let item_name = item_map.get(&item.item_def_id).map(|item| item.0.clone()).unwrap_or_else(|| item.item_def_id.clone());
                    return Ok(failure_result(&format!("材料不足：{item_name}")));
                }
            }

            let new_exp = locked_state.exp - cost_exp;
            let new_spirit_stones = locked_state.spirit_stones - cost_spirit_stones;
            let new_attribute_points = locked_state.attribute_points + gained_attribute_points;
            state
                .database
                .execute(
                    "UPDATE characters SET realm = $1, sub_realm = NULL, exp = $2, spirit_stones = $3, attribute_points = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5",
                    |query| query.bind(&next_realm).bind(new_exp).bind(new_spirit_stones).bind(new_attribute_points).bind(locked_state.character_id),
                )
                .await?;

            Ok(success_result(
                &format!("突破至{}成功", next_realm),
                RealmBreakthroughData {
                    from_realm: from_realm.clone(),
                    new_realm: next_realm.clone(),
                    spent_exp: cost_exp,
                    spent_spirit_stones: cost_spirit_stones,
                    spent_items: spent_items_for_response.clone(),
                    gained_attribute_points,
                    current_exp: new_exp,
                    current_spirit_stones: new_spirit_stones,
                    debug_realtime: Some(build_realm_update_payload("breakthrough", &from_realm, &next_realm)),
                    debug_rank_realtime: Some(build_rank_update_payload("breakthrough", &["realm", "power"])),
                },
            ))
        })
        .await
}

async fn load_breakthrough_character_state(
    state: &AppState,
    user_id: i64,
    for_update: bool,
) -> Result<Option<BreakthroughCharacterState>, AppError> {
    let (config, _) = load_realm_breakthrough_config()?;
    let sql = if for_update {
        "SELECT id, realm, sub_realm, exp, spirit_stones, attribute_points FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE"
    } else {
        "SELECT id, realm, sub_realm, exp, spirit_stones, attribute_points FROM characters WHERE user_id = $1 LIMIT 1"
    };
    let row = state.database.fetch_optional(sql, |query| query.bind(user_id)).await?;
    let Some(row) = row else { return Ok(None); };
    let character_id: i64 = row.try_get("id")?;
    let realm: String = row.try_get::<Option<String>, _>("realm")?.unwrap_or_else(|| "凡人".to_string());
    let sub_realm: String = row.try_get::<Option<String>, _>("sub_realm")?.unwrap_or_default();
    let current_realm = if realm.trim() == "凡人" || sub_realm.trim().is_empty() {
        realm.trim().to_string()
    } else {
        format!("{}·{}", realm.trim(), sub_realm.trim())
    };
    let current_index = config.realm_order.iter().position(|value| value == &current_realm).unwrap_or(0);
    let next_realm = config.realm_order.get(current_index + 1).cloned();
    let breakthrough = config.breakthroughs.iter().find(|entry| entry.from.trim() == current_realm).cloned();
    Ok(Some(BreakthroughCharacterState {
        character_id,
        from_realm: current_realm,
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
        spirit_stones: row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default(),
        attribute_points: opt_i64_from_i32(&row, "attribute_points")?.unwrap_or_default(),
        next_realm,
        breakthrough,
    }))
}

fn filter_volatile_requirements(requirements: Vec<BreakthroughRequirement>) -> Vec<BreakthroughRequirement> {
    requirements
        .into_iter()
        .filter(|requirement| matches!(requirement.requirement_type.as_str(), "main_technique_layer_min" | "main_and_sub_technique_layer_min"))
        .collect()
}

fn build_requirement_failure_result(requirement: &RealmRequirementView) -> ServiceResult<RealmBreakthroughData> {
    if requirement.source_type.as_deref() == Some("version_gate") {
        return failure_result(&requirement.detail);
    }
    failure_result(&format!("条件未满足：{}", requirement.title))
}

fn extract_cost_totals(costs: &[RealmCostView]) -> (i64, i64, Vec<ItemCost>) {
    let mut exp = 0;
    let mut spirit_stones = 0;
    let mut items = Vec::new();
    for cost in costs {
        match cost.cost_type.as_str() {
            "exp" => exp += cost.amount.unwrap_or_default(),
            "spirit_stones" => spirit_stones += cost.amount.unwrap_or_default(),
            "item" => {
                if let (Some(item_def_id), Some(qty)) = (cost.item_def_id.clone(), cost.qty) {
                    items.push(ItemCost { item_def_id, qty });
                }
            }
            _ => {}
        }
    }
    (exp, spirit_stones, items)
}

async fn consume_item_from_bag_tx(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
) -> Result<bool, AppError> {
    let mut remaining = qty.max(0);
    if item_def_id.trim().is_empty() || remaining <= 0 {
        return Ok(true);
    }
    let rows = state
        .database
        .fetch_all(
            "SELECT id, qty FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' AND item_def_id = $2 ORDER BY created_at ASC, id ASC",
            |query| query.bind(character_id).bind(item_def_id),
        )
        .await?;
    for row in rows {
        if remaining <= 0 { break; }
        let item_id: i64 = row.try_get("id")?;
        let item_qty: i64 = opt_i64_from_i32(&row, "qty")?.unwrap_or_default().max(0);
        if item_qty <= 0 { continue; }
        let consume_qty = remaining.min(item_qty);
        if consume_qty == item_qty {
            state.database.execute("DELETE FROM item_instance WHERE id = $1", |query| query.bind(item_id)).await?;
        } else {
            state.database.execute("UPDATE item_instance SET qty = qty - $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", |query| query.bind(item_id).bind(consume_qty)).await?;
        }
        remaining -= consume_qty;
    }
    Ok(remaining <= 0)
}

fn failure_result<T>(message: &str) -> ServiceResult<T> {
    ServiceResult { success: false, message: Some(message.to_string()), data: None }
}

fn success_result<T: Serialize>(message: &str, data: T) -> ServiceResult<T> {
    ServiceResult { success: true, message: Some(message.to_string()), data: Some(data) }
}

fn build_realm_overview_dto(
    config_path: Option<String>,
    realm_order: Vec<String>,
    current_realm: String,
    exp: i64,
    spirit_stones: i64,
    requirements: Vec<RealmRequirementView>,
    costs: Vec<RealmCostView>,
    rewards: Vec<RealmRewardView>,
) -> RealmOverviewDto {
    let current_index = realm_order
        .iter()
        .position(|value| value == &current_realm)
        .unwrap_or(0) as i64;
    let next_realm = realm_order.get(current_index as usize + 1).cloned();
    let can_breakthrough = next_realm.is_some()
        && requirements.iter().all(|item| item.status == "done")
        && costs.iter().all(|item| item.status.as_deref() != Some("todo"));

    RealmOverviewDto {
        config_path,
        realm_order,
        current_realm,
        current_index,
        next_realm,
        exp,
        spirit_stones,
        requirements,
        costs,
        rewards,
        can_breakthrough,
    }
}

struct BuiltCosts {
    view: Vec<RealmCostView>,
}

async fn evaluate_requirements(
    state: &AppState,
    character_id: i64,
    exp: i64,
    spirit_stones: i64,
    requirements: Vec<BreakthroughRequirement>,
) -> Result<Vec<RealmRequirementView>, AppError> {
    let item_map = load_item_name_icon_map()?;
    let technique_map = load_technique_name_map()?;
    let dungeon_map = load_dungeon_name_map()?;
    let chapter_map = load_main_quest_chapter_map()?;
    let mut completed_chapters_cache: Option<HashSet<String>> = None;
    let mut equipped_subs_cache: Option<Vec<(String, i64, i64)>> = None;
    let main_tech = get_equipped_main_technique(state, character_id).await?;
    let mut out = Vec::new();

    for requirement in requirements {
        let id = requirement.id.clone().unwrap_or_default();
        let title = requirement.title.clone().unwrap_or_else(|| "条件".to_string());
        match requirement.requirement_type.as_str() {
            "exp_min" => {
                let min = requirement.min.unwrap_or_default().max(0);
                out.push(RealmRequirementView { id: if id.is_empty() { format!("exp-{min}") } else { id }, title, detail: format!("经验 ≥ {}（当前 {}）", min.to_string(), exp.to_string()), status: if exp >= min { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
            }
            "spirit_stones_min" => {
                let min = requirement.min.unwrap_or_default().max(0);
                out.push(RealmRequirementView { id: if id.is_empty() { format!("ss-{min}") } else { id }, title, detail: format!("灵石 ≥ {}（当前 {}）", min.to_string(), spirit_stones.to_string()), status: if spirit_stones >= min { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
            }
            "main_technique_layer_min" => {
                let min_layer = requirement.min_layer.unwrap_or_default().max(0);
                if let Some((name, layer)) = &main_tech {
                    out.push(RealmRequirementView { id: if id.is_empty() { format!("maintech-{min_layer}") } else { id }, title, detail: format!("{}（主功法）≥ {} 层（当前 {}）", name, min_layer, layer), status: if *layer >= min_layer { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
                } else {
                    out.push(RealmRequirementView { id: if id.is_empty() { format!("maintech-{min_layer}") } else { id }, title, detail: format!("未装备主功法（需要 ≥ {} 层）", min_layer), status: "todo".to_string(), source_type: None, source_ref: None });
                }
            }
            "technique_layer_min" => {
                let technique_id = requirement.technique_id.clone().unwrap_or_default();
                let min_layer = requirement.min_layer.unwrap_or_default().max(0);
                let layer = if technique_id.trim().is_empty() { 0 } else { get_technique_layer(state, character_id, &technique_id).await? };
                let tech_name = technique_map.get(&technique_id).cloned().unwrap_or_else(|| if technique_id.trim().is_empty() { "功法".to_string() } else { technique_id.clone() });
                out.push(RealmRequirementView { id: if id.is_empty() { format!("{}-{}", technique_id, min_layer) } else { id }, title, detail: format!("{} ≥ {} 层（当前 {}）", tech_name, min_layer, layer), status: if layer >= min_layer { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
            }
            "main_and_sub_technique_layer_min" => {
                let min_layer = requirement.min_layer.unwrap_or_default().max(0);
                let equipped_subs = if let Some(cache) = &equipped_subs_cache { cache.clone() } else { let loaded = get_equipped_sub_techniques(state, character_id).await?; equipped_subs_cache = Some(loaded.clone()); loaded };
                if let Some((name, layer)) = &main_tech {
                    let best_sub = equipped_subs.iter().max_by_key(|(_, layer, _)| *layer);
                    let ok_sub = equipped_subs.iter().any(|(_, layer, _)| *layer >= min_layer);
                    let sub_text = if let Some((sub_name, sub_layer, slot)) = best_sub { format!("{}（副{} 当前 {}） ≥{}", sub_name, slot, sub_layer, min_layer) } else { format!("未装备副功法 ≥{}", min_layer) };
                    out.push(RealmRequirementView { id: if id.is_empty() { format!("main-sub-{min_layer}") } else { id }, title, detail: format!("{}（主 当前 {}）≥{}；{}", name, layer, min_layer, sub_text), status: if *layer >= min_layer && ok_sub { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
                } else {
                    out.push(RealmRequirementView { id: if id.is_empty() { format!("main-sub-{min_layer}") } else { id }, title, detail: format!("未装备主功法（需要主功法≥{}且副功法≥{}）", min_layer, min_layer), status: "todo".to_string(), source_type: None, source_ref: None });
                }
            }
            "techniques_count_min_layer" => {
                let min_layer = requirement.min_layer.unwrap_or_default().max(0);
                let min_count = requirement.min_count.unwrap_or_default().max(0);
                let count = get_technique_count_min_layer(state, character_id, min_layer).await?;
                out.push(RealmRequirementView { id: if id.is_empty() { format!("techcnt-{min_count}-{min_layer}") } else { id }, title, detail: format!("至少 {} 门功法 ≥ {} 层（当前 {}）", min_count, min_layer, count), status: if count >= min_count { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
            }
            "item_qty_min" => {
                let item_def_id = requirement.item_def_id.clone().unwrap_or_default();
                let qty_need = requirement.qty.unwrap_or_default().max(0);
                let qty_have = if item_def_id.is_empty() { 0 } else { get_item_qty_in_bag(state, character_id, &item_def_id).await? };
                let item_name = item_map.get(&item_def_id).map(|entry| entry.0.clone()).unwrap_or_else(|| item_def_id.clone());
                out.push(RealmRequirementView { id: if id.is_empty() { format!("item-{item_def_id}") } else { id }, title, detail: format!("{} × {}（当前 {}）", item_name, qty_need, qty_have), status: if qty_have >= qty_need { "done" } else { "todo" }.to_string(), source_type: None, source_ref: None });
            }
            "dungeon_clear_min" => {
                let dungeon_id = requirement.dungeon_id.clone().unwrap_or_default();
                let difficulty_id = requirement.difficulty_id.clone().unwrap_or_default();
                let min_count = requirement.min_count.unwrap_or(1).max(1);
                let clear_count = get_dungeon_clear_count(state, character_id, if dungeon_id.is_empty() { None } else { Some(dungeon_id.as_str()) }, if difficulty_id.is_empty() { None } else { Some(difficulty_id.as_str()) }).await?;
                let dungeon_name = if dungeon_id.is_empty() { String::new() } else { dungeon_map.get(&dungeon_id).cloned().unwrap_or_else(|| "目标秘境".to_string()) };
                let difficulty_name = if difficulty_id.is_empty() { String::new() } else { dungeon_map.get(&difficulty_id).cloned().unwrap_or_else(|| "指定难度".to_string()) };
                let scope_text = if !dungeon_id.is_empty() { if !difficulty_id.is_empty() { format!("{}（{}）", dungeon_name, difficulty_name) } else { dungeon_name } } else if !difficulty_id.is_empty() { format!("任意秘境（{}）", difficulty_name) } else { "任意秘境".to_string() };
                out.push(RealmRequirementView { id: if id.is_empty() { format!("dungeon-clear-{}-{}-{}", if dungeon_id.is_empty() { "any" } else { &dungeon_id }, if difficulty_id.is_empty() { "any" } else { &difficulty_id }, min_count) } else { id }, title, detail: format!("{} 通关 ≥ {} 次（当前 {}）", scope_text, min_count, clear_count), status: if clear_count >= min_count { "done" } else { "todo" }.to_string(), source_type: Some("dungeon_record".to_string()), source_ref: Some(if !difficulty_id.is_empty() { format!("dungeon:{}|difficulty:{}", if dungeon_id.is_empty() { "*" } else { &dungeon_id }, difficulty_id) } else if !dungeon_id.is_empty() { format!("dungeon:{}", dungeon_id) } else { "dungeon:*".to_string() }) });
            }
            "main_quest_chapter_completed" => {
                let chapter_id = requirement.chapter_id.clone().unwrap_or_default();
                let completed = if let Some(cache) = &completed_chapters_cache { cache.clone() } else { let loaded = get_completed_main_quest_chapter_set(state, character_id).await?; completed_chapters_cache = Some(loaded.clone()); loaded };
                let done = !chapter_id.is_empty() && completed.contains(&chapter_id);
                let chapter_name = chapter_map.get(&chapter_id).cloned().unwrap_or_else(|| chapter_id.clone());
                out.push(RealmRequirementView { id: if id.is_empty() { format!("main-quest-chapter-{}", if chapter_id.is_empty() { "unknown" } else { &chapter_id }) } else { id }, title, detail: format!("{}（当前{}）", chapter_name, if done { "已完成" } else { "未完成" }), status: if done { "done" } else { "todo" }.to_string(), source_type: Some("main_quest".to_string()), source_ref: Some(if chapter_id.is_empty() { "chapter:*".to_string() } else { format!("chapter:{}", chapter_id) }) });
            }
            "version_locked" => {
                let reason = requirement.reason.clone().unwrap_or_else(|| "当前版本暂未开放".to_string());
                out.push(RealmRequirementView { id: if id.is_empty() { format!("version-locked-{}", title) } else { id }, title, detail: reason, status: "todo".to_string(), source_type: Some("version_gate".to_string()), source_ref: Some("realm:version_gate".to_string()) });
            }
            _ => {
                out.push(RealmRequirementView { id: if id.is_empty() { format!("unknown-{}", title) } else { id }, title, detail: "条件未接入".to_string(), status: "unknown".to_string(), source_type: None, source_ref: None });
            }
        }
    }
    Ok(out)
}

async fn build_costs_view(
    state: &AppState,
    character_id: i64,
    current_exp: i64,
    current_spirit_stones: i64,
    costs: Vec<BreakthroughCost>,
) -> Result<BuiltCosts, AppError> {
    let item_map = load_item_name_icon_map()?;
    let mut views = Vec::new();
    for cost in costs {
        match cost {
            BreakthroughCost::Exp { amount } if amount > 0 => {
                views.push(RealmCostView { id: "cost-exp".to_string(), title: "经验".to_string(), detail: format!("需要 {}（当前 {}）", amount, current_exp), cost_type: "exp".to_string(), status: Some(if current_exp >= amount { "done" } else { "todo" }.to_string()), amount: Some(amount), item_def_id: None, item_name: None, item_icon: None, qty: None });
            }
            BreakthroughCost::SpiritStones { amount } if amount > 0 => {
                views.push(RealmCostView { id: "cost-spirit-stones".to_string(), title: "灵石".to_string(), detail: format!("需要 {}（当前 {}）", amount, current_spirit_stones), cost_type: "spirit_stones".to_string(), status: Some(if current_spirit_stones >= amount { "done" } else { "todo" }.to_string()), amount: Some(amount), item_def_id: None, item_name: None, item_icon: None, qty: None });
            }
            BreakthroughCost::Items { items } => {
                for item in items.into_iter().filter(|item| item.qty > 0 && !item.item_def_id.trim().is_empty()) {
                    let have = get_item_qty_in_bag(state, character_id, &item.item_def_id).await?;
                    let meta = item_map.get(&item.item_def_id);
                    views.push(RealmCostView { id: format!("cost-item-{}", item.item_def_id), title: meta.map(|value| value.0.clone()).unwrap_or_else(|| item.item_def_id.clone()), detail: format!("×{}（当前 {}）", item.qty, have), cost_type: "item".to_string(), status: Some(if have >= item.qty { "done" } else { "todo" }.to_string()), amount: None, item_def_id: Some(item.item_def_id.clone()), item_name: meta.map(|value| value.0.clone()), item_icon: meta.and_then(|value| value.1.clone()), qty: Some(item.qty) });
                }
            }
            _ => {}
        }
    }
    Ok(BuiltCosts { view: views })
}

fn build_rewards_view(rewards: Option<BreakthroughRewards>) -> Vec<RealmRewardView> {
    let rewards = rewards.unwrap_or_default();
    let mut out = Vec::new();
    let ap = rewards.attribute_points.unwrap_or_default().max(0);
    if ap > 0 {
        out.push(RealmRewardView { id: "ap".to_string(), title: "属性点".to_string(), detail: format!("+{ap}") });
    }
    for (key, title) in [("max_qixue", "最大气血"), ("max_lingqi", "最大灵气"), ("wugong", "物攻"), ("fagong", "法攻"), ("wufang", "物防"), ("fafang", "法防")] {
        let flat = rewards.flat.as_ref().and_then(|map| map.get(key)).copied().unwrap_or_default();
        if flat != 0.0 {
            out.push(RealmRewardView { id: format!("flat-{key}"), title: title.to_string(), detail: format!("{}{:.0}", if flat > 0.0 { "+" } else { "" }, flat) });
        }
        let pct = rewards.pct.as_ref().and_then(|map| map.get(key)).copied().unwrap_or_default();
        if pct != 0.0 {
            out.push(RealmRewardView { id: format!("pct-{key}"), title: title.to_string(), detail: format!("{}{}%", if pct > 0.0 { "+" } else { "" }, trim_trailing_zeros(pct * 100.0)) });
        }
    }
    let control_res = rewards.add_percent.as_ref().and_then(|map| map.get("kongzhi_kangxing")).copied().unwrap_or_default();
    if control_res != 0.0 {
        out.push(RealmRewardView { id: "add-percent-kongzhi_kangxing".to_string(), title: "控制抗性".to_string(), detail: format!("{}{}%", if control_res > 0.0 { "+" } else { "" }, trim_trailing_zeros(control_res * 100.0)) });
    }
    out
}

fn load_realm_breakthrough_config() -> Result<(RealmBreakthroughConfigFile, Option<String>), AppError> {
    let candidates = [
        std::env::var("REALM_CONFIG_PATH").ok().filter(|value| !value.trim().is_empty()),
        Some(format!("{}/../server/src/data/seeds/realm_breakthrough.json", env!("CARGO_MANIFEST_DIR"))),
        Some(format!("{}/data/seeds/realm_breakthrough.json", env!("CARGO_MANIFEST_DIR"))),
    ];
    for candidate in candidates.into_iter().flatten() {
        let path = PathBuf::from(candidate.clone());
        if !path.exists() { continue; }
        let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read realm_breakthrough.json: {error}")))?;
        let config: RealmBreakthroughConfigFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse realm_breakthrough.json: {error}")))?;
        return Ok((config, Some(path.display().to_string())));
    }
    Err(AppError::config("realm_breakthrough.json not found"))
}

fn load_technique_name_map() -> Result<BTreeMap<String, String>, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/technique_def.json"))
        .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let file: TechniqueDefFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse technique_def.json: {error}")))?;
    Ok(file.techniques.into_iter().filter(|technique| technique.enabled != Some(false)).map(|technique| (technique.id, technique.name)).collect())
}

fn load_dungeon_name_map() -> Result<BTreeMap<String, String>, AppError> {
    let mut map = BTreeMap::new();
    let seed_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds");
    for entry in fs::read_dir(seed_dir).map_err(|error| AppError::config(format!("failed to read dungeon seed directory: {error}")))? {
        let entry = entry.map_err(|error| AppError::config(format!("failed to iterate dungeon seed directory: {error}")))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.starts_with("dungeon_") || !file_name.ends_with(".json") { continue; }
        let content = fs::read_to_string(entry.path()).map_err(|error| AppError::config(format!("failed to read {file_name}: {error}")))?;
        let file: DungeonSeedFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse {file_name}: {error}")))?;
        for dungeon in file.dungeons {
            if dungeon.def.enabled != Some(false) { map.insert(dungeon.def.id.clone(), dungeon.def.name.clone()); }
            for difficulty in dungeon.difficulties {
                if difficulty.enabled != Some(false) { map.insert(difficulty.id.clone(), difficulty.name.clone()); }
            }
        }
    }
    Ok(map)
}

fn load_main_quest_chapter_map() -> Result<BTreeMap<String, String>, AppError> {
    let mut map = BTreeMap::new();
    let seed_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds");
    for entry in fs::read_dir(seed_dir).map_err(|error| AppError::config(format!("failed to read main quest seed directory: {error}")))? {
        let entry = entry.map_err(|error| AppError::config(format!("failed to iterate main quest seed directory: {error}")))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.starts_with("main_quest_chapter") || !file_name.ends_with(".json") { continue; }
        let content = fs::read_to_string(entry.path()).map_err(|error| AppError::config(format!("failed to read {file_name}: {error}")))?;
        let file: MainQuestChapterFile = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse {file_name}: {error}")))?;
        for chapter in file.chapters.into_iter().filter(|chapter| chapter.enabled != Some(false)) {
            map.insert(chapter.id, chapter.name);
        }
    }
    Ok(map)
}

fn load_item_name_icon_map() -> Result<BTreeMap<String, (String, Option<String>)>, AppError> {
    let mut map = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path).map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let value: serde_json::Value = serde_json::from_str(&content).map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        if let Some(items) = value.get("items").and_then(|items| items.as_array()) {
            for item in items {
                let id = item.get("id").and_then(|value| value.as_str()).unwrap_or_default().trim();
                if id.is_empty() { continue; }
                let name = item.get("name").and_then(|value| value.as_str()).unwrap_or(id).to_string();
                let icon = item.get("icon").and_then(|value| value.as_str()).map(|value| value.to_string());
                map.insert(id.to_string(), (name, icon));
            }
        }
    }
    Ok(map)
}

async fn get_equipped_main_technique(state: &AppState, character_id: i64) -> Result<Option<(String, i64)>, AppError> {
    let technique_map = load_technique_name_map()?;
    let row = state.database.fetch_optional("SELECT technique_id, current_layer FROM character_technique WHERE character_id = $1 AND slot_type = 'main' LIMIT 1", |query| query.bind(character_id)).await?;
    let Some(row) = row else { return Ok(None); };
    let technique_id: String = row.try_get::<Option<String>, _>("technique_id")?.unwrap_or_default();
    if technique_id.trim().is_empty() { return Ok(None); }
    let name = technique_map.get(technique_id.trim()).cloned().unwrap_or_else(|| technique_id.trim().to_string());
    let layer = opt_i64_from_i32(&row, "current_layer")?.unwrap_or_default();
    Ok(Some((name, layer)))
}

async fn get_equipped_sub_techniques(state: &AppState, character_id: i64) -> Result<Vec<(String, i64, i64)>, AppError> {
    let technique_map = load_technique_name_map()?;
    let rows = state.database.fetch_all("SELECT technique_id, current_layer, slot_index FROM character_technique WHERE character_id = $1 AND slot_type = 'sub' ORDER BY slot_index ASC", |query| query.bind(character_id)).await?;
    let mut out = Vec::new();
    for row in rows {
        let technique_id: String = row.try_get::<Option<String>, _>("technique_id")?.unwrap_or_default();
        let slot_index = opt_i64_from_i32(&row, "slot_index")?.unwrap_or_default();
        if technique_id.trim().is_empty() || slot_index <= 0 { continue; }
        let name = technique_map.get(technique_id.trim()).cloned().unwrap_or_else(|| technique_id.trim().to_string());
        let layer = opt_i64_from_i32(&row, "current_layer")?.unwrap_or_default();
        out.push((name, layer, slot_index));
    }
    Ok(out)
}

async fn get_technique_count_min_layer(state: &AppState, character_id: i64, min_layer: i64) -> Result<i64, AppError> {
    let row = state.database.fetch_one("SELECT COUNT(1)::bigint AS cnt FROM character_technique WHERE character_id = $1 AND current_layer >= $2", |query| query.bind(character_id).bind(min_layer)).await?;
    Ok(row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default())
}

async fn get_technique_layer(state: &AppState, character_id: i64, technique_id: &str) -> Result<i64, AppError> {
    let row = state.database.fetch_optional("SELECT current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1", |query| query.bind(character_id).bind(technique_id)).await?;
    let Some(row) = row else { return Ok(0); };
    Ok(opt_i64_from_i32(&row, "current_layer")?.unwrap_or_default())
}

async fn get_item_qty_in_bag(state: &AppState, character_id: i64, item_def_id: &str) -> Result<i64, AppError> {
    let row = state.database.fetch_one("SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' AND item_def_id = $2", |query| query.bind(character_id).bind(item_def_id)).await?;
    Ok(row.try_get::<Option<i64>, _>("qty")?.unwrap_or_default())
}

async fn get_dungeon_clear_count(state: &AppState, character_id: i64, dungeon_id: Option<&str>, difficulty_id: Option<&str>) -> Result<i64, AppError> {
    let mut sql = String::from("SELECT COUNT(1)::bigint AS cnt FROM dungeon_record WHERE character_id = $1 AND result = 'cleared'");
    let rows = state.database.fetch_one(
        if dungeon_id.is_none() && difficulty_id.is_none() {
            &sql
        } else if let Some(dungeon_id) = dungeon_id {
            if let Some(difficulty_id) = difficulty_id {
                sql.push_str(" AND dungeon_id = $2 AND difficulty_id = $3");
                return state.database.fetch_one(&sql, |query| query.bind(character_id).bind(dungeon_id).bind(difficulty_id)).await.and_then(|row| Ok(row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default()));
            }
            sql.push_str(" AND dungeon_id = $2");
            return state.database.fetch_one(&sql, |query| query.bind(character_id).bind(dungeon_id)).await.and_then(|row| Ok(row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default()));
        } else {
            sql.push_str(" AND difficulty_id = $2");
            &sql
        },
        |query| {
            if let Some(difficulty_id) = difficulty_id { query.bind(character_id).bind(difficulty_id) } else { query.bind(character_id) }
        },
    ).await?;
    Ok(rows.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default())
}

async fn get_completed_main_quest_chapter_set(state: &AppState, character_id: i64) -> Result<HashSet<String>, AppError> {
    let row = state.database.fetch_optional("SELECT completed_chapters FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1", |query| query.bind(character_id)).await?;
    let Some(row) = row else { return Ok(HashSet::new()); };
    let raw: Option<serde_json::Value> = row.try_get("completed_chapters")?;
    let mut out = HashSet::new();
    if let Some(values) = raw.and_then(|value| value.as_array().cloned()) {
        for value in values {
            if let Some(chapter_id) = value.as_str().map(str::trim).filter(|value| !value.is_empty()) {
                out.insert(chapter_id.to_string());
            }
        }
    }
    Ok(out)
}

fn trim_trailing_zeros(value: f64) -> String {
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use crate::realtime::realm::build_realm_update_payload;

    #[test]
    fn rewards_view_formats_breakthrough_rewards() {
        let rewards = super::build_rewards_view(Some(super::BreakthroughRewards {
            attribute_points: Some(5),
            flat: Some(std::collections::BTreeMap::from([("max_qixue".to_string(), 50.0)])),
            pct: Some(std::collections::BTreeMap::from([("wugong".to_string(), 0.05)])),
            add_percent: Some(std::collections::BTreeMap::from([("kongzhi_kangxing".to_string(), 0.03)])),
        }));

        assert!(rewards.iter().any(|row| row.id == "ap" && row.detail == "+5"));
        assert!(rewards.iter().any(|row| row.id == "flat-max_qixue" && row.detail == "+50"));
        assert!(rewards.iter().any(|row| row.id == "pct-wugong" && row.detail == "+5%"));
        assert!(rewards.iter().any(|row| row.id == "add-percent-kongzhi_kangxing" && row.detail == "+3%"));
    }

    #[test]
    fn realm_config_loads_current_seed_order() {
        let (config, path) = super::load_realm_breakthrough_config().expect("realm config should load");
        assert!(path.is_some());
        assert_eq!(config.realm_order.first().map(String::as_str), Some("凡人"));
        assert_eq!(config.realm_order.get(1).map(String::as_str), Some("炼精化炁·养气期"));
        assert!(!config.breakthroughs.is_empty());
    }

    #[test]
    fn overview_is_breakthrough_ready_when_requirements_and_costs_are_done() {
        let overview = super::build_realm_overview_dto(
            Some("/tmp/realm_breakthrough.json".to_string()),
            vec!["凡人".to_string(), "炼精化炁·养气期".to_string()],
            "凡人".to_string(),
            100_000,
            0,
            vec![super::RealmRequirementView {
                id: "exp".to_string(),
                title: "修为经验".to_string(),
                detail: "经验 ≥ 100000（当前 100000）".to_string(),
                status: "done".to_string(),
                source_type: None,
                source_ref: None,
            }],
            vec![super::RealmCostView {
                id: "cost-exp".to_string(),
                title: "经验".to_string(),
                detail: "需要 100000（当前 100000）".to_string(),
                cost_type: "exp".to_string(),
                status: Some("done".to_string()),
                amount: Some(100_000),
                item_def_id: None,
                item_name: None,
                item_icon: None,
                qty: None,
            }],
            vec![super::RealmRewardView {
                id: "ap".to_string(),
                title: "属性点".to_string(),
                detail: "+5".to_string(),
            }],
        );

        assert_eq!(overview.current_index, 0);
        assert_eq!(overview.next_realm.as_deref(), Some("炼精化炁·养气期"));
        assert!(overview.can_breakthrough);
    }

    #[test]
    fn overview_is_blocked_when_requirement_or_cost_is_todo() {
        let overview = super::build_realm_overview_dto(
            Some("/tmp/realm_breakthrough.json".to_string()),
            vec!["凡人".to_string(), "炼精化炁·养气期".to_string()],
            "凡人".to_string(),
            50_000,
            0,
            vec![super::RealmRequirementView {
                id: "exp".to_string(),
                title: "修为经验".to_string(),
                detail: "经验 ≥ 100000（当前 50000）".to_string(),
                status: "todo".to_string(),
                source_type: None,
                source_ref: None,
            }],
            vec![super::RealmCostView {
                id: "cost-exp".to_string(),
                title: "经验".to_string(),
                detail: "需要 100000（当前 50000）".to_string(),
                cost_type: "exp".to_string(),
                status: Some("todo".to_string()),
                amount: Some(100_000),
                item_def_id: None,
                item_name: None,
                item_icon: None,
                qty: None,
            }],
            vec![],
        );

        assert!(!overview.can_breakthrough);
    }

    #[test]
    fn overview_payload_matches_frontend_contract_shape() {
        let overview = super::build_realm_overview_dto(
            Some("/tmp/realm_breakthrough.json".to_string()),
            vec!["凡人".to_string(), "炼精化炁·养气期".to_string(), "炼精化炁·通脉期".to_string()],
            "炼精化炁·养气期".to_string(),
            200_000,
            200,
            vec![super::RealmRequirementView {
                id: "dungeon-clear-any-1".to_string(),
                title: "秘境历练".to_string(),
                detail: "任意秘境 通关 ≥ 1 次（当前 1）".to_string(),
                status: "done".to_string(),
                source_type: Some("dungeon_record".to_string()),
                source_ref: Some("dungeon:*".to_string()),
            }],
            vec![super::RealmCostView {
                id: "cost-spirit-stones".to_string(),
                title: "灵石".to_string(),
                detail: "需要 200（当前 200）".to_string(),
                cost_type: "spirit_stones".to_string(),
                status: Some("done".to_string()),
                amount: Some(200),
                item_def_id: None,
                item_name: None,
                item_icon: None,
                qty: None,
            }],
            vec![super::RealmRewardView {
                id: "ap".to_string(),
                title: "属性点".to_string(),
                detail: "+5".to_string(),
            }],
        );

        let payload = serde_json::to_value(&overview).expect("overview should serialize");
        assert_eq!(payload["currentRealm"], "炼精化炁·养气期");
        assert_eq!(payload["currentIndex"], 1);
        assert_eq!(payload["nextRealm"], "炼精化炁·通脉期");
        assert_eq!(payload["canBreakthrough"], true);
        println!("REALM_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn breakthrough_success_payload_matches_frontend_contract_shape() {
        let result = super::success_result(
            "突破至炼精化炁·养气期成功",
            super::RealmBreakthroughData {
                from_realm: "凡人".to_string(),
                new_realm: "炼精化炁·养气期".to_string(),
                spent_exp: 100_000,
                spent_spirit_stones: 0,
                spent_items: vec![super::RealmSpentItem {
                    item_def_id: "mat-xinmo-jinghua".to_string(),
                    qty: 10,
                    name: Some("心魔精华".to_string()),
                    icon: Some("/assets/items/xinmo.png".to_string()),
                }],
                gained_attribute_points: 5,
                current_exp: 0,
                current_spirit_stones: 0,
                debug_realtime: Some(build_realm_update_payload("breakthrough", "凡人", "炼精化炁·养气期")),
                debug_rank_realtime: Some(crate::realtime::rank::build_rank_update_payload("breakthrough", &["realm", "power"])),
            },
        );

        let payload = serde_json::to_value(&result).expect("result should serialize");
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["fromRealm"], "凡人");
        assert_eq!(payload["data"]["newRealm"], "炼精化炁·养气期");
        assert_eq!(payload["data"]["gainedAttributePoints"], 5);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "realm:update");
        assert_eq!(payload["data"]["debugRankRealtime"]["kind"], "rank:update");
        println!("REALM_BREAKTHROUGH_SUCCESS_RESPONSE={}", payload);
    }

    #[test]
    fn breakthrough_failure_payload_matches_frontend_contract_shape() {
        let result = super::failure_result::<super::RealmBreakthroughData>("灵石不足，需要 200");
        let payload = serde_json::to_value(&result).expect("result should serialize");
        assert_eq!(payload["success"], false);
        assert_eq!(payload["message"], "灵石不足，需要 200");
        println!("REALM_BREAKTHROUGH_FAILURE_RESPONSE={}", payload);
    }
}
