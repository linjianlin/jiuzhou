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
const SOUL_SHACKLE_MARK_ID: &str = "soul_shackle";
const SOUL_SHACKLE_RECOVERY_BLOCK_PER_STACK: f64 = 0.08;
const SOUL_SHACKLE_RECOVERY_BLOCK_CAP: f64 = 0.4;

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggered_phase_ids: Vec<String>,
    pub skill_cooldowns: BTreeMap<String, i64>,
    pub skill_cooldown_discount_bank: BTreeMap<String, i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partner_skill_policy: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_profile: Option<serde_json::Value>,
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
    pub mingzhong: f64,
    pub shanbi: f64,
    pub zhaojia: f64,
    pub baoji: f64,
    pub baoshang: f64,
    pub jianbaoshang: f64,
    pub jianfantan: f64,
    pub kangbao: f64,
    pub zengshang: f64,
    pub zhiliao: f64,
    pub jianliao: f64,
    pub xixue: f64,
    pub lengque: f64,
    pub kongzhi_kangxing: f64,
    pub jin_kangxing: f64,
    pub mu_kangxing: f64,
    pub shui_kangxing: f64,
    pub huo_kangxing: f64,
    pub tu_kangxing: f64,
    pub qixue_huifu: f64,
    pub lingqi_huifu: f64,
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
    resources: Vec<serde_json::Value>,
    buffs_applied: Vec<String>,
    is_miss: bool,
    is_crit: bool,
    is_parry: bool,
    is_element_bonus: bool,
    shield_absorbed: i64,
    momentum_gained: Vec<String>,
    momentum_consumed: Vec<String>,
}

const RUNTIME_DAMAGE_EFFECT_TYPE: &str = "damage";
const RUNTIME_MAIN_LOOP_NON_DAMAGE_EFFECT_TYPES: [&str; 15] = [
    "heal",
    "restore_lingqi",
    "resource",
    "buff",
    "debuff",
    "shield",
    "control",
    "cleanse",
    "cleanse_control",
    "dispel",
    "mark",
    "lifesteal",
    "momentum",
    "delayed_burst",
    "fate_swap",
];
#[cfg(test)]
const RUNTIME_SUPPORTED_SKILL_EFFECT_TYPES: [&str; 16] = [
    RUNTIME_DAMAGE_EFFECT_TYPE,
    "heal",
    "shield",
    "buff",
    "debuff",
    "dispel",
    "resource",
    "restore_lingqi",
    "cleanse",
    "cleanse_control",
    "lifesteal",
    "control",
    "mark",
    "momentum",
    "delayed_burst",
    "fate_swap",
];

fn is_runtime_main_loop_non_damage_effect_type(effect_type: &str) -> bool {
    RUNTIME_MAIN_LOOP_NON_DAMAGE_EFFECT_TYPES.contains(&effect_type)
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

#[derive(Debug, Clone, Default)]
struct RuntimeSkillEffectContext {
    damage_bonus_rate: f64,
    heal_bonus_rate: f64,
    shield_bonus_rate: f64,
    resource_bonus_rate: f64,
    momentum_gained: Vec<String>,
    momentum_consumed: Vec<String>,
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

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MonsterAiProfileSeed {
    skills: Option<Vec<String>>,
    phase_triggers: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone)]
struct RuntimeSummonTemplate {
    id: String,
    name: String,
    attrs: BattleUnitCurrentAttrsDto,
    skills: Vec<serde_json::Value>,
    ai_profile: Option<serde_json::Value>,
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
        mingzhong: 1.0,
        shanbi: 0.0,
        zhaojia: 0.0,
        baoji: 0.0,
        baoshang: 0.0,
        jianbaoshang: 0.0,
        jianfantan: 0.0,
        kangbao: 0.0,
        zengshang: 0.0,
        zhiliao: 0.0,
        jianliao: 0.0,
        xixue: 0.0,
        lengque: 0.0,
        kongzhi_kangxing: 0.0,
        jin_kangxing: 0.0,
        mu_kangxing: 0.0,
        shui_kangxing: 0.0,
        huo_kangxing: 0.0,
        tu_kangxing: 0.0,
        qixue_huifu: 0.0,
        lingqi_huifu: 0.0,
        realm,
        element: Some("none".to_string()),
    }
}

fn json_number_to_i64_round(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|raw| match raw {
        serde_json::Value::Number(number) => number.as_f64().map(|v| v.round() as i64),
        _ => None,
    })
}

fn json_number_to_i64_floor(value: Option<&serde_json::Value>) -> Option<i64> {
    value.and_then(|raw| match raw {
        serde_json::Value::Number(number) => number.as_f64().map(|v| v.floor() as i64),
        _ => None,
    })
}

fn json_number_to_f64(value: Option<&serde_json::Value>) -> Option<f64> {
    value.and_then(|raw| match raw {
        serde_json::Value::Number(number) => number.as_f64(),
        _ => None,
    })
}

fn json_number_to_f64_or_zero(value: Option<&serde_json::Value>) -> f64 {
    json_number_to_f64(value).unwrap_or_default().max(0.0)
}

fn apply_runtime_rate_bonus(base_value: i64, bonus_rate: f64) -> i64 {
    if base_value <= 0 {
        return base_value.max(0);
    }
    ((base_value as f64) * (1.0 + bonus_rate)).floor().max(0.0) as i64
}

fn is_runtime_heal_forbidden(unit: &BattleUnitDto) -> bool {
    unit.buffs.iter().any(|buff| {
        buff.get("healForbidden")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    })
}

fn runtime_soul_shackle_recovery_block_rate(unit: &BattleUnitDto) -> f64 {
    let stacks = unit
        .marks
        .iter()
        .filter(|mark| {
            mark.get("id").and_then(serde_json::Value::as_str) == Some(SOUL_SHACKLE_MARK_ID)
                && json_number_to_i64_floor(mark.get("remainingDuration")).unwrap_or(1) > 0
        })
        .map(|mark| {
            json_number_to_f64(mark.get("stacks"))
                .unwrap_or_default()
                .max(0.0)
        })
        .sum::<f64>();
    if stacks <= 0.0 {
        return 0.0;
    }
    (stacks * SOUL_SHACKLE_RECOVERY_BLOCK_PER_STACK).min(SOUL_SHACKLE_RECOVERY_BLOCK_CAP)
}

fn apply_runtime_recovery_reduction(value: i64, target: &BattleUnitDto) -> i64 {
    if value <= 0 {
        return value;
    }
    let block_rate = runtime_soul_shackle_recovery_block_rate(target);
    if block_rate <= 0.0 {
        return value;
    }
    ((value as f64) * (1.0 - block_rate)).floor().max(0.0) as i64
}

fn apply_runtime_healing(target: &mut BattleUnitDto, heal_amount: i64) -> i64 {
    if heal_amount <= 0 {
        return 0;
    }
    if is_runtime_heal_forbidden(target) {
        return 0;
    }
    let effective_heal = apply_runtime_recovery_reduction(heal_amount, target);
    if effective_heal <= 0 {
        return 0;
    }
    let missing_qixue = (target.current_attrs.max_qixue.max(1) - target.qixue).max(0);
    let actual_heal = effective_heal.min(missing_qixue);
    if actual_heal <= 0 {
        return 0;
    }
    target.qixue += actual_heal;
    target.stats.healing_received += actual_heal;
    actual_heal
}

fn has_runtime_dodge_next(unit: &BattleUnitDto) -> bool {
    unit.buffs
        .iter()
        .any(|buff| buff.get("dodgeNext").is_some())
}

fn consume_runtime_dodge_next_buff(unit: &mut BattleUnitDto) {
    let Some(index) = unit
        .buffs
        .iter()
        .position(|buff| buff.get("dodgeNext").is_some())
    else {
        return;
    };
    let stacks = unit.buffs[index]
        .get("stacks")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1);
    if stacks > 1 {
        if let Some(object) = unit.buffs[index].as_object_mut() {
            object.insert("stacks".to_string(), serde_json::json!(stacks - 1));
        }
    } else {
        unit.buffs.remove(index);
    }
    apply_runtime_attr_buffs(unit);
}

fn battle_attrs_from_json(base_attrs: &serde_json::Value) -> Option<BattleUnitCurrentAttrsDto> {
    let object = base_attrs.as_object()?;
    let max_qixue = json_number_to_i64_round(object.get("max_qixue"))?;
    let max_lingqi = json_number_to_i64_round(object.get("max_lingqi"))?;
    let wugong = json_number_to_i64_round(object.get("wugong"))?;
    let fagong = json_number_to_i64_round(object.get("fagong"))?;
    let wufang = json_number_to_i64_round(object.get("wufang"))?;
    let fafang = json_number_to_i64_round(object.get("fafang"))?;
    let sudu = json_number_to_i64_round(object.get("sudu"))?;

    Some(BattleUnitCurrentAttrsDto {
        max_qixue: max_qixue.max(1),
        max_lingqi: max_lingqi.max(0),
        wugong: wugong.max(0),
        fagong: fagong.max(0),
        wufang: wufang.max(0),
        fafang: fafang.max(0),
        sudu: sudu.max(1),
        mingzhong: json_number_to_f64(object.get("mingzhong"))
            .unwrap_or(1.0)
            .max(0.0),
        shanbi: json_number_to_f64_or_zero(object.get("shanbi")),
        zhaojia: json_number_to_f64_or_zero(object.get("zhaojia")),
        baoji: json_number_to_f64_or_zero(object.get("baoji")),
        baoshang: json_number_to_f64_or_zero(object.get("baoshang")),
        jianbaoshang: json_number_to_f64_or_zero(object.get("jianbaoshang")),
        jianfantan: json_number_to_f64_or_zero(object.get("jianfantan")),
        kangbao: json_number_to_f64_or_zero(object.get("kangbao")),
        zengshang: json_number_to_f64_or_zero(object.get("zengshang")),
        zhiliao: json_number_to_f64_or_zero(object.get("zhiliao")),
        jianliao: json_number_to_f64_or_zero(object.get("jianliao")),
        xixue: json_number_to_f64_or_zero(object.get("xixue")),
        lengque: json_number_to_f64_or_zero(object.get("lengque")),
        kongzhi_kangxing: json_number_to_f64_or_zero(object.get("kongzhi_kangxing")),
        jin_kangxing: json_number_to_f64_or_zero(object.get("jin_kangxing")),
        mu_kangxing: json_number_to_f64_or_zero(object.get("mu_kangxing")),
        shui_kangxing: json_number_to_f64_or_zero(object.get("shui_kangxing")),
        huo_kangxing: json_number_to_f64_or_zero(object.get("huo_kangxing")),
        tu_kangxing: json_number_to_f64_or_zero(object.get("tu_kangxing")),
        qixue_huifu: json_number_to_f64_or_zero(object.get("qixue_huifu")),
        lingqi_huifu: json_number_to_f64_or_zero(object.get("lingqi_huifu")),
        realm: object
            .get("realm")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.to_string()),
        element: object
            .get("element")
            .and_then(serde_json::Value::as_str)
            .map(|value| value.to_string()),
    })
}

fn runtime_summon_template_from_json(
    summon_template: &serde_json::Value,
) -> Option<RuntimeSummonTemplate> {
    let object = summon_template.as_object()?;
    let id = object
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let attrs = battle_attrs_from_json(object.get("baseAttrs")?)?;
    let skills = object
        .get("skills")
        .and_then(serde_json::Value::as_array)?
        .clone();
    let ai_profile = match object.get("aiProfile") {
        Some(value) if value.is_object() => Some(value.clone()),
        _ => None,
    };

    Some(RuntimeSummonTemplate {
        id,
        name,
        attrs,
        skills,
        ai_profile,
    })
}

fn build_runtime_summon_unit(
    template: &RuntimeSummonTemplate,
    actor_id: &str,
    action_round: i64,
    summon_sequence: i64,
) -> BattleUnitDto {
    BattleUnitDto {
        id: format!(
            "summon-{}-{}-{}-{}",
            template.id, actor_id, action_round, summon_sequence
        ),
        name: template.name.clone(),
        r#type: "summon".to_string(),
        source_id: serde_json::json!(template.id),
        base_attrs: template.attrs.clone(),
        formation_order: None,
        owner_unit_id: Some(actor_id.to_string()),
        month_card_active: None,
        avatar: None,
        qixue: template.attrs.max_qixue.max(1),
        lingqi: template.attrs.max_lingqi.max(0),
        current_attrs: template.attrs.clone(),
        shields: Vec::new(),
        is_alive: true,
        can_act: false,
        buffs: Vec::new(),
        marks: Vec::new(),
        momentum: None,
        set_bonus_effects: Vec::new(),
        skills: template.skills.clone(),
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        ai_profile: template.ai_profile.clone(),
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    }
}

fn value_to_f64(raw: Option<serde_json::Value>, default_value: f64) -> f64 {
    match raw {
        Some(serde_json::Value::Number(number)) => number.as_f64().unwrap_or(default_value),
        _ => default_value,
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
        max_qixue: base_attrs
            .max_qixue
            .or(base_attrs.qixue)
            .unwrap_or(50)
            .max(1),
        max_lingqi: base_attrs
            .max_lingqi
            .or(base_attrs.lingqi)
            .unwrap_or_default()
            .max(0),
        wugong: base_attrs.wugong.unwrap_or(8).max(0),
        fagong: base_attrs.fagong.unwrap_or_default().max(0),
        wufang: base_attrs.wufang.unwrap_or_default().max(0),
        fafang: base_attrs.fafang.unwrap_or_default().max(0),
        sudu: base_attrs.sudu.unwrap_or(1).max(1),
        mingzhong: value_to_f64(base_attrs.mingzhong, 1.0),
        shanbi: value_to_f64(base_attrs.shanbi, 0.0),
        zhaojia: value_to_f64(base_attrs.zhaojia, 0.0),
        baoji: value_to_f64(base_attrs.baoji, 0.0),
        baoshang: value_to_f64(base_attrs.baoshang, 0.0),
        jianbaoshang: value_to_f64(base_attrs.jianbaoshang, 0.0),
        jianfantan: value_to_f64(base_attrs.jianfantan, 0.0),
        kangbao: value_to_f64(base_attrs.kangbao, 0.0),
        zengshang: value_to_f64(base_attrs.zengshang, 0.0),
        zhiliao: value_to_f64(base_attrs.zhiliao, 0.0),
        jianliao: value_to_f64(base_attrs.jianliao, 0.0),
        xixue: value_to_f64(base_attrs.xixue, 0.0),
        lengque: value_to_f64(base_attrs.lengque, 0.0),
        kongzhi_kangxing: value_to_f64(base_attrs.kongzhi_kangxing, 0.0),
        jin_kangxing: value_to_f64(base_attrs.jin_kangxing, 0.0),
        mu_kangxing: value_to_f64(base_attrs.mu_kangxing, 0.0),
        shui_kangxing: value_to_f64(base_attrs.shui_kangxing, 0.0),
        huo_kangxing: value_to_f64(base_attrs.huo_kangxing, 0.0),
        tu_kangxing: value_to_f64(base_attrs.tu_kangxing, 0.0),
        qixue_huifu: value_to_f64(base_attrs.qixue_huifu, 0.0),
        lingqi_huifu: value_to_f64(base_attrs.lingqi_huifu, 0.0),
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
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/skill_def.json");
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
        if let Some(skill_seed) = skill_seed_map.as_ref().and_then(|map| map.get(normalized)) {
            skills.push(runtime_skill_value_from_seed(skill_seed));
        }
    }
    if !skills.iter().any(|skill| {
        skill.get("id").and_then(serde_json::Value::as_str) == Some("skill-normal-attack")
    }) {
        skills.insert(
            0,
            build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0),
        );
    }
    if skills.is_empty() {
        skills.push(build_skill_value(
            "skill-normal-attack",
            "普通攻击",
            0,
            0,
            0,
        ));
    }
    skills
}

fn resolve_monster_ai_profile_value(seed: &MonsterSeed) -> Option<serde_json::Value> {
    let mut resolving = BTreeSet::new();
    resolve_monster_ai_profile_value_with_seen(seed, &mut resolving)
}

fn resolve_monster_ai_profile_value_with_seen(
    seed: &MonsterSeed,
    resolving: &mut BTreeSet<String>,
) -> Option<serde_json::Value> {
    seed.ai_profile.as_ref().map(|profile| {
        let seed_id = seed
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let inserted = seed_id
            .as_ref()
            .map(|id| resolving.insert(id.clone()))
            .unwrap_or(false);
        let phase_triggers = if seed_id.is_some() && !inserted {
            Vec::new()
        } else {
            resolve_monster_phase_triggers_value(seed, profile, resolving)
        };
        if inserted {
            if let Some(id) = seed_id.as_ref() {
                resolving.remove(id);
            }
        }
        serde_json::json!({
            "skills": profile.skills.clone().unwrap_or_default(),
            "phaseTriggers": phase_triggers,
        })
    })
}

fn resolve_monster_phase_triggers_value(
    seed: &MonsterSeed,
    profile: &MonsterAiProfileSeed,
    resolving: &mut BTreeSet<String>,
) -> Vec<serde_json::Value> {
    let Some(raw_triggers) = profile.phase_triggers.as_ref() else {
        return Vec::new();
    };
    let Some(monster_id) = seed
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let mut triggers = Vec::new();
    for (index, trigger) in raw_triggers.iter().enumerate() {
        let trigger_id = trigger
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{monster_id}-phase-{}", index + 1));
        let Some(hp_percent) = trigger
            .get("hp_percent")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| *value > 0.0 && *value <= 1.0)
        else {
            continue;
        };
        let Some(action) = trigger
            .get("action")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if action == "enrage" {
            let effects = trigger
                .get("effects")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            triggers.push(serde_json::json!({
                "id": trigger_id,
                "hpPercent": hp_percent,
                "action": "enrage",
                "effects": effects,
            }));
            continue;
        }
        if action != "summon" {
            continue;
        }
        let Some(summon_id) = trigger
            .get("summon_id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(summon_count) = trigger
            .get("summon_count")
            .and_then(|value| json_number_to_i64_floor(Some(value)))
            .filter(|value| *value >= 1)
        else {
            continue;
        };
        let Ok(summon_seed) = load_monster_seed(summon_id) else {
            continue;
        };
        let Some(template_name) = summon_seed
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let attrs = build_monster_battle_attrs(&summon_seed);
        let skills = resolve_monster_battle_skills(&summon_seed);
        let mut summon_template = serde_json::json!({
            "id": summon_id,
            "name": template_name,
            "baseAttrs": attrs,
            "skills": skills,
        });
        if let Some(ai_profile) =
            resolve_monster_ai_profile_value_with_seen(&summon_seed, resolving)
        {
            if let Some(object) = summon_template.as_object_mut() {
                object.insert("aiProfile".to_string(), ai_profile);
            }
        }
        triggers.push(serde_json::json!({
            "id": trigger_id,
            "hpPercent": hp_percent,
            "action": "summon",
            "effects": [],
            "summonMonsterId": summon_id,
            "summonCount": summon_count,
            "summonTemplate": summon_template,
        }));
    }
    triggers
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
    try_build_minimal_pve_battle_state(battle_id, player_character_id, monster_ids)
        .expect("monster seed should exist")
}

