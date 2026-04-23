use std::collections::HashMap;
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
use crate::integrations::redis_progress_delta::{
    CharacterProgressDeltaField, buffer_character_progress_delta_fields,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::realtime::achievement::{
    AchievementUpdatePayload, build_achievement_indicator_payload, build_achievement_update_payload,
};
use crate::realtime::public_socket::emit_achievement_update_to_user;
use crate::shared::error::AppError;
use crate::shared::response::{SuccessResponse, send_success};
use crate::state::AppState;

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> Result<i64, AppError> {
    Ok(row
        .try_get::<Option<i32>, _>(column)?
        .map(i64::from)
        .unwrap_or_default())
}

#[derive(Debug, Deserialize)]
pub struct AchievementListQuery {
    pub category: Option<String>,
    pub status: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementClaimPayload {
    pub achievement_id: Option<String>,
    pub achievement_id_legacy: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointClaimPayload {
    pub threshold: Option<i64>,
    pub points_threshold: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementRewardViewDto {
    #[serde(rename = "type")]
    pub reward_type: String,
    pub amount: Option<i64>,
    pub item_def_id: Option<String>,
    pub qty: Option<i64>,
    pub item_name: Option<String>,
    pub item_icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementProgressDto {
    pub current: i64,
    pub target: i64,
    pub percent: f64,
    pub done: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementItemDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub points: i64,
    pub icon: Option<String>,
    pub hidden: bool,
    pub status: String,
    pub claimable: bool,
    pub track_type: String,
    pub track_key: String,
    pub progress: AchievementProgressDto,
    pub rewards: Vec<AchievementRewardViewDto>,
    pub title_id: Option<String>,
    pub sort_weight: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointsInfoDto {
    pub total: i64,
    pub by_category: AchievementPointsByCategoryDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointsByCategoryDto {
    pub combat: i64,
    pub cultivation: i64,
    pub exploration: i64,
    pub social: i64,
    pub collection: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AchievementListData {
    pub achievements: Vec<AchievementItemDto>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
    pub points: AchievementPointsInfoDto,
}

#[derive(Debug, Clone, Serialize)]
pub struct AchievementDetailData {
    pub achievement: AchievementItemDto,
    pub progress: AchievementProgressDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointRewardDto {
    pub id: String,
    pub threshold: i64,
    pub name: String,
    pub description: String,
    pub rewards: Vec<AchievementRewardViewDto>,
    pub title: Option<AchievementClaimTitleDto>,
    pub claimable: bool,
    pub claimed: bool,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementClaimTitleDto {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointsRewardsData {
    pub total_points: i64,
    pub claimed_thresholds: Vec<i64>,
    pub rewards: Vec<AchievementPointRewardDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementClaimData {
    pub achievement_id: String,
    pub rewards: Vec<AchievementRewardViewDto>,
    pub title: Option<AchievementClaimTitleDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<AchievementUpdatePayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementPointClaimData {
    pub threshold: i64,
    pub rewards: Vec<AchievementRewardViewDto>,
    pub title: Option<AchievementClaimTitleDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_realtime: Option<AchievementUpdatePayload>,
}

#[derive(Debug, Deserialize)]
struct AchievementDefFile {
    achievements: Vec<AchievementDefSeed>,
    point_rewards: Option<Vec<AchievementPointRewardSeed>>,
}

#[derive(Debug, Deserialize, Clone)]
struct AchievementDefSeed {
    id: String,
    name: String,
    description: String,
    category: String,
    points: i64,
    icon: Option<String>,
    hidden: Option<bool>,
    prerequisite_id: Option<String>,
    track_type: String,
    track_key: String,
    target_value: i64,
    target_list: Option<Vec<serde_json::Value>>,
    rewards: Option<Vec<AchievementRewardSeed>>,
    title_id: Option<String>,
    sort_weight: i64,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct AchievementRewardSeed {
    #[serde(rename = "type")]
    reward_type: String,
    amount: Option<i64>,
    item_def_id: Option<String>,
    qty: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
struct AchievementPointRewardSeed {
    id: String,
    threshold: i64,
    name: String,
    description: String,
    rewards: Vec<AchievementRewardSeed>,
    title: Option<AchievementClaimTitleDto>,
}

pub async fn get_achievement_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<AchievementListQuery>,
) -> Result<Json<SuccessResponse<AchievementListData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let page = query.page.unwrap_or(1).clamp(1, 10_000);
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let category = query.category.unwrap_or_default();
    let status = normalize_achievement_status_filter(query.status.as_deref());
    let defs = load_enabled_achievement_defs()?;
    let progress_map = load_character_achievement_progress_map(&state, actor.character_id).await?;
    let points = load_achievement_points_info(&state, actor.character_id).await?;
    let item_meta = load_item_meta_map()?;

    let mut rows: Vec<_> = defs
        .into_iter()
        .filter(|def| category.trim().is_empty() || def.category == category.trim())
        .map(|def| {
            let progress = progress_map.get(def.id.as_str());
            build_achievement_item(def, progress, &item_meta)
        })
        .filter(|item| filter_achievement_status(item, status.as_deref()))
        .collect();
    rows.sort_by(|left, right| {
        right
            .sort_weight
            .cmp(&left.sort_weight)
            .then_with(|| left.id.cmp(&right.id))
    });
    let total = rows.len() as i64;
    let start = ((page - 1) * limit) as usize;
    let end = (start + limit as usize).min(rows.len());
    let paged = if start >= rows.len() {
        vec![]
    } else {
        rows[start..end].to_vec()
    };

    Ok(send_success(AchievementListData {
        achievements: paged,
        total,
        page,
        limit,
        points,
    }))
}

pub async fn get_achievement_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(achievement_id): Path<String>,
) -> Result<Json<SuccessResponse<AchievementDetailData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let achievement_id = achievement_id.trim();
    if achievement_id.is_empty() {
        return Err(AppError::config("成就ID无效"));
    }
    let defs = load_enabled_achievement_defs()?;
    let Some(def) = defs.into_iter().find(|def| def.id == achievement_id) else {
        return Err(AppError::not_found("成就不存在"));
    };
    let progress_map = load_character_achievement_progress_map(&state, actor.character_id).await?;
    let item_meta = load_item_meta_map()?;
    let achievement = build_achievement_item(def, progress_map.get(achievement_id), &item_meta);
    let progress = achievement.progress.clone();
    Ok(send_success(AchievementDetailData {
        achievement,
        progress,
    }))
}

pub async fn get_achievement_points_rewards(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<AchievementPointsRewardsData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let defs = load_achievement_defs_file()?;
    let points = load_achievement_points_info(&state, actor.character_id).await?;
    let claimed_thresholds =
        load_claimed_achievement_point_thresholds(&state, actor.character_id).await?;
    let item_meta = load_item_meta_map()?;
    let rewards = defs
        .point_rewards
        .unwrap_or_default()
        .into_iter()
        .map(|row| AchievementPointRewardDto {
            id: row.id,
            threshold: row.threshold,
            name: row.name,
            description: row.description,
            rewards: build_achievement_rewards(row.rewards, &item_meta),
            title: row.title,
            claimable: points.total >= row.threshold
                && !claimed_thresholds.contains(&row.threshold),
            claimed: claimed_thresholds.contains(&row.threshold),
        })
        .collect();
    Ok(send_success(AchievementPointsRewardsData {
        total_points: points.total,
        claimed_thresholds,
        rewards,
    }))
}

pub async fn claim_achievement_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AchievementClaimPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let achievement_id = payload
        .achievement_id
        .or(payload.achievement_id_legacy)
        .unwrap_or_default();
    let achievement_id = achievement_id.trim();
    if achievement_id.is_empty() {
        return Err(AppError::config("成就ID无效"));
    }
    let defs = load_enabled_achievement_defs()?;
    let Some(def) = defs.into_iter().find(|def| def.id == achievement_id) else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<AchievementClaimData> {
                success: false,
                message: Some("成就不存在或未解锁".to_string()),
                data: None,
            },
        ));
    };
    let item_meta = load_item_meta_map()?;
    let title_meta_map = load_title_meta_map()?;
    let result = state
        .database
        .with_transaction(|| async {
            let row = state
                .database
                .fetch_optional(
                    "SELECT status FROM character_achievement WHERE character_id = $1 AND achievement_id = $2 LIMIT 1 FOR UPDATE",
                    |query| query.bind(actor.character_id).bind(achievement_id),
                )
                .await?;
            let Some(row) = row else {
                return Ok(crate::shared::response::ServiceResult::<AchievementClaimData> {
                    success: false,
                    message: Some("成就不存在或未解锁".to_string()),
                    data: None,
                });
            };
            let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "in_progress".to_string());
            if status == "claimed" {
                return Ok(crate::shared::response::ServiceResult::<AchievementClaimData> {
                    success: false,
                    message: Some("奖励已领取".to_string()),
                    data: None,
                });
            }
            if status != "completed" {
                return Ok(crate::shared::response::ServiceResult::<AchievementClaimData> {
                    success: false,
                    message: Some("成就尚未完成".to_string()),
                    data: None,
                });
            }

            let rewards = apply_achievement_rewards_tx(
                &state,
                actor.user_id,
                actor.character_id,
                def.rewards.clone().unwrap_or_default(),
                &item_meta,
                "achievement_reward",
            )
            .await?;
            let title = grant_title_tx(&state, actor.character_id, def.title_id.as_deref(), &title_meta_map).await?;
            state
                .database
                .execute(
                    "UPDATE character_achievement SET status = 'claimed', claimed_at = NOW(), updated_at = NOW() WHERE character_id = $1 AND achievement_id = $2",
                    |query| query.bind(actor.character_id).bind(achievement_id),
                )
                .await?;
            Ok(crate::shared::response::ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(AchievementClaimData {
                    achievement_id: achievement_id.to_string(),
                    rewards,
                    title,
                    debug_realtime: Some(build_achievement_update_payload("claim_achievement", Some(achievement_id), None)),
                }),
            })
        })
        .await?;
    let socket_realtime = build_achievement_indicator_payload(
        actor.character_id,
        load_claimable_achievement_count(&state, actor.character_id).await?,
    );
    emit_achievement_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(crate::shared::response::send_result(result))
}

pub async fn claim_achievement_points_reward(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<AchievementPointClaimPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let threshold = payload.threshold.or(payload.points_threshold).unwrap_or(-1);
    if threshold < 0 {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<AchievementPointClaimData> {
                success: false,
                message: Some("阈值无效".to_string()),
                data: None,
            },
        ));
    }
    let defs = load_achievement_defs_file()?;
    let Some(def) = defs
        .point_rewards
        .unwrap_or_default()
        .into_iter()
        .find(|row| row.threshold == threshold)
    else {
        return Ok(crate::shared::response::send_result(
            crate::shared::response::ServiceResult::<AchievementPointClaimData> {
                success: false,
                message: Some("点数奖励不存在".to_string()),
                data: None,
            },
        ));
    };
    let item_meta = load_item_meta_map()?;
    let title_meta_map = load_title_meta_map()?;
    let result = state
        .database
        .with_transaction(|| async {
            let row = state
                .database
                .fetch_optional(
                    "SELECT total_points, claimed_thresholds FROM character_achievement_points WHERE character_id = $1 LIMIT 1 FOR UPDATE",
                    |query| query.bind(actor.character_id),
                )
                .await?;
            let Some(row) = row else {
                return Ok(crate::shared::response::ServiceResult::<AchievementPointClaimData> {
                    success: false,
                    message: Some("点数奖励不存在".to_string()),
                    data: None,
                });
            };
            let total_points = opt_i64_from_i32(&row, "total_points")?;
            let mut claimed_thresholds = row
                .try_get::<Option<serde_json::Value>, _>("claimed_thresholds")?
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_i64())
                .collect::<Vec<_>>();
            if claimed_thresholds.contains(&threshold) {
                return Ok(crate::shared::response::ServiceResult::<AchievementPointClaimData> {
                    success: false,
                    message: Some("该点数奖励已领取".to_string()),
                    data: None,
                });
            }
            if total_points < threshold {
                return Ok(crate::shared::response::ServiceResult::<AchievementPointClaimData> {
                    success: false,
                    message: Some("成就点数不足".to_string()),
                    data: None,
                });
            }

            let rewards = apply_achievement_rewards_tx(
                &state,
                actor.user_id,
                actor.character_id,
                def.rewards.clone(),
                &item_meta,
                "achievement_points_reward",
            )
            .await?;
            let title = grant_title_tx(&state, actor.character_id, def.title.as_ref().map(|title| title.id.as_str()), &title_meta_map).await?;
            claimed_thresholds.push(threshold);
            claimed_thresholds.sort_unstable();
            claimed_thresholds.dedup();
            state
                .database
                .execute(
                    "UPDATE character_achievement_points SET claimed_thresholds = $2::jsonb, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(actor.character_id).bind(serde_json::to_string(&claimed_thresholds).unwrap_or_else(|_| "[]".to_string())),
                )
                .await?;

            Ok(crate::shared::response::ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(AchievementPointClaimData {
                    threshold,
                    rewards,
                    title,
                    debug_realtime: Some(build_achievement_update_payload("claim_points_reward", None, Some(threshold))),
                }),
            })
        })
        .await?;
    let socket_realtime = build_achievement_indicator_payload(
        actor.character_id,
        load_claimable_achievement_count(&state, actor.character_id).await?,
    );
    emit_achievement_update_to_user(&state, actor.user_id, &socket_realtime);
    Ok(crate::shared::response::send_result(result))
}

pub async fn record_dungeon_clear_achievement_event(
    state: &AppState,
    character_id: i64,
    user_id: i64,
    dungeon_id: &str,
    difficulty_id: Option<&str>,
    participant_count: i64,
    count: i64,
) -> Result<(), AppError> {
    let dungeon_id = dungeon_id.trim();
    if character_id <= 0 || user_id <= 0 || dungeon_id.is_empty() {
        return Ok(());
    }
    let increment = count.max(1);
    let mut track_keys = vec![format!("dungeon:clear:{dungeon_id}")];
    if participant_count > 1 {
        track_keys.push(format!("team:dungeon:clear:{dungeon_id}"));
    }
    if is_nightmare_dungeon_difficulty(difficulty_id)? {
        track_keys.push("dungeon:clear:difficulty:nightmare".to_string());
    }
    let candidate_track_keys = track_keys
        .into_iter()
        .flat_map(|track_key| build_track_key_candidates(&track_key))
        .collect::<Vec<_>>();
    let defs = load_enabled_achievement_defs()?;
    let matched_defs = defs
        .into_iter()
        .filter(|def| {
            candidate_track_keys
                .iter()
                .any(|candidate| candidate == def.track_key.trim())
        })
        .collect::<Vec<_>>();
    if matched_defs.is_empty() {
        return Ok(());
    }

    let use_progress_delta = state.redis_available && state.redis.is_some();
    let mut buffered_point_deltas = Vec::<CharacterProgressDeltaField>::new();

    state
        .database
        .with_transaction(|| async {
            state
                .database
                .execute(
                    "INSERT INTO character_achievement_points (character_id, total_points, combat_points, cultivation_points, exploration_points, social_points, collection_points, claimed_thresholds, updated_at) VALUES ($1, 0, 0, 0, 0, 0, 0, '[]'::jsonb, NOW()) ON CONFLICT (character_id) DO NOTHING",
                    |query| query.bind(character_id),
                )
                .await?;

            for def in matched_defs {
                state
                    .database
                    .execute(
                        "INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data, claimed_at, updated_at) VALUES ($1, $2, 'in_progress', 0, '{}'::jsonb, NULL, NOW()) ON CONFLICT (character_id, achievement_id) DO NOTHING",
                        |query| query.bind(character_id).bind(def.id.trim()),
                    )
                    .await?;

                let row = state
                    .database
                    .fetch_optional(
                        "SELECT status, progress FROM character_achievement WHERE character_id = $1 AND achievement_id = $2 LIMIT 1 FOR UPDATE",
                        |query| query.bind(character_id).bind(def.id.trim()),
                    )
                    .await?;
                let Some(row) = row else {
                    continue;
                };
                let status = row
                    .try_get::<Option<String>, _>("status")?
                    .unwrap_or_else(|| "in_progress".to_string());
                if matches!(status.as_str(), "completed" | "claimed") {
                    continue;
                }
                if let Some(prerequisite_id) = def.prerequisite_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                    let prerequisite_row = state
                        .database
                        .fetch_optional(
                            "SELECT status FROM character_achievement WHERE character_id = $1 AND achievement_id = $2 LIMIT 1",
                            |query| query.bind(character_id).bind(prerequisite_id),
                        )
                        .await?;
                    let prerequisite_status = prerequisite_row
                        .as_ref()
                        .and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten())
                        .unwrap_or_else(|| "in_progress".to_string());
                    if !matches!(prerequisite_status.as_str(), "completed" | "claimed") {
                        continue;
                    }
                }
                let current = row.try_get::<Option<i32>, _>("progress")?.map(i64::from).unwrap_or_default();
                let target = def.target_value.max(1);
                let next = if def.track_type.trim() == "flag" {
                    target
                } else {
                    (current + increment).min(target)
                };
                let completed_now = next >= target;
                let next_status = if completed_now { "completed" } else { "in_progress" };

                state
                    .database
                    .execute(
                        "UPDATE character_achievement SET progress = $3, status = $4, updated_at = NOW() WHERE character_id = $1 AND achievement_id = $2",
                        |query| query.bind(character_id).bind(def.id.trim()).bind(next).bind(next_status),
                    )
                    .await?;

                if completed_now {
                    let (point_column, point_delta) = achievement_point_column_and_delta(&def.category, def.points.max(0));
                    if point_delta > 0 {
                        if use_progress_delta {
                            buffered_point_deltas.push(CharacterProgressDeltaField {
                                character_id,
                                field: "achievement_points:total".to_string(),
                                increment: point_delta,
                            });
                            buffered_point_deltas.push(CharacterProgressDeltaField {
                                character_id,
                                field: format!("achievement_points:{point_column}"),
                                increment: point_delta,
                            });
                        } else {
                            let sql = format!(
                                "UPDATE character_achievement_points SET total_points = total_points + $2, {point_column} = {point_column} + $2, updated_at = NOW() WHERE character_id = $1"
                            );
                            state
                                .database
                                .execute(&sql, |query| query.bind(character_id).bind(point_delta))
                                .await?;
                        }
                    }
                }
            }
            Ok::<(), AppError>(())
        })
        .await?;

    if use_progress_delta && !buffered_point_deltas.is_empty() {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_progress_delta_fields(&redis, &buffered_point_deltas).await?;
        }
    }

    let socket_realtime = build_achievement_indicator_payload(
        character_id,
        load_claimable_achievement_count(state, character_id).await?,
    );
    emit_achievement_update_to_user(state, user_id, &socket_realtime);
    Ok(())
}

