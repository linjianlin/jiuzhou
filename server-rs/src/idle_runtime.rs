use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::battle_runtime::{
    BattleStateDto, BattleUnitCurrentAttrsDto, BattleUnitDto, build_minimal_partner_battle_unit,
    build_minimal_pve_battle_state,
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
    pub attrs: BattleUnitCurrentAttrsDto,
    pub qixue: i64,
    pub lingqi: i64,
    pub skills: Vec<serde_json::Value>,
    pub skill_policy: serde_json::Value,
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
        initial_battle_state.teams.attacker.total_speed += partner.attrs.sudu.max(1);
        initial_battle_state.teams.attacker.units.insert(
            0,
            build_minimal_partner_battle_unit(
                partner.partner_id,
                partner.name.clone(),
                partner.avatar.clone(),
                format!("player-{character_id}"),
                partner.attrs.clone(),
                partner.qixue,
                partner.lingqi,
                partner.skills.clone(),
                partner.skill_policy.clone(),
                0,
            ),
        );
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
    _character_id: i64,
    batch_index: i64,
    snapshot: &IdleExecutionSnapshot,
) -> Result<IdleBatchExecutionResult, String> {
    let mut state = snapshot.initial_battle_state.clone();
    state.battle_id = format!("{session_id}-batch-{batch_index}");
    start_idle_battle(&mut state);
    let mut last_result = "draw".to_string();
    for _ in 0..256 {
        if let Some(result) = finish_idle_battle_if_needed(&mut state) {
            return Ok(build_idle_batch_result_from_state(&state, result.as_str()));
        }
        let Some(actor_unit_id) = state.current_unit_id.clone() else {
            advance_idle_round(&mut state);
            continue;
        };
        let skill_id = select_idle_unit_skill_id(snapshot, &state, actor_unit_id.as_str());
        apply_idle_unit_action(&mut state, actor_unit_id.as_str(), skill_id.as_str())?;
        if let Some(result) = finish_idle_battle_if_needed(&mut state) {
            return Ok(build_idle_batch_result_from_state(&state, result.as_str()));
        }
        last_result = state.result.clone().unwrap_or_else(|| "draw".to_string());
        advance_idle_action(&mut state, actor_unit_id.as_str());
    }
    Ok(build_idle_batch_result_from_state(
        &state,
        last_result.as_str(),
    ))
}

fn select_idle_unit_skill_id(
    snapshot: &IdleExecutionSnapshot,
    state: &BattleStateDto,
    actor_unit_id: &str,
) -> String {
    let Some(actor) = state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .find(|unit| unit.id == actor_unit_id && unit.is_alive)
    else {
        return "skill-normal-attack".to_string();
    };
    if actor.r#type == "player" {
        return select_idle_player_skill_id(snapshot, state, actor);
    }
    if actor.r#type == "partner" {
        return select_idle_partner_skill_id(state, actor);
    }
    select_idle_ai_skill_id(state, actor)
}

fn select_idle_player_skill_id(
    snapshot: &IdleExecutionSnapshot,
    state: &BattleStateDto,
    actor: &BattleUnitDto,
) -> String {
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
            let priority = slot
                .get("priority")
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite())
                .unwrap_or(f64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    ordered_policy_skills.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });

    for (_, skill_id) in ordered_policy_skills {
        if idle_unit_can_use_skill(state, actor, skill_id.as_str()) {
            return skill_id;
        }
    }

    "skill-normal-attack".to_string()
}

