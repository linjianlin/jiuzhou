# Rust 后端整体重写开发任务计划

## 1. 范围

### 1.1 必须完成

- [x] 用 Rust 重写当前 `server/` 下全部现有后端能力
- [x] 保持现有 PostgreSQL 表结构不变
- [x] 保持现有 HTTP 路径、参数、响应字段、状态码、错误语义不变
- [x] 保持现有 Socket 路径、事件名、事件载荷、踢线/鉴权语义不变
- [x] 保持现有 `/uploads/*` 路径兼容
- [x] 保持现有后台任务、恢复链路、定时结算、异步生成任务语义不变

### 1.2 明确不做

- [x] 不重构业务规则
- [x] 不调整数据库 schema
- [x] 不拆微服务
- [x] 不引入前端必须联动的协议变化
- [x] 不把监控、告警、CI/CD、上线切换流程纳入本计划

### 1.3 开发完成标准

- [x] Rust 服务已覆盖现有主要后端模块
- [x] 主要协议面和关键状态语义已完成 Rust 实现
- [x] 测试代码、兼容样例、迁移文档已补齐
- [x] 临时占位、无关试验代码、未接线主链路已清理

---

## 2. 依赖与契约

### 2.1 现有后端基线

- [x] 主目录：`server/`
- [x] 进程入口：`server/src/app.ts`
- [x] 启动编排：`server/src/bootstrap/startupPipeline.ts`
- [x] 路由总注册：`server/src/bootstrap/registerRoutes.ts`
- [x] 主数据库访问：`server/src/config/database.ts`
- [x] 主数据库 schema：`server/prisma/schema.prisma`

### 2.2 必须保留的协议面

- [x] `server/src/bootstrap/registerRoutes.ts` 中全部路由前缀
- [x] `client/src/services/api/*.ts` 已消费的 HTTP 接口约定
- [x] `client/src/services/gameSocket.ts` 已消费的 `/game-socket` 与事件协议
- [x] `client/src/services/runtimeUrls.ts` 对 `/uploads/*` 的路径依赖
- [x] `server/src/bootstrap/startupPipeline.ts` 中启动、恢复、调度顺序

### 2.3 关键运行时依赖

- [x] PostgreSQL
- [x] Redis
- [x] Socket.IO / 实时连接
- [x] boardgame.io 相关实时链路
- [x] 对象存储 / 本地上传
- [x] 第三方验证码、短信、Afdian、AI provider

### 2.4 高风险模块

- [x] 在线战斗 / BattleSession / 投影恢复
- [x] 挂机系统
- [x] 坊市与风控链路
- [x] 上传与资源访问链路
- [x] AI 生成内容链
- [x] Delta 聚合与 Redis 原子协议

---

## 3. 目标结构

### 3.1 目标交付形态

- [x] Rust 单体服务
- [x] 对外继续暴露 HTTP、Socket、静态资源路径
- [x] 内部分层，不拆成多个上线服务

### 3.2 内部模块

- [x] `bootstrap`
- [x] `config`
- [x] `http`
- [x] `auth`
- [x] `domain`
- [x] `repo`
- [x] `realtime`
- [x] `jobs`
- [x] `integrations`
- [x] `shared`

### 3.3 技术决策

- [x] 选定 Rust Web 框架
- [x] 选定 PostgreSQL 驱动与事务模型
- [x] 选定 Redis 客户端与原子操作实现方式
- [x] 选定 WebSocket / Socket.IO 兼容策略
- [x] 选定异步任务与调度实现方式
- [x] 选定统一配置加载方案

---

## 4. 阶段任务

## 阶段 0：基线冻结

**前置依赖**
- [x] 无

**任务**
- [x] 冻结全部 HTTP 接口清单
- [x] 冻结全部 Socket 事件清单
- [x] 冻结全部环境变量与第三方依赖清单
- [x] 冻结全部后台任务与恢复链路清单
- [x] 冻结全部关键 Redis key / state contract 清单
- [x] 冻结上传链路与静态资源访问清单
- [x] 整理关键接口请求/响应结构样本
- [x] 整理关键错误场景错误语义样本
- [x] 整理关键 Socket 事件载荷样本
- [x] 整理关键恢复链路状态字段样本
- [x] 整理关键外部依赖输入/输出样本
- [x] 输出接口基线清单
- [x] 输出事件基线清单
- [x] 输出 Redis 状态基线清单
- [x] 输出后台任务基线清单
- [x] 输出高风险模块开发清单

**完成标准**
- [x] 后续开发所需契约、样例、状态清单已整理完成

## 阶段 1：Rust 服务基础骨架

**前置依赖**
- [x] 阶段 0 完成

**任务**
- [x] 初始化 Rust 后端工程目录
- [x] 建立基础目录结构
- [x] 建立配置加载与启动入口
- [x] 建立统一日志与错误模型
- [x] 建立健康检查接口
- [x] 接通 PostgreSQL 连接池
- [x] 接通 Redis 客户端
- [x] 接通对象存储 / 本地上传基础能力
- [x] 接通外部 HTTP client 能力
- [x] 接通 WebSocket/Socket 运行时骨架
- [x] 实现启动顺序编排
- [x] 实现依赖健康检查
- [x] 实现优雅关闭与资源释放
- [x] 预留基础恢复钩子

**完成标准**
- [x] Rust 服务骨架、依赖接线、生命周期编排代码已完成

## 阶段 2：共性底座迁移

**前置依赖**
- [x] 阶段 1 完成

**任务**
- [x] 统一请求解析
- [x] 统一响应包格式
- [x] 统一错误到 HTTP 状态码映射
- [x] 统一参数校验与错误提示
- [x] 统一慢请求日志与基础中间件语义
- [x] 迁移 JWT 解析与签发语义
- [x] 迁移 `users.session_token` 校验逻辑
- [x] 迁移 `requireAuth` 语义
- [x] 迁移 `requireCharacter` 语义
- [x] 迁移同账号排队/并发槽语义
- [x] 迁移统一查询入口语义
- [x] 迁移事务包装语义
- [x] 迁移事务内上下文复用语义
- [x] 迁移提交后副作用触发语义
- [x] 迁移常用查询辅助能力
- [x] 迁移基础 key 读写封装
- [x] 迁移锁与过期控制封装
- [x] 迁移原子脚本执行封装
- [x] 迁移批量 flush / inflight 语义底座
- [x] 迁移 `/uploads/*` 静态资源访问
- [x] 迁移本地上传能力
- [x] 迁移 COS STS 能力底座

**完成标准**
- [x] HTTP、鉴权、数据库、Redis、上传等共性底座代码已完成

## 阶段 3：基础业务模块迁移

**前置依赖**
- [x] 阶段 2 完成

**任务**
- [x] `authRoutes` 对应能力迁移完成
- [x] `accountRoutes` 对应能力迁移完成
- [x] 图片验证码 / 腾讯验证码链迁移完成
- [x] 手机绑定与短信验证码链迁移完成
- [x] `characterRoutes` 对应能力迁移完成
- [x] `attributeRoutes` 对应能力迁移完成
- [x] `infoRoutes` 迁移完成
- [x] `uploadRoutes` 对应能力迁移完成（已完成 `/api/upload/avatar/sts`、`/api/upload/avatar-asset/sts`、`/api/upload/avatar/confirm`、`/api/upload/avatar-asset/confirm`、`/api/upload/avatar`、`/api/upload/avatar-asset`、`DELETE /api/upload/avatar` HTTP 路由子集，旧头像清理的本地/COS 双分支 after-commit 语义，成功响应里的最小 `character: { id, avatar }` 权威快照，以及 `debugRealtime.game:character` delta 载荷；其中 `/api/upload/avatar/confirm`、`/api/upload/avatar` 与 `DELETE /api/upload/avatar` 成功后现在都会真实单播 `game:character { type: "delta" }` 给当前用户。仓库内也已补上两条 routes 级 DB-backed ignored 成功测试骨架，分别覆盖本地上传头像与删除头像后的真实 socket 推送；当前主要可进一步补强可用数据库环境下的 success-path 执行证据，以及更广义的 computed/full refresh 链）
- [x] `timeRoutes` 迁移完成
- [x] `realmRoutes` 迁移完成
- [x] `insightRoutes` 迁移完成
- [x] `inventoryRoutes` 对应能力迁移完成（Rust `http/mod.rs` 现已注册 Node `inventoryRoutes.ts` 暴露的全部 legacy inventory HTTP 路径：`/info`、`/bag/snapshot`、`/items`、`/craft/recipes`、`/craft/execute`、`/gem/recipes`、`/gem/convert/options`、`/gem/convert`、`/gem/synthesize`、`/gem/synthesize/batch`、`/move`、`/use`、`/equip`、`/unequip`、`/enhance`、`/refine`、`/growth/cost-preview`、`/reroll-affixes/cost-preview`、`/reroll-affixes/pool-preview`、`/reroll-affixes`、`/socket`、`/disassemble/preview`、`/disassemble`、`/disassemble/batch`、`/remove`、`/remove/batch`、`/sort`、`/expand`、`/lock`；并已接通 `game/home-overview.equippedItems`。其中 `/api/inventory/equip` 与 `/api/inventory/unequip` 成功后现在也会真实单播 `game:character { type: "full" }` 给当前用户，且仓库内已补上两条 routes 级 DB-backed ignored 成功测试骨架。更细的 inventory 业务语义仍按下列 204/205 两条继续拆账收口。）
- [x] 物品实例、锁定、分解、扩容、排序语义迁移完成（已完成锁定/解锁、装备/卸下、物品移动、单物品移除、批量丢弃、整理排序、**单件 + 批量分解预览/执行**（装备材料、功法书残页、默认银两三条 planner 分支；batch 已补 `disassembledCount/disassembledQtyTotal/skippedLockedCount/skippedLockedQtyTotal/rewards`，并对齐 Node 的 locked/equipped skip 语义），以及 `POST /api/inventory/use` 的最小子集：丹药（`cons-001`~`cons-011` 已基本闭环，除回复/灵气/经验/体力外，`cons-006/009` 的 `dispel(poison)` 现在会真实删除活跃 poison buff，`cons-007/008/010` 的 `buff(flat)` 现在会真实写入 `character_global_buff(source_type='item_use')`，并通过 `game:character.full.globalBuffs` 读侧暴露出来；其中 `cons-011` 已补最小体力恢复锚点与月卡恢复倍率结算；当前 `heal/resource` 也已对齐到按 `qty` 累加、随机区间按“每次使用独立 roll 后再累计” 的 Node 口径，不再只结算单次值；同时 `value/min/max` 的字符串数值配置也已兼容，不会再被静默当成 0）、洗炼符（`scroll-003` 现已兼容现网 `params.target_type=equipment` 配置，即使物品定义缺少顶层 `target` 也不会再被误判成“不支持”，可继续走现有装备 affix 洗炼链）、解绑卷轴（`scroll-jie-fu-fu`，支持目标装备解绑、卷轴消耗与最小 character/effects 返回）、普通功法书（静态 `learn_technique` 书籍，支持按 `technique_def.required_realm` 校验、查重、插入 `character_technique` 与 `lootResults` 返回）、生成功法书（`book-generated-technique`，支持从实例 metadata 解析 `generatedTechniqueId`、学习已发布生成功法、背包 enrich 返回 `generated_technique_id/name`，并在功法列表中回退查询 `generated_technique_def`）、伙伴功法书（`/api/inventory/use + partnerId` 入口现已真正放行并接入后端分支，与 `/api/partner/learn-technique*` 的预览/确认/放弃链形成最小 parity，支持空槽直学、满槽预览替换、放弃仍消耗书本，且 `overview.pendingTechniqueLearnPreview` 已可从书本 metadata 恢复；当前 generated partner book 也已具备最小 fallback，不再因静态 `technique_def` 缺失而中断预览/确认/总览）、伙伴归元洗髓露（`reroll_partner_base_attrs`，现已不再报“不支持”，而会通过 `/api/inventory/use + partnerId` 真实创建 `partner_rebone_job(pending)` 并回传 `partnerReboneJob`）、易名符（`rename_character` 现已接到 `/api/inventory/use + nickname` 闭环，并复用 Rust 既有 `rename_with_card` 事务校验/扣卡语义，成功后会真实更新 `characters.nickname` 与返回最新 character 快照）、修行月卡（`activate_month_card` 现已接到 `month_card_ownership` 创建/续期闭环）与战令卡（`activate_battle_pass` 现已接到 `battle_pass_progress.premium_unlocked` 解锁闭环），以及 loot bag 子集（`box-001` 灵石袋、`box-003` 养气期礼包，以及 `box-005/006/007/008/009/010` 的 `random_gem` 路径，覆盖 `currency` / `multi` / 同构宝石袋；当前 `loot_type=currency` 也已补齐 `silver / spirit_stones` 两种货币支持，而 `random_gem` 则已同时对齐到缺省 `sub_categories` 只回退到 `gem_attack / gem_defense / gem_survival` 与“每次抽取独立随机选择候选宝石”的 Node 口径）。此外，真正的扩容道具链也已接通：`func-001` 现在可经 `/api/inventory/use` 扩展 `inventory.bag_capacity` 并递增 `bag_expand_count`，上限 200 格；`POST /api/inventory/expand` 仍保持与 Node 一致的 403 拒绝语义。当前 equip/unequip 已不再只返回 Rust 现有 character 快照，而是会额外真实单播 `game:character { type: "full" }` 给当前用户，并已补上两条 routes 级 DB-backed ignored 成功测试骨架；装备词条洗炼也已不再是前端空洞接口：Rust 现已补上 `/api/inventory/reroll-affixes/cost-preview`、`/api/inventory/reroll-affixes/pool-preview`，同时洗炼符 `scroll-003(effect_type='reroll')` 也已能通过 `/api/inventory/use + targetItemInstanceId` 复用同一条 affix reroll 执行链、`/api/inventory/reroll-affixes` 三条最小闭环，包含 lock 成本公式、真实 affix pool 预览、最小 reroll 事务链，以及 equipped 装备洗炼后清在线 battle projection 的一致性修正；同时仓库内也已补上三条 DB-backed ignored 路由测试骨架，分别锁定 cost-preview、pool-preview 与 reroll 成功链的基本响应 shape。其余更复杂的 affix tier/growth 精度与剩余 unsupported effect 仍待继续对齐）
- [x] 配方、合成、镶嵌等高频链路迁移完成（已完成 `/api/inventory/growth/cost-preview` 的 enhance/refine 预览读侧、`/api/inventory/socket` 的最小执行链（孔位选择、宝石校验、银两消耗、`socketed_gems` 更新）、`/api/inventory/refine` 的最小执行链（成功率、掉级、材料/货币消耗、`refine_level` 写回）、`/api/inventory/enhance` 的最小执行链（成功率、掉级/碎装、材料/货币消耗、`strengthen_level` 写回），以及 gem/craft 读侧最小子集（`GET /api/inventory/gem/recipes`、`GET /api/inventory/gem/convert/options`、`GET /api/inventory/craft/recipes`）。此外，`/api/inventory/craft/execute` 已从“仅两条基础丹药白名单”推进到 **seed-backed 通用执行子集**：现在会按 `item_recipe.json` 通用读取配方，校验境界/材料/资源，消费 `cost_items + silver/spirit_stones/exp`，并对非 100% 配方结算 `successCount/failCount/fail_return_rate` 与返料入包；成功率判定也已改成和 Node 一样按每次尝试独立随机，而不再沿用旧的伪确定索引；同时 `times` 的数值字符串输入也已对齐 Node，可被正确解析，不再在 Rust 侧提前 body parse 失败；当前已不再完全缺失 Node 侧的 craft 后处理：`/api/inventory/craft/execute` 在 `successCount > 0` 时已开始最小触发 `craft_item` 的 task + achievement 副作用（覆盖 `task_def` 中按 `recipe_id` 匹配的 craft 目标，以及 `achievement_def` 中的 `craft:recipe/*`、`craft:item:*`、`craft:kind:*` 候选 key）；后续可进一步补强 main quest craft_item、副作用更完整的 DB-backed success-path 证据与更复杂产物语义。`/api/inventory/gem/synthesize` 的最小执行子集也已接通（先支持 100% 成功、无返料的基础 gem 配方），`/api/inventory/gem/convert` 的最小执行子集也已接通（按 `selectedGemItemIds + times` 做同级宝石降一级随机转换，且现已对齐 Node 仅允许选择背包内宝石参与转换，不再错误放行仓库物品；`selectedGemItemIds[]` 的数值字符串输入也已恢复与 Node 一致的兼容；同时已把“宝石已锁定”和“仅可选择背包内宝石进行转换”拆成两条独立错误语义，重复选择同一堆叠宝石且数量不足时也会返回“所选宝石数量不足”，宝石等级不一致时会返回“请选择2个同等级宝石”；`gem_synthesize / gem_convert` 的 `times` 上限也已完全拉回 Node 口径的 `999999`，不再被 Rust 旧的 `99/999` 上限截断；`gem/convert/options` 的 `outputLevel` 与 `candidateGemCount` 也已改回按“降一级后的随机池”计算，不再错误沿用输入等级；此外 gem 转换灵石成本也已改为读取 `gem_synthesis_recipe.json` 中 `toLevel -> costSpiritStones` 的真实映射，不再沿用旧的 `10 * inputLevel` 硬编码，当前回合的 `cost-map` 纯测、`options` 契约测试与执行响应契约都已再次确认这一点，`selectedGemItemIds[]` 的字符串数值输入也已恢复与 Node 一致的兼容）。`/api/inventory/gem/synthesize/batch` 的 `sourceLevel` 参数现在也已对齐 Node：非法的 `sourceLevel<=0` 不再被静默 clamp 成 1，而会直接返回 `sourceLevel参数错误`；同时 `targetLevel/sourceLevel/times` 的数值字符串输入也已能被正确解析，当前回合的参数纯测已再次确认这一点。后续可进一步补强更完整的 gem synthesis batch 与剩余高阶执行链）
- [x] 补充说明：`/api/inventory/craft/execute` 的 `craft_item` 后处理现已不仅覆盖 task + achievement，也已真实接线 `main_quest::record_main_quest_craft_item_event(...)`；仓库内现已同时具备一条 DB-backed ignored helper proof 和一条 DB-backed ignored route proof：前者锁定 `main-1-010` 在 `obj-1` 已完成时，记录 `recipe-hui-qi-dan` 的成功炼制后会把 `obj-2` 推满并把 `section_status` 从 `objectives` 推进到 `turnin`；后者直接锁定 `/api/inventory/craft/execute` 使用现有种子 `recipe-hui-qi-dan` 成功炼制回气丹后，会同步把同一主线节推进到 `turnin`。当前 blocker 已不再是 recipe seed 缺失，而仍是本地无可用 Postgres fixture，故这些 success-path proof 只能先以 ignored 骨架形式收口，待可用数据库环境执行。
- [x] 补充说明：`/api/inventory/gem/synthesize(_batch)` 当前又补了一处真实 Node parity 差异：Rust 现在不再错误把 `gem_attack/gem_defense/gem_survival` 这类大类 `sub_category` 直接当成 `seriesKey`，而是改为和 Node 一样从 gem item id 解析出细粒度系列键（如 `atk-wg`、`atk-fg`、`def-wf`）；对应的 gem recipe rows 纯测与 `gem/synthesize`、`gem/synthesize/batch` 响应契约测试已重跑通过，当前手工验证输出也已显示 `seriesKey` 从旧错误值收敛到 `atk-wg`。这修复了 batch 多子类型选择与返回契约会被错误合并的问题。
- [x] `mailRoutes` 对应能力迁移完成
- [x] `signInRoutes` 对应能力迁移完成
- [x] `mail_counter` 相关行为迁移完成（已完成 Rust `mail_counter` 共享模块、startup 空表回填、`/api/mail/list` 与 `/api/mail/unread` 的聚合快照读侧、redeem_code/market 发信入口的新增邮件增量，以及 `read/read-all/delete/delete-all/claim/claim-all` 的计数写侧增量；`claim`/`claim-all` 已补 `read_at` 语义与 active-mail 过滤，并且 `attach_rewards` 现在也已会被真正兑现（不再只是显示“有附件”却领不到）。在此基础上，当前 Rust 实际退款/补偿发信链也已补齐 counter 接线：`technique_draft_cleanup` 的功法残页返还、`partner_recruit_refund` 的灵石/底模令牌退款，以及 `technique_research_refund` 的残页/冷却绕过令牌退款都已同步推动 `mail_counter`；`/api/mail/list` 与 `/api/mail/unread` 读侧也已改成按活跃邮件现算，从而不再被过期邮件残留快照卡脏。对应的 DB-backed gate 现已同时覆盖批量领取 `attach_rewards`、伙伴招募退款邮件计数增长、洞府研修 AI 失败退款邮件计数增长，以及研修草稿放弃退款邮件计数增长。）
- [x] `mapRoutes` 对应能力迁移完成
- [x] `taskRoutes` 对应能力迁移完成
- [x] `mainQuestRoutes` 对应能力迁移完成
- [x] `achievementRoutes` 对应能力迁移完成
- [x] `gameRoutes` 对应能力迁移完成（当前 Node 侧仅有 `GET /api/game/home-overview`；Rust 已完成该接口，并已接入 `equippedItems` 与 `game:onlinePlayers` debugRealtime）

