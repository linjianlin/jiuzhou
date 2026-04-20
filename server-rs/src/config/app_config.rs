use std::path::{Path, PathBuf};

use config::{Config, Environment};
use serde::Deserialize;

use crate::shared::error::AppError;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub service: ServiceConfig,
    pub http: HttpConfig,
    pub wander: WanderConfig,
    pub captcha: CaptchaConfig,
    pub market_phone_binding: MarketPhoneBindingConfig,
    pub database: DatabaseConfig,
    pub redis: RedisConfig,
    pub outbound_http: OutboundHttpConfig,
    pub storage: StorageConfig,
    pub cos: CosConfig,
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone)]
pub struct ServiceConfig {
    pub name: String,
    pub version: String,
    pub node_env: String,
    pub jwt_secret: String,
    pub jwt_expires_in: String,
}

#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub host: String,
    pub port: u16,
    pub cors_origin: String,
}

#[derive(Debug, Clone)]
pub struct WanderConfig {
    pub ai_enabled: bool,
    pub model_provider: String,
    pub model_url: String,
    pub model_key: String,
    pub model_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptchaProvider {
    Local,
    Tencent,
}

#[derive(Debug, Clone)]
pub struct CaptchaConfig {
    pub provider: CaptchaProvider,
    pub tencent_app_id: u64,
    pub tencent_app_secret_key: String,
    pub tencent_secret_id: String,
    pub tencent_secret_key: String,
}

#[derive(Debug, Clone)]
pub struct MarketPhoneBindingConfig {
    pub enabled: bool,
    pub aliyun_access_key_id: String,
    pub aliyun_access_key_secret: String,
    pub sign_name: String,
    pub template_code: String,
    pub code_expire_seconds: u64,
    pub send_cooldown_seconds: u64,
    pub send_hourly_limit: u64,
    pub send_daily_limit: u64,
}

#[derive(Debug, Clone)]
pub struct DatabaseConfig {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct RedisConfig {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct OutboundHttpConfig {
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub uploads_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CosConfig {
    pub secret_id: String,
    pub secret_key: String,
    pub bucket: String,
    pub region: String,
    pub avatar_prefix: String,
    pub generated_image_prefix: String,
    pub domain: String,
    pub sts_duration_seconds: u64,
}

#[derive(Debug, Clone)]
pub struct LoggingConfig {
    pub level: String,
}

#[derive(Debug, Deserialize)]
struct RawSettings {
    service_name: String,
    service_version: String,
    node_env: String,
    jwt_secret: String,
    jwt_expires_in: String,
    host: String,
    port: u16,
    cors_origin: String,
    wander_ai_enabled: bool,
    ai_wander_model_provider: String,
    ai_wander_model_url: String,
    ai_wander_model_key: String,
    ai_wander_model_name: String,
    captcha_provider: String,
    tencent_captcha_app_id: u64,
    tencent_captcha_app_secret_key: String,
    tencent_captcha_secret_id: String,
    tencent_captcha_secret_key: String,
    market_phone_binding_enabled: bool,
    aliyun_access_key_id: String,
    aliyun_access_key_secret: String,
    aliyun_sms_sign_name: String,
    aliyun_sms_verify_template_code: String,
    market_phone_binding_code_expire_seconds: u64,
    market_phone_binding_send_cooldown_seconds: u64,
    market_phone_binding_send_hourly_limit: u64,
    market_phone_binding_send_daily_limit: u64,
    database_url: Option<String>,
    redis_url: String,
    http_client_timeout_ms: u64,
    uploads_dir: String,
    cos_secret_id: String,
    cos_secret_key: String,
    cos_bucket: String,
    cos_region: String,
    cos_avatar_prefix: String,
    cos_generated_image_prefix: String,
    cos_domain: String,
    cos_sts_duration_seconds: u64,
    log_level: String,
}

impl AppConfig {
    pub fn load() -> Result<Self, AppError> {
        load_env_files();

        let settings = Config::builder()
            .set_default("service_name", "九州修仙录 Rust Backend")?
            .set_default("service_version", env!("CARGO_PKG_VERSION"))?
            .set_default("node_env", "development")?
            .set_default("jwt_secret", "jiuzhou-xiuxian-secret-key")?
            .set_default("jwt_expires_in", "7d")?
            .set_default("host", "0.0.0.0")?
            .set_default("port", 6011)?
            .set_default("cors_origin", "*")?
            .set_default("wander_ai_enabled", false)?
            .set_default("ai_wander_model_provider", "openai")?
            .set_default("ai_wander_model_url", "")?
            .set_default("ai_wander_model_key", "")?
            .set_default("ai_wander_model_name", "")?
            .set_default("captcha_provider", "local")?
            .set_default("tencent_captcha_app_id", 0)?
            .set_default("tencent_captcha_app_secret_key", "")?
            .set_default("tencent_captcha_secret_id", "")?
            .set_default("tencent_captcha_secret_key", "")?
            .set_default("market_phone_binding_enabled", false)?
            .set_default("aliyun_access_key_id", "")?
            .set_default("aliyun_access_key_secret", "")?
            .set_default("aliyun_sms_sign_name", "")?
            .set_default("aliyun_sms_verify_template_code", "")?
            .set_default("market_phone_binding_code_expire_seconds", 300)?
            .set_default("market_phone_binding_send_cooldown_seconds", 60)?
            .set_default("market_phone_binding_send_hourly_limit", 5)?
            .set_default("market_phone_binding_send_daily_limit", 10)?
            .set_default("redis_url", "redis://localhost:6379")?
            .set_default("http_client_timeout_ms", 15_000)?
            .set_default("uploads_dir", "../server/uploads")?
            .set_default("cos_secret_id", "")?
            .set_default("cos_secret_key", "")?
            .set_default("cos_bucket", "")?
            .set_default("cos_region", "")?
            .set_default("cos_avatar_prefix", "avatars/")?
            .set_default("cos_generated_image_prefix", "jiuzhou/generated/")?
            .set_default("cos_domain", "")?
            .set_default("cos_sts_duration_seconds", 600)?
            .set_default("log_level", "info")?
            .add_source(Environment::default().try_parsing(true))
            .build()?;

        let raw = settings.try_deserialize::<RawSettings>()?;
        let database_url = raw
            .database_url
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::config("DATABASE_URL is required for server-rs startup"))?;

