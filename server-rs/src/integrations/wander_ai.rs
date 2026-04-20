use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use crate::shared::error::AppError;
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WanderAiConfigSnapshot {
    pub provider: String,
    pub url: String,
    pub key: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WanderAiEpisodeSetupDraft {
    pub story_theme: String,
    pub story_premise: String,
    pub episode_title: String,
    pub opening: String,
    pub option_texts: [String; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WanderAiEpisodeResolutionDraft {
    pub summary: String,
    pub is_ending: bool,
    pub ending_type: String,
    pub reward_title_name: String,
    pub reward_title_desc: String,
    pub reward_title_color: String,
    pub reward_title_effects: std::collections::BTreeMap<String, f64>,
}

const WANDER_TITLE_MIN_EFFECT_COUNT: usize = 1;
const WANDER_TITLE_MAX_EFFECT_COUNT: usize = 5;

fn is_valid_wander_title_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

const TITLE_EFFECT_KEYS: &[&str] = &[
    "max_qixue", "max_lingqi", "wugong", "fagong", "wufang", "fafang", "sudu", "fuyuan",
    "mingzhong", "shanbi", "zhaojia", "baoji", "baoshang", "jianbaoshang", "jianfantan",
    "kangbao", "zengshang", "zhiliao", "jianliao", "xixue", "lengque", "kongzhi_kangxing",
    "jin_kangxing", "mu_kangxing", "shui_kangxing", "huo_kangxing", "tu_kangxing",
    "qixue_huifu", "lingqi_huifu",
];
const TITLE_RATIO_EFFECT_KEYS: &[&str] = &[
    "mingzhong", "shanbi", "zhaojia", "baoji", "baoshang", "jianbaoshang", "jianfantan",
    "kangbao", "zengshang", "zhiliao", "jianliao", "xixue", "lengque", "kongzhi_kangxing",
    "jin_kangxing", "mu_kangxing", "shui_kangxing", "huo_kangxing", "tu_kangxing",
];

#[derive(Serialize)]
struct OpenAiChatCompletionRequest<'a> {
    model: &'a str,
    messages: Vec<OpenAiChatMessage<'a>>,
    seed: i64,
    temperature: f64,
    response_format: serde_json::Value,
}

fn build_wander_ai_setup_response_format() -> serde_json::Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "wander_story_payload",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["storyTheme", "storyPremise", "episodeTitle", "opening", "optionTexts"],
                "properties": {
                    "storyTheme": { "type": "string", "minLength": 2, "maxLength": 24 },
                    "storyPremise": { "type": "string", "minLength": 8, "maxLength": 120 },
                    "episodeTitle": { "type": "string", "minLength": 2, "maxLength": 24 },
                    "opening": { "type": "string", "minLength": 80, "maxLength": 420 },
                    "optionTexts": {
                        "type": "array",
                        "minItems": 3,
                        "maxItems": 3,
                        "items": { "type": "string", "minLength": 4, "maxLength": 32 }
                    }
                }
            }
        }
    })
}

