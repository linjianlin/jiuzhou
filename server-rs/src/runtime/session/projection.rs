/**
 * BattleSession 投影恢复契约。
 *
 * 作用：
 * 1. 做什么：定义 online-battle session projection 的 Rust 读取结构，并按 session index 批量恢复当前会话快照。
 * 2. 做什么：保证 `sessionId/type/ownerUserId/.../context` 等顶层字段与 Node Redis 合约一致。
 * 3. 不做什么：不维护 battleId -> sessionId 内存索引，也不解释 context 内部业务含义。
 *
 * 输入 / 输出：
 * - 输入：session index 集合与 session JSON 文本。
 * - 输出：按 index 顺序读取出的 `OnlineBattleSessionSnapshotRedis` 列表。
 *
 * 数据流 / 状态流：
 * - Redis `online-battle:index:sessions` -> session key -> 本模块解码 -> recovery kernel 归组到 battle session 子系统。
 *
 * 复用设计说明：
 * - startup 恢复和后续按需懒回填都要读同一份 session 投影，把读取逻辑集中在这里可避免 battle/session 各自复制 index + key 拼装。
 * - `context` 是高频变化点，但顶层字段稳定；因此只在顶层强类型，内部上下文保持透明 JSON 值以降低无关耦合。
 *
 * 关键边界条件与坑点：
 * 1. Redis session index 可能残留空洞 sessionId；读取缺失实体时必须跳过。
 * 2. `currentBattleId` 允许为空，恢复层不能因为缺 battle 绑定就把整条 session 判坏。
 */
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::infra::redis::codecs::decode_json;
use crate::runtime::projection::service::{
    OnlineProjectionIndexKey, OnlineProjectionRedisKey, RecoverySourceData,
};
use crate::shared::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBattleSessionSnapshotRedis {
    pub session_id: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub owner_user_id: i64,
    pub participant_user_ids: Vec<i64>,
    pub current_battle_id: Option<String>,
    pub status: String,
    pub next_action: String,
    pub can_advance: bool,
    pub last_result: Option<String>,
    pub context: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

impl OnlineBattleSessionSnapshotRedis {
    pub fn user_ids(&self) -> Vec<i64> {
        let mut user_ids = BTreeSet::from([self.owner_user_id]);
        user_ids.extend(self.participant_user_ids.iter().copied());
        user_ids.into_iter().collect()
    }
}

pub fn load_session_projections_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<OnlineBattleSessionSnapshotRedis>, AppError> {
    let mut session_ids = source
        .sets
        .get(OnlineProjectionIndexKey::sessions().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    session_ids.sort();

    let mut sessions = Vec::with_capacity(session_ids.len());
    for session_id in session_ids {
        let key = OnlineProjectionRedisKey::session(&session_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        sessions.push(decode_json(raw)?);
    }
    Ok(sessions)
}
