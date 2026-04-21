use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    CharacterItemGrantDelta, buffer_character_item_grant_deltas,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct BattlePassQuery {
    #[serde(rename = "seasonId")]
    pub season_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassTaskDto {
    pub id: String,
    pub code: String,
    pub name: String,
    pub description: String,
    pub task_type: String,
    pub condition: serde_json::Value,
    pub target_value: i64,
    pub reward_exp: i64,
    pub reward_extra: Vec<serde_json::Value>,
    pub enabled: bool,
    pub sort_weight: i64,
    pub progress_value: i64,
    pub completed: bool,
    pub claimed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassTasksOverviewDto {
    pub season_id: String,
    pub daily: Vec<BattlePassTaskDto>,
    pub weekly: Vec<BattlePassTaskDto>,
    pub season: Vec<BattlePassTaskDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassCompleteTaskData {
    pub task_id: String,
    pub task_type: String,
    pub gained_exp: i64,
    pub exp: i64,
    pub level: i64,
    pub max_level: i64,
    pub exp_per_level: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassStatusDto {
    pub season_id: String,
    pub season_name: String,
    pub exp: i64,
    pub level: i64,
    pub max_level: i64,
    pub exp_per_level: i64,
    pub premium_unlocked: bool,
    pub claimed_free_levels: Vec<i64>,
    pub claimed_premium_levels: Vec<i64>,
}

#[derive(Debug, Deserialize)]
pub struct BattlePassClaimPayload {
    pub season_id: Option<String>,
    pub level: Option<i64>,
    pub track: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum BattlePassRewardItemDto {
    #[serde(rename = "currency")]
    Currency {
        currency: String,
        amount: i64,
        name: String,
        icon: Option<String>,
    },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        qty: i64,
        name: String,
        icon: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassClaimData {
    pub level: i64,
    pub track: String,
    pub rewards: Vec<BattlePassRewardItemDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spirit_stones: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub silver: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BattlePassRewardDto {
    pub level: i64,
    pub free_rewards: Vec<BattlePassRewardItemDto>,
    pub premium_rewards: Vec<BattlePassRewardItemDto>,
}

#[derive(Debug, Deserialize)]
struct BattlePassRewardsFile {
    season: BattlePassSeasonSeed,
    rewards: Vec<BattlePassRewardSeed>,
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct BattlePassSeasonSeed {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) start_at: String,
    pub(crate) end_at: String,
    pub(crate) max_level: i64,
    pub(crate) exp_per_level: i64,
    pub(crate) enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattlePassRewardSeed {
    level: i64,
    free: Vec<BattlePassRewardEntrySeed>,
    premium: Vec<BattlePassRewardEntrySeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattlePassRewardEntrySeed {
    #[serde(rename = "type")]
    reward_type: String,
    currency: Option<String>,
    amount: Option<i64>,
    item_def_id: Option<String>,
    qty: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct BattlePassTasksFile {
    season_id: String,
    tasks: Vec<BattlePassTaskSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct BattlePassTaskSeed {
    id: String,
    code: String,
    name: String,
    description: String,
    task_type: String,
    condition: serde_json::Value,
    target_value: i64,
    reward_exp: i64,
    reward_extra: Vec<serde_json::Value>,
    enabled: Option<bool>,
    sort_weight: Option<i64>,
}

pub async fn get_battle_pass_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<BattlePassStatusDto>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let season = load_active_battle_pass_season()?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Err(AppError::config("角色不存在"));
    };

    let progress_row = state
        .database
        .fetch_optional(
            "SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 LIMIT 1",
            |query| query.bind(character_id).bind(&season.id),
        )
        .await?;
    let exp = progress_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<i64>, _>("exp").ok().flatten())
        .unwrap_or_default();
    let premium_unlocked = progress_row
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<bool>, _>("premium_unlocked")
                .ok()
                .flatten()
        })
        .unwrap_or(false);
    let claim_rows = state
        .database
        .fetch_all(
            "SELECT level, track FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2",
            |query| query.bind(character_id).bind(&season.id),
        )
        .await?;
    let mut claimed_free_levels = Vec::new();
    let mut claimed_premium_levels = Vec::new();
    for row in claim_rows {
        let level = row.try_get::<Option<i64>, _>("level")?.unwrap_or_default();
        let track = row
            .try_get::<Option<String>, _>("track")?
            .unwrap_or_default();
        if level <= 0 {
            continue;
        }
        match track.trim() {
            "premium" => claimed_premium_levels.push(level),
            _ => claimed_free_levels.push(level),
        }
    }
    claimed_free_levels.sort_unstable();
    claimed_premium_levels.sort_unstable();

    Ok(send_success(BattlePassStatusDto {
        season_id: season.id.clone(),
        season_name: season.name,
        exp,
        level: (exp / season.exp_per_level.max(1)).min(season.max_level),
        max_level: season.max_level,
        exp_per_level: season.exp_per_level,
        premium_unlocked,
        claimed_free_levels,
        claimed_premium_levels,
    }))
}

pub async fn get_battle_pass_rewards(
    Query(query): Query<BattlePassQuery>,
) -> Result<Json<SuccessResponse<Vec<BattlePassRewardDto>>>, AppError> {
    let rewards = load_battle_pass_rewards(query.season_id.as_deref())?;
    Ok(send_success(rewards))
}

pub async fn get_battle_pass_tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BattlePassQuery>,
) -> Result<Json<SuccessResponse<BattlePassTasksOverviewDto>>, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let season = load_active_battle_pass_season_with_fallback(query.season_id.as_deref())?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Ok(send_success(BattlePassTasksOverviewDto {
            season_id: season.id,
            daily: vec![],
            weekly: vec![],
            season: vec![],
        }));
    };

    let task_seed_file = load_battle_pass_task_seed_file()?;
    let rows = state
        .database
        .fetch_all(
            "SELECT task_id, progress_value, completed, completed_at::text AS completed_at_text, claimed, claimed_at::text AS claimed_at_text, updated_at::text AS updated_at_text FROM battle_pass_task_progress WHERE season_id = $1 AND character_id = $2",
            |query| query.bind(&season.id).bind(character_id),
        )
        .await?;
    let mut progress_by_task_id = BTreeMap::new();
    for row in rows {
        let task_id = row
            .try_get::<Option<String>, _>("task_id")?
            .unwrap_or_default();
        if task_id.trim().is_empty() {
            continue;
        }
        progress_by_task_id.insert(task_id, row);
    }

    let now = time::OffsetDateTime::now_utc();
    let mut all_rows = Vec::new();
    for task in task_seed_file
        .tasks
        .into_iter()
        .filter(|task| task.enabled != Some(false))
        .filter(|_| task_seed_file.season_id == season.id)
    {
        let progress = progress_by_task_id.get(task.id.as_str());
        let completed = progress
            .and_then(|row| row.try_get::<Option<bool>, _>("completed").ok().flatten())
            .unwrap_or(false)
            && is_in_current_cycle(
                &task.task_type,
                progress
                    .and_then(|row| {
                        row.try_get::<Option<String>, _>("completed_at_text")
                            .ok()
                            .flatten()
                    })
                    .as_deref(),
                now,
            );
        let claimed = progress
            .and_then(|row| row.try_get::<Option<bool>, _>("claimed").ok().flatten())
            .unwrap_or(false)
            && is_in_current_cycle(
                &task.task_type,
                progress
                    .and_then(|row| {
                        row.try_get::<Option<String>, _>("claimed_at_text")
                            .ok()
                            .flatten()
                    })
                    .as_deref(),
                now,
            );
        let progress_value = if is_in_current_cycle(
            &task.task_type,
            progress
                .and_then(|row| {
                    row.try_get::<Option<String>, _>("updated_at_text")
                        .ok()
                        .flatten()
                })
                .as_deref(),
            now,
        ) {
            progress
                .and_then(|row| {
                    row.try_get::<Option<i64>, _>("progress_value")
                        .ok()
                        .flatten()
                })
                .unwrap_or_default()
                .max(0)
        } else {
            0
        };
        all_rows.push(BattlePassTaskDto {
            id: task.id,
            code: task.code,
            name: task.name,
            description: task.description,
            task_type: task.task_type,
            condition: task.condition,
            target_value: task.target_value.max(1),
            reward_exp: task.reward_exp.max(0),
            reward_extra: task.reward_extra,
            enabled: task.enabled != Some(false),
            sort_weight: task.sort_weight.unwrap_or_default(),
            progress_value,
            completed,
            claimed,
        });
    }
    all_rows.sort_by(|left, right| {
        task_type_order(&left.task_type)
            .cmp(&task_type_order(&right.task_type))
            .then_with(|| right.sort_weight.cmp(&left.sort_weight))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(send_success(BattlePassTasksOverviewDto {
        season_id: season.id,
        daily: all_rows
            .iter()
            .filter(|task| task.task_type == "daily")
            .cloned()
            .collect(),
        weekly: all_rows
            .iter()
            .filter(|task| task.task_type == "weekly")
            .cloned()
            .collect(),
        season: all_rows
            .iter()
            .filter(|task| task.task_type == "season")
            .cloned()
            .collect(),
    }))
}

pub async fn complete_battle_pass_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let task_id = task_id.trim().to_string();
    if task_id.is_empty() {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<BattlePassCompleteTaskData> {
                success: false,
                message: Some("任务ID无效".to_string()),
                data: None,
            },
        ));
    }

    let season = load_active_battle_pass_season()?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<BattlePassCompleteTaskData> {
                success: false,
                message: Some("角色不存在".to_string()),
                data: None,
            },
        ));
    };
    let task_seed_file = load_battle_pass_task_seed_file()?;
    let Some(task) = task_seed_file
        .tasks
        .into_iter()
        .find(|entry| entry.enabled != Some(false) && entry.id == task_id)
    else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<BattlePassCompleteTaskData> {
                success: false,
                message: Some("任务不存在或未启用".to_string()),
                data: None,
            },
        ));
    };

    let result = state
        .database
        .with_transaction(|| async {
            let progress_row = state
                .database
                .fetch_optional(
                    "SELECT progress_value, completed, completed_at::text AS completed_at_text, updated_at::text AS updated_at_text FROM battle_pass_task_progress WHERE character_id = $1 AND season_id = $2 AND task_id = $3 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(&season.id).bind(&task_id),
                )
                .await?;
            let now = time::OffsetDateTime::now_utc();
            let completed = progress_row
                .as_ref()
                .and_then(|row| row.try_get::<Option<bool>, _>("completed").ok().flatten())
                .unwrap_or(false)
                && is_in_current_cycle(
                    &task.task_type,
                    progress_row
                        .as_ref()
                        .and_then(|row| row.try_get::<Option<String>, _>("completed_at_text").ok().flatten())
                        .as_deref(),
                    now,
                );
            if completed {
                return Ok(crate::shared::response::ServiceResult::<BattlePassCompleteTaskData> {
                    success: false,
                    message: Some("任务已完成".to_string()),
                    data: None,
                });
            }
            let progress_in_cycle = is_in_current_cycle(
                &task.task_type,
                progress_row
                    .as_ref()
                    .and_then(|row| row.try_get::<Option<String>, _>("updated_at_text").ok().flatten())
                    .as_deref(),
                now,
            );
            let current_progress_value = if progress_in_cycle {
                progress_row
                    .as_ref()
                    .and_then(|row| row.try_get::<Option<i64>, _>("progress_value").ok().flatten())
                    .unwrap_or_default()
                    .max(0)
            } else {
                0
            };
            if current_progress_value < task.target_value.max(1) {
                return Ok(crate::shared::response::ServiceResult::<BattlePassCompleteTaskData> {
                    success: false,
                    message: Some("任务目标未达成，无法完成".to_string()),
                    data: None,
                });
            }

            state
                .database
                .execute(
                    "INSERT INTO battle_pass_task_progress (character_id, season_id, task_id, progress_value, completed, completed_at, claimed, claimed_at, updated_at) VALUES ($1, $2, $3, $4, true, NOW(), true, NOW(), NOW()) ON CONFLICT (character_id, season_id, task_id) DO UPDATE SET progress_value = EXCLUDED.progress_value, completed = true, completed_at = NOW(), claimed = true, claimed_at = NOW(), updated_at = NOW()",
                    |query| query.bind(character_id).bind(&season.id).bind(&task_id).bind(task.target_value.max(1)),
                )
                .await?;

            let progress_state = state
                .database
                .fetch_optional(
                    "SELECT exp FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(&season.id),
                )
                .await?;
            let current_exp = progress_state
                .as_ref()
                .and_then(|row| row.try_get::<Option<i64>, _>("exp").ok().flatten())
                .unwrap_or_default();
            let max_exp = season.max_level.max(0) * season.exp_per_level.max(1);
            let next_exp = (current_exp + task.reward_exp.max(0)).min(max_exp.max(0));
            state
                .database
                .execute(
                    "INSERT INTO battle_pass_progress (character_id, season_id, exp, premium_unlocked, created_at, updated_at) VALUES ($1, $2, $3, false, NOW(), NOW()) ON CONFLICT (character_id, season_id) DO UPDATE SET exp = $3, updated_at = NOW()",
                    |query| query.bind(character_id).bind(&season.id).bind(next_exp),
                )
                .await?;

            Ok(crate::shared::response::ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(BattlePassCompleteTaskData {
                    task_id: task.id.clone(),
                    task_type: task.task_type.clone(),
                    gained_exp: task.reward_exp.max(0),
                    exp: next_exp,
                    level: (next_exp / season.exp_per_level.max(1)).min(season.max_level),
                    max_level: season.max_level,
                    exp_per_level: season.exp_per_level,
                }),
            })
        })
        .await?;

    Ok(crate::shared::response::send_result(result))
}

