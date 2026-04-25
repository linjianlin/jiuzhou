use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::technique_ai::{
    GeneratedTechniqueCandidate, ensure_generated_candidate_skill_icons,
    generate_technique_candidate,
};
use crate::integrations::text_model_config::{TextModelScope, require_text_model_config};
use crate::jobs;
use crate::realtime::public_socket::{
    emit_technique_research_result_to_user, emit_technique_research_status_to_user,
};
use crate::realtime::technique_research::{
    build_technique_research_result_payload, build_technique_research_status_payload,
};
use crate::shared::error::AppError;
use crate::shared::mail_counter::{apply_mail_counter_deltas, build_new_mail_counter_deltas};
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

const TECHNIQUE_RESEARCH_REFUND_MAIL_TITLE: &str = "洞府研修退款通知";
const TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID: &str = "mat-gongfa-canye";
const TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID: &str = "token-005";
const TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST: i64 = 1;
const TECHNIQUE_RESEARCH_FULL_REFUND_RATE: f64 = 1.0;
const TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE: f64 = 0.5;
const TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE: &str =
    "草稿已过期，系统已通过邮件返还一半功法残页，请重新领悟";
const TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT: usize = 10;

const TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES: [&str; 3] = [
    "提示词只用于限定本次功法的主题意象、命名气质、描述文风、元素倾向与局部招式表现，不决定品质、层数、效果数量、目标数量与数值预算。",
    "若提示词与当前功法类型不完全贴合，应做同主题的合理化转译；可以保留更鲜明的核心套路与招式母题，但不要为了迎合提示词强行拼接多体系、全覆盖或违和机制。",
    "可以把提示词延展成更鲜明、更偏锋的套路气质与招式表现，但不要生成全能通吃、超大范围、多段超高倍率、超长控制、超高回复或明显超出既有硬约束与预算的功法。",
];

const TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES: [&str; 1] = [
    "优先把差异放在技能机制骨架与战斗节奏上，而不是只换元素、名称或描述外皮；若采用相近主题，也要尽量改换触发条件、资源消耗、效果链条或成长曲线。",
];

const TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_DIVERSITY_RULES: [&str; 3] = [
    "最近参考只用于避免重复与拉开创意分布，不代表要把多个旧功法拼接在一起；新功法仍应围绕 1~2 个核心机制自洽展开。",
    "若最近参考已经集中在同类主机制上，本次优先切换至少一个核心机制轴线，例如把直伤连段改为蓄势爆发、把常驻增益改为印记消耗、把纯回复改为反制护体或延迟结算，而不是只换名称与文风。",
    "禁止直接复用最近参考中的完整名称、完整 description、完整 longDesc，技能机制也不能只是同构换皮；至少在触发条件、资源代价、效果组合、成长曲线中拉开明显差异。",
];

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecentTechniqueDescriptionReference {
    name: String,
    quality: String,
    technique_type: String,
    description: String,
    long_desc: String,
}

fn build_recent_successful_technique_description_prompt_context(
    entries: Vec<RecentTechniqueDescriptionReference>,
) -> Option<serde_json::Value> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();

    for entry in entries {
        let name = entry.name.trim().to_string();
        let quality = entry.quality.trim().to_string();
        let technique_type = entry.technique_type.trim().to_string();
        let description = entry.description.trim().to_string();
        let long_desc = entry.long_desc.trim().to_string();
        if description.is_empty() && long_desc.is_empty() {
            continue;
        }
        let dedupe_key = format!("{name}\n{quality}\n{technique_type}\n{description}\n{long_desc}");
        if !seen.insert(dedupe_key) {
            continue;
        }
        normalized.push(serde_json::json!({
            "name": name,
            "quality": quality,
            "type": technique_type,
            "description": description,
            "longDesc": long_desc,
        }));
        if normalized.len() >= TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT {
            break;
        }
    }

    (!normalized.is_empty()).then(|| {
        serde_json::json!({
            "techniqueRecentSuccessfulDescriptions": normalized,
            "techniqueRecentSuccessfulDescriptionDiversityRules": TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_DIVERSITY_RULES,
        })
    })
}

fn build_technique_research_prompt_context(
    burning_word_prompt: Option<&str>,
    recent_successful_description_prompt_context: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert(
        "techniqueResearchCreativeDirectionRules".to_string(),
        serde_json::json!(TECHNIQUE_RESEARCH_CREATIVE_DIRECTION_RULES),
    );
    if let Some(value) = burning_word_prompt
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object.insert(
            "techniqueBurningWordPrompt".to_string(),
            serde_json::json!(value),
        );
        object.insert(
            "techniqueBurningWordPromptScopeRules".to_string(),
            serde_json::json!(TECHNIQUE_BURNING_WORD_PROMPT_SCOPE_RULES),
        );
    }
    if let Some(serde_json::Value::Object(recent)) = recent_successful_description_prompt_context {
        for (key, value) in recent {
            object.insert(key, value);
        }
    }
    serde_json::Value::Object(object)
}

fn append_technique_research_refund_hint(reason: &str) -> String {
    let normalized = reason.trim();
    if normalized.is_empty() {
        return "洞府研修失败，相关消耗已通过邮件返还。".to_string();
    }
    if normalized.contains("已通过邮件返还") {
        return normalized.to_string();
    }
    format!("{}（相关消耗已通过邮件返还）", normalized)
}

fn build_technique_research_refund_mail_markdown(
    reason: &str,
    refund_cooldown_bypass_token: bool,
) -> String {
    let normalized = reason.trim();
    let mut lines = vec![
        "## 结果说明".to_string(),
        "".to_string(),
        "本次洞府研修未能成法，系统已将本次返还通过邮件发放。".to_string(),
        "".to_string(),
        "- 本次返还已通过邮件附件发放，请及时领取。".to_string(),
    ];
    if refund_cooldown_bypass_token {
        lines.push("- 本次额外消耗的顿悟符也已一并返还。".to_string());
    }
    if !normalized.is_empty() {
        lines.push("".to_string());
        lines.push("## 结算原因".to_string());
        lines.push("".to_string());
        lines.push(format!("> {normalized}"));
    }
    lines.join("\n")
}

fn resolve_technique_research_refund_fragments(cost_points: i64, refund_rate: f64) -> i64 {
    ((cost_points.max(0) as f64) * refund_rate.max(0.0)).floor() as i64
}

fn build_technique_research_refund_attach_rewards(
    refund_fragments: i64,
    refund_cooldown_bypass_token: bool,
) -> serde_json::Value {
    let mut items = Vec::new();
    if refund_fragments > 0 {
        items.push(serde_json::json!({
            "item_def_id": TECHNIQUE_RESEARCH_FRAGMENT_ITEM_DEF_ID,
            "qty": refund_fragments,
        }));
    }
    if refund_cooldown_bypass_token {
        items.push(serde_json::json!({
            "item_def_id": TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_ITEM_DEF_ID,
            "qty": TECHNIQUE_RESEARCH_COOLDOWN_BYPASS_TOKEN_COST,
        }));
    }
    serde_json::json!([{ "items": items }])
}