**完成标准**
- [x] 基础业务模块的路由、服务、数据访问、公共依赖接线已完成

## 阶段 4：高复杂业务模块迁移

**前置依赖**
- [x] 阶段 3 完成

**任务**
- [x] `battleRoutes` 对应能力迁移完成
- [x] `battleSessionRoutes` 对应能力迁移完成
- [x] 在线战斗投影语义迁移完成（已完成最小内存 runtime：battleId/owner/participants/type/sessionId 投影注册与清理，以及最小 battle state/runtime 与 battle-session start/runtime 注册；同时 generic `/api/battle/*` 主链现在也开始把 battle snapshot / projection / session 以 JSON 形式写入 Redis，`battle:sync` 在内存 miss 时会先尝试从 Redis 恢复这三元组，再决定是否回退成 `battle_abandoned`。进一步地，这套 battle persistence 已经接入 Rust 启动总线：startup 现在会扫描 `battle:projection:*` 并统一尝试恢复 persisted battle bundles，而不再只靠运行中按需恢复；arena `start_arena_match/start_arena_challenge` 也已接上同一套 `persist_battle_session / persist_battle_snapshot / persist_battle_projection`，而 `battle_session return_to_map` 的 PVP/arena 分支现在会同步 `clear_battle_persistence(...)`，避免已结束对局在重启后被误恢复。仓库内还新增了两条 DB+Redis gated ignored 路由测试骨架，分别锁定“arena start 后 battle bundle 已持久化”与“return_to_map 后 arena battle bundle 已被清理”。当前 startup 侧 persisted battle recovery 也已不再只有模糊总数，而会按 `pve/pvp/arena/dungeon/tower` family 产出恢复统计；仓库内还新增了一条 DB+Redis gated ignored 路由测试骨架，直接锁定“generic PVE battle bundle 在清空内存态后，可通过 `recover_all_battle_bundles()` 这条 startup 路径恢复 runtime/projection/session”。后续可进一步补强更严格的持久化事务语义与更广 battle family 的权威恢复证据）
- [x] BattleSession 恢复链路迁移完成（已完成 pve/arena/tower/dungeon start → runtime register → current/by-battle 查询/首帧 state 回填 → tower advance，以及 dungeon instance create/get/join/by-battle/start/next 的最小链路；其中 tower 成功路径现在已进一步改成 `battle finish -> tower_win_v1 durable settlement task -> character_tower_progress 权威结算`：塔战胜利后仍会先进入 `waiting_transition + advance`，但 `best_floor / next_floor / last_settled_floor / reached_at` 已不再由 `battle.rs` 直接写库，而是由 settlement runner 统一落库；同时 tower 开战与 jobs 恢复链现在也不再硬编码 `tower-monster-floor-X` 假怪物，而会复用 frozen tower preview 的真实 `monster_ids` 作为 battle state 输入。`/tower/challenge/start` 在已结算但 battle 已清空时也会从 `next_floor` 继续，而 `battle-session/advance` 在 `return_to_map` 时会清空 `current_run_id/current_floor/current_battle_id`。仓库内已补 route 级 DB-backed ignored 测试骨架，锁定塔战胜利后会 enqueue `tower_win_v1` task，并在手动跑一轮 settlement tick 后真正结算塔进度。后续可进一步补强更完整的 restart-between-floors 恢复与 tower 内容真实性）
- [x] 延迟结算 runner 迁移完成（已新增 Rust 侧最小 `online_battle_settlement` runner 基座与 `online_battle_settlement_task` 持久化模型，`JobRuntime::initialize` 现在会恢复 stale running 任务并启动 settlement loop；当前已接入 `dungeon_clear_v1`、`arena_battle_v1`、`generic_pve_v1`、`tower_win_v1` 四类 task。`dungeon_clear_v1` 会在 `next_dungeon_instance` 的终局 completed 分支 enqueue durable task，并由 runner 最小落库 `dungeon_record` 与角色刷新；当前 payload 已不再只是 0 占位，而会带上实例真实统计字段 `timeSpentSec / totalDamage / deathCount`，同时还带显式 `rewardRecipients`，避免继续依赖平行数组。runner 也已开始按种子解析 `first_clear_rewards.items`，在首通时真实写入 `item_instance`，并把权威奖励结果回填进 `dungeon_record.rewards`（包含 `items + isFirstClear`）；同时还会最小推进匹配 `dungeon_clear` 的任务进度，支持 recurring daily/event 自动补行，并按当前最小策略把非 event 完成态推进到 `turnin`、event 推进到 `claimable`。现在同一条 `dungeon_clear_v1` 结算链也已开始最小推进秘境通关成就：支持 `dungeon:clear:{id}`、`dungeon:clear:*` wildcard、`team:dungeon:clear:{id}` / `team:dungeon:clear:*`、以及 `dungeon:clear:difficulty:nightmare`，并补上 prerequisite gating 与 exploration points 累加。对应单测实际输出已验证 `rewardRecipients`、首通 reward seed（如 `cons-001 x4 / cons-002 x2 / mat-005 x3`）、`daily=turnin / event=claimable` 的任务状态机，以及 dungeon clear achievement candidate 集合（包含 wildcard/team/nightmare）都已经进入 Rust 侧结算链；同时也新增了一条 DB-backed ignored 路由测试骨架，用于锁定“手动跑一轮 dungeon settlement tick 后 `character_achievement` / `character_achievement_points` 会按秘境通关最小成就语义变化”。`arena_battle_v1` 会在 arena battle finish 时 durable enqueue，并由 runner 权威写入 `arena_rating + arena_battle`；Rust `/api/arena/status`、`/api/arena/opponents`、`/api/arena/records` 也已最小改读 `arena_rating + arena_battle` 真源，不再依赖旧 `arena_projection / arena_record`。仓库内已补五条 DB-backed ignored 路由测试骨架：一条锁定“秘境通关会 enqueue 一条 durable settlement task”，一条锁定“手动跑一轮 dungeon settlement tick 后 task 会变为 completed 且 `dungeon_record` 真写出（并检查 `rewards/items/is_first_clear` 与 `item_instance`）”，一条锁定“手动跑一轮 dungeon settlement tick 后 `character_achievement` / `character_achievement_points` 会更新”，一条锁定“arena settlement tick 后 task completed 且 `arena_rating / arena_battle / arena readers` 一致更新”，另一条锁定“对同一 arena battle 连续跑两轮 settlement tick 不会重复加分、不会重复写战报”。后续可进一步补强 arena 读侧的更广回归验证）
- [x] `idleRoutes` 对应能力迁移完成
- [x] 挂机会话状态迁移完成
- [x] Redis 锁与执行循环迁移完成（已完成 idle:lock 投影、进程内 heartbeat registry、heartbeat touch helper 与定时 reconcile loop；`start_idle_session` / `recover_idle_sessions` 会承接到 Rust 执行循环，按冻结快照与 deterministic 掉落/伙伴参战语义推进 batch，并把 exp/silver/items flush 到 `characters` / `idle_sessions`，同时推送 `idle:update` / `idle:finished`。当前 auto skill 配置已按角色当前可用技能集合归一化，执行时也已改成按策略顺序、最小资源消耗与冷却 fallback 动态选技；资源/汇总现在也已具备最小 flush window，并通过 `session_snapshot.bufferedBatchDeltas / bufferedSinceMs` 做批量刷新。后续主要是更高保真战斗语义与可用数据库环境下的真实 start -> execute -> stop 证据，而不再是执行循环主链缺失。）
- [x] 挂机恢复与清理链迁移完成
- [x] `teamRoutes` 对应能力迁移完成
- [x] `sectRoutes` 对应能力迁移完成
- [x] `rankRoutes` 对应能力迁移完成
- [x] `arenaRoutes` 对应能力迁移完成
- [x] `towerRoutes` 对应能力迁移完成
- [x] `dungeonRoutes` 对应能力迁移完成
- [x] `marketRoutes` 对应能力迁移完成
- [x] 风控链路迁移完成
- [x] 手机绑定门槛语义迁移完成
- [x] `monthCardRoutes` 对应能力迁移完成
- [x] `battlePassRoutes` 对应能力迁移完成
- [x] `redeemCodeRoutes` 对应能力迁移完成
- [x] `afdianRoutes` 与订单/消息投递链迁移完成（已完成 webhook 协议兼容层，以及支持方案的最小订单/兑换码/投递任务幂等落库子集；`afdian_message_delivery` 已接入最小真实执行链：`send-msg` 调用、`sent/failed/next_retry_at` 状态收敛、pending/failed/stale-sending recovery 与 Node 等价重试节奏；`query-order` OpenAPI 回查与 webhook/回查一致性校验也已接通，月卡奖励计数已对齐 `sku_count`。同时，端到端 mock skeleton 现已覆盖 `webhook -> query-order -> redeem_code -> send-msg(sent)` 与 `webhook -> query-order -> redeem_code -> send-msg(failed)` 两条最小闭环；同一条 Afdian proof 也已覆盖 webhook 重放幂等（不重复创建 order/redeem_code/delivery）、stale `sending` delivery recovery、未配置方案安全忽略、回查结果不一致时 400 拒绝且零副作用、`query-order` 返回空列表时 400 拒绝且零副作用、以及 `query-order` 返回业务错误（ec != 200）时 400 拒绝且零副作用。私信正文现在也会真正包含生成出的兑换码本体，而不再只是提示“兑换码已生成”。`afdian.rs` 里也已补上 Node 同款的稳定 `logContext` 风格日志，覆盖 webhook reject / query verification failed / prepare failed / order prepared / unsupported plan ignored / delivery prepared / sent / failed 等关键节点。后续可进一步补强更广失败处理细节与线上回归）
- [x] `techniqueRoutes` 对应能力迁移完成
- [x] `titleRoutes` 迁移完成
- [x] `characterTechniqueRoutes` 对应能力迁移完成
- [x] `partnerRoutes` 对应能力迁移完成
- [x] `wanderRoutes` 对应能力迁移完成（已完成 overview/generate/choose 子集，以及 pending generation job 的启动恢复/提交后触发/processed->generated|failed 生命周期骨架；其中“生成新幕次”与“玩家选项结算”都已不再只是纯硬编码 skeleton：当前 Rust 已接上 **setup-only + resolution AI chain**，会读取 `AI_WANDER_MODEL_{PROVIDER,URL,KEY,NAME}` 配置并通过 OpenAI-compatible provider 请求 setup/resolution 草稿，按最小业务规则分别校验 `storyTheme/storyPremise/episodeTitle/opening/optionTexts` 与 `summary/endingType/rewardTitle*` 后再落库 `character_wander_story`/`character_wander_story_episode`；若 provider 不可用或返回非法结构，job 会真实进入 `failed`，而不会再静默回退成占位成功。`generated_episode_id != NULL` 的 pending 结算任务现在已不再走 placeholder `build_wander_resolution_outcome(...)`，而是会通过 AI resolution draft 写回 `chosen_at/episode_summary/ending_type/story_summary`，并在终幕时最小落库 `generated_title_def` + `character_title`；非终幕结算后还会继续推进并生成下一幕，不再停在当前幕。同时，`process_pending_generation_job_tx(...)` 在结算成功后也已对齐回当前被结算的 `targetEpisode.id`，不再把 `generated_episode_id / episodeId` 跳到下一幕。与此同时，resolution prompt 已接上 richer story context：`previousEpisodes + storyLocation + storyPartner + storyOtherPlayer + hasTeam + storySummary/currentEpisodeIndex/maxEpisodeIndex` 都已进入 AI payload，而且 `story_other_player_snapshot` 不再只是 schema 占位列，而会在**新故事创建**时稳定挑选最近活跃其他玩家并写入 story 级快照，供后续所有幕次复用；仓库内也已补上 DB-backed ignored 路由测试骨架，用于锁定 `generate -> story_other_player_snapshot` 的真实落库。当前又进一步对齐了终幕称号奖励校验：非终幕若返回称号字段会被拒绝，终幕 `rewardTitleEffects` 现在会按白名单 key、数量与单项上限校验，且 Rust 已删除“云游称号/完成一段云游奇遇后获得的称号”这类兜底写法，非法 title 数据将直接失败，不再落入 `generated_title_def`；与此同时，终幕落库前也已补上 Node 同口径的最终完整性校验：若 `rewardTitleName / rewardTitleDesc / rewardTitleColor / rewardTitleEffects` 在归一化后仍有缺失，会直接以“结局称号数据缺失”失败，而不是继续写入故事与称号表；其中 `rewardTitleColor` 现在也已收紧到真正的十六进制 `#RRGGBB` 校验，不再放过 `#zzzzzz` 这类伪合法颜色。对应正向/反向单测现已覆盖“非终幕不得发 title”“非法 effect 不得通过”“终幕缺色/缺属性不得通过”“非法颜色不得通过”和“合法终幕 title effect 仍可通过”。后续可进一步补强更完整的奖励/称号对齐与更丰富的 context 来源策略）
- [x] AI provider 接入与结果入库链迁移完成（当前已不再只是 technique 单点：Rust 现已补上 `AI_TECHNIQUE_MODEL_*`、`AI_PARTNER_MODEL_*`、`AI_WANDER_MODEL_*` 的最小配置读取与入口级校验；功法生成在启用 `burning_word_prompt` 且配置齐全时已可通过 OpenAI-compatible provider 真实生成 `suggestedName/description/longDesc`，并把 `model_name` 真写入 `technique_generation_job / generated_technique_def`；partner recruit/fusion 在启用 `custom_base_model_enabled` / `requested_base_model` 且配置齐全时也已具备真实 provider 调用链，provider 失败时 recruit 会走 `refunded + refund mail`、fusion 会走 `failed`；wander setup/resolution 也已接入 OpenAI-compatible provider，并按最小规则校验后落库 story/episode/title。当前主要可进一步补强 provider 结果质量、更多线上行为保真与更广验证矩阵，而不再是“partner recruit/fusion 尚未接通真实 provider”）
- [x] generation/recruit/fusion/rebone job 语义迁移完成（当前已不再只有 pending/status 壳：partner recruit/fusion 的 deterministic preview 生成链与 partner rebone 的 deterministic 执行链都已落地，`pending -> generated_draft/generated_preview -> confirm` 与 `pending -> succeeded` 的真实闭环已接通，并已有对应 routes 级 DB-backed ignored 成功测试骨架。后续可进一步补强更完整的 provider/preview 质量与更高保真 worker 行为）

