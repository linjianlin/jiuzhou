use std::{collections::HashMap, future::Future, pin::Pin};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::application::reward_payload::{
    build_reward_preview, normalize_reward_payload, GrantedRewardPreviewView,
};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::mail::{
    MailAttachItemOptionsView, MailAttachItemView, MailItemView, MailListView, MailMutationData,
    MailRouteServices, MailUnreadSummaryView,
};

const MAIL_ACTIVE_SCOPE_SQL: &str =
    "deleted_at IS NULL AND COALESCE(expire_at, 'infinity'::timestamptz) > NOW()";

/**
 * 邮件应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node 邮件模块的列表、红点、已读、删除、批量已读/删除协议，并把计数更新集中在单一入口。
 * 2. 做什么：优先复用 `mail_counter` 聚合表和共享奖励 preview 映射，避免邮件列表为统计和附件展示重复扫描/重复映射。
 * 3. 不做什么：不处理附件真正领取，不做 socket 推送，也不在这里加入 claim 链路的兜底逻辑。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、`character_id`，以及分页或邮件 ID。
 * - 输出：Node 兼容的邮件列表、红点摘要与 `sendResult` 结果体。
 *
 * 数据流 / 状态流：
 * - 路由层完成角色鉴权 -> 本服务按“角色邮件 + 账号级邮件”双分支查询 -> `mail_counter` 汇总统计 -> 返回邮件 DTO。
 * - 已读/删除等写路径 -> 锁定目标邮件 -> 计算计数增量 -> 原子 upsert `mail_counter`。
 *
 * 复用设计说明：
 * - 奖励 preview 直接复用共享 `reward_payload` 模块，邮件与兑换码只维护一套奖励类型映射。
 * - `build_recipient_scoped_mail_union_sql` 把高频列表查询和后续 claim 队列查询共用的“角色+账号双作用域”索引策略集中在一处，避免重复 OR 扫描。
 *
 * 关键边界条件与坑点：
 * 1. `mail_counter` 是红点真值源，这里不回退扫明细表做统计兜底，避免把聚合表重新打回低性能实现。
 * 2. 账号级邮件必须通过独立 user scope 聚合，不能直接把 `recipient_user_id` 和 `recipient_character_id` 混成同一主键。
 */
