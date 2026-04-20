# Rust 后端高风险模块开发清单

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 阶段 0 中“高风险模块开发清单”。

## 1. 在线战斗 / BattleSession / 投影恢复

关注点：

- `battle:update` payload 权威性
- `battle:cooldown-sync / ready` 重连补发
- Redis bundle 恢复后不误判 abandoned
- waiting-transition 会话恢复

主文件：

- `server-rs/src/realtime/public_socket.rs`
- `server-rs/src/http/battle.rs`
- `server-rs/src/http/battle_session.rs`
- `server-rs/src/integrations/battle_persistence.rs`

## 2. 挂机系统

关注点：

- active session recovery
- lock projection 真值
- batch flush
- `idle:update / idle:finished` 单播正确性

主文件：

- `server-rs/src/http/idle.rs`
- `server-rs/src/jobs/mod.rs`

## 3. 坊市与风控链路

关注点：

- market listing / buy / cancel 后的 delta 与 mail relocation
- 手机号绑定门槛
- 实时 `market:update` / `rank:update`

主文件：

- `server-rs/src/http/market.rs`
- `server-rs/src/http/account.rs`

## 4. 上传与资源访问链路

关注点：

- `/uploads/*` 静态兼容
- COS STS 与本地回退双路径
- 上传成功后的 `game:character` 刷新

主文件：

- `server-rs/src/bootstrap/app.rs`
- `server-rs/src/http/upload.rs`

## 5. AI 生成内容链

关注点：

- technique / partner / wander provider 配置缺失时的安全失败
- generated_draft / generated_preview / succeeded / failed 状态推进
- result/update 事件单播

主文件：

- `server-rs/src/http/character_technique.rs`
- `server-rs/src/http/partner.rs`
- `server-rs/src/http/wander.rs`
- `server-rs/src/integrations/*_ai.rs`

## 6. Delta 聚合与 Redis 原子协议

关注点：

- claim / finalize / restore 语义
- shutdown 显式 flush
- 各主流程写链是否真正走 delta family

主文件：

- `server-rs/src/integrations/redis_*_delta.rs`
- `server-rs/src/jobs/mod.rs`
- `server-rs/src/bootstrap/shutdown.rs`