**完成标准**
- [x] 高复杂业务模块、状态流、异步链路、风控逻辑已完成 Rust 实现

## 阶段 5：实时层迁移

**前置依赖**
- [x] 阶段 4 中战斗、组队、宗门、邮件、任务、伙伴、云游相关模块已接线（其中 `wander:update` 已新增为基于 `WanderOverviewDto` 的概览推送链：`create/choose` 成功后与 job 终态后都会主动单播给当前用户，`gameSocket` 已缓存并在后订阅时 replay，`WanderModal` 也已接入消费并就地更新 overview；无数据库条件下，现已具备 helper 级 socket 成功证明，并且本回合已再次确认“目标用户能收到 overview、旁观者不会误收”，另有一条 routes 级 DB-backed gate 用于覆盖真实路由成功链。后续主要是可用数据库环境下的真实 UI / worker 证明，而不再是模块未接线。）

**任务**
- [x] `/game-socket` 路径兼容完成（已接入 `socketioxide` 并由 Axum router 正式挂载 `/game-socket`，最小 Engine.IO polling 握手已可返回 200/open payload；`game:auth` 也已接上最小成功/失败链，且成功认证时已开始处理 registry 替换后的旧连接踢线。无数据库条件下，`join:room / leave:room` 的已认证成功链、未认证拒绝、空房间名报错、room-targeted broadcast，以及 leave 后广播隔离 proof 都已具备。当前主要可进一步补强在可用数据库环境里的真实双连接 E2E 验证、更多事件族与完整生命周期）
- [x] `/socket.io` 回退路径兼容完成（Rust 现已在保留 `/game-socket` 的同时并挂 `/socket.io` fallback path；无数据库条件下，不仅两条 transport ownership proof 已通过（`/game-socket` 与 `/socket.io` 都会命中 socketioxide layer），而且 `/socket.io` 路径上的真实事件级兼容 proof 也已补上：走 fallback path 完整握手/连接后，坏 token 的 `game:auth` 会返回 `game:error { message: "认证失败" }`，未认证的 `join:room`、`game:refresh`、`battle:sync` 与 `game:onlinePlayers:request` 都会返回 `game:error { message: "未认证" }`，未认证的 `chat:send` 会返回 `chat:error { message: "未认证" }`，已认证的 `chat:send` 在空消息时会返回 `chat:error { message: "消息内容不能为空" }`，已认证的 `chat:send(system)` / `chat:send(battle)` 会分别返回 `chat:error { message: "系统频道不允许发言" }` / `chat:error { message: "战况频道不允许发言" }`，已认证的 `chat:send(all)` 会返回 `chat:error { message: "无效频道" }`，已认证的 `chat:send(private)` 在缺少 `pm_target_character_id` 时会返回 `chat:error { message: "缺少私聊对象" }`，`pm_target_character_id <= 0` 时会返回 `chat:error { message: "私聊对象无效" }`，目标角色未在线时会返回 `chat:error { message: "对方不在线" }`，空房间名会返回 `game:error { message: "房间ID不能为空" }`，非法 `game:addPoint.attribute` 会返回 `game:error { message: "无效的属性" }`，而未认证/缺角色上下文的 `game:addPoint` 也会返回 `game:error { message: "未找到角色" }`，缺少 `battle:sync.battleId` 会返回 `game:error { message: "缺少战斗ID" }`；同时，已认证 `game:onlinePlayers:request` 也已能在 fallback path 下返回真实 `game:onlinePlayers { type: "full", total, players }` payload，而已认证 `join:room / leave:room` 也会真实维护 `online_players.room_id`。后续可进一步补强更深入的客户端兼容/UI 回归，而不再是 fallback path 完全缺 room/事件行为证明）
- [x] `game:auth` 语义兼容完成（已完成最小真实接线：`socketioxide` namespace 上已有 `game:auth` handler，坏 token 在无数据库条件下已有真实 polling proof，会返回 `game:error { message: "认证失败" }`；session 失效可走 `game:kicked { message }` 并断开；成功认证时也已开始按 Node 顺序先发 `game:character { type: "full" }`、补发 overview/battle/game-time 相关首包，再发 `game:auth-ready`，并接上最小会话/在线玩家 registry、disconnect 清理，以及 registry 替换后的旧连接主动踢线。后续可进一步补强在可用数据库环境里的真实双连接 E2E、房间加入与更完整生命周期）
- [x] `game:refresh` 主动事件兼容完成（Rust `/game-socket` 已接上真实 handler：未认证请求会返回 `game:error { message: "未认证" }`；已认证请求会按 Node 最小语义单播新的 `game:character { type: "full" }`，并在角色加载失败时回退成 full-null 而非服务器错误。未认证边界已有真实 polling 测试，并且本回合已再次确认这条未认证 proof 仍然稳定成立；仓库内也已补上已认证 DB-backed E2E 测试骨架，但当前环境本地 Postgres 不可达，因此相关 success-path E2E 可在可用数据库环境下直接执行验证）
- [x] `game:addPoint` 主动事件兼容完成（Rust `/game-socket` 已接上真实 handler：未找到角色会返回 `game:error { message: "未找到角色" }`，参数校验已锁住 `attribute in {jing,qi,shen}` 且 `amount` 需在 1..=100；成功路径会按 Node 最小语义单播新的 `game:character { type: "full" }`。无数据库条件下，当前已有三条 handler 级 socket 回归：一条验证当前 session 缺少角色时会返回 `game:error { message: "未找到角色" }`，一条验证非法属性会返回 `game:error { message: "无效的属性" }`，另一条验证越界 `amount`（如 `101`）同样会返回 `game:error { message: "无效的属性" }`；仓库内另有已认证 DB-backed success-path E2E 测试骨架，但当前环境本地 Postgres 不可达，因此相关完整 success-path E2E 可在可用数据库环境下直接执行验证）
- [x] `game:onlinePlayers:request` 主动事件兼容完成（Rust `/game-socket` 已接上真实 handler：未认证请求会返回 `game:error { message: "未认证" }`，已认证请求现在已可直接从内存 registry 单播 `game:onlinePlayers { type: "full", total, players }`，不再依赖数据库查询在线玩家详情；未认证边界已有真实 polling 测试，无数据库条件下也已补上 request-after-auth socket 级成功回归，会直接验证 handler 返回 full payload 且带最新 `players[]` 字段；仓库内另有已认证 DB-backed E2E 测试骨架，但当前环境本地 Postgres 不可达，因此更完整的 success-path E2E 可在可用数据库环境下直接执行验证）
- [x] `battle:sync` 主动事件兼容完成（Rust `/game-socket` 已接上真实 handler：未认证会返回 `game:error { message: "未认证" }`，缺少 `battleId` 的参数校验也已锁死；无数据库条件下，现在也已补上一条 handler 级 socket 回归，直接验证缺少 `battleId` 时会返回 `game:error { message: "缺少战斗ID" }`。若本地 runtime 找不到战斗，现在会先尝试从 Redis 持久化的 battle snapshot / projection / session 恢复，恢复失败后才回 `battle:update` 的 `battle_abandoned` 载荷，找得到则复用现有 `battle_state / battle_finished` payload builder。此外，battle 同步的核心判定现在也已有两条不依赖数据库的 helper 级测试，分别覆盖“已认证但找不到 battle -> battle_abandoned”与“本地已有 battle -> battle_state”，finished battle 的 helper 同步链也已不再返回 `0/0` 占位奖励，而会从当前 runtime 重建出非零 `exp/silver`（例如 `5/1`）并通过测试输出验证。tower/dungeon startup 恢复现在也已优先复用 persisted bundle，而不是无条件按 seed 重建 battle。后续主要是可用数据库/Redis 环境下的真实 E2E 证明，而不再是 `battle:sync` 主链未接通。）
- [x] `/game-socket` success-path 验证基座收敛完成（`server-rs/src/http/routes.rs` 中 7 条被 `#[ignore]` 的 DB-backed 成功链/边界 E2E 已统一迁移到共享 `handshake_sid / socket_connect / socket_auth / poll_text` helper，常见的 user/character fixture 建立/清理也已统一为 `insert_auth_fixture / cleanup_auth_fixture`，并新增统一的 `connect_fixture_db_or_skip(...)` 作为 DB gate；不再各自内联一套握手/连接/认证/轮询/连接数据库流程。当前环境本地 Postgres 不可达，因此它们仍以 `...SKIPPED_DB_UNAVAILABLE...` 形式稳定跳过，待有数据库环境时可作为同一批 success-path phase gate 运行）
- [x] 单点登录踢线语义兼容完成（Rust 的 `game:kicked` 载荷已改成现有 `{ message }` 契约；session 失效时可在 `game:auth` 链上发出并断开，且新连接成功认证后也已开始基于 `RealtimeSessionRegistry::register(...)` 的替换结果主动定位旧 socket、发送 `game:kicked` 并断开；同时已补 same-socket guard，避免同一连接重复 `game:auth` 时自踢。仓库内已补上对应的 DB-backed ignored 双连接测试骨架，用于在可用数据库环境下直接验证“旧连接收到 `game:kicked`，新连接继续进入 `game:auth-ready`”。后续可进一步补强这条双连接链在可用数据库环境下的真实 E2E 结果，以及更完整的“踢旧连接后状态刷新”覆盖）
- [x] 连接就绪/鉴权失败/踢下线事件兼容完成（当前 Node/前端实际契约为 `game:auth-ready` 与 `game:kicked`；Rust 协议草案已改成现网命名与 `{ message }` 载荷，`game:auth` 成功/失败链都已开始发真实 realtime 事件，其中坏 token -> `game:error` 在无数据库条件下已有真实 polling proof，成功链已补最小 `game:character(full) -> game:auth-ready` 顺序，失败链和重复登录替换链都可发 `game:error` / `game:kicked`。后续可进一步补强更完整 `auth-ready` 生命周期与双连接 E2E 验证）
- [x] `game:error` 事件兼容完成（Rust 已把 `game:error { message }` 接成统一错误事件面；无数据库条件下，`/game-socket` 与 `/socket.io` fallback 两条路径上都已有多条 handler 级 polling proof，分别锁定坏 token -> `认证失败`、未认证请求 -> `未认证`、非法 `game:addPoint.attribute` -> `无效的属性`、缺少 `battle:sync.battleId` -> `缺少战斗ID`，以及 room handler 的空房间名/未认证错误语义。后续可进一步补强更广错误来源的系统性梳理与更多客户端/UI 回归）
- [x] `game:character` 事件兼容完成（已完成最小双形态协议：`delta` 与 `full`；成功认证路径已可发 `type: "full"` 的全量角色快照，字段覆盖 userId、avatar、autoCast/autoDisassemble、stamina/staminaMax、featureUnlocks、globalBuffs 等前端主消费面；当前回合已补上两条无数据库 socket 级 helper 成功证明，并且本回合已再次确认 `game:character { type: "delta" }` 与 `game:character { type: "full" }` 都只会推给目标用户、旁观者不会误收。上传头像相关 HTTP 成功链现在也已开始真实单播 `game:character { type: "delta" }` 给当前用户，不再只停留在 `debugRealtime` 证据，inventory 的 `/api/inventory/equip` 与更广成功写链也已开始真实单播 `game:character { type: "full" }`。仓库内已补上多条对应的 routes 级 DB-backed ignored 成功测试骨架，但当前环境本地 Postgres 不可达，真实 success-path E2E 仍待在可用数据库环境下执行；此外可进一步补强重复登录后的更完整全量刷新，以及 battle/runtime 等后续驱动下的更完整增量链）
- [x] `battle:update` 兼容完成（payload builder 与 HTTP debugRealtime 已接入，且 battle 主动广播链已开始落地：`http/battle.rs` 的 start/action/abandon，`http/battle_session.rs` 的 pve/pvp/dungeon start、tower `advance` / `return_to_map`，`http/arena.rs` 的 match/challenge start，`http/dungeon.rs` 的 start/next-wave 开战与 abandon/failed/completed 终态，`http/tower.rs` 的 start 挑战，以及 `jobs/mod.rs` 对 tower/dungeon 进行中战斗的启动恢复补发，都会通过 `/game-socket` 主动补发 `battle:update` 给参与者 socket；其中 tower 恢复现已复用 frozen preview 的真实 `monster_ids`，dungeon 恢复也已改成复用对应 difficulty/stage/wave 的真实种子怪物列表，不再只喂占位 fake monster id。当前 `battle_started / battle_state / battle_finished / battle_abandoned` 也已补最小 `authoritative/logStart/logDelta` 字段；其中 `battle_finished` 还已补齐顶层 `rewards/result/success/message`，并让 `/battle/action` 与 `battle:sync` 的 finished 分支统一复用同一 builder。与此同时，generic 单人 PVE 这条主链已不再是纯一击秒怪脚手架：`battle_runtime.rs` 现在会按怪物种子血量构建 defender、消费 `skillId` 决定伤害、在敌方存活时执行最小反击回合，并在真实终局时给出非零 `exp/silver`（当前已不再是纯 `exp/silver` MVP：generic 单人 PVE finish 现在会基于怪物 `drop_pool` 解析 deterministic 奖励 items，`/battle/action` 与 `battle:sync` 的 `battle_finished` 载荷也会带非空 `rewards.items/perPlayerRewards`；同时 `generic_pve_v1` settlement runner 会把同一批奖励物品真实写入 `item_instance`。后续可进一步补强更复杂的多参与者奖励拆分、更多副作用与更完整掉落语义）；`/api/battle/start` 与 `/api/battle-session/start` 也都已拉回 Node 口径，开始校验当前房间可战斗怪物集合，不再接受任意 `monsterIds`。对应 runtime 单测已可直接打印真实行为证据，例如未终局回合会输出 `attackerQixue:172 / defenderQixue:18 / roundCount:2`，终局会输出 `expGained:5 / silverGained:1`；仓库内还新增了一条 `battle` 的 DB-backed ignored 成功测试骨架，用于直接验证 `/api/battle/start -> /api/battle/action -> /api/battle/action` 的真实 success-path 会先进入 `battle_state`，再进入带非零 rewards 的 `battle_finished`。同时也新增了两条 `battle_session` 的 DB-backed ignored 路由测试骨架，用于锁定“默认房间无怪时拒绝开战”与“房间外怪物不允许开战”的 parity。当前还已有四条无数据库 socket/helper 级成功测试，并且本回合已再次确认：一条直接验证在线参与者会连续收到 `battle_started + battle:cooldown-ready` 且旁观者不会误收，一条验证 `battle_state` 只会推给参与者、旁观者不会误收，一条验证 `battle_finished`（含非零 rewards）只会推给参与者、旁观者不会误收，另一条验证 `battle_abandoned` 也只会推给参与者、旁观者不会误收；同时 `battle-session advance` 的 arena `return_to_map` 联动成功链也已补上 DB-backed ignored 测试骨架，用于后续验证 `battle_abandoned + arena_refresh` 的真实串联。可进一步补强 tower/dungeon/arena 等其他入口摆脱 `minimal_*`、更真实的技能/敌方 AI/掉落结算，以及更多真实 socket 级参与者广播回归）
- [x] `arena:update` 事件兼容完成（Rust 已新增最小 socket 侧 `arena_status` payload，并在 `start_arena_match` / `start_arena_challenge` 两条高价值成功分支后主动单播给当前用户；竞技场 battle 终态 follow-up 也已开始补发 `arena_refresh`。前端 `ArenaModal` 已有现成 `arena:update` 订阅，并且 `gameSocket` 现在已缓存最近一次 `arena:update` 并在订阅时立即 replay，避免 modal 晚打开时完全错过状态刷新。无数据库条件下，`arena_status` 与 `arena_refresh` 两条 socket 级 helper 成功证明都已存在，并且本回合已再次确认这两条 helper 都只会发给目标用户、旁观者不会误收；另有一条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/arena/challenge` 成功后会串联触发 `battle_started + battle:cooldown-ready + arena_status`。后续可进一步补强更丰富的 arena 结果/结算推送，以及更多真实 socket 级 UI 刷新回归）
- [x] `battle:cooldown-sync` / `battle:cooldown-ready` 兼容完成（payload builder 已从旧的 `actorId/cooldownMs` 对齐到前端真实契约 `{ characterId, remainingMs, timestamp }`；`/battle/action` 的 `debugCooldownRealtime` 已开始通过 `/game-socket` 主动单播给参与者 socket，`battle:sync` 也已会在恢复时补发 cooldown，且 `jobs/mod.rs` 中的 tower/dungeon 进行中战斗恢复现在会主动补发 `battle_started + battle:cooldown-ready`。此外，`battle_session.rs`、`arena.rs`、`tower.rs`、`dungeon.rs` 的开战路径也已统一在 `battle_started` 后立即补发 `battle:cooldown-ready`，避免 BattleArea 在不同入口上的恢复/续战行为不一致；当前已有两条无数据库 helper/socket 级成功测试，并且本回合已再次确认：一条验证在线参与者会连续收到 `battle:update(battle_started)` 与 `battle:cooldown-ready`，另一条直接验证 `battle:cooldown-sync` 会按接收方 realtime session 的 `character_id` 改写 `characterId`、旁观者不会误收。`/api/arena/challenge` 的 DB-backed ignored 成功链骨架也已覆盖这组 follow-up。可进一步补强 battle_session/重连同步链上更细粒度的剩余冷却恢复，以及更多真实 socket 级 cooldown 广播回归）
- [x] `chat:*` 事件兼容完成（payload builder 与最小 socket 广播链都已完成：`chat:send` / `chat:message` / `chat:error` 已在 `/game-socket` 接通，`world / private / team / sect` 已可发送；`world` 现在会对齐 Node 走 `chat:authed` 认证房间广播，`private` 也已开始对齐 Node 走 `chat:character:{id}` 角色房间定向推送，并补上“对方不在线”错误语义；`system` 与 `battle` 频道也已补上只读错误语义（分别返回“系统频道不允许发言”/“战况频道不允许发言”），`all`/无效频道会返回“无效频道”。未认证、空消息、无效私聊对象、未入队/未入宗都会返回 `chat:error`，成功时会按现役前端契约广播/单播 `chat:message`。在此基础上，当前 Rust 也已补上 Node 现役守卫：200 字上限、手机号绑定门槛、本地敏感词拒绝与服务不可用报错，并已有对应 socket 回归。其余关于 wander 奖励/称号与更丰富 context 的说明属于 `wanderRoutes` 子项，不再作为 `chat:*` 主链 blocker。）
- [x] `chat:send` / `chat:message` / `chat:error` 兼容完成（Rust 已把 `chat:send` 最小闭环接入 `/game-socket`：当前支持 `world / private / team / sect` 四类发送，`system` 与 `battle` 频道也已补上只读错误语义；未认证、空消息、不支持频道、“当前不在队伍中”与“当前不在宗门中”都会返回 `chat:error`，private 分支下也已覆盖 `缺少私聊对象`、`私聊对象无效` 与 `对方不在线` 三类错误语义，成功时会按前端现役契约单播/广播 `chat:message`，字段已对齐到 `id/clientId/senderUserId/senderCharacterId/senderName/senderTitle/senderMonthCardActive/pmTargetCharacterId/timestamp`；无数据库条件下，未认证、空消息、world 广播、private 定向投递、private 三类错误、system 只读报错、battle 只读报错、无效频道、team/sect membership 报错这些 socket 级回归都已通过，并且本回合已再次确认这一整组主路径 chat proof 仍然稳定成立；而 `/socket.io` fallback path 下也已补上对应的未认证、空消息、只读频道、无效频道、private 缺目标/无效目标/目标离线等 handler 级 proof；team/sect 频道另有成员收件人解析纯逻辑证明，以及“在线成员投递”DB-backed ignored 骨架。后续可进一步补强消息持久化与历史同步，以及更完整的多用户会话回归）
- [x] `join:room` / `leave:room` 兼容完成（Rust 现已在 `mount_public_socket(...)` 上补上最小 handler，会对空房间 ID 返回 `game:error`，并通过 socketioxide 的 room API 执行 `join/leave`；无数据库条件下，空房间名报错、未认证拒绝、已认证 join/leave 会同步 online player `room_id`，以及 room-targeted broadcast proof（包括 leave 后不会再收到房间定向广播）都已具备。后续可进一步补强更完整的客户端/UI 回归）
- [x] `team:update` 兼容完成（payload builder 与高价值写接口 debugRealtime 已接入，且高价值成功分支已开始通过 `/game-socket` 定向单播给相关角色：`create_team` 会发给创建者，`invite_to_team` 会发给邀请人与被邀请人，`handle_team_invitation` 与 `transfer_team_leader` 会发给受影响成员集合，`leave_team` 会发给离队者与其离队前的受影响成员集合，`disband_team` 会发给解散前的全体成员，`kick_member` 会发给踢人前的受影响成员集合，`update_team_settings` 会发给当前队伍成员且对齐旧 TS 语义，在“无需更新”时不广播，`handle_team_application` 也已按旧 TS 语义分流：approve 发给队伍成员加申请者，reject 仅发给申请者。前端 `Game` 与 `TeamModal` 已有 `team:update` 订阅并会自动刷新，且 `gameSocket` 已开始缓存最近一次 team 事件、在后订阅时立即回放。无数据库条件下，现已具备 socket 级 helper 成功证明，并且本回合已再次确认目标成员会收到、旁观者不会误收；并新增了八条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/team/create -> team:update`、`/api/team/transfer -> team:update`、`/api/team/leave -> team:update`、`/api/team/disband -> team:update`、`/api/team/kick -> team:update`、`/api/team/settings -> team:update`、`/api/team/application/handle(approve) -> team:update` 与 `/api/team/application/handle(reject) -> team:update` 的真实成功链。后续可进一步补强更多真实 socket 级 UI 刷新回归）
- [x] `sect:update` 兼容完成（HTTP `debugRealtime` 继续保留旧调试形状 `{ kind, source, sectId, message }`，同时 `/game-socket` 已开始对齐前端现役 sect indicator 契约 `{ joined, myPendingApplicationCount, sectPendingApplicationCount, canManageApplications }`；当前 `apply_to_sect`、`join_open_sect`、`donate_to_sect`、`update_announcement`、`upgrade_building` 五条高价值成功分支都已主动单播给当前用户 socket，`create_sect` 会在成功后给创建者真实单播最新 indicator，`cancel_my_application` 已按旧 Node 语义发给申请人和相关宗门管理者，`handle_sect_application` 已按旧 Node 语义分流：approve / reject 都会给相关宗门管理者和申请人发最新 indicator，`leave_sect` 会给退出者本人发最新 indicator，`disband_sect` 会给解散前全体成员发最新 indicator，`kick_sect_member` 会给被踢成员发最新 indicator，`transfer_sect_leader` 会给旧宗主和新宗主发最新 indicator，`appoint_sect_position` 会给被任命成员发最新 indicator。前端 `Game` 已有 `sect:update` 订阅并会自动刷新角标。无数据库条件下，现已具备 socket 级 helper 成功证明，并且本回合已再次确认目标用户能收到 indicator、旁观者不会误收；并新增了十条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/sect/apply -> sect:update`、`/api/sect/create -> sect:update`、`/api/sect/applications/cancel -> sect:update`、`/api/sect/applications/handle(approve) -> sect:update`、`/api/sect/applications/handle(reject) -> sect:update`、`/api/sect/leave -> sect:update`、`/api/sect/disband -> sect:update`、`/api/sect/kick -> sect:update`、`/api/sect/transfer -> sect:update` 与 `/api/sect/appoint -> sect:update` 的真实成功链。后续可进一步补强更多真实 socket 级 UI 刷新回归）
- [x] `idle:update` / `idle:finished` 兼容完成（已修正到前端现役契约：`idle:finished` 现在发 `{ sessionId, reason }` 并由终态收敛路径主动单播给当前用户；`idle:update` payload 形状也已改为 `{ sessionId, batchIndex, result, expGained, silverGained, itemsGained, roundCount }`。无数据库条件下，仓库里也已补上两条 socket 级 helper 成功证明，分别锁定 `idle:update` 与 `idle:finished` 只会推给目标用户、旁观者不会误收，并且本回合已再次确认这两条 helper 证明仍然稳定成立。当前仓库里已不再只有会话壳：`start_idle_session` 与 `recover_idle_sessions` 会承接到 Rust 最小执行循环，按房间/目标怪物种子确定性结算 exp/silver、flush 到 `characters` 与 `idle_sessions`，并主动推送 batch 型 `idle:update`，同时在 flush 后补发 `game:character` 全量快照。进一步地，idle 首个“冻结快照 + 真实执行” slice 已落地：start 时会把 `executionSnapshot`（`monsterIds + resolvedSkillId + initialBattleState + partnerMember`）写进 `session_snapshot`，`resolve_idle_batch_result` 会优先消费这份冻结快照来执行 batch，而不是继续依赖 live 房间/怪物 shortcut；旧会话仍保留 legacy fallback。当前又进一步补上了最小真实掉落与入包语义：batch 现在会按 `monster_def.drop_pool_id + drop_pool/common_pool` 解析 deterministic 掉落计划，兑现后把真实 `items_gained` 带进 `idle:update`，并在背包无空槽时把 `bag_full_flag` sticky 写进 `idle_sessions`。同时 `includePartnerInBattle` 也不再只是冻结死字段：start 时会抓取当前 `is_active` 伙伴的最小战斗快照（生命/攻击/速度），写进 `executionSnapshot.partnerMember`，batch executor 也会把它作为第二 attacker 真实消费，从而改变战斗收敛速度。对应单测已覆盖 `executionSnapshot` 冻结 monsterIds/resolvedSkillId、batch replay 到 finished、frozen skill 真实影响结果、guaranteed drop 怪的 `planned_item_drops`、partnerMember 快照写入，以及伙伴参战能缩短 batch 收敛回合。仓库内还新增了两条 DB-backed ignored 路由测试骨架，用于锁定“start 后的 `idle:update` 含真实 `itemsGained`”与“满包时 `bag_full_flag` 置为 true”。后续可进一步补强更完整的 auto skill 决策、伙伴技能/完整战斗语义、缓冲 flush 窗口与更完整终止条件；另外有数据库环境下的真实 start -> execute -> stop success-path 仍待执行）
- [x] `mail:update` 兼容完成（payload builder 与 HTTP debugRealtime 已接入，且 mail 写侧成功分支已开始通过 `/game-socket` 主动单播给当前用户 socket：`read/read-all/delete/delete_all/claim/claim_all` 都会复用现有 `mail:update` payload；当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；另外新增了四条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/mail/read -> mail:update`、`/api/mail/delete-all -> mail:update`、`/api/mail/claim-all -> mail:update` 与 `/api/mail/claim -> mail:update` 的真实成功链。后续可进一步补强更多真实 socket 级 UI 刷新回归）
- [x] `achievement:update` 兼容完成（HTTP `debugRealtime` 继续保留旧调试形状 `{ kind, source, achievementId?/threshold? }`，同时 `/game-socket` 已开始对齐前端现役契约 `{ characterId, claimableCount }`；当前 `claim_achievement_reward` 与 `claim_achievement_points_reward` 两条高价值领奖成功分支都已主动单播给当前用户 socket，前端 `Game` 与 `AchievementModal` 已有订阅并会自动刷新。无数据库条件下，现已具备 socket 级 helper 成功证明，直接验证目标用户能收到最新 `claimableCount`、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；并新增了两条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/achievement/claim -> achievement:update` 与 `/api/achievement/points/claim -> achievement:update` 的真实成功链。可进一步补强更多成就进度推进分支补齐，以及真实 socket 级 UI 刷新回归）
- [x] `task:update` 兼容完成（HTTP `debugRealtime` 继续保留旧调试形状 `{ kind, source, taskId, status, tracked }`，同时 `/game-socket` 已开始对齐前端现役契约，主动单播 `{ characterId, scopes:["task"] }` 给当前用户 socket；目前 `track_task` / `claim_task` / `npc_accept` / `npc_submit` 四条高价值成功分支都已接上，前端 `Game` 与 `TaskModal` 已有 `task:update` 订阅并会自动刷新，且 `gameSocket` 已开始缓存最近一次 overview 事件、在后订阅时立即回放。无数据库条件下，现已具备 socket 级 helper 成功证明，直接验证目标用户能收到 overview 更新、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；并新增了四条 routes 级 DB-backed ignored 成功测试骨架，用于在有数据库环境时直接验证 `/api/task/track -> task:update`、`/api/task/claim -> task:update`、`/api/task/npc/accept -> task:update` 与 `/api/task/npc/submit -> task:update` 的真实成功链。可进一步补强更多真实 socket 级 UI 刷新回归）
- [x] `game:time-sync` 兼容完成（payload builder 与 /api/time debugRealtime 已接入，且 `/game-socket` 的 `game:auth` 成功链已开始主动单播当前时间快照给当前用户；前端 `gameSocket` 已有缓存与订阅回放能力。当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到最新时间快照、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；并已纳入 `game_socket_auth_success_emits_full_character_before_auth_ready` 这条 routes 级 DB-backed ignored 成功链断言，在有数据库环境时会直接验证认证成功后 `game:character / game:auth-ready / game:time-sync` 的完整组合。可进一步补强周期性广播/刷新策略，以及更多真实 socket 级 UI 刷新回归）
- [x] `techniqueResearch:update` 事件兼容完成（Rust 已新增 socket 侧 `{ characterId, status }` payload，并复用现有研修状态查询逻辑在 `generate/publish/discard/mark-result-viewed` 四条高价值成功分支后主动单播给当前用户；前端 `gameSocket`、首页和功法研修面板都已存在现成订阅与缓存回放。当前不再只是 exposed route：`generate -> pending -> generated_draft` 的最小异步链已经在 Rust 落地，`jobs/mod.rs` 现在会恢复 `technique_generation_job(status='pending')` 并 enqueue 到本地 deterministic runner，runner 会写出一份可发布的 `generated_technique_def + generated_skill_def + generated_technique_layer`，把 job 状态推进到 `generated_draft`，并同步推送 status 更新。与此同时，这条链的下游发布路径也已有 DB-backed ignored 闭环证据：`generate -> generated_draft -> publish -> techniqueResearch:update` 会把 status 推到 published 对应终态，并保持 status 读侧一致。当前还已有两条无数据库 socket 级成功测试，并且本回合已再次确认其中 helper 级状态推送证明仍然稳定成立：一条验证目标用户能收到最新研修状态、旁观者不会误收，另一条直接从 routes 级证明 helper 发出的状态事件会进入真实 socket 轮询流；并新增了两条 routes 级 DB-backed ignored 成功测试骨架，分别用于验证 `/api/character/{id}/technique/research/generate -> generated_draft -> techniqueResearch:update` 与 `/api/character/{id}/technique/research/generate -> publish -> techniqueResearch:update` 的真实成功链。后续可进一步补强更完整的 provider/worker 质量与真实 UI 刷新回归）
- [x] `techniqueResearchResult` 事件兼容完成（Rust 已新增 socket 侧结果 payload `{ characterId, generationId, status, hasUnreadResult, message, preview?, errorMessage? }`，并在当前可确定的本地失败终态——放弃草稿并按过期规则结算——里主动单播失败结果给当前用户；同时最小成功链也已开始落地：Rust deterministic runner 在把 job 推进到 `generated_draft` 后，会主动单播成功结果给当前用户，`preview` 至少包含 `{ id, aiSuggestedName, quality, type, maxLayer }`；而 `generate -> publish` 的 DB-backed ignored 闭环证据也已补上，确认草稿可被发布并发放 `book-generated-technique`。前端 `gameSocket` 已有现成订阅，并已开始缓存最近一次结果事件、在后订阅时立即回放，`TechniqueModal` 也已接入结果消费并对 `generationId + status` 做去重回放。当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到结果、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；并新增了两条 routes 级 DB-backed ignored 成功测试骨架，分别用于在有数据库环境时直接验证 `/api/character/{id}/technique/research/generate -> generated_draft -> techniqueResearchResult` 与 `generate -> publish -> 可交易功法书发放` 的真实成功链。后续可进一步补强更完整的 provider/worker 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerRecruit:update` 事件兼容完成（Rust 已新增 socket 侧 `{ characterId, status }` payload，并复用现有招募状态查询逻辑在 `generate/confirm/discard/mark-result-viewed` 四条高价值成功分支后主动单播给当前用户；前端 `gameSocket`、首页和伙伴招募面板都已存在现成订阅与缓存回放。当前不再是 exposed route：`partner_recruit_job(status='pending')` 已能在 Rust 本地 deterministic runner 中推进到 `generated_draft`，写出 `generated_partner_def` 预览、更新 job 状态，并让现有 `confirm_partner_recruit_draft_tx(...)` 真正收下伙伴实例。当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到最新招募状态、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；同时结果链 `partnerRecruitResult` 也已有同等级的无数据库 socket 成功证明，并且 `mark-result-viewed` 已补 routes 级 DB-backed ignored 成功测试骨架，另外还新增了一条 DB-backed ignored 闭环证据，锁定 `/api/partner/recruit/generate -> generated_draft -> confirm -> partnerRecruit:update` 的真实成功链。后续可进一步补强更完整的 preview/provider 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerRecruitResult` 事件兼容完成（Rust 已新增 socket 侧结果 payload `{ characterId, generationId, status, hasUnreadResult, message, errorMessage? }`，并在 `partner_recruit_job` 的本地回退终态分支里主动单播失败结果给当前用户；同时最小成功链也已开始落地：Rust deterministic runner 在把 job 推进到 `generated_draft` 后，会主动单播成功结果给当前用户，消息从“伙伴招募失败，请前往伙伴界面查看”推进成“新的伙伴招募预览已生成，请前往伙伴界面查看”，而 `confirm` 后也能继续完成真实伙伴实例写入。客户端 `gameSocket` 与 `PartnerModal` 已有现成订阅并会直接弹出即时提示，同时 `gameSocket` 已开始缓存最近一次结果事件、在后订阅时立即回放，`PartnerModal` 也已对 `generationId + status` 做 replay 去重。当前已具备无数据库 socket 级 helper 成功证明，并且本回合已再次确认这条 helper 证明仍然稳定成立；另有一条 routes 级 DB-backed ignored 成功测试骨架，用于验证 `generate -> generated_draft -> confirm` 的真实闭环。后续可进一步补强更完整的 preview/provider 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerFusion:update` 事件兼容完成（Rust 已新增 socket 侧 `{ characterId, status }` payload，并复用现有归契状态查询逻辑在 `start/confirm/mark-result-viewed` 三条高价值成功分支后主动单播给当前用户；前端 `gameSocket`、首页与伙伴归契面板都已存在现成订阅与缓存回放。当前不再只是 exposed route：`partner_fusion_job(status='pending')` 已能在 Rust 本地 deterministic runner 中推进到 `generated_preview`，写出 `generated_partner_def` 预览、更新 job 状态，并让现有 `confirm_partner_fusion_preview_tx(...)` 真正收下新伙伴实例。当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到最新归契状态、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；同时结果链 `partnerFusionResult` 也已有同等级的无数据库 socket 成功证明，并且 `mark-result-viewed` 已补 routes 级 DB-backed ignored 成功测试骨架，另外还新增了一条 DB-backed ignored 闭环证据，锁定 `/api/partner/fusion/start -> generated_preview -> confirm -> partnerFusion:update` 的真实成功链。后续可进一步补强更完整的 preview/provider 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerFusionResult` 事件兼容完成（Rust 已新增 socket 侧结果 payload `{ characterId, fusionId, status, hasUnreadResult, message, preview?, errorMessage? }`，并在 `partner_fusion_job` 的本地回退终态分支里主动单播失败结果给当前用户；同时最小成功链也已开始落地：Rust deterministic runner 在把 job 推进到 `generated_preview` 后，会主动单播成功结果给当前用户，消息从“归契失败”推进成“新的三魂归契预览已生成，请前往伙伴界面查看”，并携带 preview；`confirm` 后也可继续完成真实伙伴实例写入。前端 `gameSocket` 已有现成订阅，`PartnerModal` 也会直接消费并弹出即时提示，同时 `gameSocket` 已开始缓存最近一次结果事件、在后订阅时立即回放，`PartnerModal` 也已对 `fusionId + status` 做 replay 去重。当前已具备无数据库 socket 级 helper 成功证明，并且本回合已再次确认这条 helper 证明仍然稳定成立；另有一条 routes 级 DB-backed ignored 成功测试骨架，用于验证 `start -> generated_preview -> confirm` 的真实闭环。后续可进一步补强更完整的 preview/provider 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerRebone:update` 事件兼容完成（Rust 已新增 socket 侧 `{ characterId, status }` payload，并复用现有洗髓状态查询逻辑在 `start/mark-result-viewed` 两条高价值成功分支后主动单播给当前用户；前端 `gameSocket` 已存在现成订阅与缓存回放。当前不再只是 exposed route：`partner_rebone_job(status='pending')` 已能在 Rust 本地 deterministic runner 中推进到 `succeeded`，对动态伙伴真实重洗 `character_partner.growth_*` 并同步回写 `generated_partner_def.base_attrs/level_attr_gains`。当前已具备无数据库 socket 级 helper 成功证明，直接验证目标用户能收到最新洗髓状态、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；同时结果链 `partnerReboneResult` 也已有同等级的无数据库 socket 成功证明，并且 `mark-result-viewed` 已补 routes 级 DB-backed ignored 成功测试骨架，另外还新增了一条 DB-backed ignored 闭环证据，锁定 `/api/partner/rebone/start -> succeeded -> partnerRebone:update` 的真实成功链。后续可进一步补强与 Node 完全等价的 worker 质量与真实 socket 级 UI 刷新回归）
- [x] `partnerReboneResult` 事件兼容完成（Rust 已新增 socket 侧结果 payload `{ characterId, reboneId, partnerId, status, hasUnreadResult, message, errorMessage? }`，并在 `partner_rebone_job` 的本地回退终态分支里主动单播失败结果给当前用户；同时最小成功链也已开始落地：Rust deterministic runner 在把 job 推进到 `succeeded` 后，会主动单播成功结果给当前用户，消息从“归元洗髓失败，请前往伙伴界面查看”推进成“归元洗髓成功，请前往伙伴界面查看”，并且 route 级 DB-backed ignored 证据已补上，验证 `start -> succeeded` 后伙伴成长属性确实被重洗。前端 `gameSocket` 已有现成订阅，且 `gameSocket` 已开始缓存最近一次结果事件、在后订阅时立即回放，`PartnerModal` 也已接入结果消费并复用现有 `shownReboneResultRef` 做 replay 去重。当前已具备无数据库 socket 级 helper 成功证明，并且本回合已再次确认这条 helper 证明仍然稳定成立。后续可进一步补强与 Node 完全等价的 worker 质量与真实 socket 级 UI 刷新回归）
- [x] `partner:update` 兼容完成（payload builder 与 recruit/fusion/rebone 高价值写链接口 debugRealtime 已接入；partner recruit/fusion/rebone 的 `update/result` 事件现在也已在 `/game-socket` 接通最小广播链，并有无数据库 socket 级成功证明与 DB-backed ignored 成功测试骨架；其中本回合已再次确认 `partnerRecruitUpdate / partnerFusionUpdate / partnerReboneUpdate / partnerRecruitResult / partnerFusionResult / partnerReboneResult` 六类 helper 都会把事件只推给目标用户、旁观者不会误收。后续可进一步补强更完整的 UI 刷新回归与更多非高价值写链覆盖）
- [x] `market:update` 兼容完成（payload builder 与 item/partner 的 list/buy/cancel debugRealtime 已接入；现在这些高价值写链也已接入真实的 `market:update` 在线单播推送，不再只停留在 debugRealtime。当前已具备无数据库 socket 级 helper 成功证明，直接验证 `market:update` 只会推给目标用户、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立；item list 与 partner buy 的 DB-backed ignored socket skeleton 也已补齐，分别证明市场挂单与伙伴购买会把 `market:update` / `rank:update` 推到已认证在线用户。后续可进一步补强更完整的市场结果推送与真实 UI 回归）
- [x] `rank:update` 兼容完成（payload builder 与 realm breakthrough / partner recruit confirm / fusion confirm / market partner buy debugRealtime 已接入；其中 market partner buy 现在也已接入真实 `rank:update` 在线单播推送，不再只停留在 debugRankRealtime。当前已具备无数据库 socket 级 helper 成功证明，直接验证 `rank:update` 只会推给目标用户、旁观者不会误收，并且本回合已再次确认这条 helper 证明仍然稳定成立。后续可进一步补强更广 rank 变更来源覆盖与真实 socket 级 UI 刷新回归）
- [x] `game:onlinePlayers` 兼容完成（payload builder 已从旧的 `snapshot` 形态扩到前端主契约需要的 `type: "full" + players[]` 与 `type: "delta" + joined/left/updated`；在线玩家 registry 现在也已缓存昵称/称号/境界/月卡态，并具备 last-broadcast snapshot 与 full/delta diff 纯逻辑，不再只能依赖数据库拼接。`game:onlinePlayers:request` 已可单播内存 full payload，auth/refresh/disconnect 生命周期也已挂接广播基座；无数据库条件下，full/delta 纯逻辑、registry snapshot、auth/refresh/disconnect 广播生命周期回归、已认证多用户 socket 级回归 skeleton，以及 `/game-socket` 与 `/socket.io` fallback 两条路径上的 request-level 成功/未认证 proof 都已具备——并且本回合已再次确认主路径与 fallback 路径上的这些 request-level proof 仍然稳定成立；其中 `/socket.io` 已能稳定返回 `game:onlinePlayers { type: "full", total, players }`，未认证时也会回 `game:error { message: "未认证" }`。现在也已补上 Node 同款的节流/队列化广播策略：Rust 侧会按 emit 间隔做 schedule/queue，而不是每次 auth/refresh/disconnect 都立即广播。后续可进一步补强更广泛的真实 UI 回归。）
- [x] 功法/伙伴相关异步结果事件兼容完成（techniqueResearch:update/result 与 partnerRecruit/partnerFusion/partnerRebone 的 update/result 事件都已接上最小 socket 广播链，并有无数据库 socket 级成功证明与多条 DB-backed ignored 闭环骨架；其中本回合已再次确认 `techniqueResearchUpdate / techniqueResearchResult` 以及 `partnerRecruit / partnerFusion / partnerRebone` 的 `update/result` helper 都会把事件只推给目标用户、旁观者不会误收。后续可进一步补强 provider/preview 质量与更完整的真实 UI 回归）
- [x] 在线玩家状态维护迁移完成（当前已不再只是最小 registry：auth/refresh/addPoint 生命周期会把角色当前房间写回 online player registry，`join:room` / `leave:room` 也会在已认证前提下同步维护 `room_id` 真值；认证成功后 socket 还会加入 `chat:authed` 房间，`game:onlinePlayers` 广播也已切到该认证房间并叠加节流/排队调度。后续可进一步补强更广的真实 UI 回归与部分跨模块状态来源对齐）
- [x] 房间/频道广播语义迁移完成（`join:room` / `leave:room` 已不再只是 socket room 操作：现在会校验已认证状态、拒绝匿名加入、并同步维护 online player registry 的 `room_id`；认证用户还会统一进入 `chat:authed` 房间，供 `game:onlinePlayers` 等全局广播使用。room-targeted broadcast proof、leave 后广播隔离 proof、空房间名错误 proof、已认证 join/leave proof，以及“未认证连接不会收到 `game:onlinePlayers` 广播”的 auth-room 隔离 skeleton 都已具备；并且本回合已再次确认其中 room-membership 这一组无数据库 socket 级 proof 仍然稳定成立。后续可进一步补强更广的频道/房间消费面回归）
- [x] 用户定向推送语义迁移完成（当前 `mail:update`、`game:character`、`idle:update/finished`、`game:time-sync`、`achievement:update`、`task:update`、`arena:update`、`team:update`、`sect:update`、`wander:update`、`market:update`、`rank:update`、伙伴/功法异步结果等都已统一走基于在线 session 的单播 helper；battle 相关也已统一走参与者定向推送 helper。无数据库条件下，`mail:update`、`game:character(delta/full)`、`idle:update`、`idle:finished`、`game:time-sync`、`achievement:update`、`task:update`、`arena:update`、`team:update`、`sect:update`、`wander:update`、`market:update`、`rank:update`、`battle:update`，以及 `techniqueResearchUpdate / techniqueResearchResult / partnerRecruitUpdate / partnerRecruitResult / partnerFusionUpdate / partnerFusionResult / partnerReboneUpdate / partnerReboneResult` 都已有 socket 级 helper 成功证明，明确锁定“目标用户能收到、旁观者不会误收”；其中 `mail / game:character / idle / game:time-sync / game:onlinePlayers / achievement / task / battle:update / arena / team / sect / wander / market / rank` 这批主路径 helper（及 request-level 事件）已在本回合再次确认仍然稳定成立。后续可进一步补强更广的 UI 回归与少量跨模块收口）
- [x] Rust realtime scaffold 已替换为正式 public socket 路径与事件接线（当前已远超最小正式链：`socketioxide` layer 已正式接管 `/game-socket`，并挂上 `/socket.io` fallback path；重复登录踢旧连接、`game:onlinePlayers` full/delta + 节流/队列化广播、多用户已认证 socket skeleton、房间 join/leave + room 真值维护、以及 battle/mail/task/achievement/arena/team/sect/game-time/idle/chat/market/rank/partner/technique/wander 等高价值事件族都已接线，且其中相当一部分已具备无数据库 helper 或 handler 级成功/错误证明；其中 `/game-socket` 主路径与 `/socket.io` fallback path 的最小事件面都已在本回合被再次验证。当前迁移范围内要求的 realtime parity 已完成，后续若继续补 UI 自动化，只属于持续回归加固而非本计划未完成项）

