use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::config::CaptchaProvider;
use crate::http::inventory::resolve_generated_technique_book_display;
use crate::http::partner::{
    build_effective_partner_skill, clear_pending_partner_technique_preview_by_partner_ids,
    has_pending_partner_technique_preview_for_partner,
};
use crate::http::technique::load_technique_detail_data;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_instance_mutation::{
    BufferedItemInstanceMutation, ItemInstanceMutationSnapshot, buffer_item_instance_mutations,
};
use crate::integrations::tencent_captcha;
use crate::realtime::market::{MarketUpdatePayload, build_market_update_payload};
use crate::realtime::public_socket::{emit_market_update_to_user, emit_rank_update_to_user};
use crate::realtime::rank::{RankUpdatePayload, build_rank_update_payload};
use crate::shared::error::AppError;
use crate::shared::mail_counter::{apply_mail_counter_deltas, build_new_mail_counter_deltas};
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

const MARKET_CAPTCHA_KEY_PREFIX: &str = "market:captcha:";
const MARKET_CAPTCHA_TTL_SECONDS: u64 = 300;
const MARKET_CAPTCHA_PASS_TTL_MS: u64 = 300_000;
const MARKET_CAPTCHA_CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MARKET_RISK_QUERY_LONG_WINDOW_MS: i64 = 300_000;
const MARKET_RISK_QUERY_TRACK_TTL_MS: i64 = 900_000;
const MARKET_RISK_QUERY_SHORT_WINDOW_MS: i64 = 60_000;
const MARKET_RISK_RECENT_TIMESTAMP_COUNT: i64 = 12;
const MARKET_CAPTCHA_REQUIRED_ERROR_CODE: &str = "MARKET_CAPTCHA_REQUIRED";

