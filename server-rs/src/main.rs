use anyhow::Context;
use server_rs::bootstrap::shutdown::{shutdown_application, wait_for_shutdown_signal};
use server_rs::bootstrap::startup::{BootstrappedApplication, bootstrap_application};
use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let BootstrappedApplication {
        state,
        router,
        realtime_runtime,
        job_runtime,
    } = bootstrap_application().await?;

    let bind_address = format!("{}:{}", state.config.http.host, state.config.http.port);
    let listener = tokio::net::TcpListener::bind(&bind_address)
        .await
        .with_context(|| format!("failed to bind Rust backend to {bind_address}"))?;

    tracing::info!(bind_address, "Rust backend is ready to accept traffic");

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(wait_for_shutdown_signal())
    .await
    .context("Rust backend server exited with error")?;

    tracing::info!("HTTP server stopped accepting new requests, delegating to shutdown sequence");
    shutdown_application(state, realtime_runtime, job_runtime).await;
    tracing::info!("Rust backend shutdown completed");

    Ok(())
}
