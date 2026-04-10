use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpListener;
use tracing::{error, info};

use crate::application::afdian::service::RustAfdianRouteService;
use crate::application::auth::service::RustAuthServices;
use crate::application::idle::service::RustIdleRouteService;
use crate::application::upload::service::RustUploadService;
use crate::bootstrap::app::{
    build_router, new_shared_runtime_services, AppState, RuntimeServicesState,
};
use crate::bootstrap::config::load_settings;
use crate::bootstrap::readiness::ReadinessGate;
use crate::bootstrap::shutdown::ShutdownPlan;
use crate::bootstrap::startup::{execute_with_runtime_target, StartupContext};
use crate::infra::logging::init_tracing;
use crate::infra::postgres::pool::build_postgres;
use crate::infra::redis::client::build_redis;
use crate::runtime::connection::session_registry::new_shared_session_registry;
use crate::shared::error::AppError;

pub async fn run_application() -> Result<(), AppError> {
    let settings = load_settings()?;
    init_tracing(&settings)?;

    let postgres = build_postgres(&settings).await?;
    let redis = build_redis(&settings).await?;
    let readiness = ReadinessGate::new();
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());

    let startup_context = StartupContext {
        settings: settings.clone(),
        postgres: postgres.clone(),
        redis: redis.clone(),
        readiness: readiness.clone(),
    };

    let auth_services_impl = std::sync::Arc::new(RustAuthServices::new(
        postgres.pool.clone(),
        redis.client.clone(),
        settings.auth.jwt_secret.clone(),
        settings.auth.jwt_expires_in.clone(),
        match settings.captcha.provider.as_str() {
            "tencent" => crate::edge::http::routes::auth::CaptchaProvider::Tencent,
            _ => crate::edge::http::routes::auth::CaptchaProvider::Local,
        },
        runtime_services.clone(),
    ));
    let auth_services: std::sync::Arc<dyn crate::edge::http::routes::auth::AuthRouteServices> =
        auth_services_impl.clone();
    let idle_services: std::sync::Arc<dyn crate::edge::http::routes::idle::IdleRouteServices> =
        std::sync::Arc::new(RustIdleRouteService::new(
            postgres.pool.clone(),
            redis.client.clone(),
            runtime_services.clone(),
        ));
    let game_socket_services: std::sync::Arc<
        dyn crate::edge::socket::game_socket::GameSocketAuthServices,
    > = auth_services_impl.clone();
    let upload_services: std::sync::Arc<
        dyn crate::edge::http::routes::upload::UploadRouteServices,
    > = std::sync::Arc::new(RustUploadService::new());
    let afdian_services: std::sync::Arc<
        dyn crate::edge::http::routes::afdian::AfdianRouteServices,
    > = std::sync::Arc::new(RustAfdianRouteService::new());

    let state = AppState {
        afdian_services,
        auth_services,
        idle_services,
        upload_services,
        game_socket_services,
        settings,
        readiness,
        session_registry: new_shared_session_registry(),
        runtime_services: runtime_services.clone(),
    };
    let router = build_router(state.clone());
    let listener = bind_listener(&state.settings).await?;
    let local_addr = listener.local_addr().map_err(AppError::Io)?;
    info!(%local_addr, ready = false, "rust backend listening while startup continues");

    spawn_background_startup(async move {
        let startup_execution =
            execute_with_runtime_target(&startup_context, runtime_services).await?;
        info!(startup_stages = ?startup_execution.stages, "startup pipeline completed");
        Ok(())
    });

    let _shutdown_plan = ShutdownPlan::new(Duration::from_secs(30));
    axum::serve(listener, router).await.map_err(AppError::Io)
}

pub fn spawn_background_startup<F>(startup_future: F) -> tokio::task::JoinHandle<()>
where
    F: std::future::Future<Output = Result<(), AppError>> + Send + 'static,
{
    tokio::spawn(async move {
        if let Err(error) = startup_future.await {
            error!(%error, "startup pipeline failed after listener bind");
        }
    })
}

async fn bind_listener(
    settings: &crate::infra::config::settings::Settings,
) -> Result<TcpListener, AppError> {
    let address = SocketAddr::new(settings.server.host, settings.server.port);
    TcpListener::bind(address).await.map_err(AppError::Io)
}
