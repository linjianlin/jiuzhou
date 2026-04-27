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
6. generated content refresh。
7. item data cleanup。
8. avatar cleanup。
9. performance index sync。
10. dungeon / idle / battle / partner recruit draft / technique draft / mail cleanup。
11. frozen tower pool warmup。
12. persisted battle recovery 与 orphan battle session recovery。
13. online battle projection warmup。
14. JobRuntime 初始化：idle、battle、Afdian、arena weekly settlement、rank snapshot、cleanup loops、AI job recovery、online battle settlement、Delta flush loops。
15. mail counter backfill。
16. game time runtime init。
17. build router。

高风险差异：

- Rust 的 `item data cleanup` 曾早于 `generated content refresh`；Batch 4 已调整为先刷新 generated content，再清理异常物品。
- Rust 的 online battle projection warmup 曾晚于 JobRuntime 初始化；Batch 4 已调整为先投影预热，再启动 JobRuntime 中的 online battle settlement runner。
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

## Deep Scan Batch 2（tower / realtime stamina / item cleanup）

本批继续以 NodeJS 为业务权威，聚焦上一轮留下的三个高风险锚点：

1. `server-rs/src/http/routes.rs` 中 `battle_route_tower_win_sets_waiting_transition_and_persists_progress` 曾在变更前基线复现失败，必须确认 Rust 塔胜利结算最终写入 `best_floor=13`、`next_floor=14`、`last_settled_floor=13`。
2. `server-rs/src/realtime/public_socket.rs` 中实时角色快照体力计算必须对齐 Node `server/src/services/shared/staminaRules.ts` 中 `resolveStaminaRecoveryState` 的有效恢复时长公式，以及 `server/src/services/shared/monthCardBenefits.ts` 的月卡恢复速度裁剪规则。
3. `server-rs/src/bootstrap/item_data_cleanup.rs` 的有效物品定义集合必须对齐 Node `server/src/services/staticConfigLoader.ts` 的 `ensureItemDefinitionSnapshot()`，即合并 `item_def.json`、`gem_def.json`、`equipment_def.json`，过滤空 id，保留禁用定义 id，去重后用于启动脏数据清理。

本批不扩大到 BattleEngine；战斗运行时仍由 `docs/superpowers/plans/2026-04-22-rust-battle-engine-node-parity.md` 覆盖。

## Deep Scan Batch 2 结果

- Route surface 复验仍为 Node 264 / Rust 264，缺失与额外均为 0。
- 塔胜利 route 测试改为等待当前 `tower-win:<battleId>` settlement task 完成，避免共享 fixture DB 中旧 pending task 让单次 tick 命中别的任务；Rust 最终进度断言锁定 `best_floor=13`、`next_floor=14`、`last_settled_floor=13`、`current_battle_id=NULL`。
- 实时体力恢复新增 `now_ms` 注入测试，锁定 Node `resolveStaminaRecoveryState` 的有效恢复时长公式：月卡恢复速度只增加有效 elapsed，不直接增加单 tick 恢复量。
- 物品清理新增纯 merge 测试，锁定 Node `ensureItemDefinitionSnapshot()` 语义：合并 item/gem/equipment 三份 seed、trim id、过滤空 id、去重后用于三张物品运行时表清理。

## Deep Scan Batch 2 待单独处理锚点

- `server-rs/src/http/inventory.rs` 仍存在与本批实时体力修复同类的风险：体力恢复 elapsed 计算使用 `round()`，时间解析也仍只覆盖 RFC3339。该路径需要按 Node `resolveStaminaRecoveryState` 语义单独补测与收敛。

## Deep Scan Batch 3（inventory stamina recovery）

本批继续以 NodeJS 为业务权威，聚焦 `server-rs/src/http/inventory.rs` 中三处使用 `resolve_stamina_recovery_state()` 的物品使用路径：

1. `use_inventory_item_tx()` 使用体力恢复状态后叠加单 effect 物品效果。
2. `use_inventory_multi_effect_item_tx()` 使用体力恢复状态后叠加多 effect 物品效果。
3. `load_inventory_use_character_snapshot()` 使用体力恢复状态构造物品使用后的角色快照。

上一批已修复 `server-rs/src/realtime/public_socket.rs` 的实时快照体力计算；本批要求 inventory 路径复用同一 Node 语义：有效恢复时长保留浮点直到 tick floor，PostgreSQL `timestamptz::text` 可解析，非法 `recoverAt` 按 Node 规则视为 `nowMs`。

## Deep Scan Batch 3 结果

- Route surface 复验仍为 Node 264 / Rust 264，缺失与额外均为 0。
- `server-rs/src/http/inventory.rs` 新增 `now_ms` 注入的 helper 级测试，锁定 `use_inventory_item_tx()`、`use_inventory_multi_effect_item_tx()`、`load_inventory_use_character_snapshot()` 共同调用的 `resolve_stamina_recovery_state()` 语义。
- Inventory 体力恢复已对齐 Node `resolveStaminaRecoveryState` 的有效恢复时长公式：月卡恢复速度只增加有效 elapsed，浮点结果保留到 tick floor，避免边界多恢复 1 tick。
- Inventory 时间解析已覆盖 PostgreSQL `timestamptz::text` 的 `+00`、`-07`、`+05:45`、`+05:45:30` 形态，避免 DB 查询文本无法恢复体力。
- Inventory 对非法 `recoverAt` 按 Node 规则视为 `nowMs`，写回合法 `next_recover_at_text`，不保留非法输入字符串。
- Inventory 逆推 `next_recover_at_text` 已覆盖 `month_card_start_at` 缺失但 `expire_at` 有效的窗口，保持 Node `startAtMs === null` 的向前无限加速窗口语义。
- 验证命令已执行：`node scripts/compare-node-rust-routes.mjs` 通过，`cargo test inventory_stamina_recovery -- --nocapture` 为 7 passed，`cargo test inventory_ -- --nocapture` 为 114 passed，`cargo fmt --check` 通过，占位词扫描无输出。

## Deep Scan Batch 4（startup / job order）

本批继续以 NodeJS 为业务权威，聚焦启动链中仍记录为高风险的两个顺序差异：

1. Rust `bootstrap_application()` 仍先执行 `cleanup_undefined_item_data_on_startup()`，再执行 `refresh_generated_content_on_startup()`；Node `startServerWithPipeline()` 是先刷新 generated technique / partner snapshots 与数据准备，再做 `itemDataCleanupService.cleanupUndefinedItemDataOnStartup()`。
2. Rust `bootstrap_application()` 仍先执行 `JobRuntime::initialize()`，其中会启动 online battle settlement loop，再执行 `warmup_online_battle_projection_runtime()`；Node 是先执行 `warmupOnlineBattleProjectionService()`，再初始化 `initializeOnlineBattleSettlementRunner()`。

本批只调整启动顺序，不改变各 startup step 的内部业务逻辑。

## Deep Scan Batch 4 结果

- Rust startup 顺序已对齐 Node：`refresh_generated_content_on_startup()` 先于 `cleanup_undefined_item_data_on_startup()`。
- Rust online battle projection warmup 已调整到 `JobRuntime::initialize()` 之前，避免 online battle settlement runner 先于投影预热启动。
- 新增 `startup_source_orders_generated_content_before_item_cleanup` 与 `startup_source_orders_online_projection_warmup_before_job_runtime_initialize`，用 source-order 回归测试锁定两个顺序约束。
- 验证命令已执行：`cargo test startup_source_orders -- --nocapture` 为 2 passed，`cargo test startup -- --nocapture` 为 7 passed，`cargo fmt --check` 通过。