#[derive(Clone)]
pub struct RustMailRouteService {
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MailAttachItemOptionsPayload {
    #[serde(default)]
    bind_type: Option<String>,
    #[serde(default)]
    equip_options: Option<Value>,
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    quality_rank: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
struct MailAttachItemPayload {
    item_def_id: String,
    #[serde(default)]
    item_name: Option<String>,
    #[serde(default)]
    qty: i64,
    #[serde(default)]
    options: Option<MailAttachItemOptionsPayload>,
}

#[derive(Debug, Clone, Deserialize)]
struct MailMetadataAttachmentPreviewItem {
    #[serde(rename = "itemDefId")]
    item_def_id: String,
    #[serde(rename = "itemName", default)]
    item_name: Option<String>,
    quantity: i64,
}

#[derive(Debug, Clone)]
struct MailCounterDeltaInput {
    recipient_user_id: i64,
    recipient_character_id: Option<i64>,
    total_count_delta: i64,
    unread_count_delta: i64,
    unclaimed_count_delta: i64,
}

#[derive(Debug, Clone)]
struct MailCounterState {
    recipient_user_id: i64,
    recipient_character_id: Option<i64>,
    is_unread: bool,
    is_unclaimed: bool,
}

#[derive(Debug, Clone)]
struct MailCounterSnapshot {
    total_count: i64,
    unread_count: i64,
    unclaimed_count: i64,
}

#[derive(Debug, Clone)]
struct MailCounterScopeDelta {
    scope_type: &'static str,
    scope_id: i64,
    total_count_delta: i64,
    unread_count_delta: i64,
    unclaimed_count_delta: i64,
}

impl RustMailRouteService {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self { pool }
    }

    async fn list_mails_impl(
        &self,
        user_id: i64,
        character_id: i64,
        page: i64,
        page_size: i64,
    ) -> Result<MailListView, BusinessError> {
        let offset = (page - 1).max(0) * page_size;
        let branch_limit = page_size + offset;
        let scoped_mail_union_sql = build_recipient_scoped_mail_union_sql(
            r#"
              id,
              sender_type,
              sender_name,
              mail_type,
              title,
              content,
              attach_silver,
              attach_spirit_stones,
              attach_items,
              attach_rewards,
              attach_instance_ids,
              source,
              metadata,
              read_at,
              claimed_at,
              expire_at,
              created_at
            "#,
            1,
            2,
            &[
                "deleted_at IS NULL",
                "COALESCE(expire_at, 'infinity'::timestamptz) > NOW()",
            ],
            Some("ORDER BY created_at DESC, id DESC"),
            Some(5),
        );
        let sql = format!(
            r#"
            WITH scoped_mail AS (
              {scoped_mail_union_sql}
            )
            SELECT
              id,
              sender_type,
              sender_name,
              mail_type,
              title,
              content,
              attach_silver,
              attach_spirit_stones,
              attach_items,
              attach_rewards,
              attach_instance_ids,
              source,
              metadata,
              read_at,
              claimed_at,
              expire_at,
              created_at
            FROM scoped_mail
            ORDER BY created_at DESC, id DESC
            LIMIT $3 OFFSET $4
            "#
        );

        let (rows, counters) = tokio::try_join!(
            sqlx::query(&sql)
                .bind(character_id)
                .bind(user_id)
                .bind(page_size)
                .bind(offset)
                .bind(branch_limit)
                .fetch_all(&self.pool),
            self.load_mail_counter_snapshot(user_id, character_id),
        )
        .map_err(internal_business_error)?;

        let mails = rows
            .into_iter()
            .map(build_mail_item_view)
            .collect::<Result<Vec<_>, BusinessError>>()?;

        Ok(MailListView {
            mails,
            total: counters.total_count,
            unread_count: counters.unread_count,
            unclaimed_count: counters.unclaimed_count,
            page,
            page_size,
        })
    }

    async fn get_unread_summary_impl(
        &self,
        user_id: i64,
        character_id: i64,
    ) -> Result<MailUnreadSummaryView, BusinessError> {
        let counters = self
            .load_mail_counter_snapshot(user_id, character_id)
            .await
            .map_err(internal_business_error)?;
        Ok(MailUnreadSummaryView {
            unread_count: counters.unread_count,
            unclaimed_count: counters.unclaimed_count,
        })
    }

    async fn read_mail_impl(
        &self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Result<ServiceResultResponse<MailMutationData>, BusinessError> {
        let scope_sql = build_recipient_scope_sql(2, 3);
        let sql = format!(
            r#"
            WITH target_mail AS (
              SELECT
                recipient_user_id,
                recipient_character_id,
                read_at,
                claimed_at,
                attach_silver,
                attach_spirit_stones,
                attach_items,
                attach_rewards,
                attach_instance_ids
              FROM mail
              WHERE id = $1
                AND {scope_sql}
                AND deleted_at IS NULL
              FOR UPDATE
            )
            UPDATE mail
            SET read_at = COALESCE(mail.read_at, NOW()),
                updated_at = NOW()
            FROM target_mail
            WHERE mail.id = $1
            RETURNING
              target_mail.recipient_user_id,
              target_mail.recipient_character_id,
              target_mail.read_at,
              target_mail.claimed_at,
              target_mail.attach_silver,
              target_mail.attach_spirit_stones,
              target_mail.attach_items,
              target_mail.attach_rewards,
              target_mail.attach_instance_ids
            "#
        );
        let rows = sqlx::query(&sql)
            .bind(mail_id)
            .bind(character_id)
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?;
        if rows.is_empty() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("邮件不存在".to_string()),
                None,
            ));
        }
        let state = build_mail_counter_state(&rows[0])?;
        if let Some(state) = state {
            self.apply_mail_counter_deltas(&[build_mail_counter_read_delta(&state)])
                .await?;
        }
        Ok(ServiceResultResponse::new(
            true,
            Some("已读".to_string()),
            None,
        ))
    }

    async fn delete_mail_impl(
        &self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Result<ServiceResultResponse<MailMutationData>, BusinessError> {
        let scope_sql = build_recipient_scope_sql(2, 3);
        let sql = format!(
            r#"
            UPDATE mail
            SET deleted_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND {scope_sql}
              AND deleted_at IS NULL
            RETURNING
              recipient_user_id,
              recipient_character_id,
              read_at,
              claimed_at,
              attach_silver,
              attach_spirit_stones,
              attach_items,
              attach_rewards,
              attach_instance_ids
            "#
        );
        let rows = sqlx::query(&sql)
            .bind(mail_id)
            .bind(character_id)
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?;
        if rows.is_empty() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("邮件不存在".to_string()),
                None,
            ));
        }

        let state = build_mail_counter_state(&rows[0])?;
        if let Some(state) = state {
            self.apply_mail_counter_deltas(&[build_mail_counter_delete_delta(&state)])
                .await?;
        }

        let message = match build_mail_counter_state(&rows[0])? {
            Some(state) if state.is_unclaimed => "邮件已删除（附件未领取）",
            _ => "邮件已删除",
        };
        Ok(ServiceResultResponse::new(
            true,
            Some(message.to_string()),
            None,
        ))
    }

    async fn delete_all_mails_impl(
        &self,
        user_id: i64,
        character_id: i64,
        only_read: bool,
    ) -> Result<ServiceResultResponse<MailMutationData>, BusinessError> {
        let scope_sql = build_recipient_scope_sql(1, 2);
        let mut sql = format!(
            r#"
            UPDATE mail
            SET deleted_at = NOW(),
                updated_at = NOW()
            WHERE {scope_sql}
              AND deleted_at IS NULL
            "#
        );
        if only_read {
            sql.push_str(" AND read_at IS NOT NULL");
        }
        sql.push_str(
            r#"
            RETURNING
              recipient_user_id,
              recipient_character_id,
              read_at,
              claimed_at,
              attach_silver,
              attach_spirit_stones,
              attach_items,
              attach_rewards,
              attach_instance_ids
            "#,
        );

        let rows = sqlx::query(&sql)
            .bind(character_id)
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?;
        let mut deltas = Vec::with_capacity(rows.len());
        for row in &rows {
            if let Some(state) = build_mail_counter_state(row)? {
                deltas.push(build_mail_counter_delete_delta(&state));
            }
        }
        if !deltas.is_empty() {
            self.apply_mail_counter_deltas(&deltas).await?;
        }
        Ok(ServiceResultResponse::new(
            true,
            Some(format!("已删除{}封邮件", rows.len())),
            Some(MailMutationData {
                deleted_count: Some(rows.len() as i64),
                read_count: None,
            }),
        ))
    }

    async fn mark_all_read_impl(
        &self,
        user_id: i64,
        character_id: i64,
    ) -> Result<ServiceResultResponse<MailMutationData>, BusinessError> {
        let scope_sql = build_recipient_scope_sql(1, 2);
        let sql = format!(
            r#"
            UPDATE mail
            SET read_at = NOW(),
                updated_at = NOW()
            WHERE {scope_sql}
              AND deleted_at IS NULL
              AND read_at IS NULL
            RETURNING recipient_user_id, recipient_character_id
            "#
        );
        let rows = sqlx::query(&sql)
            .bind(character_id)
            .bind(user_id)
            .fetch_all(&self.pool)
            .await
            .map_err(internal_business_error)?;

        let deltas = rows
            .iter()
            .filter_map(|row| {
                let recipient_user_id = row.try_get::<i64, _>("recipient_user_id").ok()?;
                let recipient_character_id = row
                    .try_get::<Option<i64>, _>("recipient_character_id")
                    .ok()?;
                Some(MailCounterDeltaInput {
                    recipient_user_id,
                    recipient_character_id,
                    total_count_delta: 0,
                    unread_count_delta: -1,
                    unclaimed_count_delta: 0,
                })
            })
            .collect::<Vec<_>>();
        if !deltas.is_empty() {
            self.apply_mail_counter_deltas(&deltas).await?;
        }
        Ok(ServiceResultResponse::new(
            true,
            Some(format!("已读{}封邮件", rows.len())),
            Some(MailMutationData {
                deleted_count: None,
                read_count: Some(rows.len() as i64),
            }),
        ))
    }

    async fn load_mail_counter_snapshot(
        &self,
        user_id: i64,
        character_id: i64,
    ) -> Result<MailCounterSnapshot, sqlx::Error> {
        let row = sqlx::query(
            r#"
            SELECT
              COALESCE(SUM(total_count), 0)::bigint AS total_count,
              COALESCE(SUM(unread_count), 0)::bigint AS unread_count,
              COALESCE(SUM(unclaimed_count), 0)::bigint AS unclaimed_count
            FROM mail_counter
            WHERE (scope_type = 'character' AND scope_id = $1)
               OR (scope_type = 'user' AND scope_id = $2)
            "#,
        )
        .bind(character_id)
        .bind(user_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(MailCounterSnapshot {
            total_count: row.try_get::<i64, _>("total_count").unwrap_or(0).max(0),
            unread_count: row.try_get::<i64, _>("unread_count").unwrap_or(0).max(0),
            unclaimed_count: row.try_get::<i64, _>("unclaimed_count").unwrap_or(0).max(0),
        })
    }

    async fn apply_mail_counter_deltas(
        &self,
        inputs: &[MailCounterDeltaInput],
    ) -> Result<(), BusinessError> {
        let deltas = merge_mail_counter_deltas(inputs);
        if deltas.is_empty() {
            return Ok(());
        }
        sqlx::query(
            r#"
            WITH input_rows AS (
              SELECT
                scope_type,
                scope_id,
                total_count_delta,
                unread_count_delta,
                unclaimed_count_delta
              FROM jsonb_to_recordset($1::jsonb) AS rows (
                scope_type varchar(16),
                scope_id bigint,
                total_count_delta bigint,
                unread_count_delta bigint,
                unclaimed_count_delta bigint
              )
            ),
            upserted AS (
              INSERT INTO mail_counter (
                scope_type,
                scope_id,
                total_count,
                unread_count,
                unclaimed_count,
                updated_at
              )
              SELECT
                input_rows.scope_type,
                input_rows.scope_id,
                input_rows.total_count_delta,
                input_rows.unread_count_delta,
                input_rows.unclaimed_count_delta,
                NOW()
              FROM input_rows
              ON CONFLICT (scope_type, scope_id) DO UPDATE SET
                total_count = GREATEST(0, mail_counter.total_count + EXCLUDED.total_count),
                unread_count = GREATEST(0, mail_counter.unread_count + EXCLUDED.unread_count),
                unclaimed_count = GREATEST(0, mail_counter.unclaimed_count + EXCLUDED.unclaimed_count),
                updated_at = NOW()
              RETURNING scope_type, scope_id
            )
            DELETE FROM mail_counter
            USING upserted
            WHERE mail_counter.scope_type = upserted.scope_type
              AND mail_counter.scope_id = upserted.scope_id
              AND mail_counter.total_count <= 0
              AND mail_counter.unread_count <= 0
              AND mail_counter.unclaimed_count <= 0
            "#,
        )
        .bind(json!(
            deltas
                .iter()
                .map(|delta| {
                    json!({
                        "scope_type": delta.scope_type,
                        "scope_id": delta.scope_id,
                        "total_count_delta": delta.total_count_delta,
                        "unread_count_delta": delta.unread_count_delta,
                        "unclaimed_count_delta": delta.unclaimed_count_delta,
                    })
                })
                .collect::<Vec<_>>()
        ))
        .execute(&self.pool)
        .await
        .map_err(internal_business_error)?;
        Ok(())
    }
}

