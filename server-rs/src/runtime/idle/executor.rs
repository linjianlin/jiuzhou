/**
 * 挂机运行时服务最小骨架。
 *
 * 作用：
 * 1. 做什么：把 recovery 的 idle lock 状态装配为可查询的运行时服务，并附带最小状态 payload builder。
 * 2. 做什么：为后续真实执行层保留 `lock registry + status buffer` 双入口，但当前仅恢复已存在锁事实。
 * 3. 不做什么：不启动 worker、不推进挂机批次，也不从锁 token 反推数据库 session。
 *
 * 输入 / 输出：
 * - 输入：`RuntimeRecoverySnapshot` 中的 `idle_locks`。
 * - 输出：`IdleRuntimeService` 与 `IdleLockStatusPayload`。
 *
 * 数据流 / 状态流：
 * - recovery kernel -> IdleLockRegistry -> IdleRuntimeStatusBuffer -> startup / socket / 后续执行层读取。
 *
 * 复用设计说明：
 * - 当前 idle 恢复只有锁状态，未来若执行层补上 session/批次信息，仍可沿用同一个服务壳，不必重写启动装配入口。
 * - payload 只暴露锁 token 原文和 kind，保持与 Redis 字符串协议一致，避免在多个调用方发明不同的“挂机状态”字段。
 *
 * 关键边界条件与坑点：
 * 1. `idle:lock:{characterId}` 只能证明角色当前被挂机运行态占用，不能证明具体 sessionId 或执行进度。
 * 2. 恢复服务允许空注册表；这表示当前没有可恢复的 idle lock，而不是错误。
 */
use serde::{Deserialize, Serialize};

use crate::runtime::projection::service::RuntimeRecoverySnapshot;
use crate::shared::error::AppError;

use super::buffer::IdleRuntimeStatusBuffer;
use super::lock::{IdleLockRegistry, IdleLockToken, IdleRuntimeLockState};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleLockStatusPayload {
    pub character_id: i64,
    pub lock_token_kind: String,
    pub lock_token: String,
    pub authoritative: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdleRuntimeService {
    lock_registry: IdleLockRegistry,
    status_buffer: IdleRuntimeStatusBuffer,
}

impl IdleRuntimeService {
    pub fn lock_registry(&self) -> &IdleLockRegistry {
        &self.lock_registry
    }

    pub fn status_buffer(&self) -> &IdleRuntimeStatusBuffer {
        &self.status_buffer
    }

    pub fn is_character_locked(&self, character_id: i64) -> bool {
        self.lock_registry.is_character_locked(character_id)
    }

    pub fn locked_character_ids(&self) -> Vec<i64> {
        self.lock_registry.locked_character_ids()
    }

    pub fn upsert_lock(&mut self, character_id: i64, lock_token: &str) -> Result<(), AppError> {
        let token = IdleLockToken::from_owned(lock_token.to_string())?;
        let lock = IdleRuntimeLockState {
            character_id,
            token,
        };
        self.lock_registry.upsert(lock.clone());
        self.status_buffer
            .insert(build_idle_lock_status_payload(&lock, true));
        Ok(())
    }

    pub fn remove_lock(&mut self, character_id: i64) {
        self.lock_registry.remove(character_id);
        self.status_buffer.remove(character_id);
    }
}

pub fn build_idle_runtime_service_from_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<IdleRuntimeService, AppError> {
    let lock_registry = IdleLockRegistry::from_recovered(&snapshot.idle_locks);
    let status_buffer = IdleRuntimeStatusBuffer::from_lock_registry(&lock_registry);
    Ok(IdleRuntimeService {
        lock_registry,
        status_buffer,
    })
}

pub fn build_idle_lock_status_payload(
    lock: &IdleRuntimeLockState,
    authoritative: bool,
) -> IdleLockStatusPayload {
    IdleLockStatusPayload {
        character_id: lock.character_id,
        lock_token_kind: lock.token.kind().to_string(),
        lock_token: lock.token.as_str().to_string(),
        authoritative,
    }
}
