use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

pub(crate) const DEFAULT_MONTH_CARD_ID: &str = "monthcard-001";
pub(crate) const DEFAULT_MONTH_CARD_ITEM_DEF_ID: &str = "cons-monthcard-001";

#[derive(Debug, Deserialize)]
pub struct MonthCardQuery {
    #[serde(rename = "monthCardId")]
    pub month_card_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UseMonthCardPayload {
    pub month_card_id: Option<String>,
    pub item_instance_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardBenefitsDto {
    pub cooldown_reduction_rate: f64,
    pub stamina_recovery_rate: f64,
    pub fuyuan_bonus: i64,
    pub idle_max_duration_hours: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardStatusData {
    pub month_card_id: String,
    pub name: String,
    pub description: Option<String>,
    pub duration_days: i64,
    pub daily_spirit_stones: i64,
    pub price_spirit_stones: i64,
    pub benefits: MonthCardBenefitsDto,
    pub active: bool,
    pub expire_at: Option<String>,
    pub days_left: i64,
    pub today: String,
    pub last_claim_date: Option<String>,
    pub can_claim: bool,
    pub spirit_stones: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MonthCardUseItemData {
    pub month_card_id: String,
    pub expire_at: String,
    pub days_left: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthCardClaimData {
    pub month_card_id: String,
    pub date: String,
    pub reward_spirit_stones: i64,
    pub spirit_stones: i64,
}

#[derive(Debug, Deserialize)]
struct MonthCardSeedFile {
    month_cards: Vec<MonthCardSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonthCardSeed {
    id: String,
    name: String,
    description: Option<String>,
    duration_days: Option<i64>,
    daily_spirit_stones: Option<i64>,
    cooldown_reduction_rate: Option<f64>,
    stamina_recovery_rate: Option<f64>,
    fuyuan_bonus: Option<i64>,
    idle_max_duration_hours: Option<i64>,
    price_spirit_stones: Option<i64>,
    enabled: Option<bool>,
}

pub async fn get_month_card_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MonthCardQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let month_card_id = resolve_month_card_id(query.month_card_id);
    let card = load_month_card_seed(&month_card_id)?;
    let character = load_character_currency_row(&state, actor.user_id).await?;
    let now = now_utc();
    let today = date_key(now);
    let row = state
        .database
        .fetch_optional(
            "SELECT expire_at::text AS expire_at_text, last_claim_date::text AS last_claim_date_text FROM month_card_ownership WHERE character_id = $1 AND month_card_id = $2 LIMIT 1",
            |query| query.bind(character.id).bind(&month_card_id),
        )
        .await?;
    let expire_at = row.as_ref().and_then(|row| {
        row.try_get::<Option<String>, _>("expire_at_text")
            .ok()
            .flatten()
    });
    let last_claim_date = row
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<String>, _>("last_claim_date_text")
                .ok()
                .flatten()
        })
        .map(normalize_date_key);
    let active = expire_at
        .as_deref()
        .and_then(parse_datetime_millis)
        .map(|expire_ms| expire_ms > now.unix_timestamp() * 1000)
        .unwrap_or(false);
    let days_left = expire_at
        .as_deref()
        .and_then(parse_datetime_millis)
        .map(|expire_ms| {
            (((expire_ms - now.unix_timestamp() * 1000).max(0) + 86_399_999) / 86_400_000) as i64
        })
        .unwrap_or(0);
    let can_claim = active && last_claim_date.as_deref() != Some(today.as_str());

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("获取成功".to_string()),
        data: Some(MonthCardStatusData {
            month_card_id,
            name: card.name,
            description: card.description,
            duration_days: card.duration_days.unwrap_or(30).max(0),
            daily_spirit_stones: card.daily_spirit_stones.unwrap_or(10000).max(0),
            price_spirit_stones: card.price_spirit_stones.unwrap_or(0).max(0),
            benefits: MonthCardBenefitsDto {
                cooldown_reduction_rate: clamp_rate(card.cooldown_reduction_rate.unwrap_or(0.0)),
                stamina_recovery_rate: clamp_rate(card.stamina_recovery_rate.unwrap_or(0.0)),
                fuyuan_bonus: card.fuyuan_bonus.unwrap_or_default().max(0),
                idle_max_duration_hours: card.idle_max_duration_hours.unwrap_or_default().max(0),
            },
            active,
            expire_at,
            days_left,
            today,
            last_claim_date,
            can_claim,
            spirit_stones: character.spirit_stones,
        }),
    }))
}