pub fn try_build_minimal_pve_battle_state(
    battle_id: &str,
    player_character_id: i64,
    monster_ids: &[String],
) -> Result<BattleStateDto, String> {
    let attacker_attrs = build_battle_attrs(180, 100, 32, 10, Some("凡人".to_string()));
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
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        ai_profile: None,
        control_diminishing: BTreeMap::new(),
        stats: empty_battle_stats(),
        reward_exp: None,
        reward_silver: None,
    };
    let defender_units = monster_ids
        .iter()
        .enumerate()
        .map(|(index, monster_id)| {
            let seed = load_monster_seed(monster_id)?;
            let attrs = build_monster_battle_attrs(&seed);
            let qixue = attrs.max_qixue.max(1);
            let lingqi = attrs.max_lingqi.max(0);
            Ok(BattleUnitDto {
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
                triggered_phase_ids: Vec::new(),
                skill_cooldowns: BTreeMap::new(),
                skill_cooldown_discount_bank: BTreeMap::new(),
                partner_skill_policy: None,
                ai_profile: resolve_monster_ai_profile_value(&seed),
                control_diminishing: BTreeMap::new(),
                stats: empty_battle_stats(),
                reward_exp: Some(seed.exp_reward.unwrap_or_default().max(0)),
                reward_silver: Some(seed.silver_reward_min.unwrap_or_default().max(0)),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

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
    Ok(state)
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
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        ai_profile: None,
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
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        ai_profile: None,
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
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: Some(skill_policy),
        ai_profile: None,
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
        triggered_phase_ids: Vec::new(),
        skill_cooldowns: BTreeMap::new(),
        skill_cooldown_discount_bank: BTreeMap::new(),
        partner_skill_policy: None,
        ai_profile: None,
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
            .then_with(|| {
                left.formation_order
                    .unwrap_or(i64::MAX)
                    .cmp(&right.formation_order.unwrap_or(i64::MAX))
            })
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
    units
        .iter()
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

fn build_dot_log(
    round: i64,
    unit_id: &str,
    unit_name: &str,
    buff_name: &str,
    damage: i64,
) -> serde_json::Value {
    serde_json::json!({
        "type": "dot",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "buffName": buff_name,
        "damage": damage.max(0),
    })
}

fn build_hot_log(
    round: i64,
    unit_id: &str,
    unit_name: &str,
    buff_name: &str,
    heal: i64,
) -> serde_json::Value {
    serde_json::json!({
        "type": "hot",
        "round": round,
        "unitId": unit_id,
        "unitName": unit_name,
        "buffName": buff_name,
        "heal": heal.max(0),
    })
}

fn build_buff_expire_log(
    round: i64,
    unit_id: &str,
    unit_name: &str,
    buff_name: &str,
) -> serde_json::Value {
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
                    skill
                        .get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(|skill_id| (unit.id.clone(), skill_id.to_string()))
                } else {
                    None
                }
            })
        })
        .collect::<Vec<_>>();
    for (actor_id, skill_id) in passive_casts {
        if let Ok(mut passive_logs) =
            execute_runtime_skill_action(state, actor_id.as_str(), skill_id.as_str(), &[])
        {
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
    for buff_index in 0..unit.buffs.len() {
        if !unit.is_alive {
            break;
        }
        let buff = unit.buffs[buff_index].clone();
        if let Some(delayed) = buff.get("delayedBurst") {
            let remaining_rounds = delayed
                .get("remainingRounds")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default();
            if remaining_rounds > 1 {
                if let Some(object) = unit
                    .buffs
                    .get_mut(buff_index)
                    .and_then(serde_json::Value::as_object_mut)
                    .and_then(|buff| buff.get_mut("delayedBurst"))
                    .and_then(serde_json::Value::as_object_mut)
                {
                    object.insert(
                        "remainingRounds".to_string(),
                        serde_json::json!(remaining_rounds - 1),
                    );
                }
            } else if unit.is_alive {
                let damage = delayed
                    .get("damage")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or_default()
                    .max(0);
                if damage > 0 {
                    let qixue_before = unit.qixue;
                    unit.qixue = (unit.qixue - damage).max(0);
                    let actual_damage = (qixue_before - unit.qixue).max(0);
                    unit.is_alive = unit.qixue > 0;
                    unit.can_act = unit.is_alive;
                    logs.push(build_dot_log(
                        round,
                        unit_id,
                        unit_name.as_str(),
                        "延迟爆发",
                        actual_damage,
                    ));
                    if !unit.is_alive {
                        logs.push(build_minimal_death_log(
                            round,
                            unit_id,
                            unit_name.as_str(),
                            None,
                            None,
                        ));
                    }
                }
                if let Some(object) = unit
                    .buffs
                    .get_mut(buff_index)
                    .and_then(serde_json::Value::as_object_mut)
                {
                    object.insert("remainingDuration".to_string(), serde_json::json!(0));
                }
            }
        }
        if let Some(dot) = buff.get("dot") {
            let damage = dot
                .get("damage")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
                .max(0);
            let qixue_before = unit.qixue;
            unit.qixue = (unit.qixue - damage).max(0);
            let actual_damage = (qixue_before - unit.qixue).max(0);
            unit.is_alive = unit.qixue > 0;
            unit.can_act = unit.is_alive;
            logs.push(build_dot_log(
                round,
                unit_id,
                unit_name.as_str(),
                buff.get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("持续伤害"),
                actual_damage,
            ));
            if !unit.is_alive {
                logs.push(build_minimal_death_log(
                    round,
                    unit_id,
                    unit_name.as_str(),
                    None,
                    None,
                ));
            }
        }
        if let Some(hot) = buff.get("hot") {
            if !unit.is_alive {
                continue;
            }
            let heal = hot
                .get("heal")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
                .max(0);
            let actual_heal = apply_runtime_healing(unit, heal);
            if actual_heal > 0 {
                logs.push(build_hot_log(
                    round,
                    unit_id,
                    unit_name.as_str(),
                    buff.get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("持续治疗"),
                    actual_heal,
                ));
            }
        }
    }
}

fn process_round_end_buffs(
    state: &mut BattleStateDto,
    unit_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
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
            if buff.get("deferredDamage").is_some() {
                return Some(buff);
            }
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
                    buff.get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("效果"),
                ));
                None
            } else {
                if let Some(object) = buff.as_object_mut() {
                    object.insert(
                        "remainingDuration".to_string(),
                        serde_json::json!(next_remaining),
                    );
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
            let duration = shield
                .get("duration")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(-1);
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
    let qixue_regen = unit.current_attrs.qixue_huifu.max(0.0);
    if qixue_regen > 0.0 {
        let next_qixue = ((unit.qixue as f64) + qixue_regen).floor() as i64;
        unit.qixue = next_qixue.min(unit.current_attrs.max_qixue.max(1));
    }
    let lingqi_regen = unit.current_attrs.lingqi_huifu.max(0.0);
    if lingqi_regen > 0.0 {
        let next_lingqi = ((unit.lingqi as f64) + lingqi_regen).floor() as i64;
        unit.lingqi = next_lingqi.min(unit.current_attrs.max_lingqi.max(0));
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
        let unit_id = unit.id.clone();
        process_unit_round_start_effects(state, unit_id.as_str(), logs);
        if !unit_by_id(state, unit_id.as_str())
            .map(|unit| unit.is_alive)
            .unwrap_or(false)
        {
            continue;
        }
        process_runtime_aura_effects_at_round_start(state, unit_id.as_str(), logs);
        process_runtime_set_bonus_turn_start_effects(state, unit_id.as_str(), logs);
        if let Some(unit) = unit_by_id_mut(state, unit_id.as_str()) {
            recover_unit_resources_for_round_start(unit);
        }
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
        settle_runtime_set_deferred_damage_at_round_end(state, unit_id.as_str(), logs);
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

fn unit_by_id_mut<'a>(
    state: &'a mut BattleStateDto,
    unit_id: &str,
) -> Option<&'a mut BattleUnitDto> {
    state
        .teams
        .attacker
        .units
        .iter_mut()
        .chain(state.teams.defender.units.iter_mut())
        .find(|unit| unit.id == unit_id)
}

fn unit_team_key(state: &BattleStateDto, unit_id: &str) -> Option<&'static str> {
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

fn runtime_skill_value<'a>(
    unit: &'a BattleUnitDto,
    skill_id: &str,
) -> Option<&'a serde_json::Value> {
    unit.skills
        .iter()
        .find(|skill| skill.get("id").and_then(serde_json::Value::as_str) == Some(skill_id.trim()))
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
    skill
        .get("targetType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("single_enemy")
}

