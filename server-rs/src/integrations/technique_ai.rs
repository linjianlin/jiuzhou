use serde::{Deserialize, Serialize};

use crate::integrations::text_model_config::{TextModelScope, require_text_model_config};
use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TechniqueAiDraft {
    pub model_name: String,
    pub suggested_name: String,
    pub description: String,
    pub long_desc: String,
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

pub async fn generate_technique_ai_draft(
    state: &AppState,
    technique_type: &str,
    quality: &str,
    burning_word_prompt: &str,
) -> Result<TechniqueAiDraft, AppError> {
    let config = require_text_model_config(TextModelScope::Technique)?;
    if config.provider != "openai" {
        return Err(AppError::config(format!(
            "暂不支持的功法 AI provider: {}",
            config.provider
        )));
    }
    let system_message = "You generate concise xianxia technique draft metadata. Return JSON with fields suggestedName, description, longDesc. suggestedName must be 2-12 Chinese characters. description max 40 Chinese chars. longDesc max 120 Chinese chars.";
    let user_message = format!(
        "quality={quality}; type={}; burningWord={}. Create one Chinese xianxia technique draft.",
        technique_type.trim(),
        burning_word_prompt.trim()
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
        .map_err(|error| AppError::config(format!("功法 AI 请求失败: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::config(format!("功法 AI 响应读取失败: {error}")))?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "功法 AI 返回错误状态 {}: {}",
            status, body
        )));
    }
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::config(format!("功法 AI 响应解析失败: {error}")))?;
    let content = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| AppError::config("功法 AI 未返回正文"))?;
    parse_and_validate_technique_ai_draft(content, &config.model_name)
}

pub fn parse_and_validate_technique_ai_draft(
    raw: &str,
    model_name: &str,
) -> Result<TechniqueAiDraft, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("功法 AI JSON 解析失败: {error}")))?;
    let suggested_name = extract_bounded_chinese_text(&value, "suggestedName", 2, 12)?;
    let description = extract_bounded_text(&value, "description", 6, 40)?;
    let long_desc = extract_bounded_text(&value, "longDesc", 16, 120)?;
    Ok(TechniqueAiDraft {
        model_name: model_name.trim().to_string(),
        suggested_name,
        description,
        long_desc,
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
        .ok_or_else(|| AppError::config(format!("功法 AI 缺少字段: {field}")))?;
    let char_count = text.chars().count();
    if char_count < min_len || char_count > max_len {
        return Err(AppError::config(format!("功法 AI 字段 {field} 长度非法")));
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
            "功法 AI 字段 {field} 必须为纯中文"
        )));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::parse_and_validate_technique_ai_draft;

    #[test]
    fn technique_ai_draft_validation_accepts_minimal_valid_shape() {
        let draft = parse_and_validate_technique_ai_draft(
            r#"{"suggestedName":"青木诀","description":"玄品武技草稿","longDesc":"以青木真意推演而成的玄品武技草稿，可于洞府研修中进一步命名发布。"}"#,
            "technique-model",
        )
        .expect("draft should parse");
        assert_eq!(draft.model_name, "technique-model");
        assert_eq!(draft.suggested_name, "青木诀");
        println!("TECHNIQUE_AI_DRAFT_NAME={}", draft.suggested_name);
    }

    #[test]
    fn technique_ai_draft_validation_rejects_non_chinese_name() {
        let error = parse_and_validate_technique_ai_draft(
            r#"{"suggestedName":"QingMu","description":"玄品武技草稿","longDesc":"以青木真意推演而成的玄品武技草稿，可于洞府研修中进一步命名发布。"}"#,
            "technique-model",
        )
        .expect_err("draft should reject latin name");
        assert!(error.to_string().contains("纯中文"));
    }
}