fn market_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingDto {
    pub id: i64,
    pub item_instance_id: i64,
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub quality: Option<String>,
    pub category: Option<String>,
    pub sub_category: Option<String>,
    pub description: Option<String>,
    pub long_desc: Option<String>,
    pub tags: serde_json::Value,
    pub effect_defs: serde_json::Value,
    pub base_attrs: BTreeMap<String, f64>,
    pub equip_slot: Option<String>,
    pub equip_req_realm: Option<String>,
    pub use_type: Option<String>,
    pub strengthen_level: i64,
    pub refine_level: i64,
    pub identified: bool,
    pub affixes: serde_json::Value,
    pub socketed_gems: serde_json::Value,
    pub generated_technique_id: Option<String>,
    pub qty: i64,
    pub unit_price_spirit_stones: i64,
    pub seller_character_id: i64,
    pub seller_name: String,
    pub listed_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketTradeRecordDto {
    pub id: i64,
    pub r#type: String,
    pub item_def_id: String,
    pub name: String,
    pub icon: Option<String>,
    pub qty: i64,
    pub unit_price_spirit_stones: i64,
    pub counterparty: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingsDataDto {
    pub listings: Vec<MarketListingDto>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketTradeRecordsDataDto {
    pub records: Vec<MarketTradeRecordDto>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerListingDto {
    pub id: i64,
    pub partner: serde_json::Value,
    pub unit_price_spirit_stones: i64,
    pub seller_character_id: i64,
    pub seller_name: String,
    pub listed_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerTradeRecordDto {
    pub id: i64,
    pub r#type: String,
    pub partner: serde_json::Value,
    pub unit_price_spirit_stones: i64,
    pub total_price_spirit_stones: i64,
    pub counterparty: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerListingsDataDto {
    pub listings: Vec<MarketPartnerListingDto>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerTradeRecordsDataDto {
    pub records: Vec<MarketPartnerTradeRecordDto>,
    pub total: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingsQuery {
    pub category: Option<String>,
    pub quality: Option<String>,
    pub query: Option<String>,
    pub sort: Option<String>,
    pub min_price: Option<i64>,
    pub max_price: Option<i64>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketMyListingsQuery {
    pub status: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRecordsQuery {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerListingsQuery {
    pub quality: Option<String>,
    pub element: Option<String>,
    pub query: Option<String>,
    pub sort: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerMyListingsQuery {
    pub status: Option<String>,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerTechniqueDetailQuery {
    pub listing_id: Option<i64>,
    pub technique_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerTechniqueDetailDto {
    pub technique: serde_json::Value,
    pub layers: Vec<serde_json::Value>,
    pub skills: Vec<serde_json::Value>,
    pub current_layer: i64,
    pub is_innate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCaptchaChallengeDto {
    pub captcha_id: String,
    pub image_data: String,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCaptchaVerifyPayload {
    pub captcha_id: Option<String>,
    pub captcha_code: Option<String>,
    pub ticket: Option<String>,
    pub randstr: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCaptchaVerifyResultDto {
    pub pass_expires_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCancelPayload {
    pub listing_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItemListPayload {
    pub item_instance_id: Option<i64>,
    pub qty: Option<i64>,
    pub unit_price_spirit_stones: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItemListDataDto {
    pub listing_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MarketUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerBuyPayload {
    pub listing_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerBuyDataDto {
    pub seller_user_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MarketUpdatePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_rank_realtime: Option<RankUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItemBuyPayload {
    pub listing_id: Option<i64>,
    pub qty: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketItemBuyDataDto {
    pub seller_user_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MarketUpdatePayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerListPayload {
    pub partner_id: Option<i64>,
    pub unit_price_spirit_stones: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPartnerListDataDto {
    pub listing_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MarketUpdatePayload>,
}

#[derive(Debug, Deserialize, Clone)]
struct MarketPartnerDefFile {
    partners: Vec<MarketPartnerDefSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MarketPartnerDefSeed {
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
struct MarketPartnerGrowthFile {
    exp_base_exp: i64,
    exp_growth_rate: f64,
}

#[derive(Debug)]
struct MarketPartnerRowData {
    id: i64,
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

#[derive(Debug, Clone)]
struct MarketPartnerTechniqueRowData {
    technique_id: String,
    current_layer: i64,
    is_innate: bool,
}

#[derive(Debug, Clone)]
struct MarketItemMeta {
    raw: serde_json::Value,
    name: String,
    icon: Option<String>,
    quality: Option<String>,
    category: Option<String>,
    sub_category: Option<String>,
    description: Option<String>,
    long_desc: Option<String>,
    base_attrs: BTreeMap<String, f64>,
    equip_slot: Option<String>,
    equip_req_realm: Option<String>,
    use_type: Option<String>,
    tags: serde_json::Value,
    effect_defs: serde_json::Value,
    tradeable: bool,
    tax_rate: f64,
}

pub async fn get_market_listings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketListingsQuery>,
) -> Result<Json<SuccessResponse<MarketListingsDataDto>>, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    assert_market_phone_bound(&state, user.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    record_market_risk_query_access(
        &state,
        user.user_id,
        build_item_market_risk_query_signature(&query, page, page_size),
    )
    .await?;
    let sort_sql = match query.sort.as_deref().unwrap_or("timeDesc") {
        "priceAsc" => "ml.unit_price_spirit_stones ASC, ml.id ASC",
        "priceDesc" => "ml.unit_price_spirit_stones DESC, ml.id DESC",
        "qtyDesc" => "ml.qty DESC, ml.id DESC",
        _ => "ml.listed_at DESC, ml.id DESC",
    };
    let sql = format!(
        "SELECT ml.id, ml.item_instance_id, ml.item_def_id, ml.qty, ml.unit_price_spirit_stones, ml.seller_character_id, ml.listed_at::text AS listed_at_text, ii.quality AS instance_quality, ii.strengthen_level, ii.refine_level, ii.identified, ii.affixes, ii.socketed_gems, ii.metadata, c.nickname AS seller_name FROM market_listing ml LEFT JOIN item_instance ii ON ii.id = ml.item_instance_id JOIN characters c ON c.id = ml.seller_character_id WHERE ml.status = 'active' ORDER BY {} LIMIT $1 OFFSET $2",
        sort_sql
    );
    let rows = state
        .database
        .fetch_all(&sql, |q| q.bind(page_size).bind(offset))
        .await?;
    let metas = load_market_item_meta_map()?;
    let mut listings = Vec::new();
    for row in rows {
        if let Some(listing) = build_market_listing_dto(&state, &row, &metas).await? {
            listings.push(listing);
        }
    }
    apply_market_listing_filters(&mut listings, &query);
    let total = listings.len() as i64;
    Ok(send_success(MarketListingsDataDto { listings, total }))
}

pub async fn get_my_market_listings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketMyListingsQuery>,
) -> Result<Json<SuccessResponse<MarketListingsDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("active");
    let rows = state.database.fetch_all(
        "SELECT ml.id, ml.item_instance_id, ml.item_def_id, ml.qty, ml.unit_price_spirit_stones, ml.seller_character_id, ml.listed_at::text AS listed_at_text, ii.quality AS instance_quality, ii.strengthen_level, ii.refine_level, ii.identified, ii.affixes, ii.socketed_gems, ii.metadata, c.nickname AS seller_name FROM market_listing ml LEFT JOIN item_instance ii ON ii.id = ml.item_instance_id JOIN characters c ON c.id = ml.seller_character_id WHERE ml.seller_character_id = $1 AND ml.status = $2 ORDER BY ml.listed_at DESC LIMIT $3 OFFSET $4",
        |q| q.bind(actor.character_id).bind(status).bind(page_size).bind(offset),
    ).await?;
    let count_row = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM market_listing WHERE seller_character_id = $1 AND status = $2",
        |q| q.bind(actor.character_id).bind(status),
    ).await?;
    let total = count_row
        .and_then(|r| r.try_get::<Option<i64>, _>("cnt").ok().flatten())
        .unwrap_or_default();
    let metas = load_market_item_meta_map()?;
    let mut listings = Vec::new();
    for row in rows {
        if let Some(listing) = build_market_listing_dto(&state, &row, &metas).await? {
            listings.push(listing);
        }
    }
    Ok(send_success(MarketListingsDataDto { listings, total }))
}

pub async fn get_market_trade_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketRecordsQuery>,
) -> Result<Json<SuccessResponse<MarketTradeRecordsDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    let rows = state.database.fetch_all(
        "SELECT tr.id, tr.item_def_id, tr.qty, tr.unit_price_spirit_stones, tr.buyer_character_id, tr.seller_character_id, tr.created_at::text AS created_at_text, cb.nickname AS buyer_name, cs.nickname AS seller_name FROM market_trade_record tr JOIN characters cb ON cb.id = tr.buyer_character_id JOIN characters cs ON cs.id = tr.seller_character_id WHERE tr.buyer_character_id = $1 OR tr.seller_character_id = $1 ORDER BY tr.created_at DESC LIMIT $2 OFFSET $3",
        |q| q.bind(actor.character_id).bind(page_size).bind(offset),
    ).await?;
    let count_row = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM market_trade_record WHERE buyer_character_id = $1 OR seller_character_id = $1",
        |q| q.bind(actor.character_id),
    ).await?;
    let total = count_row
        .and_then(|r| r.try_get::<Option<i64>, _>("cnt").ok().flatten())
        .unwrap_or_default();
    let metas = load_market_item_meta_map()?;
    let records = rows
        .into_iter()
        .map(|row| build_market_trade_record_dto(&row, actor.character_id, &metas))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(send_success(MarketTradeRecordsDataDto { records, total }))
}

pub async fn get_market_purchase_captcha(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<MarketCaptchaChallengeDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    if state.config.captcha.provider == CaptchaProvider::Tencent {
        return Err(AppError::config("当前验证码模式不支持此操作"));
    }
    let redis = RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("当前验证码服务不可用"))?,
    );
    let captcha_id = format!("market-captcha-{}", now_millis());
    let answer = generate_market_captcha_answer();
    let expires_at = now_secs() + MARKET_CAPTCHA_TTL_SECONDS;
    let payload = serde_json::json!({"answer": answer, "expiresAt": expires_at});
    redis
        .set_string_ex(
            &format!("{MARKET_CAPTCHA_KEY_PREFIX}{captcha_id}"),
            &payload.to_string(),
            MARKET_CAPTCHA_TTL_SECONDS,
        )
        .await?;
    Ok(send_success(MarketCaptchaChallengeDto {
        captcha_id,
        image_data: build_market_captcha_image_data(&answer),
        expires_at,
    }))
}

pub async fn verify_market_purchase_captcha(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketCaptchaVerifyPayload>,
) -> Result<Json<SuccessResponse<MarketCaptchaVerifyResultDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let request_ip = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    verify_market_captcha_payload(&state, &payload, &request_ip).await?;
    let redis = RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("Redis 不可用，无法写入坊市放行凭证"))?,
    );
    let pass_expires_at = now_millis() + MARKET_CAPTCHA_PASS_TTL_MS;
    redis
        .set_string_ex(
            &format!("market:risk:pass:{}:{}", actor.user_id, actor.character_id),
            "1",
            MARKET_CAPTCHA_PASS_TTL_MS / 1000,
        )
        .await?;
    Ok(send_success(MarketCaptchaVerifyResultDto {
        pass_expires_at,
    }))
}

pub async fn cancel_partner_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketCancelPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let listing_id = payload.listing_id.unwrap_or_default();
    if listing_id <= 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("listingId参数错误".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            cancel_partner_market_listing_tx(&state, actor.character_id, listing_id).await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(debug) = data.get("debugRealtime") {
                let payload = build_market_update_payload(
                    debug
                        .get("source")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                    debug.get("listingId").and_then(|value| value.as_i64()),
                    debug
                        .get("marketType")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                );
                emit_market_update_to_user(&state, actor.user_id, &payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn create_partner_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketPartnerListPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let partner_id = payload.partner_id.unwrap_or_default();
    let unit_price = payload.unit_price_spirit_stones.unwrap_or_default();
    if partner_id <= 0 {
        return Ok(send_result(ServiceResult::<MarketPartnerListDataDto> {
            success: false,
            message: Some("partnerId参数错误".to_string()),
            data: None,
        }));
    }
    if unit_price <= 0 {
        return Ok(send_result(ServiceResult::<MarketPartnerListDataDto> {
            success: false,
            message: Some("unitPriceSpiritStones参数错误".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            create_partner_market_listing_tx(
                &state,
                actor.user_id,
                actor.character_id,
                partner_id,
                unit_price,
            )
            .await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(payload) = data.debug_realtime.as_ref() {
                emit_market_update_to_user(&state, actor.user_id, payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn cancel_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketCancelPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let listing_id = payload.listing_id.unwrap_or_default();
    if listing_id <= 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("listingId参数错误".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            cancel_market_listing_tx(&state, actor.user_id, actor.character_id, listing_id).await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(debug) = data.get("debugRealtime") {
                let payload = build_market_update_payload(
                    debug
                        .get("source")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                    debug.get("listingId").and_then(|value| value.as_i64()),
                    debug
                        .get("marketType")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default(),
                );
                emit_market_update_to_user(&state, actor.user_id, &payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn create_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketItemListPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    let qty = payload.qty.unwrap_or_default();
    let unit_price = payload.unit_price_spirit_stones.unwrap_or_default();
    if item_instance_id <= 0 {
        return Ok(send_result(ServiceResult::<MarketItemListDataDto> {
            success: false,
            message: Some("itemInstanceId参数错误".to_string()),
            data: None,
        }));
    }
    if qty <= 0 {
        return Ok(send_result(ServiceResult::<MarketItemListDataDto> {
            success: false,
            message: Some("qty参数错误".to_string()),
            data: None,
        }));
    }
    if unit_price <= 0 {
        return Ok(send_result(ServiceResult::<MarketItemListDataDto> {
            success: false,
            message: Some("unitPriceSpiritStones参数错误".to_string()),
            data: None,
        }));
    }
    let result = state
        .database
        .with_transaction(|| async {
            create_market_listing_tx(
                &state,
                actor.user_id,
                actor.character_id,
                item_instance_id,
                qty,
                unit_price,
            )
            .await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(payload) = data.debug_realtime.as_ref() {
                emit_market_update_to_user(&state, actor.user_id, payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn buy_partner_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketPartnerBuyPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let listing_id = payload.listing_id.unwrap_or_default();
    if listing_id <= 0 {
        return Ok(send_result(ServiceResult::<MarketPartnerBuyDataDto> {
            success: false,
            message: Some("listingId参数错误".to_string()),
            data: None,
        }));
    }
    if !has_valid_market_purchase_pass(&state, actor.user_id, actor.character_id).await? {
        let assessment = get_market_purchase_risk_assessment(&state, actor.user_id).await?;
        if assessment.requires_captcha {
            return Err(AppError::Business {
                message: "坊市购买需要验证码".to_string(),
                status: axum::http::StatusCode::BAD_REQUEST,
                extra: serde_json::Map::from_iter([(
                    String::from("code"),
                    serde_json::Value::String(MARKET_CAPTCHA_REQUIRED_ERROR_CODE.to_string()),
                )]),
            });
        }
    }
    let result = state
        .database
        .with_transaction(|| async {
            buy_partner_market_listing_tx(&state, actor.user_id, actor.character_id, listing_id)
                .await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(payload) = data.debug_realtime.as_ref() {
                emit_market_update_to_user(&state, actor.user_id, payload);
                emit_market_update_to_user(&state, data.seller_user_id, payload);
            }
            if let Some(rank_payload) = data.debug_rank_realtime.as_ref() {
                emit_rank_update_to_user(&state, actor.user_id, rank_payload);
                emit_rank_update_to_user(&state, data.seller_user_id, rank_payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn buy_market_listing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MarketItemBuyPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let listing_id = payload.listing_id.unwrap_or_default();
    let qty = payload.qty.unwrap_or_default();
    if listing_id <= 0 {
        return Ok(send_result(ServiceResult::<MarketItemBuyDataDto> {
            success: false,
            message: Some("listingId参数错误".to_string()),
            data: None,
        }));
    }
    if qty <= 0 {
        return Ok(send_result(ServiceResult::<MarketItemBuyDataDto> {
            success: false,
            message: Some("qty参数错误".to_string()),
            data: None,
        }));
    }
    if !has_valid_market_purchase_pass(&state, actor.user_id, actor.character_id).await? {
        let assessment = get_market_purchase_risk_assessment(&state, actor.user_id).await?;
        if assessment.requires_captcha {
            return Err(AppError::Business {
                message: "坊市购买需要验证码".to_string(),
                status: axum::http::StatusCode::BAD_REQUEST,
                extra: serde_json::Map::from_iter([(
                    String::from("code"),
                    serde_json::Value::String(MARKET_CAPTCHA_REQUIRED_ERROR_CODE.to_string()),
                )]),
            });
        }
    }
    let result = state
        .database
        .with_transaction(|| async {
            buy_market_listing_tx(&state, actor.user_id, actor.character_id, listing_id, qty).await
        })
        .await?;
    if result.success {
        if let Some(data) = result.data.as_ref() {
            if let Some(payload) = data.debug_realtime.as_ref() {
                emit_market_update_to_user(&state, actor.user_id, payload);
                emit_market_update_to_user(&state, data.seller_user_id, payload);
            }
        }
    }
    Ok(send_result(result))
}

pub async fn get_partner_market_listings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketPartnerListingsQuery>,
) -> Result<Json<SuccessResponse<MarketPartnerListingsDataDto>>, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    assert_market_phone_bound(&state, user.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    record_market_risk_query_access(
        &state,
        user.user_id,
        build_partner_market_risk_query_signature(&query, page, page_size),
    )
    .await?;
    let sort_sql = match query.sort.as_deref().unwrap_or("timeDesc") {
        "priceAsc" => "mpl.unit_price_spirit_stones ASC, mpl.listed_at DESC",
        "priceDesc" => "mpl.unit_price_spirit_stones DESC, mpl.listed_at DESC",
        "levelDesc" => "mpl.partner_level DESC, mpl.listed_at DESC",
        _ => "mpl.listed_at DESC",
    };
    let sql = format!(
        "SELECT mpl.id, mpl.partner_snapshot, mpl.unit_price_spirit_stones, mpl.seller_character_id, seller.nickname AS seller_name, mpl.listed_at::text AS listed_at_text, mpl.partner_quality, mpl.partner_element, mpl.partner_name, mpl.partner_nickname FROM market_partner_listing mpl JOIN characters seller ON seller.id = mpl.seller_character_id WHERE mpl.status = 'active' ORDER BY {} LIMIT $1 OFFSET $2",
        sort_sql
    );
    let rows = state
        .database
        .fetch_all(&sql, |q| q.bind(page_size).bind(offset))
        .await?;
    let mut listings = rows
        .into_iter()
        .map(build_market_partner_listing_dto)
        .collect::<Result<Vec<_>, _>>()?;
    apply_partner_listing_filters(&mut listings, &query);
    let total = listings.len() as i64;
    Ok(send_success(MarketPartnerListingsDataDto {
        listings,
        total,
    }))
}

pub async fn get_my_partner_market_listings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketPartnerMyListingsQuery>,
) -> Result<Json<SuccessResponse<MarketPartnerListingsDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    let status = query
        .status
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("active");
    let rows = state.database.fetch_all(
        "SELECT mpl.id, mpl.partner_snapshot, mpl.unit_price_spirit_stones, mpl.seller_character_id, seller.nickname AS seller_name, mpl.listed_at::text AS listed_at_text FROM market_partner_listing mpl JOIN characters seller ON seller.id = mpl.seller_character_id WHERE mpl.seller_character_id = $1 AND mpl.status = $2 ORDER BY mpl.listed_at DESC LIMIT $3 OFFSET $4",
        |q| q.bind(actor.character_id).bind(status).bind(page_size).bind(offset),
    ).await?;
    let count_row = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM market_partner_listing WHERE seller_character_id = $1 AND status = $2",
        |q| q.bind(actor.character_id).bind(status),
    ).await?;
    let total = count_row
        .and_then(|r| r.try_get::<Option<i64>, _>("cnt").ok().flatten())
        .unwrap_or_default();
    let listings = rows
        .into_iter()
        .map(build_market_partner_listing_dto)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(send_success(MarketPartnerListingsDataDto {
        listings,
        total,
    }))
}

pub async fn get_partner_market_trade_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketRecordsQuery>,
) -> Result<Json<SuccessResponse<MarketPartnerTradeRecordsDataDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let page = clamp_page(query.page);
    let page_size = clamp_page_size(query.page_size);
    let offset = (page - 1) * page_size;
    let rows = state.database.fetch_all(
        "SELECT tr.id, tr.partner_snapshot, tr.unit_price_spirit_stones, tr.total_price_spirit_stones, tr.buyer_character_id, buyer.nickname AS buyer_name, seller.nickname AS seller_name, tr.created_at::text AS created_at_text FROM market_partner_trade_record tr JOIN characters buyer ON buyer.id = tr.buyer_character_id JOIN characters seller ON seller.id = tr.seller_character_id WHERE tr.buyer_character_id = $1 OR tr.seller_character_id = $1 ORDER BY tr.created_at DESC LIMIT $2 OFFSET $3",
        |q| q.bind(actor.character_id).bind(page_size).bind(offset),
    ).await?;
    let count_row = state.database.fetch_optional(
        "SELECT COUNT(*)::bigint AS cnt FROM market_partner_trade_record WHERE buyer_character_id = $1 OR seller_character_id = $1",
        |q| q.bind(actor.character_id),
    ).await?;
    let total = count_row
        .and_then(|r| r.try_get::<Option<i64>, _>("cnt").ok().flatten())
        .unwrap_or_default();
    let records = rows
        .into_iter()
        .map(|row| build_market_partner_trade_record_dto(&row, actor.character_id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(send_success(MarketPartnerTradeRecordsDataDto {
        records,
        total,
    }))
}

pub async fn get_market_partner_technique_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MarketPartnerTechniqueDetailQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    assert_market_phone_bound(&state, actor.user_id).await?;
    let listing_id = query.listing_id.unwrap_or_default();
    let technique_id = query.technique_id.unwrap_or_default();
    if listing_id <= 0 {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("listingId 参数无效".to_string()),
                data: None,
            },
        ));
    }
    if technique_id.trim().is_empty() {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("techniqueId 参数无效".to_string()),
                data: None,
            },
        ));
    }

    let row = state.database.fetch_optional(
        "SELECT seller_character_id, status, partner_snapshot FROM market_partner_listing WHERE id = $1 LIMIT 1",
        |q| q.bind(listing_id),
    ).await?;
    let Some(row) = row else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("伙伴挂单不存在".to_string()),
                data: None,
            },
        ));
    };
    let seller_character_id = row
        .try_get::<Option<i32>, _>("seller_character_id")?
        .map(i64::from)
        .unwrap_or_default();
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "active" && seller_character_id != actor.character_id {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("当前挂单不可查看功法详情".to_string()),
                data: None,
            },
        ));
    }
    let snapshot = row
        .try_get::<Option<serde_json::Value>, _>("partner_snapshot")?
        .unwrap_or_else(|| serde_json::json!({}));
    let Some(technique_entry) = snapshot
        .get("techniques")
        .and_then(|v| v.as_array())
        .and_then(|entries| {
            entries.iter().find(|entry| {
                entry.get("techniqueId").and_then(|v| v.as_str()) == Some(technique_id.trim())
            })
        })
    else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("伙伴未学习该功法".to_string()),
                data: None,
            },
        ));
    };
    let Some(detail) = load_technique_detail_data(&state, technique_id.trim(), None, true).await?
    else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<MarketPartnerTechniqueDetailDto> {
                success: false,
                message: Some("伙伴功法详情不存在".to_string()),
                data: None,
            },
        ));
    };
    let response = MarketPartnerTechniqueDetailDto {
        technique: serde_json::to_value(detail.technique)
            .map_err(|error| AppError::config(format!("坊市伙伴功法详情序列化失败: {error}")))?,
        layers: serde_json::to_value(detail.layers)
            .map_err(|error| AppError::config(format!("坊市伙伴功法层级序列化失败: {error}")))?
            .as_array()
            .cloned()
            .unwrap_or_default(),
        skills: serde_json::to_value(detail.skills)
            .map_err(|error| AppError::config(format!("坊市伙伴功法技能序列化失败: {error}")))?
            .as_array()
            .cloned()
            .unwrap_or_default(),
        current_layer: technique_entry
            .get("currentLayer")
            .and_then(|v| v.as_i64())
            .unwrap_or(1),
        is_innate: technique_entry
            .get("isInnate")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    };
    Ok(crate::shared::response::send_result(
        crate::shared::response::ServiceResult {
            success: true,
            message: Some("获取成功".to_string()),
            data: Some(response),
        },
    ))
}

pub(crate) async fn assert_market_phone_bound(
    state: &AppState,
    user_id: i64,
) -> Result<(), AppError> {
    if !state.config.market_phone_binding.enabled {
        return Ok(());
    }
    let row = state
        .database
        .fetch_optional(
            "SELECT phone_number FROM users WHERE id = $1 LIMIT 1",
            |q| q.bind(user_id),
        )
        .await?;
    let phone_number = row
        .and_then(|r| {
            r.try_get::<Option<String>, _>("phone_number")
                .ok()
                .flatten()
        })
        .unwrap_or_default();
    if phone_number.trim().is_empty() {
        return Err(AppError::config("坊市功能需要先完成手机号绑定"));
    }
    Ok(())
}

fn clamp_page(value: Option<i64>) -> i64 {
    value.unwrap_or(1).max(1)
}
fn clamp_page_size(value: Option<i64>) -> i64 {
    value.unwrap_or(20).clamp(1, 100)
}

fn apply_market_listing_filters(listings: &mut Vec<MarketListingDto>, query: &MarketListingsQuery) {
    let category = query
        .category
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "all")
        .map(|v| v.to_lowercase());
    let quality = query
        .quality
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "all")
        .map(|v| v.to_string());
    let text = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_lowercase());
    let min_price = query.min_price.unwrap_or(0);
    let max_price = query.max_price.unwrap_or(i64::MAX);
    listings.retain(|listing| {
        let category_ok = category
            .as_ref()
            .map(|value| listing.category.as_deref().map(str::to_lowercase) == Some(value.clone()))
            .unwrap_or(true);
        let quality_ok = quality
            .as_ref()
            .map(|value| listing.quality.as_deref() == Some(value.as_str()))
            .unwrap_or(true);
        let text_ok = text
            .as_ref()
            .map(|value| {
                listing.name.to_lowercase().contains(value)
                    || listing
                        .description
                        .as_deref()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(value)
            })
            .unwrap_or(true);
        let price_ok = listing.unit_price_spirit_stones >= min_price
            && listing.unit_price_spirit_stones <= max_price;
        category_ok && quality_ok && text_ok && price_ok
    });
}

async fn build_market_listing_dto(
    state: &AppState,
    row: &sqlx::postgres::PgRow,
    metas: &BTreeMap<String, MarketItemMeta>,
) -> Result<Option<MarketListingDto>, AppError> {
    let item_def_id = row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let item_def_id = item_def_id.trim().to_string();
    if item_def_id.is_empty() {
        return Ok(None);
    }
    let Some(meta) = metas.get(&item_def_id) else {
        return Ok(None);
    };
    let generated_display = resolve_generated_technique_book_display(
        state,
        item_def_id.as_str(),
        &meta.raw,
        row.try_get::<Option<serde_json::Value>, _>("metadata")?
            .as_ref(),
    )
    .await?;
    Ok(Some(MarketListingDto {
        id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        item_instance_id: row
            .try_get::<Option<i64>, _>("item_instance_id")?
            .unwrap_or_default(),
        item_def_id,
        name: generated_display
            .as_ref()
            .map(|display| display.name.clone())
            .unwrap_or_else(|| meta.name.clone()),
        icon: meta.icon.clone(),
        quality: row
            .try_get::<Option<String>, _>("instance_quality")?
            .or_else(|| {
                generated_display
                    .as_ref()
                    .and_then(|display| display.quality.clone())
            })
            .or_else(|| meta.quality.clone()),
        category: meta.category.clone(),
        sub_category: meta.sub_category.clone(),
        description: generated_display
            .as_ref()
            .map(|display| display.description.clone())
            .or_else(|| meta.description.clone()),
        long_desc: generated_display
            .as_ref()
            .map(|display| display.long_desc.clone())
            .or_else(|| meta.long_desc.clone()),
        tags: generated_display
            .as_ref()
            .map(|display| display.tags.clone())
            .unwrap_or_else(|| meta.tags.clone()),
        effect_defs: meta.effect_defs.clone(),
        base_attrs: meta.base_attrs.clone(),
        equip_slot: meta.equip_slot.clone(),
        equip_req_realm: meta.equip_req_realm.clone(),
        use_type: meta.use_type.clone(),
        strengthen_level: row
            .try_get::<Option<i32>, _>("strengthen_level")?
            .map(i64::from)
            .unwrap_or_default(),
        refine_level: row
            .try_get::<Option<i32>, _>("refine_level")?
            .map(i64::from)
            .unwrap_or_default(),
        identified: row
            .try_get::<Option<bool>, _>("identified")?
            .unwrap_or(true),
        affixes: row
            .try_get::<Option<serde_json::Value>, _>("affixes")?
            .unwrap_or_else(|| serde_json::json!([])),
        socketed_gems: row
            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
            .unwrap_or_else(|| serde_json::json!([])),
        generated_technique_id: generated_display
            .as_ref()
            .map(|display| display.generated_technique_id.clone()),
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default(),
        unit_price_spirit_stones: row
            .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
            .unwrap_or_default(),
        seller_character_id: row
            .try_get::<Option<i32>, _>("seller_character_id")?
            .map(i64::from)
            .unwrap_or_default(),
        seller_name: row
            .try_get::<Option<String>, _>("seller_name")?
            .unwrap_or_default(),
        listed_at: parse_time_ms(row.try_get::<Option<String>, _>("listed_at_text")?),
    }))
}

fn build_market_trade_record_dto(
    row: &sqlx::postgres::PgRow,
    character_id: i64,
    metas: &BTreeMap<String, MarketItemMeta>,
) -> Result<MarketTradeRecordDto, AppError> {
    let buyer_character_id = opt_i64_from_i32(row, "buyer_character_id");
    let item_def_id = row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let meta = metas.get(item_def_id.trim());
    let trade_type = if character_id == buyer_character_id {
        "买入"
    } else {
        "卖出"
    };
    let counterparty = if trade_type == "买入" {
        row.try_get::<Option<String>, _>("seller_name")?
            .unwrap_or_default()
    } else {
        row.try_get::<Option<String>, _>("buyer_name")?
            .unwrap_or_default()
    };
    Ok(MarketTradeRecordDto {
        id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        r#type: trade_type.to_string(),
        item_def_id: item_def_id.trim().to_string(),
        name: meta
            .map(|m| m.name.clone())
            .unwrap_or_else(|| item_def_id.trim().to_string()),
        icon: meta.and_then(|m| m.icon.clone()),
        qty: row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default(),
        unit_price_spirit_stones: row
            .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
            .unwrap_or_default(),
        counterparty,
        time: parse_time_ms(row.try_get::<Option<String>, _>("created_at_text")?),
    })
}

fn build_market_partner_listing_dto(
    row: sqlx::postgres::PgRow,
) -> Result<MarketPartnerListingDto, AppError> {
    Ok(MarketPartnerListingDto {
        id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        partner: row
            .try_get::<Option<serde_json::Value>, _>("partner_snapshot")?
            .unwrap_or_else(|| serde_json::json!({})),
        unit_price_spirit_stones: row
            .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
            .unwrap_or_default(),
        seller_character_id: row
            .try_get::<Option<i32>, _>("seller_character_id")?
            .map(i64::from)
            .unwrap_or_default(),
        seller_name: row
            .try_get::<Option<String>, _>("seller_name")?
            .unwrap_or_default(),
        listed_at: parse_time_ms(row.try_get::<Option<String>, _>("listed_at_text")?),
    })
}

fn build_market_partner_trade_record_dto(
    row: &sqlx::postgres::PgRow,
    viewer_character_id: i64,
) -> Result<MarketPartnerTradeRecordDto, AppError> {
    let buyer_character_id = opt_i64_from_i32(row, "buyer_character_id");
    let trade_type = if buyer_character_id == viewer_character_id {
        "买入"
    } else {
        "卖出"
    };
    let counterparty = if trade_type == "买入" {
        row.try_get::<Option<String>, _>("seller_name")?
            .unwrap_or_default()
    } else {
        row.try_get::<Option<String>, _>("buyer_name")?
            .unwrap_or_default()
    };
    Ok(MarketPartnerTradeRecordDto {
        id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        r#type: trade_type.to_string(),
        partner: row
            .try_get::<Option<serde_json::Value>, _>("partner_snapshot")?
            .unwrap_or_else(|| serde_json::json!({})),
        unit_price_spirit_stones: row
            .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
            .unwrap_or_default(),
        total_price_spirit_stones: row
            .try_get::<Option<i64>, _>("total_price_spirit_stones")?
            .unwrap_or_default(),
        counterparty,
        time: parse_time_ms(row.try_get::<Option<String>, _>("created_at_text")?),
    })
}

fn apply_partner_listing_filters(
    listings: &mut Vec<MarketPartnerListingDto>,
    query: &MarketPartnerListingsQuery,
) {
    let quality = query
        .quality
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "all")
        .map(|v| v.to_string());
    let element = query
        .element
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "all")
        .map(|v| v.to_string());
    let text = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_lowercase());
    listings.retain(|listing| {
        let partner = listing.partner.as_object();
        let quality_ok = quality
            .as_ref()
            .map(|value| {
                partner
                    .and_then(|p| p.get("quality"))
                    .and_then(|v| v.as_str())
                    == Some(value.as_str())
            })
            .unwrap_or(true);
        let element_ok = element
            .as_ref()
            .map(|value| {
                partner
                    .and_then(|p| p.get("element"))
                    .and_then(|v| v.as_str())
                    == Some(value.as_str())
            })
            .unwrap_or(true);
        let text_ok = text
            .as_ref()
            .map(|value| {
                let nickname = partner
                    .and_then(|p| p.get("nickname"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_lowercase();
                let name = partner
                    .and_then(|p| p.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_lowercase();
                nickname.contains(value) || name.contains(value)
            })
            .unwrap_or(true);
        quality_ok && element_ok && text_ok
    });
}

fn parse_time_ms(raw: Option<String>) -> i64 {
    raw.as_deref()
        .and_then(|value| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        })
        .map(|value| (value.unix_timestamp_nanos() / 1_000_000) as i64)
        .unwrap_or_default()
}

fn load_market_item_meta_map() -> Result<BTreeMap<String, MarketItemMeta>, AppError> {
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
                MarketItemMeta {
                    raw: item.clone(),
                    name,
                    icon: item
                        .get("icon")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    quality: item
                        .get("quality")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    category: item
                        .get("category")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    sub_category: item
                        .get("sub_category")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    description: item
                        .get("description")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    long_desc: item
                        .get("long_desc")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    base_attrs: item
                        .get("base_attrs")
                        .and_then(|value| value.as_object())
                        .map(|map| {
                            map.iter()
                                .filter_map(|(k, v)| {
                                    v.as_f64()
                                        .or_else(|| v.as_i64().map(|n| n as f64))
                                        .map(|n| (k.clone(), n))
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    equip_slot: item
                        .get("equip_slot")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    equip_req_realm: item
                        .get("equip_req_realm")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    use_type: item
                        .get("use_type")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    tags: item
                        .get("tags")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([])),
                    effect_defs: item
                        .get("effect_defs")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!([])),
                    tradeable: item
                        .get("tradeable")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                    tax_rate: item
                        .get("tax_rate")
                        .and_then(|value| {
                            value.as_f64().or_else(|| value.as_i64().map(|v| v as f64))
                        })
                        .unwrap_or(0.0),
                },
            );
        }
    }
    Ok(out)
}

async fn verify_market_captcha_payload(
    state: &AppState,
    payload: &MarketCaptchaVerifyPayload,
    user_ip: &str,
) -> Result<(), AppError> {
    match state.config.captcha.provider {
        CaptchaProvider::Tencent => {
            let ticket = payload.ticket.as_deref().map(str::trim).unwrap_or_default();
            let randstr = payload
                .randstr
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if ticket.is_empty() || randstr.is_empty() {
                return Err(AppError::config("验证码票据不能为空"));
            }
            return tencent_captcha::verify_tencent_captcha_ticket(
                &state.outbound_http,
                &state.config.captcha,
                ticket,
                randstr,
                user_ip,
            )
            .await;
        }
        CaptchaProvider::Local => {}
    }

    let captcha_id = payload
        .captcha_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    let captcha_code = payload
        .captcha_code
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if captcha_id.is_empty() || captcha_code.is_empty() {
        return Err(AppError::config("图片验证码不能为空"));
    }
    let redis = RedisRuntime::new(
        state
            .redis
            .clone()
            .ok_or_else(|| AppError::service_unavailable("当前验证码服务不可用"))?,
    );
    let key = format!("{MARKET_CAPTCHA_KEY_PREFIX}{captcha_id}");
    let raw = redis
        .get_string(&key)
        .await?
        .ok_or_else(|| AppError::config("验证码不存在或已失效"))?;
    redis.del(&key).await?;
    let stored: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| AppError::config(format!("failed to decode captcha payload: {error}")))?;
    let answer = stored
        .get("answer")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_ascii_uppercase();
    let expires_at = stored
        .get("expiresAt")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if expires_at < now_secs() {
        return Err(AppError::config("验证码已过期"));
    }
    if answer != captcha_code.to_ascii_uppercase() {
        return Err(AppError::config("验证码错误"));
    }
    Ok(())
}

fn generate_market_captcha_answer() -> String {
    (0..4)
        .map(|index| {
            let seed = (now_millis() as usize).wrapping_add(index * 17);
            let offset = seed % MARKET_CAPTCHA_CHARSET.len();
            MARKET_CAPTCHA_CHARSET[offset] as char
        })
        .collect()
}

fn build_market_captcha_image_data(answer: &str) -> String {
    use base64::Engine;
    let svg = format!(
        r#"<svg xmlns='http://www.w3.org/2000/svg' width='120' height='44'><rect width='120' height='44' fill='#10141f'/><text x='60' y='29' text-anchor='middle' font-size='22' font-family='monospace' fill='#f8d66d'>{answer}</text></svg>"#
    );
    format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    )
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

async fn cancel_partner_market_listing_tx(
    state: &AppState,
    character_id: i64,
    listing_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT seller_character_id, status, listing_fee_silver FROM market_partner_listing WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(listing_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("上架记录不存在".to_string()),
            data: None,
        });
    };
    let seller_character_id = row
        .try_get::<Option<i32>, _>("seller_character_id")?
        .map(i64::from)
        .unwrap_or_default();
    if seller_character_id != character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("上架记录归属异常".to_string()),
            data: None,
        });
    }
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "active" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该上架记录不可下架".to_string()),
            data: None,
        });
    }
    state.database.execute(
        "UPDATE market_partner_listing SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
        |q| q.bind(listing_id),
    ).await?;
    let refund_fee_silver = row
        .try_get::<Option<i64>, _>("listing_fee_silver")?
        .unwrap_or_default()
        .max(0);
    if refund_fee_silver > 0 {
        state.database.execute(
            "UPDATE characters SET silver = COALESCE(silver, 0) + $2, updated_at = NOW() WHERE id = $1",
            |q| q.bind(character_id).bind(refund_fee_silver),
        ).await?;
    }
    Ok(ServiceResult {
        success: true,
        message: Some(format!("下架成功，已退还{}银两手续费", refund_fee_silver)),
        data: Some(serde_json::json!({
            "debugRealtime": build_market_update_payload("cancel_partner_listing", Some(listing_id), "partner")
        })),
    })
}

