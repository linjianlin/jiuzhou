# Rust 后端迁移基线（阶段 0）

本文档冻结当前 Node/TypeScript 后端的迁移基线，作为 `RUST_BACKEND_REWRITE_PLAN.md` 阶段 0 的直接依据。

## 1. 固定路径与入口基线

### 1.1 对外路径面

当前前端反代与运行时 URL 已固定以下路径面，Rust 迁移必须保持兼容：

- HTTP API：`/api/*`
- 游戏实时链路：`/game-socket/*`
- Socket.IO 回退链路：`/socket.io/*`
- 上传资源：`/uploads/*`

证据：

- `client/Caddyfile`
- `client/src/services/runtimeUrls.ts`
- `client/src/services/gameSocket.ts`

### 1.2 当前服务根入口

当前 Node 服务根入口与健康检查响应形态如下：

- `GET /` → `{ name, version, status: "running" }`
- `GET /api/health` → `{ status: "ok", timestamp }`

证据：`server/src/bootstrap/registerRoutes.ts`

### 1.3 当前已注册 HTTP 路由前缀

当前 `server/src/bootstrap/registerRoutes.ts` 注册的 API 前缀如下，Rust 迁移阶段不得丢失：

- `/api/auth`
- `/api/account`
- `/api/character`
- `/api/upload`
- `/api/attribute`
- `/api/inventory`
- `/api/signin`
- `/api/mail`
- `/api/map`
- `/api/info`
- `/api/battle`
- `/api/battle-session`
- `/api/tower`
- `/api/technique`
- `/api/team`
- `/api/market`
- `/api/dungeon`
- `/api/monthcard`
- `/api/battlepass`
- `/api/sect`
- `/api/rank`
- `/api/realm`
- `/api/task`
- `/api/time`
- `/api/main-quest`
- `/api/arena`
- `/api/achievement`
- `/api/title`
- `/api/idle`
- `/api/insight`
- `/api/partner`
- `/api/game`
- `/api/wander`
- `/api/captcha`
- `/api/afdian`
- `/api/redeem-code`

### 1.4 前端 API 消费模块入口

当前客户端 API 入口模块位于 `client/src/services/api/`，至少包含以下消费面：

- `accountSecurity.ts`
- `auth-character.ts`
- `avatarUploadShared.ts`
- `battleSession.ts`
- `captchaConfig.ts`
- `combat-realm.ts`
- `core.ts`
- `gameHome.ts`
- `gemSynthesis.ts`
- `info-config.ts`
- `inventory.ts`
- `market-mail.ts`
- `partner.ts`
- `phoneBinding.ts`
- `profile.ts`
- `rank-sect.ts`
- `redeemCode.ts`
- `requestConfig.ts`
- `task-achievement.ts`
- `technique.ts`
- `tower.ts`
- `wander.ts`
- `welfare.ts`
- `world.ts`

证据：`client/src/services/api/*.ts`

### 1.5 前端 HTTP 协议固定约束

前端当前对 HTTP 协议有以下固定假设：

- 所有 axios 请求默认以 `API_BASE` 为基址，并自动附带 `Authorization: Bearer <token>`
- axios 拦截器默认解包 `response.data`
- 即使 HTTP 200，只要响应体里是 `success: false`，前端仍按失败处理
- 某些请求会通过 `meta.autoErrorToast = false` 关闭默认错误提示

证据：

- `client/src/services/api/core.ts`
- `client/src/services/api/requestConfig.ts`
- `client/src/services/api/error.ts`

### 1.6 客户端 HTTP 风险点

迁移时需要保留的特殊协议点：

- 多数接口使用 `{ success, message?, data? }` 包装，但少数接口直接读取顶层字段
- `searchSects` 一类接口读取顶层 `list/page/limit/total`
- 若干邮件接口直接读取顶层 `rewards/claimedCount/readCount/deletedCount`
- 头像上传存在两条协议分支：STS 直传与服务端 multipart 回退
- 验证码请求体兼容两种载荷：本地图形验证码与腾讯验证码
- `POST /character/updatePosition` 存在 `keepalive` 发送场景
- `GET /inventory/items` 的前端分页上限固定为 `pageSize <= 200`
- 伙伴、功法研究、云游等接口依赖异步 job + preview/confirm/discard/mark-result-viewed 模式

