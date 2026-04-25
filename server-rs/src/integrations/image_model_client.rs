use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::integrations::image_model_config::{ImageModelConfigSnapshot, ImageModelProvider};
use crate::shared::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageModelCallRequest {
    pub prompt: String,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub style: Option<String>,
    pub output_format: Option<String>,
    pub response_format: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageModelCallResult {
    pub b64: String,
    pub url: String,
    pub provider: ImageModelProvider,
    pub model_name: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageGenerationEnvelope {
    data: Option<Vec<OpenAiImageGenerationItem>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiImageGenerationItem {
    b64_json: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DashScopeEnvelope {
    output: Option<Value>,
}

fn as_trimmed_string(value: Option<String>) -> String {
    value
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn image_mime_from_output_format(output_format: Option<&str>) -> Result<&'static str, AppError> {
    match output_format
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        value => Err(AppError::config(format!(
            "图片模型 output_format 不支持或缺失: {value}"
        ))),
    }
}

pub fn normalize_generated_image_b64_for_storage(
    raw: &str,
    output_format: Option<&str>,
) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.to_ascii_lowercase().starts_with("data:image/") {
        return Ok(trimmed.to_string());
    }
    let mime = image_mime_from_output_format(output_format)?;
    Ok(format!("data:{mime};base64,{trimmed}"))
}

fn normalize_image_result_for_storage(
    mut result: ImageModelCallResult,
    config: &ImageModelConfigSnapshot,
) -> Result<ImageModelCallResult, AppError> {
    result.b64 =
        normalize_generated_image_b64_for_storage(&result.b64, config.output_format.as_deref())?;
    Ok(result)
}

pub fn build_openai_image_generation_payload(
    model_name: &str,
    request: &ImageModelCallRequest,
) -> Value {
    let mut payload = json!({
        "model": model_name,
        "prompt": request.prompt,
    });
    if let Some(size) = request
        .size
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["size"] = json!(size.trim());
    }
    if let Some(response_format) = request
        .response_format
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["response_format"] = json!(response_format.trim());
    }
    if let Some(quality) = request
        .quality
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["quality"] = json!(quality.trim());
    }
    if let Some(style) = request
        .style
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["style"] = json!(style.trim());
    }
    if let Some(output_format) = request
        .output_format
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        payload["output_format"] = json!(output_format.trim());
    }
    payload
}

pub fn normalize_size_for_dashscope(size: &str) -> String {
    let compact = size.split_whitespace().collect::<String>();
    if compact.contains('*') {
        compact
    } else {
        compact.replace(['x', 'X'], "*")
    }
}

pub fn build_dashscope_image_generation_payload(
    model_name: &str,
    request: &ImageModelCallRequest,
) -> Value {
    json!({
        "model": model_name,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{
                    "text": request.prompt,
                }],
            }],
        },
        "parameters": {
            "size": normalize_size_for_dashscope(request.size.as_deref().unwrap_or("512x512")),
            "n": 1,
            "prompt_extend": true,
            "watermark": false,
        },
    })
}

pub fn parse_openai_image_generation_response(
    body: &str,
    provider: ImageModelProvider,
    model_name: &str,
) -> Result<ImageModelCallResult, AppError> {
    let envelope: OpenAiImageGenerationEnvelope = serde_json::from_str(body).map_err(|error| {
        AppError::config(format!("OpenAI 图片模型响应解析失败: {error}; body={body}"))
    })?;
    let image = envelope
        .data
        .and_then(|items| items.into_iter().next())
        .ok_or_else(|| AppError::config("OpenAI 图片模型响应缺少 data[0]"))?;

    Ok(ImageModelCallResult {
        b64: as_trimmed_string(image.b64_json),
        url: as_trimmed_string(image.url),
        provider,
        model_name: model_name.to_string(),
    })
}

fn read_string_field(row: &Value, key: &str) -> String {
    row.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn read_dashscope_asset(output: &Value) -> (String, String) {
    if let Some(first_result) = output
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
    {
        let b64 = read_string_field(first_result, "b64_image");
        let url = read_string_field(first_result, "url");
        if !b64.is_empty() || !url.is_empty() {
            return (b64, url);
        }
    }

    let content_list = output
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);

    let Some(content_list) = content_list else {
        return (String::new(), String::new());
    };

    for content in content_list {
        let url = read_string_field(content, "image");
        let url = if url.is_empty() {
            read_string_field(content, "url")
        } else {
            url
        };
        let b64 = read_string_field(content, "b64_image");
        if !url.is_empty() || !b64.is_empty() {
            return (b64, url);
        }
    }

    (String::new(), String::new())
}

pub fn parse_dashscope_image_generation_response(
    body: &str,
    provider: ImageModelProvider,
    model_name: &str,
) -> Result<ImageModelCallResult, AppError> {
    let envelope: DashScopeEnvelope = serde_json::from_str(body).map_err(|error| {
        AppError::config(format!(
            "DashScope 图片模型响应解析失败: {error}; body={body}"
        ))
    })?;
    let output = envelope
        .output
        .ok_or_else(|| AppError::config("DashScope 图片模型响应缺少 output"))?;
    let (b64, url) = read_dashscope_asset(&output);

    Ok(ImageModelCallResult {
        b64,
        url,
        provider,
        model_name: model_name.to_string(),
    })
}