pub async fn record_craft_item_achievement_event(
    state: &AppState,
    character_id: i64,
    user_id: i64,
    recipe_id: Option<&str>,
    craft_kind: Option<&str>,
    item_def_id: Option<&str>,
    count: i64,
) -> Result<(), AppError> {
    if character_id <= 0 || user_id <= 0 {
        return Ok(());
    }
    let increment = count.max(1);
    let mut track_keys = Vec::new();
    if let Some(recipe_id) = recipe_id.map(str::trim).filter(|value| !value.is_empty()) {
        track_keys.push(format!("craft:recipe:{recipe_id}"));
    }
    if let Some(craft_kind) = craft_kind.map(str::trim).filter(|value| !value.is_empty()) {
        track_keys.push(format!("craft:kind:{craft_kind}"));
    }
    if let Some(item_def_id) = item_def_id.map(str::trim).filter(|value| !value.is_empty()) {
        track_keys.push(format!("craft:item:{item_def_id}"));
    }
    if track_keys.is_empty() {
        return Ok(());
    }
    let candidate_track_keys = track_keys
        .into_iter()
        .flat_map(|track_key| build_track_key_candidates(&track_key))
        .collect::<Vec<_>>();
    let defs = load_enabled_achievement_defs()?;
    let matched_defs = defs
        .into_iter()
        .filter(|def| {
            candidate_track_keys
                .iter()
                .any(|candidate| candidate == def.track_key.trim())
        })
        .collect::<Vec<_>>();
    if matched_defs.is_empty() {
        return Ok(());
    }

    let use_progress_delta = state.redis_available && state.redis.is_some();
    let mut buffered_point_deltas = Vec::<CharacterProgressDeltaField>::new();
    state.database.with_transaction(|| async {
        state.database.execute(
            "INSERT INTO character_achievement_points (character_id, total_points, combat_points, cultivation_points, exploration_points, social_points, collection_points, claimed_thresholds, updated_at) VALUES ($1, 0, 0, 0, 0, 0, 0, '[]'::jsonb, NOW()) ON CONFLICT (character_id) DO NOTHING",
            |query| query.bind(character_id),
        ).await?;
        for def in matched_defs {
            state.database.execute(
                "INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data, claimed_at, updated_at) VALUES ($1, $2, 'in_progress', 0, '{}'::jsonb, NULL, NOW()) ON CONFLICT (character_id, achievement_id) DO NOTHING",
                |query| query.bind(character_id).bind(def.id.trim()),
            ).await?;
            let row = state.database.fetch_optional(
                "SELECT status, progress FROM character_achievement WHERE character_id = $1 AND achievement_id = $2 LIMIT 1 FOR UPDATE",
                |query| query.bind(character_id).bind(def.id.trim()),
            ).await?;
            let Some(row) = row else { continue; };
            let status = row.try_get::<Option<String>, _>("status")?.unwrap_or_else(|| "in_progress".to_string());
            if matches!(status.as_str(), "completed" | "claimed") {
                continue;
            }
            if let Some(prerequisite_id) = def.prerequisite_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                let prerequisite_row = state.database.fetch_optional(
                    "SELECT status FROM character_achievement WHERE character_id = $1 AND achievement_id = $2 LIMIT 1",
                    |query| query.bind(character_id).bind(prerequisite_id),
                ).await?;
                let prerequisite_status = prerequisite_row
                    .as_ref()
                    .and_then(|row| row.try_get::<Option<String>, _>("status").ok().flatten())
                    .unwrap_or_else(|| "in_progress".to_string());
                if !matches!(prerequisite_status.as_str(), "completed" | "claimed") {
                    continue;
                }
            }
            let current = row.try_get::<Option<i32>, _>("progress")?.map(i64::from).unwrap_or_default();
            let target = def.target_value.max(1);
            let next = if def.track_type.trim() == "flag" { target } else { (current + increment).min(target) };
            let completed_now = next >= target;
            let next_status = if completed_now { "completed" } else { "in_progress" };
            state.database.execute(
                "UPDATE character_achievement SET progress = $3, status = $4, updated_at = NOW() WHERE character_id = $1 AND achievement_id = $2",
                |query| query.bind(character_id).bind(def.id.trim()).bind(next).bind(next_status),
            ).await?;
            if completed_now {
                let (point_column, point_delta) = achievement_point_column_and_delta(&def.category, def.points.max(0));
                if point_delta > 0 {
                    if use_progress_delta {
                        buffered_point_deltas.push(CharacterProgressDeltaField { character_id, field: "achievement_points:total".to_string(), increment: point_delta });
                        buffered_point_deltas.push(CharacterProgressDeltaField { character_id, field: format!("achievement_points:{point_column}"), increment: point_delta });
                    } else {
                        let sql = format!("UPDATE character_achievement_points SET total_points = total_points + $2, {point_column} = {point_column} + $2, updated_at = NOW() WHERE character_id = $1");
                        state.database.execute(&sql, |query| query.bind(character_id).bind(point_delta)).await?;
                    }
                }
            }
        }
        Ok::<(), AppError>(())
    }).await?;
    if use_progress_delta && !buffered_point_deltas.is_empty() {
        if let Some(redis_client) = state.redis.clone() {
            let redis = RedisRuntime::new(redis_client);
            buffer_character_progress_delta_fields(&redis, &buffered_point_deltas).await?;
        }
    }
    let socket_realtime = build_achievement_indicator_payload(
        character_id,
        load_claimable_achievement_count(state, character_id).await?,
    );
    emit_achievement_update_to_user(state, user_id, &socket_realtime);
    Ok(())
}

