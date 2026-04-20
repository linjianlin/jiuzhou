# Rust 后端 Socket 事件基线

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 中“Socket 事件迁移清单 / 事件基线清单”。

## 1. 路径基线

- 主路径：`/game-socket`
- fallback：`/socket.io`
- 静态上传路径兼容：`/uploads/*`

权威挂载位置：`server-rs/src/bootstrap/app.rs`

## 2. 客户端主动发送事件

- `game:auth`
- `game:refresh`
- `game:addPoint`
- `battle:sync`
- `game:onlinePlayers:request`
- `chat:send`
- `join:room`
- `leave:room`

## 3. 客户端订阅事件

- `game:error`
- `game:kicked`
- `game:auth-ready`
- `game:character`
- `game:time-sync`
- `game:onlinePlayers`
- `battle:update`
- `battle:cooldown-sync`
- `battle:cooldown-ready`
- `arena:update`
- `idle:update`
- `idle:finished`
- `mail:update`
- `achievement:update`
- `task:update`
- `team:update`
- `sect:update`
- `wander:update`
- `techniqueResearch:update`
- `techniqueResearchResult`
- `partnerRecruit:update`
- `partnerRecruitResult`
- `partnerFusion:update`
- `partnerFusionResult`
- `partnerRebone:update`
- `partnerReboneResult`
- `market:update`
- `rank:update`
- `chat:message`
- `chat:error`

## 4. 权威实现位置

- Rust realtime 主实现：`server-rs/src/realtime/public_socket.rs`
- Node 基线：`server/src/game/gameServer.ts`
- 客户端消费面：`client/src/services/gameSocket.ts`

## 5. 当前验收重点

- 认证成功首包必须先发 `game:character`，随后补发 overview 类事件，再发 `game:auth-ready`。
- 重连时若当前 battle/session 仍在 Rust runtime 中，必须补发 `battle:update` 与 cooldown 状态。
- 单播事件不得误发给旁观者；房间/频道广播不得误发给未加入连接。
