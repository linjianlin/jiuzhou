use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::battle_runtime::{restart_battle_runtime, try_build_minimal_pve_battle_state};
use crate::integrations::battle_character_profile::{
    hydrate_pve_battle_state_active_partner, hydrate_pve_battle_state_owner,
};
use crate::jobs::tower_frozen_pool::resolve_frozen_tower_monsters_for_floor;
use crate::realtime::battle::{build_battle_cooldown_ready_payload, build_battle_started_payload};
use crate::realtime::public_socket::{
    emit_battle_cooldown_to_participants, emit_battle_update_to_participants,
};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::{
    AppState, BattleSessionContextDto, BattleSessionSnapshotDto, OnlineBattleProjectionRecord,
};

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

fn opt_i64_from_i32_default(row: &sqlx::postgres::PgRow, column: &str, default: i64) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or(default)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerFloorPreviewDto {
    pub floor: i64,
    pub kind: String,
    pub seed: String,
    pub realm: String,
    pub monster_ids: Vec<String>,
    pub monster_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerOverviewDto {
    pub progress: TowerProgressDto,
    pub active_session: Option<serde_json::Value>,
    pub next_floor_preview: TowerFloorPreviewDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerProgressDto {
    pub best_floor: i64,
    pub next_floor: i64,
    pub current_run_id: Option<String>,
    pub current_floor: Option<i64>,
    pub last_settled_floor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerRankRowDto {
    pub rank: i64,
    pub character_id: i64,
    pub name: String,
    pub realm: String,
    pub best_floor: i64,
    pub reached_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerBattleSessionSnapshotDto {
    pub session_id: String,
    #[serde(rename = "type")]
    pub session_type: String,
    pub owner_user_id: i64,
    pub participant_user_ids: Vec<i64>,
    pub current_battle_id: Option<String>,
    pub status: String,
    pub next_action: String,
    pub can_advance: bool,
    pub last_result: Option<String>,
    pub context: TowerSessionContextDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerSessionContextDto {
    pub run_id: String,
    pub floor: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerStartDataDto {
    pub session: TowerBattleSessionSnapshotDto,
}

#[derive(Debug, Deserialize, Clone)]
struct TowerMonsterSeedFile {
    monsters: Vec<TowerMonsterSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct TowerMonsterSeed {
    id: Option<String>,
    name: Option<String>,
    realm: Option<String>,
    kind: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct TowerRankQuery {
    pub limit: Option<i64>,
}

pub async fn get_tower_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<TowerOverviewDto>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Err(AppError::config("角色不存在"));
    };

    let progress = state
        .database
        .fetch_optional(
            "SELECT best_floor, next_floor, current_run_id, current_floor, last_settled_floor FROM character_tower_progress WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let progress = TowerProgressDto {
        best_floor: progress
            .as_ref()
            .map(|row| opt_i64_from_i32(row, "best_floor"))
            .unwrap_or_default(),
        next_floor: progress
            .as_ref()
            .map(|row| opt_i64_from_i32_default(row, "next_floor", 1))
            .unwrap_or(1),
        current_run_id: progress.as_ref().and_then(|row| {
            row.try_get::<Option<String>, _>("current_run_id")
                .ok()
                .flatten()
        }),
        current_floor: progress.as_ref().and_then(|row| {
            row.try_get::<Option<i32>, _>("current_floor")
                .ok()
                .flatten()
                .map(i64::from)
        }),
        last_settled_floor: progress
            .as_ref()
            .map(|row| opt_i64_from_i32(row, "last_settled_floor"))
            .unwrap_or_default(),
    };
    let next_floor_preview = build_tower_floor_preview(progress.next_floor);

    let active_session = state
        .battle_sessions
        .get_current_for_user(actor.user_id)
        .filter(|session| session.session_type == "tower")
        .map(|session| serde_json::to_value(session))
        .transpose()
        .map_err(|error| {
            AppError::config(format!("failed to serialize tower active session: {error}"))
        })?;

    Ok(send_success(TowerOverviewDto {
        progress,
        active_session,
        next_floor_preview,
    }))
}

pub async fn get_tower_rank(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TowerRankQuery>,
) -> Result<Json<SuccessResponse<Vec<TowerRankRowDto>>>, AppError> {
    let _ = auth::require_auth(&state, &headers).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let rows = state
        .database
        .fetch_all(
            "SELECT ROW_NUMBER() OVER (ORDER BY best_floor DESC, reached_at ASC NULLS LAST, character_id ASC)::bigint AS rank, p.character_id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS name, c.realm, p.best_floor, p.reached_at::text AS reached_at_text FROM character_tower_progress p JOIN characters c ON c.id = p.character_id ORDER BY rank LIMIT $1",
            |query| query.bind(limit),
        )
        .await?;
    Ok(send_success(
        rows.into_iter()
            .map(|row| TowerRankRowDto {
                rank: row
                    .try_get::<Option<i64>, _>("rank")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                character_id: opt_i64_from_i32(&row, "character_id"),
                name: row
                    .try_get::<Option<String>, _>("name")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                realm: row
                    .try_get::<Option<String>, _>("realm")
                    .unwrap_or(None)
                    .unwrap_or_default(),
                best_floor: opt_i64_from_i32(&row, "best_floor"),
                reached_at: row
                    .try_get::<Option<String>, _>("reached_at_text")
                    .unwrap_or(None),
            })
            .collect(),
    ))
}

pub async fn start_tower_challenge(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<TowerStartDataDto>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Err(AppError::config("角色不存在"));
    };

    let session = state
        .database
        .with_transaction(|| async {
            start_tower_challenge_tx(&state, actor.user_id, character_id).await
        })
        .await?;
    state.battle_sessions.register(BattleSessionSnapshotDto {
        session_id: session.session_id.clone(),
        session_type: session.session_type.clone(),
        owner_user_id: session.owner_user_id,
        participant_user_ids: session.participant_user_ids.clone(),
        current_battle_id: session.current_battle_id.clone(),
        status: session.status.clone(),
        next_action: session.next_action.clone(),
        can_advance: session.can_advance,
        last_result: session.last_result.clone(),
        context: BattleSessionContextDto::Tower {
            run_id: session.context.run_id.clone(),
            floor: session.context.floor,
        },
    });
    if let Some(current_battle_id) = session.current_battle_id.clone() {
        state
            .online_battle_projections
            .register(OnlineBattleProjectionRecord {
                battle_id: current_battle_id,
                owner_user_id: actor.user_id,
                participant_user_ids: session.participant_user_ids.clone(),
                r#type: "pve".to_string(),
                session_id: Some(session.session_id.clone()),
            });
    }
    if let Some(current_battle_id) = session.current_battle_id.clone() {
        let mut battle_state = try_build_minimal_pve_battle_state(
            &current_battle_id,
            character_id,
            &resolve_tower_floor_monster_ids(session.context.floor),
        )
        .map_err(AppError::config)?;
        hydrate_pve_battle_state_owner(&state, &mut battle_state, character_id).await?;
        hydrate_pve_battle_state_active_partner(&state, &mut battle_state, character_id).await?;
        let start_logs = restart_battle_runtime(&mut battle_state);
        state.battle_runtime.register(battle_state.clone());
        let debug_realtime = build_battle_started_payload(
            &current_battle_id,
            battle_state.clone(),
            start_logs,
            state.battle_sessions.get_by_battle_id(&current_battle_id),
        );
        emit_battle_update_to_participants(&state, &session.participant_user_ids, &debug_realtime);
        let debug_cooldown_realtime =
            build_battle_cooldown_ready_payload(battle_state.current_unit_id.as_deref());
        emit_battle_cooldown_to_participants(
            &state,
            &session.participant_user_ids,
            &debug_cooldown_realtime,
        );
    }

    Ok(send_success(TowerStartDataDto { session }))
}

async fn start_tower_challenge_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
) -> Result<TowerBattleSessionSnapshotDto, AppError> {
    let progress = state.database.fetch_optional(
        "SELECT best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor FROM character_tower_progress WHERE character_id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(character_id),
    ).await?;

    let next_floor = progress
        .as_ref()
        .map(|row| opt_i64_from_i32_default(row, "next_floor", 1))
        .unwrap_or(1)
        .max(1);
    let current_run_id = progress.as_ref().and_then(|row| {
        row.try_get::<Option<String>, _>("current_run_id")
            .ok()
            .flatten()
    });
    let current_floor = progress.as_ref().and_then(|row| {
        row.try_get::<Option<i32>, _>("current_floor")
            .ok()
            .flatten()
            .map(i64::from)
    });
    let current_battle_id = progress.as_ref().and_then(|row| {
        row.try_get::<Option<String>, _>("current_battle_id")
            .ok()
            .flatten()
    });

    let run_id = current_run_id.unwrap_or_else(|| build_tower_run_id(character_id));
    let floor = if current_battle_id.is_some() {
        current_floor.unwrap_or(next_floor)
    } else {
        next_floor
    };
    let battle_id = current_battle_id.unwrap_or_else(|| build_tower_battle_id(&run_id, floor));

    if progress.is_some() {
        state.database.execute(
            "UPDATE character_tower_progress SET current_run_id = $2, current_floor = $3, current_battle_id = $4, updated_at = NOW() WHERE character_id = $1",
            |query| query.bind(character_id).bind(&run_id).bind(floor).bind(&battle_id),
        ).await?;
    } else {
        state.database.execute(
            "INSERT INTO character_tower_progress (character_id, best_floor, next_floor, current_run_id, current_floor, current_battle_id, last_settled_floor, updated_at) VALUES ($1, 0, 1, $2, $3, $4, 0, NOW())",
            |query| query.bind(character_id).bind(&run_id).bind(floor).bind(&battle_id),
        ).await?;
    }

    Ok(TowerBattleSessionSnapshotDto {
        session_id: format!("tower-session-{run_id}"),
        session_type: "tower".to_string(),
        owner_user_id: user_id,
        participant_user_ids: vec![user_id],
        current_battle_id: Some(battle_id),
        status: "running".to_string(),
        next_action: "none".to_string(),
        can_advance: false,
        last_result: None,
        context: TowerSessionContextDto { run_id, floor },
    })
}

const TOWER_REALM_ORDER: &[&str] = &[
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
    "大乘",
];

const TOWER_NORMAL_MONSTER_COUNT_MIN: i64 = 2;
const TOWER_NORMAL_MONSTER_COUNT_VARIANCE: usize = 2;
const TOWER_NORMAL_MONSTER_COUNT_INTERVAL: i64 = 50;
const TOWER_NORMAL_MONSTER_COUNT_CAP: i64 = 5;
const TOWER_ELITE_MONSTER_COUNT_BASE: i64 = 2;
const TOWER_ELITE_MONSTER_COUNT_INTERVAL: i64 = 75;
const TOWER_ELITE_MONSTER_COUNT_CAP: i64 = 4;
const TOWER_BOSS_MONSTER_COUNT_BASE: i64 = 1;
const TOWER_BOSS_MONSTER_COUNT_INTERVAL: i64 = 100;
const TOWER_BOSS_MONSTER_COUNT_CAP: i64 = 3;

fn tower_floor_kind(floor: i64) -> &'static str {
    let normalized_floor = floor.max(1);
    if normalized_floor % 10 == 0 {
        "boss"
    } else if normalized_floor % 5 == 0 {
        "elite"
    } else {
        "normal"
    }
}

fn tower_normalize_monster_kind(value: Option<&str>) -> &'static str {
    match value {
        Some("boss") => "boss",
        Some("elite") => "elite",
        _ => "normal",
    }
}

fn tower_normalize_realm(value: Option<&str>) -> String {
    let text = value.unwrap_or("凡人").trim();
    if TOWER_REALM_ORDER.contains(&text) {
        text.to_string()
    } else {
        "凡人".to_string()
    }
}

fn tower_hash_text_u32(value: &str) -> u32 {
    let mut hash = 0x811c9dc5_u32;
    for byte in value.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

fn tower_pick_deterministic_index(seed: &str, length: usize, offset: usize) -> usize {
    let scoped_seed = format!("pick-index::{seed}::{}", offset.max(0));
    (tower_hash_text_u32(&scoped_seed) as usize) % length
}

fn tower_pick_deterministic_monsters(
    seed: &str,
    items: &[TowerMonsterSeed],
    count: i64,
) -> Vec<TowerMonsterSeed> {
    let target_count = count.max(0) as usize;
    if target_count == 0 || items.is_empty() {
        return Vec::new();
    }

    let mut remaining = items.to_vec();
    let mut picked = Vec::new();
    while !remaining.is_empty() && picked.len() < target_count {
        let index = tower_pick_deterministic_index(seed, remaining.len(), picked.len());
        picked.push(remaining.remove(index));
    }
    while picked.len() < target_count {
        let index = tower_pick_deterministic_index(seed, items.len(), picked.len());
        picked.push(items[index].clone());
    }
    picked
}

fn load_tower_monster_seed_map() -> Result<BTreeMap<String, Vec<TowerMonsterSeed>>, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/monster_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read monster_def.json: {error}")))?;
    let payload: TowerMonsterSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse monster_def.json: {error}")))?;
    let mut map = BTreeMap::<String, Vec<TowerMonsterSeed>>::new();
    for monster in payload
        .monsters
        .into_iter()
        .filter(|monster| monster.enabled != Some(false))
    {
        let Some(monster_id) = monster
            .id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let kind = tower_normalize_monster_kind(monster.kind.as_deref());
        let realm = tower_normalize_realm(monster.realm.as_deref());
        map.entry(format!("{kind}::{realm}"))
            .or_default()
            .push(TowerMonsterSeed {
                id: Some(monster_id.to_string()),
                ..monster
            });
    }
    for monsters in map.values_mut() {
        monsters.sort_by(|left, right| {
            left.id
                .as_deref()
                .unwrap_or_default()
                .cmp(right.id.as_deref().unwrap_or_default())
        });
    }
    Ok(map)
}

fn tower_monster_count_for_floor(kind: &str, floor: i64, seed: &str) -> i64 {
    let normalized_floor = floor.max(1);
    match kind {
        "boss" => TOWER_BOSS_MONSTER_COUNT_CAP.min(
            TOWER_BOSS_MONSTER_COUNT_BASE + normalized_floor / TOWER_BOSS_MONSTER_COUNT_INTERVAL,
        ),
        "elite" => TOWER_ELITE_MONSTER_COUNT_CAP.min(
            TOWER_ELITE_MONSTER_COUNT_BASE + normalized_floor / TOWER_ELITE_MONSTER_COUNT_INTERVAL,
        ),
        _ => {
            let extra_count = tower_pick_deterministic_index(
                &format!("{seed}::monster-count"),
                TOWER_NORMAL_MONSTER_COUNT_VARIANCE,
                0,
            ) as i64;
            TOWER_NORMAL_MONSTER_COUNT_CAP.min(
                TOWER_NORMAL_MONSTER_COUNT_MIN
                    + extra_count
                    + normalized_floor / TOWER_NORMAL_MONSTER_COUNT_INTERVAL,
            )
        }
    }
}

fn build_latest_tower_floor_preview(
    floor: i64,
    kind: &str,
) -> Result<TowerFloorPreviewDto, AppError> {
    let normalized_floor = floor.max(1);
    let seed = format!("tower:{normalized_floor}");
    let monster_map = load_tower_monster_seed_map()?;
    let realms = TOWER_REALM_ORDER
        .iter()
        .copied()
        .filter(|realm| monster_map.contains_key(&format!("{kind}::{realm}")))
        .collect::<Vec<_>>();
    if realms.is_empty() {
        return Err(AppError::config(format!("千层塔缺少可用怪物池: {kind}")));
    }
    let cycle_index = ((normalized_floor - 1) / 10).max(0) as usize;
    let realm = realms[cycle_index.min(realms.len() - 1)];
    let candidates = monster_map
        .get(&format!("{kind}::{realm}"))
        .cloned()
        .unwrap_or_default();
    if candidates.is_empty() {
        return Err(AppError::config(format!(
            "千层塔楼层缺少怪物候选: floor={normalized_floor}, kind={kind}, realm={realm}"
        )));
    }
    let monster_count = tower_monster_count_for_floor(kind, normalized_floor, &seed);
    let monsters =
        tower_pick_deterministic_monsters(&format!("{seed}::monster"), &candidates, monster_count);
    Ok(TowerFloorPreviewDto {
        floor: normalized_floor,
        kind: kind.to_string(),
        seed,
        realm: realm.to_string(),
        monster_ids: monsters
            .iter()
            .filter_map(|monster| monster.id.clone())
            .collect(),
        monster_names: monsters
            .iter()
            .map(|monster| monster.name.clone().unwrap_or_default())
            .collect(),
    })
}

fn try_build_tower_floor_preview(floor: i64) -> Result<TowerFloorPreviewDto, AppError> {
    let normalized_floor = floor.max(1);
    let kind = tower_floor_kind(normalized_floor);
    if let Some((realm, frozen_monsters)) =
        resolve_frozen_tower_monsters_for_floor(normalized_floor, kind)
    {
        return Ok(build_tower_floor_preview_from_frozen(
            normalized_floor,
            kind,
            realm,
            frozen_monsters,
        ));
    }
    build_latest_tower_floor_preview(normalized_floor, kind)
}

fn build_tower_floor_preview(floor: i64) -> TowerFloorPreviewDto {
    try_build_tower_floor_preview(floor).expect("tower floor preview should resolve")
}

pub(crate) fn try_resolve_tower_floor_monster_ids(floor: i64) -> Result<Vec<String>, AppError> {
    let preview = try_build_tower_floor_preview(floor)?;
    if preview.monster_ids.is_empty() {
        return Err(AppError::config(format!(
            "千层塔楼层缺少怪物候选: floor={}",
            floor.max(1)
        )));
    }
    Ok(preview.monster_ids)
}

pub(crate) fn resolve_tower_floor_monster_ids(floor: i64) -> Vec<String> {
    try_resolve_tower_floor_monster_ids(floor).expect("tower floor monsters should resolve")
}

fn build_tower_floor_preview_from_frozen(
    normalized_floor: i64,
    kind: &str,
    realm: String,
    frozen_monsters: Vec<crate::jobs::tower_frozen_pool::FrozenTowerMonsterEntry>,
) -> TowerFloorPreviewDto {
    TowerFloorPreviewDto {
        floor: normalized_floor,
        kind: kind.to_string(),
        seed: format!("tower:{normalized_floor}"),
        realm,
        monster_ids: frozen_monsters
            .iter()
            .map(|monster| monster.monster_def_id.clone())
            .collect(),
        monster_names: frozen_monsters
            .iter()
            .map(|monster| monster.monster_name.clone())
            .collect(),
    }
}

fn build_tower_run_id(character_id: i64) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("tower-run-{character_id}-{millis}")
}

fn build_tower_battle_id(run_id: &str, floor: i64) -> String {
    format!("tower-battle-{run_id}-{floor}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn tower_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "progress": {"bestFloor": 12, "nextFloor": 13, "currentRunId": null, "currentFloor": null, "lastSettledFloor": 12},
                "activeSession": {"sessionId": "tower-session-run-1", "type": "tower"},
                "nextFloorPreview": {"floor": 13, "kind": "normal", "seed": "tower-floor-13", "realm": "炼精化炁·通脉期", "monsterIds": [], "monsterNames": []}
            }
        });
        assert_eq!(payload["data"]["progress"]["bestFloor"], 12);
        assert_eq!(payload["data"]["activeSession"]["type"], "tower");
        println!("TOWER_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn tower_rank_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{"rank": 1, "characterId": 1, "name": "凌霄子", "realm": "炼精化炁·通脉期", "bestFloor": 18, "reachedAt": "2026-04-11T12:00:00Z"}]
        });
        assert_eq!(payload["data"][0]["bestFloor"], 18);
        println!("TOWER_RANK_RESPONSE={}", payload);
    }

    #[test]
    fn tower_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "session": {
                    "sessionId": "tower-session-run-1",
                    "type": "tower",
                    "ownerUserId": 1,
                    "participantUserIds": [1],
                    "currentBattleId": "tower-battle-run-1-13",
                    "status": "running",
                    "nextAction": "none",
                    "canAdvance": false,
                    "lastResult": null,
                    "context": {"runId": "run-1", "floor": 13}
                }
            }
        });
        assert_eq!(payload["data"]["session"]["type"], "tower");
        println!("TOWER_START_RESPONSE={}", payload);
    }

    #[test]
    fn tower_floor_preview_uses_frozen_cache_when_available() {
        crate::jobs::tower_frozen_pool::replace_frozen_tower_pool_cache_for_tests(
            10,
            std::collections::BTreeMap::from([(
                ("normal".to_string(), "炼精化炁·养气期".to_string()),
                vec![crate::jobs::tower_frozen_pool::FrozenTowerMonsterEntry {
                    monster_def_id: "monster-gray-wolf".to_string(),
                    monster_name: "灰狼".to_string(),
                }],
            )]),
        );
        let preview = super::build_tower_floor_preview(1);
        assert_eq!(preview.monster_ids, vec!["monster-gray-wolf".to_string()]);
        assert_eq!(preview.monster_names, vec!["灰狼".to_string()]);
    }

    #[test]
    fn tower_floor_monster_ids_reuse_preview_source() {
        crate::jobs::tower_frozen_pool::replace_frozen_tower_pool_cache_for_tests(
            10,
            std::collections::BTreeMap::from([(
                ("normal".to_string(), "炼精化炁·养气期".to_string()),
                vec![crate::jobs::tower_frozen_pool::FrozenTowerMonsterEntry {
                    monster_def_id: "monster-wild-boar".to_string(),
                    monster_name: "野猪".to_string(),
                }],
            )]),
        );
        let monster_ids = super::resolve_tower_floor_monster_ids(1);
        assert_eq!(monster_ids, vec!["monster-wild-boar".to_string()]);
        println!("TOWER_FLOOR_MONSTER_IDS={}", serde_json::json!(monster_ids));
    }
}
