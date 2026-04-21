use crate::shared::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextModelScope {
    Technique,
    Partner,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextModelConfigSnapshot {
    pub provider: String,
    pub url: String,
    pub key: String,
    pub model_name: String,
}

pub fn read_text_model_config(scope: TextModelScope) -> Option<TextModelConfigSnapshot> {
    let (provider_key, url_key, key_key, name_key) = match scope {
        TextModelScope::Technique => (
            "AI_TECHNIQUE_MODEL_PROVIDER",
            "AI_TECHNIQUE_MODEL_URL",
            "AI_TECHNIQUE_MODEL_KEY",
            "AI_TECHNIQUE_MODEL_NAME",
        ),
        TextModelScope::Partner => (
            "AI_PARTNER_MODEL_PROVIDER",
            "AI_PARTNER_MODEL_URL",
            "AI_PARTNER_MODEL_KEY",
            "AI_PARTNER_MODEL_NAME",
        ),
    };
    let url = std::env::var(url_key)
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let key = std::env::var(key_key)
        .ok()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if url.is_empty() || key.is_empty() {
        return None;
    }
    let provider = std::env::var(provider_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "openai".to_string());
    let model_name = std::env::var(name_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
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
                "缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置"
            }
            TextModelScope::Partner => "缺少 AI_PARTNER_MODEL_URL 或 AI_PARTNER_MODEL_KEY 配置",
        };
        AppError::config(message)
    })
}

#[cfg(test)]
mod tests {
    use super::{TextModelScope, read_text_model_config};

    #[test]
    fn read_text_model_config_returns_none_without_required_keys() {
        unsafe {
            std::env::remove_var("AI_TECHNIQUE_MODEL_URL");
            std::env::remove_var("AI_TECHNIQUE_MODEL_KEY");
        }
        assert!(read_text_model_config(TextModelScope::Technique).is_none());
    }

    #[test]
    fn read_text_model_config_reads_technique_envs() {
        unsafe {
            std::env::set_var("AI_TECHNIQUE_MODEL_PROVIDER", "openai");
            std::env::set_var(
                "AI_TECHNIQUE_MODEL_URL",
                "https://technique.example.com/v1/chat/completions",
            );
            std::env::set_var("AI_TECHNIQUE_MODEL_KEY", "technique-key");
            std::env::set_var("AI_TECHNIQUE_MODEL_NAME", "technique-model");
        }
        let snapshot = read_text_model_config(TextModelScope::Technique)
            .expect("technique config should load");
        assert_eq!(snapshot.provider, "openai");
        assert_eq!(snapshot.model_name, "technique-model");
        println!("TEXT_MODEL_CONFIG_PROVIDER={}", snapshot.provider);
        unsafe {
            std::env::remove_var("AI_TECHNIQUE_MODEL_PROVIDER");
            std::env::remove_var("AI_TECHNIQUE_MODEL_URL");
            std::env::remove_var("AI_TECHNIQUE_MODEL_KEY");
            std::env::remove_var("AI_TECHNIQUE_MODEL_NAME");
        }
    }
}