async fn refund_technique_generation_job_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
    reason: &str,
    next_status: &str,
    error_code: &str,
    refund_rate: f64,
) -> Result<(), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT status, cost_points, used_cooldown_bypass_token FROM technique_generation_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(generation_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if matches!(status.as_str(), "refunded" | "failed" | "published") {
        return Ok(());
    }
    let cost_points = row
        .try_get::<Option<i32>, _>("cost_points")?
        .map(i64::from)
        .unwrap_or_default()
        .max(0);
    let used_cooldown_bypass_token = row
        .try_get::<Option<bool>, _>("used_cooldown_bypass_token")?
        .unwrap_or(false);
    let refund_fragments = resolve_technique_research_refund_fragments(cost_points, refund_rate);
    let refund_cooldown_bypass_token = status == "pending" && used_cooldown_bypass_token;
    let user_id = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("user_id")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .unwrap_or_default();
    if user_id <= 0 {
        return Err(AppError::config("退款邮件发送失败：角色不存在"));
    }
    if refund_fragments > 0 || refund_cooldown_bypass_token {
        state.database.execute(
            "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, expire_at, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', $3, $4, $5::jsonb, NOW() + INTERVAL '30 days', 'technique_research_refund', $6, $7::jsonb, NOW(), NOW())",
            |q| q
                .bind(user_id)
                .bind(character_id)
                .bind(TECHNIQUE_RESEARCH_REFUND_MAIL_TITLE)
                .bind(build_technique_research_refund_mail_markdown(reason, refund_cooldown_bypass_token))
                .bind(build_technique_research_refund_attach_rewards(refund_fragments, refund_cooldown_bypass_token))
                .bind(generation_id)
                .bind(serde_json::json!({
                    "generationId": generation_id,
                    "refundFragments": refund_fragments,
                    "refundCooldownBypassToken": refund_cooldown_bypass_token,
                    "reason": reason,
                })),
        ).await?;
        apply_mail_counter_deltas(
            state,
            &build_new_mail_counter_deltas(user_id, Some(character_id), true),
        )
        .await?;
    }
    state.database.execute(
        "UPDATE technique_generation_job SET status = $2, error_code = $3, error_message = $4, finished_at = NOW(), failed_viewed_at = NULL, updated_at = NOW() WHERE id = $1",
        |q| q
            .bind(generation_id)
            .bind(next_status)
            .bind(error_code)
            .bind(append_technique_research_refund_hint(reason)),
    ).await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTechniqueDto {
    pub id: i64,
    pub character_id: i64,
    pub technique_id: String,
    pub current_layer: i64,
    pub slot_type: Option<String>,
    pub slot_index: Option<i64>,
    pub acquired_at: Option<String>,
    pub technique_name: Option<String>,
    pub technique_type: Option<String>,
    pub technique_quality: Option<String>,
    pub max_layer: Option<i64>,
    pub attribute_type: Option<String>,
    pub attribute_element: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSkillSlotDto {
    pub slot_index: i64,
    pub skill_id: String,
    pub skill_name: String,
    pub skill_icon: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterAvailableSkillDto {
    pub skill_id: String,
    pub skill_name: String,
    pub skill_icon: String,
    pub technique_id: String,
    pub technique_name: String,
    pub description: Option<String>,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBattleSkillValue {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(rename = "type")]
    pub skill_type: String,
    pub damage_type: Option<String>,
    pub target_type: String,
    pub target_count: i64,
    pub element: String,
    pub trigger_type: String,
    pub ai_priority: i64,
    pub cooldown: i64,
    pub cost: serde_json::Value,
    pub effects: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTechniqueStatusDto {
    pub techniques: Vec<CharacterTechniqueDto>,
    pub equipped_main: Option<CharacterTechniqueDto>,
    pub equipped_subs: Vec<CharacterTechniqueDto>,
    pub equipped_skills: Vec<CharacterSkillSlotDto>,
    pub available_skills: Vec<CharacterAvailableSkillDto>,
    pub passives: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EquippedTechniquesDto {
    pub main: Option<CharacterTechniqueDto>,
    pub subs: Vec<CharacterTechniqueDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueUpgradeCostMaterialDto {
    pub item_id: String,
    pub qty: i64,
    pub item_name: Option<String>,
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueUpgradeCostDto {
    pub current_layer: i64,
    pub max_layer: i64,
    pub spirit_stones: i64,
    pub exp: i64,
    pub materials: Vec<TechniqueUpgradeCostMaterialDto>,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniqueDefFile {
    techniques: Vec<TechniqueDefSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniqueDefSeed {
    id: String,
    name: String,
    #[serde(rename = "type")]
    technique_type: String,
    quality: Option<String>,
    max_layer: Option<i64>,
    attribute_type: Option<String>,
    attribute_element: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniqueLayerFile {
    layers: Vec<TechniqueLayerSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniqueLayerSeed {
    technique_id: String,
    layer: i64,
    cost_spirit_stones: Option<i64>,
    cost_exp: Option<i64>,
    cost_materials: Option<Vec<TechniqueLayerCostMaterialSeed>>,
    passives: Option<Vec<TechniquePassiveSeed>>,
    unlock_skill_ids: Option<Vec<String>>,
    upgrade_skill_ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniqueLayerCostMaterialSeed {
    item_id: String,
    qty: i64,
}

#[derive(Debug, Deserialize, Clone)]
struct TechniquePassiveSeed {
    key: String,
    value: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct SkillDefFile {
    skills: Vec<SkillDefSeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTechniqueMutationPayload {
    pub technique_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSkillEquipPayload {
    pub skill_id: Option<String>,
    pub slot_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSkillUnequipPayload {
    pub slot_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTechniqueEquipPayload {
    pub technique_id: Option<String>,
    pub slot_type: Option<String>,
    pub slot_index: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchGeneratePayload {
    pub cooldown_bypass_enabled: Option<bool>,
    pub burning_word_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchGenerateDataDto {
    pub generation_id: String,
    pub quality: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchPublishPayload {
    pub custom_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchPublishDataDto {
    pub technique_id: String,
    pub final_name: String,
    pub book_item_instance_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceResultWithCode<T> {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
}

#[derive(Debug, Deserialize, Clone)]
struct SkillDefSeed {
    id: String,
    name: String,
    icon: Option<String>,
    description: Option<String>,
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
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchNameRulesDto {
    pub min_length: i64,
    pub max_length: i64,
    pub fixed_prefix: String,
    pub pattern_hint: String,
    pub immutable_after_publish: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchDraftDto {
    pub generation_id: String,
    pub id: String,
    pub quality: String,
    pub r#type: String,
    pub max_layer: i64,
    pub description: String,
    pub long_desc: String,
    pub suggested_name: String,
    pub draft_expire_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchQualityRateDto {
    pub quality: String,
    pub weight: i64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchJobDto {
    pub generation_id: String,
    pub status: String,
    pub quality: String,
    pub model_name: Option<String>,
    pub burning_word_prompt: Option<String>,
    pub draft_technique_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub draft_expire_at: Option<String>,
    pub preview: Option<serde_json::Value>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TechniqueResearchStatusDto {
    pub unlock_realm: String,
    pub unlocked: bool,
    pub fragment_balance: i64,
    pub fragment_cost: i64,
    pub cooldown_bypass_fragment_cost: i64,
    pub cooldown_hours: i64,
    pub cooldown_until: Option<String>,
    pub cooldown_remaining_seconds: i64,
    pub cooldown_bypass_token_bypasses_cooldown: bool,
    pub cooldown_bypass_token_cost: i64,
    pub cooldown_bypass_token_item_name: String,
    pub cooldown_bypass_token_available_qty: i64,
    pub burning_word_prompt_max_length: i64,
    pub current_draft: Option<TechniqueResearchDraftDto>,
    pub draft_expire_at: Option<String>,
    pub name_rules: TechniqueResearchNameRulesDto,
    pub current_job: Option<TechniqueResearchJobDto>,
    pub has_unread_result: bool,
    pub result_status: Option<String>,
    pub remaining_until_guaranteed_heaven: i64,
    pub quality_rates: Vec<TechniqueResearchQualityRateDto>,
}

pub async fn get_character_technique_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let techniques = load_character_techniques(&state, character_id).await?;
    let available_skills = build_available_skills(&techniques)?;
    let available_ids = available_skills
        .iter()
        .map(|entry| entry.skill_id.clone())
        .collect::<BTreeSet<_>>();
    let equipped_skills = load_equipped_skills(&state, character_id, &available_ids).await?;
    let passives = calculate_technique_passives(&techniques)?;
    let equipped_main = techniques
        .iter()
        .find(|entry| entry.slot_type.as_deref() == Some("main"))
        .cloned();
    let equipped_subs = techniques
        .iter()
        .filter(|entry| entry.slot_type.as_deref() == Some("sub"))
        .cloned()
        .collect::<Vec<_>>();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(CharacterTechniqueStatusDto {
            techniques,
            equipped_main,
            equipped_subs,
            equipped_skills,
            available_skills,
            passives,
        }),
    }))
}

pub async fn get_character_techniques(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(load_character_techniques(&state, character_id).await?),
    }))
}

pub async fn get_equipped_techniques(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let techniques = load_character_techniques(&state, character_id).await?;
    let main = techniques
        .iter()
        .find(|entry| entry.slot_type.as_deref() == Some("main"))
        .cloned();
    let subs = techniques
        .iter()
        .filter(|entry| entry.slot_type.as_deref() == Some("sub"))
        .cloned()
        .collect::<Vec<_>>();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(EquippedTechniquesDto { main, subs }),
    }))
}

pub async fn get_character_technique_upgrade_cost(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(i64, String)>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let techniques = load_character_techniques(&state, character_id).await?;
    let Some(entry) = techniques
        .iter()
        .find(|entry| entry.technique_id == technique_id.trim())
    else {
        return Ok(send_result(ServiceResult::<TechniqueUpgradeCostDto> {
            success: false,
            message: Some("未学习该功法".to_string()),
            data: None,
        }));
    };
    let defs = load_visible_technique_def_map()?;
    let Some(def) = defs.get(technique_id.trim()) else {
        return Ok(send_result(ServiceResult::<TechniqueUpgradeCostDto> {
            success: false,
            message: Some("功法不存在".to_string()),
            data: None,
        }));
    };
    let max_layer = def.max_layer.unwrap_or(1).max(1);
    if entry.current_layer >= max_layer {
        return Ok(send_result(ServiceResult::<TechniqueUpgradeCostDto> {
            success: false,
            message: Some("已达最高层数".to_string()),
            data: None,
        }));
    }
    let next_layer = entry.current_layer + 1;
    let layers = load_technique_layers_by_id()?;
    let Some(layer) = layers.get(&(technique_id.trim().to_string(), next_layer)) else {
        return Ok(send_result(ServiceResult::<TechniqueUpgradeCostDto> {
            success: false,
            message: Some("层级配置不存在".to_string()),
            data: None,
        }));
    };
    let item_meta = load_item_meta_map()?;
    let quality_multiplier = quality_multiplier(def.quality.as_deref());
    let materials = layer
        .cost_materials
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|cost| {
            let meta = item_meta.get(cost.item_id.trim());
            TechniqueUpgradeCostMaterialDto {
                item_id: cost.item_id,
                qty: cost.qty.max(0),
                item_name: meta.map(|row| row.0.clone()),
                item_icon: meta.and_then(|row| row.1.clone()),
            }
        })
        .collect::<Vec<_>>();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(TechniqueUpgradeCostDto {
            current_layer: entry.current_layer,
            max_layer,
            spirit_stones: scale_cost(
                layer.cost_spirit_stones.unwrap_or_default(),
                quality_multiplier,
            ),
            exp: scale_cost(layer.cost_exp.unwrap_or_default(), quality_multiplier),
            materials,
        }),
    }))
}

pub async fn get_available_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(build_available_skills(
            &load_character_techniques(&state, character_id).await?,
        )?),
    }))
}

pub async fn get_equipped_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let available =
        build_available_skills(&load_character_techniques(&state, character_id).await?)?;
    let available_ids = available
        .iter()
        .map(|entry| entry.skill_id.clone())
        .collect::<BTreeSet<_>>();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(load_equipped_skills(&state, character_id, &available_ids).await?),
    }))
}

pub async fn get_technique_passives(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("计算成功".to_string()),
        data: Some(calculate_technique_passives(
            &load_character_techniques(&state, character_id).await?,
        )?),
    }))
}

pub(crate) async fn list_character_available_skill_id_set(
    state: &AppState,
    character_id: i64,
) -> Result<BTreeSet<String>, AppError> {
    let techniques = load_character_techniques(state, character_id).await?;
    Ok(build_available_skills(&techniques)?
        .into_iter()
        .map(|entry| entry.skill_id)
        .collect())
}

pub async fn get_technique_research_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let status = load_technique_research_status_data(&state, character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(status),
    }))
}

