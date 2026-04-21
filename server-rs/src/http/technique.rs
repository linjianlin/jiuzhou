use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::Path;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TechniqueDefDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub technique_type: String,
    pub quality: String,
    pub quality_rank: i64,
    pub max_layer: i64,
    pub required_realm: String,
    pub attribute_type: String,
    pub attribute_element: String,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub long_desc: Option<String>,
    pub icon: Option<String>,
    pub obtain_type: Option<String>,
    pub obtain_hint: Vec<String>,
    pub sort_weight: i64,
    pub version: i64,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TechniqueLayerDto {
    pub technique_id: String,
    pub layer: i64,
    pub cost_spirit_stones: i64,
    pub cost_exp: i64,
    pub cost_materials: Vec<TechniqueLayerCostMaterialDto>,
    pub passives: Vec<TechniquePassiveDto>,
    pub unlock_skill_ids: Vec<String>,
    pub upgrade_skill_ids: Vec<String>,
    pub required_realm: Option<String>,
    pub required_quest_id: Option<String>,
    pub layer_desc: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TechniqueLayerCostMaterialDto {
    #[serde(rename = "itemId", alias = "item_id")]
    pub item_id: String,
    pub qty: i64,
    #[serde(rename = "itemName")]
    pub item_name: Option<String>,
    #[serde(rename = "itemIcon")]
    pub item_icon: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct TechniquePassiveDto {
    pub key: String,
    pub value: f64,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
pub struct SkillDefDto {
    pub id: String,
    pub code: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub source_type: String,
    pub source_id: Option<String>,
    pub cost_lingqi: i64,
    pub cost_lingqi_rate: f64,
    pub cost_qixue: i64,
    pub cost_qixue_rate: f64,
    pub cooldown: i64,
    pub target_type: String,
    pub target_count: i64,
    pub damage_type: Option<String>,
    pub element: String,
    pub effects: Vec<serde_json::Value>,
    pub trigger_type: String,
    pub conditions: Option<serde_json::Value>,
    pub ai_priority: i64,
    pub ai_conditions: Option<serde_json::Value>,
    pub upgrades: Option<Vec<serde_json::Value>>,
    pub sort_weight: i64,
    pub version: i64,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct TechniqueListData {
    pub techniques: Vec<TechniqueDefDto>,
}

#[derive(Debug, Serialize)]
pub struct TechniqueDetailData {
    pub technique: TechniqueDefDto,
    pub layers: Vec<TechniqueLayerDto>,
    pub skills: Vec<SkillDefDto>,
}

#[derive(Debug, Deserialize)]
struct TechniqueDefFile {
    techniques: Vec<RawTechniqueDef>,
}

#[derive(Debug, Deserialize)]
struct RawTechniqueDef {
    id: String,
    code: Option<String>,
    name: String,
    #[serde(rename = "type")]
    technique_type: String,
    quality: Option<String>,
    max_layer: Option<i64>,
    required_realm: Option<String>,
    attribute_type: Option<String>,
    attribute_element: Option<String>,
    tags: Option<Vec<String>>,
    description: Option<String>,
    long_desc: Option<String>,
    icon: Option<String>,
    obtain_type: Option<String>,
    obtain_hint: Option<Vec<String>>,
    sort_weight: Option<i64>,
    version: Option<i64>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct TechniqueLayerFile {
    layers: Vec<RawTechniqueLayer>,
}

#[derive(Debug, Deserialize)]
struct RawTechniqueLayer {
    technique_id: String,
    layer: i64,
    cost_spirit_stones: Option<i64>,
    cost_exp: Option<i64>,
    cost_materials: Option<Vec<RawTechniqueLayerCostMaterial>>,
    passives: Option<Vec<TechniquePassiveDto>>,
    unlock_skill_ids: Option<Vec<String>>,
    upgrade_skill_ids: Option<Vec<String>>,
    required_realm: Option<String>,
    required_quest_id: Option<String>,
    layer_desc: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawTechniqueLayerCostMaterial {
    #[serde(rename = "itemId", alias = "item_id")]
    item_id: String,
    qty: i64,
}

#[derive(Debug, Deserialize)]
struct SkillDefFile {
    skills: Vec<RawSkillDef>,
}

#[derive(Debug, Deserialize)]
struct RawSkillDef {
    id: String,
    code: Option<String>,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    source_type: Option<String>,
    source_id: Option<String>,
    cost_lingqi: Option<i64>,
    cost_lingqi_rate: Option<f64>,
    cost_qixue: Option<i64>,
    cost_qixue_rate: Option<f64>,
    cooldown: Option<i64>,
    target_type: Option<String>,
    target_count: Option<i64>,
    damage_type: Option<String>,
    element: Option<String>,
    effects: Option<Vec<serde_json::Value>>,
    trigger_type: Option<String>,
    conditions: Option<serde_json::Value>,
    ai_priority: Option<i64>,
    ai_conditions: Option<serde_json::Value>,
    upgrades: Option<Vec<serde_json::Value>>,
    sort_weight: Option<i64>,
    version: Option<i64>,
    enabled: Option<bool>,
}

pub async fn get_enabled_techniques(
    State(state): State<AppState>,
) -> Result<Json<SuccessResponse<TechniqueListData>>, AppError> {
    let mut techniques = load_technique_defs()?;
    techniques.extend(load_generated_visible_technique_defs(&state).await?);
    techniques.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| right.quality_rank.cmp(&left.quality_rank))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(send_success(TechniqueListData { techniques }))
}

pub async fn get_technique_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(technique_id): Path<String>,
) -> Result<Json<SuccessResponse<TechniqueDetailData>>, AppError> {
    let viewer_character_id = load_viewer_character_id(&state, &headers).await?;
    let detail =
        load_technique_detail_data(&state, technique_id.trim(), viewer_character_id, false)
            .await?
            .ok_or_else(|| AppError::not_found("未找到功法"))?;
    Ok(send_success(detail))
}

pub(crate) async fn load_technique_detail_data(
    state: &AppState,
    technique_id: &str,
    viewer_character_id: Option<i64>,
    allow_partner_only: bool,
) -> Result<Option<TechniqueDetailData>, AppError> {
    let technique_id = technique_id.trim();
    if technique_id.is_empty() {
        return Ok(None);
    }
    let techniques = load_technique_defs()?;
    let seed_technique = techniques
        .into_iter()
        .find(|technique| technique.id == technique_id);
    let generated_technique = if seed_technique.is_none() {
        load_generated_technique_def(state, technique_id, allow_partner_only).await?
    } else {
        None
    };
    let technique = seed_technique.clone().or(generated_technique.clone());
    let Some(technique) = technique else {
        return Ok(None);
    };
    let item_meta = load_item_meta_map()?;
    let mut layers = if generated_technique.is_some() {
        load_generated_technique_layers(state, technique.id.as_str(), &item_meta).await?
    } else {
        load_seed_technique_layers(technique.id.as_str(), &item_meta)?
    };
    let skills = if generated_technique.is_some() {
        load_generated_skill_defs(state, technique.id.as_str()).await?
    } else {
        load_seed_skill_defs(technique.id.as_str())?
    };
    if !allow_partner_only {
        let visibility = if can_character_view_technique_sensitive_layers(
            state,
            technique.id.as_str(),
            viewer_character_id,
        )
        .await?
        {
            TechniqueLayerVisibility::Learned
        } else {
            TechniqueLayerVisibility::Preview
        };
        layers = apply_technique_layer_visibility(layers, visibility);
    }
    layers.sort_by(|left, right| left.layer.cmp(&right.layer));
    Ok(Some(TechniqueDetailData {
        technique,
        layers,
        skills,
    }))
}

fn load_seed_technique_layers(
    technique_id: &str,
    item_meta: &BTreeMap<String, (String, Option<String>)>,
) -> Result<Vec<TechniqueLayerDto>, AppError> {
    Ok(load_technique_layers()?
        .into_iter()
        .filter(|layer| layer.technique_id == technique_id)
        .map(|layer| TechniqueLayerDto {
            technique_id: layer.technique_id,
            layer: layer.layer,
            cost_spirit_stones: layer.cost_spirit_stones.unwrap_or_default().max(0),
            cost_exp: layer.cost_exp.unwrap_or_default().max(0),
            cost_materials: layer
                .cost_materials
                .unwrap_or_default()
                .into_iter()
                .map(|cost| {
                    let meta = item_meta
                        .get(cost.item_id.trim())
                        .cloned()
                        .unwrap_or((cost.item_id.clone(), None));
                    TechniqueLayerCostMaterialDto {
                        item_id: cost.item_id,
                        qty: cost.qty.max(0),
                        item_name: Some(meta.0),
                        item_icon: meta.1,
                    }
                })
                .collect(),
            passives: layer.passives.unwrap_or_default(),
            unlock_skill_ids: layer.unlock_skill_ids.unwrap_or_default(),
            upgrade_skill_ids: layer.upgrade_skill_ids.unwrap_or_default(),
            required_realm: layer.required_realm,
            required_quest_id: layer.required_quest_id,
            layer_desc: layer.layer_desc,
        })
        .collect())
}

fn load_seed_skill_defs(technique_id: &str) -> Result<Vec<SkillDefDto>, AppError> {
    Ok(load_skill_defs()?
        .into_iter()
        .filter(|skill| skill.enabled)
        .filter(|skill| {
            skill.source_type == "technique" && skill.source_id.as_deref() == Some(technique_id)
        })
        .collect())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TechniqueLayerVisibility {
    Preview,
    Learned,
}

fn apply_technique_layer_visibility(
    layers: Vec<TechniqueLayerDto>,
    visibility: TechniqueLayerVisibility,
) -> Vec<TechniqueLayerDto> {
    if visibility == TechniqueLayerVisibility::Learned {
        return layers;
    }
    layers
        .into_iter()
        .map(|mut layer| {
            layer.cost_spirit_stones = 0;
            layer.cost_exp = 0;
            layer.cost_materials = Vec::new();
            layer.passives = Vec::new();
            layer.unlock_skill_ids = Vec::new();
            layer.upgrade_skill_ids = Vec::new();
            layer
        })
        .collect()
}

async fn load_viewer_character_id(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<i64>, AppError> {
    let Some(token) = auth::read_bearer_token(headers) else {
        return Ok(None);
    };
    let Ok(claims) = auth::verify_token(token, &state.config.service.jwt_secret) else {
        return Ok(None);
    };
    auth::get_character_id_by_user_id(state, claims.id).await
}

async fn can_character_view_technique_sensitive_layers(
    state: &AppState,
    technique_id: &str,
    viewer_character_id: Option<i64>,
) -> Result<bool, AppError> {
    let Some(character_id) = viewer_character_id.filter(|value| *value > 0) else {
        return Ok(false);
    };
    let row = state.database.fetch_optional(
        "SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
        |q| q.bind(character_id).bind(technique_id),
    ).await?;
    Ok(row.is_some())
}

async fn load_generated_technique_layers(
    state: &AppState,
    technique_id: &str,
    item_meta: &BTreeMap<String, (String, Option<String>)>,
) -> Result<Vec<TechniqueLayerDto>, AppError> {
    let quality_multiplier = load_generated_technique_cost_multiplier(state, technique_id).await?;
    let rows = state.database.fetch_all(
        "SELECT layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, required_quest_id, layer_desc FROM generated_technique_layer WHERE technique_id = $1 AND enabled = TRUE ORDER BY layer ASC",
        |q| q.bind(technique_id),
    ).await?;
    rows.into_iter()
        .map(|row| {
            let materials = row
                .try_get::<Option<serde_json::Value>, _>("cost_materials")?
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| {
                    let item_id = value
                        .get("itemId")
                        .and_then(|v| v.as_str())
                        .or_else(|| value.get("item_id").and_then(|v| v.as_str()))?
                        .to_string();
                    let qty = value.get("qty").and_then(|v| v.as_i64())?;
                    let meta = item_meta
                        .get(item_id.trim())
                        .cloned()
                        .unwrap_or((item_id.clone(), None));
                    Some(TechniqueLayerCostMaterialDto {
                        item_id,
                        qty: qty.max(0),
                        item_name: Some(meta.0),
                        item_icon: meta.1,
                    })
                })
                .collect();
            let passives = row
                .try_get::<Option<serde_json::Value>, _>("passives")?
                .and_then(|value| serde_json::from_value::<Vec<TechniquePassiveDto>>(value).ok())
                .unwrap_or_default();
            let unlock_skill_ids = row
                .try_get::<Vec<String>, _>("unlock_skill_ids")
                .unwrap_or_default();
            let upgrade_skill_ids = row
                .try_get::<Vec<String>, _>("upgrade_skill_ids")
                .unwrap_or_default();
            Ok(TechniqueLayerDto {
                technique_id: technique_id.to_string(),
                layer: row
                    .try_get::<Option<i32>, _>("layer")?
                    .map(i64::from)
                    .unwrap_or(1),
                cost_spirit_stones: scale_technique_base_cost_by_quality(
                    row.try_get::<Option<i32>, _>("cost_spirit_stones")?
                        .map(i64::from)
                        .unwrap_or_default(),
                    quality_multiplier,
                ),
                cost_exp: scale_technique_base_cost_by_quality(
                    row.try_get::<Option<i32>, _>("cost_exp")?
                        .map(i64::from)
                        .unwrap_or_default(),
                    quality_multiplier,
                ),
                cost_materials: materials,
                passives,
                unlock_skill_ids,
                upgrade_skill_ids,
                required_realm: row.try_get::<Option<String>, _>("required_realm")?,
                required_quest_id: row.try_get::<Option<String>, _>("required_quest_id")?,
                layer_desc: row.try_get::<Option<String>, _>("layer_desc")?,
            })
        })
        .collect()
}

async fn load_generated_skill_defs(
    state: &AppState,
    technique_id: &str,
) -> Result<Vec<SkillDefDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT id, code, name, description, icon, source_type, source_id, cost_lingqi, cost_lingqi_rate::double precision AS cost_lingqi_rate, cost_qixue, cost_qixue_rate::double precision AS cost_qixue_rate, cooldown, target_type, target_count, damage_type, element, effects, trigger_type, conditions, ai_priority, ai_conditions, upgrades, sort_weight, version, enabled FROM generated_skill_def WHERE source_type = 'technique' AND source_id = $1 AND enabled = TRUE ORDER BY sort_weight DESC, id ASC",
        |q| q.bind(technique_id),
    ).await?;
    rows.into_iter()
        .map(|row| {
            let effects = row
                .try_get::<Option<serde_json::Value>, _>("effects")?
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let trigger_type = resolve_skill_trigger_type(
                row.try_get::<Option<String>, _>("trigger_type")?.as_deref(),
                &effects,
            );
            Ok(SkillDefDto {
                id: row.try_get::<String, _>("id")?,
                code: row.try_get::<Option<String>, _>("code")?,
                name: row.try_get::<String, _>("name")?,
                description: row.try_get::<Option<String>, _>("description")?,
                icon: row.try_get::<Option<String>, _>("icon")?,
                source_type: row
                    .try_get::<Option<String>, _>("source_type")?
                    .unwrap_or_else(|| "technique".to_string()),
                source_id: row.try_get::<Option<String>, _>("source_id")?,
                cost_lingqi: row
                    .try_get::<Option<i32>, _>("cost_lingqi")?
                    .map(i64::from)
                    .unwrap_or_default(),
                cost_lingqi_rate: row
                    .try_get::<Option<f64>, _>("cost_lingqi_rate")?
                    .unwrap_or_default(),
                cost_qixue: row
                    .try_get::<Option<i32>, _>("cost_qixue")?
                    .map(i64::from)
                    .unwrap_or_default(),
                cost_qixue_rate: row
                    .try_get::<Option<f64>, _>("cost_qixue_rate")?
                    .unwrap_or_default(),
                cooldown: normalize_generated_technique_skill_cooldown(
                    row.try_get::<Option<i32>, _>("cooldown")?.map(i64::from),
                    trigger_type.as_str(),
                ),
                target_type: row
                    .try_get::<Option<String>, _>("target_type")?
                    .unwrap_or_else(|| "single_enemy".to_string()),
                target_count: row
                    .try_get::<Option<i32>, _>("target_count")?
                    .map(i64::from)
                    .unwrap_or(1),
                damage_type: row.try_get::<Option<String>, _>("damage_type")?,
                element: row
                    .try_get::<Option<String>, _>("element")?
                    .unwrap_or_else(|| "none".to_string()),
                effects,
                trigger_type,
                conditions: row.try_get::<Option<serde_json::Value>, _>("conditions")?,
                ai_priority: row
                    .try_get::<Option<i32>, _>("ai_priority")?
                    .map(i64::from)
                    .unwrap_or(50),
                ai_conditions: row.try_get::<Option<serde_json::Value>, _>("ai_conditions")?,
                upgrades: Some(
                    row.try_get::<Option<serde_json::Value>, _>("upgrades")?
                        .and_then(|value| value.as_array().cloned())
                        .unwrap_or_default(),
                ),
                sort_weight: row
                    .try_get::<Option<i32>, _>("sort_weight")?
                    .map(i64::from)
                    .unwrap_or_default(),
                version: row
                    .try_get::<Option<i32>, _>("version")?
                    .map(i64::from)
                    .unwrap_or(1),
                enabled: row.try_get::<Option<bool>, _>("enabled")?.unwrap_or(true),
            })
        })
        .collect()
}

pub(crate) fn resolve_skill_trigger_type(
    trigger_type: Option<&str>,
    effects: &[serde_json::Value],
) -> String {
    let has_aura_effect = effects.iter().any(|effect| {
        let effect_type = effect
            .get("type")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or("");
        if effect_type != "buff" && effect_type != "debuff" {
            return false;
        }
        effect
            .get("buffKind")
            .and_then(|value| value.as_str())
            .map(str::trim)
            == Some("aura")
    });
    if has_aura_effect {
        return "passive".to_string();
    }
    match trigger_type.map(str::trim) {
        Some("active" | "passive" | "counter" | "chase") => {
            trigger_type.unwrap().trim().to_string()
        }
        _ => "active".to_string(),
    }
}

fn normalize_generated_technique_skill_cooldown(
    raw_cooldown: Option<i64>,
    trigger_type: &str,
) -> i64 {
    if trigger_type == "passive" {
        return 0;
    }
    raw_cooldown.unwrap_or(1).clamp(1, 6)
}

async fn load_generated_technique_def(
    state: &AppState,
    technique_id: &str,
    allow_partner_only: bool,
) -> Result<Option<TechniqueDefDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT COALESCE(display_name, name) AS display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, icon, version, enabled FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
        |q| q.bind(technique_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if !allow_partner_only
        && normalize_technique_usage_scope(
            row.try_get::<Option<String>, _>("usage_scope")?.as_deref(),
        ) == "partner_only"
    {
        return Ok(None);
    }
    let quality = row
        .try_get::<Option<String>, _>("quality")?
        .unwrap_or_else(|| "黄".to_string());
    let tags = row
        .try_get::<Option<serde_json::Value>, _>("tags")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(|item| item.to_string()))
        .collect();
    Ok(Some(TechniqueDefDto {
        id: technique_id.to_string(),
        code: None,
        name: row
            .try_get::<Option<String>, _>("display_name")?
            .unwrap_or_else(|| technique_id.to_string()),
        technique_type: row
            .try_get::<Option<String>, _>("type")?
            .unwrap_or_else(|| "功法".to_string()),
        quality_rank: quality_rank_from_name(Some(quality.as_str())),
        quality,
        max_layer: row
            .try_get::<Option<i32>, _>("max_layer")?
            .map(i64::from)
            .unwrap_or_default(),
        required_realm: row
            .try_get::<Option<String>, _>("required_realm")?
            .unwrap_or_else(|| "凡人".to_string()),
        attribute_type: row
            .try_get::<Option<String>, _>("attribute_type")?
            .unwrap_or_else(|| "physical".to_string()),
        attribute_element: row
            .try_get::<Option<String>, _>("attribute_element")?
            .unwrap_or_else(|| "none".to_string()),
        tags,
        description: row.try_get::<Option<String>, _>("description")?,
        long_desc: row.try_get::<Option<String>, _>("long_desc")?,
        icon: row.try_get::<Option<String>, _>("icon")?,
        obtain_type: Some("ai_generate".to_string()),
        obtain_hint: vec!["AI研修生成".to_string()],
        sort_weight: 100,
        version: row
            .try_get::<Option<i32>, _>("version")?
            .map(i64::from)
            .unwrap_or(1),
        enabled: row.try_get::<Option<bool>, _>("enabled")?.unwrap_or(true),
    }))
}

async fn load_generated_technique_cost_multiplier(
    state: &AppState,
    technique_id: &str,
) -> Result<i64, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT quality FROM generated_technique_def WHERE id = $1 LIMIT 1",
            |q| q.bind(technique_id),
        )
        .await?;
    Ok(resolve_technique_cost_multiplier_by_quality(
        row.as_ref()
            .and_then(|row| row.try_get::<Option<String>, _>("quality").ok().flatten())
            .as_deref(),
    ))
}

