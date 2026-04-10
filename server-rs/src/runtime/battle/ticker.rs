/**
 * battle ticker 最小快照适配层。
 *
 * 作用：
 * 1. 做什么：为后续实时 tick 推送预留统一入口，当前仅复用 realtime builder 生成 battle_state payload。
 * 2. 做什么：让未来 ticker 接线可以直接消费 registry 里的 `BattleRuntime`，而不重复声明 payload 规则。
 * 3. 不做什么：不启动定时器、不推进回合，也不做并发锁管理。
 *
 * 输入 / 输出：
 * - 输入：`BattleRuntime`。
 * - 输出：最小 `BattleRealtimePayload`。
 *
 * 数据流 / 状态流：
 * - runtime registry -> ticker 适配层 -> realtime payload
 *
 * 复用设计说明：
 * - ticker 与 battle:sync 目前共享同一份 battle_state framing，单独保留模块可避免下一任务把 socket 逻辑塞回 registry。
 * - 高变化点在 future tick delta 策略，因此先把入口稳定下来，后续只替换内部 builder 参数。
 *
 * 关键边界条件与坑点：
 * 1. 当前返回的是完整状态快照，不代表已经实现真正的 tick 增量。
 * 2. 这里不维护日志正文；如果未来需要日志 delta，必须由 engine/ticker 生成后再传入 builder。
 */
use crate::domain::battle::types::{BattleRealtimePayload, BattleRuntime};

use super::realtime::build_battle_update_payload;

pub fn build_ticker_payload(runtime: &BattleRuntime, authoritative: bool) -> BattleRealtimePayload {
    build_battle_update_payload(runtime, authoritative, false)
}
