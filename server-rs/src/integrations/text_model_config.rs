use crate::shared::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextModelScope {
    Technique,
    Partner,
    Wander,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextModelProvider {
    OpenAi,
    Anthropic,
}

impl std::fmt::Display for TextModelProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            TextModelProvider::OpenAi => "openai",
            TextModelProvider::Anthropic => "anthropic",
        })
    }
}

impl PartialEq<&str> for TextModelProvider {
    fn eq(&self, other: &&str) -> bool {
        match self {
            TextModelProvider::OpenAi => other.eq_ignore_ascii_case("openai"),
            TextModelProvider::Anthropic => other.eq_ignore_ascii_case("anthropic"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextModelConfigSnapshot {
    pub provider: TextModelProvider,
    pub url: String,
    pub key: String,
    pub model_name: String,
}

struct TextModelEnvKeys {
    provider: &'static str,
    url: &'static str,
    key: &'static str,
    name: &'static str,
}

fn text_model_env_keys(scope: TextModelScope) -> TextModelEnvKeys {
    match scope {
        TextModelScope::Technique => TextModelEnvKeys {
            provider: "AI_TECHNIQUE_MODEL_PROVIDER",
            url: "AI_TECHNIQUE_MODEL_URL",
            key: "AI_TECHNIQUE_MODEL_KEY",
            name: "AI_TECHNIQUE_MODEL_NAME",
        },
        TextModelScope::Partner => TextModelEnvKeys {
            provider: "AI_PARTNER_MODEL_PROVIDER",
            url: "AI_PARTNER_MODEL_URL",
            key: "AI_PARTNER_MODEL_KEY",
            name: "AI_PARTNER_MODEL_NAME",
        },
        TextModelScope::Wander => TextModelEnvKeys {
            provider: "AI_WANDER_MODEL_PROVIDER",
            url: "AI_WANDER_MODEL_URL",
            key: "AI_WANDER_MODEL_KEY",
            name: "AI_WANDER_MODEL_NAME",
        },
    }
}

fn default_model_name(scope: TextModelScope) -> &'static str {
    match scope {
        TextModelScope::Technique | TextModelScope::Partner => "gpt-4o",
        TextModelScope::Wander => "gpt-4.1-mini",
    }
}

fn env_string(key: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn trim_trailing_slashes(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn read_text_model_provider(key: &str) -> Option<TextModelProvider> {
    match env_string(key).to_ascii_lowercase().as_str() {
        "" | "openai" => Some(TextModelProvider::OpenAi),
        "anthropic" => Some(TextModelProvider::Anthropic),
        _ => None,
    }
}

fn resolve_text_model_url(provider: TextModelProvider, key: &str) -> String {
    let configured = trim_trailing_slashes(&env_string(key));
    if !configured.is_empty() {
        return configured;
    }

    match provider {
        TextModelProvider::OpenAi => "https://api.openai.com/v1".to_string(),
        TextModelProvider::Anthropic => "https://api.anthropic.com".to_string(),
    }
}

fn resolve_text_model_name(key: &str, scope: TextModelScope) -> String {
    env_string(key)
        .split(',')
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_model_name(scope).to_string())
}

pub fn read_text_model_config(scope: TextModelScope) -> Option<TextModelConfigSnapshot> {
    let env_keys = text_model_env_keys(scope);
    let key = env_string(env_keys.key);
    if key.is_empty() {
        return None;
    }
    let provider = read_text_model_provider(env_keys.provider)?;
    let url = resolve_text_model_url(provider, env_keys.url);
    let model_name = resolve_text_model_name(env_keys.name, scope);

    Some(TextModelConfigSnapshot {
        provider,
        url,
        key,
        model_name,
    })
}

pub fn require_text_model_config(
    scope: TextModelScope,
) -> Result<TextModelConfigSnapshot, AppError> {
    read_text_model_config(scope).ok_or_else(|| {
        let message = match scope {
            TextModelScope::Technique => {
                "缺少或无效 AI_TECHNIQUE_MODEL_KEY / AI_TECHNIQUE_MODEL_PROVIDER 配置"
            }
            TextModelScope::Partner => {
                "缺少或无效 AI_PARTNER_MODEL_KEY / AI_PARTNER_MODEL_PROVIDER 配置"
            }
            TextModelScope::Wander => {
                "缺少或无效 AI_WANDER_MODEL_KEY / AI_WANDER_MODEL_PROVIDER 配置"
            }
        };
        AppError::config(message)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, OnceLock};

    use super::{
        TextModelProvider, TextModelScope, read_text_model_config, require_text_model_config,
    };

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    const TEXT_MODEL_ENV_KEYS: [&str; 12] = [
        "AI_TECHNIQUE_MODEL_PROVIDER",
        "AI_TECHNIQUE_MODEL_URL",
        "AI_TECHNIQUE_MODEL_KEY",
        "AI_TECHNIQUE_MODEL_NAME",
        "AI_PARTNER_MODEL_PROVIDER",
        "AI_PARTNER_MODEL_URL",
        "AI_PARTNER_MODEL_KEY",
        "AI_PARTNER_MODEL_NAME",
        "AI_WANDER_MODEL_PROVIDER",
        "AI_WANDER_MODEL_URL",
        "AI_WANDER_MODEL_KEY",
        "AI_WANDER_MODEL_NAME",
    ];

    fn with_clean_text_model_env(test: impl FnOnce()) {
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let original: Vec<(&str, Option<String>)> = TEXT_MODEL_ENV_KEYS
            .iter()
            .map(|key| (*key, std::env::var(key).ok()))
            .collect();
        unsafe {
            for key in TEXT_MODEL_ENV_KEYS {
                std::env::remove_var(key);
            }
        }

        test();

        unsafe {
            for (key, value) in original {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    #[test]
    fn read_text_model_config_uses_default_openai_url() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "technique-key");
            }

            let snapshot = read_text_model_config(TextModelScope::Technique)
                .expect("technique config should load");

            assert_eq!(snapshot.provider, TextModelProvider::OpenAi);
            assert_eq!(snapshot.url, "https://api.openai.com/v1");
            assert_eq!(snapshot.key, "technique-key");
            assert_eq!(snapshot.model_name, "gpt-4o");
        });
    }

    #[test]
    fn read_text_model_config_trims_openai_trailing_slashes() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", " OpenAI ");
                std::env::set_var("AI_TECHNIQUE_MODEL_URL", " https://example.com/v1/// ");
                std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "technique-key");
            }

            let snapshot = read_text_model_config(TextModelScope::Technique)
                .expect("technique config should load");

            assert_eq!(snapshot.provider, TextModelProvider::OpenAi);
            assert_eq!(snapshot.url, "https://example.com/v1");
        });
    }

    #[test]
    fn read_text_model_config_reads_anthropic_provider_and_default_url() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_PARTNER_MODEL_PROVIDER", " Anthropic ");
                std::env::set_var("AI_PARTNER_MODEL_KEY", "partner-key");
            }

            let snapshot = read_text_model_config(TextModelScope::Partner)
                .expect("partner config should load");

            assert_eq!(snapshot.provider, TextModelProvider::Anthropic);
            assert_eq!(snapshot.url, "https://api.anthropic.com");
            assert_eq!(snapshot.key, "partner-key");
            assert_eq!(snapshot.model_name, "gpt-4o");
        });
    }

    #[test]
    fn read_text_model_config_reads_wander_env_keys() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_WANDER_MODEL_PROVIDER", "openai");
                std::env::set_var("AI_WANDER_MODEL_URL", "https://wander.example.com/v1/");
                std::env::set_var("AI_WANDER_MODEL_KEY", "wander-key");
            }

            let snapshot =
                read_text_model_config(TextModelScope::Wander).expect("wander config should load");

            assert_eq!(snapshot.provider, TextModelProvider::OpenAi);
            assert_eq!(snapshot.url, "https://wander.example.com/v1");
            assert_eq!(snapshot.key, "wander-key");
            assert_eq!(snapshot.model_name, "gpt-4.1-mini");
        });
    }

    #[test]
    fn read_text_model_config_uses_first_non_empty_model_candidate() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "technique-key");
                std::env::set_var("AI_TECHNIQUE_MODEL_NAME", " , gpt-4.1-mini, gpt-4o ");
            }

            let snapshot = read_text_model_config(TextModelScope::Technique)
                .expect("technique config should load");

            assert_eq!(snapshot.model_name, "gpt-4.1-mini");
        });
    }

    #[test]
    fn read_text_model_config_returns_none_without_key() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_TECHNIQUE_MODEL_URL", "https://example.com/v1");
                std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "   ");
            }

            assert!(read_text_model_config(TextModelScope::Technique).is_none());
        });
    }

    #[test]
    fn read_text_model_config_returns_none_for_unknown_provider() {
        with_clean_text_model_env(|| {
            unsafe {
                std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", "dashscope");
                std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "technique-key");
            }

            assert!(read_text_model_config(TextModelScope::Technique).is_none());
        });
    }

    #[test]
    fn require_text_model_config_reports_wander_scope() {
        with_clean_text_model_env(|| {
            let error = require_text_model_config(TextModelScope::Wander)
                .expect_err("wander config should be required");
            assert!(error.to_string().contains("AI_WANDER_MODEL_KEY"));
        });
    }
}