fn build_wander_title_effect_entry_schema() -> serde_json::Value {
    let keys = TITLE_EFFECT_KEYS;
    let max_map = serde_json::json!({
        "max_qixue": 240,
        "max_lingqi": 200,
        "wugong": 60,
        "fagong": 60,
        "wufang": 120,
        "fafang": 120,
        "sudu": 30,
        "fuyuan": 15,
        "mingzhong": 0.08,
        "shanbi": 0.08,
        "zhaojia": 0.08,
        "baoji": 0.08,
        "baoshang": 0.08,
        "jianbaoshang": 0.08,
        "jianfantan": 0.08,
        "kangbao": 0.08,
        "zengshang": 0.08,
        "zhiliao": 0.08,
        "jianliao": 0.08,
        "xixue": 0.08,
        "lengque": 0.08,
        "kongzhi_kangxing": 0.08,
        "jin_kangxing": 0.08,
        "mu_kangxing": 0.08,
        "shui_kangxing": 0.08,
        "huo_kangxing": 0.08,
        "tu_kangxing": 0.08,
        "qixue_huifu": 20,
        "lingqi_huifu": 15
    });
    let ratio_keys = TITLE_RATIO_EFFECT_KEYS.iter().copied().collect::<BTreeSet<_>>();
    serde_json::json!({
        "oneOf": keys.iter().map(|key| {
            let max = max_map.get(*key).cloned().unwrap_or(serde_json::json!(300));
            serde_json::json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["key", "value"],
                "properties": {
                    "key": { "type": "string", "const": key },
                    "value": if ratio_keys.contains(key) {
                        serde_json::json!({ "type": "number", "exclusiveMinimum": 0, "maximum": max })
                    } else {
                        serde_json::json!({ "type": "integer", "exclusiveMinimum": 0, "maximum": max })
                    }
                }
            })
        }).collect::<Vec<_>>(),
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "value"],
        "properties": {
            "key": { "type": "string", "enum": keys },
            "value": { "type": "number", "exclusiveMinimum": 0, "maximum": 300 }
        },
        "x-max-map": max_map,
    })
}

fn build_wander_ai_resolution_response_format(is_ending: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "json_schema",
        "json_schema": {
            "name": "wander_story_payload",
            "strict": true,
            "schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["summary", "endingType", "rewardTitleName", "rewardTitleDesc", "rewardTitleColor", "rewardTitleEffects"],
                "properties": {
                    "summary": { "type": "string", "minLength": 20, "maxLength": 160 },
                    "endingType": if is_ending {
                        serde_json::json!({ "type": "string", "enum": ["good", "neutral", "tragic", "bizarre"] })
                    } else {
                        serde_json::json!({ "type": "string", "enum": ["none"], "const": "none" })
                    },
                    "rewardTitleName": if is_ending {
                        serde_json::json!({ "type": "string", "minLength": 2, "maxLength": 8 })
                    } else {
                        serde_json::json!({ "type": "string", "minLength": 0, "maxLength": 0 })
                    },
                    "rewardTitleDesc": if is_ending {
                        serde_json::json!({ "type": "string", "minLength": 8, "maxLength": 40 })
                    } else {
                        serde_json::json!({ "type": "string", "minLength": 0, "maxLength": 0 })
                    },
                    "rewardTitleColor": if is_ending {
                        serde_json::json!({ "type": "string", "minLength": 7, "maxLength": 7, "pattern": "^#[0-9A-Fa-f]{6}$" })
                    } else {
                        serde_json::json!({ "type": "string", "minLength": 0, "maxLength": 0 })
                    },
                    "rewardTitleEffects": {
                        "type": "array",
                        "minItems": if is_ending { WANDER_TITLE_MIN_EFFECT_COUNT } else { 0 },
                        "maxItems": if is_ending { WANDER_TITLE_MAX_EFFECT_COUNT } else { 0 },
                        "items": build_wander_title_effect_entry_schema()
                    }
                }
            }
        }
    })
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

#[derive(Clone, Copy)]
enum WanderAiDraftKind {
    Setup,
    Resolution { is_ending: bool },
}

const WANDER_AI_MAX_ATTEMPTS: usize = 3;
const WANDER_AI_TIMEOUT_MS: u64 = 600_000;

fn wander_ai_timeout() -> Duration {
    Duration::from_millis(WANDER_AI_TIMEOUT_MS)
}

fn is_unsupported_structured_schema_error(message: &str) -> bool {
    message.contains("invalid_json_schema")
        || message.contains("'allOf' is not permitted")
        || message.contains("Invalid schema for response_format")
}

