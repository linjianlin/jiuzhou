# Rust 后端 Phase 7 本地验证基线

## 目的

当前 `server-rs/src/http/routes.rs` 中的大部分高风险 success-path / recovery / idempotency 测试已经改成默认执行，并在数据库不可达时通过 `connect_fixture_db_or_skip(...)` 早退；只剩少量真正依赖 Postgres+Redis 或 Postgres+AI 的场景需要在可用环境下执行验证。这个文档提供一个最小可复用的本地 fixture 基线，用于把这些剩余环境依赖测试直接跑通，而不是停留在 `SKIPPED_DB_UNAVAILABLE`。

## 1. 启动本地 Postgres / Redis

仓库根目录新增了 `docker-compose.local-fixture.yml`，默认暴露：

- PostgreSQL: `postgresql://postgres:postgres@localhost:5432/jiuzhou`
- Redis: `redis://127.0.0.1:6379`

启动命令：

```bash
docker compose -f docker-compose.local-fixture.yml up -d
```

停止并清理：

```bash
docker compose -f docker-compose.local-fixture.yml down -v
```

## 2. Rust 测试环境变量

对 `server-rs` 的 DB-backed fixture 测试，最小环境建议：

```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/jiuzhou"
export REDIS_URL="redis://127.0.0.1:6379"
```

如果需要 Afdian / Wander AI 这类对外依赖链，请额外补齐对应环境变量；否则这类测试仍可能因为外部依赖不可达而跳过或失败。

另外，仓库里现在提供了一个最小执行脚本：

```bash
scripts/run-server-rs-phase7.sh --dry-run
```

如果你只想列出**当前动态发现出来的真实 高风险 route tests 清单**，可以直接用：

```bash
scripts/run-server-rs-phase7.sh afdian --list-only
```

如果你只想拿到**纯测试名**（不带 `cargo test ...` 包装，便于复制到其他执行器里），可以用：

```bash
scripts/run-server-rs-phase7.sh battle --names-only --gate=pg-redis
```

如果你想把整份 phase 7 矩阵摘要和当前选中的测试清单直接交给其他执行器或 CI，可以用：

```bash
scripts/run-server-rs-phase7.sh all --json --skip-fixture-up --skip-db-sync
```

如果你已经有可用的 DB/Redis(/AI) 环境，并且希望**整批跑完后再统一看失败面**，而不是在首个失败处中断，可以加：

```bash
scripts/run-server-rs-phase7.sh afdian wander --keep-going
```

这里的 `--json` 当前是**清单审查模式**：脚本会直接输出 machine-readable JSON 并提前退出，不会继续执行 preflight / fixture / db:sync / cargo test。

如果你只想看某一类 gate 对应的矩阵，也可以用：

```bash
scripts/run-server-rs-phase7.sh battle --gate=pg-redis --list-only
scripts/run-server-rs-phase7.sh wander --gate=pg-ai --list-only
```

它会：

- 自动注入本地默认 `DATABASE_URL / REDIS_URL`
- 按需检查依赖：只有未传 `--skip-fixture-up` 时才要求 `docker`，只有未传 `--skip-db-sync` 时才要求 `pnpm`；非 dry-run 且需要起 fixture 时还会检查 Docker daemon 是否可达
- 先校验 `docker-compose.local-fixture.yml`
- 默认执行 `docker compose ... up -d postgres redis` 并等待 `pg_isready` / `redis-cli ping` 成功
- 默认执行 `pnpm --filter ./server db:sync`，把 Prisma schema 与自定义索引同步到本地 fixture DB
- 再按 `afdian / wander / socket / idle / mail / inventory / market / battle / task / achievement / team / sect / arena / upload / all` 分组运行推荐的 ignored 测试命令
- 脚本会先输出本次 matrix summary，包含分组、命令数量，以及：
- `selected_ignored_tests`：本次动态选中的 高风险 route tests 数量
  - `selected_ignored_tests_ratio`：本次动态选中的 高风险 route tests / 全量 高风险 route tests 覆盖比例
  - `routes_ignored_tests`：`routes.rs` 中 环境依赖测试总量
  - `routes_skipped_db_unavailable_markers`：`routes.rs` 中 `SKIPPED_DB_UNAVAILABLE` 标记总量
  - `routes_ignored_pg_only / routes_ignored_pg_redis / routes_ignored_pg_ai`：按前置依赖类型拆开的 ignored 高风险测试数量
  - `routes_module_distribution`：按 高风险 route tests 前缀聚合的全量模块分布
  - `selected_module_distribution`：按本次动态选中的 高风险测试 前缀聚合的模块分布