fn select_idle_partner_skill_id(state: &BattleStateDto, actor: &BattleUnitDto) -> String {
    let mut slots = actor
        .partner_skill_policy
        .as_ref()
        .and_then(|policy| policy.get("slots"))
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|slot| slot.get("enabled").and_then(|value| value.as_bool()) == Some(true))
        .filter_map(|slot| {
            let skill_id = slot.get("skillId")?.as_str()?.trim().to_string();
            if skill_id.is_empty() {
                return None;
            }
            let priority = slot
                .get("priority")
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite())
                .unwrap_or(f64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    slots.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    for (_, skill_id) in slots {
        if idle_unit_can_use_skill(state, actor, skill_id.as_str()) {
            return skill_id;
        }
    }
    select_idle_ai_skill_id(state, actor)
}

fn select_idle_ai_skill_id(state: &BattleStateDto, actor: &BattleUnitDto) -> String {
    for skill in &actor.skills {
        let Some(skill_id) = skill.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        if skill_id == "skill-normal-attack" {
            continue;
        }
        if idle_unit_can_use_skill(state, actor, skill_id) {
            return skill_id.to_string();
        }
    }
    "skill-normal-attack".to_string()
}

fn idle_unit_can_use_skill(state: &BattleStateDto, actor: &BattleUnitDto, skill_id: &str) -> bool {
    if state
        .runtime_skill_cooldowns
        .get(format!("{}:{skill_id}", actor.id).as_str())
        .copied()
        .unwrap_or_default()
        > 0
    {
        return false;
    }
    let Some(config) = idle_skill_runtime_config_for_unit(actor, skill_id) else {
        return false;
    };
    actor.lingqi >= config.cost_lingqi.max(0) && actor.qixue > config.cost_qixue.max(0)
}

fn idle_skill_runtime_config_for_unit(
    actor: &BattleUnitDto,
    skill_id: &str,
) -> Option<IdleSkillRuntimeConfig> {
    if let Some(config) = idle_skill_runtime_config(skill_id) {
        return Some(config);
    }
    let skill = actor
        .skills
        .iter()
        .find(|skill| skill.get("id").and_then(|value| value.as_str()) == Some(skill_id.trim()))?;
    Some(IdleSkillRuntimeConfig {
        cost_lingqi: read_skill_i64(skill, "cost_lingqi", "costLingqi")
            .or_else(|| {
                skill
                    .get("cost")
                    .and_then(|cost| read_json_i64(cost.get("lingqi")))
            })
            .unwrap_or_default(),
        cost_qixue: read_skill_i64(skill, "cost_qixue", "costQixue")
            .or_else(|| {
                skill
                    .get("cost")
                    .and_then(|cost| read_json_i64(cost.get("qixue")))
            })
            .unwrap_or_default(),
        cooldown_turns: read_skill_i64(skill, "cooldown", "cooldown").unwrap_or_default(),
    })
}

fn read_skill_i64(skill: &serde_json::Value, snake_key: &str, camel_key: &str) -> Option<i64> {
    read_json_i64(skill.get(snake_key)).or_else(|| read_json_i64(skill.get(camel_key)))
}

fn read_json_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_f64().map(|number| number.floor() as i64))
            .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
    })
}

fn read_json_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_i64().map(|number| number as f64))
            .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
            .filter(|number| number.is_finite())
    })
}

fn read_json_str<'a>(
    value: &'a serde_json::Value,
    snake_key: &str,
    camel_key: &str,
) -> Option<&'a str> {
    value
        .get(snake_key)
        .and_then(|value| value.as_str())
        .or_else(|| value.get(camel_key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn start_idle_battle(state: &mut BattleStateDto) {
    state.round_count = 1;
    state.result = None;
    state.phase = "action".to_string();
    reset_idle_units_for_round(state);
    refresh_idle_round_action_order(state);
    state.current_unit_id = first_idle_actable_unit_id(state, state.current_team.as_str());
}

fn reset_idle_units_for_round(state: &mut BattleStateDto) {
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        unit.can_act = unit.is_alive;
        if unit.is_alive {
            unit.qixue = unit.qixue.clamp(0, unit.current_attrs.max_qixue.max(1));
            unit.lingqi = unit.lingqi.clamp(0, unit.current_attrs.max_lingqi.max(0));
        }
    }
}

fn refresh_idle_round_action_order(state: &mut BattleStateDto) {
    state.teams.attacker.total_speed = state
        .teams
        .attacker
        .units
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.current_attrs.sudu.max(0))
        .sum();
    state.teams.defender.total_speed = state
        .teams
        .defender
        .units
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.current_attrs.sudu.max(0))
        .sum();
    state
        .teams
        .attacker
        .units
        .sort_by(|left, right| right.current_attrs.sudu.cmp(&left.current_attrs.sudu));
    state
        .teams
        .defender
        .units
        .sort_by(|left, right| right.current_attrs.sudu.cmp(&left.current_attrs.sudu));
    state.first_mover = if state.teams.defender.total_speed > state.teams.attacker.total_speed {
        "defender".to_string()
    } else {
        "attacker".to_string()
    };
    state.current_team = state.first_mover.clone();
}

