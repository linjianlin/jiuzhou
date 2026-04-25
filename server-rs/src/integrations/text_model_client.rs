use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::integrations::text_model_config::{TextModelConfigSnapshot, TextModelProvider};
use crate::shared::error::AppError;
use crate::state::AppState;

const ANTHROPIC_MAX_TOKENS: i64 = 81920;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, PartialEq)]
pub struct TextModelCallRequest {
    pub system_message: String,
    pub user_message: String,
    pub response_format: Option<Value>,
    pub seed: Option<i64>,
    pub temperature: Option<f64>,
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextModelCallResult {
    pub model_name: String,
    pub prompt_snapshot: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
struct OpenAiChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatCompletionResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatMessageResponse {
    content: Option<OpenAiMessageContent>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OpenAiMessageContent {
    Text(String),
    Parts(Vec<OpenAiMessageContentPart>),
}

#[derive(Debug, Deserialize)]
struct OpenAiMessageContentPart {
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AnthropicMessageResponse {
    content: Vec<AnthropicContentBlock>,
}

#[derive(Debug, Deserialize)]
struct AnthropicContentBlock {
    r#type: String,
    text: Option<String>,
}

pub fn build_openai_payload(
    config: &TextModelConfigSnapshot,
    request: &TextModelCallRequest,
) -> Value {
    let mut payload = json!({
        "model": config.model_name,
        "messages": [
            {
                "role": "system",
                "content": request.system_message,
            },
            {
                "role": "user",
                "content": request.user_message,
            }
        ],
    });
    if let Some(temperature) = request.temperature {
        payload["temperature"] = json!(temperature);
    }
    if let Some(seed) = request.seed {
        payload["seed"] = json!(seed);
    }
    if let Some(response_format) = request.response_format.as_ref() {
        payload["response_format"] = response_format.clone();
    }
    payload
}

fn anthropic_output_config(response_format: Option<&Value>) -> Option<Value> {
    let response_format = response_format?;
    if response_format.get("type").and_then(Value::as_str) != Some("json_schema") {
        return None;
    }
    let schema = response_format
        .get("json_schema")
        .and_then(|value| value.get("schema"))?;
    Some(json!({
        "format": {
            "type": "json_schema",
            "schema": schema,
        }
    }))
}

pub fn build_anthropic_payload(
    config: &TextModelConfigSnapshot,
    request: &TextModelCallRequest,
) -> Value {
    let mut payload = json!({
        "model": config.model_name,
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "system": request.system_message,
        "messages": [
            {
                "role": "user",
                "content": request.user_message,
            }
        ],
    });
    if let Some(temperature) = request.temperature {
        payload["temperature"] = json!(temperature);
    }
    if let Some(output_config) = anthropic_output_config(request.response_format.as_ref()) {
        payload["output_config"] = output_config;
    }
    payload
}

fn extract_openai_message_content(content: OpenAiMessageContent) -> String {
    match content {
        OpenAiMessageContent::Text(text) => text,
        OpenAiMessageContent::Parts(parts) => parts
            .into_iter()
            .filter_map(|part| part.text)
            .collect::<Vec<_>>()
            .join(""),
    }
}

pub fn extract_openai_content(body: &str) -> Result<String, AppError> {
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(body)
        .map_err(|error| AppError::config(format!("文本模型 OpenAI 响应解析失败: {error}")))?;
    parsed
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message.content)
        .map(extract_openai_message_content)
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| AppError::config("文本模型 OpenAI 未返回正文"))
}

pub fn extract_anthropic_content(body: &str) -> Result<String, AppError> {
    let parsed: AnthropicMessageResponse = serde_json::from_str(body)
        .map_err(|error| AppError::config(format!("文本模型 Anthropic 响应解析失败: {error}")))?;
    let content = parsed
        .content
        .into_iter()
        .filter(|block| block.r#type == "text")
        .filter_map(|block| block.text)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err(AppError::config("文本模型 Anthropic 未返回正文"));
    }
    Ok(content)
}

async fn post_openai(
    state: &AppState,
    config: &TextModelConfigSnapshot,
    request: &TextModelCallRequest,
    payload: &Value,
) -> Result<String, AppError> {
    let mut builder = state
        .outbound_http
        .post(format!("{}/chat/completions", config.url))
        .bearer_auth(&config.key)
        .json(payload);
    if let Some(timeout) = request.timeout {
        builder = builder.timeout(timeout);
    }
    let response = builder.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "文本模型 OpenAI 返回错误状态 {}: {}",
            status, body
        )));
    }
    if body.trim().is_empty() {
        return Err(AppError::config("文本模型 OpenAI 返回空响应"));
    }
    Ok(body)
}