fn resolve_technique_cost_multiplier_by_quality(quality: Option<&str>) -> i64 {
    quality_rank_from_name(quality).max(1)
}

fn scale_technique_base_cost_by_quality(base_cost: i64, quality_multiplier: i64) -> i64 {
    base_cost.max(0) * quality_multiplier.max(1)
}

fn normalize_technique_usage_scope(usage_scope: Option<&str>) -> &'static str {
    match usage_scope.map(str::trim) {
        Some("partner_only") => "partner_only",
        _ => "character_only",
    }
}

fn load_technique_defs() -> Result<Vec<TechniqueDefDto>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: TechniqueDefFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_def.json: {error}"))
    })?;
    Ok(payload
        .techniques
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| {
            let quality_raw = row.quality.clone();
            TechniqueDefDto {
                id: row.id,
                code: row.code,
                name: row.name,
                technique_type: row.technique_type,
                quality: quality_raw.clone().unwrap_or_else(|| "黄".to_string()),
                quality_rank: quality_rank_from_name(quality_raw.as_deref()),
                max_layer: row.max_layer.unwrap_or_default().max(0),
                required_realm: row.required_realm.unwrap_or_else(|| "凡人".to_string()),
                attribute_type: row.attribute_type.unwrap_or_else(|| "physical".to_string()),
                attribute_element: row.attribute_element.unwrap_or_else(|| "none".to_string()),
                tags: row.tags.unwrap_or_default(),
                description: row.description,
                long_desc: row.long_desc,
                icon: row.icon,
                obtain_type: row.obtain_type,
                obtain_hint: row.obtain_hint.unwrap_or_default(),
                sort_weight: row.sort_weight.unwrap_or_default(),
                version: row.version.unwrap_or(1),
                enabled: row.enabled != Some(false),
            }
        })
        .collect())
}