async fn post_json(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    payload: &Value,
    dashscope_headers: bool,
    timeout_ms: u64,
) -> Result<String, AppError> {
    let mut builder = client
        .post(endpoint)
        .timeout(Duration::from_millis(timeout_ms))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .bearer_auth(api_key)
        .json(payload);
    if dashscope_headers {
        builder = builder.header("X-DashScope-Async", "disable");
    }
    let response = builder.send().await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(AppError::config(format!(
            "图像模型请求失败：HTTP {} {}",
            status.as_u16(),
            body
        )));
    }
    if body.trim().is_empty() {
        return Err(AppError::config("图像模型返回空响应"));
    }
    Ok(body)
}

pub async fn call_image_model(
    client: &reqwest::Client,
    config: &ImageModelConfigSnapshot,
    request: &ImageModelCallRequest,
) -> Result<ImageModelCallResult, AppError> {
    match config.provider {
        ImageModelProvider::OpenAi => {
            let payload = build_openai_image_generation_payload(&config.model_name, request);
            let body = post_json(
                client,
                &config.endpoint,
                &config.key,
                &payload,
                false,
                config.timeout_ms,
            )
            .await?;
            normalize_image_result_for_storage(
                parse_openai_image_generation_response(&body, config.provider, &config.model_name)?,
                config,
            )
        }
        ImageModelProvider::DashScope => {
            let payload = build_dashscope_image_generation_payload(&config.model_name, request);
            let body = post_json(
                client,
                &config.endpoint,
                &config.key,
                &payload,
                true,
                config.timeout_ms,
            )
            .await?;
            normalize_image_result_for_storage(
                parse_dashscope_image_generation_response(
                    &body,
                    config.provider,
                    &config.model_name,
                )?,
                config,
            )
        }
    }
}

pub fn request_from_config(
    prompt: impl Into<String>,
    config: &ImageModelConfigSnapshot,
) -> ImageModelCallRequest {
    ImageModelCallRequest {
        prompt: prompt.into(),
        size: Some(config.size.clone()),
        quality: config.quality.clone(),
        style: config.style.clone(),
        output_format: config.output_format.clone(),
        response_format: Some(config.response_format.clone()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::integrations::image_model_config::ImageModelProvider;

    use super::{
        ImageModelCallRequest, build_dashscope_image_generation_payload,
        build_openai_image_generation_payload, normalize_generated_image_b64_for_storage,
        parse_dashscope_image_generation_response, parse_openai_image_generation_response,
    };

    fn request() -> ImageModelCallRequest {
        ImageModelCallRequest {
            prompt: "画一朵花".to_string(),
            size: Some("512x512".to_string()),
            quality: Some("standard".to_string()),
            style: Some("vivid".to_string()),
            output_format: Some("png".to_string()),
            response_format: Some("b64_json".to_string()),
        }
    }

    #[test]
    fn image_model_client_builds_openai_payload() {
        let payload = build_openai_image_generation_payload("gpt-image-1", &request());

        assert_eq!(
            payload,
            json!({
                "model": "gpt-image-1",
                "prompt": "画一朵花",
                "size": "512x512",
                "response_format": "b64_json",
                "quality": "standard",
                "style": "vivid",
                "output_format": "png",
            })
        );
    }

    #[test]
    fn image_model_client_builds_dashscope_payload() {
        let payload = build_dashscope_image_generation_payload("qwen-image-2.0", &request());

        assert_eq!(payload["model"], "qwen-image-2.0");
        assert_eq!(payload["input"]["messages"][0]["role"], "user");
        assert_eq!(
            payload["input"]["messages"][0]["content"][0]["text"],
            "画一朵花"
        );
        assert_eq!(payload["parameters"]["size"], "512*512");
        assert_eq!(payload["parameters"]["n"], 1);
        assert_eq!(payload["parameters"]["prompt_extend"], true);
        assert_eq!(payload["parameters"]["watermark"], false);
    }

    #[test]
    fn image_model_client_parses_openai_b64_and_url() {
        let result = parse_openai_image_generation_response(
            r#"{"data":[{"b64_json":"data:image/png;base64,aGVsbG8=","url":"https://example.com/a.png"}]}"#,
            ImageModelProvider::OpenAi,
            "gpt-image-1",
        )
        .expect("openai response should parse");

        assert_eq!(result.b64, "data:image/png;base64,aGVsbG8=");
        assert_eq!(result.url, "https://example.com/a.png");
        assert_eq!(result.provider, ImageModelProvider::OpenAi);
        assert_eq!(result.model_name, "gpt-image-1");
    }

    #[test]
    fn image_model_client_parses_dashscope_results_and_choices() {
        let result = parse_dashscope_image_generation_response(
            r#"{"output":{"results":[{"b64_image":"data:image/webp;base64,d2VicA==","url":""}]}}"#,
            ImageModelProvider::DashScope,
            "qwen-image-2.0",
        )
        .expect("dashscope results response should parse");
        let choice_result = parse_dashscope_image_generation_response(
            r#"{"output":{"choices":[{"message":{"content":[{"image":"https://example.com/image.png"}]}}]}}"#,
            ImageModelProvider::DashScope,
            "qwen-image-2.0",
        )
        .expect("dashscope choices response should parse");

        assert_eq!(result.b64, "data:image/webp;base64,d2VicA==");
        assert_eq!(choice_result.url, "https://example.com/image.png");
    }

    #[test]
    fn image_model_client_wraps_bare_b64_with_configured_mime() {
        let result = normalize_generated_image_b64_for_storage("aGVsbG8=", Some("webp"))
            .expect("webp b64 should normalize");

        assert_eq!(result, "data:image/webp;base64,aGVsbG8=");
    }
}