pub fn read_wander_ai_config(state: &AppState) -> Option<WanderAiConfigSnapshot> {
    let provider = state.config.wander.model_provider.trim().to_string();
    let url = state.config.wander.model_url.trim().trim_end_matches('/').to_string();
    let key = state.config.wander.model_key.trim().to_string();
    let model = state.config.wander.model_name.trim().to_string();
    if !state.config.wander.ai_enabled || provider.is_empty() || url.is_empty() || key.is_empty() || model.is_empty() {
        return None;
    }
    Some(WanderAiConfigSnapshot {
        provider,
        url,
        key,
        model,
    })
}

pub async fn generate_wander_ai_episode_setup_draft(
    state: &AppState,
    system_message: &str,
    user_message: &str,
    seed: i64,
    repair_system_message: &str,
    build_repair_user_message: impl Fn(&str, &str) -> String,
) -> Result<WanderAiEpisodeSetupDraft, AppError> {
    request_wander_ai_draft_with_repair(
        state,
        WanderAiDraftKind::Setup,
        system_message,
        user_message,
        seed,
        repair_system_message,
        build_repair_user_message,
        parse_and_validate_wander_ai_episode_setup_draft,
    )
    .await
}

pub async fn generate_wander_ai_episode_resolution_draft(
    state: &AppState,
    system_message: &str,
    user_message: &str,
    seed: i64,
    is_ending: bool,
    repair_system_message: &str,
    build_repair_user_message: impl Fn(&str, &str) -> String,
) -> Result<WanderAiEpisodeResolutionDraft, AppError> {
    request_wander_ai_draft_with_repair(
        state,
        WanderAiDraftKind::Resolution { is_ending },
        system_message,
        user_message,
        seed,
        repair_system_message,
        build_repair_user_message,
        parse_and_validate_wander_ai_episode_resolution_draft,
    )
    .await
}

async fn request_wander_ai_draft_with_repair<T, F, B>(
    state: &AppState,
    draft_kind: WanderAiDraftKind,
    system_message: &str,
    user_message: &str,
    seed: i64,
    repair_system_message: &str,
    build_repair_user_message: B,
    validate: F,
) -> Result<T, AppError>
where
    F: Fn(&str) -> Result<T, AppError>,
    B: Fn(&str, &str) -> String,
{
    let initial_system_message = system_message.to_string();
    let repair_system_message = repair_system_message.to_string();
    let initial_user_message = user_message.to_string();
    request_wander_ai_draft_with_repair_inner(
        move |message, use_structured_schema| {
            let initial_system_message = initial_system_message.clone();
            let repair_system_message = repair_system_message.clone();
            let initial_user_message = initial_user_message.clone();
            let message_owned = message.to_string();
            async move {
            request_wander_ai_content(
                state,
                draft_kind,
                if message_owned == initial_user_message {
                    initial_system_message.as_str()
                } else {
                    repair_system_message.as_str()
                },
                message_owned.as_str(),
                seed,
                use_structured_schema,
            )
            .await
            }
        },
        user_message,
        &build_repair_user_message,
        validate,
    )
    .await
}

async fn request_wander_ai_draft_with_repair_inner<T, F, B, C, Fut>(
    mut request_content: C,
    initial_user_message: &str,
    build_repair_user_message: &B,
    validate: F,
) -> Result<T, AppError>
where
    F: Fn(&str) -> Result<T, AppError>,
    B: Fn(&str, &str) -> String,
    C: FnMut(&str, bool) -> Fut,
    Fut: std::future::Future<Output = Result<String, AppError>>,
{
    let mut use_structured_schema = true;
    let mut latest_user_message = initial_user_message.to_string();
    let mut latest_failure_reason = "模型未返回合法 JSON 对象".to_string();

    for _attempt in 1..=WANDER_AI_MAX_ATTEMPTS {
        let content = loop {
            match request_content(latest_user_message.as_str(), use_structured_schema).await {
                Ok(content) => break content,
                Err(error) if use_structured_schema && is_unsupported_structured_schema_error(&error.to_string()) => {
                    use_structured_schema = false;
                    continue;
                }
                Err(error) => return Err(error),
            }
        };

        match validate(&content) {
            Ok(draft) => return Ok(draft),
            Err(error) => {
                latest_failure_reason = error.to_string();
                latest_user_message = build_repair_user_message(content.as_str(), latest_failure_reason.as_str());
            }
        }
    }

    Err(AppError::config(format!("云游奇遇模型返回字段不符合业务约束：{}", latest_failure_reason)))
}

