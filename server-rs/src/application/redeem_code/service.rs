use std::{future::Future, pin::Pin};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::Row;

use crate::application::security::attempt_guard::{AttemptGuardPolicy, AttemptGuardService};
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::ServiceResultResponse;
use crate::edge::http::routes::redeem_code::{
    RedeemCodeRewardView, RedeemCodeRouteServices, RedeemCodeSuccessData,
};

const REDEEM_CODE_ATTEMPT_GUARD_POLICY: AttemptGuardPolicy = AttemptGuardPolicy {
    failure_window_ms: 15 * 60 * 1_000,
    block_window_ms: 15 * 60 * 1_000,
    subject_ip_failure_limit: 5,
    subject_failure_limit: 10,
    ip_failure_limit: 20,
    blocked_message: "兑换码尝试过于频繁，请15分钟后再试",
};

/**
 * 兑换码应用服务。
 *
 * 作用：
 * 1. 做什么：对齐 Node `/api/redeem-code/redeem` 的兑换、失败防爆破、奖励邮件入库与兑换状态更新语义。
 * 2. 做什么：把 reward payload 归一化、预览构建、邮件计数增量与事务提交收敛到单一入口，避免路由层散落 SQL。
 * 3. 不做什么：不处理爱发电 webhook 建码，不负责邮件领取，也不额外扩展客户端不存在的字段。
 *
 * 输入 / 输出：
 * - 输入：`user_id`、`character_id`、兑换码字符串、请求 IP。
 * - 输出：Node 兼容的 `sendResult` 数据结构；成功时返回 `{ code, rewards }`，失败时返回固定业务文案。
 *
 * 数据流 / 状态流：
 * - 路由层完成登录态与角色上下文校验 -> 本服务先校验尝试锁定
 * - -> 事务内锁定 `redeem_code` -> 写入奖励邮件与 `mail_counter`
 * - -> 更新兑换状态 -> 成功后清理尝试失败计数；业务失败则累计失败次数。
 *
 * 复用设计说明：
 * - 尝试防护直接复用共享 `AttemptGuardService`，登录与兑换码共用同一套 key 结构与锁定语义。
 * - 奖励预览与邮件写入在这里集中维护，后续若补 `mail` 路由或后台发奖链路，可继续复用相同的 payload 归一化结果。
 *
 * 关键边界条件与坑点：
 * 1. 兑换成功必须和邮件写入放在同一事务里，避免“码已标记兑换但奖励邮件没发出”的半成功状态。
 * 2. 只在真实业务失败时记录尝试次数；数据库异常要直接上抛 500，不能误把服务端故障记成用户爆破。
 */