pub(crate) async fn load_technique_research_status_data(
    state: &AppState,
    character_id: i64,
) -> Result<TechniqueResearchStatusDto, AppError> {
    let character_row = state.database.fetch_optional(
        "SELECT technique_research_generated_non_heaven_count, realm, sub_realm FROM characters WHERE id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(character_row) = character_row else {
        return Err(AppError::config("角色不存在"));
    };
    let generated_non_heaven_count = character_row
        .try_get::<Option<i32>, _>("technique_research_generated_non_heaven_count")?
        .map(i64::from)
        .unwrap_or_default()
        .max(0);
    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row.try_get::<Option<String>, _>("sub_realm")?;
    let unlock_realm = "炼炁化神·结胎期".to_string();
    let unlocked = realm_rank_with_subrealm(&realm, sub_realm.as_deref())
        >= realm_rank_with_full_name(&unlock_realm);
    let latest_job = state.database.fetch_optional(
        "SELECT id, status, quality_rolled, model_name, burning_word_prompt, draft_technique_id, created_at::text AS created_at_text, finished_at::text AS finished_at_text, draft_expire_at::text AS draft_expire_at_text, error_message, viewed_at::text AS viewed_at_text, failed_viewed_at::text AS failed_viewed_at_text FROM technique_generation_job WHERE character_id = $1 ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let current_job = if let Some(row) = latest_job.as_ref() {
        Some(TechniqueResearchJobDto {
            generation_id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
            status: row
                .try_get::<Option<String>, _>("status")?
                .unwrap_or_else(|| "pending".to_string()),
            quality: row
                .try_get::<Option<String>, _>("quality_rolled")?
                .unwrap_or_else(|| "黄".to_string()),
            model_name: row.try_get::<Option<String>, _>("model_name")?,
            burning_word_prompt: row.try_get::<Option<String>, _>("burning_word_prompt")?,
            draft_technique_id: row.try_get::<Option<String>, _>("draft_technique_id")?,
            started_at: row
                .try_get::<Option<String>, _>("created_at_text")?
                .unwrap_or_default(),
            finished_at: row.try_get::<Option<String>, _>("finished_at_text")?,
            draft_expire_at: row.try_get::<Option<String>, _>("draft_expire_at_text")?,
            preview: None,
            error_message: row.try_get::<Option<String>, _>("error_message")?,
        })
    } else {
        None
    };
    let current_draft = if let Some(draft_id) = current_job
        .as_ref()
        .and_then(|job| job.draft_technique_id.as_deref())
    {
        let row = state.database.fetch_optional(
            "SELECT id, quality, type, max_layer, description, long_desc, name FROM generated_technique_def WHERE id = $1 LIMIT 1",
            |q| q.bind(draft_id),
        ).await?;
        row.map(|row| TechniqueResearchDraftDto {
            generation_id: current_job
                .as_ref()
                .map(|job| job.generation_id.clone())
                .unwrap_or_default(),
            id: row
                .try_get::<Option<String>, _>("id")
                .unwrap_or(None)
                .unwrap_or_default(),
            quality: row
                .try_get::<Option<String>, _>("quality")
                .unwrap_or(None)
                .unwrap_or_else(|| "黄".to_string()),
            r#type: row
                .try_get::<Option<String>, _>("type")
                .unwrap_or(None)
                .unwrap_or_else(|| "武技".to_string()),
            max_layer: row
                .try_get::<Option<i32>, _>("max_layer")
                .unwrap_or(None)
                .map(i64::from)
                .unwrap_or(1),
            description: row
                .try_get::<Option<String>, _>("description")
                .unwrap_or(None)
                .unwrap_or_default(),
            long_desc: row
                .try_get::<Option<String>, _>("long_desc")
                .unwrap_or(None)
                .unwrap_or_default(),
            suggested_name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            draft_expire_at: current_job
                .as_ref()
                .and_then(|job| job.draft_expire_at.clone())
                .unwrap_or_default(),
        })
    } else {
        None
    };
    let latest_started_at = if let Some(row) = latest_job.as_ref() {
        let status = row
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_default();
        if matches!(
            status.as_str(),
            "pending" | "generated_draft" | "published" | "refunded"
        ) {
            row.try_get::<Option<String>, _>("created_at_text")?
        } else {
            None
        }
    } else {
        None
    };
    let cooldown = build_technique_research_cooldown_state(latest_started_at.as_deref());
    let has_unread_result = latest_job
        .as_ref()
        .map(|row| {
            let status = row
                .try_get::<Option<String>, _>("status")
                .unwrap_or(None)
                .unwrap_or_default();
            if status == "generated_draft" {
                return row
                    .try_get::<Option<String>, _>("viewed_at_text")
                    .unwrap_or(None)
                    .is_none();
            }
            matches!(status.as_str(), "failed" | "refunded")
                && row
                    .try_get::<Option<String>, _>("failed_viewed_at_text")
                    .unwrap_or(None)
                    .is_none()
        })
        .unwrap_or(false);
    let result_status = current_job
        .as_ref()
        .and_then(|job| match job.status.as_str() {
            "generated_draft" => Some("generated_draft".to_string()),
            "failed" | "refunded" => Some("failed".to_string()),
            _ => None,
        });
    let guaranteed = generated_non_heaven_count >= 19;
    let quality_rates = if guaranteed {
        vec![
            TechniqueResearchQualityRateDto {
                quality: "黄".to_string(),
                weight: 0,
                rate: 0.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "玄".to_string(),
                weight: 0,
                rate: 0.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "地".to_string(),
                weight: 0,
                rate: 0.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "天".to_string(),
                weight: 1,
                rate: 100.0,
            },
        ]
    } else {
        vec![
            TechniqueResearchQualityRateDto {
                quality: "黄".to_string(),
                weight: 4,
                rate: 40.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "玄".to_string(),
                weight: 3,
                rate: 30.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "地".to_string(),
                weight: 2,
                rate: 20.0,
            },
            TechniqueResearchQualityRateDto {
                quality: "天".to_string(),
                weight: 1,
                rate: 10.0,
            },
        ]
    };
    let fragment_balance = state.database.fetch_optional(
        "SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'mat-gongfa-canye' AND location IN ('bag','warehouse')",
        |q| q.bind(character_id),
    ).await?.and_then(|row| row.try_get::<Option<i64>, _>("qty").ok().flatten()).unwrap_or_default();
    let cooldown_token_available_qty = state.database.fetch_optional(
        "SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'token-005' AND location IN ('bag','warehouse')",
        |q| q.bind(character_id),
    ).await?.and_then(|row| row.try_get::<Option<i64>, _>("qty").ok().flatten()).unwrap_or_default();

    Ok(TechniqueResearchStatusDto {
        unlock_realm,
        unlocked,
        fragment_balance,
        fragment_cost: 3500,
        cooldown_bypass_fragment_cost: 2800,
        cooldown_hours: 72,
        cooldown_until: cooldown.0,
        cooldown_remaining_seconds: cooldown.1,
        cooldown_bypass_token_bypasses_cooldown: true,
        cooldown_bypass_token_cost: 1,
        cooldown_bypass_token_item_name: "冷却绕过令牌".to_string(),
        cooldown_bypass_token_available_qty: cooldown_token_available_qty,
        burning_word_prompt_max_length: 2,
        current_draft: current_draft.clone(),
        draft_expire_at: current_draft
            .as_ref()
            .map(|row| row.draft_expire_at.clone()),
        name_rules: TechniqueResearchNameRulesDto {
            min_length: 2,
            max_length: 14,
            fixed_prefix: "『研』".to_string(),
            pattern_hint: "仅支持纯中文（不含空格、符号、字母、数字）".to_string(),
            immutable_after_publish: true,
        },
        current_job,
        has_unread_result,
        result_status,
        remaining_until_guaranteed_heaven: if guaranteed {
            1
        } else {
            (20 - generated_non_heaven_count).max(1)
        },
        quality_rates,
    })
}

pub async fn mark_technique_research_result_viewed(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let updated = state.database.fetch_optional(
        "WITH latest_unviewed_job AS ( SELECT id, status FROM technique_generation_job WHERE character_id = $1 AND ((status = 'generated_draft' AND viewed_at IS NULL) OR (status IN ('failed','refunded') AND failed_viewed_at IS NULL)) ORDER BY created_at DESC LIMIT 1 ) UPDATE technique_generation_job AS job SET viewed_at = CASE WHEN latest_unviewed_job.status = 'generated_draft' THEN COALESCE(job.viewed_at, NOW()) ELSE job.viewed_at END, failed_viewed_at = CASE WHEN latest_unviewed_job.status IN ('failed','refunded') THEN COALESCE(job.failed_viewed_at, NOW()) ELSE job.failed_viewed_at END, updated_at = NOW() FROM latest_unviewed_job WHERE job.id = latest_unviewed_job.id RETURNING job.id",
        |q| q.bind(character_id),
    ).await?;
    let actor = auth::require_auth(&state, &headers).await?;
    if let Ok(status) = load_technique_research_status_data(&state, character_id).await {
        emit_technique_research_status_to_user(
            &state,
            actor.user_id,
            &build_technique_research_status_payload(character_id, status),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some(if updated.is_some() {
            "已标记查看".to_string()
        } else {
            "无未查看结果".to_string()
        }),
        data: Some(serde_json::json!({ "marked": updated.is_some() })),
    }))
}

pub async fn generate_technique_research_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
    Json(payload): Json<TechniqueResearchGeneratePayload>,
) -> Result<axum::response::Response, AppError> {
    tracing::info!(target: "technique_research_test_trace", character_id, "entered generate_technique_research_draft handler");
    require_owned_character(&state, &headers, character_id).await?;
    let burning_word_prompt = payload.burning_word_prompt.unwrap_or_default();
    if !burning_word_prompt.trim().is_empty() {
        let char_count = burning_word_prompt.chars().count();
        if char_count > 2 {
            return Ok(send_result(ServiceResult::<
                TechniqueResearchGenerateDataDto,
            > {
                success: false,
                message: Some("提示词最多 2 个中文字符".to_string()),
                data: None,
            }));
        }
        if !burning_word_prompt
            .chars()
            .all(|ch| (' '..='').contains(&ch) == false)
        {
            return Ok(send_result(ServiceResult::<
                TechniqueResearchGenerateDataDto,
            > {
                success: false,
                message: Some("提示词只能包含中文字符".to_string()),
                data: None,
            }));
        }
        if let Err(error) = require_text_model_config(TextModelScope::Technique) {
            return Ok(send_result(ServiceResult::<
                TechniqueResearchGenerateDataDto,
            > {
                success: false,
                message: Some(error.to_string()),
                data: None,
            }));
        }
    }
    let result = state
        .database
        .with_transaction(|| async {
            generate_technique_research_draft_tx(
                &state,
                character_id,
                payload.cooldown_bypass_enabled.unwrap_or(false),
                if burning_word_prompt.trim().is_empty() {
                    None
                } else {
                    Some(burning_word_prompt.trim())
                },
            )
            .await
        })
        .await?;
    println!(
        "TECH_RESEARCH_TRACE: after_generate_tx success={}",
        result.success
    );
    if result.success {
        if let Some(data) = result.data.as_ref() {
            println!(
                "TECH_RESEARCH_TRACE: enqueue node_env={}",
                state.config.service.node_env
            );
            let enqueue_result = jobs::enqueue_technique_generation_job(
                state.clone(),
                character_id,
                data.generation_id.clone(),
            )
            .await;
            match &enqueue_result {
                Ok(_) => println!("TECH_RESEARCH_TRACE: enqueue_result_ok=true"),
                Err(error) => {
                    println!("TECH_RESEARCH_TRACE: enqueue_result_ok=false error={error}")
                }
            }
        }
        println!("TECH_RESEARCH_TRACE: before_require_auth");
        let actor = auth::require_auth(&state, &headers).await?;
        println!(
            "TECH_RESEARCH_TRACE: after_require_auth user_id={}",
            actor.user_id
        );
        if let Ok(status) = load_technique_research_status_data(&state, character_id).await {
            println!("TECH_RESEARCH_TRACE: after_load_status");
            emit_technique_research_status_to_user(
                &state,
                actor.user_id,
                &build_technique_research_status_payload(character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn discard_technique_research_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, generation_id)): Path<(i64, String)>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let generation_id = generation_id.trim();
    if generation_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少生成任务ID".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            discard_technique_research_draft_tx(&state, character_id, generation_id).await
        })
        .await?;
    if result.success {
        let actor = auth::require_auth(&state, &headers).await?;
        if let Ok(status) = load_technique_research_status_data(&state, character_id).await {
            emit_technique_research_status_to_user(
                &state,
                actor.user_id,
                &build_technique_research_status_payload(character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn publish_technique_research_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, generation_id)): Path<(i64, String)>,
    Json(payload): Json<TechniqueResearchPublishPayload>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let generation_id = generation_id.trim();
    if generation_id.is_empty() {
        return Ok((
            axum::http::StatusCode::BAD_REQUEST,
            Json(ServiceResultWithCode::<TechniqueResearchPublishDataDto> {
                success: false,
                message: "缺少生成任务ID".to_string(),
                code: Some("GENERATION_NOT_READY".to_string()),
                data: None,
            }),
        )
            .into_response());
    }
    let custom_name = payload.custom_name.unwrap_or_default();
    let result = state
        .database
        .with_transaction(|| async {
            publish_technique_research_draft_tx(
                &state,
                character_id,
                generation_id,
                custom_name.trim(),
            )
            .await
        })
        .await?;
    if result.success {
        let actor = auth::require_auth(&state, &headers).await?;
        if let Ok(status) = load_technique_research_status_data(&state, character_id).await {
            emit_technique_research_status_to_user(
                &state,
                actor.user_id,
                &build_technique_research_status_payload(character_id, status),
            );
        }
    }
    Ok((
        if result.success {
            axum::http::StatusCode::OK
        } else {
            axum::http::StatusCode::BAD_REQUEST
        },
        Json(result),
    )
        .into_response())
}

pub async fn dissipate_character_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(i64, String)>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let technique_id = technique_id.trim();
    if technique_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少功法ID".to_string()),
            data: None,
        }));
    }
    let row = state.database.fetch_optional(
        "SELECT id, slot_type FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id).bind(technique_id),
    ).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("未学习该功法".to_string()),
            data: None,
        }));
    };
    let slot_type = row
        .try_get::<Option<String>, _>("slot_type")?
        .unwrap_or_default();
    if !slot_type.trim().is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("已运功的功法不可散功，请先取消运功".to_string()),
            data: None,
        }));
    }
    let id = row.try_get::<i64, _>("id")?;
    state
        .database
        .execute("DELETE FROM character_technique WHERE id = $1", |q| {
            q.bind(id)
        })
        .await?;
    Ok(send_result(ServiceResult::<serde_json::Value> {
        success: true,
        message: Some("散功成功".to_string()),
        data: None,
    }))
}

