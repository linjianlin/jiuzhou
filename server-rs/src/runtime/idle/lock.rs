/**
 * 挂机互斥锁恢复契约。
 *
 * 作用：
 * 1. 做什么：声明 `idle:lock:{characterId}` 的 key codec 与 `idle-start:{uuid}` 字符串 token 解析规则。
 * 2. 做什么：从恢复快照里提取当前仍持有的挂机锁，为后续 idle 恢复顺序提供只读输入。
 * 3. 不做什么：不延长 TTL、不 compare-and-del，也不把字符串锁包装成新 JSON 格式。
 *
 * 输入 / 输出：
 * - 输入：idle lock Redis key 与纯字符串 token。
 * - 输出：`RecoveredIdleLockState` 列表。
 *
 * 数据流 / 状态流：
 * - Redis idle lock 字符串 -> 本模块解析 -> recovery kernel 归组到 idle 子系统。
 *
 * 复用设计说明：
 * - idle 锁是当前兼容矩阵里唯一明确要求保留字符串语义的运行时状态，把解析逻辑集中在这里可避免后续 idle 恢复或启动互斥重复手写前缀判断。
 * - token 只暴露最小 `kind/as_str` 视图，足够恢复层判断协议，又不会误导后续业务把它当结构化 JSON 继续扩展。
 *
 * 关键边界条件与坑点：
 * 1. 只有 `idle-start:` 前缀被视为有效 token，其他字符串必须保持无效而不是猜测兼容。
 * 2. 锁 value 是权威纯字符串，绝不能在恢复层自动 JSON decode。
 */
use crate::runtime::projection::service::RecoverySourceData;
use crate::shared::error::AppError;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IdleLockRedisKey(String);

impl IdleLockRedisKey {
    const PREFIX: &'static str = "idle:lock:";

    pub fn new(character_id: i64) -> Self {
        Self(format!("{}{character_id}", Self::PREFIX))
    }

    pub fn as_ref(&self) -> &str {
        self.0.as_str()
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for IdleLockRedisKey {
    fn as_ref(&self) -> &str {
        self.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleLockToken(String);

impl IdleLockToken {
    pub fn parse(raw: &str) -> Option<Self> {
        if raw.starts_with("idle-start:") && raw.len() > "idle-start:".len() {
            return Some(Self(raw.to_string()));
        }
        None
    }

    pub fn kind(&self) -> &str {
        self.0.split(':').next().unwrap_or_default()
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    pub fn from_owned(raw: String) -> Result<Self, AppError> {
        Self::parse(&raw).ok_or_else(|| AppError::Config("invalid idle lock token".to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveredIdleLockState {
    pub character_id: i64,
    pub token: IdleLockToken,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleRuntimeLockState {
    pub character_id: i64,
    pub token: IdleLockToken,
}

impl From<&RecoveredIdleLockState> for IdleRuntimeLockState {
    fn from(value: &RecoveredIdleLockState) -> Self {
        Self {
            character_id: value.character_id,
            token: value.token.clone(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdleLockRegistry {
    locks_by_character_id: BTreeMap<i64, IdleRuntimeLockState>,
}

impl IdleLockRegistry {
    pub fn from_recovered(recovered: &[RecoveredIdleLockState]) -> Self {
        let mut registry = Self::default();
        for lock in recovered {
            registry
                .locks_by_character_id
                .insert(lock.character_id, IdleRuntimeLockState::from(lock));
        }
        registry
    }

    pub fn get(&self, character_id: i64) -> Option<&IdleRuntimeLockState> {
        self.locks_by_character_id.get(&character_id)
    }

    pub fn is_character_locked(&self, character_id: i64) -> bool {
        self.locks_by_character_id.contains_key(&character_id)
    }

    pub fn locked_character_ids(&self) -> Vec<i64> {
        self.locks_by_character_id.keys().copied().collect()
    }

    pub fn upsert(&mut self, state: IdleRuntimeLockState) {
        self.locks_by_character_id.insert(state.character_id, state);
    }

    pub fn remove(&mut self, character_id: i64) {
        self.locks_by_character_id.remove(&character_id);
    }
}

pub fn load_idle_locks_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<RecoveredIdleLockState>, AppError> {
    let mut idle_locks = Vec::new();
    for (key, raw) in &source.strings {
        if !key.starts_with(IdleLockRedisKey::PREFIX) {
            continue;
        }
        let Some(character_id) = key
            .trim_start_matches(IdleLockRedisKey::PREFIX)
            .parse::<i64>()
            .ok()
        else {
            continue;
        };
        let Some(token) = IdleLockToken::parse(raw) else {
            continue;
        };
        idle_locks.push(RecoveredIdleLockState {
            character_id,
            token,
        });
    }
    idle_locks.sort_by_key(|entry| entry.character_id);
    Ok(idle_locks)
}
