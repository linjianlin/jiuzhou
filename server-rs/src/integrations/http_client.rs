use std::time::Duration;

use crate::config::OutboundHttpConfig;
use crate::shared::error::AppError;

pub fn build(config: &OutboundHttpConfig) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms))
        .build()
        .map_err(AppError::from)
}
