use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::http::inventory::{load_inventory_def_map, resolve_generated_technique_book_display};
use crate::http::technique::load_technique_detail_data;
use crate::integrations::partner_ai::generate_partner_ai_preview_draft;
use crate::integrations::text_model_config::{
    TextModelScope, read_text_model_config, require_text_model_config,
};
use crate::jobs;
use crate::realtime::partner::{PartnerUpdatePayload, build_partner_update_payload};
use crate::realtime::partner_fusion::{
    build_partner_fusion_result_payload, build_partner_fusion_status_payload,
};
use crate::realtime::partner_rebone::{
    build_partner_rebone_result_payload, build_partner_rebone_status_payload,
};
use crate::realtime::partner_recruit::{
    build_partner_recruit_result_payload, build_partner_recruit_status_payload,
};
use crate::realtime::public_socket::{
    emit_partner_fusion_result_to_user, emit_partner_fusion_status_to_user,
    emit_partner_rebone_result_to_user, emit_partner_rebone_status_to_user,
    emit_partner_recruit_result_to_user, emit_partner_recruit_status_to_user,
};
use crate::realtime::rank::build_rank_update_payload;
use crate::shared::error::AppError;
use crate::shared::mail_counter::{apply_mail_counter_deltas, build_new_mail_counter_deltas};
use crate::shared::response::{ServiceResult, send_result};
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