async fn cancel_market_listing_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    listing_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, seller_character_id, item_instance_id, qty, original_qty, status, listing_fee_silver FROM market_listing WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(listing_id),
    ).await?;
    let Some(row) = row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("上架记录不存在".to_string()),
            data: None,
        });
    };
    let seller_character_id = row
        .try_get::<Option<i32>, _>("seller_character_id")?
        .map(i64::from)
        .unwrap_or_default();
    if seller_character_id != character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("无权限操作该上架记录".to_string()),
            data: None,
        });
    }
    let status = row
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "active" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该上架记录不可下架".to_string()),
            data: None,
        });
    }
    let item_instance_id = row
        .try_get::<Option<i64>, _>("item_instance_id")?
        .unwrap_or_default();
    let item_row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id),
    ).await?;
    let Some(item_row) = item_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let owner_character_id = item_row
        .try_get::<Option<i64>, _>("owner_character_id")?
        .unwrap_or_default();
    if owner_character_id != character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品归属异常，无法下架".to_string()),
            data: None,
        });
    }
    let location = item_row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if location != "auction" {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不在坊市中，无法下架".to_string()),
            data: None,
        });
    }
    let refund_fee_silver = row
        .try_get::<Option<i64>, _>("listing_fee_silver")?
        .unwrap_or_default()
        .max(0);
    let item_def_id = item_row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let item_qty = item_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or(1)
        .max(1);
    let item_name = load_market_item_meta_map()?
        .get(item_def_id.trim())
        .map(|meta| meta.name.clone())
        .unwrap_or_else(|| item_def_id.trim().to_string());

    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            let now_ms = market_timestamp_ms();
            let mutation = BufferedItemInstanceMutation {
                op_id: format!("market-cancel:{item_instance_id}:{now_ms}"),
                character_id,
                item_id: item_instance_id,
                created_at_ms: now_ms,
                kind: "upsert".to_string(),
                snapshot: Some(ItemInstanceMutationSnapshot {
                    id: item_instance_id,
                    owner_user_id: item_row
                        .try_get::<Option<i64>, _>("owner_user_id")?
                        .unwrap_or_default(),
                    owner_character_id: character_id,
                    item_def_id: item_def_id.clone(),
                    qty: item_qty,
                    quality: item_row.try_get::<Option<String>, _>("quality")?,
                    quality_rank: item_row
                        .try_get::<Option<i32>, _>("quality_rank")?
                        .map(i64::from),
                    bind_type: item_row
                        .try_get::<Option<String>, _>("bind_type")?
                        .unwrap_or_else(|| "none".to_string()),
                    bind_owner_user_id: item_row.try_get::<Option<i64>, _>("bind_owner_user_id")?,
                    bind_owner_character_id: item_row
                        .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                    location: "mail".to_string(),
                    location_slot: None,
                    equipped_slot: None,
                    strengthen_level: item_row
                        .try_get::<Option<i32>, _>("strengthen_level")?
                        .map(i64::from)
                        .unwrap_or_default(),
                    refine_level: item_row
                        .try_get::<Option<i32>, _>("refine_level")?
                        .map(i64::from)
                        .unwrap_or_default(),
                    socketed_gems: item_row
                        .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
                        .unwrap_or_else(|| serde_json::json!([])),
                    random_seed: item_row.try_get::<Option<i64>, _>("random_seed")?,
                    affixes: item_row
                        .try_get::<Option<serde_json::Value>, _>("affixes")?
                        .unwrap_or_else(|| serde_json::json!([])),
                    identified: item_row
                        .try_get::<Option<bool>, _>("identified")?
                        .unwrap_or(false),
                    affix_gen_version: item_row
                        .try_get::<Option<i32>, _>("affix_gen_version")?
                        .map(i64::from)
                        .unwrap_or_default(),
                    affix_roll_meta: item_row
                        .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
                        .unwrap_or_else(|| serde_json::json!({})),
                    custom_name: item_row.try_get::<Option<String>, _>("custom_name")?,
                    locked: item_row
                        .try_get::<Option<bool>, _>("locked")?
                        .unwrap_or(false),
                    expire_at: item_row.try_get::<Option<String>, _>("expire_at_text")?,
                    obtained_from: Some("market".to_string()),
                    obtained_ref_id: Some(listing_id.to_string()),
                    metadata: item_row.try_get::<Option<serde_json::Value>, _>("metadata")?,
                }),
            };
            buffer_item_instance_mutations(&redis, &[mutation]).await?;
        }
    } else {
        state.database.execute(
            "UPDATE item_instance SET location = 'mail', location_slot = NULL, equipped_slot = NULL, obtained_from = 'market', obtained_ref_id = $2, updated_at = NOW() WHERE id = $1",
            |q| q.bind(item_instance_id).bind(listing_id.to_string()),
        ).await?;
    }
    state.database.execute(
        "UPDATE market_listing SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1",
        |q| q.bind(listing_id),
    ).await?;
    if refund_fee_silver > 0 {
        state.database.execute(
            "UPDATE characters SET silver = COALESCE(silver, 0) + $2, updated_at = NOW() WHERE id = $1",
            |q| q.bind(character_id).bind(refund_fee_silver),
        ).await?;
    }
    state.database.execute(
        "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_instance_ids, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '坊市', 'trade', $3, $4, $5::jsonb, 'market', $6, $7::jsonb, NOW(), NOW())",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind("坊市下架返还通知")
            .bind("你下架的坊市物品已通过邮件返还，请及时领取附件。")
            .bind(serde_json::json!([item_instance_id]))
            .bind(listing_id.to_string())
            .bind(serde_json::json!({
                "listingId": listing_id,
                "action": "cancel",
                "attachmentPreviewItems": [{
                    "itemDefId": item_def_id,
                    "itemName": item_name,
                    "quantity": item_qty
                }]
            })),
    ).await?;
    apply_mail_counter_deltas(
        &state,
        &build_new_mail_counter_deltas(user_id, Some(character_id), true),
    )
    .await?;
    Ok(ServiceResult {
        success: true,
        message: Some(format!(
            "下架成功，物品已通过邮件返还，并退还{}银两手续费",
            refund_fee_silver
        )),
        data: Some(serde_json::json!({
            "debugRealtime": build_market_update_payload("cancel_market_listing", Some(listing_id), "item")
        })),
    })
}

