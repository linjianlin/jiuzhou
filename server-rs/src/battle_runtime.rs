use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};

const MAX_ROUNDS_PVE: i64 = 100;
const MAX_ROUNDS_PVP: i64 = 100;
const MIN_HIT_RATE: f64 = 0.2;
const MAX_HIT_RATE: f64 = 1.0;
const MAX_PARRY_RATE: f64 = 0.6;
const PARRY_REDUCTION: f64 = 0.7;
const MAX_CRIT_RATE: f64 = 1.0;
const MONSTER_MAX_CRIT_DAMAGE_MULTIPLIER: f64 = 3.0;
const MAX_ELEMENT_RESIST: f64 = 0.8;
const ELEMENT_COUNTER_BONUS: f64 = 0.15;
const DEFENSE_DAMAGE_K: f64 = 1200.0;
const VOID_EROSION_MARK_ID: &str = "void_erosion";
const VOID_EROSION_DAMAGE_PER_STACK: f64 = 0.02;
const VOID_EROSION_DAMAGE_BONUS_CAP: f64 = 0.1;

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

#[derive(Debug, Clone)]
struct RuntimeResolvedTargetLog {
    target_id: String,
    target_name: String,
    damage: i64,
    heal: i64,
    shield: i64,
    buffs_applied: Vec<String>,
    is_miss: bool,
    is_crit: bool,
    is_parry: bool,
    is_element_bonus: bool,
    shield_absorbed: i64,
    momentum_gained: Vec<String>,
    momentum_consumed: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct RuntimeDamageOutcome {
    damage: i64,
    actual_damage: i64,
    is_miss: bool,
    is_parry: bool,
    is_crit: bool,
    is_element_bonus: bool,
    shield_absorbed: i64,
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
    element: Option<String>,
    level: Option<i64>,
    exp_reward: Option<i64>,
    silver_reward_min: Option<i64>,
    base_attrs: Option<MonsterBaseAttrs>,
    ai_profile: Option<MonsterAiProfileSeed>,
    drop_pool_id: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct MonsterAiProfileSeed {
    skills: Option<Vec<String>>,
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
    max_qixue: Option<i64>,
    lingqi: Option<i64>,
    max_lingqi: Option<i64>,
    wugong: Option<i64>,
    fagong: Option<i64>,
    wufang: Option<i64>,
    fafang: Option<i64>,
    sudu: Option<i64>,
    mingzhong: Option<serde_json::Value>,
    shanbi: Option<serde_json::Value>,
    zhaojia: Option<serde_json::Value>,
    baoji: Option<serde_json::Value>,
    baoshang: Option<serde_json::Value>,
    jianbaoshang: Option<serde_json::Value>,
    jianfantan: Option<serde_json::Value>,
    kangbao: Option<serde_json::Value>,
    zengshang: Option<serde_json::Value>,
    zhiliao: Option<serde_json::Value>,
    jianliao: Option<serde_json::Value>,
    xixue: Option<serde_json::Value>,
    lengque: Option<serde_json::Value>,
    kongzhi_kangxing: Option<serde_json::Value>,
    jin_kangxing: Option<serde_json::Value>,
    mu_kangxing: Option<serde_json::Value>,
    shui_kangxing: Option<serde_json::Value>,
    huo_kangxing: Option<serde_json::Value>,
    tu_kangxing: Option<serde_json::Value>,
    qixue_huifu: Option<serde_json::Value>,
    lingqi_huifu: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone)]
struct RuntimeSkillSeedFile {
    skills: Vec<RuntimeSkillSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct RuntimeSkillSeed {
    id: String,
    name: String,
    description: Option<String>,
    cost_lingqi: Option<i64>,
    cost_qixue: Option<i64>,
    cooldown: Option<i64>,
    target_type: Option<String>,
    target_count: Option<i64>,
    damage_type: Option<String>,
    element: Option<String>,
    effects: Option<Vec<serde_json::Value>>,
    trigger_type: Option<String>,
    ai_priority: Option<i64>,
    enabled: Option<bool>,
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

fn value_to_i64(raw: Option<serde_json::Value>, fallback: i64) -> i64 {
    match raw {
        Some(serde_json::Value::Number(number)) => {
            if let Some(value) = number.as_i64() {
                value
            } else if let Some(value) = number.as_f64() {
                value.round() as i64
            } else {
                fallback
            }
        }
        Some(serde_json::Value::String(text)) => text.trim().parse::<f64>().ok().map(|v| v.round() as i64).unwrap_or(fallback),
        _ => fallback,
    }
}

fn build_monster_battle_attrs(seed: &MonsterSeed) -> BattleUnitCurrentAttrsDto {
    let base_attrs = seed.base_attrs.clone().unwrap_or(MonsterBaseAttrs {
        qixue: None,
        max_qixue: None,
        lingqi: None,
        max_lingqi: None,
        wugong: None,
        fagong: None,
        wufang: None,
        fafang: None,
        sudu: None,
        mingzhong: None,
        shanbi: None,
        zhaojia: None,
        baoji: None,
        baoshang: None,
        jianbaoshang: None,
        jianfantan: None,
        kangbao: None,
        zengshang: None,
        zhiliao: None,
        jianliao: None,
        xixue: None,
        lengque: None,
        kongzhi_kangxing: None,
        jin_kangxing: None,
        mu_kangxing: None,
        shui_kangxing: None,
        huo_kangxing: None,
        tu_kangxing: None,
        qixue_huifu: None,
        lingqi_huifu: None,
    });
    BattleUnitCurrentAttrsDto {
        max_qixue: base_attrs.max_qixue.or(base_attrs.qixue).unwrap_or(50).max(1),
        max_lingqi: base_attrs.max_lingqi.or(base_attrs.lingqi).unwrap_or_default().max(0),
        wugong: base_attrs.wugong.unwrap_or(8).max(0),
        fagong: base_attrs.fagong.unwrap_or_default().max(0),
        wufang: base_attrs.wufang.unwrap_or_default().max(0),
        fafang: base_attrs.fafang.unwrap_or_default().max(0),
        sudu: base_attrs.sudu.unwrap_or(1).max(1),
        mingzhong: value_to_i64(base_attrs.mingzhong, 100),
        shanbi: value_to_i64(base_attrs.shanbi, 0),
        zhaojia: value_to_i64(base_attrs.zhaojia, 0),
        baoji: value_to_i64(base_attrs.baoji, 0),
        baoshang: value_to_i64(base_attrs.baoshang, 0),
        jianbaoshang: value_to_i64(base_attrs.jianbaoshang, 0),
        jianfantan: value_to_i64(base_attrs.jianfantan, 0),
        kangbao: value_to_i64(base_attrs.kangbao, 0),
        zengshang: value_to_i64(base_attrs.zengshang, 0),
        zhiliao: value_to_i64(base_attrs.zhiliao, 0),
        jianliao: value_to_i64(base_attrs.jianliao, 0),
        xixue: value_to_i64(base_attrs.xixue, 0),
        lengque: value_to_i64(base_attrs.lengque, 0),
        kongzhi_kangxing: value_to_i64(base_attrs.kongzhi_kangxing, 0),
        jin_kangxing: value_to_i64(base_attrs.jin_kangxing, 0),
        mu_kangxing: value_to_i64(base_attrs.mu_kangxing, 0),
        shui_kangxing: value_to_i64(base_attrs.shui_kangxing, 0),
        huo_kangxing: value_to_i64(base_attrs.huo_kangxing, 0),
        tu_kangxing: value_to_i64(base_attrs.tu_kangxing, 0),
        qixue_huifu: value_to_i64(base_attrs.qixue_huifu, 0),
        lingqi_huifu: value_to_i64(base_attrs.lingqi_huifu, 0),
        realm: seed.level.map(|level| format!("Lv.{level}")),
        element: Some(seed.element.clone().unwrap_or_else(|| "none".to_string())),
    }
}

fn runtime_skill_value_from_seed(seed: &RuntimeSkillSeed) -> serde_json::Value {
    serde_json::json!({
        "id": seed.id,
        "name": seed.name,
        "description": seed.description.clone().unwrap_or_else(|| seed.name.clone()),
        "type": "active",
        "damageType": seed.damage_type.clone().unwrap_or_else(|| "physical".to_string()),
        "targetType": seed.target_type.clone().unwrap_or_else(|| "single_enemy".to_string()),
        "targetCount": seed.target_count.unwrap_or(1).max(1),
        "element": seed.element.clone().unwrap_or_else(|| "none".to_string()),
        "triggerType": seed.trigger_type.clone().unwrap_or_else(|| "active".to_string()),
        "aiPriority": seed.ai_priority.unwrap_or(0),
        "cooldown": seed.cooldown.unwrap_or_default().max(0),
        "cost": {
            "lingqi": seed.cost_lingqi.unwrap_or_default().max(0),
            "qixue": seed.cost_qixue.unwrap_or_default().max(0)
        },
        "effects": seed.effects.clone().unwrap_or_default(),
    })
}

fn load_runtime_skill_seed_map() -> Result<BTreeMap<String, RuntimeSkillSeed>, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/skill_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read skill_def.json: {error}"))?;
    let payload: RuntimeSkillSeedFile = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse skill_def.json: {error}"))?;
    Ok(payload
        .skills
        .into_iter()
        .filter(|skill| skill.enabled != Some(false))
        .map(|skill| (skill.id.clone(), skill))
        .collect())
}

fn resolve_monster_battle_skills(seed: &MonsterSeed) -> Vec<serde_json::Value> {
    let skill_seed_map = load_runtime_skill_seed_map().ok();
    let configured_skill_ids = seed
        .ai_profile
        .as_ref()
        .and_then(|profile| profile.skills.clone())
        .unwrap_or_default();
    let mut skills = Vec::new();
    for skill_id in configured_skill_ids {
        let normalized = skill_id.trim();
        if normalized.is_empty() {
            continue;
        }
        if let Some(skill_seed) = skill_seed_map
            .as_ref()
            .and_then(|map| map.get(normalized))
        {
            skills.push(runtime_skill_value_from_seed(skill_seed));
        }
    }
    if !skills.iter().any(|skill| skill.get("id").and_then(serde_json::Value::as_str) == Some("skill-normal-attack")) {
        skills.insert(0, build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0));
    }
    if skills.is_empty() {
        skills.push(build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0));
    }
    skills
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

pub fn build_skill_value(
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
    vec![
        build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0),
        build_skill_value("sk-bite", "撕咬", 5, 0, 1),
    ]
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
            let seed_fallback = MonsterSeed {
                id: Some(monster_id.clone()),
                name: Some(monster_id.clone()),
                realm: None,
                kind: None,
                element: Some("none".to_string()),
                level: None,
                exp_reward: None,
                silver_reward_min: None,
                base_attrs: None,
                ai_profile: None,
                drop_pool_id: None,
                enabled: Some(true),
            };
            let seed = seed.unwrap_or(seed_fallback);
            let attrs = build_monster_battle_attrs(&seed);
            let qixue = attrs.max_qixue.max(1);
            let lingqi = attrs.max_lingqi.max(0);
            BattleUnitDto {
                id: format!("monster-{}-{}", index + 1, monster_id),
                name: seed.name.clone().unwrap_or_else(|| monster_id.clone()),
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
                skills: resolve_monster_battle_skills(&seed),
                skill_cooldowns: BTreeMap::new(),
                skill_cooldown_discount_bank: BTreeMap::new(),
                partner_skill_policy: None,
                control_diminishing: BTreeMap::new(),
                stats: empty_battle_stats(),
                reward_exp: Some(
                    seed
                        .exp_reward
                        .unwrap_or_default()
                        .max(0),
                ),
                reward_silver: Some(
                    seed
                        .silver_reward_min
                        .unwrap_or_default()
                        .max(0),
                ),
            }
        })
        .collect::<Vec<_>>();

    let mut state = BattleStateDto {
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
        round_count: 0,
        current_team: "attacker".to_string(),
        current_unit_id: None,
        phase: "roundStart".to_string(),
        first_mover: "attacker".to_string(),
        result: None,
        random_seed: deterministic_battle_seed(battle_id),
        random_index: 0,
        runtime_skill_cooldowns: BTreeMap::new(),
    };
    let mut start_logs = Vec::new();
    start_battle_runtime(&mut state, &mut start_logs);
    state
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
    let mut state = BattleStateDto {
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
        round_count: 0,
        current_team: "attacker".to_string(),
        current_unit_id: None,
        phase: "roundStart".to_string(),
        first_mover: "attacker".to_string(),
        result: None,
        random_seed: deterministic_battle_seed(battle_id),
        random_index: 0,
        runtime_skill_cooldowns: BTreeMap::new(),
    };
    let mut start_logs = Vec::new();
    start_battle_runtime(&mut state, &mut start_logs);
    state
}

pub fn build_minimal_partner_battle_unit(
    partner_id: i64,
    name: String,
    avatar: Option<String>,
    owner_unit_id: String,
    attrs: BattleUnitCurrentAttrsDto,
    qixue: i64,
    lingqi: i64,
    mut skills: Vec<serde_json::Value>,
    skill_policy: serde_json::Value,
    formation_order: i64,
) -> BattleUnitDto {
    if !skills.iter().any(|skill| {
        skill.get("id").and_then(|value| value.as_str()) == Some("skill-normal-attack")
    }) {
        skills.insert(
            0,
            build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0),
        );
    }
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
        qixue: qixue.max(1),
        lingqi: lingqi.max(0),
        current_attrs: attrs,
        shields: Vec::new(),
        is_alive: true,
        can_act: true,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills,
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: Some(skill_policy),
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    }
}