fn apply_idle_unit_action(
    state: &mut BattleStateDto,
    actor_unit_id: &str,
    skill_id: &str,
) -> Result<(), String> {
    let actor_team = idle_unit_team(state, actor_unit_id)
        .ok_or_else(|| format!("行动单位不存在: {actor_unit_id}"))?;
    let target_team = if actor_team == "attacker" {
        "defender"
    } else {
        "attacker"
    };
    let config = {
        let actor = idle_find_unit(state, actor_unit_id)
            .ok_or_else(|| format!("行动单位不存在: {actor_unit_id}"))?;
        idle_skill_runtime_config_for_unit(actor, skill_id)
            .ok_or_else(|| format!("战斗技能不存在: {skill_id}"))?
    };
    {
        let actor = idle_find_unit_mut(state, actor_unit_id)
            .ok_or_else(|| format!("行动单位不存在: {actor_unit_id}"))?;
        if actor.lingqi < config.cost_lingqi.max(0) {
            return Err("灵气不足".to_string());
        }
        if actor.qixue <= config.cost_qixue.max(0) {
            return Err("气血不足".to_string());
        }
        actor.lingqi = (actor.lingqi - config.cost_lingqi.max(0)).max(0);
        actor.qixue = (actor.qixue - config.cost_qixue.max(0)).max(1);
    }
    let target_unit_ids = select_idle_target_unit_ids(state, target_team, actor_unit_id, skill_id)?;
    let mut total_damage = 0_i64;
    let mut kill_count = 0_i64;
    for target_unit_id in target_unit_ids {
        let damage =
            resolve_idle_unit_skill_damage(state, actor_unit_id, skill_id, &target_unit_id)?;
        let actual_damage = {
            let target = idle_find_unit_mut(state, &target_unit_id)
                .ok_or_else(|| format!("目标不存在: {target_unit_id}"))?;
            let before = target.qixue.max(0);
            target.qixue = (target.qixue - damage.max(0)).max(0);
            target.is_alive = target.qixue > 0;
            target.can_act = target.can_act && target.is_alive;
            before - target.qixue
        };
        total_damage = total_damage.saturating_add(actual_damage.max(0));
        if actual_damage > 0 && !idle_unit_is_alive(state, &target_unit_id) {
            kill_count = kill_count.saturating_add(1);
        }
    }
    if let Some(actor) = idle_find_unit_mut(state, actor_unit_id) {
        actor.stats.damage_dealt = actor.stats.damage_dealt.saturating_add(total_damage.max(0));
        actor.stats.kill_count = actor.stats.kill_count.saturating_add(kill_count.max(0));
    }
    if config.cooldown_turns > 0 {
        state.runtime_skill_cooldowns.insert(
            format!("{actor_unit_id}:{skill_id}"),
            config.cooldown_turns + 1,
        );
    }
    sync_idle_unit_cooldowns(state);
    Ok(())
}

fn select_idle_target_unit_ids(
    state: &BattleStateDto,
    target_team: &str,
    actor_unit_id: &str,
    skill_id: &str,
) -> Result<Vec<String>, String> {
    let actor = idle_find_unit(state, actor_unit_id)
        .ok_or_else(|| format!("行动单位不存在: {actor_unit_id}"))?;
    let skill = actor
        .skills
        .iter()
        .find(|skill| skill.get("id").and_then(|value| value.as_str()) == Some(skill_id.trim()));
    let target_type = skill
        .and_then(|skill| read_json_str(skill, "target_type", "targetType"))
        .unwrap_or("single_enemy");
    let target_count = skill
        .and_then(|skill| read_skill_i64(skill, "target_count", "targetCount"))
        .unwrap_or(1)
        .max(1) as usize;
    let alive_targets = idle_team_units(state, target_team)
        .ok_or_else(|| "目标队伍不存在".to_string())?
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>();
    if alive_targets.is_empty() {
        return Err("没有有效目标".to_string());
    }
    if target_type == "all_enemy" {
        return Ok(alive_targets);
    }
    Ok(alive_targets.into_iter().take(target_count).collect())
}

