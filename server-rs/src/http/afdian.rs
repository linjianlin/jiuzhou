use axum::Json;
use axum::extract::State;
use serde::Serialize;
use sqlx::Row;
use std::future::Future;
use time::OffsetDateTime;

use crate::shared::error::AppError;
use crate::state::AppState;

const AFDIAN_REDEEM_SOURCE_TYPE: &str = "afdian_order";
const AFDIAN_MONTH_CARD_PLAN_ID: &str = "a57feb58323011f1b48952540025c377";
const AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID: &str = "ac7064ea21ca11f1a2b15254001e7c00";
const AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID: &str = "5ca895ba23ad11f1984552540025c377";
const AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID: &str = "f1a4b2d0250011f18c3b52540025c377";
const AFDIAN_OPEN_API_DEFAULT_BASE_URL: &str = "https://ifdian.net";
const AFDIAN_MESSAGE_STALE_SENDING_SECONDS: i64 = 600;
const AFDIAN_MESSAGE_RETRY_DELAYS_SECONDS: [i64; 5] = [60, 300, 1800, 7200, 86400];

#[derive(Clone, Copy)]
enum AfdianRewardUnit {
    #[allow(dead_code)]
    Month,
    SkuCount,
}

#[derive(Clone, Copy)]
enum AfdianPlanRewardConfig {
    Item {
        unit: AfdianRewardUnit,
        item_def_id: &'static str,
        quantity_per_unit: i64,
    },
    SpiritStones {
        unit: AfdianRewardUnit,
        amount_per_unit: i64,
    },
}

#[derive(Clone, Copy)]
struct AfdianPlanConfig {
    reward: AfdianPlanRewardConfig,
}

#[derive(Debug, Serialize)]
pub struct AfdianWebhookResponseDto {
    pub ec: i64,
    pub em: String,
}

#[derive(Debug, serde::Deserialize)]
pub struct AfdianWebhookPayloadInput {
    pub data: Option<AfdianWebhookDataInput>,
}

#[derive(Debug, serde::Deserialize)]
pub struct AfdianWebhookDataInput {
    pub r#type: Option<String>,
    pub order: Option<AfdianWebhookOrderInput>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct AfdianWebhookOrderInput {
    pub out_trade_no: Option<String>,
    pub custom_order_id: Option<String>,
    pub user_id: Option<String>,
    pub user_private_id: Option<String>,
    pub plan_id: Option<String>,
    pub month: Option<i64>,
    pub total_amount: Option<String>,
    pub show_amount: Option<String>,
    pub status: Option<i64>,
    pub remark: Option<String>,
    pub redeem_id: Option<String>,
    pub product_type: Option<i64>,
    pub discount: Option<String>,
    pub title: Option<String>,
    pub address_person: Option<String>,
    pub address_phone: Option<String>,
    pub address_address: Option<String>,
    pub sku_detail: Option<Vec<AfdianWebhookSkuDetailInput>>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct AfdianWebhookSkuDetailInput {
    pub sku_id: Option<String>,
    pub count: Option<i64>,
    pub name: Option<String>,
    pub album_id: Option<String>,
    pub pic: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct AfdianOpenApiEnvelope<T> {
    ec: i64,
    em: String,
    data: T,
}

#[derive(Debug, serde::Serialize)]
struct AfdianOpenApiBody<'a> {
    user_id: &'a str,
    params: String,
    ts: i64,
    sign: String,
}

#[derive(Debug, serde::Deserialize)]
struct AfdianSendMessageResponseData {
    ok: Option<bool>,
    #[serde(flatten)]
    extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, serde::Deserialize)]
struct AfdianQueryOrderResponseData {
    list: Option<Vec<AfdianWebhookOrderInput>>,
}

pub async fn get_afdian_webhook() -> Json<AfdianWebhookResponseDto> {
    Json(AfdianWebhookResponseDto {
        ec: 200,
        em: String::new(),
    })
}

pub async fn post_afdian_webhook(
    State(state): State<AppState>,
    Json(payload): Json<AfdianWebhookPayloadInput>,
) -> (axum::http::StatusCode, Json<AfdianWebhookResponseDto>) {
    let webhook_log_context = build_afdian_webhook_log_context(&payload);
    if let Some(response) = validate_afdian_protocol_payload(&payload) {
        if response.0 == axum::http::StatusCode::BAD_REQUEST {
            tracing::warn!("afdian webhook rejected {}", webhook_log_context);
        }
        return response;
    }

    let verified_order = match query_and_verify_afdian_order(&state.outbound_http, &payload).await {
        Ok(order) => order,
        Err(error) => {
            tracing::warn!(error = %error, "afdian webhook query verification failed {}", webhook_log_context);
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(AfdianWebhookResponseDto {
                    ec: 400,
                    em: error.to_string(),
                }),
            );
        }
    };

    let handle_result = state
        .database
        .with_transaction(|| async { prepare_afdian_order_delivery(&state, &verified_order).await })
        .await;
    let delivery_id = match handle_result {
        Ok(delivery_id) => delivery_id,
        Err(error) => {
            tracing::error!(error = %error, "afdian webhook prepare delivery failed {}", webhook_log_context);
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(AfdianWebhookResponseDto {
                    ec: 400,
                    em: error.to_string(),
                }),
            );
        }
    };

    if let Some(delivery_id) = delivery_id {
        tracing::info!(
            delivery_id,
            "afdian webhook triggered immediate delivery {}",
            webhook_log_context
        );
        if let Err(error) = process_afdian_message_delivery_by_id(&state, delivery_id).await {
            tracing::error!(error = %error, delivery_id, "afdian webhook immediate delivery failed unexpectedly {}", webhook_log_context);
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(AfdianWebhookResponseDto {
                    ec: 400,
                    em: error.to_string(),
                }),
            );
        }
    }

    (
        axum::http::StatusCode::OK,
        Json(AfdianWebhookResponseDto {
            ec: 200,
            em: String::new(),
        }),
    )
}

