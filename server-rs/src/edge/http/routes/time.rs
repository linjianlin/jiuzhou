use std::{future::Future, pin::Pin};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::bootstrap::app::AppState;
use crate::edge::http::error::BusinessError;
use crate::edge::http::response::success;

/**
 * time HTTP 只读路由集群。
 *
 * 作用：
 * 1. 做什么：暴露当前 Node 已对外提供的 `GET /api/time` 读取接口，并保持成功/失败包体形状一致。
 * 2. 做什么：把“快照不存在 => 503 + 固定文案”这一 HTTP 合同固定在路由层，避免应用服务掺杂传输层细节。
 * 3. 不做什么：不补 socket 时间同步、不实现时间推进或天气计算，也不扩展任何非时间路由。
 *
 * 输入 / 输出：
 * - 输入：无。
 * - 输出：成功时 `{ success:true, data:<GameTimeSnapshotView> }`；未初始化时 `503 { success:false, message:'游戏时间未初始化' }`。
 *
 * 数据流 / 状态流：
 * - HTTP 请求 -> `TimeRouteServices` 读取当前快照 -> 路由层统一序列化为 Node 兼容响应。
 *
 * 复用设计说明：
 * - `GameTimeSnapshotView` 同时被路由、应用服务、合同测试复用，时间字段清单只维护一份，避免后续客户端看到的 shape 漂移。
 * - `TimeRouteServices` 把“数据来源”与“HTTP 合同”拆开，后续接真实运行态时不用再复制 503 文案和 envelope 逻辑。
 *
 * 关键边界条件与坑点：
 * 1. Node 端根路径只有一个 `/` 端点，这里必须保持字段名为 snake_case，不能擅自改成 camelCase。
 * 2. 未初始化要明确返回 503，不能返回 200 + null data，否则客户端会把它当成合法快照。
 */
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GameTimeSnapshotView {
    pub era_name: String,
    pub base_year: i32,
    pub year: i32,
    pub month: i32,
    pub day: i32,
    pub hour: i32,
    pub minute: i32,
    pub second: i32,
    pub shichen: String,
    pub weather: String,
    pub scale: i32,
    pub server_now_ms: u64,
    pub game_elapsed_ms: u64,
}

pub trait TimeRouteServices: Send + Sync {
    fn get_game_time_snapshot<'a>(
        &'a self,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<GameTimeSnapshotView>, BusinessError>> + Send + 'a>,
    >;
}

#[derive(Debug, Clone, Default)]
pub struct NoopTimeRouteServices;

impl TimeRouteServices for NoopTimeRouteServices {
    fn get_game_time_snapshot<'a>(
        &'a self,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<GameTimeSnapshotView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { Ok(None) })
    }
}

pub fn build_time_router() -> Router<AppState> {
    Router::new()
        .route("/api/time", get(game_time_snapshot_handler))
        .route("/api/time/", get(game_time_snapshot_handler))
}

pub async fn game_time_snapshot_handler(
    State(state): State<AppState>,
) -> Result<Response, BusinessError> {
    let Some(snapshot) = state.time_services.get_game_time_snapshot().await? else {
        return Err(BusinessError::with_status(
            "游戏时间未初始化",
            StatusCode::SERVICE_UNAVAILABLE,
        ));
    };

    Ok(success(snapshot))
}
