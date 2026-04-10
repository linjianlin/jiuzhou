use crate::bootstrap::app::{
    new_shared_runtime_services, RuntimeServicesState, SharedRuntimeServices,
};
use crate::bootstrap::readiness::ReadinessGate;
use crate::infra::config::settings::Settings;
use crate::infra::postgres::pool::verify_postgres;
use crate::infra::postgres::pool::AppPostgres;
use crate::infra::redis::client::AppRedis;
use crate::runtime::battle::{build_battle_runtime_registry_from_snapshot, BattleRuntimeRegistry};
use crate::runtime::idle::{build_idle_runtime_service_from_snapshot, IdleRuntimeService};
use crate::runtime::projection::service::{
    build_online_projection_registry_from_snapshot, OnlineProjectionRegistry,
    RuntimeRecoveryLoader, RuntimeRecoverySnapshot,
};
use crate::runtime::session::{
    build_battle_session_registry_from_snapshot, BattleSessionRuntimeRegistry,
};
use crate::runtime::tower::{build_tower_runtime_registry_from_snapshot, TowerRuntimeRegistry};
use crate::shared::error::AppError;

#[derive(Clone)]
pub struct StartupContext {
    pub settings: Settings,
    pub postgres: AppPostgres,
    pub redis: AppRedis,
    pub readiness: ReadinessGate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupStage {
    ConfigLoaded,
    PostgresReady,
    RedisReady,
    WarmupPrepared,
    RecoveryPrepared,
    Ready,
}

#[derive(Clone)]
pub struct StartupExecution {
    pub stages: Vec<StartupStage>,
    pub runtime_services: SharedRuntimeServices,
}

pub async fn execute(context: &StartupContext) -> Result<Vec<StartupStage>, AppError> {
    Ok(execute_with_runtime(context).await?.stages)
}

pub async fn load_runtime_recovery(
    context: &StartupContext,
) -> Result<RuntimeRecoverySnapshot, AppError> {
    RuntimeRecoveryLoader::load_from_redis(&context.redis).await
}

pub fn build_battle_runtime_registry(
    _context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<BattleRuntimeRegistry, AppError> {
    build_battle_runtime_registry_from_snapshot(snapshot)
}

pub fn build_session_runtime_registry(
    _context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<BattleSessionRuntimeRegistry, AppError> {
    build_battle_session_registry_from_snapshot(snapshot)
}

pub fn build_online_projection_registry(
    _context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<OnlineProjectionRegistry, AppError> {
    build_online_projection_registry_from_snapshot(snapshot)
}

pub fn build_idle_runtime_service(
    _context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<IdleRuntimeService, AppError> {
    build_idle_runtime_service_from_snapshot(snapshot)
}

pub fn build_tower_runtime_registry(
    _context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<TowerRuntimeRegistry, AppError> {
    build_tower_runtime_registry_from_snapshot(snapshot)
}

pub fn build_runtime_services(
    context: &StartupContext,
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<RuntimeServicesState, AppError> {
    Ok(RuntimeServicesState {
        battle_registry: build_battle_runtime_registry(context, snapshot)?,
        session_registry: build_session_runtime_registry(context, snapshot)?,
        online_projection_registry: build_online_projection_registry(context, snapshot)?,
        idle_runtime_service: build_idle_runtime_service(context, snapshot)?,
        tower_runtime_registry: build_tower_runtime_registry(context, snapshot)?,
    })
}

pub async fn execute_with_runtime(context: &StartupContext) -> Result<StartupExecution, AppError> {
    let recovery = load_runtime_recovery(context).await?;
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        |_| {},
        true,
    )
    .await
}

pub async fn execute_with_runtime_target(
    context: &StartupContext,
    runtime_services: SharedRuntimeServices,
) -> Result<StartupExecution, AppError> {
    let recovery = load_runtime_recovery(context).await?;
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        |_| {},
        true,
    )
    .await
}

pub async fn execute_with_recovery(
    context: &StartupContext,
    recovery: RuntimeRecoverySnapshot,
) -> Result<StartupExecution, AppError> {
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        |_| {},
        false,
    )
    .await
}

pub async fn execute_with_recovery_target(
    context: &StartupContext,
    recovery: RuntimeRecoverySnapshot,
    runtime_services: SharedRuntimeServices,
) -> Result<StartupExecution, AppError> {
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        |_| {},
        false,
    )
    .await
}

pub async fn execute_with_recovery_and_observer<F>(
    context: &StartupContext,
    recovery: RuntimeRecoverySnapshot,
    mut observer: F,
) -> Result<StartupExecution, AppError>
where
    F: FnMut(StartupStage),
{
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        &mut observer,
        false,
    )
    .await
}

pub async fn execute_with_recovery_target_and_observer<F>(
    context: &StartupContext,
    recovery: RuntimeRecoverySnapshot,
    runtime_services: SharedRuntimeServices,
    observer: F,
) -> Result<StartupExecution, AppError>
where
    F: FnMut(StartupStage),
{
    execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        observer,
        false,
    )
    .await
}

async fn execute_with_recovery_target_and_observer_internal<F>(
    context: &StartupContext,
    recovery: RuntimeRecoverySnapshot,
    runtime_services: SharedRuntimeServices,
    mut observer: F,
    verify_dependencies: bool,
) -> Result<StartupExecution, AppError>
where
    F: FnMut(StartupStage),
{
    let runtime_state = build_runtime_services(context, &recovery)?;
    execute_prepared(
        context,
        runtime_services,
        runtime_state,
        &mut observer,
        verify_dependencies,
    )
    .await
}

pub async fn execute_with_observer<F>(
    context: &StartupContext,
    mut observer: F,
) -> Result<Vec<StartupStage>, AppError>
where
    F: FnMut(StartupStage),
{
    let recovery = load_runtime_recovery(context).await?;
    let runtime_services = new_shared_runtime_services(RuntimeServicesState::default());
    Ok(execute_with_recovery_target_and_observer_internal(
        context,
        recovery,
        runtime_services,
        |stage| observer(stage),
        true,
    )
    .await?
    .stages)
}

async fn execute_prepared<F>(
    context: &StartupContext,
    runtime_services: SharedRuntimeServices,
    runtime_state: RuntimeServicesState,
    observer: &mut F,
    verify_dependencies: bool,
) -> Result<StartupExecution, AppError>
where
    F: FnMut(StartupStage),
{
    let mut executed = Vec::with_capacity(6);

    observer(StartupStage::ConfigLoaded);
    executed.push(StartupStage::ConfigLoaded);

    if verify_dependencies {
        verify_postgres(&context.postgres).await?;
    }
    observer(StartupStage::PostgresReady);
    executed.push(StartupStage::PostgresReady);

    observer(StartupStage::RedisReady);
    executed.push(StartupStage::RedisReady);

    observer(StartupStage::WarmupPrepared);
    executed.push(StartupStage::WarmupPrepared);

    observer(StartupStage::RecoveryPrepared);
    executed.push(StartupStage::RecoveryPrepared);

    {
        let mut guard = runtime_services.write().await;
        *guard = runtime_state;
    }

    let _ = (&context.settings, &context.redis);
    context.readiness.mark_ready();
    observer(StartupStage::Ready);
    executed.push(StartupStage::Ready);

    Ok(StartupExecution {
        stages: executed,
        runtime_services,
    })
}
