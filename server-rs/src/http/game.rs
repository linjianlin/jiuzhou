use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use sqlx::Row;

use crate::auth;
use crate::http::idle;
use crate::http::inventory;
use crate::http::main_quest::{MainQuestChapterDto, MainQuestProgressDto, MainQuestSectionDto, MainQuestSectionObjectiveDto};
use crate::realtime::online_players::{OnlinePlayersPayload, build_online_players_payload};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeOverviewDto {
    pub sign_in: GameHomeSignInDto,
    pub achievement: GameHomeAchievementDto,
    pub phone_binding: crate::http::account::PhoneBindingStatusDto,
    pub realm_overview: Option<crate::http::realm::RealmOverviewDto>,
    pub equipped_items: Vec<serde_json::Value>,
    pub idle_session: Option<serde_json::Value>,
    pub team: GameHomeTeamDto,
    pub task: GameHomeTaskDto,
    pub main_quest: MainQuestProgressDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<OnlinePlayersPayload>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeSignInDto {
    pub current_month: String,
    pub signed_today: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameHomeAchievementDto {
    pub claimable_count: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct GameHomeTeamDto {
    pub info: Option<serde_json::Value>,
    pub role: Option<String>,
    pub applications: Vec<serde_json::Value>,
}

#[derive(Debug, serde::Serialize)]
pub struct GameHomeTaskDto {
    pub tasks: Vec<serde_json::Value>,
}

pub async fn get_game_home_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<GameHomeOverviewDto>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let phone_binding = load_phone_binding_status(&state, actor.user_id).await?;
    let realm_overview = load_realm_overview_snapshot(&state, actor.user_id).await?;
    let task = load_task_summary_snapshot(&state, actor.user_id).await?;
    let main_quest = load_main_quest_progress_snapshot(&state, actor.user_id).await?;
    let sign_in = load_sign_in_snapshot(&state, actor.user_id).await?;
    let achievement = load_achievement_snapshot(&state, actor.user_id).await?;
    let idle_session = load_idle_session_snapshot(&state, actor.user_id).await?;
    let equipped_items = load_equipped_items_snapshot(&state, actor.user_id).await?;

    Ok(send_success(GameHomeOverviewDto {
        sign_in,
        achievement,
        phone_binding,
        realm_overview,
        equipped_items,
        idle_session,
        team: GameHomeTeamDto {
            info: None,
            role: None,
            applications: vec![],
        },
        task,
        main_quest,
        debug_realtime: Some(build_online_players_payload(state.online_players.count_total(), None)),
    }))
}

async fn load_phone_binding_status(
    state: &AppState,
    user_id: i64,
) -> Result<crate::http::account::PhoneBindingStatusDto, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT phone_number FROM users WHERE id = $1 LIMIT 1",
            |query| query.bind(user_id),
        )
        .await?;
    let phone_number = row.and_then(|row| row.try_get::<Option<String>, _>("phone_number").ok().flatten());
    Ok(crate::http::account::PhoneBindingStatusDto {
        enabled: state.config.market_phone_binding.enabled,
        is_bound: phone_number.as_deref().map(str::trim).filter(|value| !value.is_empty()).is_some(),
        masked_phone_number: phone_number.as_deref().and_then(crate::shared::phone_number::mask_phone_number),
    })
}

async fn load_sign_in_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<GameHomeSignInDto, AppError> {
    let now = time::OffsetDateTime::now_utc();
    let today = format!("{:04}-{:02}-{:02}", now.year(), u8::from(now.month()), now.day());
    let current_month = format!("{:04}-{:02}", now.year(), u8::from(now.month()));
    let signed_today = state
        .database
        .fetch_optional(
            "SELECT 1 FROM sign_in_records WHERE user_id = $1 AND sign_date = $2::date LIMIT 1",
            |query| query.bind(user_id).bind(today),
        )
        .await?
        .is_some();
    Ok(GameHomeSignInDto {
        current_month,
        signed_today,
    })
}

async fn load_achievement_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<GameHomeAchievementDto, AppError> {
    let character_id = auth::get_character_id_by_user_id(state, user_id).await?;
    let Some(character_id) = character_id else {
        return Ok(GameHomeAchievementDto { claimable_count: 0 });
    };
    let row = state.database.fetch_one(
        "SELECT COUNT(1)::bigint AS cnt FROM character_achievement WHERE character_id = $1 AND status = 'completed'",
        |query| query.bind(character_id),
    ).await?;
    Ok(GameHomeAchievementDto {
        claimable_count: row.try_get::<Option<i64>, _>("cnt")?.unwrap_or_default(),
    })
}

async fn load_realm_overview_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<Option<crate::http::realm::RealmOverviewDto>, AppError> {
    let character_row = state.database.fetch_optional(
        "SELECT id, realm, sub_realm, exp, spirit_stones FROM characters WHERE user_id = $1 LIMIT 1",
        |query| query.bind(user_id),
    ).await?;
    let Some(character_row) = character_row else { return Ok(None); };
    let config_path = None;
    let realm_order = vec![
        "凡人".to_string(),
        "炼精化炁·养气期".to_string(),
        "炼精化炁·通脉期".to_string(),
        "炼精化炁·凝炁期".to_string(),
    ];
    let realm = character_row.try_get::<Option<String>, _>("realm")?.unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row.try_get::<Option<String>, _>("sub_realm")?.unwrap_or_default();
    let current_realm = if realm == "凡人" || sub_realm.trim().is_empty() { realm } else { format!("{}·{}", realm, sub_realm) };
    Ok(Some(crate::http::realm::RealmOverviewDto {
        config_path,
        realm_order: realm_order.clone(),
        current_realm: current_realm.clone(),
        current_index: realm_order.iter().position(|value| value == &current_realm).unwrap_or(0) as i64,
        next_realm: realm_order.iter().position(|value| value == &current_realm).and_then(|idx| realm_order.get(idx + 1).cloned()),
        exp: character_row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
        spirit_stones: character_row.try_get::<Option<i64>, _>("spirit_stones")?.unwrap_or_default(),
        requirements: vec![],
        costs: vec![],
        rewards: vec![],
        can_breakthrough: false,
    }))
}