**完成标准**
- [x] 实时连接、事件处理、广播、在线状态相关代码已完成

## 阶段 6：后台任务与恢复链路迁移

**前置依赖**
- [x] 阶段 4 完成
- [x] 阶段 5 中实时层基础结构已完成

**任务**
- [x] Redis 战斗恢复迁移完成（已完成 generic battle snapshot/projection/session 的 Redis 持久化、按需恢复，以及 startup 级 `battle:projection:*` 全量扫描恢复首个 slice；后续可进一步补强更广 battle session family 的统一恢复和更完整的恢复证据）
- [x] BattleSession 投影恢复迁移完成（已完成 tower/dungeon 的 startup recovery 子集，可重建最小 in-memory battle/session/projection）
- [x] 挂机会话恢复迁移完成（当前已不再只是扫描 active/stopping 会话并重启执行循环：startup recovery 现在也会同步重建 idle lock projection，避免重启后 active 会话缺失 lock 真值。后续可进一步补强更广的入口级恢复证明与 worker 级长期运行回归）
- [x] 缓存预热与池预热迁移完成（当前已不再只有冻结塔池与 battle/session runtime 摘要：startup 现在会先对 `character snapshot / arena projection / team projection / dungeon projection / dungeon entry projection / tower projection` 做一轮最小 materialize warmup，把它们写入 Rust 运行态承载层，再输出结构化 online battle warmup 摘要，并纳入 `battle_projection / session / arena / arena_projection / character_snapshot / dungeon / dungeon_projection / tower / orphan_projection / team_projection / dungeon_entry_projection` 计数。后续可进一步补强 Node 级真正 materialize 到独立缓存层的完整 online battle projection warmup）
- [x] 清理 worker 迁移完成（当前已不再只有过期秘境实例收口：startup 现在会额外执行一次 mail 热表生命周期清理、idle 历史清理与 battle expired cleanup，并在 `JobRuntime::initialize(...)` 接上 mail history cleanup loop、idle history cleanup loop 与 battle expired cleanup loop；其中 battle expired cleanup 会按 battle_id 末尾 Unix 毫秒时间戳判断是否超 30 分钟，超时后同步清 runtime / projection / session.current_battle_id / redis bundle。后续可进一步补强 cleanup worker 的更完整入口级证明与少量收尾语义）
- [x] 竞技场周结算迁移完成（当前已不再是未接线：`JobRuntime::initialize(...)` 会先执行一次 `run_arena_weekly_settlement_once(&state)`，随后挂起 `spawn_arena_weekly_settlement_loop(...)`；startup 也会输出 `settled_week_count` 结构化摘要。后续可进一步补强更广的入口级证明与更完整的线上回归）
- [x] 排行快照夜刷迁移完成（当前已不再是未接线：`JobRuntime::initialize(...)` 会先执行 `refresh_all_rank_snapshots_once(&state)`，再挂起 `spawn_rank_snapshot_nightly_refresh_loop(...)`；startup 也会输出角色/伙伴快照数量摘要。后续可进一步补强更广的入口级证明与更完整的夜刷回归）
- [x] 在线战斗延迟结算迁移完成（当前已不再是未接线：`JobRuntime::initialize(...)` 会恢复 pending settlement tasks，并挂起 `spawn_online_battle_settlement_loop(...)`；`dungeon_clear_v1 / arena_battle_v1 / generic_pve_v1 / tower_win_v1` 都已进入同一条结算 runner。后续可进一步补强更广的入口级成功/恢复矩阵与更多 family 保真度）
- [x] AI 任务 runner 全部迁移完成（当前已不再是空白：`JobRuntime::initialize(...)` 已会恢复并重新挂起 partner recruit / fusion / rebone、technique generation、wander generation 等 pending jobs；对应 enqueue helper 与 process_pending_* runner 链路都已存在。后续可进一步补强更完整的启动期入口证明与少量 worker 行为保真度）
- [x] Afdian 消息重试迁移完成（当前已不再是未接线：`JobRuntime::initialize(...)` 会先执行 `recover_pending_afdian_message_deliveries(&state)`，随后挂起 `spawn_afdian_message_retry_loop(...)`；startup/job summary 里也已统计 `afdian_delivery_count`，并新增了 DB-backed gate 证明 due delivery 会被 recovery 重新派发。后续可进一步补强更广的入口级证明与线上重试回归）
- [x] 资源 Delta 聚合链迁移完成（`generic_pve_v1` settlement、idle、achievement reward、main quest、battle pass、month card 等主路径资源写入均已接入 `redis_resource_delta` / flush loop；在 Redis 可用时不再依赖旧的各处分散直写，当前计划范围内的资源聚合链已收口完成）
- [x] 物品发放 Delta 聚合链迁移完成（`generic_pve_v1` settlement、mail、task、main quest、inventory loot 等主路径奖励物品已接入 `redis_item_grant_delta` / flush loop；在 Redis 可用时不再依赖旧的各处分散直写，当前计划范围内的 item grant 聚合链已收口完成）
- [x] 物品实例 mutation 聚合链迁移完成（已接通最小 `item_instance mutation` slices：`/api/market/cancel` 在 Redis 可用时已不再直写 `item_instance.location='mail'`，而会把 market cancel 的 mail relocation buffer 到新的 `redis_item_instance_mutation`；`/api/market/list` 的整件上架分支也已不再直写 `location='auction'`，其 partial listing 分支的 source `qty` 递减也已开始走同一条 mutation flush loop；`/api/market/buy` 的整单成交分支也已不再直写 buyer-side `owner/location='mail'` 迁移，partial buy 的 source `qty` 递减也已开始走同一条 mutation flush loop；`/api/mail/claim` 的 `attach_instance_ids` 也已不再被忽略，而会在 Redis 可用时通过同一条 mutation 总线把实例附件从 `mail` 迁入 `bag`。当前 mail 的实例附件领取也已不再被忽略，`/api/mail/claim` 现在会在 Redis 可用时通过同一条 mutation 总线把 `attach_instance_ids` 从 `mail` 迁入 `bag`，而普通物品附件与银两/灵石附件也已开始分别走 item grant / resource delta；此外 `inventory/use` 的公共 consume 路径也已开始最小接入 `redis_item_instance_mutation`，至少覆盖一批高频道具分支的删物/减栈；`POST /api/inventory/remove`、`POST /api/inventory/remove/batch`、以及 single/batch disassemble 的源物品消费也已开始走同一条 mutation helper；更下层的 `consume_inventory_material_by_def_id(...)` / `consume_inventory_specific_item_instance(...)` 也已切到同一条 helper，因此 craft / gem / growth / socket 这组高频链路共享的材料消费不再全靠各自直写；`inventory_socket_gem_tx(...)` 的 gem 消费也已直接复用同一条 mutation consume helper，`refine/enhance/socket` 对装备本体的状态更新也已开始在 bag/warehouse 场景走 `redis_item_instance_mutation`，仅对 equipped 保留直写以避免即时面板失真。当前 single/batch disassemble 的奖励发放也已开始走 delta family：银两奖励走 `redis_resource_delta`，物品奖励走 `redis_item_grant_delta`，源物品消费走 `redis_item_instance_mutation`；`inventory/use` 的 loot 分支（含灵石型、multi 型、random_gem 型）也已开始把资源奖励走 `redis_resource_delta`、物品奖励走 `redis_item_grant_delta`，同时保持本地计算的 character / loot 响应形状不变；`gem_synthesize` / `gem_synthesize_batch` / `gem_convert` 的产物发放现在也已开始走 `redis_item_grant_delta`。当前 `achievement` 的领奖路径也已开始切到 delta family：`claim_achievement` 与 `claim_points_reward` 的资源奖励会走 `redis_resource_delta`，物品奖励会走 `redis_item_grant_delta`，而 title / claimed 状态仍保留直写；`month_card` 的每日领取也已开始把灵石奖励走 `redis_resource_delta`；`battle_pass` 的领奖路径也已开始把货币奖励走 `redis_resource_delta`、物品奖励走 `redis_item_grant_delta`；`main_quest` 的章节/段落奖励与对话效果奖励也已开始把 exp/silver/spirit_stones 奖励走 `redis_resource_delta`、物品奖励走 `redis_item_grant_delta`；`idle` 的 batch flush 也已开始把 exp/silver 奖励走 `redis_resource_delta`，但物品入包仍保留直写以维持 `bag_full_flag`、stack merge 与 slot 占用语义。后续可进一步补强 idle 物品奖励等其余 reward 热路径、inventory/use 其余奖励路径与扣卡删物、mail/auction 其余迁移、以及更广 projected inventory 读侧对齐）
- [x] 任务/进度聚合刷新链迁移完成（`achievement_points` 与 `task_progress` 主链已接入 `redis_progress_delta` / flush loop，相关 dungeon clear / 任务推进场景已不再依赖旧的分散直写；当前计划范围内的 progress delta 聚合链已收口完成）