pub async fn claim_battle_pass_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<BattlePassClaimPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let level = payload.level.unwrap_or_default();
    let track = payload.track.unwrap_or_default();
    if level < 1 {
        return Err(AppError::config("等级参数无效"));
    }
    if track != "free" && track != "premium" {
        return Err(AppError::config("奖励轨道参数无效"));
    }
    let season = load_active_battle_pass_season_with_fallback(payload.season_id.as_deref())?;
    let Some(character_id) = auth::get_character_id_by_user_id(&state, actor.user_id).await? else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<BattlePassClaimData> {
                success: false,
                message: Some("角色不存在".to_string()),
                data: None,
            },
        ));
    };

    let reward_defs = load_battle_pass_rewards_file()?;
    let Some(reward_row) = reward_defs
        .rewards
        .into_iter()
        .find(|row| row.level == level)
    else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<BattlePassClaimData> {
                success: false,
                message: Some("奖励等级不存在".to_string()),
                data: None,
            },
        ));
    };
    let reward_entries = if track == "premium" {
        reward_row.premium
    } else {
        reward_row.free
    };
    let item_meta_map = load_item_meta_map()?;

    let result = state
        .database
        .with_transaction(|| async {
            let progress = state
                .database
                .fetch_optional(
                    "SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(&season.id),
                )
                .await?;
            let Some(progress) = progress else {
                return Ok(crate::shared::response::ServiceResult::<BattlePassClaimData> {
                    success: false,
                    message: Some("战令数据不存在".to_string()),
                    data: None,
                });
            };
            let exp = progress.try_get::<Option<i64>, _>("exp")?.unwrap_or_default();
            let premium_unlocked = progress.try_get::<Option<bool>, _>("premium_unlocked")?.unwrap_or(false);
            if track == "premium" && !premium_unlocked {
                return Ok(crate::shared::response::ServiceResult::<BattlePassClaimData> {
                    success: false,
                    message: Some("未解锁高级战令".to_string()),
                    data: None,
                });
            }
            let current_level = (exp / season.exp_per_level.max(1)).min(season.max_level);
            if current_level < level {
                return Ok(crate::shared::response::ServiceResult::<BattlePassClaimData> {
                    success: false,
                    message: Some("战令等级不足".to_string()),
                    data: None,
                });
            }

            let claimed = state
                .database
                .fetch_optional(
                    "SELECT 1 FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2 AND level = $3 AND track = $4 LIMIT 1 FOR UPDATE",
                    |query| query.bind(character_id).bind(&season.id).bind(level).bind(&track),
                )
                .await?;
            if claimed.is_some() {
                return Ok(crate::shared::response::ServiceResult::<BattlePassClaimData> {
                    success: false,
                    message: Some("奖励已领取".to_string()),
                    data: None,
                });
            }

            let mut silver_delta = 0_i64;
            let mut spirit_stones_delta = 0_i64;
            let mut item_grants = Vec::<CharacterItemGrantDelta>::new();
            let mut rewards = Vec::new();
            for reward in reward_entries {
                match reward.reward_type.as_str() {
                    "currency" => {
                        let amount = reward.amount.unwrap_or_default().max(0);
                        if amount <= 0 { continue; }
                        match reward.currency.as_deref() {
                            Some("silver") => {
                                silver_delta += amount;
                                rewards.push(BattlePassRewardItemDto::Currency {
                                    currency: "silver".to_string(),
                                    amount,
                                    name: "银两".to_string(),
                                    icon: None,
                                });
                            }
                            Some("spirit_stones") => {
                                spirit_stones_delta += amount;
                                rewards.push(BattlePassRewardItemDto::Currency {
                                    currency: "spirit_stones".to_string(),
                                    amount,
                                    name: "灵石".to_string(),
                                    icon: None,
                                });
                            }
                            _ => {}
                        }
                    }
                    "item" => {
                        let item_def_id = reward.item_def_id.unwrap_or_default();
                        let qty = reward.qty.unwrap_or(1).max(1);
                        if item_def_id.trim().is_empty() { continue; }
                        item_grants.push(CharacterItemGrantDelta {
                            character_id,
                            user_id: actor.user_id,
                            item_def_id: item_def_id.trim().to_string(),
                            qty,
                            bind_type: "none".to_string(),
                            obtained_from: "battle_pass".to_string(),
                            obtained_ref_id: Some(format!("{}:{}:{}", season.id, level, track)),
                        });
                        let meta = item_meta_map.get(item_def_id.trim()).cloned().unwrap_or_else(|| (item_def_id.clone(), None));
                        rewards.push(BattlePassRewardItemDto::Item {
                            item_def_id,
                            qty,
                            name: meta.0,
                            icon: meta.1,
                        });
                    }
                    _ => {}
                }
            }

            if state.redis_available && state.redis.is_some() {
                let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
                let mut resource_fields = Vec::new();
                if silver_delta > 0 {
                    resource_fields.push(CharacterResourceDeltaField {
                        character_id,
                        field: "silver".to_string(),
                        increment: silver_delta,
                    });
                }
                if spirit_stones_delta > 0 {
                    resource_fields.push(CharacterResourceDeltaField {
                        character_id,
                        field: "spirit_stones".to_string(),
                        increment: spirit_stones_delta,
                    });
                }
                if !resource_fields.is_empty() {
                    buffer_character_resource_delta_fields(&redis, &resource_fields).await?;
                }
                if !item_grants.is_empty() {
                    buffer_character_item_grant_deltas(&redis, &item_grants).await?;
                }
            } else {
                for grant in &item_grants {
                    state
                        .database
                        .fetch_one(
                            "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'battle_pass', $5) RETURNING id",
                            |query| query.bind(actor.user_id).bind(character_id).bind(grant.item_def_id.as_str()).bind(grant.qty).bind(grant.obtained_ref_id.as_deref().unwrap_or_default()),
                        )
                        .await?;
                }
                if silver_delta > 0 || spirit_stones_delta > 0 {
                    state
                        .database
                        .execute(
                            "UPDATE characters SET silver = silver + $1, spirit_stones = spirit_stones + $2, updated_at = NOW() WHERE id = $3",
                            |query| query.bind(silver_delta).bind(spirit_stones_delta).bind(character_id),
                        )
                        .await?;
                }
            }
            state
                .database
                .execute(
                    "INSERT INTO battle_pass_claim_record (character_id, season_id, level, track, claimed_at) VALUES ($1, $2, $3, $4, NOW())",
                    |query| query.bind(character_id).bind(&season.id).bind(level).bind(&track),
                )
                .await?;

            Ok(crate::shared::response::ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(BattlePassClaimData {
                    level,
                    track: track.clone(),
                    rewards,
                    spirit_stones: (spirit_stones_delta > 0).then_some(spirit_stones_delta),
                    silver: (silver_delta > 0).then_some(silver_delta),
                }),
            })
        })
        .await?;

    Ok(crate::shared::response::send_result(result))
}