async fn load_generated_visible_technique_defs(
    state: &AppState,
) -> Result<Vec<TechniqueDefDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT id, COALESCE(display_name, name) AS display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, tags, description, long_desc, icon, version, enabled FROM generated_technique_def WHERE is_published = TRUE AND enabled = TRUE AND COALESCE(usage_scope, 'character_only') <> 'partner_only' ORDER BY created_at DESC",
        |q| q,
    ).await?;
    rows.into_iter()
        .map(|row| {
            let quality = row
                .try_get::<Option<String>, _>("quality")?
                .unwrap_or_else(|| "黄".to_string());
            let tags = row
                .try_get::<Option<serde_json::Value>, _>("tags")?
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(|item| item.to_string()))
                .collect();
            Ok(TechniqueDefDto {
                id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
                code: None,
                name: row
                    .try_get::<Option<String>, _>("display_name")?
                    .unwrap_or_default(),
                technique_type: row
                    .try_get::<Option<String>, _>("type")?
                    .unwrap_or_else(|| "功法".to_string()),
                quality_rank: quality_rank_from_name(Some(quality.as_str())),
                quality,
                max_layer: row
                    .try_get::<Option<i32>, _>("max_layer")?
                    .map(i64::from)
                    .unwrap_or(1),
                required_realm: row
                    .try_get::<Option<String>, _>("required_realm")?
                    .unwrap_or_else(|| "凡人".to_string()),
                attribute_type: row
                    .try_get::<Option<String>, _>("attribute_type")?
                    .unwrap_or_else(|| "physical".to_string()),
                attribute_element: row
                    .try_get::<Option<String>, _>("attribute_element")?
                    .unwrap_or_else(|| "none".to_string()),
                tags,
                description: row.try_get::<Option<String>, _>("description")?,
                long_desc: row.try_get::<Option<String>, _>("long_desc")?,
                icon: row.try_get::<Option<String>, _>("icon")?,
                obtain_type: Some("ai_generate".to_string()),
                obtain_hint: vec!["AI研修生成".to_string()],
                sort_weight: 100,
                version: row
                    .try_get::<Option<i32>, _>("version")?
                    .map(i64::from)
                    .unwrap_or(1),
                enabled: row.try_get::<Option<bool>, _>("enabled")?.unwrap_or(true),
            })
        })
        .collect()
}