pub fn build_minimal_character_battle_unit(
    unit_kind: &str,
    profile: &BattleCharacterUnitProfile,
    formation_order: i64,
    skills: Vec<serde_json::Value>,
) -> BattleUnitDto {
    BattleUnitDto {
        id: format!("{unit_kind}-{}", profile.character_id),
        name: profile.name.clone(),
        r#type: unit_kind.to_string(),
        source_id: serde_json::json!(profile.character_id),
        base_attrs: profile.attrs.clone(),
        formation_order: Some(formation_order),
        owner_unit_id: None,
        month_card_active: Some(profile.month_card_active),
        avatar: profile.avatar.clone(),
        qixue: profile.qixue.clamp(0, profile.attrs.max_qixue.max(1)),
        lingqi: profile.lingqi.clamp(0, profile.attrs.max_lingqi.max(0)),
        current_attrs: profile.attrs.clone(),
        shields: Vec::new(),
        is_alive: profile.qixue > 0,
        can_act: profile.qixue > 0,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills,
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    }
}

fn determine_first_mover(state: &BattleStateDto) -> &'static str {
    if state.teams.defender.total_speed > state.teams.attacker.total_speed {
        "defender"
    } else {
        "attacker"
    }
}

fn opposing_team_key(team: &str) -> &'static str {
    if team == "attacker" {
        "defender"
    } else {
        "attacker"
    }
}

fn team_units<'a>(state: &'a BattleStateDto, team: &str) -> &'a [BattleUnitDto] {
    if team == "attacker" {
        &state.teams.attacker.units
    } else {
        &state.teams.defender.units
    }
}

fn team_units_mut<'a>(state: &'a mut BattleStateDto, team: &str) -> &'a mut Vec<BattleUnitDto> {
    if team == "attacker" {
        &mut state.teams.attacker.units
    } else {
        &mut state.teams.defender.units
    }
}

fn is_actable_unit(unit: &BattleUnitDto) -> bool {
    unit.is_alive && unit.can_act
}

fn sort_units_by_speed(units: &mut Vec<BattleUnitDto>) {
    units.sort_by(|left, right| {
        right
            .current_attrs
            .sudu
            .cmp(&left.current_attrs.sudu)
            .then_with(|| left.formation_order.unwrap_or(i64::MAX).cmp(&right.formation_order.unwrap_or(i64::MAX)))
    });
}

fn first_actable_unit_id(state: &BattleStateDto, team: &str) -> Option<String> {
    team_units(state, team)
        .iter()
        .find(|unit| is_actable_unit(unit))
        .map(|unit| unit.id.clone())
}

fn find_next_actable_unit_id_after(
    units: &[BattleUnitDto],
    start_exclusive_index: isize,
) -> Option<String> {
    let start = (start_exclusive_index + 1).max(0) as usize;
    units.iter()
        .skip(start)
        .find(|unit| is_actable_unit(unit))
        .map(|unit| unit.id.clone())
}

fn is_current_unit_actable(state: &BattleStateDto) -> bool {
    let Some(current_unit_id) = state.current_unit_id.as_deref() else {
        return false;
    };
    team_units(state, state.current_team.as_str())
        .iter()
        .any(|unit| unit.id == current_unit_id && is_actable_unit(unit))
}

fn build_round_start_log(round: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "round_start",
        "round": round.max(1),
    })
}

fn build_round_end_log(round: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "round_end",
        "round": round.max(1),
    })
}

fn build_dot_log(round: i64, unit_id: &str, unit_name: &str, buff_name: &str, damage: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "dot",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "buffName": buff_name,
        "damage": damage.max(0),
    })
}

fn build_hot_log(round: i64, unit_id: &str, unit_name: &str, buff_name: &str, heal: i64) -> serde_json::Value {
    serde_json::json!({
        "type": "hot",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "buffName": buff_name,
        "heal": heal.max(0),
    })
}

fn build_buff_expire_log(round: i64, unit_id: &str, unit_name: &str, buff_name: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "buff_expire",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "buffName": buff_name,
    })
}

fn process_passive_skills(state: &mut BattleStateDto, logs: &mut Vec<serde_json::Value>) {
    let passive_casts = state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .filter(|unit| unit.is_alive)
        .flat_map(|unit| {
            unit.skills.iter().filter_map(|skill| {
                if skill.get("triggerType").and_then(serde_json::Value::as_str) == Some("passive") {
                    skill.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|skill_id| (unit.id.clone(), skill_id.to_string()))
                } else {
                    None
                }
            })
        })
        .collect::<Vec<_>>();
    for (actor_id, skill_id) in passive_casts {
        if let Ok(mut passive_logs) = execute_runtime_skill_action(state, actor_id.as_str(), skill_id.as_str(), &[]) {
            logs.append(&mut passive_logs);
        }
    }
}

fn process_unit_round_start_effects(
    state: &mut BattleStateDto,
    unit_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
    let round = state.round_count;
    let Some(unit) = unit_by_id_mut(state, unit_id) else {
        return;
    };
    let unit_name = unit.name.clone();
    let buffs = unit.buffs.clone();
    for buff in buffs {
        if !unit.is_alive {
            break;
        }
        if let Some(dot) = buff.get("dot") {
            let damage = dot.get("damage").and_then(serde_json::Value::as_i64).unwrap_or_default().max(0);
            let qixue_before = unit.qixue;
            unit.qixue = (unit.qixue - damage).max(0);
            let actual_damage = (qixue_before - unit.qixue).max(0);
            unit.is_alive = unit.qixue > 0;
            unit.can_act = unit.is_alive;
            logs.push(build_dot_log(
                round,
                unit_id,
                unit_name.as_str(),
                buff.get("name").and_then(serde_json::Value::as_str).unwrap_or("持续伤害"),
                actual_damage,
            ));
            if !unit.is_alive {
                logs.push(build_minimal_death_log(round, unit_id, unit_name.as_str(), None, None));
            }
        }
        if let Some(hot) = buff.get("hot") {
            if !unit.is_alive {
                continue;
            }
            let heal = hot.get("heal").and_then(serde_json::Value::as_i64).unwrap_or_default().max(0);
            let qixue_before = unit.qixue;
            unit.qixue = (unit.qixue + heal).min(unit.current_attrs.max_qixue.max(1));
            let actual_heal = (unit.qixue - qixue_before).max(0);
            if actual_heal > 0 {
                logs.push(build_hot_log(
                    round,
                    unit_id,
                    unit_name.as_str(),
                    buff.get("name").and_then(serde_json::Value::as_str).unwrap_or("持续治疗"),
                    actual_heal,
                ));
            }
        }
    }
}

fn process_round_end_buffs(state: &mut BattleStateDto, unit_id: &str, logs: &mut Vec<serde_json::Value>) {
    let round = state.round_count;
    let Some(unit) = unit_by_id_mut(state, unit_id) else {
        return;
    };
    let unit_name = unit.name.clone();
    unit.buffs = unit
        .buffs
        .clone()
        .into_iter()
        .filter_map(|mut buff| {
            let remaining = buff
                .get("remainingDuration")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(-1);
            if remaining == -1 {
                return Some(buff);
            }
            let next_remaining = remaining - 1;
            if next_remaining <= 0 {
                logs.push(build_buff_expire_log(
                    round,
                    unit_id,
                    unit_name.as_str(),
                    buff.get("name").and_then(serde_json::Value::as_str).unwrap_or("效果"),
                ));
                None
            } else {
                if let Some(object) = buff.as_object_mut() {
                    object.insert("remainingDuration".to_string(), serde_json::json!(next_remaining));
                }
                Some(buff)
            }
        })
        .collect::<Vec<_>>();
    unit.shields = unit
        .shields
        .clone()
        .into_iter()
        .filter_map(|mut shield| {
            let duration = shield.get("duration").and_then(serde_json::Value::as_i64).unwrap_or(-1);
            if duration == -1 {
                return Some(shield);
            }
            let next_duration = duration - 1;
            if next_duration <= 0 {
                None
            } else {
                if let Some(object) = shield.as_object_mut() {
                    object.insert("duration".to_string(), serde_json::json!(next_duration));
                }
                Some(shield)
            }
        })
        .collect::<Vec<_>>();
    apply_runtime_attr_buffs(unit);
}

fn start_battle_runtime(state: &mut BattleStateDto, logs: &mut Vec<serde_json::Value>) {
    state.round_count = 1;
    state.current_unit_id = None;
    state.phase = "roundStart".to_string();
    apply_runtime_set_bonus_equip_effects(state);
    process_passive_skills(state, logs);
    process_round_start(state, logs);
}

pub fn restart_battle_runtime(state: &mut BattleStateDto) -> Vec<serde_json::Value> {
    state.current_team = "attacker".to_string();
    state.current_unit_id = None;
    state.phase = "roundStart".to_string();
    state.first_mover = "attacker".to_string();
    state.result = None;
    state.random_index = 0;
    state.runtime_skill_cooldowns.clear();
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        unit.current_attrs = unit.base_attrs.clone();
        unit.shields.clear();
        unit.buffs.clear();
        unit.marks.clear();
        unit.momentum = None;
        unit.skill_cooldowns.clear();
        unit.skill_cooldown_discount_bank.clear();
        unit.control_diminishing.clear();
        unit.is_alive = unit.qixue > 0;
        unit.can_act = unit.is_alive;
    }
    let mut logs = Vec::new();
    start_battle_runtime(state, &mut logs);
    logs
}

fn recover_unit_resources_for_round_start(unit: &mut BattleUnitDto) {
    let qixue_regen = unit.current_attrs.qixue_huifu.max(0);
    if qixue_regen > 0 {
        unit.qixue = (unit.qixue + qixue_regen).min(unit.current_attrs.max_qixue.max(1));
    }
    let lingqi_regen = unit.current_attrs.lingqi_huifu.max(0);
    if lingqi_regen > 0 {
        unit.lingqi = (unit.lingqi + lingqi_regen).min(unit.current_attrs.max_lingqi.max(0));
    }
}

fn process_round_start(state: &mut BattleStateDto, logs: &mut Vec<serde_json::Value>) {
    state.phase = "roundStart".to_string();
    logs.push(build_round_start_log(state.round_count));
    let unit_ids = state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>();
    for unit_id in unit_ids {
        let Some(unit) = unit_by_id_mut(state, unit_id.as_str()) else {
            continue;
        };
        if !unit.is_alive {
            unit.can_act = false;
            continue;
        }
        unit.can_act = true;
        decay_runtime_marks_at_round_start(unit);
        recover_unit_resources_for_round_start(unit);
        let unit_id = unit.id.clone();
        process_unit_round_start_effects(state, unit_id.as_str(), logs);
        process_runtime_set_bonus_turn_start_effects(state, unit_id.as_str(), logs);
    }
    refresh_battle_team_total_speed(state);
    state.first_mover = determine_first_mover(state).to_string();
    sort_units_by_speed(&mut state.teams.attacker.units);
    sort_units_by_speed(&mut state.teams.defender.units);
    state.current_team = state.first_mover.clone();
    state.phase = "action".to_string();
    state.current_unit_id = first_actable_unit_id(state, state.current_team.as_str());
    finish_battle_if_needed(state);
}

fn max_rounds_for_battle(state: &BattleStateDto) -> i64 {
    if state.battle_type == "pvp" {
        MAX_ROUNDS_PVP
    } else {
        MAX_ROUNDS_PVE
    }
}

fn process_round_end_and_start_next_round(
    state: &mut BattleStateDto,
    logs: &mut Vec<serde_json::Value>,
) {
    state.phase = "roundEnd".to_string();
    let unit_ids = state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>();
    for unit_id in unit_ids {
        process_round_end_buffs(state, unit_id.as_str(), logs);
        if let Some(unit) = unit_by_id_mut(state, unit_id.as_str()) {
            if !unit.is_alive {
                unit.can_act = false;
            }
        }
    }
    logs.push(build_round_end_log(state.round_count));
    if finish_battle_if_needed(state) {
        return;
    }
    if state.round_count >= max_rounds_for_battle(state) {
        state.phase = "finished".to_string();
        state.current_unit_id = None;
        state.result = Some("draw".to_string());
        return;
    }
    state.round_count += 1;
    state.current_unit_id = None;
    process_round_start(state, logs);
}

fn finish_battle_if_needed(state: &mut BattleStateDto) -> bool {
    let attacker_alive = state.teams.attacker.units.iter().any(|unit| unit.is_alive);
    let defender_alive = state.teams.defender.units.iter().any(|unit| unit.is_alive);
    if attacker_alive && defender_alive {
        return false;
    }
    state.phase = "finished".to_string();
    state.current_unit_id = None;
    state.result = Some(if attacker_alive {
        "attacker_win".to_string()
    } else {
        "defender_win".to_string()
    });
    true
}

fn advance_cursor_without_action(state: &mut BattleStateDto) {
    let current_team = state.current_team.clone();
    let current_index = state
        .current_unit_id
        .as_ref()
        .and_then(|unit_id| {
            team_units(state, current_team.as_str())
                .iter()
                .position(|unit| unit.id == *unit_id)
        })
        .map(|index| index as isize)
        .unwrap_or(-1);
    if let Some(next_unit_id) =
        find_next_actable_unit_id_after(team_units(state, current_team.as_str()), current_index)
    {
        state.current_unit_id = Some(next_unit_id);
        return;
    }
    state.current_unit_id = None;
    if state.current_team == state.first_mover {
        state.current_team = opposing_team_key(state.current_team.as_str()).to_string();
        state.current_unit_id = first_actable_unit_id(state, state.current_team.as_str());
        if state.current_unit_id.is_none() && !finish_battle_if_needed(state) {
            let mut noop_logs = Vec::new();
            process_round_end_and_start_next_round(state, &mut noop_logs);
        }
        return;
    }
    if !finish_battle_if_needed(state) {
        let mut noop_logs = Vec::new();
        process_round_end_and_start_next_round(state, &mut noop_logs);
    }
}

