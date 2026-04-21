use std::fs;
use std::path::PathBuf;

use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::battle_runtime::MinimalBattleRewardItemDto;
use crate::http::achievement::record_dungeon_clear_achievement_event;
use crate::http::task::record_dungeon_clear_task_event;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    CharacterItemGrantDelta, buffer_character_item_grant_deltas,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::realtime::public_socket::emit_game_character_full_to_user;
use crate::shared::error::AppError;
use crate::state::AppState;

const ONLINE_BATTLE_SETTLEMENT_TICK_MS: u64 = 1_500;
const ONLINE_BATTLE_SETTLEMENT_STALE_RUNNING_SEC: i64 = 600;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnlineBattleSettlementTaskKind {
    DungeonClearV1,
    ArenaBattleV1,
    GenericPveV1,
    TowerWinV1,
}

impl OnlineBattleSettlementTaskKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::DungeonClearV1 => "dungeon_clear_v1",
            Self::ArenaBattleV1 => "arena_battle_v1",
            Self::GenericPveV1 => "generic_pve_v1",
            Self::TowerWinV1 => "tower_win_v1",
        }
    }

    fn from_str(raw: &str) -> Option<Self> {
        match raw.trim() {
            "dungeon_clear_v1" => Some(Self::DungeonClearV1),
            "arena_battle_v1" => Some(Self::ArenaBattleV1),
            "generic_pve_v1" => Some(Self::GenericPveV1),
            "tower_win_v1" => Some(Self::TowerWinV1),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericPveSettlementTaskPayload {
    pub schema_version: i64,
    pub character_id: i64,
    pub user_id: i64,
    pub exp_gained: i64,
    pub silver_gained: i64,
    pub reward_items: Vec<MinimalBattleRewardItemDto>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TowerWinSettlementTaskPayload {
    pub schema_version: i64,
    pub character_id: i64,
    pub user_id: i64,
    pub run_id: String,
    pub floor: i64,
    pub exp_gained: i64,
    pub silver_gained: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonSettlementRewardRecipient {
    pub character_id: i64,
    pub user_id: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonClearSettlementTaskPayload {
    pub instance_id: String,
    pub dungeon_id: String,
    pub difficulty_id: String,
    pub reward_recipients: Vec<DungeonSettlementRewardRecipient>,
    pub participant_character_ids: Vec<i64>,
    pub participant_user_ids: Vec<i64>,
    pub time_spent_sec: i64,
    pub total_damage: i64,
    pub death_count: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DungeonSettlementRewardItem {
    pub item_def_id: String,
    pub qty: i64,
    pub item_ids: Vec<i64>,
}

#[derive(Debug, serde::Deserialize)]
struct DungeonSeedFile {
    dungeons: Vec<DungeonSeedEntry>,
}

#[derive(Debug, serde::Deserialize)]
struct DungeonSeedEntry {
    difficulties: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArenaBattleSettlementTaskPayload {
    pub schema_version: i64,
    pub challenger_character_id: i64,
    pub opponent_character_id: i64,
    pub battle_result: String,
}

#[derive(Debug, Clone)]
pub struct OnlineBattleSettlementTaskRow {
    pub id: String,
    pub battle_id: String,
    pub kind: OnlineBattleSettlementTaskKind,
    pub status: String,
    pub attempt_count: i64,
    pub max_attempts: i64,
    pub payload: serde_json::Value,
}

pub async fn enqueue_dungeon_clear_settlement_task(
    state: &AppState,
    battle_id: &str,
    payload: &DungeonClearSettlementTaskPayload,
) -> Result<(), AppError> {
    let task_id = format!("dungeon-clear:{}", payload.instance_id.trim());
    let kind = OnlineBattleSettlementTaskKind::DungeonClearV1;
    let payload_json = serde_json::to_value(payload).map_err(|error| {
        AppError::config(format!(
            "failed to serialize dungeon settlement payload: {error}"
        ))
    })?;
    state.database.execute(
        "INSERT INTO online_battle_settlement_task (id, battle_id, kind, status, attempt_count, max_attempts, payload, created_at, updated_at) VALUES ($1, $2, $3, 'pending', 0, 5, $4::jsonb, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&task_id).bind(battle_id.trim()).bind(kind.as_str()).bind(payload_json),
    ).await?;
    Ok(())
}

pub async fn enqueue_arena_battle_settlement_task(
    state: &AppState,
    battle_id: &str,
    payload: &ArenaBattleSettlementTaskPayload,
) -> Result<(), AppError> {
    let task_id = format!("arena-battle:{}", battle_id.trim());
    let kind = OnlineBattleSettlementTaskKind::ArenaBattleV1;
    let payload_json = serde_json::to_value(payload).map_err(|error| {
        AppError::config(format!(
            "failed to serialize arena settlement payload: {error}"
        ))
    })?;
    state.database.execute(
        "INSERT INTO online_battle_settlement_task (id, battle_id, kind, status, attempt_count, max_attempts, payload, created_at, updated_at) VALUES ($1, $2, $3, 'pending', 0, 5, $4::jsonb, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&task_id).bind(battle_id.trim()).bind(kind.as_str()).bind(payload_json),
    ).await?;
    Ok(())
}

pub async fn enqueue_generic_pve_settlement_task(
    state: &AppState,
    battle_id: &str,
    payload: &GenericPveSettlementTaskPayload,
) -> Result<(), AppError> {
    let task_id = format!("generic-pve:{battle_id}");
    let kind = OnlineBattleSettlementTaskKind::GenericPveV1;
    let payload_json = serde_json::to_value(payload).map_err(|error| {
        AppError::config(format!(
            "failed to serialize generic pve settlement payload: {error}"
        ))
    })?;
    state.database.execute(
        "INSERT INTO online_battle_settlement_task (id, battle_id, kind, status, attempt_count, max_attempts, payload, created_at, updated_at) VALUES ($1, $2, $3, 'pending', 0, 5, $4::jsonb, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&task_id).bind(battle_id.trim()).bind(kind.as_str()).bind(payload_json),
    ).await?;
    Ok(())
}

pub async fn enqueue_tower_win_settlement_task(
    state: &AppState,
    battle_id: &str,
    payload: &TowerWinSettlementTaskPayload,
) -> Result<(), AppError> {
    let task_id = format!("tower-win:{battle_id}");
    let kind = OnlineBattleSettlementTaskKind::TowerWinV1;
    let payload_json = serde_json::to_value(payload).map_err(|error| {
        AppError::config(format!(
            "failed to serialize tower settlement payload: {error}"
        ))
    })?;
    state.database.execute(
        "INSERT INTO online_battle_settlement_task (id, battle_id, kind, status, attempt_count, max_attempts, payload, created_at, updated_at) VALUES ($1, $2, $3, 'pending', 0, 5, $4::jsonb, NOW(), NOW()) ON CONFLICT (id) DO NOTHING",
        |q| q.bind(&task_id).bind(battle_id.trim()).bind(kind.as_str()).bind(payload_json),
    ).await?;
    Ok(())
}

pub async fn recover_pending_online_battle_settlement_tasks(state: AppState) -> anyhow::Result<()> {
    state.database.execute(
        "UPDATE online_battle_settlement_task SET status = 'failed', error_message = COALESCE(error_message, 'stale running task recovered'), updated_at = NOW() WHERE status = 'running' AND updated_at <= NOW() - (($1::text || ' seconds')::interval)",
        |q| q.bind(ONLINE_BATTLE_SETTLEMENT_STALE_RUNNING_SEC),
    ).await?;
    Ok(())
}

pub fn spawn_online_battle_settlement_loop(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = run_online_battle_settlement_tick(&state).await {
                tracing::error!(error = %error, "online battle settlement tick failed");
            }
            sleep(Duration::from_millis(ONLINE_BATTLE_SETTLEMENT_TICK_MS)).await;
        }
    });
}

pub async fn run_online_battle_settlement_tick(state: &AppState) -> Result<(), AppError> {
    let Some(task) = claim_next_online_battle_settlement_task(state).await? else {
        return Ok(());
    };
    match process_online_battle_settlement_task(state, &task).await {
        Ok(()) => mark_online_battle_settlement_task_completed(state, &task.id).await,
        Err(error) => {
            mark_online_battle_settlement_task_failed(
                state,
                &task.id,
                task.attempt_count + 1,
                &error.to_string(),
            )
            .await
        }
    }
}

async fn claim_next_online_battle_settlement_task(
    state: &AppState,
) -> Result<Option<OnlineBattleSettlementTaskRow>, AppError> {
    let row = state.database.fetch_optional(
        "UPDATE online_battle_settlement_task SET status = 'running', attempt_count = attempt_count + 1, error_message = NULL, updated_at = NOW() WHERE id = (SELECT id FROM online_battle_settlement_task WHERE status IN ('pending', 'failed') AND attempt_count < max_attempts ORDER BY updated_at ASC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, battle_id, kind, status, attempt_count, max_attempts, payload",
        |q| q,
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let kind_raw = row
        .try_get::<Option<String>, _>("kind")?
        .unwrap_or_default();
    let Some(kind) = OnlineBattleSettlementTaskKind::from_str(&kind_raw) else {
        return Ok(None);
    };
    let payload_value = row
        .try_get::<Option<serde_json::Value>, _>("payload")?
        .unwrap_or_default();
    Ok(Some(OnlineBattleSettlementTaskRow {
        id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
        battle_id: row
            .try_get::<Option<String>, _>("battle_id")?
            .unwrap_or_default(),
        kind,
        status: row
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_default(),
        attempt_count: row
            .try_get::<Option<i32>, _>("attempt_count")?
            .map(i64::from)
            .unwrap_or_default(),
        max_attempts: row
            .try_get::<Option<i32>, _>("max_attempts")?
            .map(i64::from)
            .unwrap_or(5),
        payload: payload_value,
    }))
}

async fn process_online_battle_settlement_task(
    state: &AppState,
    task: &OnlineBattleSettlementTaskRow,
) -> Result<(), AppError> {
    match task.kind {
        OnlineBattleSettlementTaskKind::DungeonClearV1 => {
            let payload =
                serde_json::from_value::<DungeonClearSettlementTaskPayload>(task.payload.clone())
                    .map_err(|error| {
                    AppError::config(format!(
                        "failed to deserialize dungeon settlement payload: {error}"
                    ))
                })?;
            apply_dungeon_clear_settlement(state, &payload).await
        }
        OnlineBattleSettlementTaskKind::ArenaBattleV1 => {
            let payload =
                serde_json::from_value::<ArenaBattleSettlementTaskPayload>(task.payload.clone())
                    .map_err(|error| {
                        AppError::config(format!(
                            "failed to deserialize arena settlement payload: {error}"
                        ))
                    })?;
            apply_arena_battle_settlement(state, &task.battle_id, &payload).await
        }
        OnlineBattleSettlementTaskKind::GenericPveV1 => {
            let payload =
                serde_json::from_value::<GenericPveSettlementTaskPayload>(task.payload.clone())
                    .map_err(|error| {
                        AppError::config(format!(
                            "failed to deserialize generic pve settlement payload: {error}"
                        ))
                    })?;
            apply_generic_pve_settlement(state, &payload).await
        }
        OnlineBattleSettlementTaskKind::TowerWinV1 => {
            let payload =
                serde_json::from_value::<TowerWinSettlementTaskPayload>(task.payload.clone())
                    .map_err(|error| {
                        AppError::config(format!(
                            "failed to deserialize tower settlement payload: {error}"
                        ))
                    })?;
            apply_tower_win_settlement(state, &payload).await
        }
    }
}

async fn apply_character_battle_rewards(
    state: &AppState,
    character_id: i64,
    exp_gained: i64,
    silver_gained: i64,
) -> Result<(), AppError> {
    if exp_gained <= 0 && silver_gained <= 0 {
        return Ok(());
    }
    state.database.execute(
        "UPDATE characters SET exp = COALESCE(exp, 0) + $2, silver = COALESCE(silver, 0) + $3, updated_at = NOW() WHERE id = $1",
        |q| q.bind(character_id).bind(exp_gained.max(0)).bind(silver_gained.max(0)),
    ).await?;
    Ok(())
}

async fn apply_generic_pve_settlement(
    state: &AppState,
    payload: &GenericPveSettlementTaskPayload,
) -> Result<(), AppError> {
    if payload.character_id <= 0 || payload.user_id <= 0 {
        return Err(AppError::config(
            "generic pve settlement payload missing actor",
        ));
    }
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_resource_delta_fields(
                &redis,
                &[
                    CharacterResourceDeltaField {
                        character_id: payload.character_id,
                        field: "exp".to_string(),
                        increment: payload.exp_gained.max(0),
                    },
                    CharacterResourceDeltaField {
                        character_id: payload.character_id,
                        field: "silver".to_string(),
                        increment: payload.silver_gained.max(0),
                    },
                ],
            )
            .await?;
            let deltas = payload
                .reward_items
                .iter()
                .filter_map(|reward_item| {
                    (!reward_item.item_def_id.trim().is_empty() && reward_item.qty > 0).then(|| {
                        CharacterItemGrantDelta {
                            character_id: payload.character_id,
                            user_id: payload.user_id,
                            item_def_id: reward_item.item_def_id.clone(),
                            qty: reward_item.qty,
                            bind_type: reward_item.bind_type.clone(),
                            obtained_from: "battle_drop".to_string(),
                            obtained_ref_id: Some("generic_pve_v1".to_string()),
                        }
                    })
                })
                .collect::<Vec<_>>();
            buffer_character_item_grant_deltas(&redis, &deltas).await?;
        }
    } else {
        apply_character_battle_rewards(
            state,
            payload.character_id,
            payload.exp_gained,
            payload.silver_gained,
        )
        .await?;
        for reward_item in &payload.reward_items {
            if reward_item.item_def_id.trim().is_empty() || reward_item.qty <= 0 {
                continue;
            }
            state.database.execute(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, 'bag', NOW(), NOW(), 'battle_drop', 'generic_pve_v1')",
                |q| q
                    .bind(payload.user_id)
                    .bind(payload.character_id)
                    .bind(reward_item.item_def_id.as_str())
                    .bind(reward_item.qty)
                    .bind(reward_item.bind_type.as_str()),
            ).await?;
        }
    }
    let _ = emit_game_character_full_to_user(state, payload.user_id).await;
    Ok(())
}

async fn apply_tower_progress_on_win(
    state: &AppState,
    character_id: i64,
    run_id: &str,
    floor: i64,
) -> Result<(), AppError> {
    let settled_floor = floor.max(1);
    let next_floor = settled_floor.saturating_add(1);
    state.database.execute(
        "UPDATE character_tower_progress SET best_floor = GREATEST(COALESCE(best_floor, 0), $2), next_floor = GREATEST(COALESCE(next_floor, 1), $3), current_run_id = $4, current_floor = $2, current_battle_id = NULL, last_settled_floor = GREATEST(COALESCE(last_settled_floor, 0), $2), reached_at = CASE WHEN COALESCE(best_floor, 0) < $2 THEN NOW() ELSE reached_at END, updated_at = NOW() WHERE character_id = $1",
        |q| q.bind(character_id).bind(settled_floor).bind(next_floor).bind(run_id),
    ).await?;
    Ok(())
}

async fn apply_tower_win_settlement(
    state: &AppState,
    payload: &TowerWinSettlementTaskPayload,
) -> Result<(), AppError> {
    if payload.character_id <= 0 || payload.user_id <= 0 || payload.run_id.trim().is_empty() {
        return Err(AppError::config(
            "tower settlement payload missing actor or run",
        ));
    }
    apply_character_battle_rewards(
        state,
        payload.character_id,
        payload.exp_gained,
        payload.silver_gained,
    )
    .await?;
    apply_tower_progress_on_win(state, payload.character_id, &payload.run_id, payload.floor)
        .await?;
    let _ = emit_game_character_full_to_user(state, payload.user_id).await;
    Ok(())
}

async fn apply_dungeon_clear_settlement(
    state: &AppState,
    payload: &DungeonClearSettlementTaskPayload,
) -> Result<(), AppError> {
    let reward_recipients = if payload.reward_recipients.is_empty() {
        payload
            .participant_character_ids
            .iter()
            .copied()
            .zip(payload.participant_user_ids.iter().copied())
            .filter(|(character_id, user_id)| *character_id > 0 && *user_id > 0)
            .map(|(character_id, user_id)| DungeonSettlementRewardRecipient {
                character_id,
                user_id,
            })
            .collect::<Vec<_>>()
    } else {
        payload.reward_recipients.clone()
    };
    let participant_count = reward_recipients.len() as i64;

    let first_clear_reward_defs =
        load_dungeon_first_clear_reward_items(&payload.dungeon_id, &payload.difficulty_id)?;

    for recipient in reward_recipients {
        if recipient.character_id <= 0 || recipient.user_id <= 0 {
            continue;
        }
        let already_cleared_before = state.database.fetch_optional(
            "SELECT 1 FROM dungeon_record WHERE character_id = $1 AND dungeon_id = $2 AND difficulty_id = $3 AND result = 'cleared' AND instance_id <> $4 LIMIT 1",
            |q| q.bind(recipient.character_id).bind(&payload.dungeon_id).bind(&payload.difficulty_id).bind(&payload.instance_id),
        ).await?.is_some();
        let inserted = state.database.fetch_optional(
            "INSERT INTO dungeon_record (character_id, dungeon_id, difficulty_id, instance_id, result, time_spent_sec, damage_dealt, death_count, rewards, is_first_clear, completed_at) SELECT $1, $2, $3, $4, 'cleared', $5, $6, $7, '{}'::jsonb, FALSE, NOW() WHERE NOT EXISTS (SELECT 1 FROM dungeon_record WHERE character_id = $1 AND instance_id = $4 AND result = 'cleared') RETURNING character_id",
            |q| q.bind(recipient.character_id).bind(&payload.dungeon_id).bind(&payload.difficulty_id).bind(&payload.instance_id).bind(payload.time_spent_sec).bind(payload.total_damage).bind(payload.death_count),
        ).await?;
        if inserted.is_none() {
            continue;
        }

        let is_first_clear = !already_cleared_before;
        let mut granted_items = Vec::new();
        if is_first_clear {
            for reward in &first_clear_reward_defs {
                if reward.item_def_id.trim().is_empty() || reward.qty <= 0 {
                    continue;
                }
                let row = state.database.fetch_one(
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'dungeon_clear_reward', $5) RETURNING id",
                    |q| q.bind(recipient.user_id).bind(recipient.character_id).bind(&reward.item_def_id).bind(reward.qty).bind(&payload.instance_id),
                ).await?;
                let item_id = row.try_get::<Option<i64>, _>("id")?.unwrap_or_default();
                granted_items.push(DungeonSettlementRewardItem {
                    item_def_id: reward.item_def_id.clone(),
                    qty: reward.qty,
                    item_ids: if item_id > 0 {
                        vec![item_id]
                    } else {
                        Vec::new()
                    },
                });
            }
        }

        let rewards_json = serde_json::json!({
            "exp": 0,
            "silver": 0,
            "items": granted_items,
            "isFirstClear": is_first_clear,
        });
        state.database.execute(
            "UPDATE dungeon_record SET rewards = $3::jsonb, is_first_clear = $4, completed_at = NOW() WHERE character_id = $1 AND instance_id = $2 AND result = 'cleared'",
            |q| q.bind(recipient.character_id).bind(&payload.instance_id).bind(rewards_json).bind(is_first_clear),
        ).await?;
        record_dungeon_clear_task_event(
            state,
            recipient.character_id,
            recipient.user_id,
            &payload.dungeon_id,
            1,
        )
        .await?;
        record_dungeon_clear_achievement_event(
            state,
            recipient.character_id,
            recipient.user_id,
            &payload.dungeon_id,
            Some(&payload.difficulty_id),
            participant_count,
            1,
        )
        .await?;
    }
    for user_id in &payload.participant_user_ids {
        if *user_id > 0 {
            let _ = emit_game_character_full_to_user(state, *user_id).await;
        }
    }
    Ok(())
}

fn load_dungeon_first_clear_reward_items(
    dungeon_id: &str,
    difficulty_id: &str,
) -> Result<Vec<DungeonSettlementRewardItem>, AppError> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds");
    let mut paths = fs::read_dir(&base)
        .map_err(|error| {
            AppError::config(format!(
                "failed to read dungeon seed dir {}: {error}",
                base.display()
            ))
        })?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|v| v.to_str())
                .map(|name| name.starts_with("dungeon_") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        let content = fs::read_to_string(&path).map_err(|error| {
            AppError::config(format!("failed to read {}: {error}", path.display()))
        })?;
        let payload: DungeonSeedFile = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        for entry in payload.dungeons {
            for difficulty in entry.difficulties {
                if difficulty
                    .get("dungeon_id")
                    .and_then(|value| value.as_str())
                    != Some(dungeon_id)
                {
                    continue;
                }
                if difficulty.get("id").and_then(|value| value.as_str()) != Some(difficulty_id) {
                    continue;
                }
                return Ok(difficulty
                    .get("first_clear_rewards")
                    .and_then(|value| value.get("items"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|item| DungeonSettlementRewardItem {
                        item_def_id: item
                            .get("item_def_id")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        qty: item
                            .get("qty")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(1)
                            .max(1),
                        item_ids: Vec::new(),
                    })
                    .filter(|item| !item.item_def_id.trim().is_empty())
                    .collect());
            }
        }
    }
    Ok(Vec::new())
}

