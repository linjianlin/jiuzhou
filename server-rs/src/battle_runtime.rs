use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
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
    pub logs: Vec<serde_json::Value>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_character_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver_fuyuan: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_weights: Option<BTreeMap<String, f64>>,
}

#[derive(Debug, Clone)]
pub struct MinimalBattleRewardParticipant {
    pub character_id: i64,
    pub user_id: i64,
    pub fuyuan: f64,
    pub realm: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MinimalPveItemRewardResolveOptions {
    pub reward_seed: String,
    pub participants: Vec<MinimalBattleRewardParticipant>,
    pub is_dungeon_battle: bool,
    pub dungeon_reward_multiplier: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct MonsterSeedFile {
    monsters: Vec<MonsterSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterSeed {
    id: Option<String>,
    name: Option<String>,
    realm: Option<String>,
    kind: Option<String>,
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
    category: Option<String>,
    sub_category: Option<String>,
    effect_defs: Option<serde_json::Value>,
    quality: Option<String>,
    can_disassemble: Option<bool>,
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
    weight: Option<serde_json::Value>,
    qty_min: Option<serde_json::Value>,
    qty_max: Option<serde_json::Value>,
    chance_add_by_monster_realm: Option<serde_json::Value>,
    qty_min_add_by_monster_realm: Option<serde_json::Value>,
    qty_max_add_by_monster_realm: Option<serde_json::Value>,
    qty_multiply_by_monster_realm: Option<serde_json::Value>,
    quality_weights: Option<serde_json::Value>,
    bind_type: Option<String>,
    sort_order: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BattleDropSourceType {
    Common,
    Exclusive,
}

#[derive(Debug, Clone)]
struct ResolvedBattleDropEntrySeed {
    entry: BattleDropPoolEntrySeed,
    source_type: BattleDropSourceType,
    source_pool_id: String,
}

#[derive(Debug, Clone)]
struct ResolvedBattleDropPoolSeed {
    mode: String,
    entries: Vec<ResolvedBattleDropEntrySeed>,
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
        build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0),
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
    let (actor_name, skill_name) = resolve_unit_name_and_skill_name(
        &state.teams.attacker.units,
        &expected_actor_id,
        skill_id,
    )?;
    let action_round = state.round_count.max(1);
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
    let target_name = target.name.clone();
    let target_qixue_before = target.qixue;
    target.qixue = (target.qixue - damage).max(0);
    let actual_damage = (target_qixue_before - target.qixue).max(0);
    target.is_alive = target.qixue > 0;
    target.can_act = target.is_alive;
    let mut logs = vec![build_minimal_action_log(MinimalActionLogDraft {
        round: action_round,
        actor_id: &expected_actor_id,
        actor_name: &actor_name,
        skill_id: skill_id.trim(),
        skill_name: &skill_name,
        target_id: &target_id,
        target_name: &target_name,
        damage: actual_damage,
    })];
    if !target.is_alive {
        logs.push(build_minimal_death_log(
            action_round,
            &target_id,
            &target_name,
            Some(&expected_actor_id),
            Some(&actor_name),
        ));
    }

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
            logs,
        });
    }