async fn post_anthropic(
    state: &AppState,
    config: &TextModelConfigSnapshot,
    request: &TextModelCallRequest,
    payload: &Value,
) -> Result<String, AppError> {
    let mut builder = state
        .outbound_http
        .post(format!("{}/v1/messages", config.url))
        .header("x-api-key", &config.key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .json(payload);
    if let Some(timeout) = request.timeout {
        builder = builder.timeout(timeout);
    }
    let response = builder.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "文本模型 Anthropic 返回错误状态 {}: {}",
            status, body
        )));
    }
    if body.trim().is_empty() {
        return Err(AppError::config("文本模型 Anthropic 返回空响应"));
    }
    Ok(body)
}

pub async fn call_configured_text_model(
    state: &AppState,
    config: &TextModelConfigSnapshot,
    request: TextModelCallRequest,
) -> Result<TextModelCallResult, AppError> {
    match config.provider {
        TextModelProvider::OpenAi => {
            let payload = build_openai_payload(config, &request);
            let prompt_snapshot = serde_json::to_string(&payload).map_err(|error| {
                AppError::config(format!("文本模型 prompt 序列化失败: {error}"))
            })?;
            let body = post_openai(state, config, &request, &payload).await?;
            Ok(TextModelCallResult {
                model_name: config.model_name.clone(),
                prompt_snapshot,
                content: extract_openai_content(&body)?,
            })
        }
        TextModelProvider::Anthropic => {
            let payload = build_anthropic_payload(config, &request);
            let prompt_snapshot = serde_json::to_string(&payload).map_err(|error| {
                AppError::config(format!("文本模型 prompt 序列化失败: {error}"))
            })?;
            let body = post_anthropic(state, config, &request, &payload).await?;
            Ok(TextModelCallResult {
                model_name: config.model_name.clone(),
                prompt_snapshot,
                content: extract_anthropic_content(&body)?,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        TextModelCallRequest, build_anthropic_payload, build_openai_payload,
        extract_anthropic_content, extract_openai_content,
    };
    use crate::integrations::text_model_config::{TextModelConfigSnapshot, TextModelProvider};

    fn config(provider: TextModelProvider) -> TextModelConfigSnapshot {
        TextModelConfigSnapshot {
            provider,
            url: match provider {
                TextModelProvider::OpenAi => "https://api.openai.com/v1".to_string(),
                TextModelProvider::Anthropic => "https://api.anthropic.com".to_string(),
            },
            key: "key".to_string(),
            model_name: "model-a".to_string(),
        }
    }

    fn request() -> TextModelCallRequest {
        TextModelCallRequest {
            system_message: "system".to_string(),
            user_message: "user".to_string(),
            response_format: Some(serde_json::json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "payload",
                    "strict": true,
                    "schema": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["name"],
                        "properties": {
                            "name": { "type": "string" }
                        }
                    }
                }
            })),
            seed: Some(42),
            temperature: Some(0.7),
            timeout: None,
        }
    }

    #[test]
    fn text_model_client_builds_openai_payload() {
        let payload = build_openai_payload(&config(TextModelProvider::OpenAi), &request());

        assert_eq!(payload["model"], "model-a");
        assert_eq!(payload["messages"][0]["role"], "system");
        assert_eq!(payload["messages"][1]["content"], "user");
        assert_eq!(payload["seed"], 42);
        assert_eq!(payload["temperature"], 0.7);
        assert_eq!(payload["response_format"]["type"], "json_schema");
    }

    #[test]
    fn text_model_client_builds_anthropic_payload() {
        let payload = build_anthropic_payload(&config(TextModelProvider::Anthropic), &request());

        assert_eq!(payload["model"], "model-a");
        assert_eq!(payload["system"], "system");
        assert_eq!(payload["messages"][0]["role"], "user");
        assert!(payload.get("seed").is_none());
        assert_eq!(payload["output_config"]["format"]["type"], "json_schema");
        assert_eq!(
            payload["output_config"]["format"]["schema"]["properties"]["name"]["type"],
            "string"
        );
    }

    #[test]
    fn text_model_client_extracts_openai_string_and_parts_content() {
        let text =
            extract_openai_content(r#"{"choices":[{"message":{"content":" {\"ok\":true} "}}]}"#)
                .expect("string content should parse");
        let parts = extract_openai_content(
            r#"{"choices":[{"message":{"content":[{"text":" {\""},{"text":"ok\":true} "} ]}}]}"#,
        )
        .expect("parts content should parse");

        assert_eq!(text, r#"{"ok":true}"#);
        assert_eq!(parts, r#"{"ok":true}"#);
    }

    #[test]
    fn text_model_client_extracts_anthropic_text_content() {
        let content = extract_anthropic_content(
            r#"{"content":[{"type":"text","text":" {\"ok\":"},{"type":"tool_use","id":"1"},{"type":"text","text":"true} "} ]}"#,
        )
        .expect("anthropic text should parse");

        assert_eq!(content, r#"{"ok":true}"#);
    }
}
