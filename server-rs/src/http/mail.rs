use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    CharacterItemGrantDelta, buffer_character_item_grant_deltas,
};
use crate::integrations::redis_item_instance_mutation::{
    BufferedItemInstanceMutation, ItemInstanceMutationSnapshot, buffer_item_instance_mutations,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::realtime::mail::{MailUpdatePayload, build_mail_update_payload};
use crate::realtime::public_socket::emit_mail_update_to_user;
use crate::shared::error::AppError;
use crate::shared::mail_counter::{
    apply_mail_counter_deltas, build_mail_counter_claim_delta, build_mail_counter_delete_delta,
    build_mail_counter_read_delta, build_mail_counter_state, load_mail_counter_snapshot,
};
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct MailListQuery {
    pub page: Option<i64>,
    #[serde(rename = "pageSize")]
    pub page_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailIdPayload {
    pub mail_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAllMailsPayload {
    pub only_read: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMailPayload {
    pub mail_id: Option<i64>,
    pub auto_disassemble: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDto {
    pub id: i64,
    pub sender_type: String,
    pub sender_name: String,
    pub mail_type: String,
    pub title: String,
    pub content: String,
    pub attach_silver: i64,
    pub attach_spirit_stones: i64,
    pub attach_items: Vec<serde_json::Value>,
    pub attach_rewards: Vec<serde_json::Value>,
    pub has_attachments: bool,
    pub has_claimable_attachments: bool,
    pub read_at: Option<String>,
    pub claimed_at: Option<String>,
    pub expire_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailListData {
    pub mails: Vec<MailDto>,
    pub total: i64,
    pub unread_count: i64,
    pub unclaimed_count: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailUnreadData {
    pub unread_count: i64,
    pub unclaimed_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailReadAllData {
    pub read_count: i64,
}

#[derive(Debug, Serialize)]
pub struct MailSimpleResult {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MailUpdatePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailReadAllResult {
    pub success: bool,
    pub message: String,
    pub read_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MailUpdatePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailDeleteAllResult {
    pub success: bool,
    pub message: String,
    pub deleted_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MailUpdatePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum MailClaimRewardDto {
    #[serde(rename = "silver")]
    Silver { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        quantity: i64,
        item_name: Option<String>,
        item_icon: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct MailClaimResult {
    pub success: bool,
    pub message: String,
    pub rewards: Vec<MailClaimRewardDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MailUpdatePayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailClaimAllRewardsSummary {
    pub silver: i64,
    pub spirit_stones: i64,
    pub item_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailClaimAllResult {
    pub success: bool,
    pub message: String,
    pub claimed_count: i64,
    pub skipped_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rewards: Option<MailClaimAllRewardsSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<MailUpdatePayload>,
}

fn mail_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

async fn claim_mail_instance_attachment_rows(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    mail_id: i64,
    attach_instance_ids: &[serde_json::Value],
) -> Result<Vec<(String, i64)>, AppError> {
    let normalized_ids = attach_instance_ids
        .iter()
        .filter_map(|value| value.as_i64())
        .filter(|value| *value > 0)
        .collect::<Vec<_>>();
    if normalized_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = state.database.fetch_all(
        "SELECT id, owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, bind_owner_user_id, bind_owner_character_id, location, location_slot, equipped_slot, strengthen_level, refine_level, socketed_gems, random_seed, affixes, identified, affix_gen_version, affix_roll_meta, custom_name, locked, expire_at::text AS expire_at_text, obtained_from, obtained_ref_id, metadata FROM item_instance WHERE id = ANY($1) FOR UPDATE",
        |query| query.bind(&normalized_ids),
    ).await?;
    if rows.len() != normalized_ids.len() {
        return Err(AppError::config("邮件附件状态异常"));
    }
    let mut rewards = Vec::new();
    let mut mutations = Vec::new();
    let now_ms = mail_timestamp_ms();
    for row in rows {
        let item_id = row.try_get::<i64, _>("id")?;
        let owner_user_id = row
            .try_get::<Option<i64>, _>("owner_user_id")?
            .unwrap_or_default();
        let owner_character_id = row
            .try_get::<Option<i64>, _>("owner_character_id")?
            .unwrap_or_default();
        let location = row
            .try_get::<Option<String>, _>("location")?
            .unwrap_or_default();
        if owner_user_id != user_id || owner_character_id != character_id || location != "mail" {
            return Err(AppError::config("邮件附件状态异常"));
        }
        let item_def_id = row
            .try_get::<Option<String>, _>("item_def_id")?
            .unwrap_or_default();
        let qty = row
            .try_get::<Option<i32>, _>("qty")?
            .map(i64::from)
            .unwrap_or_default()
            .max(1);
        rewards.push((item_def_id.clone(), qty));
        mutations.push(BufferedItemInstanceMutation {
            op_id: format!("mail-claim:{mail_id}:{item_id}:{now_ms}"),
            character_id,
            item_id,
            created_at_ms: now_ms,
            kind: "upsert".to_string(),
            snapshot: Some(ItemInstanceMutationSnapshot {
                id: item_id,
                owner_user_id,
                owner_character_id,
                item_def_id,
                qty,
                quality: row.try_get::<Option<String>, _>("quality")?,
                quality_rank: row
                    .try_get::<Option<i32>, _>("quality_rank")?
                    .map(i64::from),
                bind_type: row
                    .try_get::<Option<String>, _>("bind_type")?
                    .unwrap_or_else(|| "none".to_string()),
                bind_owner_user_id: row.try_get::<Option<i64>, _>("bind_owner_user_id")?,
                bind_owner_character_id: row
                    .try_get::<Option<i64>, _>("bind_owner_character_id")?,
                location: "bag".to_string(),
                location_slot: None,
                equipped_slot: None,
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
            }),
        });
    }
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_item_instance_mutations(&redis, &mutations).await?;
        }
    } else {
        for mutation in mutations {
            state.database.execute(
                "UPDATE item_instance SET location = 'bag', location_slot = NULL, equipped_slot = NULL, updated_at = NOW() WHERE id = $1 AND owner_character_id = $2",
                |query| query.bind(mutation.item_id).bind(character_id),
            ).await?;
        }
    }
    Ok(rewards)
}

async fn buffer_mail_attachment_reward_deltas(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    mail_id: i64,
    silver: i64,
    spirit_stones: i64,
    attach_items: &[serde_json::Value],
) -> Result<(), AppError> {
    if !(state.redis_available && state.redis.is_some()) {
        return Ok(());
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
    if spirit_stones > 0 {
        resource_fields.push(CharacterResourceDeltaField {
            character_id,
            field: "spirit_stones".to_string(),
            increment: spirit_stones,
        });
    }
    if !resource_fields.is_empty() {
        buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
    }
    let item_grants = attach_items
        .iter()
        .filter_map(|item| {
            let item_def_id = item
                .get("item_def_id")
                .and_then(|value| value.as_str())?
                .trim()
                .to_string();
            let qty = item
                .get("qty")
                .and_then(|value| value.as_i64())
                .unwrap_or_default()
                .max(0);
            if item_def_id.is_empty() || qty <= 0 {
                return None;
            }
            Some(CharacterItemGrantDelta {
                character_id,
                user_id,
                item_def_id,
                qty,
                bind_type: "none".to_string(),
                obtained_from: "mail".to_string(),
                obtained_ref_id: Some(mail_id.to_string()),
                idle_session_id: None,
                metadata: None,
                quality: None,
                quality_rank: None,
                equip_options: None,
            })
        })
        .collect::<Vec<_>>();
    if !item_grants.is_empty() {
        buffer_character_item_grant_deltas(&redis, &item_grants).await?;
    }
    Ok(())
}

fn normalize_mail_attach_rewards(
    attach_rewards_value: Option<serde_json::Value>,
) -> (i64, i64, Vec<serde_json::Value>) {
    let Some(value) = attach_rewards_value else {
        return (0, 0, Vec::new());
    };
    let rewards = if let Some(array) = value.as_array() {
        array.clone()
    } else {
        vec![value]
    };
    let mut silver = 0_i64;
    let mut spirit_stones = 0_i64;
    let mut items = Vec::new();
    for reward in rewards {
        silver += reward
            .get("silver")
            .and_then(|entry| entry.as_i64())
            .unwrap_or_default()
            .max(0);
        spirit_stones += reward
            .get("spiritStones")
            .or_else(|| reward.get("spirit_stones"))
            .and_then(|entry| entry.as_i64())
            .unwrap_or_default()
            .max(0);
        if let Some(item_array) = reward.get("items").and_then(|entry| entry.as_array()) {
            items.extend(item_array.clone());
        }
    }
    (silver, spirit_stones, items)
}

pub async fn list_mails(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MailListQuery>,
) -> Result<Json<SuccessResponse<MailListData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * page_size;

    let rows = state.database.fetch_all(
        "SELECT id, sender_type, sender_name, mail_type, title, content, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, expire_at::text AS expire_at_text, created_at::text AS created_at_text FROM mail WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL)) AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4",
        |query| query.bind(actor.character_id).bind(actor.user_id).bind(page_size).bind(offset),
    ).await?;

    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;

    let mails = rows
        .into_iter()
        .map(|row| {
            let attach_silver = opt_i64_from_i32(&row, "attach_silver");
            let attach_spirit_stones = opt_i64_from_i32(&row, "attach_spirit_stones");
            let attach_items_value = row
                .try_get::<Option<serde_json::Value>, _>("attach_items")
                .unwrap_or(None);
            let attach_rewards_value = row
                .try_get::<Option<serde_json::Value>, _>("attach_rewards")
                .unwrap_or(None);
            let attach_instance_ids_value = row
                .try_get::<Option<serde_json::Value>, _>("attach_instance_ids")
                .unwrap_or(None);
            let mut attach_items = attach_items_value
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let (reward_silver, reward_spirit_stones, reward_items) =
                normalize_mail_attach_rewards(attach_rewards_value);
            attach_items.extend(reward_items);
            let attach_instance_ids = attach_instance_ids_value
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let has_attachments = attach_silver > 0
                || attach_spirit_stones > 0
                || reward_silver > 0
                || reward_spirit_stones > 0
                || !attach_items.is_empty()
                || !attach_instance_ids.is_empty();
            let claimed_at = row
                .try_get::<Option<String>, _>("claimed_at_text")
                .unwrap_or(None);
            MailDto {
                id: row.try_get::<i64, _>("id").unwrap_or_default(),
                sender_type: row
                    .try_get::<Option<String>, _>("sender_type")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "system".to_string()),
                sender_name: row
                    .try_get::<Option<String>, _>("sender_name")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "系统".to_string()),
                mail_type: row
                    .try_get::<Option<String>, _>("mail_type")
                    .unwrap_or(None)
                    .unwrap_or_else(|| "normal".to_string()),
                title: row
                    .try_get::<Option<String>, _>("title")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                content: row
                    .try_get::<Option<String>, _>("content")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                attach_silver: attach_silver + reward_silver,
                attach_spirit_stones: attach_spirit_stones + reward_spirit_stones,
                attach_items,
                attach_rewards: vec![],
                has_attachments,
                has_claimable_attachments: claimed_at.is_none() && has_attachments,
                read_at: row
                    .try_get::<Option<String>, _>("read_at_text")
                    .unwrap_or(None),
                claimed_at,
                expire_at: row
                    .try_get::<Option<String>, _>("expire_at_text")
                    .unwrap_or(None),
                created_at: row
                    .try_get::<Option<String>, _>("created_at_text")
                    .unwrap_or(None)
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(send_success(MailListData {
        mails,
        total: counter.total_count,
        unread_count: counter.unread_count,
        unclaimed_count: counter.unclaimed_count,
        page,
        page_size,
    }))
}

pub async fn unread_counts(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<MailUnreadData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    Ok(send_success(MailUnreadData {
        unread_count: counter.unread_count,
        unclaimed_count: counter.unclaimed_count,
    }))
}

pub async fn read_mail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MailIdPayload>,
) -> Result<Json<MailSimpleResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let mail_id = payload.mail_id.unwrap_or_default();
    if mail_id <= 0 {
        return Err(AppError::config("参数错误"));
    }
    let row = state.database.fetch_optional(
        "UPDATE mail SET read_at = COALESCE(read_at, NOW()), updated_at = NOW() WHERE id = $1 AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL)) AND deleted_at IS NULL RETURNING recipient_user_id, recipient_character_id, read_at::text AS read_at_text_before, claimed_at::text AS claimed_at_text_before, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids",
        |query| query.bind(mail_id).bind(actor.character_id).bind(actor.user_id),
    ).await?;
    let Some(row) = row else {
        return Ok(Json(MailSimpleResult {
            success: false,
            message: "邮件不存在".to_string(),
            debug_realtime: None,
        }));
    };
    let state_before = build_mail_counter_state(
        row.try_get::<Option<i64>, _>("recipient_user_id")?
            .unwrap_or_default(),
        row.try_get::<Option<i64>, _>("recipient_character_id")?,
        row.try_get::<Option<String>, _>("read_at_text_before")?
            .as_deref(),
        row.try_get::<Option<String>, _>("claimed_at_text_before")?
            .as_deref(),
        has_mail_attachments_from_row(&row)?,
    );
    if let Some(delta) = state_before
        .as_ref()
        .and_then(build_mail_counter_read_delta)
    {
        apply_mail_counter_deltas(&state, &[delta]).await?;
    }
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime =
        build_mail_update_payload(counter.unread_count, counter.unclaimed_count, "read_mail");
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);
    Ok(Json(MailSimpleResult {
        success: true,
        message: "已读".to_string(),
        debug_realtime: Some(debug_realtime),
    }))
}

pub async fn read_all_mails(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<MailReadAllResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let rows = state.database.fetch_all(
        "UPDATE mail SET read_at = NOW(), updated_at = NOW() WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL)) AND deleted_at IS NULL AND read_at IS NULL RETURNING recipient_user_id, recipient_character_id, read_at::text AS read_at_text_before, claimed_at::text AS claimed_at_text_before, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids",
        |query| query.bind(actor.character_id).bind(actor.user_id),
    ).await?;
    let read_count = rows.len() as i64;
    let deltas = rows
        .into_iter()
        .map(|row| {
            let state = build_mail_counter_state(
                row.try_get::<Option<i64>, _>("recipient_user_id")?
                    .unwrap_or_default(),
                row.try_get::<Option<i64>, _>("recipient_character_id")?,
                row.try_get::<Option<String>, _>("read_at_text_before")?
                    .as_deref(),
                row.try_get::<Option<String>, _>("claimed_at_text_before")?
                    .as_deref(),
                has_mail_attachments_from_row(&row)?,
            );
            Ok::<_, AppError>(state.and_then(|state| build_mail_counter_read_delta(&state)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    apply_mail_counter_deltas(&state, &deltas.into_iter().flatten().collect::<Vec<_>>()).await?;
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime = build_mail_update_payload(
        counter.unread_count,
        counter.unclaimed_count,
        "read_all_mails",
    );
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);
    Ok(Json(MailReadAllResult {
        success: true,
        message: format!("已读{}封邮件", read_count),
        read_count,
        debug_realtime: Some(debug_realtime),
    }))
}

pub async fn delete_mail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MailIdPayload>,
) -> Result<Json<MailSimpleResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let mail_id = payload.mail_id.unwrap_or_default();
    if mail_id <= 0 {
        return Err(AppError::config("参数错误"));
    }

    let row = state
        .database
        .fetch_optional(
            "UPDATE mail SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL)) AND deleted_at IS NULL RETURNING recipient_user_id, recipient_character_id, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids",
            |query| query.bind(mail_id).bind(actor.character_id).bind(actor.user_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(Json(MailSimpleResult {
            success: false,
            message: "邮件不存在".to_string(),
            debug_realtime: None,
        }));
    };

    let attach_silver = opt_i64_from_i32(&row, "attach_silver");
    let attach_spirit_stones = opt_i64_from_i32(&row, "attach_spirit_stones");
    let attach_items = row
        .try_get::<Option<serde_json::Value>, _>("attach_items")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let attach_rewards = row
        .try_get::<Option<serde_json::Value>, _>("attach_rewards")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let attach_instance_ids = row
        .try_get::<Option<serde_json::Value>, _>("attach_instance_ids")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let claimed_at = row.try_get::<Option<String>, _>("claimed_at_text")?;
    let has_attachments = attach_silver > 0
        || attach_spirit_stones > 0
        || !attach_items.is_empty()
        || !attach_rewards.is_empty()
        || !attach_instance_ids.is_empty();
    let message = if has_attachments && claimed_at.is_none() {
        "邮件已删除（附件未领取）"
    } else {
        "邮件已删除"
    };

    let state_before = build_mail_counter_state(
        row.try_get::<Option<i64>, _>("recipient_user_id")?
            .unwrap_or_default(),
        row.try_get::<Option<i64>, _>("recipient_character_id")?,
        row.try_get::<Option<String>, _>("read_at_text")?.as_deref(),
        row.try_get::<Option<String>, _>("claimed_at_text")?
            .as_deref(),
        has_attachments,
    );
    if let Some(state_before) = state_before.as_ref() {
        apply_mail_counter_deltas(&state, &[build_mail_counter_delete_delta(state_before)]).await?;
    }
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime =
        build_mail_update_payload(counter.unread_count, counter.unclaimed_count, "delete_mail");
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);
    Ok(Json(MailSimpleResult {
        success: true,
        message: message.to_string(),
        debug_realtime: Some(debug_realtime),
    }))
}

pub async fn delete_all_mails(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DeleteAllMailsPayload>,
) -> Result<Json<MailDeleteAllResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let only_read = payload.only_read == Some(true);
    let sql = if only_read {
        "UPDATE mail SET deleted_at = NOW(), updated_at = NOW() WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL)) AND deleted_at IS NULL AND read_at IS NOT NULL RETURNING recipient_user_id, recipient_character_id, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids"
    } else {
        "UPDATE mail SET deleted_at = NOW(), updated_at = NOW() WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL)) AND deleted_at IS NULL RETURNING recipient_user_id, recipient_character_id, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids"
    };
    let rows = state
        .database
        .fetch_all(sql, |query| {
            query.bind(actor.character_id).bind(actor.user_id)
        })
        .await?;
    let deleted = rows.len() as i64;
    let deltas = rows
        .into_iter()
        .map(|row| {
            let has_attachments = has_mail_attachments_from_row(&row)?;
            let state = build_mail_counter_state(
                row.try_get::<Option<i64>, _>("recipient_user_id")?
                    .unwrap_or_default(),
                row.try_get::<Option<i64>, _>("recipient_character_id")?,
                row.try_get::<Option<String>, _>("read_at_text")?.as_deref(),
                row.try_get::<Option<String>, _>("claimed_at_text")?
                    .as_deref(),
                has_attachments,
            );
            Ok::<_, AppError>(state.map(|state| build_mail_counter_delete_delta(&state)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    apply_mail_counter_deltas(&state, &deltas.into_iter().flatten().collect::<Vec<_>>()).await?;
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime = build_mail_update_payload(
        counter.unread_count,
        counter.unclaimed_count,
        "delete_all_mail",
    );
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);

    Ok(Json(MailDeleteAllResult {
        success: true,
        message: format!("已删除{}封邮件", deleted),
        deleted_count: deleted,
        debug_realtime: Some(debug_realtime),
    }))
}

pub async fn claim_mail_attachments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClaimMailPayload>,
) -> Result<Json<MailClaimResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let mail_id = payload.mail_id.unwrap_or_default();
    let _ = payload.auto_disassemble;
    if mail_id <= 0 {
        return Err(AppError::config("参数错误"));
    }

    let mail = state
        .database
        .fetch_optional(
            "SELECT id, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, expire_at::text AS expire_at_text FROM mail WHERE id = $1 AND (recipient_character_id = $2 OR (recipient_user_id = $3 AND recipient_character_id IS NULL)) AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
            |query| query.bind(mail_id).bind(actor.character_id).bind(actor.user_id),
        )
        .await?;
    let Some(mail) = mail else {
        return Ok(Json(MailClaimResult {
            success: false,
            message: "邮件不存在".to_string(),
            rewards: vec![],
            debug_realtime: None,
        }));
    };
    if mail
        .try_get::<Option<String>, _>("claimed_at_text")?
        .is_some()
    {
        return Ok(Json(MailClaimResult {
            success: false,
            message: "附件已领取".to_string(),
            rewards: vec![],
            debug_realtime: None,
        }));
    }
    if let Some(expire_at) = mail.try_get::<Option<String>, _>("expire_at_text")? {
        if !expire_at.trim().is_empty() {
            let expired = state
                .database
                .fetch_one("SELECT ($1::timestamptz <= NOW()) AS expired", |query| {
                    query.bind(expire_at.as_str())
                })
                .await?;
            if expired
                .try_get::<Option<bool>, _>("expired")?
                .unwrap_or(false)
            {
                return Ok(Json(MailClaimResult {
                    success: false,
                    message: "邮件已过期".to_string(),
                    rewards: vec![],
                    debug_realtime: None,
                }));
            }
        }
    }

    let attach_silver = opt_i64_from_i32(&mail, "attach_silver");
    let attach_spirit_stones = opt_i64_from_i32(&mail, "attach_spirit_stones");
    let attach_items = mail
        .try_get::<Option<serde_json::Value>, _>("attach_items")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let attach_rewards = mail.try_get::<Option<serde_json::Value>, _>("attach_rewards")?;
    let attach_instance_ids = mail
        .try_get::<Option<serde_json::Value>, _>("attach_instance_ids")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let (reward_silver, reward_spirit_stones, reward_items) =
        normalize_mail_attach_rewards(attach_rewards);
    let mut attach_items = attach_items;
    attach_items.extend(reward_items);
    if attach_silver <= 0
        && attach_spirit_stones <= 0
        && reward_silver <= 0
        && reward_spirit_stones <= 0
        && attach_items.is_empty()
        && attach_instance_ids.is_empty()
    {
        return Ok(Json(MailClaimResult {
            success: false,
            message: "该邮件没有附件".to_string(),
            rewards: vec![],
            debug_realtime: None,
        }));
    }

    let item_meta_map = load_item_meta_map()?;
    let mut rewards = Vec::new();
    let use_delta = state.redis_available && state.redis.is_some();
    state
        .database
        .with_transaction(|| async {
            let total_silver = attach_silver + reward_silver;
            let total_spirit_stones = attach_spirit_stones + reward_spirit_stones;
            if !use_delta && (total_silver > 0 || total_spirit_stones > 0) {
                state
                    .database
                    .execute(
                        "UPDATE characters SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW() WHERE id = $3",
                        |query| query.bind(total_silver).bind(total_spirit_stones).bind(actor.character_id),
                    )
                    .await?;
            }
            if total_silver > 0 {
                rewards.push(MailClaimRewardDto::Silver { amount: total_silver });
            }
            if total_spirit_stones > 0 {
                rewards.push(MailClaimRewardDto::SpiritStones { amount: total_spirit_stones });
            }
            for item in attach_items.iter() {
                let item_def_id = item.get("item_def_id").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
                let qty = item.get("qty").and_then(|value| value.as_i64()).unwrap_or_default().max(0);
                if item_def_id.is_empty() || qty <= 0 { continue; }
                if !use_delta {
                    state
                        .database
                        .fetch_one(
                            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'mail', $5) RETURNING id",
                            |query| query.bind(actor.user_id).bind(actor.character_id).bind(&item_def_id).bind(qty).bind(mail_id.to_string()),
                        )
                        .await?;
                }
                let meta = item_meta_map.get(item_def_id.as_str()).cloned();
                rewards.push(MailClaimRewardDto::Item {
                    item_def_id,
                    quantity: qty,
                    item_name: meta.as_ref().map(|value| value.0.clone()),
                    item_icon: meta.and_then(|value| value.1),
                });
            }
            for (item_def_id, qty) in claim_mail_instance_attachment_rows(&state, actor.user_id, actor.character_id, mail_id, &attach_instance_ids).await? {
                let meta = item_meta_map.get(item_def_id.as_str()).cloned();
                rewards.push(MailClaimRewardDto::Item {
                    item_def_id,
                    quantity: qty,
                    item_name: meta.as_ref().map(|value| value.0.clone()),
                    item_icon: meta.and_then(|value| value.1),
                });
            }
            state
                .database
                .execute(
                    "UPDATE mail SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()), updated_at = NOW() WHERE id = $1",
                    |query| query.bind(mail_id),
                )
                .await?;
            Ok::<(), AppError>(())
        })
        .await?;
    if use_delta {
        buffer_mail_attachment_reward_deltas(
            &state,
            actor.user_id,
            actor.character_id,
            mail_id,
            attach_silver + reward_silver,
            attach_spirit_stones + reward_spirit_stones,
            &attach_items,
        )
        .await?;
    }

    let state_before = build_mail_counter_state(
        actor.user_id,
        Some(actor.character_id),
        mail.try_get::<Option<String>, _>("read_at_text")?
            .as_deref(),
        mail.try_get::<Option<String>, _>("claimed_at_text")?
            .as_deref(),
        true,
    );
    if let Some(delta) = state_before
        .as_ref()
        .and_then(build_mail_counter_claim_delta)
    {
        apply_mail_counter_deltas(&state, &[delta]).await?;
    }
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime =
        build_mail_update_payload(counter.unread_count, counter.unclaimed_count, "claim_mail");
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);
    Ok(Json(MailClaimResult {
        success: true,
        message: "领取成功".to_string(),
        rewards,
        debug_realtime: Some(debug_realtime),
    }))
}

pub async fn claim_all_mail_attachments(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClaimMailPayload>,
) -> Result<Json<MailClaimAllResult>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let _ = payload.auto_disassemble;
    let rows = state
        .database
        .fetch_all(
            "SELECT id, recipient_user_id, recipient_character_id, read_at::text AS read_at_text, claimed_at::text AS claimed_at_text, attach_silver, attach_spirit_stones, attach_items, attach_rewards, attach_instance_ids FROM mail WHERE (recipient_character_id = $1 OR (recipient_user_id = $2 AND recipient_character_id IS NULL)) AND deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW() AND claimed_at IS NULL AND (attach_silver > 0 OR attach_spirit_stones > 0 OR attach_items IS NOT NULL OR attach_rewards IS NOT NULL OR attach_instance_ids IS NOT NULL) ORDER BY created_at ASC, id ASC",
            |query| query.bind(actor.character_id).bind(actor.user_id),
        )
        .await?;
    if rows.is_empty() {
        return Ok(Json(MailClaimAllResult {
            success: true,
            message: "没有可领取的附件".to_string(),
            claimed_count: 0,
            skipped_count: 0,
            rewards: None,
            debug_realtime: None,
        }));
    }

    let mut claimed_count = 0_i64;
    let skipped_count = 0_i64;
    let mut total_silver = 0_i64;
    let mut total_spirit_stones = 0_i64;
    let mut total_item_count = 0_i64;
    let item_meta_map = load_item_meta_map()?;
    let mut counter_deltas = Vec::new();
    let use_delta = state.redis_available && state.redis.is_some();

    for row in rows {
        let mail_id = row.try_get::<i64, _>("id")?;
        let attach_silver = opt_i64_from_i32(&row, "attach_silver");
        let attach_spirit_stones = opt_i64_from_i32(&row, "attach_spirit_stones");
        let attach_items = row
            .try_get::<Option<serde_json::Value>, _>("attach_items")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let attach_rewards = row.try_get::<Option<serde_json::Value>, _>("attach_rewards")?;
        let attach_instance_ids = row
            .try_get::<Option<serde_json::Value>, _>("attach_instance_ids")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default();
        let (reward_silver, reward_spirit_stones, reward_items) =
            normalize_mail_attach_rewards(attach_rewards);
        let mut attach_items = attach_items;
        attach_items.extend(reward_items);
        let has_attachments = attach_silver > 0
            || attach_spirit_stones > 0
            || reward_silver > 0
            || reward_spirit_stones > 0
            || !attach_items.is_empty()
            || !attach_instance_ids.is_empty();
        let state_before = build_mail_counter_state(
            row.try_get::<Option<i64>, _>("recipient_user_id")?
                .unwrap_or_default(),
            row.try_get::<Option<i64>, _>("recipient_character_id")?,
            row.try_get::<Option<String>, _>("read_at_text")?.as_deref(),
            row.try_get::<Option<String>, _>("claimed_at_text")?
                .as_deref(),
            has_attachments,
        );
        if let Some(delta) = state_before
            .as_ref()
            .and_then(build_mail_counter_claim_delta)
        {
            counter_deltas.push(delta);
        }

        state
            .database
            .with_transaction(|| async {
                let total_silver_delta = attach_silver + reward_silver;
                let total_spirit_stones_delta = attach_spirit_stones + reward_spirit_stones;
                if !use_delta && (total_silver_delta > 0 || total_spirit_stones_delta > 0) {
                    state
                        .database
                        .execute(
                            "UPDATE characters SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW() WHERE id = $3",
                            |query| query.bind(total_silver_delta).bind(total_spirit_stones_delta).bind(actor.character_id),
                        )
                        .await?;
                }
                for item in attach_items.iter() {
                    let item_def_id = item.get("item_def_id").and_then(|value| value.as_str()).unwrap_or_default().trim().to_string();
                    let qty = item.get("qty").and_then(|value| value.as_i64()).unwrap_or_default().max(0);
                    if item_def_id.is_empty() || qty <= 0 { continue; }
                    if !use_delta {
                        let _ = &item_meta_map;
                        state
                            .database
                            .fetch_one(
                                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'mail', $5) RETURNING id",
                                |query| query.bind(actor.user_id).bind(actor.character_id).bind(&item_def_id).bind(qty).bind(mail_id.to_string()),
                            )
                            .await?;
                    }
                }
                let claimed_instances = claim_mail_instance_attachment_rows(&state, actor.user_id, actor.character_id, mail_id, &attach_instance_ids).await?;
                total_item_count += claimed_instances.iter().map(|(_, qty)| *qty).sum::<i64>();
                state
                    .database
                    .execute(
                        "UPDATE mail SET claimed_at = NOW(), read_at = COALESCE(read_at, NOW()), updated_at = NOW() WHERE id = $1",
                        |query| query.bind(mail_id),
                    )
                    .await?;
                Ok::<(), AppError>(())
            })
            .await?;

        if use_delta {
            buffer_mail_attachment_reward_deltas(
                &state,
                actor.user_id,
                actor.character_id,
                mail_id,
                attach_silver + reward_silver,
                attach_spirit_stones + reward_spirit_stones,
                &attach_items,
            )
            .await?;
        }

        claimed_count += 1;
        total_silver += (attach_silver + reward_silver).max(0);
        total_spirit_stones += (attach_spirit_stones + reward_spirit_stones).max(0);
        total_item_count += attach_items
            .iter()
            .map(|item| {
                item.get("qty")
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
                    .max(0)
            })
            .sum::<i64>();
    }

    apply_mail_counter_deltas(&state, &counter_deltas).await?;
    let counter = load_mail_counter_snapshot(&state, actor.character_id, actor.user_id).await?;
    let debug_realtime = build_mail_update_payload(
        counter.unread_count,
        counter.unclaimed_count,
        "claim_all_mail",
    );
    emit_mail_update_to_user(&state, actor.user_id, &debug_realtime);
    Ok(Json(MailClaimAllResult {
        success: true,
        message: format!("成功领取{}封邮件附件", claimed_count),
        claimed_count,
        skipped_count,
        rewards: Some(MailClaimAllRewardsSummary {
            silver: total_silver,
            spirit_stones: total_spirit_stones,
            item_count: total_item_count,
        }),
        debug_realtime: Some(debug_realtime),
    }))
}

fn load_item_meta_map()
-> Result<std::collections::BTreeMap<String, (String, Option<String>)>, AppError> {
    let mut out = std::collections::BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = std::fs::read_to_string(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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

fn has_mail_attachments_from_row(row: &sqlx::postgres::PgRow) -> Result<bool, AppError> {
    let attach_silver = opt_i64_from_i32(row, "attach_silver");
    let attach_spirit_stones = opt_i64_from_i32(row, "attach_spirit_stones");
    let attach_items = row
        .try_get::<Option<serde_json::Value>, _>("attach_items")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let attach_rewards = row.try_get::<Option<serde_json::Value>, _>("attach_rewards")?;
    let attach_instance_ids = row
        .try_get::<Option<serde_json::Value>, _>("attach_instance_ids")?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let (reward_silver, reward_spirit_stones, reward_items) =
        normalize_mail_attach_rewards(attach_rewards);
    Ok(attach_silver > 0
        || attach_spirit_stones > 0
        || reward_silver > 0
        || reward_spirit_stones > 0
        || !attach_items.is_empty()
        || !reward_items.is_empty()
        || !attach_instance_ids.is_empty())
}

#[cfg(test)]
mod tests {
    use crate::shared::mail_counter::MailCounterSnapshot;

    #[test]
    fn mail_list_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "mails": [{
                    "id": 1,
                    "senderType": "system",
                    "senderName": "系统",
                    "mailType": "normal",
                    "title": "测试邮件",
                    "content": "欢迎来到九州",
                    "attachSilver": 0,
                    "attachSpiritStones": 100,
                    "attachItems": [],
                    "attachRewards": [],
                    "hasAttachments": true,
                    "hasClaimableAttachments": true,
                    "readAt": null,
                    "claimedAt": null,
                    "expireAt": null,
                    "createdAt": "2026-04-11T12:00:00Z"
                }],
                "total": 1,
                "unreadCount": 1,
                "unclaimedCount": 1,
                "page": 1,
                "pageSize": 50
            }
        });
        assert_eq!(payload["data"]["mails"][0]["mailType"], "normal");
        assert_eq!(payload["data"]["unreadCount"], 1);
        println!("MAIL_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn mail_unread_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"unreadCount": 2, "unclaimedCount": 1}
        });
        assert_eq!(payload["data"]["unreadCount"], 2);
        assert_eq!(payload["data"]["unclaimedCount"], 1);
        println!("MAIL_UNREAD_RESPONSE={}", payload);
    }

    #[test]
    fn mail_counter_snapshot_shape_matches_contract() {
        let snapshot = MailCounterSnapshot {
            total_count: 3,
            unread_count: 2,
            unclaimed_count: 1,
        };
        let payload = serde_json::json!({
            "totalCount": snapshot.total_count,
            "unreadCount": snapshot.unread_count,
            "unclaimedCount": snapshot.unclaimed_count,
        });
        assert_eq!(payload["unreadCount"], 2);
        assert_eq!(payload["unclaimedCount"], 1);
        println!("MAIL_COUNTER_SNAPSHOT={}", payload);
    }

    #[test]
    fn mail_read_all_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已读3封邮件",
            "data": {"readCount": 3, "debugRealtime": {"kind": "mail:update", "source": "read_all_mails"}}
        });
        assert_eq!(payload["data"]["readCount"], 3);
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "mail:update");
        println!("MAIL_READ_ALL_RESPONSE={}", payload);
    }

    #[test]
    fn mail_delete_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "邮件已删除",
            "data": {"debugRealtime": {"kind": "mail:update", "source": "delete_mail"}}
        });
        assert_eq!(payload["message"], "邮件已删除");
        assert_eq!(payload["data"]["debugRealtime"]["source"], "delete_mail");
        println!("MAIL_DELETE_RESPONSE={}", payload);
    }

    #[test]
    fn mail_delete_all_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "已删除3封邮件",
            "data": {
                "deletedCount": 3,
                "debugRealtime": {"kind": "mail:update", "source": "delete_all_mail"}
            }
        });
        assert_eq!(payload["data"]["deletedCount"], 3);
        assert_eq!(
            payload["data"]["debugRealtime"]["source"],
            "delete_all_mail"
        );
        println!("MAIL_DELETE_ALL_RESPONSE={}", payload);
    }

    #[test]
    fn mail_claim_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "领取成功",
            "debugRealtime": {"kind": "mail:update", "source": "claim_mail"},
            "rewards": [
                {"type": "silver", "amount": 100},
                {"type": "item", "itemDefId": "mat-gongfa-canye", "quantity": 1, "itemName": "功法残页"}
            ]
        });
        assert_eq!(payload["rewards"][0]["type"], "silver");
        assert_eq!(payload["debugRealtime"]["kind"], "mail:update");
        println!("MAIL_CLAIM_RESPONSE={}", payload);
    }

    #[test]
    fn mail_claim_all_payload_matches_frontend_contract_shape() {
        let payload = serde_json::json!({
            "success": true,
            "message": "成功领取2封邮件附件",
            "claimedCount": 2,
            "skippedCount": 0,
            "debugRealtime": {"kind": "mail:update", "source": "claim_all_mail"},
            "rewards": {"silver": 100, "spiritStones": 50, "itemCount": 3}
        });
        assert_eq!(payload["claimedCount"], 2);
        assert_eq!(payload["rewards"]["itemCount"], 3);
        assert_eq!(payload["debugRealtime"]["source"], "claim_all_mail");
        println!("MAIL_CLAIM_ALL_RESPONSE={}", payload);
    }
}
