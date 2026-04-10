use std::{future::Future, pin::Pin};

use crate::edge::http::error::BusinessError;
use crate::edge::http::routes::time::{GameTimeSnapshotView, TimeRouteServices};

/**
 * time 最小应用服务。
 *
 * 作用：
 * 1. 做什么：为 `/api/time` 提供一个可注入的统一读取入口，让 HTTP 合同不直接依赖尚未迁移的运行态时间系统。
 * 2. 做什么：在 Rust 侧时间运行态尚未接入前，明确返回“未初始化”，保持行为诚实且便于后续替换为真实快照提供方。
 * 3. 不做什么：不推进游戏时间、不生成天气/时辰，也不在这里维护后台定时器或持久化状态。
 *
 * 输入 / 输出：
 * - 输入：无，请求期只读取当前是否已有快照。
 * - 输出：`Option<GameTimeSnapshotView>`；当前默认 `None`，由路由层统一映射成 503 合同响应。
 *
 * 数据流 / 状态流：
 * - HTTP time 路由 -> 本服务 -> 返回当前快照或未初始化状态。
 *
 * 复用设计说明：
 * - 先把时间读取抽成应用服务，后续无论接 Redis、PostgreSQL 还是运行态内存，只需要替换这里，不必再改路由和测试合同。
 * - `GameTimeSnapshotView` 复用同一份对外 DTO，避免路由层和服务层各维护一套字段清单导致协议漂移。
 *
 * 关键边界条件与坑点：
 * 1. 当前默认返回 `None` 是刻意的最小实现，不能伪造“看起来正常”的时间快照掩盖 Rust 运行态尚未完成的事实。
 * 2. 读取失败时必须继续抛 `BusinessError`，不能把服务异常吞成 `None`，否则会把真实故障误报成“未初始化”。
 */
#[derive(Debug, Clone, Default)]
pub struct RustTimeService;

impl RustTimeService {
    pub fn new() -> Self {
        Self
    }

    async fn get_game_time_snapshot_impl(
        &self,
    ) -> Result<Option<GameTimeSnapshotView>, BusinessError> {
        Ok(None)
    }
}

impl TimeRouteServices for RustTimeService {
    fn get_game_time_snapshot<'a>(
        &'a self,
    ) -> Pin<
        Box<dyn Future<Output = Result<Option<GameTimeSnapshotView>, BusinessError>> + Send + 'a>,
    > {
        Box::pin(async move { self.get_game_time_snapshot_impl().await })
    }
}
