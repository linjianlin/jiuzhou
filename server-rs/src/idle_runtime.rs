use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::battle_runtime::{
    apply_minimal_pve_action, build_minimal_partner_battle_unit, build_minimal_pve_battle_state, BattleStateDto,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleSessionActivitySnapshot {
    pub id: String,
    pub character_id: i64,
    pub status: String,
    pub started_at_ms: i64,
    pub max_duration_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleReconcilePlan {
    pub interrupt_session_ids: Vec<String>,
    pub complete_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdleExecutionSnapshot {
    pub version: i64,
    pub monster_ids: Vec<String>,
    pub resolved_skill_id: String,
    #[serde(default = "default_idle_auto_skill_policy")]
    pub auto_skill_policy: serde_json::Value,
    pub initial_battle_state: BattleStateDto,
    pub partner_member: Option<IdlePartnerExecutionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IdlePartnerExecutionSnapshot {
    pub partner_id: i64,
    pub name: String,
    pub avatar: Option<String>,
    pub max_qixue: i64,
    pub attack_power: i64,
    pub speed: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdleBatchExecutionResult {
    pub result: String,
    pub round_count: i64,
    pub exp_gained: i64,
    pub silver_gained: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct IdleSkillRuntimeConfig {
    cost_lingqi: i64,
    cost_qixue: i64,
    cooldown_turns: i64,
}

fn default_idle_auto_skill_policy() -> serde_json::Value {
    serde_json::json!({ "slots": [] })
}

#[derive(Debug, Deserialize)]
struct MapSeedFile {
    maps: Vec<MapSeed>,
}

#[derive(Debug, Deserialize)]
struct MapSeed {
    id: String,
    enabled: Option<bool>,
    rooms: Vec<MapRoomSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomSeed {
    id: String,
    monsters: Vec<MapRoomMonsterSeed>,
}

#[derive(Debug, Deserialize)]
struct MapRoomMonsterSeed {
    monster_def_id: String,
    count: Option<i64>,
}

#[derive(Debug, Default)]
pub struct IdleExecutionRegistry {
    heartbeat_by_session_id: Mutex<BTreeMap<String, i64>>,
    lock_token_by_character_id: Mutex<BTreeMap<i64, String>>,
    stop_requested_by_session_id: Mutex<BTreeMap<String, bool>>,
}

pub fn build_idle_reconcile_plan(
    sessions: &[IdleSessionActivitySnapshot],
    now_ms: i64,
    heartbeat_by_session_id: &std::collections::BTreeMap<String, i64>,
    heartbeat_timeout_ms: i64,
) -> IdleReconcilePlan {
    let mut interrupt_session_ids = Vec::new();
    let mut complete_session_ids = Vec::new();

    for session in sessions {
        match session.status.as_str() {
            "stopping" => {
                let alive = heartbeat_by_session_id
                    .get(&session.id)
                    .map(|heartbeat_ms| {
                        now_ms.saturating_sub(*heartbeat_ms) <= heartbeat_timeout_ms
                    })
                    .unwrap_or(false);
                if !alive {
                    interrupt_session_ids.push(session.id.clone());
                }
            }
            "active" => {
                let alive = heartbeat_by_session_id
                    .get(&session.id)
                    .map(|heartbeat_ms| {
                        now_ms.saturating_sub(*heartbeat_ms) <= heartbeat_timeout_ms
                    })
                    .unwrap_or(false);
                let deadline_ms = session
                    .started_at_ms
                    .saturating_add(session.max_duration_ms.max(0));
                if deadline_ms <= now_ms && !alive {
                    complete_session_ids.push(session.id.clone());
                }
            }
            _ => {}
        }
    }

    IdleReconcilePlan {
        interrupt_session_ids,
        complete_session_ids,
    }
}

impl IdleExecutionRegistry {
    pub fn has_session(&self, session_id: &str) -> bool {
        self.heartbeat_by_session_id
            .lock()
            .expect("idle execution registry lock should acquire")
            .contains_key(session_id)
    }

    pub fn register(&self, session_id: &str, heartbeat_ms: i64) {
        self.heartbeat_by_session_id
            .lock()
            .expect("idle execution registry lock should acquire")
            .insert(session_id.to_string(), heartbeat_ms);
    }

    pub fn touch(&self, session_id: &str, heartbeat_ms: i64) {
        self.register(session_id, heartbeat_ms);
    }

    pub fn remove(&self, session_id: &str) {
        self.heartbeat_by_session_id
            .lock()
            .expect("idle execution registry lock should acquire")
            .remove(session_id);
        self.stop_requested_by_session_id
            .lock()
            .expect("idle execution registry stop request lock should acquire")
            .remove(session_id);
    }

    pub fn snapshot(&self) -> BTreeMap<String, i64> {
        self.heartbeat_by_session_id
            .lock()
            .expect("idle execution registry lock should acquire")
            .clone()
    }

    pub fn set_lock_token(&self, character_id: i64, token: String) {
        self.lock_token_by_character_id
            .lock()
            .expect("idle execution registry lock token lock should acquire")
            .insert(character_id, token);
    }

    pub fn get_lock_token(&self, character_id: i64) -> Option<String> {
        self.lock_token_by_character_id
            .lock()
            .expect("idle execution registry lock token lock should acquire")
            .get(&character_id)
            .cloned()
    }

    pub fn clear_lock_token(&self, character_id: i64) {
        self.lock_token_by_character_id
            .lock()
            .expect("idle execution registry lock token lock should acquire")
            .remove(&character_id);
    }

    pub fn request_stop(&self, session_id: &str) {
        self.stop_requested_by_session_id
            .lock()
            .expect("idle execution registry stop request lock should acquire")
            .insert(session_id.to_string(), true);
    }

    pub fn is_stop_requested(&self, session_id: &str) -> bool {
        self.stop_requested_by_session_id
            .lock()
            .expect("idle execution registry stop request lock should acquire")
            .get(session_id)
            .copied()
            .unwrap_or(false)
    }
}

pub fn build_idle_execution_snapshot(
    character_id: i64,
    map_id: &str,
    room_id: &str,
    target_monster_def_id: &str,
    auto_skill_policy: &serde_json::Value,
    partner_member: Option<IdlePartnerExecutionSnapshot>,
) -> Result<IdleExecutionSnapshot, String> {
    let monster_ids = load_room_monster_ids(map_id, room_id, target_monster_def_id)?;
    let resolved_skill_id = resolve_idle_skill_id(auto_skill_policy);
    let mut initial_battle_state = build_minimal_pve_battle_state(
        &format!("idle-preview-{character_id}"),
        character_id,
        &monster_ids,
    );
    if let Some(partner) = partner_member.as_ref() {
        initial_battle_state.teams.attacker.total_speed += partner.speed.max(1);
        initial_battle_state
            .teams
            .attacker
            .units
            .push(build_minimal_partner_battle_unit(
                partner.partner_id,
                partner.name.clone(),
                partner.avatar.clone(),
                format!("player-{character_id}"),
                partner.max_qixue,
                partner.speed,
                2,
            ));
    }
    Ok(IdleExecutionSnapshot {
        version: 1,
        monster_ids,
        resolved_skill_id,
        auto_skill_policy: auto_skill_policy.clone(),
        initial_battle_state,
        partner_member,
    })
}

pub fn execute_idle_batch_from_snapshot(
    session_id: &str,
    character_id: i64,
    batch_index: i64,
    snapshot: &IdleExecutionSnapshot,
) -> Result<IdleBatchExecutionResult, String> {
    let mut state = snapshot.initial_battle_state.clone();
    state.battle_id = format!("{session_id}-batch-{batch_index}");
    let mut cooldowns = BTreeMap::<String, i64>::new();
    let mut last_outcome = IdleBatchExecutionResult {
        result: "draw".to_string(),
        round_count: 0,
        exp_gained: 0,
        silver_gained: 0,
    };
    for _ in 0..32 {
        for value in cooldowns.values_mut() {
            *value = value.saturating_sub(1);
        }
        let Some(target_id) = state
            .teams
            .defender
            .units
            .iter()
            .find(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
        else {
            break;
        };
        let selected_skill_id = select_idle_skill_id_for_action(snapshot, &state, &cooldowns);
        consume_idle_skill_cost(&mut state, character_id, selected_skill_id.as_str())?;
        let outcome = apply_minimal_pve_action(
            &mut state,
            character_id,
            selected_skill_id.as_str(),
            &[target_id],
        )?;
        if let Some(config) = idle_skill_runtime_config(selected_skill_id.as_str()) {
            if config.cooldown_turns > 0 {
                cooldowns.insert(selected_skill_id, config.cooldown_turns + 1);
            }
        }
        last_outcome = IdleBatchExecutionResult {
            result: outcome
                .result
                .clone()
                .unwrap_or_else(|| state.result.clone().unwrap_or_else(|| "draw".to_string())),
            round_count: state.round_count.max(1),
            exp_gained: outcome.exp_gained,
            silver_gained: outcome.silver_gained,
        };
        if outcome.finished {
            return Ok(last_outcome);
        }
        if let Some(partner) = snapshot.partner_member.as_ref() {
            if let Some(outcome) = apply_idle_partner_follow_up(&mut state, partner) {
                return Ok(outcome);
            }
        }
    }
    Ok(last_outcome)
}

fn select_idle_skill_id_for_action(
    snapshot: &IdleExecutionSnapshot,
    state: &BattleStateDto,
    cooldowns: &BTreeMap<String, i64>,
) -> String {
    let player_id = state.current_unit_id.as_deref().unwrap_or_default();
    let player = state
        .teams
        .attacker
        .units
        .iter()
        .find(|unit| unit.id == player_id && unit.is_alive);
    let Some(player) = player else {
        return snapshot.resolved_skill_id.clone();
    };

    let mut ordered_policy_skills = snapshot
        .auto_skill_policy
        .get("slots")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|slot| {
            let skill_id = slot.get("skillId")?.as_str()?.trim().to_string();
            if skill_id.is_empty() {
                return None;
            }
            let priority = slot.get("priority").and_then(|value| value.as_i64()).unwrap_or(i64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    ordered_policy_skills.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

    for (_, skill_id) in ordered_policy_skills {
        let Some(config) = idle_skill_runtime_config(skill_id.as_str()) else {
            continue;
        };
        if cooldowns.get(skill_id.as_str()).copied().unwrap_or_default() > 0 {
            continue;
        }
        if player.lingqi < config.cost_lingqi.max(0) {
            continue;
        }
        if player.qixue <= config.cost_qixue.max(0) {
            continue;
        }
        return skill_id;
    }

    snapshot.resolved_skill_id.clone()
}

fn consume_idle_skill_cost(
    state: &mut BattleStateDto,
    actor_character_id: i64,
    skill_id: &str,
) -> Result<(), String> {
    let Some(config) = idle_skill_runtime_config(skill_id) else {
        return Ok(());
    };
    let player_id = format!("player-{actor_character_id}");
    let Some(player) = state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == player_id && unit.is_alive)
    else {
        return Err("当前不可行动".to_string());
    };
    if player.lingqi < config.cost_lingqi.max(0) {
        return Err("灵气不足".to_string());
    }
    if player.qixue <= config.cost_qixue.max(0) {
        return Err("气血不足".to_string());
    }
    player.lingqi = (player.lingqi - config.cost_lingqi.max(0)).max(0);
    player.qixue = (player.qixue - config.cost_qixue.max(0)).max(1);
    Ok(())
}

fn idle_skill_runtime_config(skill_id: &str) -> Option<IdleSkillRuntimeConfig> {
    match skill_id.trim() {
        "sk-basic-slash" => Some(IdleSkillRuntimeConfig { cost_lingqi: 0, cost_qixue: 0, cooldown_turns: 0 }),
        "sk-heavy-slash" => Some(IdleSkillRuntimeConfig { cost_lingqi: 20, cost_qixue: 0, cooldown_turns: 1 }),
        "sk-bite" => Some(IdleSkillRuntimeConfig { cost_lingqi: 5, cost_qixue: 0, cooldown_turns: 1 }),
        _ => None,
    }
}

pub fn resolve_idle_skill_id(auto_skill_policy: &serde_json::Value) -> String {
    let slots = auto_skill_policy
        .get("slots")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut resolved = slots
        .into_iter()
        .filter_map(|slot| {
            let skill_id = slot.get("skillId")?.as_str()?.trim().to_string();
            if skill_id.is_empty() {
                return None;
            }
            let priority = slot
                .get("priority")
                .and_then(|value| value.as_i64())
                .unwrap_or(i64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    resolved.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    resolved
        .into_iter()
        .map(|(_, skill_id)| skill_id)
        .next()
        .unwrap_or_else(|| "sk-basic-slash".to_string())
}

fn load_room_monster_ids(
    map_id: &str,
    room_id: &str,
    target_monster_def_id: &str,
) -> Result<Vec<String>, String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read map_def.json: {error}"))?;
    let payload: MapSeedFile = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse map_def.json: {error}"))?;
    let Some(map) = payload
        .maps
        .into_iter()
        .find(|map| map.id == map_id && map.enabled != Some(false))
    else {
        return Err(format!("map not found: {map_id}"));
    };
    let Some(room) = map.rooms.into_iter().find(|room| room.id == room_id) else {
        return Err(format!("room not found: {room_id}"));
    };
    let monster_ids = room
        .monsters
        .into_iter()
        .filter(|monster| monster.monster_def_id.trim() == target_monster_def_id.trim())
        .flat_map(|monster| {
            let count = monster.count.unwrap_or(1).max(1) as usize;
            std::iter::repeat_n(monster.monster_def_id.trim().to_string(), count)
        })
        .collect::<Vec<_>>();
    if monster_ids.is_empty() {
        return Err(format!(
            "target monster not found in room: {target_monster_def_id}"
        ));
    }
    Ok(monster_ids)
}

fn apply_idle_partner_follow_up(
    state: &mut BattleStateDto,
    partner: &IdlePartnerExecutionSnapshot,
) -> Option<IdleBatchExecutionResult> {
    let partner_unit_id = format!("partner-{}", partner.partner_id);
    if !state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == partner_unit_id && unit.is_alive)
    {
        return None;
    }
    let target = state
        .teams
        .defender
        .units
        .iter_mut()
        .find(|unit| unit.is_alive)?;
    target.qixue = (target.qixue - partner.attack_power.max(1)).max(0);
    target.is_alive = target.qixue > 0;
    let enemy_alive = state.teams.defender.units.iter().any(|unit| unit.is_alive);
    if enemy_alive {
        return None;
    }
    let (exp_gained, silver_gained) =
        state
            .teams
            .defender
            .units
            .iter()
            .fold((0_i64, 0_i64), |(exp, silver), unit| {
                (
                    exp.saturating_add(unit.reward_exp.unwrap_or_default().max(0)),
                    silver.saturating_add(unit.reward_silver.unwrap_or_default().max(0)),
                )
            });
    state.phase = "finished".to_string();
    state.result = Some("attacker_win".to_string());
    state.current_unit_id = None;
    Some(IdleBatchExecutionResult {
        result: "attacker_win".to_string(),
        round_count: state.round_count.max(1),
        exp_gained,
        silver_gained,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{
        build_idle_execution_snapshot, build_idle_reconcile_plan, execute_idle_batch_from_snapshot,
        resolve_idle_skill_id, IdleExecutionRegistry, IdlePartnerExecutionSnapshot,
        IdleSessionActivitySnapshot,
    };

    #[test]
    fn stopping_without_heartbeat_is_interrupted() {
        let sessions = vec![IdleSessionActivitySnapshot {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "stopping".to_string(),
            started_at_ms: 1000,
            max_duration_ms: 3600_000,
        }];

        let plan = build_idle_reconcile_plan(&sessions, 10_000, &BTreeMap::new(), 45_000);

        assert_eq!(plan.interrupt_session_ids, vec!["idle-1".to_string()]);
        assert!(plan.complete_session_ids.is_empty());
    }

    #[test]
    fn stopping_with_fresh_heartbeat_is_kept() {
        let sessions = vec![IdleSessionActivitySnapshot {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "stopping".to_string(),
            started_at_ms: 1000,
            max_duration_ms: 3600_000,
        }];
        let mut heartbeats = BTreeMap::new();
        heartbeats.insert("idle-1".to_string(), 9_000);

        let plan = build_idle_reconcile_plan(&sessions, 10_000, &heartbeats, 45_000);

        assert!(plan.interrupt_session_ids.is_empty());
        assert!(plan.complete_session_ids.is_empty());
    }

    #[test]
    fn expired_active_is_completed() {
        let sessions = vec![IdleSessionActivitySnapshot {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "active".to_string(),
            started_at_ms: 1_000,
            max_duration_ms: 1_000,
        }];

        let plan = build_idle_reconcile_plan(&sessions, 2_100, &BTreeMap::new(), 45_000);

        assert_eq!(plan.complete_session_ids, vec!["idle-1".to_string()]);
        assert!(plan.interrupt_session_ids.is_empty());
    }

    #[test]
    fn expired_active_with_fresh_heartbeat_is_kept() {
        let sessions = vec![IdleSessionActivitySnapshot {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "active".to_string(),
            started_at_ms: 1_000,
            max_duration_ms: 1_000,
        }];
        let mut heartbeats = BTreeMap::new();
        heartbeats.insert("idle-1".to_string(), 2_000);

        let plan = build_idle_reconcile_plan(&sessions, 2_100, &heartbeats, 45_000);

        assert!(plan.complete_session_ids.is_empty());
        assert!(plan.interrupt_session_ids.is_empty());
    }

    #[test]
    fn active_before_deadline_is_kept() {
        let sessions = vec![IdleSessionActivitySnapshot {
            id: "idle-1".to_string(),
            character_id: 1,
            status: "active".to_string(),
            started_at_ms: 1_000,
            max_duration_ms: 10_000,
        }];

        let plan = build_idle_reconcile_plan(&sessions, 2_000, &BTreeMap::new(), 45_000);

        assert!(plan.complete_session_ids.is_empty());
        assert!(plan.interrupt_session_ids.is_empty());
    }

    #[test]
    fn idle_execution_registry_registers_touches_and_removes() {
        let registry = IdleExecutionRegistry::default();
        assert!(!registry.has_session("idle-1"));
        registry.register("idle-1", 1000);
        assert!(registry.has_session("idle-1"));
        assert_eq!(registry.snapshot().get("idle-1"), Some(&1000));

        registry.touch("idle-1", 2000);
        assert_eq!(registry.snapshot().get("idle-1"), Some(&2000));

        registry.remove("idle-1");
        assert!(registry.snapshot().get("idle-1").is_none());

        registry.request_stop("idle-2");
        assert!(registry.is_stop_requested("idle-2"));
        registry.remove("idle-2");
        assert!(!registry.is_stop_requested("idle-2"));

        registry.set_lock_token(1, "token-1".to_string());
        assert_eq!(registry.get_lock_token(1).as_deref(), Some("token-1"));
        registry.clear_lock_token(1);
        assert!(registry.get_lock_token(1).is_none());
    }

    #[test]
    fn build_idle_execution_snapshot_freezes_monster_ids_and_resolved_skill() {
        let snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1}]}),
            None,
        )
        .expect("snapshot should build");
        assert_eq!(snapshot.resolved_skill_id, "sk-heavy-slash");
        assert_eq!(
            snapshot.monster_ids,
            vec![
                "monster-wild-rabbit".to_string(),
                "monster-wild-rabbit".to_string(),
                "monster-wild-rabbit".to_string(),
            ]
        );
        assert_eq!(snapshot.initial_battle_state.battle_type, "pve");
    }

    #[test]
    fn execute_idle_batch_from_snapshot_replays_until_finished() {
        let snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1}]}),
            None,
        )
        .expect("snapshot should build");
        let result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &snapshot)
            .expect("batch should execute");
        assert_eq!(result.result, "attacker_win");
        assert!(result.round_count >= 1);
        assert!(result.exp_gained > 0);
        assert!(result.silver_gained > 0);
    }

    #[test]
    fn execute_idle_batch_from_snapshot_uses_frozen_skill_id() {
        let basic = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-basic-slash","priority":1}]}),
            None,
        )
        .expect("basic snapshot should build");
        let heavy = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1}]}),
            None,
        )
        .expect("heavy snapshot should build");
        let basic_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &basic)
            .expect("basic batch should execute");
        let heavy_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &heavy)
            .expect("heavy batch should execute");
        assert!(heavy_result.round_count <= basic_result.round_count);
    }

    #[test]
    fn execute_idle_batch_from_snapshot_falls_back_when_priority_skill_lacks_lingqi() {
        let mut snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1},{"skillId":"sk-basic-slash","priority":2}]}),
            None,
        )
        .expect("snapshot should build");
        snapshot.initial_battle_state.teams.attacker.units[0].lingqi = 0;
        let result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &snapshot)
            .expect("batch should execute");
        assert_eq!(result.result, "attacker_win");
        assert!(result.round_count >= 1);
    }

    #[test]
    fn execute_idle_batch_from_snapshot_uses_lower_priority_skill_when_top_skill_is_cooling_down() {
        let mut snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1},{"skillId":"sk-basic-slash","priority":2}]}),
            None,
        )
        .expect("snapshot should build");
        snapshot.initial_battle_state.teams.defender.units = vec![
            snapshot.initial_battle_state.teams.defender.units[0].clone(),
            snapshot.initial_battle_state.teams.defender.units[0].clone(),
        ];
        snapshot.initial_battle_state.teams.defender.units[0].id = "monster-1-monster-wild-rabbit".to_string();
        snapshot.initial_battle_state.teams.defender.units[1].id = "monster-2-monster-wild-rabbit".to_string();
        snapshot.initial_battle_state.teams.defender.units[1].qixue = 60;
        snapshot.initial_battle_state.teams.defender.units[1].current_attrs.max_qixue = 60;
        let result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &snapshot)
            .expect("batch should execute");
        assert_eq!(result.result, "attacker_win");
        assert!(result.round_count >= 2);
    }

    #[test]
    fn resolve_idle_skill_id_uses_priority_then_falls_back() {
        assert_eq!(
            resolve_idle_skill_id(
                &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":2},{"skillId":"sk-basic-slash","priority":1}]})
            ),
            "sk-basic-slash"
        );
        assert_eq!(
            resolve_idle_skill_id(&serde_json::json!({"slots":[]})),
            "sk-basic-slash"
        );
    }

    #[test]
    fn build_idle_execution_snapshot_carries_partner_member() {
        let snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-basic-slash","priority":1}]}),
            Some(IdlePartnerExecutionSnapshot {
                partner_id: 9,
                name: "青木小偶".to_string(),
                avatar: None,
                max_qixue: 60,
                attack_power: 20,
                speed: 3,
            }),
        )
        .expect("snapshot should build");
        assert!(snapshot.partner_member.is_some());
        assert!(snapshot
            .initial_battle_state
            .teams
            .attacker
            .units
            .iter()
            .any(|unit| unit.id == "partner-9"));
    }

    #[test]
    fn execute_idle_batch_from_snapshot_partner_can_finish_faster() {
        let without_partner = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-basic-slash","priority":1}]}),
            None,
        )
        .expect("snapshot should build");
        let with_partner = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"sk-basic-slash","priority":1}]}),
            Some(IdlePartnerExecutionSnapshot {
                partner_id: 9,
                name: "青木小偶".to_string(),
                avatar: None,
                max_qixue: 60,
                attack_power: 20,
                speed: 3,
            }),
        )
        .expect("snapshot should build");
        let basic_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &without_partner)
            .expect("batch should execute");
        let partner_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &with_partner)
            .expect("batch should execute");
        assert!(partner_result.round_count <= basic_result.round_count);
    }
}
