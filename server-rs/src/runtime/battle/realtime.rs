/**
 * 战斗 realtime payload builder。
 *
 * 作用：
 * 1. 做什么：把 `BattleRuntime` 转成 battle:sync / battle:update 可直接消费的最小 payload。
 * 2. 做什么：统一处理 `kind/logStart/logDelta/unitsDelta/session` 等 framing，避免后续 socket 接线重复拼装。
 * 3. 不做什么：不发送 socket，不维护日志流，也不执行 battle state 增量计算。
 *
 * 输入 / 输出：
 * - 输入：`BattleRuntime` 与少量 payload framing 选项。
 * - 输出：`BattleRealtimePayload`。
 *
 * 数据流 / 状态流：
 * - BattleRuntime -> 本模块合成 state snapshot + 顶层 metadata -> battle:update / battle:sync
 *
 * 复用设计说明：
 * - sync、ticker、settlement 都需要同一份最小 payload 结构，只是 kind 与 delta 标记不同；集中在这里可保证客户端口径稳定。
 * - `logCursor` 是恢复后唯一可信的日志位点，因此 builder 统一输出 cursor snapshot，避免各调用方自造日志语义。
 *
 * 关键边界条件与坑点：
 * 1. 当前 recovery 只恢复 log cursor，不恢复日志正文，所以这里必须始终输出空 logs + cursor，而不是伪造历史日志。
 * 2. `unitsDelta` 只是 framing 标记；当前最小骨架默认发完整状态快照，不偷做半成品 delta。
 */
use serde_json::Value;

use crate::domain::battle::types::{
    build_realtime_state, extract_result_text, BattleRealtimeKind, BattleRealtimePayload,
    BattleRuntime,
};

pub fn build_battle_sync_payload(
    runtime: &BattleRuntime,
    authoritative: bool,
) -> BattleRealtimePayload {
    build_battle_realtime_payload(
        runtime,
        BattleRealtimeKind::BattleState,
        authoritative,
        false,
    )
}

pub fn build_battle_update_payload(
    runtime: &BattleRuntime,
    authoritative: bool,
    units_delta: bool,
) -> BattleRealtimePayload {
    build_battle_realtime_payload(
        runtime,
        BattleRealtimeKind::BattleState,
        authoritative,
        units_delta,
    )
}

pub fn build_battle_finished_payload(
    runtime: &BattleRuntime,
    authoritative: bool,
) -> BattleRealtimePayload {
    build_battle_realtime_payload(
        runtime,
        BattleRealtimeKind::BattleFinished,
        authoritative,
        false,
    )
}

fn build_battle_realtime_payload(
    runtime: &BattleRuntime,
    kind: BattleRealtimeKind,
    authoritative: bool,
    units_delta: bool,
) -> BattleRealtimePayload {
    BattleRealtimePayload {
        kind,
        battle_id: runtime.identity.battle_id.clone(),
        state: build_realtime_state(runtime),
        logs: Vec::<Value>::new(),
        log_start: runtime.dynamic_state.log_cursor,
        log_delta: true,
        units_delta,
        session: runtime.session.clone(),
        rewards: runtime.dynamic_state.rewards.clone(),
        result: extract_result_text(&runtime.dynamic_state.result),
        authoritative,
    }
}
