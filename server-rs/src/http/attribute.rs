use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::Deserialize;
use sqlx::Row;
use tracing::warn;

use crate::auth;
use crate::realtime::public_socket::emit_game_character_full_to_user;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct AttributeMutationPayload {
    pub attribute: Option<String>,
    pub amount: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct AttributeBatchPayload {
    pub jing: Option<i64>,
    pub qi: Option<i64>,
    pub shen: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttributeMutationData {
    pub attribute: String,
    pub new_value: i64,
    pub remaining_points: i64,
}

fn required_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<i64, AppError> {
    row.try_get::<i32, _>(column)
        .map(i64::from)
        .map_err(AppError::from)
}

pub async fn add(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AttributeMutationPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let attribute = payload.attribute.unwrap_or_default();
    let amount = payload.amount.unwrap_or(1);
    if attribute.trim().is_empty() {
        return Err(AppError::config("请指定属性类型"));
    }
    let result = add_attribute_point(&state, user.user_id, attribute.trim(), amount).await?;
    emit_attribute_character_refresh_if_success(&state, user.user_id, result.success, "add").await;
    Ok(send_result(result))
}

pub async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AttributeMutationPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let attribute = payload.attribute.unwrap_or_default();
    let amount = payload.amount.unwrap_or(1);
    if attribute.trim().is_empty() {
        return Err(AppError::config("请指定属性类型"));
    }
    let result = remove_attribute_point(&state, user.user_id, attribute.trim(), amount).await?;
    emit_attribute_character_refresh_if_success(&state, user.user_id, result.success, "remove").await;
    Ok(send_result(result))
}

pub async fn batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AttributeBatchPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let result = batch_add_points(&state, user.user_id, payload).await?;
    emit_attribute_character_refresh_if_success(&state, user.user_id, result.success, "batch").await;
    Ok(send_result(result))
}

pub async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let result = reset_attribute_points(&state, user.user_id).await?;
    emit_attribute_character_refresh_if_success(&state, user.user_id, result.success, "reset").await;
    Ok(send_result(result))
}

async fn emit_attribute_character_refresh_if_success(
    state: &AppState,
    user_id: i64,
    success: bool,
    action: &str,
) {
    if !success {
        return;
    }
    if let Err(error) = emit_game_character_full_to_user(state, user_id).await {
        warn!(user_id, action, error = %error, "failed to emit game:character after attribute mutation");
    }
}

async fn add_attribute_point(
    state: &AppState,
    user_id: i64,
    attribute: &str,
    amount: i64,
) -> Result<ServiceResult<AttributeMutationData>, AppError> {
    if !matches!(attribute, "jing" | "qi" | "shen") {
        return Ok(failure("无效的属性类型"));
    }
    if !(1..=100).contains(&amount) {
        return Ok(failure("加点数量无效"));
    }
    run_single_attribute_mutation(state, user_id, attribute, amount, true).await
}

async fn remove_attribute_point(
    state: &AppState,
    user_id: i64,
    attribute: &str,
    amount: i64,
) -> Result<ServiceResult<AttributeMutationData>, AppError> {
    if !matches!(attribute, "jing" | "qi" | "shen") {
        return Ok(failure("无效的属性类型"));
    }
    if !(1..=100).contains(&amount) {
        return Ok(failure("减点数量无效"));
    }
    run_single_attribute_mutation(state, user_id, attribute, amount, false).await
}

async fn run_single_attribute_mutation(
    state: &AppState,
    user_id: i64,
    attribute: &str,
    amount: i64,
    add_mode: bool,
) -> Result<ServiceResult<AttributeMutationData>, AppError> {
    let guard_sql = if add_mode {
        "characters.attribute_points >= $2".to_string()
    } else {
        format!("characters.{attribute} >= $2")
    };
    let attribute_mutation_sql = if add_mode {
        format!("{attribute} = {attribute} + $2")
    } else {
        format!("{attribute} = {attribute} - $2")
    };
    let point_mutation_sql = if add_mode {
        "attribute_points = attribute_points - $2"
    } else {
        "attribute_points = attribute_points + $2"
    };
    let sql = format!(
        "WITH target_character AS ( SELECT id FROM characters WHERE user_id = $1 LIMIT 1 ), updated_character AS ( UPDATE characters SET {attribute_mutation_sql}, {point_mutation_sql}, updated_at = CURRENT_TIMESTAMP FROM target_character WHERE characters.id = target_character.id AND {guard_sql} RETURNING characters.{attribute} AS new_value, characters.attribute_points AS remaining_points ) SELECT COALESCE((SELECT id FROM target_character), 0) AS character_id, EXISTS(SELECT 1 FROM target_character) AS character_exists, EXISTS(SELECT 1 FROM updated_character) AS updated, (SELECT new_value FROM updated_character) AS new_value, (SELECT remaining_points FROM updated_character) AS remaining_points"
    );
    let row = state
        .database
        .fetch_one(&sql, |query| query.bind(user_id).bind(amount))
        .await?;
    let character_exists: bool = row.try_get("character_exists")?;
    let updated: bool = row.try_get("updated")?;
    if !character_exists {
        return Ok(failure("角色不存在"));
    }
    if !updated {
        return Ok(failure(if add_mode { "属性点不足" } else { "属性点不足以减少" }));
    }
    Ok(success(
        if add_mode { "加点成功" } else { "减点成功" },
        AttributeMutationData {
            attribute: attribute.to_string(),
            new_value: required_i64_from_i32(&row, "new_value")?,
            remaining_points: required_i64_from_i32(&row, "remaining_points")?,
        },
    ))
}