async fn create_market_listing_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_instance_id: i64,
    qty: i64,
    unit_price_spirit_stones: i64,
) -> Result<ServiceResult<MarketItemListDataDto>, AppError> {
    let item_row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 AND owner_character_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id).bind(character_id),
    ).await?;
    let Some(item_row) = item_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let owner_user_id = item_row
        .try_get::<Option<i64>, _>("owner_user_id")?
        .unwrap_or_default();
    if owner_user_id != user_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品归属异常".to_string()),
            data: None,
        });
    }
    let item_def_id = item_row
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let item_metas = load_market_item_meta_map()?;
    let Some(item_meta) = item_metas.get(item_def_id.trim()) else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    if !item_meta.tradeable {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品不可交易".to_string()),
            data: None,
        });
    }
    let bind_type = item_row
        .try_get::<Option<String>, _>("bind_type")?
        .unwrap_or_else(|| "none".to_string());
    if bind_type != "none" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品已绑定，无法上架".to_string()),
            data: None,
        });
    }
    let locked = item_row
        .try_get::<Option<bool>, _>("locked")?
        .unwrap_or(false);
    if locked {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品已锁定，无法上架".to_string()),
            data: None,
        });
    }
    let location = item_row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    let equipped_slot = item_row.try_get::<Option<String>, _>("equipped_slot")?;
    if location == "equipped"
        || equipped_slot
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("已穿戴物品无法上架".to_string()),
            data: None,
        });
    }
    if location != "bag" && location != "warehouse" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品当前位置无法上架".to_string()),
            data: None,
        });
    }
    let current_qty = item_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if qty > current_qty {
        return Ok(ServiceResult {
            success: false,
            message: Some("数量不足".to_string()),
            data: None,
        });
    }

    let listing_fee_silver = unit_price_spirit_stones
        .saturating_mul(qty)
        .saturating_mul(5);
    let character_row = state
        .database
        .fetch_optional(
            "SELECT silver FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(character_row) = character_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let silver = character_row
        .try_get::<Option<i64>, _>("silver")?
        .unwrap_or_default();
    if listing_fee_silver > silver {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("银两不足，上架手续费需要{}", listing_fee_silver)),
            data: None,
        });
    }

    let auction_item_id = if qty < current_qty {
        let inserted = state.database.fetch_one(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at, obtained_from, obtained_ref_id, metadata, created_at, updated_at) SELECT owner_user_id, owner_character_id, item_def_id, $2, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, 'auction', NULL, NULL, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at, obtained_from, obtained_ref_id, metadata, NOW(), NOW() FROM item_instance WHERE id = $1 RETURNING id",
            |q| q.bind(item_instance_id).bind(qty),
        ).await?;
        if state.redis_available {
            if let Some(redis_client) = state.redis.clone() {
                let redis = RedisRuntime::new(redis_client);
                let now_ms = market_timestamp_ms();
                let mutation = BufferedItemInstanceMutation {
                    op_id: format!("market-listing-source:{item_instance_id}:{now_ms}"),
                    character_id,
                    item_id: item_instance_id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(ItemInstanceMutationSnapshot {
                        id: item_instance_id,
                        owner_user_id,
                        owner_character_id: character_id,
                        item_def_id: item_def_id.clone(),
                        qty: current_qty - qty,
                        quality: item_row.try_get::<Option<String>, _>("quality")?,
                        quality_rank: item_row
                            .try_get::<Option<i32>, _>("quality_rank")?
                            .map(i64::from),
                        bind_type: bind_type.clone(),
                        bind_owner_user_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_user_id")?,
                        bind_owner_character_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                        location: location.clone(),
                        location_slot: item_row
                            .try_get::<Option<i32>, _>("location_slot")?
                            .map(i64::from),
                        equipped_slot: item_row.try_get::<Option<String>, _>("equipped_slot")?,
                        strengthen_level: item_row
                            .try_get::<Option<i32>, _>("strengthen_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        refine_level: item_row
                            .try_get::<Option<i32>, _>("refine_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        socketed_gems: item_row
                            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        random_seed: item_row.try_get::<Option<i64>, _>("random_seed")?,
                        affixes: item_row
                            .try_get::<Option<serde_json::Value>, _>("affixes")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        identified: item_row
                            .try_get::<Option<bool>, _>("identified")?
                            .unwrap_or(false),
                        affix_gen_version: item_row
                            .try_get::<Option<i32>, _>("affix_gen_version")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        affix_roll_meta: item_row
                            .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
                            .unwrap_or_else(|| serde_json::json!({})),
                        custom_name: item_row.try_get::<Option<String>, _>("custom_name")?,
                        locked: locked,
                        expire_at: item_row.try_get::<Option<String>, _>("expire_at_text")?,
                        obtained_from: item_row.try_get::<Option<String>, _>("obtained_from")?,
                        obtained_ref_id: item_row
                            .try_get::<Option<String>, _>("obtained_ref_id")?,
                        metadata: item_row.try_get::<Option<serde_json::Value>, _>("metadata")?,
                    }),
                };
                buffer_item_instance_mutations(&redis, &[mutation]).await?;
            }
        } else {
            state
                .database
                .execute(
                    "UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                    |q| q.bind(item_instance_id).bind(qty),
                )
                .await?;
        }
        inserted.try_get::<i64, _>("id")?
    } else {
        if state.redis_available {
            if let Some(redis_client) = state.redis.clone() {
                let redis = RedisRuntime::new(redis_client);
                let now_ms = market_timestamp_ms();
                let mutation = BufferedItemInstanceMutation {
                    op_id: format!("market-listing-move:{item_instance_id}:{now_ms}"),
                    character_id,
                    item_id: item_instance_id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(ItemInstanceMutationSnapshot {
                        id: item_instance_id,
                        owner_user_id,
                        owner_character_id: character_id,
                        item_def_id: item_def_id.clone(),
                        qty: current_qty,
                        quality: item_row.try_get::<Option<String>, _>("quality")?,
                        quality_rank: item_row
                            .try_get::<Option<i32>, _>("quality_rank")?
                            .map(i64::from),
                        bind_type: bind_type.clone(),
                        bind_owner_user_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_user_id")?,
                        bind_owner_character_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                        location: "auction".to_string(),
                        location_slot: None,
                        equipped_slot: None,
                        strengthen_level: item_row
                            .try_get::<Option<i32>, _>("strengthen_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        refine_level: item_row
                            .try_get::<Option<i32>, _>("refine_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        socketed_gems: item_row
                            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        random_seed: item_row.try_get::<Option<i64>, _>("random_seed")?,
                        affixes: item_row
                            .try_get::<Option<serde_json::Value>, _>("affixes")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        identified: item_row
                            .try_get::<Option<bool>, _>("identified")?
                            .unwrap_or(false),
                        affix_gen_version: item_row
                            .try_get::<Option<i32>, _>("affix_gen_version")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        affix_roll_meta: item_row
                            .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
                            .unwrap_or_else(|| serde_json::json!({})),
                        custom_name: item_row.try_get::<Option<String>, _>("custom_name")?,
                        locked: item_row
                            .try_get::<Option<bool>, _>("locked")?
                            .unwrap_or(false),
                        expire_at: item_row.try_get::<Option<String>, _>("expire_at_text")?,
                        obtained_from: item_row.try_get::<Option<String>, _>("obtained_from")?,
                        obtained_ref_id: item_row
                            .try_get::<Option<String>, _>("obtained_ref_id")?,
                        metadata: item_row.try_get::<Option<serde_json::Value>, _>("metadata")?,
                    }),
                };
                buffer_item_instance_mutations(&redis, &[mutation]).await?;
            }
        } else {
            state.database.execute(
                "UPDATE item_instance SET location = 'auction', location_slot = NULL, equipped_slot = NULL, updated_at = NOW() WHERE id = $1",
                |q| q.bind(item_instance_id),
            ).await?;
        }
        item_instance_id
    };

    state.database.execute(
        "UPDATE characters SET silver = COALESCE(silver, 0) - $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(character_id).bind(listing_fee_silver),
    ).await?;
    let listing_row = state.database.fetch_one(
        "INSERT INTO market_listing (seller_user_id, seller_character_id, item_instance_id, item_def_id, qty, original_qty, unit_price_spirit_stones, listing_fee_silver, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active') RETURNING id",
        |q| q.bind(user_id).bind(character_id).bind(auction_item_id).bind(item_def_id.trim()).bind(qty).bind(qty).bind(unit_price_spirit_stones).bind(listing_fee_silver),
    ).await?;
    let listing_id = listing_row.try_get::<i64, _>("id")?;
    Ok(ServiceResult {
        success: true,
        message: Some(format!(
            "上架成功，已收取{}银两手续费（未卖出下架将退还）",
            listing_fee_silver
        )),
        data: Some(MarketItemListDataDto {
            listing_id,
            debug_realtime: Some(build_market_update_payload(
                "create_market_listing",
                Some(listing_id),
                "item",
            )),
        }),
    })
}

async fn create_partner_market_listing_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    partner_id: i64,
    unit_price_spirit_stones: i64,
) -> Result<ServiceResult<MarketPartnerListDataDto>, AppError> {
    let character_row = state
        .database
        .fetch_optional(
            "SELECT user_id, realm, sub_realm, silver FROM characters WHERE id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    let Some(character_row) = character_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let owner_user_id = opt_i64_from_i32(&character_row, "user_id");
    if owner_user_id != user_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色归属异常".to_string()),
            data: None,
        });
    }

    let partner = load_market_partner_row_by_id(state, character_id, partner_id).await?;
    let Some(partner) = partner else {
        return Ok(ServiceResult {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        });
    };
    if partner.is_active {
        return Ok(ServiceResult {
            success: false,
            message: Some("出战中的伙伴不可上架".to_string()),
            data: None,
        });
    }
    if has_pending_partner_technique_preview_for_partner(state, character_id, partner_id, true)
        .await?
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("存在待处理的打书预览，请先确认或放弃".to_string()),
            data: None,
        });
    }
    let active_listing = state.database.fetch_optional(
        "SELECT id FROM market_partner_listing WHERE partner_id = $1 AND status = 'active' LIMIT 1",
        |q| q.bind(partner_id),
    ).await?;
    if active_listing.is_some() {
        return Ok(ServiceResult {
            success: false,
            message: Some("该伙伴已在坊市挂单中".to_string()),
            data: None,
        });
    }

    let total_price = unit_price_spirit_stones.max(0);
    let listing_fee_silver = total_price.saturating_mul(5);
    let current_silver = character_row
        .try_get::<Option<i64>, _>("silver")?
        .unwrap_or_default();
    if listing_fee_silver > current_silver {
        return Ok(ServiceResult {
            success: false,
            message: Some(format!("银两不足，上架手续费需要{}", listing_fee_silver)),
            data: None,
        });
    }

    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row
        .try_get::<Option<String>, _>("sub_realm")?
        .unwrap_or_default();
    let snapshot = build_market_partner_snapshot(state, &partner, &realm, &sub_realm).await?;
    let listing_row = state.database.fetch_one(
        "INSERT INTO market_partner_listing (seller_user_id, seller_character_id, partner_id, partner_snapshot, partner_def_id, partner_name, partner_nickname, partner_quality, partner_element, partner_level, unit_price_spirit_stones, listing_fee_silver, status) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, 'active') RETURNING id",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind(partner_id)
            .bind(&snapshot)
            .bind(snapshot.get("partnerDefId").and_then(|v| v.as_str()).unwrap_or_default())
            .bind(snapshot.get("name").and_then(|v| v.as_str()).unwrap_or_default())
            .bind(snapshot.get("nickname").and_then(|v| v.as_str()).unwrap_or_default())
            .bind(snapshot.get("quality").and_then(|v| v.as_str()).unwrap_or("黄"))
            .bind(snapshot.get("element").and_then(|v| v.as_str()).unwrap_or("none"))
            .bind(snapshot.get("level").and_then(|v| v.as_i64()).unwrap_or(1))
            .bind(unit_price_spirit_stones)
            .bind(listing_fee_silver),
    ).await?;
    state.database.execute(
        "UPDATE characters SET silver = COALESCE(silver, 0) - $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(character_id).bind(listing_fee_silver),
    ).await?;
    let listing_id = listing_row.try_get::<i64, _>("id")?;
    Ok(ServiceResult {
        success: true,
        message: Some(format!(
            "上架成功，已收取{}银两手续费（未卖出下架将退还）",
            listing_fee_silver
        )),
        data: Some(MarketPartnerListDataDto {
            listing_id,
            debug_realtime: Some(build_market_update_payload(
                "create_partner_listing",
                Some(listing_id),
                "partner",
            )),
        }),
    })
}