        Ok(Self {
            service: ServiceConfig {
                name: raw.service_name,
                version: raw.service_version,
                node_env: raw.node_env,
                jwt_secret: raw.jwt_secret,
                jwt_expires_in: raw.jwt_expires_in,
            },
            http: HttpConfig {
                host: raw.host,
                port: raw.port,
                cors_origin: raw.cors_origin,
            },
            wander: WanderConfig {
                ai_enabled: raw.wander_ai_enabled,
                model_provider: raw.ai_wander_model_provider,
                model_url: raw.ai_wander_model_url,
                model_key: raw.ai_wander_model_key,
                model_name: raw.ai_wander_model_name,
            },
            captcha: CaptchaConfig {
                provider: parse_captcha_provider(&raw.captcha_provider),
                tencent_app_id: raw.tencent_captcha_app_id,
                tencent_app_secret_key: raw.tencent_captcha_app_secret_key,
                tencent_secret_id: raw.tencent_captcha_secret_id,
                tencent_secret_key: raw.tencent_captcha_secret_key,
            },
            market_phone_binding: MarketPhoneBindingConfig {
                enabled: raw.market_phone_binding_enabled,
                aliyun_access_key_id: raw.aliyun_access_key_id,
                aliyun_access_key_secret: raw.aliyun_access_key_secret,
                sign_name: raw.aliyun_sms_sign_name,
                template_code: raw.aliyun_sms_verify_template_code,
                code_expire_seconds: raw.market_phone_binding_code_expire_seconds.max(1),
                send_cooldown_seconds: raw.market_phone_binding_send_cooldown_seconds.max(1),
                send_hourly_limit: raw.market_phone_binding_send_hourly_limit.max(1),
                send_daily_limit: raw.market_phone_binding_send_daily_limit.max(1),
            },
            database: DatabaseConfig { url: database_url },
            redis: RedisConfig { url: raw.redis_url },
            outbound_http: OutboundHttpConfig {
                timeout_ms: raw.http_client_timeout_ms,
            },
            storage: StorageConfig {
                uploads_dir: PathBuf::from(raw.uploads_dir),
            },
            cos: CosConfig {
                secret_id: raw.cos_secret_id,
                secret_key: raw.cos_secret_key,
                bucket: raw.cos_bucket,
                region: raw.cos_region,
                avatar_prefix: raw.cos_avatar_prefix,
                generated_image_prefix: raw.cos_generated_image_prefix,
                domain: raw.cos_domain.trim_end_matches('/').to_string(),
                sts_duration_seconds: raw.cos_sts_duration_seconds.clamp(60, 7_200),
            },
            logging: LoggingConfig {
                level: raw.log_level,
            },
        })
    }
}

fn load_env_files() {
    let mut loaded_any = false;

    for candidate in [Path::new("server-rs/.env"), Path::new(".env")] {
        if candidate.is_file() {
            let _ = dotenvy::from_path(candidate);
            loaded_any = true;
        }
    }

    if !loaded_any {
        let _ = dotenvy::dotenv();
    }
}

fn parse_captcha_provider(raw: &str) -> CaptchaProvider {
    if raw.trim().eq_ignore_ascii_case("tencent") {
        CaptchaProvider::Tencent
    } else {
        CaptchaProvider::Local
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::collections::BTreeMap;
    use std::sync::{Mutex, OnceLock};

    use super::AppConfig;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> &'static Mutex<()> {
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn load_reads_wander_ai_enabled_from_env() {
        let _guard = env_lock().lock().expect("env lock should acquire");
        let keys = [
            "DATABASE_URL",
            "WANDER_AI_ENABLED",
            "AI_WANDER_MODEL_PROVIDER",
            "AI_WANDER_MODEL_URL",
            "AI_WANDER_MODEL_KEY",
            "AI_WANDER_MODEL_NAME",
        ];
        let previous = keys
            .iter()
            .map(|key| ((*key).to_string(), std::env::var(key).ok()))
            .collect::<BTreeMap<_, _>>();

        unsafe {
            std::env::set_var(
                "DATABASE_URL",
                "postgresql://postgres:postgres@localhost:5432/jiuzhou",
            );
            std::env::set_var("WANDER_AI_ENABLED", "true");
            std::env::set_var("AI_WANDER_MODEL_PROVIDER", "openai");
            std::env::set_var("AI_WANDER_MODEL_URL", "https://example.com/v1");
            std::env::set_var("AI_WANDER_MODEL_KEY", "test-key");
            std::env::set_var("AI_WANDER_MODEL_NAME", "test-model");
        }

        let config = AppConfig::load().expect("config should load from env");
        assert!(config.wander.ai_enabled);
        assert_eq!(config.wander.model_provider, "openai");
        assert_eq!(config.wander.model_url, "https://example.com/v1");
        assert_eq!(config.wander.model_key, "test-key");
        assert_eq!(config.wander.model_name, "test-model");

        for (key, value) in previous {
            unsafe {
                if let Some(value) = value {
                    std::env::set_var(&key, value);
                } else {
                    std::env::remove_var(&key);
                }
            }
        }
    }

    #[test]
    fn load_reads_database_url_from_server_rs_env_when_started_at_repo_root() {
        let _guard = env_lock().lock().expect("env lock should acquire");
        let current_dir = std::env::current_dir().expect("current dir should resolve");
        let temp_dir = std::env::temp_dir().join(format!(
            "server-rs-config-root-startup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time should be after epoch")
                .as_nanos()
        ));
        let server_rs_dir = temp_dir.join("server-rs");
        fs::create_dir_all(&server_rs_dir).expect("server-rs temp dir should create");
        fs::write(
            server_rs_dir.join(".env"),
            [
                "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/jiuzhou",
                "REDIS_URL=redis://localhost:6379",
            ]
            .join("\n"),
        )
        .expect("temp .env should write");

        let keys = ["DATABASE_URL", "REDIS_URL"];
        let previous = keys
            .iter()
            .map(|key| ((*key).to_string(), std::env::var(key).ok()))
            .collect::<BTreeMap<_, _>>();

        for key in keys {
            unsafe {
                std::env::remove_var(key);
            }
        }

        std::env::set_current_dir(&temp_dir).expect("current dir should switch to repo root temp dir");

        let config = AppConfig::load().expect("config should load from server-rs/.env fallback");
        assert_eq!(
            config.database.url,
            "postgresql://postgres:postgres@localhost:5432/jiuzhou"
        );
        assert_eq!(config.redis.url, "redis://localhost:6379");

        std::env::set_current_dir(&current_dir).expect("current dir should restore");
        for (key, value) in previous {
            unsafe {
                if let Some(value) = value {
                    std::env::set_var(&key, value);
                } else {
                    std::env::remove_var(&key);
                }
            }
        }
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
