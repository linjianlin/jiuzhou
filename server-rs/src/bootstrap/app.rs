use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::bootstrap::readiness::ReadinessGate;
use crate::edge::http::routes::afdian::{build_afdian_router, AfdianRouteServices};
use crate::edge::http::routes::auth::{build_auth_router, AuthRouteServices};
use crate::edge::http::routes::captcha::build_captcha_router;
use crate::edge::http::routes::character::build_character_router;
use crate::edge::http::routes::idle::{build_idle_router, IdleRouteServices};
use crate::edge::http::routes::info::build_info_router;
use crate::edge::http::routes::map::build_map_router;
use crate::edge::http::routes::technique::build_technique_router;
use crate::edge::http::routes::upload::{build_upload_router, UploadRouteServices};
use crate::edge::socket::default_socket::attach_default_socket_layer;
use crate::edge::socket::game_socket::{attach_game_socket_layer, GameSocketAuthServices};
use crate::infra::config::settings::Settings;
use crate::runtime::battle::BattleRuntimeRegistry;
use crate::runtime::connection::session_registry::SharedSessionRegistry;
use crate::runtime::idle::IdleRuntimeService;
use crate::runtime::projection::OnlineProjectionRegistry;
use crate::runtime::session::BattleSessionRuntimeRegistry;

/**
 * 统一的恢复运行时服务容器。
 *
 * 作用：
 * 1. 做什么：把 startup 已构建完成的 battle/session/projection/idle 运行时索引集中挂到一个共享状态里。
 * 2. 做什么：为后续 HTTP/socket/业务迁移提供单一读取入口，避免各模块重复触发 recovery loader 或重复拼接 registry。
 * 3. 不做什么：不自行读取 Redis、不推进 gameplay，不替代实时连接 `session_registry`。
 *
 * 输入 / 输出：
 * - 输入：startup 阶段基于 `RuntimeRecoverySnapshot` 构建好的各类 registry/service。
 * - 输出：可挂入 `AppState` 并被后续模块共享读取的只读运行态容器。
 *
 * 数据流 / 状态流：
 * - startup recovery loader -> subsystem builders -> `RuntimeServicesState` -> `AppState` / 后续消费者。
 *
 * 复用设计说明：
 * - battle/session/projection/idle 当前都已具备独立 builder，但缺少统一归属点；集中在这里后，后续模块只依赖一个状态入口，不必各自再持有 loader 或多份 registry。
 * - 该容器同时被 `lifecycle` 和测试复用，确保启动接线与应用状态使用同一份结构，不会出现“启动产物”和“路由状态”两套字段漂移。
 *
 * 关键边界条件与坑点：
 * 1. 这里保存的是启动恢复后的只读快照级运行态；若未来出现可变 runtime，需要在更细粒度容器上扩展，而不是偷偷在这里重跑 recovery。
 * 2. `session_registry` 代表 socket 连接态，不属于 recovery registry；两者必须分开，不能混成一个“万能 session 状态”。
 */
pub type SharedRuntimeServices = Arc<RwLock<RuntimeServicesState>>;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuntimeServicesState {
    pub battle_registry: BattleRuntimeRegistry,
    pub session_registry: BattleSessionRuntimeRegistry,
    pub online_projection_registry: OnlineProjectionRegistry,
    pub idle_runtime_service: IdleRuntimeService,
}

pub fn new_shared_runtime_services(services: RuntimeServicesState) -> SharedRuntimeServices {
    Arc::new(RwLock::new(services))
}

#[derive(Clone)]
pub struct AppState {
    pub afdian_services: Arc<dyn AfdianRouteServices>,
    pub auth_services: Arc<dyn AuthRouteServices>,
    pub idle_services: Arc<dyn IdleRouteServices>,
    pub upload_services: Arc<dyn UploadRouteServices>,
    pub game_socket_services: Arc<dyn GameSocketAuthServices>,
    pub settings: Settings,
    pub readiness: ReadinessGate,
    pub session_registry: SharedSessionRegistry,
    pub runtime_services: SharedRuntimeServices,
}

#[derive(Serialize)]
struct RootPayload<'a> {
    name: &'a str,
    version: &'a str,
    status: &'a str,
}

#[derive(Serialize)]
struct HealthPayload {
    status: &'static str,
    timestamp: u64,
    ready: bool,
}

pub fn build_router(state: AppState) -> Router {
    let router = Router::new()
        .route("/", get(root_handler))
        .route("/api/health", get(health_handler))
        .nest("/api/afdian", build_afdian_router())
        .nest("/api/auth", build_auth_router())
        .nest("/api/character", build_character_router())
        .nest("/api/idle", build_idle_router())
        .nest("/api/captcha", build_captcha_router())
        .nest("/api/info", build_info_router())
        .nest("/api/map", build_map_router())
        .nest("/api/technique", build_technique_router())
        .nest("/api/upload", build_upload_router())
        .with_state(state.clone());
    let router = attach_default_socket_layer(router);
    attach_game_socket_layer(router, &state)
}

async fn root_handler() -> Json<RootPayload<'static>> {
    Json(RootPayload {
        name: "九州修仙录",
        version: env!("CARGO_PKG_VERSION"),
        status: "running",
    })
}

async fn health_handler(State(state): State<AppState>) -> Json<HealthPayload> {
    Json(HealthPayload {
        status: "ok",
        timestamp: current_timestamp_ms(),
        ready: state.readiness.is_ready(),
    })
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}