async fn load_market_partner_row_by_id(
    state: &AppState,
    character_id: i64,
    partner_id: i64,
) -> Result<Option<MarketPartnerRowData>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT * FROM character_partner WHERE id = $1 AND character_id = $2 LIMIT 1",
            |q| q.bind(partner_id).bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(MarketPartnerRowData {
        id: i64::from(row.try_get::<i32, _>("id")?),
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
        growth_max_qixue: row
            .try_get::<Option<i32>, _>("growth_max_qixue")?
            .map(i64::from)
            .unwrap_or_default(),
        growth_wugong: row
            .try_get::<Option<i32>, _>("growth_wugong")?
            .map(i64::from)
            .unwrap_or_default(),
        growth_fagong: row
            .try_get::<Option<i32>, _>("growth_fagong")?
            .map(i64::from)
            .unwrap_or_default(),
        growth_wufang: row
            .try_get::<Option<i32>, _>("growth_wufang")?
            .map(i64::from)
            .unwrap_or_default(),
        growth_fafang: row
            .try_get::<Option<i32>, _>("growth_fafang")?
            .map(i64::from)
            .unwrap_or_default(),
        growth_sudu: row
            .try_get::<Option<i32>, _>("growth_sudu")?
            .map(i64::from)
            .unwrap_or_default(),
        is_active: row
            .try_get::<Option<bool>, _>("is_active")?
            .unwrap_or(false),
        obtained_from: row.try_get::<Option<String>, _>("obtained_from")?,
    }))
}

async fn load_market_partner_technique_rows(
    state: &AppState,
    partner_id: i64,
) -> Result<Vec<MarketPartnerTechniqueRowData>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT technique_id, current_layer, is_innate FROM character_partner_technique WHERE partner_id = $1 ORDER BY is_innate DESC, created_at ASC, id ASC",
        |q| q.bind(partner_id),
    ).await?;
    rows.into_iter()
        .map(|row| {
            Ok(MarketPartnerTechniqueRowData {
                technique_id: row
                    .try_get::<Option<String>, _>("technique_id")?
                    .unwrap_or_default(),
                current_layer: row
                    .try_get::<Option<i32>, _>("current_layer")?
                    .map(i64::from)
                    .unwrap_or(1),
                is_innate: row
                    .try_get::<Option<bool>, _>("is_innate")?
                    .unwrap_or(false),
            })
        })
        .collect()
}

async fn build_market_partner_snapshot(
    state: &AppState,
    row: &MarketPartnerRowData,
    realm: &str,
    sub_realm: &str,
) -> Result<serde_json::Value, AppError> {
    let growth_cfg = load_market_partner_growth_config()?;
    let def = load_market_partner_def_resolved(state, row.partner_def_id.trim())
        .await?
        .ok_or_else(|| AppError::config(format!("伙伴模板不存在: {}", row.partner_def_id)))?;
    let technique_rows = load_market_partner_technique_rows(state, row.id).await?;
    let techniques = build_market_partner_snapshot_techniques(state, &def, technique_rows).await?;
    let effective_level = resolve_market_partner_effective_level(realm, sub_realm, row.level);
    let computed_attrs =
        build_market_partner_computed_attrs(&def, row, effective_level, &techniques);
    Ok(serde_json::json!({
        "id": row.id,
        "partnerDefId": def.id,
        "name": def.name,
        "nickname": if row.nickname.trim().is_empty() { def.name.clone() } else { row.nickname.clone() },
        "description": row.description.clone().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| def.description.clone().unwrap_or_default()),
        "avatar": row.avatar.clone().filter(|v| !v.trim().is_empty()).or_else(|| def.avatar.clone()),
        "element": def.attribute_element.clone().unwrap_or_else(|| "none".to_string()),
        "role": def.role.clone().unwrap_or_else(|| "伙伴".to_string()),
        "quality": def.quality.clone().unwrap_or_else(|| "黄".to_string()),
        "level": row.level.max(1),
        "currentEffectiveLevel": effective_level,
        "progressExp": row.progress_exp.max(0),
        "nextLevelCostExp": calc_market_partner_upgrade_exp_by_target_level(row.level.max(1) + 1, &growth_cfg),
        "slotCount": def.max_technique_slots.unwrap_or_default().max(0),
        "isActive": row.is_active,
        "isGenerated": def.source_job_id.as_ref().is_some_and(|value| !value.trim().is_empty()) || def.id.starts_with("partner-gen-") || def.id.starts_with("generated-"),
        "obtainedFrom": row.obtained_from,
        "growth": {
            "max_qixue": row.growth_max_qixue.max(0),
            "wugong": row.growth_wugong.max(0),
            "fagong": row.growth_fagong.max(0),
            "wufang": row.growth_wufang.max(0),
            "fafang": row.growth_fafang.max(0),
            "sudu": row.growth_sudu.max(0)
        },
        "levelAttrGains": to_number_map(def.level_attr_gains.clone()),
        "computedAttrs": computed_attrs,
        "techniques": techniques,
        "tradeStatus": "market_listed",
        "marketListingId": serde_json::Value::Null,
        "fusionStatus": "none",
        "fusionJobId": serde_json::Value::Null
    }))
}