async fn request_wander_ai_content(
    state: &AppState,
    draft_kind: WanderAiDraftKind,
    system_message: &str,
    user_message: &str,
    seed: i64,
    use_structured_schema: bool,
) -> Result<String, AppError> {
    let config = read_wander_ai_config(state)
        .ok_or_else(|| AppError::config("未配置 wander AI 文本模型"))?;
    if config.provider != "openai" {
        return Err(AppError::config(format!("暂不支持的 wander AI provider: {}", config.provider)));
    }

    let response = state
        .outbound_http
        .post(format!("{}/chat/completions", config.url))
        .timeout(wander_ai_timeout())
        .bearer_auth(&config.key)
        .json(&OpenAiChatCompletionRequest {
            model: &config.model,
            messages: vec![
                OpenAiChatMessage {
                    role: "system",
                    content: system_message,
                },
                OpenAiChatMessage {
                    role: "user",
                    content: user_message,
                },
            ],
            seed,
            temperature: 0.7,
            response_format: if use_structured_schema {
                match draft_kind {
                    WanderAiDraftKind::Setup => build_wander_ai_setup_response_format(),
                    WanderAiDraftKind::Resolution { is_ending } => build_wander_ai_resolution_response_format(is_ending),
                }
            } else {
                serde_json::json!({ "type": "json_object" })
            },
        })
        .send()
        .await
        .map_err(|error| AppError::config(format!("wander AI 请求失败: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::config(format!("wander AI 响应读取失败: {error}")))?;
    if !status.is_success() {
        return Err(AppError::config(format!("wander AI 返回错误状态 {}: {}", status, body)));
    }
    let parsed: OpenAiChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::config(format!("wander AI 响应解析失败: {error}")))?;
    let content = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.as_deref())
        .map(str::trim)
        .filter(|content| !content.is_empty())
        .ok_or_else(|| AppError::config("wander AI 未返回正文"))?;
    Ok(content.to_string())
}

pub fn parse_and_validate_wander_ai_episode_setup_draft(
    raw: &str,
) -> Result<WanderAiEpisodeSetupDraft, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("wander AI JSON 解析失败: {error}")))?;
    let story_theme = extract_bounded_text(&value, "storyTheme", 2, 24)?;
    let story_premise = extract_bounded_text(&value, "storyPremise", 8, 120)?;
    let episode_title = extract_bounded_text(&value, "episodeTitle", 2, 24)?;
    let opening = extract_bounded_text(&value, "opening", 80, 420)?;
    let option_texts = extract_three_options(&value)?;
    Ok(WanderAiEpisodeSetupDraft {
        story_theme,
        story_premise,
        episode_title,
        opening,
        option_texts,
    })
}

