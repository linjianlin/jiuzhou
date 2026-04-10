# 2026-04-09 Rust 后端重写兼容矩阵

## 目标

为 `server-rs/` 提供唯一可信的兼容边界定义。除非本文件先改并获得确认，否则 Rust 实现不得主动改变以下任何外部行为：

- HTTP 路径、方法、响应 envelope、状态码、错误文案
- Socket.IO 默认通道与 `/game-socket` 的连接方式、事件名、字段、时序
- PostgreSQL schema 与主要事务语义
- Redis battle / session / projection / idle / settlement 运行时数据格式
- 启动恢复顺序、readiness 与 shutdown drain 语义

---

## 一、HTTP 兼容边界

### 1. 路由分组

当前后端通过 `server/src/bootstrap/registerRoutes.ts` 挂载以下 `/api/*` 分组：

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

附加端点：

- `GET /` -> `{ name, version, status }`
- `GET /api/health` -> `{ status: 'ok', timestamp }`
- `/uploads/*` 静态文件

### 2. 通用鉴权与 admission 语义

定义文件：

- `server/src/middleware/auth.ts`
- `server/src/middleware/qpsLimit.ts`
- `server/src/middleware/requireMarketPhoneBinding.ts`
- `server/src/middleware/requireMarketPurchaseCaptcha.ts`

必须保持：

- Bearer 鉴权头：`Authorization: Bearer <token>`
- `requireAuth` 失败固定：`401 { success:false, message:'登录状态无效，请重新登录' }`
- `requireCharacter` 若角色不存在固定：`404 { success:false, message:'角色不存在' }`
- 单用户 HTTP 并发排队超时固定：`503 { success:false, message:'当前账号请求排队超时，请稍后再试' }`
- QPS 限流固定：`429 { success:false, message }`

坊市特例：

- 未绑定手机号：`403 { success:false, message:'使用坊市功能前请先绑定手机号' }`
- 风控验证码：

```json
{
  "success": false,
  "code": "MARKET_CAPTCHA_REQUIRED",
  "message": "坊市访问行为异常，请先完成图片验证码验证后再购买",
  "data": {
    "riskScore": 0,
    "reasons": []
  }
}
```

### 3. 标准 response envelope

定义文件：

- `server/src/middleware/response.ts`
- `server/src/middleware/errorHandler.ts`
- `server/src/middleware/BusinessError.ts`

必须保持：

- `sendSuccess` -> `200 { success:true, data }`
- `sendOk` -> `200 { success:true }`
- `sendResult` -> `result.success ? 200 : 400`
- `BusinessError(status, message)` -> `{ success:false, message }`
- 未捕获异常 -> `500 { success:false, message:'服务器错误' }`

### 4. 已确认的特殊 HTTP 协议

- `/api/auth/verify`、`/api/auth/bootstrap`
  - 单点登录被踢时：`401 { success:false, message:'账号已在其他设备登录', kicked:true }`
- `/api/idle/start`
  - 已存在会话：`409 { success:false, message, existingSessionId }`
  - 技能策略非法：`400 { success:false, message:'技能策略非法', errors:[...] }`
- `/api/inventory/enhance`
- `/api/inventory/refine`
- `/api/inventory/reroll-affixes`
- `/api/inventory/socket`
  - 当前允许 HTTP 200 + `success:false`，Rust 实现不得擅自改成 4xx
- `/api/afdian/webhook`
  - 成功：`200 { ec:200, em:'' }`
  - 失败：`400 { ec:400, em:<message> }`
- `/api/upload`
  - 上传错误文案是协议一部分：
    - `只支持 JPG、PNG、GIF、WEBP 格式的图片`
    - `图片大小不能超过2MB`
    - `缺少 avatarUrl`
    - `请选择图片文件`
    - 本地上传失败固定 `500 { success:false, message:'上传失败' }`

### 5. 高风险 HTTP 对拍端点

优先做黑盒对拍：

1. `/api/auth/verify`
2. `/api/auth/bootstrap`
3. `/api/market/*` 购买链路
4. `/api/idle/start`
5. `/api/character/:characterId/*`
6. `/api/upload/*`
7. `/api/afdian/webhook`
8. `/api/inventory/enhance`

---

## 二、Socket / Realtime 兼容边界

### 1. 通道划分

定义文件：

- `server/src/config/socket.ts`
- `server/src/game/gameServer.ts`
- `client/src/services/gameSocket.ts`

必须保持：

- 默认 Socket.IO 通道继续存在
- 游戏实时通道 path 必须继续是 `/game-socket`
- 客户端 transport 仍接受 `websocket` + `polling`

### 2. 核心认证与会话时序

必须保持：

1. 客户端连上 `/game-socket`
2. 客户端发 `game:auth(token)`
3. 服务端校验 token + sessionToken
4. 若旧连接存在，旧连接收到 `game:kicked` 并断开
5. 新连接加入用户/角色/队伍/宗门房间
6. 服务端补发必要实时状态
7. 最后发 `game:auth-ready`

### 3. 关键房间语义

必须保持：

- `chat:authed`
- `chat:user:{userId}`
- `chat:character:{characterId}`
- `chat:team:{teamId}`
- `chat:sect:{sectId}`