fn has_afdian_webhook_order_payload(payload: &AfdianWebhookPayloadInput) -> bool {
    payload
        .data
        .as_ref()
        .map(|data| data.r#type.as_deref() == Some("order") && data.order.is_some())
        .unwrap_or(false)
}

fn validate_afdian_protocol_payload(
    payload: &AfdianWebhookPayloadInput,
) -> Option<(axum::http::StatusCode, Json<AfdianWebhookResponseDto>)> {
    if !has_afdian_webhook_order_payload(payload) {
        return Some((
            axum::http::StatusCode::OK,
            Json(AfdianWebhookResponseDto {
                ec: 200,
                em: String::new(),
            }),
        ));
    }
    let out_trade_no = payload
        .data
        .as_ref()
        .and_then(|data| data.order.as_ref())
        .and_then(|order| order.out_trade_no.as_deref())
        .map(str::trim)
        .unwrap_or_default();
    if out_trade_no.is_empty() {
        return Some((
            axum::http::StatusCode::BAD_REQUEST,
            Json(AfdianWebhookResponseDto {
                ec: 400,
                em: "爱发电 webhook 缺少必要字段：out_trade_no".to_string(),
            }),
        ));
    }
    None
}

async fn prepare_afdian_order_delivery(
    state: &AppState,
    order: &AfdianWebhookOrderInput,
) -> Result<Option<i64>, AppError> {
    let out_trade_no = required_text(order.out_trade_no.as_deref(), "out_trade_no")?;
    let user_id = required_text(order.user_id.as_deref(), "user_id")?;
    let plan_id = required_text(order.plan_id.as_deref(), "plan_id")?;
    let month = order
        .month
        .filter(|value| *value > 0)
        .ok_or_else(|| AppError::config("爱发电 webhook 缺少必要字段：month"))?;
    let total_amount = required_text(order.total_amount.as_deref(), "total_amount")?;
    let status = order
        .status
        .ok_or_else(|| AppError::config("爱发电 webhook 缺少必要字段：status"))?;
    let normalized_custom_order_id = normalize_optional_text(order.custom_order_id.as_deref());
    let normalized_user_private_id = normalize_optional_text(order.user_private_id.as_deref());
    let order_log_context = build_afdian_log_context(&[
        ("outTradeNo", Some(out_trade_no.clone())),
        ("planId", Some(plan_id.clone())),
        ("month", Some(month.to_string())),
        ("totalAmount", Some(total_amount.clone())),
        ("userId", Some(user_id.clone())),
    ]);

    let order_payload = build_afdian_order_payload(
        order,
        &out_trade_no,
        &user_id,
        &plan_id,
        month,
        &total_amount,
        status,
    );

    let existing = state.database.fetch_optional(
        "SELECT id, redeem_code_id FROM afdian_order WHERE out_trade_no = $1 LIMIT 1 FOR UPDATE",
        |q| q.bind(&out_trade_no),
    ).await?;
    let (order_id, existing_redeem_code_id) = if let Some(existing) = existing {
        let order_id = existing.try_get::<i64, _>("id")?;
        let redeem_code_id = existing.try_get::<Option<i64>, _>("redeem_code_id")?;
        state.database.execute(
            "UPDATE afdian_order SET custom_order_id = $2, sponsor_user_id = $3, sponsor_private_id = $4, plan_id = $5, month_count = $6, total_amount = $7, status = $8, payload = $9::jsonb, updated_at = NOW() WHERE id = $1",
            |q| q.bind(order_id).bind(&normalized_custom_order_id).bind(&user_id).bind(&normalized_user_private_id).bind(&plan_id).bind(month as i32).bind(&total_amount).bind(status as i32).bind(&order_payload),
        ).await?;
        (order_id, redeem_code_id)
    } else {
        let inserted = state.database.fetch_one(
            "INSERT INTO afdian_order (out_trade_no, custom_order_id, sponsor_user_id, sponsor_private_id, plan_id, month_count, total_amount, status, payload, processed_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW(), NOW(), NOW()) RETURNING id, redeem_code_id",
            |q| q.bind(&out_trade_no).bind(&normalized_custom_order_id).bind(&user_id).bind(&normalized_user_private_id).bind(&plan_id).bind(month as i32).bind(&total_amount).bind(status as i32).bind(&order_payload),
        ).await?;
        (
            inserted.try_get::<i64, _>("id")?,
            inserted.try_get::<Option<i64>, _>("redeem_code_id")?,
        )
    };
    tracing::info!(
        order_id,
        status,
        "afdian order prepared {}",
        order_log_context
    );

    let Some(reward_payload) =
        build_afdian_reward_payload(&plan_id, month, order.sku_detail.as_ref())?
    else {
        tracing::info!(
            "afdian order ignored unsupported plan {}",
            order_log_context
        );
        return Ok(None);
    };
    let (redeem_code_id, redeem_code) =
        get_or_create_redeem_code(state, &out_trade_no, reward_payload).await?;
    if should_refresh_afdian_order_processed_at(existing_redeem_code_id, redeem_code_id) {
        state.database.execute(
            "UPDATE afdian_order SET redeem_code_id = $2, processed_at = NOW(), updated_at = NOW() WHERE id = $1",
            |q| q.bind(order_id).bind(redeem_code_id),
        ).await?;
    }
    let content = build_afdian_redeem_code_message(&redeem_code);
    let existing_delivery = state
        .database
        .fetch_optional(
            "SELECT id FROM afdian_message_delivery WHERE order_id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(order_id),
        )
        .await?;
    let delivery_id = if let Some(existing_delivery) = existing_delivery {
        existing_delivery.try_get::<i64, _>("id")?
    } else {
        state.database.execute(
            "INSERT INTO afdian_message_delivery (order_id, recipient_user_id, content, status, attempt_count, next_retry_at, created_at, updated_at) VALUES ($1, $2, $3, 'pending', 0, NOW(), NOW(), NOW())",
            |q| q.bind(order_id).bind(&user_id).bind(&content),
        ).await?;
        let delivery = state
            .database
            .fetch_one(
                "SELECT id FROM afdian_message_delivery WHERE order_id = $1 LIMIT 1",
                |q| q.bind(order_id),
            )
            .await?;
        delivery.try_get::<i64, _>("id")?
    };
    tracing::info!(
        redeem_code_id,
        delivery_id,
        "afdian delivery prepared {}",
        build_afdian_log_context(&[
            ("outTradeNo", Some(out_trade_no)),
            ("orderId", Some(order_id.to_string())),
            ("deliveryId", Some(delivery_id.to_string())),
            ("recipientUserId", Some(user_id)),
        ])
    );
    Ok(Some(delivery_id))
}

pub async fn process_pending_afdian_message_delivery(
    state: &AppState,
    order_id: i64,
) -> Result<(), AppError> {
    let claimed = state.database.fetch_optional(
        "UPDATE afdian_message_delivery SET status = 'sending', updated_at = NOW() WHERE order_id = $1 AND ((status IN ('pending', 'failed') AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()) OR (status = 'sending' AND updated_at <= NOW() - ($2 || ' seconds')::interval)) RETURNING id, recipient_user_id, content, attempt_count",
        |q| q.bind(order_id).bind(AFDIAN_MESSAGE_STALE_SENDING_SECONDS),
    ).await?;
    process_claimed_afdian_message_delivery(state, claimed).await
}

pub async fn run_due_afdian_message_retries_once(
    state: &AppState,
    limit: i64,
) -> Result<usize, AppError> {
    let claimed = claim_due_afdian_message_deliveries(state, limit).await?;
    Ok(process_afdian_deliveries_best_effort(
        claimed,
        |row| row.try_get::<i64, _>("id").unwrap_or_default(),
        |row| async move { process_claimed_afdian_message_delivery(state, Some(row)).await },
    )
    .await)
}

async fn process_afdian_deliveries_best_effort<T, I, P, Fut>(
    deliveries: Vec<T>,
    delivery_id_of: I,
    mut process: P,
) -> usize
where
    I: Fn(&T) -> i64,
    P: FnMut(T) -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let claimed_count = deliveries.len();
    for delivery in deliveries {
        let delivery_id = delivery_id_of(&delivery);
        if let Err(error) = process(delivery).await {
            tracing::error!(error = %error, delivery_id, "afdian due retry row failed unexpectedly");
        }
    }
    claimed_count
}

