# Rust Backend Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 以 Rust 一次性重写当前后端服务，在最终切换时保持现有 HTTP API、Socket.IO 可见协议、PostgreSQL schema、关键 Redis 运行时数据格式与启动恢复语义兼容。

**Architecture:** 新实现采用单进程模块化单体：对外统一承载 HTTP、默认 Socket.IO、`/game-socket` 游戏实时层；内部拆分 `edge / application / domain / runtime / infra / bootstrap` 六层，并把 battle、battle-session、online-projection、idle 四类热路径建成独立运行时模块。开发阶段保留现有 `server/` 为权威实现，新建 `server-rs/` 逐步补齐兼容层与恢复链路，直到全量对拍通过后再做一次性切换。

**Tech Stack:** Rust、Axum、socketioxide、Tokio、SQLx、redis-rs、tracing、tracing-subscriber、config-rs、Apalis、PostgreSQL、Redis

---

## 非协商兼容边界

### HTTP
- 路径前缀与分组必须保持 `server/src/bootstrap/registerRoutes.ts` 当前形态。
- 默认成功包必须保持 `{ success: true, data? }`，默认失败包必须保持 `{ success: false, message, data?, code? }`。
- 必须保留以下特殊协议：
  - `/api/auth/verify`、`/api/auth/bootstrap` 的 `kicked: true`
  - `/api/market/*` 的 `MARKET_CAPTCHA_REQUIRED`
  - `/api/idle/start` 的 `409 + existingSessionId`
  - `/api/afdian/webhook` 的 `{ ec, em }`
  - `/api/inventory/*` 若当前是 HTTP 200 + `success:false`，Rust 侧不得“顺手修正”

### Socket / Realtime
- 必须继续支持默认 Socket.IO 与 `path="/game-socket"`。
- `game:auth`、`game:auth-ready`、`game:kicked`、`battle:update`、`idle:update`、`game:onlinePlayers`、`chat:message` 等事件名、字段与先后顺序必须兼容。
- 不允许把 Socket.IO 改成原生 WebSocket。

### Redis / Recovery
- battle、battle-session、online-battle projection、idle lock、延迟结算任务、角色运行时资源相关 key 与 JSON 结构必须兼容。
- 启动顺序必须保持“预热/恢复完成后才 listen”。

### PostgreSQL
- 保持现有 schema、事务边界、回滚语义、时间精度与主要写入顺序约束。

---

## Task 1: 冻结兼容清单并建立 Rust 对拍基线

**Files:**
- Create: `docs/plans/2026-04-09-rust-compatibility-matrix.md`
- Create: `server-rs/tests/fixtures/http/`
- Create: `server-rs/tests/fixtures/socket/`
- Create: `server-rs/tests/fixtures/redis/`
- Create: `server-rs/tests/fixtures/startup/`

**Step 1: 整理 HTTP 兼容矩阵**
- 把现有路由分组、响应 envelope、特殊状态码与文案写入 `docs/plans/2026-04-09-rust-compatibility-matrix.md`。
- 明确哪些接口必须保持 HTTP 200 即使业务失败。

**Step 2: 整理 Socket 兼容矩阵**
- 记录默认 Socket.IO 与 `/game-socket` 的连接方式、事件名、ack/重连/踢下线行为。
- 记录 `battle:update`、`game:onlinePlayers` 等事件的字段级约束。

**Step 3: 整理 Redis 兼容矩阵**
- 记录 battle、projection、session、idle、settlement 相关 key 前缀、value 顶层字段、producer、consumer、恢复入口。

**Step 4: 生成对拍 fixture 目录**
- 为后续 HTTP/Socket/Redis/startup 对拍预留 fixture 目录结构。

---

## Task 2: 搭建 Rust workspace 与生命周期骨架

**Files:**
- Create: `server-rs/Cargo.toml`
- Create: `server-rs/rust-toolchain.toml`
- Create: `server-rs/src/main.rs`
- Create: `server-rs/src/lib.rs`
- Create: `server-rs/src/bootstrap/mod.rs`
- Create: `server-rs/src/bootstrap/app.rs`
- Create: `server-rs/src/bootstrap/config.rs`
- Create: `server-rs/src/bootstrap/lifecycle.rs`
- Create: `server-rs/src/bootstrap/startup.rs`
- Create: `server-rs/src/bootstrap/shutdown.rs`
- Create: `server-rs/src/shared/mod.rs`
- Create: `server-rs/src/shared/error.rs`
- Create: `server-rs/src/shared/result.rs`

