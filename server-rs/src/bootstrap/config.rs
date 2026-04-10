use crate::infra::config::settings::Settings;
use crate::shared::error::AppError;

pub fn load_settings() -> Result<Settings, AppError> {
    Settings::from_environment()
}