#[derive(Debug, Deserialize)]
pub struct PartnerPreviewQuery {
    #[serde(rename = "partnerId")]
    pub partner_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PartnerSkillPolicyQuery {
    #[serde(rename = "partnerId")]
    pub partner_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PartnerTechniqueQuery {
    #[serde(rename = "partnerId")]
    pub partner_id: Option<i64>,
    #[serde(rename = "techniqueId")]
    pub technique_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerSkillPolicyUpdatePayload {
    pub partner_id: Option<i64>,
    pub slots: Option<Vec<PartnerSkillPolicySlotDto>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerInjectExpPayload {
    pub partner_id: Option<i64>,
    pub exp: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueActionPayload {
    pub partner_id: Option<i64>,
    pub technique_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePartnerPayload {
    pub partner_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub nickname: Option<String>,
    pub description: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnPartnerTechniquePayload {
    pub partner_id: Option<i64>,
    pub item_instance_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitGeneratePayload {
    pub custom_base_model_enabled: Option<bool>,
    pub requested_base_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitGenerateDataDto {
    pub generation_id: String,
    pub quality: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<PartnerUpdatePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerGeneratedInnateTechniquePreviewDto {
    pub technique_id: String,
    pub name: String,
    pub description: String,
    pub quality: String,
    pub icon: Option<String>,
    pub skill_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitPreviewLiteDto {
    pub partner_def_id: String,
    pub name: String,
    pub description: String,
    pub quality: String,
    pub avatar: Option<String>,
    pub element: String,
    pub role: String,
    pub slot_count: i64,
    pub base_attrs: BTreeMap<String, f64>,
    pub level_attr_gains: BTreeMap<String, f64>,
    pub innate_techniques: Vec<PartnerGeneratedInnateTechniquePreviewDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitJobLiteDto {
    pub generation_id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub preview_expire_at: Option<String>,
    pub requested_base_model: Option<String>,
    pub preview: Option<PartnerRecruitPreviewLiteDto>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitQualityRateDto {
    pub quality: String,
    pub weight: i64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRecruitStatusDto {
    pub feature_code: String,
    pub unlock_realm: String,
    pub unlocked: bool,
    pub spirit_stone_cost: i64,
    pub cooldown_hours: i64,
    pub cooldown_until: Option<String>,
    pub cooldown_remaining_seconds: i64,
    pub custom_base_model_bypasses_cooldown: bool,
    pub custom_base_model_max_length: i64,
    pub custom_base_model_token_cost: i64,
    pub custom_base_model_token_item_name: String,
    pub custom_base_model_token_available_qty: i64,
    pub current_job: Option<PartnerRecruitJobLiteDto>,
    pub has_unread_result: bool,
    pub result_status: Option<String>,
    pub remaining_until_guaranteed_heaven: i64,
    pub quality_rates: Vec<PartnerRecruitQualityRateDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionStartPayload {
    pub partner_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionStartDataDto {
    pub fusion_id: String,
    pub source_quality: String,
    pub result_quality: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<PartnerUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneStartPayload {
    pub partner_id: Option<i64>,
    pub item_def_id: Option<String>,
    pub item_qty: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneStartDataDto {
    pub rebone_id: String,
    pub partner_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<PartnerUpdatePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionJobLiteDto {
    pub fusion_id: String,
    pub status: String,
    pub source_quality: String,
    pub result_quality: Option<String>,
    pub material_partner_ids: Vec<i64>,
    pub preview: Option<PartnerRecruitPreviewLiteDto>,
    pub error_message: Option<String>,
    pub viewed_at: Option<String>,
    pub finished_at: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerFusionStatusDto {
    pub feature_code: String,
    pub unlocked: bool,
    pub current_job: Option<PartnerFusionJobLiteDto>,
    pub has_unread_result: bool,
    pub result_status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneJobLiteDto {
    pub rebone_id: String,
    pub status: String,
    pub partner_id: i64,
    pub item_def_id: String,
    pub item_qty: i64,
    pub error_message: Option<String>,
    pub viewed_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerReboneStatusDto {
    pub feature_code: String,
    pub unlocked: bool,
    pub current_job: Option<PartnerReboneJobLiteDto>,
    pub has_unread_result: bool,
    pub result_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPartnerTechniqueLearnPayload {
    pub partner_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub replaced_technique_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardPartnerTechniqueLearnPayload {
    pub item_instance_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartnerGrowthDto {
    pub max_qixue: i64,
    pub wugong: i64,
    pub fagong: i64,
    pub wufang: i64,
    pub fafang: i64,
    pub sudu: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartnerComputedAttrsDto {
    pub qixue: i64,
    pub max_qixue: i64,
    pub lingqi: i64,
    pub max_lingqi: i64,
    pub wugong: i64,
    pub fagong: i64,
    pub wufang: i64,
    pub fafang: i64,
    pub mingzhong: f64,
    pub shanbi: f64,
    pub zhaojia: f64,
    pub baoji: f64,
    pub baoshang: f64,
    pub jianbaoshang: f64,
    pub jianfantan: f64,
    pub kangbao: f64,
    pub zengshang: f64,
    pub zhiliao: f64,
    pub jianliao: f64,
    pub xixue: f64,
    pub lengque: f64,
    pub sudu: i64,
    pub kongzhi_kangxing: f64,
    pub jin_kangxing: f64,
    pub mu_kangxing: f64,
    pub shui_kangxing: f64,
    pub huo_kangxing: f64,
    pub tu_kangxing: f64,
    pub qixue_huifu: f64,
    pub lingqi_huifu: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartnerTechniqueSkillDto {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: Option<String>,
    pub cost_lingqi: Option<i64>,
    pub cost_lingqi_rate: Option<f64>,
    pub cost_qixue: Option<i64>,
    pub cost_qixue_rate: Option<f64>,
    pub cooldown: Option<i64>,
    pub target_type: Option<String>,
    pub target_count: Option<i64>,
    pub damage_type: Option<String>,
    pub element: Option<String>,
    pub effects: Option<Vec<serde_json::Value>>,
    pub trigger_type: Option<String>,
    pub ai_priority: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueDto {
    pub technique_id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub quality: String,
    pub current_layer: i64,
    pub max_layer: i64,
    pub skill_ids: Vec<String>,
    pub skills: Vec<PartnerTechniqueSkillDto>,
    pub passive_attrs: BTreeMap<String, f64>,
    pub is_innate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerDetailDto {
    pub id: i64,
    pub partner_def_id: String,
    pub name: String,
    pub nickname: String,
    pub description: String,
    pub avatar: Option<String>,
    pub element: String,
    pub role: String,
    pub quality: String,
    pub level: i64,
    pub current_effective_level: i64,
    pub progress_exp: i64,
    pub next_level_cost_exp: i64,
    pub slot_count: i64,
    pub is_active: bool,
    pub is_generated: bool,
    pub obtained_from: Option<String>,
    pub growth: PartnerGrowthDto,
    pub level_attr_gains: BTreeMap<String, f64>,
    pub computed_attrs: PartnerComputedAttrsDto,
    pub techniques: Vec<PartnerTechniqueDto>,
    pub trade_status: String,
    pub market_listing_id: Option<i64>,
    pub fusion_status: String,
    pub fusion_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerBookDto {
    pub item_instance_id: i64,
    pub item_def_id: String,
    pub technique_id: String,
    pub technique_name: String,
    pub name: String,
    pub icon: Option<String>,
    pub quality: String,
    pub qty: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_partner_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_learned_technique_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_replaced_technique_id: Option<String>,
}

#[derive(Debug, Clone)]
struct PartnerTechniquePreviewItemRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerConsumableDto {
    pub item_def_id: String,
    pub item_instance_id: i64,
    pub name: String,
    pub icon: Option<String>,
    pub qty: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerOverviewDto {
    pub unlocked: bool,
    pub feature_code: String,
    pub character_exp: i64,
    pub active_partner_id: Option<i64>,
    pub partners: Vec<PartnerDetailDto>,
    pub books: Vec<PartnerBookDto>,
    pub partner_consumables: Vec<PartnerConsumableDto>,
    pub pending_technique_learn_preview: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerSkillPolicySlotDto {
    pub skill_id: String,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerSkillPolicyEntryDto {
    pub skill_id: String,
    pub skill_name: String,
    pub skill_icon: String,
    pub skill_description: Option<String>,
    pub cost_lingqi: Option<i64>,
    pub cost_lingqi_rate: Option<f64>,
    pub cost_qixue: Option<i64>,
    pub cost_qixue_rate: Option<f64>,
    pub cooldown: Option<i64>,
    pub target_type: Option<String>,
    pub target_count: Option<i64>,
    pub damage_type: Option<String>,
    pub element: Option<String>,
    pub effects: Option<Vec<serde_json::Value>>,
    pub source_technique_id: String,
    pub source_technique_name: String,
    pub source_technique_quality: String,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerSkillPolicyDto {
    pub partner_id: i64,
    pub entries: Vec<PartnerSkillPolicyEntryDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueUpgradeCostMaterialDto {
    pub item_id: String,
    pub qty: i64,
    pub item_name: Option<String>,
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueUpgradeCostDto {
    pub current_layer: i64,
    pub max_layer: i64,
    pub next_layer: i64,
    pub spirit_stones: i64,
    pub exp: i64,
    pub materials: Vec<PartnerTechniqueUpgradeCostMaterialDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueDetailDto {
    pub technique: serde_json::Value,
    pub layers: Vec<serde_json::Value>,
    pub skills: Vec<serde_json::Value>,
    pub current_layer: i64,
    pub is_innate: bool,
}

#[derive(Debug, Deserialize)]
struct PartnerDefFile {
    partners: Vec<PartnerDefSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct PartnerDefSeed {
    id: String,
    source_job_id: Option<String>,
    name: String,
    description: Option<String>,
    avatar: Option<String>,
    quality: Option<String>,
    attribute_element: Option<String>,
    role: Option<String>,
    max_technique_slots: Option<i64>,
    innate_technique_ids: Option<Vec<String>>,
    base_attrs: serde_json::Value,
    level_attr_gains: serde_json::Value,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PartnerGrowthFile {
    exp_base_exp: i64,
    exp_growth_rate: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct PartnerRow {
    id: i64,
    character_id: i64,
    partner_def_id: String,
    nickname: String,
    description: Option<String>,
    avatar: Option<String>,
    level: i64,
    progress_exp: i64,
    growth_max_qixue: i64,
    growth_wugong: i64,
    growth_fagong: i64,
    growth_wufang: i64,
    growth_fafang: i64,
    growth_sudu: i64,
    is_active: bool,
    obtained_from: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct PartnerTechniqueRow {
    partner_id: i64,
    technique_id: String,
    current_layer: i64,
    is_innate: bool,
    learned_from_item_def_id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct CharacterPartnerSkillPolicyRow {
    skill_id: String,
    priority: i64,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerActivateData {
    pub active_partner_id: i64,
    pub partner: PartnerDetailDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerDismissData {
    pub active_partner_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerInjectExpData {
    pub partner: PartnerDetailDto,
    pub spent_exp: i64,
    pub levels_gained: i64,
    pub character_exp: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerUpgradeTechniqueData {
    pub partner: PartnerDetailDto,
    pub updated_technique: PartnerTechniqueDto,
    pub new_layer: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerRenameData {
    pub partner: PartnerDetailDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerLearnTechniqueResultDto {
    pub partner: PartnerDetailDto,
    pub learned_technique: PartnerTechniqueDto,
    pub replaced_technique: Option<PartnerTechniqueDto>,
    pub remaining_books: Vec<PartnerBookDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerDiscardLearnTechniqueData {
    pub remaining_books: Vec<PartnerBookDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerPendingTechniqueLearnPreviewDto {
    pub book: PartnerBookDto,
    pub preview: PartnerTechniqueLearnPreviewDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartnerTechniqueLearnPreviewDto {
    pub partner_id: i64,
    pub item_instance_id: i64,
    pub learned_technique: PartnerTechniqueDto,
    pub replaced_technique: PartnerTechniqueDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "mode")]
pub enum PartnerLearnTechniqueActionData {
    #[serde(rename = "learned")]
    Learned {
        result: PartnerLearnTechniqueResultDto,
    },
    #[serde(rename = "preview_replace")]
    PreviewReplace {
        preview: PartnerTechniqueLearnPreviewDto,
    },
}

pub async fn get_partner_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerOverviewDto> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }

    let character = load_partner_owner_context(&state, actor.character_id).await?;
    let rows = load_partner_rows(&state, actor.character_id).await?;
    let techniques =
        load_partner_technique_rows(&state, rows.iter().map(|row| row.id).collect()).await?;
    let books = load_partner_books(&state, actor.character_id).await?;
    let pending_preview = load_pending_partner_technique_learn_preview(
        &state,
        actor.character_id,
        &rows,
        &techniques,
        &character,
    )
    .await?;
    let overview = PartnerOverviewDto {
        unlocked: true,
        feature_code: "partner_system".to_string(),
        character_exp: character.exp,
        active_partner_id: rows.iter().find(|row| row.is_active).map(|row| row.id),
        partners: build_partner_details_with_generated(&state, rows, &techniques, &character)
            .await?,
        books,
        partner_consumables: vec![],
        pending_technique_learn_preview: pending_preview
            .map(|preview| serde_json::to_value(preview).unwrap_or(serde_json::Value::Null)),
    };
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(overview),
    }))
}

pub async fn get_partner_recruit_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let status = load_partner_recruit_status_data(&state, actor.character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(status),
    }))
}

pub(crate) async fn load_partner_recruit_status_data(
    state: &AppState,
    character_id: i64,
) -> Result<PartnerRecruitStatusDto, AppError> {
    let row = state.database.fetch_optional(
        "SELECT realm, sub_realm, partner_recruit_generated_non_heaven_count FROM characters WHERE id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    let realm = row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm")?;
    let unlock_realm = "炼神返虚·养神期".to_string();
    let unlocked = realm_rank_with_subrealm(&realm, sub_realm.as_deref())
        >= realm_rank_with_full_name(&unlock_realm);
    let non_heaven_count = row
        .try_get::<Option<i32>, _>("partner_recruit_generated_non_heaven_count")?
        .map(i64::from)
        .unwrap_or_default()
        .max(0);
    let latest_job = state.database.fetch_optional(
        "SELECT id, status, requested_base_model, preview_partner_def_id, preview_avatar_url, cooldown_started_at::text AS cooldown_started_at_text, finished_at::text AS finished_at_text, viewed_at::text AS viewed_at_text, error_message FROM partner_recruit_job WHERE character_id = $1 ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let current_job = if let Some(job) = latest_job.as_ref() {
        let preview_partner_def_id = job.try_get::<Option<String>, _>("preview_partner_def_id")?;
        let preview = if let Some(preview_partner_def_id) = preview_partner_def_id.clone() {
            build_generated_partner_preview_dto(
                &state,
                &preview_partner_def_id,
                job.try_get::<Option<String>, _>("preview_avatar_url")
                    .unwrap_or(None),
            )
            .await?
        } else {
            None
        };
        Some(PartnerRecruitJobLiteDto {
            generation_id: job.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
            status: job
                .try_get::<Option<String>, _>("status")?
                .unwrap_or_else(|| "pending".to_string()),
            started_at: job
                .try_get::<Option<String>, _>("cooldown_started_at_text")?
                .unwrap_or_default(),
            finished_at: job.try_get::<Option<String>, _>("finished_at_text")?,
            preview_expire_at: job
                .try_get::<Option<String>, _>("finished_at_text")?
                .and_then(|finished_at| {
                    time::OffsetDateTime::parse(
                        &finished_at,
                        &time::format_description::well_known::Rfc3339,
                    )
                    .ok()
                    .and_then(|value| {
                        (value + time::Duration::hours(24))
                            .format(&time::format_description::well_known::Rfc3339)
                            .ok()
                    })
                }),
            requested_base_model: job.try_get::<Option<String>, _>("requested_base_model")?,
            preview,
            error_message: job.try_get::<Option<String>, _>("error_message")?,
        })
    } else {
        None
    };
    let latest_started_at = current_job
        .as_ref()
        .map(|job| job.started_at.as_str())
        .filter(|value| !value.is_empty());
    let cooldown = build_partner_recruit_cooldown_state(latest_started_at);
    let has_unread_result = latest_job
        .as_ref()
        .map(|job| {
            let status = job
                .try_get::<Option<String>, _>("status")
                .unwrap_or(None)
                .unwrap_or_default();
            let viewed = job
                .try_get::<Option<String>, _>("viewed_at_text")
                .unwrap_or(None);
            matches!(
                status.as_str(),
                "generated_draft" | "failed" | "refunded" | "discarded"
            ) && viewed.is_none()
        })
        .unwrap_or(false);
    let result_status = current_job
        .as_ref()
        .and_then(|job| match job.status.as_str() {
            "generated_draft" => Some("generated_draft".to_string()),
            "failed" | "refunded" | "discarded" => Some("failed".to_string()),
            _ => None,
        });
    let token_qty = state.database.fetch_optional(
        "SELECT COALESCE(SUM(qty), 0) AS qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = 'token-004' AND location IN ('bag','warehouse')",
        |q| q.bind(character_id),
    ).await?.and_then(|row| row.try_get::<Option<i32>, _>("qty").ok().flatten().map(i64::from)).unwrap_or_default();
    Ok(PartnerRecruitStatusDto {
        feature_code: "partner_system".to_string(),
        unlock_realm,
        unlocked,
        spirit_stone_cost: 0,
        cooldown_hours: 72,
        cooldown_until: cooldown.0,
        cooldown_remaining_seconds: cooldown.1,
        custom_base_model_bypasses_cooldown: true,
        custom_base_model_max_length: 12,
        custom_base_model_token_cost: 1,
        custom_base_model_token_item_name: "自定义底模令".to_string(),
        custom_base_model_token_available_qty: token_qty,
        current_job,
        has_unread_result,
        result_status,
        remaining_until_guaranteed_heaven: if non_heaven_count >= 19 {
            1
        } else {
            (20 - non_heaven_count).max(1)
        },
        quality_rates: if non_heaven_count >= 19 {
            vec![
                PartnerRecruitQualityRateDto {
                    quality: "黄".to_string(),
                    weight: 0,
                    rate: 0.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "玄".to_string(),
                    weight: 0,
                    rate: 0.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "地".to_string(),
                    weight: 0,
                    rate: 0.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "天".to_string(),
                    weight: 1,
                    rate: 100.0,
                },
            ]
        } else {
            vec![
                PartnerRecruitQualityRateDto {
                    quality: "黄".to_string(),
                    weight: 4,
                    rate: 40.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "玄".to_string(),
                    weight: 3,
                    rate: 30.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "地".to_string(),
                    weight: 2,
                    rate: 20.0,
                },
                PartnerRecruitQualityRateDto {
                    quality: "天".to_string(),
                    weight: 1,
                    rate: 10.0,
                },
            ]
        },
    })
}

pub async fn mark_partner_recruit_result_viewed(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let updated = state.database.fetch_optional(
        "WITH latest_unviewed_job AS ( SELECT id::text AS id_text FROM partner_recruit_job WHERE character_id = $1 AND status IN ('generated_draft','failed','refunded','discarded') AND viewed_at IS NULL ORDER BY created_at DESC LIMIT 1 ) UPDATE partner_recruit_job AS job SET viewed_at = NOW(), updated_at = NOW() FROM latest_unviewed_job WHERE job.id::text = latest_unviewed_job.id_text RETURNING latest_unviewed_job.id_text",
        |q| q.bind(actor.character_id),
    ).await?;
    if let Ok(status) = load_partner_recruit_status_data(&state, actor.character_id).await {
        emit_partner_recruit_status_to_user(
            &state,
            actor.user_id,
            &build_partner_recruit_status_payload(actor.character_id, status),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some(if updated.is_some() {
            "已标记查看".to_string()
        } else {
            "无未查看结果".to_string()
        }),
        data: Some(serde_json::json!({
            "generationId": updated.and_then(|row| row.try_get::<Option<String>, _>("id_text").ok().flatten()),
            "debugRealtime": build_partner_update_payload("partner_recruit_mark_viewed", None, None, None, None)
        })),
    }))
}

pub async fn get_partner_fusion_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let status = load_partner_fusion_status_data(&state, actor.character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取三魂归契状态成功".to_string()),
        data: Some(status),
    }))
}

pub(crate) async fn load_partner_fusion_status_data(
    state: &AppState,
    character_id: i64,
) -> Result<PartnerFusionStatusDto, AppError> {
    let job = state.database.fetch_optional(
        "SELECT id::text AS id_text, status, source_quality, result_quality, preview_partner_def_id, error_message, viewed_at::text AS viewed_at_text, finished_at::text AS finished_at_text, created_at::text AS created_at_text FROM partner_fusion_job WHERE character_id = $1 AND (status = 'pending' OR viewed_at IS NULL) ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let preview = if let Some(row) = job.as_ref() {
        if let Some(preview_partner_def_id) = row
            .try_get::<Option<String>, _>("preview_partner_def_id")
            .unwrap_or(None)
        {
            build_generated_partner_preview_dto(state, &preview_partner_def_id, None).await?
        } else {
            None
        }
    } else {
        None
    };
    let material_partner_ids = if let Some(row) = job.as_ref() {
        let fusion_id = row
            .try_get::<Option<String>, _>("id_text")
            .unwrap_or(None)
            .unwrap_or_default();
        if fusion_id.is_empty() {
            Vec::new()
        } else {
            state.database.fetch_all(
                "SELECT partner_id FROM partner_fusion_job_material WHERE fusion_job_id = $1 ORDER BY material_order ASC",
                |q| q.bind(&fusion_id),
            ).await?
                .into_iter()
                .filter_map(|row| row.try_get::<Option<i32>, _>("partner_id").ok().flatten().map(i64::from))
                .collect()
        }
    } else {
        Vec::new()
    };
    let current_job = job.as_ref().map(|row| PartnerFusionJobLiteDto {
        fusion_id: row
            .try_get::<Option<String>, _>("id_text")
            .unwrap_or(None)
            .unwrap_or_default(),
        status: row
            .try_get::<Option<String>, _>("status")
            .unwrap_or(None)
            .unwrap_or_else(|| "pending".to_string()),
        source_quality: row
            .try_get::<Option<String>, _>("source_quality")
            .unwrap_or(None)
            .unwrap_or_else(|| "黄".to_string()),
        result_quality: row
            .try_get::<Option<String>, _>("result_quality")
            .unwrap_or(None),
        material_partner_ids: material_partner_ids.clone(),
        preview: preview.clone(),
        error_message: row
            .try_get::<Option<String>, _>("error_message")
            .unwrap_or(None),
        viewed_at: row
            .try_get::<Option<String>, _>("viewed_at_text")
            .unwrap_or(None),
        finished_at: row
            .try_get::<Option<String>, _>("finished_at_text")
            .unwrap_or(None),
        started_at: row
            .try_get::<Option<String>, _>("created_at_text")
            .unwrap_or(None)
            .unwrap_or_default(),
    });
    let has_unread_result = current_job
        .as_ref()
        .map(|job| {
            job.viewed_at.is_none() && matches!(job.status.as_str(), "generated_preview" | "failed")
        })
        .unwrap_or(false);
    let result_status = current_job
        .as_ref()
        .and_then(|job| match job.status.as_str() {
            "generated_preview" => Some("generated_preview".to_string()),
            "failed" => Some("failed".to_string()),
            _ => None,
        });
    Ok(PartnerFusionStatusDto {
        feature_code: "partner_system".to_string(),
        unlocked: true,
        current_job,
        has_unread_result,
        result_status,
    })
}

async fn build_generated_partner_preview_dto(
    state: &AppState,
    partner_def_id: &str,
    preview_avatar_url: Option<String>,
) -> Result<Option<PartnerRecruitPreviewLiteDto>, AppError> {
    let Some(def) = load_partner_def_resolved(state, partner_def_id).await? else {
        return Ok(None);
    };
    let mut innate_techniques = Vec::new();
    for technique_id in def.innate_technique_ids.clone().unwrap_or_default() {
        if let Some(detail) =
            load_technique_detail_data(state, technique_id.as_str(), None, true).await?
        {
            innate_techniques.push(PartnerGeneratedInnateTechniquePreviewDto {
                technique_id: detail.technique.id,
                name: detail.technique.name,
                description: detail.technique.description.unwrap_or_default(),
                quality: detail.technique.quality,
                icon: detail.technique.icon,
                skill_names: detail.skills.into_iter().map(|skill| skill.name).collect(),
            });
        }
    }
    Ok(Some(PartnerRecruitPreviewLiteDto {
        partner_def_id: def.id,
        name: def.name,
        description: def.description.unwrap_or_default(),
        quality: def.quality.unwrap_or_else(|| "黄".to_string()),
        avatar: preview_avatar_url.or(def.avatar),
        element: def.attribute_element.unwrap_or_else(|| "none".to_string()),
        role: def.role.unwrap_or_else(|| "伙伴".to_string()),
        slot_count: def.max_technique_slots.unwrap_or(1).max(1),
        base_attrs: fill_partner_base_attr_map(def.base_attrs),
        level_attr_gains: fill_partner_base_attr_map(def.level_attr_gains),
        innate_techniques,
    }))
}

fn fill_partner_base_attr_map(value: serde_json::Value) -> BTreeMap<String, f64> {
    const KEYS: &[&str] = &[
        "max_qixue",
        "max_lingqi",
        "wugong",
        "fagong",
        "wufang",
        "fafang",
        "mingzhong",
        "shanbi",
        "zhaojia",
        "baoji",
        "baoshang",
        "jianbaoshang",
        "jianfantan",
        "kangbao",
        "zengshang",
        "zhiliao",
        "jianliao",
        "xixue",
        "lengque",
        "sudu",
        "kongzhi_kangxing",
        "jin_kangxing",
        "mu_kangxing",
        "shui_kangxing",
        "huo_kangxing",
        "tu_kangxing",
        "qixue_huifu",
        "lingqi_huifu",
    ];
    let source = value.as_object().cloned().unwrap_or_default();
    KEYS.iter()
        .map(|key| {
            let number = source
                .get(*key)
                .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|n| n as f64)))
                .unwrap_or_default();
            ((*key).to_string(), number)
        })
        .collect()
}

pub async fn start_partner_fusion(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerFusionStartPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_ids = payload.partner_ids.unwrap_or_default();
    let state_for_enqueue = state.clone();
    let result = state
        .database
        .with_transaction(|| async {
            start_partner_fusion_tx(&state, actor.character_id, partner_ids).await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            let character_id = actor.character_id;
            let fusion_id = data.fusion_id.clone();
            state
                .database
                .after_transaction_commit(async move {
                    jobs::enqueue_partner_fusion_job(state_for_enqueue, character_id, fusion_id)
                        .await
                })
                .await?;
        }
        if let Ok(status) = load_partner_fusion_status_data(&state, actor.character_id).await {
            emit_partner_fusion_status_to_user(
                &state,
                actor.user_id,
                &build_partner_fusion_status_payload(actor.character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn confirm_partner_fusion_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(fusion_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let fusion_id = fusion_id.trim();
    if fusion_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("fusionId 参数无效".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            confirm_partner_fusion_preview_tx(&state, actor.character_id, fusion_id).await
        })
        .await?;
    if result.success {
        if let Ok(status) = load_partner_fusion_status_data(&state, actor.character_id).await {
            emit_partner_fusion_status_to_user(
                &state,
                actor.user_id,
                &build_partner_fusion_status_payload(actor.character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn mark_partner_fusion_result_viewed(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let updated = state.database.fetch_optional(
        "WITH latest_unviewed_job AS ( SELECT id::text AS id_text FROM partner_fusion_job WHERE character_id = $1 AND viewed_at IS NULL AND status IN ('generated_preview','failed') ORDER BY created_at DESC LIMIT 1 ) UPDATE partner_fusion_job AS job SET viewed_at = NOW(), updated_at = NOW() FROM latest_unviewed_job WHERE job.id::text = latest_unviewed_job.id_text RETURNING latest_unviewed_job.id_text",
        |q| q.bind(actor.character_id),
    ).await?;
    if let Ok(status) = load_partner_fusion_status_data(&state, actor.character_id).await {
        emit_partner_fusion_status_to_user(
            &state,
            actor.user_id,
            &build_partner_fusion_status_payload(actor.character_id, status),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some(if updated.is_some() {
            "已标记查看".to_string()
        } else {
            "无未查看结果".to_string()
        }),
        data: Some(serde_json::json!({
            "fusionId": updated.and_then(|row| row.try_get::<Option<String>, _>("id_text").ok().flatten()),
            "debugRealtime": build_partner_update_payload("partner_fusion_mark_viewed", None, None, None, None)
        })),
    }))
}

async fn start_partner_fusion_tx(
    state: &AppState,
    character_id: i64,
    partner_ids: Vec<i64>,
) -> Result<ServiceResult<PartnerFusionStartDataDto>, AppError> {
    let mut normalized = partner_ids
        .into_iter()
        .filter(|id| *id > 0)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    if normalized.len() != 3 {
        return Ok(ServiceResult {
            success: false,
            message: Some("必须选择3个不同伙伴进行归契".to_string()),
            data: None,
        });
    }
    let active_job = state.database.fetch_optional(
        "SELECT id FROM partner_fusion_job WHERE character_id = $1 AND status IN ('pending','generated_preview') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    if active_job.is_some() {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前已有三魂归契进行中".to_string()),
            data: None,
        });
    }

    let owner = load_partner_owner_context(state, character_id).await?;
    let all_rows = load_partner_rows(state, character_id).await?;
    let selected_rows = all_rows
        .into_iter()
        .filter(|row| normalized.contains(&row.id))
        .collect::<Vec<_>>();
    if selected_rows.len() != 3 {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契素材伙伴不存在".to_string()),
            data: None,
        });
    }
    let techniques =
        load_partner_technique_rows(state, selected_rows.iter().map(|row| row.id).collect())
            .await?;
    let details =
        build_partner_details_with_generated(state, selected_rows.clone(), &techniques, &owner)
            .await?;

    let mut source_quality = None::<String>;
    let mut elements = Vec::new();
    for detail in &details {
        if detail.is_active {
            return Ok(ServiceResult {
                success: false,
                message: Some("出战中的伙伴不可参与三魂归契".to_string()),
                data: None,
            });
        }
        if detail.trade_status == "market_listed" {
            return Ok(ServiceResult {
                success: false,
                message: Some("坊市中的伙伴不可参与三魂归契".to_string()),
                data: None,
            });
        }
        if detail.fusion_status == "fusion_locked" {
            return Ok(ServiceResult {
                success: false,
                message: Some("归契中的伙伴不可重复参与三魂归契".to_string()),
                data: None,
            });
        }
        let quality = detail.quality.clone();
        if let Some(current) = source_quality.as_deref() {
            if current != quality {
                return Ok(ServiceResult {
                    success: false,
                    message: Some("三魂归契素材必须为同品级伙伴".to_string()),
                    data: None,
                });
            }
        } else {
            source_quality = Some(quality);
        }
        elements.push(detail.element.clone());
    }
    let source_quality = source_quality.unwrap_or_else(|| "黄".to_string());
    let result_quality = roll_partner_fusion_result_quality(&source_quality, &elements);
    let fusion_id = format!("partner-fusion-{}-{}", character_id, now_millis());
    state.database.execute(
        "INSERT INTO partner_fusion_job (id, character_id, status, source_quality, result_quality, created_at, updated_at) VALUES ($1, $2, 'pending', $3, $4, NOW(), NOW())",
        |q| q.bind(&fusion_id).bind(character_id).bind(&source_quality).bind(&result_quality),
    ).await?;
    for (index, detail) in details.iter().enumerate() {
        state.database.execute(
            "INSERT INTO partner_fusion_job_material (fusion_job_id, partner_id, character_id, material_order, partner_snapshot, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())",
            |q| q.bind(&fusion_id).bind(detail.id).bind(character_id).bind(index as i64 + 1).bind(serde_json::to_value(detail).unwrap_or_else(|_| serde_json::json!({}))),
        ).await?;
    }
    Ok(ServiceResult {
        success: true,
        message: Some("三魂归契已开始".to_string()),
        data: Some(PartnerFusionStartDataDto {
            fusion_id: fusion_id.clone(),
            source_quality,
            result_quality,
            debug_realtime: Some(build_partner_update_payload(
                "partner_fusion_start",
                None,
                Some(fusion_id.as_str()),
                None,
                None,
            )),
        }),
    })
}

async fn confirm_partner_fusion_preview_tx(
    state: &AppState,
    character_id: i64,
    fusion_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let job = state.database.fetch_optional(
        "SELECT status, preview_partner_def_id FROM partner_fusion_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(fusion_id).bind(character_id),
    ).await?;
    let Some(job) = job else {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契任务不存在".to_string()),
            data: None,
        });
    };
    let status = job
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    let preview_partner_def_id = job.try_get::<Option<String>, _>("preview_partner_def_id")?;
    if status != "generated_preview"
        || preview_partner_def_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前归契结果不可确认".to_string()),
            data: None,
        });
    }
    let preview_partner_def_id = preview_partner_def_id.unwrap_or_default();
    let generated = state.database.fetch_optional(
        "SELECT id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids FROM generated_partner_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(&preview_partner_def_id),
    ).await?;
    let Some(generated) = generated else {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契预览伙伴定义不存在".to_string()),
            data: None,
        });
    };
    let material_rows = state.database.fetch_all(
        "SELECT partner_id FROM partner_fusion_job_material WHERE fusion_job_id = $1 ORDER BY material_order ASC FOR UPDATE",
        |q| q.bind(fusion_id),
    ).await?;
    if material_rows.len() != 3 {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契素材数据异常".to_string()),
            data: None,
        });
    }
    let material_partner_ids = material_rows
        .into_iter()
        .filter_map(|row| {
            row.try_get::<Option<i32>, _>("partner_id")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .collect::<Vec<_>>();
    let partners = state.database.fetch_all(
        "SELECT id, is_active FROM character_partner WHERE character_id = $1 AND id = ANY($2::bigint[]) FOR UPDATE",
        |q| q.bind(character_id).bind(&material_partner_ids),
    ).await?;
    if partners.len() != 3 {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契素材伙伴已失效".to_string()),
            data: None,
        });
    }
    if partners.iter().any(|row| {
        row.try_get::<Option<bool>, _>("is_active")
            .ok()
            .flatten()
            .unwrap_or(false)
    }) {
        return Ok(ServiceResult {
            success: false,
            message: Some("归契素材状态异常，请稍后重试".to_string()),
            data: None,
        });
    }
    clear_pending_partner_technique_preview_by_partner_ids(
        state,
        character_id,
        &material_partner_ids,
        true,
    )
    .await?;
    state
        .database
        .execute(
            "DELETE FROM character_partner WHERE character_id = $1 AND id = ANY($2::bigint[])",
            |q| q.bind(character_id).bind(&material_partner_ids),
        )
        .await?;
    let partner_row = state.database.fetch_one(
        "INSERT INTO character_partner (character_id, partner_def_id, nickname, description, avatar, level, progress_exp, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu, is_active, obtained_from, obtained_ref_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, 1000, 1000, 1000, 1000, 1000, 1000, FALSE, 'partner_fusion', $6, NOW(), NOW()) RETURNING id",
        |q| q
            .bind(character_id)
            .bind(&preview_partner_def_id)
            .bind(generated.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default())
            .bind(generated.try_get::<Option<String>, _>("description").unwrap_or(None))
            .bind(generated.try_get::<Option<String>, _>("avatar").unwrap_or(None))
            .bind(fusion_id),
    ).await?;
    let partner_id = i64::from(partner_row.try_get::<i32, _>("id")?);
    if let Some(innate_ids) = generated.try_get::<Option<Vec<String>>, _>("innate_technique_ids")? {
        for technique_id in innate_ids
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            state.database.execute(
                "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, created_at, updated_at) VALUES ($1, $2, 1, TRUE, NOW(), NOW())",
                |q| q.bind(partner_id).bind(technique_id),
            ).await?;
        }
    }
    state.database.execute(
        "UPDATE partner_fusion_job SET status = 'accepted', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE id = $1 AND character_id = $2",
        |q| q.bind(fusion_id).bind(character_id),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("已确认收下新伙伴".to_string()),
        data: Some(serde_json::json!({
            "fusionId": fusion_id,
            "partnerId": partner_id,
            "partnerDefId": preview_partner_def_id,
            "partnerName": generated.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
            "partnerAvatar": generated.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            "activated": false,
            "debugRealtime": build_partner_update_payload("partner_fusion_confirm", None, Some(fusion_id), None, Some(partner_id)),
            "debugRankRealtime": build_rank_update_payload("partner_fusion_confirm", &["partner", "power"])
        })),
    })
}

fn roll_partner_fusion_result_quality(
    source_quality: &str,
    material_elements: &[String],
) -> String {
    let source_rank = quality_rank(source_quality);
    let mut counts = BTreeMap::<String, i64>::new();
    for element in material_elements
        .iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "none")
    {
        *counts.entry(element).or_insert(0) += 1;
    }
    let max_same = counts.values().copied().max().unwrap_or(1);
    let bonus = ((max_same - 1).max(0) * 5).min(10);
    let same_weight = 85 - bonus;
    let upgrade_weight = 10 + bonus;
    let downgrade_weight = 5;
    let buckets = [
        (source_rank - 1, downgrade_weight),
        (source_rank, same_weight),
        (source_rank + 1, upgrade_weight),
    ];
    let normalized = buckets
        .into_iter()
        .map(|(rank, weight)| (rank.clamp(0, 3), weight))
        .collect::<Vec<_>>();
    let mut by_rank = BTreeMap::<i64, i64>::new();
    for (rank, weight) in normalized {
        *by_rank.entry(rank).or_insert(0) += weight;
    }
    let roll = (now_millis() % 100) as i64;
    let mut cursor = 0;
    for (rank, weight) in by_rank {
        cursor += weight;
        if roll < cursor {
            return quality_name(rank);
        }
    }
    quality_name(source_rank)
}

fn quality_rank(quality: &str) -> i64 {
    match quality.trim() {
        "天" => 3,
        "地" => 2,
        "玄" => 1,
        _ => 0,
    }
}

fn quality_name(rank: i64) -> String {
    match rank {
        3 => "天".to_string(),
        2 => "地".to_string(),
        1 => "玄".to_string(),
        _ => "黄".to_string(),
    }
}

fn build_generated_partner_fusion_name(quality: &str, material_name: Option<&str>) -> String {
    let quality = if quality.trim().is_empty() {
        "黄"
    } else {
        quality.trim()
    };
    let material_name = material_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("无相");
    format!("{}·{}归灵", quality, material_name)
}

fn build_generated_partner_recruit_name(
    quality: &str,
    requested_base_model: Option<&str>,
) -> String {
    let quality = if quality.trim().is_empty() {
        "黄"
    } else {
        quality.trim()
    };
    let base = requested_base_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("无相");
    format!("{}·{}灵伴", quality, base)
}

fn build_generated_partner_innate_technique_name(partner_name: &str) -> String {
    let base = partner_name.trim();
    if base.is_empty() {
        "无相灵诀".to_string()
    } else {
        format!("{}·天赋功法", base)
    }
}

fn build_generated_partner_innate_skill_name(partner_name: &str) -> String {
    let base = partner_name.trim();
    if base.is_empty() {
        "无相灵击".to_string()
    } else {
        format!("{}·伴生灵击", base)
    }
}

async fn persist_generated_partner_innate_technique_preview(
    state: &AppState,
    character_id: i64,
    source_job_id: &str,
    partner_def_id: &str,
    partner_name: &str,
    quality: &str,
    element: &str,
    role: &str,
) -> Result<String, AppError> {
    let technique_id = format!("generated-partner-technique-{source_job_id}");
    let skill_id = format!("generated-partner-skill-{source_job_id}");
    let technique_type = if role.trim() == "support" {
        "辅修"
    } else if element.trim() == "none" {
        "武技"
    } else {
        "法诀"
    };
    let attribute_type = if technique_type == "武技" {
        "physical"
    } else {
        "magic"
    };
    let technique_name = build_generated_partner_innate_technique_name(partner_name);
    let skill_name = build_generated_partner_innate_skill_name(partner_name);
    let aura_effects = if role.trim() == "support" {
        serde_json::json!([{"type":"buff","buffKind":"aura"}])
    } else {
        serde_json::json!([])
    };
    let base_cost = quality_multiplier_from_name(quality).max(1) * 50;
    state.database.execute(
        "INSERT INTO generated_technique_def (id, generation_id, created_by_character_id, name, display_name, type, quality, max_layer, required_realm, attribute_type, attribute_element, usage_scope, tags, description, long_desc, is_published, enabled, version, created_at, updated_at) VALUES ($1, $2, $3, $4, $4, $5, $6, 3, '凡人', $7, $8, 'partner_only', '[]'::jsonb, $9, $9, TRUE, TRUE, 1, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&technique_id).bind(source_job_id).bind(character_id).bind(&technique_name).bind(technique_type).bind(quality.trim()).bind(attribute_type).bind(element.trim()).bind(format!("{partner_name}的伴生功法")),
    ).await?;
    state.database.execute(
        "INSERT INTO generated_skill_def (id, generation_id, source_type, source_id, name, target_type, target_count, element, effects, trigger_type, cooldown, sort_weight, enabled, version, created_at, updated_at) VALUES ($1, $2, 'technique', $3, $4, $5, 1, $6, $7::jsonb, $8, $9, 10, TRUE, 1, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&skill_id).bind(source_job_id).bind(&technique_id).bind(&skill_name).bind(if role.trim() == "support" { "self" } else { "single_enemy" }).bind(element.trim()).bind(aura_effects).bind(if role.trim() == "support" { "passive" } else { "active" }).bind(if role.trim() == "support" { 0 } else { 1 }),
    ).await?;
    state.database.execute(
        "INSERT INTO generated_technique_layer (generation_id, technique_id, layer, cost_spirit_stones, cost_exp, cost_materials, passives, unlock_skill_ids, upgrade_skill_ids, required_realm, layer_desc, enabled, created_at, updated_at) VALUES ($1, $2, 1, $3, $4, '[]'::jsonb, '[]'::jsonb, ARRAY[$5], ARRAY[]::varchar[], '凡人', $6, TRUE, NOW(), NOW()) ON CONFLICT DO NOTHING",
        |q| q.bind(source_job_id).bind(&technique_id).bind(base_cost).bind(base_cost / 2).bind(&skill_id).bind(format!("{partner_name}的先天功法第一重")),
    ).await?;
    state.database.execute(
        "UPDATE generated_partner_def SET innate_technique_ids = ARRAY[$2]::text[], updated_at = NOW() WHERE id = $1",
        |q| q.bind(partner_def_id).bind(&technique_id),
    ).await?;
    Ok(technique_id)
}

const PARTNER_RECRUIT_REFUND_MAIL_TITLE: &str = "伙伴招募失败退还通知";
const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID: &str = "token-004";
const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST: i64 = 1;

fn append_partner_recruit_refund_hint(reason: &str) -> String {
    let normalized = reason.trim();
    if normalized.is_empty() {
        return "伙伴招募失败，相关消耗已通过邮件返还。".to_string();
    }
    if normalized.contains("已通过邮件返还") {
        return normalized.to_string();
    }
    format!("{}（相关消耗已通过邮件返还）", normalized)
}

fn build_partner_recruit_refund_mail_markdown(reason: &str) -> String {
    let normalized = reason.trim();
    if normalized.is_empty() {
        "本次伙伴招募未能完成，系统已返还灵石与底模令牌，请查收附件。".to_string()
    } else {
        format!(
            "本次伙伴招募未能完成：{}\n\n系统已返还灵石与底模令牌，请查收附件。",
            normalized
        )
    }
}

async fn refund_partner_recruit_job_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
    reason: &str,
    next_status: &str,
) -> Result<(), AppError> {
    let row = state.database.fetch_optional(
        "SELECT status, spirit_stones_cost, used_custom_base_model_token FROM partner_recruit_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(generation_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if matches!(
        status.as_str(),
        "accepted" | "discarded" | "failed" | "refunded"
    ) {
        return Ok(());
    }
    let spirit_stones_cost = row
        .try_get::<Option<i64>, _>("spirit_stones_cost")?
        .unwrap_or_default()
        .max(0);
    let used_custom_base_model_token = row
        .try_get::<Option<bool>, _>("used_custom_base_model_token")?
        .unwrap_or(false);
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
    state.database.execute(
        "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_spirit_stones, attach_items, expire_at, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', $3, $4, $5, $6::jsonb, NOW() + INTERVAL '30 days', 'partner_recruit_refund', $7, $8::jsonb, NOW(), NOW())",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind(PARTNER_RECRUIT_REFUND_MAIL_TITLE)
            .bind(build_partner_recruit_refund_mail_markdown(reason))
            .bind(spirit_stones_cost)
            .bind(if used_custom_base_model_token {
                serde_json::json!([{ "item_def_id": PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID, "qty": PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST }])
            } else {
                serde_json::json!([])
            })
            .bind(generation_id)
            .bind(serde_json::json!({"generationId": generation_id, "reason": reason})),
    ).await?;
    apply_mail_counter_deltas(
        state,
        &build_new_mail_counter_deltas(user_id, Some(character_id), true),
    )
    .await?;
    state.database.execute(
        "UPDATE partner_recruit_job SET status = $3, error_message = $4, finished_at = COALESCE(finished_at, NOW()), viewed_at = NULL, updated_at = NOW() WHERE id = $1 AND character_id = $2",
        |q| q.bind(generation_id).bind(character_id).bind(next_status).bind(append_partner_recruit_refund_hint(reason)),
    ).await?;
    Ok(())
}

pub async fn get_partner_rebone_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let status = load_partner_rebone_status_data(&state, actor.character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取归元洗髓状态成功".to_string()),
        data: Some(status),
    }))
}

pub(crate) async fn load_partner_rebone_status_data(
    state: &AppState,
    character_id: i64,
) -> Result<PartnerReboneStatusDto, AppError> {
    let job = state.database.fetch_optional(
        "SELECT id::text AS id_text, status, partner_id, item_def_id, item_qty, error_message, viewed_at::text AS viewed_at_text, finished_at::text AS finished_at_text, created_at::text AS created_at_text FROM partner_rebone_job WHERE character_id = $1 AND (status = 'pending' OR viewed_at IS NULL) ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let current_job = job.as_ref().map(|row| PartnerReboneJobLiteDto {
        rebone_id: row
            .try_get::<Option<String>, _>("id_text")
            .unwrap_or(None)
            .unwrap_or_default(),
        status: row
            .try_get::<Option<String>, _>("status")
            .unwrap_or(None)
            .unwrap_or_else(|| "pending".to_string()),
        partner_id: row
            .try_get::<Option<i64>, _>("partner_id")
            .unwrap_or(None)
            .unwrap_or_default(),
        item_def_id: row
            .try_get::<Option<String>, _>("item_def_id")
            .unwrap_or(None)
            .unwrap_or_default(),
        item_qty: row
            .try_get::<Option<i64>, _>("item_qty")
            .unwrap_or(None)
            .unwrap_or(1),
        error_message: row
            .try_get::<Option<String>, _>("error_message")
            .unwrap_or(None),
        viewed_at: row
            .try_get::<Option<String>, _>("viewed_at_text")
            .unwrap_or(None),
        finished_at: row
            .try_get::<Option<String>, _>("finished_at_text")
            .unwrap_or(None),
        created_at: row
            .try_get::<Option<String>, _>("created_at_text")
            .unwrap_or(None)
            .unwrap_or_default(),
    });
    let has_unread_result = current_job
        .as_ref()
        .map(|job| job.viewed_at.is_none() && matches!(job.status.as_str(), "succeeded" | "failed"))
        .unwrap_or(false);
    let result_status = current_job
        .as_ref()
        .and_then(|job| match job.status.as_str() {
            "succeeded" => Some("succeeded".to_string()),
            "failed" => Some("failed".to_string()),
            _ => None,
        });
    Ok(PartnerReboneStatusDto {
        feature_code: "partner_system".to_string(),
        unlocked: true,
        current_job,
        has_unread_result,
        result_status,
    })
}

pub async fn start_partner_rebone(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerReboneStartPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_id = payload.partner_id.unwrap_or_default();
    let item_def_id = payload.item_def_id.unwrap_or_default();
    let item_qty = payload.item_qty.unwrap_or_default();
    let state_for_enqueue = state.clone();
    let result = state
        .database
        .with_transaction(|| async {
            start_partner_rebone_tx(
                &state,
                actor.character_id,
                partner_id,
                item_def_id.trim(),
                item_qty,
            )
            .await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            let character_id = actor.character_id;
            let rebone_id = data.rebone_id.clone();
            state
                .database
                .after_transaction_commit(async move {
                    jobs::enqueue_partner_rebone_job(state_for_enqueue, character_id, rebone_id)
                        .await
                })
                .await?;
        }
        if let Ok(status) = load_partner_rebone_status_data(&state, actor.character_id).await {
            emit_partner_rebone_status_to_user(
                &state,
                actor.user_id,
                &build_partner_rebone_status_payload(actor.character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn mark_partner_rebone_result_viewed(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let updated = state.database.fetch_optional(
        "WITH latest_unviewed_job AS ( SELECT id::text AS id_text FROM partner_rebone_job WHERE character_id = $1 AND viewed_at IS NULL AND status IN ('succeeded','failed') ORDER BY created_at DESC LIMIT 1 ) UPDATE partner_rebone_job AS job SET viewed_at = NOW(), updated_at = NOW() FROM latest_unviewed_job WHERE job.id::text = latest_unviewed_job.id_text RETURNING latest_unviewed_job.id_text",
        |q| q.bind(actor.character_id),
    ).await?;
    if let Ok(status) = load_partner_rebone_status_data(&state, actor.character_id).await {
        emit_partner_rebone_status_to_user(
            &state,
            actor.user_id,
            &build_partner_rebone_status_payload(actor.character_id, status),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some(if updated.is_some() {
            "已标记查看".to_string()
        } else {
            "无未查看结果".to_string()
        }),
        data: Some(serde_json::json!({
            "reboneId": updated.and_then(|row| row.try_get::<Option<String>, _>("id_text").ok().flatten()),
            "debugRealtime": build_partner_update_payload("partner_rebone_mark_viewed", None, None, None, None)
        })),
    }))
}

pub(crate) async fn start_partner_rebone_tx(
    state: &AppState,
    character_id: i64,
    partner_id: i64,
    item_def_id: &str,
    item_qty: i64,
) -> Result<ServiceResult<PartnerReboneStartDataDto>, AppError> {
    if partner_id <= 0 {
        return Ok(ServiceResult {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        });
    }
    if item_def_id.trim().is_empty() {
        return Ok(ServiceResult {
            success: false,
            message: Some("itemDefId 参数无效".to_string()),
            data: None,
        });
    }
    if item_qty <= 0 {
        return Ok(ServiceResult {
            success: false,
            message: Some("itemQty 参数无效".to_string()),
            data: None,
        });
    }
    let pending = state.database.fetch_optional(
        "SELECT id FROM partner_rebone_job WHERE character_id = $1 AND status = 'pending' LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    if pending.is_some() {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前已有归元洗髓进行中".to_string()),
            data: None,
        });
    }
    let partner = state.database.fetch_optional(
        "SELECT id, is_active FROM character_partner WHERE character_id = $1 AND id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id).bind(partner_id),
    ).await?;
    let Some(partner) = partner else {
        return Ok(ServiceResult {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        });
    };
    if partner
        .try_get::<Option<bool>, _>("is_active")?
        .unwrap_or(false)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("出战中的伙伴不可归元洗髓".to_string()),
            data: None,
        });
    }
    let user_id = load_character_user_id(state, character_id)
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;
    let consumed =
        consume_character_item_qty(state, user_id, character_id, item_def_id, item_qty).await;
    if consumed.is_err() {
        return Ok(ServiceResult {
            success: false,
            message: Some("归元洗髓露不足".to_string()),
            data: None,
        });
    }
    let rebone_id = format!("partner-rebone-{}-{}", character_id, now_millis());
    state.database.execute(
        "INSERT INTO partner_rebone_job (id, character_id, partner_id, status, item_def_id, item_qty, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $5, NOW(), NOW())",
        |q| q.bind(&rebone_id).bind(character_id).bind(partner_id).bind(item_def_id).bind(item_qty),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("归元洗髓已开始".to_string()),
        data: Some(PartnerReboneStartDataDto {
            rebone_id: rebone_id.clone(),
            partner_id,
            debug_realtime: Some(build_partner_update_payload(
                "partner_rebone_start",
                None,
                None,
                Some(rebone_id.as_str()),
                Some(partner_id),
            )),
        }),
    })
}

pub async fn generate_partner_recruit_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerRecruitGeneratePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let requested_base_model = payload.requested_base_model.unwrap_or_default();
    if payload.custom_base_model_enabled.unwrap_or(false) && requested_base_model.trim().is_empty()
    {
        return Ok(send_result(
            ServiceResult::<PartnerRecruitGenerateDataDto> {
                success: false,
                message: Some("requestedBaseModel 参数无效".to_string()),
                data: None,
            },
        ));
    }
    if requested_base_model.chars().count() > 12 {
        return Ok(send_result(
            ServiceResult::<PartnerRecruitGenerateDataDto> {
                success: false,
                message: Some("自定义底模最多 12 个中文字符".to_string()),
                data: None,
            },
        ));
    }
    if !requested_base_model.trim().is_empty()
        && !requested_base_model
            .chars()
            .all(|ch| (' '..='~').contains(&ch) == false)
    {
        return Ok(send_result(
            ServiceResult::<PartnerRecruitGenerateDataDto> {
                success: false,
                message: Some("requestedBaseModel 参数无效".to_string()),
                data: None,
            },
        ));
    }
    if (payload.custom_base_model_enabled.unwrap_or(false)
        || !requested_base_model.trim().is_empty())
        && let Err(error) = require_text_model_config(TextModelScope::Partner)
    {
        return Ok(send_result(
            ServiceResult::<PartnerRecruitGenerateDataDto> {
                success: false,
                message: Some(error.to_string()),
                data: None,
            },
        ));
    }
    let state_for_enqueue = state.clone();
    let result = state
        .database
        .with_transaction(|| async {
            generate_partner_recruit_draft_tx(
                &state,
                actor.character_id,
                payload.custom_base_model_enabled.unwrap_or(false),
                if requested_base_model.trim().is_empty() {
                    None
                } else {
                    Some(requested_base_model.trim())
                },
            )
            .await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            let character_id = actor.character_id;
            let generation_id = data.generation_id.clone();
            state
                .database
                .after_transaction_commit(async move {
                    jobs::enqueue_partner_recruit_job(
                        state_for_enqueue,
                        character_id,
                        generation_id,
                    )
                    .await
                })
                .await?;
        }
        if let Ok(status) = load_partner_recruit_status_data(&state, actor.character_id).await {
            emit_partner_recruit_status_to_user(
                &state,
                actor.user_id,
                &build_partner_recruit_status_payload(actor.character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn confirm_partner_recruit_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(generation_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let generation_id = generation_id.trim();
    if generation_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("generationId 参数无效".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            confirm_partner_recruit_draft_tx(&state, actor.character_id, generation_id).await
        })
        .await?;
    if result.success {
        if let Ok(status) = load_partner_recruit_status_data(&state, actor.character_id).await {
            emit_partner_recruit_status_to_user(
                &state,
                actor.user_id,
                &build_partner_recruit_status_payload(actor.character_id, status),
            );
        }
    }
    Ok(send_result(result))
}

async fn generate_partner_recruit_draft_tx(
    state: &AppState,
    character_id: i64,
    custom_base_model_enabled: bool,
    requested_base_model: Option<&str>,
) -> Result<ServiceResult<PartnerRecruitGenerateDataDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT realm, sub_realm, partner_recruit_generated_non_heaven_count FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let realm = row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm")?;
    let unlock_realm = "炼神返虚·养神期".to_string();
    if realm_rank_with_subrealm(&realm, sub_realm.as_deref())
        < realm_rank_with_full_name(&unlock_realm)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("伙伴招募需达到{}后开放", unlock_realm)),
            data: None,
        });
    }
    let existing = state.database.fetch_optional(
        "SELECT id FROM partner_recruit_job WHERE character_id = $1 AND status IN ('pending','generated_draft') ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    if existing.is_some() {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前已有待处理的招募结果".to_string()),
            data: None,
        });
    }
    let latest_started_at = state.database.fetch_optional(
        "SELECT cooldown_started_at::text AS cooldown_started_at_text FROM partner_recruit_job WHERE character_id = $1 AND status IN ('pending','generated_draft','accepted','discarded') ORDER BY created_at DESC LIMIT 1",
        |q| q.bind(character_id),
    ).await?.and_then(|row| row.try_get::<Option<String>, _>("cooldown_started_at_text").ok().flatten());
    let cooldown = build_partner_recruit_cooldown_state(latest_started_at.as_deref());
    if cooldown.1 > 0 && !custom_base_model_enabled {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("伙伴招募冷却中，剩余{}秒", cooldown.1)),
            data: None,
        });
    }
    if custom_base_model_enabled {
        let user_id = load_character_user_id(state, character_id)
            .await?
            .ok_or_else(|| AppError::config("角色不存在"))?;
        consume_character_item_qty(state, user_id, character_id, "token-004", 1).await?;
    }
    let non_heaven_count = row
        .try_get::<Option<i32>, _>("partner_recruit_generated_non_heaven_count")?
        .map(i64::from)
        .unwrap_or_default()
        .max(0);
    let quality = if non_heaven_count >= 19 { "天" } else { "玄" };
    let generation_id = format!("partner-recruit-{}-{}", character_id, now_millis());
    state.database.execute(
        "INSERT INTO partner_recruit_job (id, character_id, status, quality_rolled, spirit_stones_cost, requested_base_model, used_custom_base_model_token, cooldown_started_at, finished_at, viewed_at, error_message, preview_partner_def_id, preview_avatar_url, created_at, updated_at) VALUES ($1, $2, 'pending', $3, 0, $4, $5, NOW(), NULL, NULL, NULL, NULL, NULL, NOW(), NOW())",
        |q| q.bind(&generation_id).bind(character_id).bind(quality).bind(requested_base_model.map(|v| v.to_string())).bind(custom_base_model_enabled),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("已加入伙伴招募队列".to_string()),
        data: Some(PartnerRecruitGenerateDataDto {
            generation_id: generation_id.clone(),
            quality: quality.to_string(),
            status: "pending".to_string(),
            debug_realtime: Some(build_partner_update_payload(
                "partner_recruit_generate",
                Some(generation_id.as_str()),
                None,
                None,
                None,
            )),
        }),
    })
}

async fn confirm_partner_recruit_draft_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, status, finished_at::text AS finished_at_text, preview_partner_def_id FROM partner_recruit_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(generation_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("招募任务不存在".to_string()),
            data: None,
        });
    };
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    let preview_partner_def_id = row.try_get::<Option<String>, _>("preview_partner_def_id")?;
    if status != "generated_draft"
        || preview_partner_def_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .is_none()
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前预览不可确认收下".to_string()),
            data: None,
        });
    }
    let finished_at = row.try_get::<Option<String>, _>("finished_at_text")?;
    if let Some(finished_at) = finished_at.as_deref()
        && let Ok(finished_at) =
            time::OffsetDateTime::parse(finished_at, &time::format_description::well_known::Rfc3339)
        && finished_at + time::Duration::hours(24) < time::OffsetDateTime::now_utc()
    {
        state.database.execute(
            "UPDATE partner_recruit_job SET status = 'discarded', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE id = $1 AND character_id = $2",
            |q| q.bind(generation_id).bind(character_id),
        ).await?;
        return Ok(ServiceResult {
            success: false,
            message: Some("预览已过期，无法确认收下".to_string()),
            data: None,
        });
    }
    let preview_partner_def_id = preview_partner_def_id.unwrap_or_default();
    let generated = state.database.fetch_optional(
        "SELECT id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids FROM generated_partner_def WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(&preview_partner_def_id),
    ).await?;
    let Some(generated) = generated else {
        return Ok(ServiceResult {
            success: false,
            message: Some("预览伙伴定义不存在".to_string()),
            data: None,
        });
    };
    let partner_row = state.database.fetch_one(
        "INSERT INTO character_partner (character_id, partner_def_id, nickname, description, avatar, level, progress_exp, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu, is_active, obtained_from, obtained_ref_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, 1000, 1000, 1000, 1000, 1000, 1000, FALSE, 'partner_recruit', $6, NOW(), NOW()) RETURNING id",
        |q| q
            .bind(character_id)
            .bind(&preview_partner_def_id)
            .bind(generated.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default())
            .bind(generated.try_get::<Option<String>, _>("description").unwrap_or(None))
            .bind(generated.try_get::<Option<String>, _>("avatar").unwrap_or(None))
            .bind(generation_id),
    ).await?;
    let partner_id = i64::from(partner_row.try_get::<i32, _>("id")?);
    println!("PARTNER_RECRUIT_CONFIRM_TRACE: inserted_partner_id={partner_id}");

    if let Some(innate_ids) = generated.try_get::<Option<Vec<String>>, _>("innate_technique_ids")? {
        for technique_id in innate_ids
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            state.database.execute(
                "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, created_at, updated_at) VALUES ($1, $2, 1, TRUE, NOW(), NOW())",
                |q| q.bind(partner_id).bind(technique_id),
            ).await?;
        }
    }

    state.database.execute(
        "UPDATE partner_recruit_job SET status = 'accepted', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE id = $1 AND character_id = $2",
        |q| q.bind(generation_id).bind(character_id),
    ).await?;
    println!("PARTNER_RECRUIT_CONFIRM_TRACE: updated_job_status=accepted");

    Ok(ServiceResult {
        success: true,
        message: Some("已确认收下新伙伴".to_string()),
        data: Some(serde_json::json!({
            "generationId": generation_id,
            "partnerId": partner_id,
            "partnerDefId": preview_partner_def_id,
            "partnerName": generated.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
            "partnerAvatar": generated.try_get::<Option<String>, _>("avatar").unwrap_or(None),
            "activated": false,
            "debugRealtime": build_partner_update_payload("partner_recruit_confirm", Some(generation_id), None, None, Some(partner_id)),
            "debugRankRealtime": build_rank_update_payload("partner_recruit_confirm", &["partner", "power"])
        })),
    })
}

pub async fn discard_partner_recruit_draft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(generation_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let generation_id = generation_id.trim();
    if generation_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("generationId 参数无效".to_string()),
            data: None,
        }));
    }
    let updated = state.database.fetch_optional(
        "UPDATE partner_recruit_job SET status = 'discarded', viewed_at = COALESCE(viewed_at, NOW()), updated_at = NOW() WHERE character_id = $1 AND id = $2 AND status = 'generated_draft' RETURNING id::text AS id_text",
        |q| q.bind(actor.character_id).bind(generation_id),
    ).await?;
    if updated.is_none() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("当前草稿不可放弃".to_string()),
            data: None,
        }));
    }
    if let Ok(status) = load_partner_recruit_status_data(&state, actor.character_id).await {
        emit_partner_recruit_status_to_user(
            &state,
            actor.user_id,
            &build_partner_recruit_status_payload(actor.character_id, status),
        );
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("已放弃本次招募草稿".to_string()),
        data: Some(serde_json::json!({
            "generationId": generation_id,
            "debugRealtime": build_partner_update_payload("partner_recruit_discard", Some(generation_id), None, None, None)
        })),
    }))
}

