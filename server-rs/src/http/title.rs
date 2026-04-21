use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EquipTitlePayload {
    pub title_id: Option<String>,
    pub title_id_legacy: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleInfoDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub effects: BTreeMap<String, f64>,
    pub is_equipped: bool,
    pub obtained_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TitleListData {
    pub titles: Vec<TitleInfoDto>,
    pub equipped: String,
}

#[derive(Debug, Deserialize)]
struct TitleDefinitionFile {
    titles: Vec<TitleDefinitionSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct TitleDefinitionSeed {
    id: String,
    name: String,
    description: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    effects: Option<serde_json::Value>,
}

pub async fn get_title_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<TitleListData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let defs = load_title_definition_map()?;
    let rows = state
        .database
        .fetch_all(
            "SELECT title_id, is_equipped, obtained_at::text AS obtained_at_text, expires_at::text AS expires_at_text FROM character_title WHERE character_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY is_equipped DESC, obtained_at ASC, id ASC",
            |query| query.bind(actor.character_id),
        )
        .await?;

    let mut equipped = String::new();
    let mut titles = Vec::new();
    for row in rows {
        let title_id = row
            .try_get::<Option<String>, _>("title_id")?
            .unwrap_or_default();
        let Some(def) = defs.get(title_id.trim()) else {
            continue;
        };
        let is_equipped = row
            .try_get::<Option<bool>, _>("is_equipped")?
            .unwrap_or(false);
        if is_equipped {
            equipped = title_id.clone();
        }
        titles.push(TitleInfoDto {
            id: title_id,
            name: def.name.clone(),
            description: def.description.clone().unwrap_or_default(),
            color: def.color.clone(),
            icon: def.icon.clone(),
            effects: normalize_title_effects(def.effects.clone()),
            is_equipped,
            obtained_at: row
                .try_get::<Option<String>, _>("obtained_at_text")?
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
            expires_at: row.try_get::<Option<String>, _>("expires_at_text")?,
        });
    }

    Ok(send_success(TitleListData { titles, equipped }))
}

pub async fn equip_title(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<EquipTitlePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let title_id = payload
        .title_id
        .or(payload.title_id_legacy)
        .unwrap_or_default();
    let title_id = title_id.trim();
    if title_id.is_empty() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("称号ID不能为空".to_string()),
            data: None,
        }));
    }
    let defs = load_title_definition_map()?;
    if !defs.contains_key(title_id) {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("未拥有该称号".to_string()),
            data: None,
        }));
    }
    let row = state
        .database
        .fetch_optional(
            "SELECT title_id FROM character_title WHERE character_id = $1 AND title_id = $2 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1 FOR UPDATE",
            |query| query.bind(actor.character_id).bind(title_id),
        )
        .await?;
    if row.is_none() {
        return Ok(send_result(ServiceResult::<serde_json::Value> {
            success: false,
            message: Some("未拥有该称号".to_string()),
            data: None,
        }));
    }

    state
        .database
        .with_transaction(|| async {
            state
                .database
                .execute(
                    "UPDATE character_title SET is_equipped = false, updated_at = NOW() WHERE character_id = $1 AND is_equipped = true",
                    |query| query.bind(actor.character_id),
                )
                .await?;
            state
                .database
                .execute(
                    "UPDATE character_title SET is_equipped = true, updated_at = NOW() WHERE character_id = $1 AND title_id = $2",
                    |query| query.bind(actor.character_id).bind(title_id),
                )
                .await?;
            let title_name = defs
                .get(title_id)
                .map(|def| def.name.clone())
                .unwrap_or_else(|| title_id.to_string());
            state
                .database
                .execute(
                    "UPDATE characters SET title = $2, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(actor.character_id).bind(title_name),
                )
                .await?;
            Ok::<(), AppError>(())
        })
        .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({})),
    }))
}

fn load_title_definition_map() -> Result<BTreeMap<String, TitleDefinitionSeed>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/title_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read title_def.json: {error}")))?;
    let payload: TitleDefinitionFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse title_def.json: {error}")))?;
    Ok(payload
        .titles
        .into_iter()
        .map(|title| (title.id.clone(), title))
        .collect())
}

fn normalize_title_effects(raw: Option<serde_json::Value>) -> BTreeMap<String, f64> {
    let Some(raw) = raw else {
        return BTreeMap::new();
    };
    let Some(obj) = raw.as_object() else {
        return BTreeMap::new();
    };
    obj.iter()
        .filter_map(|(key, value)| {
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|v| v as f64))
                .map(|v| (key.clone(), v))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn title_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "titles": [{
                    "id": "title-rabbit-hunter",
                    "name": "猎兔新手",
                    "description": "击杀野兔达人",
                    "color": "#ffffff",
                    "icon": "/assets/titles/rabbit.png",
                    "effects": {"wugong": 3},
                    "isEquipped": true,
                    "obtainedAt": "2026-04-11T12:00:00.000Z",
                    "expiresAt": null
                }],
                "equipped": "title-rabbit-hunter"
            }
        });
        assert_eq!(payload["data"]["titles"][0]["isEquipped"], true);
        assert_eq!(payload["data"]["equipped"], "title-rabbit-hunter");
        println!("TITLE_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn equip_title_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {}
        });
        assert_eq!(payload["message"], "ok");
        println!("TITLE_EQUIP_RESPONSE={}", payload);
    }
}