pub fn parse_and_validate_wander_ai_episode_resolution_draft(
    raw: &str,
) -> Result<WanderAiEpisodeResolutionDraft, AppError> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| AppError::config(format!("wander AI JSON 解析失败: {error}")))?;
    let summary = extract_bounded_text(&value, "summary", 20, 160)?;
    let ending_type = value
        .get("endingType")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| matches!(*value, "none" | "good" | "neutral" | "tragic" | "bizarre"))
        .ok_or_else(|| AppError::config("wander AI endingType 非法"))?
        .to_string();
    let reward_title_name = value
        .get("rewardTitleName")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let reward_title_desc = value
        .get("rewardTitleDesc")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let reward_title_color = value
        .get("rewardTitleColor")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let reward_title_effects = parse_reward_title_effects(value.get("rewardTitleEffects"))?;

    let is_ending = ending_type != "none";
    if is_ending {
        if reward_title_name.chars().count() < 2 || reward_title_name.chars().count() > 8 {
            return Err(AppError::config("wander AI rewardTitleName 长度非法"));
        }
        if reward_title_desc.chars().count() < 8 || reward_title_desc.chars().count() > 40 {
            return Err(AppError::config("wander AI rewardTitleDesc 长度非法"));
        }
        if !is_valid_wander_title_color(&reward_title_color) {
            return Err(AppError::config("wander AI rewardTitleColor 非法"));
        }
        if reward_title_effects.len() < WANDER_TITLE_MIN_EFFECT_COUNT
            || reward_title_effects.len() > WANDER_TITLE_MAX_EFFECT_COUNT
        {
            return Err(AppError::config("wander AI rewardTitleEffects 数量非法"));
        }
    } else {
        if !reward_title_name.is_empty()
            || !reward_title_desc.is_empty()
            || !reward_title_color.is_empty()
            || !reward_title_effects.is_empty()
        {
            return Err(AppError::config("wander AI 非终幕不得返回称号奖励字段"));
        }
    }

    Ok(WanderAiEpisodeResolutionDraft {
        summary,
        is_ending,
        ending_type,
        reward_title_name,
        reward_title_desc,
        reward_title_color,
        reward_title_effects,
    })
}

fn parse_reward_title_effects(
    value: Option<&serde_json::Value>,
) -> Result<BTreeMap<String, f64>, AppError> {
    let allowed = TITLE_EFFECT_KEYS.iter().copied().collect::<BTreeSet<_>>();
    let mut out = BTreeMap::new();
    let array = value
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::config("wander AI rewardTitleEffects 必须是数组"))?;
    for entry in array {
        let key = entry
            .get("key")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("wander AI rewardTitleEffects 缺少 key"))?
            .to_string();
        let raw_value = entry
            .get("value")
            .ok_or_else(|| AppError::config(format!("wander AI rewardTitleEffects 缺少 value: {key}")))?;
        insert_reward_title_effect(&mut out, &allowed, &key, raw_value)?;
    }
    Ok(out)
}

fn insert_reward_title_effect(
    out: &mut BTreeMap<String, f64>,
    allowed: &BTreeSet<&str>,
    key: &str,
    raw_value: &serde_json::Value,
) -> Result<(), AppError> {
    if !allowed.contains(key) {
        return Err(AppError::config(format!("wander AI rewardTitleEffects 包含非法属性: {key}")));
    }
    if out.contains_key(key) {
        return Err(AppError::config(format!("wander AI rewardTitleEffects 包含重复属性: {key}")));
    }
    let value = raw_value
        .as_f64()
        .or_else(|| raw_value.as_i64().map(|number| number as f64))
        .ok_or_else(|| AppError::config(format!("wander AI rewardTitleEffects 值非法: {key}")))?;
    if value <= 0.0 {
        return Err(AppError::config(format!("wander AI rewardTitleEffects 值必须大于 0: {key}")));
    }
    let max = title_effect_value_max(key)
        .ok_or_else(|| AppError::config(format!("wander AI rewardTitleEffects 属性无上限定义: {key}")))?;
    if value > max {
        return Err(AppError::config(format!("wander AI rewardTitleEffects 超出上限: {key}")));
    }
    out.insert(key.to_string(), value);
    Ok(())
}