async fn claim_due_afdian_message_deliveries(
    state: &AppState,
    limit: i64,
) -> Result<Vec<sqlx::postgres::PgRow>, AppError> {
    state.database.fetch_all(
        "WITH picked AS (SELECT id FROM afdian_message_delivery WHERE ((status IN ('pending', 'failed') AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()) OR (status = 'sending' AND updated_at <= NOW() - ($2 || ' seconds')::interval)) ORDER BY next_retry_at ASC NULLS FIRST, id ASC LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE afdian_message_delivery AS delivery SET status = 'sending', updated_at = NOW() FROM picked WHERE delivery.id = picked.id RETURNING delivery.id, delivery.recipient_user_id, delivery.content, delivery.attempt_count",
        |q| q.bind(limit).bind(AFDIAN_MESSAGE_STALE_SENDING_SECONDS),
    ).await
}

async fn process_afdian_message_delivery_by_id(
    state: &AppState,
    delivery_id: i64,
) -> Result<(), AppError> {
    let claimed = state.database.fetch_optional(
        "UPDATE afdian_message_delivery SET status = 'sending', updated_at = NOW() WHERE id = $1 AND ((status IN ('pending', 'failed') AND next_retry_at IS NOT NULL AND next_retry_at <= NOW()) OR (status = 'sending' AND updated_at <= NOW() - ($2 || ' seconds')::interval)) RETURNING id, recipient_user_id, content, attempt_count",
        |q| q.bind(delivery_id).bind(AFDIAN_MESSAGE_STALE_SENDING_SECONDS),
    ).await?;
    process_claimed_afdian_message_delivery(state, claimed).await
}

async fn process_claimed_afdian_message_delivery(
    state: &AppState,
    claimed: Option<sqlx::postgres::PgRow>,
) -> Result<(), AppError> {
    let Some(claimed) = claimed else {
        return Ok(());
    };
    let delivery_id = claimed.try_get::<i64, _>("id")?;
    let recipient_user_id = claimed.try_get::<String, _>("recipient_user_id")?;
    let content = claimed.try_get::<String, _>("content")?;
    let next_attempt_count = claimed
        .try_get::<Option<i32>, _>("attempt_count")?
        .map(i64::from)
        .unwrap_or_default()
        + 1;

    match send_afdian_private_message(&state.outbound_http, &recipient_user_id, &content).await {
        Ok(_) => {
            state.database.execute(
                "UPDATE afdian_message_delivery SET status = 'sent', attempt_count = $2, next_retry_at = NULL, last_error = NULL, sent_at = NOW(), updated_at = NOW() WHERE id = $1",
                |q| q.bind(delivery_id).bind(next_attempt_count),
            ).await?;
            tracing::info!(
                delivery_id,
                attempt_count = next_attempt_count,
                "afdian message delivery sent {}",
                build_afdian_log_context(&[
                    ("deliveryId", Some(delivery_id.to_string())),
                    ("recipientUserId", Some(recipient_user_id.clone())),
                    ("attemptCount", Some(next_attempt_count.to_string())),
                ])
            );
        }
        Err(error) => {
            let retry_at = compute_afdian_message_retry_at(next_attempt_count);
            let retry_at_text = retry_at.clone().unwrap_or_else(|| "null".to_string());
            let error_message = normalize_afdian_error_message(&error.to_string());
            state.database.execute(
                "UPDATE afdian_message_delivery SET status = 'failed', attempt_count = $2, next_retry_at = $3::timestamptz, last_error = $4, updated_at = NOW() WHERE id = $1",
                |q| q.bind(delivery_id).bind(next_attempt_count).bind(retry_at.as_deref()).bind(&error_message),
            ).await?;
            tracing::error!(
                delivery_id,
                attempt_count = next_attempt_count,
                retry_at = retry_at_text.as_str(),
                error = error_message.as_str(),
                "afdian message delivery failed {}",
                build_afdian_log_context(&[
                    ("deliveryId", Some(delivery_id.to_string())),
                    ("recipientUserId", Some(recipient_user_id)),
                    ("attemptCount", Some(next_attempt_count.to_string())),
                    ("retryAt", retry_at),
                ])
            );
        }
    }
    Ok(())
}

async fn get_or_create_redeem_code(
    state: &AppState,
    out_trade_no: &str,
    reward_payload: serde_json::Value,
) -> Result<(i64, String), AppError> {
    let existing = state.database.fetch_optional(
        "SELECT id, code FROM redeem_code WHERE source_type = $1 AND source_ref_id = $2 LIMIT 1 FOR UPDATE",
        |q| q.bind(AFDIAN_REDEEM_SOURCE_TYPE).bind(out_trade_no),
    ).await?;
    if let Some(existing) = existing {
        return Ok((
            existing.try_get::<i64, _>("id")?,
            existing.try_get::<String, _>("code")?,
        ));
    }
    let code = build_redeem_code();
    let row = state.database.fetch_one(
        "INSERT INTO redeem_code (code, source_type, source_ref_id, reward_payload, status, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, 'created', NOW(), NOW()) RETURNING id, code",
        |q| q.bind(&code).bind(AFDIAN_REDEEM_SOURCE_TYPE).bind(out_trade_no).bind(&reward_payload),
    ).await?;
    Ok((
        row.try_get::<i64, _>("id")?,
        row.try_get::<String, _>("code")?,
    ))
}

