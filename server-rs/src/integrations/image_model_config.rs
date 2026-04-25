use crate::shared::error::AppError;

const DEFAULT_OPENAI_IMAGE_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_DASHSCOPE_IMAGE_ENDPOINT: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_IMAGE_MODEL_NAME: &str = "gpt-image-1";
const DEFAULT_IMAGE_SIZE: &str = "512x512";
const DEFAULT_IMAGE_TIMEOUT_MS: u64 = 15_000;
const DEFAULT_IMAGE_RESPONSE_FORMAT: &str = "b64_json";
const DEFAULT_IMAGE_OUTPUT_FORMAT: &str = "png";
const DEFAULT_IMAGE_MAX_SKILLS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageModelProvider {
    OpenAi,
    DashScope,
}

impl std::fmt::Display for ImageModelProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            ImageModelProvider::OpenAi => "openai",
            ImageModelProvider::DashScope => "dashscope",
        })
    }
}

impl PartialEq<&str> for ImageModelProvider {
    fn eq(&self, other: &&str) -> bool {
        match self {
            ImageModelProvider::OpenAi => other.eq_ignore_ascii_case("openai"),
            ImageModelProvider::DashScope => other.eq_ignore_ascii_case("dashscope"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageModelScope {
    Technique,
    Partner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageModelConfigSnapshot {
    pub provider: ImageModelProvider,
    pub key: String,
    pub model_name: String,
    pub base_url: String,
    pub endpoint: String,
    pub size: String,
    pub timeout_ms: u64,
    pub response_format: String,
    pub quality: Option<String>,
    pub style: Option<String>,
    pub output_format: Option<String>,
    pub max_skills: usize,
}

#[derive(Debug, Clone, Copy)]
struct ImageModelEnvKeys {
    provider: &'static str,
    url: &'static str,
    key: &'static str,
    name: &'static str,
    size: &'static str,
    timeout_ms: &'static str,
    response_format: &'static str,
    quality: &'static str,
    style: &'static str,
    output_format: &'static str,
    max_skills: &'static str,
}

const SHARED_IMAGE_MODEL_ENV_KEYS: ImageModelEnvKeys = ImageModelEnvKeys {
    provider: "AI_IMAGE_MODEL_PROVIDER",
    url: "AI_IMAGE_MODEL_URL",
    key: "AI_IMAGE_MODEL_KEY",
    name: "AI_IMAGE_MODEL_NAME",
    size: "AI_IMAGE_MODEL_SIZE",
    timeout_ms: "AI_IMAGE_MODEL_TIMEOUT_MS",
    response_format: "AI_IMAGE_MODEL_RESPONSE_FORMAT",
    quality: "AI_IMAGE_MODEL_QUALITY",
    style: "AI_IMAGE_MODEL_STYLE",
    output_format: "AI_IMAGE_MODEL_OUTPUT_FORMAT",
    max_skills: "AI_IMAGE_MODEL_MAX_SKILLS",
};

fn scoped_image_model_env_keys(scope: ImageModelScope) -> ImageModelEnvKeys {
    match scope {
        ImageModelScope::Technique => ImageModelEnvKeys {
            provider: "AI_TECHNIQUE_IMAGE_PROVIDER",
            url: "AI_TECHNIQUE_IMAGE_MODEL_URL",
            key: "AI_TECHNIQUE_IMAGE_MODEL_KEY",
            name: "AI_TECHNIQUE_IMAGE_MODEL_NAME",
            size: "AI_TECHNIQUE_IMAGE_SIZE",
            timeout_ms: "AI_TECHNIQUE_IMAGE_TIMEOUT_MS",
            response_format: "AI_TECHNIQUE_IMAGE_RESPONSE_FORMAT",
            quality: "AI_TECHNIQUE_IMAGE_QUALITY",
            style: "AI_TECHNIQUE_IMAGE_STYLE",
            output_format: "AI_TECHNIQUE_IMAGE_OUTPUT_FORMAT",
            max_skills: "AI_TECHNIQUE_IMAGE_MAX_SKILLS",
        },
        ImageModelScope::Partner => ImageModelEnvKeys {
            provider: "AI_PARTNER_IMAGE_PROVIDER",
            url: "AI_PARTNER_IMAGE_MODEL_URL",
            key: "AI_PARTNER_IMAGE_MODEL_KEY",
            name: "AI_PARTNER_IMAGE_MODEL_NAME",
            size: "AI_PARTNER_IMAGE_SIZE",
            timeout_ms: "AI_PARTNER_IMAGE_TIMEOUT_MS",
            response_format: "AI_PARTNER_IMAGE_RESPONSE_FORMAT",
            quality: "AI_PARTNER_IMAGE_QUALITY",
            style: "AI_PARTNER_IMAGE_STYLE",
            output_format: "AI_PARTNER_IMAGE_OUTPUT_FORMAT",
            max_skills: "AI_PARTNER_IMAGE_MAX_SKILLS",
        },
    }
}

fn trim_to_string(value: &str) -> String {
    value.trim().to_string()
}

fn trim_trailing_slashes(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn normalize_openai_base_url(raw: &str) -> String {
    let endpoint = trim_trailing_slashes(raw);
    if endpoint.is_empty() {
        return DEFAULT_OPENAI_IMAGE_BASE_URL.to_string();
    }
    if endpoint
        .to_ascii_lowercase()
        .ends_with("/images/generations")
    {
        return endpoint[..endpoint.len() - "/images/generations".len()].to_string();
    }
    if endpoint.to_ascii_lowercase().ends_with("/v1") {
        return endpoint;
    }
    format!("{endpoint}/v1")
}

fn read_env_value(key: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|value| trim_to_string(&value))
        .unwrap_or_default()
}

fn pair_value<'a>(pairs: &'a [(&str, &str)], key: &str) -> &'a str {
    pairs
        .iter()
        .find_map(|(candidate, value)| (*candidate == key).then_some(*value))
        .unwrap_or_default()
}

fn resolve_pair_value(pairs: &[(&str, &str)], scoped_key: &str, shared_key: &str) -> String {
    let scoped = trim_to_string(pair_value(pairs, scoped_key));
    if !scoped.is_empty() {
        return scoped;
    }
    trim_to_string(pair_value(pairs, shared_key))
}

fn resolve_env_value(scoped_key: &str, shared_key: &str) -> String {
    let scoped = read_env_value(scoped_key);
    if !scoped.is_empty() {
        return scoped;
    }
    read_env_value(shared_key)
}

fn parse_provider(raw: &str) -> Option<ImageModelProvider> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "" | "openai" => Some(ImageModelProvider::OpenAi),
        "dashscope" => Some(ImageModelProvider::DashScope),
        _ => None,
    }
}

fn parse_positive_u64(raw: &str, default_value: u64) -> u64 {
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

fn parse_positive_usize(raw: &str, default_value: usize) -> usize {
    raw.trim()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

fn resolve_url(provider: ImageModelProvider, raw: &str) -> (String, String) {
    match provider {
        ImageModelProvider::OpenAi => {
            let base_url = normalize_openai_base_url(raw);
            (base_url.clone(), format!("{base_url}/images/generations"))
        }
        ImageModelProvider::DashScope => {
            let endpoint = if raw.trim().is_empty() {
                DEFAULT_DASHSCOPE_IMAGE_ENDPOINT.to_string()
            } else {
                raw.trim().to_string()
            };
            (String::new(), endpoint)
        }
    }
}

fn build_image_model_config_from_values(
    scope: ImageModelScope,
    provider_raw: String,
    url_raw: String,
    key: String,
    model_name_raw: String,
    size_raw: String,
    timeout_ms_raw: String,
    response_format_raw: String,
    quality: String,
    style: String,
    output_format: String,
    max_skills_raw: String,
) -> Option<ImageModelConfigSnapshot> {
    if key.trim().is_empty() {
        return None;
    }
    let provider = parse_provider(&provider_raw)?;
    let (base_url, endpoint) = resolve_url(provider, &url_raw);
    let model_name = if model_name_raw.trim().is_empty() {
        match (scope, provider) {
            (_, ImageModelProvider::OpenAi) => DEFAULT_IMAGE_MODEL_NAME.to_string(),
            (_, ImageModelProvider::DashScope) => "qwen-image-2.0".to_string(),
        }
    } else {
        model_name_raw
    };

    Some(ImageModelConfigSnapshot {
        provider,
        key,
        model_name,
        base_url,
        endpoint,
        size: if size_raw.trim().is_empty() {
            DEFAULT_IMAGE_SIZE.to_string()
        } else {
            size_raw
        },
        timeout_ms: parse_positive_u64(&timeout_ms_raw, DEFAULT_IMAGE_TIMEOUT_MS),
        response_format: if response_format_raw.trim().is_empty() {
            DEFAULT_IMAGE_RESPONSE_FORMAT.to_string()
        } else {
            response_format_raw
        },
        quality: (!quality.trim().is_empty()).then_some(quality),
        style: (!style.trim().is_empty()).then_some(style),
        output_format: if output_format.trim().is_empty() {
            Some(DEFAULT_IMAGE_OUTPUT_FORMAT.to_string())
        } else {
            Some(output_format)
        },
        max_skills: parse_positive_usize(&max_skills_raw, DEFAULT_IMAGE_MAX_SKILLS),
    })
}

pub fn read_image_model_config(scope: ImageModelScope) -> Option<ImageModelConfigSnapshot> {
    let scoped = scoped_image_model_env_keys(scope);
    build_image_model_config_from_values(
        scope,
        resolve_env_value(scoped.provider, SHARED_IMAGE_MODEL_ENV_KEYS.provider),
        resolve_env_value(scoped.url, SHARED_IMAGE_MODEL_ENV_KEYS.url),
        resolve_env_value(scoped.key, SHARED_IMAGE_MODEL_ENV_KEYS.key),
        resolve_env_value(scoped.name, SHARED_IMAGE_MODEL_ENV_KEYS.name),
        resolve_env_value(scoped.size, SHARED_IMAGE_MODEL_ENV_KEYS.size),
        resolve_env_value(scoped.timeout_ms, SHARED_IMAGE_MODEL_ENV_KEYS.timeout_ms),
        resolve_env_value(
            scoped.response_format,
            SHARED_IMAGE_MODEL_ENV_KEYS.response_format,
        ),
        resolve_env_value(scoped.quality, SHARED_IMAGE_MODEL_ENV_KEYS.quality),
        resolve_env_value(scoped.style, SHARED_IMAGE_MODEL_ENV_KEYS.style),
        resolve_env_value(
            scoped.output_format,
            SHARED_IMAGE_MODEL_ENV_KEYS.output_format,
        ),
        resolve_env_value(scoped.max_skills, SHARED_IMAGE_MODEL_ENV_KEYS.max_skills),
    )
}

pub fn read_image_model_config_from_pairs<'a>(
    scope: ImageModelScope,
    pairs: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Option<ImageModelConfigSnapshot> {
    let pairs: Vec<(&str, &str)> = pairs.into_iter().collect();
    let scoped = scoped_image_model_env_keys(scope);
    build_image_model_config_from_values(
        scope,
        resolve_pair_value(
            &pairs,
            scoped.provider,
            SHARED_IMAGE_MODEL_ENV_KEYS.provider,
        ),
        resolve_pair_value(&pairs, scoped.url, SHARED_IMAGE_MODEL_ENV_KEYS.url),
        resolve_pair_value(&pairs, scoped.key, SHARED_IMAGE_MODEL_ENV_KEYS.key),
        resolve_pair_value(&pairs, scoped.name, SHARED_IMAGE_MODEL_ENV_KEYS.name),
        resolve_pair_value(&pairs, scoped.size, SHARED_IMAGE_MODEL_ENV_KEYS.size),
        resolve_pair_value(
            &pairs,
            scoped.timeout_ms,
            SHARED_IMAGE_MODEL_ENV_KEYS.timeout_ms,
        ),
        resolve_pair_value(
            &pairs,
            scoped.response_format,
            SHARED_IMAGE_MODEL_ENV_KEYS.response_format,
        ),
        resolve_pair_value(&pairs, scoped.quality, SHARED_IMAGE_MODEL_ENV_KEYS.quality),
        resolve_pair_value(&pairs, scoped.style, SHARED_IMAGE_MODEL_ENV_KEYS.style),
        resolve_pair_value(
            &pairs,
            scoped.output_format,
            SHARED_IMAGE_MODEL_ENV_KEYS.output_format,
        ),
        resolve_pair_value(
            &pairs,
            scoped.max_skills,
            SHARED_IMAGE_MODEL_ENV_KEYS.max_skills,
        ),
    )
}

pub fn require_image_model_config(
    scope: ImageModelScope,
) -> Result<ImageModelConfigSnapshot, AppError> {
    read_image_model_config(scope).ok_or_else(|| {
        let message = match scope {
            ImageModelScope::Technique => {
                "缺少或无效 AI_TECHNIQUE_IMAGE_MODEL_KEY / AI_IMAGE_MODEL_KEY / AI_TECHNIQUE_IMAGE_PROVIDER 配置"
            }
            ImageModelScope::Partner => {
                "缺少或无效 AI_PARTNER_IMAGE_MODEL_KEY / AI_IMAGE_MODEL_KEY / AI_PARTNER_IMAGE_PROVIDER 配置"
            }
        };
        AppError::config(message)
    })
}

#[cfg(test)]
mod tests {
    use super::{ImageModelProvider, ImageModelScope, read_image_model_config_from_pairs};

    #[test]
    fn image_model_config_reads_shared_defaults_and_scope_overrides() {
        let technique = read_image_model_config_from_pairs(
            ImageModelScope::Technique,
            [
                ("AI_IMAGE_MODEL_KEY", "shared-key"),
                ("AI_IMAGE_MODEL_NAME", "shared-model"),
                ("AI_PARTNER_IMAGE_MODEL_KEY", "partner-key"),
                ("AI_PARTNER_IMAGE_MODEL_NAME", "partner-model"),
            ],
        )
        .expect("shared technique config should load");
        let partner = read_image_model_config_from_pairs(
            ImageModelScope::Partner,
            [
                ("AI_IMAGE_MODEL_KEY", "shared-key"),
                ("AI_IMAGE_MODEL_NAME", "shared-model"),
                ("AI_PARTNER_IMAGE_MODEL_KEY", "partner-key"),
                ("AI_PARTNER_IMAGE_MODEL_NAME", "partner-model"),
            ],
        )
        .expect("partner override config should load");

        assert_eq!(technique.provider, ImageModelProvider::OpenAi);
        assert_eq!(technique.key, "shared-key");
        assert_eq!(technique.model_name, "shared-model");
        assert_eq!(technique.base_url, "https://api.openai.com/v1");
        assert_eq!(
            technique.endpoint,
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(partner.key, "partner-key");
        assert_eq!(partner.model_name, "partner-model");
    }

    #[test]
    fn image_model_config_reads_technique_max_skills_from_scoped_env() {
        let config = read_image_model_config_from_pairs(
            ImageModelScope::Technique,
            [
                ("AI_IMAGE_MODEL_KEY", "shared-key"),
                ("AI_IMAGE_MODEL_MAX_SKILLS", "2"),
                ("AI_TECHNIQUE_IMAGE_MAX_SKILLS", "7"),
            ],
        )
        .expect("technique image config should load");

        assert_eq!(config.max_skills, 7);
    }

    #[test]
    fn image_model_config_reads_shared_max_skills_and_defaults_invalid_values() {
        let shared = read_image_model_config_from_pairs(
            ImageModelScope::Technique,
            [
                ("AI_IMAGE_MODEL_KEY", "shared-key"),
                ("AI_IMAGE_MODEL_MAX_SKILLS", "6"),
            ],
        )
        .expect("shared technique image config should load");
        let invalid = read_image_model_config_from_pairs(
            ImageModelScope::Technique,
            [
                ("AI_IMAGE_MODEL_KEY", "shared-key"),
                ("AI_TECHNIQUE_IMAGE_MAX_SKILLS", "0"),
            ],
        )
        .expect("invalid max skills still keeps config");

        assert_eq!(shared.max_skills, 6);
        assert_eq!(invalid.max_skills, 4);
    }

    #[test]
    fn image_model_config_returns_none_when_key_is_empty() {
        let config = read_image_model_config_from_pairs(
            ImageModelScope::Technique,
            [
                ("AI_IMAGE_MODEL_PROVIDER", "openai"),
                ("AI_IMAGE_MODEL_KEY", " "),
            ],
        );

        assert!(config.is_none());
    }

    #[test]
    fn image_model_config_preserves_dashscope_endpoint() {
        let config = read_image_model_config_from_pairs(
            ImageModelScope::Partner,
            [
                ("AI_IMAGE_MODEL_PROVIDER", "dashscope"),
                ("AI_IMAGE_MODEL_KEY", "key"),
                (
                    "AI_IMAGE_MODEL_URL",
                    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation/",
                ),
            ],
        )
        .expect("dashscope config should load");

        assert_eq!(config.provider, ImageModelProvider::DashScope);
        assert_eq!(config.base_url, "");
        assert_eq!(
            config.endpoint,
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation/"
        );
    }
}
