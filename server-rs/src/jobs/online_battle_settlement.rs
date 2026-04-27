use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use sqlx::Row;
use tokio::time::{Duration, sleep};

use crate::battle_runtime::MinimalBattleRewardItemDto;
use crate::http::achievement::record_dungeon_clear_achievement_event;
use crate::http::inventory::{InventoryDefSeed, load_inventory_def_map};
use crate::http::task::record_dungeon_clear_task_event;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::realtime::public_socket::emit_game_character_full_to_user;
use crate::shared::error::AppError;
use crate::state::AppState;

const ONLINE_BATTLE_SETTLEMENT_TICK_MS: u64 = 1_500;
const ONLINE_BATTLE_SETTLEMENT_STALE_RUNNING_SEC: i64 = 600;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

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
pub struct GenericPveRewardItemGain {
    pub item_def_id: String,
    pub item_name: String,
    pub qty: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericPveRewardItemSettlementResult {
    pub items_gained: Vec<GenericPveRewardItemGain>,
    pub auto_disassemble_silver_gained: i64,
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

#[cfg(test)]
pub async fn run_online_battle_settlement_task_until_completed_for_tests(
    state: &AppState,
    task_id: &str,
    max_ticks: usize,
) -> Result<(), AppError> {
    for _ in 0..max_ticks {
        let snapshot = fetch_online_battle_settlement_task_status_for_tests(state, task_id)
            .await?
            .ok_or_else(|| {
                AppError::config(format!("online battle settlement task missing: {task_id}"))
            })?;
        if snapshot.status == "completed" {
            return Ok(());
        }

        let Some(task) =
            claim_online_battle_settlement_task_by_id_for_tests(state, task_id).await?
        else {
            continue;
        };

        match process_online_battle_settlement_task(state, &task).await {
            Ok(()) => mark_online_battle_settlement_task_completed(state, &task.id).await?,
            Err(error) => {
                mark_online_battle_settlement_task_failed(
                    state,
                    &task.id,
                    task.attempt_count + 1,
                    &error.to_string(),
                )
                .await?;
            }
        }
    }

    let Some(snapshot) =
        fetch_online_battle_settlement_task_status_for_tests(state, task_id).await?
    else {
        return Err(AppError::config(format!(
            "online battle settlement task missing after {max_ticks} ticks: {task_id}"
        )));
    };

    Err(AppError::config(format!(
        "online battle settlement task did not complete after {max_ticks} ticks: task_id={task_id}, status={}, attempt_count={}, max_attempts={}, error_message={:?}",
        snapshot.status, snapshot.attempt_count, snapshot.max_attempts, snapshot.error_message
    )))
}

#[cfg(test)]
struct OnlineBattleSettlementTaskStatusForTests {
    status: String,
    attempt_count: i64,
    max_attempts: i64,
    error_message: Option<String>,
}

#[cfg(test)]
async fn fetch_online_battle_settlement_task_status_for_tests(
    state: &AppState,
    task_id: &str,
) -> Result<Option<OnlineBattleSettlementTaskStatusForTests>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT status, attempt_count, max_attempts, error_message FROM online_battle_settlement_task WHERE id = $1",
            |query| query.bind(task_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(OnlineBattleSettlementTaskStatusForTests {
        status: row.try_get::<String, _>("status")?,
        attempt_count: i64::from(row.try_get::<i32, _>("attempt_count")?),
        max_attempts: i64::from(row.try_get::<i32, _>("max_attempts")?),
        error_message: row.try_get::<Option<String>, _>("error_message")?,
    }))
}

#[cfg(test)]
async fn claim_online_battle_settlement_task_by_id_for_tests(
    state: &AppState,
    task_id: &str,
) -> Result<Option<OnlineBattleSettlementTaskRow>, AppError> {
    let row = state.database.fetch_optional(
        "UPDATE online_battle_settlement_task SET status = 'running', attempt_count = attempt_count + 1, error_message = NULL, updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'failed') AND attempt_count < max_attempts RETURNING id, battle_id, kind, status, attempt_count, max_attempts, payload",
        |q| q.bind(task_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    online_battle_settlement_task_row_from_pg_row(row)
}

fn online_battle_settlement_task_row_from_pg_row(
    row: sqlx::postgres::PgRow,
) -> Result<Option<OnlineBattleSettlementTaskRow>, AppError> {
    let kind_raw = row.try_get::<String, _>("kind")?;
    let Some(kind) = OnlineBattleSettlementTaskKind::from_str(&kind_raw) else {
        return Ok(None);
    };
    Ok(Some(OnlineBattleSettlementTaskRow {
        id: row.try_get::<String, _>("id")?,
        battle_id: row.try_get::<String, _>("battle_id")?,
        kind,
        status: row.try_get::<String, _>("status")?,
        attempt_count: i64::from(row.try_get::<i32, _>("attempt_count")?),
        max_attempts: i64::from(row.try_get::<i32, _>("max_attempts")?),
        payload: row.try_get::<serde_json::Value, _>("payload")?,
    }))
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
    online_battle_settlement_task_row_from_pg_row(row)
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

async fn apply_or_buffer_character_battle_rewards(
    state: &AppState,
    character_id: i64,
    exp_gained: i64,
    silver_gained: i64,
) -> Result<(), AppError> {
    if exp_gained <= 0 && silver_gained <= 0 {
        return Ok(());
    }
    if state.redis_available {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_resource_delta_fields(
                &redis,
                &[
                    CharacterResourceDeltaField {
                        character_id,
                        field: "exp".to_string(),
                        increment: exp_gained.max(0),
                    },
                    CharacterResourceDeltaField {
                        character_id,
                        field: "silver".to_string(),
                        increment: silver_gained.max(0),
                    },
                ],
            )
            .await?;
            return Ok(());
        }
    }
    apply_character_battle_rewards(state, character_id, exp_gained, silver_gained).await
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
    apply_or_buffer_character_battle_rewards(
        state,
        payload.character_id,
        payload.exp_gained,
        payload.silver_gained,
    )
    .await?;
    let defs = load_inventory_def_map()?;
    let mut rng = StdRng::seed_from_u64(generic_pve_reward_seed(payload));
    let mut auto_disassemble_settings = BTreeMap::<i64, AutoDisassembleSetting>::new();
    let mut extra_silver_by_character = BTreeMap::<i64, i64>::new();
    let mut refresh_user_ids = BTreeSet::from([payload.user_id]);
    for reward_item in &payload.reward_items {
        let receiver_character_id = reward_item
            .receiver_character_id
            .filter(|value| *value > 0)
            .unwrap_or(payload.character_id);
        let receiver_user_id = reward_item
            .receiver_user_id
            .filter(|value| *value > 0)
            .unwrap_or(payload.user_id);
        refresh_user_ids.insert(receiver_user_id);
        let receiver_fuyuan = reward_item.receiver_fuyuan.unwrap_or(0.0);
        if !auto_disassemble_settings.contains_key(&receiver_character_id) {
            let setting = load_auto_disassemble_setting(state, receiver_character_id).await?;
            auto_disassemble_settings.insert(receiver_character_id, setting);
        }
        let setting = auto_disassemble_settings
            .get(&receiver_character_id)
            .ok_or_else(|| AppError::config("自动分解配置读取失败"))?;
        let item_settlement = settle_battle_reward_item(
            state,
            &defs,
            setting,
            receiver_character_id,
            receiver_user_id,
            reward_item,
            receiver_fuyuan,
            None,
            &mut rng,
        )
        .await?;
        if item_settlement.auto_disassemble_silver_gained > 0 {
            *extra_silver_by_character
                .entry(receiver_character_id)
                .or_insert(0) += item_settlement.auto_disassemble_silver_gained;
        }
    }
    for (character_id, extra_silver) in extra_silver_by_character {
        if extra_silver > 0 {
            apply_or_buffer_character_battle_rewards(state, character_id, 0, extra_silver).await?;
        }
    }
    for user_id in refresh_user_ids {
        let _ = emit_game_character_full_to_user(state, user_id).await;
    }
    Ok(())
}

pub async fn settle_generic_pve_reward_items(
    state: &AppState,
    payload: &GenericPveSettlementTaskPayload,
    idle_session_id: Option<&str>,
) -> Result<GenericPveRewardItemSettlementResult, AppError> {
    if payload.character_id <= 0 || payload.user_id <= 0 {
        return Err(AppError::config(
            "generic pve settlement payload missing actor",
        ));
    }
    let defs = load_inventory_def_map()?;
    let mut rng = StdRng::seed_from_u64(generic_pve_reward_seed(payload));
    let mut auto_disassemble_settings = BTreeMap::<i64, AutoDisassembleSetting>::new();
    let mut result = GenericPveRewardItemSettlementResult {
        items_gained: Vec::new(),
        auto_disassemble_silver_gained: 0,
    };
    for reward_item in &payload.reward_items {
        let receiver_character_id = reward_item
            .receiver_character_id
            .filter(|value| *value > 0)
            .unwrap_or(payload.character_id);
        let receiver_user_id = reward_item
            .receiver_user_id
            .filter(|value| *value > 0)
            .unwrap_or(payload.user_id);
        let receiver_fuyuan = reward_item.receiver_fuyuan.unwrap_or(0.0);
        if !auto_disassemble_settings.contains_key(&receiver_character_id) {
            let setting = load_auto_disassemble_setting(state, receiver_character_id).await?;
            auto_disassemble_settings.insert(receiver_character_id, setting);
        }
        let setting = auto_disassemble_settings
            .get(&receiver_character_id)
            .ok_or_else(|| AppError::config("自动分解配置读取失败"))?;
        let item_settlement = settle_battle_reward_item(
            state,
            &defs,
            setting,
            receiver_character_id,
            receiver_user_id,
            reward_item,
            receiver_fuyuan,
            idle_session_id,
            &mut rng,
        )
        .await?;
        result.auto_disassemble_silver_gained = result
            .auto_disassemble_silver_gained
            .saturating_add(item_settlement.auto_disassemble_silver_gained);
        merge_generic_pve_item_gains(&mut result.items_gained, item_settlement.items_gained);
    }
    Ok(result)
}

#[derive(Debug, Clone)]
struct AutoDisassembleSetting {
    enabled: bool,
    rules: Vec<AutoDisassembleRuleSet>,
}

#[derive(Debug, Clone)]
struct AutoDisassembleRuleSet {
    categories: Vec<String>,
    sub_categories: Vec<String>,
    excluded_sub_categories: Vec<String>,
    include_name_keywords: Vec<String>,
    exclude_name_keywords: Vec<String>,
    max_quality_rank: i64,
}

#[derive(Debug, Clone)]
struct RewardItemMeta {
    item_name: String,
    category: String,
    sub_category: Option<String>,
    effect_defs: serde_json::Value,
    quality_rank: i64,
    can_disassemble: bool,
}

#[derive(Debug, Clone, Default)]
struct BattleRewardItemSettlementDelta {
    items_gained: Vec<GenericPveRewardItemGain>,
    auto_disassemble_silver_gained: i64,
}

fn merge_generic_pve_item_gains(
    target: &mut Vec<GenericPveRewardItemGain>,
    incoming: Vec<GenericPveRewardItemGain>,
) {
    for item in incoming {
        if item.qty <= 0 || item.item_def_id.trim().is_empty() {
            continue;
        }
        if let Some(existing) = target
            .iter_mut()
            .find(|row| row.item_def_id == item.item_def_id)
        {
            existing.qty = existing.qty.saturating_add(item.qty);
            continue;
        }
        target.push(item);
    }
}

async fn load_auto_disassemble_setting(
    state: &AppState,
    character_id: i64,
) -> Result<AutoDisassembleSetting, AppError> {
    let row = state.database.fetch_optional(
        "SELECT auto_disassemble_enabled, auto_disassemble_rules FROM characters WHERE id = $1 LIMIT 1",
        |q| q.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Err(AppError::config("角色不存在"));
    };
    let enabled = row
        .try_get::<Option<bool>, _>("auto_disassemble_enabled")?
        .unwrap_or(false);
    let rules = row
        .try_get::<Option<serde_json::Value>, _>("auto_disassemble_rules")?
        .unwrap_or_else(|| serde_json::json!([]));
    Ok(AutoDisassembleSetting {
        enabled,
        rules: normalize_auto_disassemble_rule_sets(&rules),
    })
}

async fn settle_battle_reward_item(
    state: &AppState,
    defs: &BTreeMap<String, InventoryDefSeed>,
    setting: &AutoDisassembleSetting,
    character_id: i64,
    user_id: i64,
    reward_item: &MinimalBattleRewardItemDto,
    receiver_fuyuan: f64,
    idle_session_id: Option<&str>,
    rng: &mut StdRng,
) -> Result<BattleRewardItemSettlementDelta, AppError> {
    let item_def_id = reward_item.item_def_id.trim();
    if item_def_id.is_empty() || reward_item.qty <= 0 {
        return Ok(BattleRewardItemSettlementDelta::default());
    }
    let source_meta = reward_item_meta(defs, item_def_id, None)?;
    let bind_type = normalize_bind_type(&reward_item.bind_type);
    if source_meta.category == "equipment" {
        let mut delta = BattleRewardItemSettlementDelta::default();
        for _ in 0..reward_item.qty {
            let (quality, quality_rank) =
                roll_equipment_quality(reward_item.quality_weights.as_ref(), receiver_fuyuan, rng);
            let unit_meta = reward_item_meta(defs, item_def_id, Some((quality, quality_rank)))?;
            if should_auto_disassemble(setting, &unit_meta) {
                let grant_delta = grant_auto_disassemble_rewards(
                    state,
                    defs,
                    user_id,
                    character_id,
                    &unit_meta,
                    1,
                    idle_session_id,
                    rng,
                )
                .await?;
                delta.auto_disassemble_silver_gained = delta
                    .auto_disassemble_silver_gained
                    .saturating_add(grant_delta.auto_disassemble_silver_gained);
                merge_generic_pve_item_gains(&mut delta.items_gained, grant_delta.items_gained);
            } else {
                insert_reward_item_instance(
                    state,
                    defs,
                    user_id,
                    character_id,
                    item_def_id,
                    1,
                    &bind_type,
                    "battle_drop",
                    Some("generic_pve_v1"),
                    Some(quality),
                    Some(quality_rank),
                    idle_session_id,
                    rng,
                )
                .await?;
                delta.items_gained.push(GenericPveRewardItemGain {
                    item_def_id: item_def_id.to_string(),
                    item_name: unit_meta.item_name,
                    qty: 1,
                });
            }
        }
        return Ok(delta);
    }

    if should_auto_disassemble(setting, &source_meta) {
        grant_auto_disassemble_rewards(
            state,
            defs,
            user_id,
            character_id,
            &source_meta,
            reward_item.qty,
            idle_session_id,
            rng,
        )
        .await
    } else {
        insert_reward_item_instance(
            state,
            defs,
            user_id,
            character_id,
            item_def_id,
            reward_item.qty,
            &bind_type,
            "battle_drop",
            Some("generic_pve_v1"),
            None,
            None,
            idle_session_id,
            rng,
        )
        .await?;
        Ok(BattleRewardItemSettlementDelta {
            items_gained: vec![GenericPveRewardItemGain {
                item_def_id: item_def_id.to_string(),
                item_name: source_meta.item_name,
                qty: reward_item.qty,
            }],
            auto_disassemble_silver_gained: 0,
        })
    }
}

async fn grant_auto_disassemble_rewards(
    state: &AppState,
    defs: &BTreeMap<String, InventoryDefSeed>,
    user_id: i64,
    character_id: i64,
    source_meta: &RewardItemMeta,
    qty: i64,
    idle_session_id: Option<&str>,
    rng: &mut StdRng,
) -> Result<BattleRewardItemSettlementDelta, AppError> {
    if qty <= 0 {
        return Ok(BattleRewardItemSettlementDelta::default());
    }
    if source_meta.category == "equipment" {
        let reward_item_def_id = if source_meta.quality_rank <= 2 {
            "enhance-001"
        } else {
            "enhance-002"
        };
        ensure_inventory_def(defs, reward_item_def_id)?;
        insert_reward_item_instance(
            state,
            defs,
            user_id,
            character_id,
            reward_item_def_id,
            qty,
            "none",
            "auto_disassemble",
            Some("generic_pve_v1"),
            None,
            None,
            idle_session_id,
            rng,
        )
        .await?;
        let reward_meta = reward_item_meta(defs, reward_item_def_id, None)?;
        return Ok(BattleRewardItemSettlementDelta {
            items_gained: vec![GenericPveRewardItemGain {
                item_def_id: reward_item_def_id.to_string(),
                item_name: reward_meta.item_name,
                qty,
            }],
            auto_disassemble_silver_gained: 0,
        });
    }
    if is_technique_book_reward(source_meta) {
        let reward_qty = match source_meta.quality_rank {
            1 => 15_i64,
            2 => 30_i64,
            3 => 60_i64,
            _ => 120_i64,
        }
        .saturating_mul(qty);
        ensure_inventory_def(defs, "mat-gongfa-canye")?;
        insert_reward_item_instance(
            state,
            defs,
            user_id,
            character_id,
            "mat-gongfa-canye",
            reward_qty,
            "none",
            "auto_disassemble",
            Some("generic_pve_v1"),
            None,
            None,
            idle_session_id,
            rng,
        )
        .await?;
        let reward_meta = reward_item_meta(defs, "mat-gongfa-canye", None)?;
        return Ok(BattleRewardItemSettlementDelta {
            items_gained: vec![GenericPveRewardItemGain {
                item_def_id: "mat-gongfa-canye".to_string(),
                item_name: reward_meta.item_name,
                qty: reward_qty,
            }],
            auto_disassemble_silver_gained: 0,
        });
    }
    let quality_factor = match source_meta.quality_rank {
        1 => 1.0,
        2 => 1.8,
        3 => 3.0,
        _ => 4.8,
    };
    let unit_silver = ((100.0_f64 * quality_factor) / 10.0_f64).floor() as i64;
    Ok(BattleRewardItemSettlementDelta {
        items_gained: Vec::new(),
        auto_disassemble_silver_gained: unit_silver.max(1).saturating_mul(qty),
    })
}

async fn insert_reward_item_instance(
    state: &AppState,
    defs: &BTreeMap<String, InventoryDefSeed>,
    user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
    bind_type: &str,
    obtained_from: &str,
    obtained_ref_id: Option<&str>,
    quality: Option<&str>,
    quality_rank: Option<i64>,
    idle_session_id: Option<&str>,
    rng: &mut StdRng,
) -> Result<(), AppError> {
    if item_def_id.trim().is_empty() || qty <= 0 {
        return Ok(());
    }
    ensure_inventory_def(defs, item_def_id)?;
    let random_seed = quality.map(|_| rng.gen_range(1_i64..=2_147_483_647_i64));
    let bag_capacity = state
        .database
        .fetch_optional(
            "SELECT bag_capacity FROM inventory WHERE character_id = $1 LIMIT 1 FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?
        .and_then(|row| opt_i64_from_i32(&row, "bag_capacity").ok().flatten())
        .unwrap_or(100)
        .max(1);
    let mut bag_rows = state
        .database
        .fetch_all(
            "SELECT location_slot FROM item_instance WHERE owner_character_id = $1 AND location = 'bag' FOR UPDATE",
            |q| q.bind(character_id),
        )
        .await?
        .into_iter()
        .map(|row| {
            row.try_get::<Option<i32>, _>("location_slot")
                .map(|slot| slot.map(i64::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let Some(slot) = find_first_reward_bag_slot(&bag_rows, bag_capacity) else {
        insert_reward_mail_attachment_instance(
            state,
            user_id,
            character_id,
            item_def_id,
            qty,
            bind_type,
            obtained_from,
            obtained_ref_id,
            quality,
            quality_rank,
            random_seed,
            idle_session_id,
        )
        .await?;
        return Ok(());
    };
    state.database.execute(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, location, location_slot, random_seed, affixes, identified, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'bag', $8, $9, $10::jsonb, TRUE, NOW(), NOW(), $11, $12)",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind(item_def_id.trim())
            .bind(qty.max(1))
            .bind(quality)
            .bind(quality_rank)
            .bind(normalize_bind_type(bind_type))
            .bind(slot)
            .bind(random_seed)
            .bind(serde_json::json!([]))
            .bind(obtained_from)
            .bind(obtained_ref_id),
    ).await?;
    bag_rows.push(Some(slot));
    Ok(())
}

fn find_first_reward_bag_slot(rows: &[Option<i64>], capacity: i64) -> Option<i64> {
    (0..capacity).find(|slot| !rows.iter().any(|value| *value == Some(*slot)))
}

async fn insert_reward_mail_attachment_instance(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    item_def_id: &str,
    qty: i64,
    bind_type: &str,
    obtained_from: &str,
    obtained_ref_id: Option<&str>,
    quality: Option<&str>,
    quality_rank: Option<i64>,
    random_seed: Option<i64>,
    idle_session_id: Option<&str>,
) -> Result<(), AppError> {
    let inserted = state.database.fetch_one(
        "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, quality, quality_rank, bind_type, location, random_seed, affixes, identified, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 'mail', $8, $9::jsonb, TRUE, NOW(), NOW(), $10, $11) RETURNING id",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind(item_def_id.trim())
            .bind(qty.max(1))
            .bind(quality)
            .bind(quality_rank)
            .bind(normalize_bind_type(bind_type))
            .bind(random_seed)
            .bind(serde_json::json!([]))
            .bind(obtained_from)
            .bind(obtained_ref_id),
    ).await?;
    let item_id = inserted.try_get::<i64, _>("id")?;
    state.database.execute(
        "INSERT INTO mail (recipient_user_id, recipient_character_id, sender_type, sender_name, mail_type, title, content, attach_instance_ids, expire_at, source, source_ref_id, metadata, created_at, updated_at) VALUES ($1, $2, 'system', '系统', 'reward', '奖励补发', '由于背包空间不足，部分奖励已通过邮件补发，请前往邮箱领取。', $3::jsonb, NOW() + INTERVAL '30 days', 'battle_drop', $4, $5::jsonb, NOW(), NOW())",
        |q| q
            .bind(user_id)
            .bind(character_id)
            .bind(serde_json::json!([item_id]))
            .bind(obtained_ref_id)
            .bind(serde_json::json!({
                "idleSessionId": idle_session_id,
                "obtainedFrom": obtained_from,
            })),
    ).await?;
    if let Some(idle_session_id) = idle_session_id {
        state.database.execute(
            "UPDATE idle_sessions SET bag_full_flag = true, updated_at = NOW() WHERE id::text = $1",
            |q| q.bind(idle_session_id.trim()),
        ).await?;
    }
    Ok(())
}

fn reward_item_meta(
    defs: &BTreeMap<String, InventoryDefSeed>,
    item_def_id: &str,
    quality_override: Option<(&str, i64)>,
) -> Result<RewardItemMeta, AppError> {
    let def = ensure_inventory_def(defs, item_def_id)?;
    let item_name = def
        .row
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or(item_def_id)
        .to_string();
    let category = def
        .row
        .get("category")
        .and_then(|value| value.as_str())
        .unwrap_or("other")
        .trim()
        .to_string();
    let sub_category = def
        .row
        .get("sub_category")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let effect_defs = def
        .row
        .get("effect_defs")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let quality = quality_override
        .map(|(quality, _)| quality.to_string())
        .or_else(|| {
            def.row
                .get("quality")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| "黄".to_string());
    let quality_rank = quality_override
        .map(|(_, rank)| rank)
        .unwrap_or_else(|| map_quality_rank(&quality));
    let can_disassemble = resolve_item_can_disassemble(&def.row);
    Ok(RewardItemMeta {
        item_name,
        category,
        sub_category,
        effect_defs,
        quality_rank,
        can_disassemble,
    })
}

fn ensure_inventory_def<'a>(
    defs: &'a BTreeMap<String, InventoryDefSeed>,
    item_def_id: &str,
) -> Result<&'a InventoryDefSeed, AppError> {
    defs.get(item_def_id.trim())
        .ok_or_else(|| AppError::config(format!("物品不存在: {}", item_def_id.trim())))
}

fn should_auto_disassemble(setting: &AutoDisassembleSetting, meta: &RewardItemMeta) -> bool {
    if !setting.enabled || !meta.can_disassemble || meta.quality_rank <= 0 {
        return false;
    }
    setting
        .rules
        .iter()
        .any(|rule| auto_disassemble_rule_matches(rule, meta))
}

fn resolve_item_can_disassemble(row: &serde_json::Value) -> bool {
    row.get("disassemblable").and_then(|value| value.as_bool()) != Some(false)
}

fn auto_disassemble_rule_matches(rule: &AutoDisassembleRuleSet, meta: &RewardItemMeta) -> bool {
    if meta.quality_rank > rule.max_quality_rank {
        return false;
    }
    let category = normalize_rule_token(&meta.category);
    let sub_category = meta
        .sub_category
        .as_deref()
        .map(normalize_rule_token)
        .unwrap_or_default();
    let item_name = meta.item_name.trim().to_lowercase();
    let sub_category_matched =
        !rule.sub_categories.is_empty() && rule.sub_categories.contains(&sub_category);
    if !rule.sub_categories.is_empty() && !sub_category_matched {
        return false;
    }
    if !sub_category_matched && !rule.categories.is_empty() && !rule.categories.contains(&category)
    {
        return false;
    }
    if rule.excluded_sub_categories.contains(&sub_category) {
        return false;
    }
    if !rule.include_name_keywords.is_empty()
        && !rule
            .include_name_keywords
            .iter()
            .any(|keyword| item_name.contains(keyword))
    {
        return false;
    }
    !rule
        .exclude_name_keywords
        .iter()
        .any(|keyword| item_name.contains(keyword))
}

fn normalize_auto_disassemble_rule_sets(raw: &serde_json::Value) -> Vec<AutoDisassembleRuleSet> {
    let rows = raw.as_array().cloned().unwrap_or_default();
    let mut out = rows
        .iter()
        .take(20)
        .map(normalize_auto_disassemble_rule_set)
        .collect::<Vec<_>>();
    if out.is_empty() {
        out.push(default_auto_disassemble_rule_set());
    }
    out
}

fn normalize_auto_disassemble_rule_set(raw: &serde_json::Value) -> AutoDisassembleRuleSet {
    AutoDisassembleRuleSet {
        categories: normalize_rule_list(raw.get("categories"), 100, true),
        sub_categories: normalize_rule_list(raw.get("subCategories"), 100, false),
        excluded_sub_categories: normalize_rule_list(raw.get("excludedSubCategories"), 100, false),
        include_name_keywords: normalize_rule_list(raw.get("includeNameKeywords"), 100, false),
        exclude_name_keywords: normalize_rule_list(raw.get("excludeNameKeywords"), 100, false),
        max_quality_rank: raw
            .get("maxQualityRank")
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
            .clamp(1, 4),
    }
}

fn default_auto_disassemble_rule_set() -> AutoDisassembleRuleSet {
    AutoDisassembleRuleSet {
        categories: vec!["equipment".to_string()],
        sub_categories: Vec::new(),
        excluded_sub_categories: Vec::new(),
        include_name_keywords: Vec::new(),
        exclude_name_keywords: Vec::new(),
        max_quality_rank: 1,
    }
}

fn normalize_rule_list(
    raw: Option<&serde_json::Value>,
    max_size: usize,
    use_default_equipment: bool,
) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = raw
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(normalize_rule_token)
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .take(max_size)
        .collect::<Vec<_>>();
    if out.is_empty() && use_default_equipment {
        out.push("equipment".to_string());
    }
    out
}

fn normalize_rule_token(raw: &str) -> String {
    raw.trim().to_lowercase()
}

fn is_technique_book_reward(meta: &RewardItemMeta) -> bool {
    meta.sub_category.as_deref() == Some("technique_book")
        || meta
            .effect_defs
            .as_array()
            .map(|effects| {
                effects.iter().any(|effect| {
                    effect.get("effect_type").and_then(|value| value.as_str())
                        == Some("learn_technique")
                })
            })
            .unwrap_or(false)
}

fn roll_equipment_quality(
    weights: Option<&BTreeMap<String, f64>>,
    fuyuan: f64,
    rng: &mut StdRng,
) -> (&'static str, i64) {
    let qualities = [("黄", 1_i64), ("玄", 2_i64), ("地", 3_i64), ("天", 4_i64)];
    let mut base_weights = BTreeMap::<&'static str, f64>::new();
    for (quality, _) in qualities.iter().copied() {
        let configured = weights
            .and_then(|weights| weights.get(quality))
            .copied()
            .unwrap_or(0.0);
        base_weights.insert(quality, configured.max(0.0));
    }
    if base_weights.values().all(|value| *value <= 0.0) {
        base_weights.insert("黄", 70.0);
        base_weights.insert("玄", 35.0);
        base_weights.insert("地", 17.5);
        base_weights.insert("天", 8.75);
    }
    let capped_fuyuan = fuyuan.clamp(0.0, 200.0);
    let rate = 1.0 + capped_fuyuan * 0.0025;
    let weighted = qualities
        .iter()
        .map(|(quality, rank)| {
            let mut weight = *base_weights.get(quality).unwrap_or(&0.0);
            let diff = *rank - 1;
            if capped_fuyuan > 0.0 && diff > 0 {
                weight *= 1.0 + (rate - 1.0) * diff as f64;
            }
            (*quality, *rank, weight.max(0.0))
        })
        .filter(|(_, _, weight)| *weight > 0.0)
        .collect::<Vec<_>>();
    let total_weight = weighted.iter().map(|(_, _, weight)| *weight).sum::<f64>();
    if total_weight <= 0.0 {
        return ("黄", 1);
    }
    let mut roll = rng.r#gen::<f64>() * total_weight;
    for (quality, rank, weight) in weighted {
        roll -= weight;
        if roll <= 0.0 {
            return (quality, rank);
        }
    }
    ("黄", 1)
}

fn map_quality_rank(name: &str) -> i64 {
    match name.trim() {
        "黄" => 1,
        "玄" => 2,
        "地" => 3,
        "天" => 4,
        _ => 1,
    }
}

fn normalize_bind_type(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        "none".to_string()
    } else {
        value.to_string()
    }
}

fn generic_pve_reward_seed(payload: &GenericPveSettlementTaskPayload) -> u64 {
    let digest = md5::compute(
        serde_json::to_string(payload)
            .unwrap_or_else(|_| format!("{}:{}", payload.character_id, payload.user_id))
            .as_bytes(),
    );
    u64::from_be_bytes([
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
    ])
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
        load_dungeon_first_clear_reward_items, resolve_item_can_disassemble,
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
    fn item_can_disassemble_matches_node_contract() {
        assert!(resolve_item_can_disassemble(&serde_json::json!({})));
        assert!(resolve_item_can_disassemble(
            &serde_json::json!({"disassemblable": true})
        ));
        assert!(!resolve_item_can_disassemble(
            &serde_json::json!({"disassemblable": false})
        ));
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
                receiver_character_id: Some(11),
                receiver_user_id: Some(22),
                receiver_fuyuan: Some(0.0),
                quality_weights: None,
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
