use sqlx::Row;

use crate::battle_runtime::{
    BattleCharacterUnitProfile, BattleStateDto, BattleUnitCurrentAttrsDto,
    apply_character_profile_to_battle_state,
};
use crate::shared::error::AppError;
use crate::state::AppState;

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
            wugong: row.try_get::<i64, _>("wugong")?.max(0),
            fagong: row.try_get::<i64, _>("fagong")?.max(0),
            wufang: row.try_get::<i64, _>("wufang")?.max(0),
            fafang: row.try_get::<i64, _>("fafang")?.max(0),
            sudu: row.try_get::<i64, _>("sudu")?.max(0),
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
    battle_state.teams.attacker.odwner_id = Some(profile.user_id);
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