fn repair_action_cursor(state: &mut BattleStateDto) -> bool {
    if state.phase == "finished" {
        return false;
    }
    if is_current_unit_actable(state) {
        return false;
    }
    let max_steps = state.teams.attacker.units.len() + state.teams.defender.units.len() + 2;
    let mut repaired = false;
    for _ in 0..max_steps {
        if finish_battle_if_needed(state) || is_current_unit_actable(state) {
            return repaired;
        }
        let before = (
            state.phase.clone(),
            state.round_count,
            state.current_team.clone(),
            state.current_unit_id.clone(),
        );
        advance_cursor_without_action(state);
        repaired = true;
        let after = (
            state.phase.clone(),
            state.round_count,
            state.current_team.clone(),
            state.current_unit_id.clone(),
        );
        if before == after {
            break;
        }
    }
    repaired
}

fn complete_unit_action_and_advance(
    state: &mut BattleStateDto,
    actor_id: &str,
    used_skill_id: Option<&str>,
    logs: &mut Vec<serde_json::Value>,
) {
    let current_team = state.current_team.clone();
    let current_index = team_units(state, current_team.as_str())
        .iter()
        .position(|unit| unit.id == actor_id)
        .map(|index| index as isize)
        .unwrap_or(-1);
    if let Some(actor) = team_units_mut(state, current_team.as_str())
        .iter_mut()
        .find(|unit| unit.id == actor_id)
    {
        actor.can_act = false;
    }
    reduce_runtime_skill_cooldowns_for_unit(state, actor_id, used_skill_id);
    if finish_battle_if_needed(state) {
        return;
    }
    if let Some(next_unit_id) =
        find_next_actable_unit_id_after(team_units(state, current_team.as_str()), current_index)
    {
        state.current_unit_id = Some(next_unit_id);
        return;
    }
    state.current_unit_id = None;
    if state.current_team == state.first_mover {
        state.current_team = opposing_team_key(state.current_team.as_str()).to_string();
        state.current_unit_id = first_actable_unit_id(state, state.current_team.as_str());
        if state.current_unit_id.is_none() && !finish_battle_if_needed(state) {
            process_round_end_and_start_next_round(state, logs);
        }
        return;
    }
    if !finish_battle_if_needed(state) {
        process_round_end_and_start_next_round(state, logs);
    }
}

fn first_alive_unit_id(state: &BattleStateDto, team: &str) -> Option<String> {
    team_units(state, team)
        .iter()
        .find(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
}

fn resolve_selected_alive_target(
    state: &BattleStateDto,
    team: &str,
    target_ids: &[String],
) -> Result<Option<String>, String> {
    let Some(target_id) = target_ids.first() else {
        return Ok(None);
    };
    if team_units(state, team)
        .iter()
        .any(|unit| unit.id == *target_id && unit.is_alive)
    {
        return Ok(Some(target_id.clone()));
    }
    Err("目标不存在或已死亡".to_string())
}

fn unit_by_id<'a>(state: &'a BattleStateDto, unit_id: &str) -> Option<&'a BattleUnitDto> {
    state
        .teams
        .attacker
        .units
        .iter()
        .chain(state.teams.defender.units.iter())
        .find(|unit| unit.id == unit_id)
}

fn unit_by_id_mut<'a>(state: &'a mut BattleStateDto, unit_id: &str) -> Option<&'a mut BattleUnitDto> {
    state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
        .find(|unit| unit.id == unit_id)
}

fn runtime_skill_value<'a>(unit: &'a BattleUnitDto, skill_id: &str) -> Option<&'a serde_json::Value> {
    unit.skills.iter().find(|skill| {
        skill.get("id").and_then(serde_json::Value::as_str) == Some(skill_id.trim())
    })
}

fn runtime_skill_config_from_value(skill: &serde_json::Value) -> BattleSkillRuntimeConfig {
    BattleSkillRuntimeConfig {
        cost_lingqi: skill
            .get("cost")
            .and_then(|cost| cost.get("lingqi"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            .max(0),
        cost_qixue: skill
            .get("cost")
            .and_then(|cost| cost.get("qixue"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            .max(0),
        cooldown_turns: skill
            .get("cooldown")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            .max(0),
    }
}

fn resolve_runtime_skill_config(
    state: &BattleStateDto,
    actor_id: &str,
    skill_id: &str,
) -> Option<BattleSkillRuntimeConfig> {
    let skill_id = skill_id.trim();
    unit_by_id(state, actor_id)
        .and_then(|unit| runtime_skill_value(unit, skill_id))
        .map(runtime_skill_config_from_value)
        .or_else(|| battle_skill_runtime_config(skill_id))
}

fn skill_target_type(skill: &serde_json::Value) -> &str {
    skill.get("targetType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("single_enemy")
}

fn resolve_runtime_skill_targets(
    state: &BattleStateDto,
    actor_id: &str,
    skill_id: &str,
    selected_target_ids: &[String],
) -> Result<Vec<String>, String> {
    let actor = unit_by_id(state, actor_id).ok_or_else(|| "当前不可行动".to_string())?;
    let skill = runtime_skill_value(actor, skill_id)
        .ok_or_else(|| format!("战斗技能不存在: {}", skill_id.trim()))?;
    let target_type = skill_target_type(skill);
    let actor_team = if state.teams.attacker.units.iter().any(|unit| unit.id == actor_id) {
        "attacker"
    } else {
        "defender"
    };
    let enemy_team = opposing_team_key(actor_team);
    let ally_team = actor_team;

    let targets = match target_type {
        "self" => vec![actor_id.to_string()],
        "single_ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
        },
        "all_ally" => team_units(state, ally_team)
            .iter()
            .filter(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>(),
        "all_enemy" => team_units(state, enemy_team)
            .iter()
            .filter(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>(),
        "single_enemy" | "random_enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
        },
        _ => return Err(format!("不支持的目标类型: {target_type}")),
    };
    if targets.is_empty() {
        return Err("没有可攻击目标".to_string());
    }
    Ok(targets)
}

fn resolve_effect_base_value(
    actor: &BattleUnitDto,
    target: &BattleUnitDto,
    effect: &serde_json::Value,
    fallback_scale_attr: &str,
) -> i64 {
    let value = effect.get("value").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let value_type = effect
        .get("valueType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("scale");
    let scale_attr = effect
        .get("scaleAttr")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback_scale_attr);
    let actor_attr_value = battle_attr_value(actor.current_attrs.clone(), scale_attr);
    match value_type {
        "flat" => value.floor() as i64,
        "percent" => ((target.current_attrs.max_qixue as f64) * value).floor() as i64,
        "combined" => {
            let base = effect.get("baseValue").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
            let rate = effect.get("scaleRate").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
            (base + (actor_attr_value as f64) * rate).floor() as i64
        }
        _ => {
            let rate = effect
                .get("scaleRate")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(value);
            ((actor_attr_value as f64) * rate).floor() as i64
        }
    }
}

fn battle_attr_value(attrs: BattleUnitCurrentAttrsDto, attr_key: &str) -> i64 {
    match attr_key.trim() {
        "max_qixue" => attrs.max_qixue,
        "max_lingqi" => attrs.max_lingqi,
        "wugong" => attrs.wugong,
        "fagong" => attrs.fagong,
        "wufang" => attrs.wufang,
        "fafang" => attrs.fafang,
        "sudu" => attrs.sudu,
        "mingzhong" => attrs.mingzhong,
        "shanbi" => attrs.shanbi,
        "zhaojia" => attrs.zhaojia,
        "baoji" => attrs.baoji,
        "baoshang" => attrs.baoshang,
        "jianbaoshang" => attrs.jianbaoshang,
        "jianfantan" => attrs.jianfantan,
        "kangbao" => attrs.kangbao,
        "zengshang" => attrs.zengshang,
        "zhiliao" => attrs.zhiliao,
        "jianliao" => attrs.jianliao,
        "xixue" => attrs.xixue,
        "lengque" => attrs.lengque,
        "kongzhi_kangxing" => attrs.kongzhi_kangxing,
        "jin_kangxing" => attrs.jin_kangxing,
        "mu_kangxing" => attrs.mu_kangxing,
        "shui_kangxing" => attrs.shui_kangxing,
        "huo_kangxing" => attrs.huo_kangxing,
        "tu_kangxing" => attrs.tu_kangxing,
        "qixue_huifu" => attrs.qixue_huifu,
        "lingqi_huifu" => attrs.lingqi_huifu,
        _ => 0,
    }
}

fn effect_target_mode(effect: &serde_json::Value, skill_target_type: &str, effect_type: &str) -> &'static str {
    match effect.get("target").and_then(serde_json::Value::as_str) {
        Some("self") => "self",
        Some("target") => "target",
        Some("enemy") => "enemy",
        Some("ally") => "ally",
        _ => match effect_type {
            "buff" => {
                if matches!(skill_target_type, "single_enemy" | "all_enemy" | "random_enemy") {
                    "self"
                } else {
                    "target"
                }
            }
            "debuff" => "enemy",
            "heal" | "shield" | "restore_lingqi" | "resource" => {
                if matches!(skill_target_type, "single_enemy" | "all_enemy" | "random_enemy") {
                    "self"
                } else {
                    "target"
                }
            }
            _ => "target",
        },
    }
}

fn resolve_effect_target_ids(
    state: &BattleStateDto,
    actor_id: &str,
    selected_target_ids: &[String],
    skill_target_type: &str,
    effect: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let actor_team = if state.teams.attacker.units.iter().any(|unit| unit.id == actor_id) {
        "attacker"
    } else {
        "defender"
    };
    let enemy_team = opposing_team_key(actor_team);
    let ally_team = actor_team;
    let effect_type = effect.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
    let mode = effect_target_mode(effect, skill_target_type, effect_type);
    let resolved = match mode {
        "self" => vec![actor_id.to_string()],
        "ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
        },
        "enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
        },
        _ => match skill_target_type {
            "self" => vec![actor_id.to_string()],
            "single_ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
                Some(target_id) => vec![target_id],
                None => first_alive_unit_id(state, ally_team).map(|id| vec![id]).unwrap_or_default(),
            },
            "all_ally" => team_units(state, ally_team)
                .iter()
                .filter(|unit| unit.is_alive)
                .map(|unit| unit.id.clone())
                .collect::<Vec<_>>(),
            "all_enemy" => team_units(state, enemy_team)
                .iter()
                .filter(|unit| unit.is_alive)
                .map(|unit| unit.id.clone())
                .collect::<Vec<_>>(),
            "single_enemy" | "random_enemy" => match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
                Some(target_id) => vec![target_id],
                None => first_alive_unit_id(state, enemy_team).map(|id| vec![id]).unwrap_or_default(),
            },
            _ => return Err(format!("不支持的目标类型: {skill_target_type}")),
        },
    };
    if resolved.is_empty() {
        return Err("没有有效目标".to_string());
    }
    Ok(resolved)
}

fn get_or_create_target_log<'a>(
    target_logs: &'a mut Vec<RuntimeResolvedTargetLog>,
    target_id: &str,
    target_name: &str,
) -> &'a mut RuntimeResolvedTargetLog {
    if let Some(index) = target_logs.iter().position(|entry| entry.target_id == target_id) {
        return &mut target_logs[index];
    }
    target_logs.push(RuntimeResolvedTargetLog {
        target_id: target_id.to_string(),
        target_name: target_name.to_string(),
        damage: 0,
        heal: 0,
        shield: 0,
        buffs_applied: Vec::new(),
        is_miss: false,
        is_crit: false,
        is_parry: false,
        is_element_bonus: false,
        shield_absorbed: 0,
        momentum_gained: Vec::new(),
        momentum_consumed: Vec::new(),
    });
    target_logs.last_mut().expect("target log just pushed")
}

fn buff_effect_key(effect_type: &str, effect: &serde_json::Value) -> String {
    if let Some(raw) = effect.get("buffKey").and_then(serde_json::Value::as_str) {
        let normalized = raw.trim();
        if !normalized.is_empty() {
            return normalized.to_string();
        }
    }
    let attr_key = effect
        .get("attrKey")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("effect")
        .trim();
    if effect_type == "debuff" {
        format!("debuff-{attr_key}")
    } else {
        format!("buff-{attr_key}")
    }
}

fn apply_runtime_attr_buffs(unit: &mut BattleUnitDto) {
    unit.current_attrs = unit.base_attrs.clone();
    for buff in &unit.buffs {
        let modifiers = buff
            .get("attrModifiers")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        for modifier in modifiers {
            let attr = modifier.get("attr").and_then(serde_json::Value::as_str).unwrap_or("");
            let mode = modifier.get("mode").and_then(serde_json::Value::as_str).unwrap_or("flat");
            let value = modifier.get("value").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
            let base_value = battle_attr_value(unit.current_attrs.clone(), attr) as f64;
            let next_value = if mode == "percent" {
                base_value * (1.0 + value)
            } else {
                base_value + value
            };
            apply_attr_value(&mut unit.current_attrs, attr, next_value.round() as i64);
        }
    }
}

fn battle_unit_has_set_bonus_effects(unit: &BattleUnitDto) -> bool {
    !unit.set_bonus_effects.is_empty()
}