impl MailRouteServices for RustMailRouteService {
    fn list_mails<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        page: i64,
        page_size: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailListView, BusinessError>> + Send + 'a>> {
        Box::pin(async move {
            self.list_mails_impl(user_id, character_id, page, page_size)
                .await
        })
    }

    fn get_unread_summary<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<Box<dyn Future<Output = Result<MailUnreadSummaryView, BusinessError>> + Send + 'a>>
    {
        Box::pin(async move { self.get_unread_summary_impl(user_id, character_id).await })
    }

    fn read_mail<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.read_mail_impl(user_id, character_id, mail_id).await })
    }

    fn delete_mail<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        mail_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.delete_mail_impl(user_id, character_id, mail_id).await })
    }

    fn delete_all_mails<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        only_read: bool,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.delete_all_mails_impl(user_id, character_id, only_read)
                .await
        })
    }

    fn mark_all_read<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<MailMutationData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { self.mark_all_read_impl(user_id, character_id).await })
    }
}

fn build_mail_item_view(row: sqlx::postgres::PgRow) -> Result<MailItemView, BusinessError> {
    let attach_silver = row.try_get::<i64, _>("attach_silver").unwrap_or(0).max(0);
    let attach_spirit_stones = row
        .try_get::<i64, _>("attach_spirit_stones")
        .unwrap_or(0)
        .max(0);
    let attach_items_raw = row
        .try_get::<Option<Value>, _>("attach_items")
        .unwrap_or(None);
    let attach_rewards_raw = row
        .try_get::<Option<Value>, _>("attach_rewards")
        .unwrap_or(None);
    let attach_instance_ids_raw = row
        .try_get::<Option<Value>, _>("attach_instance_ids")
        .unwrap_or(None);
    let metadata_raw = row.try_get::<Option<Value>, _>("metadata").unwrap_or(None);
    let source = row.try_get::<Option<String>, _>("source").unwrap_or(None);

    let attach_items = normalize_attach_items(attach_items_raw.clone());
    let attach_instance_ids = normalize_attach_instance_ids(attach_instance_ids_raw);
    let metadata_preview_items = normalize_metadata_attachment_preview_items(metadata_raw);
    let reward_payload = normalize_reward_payload(attach_rewards_raw);
    let mut attach_rewards = Vec::new();
    if attach_silver > 0 {
        attach_rewards.push(GrantedRewardPreviewView::Silver {
            amount: attach_silver,
        });
    }
    if attach_spirit_stones > 0 {
        attach_rewards.push(GrantedRewardPreviewView::SpiritStones {
            amount: attach_spirit_stones,
        });
    }
    let treat_attach_items_as_preview_only = matches!(source.as_deref(), Some("market"))
        && !attach_items.is_empty()
        && !attach_instance_ids.is_empty();
    if !treat_attach_items_as_preview_only {
        attach_rewards.extend(
            attach_items
                .iter()
                .map(|item| GrantedRewardPreviewView::Item {
                    item_def_id: item.item_def_id.clone(),
                    quantity: item.qty,
                    item_name: item.item_name.clone(),
                    item_icon: None,
                }),
        );
    }
    attach_rewards.extend(build_reward_preview(&reward_payload));
    if !metadata_preview_items.is_empty() {
        attach_rewards.extend(metadata_preview_items);
    }

    let has_attachments = !attach_rewards.is_empty() || !attach_instance_ids.is_empty();
    let has_claimable_attachments = row
        .try_get::<Option<DateTime<Utc>>, _>("claimed_at")
        .unwrap_or(None)
        .is_none()
        && !attach_rewards.is_empty();

    Ok(MailItemView {
        id: row
            .try_get::<i64, _>("id")
            .map_err(internal_business_error)?,
        sender_type: row
            .try_get::<String, _>("sender_type")
            .map_err(internal_business_error)?,
        sender_name: row
            .try_get::<String, _>("sender_name")
            .map_err(internal_business_error)?,
        mail_type: row
            .try_get::<String, _>("mail_type")
            .map_err(internal_business_error)?,
        title: row
            .try_get::<String, _>("title")
            .map_err(internal_business_error)?,
        content: row
            .try_get::<String, _>("content")
            .map_err(internal_business_error)?,
        attach_silver,
        attach_spirit_stones,
        attach_items,
        attach_rewards,
        has_attachments,
        has_claimable_attachments,
        read_at: to_iso_string(
            row.try_get::<Option<DateTime<Utc>>, _>("read_at")
                .unwrap_or(None),
        ),
        claimed_at: to_iso_string(
            row.try_get::<Option<DateTime<Utc>>, _>("claimed_at")
                .unwrap_or(None),
        ),
        expire_at: to_iso_string(
            row.try_get::<Option<DateTime<Utc>>, _>("expire_at")
                .unwrap_or(None),
        ),
        created_at: row
            .try_get::<DateTime<Utc>, _>("created_at")
            .map(|value| value.to_rfc3339())
            .map_err(internal_business_error)?,
    })
}