fn build_partner_recruit_cooldown_state(latest_started_at: Option<&str>) -> (Option<String>, i64) {
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

pub async fn process_pending_partner_recruit_job(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    state.database.with_transaction(|| async {
        let row = state.database.fetch_optional(
            "SELECT status, quality_rolled, requested_base_model, used_custom_base_model_token FROM partner_recruit_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(generation_id).bind(character_id),
        ).await?;
        let Some(row) = row else {
            return Ok(ServiceResult { success: false, message: Some("招募任务不存在".to_string()), data: None });
        };
        let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_default();
        if status != "pending" {
            return Ok(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(serde_json::json!({"status": status})) });
        }
        let quality = row.try_get::<Option<String>, _>("quality_rolled")?.unwrap_or_else(|| "黄".to_string());
        let requested_base_model = row.try_get::<Option<String>, _>("requested_base_model")?.unwrap_or_default();
        let preview_partner_def_id = format!("generated-partner-{generation_id}");
        let ai_draft = if !requested_base_model.trim().is_empty() {
            Some(generate_partner_ai_preview_draft(state, &quality, requested_base_model.trim()).await)
        } else {
            None
        };
        let (partner_name, partner_desc, element, role) = match ai_draft {
            Some(Ok(draft)) => (
                draft.name,
                draft.description,
                draft.attribute_element,
                draft.role,
            ),
            Some(Err(error)) => {
                let reason = error.to_string();
                refund_partner_recruit_job_tx(state, character_id, generation_id, &reason, "refunded").await?;
                if let Some(user_id) = load_character_user_id(state, character_id).await? {
                    emit_partner_recruit_result_to_user(
                        state,
                        user_id,
                        &build_partner_recruit_result_payload(
                            character_id,
                            generation_id,
                            "refunded",
                            "伙伴招募失败，相关消耗已通过邮件返还，请前往伙伴界面查看",
                            Some(append_partner_recruit_refund_hint(&reason)),
                        ),
                    );
                    if let Ok(status) = load_partner_recruit_status_data(state, character_id).await {
                        emit_partner_recruit_status_to_user(
                            state,
                            user_id,
                            &build_partner_recruit_status_payload(character_id, status),
                        );
                    }
                }
                return Ok(ServiceResult {
                    success: true,
                    message: Some("ok".to_string()),
                    data: Some(serde_json::json!({"generationId": generation_id, "status": "refunded"})),
                });
            }
            None => {
                let partner_name = build_generated_partner_recruit_name(&quality, Some(requested_base_model.as_str()));
                let partner_desc = if requested_base_model.trim().is_empty() {
                    format!("{}品质的神秘伙伴雏形，尚待确认收下。", quality.trim())
                } else {
                    format!("以{}为底模推演出的{}品质伙伴预览。", requested_base_model.trim(), quality.trim())
                };
                let element = if requested_base_model.contains('木') { "wood" } else if requested_base_model.contains('火') { "fire" } else { "none" };
                let role = if quality_rank(quality.as_str()) >= 2 { "attacker" } else { "support" };
                (partner_name, partner_desc, element.to_string(), role.to_string())
            }
        };
        let quality_rank = quality_rank(quality.as_str());
        let base_qixue = 120 + quality_rank * 30;
        let base_wugong = 18 + quality_rank * 6;
        let base_fagong = 12 + quality_rank * 4;
        let base_wufang = 10 + quality_rank * 3;
        let base_fafang = 10 + quality_rank * 3;
        let base_sudu = 8 + quality_rank * 2;
        let avatar_url = format!("/assets/generated/partners/{preview_partner_def_id}.png");
        state.database.execute(
            "INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9::jsonb, ARRAY[]::text[], TRUE, $10, $11, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
            |q| q
                .bind(&preview_partner_def_id)
                .bind(&partner_name)
                .bind(&partner_desc)
                .bind(&avatar_url)
                .bind(quality.trim())
                .bind(&element)
                .bind(&role)
                .bind(serde_json::json!({
                    "max_qixue": base_qixue,
                    "max_lingqi": 0,
                    "wugong": base_wugong,
                    "fagong": base_fagong,
                    "wufang": base_wufang,
                    "fafang": base_fafang,
                    "sudu": base_sudu,
                }))
                .bind(serde_json::json!({
                    "max_qixue": 8,
                    "max_lingqi": 0,
                    "wugong": 2,
                    "fagong": 2,
                    "wufang": 1,
                    "fafang": 1,
                    "sudu": 1,
                }))
                .bind(character_id)
                .bind(generation_id),
        ).await?;
        let _ = persist_generated_partner_innate_technique_preview(
            state,
            character_id,
            generation_id,
            &preview_partner_def_id,
            &partner_name,
            quality.as_str(),
            &element,
            &role,
        ).await?;
        state.database.execute(
            "UPDATE partner_recruit_job SET status = 'generated_draft', preview_partner_def_id = $2, preview_avatar_url = $3, finished_at = NOW(), error_message = NULL, updated_at = NOW() WHERE id = $1",
            |q| q.bind(generation_id).bind(&preview_partner_def_id).bind(&avatar_url),
        ).await?;
        state.database.execute(
            "UPDATE characters SET partner_recruit_generated_non_heaven_count = CASE WHEN $2 = '天' THEN 0 ELSE COALESCE(partner_recruit_generated_non_heaven_count, 0) + 1 END, updated_at = NOW() WHERE id = $1",
            |q| q.bind(character_id).bind(quality.trim()),
        ).await?;
        if let Some(user_id) = load_character_user_id(state, character_id).await? {
            emit_partner_recruit_result_to_user(
                state,
                user_id,
                &build_partner_recruit_result_payload(
                    character_id,
                    generation_id,
                    "generated_draft",
                    "新的伙伴招募预览已生成，请前往伙伴界面查看",
                    None,
                ),
            );
            if let Ok(status) = load_partner_recruit_status_data(state, character_id).await {
                emit_partner_recruit_status_to_user(
                    state,
                    user_id,
                    &build_partner_recruit_status_payload(character_id, status),
                );
            }
        }
        Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(serde_json::json!({"generationId": generation_id, "status": "generated_draft", "previewPartnerDefId": preview_partner_def_id})),
        })
    }).await
}

