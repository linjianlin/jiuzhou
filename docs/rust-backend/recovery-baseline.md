# Rust 后端恢复链与后台任务基线样本

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 阶段 0 中“后台任务与恢复链路清单 / 关键恢复链路状态字段样本”。

## 1. startup 恢复顺序样本

Rust 当前 startup 总线位于：`server-rs/src/bootstrap/startup.rs`

关键恢复/预热顺序：

1. 数据库与 Redis 探活
2. generated content refresh / item data cleanup / avatar cleanup / index sync
3. dungeon / idle / battle / mail 等 cleanup
4. frozen tower pool warmup
5. persisted battle recovery / orphan battle session recovery
6. online battle projection warmup
7. JobRuntime 初始化（idle / battle / afdian / settlement / snapshot / AI jobs）
8. game time runtime 初始化

## 2. 关键恢复状态字段样本

### 2.1 battle session

- `sessionId`
- `ownerUserId`
- `participantUserIds`
- `currentBattleId`
- `status`
- `nextAction`
- `canAdvance`
- `lastResult`
- `context`

### 2.2 online battle projection

- `battleId`
- `ownerUserId`
- `participantUserIds`
- `type`
- `sessionId`

### 2.3 idle session

- `session_snapshot`
- `bag_full_flag`
- `executionSnapshot.monsterIds`
- `executionSnapshot.resolvedSkillId`
- `executionSnapshot.partnerMember`

## 3. 当前后台任务 family

- idle recover / reconcile
- battle/session recovery
- online battle settlement
- afdian retry
- arena weekly settlement
- rank snapshot refresh
- idle history cleanup
- mail history cleanup
- battle expired cleanup
- dungeon expired cleanup
- partner recruit / fusion / rebone jobs
- technique generation jobs
- wander generation jobs
- progress / item grant / item mutation / resource delta flush

## 4. shutdown 顺序样本

Rust 当前 shutdown 总线位于：`server-rs/src/bootstrap/shutdown.rs`

关键停止/flush 顺序：

1. Axum graceful shutdown 停止接受新 HTTP 请求。
2. `RealtimeRuntime::shutdown()` 关闭实时 runtime。
3. `shutdown_game_time_runtime(&state)` 停止并持久化游戏时间 runtime。
4. `JobRuntime::shutdown()` 停止后台任务 runtime。
5. 等待 2000 ms drain window。
6. `flush_pending_runtime_deltas(&state)` flush progress / item grant / item instance mutation / resource delta。
7. `state.database.close().await` 关闭数据库 runtime。
8. Redis client 随 `AppState` drop；Redis 不可用时记录 no-op shutdown。

## 5. 样本来源

- `server-rs/src/bootstrap/startup.rs`
- `server-rs/src/bootstrap/shutdown.rs`
- `server-rs/src/jobs/mod.rs`
- `server-rs/src/state.rs`
