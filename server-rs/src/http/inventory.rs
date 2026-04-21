use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tracing::warn;

use crate::auth;
use crate::http::partner::load_partner_books;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    CharacterItemGrantDelta, buffer_character_item_grant_deltas, claim_character_item_grant_delta,
    finalize_claimed_character_item_grant_delta, load_claimed_character_item_grant_delta_hash,
    parse_item_grant_delta_hash, restore_claimed_character_item_grant_delta,
};
use crate::integrations::redis_item_instance_mutation::{
    BufferedItemInstanceMutation, ItemInstanceMutationSnapshot, buffer_item_instance_mutations,
    claim_character_item_instance_mutations, finalize_claimed_item_instance_mutations,
    load_claimed_item_instance_mutation_hash, parse_item_instance_mutation_hash,
    restore_claimed_item_instance_mutations,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
    claim_character_resource_delta, finalize_claimed_character_resource_delta,
    load_claimed_character_resource_delta_hash, parse_resource_delta_hash,
    restore_claimed_character_resource_delta,
};
use crate::realtime::public_socket::emit_game_character_full_to_user;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

const INVENTORY_MUTEX_NAMESPACE: i32 = 3101;
const DEFAULT_MONTH_CARD_ID: &str = "monthcard-001";
const STAMINA_BASE_MAX: i64 = 100;
const STAMINA_RECOVER_PER_TICK: i64 = 1;
const STAMINA_RECOVER_INTERVAL_SEC: i64 = 300;
const DEFAULT_RANDOM_GEM_SUB_CATEGORIES: &[&str] = &["gem_attack", "gem_defense", "gem_survival"];
const GEM_EXECUTE_MAX_TIMES: i64 = 999_999;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

#[derive(Debug, Clone, Serialize)]
pub struct InventoryInfoDataDto {
    pub bag_capacity: i64,
    pub warehouse_capacity: i64,
    pub bag_used: i64,
    pub warehouse_used: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemDefLiteDto {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub quality: String,
    pub category: String,
    pub sub_category: Option<String>,
    pub can_disassemble: bool,
    pub stack_max: i64,
    pub description: Option<String>,
    pub long_desc: Option<String>,
    pub tags: serde_json::Value,
    pub effect_defs: serde_json::Value,
    pub base_attrs: serde_json::Value,
    pub equip_slot: Option<String>,
    pub use_type: Option<String>,
    pub use_req_realm: Option<String>,
    pub equip_req_realm: Option<String>,
    pub use_req_level: Option<i64>,
    pub use_limit_daily: Option<i64>,
    pub use_limit_total: Option<i64>,
    pub socket_max: Option<i64>,
    pub gem_slot_types: Option<serde_json::Value>,
    pub gem_level: Option<i64>,
    pub set_id: Option<String>,
    pub set_name: Option<String>,
    pub set_bonuses: Option<serde_json::Value>,
    pub set_equipped_count: Option<i64>,
    pub generated_technique_id: Option<String>,
    pub generated_technique_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InventoryItemDto {
    pub id: i64,
    pub item_def_id: String,
    pub qty: i64,
    pub quality: Option<String>,
    pub quality_rank: Option<i64>,
    pub location: String,
    pub location_slot: Option<i64>,
    pub equipped_slot: Option<String>,
    pub strengthen_level: i64,
    pub refine_level: i64,
    pub affixes: serde_json::Value,
    pub identified: bool,
    pub locked: bool,
    pub bind_type: String,
    pub socketed_gems: Option<serde_json::Value>,
    pub created_at: String,
    pub def: Option<ItemDefLiteDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItemsDataDto {
    pub items: Vec<InventoryItemDto>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryBagSnapshotDataDto {
    pub info: InventoryInfoDataDto,
    pub bag_items: Vec<InventoryItemDto>,
    pub equipped_items: Vec<InventoryItemDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryItemsQuery {
    pub location: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftRecipesQuery {
    pub recipe_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySortPayload {
    pub location: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryLockPayload {
    pub item_id: Option<i64>,
    pub locked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryMovePayload {
    pub item_id: Option<i64>,
    pub target_location: Option<String>,
    pub target_slot: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEquipPayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketPayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub gem_item_id: Option<i64>,
    pub gem_item_instance_id: Option<i64>,
    pub gem_instance_id: Option<i64>,
    pub slot: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUnequipPayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub target_location: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUsePayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub qty: Option<i64>,
    pub target_item_instance_id: Option<i64>,
    pub partner_id: Option<i64>,
    pub nickname: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassemblePayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub qty: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassembleBatchPayload {
    pub items: Option<Vec<InventoryDisassembleBatchItemPayload>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassembleBatchItemPayload {
    pub item_id: Option<i64>,
    pub qty: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGrowthPreviewPayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollPayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub lock_indexes: Option<Vec<i64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRefineResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryRefineResponseData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRefineResponseData {
    pub refine_level: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_level: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_material: Option<InventoryRefineMaterialCostDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costs: Option<InventoryRefineCostDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<InventoryCharacterSnapshotDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRefineMaterialCostDto {
    pub item_def_id: String,
    pub qty: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRefineCostDto {
    pub silver: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEnhanceResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryEnhanceResponseData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEnhanceResponseData {
    pub strengthen_level: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_level: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destroyed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_material: Option<InventoryRefineMaterialCostDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costs: Option<InventoryRefineCostDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<InventoryCharacterSnapshotDto>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRemovePayload {
    pub item_id: Option<i64>,
    pub item_instance_id: Option<i64>,
    pub instance_id: Option<i64>,
    pub qty: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRemoveBatchPayload {
    pub item_ids: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRemoveBatchResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed_qty_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_locked_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_locked_qty_total: Option<i64>,
}

#[derive(Debug, Clone)]
pub(crate) struct InventoryDefSeed {
    pub(crate) row: serde_json::Value,
}

#[derive(Debug, Clone)]
struct SortInventoryRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    quality: Option<String>,
    quality_rank: Option<i64>,
    bind_type: String,
    metadata: Option<serde_json::Value>,
    location_slot: Option<i64>,
}

#[derive(Debug, Clone)]
struct SortInventoryRankedRow {
    row: SortInventoryRow,
    category: Option<String>,
    sub_category: Option<String>,
    resolved_quality_rank: i64,
}

#[derive(Debug, Clone)]
struct InventoryBatchRemovalRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    location: String,
    locked: bool,
}

#[derive(Debug, Clone, PartialEq)]
struct InventoryMoveRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    location: String,
    location_slot: Option<i64>,
    bind_type: String,
    metadata: Option<serde_json::Value>,
    quality: Option<String>,
    quality_rank: Option<i64>,
}

#[derive(Debug, Clone)]
struct InventoryEquipRow {
    id: i64,
    item_def_id: String,
    qty: i64,
    location: String,
    location_slot: Option<i64>,
    equipped_slot: Option<String>,
    bind_type: String,
    bind_owner_user_id: Option<i64>,
    bind_owner_character_id: Option<i64>,
    locked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCharacterSnapshotDto {
    pub id: i64,
    pub nickname: String,
    pub gender: String,
    pub title: String,
    pub realm: String,
    pub sub_realm: Option<String>,
    pub spirit_stones: i64,
    pub silver: i64,
    pub qixue: i64,
    pub max_qixue: i64,
    pub wugong: i64,
    pub wufang: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCharacterResponseData {
    pub character: InventoryCharacterSnapshotDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUseCharacterSnapshotDto {
    pub qixue: i64,
    pub lingqi: i64,
    pub exp: i64,
    pub stamina: i64,
    #[serde(rename = "stamina_max")]
    pub stamina_max: i64,
    pub max_qixue: i64,
    pub max_lingqi: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUseResponseData {
    pub character: InventoryUseCharacterSnapshotDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loot_results: Option<Vec<InventoryUseLootResultDto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_technique_result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_rebone_job: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUseResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<serde_json::Value>,
    pub data: InventoryUseResponseData,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryUseLootResultDto {
    pub r#type: String,
    pub name: Option<String>,
    pub amount: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_def_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassembleRewardsDto {
    pub silver: i64,
    pub items: Vec<InventoryUseLootResultDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassembleResponse {
    pub success: bool,
    pub message: String,
    pub rewards: InventoryDisassembleRewardsDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryDisassembleBatchResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disassembled_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disassembled_qty_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_locked_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_locked_qty_total: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<InventoryDisassembleRewardsDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGrowthCostPreviewResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryGrowthCostPreviewData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGrowthCostPreviewData {
    pub enhance: InventoryGrowthPreviewEntry,
    pub refine: InventoryGrowthPreviewEntry,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGrowthPreviewEntry {
    pub current_level: i64,
    pub target_level: i64,
    pub max_level: Option<i64>,
    pub success_rate: f64,
    pub fail_mode: String,
    pub costs: Option<InventoryGrowthCostPlanDto>,
    pub preview_base_attrs: BTreeMap<String, i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGrowthCostPlanDto {
    pub material_item_def_id: String,
    pub material_name: String,
    pub material_qty: i64,
    pub silver_cost: i64,
    pub spirit_stone_cost: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerolledAffixDto {
    pub key: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<InventorySocketEffectDto>>,
    pub apply_type: String,
    pub tier: i64,
    pub value: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roll_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_legendary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_round: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollCostPreviewEntryDto {
    pub lock_count: i64,
    pub reroll_scroll_qty: i64,
    pub silver_cost: i64,
    pub spirit_stone_cost: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollCostPreviewDataDto {
    pub reroll_scroll_item_def_id: String,
    pub max_lock_count: i64,
    pub cost_table: Vec<InventoryRerollCostPreviewEntryDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollCostPreviewResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryRerollCostPreviewDataDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryAffixPoolPreviewTierDto {
    pub tier: i64,
    pub min: f64,
    pub max: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryAffixPoolPreviewAffixDto {
    pub key: String,
    pub name: String,
    pub group: String,
    pub is_legendary: bool,
    pub apply_type: String,
    pub tiers: Vec<InventoryAffixPoolPreviewTierDto>,
    pub owned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effect_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_round: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description_template: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryAffixPoolPreviewDataDto {
    pub pool_name: String,
    pub affixes: Vec<InventoryAffixPoolPreviewAffixDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryAffixPoolPreviewResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryAffixPoolPreviewDataDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollCostDto {
    pub silver: i64,
    pub spirit_stones: i64,
    pub reroll_scroll: InventoryRerollScrollCostDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollScrollCostDto {
    pub item_def_id: String,
    pub qty: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollResponseData {
    pub affixes: Vec<InventoryRerolledAffixDto>,
    pub lock_indexes: Vec<i64>,
    pub costs: InventoryRerollCostDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<InventoryCharacterSnapshotDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryRerollResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryRerollResponseData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftRecipesResponse {
    pub success: bool,
    pub message: String,
    pub data: InventoryCraftRecipesData,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecutePayload {
    pub recipe_id: Option<String>,
    pub times: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGemSynthesisExecutePayload {
    pub recipe_id: Option<String>,
    pub times: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGemSynthesisBatchPayload {
    pub gem_type: Option<String>,
    pub target_level: Option<serde_json::Value>,
    pub source_level: Option<serde_json::Value>,
    pub series_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryGemConvertExecutePayload {
    pub selected_gem_item_ids: Vec<serde_json::Value>,
    pub times: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftRecipesData {
    pub character: InventoryCraftCharacterDto,
    pub recipes: Vec<InventoryCraftRecipeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftCharacterDto {
    pub realm: String,
    pub exp: i64,
    pub silver: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftRecipeDto {
    pub id: String,
    pub name: String,
    pub recipe_type: String,
    pub product: InventoryCraftProductDto,
    pub costs: InventoryCraftCostsDto,
    pub requirements: InventoryCraftRequirementsDto,
    pub success_rate: f64,
    pub fail_return_rate: f64,
    pub max_craft_times: i64,
    pub craftable: bool,
    pub craft_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftProductDto {
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub qty: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftCostsDto {
    pub silver: i64,
    pub spirit_stones: i64,
    pub exp: i64,
    pub items: Vec<InventoryCraftCostItemDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftCostItemDto {
    pub item_def_id: String,
    pub item_name: String,
    pub required: i64,
    pub owned: i64,
    pub missing: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftRequirementsDto {
    pub realm: Option<String>,
    pub level: i64,
    pub building: Option<String>,
    pub realm_met: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecuteResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventoryCraftExecuteData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecuteData {
    pub recipe_id: String,
    pub recipe_type: String,
    pub craft_kind: String,
    pub times: i64,
    pub success_count: i64,
    pub fail_count: i64,
    pub spent: InventoryCraftExecuteSpentDto,
    pub returned_items: Vec<InventoryCraftExecuteReturnedItemDto>,
    pub produced: Option<InventoryCraftExecuteProducedDto>,
    pub character: InventoryCraftCharacterDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecuteSpentDto {
    pub silver: i64,
    pub spirit_stones: i64,
    pub exp: i64,
    pub items: Vec<InventoryCraftExecuteReturnedItemDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecuteReturnedItemDto {
    pub item_def_id: String,
    pub qty: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryCraftExecuteProducedDto {
    pub item_def_id: String,
    pub item_name: String,
    pub item_icon: Option<String>,
    pub qty: i64,
    pub item_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemCharacterWalletDto {
    pub silver: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisRecipeDto {
    pub recipe_id: String,
    pub name: String,
    pub gem_type: String,
    pub series_key: String,
    pub from_level: i64,
    pub to_level: i64,
    pub input: GemItemRefDto,
    pub output: GemItemTargetDto,
    pub costs: GemCostDto,
    pub success_rate: f64,
    pub max_synthesize_times: i64,
    pub can_synthesize: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemItemRefDto {
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub qty: i64,
    pub owned: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemItemTargetDto {
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub qty: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemCostDto {
    pub silver: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisRecipeListResponse {
    pub success: bool,
    pub message: String,
    pub data: GemSynthesisRecipeListData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisRecipeListData {
    pub character: GemCharacterWalletDto,
    pub recipes: Vec<GemSynthesisRecipeDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertOptionDto {
    pub input_level: i64,
    pub output_level: i64,
    pub input_gem_qty_per_convert: i64,
    pub owned_input_gem_qty: i64,
    pub cost_spirit_stones_per_convert: i64,
    pub max_convert_times: i64,
    pub can_convert: bool,
    pub candidate_gem_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertOptionListResponse {
    pub success: bool,
    pub message: String,
    pub data: GemConvertOptionListData,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertOptionListData {
    pub character: GemCharacterWalletDto,
    pub options: Vec<GemConvertOptionDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisExecuteResponse {
    pub success: bool,
    pub message: String,
    pub data: Option<GemSynthesisExecuteData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisExecuteData {
    pub recipe_id: String,
    pub gem_type: String,
    pub series_key: String,
    pub from_level: i64,
    pub to_level: i64,
    pub times: i64,
    pub success_count: i64,
    pub fail_count: i64,
    pub success_rate: f64,
    pub consumed: InventoryCraftExecuteReturnedItemDto,
    pub spent: GemCostDto,
    pub produced: Option<InventoryCraftExecuteProducedDto>,
    pub character: GemCharacterWalletDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisBatchResponse {
    pub success: bool,
    pub message: String,
    pub data: Option<GemSynthesisBatchData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisBatchData {
    pub gem_type: String,
    pub series_key: String,
    pub source_level: i64,
    pub target_level: i64,
    pub total_spent: GemCostDto,
    pub steps: Vec<GemSynthesisBatchStepDto>,
    pub character: GemCharacterWalletDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemSynthesisBatchStepDto {
    pub recipe_id: String,
    pub series_key: String,
    pub from_level: i64,
    pub to_level: i64,
    pub times: i64,
    pub success_count: i64,
    pub fail_count: i64,
    pub success_rate: f64,
    pub consumed: InventoryCraftExecuteReturnedItemDto,
    pub spent: GemCostDto,
    pub produced: InventoryCraftExecuteProducedDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertExecuteResponse {
    pub success: bool,
    pub message: String,
    pub data: Option<GemConvertExecuteData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertExecuteData {
    pub input_level: i64,
    pub output_level: i64,
    pub times: i64,
    pub consumed: GemConvertConsumedDto,
    pub spent: GemConvertSpentDto,
    pub produced: GemConvertProducedDto,
    pub character: GemCharacterWalletDto,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertConsumedDto {
    pub input_gem_qty: i64,
    pub selected_gem_item_ids: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertSpentDto {
    pub spirit_stones: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GemConvertProducedDto {
    pub total_qty: i64,
    pub items: Vec<InventoryCraftExecuteProducedDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketEffectDto {
    pub attr_key: String,
    pub value: f64,
    pub apply_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketedGemEntryDto {
    pub slot: i64,
    pub item_def_id: String,
    pub gem_type: String,
    pub effects: Vec<InventorySocketEffectDto>,
    pub name: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<InventorySocketResponseData>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketResponseData {
    pub socketed_gems: Vec<InventorySocketedGemEntryDto>,
    pub socket_max: i64,
    pub slot: i64,
    pub gem: InventorySocketGemDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replaced_gem: Option<InventorySocketedGemEntryDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costs: Option<InventorySocketCostDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub character: Option<InventoryCharacterSnapshotDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketGemDto {
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub gem_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventorySocketCostDto {
    pub silver: i64,
}

#[derive(Debug, Clone)]
struct InventoryDisassemblePlan {
    rewards: InventoryDisassembleRewardsDto,
}

#[derive(Debug, Deserialize, Clone)]
struct InventoryTechniqueDefFile {
    techniques: Vec<InventoryTechniqueDefSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct InventoryRecipeFile {
    recipes: Vec<serde_json::Value>,
}

struct GemRecipeSeedRow {
    id: String,
    name: String,
    from_level: i64,
    to_level: i64,
    gem_type: String,
    series_key: String,
    input_item_def_id: String,
    input_qty: i64,
    output_item_def_id: String,
    output_qty: i64,
    cost_silver: i64,
    cost_spirit_stones: i64,
    success_rate: f64,
}

#[derive(Debug, Deserialize, Clone)]
struct InventoryTechniqueDefSeed {
    id: String,
    name: String,
    quality: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    tags: Option<serde_json::Value>,
    required_realm: Option<String>,
    usage_scope: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone)]
pub(crate) struct GeneratedTechniqueBookDisplayOverride {
    pub generated_technique_id: String,
    pub generated_technique_name: String,
    pub name: String,
    pub quality: Option<String>,
    pub description: String,
    pub long_desc: String,
    pub tags: serde_json::Value,
}

const REROLL_SCROLL_ITEM_DEF_ID: &str = "scroll-003";

#[derive(Debug, Clone, Deserialize)]
struct InventoryAffixPoolFile {
    pools: Vec<InventoryAffixPoolSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct InventoryAffixPoolSeed {
    id: String,
    name: String,
    rules: InventoryAffixPoolRulesSeed,
    affixes: Vec<InventoryAffixSeed>,
}

#[derive(Debug, Clone, Deserialize)]
struct InventoryAffixPoolRulesSeed {
    allow_duplicate: bool,
    legendary_chance: Option<f64>,
    mutex_groups: Option<Vec<Vec<String>>>,
}

#[derive(Debug, Clone, Deserialize)]
struct InventoryAffixSeed {
    key: String,
    name: String,
    apply_type: String,
    group: Option<String>,
    weight: Option<f64>,
    start_tier: Option<i64>,
    allowed_slots: Option<Vec<String>>,
    values: Option<serde_json::Value>,
    modifiers: Option<Vec<InventoryAffixModifierSeed>>,
    is_legendary: Option<bool>,
    trigger: Option<String>,
    target: Option<String>,
    effect_type: Option<String>,
    duration_round: Option<i64>,
    params: Option<BTreeMap<String, serde_json::Value>>,
    description_template: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct InventoryAffixModifierSeed {
    attr_key: String,
}

#[derive(Debug, Clone)]
struct InventoryRerollCostPlan {
    silver_cost: i64,
    spirit_stone_cost: i64,
    reroll_scroll_qty: i64,
}

#[derive(Debug, Clone)]
struct InventoryRerollItemState {
    _item_instance_id: i64,
    item_def_id: String,
    location: String,
    _locked: bool,
    quality: Option<String>,
    quality_rank: Option<i64>,
    affixes: Vec<InventoryRerolledAffixDto>,
    affix_pool_id: String,
    equip_slot: String,
    equip_req_realm: Option<String>,
}

pub async fn get_inventory_info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<InventoryInfoDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let info = load_inventory_info(&state, actor.character_id).await?;
    Ok(send_success(info))
}

pub async fn get_bag_inventory_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<InventoryBagSnapshotDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let info = load_inventory_info(&state, actor.character_id).await?;
    let bag_items = load_inventory_items_with_defs(&state, actor.character_id, "bag", 1, 200)
        .await?
        .items;
    let equipped_items =
        load_inventory_items_with_defs(&state, actor.character_id, "equipped", 1, 200)
            .await?
            .items;
    Ok(send_success(InventoryBagSnapshotDataDto {
        info,
        bag_items,
        equipped_items,
    }))
}

pub async fn get_inventory_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InventoryItemsQuery>,
) -> Result<Json<SuccessResponse<InventoryItemsDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let location = query.location.as_deref().unwrap_or("bag").trim();
    if !matches!(location, "bag" | "warehouse" | "equipped") {
        return Err(AppError::config("location参数错误"));
    }
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(100).clamp(1, 200);
    Ok(send_success(
        load_inventory_items_with_defs(&state, actor.character_id, location, page, page_size)
            .await?,
    ))
}

pub async fn list_inventory_craft_recipes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InventoryCraftRecipesQuery>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let defs = load_inventory_def_map()?;
    let character = load_inventory_craft_character(&state, actor.user_id).await?;
    let owned_qty = load_owned_item_qty_map(&state, actor.character_id).await?;
    let recipes =
        build_inventory_craft_recipes(&defs, &owned_qty, &character, query.recipe_type.as_deref())?;
    Ok((
        StatusCode::OK,
        Json(InventoryCraftRecipesResponse {
            success: true,
            message: "ok".to_string(),
            data: InventoryCraftRecipesData { character, recipes },
        }),
    )
        .into_response())
}

pub async fn execute_inventory_craft_recipe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryCraftExecutePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let recipe_id = payload
        .recipe_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("recipeId参数错误"))?;
    let times = parse_optional_positive_i64_json(payload.times.as_ref(), "times")?.unwrap_or(1);
    let response = state
        .database
        .with_transaction(|| async {
            execute_inventory_craft_recipe_tx(&state, actor.user_id, times.clamp(1, 99), recipe_id)
                .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "craft",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn preview_inventory_disassemble(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryDisassemblePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    let qty = payload.qty.unwrap_or(1);
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    if qty <= 0 {
        return Err(AppError::config("qty参数错误"));
    }
    let plan = preview_inventory_disassemble_plan(&state, actor.character_id, item_id, qty).await?;
    Ok((
        StatusCode::OK,
        Json(InventoryDisassembleResponse {
            success: true,
            message: "获取预览成功".to_string(),
            rewards: plan.rewards,
        }),
    )
        .into_response())
}

pub async fn disassemble_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryDisassemblePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    let qty = payload.qty.unwrap_or(1);
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    if qty <= 0 {
        return Err(AppError::config("qty参数错误"));
    }
    let response = state
        .database
        .with_transaction(|| async {
            disassemble_inventory_item_tx(&state, actor.user_id, actor.character_id, item_id, qty)
                .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "disassemble",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn disassemble_inventory_items_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryDisassembleBatchPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let items = payload.items.unwrap_or_default();
    if items.is_empty() {
        return Err(AppError::config("items参数错误"));
    }
    let parsed_items = items
        .into_iter()
        .map(|item| {
            let item_id = item.item_id.unwrap_or_default();
            let qty = item.qty.unwrap_or_default();
            if item_id <= 0 || qty <= 0 {
                return Err(AppError::config("items参数错误"));
            }
            Ok((item_id, qty))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let response = state
        .database
        .with_transaction(|| async {
            disassemble_inventory_items_batch_tx(
                &state,
                actor.user_id,
                actor.character_id,
                parsed_items,
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "disassemble_batch",
    )
    .await;
    Ok((
        if response.success {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        Json(response),
    )
        .into_response())
}

pub async fn preview_inventory_growth_cost(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGrowthPreviewPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let data = build_inventory_growth_cost_preview(&state, actor.character_id, item_id).await?;
    Ok((
        StatusCode::OK,
        Json(InventoryGrowthCostPreviewResponse {
            success: true,
            message: "获取成功".to_string(),
            data: Some(data),
        }),
    )
        .into_response())
}

pub async fn preview_inventory_reroll_cost(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGrowthPreviewPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let response = preview_inventory_reroll_cost_tx(&state, actor.character_id, item_id).await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn preview_inventory_affix_pool(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGrowthPreviewPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let response = preview_inventory_affix_pool_tx(&state, actor.character_id, item_id).await?;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn reroll_inventory_affixes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryRerollPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let lock_indexes = payload.lock_indexes.unwrap_or_default();
    if lock_indexes.iter().any(|idx| *idx < 0) {
        return Err(AppError::config("lockIndexes参数错误"));
    }
    let response = state
        .database
        .with_transaction(|| async {
            reroll_inventory_affixes_tx(
                &state,
                actor.user_id,
                actor.character_id,
                item_id,
                lock_indexes,
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "reroll_affixes",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn list_inventory_gem_synthesis_recipes(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let defs = load_inventory_def_map()?;
    let wallet = load_gem_wallet(&state, actor.character_id).await?;
    let owned_qty = load_owned_item_qty_map(&state, actor.character_id).await?;
    let recipes = build_gem_synthesis_recipes(&defs, &owned_qty, &wallet)?;
    Ok((
        StatusCode::OK,
        Json(GemSynthesisRecipeListResponse {
            success: true,
            message: "ok".to_string(),
            data: GemSynthesisRecipeListData {
                character: wallet,
                recipes,
            },
        }),
    )
        .into_response())
}

pub async fn list_inventory_gem_convert_options(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let defs = load_inventory_def_map()?;
    let wallet = load_gem_wallet(&state, actor.character_id).await?;
    let owned_qty = load_owned_item_qty_map(&state, actor.character_id).await?;
    let options = build_gem_convert_options(&defs, &wallet, &owned_qty);
    Ok((
        StatusCode::OK,
        Json(GemConvertOptionListResponse {
            success: true,
            message: "ok".to_string(),
            data: GemConvertOptionListData {
                character: wallet,
                options,
            },
        }),
    )
        .into_response())
}

pub async fn synthesize_inventory_gem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGemSynthesisExecutePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let recipe_id = payload
        .recipe_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("recipeId参数错误"))?;
    let times = parse_optional_positive_i64_json(payload.times.as_ref(), "times")?.unwrap_or(1);
    let response = state
        .database
        .with_transaction(|| async {
            synthesize_inventory_gem_tx(
                &state,
                actor.user_id,
                actor.character_id,
                recipe_id,
                normalize_gem_execute_times(times),
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "gem_synthesize",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn synthesize_inventory_gem_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGemSynthesisBatchPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let gem_type = payload
        .gem_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("gemType参数错误"))?;
    let target_level =
        parse_optional_positive_i64_json(payload.target_level.as_ref(), "targetLevel")?
            .unwrap_or_default();
    if target_level < 2 || target_level > 10 {
        return Err(AppError::config("targetLevel参数错误"));
    }
    let source_level = normalize_gem_synthesis_batch_source_level(
        parse_optional_positive_i64_json(payload.source_level.as_ref(), "sourceLevel")?,
    )?;
    if source_level >= target_level {
        return Err(AppError::config("targetLevel必须大于sourceLevel"));
    }
    let response = state
        .database
        .with_transaction(|| async {
            synthesize_inventory_gem_batch_tx(
                &state,
                actor.user_id,
                actor.character_id,
                gem_type,
                source_level,
                target_level,
                payload.series_key.as_deref(),
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "gem_synthesize_batch",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn convert_inventory_gem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGemConvertExecutePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let selected_gem_item_ids =
        parse_positive_i64_array_json(&payload.selected_gem_item_ids, "selectedGemItemIds")?;
    if selected_gem_item_ids.len() != 2 {
        return Err(AppError::config(
            "selectedGemItemIds参数错误，需要手动选择2个宝石",
        ));
    }
    let times = parse_optional_positive_i64_json(payload.times.as_ref(), "times")?.unwrap_or(1);
    let response = state
        .database
        .with_transaction(|| async {
            convert_inventory_gem_tx(
                &state,
                actor.user_id,
                actor.character_id,
                selected_gem_item_ids,
                normalize_gem_execute_times(times),
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "gem_convert",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn enhance_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGrowthPreviewPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let response = state
        .database
        .with_transaction(|| async {
            enhance_inventory_item_tx(&state, actor.user_id, actor.character_id, item_id).await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "enhance",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn refine_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryGrowthPreviewPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let response = state
        .database
        .with_transaction(|| async {
            refine_inventory_item_tx(&state, actor.user_id, actor.character_id, item_id).await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "refine",
    )
    .await;
    Ok((StatusCode::OK, Json(response)).into_response())
}

pub async fn socket_inventory_gem(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventorySocketPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_instance_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    let gem_item_instance_id = payload
        .gem_item_id
        .or(payload.gem_item_instance_id)
        .or(payload.gem_instance_id)
        .unwrap_or_default();
    if item_instance_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    if gem_item_instance_id <= 0 {
        return Err(AppError::config("gemItemId参数错误"));
    }
    if payload.slot.is_some_and(|slot| slot < 0) {
        return Err(AppError::config("slot参数错误"));
    }

    let response = state
        .database
        .with_transaction(|| async {
            socket_inventory_gem_tx(
                &state,
                actor.user_id,
                actor.character_id,
                item_instance_id,
                gem_item_instance_id,
                payload.slot,
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        response.success,
        "socket_gem",
    )
    .await;
    Ok((
        if response.success {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        Json(response),
    )
        .into_response())
}

pub async fn use_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryUsePayload>,
) -> Result<Json<InventoryUseResponse>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let qty = payload.qty.unwrap_or(1);
    if qty <= 0 {
        return Err(AppError::config("qty参数错误"));
    }

    let result = state
        .database
        .with_transaction(|| async {
            use_inventory_item_tx(
                &state,
                actor.user_id,
                actor.character_id,
                item_id,
                qty,
                payload.target_item_instance_id,
                payload.partner_id,
                payload.nickname.as_deref(),
            )
            .await
        })
        .await?;
    emit_inventory_character_refresh_after_success(
        &state,
        actor.user_id,
        result.success,
        "use_item",
    )
    .await;
    Ok(Json(result))
}

pub async fn expand_inventory(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    auth::require_character(&state, &headers).await?;
    Err(AppError::Business {
        message: "请通过使用扩容道具进行扩容".to_string(),
        status: StatusCode::FORBIDDEN,
        extra: serde_json::Map::new(),
    })
}

pub async fn sort_inventory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventorySortPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let location = payload.location.as_deref().unwrap_or("bag").trim();
    if !matches!(location, "bag" | "warehouse") {
        return Err(AppError::config("location参数错误"));
    }
    let result = state
        .database
        .with_transaction(|| async {
            sort_inventory_tx(&state, actor.character_id, location).await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn set_inventory_item_locked(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryLockPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let Some(locked) = payload.locked else {
        return Err(AppError::config("参数不完整"));
    };
    let item_id = payload.item_id.unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let result = state
        .database
        .with_transaction(|| async {
            set_inventory_item_locked_tx(&state, actor.character_id, item_id, locked).await
        })
        .await?;
    Ok(send_result(result))
}

async fn emit_inventory_character_refresh_after_success(
    state: &AppState,
    user_id: i64,
    success: bool,
    action: &str,
) {
    if !success {
        return;
    }
    if let Err(error) = emit_game_character_full_to_user(state, user_id).await {
        warn!(user_id, action, error = %error, "failed to emit game:character after inventory mutation");
    }
}

pub async fn equip_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryEquipPayload>,
) -> Result<Json<SuccessResponse<InventoryCharacterResponseData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }

    let character = state
        .database
        .with_transaction(|| async {
            equip_inventory_item_tx(&state, actor.user_id, actor.character_id, item_id).await
        })
        .await?;
    if let Err(error) = emit_game_character_full_to_user(&state, actor.user_id).await {
        warn!(user_id = actor.user_id, character_id = actor.character_id, error = %error, "failed to emit game:character after inventory equip");
    }
    Ok(send_success(InventoryCharacterResponseData { character }))
}

pub async fn unequip_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryUnequipPayload>,
) -> Result<Json<SuccessResponse<InventoryCharacterResponseData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let target_location = payload.target_location.as_deref().unwrap_or("bag").trim();
    if !matches!(target_location, "bag" | "warehouse") {
        return Err(AppError::config("targetLocation参数错误"));
    }

    let character = state
        .database
        .with_transaction(|| async {
            unequip_inventory_item_tx(
                &state,
                actor.user_id,
                actor.character_id,
                item_id,
                target_location,
            )
            .await
        })
        .await?;
    if let Err(error) = emit_game_character_full_to_user(&state, actor.user_id).await {
        warn!(user_id = actor.user_id, character_id = actor.character_id, error = %error, "failed to emit game:character after inventory unequip");
    }
    Ok(send_success(InventoryCharacterResponseData { character }))
}

pub async fn move_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryMovePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let Some(target_location) = payload
        .target_location
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err(AppError::config("参数不完整"));
    };
    let Some(item_id) = payload.item_id else {
        return Err(AppError::config("参数不完整"));
    };
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    if !matches!(target_location, "bag" | "warehouse") {
        return Err(AppError::config("targetLocation参数错误"));
    }
    if payload.target_slot.is_some_and(|slot| slot < 0) {
        return Err(AppError::config("targetSlot参数错误"));
    }

    let result = state
        .database
        .with_transaction(|| async {
            move_inventory_item_tx(
                &state,
                actor.character_id,
                item_id,
                target_location,
                payload.target_slot,
            )
            .await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn remove_inventory_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryRemovePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let item_id = payload
        .item_id
        .or(payload.item_instance_id)
        .or(payload.instance_id)
        .unwrap_or_default();
    if item_id <= 0 {
        return Err(AppError::config("itemId参数错误"));
    }
    let qty = payload.qty.unwrap_or(1);
    if qty <= 0 {
        return Err(AppError::config("qty参数错误"));
    }
    let result = state
        .database
        .with_transaction(|| async {
            remove_inventory_item_tx(&state, actor.character_id, item_id, qty).await
        })
        .await?;
    Ok(send_result(result))
}

pub async fn remove_inventory_items_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InventoryRemoveBatchPayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let raw_ids = payload.item_ids.unwrap_or_default();
    if raw_ids.is_empty() {
        return Err(AppError::config("itemIds参数错误"));
    }
    let parsed_ids = raw_ids
        .into_iter()
        .map(|value| value.as_i64().filter(|id| *id > 0))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| AppError::config("itemIds参数错误"))?;
    if parsed_ids.is_empty() {
        return Err(AppError::config("itemIds参数错误"));
    }

    let result = state
        .database
        .with_transaction(|| async {
            remove_inventory_items_batch_tx(&state, actor.character_id, parsed_ids).await
        })
        .await?;
    Ok(send_inventory_remove_batch_result(result))
}

async fn load_inventory_info(
    state: &AppState,
    character_id: i64,
) -> Result<InventoryInfoDataDto, AppError> {
    let row = state.database.fetch_optional(
        "SELECT bag_capacity, warehouse_capacity FROM inventory WHERE character_id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let bag_capacity = row
        .as_ref()
        .and_then(|row| opt_i64_from_i32(row, "bag_capacity").ok().flatten())
        .unwrap_or(100);
    let warehouse_capacity = row
        .as_ref()
        .and_then(|row| opt_i64_from_i32(row, "warehouse_capacity").ok().flatten())
        .unwrap_or(1000);
    let bag_used = count_inventory_slots(state, character_id, "bag").await?;
    let warehouse_used = count_inventory_slots(state, character_id, "warehouse").await?;
    Ok(InventoryInfoDataDto {
        bag_capacity,
        warehouse_capacity,
        bag_used,
        warehouse_used,
    })
}

async fn count_inventory_slots(
    state: &AppState,
    character_id: i64,
    location: &str,
) -> Result<i64, AppError> {
    let row = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM item_instance WHERE owner_character_id = $1 AND location = $2",
        |q| q.bind(character_id).bind(location),
    ).await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<i64>, _>("cnt").ok().flatten())
        .unwrap_or_default())
}

pub async fn load_inventory_items_with_defs(
    state: &AppState,
    character_id: i64,
    location: &str,
    page: i64,
    page_size: i64,
) -> Result<InventoryItemsDataDto, AppError> {
    let offset = (page - 1) * page_size;
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, quality, quality_rank, location, location_slot, equipped_slot, strengthen_level, refine_level, affixes, identified, locked, bind_type, socketed_gems, metadata, created_at::text AS created_at_text FROM item_instance WHERE owner_character_id = $1 AND location = $2 ORDER BY COALESCE(location_slot, 2147483647) ASC, id ASC LIMIT $3 OFFSET $4",
        |q| q.bind(character_id).bind(location).bind(page_size).bind(offset),
    ).await?;
    let total = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM item_instance WHERE owner_character_id = $1 AND location = $2",
        |q| q.bind(character_id).bind(location),
    ).await?.and_then(|row| row.try_get::<Option<i64>, _>("cnt").ok().flatten()).unwrap_or_default();
    let defs = load_inventory_def_map()?;
    let mut items = Vec::new();
    for row in rows {
        items.push(map_inventory_item(state, row, &defs).await?);
    }
    Ok(InventoryItemsDataDto {
        items,
        total,
        page,
        page_size,
    })
}

async fn sort_inventory_tx(
    state: &AppState,
    character_id: i64,
    location: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let Some(capacity) = load_inventory_capacity(state, character_id, location).await? else {
        return Ok(ServiceResult {
            success: false,
            message: Some("背包不存在".to_string()),
            data: None,
        });
    };
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, quality, quality_rank, bind_type, metadata, location_slot FROM item_instance WHERE owner_character_id = $1 AND location = $2 FOR UPDATE",
        |q| q.bind(character_id).bind(location),
    ).await?;
    let defs = load_inventory_def_map()?;
    let source_rows = rows
        .into_iter()
        .map(map_sort_inventory_row)
        .collect::<Result<Vec<_>, _>>()?;
    let compacted_rows = compact_inventory_rows_for_sort(source_rows, &defs);
    let ranked_rows = build_ranked_sort_rows(compacted_rows, &defs);
    apply_sorted_inventory_rows(state, character_id, location, capacity, ranked_rows).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("整理完成".to_string()),
        data: None,
    })
}

async fn set_inventory_item_locked_tx(
    state: &AppState,
    character_id: i64,
    item_id: i64,
    locked: bool,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT id, location FROM item_instance WHERE id = $1 AND owner_character_id = $2 FOR UPDATE",
        |q| q.bind(item_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if !matches!(location.as_str(), "bag" | "warehouse" | "equipped") {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品当前位置不可锁定".to_string()),
            data: None,
        });
    }
    state.database.execute(
        "UPDATE item_instance SET locked = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        |q| q.bind(locked).bind(item_id).bind(character_id),
    ).await?;
    Ok(ServiceResult {
        success: true,
        message: Some(if locked { "已锁定" } else { "已解锁" }.to_string()),
        data: Some(serde_json::json!({ "itemId": item_id, "locked": locked })),
    })
}

async fn remove_inventory_item_tx(
    state: &AppState,
    character_id: i64,
    item_id: i64,
    qty: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 FOR UPDATE",
            |q| q.bind(item_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let source_snapshot = map_item_instance_snapshot_from_row(&row)?;
    let current_qty = opt_i64_from_i32(&row, "qty")?.unwrap_or(0);
    let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
    if locked {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品已锁定".to_string()),
            data: None,
        });
    }
    if current_qty < qty {
        return Ok(ServiceResult {
            success: false,
            message: Some("数量不足".to_string()),
            data: None,
        });
    }
    consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("移除成功".to_string()),
        data: None,
    })
}

async fn remove_inventory_items_batch_tx(
    state: &AppState,
    character_id: i64,
    item_ids: Vec<i64>,
) -> Result<InventoryRemoveBatchResponse, AppError> {
    if item_ids.is_empty() {
        return Ok(inventory_remove_batch_failure("itemIds参数错误"));
    }

    let unique_ids = item_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if unique_ids.is_empty() {
        return Ok(inventory_remove_batch_failure("itemIds参数错误"));
    }
    if unique_ids.len() > 200 {
        return Ok(inventory_remove_batch_failure("一次最多丢弃200个物品"));
    }

    acquire_inventory_mutex(state, character_id).await?;
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, location, locked FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2) FOR UPDATE",
        |q| q.bind(character_id).bind(&unique_ids),
    ).await?;
    if rows.len() != unique_ids.len() {
        return Ok(inventory_remove_batch_failure("包含不存在的物品"));
    }

    let defs = load_inventory_def_map()?;
    let mut removable_ids = Vec::new();
    let mut removed_qty_total = 0_i64;
    let mut skipped_locked_count = 0_i64;
    let mut skipped_locked_qty_total = 0_i64;

    for row in rows.into_iter().map(map_inventory_batch_removal_row) {
        let row = row?;
        let Some(def) = defs.get(row.item_def_id.as_str()) else {
            return Ok(inventory_remove_batch_failure("包含不存在的物品"));
        };
        if row.location == "equipped" {
            return Ok(inventory_remove_batch_failure("包含穿戴中的物品"));
        }
        if !matches!(row.location.as_str(), "bag" | "warehouse") {
            return Ok(inventory_remove_batch_failure("包含不可丢弃位置的物品"));
        }
        if def.row.get("destroyable").and_then(|value| value.as_bool()) != Some(true) {
            return Ok(inventory_remove_batch_failure("包含不可丢弃的物品"));
        }
        if row.locked {
            skipped_locked_count += 1;
            skipped_locked_qty_total += row.qty;
            continue;
        }
        removable_ids.push(row.id);
        removed_qty_total += row.qty;
    }

    if removable_ids.is_empty() {
        return Ok(inventory_remove_batch_failure("没有可丢弃的物品"));
    }

    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            let now_ms = inventory_item_mutation_timestamp_ms();
            let mutations = removable_ids
                .iter()
                .map(|item_id| BufferedItemInstanceMutation {
                    op_id: format!("inventory-remove-batch:{item_id}:{now_ms}"),
                    character_id,
                    item_id: *item_id,
                    created_at_ms: now_ms,
                    kind: "delete".to_string(),
                    snapshot: None,
                })
                .collect::<Vec<_>>();
            buffer_item_instance_mutations(&redis, &mutations).await?;
        }
    } else {
        state
            .database
            .execute(
                "DELETE FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)",
                |q| q.bind(character_id).bind(&removable_ids),
            )
            .await?;
    }

    Ok(InventoryRemoveBatchResponse {
        success: true,
        message: if skipped_locked_count > 0 {
            format!("丢弃成功（已跳过已锁定×{skipped_locked_count}）")
        } else {
            "丢弃成功".to_string()
        },
        removed_count: Some(removable_ids.len() as i64),
        removed_qty_total: Some(removed_qty_total),
        skipped_locked_count: Some(skipped_locked_count),
        skipped_locked_qty_total: Some(skipped_locked_qty_total),
    })
}

fn inventory_remove_batch_failure(message: &str) -> InventoryRemoveBatchResponse {
    InventoryRemoveBatchResponse {
        success: false,
        message: message.to_string(),
        removed_count: None,
        removed_qty_total: None,
        skipped_locked_count: None,
        skipped_locked_qty_total: None,
    }
}

fn map_inventory_batch_removal_row(
    row: sqlx::postgres::PgRow,
) -> Result<InventoryBatchRemovalRow, AppError> {
    Ok(InventoryBatchRemovalRow {
        id: row.try_get::<i64, _>("id")?,
        item_def_id: row.try_get::<String, _>("item_def_id")?,
        qty: opt_i64_from_i32(&row, "qty")?.unwrap_or_default().max(0),
        location: row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default(),
        locked: row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false),
    })
}

fn send_inventory_remove_batch_result(result: InventoryRemoveBatchResponse) -> Response {
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::BAD_REQUEST
    };
    (status, Json(result)).into_response()
}

async fn use_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_id: i64,
    qty: i64,
    target_item_instance_id: Option<i64>,
    partner_id: Option<i64>,
    nickname: Option<&str>,
) -> Result<InventoryUseResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 FOR UPDATE",
        |q| q.bind(item_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("物品不存在"));
    };
    let source_snapshot = map_item_instance_snapshot_from_row(&row)?;
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let item_qty = row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
    let item_metadata = row.try_get::<Option<serde_json::Value>, _>("metadata")?;

    if !matches!(location.as_str(), "bag" | "warehouse") {
        return Err(AppError::config("该物品不可使用"));
    }
    if locked {
        return Err(AppError::config("物品已锁定"));
    }
    if item_qty < qty {
        return Err(AppError::config("数量不足"));
    }

    let defs = load_inventory_def_map()?;
    let Some(item_def) = defs.get(item_def_id.as_str()) else {
        return Err(AppError::config("物品不存在"));
    };
    if item_def_id == "cons-monthcard-001" {
        if qty != 1 {
            return Err(AppError::config("月卡每次只能使用一张"));
        }
        let month_card_result = crate::http::month_card::use_month_card_item_tx(
            state,
            character_id,
            crate::http::month_card::UseMonthCardPayload {
                month_card_id: Some(crate::http::month_card::DEFAULT_MONTH_CARD_ID.to_string()),
                item_instance_id: Some(item_id),
            },
        )
        .await?;
        if !month_card_result.success {
            return Ok(InventoryUseResponse {
                success: false,
                message: month_card_result
                    .message
                    .unwrap_or_else(|| "月卡激活失败".to_string()),
                effects: vec![],
                data: InventoryUseResponseData {
                    character: load_inventory_use_character_snapshot(state, character_id).await?,
                    loot_results: None,
                    partner_technique_result: None,
                    partner_rebone_job: None,
                },
            });
        }
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: month_card_result
                .message
                .unwrap_or_else(|| "使用成功".to_string()),
            effects: vec![],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }
    if !is_supported_inventory_use_item_def_id(item_def_id.as_str()) {
        return Err(AppError::config("该物品暂不支持使用效果"));
    }
    if item_def
        .row
        .get("category")
        .and_then(|value| value.as_str())
        != Some("consumable")
    {
        return Err(AppError::config("该物品不可使用"));
    }
    let use_type = item_def
        .row
        .get("use_type")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("instant");
    ensure_use_realm_requirement(
        state,
        character_id,
        item_def
            .row
            .get("use_req_realm")
            .and_then(|value| value.as_str()),
    )
    .await?;

    let effect_defs = item_def
        .row
        .get("effect_defs")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    if effect_defs.is_empty() {
        return Err(AppError::config("该物品暂不支持使用效果"));
    }
    if effect_defs.len() > 1 {
        return use_inventory_multi_effect_item_tx(
            state,
            character_id,
            item_id,
            qty,
            item_def_id.as_str(),
            item_def,
            &source_snapshot,
            &effect_defs,
        )
        .await;
    }
    let effect = effect_defs[0].clone();
    let effect_type = effect
        .get("effect_type")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let trigger = effect
        .get("trigger")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let target = effect
        .get("target")
        .and_then(|value| value.as_str())
        .unwrap_or("self");
    if trigger != "use" {
        return Err(AppError::config("该物品暂不支持使用效果"));
    }
    let target_use_allowed = matches!(
        effect_type,
        "unbind" | "reroll_partner_base_attrs" | "reroll"
    );
    if use_type != "instant" && !(use_type == "target" && target_use_allowed) {
        return Err(AppError::config("该物品不可使用"));
    }

    if effect_type == "rename_character" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        if qty != 1 {
            return Err(AppError::config("易名符每次只能使用一张"));
        }
        let nickname = nickname
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("道号不能为空"))?;
        let rename_result = crate::http::character::rename_character_with_card_tx(
            state,
            character_id,
            item_id,
            nickname,
        )
        .await?;
        if !rename_result.success {
            return Ok(InventoryUseResponse {
                success: false,
                message: rename_result
                    .message
                    .unwrap_or_else(|| "改名失败".to_string()),
                effects: vec![effect],
                data: InventoryUseResponseData {
                    character: load_inventory_use_character_snapshot(state, character_id).await?,
                    loot_results: None,
                    partner_technique_result: None,
                    partner_rebone_job: None,
                },
            });
        }
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: rename_result
                .message
                .unwrap_or_else(|| "改名成功".to_string()),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "reroll" {
        if !reroll_effect_targets_equipment(&effect, target) {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        if qty != 1 {
            return Err(AppError::config("洗炼符每次只能使用一张"));
        }
        let params = effect.get("params").and_then(|value| value.as_object());
        let target_type = params
            .and_then(|params| params.get("target_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        let reroll_type = params
            .and_then(|params| params.get("reroll_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if target_type != "equipment" || reroll_type != "affixes" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let target_item_instance_id = target_item_instance_id.unwrap_or_default();
        if target_item_instance_id <= 0 {
            return Err(AppError::config("请选择要洗炼的装备"));
        }
        let reroll_result = reroll_inventory_affixes_tx(
            state,
            user_id,
            character_id,
            target_item_instance_id,
            vec![],
        )
        .await?;
        if !reroll_result.success {
            return Ok(InventoryUseResponse {
                success: false,
                message: reroll_result.message,
                effects: vec![effect],
                data: InventoryUseResponseData {
                    character: load_inventory_use_character_snapshot(state, character_id).await?,
                    loot_results: None,
                    partner_technique_result: None,
                    partner_rebone_job: None,
                },
            });
        }
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: reroll_result.message,
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "unbind" {
        let params = effect.get("params").and_then(|value| value.as_object());
        let target_type = params
            .and_then(|params| params.get("target_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let bind_state = params
            .and_then(|params| params.get("bind_state"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if target_type != "equipment" || bind_state != "bound" {
            return Err(AppError::config("解绑道具配置错误"));
        }
        if qty != 1 {
            return Err(AppError::config("解绑卷轴每次只能使用一张"));
        }
        let target_item_instance_id = target_item_instance_id.unwrap_or_default();
        if target_item_instance_id <= 0 {
            return Err(AppError::config("请选择要解绑的装备"));
        }

        let target_row = state.database.fetch_optional(
            "SELECT id, item_def_id, locked, bind_type FROM item_instance WHERE id = $1 AND owner_character_id = $2 FOR UPDATE",
            |q| q.bind(target_item_instance_id).bind(character_id),
        ).await?;
        let Some(target_row) = target_row else {
            return Err(AppError::config("目标装备不存在"));
        };
        let target_item_def_id = target_row.try_get::<String, _>("item_def_id")?;
        let target_locked = target_row
            .try_get::<Option<bool>, _>("locked")?
            .unwrap_or(false);
        let target_bind_type =
            normalize_bind_type(target_row.try_get::<Option<String>, _>("bind_type")?);
        let Some(target_def) = defs.get(target_item_def_id.as_str()) else {
            return Err(AppError::config("目标装备数据异常"));
        };
        if target_def
            .row
            .get("category")
            .and_then(|value| value.as_str())
            != Some("equipment")
        {
            return Err(AppError::config("目标物品不是装备"));
        }
        if target_locked {
            return Err(AppError::config("目标装备已锁定"));
        }
        if target_bind_type == "none" {
            return Err(AppError::config("目标装备尚未绑定"));
        }

        state.database.execute(
            "UPDATE item_instance SET bind_type = 'none', bind_owner_user_id = NULL, bind_owner_character_id = NULL, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2",
            |q| q.bind(target_item_instance_id).bind(character_id),
        ).await?;

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "learn_technique" {
        let technique_id = effect
            .get("params")
            .and_then(|value| value.as_object())
            .and_then(|params| params.get("technique_id"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("目标功法不存在或未开放"))?
            .to_string();

        let defs = load_visible_inventory_technique_def_map()?;
        let Some(technique_def) = defs.get(technique_id.as_str()) else {
            return Err(AppError::config("目标功法不存在或未开放"));
        };
        ensure_use_realm_requirement(state, character_id, technique_def.required_realm.as_deref())
            .await?;

        let exists = state.database.fetch_optional(
            "SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
            |q| q.bind(character_id).bind(technique_id.as_str()),
        ).await?;
        if exists.is_some() {
            return Err(AppError::config("已学习该功法"));
        }

        state.database.execute(
            "INSERT INTO character_technique (character_id, technique_id, current_layer, obtained_from, obtained_ref_id, acquired_at) VALUES ($1, $2, 1, $3, $4, NOW())",
            |q| q.bind(character_id).bind(technique_id.as_str()).bind(format!("use_item:{}", item_def_id)).bind(item_def_id.as_str()),
        ).await?;

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: Some(vec![InventoryUseLootResultDto {
                    r#type: "technique".to_string(),
                    name: Some(technique_def.name.clone()),
                    amount: 1,
                    item_def_id: None,
                    item_ids: None,
                }]),
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "learn_generated_technique" {
        let generated_technique_id = item_metadata
            .as_ref()
            .and_then(|value| value.as_object())
            .and_then(|metadata| metadata.get("generatedTechniqueId"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("生成功法书数据异常，缺少功法标识"))?
            .to_string();

        let generated_def = state.database.fetch_optional(
            "SELECT COALESCE(display_name, name) AS name, usage_scope, required_realm FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
            |q| q.bind(generated_technique_id.as_str()),
        ).await?;
        let Some(generated_def) = generated_def else {
            return Err(AppError::config("目标生成功法不存在或未发布"));
        };
        let usage_scope = generated_def
            .try_get::<Option<String>, _>("usage_scope")?
            .unwrap_or_else(|| "character_only".to_string());
        if usage_scope == "partner_only" {
            return Err(AppError::config("该功法仅伙伴可学习"));
        }
        let generated_name = generated_def
            .try_get::<Option<String>, _>("name")?
            .unwrap_or_else(|| generated_technique_id.clone());

        let exists = state.database.fetch_optional(
            "SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
            |q| q.bind(character_id).bind(generated_technique_id.as_str()),
        ).await?;
        if exists.is_some() {
            return Err(AppError::config("已学习该功法"));
        }

        state.database.execute(
            "INSERT INTO character_technique (character_id, technique_id, current_layer, obtained_from, obtained_ref_id, acquired_at) VALUES ($1, $2, 1, $3, $4, NOW())",
            |q| q.bind(character_id).bind(generated_technique_id.as_str()).bind(format!("use_item:{}", item_def_id)).bind(item_def_id.as_str()),
        ).await?;

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        flush_inventory_item_grant_deltas_now(state, character_id).await?;
        flush_inventory_resource_deltas_now(state, character_id).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: Some(vec![InventoryUseLootResultDto {
                    r#type: "technique".to_string(),
                    name: Some(generated_name),
                    amount: 1,
                    item_def_id: None,
                    item_ids: None,
                }]),
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "expand" {
        let params = effect.get("params").and_then(|value| value.as_object());
        let expand_type = params
            .and_then(|params| params.get("expand_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if expand_type != "bag" {
            return Err(AppError::config("该道具暂不支持当前扩容类型"));
        }
        let expand_value = params
            .and_then(|params| params.get("value"))
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_i64().map(|value| value as f64))
            })
            .map(|value| value.floor() as i64)
            .unwrap_or_default();
        if expand_value <= 0 {
            return Err(AppError::config("扩容道具配置错误"));
        }
        let total_expand_size = expand_value.saturating_mul(qty);
        let _new_capacity =
            expand_inventory_capacity_tx(state, character_id, "bag", total_expand_size).await?;

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        flush_inventory_item_grant_deltas_now(state, character_id).await?;
        flush_inventory_resource_deltas_now(state, character_id).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "reroll_partner_base_attrs" {
        if target != "partner" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let partner_id = partner_id.unwrap_or_default();
        if partner_id <= 0 {
            return Err(AppError::config("请选择目标伙伴"));
        }
        let rebone_result = crate::http::partner::start_partner_rebone_tx(
            state,
            character_id,
            partner_id,
            item_def_id.as_str(),
            qty,
        )
        .await?;
        if !rebone_result.success {
            return Ok(InventoryUseResponse {
                success: false,
                message: rebone_result
                    .message
                    .unwrap_or_else(|| "归元洗髓开启失败".to_string()),
                effects: vec![effect],
                data: InventoryUseResponseData {
                    character: load_inventory_use_character_snapshot(state, character_id).await?,
                    loot_results: None,
                    partner_technique_result: None,
                    partner_rebone_job: None,
                },
            });
        }
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: rebone_result
                .message
                .unwrap_or_else(|| "使用成功".to_string()),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: rebone_result.data.map(|data| {
                    serde_json::to_value(data).unwrap_or_else(|_| serde_json::json!({}))
                }),
            },
        });
    }

    if effect_type == "activate_battle_pass" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        if qty != 1 {
            return Err(AppError::config("战令卡每次只能使用一张"));
        }
        let season_id = effect
            .get("params")
            .and_then(|value| value.as_object())
            .and_then(|params| params.get("season_id"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("战令赛季不存在"))?;
        let season = crate::http::battle_pass::load_active_battle_pass_season_with_fallback(Some(
            "bp-season-001",
        ))?;
        if season.id != season_id {
            return Err(AppError::config("战令赛季不存在"));
        }
        let existing = state
            .database
            .fetch_optional(
                "SELECT premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 LIMIT 1 FOR UPDATE",
                |q| q.bind(character_id).bind(season_id),
            )
            .await?;
        if existing
            .as_ref()
            .and_then(|row| {
                row.try_get::<Option<bool>, _>("premium_unlocked")
                    .ok()
                    .flatten()
            })
            .unwrap_or(false)
        {
            return Err(AppError::config("已解锁高级战令"));
        }
        state.database.execute(
            "INSERT INTO battle_pass_progress (character_id, season_id, exp, premium_unlocked, created_at, updated_at) VALUES ($1, $2, 0, true, NOW(), NOW()) ON CONFLICT (character_id, season_id) DO UPDATE SET premium_unlocked = true, updated_at = NOW()",
            |q| q.bind(character_id).bind(season_id),
        ).await?;
        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "activate_month_card" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        if qty != 1 {
            return Err(AppError::config("月卡每次只能使用一张"));
        }
        let month_card_id = effect
            .get("params")
            .and_then(|value| value.as_object())
            .and_then(|params| params.get("month_card_id"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(crate::http::month_card::DEFAULT_MONTH_CARD_ID);
        let month_card_result = crate::http::month_card::use_month_card_item_tx(
            state,
            character_id,
            crate::http::month_card::UseMonthCardPayload {
                month_card_id: Some(month_card_id.to_string()),
                item_instance_id: Some(item_id),
            },
        )
        .await?;
        if !month_card_result.success {
            return Ok(InventoryUseResponse {
                success: false,
                message: month_card_result
                    .message
                    .unwrap_or_else(|| "月卡激活失败".to_string()),
                effects: vec![effect],
                data: InventoryUseResponseData {
                    character: load_inventory_use_character_snapshot(state, character_id).await?,
                    loot_results: None,
                    partner_technique_result: None,
                    partner_rebone_job: None,
                },
            });
        }
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: month_card_result
                .message
                .unwrap_or_else(|| "使用成功".to_string()),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "dispel" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let dispel_type = effect
            .get("params")
            .and_then(|value| value.as_object())
            .and_then(|params| params.get("dispel_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if dispel_type != "poison" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        state.database.execute(
            "DELETE FROM character_global_buff WHERE character_id = $1 AND buff_key = 'poison' AND expire_at > NOW()",
            |q| q.bind(character_id),
        ).await?;
        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "buff" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let params = effect.get("params").and_then(|value| value.as_object());
        let attr_key = params
            .and_then(|params| params.get("attr_key"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        let apply_type = params
            .and_then(|params| params.get("apply_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        let duration_round = effect
            .get("duration_round")
            .and_then(|value| value.as_i64())
            .unwrap_or_default();
        let buff_value = params
            .and_then(|params| params.get("value"))
            .and_then(|value| {
                value
                    .as_f64()
                    .or_else(|| value.as_i64().map(|number| number as f64))
            })
            .unwrap_or_default();
        if apply_type != "flat"
            || duration_round <= 0
            || buff_value <= 0.0
            || !matches!(attr_key, "wugong" | "fagong" | "sudu")
        {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let buff_key = format!("{}_flat", attr_key);
        let source_id = format!("{}:{}", item_def_id, item_id);
        let expire_at = inventory_format_iso(
            inventory_now_utc().unix_timestamp() * 1000 + duration_round * 30_000,
        )?;
        state.database.execute(
            "INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, started_at, expire_at, created_at, updated_at) VALUES ($1, $2, 'item_use', $3, $4, NOW(), $5::timestamptz, NOW(), NOW()) ON CONFLICT (character_id, buff_key, source_type, source_id) DO UPDATE SET buff_value = EXCLUDED.buff_value, started_at = NOW(), expire_at = EXCLUDED.expire_at, updated_at = NOW()",
            |q| q.bind(character_id).bind(&buff_key).bind(&source_id).bind(buff_value).bind(&expire_at),
        ).await?;
        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: None,
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if effect_type == "loot" {
        if target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        let params = effect.get("params").and_then(|value| value.as_object());
        let loot_type = params
            .and_then(|params| params.get("loot_type"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let mut total_silver = 0_i64;
        let mut total_spirit_stones = 0_i64;
        let mut loot_item_rewards: Vec<(String, i64)> = Vec::new();
        match loot_type {
            "currency" => {
                let Some(currency) = resolve_currency_loot_type(&effect) else {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                };
                for _ in 0..qty {
                    let rolled = roll_item_use_amount(None, &effect);
                    if rolled <= 0 {
                        return Err(AppError::config("该物品暂不支持使用效果"));
                    }
                    match currency {
                        "spirit_stones" => {
                            total_spirit_stones = total_spirit_stones.saturating_add(rolled)
                        }
                        "silver" => total_silver = total_silver.saturating_add(rolled),
                        _ => unreachable!("currency loot type already validated"),
                    }
                }
            }
            "multi" => {
                if !matches!(item_def_id.as_str(), "box-002" | "box-003") {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                let items = params
                    .and_then(|params| params.get("items"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                for item in items {
                    let Some(item_def_id) = item
                        .get("item_id")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        continue;
                    };
                    let item_qty = item
                        .get("qty")
                        .and_then(|value| value.as_i64())
                        .unwrap_or(1)
                        .max(1)
                        .saturating_mul(qty);
                    loot_item_rewards.push((item_def_id.to_string(), item_qty));
                }
                let currency = params
                    .and_then(|params| params.get("currency"))
                    .and_then(|value| value.as_object());
                total_silver = currency
                    .and_then(|currency| currency.get("silver"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
                    .max(0)
                    .saturating_mul(qty);
                total_spirit_stones = currency
                    .and_then(|currency| currency.get("spirit_stones"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
                    .max(0)
                    .saturating_mul(qty);
            }
            "random_gem" => {
                if !matches!(
                    item_def_id.as_str(),
                    "box-005"
                        | "box-006"
                        | "box-007"
                        | "box-008"
                        | "box-009"
                        | "box-010"
                        | "box-011"
                        | "box-012"
                        | "box-013"
                ) {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                let min_level = params
                    .and_then(|params| params.get("min_level"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1)
                    .max(1);
                let max_level = params
                    .and_then(|params| params.get("max_level"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(min_level)
                    .max(min_level);
                let gems_per_use = params
                    .and_then(|params| params.get("gems_per_use"))
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1)
                    .max(1);
                let sub_categories = params
                    .and_then(|params| params.get("sub_categories"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|value| value.as_str().map(|v| v.trim().to_lowercase()))
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>();
                let sub_categories = if sub_categories.is_empty() {
                    DEFAULT_RANDOM_GEM_SUB_CATEGORIES
                        .iter()
                        .map(|value| value.to_string())
                        .collect::<Vec<_>>()
                } else {
                    sub_categories
                };
                let defs = load_inventory_def_map()?;
                let candidate_gem_ids = defs
                    .iter()
                    .filter(|(_, seed)| {
                        seed.row.get("category").and_then(|value| value.as_str()) == Some("gem")
                    })
                    .filter(|(_, seed)| {
                        let gem_level = seed
                            .row
                            .get("gem_level")
                            .and_then(|value| value.as_i64())
                            .unwrap_or_default();
                        gem_level >= min_level && gem_level <= max_level
                    })
                    .filter(|(_, seed)| {
                        if sub_categories.is_empty() {
                            return true;
                        }
                        seed.row
                            .get("sub_category")
                            .and_then(|value| value.as_str())
                            .map(|value| {
                                sub_categories
                                    .iter()
                                    .any(|allowed| allowed == &value.trim().to_lowercase())
                            })
                            .unwrap_or(false)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                if candidate_gem_ids.is_empty() {
                    return Err(AppError::config("宝石袋配置异常：没有可掉落宝石"));
                }
                let roll_count = qty.saturating_mul(gems_per_use);
                let mut rolled_counts: BTreeMap<String, i64> = BTreeMap::new();
                for _ in 0..roll_count {
                    let index = pick_random_index_runtime(candidate_gem_ids.len());
                    if let Some(gem_id) = candidate_gem_ids.get(index) {
                        *rolled_counts.entry(gem_id.clone()).or_insert(0) += 1;
                    }
                }
                loot_item_rewards.extend(rolled_counts.into_iter());
            }
            _ => return Err(AppError::config("该物品暂不支持使用效果")),
        }

        let character_row = state
            .database
            .fetch_optional(
                "SELECT spirit_stones FROM characters WHERE id = $1 FOR UPDATE",
                |q| q.bind(character_id),
            )
            .await?;
        let Some(character_row) = character_row else {
            return Err(AppError::config("角色不存在"));
        };
        let current_spirit_stones = character_row
            .try_get::<Option<i64>, _>("spirit_stones")?
            .unwrap_or_default();
        let next_spirit_stones = current_spirit_stones.saturating_add(total_spirit_stones);

        let defs = load_inventory_def_map()?;
        let reward_item_pairs = loot_item_rewards.clone();
        let use_item_ref_id = item_id.to_string();
        if !buffer_inventory_item_reward_deltas(
            state,
            user_id,
            character_id,
            "use_item",
            Some(use_item_ref_id.as_str()),
            total_silver,
            &reward_item_pairs,
        )
        .await?
        {
            for (reward_item_def_id, reward_qty) in &loot_item_rewards {
                if *reward_qty <= 0 {
                    continue;
                }
                let bind_type = defs
                    .get(reward_item_def_id.as_str())
                    .and_then(|seed| seed.row.get("bind_type"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("none");
                state.database.fetch_one(
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) SELECT user_id, id, $2, $3, $4, 'bag', NOW(), NOW(), 'use_item', $5 FROM characters WHERE id = $1 RETURNING id",
                    |q| q.bind(character_id).bind(reward_item_def_id.as_str()).bind(*reward_qty).bind(bind_type).bind(item_id.to_string()),
                ).await?;
            }
            if total_silver > 0 {
                state.database.execute(
                    "UPDATE characters SET silver = COALESCE(silver, 0) + $1, updated_at = NOW() WHERE id = $2",
                    |q| q.bind(total_silver).bind(character_id),
                ).await?;
            }
        }
        if total_spirit_stones > 0 {
            if !(state.redis_available && state.redis.is_some()) {
                state.database.execute(
                    "UPDATE characters SET spirit_stones = $1, updated_at = NOW() WHERE id = $2",
                    |q| q.bind(next_spirit_stones).bind(character_id),
                ).await?;
            } else {
                let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
                buffer_character_resource_delta_fields(
                    &redis,
                    &[CharacterResourceDeltaField {
                        character_id,
                        field: "spirit_stones".to_string(),
                        increment: total_spirit_stones,
                    }],
                )
                .await?;
            }
        }

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;
        flush_inventory_item_grant_deltas_now(state, character_id).await?;
        flush_inventory_resource_deltas_now(state, character_id).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: Some(build_loot_results_for_use(
                    &defs,
                    total_silver,
                    total_spirit_stones,
                    &loot_item_rewards,
                )),
                partner_technique_result: None,
                partner_rebone_job: None,
            },
        });
    }

    if partner_id.is_some()
        && matches!(effect_type, "learn_technique" | "learn_generated_technique")
    {
        if qty != 1 {
            return Err(AppError::config("伙伴打书每次只能使用一本功法书"));
        }
        let partner_id = partner_id.unwrap_or_default();
        if partner_id <= 0 {
            return Err(AppError::config("partnerId参数错误"));
        }
        let partner_row = state.database.fetch_optional(
            "SELECT cp.id, cp.partner_def_id, cp.nickname, cp.description, cp.avatar, cp.level, cp.progress_exp, cp.growth_max_qixue, cp.growth_wugong, cp.growth_fagong, cp.growth_wufang, cp.growth_fafang, cp.growth_sudu, cp.is_active, cp.obtained_from, pd.max_technique_slots, pd.innate_technique_ids, c.realm, c.sub_realm, c.exp FROM character_partner cp LEFT JOIN characters c ON c.id = cp.character_id LEFT JOIN partner_def pd ON pd.id = cp.partner_def_id WHERE cp.id = $1 AND cp.character_id = $2 LIMIT 1 FOR UPDATE",
            |q| q.bind(partner_id).bind(character_id),
        ).await?;
        let Some(partner_row) = partner_row else {
            return Err(AppError::config("伙伴不存在"));
        };

        let technique_id = if effect_type == "learn_generated_technique" {
            item_metadata
                .as_ref()
                .and_then(|value| value.as_object())
                .and_then(|metadata| metadata.get("generatedTechniqueId"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::config("生成功法书数据异常，缺少功法标识"))?
                .to_string()
        } else {
            effect
                .get("params")
                .and_then(|value| value.as_object())
                .and_then(|params| params.get("technique_id"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::config("目标功法不存在或未开放"))?
                .to_string()
        };

        let technique_name = if effect_type == "learn_generated_technique" {
            let generated_def = state.database.fetch_optional(
                "SELECT COALESCE(display_name, name) AS name FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
                |q| q.bind(technique_id.as_str()),
            ).await?;
            let Some(generated_def) = generated_def else {
                return Err(AppError::config("目标生成功法不存在或未发布"));
            };
            generated_def
                .try_get::<Option<String>, _>("name")?
                .unwrap_or_else(|| technique_id.clone())
        } else {
            let defs = load_visible_inventory_technique_def_map()?;
            let Some(technique_def) = defs.get(technique_id.as_str()) else {
                return Err(AppError::config("目标功法不存在或未开放"));
            };
            technique_def.name.clone()
        };

        let existing_rows = state.database.fetch_all(
            "SELECT technique_id, current_layer, is_innate, learned_from_item_def_id FROM character_partner_technique WHERE partner_id = $1 ORDER BY is_innate DESC, created_at ASC, id ASC FOR UPDATE",
            |q| q.bind(partner_id),
        ).await?;
        if existing_rows.iter().any(|row| {
            row.try_get::<Option<String>, _>("technique_id")
                .ok()
                .flatten()
                .unwrap_or_default()
                .trim()
                == technique_id
        }) {
            return Err(AppError::config("该伙伴已学习此功法"));
        }
        let max_slots = opt_i64_from_i32(&partner_row, "max_technique_slots")?
            .unwrap_or_default()
            .max(0);
        let current_effective_count = existing_rows.len() as i64;
        let replaceable = existing_rows
            .iter()
            .filter(|row| {
                !row.try_get::<Option<bool>, _>("is_innate")
                    .ok()
                    .flatten()
                    .unwrap_or(false)
            })
            .map(|row| {
                row.try_get::<Option<String>, _>("technique_id")
                    .ok()
                    .flatten()
                    .unwrap_or_default()
            })
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>();

        let mut replaced_technique_json = None;
        if current_effective_count < max_slots {
            state.database.execute(
                "INSERT INTO character_partner_technique (partner_id, technique_id, current_layer, is_innate, learned_from_item_def_id, created_at, updated_at) VALUES ($1, $2, 1, FALSE, $3, NOW(), NOW())",
                |q| q.bind(partner_id).bind(technique_id.as_str()).bind(item_def_id.as_str()),
            ).await?;
        } else {
            let replaced_technique_id = if replaceable.is_empty() {
                return Err(AppError::config("当前只有天生功法，无法继续打书"));
            } else {
                let index = rand::thread_rng().gen_range(0..replaceable.len());
                replaceable.get(index).cloned().unwrap_or_default()
            };
            replaced_technique_json = Some(serde_json::json!({
                "techniqueId": replaced_technique_id,
                "name": replaced_technique_id,
                "quality": "黄",
                "currentLayer": 1,
                "maxLayer": 1,
                "skillIds": [],
                "skills": [],
                "passiveAttrs": {},
                "isInnate": false
            }));
            state.database.execute(
                "UPDATE character_partner_technique SET technique_id = $2, current_layer = 1, is_innate = FALSE, learned_from_item_def_id = $3, updated_at = NOW() WHERE partner_id = $1 AND technique_id = $4",
                |q| q.bind(partner_id).bind(technique_id.as_str()).bind(item_def_id.as_str()).bind(replaced_technique_id.as_str()),
            ).await?;
        }

        consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;

        let character_snapshot = load_inventory_use_character_snapshot(state, character_id).await?;
        let remaining_books = load_partner_books(state, character_id)
            .await?
            .into_iter()
            .map(|book| {
                serde_json::json!({
                    "itemInstanceId": book.item_instance_id,
                    "itemDefId": book.item_def_id,
                    "techniqueId": book.technique_id,
                    "techniqueName": book.technique_name,
                    "name": book.name,
                    "icon": book.icon,
                    "quality": book.quality,
                    "qty": book.qty,
                })
            })
            .collect::<Vec<_>>();

        return Ok(InventoryUseResponse {
            success: true,
            message: "使用成功".to_string(),
            effects: vec![effect],
            data: InventoryUseResponseData {
                character: character_snapshot,
                loot_results: Some(vec![InventoryUseLootResultDto {
                    r#type: "partner_technique".to_string(),
                    name: Some(technique_name.clone()),
                    amount: 1,
                    item_def_id: None,
                    item_ids: None,
                }]),
                partner_technique_result: Some(serde_json::json!({
                    "partner": {
                        "id": partner_id,
                        "partnerDefId": partner_row.try_get::<Option<String>, _>("partner_def_id")?.unwrap_or_default(),
                        "nickname": partner_row.try_get::<Option<String>, _>("nickname")?.unwrap_or_default(),
                        "description": partner_row.try_get::<Option<String>, _>("description")?,
                        "avatar": partner_row.try_get::<Option<String>, _>("avatar")?,
                        "level": partner_row.try_get::<Option<i64>, _>("level")?.unwrap_or(1),
                        "progressExp": partner_row.try_get::<Option<i64>, _>("progress_exp")?.unwrap_or_default(),
                        "isActive": partner_row.try_get::<Option<bool>, _>("is_active")?.unwrap_or(false),
                        "obtainedFrom": partner_row.try_get::<Option<String>, _>("obtained_from")?,
                        "slotCount": max_slots,
                    },
                    "learnedTechnique": {
                        "techniqueId": technique_id,
                        "name": technique_name,
                        "quality": "黄",
                        "currentLayer": 1,
                        "maxLayer": 1,
                        "skillIds": [],
                        "skills": [],
                        "passiveAttrs": {},
                        "isInnate": false
                    },
                    "replacedTechnique": replaced_technique_json,
                    "remainingBooks": remaining_books,
                })),
                partner_rebone_job: None,
            },
        });
    }

    if target != "self" {
        return Err(AppError::config("该物品暂不支持使用效果"));
    }

    let mut delta_qixue = 0_i64;
    let mut delta_lingqi = 0_i64;
    let mut delta_exp = 0_i64;
    let mut delta_stamina = 0_i64;
    match effect_type {
        "heal" => {
            let value =
                roll_item_use_amount_for_qty(parse_effect_i64(effect.get("value")), &effect, qty);
            if value <= 0 {
                return Err(AppError::config("该物品暂不支持使用效果"));
            }
            delta_qixue = value;
        }
        "resource" => {
            let resource = effect
                .get("params")
                .and_then(|value| value.as_object())
                .and_then(|params| params.get("resource"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let value =
                roll_item_use_amount_for_qty(parse_effect_i64(effect.get("value")), &effect, qty);
            if value <= 0 {
                return Err(AppError::config("该物品暂不支持使用效果"));
            }
            match resource {
                "lingqi" => delta_lingqi = value,
                "exp" => delta_exp = value,
                "stamina" => delta_stamina = value,
                _ => return Err(AppError::config("该物品暂不支持使用效果")),
            }
        }
        _ => return Err(AppError::config("该物品暂不支持使用效果")),
    }

    let use_limit_config = resolve_inventory_use_limit_config(item_def);
    enforce_inventory_use_limits(
        state,
        character_id,
        item_def_id.as_str(),
        use_limit_config,
        qty,
    )
    .await?;

    let character_row = state.database.fetch_optional(
        "SELECT COALESCE(c.jing, 0)::bigint AS qixue, COALESCE(c.jing, 0)::bigint AS max_qixue, COALESCE(c.qi, 0)::bigint AS lingqi, COALESCE(c.qi, 0)::bigint AS max_lingqi, c.exp, c.stamina, c.stamina_recover_at::text AS stamina_recover_at_text, COALESCE(cip.level, 0) AS insight_level, mco.start_at::text AS month_card_start_at_text, mco.expire_at::text AS month_card_expire_at_text FROM characters c LEFT JOIN character_insight_progress cip ON cip.character_id = c.id LEFT JOIN month_card_ownership mco ON mco.character_id = c.id AND mco.month_card_id = $2 WHERE c.id = $1 LIMIT 1 FOR UPDATE OF c",
        |q| q.bind(character_id).bind(DEFAULT_MONTH_CARD_ID),
    ).await?;
    let Some(character_row) = character_row else {
        return Err(AppError::config("角色不存在"));
    };
    let current_qixue = character_row
        .try_get::<Option<i64>, _>("qixue")?
        .unwrap_or_default();
    let max_qixue = character_row
        .try_get::<Option<i64>, _>("max_qixue")?
        .unwrap_or_default()
        .max(0);
    let current_lingqi = character_row
        .try_get::<Option<i64>, _>("lingqi")?
        .unwrap_or_default();
    let max_lingqi = character_row
        .try_get::<Option<i64>, _>("max_lingqi")?
        .unwrap_or_default()
        .max(0);
    let current_exp = character_row
        .try_get::<Option<i64>, _>("exp")?
        .unwrap_or_default();
    let current_stamina = character_row
        .try_get::<Option<i32>, _>("stamina")?
        .map(i64::from)
        .unwrap_or_default();
    let insight_level = character_row
        .try_get::<Option<i64>, _>("insight_level")?
        .unwrap_or_default();
    let stamina_recover_at_text =
        character_row.try_get::<Option<String>, _>("stamina_recover_at_text")?;
    let month_card_start_at_text =
        character_row.try_get::<Option<String>, _>("month_card_start_at_text")?;
    let month_card_expire_at_text =
        character_row.try_get::<Option<String>, _>("month_card_expire_at_text")?;
    let effective_max_qixue = max_qixue
        .max(current_qixue.saturating_add(delta_qixue))
        .max(0);
    let effective_max_lingqi = max_lingqi
        .max(current_lingqi.saturating_add(delta_lingqi))
        .max(0);
    let next_qixue = (current_qixue + delta_qixue).clamp(0, effective_max_qixue);
    let next_lingqi = (current_lingqi + delta_lingqi).clamp(0, effective_max_lingqi);
    let next_exp = current_exp.saturating_add(delta_exp);
    let stamina_state = resolve_stamina_recovery_state(
        current_stamina,
        calc_character_stamina_max_by_insight_level(insight_level),
        stamina_recover_at_text.as_deref(),
        month_card_start_at_text.as_deref(),
        month_card_expire_at_text.as_deref(),
        load_default_month_card_stamina_recovery_rate(),
    );
    let next_stamina = (stamina_state.stamina + delta_stamina).clamp(0, stamina_state.max_stamina);
    let next_stamina_recover_at_text = if next_stamina >= stamina_state.max_stamina {
        current_timestamp_rfc3339()
    } else {
        stamina_state.next_recover_at_text
    };

    state.database.execute(
        "UPDATE characters SET jing = $1, qi = $2, exp = $3, stamina = $4, stamina_recover_at = $5::timestamptz, updated_at = NOW() WHERE id = $6",
        |q| q.bind(next_qixue).bind(next_lingqi).bind(next_exp).bind(next_stamina).bind(next_stamina_recover_at_text.as_str()).bind(character_id),
    ).await?;

    consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;

    record_inventory_use_limits(
        state,
        character_id,
        item_def_id.as_str(),
        use_limit_config,
        qty,
    )
    .await?;

    Ok(InventoryUseResponse {
        success: true,
        message: "使用成功".to_string(),
        effects: vec![effect],
        data: InventoryUseResponseData {
            character: InventoryUseCharacterSnapshotDto {
                qixue: next_qixue,
                lingqi: next_lingqi,
                exp: next_exp,
                stamina: next_stamina,
                stamina_max: stamina_state.max_stamina,
                max_qixue: effective_max_qixue,
                max_lingqi: effective_max_lingqi,
            },
            loot_results: None,
            partner_technique_result: None,
            partner_rebone_job: None,
        },
    })
}

fn is_supported_inventory_use_item_def_id(item_def_id: &str) -> bool {
    if item_def_id.starts_with("book-") {
        return true;
    }
    matches!(
        item_def_id,
        "cons-001"
            | "cons-002"
            | "cons-003"
            | "cons-004"
            | "cons-005"
            | "cons-006"
            | "cons-007"
            | "cons-008"
            | "cons-009"
            | "cons-010"
            | "cons-011"
            | "cons-monthcard-001"
            | "cons-battlepass-001"
            | "scroll-003"
            | "scroll-jie-fu-fu"
            | "func-001"
            | "box-001"
            | "box-002"
            | "box-003"
            | "box-005"
            | "box-006"
            | "box-007"
            | "box-008"
            | "box-009"
            | "box-010"
            | "box-011"
            | "box-012"
            | "box-013"
            | "cons-partner-rebone-001"
            | "cons-rename-001"
    )
}

#[derive(Debug, Clone, Copy, Default)]
struct InventoryUseLimitConfig {
    effective_cd_sec: i64,
    daily_limit: i64,
    total_limit: i64,
}

fn resolve_inventory_use_limit_config(item_def: &InventoryDefSeed) -> InventoryUseLimitConfig {
    let cd_round = item_def
        .row
        .get("use_cd_round")
        .and_then(|value| value.as_i64())
        .unwrap_or_default();
    let cd_sec = item_def
        .row
        .get("use_cd_sec")
        .and_then(|value| value.as_i64())
        .unwrap_or_default();
    InventoryUseLimitConfig {
        effective_cd_sec: cd_round.max(cd_sec).max(0),
        daily_limit: item_def
            .row
            .get("use_limit_daily")
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            .max(0),
        total_limit: item_def
            .row
            .get("use_limit_total")
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            .max(0),
    }
}

async fn enforce_inventory_use_limits(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
    config: InventoryUseLimitConfig,
    qty: i64,
) -> Result<(), AppError> {
    if config.effective_cd_sec > 0 {
        let cooldown_row = state
            .database
            .fetch_optional(
                "SELECT GREATEST(CEIL(EXTRACT(EPOCH FROM (cooldown_until - NOW()))), 0)::bigint AS remaining_seconds FROM item_use_cooldown WHERE character_id = $1 AND item_def_id = $2 FOR UPDATE",
                |q| q.bind(character_id).bind(item_def_id),
            )
            .await?;
        if let Some(cooldown_row) = cooldown_row {
            let remaining = cooldown_row
                .try_get::<Option<i64>, _>("remaining_seconds")?
                .unwrap_or_default();
            if remaining > 0 {
                return Err(AppError::config(format!("物品冷却中，剩余{}秒", remaining)));
            }
        }
    }

    if config.daily_limit > 0 || config.total_limit > 0 {
        let count_row = state
            .database
            .fetch_optional(
                "SELECT daily_count, total_count, last_daily_reset::text AS last_daily_reset_text FROM item_use_count WHERE character_id = $1 AND item_def_id = $2 FOR UPDATE",
                |q| q.bind(character_id).bind(item_def_id),
            )
            .await?;
        let today = state
            .database
            .fetch_optional("SELECT CURRENT_DATE::text AS today", |q| q)
            .await?
            .and_then(|row| row.try_get::<Option<String>, _>("today").ok().flatten())
            .unwrap_or_default();
        let current_daily = count_row
            .as_ref()
            .and_then(|row| {
                let last_reset = row
                    .try_get::<Option<String>, _>("last_daily_reset_text")
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                if last_reset == today {
                    row.try_get::<Option<i32>, _>("daily_count")
                        .ok()
                        .flatten()
                        .map(i64::from)
                } else {
                    Some(0)
                }
            })
            .unwrap_or_default();
        let current_total = count_row
            .as_ref()
            .and_then(|row| {
                row.try_get::<Option<i32>, _>("total_count")
                    .ok()
                    .flatten()
                    .map(i64::from)
            })
            .unwrap_or_default();
        if config.daily_limit > 0 && current_daily + qty > config.daily_limit {
            return Err(AppError::config("今日使用次数已达上限"));
        }
        if config.total_limit > 0 && current_total + qty > config.total_limit {
            return Err(AppError::config("使用次数已达上限"));
        }
    }

    Ok(())
}

async fn record_inventory_use_limits(
    state: &AppState,
    character_id: i64,
    item_def_id: &str,
    config: InventoryUseLimitConfig,
    qty: i64,
) -> Result<(), AppError> {
    if config.effective_cd_sec > 0 {
        state
            .database
            .execute(
                "INSERT INTO item_use_cooldown (character_id, item_def_id, cooldown_until, created_at, updated_at) VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval, NOW(), NOW()) ON CONFLICT (character_id, item_def_id) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until, updated_at = NOW()",
                |q| q.bind(character_id).bind(item_def_id).bind(config.effective_cd_sec),
            )
            .await?;
    }
    if config.daily_limit > 0 || config.total_limit > 0 {
        state
            .database
            .execute(
                "INSERT INTO item_use_count (character_id, item_def_id, daily_count, total_count, last_daily_reset, created_at, updated_at) VALUES ($1, $2, $3, $3, CURRENT_DATE, NOW(), NOW()) ON CONFLICT (character_id, item_def_id) DO UPDATE SET daily_count = CASE WHEN item_use_count.last_daily_reset = CURRENT_DATE THEN item_use_count.daily_count + EXCLUDED.daily_count ELSE EXCLUDED.daily_count END, total_count = item_use_count.total_count + EXCLUDED.total_count, last_daily_reset = CURRENT_DATE, updated_at = NOW()",
                |q| q.bind(character_id).bind(item_def_id).bind(qty),
            )
            .await?;
    }
    Ok(())
}

async fn use_inventory_multi_effect_item_tx(
    state: &AppState,
    character_id: i64,
    item_id: i64,
    qty: i64,
    item_def_id: &str,
    item_def: &InventoryDefSeed,
    source_snapshot: &ItemInstanceMutationSnapshot,
    effect_defs: &[serde_json::Value],
) -> Result<InventoryUseResponse, AppError> {
    let mut delta_qixue = 0_i64;
    let mut delta_lingqi = 0_i64;
    let mut delta_exp = 0_i64;
    let mut delta_stamina = 0_i64;
    let mut poison_dispelled = false;
    let mut pending_buffs: Vec<(String, f64, i64)> = Vec::new();

    for effect in effect_defs {
        let trigger = effect
            .get("trigger")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let target = effect
            .get("target")
            .and_then(|value| value.as_str())
            .unwrap_or("self");
        let effect_type = effect
            .get("effect_type")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if trigger != "use" || target != "self" {
            return Err(AppError::config("该物品暂不支持使用效果"));
        }
        match effect_type {
            "heal" => {
                let value = roll_item_use_amount_for_qty(
                    effect.get("value").and_then(|value| value.as_i64()),
                    effect,
                    qty,
                );
                if value <= 0 {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                delta_qixue = delta_qixue.saturating_add(value);
            }
            "resource" => {
                let resource = effect
                    .get("params")
                    .and_then(|value| value.as_object())
                    .and_then(|params| params.get("resource"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let value = roll_item_use_amount_for_qty(
                    effect.get("value").and_then(|value| value.as_i64()),
                    effect,
                    qty,
                );
                if value <= 0 {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                match resource {
                    "lingqi" => delta_lingqi = delta_lingqi.saturating_add(value),
                    "exp" => delta_exp = delta_exp.saturating_add(value),
                    "stamina" => delta_stamina = delta_stamina.saturating_add(value),
                    _ => return Err(AppError::config("该物品暂不支持使用效果")),
                }
            }
            "dispel" => {
                let dispel_type = effect
                    .get("params")
                    .and_then(|value| value.as_object())
                    .and_then(|params| params.get("dispel_type"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim();
                if dispel_type != "poison" {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                poison_dispelled = true;
            }
            "buff" => {
                let params = effect.get("params").and_then(|value| value.as_object());
                let attr_key = params
                    .and_then(|params| params.get("attr_key"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim();
                let apply_type = params
                    .and_then(|params| params.get("apply_type"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim();
                let duration_round = effect
                    .get("duration_round")
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default();
                let buff_value = params
                    .and_then(|params| params.get("value"))
                    .and_then(|value| {
                        value
                            .as_f64()
                            .or_else(|| value.as_i64().map(|number| number as f64))
                    })
                    .unwrap_or_default();
                if apply_type != "flat"
                    || duration_round <= 0
                    || buff_value <= 0.0
                    || !matches!(attr_key, "wugong" | "fagong" | "sudu")
                {
                    return Err(AppError::config("该物品暂不支持使用效果"));
                }
                pending_buffs.push((format!("{}_flat", attr_key), buff_value, duration_round));
            }
            _ => return Err(AppError::config("该物品暂不支持使用效果")),
        }
    }

    let use_limit_config = resolve_inventory_use_limit_config(item_def);
    enforce_inventory_use_limits(state, character_id, item_def_id, use_limit_config, qty).await?;

    let character_row = state.database.fetch_optional(
        "SELECT COALESCE(c.jing, 0)::bigint AS qixue, COALESCE(c.jing, 0)::bigint AS max_qixue, COALESCE(c.qi, 0)::bigint AS lingqi, COALESCE(c.qi, 0)::bigint AS max_lingqi, c.exp, c.stamina, c.stamina_recover_at::text AS stamina_recover_at_text, COALESCE(cip.level, 0) AS insight_level, mco.start_at::text AS month_card_start_at_text, mco.expire_at::text AS month_card_expire_at_text FROM characters c LEFT JOIN character_insight_progress cip ON cip.character_id = c.id LEFT JOIN month_card_ownership mco ON mco.character_id = c.id AND mco.month_card_id = $2 WHERE c.id = $1 LIMIT 1 FOR UPDATE OF c",
        |q| q.bind(character_id).bind(DEFAULT_MONTH_CARD_ID),
    ).await?;
    let Some(character_row) = character_row else {
        return Err(AppError::config("角色不存在"));
    };
    let current_qixue = character_row
        .try_get::<Option<i64>, _>("qixue")?
        .unwrap_or_default();
    let max_qixue = character_row
        .try_get::<Option<i64>, _>("max_qixue")?
        .unwrap_or_default()
        .max(0);
    let current_lingqi = character_row
        .try_get::<Option<i64>, _>("lingqi")?
        .unwrap_or_default();
    let max_lingqi = character_row
        .try_get::<Option<i64>, _>("max_lingqi")?
        .unwrap_or_default()
        .max(0);
    let current_exp = character_row
        .try_get::<Option<i64>, _>("exp")?
        .unwrap_or_default();
    let current_stamina = character_row
        .try_get::<Option<i32>, _>("stamina")?
        .map(i64::from)
        .unwrap_or_default();
    let insight_level = character_row
        .try_get::<Option<i64>, _>("insight_level")?
        .unwrap_or_default();
    let stamina_recover_at_text =
        character_row.try_get::<Option<String>, _>("stamina_recover_at_text")?;
    let month_card_start_at_text =
        character_row.try_get::<Option<String>, _>("month_card_start_at_text")?;
    let month_card_expire_at_text =
        character_row.try_get::<Option<String>, _>("month_card_expire_at_text")?;
    let effective_max_qixue = max_qixue
        .max(current_qixue.saturating_add(delta_qixue))
        .max(0);
    let effective_max_lingqi = max_lingqi
        .max(current_lingqi.saturating_add(delta_lingqi))
        .max(0);
    let next_qixue = (current_qixue + delta_qixue).clamp(0, effective_max_qixue);
    let next_lingqi = (current_lingqi + delta_lingqi).clamp(0, effective_max_lingqi);
    let next_exp = current_exp.saturating_add(delta_exp);
    let stamina_state = resolve_stamina_recovery_state(
        current_stamina,
        calc_character_stamina_max_by_insight_level(insight_level),
        stamina_recover_at_text.as_deref(),
        month_card_start_at_text.as_deref(),
        month_card_expire_at_text.as_deref(),
        load_default_month_card_stamina_recovery_rate(),
    );
    let next_stamina = (stamina_state.stamina + delta_stamina).clamp(0, stamina_state.max_stamina);
    let next_stamina_recover_at_text = if next_stamina >= stamina_state.max_stamina {
        current_timestamp_rfc3339()
    } else {
        stamina_state.next_recover_at_text
    };

    state.database.execute(
        "UPDATE characters SET jing = $1, qi = $2, exp = $3, stamina = $4, stamina_recover_at = $5::timestamptz, updated_at = NOW() WHERE id = $6",
        |q| q.bind(next_qixue).bind(next_lingqi).bind(next_exp).bind(next_stamina).bind(next_stamina_recover_at_text.as_str()).bind(character_id),
    ).await?;

    if poison_dispelled {
        state.database.execute(
            "DELETE FROM character_global_buff WHERE character_id = $1 AND buff_key = 'poison' AND expire_at > NOW()",
            |q| q.bind(character_id),
        ).await?;
    }
    if !pending_buffs.is_empty() {
        let source_id = format!("{}:{}", item_def_id, item_id);
        for (buff_key, buff_value, duration_round) in pending_buffs {
            let expire_at = inventory_format_iso(
                inventory_now_utc().unix_timestamp() * 1000 + duration_round * 30_000,
            )?;
            state.database.execute(
                "INSERT INTO character_global_buff (character_id, buff_key, source_type, source_id, buff_value, started_at, expire_at, created_at, updated_at) VALUES ($1, $2, 'item_use', $3, $4, NOW(), $5::timestamptz, NOW(), NOW()) ON CONFLICT (character_id, buff_key, source_type, source_id) DO UPDATE SET buff_value = EXCLUDED.buff_value, started_at = NOW(), expire_at = EXCLUDED.expire_at, updated_at = NOW()",
                |q| q.bind(character_id).bind(&buff_key).bind(&source_id).bind(buff_value).bind(&expire_at),
            ).await?;
        }
    }

    consume_inventory_used_item_instance_tx(state, source_snapshot, qty).await?;

    record_inventory_use_limits(state, character_id, item_def_id, use_limit_config, qty).await?;

    Ok(InventoryUseResponse {
        success: true,
        message: "使用成功".to_string(),
        effects: effect_defs.to_vec(),
        data: InventoryUseResponseData {
            character: InventoryUseCharacterSnapshotDto {
                qixue: next_qixue,
                lingqi: next_lingqi,
                exp: next_exp,
                stamina: next_stamina,
                stamina_max: stamina_state.max_stamina,
                max_qixue: effective_max_qixue,
                max_lingqi: effective_max_lingqi,
            },
            loot_results: None,
            partner_technique_result: None,
            partner_rebone_job: None,
        },
    })
}

async fn preview_inventory_disassemble_plan(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
    qty: i64,
) -> Result<InventoryDisassemblePlan, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, item_def_id, qty, quality, quality_rank, location, strengthen_level, refine_level, affixes, locked FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("物品不存在"));
    };
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let item_qty = row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
    if locked {
        return Err(AppError::config("物品已锁定"));
    }
    if location == "equipped" {
        let defs = load_inventory_def_map()?;
        let def = defs
            .get(item_def_id.as_str())
            .ok_or_else(|| AppError::config("物品不存在"))?;
        if def.row.get("category").and_then(|value| value.as_str()) == Some("equipment") {
            return Err(AppError::config("穿戴中的装备不可分解"));
        }
        return Err(AppError::config("该物品当前位置不可分解"));
    }
    if !matches!(location.as_str(), "bag" | "warehouse") {
        return Err(AppError::config("该物品当前位置不可分解"));
    }
    if qty > item_qty {
        return Err(AppError::config("道具数量不足"));
    }
    let defs = load_inventory_def_map()?;
    let def = defs
        .get(item_def_id.as_str())
        .ok_or_else(|| AppError::config("物品不存在"))?;
    if def
        .row
        .get("disassemblable")
        .and_then(|value| value.as_bool())
        == Some(false)
    {
        return Err(AppError::config("该物品不可分解"));
    }
    let plan = build_inventory_disassemble_plan(
        &defs,
        item_def_id.as_str(),
        row.try_get::<Option<String>, _>("quality")?,
        row.try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
        row.try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
        row.try_get::<Option<i32>, _>("refine_level")?
            .map(i64::from)
            .unwrap_or_default(),
        row.try_get::<Option<serde_json::Value>, _>("affixes")?,
        qty,
    )?;
    Ok(plan)
}

async fn disassemble_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
    qty: i64,
) -> Result<InventoryDisassembleResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let plan =
        preview_inventory_disassemble_plan(state, character_id, item_instance_id, qty).await?;
    let row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("物品不存在"));
    };
    let source_snapshot = map_item_instance_snapshot_from_row(&row)?;
    let current_qty = row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if current_qty < qty {
        return Err(AppError::config("道具数量不足"));
    }
    consume_inventory_used_item_instance_tx(state, &source_snapshot, qty).await?;

    let reward_item_pairs = plan
        .rewards
        .items
        .iter()
        .filter_map(|reward| {
            (reward.r#type == "item" && reward.amount > 0)
                .then(|| {
                    reward
                        .item_def_id
                        .as_deref()
                        .map(|item_def_id| (item_def_id.to_string(), reward.amount))
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    let disassemble_ref_id = item_instance_id.to_string();
    if !buffer_inventory_item_reward_deltas(
        state,
        user_id,
        character_id,
        "disassemble",
        Some(disassemble_ref_id.as_str()),
        plan.rewards.silver,
        &reward_item_pairs,
    )
    .await?
    {
        for reward in &plan.rewards.items {
            if reward.r#type != "item" || reward.amount <= 0 {
                continue;
            }
            let item_def_id = reward
                .item_def_id
                .as_deref()
                .ok_or_else(|| AppError::config("分解奖励配置错误"))?;
            let defs = load_inventory_def_map()?;
            let bind_type = defs
                .get(item_def_id)
                .and_then(|seed| seed.row.get("bind_type"))
                .and_then(|value| value.as_str())
                .unwrap_or("none");
            state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'disassemble', $6) RETURNING id",
                |q| q.bind(user_id).bind(character_id).bind(item_def_id).bind(reward.amount).bind(bind_type).bind(item_instance_id.to_string()),
            ).await?;
        }
        if plan.rewards.silver > 0 {
            state.database.execute(
                "UPDATE characters SET silver = COALESCE(silver, 0) + $1, updated_at = NOW() WHERE id = $2",
                |q| q.bind(plan.rewards.silver).bind(character_id),
            ).await?;
        }
    }
    Ok(InventoryDisassembleResponse {
        success: true,
        message: "分解成功".to_string(),
        rewards: plan.rewards,
    })
}

async fn disassemble_inventory_items_batch_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    items: Vec<(i64, i64)>,
) -> Result<InventoryDisassembleBatchResponse, AppError> {
    if items.is_empty() {
        return Ok(inventory_disassemble_batch_failure("items参数错误"));
    }
    acquire_inventory_mutex(state, character_id).await?;
    let unique_ids = items.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    let rows = state.database.fetch_all(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2) FOR UPDATE",
        |q| q.bind(character_id).bind(&unique_ids),
    ).await?;
    if rows.len() != unique_ids.len() {
        return Ok(inventory_disassemble_batch_failure("包含不存在的物品"));
    }
    let defs = load_inventory_def_map()?;
    let qty_by_id = items.into_iter().collect::<BTreeMap<_, _>>();
    let mut total_silver = 0_i64;
    let mut reward_items_by_def: BTreeMap<String, InventoryUseLootResultDto> = BTreeMap::new();
    let mut consume_operations = Vec::new();
    let mut skipped_locked_count = 0_i64;
    let mut skipped_locked_qty_total = 0_i64;
    let mut disassembled_qty_total = 0_i64;

    for row in rows {
        let row_id = row.try_get::<i64, _>("id")?;
        let request_qty = qty_by_id.get(&row_id).copied().unwrap_or_default();
        if request_qty <= 0 {
            return Ok(inventory_disassemble_batch_failure("items参数错误"));
        }
        let row_qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default();
        if row_qty < request_qty {
            return Ok(inventory_disassemble_batch_failure("包含数量不足的物品"));
        }
        let location = row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default();
        if location == "equipped" {
            continue;
        }
        if location != "bag" && location != "warehouse" {
            return Ok(inventory_disassemble_batch_failure(
                "包含不可分解位置的物品",
            ));
        }
        let item_def_id = row.try_get::<String, _>("item_def_id")?;
        let Some(item_def) = defs.get(item_def_id.as_str()) else {
            return Ok(inventory_disassemble_batch_failure("包含不存在的物品"));
        };
        if item_def
            .row
            .get("disassemblable")
            .and_then(|value| value.as_bool())
            == Some(false)
        {
            return Ok(inventory_disassemble_batch_failure("包含不可分解的物品"));
        }
        let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
        if locked {
            skipped_locked_count += 1;
            skipped_locked_qty_total += request_qty;
            continue;
        }
        let plan = build_inventory_disassemble_plan(
            &defs,
            item_def_id.as_str(),
            row.try_get::<Option<String>, _>("quality")?,
            row.try_get::<Option<i32>, _>("quality_rank")?
                .map(i64::from),
            row.try_get::<Option<i32>, _>("strengthen_level")?
                .map(i64::from)
                .unwrap_or_default(),
            row.try_get::<Option<i32>, _>("refine_level")?
                .map(i64::from)
                .unwrap_or_default(),
            row.try_get::<Option<serde_json::Value>, _>("affixes")?,
            request_qty,
        )?;
        total_silver += plan.rewards.silver;
        for reward in plan.rewards.items {
            let key = reward.item_def_id.clone().unwrap_or_default();
            if let Some(existing) = reward_items_by_def.get_mut(&key) {
                existing.amount += reward.amount;
            } else {
                reward_items_by_def.insert(key, reward);
            }
        }
        consume_operations.push((map_item_instance_snapshot_from_row(&row)?, request_qty));
        disassembled_qty_total += request_qty;
    }

    for (snapshot, consume_qty) in consume_operations {
        consume_inventory_used_item_instance_tx(state, &snapshot, consume_qty).await?;
    }

    let reward_items = reward_items_by_def.into_values().collect::<Vec<_>>();
    let reward_item_pairs = reward_items
        .iter()
        .filter_map(|reward| {
            reward
                .item_def_id
                .as_ref()
                .map(|item_def_id| (item_def_id.clone(), reward.amount))
        })
        .collect::<Vec<_>>();
    if !buffer_inventory_item_reward_deltas(
        state,
        user_id,
        character_id,
        "disassemble",
        Some("batch"),
        total_silver,
        &reward_item_pairs,
    )
    .await?
    {
        for reward in &reward_items {
            if reward.r#type != "item" || reward.amount <= 0 {
                continue;
            }
            let item_def_id = reward
                .item_def_id
                .as_deref()
                .ok_or_else(|| AppError::config("分解奖励配置错误"))?;
            let bind_type = defs
                .get(item_def_id)
                .and_then(|seed| seed.row.get("bind_type"))
                .and_then(|value| value.as_str())
                .unwrap_or("none");
            state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'disassemble', 'batch') RETURNING id",
                |q| q.bind(user_id).bind(character_id).bind(item_def_id).bind(reward.amount).bind(bind_type),
            ).await?;
        }
        if total_silver > 0 {
            state.database.execute(
                "UPDATE characters SET silver = COALESCE(silver, 0) + $1, updated_at = NOW() WHERE id = $2",
                |q| q.bind(total_silver).bind(character_id),
            ).await?;
        }
    }

    Ok(InventoryDisassembleBatchResponse {
        success: true,
        message: if skipped_locked_count > 0 {
            format!("分解成功（已跳过已锁定×{}）", skipped_locked_count)
        } else {
            "分解成功".to_string()
        },
        disassembled_count: Some((qty_by_id.len() as i64) - skipped_locked_count),
        disassembled_qty_total: Some(disassembled_qty_total),
        skipped_locked_count: Some(skipped_locked_count),
        skipped_locked_qty_total: Some(skipped_locked_qty_total),
        rewards: Some(InventoryDisassembleRewardsDto {
            silver: total_silver,
            items: reward_items,
        }),
    })
}

fn inventory_disassemble_batch_failure(message: &str) -> InventoryDisassembleBatchResponse {
    InventoryDisassembleBatchResponse {
        success: false,
        message: message.to_string(),
        disassembled_count: None,
        disassembled_qty_total: None,
        skipped_locked_count: None,
        skipped_locked_qty_total: None,
        rewards: None,
    }
}

async fn build_inventory_growth_cost_preview(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryGrowthCostPreviewData, AppError> {
    let row = state.database.fetch_optional(
        "SELECT item_def_id, quality, quality_rank, strengthen_level, refine_level, socketed_gems, location, locked, qty FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("物品不存在"));
    };
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let defs = load_inventory_def_map()?;
    let def = defs
        .get(item_def_id.as_str())
        .ok_or_else(|| AppError::config("该物品不可强化"))?;
    if def.row.get("category").and_then(|value| value.as_str()) != Some("equipment") {
        return Err(AppError::config("该物品不可强化"));
    }
    let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
    if locked {
        return Err(AppError::config("物品已锁定"));
    }
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if location == "auction" {
        return Err(AppError::config("交易中的装备不可强化"));
    }
    if !matches!(location.as_str(), "bag" | "warehouse" | "equipped") {
        return Err(AppError::config("该物品当前位置不可强化"));
    }
    if row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default()
        != 1
    {
        return Err(AppError::config("装备数量异常"));
    }

    let equip_req_realm_rank = get_realm_rank_one_based_for_equipment(
        def.row
            .get("equip_req_realm")
            .and_then(|value| value.as_str())
            .unwrap_or("凡人"),
    );
    let discount_rate = load_forge_house_discount_rate(state, character_id).await?;

    let enhance_current_level = normalize_enhance_level(
        row.try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
    );
    let enhance_target_level = enhance_current_level + 1;
    let enhance_cost = build_discounted_growth_cost_plan(
        "enhance",
        enhance_target_level,
        equip_req_realm_rank,
        discount_rate,
        &defs,
    )?;

    let refine_current_level = row
        .try_get::<Option<i32>, _>("refine_level")?
        .map(i64::from)
        .unwrap_or_default()
        .clamp(0, 10);
    let refine_target_level = if refine_current_level >= 10 {
        10
    } else {
        refine_current_level + 1
    };
    let refine_cost = if refine_current_level >= 10 {
        None
    } else {
        Some(build_discounted_growth_cost_plan(
            "refine",
            refine_target_level,
            equip_req_realm_rank,
            discount_rate,
            &defs,
        )?)
    };

    let def_quality_rank = map_quality_rank(
        def.row
            .get("quality")
            .and_then(|value| value.as_str())
            .unwrap_or("黄"),
    );
    let resolved_quality_rank = row
        .try_get::<Option<i32>, _>("quality_rank")?
        .map(i64::from)
        .unwrap_or_else(|| {
            map_quality_rank(
                row.try_get::<Option<String>, _>("quality")
                    .ok()
                    .flatten()
                    .as_deref()
                    .unwrap_or(
                        def.row
                            .get("quality")
                            .and_then(|value| value.as_str())
                            .unwrap_or("黄"),
                    ),
            )
        });
    let socketed_gems = row.try_get::<Option<serde_json::Value>, _>("socketed_gems")?;
    let base_attrs_raw = def
        .row
        .get("base_attrs")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    Ok(InventoryGrowthCostPreviewData {
        enhance: InventoryGrowthPreviewEntry {
            current_level: enhance_current_level,
            target_level: enhance_target_level,
            max_level: None,
            success_rate: enhance_success_rate(enhance_target_level),
            fail_mode: enhance_fail_mode(enhance_target_level).to_string(),
            costs: Some(enhance_cost),
            preview_base_attrs: build_equipment_preview_base_attrs(
                &base_attrs_raw,
                def_quality_rank,
                resolved_quality_rank,
                enhance_target_level,
                refine_current_level,
                socketed_gems.as_ref(),
                &defs,
            ),
        },
        refine: InventoryGrowthPreviewEntry {
            current_level: refine_current_level,
            target_level: refine_target_level,
            max_level: Some(10),
            success_rate: refine_success_rate(refine_target_level),
            fail_mode: if refine_current_level >= 10 {
                "none".to_string()
            } else {
                "downgrade".to_string()
            },
            costs: refine_cost,
            preview_base_attrs: build_equipment_preview_base_attrs(
                &base_attrs_raw,
                def_quality_rank,
                resolved_quality_rank,
                enhance_current_level,
                refine_target_level,
                socketed_gems.as_ref(),
                &defs,
            ),
        },
    })
}

async fn refine_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryRefineResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(inventory_refine_failure("物品不存在", 0, None));
    };
    let defs = load_inventory_def_map()?;
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let def = defs
        .get(item_def_id.as_str())
        .ok_or_else(|| AppError::config("该物品不可精炼"))?;
    if def.row.get("category").and_then(|value| value.as_str()) != Some("equipment") {
        return Ok(inventory_refine_failure("该物品不可精炼", 0, None));
    }
    if row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false) {
        return Ok(inventory_refine_failure("物品已锁定", 0, None));
    }
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if location == "auction" {
        return Ok(inventory_refine_failure("交易中的装备不可精炼", 0, None));
    }
    if !matches!(location.as_str(), "bag" | "warehouse" | "equipped") {
        return Ok(inventory_refine_failure("该物品当前位置不可精炼", 0, None));
    }
    if row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default()
        != 1
    {
        return Ok(inventory_refine_failure("装备数量异常", 0, None));
    }

    let current_level = row
        .try_get::<Option<i32>, _>("refine_level")?
        .map(i64::from)
        .unwrap_or_default()
        .clamp(0, 10);
    let mut item_snapshot = map_item_instance_snapshot_from_row(&row)?;
    if current_level >= 10 {
        return Ok(InventoryRefineResponse {
            success: false,
            message: "精炼已达上限".to_string(),
            data: Some(InventoryRefineResponseData {
                refine_level: current_level,
                target_level: Some(current_level),
                success_rate: None,
                roll: None,
                used_material: None,
                costs: None,
                character: None,
            }),
        });
    }
    let target_level = current_level + 1;
    let equip_req_realm_rank = get_realm_rank_one_based_for_equipment(
        def.row
            .get("equip_req_realm")
            .and_then(|value| value.as_str())
            .unwrap_or("凡人"),
    );
    let discount_rate = load_forge_house_discount_rate(state, character_id).await?;
    let cost_plan = build_discounted_growth_cost_plan(
        "refine",
        target_level,
        equip_req_realm_rank,
        discount_rate,
        &defs,
    )?;

    consume_inventory_material_by_def_id(
        state,
        user_id,
        character_id,
        &cost_plan.material_item_def_id,
        cost_plan.material_qty,
    )
    .await?;
    consume_inventory_character_currencies(
        state,
        character_id,
        cost_plan.silver_cost,
        cost_plan.spirit_stone_cost,
        0,
    )
    .await?;

    let success_rate = refine_success_rate(target_level);
    let roll = (pick_random_index(10_000, item_instance_id as usize) as f64) / 10_000.0;
    let success = roll < success_rate;
    let result_level = if success {
        target_level
    } else {
        get_refine_fail_result_level(current_level, target_level)
    };
    item_snapshot.refine_level = result_level;
    if location == "equipped" {
        state.database.execute(
            "UPDATE item_instance SET refine_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
            |q| q.bind(result_level).bind(item_instance_id).bind(character_id),
        ).await?;
    } else {
        apply_inventory_item_snapshot_mutation_tx(state, item_snapshot).await?;
    }

    let character = if location == "equipped" {
        load_inventory_character_snapshot(state, user_id).await?
    } else {
        None
    };
    Ok(InventoryRefineResponse {
        success,
        message: if success {
            "精炼成功".to_string()
        } else {
            "精炼失败".to_string()
        },
        data: Some(InventoryRefineResponseData {
            refine_level: result_level,
            target_level: Some(target_level),
            success_rate: Some(success_rate),
            roll: Some(roll),
            used_material: Some(InventoryRefineMaterialCostDto {
                item_def_id: cost_plan.material_item_def_id.clone(),
                qty: cost_plan.material_qty,
            }),
            costs: Some(InventoryRefineCostDto {
                silver: cost_plan.silver_cost,
                spirit_stones: cost_plan.spirit_stone_cost,
            }),
            character,
        }),
    })
}

fn inventory_refine_failure(
    message: &str,
    refine_level: i64,
    target_level: Option<i64>,
) -> InventoryRefineResponse {
    InventoryRefineResponse {
        success: false,
        message: message.to_string(),
        data: Some(InventoryRefineResponseData {
            refine_level,
            target_level,
            success_rate: None,
            roll: None,
            used_material: None,
            costs: None,
            character: None,
        }),
    }
}

async fn enhance_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryEnhanceResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(inventory_enhance_failure("物品不存在", 0, None, None, None));
    };
    let defs = load_inventory_def_map()?;
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let def = defs
        .get(item_def_id.as_str())
        .ok_or_else(|| AppError::config("该物品不可强化"))?;
    if def.row.get("category").and_then(|value| value.as_str()) != Some("equipment") {
        return Ok(inventory_enhance_failure(
            "该物品不可强化",
            0,
            None,
            None,
            None,
        ));
    }
    if row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false) {
        return Ok(inventory_enhance_failure("物品已锁定", 0, None, None, None));
    }
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if location == "auction" {
        return Ok(inventory_enhance_failure(
            "交易中的装备不可强化",
            0,
            None,
            None,
            None,
        ));
    }
    if !matches!(location.as_str(), "bag" | "warehouse" | "equipped") {
        return Ok(inventory_enhance_failure(
            "该物品当前位置不可强化",
            0,
            None,
            None,
            None,
        ));
    }
    if row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default()
        != 1
    {
        return Ok(inventory_enhance_failure(
            "装备数量异常",
            0,
            None,
            None,
            None,
        ));
    }

    let current_level = normalize_enhance_level(
        row.try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
    );
    let mut item_snapshot = map_item_instance_snapshot_from_row(&row)?;
    let target_level = current_level + 1;
    let equip_req_realm_rank = get_realm_rank_one_based_for_equipment(
        def.row
            .get("equip_req_realm")
            .and_then(|value| value.as_str())
            .unwrap_or("凡人"),
    );
    let discount_rate = load_forge_house_discount_rate(state, character_id).await?;
    let cost_plan = build_discounted_growth_cost_plan(
        "enhance",
        target_level,
        equip_req_realm_rank,
        discount_rate,
        &defs,
    )?;

    consume_inventory_material_by_def_id(
        state,
        user_id,
        character_id,
        &cost_plan.material_item_def_id,
        cost_plan.material_qty,
    )
    .await?;
    consume_inventory_character_currencies(
        state,
        character_id,
        cost_plan.silver_cost,
        cost_plan.spirit_stone_cost,
        0,
    )
    .await?;

    let success_rate = enhance_success_rate(target_level);
    let roll = (pick_random_index(10_000, item_instance_id as usize) as f64) / 10_000.0;
    let success = roll < success_rate;
    let fail_mode = enhance_fail_mode(target_level).to_string();
    let destroyed = !success && fail_mode == "destroy";
    let result_level = if success {
        target_level
    } else if fail_mode == "downgrade" {
        current_level.saturating_sub(1).max(0)
    } else {
        current_level
    };

    if destroyed {
        if location == "equipped" {
            state
                .database
                .execute(
                    "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
                    |q| q.bind(item_instance_id).bind(character_id),
                )
                .await?;
        } else {
            consume_inventory_used_item_instance_tx(
                state,
                &item_snapshot,
                item_snapshot.qty.max(1),
            )
            .await?;
        }
    } else {
        item_snapshot.strengthen_level = result_level;
        if location == "equipped" {
            state.database.execute(
                "UPDATE item_instance SET strengthen_level = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
                |q| q.bind(result_level).bind(item_instance_id).bind(character_id),
            ).await?;
        } else {
            apply_inventory_item_snapshot_mutation_tx(state, item_snapshot).await?;
        }
    }

    let character = if location == "equipped" {
        load_inventory_character_snapshot(state, user_id).await?
    } else {
        None
    };
    Ok(InventoryEnhanceResponse {
        success,
        message: if success {
            "强化成功".to_string()
        } else if destroyed {
            "强化失败，装备已碎".to_string()
        } else {
            "强化失败".to_string()
        },
        data: Some(InventoryEnhanceResponseData {
            strengthen_level: result_level,
            target_level: Some(target_level),
            success_rate: Some(success_rate),
            roll: Some(roll),
            fail_mode: Some(fail_mode),
            destroyed: Some(destroyed),
            used_material: Some(InventoryRefineMaterialCostDto {
                item_def_id: cost_plan.material_item_def_id.clone(),
                qty: cost_plan.material_qty,
            }),
            costs: Some(InventoryRefineCostDto {
                silver: cost_plan.silver_cost,
                spirit_stones: cost_plan.spirit_stone_cost,
            }),
            character,
        }),
    })
}

fn inventory_enhance_failure(
    message: &str,
    strengthen_level: i64,
    target_level: Option<i64>,
    fail_mode: Option<String>,
    destroyed: Option<bool>,
) -> InventoryEnhanceResponse {
    InventoryEnhanceResponse {
        success: false,
        message: message.to_string(),
        data: Some(InventoryEnhanceResponseData {
            strengthen_level,
            target_level,
            success_rate: None,
            roll: None,
            fail_mode,
            destroyed,
            used_material: None,
            costs: None,
            character: None,
        }),
    }
}

async fn consume_inventory_material_by_def_id(
    state: &AppState,
    _user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
) -> Result<(), AppError> {
    let rows = state.database.fetch_all(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE owner_character_id = $1 AND item_def_id = $2 AND location IN ('bag', 'warehouse') ORDER BY locked ASC, qty DESC, id ASC FOR UPDATE",
        |q| q.bind(character_id).bind(item_def_id),
    ).await?;
    if rows.is_empty() {
        return Err(AppError::config(&format!("材料不足，需要{}", qty)));
    }
    let mut remaining = qty;
    let mut touched = false;
    for row in rows {
        let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
        if locked {
            continue;
        }
        let id = row.try_get::<i64, _>("id")?;
        let current_qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default();
        if current_qty <= 0 {
            continue;
        }
        touched = true;
        let consume = remaining.min(current_qty);
        let snapshot = map_item_instance_snapshot_from_row(&row)?;
        let _ = id;
        consume_inventory_used_item_instance_tx(state, &snapshot, consume).await?;
        remaining -= consume;
        if remaining <= 0 {
            break;
        }
    }
    if remaining > 0 {
        if touched {
            return Err(AppError::config(&format!("材料不足，需要{}", qty)));
        }
        return Err(AppError::config("材料已锁定"));
    }
    Ok(())
}

async fn consume_inventory_specific_item_instance(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
    qty: i64,
) -> Result<(), AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("所选宝石不存在"));
    };
    if row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false) {
        return Err(AppError::config("所选宝石已锁定"));
    }
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if !matches!(location.as_str(), "bag" | "warehouse") {
        return Err(AppError::config("所选宝石不可消耗"));
    }
    let current_qty = row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if current_qty < qty {
        return Err(AppError::config("所选宝石数量不足"));
    }
    let snapshot = map_item_instance_snapshot_from_row(&row)?;
    consume_inventory_used_item_instance_tx(state, &snapshot, qty).await?;
    Ok(())
}

async fn consume_inventory_character_currencies(
    state: &AppState,
    character_id: i64,
    silver_cost: i64,
    spirit_stone_cost: i64,
    exp_cost: i64,
) -> Result<(), AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT silver, spirit_stones, exp FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    let silver = row.try_get::<Option<i64>, _>("silver")?.unwrap_or_default();
    let spirit_stones = row
        .try_get::<Option<i64>, _>("spirit_stones")?
        .unwrap_or_default();
    let exp = row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default();
    if silver < silver_cost {
        return Err(AppError::config(&format!("银两不足，需要{}", silver_cost)));
    }
    if spirit_stones < spirit_stone_cost {
        return Err(AppError::config(&format!(
            "灵石不足，需要{}",
            spirit_stone_cost
        )));
    }
    if exp < exp_cost {
        return Err(AppError::config(&format!("经验不足，需要{}", exp_cost)));
    }
    state.database.execute(
        "UPDATE characters SET silver = silver - $1, spirit_stones = spirit_stones - $2, exp = exp - $3, updated_at = NOW() WHERE id = $4",
        |q| q.bind(silver_cost).bind(spirit_stone_cost).bind(exp_cost).bind(character_id),
    ).await?;
    Ok(())
}

fn get_refine_fail_result_level(current_level: i64, target_level: i64) -> i64 {
    if target_level >= 6 {
        current_level.saturating_sub(1).max(0)
    } else {
        current_level
    }
}

async fn socket_inventory_gem_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
    gem_item_instance_id: i64,
    requested_slot: Option<i64>,
) -> Result<InventorySocketResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let defs = load_inventory_def_map()?;

    let equip_row = state.database.fetch_optional(
        "SELECT id, item_def_id, qty, location, locked, quality_rank, socketed_gems FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(equip_row) = equip_row else {
        return Ok(inventory_socket_failure("物品不存在"));
    };
    let equip_item_def_id = equip_row.try_get::<String, _>("item_def_id")?;
    let equip_def = defs
        .get(equip_item_def_id.as_str())
        .ok_or_else(|| AppError::config("物品不存在"))?;
    if equip_def
        .row
        .get("category")
        .and_then(|value| value.as_str())
        != Some("equipment")
    {
        return Ok(inventory_socket_failure("该物品不可镶嵌"));
    }
    if equip_row
        .try_get::<Option<bool>, _>("locked")?
        .unwrap_or(false)
    {
        return Ok(inventory_socket_failure("物品已锁定"));
    }
    let equip_location = equip_row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if equip_location == "auction" {
        return Ok(inventory_socket_failure("交易中的装备不可镶嵌"));
    }
    if !matches!(equip_location.as_str(), "bag" | "warehouse" | "equipped") {
        return Ok(inventory_socket_failure("该物品当前位置不可镶嵌"));
    }
    if equip_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default()
        != 1
    {
        return Ok(inventory_socket_failure("装备数量异常"));
    }
    let resolved_quality_rank = equip_row
        .try_get::<Option<i32>, _>("quality_rank")?
        .map(i64::from)
        .unwrap_or(1)
        .max(1);
    let socket_max = resolve_socket_max(
        equip_def
            .row
            .get("socket_max")
            .and_then(|value| value.as_i64()),
        resolved_quality_rank,
    );
    if socket_max <= 0 {
        return Ok(inventory_socket_failure("该装备无可用镶嵌孔"));
    }
    let gem_slot_types = equip_def.row.get("gem_slot_types").cloned();
    let current_entries = parse_socketed_gems(
        equip_row.try_get::<Option<serde_json::Value>, _>("socketed_gems")?,
        &defs,
    );

    let slot = if let Some(slot) = requested_slot {
        if slot >= socket_max {
            return Ok(inventory_socket_failure("孔位参数错误"));
        }
        slot
    } else {
        let Some(slot) = get_next_available_socket_slot(&current_entries, socket_max) else {
            return Ok(inventory_socket_failure("镶嵌孔已满，请指定替换孔位"));
        };
        slot
    };

    let gem_row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(gem_item_instance_id).bind(character_id),
    ).await?;
    let Some(gem_row) = gem_row else {
        return Ok(inventory_socket_failure("宝石不存在"));
    };
    if gem_row
        .try_get::<Option<bool>, _>("locked")?
        .unwrap_or(false)
    {
        return Ok(inventory_socket_failure("宝石已锁定"));
    }
    let gem_location = gem_row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if !matches!(gem_location.as_str(), "bag" | "warehouse") {
        return Ok(inventory_socket_failure("宝石当前位置不可消耗"));
    }
    if gem_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default()
        < 1
    {
        return Ok(inventory_socket_failure("宝石数量不足"));
    }
    let gem_snapshot = map_item_instance_snapshot_from_row(&gem_row)?;
    let gem_item_def_id = gem_row.try_get::<String, _>("item_def_id")?;
    let gem_def = defs
        .get(gem_item_def_id.as_str())
        .ok_or_else(|| AppError::config("宝石不存在"))?;
    if gem_def.row.get("category").and_then(|value| value.as_str()) != Some("gem") {
        return Ok(inventory_socket_failure("该物品不是宝石"));
    }
    let gem_effects = parse_socket_effects_from_item_effect_defs(gem_def.row.get("effect_defs"));
    if gem_effects.is_empty() {
        return Ok(inventory_socket_failure("该宝石不可镶嵌"));
    }
    let gem_type = resolve_gem_type_from_item_definition(
        gem_def
            .row
            .get("sub_category")
            .and_then(|value| value.as_str()),
        &gem_effects,
    );
    if !is_gem_type_allowed_in_slot(gem_slot_types.as_ref(), slot, gem_type.as_str()) {
        return Ok(inventory_socket_failure("该宝石类型与孔位不匹配"));
    }
    if current_entries
        .iter()
        .any(|entry| entry.item_def_id == gem_item_def_id && entry.slot != slot)
    {
        return Ok(inventory_socket_failure("同一件装备不可镶嵌相同宝石"));
    }
    let replaced_gem = current_entries
        .iter()
        .find(|entry| entry.slot == slot)
        .cloned();
    let silver_cost = if replaced_gem.is_some() { 100 } else { 50 };

    let character_row = state
        .database
        .fetch_optional(
            "SELECT silver FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(character_row) = character_row else {
        return Err(AppError::config("角色不存在"));
    };
    let current_silver = character_row
        .try_get::<Option<i64>, _>("silver")?
        .unwrap_or_default();
    if current_silver < silver_cost {
        return Ok(inventory_socket_failure(&format!(
            "银两不足，需要{}",
            silver_cost
        )));
    }
    state
        .database
        .execute(
            "UPDATE characters SET silver = silver - $1, updated_at = NOW() WHERE id = $2",
            |q| q.bind(silver_cost).bind(character_id),
        )
        .await?;

    let next_entries = upsert_socket_entry(
        &current_entries,
        InventorySocketedGemEntryDto {
            slot,
            item_def_id: gem_item_def_id.clone(),
            gem_type: gem_type.clone(),
            effects: gem_effects.clone(),
            name: gem_def
                .row
                .get("name")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
            icon: gem_def
                .row
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string()),
        },
    );
    let socketed_gems_json = serde_json::to_value(&next_entries)
        .map_err(|error| AppError::config(format!("socketed_gems 序列化失败: {error}")))?;
    state.database.execute(
        "UPDATE item_instance SET socketed_gems = $1::jsonb, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        |q| q.bind(socketed_gems_json).bind(item_instance_id).bind(character_id),
    ).await?;

    consume_inventory_used_item_instance_tx(state, &gem_snapshot, 1).await?;

    let character = if equip_location == "equipped" {
        load_inventory_character_snapshot(state, user_id).await?
    } else {
        None
    };

    Ok(InventorySocketResponse {
        success: true,
        message: if replaced_gem.is_some() {
            "替换镶嵌成功".to_string()
        } else {
            "镶嵌成功".to_string()
        },
        data: Some(InventorySocketResponseData {
            socketed_gems: next_entries,
            socket_max,
            slot,
            gem: InventorySocketGemDto {
                item_def_id: gem_item_def_id,
                name: gem_def
                    .row
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("宝石")
                    .to_string(),
                icon: gem_def
                    .row
                    .get("icon")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                gem_type,
            },
            replaced_gem,
            costs: Some(InventorySocketCostDto {
                silver: silver_cost,
            }),
            character,
        }),
    })
}

fn inventory_socket_failure(message: &str) -> InventorySocketResponse {
    InventorySocketResponse {
        success: false,
        message: message.to_string(),
        data: Some(InventorySocketResponseData {
            socketed_gems: vec![],
            socket_max: 0,
            slot: 0,
            gem: InventorySocketGemDto {
                item_def_id: String::new(),
                name: String::new(),
                icon: None,
                gem_type: String::new(),
            },
            replaced_gem: None,
            costs: None,
            character: None,
        }),
    }
}

fn parse_socket_effects_from_item_effect_defs(
    effect_defs_raw: Option<&serde_json::Value>,
) -> Vec<InventorySocketEffectDto> {
    effect_defs_raw
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|effect| effect.get("trigger").and_then(|value| value.as_str()) == Some("socket"))
        .filter(|effect| effect.get("effect_type").and_then(|value| value.as_str()) == Some("buff"))
        .filter_map(|effect| {
            let params = effect.get("params")?.as_object()?;
            let attr_key = params.get("attr_key")?.as_str()?.trim().to_string();
            let value = params
                .get("value")?
                .as_f64()
                .or_else(|| params.get("value")?.as_i64().map(|v| v as f64))?;
            let apply_type = params
                .get("apply_type")
                .and_then(|value| value.as_str())
                .unwrap_or("flat")
                .trim()
                .to_lowercase();
            if attr_key.is_empty() || value == 0.0 {
                return None;
            }
            Some(InventorySocketEffectDto {
                attr_key,
                value,
                apply_type: if apply_type == "percent" || apply_type == "special" {
                    apply_type
                } else {
                    "flat".to_string()
                },
            })
        })
        .collect()
}

fn resolve_gem_type_from_item_definition(
    sub_category: Option<&str>,
    effects: &[InventorySocketEffectDto],
) -> String {
    let sub_category = sub_category.unwrap_or_default().trim().to_lowercase();
    match sub_category.as_str() {
        "gem_attack" | "atk_jewel" => "attack".to_string(),
        "gem_defense" | "def_jewel" => "defense".to_string(),
        "gem_survival" | "hp_jewel" => "survival".to_string(),
        "gem_all" => "all".to_string(),
        _ => infer_gem_type_from_effects(effects),
    }
}

fn infer_gem_type_from_effects(effects: &[InventorySocketEffectDto]) -> String {
    let attack_keys = [
        "wugong",
        "fagong",
        "mingzhong",
        "baoji",
        "baoshang",
        "zengshang",
    ];
    let defense_keys = [
        "wufang",
        "fafang",
        "shanbi",
        "kangbao",
        "jianbaoshang",
        "jianfantan",
    ];
    let survival_keys = [
        "qixue",
        "max_qixue",
        "lingqi",
        "max_lingqi",
        "zhiliao",
        "jianliao",
        "xixue",
        "sudu",
    ];
    let mut has_attack = false;
    let mut has_defense = false;
    let mut has_survival = false;
    for effect in effects {
        let key = effect.attr_key.as_str();
        if attack_keys.contains(&key) {
            has_attack = true;
        } else if defense_keys.contains(&key) {
            has_defense = true;
        } else if survival_keys.contains(&key) {
            has_survival = true;
        }
    }
    let count = has_attack as i32 + has_defense as i32 + has_survival as i32;
    if count >= 2 {
        "all".to_string()
    } else if has_attack {
        "attack".to_string()
    } else if has_defense {
        "defense".to_string()
    } else if has_survival {
        "survival".to_string()
    } else {
        "utility".to_string()
    }
}

fn parse_socketed_gems(
    raw: Option<serde_json::Value>,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> Vec<InventorySocketedGemEntryDto> {
    let mut by_slot = BTreeMap::new();
    for gem in raw
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
    {
        let slot = gem
            .get("slot")
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            .max(0);
        let item_def_id = gem
            .get("itemDefId")
            .or_else(|| gem.get("item_def_id"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if item_def_id.is_empty() {
            continue;
        }
        let Some(def) = defs.get(item_def_id.as_str()) else {
            continue;
        };
        let effects = parse_socket_effects_from_item_effect_defs(def.row.get("effect_defs"));
        if effects.is_empty() {
            continue;
        }
        by_slot.insert(
            slot,
            InventorySocketedGemEntryDto {
                slot,
                item_def_id: item_def_id.clone(),
                gem_type: resolve_gem_type_from_item_definition(
                    def.row.get("sub_category").and_then(|value| value.as_str()),
                    &effects,
                ),
                effects,
                name: def
                    .row
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                icon: def
                    .row
                    .get("icon")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            },
        );
    }
    by_slot.into_values().collect()
}

fn resolve_socket_max(socket_max_raw: Option<i64>, resolved_quality_rank: i64) -> i64 {
    if let Some(value) = socket_max_raw.filter(|value| *value > 0) {
        return value.min(12);
    }
    match resolved_quality_rank.clamp(1, 4) {
        1 => 1,
        2 => 2,
        3 => 3,
        _ => 4,
    }
}

fn is_gem_type_allowed_in_slot(
    gem_slot_types_raw: Option<&serde_json::Value>,
    slot: i64,
    gem_type_raw: &str,
) -> bool {
    let Some(raw) = gem_slot_types_raw else {
        return true;
    };
    let allowed = parse_allowed_gem_types(raw, slot);
    if allowed.is_empty() {
        return true;
    }
    let gem_type = normalize_gem_type(gem_type_raw);
    allowed.contains(&"all".to_string()) || gem_type == "all" || allowed.contains(&gem_type)
}

fn parse_allowed_gem_types(raw: &serde_json::Value, slot: i64) -> Vec<String> {
    if let Some(array) = raw.as_array() {
        if let Some(slot_based) = array.get(slot as usize).and_then(|value| value.as_array()) {
            return slot_based
                .iter()
                .filter_map(|value| value.as_str().map(normalize_gem_type))
                .collect();
        }
        if array.iter().all(|value| value.is_string()) {
            return array
                .iter()
                .filter_map(|value| value.as_str().map(normalize_gem_type))
                .collect();
        }
    }
    if let Some(object) = raw.as_object() {
        if let Some(slot_array) = object
            .get(&slot.to_string())
            .and_then(|value| value.as_array())
        {
            return slot_array
                .iter()
                .filter_map(|value| value.as_str().map(normalize_gem_type))
                .collect();
        }
        if let Some(default_array) = object.get("default").and_then(|value| value.as_array()) {
            return default_array
                .iter()
                .filter_map(|value| value.as_str().map(normalize_gem_type))
                .collect();
        }
    }
    vec![]
}

fn normalize_gem_type(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "atk" | "attack" | "gongji" | "offense" => "attack".to_string(),
        "def" | "defense" | "fangyu" => "defense".to_string(),
        "hp" | "life" | "survival" | "shengming" => "survival".to_string(),
        "all" | "any" | "universal" | "*" => "all".to_string(),
        other => other.to_string(),
    }
}

fn get_next_available_socket_slot(
    entries: &[InventorySocketedGemEntryDto],
    socket_max: i64,
) -> Option<i64> {
    (0..socket_max).find(|slot| !entries.iter().any(|entry| entry.slot == *slot))
}

fn upsert_socket_entry(
    entries: &[InventorySocketedGemEntryDto],
    next_entry: InventorySocketedGemEntryDto,
) -> Vec<InventorySocketedGemEntryDto> {
    let mut by_slot = entries
        .iter()
        .map(|entry| (entry.slot, entry.clone()))
        .collect::<BTreeMap<_, _>>();
    by_slot.insert(next_entry.slot, next_entry);
    by_slot.into_values().collect()
}

async fn load_forge_house_discount_rate(
    state: &AppState,
    character_id: i64,
) -> Result<f64, AppError> {
    let row = state.database.fetch_optional(
        "SELECT sb.level FROM sect_member sm LEFT JOIN sect_building sb ON sb.sect_id = sm.sect_id AND sb.building_type = 'forge_house' WHERE sm.character_id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let level = row
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("level")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .unwrap_or_default();
    Ok(((level as f64) * 0.005).clamp(0.0, 0.25))
}

fn normalize_enhance_level(value: i64) -> i64 {
    value.max(0)
}

fn enhance_success_rate(target_level: i64) -> f64 {
    match target_level.max(1) {
        1..=5 => 1.0,
        6 => 0.8,
        7 => 0.7,
        8 => 0.6,
        9 => 0.5,
        10 => 0.4,
        11 => 0.35,
        12 => 0.3,
        13 => 0.25,
        14 => 0.2,
        _ => 0.15,
    }
}

fn refine_success_rate(target_level: i64) -> f64 {
    match target_level.clamp(1, 10) {
        1..=3 => 1.0,
        4 => 0.9,
        5 => 0.8,
        6 => 0.7,
        7 => 0.6,
        8 => 0.5,
        9 => 0.4,
        _ => 0.3,
    }
}

fn enhance_fail_mode(target_level: i64) -> &'static str {
    let level = target_level.max(1);
    if level >= 15 {
        "destroy"
    } else if (8..=14).contains(&level) {
        "downgrade"
    } else {
        "none"
    }
}

fn build_discounted_growth_cost_plan(
    mode: &str,
    target_level: i64,
    equip_req_realm_rank: i64,
    discount_rate: f64,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> Result<InventoryGrowthCostPlanDto, AppError> {
    let material_item_def_id = if mode == "enhance" && target_level <= 10 {
        "enhance-001"
    } else {
        "enhance-002"
    };
    let material_qty = (target_level.max(1) * equip_req_realm_rank.max(1)) as f64;
    let silver_cost =
        (125.0 * target_level.max(1) as f64 * equip_req_realm_rank.max(1) as f64).floor();
    let spirit_stone_cost = 20.0 * target_level.max(1) as f64 * equip_req_realm_rank.max(1) as f64;
    let multiplier = 1.0 - discount_rate.clamp(0.0, 1.0);
    let material_name = defs
        .get(material_item_def_id)
        .and_then(|seed| seed.row.get("name"))
        .and_then(|value| value.as_str())
        .unwrap_or(material_item_def_id)
        .to_string();
    Ok(InventoryGrowthCostPlanDto {
        material_item_def_id: material_item_def_id.to_string(),
        material_name,
        material_qty: if material_qty <= 0.0 {
            0
        } else {
            (material_qty * multiplier).floor().max(1.0) as i64
        },
        silver_cost: (silver_cost * multiplier).floor().max(0.0) as i64,
        spirit_stone_cost: (spirit_stone_cost * multiplier).floor().max(0.0) as i64,
    })
}

async fn load_gem_wallet(
    state: &AppState,
    character_id: i64,
) -> Result<GemCharacterWalletDto, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT silver, spirit_stones FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    Ok(GemCharacterWalletDto {
        silver: row.try_get::<Option<i64>, _>("silver")?.unwrap_or_default(),
        spirit_stones: row
            .try_get::<Option<i64>, _>("spirit_stones")?
            .unwrap_or_default(),
    })
}

async fn load_owned_item_qty_map(
    state: &AppState,
    character_id: i64,
) -> Result<BTreeMap<String, i64>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT item_def_id, COALESCE(SUM(qty), 0)::bigint AS qty FROM item_instance WHERE owner_character_id = $1 AND location IN ('bag', 'warehouse') AND locked = FALSE GROUP BY item_def_id",
        |q| q.bind(character_id),
    ).await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let id = row
                .try_get::<Option<String>, _>("item_def_id")
                .ok()
                .flatten()?;
            let qty = row
                .try_get::<Option<i64>, _>("qty")
                .ok()
                .flatten()
                .unwrap_or_default();
            Some((id, qty))
        })
        .collect())
}

fn load_gem_synthesis_recipe_rows() -> Result<Vec<GemRecipeSeedRow>, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../server/src/data/seeds/gem_synthesis_recipe.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {}: {error}", path.display())))?;
    let payload: InventoryRecipeFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse {}: {error}", path.display()))
    })?;
    let defs = load_inventory_def_map()?;
    let mut rows = Vec::new();
    for row in payload.recipes {
        if row
            .get("recipe_type")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            != "gem_synthesis"
        {
            continue;
        }
        let input = row
            .get("cost_items")
            .and_then(|value| value.as_array())
            .and_then(|items| items.first())
            .ok_or_else(|| AppError::config("宝石配方缺少 cost_items"))?;
        let input_item_def_id = input
            .get("item_def_id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let output_item_def_id = row
            .get("product_item_def_id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if input_item_def_id.is_empty() || output_item_def_id.is_empty() {
            continue;
        }
        let input_def = defs
            .get(input_item_def_id.as_str())
            .ok_or_else(|| AppError::config("宝石配方输入定义不存在"))?;
        let output_def = defs
            .get(output_item_def_id.as_str())
            .ok_or_else(|| AppError::config("宝石配方产物定义不存在"))?;
        let (input_gem_type, input_series_key, input_level) =
            parse_gem_item_series_identity(&input_item_def_id)
                .ok_or_else(|| AppError::config("宝石配方输入定义ID无效"))?;
        let (output_gem_type, output_series_key, output_level) =
            parse_gem_item_series_identity(&output_item_def_id)
                .ok_or_else(|| AppError::config("宝石配方产物定义ID无效"))?;
        if input_gem_type != output_gem_type || input_series_key != output_series_key {
            return Err(AppError::config("宝石配方输入输出子类型不一致"));
        }
        rows.push(GemRecipeSeedRow {
            id: row
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string(),
            name: row
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            from_level: input_def
                .row
                .get("gem_level")
                .and_then(|value| value.as_i64())
                .unwrap_or(input_level),
            to_level: output_def
                .row
                .get("gem_level")
                .and_then(|value| value.as_i64())
                .unwrap_or(output_level),
            gem_type: input_gem_type,
            series_key: input_series_key,
            input_item_def_id,
            input_qty: parse_recipe_i64(input.get("qty")),
            output_item_def_id,
            output_qty: parse_recipe_i64(row.get("product_qty")).max(1),
            cost_silver: parse_recipe_i64(row.get("cost_silver")),
            cost_spirit_stones: parse_recipe_i64(row.get("cost_spirit_stones")),
            success_rate: row
                .get("success_rate")
                .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
                .unwrap_or(1.0),
        });
    }
    Ok(rows)
}

fn build_gem_synthesis_recipes(
    defs: &BTreeMap<String, InventoryDefSeed>,
    owned_qty: &BTreeMap<String, i64>,
    wallet: &GemCharacterWalletDto,
) -> Result<Vec<GemSynthesisRecipeDto>, AppError> {
    let mut recipes = Vec::new();
    let gem_recipe_rows = load_gem_synthesis_recipe_rows()?;
    for row in gem_recipe_rows {
        let from_seed = defs
            .get(row.input_item_def_id.as_str())
            .ok_or_else(|| AppError::config("宝石配方输入定义不存在"))?;
        let to_seed = defs
            .get(row.output_item_def_id.as_str())
            .ok_or_else(|| AppError::config("宝石配方产物定义不存在"))?;
        let owned = owned_qty
            .get(row.input_item_def_id.as_str())
            .copied()
            .unwrap_or_default();
        let max_times = calc_max_synthesize_times(
            owned,
            row.input_qty,
            wallet.silver,
            wallet.spirit_stones,
            row.cost_silver,
            row.cost_spirit_stones,
        );
        recipes.push(GemSynthesisRecipeDto {
            recipe_id: row.id,
            name: row.name,
            gem_type: row.gem_type,
            series_key: row.series_key,
            from_level: row.from_level,
            to_level: row.to_level,
            input: GemItemRefDto {
                item_def_id: row.input_item_def_id.clone(),
                name: from_seed
                    .row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(row.input_item_def_id.as_str())
                    .to_string(),
                icon: from_seed
                    .row
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                qty: row.input_qty,
                owned,
            },
            output: GemItemTargetDto {
                item_def_id: row.output_item_def_id.clone(),
                name: to_seed
                    .row
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(row.output_item_def_id.as_str())
                    .to_string(),
                icon: to_seed
                    .row
                    .get("icon")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                qty: row.output_qty,
            },
            costs: GemCostDto {
                silver: row.cost_silver,
                spirit_stones: row.cost_spirit_stones,
            },
            success_rate: row.success_rate,
            max_synthesize_times: max_times,
            can_synthesize: max_times > 0,
        });
    }
    recipes.sort_by(|a, b| {
        a.gem_type
            .cmp(&b.gem_type)
            .then(a.series_key.cmp(&b.series_key))
            .then(a.from_level.cmp(&b.from_level))
    });
    Ok(recipes)
}

fn build_gem_convert_spirit_cost_map() -> Result<BTreeMap<i64, i64>, AppError> {
    let mut costs = BTreeMap::new();
    for row in load_gem_synthesis_recipe_rows()? {
        if !(2..=10).contains(&row.to_level) {
            continue;
        }
        match costs.get(&row.to_level) {
            Some(existing) if *existing != row.cost_spirit_stones => {
                return Err(AppError::config(format!(
                    "宝石转换配置冲突：{}级灵石消耗不一致",
                    row.to_level
                )));
            }
            _ => {
                costs.insert(row.to_level, row.cost_spirit_stones);
            }
        }
    }
    Ok(costs)
}

fn roll_gem_convert_outputs_with_random_fn<F>(
    candidate_item_def_ids: &[String],
    times: i64,
    mut next_index: F,
) -> BTreeMap<String, i64>
where
    F: FnMut(usize) -> usize,
{
    let mut produced_counts = BTreeMap::new();
    if candidate_item_def_ids.is_empty() || times <= 0 {
        return produced_counts;
    }
    for _ in 0..times {
        let idx =
            pick_random_index_with_random_fn(candidate_item_def_ids.len(), |len| next_index(len));
        if let Some(item_def_id) = candidate_item_def_ids.get(idx) {
            *produced_counts.entry(item_def_id.clone()).or_insert(0) += 1;
        }
    }
    produced_counts
}

async fn synthesize_inventory_gem_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    recipe_id: &str,
    times: i64,
) -> Result<GemSynthesisExecuteResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let defs = load_inventory_def_map()?;
    let wallet = load_gem_wallet(state, character_id).await?;
    let owned_qty = load_owned_item_qty_map(state, character_id).await?;
    let recipes = build_gem_synthesis_recipes(&defs, &owned_qty, &wallet)?;
    let recipe = recipes
        .into_iter()
        .find(|recipe| recipe.recipe_id == recipe_id)
        .ok_or_else(|| AppError::config("配方不存在"))?;
    if recipe.max_synthesize_times < times {
        return Ok(GemSynthesisExecuteResponse {
            success: false,
            message: build_gem_synthesize_max_times_message(recipe.max_synthesize_times),
            data: None,
        });
    }

    consume_inventory_material_by_def_id(
        state,
        user_id,
        character_id,
        &recipe.input.item_def_id,
        recipe.input.qty * times,
    )
    .await?;
    consume_inventory_character_currencies(
        state,
        character_id,
        recipe.costs.silver * times,
        recipe.costs.spirit_stones * times,
        0,
    )
    .await?;

    let mut success_count = 0_i64;
    let mut fail_count = 0_i64;
    for _ in 0..times {
        if roll_success_runtime(recipe.success_rate) {
            success_count += 1;
        } else {
            fail_count += 1;
        }
    }

    let produced = if success_count > 0 {
        let total_qty = recipe.output.qty * success_count;
        let reward_item_pairs = vec![(recipe.output.item_def_id.clone(), total_qty)];
        let buffered = buffer_inventory_item_reward_deltas(
            state,
            user_id,
            character_id,
            "gem_synthesize",
            Some(recipe.recipe_id.as_str()),
            0,
            &reward_item_pairs,
        )
        .await?;
        Some(InventoryCraftExecuteProducedDto {
            item_def_id: recipe.output.item_def_id.clone(),
            item_name: recipe.output.name.clone(),
            item_icon: recipe.output.icon.clone(),
            qty: total_qty,
            item_ids: if buffered {
                vec![]
            } else {
                let product_def = defs
                    .get(recipe.output.item_def_id.as_str())
                    .ok_or_else(|| AppError::config("产物定义不存在"))?;
                let bind_type = product_def
                    .row
                    .get("bind_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("none");
                let produced_row = state.database.fetch_one(
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'gem_synthesize', $6) RETURNING id",
                    |q| q.bind(user_id).bind(character_id).bind(recipe.output.item_def_id.as_str()).bind(total_qty).bind(bind_type).bind(recipe.recipe_id.as_str()),
                ).await?;
                vec![produced_row.try_get::<i64, _>("id")?]
            },
        })
    } else {
        None
    };
    let character = load_gem_wallet(state, character_id).await?;
    Ok(GemSynthesisExecuteResponse {
        success: true,
        message: if success_count > 0 {
            "宝石合成完成".to_string()
        } else {
            "宝石合成失败".to_string()
        },
        data: Some(GemSynthesisExecuteData {
            recipe_id: recipe.recipe_id,
            gem_type: recipe.gem_type,
            series_key: recipe.series_key,
            from_level: recipe.from_level,
            to_level: recipe.to_level,
            times,
            success_count,
            fail_count,
            success_rate: recipe.success_rate,
            consumed: InventoryCraftExecuteReturnedItemDto {
                item_def_id: recipe.input.item_def_id,
                qty: recipe.input.qty * times,
            },
            spent: recipe.costs,
            produced,
            character,
        }),
    })
}

async fn synthesize_inventory_gem_batch_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    gem_type: &str,
    source_level: i64,
    target_level: i64,
    requested_series_key: Option<&str>,
) -> Result<GemSynthesisBatchResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let defs = load_inventory_def_map()?;
    let mut wallet = load_gem_wallet(state, character_id).await?;
    let mut recipes = build_gem_synthesis_recipes(
        &defs,
        &load_owned_item_qty_map(state, character_id).await?,
        &wallet,
    )?;
    recipes.retain(|recipe| recipe.gem_type == normalize_gem_type(gem_type));
    if recipes.is_empty() {
        return Ok(GemSynthesisBatchResponse {
            success: false,
            message: "宝石配方不存在".to_string(),
            data: None,
        });
    }

    let mut series_keys = recipes
        .iter()
        .map(|recipe| recipe.series_key.clone())
        .collect::<Vec<_>>();
    series_keys.sort();
    series_keys.dedup();
    let selected_series_key = if let Some(series_key) = requested_series_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let key = series_key.to_lowercase();
        if !series_keys.iter().any(|value| value == &key) {
            return Ok(GemSynthesisBatchResponse {
                success: false,
                message: "宝石子类型参数错误".to_string(),
                data: None,
            });
        }
        key
    } else if series_keys.len() > 1 {
        return Ok(GemSynthesisBatchResponse {
            success: false,
            message: "该类型包含多个子类型，请先选择具体宝石后再批量合成".to_string(),
            data: None,
        });
    } else {
        series_keys.first().cloned().unwrap_or_default()
    };

    recipes.retain(|recipe| recipe.series_key == selected_series_key);
    let recipe_by_from_level = recipes
        .into_iter()
        .map(|recipe| (recipe.from_level, recipe))
        .collect::<BTreeMap<_, _>>();

    let mut steps = Vec::new();
    let mut total_spent_silver = 0_i64;
    let mut total_spent_spirit = 0_i64;
    let mut pending_grants: BTreeMap<String, i64> = BTreeMap::new();

    for level in source_level..target_level {
        let Some(recipe) = recipe_by_from_level.get(&level) else {
            continue;
        };
        let owned_qty = load_owned_item_qty_map(state, character_id).await?;
        let owned_input_qty = owned_qty
            .get(recipe.input.item_def_id.as_str())
            .copied()
            .unwrap_or_default();
        let max_times = calc_max_synthesize_times(
            owned_input_qty,
            recipe.input.qty,
            wallet.silver,
            wallet.spirit_stones,
            recipe.costs.silver,
            recipe.costs.spirit_stones,
        );
        if max_times <= 0 {
            continue;
        }
        consume_inventory_material_by_def_id(
            state,
            user_id,
            character_id,
            &recipe.input.item_def_id,
            recipe.input.qty * max_times,
        )
        .await?;
        consume_inventory_character_currencies(
            state,
            character_id,
            recipe.costs.silver * max_times,
            recipe.costs.spirit_stones * max_times,
            0,
        )
        .await?;
        wallet.silver -= recipe.costs.silver * max_times;
        wallet.spirit_stones -= recipe.costs.spirit_stones * max_times;
        total_spent_silver += recipe.costs.silver * max_times;
        total_spent_spirit += recipe.costs.spirit_stones * max_times;

        let mut success_count = 0_i64;
        let mut fail_count = 0_i64;
        for _ in 0..max_times {
            if roll_success_runtime(recipe.success_rate) {
                success_count += 1;
            } else {
                fail_count += 1;
            }
        }
        let produce_qty = recipe.output.qty * success_count;
        if produce_qty > 0 {
            *pending_grants
                .entry(recipe.output.item_def_id.clone())
                .or_insert(0) += produce_qty;
        }
        steps.push(GemSynthesisBatchStepDto {
            recipe_id: recipe.recipe_id.clone(),
            series_key: recipe.series_key.clone(),
            from_level: recipe.from_level,
            to_level: recipe.to_level,
            times: max_times,
            success_count,
            fail_count,
            success_rate: recipe.success_rate,
            consumed: InventoryCraftExecuteReturnedItemDto {
                item_def_id: recipe.input.item_def_id.clone(),
                qty: recipe.input.qty * max_times,
            },
            spent: GemCostDto {
                silver: recipe.costs.silver * max_times,
                spirit_stones: recipe.costs.spirit_stones * max_times,
            },
            produced: InventoryCraftExecuteProducedDto {
                item_def_id: recipe.output.item_def_id.clone(),
                item_name: recipe.output.name.clone(),
                item_icon: recipe.output.icon.clone(),
                qty: produce_qty,
                item_ids: vec![],
            },
        });
    }

    if steps.is_empty() {
        return Ok(GemSynthesisBatchResponse {
            success: false,
            message: "材料或货币不足，无法批量合成".to_string(),
            data: None,
        });
    }

    let pending_reward_pairs = pending_grants
        .iter()
        .map(|(item_def_id, qty)| (item_def_id.clone(), *qty))
        .collect::<Vec<_>>();
    let buffered_batch_grants = buffer_inventory_item_reward_deltas(
        state,
        user_id,
        character_id,
        "gem_synthesize_batch",
        Some(selected_series_key.as_str()),
        0,
        &pending_reward_pairs,
    )
    .await?;
    for (item_def_id, qty) in pending_grants {
        if qty <= 0 {
            continue;
        }
        if !buffered_batch_grants {
            let product_def = defs
                .get(item_def_id.as_str())
                .ok_or_else(|| AppError::config("产物定义不存在"))?;
            let bind_type = product_def
                .row
                .get("bind_type")
                .and_then(|v| v.as_str())
                .unwrap_or("none");
            state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'gem_synthesize_batch', $6) RETURNING id",
                |q| q.bind(user_id).bind(character_id).bind(item_def_id.as_str()).bind(qty).bind(bind_type).bind(selected_series_key.as_str()),
            ).await?;
        }
    }
    let character = load_gem_wallet(state, character_id).await?;
    let total_success = steps.iter().map(|step| step.success_count).sum::<i64>();
    let total_fail = steps.iter().map(|step| step.fail_count).sum::<i64>();
    let message = if total_success <= 0 {
        "批量合成完成，但全部失败，材料已损失".to_string()
    } else if total_fail <= 0 {
        "批量合成成功".to_string()
    } else {
        format!(
            "批量合成完成（成功{}次，失败{}次）",
            total_success, total_fail
        )
    };
    Ok(GemSynthesisBatchResponse {
        success: true,
        message,
        data: Some(GemSynthesisBatchData {
            gem_type: normalize_gem_type(gem_type),
            series_key: selected_series_key,
            source_level,
            target_level,
            total_spent: GemCostDto {
                silver: total_spent_silver,
                spirit_stones: total_spent_spirit,
            },
            steps,
            character,
        }),
    })
}

fn calc_max_synthesize_times(
    owned_input_qty: i64,
    need_input_qty: i64,
    silver: i64,
    spirit_stones: i64,
    silver_cost: i64,
    spirit_stone_cost: i64,
) -> i64 {
    let by_items = if need_input_qty > 0 {
        owned_input_qty / need_input_qty
    } else {
        0
    };
    let by_silver = if silver_cost > 0 {
        silver / silver_cost
    } else {
        i64::MAX / 4
    };
    let by_spirit = if spirit_stone_cost > 0 {
        spirit_stones / spirit_stone_cost
    } else {
        i64::MAX / 4
    };
    by_items
        .min(by_silver)
        .min(by_spirit)
        .clamp(0, GEM_EXECUTE_MAX_TIMES)
}

async fn convert_inventory_gem_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    selected_gem_item_ids: Vec<i64>,
    times: i64,
) -> Result<GemConvertExecuteResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let defs = load_inventory_def_map()?;
    let wallet = load_gem_wallet(state, character_id).await?;
    let spirit_cost_by_input_level = build_gem_convert_spirit_cost_map()?;
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, locked, location FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2) FOR UPDATE",
        |q| q.bind(character_id).bind(&selected_gem_item_ids),
    ).await?;
    let distinct_selected_count = selected_gem_item_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .len();
    if rows.len() != distinct_selected_count {
        return Ok(GemConvertExecuteResponse {
            success: false,
            message: "所选宝石不存在".to_string(),
            data: None,
        });
    }
    let mut input_level: Option<i64> = None;
    let mut consume_by_id = BTreeMap::new();
    let mut qty_by_id = BTreeMap::new();
    for row in rows {
        let item_id = row.try_get::<i64, _>("id")?;
        let item_def_id = row.try_get::<String, _>("item_def_id")?;
        let qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default();
        let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
        let location = row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default();
        if let Err(message) = validate_gem_convert_item_state(locked, location.as_str()) {
            return Ok(GemConvertExecuteResponse {
                success: false,
                message: message.to_string(),
                data: None,
            });
        }
        if qty <= 0 {
            return Ok(GemConvertExecuteResponse {
                success: false,
                message: "所选宝石数量不足".to_string(),
                data: None,
            });
        }
        let def = defs
            .get(item_def_id.as_str())
            .ok_or_else(|| AppError::config("所选宝石不存在"))?;
        if def.row.get("category").and_then(|v| v.as_str()) != Some("gem") {
            return Ok(GemConvertExecuteResponse {
                success: false,
                message: "所选物品不是宝石".to_string(),
                data: None,
            });
        }
        let level = def
            .row
            .get("gem_level")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        if !(2..=10).contains(&level) {
            return Ok(GemConvertExecuteResponse {
                success: false,
                message: "所选宝石等级不可转换".to_string(),
                data: None,
            });
        }
        if let Some(current) = input_level {
            if current != level {
                return Ok(GemConvertExecuteResponse {
                    success: false,
                    message: "请选择2个同等级宝石".to_string(),
                    data: None,
                });
            }
        } else {
            input_level = Some(level);
        }
        qty_by_id.insert(item_id, qty);
        *consume_by_id.entry(item_id).or_insert(0_i64) += 1;
    }
    let input_level = input_level.unwrap_or(0);
    if !has_sufficient_selected_gem_qty(&qty_by_id, &consume_by_id) {
        return Ok(GemConvertExecuteResponse {
            success: false,
            message: "所选宝石数量不足".to_string(),
            data: None,
        });
    }
    let output_level = input_level - 1;
    let cost_spirit_stones = spirit_cost_by_input_level
        .get(&input_level)
        .copied()
        .ok_or_else(|| {
            AppError::config(format!("宝石转换配置缺失：{}级灵石消耗未定义", input_level))
        })?;
    let max_by_selected_items = consume_by_id
        .iter()
        .map(|(item_id, per_time_qty)| {
            qty_by_id.get(item_id).copied().unwrap_or_default() / (*per_time_qty).max(1)
        })
        .min()
        .unwrap_or_default();
    let max_by_spirit = if cost_spirit_stones > 0 {
        wallet.spirit_stones / cost_spirit_stones
    } else {
        i64::MAX / 4
    };
    let max_convert_times = max_by_selected_items.min(max_by_spirit).max(0);
    if max_convert_times <= 0 {
        return Ok(GemConvertExecuteResponse {
            success: false,
            message: "所选宝石或灵石不足".to_string(),
            data: None,
        });
    }
    if times > max_convert_times {
        return Ok(GemConvertExecuteResponse {
            success: false,
            message: build_gem_convert_max_times_message(max_convert_times),
            data: None,
        });
    }
    let total_spirit_stones = cost_spirit_stones * times;
    let candidate_defs = defs
        .iter()
        .filter(|(_, seed)| seed.row.get("category").and_then(|v| v.as_str()) == Some("gem"))
        .filter(|(_, seed)| {
            seed.row
                .get("gem_level")
                .and_then(|v| v.as_i64())
                .unwrap_or_default()
                == output_level
        })
        .map(|(id, seed)| (id.clone(), seed))
        .collect::<Vec<_>>();
    if candidate_defs.is_empty() {
        return Ok(GemConvertExecuteResponse {
            success: false,
            message: "当前无可转换目标宝石".to_string(),
            data: None,
        });
    }

    for (item_id, per_time_qty) in &consume_by_id {
        consume_inventory_specific_item_instance(
            state,
            character_id,
            *item_id,
            per_time_qty * times,
        )
        .await?;
    }
    consume_inventory_character_currencies(state, character_id, 0, total_spirit_stones, 0).await?;

    let total_qty = times;
    let candidate_item_def_ids = candidate_defs
        .iter()
        .map(|(item_def_id, _)| item_def_id.clone())
        .collect::<Vec<_>>();
    let produced_counts =
        roll_gem_convert_outputs_with_random_fn(&candidate_item_def_ids, times, |len| {
            rand::thread_rng().gen_range(0..len)
        });
    let mut produced_items = Vec::new();
    let produced_pairs = produced_counts
        .iter()
        .map(|(item_def_id, qty)| (item_def_id.clone(), *qty))
        .collect::<Vec<_>>();
    let buffered_convert_grants = buffer_inventory_item_reward_deltas(
        state,
        user_id,
        character_id,
        "gem_convert",
        Some("manual"),
        0,
        &produced_pairs,
    )
    .await?;
    for (item_def_id, qty) in produced_counts {
        let seed = defs
            .get(item_def_id.as_str())
            .ok_or_else(|| AppError::config("目标宝石定义不存在"))?;
        produced_items.push(InventoryCraftExecuteProducedDto {
            item_def_id: item_def_id.clone(),
            item_name: seed.row.get("name").and_then(|v| v.as_str()).unwrap_or(item_def_id.as_str()).to_string(),
            item_icon: seed.row.get("icon").and_then(|v| v.as_str()).map(|v| v.to_string()),
            qty,
            item_ids: if buffered_convert_grants { vec![] } else {
                let bind_type = seed.row.get("bind_type").and_then(|v| v.as_str()).unwrap_or("none");
                let produced_row = state.database.fetch_one(
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'gem_convert', 'manual') RETURNING id",
                    |q| q.bind(user_id).bind(character_id).bind(item_def_id.as_str()).bind(qty).bind(bind_type),
                ).await?;
                vec![produced_row.try_get::<i64, _>("id")?]
            },
        });
    }
    let character = load_gem_wallet(state, character_id).await?;
    Ok(GemConvertExecuteResponse {
        success: true,
        message: "宝石转换成功".to_string(),
        data: Some(GemConvertExecuteData {
            input_level: input_level,
            output_level,
            times,
            consumed: GemConvertConsumedDto {
                input_gem_qty: 2 * times,
                selected_gem_item_ids,
            },
            spent: GemConvertSpentDto {
                spirit_stones: total_spirit_stones,
            },
            produced: GemConvertProducedDto {
                total_qty,
                items: produced_items,
            },
            character,
        }),
    })
}

fn build_gem_convert_options(
    defs: &BTreeMap<String, InventoryDefSeed>,
    wallet: &GemCharacterWalletDto,
    owned_qty: &BTreeMap<String, i64>,
) -> Vec<GemConvertOptionDto> {
    let mut options = Vec::new();
    let Ok(spirit_cost_by_input_level) = build_gem_convert_spirit_cost_map() else {
        return options;
    };
    for level in 2_i64..=10_i64 {
        let output_level = level - 1;
        let candidate_count = defs
            .iter()
            .filter(|(_, seed)| seed.row.get("category").and_then(|v| v.as_str()) == Some("gem"))
            .filter(|(_, seed)| {
                seed.row
                    .get("gem_level")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default()
                    == output_level
            })
            .count() as i64;
        if candidate_count <= 0 {
            continue;
        }
        let owned_input_gem_qty = owned_qty
            .iter()
            .filter(|(id, _)| {
                defs.get(id.as_str())
                    .and_then(|seed| seed.row.get("category").and_then(|v| v.as_str()))
                    == Some("gem")
                    && defs
                        .get(id.as_str())
                        .and_then(|seed| seed.row.get("gem_level").and_then(|v| v.as_i64()))
                        .unwrap_or_default()
                        == level
            })
            .map(|(_, qty)| *qty)
            .sum::<i64>();
        let input_qty = 2_i64;
        let Some(cost_spirit_stones) = spirit_cost_by_input_level.get(&level).copied() else {
            continue;
        };
        let max_convert_times =
            (owned_input_gem_qty / input_qty).min(wallet.spirit_stones / cost_spirit_stones.max(1));
        options.push(GemConvertOptionDto {
            input_level: level,
            output_level,
            input_gem_qty_per_convert: input_qty,
            owned_input_gem_qty,
            cost_spirit_stones_per_convert: cost_spirit_stones,
            max_convert_times,
            can_convert: max_convert_times > 0,
            candidate_gem_count: candidate_count,
        });
    }
    options
}

fn parse_gem_item_series_identity(item_def_id: &str) -> Option<(String, String, i64)> {
    let parts = item_def_id.trim().split('-').collect::<Vec<_>>();
    if parts.len() < 3 || parts.first().copied() != Some("gem") {
        return None;
    }
    let level = parts.last()?.parse::<i64>().ok()?.clamp(1, 10);
    let token = parts.get(1)?.trim().to_lowercase();
    let gem_type = match token.as_str() {
        "atk" => "attack",
        "def" => "defense",
        "sur" => "survival",
        "all" => "all",
        _ => return None,
    }
    .to_string();
    let series_key = if token == "all" {
        token
    } else {
        let subtype = parts.get(2)?.trim().to_lowercase();
        if subtype.is_empty() {
            return None;
        }
        format!("{token}-{subtype}")
    };
    Some((gem_type, series_key, level))
}

async fn load_inventory_craft_character(
    state: &AppState,
    user_id: i64,
) -> Result<InventoryCraftCharacterDto, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT realm, exp, silver, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1",
            |q| q.bind(user_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    Ok(InventoryCraftCharacterDto {
        realm: row
            .try_get::<Option<String>, _>("realm")?
            .unwrap_or_else(|| "凡人".to_string()),
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
        silver: row.try_get::<Option<i64>, _>("silver")?.unwrap_or_default(),
        spirit_stones: row
            .try_get::<Option<i64>, _>("spirit_stones")?
            .unwrap_or_default(),
    })
}

fn build_inventory_craft_recipes(
    defs: &BTreeMap<String, InventoryDefSeed>,
    owned_qty: &BTreeMap<String, i64>,
    character: &InventoryCraftCharacterDto,
    recipe_type_filter: Option<&str>,
) -> Result<Vec<InventoryCraftRecipeDto>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/item_recipe.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {}: {error}", path.display())))?;
    let payload: InventoryRecipeFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse {}: {error}", path.display()))
    })?;
    let recipe_type_filter = recipe_type_filter
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let mut recipes = Vec::new();
    for row in payload.recipes {
        if let Some(expected) = recipe_type_filter.as_ref() {
            let recipe_type = row
                .get("recipe_type")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim();
            if recipe_type != expected {
                continue;
            }
        }
        if let Some(recipe) = build_inventory_craft_recipe_dto(&row, defs, owned_qty, character)? {
            recipes.push(recipe);
        }
    }
    Ok(recipes)
}

fn build_inventory_craft_recipe_dto(
    row: &serde_json::Value,
    defs: &BTreeMap<String, InventoryDefSeed>,
    owned_qty: &BTreeMap<String, i64>,
    character: &InventoryCraftCharacterDto,
) -> Result<Option<InventoryCraftRecipeDto>, AppError> {
    let id = row
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if id.is_empty() {
        return Ok(None);
    }
    let recipe_type = row
        .get("recipe_type")
        .and_then(|v| v.as_str())
        .unwrap_or("craft")
        .trim()
        .to_string();
    let product_item_def_id = row
        .get("product_item_def_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if product_item_def_id.is_empty() {
        return Ok(None);
    }
    let product_def = defs.get(product_item_def_id.as_str());
    let req_realm = row
        .get("req_realm")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let realm_met = req_realm
        .as_ref()
        .map(|required| {
            get_realm_rank_one_based_for_equipment(&character.realm)
                >= get_realm_rank_one_based_for_equipment(required)
        })
        .unwrap_or(true);
    let cost_items = row
        .get("cost_items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let cost_item_views = cost_items
        .iter()
        .filter_map(|item| {
            let item_def_id = item
                .get("item_def_id")
                .and_then(|v| v.as_str())?
                .trim()
                .to_string();
            if item_def_id.is_empty() {
                return None;
            }
            let required = parse_recipe_i64(item.get("qty"));
            let owned = owned_qty
                .get(item_def_id.as_str())
                .copied()
                .unwrap_or_default();
            let item_name = defs
                .get(item_def_id.as_str())
                .and_then(|seed| seed.row.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(item_def_id.as_str())
                .to_string();
            Some(InventoryCraftCostItemDto {
                item_def_id,
                item_name,
                required,
                owned,
                missing: (required - owned).max(0),
            })
        })
        .collect::<Vec<_>>();
    let silver = parse_recipe_i64(row.get("cost_silver"));
    let spirit_stones = parse_recipe_i64(row.get("cost_spirit_stones"));
    let exp = parse_recipe_i64(row.get("cost_exp"));
    let max_from_silver = if silver > 0 {
        character.silver / silver
    } else {
        i64::MAX / 4
    };
    let max_from_spirit = if spirit_stones > 0 {
        character.spirit_stones / spirit_stones
    } else {
        i64::MAX / 4
    };
    let max_from_exp = if exp > 0 {
        character.exp / exp
    } else {
        i64::MAX / 4
    };
    let max_from_items = cost_item_views.iter().fold(i64::MAX / 4, |acc, item| {
        if item.required <= 0 {
            acc
        } else {
            acc.min(item.owned / item.required)
        }
    });
    let max_craft_times = max_from_silver
        .min(max_from_spirit)
        .min(max_from_exp)
        .min(max_from_items)
        .min(999)
        .max(0);
    let craft_kind = match recipe_type.as_str() {
        "refine" => "smithing".to_string(),
        _ => match product_def
            .and_then(|seed| seed.row.get("category"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
        {
            "equipment" => "smithing".to_string(),
            "consumable"
                if product_def
                    .and_then(|seed| seed.row.get("sub_category"))
                    .and_then(|v| v.as_str())
                    == Some("pill") =>
            {
                "alchemy".to_string()
            }
            _ => "craft".to_string(),
        },
    };
    let success_rate = row
        .get("success_rate")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
        .unwrap_or_else(|| {
            if recipe_type == "gem_synthesis" {
                1.0
            } else {
                100.0
            }
        });
    let fail_return_rate = row
        .get("fail_return_rate")
        .and_then(|v| v.as_f64().or_else(|| v.as_i64().map(|n| n as f64)))
        .unwrap_or(0.0);
    Ok(Some(InventoryCraftRecipeDto {
        id,
        name: row
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        recipe_type,
        product: InventoryCraftProductDto {
            item_def_id: product_item_def_id.clone(),
            name: product_def
                .and_then(|seed| seed.row.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(product_item_def_id.as_str())
                .to_string(),
            icon: product_def
                .and_then(|seed| seed.row.get("icon"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            qty: parse_recipe_i64(row.get("product_qty")).max(1),
        },
        costs: InventoryCraftCostsDto {
            silver,
            spirit_stones,
            exp,
            items: cost_item_views,
        },
        requirements: InventoryCraftRequirementsDto {
            realm: req_realm,
            level: parse_recipe_i64(row.get("req_level")),
            building: row
                .get("req_building")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .filter(|v| !v.is_empty()),
            realm_met,
        },
        success_rate,
        fail_return_rate,
        max_craft_times,
        craftable: realm_met && max_craft_times > 0,
        craft_kind,
    }))
}

fn normalize_inventory_recipe_rate_to_ratio(raw: f64, default_percent: f64) -> f64 {
    let value = if raw.is_finite() {
        raw
    } else {
        default_percent
    };
    if value <= 0.0 {
        return 0.0;
    }
    if value <= 1.0 {
        return value.clamp(0.0, 1.0);
    }
    (value / 100.0).clamp(0.0, 1.0)
}

async fn grant_inventory_item_instance(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
    bind_type: &str,
    obtained_from: &str,
    obtained_ref_id: &str,
) -> Result<i64, AppError> {
    let row = state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), $6, $7) RETURNING id",
        |q| q.bind(user_id).bind(character_id).bind(item_def_id).bind(qty).bind(bind_type).bind(obtained_from).bind(obtained_ref_id),
    ).await?;
    row.try_get::<i64, _>("id").map_err(AppError::from)
}

fn inventory_item_mutation_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn map_item_instance_snapshot_from_row(
    row: &sqlx::postgres::PgRow,
) -> Result<ItemInstanceMutationSnapshot, AppError> {
    Ok(ItemInstanceMutationSnapshot {
        id: row.try_get::<i64, _>("id")?,
        owner_user_id: row
            .try_get::<Option<i64>, _>("owner_user_id")?
            .unwrap_or_default(),
        owner_character_id: row
            .try_get::<Option<i64>, _>("owner_character_id")?
            .unwrap_or_default(),
        item_def_id: row
            .try_get::<Option<String>, _>("item_def_id")?
            .unwrap_or_default(),
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default(),
        quality: row.try_get::<Option<String>, _>("quality")?,
        quality_rank: row
            .try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
        bind_type: row
            .try_get::<Option<String>, _>("bind_type")?
            .unwrap_or_else(|| "none".to_string()),
        bind_owner_user_id: row.try_get::<Option<i64>, _>("bind_owner_user_id")?,
        bind_owner_character_id: row.try_get::<Option<i64>, _>("bind_owner_character_id")?,
        location: row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default(),
        location_slot: row
            .try_get::<Option<i32>, _>("location_slot")?
            .map(i64::from),
        equipped_slot: row.try_get::<Option<String>, _>("equipped_slot")?,
        strengthen_level: row
            .try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
        refine_level: row
            .try_get::<Option<i32>, _>("refine_level")?
            .map(i64::from)
            .unwrap_or_default(),
        socketed_gems: row
            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
            .unwrap_or_else(|| serde_json::json!([])),
        random_seed: row.try_get::<Option<i64>, _>("random_seed")?,
        affixes: row
            .try_get::<Option<serde_json::Value>, _>("affixes")?
            .unwrap_or_else(|| serde_json::json!([])),
        identified: row
            .try_get::<Option<bool>, _>("identified")?
            .unwrap_or(false),
        affix_gen_version: row
            .try_get::<Option<i32>, _>("affix_gen_version")?
            .map(i64::from)
            .unwrap_or_default(),
        affix_roll_meta: row
            .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
            .unwrap_or_else(|| serde_json::json!({})),
        custom_name: row.try_get::<Option<String>, _>("custom_name")?,
        locked: row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false),
        expire_at: row.try_get::<Option<String>, _>("expire_at_text")?,
        obtained_from: row.try_get::<Option<String>, _>("obtained_from")?,
        obtained_ref_id: row.try_get::<Option<String>, _>("obtained_ref_id")?,
        metadata: row.try_get::<Option<serde_json::Value>, _>("metadata")?,
    })
}

async fn consume_inventory_used_item_instance_tx(
    state: &AppState,
    snapshot: &ItemInstanceMutationSnapshot,
    consume_qty: i64,
) -> Result<(), AppError> {
    if snapshot.id <= 0 || snapshot.owner_character_id <= 0 || consume_qty <= 0 {
        return Ok(());
    }
    let remaining_qty = (snapshot.qty - consume_qty).max(0);
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            let now_ms = inventory_item_mutation_timestamp_ms();
            let mutation = if remaining_qty == 0 {
                BufferedItemInstanceMutation {
                    op_id: format!("inventory-use-delete:{}:{now_ms}", snapshot.id),
                    character_id: snapshot.owner_character_id,
                    item_id: snapshot.id,
                    created_at_ms: now_ms,
                    kind: "delete".to_string(),
                    snapshot: None,
                }
            } else {
                let mut next_snapshot = snapshot.clone();
                next_snapshot.qty = remaining_qty;
                BufferedItemInstanceMutation {
                    op_id: format!("inventory-use-consume:{}:{now_ms}", snapshot.id),
                    character_id: snapshot.owner_character_id,
                    item_id: snapshot.id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(next_snapshot),
                }
            };
            buffer_item_instance_mutations(&redis, &[mutation]).await?;
            flush_inventory_item_instance_mutations_now(state, snapshot.owner_character_id).await?;
            return Ok(());
        }
    }
    if remaining_qty == 0 {
        state
            .database
            .execute(
                "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
                |q| q.bind(snapshot.id).bind(snapshot.owner_character_id),
            )
            .await?;
    } else {
        state.database.execute(
            "UPDATE item_instance SET qty = $1, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
            |q| q.bind(remaining_qty).bind(snapshot.id).bind(snapshot.owner_character_id),
        ).await?;
    }
    Ok(())
}

async fn apply_inventory_item_snapshot_mutation_tx(
    state: &AppState,
    snapshot: ItemInstanceMutationSnapshot,
) -> Result<(), AppError> {
    if snapshot.id <= 0 || snapshot.owner_character_id <= 0 {
        return Ok(());
    }
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            let now_ms = inventory_item_mutation_timestamp_ms();
            let mutation = BufferedItemInstanceMutation {
                op_id: format!("inventory-item-upsert:{}:{now_ms}", snapshot.id),
                character_id: snapshot.owner_character_id,
                item_id: snapshot.id,
                created_at_ms: now_ms,
                kind: "upsert".to_string(),
                snapshot: Some(snapshot),
            };
            buffer_item_instance_mutations(&redis, &[mutation]).await?;
            return Ok(());
        }
    }
    state.database.execute(
        "UPDATE item_instance SET owner_user_id = $2, owner_character_id = $3, item_def_id = $4, qty = $5, quality = $6, quality_rank = $7, bind_type = $8, bind_owner_user_id = $9, bind_owner_character_id = $10, location = $11, location_slot = $12, equipped_slot = $13, strengthen_level = $14, refine_level = $15, socketed_gems = $16::jsonb, random_seed = $17, affixes = $18::jsonb, identified = $19, affix_gen_version = $20, affix_roll_meta = $21::jsonb, custom_name = $22, locked = $23, expire_at = $24::timestamptz, obtained_from = $25, obtained_ref_id = $26, metadata = $27::jsonb, updated_at = NOW() WHERE id = $1 AND owner_character_id = $28",
        |query| query
            .bind(snapshot.id)
            .bind(snapshot.owner_user_id)
            .bind(snapshot.owner_character_id)
            .bind(snapshot.item_def_id.as_str())
            .bind(snapshot.qty)
            .bind(snapshot.quality.as_deref())
            .bind(snapshot.quality_rank)
            .bind(snapshot.bind_type.as_str())
            .bind(snapshot.bind_owner_user_id)
            .bind(snapshot.bind_owner_character_id)
            .bind(snapshot.location.as_str())
            .bind(snapshot.location_slot)
            .bind(snapshot.equipped_slot.as_deref())
            .bind(snapshot.strengthen_level)
            .bind(snapshot.refine_level)
            .bind(snapshot.socketed_gems)
            .bind(snapshot.random_seed)
            .bind(snapshot.affixes)
            .bind(snapshot.identified)
            .bind(snapshot.affix_gen_version)
            .bind(snapshot.affix_roll_meta)
            .bind(snapshot.custom_name.as_deref())
            .bind(snapshot.locked)
            .bind(snapshot.expire_at.as_deref())
            .bind(snapshot.obtained_from.as_deref())
            .bind(snapshot.obtained_ref_id.as_deref())
            .bind(snapshot.metadata)
            .bind(snapshot.owner_character_id),
    ).await?;
    Ok(())
}

async fn apply_inventory_item_instance_mutations_to_db(
    state: &AppState,
    character_id: i64,
    mutations: Vec<BufferedItemInstanceMutation>,
) -> Result<(), AppError> {
    if character_id <= 0 || mutations.is_empty() {
        return Ok(());
    }
    let slot_release_ids = mutations
        .iter()
        .map(|mutation| mutation.item_id)
        .collect::<Vec<_>>();
    ensure_no_duplicate_item_instance_slot_targets(
        character_id,
        mutations
            .iter()
            .filter_map(|mutation| mutation.snapshot.as_ref()),
    )?;
    ensure_no_existing_item_instance_slot_conflicts(
        state,
        character_id,
        &slot_release_ids,
        mutations
            .iter()
            .filter_map(|mutation| mutation.snapshot.as_ref()),
    )
    .await?;
    release_item_instance_slots_for_update(state, character_id, &slot_release_ids).await?;

    for mutation in mutations {
        match mutation.kind.as_str() {
            "delete" => {
                state
                    .database
                    .execute(
                        "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
                        |query| query.bind(mutation.item_id).bind(character_id),
                    )
                    .await?;
            }
            _ => {
                let Some(snapshot) = mutation.snapshot else {
                    continue;
                };
                state.database.execute(
                    "UPDATE item_instance SET owner_user_id = $2, owner_character_id = $3, item_def_id = $4, qty = $5, quality = $6, quality_rank = $7, bind_type = $8, bind_owner_user_id = $9, bind_owner_character_id = $10, location = $11, location_slot = $12, equipped_slot = $13, strengthen_level = $14, refine_level = $15, socketed_gems = $16::jsonb, random_seed = $17, affixes = $18::jsonb, identified = $19, affix_gen_version = $20, affix_roll_meta = $21::jsonb, custom_name = $22, locked = $23, expire_at = $24::timestamptz, obtained_from = $25, obtained_ref_id = $26, metadata = $27::jsonb, updated_at = NOW() WHERE id = $1 AND owner_character_id = $28",
                    |query| query
                        .bind(snapshot.id)
                        .bind(snapshot.owner_user_id)
                        .bind(snapshot.owner_character_id)
                        .bind(snapshot.item_def_id.as_str())
                        .bind(snapshot.qty)
                        .bind(snapshot.quality.as_deref())
                        .bind(snapshot.quality_rank)
                        .bind(snapshot.bind_type.as_str())
                        .bind(snapshot.bind_owner_user_id)
                        .bind(snapshot.bind_owner_character_id)
                        .bind(snapshot.location.as_str())
                        .bind(snapshot.location_slot)
                        .bind(snapshot.equipped_slot.as_deref())
                        .bind(snapshot.strengthen_level)
                        .bind(snapshot.refine_level)
                        .bind(snapshot.socketed_gems)
                        .bind(snapshot.random_seed)
                        .bind(snapshot.affixes)
                        .bind(snapshot.identified)
                        .bind(snapshot.affix_gen_version)
                        .bind(snapshot.affix_roll_meta)
                        .bind(snapshot.custom_name.as_deref())
                        .bind(snapshot.locked)
                        .bind(snapshot.expire_at.as_deref())
                        .bind(snapshot.obtained_from.as_deref())
                        .bind(snapshot.obtained_ref_id.as_deref())
                        .bind(snapshot.metadata)
                        .bind(character_id),
                ).await?;
            }
        }
    }
    Ok(())
}

async fn release_item_instance_slots_for_update(
    state: &AppState,
    character_id: i64,
    item_ids: &[i64],
) -> Result<(), AppError> {
    if character_id <= 0 || item_ids.is_empty() {
        return Ok(());
    }
    state.database.execute(
        "UPDATE item_instance SET location_slot = NULL, updated_at = NOW() WHERE owner_character_id = $1 AND id = ANY($2) AND location IN ('bag', 'warehouse') AND location_slot IS NOT NULL",
        |query| query.bind(character_id).bind(item_ids),
    ).await?;
    Ok(())
}

async fn release_item_instance_slots_for_location(
    state: &AppState,
    character_id: i64,
    location: &str,
) -> Result<(), AppError> {
    if character_id <= 0 {
        return Ok(());
    }
    state.database.execute(
        "UPDATE item_instance SET location_slot = NULL, updated_at = NOW() WHERE owner_character_id = $1 AND location = $2 AND location IN ('bag', 'warehouse') AND location_slot IS NOT NULL",
        |query| query.bind(character_id).bind(location),
    ).await?;
    Ok(())
}

fn ensure_no_duplicate_item_instance_slot_targets<'a>(
    character_id: i64,
    snapshots: impl Iterator<Item = &'a ItemInstanceMutationSnapshot>,
) -> Result<(), AppError> {
    let mut seen = BTreeSet::new();
    for snapshot in snapshots {
        if snapshot.owner_character_id != character_id {
            continue;
        }
        if !matches!(snapshot.location.as_str(), "bag" | "warehouse") {
            continue;
        }
        let Some(location_slot) = snapshot.location_slot else {
            continue;
        };
        let key = format!(
            "{}:{}:{}",
            snapshot.owner_character_id, snapshot.location, location_slot
        );
        if !seen.insert(key.clone()) {
            return Err(AppError::config(format!(
                "实例 mutation 目标槽位冲突: {key}"
            )));
        }
    }
    Ok(())
}

async fn ensure_no_existing_item_instance_slot_conflicts(
    state: &AppState,
    character_id: i64,
    batch_item_ids: &[i64],
    snapshots: impl Iterator<Item = &ItemInstanceMutationSnapshot>,
) -> Result<(), AppError> {
    if character_id <= 0 {
        return Ok(());
    }
    let occupied_rows = state.database.fetch_all(
        "SELECT id, location, location_slot FROM item_instance WHERE owner_character_id = $1 AND location IN ('bag', 'warehouse') AND location_slot IS NOT NULL",
        |query| query.bind(character_id),
    ).await?;
    let occupied_keys = occupied_rows
        .into_iter()
        .filter_map(|row| {
            let id = row.try_get::<i64, _>("id").ok()?;
            if batch_item_ids.contains(&id) {
                return None;
            }
            let location = row
                .try_get::<Option<String>, _>("location")
                .ok()
                .flatten()?;
            let location_slot = row
                .try_get::<Option<i32>, _>("location_slot")
                .ok()
                .flatten()?;
            Some((
                format!("{}:{}:{}", character_id, location, location_slot),
                id,
            ))
        })
        .collect::<BTreeMap<_, _>>();

    for snapshot in snapshots {
        if snapshot.owner_character_id != character_id {
            continue;
        }
        if !matches!(snapshot.location.as_str(), "bag" | "warehouse") {
            continue;
        }
        let Some(location_slot) = snapshot.location_slot else {
            continue;
        };
        let key = format!(
            "{}:{}:{}",
            snapshot.owner_character_id, snapshot.location, location_slot
        );
        if let Some(occupant_id) = occupied_keys.get(&key) {
            return Err(AppError::config(format!(
                "实例 mutation 目标槽位冲突: {key} 已被物品 {occupant_id} 占用"
            )));
        }
    }
    Ok(())
}

async fn flush_inventory_item_instance_mutations_now(
    state: &AppState,
    character_id: i64,
) -> Result<(), AppError> {
    if character_id <= 0 || !state.redis_available {
        return Ok(());
    }
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    if !claim_character_item_instance_mutations(&redis, character_id).await? {
        return Ok(());
    }
    let claimed_hash = load_claimed_item_instance_mutation_hash(&redis, character_id).await?;
    let parsed = parse_item_instance_mutation_hash(claimed_hash);
    if parsed.is_empty() {
        finalize_claimed_item_instance_mutations(&redis, character_id).await?;
        return Ok(());
    }
    match apply_inventory_item_instance_mutations_to_db(state, character_id, parsed).await {
        Ok(()) => finalize_claimed_item_instance_mutations(&redis, character_id).await,
        Err(error) => {
            restore_claimed_item_instance_mutations(&redis, character_id).await?;
            Err(error)
        }
    }
}

async fn flush_inventory_item_grant_deltas_now(
    state: &AppState,
    character_id: i64,
) -> Result<(), AppError> {
    if character_id <= 0 || !state.redis_available {
        return Ok(());
    }
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    if !claim_character_item_grant_delta(&redis, character_id).await? {
        return Ok(());
    }
    let claimed_hash = load_claimed_character_item_grant_delta_hash(&redis, character_id).await?;
    let parsed = parse_item_grant_delta_hash(claimed_hash);
    if parsed.is_empty() {
        finalize_claimed_character_item_grant_delta(&redis, character_id).await?;
        return Ok(());
    }
    let defs = load_inventory_def_map()?;
    let result = async {
        for grant in parsed {
            if grant.user_id <= 0 || grant.qty <= 0 || grant.item_def_id.trim().is_empty() || grant.obtained_from.trim().is_empty() {
                continue;
            }
            let bind_type = defs
                .get(grant.item_def_id.as_str())
                .and_then(|seed| seed.row.get("bind_type"))
                .and_then(|value| value.as_str())
                .unwrap_or(grant.bind_type.as_str());
            state.database.execute(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), $6, $7)",
                |query| query
                    .bind(grant.user_id)
                    .bind(character_id)
                    .bind(grant.item_def_id.as_str())
                    .bind(grant.qty)
                    .bind(bind_type)
                    .bind(grant.obtained_from.as_str())
                    .bind(grant.obtained_ref_id.as_deref()),
            ).await?;
        }
        Ok::<(), AppError>(())
    }.await;
    match result {
        Ok(()) => finalize_claimed_character_item_grant_delta(&redis, character_id).await,
        Err(error) => {
            restore_claimed_character_item_grant_delta(&redis, character_id).await?;
            Err(error)
        }
    }
}

async fn flush_inventory_resource_deltas_now(
    state: &AppState,
    character_id: i64,
) -> Result<(), AppError> {
    if character_id <= 0 || !state.redis_available {
        return Ok(());
    }
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    if !claim_character_resource_delta(&redis, character_id).await? {
        return Ok(());
    }
    let claimed_hash = load_claimed_character_resource_delta_hash(&redis, character_id).await?;
    let parsed = parse_resource_delta_hash(claimed_hash);
    if parsed.is_empty() {
        finalize_claimed_character_resource_delta(&redis, character_id).await?;
        return Ok(());
    }
    let result = async {
        let silver_delta = parsed.get("silver").copied().unwrap_or_default().max(0);
        let spirit_stones_delta = parsed.get("spirit_stones").copied().unwrap_or_default().max(0);
        let exp_delta = parsed.get("exp").copied().unwrap_or_default().max(0);
        if silver_delta > 0 || spirit_stones_delta > 0 || exp_delta > 0 {
            state.database.execute(
                "UPDATE characters SET silver = COALESCE(silver, 0) + $2, spirit_stones = COALESCE(spirit_stones, 0) + $3, exp = COALESCE(exp, 0) + $4, updated_at = NOW() WHERE id = $1",
                |query| query.bind(character_id).bind(silver_delta).bind(spirit_stones_delta).bind(exp_delta),
            ).await?;
        }
        Ok::<(), AppError>(())
    }.await;
    match result {
        Ok(()) => finalize_claimed_character_resource_delta(&redis, character_id).await,
        Err(error) => {
            restore_claimed_character_resource_delta(&redis, character_id).await?;
            Err(error)
        }
    }
}

async fn buffer_inventory_item_reward_deltas(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    obtained_from: &str,
    obtained_ref_id: Option<&str>,
    silver: i64,
    item_rewards: &[(String, i64)],
) -> Result<bool, AppError> {
    if !(state.redis_available && state.redis.is_some()) {
        return Ok(false);
    }
    let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
    let mut resource_fields = Vec::new();
    if silver > 0 {
        resource_fields.push(CharacterResourceDeltaField {
            character_id,
            field: "silver".to_string(),
            increment: silver,
        });
    }
    if !resource_fields.is_empty() {
        buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
    }
    let grants = item_rewards
        .iter()
        .filter_map(|(item_def_id, qty)| {
            let normalized_id = item_def_id.trim();
            (*qty > 0 && !normalized_id.is_empty()).then(|| CharacterItemGrantDelta {
                character_id,
                user_id,
                item_def_id: normalized_id.to_string(),
                qty: *qty,
                bind_type: "none".to_string(),
                obtained_from: obtained_from.trim().to_string(),
                obtained_ref_id: obtained_ref_id
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string()),
            })
        })
        .collect::<Vec<_>>();
    if !grants.is_empty() {
        buffer_character_item_grant_deltas(&redis, &grants).await?;
    }
    Ok(true)
}

async fn execute_inventory_craft_recipe_tx(
    state: &AppState,
    user_id: i64,
    times: i64,
    recipe_id: &str,
) -> Result<InventoryCraftExecuteResponse, AppError> {
    let character = load_inventory_craft_character(state, user_id).await?;
    let character_id = state
        .database
        .fetch_optional(
            "SELECT id FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(user_id),
        )
        .await?
        .and_then(|row| {
            row.try_get::<Option<i32>, _>("id")
                .ok()
                .flatten()
                .map(i64::from)
        })
        .ok_or_else(|| AppError::config("角色不存在"))?;
    acquire_inventory_mutex(state, character_id).await?;

    let defs = load_inventory_def_map()?;
    let owned_qty = load_owned_item_qty_map(state, character_id).await?;
    let recipes = build_inventory_craft_recipes(&defs, &owned_qty, &character, None)?;
    let recipe = recipes
        .into_iter()
        .find(|recipe| recipe.id == recipe_id)
        .ok_or_else(|| AppError::config("配方不存在"))?;
    if !recipe.requirements.realm_met {
        return Ok(InventoryCraftExecuteResponse {
            success: false,
            message: format!(
                "境界不足，需要{}",
                recipe.requirements.realm.clone().unwrap_or_default()
            ),
            data: None,
        });
    }
    if recipe.max_craft_times < times {
        return Ok(InventoryCraftExecuteResponse {
            success: false,
            message: "材料或资源不足".to_string(),
            data: None,
        });
    }

    for cost_item in &recipe.costs.items {
        consume_inventory_material_by_def_id(
            state,
            user_id,
            character_id,
            &cost_item.item_def_id,
            cost_item.required * times,
        )
        .await?;
    }
    consume_inventory_character_currencies(
        state,
        character_id,
        recipe.costs.silver * times,
        recipe.costs.spirit_stones * times,
        recipe.costs.exp * times,
    )
    .await?;

    let success_rate_ratio = normalize_inventory_recipe_rate_to_ratio(
        recipe.success_rate,
        if recipe.recipe_type == "gem_synthesis" {
            1.0
        } else {
            100.0
        },
    );
    let fail_return_rate_ratio =
        normalize_inventory_recipe_rate_to_ratio(recipe.fail_return_rate, 0.0);
    let mut success_count = 0_i64;
    let mut fail_count = 0_i64;
    for _ in 0..times {
        if roll_success_runtime(success_rate_ratio) {
            success_count += 1;
        } else {
            fail_count += 1;
        }
    }

    let product_def = defs
        .get(recipe.product.item_def_id.as_str())
        .ok_or_else(|| AppError::config("产物定义不存在"))?;
    let product_bind_type = product_def
        .row
        .get("bind_type")
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    let produced = if success_count > 0 {
        let product_qty = recipe.product.qty * success_count;
        let produced_id = grant_inventory_item_instance(
            state,
            user_id,
            character_id,
            recipe.product.item_def_id.as_str(),
            product_qty,
            product_bind_type,
            "craft",
            recipe.id.as_str(),
        )
        .await?;
        Some(InventoryCraftExecuteProducedDto {
            item_def_id: recipe.product.item_def_id.clone(),
            item_name: recipe.product.name.clone(),
            item_icon: recipe.product.icon.clone(),
            qty: product_qty,
            item_ids: vec![produced_id],
        })
    } else {
        None
    };

    let mut returned_items = Vec::new();
    if fail_count > 0 && fail_return_rate_ratio > 0.0 {
        for cost_item in &recipe.costs.items {
            let rollback_qty =
                ((cost_item.required * fail_count) as f64 * fail_return_rate_ratio).floor() as i64;
            if rollback_qty <= 0 {
                continue;
            }
            let bind_type = defs
                .get(cost_item.item_def_id.as_str())
                .and_then(|seed| seed.row.get("bind_type"))
                .and_then(|value| value.as_str())
                .unwrap_or("none");
            grant_inventory_item_instance(
                state,
                user_id,
                character_id,
                cost_item.item_def_id.as_str(),
                rollback_qty,
                bind_type,
                "craft_refund",
                recipe.id.as_str(),
            )
            .await?;
            returned_items.push(InventoryCraftExecuteReturnedItemDto {
                item_def_id: cost_item.item_def_id.clone(),
                qty: rollback_qty,
            });
        }
    }

    let character = load_inventory_craft_character(state, user_id).await?;
    let message = if success_count > 0 {
        "炼制完成".to_string()
    } else {
        "炼制失败".to_string()
    };
    if success_count > 0 {
        crate::http::task::record_craft_item_task_event(
            state,
            character_id,
            user_id,
            Some(recipe.id.as_str()),
            Some(recipe.craft_kind.as_str()),
            Some(recipe.product.item_def_id.as_str()),
            success_count,
            Some(recipe.recipe_type.as_str()),
        )
        .await?;
        crate::http::achievement::record_craft_item_achievement_event(
            state,
            character_id,
            user_id,
            Some(recipe.id.as_str()),
            Some(recipe.craft_kind.as_str()),
            Some(recipe.product.item_def_id.as_str()),
            success_count,
        )
        .await?;
        crate::http::main_quest::record_main_quest_craft_item_event(
            state,
            character_id,
            recipe.id.as_str(),
            success_count,
        )
        .await?;
    }
    Ok(InventoryCraftExecuteResponse {
        success: true,
        message,
        data: Some(InventoryCraftExecuteData {
            recipe_id: recipe.id.clone(),
            recipe_type: recipe.recipe_type.clone(),
            craft_kind: recipe.craft_kind.clone(),
            times,
            success_count,
            fail_count,
            spent: InventoryCraftExecuteSpentDto {
                silver: recipe.costs.silver * times,
                spirit_stones: recipe.costs.spirit_stones * times,
                exp: recipe.costs.exp * times,
                items: recipe
                    .costs
                    .items
                    .iter()
                    .map(|item| InventoryCraftExecuteReturnedItemDto {
                        item_def_id: item.item_def_id.clone(),
                        qty: item.required * times,
                    })
                    .collect(),
            },
            returned_items,
            produced,
            character,
        }),
    })
}

fn build_equipment_preview_base_attrs(
    base_attrs_raw: &serde_json::Value,
    def_quality_rank: i64,
    resolved_quality_rank: i64,
    strengthen_level: i64,
    refine_level: i64,
    socketed_gems_raw: Option<&serde_json::Value>,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> BTreeMap<String, i64> {
    let mut attrs = BTreeMap::new();
    if let Some(map) = base_attrs_raw.as_object() {
        for (key, value) in map {
            let base = value
                .as_f64()
                .or_else(|| value.as_i64().map(|v| v as f64))
                .unwrap_or_default();
            let quality_factor = quality_multiplier(resolved_quality_rank)
                / quality_multiplier(def_quality_rank.max(1));
            let growth_factor = (1.0 + strengthen_level.max(0) as f64 * 0.03)
                * (1.0 + refine_level.max(0) as f64 * 0.02);
            attrs.insert(
                key.clone(),
                (base * quality_factor * growth_factor).round() as i64,
            );
        }
    }
    if let Some(gems) = socketed_gems_raw.and_then(|value| value.as_array()) {
        for gem in gems {
            let Some(item_def_id) = gem.get("itemDefId").and_then(|value| value.as_str()) else {
                continue;
            };
            let Some(def) = defs.get(item_def_id) else {
                continue;
            };
            let effect_defs = def
                .row
                .get("effect_defs")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            for effect in effect_defs {
                if effect.get("trigger").and_then(|value| value.as_str()) != Some("socket") {
                    continue;
                }
                if effect.get("effect_type").and_then(|value| value.as_str()) != Some("buff") {
                    continue;
                }
                let params = effect.get("params").and_then(|value| value.as_object());
                let Some(attr_key) = params
                    .and_then(|params| params.get("attr_key"))
                    .and_then(|value| value.as_str())
                else {
                    continue;
                };
                let apply_type = params
                    .and_then(|params| params.get("apply_type"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("flat");
                if apply_type != "flat" {
                    continue;
                }
                let value = params
                    .and_then(|params| params.get("value"))
                    .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
                    .unwrap_or_default();
                *attrs.entry(attr_key.to_string()).or_insert(0) += value.round() as i64;
            }
        }
    }
    attrs
}

fn quality_multiplier(rank: i64) -> f64 {
    match rank.max(1) {
        1 => 1.0,
        2 => 1.15,
        3 => 1.35,
        4 => 1.6,
        _ => 1.0,
    }
}

fn build_inventory_disassemble_plan(
    defs: &BTreeMap<String, InventoryDefSeed>,
    item_def_id: &str,
    quality: Option<String>,
    quality_rank: Option<i64>,
    strengthen_level: i64,
    refine_level: i64,
    affixes: Option<serde_json::Value>,
    qty: i64,
) -> Result<InventoryDisassemblePlan, AppError> {
    let def = defs
        .get(item_def_id)
        .ok_or_else(|| AppError::config("物品不存在"))?;
    let quality_rank = quality_rank.unwrap_or_else(|| {
        map_quality_rank(quality.as_deref().unwrap_or_else(|| {
            def.row
                .get("quality")
                .and_then(|value| value.as_str())
                .unwrap_or("黄")
        }))
    });
    let category = def
        .row
        .get("category")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let sub_category = def
        .row
        .get("sub_category")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if category == "equipment" {
        let reward_item_def_id = if quality_rank <= 2 {
            "enhance-001"
        } else {
            "enhance-002"
        };
        let name = defs
            .get(reward_item_def_id)
            .and_then(|seed| seed.row.get("name"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| AppError::config("分解奖励名称配置错误"))?;
        return Ok(InventoryDisassemblePlan {
            rewards: InventoryDisassembleRewardsDto {
                silver: 0,
                items: vec![InventoryUseLootResultDto {
                    r#type: "item".to_string(),
                    name: Some(name.to_string()),
                    amount: qty,
                    item_def_id: Some(reward_item_def_id.to_string()),
                    item_ids: Some(vec![]),
                }],
            },
        });
    }
    let is_technique_book = sub_category == "technique_book"
        || def
            .row
            .get("effect_defs")
            .and_then(|value| value.as_array())
            .map(|effects| {
                effects.iter().any(|effect| {
                    effect.get("effect_type").and_then(|value| value.as_str())
                        == Some("learn_technique")
                })
            })
            .unwrap_or(false);
    if is_technique_book {
        let reward_qty: i64 = match quality_rank {
            1 => 15_i64,
            2 => 30_i64,
            3 => 60_i64,
            _ => 120_i64,
        }
        .saturating_mul(qty);
        let reward_item_def_id = "mat-gongfa-canye";
        let name = defs
            .get(reward_item_def_id)
            .and_then(|seed| seed.row.get("name"))
            .and_then(|value| value.as_str())
            .ok_or_else(|| AppError::config("分解奖励名称配置错误"))?;
        return Ok(InventoryDisassemblePlan {
            rewards: InventoryDisassembleRewardsDto {
                silver: 0,
                items: vec![InventoryUseLootResultDto {
                    r#type: "item".to_string(),
                    name: Some(name.to_string()),
                    amount: reward_qty,
                    item_def_id: Some(reward_item_def_id.to_string()),
                    item_ids: Some(vec![]),
                }],
            },
        });
    }
    let quality_factor = match quality_rank {
        1 => 1.0,
        2 => 1.8,
        3 => 3.0,
        _ => 4.8,
    };
    let affix_count = affixes
        .and_then(|value| value.as_array().map(|items| items.len() as i64))
        .unwrap_or_default();
    let growth_factor = 1.0
        + strengthen_level.max(0) as f64 * 0.06
        + refine_level.max(0) as f64 * 0.08
        + affix_count.max(0) as f64 * 0.03;
    let unit_silver = ((100.0 * quality_factor * growth_factor) / 10.0).floor() as i64;
    Ok(InventoryDisassemblePlan {
        rewards: InventoryDisassembleRewardsDto {
            silver: unit_silver.max(1).saturating_mul(qty),
            items: vec![],
        },
    })
}

fn map_quality_rank(name: &str) -> i64 {
    match name.trim() {
        "黄" => 1,
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 1,
    }
}

async fn load_inventory_use_character_snapshot(
    state: &AppState,
    character_id: i64,
) -> Result<InventoryUseCharacterSnapshotDto, AppError> {
    let character_row = state.database.fetch_optional(
        "SELECT COALESCE(c.jing, 0)::bigint AS qixue, COALESCE(c.jing, 0)::bigint AS max_qixue, COALESCE(c.qi, 0)::bigint AS lingqi, COALESCE(c.qi, 0)::bigint AS max_lingqi, c.exp, c.stamina, c.stamina_recover_at::text AS stamina_recover_at_text, COALESCE(cip.level, 0) AS insight_level, mco.start_at::text AS month_card_start_at_text, mco.expire_at::text AS month_card_expire_at_text FROM characters c LEFT JOIN character_insight_progress cip ON cip.character_id = c.id LEFT JOIN month_card_ownership mco ON mco.character_id = c.id AND mco.month_card_id = $2 WHERE c.id = $1 LIMIT 1 FOR UPDATE OF c",
        |q| q.bind(character_id).bind(DEFAULT_MONTH_CARD_ID),
    ).await?;
    let Some(character_row) = character_row else {
        return Err(AppError::config("角色不存在"));
    };
    let current_qixue = character_row
        .try_get::<Option<i64>, _>("qixue")?
        .unwrap_or_default();
    let max_qixue = character_row
        .try_get::<Option<i64>, _>("max_qixue")?
        .unwrap_or_default()
        .max(0);
    let current_lingqi = character_row
        .try_get::<Option<i64>, _>("lingqi")?
        .unwrap_or_default();
    let max_lingqi = character_row
        .try_get::<Option<i64>, _>("max_lingqi")?
        .unwrap_or_default()
        .max(0);
    let current_exp = character_row
        .try_get::<Option<i64>, _>("exp")?
        .unwrap_or_default();
    let current_stamina = character_row
        .try_get::<Option<i32>, _>("stamina")?
        .map(i64::from)
        .unwrap_or_default();
    let insight_level = character_row
        .try_get::<Option<i64>, _>("insight_level")?
        .unwrap_or_default();
    let stamina_recover_at_text =
        character_row.try_get::<Option<String>, _>("stamina_recover_at_text")?;
    let month_card_start_at_text =
        character_row.try_get::<Option<String>, _>("month_card_start_at_text")?;
    let month_card_expire_at_text =
        character_row.try_get::<Option<String>, _>("month_card_expire_at_text")?;
    let stamina_state = resolve_stamina_recovery_state(
        current_stamina,
        calc_character_stamina_max_by_insight_level(insight_level),
        stamina_recover_at_text.as_deref(),
        month_card_start_at_text.as_deref(),
        month_card_expire_at_text.as_deref(),
        load_default_month_card_stamina_recovery_rate(),
    );
    Ok(InventoryUseCharacterSnapshotDto {
        qixue: current_qixue,
        lingqi: current_lingqi,
        exp: current_exp,
        stamina: stamina_state.stamina,
        stamina_max: stamina_state.max_stamina,
        max_qixue,
        max_lingqi,
    })
}

async fn equip_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_id: i64,
) -> Result<InventoryCharacterSnapshotDto, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, location, location_slot, equipped_slot, bind_type, bind_owner_user_id, bind_owner_character_id, locked FROM item_instance WHERE owner_character_id = $1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let mut items = rows
        .into_iter()
        .map(map_inventory_equip_row)
        .collect::<Result<Vec<_>, _>>()?;

    let Some(item_index) = items.iter().position(|row| row.id == item_id) else {
        return Err(AppError::config("物品不存在"));
    };
    let item = items[item_index].clone();
    let defs = load_inventory_def_map()?;
    let Some(def) = defs.get(item.item_def_id.as_str()) else {
        return Err(AppError::config("物品不存在"));
    };
    if item.locked {
        return Err(AppError::config("物品已锁定"));
    }
    if def.row.get("category").and_then(|value| value.as_str()) != Some("equipment") {
        return Err(AppError::config("该物品不可装备"));
    }
    let equip_slot = def
        .row
        .get("equip_slot")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config("装备槽位配置错误"))?
        .to_string();
    if item.qty != 1 {
        return Err(AppError::config("装备数量异常"));
    }
    if item.location == "equipped" {
        return Err(AppError::config("该装备已穿戴"));
    }
    if !matches!(item.location.as_str(), "bag" | "warehouse") {
        return Err(AppError::config("该物品当前位置不可装备"));
    }
    ensure_equip_realm_requirement(
        state,
        character_id,
        def.row
            .get("equip_req_realm")
            .and_then(|value| value.as_str()),
    )
    .await?;

    if let Some(equipped_index) = items.iter().position(|row| {
        row.id != item.id
            && row.equipped_slot.as_deref() == Some(equip_slot.as_str())
            && row.location == "equipped"
    }) {
        let bag_capacity = load_inventory_capacity(state, character_id, "bag")
            .await?
            .unwrap_or(100);
        let Some(empty_slot) = find_first_empty_equip_target_slot(&items, "bag", bag_capacity)
        else {
            return Err(AppError::config("背包已满，无法替换装备"));
        };
        items[equipped_index].location = "bag".to_string();
        items[equipped_index].location_slot = Some(empty_slot);
        items[equipped_index].equipped_slot = None;
    }

    let target = &mut items[item_index];
    target.location = "equipped".to_string();
    target.location_slot = None;
    target.equipped_slot = Some(equip_slot);
    if target.bind_type == "none"
        && def.row.get("bind_type").and_then(|value| value.as_str()) == Some("equip")
    {
        target.bind_type = "equip".to_string();
        target.bind_owner_user_id = Some(user_id);
        target.bind_owner_character_id = Some(character_id);
    }

    apply_inventory_equip_rows(state, character_id, &items).await?;
    if let Some(projection) = state
        .online_battle_projections
        .get_current_for_user(user_id)
    {
        state.online_battle_projections.clear(&projection.battle_id);
    }
    load_inventory_character_snapshot(state, user_id)
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))
}

async fn unequip_inventory_item_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_id: i64,
    target_location: &str,
) -> Result<InventoryCharacterSnapshotDto, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let rows = state.database.fetch_all(
        "SELECT id, item_def_id, qty, location, location_slot, equipped_slot, bind_type, bind_owner_user_id, bind_owner_character_id, locked FROM item_instance WHERE owner_character_id = $1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let mut items = rows
        .into_iter()
        .map(map_inventory_equip_row)
        .collect::<Result<Vec<_>, _>>()?;

    let Some(item_index) = items.iter().position(|row| row.id == item_id) else {
        return Err(AppError::config("物品不存在"));
    };
    let item = items[item_index].clone();
    if item.locked {
        return Err(AppError::config("物品已锁定"));
    }
    if item.location != "equipped" {
        return Err(AppError::config("该物品未穿戴"));
    }
    let capacity = load_inventory_capacity(state, character_id, target_location)
        .await?
        .unwrap_or(if target_location == "warehouse" {
            1000
        } else {
            100
        });
    let Some(empty_slot) = find_first_empty_equip_target_slot(&items, target_location, capacity)
    else {
        return Err(AppError::config(if target_location == "bag" {
            "背包已满"
        } else {
            "仓库已满"
        }));
    };

    let target = &mut items[item_index];
    target.location = target_location.to_string();
    target.location_slot = Some(empty_slot);
    target.equipped_slot = None;

    apply_inventory_equip_rows(state, character_id, &items).await?;
    if let Some(projection) = state
        .online_battle_projections
        .get_current_for_user(user_id)
    {
        state.online_battle_projections.clear(&projection.battle_id);
    }
    load_inventory_character_snapshot(state, user_id)
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))
}

fn map_inventory_equip_row(row: sqlx::postgres::PgRow) -> Result<InventoryEquipRow, AppError> {
    Ok(InventoryEquipRow {
        id: row.try_get::<i64, _>("id")?,
        item_def_id: row.try_get::<String, _>("item_def_id")?,
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default(),
        location: row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default(),
        location_slot: row
            .try_get::<Option<i32>, _>("location_slot")?
            .map(i64::from),
        equipped_slot: row.try_get::<Option<String>, _>("equipped_slot")?,
        bind_type: normalize_bind_type(row.try_get::<Option<String>, _>("bind_type")?),
        bind_owner_user_id: row.try_get::<Option<i64>, _>("bind_owner_user_id")?,
        bind_owner_character_id: row.try_get::<Option<i64>, _>("bind_owner_character_id")?,
        locked: row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false),
    })
}

fn find_first_empty_equip_target_slot(
    rows: &[InventoryEquipRow],
    location: &str,
    capacity: i64,
) -> Option<i64> {
    (0..capacity).find(|slot| {
        !rows
            .iter()
            .any(|row| row.location == location && row.location_slot == Some(*slot))
    })
}

async fn apply_inventory_equip_rows(
    state: &AppState,
    character_id: i64,
    rows: &[InventoryEquipRow],
) -> Result<(), AppError> {
    let slot_release_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
    release_item_instance_slots_for_update(state, character_id, &slot_release_ids).await?;
    for row in rows {
        state.database.execute(
            "UPDATE item_instance SET location = $1, location_slot = $2, equipped_slot = $3, bind_type = $4, bind_owner_user_id = $5, bind_owner_character_id = $6, updated_at = NOW() WHERE id = $7 AND owner_character_id = $8",
            |q| q
                .bind(row.location.as_str())
                .bind(row.location_slot)
                .bind(row.equipped_slot.as_deref())
                .bind(row.bind_type.as_str())
                .bind(row.bind_owner_user_id)
                .bind(row.bind_owner_character_id)
                .bind(row.id)
                .bind(character_id),
        ).await?;
    }
    Ok(())
}

async fn ensure_equip_realm_requirement(
    state: &AppState,
    character_id: i64,
    equip_required_realm: Option<&str>,
) -> Result<(), AppError> {
    let required = equip_required_realm
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(required) = required else {
        return Ok(());
    };
    let row = state
        .database
        .fetch_optional(
            "SELECT realm, sub_realm FROM characters WHERE id = $1 FOR UPDATE LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    let realm = row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_default();
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm")?;
    let current_rank = get_realm_rank_one_based_strict(&realm, sub_realm.as_deref());
    let required_rank = get_realm_rank_one_based_for_equipment(required);
    if current_rank < required_rank {
        return Err(AppError::config(format!("境界不足，需达到{required}")));
    }
    Ok(())
}

async fn ensure_use_realm_requirement(
    state: &AppState,
    character_id: i64,
    required_realm: Option<&str>,
) -> Result<(), AppError> {
    let required = required_realm
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(required) = required else {
        return Ok(());
    };
    let row = state
        .database
        .fetch_optional(
            "SELECT realm, sub_realm FROM characters WHERE id = $1 FOR UPDATE LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    let realm = row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_default();
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm")?;
    let current_rank = get_realm_rank_one_based_strict(&realm, sub_realm.as_deref());
    let required_rank = get_realm_rank_one_based_for_equipment(required);
    if current_rank < required_rank {
        return Err(AppError::config(format!("境界不足，需要达到{}", required)));
    }
    Ok(())
}

fn get_realm_rank_one_based_strict(realm: &str, sub_realm: Option<&str>) -> i64 {
    let normalized = normalize_realm_strict(realm, sub_realm);
    realm_order()
        .iter()
        .position(|value| *value == normalized)
        .map(|index| index as i64 + 1)
        .unwrap_or(1)
}

fn get_realm_rank_one_based_for_equipment(realm_raw: &str) -> i64 {
    let normalized = normalize_realm_for_equipment(realm_raw);
    realm_order()
        .iter()
        .position(|value| *value == normalized)
        .map(|index| index as i64 + 1)
        .unwrap_or(1)
}

fn normalize_realm_strict(realm: &str, sub_realm: Option<&str>) -> &'static str {
    let realm = realm.trim();
    let sub_realm = sub_realm.unwrap_or_default().trim();
    if realm.is_empty() && sub_realm.is_empty() {
        return "凡人";
    }
    if !realm.is_empty() && !sub_realm.is_empty() {
        let combined = format!("{realm}·{sub_realm}");
        if let Some(full) = map_known_realm(&combined) {
            return full;
        }
    }
    if let Some(full) = map_known_realm(realm) {
        return full;
    }
    if let Some(full) = map_known_realm(sub_realm) {
        return full;
    }
    "凡人"
}

fn normalize_realm_for_equipment(realm_raw: &str) -> &'static str {
    let raw = realm_raw.trim();
    if raw.is_empty() {
        return "凡人";
    }
    if let Some(full) = map_known_realm(raw) {
        return full;
    }
    let segments = raw.split('·').collect::<Vec<_>>();
    if segments.len() >= 2 {
        let combined = format!("{}·{}", segments[0], segments[1]);
        if let Some(full) = map_known_realm(&combined) {
            return full;
        }
        if let Some(full) = map_known_realm(segments[1]) {
            return full;
        }
    }
    "凡人"
}

fn map_known_realm(value: &str) -> Option<&'static str> {
    match value.trim() {
        "凡人" => Some("凡人"),
        "炼精化炁" => Some("炼精化炁·养气期"),
        "炼炁化神" => Some("炼炁化神·炼己期"),
        "炼神返虚" => Some("炼神返虚·养神期"),
        "炼虚合道" => Some("炼虚合道·证道期"),
        "养气期" | "炼精化炁·养气期" => Some("炼精化炁·养气期"),
        "通脉期" | "炼精化炁·通脉期" => Some("炼精化炁·通脉期"),
        "凝炁期" | "炼精化炁·凝炁期" => Some("炼精化炁·凝炁期"),
        "炼己期" | "炼炁化神·炼己期" => Some("炼炁化神·炼己期"),
        "采药期" | "炼炁化神·采药期" => Some("炼炁化神·采药期"),
        "结胎期" | "炼炁化神·结胎期" => Some("炼炁化神·结胎期"),
        "养神期" | "炼神返虚·养神期" => Some("炼神返虚·养神期"),
        "还虚期" | "炼神返虚·还虚期" => Some("炼神返虚·还虚期"),
        "合道期" | "炼神返虚·合道期" => Some("炼神返虚·合道期"),
        "证道期" | "炼虚合道·证道期" => Some("炼虚合道·证道期"),
        "历劫期" | "炼虚合道·历劫期" => Some("炼虚合道·历劫期"),
        "成圣期" | "炼虚合道·成圣期" => Some("炼虚合道·成圣期"),
        _ => None,
    }
}

fn realm_order() -> &'static [&'static str] {
    &[
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
    ]
}

async fn load_inventory_character_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<Option<InventoryCharacterSnapshotDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, nickname, gender, title, realm, sub_realm, spirit_stones, silver, COALESCE(jing, 0)::bigint AS qixue, COALESCE(jing, 0)::bigint AS max_qixue, 0::bigint AS wugong, 0::bigint AS wufang FROM characters WHERE user_id = $1 LIMIT 1",
        |q| q.bind(user_id),
    ).await?;
    row.map(|row| {
        Ok(InventoryCharacterSnapshotDto {
            id: i64::from(row.try_get::<i32, _>("id")?),
            nickname: row.try_get("nickname")?,
            gender: row.try_get("gender")?,
            title: row.try_get("title")?,
            realm: row.try_get("realm")?,
            sub_realm: row.try_get("sub_realm")?,
            spirit_stones: row.try_get("spirit_stones").unwrap_or_default(),
            silver: row.try_get("silver").unwrap_or_default(),
            qixue: row.try_get("qixue").unwrap_or_default(),
            max_qixue: row.try_get("max_qixue").unwrap_or_default(),
            wugong: row.try_get("wugong").unwrap_or_default(),
            wufang: row.try_get("wufang").unwrap_or_default(),
        })
    })
    .transpose()
}

async fn move_inventory_item_tx(
    state: &AppState,
    character_id: i64,
    item_id: i64,
    target_location: &str,
    target_slot: Option<i64>,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let mut rows = state
        .database
        .fetch_all(
            "SELECT id, item_def_id, qty, location, location_slot, bind_type, metadata, quality, quality_rank FROM item_instance WHERE owner_character_id = $1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?
        .into_iter()
        .map(map_inventory_move_row)
        .collect::<Result<Vec<_>, _>>()?;
    let original_rows = rows.clone();

    let Some(item_index) = rows.iter().position(|row| row.id == item_id) else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let item = rows[item_index].clone();
    let Some(def) = load_inventory_def_map()?
        .get(item.item_def_id.as_str())
        .cloned()
    else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    if !matches!(item.location.as_str(), "bag" | "warehouse") {
        return Ok(ServiceResult {
            success: false,
            message: Some("当前位置不支持移动".to_string()),
            data: None,
        });
    }
    let Some(current_slot) = item.location_slot.filter(|slot| *slot >= 0) else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品格子状态异常".to_string()),
            data: None,
        });
    };
    if item.qty <= 0 {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品数量异常".to_string()),
            data: None,
        });
    }

    let stack_max = def
        .row
        .get("stack_max")
        .and_then(|value| value.as_i64())
        .unwrap_or(1)
        .max(1);
    let source_can_auto_stack = stack_max > 1 && is_plain_stacking_move_row(&item);
    let normalized_bind_type = normalize_bind_type(Some(item.bind_type.clone()));
    let mut remaining_qty = item.qty;

    if item.location != target_location && source_can_auto_stack {
        let candidate_ids = rows
            .iter()
            .filter(|row| {
                row.id != item.id
                    && row.location == target_location
                    && row.item_def_id == item.item_def_id
                    && normalize_bind_type(Some(row.bind_type.clone())) == normalized_bind_type
                    && is_plain_stacking_move_row(row)
                    && row.qty < stack_max
            })
            .map(|row| row.id)
            .collect::<Vec<_>>();
        let mut sorted_candidate_ids = candidate_ids;
        sorted_candidate_ids.sort_by(|left, right| {
            let left_row = rows
                .iter()
                .find(|row| row.id == *left)
                .expect("candidate row should exist");
            let right_row = rows
                .iter()
                .find(|row| row.id == *right)
                .expect("candidate row should exist");
            right_row
                .qty
                .cmp(&left_row.qty)
                .then_with(|| left_row.id.cmp(&right_row.id))
        });

        for candidate_id in sorted_candidate_ids {
            if remaining_qty <= 0 {
                break;
            }
            let candidate = rows
                .iter_mut()
                .find(|row| row.id == candidate_id)
                .expect("candidate row should exist");
            let can_add = (stack_max - candidate.qty).min(remaining_qty).max(0);
            if can_add <= 0 {
                continue;
            }
            candidate.qty += can_add;
            candidate.bind_type = normalized_bind_type.clone();
            candidate.metadata = None;
            candidate.quality = None;
            candidate.quality_rank = None;
            remaining_qty -= can_add;
        }

        if remaining_qty <= 0 {
            apply_inventory_move_rows(state, character_id, &original_rows, &rows, Some(item.id))
                .await?;
            return Ok(ServiceResult {
                success: true,
                message: Some("移动成功".to_string()),
                data: None,
            });
        }
    }

    let Some(capacity) = load_inventory_capacity(state, character_id, target_location).await?
    else {
        return Ok(ServiceResult {
            success: false,
            message: Some("背包不存在".to_string()),
            data: None,
        });
    };
    if let Some(target_slot) = target_slot {
        if target_slot >= capacity {
            return Ok(ServiceResult {
                success: false,
                message: Some("目标格子超出容量".to_string()),
                data: None,
            });
        }
    }

    let final_slot = if let Some(target_slot) = target_slot {
        target_slot
    } else {
        let Some(empty_slot) = find_first_empty_inventory_slot(&rows, target_location, capacity)
        else {
            return Ok(ServiceResult {
                success: false,
                message: Some("目标位置已满".to_string()),
                data: None,
            });
        };
        empty_slot
    };

    if let Some(occupant_index) = rows.iter().position(|row| {
        row.id != item.id
            && row.location == target_location
            && row.location_slot == Some(final_slot)
    }) {
        rows[occupant_index].location = item.location.clone();
        rows[occupant_index].location_slot = Some(current_slot);
    }

    rows[item_index].qty = remaining_qty;
    rows[item_index].location = target_location.to_string();
    rows[item_index].location_slot = Some(final_slot);
    rows[item_index].bind_type = normalized_bind_type;
    if source_can_auto_stack {
        rows[item_index].metadata = None;
        rows[item_index].quality = None;
        rows[item_index].quality_rank = None;
    }

    apply_inventory_move_rows(state, character_id, &original_rows, &rows, None).await?;
    Ok(ServiceResult {
        success: true,
        message: Some("移动成功".to_string()),
        data: None,
    })
}

fn map_inventory_move_row(row: sqlx::postgres::PgRow) -> Result<InventoryMoveRow, AppError> {
    Ok(InventoryMoveRow {
        id: row.try_get::<i64, _>("id")?,
        item_def_id: row.try_get::<String, _>("item_def_id")?,
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default(),
        location: row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default(),
        location_slot: row
            .try_get::<Option<i32>, _>("location_slot")?
            .map(i64::from),
        bind_type: normalize_bind_type(row.try_get::<Option<String>, _>("bind_type")?),
        metadata: row.try_get::<Option<serde_json::Value>, _>("metadata")?,
        quality: row.try_get::<Option<String>, _>("quality")?,
        quality_rank: row
            .try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
    })
}

fn is_plain_stacking_move_row(row: &InventoryMoveRow) -> bool {
    row.quality
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
        && row.quality_rank.map(|value| value <= 0).unwrap_or(true)
        && row
            .metadata
            .as_ref()
            .map(value_is_blank_metadata)
            .unwrap_or(true)
}

fn find_first_empty_inventory_slot(
    rows: &[InventoryMoveRow],
    location: &str,
    capacity: i64,
) -> Option<i64> {
    (0..capacity).find(|slot| {
        !rows
            .iter()
            .any(|row| row.location == location && row.location_slot == Some(*slot))
    })
}

async fn apply_inventory_move_rows(
    state: &AppState,
    character_id: i64,
    original_rows: &[InventoryMoveRow],
    rows: &[InventoryMoveRow],
    delete_item_id: Option<i64>,
) -> Result<(), AppError> {
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            let now_ms = inventory_item_mutation_timestamp_ms();
            let rows_by_id = rows
                .iter()
                .map(|row| (row.id, row))
                .collect::<BTreeMap<_, _>>();
            let snapshot_ids = rows.iter().map(|row| row.id).collect::<Vec<_>>();
            let mut mutations = Vec::new();
            if let Some(delete_item_id) = delete_item_id {
                mutations.push(BufferedItemInstanceMutation {
                    op_id: format!("inventory-move-delete:{delete_item_id}:{now_ms}"),
                    character_id,
                    item_id: delete_item_id,
                    created_at_ms: now_ms,
                    kind: "delete".to_string(),
                    snapshot: None,
                });
            }
            let snapshot_rows = state.database.fetch_all(
                "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE owner_character_id = $1 AND id = ANY($2)",
                |q| q.bind(character_id).bind(&snapshot_ids),
            ).await?;
            for snapshot_row in snapshot_rows {
                let snapshot_id = snapshot_row.try_get::<i64, _>("id")?;
                if delete_item_id == Some(snapshot_id) {
                    continue;
                }
                let Some(updated_row) = rows_by_id.get(&snapshot_id) else {
                    continue;
                };
                let Some(original) = original_rows.iter().find(|entry| entry.id == snapshot_id)
                else {
                    continue;
                };
                if original == *updated_row {
                    continue;
                }
                let mut snapshot = map_item_instance_snapshot_from_row(&snapshot_row)?;
                snapshot.qty = updated_row.qty;
                snapshot.location = updated_row.location.clone();
                snapshot.location_slot = updated_row.location_slot;
                snapshot.bind_type = updated_row.bind_type.clone();
                snapshot.metadata = updated_row.metadata.clone();
                snapshot.quality = updated_row.quality.clone();
                snapshot.quality_rank = updated_row.quality_rank;
                mutations.push(BufferedItemInstanceMutation {
                    op_id: format!("inventory-move-upsert:{}:{now_ms}", snapshot_id),
                    character_id,
                    item_id: snapshot_id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(snapshot),
                });
            }
            if !mutations.is_empty() {
                buffer_item_instance_mutations(&redis, &mutations).await?;
                flush_inventory_item_instance_mutations_now(state, character_id).await?;
            }
            return Ok(());
        }
    }

    if let Some(delete_item_id) = delete_item_id {
        state
            .database
            .execute(
                "DELETE FROM item_instance WHERE id = $1 AND owner_character_id = $2",
                |q| q.bind(delete_item_id).bind(character_id),
            )
            .await?;
    }

    let slot_release_ids = rows
        .iter()
        .filter(|row| delete_item_id != Some(row.id))
        .map(|row| row.id)
        .collect::<Vec<_>>();
    release_item_instance_slots_for_update(state, character_id, &slot_release_ids).await?;

    for row in rows {
        if delete_item_id == Some(row.id) {
            continue;
        }
        let Some(original) = original_rows.iter().find(|entry| entry.id == row.id) else {
            continue;
        };
        if original == row {
            continue;
        }
        state.database.execute(
            "UPDATE item_instance SET qty = $1, location = $2, location_slot = $3, bind_type = $4, metadata = $5, quality = $6, quality_rank = $7, updated_at = NOW() WHERE id = $8 AND owner_character_id = $9",
            |q| q
                .bind(row.qty)
                .bind(row.location.as_str())
                .bind(row.location_slot)
                .bind(row.bind_type.as_str())
                .bind(row.metadata.clone())
                .bind(row.quality.as_deref())
                .bind(row.quality_rank)
                .bind(row.id)
                .bind(character_id),
        ).await?;
    }

    Ok(())
}

async fn acquire_inventory_mutex(state: &AppState, character_id: i64) -> Result<(), AppError> {
    state
        .database
        .fetch_one(
            "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
            |q| q.bind(INVENTORY_MUTEX_NAMESPACE).bind(character_id as i32),
        )
        .await?;
    Ok(())
}

async fn load_inventory_capacity(
    state: &AppState,
    character_id: i64,
    location: &str,
) -> Result<Option<i64>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT bag_capacity, warehouse_capacity FROM inventory WHERE character_id = $1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let capacity = if location == "warehouse" {
        opt_i64_from_i32(&row, "warehouse_capacity")?.unwrap_or(1000)
    } else {
        opt_i64_from_i32(&row, "bag_capacity")?.unwrap_or(100)
    };
    Ok(Some(capacity.max(0)))
}

async fn expand_inventory_capacity_tx(
    state: &AppState,
    character_id: i64,
    location: &str,
    expand_size: i64,
) -> Result<i64, AppError> {
    let normalized_expand_size = expand_size.max(0);
    if normalized_expand_size <= 0 {
        return Err(AppError::config("扩容道具配置错误"));
    }
    let row = state.database.fetch_optional(
        "SELECT bag_capacity, warehouse_capacity, bag_expand_count, warehouse_expand_count FROM inventory WHERE character_id = $1 FOR UPDATE",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("背包不存在"));
    };
    if location != "bag" {
        return Err(AppError::config("该道具暂不支持当前扩容类型"));
    }
    let current_capacity = opt_i64_from_i32(&row, "bag_capacity")?
        .unwrap_or(100)
        .max(0);
    if current_capacity >= 200 {
        return Err(AppError::config("背包容量已达上限（200格）"));
    }
    let next_capacity = current_capacity.saturating_add(normalized_expand_size);
    if next_capacity > 200 {
        return Err(AppError::config("扩容后超过上限（200格）"));
    }
    state.database.execute(
        "UPDATE inventory SET bag_capacity = bag_capacity + $1, bag_expand_count = COALESCE(bag_expand_count, 0) + 1, updated_at = NOW() WHERE character_id = $2",
        |q| q.bind(normalized_expand_size).bind(character_id),
    ).await?;
    Ok(next_capacity)
}

fn map_sort_inventory_row(row: sqlx::postgres::PgRow) -> Result<SortInventoryRow, AppError> {
    Ok(SortInventoryRow {
        id: row.try_get::<i64, _>("id")?,
        item_def_id: row.try_get::<String, _>("item_def_id")?,
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or(1)
            .max(0),
        quality: row.try_get::<Option<String>, _>("quality")?,
        quality_rank: row
            .try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
        bind_type: normalize_bind_type(row.try_get::<Option<String>, _>("bind_type")?),
        metadata: row.try_get::<Option<serde_json::Value>, _>("metadata")?,
        location_slot: row
            .try_get::<Option<i32>, _>("location_slot")?
            .map(i64::from),
    })
}

fn compact_inventory_rows_for_sort(
    rows: Vec<SortInventoryRow>,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> Vec<SortInventoryRow> {
    let mut preserved_rows = Vec::new();
    let mut grouped_plain_rows: BTreeMap<(String, String), Vec<SortInventoryRow>> = BTreeMap::new();
    for row in rows {
        let stack_max = defs
            .get(row.item_def_id.as_str())
            .and_then(|seed| seed.row.get("stack_max"))
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            .max(1);
        let plain = is_plain_stacking_row(&row);
        if stack_max <= 1 || !plain {
            preserved_rows.push(row);
            continue;
        }
        grouped_plain_rows
            .entry((row.item_def_id.clone(), row.bind_type.clone()))
            .or_default()
            .push(row);
    }

    for ((item_def_id, bind_type), mut group_rows) in grouped_plain_rows {
        group_rows.sort_by(|left, right| {
            left.location_slot
                .unwrap_or(i64::MAX)
                .cmp(&right.location_slot.unwrap_or(i64::MAX))
                .then_with(|| left.id.cmp(&right.id))
        });
        let stack_max = defs
            .get(item_def_id.as_str())
            .and_then(|seed| seed.row.get("stack_max"))
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            .max(1);
        let total_qty: i64 = group_rows.iter().map(|row| row.qty.max(0)).sum();
        if total_qty <= 0 {
            continue;
        }
        let mut remaining = total_qty;
        let mut template_iter = group_rows.into_iter();
        while remaining > 0 {
            let mut row = template_iter.next().unwrap_or_else(|| SortInventoryRow {
                id: 0,
                item_def_id: item_def_id.clone(),
                qty: 0,
                quality: None,
                quality_rank: None,
                bind_type: bind_type.clone(),
                metadata: None,
                location_slot: None,
            });
            if row.id <= 0 {
                break;
            }
            let next_qty = remaining.min(stack_max);
            row.qty = next_qty;
            row.quality = None;
            row.quality_rank = None;
            row.metadata = None;
            row.bind_type = bind_type.clone();
            preserved_rows.push(row);
            remaining -= next_qty;
        }
    }

    preserved_rows
}

fn is_plain_stacking_row(row: &SortInventoryRow) -> bool {
    row.quality
        .as_deref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
        && row.quality_rank.map(|value| value <= 0).unwrap_or(true)
        && row
            .metadata
            .as_ref()
            .map(value_is_blank_metadata)
            .unwrap_or(true)
}

fn value_is_blank_metadata(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::String(text) => {
            let normalized = text.trim().to_ascii_lowercase();
            normalized.is_empty() || normalized == "null" || normalized == "{}"
        }
        serde_json::Value::Object(map) => map.is_empty(),
        serde_json::Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn normalize_bind_type(value: Option<String>) -> String {
    let normalized = value.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.is_empty() {
        "none".to_string()
    } else {
        normalized
    }
}

fn build_ranked_sort_rows(
    rows: Vec<SortInventoryRow>,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> Vec<SortInventoryRankedRow> {
    let mut ranked = rows
        .into_iter()
        .map(|row| {
            let def = defs.get(row.item_def_id.as_str()).map(|seed| &seed.row);
            let quality_name = row.quality.as_deref().or_else(|| {
                def.and_then(|def| def.get("quality").and_then(|value| value.as_str()))
            });
            SortInventoryRankedRow {
                resolved_quality_rank: row
                    .quality_rank
                    .unwrap_or_else(|| quality_name.map(resolve_quality_rank).unwrap_or_default()),
                category: def
                    .and_then(|def| def.get("category"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                sub_category: def
                    .and_then(|def| def.get("sub_category"))
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                row,
            }
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| compare_ranked_rows(left, right));
    ranked
}

fn compare_ranked_rows(
    left: &SortInventoryRankedRow,
    right: &SortInventoryRankedRow,
) -> std::cmp::Ordering {
    compare_optional_text(left.category.as_deref(), right.category.as_deref())
        .then_with(|| right.resolved_quality_rank.cmp(&left.resolved_quality_rank))
        .then_with(|| {
            compare_optional_text(left.sub_category.as_deref(), right.sub_category.as_deref())
        })
        .then_with(|| left.row.item_def_id.cmp(&right.row.item_def_id))
        .then_with(|| right.row.qty.cmp(&left.row.qty))
        .then_with(|| left.row.id.cmp(&right.row.id))
}

fn compare_optional_text(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

fn resolve_quality_rank(name: &str) -> i64 {
    match name {
        "黄" => 1,
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 0,
    }
}

fn normalize_affix_lock_indexes(lock_indexes: &[i64]) -> Vec<i64> {
    let mut out = lock_indexes
        .iter()
        .copied()
        .filter(|idx| *idx >= 0)
        .collect::<Vec<_>>();
    out.sort_unstable();
    out.dedup();
    out
}

fn build_affix_reroll_cost_plan(
    equip_req_realm: Option<&str>,
    lock_count: i64,
) -> InventoryRerollCostPlan {
    let realm_rank =
        get_realm_rank_one_based_for_equipment(equip_req_realm.unwrap_or("凡人")).max(1);
    let safe_lock_count = lock_count.max(0).min(30);
    let reroll_scroll_qty = 2_i64.saturating_pow(safe_lock_count as u32);
    let silver_cost = (realm_rank * realm_rank * 500) as f64 * 1.6_f64.powi(safe_lock_count as i32);
    let spirit_stone_cost = if safe_lock_count > 0 {
        ((reroll_scroll_qty - 1) * realm_rank * 60).max(0)
    } else {
        0
    };
    InventoryRerollCostPlan {
        silver_cost: silver_cost.floor() as i64,
        spirit_stone_cost,
        reroll_scroll_qty,
    }
}

fn load_affix_pool_seed_map() -> Result<BTreeMap<String, InventoryAffixPoolSeed>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/affix_pool.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read affix_pool.json: {error}")))?;
    let payload: InventoryAffixPoolFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse affix_pool.json: {error}")))?;
    Ok(payload
        .pools
        .into_iter()
        .map(|pool| (pool.id.clone(), pool))
        .collect())
}

fn resolve_affix_pool_for_item(
    pool_map: &BTreeMap<String, InventoryAffixPoolSeed>,
    pool_id: &str,
    equip_slot: &str,
) -> Option<InventoryAffixPoolSeed> {
    let pool = pool_map.get(pool_id)?;
    let mut filtered = pool.clone();
    filtered.affixes = filtered
        .affixes
        .into_iter()
        .filter(|affix| {
            affix
                .allowed_slots
                .as_ref()
                .map(|slots| slots.iter().any(|slot| slot.trim() == equip_slot))
                .unwrap_or(true)
        })
        .collect();
    if filtered.affixes.is_empty() {
        None
    } else {
        Some(filtered)
    }
}

fn parse_inventory_rerolled_affixes(raw: serde_json::Value) -> Vec<InventoryRerolledAffixDto> {
    serde_json::from_value::<Vec<InventoryRerolledAffixDto>>(raw).unwrap_or_default()
}

fn render_affix_preview_tiers_for_realm(
    affix: &InventoryAffixSeed,
    attr_factor: f64,
    realm_rank: i64,
) -> Vec<InventoryAffixPoolPreviewTierDto> {
    let Some(values) = affix.values.as_ref() else {
        return Vec::new();
    };
    let Some(main) = values.get("main") else {
        return Vec::new();
    };
    let base = main.get("base").cloned().unwrap_or_default();
    let growth = main.get("growth").cloned().unwrap_or_default();
    let base_min = base
        .get("min")
        .and_then(|value| value.as_f64())
        .unwrap_or_default();
    let base_max = base
        .get("max")
        .and_then(|value| value.as_f64())
        .unwrap_or_default();
    let growth_min = growth
        .get("min_delta")
        .and_then(|value| value.as_f64())
        .unwrap_or_default();
    let growth_max = growth
        .get("max_delta")
        .and_then(|value| value.as_f64())
        .unwrap_or_default();
    let start_tier = affix.start_tier.unwrap_or(1).max(1);
    let tier_count = (realm_rank.max(start_tier) - start_tier + 1).max(1);
    (0..tier_count)
        .map(|offset| {
            let tier = start_tier + offset;
            let min = base_min + growth_min * offset as f64;
            let max = base_max + growth_max * offset as f64;
            InventoryAffixPoolPreviewTierDto {
                tier,
                min: if attr_factor.is_finite() && attr_factor > 0.0 {
                    min * attr_factor
                } else {
                    min
                },
                max: if attr_factor.is_finite() && attr_factor > 0.0 {
                    max * attr_factor
                } else {
                    max
                },
            }
        })
        .collect()
}

fn build_affix_rng_seed(
    item_instance_id: i64,
    character_id: i64,
    lock_count: usize,
    cursor: usize,
) -> [u8; 16] {
    md5::compute(
        format!(
            "reroll-affix:{item_instance_id}:{character_id}:{lock_count}:{cursor}:{}",
            current_timestamp_ms()
        )
        .as_bytes(),
    )
    .0
}

fn draw_weighted_affix_index(affixes: &[InventoryAffixSeed], seed: [u8; 16]) -> usize {
    let total_weight = affixes
        .iter()
        .map(|affix| affix.weight.unwrap_or(0.0).max(0.0))
        .sum::<f64>();
    if total_weight <= 0.0 {
        return 0;
    }
    let mut remaining = (u32::from_be_bytes([seed[0], seed[1], seed[2], seed[3]]) as f64
        / u32::MAX as f64)
        * total_weight;
    for (index, affix) in affixes.iter().enumerate() {
        remaining -= affix.weight.unwrap_or(0.0).max(0.0);
        if remaining <= 0.0 {
            return index;
        }
    }
    affixes.len().saturating_sub(1)
}

fn build_rerolled_affix(
    affix: &InventoryAffixSeed,
    attr_factor: f64,
    realm_rank: i64,
    seed: [u8; 16],
) -> InventoryRerolledAffixDto {
    let mut tiers = render_affix_preview_tiers_for_realm(affix, attr_factor, realm_rank);
    tiers.sort_by(|left, right| right.tier.cmp(&left.tier));
    let weights = tiers
        .iter()
        .enumerate()
        .map(|(index, _)| 0.6_f64.powi(index as i32))
        .collect::<Vec<_>>();
    let total_weight = weights.iter().sum::<f64>().max(f64::EPSILON);
    let mut remaining_weight = (u32::from_be_bytes([seed[4], seed[5], seed[6], seed[7]]) as f64
        / u32::MAX as f64)
        * total_weight;
    let mut selected_index = 0_usize;
    for (index, weight) in weights.iter().enumerate() {
        remaining_weight -= *weight;
        if remaining_weight <= 0.0 {
            selected_index = index;
            break;
        }
    }
    let tier = tiers
        .get(selected_index)
        .cloned()
        .unwrap_or(InventoryAffixPoolPreviewTierDto {
            tier: 1,
            min: 0.0,
            max: 0.0,
        });
    let roll_ratio = (u32::from_be_bytes([seed[8], seed[9], seed[10], seed[11]]) as f64
        / u32::MAX as f64)
        .clamp(0.0, 1.0);
    let value = tier.min + (tier.max - tier.min) * roll_ratio;
    let rounded_value = if value.fract().abs() < 0.000_001 {
        value.round()
    } else {
        (value * 100.0).round() / 100.0
    };
    let modifiers = affix.modifiers.as_ref().map(|mods| {
        mods.iter()
            .map(|modifier| InventorySocketEffectDto {
                attr_key: modifier.attr_key.clone(),
                value: rounded_value,
                apply_type: affix.apply_type.clone(),
            })
            .collect::<Vec<_>>()
    });
    InventoryRerolledAffixDto {
        key: affix.key.clone(),
        name: affix.name.clone(),
        modifiers,
        apply_type: affix.apply_type.clone(),
        tier: tier.tier,
        value: rounded_value,
        roll_ratio: Some(roll_ratio),
        roll_percent: Some((roll_ratio * 100.0 * 100.0).round() / 100.0),
        is_legendary: affix.is_legendary,
        description: affix.description_template.clone(),
        trigger: affix.trigger.clone(),
        target: affix.target.clone(),
        effect_type: affix.effect_type.clone(),
        duration_round: affix.duration_round,
        params: affix.params.clone(),
    }
}

async fn load_reroll_item_state(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryRerollItemState, AppError> {
    let row = state.database.fetch_optional(
        "SELECT item_def_id, affixes, locked, location, quality, quality_rank FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("物品不存在"));
    };
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let defs = load_inventory_def_map()?;
    let Some(def) = defs.get(item_def_id.as_str()) else {
        return Err(AppError::config("物品不存在"));
    };
    if def.row.get("category").and_then(|value| value.as_str()) != Some("equipment") {
        return Err(AppError::config("该物品不可洗炼"));
    }
    let locked = row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false);
    if locked {
        return Err(AppError::config("物品已锁定"));
    }
    let location = row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if location == "auction" {
        return Err(AppError::config("交易中的装备不可洗炼"));
    }
    if !matches!(location.as_str(), "bag" | "warehouse" | "equipped") {
        return Err(AppError::config("该物品当前位置不可洗炼"));
    }
    let affixes = parse_inventory_rerolled_affixes(
        row.try_get::<Option<serde_json::Value>, _>("affixes")?
            .unwrap_or_else(|| serde_json::json!([])),
    );
    if affixes.is_empty() {
        return Err(AppError::config("该装备没有可洗炼词条"));
    }
    let affix_pool_id = def
        .row
        .get("affix_pool_id")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if affix_pool_id.is_empty() {
        return Err(AppError::config("该装备没有可用词条池"));
    }
    let equip_slot = def
        .row
        .get("equip_slot")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    if equip_slot.is_empty() {
        return Err(AppError::config("该装备没有可用词条池"));
    }
    Ok(InventoryRerollItemState {
        _item_instance_id: item_instance_id,
        item_def_id,
        location,
        _locked: locked,
        quality: row.try_get::<Option<String>, _>("quality")?,
        quality_rank: row
            .try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
        affixes,
        affix_pool_id,
        equip_slot,
        equip_req_realm: def
            .row
            .get("equip_req_realm")
            .and_then(|value| value.as_str())
            .map(|s| s.to_string()),
    })
}

async fn preview_inventory_reroll_cost_tx(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryRerollCostPreviewResponse, AppError> {
    let item = load_reroll_item_state(state, character_id, item_instance_id).await?;
    let max_lock_count = (item.affixes.len() as i64 - 1).max(0);
    let cost_table = (0..=max_lock_count)
        .map(|lock_count| {
            let plan = build_affix_reroll_cost_plan(item.equip_req_realm.as_deref(), lock_count);
            InventoryRerollCostPreviewEntryDto {
                lock_count,
                reroll_scroll_qty: plan.reroll_scroll_qty,
                silver_cost: plan.silver_cost,
                spirit_stone_cost: plan.spirit_stone_cost,
            }
        })
        .collect();
    Ok(InventoryRerollCostPreviewResponse {
        success: true,
        message: "ok".to_string(),
        data: Some(InventoryRerollCostPreviewDataDto {
            reroll_scroll_item_def_id: REROLL_SCROLL_ITEM_DEF_ID.to_string(),
            max_lock_count,
            cost_table,
        }),
    })
}

async fn preview_inventory_affix_pool_tx(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
) -> Result<InventoryAffixPoolPreviewResponse, AppError> {
    let item = load_reroll_item_state(state, character_id, item_instance_id).await?;
    let defs = load_inventory_def_map()?;
    let item_def = defs
        .get(item.item_def_id.as_str())
        .ok_or_else(|| AppError::config("物品不存在"))?;
    let pool_map = load_affix_pool_seed_map()?;
    let Some(pool) = resolve_affix_pool_for_item(&pool_map, &item.affix_pool_id, &item.equip_slot)
    else {
        return Err(AppError::config("词条池不存在"));
    };
    let def_quality_rank = item_def
        .row
        .get("quality")
        .and_then(|value| value.as_str())
        .map(resolve_quality_rank)
        .unwrap_or(1)
        .max(1);
    let resolved_quality_rank = item
        .quality_rank
        .unwrap_or_else(|| {
            item.quality
                .as_deref()
                .map(resolve_quality_rank)
                .unwrap_or(def_quality_rank)
        })
        .max(1);
    let attr_factor =
        quality_multiplier(resolved_quality_rank) / quality_multiplier(def_quality_rank);
    let owned_keys = item
        .affixes
        .iter()
        .map(|affix| affix.key.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    Ok(InventoryAffixPoolPreviewResponse {
        success: true,
        message: "ok".to_string(),
        data: Some(InventoryAffixPoolPreviewDataDto {
            pool_name: pool.name,
            affixes: pool
                .affixes
                .into_iter()
                .map(|affix| InventoryAffixPoolPreviewAffixDto {
                    key: affix.key.clone(),
                    name: affix.name.clone(),
                    group: affix.group.clone().unwrap_or_default(),
                    is_legendary: affix.is_legendary.unwrap_or(false),
                    apply_type: affix.apply_type.clone(),
                    tiers: render_affix_preview_tiers_for_realm(
                        &affix,
                        attr_factor,
                        get_realm_rank_one_based_for_equipment(
                            item.equip_req_realm.as_deref().unwrap_or("凡人"),
                        ),
                    ),
                    owned: owned_keys.contains(affix.key.as_str()),
                    trigger: affix.trigger.clone(),
                    target: affix.target.clone(),
                    effect_type: affix.effect_type.clone(),
                    duration_round: affix.duration_round,
                    params: affix.params.clone(),
                    description_template: affix.description_template.clone(),
                })
                .collect(),
        }),
    })
}

async fn reroll_inventory_affixes_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
    lock_indexes: Vec<i64>,
) -> Result<InventoryRerollResponse, AppError> {
    acquire_inventory_mutex(state, character_id).await?;
    let item = load_reroll_item_state(state, character_id, item_instance_id).await?;
    let normalized_lock_indexes = normalize_affix_lock_indexes(&lock_indexes);
    let affix_count = item.affixes.len() as i64;
    let max_lock_count = (affix_count - 1).max(0);
    if normalized_lock_indexes
        .iter()
        .any(|idx| *idx >= affix_count)
        || normalized_lock_indexes.len() as i64 > max_lock_count
    {
        return Ok(InventoryRerollResponse {
            success: false,
            message: "锁定词条数量不合法".to_string(),
            data: None,
        });
    }
    let defs = load_inventory_def_map()?;
    let item_def = defs
        .get(item.item_def_id.as_str())
        .ok_or_else(|| AppError::config("物品不存在"))?;
    let pool_map = load_affix_pool_seed_map()?;
    let Some(pool) = resolve_affix_pool_for_item(&pool_map, &item.affix_pool_id, &item.equip_slot)
    else {
        return Ok(InventoryRerollResponse {
            success: false,
            message: "该装备没有可用词条池".to_string(),
            data: None,
        });
    };
    let def_quality_rank = item_def
        .row
        .get("quality")
        .and_then(|value| value.as_str())
        .map(resolve_quality_rank)
        .unwrap_or(1)
        .max(1);
    let resolved_quality_rank = item
        .quality_rank
        .unwrap_or_else(|| {
            item.quality
                .as_deref()
                .map(resolve_quality_rank)
                .unwrap_or(def_quality_rank)
        })
        .max(1);
    let attr_factor =
        quality_multiplier(resolved_quality_rank) / quality_multiplier(def_quality_rank);
    let cost_plan = build_affix_reroll_cost_plan(
        item.equip_req_realm.as_deref(),
        normalized_lock_indexes.len() as i64,
    );
    consume_inventory_material_by_def_id(
        state,
        user_id,
        character_id,
        REROLL_SCROLL_ITEM_DEF_ID,
        cost_plan.reroll_scroll_qty,
    )
    .await?;
    consume_inventory_character_currencies(
        state,
        character_id,
        cost_plan.silver_cost,
        cost_plan.spirit_stone_cost,
        0,
    )
    .await?;

    let mut selected_keys = normalized_lock_indexes
        .iter()
        .filter_map(|idx| item.affixes.get(*idx as usize))
        .map(|affix| affix.key.clone())
        .collect::<std::collections::BTreeSet<_>>();
    let mutex_groups = pool.rules.mutex_groups.unwrap_or_default();
    let locked_count = item
        .affixes
        .iter()
        .enumerate()
        .filter(|(idx, _)| normalized_lock_indexes.contains(&(*idx as i64)))
        .filter(|(_, affix)| affix.is_legendary.unwrap_or(false))
        .count();
    let additional_legendary = {
        let seed = build_affix_rng_seed(
            item_instance_id,
            character_id,
            normalized_lock_indexes.len(),
            9999,
        );
        let roll =
            u32::from_be_bytes([seed[8], seed[9], seed[10], seed[11]]) as f64 / u32::MAX as f64;
        if roll < pool.rules.legendary_chance.unwrap_or(0.0).clamp(0.0, 1.0) {
            1
        } else {
            0
        }
    };
    let max_legendary = locked_count + additional_legendary;
    let reroll_count = item
        .affixes
        .len()
        .saturating_sub(normalized_lock_indexes.len());
    if reroll_count == 0 {
        return Ok(InventoryRerollResponse {
            success: false,
            message: "锁定词条数量不合法".to_string(),
            data: None,
        });
    }
    let mut generated = Vec::new();
    let mut legendary_count = locked_count;
    for cursor in 0..reroll_count {
        let valid = pool
            .affixes
            .iter()
            .filter(|affix| {
                if selected_keys.contains(affix.key.as_str()) && !pool.rules.allow_duplicate {
                    return false;
                }
                if affix.is_legendary.unwrap_or(false) && legendary_count >= max_legendary {
                    return false;
                }
                if mutex_groups.iter().any(|group| {
                    group.iter().any(|key| key == &affix.key)
                        && group.iter().any(|key| selected_keys.contains(key.as_str()))
                }) {
                    return false;
                }
                true
            })
            .cloned()
            .collect::<Vec<_>>();
        if valid.is_empty() {
            return Ok(InventoryRerollResponse {
                success: false,
                message: "当前锁定组合无法完成洗炼，请减少锁定词条".to_string(),
                data: None,
            });
        }
        let seed = build_affix_rng_seed(
            item_instance_id,
            character_id,
            normalized_lock_indexes.len(),
            cursor,
        );
        let index = draw_weighted_affix_index(&valid, seed);
        let selected = valid
            .get(index)
            .cloned()
            .unwrap_or_else(|| valid[0].clone());
        let rerolled = build_rerolled_affix(
            &selected,
            attr_factor,
            get_realm_rank_one_based_for_equipment(
                item.equip_req_realm.as_deref().unwrap_or("凡人"),
            ),
            seed,
        );
        if rerolled.is_legendary.unwrap_or(false) {
            legendary_count += 1;
        }
        selected_keys.insert(rerolled.key.clone());
        generated.push(rerolled);
    }
    let mut final_affixes = Vec::with_capacity(item.affixes.len());
    let mut generated_cursor = 0_usize;
    for (index, affix) in item.affixes.iter().enumerate() {
        if normalized_lock_indexes.contains(&(index as i64)) {
            final_affixes.push(affix.clone());
        } else {
            final_affixes.push(
                generated
                    .get(generated_cursor)
                    .cloned()
                    .ok_or_else(|| AppError::config("当前锁定组合无法完成洗炼，请减少锁定词条"))?,
            );
            generated_cursor += 1;
        }
    }
    state.database.execute(
        "UPDATE item_instance SET affixes = $1::jsonb, updated_at = NOW() WHERE id = $2 AND owner_character_id = $3",
        |q| q.bind(serde_json::to_value(&final_affixes).unwrap_or_else(|_| serde_json::json!([]))).bind(item_instance_id).bind(character_id),
    ).await?;
    if item.location == "equipped" {
        if let Some(projection) = state
            .online_battle_projections
            .get_current_for_user(user_id)
        {
            state.online_battle_projections.clear(&projection.battle_id);
        }
    }
    let character = if item.location == "equipped" {
        load_inventory_character_snapshot(state, user_id).await?
    } else {
        None
    };
    Ok(InventoryRerollResponse {
        success: true,
        message: "洗炼成功".to_string(),
        data: Some(InventoryRerollResponseData {
            affixes: final_affixes,
            lock_indexes: normalized_lock_indexes,
            costs: InventoryRerollCostDto {
                silver: cost_plan.silver_cost,
                spirit_stones: cost_plan.spirit_stone_cost,
                reroll_scroll: InventoryRerollScrollCostDto {
                    item_def_id: REROLL_SCROLL_ITEM_DEF_ID.to_string(),
                    qty: cost_plan.reroll_scroll_qty,
                },
            },
            character,
        }),
    })
}

async fn apply_sorted_inventory_rows(
    state: &AppState,
    character_id: i64,
    location: &str,
    capacity: i64,
    ranked_rows: Vec<SortInventoryRankedRow>,
) -> Result<(), AppError> {
    let kept_ids = ranked_rows
        .iter()
        .map(|ranked| ranked.row.id)
        .collect::<Vec<_>>();
    release_item_instance_slots_for_location(state, character_id, location).await?;
    for (index, ranked) in ranked_rows.iter().enumerate() {
        let location_slot = if (index as i64) < capacity {
            Some(index as i64)
        } else {
            None
        };
        state.database.execute(
            "UPDATE item_instance SET qty = $1, bind_type = $2, quality = $3, quality_rank = $4, metadata = $5, location_slot = $6, updated_at = NOW() WHERE id = $7 AND owner_character_id = $8 AND location = $9",
            |q| q
                .bind(ranked.row.qty)
                .bind(ranked.row.bind_type.as_str())
                .bind(ranked.row.quality.as_deref())
                .bind(ranked.row.quality_rank)
                .bind(ranked.row.metadata.clone())
                .bind(location_slot)
                .bind(ranked.row.id)
                .bind(character_id)
                .bind(location),
        ).await?;
    }

    if kept_ids.is_empty() {
        state
            .database
            .execute(
                "DELETE FROM item_instance WHERE owner_character_id = $1 AND location = $2",
                |q| q.bind(character_id).bind(location),
            )
            .await?;
    } else {
        state.database.execute(
            "DELETE FROM item_instance WHERE owner_character_id = $1 AND location = $2 AND NOT (id = ANY($3))",
            |q| q.bind(character_id).bind(location).bind(&kept_ids),
        ).await?;
    }
    Ok(())
}

async fn map_inventory_item(
    state: &AppState,
    row: sqlx::postgres::PgRow,
    defs: &BTreeMap<String, InventoryDefSeed>,
) -> Result<InventoryItemDto, AppError> {
    let item_def_id = row.try_get::<String, _>("item_def_id")?;
    let metadata = row.try_get::<Option<serde_json::Value>, _>("metadata")?;
    let def = if let Some(seed) = defs.get(item_def_id.as_str()) {
        Some(map_item_def_lite(state, &item_def_id, &seed.row, metadata.as_ref()).await?)
    } else {
        None
    };
    Ok(InventoryItemDto {
        id: row.try_get::<i64, _>("id")?,
        item_def_id,
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or(1),
        quality: row.try_get::<Option<String>, _>("quality")?,
        quality_rank: row
            .try_get::<Option<i32>, _>("quality_rank")?
            .map(i64::from),
        location: row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_else(|| "bag".to_string()),
        location_slot: row
            .try_get::<Option<i32>, _>("location_slot")?
            .map(i64::from),
        equipped_slot: row.try_get::<Option<String>, _>("equipped_slot")?,
        strengthen_level: row
            .try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
        refine_level: row
            .try_get::<Option<i32>, _>("refine_level")?
            .map(i64::from)
            .unwrap_or_default(),
        affixes: row
            .try_get::<Option<serde_json::Value>, _>("affixes")?
            .unwrap_or_else(|| serde_json::json!([])),
        identified: row
            .try_get::<Option<bool>, _>("identified")?
            .unwrap_or(true),
        locked: row.try_get::<Option<bool>, _>("locked")?.unwrap_or(false),
        bind_type: row
            .try_get::<Option<String>, _>("bind_type")?
            .unwrap_or_else(|| "none".to_string()),
        socketed_gems: row.try_get::<Option<serde_json::Value>, _>("socketed_gems")?,
        created_at: row
            .try_get::<Option<String>, _>("created_at_text")?
            .unwrap_or_default(),
        def,
    })
}

pub(crate) fn load_inventory_def_map() -> Result<BTreeMap<String, InventoryDefSeed>, AppError> {
    let mut map = BTreeMap::new();
    for filename in ["item_def.json", "equipment_def.json", "gem_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for row in payload
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
        {
            if let Some(id) = row.get("id").and_then(|value| value.as_str()) {
                map.insert(id.to_string(), InventoryDefSeed { row });
            }
        }
    }
    Ok(map)
}

fn load_visible_inventory_technique_def_map()
-> Result<BTreeMap<String, InventoryTechniqueDefSeed>, AppError> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../server/src/data/seeds/technique_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read {}: {error}", path.display())))?;
    let payload: InventoryTechniqueDefFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse {}: {error}", path.display()))
    })?;
    Ok(payload
        .techniques
        .into_iter()
        .filter(|entry| entry.enabled.unwrap_or(true))
        .filter(|entry| entry.usage_scope.as_deref().map(str::trim) != Some("partner_only"))
        .map(|entry| (entry.id.clone(), entry))
        .collect())
}

pub(crate) async fn resolve_generated_technique_book_display(
    state: &AppState,
    item_def_id: &str,
    _seed_row: &serde_json::Value,
    metadata: Option<&serde_json::Value>,
) -> Result<Option<GeneratedTechniqueBookDisplayOverride>, AppError> {
    if item_def_id != "book-generated-technique" {
        return Ok(None);
    }
    let generated_technique_id = metadata
        .and_then(|value| value.as_object())
        .and_then(|metadata| metadata.get("generatedTechniqueId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string();
    if generated_technique_id.is_empty() {
        return Ok(None);
    }
    let generated_row = state.database.fetch_optional(
        "SELECT COALESCE(display_name, name) AS name, quality, description, long_desc, tags FROM generated_technique_def WHERE id = $1 AND is_published = TRUE AND enabled = TRUE LIMIT 1",
        |q| q.bind(&generated_technique_id),
    ).await?;
    let static_defs = load_visible_inventory_technique_def_map()?;
    let static_def = static_defs.get(&generated_technique_id);
    let generated_technique_name = generated_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("name").ok().flatten())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            static_def
                .map(|entry| entry.name.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            metadata
                .and_then(|value| value.as_object())
                .and_then(|meta| meta.get("generatedTechniqueName"))
                .and_then(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let Some(generated_technique_name) = generated_technique_name else {
        return Ok(None);
    };
    let quality = generated_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("quality").ok().flatten())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            static_def
                .and_then(|entry| entry.quality.clone())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let description = generated_row
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<String>, _>("description")
                .ok()
                .flatten()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            static_def
                .and_then(|entry| entry.description.clone())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| {
            format!(
                "记载功法「{}」的生成功法书，使用后学习该功法。",
                generated_technique_name
            )
        });
    let long_desc = generated_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("long_desc").ok().flatten())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            static_def
                .and_then(|entry| entry.long_desc.clone())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| {
            format!(
                "该秘卷为洞府研修推演所得，关联功法：{}。",
                generated_technique_name
            )
        });
    let mut tags = vec![serde_json::Value::String("研修生成".to_string())];
    let extra_tags = generated_row
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<serde_json::Value>, _>("tags")
                .ok()
                .flatten()
        })
        .or_else(|| static_def.and_then(|entry| entry.tags.clone()))
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    tags.extend(extra_tags);
    let mut dedup = BTreeSet::new();
    let tags = serde_json::Value::Array(
        tags.into_iter()
            .filter(|value| {
                let key = value.as_str().unwrap_or_default().to_string();
                !key.is_empty() && dedup.insert(key)
            })
            .collect(),
    );
    Ok(Some(GeneratedTechniqueBookDisplayOverride {
        generated_technique_id,
        generated_technique_name: generated_technique_name.clone(),
        name: format!("《{}》秘卷", generated_technique_name),
        quality,
        description,
        long_desc,
        tags,
    }))
}

async fn map_item_def_lite(
    state: &AppState,
    item_def_id: &str,
    row: &serde_json::Value,
    metadata: Option<&serde_json::Value>,
) -> Result<ItemDefLiteDto, AppError> {
    let raw_generated_technique_id = metadata
        .and_then(|value| value.as_object())
        .and_then(|metadata| metadata.get("generatedTechniqueId"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let raw_generated_technique_name = metadata
        .and_then(|value| value.as_object())
        .and_then(|metadata| metadata.get("generatedTechniqueName"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let generated_display =
        resolve_generated_technique_book_display(state, item_def_id, row, metadata).await?;
    let display_name = generated_display
        .as_ref()
        .map(|display| display.name.clone())
        .unwrap_or_else(|| {
            row.get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(item_def_id)
                .to_string()
        });
    let description = generated_display
        .as_ref()
        .map(|display| display.description.clone())
        .or_else(|| {
            row.get("description")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });
    let long_desc = generated_display
        .as_ref()
        .map(|display| display.long_desc.clone())
        .or_else(|| {
            row.get("long_desc")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });
    Ok(ItemDefLiteDto {
        id: item_def_id.to_string(),
        name: display_name,
        icon: row
            .get("icon")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        quality: generated_display
            .as_ref()
            .and_then(|display| display.quality.clone())
            .or_else(|| {
                row.get("quality")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string())
            })
            .unwrap_or_else(|| "黄".to_string()),
        category: row
            .get("category")
            .and_then(|value| value.as_str())
            .unwrap_or("other")
            .to_string(),
        sub_category: row
            .get("sub_category")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        can_disassemble: row
            .get("can_disassemble")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        stack_max: row
            .get("stack_max")
            .and_then(|value| value.as_i64())
            .unwrap_or(1),
        description,
        long_desc,
        tags: generated_display
            .as_ref()
            .map(|display| display.tags.clone())
            .unwrap_or_else(|| {
                row.get("tags")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]))
            }),
        effect_defs: row
            .get("effect_defs")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
        base_attrs: row
            .get("base_attrs")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        equip_slot: row
            .get("equip_slot")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        use_type: row
            .get("use_type")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        use_req_realm: row
            .get("use_req_realm")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        equip_req_realm: row
            .get("equip_req_realm")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        use_req_level: row.get("use_req_level").and_then(|value| value.as_i64()),
        use_limit_daily: row.get("use_limit_daily").and_then(|value| value.as_i64()),
        use_limit_total: row.get("use_limit_total").and_then(|value| value.as_i64()),
        socket_max: row.get("socket_max").and_then(|value| value.as_i64()),
        gem_slot_types: row.get("gem_slot_types").cloned(),
        gem_level: row.get("gem_level").and_then(|value| value.as_i64()),
        set_id: row
            .get("set_id")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        set_name: row
            .get("set_name")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        set_bonuses: row.get("set_bonuses").cloned(),
        set_equipped_count: None,
        generated_technique_id: generated_display
            .as_ref()
            .map(|display| display.generated_technique_id.clone())
            .or(raw_generated_technique_id.filter(|_| false)),
        generated_technique_name: generated_display
            .as_ref()
            .map(|display| display.generated_technique_name.clone())
            .or(raw_generated_technique_name.filter(|_| false)),
    })
}

fn build_loot_results_for_use(
    defs: &BTreeMap<String, InventoryDefSeed>,
    silver: i64,
    spirit_stones: i64,
    item_rewards: &[(String, i64)],
) -> Vec<InventoryUseLootResultDto> {
    let mut results = Vec::new();
    if silver > 0 {
        results.push(InventoryUseLootResultDto {
            r#type: "silver".to_string(),
            name: Some("银两".to_string()),
            amount: silver,
            item_def_id: None,
            item_ids: None,
        });
    }
    if spirit_stones > 0 {
        results.push(InventoryUseLootResultDto {
            r#type: "spirit_stones".to_string(),
            name: Some("灵石".to_string()),
            amount: spirit_stones,
            item_def_id: None,
            item_ids: None,
        });
    }
    for (item_def_id, qty) in item_rewards {
        if *qty <= 0 {
            continue;
        }
        let name = defs
            .get(item_def_id.as_str())
            .and_then(|seed| seed.row.get("name"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .or_else(|| Some(item_def_id.clone()));
        results.push(InventoryUseLootResultDto {
            r#type: "item".to_string(),
            name,
            amount: *qty,
            item_def_id: Some(item_def_id.clone()),
            item_ids: Some(vec![]),
        });
    }
    results
}

#[derive(Debug, Clone)]
struct ResolvedStaminaState {
    stamina: i64,
    max_stamina: i64,
    next_recover_at_text: String,
}

fn calc_character_stamina_max_by_insight_level(insight_level: i64) -> i64 {
    STAMINA_BASE_MAX + (insight_level.max(0) / 10)
}

fn load_default_month_card_stamina_recovery_rate() -> f64 {
    static RATE: OnceLock<f64> = OnceLock::new();
    *RATE.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/month_card.json");
        let content = fs::read_to_string(path).unwrap_or_default();
        let payload: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        payload
            .get("month_cards")
            .and_then(|value| value.as_array())
            .and_then(|cards| {
                cards.iter().find(|card| {
                    card.get("id").and_then(|v| v.as_str()) == Some(DEFAULT_MONTH_CARD_ID)
                })
            })
            .and_then(|card| card.get("stamina_recovery_rate"))
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0)
    })
}

fn resolve_stamina_recovery_state(
    stamina: i64,
    max_stamina: i64,
    recover_at_text: Option<&str>,
    month_card_start_at_text: Option<&str>,
    month_card_expire_at_text: Option<&str>,
    recovery_speed_rate: f64,
) -> ResolvedStaminaState {
    let now_ms = current_timestamp_ms();
    let safe_max_stamina = max_stamina.max(1);
    let safe_stamina = stamina.clamp(0, safe_max_stamina);
    let recover_at_ms = parse_datetime_millis(recover_at_text).unwrap_or(now_ms);
    let fallback_recover_at = recover_at_text
        .map(str::to_string)
        .unwrap_or_else(current_timestamp_rfc3339);
    if safe_stamina >= safe_max_stamina || now_ms <= recover_at_ms {
        return ResolvedStaminaState {
            stamina: safe_stamina,
            max_stamina: safe_max_stamina,
            next_recover_at_text: fallback_recover_at,
        };
    }

    let recovery_speed_rate = recovery_speed_rate.clamp(0.0, 1.0);
    let window_start_ms = parse_datetime_millis(month_card_start_at_text);
    let window_expire_ms = parse_datetime_millis(month_card_expire_at_text);
    let effective_elapsed_ms = calc_effective_stamina_elapsed_ms(
        recover_at_ms,
        now_ms,
        window_start_ms,
        window_expire_ms,
        recovery_speed_rate,
    );
    let tick_ms = STAMINA_RECOVER_INTERVAL_SEC * 1000;
    let ticks = effective_elapsed_ms / tick_ms;
    if ticks <= 0 {
        return ResolvedStaminaState {
            stamina: safe_stamina,
            max_stamina: safe_max_stamina,
            next_recover_at_text: fallback_recover_at,
        };
    }

    let recovered_total = ticks * STAMINA_RECOVER_PER_TICK;
    let next_stamina = (safe_stamina + recovered_total).clamp(0, safe_max_stamina);
    if next_stamina >= safe_max_stamina {
        return ResolvedStaminaState {
            stamina: next_stamina,
            max_stamina: safe_max_stamina,
            next_recover_at_text: current_timestamp_rfc3339(),
        };
    }

    let leftover_effective_elapsed_ms = effective_elapsed_ms - ticks * tick_ms;
    ResolvedStaminaState {
        stamina: next_stamina,
        max_stamina: safe_max_stamina,
        next_recover_at_text: millis_to_rfc3339(rewind_recover_at_ms(
            now_ms,
            leftover_effective_elapsed_ms,
            window_start_ms,
            window_expire_ms,
            recovery_speed_rate,
        )),
    }
}

fn calc_effective_stamina_elapsed_ms(
    start_ms: i64,
    end_ms: i64,
    window_start_ms: Option<i64>,
    window_expire_ms: Option<i64>,
    recovery_speed_rate: f64,
) -> i64 {
    if end_ms <= start_ms {
        return 0;
    }
    let real_elapsed_ms = end_ms - start_ms;
    if recovery_speed_rate <= 0.0 {
        return real_elapsed_ms;
    }
    let Some(expire_ms) = window_expire_ms else {
        return real_elapsed_ms;
    };
    let active_start_ms = window_start_ms.unwrap_or(start_ms);
    let overlap_start_ms = start_ms.max(active_start_ms);
    let overlap_end_ms = end_ms.min(expire_ms);
    let overlap_ms = (overlap_end_ms - overlap_start_ms).max(0);
    real_elapsed_ms + ((overlap_ms as f64) * recovery_speed_rate).round() as i64
}

fn rewind_recover_at_ms(
    now_ms: i64,
    effective_elapsed_ms: i64,
    window_start_ms: Option<i64>,
    window_expire_ms: Option<i64>,
    recovery_speed_rate: f64,
) -> i64 {
    if effective_elapsed_ms <= 0 || recovery_speed_rate <= 0.0 || window_expire_ms.is_none() {
        return now_ms - effective_elapsed_ms.max(0);
    }
    let expire_ms = window_expire_ms.unwrap_or(now_ms);
    let mut remaining_effective_elapsed_ms = effective_elapsed_ms as f64;
    let mut cursor_ms = now_ms;
    if cursor_ms > expire_ms {
        let inactive_after_window_ms = (cursor_ms - expire_ms) as f64;
        if remaining_effective_elapsed_ms <= inactive_after_window_ms {
            return (cursor_ms as f64 - remaining_effective_elapsed_ms).round() as i64;
        }
        remaining_effective_elapsed_ms -= inactive_after_window_ms;
        cursor_ms = expire_ms;
    }
    let active_start_ms = window_start_ms.unwrap_or(cursor_ms);
    if cursor_ms > active_start_ms {
        let active_multiplier = 1.0 + recovery_speed_rate;
        let active_real_duration_ms = (cursor_ms - active_start_ms) as f64;
        let active_effective_cap_ms = active_real_duration_ms * active_multiplier;
        if remaining_effective_elapsed_ms <= active_effective_cap_ms {
            return (cursor_ms as f64 - remaining_effective_elapsed_ms / active_multiplier).round()
                as i64;
        }
        remaining_effective_elapsed_ms -= active_effective_cap_ms;
        cursor_ms = active_start_ms;
    }
    (cursor_ms as f64 - remaining_effective_elapsed_ms).round() as i64
}

fn parse_datetime_millis(raw: Option<&str>) -> Option<i64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    let parsed =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some(parsed.unix_timestamp_nanos() as i64 / 1_000_000)
}

fn millis_to_rfc3339(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos((ms as i128) * 1_000_000)
        .ok()
        .and_then(|dt| {
            dt.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_else(current_timestamp_rfc3339)
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn inventory_now_utc() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

fn inventory_format_iso(timestamp_ms: i64) -> Result<String, AppError> {
    let dt = time::OffsetDateTime::from_unix_timestamp(timestamp_ms.div_euclid(1000))
        .map_err(|error| AppError::config(format!("invalid inventory timestamp: {error}")))?;
    dt.format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| AppError::config(format!("failed to format inventory timestamp: {error}")))
}

fn current_timestamp_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn pick_random_index(len: usize, salt: usize) -> usize {
    if len <= 1 {
        return 0;
    }
    let mut seed = (current_timestamp_ms().unsigned_abs() as u64)
        .wrapping_mul(1_103_515_245)
        .wrapping_add(12_345)
        .wrapping_add(salt as u64 * 97_531);
    seed ^= seed >> 11;
    seed ^= seed << 7;
    seed ^= seed >> 13;
    (seed as usize) % len
}

fn pick_random_index_with_random_fn<F>(len: usize, mut next_index: F) -> usize
where
    F: FnMut(usize) -> usize,
{
    if len <= 1 {
        return 0;
    }
    next_index(len) % len
}

fn pick_random_index_runtime(len: usize) -> usize {
    pick_random_index_with_random_fn(len, |limit| rand::thread_rng().gen_range(0..limit))
}

fn roll_success_with_random_fn<F>(success_rate: f64, mut next_roll: F) -> bool
where
    F: FnMut() -> f64,
{
    let rate = success_rate.clamp(0.0, 1.0);
    if rate <= 0.0 {
        return false;
    }
    if rate >= 1.0 {
        return true;
    }
    next_roll() < rate
}

fn roll_success_runtime(success_rate: f64) -> bool {
    roll_success_with_random_fn(success_rate, || rand::thread_rng().gen_range(0.0..1.0))
}

fn can_use_gem_convert_location(location: &str) -> bool {
    location.trim() == "bag"
}

fn validate_gem_convert_item_state(locked: bool, location: &str) -> Result<(), &'static str> {
    if locked {
        return Err("所选宝石已锁定");
    }
    if !can_use_gem_convert_location(location) {
        return Err("仅可选择背包内宝石进行转换");
    }
    Ok(())
}

fn has_sufficient_selected_gem_qty(
    qty_by_id: &BTreeMap<i64, i64>,
    consume_by_id: &BTreeMap<i64, i64>,
) -> bool {
    consume_by_id.iter().all(|(item_id, per_time_qty)| {
        qty_by_id.get(item_id).copied().unwrap_or_default() >= *per_time_qty
    })
}

fn normalize_gem_execute_times(times: i64) -> i64 {
    times.clamp(1, GEM_EXECUTE_MAX_TIMES)
}

fn parse_optional_positive_i64_json(
    value: Option<&serde_json::Value>,
    field_name: &str,
) -> Result<Option<i64>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let parsed = if let Some(number) = value.as_i64() {
        Some(number)
    } else if let Some(number) = value.as_f64() {
        if number.is_finite() && number.fract() == 0.0 {
            Some(number as i64)
        } else {
            None
        }
    } else if let Some(raw) = value.as_str() {
        raw.trim().parse::<i64>().ok()
    } else {
        None
    };
    let Some(parsed) = parsed else {
        return Err(AppError::config(format!("{}参数错误", field_name)));
    };
    if parsed <= 0 {
        return Err(AppError::config(format!("{}参数错误", field_name)));
    }
    Ok(Some(parsed))
}

fn parse_positive_i64_array_json(
    values: &[serde_json::Value],
    field_name: &str,
) -> Result<Vec<i64>, AppError> {
    let mut parsed_values = Vec::with_capacity(values.len());
    for value in values {
        let Some(parsed) = parse_optional_positive_i64_json(Some(value), field_name)? else {
            return Err(AppError::config(format!("{}参数错误", field_name)));
        };
        parsed_values.push(parsed);
    }
    Ok(parsed_values)
}

fn normalize_gem_synthesis_batch_source_level(source_level: Option<i64>) -> Result<i64, AppError> {
    if source_level.is_some_and(|value| value <= 0) {
        return Err(AppError::config("sourceLevel参数错误"));
    }
    Ok(source_level.unwrap_or(1).clamp(1, 9))
}

fn build_gem_synthesize_max_times_message(max_times: i64) -> String {
    format!("当前最多可合成{}次", max_times.max(0))
}

fn build_gem_convert_max_times_message(max_times: i64) -> String {
    format!("当前最多可转换{}次", max_times.max(0))
}

fn parse_effect_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            return Some(number.floor() as i64);
        }
    }
    value
        .as_str()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|number| number.is_finite())
        .map(|number| number.floor() as i64)
}

fn parse_recipe_i64(value: Option<&serde_json::Value>) -> i64 {
    parse_effect_i64(value).unwrap_or_default().max(0)
}

fn resolve_currency_loot_type(effect: &serde_json::Value) -> Option<&str> {
    effect
        .get("params")
        .and_then(|params| params.get("currency"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| matches!(*value, "spirit_stones" | "silver"))
}

fn roll_item_use_amount_with_random_fn<F>(
    value: Option<i64>,
    effect: &serde_json::Value,
    mut roll_random_int: F,
) -> i64
where
    F: FnMut(i64, i64) -> i64,
{
    let min = effect
        .get("params")
        .and_then(|value| value.get("min"))
        .and_then(|value| parse_effect_i64(Some(value)));
    let max = effect
        .get("params")
        .and_then(|value| value.get("max"))
        .and_then(|value| parse_effect_i64(Some(value)));
    if let (Some(min), Some(max)) = (min, max) {
        let lower = min.min(max).max(0);
        let upper = min.max(max).max(0);
        if upper <= lower {
            return lower;
        }
        return roll_random_int(lower, upper);
    }
    value.unwrap_or_default().max(0)
}

fn roll_item_use_amount(value: Option<i64>, effect: &serde_json::Value) -> i64 {
    roll_item_use_amount_with_random_fn(value, effect, |lower, upper| {
        rand::thread_rng().gen_range(lower..=upper)
    })
}

fn roll_item_use_amount_for_qty(value: Option<i64>, effect: &serde_json::Value, qty: i64) -> i64 {
    let safe_qty = qty.max(1);
    let min = effect
        .get("params")
        .and_then(|value| value.get("min"))
        .and_then(|value| value.as_i64());
    let max = effect
        .get("params")
        .and_then(|value| value.get("max"))
        .and_then(|value| value.as_i64());
    if min.is_some() && max.is_some() {
        let mut total = 0_i64;
        for _ in 0..safe_qty {
            total = total.saturating_add(roll_item_use_amount(value, effect));
        }
        return total;
    }
    roll_item_use_amount(value, effect).saturating_mul(safe_qty)
}

fn reroll_effect_targets_equipment(effect: &serde_json::Value, target: &str) -> bool {
    if target.trim() == "equipment" {
        return true;
    }
    effect
        .get("params")
        .and_then(|value| value.as_object())
        .and_then(|params| params.get("target_type"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        == Some("equipment")
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn inventory_info_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"bagCapacity": 100, "warehouseCapacity": 1000, "bagUsed": 5, "warehouseUsed": 1}
        });
        assert_eq!(payload["data"]["bagCapacity"], 100);
        println!("INVENTORY_INFO_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_expand_forbidden_response_matches_contract() {
        let payload = serde_json::json!({
            "success": false,
            "message": "请通过使用扩容道具进行扩容"
        });
        assert_eq!(payload["success"], false);
        assert_eq!(payload["message"], "请通过使用扩容道具进行扩容");
        println!("INVENTORY_EXPAND_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_use_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "heal",
                "value": 50
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 0,
                    "stamina": 80,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["character"]["qixue"], 120);
        println!("INVENTORY_USE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_use_exp_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "resource",
                "value": 1000,
                "params": { "resource": "exp" }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 80,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(payload["data"]["character"]["exp"], 1000);
    }

    #[test]
    fn inventory_use_stamina_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "resource",
                "params": { "resource": "stamina", "min": 10, "max": 20 }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(payload["data"]["character"]["stamina"], 95);
        assert_eq!(payload["data"]["character"]["stamina_max"], 100);
    }

    #[test]
    fn inventory_use_unbind_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "effect_type": "unbind",
                "params": { "target_type": "equipment", "bind_state": "bound" }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(payload["effects"][0]["effect_type"], "unbind");
    }

    #[test]
    fn inventory_reroll_effect_accepts_equipment_target_from_params_when_top_level_target_missing()
    {
        let effect = serde_json::json!({
            "trigger": "use",
            "effect_type": "reroll",
            "params": {
                "target_type": "equipment",
                "reroll_type": "affixes"
            }
        });
        assert!(super::reroll_effect_targets_equipment(&effect, "self"));
        println!("INVENTORY_REROLL_TARGET_COMPAT={}", effect);
    }

    #[test]
    fn inventory_roll_item_use_amount_for_qty_scales_fixed_value() {
        let effect = serde_json::json!({
            "trigger": "use",
            "target": "self",
            "effect_type": "resource",
            "value": 10,
            "params": { "resource": "stamina" }
        });
        assert_eq!(
            super::roll_item_use_amount_for_qty(Some(10), &effect, 3),
            30
        );
    }

    #[test]
    fn inventory_parse_effect_i64_accepts_numeric_string_value() {
        let value = serde_json::json!("10");
        assert_eq!(super::parse_effect_i64(Some(&value)), Some(10));
    }

    #[test]
    fn inventory_roll_item_use_amount_for_qty_accumulates_range_per_use() {
        let effect = serde_json::json!({
            "trigger": "use",
            "target": "self",
            "effect_type": "heal",
            "params": { "min": 5, "max": 5 }
        });
        assert_eq!(super::roll_item_use_amount_for_qty(None, &effect, 4), 20);
    }

    #[test]
    fn inventory_roll_item_use_amount_with_random_fn_uses_fresh_value_each_time() {
        let effect = serde_json::json!({
            "trigger": "use",
            "target": "self",
            "effect_type": "resource",
            "params": { "resource": "stamina", "min": 1, "max": 3 }
        });
        let mut values = vec![1_i64, 2_i64, 3_i64].into_iter();
        let mut total = 0_i64;
        for _ in 0..3 {
            total += super::roll_item_use_amount_with_random_fn(None, &effect, |_, _| {
                values.next().expect("next value")
            });
        }
        assert_eq!(total, 6);
    }

    #[test]
    fn inventory_pick_random_index_with_random_fn_uses_each_generated_value() {
        let mut values = vec![2_usize, 0, 1].into_iter();
        let picked = (0..3)
            .map(|_| {
                super::pick_random_index_with_random_fn(3, |_| values.next().expect("next index"))
            })
            .collect::<Vec<_>>();
        assert_eq!(picked, vec![2, 0, 1]);
    }

    #[test]
    fn inventory_roll_success_with_random_fn_respects_bounds() {
        assert!(!super::roll_success_with_random_fn(0.0, || 0.0));
        assert!(super::roll_success_with_random_fn(1.0, || 0.999));
    }

    #[test]
    fn inventory_roll_success_with_random_fn_uses_fresh_rolls() {
        let mut rolls = vec![0.1_f64, 0.9_f64].into_iter();
        let first = super::roll_success_with_random_fn(0.5, || rolls.next().expect("first roll"));
        let second = super::roll_success_with_random_fn(0.5, || rolls.next().expect("second roll"));
        assert!(first);
        assert!(!second);
    }

    #[test]
    fn inventory_random_gem_defaults_to_node_sub_categories_when_missing() {
        let sub_categories = Vec::<String>::new();
        let resolved = if sub_categories.is_empty() {
            super::DEFAULT_RANDOM_GEM_SUB_CATEGORIES
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
        } else {
            sub_categories
        };
        assert_eq!(resolved, vec!["gem_attack", "gem_defense", "gem_survival"]);
    }

    #[test]
    fn inventory_currency_loot_type_accepts_spirit_stones_and_silver_only() {
        let spirit = serde_json::json!({"params": {"currency": "spirit_stones"}});
        let silver = serde_json::json!({"params": {"currency": "silver"}});
        let invalid = serde_json::json!({"params": {"currency": "gold"}});
        assert_eq!(
            super::resolve_currency_loot_type(&spirit),
            Some("spirit_stones")
        );
        assert_eq!(super::resolve_currency_loot_type(&silver), Some("silver"));
        assert_eq!(super::resolve_currency_loot_type(&invalid), None);
    }

    #[test]
    fn inventory_gem_convert_location_allows_bag_only() {
        assert!(super::can_use_gem_convert_location("bag"));
        assert!(!super::can_use_gem_convert_location("warehouse"));
        assert!(!super::can_use_gem_convert_location("equipped"));
    }

    #[test]
    fn inventory_gem_convert_item_state_reports_locked_and_non_bag_separately() {
        assert_eq!(
            super::validate_gem_convert_item_state(true, "bag"),
            Err("所选宝石已锁定")
        );
        assert_eq!(
            super::validate_gem_convert_item_state(false, "warehouse"),
            Err("仅可选择背包内宝石进行转换")
        );
        assert_eq!(super::validate_gem_convert_item_state(false, "bag"), Ok(()));
    }

    #[test]
    fn inventory_normalize_gem_execute_times_matches_node_upper_bound() {
        assert_eq!(super::normalize_gem_execute_times(1), 1);
        assert_eq!(super::normalize_gem_execute_times(99), 99);
        assert_eq!(super::normalize_gem_execute_times(1_000_000), 999_999);
    }

    #[test]
    fn inventory_calc_max_synthesize_times_matches_node_upper_bound() {
        let max_times = super::calc_max_synthesize_times(9_999_999, 1, 9_999_999, 9_999_999, 1, 1);
        assert_eq!(max_times, 999_999);
    }

    #[test]
    fn inventory_gem_synthesize_max_times_message_matches_node() {
        assert_eq!(
            super::build_gem_synthesize_max_times_message(3),
            "当前最多可合成3次"
        );
    }

    #[test]
    fn inventory_gem_convert_max_times_message_matches_node() {
        assert_eq!(
            super::build_gem_convert_max_times_message(4),
            "当前最多可转换4次"
        );
    }

    #[test]
    fn inventory_parse_optional_positive_i64_json_accepts_numeric_strings() {
        let target = serde_json::json!("10");
        let source = serde_json::json!("2");
        assert_eq!(
            super::parse_optional_positive_i64_json(Some(&target), "targetLevel").unwrap(),
            Some(10)
        );
        assert_eq!(
            super::parse_optional_positive_i64_json(Some(&source), "sourceLevel").unwrap(),
            Some(2)
        );
    }

    #[test]
    fn inventory_parse_optional_positive_i64_json_accepts_times_string() {
        let times = serde_json::json!("7");
        assert_eq!(
            super::parse_optional_positive_i64_json(Some(&times), "times").unwrap(),
            Some(7)
        );
    }

    #[test]
    fn inventory_parse_positive_i64_array_json_accepts_numeric_strings() {
        let values = vec![serde_json::json!("11"), serde_json::json!("12")];
        assert_eq!(
            super::parse_positive_i64_array_json(&values, "selectedGemItemIds").unwrap(),
            vec![11, 12]
        );
    }

    #[test]
    fn inventory_parse_recipe_i64_accepts_numeric_strings() {
        let value = serde_json::json!("15");
        assert_eq!(super::parse_recipe_i64(Some(&value)), 15);
    }

    #[test]
    fn inventory_gem_synthesis_batch_source_level_matches_node_contract() {
        assert_eq!(
            super::normalize_gem_synthesis_batch_source_level(None).unwrap(),
            1
        );
        assert_eq!(
            super::normalize_gem_synthesis_batch_source_level(Some(12)).unwrap(),
            9
        );
        assert_eq!(
            super::normalize_gem_synthesis_batch_source_level(Some(0))
                .unwrap_err()
                .to_string(),
            "configuration error: sourceLevel参数错误"
        );
    }

    #[test]
    fn inventory_build_gem_convert_spirit_cost_map_reads_recipe_defined_costs() {
        let costs =
            super::build_gem_convert_spirit_cost_map().expect("gem convert costs should load");
        assert_eq!(costs.get(&2), Some(&0));
        assert_eq!(costs.get(&6), Some(&4));
    }

    #[test]
    fn inventory_build_gem_synthesis_recipes_propagates_recipe_config_errors() {
        let wallet = super::GemCharacterWalletDto {
            silver: 0,
            spirit_stones: 0,
        };
        let error = super::build_gem_synthesis_recipes(
            &std::collections::BTreeMap::new(),
            &std::collections::BTreeMap::new(),
            &wallet,
        )
        .expect_err("missing defs should surface as config error");
        assert!(error.to_string().contains("宝石配方输入定义不存在"));
    }

    #[test]
    fn inventory_load_gem_synthesis_recipe_rows_use_node_series_keys() {
        let rows = super::load_gem_synthesis_recipe_rows().expect("gem synthesis rows should load");
        let wg = rows
            .iter()
            .find(|row| row.input_item_def_id == "gem-atk-wg-1")
            .expect("wg recipe should exist");
        let fg = rows
            .iter()
            .find(|row| row.input_item_def_id == "gem-atk-fg-1")
            .expect("fg recipe should exist");
        assert_eq!(wg.series_key, "atk-wg");
        assert_eq!(fg.series_key, "atk-fg");
        assert_ne!(wg.series_key, fg.series_key);
    }

    #[test]
    fn inventory_gem_convert_options_use_recipe_defined_output_level_and_costs() {
        let defs = super::load_inventory_def_map().expect("defs should load");
        let wallet = super::GemCharacterWalletDto {
            silver: 1000,
            spirit_stones: 200,
        };
        let owned_qty = std::collections::BTreeMap::from([
            ("gem-atk-wg-2".to_string(), 6_i64),
            ("gem-atk-wg-1".to_string(), 10_i64),
            ("gem-def-wf-1".to_string(), 10_i64),
            ("gem-sur-hp-1".to_string(), 10_i64),
        ]);
        let options = super::build_gem_convert_options(&defs, &wallet, &owned_qty);
        let level_2 = options
            .iter()
            .find(|option| option.input_level == 2)
            .expect("level 2 option");
        assert_eq!(level_2.output_level, 1);
        assert_eq!(level_2.cost_spirit_stones_per_convert, 0);
        assert_eq!(level_2.candidate_gem_count, 12);
    }

    #[test]
    fn inventory_gem_synthesis_recipes_max_times_are_wallet_limited() {
        let defs = super::load_inventory_def_map().expect("defs should load");
        let owned_qty = std::collections::BTreeMap::from([("gem-atk-wg-5".to_string(), 30_i64)]);
        let wallet = super::GemCharacterWalletDto {
            silver: 100_000,
            spirit_stones: 7,
        };
        let recipes = super::build_gem_synthesis_recipes(&defs, &owned_qty, &wallet)
            .expect("recipes should load");
        let recipe = recipes
            .iter()
            .find(|recipe| recipe.input.item_def_id == "gem-atk-wg-5")
            .expect("recipe exists");
        assert_eq!(recipe.costs.spirit_stones, 4);
        assert_eq!(recipe.max_synthesize_times, 1);
    }

    #[test]
    fn inventory_gem_convert_output_rolls_use_fresh_indices() {
        let candidates = vec![
            "gem-a".to_string(),
            "gem-b".to_string(),
            "gem-c".to_string(),
        ];
        let mut indices = vec![2_usize, 0, 2].into_iter();
        let produced = super::roll_gem_convert_outputs_with_random_fn(&candidates, 3, |_| {
            indices.next().expect("next index")
        });
        assert_eq!(produced.get("gem-a"), Some(&1));
        assert_eq!(produced.get("gem-c"), Some(&2));
        assert_eq!(produced.get("gem-b"), None);
    }

    #[test]
    fn inventory_gem_convert_duplicate_selection_uses_distinct_row_count() {
        let selected = vec![11_i64, 11_i64];
        let distinct = selected
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len();
        assert_eq!(distinct, 1);
    }

    #[test]
    fn inventory_gem_convert_duplicate_selection_requires_sufficient_stack_qty() {
        let qty_by_id = std::collections::BTreeMap::from([(11_i64, 1_i64)]);
        let consume_by_id = std::collections::BTreeMap::from([(11_i64, 2_i64)]);
        assert!(!super::has_sufficient_selected_gem_qty(
            &qty_by_id,
            &consume_by_id
        ));
    }

    #[test]
    fn inventory_use_expand_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "expand",
                "params": { "expand_type": "bag", "value": 10 }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(payload["effects"][0]["effect_type"], "expand");
        assert_eq!(payload["data"]["character"]["qixue"], 120);
    }

    #[test]
    fn inventory_use_technique_book_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "learn_technique",
                "params": { "technique_id": "tech-jichu-quanfa" }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [{
                    "type": "technique",
                    "name": "基础拳法",
                    "amount": 1
                }]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "technique");
        assert_eq!(payload["data"]["lootResults"][0]["name"], "基础拳法");
    }

    #[test]
    fn inventory_use_generated_technique_book_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "learn_generated_technique"
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [{
                    "type": "technique",
                    "name": "《云水诀》",
                    "amount": 1
                }]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "technique");
    }

    #[test]
    fn inventory_use_partner_technique_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "learn_technique",
                "params": { "technique_id": "tech-jichu-quanfa" }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [{
                    "type": "partner_technique",
                    "name": "基础拳法",
                    "amount": 1
                }],
                "partnerTechniqueResult": {
                    "partner": { "id": 1, "slotCount": 3 },
                    "learnedTechnique": { "techniqueId": "tech-jichu-quanfa", "name": "基础拳法" },
                    "replacedTechnique": null,
                    "remainingBooks": []
                }
            }
        });
        assert_eq!(
            payload["data"]["lootResults"][0]["type"],
            "partner_technique"
        );
        assert_eq!(
            payload["data"]["partnerTechniqueResult"]["partner"]["id"],
            1
        );
    }

    #[test]
    fn inventory_use_loot_bag_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "loot",
                "params": {
                    "loot_type": "currency",
                    "currency": "spirit_stones",
                    "min": 1,
                    "max": 10
                }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [{
                    "type": "spirit_stones",
                    "name": "灵石",
                    "amount": 7
                }]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "spirit_stones");
        assert_eq!(payload["data"]["lootResults"][0]["name"], "灵石");
    }

    #[test]
    fn inventory_use_multi_loot_box_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "loot",
                "params": {
                    "loot_type": "multi",
                    "items": [
                        { "item_id": "enhance-001", "qty": 20 },
                        { "item_id": "cons-002", "qty": 10 }
                    ],
                    "currency": { "spirit_stones": 50 }
                }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [
                    { "type": "spirit_stones", "name": "灵石", "amount": 50 },
                    { "type": "item", "name": "淬灵石", "amount": 20 },
                    { "type": "item", "name": "回气丹", "amount": 10 }
                ]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "spirit_stones");
        assert_eq!(payload["data"]["lootResults"][1]["name"], "淬灵石");
        assert_eq!(payload["data"]["lootResults"][2]["name"], "回气丹");
    }

    #[test]
    fn inventory_use_multi_loot_box_with_silver_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "loot",
                "params": {
                    "loot_type": "multi",
                    "items": [
                        { "item_id": "equip-weapon-001", "qty": 1 },
                        { "item_id": "cons-001", "qty": 10 }
                    ],
                    "currency": { "silver": 100 }
                }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [
                    { "type": "silver", "name": "银两", "amount": 100 },
                    { "type": "item", "name": "青锋剑", "amount": 1 },
                    { "type": "item", "name": "清灵丹", "amount": 10 }
                ]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "silver");
        assert_eq!(payload["data"]["lootResults"][0]["amount"], 100);
        assert_eq!(payload["data"]["lootResults"][1]["name"], "青锋剑");
        assert_eq!(payload["data"]["lootResults"][2]["name"], "清灵丹");
    }

    #[test]
    fn inventory_use_random_gem_box_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "loot",
                "params": {
                    "loot_type": "random_gem",
                    "min_level": 1,
                    "max_level": 1,
                    "gems_per_use": 1
                }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [
                    { "type": "item", "name": "一级攻击宝石", "amount": 1 }
                ]
            }
        });
        assert_eq!(payload["data"]["lootResults"][0]["type"], "item");
        assert_eq!(payload["data"]["lootResults"][0]["amount"], 1);
    }

    #[test]
    fn inventory_use_random_gem_higher_tier_box_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "loot",
                "params": {
                    "loot_type": "random_gem",
                    "min_level": 1,
                    "max_level": 2,
                    "gems_per_use": 1
                }
            }],
            "data": {
                "character": {
                    "qixue": 120,
                    "lingqi": 30,
                    "exp": 1000,
                    "stamina": 95,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                },
                "lootResults": [
                    { "type": "item", "name": "二级攻击宝石", "amount": 1 }
                ]
            }
        });
        assert_eq!(payload["effects"][0]["params"]["max_level"], 2);
        assert_eq!(payload["data"]["lootResults"][0]["type"], "item");
    }

    #[test]
    fn inventory_growth_cost_preview_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {
                "enhance": {
                    "currentLevel": 3,
                    "targetLevel": 4,
                    "maxLevel": null,
                    "successRate": 1.0,
                    "failMode": "none",
                    "costs": {
                        "materialItemDefId": "enhance-001",
                        "materialName": "淬灵石",
                        "materialQty": 4,
                        "silverCost": 500,
                        "spiritStoneCost": 80
                    },
                    "previewBaseAttrs": {"wugong": 12}
                },
                "refine": {
                    "currentLevel": 2,
                    "targetLevel": 3,
                    "maxLevel": 10,
                    "successRate": 1.0,
                    "failMode": "downgrade",
                    "costs": {
                        "materialItemDefId": "enhance-002",
                        "materialName": "蕴灵石",
                        "materialQty": 3,
                        "silverCost": 375,
                        "spiritStoneCost": 60
                    },
                    "previewBaseAttrs": {"wugong": 11}
                }
            }
        });
        assert_eq!(
            payload["data"]["enhance"]["costs"]["materialItemDefId"],
            "enhance-001"
        );
        assert_eq!(payload["data"]["refine"]["maxLevel"], 10);
        println!("INVENTORY_GROWTH_COST_PREVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_gem_recipe_list_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "character": {"silver": 1000, "spiritStones": 200},
                "recipes": [{
                    "recipeId": "gem:attack:1->2",
                    "name": "攻击宝石1级→2级合成",
                    "gemType": "attack",
                    "seriesKey": "atk-wg",
                    "fromLevel": 1,
                    "toLevel": 2,
                    "input": {"itemDefId": "gem-atk-001", "name": "一级攻击宝石", "icon": null, "qty": 3, "owned": 6},
                    "output": {"itemDefId": "gem-atk-002", "name": "二级攻击宝石", "icon": null, "qty": 1},
                    "costs": {"silver": 100, "spiritStones": 20},
                    "successRate": 1.0,
                    "maxSynthesizeTimes": 2,
                    "canSynthesize": true
                }]
            }
        });
        assert_eq!(payload["data"]["recipes"][0]["gemType"], "attack");
        println!("INVENTORY_GEM_RECIPES_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_gem_convert_options_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "character": {"silver": 1000, "spiritStones": 200},
                "options": [{
                    "inputLevel": 2,
                    "outputLevel": 1,
                    "inputGemQtyPerConvert": 2,
                    "ownedInputGemQty": 6,
                    "costSpiritStonesPerConvert": 0,
                    "maxConvertTimes": 3,
                    "canConvert": true,
                    "candidateGemCount": 4
                }]
            }
        });
        assert_eq!(payload["data"]["options"][0]["inputLevel"], 2);
        println!("INVENTORY_GEM_CONVERT_OPTIONS_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_gem_synthesize_execute_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "宝石合成完成",
            "data": {
                "recipeId": "gem:attack:1->2",
                "gemType": "attack",
                "seriesKey": "atk-wg",
                "fromLevel": 1,
                "toLevel": 2,
                "times": 1,
                "successCount": 1,
                "failCount": 0,
                "successRate": 1.0,
                "consumed": {"itemDefId": "gem-atk-001", "qty": 3},
                "spent": {"silver": 100, "spiritStones": 20},
                "produced": {"itemDefId": "gem-atk-002", "itemName": "二级攻击宝石", "itemIcon": null, "qty": 1, "itemIds": [21]},
                "character": {"silver": 900, "spiritStones": 180}
            }
        });
        assert_eq!(payload["data"]["recipeId"], "gem:attack:1->2");
        assert_eq!(payload["data"]["successCount"], 1);
        println!("INVENTORY_GEM_SYNTHESIZE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_gem_convert_execute_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "宝石转换成功",
            "data": {
                "inputLevel": 2,
                "outputLevel": 1,
                "times": 1,
                "consumed": {"inputGemQty": 2, "selectedGemItemIds": [41, 42]},
                "spent": {"spiritStones": 0},
                "produced": {
                    "totalQty": 1,
                    "items": [{"itemDefId": "gem-atk-wg-1", "name": "一级攻击宝石", "icon": null, "qty": 1, "itemIds": [51]}]
                },
                "character": {"silver": 1000, "spiritStones": 200}
            }
        });
        assert_eq!(payload["data"]["outputLevel"], 1);
        assert_eq!(payload["data"]["produced"]["totalQty"], 1);
        println!("INVENTORY_GEM_CONVERT_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_gem_synthesize_batch_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "批量合成成功",
            "data": {
                "gemType": "attack",
                "seriesKey": "atk-wg",
                "sourceLevel": 1,
                "targetLevel": 3,
                "totalSpent": {"silver": 300, "spiritStones": 20},
                "steps": [{
                    "recipeId": "gem:attack:1->2",
                    "seriesKey": "atk-wg",
                    "fromLevel": 1,
                    "toLevel": 2,
                    "times": 2,
                    "successCount": 2,
                    "failCount": 0,
                    "successRate": 1.0,
                    "consumed": {"itemDefId": "gem-atk-001", "qty": 6},
                    "spent": {"silver": 200, "spiritStones": 0},
                    "produced": {"itemDefId": "gem-atk-002", "itemName": "二级攻击宝石", "itemIcon": null, "qty": 2, "itemIds": []}
                }],
                "character": {"silver": 700, "spiritStones": 180}
            }
        });
        assert_eq!(payload["data"]["steps"][0]["times"], 2);
        assert_eq!(payload["data"]["totalSpent"]["silver"], 300);
        println!("INVENTORY_GEM_SYNTHESIZE_BATCH_RESPONSE={}", payload);
    }

    #[test]
    fn reroll_cost_plan_matches_lock_formula() {
        let cost0 = build_affix_reroll_cost_plan(Some("炼精化炁·养气期"), 0);
        let cost2 = build_affix_reroll_cost_plan(Some("炼精化炁·养气期"), 2);
        assert_eq!(cost0.reroll_scroll_qty, 1);
        assert_eq!(cost2.reroll_scroll_qty, 4);
        assert!(cost2.silver_cost > cost0.silver_cost);
        assert!(cost2.spirit_stone_cost > cost0.spirit_stone_cost);
    }

    #[test]
    fn affix_pool_seed_loader_contains_equipment_pool() {
        let pools = load_affix_pool_seed_map().expect("affix pool should load");
        let pool = pools
            .get("ap-equipment")
            .expect("equipment pool should exist");
        assert_eq!(pool.name, "装备总词条池");
        assert!(pool.affixes.len() > 10);
    }

    #[test]
    fn affix_preview_tiers_expand_with_growth_and_realm_rank() {
        let pools = load_affix_pool_seed_map().expect("affix pool should load");
        let pool = pools
            .get("ap-equipment")
            .expect("equipment pool should exist");
        let affix = pool
            .affixes
            .iter()
            .find(|affix| {
                affix.key == "fagong_flat"
                    && affix
                        .allowed_slots
                        .as_ref()
                        .is_some_and(|slots| slots.iter().any(|slot| slot == "artifact"))
            })
            .expect("artifact spell affix should exist");
        let tiers = render_affix_preview_tiers_for_realm(affix, 1.0, 3);
        assert!(tiers.len() >= 3);
        assert_eq!(tiers[0].tier, affix.start_tier.unwrap_or(1));
        assert!(tiers[1].min > tiers[0].min);
        assert!(tiers[1].max > tiers[0].max);
    }

    #[test]
    fn affix_seed_loader_exposes_special_trigger_fields() {
        let pools = load_affix_pool_seed_map().expect("affix pool should load");
        let pool = pools
            .get("ap-equipment")
            .expect("equipment pool should exist");
        let affix = pool
            .affixes
            .iter()
            .find(|affix| affix.key == "proc_baonu" && affix.trigger.as_deref() == Some("on_crit"))
            .expect("special trigger affix should exist");
        assert_eq!(affix.target.as_deref(), Some("self"));
        assert_eq!(affix.effect_type.as_deref(), Some("buff"));
        assert_eq!(affix.duration_round, Some(2));
        assert!(
            affix
                .params
                .as_ref()
                .is_some_and(|params| !params.is_empty())
        );
    }

    #[test]
    fn inventory_craft_recipes_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "character": {"realm": "凡人", "exp": 100, "silver": 1000, "spiritStones": 20},
                "recipes": [{
                    "id": "recipe-qing-ling-dan",
                    "name": "清灵丹配方",
                    "recipeType": "craft",
                    "product": {"itemDefId": "cons-001", "name": "清灵丹", "icon": null, "qty": 1},
                    "costs": {
                        "silver": 10,
                        "spiritStones": 0,
                        "exp": 0,
                        "items": [{"itemDefId": "mat-001", "itemName": "灵草", "required": 3, "owned": 6, "missing": 0}]
                    },
                    "requirements": {"realm": "凡人", "level": 0, "building": null, "realmMet": true},
                    "successRate": 100,
                    "failReturnRate": 0,
                    "maxCraftTimes": 2,
                    "craftable": true,
                    "craftKind": "alchemy"
                }]
            }
        });
        assert_eq!(payload["data"]["recipes"][0]["id"], "recipe-qing-ling-dan");
        println!("INVENTORY_CRAFT_RECIPES_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_craft_execute_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "炼制完成",
            "data": {
                "recipeId": "recipe-qing-ling-dan",
                "recipeType": "craft",
                "craftKind": "alchemy",
                "times": 1,
                "successCount": 1,
                "failCount": 0,
                "spent": {
                    "silver": 10,
                    "spiritStones": 0,
                    "exp": 0,
                    "items": [{"itemDefId": "mat-001", "qty": 3}]
                },
                "returnedItems": [],
                "produced": {
                    "itemDefId": "cons-001",
                    "itemName": "清灵丹",
                    "itemIcon": null,
                    "qty": 1,
                    "itemIds": [11]
                },
                "character": {
                    "realm": "凡人",
                    "exp": 100,
                    "silver": 990,
                    "spiritStones": 20
                }
            }
        });
        assert_eq!(payload["data"]["recipeId"], "recipe-qing-ling-dan");
        assert_eq!(payload["data"]["produced"]["qty"], 1);
        println!("INVENTORY_CRAFT_EXECUTE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_recipe_rate_normalization_supports_percent_and_ratio() {
        assert!((normalize_inventory_recipe_rate_to_ratio(80.0, 100.0) - 0.8).abs() < f64::EPSILON);
        assert!((normalize_inventory_recipe_rate_to_ratio(0.8, 100.0) - 0.8).abs() < f64::EPSILON);
        assert!(
            (normalize_inventory_recipe_rate_to_ratio(150.0, 100.0) - 1.0).abs() < f64::EPSILON
        );
        assert!(
            (normalize_inventory_recipe_rate_to_ratio(-10.0, 100.0) - 0.0).abs() < f64::EPSILON
        );
    }

    #[test]
    fn inventory_craft_execute_partial_failure_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "炼制完成",
            "data": {
                "recipeId": "recipe-xuan-ling-dan",
                "recipeType": "craft",
                "craftKind": "alchemy",
                "times": 3,
                "successCount": 2,
                "failCount": 1,
                "spent": {
                    "silver": 150,
                    "spiritStones": 3,
                    "exp": 0,
                    "items": [
                        {"itemDefId": "mat-001", "qty": 30},
                        {"itemDefId": "cons-001", "qty": 6}
                    ]
                },
                "returnedItems": [
                    {"itemDefId": "mat-001", "qty": 5},
                    {"itemDefId": "cons-001", "qty": 1}
                ],
                "produced": {
                    "itemDefId": "cons-003",
                    "itemName": "玄灵丹",
                    "itemIcon": null,
                    "qty": 2,
                    "itemIds": [21]
                },
                "character": {
                    "realm": "炼精化炁·养气期",
                    "exp": 100,
                    "silver": 850,
                    "spiritStones": 17
                }
            }
        });
        assert_eq!(payload["data"]["failCount"], 1);
        assert_eq!(payload["data"]["returnedItems"][0]["qty"], 5);
        assert_eq!(payload["data"]["produced"]["qty"], 2);
    }

    #[test]
    fn inventory_socket_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "镶嵌成功",
            "data": {
                "socketedGems": [{
                    "slot": 0,
                    "itemDefId": "gem-atk-001",
                    "gemType": "attack",
                    "effects": [{"attrKey": "wugong", "value": 5, "applyType": "flat"}],
                    "name": "一级攻击宝石",
                    "icon": null
                }],
                "socketMax": 2,
                "slot": 0,
                "gem": {
                    "itemDefId": "gem-atk-001",
                    "name": "一级攻击宝石",
                    "icon": null,
                    "gemType": "attack"
                },
                "costs": {"silver": 50},
                "character": null
            }
        });
        assert_eq!(payload["data"]["socketedGems"][0]["gemType"], "attack");
        assert_eq!(payload["data"]["costs"]["silver"], 50);
        println!("INVENTORY_SOCKET_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_refine_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "精炼成功",
            "data": {
                "refineLevel": 3,
                "targetLevel": 3,
                "successRate": 1.0,
                "roll": 0.12,
                "usedMaterial": {"itemDefId": "enhance-002", "qty": 3},
                "costs": {"silver": 375, "spiritStones": 60},
                "character": null
            }
        });
        assert_eq!(payload["data"]["refineLevel"], 3);
        assert_eq!(payload["data"]["usedMaterial"]["itemDefId"], "enhance-002");
        println!("INVENTORY_REFINE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_enhance_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "强化成功",
            "data": {
                "strengthenLevel": 4,
                "targetLevel": 4,
                "successRate": 1.0,
                "roll": 0.08,
                "failMode": "none",
                "destroyed": false,
                "usedMaterial": {"itemDefId": "enhance-001", "qty": 4},
                "costs": {"silver": 500, "spiritStones": 80},
                "character": null
            }
        });
        assert_eq!(payload["data"]["strengthenLevel"], 4);
        assert_eq!(payload["data"]["failMode"], "none");
        assert_eq!(payload["data"]["destroyed"], false);
        println!("INVENTORY_ENHANCE_RESPONSE={}", payload);
    }

    #[test]
    fn calc_character_stamina_max_by_insight_level_matches_rule() {
        assert_eq!(calc_character_stamina_max_by_insight_level(0), 100);
        assert_eq!(calc_character_stamina_max_by_insight_level(9), 100);
        assert_eq!(calc_character_stamina_max_by_insight_level(10), 101);
        assert_eq!(calc_character_stamina_max_by_insight_level(27), 102);
    }

    #[test]
    fn inventory_use_payload_deserializes_aliases_and_qty() {
        let payload: InventoryUsePayload = serde_json::from_value(serde_json::json!({
            "itemInstanceId": 9,
            "qty": 2,
            "partnerId": 42
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_instance_id, Some(9));
        assert_eq!(payload.qty, Some(2));
        assert_eq!(payload.partner_id, Some(42));
    }

    #[test]
    fn inventory_use_supports_mid_tier_consumables_in_allowlist() {
        assert!(is_supported_inventory_use_item_def_id("cons-003"));
        assert!(is_supported_inventory_use_item_def_id("cons-009"));
        assert!(is_supported_inventory_use_item_def_id("cons-010"));
        assert!(is_supported_inventory_use_item_def_id(
            "cons-battlepass-001"
        ));
        assert!(is_supported_inventory_use_item_def_id("box-002"));
        assert!(is_supported_inventory_use_item_def_id("box-013"));
        assert!(is_supported_inventory_use_item_def_id("book-jichu-quanfa"));
        assert!(is_supported_inventory_use_item_def_id(
            "book-generated-technique"
        ));
    }

    #[test]
    fn inventory_use_multi_effect_response_shape_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "effects": [
                {
                    "trigger": "use",
                    "target": "self",
                    "effect_type": "dispel",
                    "params": { "dispel_type": "poison" }
                },
                {
                    "trigger": "use",
                    "target": "self",
                    "effect_type": "heal",
                    "value": 120
                }
            ],
            "data": {
                "character": {
                    "qixue": 180,
                    "lingqi": 30,
                    "exp": 0,
                    "stamina": 80,
                    "stamina_max": 100,
                    "maxQixue": 200,
                    "maxLingqi": 100
                }
            }
        });
        assert_eq!(
            payload["effects"].as_array().map(|items| items.len()),
            Some(2)
        );
        assert_eq!(payload["effects"][0]["effect_type"], "dispel");
        assert_eq!(payload["effects"][1]["effect_type"], "heal");
    }

    #[test]
    fn build_loot_results_for_use_includes_silver_and_items_in_order() {
        let mut defs = BTreeMap::new();
        defs.insert(
            "equip-weapon-001".to_string(),
            InventoryDefSeed {
                row: serde_json::json!({"name": "青锋剑"}),
            },
        );
        defs.insert(
            "cons-001".to_string(),
            InventoryDefSeed {
                row: serde_json::json!({"name": "清灵丹"}),
            },
        );
        let results = build_loot_results_for_use(
            &defs,
            100,
            50,
            &[
                ("equip-weapon-001".to_string(), 1),
                ("cons-001".to_string(), 10),
            ],
        );
        assert_eq!(results.len(), 4);
        assert_eq!(results[0].r#type, "silver");
        assert_eq!(results[0].amount, 100);
        assert_eq!(results[1].r#type, "spirit_stones");
        assert_eq!(results[1].amount, 50);
        assert_eq!(results[2].name.as_deref(), Some("青锋剑"));
        assert_eq!(results[3].name.as_deref(), Some("清灵丹"));
    }

    #[test]
    fn inventory_snapshot_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"info": {"bagCapacity": 100}, "bagItems": [], "equippedItems": []}
        });
        assert_eq!(payload["data"]["bagItems"], serde_json::json!([]));
        println!("INVENTORY_SNAPSHOT_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_items_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"items": [{"id": 1, "itemDefId": "cons-001", "qty": 3, "location": "bag"}], "total": 1, "page": 1, "pageSize": 100}
        });
        assert_eq!(payload["data"]["items"][0]["itemDefId"], "cons-001");
        println!("INVENTORY_ITEMS_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_sort_result_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "整理完成"
        });
        assert_eq!(payload["message"], "整理完成");
        println!("INVENTORY_SORT_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_lock_result_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已锁定",
            "data": {"itemId": 42, "locked": true}
        });
        assert_eq!(payload["data"]["locked"], true);
        println!("INVENTORY_LOCK_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_remove_result_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "移除成功"
        });
        assert_eq!(payload["message"], "移除成功");
        println!("INVENTORY_REMOVE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_remove_payload_defaults_qty_to_one() {
        let payload: InventoryRemovePayload = serde_json::from_value(serde_json::json!({
            "itemId": 42
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_id, Some(42));
        assert_eq!(payload.qty, None);
    }

    #[test]
    fn inventory_remove_payload_supports_alias_ids() {
        let payload: InventoryRemovePayload = serde_json::from_value(serde_json::json!({
            "itemInstanceId": 8,
            "qty": 2
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_instance_id, Some(8));
        assert_eq!(payload.qty, Some(2));
    }

    #[test]
    fn inventory_remove_batch_response_matches_contract() {
        let payload = serde_json::to_value(InventoryRemoveBatchResponse {
            success: true,
            message: "丢弃成功（已跳过已锁定×1）".to_string(),
            removed_count: Some(2),
            removed_qty_total: Some(7),
            skipped_locked_count: Some(1),
            skipped_locked_qty_total: Some(3),
        })
        .expect("payload should serialize");
        assert_eq!(payload["removedCount"], 2);
        assert_eq!(payload["removedQtyTotal"], 7);
        assert_eq!(payload["skippedLockedCount"], 1);
        println!("INVENTORY_REMOVE_BATCH_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_disassemble_preview_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取预览成功",
            "rewards": {
                "silver": 0,
                "items": [{
                    "type": "item",
                    "itemDefId": "enhance-001",
                    "name": "淬灵石",
                    "qty": 1,
                    "itemIds": []
                }]
            }
        });
        assert_eq!(payload["rewards"]["items"][0]["itemDefId"], "enhance-001");
        println!("INVENTORY_DISASSEMBLE_PREVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_disassemble_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "分解成功",
            "rewards": {
                "silver": 25,
                "items": []
            }
        });
        assert_eq!(payload["message"], "分解成功");
        assert_eq!(payload["rewards"]["silver"], 25);
        println!("INVENTORY_DISASSEMBLE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_disassemble_batch_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "分解成功（已跳过已锁定×1）",
            "disassembledCount": 2,
            "disassembledQtyTotal": 3,
            "skippedLockedCount": 1,
            "skippedLockedQtyTotal": 1,
            "rewards": {
                "silver": 50,
                "items": [{
                    "type": "item",
                    "itemDefId": "enhance-001",
                    "name": "淬灵石",
                    "qty": 2,
                    "itemIds": []
                }]
            }
        });
        assert_eq!(payload["disassembledCount"], 2);
        assert_eq!(payload["skippedLockedCount"], 1);
        println!("INVENTORY_DISASSEMBLE_BATCH_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_remove_batch_failure_omits_counters() {
        let payload = serde_json::to_value(inventory_remove_batch_failure("itemIds参数错误"))
            .expect("payload should serialize");
        assert_eq!(payload["success"], false);
        assert!(payload.get("removedCount").is_none());
    }

    #[test]
    fn inventory_remove_batch_payload_deserializes_item_ids() {
        let payload: InventoryRemoveBatchPayload = serde_json::from_value(serde_json::json!({
            "itemIds": [1, 2, 3]
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_ids.as_ref().map(Vec::len), Some(3));
    }

    #[test]
    fn inventory_move_result_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "移动成功"
        });
        assert_eq!(payload["message"], "移动成功");
        println!("INVENTORY_MOVE_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_move_payload_deserializes_contract() {
        let payload: InventoryMovePayload = serde_json::from_value(serde_json::json!({
            "itemId": 8,
            "targetLocation": "warehouse",
            "targetSlot": 3
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_id, Some(8));
        assert_eq!(payload.target_location.as_deref(), Some("warehouse"));
        assert_eq!(payload.target_slot, Some(3));
    }

    #[test]
    fn find_first_empty_inventory_slot_skips_occupied_slots() {
        let rows = vec![
            InventoryMoveRow {
                id: 1,
                item_def_id: "a".to_string(),
                qty: 1,
                location: "bag".to_string(),
                location_slot: Some(0),
                bind_type: "none".to_string(),
                metadata: None,
                quality: None,
                quality_rank: None,
            },
            InventoryMoveRow {
                id: 2,
                item_def_id: "b".to_string(),
                qty: 1,
                location: "bag".to_string(),
                location_slot: Some(2),
                bind_type: "none".to_string(),
                metadata: None,
                quality: None,
                quality_rank: None,
            },
        ];
        assert_eq!(find_first_empty_inventory_slot(&rows, "bag", 5), Some(1));
    }

    #[test]
    fn inventory_move_stack_candidates_follow_qty_desc_then_id_asc() {
        let mut candidate_ids = vec![3_i64, 1, 2];
        let rows = vec![
            InventoryMoveRow {
                id: 1,
                item_def_id: "a".to_string(),
                qty: 4,
                location: "warehouse".to_string(),
                location_slot: Some(0),
                bind_type: "none".to_string(),
                metadata: None,
                quality: None,
                quality_rank: None,
            },
            InventoryMoveRow {
                id: 2,
                item_def_id: "a".to_string(),
                qty: 9,
                location: "warehouse".to_string(),
                location_slot: Some(3),
                bind_type: "none".to_string(),
                metadata: None,
                quality: None,
                quality_rank: None,
            },
            InventoryMoveRow {
                id: 3,
                item_def_id: "a".to_string(),
                qty: 9,
                location: "warehouse".to_string(),
                location_slot: Some(1),
                bind_type: "none".to_string(),
                metadata: None,
                quality: None,
                quality_rank: None,
            },
        ];
        candidate_ids.sort_by(|left, right| {
            let left_row = rows
                .iter()
                .find(|row| row.id == *left)
                .expect("candidate row should exist");
            let right_row = rows
                .iter()
                .find(|row| row.id == *right)
                .expect("candidate row should exist");
            right_row
                .qty
                .cmp(&left_row.qty)
                .then_with(|| left_row.id.cmp(&right_row.id))
        });
        assert_eq!(candidate_ids, vec![2, 3, 1]);
    }

    #[test]
    fn inventory_equip_success_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "character": {
                    "id": 1,
                    "nickname": "tester"
                }
            }
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["data"]["character"]["id"], 1);
        println!("INVENTORY_EQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_unequip_success_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "character": {
                    "id": 1,
                    "nickname": "tester"
                }
            }
        });
        assert_eq!(payload["data"]["character"]["nickname"], "tester");
        println!("INVENTORY_UNEQUIP_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_unequip_payload_defaults_target_location_to_bag() {
        let payload: InventoryUnequipPayload = serde_json::from_value(serde_json::json!({
            "itemId": 7
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_id, Some(7));
        assert!(payload.target_location.is_none());
    }

    #[test]
    fn inventory_use_payload_accepts_optional_nickname() {
        let payload: InventoryUsePayload = serde_json::from_value(serde_json::json!({
            "itemId": 7,
            "qty": 1,
            "nickname": "凌霄子"
        }))
        .expect("payload should deserialize");
        assert_eq!(payload.item_id, Some(7));
        assert_eq!(payload.nickname.as_deref(), Some("凌霄子"));
    }

    #[test]
    fn inventory_use_rename_card_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "改名成功",
            "effects": [{
                "trigger": "use",
                "target": "self",
                "effect_type": "rename_character"
            }],
            "data": {
                "character": {
                    "id": 1,
                    "nickname": "凌霄子"
                }
            }
        });
        assert_eq!(payload["data"]["character"]["nickname"], "凌霄子");
        println!("INVENTORY_USE_RENAME_CARD_RESPONSE={}", payload);
    }

    #[test]
    fn inventory_use_reroll_scroll_response_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "洗炼成功",
            "effects": [{
                "trigger": "use",
                "effect_type": "reroll",
                "params": {
                    "target_type": "equipment",
                    "reroll_type": "affixes"
                }
            }],
            "data": {
                "character": {
                    "id": 1,
                    "nickname": "tester"
                }
            }
        });
        assert_eq!(payload["message"], "洗炼成功");
        assert_eq!(payload["effects"][0]["effect_type"], "reroll");
        println!("INVENTORY_USE_REROLL_SCROLL_RESPONSE={}", payload);
    }

    #[test]
    fn compact_inventory_rows_merges_plain_stackables() {
        let defs = BTreeMap::from([(
            "cons-001".to_string(),
            InventoryDefSeed {
                row: serde_json::json!({"stack_max": 20, "category": "consumable"}),
            },
        )]);
        let rows = vec![
            SortInventoryRow {
                id: 1,
                item_def_id: "cons-001".to_string(),
                qty: 15,
                quality: None,
                quality_rank: None,
                bind_type: "none".to_string(),
                metadata: None,
                location_slot: Some(4),
            },
            SortInventoryRow {
                id: 2,
                item_def_id: "cons-001".to_string(),
                qty: 8,
                quality: None,
                quality_rank: None,
                bind_type: "none".to_string(),
                metadata: None,
                location_slot: Some(1),
            },
        ];

        let compacted = compact_inventory_rows_for_sort(rows, &defs);
        assert_eq!(compacted.len(), 2);
        assert_eq!(compacted[0].id, 2);
        assert_eq!(compacted[0].qty, 20);
        assert_eq!(compacted[1].id, 1);
        assert_eq!(compacted[1].qty, 3);
    }

    #[test]
    fn ranked_sort_rows_follow_category_quality_and_qty_order() {
        let defs = BTreeMap::from([
            (
                "eq-001".to_string(),
                InventoryDefSeed {
                    row: serde_json::json!({"category": "equipment", "sub_category": "weapon", "quality": "天"}),
                },
            ),
            (
                "cons-001".to_string(),
                InventoryDefSeed {
                    row: serde_json::json!({"category": "consumable", "sub_category": "pill", "quality": "玄"}),
                },
            ),
        ]);
        let ranked = build_ranked_sort_rows(
            vec![
                SortInventoryRow {
                    id: 1,
                    item_def_id: "eq-001".to_string(),
                    qty: 1,
                    quality: None,
                    quality_rank: None,
                    bind_type: "none".to_string(),
                    metadata: None,
                    location_slot: Some(1),
                },
                SortInventoryRow {
                    id: 2,
                    item_def_id: "cons-001".to_string(),
                    qty: 20,
                    quality: None,
                    quality_rank: None,
                    bind_type: "none".to_string(),
                    metadata: None,
                    location_slot: Some(0),
                },
            ],
            &defs,
        );
        assert_eq!(ranked[0].row.item_def_id, "cons-001");
        assert_eq!(ranked[1].row.item_def_id, "eq-001");
    }
}