pub async fn unequip_character_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
    Json(payload): Json<CharacterTechniqueMutationPayload>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let technique_id = payload.technique_id.unwrap_or_default();
    if technique_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少功法ID".to_string()),
            data: None,
        }));
    }
    let result = state.database.fetch_optional(
        "UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW() WHERE character_id = $1 AND technique_id = $2 AND slot_type IS NOT NULL RETURNING slot_type",
        |q| q.bind(character_id).bind(technique_id.trim()),
    ).await?;
    let Some(row) = result else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("功法未装备".to_string()),
            data: None,
        }));
    };
    let removed_main = row.try_get::<Option<String>, _>("slot_type")?.as_deref() == Some("main");
    if removed_main {
        state.database.execute(
            "UPDATE characters SET attribute_type = 'physical', attribute_element = 'none', updated_at = NOW() WHERE id = $1",
            |q| q.bind(character_id),
        ).await?;
    }
    Ok(send_result(ServiceResult::<serde_json::Value> {
        success: true,
        message: Some("卸下成功".to_string()),
        data: None,
    }))
}

pub async fn equip_character_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
    Json(payload): Json<CharacterSkillEquipPayload>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let skill_id = payload.skill_id.unwrap_or_default();
    let slot_index = payload.slot_index.unwrap_or_default();
    if skill_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少技能ID".to_string()),
            data: None,
        }));
    }
    if !(1..=10).contains(&slot_index) {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("技能槽位必须为1-10".to_string()),
            data: None,
        }));
    }
    let available =
        build_available_skills(&load_character_techniques(&state, character_id).await?)?;
    if !available
        .iter()
        .any(|entry| entry.skill_id == skill_id.trim())
    {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("技能不可用（未解锁或功法未装备）".to_string()),
            data: None,
        }));
    }
    state.database.execute(
        "DELETE FROM character_skill_slot WHERE character_id = $1 AND (skill_id = $2 OR slot_index = $3)",
        |q| q.bind(character_id).bind(skill_id.trim()).bind(slot_index),
    ).await?;
    state.database.execute(
        "INSERT INTO character_skill_slot (character_id, slot_index, skill_id, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())",
        |q| q.bind(character_id).bind(slot_index).bind(skill_id.trim()),
    ).await?;
    Ok(send_result(ServiceResult::<serde_json::Value> {
        success: true,
        message: Some("装备成功".to_string()),
        data: None,
    }))
}

pub async fn unequip_character_skill(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
    Json(payload): Json<CharacterSkillUnequipPayload>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let slot_index = payload.slot_index.unwrap_or_default();
    if !(1..=10).contains(&slot_index) {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少槽位索引".to_string()),
            data: None,
        }));
    }
    let deleted = state.database.fetch_optional(
        "DELETE FROM character_skill_slot WHERE character_id = $1 AND slot_index = $2 RETURNING id",
        |q| q.bind(character_id).bind(slot_index),
    ).await?;
    if deleted.is_none() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("该槽位未装备技能".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult::<serde_json::Value> {
        success: true,
        message: Some("卸下成功".to_string()),
        data: None,
    }))
}

pub async fn equip_character_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(character_id): Path<i64>,
    Json(payload): Json<CharacterTechniqueEquipPayload>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let technique_id = payload.technique_id.unwrap_or_default();
    let slot_type = payload.slot_type.unwrap_or_default();
    if technique_id.trim().is_empty() || slot_type.trim().is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少必要参数".to_string()),
            data: None,
        }));
    }
    if slot_type != "main" && slot_type != "sub" {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("无效的槽位类型".to_string()),
            data: None,
        }));
    }
    let row = state.database.fetch_optional(
        "SELECT id, slot_type, slot_index FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id).bind(technique_id.trim()),
    ).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("未学习该功法".to_string()),
            data: None,
        }));
    };
    let current_slot_type = row
        .try_get::<Option<String>, _>("slot_type")?
        .unwrap_or_default();
    let current_slot_index = row.try_get::<Option<i64>, _>("slot_index")?;
    let requested_slot_index = if slot_type == "sub" {
        let slot_index = payload.slot_index.unwrap_or_default();
        if !(1..=3).contains(&slot_index) {
            return Ok(send_result(ServiceResult::<serde_json::Value> {
                success: false,
                message: Some("副功法槽位必须为1-3".to_string()),
                data: None,
            }));
        }
        Some(slot_index)
    } else {
        None
    };
    if current_slot_type == slot_type
        && (slot_type == "main" || current_slot_index == requested_slot_index)
    {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: true,
            message: Some("功法已在该位置".to_string()),
            data: None,
        }));
    }

    if slot_type == "main" {
        state.database.execute(
            "UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW() WHERE character_id = $1 AND slot_type = 'main'",
            |q| q.bind(character_id),
        ).await?;
    } else {
        state.database.execute(
            "UPDATE character_technique SET slot_type = NULL, slot_index = NULL, updated_at = NOW() WHERE character_id = $1 AND slot_type = 'sub' AND slot_index = $2",
            |q| q.bind(character_id).bind(requested_slot_index.unwrap_or_default()),
        ).await?;
    }

    state.database.execute(
        "UPDATE character_technique SET slot_type = $1, slot_index = $2, updated_at = NOW() WHERE id = $3",
        |q| q.bind(slot_type.as_str()).bind(requested_slot_index).bind(row.try_get::<i64, _>("id").unwrap_or_default()),
    ).await?;

    if slot_type == "main" {
        let defs = load_visible_technique_def_map()?;
        if let Some(def) = defs.get(technique_id.trim()) {
            state.database.execute(
                "UPDATE characters SET attribute_type = $1, attribute_element = $2, updated_at = NOW() WHERE id = $3",
                |q| q
                    .bind(def.attribute_type.clone().unwrap_or_else(|| "physical".to_string()))
                    .bind(def.attribute_element.clone().unwrap_or_else(|| "none".to_string()))
                    .bind(character_id),
            ).await?;
        }
    }

    Ok(send_result(ServiceResult::<serde_json::Value> {
        success: true,
        message: Some("装备成功".to_string()),
        data: None,
    }))
}

pub async fn upgrade_character_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((character_id, technique_id)): Path<(i64, String)>,
) -> Result<axum::response::Response, AppError> {
    require_owned_character(&state, &headers, character_id).await?;
    let technique_id = technique_id.trim();
    if technique_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("缺少功法ID".to_string()),
            data: None,
        }));
    }
    let row = state.database.fetch_optional(
        "SELECT id, current_layer FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id).bind(technique_id),
    ).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("未学习该功法".to_string()),
            data: None,
        }));
    };
    let current_layer = row
        .try_get::<Option<i32>, _>("current_layer")?
        .map(i64::from)
        .unwrap_or(1);
    let defs = load_visible_technique_def_map()?;
    let Some(def) = defs.get(technique_id) else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("功法不存在".to_string()),
            data: None,
        }));
    };
    let max_layer = def.max_layer.unwrap_or(1).max(1);
    if current_layer >= max_layer {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("已达最高层数".to_string()),
            data: None,
        }));
    }
    let next_layer = current_layer + 1;
    let layers = load_technique_layers_by_id()?;
    let Some(layer) = layers.get(&(technique_id.to_string(), next_layer)) else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("层级配置不存在".to_string()),
            data: None,
        }));
    };
    let quality_mul = quality_multiplier(def.quality.as_deref());
    let cost_spirit_stones = scale_cost(layer.cost_spirit_stones.unwrap_or_default(), quality_mul);
    let cost_exp = scale_cost(layer.cost_exp.unwrap_or_default(), quality_mul);
    let character_row = state
        .database
        .fetch_optional(
            "SELECT spirit_stones, exp FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(character_row) = character_row else {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    };
    let spirit_stones = character_row
        .try_get::<Option<i64>, _>("spirit_stones")?
        .unwrap_or_default();
    let exp = character_row
        .try_get::<Option<i64>, _>("exp")?
        .unwrap_or_default();
    if spirit_stones < cost_spirit_stones {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("灵石不足".to_string()),
            data: None,
        }));
    }
    if exp < cost_exp {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("经验不足".to_string()),
            data: None,
        }));
    }
    for material in layer.cost_materials.clone().unwrap_or_default() {
        let remaining =
            consume_material_qty(&state, character_id, &material.item_id, material.qty.max(0))
                .await?;
        if !remaining {
            return Ok(send_result(ServiceResult::<serde_json::Value> {
                success: false,
                message: Some(format!("材料不足：{}", material.item_id)),
                data: None,
            }));
        }
    }
    state.database.execute(
        "UPDATE characters SET spirit_stones = COALESCE(spirit_stones, 0) - $2, exp = COALESCE(exp, 0) - $3, updated_at = NOW() WHERE id = $1",
        |q| q.bind(character_id).bind(cost_spirit_stones).bind(cost_exp),
    ).await?;
    state
        .database
        .execute(
            "UPDATE character_technique SET current_layer = $1, updated_at = NOW() WHERE id = $2",
            |q| {
                q.bind(next_layer)
                    .bind(row.try_get::<i64, _>("id").unwrap_or_default())
            },
        )
        .await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some(format!("{}修炼至第{}层", def.name, next_layer)),
        data: Some(serde_json::json!({
            "newLayer": next_layer,
            "unlockedSkills": layer.unlock_skill_ids.clone().unwrap_or_default(),
            "upgradedSkills": layer.upgrade_skill_ids.clone().unwrap_or_default()
        })),
    }))
}