async fn apply_arena_battle_settlement(
    state: &AppState,
    battle_id: &str,
    payload: &ArenaBattleSettlementTaskPayload,
) -> Result<(), AppError> {
    let challenger_id = payload.challenger_character_id.max(0);
    let opponent_id = payload.opponent_character_id.max(0);
    if challenger_id <= 0 || opponent_id <= 0 {
        return Err(AppError::config(
            "arena settlement payload missing characters",
        ));
    }
    let challenger_before = ensure_arena_rating_row(state, challenger_id).await?;
    let opponent_before = ensure_arena_rating_row(state, opponent_id).await?;
    let (challenger_result, challenger_delta, challenger_after) = compute_arena_rating_change(
        challenger_before,
        opponent_before,
        payload.battle_result.trim(),
    );
    let opposite_battle_result = invert_battle_result(payload.battle_result.trim());
    let (opponent_result, _opponent_delta, opponent_after) =
        compute_arena_rating_change(opponent_before, challenger_before, &opposite_battle_result);

    let inserted = state.database.fetch_optional(
        "INSERT INTO arena_battle (battle_id, challenger_character_id, opponent_character_id, status, result, delta_score, score_before, score_after, created_at, finished_at) VALUES ($1, $2, $3, 'finished', $4, $5, $6, $7, NOW(), NOW()) ON CONFLICT (battle_id) DO NOTHING RETURNING battle_id",
        |q| q.bind(battle_id).bind(challenger_id).bind(opponent_id).bind(&challenger_result).bind(challenger_delta).bind(challenger_before).bind(challenger_after),
    ).await?;
    if inserted.is_none() {
        return Ok(());
    }

    update_arena_rating_row(state, challenger_id, challenger_after, &challenger_result).await?;
    update_arena_rating_row(state, opponent_id, opponent_after, &opponent_result).await?;
    Ok(())
}

