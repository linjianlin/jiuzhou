/**
 * battle settlement 最小快照适配层。
 *
 * 作用：
 * 1. 做什么：为后续战斗结算推送提供统一 finished payload 入口，当前只负责基于现有 runtime 输出终态快照。
 * 2. 做什么：避免未来 settlement 与 reconnect 逻辑各自复制 `battle_finished` payload 字段。
 * 3. 不做什么：不执行奖励结算、不修改状态，也不移除 runtime registry 条目。
 *
 * 输入 / 输出：
 * - 输入：`BattleRuntime`。
 * - 输出：`battle_finished` payload。
 *
 * 数据流 / 状态流：
 * - runtime registry -> settlement 适配层 -> realtime payload
 *
 * 复用设计说明：
 * - 当前 settlement 还未迁移，但 finished payload 口径已经确定，先保留单一出口可减少下一任务重复拼装。
 * - 与 ticker 分模块可避免 future finished-only 字段污染普通 battle_state builder。
 *
 * 关键边界条件与坑点：
 * 1. 当前只会反映 runtime 已有的 `result/rewards`，不会推断缺失结算数据。
 * 2. 未完成 battle 若误调用这里，也只会诚实输出当前 runtime 终态快照结构，不会强行补 finished 业务副作用。
 */
use crate::domain::battle::types::{BattleRealtimePayload, BattleRuntime};

use super::realtime::build_battle_finished_payload;

pub fn build_settlement_payload(
    runtime: &BattleRuntime,
    authoritative: bool,
) -> BattleRealtimePayload {
    build_battle_finished_payload(runtime, authoritative)
}