fn normalize_attach_items(raw: Option<Value>) -> Vec<MailAttachItemView> {
    raw.and_then(|value| serde_json::from_value::<Vec<MailAttachItemPayload>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let item_def_id = item.item_def_id.trim().to_string();
            let qty = item.qty.max(0);
            if item_def_id.is_empty() || qty <= 0 {
                return None;
            }
            Some(MailAttachItemView {
                item_def_id,
                item_name: item
                    .item_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                qty,
                options: normalize_attach_item_options(item.options),
            })
        })
        .collect()
}

fn normalize_attach_item_options(
    raw: Option<MailAttachItemOptionsPayload>,
) -> Option<MailAttachItemOptionsView> {
    let raw = raw?;
    Some(MailAttachItemOptionsView {
        bind_type: raw
            .bind_type
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        equip_options: raw.equip_options.and_then(normalize_json_object),
        metadata: raw.metadata.and_then(normalize_attach_item_metadata),
        quality: raw
            .quality
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        quality_rank: raw.quality_rank.map(|value| value.max(1)),
    })
}

fn normalize_json_object(value: Value) -> Option<Value> {
    match value {
        Value::Object(map) => Some(Value::Object(map)),
        _ => None,
    }
}

fn normalize_attach_item_metadata(value: Value) -> Option<Value> {
    let Value::Object(source) = value else {
        return None;
    };
    let mut entries = source
        .into_iter()
        .filter(|(_, field_value)| {
            matches!(
                field_value,
                Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
            )
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Some(Value::Object(entries.into_iter().collect()))
}

fn normalize_attach_instance_ids(raw: Option<Value>) -> Vec<i64> {
    match raw {
        Some(Value::Array(values)) => values
            .into_iter()
            .filter_map(|value| match value {
                Value::Number(number) => number.as_i64(),
                Value::String(text) => text.trim().parse::<i64>().ok(),
                _ => None,
            })
            .filter(|value| *value > 0)
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_metadata_attachment_preview_items(
    raw: Option<Value>,
) -> Vec<GrantedRewardPreviewView> {
    let Some(Value::Object(map)) = raw else {
        return Vec::new();
    };
    let Some(value) = map.get("attachmentPreviewItems").cloned() else {
        return Vec::new();
    };
    serde_json::from_value::<Vec<MailMetadataAttachmentPreviewItem>>(value)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let item_def_id = item.item_def_id.trim().to_string();
            let quantity = item.quantity.max(0);
            if item_def_id.is_empty() || quantity <= 0 {
                return None;
            }
            Some(GrantedRewardPreviewView::Item {
                item_def_id,
                quantity,
                item_name: item
                    .item_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                item_icon: None,
            })
        })
        .collect()
}

fn build_mail_counter_state(
    row: &sqlx::postgres::PgRow,
) -> Result<Option<MailCounterState>, BusinessError> {
    let recipient_user_id = row
        .try_get::<i64, _>("recipient_user_id")
        .map_err(internal_business_error)?;
    if recipient_user_id <= 0 {
        return Ok(None);
    }
    let attach_silver = row.try_get::<i64, _>("attach_silver").unwrap_or(0).max(0);
    let attach_spirit_stones = row
        .try_get::<i64, _>("attach_spirit_stones")
        .unwrap_or(0)
        .max(0);
    let attach_items = row
        .try_get::<Option<Value>, _>("attach_items")
        .unwrap_or(None);
    let attach_rewards = row
        .try_get::<Option<Value>, _>("attach_rewards")
        .unwrap_or(None);
    let attach_instance_ids = row
        .try_get::<Option<Value>, _>("attach_instance_ids")
        .unwrap_or(None);
    let is_unclaimed = row
        .try_get::<Option<DateTime<Utc>>, _>("claimed_at")
        .unwrap_or(None)
        .is_none()
        && has_mail_attachments(
            attach_silver,
            attach_spirit_stones,
            &attach_items,
            &attach_rewards,
            &attach_instance_ids,
        );
    Ok(Some(MailCounterState {
        recipient_user_id,
        recipient_character_id: row
            .try_get::<Option<i64>, _>("recipient_character_id")
            .unwrap_or(None),
        is_unread: row
            .try_get::<Option<DateTime<Utc>>, _>("read_at")
            .unwrap_or(None)
            .is_none(),
        is_unclaimed,
    }))
}

fn has_mail_attachments(
    attach_silver: i64,
    attach_spirit_stones: i64,
    attach_items: &Option<Value>,
    attach_rewards: &Option<Value>,
    attach_instance_ids: &Option<Value>,
) -> bool {
    attach_silver > 0
        || attach_spirit_stones > 0
        || attach_items.is_some()
        || attach_rewards.is_some()
        || attach_instance_ids.is_some()
}

fn build_mail_counter_read_delta(state: &MailCounterState) -> MailCounterDeltaInput {
    MailCounterDeltaInput {
        recipient_user_id: state.recipient_user_id,
        recipient_character_id: state.recipient_character_id,
        total_count_delta: 0,
        unread_count_delta: if state.is_unread { -1 } else { 0 },
        unclaimed_count_delta: 0,
    }
}

fn build_mail_counter_delete_delta(state: &MailCounterState) -> MailCounterDeltaInput {
    MailCounterDeltaInput {
        recipient_user_id: state.recipient_user_id,
        recipient_character_id: state.recipient_character_id,
        total_count_delta: -1,
        unread_count_delta: if state.is_unread { -1 } else { 0 },
        unclaimed_count_delta: if state.is_unclaimed { -1 } else { 0 },
    }
}

fn merge_mail_counter_deltas(inputs: &[MailCounterDeltaInput]) -> Vec<MailCounterScopeDelta> {
    let mut merged = HashMap::<String, MailCounterScopeDelta>::new();
    for input in inputs {
        let (scope_type, scope_id) = match input.recipient_character_id {
            Some(character_id) if character_id > 0 => ("character", character_id),
            _ if input.recipient_user_id > 0 => ("user", input.recipient_user_id),
            _ => continue,
        };
        if input.total_count_delta == 0
            && input.unread_count_delta == 0
            && input.unclaimed_count_delta == 0
        {
            continue;
        }
        let key = format!("{scope_type}:{scope_id}");
        let entry = merged.entry(key).or_insert(MailCounterScopeDelta {
            scope_type,
            scope_id,
            total_count_delta: 0,
            unread_count_delta: 0,
            unclaimed_count_delta: 0,
        });
        entry.total_count_delta += input.total_count_delta;
        entry.unread_count_delta += input.unread_count_delta;
        entry.unclaimed_count_delta += input.unclaimed_count_delta;
    }
    merged.into_values().collect()
}

fn build_recipient_scope_sql(
    character_id_param_index: usize,
    user_id_param_index: usize,
) -> String {
    format!(
        "(recipient_character_id = ${character_id_param_index} OR (recipient_user_id = ${user_id_param_index} AND recipient_character_id IS NULL))"
    )
}

fn build_recipient_scoped_mail_union_sql(
    select_sql: &str,
    character_id_param_index: usize,
    user_id_param_index: usize,
    common_where_sql: &[&str],
    order_by_sql: Option<&str>,
    limit_param_index: Option<usize>,
) -> String {
    let build_branch = |recipient_sql: String| {
        let mut where_parts = vec![recipient_sql];
        where_parts.extend(common_where_sql.iter().map(|value| (*value).to_string()));
        let mut sql = format!(
            "(
              SELECT {select_sql}
              FROM mail
              WHERE {}
            )",
            where_parts.join("\n                AND ")
        );
        if order_by_sql.is_some() || limit_param_index.is_some() {
            let mut suffix = String::new();
            if let Some(order_by_sql) = order_by_sql {
                suffix.push('\n');
                suffix.push_str("              ");
                suffix.push_str(order_by_sql);
            }
            if let Some(limit_param_index) = limit_param_index {
                suffix.push('\n');
                suffix.push_str(&format!("              LIMIT ${limit_param_index}"));
            }
            sql = format!(
                "(
                  SELECT {select_sql}
                  FROM mail
                  WHERE {}
                  {suffix}
                )",
                where_parts.join("\n                    AND ")
            );
        }
        sql
    };

    [
        build_branch(format!(
            "recipient_character_id = ${character_id_param_index}"
        )),
        build_branch(format!(
            "recipient_user_id = ${user_id_param_index}\n                    AND recipient_character_id IS NULL"
        )),
    ]
    .join("\n              UNION ALL\n")
}

fn to_iso_string(value: Option<DateTime<Utc>>) -> Option<String> {
    value.map(|value| value.to_rfc3339())
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
