use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use socketioxide::SocketIo;

use crate::battle_runtime::BattleStateDto;
use crate::config::AppConfig;
use crate::idle_runtime::IdleExecutionRegistry;
use crate::integrations::database::DatabaseRuntime;
use crate::realtime::online_players::OnlinePlayerDto;

#[derive(Debug, Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub database: DatabaseRuntime,
    pub redis: Option<redis::Client>,
    pub outbound_http: reqwest::Client,
    pub redis_available: bool,
    pub idle_execution_registry: Arc<IdleExecutionRegistry>,
    pub battle_sessions: Arc<BattleSessionRuntime>,
    pub battle_runtime: Arc<BattleRuntime>,
    pub online_battle_projections: Arc<OnlineBattleProjectionRuntime>,
    pub character_snapshots: Arc<CharacterSnapshotRuntime>,
    pub arena_projections: Arc<ArenaProjectionRuntime>,
    pub dungeon_projections: Arc<DungeonProjectionRuntime>,
    pub team_projections: Arc<TeamProjectionRuntime>,
    pub dungeon_entry_projections: Arc<DungeonEntryProjectionRuntime>,
    pub tower_projections: Arc<TowerProjectionRuntime>,
    pub online_players: Arc<OnlinePlayerRegistry>,
    pub realtime_sessions: Arc<RealtimeSessionRegistry>,
    pub realtime_io: Arc<Mutex<Option<SocketIo>>>,
    #[cfg(test)]
    pub test_runtime_slot: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineBattleProjectionRecord {
    pub battle_id: String,
    pub owner_user_id: i64,
    pub participant_user_ids: Vec<i64>,
    pub r#type: String,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlinePlayerRecord {
    pub user_id: i64,
    pub character_id: Option<i64>,
    pub nickname: Option<String>,
    pub month_card_active: bool,
    pub title: Option<String>,
    pub realm: Option<String>,
    pub room_id: Option<String>,
    pub connected_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeSessionRecord {
    pub socket_id: String,
    pub user_id: i64,
    pub character_id: Option<i64>,
    pub session_token: Option<String>,
    pub connected_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamProjectionRecord {
    pub user_id: i64,
    pub team_id: Option<String>,
    pub role: String,
    pub member_character_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonEntryProjectionRecord {
    pub character_id: i64,
    pub dungeon_id: String,
    pub daily_count: i64,
    pub weekly_count: i64,
    pub total_count: i64,
    pub last_daily_reset: String,
    pub last_weekly_reset: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerProjectionRecord {
    pub character_id: i64,
    pub best_floor: i64,
    pub next_floor: i64,
    pub current_run_id: Option<String>,
    pub current_floor: Option<i64>,
    pub current_battle_id: Option<String>,
    pub last_settled_floor: i64,
    pub updated_at: Option<String>,
    pub reached_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaProjectionRecord {
    pub character_id: i64,
    pub score: i64,
    pub win_count: i64,
    pub lose_count: i64,
    pub today_used: i64,
    pub today_limit: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonProjectionRecord {
    pub instance_id: String,
    pub dungeon_id: String,
    pub difficulty_id: String,
    pub creator_character_id: i64,
    pub team_id: Option<String>,
    pub status: String,
    pub current_stage: i64,
    pub current_wave: i64,
    pub participant_character_ids: Vec<i64>,
    pub current_battle_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSnapshotRecord {
    pub character_id: i64,
    pub user_id: i64,
    pub nickname: String,
    pub realm: String,
    pub power: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BattleSessionSnapshotDto {
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
    pub context: BattleSessionContextDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BattleSessionContextDto {
    Pve {
        monster_ids: Vec<String>,
    },
    Dungeon {
        instance_id: String,
    },
    Tower {
        run_id: String,
        floor: i64,
    },
    Pvp {
        opponent_character_id: i64,
        mode: String,
    },
}

#[derive(Debug, Default)]
pub struct BattleSessionRuntime {
    sessions_by_id: Mutex<HashMap<String, BattleSessionSnapshotDto>>,
    session_id_by_battle_id: Mutex<HashMap<String, String>>,
    current_session_id_by_user_id: Mutex<HashMap<i64, String>>,
}

#[derive(Debug, Default)]
pub struct BattleRuntime {
    states_by_battle_id: Mutex<HashMap<String, BattleStateDto>>,
}

#[derive(Debug, Default)]
pub struct OnlineBattleProjectionRuntime {
    projections_by_battle_id: Mutex<HashMap<String, OnlineBattleProjectionRecord>>,
    current_battle_id_by_user_id: Mutex<HashMap<i64, String>>,
}

#[derive(Debug, Default)]
pub struct TeamProjectionRuntime {
    projections_by_user_id: Mutex<HashMap<i64, TeamProjectionRecord>>,
}

#[derive(Debug, Default)]
pub struct DungeonEntryProjectionRuntime {
    projections_by_key: Mutex<HashMap<String, DungeonEntryProjectionRecord>>,
}

#[derive(Debug, Default)]
pub struct TowerProjectionRuntime {
    projections_by_character_id: Mutex<HashMap<i64, TowerProjectionRecord>>,
}

#[derive(Debug, Default)]
pub struct ArenaProjectionRuntime {
    projections_by_character_id: Mutex<HashMap<i64, ArenaProjectionRecord>>,
}

#[derive(Debug, Default)]
pub struct DungeonProjectionRuntime {
    projections_by_instance_id: Mutex<HashMap<String, DungeonProjectionRecord>>,
}

#[derive(Debug, Default)]
pub struct CharacterSnapshotRuntime {
    snapshots_by_character_id: Mutex<HashMap<i64, CharacterSnapshotRecord>>,
}

#[derive(Debug, Default)]
pub struct OnlinePlayerRegistry {
    players_by_user_id: Mutex<HashMap<i64, OnlinePlayerRecord>>,
    last_broadcasted_players: Mutex<BTreeMap<i64, OnlinePlayerDto>>,
    online_players_emit_timer_active: AtomicBool,
    online_players_emit_queued: AtomicBool,
    online_players_last_emit_at_ms: AtomicI64,
}

#[derive(Debug, Default)]
pub struct RealtimeSessionRegistry {
    sessions_by_socket_id: Mutex<HashMap<String, RealtimeSessionRecord>>,
    socket_id_by_user_id: Mutex<HashMap<i64, String>>,
    socket_id_by_character_id: Mutex<HashMap<i64, String>>,
}

impl AppState {
    pub fn new(
        config: Arc<AppConfig>,
        database: DatabaseRuntime,
        redis: Option<redis::Client>,
        outbound_http: reqwest::Client,
        redis_available: bool,
    ) -> Self {
        Self {
            config,
            database,
            redis,
            outbound_http,
            redis_available,
            idle_execution_registry: Arc::new(IdleExecutionRegistry::default()),
            battle_sessions: Arc::new(BattleSessionRuntime::default()),
            battle_runtime: Arc::new(BattleRuntime::default()),
            online_battle_projections: Arc::new(OnlineBattleProjectionRuntime::default()),
            character_snapshots: Arc::new(CharacterSnapshotRuntime::default()),
            arena_projections: Arc::new(ArenaProjectionRuntime::default()),
            dungeon_projections: Arc::new(DungeonProjectionRuntime::default()),
            team_projections: Arc::new(TeamProjectionRuntime::default()),
            dungeon_entry_projections: Arc::new(DungeonEntryProjectionRuntime::default()),
            tower_projections: Arc::new(TowerProjectionRuntime::default()),
            online_players: Arc::new(OnlinePlayerRegistry::default()),
            realtime_sessions: Arc::new(RealtimeSessionRegistry::default()),
            realtime_io: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            test_runtime_slot: None,
        }
    }

    pub fn attach_socket_io(&self, io: SocketIo) {
        *self
            .realtime_io
            .lock()
            .expect("realtime io lock should acquire") = Some(io);
    }

    pub fn socket_io(&self) -> Option<SocketIo> {
        self.realtime_io
            .lock()
            .expect("realtime io lock should acquire")
            .clone()
    }
}

impl BattleSessionRuntime {
    pub fn register(&self, session: BattleSessionSnapshotDto) {
        let session_id = session.session_id.clone();
        let current_battle_id = session.current_battle_id.clone();
        let owner_user_id = session.owner_user_id;
        self.sessions_by_id
            .lock()
            .expect("battle sessions lock should acquire")
            .insert(session_id.clone(), session);
        if let Some(battle_id) = current_battle_id {
            self.session_id_by_battle_id
                .lock()
                .expect("battle session battle index lock should acquire")
                .insert(battle_id, session_id.clone());
        }
        self.current_session_id_by_user_id
            .lock()
            .expect("battle session current index lock should acquire")
            .insert(owner_user_id, session_id);
    }

    pub fn get_by_session_id(&self, session_id: &str) -> Option<BattleSessionSnapshotDto> {
        self.sessions_by_id
            .lock()
            .expect("battle sessions lock should acquire")
            .get(session_id)
            .cloned()
    }

    pub fn get_by_battle_id(&self, battle_id: &str) -> Option<BattleSessionSnapshotDto> {
        let session_id = self
            .session_id_by_battle_id
            .lock()
            .expect("battle session battle index lock should acquire")
            .get(battle_id)
            .cloned()?;
        self.get_by_session_id(&session_id)
    }

    pub fn get_current_for_user(&self, user_id: i64) -> Option<BattleSessionSnapshotDto> {
        let session_id = self
            .current_session_id_by_user_id
            .lock()
            .expect("battle session current index lock should acquire")
            .get(&user_id)
            .cloned()?;
        self.get_by_session_id(&session_id)
    }

    pub fn update<F>(&self, session_id: &str, mutator: F) -> Option<BattleSessionSnapshotDto>
    where
        F: FnOnce(&mut BattleSessionSnapshotDto),
    {
        let mut sessions = self
            .sessions_by_id
            .lock()
            .expect("battle sessions lock should acquire");
        let session = sessions.get_mut(session_id)?;
        let previous_battle_id = session.current_battle_id.clone();
        mutator(session);
        let snapshot = session.clone();
        drop(sessions);

        let mut by_battle = self
            .session_id_by_battle_id
            .lock()
            .expect("battle session battle index lock should acquire");
        if let Some(previous_battle_id) = previous_battle_id {
            if snapshot.current_battle_id.as_deref() != Some(previous_battle_id.as_str()) {
                by_battle.remove(&previous_battle_id);
            }
        }
        if let Some(current_battle_id) = snapshot.current_battle_id.clone() {
            by_battle.insert(current_battle_id, snapshot.session_id.clone());
        }
        drop(by_battle);

        self.current_session_id_by_user_id
            .lock()
            .expect("battle session current index lock should acquire")
            .insert(snapshot.owner_user_id, snapshot.session_id.clone());
        Some(snapshot)
    }

    pub fn snapshot(&self) -> Vec<BattleSessionSnapshotDto> {
        let mut values = self
            .sessions_by_id
            .lock()
            .expect("battle sessions lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        values
    }
}

impl OnlineBattleProjectionRuntime {
    pub fn register(&self, projection: OnlineBattleProjectionRecord) {
        let battle_id = projection.battle_id.clone();
        for user_id in &projection.participant_user_ids {
            self.current_battle_id_by_user_id
                .lock()
                .expect("online battle current index lock should acquire")
                .insert(*user_id, battle_id.clone());
        }
        self.projections_by_battle_id
            .lock()
            .expect("online battle projection lock should acquire")
            .insert(battle_id, projection);
    }

    pub fn get_by_battle_id(&self, battle_id: &str) -> Option<OnlineBattleProjectionRecord> {
        self.projections_by_battle_id
            .lock()
            .expect("online battle projection lock should acquire")
            .get(battle_id)
            .cloned()
    }

    pub fn get_current_for_user(&self, user_id: i64) -> Option<OnlineBattleProjectionRecord> {
        let battle_id = self
            .current_battle_id_by_user_id
            .lock()
            .expect("online battle current index lock should acquire")
            .get(&user_id)
            .cloned()?;
        self.get_by_battle_id(&battle_id)
    }

    pub fn clear(&self, battle_id: &str) {
        let removed = self
            .projections_by_battle_id
            .lock()
            .expect("online battle projection lock should acquire")
            .remove(battle_id);
        if let Some(record) = removed {
            let mut current = self
                .current_battle_id_by_user_id
                .lock()
                .expect("online battle current index lock should acquire");
            for user_id in record.participant_user_ids {
                if current.get(&user_id).map(|value| value.as_str()) == Some(battle_id) {
                    current.remove(&user_id);
                }
            }
        }
    }

    pub fn snapshot(&self) -> Vec<OnlineBattleProjectionRecord> {
        let mut values = self
            .projections_by_battle_id
            .lock()
            .expect("online battle projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.battle_id.cmp(&right.battle_id));
        values
    }
}

impl TeamProjectionRuntime {
    pub fn register(&self, projection: TeamProjectionRecord) {
        self.projections_by_user_id
            .lock()
            .expect("team projection lock should acquire")
            .insert(projection.user_id, projection);
    }

    pub fn snapshot(&self) -> Vec<TeamProjectionRecord> {
        let mut values = self
            .projections_by_user_id
            .lock()
            .expect("team projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.user_id.cmp(&right.user_id));
        values
    }
}

impl DungeonEntryProjectionRuntime {
    pub fn register(&self, projection: DungeonEntryProjectionRecord) {
        let key = format!("{}:{}", projection.character_id, projection.dungeon_id);
        self.projections_by_key
            .lock()
            .expect("dungeon entry projection lock should acquire")
            .insert(key, projection);
    }

    pub fn snapshot(&self) -> Vec<DungeonEntryProjectionRecord> {
        let mut values = self
            .projections_by_key
            .lock()
            .expect("dungeon entry projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| {
            left.character_id
                .cmp(&right.character_id)
                .then(left.dungeon_id.cmp(&right.dungeon_id))
        });
        values
    }
}

impl TowerProjectionRuntime {
    pub fn register(&self, projection: TowerProjectionRecord) {
        self.projections_by_character_id
            .lock()
            .expect("tower projection lock should acquire")
            .insert(projection.character_id, projection);
    }

    pub fn snapshot(&self) -> Vec<TowerProjectionRecord> {
        let mut values = self
            .projections_by_character_id
            .lock()
            .expect("tower projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.character_id.cmp(&right.character_id));
        values
    }
}

impl ArenaProjectionRuntime {
    pub fn register(&self, projection: ArenaProjectionRecord) {
        self.projections_by_character_id
            .lock()
            .expect("arena projection lock should acquire")
            .insert(projection.character_id, projection);
    }

    pub fn snapshot(&self) -> Vec<ArenaProjectionRecord> {
        let mut values = self
            .projections_by_character_id
            .lock()
            .expect("arena projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.character_id.cmp(&right.character_id));
        values
    }
}

impl DungeonProjectionRuntime {
    pub fn register(&self, projection: DungeonProjectionRecord) {
        self.projections_by_instance_id
            .lock()
            .expect("dungeon projection lock should acquire")
            .insert(projection.instance_id.clone(), projection);
    }

    pub fn snapshot(&self) -> Vec<DungeonProjectionRecord> {
        let mut values = self
            .projections_by_instance_id
            .lock()
            .expect("dungeon projection lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
        values
    }
}

impl CharacterSnapshotRuntime {
    pub fn register(&self, snapshot: CharacterSnapshotRecord) {
        self.snapshots_by_character_id
            .lock()
            .expect("character snapshot runtime lock should acquire")
            .insert(snapshot.character_id, snapshot);
    }

    pub fn snapshot(&self) -> Vec<CharacterSnapshotRecord> {
        let mut values = self
            .snapshots_by_character_id
            .lock()
            .expect("character snapshot runtime lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.character_id.cmp(&right.character_id));
        values
    }
}

impl BattleRuntime {
    pub fn register(&self, state: BattleStateDto) {
        self.states_by_battle_id
            .lock()
            .expect("battle runtime lock should acquire")
            .insert(state.battle_id.clone(), state);
    }

    pub fn get(&self, battle_id: &str) -> Option<BattleStateDto> {
        self.states_by_battle_id
            .lock()
            .expect("battle runtime lock should acquire")
            .get(battle_id)
            .cloned()
    }

    pub fn update<F>(&self, battle_id: &str, mutator: F) -> Option<BattleStateDto>
    where
        F: FnOnce(&mut BattleStateDto),
    {
        let mut states = self
            .states_by_battle_id
            .lock()
            .expect("battle runtime lock should acquire");
        let state = states.get_mut(battle_id)?;
        mutator(state);
        Some(state.clone())
    }

    pub fn clear(&self, battle_id: &str) {
        self.states_by_battle_id
            .lock()
            .expect("battle runtime lock should acquire")
            .remove(battle_id);
    }
}

impl OnlinePlayerRegistry {
    pub fn register(&self, record: OnlinePlayerRecord) {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .insert(record.user_id, record);
    }

    pub fn update_room(&self, user_id: i64, room_id: Option<&str>) {
        if let Some(record) = self
            .players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .get_mut(&user_id)
        {
            record.room_id = room_id.map(|value| value.to_string());
        }
    }

    pub fn remove(&self, user_id: i64) {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .remove(&user_id);
    }

    pub fn get(&self, user_id: i64) -> Option<OnlinePlayerRecord> {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .get(&user_id)
            .cloned()
    }

    pub fn snapshot(&self) -> Vec<OnlinePlayerRecord> {
        let mut values = self
            .players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by_key(|record| record.user_id);
        values
    }

    pub fn snapshot_dto_map(&self) -> BTreeMap<i64, OnlinePlayerDto> {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .values()
            .filter_map(|record| record.to_dto())
            .map(|dto| (dto.id, dto))
            .collect()
    }

    pub fn take_last_broadcasted_players(&self) -> BTreeMap<i64, OnlinePlayerDto> {
        self.last_broadcasted_players
            .lock()
            .expect("online players broadcast snapshot lock should acquire")
            .clone()
    }

    pub fn replace_last_broadcasted_players(&self, snapshot: BTreeMap<i64, OnlinePlayerDto>) {
        *self
            .last_broadcasted_players
            .lock()
            .expect("online players broadcast snapshot lock should acquire") = snapshot;
    }

    pub fn mark_online_players_emit_timer_active(&self) -> bool {
        self.online_players_emit_timer_active
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn clear_online_players_emit_timer_active(&self) {
        self.online_players_emit_timer_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn mark_online_players_emit_queued(&self) {
        self.online_players_emit_queued
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn take_online_players_emit_queued(&self) -> bool {
        self.online_players_emit_queued
            .swap(false, std::sync::atomic::Ordering::SeqCst)
    }

    pub fn online_players_last_emit_at_ms(&self) -> i64 {
        self.online_players_last_emit_at_ms
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn set_online_players_last_emit_at_ms(&self, value: i64) {
        self.online_players_last_emit_at_ms
            .store(value, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn count_total(&self) -> i64 {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .len() as i64
    }

    pub fn count_room(&self, room_id: &str) -> i64 {
        self.players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .values()
            .filter(|record| record.room_id.as_deref() == Some(room_id))
            .count() as i64
    }

    pub fn snapshot_room(&self, room_id: &str) -> Vec<OnlinePlayerRecord> {
        let mut values = self
            .players_by_user_id
            .lock()
            .expect("online players lock should acquire")
            .values()
            .filter(|record| record.room_id.as_deref() == Some(room_id))
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by_key(|record| record.user_id);
        values
    }
}

impl OnlinePlayerRecord {
    pub fn to_dto(&self) -> Option<OnlinePlayerDto> {
        let id = self.character_id?;
        if id <= 0 {
            return None;
        }
        let nickname = self.nickname.as_deref()?.trim();
        if nickname.is_empty() {
            return None;
        }
        Some(OnlinePlayerDto {
            id,
            nickname: nickname.to_string(),
            month_card_active: self.month_card_active,
            title: self
                .title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("散修")
                .to_string(),
            realm: self
                .realm
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("凡人")
                .to_string(),
        })
    }
}

impl RealtimeSessionRegistry {
    pub fn register(&self, record: RealtimeSessionRecord) -> Option<RealtimeSessionRecord> {
        let socket_id = record.socket_id.clone();
        let user_id = record.user_id;
        let character_id = record.character_id;

        let previous_socket_id = self
            .socket_id_by_user_id
            .lock()
            .expect("realtime user index lock should acquire")
            .insert(user_id, socket_id.clone());

        let previous = previous_socket_id.and_then(|previous_socket_id| {
            self.sessions_by_socket_id
                .lock()
                .expect("realtime sessions lock should acquire")
                .remove(&previous_socket_id)
        });

        if let Some(previous_record) = previous.as_ref() {
            if let Some(previous_character_id) = previous_record.character_id {
                let mut by_character = self
                    .socket_id_by_character_id
                    .lock()
                    .expect("realtime character index lock should acquire");
                if by_character
                    .get(&previous_character_id)
                    .map(|value| value.as_str())
                    == Some(previous_record.socket_id.as_str())
                {
                    by_character.remove(&previous_character_id);
                }
            }
        }

        self.sessions_by_socket_id
            .lock()
            .expect("realtime sessions lock should acquire")
            .insert(socket_id.clone(), record);

        if let Some(character_id) = character_id {
            self.socket_id_by_character_id
                .lock()
                .expect("realtime character index lock should acquire")
                .insert(character_id, socket_id);
        }

        previous
    }

    pub fn get_by_socket_id(&self, socket_id: &str) -> Option<RealtimeSessionRecord> {
        self.sessions_by_socket_id
            .lock()
            .expect("realtime sessions lock should acquire")
            .get(socket_id)
            .cloned()
    }

    pub fn get_by_user_id(&self, user_id: i64) -> Option<RealtimeSessionRecord> {
        let socket_id = self
            .socket_id_by_user_id
            .lock()
            .expect("realtime user index lock should acquire")
            .get(&user_id)
            .cloned()?;
        self.get_by_socket_id(&socket_id)
    }

    pub fn get_by_character_id(&self, character_id: i64) -> Option<RealtimeSessionRecord> {
        let socket_id = self
            .socket_id_by_character_id
            .lock()
            .expect("realtime character index lock should acquire")
            .get(&character_id)
            .cloned()?;
        self.get_by_socket_id(&socket_id)
    }

    pub fn snapshot(&self) -> Vec<RealtimeSessionRecord> {
        let mut values = self
            .sessions_by_socket_id
            .lock()
            .expect("realtime sessions lock should acquire")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|a, b| a.socket_id.cmp(&b.socket_id));
        values
    }

    pub fn remove_by_socket_id(&self, socket_id: &str) -> Option<RealtimeSessionRecord> {
        let removed = self
            .sessions_by_socket_id
            .lock()
            .expect("realtime sessions lock should acquire")
            .remove(socket_id);

        if let Some(record) = removed.as_ref() {
            let mut by_user = self
                .socket_id_by_user_id
                .lock()
                .expect("realtime user index lock should acquire");
            if by_user.get(&record.user_id).map(|value| value.as_str()) == Some(socket_id) {
                by_user.remove(&record.user_id);
            }

            if let Some(character_id) = record.character_id {
                let mut by_character = self
                    .socket_id_by_character_id
                    .lock()
                    .expect("realtime character index lock should acquire");
                if by_character.get(&character_id).map(|value| value.as_str()) == Some(socket_id) {
                    by_character.remove(&character_id);
                }
            }
        }

        removed
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BattleRuntime, OnlineBattleProjectionRecord, OnlineBattleProjectionRuntime,
        OnlinePlayerRecord, OnlinePlayerRegistry, RealtimeSessionRecord, RealtimeSessionRegistry,
    };
    use crate::battle_runtime::build_minimal_pve_battle_state;

    #[test]
    fn online_battle_projection_runtime_registers_and_clears() {
        let runtime = OnlineBattleProjectionRuntime::default();
        runtime.register(OnlineBattleProjectionRecord {
            battle_id: "battle-1".to_string(),
            owner_user_id: 1,
            participant_user_ids: vec![1, 2],
            r#type: "pve".to_string(),
            session_id: Some("session-1".to_string()),
        });

        let by_battle = runtime
            .get_by_battle_id("battle-1")
            .expect("projection should exist");
        assert_eq!(by_battle.session_id.as_deref(), Some("session-1"));
        let current = runtime
            .get_current_for_user(2)
            .expect("participant projection should exist");
        assert_eq!(current.battle_id, "battle-1");

        runtime.clear("battle-1");
        assert!(runtime.get_by_battle_id("battle-1").is_none());
        assert!(runtime.get_current_for_user(1).is_none());
    }

    #[test]
    fn battle_runtime_registers_and_updates() {
        let runtime = BattleRuntime::default();
        runtime.register(build_minimal_pve_battle_state(
            "battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        ));

        let initial = runtime.get("battle-1").expect("battle state should exist");
        assert_eq!(initial.phase, "action");

        let updated = runtime
            .update("battle-1", |state| {
                state.phase = "finished".to_string();
                state.result = Some("attacker_win".to_string());
            })
            .expect("battle state should update");
        assert_eq!(updated.result.as_deref(), Some("attacker_win"));

        runtime.clear("battle-1");
        assert!(runtime.get("battle-1").is_none());
    }

    #[test]
    fn online_player_registry_registers_updates_and_removes() {
        let registry = OnlinePlayerRegistry::default();
        registry.register(OnlinePlayerRecord {
            user_id: 1,
            character_id: Some(2),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1712800000000,
        });

        assert_eq!(
            registry.get(1).and_then(|record| record.character_id),
            Some(2)
        );
        registry.update_room(1, Some("room-south-forest"));
        assert_eq!(
            registry.get(1).and_then(|record| record.room_id),
            Some("room-south-forest".to_string())
        );
        assert_eq!(registry.snapshot().len(), 1);

        registry.remove(1);
        assert!(registry.get(1).is_none());
    }

    #[test]
    fn online_player_registry_counts_and_filters_by_room() {
        let registry = OnlinePlayerRegistry::default();
        registry.register(OnlinePlayerRecord {
            user_id: 1,
            character_id: Some(11),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 1,
        });
        registry.register(OnlinePlayerRecord {
            user_id: 2,
            character_id: Some(22),
            nickname: Some("张铁".to_string()),
            month_card_active: false,
            title: Some("外门弟子".to_string()),
            realm: Some("凡人".to_string()),
            room_id: Some("room-village-center".to_string()),
            connected_at_ms: 2,
        });
        registry.register(OnlinePlayerRecord {
            user_id: 3,
            character_id: Some(33),
            nickname: Some("墨彩环".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("练气期".to_string()),
            room_id: Some("room-south-forest".to_string()),
            connected_at_ms: 3,
        });

        assert_eq!(registry.count_total(), 3);
        assert_eq!(registry.count_room("room-village-center"), 2);
        assert_eq!(registry.count_room("room-south-forest"), 1);
        assert_eq!(registry.count_room("room-none"), 0);

        let village = registry.snapshot_room("room-village-center");
        assert_eq!(village.len(), 2);
        assert_eq!(village[0].user_id, 1);
        assert_eq!(village[1].user_id, 2);
    }

    #[test]
    fn online_player_registry_builds_sorted_dto_snapshot() {
        let registry = OnlinePlayerRegistry::default();
        registry.register(OnlinePlayerRecord {
            user_id: 1,
            character_id: Some(11),
            nickname: Some("韩立".to_string()),
            month_card_active: true,
            title: Some("散修".to_string()),
            realm: Some("炼气期".to_string()),
            room_id: None,
            connected_at_ms: 1,
        });
        registry.register(OnlinePlayerRecord {
            user_id: 2,
            character_id: None,
            nickname: Some("空角色".to_string()),
            month_card_active: false,
            title: Some("散修".to_string()),
            realm: Some("凡人".to_string()),
            room_id: None,
            connected_at_ms: 2,
        });

        let snapshot = registry.snapshot_dto_map();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(
            snapshot.get(&11).map(|dto| dto.nickname.as_str()),
            Some("韩立")
        );
    }

    #[test]
    fn realtime_session_registry_registers_indexes_and_replaces_duplicate_user() {
        let registry = RealtimeSessionRegistry::default();
        let first = registry.register(RealtimeSessionRecord {
            socket_id: "socket-1".to_string(),
            user_id: 7,
            character_id: Some(70),
            session_token: Some("sess-a".to_string()),
            connected_at_ms: 1,
        });
        assert!(first.is_none());

        let replaced = registry.register(RealtimeSessionRecord {
            socket_id: "socket-2".to_string(),
            user_id: 7,
            character_id: Some(71),
            session_token: Some("sess-b".to_string()),
            connected_at_ms: 2,
        });

        assert_eq!(
            replaced.as_ref().map(|record| record.socket_id.as_str()),
            Some("socket-1")
        );
        assert!(registry.get_by_socket_id("socket-1").is_none());
        assert_eq!(
            registry.get_by_user_id(7).map(|record| record.socket_id),
            Some("socket-2".to_string())
        );
        assert!(registry.get_by_character_id(70).is_none());
        assert_eq!(
            registry
                .get_by_character_id(71)
                .map(|record| record.user_id),
            Some(7)
        );
    }

    #[test]
    fn realtime_session_registry_removes_indexes_with_socket() {
        let registry = RealtimeSessionRegistry::default();
        registry.register(RealtimeSessionRecord {
            socket_id: "socket-3".to_string(),
            user_id: 9,
            character_id: Some(90),
            session_token: None,
            connected_at_ms: 3,
        });

        let removed = registry.remove_by_socket_id("socket-3");
        assert_eq!(removed.as_ref().map(|record| record.user_id), Some(9));
        assert!(registry.get_by_socket_id("socket-3").is_none());
        assert!(registry.get_by_user_id(9).is_none());
        assert!(registry.get_by_character_id(90).is_none());
    }
}