fn load_technique_layers() -> Result<Vec<RawTechniqueLayer>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_layer.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_layer.json: {error}")))?;
    let normalized_content = content.replace("\"itemId\"", "\"item_id\"");
    let payload: TechniqueLayerFile =
        serde_json::from_str(&normalized_content).map_err(|error| {
            AppError::config(format!(
                "failed to parse technique_layer.json [technique.rs]: {error}"
            ))
        })?;
    Ok(payload.layers)
}

fn load_skill_defs() -> Result<Vec<SkillDefDto>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/skill_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read skill_def.json: {error}")))?;
    let payload: SkillDefFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse skill_def.json: {error}")))?;
    Ok(payload
        .skills
        .into_iter()
        .map(|row| SkillDefDto {
            id: row.id,
            code: row.code,
            name: row.name,
            description: row.description,
            icon: row.icon,
            source_type: row.source_type.unwrap_or_else(|| "unknown".to_string()),
            source_id: row.source_id,
            cost_lingqi: row.cost_lingqi.unwrap_or_default(),
            cost_lingqi_rate: row.cost_lingqi_rate.unwrap_or_default(),
            cost_qixue: row.cost_qixue.unwrap_or_default(),
            cost_qixue_rate: row.cost_qixue_rate.unwrap_or_default(),
            cooldown: row.cooldown.unwrap_or_default(),
            target_type: row
                .target_type
                .unwrap_or_else(|| "single_enemy".to_string()),
            target_count: row.target_count.unwrap_or(1),
            damage_type: row.damage_type,
            element: row.element.unwrap_or_else(|| "none".to_string()),
            effects: row.effects.unwrap_or_default(),
            trigger_type: row.trigger_type.unwrap_or_else(|| "active".to_string()),
            conditions: row.conditions,
            ai_priority: row.ai_priority.unwrap_or_default(),
            ai_conditions: row.ai_conditions,
            upgrades: row.upgrades,
            sort_weight: row.sort_weight.unwrap_or_default(),
            version: row.version.unwrap_or(1),
            enabled: row.enabled != Some(false),
        })
        .collect())
}

