/**
 * 在线投影恢复服务。
 *
 * 作用：
 * 1. 做什么：定义 online-battle key/index codec，并把 battle/session/online projection/tower/idle lock 原始 Redis 数据统一收集成恢复快照。
 * 2. 做什么：提供 `load_from_source` 纯装载入口与 `load_from_redis` 真实读取入口，方便测试与启动阶段共用同一套恢复编排。
 * 3. 不做什么：不执行业务预热、不落内存运行态索引，也不修改 Redis 内容。
 *
 * 输入 / 输出：
 * - 输入：真实 `AppRedis` 客户端，或测试用 `RecoverySourceData`。
 * - 输出：按 subsystem 分组的 `RuntimeRecoverySnapshot`。
 *
 * 数据流 / 状态流：
 * - AppRedis 扫描 battle/projection/idle 相关 key 与 set index -> `RecoverySourceData`
 * - `RecoverySourceData` -> 各子模块 typed decode -> `RuntimeRecoverySnapshot`
 * - 下一阶段 startup 只需要消费已分组的恢复结果。
 *
 * 复用设计说明：
 * - key/index codec 与 recovery orchestration 都围绕 online projection 命名空间展开，集中在这里能让 battle/session/tower/idle 子模块只关心各自 payload，不必重复持有全局 Redis 扫描逻辑。
 * - 纯数据源 `RecoverySourceData` 让测试与真实 Redis 读取共享同一条装载路径，避免写两套恢复实现。
 *
 * 关键边界条件与坑点：
 * 1. 这里使用 `KEYS` 仅限启动恢复最小内核，后续若恢复规模扩大再演进为 scan；当前不能擅自改变 Redis 合约。
 * 2. `online-battle:*` 里混有 JSON 与纯字符串链接键，读取时必须按具体 key 类型区分，不能统一当 JSON 解析。
 */
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::infra::redis::client::AppRedis;
use crate::infra::redis::codecs::decode_json;
use crate::runtime::battle::recovery::{
    load_battles_from_source, load_pve_resume_intents_from_source,
    load_runtime_resources_from_source, RecoveredBattleRuntime, RecoveredBattleSessionState,
};
use crate::runtime::idle::lock::{load_idle_locks_from_source, RecoveredIdleLockState};
use crate::runtime::session::projection::{
    load_session_projections_from_source, OnlineBattleSessionSnapshotRedis,
};
use crate::runtime::tower::{TowerBattleRuntimeProjectionRedis, TowerProgressProjectionRedis};
use crate::shared::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OnlineProjectionRedisKey(String);

impl OnlineProjectionRedisKey {
    const CHARACTER_PREFIX: &'static str = "online-battle:character:";
    const USER_CHARACTER_PREFIX: &'static str = "online-battle:user-character:";
    const TEAM_MEMBER_PREFIX: &'static str = "online-battle:team-member:";
    const SESSION_PREFIX: &'static str = "online-battle:session:";
    const SESSION_BATTLE_PREFIX: &'static str = "online-battle:session-battle:";
    const ARENA_PREFIX: &'static str = "online-battle:arena:";
    const DUNGEON_PREFIX: &'static str = "online-battle:dungeon:";
    const DUNGEON_BATTLE_PREFIX: &'static str = "online-battle:dungeon-battle:";
    const DUNGEON_ENTRY_PREFIX: &'static str = "online-battle:dungeon-entry:";
    const TOWER_PREFIX: &'static str = "online-battle:tower:";
    const TOWER_RUNTIME_PREFIX: &'static str = "online-battle:tower-runtime:";
    const SETTLEMENT_TASK_PREFIX: &'static str = "online-battle:settlement-task:";

    pub fn character(character_id: i64) -> Self {
        Self(format!("{}{character_id}", Self::CHARACTER_PREFIX))
    }

    pub fn user_character(user_id: i64) -> Self {
        Self(format!("{}{user_id}", Self::USER_CHARACTER_PREFIX))
    }

    pub fn team_member(user_id: i64) -> Self {
        Self(format!("{}{user_id}", Self::TEAM_MEMBER_PREFIX))
    }

