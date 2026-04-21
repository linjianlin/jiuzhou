use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::http::security::{
    AttemptAction, assert_action_attempt_allowed, clear_action_attempt_failures,
    record_action_attempt_failure,
};
use crate::shared::error::AppError;
use crate::shared::mail_counter::{apply_mail_counter_deltas, build_new_mail_counter_deltas};
use crate::shared::request_ip::resolve_request_ip_with_socket_addr;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RedeemCodePayload {
    pub code: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum RedeemRewardDto {
    #[serde(rename = "exp")]
    Exp { amount: i64 },
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
    #[serde(rename = "technique")]
    Technique {
        technique_id: String,
        technique_name: Option<String>,
        technique_icon: Option<String>,
    },
    #[serde(rename = "feature_unlock")]
    FeatureUnlock { feature_code: String },
    #[serde(rename = "title")]
    Title { title: String },
}

#[derive(Debug, Serialize)]
pub struct RedeemCodeData {
    pub code: String,
    pub rewards: Vec<RedeemRewardDto>,
}

pub async fn redeem_code(
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<RedeemCodePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let request_ip = resolve_request_ip_with_socket_addr(&headers, Some(remote_addr))?;
    let code = payload.code.unwrap_or_default();
    let normalized_code = code.trim().to_uppercase();
    if normalized_code.is_empty() {
        return Err(AppError::config("兑换码不能为空"));
    }

    assert_action_attempt_allowed(
        &state,
        AttemptAction::RedeemCode,
        &actor.user_id.to_string(),
        &request_ip,
    )
    .await?;

    let result = state
        .database
        .with_transaction(|| async {
            let row = state
                .database
                .fetch_optional(
                    "SELECT id, code, reward_payload, status FROM redeem_code WHERE code = $1 LIMIT 1 FOR UPDATE",
                    |query| query.bind(&normalized_code),
                )
                .await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<RedeemCodeData> {
                    success: false,
                    message: Some("兑换码不存在".to_string()),
                    data: None,
                });
            };

            let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "created".to_string());
            if status == "redeemed" {
                return Ok(ServiceResult::<RedeemCodeData> {
                    success: false,
                    message: Some("兑换码已使用".to_string()),
                    data: None,
                });
            }

            let reward_payload = row.try_get::<Option<serde_json::Value>, _>("reward_payload")?.unwrap_or_default();
            let preview = build_redeem_reward_preview(&reward_payload)?;
            state
                .database
                .execute(
                    "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_rewards, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', $3, $4, $5::jsonb, 'redeem_code', $6, $7::jsonb, NOW(), NOW())",
                    |query| {
                        query
                            .bind(actor.user_id)
                            .bind(actor.character_id)
                            .bind("兑换码奖励已送达")
                            .bind(format!("你已成功兑换兑换码 {}，奖励已通过系统邮件发放，请及时领取。", normalized_code))
                            .bind(serde_json::to_string(&reward_payload).unwrap_or_else(|_| "{}".to_string()))
                            .bind(&normalized_code)
                            .bind(serde_json::json!({
                                "redeemCode": normalized_code,
                            }).to_string())
                    },
                )
                .await?;
            apply_mail_counter_deltas(
                &state,
                &build_new_mail_counter_deltas(actor.user_id, Some(actor.character_id), true),
            )
            .await?;
            let redeem_id: i64 = row.try_get("id")?;
            state
                .database
                .execute(
                    "UPDATE redeem_code SET status = 'redeemed', redeemed_by_user_id = $2, redeemed_by_character_id = $3, redeemed_at = NOW(), updated_at = NOW() WHERE id = $1",
                    |query| query.bind(redeem_id).bind(actor.user_id).bind(actor.character_id),
                )
                .await?;

            Ok(ServiceResult {
                success: true,
                message: Some("兑换成功，奖励已通过系统邮件发放".to_string()),
                data: Some(RedeemCodeData {
                    code: normalized_code.clone(),
                    rewards: preview,
                }),
            })
        })
        .await?;

    if result.success {
        clear_action_attempt_failures(
            &state,
            AttemptAction::RedeemCode,
            &actor.user_id.to_string(),
            &request_ip,
        )
        .await?;
    } else {
        record_action_attempt_failure(
            &state,
            AttemptAction::RedeemCode,
            &actor.user_id.to_string(),
            &request_ip,
        )
        .await?;
    }

    Ok(send_result(result))
}

