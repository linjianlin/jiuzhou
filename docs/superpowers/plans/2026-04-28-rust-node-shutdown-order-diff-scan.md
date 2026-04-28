# Rust Node Shutdown Order Diff Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the Rust backend shutdown order and drain window with the NodeJS backend shutdown pipeline for this scan batch.

**Architecture:** Treat Node `server/src/bootstrap/startupPipeline.ts::registerGracefulShutdown()` as the business authority. Keep the Rust change scoped to `server-rs/src/bootstrap/shutdown.rs`, then update the Rust/Node diff scan documents with the evidence and the remaining JobRuntime loop-stop risk as a separate future scan target.

**Tech Stack:** Rust, Tokio, Axum graceful shutdown, NodeJS shutdown pipeline, Markdown scan documentation, Cargo tests.

---

## File Structure

- Modify: `server-rs/src/bootstrap/shutdown.rs`
  - Add source-order regression tests for Rust shutdown order.
  - Move game time runtime flush before `JobRuntime::shutdown()`.
  - Change the drain window from 250 ms to 2000 ms to match Node's shutdown wait.
- Modify: `docs/rust-backend/node-rust-diff-scan-2026-04-27.md`
  - Add Batch 5 scope before implementation.
  - Add Batch 5 result after verification.
  - Mark shutdown order/drain window as resolved while leaving JobRuntime loop cancellation as the remaining high-risk anchor.
- Modify: `docs/rust-backend/recovery-baseline.md`
  - Update the shutdown sequence section so the Rust baseline lists game time stop before JobRuntime stop and a 2000 ms drain window before delta flush.

### Task 1: Record Batch 5 Scan Scope

**Files:**
- Modify: `docs/rust-backend/node-rust-diff-scan-2026-04-27.md`

- [ ] **Step 1: Append the Batch 5 scope section**

Add this exact section after the current Batch 4 result section:

```markdown
## Deep Scan Batch 5（shutdown order / drain window）

本批继续以 NodeJS 为业务权威，聚焦 shutdown 路径中可独立验证的顺序差异：

1. Node `registerGracefulShutdown()` 在关闭 Socket 后先执行 `stopGameTimeService()`，再停止 arena / cleanup / battle / idle / worker runners；Rust `shutdown_application()` 当前先执行 `job_runtime.shutdown()`，再执行 `shutdown_game_time_runtime(&state)`。
2. Node 在停止 runner 与 worker pool 后等待 2000 ms，再 flush idle buffers 与四类 Delta 聚合器；Rust 当前 drain window 为 250 ms。
3. 本批只调整 shutdown 顺序与 drain window，不把 JobRuntime loop 句柄化混入同一批。`JobRuntime::shutdown()` 仍需在下一批单独扫描为“停止后台 loop、等待退出、再 flush”的实现任务。
```

- [ ] **Step 2: Run the placeholder scan**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details|Similar[ ]to[ ]Task|适[当]|后续[再]" docs/rust-backend/node-rust-diff-scan-2026-04-27.md
```

Expected: no output.

- [ ] **Step 3: Commit the scan scope**

Run:

```bash
git add docs/rust-backend/node-rust-diff-scan-2026-04-27.md
git commit -m "docs: record shutdown order diff scan scope"
```

Expected: commit succeeds.

### Task 2: Add Failing Shutdown Order Tests

**Files:**
- Modify: `server-rs/src/bootstrap/shutdown.rs`

- [ ] **Step 1: Add source-order tests**

Append this test module to the end of `server-rs/src/bootstrap/shutdown.rs`:

```rust
#[cfg(test)]
mod tests {
    fn assert_source_order(source: &str, earlier: &str, later: &str) {
        let earlier_index = source
            .find(earlier)
            .unwrap_or_else(|| panic!("shutdown source missing earlier marker: {earlier}"));
        let later_index = source
            .find(later)
            .unwrap_or_else(|| panic!("shutdown source missing later marker: {later}"));
        assert!(
            earlier_index < later_index,
            "expected `{earlier}` to appear before `{later}`"
        );
    }