#[derive(Clone)]
pub struct RustRedeemCodeRouteService {
    attempt_guard: AttemptGuardService,
    pool: sqlx::PgPool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GrantedRewardPayload {
    #[serde(default)]
    exp: Option<i64>,
    #[serde(default)]
    silver: Option<i64>,
    #[serde(rename = "spiritStones", alias = "spirit_stones", default)]
    spirit_stones: Option<i64>,
    #[serde(default)]
    items: Option<Vec<GrantedRewardItemPayload>>,
    #[serde(default)]
    techniques: Option<Vec<String>>,
    #[serde(default)]
    titles: Option<Vec<String>>,
    #[serde(rename = "unlockFeatures", alias = "unlock_features", default)]
    unlock_features: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GrantedRewardItemPayload {
    #[serde(rename = "itemDefId", alias = "item_def_id")]
    item_def_id: String,
    #[serde(alias = "qty")]
    quantity: i64,
    #[serde(rename = "itemName", alias = "item_name", default)]
    item_name: Option<String>,
    #[serde(rename = "itemIcon", alias = "item_icon", default)]
    item_icon: Option<String>,
}

#[derive(Debug, Clone)]
struct NormalizedGrantedRewardPayload {
    exp: i64,
    silver: i64,
    spirit_stones: i64,
    items: Vec<GrantedRewardItemPayload>,
    techniques: Vec<String>,
    titles: Vec<String>,
    unlock_features: Vec<String>,
}

impl RustRedeemCodeRouteService {
    pub fn new(pool: sqlx::PgPool, redis: redis::Client) -> Self {
        Self {
            attempt_guard: AttemptGuardService::new(redis),
            pool,
        }
    }

    async fn redeem_code_impl(
        &self,
        user_id: i64,
        character_id: i64,
        code: String,
        request_ip: String,
    ) -> Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError> {
        let normalized_code = normalize_redeem_code(&code);
        if normalized_code.is_empty() {
            return Ok(ServiceResultResponse::new(
                false,
                Some("兑换码不能为空".to_string()),
                None,
            ));
        }

        self.attempt_guard
            .assert_allowed(
                "redeem-code",
                &user_id.to_string(),
                &request_ip,
                REDEEM_CODE_ATTEMPT_GUARD_POLICY,
            )
            .await?;

        let redeem_result = self
            .execute_redeem_transaction(user_id, character_id, &normalized_code)
            .await;

        match redeem_result {
            Ok(result) => {
                if result.success {
                    self.attempt_guard
                        .clear_failures("redeem-code", &user_id.to_string(), &request_ip)
                        .await?;
                } else {
                    self.attempt_guard
                        .record_failure(
                            "redeem-code",
                            &user_id.to_string(),
                            &request_ip,
                            REDEEM_CODE_ATTEMPT_GUARD_POLICY,
                        )
                        .await?;
                }
                Ok(result)
            }
            Err(error) => Err(error),
        }
    }

    async fn execute_redeem_transaction(
        &self,
        user_id: i64,
        character_id: i64,
        normalized_code: &str,
    ) -> Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError> {
        let mut transaction = self.pool.begin().await.map_err(internal_business_error)?;
        let row = sqlx::query(
            r#"
            SELECT id, code, reward_payload, status
            FROM redeem_code
            WHERE code = $1
            LIMIT 1
            FOR UPDATE
            "#,
        )
        .bind(normalized_code)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        let Some(row) = row else {
            transaction
                .commit()
                .await
                .map_err(internal_business_error)?;
            return Ok(ServiceResultResponse::new(
                false,
                Some("兑换码不存在".to_string()),
                None,
            ));
        };

        let status = row.get::<String, _>("status");
        if status == "redeemed" {
            transaction
                .commit()
                .await
                .map_err(internal_business_error)?;
            return Ok(ServiceResultResponse::new(
                false,
                Some("兑换码已使用".to_string()),
                None,
            ));
        }

        let code = row.get::<String, _>("code");
        let reward_payload =
            normalize_reward_payload(row.try_get::<Value, _>("reward_payload").ok());
        let rewards = build_reward_preview(&reward_payload);
        let reward_payload_value = build_reward_payload_json(&reward_payload);
        let metadata = json!({
            "redeemCode": code.clone(),
            "grantRewardsInput": build_grant_rewards_input(&reward_payload),
        });

        let _mail_id = sqlx::query(
            r#"
            INSERT INTO mail (
              recipient_user_id,
              recipient_character_id,
              sender_type,
              sender_name,
              mail_type,
              title,
              content,
              attach_rewards,
              source,
              source_ref_id,
              metadata
            ) VALUES ($1, $2, 'system', '系统', 'reward', $3, $4, $5::jsonb, 'redeem_code', $6, $7::jsonb)
            RETURNING id
            "#,
        )
        .bind(user_id)
        .bind(character_id)
        .bind("兑换码奖励已送达")
        .bind(format!(
            "你已成功兑换兑换码 {}，奖励已通过系统邮件发放，请及时领取。",
            code
        ))
        .bind(reward_payload_value)
        .bind(&code)
        .bind(metadata)
        .fetch_one(&mut *transaction)
        .await
        .map_err(internal_business_error)?
        .get::<i64, _>("id");

        self.insert_mail_counter_delta(&mut transaction, character_id)
            .await?;

        sqlx::query(
            r#"
            UPDATE redeem_code
            SET status = 'redeemed',
                redeemed_by_user_id = $2,
                redeemed_by_character_id = $3,
                redeemed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(row.get::<i64, _>("id"))
        .bind(user_id)
        .bind(character_id)
        .execute(&mut *transaction)
        .await
        .map_err(internal_business_error)?;

        transaction
            .commit()
            .await
            .map_err(internal_business_error)?;

        Ok(ServiceResultResponse::new(
            true,
            Some("兑换成功，奖励已通过邮件发放".to_string()),
            Some(RedeemCodeSuccessData { code, rewards }),
        ))
    }

    async fn insert_mail_counter_delta(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        character_id: i64,
    ) -> Result<(), BusinessError> {
        sqlx::query(
            r#"
            INSERT INTO mail_counter (
              scope_type,
              scope_id,
              total_count,
              unread_count,
              unclaimed_count,
              updated_at
            ) VALUES ('character', $1, 1, 1, 1, NOW())
            ON CONFLICT (scope_type, scope_id) DO UPDATE SET
              total_count = GREATEST(mail_counter.total_count + 1, 0),
              unread_count = GREATEST(mail_counter.unread_count + 1, 0),
              unclaimed_count = GREATEST(mail_counter.unclaimed_count + 1, 0),
              updated_at = NOW()
            "#,
        )
        .bind(character_id)
        .execute(&mut **transaction)
        .await
        .map_err(internal_business_error)?;
        Ok(())
    }
}

impl RedeemCodeRouteServices for RustRedeemCodeRouteService {
    fn redeem_code<'a>(
        &'a self,
        user_id: i64,
        character_id: i64,
        code: String,
        request_ip: String,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<ServiceResultResponse<RedeemCodeSuccessData>, BusinessError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.redeem_code_impl(user_id, character_id, code, request_ip)
                .await
        })
    }
}