fn resolve_idle_unit_skill_damage(
    state: &BattleStateDto,
    actor_unit_id: &str,
    skill_id: &str,
    target_unit_id: &str,
) -> Result<i64, String> {
    let actor = idle_find_unit(state, actor_unit_id)
        .ok_or_else(|| format!("行动单位不存在: {actor_unit_id}"))?;
    let target = idle_find_unit(state, target_unit_id)
        .ok_or_else(|| format!("目标不存在: {target_unit_id}"))?;
    let skill = actor
        .skills
        .iter()
        .find(|skill| skill.get("id").and_then(|value| value.as_str()) == Some(skill_id.trim()));
    let raw_damage = skill
        .and_then(|skill| resolve_idle_skill_effect_damage(actor, target, skill))
        .unwrap_or_else(|| resolve_idle_default_skill_damage(actor, skill_id));
    let damage_type = skill
        .and_then(|skill| read_json_str(skill, "damage_type", "damageType"))
        .unwrap_or("physical");
    Ok(apply_idle_defense_reduction(raw_damage.max(1), target, damage_type).max(1))
}

fn resolve_idle_skill_effect_damage(
    actor: &BattleUnitDto,
    target: &BattleUnitDto,
    skill: &serde_json::Value,
) -> Option<i64> {
    let damage_type = read_json_str(skill, "damage_type", "damageType").unwrap_or("physical");
    let fallback_scale_attr = if damage_type == "magic" {
        "fagong"
    } else {
        "wugong"
    };
    let effects = skill.get("effects")?.as_array()?;
    let mut total = 0_i64;
    for effect in effects {
        if effect.get("type").and_then(|value| value.as_str()) != Some("damage") {
            continue;
        }
        let value_type = read_json_str(effect, "value_type", "valueType").unwrap_or("scale");
        let value = read_json_f64(effect.get("value")).unwrap_or_default();
        let scale_attr =
            read_json_str(effect, "scale_attr", "scaleAttr").unwrap_or(fallback_scale_attr);
        let scale_rate = read_json_f64(effect.get("scaleRate"))
            .or_else(|| read_json_f64(effect.get("scale_rate")))
            .unwrap_or(value);
        let base = match value_type {
            "flat" => value.floor() as i64,
            "percent" => (target.current_attrs.max_qixue as f64 * value).floor() as i64,
            "combined" => {
                let base_value = read_json_f64(effect.get("baseValue"))
                    .or_else(|| read_json_f64(effect.get("base_value")))
                    .unwrap_or_default();
                (base_value + idle_attr_value(actor, scale_attr) as f64 * scale_rate).floor() as i64
            }
            "scale" => (idle_attr_value(actor, scale_attr) as f64 * scale_rate).floor() as i64,
            _ => value.floor() as i64,
        };
        let hit_count = read_json_i64(effect.get("hit_count"))
            .or_else(|| read_json_i64(effect.get("hitCount")))
            .unwrap_or(1)
            .max(1);
        total = total.saturating_add(base.max(0).saturating_mul(hit_count));
    }
    (total > 0).then_some(total)
}

fn idle_attr_value(unit: &BattleUnitDto, attr: &str) -> i64 {
    match attr {
        "max_qixue" => unit.current_attrs.max_qixue,
        "max_lingqi" => unit.current_attrs.max_lingqi,
        "wugong" => unit.current_attrs.wugong,
        "fagong" => unit.current_attrs.fagong,
        "wufang" => unit.current_attrs.wufang,
        "fafang" => unit.current_attrs.fafang,
        "sudu" => unit.current_attrs.sudu,
        _ => 0,
    }
}

fn resolve_idle_default_skill_damage(actor: &BattleUnitDto, skill_id: &str) -> i64 {
    match skill_id.trim() {
        "sk-heavy-slash" => (actor.current_attrs.wugong as f64 * 1.3).floor() as i64,
        "sk-bite" => actor.current_attrs.wugong.max(1),
        "skill-normal-attack" => actor
            .current_attrs
            .wugong
            .max(actor.current_attrs.fagong)
            .max(1),
        _ => actor
            .current_attrs
            .wugong
            .max(actor.current_attrs.fagong)
            .max(1),
    }
}