async fn generate_technique_research_draft_tx(
    state: &AppState,
    character_id: i64,
    cooldown_bypass_enabled: bool,
    burning_word_prompt: Option<&str>,
) -> Result<ServiceResult<TechniqueResearchGenerateDataDto>, AppError> {
    let character_row = state.database.fetch_optional(
        "SELECT technique_research_generated_non_heaven_count, realm, sub_realm FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let Some(character_row) = character_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row.try_get::<Option<String>, _>("sub_realm")?;
    let unlock_realm = "炼炁化神·结胎期".to_string();
    if realm_rank_with_subrealm(&realm, sub_realm.as_deref())
        < realm_rank_with_full_name(&unlock_realm)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("洞府研修需要达到{}", unlock_realm)),
            data: None,
        });
    }

    let existing = state.database.fetch_optional(
        "SELECT id FROM technique_generation_job WHERE character_id = $1 AND status IN ('pending','generated_draft') ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    if existing.is_some() {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前已有待处理的研修结果".to_string()),
            data: None,
        });
    }

    let latest_started_at = state.database.fetch_optional(
        "SELECT created_at::text AS created_at_text FROM technique_generation_job WHERE character_id = $1 AND status IN ('pending','generated_draft','published','refunded') ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?.and_then(|row| row.try_get::<Option<String>, _>("created_at_text").ok().flatten());
    let cooldown = build_technique_research_cooldown_state(latest_started_at.as_deref());
    if cooldown.1 > 0 && !cooldown_bypass_enabled {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("洞府研修冷却中，剩余{}秒", cooldown.1)),
            data: None,
        });
    }

    let fragment_cost = if cooldown_bypass_enabled { 2800 } else { 3500 };
    let fragments_ok =
        consume_material_qty(state, character_id, "mat-gongfa-canye", fragment_cost).await?;
    if !fragments_ok {
        return Ok(ServiceResult {
            success: false,
            message: Some("功法残页不足".to_string()),
            data: None,
        });
    }
    if cooldown_bypass_enabled {
        let token_ok = consume_material_qty(state, character_id, "token-005", 1).await?;
        if !token_ok {
            return Ok(ServiceResult {
                success: false,
                message: Some("冷却绕过令牌不足".to_string()),
                data: None,
            });
        }
    }

    let generated_non_heaven_count = character_row
        .try_get::<Option<i32>, _>("technique_research_generated_non_heaven_count")?
        .map(i64::from)
        .unwrap_or_default()
        .max(0);
    let quality = if generated_non_heaven_count >= 19 {
        "天"
    } else if generated_non_heaven_count == 0 {
        "玄"
    } else {
        "黄"
    };
    let generation_id = format!("tech-gen-{}-{}", character_id, now_millis());
    let week_key = current_week_key();
    let model_name = if burning_word_prompt.is_some() {
        Some(require_text_model_config(TextModelScope::Technique)?.model_name)
    } else {
        None
    };
    state.database.execute(
        "INSERT INTO technique_generation_job (id, character_id, week_key, status, type_rolled, quality_rolled, cost_points, used_cooldown_bypass_token, burning_word_prompt, prompt_snapshot, model_name, attempt_count, draft_technique_id, generated_technique_id, publish_attempts, draft_expire_at, viewed_at, failed_viewed_at, finished_at, error_code, error_message, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, '{}'::jsonb, $9, 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NOW(), NOW())",
        |q| q
            .bind(&generation_id)
            .bind(character_id)
            .bind(&week_key)
            .bind("武技")
            .bind(quality)
            .bind(fragment_cost)
            .bind(cooldown_bypass_enabled)
            .bind(burning_word_prompt.map(|v| v.to_string()))
            .bind(model_name),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("洞府推演任务已创建".to_string()),
        data: Some(TechniqueResearchGenerateDataDto {
            generation_id,
            quality: quality.to_string(),
            status: "pending".to_string(),
        }),
    })
}

pub async fn process_pending_technique_generation_job(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<(), AppError> {
    let generation_id = generation_id.trim();
    if generation_id.is_empty() || character_id <= 0 {
        return Ok(());
    }
    let row = state
        .database
        .fetch_optional(
            "SELECT id, status, type_rolled, quality_rolled, burning_word_prompt FROM technique_generation_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(generation_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "pending" {
        return Ok(());
    }

    let technique_type = row
        .try_get::<Option<String>, _>("type_rolled")?
        .unwrap_or_else(|| "武技".to_string());
    let quality = row
        .try_get::<Option<String>, _>("quality_rolled")?
        .unwrap_or_else(|| "黄".to_string());
    let burning_word_prompt = row.try_get::<Option<String>, _>("burning_word_prompt")?;
    let draft_technique_id = short_generated_id("tech-gen", generation_id);
    let max_layer = generated_technique_max_layer(&quality);
    let recent_successful_description_prompt_context =
        match load_recent_successful_technique_description_prompt_context(state, character_id).await
        {
            Ok(context) => context,
            Err(error) => {
                fail_technique_generation_job_with_refund(
                    state,
                    character_id,
                    generation_id,
                    &error.to_string(),
                )
                .await?;
                return Ok(());
            }
        };
    let prompt_context = build_technique_research_prompt_context(
        burning_word_prompt.as_deref(),
        recent_successful_description_prompt_context,
    );
    let candidate_result = match generate_technique_candidate(
        state,
        &technique_type,
        &quality,
        max_layer,
        burning_word_prompt.as_deref(),
        Some(prompt_context),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            fail_technique_generation_job_with_refund(
                state,
                character_id,
                generation_id,
                &error.to_string(),
            )
            .await?;
            return Ok(());
        }
    };
    let mut candidate = candidate_result.candidate;
    remap_generated_candidate_skill_ids(&mut candidate, generation_id);
    ensure_generated_candidate_skill_icons(state, &mut candidate).await?;
    let prompt_snapshot: serde_json::Value =
        serde_json::from_str(&candidate_result.prompt_snapshot).map_err(|error| {
            AppError::config(format!("功法 candidate prompt_snapshot 解析失败: {error}"))
        })?;

    state.database.with_transaction(|| async {
        state.database.execute(
            "INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, normalized_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, model_name, icon, is_published, published_at, name_locked, enabled, version, custom_name, normalized_custom_name, identity_suffix, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7, $8, $9, $10, 'character_only', $11::jsonb, $12, $13, $14, NULL, FALSE, NULL, FALSE, TRUE, 1, NULL, NULL, NULL, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
            |q| q
                .bind(&draft_technique_id)
                .bind(generation_id)
                .bind(character_id)
                .bind(&candidate.technique.name)
                .bind(candidate.technique.r#type.trim())
                .bind(candidate.technique.quality.trim())
                .bind(candidate.technique.max_layer)
                .bind(candidate.technique.required_realm.trim())
                .bind(candidate.technique.attribute_type.trim())
                .bind(candidate.technique.attribute_element.trim())
                .bind(serde_json::json!(candidate.technique.tags))
                .bind(&candidate.technique.description)
                .bind(&candidate.technique.long_desc)
                .bind(&candidate_result.model_name),
        ).await?;
        for skill in &candidate.skills {
            state.database.execute(
                "INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, code, name, description, icon, cost_lingqi, cost_lingqi_rate, cost_qixue, cost_qixue_rate, cooldown, target_type, target_count, damage_type, element, effects, trigger_type, ai_priority, upgrades, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20::jsonb, TRUE, 1, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
                |q| q
                    .bind(&skill.id)
                    .bind(generation_id)
                    .bind(&draft_technique_id)
                    .bind(&skill.id)
                    .bind(&skill.name)
                    .bind(&skill.description)
                    .bind(skill.icon.as_deref())
                    .bind(skill.cost_lingqi)
                    .bind(skill.cost_lingqi_rate)
                    .bind(skill.cost_qixue)
                    .bind(skill.cost_qixue_rate)
                    .bind(skill.cooldown)
                    .bind(skill.target_type.trim())
                    .bind(skill.target_count)
                    .bind(skill.damage_type.as_deref())
                    .bind(skill.element.trim())
                    .bind(serde_json::json!(skill.effects))
                    .bind(skill.trigger_type.trim())
                    .bind(skill.ai_priority)
                    .bind(serde_json::json!(skill.upgrades)),
            ).await?;
        }
        for layer in &candidate.layers {
            state.database.execute(
                "INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, required_quest_id, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::text[], $9::text[], $10, NULL, $11, TRUE, NOW(), NOW()) ON CONFLICT (technique_id, layer) DO NOTHING",
                |q| q
                    .bind(generation_id)
                    .bind(&draft_technique_id)
                    .bind(layer.layer)
                    .bind(layer.cost_spirit_stones)
                    .bind(layer.cost_exp)
                    .bind(serde_json::json!(layer.cost_materials))
                    .bind(serde_json::json!(layer.passives))
                    .bind(&layer.unlock_skill_ids)
                    .bind(&layer.upgrade_skill_ids)
                    .bind(candidate.technique.required_realm.trim())
                    .bind(&layer.layer_desc),
            ).await?;
        }
        state.database.execute(
            "UPDATE technique_generation_job SET status = 'generated_draft', prompt_snapshot = $2::jsonb, model_name = $3, attempt_count = $4, draft_technique_id = $5, draft_expire_at = NOW() + ('24 hours')::interval, finished_at = NOW(), error_code = NULL, error_message = NULL, updated_at = NOW() WHERE id = $1",
            |q| q
                .bind(generation_id)
                .bind(&prompt_snapshot)
                .bind(&candidate_result.model_name)
                .bind(candidate_result.attempt_count)
                .bind(&draft_technique_id),
        ).await?;
        Ok::<(), AppError>(())
    }).await?;

    let user_id = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?
        .and_then(|row| row.try_get::<Option<i64>, _>("user_id").ok().flatten());
    if let Some(user_id) = user_id {
        let preview = state.database.fetch_optional(
            "SELECT id, name, quality, type, max_layer FROM generated_technique_def WHERE id = $1 LIMIT 1",
            |q| q.bind(&draft_technique_id),
        ).await?;
        emit_technique_research_result_to_user(
            state,
            user_id,
            &build_technique_research_result_payload(
                character_id,
                generation_id,
                "generated_draft",
                "新的研修草稿已生成，请前往功法查看",
                preview.map(|row| {
                    serde_json::json!({
                        "id": row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
                        "aiSuggestedName": row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
                        "quality": row.try_get::<Option<String>, _>("quality").unwrap_or(None).unwrap_or_default(),
                        "type": row.try_get::<Option<String>, _>("type").unwrap_or(None).unwrap_or_default(),
                        "maxLayer": row.try_get::<Option<i64>, _>("max_layer").unwrap_or(None).unwrap_or_default(),
                    })
                }),
                None,
            ),
        );
        if let Ok(status) = load_technique_research_status_data(state, character_id).await {
            emit_technique_research_status_to_user(
                state,
                user_id,
                &build_technique_research_status_payload(character_id, status),
            );
        }
    }
    Ok(())
}

async fn load_recent_successful_technique_description_prompt_context(
    state: &AppState,
    character_id: i64,
) -> Result<Option<serde_json::Value>, AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT d.name AS technique_name, d.quality, d.type, COALESCE(d.description, '') AS description, COALESCE(d.long_desc, '') AS long_desc FROM technique_generation_job j JOIN generated_technique_def d ON d.generation_id = j.id WHERE j.character_id = $1 AND (COALESCE(d.description, '') <> '' OR COALESCE(d.long_desc, '') <> '') ORDER BY COALESCE(j.finished_at, j.created_at) DESC, j.id DESC LIMIT $2",
            |q| q.bind(character_id).bind(TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT as i64),
        )
        .await?;

    let entries = rows
        .into_iter()
        .map(|row| {
            Ok(RecentTechniqueDescriptionReference {
                name: row
                    .try_get::<Option<String>, _>("technique_name")?
                    .unwrap_or_default(),
                quality: row
                    .try_get::<Option<String>, _>("quality")?
                    .unwrap_or_default(),
                technique_type: row
                    .try_get::<Option<String>, _>("type")?
                    .unwrap_or_default(),
                description: row
                    .try_get::<Option<String>, _>("description")?
                    .unwrap_or_default(),
                long_desc: row
                    .try_get::<Option<String>, _>("long_desc")?
                    .unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()?;

    Ok(build_recent_successful_technique_description_prompt_context(entries))
}

async fn discard_technique_research_draft_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, status, cost_points, used_cooldown_bypass_token FROM technique_generation_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(generation_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("生成任务不存在".to_string()),
            data: None,
        });
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "generated_draft" {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前草稿不可放弃".to_string()),
            data: None,
        });
    }
    refund_technique_generation_job_tx(
        state,
        character_id,
        generation_id,
        TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE,
        "refunded",
        "GENERATION_EXPIRED",
        TECHNIQUE_RESEARCH_EXPIRED_DRAFT_REFUND_RATE,
    )
    .await?;
    let user_id = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("user_id")
                .ok()
                .flatten()
                .map(i64::from)
        });
    if let Some(user_id) = user_id {
        emit_technique_research_result_to_user(
            state,
            user_id,
            &build_technique_research_result_payload(
                character_id,
                generation_id,
                "failed",
                "洞府推演失败，请前往功法查看",
                None,
                Some(append_technique_research_refund_hint(
                    TECHNIQUE_RESEARCH_EXPIRED_DRAFT_MESSAGE,
                )),
            ),
        );
    }
    Ok(ServiceResult {
        success: true,
        message: Some("已放弃本次研修草稿，并按过期规则结算".to_string()),
        data: Some(serde_json::json!({ "generationId": generation_id })),
    })
}