fn required_text(value: Option<&str>, field_name: &str) -> Result<String, AppError> {
    let normalized = value.unwrap_or_default().trim();
    if normalized.is_empty() {
        return Err(AppError::config(format!(
            "爱发电 webhook 缺少必要字段：{field_name}"
        )));
    }
    Ok(normalized.to_string())
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    let normalized = value.unwrap_or_default().trim();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

fn normalize_afdian_error_message(message: &str) -> String {
    let normalized = message.trim();
    if normalized.is_empty() {
        "未知错误".to_string()
    } else {
        normalized.to_string()
    }
}

fn should_refresh_afdian_order_processed_at(
    existing_redeem_code_id: Option<i64>,
    redeem_code_id: i64,
) -> bool {
    existing_redeem_code_id.unwrap_or_default() != redeem_code_id
}

fn build_afdian_order_payload(
    order: &AfdianWebhookOrderInput,
    out_trade_no: &str,
    user_id: &str,
    plan_id: &str,
    month: i64,
    total_amount: &str,
    status: i64,
) -> serde_json::Value {
    serde_json::json!({
        "out_trade_no": out_trade_no,
        "custom_order_id": order.custom_order_id,
        "user_id": user_id,
        "user_private_id": order.user_private_id,
        "plan_id": plan_id,
        "month": month,
        "total_amount": total_amount,
        "show_amount": order.show_amount,
        "status": status,
        "remark": order.remark,
        "redeem_id": order.redeem_id,
        "product_type": order.product_type,
        "discount": order.discount,
        "title": order.title,
        "address_person": order.address_person,
        "address_phone": order.address_phone,
        "address_address": order.address_address,
        "sku_detail": order.sku_detail,
    })
}

fn build_afdian_log_context(fields: &[(&str, Option<String>)]) -> String {
    fields
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| format!("{}={}", key, value))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_afdian_webhook_log_context(payload: &AfdianWebhookPayloadInput) -> String {
    let order = payload.data.as_ref().and_then(|data| data.order.as_ref());
    build_afdian_log_context(&[
        (
            "type",
            payload.data.as_ref().and_then(|data| data.r#type.clone()),
        ),
        (
            "outTradeNo",
            order.and_then(|order| order.out_trade_no.clone()),
        ),
        ("planId", order.and_then(|order| order.plan_id.clone())),
        ("userId", order.and_then(|order| order.user_id.clone())),
        (
            "month",
            order.and_then(|order| order.month.map(|value| value.to_string())),
        ),
    ])
}

fn build_afdian_reward_payload(
    plan_id: &str,
    month: i64,
    sku_detail: Option<&Vec<AfdianWebhookSkuDetailInput>>,
) -> Result<Option<serde_json::Value>, AppError> {
    let Some(plan_config) = get_afdian_plan_config(plan_id) else {
        return Ok(None);
    };
    let reward_units = compute_afdian_reward_units(plan_config.reward, month, sku_detail)?;
    let reward_payload = match plan_config.reward {
        AfdianPlanRewardConfig::Item {
            item_def_id,
            quantity_per_unit,
            ..
        } => serde_json::json!({
            "items": [{"itemDefId": item_def_id, "quantity": quantity_per_unit * reward_units}]
        }),
        AfdianPlanRewardConfig::SpiritStones {
            amount_per_unit, ..
        } => serde_json::json!({
            "spiritStones": amount_per_unit * reward_units
        }),
    };
    Ok(Some(reward_payload))
}

fn get_afdian_plan_config(plan_id: &str) -> Option<AfdianPlanConfig> {
    match plan_id.trim() {
        AFDIAN_MONTH_CARD_PLAN_ID => Some(AfdianPlanConfig {
            reward: AfdianPlanRewardConfig::Item {
                unit: AfdianRewardUnit::SkuCount,
                item_def_id: "cons-monthcard-001",
                quantity_per_unit: 1,
            },
        }),
        AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID => Some(AfdianPlanConfig {
            reward: AfdianPlanRewardConfig::SpiritStones {
                unit: AfdianRewardUnit::SkuCount,
                amount_per_unit: 30000,
            },
        }),
        AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID => Some(AfdianPlanConfig {
            reward: AfdianPlanRewardConfig::Item {
                unit: AfdianRewardUnit::SkuCount,
                item_def_id: "token-004",
                quantity_per_unit: 1,
            },
        }),
        AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID => Some(AfdianPlanConfig {
            reward: AfdianPlanRewardConfig::Item {
                unit: AfdianRewardUnit::SkuCount,
                item_def_id: "token-005",
                quantity_per_unit: 1,
            },
        }),
        _ => None,
    }
}

fn compute_afdian_reward_units(
    reward_config: AfdianPlanRewardConfig,
    month: i64,
    sku_detail: Option<&Vec<AfdianWebhookSkuDetailInput>>,
) -> Result<i64, AppError> {
    match reward_config {
        AfdianPlanRewardConfig::Item { unit, .. }
        | AfdianPlanRewardConfig::SpiritStones { unit, .. } => match unit {
            AfdianRewardUnit::Month => {
                if month <= 0 {
                    return Err(AppError::config("爱发电订单 month 必须为正整数"));
                }
                Ok(month)
            }
            AfdianRewardUnit::SkuCount => compute_afdian_sku_purchase_count(sku_detail),
        },
    }
}

fn build_afdian_redeem_code_message(code: &str) -> String {
    [
        "感谢你支持《九州修仙录》！",
        "这是为你生成的赞助兑换码：",
        code,
        "进入游戏后，在“设置 - 兑换码”中输入即可领取对应赞助奖励。",
    ]
    .join("\n")
}

fn compute_afdian_sku_purchase_count(
    sku_detail: Option<&Vec<AfdianWebhookSkuDetailInput>>,
) -> Result<i64, AppError> {
    let detail = sku_detail.ok_or_else(|| AppError::config("爱发电商品订单缺少有效 sku_detail"))?;
    let mut total = 0;
    for sku in detail {
        let count = sku.count.unwrap_or_default();
        if count <= 0 {
            return Err(AppError::config(
                "爱发电商品订单 sku_detail.count 必须为正整数",
            ));
        }
        total += count;
    }
    if total <= 0 {
        return Err(AppError::config(
            "爱发电商品订单 sku_detail.count 汇总后必须大于 0",
        ));
    }
    Ok(total)
}

fn build_redeem_code() -> String {
    format!(
        "AFD{:08X}",
        (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
            & 0xFFFFFFFF) as u32
    )
}

fn get_afdian_open_api_base_url() -> String {
    let raw = std::env::var("AFDIAN_OPEN_API_BASE_URL")
        .unwrap_or_else(|_| AFDIAN_OPEN_API_DEFAULT_BASE_URL.to_string());
    let normalized = raw.trim().trim_end_matches('/');
    if normalized.is_empty() {
        AFDIAN_OPEN_API_DEFAULT_BASE_URL.to_string()
    } else {
        normalized.to_string()
    }
}

fn get_afdian_open_api_credentials() -> Result<(String, String), AppError> {
    let user_id = std::env::var("AFDIAN_OPEN_USER_ID")
        .unwrap_or_default()
        .trim()
        .to_string();
    let token = std::env::var("AFDIAN_OPEN_TOKEN")
        .unwrap_or_default()
        .trim()
        .to_string();
    if user_id.is_empty() || token.is_empty() {
        return Err(AppError::config(
            "爱发电 OpenAPI 配置缺失：请设置 AFDIAN_OPEN_USER_ID 与 AFDIAN_OPEN_TOKEN",
        ));
    }
    Ok((user_id, token))
}

fn build_afdian_open_api_sign(user_id: &str, token: &str, params_text: &str, ts: i64) -> String {
    let sign_text = format!("{token}params{params_text}ts{ts}user_id{user_id}");
    format!("{:x}", md5::compute(sign_text))
}

async fn send_afdian_private_message(
    client: &reqwest::Client,
    recipient: &str,
    content: &str,
) -> Result<AfdianOpenApiEnvelope<AfdianSendMessageResponseData>, AppError> {
    let (user_id, token) = get_afdian_open_api_credentials()?;
    let ts = OffsetDateTime::now_utc().unix_timestamp();
    let params_text = serde_json::json!({
        "recipient": recipient,
        "content": content,
    })
    .to_string();
    let sign = build_afdian_open_api_sign(&user_id, &token, &params_text, ts);
    let body = AfdianOpenApiBody {
        user_id: &user_id,
        params: params_text,
        ts,
        sign,
    };
    let response = client
        .post(format!(
            "{}/api/open/send-msg",
            get_afdian_open_api_base_url()
        ))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "爱发电接口请求失败：HTTP {} {}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        )));
    }
    let body: AfdianOpenApiEnvelope<AfdianSendMessageResponseData> = serde_json::from_str(&text)
        .map_err(|error| AppError::config(format!("爱发电接口响应解析失败: {error}")))?;
    if body.ec != 200 {
        return Err(AppError::config(if body.em.trim().is_empty() {
            format!("爱发电接口请求失败：ec={}", body.ec)
        } else {
            body.em.clone()
        }));
    }
    if body.data.ok == Some(false) {
        return Err(AppError::config(if body.em.trim().is_empty() {
            "爱发电接口请求失败：send-msg 返回 ok=false".to_string()
        } else {
            body.em.clone()
        }));
    }
    let _ = body.data.extra.len();
    Ok(body)
}

async fn query_afdian_orders_by_out_trade_no(
    client: &reqwest::Client,
    out_trade_no: &str,
) -> Result<Vec<AfdianWebhookOrderInput>, AppError> {
    let (user_id, token) = get_afdian_open_api_credentials()?;
    let ts = OffsetDateTime::now_utc().unix_timestamp();
    let params_text = serde_json::json!({
        "out_trade_no": out_trade_no,
    })
    .to_string();
    let sign = build_afdian_open_api_sign(&user_id, &token, &params_text, ts);
    let body = AfdianOpenApiBody {
        user_id: &user_id,
        params: params_text,
        ts,
        sign,
    };
    let response = client
        .post(format!(
            "{}/api/open/query-order",
            get_afdian_open_api_base_url()
        ))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "爱发电接口请求失败：HTTP {} {}",
            status.as_u16(),
            text.chars().take(200).collect::<String>()
        )));
    }
    let body: AfdianOpenApiEnvelope<AfdianQueryOrderResponseData> = serde_json::from_str(&text)
        .map_err(|error| AppError::config(format!("爱发电接口响应解析失败: {error}")))?;
    if body.ec != 200 {
        return Err(AppError::config(if body.em.trim().is_empty() {
            format!("爱发电接口请求失败：ec={}", body.ec)
        } else {
            body.em.clone()
        }));
    }
    Ok(body.data.list.unwrap_or_default())
}