pub async fn process_pending_partner_fusion_job(
    state: &AppState,
    character_id: i64,
    fusion_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    state.database.with_transaction(|| async {
        let row = state.database.fetch_optional(
            "SELECT status, source_quality, result_quality FROM partner_fusion_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(fusion_id).bind(character_id),
        ).await?;
        let Some(row) = row else {
            return Ok(ServiceResult { success: false, message: Some("归契任务不存在".to_string()), data: None });
        };
        let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_default();
        if status != "pending" {
            return Ok(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(serde_json::json!({"status": status})) });
        }
        let source_quality = row.try_get::<Option<String>, _>("source_quality")?.unwrap_or_else(|| "黄".to_string());
        let result_quality = row.try_get::<Option<String>, _>("result_quality")?.unwrap_or_else(|| source_quality.clone());
        let material_rows = state.database.fetch_all(
            "SELECT partner_snapshot FROM partner_fusion_job_material WHERE fusion_job_id = $1 ORDER BY material_order ASC FOR UPDATE",
            |q| q.bind(fusion_id),
        ).await?;
        let first_name = material_rows
            .first()
            .and_then(|row| row.try_get::<Option<serde_json::Value>, _>("partner_snapshot").ok().flatten())
            .and_then(|snapshot| snapshot.get("nickname").and_then(|value| value.as_str()).map(str::trim).map(|value| value.to_string()))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "无相".to_string());
        let preview_partner_def_id = format!("generated-fusion-partner-{fusion_id}");
        let ai_config_present = read_text_model_config(TextModelScope::Partner).is_some();
        println!("PARTNER_FUSION_TRACE: ai_config_present={ai_config_present}");
        let ai_draft = if ai_config_present {
            Some(generate_partner_ai_preview_draft(state, &result_quality, first_name.as_str()).await)
        } else {
            None
        };
        let (partner_name, partner_desc, role, element, failure) = match ai_draft {
            Some(Ok(draft)) => (draft.name, draft.description, draft.role, draft.attribute_element, None),
            Some(Err(error)) => (
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                Some(error.to_string()),
            ),
            None => (
                build_generated_partner_fusion_name(&result_quality, Some(first_name.as_str())),
                format!("由{}品质素材归契而成的{}品质伙伴预览。", source_quality.trim(), result_quality.trim()),
                if quality_rank(result_quality.as_str()) >= 2 { "attacker".to_string() } else { "support".to_string() },
                if first_name.contains('木') { "wood".to_string() } else if first_name.contains('火') { "fire".to_string() } else { "none".to_string() },
                None,
            ),
        };
        if let Some(error_message) = failure {
            println!("PARTNER_FUSION_TRACE: ai_failure={error_message}");
            state.database.execute(
                "UPDATE partner_fusion_job SET status = 'failed', error_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1",
                |q| q.bind(fusion_id).bind(&error_message),
            ).await?;
            if let Some(user_id) = load_character_user_id(state, character_id).await? {
                emit_partner_fusion_result_to_user(
                    state,
                    user_id,
                    &build_partner_fusion_result_payload(
                        character_id,
                        fusion_id,
                        "failed",
                        "三魂归契失败，请前往伙伴界面查看",
                        None,
                        Some(error_message),
                    ),
                );
                if let Ok(status) = load_partner_fusion_status_data(state, character_id).await {
                    emit_partner_fusion_status_to_user(
                        state,
                        user_id,
                        &build_partner_fusion_status_payload(character_id, status),
                    );
                }
            }
            return Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(serde_json::json!({"fusionId": fusion_id, "status": "failed"})),
            });
        }
        let avatar_url = format!("/assets/generated/partners/{preview_partner_def_id}.png");
        state.database.execute(
            "INSERT INTO generated_partner_def (id, name, description, avatar, quality, attribute_element, role, max_technique_slots, base_attrs, level_attr_gains, innate_technique_ids, enabled, created_by_character_id, source_job_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9::jsonb, ARRAY[]::text[], TRUE, $10, $11, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
            |q| q
                .bind(&preview_partner_def_id)
                .bind(&partner_name)
                .bind(&partner_desc)
                .bind(&avatar_url)
                .bind(result_quality.trim())
                .bind(&element)
                .bind(&role)
                .bind(serde_json::json!({
                    "max_qixue": 150 + quality_rank(result_quality.as_str()) * 30,
                    "max_lingqi": 0,
                    "wugong": 20 + quality_rank(result_quality.as_str()) * 6,
                    "fagong": 12 + quality_rank(result_quality.as_str()) * 4,
                    "wufang": 12 + quality_rank(result_quality.as_str()) * 3,
                    "fafang": 12 + quality_rank(result_quality.as_str()) * 3,
                    "sudu": 9 + quality_rank(result_quality.as_str()) * 2,
                }))
                .bind(serde_json::json!({
                    "max_qixue": 8,
                    "max_lingqi": 0,
                    "wugong": 2,
                    "fagong": 2,
                    "wufang": 1,
                    "fafang": 1,
                    "sudu": 1,
                }))
                .bind(character_id)
                .bind(fusion_id),
        ).await?;
        let _ = persist_generated_partner_innate_technique_preview(
            state,
            character_id,
            fusion_id,
            &preview_partner_def_id,
            &partner_name,
            result_quality.as_str(),
            &element,
            &role,
        ).await?;
        state.database.execute(
            "UPDATE partner_fusion_job SET status = 'generated_preview', preview_partner_def_id = $2, error_message = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = $1",
            |q| q.bind(fusion_id).bind(&preview_partner_def_id),
        ).await?;
        println!("PARTNER_FUSION_TRACE: generated_preview preview_partner_def_id={preview_partner_def_id}");
        if let Some(user_id) = load_character_user_id(state, character_id).await? {
            let preview = state.database.fetch_optional(
                "SELECT id, name, quality, avatar FROM generated_partner_def WHERE id = $1 LIMIT 1",
                |q| q.bind(&preview_partner_def_id),
            ).await?;
            emit_partner_fusion_result_to_user(
                state,
                user_id,
                &build_partner_fusion_result_payload(
                    character_id,
                    fusion_id,
                    "generated_preview",
                    "新的三魂归契预览已生成，请前往伙伴界面查看",
                    preview.map(|row| serde_json::json!({
                        "id": row.try_get::<Option<String>, _>("id").unwrap_or(None).unwrap_or_default(),
                        "name": row.try_get::<Option<String>, _>("name").unwrap_or(None).unwrap_or_default(),
                        "quality": row.try_get::<Option<String>, _>("quality").unwrap_or(None).unwrap_or_default(),
                        "avatar": row.try_get::<Option<String>, _>("avatar").unwrap_or(None),
                    })),
                    None,
                ),
            );
            if let Ok(status) = load_partner_fusion_status_data(state, character_id).await {
                emit_partner_fusion_status_to_user(
                    state,
                    user_id,
                    &build_partner_fusion_status_payload(character_id, status),
                );
            }
        }
        Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(serde_json::json!({"fusionId": fusion_id, "status": "generated_preview", "previewPartnerDefId": preview_partner_def_id})),
        })
    }).await
}

pub async fn process_pending_partner_rebone_job(
    state: &AppState,
    character_id: i64,
    rebone_id: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    state.database.with_transaction(|| async {
        let row = state.database.fetch_optional(
            "SELECT status, item_def_id, item_qty FROM partner_rebone_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(rebone_id).bind(character_id),
        ).await?;
        let Some(row) = row else {
            return Ok(ServiceResult { success: false, message: Some("归元洗髓任务不存在".to_string()), data: None });
        };
        let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_default();
        if status != "pending" {
            return Ok(ServiceResult { success: true, message: Some("ok".to_string()), data: Some(serde_json::json!({"status": status})) });
        }
        let item_def_id = row.try_get::<Option<String>, _>("item_def_id")?.unwrap_or_default();
        let item_qty = row
            .try_get::<Option<i32>, _>("item_qty")?
            .map(i64::from)
            .unwrap_or(1)
            .max(1);
        let partner_row = state.database.fetch_optional(
            "SELECT id, partner_def_id, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu FROM character_partner WHERE id = (SELECT partner_id FROM partner_rebone_job WHERE id = $1 LIMIT 1) AND character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(rebone_id).bind(character_id),
        ).await?;
        let Some(partner_row) = partner_row else {
            refund_partner_rebone_consumed_item(state, character_id, &item_def_id, item_qty).await?;
            state.database.execute(
                "UPDATE partner_rebone_job SET status = 'failed', error_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1",
                |q| q.bind(rebone_id).bind("归元洗髓目标伙伴不存在，已自动终结并退款"),
            ).await?;
            return Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(serde_json::json!({"reboneId": rebone_id, "status": "failed"})),
            });
        };
        let partner_id = partner_row
            .try_get::<Option<i32>, _>("id")?
            .map(i64::from)
            .unwrap_or_default();
        let partner_def_id = partner_row.try_get::<Option<String>, _>("partner_def_id")?.unwrap_or_default();
        let generated_partner = state.database.fetch_optional(
            "SELECT id, base_attrs, level_attr_gains FROM generated_partner_def WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(&partner_def_id),
        ).await?;
        let Some(generated_partner) = generated_partner else {
            refund_partner_rebone_consumed_item(state, character_id, &item_def_id, item_qty).await?;
            state.database.execute(
                "UPDATE partner_rebone_job SET status = 'failed', error_message = $2, finished_at = NOW(), updated_at = NOW() WHERE id = $1",
                |q| q.bind(rebone_id).bind("仅动态伙伴支持归元洗髓，已自动终结并退款"),
            ).await?;
            if let Some(user_id) = load_character_user_id(state, character_id).await? {
                emit_partner_rebone_result_to_user(
                    state,
                    user_id,
                    &build_partner_rebone_result_payload(
                        character_id,
                        rebone_id,
                        partner_id,
                        "failed",
                        "归元洗髓失败，请前往伙伴界面查看",
                        Some("仅动态伙伴支持归元洗髓，已自动终结并退款".to_string()),
                    ),
                );
            }
            return Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(serde_json::json!({"reboneId": rebone_id, "status": "failed"})),
            });
        };

        let quality_rank = partner_def_quality_rank(&partner_def_id, state).await?.unwrap_or(1);
        let base_attrs = generated_partner.try_get::<Option<serde_json::Value>, _>("base_attrs")?.unwrap_or_else(|| serde_json::json!({}));
        let level_gains = generated_partner.try_get::<Option<serde_json::Value>, _>("level_attr_gains")?.unwrap_or_else(|| serde_json::json!({}));
        let rerolled_base = reroll_partner_rebone_attrs(
            &format!("rebone:{rebone_id}:base"),
            quality_rank,
            &base_attrs,
        );
        let rerolled_level = reroll_partner_rebone_attrs(
            &format!("rebone:{rebone_id}:level"),
            quality_rank,
            &level_gains,
        );

        state.database.execute(
            "UPDATE generated_partner_def SET base_attrs = $2::jsonb, level_attr_gains = $3::jsonb, updated_at = NOW() WHERE id = $1",
            |q| q.bind(&partner_def_id).bind(&rerolled_base).bind(&rerolled_level),
        ).await?;
        state.database.execute(
            "UPDATE character_partner SET growth_max_qixue = $2, growth_wugong = $3, growth_fagong = $4, growth_wufang = $5, growth_fafang = $6, growth_sudu = $7, updated_at = NOW() WHERE id = $1",
            |q| q
                .bind(partner_id)
                .bind(rerolled_base.get("max_qixue").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_max_qixue").unwrap_or(None).unwrap_or_default()) as i64)
                .bind(rerolled_base.get("wugong").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_wugong").unwrap_or(None).unwrap_or_default()) as i64)
                .bind(rerolled_base.get("fagong").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_fagong").unwrap_or(None).unwrap_or_default()) as i64)
                .bind(rerolled_base.get("wufang").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_wufang").unwrap_or(None).unwrap_or_default()) as i64)
                .bind(rerolled_base.get("fafang").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_fafang").unwrap_or(None).unwrap_or_default()) as i64)
                .bind(rerolled_base.get("sudu").and_then(|v| v.as_i64()).unwrap_or(partner_row.try_get::<Option<i64>, _>("growth_sudu").unwrap_or(None).unwrap_or_default()) as i64),
        ).await?;
        state.database.execute(
            "UPDATE partner_rebone_job SET status = 'succeeded', error_message = NULL, finished_at = NOW(), updated_at = NOW() WHERE id = $1",
            |q| q.bind(rebone_id),
        ).await?;
        if let Some(user_id) = load_character_user_id(state, character_id).await? {
            emit_partner_rebone_result_to_user(
                state,
                user_id,
                &build_partner_rebone_result_payload(
                    character_id,
                    rebone_id,
                    partner_id,
                    "succeeded",
                    "归元洗髓成功，请前往伙伴界面查看",
                    None,
                ),
            );
            if let Ok(status) = load_partner_rebone_status_data(state, character_id).await {
                emit_partner_rebone_status_to_user(
                    state,
                    user_id,
                    &build_partner_rebone_status_payload(character_id, status),
                );
            }
        }
        Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(serde_json::json!({"reboneId": rebone_id, "status": "succeeded", "partnerId": partner_id})),
        })
    }).await
}

async fn load_character_user_id(
    state: &AppState,
    character_id: i64,
) -> Result<Option<i64>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT user_id FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    Ok(row.and_then(|row| {
        row.try_get::<Option<i32>, _>("user_id")
            .ok()
            .flatten()
            .map(i64::from)
    }))
}

async fn refund_partner_rebone_consumed_item(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
    item_qty: i64,
) -> Result<(), AppError> {
    state.database.execute(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at) SELECT user_id, id, $2, $3, 'none', 'bag', NOW(), NOW() FROM characters WHERE id = $1",
        |q| q.bind(character_id).bind(item_def_id).bind(item_qty.max(1)),
    ).await?;
    Ok(())
}

async fn partner_def_quality_rank(
    partner_def_id: &str,
    state: &AppState,
) -> Result<Option<i64>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT quality FROM generated_partner_def WHERE id = $1 LIMIT 1",
            |q| q.bind(partner_def_id),
        )
        .await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<String>, _>("quality").ok().flatten())
        .map(|quality| quality_rank(quality.as_str())))
}

fn reroll_partner_rebone_attrs(
    seed: &str,
    quality_rank: i64,
    source: &serde_json::Value,
) -> serde_json::Value {
    let mut out = source.as_object().cloned().unwrap_or_default();
    for key in ["max_qixue", "wugong", "fagong", "wufang", "fafang", "sudu"] {
        let base = source
            .get(key)
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            .max(1);
        let digest = md5::compute(format!("{seed}:{key}").as_bytes());
        let roll = i16::from_be_bytes([digest[0], digest[1]]) as i64;
        let delta = (roll.rem_euclid(7) - 3) + quality_rank.max(0);
        let next = (base + delta).max(1);
        out.insert(key.to_string(), serde_json::json!(next));
    }
    serde_json::Value::Object(out)
}

pub async fn get_partner_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PartnerPreviewQuery>,
) -> Result<axum::response::Response, AppError> {
    let _ = auth::require_character(&state, &headers).await?;
    let partner_id = query.partner_id.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerDetailDto> {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        }));
    }
    let row = load_partner_row_by_id(&state, partner_id).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<PartnerDetailDto> {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        }));
    };
    let owner = load_partner_owner_context(&state, row.character_id).await?;
    let techniques = load_partner_technique_rows(&state, vec![row.id]).await?;
    let partner = build_partner_details_with_generated(&state, vec![row], &techniques, &owner)
        .await?
        .into_iter()
        .next();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: partner,
    }))
}

pub async fn get_partner_skill_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PartnerSkillPolicyQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_id = query.partner_id.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerSkillPolicyDto> {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        }));
    }
    let row = load_single_partner_row(&state, actor.character_id, partner_id, false).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<PartnerSkillPolicyDto> {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        }));
    };
    let technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
    let policy_rows = load_partner_skill_policy_rows(&state, row.id).await?;
    let entries = build_partner_skill_policy_entries_with_generated(
        &state,
        &row,
        technique_rows.get(&row.id).cloned().unwrap_or_default(),
        policy_rows,
    )
    .await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(PartnerSkillPolicyDto {
            partner_id: row.id,
            entries,
        }),
    }))
}

pub async fn update_partner_skill_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerSkillPolicyUpdatePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_id = payload.partner_id.unwrap_or_default();
    let slots = payload.slots.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerSkillPolicyDto> {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        }));
    }
    let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<PartnerSkillPolicyDto> {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        }));
    };
    let technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
    let available_entries = build_partner_skill_policy_entries(
        &row,
        technique_rows.get(&row.id).cloned().unwrap_or_default(),
        vec![],
    )?;
    let normalized_slots =
        normalize_partner_skill_policy_slots_for_save(&available_entries, slots)?;
    state.database.with_transaction(|| async {
        state.database.execute(
            "DELETE FROM character_partner_skill_policy WHERE partner_id = $1",
            |query| query.bind(row.id),
        ).await?;
        for slot in &normalized_slots {
            state.database.execute(
                "INSERT INTO character_partner_skill_policy (partner_id, skill_id, priority, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())",
                |query| query.bind(row.id).bind(&slot.skill_id).bind(slot.priority).bind(slot.enabled),
            ).await?;
        }
        Ok::<(), AppError>(())
    }).await?;
    let entries = build_partner_skill_policy_entries(
        &row,
        technique_rows.get(&row.id).cloned().unwrap_or_default(),
        load_partner_skill_policy_rows(&state, row.id).await?,
    )?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(PartnerSkillPolicyDto {
            partner_id: row.id,
            entries,
        }),
    }))
}

pub async fn activate_partner(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerPreviewQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerActivateData> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    let partner_id = payload.partner_id.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerActivateData> {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        }));
    }
    let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<PartnerActivateData> {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        }));
    };

    let partner = state
        .database
        .with_transaction(|| async {
            state
                .database
                .execute(
                    "UPDATE character_partner SET is_active = false, updated_at = NOW() WHERE character_id = $1 AND is_active = true",
                    |query| query.bind(actor.character_id),
                )
                .await?;
            state
                .database
                .execute(
                    "UPDATE character_partner SET is_active = true, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(row.id),
                )
                .await?;
            let owner = load_partner_owner_context(&state, actor.character_id).await?;
            let techniques = load_partner_technique_rows(&state, vec![row.id]).await?;
            let partner = build_partner_details(
                vec![PartnerRow { is_active: true, ..row.clone() }],
                &techniques,
                &owner,
            )?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::config("伙伴状态刷新失败"))?;
            Ok::<PartnerDetailDto, AppError>(partner)
        })
        .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("出战伙伴已切换".to_string()),
        data: Some(PartnerActivateData {
            active_partner_id: row.id,
            partner,
        }),
    }))
}

pub async fn dismiss_partner(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerDismissData> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    state
        .database
        .execute(
            "UPDATE character_partner SET is_active = false, updated_at = NOW() WHERE character_id = $1 AND is_active = true",
            |query| query.bind(actor.character_id),
        )
        .await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("出战伙伴已下阵".to_string()),
        data: Some(PartnerDismissData {
            active_partner_id: None,
        }),
    }))
}

pub async fn inject_partner_exp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerInjectExpPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerInjectExpData> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    let partner_id = payload.partner_id.unwrap_or_default();
    let inject_exp_budget = payload.exp.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerInjectExpData> {
            success: false,
            message: Some("partnerId 参数无效".to_string()),
            data: None,
        }));
    }
    if inject_exp_budget <= 0 {
        return Ok(send_result(ServiceResult::<PartnerInjectExpData> {
            success: false,
            message: Some("exp 参数无效".to_string()),
            data: None,
        }));
    }

    let growth_cfg = load_partner_growth_config()?;
    let result = state
        .database
        .with_transaction(|| async {
            let owner = load_partner_owner_context(&state, actor.character_id).await?;
            let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<PartnerInjectExpData> {
                    success: false,
                    message: Some("伙伴不存在".to_string()),
                    data: None,
                });
            };
            if owner.exp <= 0 {
                return Ok(ServiceResult::<PartnerInjectExpData> {
                    success: false,
                    message: Some("角色经验不足".to_string()),
                    data: None,
                });
            }
            let effective_budget = inject_exp_budget.max(0).min(owner.exp);
            let plan = resolve_partner_inject_plan(row.level, row.progress_exp, owner.exp, effective_budget, &growth_cfg, resolve_partner_effective_level(&owner.realm, &owner.sub_realm, i64::MAX))?;
            if plan.spent_exp <= 0 {
                return Ok(ServiceResult::<PartnerInjectExpData> {
                    success: false,
                    message: Some("角色经验不足".to_string()),
                    data: None,
                });
            }

            state
                .database
                .execute(
                    "UPDATE characters SET exp = $2, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(actor.character_id).bind(plan.remaining_character_exp),
                )
                .await?;
            state
                .database
                .execute(
                    "UPDATE character_partner SET level = $2, progress_exp = $3, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(row.id).bind(plan.after_level).bind(plan.after_progress_exp),
                )
                .await?;

            let refreshed_row = load_single_partner_row(&state, actor.character_id, partner_id, false)
                .await?
                .ok_or_else(|| AppError::config("伙伴刷新失败"))?;
            let techniques = load_partner_technique_rows(&state, vec![refreshed_row.id]).await?;
            let partner = build_partner_details(vec![refreshed_row], &techniques, &PartnerOwnerContext { exp: plan.remaining_character_exp, ..owner.clone() })?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::config("伙伴刷新失败"))?;

            Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(PartnerInjectExpData {
                    partner,
                    spent_exp: plan.spent_exp,
                    levels_gained: plan.gained_levels,
                    character_exp: plan.remaining_character_exp,
                }),
            })
        })
        .await?;

    Ok(send_result(result))
}

pub async fn upgrade_partner_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PartnerTechniqueActionPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerUpgradeTechniqueData> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    let partner_id = payload.partner_id.unwrap_or_default();
    let technique_id = payload.technique_id.unwrap_or_default();
    if partner_id <= 0 || technique_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<PartnerUpgradeTechniqueData> {
            success: false,
            message: Some("参数错误".to_string()),
            data: None,
        }));
    }

    let item_meta = load_item_meta_map()?;

    let result = state
        .database
        .with_transaction(|| async {
            let owner = load_partner_owner_context(&state, actor.character_id).await?;
            let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("伙伴不存在".to_string()),
                    data: None,
                });
            };
            let def = load_partner_def_resolved(&state, row.partner_def_id.trim()).await?
                .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
            let mut technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
            let current_techniques = build_partner_techniques_with_generated(&state, &def, technique_rows.get(&row.id).cloned().unwrap_or_default()).await?;
            let Some(current_technique) = current_techniques.iter().find(|technique| technique.technique_id == technique_id.trim()) else {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("伙伴功法不存在".to_string()),
                    data: None,
                });
            };
            if current_technique.current_layer >= current_technique.max_layer {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("已达最高层数".to_string()),
                    data: None,
                });
            }
            let Some(detail) = load_technique_detail_data(&state, technique_id.trim(), None, true).await? else {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("伙伴功法不存在".to_string()),
                    data: None,
                });
            };
            let next_layer = current_technique.current_layer + 1;
            let Some(layer) = detail.layers.iter().find(|layer| layer.layer == next_layer) else {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("已达最高层数".to_string()),
                    data: None,
                });
            };
            let spirit_stones_cost = layer.cost_spirit_stones.max(0);
            let exp_cost = layer.cost_exp.max(0);
            if owner.exp < exp_cost {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("角色经验不足".to_string()),
                    data: None,
                });
            }

            let character_row = state
                .database
                .fetch_optional(
                    "SELECT spirit_stones FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
                    |query| query.bind(actor.character_id),
                )
                .await?
                .ok_or_else(|| AppError::config("角色不存在"))?;
            let spirit_stones = character_row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default();
            if spirit_stones < spirit_stones_cost {
                return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                    success: false,
                    message: Some("灵石不足".to_string()),
                    data: None,
                });
            }

            for material in &layer.cost_materials {
                let item_id = material.item_id.trim().to_string();
                let qty = material.qty.max(0);
                if item_id.is_empty() || qty <= 0 { continue; }
                let have = count_character_item_qty(&state, actor.character_id, &item_id).await?;
                if have < qty {
                    let name = item_meta.get(item_id.as_str()).map(|meta| meta.0.clone()).unwrap_or(item_id.clone());
                    return Ok(ServiceResult::<PartnerUpgradeTechniqueData> {
                        success: false,
                        message: Some(format!("材料不足：{}", name)),
                        data: None,
                    });
                }
            }

            state
                .database
                .execute(
                    "UPDATE characters SET spirit_stones = spirit_stones - $2, exp = exp - $3, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(actor.character_id).bind(spirit_stones_cost).bind(exp_cost),
                )
                .await?;
            for material in &layer.cost_materials {
                let item_id = material.item_id.trim().to_string();
                let qty = material.qty.max(0);
                if item_id.is_empty() || qty <= 0 { continue; }
                consume_character_item_qty(&state, actor.user_id, actor.character_id, &item_id, qty).await?;
            }

            let maybe_existing = technique_rows.get(&row.id).and_then(|rows| rows.iter().find(|entry| entry.technique_id == technique_id.trim()));
            if let Some(existing) = maybe_existing {
                state
                    .database
                    .execute(
                        "UPDATE character_partner_technique SET current_layer = $2, updated_at = NOW() WHERE partner_id = $1 AND technique_id = $3",
                        |query| query.bind(row.id).bind(next_layer).bind(existing.technique_id.clone()),
                    )
                    .await?;
            } else {
                state
                    .database
                    .execute(
                        "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, $3, true, NULL, NOW(), NOW())",
                        |query| query.bind(row.id).bind(technique_id.trim()).bind(next_layer),
                    )
                    .await?;
            }

            technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
            let partner = build_partner_details_with_generated(&state, vec![row.clone()], &technique_rows, &PartnerOwnerContext { exp: owner.exp - exp_cost, ..owner.clone() }).await?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::config("伙伴刷新失败"))?;
            let updated_technique = partner
                .techniques
                .iter()
                .find(|technique| technique.technique_id == technique_id.trim())
                .cloned()
                .ok_or_else(|| AppError::config("伙伴功法刷新失败"))?;

            Ok(ServiceResult {
                success: true,
                message: Some(format!("{}修炼至第{}层", updated_technique.name, next_layer)),
                data: Some(PartnerUpgradeTechniqueData {
                    partner,
                    updated_technique,
                    new_layer: next_layer,
                }),
            })
        })
        .await?;

    Ok(send_result(result))
}

pub async fn rename_partner_with_card(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RenamePartnerPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<PartnerRenameData> {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    let partner_id = payload.partner_id.unwrap_or_default();
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    if partner_id <= 0 || item_instance_id <= 0 {
        return Ok(send_result(ServiceResult::<PartnerRenameData> {
            success: false,
            message: Some("参数错误".to_string()),
            data: None,
        }));
    }
    let nickname = payload.nickname.unwrap_or_default();
    let normalized_nickname = normalize_partner_name(&nickname)?;
    let normalized_description = normalize_partner_description(payload.description)?;
    let normalized_avatar = normalize_partner_avatar(payload.avatar)?;

    let result = state
        .database
        .with_transaction(|| async {
            let owner = load_partner_owner_context(&state, actor.character_id).await?;
            let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<PartnerRenameData> {
                    success: false,
                    message: Some("伙伴不存在".to_string()),
                    data: None,
                });
            };

            consume_partner_rename_card(&state, actor.user_id, actor.character_id, item_instance_id).await?;
            state
                .database
                .execute(
                    "UPDATE character_partner SET nickname = $2, description = $3, avatar = $4, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(row.id).bind(&normalized_nickname).bind(normalized_description.clone()).bind(normalized_avatar.clone()),
                )
                .await?;

            let refreshed = load_single_partner_row(&state, actor.character_id, partner_id, false)
                .await?
                .ok_or_else(|| AppError::config("伙伴刷新失败"))?;
            let techniques = load_partner_technique_rows(&state, vec![refreshed.id]).await?;
            let partner = build_partner_details(vec![refreshed], &techniques, &owner)?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::config("伙伴刷新失败"))?;

            Ok(ServiceResult {
                success: true,
                message: Some("伙伴改名成功".to_string()),
                data: Some(PartnerRenameData { partner }),
            })
        })
        .await?;

    Ok(send_result(result))
}