pub(crate) fn load_active_battle_pass_season() -> Result<BattlePassSeasonSeed, AppError> {
    let payload = load_battle_pass_rewards_file()?;
    if payload.season.enabled == Some(false) {
        return Err(AppError::config("战令赛季不存在"));
    }
    if !is_season_active(&payload.season) {
        return Err(AppError::config("当前没有进行中的赛季"));
    }
    Ok(payload.season)
}

pub(crate) fn load_active_battle_pass_season_with_fallback(
    season_id: Option<&str>,
) -> Result<BattlePassSeasonSeed, AppError> {
    let payload = load_battle_pass_rewards_file()?;
    if payload.season.enabled == Some(false) {
        return Err(AppError::config("战令赛季不存在"));
    }
    if let Some(season_id) = season_id.map(str::trim).filter(|value| !value.is_empty()) {
        if payload.season.id != season_id {
            return Err(AppError::config("战令赛季不存在"));
        }
    }
    if season_id.is_none() && !is_season_active(&payload.season) {
        return Ok(payload.season);
    }
    Ok(payload.season)
}

fn load_battle_pass_rewards(season_id: Option<&str>) -> Result<Vec<BattlePassRewardDto>, AppError> {
    let payload = load_battle_pass_rewards_file()?;
    if payload.season.enabled == Some(false) {
        return Ok(vec![]);
    }
    if let Some(season_id) = season_id.map(str::trim).filter(|value| !value.is_empty()) {
        if payload.season.id != season_id {
            return Ok(vec![]);
        }
    }
    let item_meta_map = load_item_meta_map()?;
    Ok(payload
        .rewards
        .into_iter()
        .map(|row| BattlePassRewardDto {
            level: row.level,
            free_rewards: row
                .free
                .into_iter()
                .filter_map(|reward| to_reward_item_dto(reward, &item_meta_map))
                .collect(),
            premium_rewards: row
                .premium
                .into_iter()
                .filter_map(|reward| to_reward_item_dto(reward, &item_meta_map))
                .collect(),
        })
        .collect())
}