async fn query_and_verify_afdian_order(
    client: &reqwest::Client,
    payload: &AfdianWebhookPayloadInput,
) -> Result<AfdianWebhookOrderInput, AppError> {
    let webhook_order = payload
        .data
        .as_ref()
        .and_then(|data| data.order.as_ref())
        .ok_or_else(|| AppError::config("爱发电 webhook 缺少必要字段：order"))?;
    let out_trade_no = required_text(webhook_order.out_trade_no.as_deref(), "out_trade_no")?;
    let queried_orders = query_afdian_orders_by_out_trade_no(client, &out_trade_no).await?;
    let verified_order = find_afdian_order_by_out_trade_no(&queried_orders, &out_trade_no)
        .cloned()
        .ok_or_else(|| AppError::config("爱发电订单回查失败：未找到对应订单"))?;
    assert_afdian_order_matches_webhook(webhook_order, &verified_order)?;
    Ok(verified_order)
}

fn find_afdian_order_by_out_trade_no<'a>(
    orders: &'a [AfdianWebhookOrderInput],
    out_trade_no: &str,
) -> Option<&'a AfdianWebhookOrderInput> {
    let normalized_out_trade_no = out_trade_no.trim();
    if normalized_out_trade_no.is_empty() {
        return None;
    }
    orders.iter().find(|order| {
        order
            .out_trade_no
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            == normalized_out_trade_no
    })
}

fn assert_afdian_order_matches_webhook(
    webhook_order: &AfdianWebhookOrderInput,
    verified_order: &AfdianWebhookOrderInput,
) -> Result<(), AppError> {
    let mut mismatch_fields = Vec::new();
    if webhook_order.out_trade_no.as_deref().unwrap_or_default()
        != verified_order.out_trade_no.as_deref().unwrap_or_default()
    {
        mismatch_fields.push("out_trade_no");
    }
    if webhook_order.user_id.as_deref().unwrap_or_default()
        != verified_order.user_id.as_deref().unwrap_or_default()
    {
        mismatch_fields.push("user_id");
    }
    if webhook_order.plan_id.as_deref().unwrap_or_default()
        != verified_order.plan_id.as_deref().unwrap_or_default()
    {
        mismatch_fields.push("plan_id");
    }
    if webhook_order.month.unwrap_or_default() != verified_order.month.unwrap_or_default() {
        mismatch_fields.push("month");
    }
    if webhook_order.total_amount.as_deref().unwrap_or_default()
        != verified_order.total_amount.as_deref().unwrap_or_default()
    {
        mismatch_fields.push("total_amount");
    }
    if webhook_order.status.unwrap_or_default() != verified_order.status.unwrap_or_default() {
        mismatch_fields.push("status");
    }
    if mismatch_fields.is_empty() {
        Ok(())
    } else {
        Err(AppError::config(format!(
            "爱发电订单回查结果与 webhook 不一致：{}",
            mismatch_fields.join(", ")
        )))
    }
}

fn compute_afdian_message_retry_at(next_attempt_count: i64) -> Option<String> {
    compute_afdian_message_retry_at_from(next_attempt_count, OffsetDateTime::now_utc())
}

