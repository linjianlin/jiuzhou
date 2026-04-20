use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleStateDto {
    pub battle_id: String,
    pub battle_type: String,
    pub teams: BattleTeamsDto,
    pub round_count: i64,
    pub current_team: String,
    pub current_unit_id: Option<String>,
    pub phase: String,
    pub first_mover: String,
    pub result: Option<String>,
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
    pub formation_order: Option<i64>,
    pub owner_unit_id: Option<String>,
    pub month_card_active: Option<bool>,
    pub avatar: Option<String>,
    pub qixue: i64,
    pub lingqi: i64,
    pub current_attrs: BattleUnitCurrentAttrsDto,
    pub is_alive: bool,
    pub buffs: Vec<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_exp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_silver: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BattleUnitCurrentAttrsDto {
    pub max_qixue: i64,
    pub max_lingqi: i64,
    pub realm: Option<String>,
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

pub fn build_minimal_pve_battle_state(
    battle_id: &str,
    player_character_id: i64,
    monster_ids: &[String],
) -> BattleStateDto {
    let attacker = BattleUnitDto {
        id: format!("player-{}", player_character_id),
        name: format!("修士{}", player_character_id),
        r#type: "player".to_string(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 180,
        lingqi: 100,
        current_attrs: BattleUnitCurrentAttrsDto {
            max_qixue: 180,
            max_lingqi: 100,
            realm: None,
        },
        is_alive: true,
        buffs: Vec::new(),
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
            BattleUnitDto {
                id: format!("monster-{}-{}", index + 1, monster_id),
                name: seed
                    .as_ref()
                    .and_then(|seed| seed.name.clone())
                    .unwrap_or_else(|| monster_id.clone()),
                r#type: "monster".to_string(),
                formation_order: Some(index as i64 + 1),
                owner_unit_id: None,
                month_card_active: None,
                avatar: None,
                qixue,
                lingqi,
                current_attrs: BattleUnitCurrentAttrsDto {
                    max_qixue: qixue,
                    max_lingqi: lingqi,
                    realm: seed
                        .as_ref()
                        .and_then(|seed| seed.level)
                        .map(|level| format!("Lv.{level}")),
                },
                is_alive: true,
                buffs: Vec::new(),
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
        runtime_skill_cooldowns: BTreeMap::new(),
    }
}

pub fn build_minimal_pvp_battle_state(
    battle_id: &str,
    owner_user_id: i64,
    opponent_character_id: i64,
) -> BattleStateDto {
    let attacker = BattleUnitDto {
        id: format!("player-{}", owner_user_id),
        name: format!("修士{}", owner_user_id),
        r#type: "player".to_string(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 100,
        lingqi: 100,
        current_attrs: BattleUnitCurrentAttrsDto {
            max_qixue: 100,
            max_lingqi: 100,
            realm: None,
        },
        is_alive: true,
        buffs: Vec::new(),
        reward_exp: None,
        reward_silver: None,
    };
    let defender = BattleUnitDto {
        id: format!("opponent-{}", opponent_character_id),
        name: format!("对手{}", opponent_character_id),
        r#type: "player".to_string(),
        formation_order: Some(1),
        owner_unit_id: None,
        month_card_active: Some(false),
        avatar: None,
        qixue: 100,
        lingqi: 100,
        current_attrs: BattleUnitCurrentAttrsDto {
            max_qixue: 100,
            max_lingqi: 100,
            realm: None,
        },
        is_alive: true,
        buffs: Vec::new(),
        reward_exp: None,
        reward_silver: None,
    };
    BattleStateDto {
        battle_id: battle_id.to_string(),
        battle_type: "pvp".to_string(),
        teams: BattleTeamsDto {
            attacker: BattleTeamDto {
                odwner_id: Some(owner_user_id),
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
        runtime_skill_cooldowns: BTreeMap::new(),
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
    actor_user_id: i64,
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
    let expected_actor_id = format!("player-{}", actor_user_id);
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
    if state.runtime_skill_cooldowns.get(cooldown_key.as_str()).copied().unwrap_or_default() > 0 {
        return Err("技能冷却中".to_string());
    }
    let Some(actor) = state.teams.attacker.units.iter_mut().find(|unit| unit.id == actor_id && unit.is_alive) else {
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
        state.runtime_skill_cooldowns.insert(cooldown_key, config.cooldown_turns + 1);
    }
    Ok(())
}

fn battle_skill_runtime_config(skill_id: &str) -> Option<BattleSkillRuntimeConfig> {
    match skill_id.trim() {
        "sk-basic-slash" => Some(BattleSkillRuntimeConfig { cost_lingqi: 0, cost_qixue: 0, cooldown_turns: 0 }),
        "sk-heavy-slash" => Some(BattleSkillRuntimeConfig { cost_lingqi: 20, cost_qixue: 0, cooldown_turns: 1 }),
        "sk-bite" => Some(BattleSkillRuntimeConfig { cost_lingqi: 5, cost_qixue: 0, cooldown_turns: 1 }),
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
        apply_minimal_pve_action, apply_minimal_pvp_action, build_minimal_pve_battle_state,
        build_minimal_pvp_battle_state, resolve_minimal_pve_item_rewards,
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
            outcome.finished,
            outcome.result,
            outcome.exp_gained,
            outcome.silver_gained
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
        assert!(state
            .runtime_skill_cooldowns
            .get("player-1:sk-heavy-slash")
            .copied()
            .unwrap_or_default()
            > 0);
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
    fn minimal_pve_reward_items_include_guaranteed_boar_drop() {
        let rewards = resolve_minimal_pve_item_rewards(&["monster-wild-boar".to_string()])
            .expect("boar rewards should resolve");
        assert!(rewards
            .iter()
            .any(|item| item.item_def_id == "mat-005" && item.qty > 0));
        println!(
            "BATTLE_RUNTIME_REWARD_ITEMS={}",
            serde_json::to_string(&rewards).expect("rewards should serialize")
        );
    }
}