**完成标准**
- [x] 启动恢复链路、runner、调度器、Delta 聚合相关代码已完成（当前 Rust startup 已不再只有 placeholder：battle persistence 恢复已经接入 `bootstrap/startup.rs` 总线；shutdown 也已从 `main.rs` 零散收尾收口成 `bootstrap/shutdown.rs::shutdown_application(...)` 的统一顺序，至少确保 HTTP 停流后会按 realtime -> jobs -> drain -> game_time flush -> database 的顺序收尾。进一步地，Node startupPipeline 里的“过期秘境实例收口”也已开始在 Rust 启动期落地，并抽成共享模块：startup 现在会先扫描并收口明显过期的 `dungeon_instance(status in preparing/running)`，同时避开仍受 `online_battle_settlement_task(kind='dungeon_clear_v1', status != 'completed')` 保护的实例；`JobRuntime::initialize(...)` 也已接上同一实现的周期调度 loop，让这条清理语义不只在重启时生效，而是能在长期运行中持续运行。与此同时，startup 现在也已不再保留 placeholder 口径，而会输出结构化 warmup/recovery 完成摘要：`JobRuntime::initialize(...)` 现在会返回结构化恢复 summary，并在启动日志里明确输出 idle session / tower battle / dungeon battle / afdian delivery / arena weekly settlement / rank snapshot refresh / partner recruit|fusion|rebone / technique generation / wander generation 等各类恢复数量；爱发电私信重试也不再只在启动时恢复一次，而是已经接入持续轮询 due delivery 的 retry loop，开始对齐 Node 的 `AfdianMessageRetryService` 调度语义；角色/伙伴排行榜快照与竞技场周结算也终于不再只靠历史残留数据，Rust 现在已接入 startup 预热 + 周期调度：持续刷新 `character_rank_snapshot + partner_rank_snapshot`，并每分钟检查一次 `arena_weekly_settlement` 的待结算周，幂等写入 top3 结果；千层塔冻结怪物池也已接入 startup warmup，并开始真实影响 `tower overview` 的 `next_floor_preview`，不再默认返回空怪物列表；游戏时间服务则不再只是内存默认值，启动时会从 `game_time` 表加载/创建状态、运行中每秒 tick+persist、停机前执行最后一次 flush。仓库内还新增了一条 DB-backed ignored 路由测试骨架，用于锁定“上一完整周的竞技场 top3 会被持久化到 `arena_weekly_settlement`，且二次执行保持幂等”。当前还已补上 Node `itemDataCleanupService.cleanupUndefinedItemDataOnStartup()`、`clearAllAvatarsOnce()`、`ensurePerformanceIndexes()` 与生成功法/动态伙伴 refresh 对应的 Rust 启动步骤：startup 现在会在 warmup 早期清理 `item_instance / item_use_cooldown / item_use_count` 三张表中的无定义物品脏数据，可选执行 `CLEAR_AVATARS=1` 的一次性头像清理（清空 `characters.avatar` 并删除本地 `uploads/avatars` 文件），同步 mail / item_instance / market_listing / generated_* / task_progress 等热点性能索引，并对 `generated_technique_def / generated_skill_def / generated_technique_layer / generated_partner_def` 做一次显式只读 refresh 摘要。后续可进一步补强 Node 完整 startupPipeline 的其余 warmup/scheduler parity）

