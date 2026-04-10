use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::edge::http::error::BusinessError;

pub const DEFAULT_LIMIT_MESSAGE: &str = "请求过于频繁，请稍后再试";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QpsLimitConfig {
    pub key_prefix: String,
    pub limit: u32,
    pub window_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct QpsLimitResponse {
    pub success: bool,
    pub message: String,
}

impl QpsLimitConfig {
    pub fn new(
        key_prefix: impl Into<String>,
        limit: u32,
        window_ms: u64,
        message: Option<String>,
    ) -> Result<Self, BusinessError> {
        let key_prefix = key_prefix.into().trim().to_string();
        if key_prefix.is_empty() {
            return Err(BusinessError::new("keyPrefix 不能为空"));
        }
        if limit == 0 {
            return Err(BusinessError::new("limit 必须是正整数"));
        }
        if window_ms == 0 {
            return Err(BusinessError::new("windowMs 必须是正整数"));
        }

        Ok(Self {
            key_prefix,
            limit,
            window_ms,
            message: message
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| DEFAULT_LIMIT_MESSAGE.to_string()),
        })
    }

    pub fn redis_key(&self, scope: QpsLimitScope, now_ms: u64) -> Result<String, BusinessError> {
        let scope = scope.normalize()?;
        let current_window = now_ms / self.window_ms;
        Ok(format!("{}:{}:{}", self.key_prefix, scope, current_window))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QpsLimitScope {
    Number(i64),
    Text(String),
}

impl QpsLimitScope {
    fn normalize(self) -> Result<String, BusinessError> {
        match self {
            Self::Number(value) if value > 0 => Ok(value.to_string()),
            Self::Number(_) => Err(BusinessError::new("QPS 限流作用域必须是正整数")),
            Self::Text(value) => {
                let value = value.trim().to_string();
                if value.is_empty() {
                    Err(BusinessError::new("QPS 限流作用域不能为空字符串"))
                } else {
                    Ok(value)
                }
            }
        }
    }
}

pub fn limit_exceeded_response(message: impl Into<String>) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(QpsLimitResponse {
            success: false,
            message: message.into(),
        }),
    )
        .into_response()
}
