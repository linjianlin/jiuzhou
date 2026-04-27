# Rust 后端恢复链与后台任务基线样本

本文档补齐 `RUST_BACKEND_REWRITE_PLAN.md` 阶段 0 中“后台任务与恢复链路清单 / 关键恢复链路状态字段样本”。

## 1. startup 恢复顺序样本

Rust 当前 startup 总线位于：`server-rs/src/bootstrap/startup.rs`

关键恢复/预热顺序：

1. 数据库与 Redis 探活
2. generated content refresh / item data cleanup / avatar cleanup / index sync
3. dungeon / idle / battle / mail 等 cleanup
4. frozen tower pool warmup
5. persisted battle recovery / orphan battle session recovery
6. online battle projection warmup
7. JobRuntime 初始化（idle / battle / afdian / settlement / snapshot / AI jobs）
8. game time runtime 初始化

## 2. 关键恢复状态字段样本

### 2.1 battle session

- `sessionId`
- `ownerUserId`
- `participantUserIds`
- `currentBattleId`
- `status`
- `nextAction`
- `canAdvance`
- `lastResult`
- `context`

### 2.2 online battle projection

- `battleId`
- `ownerUserId`
- `participantUserIds`
- `type`
- `sessionId`

### 2.3 idle session

- `session_snapshot`
- `bag_full_flag`
- `executionSnapshot.monsterIds`
- `executionSnapshot.resolvedSkillId`
- `executionSnapshot.partnerMember`

## 3. 当前后台任务 family

- idle recover / reconcile
- battle/session recovery
- online battle settlement
- afdian retry
- arena weekly settlement
- rank snapshot refresh
- idle history cleanup
- mail history cleanup
- battle expired cleanup
- dungeon expired cleanup
- partner recruit / fusion / rebone jobs
- technique generation jobs
- wander generation jobs
- progress / item grant / item mutation / resource delta flush

## 4. 样本来源

- `server-rs/src/bootstrap/startup.rs`
- `server-rs/src/bootstrap/shutdown.rs`
- `server-rs/src/jobs/mod.rs`
- `server-rs/src/state.rs`