fn title_effect_value_max(key: &str) -> Option<f64> {
    Some(match key {
        "max_qixue" => 240.0,
        "max_lingqi" => 200.0,
        "wugong" | "fagong" => 60.0,
        "wufang" | "fafang" => 120.0,
        "sudu" => 30.0,
        "fuyuan" => 15.0,
        "mingzhong" | "shanbi" | "zhaojia" | "baoji" | "baoshang" | "jianbaoshang"
        | "jianfantan" | "kangbao" | "zengshang" | "zhiliao" | "jianliao" | "xixue"
        | "lengque" | "kongzhi_kangxing" | "jin_kangxing" | "mu_kangxing"
        | "shui_kangxing" | "huo_kangxing" | "tu_kangxing" => 0.08,
        "qixue_huifu" => 20.0,
        "lingqi_huifu" => 15.0,
        _ => return None,
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
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::config(format!("wander AI 缺少字段: {field}")))?;
    if text.chars().count() < min_len || text.chars().count() > max_len {
        return Err(AppError::config(format!("wander AI 字段 {field} 长度非法")));
    }
    Ok(text.to_string())
}

fn extract_three_options(value: &serde_json::Value) -> Result<[String; 3], AppError> {
    let options = value
        .get("optionTexts")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::config("wander AI 缺少 optionTexts"))?;
    if options.len() != 3 {
        return Err(AppError::config("wander AI optionTexts 数量必须为 3"));
    }
    let parsed = options
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.to_string())
                .ok_or_else(|| AppError::config("wander AI optionTexts 含空值"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok([
        parsed[0].clone(),
        parsed[1].clone(),
        parsed[2].clone(),
    ])
}

#[cfg(test)]
mod tests {
    use super::{
        build_wander_ai_resolution_response_format,
        build_wander_ai_setup_response_format,
        is_unsupported_structured_schema_error,
        parse_and_validate_wander_ai_episode_resolution_draft,
        parse_and_validate_wander_ai_episode_setup_draft,
        wander_ai_timeout,
    };

    #[test]
    fn wander_ai_setup_draft_validation_accepts_minimal_valid_shape() {
        let draft = parse_and_validate_wander_ai_episode_setup_draft(
            r#"{
                "storyTheme":"雨夜借灯",
                "storyPremise":"你循着残留血迹误入谷口深处，才觉今夜盘踞此地的异物并非寻常山兽。",
                "episodeTitle":"桥头灯影",
                "opening":"夜雨压桥，河雾顺着石栏缓缓爬起，你才在破庙檐下收住衣角，便见对岸灯影摇成一线。那人披着旧蓑衣，手里提灯不前不后，只隔着雨幕望来，像是在等谁认出他的来意；桥下水声却忽然沉了一拍，仿佛另有什么东西正贴着桥墩缓缓游过。",
                "optionTexts":["先借檐避雨，再试探来意","绕到桥下暗查灵息","收敛气机，静观其变"]
            }"#,
        )
        .expect("draft should validate");
        assert_eq!(draft.story_theme, "雨夜借灯");
        assert_eq!(draft.option_texts[0], "先借檐避雨，再试探来意");
    }

    #[test]
    fn wander_ai_resolution_draft_validation_accepts_minimal_valid_shape() {
        let draft = parse_and_validate_wander_ai_episode_resolution_draft(
            r#"{
                "summary":"你借灯试探来意后稳住桥上气机，也逼得桥下暗潮现形，这一幕的因果因此继续滚向更深的冲突。",
                "endingType":"none",
                "rewardTitleName":"",
                "rewardTitleDesc":"",
                "rewardTitleColor":"",
                "rewardTitleEffects":[]
            }"#,
        )
        .expect("resolution draft should validate");
        assert_eq!(draft.ending_type, "none");
        assert_eq!(draft.summary.len() > 20, true);
    }

    #[test]
    fn wander_ai_resolution_draft_accepts_array_title_effects_shape() {
        let draft = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你在《云梦夜航》的终幕中选择了驻足观望，最终借月下潮声看清了整段奇遇的真意，并为自己留下一枚完整的归航印记。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"max_qixue\",\"value\":50},{\"key\":\"wugong\",\"value\":5}]\n            }",
        )
        .expect("array title effects should validate");
        assert_eq!(draft.reward_title_effects.get("max_qixue").copied(), Some(50.0));
        assert_eq!(draft.reward_title_effects.get("wugong").copied(), Some(5.0));
    }

    #[test]
    fn wander_ai_response_formats_use_json_schema_shape() {
        let setup = build_wander_ai_setup_response_format();
        let resolution_continue = build_wander_ai_resolution_response_format(false);
        let resolution_end = build_wander_ai_resolution_response_format(true);
        assert_eq!(setup["type"], "json_schema");
        assert_eq!(setup["json_schema"]["strict"], true);
        assert_eq!(setup["json_schema"]["schema"]["additionalProperties"], false);
        assert_eq!(setup["json_schema"]["schema"]["required"][0], "storyTheme");
        assert_eq!(setup["json_schema"]["schema"]["properties"]["storyTheme"]["minLength"], 2);
        assert_eq!(setup["json_schema"]["schema"]["properties"]["storyPremise"]["maxLength"], 120);
        assert_eq!(setup["json_schema"]["schema"]["properties"]["optionTexts"]["type"], "array");
        assert_eq!(setup["json_schema"]["schema"]["properties"]["optionTexts"]["minItems"], 3);
        assert_eq!(setup["json_schema"]["schema"]["properties"]["optionTexts"]["maxItems"], 3);
        assert_eq!(resolution_continue["type"], "json_schema");
        assert_eq!(resolution_continue["json_schema"]["schema"]["properties"]["endingType"]["const"], "none");
        assert_eq!(resolution_continue["json_schema"]["schema"]["properties"]["rewardTitleName"]["maxLength"], 0);
        assert_eq!(resolution_continue["json_schema"]["schema"]["properties"]["rewardTitleDesc"]["maxLength"], 0);
        assert_eq!(resolution_continue["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["maxItems"], 0);
        assert_eq!(resolution_end["type"], "json_schema");
        assert_eq!(resolution_end["json_schema"]["strict"], true);
        assert_eq!(resolution_end["json_schema"]["schema"]["additionalProperties"], false);
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleName"]["minLength"], 2);
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["minItems"], 1);
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleColor"]["pattern"], "^#[0-9A-Fa-f]{6}$");
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["type"], "array");
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["oneOf"][0]["properties"]["key"]["const"], "max_qixue");
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["oneOf"][0]["properties"]["value"]["type"], "integer");
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["x-max-map"]["max_qixue"], 240);
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["x-max-map"]["wugong"], 60);
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["oneOf"][8]["properties"]["key"]["const"], "mingzhong");
        assert_eq!(resolution_end["json_schema"]["schema"]["properties"]["rewardTitleEffects"]["items"]["oneOf"][8]["properties"]["value"]["type"], "number");
    }

    #[test]
    fn wander_ai_structured_schema_error_detection_matches_node_semantics() {
        assert!(is_unsupported_structured_schema_error("invalid_json_schema"));
        assert!(is_unsupported_structured_schema_error("'allOf' is not permitted"));
        assert!(is_unsupported_structured_schema_error("Invalid schema for response_format"));
        assert!(!is_unsupported_structured_schema_error("network timeout"));
    }

    #[test]
    fn wander_ai_timeout_matches_node_contract() {
        assert_eq!(wander_ai_timeout().as_millis(), 600_000);
    }

    #[test]
    fn wander_ai_resolution_draft_rejects_non_ending_title_fields() {
        let error = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你借灯试探来意后稳住桥上气机，也逼得桥下暗潮现形，这一幕的因果因此继续滚向更深的冲突。\",\n                \"endingType\":\"none\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"max_qixue\",\"value\":50}]\n            }",
        )
        .expect_err("non-ending title fields should be rejected");
        assert!(error.to_string().contains("非终幕"));
    }

    #[test]
    fn wander_ai_resolution_draft_rejects_illegal_title_effects() {
        let error = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你在《云梦夜航》的终幕中选择了驻足观望，最终借月下潮声看清了整段奇遇的真意，并为自己留下一枚完整的归航印记。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"illegal_attr\",\"value\":50}]\n            }",
        )
        .expect_err("illegal title effect should be rejected");
        assert!(error.to_string().contains("非法属性"));
    }

    #[test]
    fn wander_ai_resolution_draft_accepts_valid_title_effects() {
        let draft = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你在《云梦夜航》的终幕中选择了驻足观望，最终借月下潮声看清了整段奇遇的真意，并为自己留下一枚完整的归航印记。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"max_qixue\",\"value\":50},{\"key\":\"wugong\",\"value\":5},{\"key\":\"sudu\",\"value\":3}]\n            }",
        )
        .expect("valid title effects should pass");
        assert_eq!(draft.ending_type, "good");
        assert_eq!(draft.reward_title_name, "云航客");
        assert_eq!(draft.reward_title_effects.get("max_qixue").copied(), Some(50.0));
        assert_eq!(draft.reward_title_effects.get("wugong").copied(), Some(5.0));
        assert_eq!(draft.reward_title_effects.get("sudu").copied(), Some(3.0));
    }

    #[test]
    fn wander_ai_resolution_draft_accepts_five_title_effects() {
        let draft = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你在《云梦夜航》的终幕中迎着桥上回风踏碎残雾，把整段奇遇压成一枚真正归于自身的夜航印记，也让这条路在体魄、攻势与灵息上都留下了持久回响。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"max_qixue\",\"value\":50},{\"key\":\"max_lingqi\",\"value\":30},{\"key\":\"wugong\",\"value\":5},{\"key\":\"fagong\",\"value\":5},{\"key\":\"baoji\",\"value\":0.03}]\n            }",
        )
        .expect("five title effects should pass");
        assert_eq!(draft.reward_title_effects.len(), 5);
        println!("WANDER_TITLE_EFFECT_COUNT={}", draft.reward_title_effects.len());
    }

    #[test]
    fn wander_ai_resolution_draft_rejects_integer_percent_ratio_fields() {
        let error = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你先斩断来客借桥引动的邪法，再回身镇住桥下暗潮，雨夜由此收束成一段险极而成的缘法。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"断桥镇潮\",\n                \"rewardTitleDesc\":\"断桥一战后，余威仍镇河潮。\",\n                \"rewardTitleColor\":\"#faad14\",\n                \"rewardTitleEffects\":[{\"key\":\"wugong\",\"value\":60},{\"key\":\"baoji\",\"value\":15}]\n            }",
        )
        .expect_err("integer percent ratio should fail");
        assert!(error.to_string().contains("超出上限"));
    }

    #[test]
    fn wander_ai_resolution_draft_rejects_non_hex_title_color() {
        let error = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你先斩断来客借桥引动的邪法，再回身镇住桥下暗潮，雨夜由此收束成一段险极而成的缘法。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"断桥镇潮\",\n                \"rewardTitleDesc\":\"断桥一战后，余威仍镇河潮。\",\n                \"rewardTitleColor\":\"#zzzzzz\",\n                \"rewardTitleEffects\":[{\"key\":\"wugong\",\"value\":60},{\"key\":\"baoji\",\"value\":0.03}]\n            }",
        )
        .expect_err("non-hex title color should fail");
        assert!(error.to_string().contains("rewardTitleColor 非法"));
    }

    #[test]
    fn wander_ai_resolution_draft_rejects_prompt_level_hard_cap_exceeded() {
        let error = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你正面压住荒台残兵的最后一道剑压，旧宗荒台的局势终于在你手中定住，但代价也清晰刻进气机深处。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"荒台定锋\",\n                \"rewardTitleDesc\":\"荒台旧锋未灭，余势仍可镇敌。\",\n                \"rewardTitleColor\":\"#faad14\",\n                \"rewardTitleEffects\":[{\"key\":\"wugong\",\"value\":61},{\"key\":\"max_qixue\",\"value\":240}]\n            }",
        )
        .expect_err("wugong above prompt cap should fail");
        assert!(error.to_string().contains("超出上限"));
    }
}
