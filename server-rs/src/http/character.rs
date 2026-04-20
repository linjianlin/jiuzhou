use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use crate::auth;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDto {
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
pub struct CharacterEnvelope {
    pub character: Option<CharacterDto>,
    pub has_character: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateCharacterPayload {
    pub nickname: Option<String>,
    pub gender: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePositionPayload {
    pub current_map_id: Option<String>,
    pub current_room_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TogglePayload {
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoDisassembleRuleDto {
    pub categories: Option<Vec<String>>,
    pub sub_categories: Option<Vec<String>>,
    pub excluded_sub_categories: Option<Vec<String>>,
    pub include_name_keywords: Option<Vec<String>>,
    pub exclude_name_keywords: Option<Vec<String>>,
    pub max_quality_rank: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAutoDisassemblePayload {
    pub enabled: Option<bool>,
    pub rules: Option<Vec<AutoDisassembleRuleDto>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWithCardPayload {
    pub item_instance_id: Option<i64>,
    pub nickname: Option<String>,
}

pub async fn check(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let character = load_character_by_user_id(&state, user.user_id).await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some(if character.is_some() {
            "已有角色".to_string()
        } else {
            "未创建角色".to_string()
        }),
        data: Some(CharacterEnvelope {
            has_character: character.is_some(),
            character,
        }),
    }))
}

pub async fn info(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let character = load_character_by_user_id(&state, user.user_id).await?;

    if let Some(character) = character {
        return Ok(send_result(ServiceResult {
            success: true,
            message: Some("获取成功".to_string()),
            data: Some(CharacterEnvelope {
                has_character: true,
                character: Some(character),
            }),
        }));
    }

    Ok(send_result(ServiceResult::<CharacterEnvelope> {
        success: false,
        message: Some("角色不存在".to_string()),
        data: None,
    }))
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateCharacterPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let nickname = payload.nickname.unwrap_or_default().trim().to_string();
    let gender = payload.gender.unwrap_or_default();

    if nickname.is_empty() || gender.is_empty() {
        return Err(AppError::config("道号和性别不能为空"));
    }
    if gender != "male" && gender != "female" {
        return Err(AppError::config("性别参数错误"));
    }

    let existing = state
        .database
        .fetch_optional(
            "SELECT id FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(user.user_id),
        )
        .await?;
    if existing.is_some() {
        return Ok(send_result(ServiceResult::<CharacterEnvelope> {
            success: false,
            message: Some("已存在角色，无法重复创建".to_string()),
            data: None,
        }));
    }

    state
        .database
        .fetch_one(
            "INSERT INTO characters (user_id, nickname, gender, title, spirit_stones, silver, realm, exp, attribute_points, jing, qi, shen, attribute_type, attribute_element, current_map_id, current_room_id) VALUES ($1, $2, $3, '散修', 0, 0, '凡人', 0, 0, 0, 0, 0, 'physical', 'none', 'map-qingyun-village', 'room-village-center') RETURNING id",
            |query| query.bind(user.user_id).bind(&nickname).bind(&gender),
        )
        .await?;

    let character = load_character_by_user_id(&state, user.user_id)
        .await?
        .ok_or_else(|| AppError::config("角色创建成功，但读取角色数据失败"))?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("角色创建成功".to_string()),
        data: Some(CharacterEnvelope {
            has_character: true,
            character: Some(character),
        }),
    }))
}

pub async fn update_position(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdatePositionPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let map_id = payload.current_map_id.unwrap_or_default().trim().to_string();
    let room_id = payload.current_room_id.unwrap_or_default().trim().to_string();
    if map_id.is_empty() || room_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("位置参数不能为空".to_string()),
            data: None,
        }));
    }
    if map_id.len() > 64 || room_id.len() > 64 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("位置参数过长".to_string()),
            data: None,
        }));
    }
    let updated = state
        .database
        .execute(
            "UPDATE characters SET current_map_id = $1, current_room_id = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3",
            |query| query.bind(&map_id).bind(&room_id).bind(user.user_id),
        )
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("位置更新成功".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

pub async fn update_auto_cast_skills(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TogglePayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let enabled = payload.enabled.unwrap_or(false);
    let updated = state
        .database
        .execute(
            "UPDATE characters SET auto_cast_skills = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            |query| query.bind(enabled).bind(user.user_id),
        )
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("设置已保存".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

pub async fn update_auto_disassemble(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<UpdateAutoDisassemblePayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let enabled = payload.enabled.unwrap_or(false);
    let normalized_rules = normalize_auto_disassemble_rules(payload.rules);
    let rules_json = serde_json::to_string(&normalized_rules)
        .map_err(|error| AppError::config(format!("failed to serialize auto disassemble rules: {error}")))?;
    let updated = state
        .database
        .execute(
            "UPDATE characters SET auto_disassemble_enabled = $1, auto_disassemble_rules = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE user_id = $3",
            |query| query.bind(enabled).bind(rules_json).bind(user.user_id),
        )
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("设置已保存".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

pub async fn update_dungeon_no_stamina_cost(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TogglePayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let enabled = payload.enabled.unwrap_or(false);
    let updated = state
        .database
        .execute(
            "UPDATE characters SET dungeon_no_stamina_cost = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
            |query| query.bind(enabled).bind(user.user_id),
        )
        .await?;
    if updated.rows_affected() == 0 {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    }
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("设置已保存".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

pub async fn rename_with_card(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RenameWithCardPayload>,
) -> Result<axum::response::Response, AppError> {
    let user = auth::require_auth(&state, &headers).await?;
    let item_instance_id = payload.item_instance_id.unwrap_or_default();
    let nickname = payload.nickname.unwrap_or_default();

    if item_instance_id <= 0 {
        return Err(AppError::config("itemInstanceId参数错误"));
    }
    let normalized_nickname = normalize_character_nickname_input(&nickname);
    if normalized_nickname.is_empty() {
        return Err(AppError::config("道号不能为空"));
    }

    let result = state
        .database
        .with_transaction(|| async {
            let row = state
                .database
                .fetch_optional(
                    "SELECT id, nickname FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE",
                    |query| query.bind(user.user_id),
                )
                .await?;
            let Some(row) = row else {
                return Ok(ServiceResult::<serde_json::Value> {
                    success: false,
                    message: Some("角色不存在".to_string()),
                    data: None,
                });
            };
            let character_id = i64::from(row.try_get::<i32, _>("id")?);
            rename_character_with_card_tx(&state, character_id, item_instance_id, &normalized_nickname).await
        })
        .await?;

    Ok(send_result(result))
}

pub(crate) async fn rename_character_with_card_tx(
    state: &AppState,
    character_id: i64,
    item_instance_id: i64,
    nickname: &str,
) -> Result<ServiceResult<serde_json::Value>, AppError> {
    let normalized_nickname = normalize_character_nickname_input(nickname);
    let character_row = state
        .database
        .fetch_optional(
            "SELECT nickname FROM characters WHERE id = $1 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(_character_row) = character_row else {
        return Ok(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        });
    };

    let validation_error = validate_character_nickname(
        state,
        &normalized_nickname,
        Some(character_id),
    )
    .await?;
    if let Some(message) = validation_error {
        return Ok(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some(message),
            data: None,
        });
    }

    let item_row = state
        .database
        .fetch_optional(
            "SELECT id, qty, item_def_id FROM item_instance WHERE id = $1 AND owner_character_id = $2 FOR UPDATE",
            |query| query.bind(item_instance_id).bind(character_id),
        )
        .await?;
    let Some(item_row) = item_row else {
        return Ok(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("易名符不存在".to_string()),
            data: None,
        });
    };
    let item_def_id: String = item_row.try_get::<Option<String>, _>("item_def_id")?.unwrap_or_default();
    if !is_rename_card_item_definition(&item_def_id)? {
        return Ok(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("该物品不能用于改名".to_string()),
            data: None,
        });
    }
    let qty: i64 = item_row.try_get::<Option<i32>, _>("qty")?.map(i64::from).unwrap_or_default();
    if qty <= 0 {
        return Ok(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("易名符数量不足".to_string()),
            data: None,
        });
    }

    if qty == 1 {
        state
            .database
            .execute(
                "DELETE FROM item_instance WHERE id = $1",
                |query| query.bind(item_instance_id),
            )
            .await?;
    } else {
        state
            .database
            .execute(
                "UPDATE item_instance SET qty = qty - 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
                |query| query.bind(item_instance_id),
            )
            .await?;
    }

    state
        .database
        .execute(
            "UPDATE characters SET nickname = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
            |query| query.bind(&normalized_nickname).bind(character_id),
        )
        .await?;

    Ok(ServiceResult {
        success: true,
        message: Some("改名成功".to_string()),
        data: Some(serde_json::json!({})),
    })
}

fn normalize_auto_disassemble_rules(raw: Option<Vec<AutoDisassembleRuleDto>>) -> Vec<serde_json::Value> {
    let rows = raw.unwrap_or_default();
    if rows.is_empty() {
        return vec![default_auto_disassemble_rule()];
    }
    let mut normalized = Vec::new();
    for row in rows.into_iter().take(20) {
        normalized.push(serde_json::json!({
            "categories": normalize_token_list(row.categories, true),
            "subCategories": normalize_token_list(row.sub_categories, false),
            "excludedSubCategories": normalize_token_list(row.excluded_sub_categories, false),
            "includeNameKeywords": normalize_token_list(row.include_name_keywords, false),
            "excludeNameKeywords": normalize_token_list(row.exclude_name_keywords, false),
            "maxQualityRank": clamp_quality_rank(row.max_quality_rank.unwrap_or(1)),
        }));
    }
    if normalized.is_empty() {
        vec![default_auto_disassemble_rule()]
    } else {
        normalized
    }
}

fn default_auto_disassemble_rule() -> serde_json::Value {
    serde_json::json!({
        "categories": ["equipment"],
        "subCategories": [],
        "excludedSubCategories": [],
        "includeNameKeywords": [],
        "excludeNameKeywords": [],
        "maxQualityRank": 1,
    })
}

fn normalize_token_list(raw: Option<Vec<String>>, default_equipment: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for item in raw.unwrap_or_default().into_iter().take(100) {
        let token = item.trim().to_lowercase();
        if token.is_empty() || !seen.insert(token.clone()) {
            continue;
        }
        out.push(token);
    }
    if out.is_empty() && default_equipment {
        vec!["equipment".to_string()]
    } else {
        out
    }
}

fn clamp_quality_rank(raw: i64) -> i64 {
    raw.clamp(1, 4)
}

fn normalize_character_nickname_input(nickname: &str) -> String {
    nickname.trim().to_string()
}

async fn validate_character_nickname(
    state: &AppState,
    nickname: &str,
    exclude_character_id: Option<i64>,
) -> Result<Option<String>, AppError> {
    let length = nickname.chars().count();
    if length < 2 || length > 12 {
        return Ok(Some("道号需2-12个字符".to_string()));
    }
    if local_sensitive_words_contain(nickname)? {
        return Ok(Some("道号包含敏感词，请重新输入".to_string()));
    }

    let duplicate = if let Some(character_id) = exclude_character_id {
        state
            .database
            .fetch_optional(
                "SELECT id FROM characters WHERE nickname = $1 AND id <> $2 LIMIT 1",
                |query| query.bind(nickname).bind(character_id),
            )
            .await?
    } else {
        state
            .database
            .fetch_optional(
                "SELECT id FROM characters WHERE nickname = $1 LIMIT 1",
                |query| query.bind(nickname),
            )
            .await?
    };
    if duplicate.is_some() {
        return Ok(Some("该道号已被使用".to_string()));
    }

    Ok(None)
}

pub(crate) fn local_sensitive_words_contain(content: &str) -> Result<bool, AppError> {
    let content = content.trim().to_lowercase();
    if content.is_empty() {
        return Ok(false);
    }
    Ok(load_local_sensitive_words()?
        .into_iter()
        .any(|word| !word.is_empty() && content.contains(&word)))
}

fn load_local_sensitive_words() -> Result<BTreeSet<String>, AppError> {
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/technique_name_sensitive_words.json"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/data/seeds/technique_name_sensitive_words.json"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dist/data/seeds/technique_name_sensitive_words.json"),
    ];
    let Some(path) = candidates.into_iter().find(|path| path.exists()) else {
        return Ok(BTreeSet::new());
    };
    let content = fs::read_to_string(path)
        .map_err(|error| AppError::config(format!("failed to read local sensitive words: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse local sensitive words: {error}")))?;
    let words = payload
        .get("words")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(words
        .into_iter()
        .filter_map(|value| value.as_str().map(|value| value.trim().to_lowercase()))
        .filter(|value| !value.is_empty())
        .collect())
}

fn is_rename_card_item_definition(item_def_id: &str) -> Result<bool, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/item_def.json"))
        .map_err(|error| AppError::config(format!("failed to read item_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse item_def.json: {error}")))?;
    let items = payload
        .get("items")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for item in items {
        if item.get("id").and_then(|value| value.as_str()).map(str::trim) != Some(item_def_id) {
            continue;
        }
        let effects = item
            .get("effect_defs")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        return Ok(effects.into_iter().any(|effect| {
            effect
                .get("effect_type")
                .and_then(|value| value.as_str())
                .map(str::trim)
                == Some("rename_character")
        }));
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    #[test]
    fn update_position_success_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "位置更新成功",
            "data": {}
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["message"], "位置更新成功");
        println!("CHARACTER_UPDATE_POSITION_RESPONSE={}", payload);
    }

    #[test]
    fn rename_with_card_success_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "改名成功",
            "data": {}
        });
        assert_eq!(payload["success"], true);
        assert_eq!(payload["message"], "改名成功");
        println!("CHARACTER_RENAME_WITH_CARD_RESPONSE={}", payload);
    }
}

async fn load_character_by_user_id(
    state: &AppState,
    user_id: i64,
) -> Result<Option<CharacterDto>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT id, nickname, gender, title, realm, sub_realm, spirit_stones, silver, COALESCE(jing, 0)::bigint AS qixue, COALESCE(jing, 0)::bigint AS max_qixue, 0::bigint AS wugong, 0::bigint AS wufang FROM characters WHERE user_id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?;

    row.map(|row| {
        Ok(CharacterDto {
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