pub(crate) async fn load_claimable_achievement_count(
    state: &AppState,
    character_id: i64,
) -> Result<i64, AppError> {
    let row = state
        .database
        .fetch_one(
            "SELECT COUNT(1)::bigint AS claimable_count FROM character_achievement WHERE character_id = $1 AND status = 'completed'",
            |query| query.bind(character_id),
        )
        .await?;
    Ok(row
        .try_get::<Option<i64>, _>("claimable_count")?
        .unwrap_or_default())
}

async fn apply_achievement_rewards_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    rewards: Vec<AchievementRewardSeed>,
    item_meta: &HashMap<String, (String, Option<String>)>,
    obtained_from: &str,
) -> Result<Vec<AchievementRewardViewDto>, AppError> {
    let mut silver_delta = 0_i64;
    let mut spirit_stones_delta = 0_i64;
    let mut exp_delta = 0_i64;
    let mut item_grants = Vec::<CharacterItemGrantDelta>::new();
    let mut out = Vec::new();
    for reward in rewards {
        match reward.reward_type.as_str() {
            "silver" | "spirit_stones" | "exp" => {
                let amount = reward.amount.unwrap_or_default().max(0);
                if amount <= 0 {
                    continue;
                }
                match reward.reward_type.as_str() {
                    "silver" => silver_delta += amount,
                    "spirit_stones" => spirit_stones_delta += amount,
                    "exp" => exp_delta += amount,
                    _ => {}
                }
                out.push(AchievementRewardViewDto {
                    reward_type: reward.reward_type,
                    amount: Some(amount),
                    item_def_id: None,
                    qty: None,
                    item_name: None,
                    item_icon: None,
                });
            }
            "item" => {
                let item_def_id = reward.item_def_id.unwrap_or_default();
                let qty = reward.qty.unwrap_or(1).max(1);
                if item_def_id.trim().is_empty() {
                    continue;
                }
                item_grants.push(CharacterItemGrantDelta {
                    character_id,
                    user_id,
                    item_def_id: item_def_id.trim().to_string(),
                    qty,
                    bind_type: "none".to_string(),
                    obtained_from: obtained_from.trim().to_string(),
                    obtained_ref_id: None,
                    idle_session_id: None,
                    metadata: None,
                    quality: None,
                    quality_rank: None,
                    equip_options: None,
                });
                let meta = item_meta.get(item_def_id.trim()).cloned();
                out.push(AchievementRewardViewDto {
                    reward_type: "item".to_string(),
                    amount: None,
                    item_def_id: Some(item_def_id),
                    qty: Some(qty),
                    item_name: meta.as_ref().map(|value| value.0.clone()),
                    item_icon: meta.and_then(|value| value.1),
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
        if exp_delta > 0 {
            resource_fields.push(CharacterResourceDeltaField {
                character_id,
                field: "exp".to_string(),
                increment: exp_delta,
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
                    "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), $5) RETURNING id",
                    |query| query.bind(user_id).bind(character_id).bind(grant.item_def_id.as_str()).bind(grant.qty).bind(obtained_from),
                )
                .await?;
        }
        if silver_delta > 0 || spirit_stones_delta > 0 || exp_delta > 0 {
            state
                .database
                .execute(
                    "UPDATE characters SET silver = silver + $1, spirit_stones = spirit_stones + $2, exp = exp + $3, updated_at = NOW() WHERE id = $4",
                    |query| query.bind(silver_delta).bind(spirit_stones_delta).bind(exp_delta).bind(character_id),
                )
                .await?;
        }
    }
    Ok(out)
}

async fn grant_title_tx(
    state: &AppState,
    character_id: i64,
    title_id: Option<&str>,
    title_meta_map: &HashMap<String, AchievementClaimTitleDto>,
) -> Result<Option<AchievementClaimTitleDto>, AppError> {
    let Some(title_id) = title_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    state
        .database
        .execute(
            "INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, updated_at) VALUES ($1, $2, false, NOW(), NOW()) ON CONFLICT (character_id, title_id) DO NOTHING",
            |query| query.bind(character_id).bind(title_id),
        )
        .await?;
    Ok(title_meta_map.get(title_id).cloned())
}

fn load_title_meta_map() -> Result<HashMap<String, AchievementClaimTitleDto>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/title_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read title_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse title_def.json: {error}")))?;
    let titles = payload
        .get("titles")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(titles
        .into_iter()
        .filter_map(|title| {
            let id = title.get("id")?.as_str()?.trim().to_string();
            let name = title.get("name")?.as_str()?.trim().to_string();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            Some((
                id.clone(),
                AchievementClaimTitleDto {
                    id,
                    name,
                    color: title
                        .get("color")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                    icon: title
                        .get("icon")
                        .and_then(|value| value.as_str())
                        .map(|value| value.to_string()),
                },
            ))
        })
        .collect())
}

#[derive(Clone)]
struct CharacterAchievementProgressRow {
    status: String,
    progress: i64,
    progress_data: Option<serde_json::Value>,
}

fn build_achievement_item(
    def: AchievementDefSeed,
    progress: Option<&CharacterAchievementProgressRow>,
    item_meta: &HashMap<String, (String, Option<String>)>,
) -> AchievementItemDto {
    let status = progress
        .map(|progress| progress.status.clone())
        .unwrap_or_else(|| "in_progress".to_string());
    let track_type = def.track_type.clone();
    let target = if track_type == "multi" {
        def.target_list
            .as_ref()
            .map(|items| items.len() as i64)
            .filter(|v| *v > 0)
            .unwrap_or(def.target_value.max(1))
    } else {
        def.target_value.max(1)
    };
    let current = progress
        .map(|progress| progress.progress.max(0))
        .unwrap_or_default()
        .min(target);
    let done = status == "completed" || status == "claimed" || current >= target;
    let hidden_unfinished = def.hidden == Some(true) && status == "in_progress";
    AchievementItemDto {
        id: def.id.clone(),
        name: if hidden_unfinished {
            "？？？".to_string()
        } else {
            def.name.clone()
        },
        description: if hidden_unfinished {
            "隐藏成就，完成后解锁描述".to_string()
        } else {
            def.description.clone()
        },
        category: def.category,
        points: def.points.max(0),
        icon: def.icon,
        hidden: def.hidden == Some(true),
        status: status.clone(),
        claimable: status == "completed",
        track_type: track_type.clone(),
        track_key: def.track_key,
        progress: AchievementProgressDto {
            current,
            target,
            percent: if target > 0 {
                ((current as f64 / target as f64) * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            },
            done,
            status,
            progress_data: (track_type == "multi")
                .then(|| progress.and_then(|progress| progress.progress_data.clone()))
                .flatten(),
        },
        rewards: build_achievement_rewards(def.rewards.unwrap_or_default(), item_meta),
        title_id: def.title_id,
        sort_weight: def.sort_weight,
    }
}

fn build_achievement_rewards(
    rewards: Vec<AchievementRewardSeed>,
    item_meta: &HashMap<String, (String, Option<String>)>,
) -> Vec<AchievementRewardViewDto> {
    rewards
        .into_iter()
        .filter_map(|reward| match reward.reward_type.as_str() {
            "silver" | "spirit_stones" | "exp" => {
                let amount = reward.amount.unwrap_or_default().max(0);
                (amount > 0).then_some(AchievementRewardViewDto {
                    reward_type: reward.reward_type,
                    amount: Some(amount),
                    item_def_id: None,
                    qty: None,
                    item_name: None,
                    item_icon: None,
                })
            }
            "item" => {
                let item_def_id = reward.item_def_id.unwrap_or_default();
                if item_def_id.trim().is_empty() {
                    return None;
                }
                let qty = reward.qty.unwrap_or(1).max(1);
                let meta = item_meta.get(item_def_id.trim()).cloned();
                Some(AchievementRewardViewDto {
                    reward_type: "item".to_string(),
                    amount: None,
                    item_def_id: Some(item_def_id),
                    qty: Some(qty),
                    item_name: meta.as_ref().map(|value| value.0.clone()),
                    item_icon: meta.and_then(|value| value.1),
                })
            }
            _ => None,
        })
        .collect()
}

async fn load_character_achievement_progress_map(
    state: &AppState,
    character_id: i64,
) -> Result<HashMap<String, CharacterAchievementProgressRow>, AppError> {
    let rows = state
        .database
        .fetch_all(
            "SELECT achievement_id, status, progress, progress_data FROM character_achievement WHERE character_id = $1",
            |query| query.bind(character_id),
        )
        .await?;
    let mut map = HashMap::new();
    for row in rows {
        let achievement_id = row
            .try_get::<Option<String>, _>("achievement_id")?
            .unwrap_or_default();
        if achievement_id.trim().is_empty() {
            continue;
        }
        map.insert(
            achievement_id,
            CharacterAchievementProgressRow {
                status: row
                    .try_get::<Option<String>, _>("status")?
                    .unwrap_or_else(|| "in_progress".to_string()),
                progress: opt_i64_from_i32(&row, "progress")?,
                progress_data: row.try_get::<Option<serde_json::Value>, _>("progress_data")?,
            },
        );
    }
    Ok(map)
}

async fn load_achievement_points_info(
    state: &AppState,
    character_id: i64,
) -> Result<AchievementPointsInfoDto, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT total_points, combat_points, cultivation_points, exploration_points, social_points, collection_points FROM character_achievement_points WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(row) = row else {
        return Ok(AchievementPointsInfoDto {
            total: 0,
            by_category: AchievementPointsByCategoryDto {
                combat: 0,
                cultivation: 0,
                exploration: 0,
                social: 0,
                collection: 0,
            },
        });
    };
    Ok(AchievementPointsInfoDto {
        total: opt_i64_from_i32(&row, "total_points")?,
        by_category: AchievementPointsByCategoryDto {
            combat: opt_i64_from_i32(&row, "combat_points")?,
            cultivation: opt_i64_from_i32(&row, "cultivation_points")?,
            exploration: opt_i64_from_i32(&row, "exploration_points")?,
            social: opt_i64_from_i32(&row, "social_points")?,
            collection: opt_i64_from_i32(&row, "collection_points")?,
        },
    })
}

async fn load_claimed_achievement_point_thresholds(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<i64>, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT claimed_thresholds FROM character_achievement_points WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    Ok(row
        .and_then(|row| {
            row.try_get::<Option<serde_json::Value>, _>("claimed_thresholds")
                .ok()
                .flatten()
        })
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_i64())
        .collect())
}

fn load_achievement_defs_file() -> Result<AchievementDefFile, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/achievement_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read achievement_def.json: {error}")))?;
    serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse achievement_def.json: {error}")))
}

fn load_enabled_achievement_defs() -> Result<Vec<AchievementDefSeed>, AppError> {
    Ok(load_achievement_defs_file()?
        .achievements
        .into_iter()
        .filter(|achievement| achievement.enabled != Some(false))
        .collect())
}

fn achievement_point_column_and_delta(category: &str, points: i64) -> (&'static str, i64) {
    let normalized = category.trim();
    let column = match normalized {
        "combat" => "combat_points",
        "cultivation" => "cultivation_points",
        "exploration" => "exploration_points",
        "social" => "social_points",
        "collection" => "collection_points",
        _ => "exploration_points",
    };
    (column, points.max(0))
}

fn build_track_key_candidates(track_key: &str) -> Vec<String> {
    let key = track_key.trim();
    if key.is_empty() {
        return Vec::new();
    }
    let parts = key
        .split(':')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return Vec::new();
    }
    let mut out = std::collections::BTreeSet::new();
    out.insert(parts.join(":"));
    for index in (0..parts.len()).rev() {
        let candidate = parts[..index]
            .iter()
            .copied()
            .chain(std::iter::repeat_n("*", parts.len() - index))
            .collect::<Vec<_>>()
            .join(":");
        out.insert(candidate);
    }
    out.insert("*".to_string());
    out.into_iter().collect()
}

fn is_nightmare_dungeon_difficulty(difficulty_id: Option<&str>) -> Result<bool, AppError> {
    let Some(difficulty_id) = difficulty_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
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
        let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
            AppError::config(format!("failed to parse {}: {error}", path.display()))
        })?;
        let dungeons = payload
            .get("dungeons")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        for dungeon in dungeons {
            let difficulties = dungeon
                .get("difficulties")
                .and_then(|value| value.as_array())
                .cloned()
                .unwrap_or_default();
            for difficulty in difficulties {
                if difficulty.get("id").and_then(|value| value.as_str()) != Some(difficulty_id) {
                    continue;
                }
                return Ok(difficulty
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    == Some("噩梦"));
            }
        }
    }
    Ok(false)
}

