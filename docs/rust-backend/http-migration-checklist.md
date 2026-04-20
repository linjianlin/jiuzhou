# Rust 后端 HTTP 接口迁移清单

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 中“HTTP 接口迁移清单 / 接口基线清单”交付物，和 `phase-0-baseline.md` 一起作为 Rust 对外 HTTP 契约的冻结基线。

## 1. 根入口与基础能力

- `GET /`
- `GET /api/health`
- `GET /api/captcha/config`

## 2. 认证与账号

- `/api/auth/*`
- `/api/account/*`

## 3. 角色与属性

- `/api/character/*`
- `/api/attribute/*`

## 4. 背包 / 上传 / 邮件

- `/api/inventory/*`
- `/api/upload/*`
- `/api/mail/*`

## 5. 战斗与成长

- `/api/battle/*`
- `/api/battle-session/*`
- `/api/tower/*`
- `/api/dungeon/*`
- `/api/realm/*`
- `/api/technique/*`
- `/api/character/{characterId}/technique/*`
- `/api/partner/*`

## 6. 世界与玩法

- `/api/map/*`
- `/api/info/*`
- `/api/game/*`
- `/api/idle/*`
- `/api/wander/*`

## 7. 经济与社交

- `/api/market/*`
- `/api/team/*`
- `/api/sect/*`
- `/api/rank/*`

## 8. 福利与活动

- `/api/signin/*`
- `/api/monthcard/*`
- `/api/battlepass/*`
- `/api/redeem-code/*`
- `/api/achievement/*`
- `/api/task/*`
- `/api/main-quest/*`
- `/api/title/*`
- `/api/time`
- `/api/insight/*`
- `/api/arena/*`
- `/api/afdian/webhook`

## 9. 权威挂载位置

- Rust 路由总表：`server-rs/src/http/mod.rs`
- Node 基线：`server/src/bootstrap/registerRoutes.ts`
- 客户端消费面：`client/src/services/api/*.ts`

## 10. 验收要求

- Rust 路由前缀不得少于 Node 基线。
- 已有客户端消费的路径、参数名、响应字段名、错误语义不得漂移。
- 变更后优先运行：
  - `cargo check`
  - `cargo test http::routes::tests:: -- --ignored --nocapture`（按 phase 7 gate 分批）