**Step 1: 写 failing test，约束服务外壳能启动并暴露 `/` 与 `/api/health`**
- Test: `server-rs/tests/bootstrap_health_test.rs`
- 覆盖：启动 app、请求 `/` 与 `/api/health`、返回字段与现有服务一致。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs bootstrap_health_test -- --nocapture`
- Expected: 因 `main/app/router` 尚不存在而失败。

**Step 3: 实现最小骨架**
- 建立 config、tracing、Axum router、基础 lifecycle。
- 暂时只实现根路由与 health 路由，不接业务。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs bootstrap_health_test -- --nocapture`
- Expected: PASS。

---

## Task 3: 搭建 infra 层（配置、日志、PostgreSQL、Redis）

**Files:**
- Create: `server-rs/src/infra/mod.rs`
- Create: `server-rs/src/infra/config/mod.rs`
- Create: `server-rs/src/infra/config/settings.rs`
- Create: `server-rs/src/infra/logging/mod.rs`
- Create: `server-rs/src/infra/postgres/mod.rs`
- Create: `server-rs/src/infra/postgres/pool.rs`
- Create: `server-rs/src/infra/postgres/transaction.rs`
- Create: `server-rs/src/infra/redis/mod.rs`
- Create: `server-rs/src/infra/redis/client.rs`
- Create: `server-rs/src/infra/redis/codecs.rs`
- Create: `server-rs/tests/infra_config_test.rs`
- Create: `server-rs/tests/infra_codecs_test.rs`

**Step 1: 写 failing test，约束配置映射与 Redis codec 形状**
- 配置 test 覆盖：HOST、PORT、DATABASE_URL、REDIS_URL、CORS_ORIGIN、日志级别。
- codec test 覆盖：battle state、battle static、session snapshot、idle lock 顶层序列化/反序列化。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs infra_ -- --nocapture`

**Step 3: 实现最小 infra**
- 用 `config-rs + serde` 映射配置。
- 用 `tracing + tracing-subscriber` 初始化日志。
- 用 `SQLx` 建立 Postgres pool，用 `redis-rs` 建立 async client/manager。
- 只实现 codec，不实现完整业务。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs infra_ -- --nocapture`

---

## Task 4: 复刻启动 DAG 与 readiness/shutdown 语义

**Files:**
- Modify: `server-rs/src/bootstrap/startup.rs`
- Modify: `server-rs/src/bootstrap/shutdown.rs`
- Create: `server-rs/src/bootstrap/readiness.rs`
- Create: `server-rs/tests/startup_order_test.rs`
- Create: `server-rs/tests/shutdown_drain_test.rs`

**Step 1: 写 failing test，约束启动顺序与 shutdown drain**
- 启动顺序必须至少表达：config/logging -> postgres -> redis -> warmup gate -> recovery gate -> listen。
- shutdown 必须先停止新连接，再做 worker/runtime drain，再释放资源。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs startup_order_test shutdown_drain_test -- --nocapture`

**Step 3: 实现最小 startup/shutdown DAG**
- 引入显式 readiness gate。
- 当前只挂 stub warmup/recovery task，但顺序必须固定。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs startup_order_test shutdown_drain_test -- --nocapture`

---

## Task 5: 迁移 HTTP 边界基础设施（response/error/auth admission）

**Files:**
- Create: `server-rs/src/edge/mod.rs`
- Create: `server-rs/src/edge/http/mod.rs`
- Create: `server-rs/src/edge/http/router.rs`
- Create: `server-rs/src/edge/http/response.rs`
- Create: `server-rs/src/edge/http/error_handler.rs`
- Create: `server-rs/src/edge/http/auth.rs`
- Create: `server-rs/src/edge/http/qps_limit.rs`
- Create: `server-rs/src/application/auth/mod.rs`
- Create: `server-rs/src/application/auth/session.rs`
- Create: `server-rs/tests/http_contract_test.rs`

**Step 1: 写 failing test，约束通用 response/error/auth 行为**
- 覆盖：标准 success envelope、401 登录失效、404 角色不存在、503 排队超时、429 限流。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs http_contract_test -- --nocapture`

**Step 3: 实现最小 HTTP 基础设施**
- 把标准包结构、业务错误映射、Bearer 解析、Admission gate 与 QPS 入口先搭起来。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs http_contract_test -- --nocapture`

---

## Task 6: 迁移 Socket.IO 兼容层与 `/game-socket` 会话入口