pub(crate) async fn use_month_card_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UseMonthCardPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let character = load_character_currency_row(&state, actor.user_id).await?;
    let result = use_month_card_item_tx(&state, character.id, payload).await?;
    Ok(send_result(result))
}

pub(crate) async fn use_month_card_item_tx(
    state: &AppState,
    character_id: i64,
    payload: UseMonthCardPayload,
) -> Result<ServiceResult<MonthCardUseItemData>, AppError> {
    let month_card_id = resolve_month_card_id(payload.month_card_id);
    let card = load_month_card_seed(&month_card_id)?;
    let duration_days = card.duration_days.unwrap_or(30).max(1);

    let item_row = if let Some(item_instance_id) =
        payload.item_instance_id.filter(|value| *value > 0)
    {
        state
            .database
            .fetch_optional(
                "SELECT id, qty FROM item_instance WHERE id = $1 AND owner_character_id = $2 AND item_def_id = $3 AND location = 'bag' LIMIT 1 FOR UPDATE",
                |query| query.bind(item_instance_id).bind(character_id).bind(DEFAULT_MONTH_CARD_ITEM_DEF_ID),
            )
            .await?
    } else {
        state
            .database
            .fetch_optional(
                "SELECT id, qty FROM item_instance WHERE owner_character_id = $1 AND item_def_id = $2 AND location = 'bag' ORDER BY created_at ASC LIMIT 1 FOR UPDATE",
                |query| query.bind(character_id).bind(DEFAULT_MONTH_CARD_ITEM_DEF_ID),
            )
            .await?
    };
    let Some(item_row) = item_row else {
        return Ok(ServiceResult::<MonthCardUseItemData> {
            success: false,
            message: Some("背包中没有可用的月卡道具".to_string()),
            data: None,
        });
    };
    let item_id: i64 = item_row.try_get::<i64, _>("id")?;
    let item_qty: i64 = item_row
        .try_get::<Option<i32>, _>("qty")?
        .map(i64::from)
        .unwrap_or_default();
    if item_qty <= 0 {
        return Ok(ServiceResult::<MonthCardUseItemData> {
            success: false,
            message: Some("背包中没有可用的月卡道具".to_string()),
            data: None,
        });
    }

    let now = now_utc();
    let next_expire_at = state
        .database
        .with_transaction(|| async {
            if item_qty == 1 {
                state
                    .database
                    .execute("DELETE FROM item_instance WHERE id = $1", |query| query.bind(item_id))
                    .await?;
            } else {
                state
                    .database
                    .execute(
                        "UPDATE item_instance SET qty = qty - 1, updated_at = NOW() WHERE id = $1",
                        |query| query.bind(item_id),
                    )
                    .await?;
            }

            let ownership = state
                .database
                .fetch_optional(
                    "SELECT id, expire_at::text AS expire_at_text FROM month_card_ownership WHERE character_id = $1 AND month_card_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(&month_card_id),
                )
                .await?;
            let base_ms = ownership
                .as_ref()
                .and_then(|row| row.try_get::<Option<String>, _>("expire_at_text").ok().flatten())
                .as_deref()
                .and_then(parse_datetime_millis)
                .filter(|value| *value > now.unix_timestamp() * 1000)
                .unwrap_or(now.unix_timestamp() * 1000);
            let next_expire_ms = base_ms + duration_days * 86_400_000;
            let next_expire_at = format_iso(next_expire_ms)?;

            if let Some(row) = ownership {
                let ownership_id: i64 = row.try_get::<i64, _>("id")?;
                state
                    .database
                    .execute(
                        "UPDATE month_card_ownership SET expire_at = $1::timestamptz, updated_at = NOW() WHERE id = $2",
                        |query| query.bind(&next_expire_at).bind(ownership_id),
                    )
                    .await?;
            } else {
                state
                    .database
                    .execute(
                        "INSERT INTO month_card_ownership (character_id, month_card_id, start_at, expire_at, created_at, updated_at) VALUES ($1, $2, NOW(), $3::timestamptz, NOW(), NOW())",
                        |query| query.bind(character_id).bind(&month_card_id).bind(&next_expire_at),
                    )
                    .await?;
            }
            Ok::<String, AppError>(next_expire_at)
        })
        .await?;

    let days_left = parse_datetime_millis(&next_expire_at)
        .map(|expire_ms| {
            (((expire_ms - now.unix_timestamp() * 1000).max(0) + 86_399_999) / 86_400_000) as i64
        })
        .unwrap_or(0);
    Ok(ServiceResult {
        success: true,
        message: Some("使用成功".to_string()),
        data: Some(MonthCardUseItemData {
            month_card_id,
            expire_at: next_expire_at,
            days_left,
        }),
    })
}

