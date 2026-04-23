use sqlx::Row;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::battle_runtime::{
    BattleCharacterUnitProfile, BattleStateDto, BattleUnitCurrentAttrsDto,
    apply_character_profile_to_battle_state, build_minimal_character_battle_unit,
    build_minimal_partner_battle_unit, build_skill_value,
};
use crate::http::character_technique::load_character_battle_skill_values;
use crate::http::inventory::load_inventory_def_map;
use crate::http::partner::build_active_partner_idle_execution_snapshot;
use crate::shared::error::AppError;
use crate::state::AppState;

const DEFAULT_BATTLE_WUGONG: i64 = 32;
const DEFAULT_BATTLE_FAGONG: i64 = 24;
const DEFAULT_BATTLE_WUFANG: i64 = 16;
const DEFAULT_BATTLE_FAFANG: i64 = 16;
const DEFAULT_BATTLE_SUDU: i64 = 6;

struct ItemSetSeed {
    name: String,
    bonuses: Vec<ItemSetBonusSeed>,
}

struct ItemSetBonusSeed {
    piece_count: i64,
    effect_defs: Vec<serde_json::Value>,
    priority: Option<i64>,
}

fn ensure_runtime_normal_attack(skills: &mut Vec<serde_json::Value>) {
    let has_normal_attack = skills.iter().any(|skill| {
        skill.get("id").and_then(serde_json::Value::as_str) == Some("skill-normal-attack")
    });
    if has_normal_attack {
        return;
    }
    skills.insert(
        0,
        build_skill_value("skill-normal-attack", "普通攻击", 0, 0, 0),
    );
}

fn load_item_set_seed_map() -> Result<BTreeMap<String, ItemSetSeed>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/item_set.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read item_set.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse item_set.json: {error}")))?;
    let sets = payload
        .get("sets")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut map = BTreeMap::new();
    for set in sets {
        let Some(set_id) = set
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let name = set
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(set_id)
            .to_string();
        let bonuses = set
            .get("bonuses")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|bonus| {
                Some(ItemSetBonusSeed {
                    piece_count: bonus
                        .get("piece_count")
                        .and_then(|value| value.as_i64())?
                        .max(1),
                    effect_defs: bonus
                        .get("effect_defs")
                        .and_then(|value| value.as_array())
                        .cloned()
                        .unwrap_or_default(),
                    priority: bonus.get("priority").and_then(|value| value.as_i64()),
                })
            })
            .collect::<Vec<_>>();
        map.insert(set_id.to_string(), ItemSetSeed { name, bonuses });
    }
    Ok(map)
}

async fn load_character_battle_set_bonus_effect_values(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<serde_json::Value>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT item_def_id FROM item_instance WHERE owner_character_id = $1 AND location = 'equipped'",
        |q| q.bind(character_id),
    ).await?;
    let defs = load_inventory_def_map()?;
    let set_seed_map = load_item_set_seed_map()?;
    let mut equipped_count_by_set = BTreeMap::<String, i64>::new();
    for row in rows {
        let item_def_id = row
            .try_get::<Option<String>, _>("item_def_id")?
            .unwrap_or_default();
        let Some(def) = defs.get(item_def_id.as_str()) else {
            continue;
        };
        let Some(set_id) = def
            .row
            .get("set_id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        *equipped_count_by_set.entry(set_id.to_string()).or_insert(0) += 1;
    }
    let mut effects = Vec::new();
    for (set_id, equipped_count) in equipped_count_by_set {
        let Some(set_seed) = set_seed_map.get(set_id.as_str()) else {
            continue;
        };
        for bonus in &set_seed.bonuses {
            if equipped_count < bonus.piece_count.max(1) {
                continue;
            }
            for effect_def in &bonus.effect_defs {
                let trigger = effect_def
                    .get("trigger")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let target = effect_def
                    .get("target")
                    .and_then(|value| value.as_str())
                    .unwrap_or("self");
                let effect_type = effect_def
                    .get("effect_type")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let params = effect_def
                    .get("params")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                if trigger.is_empty() || effect_type.is_empty() {
                    continue;
                }
                effects.push(serde_json::json!({
                    "setId": set_id,
                    "setName": set_seed.name,
                    "pieceCount": bonus.piece_count.max(1),
                    "trigger": trigger,
                    "target": if target == "enemy" { "enemy" } else { "self" },
                    "effectType": effect_type,
                    "durationRound": effect_def.get("duration_round").and_then(|value| value.as_i64()),
                    "element": effect_def.get("element").and_then(|value| value.as_str()),
                    "params": params,
                    "priority": bonus.priority.unwrap_or_default(),
                }));
            }
        }
    }
    Ok(effects)
}