**Files:**
- Create: `server-rs/src/edge/socket/mod.rs`
- Create: `server-rs/src/edge/socket/default_socket.rs`
- Create: `server-rs/src/edge/socket/game_socket.rs`
- Create: `server-rs/src/edge/socket/events.rs`
- Create: `server-rs/src/runtime/connection/mod.rs`
- Create: `server-rs/src/runtime/connection/session_registry.rs`
- Create: `server-rs/tests/socket_protocol_test.rs`
- Create: `server-rs/tests/game_socket_auth_test.rs`

**Step 1: 写 failing test，约束 handshake / auth / kick / room 基础行为**
- 覆盖：默认 Socket.IO 连通、`/game-socket` path、`game:auth`、旧连接被踢、`game:auth-ready`。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs socket_protocol_test game_socket_auth_test -- --nocapture`

**Step 3: 实现最小 socket 层**
- 使用 `socketioxide` 挂默认 Socket 与 `/game-socket`。
- 先补认证、房间、用户连接映射，不碰 battle payload。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs socket_protocol_test game_socket_auth_test -- --nocapture`

---

## Task 7: 迁移 Redis codec 与 recovery kernel（battle / projection / session / idle）

**Files:**
- Create: `server-rs/src/runtime/battle/mod.rs`
- Create: `server-rs/src/runtime/battle/persistence.rs`
- Create: `server-rs/src/runtime/battle/recovery.rs`
- Create: `server-rs/src/runtime/session/mod.rs`
- Create: `server-rs/src/runtime/session/projection.rs`
- Create: `server-rs/src/runtime/projection/mod.rs`
- Create: `server-rs/src/runtime/projection/service.rs`
- Create: `server-rs/src/runtime/idle/mod.rs`
- Create: `server-rs/src/runtime/idle/lock.rs`
- Create: `server-rs/tests/redis_codec_golden_test.rs`
- Create: `server-rs/tests/recovery_kernel_test.rs`

**Step 1: 写 failing test，约束 battle/session/projection/idle Redis 互读**
- 使用 fixture 验证：Rust 可读当前 Node 写出的 JSON；Rust 写出的 JSON 可被 fixture schema 接受。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs redis_codec_golden_test recovery_kernel_test -- --nocapture`

**Step 3: 实现最小 recovery kernel**
- 只实现 key codec、索引读取、恢复顺序与内存 registry，不实现完整业务动作。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs redis_codec_golden_test recovery_kernel_test -- --nocapture`

---

## Task 8: 迁移 battle engine 与 battle runtime

**Files:**
- Create: `server-rs/src/domain/mod.rs`
- Create: `server-rs/src/domain/battle/mod.rs`
- Create: `server-rs/src/domain/battle/engine.rs`
- Create: `server-rs/src/domain/battle/types.rs`
- Create: `server-rs/src/runtime/battle/ticker.rs`
- Create: `server-rs/src/runtime/battle/settlement.rs`
- Create: `server-rs/tests/battle_engine_contract_test.rs`
- Create: `server-rs/tests/battle_runtime_recovery_test.rs`

**Step 1: 写 failing test，锁 battle 输出边界**
- 覆盖：battle state 基础推进、日志 cursor、冷却字段、结束态持久化入口。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs battle_engine_contract_test battle_runtime_recovery_test -- --nocapture`

**Step 3: 实现最小 battle 内核与 runtime**
- 先实现可恢复的 battle runtime 外壳，再逐步迁 battle engine 规则。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs battle_engine_contract_test battle_runtime_recovery_test -- --nocapture`

---

## Task 9: 迁移 battle-session / online-projection / delayed-settlement

**Files:**
- Modify: `server-rs/src/runtime/session/projection.rs`
- Modify: `server-rs/src/runtime/projection/service.rs`
- Create: `server-rs/src/runtime/session/service.rs`
- Create: `server-rs/src/runtime/projection/settlement_runner.rs`
- Create: `server-rs/tests/session_projection_test.rs`
- Create: `server-rs/tests/deferred_settlement_test.rs`

**Step 1: 写 failing test，锁 session projection 与 deferred settlement**
- 覆盖：session index 恢复、battleId -> sessionId 映射、延迟结算任务重载。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs session_projection_test deferred_settlement_test -- --nocapture`

**Step 3: 实现最小 session/projection/runner**
- 按现有 Redis 契约补齐 bulk recovery、lazy lookup、deferred settlement queue。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs session_projection_test deferred_settlement_test -- --nocapture`

---

