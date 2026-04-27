# Node/Rust 后端差异扫描记录（2026-04-27）

## 结论

- NodeJS 仍是业务逻辑权威。
- HTTP method/path surface 已对齐：Node 264 条路由，Rust 264 条，缺失与额外均为 0。
- 旧计划 `docs/superpowers/plans/2026-04-22-rust-battle-engine-node-parity.md` 继续覆盖 BattleEngine；本轮记录只覆盖非战斗扫描。

## Route Surface

命令：

```bash
node scripts/compare-node-rust-routes.mjs
```

结果：

```json
{
  "totals": {
    "node": 264,
    "rust": 264,
    "missingInRust": 0,
    "extraInRust": 0
  },
  "missingByPrefix": {},
  "extraByPrefix": {},
  "missingInRust": [],
  "extraInRust": []
}
```

## Startup / Job 差异入口

Node startup 权威顺序来自 `server/src/bootstrap/startupPipeline.ts`：

1. PostgreSQL 探活。
2. Redis 探活，Redis 失败时仅警告并继续。
3. 生成功法快照刷新、动态伙伴快照失效、数据准备。
4. 性能索引同步。
5. 四类 Delta 聚合器初始化。
6. 头像清理、异常物品数据清理。
7. Worker 池初始化。
8. technique / partner recruit / partner fusion / partner rebone / wander worker 协调器初始化。
9. 过期秘境实例收口。
10. 千层塔冻结怪物池预热。
11. 在线战斗投影预热。
12. 在线战斗延迟结算、Afdian 私信重试、排行夜刷调度器初始化。
13. 游戏时间、竞技场周结算、清理 Worker 初始化。
14. Redis 可用时执行战斗状态恢复与战斗会话恢复。
15. 挂机会话恢复。
16. 最后监听端口。

Rust startup 当前入口来自 `server-rs/src/bootstrap/startup.rs` 与 `server-rs/src/jobs/mod.rs`：

1. 加载 Rust 配置与 tracing。
2. PostgreSQL 连接与 sqlx migration。
3. Redis 探活。
4. outbound HTTP client 与 uploads 目录。
5. RealtimeRuntime 初始化。
6. item data cleanup。
7. generated content refresh。
8. avatar cleanup。
9. performance index sync。
10. dungeon / idle / battle / partner recruit draft / technique draft / mail cleanup。
11. frozen tower pool warmup。
12. persisted battle recovery 与 orphan battle session recovery。
13. JobRuntime 初始化：idle、battle、Afdian、arena weekly settlement、rank snapshot、cleanup loops、AI job recovery、online battle settlement、Delta flush loops。
14. mail counter backfill。
15. online battle projection warmup。
16. game time runtime init。
17. build router。

高风险差异：

- Rust 的 `item data cleanup` 早于 `generated content refresh`，Node 是动态快照刷新与数据准备之后才清理异常物品。
- Rust 的 online battle projection warmup 晚于 JobRuntime 初始化，Node 是先投影预热再启动 online battle settlement runner。
- Rust `JobRuntime::shutdown` 当前只记录日志，Node shutdown 会停止各 runner、等待 drain、flush idle buffers 与四类 Delta 聚合器。

## 千层塔冻结池差异

Node 权威实现：

- `server/src/services/tower/frozenPool.ts`
- `server/src/services/tower/frozenFrontier.ts`
- `server/src/services/tower/algorithm.ts`

Rust 当前实现：

- `server-rs/src/jobs/tower_frozen_pool.rs`
- `server-rs/src/http/tower.rs`

本轮发现并已收敛的历史差异：

- 本轮发现 Rust 曾在 `frozenFloorMax > 0` 且 snapshot 为空时缓存空池；当前已改为对齐 Node 报错：`千层塔冻结怪物池缺失: frozen_floor_max=<n>`。
- 本轮发现 Rust 曾对 snapshot `kind/realm/monster_def_id` 空字段静默跳过；当前已改为报错。
- 本轮发现 Rust 曾在 snapshot 指向不存在 monster 定义时用 monster id 作为名称继续运行；当前已改为报错。
- 本轮确认 Node 的冻结池怪物定义索引会跳过 `monster_def.json` 中的 `_comment` 元数据行；Rust 当前已对齐跳过这类非怪物条目，真实怪物定义仍严格校验空 id/name。
- Node 会对冻结池结果做深拷贝；Rust 读缓存时 clone 结构体，语义可接受。

## Seed / Config 严格性扫描入口

优先扫描这些 Rust 读取静态 JSON 的位置：

```bash
rg -n "unwrap_or_default|unwrap_or_else|Option<|enabled != Some\\(false\\)|read_to_string|serde_json::from_str" server-rs/src -g '*.rs'
```

扫描时只把 Node 明确允许缺省的字段映射为 `Option`。Node 严格校验的配置，如 `insight_growth.json`，Rust 不得引入默认值、静默空数组或旧结构兼容。

## Seed / Config 首批锚点

扫描命令：

```bash
rg -n "unwrap_or_default|unwrap_or_else|Option<|enabled != Some\\(false\\)|read_to_string|serde_json::from_str" server-rs/src -g '*.rs'
```

首批人工核对锚点：

- `server-rs/src/realtime/public_socket.rs` 读取 `month_card.json` 时使用 `unwrap_or_default`，需要对照 Node `server/src/services/shared/staminaRules.ts` 与 `server/src/services/shared/monthCardBenefits.ts` 判断哪些字段允许缺省。
- `server-rs/src/bootstrap/item_data_cleanup.rs` 读取 item/equipment/gem seed，必须和 Node `server/src/services/staticConfigLoader.ts` 的 enabled 与分类规则一致。
- `server-rs/src/battle_runtime.rs` 读取 monster/skill seed，仍由旧 battle parity 计划覆盖，不在本计划重复修补。
- `server-rs/src/jobs/tower_frozen_pool.rs` 本轮已严格化冻结池 snapshot/frontier/monster seed 读取，后续扫描只需回归确认没有重新引入静默默认或跳过。