async fn load_task_summary_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<GameHomeTaskDto, AppError> {
    let character_id = auth::get_character_id_by_user_id(state, user_id).await?;
    let Some(character_id) = character_id else { return Ok(GameHomeTaskDto { tasks: vec![] }); };
    let rows = state.database.fetch_all(
        "SELECT task_id, status, tracked FROM character_task_progress WHERE character_id = $1 AND tracked = true ORDER BY updated_at DESC LIMIT 20",
        |query| query.bind(character_id),
    ).await?;
    Ok(GameHomeTaskDto {
        tasks: rows.into_iter().map(|row| serde_json::json!({
            "id": row.try_get::<Option<String>, _>("task_id").unwrap_or(None).unwrap_or_default(),
            "status": row.try_get::<Option<String>, _>("status").unwrap_or(None).unwrap_or_else(|| "ongoing".to_string()),
            "tracked": row.try_get::<Option<bool>, _>("tracked").unwrap_or(None).unwrap_or(false),
        })).collect(),
    })
}

async fn load_idle_session_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<Option<serde_json::Value>, AppError> {
    let character_id = auth::get_character_id_by_user_id(state, user_id).await?;
    let Some(character_id) = character_id else { return Ok(None); };
    let session = idle::load_active_idle_session(state, character_id).await?;
    session
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| AppError::config(format!("failed to serialize idle session snapshot: {error}")))
}

async fn load_equipped_items_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<Vec<serde_json::Value>, AppError> {
    let character_id = auth::get_character_id_by_user_id(state, user_id).await?;
    let Some(character_id) = character_id else {
        return Ok(Vec::new());
    };
    let items = inventory::load_inventory_items_with_defs(state, character_id, "equipped", 1, 200).await?;
    items
        .items
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::config(format!("failed to serialize equipped items snapshot: {error}")))
}

async fn load_main_quest_progress_snapshot(
    state: &AppState,
    user_id: i64,
) -> Result<MainQuestProgressDto, AppError> {
    let character_id = auth::get_character_id_by_user_id(state, user_id).await?;
    let Some(character_id) = character_id else {
        return Ok(MainQuestProgressDto { current_chapter: None, current_section: None, completed_chapters: vec![], completed_sections: vec![], dialogue_state: None, tracked: true });
    };
    let row = state.database.fetch_optional(
        "SELECT current_chapter_id, current_section_id, section_status, completed_chapters, completed_sections, dialogue_state, tracked FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(MainQuestProgressDto { current_chapter: None, current_section: None, completed_chapters: vec![], completed_sections: vec![], dialogue_state: None, tracked: true });
    };
    let current_chapter_id = row.try_get::<Option<String>, _>("current_chapter_id")?.unwrap_or_default();
    let current_section_id = row.try_get::<Option<String>, _>("current_section_id")?.unwrap_or_default();
    Ok(MainQuestProgressDto {
        current_chapter: (!current_chapter_id.is_empty()).then_some(MainQuestChapterDto {
            id: current_chapter_id,
            chapter_num: 0,
            name: String::new(),
            description: String::new(),
            background: String::new(),
            min_realm: "凡人".to_string(),
            is_completed: false,
        }),
        current_section: (!current_section_id.is_empty()).then_some(MainQuestSectionDto {
            id: current_section_id,
            chapter_id: String::new(),
            section_num: 0,
            name: String::new(),
            description: String::new(),
            brief: String::new(),
            npc_id: None,
            map_id: None,
            room_id: None,
            status: row.try_get::<Option<String>, _>("section_status")?.unwrap_or_else(|| "not_started".to_string()),
            objectives: Vec::<MainQuestSectionObjectiveDto>::new(),
            rewards: serde_json::json!({}),
            is_chapter_final: false,
        }),
        completed_chapters: row.try_get::<Option<serde_json::Value>, _>("completed_chapters")?.and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
        completed_sections: row.try_get::<Option<serde_json::Value>, _>("completed_sections")?.and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect(),
        dialogue_state: row.try_get::<Option<serde_json::Value>, _>("dialogue_state")?,
        tracked: row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn game_home_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "signIn": {"currentMonth": "2026-04", "signedToday": false},
                "achievement": {"claimableCount": 2},
                "phoneBinding": {"enabled": true, "isBound": false, "maskedPhoneNumber": null},
                "realmOverview": null,
                "equippedItems": [],
                "idleSession": {"id": "idle-1", "status": "active"},
                "debugRealtime": {"kind": "game:onlinePlayers", "total": 0, "roomId": null},
                "team": {"info": null, "role": null, "applications": []},
                "task": {"tasks": []},
                "mainQuest": {"currentChapter": null, "currentSection": null, "completedChapters": [], "completedSections": [], "dialogueState": null, "tracked": true}
            }
        });
        assert_eq!(payload["data"]["achievement"]["claimableCount"], 2);
        assert_eq!(payload["data"]["idleSession"]["status"], "active");
        assert_eq!(payload["data"]["debugRealtime"]["kind"], "game:onlinePlayers");
        println!("GAME_HOME_OVERVIEW_RESPONSE={}", payload);
    }
}