async fn ensure_arena_rating_row(state: &AppState, character_id: i64) -> Result<i64, AppError> {
    state.database.execute(
        "INSERT INTO arena_rating (character_id, rating, win_count, lose_count, created_at, updated_at) VALUES ($1, 1000, 0, 0, NOW(), NOW()) ON CONFLICT (character_id) DO NOTHING",
        |q| q.bind(character_id),
    ).await?;
    let row = state
        .database
        .fetch_optional(
            "SELECT rating FROM arena_rating WHERE character_id = $1 LIMIT 1",
            |q| q.bind(character_id),
        )
        .await?;
    Ok(row
        .and_then(|row| row.try_get::<Option<i64>, _>("rating").ok().flatten())
        .unwrap_or(1000))
}

async fn update_arena_rating_row(
    state: &AppState,
    character_id: i64,
    rating: i64,
    result: &str,
) -> Result<(), AppError> {
    let win_inc = i64::from(result == "win");
    let lose_inc = i64::from(result == "lose");
    state.database.execute(
        "UPDATE arena_rating SET rating = $2, win_count = win_count + $3, lose_count = lose_count + $4, last_battle_at = NOW(), updated_at = NOW() WHERE character_id = $1",
        |q| q.bind(character_id).bind(rating).bind(win_inc).bind(lose_inc),
    ).await?;
    Ok(())
}