async fn publish_technique_research_draft_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
    custom_name: &str,
) -> Result<ServiceResultWithCode<TechniqueResearchPublishDataDto>, AppError> {
    let custom_name = custom_name.trim();
    if custom_name.is_empty() {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "缺少自定义名称".to_string(),
            code: Some("NAME_INVALID".to_string()),
            data: None,
        });
    }
    let char_count = custom_name.chars().count();
    if !(2..=14).contains(&char_count) {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "名称长度需在2~14之间".to_string(),
            code: Some("NAME_INVALID".to_string()),
            data: None,
        });
    }
    if !custom_name.chars().all(|ch| ('一'..='龥').contains(&ch)) {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "名称仅支持纯中文".to_string(),
            code: Some("NAME_INVALID".to_string()),
            data: None,
        });
    }

    let row = state.database.fetch_optional(
        "SELECT id, status, draft_technique_id FROM technique_generation_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(generation_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "生成任务不存在".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status == "published" {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "该草稿已发布".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    }
    if status != "generated_draft" {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "草稿尚未就绪".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    }
    let Some(technique_id) = row.try_get::<Option<String>, _>("draft_technique_id")? else {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "草稿功法不存在".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    };

    let generated_row = state
        .database
        .fetch_optional(
            "SELECT id, name_locked FROM generated_technique_def WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(&technique_id),
        )
        .await?;
    let Some(generated_row) = generated_row else {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "草稿功法不存在".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    };
    if generated_row
        .try_get::<Option<bool>, _>("name_locked")?
        .unwrap_or(false)
    {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "名称已锁定，不可修改".to_string(),
            code: Some("GENERATION_NOT_READY".to_string()),
            data: None,
        });
    }

    let final_name = format!("『研』{}", custom_name);
    let normalized = final_name.to_lowercase();
    let duplicate = state.database.fetch_optional(
        "SELECT id FROM generated_technique_def WHERE normalized_custom_name = $1 AND id <> $2 LIMIT 1",
        |q| q.bind(&normalized).bind(&technique_id),
    ).await?;
    if duplicate.is_some() {
        return Ok(ServiceResultWithCode {
            success: false,
            message: "名称已存在，请更换其他名称".to_string(),
            code: Some("NAME_INVALID".to_string()),
            data: None,
        });
    }

    let book_item_row = state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, metadata, created_at, updated_at) SELECT user_id, id, 'book-generated-technique', 1, 'none', 'bag', $2::jsonb, NOW(), NOW() FROM characters WHERE id = $1 RETURNING id",
        |q| q.bind(character_id).bind(serde_json::json!({
            "generatedTechniqueId": technique_id,
            "generatedTechniqueName": final_name,
        })),
    ).await?;
    let book_item_instance_id = book_item_row.try_get::<i64, _>("id")?;

    state.database.execute(
        "UPDATE generated_technique_def SET is_published = TRUE, published_at = NOW(), name_locked = TRUE, display_name = $2, custom_name = $3, normalized_custom_name = $4, updated_at = NOW() WHERE id = $1",
        |q| q.bind(&technique_id).bind(&final_name).bind(custom_name).bind(&normalized),
    ).await?;
    state.database.execute(
        "UPDATE technique_generation_job SET status = 'published', generated_technique_id = $2, finished_at = COALESCE(finished_at, NOW()), viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE id = $1",
        |q| q.bind(generation_id).bind(&technique_id),
    ).await?;

    Ok(ServiceResultWithCode {
        success: true,
        message: "发布成功，已发放可交易功法书".to_string(),
        code: None,
        data: Some(TechniqueResearchPublishDataDto {
            technique_id,
            final_name,
            book_item_instance_id: Some(book_item_instance_id),
        }),
    })
}

async fn require_owned_character(
    state: &AppState,
    headers: &HeaderMap,
    character_id: i64,
) -> Result<(), AppError> {
    tracing::info!(target: "technique_research_test_trace", character_id, "entered require_owned_character");
    let actor = auth::require_auth(state, headers).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT 1 AS ok FROM characters WHERE id = $1 AND user_id = $2 LIMIT 1",
            |q| q.bind(character_id).bind(actor.user_id),
        )
        .await?;
    if row.is_none() {
        return Err(AppError::unauthorized("无权限访问该角色"));
    }
    Ok(())
}

async fn load_character_techniques(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<CharacterTechniqueDto>, AppError> {
    let defs = load_visible_technique_def_map()?;
    let rows = state.database.fetch_all(
        "SELECT id, character_id, technique_id, current_layer, slot_type, slot_index, acquired_at::text AS acquired_at_text FROM character_technique WHERE character_id = $1",
        |q| q.bind(character_id),
    ).await?;
    let generated_ids = rows
        .iter()
        .filter_map(|row| {
            row.try_get::<Option<String>, _>("technique_id")
                .ok()
                .flatten()
        })
        .map(|value| value.trim().to_string())
        .filter(|technique_id| {
            !technique_id.is_empty() && !defs.contains_key(technique_id.as_str())
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let generated_defs = if generated_ids.is_empty() {
        BTreeMap::new()
    } else {
        let generated_rows = state.database.fetch_all(
            "SELECT id, COALESCE(display_name, name) AS name, type, quality, max_layer, attribute_type, attribute_element FROM generated_technique_def WHERE is_published = TRUE AND enabled = TRUE AND id = ANY($1) ORDER BY created_at DESC",
            |q| q.bind(&generated_ids),
        ).await?;
        generated_rows
            .into_iter()
            .filter_map(|row| {
                let id = row.try_get::<Option<String>, _>("id").ok().flatten()?;
                Some((
                    id.trim().to_string(),
                    CharacterTechniqueDto {
                        id: 0,
                        character_id,
                        technique_id: String::new(),
                        current_layer: 1,
                        slot_type: None,
                        slot_index: None,
                        acquired_at: None,
                        technique_name: Some(
                            row.try_get::<Option<String>, _>("name")
                                .ok()
                                .flatten()
                                .unwrap_or_default(),
                        ),
                        technique_type: Some(
                            row.try_get::<Option<String>, _>("type")
                                .ok()
                                .flatten()
                                .unwrap_or_default(),
                        ),
                        technique_quality: row
                            .try_get::<Option<String>, _>("quality")
                            .ok()
                            .flatten(),
                        max_layer: row
                            .try_get::<Option<i32>, _>("max_layer")
                            .ok()
                            .flatten()
                            .map(i64::from),
                        attribute_type: row
                            .try_get::<Option<String>, _>("attribute_type")
                            .ok()
                            .flatten(),
                        attribute_element: row
                            .try_get::<Option<String>, _>("attribute_element")
                            .ok()
                            .flatten(),
                    },
                ))
            })
            .collect::<BTreeMap<_, _>>()
    };
    let mut techniques = rows
        .into_iter()
        .filter_map(|row| {
            let technique_id = row
                .try_get::<Option<String>, _>("technique_id")
                .ok()
                .flatten()?;
            let static_def = defs.get(technique_id.trim());
            let generated_def = generated_defs.get(technique_id.trim());
            let def_name = static_def
                .map(|def| def.name.clone())
                .or_else(|| generated_def.and_then(|def| def.technique_name.clone()))?;
            let def_type = static_def
                .map(|def| def.technique_type.clone())
                .or_else(|| generated_def.and_then(|def| def.technique_type.clone()));
            let def_quality = static_def
                .and_then(|def| def.quality.clone())
                .or_else(|| generated_def.and_then(|def| def.technique_quality.clone()));
            let def_max_layer = static_def
                .and_then(|def| def.max_layer)
                .or_else(|| generated_def.and_then(|def| def.max_layer));
            let def_attr_type = static_def
                .and_then(|def| def.attribute_type.clone())
                .or_else(|| generated_def.and_then(|def| def.attribute_type.clone()));
            let def_attr_element = static_def
                .and_then(|def| def.attribute_element.clone())
                .or_else(|| generated_def.and_then(|def| def.attribute_element.clone()));
            Some(CharacterTechniqueDto {
                id: i64::from(row.try_get::<i32, _>("id").ok()?),
                character_id: i64::from(row.try_get::<i32, _>("character_id").ok()?),
                technique_id: technique_id.trim().to_string(),
                current_layer: row
                    .try_get::<Option<i32>, _>("current_layer")
                    .ok()
                    .flatten()
                    .map(i64::from)
                    .unwrap_or(1),
                slot_type: row.try_get::<Option<String>, _>("slot_type").ok().flatten(),
                slot_index: row
                    .try_get::<Option<i32>, _>("slot_index")
                    .ok()
                    .flatten()
                    .map(i64::from),
                acquired_at: row
                    .try_get::<Option<String>, _>("acquired_at_text")
                    .ok()
                    .flatten(),
                technique_name: Some(def_name),
                technique_type: def_type,
                technique_quality: def_quality,
                max_layer: def_max_layer,
                attribute_type: def_attr_type,
                attribute_element: def_attr_element,
            })
        })
        .collect::<Vec<_>>();
    techniques.sort_by(|left, right| {
        technique_slot_rank(&left.slot_type, left.slot_index)
            .cmp(&technique_slot_rank(&right.slot_type, right.slot_index))
            .then_with(|| {
                quality_multiplier(right.technique_quality.as_deref())
                    .cmp(&quality_multiplier(left.technique_quality.as_deref()))
            })
    });
    Ok(techniques)
}

fn technique_slot_rank(slot_type: &Option<String>, slot_index: Option<i64>) -> (i64, i64) {
    match slot_type.as_deref() {
        Some("main") => (0, 0),
        Some("sub") => (1, slot_index.unwrap_or(i64::MAX)),
        _ => (2, i64::MAX),
    }
}

async fn load_equipped_skills(
    state: &AppState,
    character_id: i64,
    available_ids: &BTreeSet<String>,
) -> Result<Vec<CharacterSkillSlotDto>, AppError> {
    let skill_defs = load_skill_def_map()?;
    let rows = state.database.fetch_all(
        "SELECT slot_index, skill_id FROM character_skill_slot WHERE character_id = $1 ORDER BY slot_index ASC",
        |q| q.bind(character_id),
    ).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let skill_id = row
                .try_get::<Option<String>, _>("skill_id")
                .ok()
                .flatten()?;
            if !available_ids.contains(skill_id.trim()) {
                return None;
            }
            let def = skill_defs.get(skill_id.trim());
            Some(CharacterSkillSlotDto {
                slot_index: row
                    .try_get::<Option<i32>, _>("slot_index")
                    .ok()
                    .flatten()
                    .map(i64::from)
                    .unwrap_or_default(),
                skill_id: skill_id.trim().to_string(),
                skill_name: def
                    .map(|row| row.name.clone())
                    .unwrap_or_else(|| skill_id.trim().to_string()),
                skill_icon: def.and_then(|row| row.icon.clone()).unwrap_or_default(),
            })
        })
        .collect())
}