## 2. 实时协议基线

### 2.1 连接路径与传输形态

客户端实时连接使用 `socket.io-client`，服务端路径基线如下：

- 生产同域，开发默认 `:6011`
- 主要路径：`/game-socket`
- 回退路径仍需兼容 `/socket.io/*`

证据：

- `client/src/services/gameSocket.ts`
- `client/Caddyfile`
- `server/src/game/gameServer.ts`
- `server/src/config/socket.ts`

### 2.2 客户端主动发送事件

当前客户端主动发送的关键事件：

- `game:auth`
- `game:refresh`
- `game:addPoint`
- `battle:sync`
- `game:onlinePlayers:request`
- `chat:send`

证据：`client/src/services/gameSocket.ts`

### 2.3 客户端订阅事件

当前客户端明确订阅的关键事件：

- `game:error`
- `game:character`
- `game:kicked`
- `team:update`
- `sect:update`
- `game:auth-ready`
- `battle:update`
- `arena:update`
- `idle:update`
- `idle:finished`
- `mail:update`
- `achievement:update`
- `task:update`
- `game:time-sync`
- `techniqueResearch:update`
- `techniqueResearchResult`
- `partnerRecruit:update`
- `partnerRecruitResult`
- `partnerFusion:update`
- `partnerFusionResult`
- `partnerRebone:update`
- `partnerReboneResult`
- `chat:message`
- `chat:error`
- `game:onlinePlayers`

证据：`client/src/services/gameSocket.ts`

### 2.4 服务端实时职责主文件

- `server/src/game/gameServer.ts`：`/game-socket` 建链、`game:auth` 鉴权、单点登录踢线、在线状态、聊天广播、属性推送、冷却同步
- `server/src/config/socket.ts`：通用 Socket.IO 入口、`/socket.io` 默认连接、`join:room` / `leave:room` / `chat:send`
- `server/src/app.ts`：`game:time-sync` 广播接线

### 2.5 battle / game-time 协议固定点

- `battle:update` 是战斗实时主入口
- 前端当前支持的 `battle:update` wire kind 至少包含：
  - `battle_started`
  - `battle_state`
  - `battle_finished`
  - `battle_abandoned`
- 战斗冷却单独使用：
  - `battle:cooldown-sync`
  - `battle:cooldown-ready`
- 游戏时间同步单独使用：`game:time-sync`

证据：

- `client/src/services/battleRealtime.ts`
- `client/src/services/gameSocket.ts`
- `server/src/services/gameTimeService.ts`

### 2.6 realtime 风险点

- `/game-socket` 是当前主游戏实时通道
- `server/src/config/socket.ts` 暴露了并行的默认 `/socket.io` 通道，但不是当前 `gameSocket.ts` 的主消费面
- 客户端保留了 `idle:finished` 消费面，本轮仓库证据中未发现明确 producer，迁移时需要保守兼容

证据：

- `client/src/services/gameSocket.ts`
- `server/src/game/gameServer.ts`
- `server/src/config/socket.ts`

## 3. 启动、恢复与关闭基线

### 3.1 启动顺序语义

当前服务不是“先监听端口再慢慢恢复”，而是按以下顺序完成后才开始 `listen`：

1. PostgreSQL 探活，失败则启动终止
2. Redis 探活，失败允许降级但发出警告
3. 动态快照刷新与数据准备
4. 性能索引与 Delta 聚合器初始化
5. 头像清理检查与异常数据清理
6. Worker 池初始化
7. AI/云游等 worker 协调器初始化
8. 过期秘境、千层塔、在线战斗投影等预热
9. 延迟结算、爱发电重试、排行夜刷等调度器初始化
10. 游戏时间、竞技场周结算、清理 worker 初始化
11. Redis 可用时执行战斗状态恢复与战斗会话恢复
12. 挂机会话恢复
13. 最后才监听端口

证据：`server/src/bootstrap/startupPipeline.ts`

### 3.2 健康检查语义

当前部署依赖 `/api/health` 判活，而服务仅在完整启动链完成后才监听端口，因此健康检查实际上承担了 readiness 语义。

证据：