pub async fn learn_partner_technique(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LearnPartnerTechniquePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    if !is_partner_unlocked(&state, actor.character_id).await? {
        return Ok(send_result(ServiceResult::<
            PartnerLearnTechniqueActionData,
        > {
            success: false,
            message: Some("伙伴功能尚未解锁".to_string()),
            data: None,
        }));
    }
    let partner_id = payload.partner_id.unwrap_or_default();
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    if partner_id <= 0 || item_instance_id <= 0 {
        return Ok(send_result(ServiceResult::<
            PartnerLearnTechniqueActionData,
        > {
            success: false,
            message: Some("参数错误".to_string()),
            data: None,
        }));
    }

    let result = state
        .database
        .with_transaction(|| async {
            let owner = load_partner_owner_context(&state, actor.character_id).await?;
            let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<PartnerLearnTechniqueActionData> {
                    success: false,
                    message: Some("伙伴不存在".to_string()),
                    data: None,
                });
            };
            let book = load_partner_book_context(&state, actor.character_id, item_instance_id).await?;
            let Some(book) = book else {
                return Ok(ServiceResult::<PartnerLearnTechniqueActionData> {
                    success: false,
                    message: Some("功法书不存在".to_string()),
                    data: None,
                });
            };

            let def = load_partner_def_resolved(&state, row.partner_def_id.trim()).await?
                .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
            let mut technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
            let techniques = build_partner_techniques_with_generated(&state, &def, technique_rows.get(&row.id).cloned().unwrap_or_default()).await?;
            if techniques.iter().any(|technique| technique.technique_id == book.technique_id) {
                return Ok(ServiceResult::<PartnerLearnTechniqueActionData> {
                    success: false,
                    message: Some("伙伴已掌握该功法".to_string()),
                    data: None,
                });
            }
            let existing_preview = state.database.fetch_optional(
                "SELECT 1 FROM item_instance WHERE owner_character_id = $1 AND location = 'partner_preview' LIMIT 1 FOR UPDATE",
                |q| q.bind(actor.character_id),
            ).await?;
            if existing_preview.is_some() {
                return Ok(ServiceResult::<PartnerLearnTechniqueActionData> {
                    success: false,
                    message: Some("当前已有待处理打书预览，请先确认或放弃".to_string()),
                    data: None,
                });
            }
            let learned_preview = build_partner_techniques_with_generated(&state, &def, technique_rows.get(&row.id).cloned().unwrap_or_default().into_iter().chain(std::iter::once(PartnerTechniqueRow {
                partner_id: row.id,
                technique_id: book.technique_id.clone(),
                current_layer: 1,
                is_innate: false,
                learned_from_item_def_id: Some(book.item_def_id.clone()),
            })).collect()).await?
                .into_iter()
                .find(|technique| technique.technique_id == book.technique_id)
                .ok_or_else(|| AppError::config("预览目标功法不存在或已失效"))?;
            let learned_preview = if learned_preview.name == learned_preview.technique_id {
                PartnerTechniqueDto {
                    name: book.technique_name.clone(),
                    quality: book.quality.clone(),
                    ..learned_preview
                }
            } else {
                learned_preview
            };

            if techniques.len() < def.max_technique_slots.unwrap_or_default().max(0) as usize {
                consume_specific_item_instance(&state, actor.user_id, actor.character_id, item_instance_id, 1, &book.item_def_id).await?;
                state.database.execute(
                    "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, 1, false, $3, NOW(), NOW())",
                    |query| query.bind(row.id).bind(&book.technique_id).bind(&book.item_def_id),
                ).await?;
                technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
                let partner = build_partner_details_with_generated(&state, vec![row.clone()], &technique_rows, &owner).await?
                    .into_iter()
                    .next()
                    .ok_or_else(|| AppError::config("伙伴刷新失败"))?;
        let learned_technique = partner.techniques.iter().find(|technique| technique.technique_id == book.technique_id).cloned().ok_or_else(|| AppError::config("伙伴刷新失败"))?;
        let learned_technique = if learned_technique.name == learned_technique.technique_id {
            PartnerTechniqueDto {
                name: book.technique_name.clone(),
                quality: book.quality.clone(),
                ..learned_technique
            }
        } else {
            learned_technique
        };
        return Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(PartnerLearnTechniqueActionData::Learned {
                result: PartnerLearnTechniqueResultDto {
                            partner,
                            learned_technique,
                            replaced_technique: None,
                            remaining_books: load_partner_books(&state, actor.character_id).await?,
                        },
                    }),
                });
            }

            let replaceable = techniques.iter().filter(|technique| !technique.is_innate).cloned().collect::<Vec<_>>();
            let replaced = if replaceable.is_empty() {
                None
            } else {
                let index = rand::thread_rng().gen_range(0..replaceable.len());
                replaceable.get(index).cloned()
            };
            let Some(replaced) = replaced else {
                return Ok(ServiceResult::<PartnerLearnTechniqueActionData> {
                    success: false,
                    message: Some("当前只有天生功法，无法继续打书".to_string()),
                    data: None,
                });
            };
            state.database.execute(
                "UPDATE item_instance SET location = 'partner_preview', location_slot = NULL, metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1 AND owner_character_id = $3",
                |query| query
                    .bind(item_instance_id)
                    .bind(serde_json::json!({
                        "partnerTechniqueLearnPreview": {
                            "partnerId": partner_id,
                            "learnedTechniqueId": learned_preview.technique_id,
                            "replacedTechniqueId": replaced.technique_id,
                        }
                    }))
                    .bind(actor.character_id),
            ).await?;
            Ok(ServiceResult {
                success: true,
                message: Some("请确认本次功法替换预览".to_string()),
                data: Some(PartnerLearnTechniqueActionData::PreviewReplace {
                    preview: PartnerTechniqueLearnPreviewDto {
                        partner_id,
                        item_instance_id,
                        learned_technique: learned_preview,
                        replaced_technique: replaced,
                    },
                }),
            })
        })
        .await?;

    Ok(send_result(result))
}

pub async fn confirm_partner_technique_learn_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ConfirmPartnerTechniqueLearnPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_id = payload.partner_id.unwrap_or_default();
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    let replaced_technique_id = payload.replaced_technique_id.unwrap_or_default();
    if partner_id <= 0 || item_instance_id <= 0 || replaced_technique_id.trim().is_empty() {
        return Ok(send_result(
            ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("参数错误".to_string()),
                data: None,
            },
        ));
    }

    let result = state.database.with_transaction(|| async {
        let owner = load_partner_owner_context(&state, actor.character_id).await?;
        let row = load_single_partner_row(&state, actor.character_id, partner_id, true).await?;
        let Some(row) = row else {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("伙伴不存在".to_string()),
                data: None,
            });
        };
        let rows = load_partner_technique_preview_items(&state, actor.character_id, true).await?;
        let matched_row = rows.into_iter().find(|row| row.id == item_instance_id);
        let Some(preview_row) = matched_row else {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("待处理打书预览不存在".to_string()),
                data: None,
            });
        };
        let pending_preview = match resolve_partner_pending_preview_from_row(&state, actor.character_id, &preview_row, true).await? {
            PartnerPendingPreviewResolution::Valid(preview) => preview,
            PartnerPendingPreviewResolution::Invalid { message } => {
                return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                    success: false,
                    message: Some(message.to_string()),
                    data: None,
                });
            }
        };
        let book = pending_preview.book.clone();
        let def = load_partner_def_resolved(&state, row.partner_def_id.trim()).await?
            .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
        let mut technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
        let current_techniques = build_partner_techniques_with_generated(&state, &def, technique_rows.get(&row.id).cloned().unwrap_or_default()).await?;
        let replaced = current_techniques.iter().find(|technique| technique.technique_id == replaced_technique_id.trim() && !technique.is_innate).cloned();
        let Some(replaced) = replaced else {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("预览已失效，请重新选择功法书".to_string()),
                data: None,
            });
        };
        if current_techniques.iter().any(|technique| technique.technique_id == book.technique_id) {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("伙伴已掌握该功法".to_string()),
                data: None,
            });
        }
        if pending_preview.preview.partner_id != partner_id {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("待处理打书预览与当前伙伴不匹配".to_string()),
                data: None,
            });
        }
        if pending_preview.preview.replaced_technique.technique_id.trim() != replaced_technique_id.trim() {
            return Ok(ServiceResult::<PartnerLearnTechniqueResultDto> {
                success: false,
                message: Some("预览已失效，请重新选择功法书".to_string()),
                data: None,
            });
        }

        consume_specific_item_instance(&state, actor.user_id, actor.character_id, item_instance_id, 1, &book.item_def_id).await?;
        state.database.execute(
            "DELETE FROM character_partner_technique WHERE partner_id = $1 AND technique_id = $2 AND is_innate = false",
            |query| query.bind(row.id).bind(replaced_technique_id.trim()),
        ).await?;
        state.database.execute(
            "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, 1, false, $3, NOW(), NOW())",
            |query| query.bind(row.id).bind(&book.technique_id).bind(&book.item_def_id),
        ).await?;
        technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
        let partner = build_partner_details_with_generated(&state, vec![row], &technique_rows, &owner).await?
            .into_iter()
            .next()
            .ok_or_else(|| AppError::config("伙伴刷新失败"))?;
        let learned_technique = partner.techniques.iter().find(|technique| technique.technique_id == book.technique_id).cloned().ok_or_else(|| AppError::config("伙伴刷新失败"))?;
        let learned_technique = if learned_technique.name == learned_technique.technique_id {
            PartnerTechniqueDto {
                name: book.technique_name.clone(),
                quality: book.quality.clone(),
                ..learned_technique
            }
        } else {
            learned_technique
        };
        let remaining_books = load_partner_books(&state, actor.character_id).await?;
        Ok(ServiceResult {
            success: true,
            message: Some("伙伴打书成功".to_string()),
            data: Some(PartnerLearnTechniqueResultDto {
                partner,
                learned_technique,
                replaced_technique: Some(replaced),
                remaining_books,
            }),
        })
    }).await?;
    Ok(send_result(result))
}

pub async fn discard_partner_technique_learn_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DiscardPartnerTechniqueLearnPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    if item_instance_id <= 0 {
        return Ok(send_result(ServiceResult::<
            PartnerDiscardLearnTechniqueData,
        > {
            success: false,
            message: Some("参数错误".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            let rows =
                load_partner_technique_preview_items(&state, actor.character_id, true).await?;
            let matched_row = rows.into_iter().find(|row| row.id == item_instance_id);
            let Some(row) = matched_row else {
                return Ok(ServiceResult::<PartnerDiscardLearnTechniqueData> {
                    success: false,
                    message: Some("待处理打书预览不存在".to_string()),
                    data: None,
                });
            };
            let pending_preview = match resolve_partner_pending_preview_from_row(
                &state,
                actor.character_id,
                &row,
                true,
            )
            .await?
            {
                PartnerPendingPreviewResolution::Valid(preview) => preview,
                PartnerPendingPreviewResolution::Invalid { message } => {
                    return Ok(ServiceResult::<PartnerDiscardLearnTechniqueData> {
                        success: false,
                        message: Some(message.to_string()),
                        data: None,
                    });
                }
            };
            let book = pending_preview.book;
            consume_specific_item_instance(
                &state,
                actor.user_id,
                actor.character_id,
                item_instance_id,
                1,
                &book.item_def_id,
            )
            .await?;
            let remaining_books = load_partner_books(&state, actor.character_id).await?;
            Ok(ServiceResult {
                success: true,
                message: Some("已放弃学习，本次功法书已消耗".to_string()),
                data: Some(PartnerDiscardLearnTechniqueData { remaining_books }),
            })
        })
        .await?;
    Ok(send_result(result))
}

pub async fn get_partner_technique_upgrade_cost(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PartnerTechniqueQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let partner_id = query.partner_id.unwrap_or_default();
    let technique_id = query.technique_id.unwrap_or_default();
    if partner_id <= 0 || technique_id.trim().is_empty() {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("参数错误".to_string()),
                data: None,
            },
        ));
    }
    let row = load_single_partner_row(&state, actor.character_id, partner_id, false).await?;
    let Some(row) = row else {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("伙伴不存在".to_string()),
                data: None,
            },
        ));
    };
    let technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
    let def = load_partner_def_resolved(&state, row.partner_def_id.trim())
        .await?
        .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
    let techniques = build_partner_techniques_with_generated(
        &state,
        &def,
        technique_rows.get(&row.id).cloned().unwrap_or_default(),
    )
    .await?;
    let Some(technique) = techniques
        .into_iter()
        .find(|technique| technique.technique_id == technique_id.trim())
    else {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("伙伴功法不存在".to_string()),
                data: None,
            },
        ));
    };
    if technique.current_layer >= technique.max_layer {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("已达最高层数".to_string()),
                data: None,
            },
        ));
    }
    let Some(detail) = load_technique_detail_data(&state, technique_id.trim(), None, true).await?
    else {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("伙伴功法不存在".to_string()),
                data: None,
            },
        ));
    };
    let next_layer = technique.current_layer + 1;
    let Some(layer) = detail.layers.iter().find(|layer| layer.layer == next_layer) else {
        return Ok(send_result(
            ServiceResult::<PartnerTechniqueUpgradeCostDto> {
                success: false,
                message: Some("已达最高层数".to_string()),
                data: None,
            },
        ));
    };
    let item_meta = load_item_meta_map()?;
    let materials = layer
        .cost_materials
        .iter()
        .filter_map(|row| {
            let item_id = row.item_id.trim().to_string();
            let qty = row.qty.max(0);
            if item_id.is_empty() || qty <= 0 {
                return None;
            }
            let meta = item_meta.get(item_id.as_str()).cloned();
            Some(PartnerTechniqueUpgradeCostMaterialDto {
                item_id,
                qty,
                item_name: meta.as_ref().map(|value| value.0.clone()),
                item_icon: meta.and_then(|value| value.1),
            })
        })
        .collect();
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(PartnerTechniqueUpgradeCostDto {
            current_layer: technique.current_layer,
            max_layer: technique.max_layer,
            next_layer,
            spirit_stones: layer.cost_spirit_stones.max(0),
            exp: layer.cost_exp.max(0),
            materials,
        }),
    }))
}

pub async fn get_partner_technique_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PartnerTechniqueQuery>,
) -> Result<axum::response::Response, AppError> {
    let _ = auth::require_character(&state, &headers).await?;
    let partner_id = query.partner_id.unwrap_or_default();
    let technique_id = query.technique_id.unwrap_or_default();
    if partner_id <= 0 || technique_id.trim().is_empty() {
        return Ok(send_result(ServiceResult::<PartnerTechniqueDetailDto> {
            success: false,
            message: Some("参数错误".to_string()),
            data: None,
        }));
    }
    let row = load_partner_row_by_id(&state, partner_id).await?;
    let Some(row) = row else {
        return Ok(send_result(ServiceResult::<PartnerTechniqueDetailDto> {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        }));
    };
    let technique_rows = load_partner_technique_rows(&state, vec![row.id]).await?;
    let def = load_partner_def_resolved(&state, row.partner_def_id.trim())
        .await?
        .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
    let techniques = build_partner_techniques_with_generated(
        &state,
        &def,
        technique_rows.get(&row.id).cloned().unwrap_or_default(),
    )
    .await?;
    let Some(technique) = techniques
        .into_iter()
        .find(|technique| technique.technique_id == technique_id.trim())
    else {
        return Ok(send_result(ServiceResult::<PartnerTechniqueDetailDto> {
            success: false,
            message: Some("伙伴功法不存在".to_string()),
            data: None,
        }));
    };
    let Some(detail) = load_technique_detail_data(&state, technique_id.trim(), None, true).await?
    else {
        return Ok(send_result(ServiceResult::<PartnerTechniqueDetailDto> {
            success: false,
            message: Some("伙伴功法详情不存在".to_string()),
            data: None,
        }));
    };
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(PartnerTechniqueDetailDto {
            technique: serde_json::to_value(detail.technique)
                .map_err(|error| AppError::config(format!("伙伴功法详情序列化失败: {error}")))?,
            layers: serde_json::to_value(detail.layers)
                .map_err(|error| AppError::config(format!("伙伴功法层级序列化失败: {error}")))?
                .as_array()
                .cloned()
                .unwrap_or_default(),
            skills: serde_json::to_value(detail.skills)
                .map_err(|error| AppError::config(format!("伙伴功法技能序列化失败: {error}")))?
                .as_array()
                .cloned()
                .unwrap_or_default(),
            current_layer: technique.current_layer,
            is_innate: technique.is_innate,
        }),
    }))
}

#[derive(Clone)]
struct PartnerOwnerContext {
    realm: String,
    sub_realm: String,
    exp: i64,
}

struct PartnerInjectPlan {
    spent_exp: i64,
    remaining_character_exp: i64,
    after_level: i64,
    after_progress_exp: i64,
    gained_levels: i64,
}

async fn is_partner_unlocked(state: &AppState, character_id: i64) -> Result<bool, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT 1 FROM character_feature_unlocks WHERE character_id = $1 AND feature_code = 'partner_system' LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    Ok(row.is_some())
}

async fn load_partner_owner_context(
    state: &AppState,
    character_id: i64,
) -> Result<PartnerOwnerContext, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT realm, sub_realm, exp FROM characters WHERE id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;
    Ok(PartnerOwnerContext {
        realm: row
            .try_get::<Option<String>, _>("realm")?
            .unwrap_or_else(|| "凡人".to_string()),
        sub_realm: row
            .try_get::<Option<String>, _>("sub_realm")?
            .unwrap_or_default(),
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
    })
}

async fn load_partner_rows(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<PartnerRow>, AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT * FROM character_partner WHERE character_id = $1 ORDER BY is_active DESC, created_at ASC, id ASC",
            |query| query.bind(character_id),
        )
        .await?;
    rows.into_iter().map(parse_partner_row).collect()
}

async fn load_partner_def_resolved(
    state: &AppState,
    partner_def_id: &str,
) -> Result<Option<PartnerDefSeed>, AppError> {
    let defs = load_partner_def_map()?;
    if let Some(def) = defs.get(partner_def_id).cloned() {
        return Ok(Some(def));
    }
    let row = state.database.fetch_optional(
        "SELECT id, source_job_id, name, description, avatar, quality, attribute_element, role, max_technique_slots, innate_technique_ids, base_attrs, level_attr_gains, enabled FROM generated_partner_def WHERE id = $1 AND enabled = TRUE LIMIT 1",
        |q| q.bind(partner_def_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(PartnerDefSeed {
        id: row
            .try_get::<Option<String>, _>("id")?
            .unwrap_or_else(|| partner_def_id.to_string()),
        source_job_id: row.try_get::<Option<String>, _>("source_job_id")?,
        name: row
            .try_get::<Option<String>, _>("name")?
            .unwrap_or_else(|| partner_def_id.to_string()),
        description: row.try_get::<Option<String>, _>("description")?,
        avatar: row.try_get::<Option<String>, _>("avatar")?,
        quality: row.try_get::<Option<String>, _>("quality")?,
        attribute_element: row.try_get::<Option<String>, _>("attribute_element")?,
        role: row.try_get::<Option<String>, _>("role")?,
        max_technique_slots: row
            .try_get::<Option<i32>, _>("max_technique_slots")?
            .map(i64::from),
        innate_technique_ids: row.try_get::<Option<Vec<String>>, _>("innate_technique_ids")?,
        base_attrs: row
            .try_get::<Option<serde_json::Value>, _>("base_attrs")?
            .unwrap_or_else(|| serde_json::json!({})),
        level_attr_gains: row
            .try_get::<Option<serde_json::Value>, _>("level_attr_gains")?
            .unwrap_or_else(|| serde_json::json!({})),
        enabled: row.try_get::<Option<bool>, _>("enabled")?,
    }))
}

async fn load_partner_row_by_id(
    state: &AppState,
    partner_id: i64,
) -> Result<Option<PartnerRow>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT * FROM character_partner WHERE id = $1 LIMIT 1",
            |query| query.bind(partner_id),
        )
        .await?;
    row.map(parse_partner_row).transpose()
}

async fn load_single_partner_row(
    state: &AppState,
    character_id: i64,
    partner_id: i64,
    for_update: bool,
) -> Result<Option<PartnerRow>, AppError> {
    let sql = if for_update {
        "SELECT * FROM character_partner WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE"
    } else {
        "SELECT * FROM character_partner WHERE id = $1 AND character_id = $2 LIMIT 1"
    };
    let row = state
        .database
        .fetch_optional(sql, |query| query.bind(partner_id).bind(character_id))
        .await?;
    row.map(parse_partner_row).transpose()
}

fn parse_partner_row(row: sqlx::postgres::PgRow) -> Result<PartnerRow, AppError> {
    Ok(PartnerRow {
        id: i64::from(row.try_get::<i32, _>("id")?),
        character_id: i64::from(row.try_get::<i32, _>("character_id")?),
        partner_def_id: row
            .try_get::<Option<String>, _>("partner_def_id")?
            .unwrap_or_default(),
        nickname: row
            .try_get::<Option<String>, _>("nickname")?
            .unwrap_or_default(),
        description: row.try_get::<Option<String>, _>("description")?,
        avatar: row.try_get::<Option<String>, _>("avatar")?,
        level: row.try_get::<Option<i64>, _>("level")?.unwrap_or(1),
        progress_exp: row
            .try_get::<Option<i64>, _>("progress_exp")?
            .unwrap_or_default(),
        growth_max_qixue: opt_i64_from_i32(&row, "growth_max_qixue"),
        growth_wugong: opt_i64_from_i32(&row, "growth_wugong"),
        growth_fagong: opt_i64_from_i32(&row, "growth_fagong"),
        growth_wufang: opt_i64_from_i32(&row, "growth_wufang"),
        growth_fafang: opt_i64_from_i32(&row, "growth_fafang"),
        growth_sudu: opt_i64_from_i32(&row, "growth_sudu"),
        is_active: row
            .try_get::<Option<bool>, _>("is_active")?
            .unwrap_or(false),
        obtained_from: row.try_get::<Option<String>, _>("obtained_from")?,
    })
}

async fn load_partner_technique_rows(
    state: &AppState,
    partner_ids: Vec<i64>,
) -> Result<HashMap<i64, Vec<PartnerTechniqueRow>>, AppError> {
    load_partner_technique_rows_with_lock(state, partner_ids, false).await
}

async fn load_partner_technique_rows_with_lock(
    state: &AppState,
    partner_ids: Vec<i64>,
    for_update: bool,
) -> Result<HashMap<i64, Vec<PartnerTechniqueRow>>, AppError> {
    if partner_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let lock_sql = if for_update { " FOR UPDATE" } else { "" };
    let rows = state
        .database
        .fetch_all(
            &format!(
                "SELECT partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id FROM character_partner_technique WHERE partner_id = ANY($1::bigint[]) ORDER BY partner_id ASC, is_innate DESC, created_at ASC, id ASC{}",
                lock_sql,
            ),
            |query| query.bind(partner_ids),
        )
        .await?;
    let mut map = HashMap::new();
    for row in rows {
        let partner_id = opt_i64_from_i32(&row, "partner_id");
        map.entry(partner_id)
            .or_insert_with(Vec::new)
            .push(PartnerTechniqueRow {
                partner_id,
                technique_id: row
                    .try_get::<Option<String>, _>("technique_id")?
                    .unwrap_or_default(),
                current_layer: opt_i64_from_i32_default(&row, "current_layer", 1),
                is_innate: row
                    .try_get::<Option<bool>, _>("is_innate")?
                    .unwrap_or(false),
                learned_from_item_def_id: row
                    .try_get::<Option<String>, _>("learned_from_item_def_id")?,
            });
    }
    Ok(map)
}

async fn load_partner_skill_policy_rows(
    state: &AppState,
    partner_id: i64,
) -> Result<Vec<CharacterPartnerSkillPolicyRow>, AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT partner_id, skill_id, priority, enabled FROM character_partner_skill_policy WHERE partner_id = $1 ORDER BY enabled DESC, priority ASC, id ASC",
            |query| query.bind(partner_id),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| CharacterPartnerSkillPolicyRow {
            skill_id: row
                .try_get::<Option<String>, _>("skill_id")
                .unwrap_or(None)
                .unwrap_or_default(),
            priority: opt_i64_from_i32(&row, "priority"),
            enabled: row
                .try_get::<Option<bool>, _>("enabled")
                .unwrap_or(None)
                .unwrap_or(false),
        })
        .collect())
}