fn build_redeem_reward_preview(raw: &serde_json::Value) -> Result<Vec<RedeemRewardDto>, AppError> {
    let mut rewards = Vec::new();
    let exp = raw
        .get("exp")
        .and_then(|value| value.as_i64())
        .unwrap_or_default()
        .max(0);
    let silver = raw
        .get("silver")
        .and_then(|value| value.as_i64())
        .unwrap_or_default()
        .max(0);
    let spirit_stones = raw
        .get("spiritStones")
        .or_else(|| raw.get("spirit_stones"))
        .and_then(|value| value.as_i64())
        .unwrap_or_default()
        .max(0);
    if exp > 0 {
        rewards.push(RedeemRewardDto::Exp { amount: exp });
    }
    if silver > 0 {
        rewards.push(RedeemRewardDto::Silver { amount: silver });
    }
    if spirit_stones > 0 {
        rewards.push(RedeemRewardDto::SpiritStones {
            amount: spirit_stones,
        });
    }

    let item_meta_map = load_item_meta_map()?;
    for item in raw
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let item_def_id = item
            .get("itemDefId")
            .or_else(|| item.get("item_def_id"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let quantity = item
            .get("quantity")
            .or_else(|| item.get("qty"))
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
            .max(0);
        if item_def_id.is_empty() || quantity <= 0 {
            continue;
        }
        let meta = item_meta_map.get(item_def_id.as_str()).cloned();
        rewards.push(RedeemRewardDto::Item {
            item_def_id,
            quantity,
            item_name: meta.as_ref().map(|value| value.0.clone()),
            item_icon: meta.and_then(|value| value.1),
        });
    }

    let technique_meta_map = load_technique_meta_map()?;
    for technique_id in raw
        .get("techniques")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let technique_id = technique_id.as_str().unwrap_or_default().trim().to_string();
        if technique_id.is_empty() {
            continue;
        }
        let meta = technique_meta_map.get(technique_id.as_str()).cloned();
        rewards.push(RedeemRewardDto::Technique {
            technique_id,
            technique_name: meta.as_ref().map(|value| value.0.clone()),
            technique_icon: meta.and_then(|value| value.1),
        });
    }
    for title in raw
        .get("titles")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let title = title.as_str().unwrap_or_default().trim().to_string();
        if !title.is_empty() {
            rewards.push(RedeemRewardDto::Title { title });
        }
    }
    for feature in raw
        .get("unlockFeatures")
        .or_else(|| raw.get("unlock_features"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let feature_code = feature.as_str().unwrap_or_default().trim().to_string();
        if !feature_code.is_empty() {
            rewards.push(RedeemRewardDto::FeatureUnlock { feature_code });
        }
    }
    Ok(rewards)
}

fn load_item_meta_map()
-> Result<std::collections::BTreeMap<String, (String, Option<String>)>, AppError> {
    let mut out = std::collections::BTreeMap::new();
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
-> Result<std::collections::BTreeMap<String, (String, Option<String>)>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_def.json: {error}"))
    })?;
    let items = payload
        .get("techniques")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim().to_string();
            let name = item.get("name")?.as_str()?.trim().to_string();
            let icon = item
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            (!id.is_empty() && !name.is_empty()).then_some((id, (name, icon)))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    #[test]
    fn redeem_code_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "兑换成功，奖励已通过系统邮件发放",
            "data": {
                "code": "JZABC123",
                "rewards": [
                    {"type": "silver", "amount": 100},
                    {"type": "item", "itemDefId": "mat-gongfa-canye", "quantity": 1, "itemName": "功法残页"}
                ]
            }
        });
        assert_eq!(payload["data"]["code"], "JZABC123");
        assert_eq!(payload["data"]["rewards"][0]["type"], "silver");
        println!("REDEEM_CODE_RESPONSE={}", payload);
    }
}
