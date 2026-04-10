use std::net::SocketAddr;
use std::time::Duration;

use tokio::net::TcpListener;
use tracing::info;

use crate::application::achievement::service::RustAchievementRouteService;
use crate::application::afdian::service::RustAfdianRouteService;
use crate::application::attribute::service::RustAttributeRouteService;
use crate::application::auth::service::RustAuthServices;
use crate::application::battle_pass::service::RustBattlePassRouteService;
use crate::application::game::service::RustGameRouteService;
use crate::application::idle::service::RustIdleRouteService;
use crate::application::info::service::RustInfoService;
use crate::application::insight::service::RustInsightRouteService;
use crate::application::inventory::service::RustInventoryReadService;
use crate::application::month_card::service::RustMonthCardRouteService;
use crate::application::rank::service::RustRankRouteService;
use crate::application::realm::service::RustRealmRouteService;
use crate::application::redeem_code::service::RustRedeemCodeRouteService;
use crate::application::time::service::RustTimeService;
use crate::application::title::service::RustTitleRouteService;
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
    let session_registry = new_shared_session_registry();

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
    > = std::sync::Arc::new(RustUploadService::new(postgres.pool.clone()));
    let afdian_services: std::sync::Arc<
        dyn crate::edge::http::routes::afdian::AfdianRouteServices,
    > = std::sync::Arc::new(RustAfdianRouteService::new());

    let state = AppState {
        afdian_services,
        achievement_services: std::sync::Arc::new(RustAchievementRouteService::new(
            postgres.pool.clone(),
        )),
        auth_services,
        attribute_services: std::sync::Arc::new(RustAttributeRouteService::new(
            postgres.pool.clone(),
        )),
        battle_pass_services: std::sync::Arc::new(RustBattlePassRouteService::new(
            postgres.pool.clone(),
        )),
        game_services: std::sync::Arc::new(RustGameRouteService::new(
            postgres.pool.clone(),
            redis.client.clone(),
            runtime_services.clone(),
            session_registry.clone(),
        )),
        idle_services,
        info_services: std::sync::Arc::new(RustInfoService::new(postgres.pool.clone())),
        insight_services: std::sync::Arc::new(RustInsightRouteService::new(postgres.pool.clone())),
        inventory_services: std::sync::Arc::new(RustInventoryReadService::new(
            postgres.pool.clone(),
        )),
        month_card_services: std::sync::Arc::new(RustMonthCardRouteService::new(
            postgres.pool.clone(),
        )),
        rank_services: std::sync::Arc::new(RustRankRouteService::new(postgres.pool.clone())),
        realm_services: std::sync::Arc::new(RustRealmRouteService::new(postgres.pool.clone())),
        redeem_code_services: std::sync::Arc::new(RustRedeemCodeRouteService::new(
            postgres.pool.clone(),
            redis.client.clone(),
        )),
        time_services: std::sync::Arc::new(RustTimeService::new()),
        title_services: std::sync::Arc::new(RustTitleRouteService::new(postgres.pool.clone())),
        upload_services,
        game_socket_services,
        settings,
        readiness,
        session_registry,
        runtime_services: runtime_services.clone(),
    };
    let startup_execution = execute_with_runtime_target(&startup_context, runtime_services).await?;
    info!(startup_stages = ?startup_execution.stages, "startup pipeline completed");

    let _shutdown_plan = ShutdownPlan::new(Duration::from_secs(30));
    let router = build_router(state.clone());
    let listener = bind_listener(&state.settings).await?;
    let local_addr = listener.local_addr().map_err(AppError::Io)?;
    info!(%local_addr, ready = state.readiness.is_ready(), "rust backend listening after startup ready");
    axum::serve(listener, router).await.map_err(AppError::Io)
}

async fn bind_listener(
    settings: &crate::infra::config::settings::Settings,
) -> Result<TcpListener, AppError> {
    let address = SocketAddr::new(settings.server.host, settings.server.port);
    TcpListener::bind(address).await.map_err(AppError::Io)
}