fn apply_runtime_attr_modifier_to_unit(
    unit: &mut BattleUnitDto,
    attr_key: &str,
    apply_type: &str,
    value: f64,
) {
    let current = battle_attr_value(unit.current_attrs.clone(), attr_key) as f64;
    let next = if apply_type == "percent" {
        current * (1.0 + value)
    } else {
        current + value
    };
    apply_attr_value(&mut unit.current_attrs, attr_key, next.round() as i64);
}

fn apply_runtime_set_bonus_equip_effects(state: &mut BattleStateDto) {
    for unit in state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
    {
        if !battle_unit_has_set_bonus_effects(unit) {
            continue;
        }
        for effect in unit.set_bonus_effects.clone() {
            if effect.get("trigger").and_then(serde_json::Value::as_str) != Some("equip") {
                continue;
            }
            if effect.get("target").and_then(serde_json::Value::as_str) != Some("self") {
                continue;
            }
            let effect_type = effect.get("effectType").and_then(serde_json::Value::as_str).unwrap_or("");
            let params = effect.get("params").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
            match effect_type {
                "buff" => {
                    let attr_key = params.get("attr_key").and_then(serde_json::Value::as_str).unwrap_or("").trim();
                    let apply_type = params.get("apply_type").and_then(serde_json::Value::as_str).unwrap_or("flat");
                    let value = params
                        .get("value")
                        .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
                        .unwrap_or_default();
                    if !attr_key.is_empty() && value != 0.0 {
                        apply_runtime_attr_modifier_to_unit(unit, attr_key, apply_type, value);
                    }
                }
                "shield" => {
                    let value = params
                        .get("value")
                        .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|v| v.round() as i64)))
                        .unwrap_or_default();
                    if value > 0 {
                        unit.shields.push(serde_json::json!({
                            "id": format!("set-shield-{}-{}", unit.id, effect.get("setId").and_then(serde_json::Value::as_str).unwrap_or("set")),
                            "sourceSkillId": effect.get("setId").and_then(serde_json::Value::as_str).unwrap_or("set-bonus"),
                            "value": value,
                            "maxValue": value,
                            "duration": effect.get("durationRound").and_then(serde_json::Value::as_i64).unwrap_or(1),
                            "absorbType": "all",
                            "priority": 0,
                        }));
                    }
                }
                _ => {}
            }
        }
    }
}

fn process_runtime_set_bonus_turn_start_effects(
    state: &mut BattleStateDto,
    unit_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
    let round = state.round_count;
    let Some(unit) = unit_by_id_mut(state, unit_id) else {
        return;
    };
    let unit_name = unit.name.clone();
    for effect in unit.set_bonus_effects.clone() {
        if effect.get("trigger").and_then(serde_json::Value::as_str) != Some("on_turn_start") {
            continue;
        }
        if effect.get("target").and_then(serde_json::Value::as_str) != Some("self") {
            continue;
        }
        let effect_type = effect.get("effectType").and_then(serde_json::Value::as_str).unwrap_or("");
        let params = effect.get("params").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
        match effect_type {
            "heal" => {
                let heal = params
                    .get("value")
                    .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|v| v.round() as i64)))
                    .unwrap_or_default()
                    .max(0);
                if heal > 0 && unit.is_alive {
                    let before = unit.qixue;
                    unit.qixue = (unit.qixue + heal).min(unit.current_attrs.max_qixue.max(1));
                    let actual = (unit.qixue - before).max(0);
                    if actual > 0 {
                        logs.push(build_hot_log(round, unit_id, unit_name.as_str(), effect.get("setName").and_then(serde_json::Value::as_str).unwrap_or("套装效果"), actual));
                    }
                }
            }
            "resource" => {
                let value = params
                    .get("value")
                    .and_then(|val| val.as_i64().or_else(|| val.as_f64().map(|v| v.round() as i64)))
                    .unwrap_or_default();
                let resource_type = params.get("resource_type").and_then(serde_json::Value::as_str).unwrap_or("lingqi");
                if resource_type == "qixue" {
                    unit.qixue = (unit.qixue + value).clamp(0, unit.current_attrs.max_qixue.max(1));
                } else {
                    unit.lingqi = (unit.lingqi + value).clamp(0, unit.current_attrs.max_lingqi.max(0));
                }
            }
            "buff" => {
                let attr_key = params.get("attr_key").and_then(serde_json::Value::as_str).unwrap_or("").trim();
                let apply_type = params.get("apply_type").and_then(serde_json::Value::as_str).unwrap_or("flat");
                let value = params
                    .get("value")
                    .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
                    .unwrap_or_default();
                if !attr_key.is_empty() && value != 0.0 {
                    unit.buffs.push(serde_json::json!({
                        "id": format!("set-buff-{}-{}", unit.id, effect.get("setId").and_then(serde_json::Value::as_str).unwrap_or("set")),
                        "buffDefId": format!("set-buff-{}", attr_key),
                        "name": effect.get("setName").and_then(serde_json::Value::as_str).unwrap_or("套装效果"),
                        "type": "buff",
                        "category": "set_bonus",
                        "sourceUnitId": unit.id,
                        "remainingDuration": effect.get("durationRound").and_then(serde_json::Value::as_i64).unwrap_or(1),
                        "stacks": 1,
                        "maxStacks": 1,
                        "attrModifiers": [{
                            "attr": attr_key,
                            "value": value,
                            "mode": apply_type,
                        }],
                        "tags": ["set_bonus"],
                        "dispellable": true,
                    }));
                    apply_runtime_attr_buffs(unit);
                }
            }
            _ => {}
        }
    }
}

fn runtime_has_control(unit: &BattleUnitDto, control_type: &str) -> bool {
    unit.buffs.iter().any(|buff| {
        buff.get("control").and_then(serde_json::Value::as_str) == Some(control_type)
    })
}

fn runtime_is_stunned(unit: &BattleUnitDto) -> bool {
    runtime_has_control(unit, "stun") || runtime_has_control(unit, "freeze")
}

fn runtime_is_feared(unit: &BattleUnitDto) -> bool {
    runtime_has_control(unit, "fear")
}

fn runtime_is_silenced(unit: &BattleUnitDto) -> bool {
    runtime_has_control(unit, "silence")
}

fn runtime_is_disarmed(unit: &BattleUnitDto) -> bool {
    runtime_has_control(unit, "disarm")
}

fn remove_runtime_buffs_by_predicate<F>(unit: &mut BattleUnitDto, predicate: F) -> Vec<String>
where
    F: Fn(&serde_json::Value) -> bool,
{
    let mut removed = Vec::new();
    unit.buffs = unit
        .buffs
        .clone()
        .into_iter()
        .filter(|buff| {
            if predicate(buff) {
                if let Some(name) = buff.get("name").and_then(serde_json::Value::as_str) {
                    removed.push(name.to_string());
                }
                return false;
            }
            true
        })
        .collect::<Vec<_>>();
    apply_runtime_attr_buffs(unit);
    removed
}