async fn batch_add_points(
    state: &AppState,
    user_id: i64,
    payload: AttributeBatchPayload,
) -> Result<ServiceResult<AttributeMutationData>, AppError> {
    let jing = payload.jing.unwrap_or(0);
    let qi = payload.qi.unwrap_or(0);
    let shen = payload.shen.unwrap_or(0);
    let total = jing + qi + shen;
    if total <= 0 {
        return Ok(failure("请指定加点数量"));
    }

    let row = state.database.fetch_one(
        "WITH target_character AS ( SELECT id FROM characters WHERE user_id = $1 LIMIT 1 ), updated_character AS ( UPDATE characters SET jing = jing + $2, qi = qi + $3, shen = shen + $4, attribute_points = attribute_points - $5, updated_at = CURRENT_TIMESTAMP FROM target_character WHERE characters.id = target_character.id AND characters.attribute_points >= $5 RETURNING characters.jing AS jing, characters.qi AS qi, characters.shen AS shen, characters.attribute_points AS remaining_points ) SELECT COALESCE((SELECT id FROM target_character), 0) AS character_id, EXISTS(SELECT 1 FROM target_character) AS character_exists, EXISTS(SELECT 1 FROM updated_character) AS updated, (SELECT jing FROM updated_character) AS jing, (SELECT qi FROM updated_character) AS qi, (SELECT shen FROM updated_character) AS shen, (SELECT remaining_points FROM updated_character) AS remaining_points",
        |query| query.bind(user_id).bind(jing).bind(qi).bind(shen).bind(total),
    ).await?;
    let character_exists: bool = row.try_get("character_exists")?;
    let updated: bool = row.try_get("updated")?;
    if !character_exists {
        return Ok(failure("角色不存在"));
    }
    if !updated {
        return Ok(failure("属性点不足"));
    }
    Ok(success(
        "批量加点成功",
        AttributeMutationData {
            attribute: "jing".to_string(),
            new_value: required_i64_from_i32(&row, "jing")?,
            remaining_points: required_i64_from_i32(&row, "remaining_points")?,
        },
    ))
}

async fn reset_attribute_points(
    state: &AppState,
    user_id: i64,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let row = state.database.fetch_one(
        "WITH target_character AS ( SELECT id, jing, qi, shen FROM characters WHERE user_id = $1 LIMIT 1 ), updated_character AS ( UPDATE characters SET jing = 0, qi = 0, shen = 0, attribute_points = attribute_points + target_character.jing + target_character.qi + target_character.shen, updated_at = CURRENT_TIMESTAMP FROM target_character WHERE characters.id = target_character.id RETURNING target_character.jing + target_character.qi + target_character.shen AS refunded_points ) SELECT COALESCE((SELECT id FROM target_character), 0) AS character_id, EXISTS(SELECT 1 FROM target_character) AS character_exists, EXISTS(SELECT 1 FROM updated_character) AS updated, (SELECT refunded_points FROM updated_character) AS refunded_points",
        |query| query.bind(user_id),
    ).await?;
    let character_exists: bool = row.try_get("character_exists")?;
    let updated: bool = row.try_get("updated")?;
    if !character_exists {
        return Ok(ServiceResult { success: false, message: Some("角色不存在".to_string()), data: None });
    }
    if !updated {
        return Ok(ServiceResult { success: false, message: Some("重置失败".to_string()), data: None });
    }
    Ok(ServiceResult {
        success: true,
        message: Some("属性点已重置".to_string()),
        data: Some(serde_json::json!({"totalPoints": required_i64_from_i32(&row, "refunded_points")?})),
    })
}

fn failure<T>(message: &str) -> ServiceResult<T> {
    ServiceResult { success: false, message: Some(message.to_string()), data: None }
}

fn success<T: serde::Serialize>(message: &str, data: T) -> ServiceResult<T> {
    ServiceResult { success: true, message: Some(message.to_string()), data: Some(data) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_rejects_invalid_attribute() {
        let result = failure::<AttributeMutationData>("无效的属性类型");
        assert!(!result.success);
        assert_eq!(result.message.as_deref(), Some("无效的属性类型"));
    }

    #[test]
    fn success_payload_preserves_existing_batch_contract_shape() {
        let result = success(
            "批量加点成功",
            AttributeMutationData {
                attribute: "jing".to_string(),
                new_value: 12,
                remaining_points: 3,
            },
        );
        let payload = serde_json::to_value(&result).expect("result should serialize");
        assert_eq!(payload["data"]["attribute"], "jing");
        assert_eq!(payload["data"]["newValue"], 12);
        assert_eq!(payload["data"]["remainingPoints"], 3);
        println!("ATTRIBUTE_BATCH_RESPONSE={}", payload);
    }

    #[test]
    fn invalid_attribute_failure_payload_matches_contract() {
        let result = failure::<AttributeMutationData>("无效的属性类型");
        let payload = serde_json::to_value(&result).expect("result should serialize");
        assert_eq!(payload["success"], false);
        assert_eq!(payload["message"], "无效的属性类型");
        println!("ATTRIBUTE_INVALID_RESPONSE={}", payload);
    }
}