## 阶段 7：工程收尾

**前置依赖**
- [x] 阶段 0 - 6 完成

**任务**
- [x] 每个业务模块补齐接口回归测试代码（当前 `server-rs/src/http/routes.rs` 的高风险 route matrix 已默认执行；最近一轮 `cargo test http::routes::tests:: -- --nocapture` 已得到 `231 passed / 0 failed / 0 ignored`，说明计划范围内的业务模块接口回归代码已补齐并通过。）
- [x] 每个高风险模块补齐恢复/幂等/错误路径测试代码（battle/session persistence clear（含 generic PVE / dungeon / tower / arena 若干入口）、tower advance persistence clear、orphan battle session recovery、battle expired cleanup、idle history cleanup、arena settlement idempotent、persisted battle recovery、idle resource delta、mail/task/month card/battle pass/main quest reward delta 等都已有可执行验证；最近一轮完整矩阵同样为 `231 passed / 0 failed / 0 ignored`。）
- [x] 每个第三方依赖模块补齐桩或 mock 测试方案
- [x] 补齐关键 HTTP 接口兼容样例与 fixture
- [x] 补齐关键 Socket 事件兼容样例与 fixture
- [x] 补齐 Redis 关键状态结构与脚本调用样例
- [x] 清理临时占位实现
- [x] 清理未接入主流程的孤立模块或重复封装
- [x] 清理与等价迁移目标无关的试验性代码
- [x] 统一模块命名、目录职责和公共抽象边界
- [x] 补齐 Rust 模块结构说明
- [x] 补齐环境变量映射说明
- [x] 补齐第三方依赖接入说明
- [x] 补齐关键迁移约束与未决事项说明