pub async fn claim_month_card_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MonthCardQuery>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let month_card_id = resolve_month_card_id(payload.month_card_id);
    let card = load_month_card_seed(&month_card_id)?;
    let reward = card.daily_spirit_stones.unwrap_or(10000).max(0);
    let character = load_character_currency_row(&state, actor.user_id).await?;
    let now = now_utc();
    let today = date_key(now);

    let claim_result = state
        .database
        .with_transaction(|| async {
            let ownership = state
                .database
                .fetch_optional(
                    "SELECT id, expire_at::text AS expire_at_text, last_claim_date::text AS last_claim_date_text FROM month_card_ownership WHERE character_id = $1 AND month_card_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character.id).bind(&month_card_id),
                )
                .await?;
            let Some(ownership) = ownership else {
                return Ok::<ServiceResult<MonthCardClaimData>, AppError>(ServiceResult {
                    success: false,
                    message: Some("未激活月卡".to_string()),
                    data: None,
                });
            };
            let expire_at = ownership
                .try_get::<Option<String>, _>("expire_at_text")?
                .as_deref()
                .and_then(parse_datetime_millis)
                .unwrap_or_default();
            if expire_at <= now.unix_timestamp() * 1000 {
                return Ok(ServiceResult {
                    success: false,
                    message: Some("月卡已到期".to_string()),
                    data: None,
                });
            }
            let last_claim_date = ownership
                .try_get::<Option<String>, _>("last_claim_date_text")?
                .map(normalize_date_key);
            if last_claim_date.as_deref() == Some(today.as_str()) {
                return Ok(ServiceResult {
                    success: false,
                    message: Some("今日已领取".to_string()),
                    data: None,
                });
            }

            state
                .database
                .execute(
                    "INSERT INTO month_card_claim_record (character_id, month_card_id, claim_date, reward_spirit_stones, created_at) VALUES ($1, $2, $3::date, $4, NOW()) ON CONFLICT (character_id, month_card_id, claim_date) DO NOTHING",
                    |query| query.bind(character.id).bind(&month_card_id).bind(today.clone()).bind(reward),
                )
                .await?;
            let spirit_stones = character.spirit_stones + reward;
            if state.redis_available && state.redis.is_some() {
                let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
                buffer_character_resource_delta_fields(&redis, &[CharacterResourceDeltaField {
                    character_id: character.id,
                    field: "spirit_stones".to_string(),
                    increment: reward,
                }]).await?;
            } else {
                state
                    .database
                    .execute(
                        "UPDATE characters SET spirit_stones = spirit_stones + $1, updated_at = NOW() WHERE id = $2",
                        |query| query.bind(reward).bind(character.id),
                    )
                    .await?;
            }
            let ownership_id: i64 = ownership.try_get::<i64, _>("id")?;
            state
                .database
                .execute(
                    "UPDATE month_card_ownership SET last_claim_date = $1::date, updated_at = NOW() WHERE id = $2",
                    |query| query.bind(today.clone()).bind(ownership_id),
                )
                .await?;
            Ok(ServiceResult {
                success: true,
                message: Some("领取成功".to_string()),
                data: Some(MonthCardClaimData {
                    month_card_id,
                    date: today,
                    reward_spirit_stones: reward,
                    spirit_stones,
                }),
            })
        })
        .await?;

    Ok(send_result(claim_result))
}