    #[test]
    fn shutdown_source_orders_game_time_before_job_runtime() {
        let source = include_str!("shutdown.rs");
        let implementation_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("shutdown source should include implementation before tests");

        assert_source_order(
            implementation_source,
            "shutdown_game_time_runtime(&state)",
            "job_runtime.shutdown().await",
        );
    }

    #[test]
    fn shutdown_source_uses_node_drain_window() {
        let source = include_str!("shutdown.rs");
        let implementation_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("shutdown source should include implementation before tests");

        assert!(
            implementation_source.contains("std::time::Duration::from_millis(2_000)"),
            "shutdown drain window should match Node graceful shutdown 2000 ms wait"
        );
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd server-rs && cargo test shutdown_source_ -- --nocapture
```

Expected: FAIL with both `shutdown_source_orders_game_time_before_job_runtime` and `shutdown_source_uses_node_drain_window` failing against the current source.

- [ ] **Step 3: Commit nothing after the red test**

Run:

```bash
git status --short
```

Expected: `server-rs/src/bootstrap/shutdown.rs` is modified and uncommitted. Do not commit red tests without the implementation in this batch.

### Task 3: Align Rust Shutdown Order and Drain Window

**Files:**
- Modify: `server-rs/src/bootstrap/shutdown.rs`

- [ ] **Step 1: Move game time flush before JobRuntime shutdown**

Replace the top of `shutdown_application()` with this exact order:

```rust
pub async fn shutdown_application(
    state: AppState,
    realtime_runtime: RealtimeRuntime,
    job_runtime: JobRuntime,
) {
    tracing::info!("starting graceful shutdown sequence");
    tracing::info!("→ shutting down realtime runtime");
    realtime_runtime.shutdown().await;
    tracing::info!("✓ realtime runtime stopped");

    tracing::info!("→ flushing game time runtime");
    if let Err(error) = shutdown_game_time_runtime(&state).await {
        tracing::error!(error = %error, "game time runtime flush failed during shutdown");
    } else {
        tracing::info!("✓ game time runtime flushed");
    }

    tracing::info!("→ shutting down job runtime");
    job_runtime.shutdown().await;
    tracing::info!("✓ job runtime stopped");

    tracing::info!("→ draining outstanding tasks");
    tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
    tracing::info!("✓ drain window elapsed");
```

Keep the existing `flush_pending_runtime_deltas(&state).await`, database close, and Redis logging block after the drain window.

- [ ] **Step 2: Remove the old post-drain game time flush block**

Delete this old block from below the drain window:

```rust
    tracing::info!("→ flushing game time runtime");
    if let Err(error) = shutdown_game_time_runtime(&state).await {
        tracing::error!(error = %error, "game time runtime flush failed during shutdown");
    } else {
        tracing::info!("✓ game time runtime flushed");
    }
```

- [ ] **Step 3: Run the shutdown source tests**

Run:

```bash
cd server-rs && cargo test shutdown_source_ -- --nocapture
```

Expected: PASS with 2 passed.

- [ ] **Step 4: Run the broader bootstrap shutdown-adjacent tests**

Run:

```bash
cd server-rs && cargo test shutdown -- --nocapture
```

Expected: PASS for the shutdown source tests and any existing tests with `shutdown` in the name.

- [ ] **Step 5: Format the Rust code**

Run:

```bash
cd server-rs && cargo fmt --check
```

Expected: PASS. If formatting fails, run `cd server-rs && cargo fmt`, then rerun `cd server-rs && cargo fmt --check` until it passes.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add server-rs/src/bootstrap/shutdown.rs
git commit -m "test: align rust shutdown order with node pipeline"
```

Expected: commit succeeds.

### Task 4: Record Batch 5 Results and Verify

**Files:**
- Modify: `docs/rust-backend/node-rust-diff-scan-2026-04-27.md`
- Modify: `docs/rust-backend/recovery-baseline.md`

- [ ] **Step 1: Update the shutdown high-risk bullet**

In `docs/rust-backend/node-rust-diff-scan-2026-04-27.md`, replace the current shutdown bullet:

```markdown
- Rust `JobRuntime::shutdown` 当前只记录日志，Node shutdown 会停止各 runner、等待 drain、flush idle buffers 与四类 Delta 聚合器。
```

with:

```markdown
- Rust shutdown 顺序与 drain window 曾和 Node 不一致；Batch 5 已调整为先 flush game time runtime，再停止 JobRuntime，并把 drain window 对齐为 2000 ms。`JobRuntime::shutdown()` 当前仍只记录日志，Node shutdown 会停止各 runner；runner 停止与等待退出需单独扫描。
```

- [ ] **Step 2: Append the Batch 5 result section**

Add this exact section after the Batch 5 scope section:

```markdown
## Deep Scan Batch 5 结果

- Rust `shutdown_application()` 已按 Node shutdown 语义调整为：RealtimeRuntime shutdown 后先执行 `shutdown_game_time_runtime(&state)`，再执行 `job_runtime.shutdown().await`。
- Rust drain window 已从 250 ms 对齐为 2000 ms，随后再执行 `flush_pending_runtime_deltas(&state)` 与数据库 runtime close。
- 新增 `shutdown_source_orders_game_time_before_job_runtime` 与 `shutdown_source_uses_node_drain_window`，用 source-order 回归测试锁定 shutdown 顺序与等待窗口。
- 验证命令已执行：`cargo test shutdown_source_ -- --nocapture` 为 2 passed，`cargo test shutdown -- --nocapture` 通过，`cargo fmt --check` 通过。
```

- [ ] **Step 3: Update recovery baseline shutdown sequence**

In `docs/rust-backend/recovery-baseline.md`, update the shutdown sequence so it lists these Rust steps in order:

```markdown
1. Axum graceful shutdown 停止接受新 HTTP 请求。
2. `RealtimeRuntime::shutdown()` 关闭实时 runtime。
3. `shutdown_game_time_runtime(&state)` 停止并持久化游戏时间 runtime。
4. `JobRuntime::shutdown()` 停止后台任务 runtime。
5. 等待 2000 ms drain window。
6. `flush_pending_runtime_deltas(&state)` flush progress / item grant / item instance mutation / resource delta。
7. `state.database.close().await` 关闭数据库 runtime。
8. Redis client 随 `AppState` drop；Redis 不可用时记录 no-op shutdown。
```

- [ ] **Step 4: Run the full verification set**

Run:

```bash
node scripts/compare-node-rust-routes.mjs
cd server-rs && cargo test shutdown_source_ -- --nocapture
cd server-rs && cargo test shutdown -- --nocapture
cd server-rs && cargo fmt --check
rg -n "T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details|Similar[ ]to[ ]Task|适[当]|后续[再]" docs/rust-backend/node-rust-diff-scan-2026-04-27.md docs/rust-backend/recovery-baseline.md
git status --short
```

Expected:

```text
compare-node-rust-routes: node 264, rust 264, missingInRust 0, extraInRust 0
cargo test shutdown_source_: 2 passed
cargo test shutdown: all matching tests passed
cargo fmt --check: no output and exit code 0
placeholder scan: no output
git status --short: only the two docs modified before the docs commit
```

- [ ] **Step 5: Commit the result docs**

Run:

```bash
git add docs/rust-backend/node-rust-diff-scan-2026-04-27.md docs/rust-backend/recovery-baseline.md
git commit -m "docs: record shutdown order diff scan results"
```

Expected: commit succeeds.

- [ ] **Step 6: Confirm final branch state**

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: `git status --short` has no output, and the latest commits are the Batch 5 docs result commit, the shutdown implementation commit, and the Batch 5 scope commit.

## Self-Review

Spec coverage:
- The plan covers the user's request to continue scanning Rust vs Node backend differences with NodeJS as the authority.
- The plan scopes this pass to shutdown order and drain window, both directly supported by Node `registerGracefulShutdown()` and Rust `shutdown_application()`.
- The plan leaves JobRuntime runner stop/drain as an explicit next scan target because it touches multiple loop owners and should not be mixed with this narrow order/drain change.

Placeholder scan:
- The plan avoids the forbidden placeholder words and gives exact code, commands, expected failures, and expected passing output.

Type consistency:
- The plan uses existing Rust symbols: `shutdown_application`, `shutdown_game_time_runtime`, `JobRuntime`, `RealtimeRuntime`, and `flush_pending_runtime_deltas`.
- The source-order tests use the same helper pattern already present in `server-rs/src/bootstrap/startup.rs`.