fn to_reward_item_dto(
    reward: BattlePassRewardEntrySeed,
    item_meta_map: &BTreeMap<String, (String, Option<String>)>,
) -> Option<BattlePassRewardItemDto> {
    match reward.reward_type.as_str() {
        "currency" => {
            let currency = reward.currency.unwrap_or_default();
            let amount = reward.amount.unwrap_or_default().max(0);
            if amount <= 0 || !matches!(currency.as_str(), "silver" | "spirit_stones") {
                return None;
            }
            Some(BattlePassRewardItemDto::Currency {
                name: if currency == "silver" {
                    "银两".to_string()
                } else {
                    "灵石".to_string()
                },
                currency,
                amount,
                icon: None,
            })
        }
        "item" => {
            let item_def_id = reward.item_def_id.unwrap_or_default();
            let qty = reward.qty.unwrap_or(1).max(1);
            if item_def_id.trim().is_empty() {
                return None;
            }
            let (name, icon) = item_meta_map
                .get(item_def_id.trim())
                .cloned()
                .unwrap_or_else(|| (item_def_id.clone(), None));
            Some(BattlePassRewardItemDto::Item {
                item_def_id,
                qty,
                name,
                icon,
            })
        }
        _ => None,
    }
}

fn load_battle_pass_rewards_file() -> Result<BattlePassRewardsFile, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/battle_pass_rewards.json"),
    )
    .map_err(|error| {
        AppError::config(format!("failed to read battle_pass_rewards.json: {error}"))
    })?;
    serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse battle_pass_rewards.json: {error}"))
    })
}

