# Rust 后端 Redis 状态契约清单

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 中“Redis 状态基线清单 / Redis 状态契约清单”。

## 1. 在线战斗 / 会话恢复

- battle bundle 持久化与恢复：`server-rs/src/integrations/battle_persistence.rs`
- battle runtime / session / projection 运行态：`server-rs/src/state.rs`
- startup 恢复入口：`server-rs/src/bootstrap/startup.rs`

## 2. Delta 聚合总线

- 资源增量：`server-rs/src/integrations/redis_resource_delta.rs`
- 物品发放增量：`server-rs/src/integrations/redis_item_grant_delta.rs`
- 物品实例 mutation：`server-rs/src/integrations/redis_item_instance_mutation.rs`
- 任务/成就进度：`server-rs/src/integrations/redis_progress_delta.rs`

## 3. Flush / recovery 总入口

- 周期 flush：`server-rs/src/jobs/mod.rs`
- 关机前显式 flush：`server-rs/src/bootstrap/shutdown.rs`

## 4. 当前语义要求

- Redis 可用时，相关主流程优先写入 delta family，再由 flush loop 落库。
- flush 失败必须 restore inflight，而不是吞掉。
- shutdown 必须在关库前尝试 flush 四类 delta。
- battle/session 恢复必须允许“本地 miss → Redis bundle 恢复 → 再决定 abandoned”。

## 5. 验证入口

- `cargo test battle_ -- --ignored --nocapture`
- `cargo test idle_ -- --ignored --nocapture`