    let counter_actions = state
        .teams
        .defender
        .units
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| {
            let skill_id = "sk-bite";
            let skill_name = resolve_unit_skill_name(unit, skill_id)?;
            Ok((
                unit.id.clone(),
                unit.name.clone(),
                skill_id.to_string(),
                skill_name,
                resolve_monster_counter_damage(unit),
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let Some(player) = state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == expected_actor_id)
    else {
        return Err("当前不可行动".to_string());
    };
    let mut killer_id = None;
    let mut killer_name = None;
    for (
        counter_actor_id,
        counter_actor_name,
        counter_skill_id,
        counter_skill_name,
        counter_damage,
    ) in counter_actions
    {
        if player.qixue <= 0 {
            break;
        }
        let qixue_before = player.qixue;
        player.qixue = (player.qixue - counter_damage).max(0);
        let actual_counter_damage = (qixue_before - player.qixue).max(0);
        logs.push(build_minimal_action_log(MinimalActionLogDraft {
            round: action_round,
            actor_id: &counter_actor_id,
            actor_name: &counter_actor_name,
            skill_id: &counter_skill_id,
            skill_name: &counter_skill_name,
            target_id: &expected_actor_id,
            target_name: &actor_name,
            damage: actual_counter_damage,
        }));
        if player.qixue <= 0 {
            killer_id = Some(counter_actor_id);
            killer_name = Some(counter_actor_name);
        }
    }
    player.is_alive = player.qixue > 0;
    player.can_act = player.is_alive;
    state.round_count += 1;

    if !player.is_alive {
        state.phase = "finished".to_string();
        state.result = Some("defender_win".to_string());
        state.current_unit_id = None;
        logs.push(build_minimal_death_log(
            action_round,
            &expected_actor_id,
            &actor_name,
            killer_id.as_deref(),
            killer_name.as_deref(),
        ));
        return Ok(MinimalBattleActionOutcome {
            finished: true,
            result: Some("defender_win".to_string()),
            exp_gained: 0,
            silver_gained: 0,
            logs,
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
        logs,
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
    let skill_id = "sk-heavy-slash";
    let (actor_name, skill_name) = resolve_unit_name_and_skill_name(
        &state.teams.attacker.units,
        &expected_actor_id,
        skill_id,
    )?;
    let action_round = state.round_count.max(1);
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

    let target_name = target.name.clone();
    let target_qixue_before = target.qixue;
    target.qixue = 0;
    let actual_damage = target_qixue_before.max(0);
    target.is_alive = false;
    target.can_act = false;
    let logs = vec![
        build_minimal_action_log(MinimalActionLogDraft {
            round: action_round,
            actor_id: &expected_actor_id,
            actor_name: &actor_name,
            skill_id,
            skill_name: &skill_name,
            target_id: &target_id,
            target_name: &target_name,
            damage: actual_damage,
        }),
        build_minimal_death_log(
            action_round,
            &target_id,
            &target_name,
            Some(&expected_actor_id),
            Some(&actor_name),
        ),
    ];
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
            logs,
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
        logs,
    })
}

struct MinimalActionLogDraft<'a> {
    round: i64,
    actor_id: &'a str,
    actor_name: &'a str,
    skill_id: &'a str,
    skill_name: &'a str,
    target_id: &'a str,
    target_name: &'a str,
    damage: i64,
}

fn build_minimal_action_log(draft: MinimalActionLogDraft<'_>) -> serde_json::Value {
    serde_json::json!({
        "type": "action",
        "round": draft.round,
        "actorId": draft.actor_id,
        "actorName": draft.actor_name,
        "skillId": draft.skill_id,
        "skillName": draft.skill_name,
        "targets": [{
            "targetId": draft.target_id,
            "targetName": draft.target_name,
            "hits": [{
                "index": 1,
                "damage": draft.damage.max(0),
                "isMiss": false,
                "isCrit": false,
                "isParry": false,
                "isElementBonus": false,
                "shieldAbsorbed": 0
            }],
            "damage": draft.damage.max(0)
        }]
    })
}

fn build_minimal_death_log(
    round: i64,
    unit_id: &str,
    unit_name: &str,
    killer_id: Option<&str>,
    killer_name: Option<&str>,
) -> serde_json::Value {
    serde_json::json!({
        "type": "death",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "killerId": killer_id,
        "killerName": killer_name
    })
}

fn resolve_unit_name_and_skill_name(
    units: &[BattleUnitDto],
    unit_id: &str,
    skill_id: &str,
) -> Result<(String, String), String> {
    let Some(unit) = units.iter().find(|unit| unit.id == unit_id) else {
        return Err("当前不可行动".to_string());
    };
    Ok((unit.name.clone(), resolve_unit_skill_name(unit, skill_id)?))
}

fn resolve_unit_skill_name(unit: &BattleUnitDto, skill_id: &str) -> Result<String, String> {
    let normalized_skill_id = skill_id.trim();
    if normalized_skill_id == "skill-normal-attack" {
        return Ok("普通攻击".to_string());
    }
    unit.skills
        .iter()
        .find(|skill| {
            skill.get("id").and_then(serde_json::Value::as_str) == Some(normalized_skill_id)
        })
        .and_then(|skill| skill.get("name").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| format!("战斗技能不存在: {normalized_skill_id}"))
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
        "skill-normal-attack" => Some(BattleSkillRuntimeConfig {
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
        "skill-normal-attack" => 32,
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
    options: &MinimalPveItemRewardResolveOptions,
) -> Result<Vec<MinimalBattleRewardItemDto>, String> {
    let monster_map = load_monster_seed_map()?;
    let item_defs = load_battle_reward_item_map()?;
    let drop_pools = load_battle_drop_pool_map()?;
    let participants = options
        .participants
        .iter()
        .filter(|participant| participant.character_id > 0 && participant.user_id > 0)
        .cloned()
        .collect::<Vec<_>>();
    if participants.is_empty() {
        return Ok(Vec::new());
    }
    let mut rng = StdRng::seed_from_u64(seed_u64(&options.reward_seed));
    let mut merged = BTreeMap::<String, MinimalBattleRewardItemDto>::new();
    let participant_count = participants.len() as f64;
    let team_average_fuyuan = participants
        .iter()
        .map(|participant| participant.fuyuan)
        .sum::<f64>()
        / participant_count.max(1.0);

    for monster_id in monster_ids {
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
        let drop_pool = resolve_battle_drop_pool(&drop_pools, drop_pool_id)?;
        let monster_kind = normalize_monster_kind(monster.kind.as_deref());
        let monster_realm = monster.realm.as_deref();
        let realm_suppression_multiplier = if options.is_dungeon_battle {
            1.0
        } else {
            participants
                .iter()
                .map(|participant| {
                    realm_suppression_multiplier(participant.realm.as_deref(), monster_realm)
                })
                .sum::<f64>()
                / participant_count.max(1.0)
        }
        .clamp(0.0, 1.0);
        let drops = roll_battle_drop_pool(
            &drop_pool,
            &item_defs,
            monster_kind,
            monster_realm,
            team_average_fuyuan,
            realm_suppression_multiplier,
            options.is_dungeon_battle,
            options.dungeon_reward_multiplier,
            &mut rng,
        );
        for drop in drops {
            let Some(item_meta) = item_defs.get(drop.item_def_id.as_str()) else {
                continue;
            };
            if participants.len() <= 1 {
                let receiver = &participants[0];
                merge_minimal_reward_drop(
                    &mut merged,
                    &drop,
                    item_meta,
                    receiver.character_id,
                    receiver.user_id,
                    receiver.fuyuan,
                );
                continue;
            }
            let mut qty_by_receiver = BTreeMap::<i64, (MinimalBattleRewardParticipant, i64)>::new();
            for _ in 0..drop.qty {
                let receiver_index = rng.gen_range(0..participants.len());
                let receiver = participants[receiver_index].clone();
                qty_by_receiver
                    .entry(receiver.character_id)
                    .and_modify(|(_, qty)| *qty += 1)
                    .or_insert((receiver, 1));
            }
            for (_, (receiver, qty)) in qty_by_receiver {
                let allocated_drop = MinimalRolledBattleDrop {
                    qty,
                    ..drop.clone()
                };
                merge_minimal_reward_drop(
                    &mut merged,
                    &allocated_drop,
                    item_meta,
                    receiver.character_id,
                    receiver.user_id,
                    receiver.fuyuan,
                );
            }
        }
    }

    Ok(merged.into_values().collect())
}

#[derive(Debug, Clone)]
struct MinimalRolledBattleDrop {
    item_def_id: String,
    qty: i64,
    bind_type: String,
    quality_weights: Option<BTreeMap<String, f64>>,
}

fn merge_minimal_reward_drop(
    merged: &mut BTreeMap<String, MinimalBattleRewardItemDto>,
    drop: &MinimalRolledBattleDrop,
    item_meta: &BattleRewardItemMeta,
    receiver_character_id: i64,
    receiver_user_id: i64,
    receiver_fuyuan: f64,
) {
    let quality_key = stable_quality_weights_key(drop.quality_weights.as_ref());
    let key = format!(
        "{}|{}|{}|{}",
        receiver_character_id, drop.item_def_id, drop.bind_type, quality_key
    );
    merged
        .entry(key)
        .and_modify(|row| row.qty += drop.qty)
        .or_insert_with(|| MinimalBattleRewardItemDto {
            item_def_id: drop.item_def_id.clone(),
            item_name: item_meta
                .name
                .clone()
                .unwrap_or_else(|| drop.item_def_id.clone()),
            qty: drop.qty,
            bind_type: if drop.bind_type.trim().is_empty() {
                "none".to_string()
            } else {
                drop.bind_type.clone()
            },
            receiver_character_id: Some(receiver_character_id),
            receiver_user_id: Some(receiver_user_id),
            receiver_fuyuan: Some(receiver_fuyuan),
            quality_weights: drop.quality_weights.clone(),
        });
}

fn roll_battle_drop_pool(
    drop_pool: &ResolvedBattleDropPoolSeed,
    item_defs: &BTreeMap<String, BattleRewardItemMeta>,
    monster_kind: BattleMonsterKind,
    monster_realm: Option<&str>,
    fuyuan: f64,
    realm_suppression_multiplier: f64,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
    rng: &mut StdRng,
) -> Vec<MinimalRolledBattleDrop> {
    let mut results = Vec::new();
    if drop_pool.mode == "weight" {
        let total_weight = drop_pool
            .entries
            .iter()
            .map(|resolved| {
                adjusted_weight(
                    as_drop_entry_f64(resolved.entry.weight.as_ref()).unwrap_or(0.0),
                    resolved.source_type,
                    &resolved.source_pool_id,
                    monster_kind,
                    is_dungeon_battle,
                    dungeon_reward_multiplier,
                )
            })
            .sum::<f64>();
        if total_weight <= 0.0 || rng.r#gen::<f64>() >= realm_suppression_multiplier {
            return results;
        }
        let mut roll = rng.r#gen::<f64>() * total_weight;
        for resolved in &drop_pool.entries {
            roll -= adjusted_weight(
                as_drop_entry_f64(resolved.entry.weight.as_ref()).unwrap_or(0.0),
                resolved.source_type,
                &resolved.source_pool_id,
                monster_kind,
                is_dungeon_battle,
                dungeon_reward_multiplier,
            );
            if roll <= 0.0 {
                if let Some(drop) = roll_entry_quantity(
                    resolved,
                    item_defs,
                    monster_kind,
                    monster_realm,
                    is_dungeon_battle,
                    dungeon_reward_multiplier,
                    rng,
                ) {
                    results.push(drop);
                }
                break;
            }
        }
        return results;
    }

    let capped_fuyuan = fuyuan.clamp(0.0, 200.0);
    let chance_multiplier = 1.0 + capped_fuyuan * 0.0025;
    for resolved in &drop_pool.entries {
        if normalized_entry_item_def_id(&resolved.entry).is_none() {
            continue;
        }
        let chance = as_drop_entry_f64(resolved.entry.chance.as_ref()).unwrap_or(0.0);
        let effective_chance = (adjusted_chance(
            chance * chance_multiplier,
            resolved.source_type,
            &resolved.source_pool_id,
            monster_kind,
            monster_realm,
            as_drop_entry_f64(resolved.entry.chance_add_by_monster_realm.as_ref()).unwrap_or(0.0),
            is_dungeon_battle,
            dungeon_reward_multiplier,
        ) * realm_suppression_multiplier)
            .clamp(0.0, 1.0);
        if rng.r#gen::<f64>() >= effective_chance {
            continue;
        }
        if let Some(drop) = roll_entry_quantity(
            resolved,
            item_defs,
            monster_kind,
            monster_realm,
            is_dungeon_battle,
            dungeon_reward_multiplier,
            rng,
        ) {
            results.push(drop);
        }
    }
    results
}

fn roll_entry_quantity(
    resolved: &ResolvedBattleDropEntrySeed,
    item_defs: &BTreeMap<String, BattleRewardItemMeta>,
    monster_kind: BattleMonsterKind,
    monster_realm: Option<&str>,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
    rng: &mut StdRng,
) -> Option<MinimalRolledBattleDrop> {
    let item_def_id = normalized_entry_item_def_id(&resolved.entry)?;
    let item_def = item_defs.get(&item_def_id);
    let (qty_min, qty_max) = adjusted_drop_quantity_range(
        &resolved.entry,
        resolved.source_type,
        &resolved.source_pool_id,
        monster_kind,
        monster_realm,
        item_def,
        is_dungeon_battle,
        dungeon_reward_multiplier,
    );
    let qty = if qty_max <= qty_min {
        qty_min
    } else {
        rng.gen_range(qty_min..=qty_max)
    };
    if qty <= 0 {
        return None;
    }
    let bind_type = resolved
        .entry
        .bind_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| item_def.and_then(|meta| meta.bind_type.clone()))
        .unwrap_or_else(|| "none".to_string());
    Some(MinimalRolledBattleDrop {
        item_def_id,
        qty,
        bind_type,
        quality_weights: normalize_quality_weights(resolved.entry.quality_weights.as_ref()),
    })
}

fn adjusted_drop_quantity_range(
    entry: &BattleDropPoolEntrySeed,
    source_type: BattleDropSourceType,
    source_pool_id: &str,
    monster_kind: BattleMonsterKind,
    monster_realm: Option<&str>,
    item_def: Option<&BattleRewardItemMeta>,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
) -> (i64, i64) {
    let qty_min = as_drop_entry_i64(entry.qty_min.as_ref(), 1).max(1);
    let qty_max = as_drop_entry_i64(entry.qty_max.as_ref(), qty_min).max(qty_min);
    let realm_rank = get_realm_rank_zero_based(monster_realm) as f64;
    let qty_min_add = as_drop_entry_f64(entry.qty_min_add_by_monster_realm.as_ref())
        .unwrap_or(0.0)
        .max(0.0);
    let qty_max_add = as_drop_entry_f64(entry.qty_max_add_by_monster_realm.as_ref())
        .unwrap_or(qty_min_add)
        .max(0.0)
        .max(qty_min_add);
    let base_min = ((qty_min as f64) + realm_rank * qty_min_add)
        .floor()
        .max(1.0) as i64;
    let base_max = ((qty_max as f64) + realm_rank * qty_max_add)
        .floor()
        .max(base_min as f64) as i64;
    let apply_qty_multiplier = should_apply_drop_quantity_multiplier(item_def);
    let common_multiplier = if apply_qty_multiplier {
        common_pool_multiplier(source_type, source_pool_id, monster_kind, is_dungeon_battle)
    } else {
        1.0
    };
    let min_after_common = if common_multiplier <= 1.0 {
        base_min
    } else {
        ((base_min as f64) * common_multiplier).floor().max(1.0) as i64
    };
    let max_after_common = if common_multiplier <= 1.0 {
        base_max.max(min_after_common)
    } else {
        ((base_max as f64) * common_multiplier)
            .floor()
            .max(min_after_common as f64) as i64
    };
    let qty_multiply_by_realm =
        as_drop_entry_f64(entry.qty_multiply_by_monster_realm.as_ref()).unwrap_or(1.0);
    let realm_mult = effective_realm_quantity_multiplier(qty_multiply_by_realm, monster_realm);
    let final_min = ((min_after_common as f64) * realm_mult).floor().max(1.0) as i64;
    let final_max = ((max_after_common as f64) * realm_mult)
        .floor()
        .max(final_min as f64) as i64;
    let _ = dungeon_reward_multiplier;
    (final_min, final_max)
}

fn should_apply_drop_quantity_multiplier(item_def: Option<&BattleRewardItemMeta>) -> bool {
    let Some(item_def) = item_def else {
        return true;
    };
    let category = item_def
        .category
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let sub_category = item_def
        .sub_category
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let has_learn_technique = item_def
        .effect_defs
        .as_ref()
        .and_then(|value| value.as_array())
        .map(|effects| {
            effects.iter().any(|effect| {
                effect.get("effect_type").and_then(|value| value.as_str())
                    == Some("learn_technique")
            })
        })
        .unwrap_or(false);
    category != "equipment"
        && sub_category != "technique"
        && sub_category != "technique_book"
        && !has_learn_technique
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BattleMonsterKind {
    Normal,
    Elite,
    Boss,
}

fn normalize_monster_kind(raw: Option<&str>) -> BattleMonsterKind {
    match raw.unwrap_or_default().trim().to_lowercase().as_str() {
        "elite" => BattleMonsterKind::Elite,
        "boss" => BattleMonsterKind::Boss,
        _ => BattleMonsterKind::Normal,
    }
}

fn adjusted_chance(
    chance: f64,
    source_type: BattleDropSourceType,
    source_pool_id: &str,
    monster_kind: BattleMonsterKind,
    monster_realm: Option<&str>,
    chance_add_by_monster_realm: f64,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
) -> f64 {
    if chance <= 0.0 {
        return 0.0;
    }
    let multiplied = chance
        * common_pool_multiplier(source_type, source_pool_id, monster_kind, is_dungeon_battle);
    let realm_bonus =
        get_realm_rank_zero_based(monster_realm) as f64 * chance_add_by_monster_realm.max(0.0);
    ((multiplied + realm_bonus)
        * dungeon_reward_rate_multiplier(
            source_pool_id,
            is_dungeon_battle,
            dungeon_reward_multiplier,
        ))
    .clamp(0.0, 1.0)
}

fn adjusted_weight(
    weight: f64,
    source_type: BattleDropSourceType,
    source_pool_id: &str,
    monster_kind: BattleMonsterKind,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
) -> f64 {
    if weight <= 0.0 {
        return 0.0;
    }
    weight
        * common_pool_multiplier(source_type, source_pool_id, monster_kind, is_dungeon_battle)
        * dungeon_reward_rate_multiplier(
            source_pool_id,
            is_dungeon_battle,
            dungeon_reward_multiplier,
        )
}

fn common_pool_multiplier(
    source_type: BattleDropSourceType,
    source_pool_id: &str,
    monster_kind: BattleMonsterKind,
    is_dungeon_battle: bool,
) -> f64 {
    if source_type != BattleDropSourceType::Common {
        return 1.0;
    }
    if matches!(
        source_pool_id,
        "dp-common-monster-elite"
            | "dp-common-monster-boss"
            | "dp-common-dungeon-boss-unbind"
            | "dp-common-dungeon-boss-advanced-recruit-token"
    ) {
        return 1.0;
    }
    match (monster_kind, is_dungeon_battle) {
        (BattleMonsterKind::Normal, false) => 1.0,
        (BattleMonsterKind::Normal, true) => 2.0,
        (BattleMonsterKind::Elite, false) => 2.0,
        (BattleMonsterKind::Elite, true) => 4.0,
        (BattleMonsterKind::Boss, false) => 4.0,
        (BattleMonsterKind::Boss, true) => 6.0,
    }
}

fn dungeon_reward_rate_multiplier(
    source_pool_id: &str,
    is_dungeon_battle: bool,
    dungeon_reward_multiplier: Option<f64>,
) -> f64 {
    if !is_dungeon_battle || excluded_pool_for_dungeon_reward_multiplier(source_pool_id) {
        return 1.0;
    }
    dungeon_reward_multiplier.unwrap_or(1.0).max(0.0)
}

fn excluded_pool_for_dungeon_reward_multiplier(source_pool_id: &str) -> bool {
    matches!(
        source_pool_id,
        "dp-common-dungeon-boss-unbind" | "dp-common-dungeon-boss-advanced-recruit-token"
    )
}

fn effective_realm_quantity_multiplier(multiplier: f64, monster_realm: Option<&str>) -> f64 {
    if multiplier <= 0.0 || (multiplier - 1.0).abs() < f64::EPSILON {
        return 1.0;
    }
    if multiplier < 1.0 {
        return multiplier.max(0.0);
    }
    let realm_rank = get_realm_rank_one_based_strict(monster_realm) as f64;
    1.0 + (multiplier - 1.0) * realm_rank
}

fn realm_suppression_multiplier(player_realm: Option<&str>, monster_realm: Option<&str>) -> f64 {
    let player_rank = get_realm_order_index(player_realm);
    let monster_rank = get_realm_order_index(monster_realm);
    if player_rank < 0 || monster_rank < 0 {
        return 1.0;
    }
    let extra_levels = player_rank - (monster_rank + 1);
    if extra_levels <= 0 {
        1.0
    } else {
        0.5_f64.powi(extra_levels as i32)
    }
}

fn normalized_entry_item_def_id(entry: &BattleDropPoolEntrySeed) -> Option<String> {
    entry
        .item_def_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn normalize_quality_weights(value: Option<&serde_json::Value>) -> Option<BTreeMap<String, f64>> {
    let object = value.and_then(|value| value.as_object())?;
    let mut weights = BTreeMap::new();
    for (key, raw) in object {
        let Some(weight) = as_drop_entry_f64(Some(raw)) else {
            continue;
        };
        if weight > 0.0 {
            weights.insert(key.clone(), weight);
        }
    }
    (!weights.is_empty()).then_some(weights)
}

fn stable_quality_weights_key(weights: Option<&BTreeMap<String, f64>>) -> String {
    weights
        .map(|weights| {
            weights
                .iter()
                .map(|(key, value)| format!("{key}:{value:.6}"))
                .collect::<Vec<_>>()
                .join(",")
        })
        .unwrap_or_default()
}

fn seed_u64(seed: &str) -> u64 {
    let digest = md5::compute(seed.as_bytes());
    u64::from_be_bytes([
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
    ])
}

fn get_realm_order_index(realm: Option<&str>) -> i64 {
    REALM_ORDER
        .iter()
        .position(|value| *value == realm.unwrap_or_default().trim())
        .map(|index| index as i64)
        .unwrap_or(-1)
}

fn get_realm_rank_zero_based(realm: Option<&str>) -> i64 {
    let index = get_realm_order_index(realm);
    if index >= 0 { index } else { 0 }
}

fn get_realm_rank_one_based_strict(realm: Option<&str>) -> i64 {
    let index = get_realm_order_index(realm);
    if index >= 0 { index + 1 } else { 1 }
}

const REALM_ORDER: &[&str] = &[
    "凡人",
    "炼精化炁·养气期",
    "炼精化炁·通脉期",
    "炼精化炁·凝炁期",
    "炼炁化神·炼己期",
    "炼炁化神·采药期",
    "炼炁化神·结胎期",
    "炼神返虚·养神期",
    "炼神返虚·还虚期",
    "炼神返虚·合道期",
    "炼虚合道·证道期",
    "炼虚合道·历劫期",
    "炼虚合道·成圣期",
];

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
                    category: item.category,
                    sub_category: item.sub_category,
                    effect_defs: item.effect_defs,
                    quality: item.quality,
                    can_disassemble: item.can_disassemble,
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

fn resolve_battle_drop_pool(
    pools: &BTreeMap<String, BattleDropPoolSeed>,
    pool_id: &str,
) -> Result<ResolvedBattleDropPoolSeed, String> {
    let normalized = pool_id.trim();
    if normalized.is_empty() {
        return Ok(ResolvedBattleDropPoolSeed {
            mode: "prob".to_string(),
            entries: Vec::new(),
        });
    }
    let Some(pool) = pools.get(normalized) else {
        return Ok(ResolvedBattleDropPoolSeed {
            mode: "prob".to_string(),
            entries: Vec::new(),
        });
    };
    let mut merged = BTreeMap::<String, ResolvedBattleDropEntrySeed>::new();
    for common_pool_id in normalize_common_pool_ids(pool.common_pool_ids.as_ref()) {
        let Some(common_pool) = pools.get(common_pool_id.as_str()) else {
            continue;
        };
        for entry in common_pool.entries.clone().unwrap_or_default() {
            let Some(item_def_id) = normalized_entry_item_def_id(&entry) else {
                continue;
            };
            merged.insert(
                item_def_id,
                ResolvedBattleDropEntrySeed {
                    entry,
                    source_type: BattleDropSourceType::Common,
                    source_pool_id: common_pool_id.clone(),
                },
            );
        }
    }
    for entry in pool.entries.clone().unwrap_or_default() {
        let Some(item_def_id) = normalized_entry_item_def_id(&entry) else {
            continue;
        };
        merged.insert(
            item_def_id,
            ResolvedBattleDropEntrySeed {
                entry,
                source_type: BattleDropSourceType::Exclusive,
                source_pool_id: normalized.to_string(),
            },
        );
    }
    let mut entries = merged.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        let left_order = as_drop_entry_i64(left.entry.sort_order.as_ref(), 0);
        let right_order = as_drop_entry_i64(right.entry.sort_order.as_ref(), 0);
        left_order.cmp(&right_order).then_with(|| {
            normalized_entry_item_def_id(&left.entry)
                .unwrap_or_default()
                .cmp(&normalized_entry_item_def_id(&right.entry).unwrap_or_default())
        })
    });
    Ok(ResolvedBattleDropPoolSeed {
        mode: if pool.mode.as_deref().map(str::trim) == Some("weight") {
            "weight".to_string()
        } else {
            "prob".to_string()
        },
        entries,
    })
}

fn normalize_common_pool_ids(value: Option<&Vec<String>>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    value
        .into_iter()
        .flatten()
        .filter_map(|raw| {
            let id = raw.trim();
            (!id.is_empty() && seen.insert(id.to_string())).then(|| id.to_string())
        })
        .collect()
}

fn as_drop_entry_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_f64(),
        Some(serde_json::Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_drop_entry_i64(value: Option<&serde_json::Value>, default_value: i64) -> i64 {
    match value {
        Some(serde_json::Value::Number(number)) => number.as_i64().unwrap_or(default_value),
        Some(serde_json::Value::String(text)) => {
            text.trim().parse::<i64>().unwrap_or(default_value)
        }
        _ => default_value,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BattleCharacterUnitProfile, BattleUnitCurrentAttrsDto, MinimalBattleRewardParticipant,
        MinimalPveItemRewardResolveOptions, apply_character_profile_to_battle_state,
        apply_minimal_pve_action, apply_minimal_pvp_action, build_minimal_pve_battle_state,
        build_minimal_pvp_battle_state, build_skill_value, resolve_minimal_pve_item_rewards,
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
                .any(|skill| skill["id"] == "skill-normal-attack")
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
        assert_eq!(outcome.logs[0]["type"], "action");
        assert_eq!(outcome.logs[0]["actorId"], "player-1");
        assert_eq!(outcome.logs[0]["actorName"], "修士1");
        assert_eq!(outcome.logs[0]["skillId"], "sk-heavy-slash");
        assert_eq!(outcome.logs[0]["skillName"], "重斩");
        assert_eq!(
            outcome.logs[0]["targets"][0]["targetId"],
            "monster-1-monster-gray-wolf"
        );
        assert!(
            outcome.logs[0]["targets"][0]["hits"][0]["damage"]
                .as_i64()
                .unwrap_or_default()
                > 0
        );
        assert_eq!(outcome.logs[1]["type"], "death");
        assert_eq!(outcome.logs[1]["unitName"], "灰狼");
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
            "skill-normal-attack",
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
            "skill-normal-attack",
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
        assert_eq!(outcome.logs[0]["type"], "action");
        assert_eq!(outcome.logs[0]["actorName"], "修士1");
        assert_eq!(outcome.logs[0]["skillName"], "普通攻击");
        assert_eq!(outcome.logs[1]["type"], "action");
        assert_eq!(outcome.logs[1]["actorName"], "灰狼");
        assert_eq!(outcome.logs[1]["skillName"], "撕咬");
        assert_eq!(outcome.logs[1]["targets"][0]["targetName"], "修士1");
        println!(
            "BATTLE_RUNTIME_PVE_PROGRESS_STATE={{\"finished\":{},\"attackerQixue\":{},\"defenderQixue\":{},\"roundCount\":{}}}",
            outcome.finished,
            state.teams.attacker.units[0].qixue,
            state.teams.defender.units[0].qixue,
            state.round_count
        );
    }

    #[test]
    fn minimal_pve_action_allows_innate_normal_attack_when_snapshot_skills_are_stale() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills = vec![build_skill_value(
            "sk-stale-snapshot-normal",
            "旧快照普攻",
            0,
            0,
            0,
        )];

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("innate normal attack should be resolved");

        assert_eq!(outcome.logs[0]["type"], "action");
        assert_eq!(outcome.logs[0]["skillId"], "skill-normal-attack");
        assert_eq!(outcome.logs[0]["skillName"], "普通攻击");
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
        assert_eq!(outcome.logs[0]["type"], "action");
        assert_eq!(outcome.logs[0]["actorName"], "修士1");
        assert_eq!(outcome.logs[0]["skillName"], "重斩");
        assert_eq!(outcome.logs[1]["type"], "death");
        assert_eq!(outcome.logs[1]["unitName"], "对手2");
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
        let rewards = resolve_minimal_pve_item_rewards(
            &["monster-wild-boar".to_string()],
            &MinimalPveItemRewardResolveOptions {
                reward_seed: "test-boar-reward".to_string(),
                participants: vec![MinimalBattleRewardParticipant {
                    character_id: 11,
                    user_id: 22,
                    fuyuan: 0.0,
                    realm: Some("凡人".to_string()),
                }],
                is_dungeon_battle: false,
                dungeon_reward_multiplier: None,
            },
        )
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
