use std::collections::HashMap;
use std::net::IpAddr;
use std::str::FromStr;

use config::{Config, File, FileFormat};
use serde::Deserialize;

use crate::shared::error::AppError;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct Settings {
    pub server: ServerSettings,
    pub database: DatabaseSettings,
    pub redis: RedisSettings,
    pub auth: AuthSettings,
    pub captcha: CaptchaSettings,
    pub logging: LoggingSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ServerSettings {
    pub host: IpAddr,
    pub port: u16,
    pub cors_origin: String,
    pub environment: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct DatabaseSettings {
    pub url: String,
    pub max_connections: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RedisSettings {
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct AuthSettings {
    pub jwt_secret: String,
    pub jwt_expires_in: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct CaptchaSettings {
    pub provider: String,
    pub tencent_app_id: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct LoggingSettings {
    pub filter: String,
    pub json: bool,
}

impl Settings {
    pub fn from_environment() -> Result<Self, AppError> {
        let mut values = default_map();
        merge_legacy_environment(&mut values);
        Self::build_from_map(values)
    }

    pub fn from_map(overrides: HashMap<String, String>) -> Result<Self, AppError> {
        let mut values = default_map();
        values.extend(overrides);
        Self::build_from_map(values)
    }

    fn build_from_map(values: HashMap<String, String>) -> Result<Self, AppError> {
        let config = Config::builder()
            .add_source(File::from_str(&map_to_toml(&values), FileFormat::Toml))
            .build()
            .map_err(|error| AppError::Config(error.to_string()))?;
        let mut settings: Settings = config
            .try_deserialize()
            .map_err(|error| AppError::Config(error.to_string()))?;

        if settings.server.port == 0 {
            return Err(AppError::Config(
                "server.port must be greater than 0".to_string(),
            ));
        }

        if settings.logging.filter.trim().is_empty() {
            settings.logging.filter = "info".to_string();
        }

        Ok(settings)
    }
}

fn merge_legacy_environment(values: &mut HashMap<String, String>) {
    apply_env(values, "HOST", "server.host");
    apply_env(values, "PORT", "server.port");
    apply_env(values, "CORS_ORIGIN", "server.cors_origin");
    apply_env(values, "NODE_ENV", "server.environment");
    apply_env(values, "DATABASE_URL", "database.url");
    apply_env(values, "DB_POOL_MAX", "database.max_connections");
    apply_env(values, "REDIS_URL", "redis.url");
    apply_env(values, "JWT_SECRET", "auth.jwt_secret");
    apply_env(values, "JWT_EXPIRES_IN", "auth.jwt_expires_in");
    apply_env(values, "CAPTCHA_PROVIDER", "captcha.provider");
    apply_env(values, "TENCENT_CAPTCHA_APP_ID", "captcha.tencent_app_id");
    apply_env(values, "RUST_LOG", "logging.filter");
    apply_env(values, "LOG_FILTER", "logging.filter");
    apply_env(values, "LOG_JSON", "logging.json");
}

fn apply_env(values: &mut HashMap<String, String>, env_key: &str, config_key: &str) {
    if let Ok(value) = std::env::var(env_key) {
        values.insert(config_key.to_string(), value);
    }
}

fn default_map() -> HashMap<String, String> {
    HashMap::from([
        ("server.host".to_string(), "0.0.0.0".to_string()),
        ("server.port".to_string(), "6011".to_string()),
        (
            "server.cors_origin".to_string(),
            "http://localhost:6010".to_string(),
        ),
        ("server.environment".to_string(), "development".to_string()),
        (
            "database.url".to_string(),
            "postgresql://postgres:postgres@localhost:5432/jiuzhou".to_string(),
        ),
        ("database.max_connections".to_string(), "20".to_string()),
        (
            "redis.url".to_string(),
            "redis://localhost:6379".to_string(),
        ),
        ("auth.jwt_secret".to_string(), "change-me".to_string()),
        ("auth.jwt_expires_in".to_string(), "7d".to_string()),
        ("captcha.provider".to_string(), "local".to_string()),
        ("captcha.tencent_app_id".to_string(), "0".to_string()),
        ("logging.filter".to_string(), "info".to_string()),
        ("logging.json".to_string(), "false".to_string()),
    ])
}

fn map_to_toml(values: &HashMap<String, String>) -> String {
    let host = values
        .get("server.host")
        .cloned()
        .unwrap_or_else(|| "0.0.0.0".to_string());
    let host = IpAddr::from_str(&host).unwrap_or(IpAddr::from([0, 0, 0, 0]));
    format!(
        r#"
[server]
host = "{host}"
port = {port}
cors_origin = "{cors_origin}"
environment = "{environment}"

[database]
url = "{database_url}"
max_connections = {database_max_connections}

[redis]
url = "{redis_url}"

[auth]
jwt_secret = "{jwt_secret}"
jwt_expires_in = "{jwt_expires_in}"

[captcha]
provider = "{captcha_provider}"
tencent_app_id = {captcha_tencent_app_id}

[logging]
filter = "{logging_filter}"
json = {logging_json}
"#,
        port = values
            .get("server.port")
            .map(String::as_str)
            .unwrap_or("6011"),
        cors_origin = values
            .get("server.cors_origin")
            .map(String::as_str)
            .unwrap_or("http://localhost:6010"),
        environment = values
            .get("server.environment")
            .map(String::as_str)
            .unwrap_or("development"),
        database_url = values
            .get("database.url")
            .map(String::as_str)
            .unwrap_or("postgresql://postgres:postgres@localhost:5432/jiuzhou"),
        database_max_connections = values
            .get("database.max_connections")
            .map(String::as_str)
            .unwrap_or("20"),
        redis_url = values
            .get("redis.url")
            .map(String::as_str)
            .unwrap_or("redis://localhost:6379"),
        jwt_secret = values
            .get("auth.jwt_secret")
            .map(String::as_str)
            .unwrap_or("change-me"),
        jwt_expires_in = values
            .get("auth.jwt_expires_in")
            .map(String::as_str)
            .unwrap_or("7d"),
        captcha_provider = values
            .get("captcha.provider")
            .map(String::as_str)
            .unwrap_or("local"),
        captcha_tencent_app_id = values
            .get("captcha.tencent_app_id")
            .map(String::as_str)
            .unwrap_or("0"),
        logging_filter = values
            .get("logging.filter")
            .map(String::as_str)
            .unwrap_or("info"),
        logging_json = values
            .get("logging.json")
            .map(String::as_str)
            .unwrap_or("false"),
    )
}