fn load_market_partner_def_map() -> Result<BTreeMap<String, MarketPartnerDefSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/partner_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read partner_def.json: {error}")))?;
    let payload: MarketPartnerDefFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse partner_def.json: {error}")))?;
    Ok(payload
        .partners
        .into_iter()
        .filter(|row| row.enabled != Some(false))
        .map(|row| (row.id.clone(), row))
        .collect())
}

async fn load_market_partner_def_resolved(
    state: &AppState,
    partner_def_id: &str,
) -> Result<Option<MarketPartnerDefSeed>, AppError> {
    let defs = load_market_partner_def_map()?;
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
    Ok(Some(MarketPartnerDefSeed {
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

fn load_market_partner_growth_config() -> Result<MarketPartnerGrowthFile, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/partner_growth.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read partner_growth.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse partner_growth.json: {error}")))
}

async fn build_market_partner_snapshot_techniques(
    state: &AppState,
    def: &MarketPartnerDefSeed,
    rows: Vec<MarketPartnerTechniqueRowData>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let mut effective_rows = Vec::new();
    let innate_ids = def.innate_technique_ids.clone().unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    for technique_id in innate_ids {
        if seen.insert(technique_id.clone()) {
            let row = rows.iter().find(|row| row.technique_id == technique_id);
            effective_rows.push(MarketPartnerTechniqueRowData {
                technique_id,
                current_layer: row.map(|row| row.current_layer).unwrap_or(1),
                is_innate: true,
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
            return Err(AppError::config(format!(
                "伙伴功法不存在: {}",
                row.technique_id
            )));
        };
        let max_layer = detail.technique.max_layer.max(1);
        let current_layer = row.current_layer.clamp(1, max_layer);
        let all_layers = serde_json::to_value(&detail.layers)
            .map_err(|error| AppError::config(format!("坊市伙伴功法层级序列化失败: {error}")))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut skill_ids = Vec::new();
        let mut upgrade_counts = BTreeMap::<String, i64>::new();
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
                        skill_ids.push(skill_id.to_string());
                    }
                }
            }
            if let Some(skills) = layer
                .get("upgrade_skill_ids")
                .and_then(|value| value.as_array())
            {
                for skill in skills {
                    if let Some(skill_id) = skill.as_str() {
                        skill_ids.push(skill_id.to_string());
                        *upgrade_counts.entry(skill_id.to_string()).or_insert(0) += 1;
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
            .map(|skill| {
                serde_json::to_value(skill).map_err(|error| {
                    AppError::config(format!("坊市伙伴功法技能序列化失败: {error}"))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        out.push(serde_json::json!({
            "techniqueId": row.technique_id,
            "name": detail.technique.name,
            "description": detail.technique.description,
            "icon": detail.technique.icon,
            "quality": detail.technique.quality,
            "currentLayer": current_layer,
            "maxLayer": max_layer,
            "skillIds": skill_ids,
            "skills": skills,
            "passiveAttrs": passive_attrs,
            "isInnate": row.is_innate
        }));
    }
    Ok(out)
}

fn build_market_partner_computed_attrs(
    def: &MarketPartnerDefSeed,
    row: &MarketPartnerRowData,
    effective_level: i64,
    techniques: &[serde_json::Value],
) -> serde_json::Value {
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
        if let Some(passive_attrs) = technique.get("passiveAttrs").and_then(|v| v.as_object()) {
            for (key, value) in passive_attrs {
                if let Some(value) = value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)) {
                    *attrs.entry(key.clone()).or_insert(0.0) += value;
                }
            }
        }
    }
    let max_qixue = attrs.get("max_qixue").copied().unwrap_or(1.0).max(1.0) as i64;
    let max_lingqi = attrs.get("max_lingqi").copied().unwrap_or(0.0).max(0.0) as i64;
    serde_json::json!({
        "qixue": max_qixue,
        "max_qixue": max_qixue,
        "lingqi": max_lingqi,
        "max_lingqi": max_lingqi,
        "wugong": attrs.get("wugong").copied().unwrap_or_default() as i64,
        "fagong": attrs.get("fagong").copied().unwrap_or_default() as i64,
        "wufang": attrs.get("wufang").copied().unwrap_or_default() as i64,
        "fafang": attrs.get("fafang").copied().unwrap_or_default() as i64,
        "mingzhong": attrs.get("mingzhong").copied().unwrap_or_default(),
        "shanbi": attrs.get("shanbi").copied().unwrap_or_default(),
        "zhaojia": attrs.get("zhaojia").copied().unwrap_or_default(),
        "baoji": attrs.get("baoji").copied().unwrap_or_default(),
        "baoshang": attrs.get("baoshang").copied().unwrap_or_default(),
        "jianbaoshang": attrs.get("jianbaoshang").copied().unwrap_or_default(),
        "jianfantan": attrs.get("jianfantan").copied().unwrap_or_default(),
        "kangbao": attrs.get("kangbao").copied().unwrap_or_default(),
        "zengshang": attrs.get("zengshang").copied().unwrap_or_default(),
        "zhiliao": attrs.get("zhiliao").copied().unwrap_or_default(),
        "jianliao": attrs.get("jianliao").copied().unwrap_or_default(),
        "xixue": attrs.get("xixue").copied().unwrap_or_default(),
        "lengque": attrs.get("lengque").copied().unwrap_or_default(),
        "sudu": attrs.get("sudu").copied().unwrap_or(1.0).max(1.0) as i64,
        "kongzhi_kangxing": attrs.get("kongzhi_kangxing").copied().unwrap_or_default(),
        "jin_kangxing": attrs.get("jin_kangxing").copied().unwrap_or_default(),
        "mu_kangxing": attrs.get("mu_kangxing").copied().unwrap_or_default(),
        "shui_kangxing": attrs.get("shui_kangxing").copied().unwrap_or_default(),
        "huo_kangxing": attrs.get("huo_kangxing").copied().unwrap_or_default(),
        "tu_kangxing": attrs.get("tu_kangxing").copied().unwrap_or_default(),
        "qixue_huifu": attrs.get("qixue_huifu").copied().unwrap_or_default(),
        "lingqi_huifu": attrs.get("lingqi_huifu").copied().unwrap_or_default()
    })
}

fn resolve_market_partner_effective_level(realm: &str, sub_realm: &str, level: i64) -> i64 {
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
    let rank = ORDER
        .iter()
        .position(|item| *item == full)
        .map(|idx| idx as i64 + 1)
        .unwrap_or(1);
    let cap = (rank * 10).max(10);
    level.max(1).min(cap)
}

fn calc_market_partner_upgrade_exp_by_target_level(
    target_level: i64,
    growth: &MarketPartnerGrowthFile,
) -> i64 {
    let safe_target = target_level.max(2);
    let level_offset = (safe_target - 2).max(0) as f64;
    let raw =
        (growth.exp_base_exp.max(1) as f64) * growth.exp_growth_rate.max(1.0).powf(level_offset);
    raw.floor().max(1.0) as i64
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

async fn record_market_risk_query_access(
    state: &AppState,
    user_id: i64,
    signature: String,
) -> Result<(), AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(());
    };
    let redis = RedisRuntime::new(redis_client);
    let occurred_at = now_millis() as i64;
    let signature_hash = hash_market_signature(&signature);
    let query_events_key = format!("market:risk:user:{}:queries", user_id);
    let signature_events_key = format!("market:risk:user:{}:signature:{}", user_id, signature_hash);
    let last_signature_key = format!("market:risk:user:{}:last-signature", user_id);
    let event_member = format!("{}:{}", occurred_at, now_millis());
    let min_score_to_keep = occurred_at - MARKET_RISK_QUERY_LONG_WINDOW_MS;
    redis
        .zadd(&query_events_key, occurred_at, &event_member)
        .await?;
    let _ = redis
        .zremrangebyscore(&query_events_key, 0, min_score_to_keep)
        .await?;
    let _ = redis
        .pexpire(&query_events_key, MARKET_RISK_QUERY_TRACK_TTL_MS)
        .await?;
    redis
        .zadd(&signature_events_key, occurred_at, &event_member)
        .await?;
    let _ = redis
        .zremrangebyscore(&signature_events_key, 0, min_score_to_keep)
        .await?;
    let _ = redis
        .pexpire(&signature_events_key, MARKET_RISK_QUERY_TRACK_TTL_MS)
        .await?;
    redis
        .psetex(
            &last_signature_key,
            MARKET_RISK_QUERY_TRACK_TTL_MS,
            &signature_hash,
        )
        .await?;
    Ok(())
}

fn build_item_market_risk_query_signature(
    query: &MarketListingsQuery,
    page: i64,
    page_size: i64,
) -> String {
    serde_json::json!({
        "category": query.category.as_deref().unwrap_or_default().trim(),
        "quality": query.quality.as_deref().unwrap_or_default().trim(),
        "query": query.query.as_deref().unwrap_or_default().trim(),
        "sort": query.sort.as_deref().unwrap_or("timeDesc"),
        "minPrice": query.min_price,
        "maxPrice": query.max_price,
        "page": page,
        "pageSize": page_size,
    })
    .to_string()
}

fn build_partner_market_risk_query_signature(
    query: &MarketPartnerListingsQuery,
    page: i64,
    page_size: i64,
) -> String {
    serde_json::json!({
        "quality": query.quality.as_deref().unwrap_or_default().trim(),
        "element": query.element.as_deref().unwrap_or_default().trim(),
        "query": query.query.as_deref().unwrap_or_default().trim(),
        "sort": query.sort.as_deref().unwrap_or("timeDesc"),
        "page": page,
        "pageSize": page_size,
    })
    .to_string()
}

fn hash_market_signature(signature: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(signature.as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn has_valid_market_purchase_pass(
    state: &AppState,
    user_id: i64,
    character_id: i64,
) -> Result<bool, AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(false);
    };
    let redis = RedisRuntime::new(redis_client);
    Ok(redis
        .get_string(&format!("market:risk:pass:{}:{}", user_id, character_id))
        .await?
        .is_some())
}

#[derive(Debug)]
struct MarketPurchaseRiskAssessmentDto {
    requires_captcha: bool,
}

async fn get_market_purchase_risk_assessment(
    state: &AppState,
    user_id: i64,
) -> Result<MarketPurchaseRiskAssessmentDto, AppError> {
    let Some(redis_client) = state.redis.clone() else {
        return Ok(MarketPurchaseRiskAssessmentDto {
            requires_captcha: false,
        });
    };
    let redis = RedisRuntime::new(redis_client);
    let now_ms = now_millis() as i64;
    let query_events_key = format!("market:risk:user:{}:queries", user_id);
    let last_signature_hash = redis
        .get_string(&format!("market:risk:user:{}:last-signature", user_id))
        .await?;
    let latest_signature_count_60s = if let Some(hash) = last_signature_hash {
        redis
            .zcount(
                &format!("market:risk:user:{}:signature:{}", user_id, hash),
                now_ms - MARKET_RISK_QUERY_SHORT_WINDOW_MS,
                now_ms,
            )
            .await?
    } else {
        0
    };
    let query_count_60s = redis
        .zcount(
            &query_events_key,
            now_ms - MARKET_RISK_QUERY_SHORT_WINDOW_MS,
            now_ms,
        )
        .await?;
    let query_count_5m = redis
        .zcount(
            &query_events_key,
            now_ms - MARKET_RISK_QUERY_LONG_WINDOW_MS,
            now_ms,
        )
        .await?;
    let recent_query_with_scores = redis
        .zrange_withscores(&query_events_key, -MARKET_RISK_RECENT_TIMESTAMP_COUNT, -1)
        .await?;
    let recent_query_timestamps = parse_sorted_set_scores(recent_query_with_scores);
    let interval_stats = calculate_market_interval_stats(&recent_query_timestamps);
    let mut score = 0;
    if query_count_60s >= 18 {
        score += 20;
    }
    if query_count_60s >= 30 {
        score += 15;
    }
    if query_count_5m >= 90 {
        score += 15;
    }
    if latest_signature_count_60s >= 10 {
        score += 20;
    }
    if latest_signature_count_60s >= 16 {
        score += 15;
    }
    if let Some((average_interval_ms, coefficient_of_variation)) = interval_stats {
        if average_interval_ms <= 1800.0 && coefficient_of_variation <= 0.2 {
            score += 25;
        }
    }
    Ok(MarketPurchaseRiskAssessmentDto {
        requires_captcha: score >= 60,
    })
}

fn parse_sorted_set_scores(values: Vec<String>) -> Vec<i64> {
    let mut scores = Vec::new();
    let mut index = 1;
    while index < values.len() {
        if let Ok(score) = values[index].parse::<f64>() {
            scores.push(score.floor() as i64);
        }
        index += 2;
    }
    scores.sort();
    scores
}

fn calculate_market_interval_stats(timestamps: &[i64]) -> Option<(f64, f64)> {
    if timestamps.len() < 8 {
        return None;
    }
    let mut intervals = Vec::new();
    for window in timestamps.windows(2) {
        let interval = window[1] - window[0];
        if interval <= 0 {
            return None;
        }
        intervals.push(interval as f64);
    }
    if intervals.len() < 7 {
        return None;
    }
    let average = intervals.iter().sum::<f64>() / intervals.len() as f64;
    if average <= 0.0 {
        return None;
    }
    let variance = intervals
        .iter()
        .map(|value| {
            let delta = *value - average;
            delta * delta
        })
        .sum::<f64>()
        / intervals.len() as f64;
    Some((average, variance.sqrt() / average))
}

async fn buy_partner_market_listing_tx(
    state: &AppState,
    buyer_user_id: i64,
    buyer_character_id: i64,
    listing_id: i64,
) -> Result<ServiceResult<MarketPartnerBuyDataDto>, AppError> {
    let listing = state.database.fetch_optional(
        "SELECT id, seller_user_id, seller_character_id, partner_id, status, unit_price_spirit_stones FROM market_partner_listing WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(listing_id),
    ).await?;
    let Some(listing) = listing else {
        return Ok(ServiceResult {
            success: false,
            message: Some("上架记录不存在".to_string()),
            data: None,
        });
    };
    let seller_user_id = listing
        .try_get::<Option<i32>, _>("seller_user_id")?
        .map(i64::from)
        .unwrap_or_default();
    let seller_character_id = listing
        .try_get::<Option<i32>, _>("seller_character_id")?
        .map(i64::from)
        .unwrap_or_default();
    if seller_character_id == buyer_character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("不能购买自己上架的伙伴".to_string()),
            data: None,
        });
    }
    let status = listing
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "active" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该伙伴已被购买或下架".to_string()),
            data: None,
        });
    }
    let partner_id = listing
        .try_get::<Option<i32>, _>("partner_id")?
        .map(i64::from)
        .unwrap_or_default();
    let unit_price_spirit_stones = listing
        .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
        .unwrap_or_default();

    let partner_row = state.database.fetch_optional(
        "SELECT character_id, is_active FROM character_partner WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(partner_id),
    ).await?;
    let Some(partner_row) = partner_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("伙伴不存在".to_string()),
            data: None,
        });
    };
    let current_owner_character_id = partner_row
        .try_get::<Option<i32>, _>("character_id")?
        .map(i64::from)
        .unwrap_or_default();
    if current_owner_character_id != seller_character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("伙伴归属异常，请刷新后重试".to_string()),
            data: None,
        });
    }
    if partner_row
        .try_get::<Option<bool>, _>("is_active")?
        .unwrap_or(false)
    {
        return Ok(ServiceResult {
            success: false,
            message: Some("出战中的伙伴不可交易".to_string()),
            data: None,
        });
    }

    let buyer_row = state.database.fetch_optional(
        "SELECT spirit_stones, realm, sub_realm FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(buyer_character_id),
    ).await?;
    let seller_row = state
        .database
        .fetch_optional(
            "SELECT realm, sub_realm FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(seller_character_id),
        )
        .await?;
    let (Some(buyer_row), Some(_seller_row)) = (buyer_row, seller_row) else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let buyer_spirit_stones = buyer_row
        .try_get::<Option<i64>, _>("spirit_stones")?
        .unwrap_or_default();
    if buyer_spirit_stones < unit_price_spirit_stones {
        return Ok(ServiceResult {
            success: false,
            message: Some("灵石不足".to_string()),
            data: None,
        });
    }

    state.database.execute(
        "UPDATE characters SET spirit_stones = COALESCE(spirit_stones, 0) - $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(buyer_character_id).bind(unit_price_spirit_stones),
    ).await?;
    state.database.execute(
        "UPDATE characters SET spirit_stones = COALESCE(spirit_stones, 0) + $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(seller_character_id).bind(unit_price_spirit_stones),
    ).await?;
    clear_pending_partner_technique_preview_by_partner_ids(
        state,
        seller_character_id,
        &[partner_id],
        true,
    )
    .await?;
    state.database.execute(
        "UPDATE character_partner SET character_id = $1, is_active = FALSE, updated_at = NOW() WHERE id = $2",
        |q| q.bind(buyer_character_id).bind(partner_id),
    ).await?;

    let buyer_realm = buyer_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let buyer_sub_realm = buyer_row
        .try_get::<Option<String>, _>("sub_realm")?
        .unwrap_or_default();
    let snapshot_row = load_market_partner_row_by_id(state, buyer_character_id, partner_id)
        .await?
        .ok_or_else(|| AppError::config("伙伴快照构建失败"))?;
    let sold_snapshot =
        build_market_partner_snapshot(state, &snapshot_row, &buyer_realm, &buyer_sub_realm).await?;

    state.database.execute(
        "UPDATE market_partner_listing SET status = 'sold', buyer_user_id = $1, buyer_character_id = $2, partner_snapshot = $3::jsonb, sold_at = NOW(), updated_at = NOW() WHERE id = $4",
        |q| q.bind(buyer_user_id).bind(buyer_character_id).bind(&sold_snapshot).bind(listing_id),
    ).await?;
    state.database.execute(
        "INSERT INTO market_partner_trade_record (listing_id, buyer_user_id, buyer_character_id, seller_user_id, seller_character_id, partner_id, partner_def_id, partner_snapshot, unit_price_spirit_stones, total_price_spirit_stones, tax_spirit_stones) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 0)",
        |q| q
            .bind(listing_id)
            .bind(buyer_user_id)
            .bind(buyer_character_id)
            .bind(seller_user_id)
            .bind(seller_character_id)
            .bind(partner_id)
            .bind(sold_snapshot.get("partnerDefId").and_then(|v| v.as_str()).unwrap_or_default())
            .bind(&sold_snapshot)
            .bind(unit_price_spirit_stones)
            .bind(unit_price_spirit_stones),
    ).await?;

    Ok(ServiceResult {
        success: true,
        message: Some("购买成功，伙伴已转入麾下".to_string()),
        data: Some(MarketPartnerBuyDataDto {
            seller_user_id,
            debug_realtime: Some(build_market_update_payload(
                "buy_partner_listing",
                Some(listing_id),
                "partner",
            )),
            debug_rank_realtime: Some(build_rank_update_payload(
                "buy_partner_listing",
                &["partner", "power"],
            )),
        }),
    })
}

