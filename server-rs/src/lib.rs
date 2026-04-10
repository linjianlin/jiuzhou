pub mod application;
pub mod bootstrap;
pub mod domain;
pub mod edge;
pub mod infra;
pub mod runtime;
pub mod shared;

pub async fn run() -> Result<(), shared::error::AppError> {
    bootstrap::lifecycle::run_application().await
}