pub async fn load_required_battle_character_profile(
    state: &AppState,
    character_id: i64,
) -> Result<BattleCharacterUnitProfile, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT c.id::bigint AS character_id, c.user_id::bigint AS user_id, COALESCE(NULLIF(TRIM(c.nickname), ''), CONCAT('修士', c.id::text)) AS nickname, c.avatar, COALESCE(NULLIF(TRIM(c.realm), ''), '凡人') AS realm, NULLIF(TRIM(c.sub_realm), '') AS sub_realm, COALESCE(NULLIF(TRIM(c.attribute_element), ''), 'none') AS attribute_element, GREATEST(COALESCE(crs.max_qixue, c.jing::bigint, 0), 1)::bigint AS max_qixue, GREATEST(COALESCE(crs.max_lingqi, c.qi::bigint, 0), 0)::bigint AS max_lingqi, COALESCE(crs.wugong, 0)::bigint AS wugong, COALESCE(crs.fagong, 0)::bigint AS fagong, COALESCE(crs.wufang, 0)::bigint AS wufang, COALESCE(crs.fafang, 0)::bigint AS fafang, GREATEST(COALESCE(crs.sudu, 0), 0)::bigint AS sudu, COALESCE(c.jing, 0)::bigint AS current_qixue, COALESCE(c.qi, 0)::bigint AS current_lingqi, (mco.expire_at IS NOT NULL) AS month_card_active FROM characters c LEFT JOIN character_rank_snapshot crs ON crs.character_id = c.id LEFT JOIN month_card_ownership mco ON mco.character_id = c.id AND mco.month_card_id = 'monthcard-001' AND mco.expire_at > NOW() WHERE c.id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };

    let max_qixue = row.try_get::<i64, _>("max_qixue")?.max(1);
    let max_lingqi = row.try_get::<i64, _>("max_lingqi")?.max(0);
    let current_lingqi = row.try_get::<i64, _>("current_lingqi")?.max(0);
    let battle_lingqi = if max_lingqi > 0 {
        current_lingqi.max(max_lingqi / 2).min(max_lingqi)
    } else {
        current_lingqi
    };
    let realm_text = row.try_get::<String, _>("realm")?;
    let sub_realm = row.try_get::<Option<String>, _>("sub_realm")?;
    let realm = normalize_realm(Some(&realm_text), sub_realm.as_deref());
    let element = row.try_get::<String, _>("attribute_element")?;

    Ok(BattleCharacterUnitProfile {
        character_id: row.try_get::<i64, _>("character_id")?,
        user_id: row.try_get::<i64, _>("user_id")?,
        name: row.try_get::<String, _>("nickname")?,
        month_card_active: row.try_get::<bool, _>("month_card_active")?,
        avatar: row
            .try_get::<Option<String>, _>("avatar")?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        qixue: max_qixue,
        lingqi: battle_lingqi,
        attrs: BattleUnitCurrentAttrsDto {
            max_qixue,
            max_lingqi,
            wugong: row.try_get::<i64, _>("wugong")?.max(DEFAULT_BATTLE_WUGONG),
            fagong: row.try_get::<i64, _>("fagong")?.max(DEFAULT_BATTLE_FAGONG),
            wufang: row.try_get::<i64, _>("wufang")?.max(DEFAULT_BATTLE_WUFANG),
            fafang: row.try_get::<i64, _>("fafang")?.max(DEFAULT_BATTLE_FAFANG),
            sudu: row.try_get::<i64, _>("sudu")?.max(DEFAULT_BATTLE_SUDU),
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
            realm: Some(realm),
            element: Some(element),
        },
    })
}

pub async fn hydrate_pve_battle_state_owner(
    state: &AppState,
    battle_state: &mut BattleStateDto,
    character_id: i64,
) -> Result<(), AppError> {
    let unit_id = format!("player-{character_id}");
    let profile = load_required_battle_character_profile(state, character_id).await?;
    apply_character_profile_to_battle_state(battle_state, &unit_id, "player", &profile)
        .ok_or_else(|| AppError::config("战斗单位不存在"))?;
    let battle_skills = load_character_battle_skill_values(state, character_id).await?;
    let set_bonus_effects =
        load_character_battle_set_bonus_effect_values(state, character_id).await?;
    if let Some(unit) = battle_state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == unit_id)
    {
        if !battle_skills.is_empty() {
            unit.skills = battle_skills;
        }
        ensure_runtime_normal_attack(&mut unit.skills);
        unit.set_bonus_effects = set_bonus_effects;
    }
    battle_state.teams.attacker.odwner_id = Some(profile.user_id);
    Ok(())
}

pub async fn hydrate_pve_battle_state_active_partner(
    state: &AppState,
    battle_state: &mut BattleStateDto,
    character_id: i64,
) -> Result<(), AppError> {
    let Some(partner) = build_active_partner_idle_execution_snapshot(state, character_id).await?
    else {
        return Ok(());
    };
    if battle_state
        .teams
        .attacker
        .units
        .iter()
        .any(|unit| unit.id == format!("partner-{}", partner.partner_id))
    {
        return Ok(());
    }
    let formation_order = battle_state.teams.attacker.units.len() as i64 + 1;
    battle_state
        .teams
        .attacker
        .units
        .push(build_minimal_partner_battle_unit(
            partner.partner_id,
            partner.name,
            partner.avatar,
            format!("player-{character_id}"),
            partner.attrs,
            partner.qixue,
            partner.lingqi,
            partner.skills,
            partner.skill_policy,
            formation_order,
        ));
    Ok(())
}