## Task 10: 迁移 idle runtime 与后台任务层

**Files:**
- Modify: `server-rs/src/runtime/idle/mod.rs`
- Create: `server-rs/src/runtime/idle/executor.rs`
- Create: `server-rs/src/runtime/idle/buffer.rs`
- Create: `server-rs/src/jobs/mod.rs`
- Create: `server-rs/src/jobs/scheduler.rs`
- Create: `server-rs/tests/idle_recovery_test.rs`
- Create: `server-rs/tests/job_bootstrap_test.rs`

**Step 1: 写 failing test，锁 idle lock/recovery/buffer flush 语义**
- 覆盖：DB 恢复 active session、Redis lock 兼容、停止时 flush buffer。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs idle_recovery_test job_bootstrap_test -- --nocapture`

**Step 3: 实现最小 idle/job 层**
- 先做 executor、recovery 与 scheduler 外壳，业务 worker 再逐步迁移。

**Step 4: 跑测试并确认通过**
- Run: `cargo test -p jiuzhou-server-rs idle_recovery_test job_bootstrap_test -- --nocapture`

---

## Task 11: 按路由簇迁移剩余 HTTP 业务模块

**Files:**
- Modify: `server-rs/src/edge/http/router.rs`
- Create: `server-rs/src/edge/http/routes/auth.rs`
- Create: `server-rs/src/edge/http/routes/account.rs`
- Create: `server-rs/src/edge/http/routes/market.rs`
- Create: `server-rs/src/edge/http/routes/idle.rs`
- Create: `server-rs/src/edge/http/routes/upload.rs`
- Create: `server-rs/src/edge/http/routes/afdian.rs`
- Create: `server-rs/src/edge/http/routes/...`
- Create: `server-rs/tests/http_route_cluster_test.rs`

**Step 1: 先迁移高风险簇**
- 顺序固定：`auth -> market -> idle -> inventory -> upload -> afdian -> 其余簇`。

**Step 2: 每迁一个簇先写 failing test**
- 按簇补 black-box 测试，不允许先写生产代码。

**Step 3: 实现最小通过代码**
- 仅满足当前簇 fixture 与约束，不顺手做“更优雅”的协议改造。

**Step 4: 逐簇回归**
- Run: `cargo test -p jiuzhou-server-rs http_route_cluster_test -- --nocapture`

---

## Task 12: 全链路 dress rehearsal、cutover 与 rollback runbook

**Files:**
- Create: `docs/plans/2026-04-09-rust-cutover-runbook.md`
- Create: `docs/plans/2026-04-09-rust-rollback-runbook.md`
- Create: `server-rs/tests/full_rehearsal_test.rs`
- Modify: `server-rs/src/main.rs`
- Modify: 部署/容器相关文件（最终阶段再定）

**Step 1: 写 failing test，约束 rehearsal gate**
- 覆盖：startup -> warmup -> recovery -> HTTP health -> socket auth -> Redis key cross-read。

**Step 2: 跑测试并确认失败**
- Run: `cargo test -p jiuzhou-server-rs full_rehearsal_test -- --nocapture`

**Step 3: 实现 cutover/rollback runbook**
- 写明停机、流量冻结、Node 停止、Rust 启动、健康检查、回滚条件。

**Step 4: 最终校验**
- Run: `cargo test -p jiuzhou-server-rs -- --nocapture`
- Run: `cargo fmt --all --check`
- Run: `cargo clippy --workspace --all-targets -- -D warnings`
- Run: `tsc -b`

---

## 执行规则

1. 不允许先改现有 `server/` 入口再补 Rust 实现。
2. 不允许把 Socket.IO 降级成纯 WebSocket。
3. 不允许“顺手修正”现有协议怪异点，除非 fixture 先变更并经你确认。
4. 不允许跳过 failing test；每个簇/模块都必须先红后绿。
5. 不允许在启动链、恢复链未齐之前宣称可切换。

## 第一个安全里程碑

完成 Task 1 ~ Task 4 后，应达到以下状态：

- `server-rs/` 可独立编译启动。
- `/` 与 `/api/health` 可用。
- Rust 侧已有 config/logging/postgres/redis/startup/shutdown/readiness 骨架。
- 已具备 HTTP/Socket/Redis/startup 四类 fixture 与对拍测试入口。
- 当前仓库仍然没有切换生产入口，`server/` 保持权威实现。

Plan complete and saved to `docs/plans/2026-04-09-rust-backend-rewrite-implementation.md`.