fn compute_afdian_message_retry_at_from(
    next_attempt_count: i64,
    now: OffsetDateTime,
) -> Option<String> {
    let delay_seconds = AFDIAN_MESSAGE_RETRY_DELAYS_SECONDS
        .get((next_attempt_count - 1).max(0) as usize)
        .copied()?;
    let next = now + time::Duration::seconds(delay_seconds);
    next.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

#[cfg(test)]
mod tests {
    use time::OffsetDateTime;

    use super::{
        AfdianPlanConfig, AfdianPlanRewardConfig, AfdianRewardUnit, AfdianWebhookDataInput,
        AfdianWebhookOrderInput, AfdianWebhookPayloadInput, AfdianWebhookSkuDetailInput,
        assert_afdian_order_matches_webhook, build_afdian_log_context, build_afdian_open_api_sign,
        build_afdian_order_payload, build_afdian_redeem_code_message, build_afdian_reward_payload,
        build_afdian_webhook_log_context, compute_afdian_message_retry_at,
        compute_afdian_message_retry_at_from, compute_afdian_reward_units,
        find_afdian_order_by_out_trade_no, get_afdian_open_api_base_url, get_afdian_plan_config,
        has_afdian_webhook_order_payload, normalize_afdian_error_message, normalize_optional_text,
        should_refresh_afdian_order_processed_at, validate_afdian_protocol_payload,
    };

    #[tokio::test]
    async fn afdian_webhook_get_payload_matches_contract() {
        let response = super::get_afdian_webhook().await;
        let payload = serde_json::to_value(response.0).expect("payload should serialize");
        assert_eq!(payload, serde_json::json!({"ec": 200, "em": ""}));
        println!("AFDIAN_WEBHOOK_GET_RESPONSE={}", payload);
    }

    #[tokio::test]
    async fn afdian_webhook_post_non_order_returns_ok() {
        let (status, body) =
            validate_afdian_protocol_payload(&AfdianWebhookPayloadInput { data: None })
                .expect("response should exist");
        let payload = serde_json::to_value(body.0).expect("payload should serialize");
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(payload, serde_json::json!({"ec": 200, "em": ""}));
        println!("AFDIAN_WEBHOOK_POST_NON_ORDER_RESPONSE={}", payload);
    }

    #[test]
    fn afdian_has_order_payload_matches_node_guard_semantics() {
        let empty = AfdianWebhookPayloadInput { data: None };
        let non_order = AfdianWebhookPayloadInput {
            data: Some(AfdianWebhookDataInput {
                r#type: Some("ping".to_string()),
                order: Some(AfdianWebhookOrderInput {
                    out_trade_no: Some("trade-1".to_string()),
                    custom_order_id: None,
                    user_id: Some("user-a".to_string()),
                    user_private_id: None,
                    plan_id: Some("plan-a".to_string()),
                    month: Some(1),
                    total_amount: Some("30.00".to_string()),
                    show_amount: None,
                    status: Some(2),
                    remark: None,
                    redeem_id: None,
                    product_type: None,
                    discount: None,
                    title: None,
                    address_person: None,
                    address_phone: None,
                    address_address: None,
                    sku_detail: None,
                }),
            }),
        };
        let order_without_body = AfdianWebhookPayloadInput {
            data: Some(AfdianWebhookDataInput {
                r#type: Some("order".to_string()),
                order: None,
            }),
        };
        let valid_order = AfdianWebhookPayloadInput {
            data: Some(AfdianWebhookDataInput {
                r#type: Some("order".to_string()),
                order: Some(AfdianWebhookOrderInput {
                    out_trade_no: Some("trade-1".to_string()),
                    custom_order_id: None,
                    user_id: Some("user-a".to_string()),
                    user_private_id: None,
                    plan_id: Some("plan-a".to_string()),
                    month: Some(1),
                    total_amount: Some("30.00".to_string()),
                    show_amount: None,
                    status: Some(2),
                    remark: None,
                    redeem_id: None,
                    product_type: None,
                    discount: None,
                    title: None,
                    address_person: None,
                    address_phone: None,
                    address_address: None,
                    sku_detail: None,
                }),
            }),
        };
        assert!(!has_afdian_webhook_order_payload(&empty));
        assert!(!has_afdian_webhook_order_payload(&non_order));
        assert!(!has_afdian_webhook_order_payload(&order_without_body));
        assert!(has_afdian_webhook_order_payload(&valid_order));
        println!(
            "AFDIAN_HAS_ORDER_PAYLOAD={{\"empty\":{},\"nonOrder\":{},\"missingOrder\":{},\"validOrder\":{}}}",
            has_afdian_webhook_order_payload(&empty),
            has_afdian_webhook_order_payload(&non_order),
            has_afdian_webhook_order_payload(&order_without_body),
            has_afdian_webhook_order_payload(&valid_order)
        );
    }

    #[tokio::test]
    async fn afdian_webhook_post_missing_out_trade_no_returns_400() {
        let payload = serde_json::json!({"data": {"type": "order", "order": {}}});
        let parsed: AfdianWebhookPayloadInput =
            serde_json::from_value(payload).expect("payload should parse");
        let (status, body) =
            validate_afdian_protocol_payload(&parsed).expect("response should exist");
        let payload = serde_json::to_value(body.0).expect("payload should serialize");
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(
            payload,
            serde_json::json!({"ec": 400, "em": "爱发电 webhook 缺少必要字段：out_trade_no"})
        );
        println!("AFDIAN_WEBHOOK_POST_BAD_REQUEST_RESPONSE={}", payload);
    }

    #[test]
    fn afdian_open_api_sign_matches_node_contract_shape() {
        let sign =
            build_afdian_open_api_sign("uid", "token", r#"{"recipient":"1","content":"hi"}"#, 123);
        assert_eq!(sign.len(), 32);
        assert!(sign.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(
            build_afdian_open_api_sign("abc", "123", r#"{"a":333}"#, 1624339905),
            "a4acc28b81598b7e5d84ebdc3e91710c"
        );
        println!(
            "AFDIAN_OPEN_API_SIGN={}",
            build_afdian_open_api_sign("abc", "123", r#"{"a":333}"#, 1624339905)
        );
    }

    #[test]
    fn afdian_open_api_base_url_falls_back_when_env_is_blank() {
        let key = "AFDIAN_OPEN_API_BASE_URL";
        let original = std::env::var(key).ok();
        unsafe {
            std::env::set_var(key, "   ");
        }
        let blank = get_afdian_open_api_base_url();
        unsafe {
            std::env::set_var(key, "https://ifdian.net///");
        }
        let trimmed = get_afdian_open_api_base_url();
        match original {
            Some(value) => unsafe {
                std::env::set_var(key, value);
            },
            None => unsafe {
                std::env::remove_var(key);
            },
        }
        assert_eq!(blank, super::AFDIAN_OPEN_API_DEFAULT_BASE_URL);
        assert_eq!(trimmed, super::AFDIAN_OPEN_API_DEFAULT_BASE_URL);
        println!(
            "AFDIAN_BASE_URL={{\"blank\":{:?},\"trimmed\":{:?}}}",
            blank, trimmed
        );
    }

    #[tokio::test]
    async fn afdian_send_msg_ok_false_is_treated_as_failure() {
        let app = axum::Router::new().route(
            "/api/open/send-msg",
            axum::routing::post(|| async move {
                axum::Json(serde_json::json!({
                    "ec": 200,
                    "em": "send-msg business failed",
                    "data": {"ok": false}
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind listener");
        let address = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("server should run");
        });

        let old_base = std::env::var("AFDIAN_OPEN_API_BASE_URL").ok();
        let old_user = std::env::var("AFDIAN_OPEN_USER_ID").ok();
        let old_token = std::env::var("AFDIAN_OPEN_TOKEN").ok();
        unsafe {
            std::env::set_var("AFDIAN_OPEN_API_BASE_URL", format!("http://{address}"));
            std::env::set_var("AFDIAN_OPEN_USER_ID", "mock-user-id");
            std::env::set_var("AFDIAN_OPEN_TOKEN", "mock-token");
        }

        let client = reqwest::Client::new();
        let error = super::send_afdian_private_message(&client, "afdian-user", "hello")
            .await
            .expect_err("ok=false should be treated as failure");

        println!("AFDIAN_SEND_MSG_OK_FALSE_ERROR={}", error);

        server.abort();
        match old_base {
            Some(value) => unsafe { std::env::set_var("AFDIAN_OPEN_API_BASE_URL", value) },
            None => unsafe { std::env::remove_var("AFDIAN_OPEN_API_BASE_URL") },
        }
        match old_user {
            Some(value) => unsafe { std::env::set_var("AFDIAN_OPEN_USER_ID", value) },
            None => unsafe { std::env::remove_var("AFDIAN_OPEN_USER_ID") },
        }
        match old_token {
            Some(value) => unsafe { std::env::set_var("AFDIAN_OPEN_TOKEN", value) },
            None => unsafe { std::env::remove_var("AFDIAN_OPEN_TOKEN") },
        }

        assert!(error.to_string().contains("send-msg business failed"));
    }

    #[test]
    fn afdian_optional_text_fields_trim_and_empty_to_none() {
        let custom = normalize_optional_text(Some("  custom-1  "));
        let private = normalize_optional_text(Some("   "));
        let missing = normalize_optional_text(None);
        assert_eq!(custom.as_deref(), Some("custom-1"));
        assert_eq!(private, None);
        assert_eq!(missing, None);
        println!(
            "AFDIAN_OPTIONAL_TEXT={{\"custom\":{:?},\"blankIsNone\":{},\"missingIsNone\":{}}}",
            custom,
            private.is_none(),
            missing.is_none()
        );
    }

    #[test]
    fn afdian_error_message_normalization_matches_node_semantics() {
        let trimmed = normalize_afdian_error_message("  network failed  ");
        let blank = normalize_afdian_error_message("   ");
        assert_eq!(trimmed, "network failed");
        assert_eq!(blank, "未知错误");
        println!(
            "AFDIAN_ERROR_MESSAGE={{\"trimmed\":{:?},\"blank\":{:?}}}",
            trimmed, blank
        );
    }

    #[test]
    fn afdian_processed_at_refresh_only_when_redeem_code_changes() {
        assert!(should_refresh_afdian_order_processed_at(None, 3));
        assert!(should_refresh_afdian_order_processed_at(Some(2), 3));
        assert!(!should_refresh_afdian_order_processed_at(Some(3), 3));
        println!(
            "AFDIAN_PROCESSED_AT_REFRESH={{\"noneToThree\":{},\"twoToThree\":{},\"sameId\":{}}}",
            should_refresh_afdian_order_processed_at(None, 3),
            should_refresh_afdian_order_processed_at(Some(2), 3),
            should_refresh_afdian_order_processed_at(Some(3), 3)
        );
    }

    #[test]
    fn afdian_order_payload_preserves_extended_order_fields() {
        let order = AfdianWebhookOrderInput {
            out_trade_no: Some("trade-1".to_string()),
            custom_order_id: Some("  custom-1  ".to_string()),
            user_id: Some("user-a".to_string()),
            user_private_id: Some("  private-a  ".to_string()),
            plan_id: Some(super::AFDIAN_MONTH_CARD_PLAN_ID.to_string()),
            month: Some(2),
            total_amount: Some("30.00".to_string()),
            show_amount: Some("28.00".to_string()),
            status: Some(2),
            remark: Some("gift".to_string()),
            redeem_id: Some("redeem-7".to_string()),
            product_type: Some(1),
            discount: Some("2.00".to_string()),
            title: Some("月卡支持".to_string()),
            address_person: Some("韩立".to_string()),
            address_phone: Some("13800000000".to_string()),
            address_address: Some("青云洲".to_string()),
            sku_detail: Some(vec![AfdianWebhookSkuDetailInput {
                sku_id: Some("sku-month-card-001".to_string()),
                count: Some(2),
                name: Some("修行月卡".to_string()),
                album_id: Some("album-1".to_string()),
                pic: Some("https://example.com/month-card.png".to_string()),
            }]),
        };
        let payload = build_afdian_order_payload(
            &order,
            "trade-1",
            "user-a",
            super::AFDIAN_MONTH_CARD_PLAN_ID,
            2,
            "30.00",
            2,
        );
        assert_eq!(payload["show_amount"], "28.00");
        assert_eq!(payload["remark"], "gift");
        assert_eq!(payload["redeem_id"], "redeem-7");
        assert_eq!(payload["product_type"], 1);
        assert_eq!(payload["discount"], "2.00");
        assert_eq!(payload["title"], "月卡支持");
        assert_eq!(payload["address_person"], "韩立");
        assert_eq!(payload["address_phone"], "13800000000");
        assert_eq!(payload["address_address"], "青云洲");
        assert_eq!(payload["custom_order_id"], "  custom-1  ");
        assert_eq!(payload["user_private_id"], "  private-a  ");
        assert_eq!(payload["sku_detail"][0]["sku_id"], "sku-month-card-001");
        assert_eq!(payload["sku_detail"][0]["name"], "修行月卡");
        assert_eq!(payload["sku_detail"][0]["album_id"], "album-1");
        assert_eq!(
            payload["sku_detail"][0]["pic"],
            "https://example.com/month-card.png"
        );
        println!("AFDIAN_ORDER_PAYLOAD={payload}");
    }

    #[test]
    fn afdian_log_context_omits_empty_values_and_is_stable() {
        let context = build_afdian_log_context(&[
            ("outTradeNo", Some("trade-1".to_string())),
            ("planId", Some("plan-a".to_string())),
            ("empty", Some(" ".to_string())),
            ("none", None),
        ]);
        assert_eq!(context, "outTradeNo=trade-1 planId=plan-a");
    }

    #[test]
    fn afdian_webhook_log_context_extracts_order_fields() {
        let payload = AfdianWebhookPayloadInput {
            data: Some(AfdianWebhookDataInput {
                r#type: Some("order".to_string()),
                order: Some(AfdianWebhookOrderInput {
                    out_trade_no: Some("trade-1".to_string()),
                    custom_order_id: None,
                    user_id: Some("user-a".to_string()),
                    user_private_id: None,
                    plan_id: Some("plan-a".to_string()),
                    month: Some(1),
                    total_amount: Some("30.00".to_string()),
                    show_amount: None,
                    status: Some(2),
                    remark: None,
                    redeem_id: None,
                    product_type: None,
                    discount: None,
                    title: None,
                    address_person: None,
                    address_phone: None,
                    address_address: None,
                    sku_detail: None,
                }),
            }),
        };
        let context = build_afdian_webhook_log_context(&payload);
        assert_eq!(
            context,
            "type=order outTradeNo=trade-1 planId=plan-a userId=user-a month=1"
        );
    }

    #[test]
    fn afdian_message_retry_schedule_matches_node_sequence() {
        let base = OffsetDateTime::parse(
            "2026-03-16T00:00:00Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("base timestamp should parse");
        assert_eq!(
            compute_afdian_message_retry_at_from(1, base),
            Some("2026-03-16T00:01:00Z".to_string())
        );
        assert_eq!(
            compute_afdian_message_retry_at_from(2, base),
            Some("2026-03-16T00:05:00Z".to_string())
        );
        assert_eq!(
            compute_afdian_message_retry_at_from(3, base),
            Some("2026-03-16T00:30:00Z".to_string())
        );
        assert_eq!(
            compute_afdian_message_retry_at_from(4, base),
            Some("2026-03-16T02:00:00Z".to_string())
        );
        assert_eq!(
            compute_afdian_message_retry_at_from(5, base),
            Some("2026-03-17T00:00:00Z".to_string())
        );
        assert_eq!(compute_afdian_message_retry_at_from(6, base), None);
        assert!(compute_afdian_message_retry_at(1).is_some());
        println!(
            "AFDIAN_RETRY_SCHEDULE={{\"attempt1\":{:?},\"attempt5\":{:?},\"attempt6\":{:?}}}",
            compute_afdian_message_retry_at_from(1, base),
            compute_afdian_message_retry_at_from(5, base),
            compute_afdian_message_retry_at_from(6, base)
        );
    }

    #[test]
    fn afdian_order_mismatch_is_detected() {
        let webhook = AfdianWebhookOrderInput {
            out_trade_no: Some("trade-1".to_string()),
            custom_order_id: None,
            user_id: Some("user-a".to_string()),
            user_private_id: None,
            plan_id: Some("plan-a".to_string()),
            month: Some(1),
            total_amount: Some("30.00".to_string()),
            show_amount: None,
            status: Some(2),
            remark: None,
            redeem_id: None,
            product_type: None,
            discount: None,
            title: None,
            address_person: None,
            address_phone: None,
            address_address: None,
            sku_detail: None,
        };
        let verified = AfdianWebhookOrderInput {
            out_trade_no: Some("trade-1".to_string()),
            custom_order_id: None,
            user_id: Some("user-a".to_string()),
            user_private_id: None,
            plan_id: Some("plan-a".to_string()),
            month: Some(1),
            total_amount: Some("31.00".to_string()),
            show_amount: None,
            status: Some(2),
            remark: None,
            redeem_id: None,
            product_type: None,
            discount: None,
            title: None,
            address_person: None,
            address_phone: None,
            address_address: None,
            sku_detail: None,
        };
        let error = assert_afdian_order_matches_webhook(&webhook, &verified)
            .expect_err("should detect mismatch");
        assert!(error.to_string().contains("total_amount"));
    }

    #[test]
    fn afdian_find_order_by_out_trade_no_trims_and_handles_empty() {
        let verified = AfdianWebhookOrderInput {
            out_trade_no: Some("trade-1".to_string()),
            custom_order_id: None,
            user_id: Some("user-a".to_string()),
            user_private_id: None,
            plan_id: Some("plan-a".to_string()),
            month: Some(1),
            total_amount: Some("30.00".to_string()),
            show_amount: None,
            status: Some(2),
            remark: None,
            redeem_id: None,
            product_type: None,
            discount: None,
            title: None,
            address_person: None,
            address_phone: None,
            address_address: None,
            sku_detail: None,
        };
        let orders = vec![verified];
        let found = find_afdian_order_by_out_trade_no(&orders, " trade-1 ");
        let missing = find_afdian_order_by_out_trade_no(&orders, "missing-order");
        let empty = find_afdian_order_by_out_trade_no(&orders, "   ");
        assert_eq!(
            found.and_then(|order| order.out_trade_no.as_deref()),
            Some("trade-1")
        );
        assert!(missing.is_none());
        assert!(empty.is_none());
        println!(
            "AFDIAN_FIND_ORDER={{\"found\":{:?},\"missing\":{},\"empty\":{}}}",
            found.and_then(|order| order.out_trade_no.as_deref()),
            missing.is_none(),
            empty.is_none()
        );
    }

    #[test]
    fn afdian_month_card_reward_uses_sku_count() {
        let reward = build_afdian_reward_payload(
            super::AFDIAN_MONTH_CARD_PLAN_ID,
            12,
            Some(&vec![AfdianWebhookSkuDetailInput {
                sku_id: None,
                count: Some(2),
                name: None,
                album_id: None,
                pic: None,
            }]),
        )
        .expect("reward should build")
        .expect("reward should exist");
        assert_eq!(reward["items"][0]["quantity"], 2);
    }

    #[test]
    fn afdian_spirit_stone_product_reward_uses_sku_count() {
        let reward = build_afdian_reward_payload(
            super::AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
            1,
            Some(&vec![AfdianWebhookSkuDetailInput {
                sku_id: None,
                count: Some(3),
                name: None,
                album_id: None,
                pic: None,
            }]),
        )
        .expect("reward should build")
        .expect("reward should exist");
        assert_eq!(reward["spiritStones"], 90000);
    }

    #[test]
    fn afdian_advanced_recruit_product_reward_uses_sku_count() {
        let reward = build_afdian_reward_payload(
            super::AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID,
            1,
            Some(&vec![AfdianWebhookSkuDetailInput {
                sku_id: None,
                count: Some(3),
                name: None,
                album_id: None,
                pic: None,
            }]),
        )
        .expect("reward should build")
        .expect("reward should exist");
        assert_eq!(reward["items"][0]["itemDefId"], "token-004");
        assert_eq!(reward["items"][0]["quantity"], 3);
    }

    #[test]
    fn afdian_dunwu_product_reward_uses_sku_count() {
        let reward = build_afdian_reward_payload(
            super::AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID,
            1,
            Some(&vec![AfdianWebhookSkuDetailInput {
                sku_id: None,
                count: Some(3),
                name: None,
                album_id: None,
                pic: None,
            }]),
        )
        .expect("reward should build")
        .expect("reward should exist");
        assert_eq!(reward["items"][0]["itemDefId"], "token-005");
        assert_eq!(reward["items"][0]["quantity"], 3);
    }

    #[test]
    fn afdian_product_reward_rejects_missing_valid_sku_detail() {
        let error = build_afdian_reward_payload(
            super::AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
            1,
            Some(&vec![]),
        )
        .expect_err("missing sku detail should fail");
        assert!(error.to_string().contains("sku_detail"));
        println!("AFDIAN_SKU_DETAIL_ERROR={}", error);
    }

    #[test]
    fn afdian_plan_config_lookup_trims_plan_id() {
        let config = get_afdian_plan_config(&format!(" {} ", super::AFDIAN_MONTH_CARD_PLAN_ID));
        assert!(config.is_some());
    }

    #[test]
    fn afdian_plan_config_keys_match_supported_plan_ids() {
        let configured = [
            super::AFDIAN_MONTH_CARD_PLAN_ID,
            super::AFDIAN_SPIRIT_STONE_PRODUCT_PLAN_ID,
            super::AFDIAN_ADVANCED_RECRUIT_TOKEN_PRODUCT_PLAN_ID,
            super::AFDIAN_DUNWU_TOKEN_PRODUCT_PLAN_ID,
        ];
        assert!(
            configured
                .iter()
                .all(|plan_id| get_afdian_plan_config(plan_id).is_some())
        );
        println!("AFDIAN_PLAN_CONFIG_KEYS={:?}", configured);
    }

    #[test]
    fn afdian_unknown_plan_config_returns_none() {
        assert!(get_afdian_plan_config("other-plan").is_none());
    }

    #[test]
    fn afdian_blank_plan_config_returns_none() {
        assert!(get_afdian_plan_config("   ").is_none());
    }

    #[test]
    fn afdian_reward_units_support_month_based_config() {
        let units = compute_afdian_reward_units(
            AfdianPlanConfig {
                reward: AfdianPlanRewardConfig::Item {
                    unit: AfdianRewardUnit::Month,
                    item_def_id: "cons-monthcard-001",
                    quantity_per_unit: 1,
                },
            }
            .reward,
            3,
            None,
        )
        .expect("month units should resolve");
        assert_eq!(units, 3);
        println!("AFDIAN_REWARD_UNITS_MONTH={}", units);
    }

    #[test]
    fn afdian_redeem_code_message_contains_code_body() {
        let message = build_afdian_redeem_code_message("AFD12345678");
        assert!(message.contains("AFD12345678"));
        assert!(message.contains("设置 - 兑换码"));
        assert!(message.contains("这是为你生成的赞助兑换码："));
        assert!(message.contains("对应赞助奖励"));
    }

    #[tokio::test]
    async fn afdian_due_retry_best_effort_continues_after_single_failure() {
        let processed = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let processed_for_closure = processed.clone();

        let claimed = super::process_afdian_deliveries_best_effort(
            vec![1_i64, 2_i64, 3_i64],
            |delivery_id| *delivery_id,
            move |delivery_id| {
                let processed = processed_for_closure.clone();
                async move {
                    processed.lock().expect("processed lock").push(delivery_id);
                    if delivery_id == 2 {
                        Err(crate::shared::error::AppError::config("send-msg boom"))
                    } else {
                        Ok(())
                    }
                }
            },
        )
        .await;

        let processed = processed.lock().expect("processed lock").clone();
        assert_eq!(claimed, 3);
        assert_eq!(processed, vec![1, 2, 3]);
        println!(
            "AFDIAN_BEST_EFFORT_BATCH={}",
            serde_json::json!({
                "claimed": claimed,
                "processed": processed,
            })
        );
    }
}