- `server/src/bootstrap/registerRoutes.ts`
- `server/src/bootstrap/startupPipeline.ts`
- `docker-stack.yml`

### 3.3 优雅关闭顺序

当前关闭顺序固定为：

1. 停止接受新 HTTP 请求
2. 关闭游戏 Socket 服务
3. 停止时间服务、结算、清理、战斗与挂机执行循环
4. 关闭各类 worker 协调器与异步 runner
5. 等待已有操作 drain
6. flush 缓冲区与 Delta 聚合器
7. 关闭 Redis 与 PostgreSQL 连接

证据：`server/src/bootstrap/startupPipeline.ts`

## 4. 环境变量与第三方依赖基线

### 4.1 基础运行依赖

- PostgreSQL：`DATABASE_URL` 以及 `DB_*` 连接池配置
- Redis：`REDIS_URL`
- JWT：`JWT_SECRET`、`JWT_EXPIRES_IN`
- HTTP 服务：`HOST`、`PORT`、`NODE_ENV`、`CORS_ORIGIN`

### 4.2 启动与调度相关配置

- `IDLE_WORKER_COUNT`
- `IDLE_HISTORY_*`
- `GAME_TIME_SCALE`
- `STAMINA_*`
- `REALM_CONFIG_PATH`
- `CLEAR_AVATARS`

### 4.3 上传 / COS 配置

- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_BUCKET`
- `COS_REGION`
- `COS_AVATAR_PREFIX`
- `COS_GENERATED_IMAGE_PREFIX`
- `COS_DOMAIN`
- `COS_STS_DURATION_SECONDS`

当前 COS 配置不完整时，服务不会拒绝启动，而是自动回退到本地磁盘上传。

证据：

- `server/.env.example`
- `server/src/config/cos.ts`

### 4.4 第三方依赖分组

- 爱发电：`AFDIAN_*`
- AI 文本模型：`AI_TECHNIQUE_*`、`AI_PARTNER_*`、`AI_WANDER_*`
- 敏感词服务：`SENSITIVE_WORD_SERVICE_*`
- AI 图片生成：`AI_TECHNIQUE_IMAGE_*`
- 坊市手机号绑定/短信：`MARKET_PHONE_BINDING_*`、`ALIYUN_SMS_*`
- 验证码：`CAPTCHA_PROVIDER`、`TENCENT_CAPTCHA_*`

证据：`server/.env.example`

## 5. 上传与静态资源基线

### 5.1 路径约束

- `/uploads/*` 必须始终走 `SERVER_BASE`
- 不能被 CDN 基址替换

证据：`client/src/services/runtimeUrls.ts`

### 5.2 当前服务端行为

- Node 服务通过静态目录直接暴露 `/uploads`
- 当前 Docker 部署将卷挂载到 `/app/server/uploads`
- 本地上传目录是 `server/uploads`

证据：

- `server/src/app.ts`
- `docker-stack.yml`
- `server-rs/.env.example`

## 6. Rust 阶段 1 已完成基线

当前 `server-rs/` 已完成的基础骨架内容：

- `axum + tokio` 单体入口
- 配置加载、日志初始化、统一错误模型
- `GET /` 与 `GET /api/health`
- PostgreSQL、Redis、outbound HTTP client 接线
- `/uploads` 静态路径占位
- realtime/jobs 生命周期占位
- 优雅关闭骨架

证据：

- `server-rs/src/main.rs`
- `server-rs/src/bootstrap/startup.rs`
- `server-rs/src/bootstrap/app.rs`
- `server-rs/src/http/mod.rs`
- `server-rs/src/shared/error.rs`
- `server-rs/.env.example`

## 7. 当前阶段状态

基于当前仓库证据：

- 阶段 1（Rust 服务基础骨架）已完成最小可运行版本
- 阶段 0 已完成“最小基线冻结”：覆盖路径面、启动语义、环境依赖、上传假设与阶段 1 交付范围
- 阶段 0 的目标始终是“最小基线冻结”，而不是一次性穷尽全部请求/响应样本与全部 Redis / Socket 载荷；这些细项已在后续迁移清单、fixture 与 phase 7 验证中继续补齐，因此不再构成后续阶段验收阻塞
