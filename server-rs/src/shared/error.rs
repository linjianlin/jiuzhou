use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error(transparent)]
    ConfigSource(#[from] config::ConfigError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Redis(#[from] redis::RedisError),
    #[error(transparent)]
    HttpClient(#[from] reqwest::Error),
    #[error(transparent)]
    AddressParse(#[from] http::header::InvalidHeaderValue),
    #[error("{0}")]
    TransactionRollbackOnly(String),
    #[error("{message}")]
    Business {
        message: String,
        status: StatusCode,
        extra: Map<String, Value>,
    },
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    success: bool,
    message: String,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

impl AppError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::Business {
            message: message.into(),
            status: StatusCode::UNAUTHORIZED,
            extra: Map::new(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Business {
            message: message.into(),
            status: StatusCode::NOT_FOUND,
            extra: Map::new(),
        }
    }

    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::Business {
            message: message.into(),
            status: StatusCode::SERVICE_UNAVAILABLE,
            extra: Map::new(),
        }
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self::Business {
            message: message.into(),
            status: StatusCode::TOO_MANY_REQUESTS,
            extra: Map::new(),
        }
    }

    pub fn with_extra(mut self, key: &str, value: impl Into<Value>) -> Self {
        if let Self::Business { extra, .. } = &mut self {
            extra.insert(key.to_string(), value.into());
        }
        self
    }

    pub fn client_message(&self) -> &str {
        match self {
            Self::Config(message) => message,
            Self::ConfigSource(_) => "configuration error",
            Self::Io(_) => "io error",
            Self::Database(_) => "database error",
            Self::Redis(_) => "redis error",
            Self::HttpClient(_) => "http client error",
            Self::AddressParse(_) => "invalid header value",
            Self::TransactionRollbackOnly(message) => message,
            Self::Business { message, .. } => message,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Config(_) | Self::ConfigSource(_) | Self::AddressParse(_) => {
                StatusCode::BAD_REQUEST
            }
            Self::TransactionRollbackOnly(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::Io(_) | Self::Database(_) | Self::Redis(_) | Self::HttpClient(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::Business { status, .. } => *status,
        };

        let message = self.to_string();
        tracing::error!(%message, "request failed");
        eprintln!(
            "APP_ERROR_RESPONSE={message}\nBACKTRACE={}",
            std::backtrace::Backtrace::capture()
        );

        let extra = match self {
            Self::Business { extra, .. } => extra,
            _ => Map::new(),
        };

        (
            status,
            Json(ErrorResponse {
                success: false,
                message,
                extra,
            }),
        )
            .into_response()
    }
}