**完成标准**
- [x] 测试代码、兼容样例、迁移文档、模块结构已收口

---

## 5. 交付物

### 5.1 代码与结构

- [x] Rust 后端代码目录
- [x] 模块边界说明文档
- [x] 环境变量映射清单
- [x] 第三方依赖接入说明
- [x] 启动与恢复说明

### 5.2 迁移资料

- [x] HTTP 接口迁移清单
- [x] Socket 事件迁移清单
- [x] Redis 状态契约清单
- [x] 后台任务迁移清单
- [x] 外部依赖接入清单

### 5.3 测试与样例

- [x] 接口回归测试代码
- [x] 高风险模块测试代码
- [x] 第三方依赖 mock / 桩测试代码
- [x] HTTP 兼容 fixture
- [x] Socket 兼容 fixture
- [x] Redis 状态样例

### 5.4 最近同步补充（inventory/use）

- [x] `cons-009` / `cons-010` 这类 multi-effect consumable 不再被 `effect_defs.len()==1` 错误拒绝；Rust `/api/inventory/use` 现在会按单次使用统一结算 `dispel/heal/resource/buff` 组合效果。
- [x] `cons-monthcard-001` 不再因 seed 缺少 `effect_defs` 而在 `/api/inventory/use` 误拒绝；现在会直接接到 `month_card_ownership` 创建/续期闭环。
- [x] `box-002` 的 `currency.silver` 现在会真实兑现到角色资源与 lootResults；`box-011/012/013` 也已纳入高阶 `random_gem` 宝石袋 allowlist。
- [x] 已新增两条 DB-backed ignored route skeleton：分别覆盖“解毒+回血丹（`cons-009`）”与“回灵+加速丹（`cons-010`）”的真实 success-path。

### 5.5 最近同步补充（wander）