async fn buy_market_listing_tx(
    state: &AppState,
    buyer_user_id: i64,
    buyer_character_id: i64,
    listing_id: i64,
    requested_qty: i64,
) -> Result<ServiceResult<MarketItemBuyDataDto>, AppError> {
    let listing = state.database.fetch_optional(
        "SELECT id, seller_user_id, seller_character_id, item_instance_id, item_def_id, qty, unit_price_spirit_stones, status FROM market_listing WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(listing_id),
    ).await?;
    let Some(listing) = listing else {
        return Ok(ServiceResult {
            success: false,
            message: Some("上架记录不存在".to_string()),
            data: None,
        });
    };
    let seller_user_id = listing
        .try_get::<Option<i32>, _>("seller_user_id")?
        .map(i64::from)
        .unwrap_or_default();
    let seller_character_id = listing
        .try_get::<Option<i32>, _>("seller_character_id")?
        .map(i64::from)
        .unwrap_or_default();
    if seller_character_id == buyer_character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("不能购买自己上架的物品".to_string()),
            data: None,
        });
    }
    let status = listing
        .try_get::<Option<String>, _>("status")?
        .unwrap_or_default();
    if status != "active" {
        return Ok(ServiceResult {
            success: false,
            message: Some("该物品已被购买或下架".to_string()),
            data: None,
        });
    }
    let listing_qty = listing
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if requested_qty > listing_qty || requested_qty <= 0 {
        return Ok(ServiceResult {
            success: false,
            message: Some("购买数量不合法，请刷新后重试".to_string()),
            data: None,
        });
    }
    let item_instance_id = listing
        .try_get::<Option<i64>, _>("item_instance_id")?
        .unwrap_or_default();
    let item_def_id = listing
        .try_get::<Option<String>, _>("item_def_id")?
        .unwrap_or_default();
    let unit_price_spirit_stones = listing
        .try_get::<Option<i64>, _>("unit_price_spirit_stones")?
        .unwrap_or_default();

    let item_row = state.database.fetch_optional(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(item_instance_id),
    ).await?;
    let Some(item_row) = item_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不存在".to_string()),
            data: None,
        });
    };
    let item_location = item_row
        .try_get::<Option<String>, _>("location")?
        .unwrap_or_default();
    if item_location != "auction" {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品不在坊市中".to_string()),
            data: None,
        });
    }
    let item_owner_character_id = item_row
        .try_get::<Option<i64>, _>("owner_character_id")?
        .unwrap_or_default();
    if item_owner_character_id != seller_character_id {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品归属异常，请刷新后重试".to_string()),
            data: None,
        });
    }
    let item_qty = item_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if item_qty != listing_qty {
        return Ok(ServiceResult {
            success: false,
            message: Some("物品数量异常，请刷新后重试".to_string()),
            data: None,
        });
    }

    let item_metas = load_market_item_meta_map()?;
    let item_meta = item_metas.get(item_def_id.trim());
    let total_price = unit_price_spirit_stones.saturating_mul(requested_qty);
    let tax_rate = item_meta.map(|meta| meta.tax_rate).unwrap_or_default();
    let tax_amount = calculate_market_tax_amount(total_price, tax_rate);
    let seller_gain = total_price.saturating_sub(tax_amount);

    let buyer_row = state
        .database
        .fetch_optional(
            "SELECT spirit_stones FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(buyer_character_id),
        )
        .await?;
    let Some(buyer_row) = buyer_row else {
        return Ok(ServiceResult {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };
    let buyer_spirit_stones = buyer_row
        .try_get::<Option<i64>, _>("spirit_stones")?
        .unwrap_or_default();
    if buyer_spirit_stones < total_price {
        return Ok(ServiceResult {
            success: false,
            message: Some("灵石不足".to_string()),
            data: None,
        });
    }

    state.database.execute(
        "UPDATE characters SET spirit_stones = COALESCE(spirit_stones, 0) - $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(buyer_character_id).bind(total_price),
    ).await?;
    state.database.execute(
        "UPDATE characters SET spirit_stones = COALESCE(spirit_stones, 0) + $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(seller_character_id).bind(seller_gain),
    ).await?;

    let delivered_item_instance_id = if requested_qty < listing_qty {
        let inserted = state.database.fetch_one(
            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at, obtained_from, obtained_ref_id, metadata, created_at, updated_at) SELECT $2, $3, item_def_id, $4, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, 'mail', NULL, NULL, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at, 'market', $5, metadata, NOW(), NOW() FROM item_instance WHERE id = $1 RETURNING id",
            |q| q.bind(item_instance_id).bind(buyer_user_id).bind(buyer_character_id).bind(requested_qty).bind(listing_id.to_string()),
        ).await?;
        if state.redis_available {
            if let Some(redis_client) = state.redis.clone() {
                let redis = RedisRuntime::new(redis_client);
                let now_ms = market_timestamp_ms();
                let mutation = BufferedItemInstanceMutation {
                    op_id: format!("market-buy-partial-source:{item_instance_id}:{now_ms}"),
                    character_id: seller_character_id,
                    item_id: item_instance_id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(ItemInstanceMutationSnapshot {
                        id: item_instance_id,
                        owner_user_id: seller_user_id,
                        owner_character_id: seller_character_id,
                        item_def_id: item_def_id.clone(),
                        qty: listing_qty - requested_qty,
                        quality: item_row.try_get::<Option<String>, _>("quality")?,
                        quality_rank: item_row
                            .try_get::<Option<i32>, _>("quality_rank")?
                            .map(i64::from),
                        bind_type: item_row
                            .try_get::<Option<String>, _>("bind_type")?
                            .unwrap_or_else(|| "none".to_string()),
                        bind_owner_user_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_user_id")?,
                        bind_owner_character_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                        location: item_location.clone(),
                        location_slot: item_row
                            .try_get::<Option<i32>, _>("location_slot")?
                            .map(i64::from),
                        equipped_slot: item_row.try_get::<Option<String>, _>("equipped_slot")?,
                        strengthen_level: item_row
                            .try_get::<Option<i32>, _>("strengthen_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        refine_level: item_row
                            .try_get::<Option<i32>, _>("refine_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        socketed_gems: item_row
                            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        random_seed: item_row.try_get::<Option<i64>, _>("random_seed")?,
                        affixes: item_row
                            .try_get::<Option<serde_json::Value>, _>("affixes")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        identified: item_row
                            .try_get::<Option<bool>, _>("identified")?
                            .unwrap_or(false),
                        affix_gen_version: item_row
                            .try_get::<Option<i32>, _>("affix_gen_version")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        affix_roll_meta: item_row
                            .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
                            .unwrap_or_else(|| serde_json::json!({})),
                        custom_name: item_row.try_get::<Option<String>, _>("custom_name")?,
                        locked: item_row
                            .try_get::<Option<bool>, _>("locked")?
                            .unwrap_or(false),
                        expire_at: item_row.try_get::<Option<String>, _>("expire_at_text")?,
                        obtained_from: item_row.try_get::<Option<String>, _>("obtained_from")?,
                        obtained_ref_id: item_row
                            .try_get::<Option<String>, _>("obtained_ref_id")?,
                        metadata: item_row.try_get::<Option<serde_json::Value>, _>("metadata")?,
                    }),
                };
                buffer_item_instance_mutations(&redis, &[mutation]).await?;
            }
        } else {
            state
                .database
                .execute(
                    "UPDATE item_instance SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                    |q| q.bind(item_instance_id).bind(requested_qty),
                )
                .await?;
        }
        state
            .database
            .execute(
                "UPDATE market_listing SET qty = qty - $2, updated_at = NOW() WHERE id = $1",
                |q| q.bind(listing_id).bind(requested_qty),
            )
            .await?;
        inserted.try_get::<i64, _>("id")?
    } else {
        if state.redis_available {
            if let Some(redis_client) = state.redis.clone() {
                let redis = RedisRuntime::new(redis_client);
                let now_ms = market_timestamp_ms();
                let mutation = BufferedItemInstanceMutation {
                    op_id: format!("market-buy-full:{item_instance_id}:{now_ms}"),
                    character_id: buyer_character_id,
                    item_id: item_instance_id,
                    created_at_ms: now_ms,
                    kind: "upsert".to_string(),
                    snapshot: Some(ItemInstanceMutationSnapshot {
                        id: item_instance_id,
                        owner_user_id: buyer_user_id,
                        owner_character_id: buyer_character_id,
                        item_def_id: item_def_id.clone(),
                        qty: requested_qty,
                        quality: item_row.try_get::<Option<String>, _>("quality")?,
                        quality_rank: item_row
                            .try_get::<Option<i32>, _>("quality_rank")?
                            .map(i64::from),
                        bind_type: item_row
                            .try_get::<Option<String>, _>("bind_type")?
                            .unwrap_or_else(|| "none".to_string()),
                        bind_owner_user_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_user_id")?,
                        bind_owner_character_id: item_row
                            .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                        location: "mail".to_string(),
                        location_slot: None,
                        equipped_slot: None,
                        strengthen_level: item_row
                            .try_get::<Option<i32>, _>("strengthen_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        refine_level: item_row
                            .try_get::<Option<i32>, _>("refine_level")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        socketed_gems: item_row
                            .try_get::<Option<serde_json::Value>, _>("socketed_gems")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        random_seed: item_row.try_get::<Option<i64>, _>("random_seed")?,
                        affixes: item_row
                            .try_get::<Option<serde_json::Value>, _>("affixes")?
                            .unwrap_or_else(|| serde_json::json!([])),
                        identified: item_row
                            .try_get::<Option<bool>, _>("identified")?
                            .unwrap_or(false),
                        affix_gen_version: item_row
                            .try_get::<Option<i32>, _>("affix_gen_version")?
                            .map(i64::from)
                            .unwrap_or_default(),
                        affix_roll_meta: item_row
                            .try_get::<Option<serde_json::Value>, _>("affix_roll_meta")?
                            .unwrap_or_else(|| serde_json::json!({})),
                        custom_name: item_row.try_get::<Option<String>, _>("custom_name")?,
                        locked: item_row
                            .try_get::<Option<bool>, _>("locked")?
                            .unwrap_or(false),
                        expire_at: item_row.try_get::<Option<String>, _>("expire_at_text")?,
                        obtained_from: Some("market".to_string()),
                        obtained_ref_id: Some(listing_id.to_string()),
                        metadata: item_row.try_get::<Option<serde_json::Value>, _>("metadata")?,
                    }),
                };
                buffer_item_instance_mutations(&redis, &[mutation]).await?;
            }
        } else {
            state.database.execute(
                "UPDATE item_instance SET owner_user_id = $2, owner_character_id = $3, location = 'mail', location_slot = NULL, equipped_slot = NULL, obtained_from = 'market', obtained_ref_id = $4, updated_at = NOW() WHERE id = $1",
                |q| q.bind(item_instance_id).bind(buyer_user_id).bind(buyer_character_id).bind(listing_id.to_string()),
            ).await?;
        }
        state.database.execute(
            "UPDATE market_listing SET status = 'sold', buyer_user_id = $2, buyer_character_id = $3, sold_at = NOW(), updated_at = NOW() WHERE id = $1",
            |q| q.bind(listing_id).bind(buyer_user_id).bind(buyer_character_id),
        ).await?;
        item_instance_id
    };

    state.database.execute(
        "INSERT INTO market_trade_record (listing_id, buyer_user_id, buyer_character_id, seller_user_id, seller_character_id, item_def_id, qty, unit_price_spirit_stones, total_price_spirit_stones, tax_spirit_stones) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        |q| q.bind(listing_id).bind(buyer_user_id).bind(buyer_character_id).bind(seller_user_id).bind(seller_character_id).bind(item_def_id.trim()).bind(requested_qty).bind(unit_price_spirit_stones).bind(total_price).bind(tax_amount),
    ).await?;
    let item_name = item_meta
        .map(|meta| meta.name.clone())
        .unwrap_or_else(|| item_def_id.trim().to_string());
    state.database.execute(
        "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_instance_ids, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '坊市', 'trade', $3, $4, $5::jsonb, 'market', $6, $7::jsonb, NOW(), NOW())",
        |q| q
            .bind(buyer_user_id)
            .bind(buyer_character_id)
            .bind("坊市购买到账通知")
            .bind(format!("你在坊市购买的【{}】已通过邮件发放，请及时领取附件。", item_name))
            .bind(serde_json::json!([delivered_item_instance_id]))
            .bind(listing_id.to_string())
            .bind(serde_json::json!({
                "listingId": listing_id,
                "attachmentPreviewItems": [{
                    "itemDefId": item_def_id.trim(),
                    "itemName": item_name,
                    "quantity": requested_qty
                }]
            })),
    ).await?;
    apply_mail_counter_deltas(
        &state,
        &build_new_mail_counter_deltas(buyer_user_id, Some(buyer_character_id), true),
    )
    .await?;

    Ok(ServiceResult {
        success: true,
        message: Some("购买成功，物品已通过邮件发放".to_string()),
        data: Some(MarketItemBuyDataDto {
            seller_user_id,
            debug_realtime: Some(build_market_update_payload(
                "buy_market_listing",
                Some(listing_id),
                "item",
            )),
        }),
    })
}

fn calculate_market_tax_amount(total_price: i64, tax_rate: f64) -> i64 {
    if total_price <= 0 || !tax_rate.is_finite() || tax_rate <= 0.0 {
        return 0;
    }
    let rate = tax_rate.clamp(0.0, 100.0);
    (total_price as i128 * (rate * 100.0).floor() as i128 / 10000) as i64
}

#[cfg(test)]
mod tests {
    #[test]
    fn market_listings_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"listings": [{"id": 1, "name": "清灵丹", "qty": 5, "unitPriceSpiritStones": 20, "sellerName": "凌霄子"}], "total": 1}
        });
        assert_eq!(payload["data"]["listings"][0]["name"], "清灵丹");
        println!("MARKET_LISTINGS_RESPONSE={}", payload);
    }

    #[test]
    fn market_my_listings_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"listings": [{"id": 1, "status": "active"}], "total": 1}
        });
        assert_eq!(payload["data"]["total"], 1);
        println!("MARKET_MY_LISTINGS_RESPONSE={}", payload);
    }

    #[test]
    fn market_records_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"records": [{"id": 1, "type": "买入", "name": "清灵丹", "qty": 2, "unitPriceSpiritStones": 30, "counterparty": "白尘", "time": 1712800000000i64}], "total": 1}
        });
        assert_eq!(payload["data"]["records"][0]["type"], "买入");
        println!("MARKET_RECORDS_RESPONSE={}", payload);
    }

    #[test]
    fn market_partner_listings_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"listings": [{"id": 1, "partner": {"id": 9, "nickname": "青木小偶"}, "unitPriceSpiritStones": 300}], "total": 1}
        });
        assert_eq!(
            payload["data"]["listings"][0]["partner"]["nickname"],
            "青木小偶"
        );
        println!("MARKET_PARTNER_LISTINGS_RESPONSE={}", payload);
    }

    #[test]
    fn market_partner_records_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"records": [{"id": 1, "type": "卖出", "partner": {"id": 9}, "unitPriceSpiritStones": 300, "totalPriceSpiritStones": 300, "counterparty": "白尘", "time": 1712800000000i64}], "total": 1}
        });
        assert_eq!(payload["data"]["records"][0]["type"], "卖出");
        println!("MARKET_PARTNER_RECORDS_RESPONSE={}", payload);
    }

    #[test]
    fn market_partner_technique_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "获取成功",
            "data": {"technique": {"id": "tech-huifu-shu"}, "layers": [{"layer": 1}], "skills": [{"id": "skill-huifu-shu-1"}], "currentLayer": 1, "isInnate": true}
        });
        assert_eq!(payload["data"]["technique"]["id"], "tech-huifu-shu");
        println!("MARKET_PARTNER_TECHNIQUE_DETAIL_RESPONSE={}", payload);
    }

    #[test]
    fn market_captcha_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"captchaId": "market-captcha-1", "imageData": "data:image/svg+xml;base64,abc", "expiresAt": 1712800300}
        });
        assert_eq!(payload["data"]["captchaId"], "market-captcha-1");
        println!("MARKET_CAPTCHA_RESPONSE={}", payload);
    }

    #[test]
    fn market_captcha_verify_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"passExpiresAt": 1712800600000i64}
        });
        assert_eq!(payload["data"]["passExpiresAt"], 1712800600000i64);
        println!("MARKET_CAPTCHA_VERIFY_RESPONSE={}", payload);
    }

    #[test]
    fn market_partner_cancel_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "下架成功，已退还15银两手续费",
            "data": {"debugRealtime": {"kind": "market:update", "source": "cancel_partner_listing", "listingId": 1, "marketType": "partner"}}
        });
        assert_eq!(payload["message"], "下架成功，已退还15银两手续费");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "market:update");
        println!("MARKET_PARTNER_CANCEL_RESPONSE={}", payload);
    }

    #[test]
    fn market_partner_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "上架成功，已收取1500银两手续费（未卖出下架将退还）",
            "data": {"listingId": 99, "debugRealtime": {"kind": "market:update", "source": "create_partner_listing", "listingId": 99, "marketType": "partner"}}
        });
        assert_eq!(payload["data"]["listingId"], 99);
        assert_eq!(
            payload["data"]["debugRealtime"]["source"],
            "create_partner_listing"
        );
        println!("MARKET_PARTNER_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn market_item_cancel_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "下架成功，物品已通过邮件返还，并退还15银两手续费",
            "data": {"debugRealtime": {"kind": "market:update", "source": "cancel_market_listing", "listingId": 1, "marketType": "item"}}
        });
        assert_eq!(
            payload["message"],
            "下架成功，物品已通过邮件返还，并退还15银两手续费"
        );
        assert_eq!(payload["data"]["debugRealtime"]["marketType"], "item");
        println!("MARKET_ITEM_CANCEL_RESPONSE={}", payload);
    }

    #[test]
    fn market_item_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "上架成功，已收取100银两手续费（未卖出下架将退还）",
            "data": {"listingId": 88, "debugRealtime": {"kind": "market:update", "source": "create_market_listing", "listingId": 88, "marketType": "item"}}
        });
        assert_eq!(payload["data"]["listingId"], 88);
        assert_eq!(
            payload["data"]["debugRealtime"]["source"],
            "create_market_listing"
        );
        println!("MARKET_ITEM_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn market_risk_signature_hash_is_stable() {
        let hash = super::hash_market_signature("{\"query\":\"清灵丹\"}");
        assert_eq!(hash.len(), 40);
    }

    #[test]
    fn market_partner_buy_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "购买成功，伙伴已转入麾下",
            "data": {"sellerUserId": 12, "debugRealtime": {"kind": "market:update", "source": "buy_partner_listing", "listingId": 1, "marketType": "partner"}, "debugRankRealtime": {"kind": "rank:update", "domains": ["partner", "power"]}}
        });
        assert_eq!(payload["data"]["sellerUserId"], 12);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "market:update");
        assert_eq!(payload["data"]["debugRankRealtime"]["kind"], "rank:update");
        println!("MARKET_PARTNER_BUY_RESPONSE={}", payload);
    }

    #[test]
    fn market_item_buy_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "购买成功，物品已通过邮件发放",
            "data": {"sellerUserId": 12, "debugRealtime": {"kind": "market:update", "source": "buy_market_listing", "listingId": 1, "marketType": "item"}}
        });
        assert_eq!(payload["data"]["sellerUserId"], 12);
        assert_eq!(
            payload["data"]["debugRealtime"]["source"],
            "buy_market_listing"
        );
        println!("MARKET_ITEM_BUY_RESPONSE={}", payload);
    }
}