fn load_item_meta_map() -> Result<BTreeMap<String, (String, Option<String>)>, AppError> {
    let mut out = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../server/src/data/seeds/{filename}")),
        )
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        let items = payload
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        for item in items {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let name = item
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let icon = item
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            out.insert(id, (name, icon));
        }
    }
    Ok(out)
}

fn quality_rank_from_name(raw: Option<&str>) -> i64 {
    match raw.unwrap_or_default().trim() {
        "黄" => 1,
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn technique_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"techniques": [{"id": "tech-yangqi-jue", "name": "养气诀", "type": "心法"}]}
        });
        assert_eq!(payload["data"]["techniques"][0]["type"], "心法");
        println!("TECHNIQUE_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn technique_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "technique": {"id": "tech-yangqi-jue", "name": "养气诀", "type": "心法"},
                "layers": [{"technique_id": "tech-yangqi-jue", "layer": 1, "cost_spirit_stones": 100, "cost_exp": 50, "cost_materials": [], "passives": [], "unlock_skill_ids": [], "upgrade_skill_ids": []}],
                "skills": [{"id": "skill-普通攻击", "name": "普通攻击", "source_type": "innate", "target_type": "single_enemy", "element": "none", "effects": [], "trigger_type": "active", "ai_priority": 10, "enabled": true}]
            }
        });
        assert_eq!(payload["data"]["technique"]["id"], "tech-yangqi-jue");
        assert_eq!(
            payload["data"]["layers"][0]["technique_id"],
            "tech-yangqi-jue"
        );
        println!("TECHNIQUE_DETAIL_RESPONSE={}", payload);
    }
}