fn compute_arena_rating_change(
    self_rating: i64,
    opponent_rating: i64,
    battle_result: &str,
) -> (String, i64, i64) {
    let expected = 1.0 / (1.0 + 10_f64.powf((opponent_rating - self_rating) as f64 / 400.0));
    let (result, delta) = match battle_result {
        "attacker_win" => ("win".to_string(), (20.0 * (1.0 - expected)).round() as i64),
        "defender_win" => ("lose".to_string(), -((10.0 * expected).round() as i64)),
        _ => ("draw".to_string(), 0),
    };
    let normalized_delta = if result == "win" {
        delta.max(1)
    } else if result == "lose" {
        delta.min(-1)
    } else {
        0
    };
    (result, normalized_delta, self_rating + normalized_delta)
}

fn invert_battle_result(result: &str) -> String {
    match result {
        "attacker_win" => "defender_win".to_string(),
        "defender_win" => "attacker_win".to_string(),
        _ => "draw".to_string(),
    }
}

async fn mark_online_battle_settlement_task_failed(
    state: &AppState,
    task_id: &str,
    attempt_count: i64,
    error_message: &str,
) -> Result<(), AppError> {
    state.database.execute(
        "UPDATE online_battle_settlement_task SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'failed' END, error_message = $2, updated_at = NOW() WHERE id = $1",
        |q| q.bind(task_id).bind(error_message),
    ).await?;
    let _ = attempt_count;
    Ok(())
}

