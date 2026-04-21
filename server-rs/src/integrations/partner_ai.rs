use serde::{Deserialize, Serialize};

use crate::integrations::text_model_config::{TextModelScope, require_text_model_config};
use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartnerAiPreviewDraft {
    pub model_name: String,
    pub name: String,
    pub description: String,
    pub attribute_element: String,
    pub role: String,
}

#[derive(Serialize)]
struct OpenAiChatCompletionRequest<'a> {
    model: &'a str,
    messages: Vec<OpenAiChatMessage<'a>>,
    temperature: f64,
    response_format: serde_json::Value,
}

#[derive(Serialize)]
struct OpenAiChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiChatCompletionResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessageResponse,
}

#[derive(Deserialize)]
struct OpenAiChatMessageResponse {
    content: Option<String>,
}

pub async fn generate_partner_ai_preview_draft(
    state: &AppState,
    quality: &str,
    requested_base_model: &str,
) -> Result<PartnerAiPreviewDraft, AppError> {
    let config = require_text_model_config(TextModelScope::Partner)?;
    if config.provider != "openai" {
        return Err(AppError::config(format!(
            "暂不支持的伙伴 AI provider: {}",
            config.provider
        )));
    }
    let system_message = "You generate concise xianxia partner preview metadata. Return JSON with fields name, description, attributeElement, role. name must be 2-12 Chinese characters. description max 60 Chinese chars. attributeElement must be one of none, wood, fire, water, earth, metal. role must be one of attacker, support, tank.";
    let user_message = format!(
        "quality={}; baseModel={}. Create one Chinese xianxia partner preview.",
        quality.trim(),
        requested_base_model.trim()
    );
    let response = state
        .outbound_http
        .post(format!("{}/chat/completions", config.url))
        .bearer_auth(&config.key)
        .json(&OpenAiChatCompletionRequest {
            model: &config.model_name,
            messages: vec![
                OpenAiChatMessage {
                    role: "system",
                    content: system_message,
                },
                OpenAiChatMessage {
                    role: "user",
                    content: &user_message,
                },
            ],
            temperature: 0.7,
            response_format: serde_json::json!({"type": "json_object"}),
        })
        .send()
        .await
        .map_err(|error| AppError::config(format!("伙伴 AI 请求失败: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::config(format!("伙伴 AI 响应读取失败: {error}")))?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "伙伴 AI 返回错误状态 {}: {}",
            status, body
        )));
    }
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::config(format!("伙伴 AI 响应解析失败: {error}")))?;
    let content = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| AppError::config("伙伴 AI 未返回正文"))?;
    parse_and_validate_partner_ai_preview_draft(content, &config.model_name)
}

pub fn parse_and_validate_partner_ai_preview_draft(
    raw: &str,
    model_name: &str,
) -> Result<PartnerAiPreviewDraft, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("伙伴 AI JSON 解析失败: {error}")))?;
    let name = extract_bounded_chinese_text(&value, "name", 2, 12)?;
    let description = extract_bounded_text(&value, "description", 8, 60)?;
    let attribute_element = value
        .get("attributeElement")
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|value| {
            matches!(
                *value,
                "none" | "wood" | "fire" | "water" | "earth" | "metal"
            )
        })
        .ok_or_else(|| AppError::config("伙伴 AI attributeElement 非法"))?
        .to_string();
    let role = value
        .get("role")
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .filter(|value| matches!(*value, "attacker" | "support" | "tank"))
        .ok_or_else(|| AppError::config("伙伴 AI role 非法"))?
        .to_string();
    Ok(PartnerAiPreviewDraft {
        model_name: model_name.trim().to_string(),
        name,
        description,
        attribute_element,
        role,
    })
}

fn extract_bounded_text(
    value: &serde_json::Value,
    field: &str,
    min_len: usize,
    max_len: usize,
) -> Result<String, AppError> {
    let text = value
        .get(field)
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .ok_or_else(|| AppError::config(format!("伙伴 AI 缺少字段: {field}")))?;
    let char_count = text.chars().count();
    if char_count < min_len || char_count > max_len {
        return Err(AppError::config(format!("伙伴 AI 字段 {field} 长度非法")));
    }
    Ok(text.to_string())
}

fn extract_bounded_chinese_text(
    value: &serde_json::Value,
    field: &str,
    min_len: usize,
    max_len: usize,
) -> Result<String, AppError> {
    let text = extract_bounded_text(value, field, min_len, max_len)?;
    if !text.chars().all(|ch| ('一'..='龥').contains(&ch)) {
        return Err(AppError::config(format!(
            "伙伴 AI 字段 {field} 必须为纯中文"
        )));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::parse_and_validate_partner_ai_preview_draft;

    #[test]
    fn partner_ai_preview_validation_accepts_minimal_valid_shape() {
        let draft = parse_and_validate_partner_ai_preview_draft(
            r#"{"name":"青木灵伴","description":"以青木为底模推演出的玄品质伙伴预览。","attributeElement":"wood","role":"support"}"#,
            "partner-model",
        )
        .expect("draft should parse");
        assert_eq!(draft.model_name, "partner-model");
        assert_eq!(draft.attribute_element, "wood");
        println!("PARTNER_AI_PREVIEW_NAME={}", draft.name);
    }
}