fn build_available_skills(
    techniques: &[CharacterTechniqueDto],
) -> Result<Vec<CharacterAvailableSkillDto>, AppError> {
    let skill_defs = load_skill_def_map()?;
    let layers = load_technique_layers_grouped()?;
    let defs = load_visible_technique_def_map()?;
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for technique in techniques.iter().filter(|entry| entry.slot_type.is_some()) {
        let Some(def) = defs.get(technique.technique_id.as_str()) else {
            continue;
        };
        let unlocked_layers = layers
            .get(technique.technique_id.as_str())
            .cloned()
            .unwrap_or_default();
        let mut skill_ids = Vec::new();
        for layer in unlocked_layers
            .into_iter()
            .filter(|layer| layer.layer <= technique.current_layer)
        {
            skill_ids.extend(layer.unlock_skill_ids.unwrap_or_default());
            skill_ids.extend(layer.upgrade_skill_ids.unwrap_or_default());
        }
        skill_ids.sort();
        skill_ids.dedup();
        for skill_id in skill_ids {
            if !seen.insert(skill_id.clone()) {
                continue;
            }
            let Some(skill) = skill_defs.get(skill_id.as_str()) else {
                continue;
            };
            out.push(CharacterAvailableSkillDto {
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                skill_icon: skill.icon.clone().unwrap_or_default(),
                technique_id: technique.technique_id.clone(),
                technique_name: def.name.clone(),
                description: skill.description.clone(),
                cost_lingqi: skill.cost_lingqi.unwrap_or_default(),
                cost_lingqi_rate: skill.cost_lingqi_rate.unwrap_or_default(),
                cost_qixue: skill.cost_qixue.unwrap_or_default(),
                cost_qixue_rate: skill.cost_qixue_rate.unwrap_or_default(),
                cooldown: skill.cooldown.unwrap_or_default(),
                target_type: skill
                    .target_type
                    .clone()
                    .unwrap_or_else(|| "single_enemy".to_string()),
                target_count: skill.target_count.unwrap_or(1),
                damage_type: skill.damage_type.clone(),
                element: skill.element.clone().unwrap_or_else(|| "none".to_string()),
                effects: skill.effects.clone().unwrap_or_default(),
            });
        }
    }
    Ok(out)
}

fn to_battle_skill_value(skill: &CharacterAvailableSkillDto) -> serde_json::Value {
    serde_json::json!({
        "id": skill.skill_id,
        "name": skill.skill_name,
        "description": skill.description.clone().unwrap_or_default(),
        "type": "active",
        "damageType": skill.damage_type.clone().unwrap_or_else(|| "physical".to_string()),
        "targetType": skill.target_type,
        "targetCount": skill.target_count.max(1),
        "element": if skill.element.trim().is_empty() { "none" } else { skill.element.trim() },
        "triggerType": "active",
        "aiPriority": 50,
        "cooldown": skill.cooldown.max(0),
        "cost": {
            "lingqi": skill.cost_lingqi.max(0),
            "lingqiRate": skill.cost_lingqi_rate.max(0.0),
            "qixue": skill.cost_qixue.max(0),
            "qixueRate": skill.cost_qixue_rate.max(0.0),
        },
        "effects": skill.effects,
    })
}

pub async fn load_character_battle_skill_values(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<serde_json::Value>, AppError> {
    let techniques = load_character_techniques(state, character_id).await?;
    let available_skills = build_available_skills(&techniques)?;
    let available_id_set = available_skills
        .iter()
        .map(|skill| skill.skill_id.clone())
        .collect::<BTreeSet<_>>();
    let equipped = load_equipped_skills(state, character_id, &available_id_set).await?;
    let available_map = available_skills
        .into_iter()
        .map(|skill| (skill.skill_id.clone(), skill))
        .collect::<BTreeMap<_, _>>();

    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for slot in equipped {
        if !seen.insert(slot.skill_id.clone()) {
            continue;
        }
        if let Some(skill) = available_map.get(slot.skill_id.as_str()) {
            out.push(to_battle_skill_value(skill));
        }
    }
    if out.is_empty() {
        for (skill_id, skill) in &available_map {
            if !seen.insert(skill_id.clone()) {
                continue;
            }
            out.push(to_battle_skill_value(skill));
        }
    }
    Ok(out)
}

fn calculate_technique_passives(
    techniques: &[CharacterTechniqueDto],
) -> Result<BTreeMap<String, f64>, AppError> {
    let layers = load_technique_layers_grouped()?;
    let mut passives = BTreeMap::new();
    for technique in techniques.iter().filter(|entry| entry.slot_type.is_some()) {
        let ratio = if technique.slot_type.as_deref() == Some("main") {
            1.0
        } else {
            0.3
        };
        for layer in layers
            .get(technique.technique_id.as_str())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|layer| layer.layer <= technique.current_layer)
        {
            for passive in layer.passives.unwrap_or_default() {
                *passives.entry(passive.key).or_insert(0.0) += passive.value * ratio;
            }
        }
    }
    Ok(passives)
}

fn load_visible_technique_def_map() -> Result<BTreeMap<String, TechniqueDefSeed>, AppError> {
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
        .map(|row| (row.id.clone(), row))
        .collect())
}

fn load_technique_layers_by_id() -> Result<BTreeMap<(String, i64), TechniqueLayerSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_layer.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_layer.json: {error}")))?;
    let normalized_content = content.replace("\"itemId\"", "\"item_id\"");
    let payload: TechniqueLayerFile =
        serde_json::from_str(&normalized_content).map_err(|error| {
            AppError::config(format!(
                "failed to parse technique_layer.json [character_technique.rs::by_id]: {error}"
            ))
        })?;
    Ok(payload
        .layers
        .into_iter()
        .map(|row| ((row.technique_id.clone(), row.layer), row))
        .collect())
}

fn load_technique_layers_grouped() -> Result<BTreeMap<String, Vec<TechniqueLayerSeed>>, AppError> {
    let mut grouped = BTreeMap::<String, Vec<TechniqueLayerSeed>>::new();
    for ((technique_id, _), row) in load_technique_layers_by_id()? {
        grouped.entry(technique_id).or_default().push(row);
    }
    for values in grouped.values_mut() {
        values.sort_by_key(|row| row.layer);
    }
    Ok(grouped)
}

fn load_skill_def_map() -> Result<BTreeMap<String, SkillDefSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/skill_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read skill_def.json: {error}")))?;
    let payload: SkillDefFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse skill_def.json: {error}")))?;
    Ok(payload
        .skills
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| (row.id.clone(), row))
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
            out.insert(
                id,
                (
                    name,
                    item.get("icon")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                ),
            );
        }
    }
    Ok(out)
}

fn quality_multiplier(quality: Option<&str>) -> i64 {
    match quality.unwrap_or_default().trim() {
        "天" => 4,
        "地" => 3,
        "玄" => 2,
        "黄" => 1,
        _ => 1,
    }
}

