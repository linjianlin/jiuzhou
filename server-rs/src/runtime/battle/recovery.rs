/**
 * 战斗域恢复聚合器。
 *
 * 作用：
 * 1. 做什么：从原始 Redis 快照中提取 battle、PVE 续战意图与角色运行时资源，形成按 battle 域分组的恢复结果。
 * 2. 做什么：统一处理 battle 动态/静态/participants 三键拼装，避免上层恢复流程重复写配对逻辑。
 * 3. 不做什么：不创建 BattleEngine，不写回 Redis，也不补齐缺失业务数据。
 *
 * 输入 / 输出：
 * - 输入：`RecoverySourceData` 中的 Redis 原始字符串快照。
 * - 输出：战斗恢复列表、PVE 续战意图列表、角色运行时资源列表。
 *
 * 数据流 / 状态流：
 * - projection/service 先收集 Redis 原始快照 -> 本模块按 battle 前缀过滤并解码 -> 返回恢复就绪结构。
 *
 * 复用设计说明：
 * - battle 恢复和 battle-session 恢复共享 battle 命名空间，把 battle 侧读取收敛在这里，可以减少 projection 层对 battle key 细节的耦合。
 * - 角色运行时资源虽然不属于单场 battle，但和 battle 恢复顺序强关联，放在同一模块能保证下一步 startup 编排时只接一个 battle recovery 入口。
 *
 * 关键边界条件与坑点：
 * 1. 若 battle 缺少静态态或参与者键，本模块会跳过而不是猜测补全，保持恢复内核诚实。
 * 2. 资源键只按 `character:runtime:resource:v1:*` 读取，不能误吞 static attr cache 等其他 character Redis 数据。
 */
use std::collections::{BTreeMap, BTreeSet};

use crate::domain::battle::engine::BattleRuntimeEngine;
use crate::domain::battle::types::BattleRuntime;
use crate::infra::redis::codecs::decode_json;
use crate::runtime::projection::service::RuntimeRecoverySnapshot;
use crate::shared::error::AppError;

use super::persistence::{
    BattleDynamicStateRedis, BattleRedisKey, BattleStaticStateRedis, CharacterRuntimeResourceRedis,
    PveResumeIntentRedis,
};
use crate::runtime::projection::service::RecoverySourceData;
use crate::runtime::session::projection::OnlineBattleSessionSnapshotRedis;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BattleRuntimeRegistry {
    battles: BTreeMap<String, BattleRuntime>,
    battle_id_by_character_id: BTreeMap<i64, String>,
    battle_ids_by_user_id: BTreeMap<i64, BTreeSet<String>>,
}

impl BattleRuntimeRegistry {
    pub fn len(&self) -> usize {
        self.battles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.battles.is_empty()
    }

    pub fn get(&self, battle_id: &str) -> Option<&BattleRuntime> {
        self.battles.get(battle_id)
    }

    pub fn battle_ids(&self) -> Vec<String> {
        self.battles.keys().cloned().collect()
    }

    pub fn find_battle_id_by_character_id(&self, character_id: i64) -> Option<&str> {
        self.battle_id_by_character_id
            .get(&character_id)
            .map(String::as_str)
    }

    pub fn find_battle_ids_by_user_id(&self, user_id: i64) -> Vec<String> {
        self.battle_ids_by_user_id
            .get(&user_id)
            .map(|items| items.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn insert(&mut self, runtime: BattleRuntime) {
        let battle_id = runtime.identity.battle_id.clone();
        for character_id in &runtime.participants.character_ids {
            self.battle_id_by_character_id
                .insert(*character_id, battle_id.clone());
        }
        for user_id in &runtime.participants.user_ids {
            self.battle_ids_by_user_id
                .entry(*user_id)
                .or_default()
                .insert(battle_id.clone());
        }
        self.battles.insert(battle_id, runtime);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecoveredBattleRuntime {
    pub battle_id: String,
    pub dynamic_state: BattleDynamicStateRedis,
    pub static_state: BattleStaticStateRedis,
    pub participants: Vec<i64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoveredBattleSessionState {
    pub pve_resume_intents: Vec<PveResumeIntentRedis>,
    pub projections: Vec<OnlineBattleSessionSnapshotRedis>,
}

pub fn load_battles_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<RecoveredBattleRuntime>, AppError> {
    let mut battles = Vec::new();
    for (key, raw_dynamic) in &source.strings {
        let Some(parsed_key) = BattleRedisKey::parse(key) else {
            continue;
        };
        if !parsed_key.as_ref().starts_with("battle:state:")
            || parsed_key.as_ref().starts_with("battle:state:static:")
        {
            continue;
        }
        let battle_id = parsed_key
            .as_ref()
            .trim_start_matches("battle:state:")
            .to_string();
        let dynamic_state: BattleDynamicStateRedis = decode_json(raw_dynamic)?;
        let static_state_key = BattleRedisKey::static_state(&battle_id).into_string();
        let participants_key = BattleRedisKey::participants(&battle_id).into_string();
        let Some(raw_static) = source.strings.get(&static_state_key) else {
            continue;
        };
        let static_state: BattleStaticStateRedis = decode_json(raw_static)?;
        let participants = source
            .strings
            .get(&participants_key)
            .map(|raw| decode_json::<Vec<i64>>(raw))
            .transpose()?
            .unwrap_or_default();
        battles.push(RecoveredBattleRuntime {
            battle_id,
            dynamic_state,
            static_state,
            participants,
        });
    }
    battles.sort_by(|left, right| left.battle_id.cmp(&right.battle_id));
    Ok(battles)
}

pub fn load_pve_resume_intents_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<PveResumeIntentRedis>, AppError> {
    let mut intents = Vec::new();
    for (key, raw) in &source.strings {
        let Some(parsed_key) = BattleRedisKey::parse(key) else {
            continue;
        };
        if !parsed_key
            .as_ref()
            .starts_with("battle:session:pve-resume:")
        {
            continue;
        }
        intents.push(decode_json(raw)?);
    }
    intents.sort_by_key(|entry: &PveResumeIntentRedis| entry.owner_user_id);
    Ok(intents)
}

pub fn load_runtime_resources_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<(i64, CharacterRuntimeResourceRedis)>, AppError> {
    let mut resources = Vec::new();
    for (key, raw) in &source.strings {
        let Some(parsed_key) = BattleRedisKey::parse(key) else {
            continue;
        };
        if !parsed_key
            .as_ref()
            .starts_with("character:runtime:resource:v1:")
        {
            continue;
        }
        let Some(character_id) = parsed_key
            .as_ref()
            .trim_start_matches("character:runtime:resource:v1:")
            .parse::<i64>()
            .ok()
        else {
            continue;
        };
        resources.push((character_id, decode_json(raw)?));
    }
    resources.sort_by_key(|(character_id, _)| *character_id);
    Ok(resources)
}

pub fn build_battle_runtime_registry_from_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<BattleRuntimeRegistry, AppError> {
    let mut registry = BattleRuntimeRegistry::default();
    for recovered_battle in &snapshot.battles {
        let runtime = BattleRuntimeEngine::assemble(snapshot, &recovered_battle.battle_id)
            .ok_or_else(|| {
                AppError::Config(format!(
                    "missing recovered battle runtime while assembling registry: {}",
                    recovered_battle.battle_id
                ))
            })?;
        registry.insert(runtime);
    }
    Ok(registry)
}