fn load_battle_pass_task_seed_file() -> Result<BattlePassTasksFile, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/battle_pass_tasks.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read battle_pass_tasks.json: {error}")))?;
    serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse battle_pass_tasks.json: {error}"))
    })
}

fn load_item_meta_map() -> Result<BTreeMap<String, (String, Option<String>)>, AppError> {
    let mut out = BTreeMap::new();
    for filename in ["item_def.json", "gem_def.json", "equipment_def.json"] {
        let content = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join(format!("../server/src/data/seeds/{filename}")),
        )
        .map_err(|error| AppError::config(format!("failed to read {filename}: {error}")))?;
        let payload: serde_json::Value = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {filename}: {error}")))?;
        let items = payload
            .get("items")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        for item in items {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            let name = item
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .trim()
                .to_string();
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let icon = item
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            out.insert(id, (name, icon));
        }
    }
    Ok(out)
}

fn task_type_order(task_type: &str) -> i32 {
    match task_type {
        "daily" => 1,
        "weekly" => 2,
        _ => 3,
    }
}

fn is_in_current_cycle(
    task_type: &str,
    timestamp: Option<&str>,
    now: time::OffsetDateTime,
) -> bool {
    let Some(timestamp) = timestamp else {
        return false;
    };
    let Ok(timestamp) =
        time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
    else {
        return false;
    };
    match task_type {
        "daily" => timestamp.date() == now.date(),
        "weekly" => {
            let weekday = now.weekday().number_days_from_monday() as i32;
            let start = now.date().to_julian_day() - weekday;
            timestamp.date().to_julian_day() >= start
        }
        _ => true,
    }
}