fn target_count_from_value(value: &serde_json::Value) -> usize {
    value
        .get("targetCount")
        .or_else(|| value.get("target_count"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1) as usize
}

fn alive_unit_ids(state: &BattleStateDto, team: &str) -> Vec<String> {
    team_units(state, team)
        .iter()
        .filter(|unit| unit.is_alive)
        .map(|unit| unit.id.clone())
        .collect::<Vec<_>>()
}

fn random_alive_unit_ids(state: &mut BattleStateDto, team: &str, count: usize) -> Vec<String> {
    let mut candidates = alive_unit_ids(state, team);
    if candidates.len() <= count {
        return candidates;
    }
    for i in (1..candidates.len()).rev() {
        let roll = next_runtime_random(state);
        let j = ((roll * ((i + 1) as f64)).floor() as usize).min(i);
        candidates.swap(i, j);
    }
    candidates.into_iter().take(count).collect()
}

fn taunt_locked_target_id(
    state: &BattleStateDto,
    actor_id: &str,
    enemy_team: &str,
) -> Option<String> {
    let actor = unit_by_id(state, actor_id)?;
    let source_unit_id = actor
        .buffs
        .iter()
        .find(|buff| buff.get("control").and_then(serde_json::Value::as_str) == Some("taunt"))
        .and_then(|buff| buff.get("sourceUnitId").and_then(serde_json::Value::as_str))?;
    team_units(state, enemy_team)
        .iter()
        .find(|unit| unit.id == source_unit_id && unit.is_alive)
        .map(|unit| unit.id.clone())
}

fn resolve_runtime_skill_targets(
    state: &mut BattleStateDto,
    actor_id: &str,
    skill_id: &str,
    selected_target_ids: &[String],
) -> Result<Vec<String>, String> {
    let actor = unit_by_id(state, actor_id).ok_or_else(|| "当前不可行动".to_string())?;
    let skill = runtime_skill_value(actor, skill_id)
        .ok_or_else(|| format!("战斗技能不存在: {}", skill_id.trim()))?;
    let target_type = skill_target_type(skill).to_string();
    let target_count = target_count_from_value(skill);
    let actor_team = if state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == actor_id)
    {
        "attacker"
    } else {
        "defender"
    };
    let enemy_team = opposing_team_key(actor_team);
    let ally_team = actor_team;

    let targets = match target_type.as_str() {
        "self" => vec![actor_id.to_string()],
        "single_ally" => {
            match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
                Some(target_id) => vec![target_id],
                None => first_alive_unit_id(state, ally_team)
                    .map(|id| vec![id])
                    .unwrap_or_default(),
            }
        }
        "all_ally" => team_units(state, ally_team)
            .iter()
            .filter(|unit| unit.is_alive)
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>(),
        "random_ally" => random_alive_unit_ids(state, ally_team, target_count),
        "all_enemy" => match taunt_locked_target_id(state, actor_id, enemy_team) {
            Some(target_id) => vec![target_id],
            None => team_units(state, enemy_team)
                .iter()
                .filter(|unit| unit.is_alive)
                .map(|unit| unit.id.clone())
                .collect::<Vec<_>>(),
        },
        "single_enemy" => {
            if let Some(target_id) = taunt_locked_target_id(state, actor_id, enemy_team) {
                vec![target_id]
            } else {
                match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
                    Some(target_id) => vec![target_id],
                    None => first_alive_unit_id(state, enemy_team)
                        .map(|id| vec![id])
                        .unwrap_or_default(),
                }
            }
        }
        "random_enemy" => {
            if let Some(target_id) = taunt_locked_target_id(state, actor_id, enemy_team) {
                vec![target_id]
            } else {
                random_alive_unit_ids(state, enemy_team, target_count)
            }
        }
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
    default_scale_attr: &str,
) -> i64 {
    let value = effect
        .get("value")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let value_type = effect
        .get("valueType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("scale");
    let scale_attr = effect
        .get("scaleAttr")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(default_scale_attr);
    let actor_attr_value = battle_attr_value_i64(&actor.current_attrs, scale_attr);
    match value_type {
        "flat" => value.floor() as i64,
        "percent" => ((target.current_attrs.max_qixue as f64) * value).floor() as i64,
        "combined" => {
            let base = effect
                .get("baseValue")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let rate = effect
                .get("scaleRate")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
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

fn battle_attr_value_i64(attrs: &BattleUnitCurrentAttrsDto, attr: &str) -> i64 {
    match attr.trim() {
        "max_qixue" => attrs.max_qixue,
        "max_lingqi" => attrs.max_lingqi,
        "wugong" => attrs.wugong,
        "fagong" => attrs.fagong,
        "wufang" => attrs.wufang,
        "fafang" => attrs.fafang,
        "sudu" => attrs.sudu,
        "qixue_huifu" => attrs.qixue_huifu.round() as i64,
        "lingqi_huifu" => attrs.lingqi_huifu.round() as i64,
        _ => battle_attr_value_f64(attrs, attr).round() as i64,
    }
}

fn battle_attr_value_f64(attrs: &BattleUnitCurrentAttrsDto, attr: &str) -> f64 {
    match attr.trim() {
        "max_qixue" => attrs.max_qixue as f64,
        "max_lingqi" => attrs.max_lingqi as f64,
        "wugong" => attrs.wugong as f64,
        "fagong" => attrs.fagong as f64,
        "wufang" => attrs.wufang as f64,
        "fafang" => attrs.fafang as f64,
        "sudu" => attrs.sudu as f64,
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
        _ => 0.0,
    }
}

fn effect_target_mode(
    effect: &serde_json::Value,
    skill_target_type: &str,
    effect_type: &str,
) -> &'static str {
    match effect.get("target").and_then(serde_json::Value::as_str) {
        Some("self") => "self",
        Some("target") => "target",
        Some("enemy") => "enemy",
        Some("ally") => "ally",
        _ => match effect_type {
            "buff" => {
                if matches!(
                    skill_target_type,
                    "single_enemy" | "all_enemy" | "random_enemy"
                ) {
                    "self"
                } else {
                    "target"
                }
            }
            "debuff" => "enemy",
            "heal" | "shield" | "restore_lingqi" => {
                if matches!(
                    skill_target_type,
                    "single_enemy" | "all_enemy" | "random_enemy"
                ) {
                    "self"
                } else {
                    "target"
                }
            }
            "resource" => {
                let value = json_number_to_f64(effect.get("value")).unwrap_or_default();
                if value > 0.0
                    && matches!(
                        skill_target_type,
                        "single_enemy" | "all_enemy" | "random_enemy"
                    )
                {
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
    state: &mut BattleStateDto,
    actor_id: &str,
    primary_target_ids: &[String],
    selected_target_ids: &[String],
    skill_target_type: &str,
    skill_target_count: usize,
    effect: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let actor_team = if state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == actor_id)
    {
        "attacker"
    } else {
        "defender"
    };
    let enemy_team = opposing_team_key(actor_team);
    let ally_team = actor_team;
    let effect_type = effect
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mode = effect_target_mode(effect, skill_target_type, effect_type);
    let target_count = effect
        .get("targetCount")
        .or_else(|| effect.get("target_count"))
        .and_then(serde_json::Value::as_i64)
        .map(|value| value.max(1) as usize)
        .unwrap_or(skill_target_count);
    let resolved = match mode {
        "self" => vec![actor_id.to_string()],
        "ally" => match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
            Some(target_id) => vec![target_id],
            None => {
                if target_count > 1 {
                    random_alive_unit_ids(state, ally_team, target_count)
                } else {
                    first_alive_unit_id(state, ally_team)
                        .map(|id| vec![id])
                        .unwrap_or_default()
                }
            }
        },
        "enemy" => {
            if let Some(target_id) = taunt_locked_target_id(state, actor_id, enemy_team) {
                vec![target_id]
            } else {
                match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
                    Some(target_id) => vec![target_id],
                    None => {
                        if target_count > 1 {
                            random_alive_unit_ids(state, enemy_team, target_count)
                        } else {
                            first_alive_unit_id(state, enemy_team)
                                .map(|id| vec![id])
                                .unwrap_or_default()
                        }
                    }
                }
            }
        }
        _ => match skill_target_type {
            "self" | "single_ally" | "all_ally" | "random_ally" | "all_enemy" | "single_enemy"
            | "random_enemy"
                if !primary_target_ids.is_empty() =>
            {
                primary_target_ids.to_vec()
            }
            "self" => vec![actor_id.to_string()],
            "single_ally" => {
                match resolve_selected_alive_target(state, ally_team, selected_target_ids)? {
                    Some(target_id) => vec![target_id],
                    None => first_alive_unit_id(state, ally_team)
                        .map(|id| vec![id])
                        .unwrap_or_default(),
                }
            }
            "all_ally" => team_units(state, ally_team)
                .iter()
                .filter(|unit| unit.is_alive)
                .map(|unit| unit.id.clone())
                .collect::<Vec<_>>(),
            "random_ally" => random_alive_unit_ids(state, ally_team, target_count),
            "all_enemy" => match taunt_locked_target_id(state, actor_id, enemy_team) {
                Some(target_id) => vec![target_id],
                None => team_units(state, enemy_team)
                    .iter()
                    .filter(|unit| unit.is_alive)
                    .map(|unit| unit.id.clone())
                    .collect::<Vec<_>>(),
            },
            "single_enemy" => {
                if let Some(target_id) = taunt_locked_target_id(state, actor_id, enemy_team) {
                    vec![target_id]
                } else {
                    match resolve_selected_alive_target(state, enemy_team, selected_target_ids)? {
                        Some(target_id) => vec![target_id],
                        None => first_alive_unit_id(state, enemy_team)
                            .map(|id| vec![id])
                            .unwrap_or_default(),
                    }
                }
            }
            "random_enemy" => {
                if let Some(target_id) = taunt_locked_target_id(state, actor_id, enemy_team) {
                    vec![target_id]
                } else {
                    random_alive_unit_ids(state, enemy_team, target_count)
                }
            }
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
    if let Some(index) = target_logs
        .iter()
        .position(|entry| entry.target_id == target_id)
    {
        return &mut target_logs[index];
    }
    target_logs.push(RuntimeResolvedTargetLog {
        target_id: target_id.to_string(),
        target_name: target_name.to_string(),
        damage: 0,
        heal: 0,
        shield: 0,
        resources: Vec::new(),
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

fn push_runtime_resource_log(
    target_log: &mut RuntimeResolvedTargetLog,
    resource_type: &str,
    amount: i64,
) {
    if amount <= 0 {
        return;
    }
    target_log.resources.push(serde_json::json!({
        "type": resource_type,
        "amount": amount,
    }));
}

fn runtime_momentum_state(
    momentum_value: Option<&serde_json::Value>,
    momentum_id: &str,
) -> (i64, i64) {
    let Some(momentum) = momentum_value.and_then(serde_json::Value::as_object) else {
        return (0, 0);
    };
    if momentum
        .get("id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id != momentum_id)
    {
        return (0, 0);
    }
    let max_stacks = json_number_to_i64_floor(momentum.get("maxStacks"))
        .unwrap_or(1)
        .max(1);
    let stacks = json_number_to_i64_floor(momentum.get("stacks"))
        .unwrap_or_default()
        .clamp(0, max_stacks);
    (stacks, max_stacks)
}

fn resolve_runtime_momentum_max_stacks(
    momentum_value: Option<&serde_json::Value>,
    momentum_id: &str,
    effect: &serde_json::Value,
) -> Result<i64, String> {
    if let Some(momentum) = momentum_value.and_then(serde_json::Value::as_object) {
        if momentum
            .get("id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| id == momentum_id)
        {
            return Ok(json_number_to_i64_floor(momentum.get("maxStacks"))
                .unwrap_or(1)
                .max(1));
        }
    }
    Ok(json_number_to_i64_floor(effect.get("maxStacks"))
        .ok_or_else(|| "momentum maxStacks 缺失".to_string())?
        .max(1))
}

fn set_runtime_momentum_state(
    momentum_value: &mut Option<serde_json::Value>,
    momentum_id: &str,
    stacks: i64,
    max_stacks: i64,
) {
    let normalized_max_stacks = max_stacks.max(1);
    *momentum_value = Some(serde_json::json!({
        "id": momentum_id,
        "stacks": stacks.clamp(0, normalized_max_stacks),
        "maxStacks": normalized_max_stacks,
    }));
}

fn process_runtime_skill_momentum_effect(
    momentum_value: &mut Option<serde_json::Value>,
    effect: &serde_json::Value,
    effect_context: &mut RuntimeSkillEffectContext,
) -> Result<(), String> {
    let operation = effect
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "momentum operation 缺失".to_string())?;
    let momentum_id = effect
        .get("momentumId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "momentumId 缺失".to_string())?;
    match operation {
        "gain" => {
            let gain_stacks = json_number_to_i64_floor(effect.get("gainStacks"))
                .ok_or_else(|| "momentum gainStacks 缺失".to_string())?;
            if gain_stacks <= 0 {
                return Err("momentum gainStacks 必须大于0".to_string());
            }
            let (current_stacks, _) = runtime_momentum_state(momentum_value.as_ref(), momentum_id);
            let max_stacks =
                resolve_runtime_momentum_max_stacks(momentum_value.as_ref(), momentum_id, effect)?;
            let next_stacks = (current_stacks + gain_stacks).min(max_stacks);
            let gained_stacks = (next_stacks - current_stacks).max(0);
            set_runtime_momentum_state(momentum_value, momentum_id, next_stacks, max_stacks);
            if gained_stacks > 0 {
                effect_context
                    .momentum_gained
                    .push(format!("势+{gained_stacks}（当前{next_stacks}层）"));
            }
        }
        "consume" => {
            let consume_mode = effect
                .get("consumeMode")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "momentum consumeMode 缺失".to_string())?;
            if consume_mode != "all" && consume_mode != "fixed" {
                return Err(format!("momentum consumeMode 不支持: {consume_mode}"));
            }
            let per_stack_rate = json_number_to_f64(effect.get("perStackRate"))
                .ok_or_else(|| "momentum perStackRate 缺失".to_string())?;
            if per_stack_rate < 0.0 {
                return Err("momentum perStackRate 不能小于0".to_string());
            }
            let bonus_type = effect
                .get("bonusType")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "momentum bonusType 缺失".to_string())?;
            if !matches!(
                bonus_type,
                "damage" | "heal" | "shield" | "resource" | "all"
            ) {
                return Err(format!("momentum bonusType 不支持: {bonus_type}"));
            }
            let consume_stacks = if consume_mode == "fixed" {
                let value = json_number_to_i64_floor(effect.get("consumeStacks"))
                    .ok_or_else(|| "momentum consumeStacks 缺失".to_string())?;
                if value <= 0 {
                    return Err("momentum consumeStacks 必须大于0".to_string());
                }
                value
            } else {
                0
            };
            let (current_stacks, _) = runtime_momentum_state(momentum_value.as_ref(), momentum_id);
            if current_stacks <= 0 {
                return Ok(());
            }
            let max_stacks =
                resolve_runtime_momentum_max_stacks(momentum_value.as_ref(), momentum_id, effect)?;
            let consumed_stacks = if consume_mode == "all" {
                current_stacks
            } else {
                consume_stacks.min(current_stacks)
            };
            let remaining_stacks = (current_stacks - consumed_stacks).max(0);
            set_runtime_momentum_state(momentum_value, momentum_id, remaining_stacks, max_stacks);
            if consumed_stacks <= 0 {
                return Ok(());
            }
            effect_context.momentum_consumed.push(format!(
                "消耗{consumed_stacks}层势（剩余{remaining_stacks}层）"
            ));
            let total_bonus_rate = per_stack_rate * consumed_stacks as f64;
            match bonus_type {
                "damage" => effect_context.damage_bonus_rate += total_bonus_rate,
                "heal" => effect_context.heal_bonus_rate += total_bonus_rate,
                "shield" => effect_context.shield_bonus_rate += total_bonus_rate,
                "resource" => effect_context.resource_bonus_rate += total_bonus_rate,
                "all" => {
                    effect_context.damage_bonus_rate += total_bonus_rate;
                    effect_context.heal_bonus_rate += total_bonus_rate;
                    effect_context.shield_bonus_rate += total_bonus_rate;
                    effect_context.resource_bonus_rate += total_bonus_rate;
                }
                _ => unreachable!(),
            }
        }
        _ => return Err(format!("momentum operation 不支持: {operation}")),
    }
    Ok(())
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
            let attr = modifier
                .get("attr")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let mode = modifier
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("flat");
            let value = modifier
                .get("value")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            let base_value = battle_attr_value_f64(&unit.current_attrs, attr);
            let next_value = if mode == "percent" {
                base_value * (1.0 + value)
            } else {
                base_value + value
            };
            apply_attr_value(&mut unit.current_attrs, attr, next_value);
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
    let current = battle_attr_value_f64(&unit.current_attrs, attr_key);
    let next = if apply_type == "percent" {
        current * (1.0 + value)
    } else {
        current + value
    };
    apply_attr_value(&mut unit.current_attrs, attr_key, next);
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
            let effect_type = effect
                .get("effectType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let params = effect
                .get("params")
                .and_then(serde_json::Value::as_object)
                .cloned()
                .unwrap_or_default();
            match effect_type {
                "buff" => {
                    let attr_key = params
                        .get("attr_key")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .trim();
                    let apply_type = params
                        .get("apply_type")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("flat");
                    let value = params
                        .get("value")
                        .and_then(|value| {
                            value.as_f64().or_else(|| value.as_i64().map(|v| v as f64))
                        })
                        .unwrap_or_default();
                    if !attr_key.is_empty() && value != 0.0 {
                        apply_runtime_attr_modifier_to_unit(unit, attr_key, apply_type, value);
                    }
                }
                "shield" => {
                    let value = params
                        .get("value")
                        .and_then(|value| {
                            value
                                .as_i64()
                                .or_else(|| value.as_f64().map(|v| v.round() as i64))
                        })
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
        let effect_type = effect
            .get("effectType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let params = effect
            .get("params")
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        match effect_type {
            "heal" => {
                let heal = params
                    .get("value")
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_f64().map(|v| v.round() as i64))
                    })
                    .unwrap_or_default()
                    .max(0);
                if heal > 0 && unit.is_alive {
                    let actual = apply_runtime_healing(unit, heal);
                    if actual > 0 {
                        unit.stats.healing_done += actual;
                        logs.push(build_hot_log(
                            round,
                            unit_id,
                            unit_name.as_str(),
                            effect
                                .get("setName")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("套装效果"),
                            actual,
                        ));
                    }
                }
            }
            "resource" => {
                let value = params
                    .get("value")
                    .and_then(|val| {
                        val.as_i64()
                            .or_else(|| val.as_f64().map(|v| v.round() as i64))
                    })
                    .unwrap_or_default();
                let resource_type = params
                    .get("resource_type")
                    .or_else(|| params.get("resourceType"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("lingqi");
                if resource_type == "qixue" {
                    if value > 0 {
                        let actual = apply_runtime_healing(unit, value);
                        if actual > 0 {
                            unit.stats.healing_done += actual;
                            logs.push(build_hot_log(
                                round,
                                unit_id,
                                unit_name.as_str(),
                                effect
                                    .get("setName")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("套装效果"),
                                actual,
                            ));
                        }
                    } else {
                        unit.qixue =
                            (unit.qixue + value).clamp(0, unit.current_attrs.max_qixue.max(1));
                    }
                } else {
                    let adjusted_value = if value > 0 {
                        apply_runtime_recovery_reduction(value, unit)
                    } else {
                        value
                    };
                    let before = unit.lingqi;
                    unit.lingqi = (unit.lingqi + adjusted_value)
                        .clamp(0, unit.current_attrs.max_lingqi.max(0));
                    let gain = (unit.lingqi - before).max(0);
                    if gain > 0 {
                        logs.push(build_runtime_action_log(
                            round,
                            unit_id,
                            unit_name.as_str(),
                            &format!(
                                "proc-{}-on_turn_start",
                                effect
                                    .get("setId")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("set")
                            ),
                            effect
                                .get("setName")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("套装效果"),
                            &[RuntimeResolvedTargetLog {
                                target_id: unit_id.to_string(),
                                target_name: unit_name.clone(),
                                damage: 0,
                                heal: 0,
                                shield: 0,
                                resources: vec![serde_json::json!({
                                    "type": "lingqi",
                                    "amount": gain,
                                })],
                                buffs_applied: Vec::new(),
                                is_miss: false,
                                is_crit: false,
                                is_parry: false,
                                is_element_bonus: false,
                                shield_absorbed: 0,
                                momentum_gained: Vec::new(),
                                momentum_consumed: Vec::new(),
                            }],
                        ));
                    }
                }
            }
            "buff" => {
                let attr_key = params
                    .get("attr_key")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .trim();
                let apply_type = params
                    .get("apply_type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("flat");
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

fn apply_runtime_set_bonus_buff_or_debuff(
    target: &mut BattleUnitDto,
    owner_id: &str,
    effect: &serde_json::Value,
    effect_type: &str,
    params: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    let attr_key = params
        .get("attr_key")
        .or_else(|| params.get("attrKey"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    let apply_type = params
        .get("apply_type")
        .or_else(|| params.get("applyType"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("flat");
    let value = params
        .get("value")
        .and_then(|value| value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)))
        .unwrap_or_default();
    if attr_key.is_empty() || value == 0.0 {
        return None;
    }
    let set_id = effect
        .get("setId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("set");
    let set_name = effect
        .get("setName")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("套装效果");
    let duration = effect
        .get("durationRound")
        .or_else(|| params.get("duration_round"))
        .and_then(|value| json_number_to_i64_floor(Some(value)))
        .unwrap_or(1)
        .max(1);
    let is_debuff = effect_type == "debuff";
    let modifier_value = if is_debuff { -value.abs() } else { value };
    target.buffs.push(serde_json::json!({
        "id": format!("set-buff-{}-{}-{}", target.id, set_id, attr_key),
        "buffDefId": format!("set-buff-{}", attr_key),
        "name": set_name,
        "type": if is_debuff { "debuff" } else { "buff" },
        "category": "set_bonus",
        "sourceUnitId": owner_id,
        "remainingDuration": duration,
        "stacks": 1,
        "maxStacks": 1,
        "attrModifiers": [{
            "attr": attr_key,
            "value": modifier_value,
            "mode": apply_type,
        }],
        "tags": ["set_bonus"],
        "dispellable": true,
    }));
    apply_runtime_attr_buffs(target);
    Some(set_name.to_string())
}

fn process_runtime_set_bonus_trigger(
    state: &mut BattleStateDto,
    trigger: &str,
    owner_id: &str,
    target_id: Option<&str>,
    source_damage: i64,
    logs: &mut Vec<serde_json::Value>,
) {
    let round = state.round_count;
    let Some(owner) = unit_by_id(state, owner_id).cloned() else {
        return;
    };
    if !owner.is_alive {
        return;
    }
    for effect in owner.set_bonus_effects.clone() {
        if effect.get("trigger").and_then(serde_json::Value::as_str) != Some(trigger) {
            continue;
        }
        let chance = json_number_to_f64(effect.get("chance")).unwrap_or(1.0);
        if !roll_runtime_chance(state, chance) {
            continue;
        }
        let effect_type = effect
            .get("effectType")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let params = effect
            .get("params")
            .and_then(serde_json::Value::as_object)
            .cloned()
            .unwrap_or_default();
        let resolved_target_id =
            if effect.get("target").and_then(serde_json::Value::as_str) == Some("enemy") {
                target_id.unwrap_or(owner_id)
            } else {
                owner_id
            };
        let Some(target_snapshot) = unit_by_id(state, resolved_target_id).cloned() else {
            continue;
        };
        match effect_type {
            "damage" => {
                let damage = params
                    .get("value")
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_f64().map(|value| value.floor() as i64))
                    })
                    .unwrap_or_default()
                    .max(0);
                if damage <= 0 {
                    continue;
                }
                let damage_type = params
                    .get("damage_type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("true");
                let (actual_damage, shield_absorbed) = {
                    let Some(target) = unit_by_id_mut(state, resolved_target_id) else {
                        continue;
                    };
                    apply_runtime_damage_to_target(target, damage, damage_type)
                };
                logs.push(build_runtime_action_log(
                    round,
                    owner_id,
                    owner.name.as_str(),
                    &format!(
                        "proc-{}-{}",
                        effect
                            .get("setId")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("set"),
                        trigger
                    ),
                    effect
                        .get("setName")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("套装效果"),
                    &[RuntimeResolvedTargetLog {
                        target_id: resolved_target_id.to_string(),
                        target_name: target_snapshot.name,
                        damage: actual_damage,
                        heal: 0,
                        shield: 0,
                        resources: Vec::new(),
                        buffs_applied: Vec::new(),
                        is_miss: false,
                        is_crit: false,
                        is_parry: false,
                        is_element_bonus: false,
                        shield_absorbed,
                        momentum_gained: Vec::new(),
                        momentum_consumed: Vec::new(),
                    }],
                ));
            }
            "shield" => {
                let value = params
                    .get("value")
                    .and_then(|value| {
                        value
                            .as_i64()
                            .or_else(|| value.as_f64().map(|value| value.floor() as i64))
                    })
                    .unwrap_or(source_damage)
                    .max(0);
                if value <= 0 {
                    continue;
                }
                if let Some(target) = unit_by_id_mut(state, resolved_target_id) {
                    target.shields.push(serde_json::json!({
                        "id": format!("set-shield-{}-{}", resolved_target_id, round),
                        "sourceSkillId": effect.get("setId").and_then(serde_json::Value::as_str).unwrap_or("set-bonus"),
                        "value": value,
                        "maxValue": value,
                        "duration": 1,
                        "absorbType": "all",
                        "priority": 0,
                    }));
                }
            }
            "buff" | "debuff" => {
                let applied_name = {
                    let Some(target) = unit_by_id_mut(state, resolved_target_id) else {
                        continue;
                    };
                    apply_runtime_set_bonus_buff_or_debuff(
                        target,
                        owner_id,
                        &effect,
                        effect_type,
                        &params,
                    )
                };
                let Some(applied_name) = applied_name else {
                    continue;
                };
                logs.push(build_runtime_action_log(
                    round,
                    owner_id,
                    owner.name.as_str(),
                    &format!(
                        "proc-{}-{}",
                        effect
                            .get("setId")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("set"),
                        trigger
                    ),
                    effect
                        .get("setName")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("套装效果"),
                    &[RuntimeResolvedTargetLog {
                        target_id: resolved_target_id.to_string(),
                        target_name: target_snapshot.name,
                        damage: 0,
                        heal: 0,
                        shield: 0,
                        resources: Vec::new(),
                        buffs_applied: vec![applied_name],
                        is_miss: false,
                        is_crit: false,
                        is_parry: false,
                        is_element_bonus: false,
                        shield_absorbed: 0,
                        momentum_gained: Vec::new(),
                        momentum_consumed: Vec::new(),
                    }],
                ));
            }
            _ => {}
        }
    }
}

fn process_runtime_aura_effects_at_round_start(
    state: &mut BattleStateDto,
    aura_owner_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
    let owner_team = if state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == aura_owner_id)
    {
        "attacker"
    } else {
        "defender"
    };
    let Some(owner) = unit_by_id(state, aura_owner_id).cloned() else {
        return;
    };
    if !owner.is_alive {
        return;
    }
    let aura_buffs = owner
        .buffs
        .iter()
        .filter(|buff| buff.get("aura").is_some())
        .cloned()
        .collect::<Vec<_>>();
    for aura_buff in aura_buffs {
        let Some(aura) = aura_buff.get("aura") else {
            continue;
        };
        let aura_target = aura
            .get("auraTarget")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("self");
        let target_team = match aura_target {
            "all_enemy" => opposing_team_key(owner_team),
            _ => owner_team,
        };
        let target_ids = if aura_target == "self" {
            vec![aura_owner_id.to_string()]
        } else {
            team_units(state, target_team)
                .iter()
                .filter(|unit| unit.is_alive)
                .map(|unit| unit.id.clone())
                .collect::<Vec<_>>()
        };
        let effects = aura
            .get("effects")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        if effects.is_empty() || target_ids.is_empty() {
            continue;
        }
        for target_id in target_ids {
            let Some(target) = unit_by_id_mut(state, target_id.as_str()) else {
                continue;
            };
            for effect in &effects {
                let buff_def_id = effect
                    .get("buffDefId")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("aura-sub");
                let duration = json_number_to_i64_floor(effect.get("duration"))
                    .unwrap_or(1)
                    .max(1);
                let attr_modifiers = effect
                    .get("attrModifiers")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                target.buffs.retain(|buff| {
                    !(buff.get("category").and_then(serde_json::Value::as_str) == Some("aura")
                        && buff.get("buffDefId").and_then(serde_json::Value::as_str)
                            == Some(buff_def_id))
                });
                target.buffs.push(serde_json::json!({
                    "id": format!("aura-sub-{}-{}", buff_def_id, target.id),
                    "buffDefId": buff_def_id,
                    "name": buff_def_id,
                    "type": effect.get("type").and_then(serde_json::Value::as_str).unwrap_or("buff"),
                    "category": "aura",
                    "sourceUnitId": aura_owner_id,
                    "remainingDuration": duration,
                    "stacks": 1,
                    "maxStacks": 1,
                    "attrModifiers": attr_modifiers,
                    "dot": effect.get("dot").cloned(),
                    "hot": effect.get("hot").cloned(),
                    "healForbidden": effect.get("healForbidden").cloned(),
                    "tags": ["aura_sub"],
                    "dispellable": true,
                }));
            }
            apply_runtime_attr_buffs(target);
        }
        logs.push(serde_json::json!({
            "type": "aura",
            "round": state.round_count,
            "unitId": aura_owner_id,
            "unitName": owner.name,
            "buffName": aura_buff.get("name").and_then(serde_json::Value::as_str).unwrap_or("光环"),
            "auraTarget": aura_target,
        }));
    }
}

fn settle_runtime_set_deferred_damage_at_round_end(
    state: &mut BattleStateDto,
    unit_id: &str,
    logs: &mut Vec<serde_json::Value>,
) {
    let round = state.round_count;
    let Some(unit) = unit_by_id_mut(state, unit_id) else {
        return;
    };
    if !unit.is_alive {
        return;
    }
    let unit_name = unit.name.clone();
    let mut next_buffs = Vec::new();
    for mut buff in unit.buffs.clone() {
        if !unit.is_alive {
            break;
        }
        let Some(deferred) = buff.get("deferredDamage").cloned() else {
            next_buffs.push(buff);
            continue;
        };
        let Some(pool) = deferred.get("pool").and_then(serde_json::Value::as_i64) else {
            next_buffs.push(buff);
            continue;
        };
        let Some(settle_rate) = deferred
            .get("settleRate")
            .and_then(serde_json::Value::as_f64)
        else {
            next_buffs.push(buff);
            continue;
        };
        let Some(damage_type) = deferred
            .get("damageType")
            .and_then(serde_json::Value::as_str)
        else {
            next_buffs.push(buff);
            continue;
        };
        let Some(remaining_duration) = buff
            .get("remainingDuration")
            .and_then(serde_json::Value::as_i64)
        else {
            next_buffs.push(buff);
            continue;
        };
        let pool = pool.max(0);
        let settle_rate = settle_rate.clamp(0.0, 1.0);
        let is_permanent = remaining_duration == -1;
        let settle_damage = if !is_permanent && remaining_duration <= 1 {
            pool
        } else {
            ((pool as f64) * settle_rate).floor().max(1.0) as i64
        };
        let (actual_damage, _shield_absorbed) =
            apply_runtime_damage_to_target(unit, settle_damage, damage_type);
        if actual_damage > 0 {
            logs.push(build_dot_log(
                round,
                unit_id,
                unit_name.as_str(),
                buff.get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("延迟伤害"),
                actual_damage,
            ));
        }
        let next_pool = (pool - settle_damage).max(0);
        let next_duration = if is_permanent {
            -1
        } else {
            remaining_duration - 1
        };
        if next_pool > 0 && (is_permanent || next_duration > 0) && unit.is_alive {
            if let Some(object) = buff.as_object_mut() {
                object.insert(
                    "remainingDuration".to_string(),
                    serde_json::json!(next_duration),
                );
                object.insert(
                    "deferredDamage".to_string(),
                    serde_json::json!({
                        "pool": next_pool,
                        "settleRate": settle_rate,
                        "damageType": damage_type,
                    }),
                );
            }
            next_buffs.push(buff);
        }
    }
    unit.buffs = next_buffs;
    if !unit.is_alive {
        logs.push(build_minimal_death_log(
            round,
            unit_id,
            unit_name.as_str(),
            None,
            None,
        ));
    }
}

fn runtime_has_control(unit: &BattleUnitDto, control_type: &str) -> bool {
    unit.buffs
        .iter()
        .any(|buff| buff.get("control").and_then(serde_json::Value::as_str) == Some(control_type))
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
        let current_stacks = existing
            .get("stacks")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default();
        if let Some(object) = existing.as_object_mut() {
            object.insert(
                "stacks".to_string(),
                serde_json::json!((current_stacks + stacks).min(max_stacks)),
            );
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

fn apply_runtime_delayed_burst_effect(
    target: &mut BattleUnitDto,
    actor: &BattleUnitDto,
    skill_id: &str,
    skill: &serde_json::Value,
    effect: &serde_json::Value,
) -> Option<String> {
    let damage_type = effect
        .get("damageType")
        .and_then(serde_json::Value::as_str)
        .or_else(|| skill.get("damageType").and_then(serde_json::Value::as_str))
        .unwrap_or("true");
    let default_scale_attr = if damage_type == "magic" {
        "fagong"
    } else {
        "wugong"
    };
    let damage = resolve_effect_base_value(actor, target, effect, default_scale_attr).max(1);
    let duration = json_number_to_i64_floor(effect.get("duration"))
        .unwrap_or(2)
        .max(1);
    let element = effect
        .get("element")
        .and_then(serde_json::Value::as_str)
        .or_else(|| skill.get("element").and_then(serde_json::Value::as_str))
        .unwrap_or("none");
    let buff_def_id = format!("delayed-burst:{skill_id}:{element}");
    target.buffs.push(serde_json::json!({
        "id": format!("{}-{}", buff_def_id, target.buffs.len() + 1),
        "buffDefId": buff_def_id,
        "name": "延迟爆发",
        "type": "debuff",
        "category": "skill",
        "sourceUnitId": actor.id,
        "remainingDuration": duration + 1,
        "stacks": 1,
        "maxStacks": 1,
        "delayedBurst": {
            "damage": damage,
            "damageType": damage_type,
            "element": element,
            "remainingRounds": duration,
        },
        "tags": ["delayed_burst"],
        "dispellable": true,
    }));
    Some(format!("延迟爆发（{duration}回合后）"))
}

fn apply_runtime_fate_swap_effect(
    actor: &mut BattleUnitDto,
    target: &mut BattleUnitDto,
    effect: &serde_json::Value,
) -> Option<String> {
    let swap_mode = effect.get("swapMode").and_then(serde_json::Value::as_str)?;
    if swap_mode != "shield_steal" {
        return None;
    }
    let rate = json_number_to_f64(effect.get("value"))?.clamp(0.0, 1.0);
    if rate <= 0.0 {
        return None;
    }
    let first_shield = target.shields.first_mut()?;
    let current = first_shield
        .get("value")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default()
        .max(0);
    if current <= 0 {
        return None;
    }
    let max_value = first_shield
        .get("maxValue")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(current)
        .max(current);
    let duration = first_shield
        .get("duration")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let absorb_type = first_shield
        .get("absorbType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("all")
        .to_string();
    let priority = first_shield
        .get("priority")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default();
    let stolen = ((current as f64) * rate).floor().max(1.0) as i64;
    let remaining = (current - stolen).max(0);
    if let Some(object) = first_shield.as_object_mut() {
        object.insert("value".to_string(), serde_json::json!(remaining));
        object.insert(
            "maxValue".to_string(),
            serde_json::json!((max_value - stolen).max(remaining)),
        );
    }
    target.shields.retain(|shield| {
        shield
            .get("value")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            > 0
    });
    actor.shields.push(serde_json::json!({
        "id": format!("fate-swap-shield-{}-{}", actor.id, actor.shields.len() + 1),
        "sourceSkillId": "",
        "value": stolen,
        "maxValue": stolen,
        "duration": duration,
        "absorbType": absorb_type,
        "priority": priority,
    }));
    Some(format!("夺取护盾 {stolen}"))
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
                    object.insert(
                        "remainingDuration".to_string(),
                        serde_json::json!(next_remaining),
                    );
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
                && mark.get("sourceUnitId").and_then(serde_json::Value::as_str)
                    == Some(attacker.id.as_str())
        })
        .map(|mark| {
            mark.get("stacks")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
        })
        .sum::<i64>();
    ((total_stacks as f64) * VOID_EROSION_DAMAGE_PER_STACK).min(VOID_EROSION_DAMAGE_BONUS_CAP)
}

fn apply_attr_value(attrs: &mut BattleUnitCurrentAttrsDto, attr: &str, value: f64) {
    match attr.trim() {
        "max_qixue" => attrs.max_qixue = (value.round() as i64).max(1),
        "max_lingqi" => attrs.max_lingqi = (value.round() as i64).max(0),
        "wugong" => attrs.wugong = value.round() as i64,
        "fagong" => attrs.fagong = value.round() as i64,
        "wufang" => attrs.wufang = value.round() as i64,
        "fafang" => attrs.fafang = value.round() as i64,
        "sudu" => attrs.sudu = (value.round() as i64).max(0),
        "qixue_huifu" => attrs.qixue_huifu = value.max(0.0),
        "lingqi_huifu" => attrs.lingqi_huifu = value.max(0.0),
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
        _ => {}
    }
}

fn normalized_rate(value: f64) -> f64 {
    value.max(0.0)
}

fn normalized_multiplier(value: f64) -> f64 {
    value.max(0.0)
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn next_runtime_random(state: &mut BattleStateDto) -> f64 {
    let seed = state.random_seed.wrapping_add(state.random_index) as u32;
    state.random_index += 1;

    let mut t = seed.wrapping_add(0x6D2B_79F5);
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
}

fn roll_runtime_chance(state: &mut BattleStateDto, chance: f64) -> bool {
    let clamped_chance = chance.clamp(0.0, 1.0);
    next_runtime_random(state) < clamped_chance
}

fn is_supported_runtime_control(control_type: &str) -> bool {
    matches!(
        control_type,
        "stun" | "freeze" | "silence" | "disarm" | "root" | "taunt" | "fear"
    )
}

fn is_hard_runtime_control(control_type: &str) -> bool {
    matches!(control_type, "stun" | "freeze" | "fear")
}

fn runtime_control_chance(effect: &serde_json::Value) -> f64 {
    effect
        .get("chance")
        .or_else(|| effect.get("successRate"))
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(1.0)
        .clamp(0.0, 1.0)
}

fn runtime_control_duration_after_diminishing(
    target: &mut BattleUnitDto,
    control_type: &str,
    base_duration: i64,
    round: i64,
) -> Option<i64> {
    let base_duration = base_duration.max(1);
    if !is_hard_runtime_control(control_type) {
        return Some(base_duration);
    }

    let key = "hard_control".to_string();
    let current = target
        .control_diminishing
        .get(key.as_str())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({"count": 0, "resetRound": 0}));
    let reset_round = current
        .get("resetRound")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or_default();
    let count = if reset_round <= round {
        0
    } else {
        current
            .get("count")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default()
            .max(0)
    };
    if count >= 3 {
        target.control_diminishing.insert(
            key,
            serde_json::json!({"count": count + 1, "resetRound": round + 3}),
        );
        return None;
    }
    let multiplier = match count {
        0 => 1.0,
        1 => 0.5,
        2 => 0.25,
        _ => 0.0,
    };
    target.control_diminishing.insert(
        key,
        serde_json::json!({"count": count + 1, "resetRound": round + 3}),
    );
    Some(((base_duration as f64) * multiplier).ceil().max(1.0) as i64)
}

fn apply_runtime_control_effect(
    state: &mut BattleStateDto,
    target_id: &str,
    source_unit_id: &str,
    effect: &serde_json::Value,
    round: i64,
) -> Result<Option<String>, String> {
    let control_type = effect
        .get("controlType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if control_type.is_empty() || !is_supported_runtime_control(control_type) {
        return Ok(None);
    }
    let resistance = unit_by_id(state, target_id)
        .map(|unit| normalized_rate(unit.current_attrs.kongzhi_kangxing).clamp(0.0, 1.0))
        .unwrap_or_default();
    let chance = runtime_control_chance(effect) * (1.0 - resistance);
    if !roll_runtime_chance(state, chance) {
        return Ok(None);
    }
    let duration = effect
        .get("duration")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let target = unit_by_id_mut(state, target_id).ok_or_else(|| "没有有效目标".to_string())?;
    let Some(duration) =
        runtime_control_duration_after_diminishing(target, control_type, duration, round)
    else {
        return Ok(None);
    };
    target.buffs.push(serde_json::json!({
        "id": format!("control-{}-{}", control_type, round),
        "buffDefId": format!("control-{}", control_type),
        "name": control_type,
        "type": "debuff",
        "category": "control",
        "sourceUnitId": source_unit_id,
        "remainingDuration": duration,
        "stacks": 1,
        "maxStacks": 1,
        "control": control_type,
        "tags": [control_type],
        "dispellable": true,
    }));
    Ok(Some(control_type.to_string()))
}

fn damage_type_defense(target: &BattleUnitDto, damage_type: &str) -> f64 {
    match damage_type {
        "magic" => target.current_attrs.fafang as f64,
        _ => target.current_attrs.wufang as f64,
    }
}

fn is_element_counter(attack_element: Option<&str>, defend_element: Option<&str>) -> bool {
    matches!(
        (
            attack_element.unwrap_or("none"),
            defend_element.unwrap_or("none")
        ),
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
                    object
                        .get("priority")
                        .and_then(serde_json::Value::as_i64)
                        .unwrap_or_default(),
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
        let current_value = shield
            .get("value")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or_default();
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

fn runtime_next_skill_bonus_rate(unit: &BattleUnitDto, bonus_type: &str) -> f64 {
    unit.buffs
        .iter()
        .filter_map(|buff| buff.get("nextSkillBonus"))
        .filter(|bonus| {
            let configured = bonus
                .get("bonusType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("all");
            configured == "all" || configured == bonus_type
        })
        .map(|bonus| json_number_to_f64(bonus.get("rate")).unwrap_or(0.0))
        .sum::<f64>()
        .max(0.0)
}

fn consume_runtime_next_skill_bonus(unit: &mut BattleUnitDto) {
    unit.buffs
        .retain(|buff| buff.get("nextSkillBonus").is_none());
    apply_runtime_attr_buffs(unit);
}

fn runtime_reflect_damage_rate(unit: &BattleUnitDto) -> f64 {
    unit.buffs
        .iter()
        .filter_map(|buff| {
            let reflect = buff.get("reflectDamage")?;
            let rate = json_number_to_f64(reflect.get("rate")).unwrap_or(0.0);
            let stacks = buff
                .get("stacks")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(1)
                .max(1);
            Some(rate * stacks as f64)
        })
        .sum::<f64>()
        .max(0.0)
}

fn build_runtime_reflect_damage_log(
    round: i64,
    defender: &BattleUnitDto,
    attacker: &BattleUnitDto,
    damage: i64,
    shield_absorbed: i64,
) -> serde_json::Value {
    serde_json::json!({
        "type": "action",
        "round": round,
        "actorId": defender.id,
        "actorName": defender.name,
        "skillId": format!("proc-{}-reflect-damage", defender.id),
        "skillName": "反弹伤害",
        "targets": [{
            "targetId": attacker.id,
            "targetName": attacker.name,
            "hits": [{
                "index": 1,
                "damage": damage.max(0),
                "isMiss": false,
                "isCrit": false,
                "isParry": false,
                "isElementBonus": false,
                "shieldAbsorbed": shield_absorbed.max(0),
            }],
            "damage": damage.max(0),
            "shieldAbsorbed": shield_absorbed.max(0),
        }]
    })
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
    if has_runtime_dodge_next(defender) {
        outcome.is_miss = true;
        return outcome;
    }
    let hit_rate = clamp_f64(
        normalized_rate(attacker.current_attrs.mingzhong)
            - normalized_rate(defender.current_attrs.shanbi),
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
    let parry_rate = clamp_f64(
        normalized_rate(defender.current_attrs.zhaojia),
        0.0,
        MAX_PARRY_RATE,
    );
    if roll_runtime_chance(state, parry_rate) {
        outcome.is_parry = true;
        damage *= PARRY_REDUCTION;
    }
    if damage_type != "true" {
        let crit_rate = clamp_f64(
            normalized_rate(attacker.current_attrs.baoji)
                - normalized_rate(defender.current_attrs.kangbao),
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
            let crit_multiplier =
                (capped_baoshang - normalized_rate(defender.current_attrs.jianbaoshang)).max(1.0);
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
    let resistance = clamp_f64(
        element_resistance(defender, element),
        0.0,
        MAX_ELEMENT_RESIST,
    );
    damage *= 1.0 - resistance;
    outcome.damage = damage.floor().max(1.0) as i64;
    outcome
}

fn apply_runtime_buff_effect(
    unit: &mut BattleUnitDto,
    actor: &BattleUnitDto,
    target_snapshot: &BattleUnitDto,
    skill: &serde_json::Value,
    source_unit_id: &str,
    effect_type: &str,
    effect: &serde_json::Value,
) -> Option<String> {
    let buff_kind = effect
        .get("buffKind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let buff_key = buff_effect_key(effect_type, effect);
    let duration = json_number_to_i64_floor(effect.get("duration"))
        .unwrap_or(1)
        .max(1);
    let stacks = json_number_to_i64_floor(effect.get("stacks"))
        .unwrap_or(1)
        .max(1);
    let mut buff_value = serde_json::json!({
        "id": buff_key,
        "buffDefId": buff_key,
        "name": buff_key,
        "type": effect_type,
        "category": "runtime",
        "sourceUnitId": source_unit_id,
        "remainingDuration": duration,
        "stacks": stacks,
        "maxStacks": stacks,
        "tags": [],
        "dispellable": true,
    });
    match buff_kind {
        "attr" => {
            let attr_key = effect
                .get("attrKey")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if attr_key.trim().is_empty() {
                return None;
            }
            let mode = effect
                .get("applyType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("flat");
            let raw_value = json_number_to_f64(effect.get("value")).unwrap_or(0.0);
            let value = if effect_type == "debuff" {
                -raw_value
            } else {
                raw_value
            };
            buff_value["attrModifiers"] = serde_json::json!([{
                "attr": attr_key,
                "value": value,
                "mode": mode,
            }]);
        }
        "dot" => {
            let skill_damage_type = skill
                .get("damageType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("physical");
            let default_scale_attr = if skill_damage_type == "magic" {
                "fagong"
            } else {
                "wugong"
            };
            let damage =
                resolve_effect_base_value(actor, target_snapshot, effect, default_scale_attr)
                    .max(1);
            buff_value["dot"] = serde_json::json!({
                "damage": damage,
                "damageType": if skill_damage_type == "magic" { "magic" } else { "physical" },
                "element": skill.get("element").and_then(serde_json::Value::as_str).unwrap_or("none"),
            });
        }
        "hot" => {
            let heal = resolve_effect_base_value(actor, target_snapshot, effect, "fagong").max(1);
            buff_value["hot"] = serde_json::json!({ "heal": heal });
        }
        "dodge_next" => {
            buff_value["dodgeNext"] = serde_json::json!({ "guaranteedMiss": true });
        }
        "reflect_damage" => {
            let rate = json_number_to_f64(effect.get("value"))
                .unwrap_or(0.0)
                .max(0.0);
            if rate <= 0.0 {
                return None;
            }
            buff_value["reflectDamage"] = serde_json::json!({ "rate": rate });
        }
        "heal_forbid" => {
            buff_value["healForbidden"] = serde_json::json!(true);
        }
        "next_skill_bonus" => {
            let rate = json_number_to_f64(effect.get("value"))
                .unwrap_or(0.0)
                .max(0.0);
            if rate <= 0.0 {
                return None;
            }
            buff_value["nextSkillBonus"] = serde_json::json!({
                "rate": rate,
                "bonusType": effect.get("bonusType").and_then(serde_json::Value::as_str).unwrap_or("all"),
            });
        }
        "aura" => {
            let aura_target = effect
                .get("auraTarget")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("self");
            let aura_effects = effect
                .get("auraEffects")
                .and_then(serde_json::Value::as_array)?
                .iter()
                .filter_map(|sub| {
                    let sub_type = sub
                        .get("type")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| matches!(*value, "buff" | "debuff"))?;
                    let attr_key = sub.get("attrKey").and_then(serde_json::Value::as_str)?;
                    if attr_key.trim().is_empty() {
                        return None;
                    }
                    let sub_buff_key = buff_effect_key(sub_type, sub);
                    let mode = sub
                        .get("applyType")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("flat");
                    let raw_value = json_number_to_f64(sub.get("value")).unwrap_or(0.0);
                    let value = if sub_type == "debuff" {
                        -raw_value
                    } else {
                        raw_value
                    };
                    Some(serde_json::json!({
                        "type": sub_type,
                        "buffDefId": sub_buff_key,
                        "attrModifiers": [{
                            "attr": attr_key,
                            "value": value,
                            "mode": mode,
                        }],
                        "duration": 1,
                    }))
                })
                .collect::<Vec<_>>();
            if aura_effects.is_empty() {
                return None;
            }
            buff_value["type"] = serde_json::json!("buff");
            buff_value["remainingDuration"] = serde_json::json!(-1);
            buff_value["dispellable"] = serde_json::json!(false);
            buff_value["aura"] = serde_json::json!({
                "auraTarget": aura_target,
                "effects": aura_effects,
                "damageType": skill.get("damageType").and_then(serde_json::Value::as_str).unwrap_or("physical"),
                "element": skill.get("element").and_then(serde_json::Value::as_str).unwrap_or("none"),
            });
        }
        _ => return None,
    }
    unit.buffs
        .retain(|buff| buff.get("buffDefId") != Some(&serde_json::json!(buff_key)));
    unit.buffs.push(buff_value);
    apply_runtime_attr_buffs(unit);
    Some(buff_key)
}

fn process_runtime_phase_triggers_before_action(
    state: &mut BattleStateDto,
    actor_id: &str,
    logs: &mut Vec<serde_json::Value>,
) -> Result<(), String> {
    let action_round = state.round_count.max(1);
    let Some(unit) = unit_by_id(state, actor_id).cloned() else {
        return Err("当前不可行动".to_string());
    };
    if unit.r#type != "monster" && unit.r#type != "summon" {
        return Ok(());
    }
    let Some(phase_triggers) = unit
        .ai_profile
        .as_ref()
        .and_then(|profile| profile.get("phaseTriggers"))
        .and_then(serde_json::Value::as_array)
        .cloned()
    else {
        return Ok(());
    };
    let max_qixue = unit.current_attrs.max_qixue.max(1) as f64;
    let current_hp_percent = (unit.qixue.max(0) as f64) / max_qixue;
    for trigger in phase_triggers {
        let Some(trigger_id) = trigger
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if unit_by_id(state, actor_id)
            .map(|actor_unit| {
                actor_unit
                    .triggered_phase_ids
                    .iter()
                    .any(|value| value == trigger_id)
            })
            .unwrap_or(true)
        {
            continue;
        }
        let Some(hp_percent) = trigger.get("hpPercent").and_then(serde_json::Value::as_f64) else {
            continue;
        };
        let Some(action) = trigger
            .get("action")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if current_hp_percent > hp_percent {
            continue;
        }
        if action == "enrage" {
            let mut buffs_applied = Vec::new();
            if let Some(effects) = trigger.get("effects").and_then(serde_json::Value::as_array) {
                for effect in effects {
                    let Some(effect_type) = effect
                        .get("type")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| matches!(*value, "buff" | "debuff"))
                    else {
                        continue;
                    };
                    let actor_snapshot = unit_by_id(state, actor_id).cloned();
                    if let (Some(actor_snapshot), Some(actor_unit)) =
                        (actor_snapshot, unit_by_id_mut(state, actor_id))
                    {
                        let empty_skill = serde_json::json!({});
                        if let Some(buff_key) = apply_runtime_buff_effect(
                            actor_unit,
                            &actor_snapshot,
                            &actor_snapshot,
                            &empty_skill,
                            actor_id,
                            effect_type,
                            effect,
                        ) {
                            buffs_applied.push(buff_key);
                        }
                    }
                }
            }
            if let Some(actor_unit) = unit_by_id_mut(state, actor_id) {
                actor_unit.triggered_phase_ids.push(trigger_id.to_string());
                let target_logs = vec![RuntimeResolvedTargetLog {
                    target_id: actor_unit.id.clone(),
                    target_name: actor_unit.name.clone(),
                    damage: 0,
                    heal: 0,
                    shield: 0,
                    resources: Vec::new(),
                    buffs_applied,
                    is_miss: false,
                    is_crit: false,
                    is_parry: false,
                    is_element_bonus: false,
                    shield_absorbed: 0,
                    momentum_gained: Vec::new(),
                    momentum_consumed: Vec::new(),
                }];
                logs.push(build_runtime_phase_action_log(
                    action_round,
                    actor_unit.id.as_str(),
                    actor_unit.name.as_str(),
                    &format!("proc-phase-enrage-{trigger_id}"),
                    "阶段触发·狂暴",
                    &target_logs,
                ));
            }
            continue;
        }
        if action != "summon" {
            continue;
        }
        let Some(summon_count) = trigger
            .get("summonCount")
            .and_then(|value| json_number_to_i64_floor(Some(value)))
            .filter(|value| *value >= 1)
        else {
            continue;
        };
        let Some(summon_template) = trigger.get("summonTemplate") else {
            continue;
        };
        let Some(template) = runtime_summon_template_from_json(summon_template) else {
            continue;
        };
        let Some(actor_team_key) = unit_team_key(state, actor_id) else {
            return Err("当前不可行动".to_string());
        };
        let mut target_logs = Vec::new();
        {
            let team_units = team_units_mut(state, actor_team_key);
            let Some(actor_index) = team_units
                .iter()
                .position(|team_unit| team_unit.id == actor_id)
            else {
                return Err("当前不可行动".to_string());
            };
            let existing_summon_count = team_units
                .iter()
                .filter(|team_unit| team_unit.r#type == "summon")
                .count() as i64;
            let mut summoned_units = Vec::new();
            for summon_offset in 1..=summon_count {
                let summon_sequence = existing_summon_count + summon_offset;
                let summon_unit =
                    build_runtime_summon_unit(&template, actor_id, action_round, summon_sequence);
                target_logs.push(RuntimeResolvedTargetLog {
                    target_id: summon_unit.id.clone(),
                    target_name: summon_unit.name.clone(),
                    damage: 0,
                    heal: 0,
                    shield: 0,
                    resources: Vec::new(),
                    buffs_applied: Vec::new(),
                    is_miss: false,
                    is_crit: false,
                    is_parry: false,
                    is_element_bonus: false,
                    shield_absorbed: 0,
                    momentum_gained: Vec::new(),
                    momentum_consumed: Vec::new(),
                });
                summoned_units.push(summon_unit);
            }
            team_units[actor_index]
                .triggered_phase_ids
                .push(trigger_id.to_string());
            team_units.extend(summoned_units);
        }
        refresh_battle_team_total_speed(state);
        logs.push(build_runtime_phase_action_log(
            action_round,
            unit.id.as_str(),
            unit.name.as_str(),
            &format!("proc-phase-summon-{trigger_id}"),
            "阶段触发·召唤",
            &target_logs,
        ));
    }
    Ok(())
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
        if unit.skills.iter().any(|skill| {
            skill.get("id").and_then(serde_json::Value::as_str) == Some(preferred_skill_id)
        }) && can_use_runtime_skill_now(state, actor_id, preferred_skill_id)
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
            let enabled = slot
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            if !enabled {
                return None;
            }
            let priority = slot
                .get("priority")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(i64::MAX);
            Some((priority, skill_id))
        })
        .collect::<Vec<_>>();
    let mut ordered_policy_skills = ordered_policy_skills;
    ordered_policy_skills
        .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
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
    process_runtime_phase_triggers_before_action(state, actor_id, logs)?;
    if state.phase == "finished" {
        return Ok(());
    }
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
    logs.extend(execute_runtime_skill_action(
        state,
        actor_id,
        skill_id.as_str(),
        &target_ids,
    )?);
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
                if !target.resources.is_empty() {
                    object.insert(
                        "resources".to_string(),
                        serde_json::json!(target.resources),
                    );
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

fn build_runtime_phase_action_log(
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
                "hits": [],
            });
            if let Some(object) = target_value.as_object_mut() {
                if !target.buffs_applied.is_empty() {
                    object.insert(
                        "buffsApplied".to_string(),
                        serde_json::json!(target.buffs_applied),
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
    let skill_target_count = target_count_from_value(&skill);
    let effects = skill
        .get("effects")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let damage_effects = effects
        .iter()
        .cloned()
        .filter(|effect| {
            effect.get("type").and_then(serde_json::Value::as_str)
                == Some(RUNTIME_DAMAGE_EFFECT_TYPE)
        })
        .collect::<Vec<_>>();
    let mut effect_context = RuntimeSkillEffectContext::default();
    let mut pending_actor_momentum = actor.momentum.clone();
    let mut momentum_gain_effects = Vec::new();
    for effect in effects
        .iter()
        .filter(|effect| effect.get("type").and_then(serde_json::Value::as_str) == Some("momentum"))
    {
        let operation = effect
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "momentum operation 缺失".to_string())?;
        match operation {
            "consume" => {
                process_runtime_skill_momentum_effect(
                    &mut pending_actor_momentum,
                    effect,
                    &mut effect_context,
                )?;
            }
            "gain" => momentum_gain_effects.push(effect),
            _ => return Err(format!("momentum operation 不支持: {operation}")),
        }
    }

    let mut target_logs = Vec::new();
    let mut logs = Vec::new();
    let actor_next_skill_damage_bonus = runtime_next_skill_bonus_rate(&actor, "damage");
    process_runtime_set_bonus_trigger(state, "on_skill", actor_id, None, 0, &mut logs);
    let should_resolve_damage_targets = !damage_effects.is_empty()
        || matches!(
            skill_id.trim(),
            "skill-normal-attack" | "sk-heavy-slash" | "sk-bite"
        );
    if should_resolve_damage_targets {
        for target_id in &target_ids {
            let target_snapshot = unit_by_id(state, target_id.as_str())
                .cloned()
                .ok_or_else(|| "目标不存在或已死亡".to_string())?;
            if !target_snapshot.is_alive {
                continue;
            }
            let mut total_damage = 0;
            if damage_effects.is_empty() {
                if matches!(
                    skill_id.trim(),
                    "skill-normal-attack" | "sk-heavy-slash" | "sk-bite"
                ) {
                    total_damage = apply_runtime_rate_bonus(
                        resolve_runtime_skill_damage(state, actor_id, skill_id).max(0),
                        effect_context.damage_bonus_rate + actor_next_skill_damage_bonus,
                    );
                }
            } else {
                for effect in &damage_effects {
                    let damage_type = effect
                        .get("damageType")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| skill.get("damageType").and_then(serde_json::Value::as_str))
                        .unwrap_or("physical");
                    let default_scale_attr = if damage_type == "magic" {
                        "fagong"
                    } else {
                        "wugong"
                    };
                    let effect_base_damage = resolve_effect_base_value(
                        &actor,
                        &target_snapshot,
                        effect,
                        default_scale_attr,
                    )
                    .max(0);
                    total_damage += apply_runtime_rate_bonus(
                        effect_base_damage,
                        effect_context.damage_bonus_rate + actor_next_skill_damage_bonus,
                    );
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
                    (
                        actual_damage,
                        !target.is_alive,
                        target_name,
                        shield_absorbed,
                    )
                } else {
                    (0, false, target_name, 0)
                }
            };
            if damage_outcome.is_miss {
                if let Some(target) = unit_by_id_mut(state, target_id.as_str()) {
                    consume_runtime_dodge_next_buff(target);
                }
            }
            if actual_damage > 0 {
                process_runtime_set_bonus_trigger(
                    state,
                    "on_hit",
                    actor_id,
                    Some(target_id.as_str()),
                    actual_damage,
                    &mut logs,
                );
                process_runtime_set_bonus_trigger(
                    state,
                    "on_be_hit",
                    target_id.as_str(),
                    Some(actor_id),
                    actual_damage,
                    &mut logs,
                );
                if damage_outcome.is_crit {
                    process_runtime_set_bonus_trigger(
                        state,
                        "on_crit",
                        actor_id,
                        Some(target_id.as_str()),
                        actual_damage,
                        &mut logs,
                    );
                }
                let defender_snapshot = unit_by_id(state, target_id.as_str()).cloned();
                if let Some(defender_snapshot) = defender_snapshot {
                    let reflect_rate = runtime_reflect_damage_rate(&defender_snapshot);
                    if reflect_rate > 0.0 {
                        let reflect_damage =
                            ((actual_damage as f64) * reflect_rate).floor().max(0.0) as i64;
                        if reflect_damage > 0 {
                            let (reflected, reflected_shield_absorbed, attacker_snapshot) = {
                                let attacker = unit_by_id_mut(state, actor_id)
                                    .ok_or_else(|| "当前不可行动".to_string())?;
                                let (reflected, reflected_shield_absorbed) =
                                    apply_runtime_damage_to_target(
                                        attacker,
                                        reflect_damage,
                                        "true",
                                    );
                                (reflected, reflected_shield_absorbed, attacker.clone())
                            };
                            logs.push(build_runtime_reflect_damage_log(
                                action_round,
                                &defender_snapshot,
                                &attacker_snapshot,
                                reflected,
                                reflected_shield_absorbed,
                            ));
                        }
                    }
                }
            }
            target_logs.push(RuntimeResolvedTargetLog {
                target_id: target_id.to_string(),
                target_name: target_name.clone(),
                damage: actual_damage,
                heal: 0,
                shield: 0,
                resources: Vec::new(),
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
    }
    if actor_next_skill_damage_bonus > 0.0 {
        if let Some(actor_unit) = unit_by_id_mut(state, actor_id) {
            consume_runtime_next_skill_bonus(actor_unit);
        }
    }
    let lifesteal_rate = effects
        .iter()
        .filter(|effect| {
            effect.get("type").and_then(serde_json::Value::as_str) == Some("lifesteal")
        })
        .map(|effect| json_number_to_f64(effect.get("value")).unwrap_or(0.0))
        .sum::<f64>()
        .max(0.0);
    if lifesteal_rate > 0.0 {
        for target_log in &target_logs {
            let heal_value = ((target_log.damage.max(0) as f64) * lifesteal_rate)
                .floor()
                .max(0.0) as i64;
            if heal_value <= 0 {
                continue;
            }
            let actor_unit =
                unit_by_id_mut(state, actor_id).ok_or_else(|| "当前不可行动".to_string())?;
            let healed = apply_runtime_healing(actor_unit, heal_value);
            if healed > 0 {
                actor_unit.stats.healing_done += healed;
            }
        }
    }
    for effect in effects.iter().filter(|effect| {
        effect
            .get("type")
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_runtime_main_loop_non_damage_effect_type)
    }) {
        let effect_type = effect
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let effect_target_ids = resolve_effect_target_ids(
            state,
            actor_id,
            &target_ids,
            selected_target_ids,
            skill_target_type.as_str(),
            skill_target_count,
            effect,
        )?;
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
                    let heal_value = apply_runtime_rate_bonus(
                        resolve_effect_base_value(&actor, &target_snapshot, effect, "fagong")
                            .max(0),
                        effect_context.heal_bonus_rate,
                    );
                    let heal_value =
                        ((heal_value as f64) * (1.0 + actor.current_attrs.zhiliao)).floor() as i64;
                    let heal_value = ((heal_value as f64)
                        * (1.0 - target_snapshot.current_attrs.jianliao))
                        .floor() as i64;
                    if heal_value > 0 {
                        let healed = {
                            let target = unit_by_id_mut(state, effect_target_id.as_str())
                                .ok_or_else(|| "没有有效目标".to_string())?;
                            apply_runtime_healing(target, heal_value)
                        };
                        if healed > 0 {
                            if let Some(actor_unit) = unit_by_id_mut(state, actor_id) {
                                actor_unit.stats.healing_done += healed;
                            }
                            log_entry.heal += healed;
                            process_runtime_set_bonus_trigger(
                                state,
                                "on_heal",
                                actor_id,
                                Some(effect_target_id.as_str()),
                                healed,
                                &mut logs,
                            );
                        }
                    }
                }
                "restore_lingqi" => {
                    let restore_value = apply_runtime_rate_bonus(
                        json_number_to_i64_floor(effect.get("value"))
                            .unwrap_or_default()
                            .max(0),
                        effect_context.resource_bonus_rate,
                    );
                    if restore_value > 0 {
                        let target = unit_by_id_mut(state, effect_target_id.as_str())
                            .ok_or_else(|| "没有有效目标".to_string())?;
                        let effective_restore =
                            apply_runtime_recovery_reduction(restore_value, target);
                        target.lingqi = (target.lingqi + effective_restore)
                            .min(target.current_attrs.max_lingqi.max(0));
                        push_runtime_resource_log(log_entry, "lingqi", effective_restore);
                    }
                }
                "resource" => {
                    let resource_type = effect
                        .get("resourceType")
                        .or_else(|| effect.get("resource_type"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("lingqi");
                    let delta = effect
                        .get("value")
                        .and_then(|value| json_number_to_i64_floor(Some(value)))
                        .unwrap_or_default();
                    let adjusted_delta = if delta > 0 {
                        apply_runtime_rate_bonus(delta, effect_context.resource_bonus_rate)
                    } else {
                        delta
                    };
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if resource_type == "qixue" {
                        if adjusted_delta > 0 {
                            target.qixue = (target.qixue + adjusted_delta)
                                .min(target.current_attrs.max_qixue.max(1));
                        } else {
                            target.qixue = (target.qixue + adjusted_delta)
                                .clamp(0, target.current_attrs.max_qixue.max(1));
                        }
                        push_runtime_resource_log(log_entry, "qixue", adjusted_delta.abs());
                    } else {
                        let effective_delta = if adjusted_delta > 0 {
                            apply_runtime_recovery_reduction(adjusted_delta, target)
                        } else {
                            adjusted_delta
                        };
                        target.lingqi = (target.lingqi + effective_delta)
                            .clamp(0, target.current_attrs.max_lingqi.max(0));
                        push_runtime_resource_log(log_entry, "lingqi", effective_delta.abs());
                    }
                }
                "shield" => {
                    let shield_value = apply_runtime_rate_bonus(
                        resolve_effect_base_value(&actor, &target_snapshot, effect, "fagong")
                            .max(0),
                        effect_context.shield_bonus_rate,
                    );
                    if shield_value > 0 {
                        let target = unit_by_id_mut(state, effect_target_id.as_str())
                            .ok_or_else(|| "没有有效目标".to_string())?;
                        target.shields.push(serde_json::json!({
                            "id": format!("shield-{}-{}", effect_target_id, action_round),
                            "sourceSkillId": skill_id,
                            "value": shield_value,
                            "maxValue": shield_value,
                            "duration": json_number_to_i64_floor(effect.get("duration")).unwrap_or(1),
                            "absorbType": "all",
                            "priority": 0,
                        }));
                        log_entry.shield += shield_value;
                    }
                }
                "buff" | "debuff" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if let Some(buff_key) = apply_runtime_buff_effect(
                        target,
                        &actor,
                        &target_snapshot,
                        &skill,
                        actor_id,
                        effect_type,
                        effect,
                    ) {
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &buff_key)
                        {
                            log_entry.buffs_applied.push(buff_key);
                        }
                    }
                }
                "control" => {
                    if let Some(control_type) = apply_runtime_control_effect(
                        state,
                        effect_target_id.as_str(),
                        actor_id,
                        effect,
                        action_round,
                    )? {
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &control_type)
                        {
                            log_entry.buffs_applied.push(control_type);
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
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &buff_name)
                        {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "cleanse_control" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    let removed = remove_runtime_buffs_by_predicate(target, |buff| {
                        buff.get("control")
                            .and_then(serde_json::Value::as_str)
                            .is_some()
                    });
                    for buff_name in removed {
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &buff_name)
                        {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "dispel" => {
                    let dispel_type = effect
                        .get("dispelType")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("all");
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    let removed =
                        remove_runtime_buffs_by_predicate(target, |buff| match dispel_type {
                            "buff" => {
                                buff.get("type").and_then(serde_json::Value::as_str) == Some("buff")
                            }
                            "debuff" => {
                                buff.get("type").and_then(serde_json::Value::as_str)
                                    == Some("debuff")
                            }
                            _ => true,
                        });
                    for buff_name in removed {
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &buff_name)
                        {
                            log_entry.buffs_applied.push(buff_name);
                        }
                    }
                }
                "mark" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if let Some(mark_id) = apply_runtime_mark_effect(target, actor_id, effect) {
                        if !log_entry
                            .buffs_applied
                            .iter()
                            .any(|entry| entry == &mark_id)
                        {
                            log_entry.buffs_applied.push(mark_id);
                        }
                    }
                }
                "delayed_burst" => {
                    let target = unit_by_id_mut(state, effect_target_id.as_str())
                        .ok_or_else(|| "没有有效目标".to_string())?;
                    if let Some(text) =
                        apply_runtime_delayed_burst_effect(target, &actor, skill_id, &skill, effect)
                    {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &text) {
                            log_entry.buffs_applied.push(text);
                        }
                    }
                }
                "fate_swap" => {
                    let actor_team_is_attacker = state
                        .teams
                        .attacker
                        .units
                        .iter()
                        .any(|unit| unit.id == actor_id);
                    let text = if actor_team_is_attacker {
                        let actor_index = state
                            .teams
                            .attacker
                            .units
                            .iter()
                            .position(|unit| unit.id == actor_id);
                        let target_index = state
                            .teams
                            .defender
                            .units
                            .iter()
                            .position(|unit| unit.id == effect_target_id);
                        match (actor_index, target_index) {
                            (Some(actor_index), Some(target_index)) => {
                                let actor_unit = &mut state.teams.attacker.units[actor_index];
                                let target_unit = &mut state.teams.defender.units[target_index];
                                apply_runtime_fate_swap_effect(actor_unit, target_unit, effect)
                            }
                            _ => None,
                        }
                    } else {
                        let actor_index = state
                            .teams
                            .defender
                            .units
                            .iter()
                            .position(|unit| unit.id == actor_id);
                        let target_index = state
                            .teams
                            .attacker
                            .units
                            .iter()
                            .position(|unit| unit.id == effect_target_id);
                        match (actor_index, target_index) {
                            (Some(actor_index), Some(target_index)) => {
                                let actor_unit = &mut state.teams.defender.units[actor_index];
                                let target_unit = &mut state.teams.attacker.units[target_index];
                                apply_runtime_fate_swap_effect(actor_unit, target_unit, effect)
                            }
                            _ => None,
                        }
                    };
                    if let Some(text) = text {
                        if !log_entry.buffs_applied.iter().any(|entry| entry == &text) {
                            log_entry.buffs_applied.push(text);
                        }
                    }
                }
                "lifesteal" | "momentum" => {}
                _ => {}
            }
        }
    }
    for effect in momentum_gain_effects {
        process_runtime_skill_momentum_effect(
            &mut pending_actor_momentum,
            effect,
            &mut effect_context,
        )?;
    }
    process_runtime_set_bonus_trigger(state, "after_skill", actor_id, None, 0, &mut logs);
    if !effect_context.momentum_gained.is_empty() || !effect_context.momentum_consumed.is_empty() {
        if let Some(target_log) = target_logs.first_mut() {
            if !effect_context.momentum_gained.is_empty() {
                target_log.momentum_gained = effect_context.momentum_gained.clone();
            }
            if !effect_context.momentum_consumed.is_empty() {
                target_log.momentum_consumed = effect_context.momentum_consumed.clone();
            }
        }
    }
    if target_logs.is_empty() {
        return Err("没有可攻击目标".to_string());
    }
    if pending_actor_momentum != actor.momentum {
        let actor_unit =
            unit_by_id_mut(state, actor_id).ok_or_else(|| "当前不可行动".to_string())?;
        actor_unit.momentum = pending_actor_momentum;
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
        let actor_id = state
            .current_unit_id
            .clone()
            .ok_or_else(|| "当前不可行动".to_string())?;
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
    run_attacker_auto_turns_until_owner_or_switch(
        state,
        placeholder_owner_actor_id.as_str(),
        &mut logs,
    )?;
    if state.current_team != "attacker" {
        return Err("当前不是我方行动回合".to_string());
    }
    let current_actor_id = state
        .current_unit_id
        .clone()
        .ok_or_else(|| "当前不可行动".to_string())?;
    let current_actor =
        unit_by_id(state, current_actor_id.as_str()).ok_or_else(|| "当前不可行动".to_string())?;
    if current_actor.r#type != "player" {
        return Err("当前不可行动".to_string());
    }
    resolve_unit_skill_name(current_actor, skill_id)?;
    consume_runtime_skill_cost_and_validate_cooldown(state, current_actor_id.as_str(), skill_id)?;
    logs.extend(execute_runtime_skill_action(
        state,
        current_actor_id.as_str(),
        skill_id,
        target_ids,
    )?);
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
    let current_actor =
        unit_by_id(state, expected_actor_id.as_str()).ok_or_else(|| "当前不可行动".to_string())?;
    resolve_unit_skill_name(current_actor, skill_id)?;
    consume_runtime_skill_cost_and_validate_cooldown(state, &expected_actor_id, skill_id)?;
    let mut logs =
        execute_runtime_skill_action(state, expected_actor_id.as_str(), skill_id, target_ids)?;
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
        BattleCharacterUnitProfile, BattleUnitCurrentAttrsDto, DEFENSE_DAMAGE_K, MAX_ROUNDS_PVE,
        MinimalBattleRewardParticipant, MinimalPveItemRewardResolveOptions,
        apply_character_profile_to_battle_state, apply_minimal_pve_action,
        apply_minimal_pvp_action, build_minimal_pve_battle_state, build_minimal_pvp_battle_state,
        build_skill_value, determine_first_mover, process_round_end_and_start_next_round,
        process_round_start, refresh_battle_team_total_speed, resolve_minimal_pve_item_rewards,
        restart_battle_runtime, start_battle_runtime,
    };

    fn runtime_supported_skill_effect_types() -> std::collections::BTreeSet<&'static str> {
        super::RUNTIME_SUPPORTED_SKILL_EFFECT_TYPES
            .into_iter()
            .collect()
    }

    fn assert_rate_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected {actual} to equal {expected}"
        );
    }

    #[test]
    fn runtime_random_matches_node_mulberry32_sequence() {
        let mut state =
            build_minimal_pve_battle_state("rng-sequence", 1, &["monster-wild-rabbit".to_string()]);
        state.random_seed = 123456;
        state.random_index = 0;

        let rolls = vec![
            super::next_runtime_random(&mut state),
            super::next_runtime_random(&mut state),
            super::next_runtime_random(&mut state),
            super::next_runtime_random(&mut state),
        ];

        let expected = vec![
            0.38233304349705577,
            0.39825971820391715,
            0.8622671910561621,
            0.9009416962508112,
        ];
        for (actual, expected) in rolls.into_iter().zip(expected) {
            assert!(
                (actual - expected).abs() < 0.000_000_000_001,
                "expected {actual} to equal {expected}"
            );
        }
        assert_eq!(state.random_index, 4);
    }

    #[test]
    fn runtime_random_alive_unit_ids_uses_node_shuffle_order() {
        let mut state = build_minimal_pve_battle_state(
            "random-targets",
            1,
            &[
                "monster-wild-rabbit".to_string(),
                "monster-wild-boar".to_string(),
                "monster-gray-wolf".to_string(),
            ],
        );
        state.random_seed = 123456;
        state.random_index = 0;

        let selected = super::random_alive_unit_ids(&mut state, "defender", 2);

        assert_eq!(
            selected,
            vec![
                "monster-2-monster-wild-boar".to_string(),
                "monster-3-monster-gray-wolf".to_string(),
            ]
        );
        assert_eq!(state.random_index, 2);
    }

    #[test]
    fn runtime_random_alive_unit_ids_returns_all_without_random_when_count_covers_candidates() {
        let mut state = build_minimal_pve_battle_state(
            "random-targets-all",
            1,
            &[
                "monster-wild-rabbit".to_string(),
                "monster-wild-boar".to_string(),
            ],
        );
        state.random_seed = 123456;
        state.random_index = 7;

        let selected = super::random_alive_unit_ids(&mut state, "defender", 2);

        assert_eq!(
            selected,
            vec![
                "monster-1-monster-wild-rabbit".to_string(),
                "monster-2-monster-wild-boar".to_string(),
            ]
        );
        assert_eq!(state.random_index, 7);
    }

    #[test]
    fn runtime_roll_chance_consumes_random_at_clamped_bounds() {
        let mut state = build_minimal_pve_battle_state(
            "roll-chance-bounds",
            1,
            &["monster-wild-rabbit".to_string()],
        );
        state.random_seed = 123456;
        state.random_index = 0;

        assert!(!super::roll_runtime_chance(&mut state, -0.5));
        assert_eq!(state.random_index, 1);
        assert!(super::roll_runtime_chance(&mut state, 1.5));
        assert_eq!(state.random_index, 2);
    }

    #[test]
    fn monster_seed_fractional_rates_survive_runtime_attrs() {
        let seed = super::MonsterSeed {
            id: Some("monster-fractional-rates".to_string()),
            name: Some("小数率怪".to_string()),
            realm: Some("凡人".to_string()),
            kind: Some("normal".to_string()),
            element: Some("mu".to_string()),
            level: None,
            exp_reward: None,
            silver_reward_min: None,
            base_attrs: Some(super::MonsterBaseAttrs {
                qixue: Some(100),
                max_qixue: None,
                lingqi: Some(30),
                max_lingqi: None,
                wugong: Some(10),
                fagong: Some(8),
                wufang: Some(4),
                fafang: Some(3),
                sudu: Some(5),
                mingzhong: Some(serde_json::json!(0.85)),
                shanbi: Some(serde_json::json!(0.12)),
                zhaojia: Some(serde_json::json!(0.07)),
                baoji: Some(serde_json::json!(0.08)),
                baoshang: Some(serde_json::json!(1.5)),
                jianbaoshang: Some(serde_json::json!(0.04)),
                jianfantan: Some(serde_json::json!(0.03)),
                kangbao: Some(serde_json::json!(0.02)),
                zengshang: Some(serde_json::json!(0.11)),
                zhiliao: Some(serde_json::json!(0.09)),
                jianliao: Some(serde_json::json!(0.06)),
                xixue: Some(serde_json::json!(0.05)),
                lengque: Some(serde_json::json!(0.04)),
                kongzhi_kangxing: Some(serde_json::json!(0.13)),
                jin_kangxing: Some(serde_json::json!(0.01)),
                mu_kangxing: Some(serde_json::json!(0.02)),
                shui_kangxing: Some(serde_json::json!(0.03)),
                huo_kangxing: Some(serde_json::json!(0.04)),
                tu_kangxing: Some(serde_json::json!(0.05)),
                qixue_huifu: Some(serde_json::json!(2.25)),
                lingqi_huifu: Some(serde_json::json!(3.15)),
            }),
            ai_profile: None,
            drop_pool_id: None,
            enabled: Some(true),
        };

        let attrs = super::build_monster_battle_attrs(&seed);

        assert_rate_close(attrs.mingzhong as f64, 0.85);
        assert_rate_close(attrs.shanbi as f64, 0.12);
        assert_rate_close(attrs.baoji as f64, 0.08);
        assert_rate_close(attrs.baoshang as f64, 1.5);
        assert_rate_close(attrs.zengshang as f64, 0.11);
        assert_rate_close(attrs.kongzhi_kangxing as f64, 0.13);
        assert_rate_close(attrs.qixue_huifu as f64, 2.25);
        assert_rate_close(attrs.lingqi_huifu as f64, 3.15);
    }

    #[test]
    fn battle_attrs_from_json_defaults_mingzhong_and_other_rates() {
        let base_attrs = serde_json::json!({
            "max_qixue": 180,
            "max_lingqi": 100,
            "wugong": 32,
            "fagong": 0,
            "wufang": 12,
            "fafang": 8,
            "sudu": 10
        });

        let attrs = super::battle_attrs_from_json(&base_attrs).expect("attrs should parse");

        assert_rate_close(attrs.mingzhong, 1.0);
        assert_rate_close(attrs.shanbi, 0.0);
        assert_rate_close(attrs.zhaojia, 0.0);
        assert_rate_close(attrs.baoji, 0.0);
        assert_rate_close(attrs.baoshang, 0.0);
        assert_rate_close(attrs.jianbaoshang, 0.0);
        assert_rate_close(attrs.kangbao, 0.0);
        assert_rate_close(attrs.zengshang, 0.0);
        assert_rate_close(attrs.kongzhi_kangxing, 0.0);
        assert_rate_close(attrs.jin_kangxing, 0.0);
        assert_rate_close(attrs.tu_kangxing, 0.0);
        assert_rate_close(attrs.qixue_huifu, 0.0);
        assert_rate_close(attrs.lingqi_huifu, 0.0);
    }

    #[test]
    fn battle_attrs_from_json_preserves_fractional_recovery_attrs() {
        let base_attrs = serde_json::json!({
            "max_qixue": 180,
            "max_lingqi": 100,
            "wugong": 32,
            "fagong": 0,
            "wufang": 12,
            "fafang": 8,
            "sudu": 10,
            "qixue_huifu": 0.2,
            "lingqi_huifu": 0.15
        });

        let attrs = super::battle_attrs_from_json(&base_attrs).expect("attrs should parse");

        assert_rate_close(attrs.qixue_huifu, 0.2);
        assert_rate_close(attrs.lingqi_huifu, 0.15);
    }

    #[test]
    fn rust_runtime_declares_all_node_skill_effect_types_supported() {
        let expected = [
            "damage",
            "heal",
            "shield",
            "buff",
            "debuff",
            "dispel",
            "resource",
            "restore_lingqi",
            "cleanse",
            "cleanse_control",
            "lifesteal",
            "control",
            "mark",
            "momentum",
            "delayed_burst",
            "fate_swap",
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(runtime_supported_skill_effect_types(), expected);
    }

    #[test]
    fn rust_runtime_main_skill_loop_includes_all_supported_non_damage_effects() {
        let supported = runtime_supported_skill_effect_types();
        let main_loop = super::RUNTIME_MAIN_LOOP_NON_DAMAGE_EFFECT_TYPES
            .into_iter()
            .filter(|effect_type| super::is_runtime_main_loop_non_damage_effect_type(effect_type))
            .collect::<std::collections::BTreeSet<_>>();

        let damage_only = [super::RUNTIME_DAMAGE_EFFECT_TYPE]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        let covered = main_loop
            .union(&damage_only)
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(covered, supported);
    }

    #[test]
    fn minimal_pve_battle_state_matches_frontend_required_shape() {
        let state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
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
                "monster-wild-rabbit".to_string(),
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

        assert!(
            outcome
                .logs
                .iter()
                .any(|log| log["type"] == "round_end" && log["round"] == 1)
        );
        assert!(
            outcome
                .logs
                .iter()
                .any(|log| log["type"] == "round_start" && log["round"] == 2)
        );
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
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
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
    fn minimal_pve_lifesteal_effect_heals_actor_from_damage_result() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-lifesteal",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].qixue = 50;
        state.teams.attacker.units[0].current_attrs.max_qixue = 300;
        state.teams.defender.units[0].qixue = 100;
        state.teams.defender.units[0].current_attrs.max_qixue = 100;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-life-cut",
            "name": "饮血斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"},
                {"type": "lifesteal", "value": 0.5}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-life-cut", &[target_id])
            .expect("lifesteal action should succeed");

        assert_eq!(
            outcome.logs[0]["targets"][0]["damage"],
            serde_json::json!(100)
        );
        assert_eq!(state.teams.attacker.units[0].qixue, 100);
        assert_eq!(state.teams.attacker.units[0].stats.healing_done, 50);
        assert_eq!(state.teams.attacker.units[0].stats.healing_received, 50);
    }

    #[test]
    fn minimal_pve_lifesteal_effect_is_blocked_by_heal_forbidden() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-lifesteal-heal-forbidden",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].qixue = 50;
        state.teams.attacker.units[0].current_attrs.max_qixue = 300;
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "forbidden-heal",
            "healForbidden": true
        }));
        state.teams.defender.units[0].qixue = 100;
        state.teams.defender.units[0].current_attrs.max_qixue = 100;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-life-cut-blocked",
            "name": "禁疗饮血斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"},
                {"type": "lifesteal", "value": 0.5}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome =
            apply_minimal_pve_action(&mut state, 1, "skill-life-cut-blocked", &[target_id])
                .expect("lifesteal blocked action should succeed");

        assert_eq!(
            outcome.logs[0]["targets"][0]["damage"],
            serde_json::json!(100)
        );
        assert_eq!(state.teams.attacker.units[0].qixue, 50);
        assert_eq!(state.teams.attacker.units[0].stats.healing_done, 0);
        assert_eq!(state.teams.attacker.units[0].stats.healing_received, 0);
    }

    #[test]
    fn runtime_heal_effect_uses_zhiliao_jianliao_and_stats() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-heal-modifiers",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let caster = &mut state.teams.attacker.units[0];
        caster.qixue = 40;
        caster.current_attrs.max_qixue = 300;
        caster.current_attrs.zhiliao = 0.2;
        caster.current_attrs.jianliao = 0.25;
        caster.skills = vec![serde_json::json!({
            "id": "skill-self-heal-modifiers",
            "name": "调息回春",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "damageType": "magic",
            "effects": [
                {"type": "heal", "value": 100, "valueType": "flat"}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-self-heal-modifiers",
            &[],
        )
        .expect("heal action should succeed");

        let caster = &state.teams.attacker.units[0];
        assert_eq!(caster.qixue, 130);
        assert_eq!(caster.stats.healing_done, 90);
        assert_eq!(caster.stats.healing_received, 90);
        assert_eq!(logs[0]["targets"][0]["heal"], serde_json::json!(90));
    }

    #[test]
    fn runtime_recovery_effects_apply_soul_shackle_reduction() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-soul-shackle-recovery",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let caster = &mut state.teams.attacker.units[0];
        caster.qixue = 10;
        caster.lingqi = 0;
        caster.current_attrs.max_qixue = 200;
        caster.current_attrs.max_lingqi = 100;
        caster.marks.push(serde_json::json!({
            "id": "soul_shackle",
            "sourceUnitId": "monster-1-monster-gray-wolf",
            "stacks": 2,
            "maxStacks": 5,
            "remainingDuration": 2
        }));
        caster.skills = vec![serde_json::json!({
            "id": "skill-soul-shackle-recovery",
            "name": "锁下回元",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "damageType": "magic",
            "effects": [
                {"type": "heal", "value": 100, "valueType": "flat"},
                {"type": "restore_lingqi", "value": 50, "valueType": "flat"}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-soul-shackle-recovery",
            &[],
        )
        .expect("recovery action should succeed");

        let caster = &state.teams.attacker.units[0];
        assert_eq!(caster.qixue, 94);
        assert_eq!(caster.lingqi, 42);
        assert_eq!(caster.stats.healing_done, 84);
        assert_eq!(caster.stats.healing_received, 84);
        assert_eq!(logs[0]["targets"][0]["heal"], serde_json::json!(84));
    }

    #[test]
    fn runtime_resource_qixue_does_not_use_healing_modifiers_or_soul_shackle() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-resource-qixue-not-heal",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let caster = &mut state.teams.attacker.units[0];
        caster.qixue = 10;
        caster.current_attrs.max_qixue = 200;
        caster.current_attrs.jianliao = 0.5;
        caster.buffs.push(serde_json::json!({
            "id": "forbidden-heal",
            "healForbidden": true
        }));
        caster.marks.push(serde_json::json!({
            "id": "soul_shackle",
            "sourceUnitId": "monster-1-monster-gray-wolf",
            "stacks": 2,
            "maxStacks": 5,
            "remainingDuration": 2
        }));
        caster.skills = vec![serde_json::json!({
            "id": "skill-resource-qixue",
            "name": "血元归复",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "damageType": "magic",
            "effects": [
                {"type": "resource", "resourceType": "qixue", "value": 100}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-resource-qixue",
            &[],
        )
        .expect("resource qixue action should succeed");

        let caster = &state.teams.attacker.units[0];
        assert_eq!(caster.qixue, 110);
        assert_eq!(caster.stats.healing_done, 0);
        assert_eq!(caster.stats.healing_received, 0);
        assert!(logs[0]["targets"][0].get("heal").is_none());
        assert_eq!(
            logs[0]["targets"][0]["resources"],
            serde_json::json!([{"type": "qixue", "amount": 100}])
        );
    }

    #[test]
    fn runtime_resource_lingqi_applies_soul_shackle_reduction_and_logs_resource() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-resource-lingqi-soul-shackle",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let caster = &mut state.teams.attacker.units[0];
        caster.lingqi = 0;
        caster.current_attrs.max_lingqi = 100;
        caster.marks.push(serde_json::json!({
            "id": "soul_shackle",
            "sourceUnitId": "monster-1-monster-gray-wolf",
            "stacks": 2,
            "maxStacks": 5,
            "remainingDuration": 2
        }));
        caster.skills = vec![serde_json::json!({
            "id": "skill-resource-lingqi",
            "name": "聚灵归元",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "damageType": "magic",
            "effects": [
                {"type": "resource", "resourceType": "lingqi", "value": 50}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-resource-lingqi",
            &[],
        )
        .expect("resource lingqi action should succeed");

        assert_eq!(state.teams.attacker.units[0].lingqi, 42);
        assert_eq!(
            logs[0]["targets"][0]["resources"],
            serde_json::json!([{"type": "lingqi", "amount": 42}])
        );
    }

    #[test]
    fn runtime_positive_resource_in_enemy_facing_skill_defaults_to_self() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-positive-resource-default-self",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].lingqi = 20;
        state.teams.attacker.units[0].current_attrs.max_lingqi = 100;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-enemy-facing-resource",
            "name": "战中回灵",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "damageType": "magic",
            "effects": [
                {"type": "resource", "resourceType": "lingqi", "value": 12}
            ]
        })];
        state.teams.defender.units[0].lingqi = 30;
        let target_id = state.teams.defender.units[0].id.clone();

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-enemy-facing-resource",
            std::slice::from_ref(&target_id),
        )
        .expect("enemy-facing positive resource action should succeed");

        assert_eq!(state.teams.attacker.units[0].lingqi, 32);
        assert_eq!(state.teams.defender.units[0].lingqi, 30);
        assert_eq!(logs[0]["targets"][0]["targetId"], "player-1");
        assert_eq!(
            logs[0]["targets"][0]["resources"],
            serde_json::json!([{"type": "lingqi", "amount": 12}])
        );
    }

    #[test]
    fn runtime_negative_resource_defaults_to_current_target() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-negative-resource-target",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].lingqi = 50;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-drain-lingqi",
            "name": "断灵指",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "damageType": "magic",
            "effects": [
                {"type": "resource", "resourceType": "lingqi", "value": -12}
            ]
        })];
        state.teams.defender.units[0].lingqi = 30;
        let target_id = state.teams.defender.units[0].id.clone();

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-drain-lingqi",
            std::slice::from_ref(&target_id),
        )
        .expect("negative resource action should succeed");

        assert_eq!(state.teams.attacker.units[0].lingqi, 50);
        assert_eq!(state.teams.defender.units[0].lingqi, 18);
        assert_eq!(logs[0]["targets"][0]["targetId"], target_id);
        assert_eq!(
            logs[0]["targets"][0]["resources"],
            serde_json::json!([{"type": "lingqi", "amount": 12}])
        );
    }

    #[test]
    fn set_bonus_on_heal_applies_buff() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-on-heal-buff",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let base_wugong = state.teams.attacker.units[0].base_attrs.wugong;
        let caster = &mut state.teams.attacker.units[0];
        caster.qixue = 40;
        caster.current_attrs.max_qixue = 300;
        caster.set_bonus_effects = vec![serde_json::json!({
            "setId": "set-heal-buff",
            "setName": "回春战意",
            "pieceCount": 2,
            "trigger": "on_heal",
            "target": "self",
            "effectType": "buff",
            "durationRound": 2,
            "params": {
                "attr_key": "wugong",
                "value": 5,
                "apply_type": "flat"
            }
        })];
        caster.skills = vec![serde_json::json!({
            "id": "skill-heal-proc-buff",
            "name": "回春引",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "damageType": "magic",
            "effects": [
                {"type": "heal", "value": 50, "valueType": "flat"}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-heal-proc-buff",
            &[],
        )
        .expect("heal should trigger set bonus buff");

        let caster = &state.teams.attacker.units[0];
        assert_eq!(caster.current_attrs.wugong, base_wugong + 5);
        assert!(caster.buffs.iter().any(|buff| {
            buff.get("category").and_then(serde_json::Value::as_str) == Some("set_bonus")
                && buff.get("name").and_then(serde_json::Value::as_str) == Some("回春战意")
        }));
        assert!(logs.iter().any(|log| {
            log["skillId"] == "proc-set-heal-buff-on_heal"
                && log["targets"][0]["buffsApplied"][0] == "回春战意"
        }));
    }

    #[test]
    fn minimal_pve_delayed_burst_effect_applies_and_explodes() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-delayed-burst",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-delayed-burst",
            "name": "迟发雷",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "delayed_burst", "value": 40, "valueType": "flat", "damageType": "true", "duration": 1}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let action_logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-delayed-burst",
            std::slice::from_ref(&target_id),
        )
        .expect("delayed burst action should succeed");

        assert_eq!(
            action_logs[0]["targets"][0]["buffsApplied"][0],
            "延迟爆发（1回合后）"
        );
        assert!(state.teams.defender.units[0].buffs.iter().any(|buff| {
            buff.get("delayedBurst").is_some()
                && buff
                    .get("buffDefId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| id.starts_with("delayed-burst:skill-delayed-burst:"))
        }));

        let qixue_before = state.teams.defender.units[0].qixue;
        let mut logs = Vec::new();
        super::process_unit_round_start_effects(&mut state, target_id.as_str(), &mut logs);
        assert_eq!(state.teams.defender.units[0].qixue, qixue_before - 40);
        assert!(
            logs.iter()
                .any(|log| log["type"] == "dot" && log["damage"] == serde_json::json!(40))
        );
        let burst_buff = state.teams.defender.units[0]
            .buffs
            .iter()
            .find(|buff| buff.get("delayedBurst").is_some())
            .expect("exploded delayed burst buff should remain until round-end cleanup");
        assert_eq!(burst_buff["remainingDuration"], serde_json::json!(0));
    }

    #[test]
    fn minimal_pve_fate_swap_shield_steal_moves_target_shield_to_actor() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-fate-shield",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.defender.units[0]
            .shields
            .push(serde_json::json!({
                "id": "monster-shield",
                "sourceSkillId": "monster-skill",
                "value": 80,
                "maxValue": 80,
                "duration": 2,
                "absorbType": "all",
                "priority": 1
            }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-steal-shield",
            "name": "夺盾",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "effects": [
                {"type": "fate_swap", "swapMode": "shield_steal", "value": 0.5}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-steal-shield",
            std::slice::from_ref(&target_id),
        )
        .expect("fate swap should succeed");

        assert_eq!(
            state.teams.defender.units[0].shields[0]["value"],
            serde_json::json!(40)
        );
        assert_eq!(
            state.teams.attacker.units[0].shields[0]["value"],
            serde_json::json!(40)
        );
        assert_eq!(outcome[0]["targets"][0]["buffsApplied"][0], "夺取护盾 40");
    }

    #[test]
    fn minimal_pve_buff_kind_dot_and_hot_write_runtime_payloads() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-dot-hot",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-dot-hot",
            "name": "火毒回春",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "magic",
            "element": "huo",
            "effects": [
                {"type": "debuff", "buffKind": "dot", "buffKey": "burn-dot", "value": 20, "valueType": "flat", "duration": 2},
                {"type": "buff", "target": "self", "buffKind": "hot", "buffKey": "spring-hot", "value": 15, "valueType": "flat", "duration": 2}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-dot-hot",
            std::slice::from_ref(&target_id),
        )
        .expect("dot hot action should succeed");

        assert_eq!(
            state.teams.defender.units[0].buffs[0]["dot"]["damage"],
            serde_json::json!(20)
        );
        assert_eq!(
            state.teams.defender.units[0].buffs[0]["dot"]["damageType"],
            "magic"
        );
        assert_eq!(
            state.teams.attacker.units[0].buffs[0]["hot"]["heal"],
            serde_json::json!(15)
        );
    }

    #[test]
    fn minimal_pve_buff_kind_dodge_next_forces_next_hit_to_miss() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-dodge-next",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "dodge-next",
            "buffDefId": "buff-dodge-next",
            "name": "闪避下一击",
            "type": "buff",
            "category": "skill",
            "sourceUnitId": "monster-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "dodgeNext": {"guaranteedMiss": true},
            "tags": [],
            "dispellable": true
        }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-true-hit",
            "name": "必失一击",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [{"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-true-hit",
            std::slice::from_ref(&target_id),
        )
        .expect("dodge-next action should succeed");

        assert_eq!(logs[0]["targets"][0]["hits"][0]["isMiss"], true);
        assert_eq!(logs[0]["targets"][0]["damage"], serde_json::json!(0));
        assert!(
            state.teams.defender.units[0]
                .buffs
                .iter()
                .all(|buff| buff.get("dodgeNext").is_none())
        );
    }

    #[test]
    fn minimal_pve_buff_kind_heal_forbid_blocks_heal_effect() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-heal-forbid",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].qixue = 20;
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "heal-forbid",
            "buffDefId": "debuff-heal-forbid",
            "name": "禁疗",
            "type": "debuff",
            "category": "skill",
            "sourceUnitId": "monster-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "healForbidden": true,
            "tags": [],
            "dispellable": true
        }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-self-heal",
            "name": "自疗",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "self",
            "targetCount": 1,
            "effects": [{"type": "heal", "value": 100, "valueType": "flat"}]
        })];

        let logs =
            super::execute_runtime_skill_action(&mut state, "player-1", "skill-self-heal", &[])
                .expect("heal action should succeed");

        assert_eq!(state.teams.attacker.units[0].qixue, 20);
        assert_eq!(logs[0]["targets"][0].get("heal"), None);
    }

    #[test]
    fn minimal_pve_aura_buff_applies_sub_effect_to_allies_at_round_start() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-aura",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let mut ally = state.teams.attacker.units[0].clone();
        ally.id = "player-2".to_string();
        ally.name = "队友".to_string();
        ally.qixue = 100;
        ally.shields.clear();
        ally.buffs.clear();
        ally.marks.clear();
        ally.momentum = None;
        ally.skills.clear();
        ally.skill_cooldowns.clear();
        ally.skill_cooldown_discount_bank.clear();
        ally.control_diminishing.clear();
        ally.triggered_phase_ids.clear();
        ally.stats = super::BattleUnitStatsDto {
            damage_dealt: 0,
            damage_taken: 0,
            healing_done: 0,
            healing_received: 0,
            kill_count: 0,
        };
        state.teams.attacker.units.push(ally);
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "aura-host",
            "buffDefId": "aura_host|player-1|skill-aura|0|buff-aura",
            "name": "灵压光环",
            "type": "buff",
            "category": "skill",
            "sourceUnitId": "player-1",
            "remainingDuration": -1,
            "stacks": 1,
            "maxStacks": 1,
            "aura": {
                "auraTarget": "all_ally",
                "effects": [{
                    "type": "buff",
                    "buffDefId": "aura-sub-wugong",
                    "attrModifiers": [{"attr": "wugong", "value": 10, "mode": "flat"}],
                    "duration": 1
                }],
                "damageType": "physical",
                "element": "none"
            },
            "tags": [],
            "dispellable": false
        }));

        super::process_runtime_aura_effects_at_round_start(&mut state, "player-1", &mut Vec::new());

        assert!(state.teams.attacker.units[1].buffs.iter().any(|buff| {
            buff.get("category").and_then(serde_json::Value::as_str) == Some("aura")
                && buff.get("buffDefId").and_then(serde_json::Value::as_str)
                    == Some("aura-sub-wugong")
        }));
        assert_eq!(
            state.teams.attacker.units[1].current_attrs.wugong,
            state.teams.attacker.units[1].base_attrs.wugong + 10
        );
    }

    #[test]
    fn minimal_pve_reflect_damage_buff_reflects_damage_to_attacker() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-reflect",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].qixue = 300;
        state.teams.attacker.units[0].current_attrs.max_qixue = 300;
        state.teams.defender.units[0].qixue = 300;
        state.teams.defender.units[0].current_attrs.max_qixue = 300;
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "reflect",
            "buffDefId": "buff-reflect",
            "name": "反震",
            "type": "buff",
            "category": "skill",
            "sourceUnitId": "monster-1",
            "remainingDuration": 2,
            "stacks": 1,
            "maxStacks": 1,
            "reflectDamage": {"rate": 0.25},
            "tags": [],
            "dispellable": true
        }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-hit",
            "name": "直击",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [{"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}]
        })];

        let attacker_before = state.teams.attacker.units[0].qixue;
        let target_id = state.teams.defender.units[0].id.clone();
        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-hit",
            std::slice::from_ref(&target_id),
        )
        .expect("reflect action should succeed");

        assert_eq!(state.teams.attacker.units[0].qixue, attacker_before - 25);
        assert!(logs.iter().any(|log| log["skillName"] == "反弹伤害"));
    }

    #[test]
    fn minimal_pve_next_skill_bonus_applies_once_to_damage() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-next-bonus",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.defender.units[0].qixue = 300;
        state.teams.defender.units[0].current_attrs.max_qixue = 300;
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "next-skill-bonus",
            "buffDefId": "buff-next-skill-bonus",
            "name": "下一击强化",
            "type": "buff",
            "category": "skill",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "nextSkillBonus": {"rate": 0.5, "bonusType": "damage"},
            "tags": [],
            "dispellable": true
        }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-hit",
            "name": "强化直击",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [{"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-hit",
            std::slice::from_ref(&target_id),
        )
        .expect("next skill bonus action should succeed");

        assert_eq!(logs[0]["targets"][0]["damage"], serde_json::json!(150));
        assert!(
            state.teams.attacker.units[0]
                .buffs
                .iter()
                .all(|buff| buff.get("nextSkillBonus").is_none())
        );
    }

    #[test]
    fn minimal_pve_set_bonus_on_hit_damage_triggers_after_damage() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-set-on-hit",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.defender.units[0].qixue = 300;
        state.teams.defender.units[0].current_attrs.max_qixue = 300;
        state.teams.attacker.units[0].set_bonus_effects = vec![serde_json::json!({
            "setId": "set-test",
            "setName": "测试套装",
            "trigger": "on_hit",
            "effectType": "damage",
            "target": "enemy",
            "chance": 1.0,
            "params": {"value": 20, "damage_type": "true"}
        })];
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-hit",
            "name": "直击",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [{"type": "damage", "value": 10, "valueType": "flat", "damageType": "true"}]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-hit",
            std::slice::from_ref(&target_id),
        )
        .expect("set on hit action should succeed");

        assert!(logs.iter().any(|log| {
            log["skillId"] == "proc-set-test-on_hit"
                && log["targets"][0]["damage"] == serde_json::json!(20)
        }));
    }

    #[test]
    fn minimal_pve_momentum_gain_and_consume_updates_state_and_log() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].momentum = Some(serde_json::json!({
            "id": "battle_momentum",
            "stacks": 2,
            "maxStacks": 5
        }));
        state.teams.defender.units[0].qixue = 150;
        state.teams.defender.units[0].current_attrs.max_qixue = 150;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum",
            "name": "蓄势一击",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "gain", "momentumId": "battle_momentum", "gainStacks": 2, "maxStacks": 5},
                {"type": "momentum", "operation": "consume", "momentumId": "battle_momentum", "consumeMode": "fixed", "consumeStacks": 1, "perStackRate": 0.5, "bonusType": "damage"},
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-momentum", &[target_id])
            .expect("momentum action should succeed");

        assert_eq!(
            state.teams.attacker.units[0].momentum.as_ref().unwrap()["stacks"],
            serde_json::json!(3)
        );
        assert_eq!(
            outcome.logs[0]["targets"][0]["damage"],
            serde_json::json!(150)
        );
        assert_eq!(
            outcome.logs[0]["targets"][0]["momentumGained"][0],
            "势+2（当前3层）"
        );
        assert_eq!(
            outcome.logs[0]["targets"][0]["momentumConsumed"][0],
            "消耗1层势（剩余1层）"
        );
    }

    #[test]
    fn minimal_pve_momentum_gain_keeps_existing_max_stacks() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-existing-max",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].momentum = Some(serde_json::json!({
            "id": "battle_momentum",
            "stacks": 1,
            "maxStacks": 2
        }));
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-existing-max",
            "name": "叠势上限校验",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "gain", "momentumId": "battle_momentum", "gainStacks": 5, "maxStacks": 9},
                {"type": "damage", "value": 10, "valueType": "flat", "damageType": "true"}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome =
            apply_minimal_pve_action(&mut state, 1, "skill-momentum-existing-max", &[target_id])
                .expect("momentum existing max action should succeed");

        assert_eq!(
            state.teams.attacker.units[0].momentum.as_ref().unwrap()["stacks"],
            serde_json::json!(2)
        );
        assert_eq!(
            state.teams.attacker.units[0].momentum.as_ref().unwrap()["maxStacks"],
            serde_json::json!(2)
        );
        assert_eq!(
            outcome.logs[0]["targets"][0]["momentumGained"][0],
            "势+1（当前2层）"
        );
    }

    #[test]
    fn minimal_pve_momentum_damage_bonus_applies_per_damage_segment_floor() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-split-damage",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].momentum = Some(serde_json::json!({
            "id": "battle_momentum",
            "stacks": 1,
            "maxStacks": 5
        }));
        state.teams.defender.units[0].qixue = 10;
        state.teams.defender.units[0].current_attrs.max_qixue = 10;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-split-damage",
            "name": "双段蓄势斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "consume", "momentumId": "battle_momentum", "consumeMode": "fixed", "consumeStacks": 1, "perStackRate": 0.5, "bonusType": "damage"},
                {"type": "damage", "value": 1, "valueType": "flat", "damageType": "true"},
                {"type": "damage", "value": 1, "valueType": "flat", "damageType": "true"}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome =
            apply_minimal_pve_action(&mut state, 1, "skill-momentum-split-damage", &[target_id])
                .expect("split momentum action should succeed");

        assert_eq!(
            outcome.logs[0]["targets"][0]["damage"],
            serde_json::json!(2)
        );
        assert_eq!(
            state.teams.attacker.units[0].momentum.as_ref().unwrap()["stacks"],
            serde_json::json!(0)
        );
        assert_eq!(
            outcome.logs[0]["targets"][0]["momentumConsumed"][0],
            "消耗1层势（剩余0层）"
        );
    }

    #[test]
    fn minimal_pve_momentum_gain_only_does_not_buff_same_action_damage() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-gain-only-no-bonus",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.defender.units[0].qixue = 120;
        state.teams.defender.units[0].current_attrs.max_qixue = 120;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-gain-only",
            "name": "蓄势不增伤",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "gain", "momentumId": "battle_momentum", "gainStacks": 2, "maxStacks": 5},
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}
            ]
        })];

        let target_id = state.teams.defender.units[0].id.clone();
        let outcome =
            apply_minimal_pve_action(&mut state, 1, "skill-momentum-gain-only", &[target_id])
                .expect("gain only momentum action should succeed");

        assert_eq!(
            outcome.logs[0]["targets"][0]["damage"],
            serde_json::json!(100)
        );
        assert_eq!(
            state.teams.attacker.units[0].momentum.as_ref().unwrap()["stacks"],
            serde_json::json!(2)
        );
    }

    #[test]
    fn runtime_skill_action_invalid_momentum_config_returns_err_and_does_not_mutate_momentum() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-invalid-config",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-invalid",
            "name": "坏配置蓄势斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "momentumId": "battle_momentum", "gainStacks": 2},
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}
            ]
        })];
        let before = state.teams.attacker.units[0].momentum.clone();
        let target_id = state.teams.defender.units[0].id.clone();

        let error = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-momentum-invalid",
            &[target_id],
        )
        .expect_err("invalid momentum config should fail");

        assert_eq!(error, "momentum operation 缺失");
        assert_eq!(state.teams.attacker.units[0].momentum, before);
    }

    #[test]
    fn runtime_skill_action_invalid_momentum_per_stack_rate_returns_err_and_does_not_mutate_momentum()
     {
        for (effect, expected_error) in [
            (
                serde_json::json!({
                    "type": "momentum",
                    "operation": "consume",
                    "momentumId": "battle_momentum",
                    "consumeMode": "all",
                    "bonusType": "damage"
                }),
                "momentum perStackRate 缺失",
            ),
            (
                serde_json::json!({
                    "type": "momentum",
                    "operation": "consume",
                    "momentumId": "battle_momentum",
                    "consumeMode": "all",
                    "perStackRate": -0.25,
                    "bonusType": "damage"
                }),
                "momentum perStackRate 不能小于0",
            ),
        ] {
            let mut state = build_minimal_pve_battle_state(
                "pve-battle-momentum-invalid-rate",
                1,
                &["monster-gray-wolf".to_string()],
            );
            state.teams.attacker.units[0].momentum = Some(serde_json::json!({
                "id": "battle_momentum",
                "stacks": 2,
                "maxStacks": 5
            }));
            state.teams.attacker.units[0].skills = vec![serde_json::json!({
                "id": "skill-momentum-invalid-rate",
                "name": "坏倍率蓄势斩",
                "cost": {"lingqi": 0, "qixue": 0},
                "cooldown": 0,
                "targetType": "single_enemy",
                "targetCount": 1,
                "damageType": "true",
                "effects": [
                    effect,
                    {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}
                ]
            })];
            let before = state.teams.attacker.units[0].momentum.clone();
            let target_id = state.teams.defender.units[0].id.clone();

            let error = super::execute_runtime_skill_action(
                &mut state,
                "player-1",
                "skill-momentum-invalid-rate",
                &[target_id],
            )
            .expect_err("invalid momentum perStackRate should fail");

            assert_eq!(error, expected_error);
            assert_eq!(state.teams.attacker.units[0].momentum, before);
        }
    }

    #[test]
    fn runtime_skill_action_target_validation_failure_does_not_mutate_momentum() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-no-target",
            1,
            &["monster-gray-wolf".to_string()],
        );
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-no-target",
            "name": "空挥蓄势斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "single_enemy",
            "targetCount": 1,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "gain", "momentumId": "battle_momentum", "gainStacks": 2, "maxStacks": 5},
                {"type": "momentum", "operation": "consume", "momentumId": "battle_momentum", "consumeMode": "fixed", "consumeStacks": 1, "perStackRate": 0.5, "bonusType": "damage"},
                {"type": "damage", "value": 100, "valueType": "flat", "damageType": "true"}
            ]
        })];
        let before = state.teams.attacker.units[0].momentum.clone();

        let error = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-momentum-no-target",
            &["monster-does-not-exist".to_string()],
        )
        .expect_err("invalid selected target should fail");

        assert_eq!(error, "目标不存在或已死亡");
        assert_eq!(state.teams.attacker.units[0].momentum, before);
    }

    #[test]
    fn runtime_action_log_attaches_momentum_fields_only_on_first_target() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-momentum-multi-target-log",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
            ],
        );
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-momentum-multi-target",
            "name": "群体蓄势斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "random_enemy",
            "targetCount": 2,
            "damageType": "true",
            "effects": [
                {"type": "momentum", "operation": "gain", "momentumId": "battle_momentum", "gainStacks": 2, "maxStacks": 5},
                {"type": "damage", "value": 10, "valueType": "flat", "damageType": "true"}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-momentum-multi-target",
            &[],
        )
        .expect("multi target momentum action should succeed");
        let targets = logs[0]["targets"]
            .as_array()
            .expect("targets should be array");
        assert_eq!(targets.len(), 2);
        assert!(targets[0].get("momentumGained").is_some());
        assert!(targets[1].get("momentumGained").is_none());
    }

    #[test]
    fn runtime_skill_action_lifesteal_per_target_floor_prevents_split_heal() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-lifesteal-split-floor",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
            ],
        );
        state.teams.attacker.units[0].qixue = 50;
        state.teams.attacker.units[0].current_attrs.max_qixue = 300;
        state.teams.attacker.units[0].skills = vec![serde_json::json!({
            "id": "skill-life-split-floor",
            "name": "分段饮血斩",
            "cost": {"lingqi": 0, "qixue": 0},
            "cooldown": 0,
            "targetType": "random_enemy",
            "targetCount": 2,
            "damageType": "true",
            "effects": [
                {"type": "damage", "value": 1, "valueType": "flat", "damageType": "true"},
                {"type": "lifesteal", "value": 0.5}
            ]
        })];

        let logs = super::execute_runtime_skill_action(
            &mut state,
            "player-1",
            "skill-life-split-floor",
            &[],
        )
        .expect("lifesteal split floor action should succeed");
        let targets = logs[0]["targets"]
            .as_array()
            .expect("targets should be array");
        assert_eq!(targets.len(), 2);
        for target in targets {
            assert_eq!(target["damage"], serde_json::json!(1));
        }
        assert_eq!(state.teams.attacker.units[0].qixue, 50);
        assert_eq!(state.teams.attacker.units[0].stats.healing_done, 0);
        assert_eq!(state.teams.attacker.units[0].stats.healing_received, 0);
    }

    #[test]
    fn minimal_pve_action_supports_single_ally_heal_and_buff_targeting() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        let ally_attrs = BattleUnitCurrentAttrsDto {
            max_qixue: 300,
            max_lingqi: 120,
            wugong: 80,
            fagong: 60,
            wufang: 30,
            fafang: 30,
            sudu: 10,
            mingzhong: 1.0,
            shanbi: 0.0,
            zhaojia: 0.0,
            baoji: 0.0,
            baoshang: 0.0,
            jianbaoshang: 0.0,
            jianfantan: 0.0,
            kangbao: 0.0,
            zengshang: 0.0,
            zhiliao: 0.0,
            jianliao: 0.0,
            xixue: 0.0,
            lengque: 0.0,
            kongzhi_kangxing: 0.0,
            jin_kangxing: 0.0,
            mu_kangxing: 0.0,
            shui_kangxing: 0.0,
            huo_kangxing: 0.0,
            tu_kangxing: 0.0,
            qixue_huifu: 0.0,
            lingqi_huifu: 0.0,
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
            skills: vec![build_skill_value(
                "skill-normal-attack",
                "普通攻击",
                0,
                0,
                0,
            )],
            triggered_phase_ids: Vec::new(),
            skill_cooldowns: std::collections::BTreeMap::new(),
            skill_cooldown_discount_bank: std::collections::BTreeMap::new(),
            partner_skill_policy: None,
            ai_profile: None,
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

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-support-ally",
            &["player-2".to_string()],
        )
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
            ally.qixue, ally.current_attrs.wugong, ally.base_attrs.wugong, outcome.logs[0]
        );
        assert_eq!(outcome.logs[0]["targets"][0]["targetId"], "player-2");
        assert_eq!(outcome.logs[0]["targets"][0]["heal"], 180);
        assert_eq!(
            outcome.logs[0]["targets"][0]["buffsApplied"][0],
            "buff-wugong"
        );
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

        assert!(
            logs.iter()
                .any(|log| log["skillId"] == "skill-passive-zengshang")
        );
        assert!(
            state.teams.attacker.units[0].current_attrs.wugong
                > state.teams.attacker.units[0].base_attrs.wugong
        );
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
                mingzhong: 1.0,
                shanbi: 0.0,
                zhaojia: 0.0,
                baoji: 0.0,
                baoshang: 2.0,
                jianbaoshang: 0.0,
                jianfantan: 0.0,
                kangbao: 0.0,
                zengshang: 0.0,
                zhiliao: 0.0,
                jianliao: 0.0,
                xixue: 0.0,
                lengque: 0.0,
                kongzhi_kangxing: 0.0,
                jin_kangxing: 0.0,
                mu_kangxing: 0.0,
                shui_kangxing: 0.0,
                huo_kangxing: 0.0,
                tu_kangxing: 0.0,
                qixue_huifu: 0.0,
                lingqi_huifu: 0.0,
                realm: None,
                element: Some("none".to_string()),
            },
            ..state.teams.attacker.units[0].clone()
        };
        let defender = super::BattleUnitDto {
            current_attrs: BattleUnitCurrentAttrsDto {
                wufang: 180,
                fafang: 100,
                shanbi: 0.0,
                zhaojia: 0.0,
                kangbao: 0.0,
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
        let expected =
            ((200.0_f64) * (DEFENSE_DAMAGE_K / (180.0 + DEFENSE_DAMAGE_K))).floor() as i64;
        assert_eq!(outcome.damage, expected);
        assert_eq!(outcome.is_miss, false);
        assert_eq!(outcome.is_crit, false);
    }

    #[test]
    fn runtime_damage_applies_shield_absorption_before_qixue_loss() {
        let mut target =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()])
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

        let (actual_damage, shield_absorbed) =
            super::apply_runtime_damage_to_target(&mut target, 50, "physical");
        assert_eq!(shield_absorbed, 30);
        assert_eq!(actual_damage, 20);
        assert_eq!(target.qixue, 80);
        assert!(target.shields.is_empty());
    }

    #[test]
    fn battle_start_applies_equip_trigger_set_bonus_buff() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
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

        assert!(
            state.teams.attacker.units[0].current_attrs.wugong
                > state.teams.attacker.units[0].base_attrs.wugong
        );
    }

    #[test]
    fn round_start_applies_on_turn_start_set_bonus_heal() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
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
        assert_eq!(state.teams.attacker.units[0].stats.healing_done, 20);
        assert_eq!(state.teams.attacker.units[0].stats.healing_received, 20);
        assert!(logs.iter().any(|log| log["type"] == "hot"));
    }

    #[test]
    fn round_start_settles_dot_before_natural_recovery() {
        let mut state = build_minimal_pve_battle_state(
            "round-order-dot-recovery",
            1,
            &["monster-wild-rabbit".to_string()],
        );
        let attacker = state
            .teams
            .attacker
            .units
            .first_mut()
            .expect("attacker exists");
        attacker.qixue = 5;
        attacker.current_attrs.max_qixue = 100;
        attacker.base_attrs.max_qixue = 100;
        attacker.current_attrs.qixue_huifu = 10.0;
        attacker.base_attrs.qixue_huifu = 10.0;
        attacker.buffs.push(serde_json::json!({
            "id": "dot-test",
            "buffDefId": "dot-test",
            "name": "流血",
            "type": "debuff",
            "category": "runtime",
            "sourceUnitId": "monster-1-monster-wild-rabbit",
            "remainingDuration": 2,
            "stacks": 1,
            "maxStacks": 1,
            "dot": {
                "damage": 8,
                "damageType": "true"
            },
            "tags": ["dot"],
            "dispellable": true
        }));
        state.round_count = 2;

        let mut logs = Vec::new();
        process_round_start(&mut state, &mut logs);

        let attacker = state
            .teams
            .attacker
            .units
            .first()
            .expect("attacker exists");
        assert!(
            !attacker.is_alive,
            "Node order kills the unit before qixue_huifu can recover"
        );
        assert_eq!(attacker.qixue, 0);
    }

    #[test]
    fn round_start_skips_aura_set_bonus_and_recovery_after_dot_death() {
        let mut state = build_minimal_pve_battle_state(
            "round-order-dot-death-skip-followups",
            1,
            &["monster-wild-rabbit".to_string()],
        );
        let mut ally = state.teams.attacker.units[0].clone();
        ally.id = "player-2".to_string();
        ally.name = "队友".to_string();
        ally.qixue = 100;
        ally.shields.clear();
        ally.buffs.clear();
        ally.marks.clear();
        ally.momentum = None;
        ally.skills.clear();
        ally.skill_cooldowns.clear();
        ally.skill_cooldown_discount_bank.clear();
        ally.control_diminishing.clear();
        ally.triggered_phase_ids.clear();
        ally.stats = super::BattleUnitStatsDto {
            damage_dealt: 0,
            damage_taken: 0,
            healing_done: 0,
            healing_received: 0,
            kill_count: 0,
        };
        state.teams.attacker.units.push(ally);

        let attacker = state
            .teams
            .attacker
            .units
            .first_mut()
            .expect("attacker exists");
        attacker.qixue = 5;
        attacker.current_attrs.max_qixue = 100;
        attacker.base_attrs.max_qixue = 100;
        attacker.current_attrs.qixue_huifu = 10.0;
        attacker.base_attrs.qixue_huifu = 10.0;
        attacker.buffs.push(serde_json::json!({
            "id": "dot-test",
            "buffDefId": "dot-test",
            "name": "流血",
            "type": "debuff",
            "category": "runtime",
            "sourceUnitId": "monster-1-monster-wild-rabbit",
            "remainingDuration": 2,
            "stacks": 1,
            "maxStacks": 1,
            "dot": {
                "damage": 8,
                "damageType": "true"
            },
            "tags": ["dot"],
            "dispellable": true
        }));
        attacker.buffs.push(serde_json::json!({
            "id": "aura-host",
            "buffDefId": "aura-host",
            "name": "灵压光环",
            "type": "buff",
            "category": "skill",
            "sourceUnitId": "player-1",
            "remainingDuration": -1,
            "stacks": 1,
            "maxStacks": 1,
            "aura": {
                "auraTarget": "all_ally",
                "effects": [{
                    "type": "buff",
                    "buffDefId": "aura-sub-wugong",
                    "attrModifiers": [{"attr": "wugong", "value": 10, "mode": "flat"}],
                    "duration": 1
                }],
                "damageType": "physical",
                "element": "none"
            },
            "tags": [],
            "dispellable": false
        }));
        attacker.set_bonus_effects = vec![
            serde_json::json!({
                "setId": "set-resource-test",
                "setName": "资源套装",
                "pieceCount": 2,
                "trigger": "on_turn_start",
                "target": "self",
                "effectType": "resource",
                "params": {
                    "resource_type": "qixue",
                    "value": 30
                }
            }),
            serde_json::json!({
                "setId": "set-buff-test",
                "setName": "增益套装",
                "pieceCount": 2,
                "trigger": "on_turn_start",
                "target": "self",
                "effectType": "buff",
                "params": {
                    "attr_key": "wugong",
                    "value": 6,
                    "apply_type": "flat"
                }
            }),
        ];
        state.round_count = 2;

        let mut logs = Vec::new();
        process_round_start(&mut state, &mut logs);

        let attacker = state
            .teams
            .attacker
            .units
            .iter()
            .find(|unit| unit.id == "player-1")
            .expect("attacker exists");
        assert!(!attacker.is_alive);
        assert_eq!(attacker.qixue, 0);
        assert!(!attacker.buffs.iter().any(|buff| {
            buff.get("category").and_then(serde_json::Value::as_str) == Some("set_bonus")
        }));

        let ally = state
            .teams
            .attacker
            .units
            .iter()
            .find(|unit| unit.id == "player-2")
            .expect("ally exists");
        assert!(!ally.buffs.iter().any(|buff| {
            buff.get("category").and_then(serde_json::Value::as_str) == Some("aura")
        }));
    }

    #[test]
    fn round_end_settles_set_deferred_damage() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.defender.units[0].qixue = 100;
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-1",
            "buffDefId": "set-deferred-damage",
            "name": "延迟伤害",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 30,
                "settleRate": 1.0,
                "damageType": "physical"
            },
            "tags": ["set_bonus"],
            "dispellable": false
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

        assert!(
            outcome
                .logs
                .iter()
                .any(|log| log["type"] == "dot" && log["damage"] == 30)
        );
        assert!(state.teams.defender.units[0].qixue <= 70);
    }

    #[test]
    fn round_end_stops_deferred_damage_after_death() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.defender.units[0].qixue = 10;
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-1",
            "buffDefId": "set-deferred-damage",
            "name": "延迟伤害A",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 20,
                "settleRate": 1.0,
                "damageType": "physical"
            },
            "tags": ["set_bonus"],
            "dispellable": false
        }));
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-2",
            "buffDefId": "set-deferred-damage",
            "name": "延迟伤害B",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 20,
                "settleRate": 1.0,
                "damageType": "physical"
            },
            "tags": ["set_bonus"],
            "dispellable": false
        }));
        state.teams.defender.units[0]
            .shields
            .push(serde_json::json!({
                "id": "test-shield",
                "sourceSkillId": "skill-shield",
                "value": 1,
                "maxValue": 1,
                "duration": 1,
                "absorbType": "all",
                "priority": 10
            }));
        let mut logs = Vec::new();
        process_round_end_and_start_next_round(&mut state, &mut logs);

        let defender_dot_logs = logs
            .iter()
            .filter(|log| {
                log["type"] == "dot"
                    && log["unitId"] == "monster-1-monster-gray-wolf"
                    && log["buffName"]
                        .as_str()
                        .unwrap_or("")
                        .starts_with("延迟伤害")
            })
            .collect::<Vec<_>>();
        assert_eq!(defender_dot_logs.len(), 1);
        assert_eq!(state.teams.defender.units[0].qixue, 0);
        assert!(!state.teams.defender.units[0].is_alive);
    }

    #[test]
    fn round_end_preserves_permanent_deferred_damage() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.defender.units[0].qixue = 100;
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-permanent",
            "buffDefId": "set-deferred-damage",
            "name": "永久延迟伤害",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": -1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 40,
                "settleRate": 0.5,
                "damageType": "physical"
            },
            "tags": ["set_bonus"],
            "dispellable": false
        }));

        let mut logs = Vec::new();
        process_round_end_and_start_next_round(&mut state, &mut logs);

        assert!(
            logs.iter()
                .any(|log| log["type"] == "dot" && log["damage"] == 20)
        );
        let buff = state.teams.defender.units[0]
            .buffs
            .iter()
            .find(|buff| buff["id"] == "set-deferred-permanent")
            .expect("permanent deferred buff should remain");
        assert_eq!(buff["remainingDuration"], serde_json::json!(-1));
        assert_eq!(buff["deferredDamage"]["pool"], serde_json::json!(20));
    }

    #[test]
    fn round_end_keeps_invalid_deferred_damage_without_settling() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.defender.units[0].qixue = 100;
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-invalid-settle-rate",
            "buffDefId": "set-deferred-damage",
            "name": "无效延迟伤害",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 40,
                "damageType": "physical"
            },
            "tags": ["set_bonus"],
            "dispellable": false
        }));
        state.teams.defender.units[0].buffs.push(serde_json::json!({
            "id": "set-deferred-invalid-damage-type",
            "buffDefId": "set-deferred-damage",
            "name": "无效延迟伤害2",
            "type": "debuff",
            "category": "set_bonus",
            "sourceUnitId": "player-1",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "deferredDamage": {
                "pool": 40,
                "settleRate": 0.5
            },
            "tags": ["set_bonus"],
            "dispellable": false
        }));

        let mut logs = Vec::new();
        process_round_end_and_start_next_round(&mut state, &mut logs);

        assert!(
            !logs.iter().any(|log| {
                log["type"] == "dot" && log["unitId"] == "monster-1-monster-gray-wolf"
            })
        );
        assert_eq!(state.teams.defender.units[0].qixue, 100);

        let invalid_settle_rate = state.teams.defender.units[0]
            .buffs
            .iter()
            .find(|buff| buff["id"] == "set-deferred-invalid-settle-rate")
            .expect("invalid buff should remain");
        assert_eq!(
            invalid_settle_rate["remainingDuration"],
            serde_json::json!(1)
        );
        assert_eq!(
            invalid_settle_rate["deferredDamage"]["pool"],
            serde_json::json!(40)
        );
        assert!(
            invalid_settle_rate["deferredDamage"]
                .get("settleRate")
                .is_none()
        );
        assert_eq!(
            invalid_settle_rate["deferredDamage"]["damageType"],
            serde_json::json!("physical")
        );

        let invalid_damage_type = state.teams.defender.units[0]
            .buffs
            .iter()
            .find(|buff| buff["id"] == "set-deferred-invalid-damage-type")
            .expect("invalid buff should remain");
        assert_eq!(
            invalid_damage_type["remainingDuration"],
            serde_json::json!(1)
        );
        assert_eq!(
            invalid_damage_type["deferredDamage"]["pool"],
            serde_json::json!(40)
        );
        assert_eq!(
            invalid_damage_type["deferredDamage"]["settleRate"],
            serde_json::json!(0.5)
        );
        assert!(
            invalid_damage_type["deferredDamage"]
                .get("damageType")
                .is_none()
        );
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
    fn minimal_pve_battle_state_rejects_unknown_monster_seed() {
        let error = super::try_build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &["monster-does-not-exist".to_string()],
        )
        .expect_err("unknown monster seed should fail");

        assert!(error.contains("monster-does-not-exist"));
    }

    #[test]
    fn minimal_pve_random_enemy_respects_target_count() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
            ],
        );
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
                "id": "skill-random-cleave",
                "name": "乱刃",
                "description": "随机攻击两名敌人",
                "type": "active",
                "targetType": "random_enemy",
                "targetCount": 2,
                "damageType": "physical",
                "cooldown": 0,
                "cost": {"lingqi": 0, "qixue": 0},
                "effects": [
                    {"type": "damage", "value": 1, "valueType": "flat"}
                ]
            }));

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-random-cleave", &[])
            .expect("random enemy skill should succeed");
        let target_ids = outcome.logs[0]["targets"]
            .as_array()
            .expect("targets should be array")
            .iter()
            .map(|target| target["targetId"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();

        assert_eq!(target_ids.len(), 2);
        assert!(target_ids.contains(&"monster-1-monster-gray-wolf".to_string()));
        assert!(target_ids.contains(&"monster-2-monster-wild-rabbit".to_string()));
    }

    #[test]
    fn minimal_pve_random_ally_respects_target_count() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        let mut ally = state.teams.attacker.units[0].clone();
        ally.id = "player-2".to_string();
        ally.name = "队友".to_string();
        ally.source_id = serde_json::json!(2);
        ally.formation_order = Some(2);
        ally.qixue = 90;
        state.teams.attacker.units.push(ally);
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
                "id": "skill-random-ally-shield",
                "name": "流云护阵",
                "description": "随机护盾两名友方",
                "type": "active",
                "targetType": "random_ally",
                "targetCount": 2,
                "damageType": "magic",
                "cooldown": 0,
                "cost": {"lingqi": 0, "qixue": 0},
                "effects": [
                    {"type": "shield", "value": 12, "valueType": "flat"}
                ]
            }));
        refresh_battle_team_total_speed(&mut state);

        let outcome = apply_minimal_pve_action(&mut state, 1, "skill-random-ally-shield", &[])
            .expect("random ally skill should succeed");
        let target_ids = outcome.logs[0]["targets"]
            .as_array()
            .expect("targets should be array")
            .iter()
            .map(|target| target["targetId"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();

        assert_eq!(target_ids.len(), 2);
        assert!(target_ids.contains(&"player-1".to_string()));
        assert!(target_ids.contains(&"player-2".to_string()));
    }

    #[test]
    fn minimal_pve_random_ally_effect_reuses_primary_target() {
        let mut state = build_minimal_pve_battle_state(
            "random-ally-single",
            1,
            &["monster-gray-wolf".to_string()],
        );
        let mut ally = state.teams.attacker.units[0].clone();
        ally.id = "player-2".to_string();
        ally.name = "队友".to_string();
        ally.source_id = serde_json::json!(2);
        ally.formation_order = Some(2);
        state.teams.attacker.units.push(ally);
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
                "id": "skill-random-ally-single-shield",
                "name": "流云单护",
                "description": "随机护盾一名友方",
                "type": "active",
                "targetType": "random_ally",
                "targetCount": 1,
                "damageType": "magic",
                "cooldown": 0,
                "cost": {"lingqi": 0, "qixue": 0},
                "effects": [
                    {"type": "shield", "value": 12, "valueType": "flat"}
                ]
            }));
        refresh_battle_team_total_speed(&mut state);

        let outcome =
            apply_minimal_pve_action(&mut state, 1, "skill-random-ally-single-shield", &[])
                .expect("random ally single-target skill should succeed");
        let targets = outcome.logs[0]["targets"]
            .as_array()
            .expect("targets should be array");

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0]["shield"], 12);
    }

    #[test]
    fn minimal_pve_taunt_locks_enemy_target_selection() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
            ],
        );
        state.teams.attacker.units[0].buffs.push(serde_json::json!({
            "id": "control-taunt-1",
            "buffDefId": "control-taunt",
            "name": "taunt",
            "type": "debuff",
            "category": "control",
            "sourceUnitId": "monster-2-monster-wild-rabbit",
            "remainingDuration": 1,
            "stacks": 1,
            "maxStacks": 1,
            "control": "taunt",
            "tags": ["taunt"],
            "dispellable": true
        }));

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("taunted action should succeed");

        assert_eq!(
            outcome.logs[0]["targets"][0]["targetId"],
            "monster-2-monster-wild-rabbit"
        );
    }

    #[test]
    fn minimal_pve_action_control_effect_causes_enemy_turn_skip() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
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

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-stun-enemy",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("stun skill should succeed");

        assert!(outcome.logs.iter().any(|log| log["skillId"] == "skip"));
        assert!(state.round_count >= 2);
    }

    #[test]
    fn minimal_pve_control_zero_chance_does_not_apply_or_skip_turn() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
                "id": "skill-stun-zero-chance",
                "name": "失手定魂击",
                "description": "控制概率为零",
                "type": "active",
                "targetType": "single_enemy",
                "damageType": "physical",
                "cooldown": 0,
                "cost": {"lingqi": 0, "qixue": 0},
                "effects": [
                    {"type": "control", "controlType": "stun", "chance": 0.0, "duration": 1}
                ]
            }));

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-stun-zero-chance",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("zero chance control skill should still resolve");

        assert!(!outcome.logs.iter().any(|log| log["skillId"] == "skip"));
        assert!(
            state.teams.defender.units[0]
                .buffs
                .iter()
                .all(
                    |buff| buff.get("control").and_then(serde_json::Value::as_str) != Some("stun")
                )
        );
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
            skills: vec![build_skill_value(
                "skill-normal-attack",
                "普通攻击",
                0,
                0,
                0,
            )],
            triggered_phase_ids: Vec::new(),
            skill_cooldowns: std::collections::BTreeMap::new(),
            skill_cooldown_discount_bank: std::collections::BTreeMap::new(),
            partner_skill_policy: None,
            ai_profile: None,
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
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
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

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-cleanse-ally",
            &["player-2".to_string()],
        )
        .expect("cleanse control should succeed");
        let ally = state
            .teams
            .attacker
            .units
            .iter()
            .find(|unit| unit.id == "player-2")
            .expect("ally exists");
        assert!(ally.buffs.iter().all(|buff| buff.get("control").is_none()));
        assert_eq!(outcome.logs[0]["targets"][0]["targetId"], "player-2");
    }

    #[test]
    fn runtime_buff_effect_records_source_unit_id() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        state.teams.attacker.units[0]
            .skills
            .push(serde_json::json!({
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

        let mark_outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-mark-enemy",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("mark skill should succeed");
        assert_eq!(
            mark_outcome.logs[0]["targets"][0]["buffsApplied"][0],
            "void_erosion"
        );

        let defender = state.teams.defender.units[0].clone();
        let attacker = state.teams.attacker.units[0].clone();
        let no_mark_damage = super::calculate_runtime_damage(
            &mut state,
            &attacker,
            &super::BattleUnitDto {
                marks: Vec::new(),
                ..defender.clone()
            },
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
        let mut unit =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()])
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
                resources: Vec::new(),
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
        assert!(target.get("resources").is_none());
        assert!(target.get("buffsApplied").is_none());
        assert!(target.get("momentumConsumed").is_none());
    }

    #[test]
    fn monster_phase_trigger_enrage_applies_buff_before_action() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        {
            let defender = &mut state.teams.defender.units[0];
            defender.qixue = 10;
            defender.current_attrs.max_qixue = 180;
            defender.current_attrs.wufang = 10000;
            defender.ai_profile = Some(serde_json::json!({
                "skills": ["skill-normal-attack"],
                "phaseTriggers": [{
                    "id": "low-hp-enrage",
                    "hpPercent": 0.5,
                    "action": "enrage",
                    "effects": [{
                        "type": "buff",
                        "buffKind": "attr",
                        "attrKey": "wugong",
                        "applyType": "flat",
                        "value": 5,
                        "duration": 2
                    }]
                }]
            }));
        }

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        let phase_index = outcome
            .logs
            .iter()
            .position(|log| log["skillId"] == "proc-phase-enrage-low-hp-enrage")
            .expect("phase trigger log should exist");
        let defender_action_index = outcome
            .logs
            .iter()
            .position(|log| {
                log["actorId"] == "monster-1-monster-gray-wolf"
                    && log["skillId"] != "proc-phase-enrage-low-hp-enrage"
            })
            .expect("defender action should exist");

        assert!(phase_index < defender_action_index);
        assert_eq!(outcome.logs[phase_index]["skillName"], "阶段触发·狂暴");
        assert_eq!(
            outcome.logs[phase_index]["targets"][0]["buffsApplied"],
            serde_json::json!(["buff-wugong"])
        );
        assert_eq!(
            outcome.logs[phase_index]["targets"][0]["hits"],
            serde_json::json!([])
        );
        assert!(
            outcome.logs[phase_index]["targets"][0]
                .get("damage")
                .is_none()
        );
        assert!(
            state.teams.defender.units[0]
                .triggered_phase_ids
                .iter()
                .any(|value| value == "low-hp-enrage")
        );
        assert_eq!(
            state.teams.defender.units[0].current_attrs.wugong,
            state.teams.defender.units[0].base_attrs.wugong + 5
        );
    }

    #[test]
    fn monster_phase_trigger_summon_adds_next_round_unit() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        {
            let defender = &mut state.teams.defender.units[0];
            defender.qixue = 60;
            defender.current_attrs.max_qixue = 180;
            defender.current_attrs.wufang = 10000;
            let summon_skill = super::build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0);
            let summon_base_attrs = serde_json::json!({
                "max_qixue": 90,
                "max_lingqi": 30,
                "wugong": 18,
                "fagong": 6,
                "wufang": 12,
                "fafang": 6,
                "sudu": 9,
                "mingzhong": 100,
                "shanbi": 0,
                "zhaojia": 0,
                "baoji": 0,
                "baoshang": 0,
                "jianbaoshang": 0,
                "jianfantan": 0,
                "kangbao": 0,
                "zengshang": 0,
                "zhiliao": 0,
                "jianliao": 0,
                "xixue": 0,
                "lengque": 0,
                "kongzhi_kangxing": 0,
                "jin_kangxing": 0,
                "mu_kangxing": 0,
                "shui_kangxing": 0,
                "huo_kangxing": 0,
                "tu_kangxing": 0,
                "qixue_huifu": 0,
                "lingqi_huifu": 0,
                "realm": "凡人",
                "element": "wood"
            });
            let summon_phase_trigger = serde_json::json!({
                "id": "call-wolf",
                "hpPercent": 0.5,
                "action": "summon",
                "summonCount": 1,
                "summonTemplate": {
                    "id": "wolf-cub",
                    "name": "狼崽",
                    "baseAttrs": summon_base_attrs,
                    "skills": [summon_skill]
                }
            });
            defender.ai_profile = Some(serde_json::json!({
                "skills": ["skill-normal-attack"],
                "phaseTriggers": [summon_phase_trigger]
            }));
        }

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        let summon_index = outcome
            .logs
            .iter()
            .position(|log| log["skillId"] == "proc-phase-summon-call-wolf")
            .expect("phase summon log should exist");
        let attacker_action_index = outcome
            .logs
            .iter()
            .position(|log| log["actorId"] == "player-1" && log["skillId"] == "skill-normal-attack")
            .expect("player action log should exist");
        assert_ne!(summon_index, attacker_action_index);
        assert_eq!(outcome.logs[summon_index]["skillName"], "阶段触发·召唤");
        assert!(
            outcome.logs[summon_index]["targets"][0]["targetId"]
                .as_str()
                .is_some_and(|target_id| target_id.contains("summon-wolf-cub"))
        );
        assert_eq!(
            outcome.logs[summon_index]["targets"][0]["hits"],
            serde_json::json!([])
        );
        assert!(
            outcome.logs[summon_index]["targets"][0]
                .get("damage")
                .is_none()
        );

        let summon_unit = state
            .teams
            .defender
            .units
            .iter()
            .find(|unit| unit.id.contains("summon-wolf-cub"))
            .expect("summon unit should exist");
        assert!(!summon_unit.can_act);
        assert!(summon_unit.is_alive);
        assert_eq!(
            summon_unit.owner_unit_id.as_deref(),
            Some("monster-1-monster-gray-wolf")
        );
        let original_monster = state
            .teams
            .defender
            .units
            .iter()
            .find(|unit| unit.id == "monster-1-monster-gray-wolf")
            .expect("original monster should still exist");
        assert!(
            original_monster
                .triggered_phase_ids
                .iter()
                .any(|value| value == "call-wolf")
        );
    }

    #[test]
    fn monster_phase_trigger_summon_uses_unique_ids_for_same_template_triggers() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        {
            let defender = &mut state.teams.defender.units[0];
            defender.qixue = 60;
            defender.current_attrs.max_qixue = 180;
            defender.current_attrs.wufang = 10000;
            let summon_template = serde_json::json!({
                "id": "wolf-cub",
                "name": "狼崽",
                "baseAttrs": {
                    "max_qixue": 30,
                    "max_lingqi": 0,
                    "wugong": 6,
                    "fagong": 0,
                    "wufang": 0,
                    "fafang": 0,
                    "sudu": 1
                },
                "skills": [super::build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0)]
            });
            defender.ai_profile = Some(serde_json::json!({
                "phaseTriggers": [{
                    "id": "call-wolf-a",
                    "hpPercent": 0.5,
                    "action": "summon",
                    "summonCount": 1,
                    "summonTemplate": summon_template.clone()
                }, {
                    "id": "call-wolf-b",
                    "hpPercent": 0.5,
                    "action": "summon",
                    "summonCount": 1,
                    "summonTemplate": summon_template
                }]
            }));
        }

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        assert!(
            outcome
                .logs
                .iter()
                .any(|log| log["skillId"] == "proc-phase-summon-call-wolf-a")
        );
        assert!(
            outcome
                .logs
                .iter()
                .any(|log| log["skillId"] == "proc-phase-summon-call-wolf-b")
        );
        let mut summon_ids = state
            .teams
            .defender
            .units
            .iter()
            .filter(|unit| unit.r#type == "summon")
            .map(|unit| unit.id.clone())
            .collect::<Vec<_>>();
        summon_ids.sort();
        summon_ids.dedup();

        assert_eq!(summon_ids.len(), 2);
    }

    #[test]
    fn monster_phase_trigger_enrage_logs_without_valid_effects() {
        let mut state =
            build_minimal_pve_battle_state("pve-battle-1", 1, &["monster-gray-wolf".to_string()]);
        {
            let defender = &mut state.teams.defender.units[0];
            defender.qixue = 10;
            defender.current_attrs.max_qixue = 180;
            defender.current_attrs.wufang = 10000;
            defender.ai_profile = Some(serde_json::json!({
                "phaseTriggers": [{
                    "id": "low-hp-empty-enrage",
                    "hpPercent": 0.5,
                    "action": "enrage",
                    "effects": [{
                        "type": "damage"
                    }]
                }]
            }));
        }

        let outcome = apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-1-monster-gray-wolf".to_string()],
        )
        .expect("action should succeed");

        let phase_log = outcome
            .logs
            .iter()
            .find(|log| log["skillId"] == "proc-phase-enrage-low-hp-empty-enrage")
            .expect("phase trigger log should exist");

        assert!(phase_log["targets"][0].get("buffsApplied").is_none());
        assert_eq!(phase_log["targets"][0]["hits"], serde_json::json!([]));
        assert!(phase_log["targets"][0].get("damage").is_none());
        assert!(
            state.teams.defender.units[0]
                .triggered_phase_ids
                .iter()
                .any(|value| value == "low-hp-empty-enrage")
        );
    }

    #[test]
    fn monster_ai_profile_value_uses_node_array_shape() {
        let seed = super::MonsterSeed {
            id: Some("monster-test".to_string()),
            name: Some("测试怪".to_string()),
            realm: None,
            kind: None,
            element: None,
            level: None,
            exp_reward: None,
            silver_reward_min: None,
            base_attrs: None,
            ai_profile: Some(super::MonsterAiProfileSeed {
                skills: None,
                phase_triggers: None,
            }),
            drop_pool_id: None,
            enabled: Some(true),
        };

        let profile = super::resolve_monster_ai_profile_value(&seed).expect("profile should exist");

        assert_eq!(profile["skills"], serde_json::json!([]));
        assert_eq!(profile["phaseTriggers"], serde_json::json!([]));
    }

    #[test]
    fn monster_ai_profile_value_normalizes_seed_phase_triggers() {
        let seed = super::load_monster_seed("monster-boss-ancient-tree")
            .expect("monster seed should exist");

        let profile = super::resolve_monster_ai_profile_value(&seed).expect("profile should exist");
        let phase_triggers = profile["phaseTriggers"]
            .as_array()
            .expect("phaseTriggers should be an array");

        assert!(phase_triggers.iter().any(|trigger| {
            trigger["id"] == "monster-boss-ancient-tree-phase-1"
                && trigger["hpPercent"] == serde_json::json!(0.5)
                && trigger["action"] == "enrage"
        }));
        assert!(phase_triggers.iter().any(|trigger| {
            trigger["id"] == "monster-boss-ancient-tree-phase-2"
                && trigger["hpPercent"] == serde_json::json!(0.2)
                && trigger["action"] == "summon"
                && trigger["summonCount"] == serde_json::json!(1)
                && trigger["summonTemplate"]["id"] == "monster-tree-spirit"
                && trigger["summonTemplate"]["baseAttrs"]["max_qixue"].is_number()
                && trigger["summonTemplate"]["skills"].as_array().is_some()
        }));
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
                "monster-wild-rabbit".to_string(),
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
        assert_eq!(outcome.logs[2]["actorId"], "monster-2-monster-wild-rabbit");
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
                "monster-wild-rabbit".to_string(),
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
            &["monster-2-monster-wild-rabbit".to_string()],
        )
        .expect_err("second own turn should still be blocked");
        assert_eq!(blocked, "技能冷却中: 1回合");

        apply_minimal_pve_action(
            &mut state,
            1,
            "skill-normal-attack",
            &["monster-2-monster-wild-rabbit".to_string()],
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
            &["monster-2-monster-wild-rabbit".to_string()],
        )
        .expect("third own turn should unlock heavy slash again");
    }

    #[test]
    fn minimal_pve_action_repairs_missing_action_cursor_before_validation() {
        let mut state = build_minimal_pve_battle_state(
            "pve-battle-1",
            1,
            &[
                "monster-gray-wolf".to_string(),
                "monster-wild-rabbit".to_string(),
            ],
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

        let outcome =
            apply_minimal_pvp_action(&mut state, 1, "sk-heavy-slash", &["opponent-2".to_string()])
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
                mingzhong: 1.0,
                shanbi: 0.0,
                zhaojia: 0.0,
                baoji: 0.0,
                baoshang: 0.0,
                jianbaoshang: 0.0,
                jianfantan: 0.0,
                kangbao: 0.0,
                zengshang: 0.0,
                zhiliao: 0.0,
                jianliao: 0.0,
                xixue: 0.0,
                lengque: 0.0,
                kongzhi_kangxing: 0.0,
                jin_kangxing: 0.0,
                mu_kangxing: 0.0,
                shui_kangxing: 0.0,
                huo_kangxing: 0.0,
                tu_kangxing: 0.0,
                qixue_huifu: 0.0,
                lingqi_huifu: 0.0,
                realm: Some("炼精化炁·养气期".to_string()),
                element: Some("wood".to_string()),
            },
        }
    }
}