fn apply_idle_defense_reduction(raw_damage: i64, target: &BattleUnitDto, damage_type: &str) -> i64 {
    if damage_type == "true" {
        return raw_damage.max(0);
    }
    let defense = if damage_type == "magic" {
        target.current_attrs.fafang
    } else {
        target.current_attrs.wufang
    }
    .max(0) as f64;
    let reduced = raw_damage as f64 * (1200.0 / (defense + 1200.0));
    reduced.floor() as i64
}

fn advance_idle_action(state: &mut BattleStateDto, actor_unit_id: &str) {
    if let Some(actor) = idle_find_unit_mut(state, actor_unit_id) {
        if actor.is_alive {
            actor.can_act = false;
        }
    }
    tick_idle_runtime_cooldowns(state);
    let current_team = state.current_team.clone();
    let current_idx = idle_team_units(state, current_team.as_str())
        .and_then(|units| units.iter().position(|unit| unit.id == actor_unit_id))
        .map(|idx| idx as isize)
        .unwrap_or(-1);
    if let Some(next_id) =
        next_idle_actable_unit_id_after(state, current_team.as_str(), current_idx)
    {
        state.current_unit_id = Some(next_id);
        return;
    }
    let second_mover = if state.first_mover == "attacker" {
        "defender"
    } else {
        "attacker"
    };
    if state.current_team == state.first_mover {
        state.current_team = second_mover.to_string();
        state.current_unit_id = first_idle_actable_unit_id(state, second_mover);
        if state.current_unit_id.is_some() {
            return;
        }
    }
    advance_idle_round(state);
}

fn advance_idle_round(state: &mut BattleStateDto) {
    if finish_idle_battle_if_needed(state).is_some() {
        return;
    }
    if state.round_count >= 32 {
        state.phase = "finished".to_string();
        state.result = Some("draw".to_string());
        state.current_unit_id = None;
        return;
    }
    state.round_count += 1;
    reset_idle_units_for_round(state);
    refresh_idle_round_action_order(state);
    state.current_unit_id = first_idle_actable_unit_id(state, state.current_team.as_str());
}

fn tick_idle_runtime_cooldowns(state: &mut BattleStateDto) {
    for value in state.runtime_skill_cooldowns.values_mut() {
        *value = value.saturating_sub(1);
    }
    state.runtime_skill_cooldowns.retain(|_, value| *value > 0);
    sync_idle_unit_cooldowns(state);
}

fn sync_idle_unit_cooldowns(state: &mut BattleStateDto) {
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        unit.skill_cooldowns.clear();
    }
    for (key, remaining) in state.runtime_skill_cooldowns.clone() {
        let Some((unit_id, skill_id)) = key.split_once(':') else {
            continue;
        };
        if let Some(unit) = idle_find_unit_mut(state, unit_id) {
            unit.skill_cooldowns.insert(skill_id.to_string(), remaining);
        }
    }
}

fn finish_idle_battle_if_needed(state: &mut BattleStateDto) -> Option<String> {
    let attacker_alive = state.teams.attacker.units.iter().any(|unit| unit.is_alive);
    let defender_alive = state.teams.defender.units.iter().any(|unit| unit.is_alive);
    let result = if attacker_alive && !defender_alive {
        Some("attacker_win")
    } else if !attacker_alive && defender_alive {
        Some("defender_win")
    } else if !attacker_alive && !defender_alive {
        Some("draw")
    } else {
        None
    }?;
    state.phase = "finished".to_string();
    state.result = Some(result.to_string());
    state.current_unit_id = None;
    Some(result.to_string())
}

fn build_idle_batch_result_from_state(
    state: &BattleStateDto,
    result: &str,
) -> IdleBatchExecutionResult {
    let (exp_gained, silver_gained) = if result == "attacker_win" {
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
            })
    } else {
        (0, 0)
    };
    IdleBatchExecutionResult {
        result: result.to_string(),
        round_count: state.round_count.max(1),
        exp_gained,
        silver_gained,
    }
}

fn idle_unit_team(state: &BattleStateDto, unit_id: &str) -> Option<&'static str> {
    if state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == unit_id)
    {
        Some("attacker")
    } else if state
        .teams
        .defender
        .units
        .iter()
        .any(|unit| unit.id == unit_id)
    {
        Some("defender")
    } else {
        None
    }
}

fn idle_team_units<'a>(state: &'a BattleStateDto, team: &str) -> Option<&'a [BattleUnitDto]> {
    match team {
        "attacker" => Some(&state.teams.attacker.units),
        "defender" => Some(&state.teams.defender.units),
        _ => None,
    }
}

