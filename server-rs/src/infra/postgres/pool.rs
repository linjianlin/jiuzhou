use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::infra::config::settings::Settings;
use crate::shared::error::AppError;

#[derive(Clone)]
pub struct AppPostgres {
    pub pool: PgPool,
}

pub async fn build_postgres(settings: &Settings) -> Result<AppPostgres, AppError> {
    let pool = PgPoolOptions::new()
        .max_connections(settings.database.max_connections)
        .connect_lazy(&settings.database.url)?;

    Ok(AppPostgres { pool })
}

pub async fn verify_postgres(postgres: &AppPostgres) -> Result<(), AppError> {
    postgres.pool.acquire().await?;
    Ok(())
}
