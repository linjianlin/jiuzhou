use tracing_subscriber::fmt;
use tracing_subscriber::EnvFilter;

use crate::infra::config::settings::Settings;
use crate::shared::error::AppError;

pub fn init_tracing(settings: &Settings) -> Result<(), AppError> {
    let filter = EnvFilter::try_new(settings.logging.filter.clone())
        .map_err(|error| AppError::Logging(error.to_string()))?;

    let subscriber = fmt().with_env_filter(filter);
    let result = if settings.logging.json {
        subscriber.json().try_init()
    } else {
        subscriber.try_init()
    };

    match result {
        Ok(()) => Ok(()),
        Err(_already_set) => Ok(()),
    }
}