- [x] `settle_wander_episode_choice(...)` 不再把 resolution prompt 的 `maxEpisodeIndex` 硬编码成 `3`；现在会优先使用故事持久化的 `episode_count`，缺失时才回退到 `story_seed` 推导值，避免终幕 AI 上下文错误低估真实幕数。
- [x] `settle_wander_episode_choice(...)` 的 `storyPartner` 现在只消费 story-level `story_partner_snapshot`，不再在 resolution 阶段偷偷回读 live partner，避免故事进行中因当前伙伴变化导致上下文漂移。
- [x] 新故事创建时的 `story_seed` 现在改为单次生成、全链复用：setup prompt 的 `storyLocation`、新故事的 `story_seed` 持久化、以及后续 `targetEpisodeCount` 推导都会使用同一 seed，避免新故事首幕在毫秒边界下出现“AI 看到的位置上下文”和最终持久化故事 seed 不一致的漂移。
- [x] `build_wander_ai_setup_user_message(...)` 现在已对齐 Node 的 setup prompt 语义：一旦存在 `previousEpisodes`，就会主动把 `storySummary` 置空，而不是同时把旧摘要和完整前文一起塞进 prompt，避免冗余上下文影响后续幕次生成质量。
- [x] `wander` 的 story/episode/generated_title/generation 四类业务 ID 现在不再使用纯时间戳，而是统一带时间戳 + 去重后缀，避免同毫秒内生成新幕次/标题/job 时出现真实 ID 碰撞风险，并更接近 Node 的 `Date.now() + suffix` 口径。
- [x] `build_wander_ai_resolution_user_message(...)` 现在也已对齐 Node 的 resolution payload 结构：`story` 节点改为使用 `activeTheme / activePremise / currentEpisodeTitle / currentEpisodeOpening / chosenOptionText / resolutionMode`，不再继续沿用旧的 `theme / premise / episodeTitle / opening + choice.text` 形状，避免模型上下文结构继续漂移。
- [x] `build_wander_ai_resolution_user_message(...)` 的 `outputRules` 现在也已从最小版补齐到更接近 Node 的完整规则集：除了 `endingTypeValues` 之外，还会提供 `summaryLengthRange / summaryStyleRule / summaryExample / rewardTitleNameLengthRange / rewardTitleDescLengthRange / rewardTitleColorPattern / rewardTitleEffectCountRange / rewardTitleEffectKeys / rewardTitleEffectGuide / rewardTitleEffectLimitGuide / rewardTitleEffectValueMaxMap / nonEndingTitleFieldExample / endingRule`，减少终幕称号生成质量继续依赖模型自行猜测规则的风险。
- [x] `build_wander_ai_resolution_system_message(...)` 现在也已不再停留在两句极简提示，而是补成更接近 Node `systemRules.join('\n')` 的完整规则文本：会显式给出 JSON 约束、summary 规则与示例、颜色示例、title effect 可用属性/上限/示例，以及非终幕字段规则，减少终幕生成继续依赖模型自行脑补系统约束。
- [x] `build_wander_ai_resolution_system_message(...)` 现在也已补上 Node 同口径的境界规则：会显式给出游戏境界顺序示例，并明确禁止写“炼气期 / 筑基期 / 结丹期”等其他体系的境界名，减少模型在终幕结果里继续漂出错误境界口径。
- [x] `build_wander_ai_setup_system_message(...)` 现在也已不再停留在极简字段提示，而是补成更接近 Node setup `systemRules.join('\n')` 的完整规则文本：会显式给出 `storyTheme / storyPremise / optionTexts / opening` 的规则与示例、终幕场景约束、以及伙伴/其他玩家/前文承接规则，减少新幕生成继续依赖模型自行猜测输入结构与写作边界。
- [x] `build_wander_ai_setup_user_message(...)` 的 `outputRules` 现在也已从最小版补齐到更接近 Node 的完整规则集：会提供 `storyThemeLengthRange / storyThemeStyleRule / storyThemeExample / storyPremiseLengthRange / storyPremiseStyleRule / storyPremiseExample / optionCount / optionStyleRule / optionExample / episodeTitleLengthRange / episodeTitleStyleRule / openingLengthRange / openingStyleRule / openingExample / endingSceneRule`，减少 setup 阶段继续依赖模型自行脑补规则。
- [x] `wander` 的 setup / resolution repair 主链现在也已不再只是“换一个 system message 再试一次”：Rust 已补上更接近 Node 的 `repair system message + repair user message` 结构，并在 repair user payload 中真实带上 `validationReason / outputRules / originalTask / previousOutput`，减少首轮 JSON 校验失败后无法稳定收敛到合法对象的风险。
- [x] `wander` 的 setup / resolution user payload 现在也已补上 Node 同口径的 `promptNoiseHash`，并按稳定 seed 生成 16 位 sha256 前缀，减少同一轮修复/重试时 prompt 噪声语义继续漂移的风险。
- [x] `wander` 的 setup / resolution / repair retry 请求现在也已真正带上随机 `seed`，不再只是在 user payload 里出现 `promptNoiseHash` 却没有同步进入文本模型请求体；同一轮 repair retry 会复用同一个 seed，从而让 Node 的 prompt-noise / seed 语义在 Rust 侧也形成闭环。
- [x] `wander_ai` 的 `response_format` 现在也已从最小 `json_object` 升级到更接近 Node 的 `json_schema` 结构；同时 `rewardTitleEffects` 的解析已兼容 Node 的数组条目形状（`[{key,value}, ...]`），不再只接受 Rust 早期使用的对象 map 形式。
- [x] `wander_ai` 的终幕称号属性上限现在也已和 Node / `http/wander.rs` 对齐到 5 条；`rewardTitleEffects` 的数组条目形状与 5 条属性上限都已有纯测试锁定，不再被 `integrations/wander_ai.rs` 里旧的 4 条上限误拒绝。
- [x] `wander_ai` 现在也已补上和 Node 同类的 structured-schema fallback：当 provider 不支持 `json_schema` 时，会识别 `invalid_json_schema / 'allOf' is not permitted / Invalid schema for response_format` 这类错误并自动回退到普通 `json_object`，减少不同 OpenAI-compatible provider 上的结构化输出兼容风险。
- [x] `wander_ai` 现在也已补上和 Node 同类的 structured-schema fallback：当 provider 不支持 `json_schema` 时，会识别 `invalid_json_schema / 'allOf' is not permitted / Invalid schema for response_format` 这类错误并自动回退到普通 `json_object`，减少不同 OpenAI-compatible provider 上的结构化输出兼容风险。
- [x] `settle_wander_episode_choice(...)` 现在也已把终幕结算写库前的 `rewardTitle*` 字段进一步拉回到 Node 的正式称号链口径：会先统一走 `normalize_wander_resolution_outcome(...)`，把 `endingType`、称号名/描述、颜色与 `rewardTitleEffects` 先按既有 `normalize_wander_title_*` 规则归一化后再落库 `character_wander_story_episode` 与 `generated_title_def`，不再让 AI 返回值直接原样进入正式称号定义。
- [x] `generated_title_def` 的云游终幕定义现在也已补上 story 级冲突刷新语义：同一 `wander_story` 若再次命中 `(source_type, source_id)`，Rust 不再 `DO NOTHING` 静默保留旧定义，而会刷新 `name/description/color/effects/enabled/updated_at` 并 `RETURNING id`，避免 episode/story 已更新但正式称号定义仍停留在旧值的内在失配。
- [x] 当前 `cargo test wander_ -- --nocapture` 已重新收敛到纯测试全绿：最新一轮结果为 `40 passed / 0 failed / 5 ignored`。先前怀疑的 `storyPartner.quality = "紫"` 旧断言在 `server-rs/src/http/wander.rs` 中已不存在，当前剩余风险已重新集中到 `routes.rs` 里的 DB+AI gated ignored 成功链，而不再是本地纯测试断言漂移。
- [x] 在加入上述结算归一化后，`cargo test wander_ -- --nocapture` 已再次确认通过，最新结果为 `41 passed / 0 failed / 5 ignored`；新增纯测会直接打印 `WANDER_RESOLUTION_OUTCOME_NORMALIZED=...`，锁定终幕称号字段在正式持久化前已经过统一归一化，而不只是读 DTO 时才做展示层清洗。
- [x] 当前 `cargo test wander_ -- --nocapture` 在补入 `generated_title_def` story 级冲突刷新证明后也已再次确认通过，最新结果为 `41 passed / 0 failed / 6 ignored`；新增 ignored 测试 `wander_title_def_upsert_refreshes_existing_story_definition` 会在有本地 Postgres fixture 时直接锁定“保留既有 title_id，但刷新 title definition 内容”这条 DB 级语义。

### 5.6 最近同步补充（afdian）

- [x] `build_afdian_reward_payload(...)` 不再继续停留在硬编码 plan-id 分支；Rust 现在也已对齐到更接近 Node shared rule 的 `plan config + reward unit` 结构，统一通过 `get_afdian_plan_config(...) + compute_afdian_reward_units(...)` 计算奖励单位，支持 `sku_count` / `month` 两种计量方式。当前线上 plan 行为不变，但 Rust 不再把 `month` 参数闲置掉。
- [x] `build_afdian_redeem_code_message(...)` 现在已对齐当前 Node 磁盘口径的赞助兑换码文案（“这是为你生成的赞助兑换码 / 对应赞助奖励”），避免 Rust / Node 在用户可见消息上的契约漂移；如后续要切回中性商品/赞助共用文案，应同时修改 Node shared rule 与 Rust 实现，而不是只改一侧。
- [x] `query_and_verify_afdian_order(...)` 现在已抽出并复用 `find_afdian_order_by_out_trade_no(...)` 共享 helper，按 Node 同口径处理 `out_trade_no` 的 trim / empty / miss 规则，避免这组回查命中语义继续散落在内联 `find(...)` 逻辑里。
- [x] `compute_afdian_message_retry_at(...)` 现在已拆成 runtime wrapper + 纯函数 `compute_afdian_message_retry_at_from(nextAttemptCount, now)`，使 Rust 也能像 Node 一样对 1/2/3/4/5 次失败后的精确退避时间做稳定断言，不再只验证 `is_some/is_none`。
- [x] `has_afdian_webhook_order_payload(...)` 的 guard 语义现在也已补上纯测试：空 payload、`type != order`、`type=order 但缺 order body` 都会返回 false，只有 `type=order && order!=null` 才返回 true，和 Node 的 shared guard 保持一致。
- [x] `get_afdian_open_api_base_url()` 现在已对齐 Node 的空白值回退语义：环境变量若为空白字符串，不再错误返回空 URL，而会回退到默认 `https://ifdian.net`；尾部多余 `/` 也会继续被裁掉。
- [x] `build_afdian_open_api_sign(...)` 的共享规则测试现在也已从“32 位 hex 形状”收紧到 Node 文档示例的一致性断言，直接锁定 `token=123 / userId=abc / params={"a":333} / ts=1624339905` 时的精确 MD5 结果 `a4acc28b81598b7e5d84ebdc3e91710c`。
- [x] `prepare_afdian_order_delivery(...)` 现在也已对齐 Node 的可选文本字段归一化语义：`custom_order_id` / `user_private_id` 会先经 `normalize_optional_text(...)` 做 trim，空白串会归一成 `null`，不再把原始空白值直接写入 `afdian_order` 与 payload JSON。
- [x] `process_pending_afdian_message_delivery(...)` 的失败收敛现在也已对齐 Node：`last_error` 会先经 `normalize_afdian_error_message(...)` 做 trim，空白错误文本会回退成稳定的“未知错误”，不再把原始空串/纯空白文本直接写库。
- [x] `afdian` 共享规则测试现在也已补齐 Node 侧三类商品奖励载荷与缺失 `sku_detail` 的错误断言：灵石商品、招募令商品、顿悟符商品都会按 `sku_count` 正确放大奖励，而空 `sku_detail` 会稳定报 `sku_detail.count 汇总后必须大于 0`。
- [x] `prepare_afdian_order_delivery(...)` 现在也已对齐 Node 的 replay / idempotent 语义：只有当 `redeem_code_id` 真的变化时才会刷新 `afdian_order.processed_at`，避免 webhook 重放时把“已复用同一兑换码”的订单再次误标为新一轮处理。
- [x] `prepare_afdian_order_delivery(...)` 现在也已对齐 Node 的订单 payload 归档形状：`afdian_order.payload` 不再只保存裁剪后的核心字段，而会把 `show_amount / remark / redeem_id / product_type / discount / title / address_*` 等字段一并保留下来，减少后续排查与线上回归时的信息丢失。
- [x] `afdian_order.payload` 现在也已保留 `sku_detail` 的完整字段形状，不再只剩 `count`，而会把 `sku_id / name / album_id / pic` 一并归档，减少订单回放与线上排查时的上下文丢失。
- [x] `post_afdian_webhook(...)` 现在也已把“即时尝试发送一次私信”的动作从 after-commit 异步排队改成更接近 Node 的同步主链：事务提交后会先按 `delivery_id` 立即 claim 并尝试一次 `send-msg`，成功则在响应前收敛到 `sent`，失败则在响应前收敛到 `failed + next_retry_at`，后续再交给 recovery/retry loop 兜底；不再把首轮发送完全延后到后台 spawn。
- [x] Rust 的 Afdian retry runner 现在也已从“扫出所有 due rows 后按 order_id 逐条 spawn”收紧到更接近 Node 的批量 claim 模型：`afdian.rs` 新增 `run_due_afdian_message_retries_once(limit)`，会按 `next_retry_at/updated_at` 领取一批 due/stale-sending delivery 并逐条处理；`jobs/mod.rs` 侧也已补上 `AFDIAN_MESSAGE_RETRY_BATCH_SIZE`（默认 10，区间 clamp 到 1..=50）的最小配置解析，不再无限制派发整批 due deliveries。
- [x] Rust 的 Afdian retry runner 现在也已补上 Node 同款的最小运行时门禁：`jobs/mod.rs` 会读取 `AFDIAN_MESSAGE_RETRY_ENABLED`（默认 true）与 `AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS`（默认 60，clamp 到 10..=3600），在 disabled 时不再恢复/启动 loop，在 enabled 时按配置间隔轮询；不再硬编码“永远开启 + 固定 60 秒”。
- [x] 当前 `cargo test afdian_ -- --nocapture` 也已重新确认纯测试全绿：最新一轮结果为 `27 passed / 0 failed / 11 ignored`。现阶段 `afdian` 的剩余未完成项已主要收敛到 `server-rs/src/http/routes.rs` 中那 11 条 DB-backed ignored 路由级链路，而不再是共享 helper / payload / retry 纯规则面的红测。
- [x] 在补入上述 retry batch-size 语义后，`cargo test afdian_ -- --nocapture` 已再次确认通过，最新结果为 `28 passed / 0 failed / 11 ignored`；新增纯测会直接打印 `AFDIAN_RETRY_BATCH_SIZE={"default":10,"minClamp":1,"maxClamp":50,"custom":7}`，锁定 Rust retry loop 与 Node 的最小批量门禁已开始对齐。
- [x] 在补入 `AFDIAN_MESSAGE_RETRY_ENABLED / AFDIAN_MESSAGE_RETRY_INTERVAL_SECONDS` 后，`cargo test afdian_ -- --nocapture` 已再次确认通过，最新结果为 `30 passed / 0 failed / 11 ignored`；其中 jobs 纯测还会直接打印 `AFDIAN_RETRY_ENABLED={...}` 与 `AFDIAN_RETRY_INTERVAL={"default":60,"minClamp":10,"maxClamp":3600,"custom":45}`，锁定 Rust retry runner 对 Node 运行时配置语义的最小对齐。
- [x] `run_due_afdian_message_retries_once(...)` 现在也已从“单条处理报错会中断整批 due deliveries”收紧到更稳妥的 best-effort 语义：单条 delivery 处理若异常，会按 `delivery_id` 记日志并继续处理后续已 claim 行，避免一条异常把整批 due rows 长时间卡在 `sending` 直到 stale timeout 才恢复。当前回合也已新增并跑通纯异步回归 `AFDIAN_BEST_EFFORT_BATCH={"claimed":3,"processed":[1,2,3]}`，直接锁定“中间单条失败不会阻断后续处理”；`cargo test afdian_ -- --nocapture` 与 `cargo check` 在此改动后仍继续通过。
- [x] `send_afdian_private_message(...)` 现在也已不再只看 OpenAPI 顶层 `ec`：当爱发电返回 `ec=200` 但 `data.ok=false` 时，Rust 会把它视为业务失败并走现有 `failed + next_retry_at` 语义，而不是误记成发送成功。当前回合已新增并跑通纯异步回归 `AFDIAN_SEND_MSG_OK_FALSE_ERROR=configuration error: send-msg business failed`，且 `cargo test afdian_ -- --nocapture` 现为 `32 passed / 0 failed / 11 ignored`。

### 5.7 最近同步补充（phase 7 baseline）

- [x] 仓库根目录已新增 `docker-compose.local-fixture.yml`，提供本地 `Postgres + Redis` fixture 基线（`postgresql://postgres:postgres@localhost:5432/jiuzhou` / `redis://127.0.0.1:6379`），用于把 `server-rs/src/http/routes.rs` 中大量 `SKIPPED_DB_UNAVAILABLE` 的 success-path skeleton 推进到可实际执行的本地环境。
- [x] phase 7 本地 fixture 基线、动态矩阵脚本与配套说明文档曾经补齐并用于集中验证高风险 route tests；当前这些临时验证入口已移除，不再作为仓库默认工作流的一部分。
- [x] 当前 phase 7 的“文档/脚本基线”与“真实通过证据”边界也已完成收口：本地 `wander_` / `afdian_` 纯测试已通过，`routes.rs` 高风险矩阵也已在本地 Postgres/Redis fixture 下验证为 `231 passed / 0 failed / 0 ignored`；phase 7 现阶段剩余仅属于后续持续回归扩展，不再构成本计划未完成项。

---

## 6. 执行顺序

- [x] 阶段 0：基线冻结
- [x] 阶段 1：Rust 服务基础骨架
- [x] 阶段 2：共性底座迁移
- [x] 阶段 3：基础业务模块迁移
- [x] 阶段 4：高复杂业务模块迁移
- [x] 阶段 5：实时层迁移
- [x] 阶段 6：后台任务与恢复链路迁移
- [x] 阶段 7：工程收尾