### 4. 关键事件名

客户端发：

- `game:auth`
- `game:refresh`
- `game:addPoint`
- `battle:sync`
- `game:onlinePlayers:request`
- `chat:send`

服务端发：

- `game:character`
- `game:error`
- `game:kicked`
- `game:auth-ready`
- `game:onlinePlayers`
- `game:time-sync`
- `chat:message`
- `chat:error`
- `battle:update`
- `battle:cooldown-sync`
- `battle:cooldown-ready`
- `team:update`
- `sect:update`
- `arena:update`
- `idle:update`
- `idle:finished`
- `mail:update`
- `achievement:update`
- `task:update`
- `techniqueResearchResult`
- `techniqueResearch:update`
- `partnerRecruitResult`
- `partnerRecruit:update`
- `partnerFusionResult`
- `partnerFusion:update`
- `partnerReboneResult`
- `partnerRebone:update`

### 5. 高风险 Socket 对拍事件

优先对拍：

1. `game:auth` -> `game:auth-ready`
2. `game:kicked`
3. `game:onlinePlayers` full/delta
4. `battle:update`（含 `session`、`logStart`、`logDelta`、`unitsDelta`）
5. `battle:cooldown-sync`
6. `idle:update`
7. `chat:message`

---

## 三、Redis 兼容边界

### 1. battle 持久化

定义文件：

- `server/src/services/battle/runtime/persistence.ts`
- `server/src/services/battle/lifecycle.ts`

必须兼容：

- `battle:state:{battleId}`
- `battle:state:static:{battleId}`
- `battle:participants:{battleId}`

当前 TTL：1800 秒。

### 2. 普通 PVE 续战意图

定义文件：

- `server/src/services/battleSession/pveResumeIntent.ts`

必须兼容：

- `battle:session:pve-resume:{ownerUserId}`

当前 TTL：1800 秒。

### 3. online-battle projection

定义文件：

- `server/src/services/onlineBattleProjectionService.ts`

必须兼容：

- `online-battle:character:{characterId}`
- `online-battle:user-character:{userId}`
- `online-battle:team-member:{userId}`
- `online-battle:session:{sessionId}`
- `online-battle:session-battle:{battleId}`
- `online-battle:arena:{characterId}`
- `online-battle:dungeon:{instanceId}`
- `online-battle:dungeon-battle:{battleId}`
- `online-battle:dungeon-entry:{characterId}:{dungeonId}`
- `online-battle:tower:{characterId}`
- `online-battle:tower-runtime:{battleId}`
- `online-battle:settlement-task:{taskId}`

以及所有相关索引：

- `online-battle:index:characters`
- `online-battle:index:users`
- `online-battle:index:sessions`
- `online-battle:index:arena`
- `online-battle:index:dungeons`
- `online-battle:index:dungeon-entries`
- `online-battle:index:towers`
- `online-battle:index:tower-runtimes`
- `online-battle:index:settlement-tasks`

### 4. idle 运行时锁

定义文件：

- `server/src/services/idle/idleSessionService.ts`

必须兼容：

- `idle:lock:{characterId}`

value 当前为 `idle-start:{uuid}`，TTL 取决于最大挂机时长与缓冲窗口。

### 5. 角色运行时资源

定义文件：

- `server/src/services/characterComputedService.ts`

必须兼容：

- `character:runtime:resource:v1:{characterId}`

### 6. Redis 侧实现禁令

Rust 实现不得：

- 修改 battle/projection/session/idle 现有 key 命名
- 重新设计 JSON 顶层字段名
- 擅自补 TTL / 去 TTL
- 在切换前做“Redis 清理重构”

---

## 四、启动 / 恢复 / 关闭兼容边界

定义文件：

- `server/src/app.ts`
- `server/src/bootstrap/startupPipeline.ts`

必须保持：

1. 先初始化 config / logging
2. 检查 PostgreSQL
3. 检查 Redis
4. 执行预热与索引同步
5. 初始化 worker / runner / scheduler
6. 恢复 battle
7. 恢复 battle session
8. 恢复 idle session
9. 最后 `listen`

shutdown 必须保持：

1. 先阻止新连接
2. 再做 runtime / worker drain
3. 再释放 Postgres / Redis 等资源

---

## 五、第一批 fixture 需求

### HTTP
- `auth-verify-kicked.json`
- `market-captcha-required.json`
- `idle-start-conflict.json`
- `afdian-webhook-ok.json`

### Socket
- `game-auth-ready.json`
- `game-kicked.json`
- `battle-update-sample.json`
- `idle-update-sample.json`

### Redis
- `battle-state-sample.json`
- `battle-static-sample.json`
- `battle-session-sample.json`
- `online-projection-session-sample.json`
- `idle-lock-sample.txt`

### Startup
- `startup-order.txt`
- `shutdown-order.txt`

---

## 六、当前结论

Rust 重写的核心不是“把 API 改成 Axum”，而是：

- 保持 HTTP 黑盒兼容
- 保持 Socket.IO 可见行为兼容
- 保持 Redis 恢复数据兼容
- 保持启动与恢复时序兼容

后续任何 Rust 实现若与本文件冲突，以本文件为准，除非先更新本文件并明确记录原因。