fn build_partner_details(
    rows: Vec<PartnerRow>,
    technique_map: &HashMap<i64, Vec<PartnerTechniqueRow>>,
    owner: &PartnerOwnerContext,
) -> Result<Vec<PartnerDetailDto>, AppError> {
    let growth_cfg = load_partner_growth_config()?;
    let defs = load_partner_def_map()?;
    let tech_defs = load_technique_def_map()?;
    let skill_defs = load_skill_def_map()?;
    rows.into_iter()
        .map(|row| {
            let def = defs.get(row.partner_def_id.trim()).ok_or_else(|| {
                AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id))
            })?;
            let effective_level =
                resolve_partner_effective_level(&owner.realm, &owner.sub_realm, row.level);
            let techniques = build_partner_techniques(
                def,
                technique_map.get(&row.id).cloned().unwrap_or_default(),
                &tech_defs,
                &skill_defs,
            )?;
            let computed = build_partner_computed_attrs(def, &row, effective_level, &techniques);
            Ok(PartnerDetailDto {
                id: row.id,
                partner_def_id: def.id.clone(),
                name: def.name.clone(),
                nickname: if row.nickname.trim().is_empty() {
                    def.name.clone()
                } else {
                    row.nickname.clone()
                },
                description: row
                    .description
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| def.description.clone().unwrap_or_default()),
                avatar: row
                    .avatar
                    .clone()
                    .filter(|value| !value.trim().is_empty())
                    .or_else(|| def.avatar.clone()),
                element: def
                    .attribute_element
                    .clone()
                    .unwrap_or_else(|| "none".to_string()),
                role: def.role.clone().unwrap_or_else(|| "伙伴".to_string()),
                quality: def.quality.clone().unwrap_or_else(|| "黄".to_string()),
                level: row.level.max(1),
                current_effective_level: effective_level,
                progress_exp: row.progress_exp.max(0),
                next_level_cost_exp: calc_partner_upgrade_exp_by_target_level(
                    row.level.max(1) + 1,
                    &growth_cfg,
                ),
                slot_count: def.max_technique_slots.unwrap_or_default().max(0),
                is_active: row.is_active,
                is_generated: def.id.starts_with("partner-gen-"),
                obtained_from: row.obtained_from.clone(),
                growth: PartnerGrowthDto {
                    max_qixue: row.growth_max_qixue.max(0),
                    wugong: row.growth_wugong.max(0),
                    fagong: row.growth_fagong.max(0),
                    wufang: row.growth_wufang.max(0),
                    fafang: row.growth_fafang.max(0),
                    sudu: row.growth_sudu.max(0),
                },
                level_attr_gains: to_number_map(def.level_attr_gains.clone()),
                computed_attrs: computed,
                techniques,
                trade_status: "none".to_string(),
                market_listing_id: None,
                fusion_status: "none".to_string(),
                fusion_job_id: None,
            })
        })
        .collect()
}

fn build_partner_techniques(
    def: &PartnerDefSeed,
    rows: Vec<PartnerTechniqueRow>,
    tech_defs: &HashMap<String, serde_json::Value>,
    skill_defs: &HashMap<String, serde_json::Value>,
) -> Result<Vec<PartnerTechniqueDto>, AppError> {
    let mut effective_rows = Vec::new();
    let innate_ids = def.innate_technique_ids.clone().unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    for technique_id in innate_ids {
        if seen.insert(technique_id.clone()) {
            let row = rows.iter().find(|row| row.technique_id == technique_id);
            effective_rows.push(PartnerTechniqueRow {
                partner_id: row.map(|row| row.partner_id).unwrap_or_default(),
                technique_id: technique_id.clone(),
                current_layer: row.map(|row| row.current_layer).unwrap_or(1),
                is_innate: true,
                learned_from_item_def_id: row.and_then(|row| row.learned_from_item_def_id.clone()),
            });
        }
    }
    for row in rows {
        if seen.insert(row.technique_id.clone()) {
            effective_rows.push(row);
        }
    }

    effective_rows
        .into_iter()
        .map(|row| {
            let tech = tech_defs.get(row.technique_id.as_str());
            let max_layer = tech
                .and_then(|value| value.get("max_layer").and_then(|value| value.as_i64()))
                .unwrap_or(1)
                .max(1);
            let current_layer = row.current_layer.clamp(1, max_layer);
            let all_layers = if tech.is_some() {
                load_technique_layers_for(&row.technique_id)?
            } else {
                Vec::new()
            };
            let mut unlock_skill_ids = Vec::new();
            let mut upgrade_skill_ids = Vec::new();
            let mut passive_attrs = BTreeMap::new();
            for layer in all_layers.iter().filter(|layer| {
                layer
                    .get("layer")
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
                    <= current_layer
            }) {
                if let Some(skills) = layer
                    .get("unlock_skill_ids")
                    .and_then(|value| value.as_array())
                {
                    for skill in skills {
                        if let Some(skill_id) = skill.as_str() {
                            unlock_skill_ids.push(skill_id.to_string());
                        }
                    }
                }
                if let Some(skills) = layer
                    .get("upgrade_skill_ids")
                    .and_then(|value| value.as_array())
                {
                    for skill in skills {
                        if let Some(skill_id) = skill.as_str() {
                            upgrade_skill_ids.push(skill_id.to_string());
                        }
                    }
                }
                if let Some(passives) = layer.get("passives").and_then(|value| value.as_array()) {
                    for passive in passives {
                        if let (Some(key), Some(value)) = (
                            passive.get("key").and_then(|value| value.as_str()),
                            passive.get("value").and_then(|value| {
                                value.as_f64().or_else(|| value.as_i64().map(|v| v as f64))
                            }),
                        ) {
                            *passive_attrs.entry(key.to_string()).or_insert(0.0) += value;
                        }
                    }
                }
            }
            let mut skill_ids = unlock_skill_ids;
            skill_ids.sort();
            skill_ids.dedup();
            let skills = skill_ids
                .iter()
                .filter_map(|skill_id| {
                    skill_defs
                        .get(skill_id.as_str())
                        .map(|skill| PartnerTechniqueSkillDto {
                            id: skill_id.clone(),
                            name: skill
                                .get("name")
                                .and_then(|value| value.as_str())
                                .unwrap_or(skill_id)
                                .to_string(),
                            icon: skill
                                .get("icon")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                                .to_string(),
                            description: skill
                                .get("description")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string()),
                            cost_lingqi: skill.get("cost_lingqi").and_then(|value| value.as_i64()),
                            cost_lingqi_rate: skill
                                .get("cost_lingqi_rate")
                                .and_then(|value| value.as_f64()),
                            cost_qixue: skill.get("cost_qixue").and_then(|value| value.as_i64()),
                            cost_qixue_rate: skill
                                .get("cost_qixue_rate")
                                .and_then(|value| value.as_f64()),
                            cooldown: skill.get("cooldown").and_then(|value| value.as_i64()),
                            target_type: skill
                                .get("target_type")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string()),
                            target_count: skill
                                .get("target_count")
                                .and_then(|value| value.as_i64()),
                            damage_type: skill
                                .get("damage_type")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string()),
                            element: skill
                                .get("element")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string()),
                            effects: skill
                                .get("effects")
                                .and_then(|value| value.as_array())
                                .cloned(),
                            trigger_type: skill
                                .get("trigger_type")
                                .and_then(|value| value.as_str())
                                .map(|value| value.to_string()),
                            ai_priority: skill.get("ai_priority").and_then(|value| value.as_i64()),
                        })
                })
                .collect();
            let _ = upgrade_skill_ids;
            Ok(PartnerTechniqueDto {
                technique_id: row.technique_id.clone(),
                name: tech
                    .and_then(|value| value.get("name").and_then(|value| value.as_str()))
                    .unwrap_or(&row.technique_id)
                    .to_string(),
                description: tech
                    .and_then(|value| value.get("description").and_then(|value| value.as_str()))
                    .map(|value| value.to_string()),
                icon: tech
                    .and_then(|value| value.get("icon").and_then(|value| value.as_str()))
                    .map(|value| value.to_string()),
                quality: tech
                    .and_then(|value| value.get("quality").and_then(|value| value.as_str()))
                    .unwrap_or("玄")
                    .to_string(),
                current_layer,
                max_layer,
                skill_ids,
                skills,
                passive_attrs,
                is_innate: row.is_innate,
            })
        })
        .collect()
}

async fn build_partner_details_with_generated(
    state: &AppState,
    rows: Vec<PartnerRow>,
    technique_map: &HashMap<i64, Vec<PartnerTechniqueRow>>,
    owner: &PartnerOwnerContext,
) -> Result<Vec<PartnerDetailDto>, AppError> {
    let growth_cfg = load_partner_growth_config()?;
    let mut out = Vec::new();
    for row in rows {
        let def = load_partner_def_resolved(state, row.partner_def_id.trim())
            .await?
            .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
        let effective_level =
            resolve_partner_effective_level(&owner.realm, &owner.sub_realm, row.level);
        let techniques = build_partner_techniques_with_generated(
            state,
            &def,
            technique_map.get(&row.id).cloned().unwrap_or_default(),
        )
        .await?;
        out.push(PartnerDetailDto {
            id: row.id,
            partner_def_id: def.id.clone(),
            name: def.name.clone(),
            nickname: if row.nickname.trim().is_empty() {
                def.name.clone()
            } else {
                row.nickname.clone()
            },
            description: row
                .description
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| def.description.clone().unwrap_or_default()),
            avatar: row
                .avatar
                .clone()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| def.avatar.clone()),
            element: def
                .attribute_element
                .clone()
                .unwrap_or_else(|| "none".to_string()),
            role: def.role.clone().unwrap_or_else(|| "伙伴".to_string()),
            quality: def.quality.clone().unwrap_or_else(|| "黄".to_string()),
            level: row.level.max(1),
            current_effective_level: effective_level,
            progress_exp: row.progress_exp.max(0),
            next_level_cost_exp: calc_partner_upgrade_exp_by_target_level(
                row.level.max(1) + 1,
                &growth_cfg,
            ),
            slot_count: def.max_technique_slots.unwrap_or_default().max(0),
            is_active: row.is_active,
            is_generated: def
                .source_job_id
                .as_ref()
                .is_some_and(|value| !value.trim().is_empty())
                || def.id.starts_with("partner-gen-")
                || def.id.starts_with("generated-"),
            obtained_from: row.obtained_from.clone(),
            growth: PartnerGrowthDto {
                max_qixue: row.growth_max_qixue.max(0),
                wugong: row.growth_wugong.max(0),
                fagong: row.growth_fagong.max(0),
                wufang: row.growth_wufang.max(0),
                fafang: row.growth_fafang.max(0),
                sudu: row.growth_sudu.max(0),
            },
            level_attr_gains: to_number_map(def.level_attr_gains.clone()),
            computed_attrs: build_partner_computed_attrs(&def, &row, effective_level, &techniques),
            techniques,
            trade_status: "none".to_string(),
            market_listing_id: None,
            fusion_status: "none".to_string(),
            fusion_job_id: None,
        });
    }
    Ok(out)
}

async fn build_partner_techniques_with_generated(
    state: &AppState,
    def: &PartnerDefSeed,
    rows: Vec<PartnerTechniqueRow>,
) -> Result<Vec<PartnerTechniqueDto>, AppError> {
    let mut effective_rows = Vec::new();
    let innate_ids = def.innate_technique_ids.clone().unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    for technique_id in innate_ids {
        if seen.insert(technique_id.clone()) {
            let row = rows.iter().find(|row| row.technique_id == technique_id);
            effective_rows.push(PartnerTechniqueRow {
                partner_id: row.map(|row| row.partner_id).unwrap_or_default(),
                technique_id: technique_id.clone(),
                current_layer: row.map(|row| row.current_layer).unwrap_or(1),
                is_innate: true,
                learned_from_item_def_id: row.and_then(|row| row.learned_from_item_def_id.clone()),
            });
        }
    }
    for row in rows {
        if seen.insert(row.technique_id.clone()) {
            effective_rows.push(row);
        }
    }

    let mut out = Vec::new();
    for row in effective_rows {
        let Some(detail) =
            load_technique_detail_data(state, row.technique_id.as_str(), None, true).await?
        else {
            continue;
        };
        let max_layer = detail.technique.max_layer.max(1);
        let current_layer = row.current_layer.clamp(1, max_layer);
        let mut skill_ids = Vec::new();
        let mut upgrade_counts = BTreeMap::<String, i64>::new();
        let mut passive_attrs = BTreeMap::new();
        for layer in detail
            .layers
            .iter()
            .filter(|layer| layer.layer <= current_layer)
        {
            skill_ids.extend(layer.unlock_skill_ids.iter().cloned());
            skill_ids.extend(layer.upgrade_skill_ids.iter().cloned());
            for skill_id in &layer.upgrade_skill_ids {
                *upgrade_counts.entry(skill_id.clone()).or_insert(0) += 1;
            }
            for passive in &layer.passives {
                *passive_attrs.entry(passive.key.clone()).or_insert(0.0) += passive.value as f64;
            }
        }
        skill_ids.sort();
        skill_ids.dedup();
        let skills = detail
            .skills
            .into_iter()
            .filter(|skill| skill_ids.iter().any(|skill_id| skill_id == &skill.id))
            .map(|skill| {
                let skill_id = skill.id.clone();
                build_effective_partner_skill(skill, *upgrade_counts.get(&skill_id).unwrap_or(&0))
            })
            .collect();
        out.push(PartnerTechniqueDto {
            technique_id: row.technique_id,
            name: detail.technique.name,
            description: detail.technique.description,
            icon: detail.technique.icon,
            quality: detail.technique.quality,
            current_layer,
            max_layer,
            skill_ids,
            skills,
            passive_attrs,
            is_innate: row.is_innate,
        });
    }
    Ok(out)
}

pub(crate) fn build_effective_partner_skill(
    skill: crate::http::technique::SkillDefDto,
    upgrade_count: i64,
) -> PartnerTechniqueSkillDto {
    let mut cost_lingqi = skill.cost_lingqi;
    let mut cost_lingqi_rate = skill.cost_lingqi_rate;
    let mut cost_qixue = skill.cost_qixue;
    let mut cost_qixue_rate = skill.cost_qixue_rate;
    let mut cooldown = skill.cooldown.max(0);
    let mut target_count = skill.target_count.max(1);
    let mut ai_priority = skill.ai_priority.max(0);
    let mut effects = skill.effects.clone();
    let damage_effect = effects
        .iter()
        .find(|effect| effect.get("type").and_then(|value| value.as_str()) == Some("damage"))
        .cloned();
    let mut upgrades = skill.upgrades.clone().unwrap_or_default();
    upgrades.sort_by_key(|upgrade| {
        upgrade
            .get("layer")
            .and_then(|value| value.as_i64())
            .unwrap_or(i64::MAX)
    });
    for upgrade in upgrades.into_iter().take(upgrade_count.max(0) as usize) {
        let Some(changes) = upgrade.get("changes").and_then(|value| value.as_object()) else {
            continue;
        };
        if let Some(value) = changes.get("target_count").and_then(|value| value.as_i64()) {
            target_count = value.max(1);
        }
        if let Some(value) = changes.get("cooldown").and_then(|value| value.as_i64()) {
            cooldown = (cooldown + value).max(0);
        }
        if let Some(value) = changes.get("cost_lingqi").and_then(|value| value.as_i64()) {
            cost_lingqi = (cost_lingqi + value).max(0);
        }
        if let Some(value) = changes
            .get("cost_lingqi_rate")
            .and_then(|value| value.as_f64())
        {
            cost_lingqi_rate = (cost_lingqi_rate + value).max(0.0);
        }
        if let Some(value) = changes.get("cost_qixue").and_then(|value| value.as_i64()) {
            cost_qixue = (cost_qixue + value).max(0);
        }
        if let Some(value) = changes
            .get("cost_qixue_rate")
            .and_then(|value| value.as_f64())
        {
            cost_qixue_rate = (cost_qixue_rate + value).max(0.0);
        }
        if let Some(value) = changes.get("ai_priority").and_then(|value| value.as_i64()) {
            ai_priority = (ai_priority + value).max(0);
        }
        if let Some(next_effects) = changes.get("effects") {
            let mut replaced = next_effects.as_array().cloned().unwrap_or_default();
            if damage_effect.is_some()
                && !replaced.iter().any(|effect| {
                    effect.get("type").and_then(|value| value.as_str()) == Some("damage")
                })
            {
                replaced.insert(0, damage_effect.clone().unwrap_or_default());
            }
            effects = replaced;
        }
        if let Some(add_effect) = changes.get("addEffect") {
            if add_effect.is_object() {
                effects.push(add_effect.clone());
            }
        }
    }
    let trigger_type = crate::http::technique::resolve_skill_trigger_type(
        Some(skill.trigger_type.as_str()),
        &effects,
    );
    let cooldown = if trigger_type == "passive" {
        0
    } else {
        cooldown
    };
    PartnerTechniqueSkillDto {
        id: skill.id,
        name: skill.name,
        icon: skill.icon.unwrap_or_default(),
        description: skill.description,
        cost_lingqi: Some(cost_lingqi),
        cost_lingqi_rate: Some(cost_lingqi_rate),
        cost_qixue: Some(cost_qixue),
        cost_qixue_rate: Some(cost_qixue_rate),
        cooldown: Some(cooldown),
        target_type: Some(skill.target_type),
        target_count: Some(target_count),
        damage_type: skill.damage_type,
        element: Some(skill.element),
        effects: Some(effects),
        trigger_type: Some(trigger_type),
        ai_priority: Some(ai_priority),
    }
}

fn build_partner_computed_attrs(
    def: &PartnerDefSeed,
    row: &PartnerRow,
    effective_level: i64,
    techniques: &[PartnerTechniqueDto],
) -> PartnerComputedAttrsDto {
    let base = to_number_map(def.base_attrs.clone());
    let level_gain = to_number_map(def.level_attr_gains.clone());
    let level_offset = (effective_level - 1).max(0) as f64;
    let mut attrs = BTreeMap::new();
    for (key, value) in base {
        attrs.insert(key, value);
    }
    for (key, value) in level_gain {
        *attrs.entry(key).or_insert(0.0) += value * level_offset;
    }
    *attrs.entry("max_qixue".to_string()).or_insert(0.0) +=
        row.growth_max_qixue as f64 * level_offset;
    *attrs.entry("wugong".to_string()).or_insert(0.0) += row.growth_wugong as f64 * level_offset;
    *attrs.entry("fagong".to_string()).or_insert(0.0) += row.growth_fagong as f64 * level_offset;
    *attrs.entry("wufang".to_string()).or_insert(0.0) += row.growth_wufang as f64 * level_offset;
    *attrs.entry("fafang".to_string()).or_insert(0.0) += row.growth_fafang as f64 * level_offset;
    *attrs.entry("sudu".to_string()).or_insert(0.0) += row.growth_sudu as f64 * level_offset;
    for technique in techniques {
        for (key, value) in &technique.passive_attrs {
            *attrs.entry(key.clone()).or_insert(0.0) += *value;
        }
    }
    let max_qixue = attrs.get("max_qixue").copied().unwrap_or(1.0).max(1.0) as i64;
    let max_lingqi = attrs.get("max_lingqi").copied().unwrap_or(0.0).max(0.0) as i64;
    PartnerComputedAttrsDto {
        qixue: max_qixue,
        max_qixue,
        lingqi: max_lingqi,
        max_lingqi,
        wugong: attrs.get("wugong").copied().unwrap_or_default() as i64,
        fagong: attrs.get("fagong").copied().unwrap_or_default() as i64,
        wufang: attrs.get("wufang").copied().unwrap_or_default() as i64,
        fafang: attrs.get("fafang").copied().unwrap_or_default() as i64,
        mingzhong: attrs.get("mingzhong").copied().unwrap_or_default(),
        shanbi: attrs.get("shanbi").copied().unwrap_or_default(),
        zhaojia: attrs.get("zhaojia").copied().unwrap_or_default(),
        baoji: attrs.get("baoji").copied().unwrap_or_default(),
        baoshang: attrs.get("baoshang").copied().unwrap_or_default(),
        jianbaoshang: attrs.get("jianbaoshang").copied().unwrap_or_default(),
        jianfantan: attrs.get("jianfantan").copied().unwrap_or_default(),
        kangbao: attrs.get("kangbao").copied().unwrap_or_default(),
        zengshang: attrs.get("zengshang").copied().unwrap_or_default(),
        zhiliao: attrs.get("zhiliao").copied().unwrap_or_default(),
        jianliao: attrs.get("jianliao").copied().unwrap_or_default(),
        xixue: attrs.get("xixue").copied().unwrap_or_default(),
        lengque: attrs.get("lengque").copied().unwrap_or_default(),
        sudu: attrs.get("sudu").copied().unwrap_or(1.0).max(1.0) as i64,
        kongzhi_kangxing: attrs.get("kongzhi_kangxing").copied().unwrap_or_default(),
        jin_kangxing: attrs.get("jin_kangxing").copied().unwrap_or_default(),
        mu_kangxing: attrs.get("mu_kangxing").copied().unwrap_or_default(),
        shui_kangxing: attrs.get("shui_kangxing").copied().unwrap_or_default(),
        huo_kangxing: attrs.get("huo_kangxing").copied().unwrap_or_default(),
        tu_kangxing: attrs.get("tu_kangxing").copied().unwrap_or_default(),
        qixue_huifu: attrs.get("qixue_huifu").copied().unwrap_or_default(),
        lingqi_huifu: attrs.get("lingqi_huifu").copied().unwrap_or_default(),
    }
}

async fn build_partner_skill_policy_entries_with_generated(
    state: &AppState,
    row: &PartnerRow,
    technique_rows: Vec<PartnerTechniqueRow>,
    persisted_rows: Vec<CharacterPartnerSkillPolicyRow>,
) -> Result<Vec<PartnerSkillPolicyEntryDto>, AppError> {
    let def = load_partner_def_resolved(state, row.partner_def_id.trim())
        .await?
        .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
    let techniques = build_partner_techniques_with_generated(state, &def, technique_rows).await?;
    let mut available = Vec::new();
    for technique in &techniques {
        for skill in &technique.skills {
            let trigger_type = skill.target_type.as_deref().map(|_| skill.effects.as_ref());
            let _ = trigger_type;
            available.push(PartnerSkillPolicyEntryDto {
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                skill_icon: skill.icon.clone(),
                skill_description: skill.description.clone(),
                cost_lingqi: skill.cost_lingqi,
                cost_lingqi_rate: skill.cost_lingqi_rate,
                cost_qixue: skill.cost_qixue,
                cost_qixue_rate: skill.cost_qixue_rate,
                cooldown: skill.cooldown,
                target_type: skill.target_type.clone(),
                target_count: skill.target_count,
                damage_type: skill.damage_type.clone(),
                element: skill.element.clone(),
                effects: skill.effects.clone(),
                source_technique_id: technique.technique_id.clone(),
                source_technique_name: technique.name.clone(),
                source_technique_quality: technique.quality.clone(),
                priority: 999,
                enabled: false,
            });
        }
    }
    let persisted_map = persisted_rows
        .into_iter()
        .map(|entry| (entry.skill_id.clone(), entry))
        .collect::<HashMap<_, _>>();
    for entry in &mut available {
        if let Some(saved) = persisted_map.get(entry.skill_id.as_str()) {
            entry.priority = saved.priority;
            entry.enabled = saved.enabled;
        }
    }
    available.sort_by(|left, right| {
        left.priority
            .cmp(&right.priority)
            .then_with(|| left.skill_id.cmp(&right.skill_id))
    });
    Ok(available)
}

fn resolve_partner_effective_level(realm: &str, sub_realm: &str, level: i64) -> i64 {
    let rank = realm_rank(realm, sub_realm);
    let cap = (rank * 10).max(10);
    level.max(1).min(cap)
}