- `--gate=pg-only|pg-redis|pg-ai|all` 会把动态发现出来的 高风险 route tests 再按依赖类型过滤，便于在“只有 Postgres”“Postgres+Redis”“Postgres+AI”这些不同环境下分别执行。
- 如果选择 `--gate=pg-ai` 且不是 dry-run，脚本还会额外检查最小 `AI_WANDER_MODEL_PROVIDER / URL / KEY / NAME` 环境变量是否齐全，尽量把“根本没配 AI provider”的失败前移到测试启动前。
- 脚本现在会直接按 `server-rs/src/http/routes.rs` 里真实存在的 环境依赖测试名动态生成命令，不再依赖手工维护少数前缀命令，因此 `afdian / wander` 这类分组会更接近当前仓库里的真实 ignored 矩阵。
- `--list-only` 模式会在打印完 matrix summary 之后，直接输出本次选中的真实 ignored test 命令清单，并提前退出，不会执行 preflight / fixture / db:sync / cargo test 包装。
- `--names-only` 模式会在打印完 matrix summary 之后，直接输出本次选中的**纯测试名**清单，并提前退出，不会执行 preflight / fixture / db:sync / cargo test 包装。
- `--json` 模式会在打印完 matrix summary 之后，直接输出 machine-readable JSON 并提前退出；其中包含本次选中的 `commands`、纯 `test_names`、gate 过滤信息、统计摘要字段，以及 `ai_env_preflight / remote_reachability_mode / remote_reachability_targets` 这些执行前置信号，而 `selected_ignored_tests_ratio` 会直接给出，`routes_module_distribution / selected_module_distribution` 也已是 JSON object，方便进一步自动化消费。
- 默认真实执行模式下，脚本仍会在首个失败命令处退出；如果传入 `--keep-going`，则会继续跑完本次选中的所有 高风险 route tests，并在结尾额外输出 `executed_commands / failed_commands / failed_command_list`，方便把 phase 7 从“首个报错样本”推进到“整批失败面审计”。

如果你只想看命令展开，不实际触发 `db:sync`，可以用：

```bash
scripts/run-server-rs-phase7.sh --dry-run --skip-db-sync
```

如果你已经手动起好了本地 fixture，或者你要直接连远端/现成的 DB 与 Redis，也可以跳过本地 compose 校验、自动启动与健康检查：

```bash
scripts/run-server-rs-phase7.sh --dry-run --skip-fixture-up
```

如果不是 dry-run，脚本现在还会在 `--skip-fixture-up` 模式下按 `--gate` 精细化做最小 TCP reachability 检查：

- `pg-only` / `pg-ai`：只检查 `DATABASE_URL`
- `pg-redis` / `all`：同时检查 `DATABASE_URL` 和 `REDIS_URL`

这样可以避免在“当前 gate 本身并不需要 Redis”时，被无关的 `REDIS_URL` 可达性误拦住。

如果你同时还想跳过本机 `pnpm db:sync`，只审查“当前会跑哪些真实 高风险 route tests”，可以直接用：

```bash
scripts/run-server-rs-phase7.sh --dry-run --skip-fixture-up --skip-db-sync
```

## 3. 建议优先跑的高风险矩阵

### 3.1 Afdian

```bash
cargo test http::routes::tests::afdian_ -- --nocapture
```

也可以直接跑：

```bash
scripts/run-server-rs-phase7.sh afdian
```

### 3.2 Wander

```bash
cargo test http::routes::tests::wander_ -- --nocapture
cargo test http::routes::tests::game_socket_wander_generate_ -- --nocapture
cargo test http::routes::tests::wander_ai_resolution_ -- --nocapture
```

也可以直接跑：

```bash
scripts/run-server-rs-phase7.sh wander
```

### 3.3 Socket success-path 基线

```bash
cargo test http::routes::tests::game_socket_ -- --nocapture
```

也可以直接跑：

```bash
scripts/run-server-rs-phase7.sh socket
```

### 3.4 其他高风险模块

```bash
scripts/run-server-rs-phase7.sh idle
scripts/run-server-rs-phase7.sh mail
scripts/run-server-rs-phase7.sh inventory
scripts/run-server-rs-phase7.sh market
scripts/run-server-rs-phase7.sh battle
scripts/run-server-rs-phase7.sh task
scripts/run-server-rs-phase7.sh achievement
scripts/run-server-rs-phase7.sh team
scripts/run-server-rs-phase7.sh sect
scripts/run-server-rs-phase7.sh arena
scripts/run-server-rs-phase7.sh upload
```

## 4. 验证结论

- 这份基线文档对应的本地 fixture 执行入口已经可用，并已支撑 `server-rs/src/http/routes.rs` 高风险矩阵在本地 Postgres / Redis 环境下跑到 `231 passed / 0 failed / 0 ignored`。
- 需要真实 AI provider / 第三方 HTTP 的测试，仍然需要额外环境变量或 mock 支持；这属于外部环境前置条件，不再构成本计划代码与工程收尾未完成。
- 当前 `phase 7` 文档的角色是复现实测入口与环境前提，而不是记录“仍未完成的阶段性阻塞”。