fn idle_find_unit<'a>(state: &'a BattleStateDto, unit_id: &str) -> Option<&'a BattleUnitDto> {
    state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .find(|unit| unit.id == unit_id)
}

fn idle_find_unit_mut<'a>(
    state: &'a mut BattleStateDto,
    unit_id: &str,
) -> Option<&'a mut BattleUnitDto> {
    if let Some(index) = state
        .teams
        .attacker
        .units
        .iter()
        .position(|unit| unit.id == unit_id)
    {
        return state.teams.attacker.units.get_mut(index);
    }
    let index = state
        .teams
        .defender
        .units
        .iter()
        .position(|unit| unit.id == unit_id)?;
    state.teams.defender.units.get_mut(index)
}

fn idle_unit_is_alive(state: &BattleStateDto, unit_id: &str) -> bool {
    idle_find_unit(state, unit_id)
        .map(|unit| unit.is_alive)
        .unwrap_or(false)
}

fn first_idle_actable_unit_id(state: &BattleStateDto, team: &str) -> Option<String> {
    idle_team_units(state, team)?
        .iter()
        .find(|unit| unit.is_alive && unit.can_act)
        .map(|unit| unit.id.clone())
}

fn next_idle_actable_unit_id_after(
    state: &BattleStateDto,
    team: &str,
    current_idx: isize,
) -> Option<String> {
    idle_team_units(state, team)?
        .iter()
        .enumerate()
        .skip((current_idx + 1).max(0) as usize)
        .find(|(_, unit)| unit.is_alive && unit.can_act)
        .map(|(_, unit)| unit.id.clone())
}