    pub fn session(session_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{session_id}",
            Self::SESSION_PREFIX,
            session_id = session_id.as_ref()
        ))
    }

    pub fn session_battle(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::SESSION_BATTLE_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn arena(character_id: i64) -> Self {
        Self(format!("{}{character_id}", Self::ARENA_PREFIX))
    }

    pub fn dungeon(instance_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{instance_id}",
            Self::DUNGEON_PREFIX,
            instance_id = instance_id.as_ref()
        ))
    }

    pub fn dungeon_battle(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::DUNGEON_BATTLE_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn dungeon_entry(character_id: i64, dungeon_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{character_id}:{dungeon_id}",
            Self::DUNGEON_ENTRY_PREFIX,
            dungeon_id = dungeon_id.as_ref()
        ))
    }

    pub fn tower(character_id: i64) -> Self {
        Self(format!("{}{character_id}", Self::TOWER_PREFIX))
    }

    pub fn tower_runtime(battle_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{battle_id}",
            Self::TOWER_RUNTIME_PREFIX,
            battle_id = battle_id.as_ref()
        ))
    }

    pub fn settlement_task(task_id: impl AsRef<str>) -> Self {
        Self(format!(
            "{}{task_id}",
            Self::SETTLEMENT_TASK_PREFIX,
            task_id = task_id.as_ref()
        ))
    }

    pub fn as_ref(&self) -> &str {
        self.0.as_str()
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for OnlineProjectionRedisKey {
    fn as_ref(&self) -> &str {
        self.as_ref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OnlineProjectionIndexKey(String);

impl OnlineProjectionIndexKey {
    pub fn characters() -> Self {
        Self("online-battle:index:characters".to_string())
    }

    pub fn users() -> Self {
        Self("online-battle:index:users".to_string())
    }

    pub fn sessions() -> Self {
        Self("online-battle:index:sessions".to_string())
    }

    pub fn arena() -> Self {
        Self("online-battle:index:arena".to_string())
    }

    pub fn dungeons() -> Self {
        Self("online-battle:index:dungeons".to_string())
    }

    pub fn dungeon_entries() -> Self {
        Self("online-battle:index:dungeon-entries".to_string())
    }

    pub fn towers() -> Self {
        Self("online-battle:index:towers".to_string())
    }

    pub fn tower_runtimes() -> Self {
        Self("online-battle:index:tower-runtimes".to_string())
    }

    pub fn settlement_tasks() -> Self {
        Self("online-battle:index:settlement-tasks".to_string())
    }

    pub fn as_ref(&self) -> &str {
        self.0.as_str()
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl AsRef<str> for OnlineProjectionIndexKey {
    fn as_ref(&self) -> &str {
        self.as_ref()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBattleCharacterSnapshotRedis {
    pub character_id: i64,
    pub user_id: i64,
    pub computed: Value,
    pub loadout: Value,
    pub active_partner: Option<Value>,
    pub team_id: Option<String>,
    pub is_team_leader: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberProjectionRedis {
    pub team_id: Option<String>,
    pub role: Option<String>,
    pub member_character_ids: Vec<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoverySourceData {
    pub strings: BTreeMap<String, String>,
    pub sets: BTreeMap<String, BTreeSet<String>>,
}

impl RecoverySourceData {
    pub fn with_string(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.strings.insert(key.into(), value.into());
        self
    }

    pub fn with_set<I, S>(mut self, key: impl Into<String>, values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.sets.insert(
            key.into(),
            values
                .into_iter()
                .map(|value| value.as_ref().to_string())
                .collect(),
        );
        self
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OnlineProjectionRecoveryState {
    pub character_snapshots: Vec<OnlineBattleCharacterSnapshotRedis>,
    pub user_character_links: Vec<(i64, i64)>,
    pub team_members: Vec<(i64, TeamMemberProjectionRedis)>,
    pub session_battle_links: Vec<(String, String)>,
    pub session_projections: Vec<OnlineBattleSessionSnapshotRedis>,
    pub tower_progressions: Vec<TowerProgressProjectionRedis>,
    pub tower_runtime_projections: Vec<TowerBattleRuntimeProjectionRedis>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RuntimeRecoverySnapshot {
    pub battles: Vec<RecoveredBattleRuntime>,
    pub battle_sessions: RecoveredBattleSessionState,
    pub online_projection: OnlineProjectionRecoveryState,
    pub runtime_resources: Vec<(
        i64,
        crate::runtime::battle::persistence::CharacterRuntimeResourceRedis,
    )>,
    pub idle_locks: Vec<RecoveredIdleLockState>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct OnlineProjectionRegistry {
    character_snapshots: BTreeMap<i64, OnlineBattleCharacterSnapshotRedis>,
    character_id_by_user_id: BTreeMap<i64, i64>,
    team_members_by_user_id: BTreeMap<i64, TeamMemberProjectionRedis>,
    session_snapshots: BTreeMap<String, OnlineBattleSessionSnapshotRedis>,
    battle_id_by_session_id: BTreeMap<String, String>,
    session_ids_by_character_id: BTreeMap<i64, BTreeSet<String>>,
}

impl OnlineProjectionRegistry {
    pub fn get_character(&self, character_id: i64) -> Option<&OnlineBattleCharacterSnapshotRedis> {
        self.character_snapshots.get(&character_id)
    }

    fn update_character_computed_value(
        &mut self,
        character_id: i64,
        key: &str,
        value: Value,
    ) -> bool {
        let Some(snapshot) = self.character_snapshots.get_mut(&character_id) else {
            return false;
        };
        let Some(computed) = snapshot.computed.as_object_mut() else {
            return false;
        };

        computed.insert(key.to_string(), value);
        true
    }

    pub fn update_character_position(
        &mut self,
        character_id: i64,
        map_id: &str,
        room_id: &str,
    ) -> bool {
        let map_updated = self.update_character_computed_value(
            character_id,
            "current_map_id",
            Value::String(map_id.to_string()),
        );
        let room_updated = self.update_character_computed_value(
            character_id,
            "current_room_id",
            Value::String(room_id.to_string()),
        );
        map_updated && room_updated
    }

    pub fn update_character_auto_cast_skills(&mut self, character_id: i64, enabled: bool) -> bool {
        self.update_character_computed_value(character_id, "auto_cast_skills", Value::Bool(enabled))
    }

    pub fn update_character_auto_disassemble(
        &mut self,
        character_id: i64,
        enabled: bool,
        rules: &[crate::application::character::service::AutoDisassembleRuleDto],
    ) -> bool {
        let enabled_updated = self.update_character_computed_value(
            character_id,
            "auto_disassemble_enabled",
            Value::Bool(enabled),
        );
        let rules_updated = self.update_character_computed_value(
            character_id,
            "auto_disassemble_rules",
            serde_json::to_value(rules).unwrap_or(Value::Array(Vec::new())),
        );
        enabled_updated && rules_updated
    }

    pub fn update_character_dungeon_no_stamina_cost(
        &mut self,
        character_id: i64,
        enabled: bool,
    ) -> bool {
        self.update_character_computed_value(
            character_id,
            "dungeon_no_stamina_cost",
            Value::Bool(enabled),
        )
    }

    pub fn character_ids(&self) -> Vec<i64> {
        self.character_snapshots.keys().copied().collect()
    }

    pub fn find_character_id_by_user_id(&self, user_id: i64) -> Option<i64> {
        self.character_id_by_user_id.get(&user_id).copied()
    }

    pub fn get_team_member_by_user_id(&self, user_id: i64) -> Option<&TeamMemberProjectionRedis> {
        self.team_members_by_user_id.get(&user_id)
    }

    pub fn get_session(&self, session_id: &str) -> Option<&OnlineBattleSessionSnapshotRedis> {
        self.session_snapshots.get(session_id)
    }

    pub fn find_battle_id_by_session_id(&self, session_id: &str) -> Option<&str> {
        self.battle_id_by_session_id
            .get(session_id)
            .map(String::as_str)
    }

    pub fn find_session_ids_by_character_id(&self, character_id: i64) -> Vec<String> {
        self.session_ids_by_character_id
            .get(&character_id)
            .map(|items| items.iter().cloned().collect())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OnlineProjectionCharacterStatusPayload {
    pub character: OnlineBattleCharacterSnapshotRedis,
    pub user_id: i64,
    pub team_member: Option<TeamMemberProjectionRedis>,
    pub session_ids: Vec<String>,
    pub authoritative: bool,
}

pub struct RuntimeRecoveryLoader;

impl RuntimeRecoveryLoader {
    pub async fn load_from_source(
        source: &RecoverySourceData,
    ) -> Result<RuntimeRecoverySnapshot, AppError> {
        let battles = load_battles_from_source(source)?;
        let pve_resume_intents = load_pve_resume_intents_from_source(source)?;
        let session_projections = load_session_projections_from_source(source)?;
        let character_snapshots = load_character_snapshots_from_source(source)?;
        let user_character_links = load_user_character_links_from_source(source);
        let team_members = load_team_members_from_source(source)?;
        let session_battle_links = load_session_battle_links_from_source(source);
        let tower_progressions = load_tower_progressions_from_source(source)?;
        let tower_runtime_projections = load_tower_runtime_projections_from_source(source)?;
        let runtime_resources = load_runtime_resources_from_source(source)?;
        let idle_locks = load_idle_locks_from_source(source)?;

        Ok(RuntimeRecoverySnapshot {
            battles,
            battle_sessions: RecoveredBattleSessionState {
                pve_resume_intents,
                projections: session_projections.clone(),
            },
            online_projection: OnlineProjectionRecoveryState {
                character_snapshots,
                user_character_links,
                team_members,
                session_battle_links,
                session_projections: session_projections.clone(),
                tower_progressions,
                tower_runtime_projections,
            },
            runtime_resources,
            idle_locks,
        })
    }

    pub async fn load_from_redis(redis: &AppRedis) -> Result<RuntimeRecoverySnapshot, AppError> {
        let source = read_recovery_source(redis).await?;
        Self::load_from_source(&source).await
    }
}

pub fn build_online_projection_registry_from_snapshot(
    snapshot: &RuntimeRecoverySnapshot,
) -> Result<OnlineProjectionRegistry, AppError> {
    let mut registry = OnlineProjectionRegistry::default();

    for character in &snapshot.online_projection.character_snapshots {
        registry
            .character_snapshots
            .insert(character.character_id, character.clone());
    }

    for (user_id, character_id) in &snapshot.online_projection.user_character_links {
        registry
            .character_id_by_user_id
            .insert(*user_id, *character_id);
    }

    for (user_id, team_member) in &snapshot.online_projection.team_members {
        registry
            .team_members_by_user_id
            .insert(*user_id, team_member.clone());
    }

    for session in &snapshot.online_projection.session_projections {
        registry
            .session_snapshots
            .insert(session.session_id.clone(), session.clone());
        if let Some(battle_id) = session.current_battle_id.clone() {
            registry
                .battle_id_by_session_id
                .insert(session.session_id.clone(), battle_id);
        }
    }

    for (battle_id, session_id) in &snapshot.online_projection.session_battle_links {
        if registry.session_snapshots.contains_key(session_id) {
            registry
                .battle_id_by_session_id
                .entry(session_id.clone())
                .or_insert_with(|| battle_id.clone());
        }
    }

    for session in registry.session_snapshots.values() {
        for user_id in session.user_ids() {
            let Some(character_id) = registry.character_id_by_user_id.get(&user_id).copied() else {
                continue;
            };
            registry
                .session_ids_by_character_id
                .entry(character_id)
                .or_default()
                .insert(session.session_id.clone());
        }
    }

    Ok(registry)
}

pub fn build_projection_character_status_payload(
    registry: &OnlineProjectionRegistry,
    character_id: i64,
) -> Option<OnlineProjectionCharacterStatusPayload> {
    let character = registry.get_character(character_id)?.clone();
    Some(OnlineProjectionCharacterStatusPayload {
        user_id: character.user_id,
        team_member: registry
            .get_team_member_by_user_id(character.user_id)
            .cloned(),
        session_ids: registry.find_session_ids_by_character_id(character_id),
        character,
        authoritative: true,
    })
}

async fn read_recovery_source(redis: &AppRedis) -> Result<RecoverySourceData, AppError> {
    let battle_state_keys = redis.keys("battle:state:*").await?;
    let pve_resume_keys = redis.keys("battle:session:pve-resume:*").await?;
    let runtime_resource_keys = redis.keys("character:runtime:resource:v1:*").await?;
    let online_keys = redis.keys("online-battle:*").await?;
    let idle_keys = redis.keys("idle:lock:*").await?;

    let mut source = RecoverySourceData::default();
    let all_string_keys: BTreeSet<String> = battle_state_keys
        .into_iter()
        .chain(pve_resume_keys)
        .chain(runtime_resource_keys)
        .chain(online_keys)
        .chain(idle_keys)
        .collect();

    for key in all_string_keys {
        if let Some(value) = redis.get_string(&key).await? {
            source = source.with_string(key, value);
        }
    }

    for index_key in [
        OnlineProjectionIndexKey::characters(),
        OnlineProjectionIndexKey::users(),
        OnlineProjectionIndexKey::sessions(),
        OnlineProjectionIndexKey::arena(),
        OnlineProjectionIndexKey::dungeons(),
        OnlineProjectionIndexKey::dungeon_entries(),
        OnlineProjectionIndexKey::towers(),
        OnlineProjectionIndexKey::tower_runtimes(),
        OnlineProjectionIndexKey::settlement_tasks(),
    ] {
        let key = index_key.into_string();
        let members = redis.smembers(&key).await?;
        source = source.with_set(key, members);
    }

    Ok(source)
}

fn load_character_snapshots_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<OnlineBattleCharacterSnapshotRedis>, AppError> {
    let mut character_ids = source
        .sets
        .get(OnlineProjectionIndexKey::characters().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    character_ids.sort();
    let mut snapshots = Vec::with_capacity(character_ids.len());
    for character_id in character_ids {
        let Some(parsed_id) = character_id.parse::<i64>().ok() else {
            continue;
        };
        let key = OnlineProjectionRedisKey::character(parsed_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        snapshots.push(decode_json(raw)?);
    }
    Ok(snapshots)
}

fn load_user_character_links_from_source(source: &RecoverySourceData) -> Vec<(i64, i64)> {
    let mut user_ids = source
        .sets
        .get(OnlineProjectionIndexKey::users().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    user_ids.sort();

    let mut links = Vec::new();
    for user_id in user_ids {
        let Some(parsed_user_id) = user_id.parse::<i64>().ok() else {
            continue;
        };
        let key = OnlineProjectionRedisKey::user_character(parsed_user_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        let Some(character_id) = raw.parse::<i64>().ok() else {
            continue;
        };
        links.push((parsed_user_id, character_id));
    }
    links
}

fn load_team_members_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<(i64, TeamMemberProjectionRedis)>, AppError> {
    let mut team_members = Vec::new();
    for (user_id, _) in load_user_character_links_from_source(source) {
        let key = OnlineProjectionRedisKey::team_member(user_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        team_members.push((user_id, decode_json(raw)?));
    }
    Ok(team_members)
}

fn load_session_battle_links_from_source(source: &RecoverySourceData) -> Vec<(String, String)> {
    let mut links = Vec::new();
    for session in &source
        .sets
        .get(OnlineProjectionIndexKey::sessions().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
    {
        if let Some(raw_session) = source
            .strings
            .get(&OnlineProjectionRedisKey::session(session).into_string())
        {
            if let Ok(snapshot) = decode_json::<OnlineBattleSessionSnapshotRedis>(raw_session) {
                if let Some(battle_id) = snapshot.current_battle_id {
                    links.push((battle_id, snapshot.session_id));
                }
            }
        }
    }
    links.sort();
    links.dedup();
    links
}

fn load_tower_progressions_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<TowerProgressProjectionRedis>, AppError> {
    let mut character_ids = source
        .sets
        .get(OnlineProjectionIndexKey::towers().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    character_ids.sort();

    let mut progressions = Vec::with_capacity(character_ids.len());
    for character_id in character_ids {
        let Some(parsed_character_id) = character_id.parse::<i64>().ok() else {
            continue;
        };
        let key = OnlineProjectionRedisKey::tower(parsed_character_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        progressions.push(decode_json(raw)?);
    }

    Ok(progressions)
}

fn load_tower_runtime_projections_from_source(
    source: &RecoverySourceData,
) -> Result<Vec<TowerBattleRuntimeProjectionRedis>, AppError> {
    let mut battle_ids = source
        .sets
        .get(OnlineProjectionIndexKey::tower_runtimes().as_ref())
        .map(|items| items.iter().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    battle_ids.sort();

    let mut runtimes = Vec::with_capacity(battle_ids.len());
    for battle_id in battle_ids {
        let key = OnlineProjectionRedisKey::tower_runtime(&battle_id).into_string();
        let Some(raw) = source.strings.get(&key) else {
            continue;
        };
        runtimes.push(decode_json(raw)?);
    }

    Ok(runtimes)
}