fn normalize_redeem_code(code: &str) -> String {
    code.trim().to_uppercase()
}

fn normalize_reward_payload(raw: Option<Value>) -> NormalizedGrantedRewardPayload {
    let parsed = raw
        .and_then(|value| serde_json::from_value::<GrantedRewardPayload>(value).ok())
        .unwrap_or(GrantedRewardPayload {
            exp: None,
            silver: None,
            spirit_stones: None,
            items: None,
            techniques: None,
            titles: None,
            unlock_features: None,
        });

    let items = parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let item_def_id = item.item_def_id.trim().to_string();
            let quantity = item.quantity.max(0);
            if item_def_id.is_empty() || quantity <= 0 {
                return None;
            }
            Some(GrantedRewardItemPayload {
                item_def_id,
                quantity,
                item_name: item
                    .item_name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                item_icon: item
                    .item_icon
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
            })
        })
        .collect::<Vec<_>>();

    NormalizedGrantedRewardPayload {
        exp: parsed.exp.unwrap_or(0).max(0),
        silver: parsed.silver.unwrap_or(0).max(0),
        spirit_stones: parsed.spirit_stones.unwrap_or(0).max(0),
        items,
        techniques: normalize_unique_strings(parsed.techniques.unwrap_or_default()),
        titles: normalize_unique_strings(parsed.titles.unwrap_or_default()),
        unlock_features: normalize_unique_strings(parsed.unlock_features.unwrap_or_default()),
    }
}

fn normalize_unique_strings(values: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::with_capacity(values.len());
    for value in values {
        let trimmed = value.trim().to_string();
        if trimmed.is_empty() || normalized.contains(&trimmed) {
            continue;
        }
        normalized.push(trimmed);
    }
    normalized
}