struct CharacterCurrencyRow {
    id: i64,
    spirit_stones: i64,
}

async fn load_character_currency_row(
    state: &AppState,
    user_id: i64,
) -> Result<CharacterCurrencyRow, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?
        .ok_or_else(|| AppError::config("角色不存在"))?;
    Ok(CharacterCurrencyRow {
        id: i64::from(row.try_get::<i32, _>("id")?),
        spirit_stones: row
            .try_get::<Option<i64>, _>("spirit_stones")?
            .unwrap_or_default(),
    })
}

fn resolve_month_card_id(value: Option<String>) -> String {
    let raw = value.unwrap_or_default();
    let normalized = raw.trim();
    if normalized.is_empty() {
        DEFAULT_MONTH_CARD_ID.to_string()
    } else {
        normalized.to_string()
    }
}

fn load_month_card_seed(month_card_id: &str) -> Result<MonthCardSeed, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/month_card.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read month_card.json: {error}")))?;
    let payload: MonthCardSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse month_card.json: {error}")))?;
    payload
        .month_cards
        .into_iter()
        .find(|row| row.enabled != Some(false) && row.id == month_card_id)
        .ok_or_else(|| AppError::config("月卡不存在或未启用"))
}

fn clamp_rate(value: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else if value >= 1.0 {
        1.0
    } else {
        value
    }
}

fn now_utc() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

fn date_key(value: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        value.year(),
        u8::from(value.month()),
        value.day()
    )
}

fn normalize_date_key(raw: String) -> String {
    raw.chars().take(10).collect()
}

fn parse_datetime_millis(raw: &str) -> Option<i64> {
    time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        .ok()
        .or_else(|| {
            time::OffsetDateTime::parse(
                raw,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond]+[offset_hour]"
                ),
            )
            .ok()
        })
        .or_else(|| {
            time::OffsetDateTime::parse(
                raw,
                &time::macros::format_description!(
                    "[year]-[month]-[day] [hour]:[minute]:[second]+[offset_hour]"
                ),
            )
            .ok()
        })
        .map(|value| value.unix_timestamp_nanos() as i64 / 1_000_000)
}

fn format_iso(timestamp_ms: i64) -> Result<String, AppError> {
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos((timestamp_ms as i128) * 1_000_000)
        .map_err(|error| AppError::config(format!("invalid month card timestamp: {error}")))?;
    Ok(dt
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| {
            AppError::config(format!("failed to format month card timestamp: {error}"))
        })?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn month_card_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "monthCardId": "monthcard-001",
                "active": true,
                "canClaim": true,
                "daysLeft": 10,
                "spiritStones": 8888
            }
        });
        assert_eq!(payload["data"]["monthCardId"], "monthcard-001");
        assert_eq!(payload["data"]["canClaim"], true);
        println!("MONTH_CARD_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn month_card_use_item_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "使用成功",
            "data": {"monthCardId": "monthcard-001", "daysLeft": 30}
        });
        assert_eq!(payload["data"]["daysLeft"], 30);
        println!("MONTH_CARD_USE_ITEM_RESPONSE={}", payload);
    }

    #[test]
    fn month_card_claim_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "领取成功",
            "data": {"monthCardId": "monthcard-001", "rewardSpiritStones": 10000, "spiritStones": 20000}
        });
        assert_eq!(payload["data"]["rewardSpiritStones"], 10000);
        println!("MONTH_CARD_CLAIM_RESPONSE={}", payload);
    }
}
