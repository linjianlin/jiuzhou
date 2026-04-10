/**
 * BattleSession 运行时注册表。
 *
 * 作用：
 * 1. 做什么：把 recovery snapshot 中的 battle session 投影组装成 `sessionId -> snapshot` 与 `battleId -> sessionId` 两层索引。
 * 2. 做什么：提供后续 startup / socket 层可直接复用的最小状态载荷 framing。
 * 3. 不做什么：不推进 session 状态、不回写 Redis，也不解释 `context` 内部业务细节。
 *
 * 输入 / 输出：
 * - 输入：`RuntimeRecoverySnapshot` 中 battle session 与 online projection 已恢复的 session 数据。
 * - 输出：`BattleSessionRuntimeRegistry` 与可序列化的 `BattleSessionStatusPayload`。
 *
 * 数据流 / 状态流：
 * - recovery kernel -> 本模块按 session/battle 建索引 -> startup 与 socket 查询最小状态快照。
 *
 * 复用设计说明：
 * - session recovery 与 battle runtime 都需要通过 battleId 找 session；把索引集中在这里可避免 battle/socket 重复扫描全部 session。
 * - status payload 只包一层 `session + authoritative`，后续 push 接线可直接复用，不需要各调用方再手拼顶层字段。
 *
 * 关键边界条件与坑点：
 * 1. `currentBattleId` 允许为空；这类 session 只进入 `sessionId` 索引，不会被强行挂到 battleId 索引。
 * 2. 若 Redis 同时存在 `currentBattleId` 与 `session-battle` 链接，本模块只接受“能落到已恢复 session 上”的 battle 映射，不猜测缺失 session。
 */
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::runtime::projection::service::RuntimeRecoverySnapshot;
use crate::runtime::session::projection::OnlineBattleSessionSnapshotRedis;
use crate::shared::error::AppError;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BattleSessionRuntimeRegistry {
    sessions: BTreeMap<String, OnlineBattleSessionSnapshotRedis>,
    session_id_by_battle_id: BTreeMap<String, String>,
    session_ids_by_user_id: BTreeMap<i64, Vec<String>>,
    active_session_id_by_user_id: BTreeMap<i64, String>,
}

impl BattleSessionRuntimeRegistry {
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    pub fn get(&self, session_id: &str) -> Option<&OnlineBattleSessionSnapshotRedis> {
        self.sessions.get(session_id)
    }

    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    pub fn find_session_id_by_battle_id(&self, battle_id: &str) -> Option<&str> {
        self.session_id_by_battle_id
            .get(battle_id)
            .map(String::as_str)
    }

    pub fn find_session_by_battle_id(
        &self,
        battle_id: &str,
    ) -> Option<&OnlineBattleSessionSnapshotRedis> {
        self.find_session_id_by_battle_id(battle_id)
            .and_then(|session_id| self.get(session_id))
    }

    pub fn find_session_ids_by_user_id(&self, user_id: i64) -> Vec<String> {
        self.session_ids_by_user_id
            .get(&user_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn find_active_session_id_by_user_id(&self, user_id: i64) -> Option<&str> {
        self.active_session_id_by_user_id
            .get(&user_id)
            .map(String::as_str)
    }

    pub fn find_active_session_by_user_id(
        &self,
        user_id: i64,
    ) -> Option<&OnlineBattleSessionSnapshotRedis> {
        self.find_active_session_id_by_user_id(user_id)
            .and_then(|session_id| self.get(session_id))
    }

    fn insert(&mut self, session: OnlineBattleSessionSnapshotRedis) {
        let user_ids = session.user_ids();
        if let Some(battle_id) = session.current_battle_id.clone() {
            self.session_id_by_battle_id
                .insert(battle_id, session.session_id.clone());
        }
        for user_id in &user_ids {
            self.session_ids_by_user_id
                .entry(*user_id)
                .or_default()
                .push(session.session_id.clone());
        }
        self.update_active_session_indexes(&session, &user_ids);
        self.sessions.insert(session.session_id.clone(), session);
    }

    fn insert_battle_link(&mut self, battle_id: &str, session_id: &str) {
        if self.sessions.contains_key(session_id) {
            self.session_id_by_battle_id
                .insert(battle_id.to_string(), session_id.to_string());
        }
    }

    fn update_active_session_indexes(
        &mut self,
        session: &OnlineBattleSessionSnapshotRedis,
        user_ids: &[i64],
    ) {
        if !is_active_session(session) {
            return;
        }

        for user_id in user_ids {
            let should_replace = self
                .active_session_id_by_user_id
                .get(user_id)
                .and_then(|session_id| self.sessions.get(session_id))
                .map(|current| prefer_newer_active_session(current, session))
                .unwrap_or(true);
            if should_replace {
                self.active_session_id_by_user_id
                    .insert(*user_id, session.session_id.clone());
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleSessionStatusPayload {
    pub session: OnlineBattleSessionSnapshotRedis,
    pub authoritative: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleSessionSnapshotView {
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
    pub context: serde_json::Value,
}

pub fn build_battle_session_registry_from_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<BattleSessionRuntimeRegistry, AppError> {
    let mut registry = BattleSessionRuntimeRegistry::default();

    for session in &snapshot.battle_sessions.projections {
        registry.insert(session.clone());
    }

    for (battle_id, session_id) in &snapshot.online_projection.session_battle_links {
        registry.insert_battle_link(battle_id, session_id);
    }

    Ok(registry)
}

pub fn build_battle_session_status_payload(
    session: &OnlineBattleSessionSnapshotRedis,
    authoritative: bool,
) -> BattleSessionStatusPayload {
    BattleSessionStatusPayload {
        session: session.clone(),
        authoritative,
    }
}

pub fn build_battle_session_snapshot_view(
    session: &OnlineBattleSessionSnapshotRedis,
) -> BattleSessionSnapshotView {
    BattleSessionSnapshotView {
        session_id: session.session_id.clone(),
        session_type: session.session_type.clone(),
        owner_user_id: session.owner_user_id,
        participant_user_ids: session.participant_user_ids.clone(),
        current_battle_id: session.current_battle_id.clone(),
        status: session.status.clone(),
        next_action: session.next_action.clone(),
        can_advance: session.can_advance,
        last_result: session.last_result.clone(),
        context: session.context.clone(),
    }
}

fn is_active_session(session: &OnlineBattleSessionSnapshotRedis) -> bool {
    matches!(session.status.as_str(), "running" | "waiting_transition")
}

fn prefer_newer_active_session(
    current: &OnlineBattleSessionSnapshotRedis,
    candidate: &OnlineBattleSessionSnapshotRedis,
) -> bool {
    candidate.updated_at > current.updated_at
        || (candidate.updated_at == current.updated_at
            && candidate.session_id.as_str() > current.session_id.as_str())
}
