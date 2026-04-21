use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleStateDto {
    pub battle_id: String,
    pub battle_type: String,
    pub cooldown_timing_mode: String,
    pub teams: BattleTeamsDto,
    pub round_count: i64,
    pub current_team: String,
    pub current_unit_id: Option<String>,
    pub phase: String,
    pub first_mover: String,
    pub result: Option<String>,
    pub random_seed: i64,
    pub random_index: i64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runtime_skill_cooldowns: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleTeamsDto {
    pub attacker: BattleTeamDto,
    pub defender: BattleTeamDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleTeamDto {
    pub odwner_id: Option<i64>,
    pub units: Vec<BattleUnitDto>,
    pub total_speed: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleUnitDto {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub source_id: serde_json::Value,
    pub base_attrs: BattleUnitCurrentAttrsDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formation_order: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_unit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub month_card_active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub qixue: i64,
    pub lingqi: i64,
    pub current_attrs: BattleUnitCurrentAttrsDto,
    pub shields: Vec<serde_json::Value>,
    pub is_alive: bool,
    pub can_act: bool,
    pub buffs: Vec<serde_json::Value>,
    pub marks: Vec<serde_json::Value>,
    pub momentum: Option<serde_json::Value>,
    pub set_bonus_effects: Vec<serde_json::Value>,
    pub skills: Vec<serde_json::Value>,
    pub skill_cooldowns: BTreeMap<String, i64>,
    pub skill_cooldown_discount_bank: BTreeMap<String, i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_skill_policy: Option<serde_json::Value>,
    pub control_diminishing: BTreeMap<String, serde_json::Value>,
    pub stats: BattleUnitStatsDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_exp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_silver: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BattleUnitCurrentAttrsDto {
    pub max_qixue: i64,
    pub max_lingqi: i64,
    pub wugong: i64,
    pub fagong: i64,
    pub wufang: i64,
    pub fafang: i64,
    pub sudu: i64,
    pub mingzhong: i64,
    pub shanbi: i64,
    pub zhaojia: i64,
    pub baoji: i64,
    pub baoshang: i64,
    pub jianbaoshang: i64,
    pub jianfantan: i64,
    pub kangbao: i64,
    pub zengshang: i64,
    pub zhiliao: i64,
    pub jianliao: i64,
    pub xixue: i64,
    pub lengque: i64,
    pub kongzhi_kangxing: i64,
    pub jin_kangxing: i64,
    pub mu_kangxing: i64,
    pub shui_kangxing: i64,
    pub huo_kangxing: i64,
    pub tu_kangxing: i64,
    pub qixue_huifu: i64,
    pub lingqi_huifu: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub realm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BattleUnitStatsDto {
    pub damage_dealt: i64,
    pub damage_taken: i64,
    pub healing_done: i64,
    pub healing_received: i64,
    pub kill_count: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BattleCharacterUnitProfile {
    pub character_id: i64,
    pub user_id: i64,
    pub name: String,
    pub month_card_active: bool,
    pub avatar: Option<String>,
    pub qixue: i64,
    pub lingqi: i64,
    pub attrs: BattleUnitCurrentAttrsDto,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinimalBattleActionOutcome {
    pub finished: bool,
    pub result: Option<String>,
    pub exp_gained: i64,
    pub silver_gained: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BattleSkillRuntimeConfig {
    cost_lingqi: i64,
    cost_qixue: i64,
    cooldown_turns: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MinimalBattleRewardItemDto {
    pub item_def_id: String,
    pub item_name: String,
    pub qty: i64,
    pub bind_type: String,
}

#[derive(Debug, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterSeed {
    id: Option<String>,
    name: Option<String>,
    #[serde(rename = "realm")]
    _realm: Option<String>,
    level: Option<i64>,
    exp_reward: Option<i64>,
    silver_reward_min: Option<i64>,
    base_attrs: Option<MonsterBaseAttrs>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattleRewardItemMeta {
    id: Option<String>,
    name: Option<String>,
    bind_type: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattleRewardItemFile {
    items: Vec<BattleRewardItemMeta>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattleDropPoolFile {
    pools: Vec<BattleDropPoolSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattleDropPoolSeed {
    id: Option<String>,
    mode: Option<String>,
    entries: Option<Vec<BattleDropPoolEntrySeed>>,
    common_pool_ids: Option<Vec<String>>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattleDropPoolEntrySeed {
    item_def_id: Option<String>,
    chance: Option<serde_json::Value>,
    qty_min: Option<serde_json::Value>,
    qty_max: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterBaseAttrs {
    qixue: Option<i64>,
    lingqi: Option<i64>,
    wugong: Option<i64>,
}

fn build_battle_attrs(
    max_qixue: i64,
    max_lingqi: i64,
    wugong: i64,
    sudu: i64,
    realm: Option<String>,
) -> BattleUnitCurrentAttrsDto {
    BattleUnitCurrentAttrsDto {
        max_qixue: max_qixue.max(1),
        max_lingqi: max_lingqi.max(0),
        wugong: wugong.max(0),
        fagong: 0,
        wufang: 0,
        fafang: 0,
        sudu: sudu.max(0),
        mingzhong: 100,
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
        realm,
        element: Some("none".to_string()),
    }
}

fn empty_battle_stats() -> BattleUnitStatsDto {
    BattleUnitStatsDto {
        damage_dealt: 0,
        damage_taken: 0,
        healing_done: 0,
        healing_received: 0,
        kill_count: 0,
    }
}

fn build_skill_value(
    id: &str,
    name: &str,
    cost_lingqi: i64,
    cost_qixue: i64,
    cooldown: i64,
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": name,
        "description": name,
        "type": "active",
        "damageType": "physical",
        "targetType": "single_enemy",
        "cost": {
            "lingqi": cost_lingqi.max(0),
            "qixue": cost_qixue.max(0)
        },
        "cooldown": cooldown.max(0),
        "effects": []
    })
}

fn player_battle_skills() -> Vec<serde_json::Value> {
    vec![
        build_skill_value("sk-basic-slash", "普通攻击", 0, 0, 0),
        build_skill_value("sk-heavy-slash", "重斩", 20, 0, 1),
    ]
}

fn monster_battle_skills() -> Vec<serde_json::Value> {
    vec![build_skill_value("sk-bite", "撕咬", 5, 0, 1)]
}

fn deterministic_battle_seed(battle_id: &str) -> i64 {
    let seed = battle_id.as_bytes().iter().fold(17_u64, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(u64::from(*byte))
    });
    (seed % i64::MAX as u64) as i64
}

pub fn refresh_battle_team_total_speed(state: &mut BattleStateDto) {
    state.teams.attacker.total_speed = state
        .teams
        .attacker
        .units
        .iter()
        .map(|unit| unit.current_attrs.sudu.max(0))
        .sum();
    state.teams.defender.total_speed = state
        .teams
        .defender
        .units
        .iter()
        .map(|unit| unit.current_attrs.sudu.max(0))
        .sum();
}

pub fn apply_character_profile_to_battle_state(
    state: &mut BattleStateDto,
    existing_unit_id: &str,
    unit_kind: &str,
    profile: &BattleCharacterUnitProfile,
) -> Option<String> {
    let normalized_kind = match unit_kind.trim() {
        "player" | "partner" | "npc" => unit_kind.trim(),
        _ => return None,
    };
    let next_unit_id = format!("{normalized_kind}-{}", profile.character_id);
    let mut found = false;
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        if unit.id != existing_unit_id {
            continue;
        }
        unit.id = next_unit_id.clone();
        unit.name = profile.name.clone();
        unit.r#type = normalized_kind.to_string();
        unit.source_id = serde_json::json!(profile.character_id);
        unit.base_attrs = profile.attrs.clone();
        unit.current_attrs = profile.attrs.clone();
        unit.qixue = profile.qixue.clamp(0, profile.attrs.max_qixue.max(1));
        unit.lingqi = profile.lingqi.clamp(0, profile.attrs.max_lingqi.max(0));
        unit.month_card_active = Some(profile.month_card_active);
        unit.avatar = if normalized_kind == "player" || normalized_kind == "partner" {
            profile.avatar.clone()
        } else {
            None
        };
        unit.is_alive = unit.qixue > 0;
        unit.can_act = unit.is_alive;
        found = true;
        break;
    }
    if !found {
        return None;
    }
    if state.current_unit_id.as_deref() == Some(existing_unit_id) {
        state.current_unit_id = Some(next_unit_id.clone());
    }
    let old_prefix = format!("{existing_unit_id}:");
    let cooldown_rewrites = state
        .runtime_skill_cooldowns
        .iter()
        .filter_map(|(key, value)| {
            key.strip_prefix(&old_prefix)
                .map(|skill_id| (key.clone(), format!("{next_unit_id}:{skill_id}"), *value))
        })
        .collect::<Vec<_>>();
    for (old_key, new_key, value) in cooldown_rewrites {
        state.runtime_skill_cooldowns.remove(&old_key);
        state.runtime_skill_cooldowns.insert(new_key, value);
    }
    sync_unit_skill_cooldowns_from_runtime(state);
    refresh_battle_team_total_speed(state);
    Some(next_unit_id)
}

pub fn build_minimal_pve_battle_state(
    battle_id: &str,
    player_character_id: i64,
    monster_ids: &[String],
) -> BattleStateDto {
    let attacker_attrs = build_battle_attrs(180, 100, 32, 6, Some("凡人".to_string()));
    let attacker = BattleUnitDto {
        id: format!("player-{}", player_character_id),
        name: format!("修士{}", player_character_id),
        r#type: "player".to_string(),
        source_id: serde_json::json!(player_character_id),
        base_attrs: attacker_attrs.clone(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 180,
        lingqi: 100,
        current_attrs: attacker_attrs,
        shields: Vec::new(),
        is_alive: true,
        can_act: true,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills: player_battle_skills(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    };
    let defender_units = monster_ids
        .iter()
        .enumerate()
        .map(|(index, monster_id)| {
            let seed = load_monster_seed(monster_id).ok();
            let qixue = seed
                .as_ref()
                .and_then(|seed| seed.base_attrs.as_ref())
                .and_then(|attrs| attrs.qixue)
                .unwrap_or(50)
                .max(1);
            let lingqi = seed
                .as_ref()
                .and_then(|seed| seed.base_attrs.as_ref())
                .and_then(|attrs| attrs.lingqi)
                .unwrap_or_default()
                .max(0);
            let wugong = seed
                .as_ref()
                .and_then(|seed| seed.base_attrs.as_ref())
                .and_then(|attrs| attrs.wugong)
                .unwrap_or(8)
                .max(0);
            let attrs = build_battle_attrs(
                qixue,
                lingqi,
                wugong,
                (qixue / 50 + 1).max(1),
                seed.as_ref()
                    .and_then(|seed| seed.level)
                    .map(|level| format!("Lv.{level}")),
            );
            BattleUnitDto {
                id: format!("monster-{}-{}", index + 1, monster_id),
                name: seed
                    .as_ref()
                    .and_then(|seed| seed.name.clone())
                    .unwrap_or_else(|| monster_id.clone()),
                r#type: "monster".to_string(),
                source_id: serde_json::json!(monster_id),
                base_attrs: attrs.clone(),
                formation_order: Some(index as i64 + 1),
                owner_unit_id: None,
                month_card_active: None,
                avatar: None,
                qixue,
                lingqi,
                current_attrs: attrs,
                shields: Vec::new(),
                is_alive: true,
                can_act: true,
                buffs: Vec::new(),
                marks: Vec::new(),
                momentum: None,
                set_bonus_effects: Vec::new(),
                skills: monster_battle_skills(),
                skill_cooldowns: BTreeMap::new(),
                skill_cooldown_discount_bank: BTreeMap::new(),
                partner_skill_policy: None,
                control_diminishing: BTreeMap::new(),
                stats: empty_battle_stats(),
                reward_exp: Some(
                    seed.as_ref()
                        .and_then(|seed| seed.exp_reward)
                        .unwrap_or_default()
                        .max(0),
                ),
                reward_silver: Some(
                    seed.as_ref()
                        .and_then(|seed| seed.silver_reward_min)
                        .unwrap_or_default()
                        .max(0),
                ),
            }
        })
        .collect::<Vec<_>>();

    BattleStateDto {
        battle_id: battle_id.to_string(),
        battle_type: "pve".to_string(),
        cooldown_timing_mode: "self_action_end".to_string(),
        teams: BattleTeamsDto {
            attacker: BattleTeamDto {
                odwner_id: Some(player_character_id),
                units: vec![attacker.clone()],
                total_speed: 6,
            },
            defender: BattleTeamDto {
                odwner_id: None,
                total_speed: defender_units
                    .iter()
                    .map(|unit| unit.current_attrs.max_qixue / 50 + 1)
                    .sum(),
                units: defender_units,
            },
        },
        round_count: 1,
        current_team: "attacker".to_string(),
        current_unit_id: Some(attacker.id),
        phase: "action".to_string(),
        first_mover: "attacker".to_string(),
        result: None,
        random_seed: deterministic_battle_seed(battle_id),
        random_index: 0,
        runtime_skill_cooldowns: BTreeMap::new(),
    }
}

pub fn build_minimal_pvp_battle_state(
    battle_id: &str,
    owner_character_id: i64,
    opponent_character_id: i64,
) -> BattleStateDto {
    let attacker_attrs = build_battle_attrs(100, 100, 28, 1, Some("凡人".to_string()));
    let attacker = BattleUnitDto {
        id: format!("player-{}", owner_character_id),
        name: format!("修士{}", owner_character_id),
        r#type: "player".to_string(),
        source_id: serde_json::json!(owner_character_id),
        base_attrs: attacker_attrs.clone(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 100,
        lingqi: 100,
        current_attrs: attacker_attrs,
        shields: Vec::new(),
        is_alive: true,
        can_act: true,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills: player_battle_skills(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    };
    let defender_attrs = build_battle_attrs(100, 100, 24, 1, Some("凡人".to_string()));
    let defender = BattleUnitDto {
        id: format!("opponent-{}", opponent_character_id),
        name: format!("对手{}", opponent_character_id),
        r#type: "player".to_string(),
        source_id: serde_json::json!(opponent_character_id),
        base_attrs: defender_attrs.clone(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 100,
        lingqi: 100,
        current_attrs: defender_attrs,
        shields: Vec::new(),
        is_alive: true,
        can_act: true,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills: player_battle_skills(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    };
    BattleStateDto {
        battle_id: battle_id.to_string(),
        battle_type: "pvp".to_string(),
        cooldown_timing_mode: "self_action_end".to_string(),
        teams: BattleTeamsDto {
            attacker: BattleTeamDto {
                odwner_id: Some(owner_character_id),
                units: vec![attacker.clone()],
                total_speed: 1,
            },
            defender: BattleTeamDto {
                odwner_id: Some(opponent_character_id),
                units: vec![defender],
                total_speed: 1,
            },
        },
        round_count: 1,
        current_team: "attacker".to_string(),
        current_unit_id: Some(attacker.id),
        phase: "action".to_string(),
        first_mover: "attacker".to_string(),
        result: None,
        random_seed: deterministic_battle_seed(battle_id),
        random_index: 0,
        runtime_skill_cooldowns: BTreeMap::new(),
    }
}

pub fn build_minimal_partner_battle_unit(
    partner_id: i64,
    name: String,
    avatar: Option<String>,
    owner_unit_id: String,
    max_qixue: i64,
    speed: i64,
    formation_order: i64,
) -> BattleUnitDto {
    let attrs = build_battle_attrs(max_qixue.max(1), 0, 18, speed.max(1), None);
    BattleUnitDto {
        id: format!("partner-{partner_id}"),
        name,
        r#type: "partner".to_string(),
        source_id: serde_json::json!(partner_id),
        base_attrs: attrs.clone(),
        formation_order: Some(formation_order),
        owner_unit_id: Some(owner_unit_id),
        month_card_active: None,
        avatar,
        qixue: max_qixue.max(1),
        lingqi: 0,
        current_attrs: attrs,
        shields: Vec::new(),
        is_alive: true,
        can_act: true,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills: player_battle_skills(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    }
}

pub fn apply_minimal_pve_action(
    state: &mut BattleStateDto,
    actor_character_id: i64,
    skill_id: &str,
    target_ids: &[String],
) -> Result<MinimalBattleActionOutcome, String> {
    if state.battle_type != "pve" {
        return Err("当前战斗不支持该行动".to_string());
    }
    if state.phase == "finished" {
        return Err("战斗已结束".to_string());
    }
    if state.current_team != "attacker" {
        return Err("当前不是我方行动回合".to_string());
    }
    let expected_actor_id = format!("player-{}", actor_character_id);
    if state.current_unit_id.as_deref() != Some(expected_actor_id.as_str()) {
        return Err("当前不可行动".to_string());
    }
    tick_down_runtime_skill_cooldowns(state);
    consume_runtime_skill_cost_and_validate_cooldown(state, &expected_actor_id, skill_id)?;
    let target_id = target_ids.first().cloned().or_else(|| {
        state
            .teams
            .defender
            .units
            .iter()
            .find(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
    });
    let Some(target_id) = target_id else {
        return Err("没有可攻击目标".to_string());
    };
    let Some(target) = state
        .teams
        .defender
        .units
        .iter_mut()
        .find(|unit| unit.id == target_id && unit.is_alive)
    else {
        return Err("目标不存在或已死亡".to_string());
    };

    let damage = resolve_player_skill_damage(skill_id);
    target.qixue = (target.qixue - damage).max(0);
    target.is_alive = target.qixue > 0;
    target.can_act = target.is_alive;

    let enemy_alive = state.teams.defender.units.iter().any(|unit| unit.is_alive);
    if !enemy_alive {
        state.phase = "finished".to_string();
        state.result = Some("attacker_win".to_string());
        state.current_unit_id = None;
        let (exp_gained, silver_gained) = sum_monster_rewards(&state.teams.defender.units);
        return Ok(MinimalBattleActionOutcome {
            finished: true,
            result: Some("attacker_win".to_string()),
            exp_gained,
            silver_gained,
        });
    }

    let Some(player) = state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == expected_actor_id)
    else {
        return Err("当前不可行动".to_string());
    };
    let total_enemy_damage = state
        .teams
        .defender
        .units
        .iter()
        .filter(|unit| unit.is_alive)
        .map(resolve_monster_counter_damage)
        .sum::<i64>();
    player.qixue = (player.qixue - total_enemy_damage).max(0);
    player.is_alive = player.qixue > 0;
    player.can_act = player.is_alive;
    state.round_count += 1;

    if !player.is_alive {
        state.phase = "finished".to_string();
        state.result = Some("defender_win".to_string());
        state.current_unit_id = None;
        return Ok(MinimalBattleActionOutcome {
            finished: true,
            result: Some("defender_win".to_string()),
            exp_gained: 0,
            silver_gained: 0,
        });
    }

    state.phase = "action".to_string();
    state.current_team = "attacker".to_string();
    state.current_unit_id = Some(expected_actor_id);
    Ok(MinimalBattleActionOutcome {
        finished: false,
        result: None,
        exp_gained: 0,
        silver_gained: 0,
    })
}

pub fn apply_minimal_pvp_action(
    state: &mut BattleStateDto,
    actor_character_id: i64,
    target_ids: &[String],
) -> Result<MinimalBattleActionOutcome, String> {
    if state.battle_type != "pvp" {
        return Err("当前战斗不支持该行动".to_string());
    }
    if state.phase == "finished" {
        return Err("战斗已结束".to_string());
    }
    if state.current_team != "attacker" {
        return Err("当前不是我方行动回合".to_string());
    }
    let expected_actor_id = format!("player-{}", actor_character_id);
    if state.current_unit_id.as_deref() != Some(expected_actor_id.as_str()) {
        return Err("当前不可行动".to_string());
    }
    tick_down_runtime_skill_cooldowns(state);
    consume_runtime_skill_cost_and_validate_cooldown(state, &expected_actor_id, "sk-heavy-slash")?;
    let target_id = target_ids.first().cloned().or_else(|| {
        state
            .teams
            .defender
            .units
            .iter()
            .find(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
    });
    let Some(target_id) = target_id else {
        return Err("没有可攻击目标".to_string());
    };
    let Some(target) = state
        .teams
        .defender
        .units
        .iter_mut()
        .find(|unit| unit.id == target_id && unit.is_alive)
    else {
        return Err("目标不存在或已死亡".to_string());
    };

    target.qixue = 0;
    target.is_alive = false;
    target.can_act = false;
    state.round_count += 1;

    let enemy_alive = state.teams.defender.units.iter().any(|unit| unit.is_alive);
    if !enemy_alive {
        state.phase = "finished".to_string();
        state.result = Some("attacker_win".to_string());
        state.current_unit_id = None;
        return Ok(MinimalBattleActionOutcome {
            finished: true,
            result: Some("attacker_win".to_string()),
            exp_gained: 0,
            silver_gained: 0,
        });
    }

    state.phase = "action".to_string();
    state.current_team = "attacker".to_string();
    state.current_unit_id = Some(expected_actor_id);
    Ok(MinimalBattleActionOutcome {
        finished: false,
        result: None,
        exp_gained: 0,
        silver_gained: 0,
    })
}

fn tick_down_runtime_skill_cooldowns(state: &mut BattleStateDto) {
    for value in state.runtime_skill_cooldowns.values_mut() {
        *value = value.saturating_sub(1);
    }
    state.runtime_skill_cooldowns.retain(|_, value| *value > 0);
    sync_unit_skill_cooldowns_from_runtime(state);
}

fn sync_unit_skill_cooldowns_from_runtime(state: &mut BattleStateDto) {
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        unit.skill_cooldowns.clear();
    }
    for (cooldown_key, remaining) in state.runtime_skill_cooldowns.clone() {
        let Some((unit_id, skill_id)) = cooldown_key.split_once(':') else {
            continue;
        };
        let Some(unit) = state
            .teams
            .attacker
            .units
            .iter_mut()
            .chain(state.teams.defender.units.iter_mut())
            .find(|unit| unit.id == unit_id)
        else {
            continue;
        };
        unit.skill_cooldowns.insert(skill_id.to_string(), remaining);
    }
}

fn consume_runtime_skill_cost_and_validate_cooldown(
    state: &mut BattleStateDto,
    actor_id: &str,
    skill_id: &str,
) -> Result<(), String> {
    let Some(config) = battle_skill_runtime_config(skill_id) else {
        return Ok(());
    };
    let cooldown_key = format!("{actor_id}:{skill_id}");
    if state
        .runtime_skill_cooldowns
        .get(cooldown_key.as_str())
        .copied()
        .unwrap_or_default()
        > 0
    {
        return Err("技能冷却中".to_string());
    }
    let Some(actor) = state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == actor_id && unit.is_alive)
    else {
        return Err("当前不可行动".to_string());
    };
    if actor.lingqi < config.cost_lingqi.max(0) {
        return Err("灵气不足".to_string());
    }
    if actor.qixue <= config.cost_qixue.max(0) {
        return Err("气血不足".to_string());
    }
    actor.lingqi = (actor.lingqi - config.cost_lingqi.max(0)).max(0);
    actor.qixue = (actor.qixue - config.cost_qixue.max(0)).max(1);
    if config.cooldown_turns > 0 {
        state
            .runtime_skill_cooldowns
            .insert(cooldown_key, config.cooldown_turns + 1);
        sync_unit_skill_cooldowns_from_runtime(state);
    }
    Ok(())
}

fn battle_skill_runtime_config(skill_id: &str) -> Option<BattleSkillRuntimeConfig> {
    match skill_id.trim() {
        "sk-basic-slash" => Some(BattleSkillRuntimeConfig {
            cost_lingqi: 0,
            cost_qixue: 0,
            cooldown_turns: 0,
        }),
        "sk-heavy-slash" => Some(BattleSkillRuntimeConfig {
            cost_lingqi: 20,
            cost_qixue: 0,
            cooldown_turns: 1,
        }),
        "sk-bite" => Some(BattleSkillRuntimeConfig {
            cost_lingqi: 5,
            cost_qixue: 0,
            cooldown_turns: 1,
        }),
        _ => None,
    }
}

fn resolve_player_skill_damage(skill_id: &str) -> i64 {
    match skill_id.trim() {
        "sk-heavy-slash" => 220,
        "sk-basic-slash" => 32,
        "sk-bite" => 24,
        _ => 28,
    }
}

fn resolve_monster_counter_damage(unit: &BattleUnitDto) -> i64 {
    let monster_def_id = parse_monster_def_id(&unit.id);
    load_monster_seed(&monster_def_id)
        .ok()
        .and_then(|seed| seed.base_attrs.and_then(|attrs| attrs.wugong))
        .unwrap_or(8)
        .max(1)
}

fn parse_monster_def_id(unit_id: &str) -> String {
    unit_id
        .splitn(3, '-')
        .nth(2)
        .map(|value| value.to_string())
        .unwrap_or_else(|| unit_id.to_string())
}

fn sum_monster_rewards(units: &[BattleUnitDto]) -> (i64, i64) {
    units.iter().fold((0, 0), |(exp, silver), unit| {
        let reward_exp = unit
            .reward_exp
            .filter(|value| *value > 0)
            .unwrap_or_else(|| (unit.current_attrs.max_qixue / 10).max(1));
        let reward_silver = unit
            .reward_silver
            .filter(|value| *value > 0)
            .unwrap_or_else(|| (unit.current_attrs.max_qixue / 30).max(1));
        (
            exp.saturating_add(reward_exp),
            silver.saturating_add(reward_silver),
        )
    })
}

pub fn resolve_minimal_pve_item_rewards(
    monster_ids: &[String],
) -> Result<Vec<MinimalBattleRewardItemDto>, String> {
    let monster_map = load_monster_seed_map()?;
    let item_defs = load_battle_reward_item_map()?;
    let drop_pools = load_battle_drop_pool_map()?;
    let mut merged = BTreeMap::<String, MinimalBattleRewardItemDto>::new();

    for (monster_index, monster_id) in monster_ids.iter().enumerate() {
        let Some(monster) = monster_map.get(monster_id.as_str()) else {
            continue;
        };
        let Some(drop_pool_id) = monster
            .drop_pool_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let entries = resolve_battle_drop_pool_entries(&drop_pools, drop_pool_id)?;
        for (entry_index, entry) in entries.iter().enumerate() {
            let Some(item_def_id) = entry
                .item_def_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let chance = as_drop_entry_f64(entry.chance.as_ref())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0);
            if chance <= 0.0 {
                continue;
            }
            let roll = deterministic_reward_roll_unit_interval(
                monster_id,
                monster_index as i64,
                entry_index as i64,
                item_def_id,
            );
            if roll > chance {
                continue;
            }
            let qty_min = as_drop_entry_i64(entry.qty_min.as_ref(), 1).max(1);
            let qty_max = as_drop_entry_i64(entry.qty_max.as_ref(), qty_min).max(qty_min);
            let quantity = deterministic_reward_roll_i64(
                monster_id,
                monster_index as i64,
                entry_index as i64,
                qty_min,
                qty_max,
            );
            if quantity <= 0 {
                continue;
            }
            let Some(item_meta) = item_defs.get(item_def_id) else {
                continue;
            };
            merged
                .entry(item_def_id.to_string())
                .and_modify(|row| row.qty += quantity)
                .or_insert_with(|| MinimalBattleRewardItemDto {
                    item_def_id: item_def_id.to_string(),
                    item_name: item_meta
                        .name
                        .clone()
                        .unwrap_or_else(|| item_def_id.to_string()),
                    qty: quantity,
                    bind_type: item_meta
                        .bind_type
                        .clone()
                        .unwrap_or_else(|| "none".to_string()),
                });
        }
    }

    Ok(merged.into_values().collect())
}

fn load_monster_seed(monster_def_id: &str) -> Result<MonsterSeed, String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read monster_def.json: {error}"))?;
    let payload: MonsterSeedFile = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse monster_def.json: {error}"))?;
    payload
        .monsters
        .into_iter()
        .find(|monster| {
            monster.id.as_deref().map(str::trim) == Some(monster_def_id)
                && monster.enabled != Some(false)
        })
        .ok_or_else(|| format!("monster seed not found: {monster_def_id}"))
}

fn load_monster_seed_map() -> Result<BTreeMap<String, MonsterSeed>, String> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read monster_def.json: {error}"))?;
    let payload: MonsterSeedFile = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse monster_def.json: {error}"))?;
    Ok(payload
        .monsters
        .into_iter()
        .filter(|monster| monster.enabled != Some(false))
        .filter_map(|monster| {
            monster
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|id| (id.to_string(), monster.clone()))
        })
        .collect())
}

fn load_battle_reward_item_map() -> Result<BTreeMap<String, BattleRewardItemMeta>, String> {
    let mut map = BTreeMap::new();
    for filename in ["item_def.json", "equipment_def.json", "gem_def.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let payload: BattleRewardItemFile = serde_json::from_str(&content)
            .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
        for item in payload.items {
            let Some(item_id) = item
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            map.insert(
                item_id.to_string(),
                BattleRewardItemMeta {
                    id: item.id,
                    name: item.name,
                    bind_type: item.bind_type,
                },
            );
        }
    }
    Ok(map)
}

fn load_battle_drop_pool_map() -> Result<BTreeMap<String, BattleDropPoolSeed>, String> {
    let mut map = BTreeMap::new();
    for filename in ["drop_pool.json", "drop_pool_common.json"] {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../server/src/data/seeds/{filename}"));
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let payload: BattleDropPoolFile = serde_json::from_str(&content)
            .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
        for pool in payload
            .pools
            .into_iter()
            .filter(|pool| pool.enabled != Some(false))
        {
            let Some(pool_id) = pool
                .id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            map.insert(pool_id.to_string(), pool);
        }
    }
    Ok(map)
}

fn resolve_battle_drop_pool_entries(
    pools: &BTreeMap<String, BattleDropPoolSeed>,
    pool_id: &str,
) -> Result<Vec<BattleDropPoolEntrySeed>, String> {
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    collect_battle_drop_pool_entries(pools, pool_id, &mut visited, &mut out)?;
    Ok(out)
}

fn collect_battle_drop_pool_entries(
    pools: &BTreeMap<String, BattleDropPoolSeed>,
    pool_id: &str,
    visited: &mut BTreeSet<String>,
    out: &mut Vec<BattleDropPoolEntrySeed>,
) -> Result<(), String> {
    let normalized = pool_id.trim();
    if normalized.is_empty() || !visited.insert(normalized.to_string()) {
        return Ok(());
    }
    let Some(pool) = pools.get(normalized) else {
        return Ok(());
    };
    if pool.mode.as_deref().map(str::trim) != Some("prob") {
        return Ok(());
    }
    for common_pool_id in pool.common_pool_ids.clone().unwrap_or_default() {
        collect_battle_drop_pool_entries(pools, &common_pool_id, visited, out)?;
    }
    out.extend(pool.entries.clone().unwrap_or_default().into_iter());
    Ok(())
}

fn deterministic_reward_roll_unit_interval(
    monster_id: &str,
    monster_index: i64,
    entry_index: i64,
    item_def_id: &str,
) -> f64 {
    let seed = format!("battle-reward:{monster_id}:{monster_index}:{entry_index}:{item_def_id}");
    let digest = md5::compute(seed.as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (value as f64) / (u32::MAX as f64)
}

fn deterministic_reward_roll_i64(
    monster_id: &str,
    monster_index: i64,
    entry_index: i64,
    min: i64,
    max: i64,
) -> i64 {
    if max <= min {
        return min;
    }
    let seed = format!("battle-reward-qty:{monster_id}:{monster_index}:{entry_index}:{min}:{max}");
    let digest = md5::compute(seed.as_bytes());
    let value = u32::from_be_bytes([digest[4], digest[5], digest[6], digest[7]]) as i64;
    min + value.rem_euclid(max - min + 1)
}

fn as_drop_entry_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_f64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_drop_entry_i64(value: Option<&serde_json::Value>, fallback: i64) -> i64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_i64().unwrap_or(fallback),
        Some(serde_json::Value::String(text)) => text.trim().parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BattleCharacterUnitProfile, BattleUnitCurrentAttrsDto,
        apply_character_profile_to_battle_state, apply_minimal_pve_action,
        apply_minimal_pvp_action, build_minimal_pve_battle_state, build_minimal_pvp_battle_state,
        resolve_minimal_pve_item_rewards,
    };

    #[test]
    fn minimal_pve_battle_state_matches_frontend_required_shape() {
        let state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-white-wolf".to_string(),
            ],
        );

        assert_eq!(state.battle_type, "pve");
        assert_eq!(state.current_team, "attacker");
        assert_eq!(state.phase, "action");
        assert_eq!(state.teams.attacker.units.len(), 1);
        assert_eq!(state.teams.defender.units.len(), 2);
        assert_eq!(state.current_unit_id.as_deref(), Some("player-1"));
        let attacker = &state.teams.attacker.units[0];
        assert_eq!(attacker.source_id, serde_json::json!(1));
        assert_eq!(attacker.current_attrs.realm.as_deref(), Some("凡人"));
        assert_eq!(
            attacker.base_attrs.max_qixue,
            attacker.current_attrs.max_qixue
        );
        assert!(attacker.can_act);
        assert!(attacker.shields.is_empty());
        assert!(attacker.marks.is_empty());
        assert!(
            attacker
                .skills
                .iter()
                .any(|skill| skill["id"] == "sk-basic-slash")
        );
        assert!(attacker.skill_cooldowns.is_empty());
        assert_eq!(attacker.stats.damage_dealt, 0);
        let serialized = serde_json::to_value(attacker).expect("attacker should serialize");
        assert_eq!(
            serialized["currentAttrs"]["max_qixue"],
            serde_json::json!(180)
        );
        assert!(serialized["currentAttrs"].get("maxQixue").is_none());
    }

    #[test]
    fn minimal_pve_action_kills_target_and_finishes_last_enemy() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        assert!(outcome.finished);
        assert_eq!(state.phase, "finished");
        assert_eq!(state.result.as_deref(), Some("attacker_win"));
        assert_eq!(state.current_unit_id, None);
        assert!(outcome.exp_gained > 0);
        assert!(outcome.silver_gained > 0);
        println!(
            "BATTLE_RUNTIME_PVE_FINISH_OUTCOME={{\"finished\":{},\"result\":{:?},\"expGained\":{},\"silverGained\":{}}}",
            outcome.finished, outcome.result, outcome.exp_gained, outcome.silver_gained
        );
    }

    #[test]
    fn minimal_pve_action_requires_attacker_turn() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.current_team = "defender".to_string();

        let error = apply_minimal_pve_action(
            &mut state,
            1,
            "sk-basic-slash",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect_err("action should fail");

        assert_eq!(error, "当前不是我方行动回合");
    }

    #[test]
    fn minimal_pve_action_can_leave_enemy_alive_and_enemy_can_counterattack() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "sk-basic-slash",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        assert!(!outcome.finished);
        assert_eq!(state.phase, "action");
        assert_eq!(state.result, None);
        assert!(state.teams.defender.units[0].is_alive);
        assert!(
            state.teams.attacker.units[0].qixue
                < state.teams.attacker.units[0].current_attrs.max_qixue
        );
        assert!(state.round_count >= 2);
        println!(
            "BATTLE_RUNTIME_PVE_PROGRESS_STATE={{\"finished\":{},\"attackerQixue\":{},\"defenderQixue\":{},\"roundCount\":{}}}",
            outcome.finished,
            state.teams.attacker.units[0].qixue,
            state.teams.defender.units[0].qixue,
            state.round_count
        );
    }

    #[test]
    fn minimal_pve_action_consumes_lingqi_and_sets_cooldown_for_heavy_slash() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-wild-boar".to_string()]);

        apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-1-monster-wild-boar".to_string()],
        )
        .expect("action should succeed");

        assert_eq!(state.teams.attacker.units[0].lingqi, 80);
        assert!(
            state
                .runtime_skill_cooldowns
                .get("player-1:sk-heavy-slash")
                .copied()
                .unwrap_or_default()
                > 0
        );
        assert_eq!(
            state.teams.attacker.units[0]
                .skill_cooldowns
                .get("sk-heavy-slash")
                .copied()
                .unwrap_or_default(),
            2
        );
    }

    #[test]
    fn minimal_pve_action_rejects_skill_while_cooling_down() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state
            .runtime_skill_cooldowns
            .insert("player-1:sk-heavy-slash".to_string(), 2);

        let error = apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect_err("action should fail");

        assert_eq!(error, "技能冷却中");
    }

    #[test]
    fn minimal_pvp_battle_state_matches_frontend_required_shape() {
        let state = build_minimal_pvp_battle_state("pvp-battle-1", 1, 2);

        assert_eq!(state.battle_type, "pvp");
        assert_eq!(state.current_team, "attacker");
        assert_eq!(state.teams.attacker.units.len(), 1);
        assert_eq!(state.teams.defender.units.len(), 1);
    }

    #[test]
    fn minimal_pvp_action_kills_target_and_finishes_last_enemy() {
        let mut state = build_minimal_pvp_battle_state("pvp-battle-1", 1, 2);

        let outcome = apply_minimal_pvp_action(&mut state, 1, &["opponent-2".to_string()])
            .expect("pvp action should succeed");

        assert!(outcome.finished);
        assert_eq!(state.phase, "finished");
        assert_eq!(state.result.as_deref(), Some("attacker_win"));
    }

    #[test]
    fn character_profile_replaces_placeholder_unit_identity_and_resources() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 42, &["monster-gray-wolf".to_string()]);
        let profile = test_profile(42, 7, "青玄", 360, 140, 18);

        let unit_id =
            apply_character_profile_to_battle_state(&mut state, "player-42", "player", &profile)
                .expect("profile should apply");

        assert_eq!(unit_id, "player-42");
        assert_eq!(state.current_unit_id.as_deref(), Some("player-42"));
        assert_eq!(state.teams.attacker.total_speed, 18);
        let attacker = &state.teams.attacker.units[0];
        assert_eq!(attacker.name, "青玄");
        assert_eq!(attacker.qixue, 360);
        assert_eq!(attacker.lingqi, 140);
        assert_eq!(attacker.current_attrs.max_qixue, 360);
        assert_eq!(attacker.current_attrs.max_lingqi, 200);
        assert_eq!(attacker.month_card_active, Some(true));
    }

    #[test]
    fn character_profile_aligns_pvp_defender_to_node_npc_unit_id() {
        let mut state = build_minimal_pvp_battle_state("pvp-battle-1", 10, 20);
        let profile = test_profile(20, 8, "镜像修士", 480, 100, 12);

        let unit_id =
            apply_character_profile_to_battle_state(&mut state, "opponent-20", "npc", &profile)
                .expect("profile should apply");

        assert_eq!(unit_id, "npc-20");
        let defender = &state.teams.defender.units[0];
        assert_eq!(defender.id, "npc-20");
        assert_eq!(defender.r#type, "npc");
        assert_eq!(defender.name, "镜像修士");
        assert_eq!(defender.qixue, 480);
        assert_eq!(defender.avatar, None);
    }

    #[test]
    fn minimal_pve_reward_items_include_guaranteed_boar_drop() {
        let rewards = resolve_minimal_pve_item_rewards(&["monster-wild-boar".to_string()])
            .expect("boar rewards should resolve");
        assert!(
            rewards
                .iter()
                .any(|item| item.item_def_id == "mat-005" && item.qty > 0)
        );
        println!(
            "BATTLE_RUNTIME_REWARD_ITEMS={}",
            serde_json::to_string(&rewards).expect("rewards should serialize")
        );
    }

    fn test_profile(
        character_id: i64,
        user_id: i64,
        name: &str,
        qixue: i64,
        lingqi: i64,
        sudu: i64,
    ) -> BattleCharacterUnitProfile {
        BattleCharacterUnitProfile {
            character_id,
            user_id,
            name: name.to_string(),
            month_card_active: true,
            avatar: Some("/uploads/avatars/test.png".to_string()),
            qixue,
            lingqi,
            attrs: BattleUnitCurrentAttrsDto {
                max_qixue: qixue,
                max_lingqi: 200,
                wugong: 31,
                fagong: 0,
                wufang: 3,
                fafang: 4,
                sudu,
                mingzhong: 100,
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
                realm: Some("炼精化炁·养气期".to_string()),
                element: Some("wood".to_string()),
            },
        }
    }
}