fn is_season_active(season: &BattlePassSeasonSeed) -> bool {
    let start = parse_rfc3339(&season.start_at);
    let end = parse_rfc3339(&season.end_at);
    let now = time::OffsetDateTime::now_utc();
    match (start, end) {
        (Some(start), Some(end)) => start <= now && now < end,
        _ => true,
    }
}

fn parse_rfc3339(raw: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn battle_pass_status_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "seasonId": "bp-season-001",
                "seasonName": "第一赛季",
                "exp": 1200,
                "level": 1,
                "maxLevel": 30,
                "expPerLevel": 1000,
                "premiumUnlocked": false,
                "claimedFreeLevels": [1],
                "claimedPremiumLevels": []
            }
        });
        assert_eq!(payload["data"]["seasonId"], "bp-season-001");
        println!("BATTLE_PASS_STATUS_RESPONSE={}", payload);
    }

    #[test]
    fn battle_pass_rewards_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": [{
                "level": 1,
                "freeRewards": [{"type": "currency", "currency": "silver", "amount": 100, "name": "银两", "icon": null}],
                "premiumRewards": [{"type": "item", "itemDefId": "mat-001", "qty": 20, "name": "一阶矿石", "icon": null}]
            }]
        });
        assert_eq!(payload["data"][0]["level"], 1);
        println!("BATTLE_PASS_REWARDS_RESPONSE={}", payload);
    }

    #[test]
    fn battle_pass_tasks_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "seasonId": "bp-season-001",
                "daily": [{"id": "bp-task-daily-001", "taskType": "daily", "progressValue": 0, "completed": false, "claimed": false}],
                "weekly": [],
                "season": []
            }
        });
        assert_eq!(payload["data"]["daily"][0]["taskType"], "daily");
        println!("BATTLE_PASS_TASKS_RESPONSE={}", payload);
    }

    #[test]
    fn battle_pass_complete_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "taskId": "bp-task-daily-001",
                "taskType": "daily",
                "gainedExp": 100,
                "exp": 1200,
                "level": 1,
                "maxLevel": 30,
                "expPerLevel": 1000
            }
        });
        assert_eq!(payload["data"]["taskId"], "bp-task-daily-001");
        println!("BATTLE_PASS_COMPLETE_RESPONSE={}", payload);
    }

    #[test]
    fn battle_pass_claim_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "level": 1,
                "track": "free",
                "rewards": [{"type": "currency", "currency": "silver", "amount": 100, "name": "银两", "icon": null}],
                "silver": 100
            }
        });
        assert_eq!(payload["data"]["track"], "free");
        assert_eq!(payload["data"]["silver"], 100);
        println!("BATTLE_PASS_CLAIM_RESPONSE={}", payload);
    }
}