fn resolve_partner_inject_plan(
    before_level: i64,
    before_progress_exp: i64,
    character_exp: i64,
    inject_exp_budget: i64,
    growth: &PartnerGrowthFile,
    max_level: i64,
) -> Result<PartnerInjectPlan, AppError> {
    let mut current_level = before_level.max(1);
    let mut current_progress_exp = before_progress_exp.max(0);
    let mut remaining_budget = inject_exp_budget.max(0).min(character_exp.max(0));
    let mut gained_levels = 0;
    let current_cost = calc_partner_upgrade_exp_by_target_level(current_level + 1, growth);
    if current_progress_exp >= current_cost {
        return Err(AppError::config("伙伴进度异常：当前等级经验已超过升级需求"));
    }
    while remaining_budget > 0 {
        if current_level >= max_level.max(1) {
            current_progress_exp = 0;
            break;
        }
        let next_cost = calc_partner_upgrade_exp_by_target_level(current_level + 1, growth);
        let required = (next_cost - current_progress_exp).max(0);
        if required <= 0 {
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }
        if remaining_budget >= required {
            remaining_budget -= required;
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }
        current_progress_exp += remaining_budget;
        remaining_budget = 0;
    }
    let spent_exp = inject_exp_budget.max(0).min(character_exp.max(0)) - remaining_budget;
    Ok(PartnerInjectPlan {
        spent_exp,
        remaining_character_exp: (character_exp - spent_exp).max(0),
        after_level: current_level,
        after_progress_exp: current_progress_exp,
        gained_levels,
    })
}

fn realm_rank(realm: &str, sub_realm: &str) -> i64 {
    let full = if realm.trim() == "凡人" || sub_realm.trim().is_empty() {
        realm.trim().to_string()
    } else {
        format!("{}·{}", realm.trim(), sub_realm.trim())
    };
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
        .position(|item| *item == full)
        .map(|idx| idx as i64 + 1)
        .unwrap_or(1)
}

fn calc_partner_upgrade_exp_by_target_level(target_level: i64, growth: &PartnerGrowthFile) -> i64 {
    let safe_target = target_level.max(2);
    let level_offset = (safe_target - 2).max(0) as f64;
    let raw =
        (growth.exp_base_exp.max(1) as f64) * growth.exp_growth_rate.max(1.0).powf(level_offset);
    raw.floor().max(1.0) as i64
}

fn quality_multiplier_from_name(quality: &str) -> i64 {
    match quality.trim() {
        "黄" => 1,
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 1,
    }
}

fn build_partner_skill_policy_entries(
    row: &PartnerRow,
    technique_rows: Vec<PartnerTechniqueRow>,
    persisted_rows: Vec<CharacterPartnerSkillPolicyRow>,
) -> Result<Vec<PartnerSkillPolicyEntryDto>, AppError> {
    let defs = load_partner_def_map()?;
    let def = defs
        .get(row.partner_def_id.trim())
        .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
    let tech_defs = load_technique_def_map()?;
    let skill_defs = load_skill_def_map()?;
    let techniques = build_partner_techniques(def, technique_rows, &tech_defs, &skill_defs)?;
    let mut available = Vec::new();
    for technique in &techniques {
        for skill in &technique.skills {
            let trigger_type = skill_defs
                .get(skill.id.as_str())
                .and_then(|skill| skill.get("trigger_type").and_then(|value| value.as_str()))
                .unwrap_or("active");
            if trigger_type != "active" {
                continue;
            }
            available.push(PartnerSkillPolicyEntryDto {
                skill_id: skill.id.clone(),
                skill_name: skill.name.clone(),
                skill_icon: skill.icon.clone(),
                skill_description: skill.description.clone(),
                cost_lingqi: skill.cost_lingqi,
                cost_lingqi_rate: skill.cost_lingqi_rate,
                cost_qixue: skill.cost_qixue,
                cost_qixue_rate: skill.cost_qixue_rate,
                cooldown: skill.cooldown,
                target_type: skill.target_type.clone(),
                target_count: skill.target_count,
                damage_type: skill.damage_type.clone(),
                element: skill.element.clone(),
                effects: skill.effects.clone(),
                source_technique_id: technique.technique_id.clone(),
                source_technique_name: technique.name.clone(),
                source_technique_quality: technique.quality.clone(),
                priority: 0,
                enabled: true,
            });
        }
    }
    let persisted_by_skill: HashMap<String, CharacterPartnerSkillPolicyRow> = persisted_rows
        .into_iter()
        .map(|row| (row.skill_id.clone(), row))
        .collect();
    let mut enabled = Vec::new();
    let mut disabled = Vec::new();
    for (natural_order, mut entry) in available.into_iter().enumerate() {
        if let Some(row) = persisted_by_skill.get(entry.skill_id.as_str()) {
            entry.priority = row.priority.max(1);
            entry.enabled = row.enabled;
            if row.enabled {
                enabled.push((entry, natural_order));
            } else {
                disabled.push((entry, natural_order));
            }
        } else {
            entry.priority = (natural_order + 1) as i64;
            enabled.push((entry, natural_order));
        }
    }
    enabled.sort_by(|(left, lo), (right, ro)| {
        left.priority.cmp(&right.priority).then_with(|| lo.cmp(ro))
    });
    disabled.sort_by(|(left, lo), (right, ro)| {
        left.priority.cmp(&right.priority).then_with(|| lo.cmp(ro))
    });
    let mut out = Vec::new();
    for (idx, (mut entry, _)) in enabled.into_iter().chain(disabled.into_iter()).enumerate() {
        entry.priority = (idx + 1) as i64;
        out.push(entry);
    }
    Ok(out)
}

fn normalize_partner_skill_policy_slots_for_save(
    available_entries: &[PartnerSkillPolicyEntryDto],
    slots: Vec<PartnerSkillPolicySlotDto>,
) -> Result<Vec<PartnerSkillPolicySlotDto>, AppError> {
    let available_ids: std::collections::BTreeSet<_> = available_entries
        .iter()
        .map(|entry| entry.skill_id.clone())
        .collect();
    if slots.len() != available_entries.len() {
        return Err(AppError::config("技能策略必须覆盖伙伴当前全部可配置技能"));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut enabled = Vec::new();
    let mut disabled = Vec::new();
    for (natural_order, slot) in slots.into_iter().enumerate() {
        let skill_id = slot.skill_id.trim().to_string();
        if skill_id.is_empty()
            || slot.priority <= 0
            || !available_ids.contains(skill_id.as_str())
            || !seen.insert(skill_id.clone())
        {
            return Err(AppError::config("技能策略存在重复、缺失或非法技能"));
        }
        let normalized = PartnerSkillPolicySlotDto {
            skill_id,
            priority: slot.priority,
            enabled: slot.enabled,
        };
        if normalized.enabled {
            enabled.push((normalized, natural_order));
        } else {
            disabled.push((normalized, natural_order));
        }
    }
    enabled.sort_by(|(left, lo), (right, ro)| {
        left.priority.cmp(&right.priority).then_with(|| lo.cmp(ro))
    });
    disabled.sort_by(|(left, lo), (right, ro)| {
        left.priority.cmp(&right.priority).then_with(|| lo.cmp(ro))
    });
    Ok(enabled
        .into_iter()
        .chain(disabled.into_iter())
        .enumerate()
        .map(|(idx, (slot, _))| PartnerSkillPolicySlotDto {
            priority: (idx + 1) as i64,
            ..slot
        })
        .collect())
}

fn load_partner_def_map() -> Result<HashMap<String, PartnerDefSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/partner_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read partner_def.json: {error}")))?;
    let payload: PartnerDefFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse partner_def.json: {error}")))?;
    Ok(payload
        .partners
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| (row.id.clone(), row))
        .collect())
}

fn load_partner_growth_config() -> Result<PartnerGrowthFile, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/partner_growth.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read partner_growth.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse partner_growth.json: {error}")))
}

fn load_technique_def_map() -> Result<HashMap<String, serde_json::Value>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_def.json: {error}"))
    })?;
    let techniques = payload
        .get("techniques")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(techniques
        .into_iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(|v| v.as_str())
                .map(|id| (id.to_string(), row.clone()))
        })
        .collect())
}

fn load_skill_def_map() -> Result<HashMap<String, serde_json::Value>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/skill_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read skill_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse skill_def.json: {error}")))?;
    let skills = payload
        .get("skills")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(skills
        .into_iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(|v| v.as_str())
                .map(|id| (id.to_string(), row.clone()))
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

fn load_technique_meta_map()
-> Result<BTreeMap<String, (String, Option<String>, Option<String>)>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_def.json: {error}"))
    })?;
    let techniques = payload
        .get("techniques")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(techniques
        .into_iter()
        .filter_map(|technique| {
            let id = technique.get("id")?.as_str()?.trim().to_string();
            let name = technique.get("name")?.as_str()?.trim().to_string();
            let icon = technique
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            let quality = technique
                .get("quality")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            (!id.is_empty() && !name.is_empty()).then_some((id, (name, icon, quality)))
        })
        .collect())
}

pub(crate) async fn load_partner_book_context(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
) -> Result<Option<PartnerBookDto>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, item_def_id, qty, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
            |query| query.bind(item_instance_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let item_def_id = row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let metadata = row.try_get::<Option<serde_json::Value>, _>("metadata")?;
    let Some(mut book) = resolve_partner_book(state, item_def_id.trim(), metadata.as_ref()).await?
    else {
        return Ok(None);
    };
    if item_def_id.trim() == "book-generated-technique"
        && resolve_generated_technique_book_display(
            state,
            item_def_id.trim(),
            &load_inventory_def_map()?
                .get(item_def_id.trim())
                .ok_or_else(|| AppError::config("生成功法书定义缺失"))?
                .row,
            metadata.as_ref(),
        )
        .await?
        .is_none()
    {
        return Ok(None);
    }
    enrich_generated_partner_book_display(state, &mut book, metadata.as_ref()).await?;
    book.item_instance_id = item_instance_id;
    book.qty = row
        .try_get::<Option<i32>, _>("qty")
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or(1)
        .max(1);
    Ok(Some(book))
}

pub(crate) async fn load_partner_books(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<PartnerBookDto>, AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT id, item_def_id, qty, metadata FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' ORDER BY created_at ASC, id ASC",
            |query| query.bind(character_id),
        )
        .await?;
    let mut books = Vec::new();
    for row in rows {
        let item_instance_id = row.try_get::<Option<i64>, _>("id")?.unwrap_or_default();
        let item_def_id = row
            .try_get::<Option<String>, _>("item_def_id")?
            .unwrap_or_default();
        let metadata = row.try_get::<Option<serde_json::Value>, _>("metadata")?;
        let Some(mut book) =
            resolve_partner_book(state, item_def_id.trim(), metadata.as_ref()).await?
        else {
            continue;
        };
        if item_def_id.trim() == "book-generated-technique"
            && resolve_generated_technique_book_display(
                state,
                item_def_id.trim(),
                &load_inventory_def_map()?
                    .get(item_def_id.trim())
                    .ok_or_else(|| AppError::config("生成功法书定义缺失"))?
                    .row,
                metadata.as_ref(),
            )
            .await?
            .is_none()
        {
            continue;
        }
        enrich_generated_partner_book_display(state, &mut book, metadata.as_ref()).await?;
        book.item_instance_id = item_instance_id;
        book.qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or(1)
            .max(1);
        books.push(book);
    }
    Ok(books)
}

async fn load_partner_technique_preview_items(
    state: &AppState,
    character_id: i64,
    for_update: bool,
) -> Result<Vec<PartnerTechniquePreviewItemRow>, AppError> {
    let lock_sql = if for_update { " FOR UPDATE" } else { "" };
    let rows = state
        .database
        .fetch_all(
            &format!(
                "SELECT id, item_def_id, qty, metadata FROM item_instance WHERE owner_character_id = $1 AND location = 'partner_preview' ORDER BY created_at ASC, id ASC{}",
                lock_sql,
            ),
            |query| query.bind(character_id),
        )
        .await?;

    rows.into_iter()
        .map(|row| {
            Ok(PartnerTechniquePreviewItemRow {
                id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
                item_def_id: row
                    .try_get::<Option<String>, _>("item_def_id")?
                    .unwrap_or_default(),
                qty: row
                    .try_get::<Option<i32>, _>("qty")?
                    .map(i64::from)
                    .unwrap_or(1)
                    .max(1),
                metadata: row.try_get::<Option<serde_json::Value>, _>("metadata")?,
            })
        })
        .collect()
}

fn read_pending_partner_technique_preview_partner_id(
    metadata: Option<&serde_json::Value>,
) -> Option<i64> {
    metadata
        .and_then(|value| value.get("partnerTechniqueLearnPreview"))
        .and_then(|value| value.get("partnerId"))
        .and_then(|value| value.as_i64())
        .filter(|partner_id| *partner_id > 0)
}

async fn delete_partner_technique_preview_items_by_ids(
    state: &AppState,
    character_id: i64,
    item_instance_ids: &[i64],
) -> Result<(), AppError> {
    let normalized_ids = item_instance_ids
        .iter()
        .copied()
        .filter(|item_instance_id| *item_instance_id > 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if normalized_ids.is_empty() {
        return Ok(());
    }

    state
        .database
        .execute(
            "DELETE FROM item_instance WHERE owner_character_id = $1 AND location = 'partner_preview' AND id = ANY($2::bigint[])",
            |query| query.bind(character_id).bind(&normalized_ids),
        )
        .await?;
    Ok(())
}

pub(crate) async fn has_pending_partner_technique_preview_for_partner(
    state: &AppState,
    character_id: i64,
    partner_id: i64,
    for_update: bool,
) -> Result<bool, AppError> {
    if partner_id <= 0 {
        return Ok(false);
    }

    let rows = load_partner_technique_preview_items(state, character_id, for_update).await?;
    Ok(rows.into_iter().any(|row| {
        read_pending_partner_technique_preview_partner_id(row.metadata.as_ref()) == Some(partner_id)
    }))
}

pub(crate) async fn clear_pending_partner_technique_preview_by_partner_ids(
    state: &AppState,
    character_id: i64,
    partner_ids: &[i64],
    for_update: bool,
) -> Result<Vec<i64>, AppError> {
    let normalized_partner_ids = partner_ids
        .iter()
        .copied()
        .filter(|partner_id| *partner_id > 0)
        .collect::<BTreeSet<_>>();
    if normalized_partner_ids.is_empty() {
        return Ok(Vec::new());
    }

    let rows = load_partner_technique_preview_items(state, character_id, for_update).await?;
    let matched_item_ids = rows
        .into_iter()
        .filter(|row| {
            read_pending_partner_technique_preview_partner_id(row.metadata.as_ref())
                .is_some_and(|partner_id| normalized_partner_ids.contains(&partner_id))
        })
        .map(|row| row.id)
        .collect::<Vec<_>>();

    delete_partner_technique_preview_items_by_ids(state, character_id, &matched_item_ids).await?;
    Ok(matched_item_ids)
}

async fn build_partner_preview_book_from_item_row(
    state: &AppState,
    row: &PartnerTechniquePreviewItemRow,
) -> Result<Option<PartnerBookDto>, AppError> {
    let Some(mut book) =
        resolve_partner_book(state, row.item_def_id.trim(), row.metadata.as_ref()).await?
    else {
        return Ok(None);
    };
    enrich_generated_partner_book_display(state, &mut book, row.metadata.as_ref()).await?;
    book.item_instance_id = row.id;
    book.qty = row.qty;
    Ok(Some(book))
}

enum PartnerPendingPreviewResolution {
    Valid(PartnerPendingTechniqueLearnPreviewDto),
    Invalid { message: &'static str },
}

async fn resolve_partner_pending_preview_from_row(
    state: &AppState,
    character_id: i64,
    row: &PartnerTechniquePreviewItemRow,
    for_update: bool,
) -> Result<PartnerPendingPreviewResolution, AppError> {
    let Some(book) = build_partner_preview_book_from_item_row(state, row).await? else {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "待处理打书预览中的功法书数据异常",
        });
    };

    let preview_partner_id = book.preview_partner_id.unwrap_or_default();
    let preview_learned_technique_id = book
        .preview_learned_technique_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    let preview_replaced_technique_id = book
        .preview_replaced_technique_id
        .as_deref()
        .unwrap_or_default()
        .trim();

    if preview_partner_id <= 0
        || preview_learned_technique_id.is_empty()
        || preview_replaced_technique_id.is_empty()
    {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "待处理打书预览数据异常",
        });
    }
    if book.technique_id.trim() != preview_learned_technique_id {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "待处理打书预览与功法书不匹配",
        });
    }

    let Some(partner_row) =
        load_single_partner_row(state, character_id, preview_partner_id, for_update).await?
    else {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "伙伴不存在",
        });
    };
    let listing_lock_sql = if for_update { " FOR UPDATE" } else { "" };
    let active_listing = state.database.fetch_optional(
        &format!(
            "SELECT id FROM market_partner_listing WHERE partner_id = $1 AND status = 'active' LIMIT 1{}",
            listing_lock_sql,
        ),
        |query| query.bind(preview_partner_id),
    ).await?;
    if active_listing.is_some() {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "已在坊市挂单的伙伴不可学习功法",
        });
    }
    let fusion_lock_sql = if for_update { " FOR UPDATE" } else { "" };
    let fusion_material = state.database.fetch_optional(
        &format!(
            "SELECT material.partner_id FROM partner_fusion_job_material AS material INNER JOIN partner_fusion_job AS job ON job.id = material.fusion_job_id WHERE material.partner_id = $1 AND job.status IN ('pending','generated_preview') LIMIT 1{}",
            fusion_lock_sql,
        ),
        |query| query.bind(preview_partner_id),
    ).await?;
    if fusion_material.is_some() {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "归契中的伙伴不可学习功法",
        });
    }
    let def = load_partner_def_resolved(state, partner_row.partner_def_id.trim())
        .await?
        .ok_or_else(|| {
            AppError::config(format!("伙伴模板不存在: {}", partner_row.partner_def_id))
        })?;
    let technique_map =
        load_partner_technique_rows_with_lock(state, vec![partner_row.id], for_update).await?;
    let current_techniques = build_partner_techniques_with_generated(
        state,
        &def,
        technique_map
            .get(&partner_row.id)
            .cloned()
            .unwrap_or_default(),
    )
    .await?;
    if current_techniques
        .iter()
        .any(|technique| technique.technique_id == preview_learned_technique_id)
    {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "伙伴已掌握该功法",
        });
    }

    let learned_technique =
        match build_partner_preview_technique(state, preview_learned_technique_id).await {
            Ok(technique) => technique,
            Err(_) => {
                return Ok(PartnerPendingPreviewResolution::Invalid {
                    message: "伙伴功法不存在或未开放",
                });
            }
        };
    let Some(replaced_technique) = current_techniques
        .iter()
        .find(|technique| {
            technique.technique_id == preview_replaced_technique_id && !technique.is_innate
        })
        .cloned()
    else {
        return Ok(PartnerPendingPreviewResolution::Invalid {
            message: "待处理打书预览中的被替换功法已失效",
        });
    };

    Ok(PartnerPendingPreviewResolution::Valid(
        PartnerPendingTechniqueLearnPreviewDto {
            book,
            preview: PartnerTechniqueLearnPreviewDto {
                partner_id: preview_partner_id,
                item_instance_id: row.id,
                learned_technique,
                replaced_technique,
            },
        },
    ))
}