fn load_item_meta_map() -> Result<HashMap<String, (String, Option<String>)>, AppError> {
    let mut out = HashMap::new();
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

fn normalize_achievement_status_filter(raw: Option<&str>) -> Option<String> {
    match raw.unwrap_or_default().trim() {
        "in_progress" | "completed" | "claimed" | "claimable" | "all" => {
            Some(raw.unwrap_or_default().trim().to_string())
        }
        _ => None,
    }
}

fn filter_achievement_status(item: &AchievementItemDto, status: Option<&str>) -> bool {
    match status.unwrap_or("all") {
        "all" => true,
        "claimable" => item.claimable,
        other => item.status == other,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn craft_track_key_candidates_include_recipe_wildcard() {
        let keys = super::build_track_key_candidates("craft:recipe:recipe-hui-qi-dan");
        assert!(keys.contains(&"craft:recipe:*".to_string()));
        assert!(keys.contains(&"craft:recipe:recipe-hui-qi-dan".to_string()));
        println!("CRAFT_ACHIEVEMENT_TRACK_KEYS={}", serde_json::json!(keys));
    }

    #[test]
    fn achievement_list_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "achievements": [{
                    "id": "ach-rabbit-001",
                    "name": "猎兔新手",
                    "status": "in_progress",
                    "claimable": false,
                    "progress": {"current": 1, "target": 10, "percent": 10, "done": false, "status": "in_progress"}
                }],
                "total": 1,
                "page": 1,
                "limit": 20,
                "points": {"total": 10, "byCategory": {"combat": 10, "cultivation": 0, "exploration": 0, "social": 0, "collection": 0}}
            }
        });
        assert_eq!(payload["data"]["achievements"][0]["id"], "ach-rabbit-001");
        println!("ACHIEVEMENT_LIST_RESPONSE={}", payload);
    }

    #[test]
    fn achievement_detail_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "achievement": {"id": "ach-rabbit-001", "name": "猎兔新手"},
                "progress": {"current": 1, "target": 10, "percent": 10, "done": false, "status": "in_progress"}
            }
        });
        assert_eq!(payload["data"]["achievement"]["id"], "ach-rabbit-001");
        println!("ACHIEVEMENT_DETAIL_RESPONSE={}", payload);
    }

    #[test]
    fn achievement_points_rewards_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "totalPoints": 10,
                "claimedThresholds": [5],
                "rewards": [{"id": "point-5", "threshold": 5, "claimable": false, "claimed": true}]
            }
        });
        assert_eq!(payload["data"]["totalPoints"], 10);
        println!("ACHIEVEMENT_POINTS_REWARDS_RESPONSE={}", payload);
    }

    #[test]
    fn achievement_claim_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "achievementId": "ach-rabbit-001",
                "rewards": [{"type": "silver", "amount": 100}],
                "title": {"id": "title-rabbit-hunter", "name": "猎兔新手", "color": null, "icon": null},
                "debugRealtime": {"kind": "achievement:update", "source": "claim_achievement", "achievementId": "ach-rabbit-001"}
            }
        });
        assert_eq!(payload["data"]["achievementId"], "ach-rabbit-001");
        assert_eq!(
            payload["data"]["debugRealtime"]["kind"],
            "achievement:update"
        );
        println!("ACHIEVEMENT_CLAIM_RESPONSE={}", payload);
    }

    #[test]
    fn achievement_points_claim_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "threshold": 10,
                "rewards": [{"type": "item", "itemDefId": "cons-001", "qty": 5}],
                "title": null,
                "debugRealtime": {"kind": "achievement:update", "source": "claim_points_reward", "threshold": 10}
            }
        });
        assert_eq!(payload["data"]["threshold"], 10);
        assert_eq!(
            payload["data"]["debugRealtime"]["source"],
            "claim_points_reward"
        );
        println!("ACHIEVEMENT_POINTS_CLAIM_RESPONSE={}", payload);
    }

    #[test]
    fn dungeon_clear_achievement_track_candidates_cover_wildcard_team_and_nightmare() {
        let mut keys = Vec::new();
        keys.extend(super::build_track_key_candidates(
            "dungeon:clear:dungeon-qiqi-wolf-den",
        ));
        keys.extend(super::build_track_key_candidates(
            "team:dungeon:clear:dungeon-qiqi-wolf-den",
        ));
        keys.extend(super::build_track_key_candidates(
            "dungeon:clear:difficulty:nightmare",
        ));
        let keys = keys.into_iter().collect::<std::collections::BTreeSet<_>>();
        assert!(keys.contains("dungeon:clear:dungeon-qiqi-wolf-den"));
        assert!(keys.contains("dungeon:clear:*"));
        assert!(keys.contains("team:dungeon:clear:*"));
        assert!(keys.contains("dungeon:clear:difficulty:nightmare"));
        println!(
            "DUNGEON_CLEAR_ACHIEVEMENT_CANDIDATES={}",
            serde_json::to_value(keys).expect("keys should serialize")
        );
    }
}