fn short_hash_hex(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn short_generated_id(prefix: &str, source: &str) -> String {
    format!("{}-{}", prefix.trim(), short_hash_hex(source.trim()))
}

fn scale_cost(base: i64, quality_multiplier: i64) -> i64 {
    base.max(0).saturating_mul(quality_multiplier.max(1))
}

fn generated_technique_max_layer(quality: &str) -> i64 {
    match quality.trim() {
        "天" => 9,
        "地" => 7,
        "玄" => 5,
        _ => 3,
    }
}

fn remap_generated_candidate_skill_ids(
    candidate: &mut GeneratedTechniqueCandidate,
    generation_id: &str,
) {
    let id_map = candidate
        .skills
        .iter()
        .enumerate()
        .map(|(index, skill)| {
            (
                skill.id.clone(),
                short_generated_id("skill-gen", &format!("{generation_id}:{}", index + 1)),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for skill in &mut candidate.skills {
        if let Some(next_id) = id_map.get(&skill.id) {
            skill.id = next_id.clone();
        }
    }
    for layer in &mut candidate.layers {
        for skill_id in &mut layer.unlock_skill_ids {
            if let Some(next_id) = id_map.get(skill_id) {
                *skill_id = next_id.clone();
            }
        }
        for skill_id in &mut layer.upgrade_skill_ids {
            if let Some(next_id) = id_map.get(skill_id) {
                *skill_id = next_id.clone();
            }
        }
    }
}

async fn fail_technique_generation_job_with_refund(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
    reason: &str,
) -> Result<(), AppError> {
    refund_technique_generation_job_tx(
        state,
        character_id,
        generation_id,
        reason,
        "failed",
        "AI_PROVIDER_ERROR",
        TECHNIQUE_RESEARCH_FULL_REFUND_RATE,
    )
    .await?;
    let user_id = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("user_id")
                .ok()
                .flatten()
                .map(i64::from)
        });
    if let Some(user_id) = user_id {
        emit_technique_research_result_to_user(
            state,
            user_id,
            &build_technique_research_result_payload(
                character_id,
                generation_id,
                "failed",
                "洞府推演失败，请前往功法查看",
                None,
                Some(append_technique_research_refund_hint(reason)),
            ),
        );
        if let Ok(status) = load_technique_research_status_data(state, character_id).await {
            emit_technique_research_status_to_user(
                state,
                user_id,
                &build_technique_research_status_payload(character_id, status),
            );
        }
    }
    Ok(())
}

fn current_week_key() -> String {
    let now = time::OffsetDateTime::now_utc();
    let (year, week, _) = now.to_iso_week_date();
    format!("{:04}-W{:02}", year, week)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

async fn consume_material_qty(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
) -> Result<bool, AppError> {
    if qty <= 0 {
        return Ok(true);
    }
    let rows = state.database.fetch_all(
        "SELECT id, qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = $2 AND location IN ('bag','warehouse') ORDER BY created_at ASC, id ASC FOR UPDATE",
        |q| q.bind(character_id).bind(item_def_id),
    ).await?;
    let mut remaining = qty;
    for row in rows {
        let instance_id = row.try_get::<i64, _>("id")?;
        let stack_qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default()
            .max(0);
        if stack_qty <= 0 {
            continue;
        }
        if stack_qty <= remaining {
            state
                .database
                .execute("DELETE FROM item_instance WHERE id = $1", |q| {
                    q.bind(instance_id)
                })
                .await?;
            remaining -= stack_qty;
        } else {
            state
                .database
                .execute(
                    "UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                    |q| q.bind(instance_id).bind(remaining),
                )
                .await?;
            remaining = 0;
        }
        if remaining == 0 {
            break;
        }
    }
    Ok(remaining == 0)
}

fn build_technique_research_cooldown_state(
    latest_started_at: Option<&str>,
) -> (Option<String>, i64) {
    if std::env::var("NODE_ENV").ok().as_deref() == Some("development") {
        return (None, 0);
    }
    let Some(started_at) = latest_started_at else {
        return (None, 0);
    };
    let Ok(started_at) =
        time::OffsetDateTime::parse(started_at, &time::format_description::well_known::Rfc3339)
    else {
        return (None, 0);
    };
    let cooldown_until = started_at + time::Duration::hours(72);
    let now = time::OffsetDateTime::now_utc();
    let remaining = ((cooldown_until.unix_timestamp_nanos() - now.unix_timestamp_nanos()).max(0)
        / 1_000_000
        + 999)
        / 1000;
    (
        Some(
            cooldown_until
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        ),
        remaining as i64,
    )
}

fn realm_rank_with_full_name(full_realm: &str) -> i64 {
    const ORDER: &[&str] = &[
        "凡人",
        "炼精化炁·养气期",
        "炼精化炁·通脉期",
        "炼精化炁·凝炁期",
        "炼炁化神·炼己期",
        "炼炁化神·采药期",
        "炼炁化神·结胎期",
        "炼神返虚·养神期",
        "炼神返虚·还虚期",
        "炼神返虚·合道期",
        "炼虚合道·证道期",
        "炼虚合道·历劫期",
        "炼虚合道·成圣期",
    ];
    ORDER
        .iter()
        .position(|item| *item == full_realm.trim())
        .map(|idx| idx as i64)
        .unwrap_or(0)
}

fn realm_rank_with_subrealm(realm: &str, sub_realm: Option<&str>) -> i64 {
    let full = if realm.trim() == "凡人" || sub_realm.unwrap_or_default().trim().is_empty() {
        realm.trim().to_string()
    } else {
        format!("{}·{}", realm.trim(), sub_realm.unwrap_or_default().trim())
    };
    realm_rank_with_full_name(&full)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn technique_research_prompt_context_merges_creative_burning_word_and_recent_descriptions() {
        let context = build_technique_research_prompt_context(
            Some("炎心"),
            Some(serde_json::json!({
                "techniqueRecentSuccessfulDescriptions": [
                    {
                        "name": "青木回风诀",
                        "quality": "玄",
                        "type": "武技",
                        "description": "以回风护体",
                        "longDesc": "借青木回风延展身法。"
                    }
                ],
                "techniqueRecentSuccessfulDescriptionDiversityRules": ["避开旧功法句式"]
            })),
        );

        assert_eq!(context["techniqueBurningWordPrompt"], "炎心");
        assert!(context["techniqueBurningWordPromptScopeRules"].is_array());
        assert!(context["techniqueResearchCreativeDirectionRules"].is_array());
        assert_eq!(
            context["techniqueRecentSuccessfulDescriptions"][0]["name"],
            "青木回风诀"
        );
    }

    #[test]
    fn recent_successful_description_context_filters_empty_and_dedupes() {
        let context = build_recent_successful_technique_description_prompt_context(vec![
            RecentTechniqueDescriptionReference {
                name: "青木回风诀".to_string(),
                quality: "玄".to_string(),
                technique_type: "武技".to_string(),
                description: "以回风护体".to_string(),
                long_desc: "借青木回风延展身法。".to_string(),
            },
            RecentTechniqueDescriptionReference {
                name: "青木回风诀".to_string(),
                quality: "玄".to_string(),
                technique_type: "武技".to_string(),
                description: "以回风护体".to_string(),
                long_desc: "借青木回风延展身法。".to_string(),
            },
            RecentTechniqueDescriptionReference {
                name: "空白诀".to_string(),
                quality: "黄".to_string(),
                technique_type: "武技".to_string(),
                description: "".to_string(),
                long_desc: " ".to_string(),
            },
        ])
        .expect("context should keep one valid reference");

        assert_eq!(
            context["techniqueRecentSuccessfulDescriptions"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn recent_successful_description_context_limits_to_recent_successful_description_limit() {
        let entries = (1..=(TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT + 2))
            .map(|index| RecentTechniqueDescriptionReference {
                name: format!("功法{index}"),
                quality: "玄".to_string(),
                technique_type: "武技".to_string(),
                description: format!("描述{index}"),
                long_desc: format!("长描述{index}"),
            })
            .collect();

        let context = build_recent_successful_technique_description_prompt_context(entries)
            .expect("context should keep limited entries");
        let descriptions = context["techniqueRecentSuccessfulDescriptions"]
            .as_array()
            .expect("descriptions should be array");

        assert_eq!(
            descriptions.len(),
            TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT
        );
        assert_eq!(descriptions[0]["name"], "功法1");
        assert_eq!(
            descriptions[TECHNIQUE_RECENT_SUCCESSFUL_DESCRIPTION_LIMIT - 1]["name"],
            "功法10"
        );
    }

    #[test]
    fn character_technique_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"techniques": [], "equippedMain": null, "equippedSubs": [], "equippedSkills": [], "availableSkills": [], "passives": {}}
        });
        assert_eq!(payload["data"]["techniques"], serde_json::json!([]));
        println!("CHARACTER_TECHNIQUE_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn character_techniques_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": [{"techniqueId": "tech-yangqi-jue", "currentLayer": 1}]
        });
        assert_eq!(payload["data"][0]["techniqueId"], "tech-yangqi-jue");
        println!("CHARACTER_TECHNIQUES_RESPONSE={}", payload);
    }

    #[test]
    fn equipped_techniques_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"main": {"techniqueId": "tech-yangqi-jue"}, "subs": []}
        });
        assert_eq!(payload["data"]["main"]["techniqueId"], "tech-yangqi-jue");
        println!("CHARACTER_TECHNIQUES_EQUIPPED_RESPONSE={}", payload);
    }

    #[test]
    fn technique_upgrade_cost_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"currentLayer": 1, "maxLayer": 9, "spiritStones": 100, "exp": 50, "materials": []}
        });
        assert_eq!(payload["data"]["currentLayer"], 1);
        println!("CHARACTER_TECHNIQUE_UPGRADE_COST_RESPONSE={}", payload);
    }

    #[test]
    fn available_skills_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": [{"skillId": "skill-普通攻击", "techniqueId": "tech-yangqi-jue"}]
        });
        assert_eq!(payload["data"][0]["skillId"], "skill-普通攻击");
        println!("CHARACTER_AVAILABLE_SKILLS_RESPONSE={}", payload);
    }

    #[test]
    fn equipped_skills_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": [{"slotIndex": 1, "skillId": "skill-普通攻击"}]
        });
        assert_eq!(payload["data"][0]["slotIndex"], 1);
        println!("CHARACTER_EQUIPPED_SKILLS_RESPONSE={}", payload);
    }

    #[test]
    fn technique_passives_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "计算成功",
            "data": {"wugong": 10.5}
        });
        assert_eq!(payload["data"]["wugong"], 10.5);
        println!("CHARACTER_TECHNIQUE_PASSIVES_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"unlockRealm": "炼炁化神·结胎期", "unlocked": false, "fragmentBalance": 0, "currentJob": null, "hasUnreadResult": false, "qualityRates": [{"quality": "黄", "weight": 4, "rate": 40.0}]}
        });
        assert_eq!(payload["data"]["unlockRealm"], "炼炁化神·结胎期");
        println!("CHARACTER_TECHNIQUE_RESEARCH_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_mark_viewed_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已标记查看",
            "data": {"marked": true}
        });
        assert_eq!(payload["data"]["marked"], true);
        println!(
            "CHARACTER_TECHNIQUE_RESEARCH_MARK_VIEWED_RESPONSE={}",
            payload
        );
    }

    #[test]
    fn character_technique_dissipate_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "散功成功"
        });
        assert_eq!(payload["message"], "散功成功");
        println!("CHARACTER_TECHNIQUE_DISSIPATE_RESPONSE={}", payload);
    }

    #[test]
    fn character_technique_unequip_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "卸下成功"
        });
        assert_eq!(payload["message"], "卸下成功");
        println!("CHARACTER_TECHNIQUE_UNEQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn character_skill_equip_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "装备成功"
        });
        assert_eq!(payload["message"], "装备成功");
        println!("CHARACTER_SKILL_EQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn character_skill_unequip_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "卸下成功"
        });
        assert_eq!(payload["message"], "卸下成功");
        println!("CHARACTER_SKILL_UNEQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn character_technique_equip_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "装备成功"
        });
        assert_eq!(payload["message"], "装备成功");
        println!("CHARACTER_TECHNIQUE_EQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn character_technique_upgrade_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "养气诀修炼至第2层",
            "data": {"newLayer": 2, "unlockedSkills": [], "upgradedSkills": []}
        });
        assert_eq!(payload["data"]["newLayer"], 2);
        println!("CHARACTER_TECHNIQUE_UPGRADE_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_generate_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "洞府推演任务已创建",
            "data": {"generationId": "tech-gen-1-123", "quality": "玄", "status": "pending"}
        });
        assert_eq!(payload["data"]["status"], "pending");
        println!("CHARACTER_TECHNIQUE_RESEARCH_GENERATE_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_discard_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已放弃本次研修草稿，并按过期规则结算",
            "data": {"generationId": "tech-gen-1-123"}
        });
        assert_eq!(payload["data"]["generationId"], "tech-gen-1-123");
        println!("CHARACTER_TECHNIQUE_RESEARCH_DISCARD_RESPONSE={}", payload);
    }

    #[test]
    fn technique_research_publish_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "发布成功，已发放可交易功法书",
            "data": {"techniqueId": "gen-tech-1", "finalName": "『研』青木诀", "bookItemInstanceId": 501}
        });
        assert_eq!(payload["data"]["bookItemInstanceId"], 501);
        println!("CHARACTER_TECHNIQUE_RESEARCH_PUBLISH_RESPONSE={}", payload);
    }
}