async fn mark_online_battle_settlement_task_completed(
    state: &AppState,
    task_id: &str,
) -> Result<(), AppError> {
    state.database.execute(
        "UPDATE online_battle_settlement_task SET status = 'completed', error_message = NULL, updated_at = NOW() WHERE id = $1",
        |q| q.bind(task_id),
    ).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ArenaBattleSettlementTaskPayload, DungeonClearSettlementTaskPayload,
        DungeonSettlementRewardRecipient, GenericPveSettlementTaskPayload,
        OnlineBattleSettlementTaskKind, TowerWinSettlementTaskPayload, compute_arena_rating_change,
        load_dungeon_first_clear_reward_items,
    };
    use crate::battle_runtime::MinimalBattleRewardItemDto;

    const ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL: &str =
        include_str!("../../migrations/20260421145500_ensure_online_battle_settlement_task.sql");

    #[test]
    fn dungeon_settlement_payload_serializes_minimal_shape() {
        let payload = serde_json::to_value(DungeonClearSettlementTaskPayload {
            instance_id: "inst-1".to_string(),
            dungeon_id: "dungeon-1".to_string(),
            difficulty_id: "difficulty-1".to_string(),
            reward_recipients: vec![DungeonSettlementRewardRecipient {
                character_id: 1,
                user_id: 11,
            }],
            participant_character_ids: vec![1, 2],
            participant_user_ids: vec![11, 22],
            time_spent_sec: 90,
            total_damage: 12345,
            death_count: 1,
        })
        .expect("payload should serialize");
        assert_eq!(payload["instanceId"], "inst-1");
        assert_eq!(payload["participantCharacterIds"][0], 1);
        assert_eq!(payload["timeSpentSec"], 90);
        assert_eq!(payload["totalDamage"], 12345);
        assert_eq!(payload["deathCount"], 1);
        assert_eq!(payload["rewardRecipients"][0]["characterId"], 1);
        assert_eq!(
            OnlineBattleSettlementTaskKind::DungeonClearV1.as_str(),
            "dungeon_clear_v1"
        );
        println!("ONLINE_BATTLE_SETTLEMENT_PAYLOAD={payload}");
    }

    #[test]
    fn dungeon_first_clear_reward_loader_reads_seed_items() {
        let rewards =
            load_dungeon_first_clear_reward_items("dungeon-qiqi-wolf-den", "dd-qiqi-wolf-den-n")
                .expect("dungeon first clear rewards should load");
        assert_eq!(rewards.len(), 3);
        assert_eq!(rewards[0].item_def_id, "cons-001");
        assert_eq!(rewards[0].qty, 4);
        println!(
            "DUNGEON_FIRST_CLEAR_REWARDS={}",
            serde_json::to_value(rewards).expect("rewards should serialize")
        );
    }

    #[test]
    fn arena_settlement_payload_and_delta_match_minimal_formula() {
        let payload = serde_json::to_value(ArenaBattleSettlementTaskPayload {
            schema_version: 1,
            challenger_character_id: 1,
            opponent_character_id: 2,
            battle_result: "attacker_win".to_string(),
        })
        .expect("payload should serialize");
        let (result, delta, after) = compute_arena_rating_change(1000, 1000, "attacker_win");
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["battleResult"], "attacker_win");
        assert_eq!(
            OnlineBattleSettlementTaskKind::ArenaBattleV1.as_str(),
            "arena_battle_v1"
        );
        assert_eq!(result, "win");
        assert_eq!(delta, 10);
        assert_eq!(after, 1010);
        println!("ONLINE_ARENA_SETTLEMENT_PAYLOAD={payload}");
    }

    #[test]
    fn generic_pve_and_tower_settlement_payloads_serialize_minimal_shape() {
        let pve = serde_json::to_value(GenericPveSettlementTaskPayload {
            schema_version: 1,
            character_id: 11,
            user_id: 22,
            exp_gained: 33,
            silver_gained: 44,
            reward_items: vec![MinimalBattleRewardItemDto {
                item_def_id: "mat-005".to_string(),
                item_name: "铁木芯".to_string(),
                qty: 1,
                bind_type: "none".to_string(),
            }],
        })
        .expect("generic pve payload should serialize");
        let tower = serde_json::to_value(TowerWinSettlementTaskPayload {
            schema_version: 1,
            character_id: 11,
            user_id: 22,
            run_id: "tower-run-1".to_string(),
            floor: 13,
            exp_gained: 33,
            silver_gained: 44,
        })
        .expect("tower payload should serialize");
        assert_eq!(pve["characterId"], 11);
        assert_eq!(pve["expGained"], 33);
        assert_eq!(pve["rewardItems"][0]["itemDefId"], "mat-005");
        assert_eq!(tower["runId"], "tower-run-1");
        assert_eq!(tower["floor"], 13);
        assert_eq!(
            OnlineBattleSettlementTaskKind::GenericPveV1.as_str(),
            "generic_pve_v1"
        );
        assert_eq!(
            OnlineBattleSettlementTaskKind::TowerWinV1.as_str(),
            "tower_win_v1"
        );
    }

    #[test]
    fn settlement_schema_migration_covers_required_columns_and_indexes() {
        assert!(
            ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL
                .contains("CREATE TABLE IF NOT EXISTS public.online_battle_settlement_task")
        );
        assert!(
            ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL
                .contains("id character varying(128) PRIMARY KEY")
        );
        assert!(ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL.contains("payload jsonb NOT NULL"));
        assert!(
            ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL
                .contains("updated_at timestamp(6) with time zone DEFAULT now() NOT NULL")
        );
        assert!(
            ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL
                .contains("idx_online_battle_settlement_status")
        );
        assert!(
            ONLINE_BATTLE_SETTLEMENT_REPAIR_MIGRATION_SQL
                .contains("idx_online_battle_settlement_battle")
        );
    }
}