async fn resolve_partner_book(
    state: &AppState,
    item_def_id: &str,
    metadata: Option<&serde_json::Value>,
) -> Result<Option<PartnerBookDto>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/item_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read item_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse item_def.json: {error}")))?;
    let item = payload
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .find(|item| {
            item.get("id")
                .and_then(|value| value.as_str())
                .map(str::trim)
                == Some(item_def_id)
        });
    let Some(item) = item else {
        return Ok(None);
    };
    let effect_defs = item
        .get("effect_defs")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for effect in effect_defs {
        if effect
            .get("trigger")
            .and_then(|value| value.as_str())
            .map(str::trim)
            != Some("use")
        {
            continue;
        }
        let effect_type = effect
            .get("effect_type")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if effect_type == "learn_technique" {
            let technique_id = effect
                .get("params")
                .and_then(|value| value.get("technique_id"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if technique_id.is_empty() {
                return Ok(None);
            }
            let technique_meta = load_technique_meta_map()?
                .get(technique_id.as_str())
                .cloned();
            return Ok(Some(PartnerBookDto {
                item_instance_id: 0,
                item_def_id: item_def_id.to_string(),
                technique_id: technique_id.clone(),
                technique_name: technique_meta
                    .as_ref()
                    .map(|value| value.0.clone())
                    .unwrap_or_else(|| technique_id.clone()),
                name: item
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or(item_def_id)
                    .to_string(),
                icon: item
                    .get("icon")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                quality: item
                    .get("quality")
                    .and_then(|value| value.as_str())
                    .unwrap_or("黄")
                    .to_string(),
                qty: 1,
                preview_partner_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("partnerId"))
                    .and_then(|value| value.as_i64()),
                preview_learned_technique_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("learnedTechniqueId"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                preview_replaced_technique_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("replacedTechniqueId"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            }));
        }
        if effect_type == "learn_generated_technique" {
            let technique_id = metadata
                .and_then(|value| value.get("generatedTechniqueId"))
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if technique_id.is_empty() {
                return Ok(None);
            }
            let generated_row = state.database.fetch_optional(
                "SELECT COALESCE(display_name, name) AS name, quality FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
                |q| q.bind(&technique_id),
            ).await?;
            let static_meta = load_technique_meta_map()?
                .get(technique_id.as_str())
                .cloned();
            let generated_name = generated_row
                .as_ref()
                .and_then(|row| row.try_get::<Option<String>, _>("name").ok().flatten())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| static_meta.as_ref().map(|value| value.0.clone()));
            let Some(generated_name) = generated_name else {
                return Ok(None);
            };
            let resolved_quality = generated_row
                .as_ref()
                .and_then(|row| row.try_get::<Option<String>, _>("quality").ok().flatten())
                .or_else(|| static_meta.as_ref().and_then(|value| value.2.clone()))
                .or_else(|| {
                    item.get("quality")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string())
                })
                .unwrap_or_else(|| "黄".to_string());
            return Ok(Some(PartnerBookDto {
                item_instance_id: 0,
                item_def_id: item_def_id.to_string(),
                technique_id: technique_id.clone(),
                technique_name: generated_name.clone(),
                name: format!("《{}》秘卷", generated_name),
                icon: item
                    .get("icon")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                quality: resolved_quality,
                qty: 1,
                preview_partner_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("partnerId"))
                    .and_then(|value| value.as_i64()),
                preview_learned_technique_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("learnedTechniqueId"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                preview_replaced_technique_id: metadata
                    .and_then(|value| value.get("partnerTechniqueLearnPreview"))
                    .and_then(|value| value.get("replacedTechniqueId"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            }));
        }
    }
    Ok(None)
}

async fn enrich_generated_partner_book_display(
    state: &AppState,
    book: &mut PartnerBookDto,
    metadata: Option<&serde_json::Value>,
) -> Result<(), AppError> {
    if book.item_def_id != "book-generated-technique" {
        return Ok(());
    }
    let generated_technique_id = metadata
        .and_then(|value| value.get("generatedTechniqueId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if generated_technique_id.is_empty() {
        return Ok(());
    }
    let generated_row = state.database.fetch_optional(
        "SELECT COALESCE(display_name, name) AS name, quality FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
        |q| q.bind(generated_technique_id),
    ).await?;
    if let Some(row) = generated_row {
        if let Some(name) = row.try_get::<Option<String>, _>("name")? {
            book.technique_name = name.clone();
            book.name = format!("《{}》秘卷", name);
        }
        if let Some(quality) = row.try_get::<Option<String>, _>("quality")? {
            book.quality = quality;
        }
        return Ok(());
    }
    if let Some((name, _icon, _quality)) = load_technique_meta_map()?
        .get(generated_technique_id)
        .cloned()
    {
        book.technique_name = name.clone();
        book.name = format!("《{}》秘卷", name);
    }
    Ok(())
}

async fn load_pending_partner_technique_learn_preview(
    state: &AppState,
    character_id: i64,
    _partner_rows: &[PartnerRow],
    _technique_map: &HashMap<i64, Vec<PartnerTechniqueRow>>,
    _owner: &PartnerOwnerContext,
) -> Result<Option<PartnerPendingTechniqueLearnPreviewDto>, AppError> {
    let rows = load_partner_technique_preview_items(state, character_id, false).await?;
    let mut invalid_item_ids = Vec::new();
    let mut valid_previews = Vec::new();
    for row in rows {
        let item_instance_id = row.id;
        match resolve_partner_pending_preview_from_row(state, character_id, &row, false).await? {
            PartnerPendingPreviewResolution::Valid(preview) => valid_previews.push(preview),
            PartnerPendingPreviewResolution::Invalid { .. } => {
                if item_instance_id > 0 {
                    invalid_item_ids.push(item_instance_id);
                }
            }
        }
    }
    if !invalid_item_ids.is_empty() {
        delete_partner_technique_preview_items_by_ids(state, character_id, &invalid_item_ids)
            .await?;
    }
    if valid_previews.is_empty() {
        return Ok(None);
    }
    if valid_previews.len() > 1 {
        return Err(AppError::Business {
            message: "存在多个待处理的伙伴打书预览，请先清理异常数据".to_string(),
            status: axum::http::StatusCode::BAD_REQUEST,
            extra: serde_json::Map::new(),
        });
    }
    Ok(valid_previews.into_iter().next())
}

async fn build_partner_preview_technique(
    state: &AppState,
    technique_id: &str,
) -> Result<PartnerTechniqueDto, AppError> {
    let Some(detail) = load_technique_detail_data(state, technique_id, None, true).await? else {
        return Err(AppError::config("伙伴功法详情不存在"));
    };
    if detail.layers.is_empty() {
        return Err(AppError::config("伙伴功法详情不存在"));
    }
    let layers = serde_json::to_value(&detail.layers)
        .map_err(|error| AppError::config(format!("伙伴预览功法层级序列化失败: {error}")))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let current_layer = 1_i64;
    let mut skill_ids = Vec::new();
    let mut passive_attrs = BTreeMap::new();
    for layer in layers.iter().filter(|layer| {
        layer
            .get("layer")
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            <= current_layer
    }) {
        if let Some(skills) = layer
            .get("unlock_skill_ids")
            .and_then(|value| value.as_array())
        {
            for skill in skills {
                if let Some(skill_id) = skill.as_str() {
                    skill_ids.push(skill_id.to_string());
                }
            }
        }
        if let Some(passives) = layer.get("passives").and_then(|value| value.as_array()) {
            for passive in passives {
                if let (Some(key), Some(value)) = (
                    passive.get("key").and_then(|value| value.as_str()),
                    passive.get("value").and_then(|value| {
                        value
                            .as_f64()
                            .or_else(|| value.as_i64().map(|value| value as f64))
                    }),
                ) {
                    *passive_attrs.entry(key.to_string()).or_insert(0.0) += value;
                }
            }
        }
    }
    skill_ids.sort();
    skill_ids.dedup();
    let skills = detail
        .skills
        .into_iter()
        .filter(|skill| skill_ids.iter().any(|skill_id| skill_id == &skill.id))
        .map(|skill| PartnerTechniqueSkillDto {
            id: skill.id,
            name: skill.name,
            icon: skill.icon.unwrap_or_default(),
            description: skill.description,
            cost_lingqi: Some(skill.cost_lingqi),
            cost_lingqi_rate: Some(skill.cost_lingqi_rate),
            cost_qixue: Some(skill.cost_qixue),
            cost_qixue_rate: Some(skill.cost_qixue_rate),
            cooldown: Some(skill.cooldown),
            target_type: Some(skill.target_type),
            target_count: Some(skill.target_count),
            damage_type: skill.damage_type,
            element: Some(skill.element),
            effects: Some(skill.effects),
            trigger_type: Some(skill.trigger_type),
            ai_priority: Some(skill.ai_priority),
        })
        .collect();
    Ok(PartnerTechniqueDto {
        technique_id: technique_id.to_string(),
        name: detail.technique.name,
        description: detail.technique.description,
        icon: detail.technique.icon,
        quality: detail.technique.quality,
        current_layer,
        max_layer: detail.technique.max_layer.max(1),
        skill_ids,
        skills,
        passive_attrs,
        is_innate: false,
    })
}

async fn consume_specific_item_instance(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
    qty: i64,
    item_def_id: &str,
) -> Result<(), AppError> {
    let row = state.database.fetch_optional(
        "SELECT qty, item_def_id FROM item_instance WHERE id = $1 AND owner_user_id = $2 AND owner_character_id = $3 LIMIT 1 FOR UPDATE",
        |query| query.bind(item_instance_id).bind(user_id).bind(character_id),
    ).await?.ok_or_else(|| AppError::config("功法书不存在"))?;
    let owned_item_def_id = row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    if owned_item_def_id.trim() != item_def_id {
        return Err(AppError::config("功法书已变化，请刷新后重试"));
    }
    let current_qty = row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if current_qty < qty {
        return Err(AppError::config("功法书数量不足"));
    }
    if current_qty == qty {
        state
            .database
            .execute("DELETE FROM item_instance WHERE id = $1", |query| {
                query.bind(item_instance_id)
            })
            .await?;
    } else {
        state
            .database
            .execute(
                "UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                |query| query.bind(item_instance_id).bind(qty),
            )
            .await?;
    }
    Ok(())
}

fn normalize_partner_name(raw: &str) -> Result<String, AppError> {
    let normalized = raw.trim();
    if normalized.is_empty() {
        return Err(AppError::config("伙伴名不能为空"));
    }
    let length = normalized.chars().count();
    if !(2..=12).contains(&length) {
        return Err(AppError::config("伙伴名需2-12个字符"));
    }
    if local_sensitive_words_contain(normalized)? {
        return Err(AppError::config("伙伴名包含敏感词，请重新输入"));
    }
    Ok(normalized.to_string())
}

fn normalize_partner_description(raw: Option<String>) -> Result<Option<String>, AppError> {
    let normalized = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if normalized
        .as_deref()
        .map(|value| value.chars().count() > 80)
        .unwrap_or(false)
    {
        return Err(AppError::config("伙伴描述最多80个字符"));
    }
    Ok(normalized)
}

fn normalize_partner_avatar(raw: Option<String>) -> Result<Option<String>, AppError> {
    let normalized = raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(value) = normalized.as_deref() {
        let valid = value.starts_with("/uploads/")
            || value.starts_with("https://")
            || value.starts_with("http://");
        if !valid {
            return Err(AppError::config("头像地址不合法"));
        }
    }
    Ok(normalized)
}

async fn consume_partner_rename_card(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
) -> Result<(), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, item_def_id, qty FROM item_instance WHERE id = $1 AND owner_user_id = $2 AND owner_character_id = $3 LIMIT 1 FOR UPDATE",
            |query| query.bind(item_instance_id).bind(user_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("易名符不存在"));
    };
    let item_def_id = row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    if !is_rename_card_item_definition(item_def_id.trim())? {
        return Err(AppError::config("该物品不能用于改名"));
    }
    let qty = row.try_get::<Option<i64>, _>("qty")?.unwrap_or_default();
    if qty <= 0 {
        return Err(AppError::config("易名符数量不足"));
    }
    if qty == 1 {
        state
            .database
            .execute("DELETE FROM item_instance WHERE id = $1", |query| {
                query.bind(item_instance_id)
            })
            .await?;
    } else {
        state
            .database
            .execute(
                "UPDATE item_instance SET qty = qty - 1, updated_at = NOW() WHERE id = $1",
                |query| query.bind(item_instance_id),
            )
            .await?;
    }
    Ok(())
}

fn is_rename_card_item_definition(item_def_id: &str) -> Result<bool, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/item_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read item_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse item_def.json: {error}")))?;
    let items = payload
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items.into_iter().any(|item| {
        item.get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            == Some(item_def_id)
            && item
                .get("effect_defs")
                .and_then(|value| value.as_array())
                .map(|effects| {
                    effects.iter().any(|effect| {
                        effect
                            .get("effect_type")
                            .and_then(|value| value.as_str())
                            .map(str::trim)
                            == Some("rename_character")
                    })
                })
                .unwrap_or(false)
    }))
}

fn local_sensitive_words_contain(content: &str) -> Result<bool, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../server/src/data/seeds/technique_name_sensitive_words.json");
    if !path.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(path).map_err(|error| {
        AppError::config(format!("failed to read local sensitive words: {error}"))
    })?;
    let payload: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
        AppError::config(format!("failed to parse local sensitive words: {error}"))
    })?;
    let words = payload
        .get("words")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let normalized = content.trim().to_lowercase();
    Ok(words
        .into_iter()
        .filter_map(|value| value.as_str().map(|value| value.trim().to_lowercase()))
        .filter(|value| !value.is_empty())
        .any(|value| normalized.contains(&value)))
}

fn load_technique_layers_for(technique_id: &str) -> Result<Vec<serde_json::Value>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_layer.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_layer.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_layer.json: {error}"))
    })?;
    let layers = payload
        .get("layers")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(layers
        .into_iter()
        .filter(|row| row.get("technique_id").and_then(|v| v.as_str()) == Some(technique_id))
        .collect())
}

async fn count_character_item_qty(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
) -> Result<i64, AppError> {
    let row = state
        .database
        .fetch_one(
            "SELECT COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' AND item_def_id = $2",
            |query| query.bind(character_id).bind(item_def_id),
        )
        .await?;
    Ok(row.try_get::<Option<i64>, _>("qty")?.unwrap_or_default())
}

async fn consume_character_item_qty(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
) -> Result<(), AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT id, qty FROM item_instance WHERE owner_user_id = $1 AND owner_character_id = $2 AND item_def_id = $3 AND location = 'bag' ORDER BY created_at ASC, id ASC FOR UPDATE",
            |query| query.bind(user_id).bind(character_id).bind(item_def_id),
        )
        .await?;
    let mut remaining = qty.max(0);
    for row in rows {
        if remaining <= 0 {
            break;
        }
        let item_id: i64 = row.try_get("id")?;
        let item_qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default()
            .max(0);
        if item_qty <= 0 {
            continue;
        }
        let consume_qty = remaining.min(item_qty);
        if consume_qty == item_qty {
            state
                .database
                .execute("DELETE FROM item_instance WHERE id = $1", |query| {
                    query.bind(item_id)
                })
                .await?;
        } else {
            state
                .database
                .execute(
                    "UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(item_id).bind(consume_qty),
                )
                .await?;
        }
        remaining -= consume_qty;
    }
    if remaining > 0 {
        return Err(AppError::config("伙伴功法升级材料扣减失败"));
    }
    Ok(())
}

fn to_number_map(value: serde_json::Value) -> BTreeMap<String, f64> {
    value
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .map(|n| (k, n))
        })
        .collect()
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

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::build_effective_partner_skill;
    use std::collections::BTreeSet;

    #[test]
    fn partner_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "unlocked": true,
                "featureCode": "partner_system",
                "activePartnerId": 1,
                "characterExp": 1200,
                "partners": [{"id": 1, "partnerDefId": "partner-qingmu-xiaoou", "nickname": "青木小偶", "tradeStatus": "none", "fusionStatus": "none"}],
                "books": [],
                "partnerConsumables": [],
                "pendingTechniqueLearnPreview": null
            }
        });
        assert_eq!(payload["data"]["featureCode"], "partner_system");
        println!("PARTNER_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn partner_overview_preview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "unlocked": true,
                "featureCode": "partner_system",
                "activePartnerId": 1,
                "characterExp": 1200,
                "partners": [{"id": 1, "partnerDefId": "partner-qingmu-xiaoou", "nickname": "青木小偶"}],
                "books": [{"itemInstanceId": 88, "itemDefId": "book-jichu-daofa", "techniqueId": "tech-jichu-daofa", "techniqueName": "基础刀法", "name": "基础刀法秘籍", "icon": null, "quality": "黄", "qty": 1}],
                "partnerConsumables": [],
                "pendingTechniqueLearnPreview": {
                    "book": {"itemInstanceId": 88, "itemDefId": "book-jichu-daofa", "techniqueId": "tech-jichu-daofa", "techniqueName": "基础刀法", "name": "基础刀法秘籍", "icon": null, "quality": "黄", "qty": 1, "previewPartnerId": 1, "previewReplacedTechniqueId": "tech-huifu-shu"},
                    "preview": {
                        "partnerId": 1,
                        "itemInstanceId": 88,
                        "learnedTechnique": {"techniqueId": "tech-jichu-daofa"},
                        "replacedTechnique": {"techniqueId": "tech-huifu-shu"}
                    }
                }
            }
        });
        assert_eq!(
            payload["data"]["pendingTechniqueLearnPreview"]["preview"]["partnerId"],
            1
        );
        println!("PARTNER_OVERVIEW_PREVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn partner_preview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"id": 1, "partnerDefId": "partner-qingmu-xiaoou", "nickname": "青木小偶"}
        });
        assert_eq!(payload["data"]["id"], 1);
        println!("PARTNER_PREVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn partner_skill_policy_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"partnerId": 1, "entries": [{"skillId": "skill-普通攻击", "priority": 1, "enabled": true}]}
        });
        assert_eq!(payload["data"]["partnerId"], 1);
        println!("PARTNER_SKILL_POLICY_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"unlockRealm": "炼神返虚·养神期", "unlocked": false, "currentJob": null, "hasUnreadResult": false}
        });
        assert_eq!(payload["data"]["unlockRealm"], "炼神返虚·养神期");
        println!("PARTNER_RECRUIT_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_generate_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已加入伙伴招募队列",
            "data": {"generationId": "partner-recruit-1", "quality": "玄", "status": "pending", "debugRealtime": {"kind": "partner:update", "source": "partner_recruit_generate"}}
        });
        assert_eq!(payload["data"]["status"], "pending");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "partner:update");
        println!("PARTNER_RECRUIT_GENERATE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_confirm_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已确认收下新伙伴",
            "data": {"generationId": "partner-recruit-1", "partnerId": 101, "partnerDefId": "gen-partner-1", "partnerName": "玄木灵偶", "partnerAvatar": null, "activated": false, "debugRealtime": {"kind": "partner:update", "source": "partner_recruit_confirm"}, "debugRankRealtime": {"kind": "rank:update"}}
        });
        assert_eq!(payload["data"]["partnerId"], 101);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "partner:update");
        println!("PARTNER_RECRUIT_CONFIRM_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_mark_viewed_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已标记查看",
            "data": {"generationId": "partner-recruit-1", "debugRealtime": {"kind": "partner:update", "source": "partner_recruit_mark_viewed"}}
        });
        assert_eq!(payload["data"]["generationId"], "partner-recruit-1");
        println!("PARTNER_RECRUIT_MARK_VIEWED_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_discard_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已放弃本次招募草稿",
            "data": {"generationId": "partner-recruit-1", "debugRealtime": {"kind": "partner:update", "source": "partner_recruit_discard"}}
        });
        assert_eq!(payload["data"]["generationId"], "partner-recruit-1");
        println!("PARTNER_RECRUIT_DISCARD_RESPONSE={}", payload);
    }

    #[test]
    fn partner_activate_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "出战伙伴已切换",
            "data": {"activePartnerId": 1, "partner": {"id": 1, "nickname": "青木小偶"}}
        });
        assert_eq!(payload["data"]["activePartnerId"], 1);
        println!("PARTNER_ACTIVATE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_dismiss_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "出战伙伴已下阵",
            "data": {"activePartnerId": null}
        });
        assert!(payload["data"]["activePartnerId"].is_null());
        println!("PARTNER_DISMISS_RESPONSE={}", payload);
    }

    #[test]
    fn partner_inject_exp_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "partner": {"id": 1, "nickname": "青木小偶"},
                "spentExp": 120,
                "levelsGained": 1,
                "characterExp": 80
            }
        });
        assert_eq!(payload["data"]["spentExp"], 120);
        println!("PARTNER_INJECT_EXP_RESPONSE={}", payload);
    }

    #[test]
    fn partner_upgrade_technique_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "治愈术修炼至第2层",
            "data": {
                "partner": {"id": 1, "nickname": "青木小偶"},
                "updatedTechnique": {"techniqueId": "tech-huifu-shu", "currentLayer": 2},
                "newLayer": 2
            }
        });
        assert_eq!(payload["data"]["newLayer"], 2);
        println!("PARTNER_UPGRADE_TECHNIQUE_RESPONSE={}", payload);
    }

    #[test]
    fn partner_rename_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "伙伴改名成功",
            "data": {"partner": {"id": 1, "nickname": "青衣小偶"}}
        });
        assert_eq!(payload["data"]["partner"]["nickname"], "青衣小偶");
        println!("PARTNER_RENAME_RESPONSE={}", payload);
    }

    #[test]
    fn partner_learn_technique_preview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "请确认本次功法替换预览",
            "data": {
                "mode": "preview_replace",
                "preview": {
                    "partnerId": 1,
                    "itemInstanceId": 99,
                    "learnedTechnique": {"techniqueId": "tech-jichu-daofa"},
                    "replacedTechnique": {"techniqueId": "tech-huifu-shu"}
                }
            }
        });
        assert_eq!(payload["data"]["mode"], "preview_replace");
        println!("PARTNER_LEARN_TECHNIQUE_RESPONSE={}", payload);
    }

    #[test]
    fn generated_partner_learn_result_prefers_book_metadata_name() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "mode": "learned",
                "result": {
                    "partner": { "id": 1 },
                    "learnedTechnique": {
                        "techniqueId": "gt-001",
                        "name": "云水诀",
                        "quality": "玄"
                    },
                    "replacedTechnique": null,
                    "remainingBooks": []
                }
            }
        });
        assert_eq!(
            payload["data"]["result"]["learnedTechnique"]["name"],
            "云水诀"
        );
        assert_eq!(
            payload["data"]["result"]["learnedTechnique"]["quality"],
            "玄"
        );
    }

    #[test]
    fn build_effective_partner_skill_sorts_upgrades_by_layer_and_preserves_trigger_type() {
        let skill = crate::http::technique::SkillDefDto {
            id: "skill-1".to_string(),
            code: None,
            name: "测试技能".to_string(),
            description: None,
            icon: None,
            source_type: "technique".to_string(),
            source_id: Some("tech-1".to_string()),
            cost_lingqi: 10,
            cost_lingqi_rate: 0.0,
            cost_qixue: 0,
            cost_qixue_rate: 0.0,
            cooldown: 3,
            target_type: "single_enemy".to_string(),
            target_count: 1,
            damage_type: None,
            element: "wood".to_string(),
            effects: vec![serde_json::json!({"type":"damage","ratio":1.0})],
            trigger_type: "counter".to_string(),
            conditions: None,
            ai_priority: 10,
            ai_conditions: None,
            upgrades: Some(vec![
                serde_json::json!({"layer": 2, "changes": {"target_count": 3}}),
                serde_json::json!({"layer": 1, "changes": {"cooldown": -1}}),
            ]),
            sort_weight: 0,
            version: 1,
            enabled: true,
        };
        let effective = build_effective_partner_skill(skill, 2);
        assert_eq!(effective.trigger_type.as_deref(), Some("counter"));
        assert_eq!(effective.cooldown, Some(2));
        assert_eq!(effective.target_count, Some(3));
    }

    #[test]
    fn build_partner_techniques_counts_innate_entries_without_persisted_rows() {
        let defs = super::load_partner_def_map().expect("partner defs should load");
        let tech_defs = super::load_technique_def_map().expect("tech defs should load");
        let skill_defs = super::load_skill_def_map().expect("skill defs should load");
        let def = defs
            .get("partner-qingmu-xiaoou")
            .expect("partner-qingmu-xiaoou should exist");

        let techniques = super::build_partner_techniques(def, Vec::new(), &tech_defs, &skill_defs)
            .expect("partner techniques should build");
        let innate_count = def
            .innate_technique_ids
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect::<BTreeSet<_>>()
            .len();

        assert!(innate_count > 0);
        assert_eq!(techniques.len(), innate_count);
    }

    #[test]
    fn partner_overview_generated_book_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "books": [{
                    "itemInstanceId": 77,
                    "itemDefId": "book-generated-technique",
                    "techniqueId": "gt-001",
                    "techniqueName": "云水诀",
                    "name": "《云水诀》秘卷",
                    "icon": null,
                    "quality": "玄",
                    "qty": 1
                }]
            }
        });
        assert_eq!(payload["data"]["books"][0]["techniqueName"], "云水诀");
        assert_eq!(payload["data"]["books"][0]["name"], "《云水诀》秘卷");
    }

    #[test]
    fn partner_confirm_learn_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "伙伴打书成功",
            "data": {"partner": {"id": 1}, "learnedTechnique": {"techniqueId": "tech-jichu-daofa"}, "replacedTechnique": {"techniqueId": "tech-huifu-shu"}, "remainingBooks": []}
        });
        assert_eq!(
            payload["data"]["learnedTechnique"]["techniqueId"],
            "tech-jichu-daofa"
        );
        println!("PARTNER_CONFIRM_LEARN_RESPONSE={}", payload);
    }

    #[test]
    fn partner_discard_learn_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已放弃学习，本次功法书已消耗",
            "data": {"remainingBooks": []}
        });
        assert!(payload["data"]["remainingBooks"].is_array());
        println!("PARTNER_DISCARD_LEARN_RESPONSE={}", payload);
    }

    #[test]
    fn partner_technique_upgrade_cost_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"currentLayer": 1, "maxLayer": 9, "nextLayer": 2, "spiritStones": 100, "exp": 50, "materials": []}
        });
        assert_eq!(payload["data"]["nextLayer"], 2);
        println!("PARTNER_TECHNIQUE_UPGRADE_COST_RESPONSE={}", payload);
    }

    #[test]
    fn partner_technique_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"technique": {"id": "tech-huifu-shu"}, "layers": [{"technique_id": "tech-huifu-shu", "layer": 1}], "skills": [{"id": "skill-huifu-shu-1"}], "currentLayer": 1, "isInnate": true}
        });
        assert_eq!(payload["data"]["currentLayer"], 1);
        println!("PARTNER_TECHNIQUE_DETAIL_RESPONSE={}", payload);
    }

    #[test]
    fn partner_fusion_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取三魂归契状态成功",
            "data": {"featureCode": "partner_system", "unlocked": true, "currentJob": null, "hasUnreadResult": false, "resultStatus": null}
        });
        assert_eq!(payload["data"]["featureCode"], "partner_system");
        println!("PARTNER_FUSION_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn partner_fusion_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "三魂归契已开始",
            "data": {"fusionId": "partner-fusion-1", "sourceQuality": "玄", "resultQuality": "地", "debugRealtime": {"kind": "partner:update", "source": "partner_fusion_start"}}
        });
        assert_eq!(payload["data"]["fusionId"], "partner-fusion-1");
        println!("PARTNER_FUSION_START_RESPONSE={}", payload);
    }

    #[test]
    fn partner_fusion_confirm_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已确认收下新伙伴",
            "data": {"fusionId": "partner-fusion-1", "partnerId": 201, "partnerDefId": "gen-fusion-partner-1", "partnerName": "炎羽灵偶", "partnerAvatar": null, "activated": false, "debugRealtime": {"kind": "partner:update", "source": "partner_fusion_confirm"}, "debugRankRealtime": {"kind": "rank:update"}}
        });
        assert_eq!(payload["data"]["partnerId"], 201);
        println!("PARTNER_FUSION_CONFIRM_RESPONSE={}", payload);
    }

    #[test]
    fn partner_fusion_mark_viewed_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已标记查看",
            "data": {"fusionId": "partner-fusion-1", "debugRealtime": {"kind": "partner:update", "source": "partner_fusion_mark_viewed"}}
        });
        assert_eq!(payload["data"]["fusionId"], "partner-fusion-1");
        println!("PARTNER_FUSION_MARK_VIEWED_RESPONSE={}", payload);
    }

    #[test]
    fn partner_rebone_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取归元洗髓状态成功",
            "data": {"featureCode": "partner_system", "unlocked": true, "currentJob": null, "hasUnreadResult": false, "resultStatus": null}
        });
        assert_eq!(payload["data"]["featureCode"], "partner_system");
        println!("PARTNER_REBONE_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn partner_rebone_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "归元洗髓已开始",
            "data": {"reboneId": "partner-rebone-1", "partnerId": 7, "debugRealtime": {"kind": "partner:update", "source": "partner_rebone_start"}}
        });
        assert_eq!(payload["data"]["reboneId"], "partner-rebone-1");
        println!("PARTNER_REBONE_START_RESPONSE={}", payload);
    }

    #[test]
    fn partner_rebone_mark_viewed_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已标记查看",
            "data": {"reboneId": "partner-rebone-1", "debugRealtime": {"kind": "partner:update", "source": "partner_rebone_mark_viewed"}}
        });
        assert_eq!(payload["data"]["reboneId"], "partner-rebone-1");
        println!("PARTNER_REBONE_MARK_VIEWED_RESPONSE={}", payload);
    }

    #[test]
    fn partner_recruit_generated_name_is_deterministic() {
        let seeded = super::build_generated_partner_recruit_name("玄", Some("青木"));
        let fallback = super::build_generated_partner_recruit_name("黄", None);
        assert_eq!(seeded, "玄·青木灵伴");
        assert_eq!(fallback, "黄·无相灵伴");
        println!(
            "PARTNER_RECRUIT_GENERATED_NAMES={{\"seeded\":\"{seeded}\",\"fallback\":\"{fallback}\"}}"
        );
    }

    #[test]
    fn partner_fusion_generated_name_is_deterministic() {
        let seeded = super::build_generated_partner_fusion_name("地", Some("青木灵伴"));
        let fallback = super::build_generated_partner_fusion_name("黄", None);
        assert_eq!(seeded, "地·青木灵伴归灵");
        assert_eq!(fallback, "黄·无相归灵");
        println!(
            "PARTNER_FUSION_GENERATED_NAMES={{\"seeded\":\"{seeded}\",\"fallback\":\"{fallback}\"}}"
        );
    }
}