pub async fn hydrate_pve_battle_state_participants(
    state: &AppState,
    battle_state: &mut BattleStateDto,
    participant_character_ids: &[i64],
) -> Result<(), AppError> {
    for character_id in participant_character_ids {
        if *character_id <= 0 {
            continue;
        }
        let player_unit_id = format!("player-{character_id}");
        if battle_state
            .teams
            .attacker
            .units
            .iter()
            .any(|unit| unit.id == player_unit_id)
        {
            hydrate_pve_battle_state_active_partner(state, battle_state, *character_id).await?;
            continue;
        }
        let profile = load_required_battle_character_profile(state, *character_id).await?;
        let mut battle_skills = load_character_battle_skill_values(state, *character_id).await?;
        let set_bonus_effects =
            load_character_battle_set_bonus_effect_values(state, *character_id).await?;
        ensure_runtime_normal_attack(&mut battle_skills);
        let next_order = battle_state.teams.attacker.units.len() as i64 + 1;
        let mut unit =
            build_minimal_character_battle_unit("player", &profile, next_order, battle_skills);
        unit.set_bonus_effects = set_bonus_effects;
        battle_state.teams.attacker.units.push(unit);
        hydrate_pve_battle_state_active_partner(state, battle_state, *character_id).await?;
    }
    Ok(())
}

pub async fn hydrate_pvp_battle_state_players(
    state: &AppState,
    battle_state: &mut BattleStateDto,
    attacker_character_id: i64,
    defender_character_id: i64,
    defender_unit_kind: &str,
) -> Result<(), AppError> {
    let attacker_profile =
        load_required_battle_character_profile(state, attacker_character_id).await?;
    let defender_profile =
        load_required_battle_character_profile(state, defender_character_id).await?;
    apply_character_profile_to_battle_state(
        battle_state,
        &format!("player-{attacker_character_id}"),
        "player",
        &attacker_profile,
    )
    .ok_or_else(|| AppError::config("战斗单位不存在"))?;
    apply_character_profile_to_battle_state(
        battle_state,
        &format!("opponent-{defender_character_id}"),
        defender_unit_kind,
        &defender_profile,
    )
    .ok_or_else(|| AppError::config("战斗单位不存在"))?;
    let attacker_skills = load_character_battle_skill_values(state, attacker_character_id).await?;
    let attacker_set_bonus_effects =
        load_character_battle_set_bonus_effect_values(state, attacker_character_id).await?;
    if let Some(unit) = battle_state
        .teams
        .attacker
        .units
        .iter_mut()
        .find(|unit| unit.id == format!("player-{attacker_character_id}"))
    {
        if !attacker_skills.is_empty() {
            unit.skills = attacker_skills;
        }
        ensure_runtime_normal_attack(&mut unit.skills);
        unit.set_bonus_effects = attacker_set_bonus_effects;
    }
    let defender_skills = load_character_battle_skill_values(state, defender_character_id).await?;
    let defender_set_bonus_effects =
        load_character_battle_set_bonus_effect_values(state, defender_character_id).await?;
    let defender_unit_id = if defender_unit_kind == "npc" {
        format!("npc-{defender_character_id}")
    } else {
        format!("player-{defender_character_id}")
    };
    if let Some(unit) = battle_state
        .teams
        .defender
        .units
        .iter_mut()
        .find(|unit| unit.id == defender_unit_id)
    {
        if !defender_skills.is_empty() {
            unit.skills = defender_skills;
        }
        ensure_runtime_normal_attack(&mut unit.skills);
        unit.set_bonus_effects = defender_set_bonus_effects;
    }
    battle_state.teams.attacker.odwner_id = Some(attacker_profile.user_id);
    battle_state.teams.defender.odwner_id = if defender_unit_kind == "player" {
        Some(defender_profile.user_id)
    } else {
        None
    };
    Ok(())
}

fn normalize_realm(realm: Option<&str>, sub_realm: Option<&str>) -> String {
    let realm = realm
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("凡人");
    let Some(sub_realm) = sub_realm.map(str::trim).filter(|value| !value.is_empty()) else {
        return realm.to_string();
    };
    format!("{realm}·{sub_realm}")
}

#[cfg(test)]
mod tests {
    use super::normalize_realm;

    #[test]
    fn normalize_realm_keeps_node_style_sub_realm_suffix() {
        assert_eq!(
            normalize_realm(Some("炼精化炁"), Some("养气期")),
            "炼精化炁·养气期"
        );
        assert_eq!(normalize_realm(Some("凡人"), None), "凡人");
    }
}
