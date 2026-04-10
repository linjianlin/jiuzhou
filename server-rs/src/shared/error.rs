use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum AppError {
    Config(String),
    Io(std::io::Error),
    Sqlx(sqlx::Error),
    Redis(redis::RedisError),
    SerdeJson(serde_json::Error),
    Logging(String),
}

impl Display for AppError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(message) => write!(formatter, "config error: {message}"),
            Self::Io(error) => write!(formatter, "io error: {error}"),
            Self::Sqlx(error) => write!(formatter, "sqlx error: {error}"),
            Self::Redis(error) => write!(formatter, "redis error: {error}"),
            Self::SerdeJson(error) => write!(formatter, "serde json error: {error}"),
            Self::Logging(message) => write!(formatter, "logging error: {message}"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        Self::Sqlx(value)
    }
}

impl From<redis::RedisError> for AppError {
    fn from(value: redis::RedisError) -> Self {
        Self::Redis(value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::SerdeJson(value)
    }
}
