/**
 * tower 运行时恢复索引。
 *
 * 作用：
 * 1. 做什么：定义 Node `online-battle:tower:*` 与 `online-battle:tower-runtime:*` 的 Rust 读取结构，并在 startup 后构建只读索引。
 * 2. 做什么：把塔进度投影与塔战斗运行时拆成独立 registry，供后续 `/api/tower`、战斗结算与重连恢复共用，避免各模块重复扫描 recovery snapshot。
 * 3. 不做什么：不在这里生成楼层怪物、不推进千层塔战斗，也不直接改写 Redis。
 *
 * 输入 / 输出：
 * - 输入：`RuntimeRecoverySnapshot` 中恢复出的 tower 进度投影与 tower runtime 投影。
 * - 输出：按 `characterId`、`battleId` 建好的 `TowerRuntimeRegistry`，以及可直接反序列化 Redis JSON 的强类型结构。
 *
 * 数据流 / 状态流：
 * - Redis tower key/index -> `projection/service` 归组 -> 本模块建索引 -> `RuntimeServicesState` 暴露给后续业务读取。
 *
 * 复用设计说明：
 * - tower 进度和 tower runtime 都是后续 `/api/tower/overview`、`/api/tower/challenge/start`、战后结算的共同输入，把索引集中后可以避免每条链路各自维护 `characterId -> progress` 和 `battleId -> runtime` 两套查找逻辑。
 * - `preview` 字段是 tower 对外展示与恢复重建最稳定的公共数据，本模块集中定义后，后续 HTTP 与 battle 模块可直接复用同一份结构，减少字段漂移。
 *
 * 关键边界条件与坑点：
 * 1. tower runtime 的 `monsters` 当前保留原始 JSON 数组；恢复层只负责保真读取，不能在这里猜测或裁剪怪物字段。
 * 2. 同一 `characterId` 或 `battleId` 若 Redis 中残留重复记录，索引只保留最后一次恢复到的实体；上层若需要冲突诊断，应在更高层显式处理。
 */
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::runtime::projection::service::RuntimeRecoverySnapshot;
use crate::shared::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TowerProgressProjectionRedis {
    pub character_id: i64,
    pub best_floor: i64,
    pub next_floor: i64,
    pub current_run_id: Option<String>,
    pub current_floor: Option<i64>,
    pub current_battle_id: Option<String>,
    pub last_settled_floor: i64,
    pub updated_at: String,
    pub reached_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TowerFloorPreviewRedis {
    pub floor: i64,
    pub kind: String,
    pub seed: String,
    pub realm: String,
    pub monster_ids: Vec<String>,
    pub monster_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TowerBattleRuntimeProjectionRedis {
    pub battle_id: String,
    pub character_id: i64,
    pub user_id: i64,
    pub run_id: String,
    pub floor: i64,
    pub monsters: Vec<Value>,
    pub preview: TowerFloorPreviewRedis,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TowerRuntimeRegistry {
    progress_by_character_id: BTreeMap<i64, TowerProgressProjectionRedis>,
    runtime_by_battle_id: BTreeMap<String, TowerBattleRuntimeProjectionRedis>,
}

impl TowerRuntimeRegistry {
    pub fn len_progressions(&self) -> usize {
        self.progress_by_character_id.len()
    }

    pub fn len_runtimes(&self) -> usize {
        self.runtime_by_battle_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.progress_by_character_id.is_empty() && self.runtime_by_battle_id.is_empty()
    }

    pub fn get_progress(&self, character_id: i64) -> Option<&TowerProgressProjectionRedis> {
        self.progress_by_character_id.get(&character_id)
    }

    pub fn get_runtime(&self, battle_id: &str) -> Option<&TowerBattleRuntimeProjectionRedis> {
        self.runtime_by_battle_id.get(battle_id)
    }

    pub fn progress_character_ids(&self) -> Vec<i64> {
        self.progress_by_character_id.keys().copied().collect()
    }

    pub fn runtime_battle_ids(&self) -> Vec<String> {
        self.runtime_by_battle_id.keys().cloned().collect()
    }

    fn insert_progress(&mut self, progress: TowerProgressProjectionRedis) {
        self.progress_by_character_id
            .insert(progress.character_id, progress);
    }

    fn insert_runtime(&mut self, runtime: TowerBattleRuntimeProjectionRedis) {
        self.runtime_by_battle_id
            .insert(runtime.battle_id.clone(), runtime);
    }
}

pub fn build_tower_runtime_registry_from_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<TowerRuntimeRegistry, AppError> {
    let mut registry = TowerRuntimeRegistry::default();

    for progress in &snapshot.online_projection.tower_progressions {
        registry.insert_progress(progress.clone());
    }

    for runtime in &snapshot.online_projection.tower_runtime_projections {
        registry.insert_runtime(runtime.clone());
    }

    Ok(registry)
}