fn apply_runtime_mark_effect(
    target: &mut BattleUnitDto,
    source_unit_id: &str,
    effect: &serde_json::Value,
) -> Option<String> {
    let mark_id = effect
        .get("markId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(VOID_EROSION_MARK_ID)
        .to_string();
    let stacks = effect
        .get("applyStacks")
        .or_else(|| effect.get("stacks"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let max_stacks = effect
        .get("maxStacks")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(5)
        .max(1);
    let duration = effect
        .get("duration")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(2)
        .max(1);
    let marks = &mut target.marks;
    if let Some(existing) = marks.iter_mut().find(|mark| {
        mark.get("id").and_then(serde_json::Value::as_str) == Some(mark_id.as_str())
            && mark.get("sourceUnitId").and_then(serde_json::Value::as_str) == Some(source_unit_id)
    }) {
        let current_stacks = existing.get("stacks").and_then(serde_json::Value::as_i64).unwrap_or_default();
        if let Some(object) = existing.as_object_mut() {
            object.insert("stacks".to_string(), serde_json::json!((current_stacks + stacks).min(max_stacks)));
            object.insert("remainingDuration".to_string(), serde_json::json!(duration));
            object.insert("maxStacks".to_string(), serde_json::json!(max_stacks));
        }
    } else {
        marks.push(serde_json::json!({
            "id": mark_id,
            "sourceUnitId": source_unit_id,
            "stacks": stacks.min(max_stacks),
            "maxStacks": max_stacks,
            "remainingDuration": duration,
        }));
    }
    Some(mark_id)
}

fn decay_runtime_marks_at_round_start(unit: &mut BattleUnitDto) {
    unit.marks = unit
        .marks
        .clone()
        .into_iter()
        .filter_map(|mut mark| {
            let remaining = mark
                .get("remainingDuration")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            let next_remaining = remaining - 1;
            if next_remaining <= 0 {
                None
            } else {
                if let Some(object) = mark.as_object_mut() {
                    object.insert("remainingDuration".to_string(), serde_json::json!(next_remaining));
                }
                Some(mark)
            }
        })
        .collect::<Vec<_>>();
}

fn runtime_void_erosion_damage_bonus(attacker: &BattleUnitDto, defender: &BattleUnitDto) -> f64 {
    let total_stacks = defender
        .marks
        .iter()
        .filter(|mark| {
            mark.get("id").and_then(serde_json::Value::as_str) == Some(VOID_EROSION_MARK_ID)
                && mark.get("sourceUnitId").and_then(serde_json::Value::as_str) == Some(attacker.id.as_str())
        })
        .map(|mark| mark.get("stacks").and_then(serde_json::Value::as_i64).unwrap_or_default())
        .sum::<i64>();
    ((total_stacks as f64) * VOID_EROSION_DAMAGE_PER_STACK).min(VOID_EROSION_DAMAGE_BONUS_CAP)
}

fn apply_attr_value(attrs: &mut BattleUnitCurrentAttrsDto, attr: &str, value: i64) {
    match attr.trim() {
        "max_qixue" => attrs.max_qixue = value.max(1),
        "max_lingqi" => attrs.max_lingqi = value.max(0),
        "wugong" => attrs.wugong = value,
        "fagong" => attrs.fagong = value,
        "wufang" => attrs.wufang = value,
        "fafang" => attrs.fafang = value,
        "sudu" => attrs.sudu = value.max(0),
        "mingzhong" => attrs.mingzhong = value,
        "shanbi" => attrs.shanbi = value,
        "zhaojia" => attrs.zhaojia = value,
        "baoji" => attrs.baoji = value,
        "baoshang" => attrs.baoshang = value,
        "jianbaoshang" => attrs.jianbaoshang = value,
        "jianfantan" => attrs.jianfantan = value,
        "kangbao" => attrs.kangbao = value,
        "zengshang" => attrs.zengshang = value,
        "zhiliao" => attrs.zhiliao = value,
        "jianliao" => attrs.jianliao = value,
        "xixue" => attrs.xixue = value,
        "lengque" => attrs.lengque = value,
        "kongzhi_kangxing" => attrs.kongzhi_kangxing = value,
        "jin_kangxing" => attrs.jin_kangxing = value,
        "mu_kangxing" => attrs.mu_kangxing = value,
        "shui_kangxing" => attrs.shui_kangxing = value,
        "huo_kangxing" => attrs.huo_kangxing = value,
        "tu_kangxing" => attrs.tu_kangxing = value,
        "qixue_huifu" => attrs.qixue_huifu = value,
        "lingqi_huifu" => attrs.lingqi_huifu = value,
        _ => {}
    }
}

fn normalized_rate(value: i64) -> f64 {
    if value <= 0 {
        0.0
    } else if value > 1 {
        (value as f64) / 100.0
    } else {
        value as f64
    }
}

fn normalized_multiplier(value: i64) -> f64 {
    if value <= 0 {
        0.0
    } else if value >= 10 {
        (value as f64) / 100.0
    } else {
        value as f64
    }
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn next_runtime_random(state: &mut BattleStateDto) -> f64 {
    let seed = (state.random_seed as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add((state.random_index as u64).wrapping_add(1442695040888963407));
    state.random_index += 1;
    ((seed >> 11) as f64) / ((u64::MAX >> 11) as f64)
}

fn roll_runtime_chance(state: &mut BattleStateDto, chance: f64) -> bool {
    if chance <= 0.0 {
        return false;
    }
    if chance >= 1.0 {
        return true;
    }
    next_runtime_random(state) < chance
}

fn damage_type_defense(target: &BattleUnitDto, damage_type: &str) -> f64 {
    match damage_type {
        "magic" => target.current_attrs.fafang as f64,
        _ => target.current_attrs.wufang as f64,
    }
}

fn is_element_counter(attack_element: Option<&str>, defend_element: Option<&str>) -> bool {
    matches!(
        (attack_element.unwrap_or("none"), defend_element.unwrap_or("none")),
        ("jin", "mu") | ("mu", "tu") | ("tu", "shui") | ("shui", "huo") | ("huo", "jin")
    )
}

fn element_resistance(target: &BattleUnitDto, element: Option<&str>) -> f64 {
    match element.unwrap_or("none") {
        "jin" => normalized_rate(target.current_attrs.jin_kangxing),
        "mu" => normalized_rate(target.current_attrs.mu_kangxing),
        "shui" => normalized_rate(target.current_attrs.shui_kangxing),
        "huo" => normalized_rate(target.current_attrs.huo_kangxing),
        "tu" => normalized_rate(target.current_attrs.tu_kangxing),
        _ => 0.0,
    }
}

fn apply_runtime_damage_to_target(
    target: &mut BattleUnitDto,
    damage: i64,
    damage_type: &str,
) -> (i64, i64) {
    let mut remaining_damage = damage.max(0);
    let mut total_absorbed = 0_i64;
    let mut indexed_shields = target
        .shields
        .iter()
        .enumerate()
        .filter_map(|(index, shield)| {
            shield.as_object().map(|object| {
                (
                    index,
                    object.get("priority").and_then(serde_json::Value::as_i64).unwrap_or_default(),
                )
            })
        })
        .collect::<Vec<_>>();
    indexed_shields.sort_by(|a, b| b.1.cmp(&a.1));
    let mut remove_indices = Vec::new();
    for (index, _) in indexed_shields {
        if remaining_damage <= 0 {
            break;
        }
        let Some(shield) = target.shields.get_mut(index) else {
            continue;
        };
        let absorb_type = shield
            .get("absorbType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("all");
        if absorb_type != "all" && absorb_type != damage_type {
            continue;
        }
        let current_value = shield.get("value").and_then(serde_json::Value::as_i64).unwrap_or_default();
        let absorbed = current_value.min(remaining_damage).max(0);
        remaining_damage -= absorbed;
        total_absorbed += absorbed;
        let next_value = current_value - absorbed;
        if let Some(object) = shield.as_object_mut() {
            object.insert("value".to_string(), serde_json::json!(next_value.max(0)));
        }
        if next_value <= 0 {
            remove_indices.push(index);
        }
    }
    remove_indices.sort_unstable();
    remove_indices.reverse();
    for index in remove_indices {
        target.shields.remove(index);
    }
    let actual_damage = remaining_damage.min(target.qixue).max(0);
    target.qixue -= actual_damage;
    target.stats.damage_taken += actual_damage;
    target.is_alive = target.qixue > 0;
    if !target.is_alive {
        target.qixue = 0;
        target.can_act = false;
    }
    (actual_damage, total_absorbed)
}

fn calculate_runtime_damage(
    state: &mut BattleStateDto,
    attacker: &BattleUnitDto,
    defender: &BattleUnitDto,
    damage_type: &str,
    element: Option<&str>,
    base_damage: i64,
) -> RuntimeDamageOutcome {
    let mut outcome = RuntimeDamageOutcome::default();
    let mut damage = (base_damage as f64).max(0.0);
    if damage <= 0.0 {
        return outcome;
    }
    let hit_rate = clamp_f64(
        normalized_rate(attacker.current_attrs.mingzhong) - normalized_rate(defender.current_attrs.shanbi),
        MIN_HIT_RATE,
        MAX_HIT_RATE,
    );
    if !roll_runtime_chance(state, hit_rate) {
        outcome.is_miss = true;
        return outcome;
    }
    if damage_type != "true" {
        let defense = damage_type_defense(defender, damage_type).max(0.0);
        damage *= DEFENSE_DAMAGE_K / (defense + DEFENSE_DAMAGE_K);
    }
    let parry_rate = clamp_f64(normalized_rate(defender.current_attrs.zhaojia), 0.0, MAX_PARRY_RATE);
    if roll_runtime_chance(state, parry_rate) {
        outcome.is_parry = true;
        damage *= PARRY_REDUCTION;
    }
    if damage_type != "true" {
        let crit_rate = clamp_f64(
            normalized_rate(attacker.current_attrs.baoji) - normalized_rate(defender.current_attrs.kangbao),
            0.0,
            MAX_CRIT_RATE,
        );
        if roll_runtime_chance(state, crit_rate) {
            outcome.is_crit = true;
            let attacker_baoshang = normalized_multiplier(attacker.current_attrs.baoshang);
            let capped_baoshang = if attacker.r#type == "monster" {
                attacker_baoshang.min(MONSTER_MAX_CRIT_DAMAGE_MULTIPLIER)
            } else {
                attacker_baoshang
            };
            let crit_multiplier = (capped_baoshang - normalized_rate(defender.current_attrs.jianbaoshang)).max(1.0);
            damage *= crit_multiplier;
        }
    }
    damage *= 1.0 + normalized_rate(attacker.current_attrs.zengshang);
    let mark_bonus = runtime_void_erosion_damage_bonus(attacker, defender);
    if mark_bonus > 0.0 {
        damage *= 1.0 + mark_bonus;
    }
    if is_element_counter(element, defender.current_attrs.element.as_deref()) {
        outcome.is_element_bonus = true;
        damage *= 1.0 + ELEMENT_COUNTER_BONUS;
    }
    let resistance = clamp_f64(element_resistance(defender, element), 0.0, MAX_ELEMENT_RESIST);
    damage *= 1.0 - resistance;
    outcome.damage = damage.floor().max(1.0) as i64;
    outcome
}

fn apply_runtime_buff_effect(
    unit: &mut BattleUnitDto,
    source_unit_id: &str,
    effect_type: &str,
    effect: &serde_json::Value,
) -> Option<String> {
    let buff_kind = effect.get("buffKind").and_then(serde_json::Value::as_str).unwrap_or("");
    if buff_kind != "attr" {
        return None;
    }
    let attr_key = effect.get("attrKey").and_then(serde_json::Value::as_str).unwrap_or("");
    if attr_key.trim().is_empty() {
        return None;
    }
    let mode = effect.get("applyType").and_then(serde_json::Value::as_str).unwrap_or("flat");
    let raw_value = effect.get("value").and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    let value = if effect_type == "debuff" { -raw_value } else { raw_value };
    let buff_key = buff_effect_key(effect_type, effect);
    let buff_value = serde_json::json!({
        "id": buff_key,
        "buffDefId": buff_key,
        "name": buff_key,
        "type": effect_type,
        "category": "runtime",
        "sourceUnitId": source_unit_id,
        "remainingDuration": effect.get("duration").and_then(serde_json::Value::as_i64).unwrap_or(1).max(1),
        "stacks": effect.get("stacks").and_then(serde_json::Value::as_i64).unwrap_or(1).max(1),
        "maxStacks": effect.get("stacks").and_then(serde_json::Value::as_i64).unwrap_or(1).max(1),
        "attrModifiers": [{
            "attr": attr_key,
            "value": value,
            "mode": mode,
        }],
        "tags": [],
        "dispellable": true,
    });
    unit.buffs.retain(|buff| buff.get("buffDefId") != Some(&serde_json::json!(buff_key)));
    unit.buffs.push(buff_value);
    apply_runtime_attr_buffs(unit);
    Some(buff_key)
}

fn can_use_runtime_skill_now(state: &BattleStateDto, actor_id: &str, skill_id: &str) -> bool {
    let Some(config) = resolve_runtime_skill_config(state, actor_id, skill_id) else {
        return true;
    };
    if state
        .runtime_skill_cooldowns
        .get(format!("{actor_id}:{skill_id}").as_str())
        .copied()
        .unwrap_or_default()
        > 0
    {
        return false;
    }
    let Some(actor) = unit_by_id(state, actor_id) else {
        return false;
    };
    let damage_type = runtime_skill_value(actor, skill_id)
        .and_then(|skill| skill.get("damageType").and_then(serde_json::Value::as_str))
        .unwrap_or("physical");
    actor.is_alive
        && !runtime_is_stunned(actor)
        && !runtime_is_feared(actor)
        && !(damage_type == "magic" && runtime_is_silenced(actor))
        && !(damage_type == "physical" && runtime_is_disarmed(actor))
        && actor.lingqi >= config.cost_lingqi.max(0)
        && actor.qixue > config.cost_qixue.max(0)
}

fn resolve_ai_skill_id(state: &BattleStateDto, actor_id: &str) -> Result<String, String> {
    let Some(unit) = unit_by_id(state, actor_id) else {
        return Err("当前不可行动".to_string());
    };
    if runtime_is_stunned(unit) || runtime_is_feared(unit) {
        return Ok("skill-normal-attack".to_string());
    }
    for preferred_skill_id in ["sk-bite", "skill-normal-attack"] {
        if unit
            .skills
            .iter()
            .any(|skill| skill.get("id").and_then(serde_json::Value::as_str) == Some(preferred_skill_id))
            && can_use_runtime_skill_now(state, actor_id, preferred_skill_id)
        {
            return Ok(preferred_skill_id.to_string());
        }
    }
    unit.skills
        .iter()
        .filter_map(|skill| skill.get("id").and_then(serde_json::Value::as_str))
        .find(|skill_id| can_use_runtime_skill_now(state, actor_id, skill_id))
        .map(str::to_string)
        .ok_or_else(|| "当前不可行动".to_string())
}

fn resolve_partner_skill_id(state: &BattleStateDto, actor_id: &str) -> Result<String, String> {
    let Some(unit) = unit_by_id(state, actor_id) else {
        return Err("当前不可行动".to_string());
    };
    let ordered_policy_skills = unit
        .partner_skill_policy
        .as_ref()
        .and_then(|policy| policy.get("slots"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|slot| {
            let skill_id = slot.get("skillId")?.as_str()?.trim().to_string();
            if skill_id.is_empty() {
                return None;
            }
            let enabled = slot.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
            if !enabled {
                return None;
            }
            let priority = slot.get("priority").and_then(serde_json::Value::as_i64).unwrap_or(i64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    let mut ordered_policy_skills = ordered_policy_skills;
    ordered_policy_skills.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    for (_, skill_id) in ordered_policy_skills {
        if can_use_runtime_skill_now(state, actor_id, skill_id.as_str()) {
            return Ok(skill_id);
        }
    }
    resolve_ai_skill_id(state, actor_id)
}

fn execute_runtime_auto_turn(
    state: &mut BattleStateDto,
    actor_id: &str,
    logs: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    let actor = unit_by_id(state, actor_id)
        .cloned()
        .ok_or_else(|| "当前不可行动".to_string())?;
    if runtime_is_stunned(&actor) || runtime_is_feared(&actor) {
        logs.push(build_runtime_action_log(
            state.round_count.max(1),
            actor.id.as_str(),
            actor.name.as_str(),
            "skip",
            "跳过",
            &[],
        ));
        complete_unit_action_and_advance(state, actor_id, None, logs);
        return Ok(());
    }
    let skill_id = if actor.r#type == "partner" {
        resolve_partner_skill_id(state, actor_id)?
    } else {
        resolve_ai_skill_id(state, actor_id)?
    };
    consume_runtime_skill_cost_and_validate_cooldown(state, actor_id, skill_id.as_str())?;
    let target_ids = resolve_runtime_skill_targets(state, actor_id, skill_id.as_str(), &[])?;
    logs.extend(execute_runtime_skill_action(state, actor_id, skill_id.as_str(), &target_ids)?);
    complete_unit_action_and_advance(state, actor_id, Some(skill_id.as_str()), logs);
    Ok(())
}

fn run_attacker_auto_turns_until_owner_or_switch(
    state: &mut BattleStateDto,
    owner_actor_id: &str,
    logs: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    while state.phase != "finished" && state.current_team == "attacker" {
        repair_action_cursor(state);
        let Some(current_actor_id) = state.current_unit_id.clone() else {
            break;
        };
        if current_actor_id == owner_actor_id {
            break;
        }
        let Some(actor) = unit_by_id(state, current_actor_id.as_str()) else {
            break;
        };
        if actor.r#type == "player" {
            break;
        }
        execute_runtime_auto_turn(state, current_actor_id.as_str(), logs)?;
    }
    Ok(())
}

fn execute_runtime_damage_action(
    state: &mut BattleStateDto,
    actor_id: &str,
    target_id: &str,
    skill_id: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let actor_name = unit_by_id(state, actor_id)
        .map(|unit| unit.name.clone())
        .ok_or_else(|| "当前不可行动".to_string())?;
    let skill_name = unit_by_id(state, actor_id)
        .and_then(|unit| resolve_unit_skill_name(unit, skill_id).ok())
        .ok_or_else(|| format!("战斗技能不存在: {}", skill_id.trim()))?;
    let damage = resolve_runtime_skill_damage(state, actor_id, skill_id);
    let action_round = state.round_count.max(1);

    let target_name = unit_by_id(state, target_id)
        .map(|unit| unit.name.clone())
        .ok_or_else(|| "目标不存在或已死亡".to_string())?;
    let (actual_damage, target_dead) = {
        let Some(target) = unit_by_id_mut(state, target_id) else {
            return Err("目标不存在或已死亡".to_string());
        };
        if !target.is_alive {
            return Err("目标不存在或已死亡".to_string());
        }
        let qixue_before = target.qixue;
        target.qixue = (target.qixue - damage).max(0);
        let dealt = (qixue_before - target.qixue).max(0);
        target.is_alive = target.qixue > 0;
        target.can_act = target.is_alive && target.can_act;
        (dealt, !target.is_alive)
    };

    let mut logs = vec![build_minimal_action_log(MinimalActionLogDraft {
        round: action_round,
        actor_id,
        actor_name: &actor_name,
        skill_id: skill_id.trim(),
        skill_name: &skill_name,
        target_id,
        target_name: &target_name,
        damage: actual_damage,
    })];
    if target_dead {
        logs.push(build_minimal_death_log(
            action_round,
            target_id,
            &target_name,
            Some(actor_id),
            Some(&actor_name),
        ));
    }
    Ok(logs)
}

fn build_runtime_action_log(
    round: i64,
    actor_id: &str,
    actor_name: &str,
    skill_id: &str,
    skill_name: &str,
    targets: &[RuntimeResolvedTargetLog],
) -> serde_json::Value {
    serde_json::json!({
        "type": "action",
        "round": round,
        "actorId": actor_id,
        "actorName": actor_name,
        "skillId": skill_id,
        "skillName": skill_name,
        "targets": targets.iter().map(|target| {
            let mut target_value = serde_json::json!({
                "targetId": target.target_id,
                "targetName": target.target_name,
                "hits": [{
                    "index": 1,
                    "damage": target.damage.max(0),
                    "isMiss": target.is_miss,
                    "isCrit": target.is_crit,
                    "isParry": target.is_parry,
                    "isElementBonus": target.is_element_bonus,
                    "shieldAbsorbed": target.shield_absorbed.max(0),
                }],
                "damage": target.damage.max(0),
                "shieldAbsorbed": target.shield_absorbed.max(0),
            });
            if let Some(object) = target_value.as_object_mut() {
                if target.heal > 0 {
                    object.insert("heal".to_string(), serde_json::json!(target.heal));
                }
                if target.shield > 0 {
                    object.insert("shield".to_string(), serde_json::json!(target.shield));
                }
                if !target.buffs_applied.is_empty() {
                    object.insert(
                        "buffsApplied".to_string(),
                        serde_json::json!(target.buffs_applied),
                    );
                }
                if !target.momentum_gained.is_empty() {
                    object.insert(
                        "momentumGained".to_string(),
                        serde_json::json!(target.momentum_gained),
                    );
                }
                if !target.momentum_consumed.is_empty() {
                    object.insert(
                        "momentumConsumed".to_string(),
                        serde_json::json!(target.momentum_consumed),
                    );
                }
            }
            target_value
        }).collect::<Vec<_>>()
    })
}

fn execute_runtime_skill_action(
    state: &mut BattleStateDto,
    actor_id: &str,
    skill_id: &str,
    selected_target_ids: &[String],
) -> Result<Vec<serde_json::Value>, String> {
    let actor = unit_by_id(state, actor_id)
        .cloned()
        .ok_or_else(|| "当前不可行动".to_string())?;
    let actor_name = actor.name.clone();
    let skill = runtime_skill_value(&actor, skill_id)
        .cloned()
        .ok_or_else(|| format!("战斗技能不存在: {}", skill_id.trim()))?;
    let skill_name = resolve_unit_skill_name(&actor, skill_id)?;
    let action_round = state.round_count.max(1);
    let target_ids = resolve_runtime_skill_targets(state, actor_id, skill_id, selected_target_ids)?;
    let skill_target_type = skill_target_type(&skill).to_string();
    let effects = skill
        .get("effects")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let damage_effects = effects
        .iter()
        .cloned()
        .filter(|effect| effect.get("type").and_then(serde_json::Value::as_str) == Some("damage"))
        .collect::<Vec<_>>();

    let mut target_logs = Vec::new();
    let mut logs = Vec::new();
    for target_id in target_ids {
        let target_snapshot = unit_by_id(state, target_id.as_str())
            .cloned()
            .ok_or_else(|| "目标不存在或已死亡".to_string())?;
        if !target_snapshot.is_alive {
            continue;
        }
        let mut total_damage = 0;
        if damage_effects.is_empty() {
            if matches!(skill_id.trim(), "skill-normal-attack" | "sk-heavy-slash" | "sk-bite") {
                total_damage = resolve_runtime_skill_damage(state, actor_id, skill_id).max(0);
            }
        } else {
            for effect in &damage_effects {
                let damage_type = effect
                    .get("damageType")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| skill.get("damageType").and_then(serde_json::Value::as_str))
                    .unwrap_or("physical");
                let fallback_scale_attr = if damage_type == "magic" { "fagong" } else { "wugong" };
                total_damage += resolve_effect_base_value(&actor, &target_snapshot, effect, fallback_scale_attr)
                    .max(0);
            }
        }

        let mut damage_outcome = calculate_runtime_damage(
            state,
            &actor,
            &target_snapshot,
            skill
                .get("damageType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("physical"),
            skill.get("element").and_then(serde_json::Value::as_str),
            total_damage,
        );

        let (actual_damage, target_dead, target_name, shield_absorbed) = {
            let target = unit_by_id_mut(state, target_id.as_str())
                .ok_or_else(|| "目标不存在或已死亡".to_string())?;
            let target_name = target.name.clone();
            if !damage_outcome.is_miss {
                let (actual_damage, shield_absorbed) = apply_runtime_damage_to_target(
                    target,
                    damage_outcome.damage,
                    skill
                        .get("damageType")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("physical"),
                );
                damage_outcome.actual_damage = actual_damage;
                damage_outcome.shield_absorbed = shield_absorbed;
                (actual_damage, !target.is_alive, target_name, shield_absorbed)
            } else {
                (0, false, target_name, 0)
            }
        };
        target_logs.push(RuntimeResolvedTargetLog {
            target_id: target_id.clone(),
            target_name: target_name.clone(),
            damage: actual_damage,
            heal: 0,
            shield: 0,
            buffs_applied: Vec::new(),
            is_miss: damage_outcome.is_miss,
            is_crit: damage_outcome.is_crit,
            is_parry: damage_outcome.is_parry,
            is_element_bonus: damage_outcome.is_element_bonus,
            shield_absorbed,
            momentum_gained: Vec::new(),
            momentum_consumed: Vec::new(),
        });
        if target_dead {
            logs.push(build_minimal_death_log(
                action_round,
                target_id.as_str(),
                target_name.as_str(),
                Some(actor_id),
                Some(actor_name.as_str()),
            ));
        }
    }
    for effect in effects.iter().filter(|effect| {
        matches!(
            effect.get("type").and_then(serde_json::Value::as_str),
            Some("heal" | "restore_lingqi" | "resource" | "buff" | "debuff" | "shield" | "control" | "cleanse" | "cleanse_control" | "dispel" | "mark")
        )
    }) {
        let effect_type = effect.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
        let effect_target_ids =
            resolve_effect_target_ids(state, actor_id, selected_target_ids, skill_target_type.as_str(), effect)?;
        for effect_target_id in effect_target_ids {
            let target_snapshot = unit_by_id(state, effect_target_id.as_str())
                .cloned()
                .ok_or_else(|| "没有有效目标".to_string())?;
            let log_entry = get_or_create_target_log(
                &mut target_logs,
                effect_target_id.as_str(),
                target_snapshot.name.as_str(),
            );
            match effect_type {
                "heal" => {
                    let heal_value = resolve_effect_base_value(&actor, &target_snapshot, effect, "fagong").max(0);
                    if heal_value > 0 {
                        let healed = {
                            let target = unit_by_id_mut(state, effect_target_id.as_str())
                                .ok_or_else(|| "没有有效目标".to_string())?;
                            let before = target.qixue;
                            target.qixue = (target.qixue + heal_value).min(target.current_attrs.max_qixue.max(1));
                            (target.qixue - before).max(0)
                        };
                        log_entry.heal += healed;
                    }
                }
                "restore_lingqi" => {
                    let restore_value = effect.get("value").and_then(serde_json::Value::as_i64).unwrap_or_default().max(0);
                    if restore_value > 0 {
                        let target = unit_by_id_mut(state, effect_target_id.as_str())
                            .ok_or_else(|| "没有有效目标".to_string())?;
                        target.lingqi = (target.lingqi + restore_value).min(target.current_attrs.max_lingqi.max(0));
                    }
                }
                "resource" => {
                    let resource_type = effect.get("resourceType").and_then(serde_json::Value::as_str).unwrap_or("lingqi");
                    let delta = effect.get("value").and_then(serde_json::Value::as_i64).unwrap_or_default();
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if resource_type == "qixue" {
                        target.qixue = (target.qixue + delta).clamp(0, target.current_attrs.max_qixue.max(1));
                    } else {
                        target.lingqi = (target.lingqi + delta).clamp(0, target.current_attrs.max_lingqi.max(0));
                    }
                }
                "shield" => {
                    let shield_value = resolve_effect_base_value(&actor, &target_snapshot, effect, "fagong").max(0);
                    if shield_value > 0 {
                        let target = unit_by_id_mut(state, effect_target_id.as_str())
                            .ok_or_else(|| "没有有效目标".to_string())?;
                        target.shields.push(serde_json::json!({
                            "id": format!("shield-{}-{}", effect_target_id, action_round),
                            "sourceSkillId": skill_id,
                            "value": shield_value,
                            "maxValue": shield_value,
                            "duration": effect.get("duration").and_then(serde_json::Value::as_i64).unwrap_or(1),
                            "absorbType": "all",
                            "priority": 0,
                        }));
                        log_entry.shield += shield_value;
                    }
                }
                "buff" | "debuff" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if let Some(buff_key) = apply_runtime_buff_effect(target, actor_id, effect_type, effect) {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &buff_key) {
                            log_entry.buffs_applied.push(buff_key);
                        }
                    }
                }
                "control" => {
                    let control_type = effect.get("controlType").and_then(serde_json::Value::as_str).unwrap_or("").trim();
                    if !control_type.is_empty() {
                        let target = unit_by_id_mut(state, effect_target_id.as_str())
                            .ok_or_else(|| "没有有效目标".to_string())?;
                        target.buffs.push(serde_json::json!({
                            "id": format!("control-{}-{}", control_type, action_round),
                            "buffDefId": format!("control-{}", control_type),
                            "name": control_type,
                            "type": "debuff",
                            "category": "control",
                            "sourceUnitId": actor_id,
                            "remainingDuration": effect.get("duration").and_then(serde_json::Value::as_i64).unwrap_or(1).max(1),
                            "stacks": 1,
                            "maxStacks": 1,
                            "control": control_type,
                            "tags": [control_type],
                            "dispellable": true,
                        }));
                        if !log_entry.buffs_applied.iter().any(|entry| entry == control_type) {
                            log_entry.buffs_applied.push(control_type.to_string());
                        }
                    }
                }
                "cleanse" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    let removed = remove_runtime_buffs_by_predicate(target, |buff| {
                        buff.get("type").and_then(serde_json::Value::as_str) == Some("debuff")
                    });
                    for buff_name in removed {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &buff_name) {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "cleanse_control" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    let removed = remove_runtime_buffs_by_predicate(target, |buff| {
                        buff.get("control").and_then(serde_json::Value::as_str).is_some()
                    });
                    for buff_name in removed {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &buff_name) {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "dispel" => {
                    let dispel_type = effect.get("dispelType").and_then(serde_json::Value::as_str).unwrap_or("all");
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    let removed = remove_runtime_buffs_by_predicate(target, |buff| match dispel_type {
                        "buff" => buff.get("type").and_then(serde_json::Value::as_str) == Some("buff"),
                        "debuff" => buff.get("type").and_then(serde_json::Value::as_str) == Some("debuff"),
                        _ => true,
                    });
                    for buff_name in removed {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &buff_name) {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "mark" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if let Some(mark_id) = apply_runtime_mark_effect(target, actor_id, effect) {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &mark_id) {
                            log_entry.buffs_applied.push(mark_id);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    if target_logs.is_empty() {
        return Err("没有可攻击目标".to_string());
    }
    logs.insert(
        0,
        build_runtime_action_log(
            action_round,
            actor_id,
            actor_name.as_str(),
            skill_id.trim(),
            skill_name.as_str(),
            &target_logs,
        ),
    );
    Ok(logs)
}

fn run_defender_turns_until_attacker_or_finish(
    state: &mut BattleStateDto,
    logs: &mut Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, String> {
    let mut defender_logs = Vec::new();
    while state.phase != "finished" && state.current_team != "attacker" {
        repair_action_cursor(state);
        if state.phase == "finished" || state.current_team == "attacker" {
            break;
        }
        let actor_id = state.current_unit_id.clone().ok_or_else(|| "当前不可行动".to_string())?;
        execute_runtime_auto_turn(state, actor_id.as_str(), &mut defender_logs)?;
    }
    logs.extend(defender_logs.iter().cloned());
    Ok(defender_logs)
}

pub fn apply_minimal_pve_action(
    state: &mut BattleStateDto,
    _actor_character_id: i64,
    skill_id: &str,
    target_ids: &[String],
) -> Result<MinimalBattleActionOutcome, String> {
    if state.battle_type != "pve" {
        return Err("当前战斗不支持该行动".to_string());
    }
    if state.phase == "finished" {
        return Err("战斗已结束".to_string());
    }
    repair_action_cursor(state);
    let mut logs = Vec::new();
    let placeholder_owner_actor_id = state.current_unit_id.clone().unwrap_or_default();
    run_attacker_auto_turns_until_owner_or_switch(state, placeholder_owner_actor_id.as_str(), &mut logs)?;
    if state.current_team != "attacker" {
        return Err("当前不是我方行动回合".to_string());
    }
    let current_actor_id = state
        .current_unit_id
        .clone()
        .ok_or_else(|| "当前不可行动".to_string())?;
    let current_actor = unit_by_id(state, current_actor_id.as_str())
        .ok_or_else(|| "当前不可行动".to_string())?;
    if current_actor.r#type != "player" {
        return Err("当前不可行动".to_string());
    }
    resolve_unit_skill_name(current_actor, skill_id)?;
    consume_runtime_skill_cost_and_validate_cooldown(state, current_actor_id.as_str(), skill_id)?;
    logs.extend(execute_runtime_skill_action(state, current_actor_id.as_str(), skill_id, target_ids)?);
    complete_unit_action_and_advance(state, current_actor_id.as_str(), Some(skill_id), &mut logs);
    run_attacker_auto_turns_until_owner_or_switch(state, current_actor_id.as_str(), &mut logs)?;
    run_defender_turns_until_attacker_or_finish(state, &mut logs)?;

    let (exp_gained, silver_gained) = if state.result.as_deref() == Some("attacker_win") {
        sum_monster_rewards(&state.teams.defender.units)
    } else {
        (0, 0)
    };
    Ok(MinimalBattleActionOutcome {
        finished: state.phase == "finished",
        result: state.result.clone(),
        exp_gained,
        silver_gained,
        logs,
    })
}

pub fn apply_minimal_pvp_action(
    state: &mut BattleStateDto,
    actor_character_id: i64,
    skill_id: &str,
    target_ids: &[String],
) -> Result<MinimalBattleActionOutcome, String> {
    if state.battle_type != "pvp" {
        return Err("当前战斗不支持该行动".to_string());
    }
    if state.phase == "finished" {
        return Err("战斗已结束".to_string());
    }
    repair_action_cursor(state);
    if state.current_team != "attacker" {
        return Err("当前不是我方行动回合".to_string());
    }
    let expected_actor_id = format!("player-{}", actor_character_id);
    if state.current_unit_id.as_deref() != Some(expected_actor_id.as_str()) {
        return Err("当前不可行动".to_string());
    }
    let current_actor = unit_by_id(state, expected_actor_id.as_str())
        .ok_or_else(|| "当前不可行动".to_string())?;
    resolve_unit_skill_name(current_actor, skill_id)?;
    consume_runtime_skill_cost_and_validate_cooldown(state, &expected_actor_id, skill_id)?;
    let mut logs = execute_runtime_skill_action(state, expected_actor_id.as_str(), skill_id, target_ids)?;
    complete_unit_action_and_advance(state, expected_actor_id.as_str(), Some(skill_id), &mut logs);
    run_defender_turns_until_attacker_or_finish(state, &mut logs)?;
    Ok(MinimalBattleActionOutcome {
        finished: state.phase == "finished",
        result: state.result.clone(),
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
    unit.skills
        .iter()
        .find(|skill| {
            skill.get("id").and_then(serde_json::Value::as_str) == Some(normalized_skill_id)
        })
        .and_then(|skill| skill.get("name").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .ok_or_else(|| format!("战斗技能不存在: {normalized_skill_id}"))
}

fn reduce_runtime_skill_cooldowns_for_unit(
    state: &mut BattleStateDto,
    actor_id: &str,
    used_skill_id: Option<&str>,
) {
    let actor_prefix = format!("{actor_id}:");
    let skip_key = used_skill_id.map(|skill_id| format!("{actor_id}:{skill_id}"));
    let keys_to_update = state
        .runtime_skill_cooldowns
        .keys()
        .filter(|key| key.starts_with(actor_prefix.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    for key in keys_to_update {
        if skip_key.as_deref() == Some(key.as_str()) {
            continue;
        }
        let remaining = state
            .runtime_skill_cooldowns
            .get(key.as_str())
            .copied()
            .unwrap_or_default();
        if remaining <= 1 {
            state.runtime_skill_cooldowns.remove(key.as_str());
            continue;
        }
        state
            .runtime_skill_cooldowns
            .insert(key, remaining.saturating_sub(1));
    }
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
    let Some(config) = resolve_runtime_skill_config(state, actor_id, skill_id) else {
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
        let remaining = state
            .runtime_skill_cooldowns
            .get(cooldown_key.as_str())
            .copied()
            .unwrap_or_default();
        return Err(format!("技能冷却中: {}回合", remaining));
    }
    let Some(actor) = unit_by_id_mut(state, actor_id) else {
        return Err("当前不可行动".to_string());
    };
    if !actor.is_alive {
        return Err("当前不可行动".to_string());
    }
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
            .insert(cooldown_key, config.cooldown_turns);
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

fn resolve_runtime_skill_damage(state: &BattleStateDto, actor_id: &str, skill_id: &str) -> i64 {
    match skill_id.trim() {
        "sk-heavy-slash" => 220,
        "skill-normal-attack" => unit_by_id(state, actor_id)
            .map(|unit| unit.current_attrs.wugong.max(32))
            .unwrap_or(32),
        "sk-bite" => unit_by_id(state, actor_id)
            .map(resolve_monster_counter_damage)
            .map(|damage| damage.max(24))
            .unwrap_or(24),
        _ => unit_by_id(state, actor_id)
            .map(|unit| unit.current_attrs.wugong.max(28))
            .unwrap_or(28),
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
        DEFENSE_DAMAGE_K, MAX_ROUNDS_PVE, MinimalPveItemRewardResolveOptions,
        apply_character_profile_to_battle_state, apply_minimal_pve_action,
        apply_minimal_pvp_action, build_minimal_pve_battle_state,
        build_minimal_pvp_battle_state, build_skill_value, determine_first_mover,
        process_round_start, refresh_battle_team_total_speed, resolve_minimal_pve_item_rewards,
        restart_battle_runtime, start_battle_runtime,
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
    fn minimal_pve_action_rejects_stale_selected_target() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-white-wolf".to_string(),
            ],
        );

        let error = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-does-not-exist".to_string()],
        )
        .expect_err("stale target should be rejected");

        assert_eq!(error, "目标不存在或已死亡");
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
    fn minimal_pve_action_emits_round_end_and_next_round_start_logs() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].current_attrs.sudu = 0;
        refresh_battle_team_total_speed(&mut state);
        state.first_mover = determine_first_mover(&state).to_string();

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        assert!(outcome.logs.iter().any(|log| log["type"] == "round_end" && log["round"] == 1));
        assert!(outcome.logs.iter().any(|log| log["type"] == "round_start" && log["round"] == 2));
        assert_eq!(state.round_count, 2);
    }

    #[test]
    fn minimal_pve_action_draws_when_max_rounds_are_exhausted() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.round_count = MAX_ROUNDS_PVE;
        state.teams.attacker.units[0].current_attrs.sudu = 0;
        refresh_battle_team_total_speed(&mut state);
        state.first_mover = determine_first_mover(&state).to_string();

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should finish as draw");

        assert!(outcome.finished);
        assert_eq!(outcome.result.as_deref(), Some("draw"));
        assert_eq!(state.phase, "finished");
        assert_eq!(state.result.as_deref(), Some("draw"));
        assert!(outcome.logs.iter().any(|log| log["type"] == "round_end"));
    }

    #[test]
    fn minimal_pve_action_supports_self_lingqi_restore_skill_effect() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].lingqi = 20;
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-restore-self",
            "name": "养气回灵",
            "description": "恢复灵气",
            "type": "active",
            "targetType": "self",
            "damageType": "magic",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "restore_lingqi", "value": 15, "valueType": "flat"}
            ]
        }));

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-restore-self", &[])
            .expect("self restore skill should succeed");

        assert_eq!(outcome.logs[0]["actorId"], "player-1");
        assert_eq!(outcome.logs[0]["targets"][0]["targetId"], "player-1");
        assert_eq!(state.teams.attacker.units[0].lingqi, 35);
    }

    #[test]
    fn minimal_pve_action_supports_single_ally_heal_and_buff_targeting() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let ally_attrs = BattleUnitCurrentAttrsDto {
            max_qixue: 300,
            max_lingqi: 120,
            wugong: 80,
            fagong: 60,
            wufang: 30,
            fafang: 30,
            sudu: 10,
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
            realm: Some("凡人".to_string()),
            element: Some("none".to_string()),
        };
        state.teams.attacker.units.push(super::BattleUnitDto {
            id: "player-2".to_string(),
            name: "队友".to_string(),
            r#type: "player".to_string(),
            source_id: serde_json::json!(2),
            base_attrs: ally_attrs.clone(),
            formation_order: Some(2),
            owner_unit_id: None,
            month_card_active: Some(false),
            avatar: None,
            qixue: 120,
            lingqi: 60,
            current_attrs: ally_attrs,
            shields: Vec::new(),
            is_alive: true,
            can_act: true,
            buffs: Vec::new(),
            marks: Vec::new(),
            momentum: None,
            set_bonus_effects: Vec::new(),
            skills: vec![build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0)],
            skill_cooldowns: std::collections::BTreeMap::new(),
            skill_cooldown_discount_bank: std::collections::BTreeMap::new(),
            partner_skill_policy: None,
            control_diminishing: std::collections::BTreeMap::new(),
            stats: super::BattleUnitStatsDto {
                damage_dealt: 0,
                damage_taken: 0,
                healing_done: 0,
                healing_received: 0,
                kill_count: 0,
            },
            reward_exp: None,
            reward_silver: None,
        });
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-support-ally",
            "name": "回春护体诀",
            "description": "治疗并增益队友",
            "type": "active",
            "targetType": "single_ally",
            "damageType": "magic",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "heal", "value": 180, "valueType": "flat"},
                {"type": "buff", "buffKind": "attr", "attrKey": "wugong", "applyType": "percent", "value": 0.25, "duration": 2}
            ]
        }));
        refresh_battle_team_total_speed(&mut state);

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-support-ally", &["player-2".to_string()])
            .expect("single ally support skill should succeed");

        let ally = state
            .teams
            .attacker
            .units
            .iter()
            .find(|unit| unit.id == "player-2")
            .expect("ally should exist");
        println!(
            "BATTLE_RUNTIME_SUPPORT_SKILL_OUTCOME={{\"allyQixue\":{},\"allyWugong\":{},\"baseWugong\":{},\"log\":{}}}",
            ally.qixue,
            ally.current_attrs.wugong,
            ally.base_attrs.wugong,
            outcome.logs[0]
        );
        assert_eq!(outcome.logs[0]["targets"][0]["targetId"], "player-2");
        assert_eq!(outcome.logs[0]["targets"][0]["heal"], 180);
        assert_eq!(outcome.logs[0]["targets"][0]["buffsApplied"][0], "buff-wugong");
        assert_eq!(ally.qixue, 300);
        assert!(ally.current_attrs.wugong > ally.base_attrs.wugong);
    }

    #[test]
    fn minimal_pve_battle_state_applies_passive_entry_effects_on_start() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-passive-zengshang",
            "name": "先天战意",
            "description": "进场提高增伤",
            "type": "active",
            "targetType": "self",
            "damageType": "physical",
            "cooldown": 0,
            "triggerType": "passive",
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "buff", "buffKind": "attr", "attrKey": "wugong", "applyType": "percent", "value": 0.2, "duration": 2}
            ]
        }));

        let mut logs = Vec::new();
        start_battle_runtime(&mut state, &mut logs);

        assert!(logs.iter().any(|log| log["skillId"] == "skill-passive-zengshang"));
        assert!(state.teams.attacker.units[0].current_attrs.wugong > state.teams.attacker.units[0].base_attrs.wugong);
    }

    #[test]
    fn minimal_pve_action_expires_attr_buff_at_round_end() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-self-buff",
            "name": "战意昂扬",
            "description": "提高攻击",
            "type": "active",
            "targetType": "self",
            "damageType": "physical",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "buff", "buffKind": "attr", "attrKey": "wugong", "applyType": "percent", "value": 0.25, "duration": 1}
            ]
        }));
        state.teams.attacker.units[0].current_attrs.sudu = 0;
        refresh_battle_team_total_speed(&mut state);
        state.first_mover = determine_first_mover(&state).to_string();

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-self-buff", &[])
            .expect("self buff should succeed");

        assert!(outcome.logs.iter().any(|log| log["type"] == "buff_expire"));
        assert!(state.teams.attacker.units[0].buffs.is_empty());
        assert_eq!(
            state.teams.attacker.units[0].current_attrs.wugong,
            state.teams.attacker.units[0].base_attrs.wugong
        );
    }

    #[test]
    fn round_end_buff_expire_logs_before_round_end() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "buff-expire",
            "buffDefId": "buff-expire",
            "name": "短效增益",
            "type": "buff",
            "category": "runtime",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "attrModifiers": [],
            "tags": [],
            "dispellable": true
        }));
        state.teams.attacker.units[0].current_attrs.sudu = 0;
        refresh_battle_team_total_speed(&mut state);
        state.first_mover = determine_first_mover(&state).to_string();

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should advance round");

        let expire_index = outcome
            .logs
            .iter()
            .position(|log| log["type"] == "buff_expire")
            .expect("buff expire log should exist");
        let round_end_index = outcome
            .logs
            .iter()
            .position(|log| log["type"] == "round_end")
            .expect("round_end log should exist");

        assert!(expire_index < round_end_index);
    }

    #[test]
    fn runtime_damage_respects_defense_reduction_formula() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        let attacker = super::BattleUnitDto {
            current_attrs: BattleUnitCurrentAttrsDto {
                max_qixue: 1000,
                max_lingqi: 100,
                wugong: 200,
                fagong: 200,
                wufang: 0,
                fafang: 0,
                sudu: 10,
                mingzhong: 100,
                shanbi: 0,
                zhaojia: 0,
                baoji: 0,
                baoshang: 2,
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
                element: Some("none".to_string()),
            },
            ..state.teams.attacker.units[0].clone()
        };
        let defender = super::BattleUnitDto {
            current_attrs: BattleUnitCurrentAttrsDto {
                wufang: 180,
                fafang: 100,
                shanbi: 0,
                zhaojia: 0,
                kangbao: 0,
                ..state.teams.defender.units[0].current_attrs.clone()
            },
            ..state.teams.defender.units[0].clone()
        };

        let outcome = super::calculate_runtime_damage(
            &mut state,
            &attacker,
            &defender,
            "physical",
            Some("none"),
            200,
        );
        let expected = ((200.0_f64) * (DEFENSE_DAMAGE_K / (180.0 + DEFENSE_DAMAGE_K))).floor() as i64;
        assert_eq!(outcome.damage, expected);
        assert_eq!(outcome.is_miss, false);
        assert_eq!(outcome.is_crit, false);
    }

    #[test]
    fn runtime_damage_applies_shield_absorption_before_qixue_loss() {
        let mut target = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        )
        .teams
        .defender
        .units[0]
        .clone();
        target.qixue = 100;
        target.shields.push(serde_json::json!({
            "id": "shield-1",
            "sourceSkillId": "skill-shield",
            "value": 30,
            "maxValue": 30,
            "duration": 2,
            "absorbType": "all",
            "priority": 10,
        }));

        let (actual_damage, shield_absorbed) = super::apply_runtime_damage_to_target(&mut target, 50, "physical");
        assert_eq!(shield_absorbed, 30);
        assert_eq!(actual_damage, 20);
        assert_eq!(target.qixue, 80);
        assert!(target.shields.is_empty());
    }

    #[test]
    fn battle_start_applies_equip_trigger_set_bonus_buff() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].set_bonus_effects = vec![serde_json::json!({
            "setId": "set-fanren",
            "setName": "凡尘套装",
            "pieceCount": 2,
            "trigger": "equip",
            "target": "self",
            "effectType": "buff",
            "params": {
                "attr_key": "wugong",
                "value": 6,
                "apply_type": "flat"
            }
        })];

        let mut logs = Vec::new();
        restart_battle_runtime(&mut state);
        process_round_start(&mut state, &mut logs);

        assert!(state.teams.attacker.units[0].current_attrs.wugong > state.teams.attacker.units[0].base_attrs.wugong);
    }

    #[test]
    fn round_start_applies_on_turn_start_set_bonus_heal() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].qixue = 60;
        state.teams.attacker.units[0].set_bonus_effects = vec![serde_json::json!({
            "setId": "set-test",
            "setName": "测试套装",
            "pieceCount": 2,
            "trigger": "on_turn_start",
            "target": "self",
            "effectType": "heal",
            "params": {
                "value": 20
            }
        })];

        let mut logs = Vec::new();
        process_round_start(&mut state, &mut logs);

        assert_eq!(state.teams.attacker.units[0].qixue, 80);
        assert!(logs.iter().any(|log| log["type"] == "hot"));
    }

    #[test]
    fn minimal_pve_battle_state_uses_seed_monster_attrs_and_skills() {
        let state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-mountain-wolf".to_string()],
        );
        let monster = &state.teams.defender.units[0];
        assert_eq!(monster.current_attrs.wugong, 22);
        assert_eq!(monster.current_attrs.wufang, 10);
        assert_eq!(monster.current_attrs.sudu, 6);
        assert!(monster.skills.iter().any(|skill| skill["id"] == "sk-bite"));
        assert!(monster.skills.iter().any(|skill| skill["id"] == "sk-howl"));
    }

    #[test]
    fn minimal_pve_action_control_effect_causes_enemy_turn_skip() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-stun-enemy",
            "name": "定魂击",
            "description": "使敌人眩晕",
            "type": "active",
            "targetType": "single_enemy",
            "damageType": "physical",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "control", "controlType": "stun", "duration": 1}
            ]
        }));

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-stun-enemy", &["monster-1-monster-gray-wolf".to_string()])
            .expect("stun skill should succeed");

        assert!(outcome.logs.iter().any(|log| log["skillId"] == "skip"));
        assert!(state.round_count >= 2);
    }

    #[test]
    fn controlled_unit_skip_log_has_empty_targets() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "control-stun",
            "buffDefId": "control-stun",
            "name": "眩晕",
            "type": "debuff",
            "category": "control",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "control": "stun",
            "tags": ["stun"],
            "dispellable": true
        }));

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        let skip_log = outcome
            .logs
            .iter()
            .find(|log| log["skillId"] == "skip")
            .expect("skip log should exist");
        assert_eq!(skip_log["targets"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn minimal_pve_action_cleanse_control_removes_stun_from_ally() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units.push(super::BattleUnitDto {
            id: "player-2".to_string(),
            name: "队友".to_string(),
            r#type: "player".to_string(),
            source_id: serde_json::json!(2),
            base_attrs: state.teams.attacker.units[0].base_attrs.clone(),
            formation_order: Some(2),
            owner_unit_id: None,
            month_card_active: Some(false),
            avatar: None,
            qixue: 100,
            lingqi: 100,
            current_attrs: state.teams.attacker.units[0].current_attrs.clone(),
            shields: Vec::new(),
            is_alive: true,
            can_act: true,
            buffs: vec![serde_json::json!({
                "id": "control-stun-1",
                "buffDefId": "control-stun",
                "name": "stun",
                "type": "debuff",
                "category": "control",
                "sourceUnitId": "monster-1",
                "remainingDuration": 1,
                "stacks": 1,
                "maxStacks": 1,
                "control": "stun",
                "tags": ["stun"],
                "dispellable": true
            })],
            marks: Vec::new(),
            momentum: None,
            set_bonus_effects: Vec::new(),
            skills: vec![build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0)],
            skill_cooldowns: std::collections::BTreeMap::new(),
            skill_cooldown_discount_bank: std::collections::BTreeMap::new(),
            partner_skill_policy: None,
            control_diminishing: std::collections::BTreeMap::new(),
            stats: super::BattleUnitStatsDto {
                damage_dealt: 0,
                damage_taken: 0,
                healing_done: 0,
                healing_received: 0,
                kill_count: 0,
            },
            reward_exp: None,
            reward_silver: None,
        });
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-cleanse-ally",
            "name": "清心诀",
            "description": "解除控制",
            "type": "active",
            "targetType": "single_ally",
            "damageType": "magic",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "cleanse_control"}
            ]
        }));

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-cleanse-ally", &["player-2".to_string()])
            .expect("cleanse control should succeed");
        let ally = state.teams.attacker.units.iter().find(|unit| unit.id == "player-2").expect("ally exists");
        assert!(ally.buffs.iter().all(|buff| buff.get("control").is_none()));
        assert_eq!(outcome.logs[0]["targets"][0]["targetId"], "player-2");
    }

    #[test]
    fn runtime_buff_effect_records_source_unit_id() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-self-buff-source",
            "name": "凝神",
            "description": "提升武攻",
            "type": "active",
            "targetType": "self",
            "damageType": "magic",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {
                    "type": "buff",
                    "buffKind": "attr",
                    "attrKey": "wugong",
                    "value": 5,
                    "applyType": "flat",
                    "duration": 2
                }
            ]
        }));

        apply_minimal_pve_action(&mut state, 1, "skill-self-buff-source", &[])
            .expect("buff skill should succeed");

        let buff = state.teams.attacker.units[0]
            .buffs
            .iter()
            .find(|buff| buff["buffDefId"] == "buff-wugong")
            .expect("buff should exist");
        assert_eq!(buff["sourceUnitId"], "player-1");
    }

    #[test]
    fn minimal_pve_action_applies_mark_and_bonus_damage_uses_same_source_only() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills.push(serde_json::json!({
            "id": "skill-mark-enemy",
            "name": "虚蚀印诀",
            "description": "施加虚蚀印记",
            "type": "active",
            "targetType": "single_enemy",
            "damageType": "magic",
            "cooldown": 0,
            "cost": {"lingqi": 0, "qixue": 0},
            "effects": [
                {"type": "mark", "markId": "void_erosion", "applyStacks": 2, "maxStacks": 5, "duration": 2}
            ]
        }));

        let mark_outcome = apply_minimal_pve_action(&mut state, 1, "skill-mark-enemy", &["monster-1-monster-gray-wolf".to_string()])
            .expect("mark skill should succeed");
        assert_eq!(mark_outcome.logs[0]["targets"][0]["buffsApplied"][0], "void_erosion");

        let defender = state.teams.defender.units[0].clone();
        let attacker = state.teams.attacker.units[0].clone();
        let no_mark_damage = super::calculate_runtime_damage(
            &mut state,
            &attacker,
            &super::BattleUnitDto { marks: Vec::new(), ..defender.clone() },
            "physical",
            Some("none"),
            100,
        )
        .damage;
        let marked_damage = super::calculate_runtime_damage(
            &mut state,
            &attacker,
            &defender,
            "physical",
            Some("none"),
            100,
        )
        .damage;
        assert!(marked_damage > no_mark_damage);
    }

    #[test]
    fn minimal_pve_round_start_decays_marks() {
        let mut unit = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string()],
        )
        .teams
        .defender
        .units[0]
        .clone();
        unit.marks = vec![
            serde_json::json!({"id": "void_erosion", "sourceUnitId": "player-1", "stacks": 2, "maxStacks": 5, "remainingDuration": 2}),
            serde_json::json!({"id": "void_erosion", "sourceUnitId": "player-2", "stacks": 1, "maxStacks": 5, "remainingDuration": 1}),
        ];

        super::decay_runtime_marks_at_round_start(&mut unit);
        assert_eq!(unit.marks.len(), 1);
        assert_eq!(unit.marks[0]["sourceUnitId"], "player-1");
        assert_eq!(unit.marks[0]["remainingDuration"], 1);
    }

    #[test]
    fn minimal_pve_action_rejects_unknown_snapshot_skill_even_for_normal_attack() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0].skills = vec![build_skill_value(
            "sk-stale-snapshot-normal",
            "旧快照普攻",
            0,
            0,
            0,
        )];

        let error = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect_err("unknown snapshot skill should be rejected");

        assert_eq!(error, "战斗技能不存在: skill-normal-attack");
    }

    #[test]
    fn runtime_action_log_omits_empty_optional_fields_and_keeps_node_shape() {
        let log = super::build_runtime_action_log(
            3,
            "player-1",
            "修士1",
            "skill-normal-attack",
            "普通攻击",
            &[super::RuntimeResolvedTargetLog {
                target_id: "monster-1".to_string(),
                target_name: "灰狼".to_string(),
                damage: 12,
                heal: 0,
                shield: 0,
                buffs_applied: Vec::new(),
                is_miss: false,
                is_crit: true,
                is_parry: false,
                is_element_bonus: true,
                shield_absorbed: 4,
                momentum_gained: vec!["moon_trace".to_string()],
                momentum_consumed: Vec::new(),
            }],
        );

        let target = &log["targets"][0];
        assert_eq!(log["type"], "action");
        assert_eq!(log["round"], 3);
        assert_eq!(target["targetId"], "monster-1");
        assert_eq!(target["damage"], 12);
        assert_eq!(target["shieldAbsorbed"], 4);
        assert_eq!(target["hits"][0]["damage"], 12);
        assert_eq!(target["hits"][0]["isCrit"], true);
        assert_eq!(target["hits"][0]["isElementBonus"], true);
        assert_eq!(target["momentumGained"][0], "moon_trace");
        assert!(target.get("heal").is_none());
        assert!(target.get("shield").is_none());
        assert!(target.get("buffsApplied").is_none());
        assert!(target.get("momentumConsumed").is_none());
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
            1
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

        assert_eq!(error, "技能冷却中: 2回合");
    }

    #[test]
    fn minimal_pve_action_runs_all_defender_turns_before_returning_to_attacker() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-white-wolf".to_string(),
            ],
        );

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        assert!(!outcome.finished);
        assert_eq!(state.phase, "action");
        assert_eq!(state.current_team, "attacker");
        assert_eq!(state.current_unit_id.as_deref(), Some("player-1"));
        assert_eq!(state.round_count, 2);
        assert_eq!(outcome.logs.len(), 5);
        assert_eq!(outcome.logs[0]["actorId"], "player-1");
        assert_eq!(outcome.logs[1]["actorId"], "monster-1-monster-gray-wolf");
        assert_eq!(outcome.logs[2]["actorId"], "monster-2-monster-white-wolf");
        assert_eq!(outcome.logs[3]["type"], "round_end");
        assert_eq!(outcome.logs[4]["type"], "round_start");
    }

    #[test]
    fn minimal_pve_action_cooldown_blocks_next_own_turn_then_unlocks_after_other_skill() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-white-wolf".to_string(),
            ],
        );

        apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("heavy slash should succeed on first own turn");

        assert_eq!(state.current_team, "attacker");
        assert_eq!(state.round_count, 2);
        assert_eq!(
            state.teams.attacker.units[0]
                .skill_cooldowns
                .get("sk-heavy-slash")
                .copied(),
            Some(1)
        );

        let blocked = apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-2-monster-white-wolf".to_string()],
        )
        .expect_err("second own turn should still be blocked");
        assert_eq!(blocked, "技能冷却中: 1回合");

        apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-2-monster-white-wolf".to_string()],
        )
        .expect("normal attack should advance own-turn cooldowns");

        assert!(
            state.teams.attacker.units[0]
                .skill_cooldowns
                .get("sk-heavy-slash")
                .is_none()
        );

        apply_minimal_pve_action(
            &mut state,
            1,
            "sk-heavy-slash",
            &["monster-2-monster-white-wolf".to_string()],
        )
        .expect("third own turn should unlock heavy slash again");
    }

    #[test]
    fn minimal_pve_action_repairs_missing_action_cursor_before_validation() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-gray-wolf".to_string(), "monster-white-wolf".to_string()],
        );
        state.current_unit_id = None;

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action cursor should self-heal");

        assert_eq!(outcome.logs[0]["actorId"], "player-1");
        assert_eq!(state.current_team, "attacker");
        assert_eq!(state.current_unit_id.as_deref(), Some("player-1"));
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

        let outcome = apply_minimal_pvp_action(&mut state, 1, "sk-heavy-slash", &["opponent-2".to_string()])
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
