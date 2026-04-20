# Rust 后端后台任务与恢复链清单

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 中“后台任务迁移清单 / 后台任务基线清单”。

## 1. startup / shutdown 总线

- 启动：`server-rs/src/bootstrap/startup.rs`
- 关闭：`server-rs/src/bootstrap/shutdown.rs`

## 2. JobRuntime 统一接线

主入口：`server-rs/src/jobs/mod.rs`

当前已接线的核心 family：

- 挂机会话恢复与 reconcile loop
- 在线战斗恢复
- Afdian 私信重试恢复与 loop
- arena 周结算
- rank snapshot 夜刷
- idle / mail history cleanup
- partner recruit draft cleanup
- technique draft cleanup
- dungeon expired cleanup
- online battle settlement loop
- progress / item grant / item mutation / resource delta flush loop
- AI generation jobs recovery（technique / partner / wander）

## 3. 关键子模块

- `jobs/online_battle_settlement.rs`
- `jobs/arena_weekly_settlement.rs`
- `jobs/rank_snapshot.rs`
- `jobs/dungeon_cleanup.rs`
- `jobs/battle_expired_cleanup.rs`
- `jobs/idle_history_cleanup.rs`
- `jobs/mail_history_cleanup.rs`
- `jobs/tower_frozen_pool.rs`

## 4. 当前验收要求

- 启动时恢复 pending / stale-running 任务，不允许只依赖在线触发。
- 关闭时先停新流量，再停 runtime，再 flush game time / delta，总线顺序不可乱。
- 任意 runner 失败后不得留下未恢复的 inflight Redis 状态。
