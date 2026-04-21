use anyhow::Context;
use server_rs::config::AppConfig;
use server_rs::integrations::database;
use server_rs::shared::tracing::init_tracing;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("failed to load Rust backend configuration")?;
    init_tracing(&config.logging.level, &config.service.node_env)
        .context("failed to initialize Rust backend tracing")?;

    tracing::info!("→ sqlx migration database probe");
    let database = database::connect(&config.database).await?;
    tracing::info!("✓ sqlx migration database ready");

    let migration_summary = database.apply_migrations().await?;
    tracing::info!(
        adopted_existing_schema_as_baseline = migration_summary.adopted_existing_schema_as_baseline,
        previously_applied_migration_count = migration_summary.previously_applied_migration_count,
        total_applied_migration_count = migration_summary.total_applied_migration_count,
        newly_applied_migration_count = migration_summary.newly_applied_migration_count,
        "✓ sqlx migrations applied"
    );

    database.close().await;
    Ok(())
}