fn build_reward_preview(payload: &NormalizedGrantedRewardPayload) -> Vec<RedeemCodeRewardView> {
    let mut rewards = Vec::new();
    if payload.exp > 0 {
        rewards.push(RedeemCodeRewardView::Exp {
            amount: payload.exp,
        });
    }
    if payload.silver > 0 {
        rewards.push(RedeemCodeRewardView::Silver {
            amount: payload.silver,
        });
    }
    if payload.spirit_stones > 0 {
        rewards.push(RedeemCodeRewardView::SpiritStones {
            amount: payload.spirit_stones,
        });
    }
    for item in &payload.items {
        rewards.push(RedeemCodeRewardView::Item {
            item_def_id: item.item_def_id.clone(),
            quantity: item.quantity,
            item_name: item.item_name.clone(),
            item_icon: item.item_icon.clone(),
        });
    }
    for technique_id in &payload.techniques {
        rewards.push(RedeemCodeRewardView::Technique {
            technique_id: technique_id.clone(),
            technique_name: None,
            technique_icon: None,
        });
    }
    for title in &payload.titles {
        rewards.push(RedeemCodeRewardView::Title {
            title: title.clone(),
        });
    }
    for feature_code in &payload.unlock_features {
        rewards.push(RedeemCodeRewardView::FeatureUnlock {
            feature_code: feature_code.clone(),
        });
    }
    rewards
}

fn build_grant_rewards_input(payload: &NormalizedGrantedRewardPayload) -> Value {
    let mut map = serde_json::Map::new();
    if payload.exp > 0 {
        map.insert("exp".to_string(), Value::from(payload.exp));
    }
    if payload.silver > 0 {
        map.insert("silver".to_string(), Value::from(payload.silver));
    }
    if payload.spirit_stones > 0 {
        map.insert(
            "spirit_stones".to_string(),
            Value::from(payload.spirit_stones),
        );
    }
    if !payload.items.is_empty() {
        map.insert(
            "items".to_string(),
            Value::Array(
                payload
                    .items
                    .iter()
                    .map(|item| {
                        json!({
                            "item_def_id": item.item_def_id.clone(),
                            "quantity": item.quantity,
                        })
                    })
                    .collect(),
            ),
        );
    }
    if !payload.techniques.is_empty() {
        map.insert(
            "techniques".to_string(),
            Value::Array(
                payload
                    .techniques
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.titles.is_empty() {
        map.insert(
            "titles".to_string(),
            Value::Array(
                payload
                    .titles
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.unlock_features.is_empty() {
        map.insert(
            "unlock_features".to_string(),
            Value::Array(
                payload
                    .unlock_features
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

fn build_reward_payload_json(payload: &NormalizedGrantedRewardPayload) -> Value {
    let mut map = serde_json::Map::new();
    if payload.exp > 0 {
        map.insert("exp".to_string(), Value::from(payload.exp));
    }
    if payload.silver > 0 {
        map.insert("silver".to_string(), Value::from(payload.silver));
    }
    if payload.spirit_stones > 0 {
        map.insert(
            "spiritStones".to_string(),
            Value::from(payload.spirit_stones),
        );
    }
    if !payload.items.is_empty() {
        map.insert(
            "items".to_string(),
            Value::Array(
                payload
                    .items
                    .iter()
                    .map(|item| {
                        json!({
                            "itemDefId": item.item_def_id.clone(),
                            "quantity": item.quantity,
                            "itemName": item.item_name.clone(),
                            "itemIcon": item.item_icon.clone(),
                        })
                    })
                    .collect(),
            ),
        );
    }
    if !payload.techniques.is_empty() {
        map.insert(
            "techniques".to_string(),
            Value::Array(
                payload
                    .techniques
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.titles.is_empty() {
        map.insert(
            "titles".to_string(),
            Value::Array(
                payload
                    .titles
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    if !payload.unlock_features.is_empty() {
        map.insert(
            "unlockFeatures".to_string(),
            Value::Array(
                payload
                    .unlock_features
                    .iter()
                    .map(|value| Value::from(value.clone()))
                    .collect(),
            ),
        );
    }
    Value::Object(map)
}

fn internal_business_error<E>(_error: E) -> BusinessError {
    BusinessError::with_status("服务器错误", axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}
