/**
 * 挂机运行时状态缓冲。
 *
 * 作用：
 * 1. 做什么：缓存 recovery 后当前可直接对外暴露的挂机锁状态快照，给后续 socket / 执行器层提供只读入口。
 * 2. 做什么：把 `characterId -> latest status payload` 收敛为显式索引，避免恢复后每次推送都重新遍历锁注册表。
 * 3. 不做什么：不做批次执行、不累积战斗收益，也不代表真实数据库中的 idle session 行状态。
 *
 * 输入 / 输出：
 * - 输入：`IdleLockRegistry` 或单条 `IdleLockStatusPayload`。
 * - 输出：按 `characterId` 查询的最新挂机锁状态快照。
 *
 * 数据流 / 状态流：
 * - idle lock registry -> 本缓冲生成最小状态视图 -> 后续 socket / executor 直接读取。
 *
 * 复用设计说明：
 * - 现在只有恢复时的锁状态，未来执行层增量更新时仍可沿用同一缓存结构，不需要再引入第二份按 characterId 的状态表。
 * - payload 构建和缓冲写入拆开后，既能给测试断言最小 framing，也能让恢复层保持纯组装职责。
 *
 * 关键边界条件与坑点：
 * 1. 当前缓冲只反映锁事实，不推断 active/stopping/completed 等 session 生命周期。
 * 2. 若同一 characterId 后续收到新状态，调用方应显式覆盖旧值；本模块不做时间戳仲裁。
 */
use std::collections::BTreeMap;

use super::executor::IdleLockStatusPayload;
use super::lock::IdleLockRegistry;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdleRuntimeStatusBuffer {
    status_by_character_id: BTreeMap<i64, IdleLockStatusPayload>,
}

impl IdleRuntimeStatusBuffer {
    pub fn from_lock_registry(registry: &IdleLockRegistry) -> Self {
        let mut buffer = Self::default();
        for character_id in registry.locked_character_ids() {
            if let Some(lock) = registry.get(character_id) {
                buffer.insert(super::executor::build_idle_lock_status_payload(lock, true));
            }
        }
        buffer
    }

    pub fn get(&self, character_id: i64) -> Option<&IdleLockStatusPayload> {
        self.status_by_character_id.get(&character_id)
    }

    pub fn insert(&mut self, payload: IdleLockStatusPayload) {
        self.status_by_character_id
            .insert(payload.character_id, payload);
    }

    pub fn remove(&mut self, character_id: i64) {
        self.status_by_character_id.remove(&character_id);
    }
}