fn idle_skill_runtime_config(skill_id: &str) -> Option<IdleSkillRuntimeConfig> {
    match skill_id.trim() {
        "skill-normal-attack" => Some(IdleSkillRuntimeConfig {
            cost_lingqi: 0,
            cost_qixue: 0,
            cooldown_turns: 0,
        }),
        "sk-heavy-slash" => Some(IdleSkillRuntimeConfig {
            cost_lingqi: 20,
            cost_qixue: 0,
            cooldown_turns: 1,
        }),
        "sk-bite" => Some(IdleSkillRuntimeConfig {
            cost_lingqi: 5,
            cost_qixue: 0,
            cooldown_turns: 1,
        }),
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
                .and_then(|value| value.as_f64())
                .filter(|value| value.is_finite())
                .unwrap_or(f64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    resolved.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    resolved
        .into_iter()
        .map(|(_, skill_id)| skill_id)
        .next()
        .unwrap_or_else(|| "skill-normal-attack".to_string())
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::battle_runtime::BattleUnitCurrentAttrsDto;

    use super::{
        IdleExecutionRegistry, IdlePartnerExecutionSnapshot, IdleSessionActivitySnapshot,
        build_idle_execution_snapshot, build_idle_reconcile_plan, execute_idle_batch_from_snapshot,
        resolve_idle_skill_id,
    };

    fn test_partner_snapshot() -> IdlePartnerExecutionSnapshot {
        IdlePartnerExecutionSnapshot {
            partner_id: 9,
            name: "青木小偶".to_string(),
            avatar: None,
            qixue: 60,
            lingqi: 0,
            attrs: BattleUnitCurrentAttrsDto {
                max_qixue: 60,
                max_lingqi: 0,
                wugong: 20,
                fagong: 0,
                wufang: 0,
                fafang: 0,
                sudu: 3,
                mingzhong: 0,
                shanbi: 0,
                zhaojia: 0,
                baoji: 0,
                baoshang: 0,
                jianbaoshang: 0,
                jianfantan: 0,
                kangbao: 0,
                zengshang: 0,
                zhiliao: 0,
                jianliao: 0,
                xixue: 0,
                lengque: 0,
                kongzhi_kangxing: 0,
                jin_kangxing: 0,
                mu_kangxing: 0,
                shui_kangxing: 0,
                huo_kangxing: 0,
                tu_kangxing: 0,
                qixue_huifu: 0,
                lingqi_huifu: 0,
                realm: None,
                element: Some("wood".to_string()),
            },
            skills: Vec::new(),
            skill_policy: serde_json::json!({ "slots": [] }),
        }
    }

    fn test_partner_snapshot_with_policy_skill() -> IdlePartnerExecutionSnapshot {
        let mut partner = test_partner_snapshot();
        partner.attrs.wugong = 1;
        partner.attrs.fagong = 240;
        partner.attrs.sudu = 100;
        partner.skills = vec![serde_json::json!({
            "id": "partner-burst",
            "name": "灵伴术击",
            "cost_lingqi": 0,
            "cost_qixue": 0,
            "cooldown": 0,
            "target_type": "all_enemy",
            "target_count": 3,
            "damage_type": "magic",
            "element": "wood",
            "effects": [{
                "type": "damage",
                "valueType": "scale",
                "scaleAttr": "fagong",
                "scaleRate": 1.0
            }]
        })];
        partner.skill_policy = serde_json::json!({
            "slots": [{"skillId": "partner-burst", "priority": 1, "enabled": true}]
        });
        partner
    }

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
            &serde_json::json!({"slots":[{"skillId":"skill-normal-attack","priority":1}]}),
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
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1},{"skillId":"skill-normal-attack","priority":2}]}),
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
            &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":1},{"skillId":"skill-normal-attack","priority":2}]}),
            None,
        )
        .expect("snapshot should build");
        snapshot.initial_battle_state.teams.defender.units = vec![
            snapshot.initial_battle_state.teams.defender.units[0].clone(),
            snapshot.initial_battle_state.teams.defender.units[0].clone(),
        ];
        snapshot.initial_battle_state.teams.defender.units[0].id =
            "monster-1-monster-wild-rabbit".to_string();
        snapshot.initial_battle_state.teams.defender.units[1].id =
            "monster-2-monster-wild-rabbit".to_string();
        snapshot.initial_battle_state.teams.defender.units[1].qixue = 60;
        snapshot.initial_battle_state.teams.defender.units[1]
            .current_attrs
            .max_qixue = 60;
        let result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &snapshot)
            .expect("batch should execute");
        assert_eq!(result.result, "attacker_win");
        assert!(result.round_count >= 2);
    }

    #[test]
    fn resolve_idle_skill_id_uses_priority_then_falls_back() {
        assert_eq!(
            resolve_idle_skill_id(
                &serde_json::json!({"slots":[{"skillId":"sk-heavy-slash","priority":2},{"skillId":"skill-normal-attack","priority":1}]})
            ),
            "skill-normal-attack"
        );
        assert_eq!(
            resolve_idle_skill_id(&serde_json::json!({"slots":[]})),
            "skill-normal-attack"
        );
    }

    #[test]
    fn build_idle_execution_snapshot_carries_partner_member() {
        let snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"skill-normal-attack","priority":1}]}),
            Some(test_partner_snapshot()),
        )
        .expect("snapshot should build");
        assert!(snapshot.partner_member.is_some());
        assert!(
            snapshot
                .initial_battle_state
                .teams
                .attacker
                .units
                .iter()
                .any(|unit| unit.id == "partner-9")
        );
    }

    #[test]
    fn execute_idle_batch_from_snapshot_partner_can_finish_faster() {
        let without_partner = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"skill-normal-attack","priority":1}]}),
            None,
        )
        .expect("snapshot should build");
        let with_partner = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"skill-normal-attack","priority":1}]}),
            Some(test_partner_snapshot()),
        )
        .expect("snapshot should build");
        let basic_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &without_partner)
            .expect("batch should execute");
        let partner_result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &with_partner)
            .expect("batch should execute");
        assert!(partner_result.round_count <= basic_result.round_count);
    }

    #[test]
    fn execute_idle_batch_from_snapshot_partner_uses_skill_policy_turn() {
        let snapshot = build_idle_execution_snapshot(
            1,
            "map-qingyun-outskirts",
            "room-south-forest",
            "monster-wild-rabbit",
            &serde_json::json!({"slots":[{"skillId":"skill-normal-attack","priority":1}]}),
            Some(test_partner_snapshot_with_policy_skill()),
        )
        .expect("snapshot should build");
        let result = execute_idle_batch_from_snapshot("idle-1", 1, 1, &snapshot)
            .expect("batch should execute");
        assert_eq!(result.result, "attacker_win");
        assert_eq!(result.round_count, 1);
    }
}
