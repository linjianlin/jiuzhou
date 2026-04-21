use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::auth;
use crate::integrations::wander_ai::{
    WanderAiEpisodeResolutionDraft, WanderAiEpisodeSetupDraft,
    generate_wander_ai_episode_resolution_draft, generate_wander_ai_episode_setup_draft,
    read_wander_ai_config,
};
use crate::jobs;
use crate::realtime::public_socket::emit_wander_update_to_user;
use crate::realtime::wander::build_wander_update_payload;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderGenerationJobDto {
    pub generation_id: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderEpisodeOptionDto {
    pub index: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderEpisodeDto {
    pub id: String,
    pub day_key: String,
    pub day_index: i64,
    pub title: String,
    pub opening: String,
    pub options: Vec<WanderEpisodeOptionDto>,
    pub chosen_option_index: Option<i64>,
    pub chosen_option_text: Option<String>,
    pub summary: String,
    pub is_ending: bool,
    pub ending_type: String,
    pub reward_title_name: Option<String>,
    pub reward_title_desc: Option<String>,
    pub reward_title_color: Option<String>,
    pub reward_title_effects: std::collections::BTreeMap<String, f64>,
    pub created_at: String,
    pub chosen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderStoryDto {
    pub id: String,
    pub status: String,
    pub theme: String,
    pub premise: String,
    pub summary: String,
    pub episode_count: i64,
    pub reward_title_id: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub episodes: Vec<WanderEpisodeDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderGeneratedTitleDto {
    pub id: String,
    pub name: String,
    pub description: String,
    pub color: Option<String>,
    pub effects: std::collections::BTreeMap<String, f64>,
    pub is_equipped: bool,
    pub obtained_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderOverviewDto {
    pub today: String,
    pub ai_available: bool,
    pub has_pending_episode: bool,
    pub is_resolving_episode: bool,
    pub can_generate: bool,
    pub is_cooling_down: bool,
    pub cooldown_until: Option<String>,
    pub cooldown_remaining_seconds: i64,
    pub current_generation_job: Option<WanderGenerationJobDto>,
    pub active_story: Option<WanderStoryDto>,
    pub current_episode: Option<WanderEpisodeDto>,
    pub latest_finished_story: Option<WanderStoryDto>,
    pub generated_titles: Vec<WanderGeneratedTitleDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderGenerateQueueResultDto {
    pub job: WanderGenerationJobDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderChooseResultDto {
    pub story: WanderStoryDto,
    pub job: WanderGenerationJobDto,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderChoosePayload {
    pub episode_id: String,
    pub option_index: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WanderGenerationProcessResult {
    pub status: String,
    pub episode_id: Option<String>,
    pub error_message: Option<String>,
}

pub async fn get_wander_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let overview = load_wander_overview_data(&state, actor.character_id).await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(overview),
    }))
}

pub async fn load_wander_overview_data(
    state: &AppState,
    character_id: i64,
) -> Result<WanderOverviewDto, AppError> {
    let latest_episode = load_latest_episode_row(&state, character_id).await?;
    let active_story = load_story_with_episodes(&state, character_id, "active").await?;
    let latest_finished_story =
        load_latest_finished_story_with_episodes(&state, character_id).await?;
    let generated_titles = load_generated_titles(&state, character_id).await?;
    let latest_generation_job = load_latest_generation_job(&state, character_id).await?;

    let now = current_local_time();
    let today = build_date_key(now);
    let ai_available = read_wander_ai_config(state).is_some();
    let cooldown_state = build_wander_cooldown_state(
        latest_episode.as_ref().map(|row| row.created_at.as_str()),
        now,
        state.config.service.node_env.as_str(),
    );
    let current_episode = if let Some(episode) = latest_episode.clone() {
        if episode.chosen_option_index.is_none()
            || episode.chosen_at.is_none()
            || cooldown_state.is_cooling_down
        {
            Some(map_episode_row(episode))
        } else {
            None
        }
    } else {
        None
    };
    let latest_episode_created_at_ms = latest_episode
        .as_ref()
        .and_then(|row| parse_rfc3339(&row.created_at))
        .map(|dt| dt.unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(i128::MIN);
    let latest_generation_job_created_at_ms = latest_generation_job
        .as_ref()
        .and_then(|row| parse_rfc3339(&row.started_at))
        .map(|dt| dt.unix_timestamp_nanos() / 1_000_000)
        .unwrap_or(i128::MIN);
    let current_generation_job = latest_generation_job.as_ref().and_then(|row| {
        let pending_or_failed = row.status == "pending" || row.status == "failed";
        let expose = pending_or_failed
            && ((current_episode.is_some()
                && row.generated_episode_id.as_deref()
                    == current_episode.as_ref().map(|ep| ep.id.as_str())
                && current_episode
                    .as_ref()
                    .and_then(|ep| ep.chosen_at.as_deref())
                    .is_none())
                || latest_episode_created_at_ms == i128::MIN
                || latest_generation_job_created_at_ms >= latest_episode_created_at_ms);
        expose.then(|| map_generation_job_row(row.clone()))
    });
    let has_pending_episode = current_episode
        .as_ref()
        .map(|ep| ep.chosen_option_index.is_none())
        .unwrap_or(false);
    let is_resolving_episode = current_episode
        .as_ref()
        .map(|ep| ep.chosen_option_index.is_some() && ep.chosen_at.is_none())
        .unwrap_or(false);
    let can_generate = ai_available
        && !has_pending_episode
        && !is_resolving_episode
        && !cooldown_state.is_cooling_down
        && current_generation_job
            .as_ref()
            .map(|job| job.status.as_str())
            != Some("pending");

    Ok(WanderOverviewDto {
        today,
        ai_available,
        has_pending_episode,
        is_resolving_episode,
        can_generate,
        is_cooling_down: cooldown_state.is_cooling_down,
        cooldown_until: cooldown_state.cooldown_until,
        cooldown_remaining_seconds: cooldown_state.cooldown_remaining_seconds,
        current_generation_job,
        active_story,
        current_episode,
        latest_finished_story,
        generated_titles,
    })
}

pub async fn create_wander_generation_job(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let state_for_enqueue = state.clone();
    let result = state
        .database
        .with_transaction(|| async {
            create_wander_generation_job_tx(&state, actor.character_id).await
        })
        .await?;
    if result.success {
        if let Some(job) = result.data.as_ref().map(|data| data.job.clone()) {
            let character_id = actor.character_id;
            state
                .database
                .after_transaction_commit(async move {
                    jobs::enqueue_wander_generation_job(
                        state_for_enqueue,
                        character_id,
                        job.generation_id,
                    )
                    .await
                })
                .await?;
        }
        if let Ok(overview) = load_wander_overview_data(&state, actor.character_id).await {
            emit_wander_update_to_user(
                &state,
                actor.user_id,
                &build_wander_update_payload(overview),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn choose_wander_episode_option(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<WanderChoosePayload>,
) -> Result<Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let state_for_enqueue = state.clone();
    let result = state
        .database
        .with_transaction(|| async {
            choose_wander_episode_option_tx(
                &state,
                actor.character_id,
                &payload.episode_id,
                payload.option_index,
            )
            .await
        })
        .await?;
    if result.success {
        if let Some(job) = result.data.as_ref().map(|data| data.job.clone()) {
            let character_id = actor.character_id;
            state
                .database
                .after_transaction_commit(async move {
                    jobs::enqueue_wander_generation_job(
                        state_for_enqueue,
                        character_id,
                        job.generation_id,
                    )
                    .await
                })
                .await?;
        }
        if let Ok(overview) = load_wander_overview_data(&state, actor.character_id).await {
            emit_wander_update_to_user(
                &state,
                actor.user_id,
                &build_wander_update_payload(overview),
            );
        }
    }
    Ok(send_result(result))
}

pub async fn process_pending_generation_job(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<ServiceResult<WanderGenerationProcessResult>, AppError> {
    state
        .database
        .with_transaction(|| async {
            process_pending_generation_job_tx(state, character_id, generation_id).await
        })
        .await
}

#[derive(Clone)]
struct WanderEpisodeRowData {
    id: String,
    story_id: String,
    day_key: String,
    day_index: i64,
    episode_title: String,
    opening: String,
    option_texts: Vec<String>,
    chosen_option_index: Option<i64>,
    chosen_option_text: Option<String>,
    episode_summary: String,
    is_ending: bool,
    ending_type: String,
    reward_title_name: Option<String>,
    reward_title_desc: Option<String>,
    reward_title_color: Option<String>,
    reward_title_effects: std::collections::BTreeMap<String, f64>,
    created_at: String,
    chosen_at: Option<String>,
}

fn opt_i64_from_i32(row: &sqlx::postgres::PgRow, column: &str) -> i64 {
    row.try_get::<Option<i32>, _>(column)
        .unwrap_or(None)
        .map(i64::from)
        .unwrap_or_default()
}

fn opt_i64_from_i32_opt(
    row: &sqlx::postgres::PgRow,
    column: &str,
) -> Result<Option<i64>, AppError> {
    Ok(row.try_get::<Option<i32>, _>(column)?.map(i64::from))
}

fn resolve_wander_story_max_episode_index(
    story_seed: i32,
    persisted_episode_count: Option<i64>,
) -> i64 {
    persisted_episode_count
        .filter(|value| *value > 0)
        .unwrap_or_else(|| resolve_wander_target_episode_count(story_seed))
}

fn resolve_wander_story_partner_snapshot_for_resolution(
    story_partner_snapshot: Option<serde_json::Value>,
) -> Option<WanderAiStoryPartnerDto> {
    story_partner_snapshot.and_then(parse_wander_story_partner_context)
}

fn resolve_new_wander_story_seed(timestamp_ms: i64) -> i32 {
    timestamp_ms.rem_euclid(i32::MAX as i64).max(1) as i32
}

fn resolve_wander_setup_story_summary(
    story_summary: Option<&str>,
    previous_episodes: &[WanderAiPreviousEpisodeContextDto],
) -> Option<String> {
    if !previous_episodes.is_empty() {
        return None;
    }
    story_summary
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

#[derive(Clone)]
struct WanderGenerationJobRowData {
    generation_id: String,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    error_message: Option<String>,
    generated_episode_id: Option<String>,
}

async fn load_latest_episode_row(
    state: &AppState,
    character_id: i64,
) -> Result<Option<WanderEpisodeRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, story_id, day_key::text AS day_key_text, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at::text AS created_at_text, chosen_at::text AS chosen_at_text FROM character_wander_story_episode WHERE character_id = $1 ORDER BY day_key DESC, day_index DESC, created_at DESC LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    row.map(parse_episode_row).transpose()
}

async fn load_story_with_episodes(
    state: &AppState,
    character_id: i64,
    status: &str,
) -> Result<Option<WanderStoryDto>, AppError> {
    let story = state.database.fetch_optional(
        "SELECT id, status, story_theme, story_premise, story_summary, episode_count, reward_title_id, finished_at::text AS finished_at_text, created_at::text AS created_at_text, updated_at::text AS updated_at_text FROM character_wander_story WHERE character_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1",
        |query| query.bind(character_id).bind(status),
    ).await?;
    let Some(story) = story else {
        return Ok(None);
    };
    let story_id = story
        .try_get::<Option<String>, _>("id")?
        .unwrap_or_default();
    let episodes = load_story_episodes(state, &story_id).await?;
    Ok(Some(WanderStoryDto {
        id: story_id,
        status: story
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_else(|| status.to_string()),
        theme: story
            .try_get::<Option<String>, _>("story_theme")?
            .unwrap_or_default(),
        premise: story
            .try_get::<Option<String>, _>("story_premise")?
            .unwrap_or_default(),
        summary: story
            .try_get::<Option<String>, _>("story_summary")?
            .unwrap_or_default(),
        episode_count: opt_i64_from_i32(&story, "episode_count"),
        reward_title_id: story.try_get::<Option<String>, _>("reward_title_id")?,
        finished_at: story.try_get::<Option<String>, _>("finished_at_text")?,
        created_at: story
            .try_get::<Option<String>, _>("created_at_text")?
            .unwrap_or_default(),
        updated_at: story
            .try_get::<Option<String>, _>("updated_at_text")?
            .unwrap_or_default(),
        episodes,
    }))
}

async fn load_story_with_episodes_by_id(
    state: &AppState,
    story_id: &str,
) -> Result<Option<WanderStoryDto>, AppError> {
    let story = state.database.fetch_optional(
        "SELECT id, status, story_theme, story_premise, story_summary, episode_count, reward_title_id, finished_at::text AS finished_at_text, created_at::text AS created_at_text, updated_at::text AS updated_at_text FROM character_wander_story WHERE id = $1 LIMIT 1",
        |query| query.bind(story_id),
    ).await?;
    let Some(story) = story else {
        return Ok(None);
    };
    let story_id = story
        .try_get::<Option<String>, _>("id")?
        .unwrap_or_default();
    let episodes = load_story_episodes(state, &story_id).await?;
    Ok(Some(WanderStoryDto {
        id: story_id,
        status: story
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_else(|| "active".to_string()),
        theme: story
            .try_get::<Option<String>, _>("story_theme")?
            .unwrap_or_default(),
        premise: story
            .try_get::<Option<String>, _>("story_premise")?
            .unwrap_or_default(),
        summary: story
            .try_get::<Option<String>, _>("story_summary")?
            .unwrap_or_default(),
        episode_count: opt_i64_from_i32(&story, "episode_count"),
        reward_title_id: story.try_get::<Option<String>, _>("reward_title_id")?,
        finished_at: story.try_get::<Option<String>, _>("finished_at_text")?,
        created_at: story
            .try_get::<Option<String>, _>("created_at_text")?
            .unwrap_or_default(),
        updated_at: story
            .try_get::<Option<String>, _>("updated_at_text")?
            .unwrap_or_default(),
        episodes,
    }))
}

async fn load_latest_finished_story_with_episodes(
    state: &AppState,
    character_id: i64,
) -> Result<Option<WanderStoryDto>, AppError> {
    let story = state.database.fetch_optional(
        "SELECT id, status, story_theme, story_premise, story_summary, episode_count, reward_title_id, finished_at::text AS finished_at_text, created_at::text AS created_at_text, updated_at::text AS updated_at_text FROM character_wander_story WHERE character_id = $1 AND status = 'finished' ORDER BY finished_at DESC NULLS LAST, created_at DESC LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    let Some(story) = story else {
        return Ok(None);
    };
    let story_id = story
        .try_get::<Option<String>, _>("id")?
        .unwrap_or_default();
    let episodes = load_story_episodes(state, &story_id).await?;
    Ok(Some(WanderStoryDto {
        id: story_id,
        status: story
            .try_get::<Option<String>, _>("status")?
            .unwrap_or_else(|| "finished".to_string()),
        theme: story
            .try_get::<Option<String>, _>("story_theme")?
            .unwrap_or_default(),
        premise: story
            .try_get::<Option<String>, _>("story_premise")?
            .unwrap_or_default(),
        summary: story
            .try_get::<Option<String>, _>("story_summary")?
            .unwrap_or_default(),
        episode_count: opt_i64_from_i32(&story, "episode_count"),
        reward_title_id: story.try_get::<Option<String>, _>("reward_title_id")?,
        finished_at: story.try_get::<Option<String>, _>("finished_at_text")?,
        created_at: story
            .try_get::<Option<String>, _>("created_at_text")?
            .unwrap_or_default(),
        updated_at: story
            .try_get::<Option<String>, _>("updated_at_text")?
            .unwrap_or_default(),
        episodes,
    }))
}

async fn load_story_episodes(
    state: &AppState,
    story_id: &str,
) -> Result<Vec<WanderEpisodeDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT id, story_id, day_key::text AS day_key_text, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at::text AS created_at_text, chosen_at::text AS chosen_at_text FROM character_wander_story_episode WHERE story_id = $1 ORDER BY day_index ASC",
        |query| query.bind(story_id),
    ).await?;
    rows.into_iter()
        .map(parse_episode_row)
        .map(|row| row.map(map_episode_row))
        .collect()
}

async fn load_generated_titles(
    state: &AppState,
    character_id: i64,
) -> Result<Vec<WanderGeneratedTitleDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT gtd.id, gtd.name, gtd.description, gtd.color, gtd.effects, ct.is_equipped, ct.obtained_at::text AS obtained_at_text FROM character_title ct JOIN generated_title_def gtd ON gtd.id = ct.title_id WHERE ct.character_id = $1 AND gtd.source_type = 'wander_story' AND gtd.enabled = true AND (ct.expires_at IS NULL OR ct.expires_at > NOW()) ORDER BY ct.obtained_at DESC, gtd.created_at DESC",
        |query| query.bind(character_id),
    ).await?;
    Ok(rows
        .into_iter()
        .map(|row| WanderGeneratedTitleDto {
            id: row
                .try_get::<Option<String>, _>("id")
                .unwrap_or(None)
                .unwrap_or_default(),
            name: row
                .try_get::<Option<String>, _>("name")
                .unwrap_or(None)
                .unwrap_or_default(),
            description: row
                .try_get::<Option<String>, _>("description")
                .unwrap_or(None)
                .unwrap_or_default(),
            color: normalize_wander_title_color(
                row.try_get::<Option<String>, _>("color").unwrap_or(None),
            ),
            effects: normalize_wander_title_effects(
                row.try_get::<Option<serde_json::Value>, _>("effects")
                    .unwrap_or(None),
            ),
            is_equipped: row
                .try_get::<Option<bool>, _>("is_equipped")
                .unwrap_or(None)
                .unwrap_or(false),
            obtained_at: row
                .try_get::<Option<String>, _>("obtained_at_text")
                .unwrap_or(None)
                .unwrap_or_default(),
        })
        .collect())
}

async fn load_latest_generation_job(
    state: &AppState,
    character_id: i64,
) -> Result<Option<WanderGenerationJobRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, status, error_message, generated_episode_id, created_at::text AS created_at_text, finished_at::text AS finished_at_text FROM character_wander_generation_job WHERE character_id = $1 ORDER BY created_at DESC LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    Ok(row
        .map(|row| WanderGenerationJobRowData {
            generation_id: row
                .try_get::<Option<String>, _>("id")
                .unwrap_or(None)
                .unwrap_or_default(),
            status: row
                .try_get::<Option<String>, _>("status")
                .unwrap_or(None)
                .unwrap_or_else(|| "pending".to_string()),
            started_at: row
                .try_get::<Option<String>, _>("created_at_text")
                .unwrap_or(None)
                .unwrap_or_default(),
            finished_at: row
                .try_get::<Option<String>, _>("finished_at_text")
                .unwrap_or(None),
            error_message: row
                .try_get::<Option<String>, _>("error_message")
                .unwrap_or(None),
            generated_episode_id: row
                .try_get::<Option<String>, _>("generated_episode_id")
                .unwrap_or(None),
        })
        .map(|row| row))
}

async fn load_latest_generation_job_by_episode(
    state: &AppState,
    character_id: i64,
    episode_id: &str,
) -> Result<Option<WanderGenerationJobRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, status, error_message, generated_episode_id, created_at::text AS created_at_text, finished_at::text AS finished_at_text FROM character_wander_generation_job WHERE character_id = $1 AND generated_episode_id = $2 ORDER BY created_at DESC LIMIT 1",
        |query| query.bind(character_id).bind(episode_id),
    ).await?;
    Ok(row
        .map(|row| WanderGenerationJobRowData {
            generation_id: row
                .try_get::<Option<String>, _>("id")
                .unwrap_or(None)
                .unwrap_or_default(),
            status: row
                .try_get::<Option<String>, _>("status")
                .unwrap_or(None)
                .unwrap_or_else(|| "pending".to_string()),
            started_at: row
                .try_get::<Option<String>, _>("created_at_text")
                .unwrap_or(None)
                .unwrap_or_default(),
            finished_at: row
                .try_get::<Option<String>, _>("finished_at_text")
                .unwrap_or(None),
            error_message: row
                .try_get::<Option<String>, _>("error_message")
                .unwrap_or(None),
            generated_episode_id: row
                .try_get::<Option<String>, _>("generated_episode_id")
                .unwrap_or(None),
        })
        .map(|row| row))
}

async fn load_episode_row_by_id_for_update(
    state: &AppState,
    character_id: i64,
    episode_id: &str,
) -> Result<Option<WanderEpisodeRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, story_id, day_key::text AS day_key_text, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at::text AS created_at_text, chosen_at::text AS chosen_at_text FROM character_wander_story_episode WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(episode_id).bind(character_id),
    ).await?;
    row.map(parse_episode_row).transpose()
}

async fn load_episode_row_by_id(
    state: &AppState,
    character_id: i64,
    episode_id: &str,
) -> Result<Option<WanderEpisodeRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, story_id, day_key::text AS day_key_text, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at::text AS created_at_text, chosen_at::text AS chosen_at_text FROM character_wander_story_episode WHERE id = $1 AND character_id = $2 LIMIT 1",
        |query| query.bind(episode_id).bind(character_id),
    ).await?;
    row.map(parse_episode_row).transpose()
}

async fn load_episode_row_by_day_key(
    state: &AppState,
    character_id: i64,
    day_key: &str,
) -> Result<Option<WanderEpisodeRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, story_id, day_key::text AS day_key_text, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at::text AS created_at_text, chosen_at::text AS chosen_at_text FROM character_wander_story_episode WHERE character_id = $1 AND day_key = $2::date ORDER BY day_index DESC, created_at DESC LIMIT 1",
        |query| query.bind(character_id).bind(day_key),
    ).await?;
    row.map(parse_episode_row).transpose()
}

async fn load_generation_job_by_id_for_update(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<Option<WanderGenerationJobWithDayKeyRowData>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT id, day_key::text AS day_key_text, status, error_message, generated_episode_id, created_at::text AS created_at_text, finished_at::text AS finished_at_text FROM character_wander_generation_job WHERE id = $1 AND character_id = $2 LIMIT 1 FOR UPDATE",
        |query| query.bind(generation_id).bind(character_id),
    ).await?;
    Ok(row.map(|row| WanderGenerationJobWithDayKeyRowData {
        day_key: normalize_date_key(
            row.try_get::<Option<String>, _>("day_key_text")
                .unwrap_or(None)
                .unwrap_or_default(),
        ),
        status: row
            .try_get::<Option<String>, _>("status")
            .unwrap_or(None)
            .unwrap_or_else(|| "pending".to_string()),
        error_message: row
            .try_get::<Option<String>, _>("error_message")
            .unwrap_or(None),
        generated_episode_id: row
            .try_get::<Option<String>, _>("generated_episode_id")
            .unwrap_or(None),
    }))
}

async fn load_character_exists(state: &AppState, character_id: i64) -> Result<bool, AppError> {
    Ok(state
        .database
        .fetch_optional("SELECT id FROM characters WHERE id = $1 LIMIT 1", |query| {
            query.bind(character_id)
        })
        .await?
        .is_some())
}

async fn create_wander_generation_job_tx(
    state: &AppState,
    character_id: i64,
) -> Result<ServiceResult<WanderGenerateQueueResultDto>, AppError> {
    if read_wander_ai_config(state).is_none() {
        return Ok(failure_result("未配置 AI 文本模型，无法生成云游奇遇"));
    }

    let (latest_generation_job, character_exists, latest_episode) = tokio::join!(
        load_latest_generation_job(state, character_id),
        load_character_exists(state, character_id),
        load_latest_episode_row(state, character_id)
    );
    let latest_generation_job = latest_generation_job?;
    let character_exists = character_exists?;
    let latest_episode = latest_episode?;

    if !character_exists {
        return Ok(failure_result("角色不存在"));
    }

    if latest_episode
        .as_ref()
        .and_then(|episode| episode.chosen_option_index)
        .is_none()
        && latest_episode.is_some()
    {
        return Ok(failure_result("当前奇遇已生成，等待抉择"));
    }

    if let Some(job) = latest_generation_job.clone() {
        if job.status == "pending" {
            return Ok(ServiceResult {
                success: true,
                message: Some("当前云游正在生成中".to_string()),
                data: Some(WanderGenerateQueueResultDto {
                    job: map_generation_job_row(job),
                }),
            });
        }
    }

    let now = current_local_time();
    let cooldown_state = build_wander_cooldown_state(
        latest_episode.as_ref().map(|row| row.created_at.as_str()),
        now,
        state.config.service.node_env.as_str(),
    );
    if cooldown_state.is_cooling_down {
        return Ok(failure_result(&format!(
            "云游冷却中，还需等待{}",
            format_wander_cooldown_remaining(cooldown_state.cooldown_remaining_seconds)
        )));
    }

    let generation_id = build_generation_id();
    let generation_day_key = resolve_wander_generation_day_key(
        latest_episode
            .as_ref()
            .map(|episode| episode.day_key.as_str()),
        now,
    );
    let started_at = format_rfc3339(now)?;
    state.database.execute(
        "INSERT INTO character_wander_generation_job (id, character_id, day_key, status, error_message, generated_episode_id, created_at, finished_at) VALUES ($1, $2, $3::date, 'pending', NULL, NULL, NOW(), NULL)",
        |query| query.bind(&generation_id).bind(character_id).bind(&generation_day_key),
    ).await?;

    Ok(ServiceResult {
        success: true,
        message: Some("当前云游已进入推演".to_string()),
        data: Some(WanderGenerateQueueResultDto {
            job: WanderGenerationJobDto {
                generation_id,
                status: "pending".to_string(),
                started_at,
                finished_at: None,
                error_message: None,
            },
        }),
    })
}

async fn choose_wander_episode_option_tx(
    state: &AppState,
    character_id: i64,
    episode_id: &str,
    option_index: i64,
) -> Result<ServiceResult<WanderChooseResultDto>, AppError> {
    let normalized_option_index = option_index;
    if normalized_option_index < 0 || normalized_option_index > 2 {
        return Ok(failure_result("选项参数错误"));
    }

    let Some(mut episode) =
        load_episode_row_by_id_for_update(state, character_id, episode_id).await?
    else {
        return Ok(failure_result("奇遇幕次不存在"));
    };

    let chosen_option_text = if episode.chosen_option_index.is_none() {
        let Some(option_text) = episode
            .option_texts
            .get(normalized_option_index as usize)
            .cloned()
        else {
            return Ok(failure_result("所选选项不存在"));
        };
        state.database.execute(
            "UPDATE character_wander_story_episode SET chosen_option_index = $2, chosen_option_text = $3, chosen_at = NULL WHERE id = $1",
            |query| query.bind(&episode.id).bind(normalized_option_index).bind(&option_text),
        ).await?;
        episode.chosen_option_index = Some(normalized_option_index);
        episode.chosen_option_text = Some(option_text.clone());
        option_text
    } else {
        if episode.chosen_at.is_some() {
            return Ok(failure_result("本幕已作出选择"));
        }
        if episode.chosen_option_index != Some(normalized_option_index) {
            return Ok(failure_result("本幕已锁定其他选择"));
        }
        let Some(option_text) = episode.chosen_option_text.clone() else {
            return Ok(failure_result("本幕已记录的选择缺失"));
        };
        option_text
    };

    if let Some(job) =
        load_latest_generation_job_by_episode(state, character_id, &episode.id).await?
    {
        if job.status == "pending" {
            let Some(story) = load_story_with_episodes_by_id(state, &episode.story_id).await?
            else {
                return Ok(failure_result("奇遇故事不存在"));
            };
            return Ok(ServiceResult {
                success: true,
                message: Some("当前云游正在推演后续结果".to_string()),
                data: Some(WanderChooseResultDto {
                    story,
                    job: map_generation_job_row(job),
                }),
            });
        }
    }

    let generation_id = build_generation_id();
    let started_at = format_rfc3339(current_local_time())?;
    state.database.execute(
        "INSERT INTO character_wander_generation_job (id, character_id, day_key, status, error_message, generated_episode_id, created_at, finished_at) VALUES ($1, $2, $3::date, 'pending', NULL, $4, NOW(), NULL)",
        |query| query.bind(&generation_id).bind(character_id).bind(&episode.day_key).bind(&episode.id),
    ).await?;

    let Some(story) = load_story_with_episodes_by_id(state, &episode.story_id).await? else {
        return Ok(failure_result("奇遇故事不存在"));
    };

    let message = if episode.is_ending {
        "终幕抉择已落定，正在推演结局"
    } else {
        "本幕抉择已落定，正在推演后续结果"
    };

    let _ = chosen_option_text;

    Ok(ServiceResult {
        success: true,
        message: Some(message.to_string()),
        data: Some(WanderChooseResultDto {
            story,
            job: WanderGenerationJobDto {
                generation_id,
                status: "pending".to_string(),
                started_at,
                finished_at: None,
                error_message: None,
            },
        }),
    })
}

async fn process_pending_generation_job_tx(
    state: &AppState,
    character_id: i64,
    generation_id: &str,
) -> Result<ServiceResult<WanderGenerationProcessResult>, AppError> {
    let Some(job) =
        load_generation_job_by_id_for_update(state, character_id, generation_id).await?
    else {
        return Ok(failure_result("云游生成任务不存在"));
    };

    if job.status != "pending" {
        return Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(WanderGenerationProcessResult {
                status: if job.status == "generated" {
                    "generated".to_string()
                } else {
                    "failed".to_string()
                },
                episode_id: job.generated_episode_id,
                error_message: job.error_message,
            }),
        });
    }

    if let Some(target_episode_id) = job.generated_episode_id.clone() {
        let Some(target_episode) =
            load_episode_row_by_id(state, character_id, &target_episode_id).await?
        else {
            let reason = "云游结算幕次不存在";
            update_generation_job_as_failed(state, generation_id, reason).await?;
            return Ok(process_failure_result(reason));
        };
        if target_episode.chosen_at.is_some() {
            update_generation_job_as_generated(state, generation_id, &target_episode.id).await?;
            return Ok(process_generated_result(&target_episode.id));
        }
        if target_episode.chosen_option_index.is_none()
            || target_episode.chosen_option_text.is_none()
        {
            let reason = "云游结算缺少已确认的选项";
            update_generation_job_as_failed(state, generation_id, reason).await?;
            return Ok(process_failure_result(reason));
        }
        match settle_wander_episode_choice(state, character_id, &target_episode).await {
            Ok(_next_episode_id) => {
                update_generation_job_as_generated(state, generation_id, &target_episode.id)
                    .await?;
                return Ok(process_generated_result(&target_episode.id));
            }
            Err(error) => {
                update_generation_job_as_failed(state, generation_id, &error.to_string()).await?;
                return Ok(process_failure_result(&error.to_string()));
            }
        }
    }

    if let Some(existing_episode) =
        load_episode_row_by_day_key(state, character_id, &job.day_key).await?
    {
        update_generation_job_as_generated(state, generation_id, &existing_episode.id).await?;
        return Ok(process_generated_result(&existing_episode.id));
    }

    match create_wander_episode_for_day_key(state, character_id, &job.day_key).await? {
        Some(episode_id) => {
            update_generation_job_as_generated(state, generation_id, &episode_id).await?;
            Ok(process_generated_result(&episode_id))
        }
        None => {
            let reason = "云游奇遇生成失败";
            update_generation_job_as_failed(state, generation_id, reason).await?;
            Ok(process_failure_result(reason))
        }
    }
}

fn map_generation_job_row(row: WanderGenerationJobRowData) -> WanderGenerationJobDto {
    WanderGenerationJobDto {
        generation_id: row.generation_id,
        status: row.status,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error_message: row.error_message,
    }
}

async fn update_generation_job_as_failed(
    state: &AppState,
    generation_id: &str,
    error_message: &str,
) -> Result<(), AppError> {
    state.database.execute(
        "UPDATE character_wander_generation_job SET status = 'failed', error_message = $2, finished_at = NOW() WHERE id = $1",
        |query| query.bind(generation_id).bind(error_message),
    ).await?;
    Ok(())
}

async fn update_generation_job_as_generated(
    state: &AppState,
    generation_id: &str,
    episode_id: &str,
) -> Result<(), AppError> {
    state.database.execute(
        "UPDATE character_wander_generation_job SET status = 'generated', generated_episode_id = $2, error_message = NULL, finished_at = NOW() WHERE id = $1",
        |query| query.bind(generation_id).bind(episode_id),
    ).await?;
    Ok(())
}

fn process_generated_result(episode_id: &str) -> ServiceResult<WanderGenerationProcessResult> {
    ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(WanderGenerationProcessResult {
            status: "generated".to_string(),
            episode_id: Some(episode_id.to_string()),
            error_message: None,
        }),
    }
}

fn process_failure_result(reason: &str) -> ServiceResult<WanderGenerationProcessResult> {
    ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(WanderGenerationProcessResult {
            status: "failed".to_string(),
            episode_id: None,
            error_message: Some(reason.to_string()),
        }),
    }
}

#[derive(Debug, Clone)]
struct WanderResolutionOutcome {
    summary: String,
    ending_type: String,
    reward_title_name: Option<String>,
    reward_title_desc: Option<String>,
    reward_title_color: Option<String>,
    reward_title_effects: std::collections::BTreeMap<String, f64>,
}

fn validate_wander_ending_reward_fields(outcome: &WanderResolutionOutcome) -> Result<(), AppError> {
    let missing_name = outcome
        .reward_title_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none();
    let missing_desc = outcome
        .reward_title_desc
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none();
    let missing_color = outcome.reward_title_color.is_none();
    let missing_effects = outcome.reward_title_effects.is_empty();
    if missing_name || missing_desc || missing_color || missing_effects {
        return Err(AppError::config("结局称号数据缺失"));
    }
    Ok(())
}

fn normalize_wander_resolution_outcome(
    outcome: WanderResolutionOutcome,
) -> WanderResolutionOutcome {
    WanderResolutionOutcome {
        summary: outcome.summary,
        ending_type: normalize_ending_type(&outcome.ending_type),
        reward_title_name: outcome
            .reward_title_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        reward_title_desc: outcome
            .reward_title_desc
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        reward_title_color: normalize_wander_title_color(outcome.reward_title_color),
        reward_title_effects: normalize_wander_title_effects_value_map(
            outcome.reward_title_effects,
        ),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WanderAiPreviousEpisodeContextDto {
    day_index: i64,
    location_name: String,
    title: String,
    opening: String,
    chosen_option_text: String,
    summary: String,
    is_ending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WanderAiStoryLocationDto {
    region: String,
    map_id: String,
    map_name: String,
    area_id: String,
    area_name: String,
    full_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WanderAiStoryPartnerDto {
    partner_id: i64,
    partner_def_id: String,
    nickname: String,
    name: String,
    description: Option<String>,
    role: String,
    quality: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WanderAiStoryOtherPlayerDto {
    character_id: i64,
    nickname: String,
    title: Option<String>,
    realm: String,
    sub_realm: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct WanderMapSeedFile {
    maps: Vec<WanderMapSeed>,
}

#[derive(Debug, serde::Deserialize)]
struct WanderMapSeed {
    id: String,
    name: Option<String>,
    region: Option<String>,
    enabled: Option<bool>,
    rooms: Option<Vec<WanderRoomSeed>>,
}

#[derive(Debug, serde::Deserialize)]
struct WanderRoomSeed {
    id: String,
    name: Option<String>,
}

const WANDER_STORY_PARTNER_INCLUDE_RATE: f64 = 0.1;
const WANDER_STORY_OTHER_PLAYER_INCLUDE_RATE: f64 = 0.1;
const WANDER_TITLE_EFFECT_KEYS: &[&str] = &[
    "max_qixue",
    "max_lingqi",
    "wugong",
    "fagong",
    "wufang",
    "fafang",
    "sudu",
    "fuyuan",
    "mingzhong",
    "shanbi",
    "zhaojia",
    "baoji",
    "baoshang",
    "jianbaoshang",
    "jianfantan",
    "kangbao",
    "zengshang",
    "zhiliao",
    "jianliao",
    "xixue",
    "lengque",
    "kongzhi_kangxing",
    "jin_kangxing",
    "mu_kangxing",
    "shui_kangxing",
    "huo_kangxing",
    "tu_kangxing",
    "qixue_huifu",
    "lingqi_huifu",
];
const WANDER_TITLE_RATIO_EFFECT_KEYS: &[&str] = &[
    "mingzhong",
    "shanbi",
    "zhaojia",
    "baoji",
    "baoshang",
    "jianbaoshang",
    "jianfantan",
    "kangbao",
    "zengshang",
    "zhiliao",
    "jianliao",
    "xixue",
    "lengque",
    "kongzhi_kangxing",
    "jin_kangxing",
    "mu_kangxing",
    "shui_kangxing",
    "huo_kangxing",
    "tu_kangxing",
];
const WANDER_TITLE_RATIO_EFFECT_PRECISION: f64 = 10_000.0;
const WANDER_TITLE_COLOR_PATTERN: &str = "#RRGGBB";
const WANDER_TITLE_MIN_EFFECT_COUNT: usize = 1;
const WANDER_TITLE_MAX_EFFECT_COUNT: usize = 5;
const WANDER_SUMMARY_STYLE_RULE: &str = "summary 必须是 20 到 160 字的结果摘要，要明确体现玩家本次选择直接造成的结果、局势变化或收束，禁止脱离 chosenOptionText 单独编写空泛结论，也不要套用总结腔。";
const WANDER_SUMMARY_EXAMPLE: &str = "你借灯试探来意后顺势稳住桥上气机，逼得对岸来客率先露出口风，也让桥下暗潮彻底惊动，原本暗里的试探当场转成了无法回避的正面冲突。";
const WANDER_TITLE_COLOR_EXAMPLE: &str = "#faad14";
const WANDER_TITLE_EFFECT_GUIDE: &str = "max_qixue(气血上限)、max_lingqi(灵气上限)、wugong(物攻)、fagong(法攻)、wufang(物防)、fafang(法防)、sudu(速度)、fuyuan(福源)、mingzhong(命中)、shanbi(闪避)、zhaojia(招架)、baoji(暴击)、baoshang(暴伤)、jianbaoshang(暴伤减免)、jianfantan(反伤减免)、kangbao(抗暴)、zengshang(增伤)、zhiliao(治疗)、jianliao(减疗)、xixue(吸血)、lengque(冷却)、kongzhi_kangxing(控制抗性)、jin_kangxing(金抗性)、mu_kangxing(木抗性)、shui_kangxing(水抗性)、huo_kangxing(火抗性)、tu_kangxing(土抗性)、qixue_huifu(气血恢复)、lingqi_huifu(灵气恢复)";
const WANDER_TITLE_EFFECT_LIMIT_GUIDE: &str = "max_qixue(气血上限<=240)、max_lingqi(灵气上限<=200)、wugong(物攻<=60)、fagong(法攻<=60)、wufang(物防<=120)、fafang(法防<=120)、sudu(速度<=30)、fuyuan(福源<=15)、mingzhong(命中<=8%)、shanbi(闪避<=8%)、zhaojia(招架<=8%)、baoji(暴击<=8%)、baoshang(暴伤<=8%)、jianbaoshang(暴伤减免<=8%)、jianfantan(反伤减免<=8%)、kangbao(抗暴<=8%)、zengshang(增伤<=8%)、zhiliao(治疗<=8%)、jianliao(减疗<=8%)、xixue(吸血<=8%)、lengque(冷却<=8%)、kongzhi_kangxing(控制抗性<=8%)、jin_kangxing(金抗性<=8%)、mu_kangxing(木抗性<=8%)、shui_kangxing(水抗性<=8%)、huo_kangxing(火抗性<=8%)、tu_kangxing(土抗性<=8%)、qixue_huifu(气血恢复<=20)、lingqi_huifu(灵气恢复<=15)";
const WANDER_NON_ENDING_TITLE_FIELD_RULE: &str = "非终幕结算必须返回 endingType=none，rewardTitleName、rewardTitleDesc、rewardTitleColor 必须为空字符串，rewardTitleEffects 必须为空数组，不允许返回占位称号或任意属性。";
const WANDER_TITLE_EFFECT_EXAMPLE_JSON: &str = r#"[{"key":"max_qixue","value":200},{"key":"wugong","value":60},{"key":"fagong","value":60},{"key":"baoji","value":0.03}]"#;
const WANDER_REALM_ORDER_PROMPT: &str = "游戏境界顺序示例：凡人 > 炼精化炁·养气期 > 炼精化炁·通脉期 > 炼精化炁·凝炁期 > 炼炁化神·炼己期 > 炼炁化神·采药期 > 炼炁化神·结胎期 > 炼神返虚·养神期 > 炼神返虚·还虚期 > 炼神返虚·合道期 > 炼虚合道·证道期 > 炼虚合道·历劫期 > 炼虚合道·成圣期";
const WANDER_REALM_RULE: &str = "玩家与同行修士的境界只能使用以上游戏境界，禁止写炼气期、筑基期、结丹期或任何其他体系的境界名。";
const WANDER_OPTION_EXAMPLE_JSON: &str =
    r#"["先借檐避雨，再试探来意","绕到桥下暗查灵息","收敛气机，静观其变"]"#;
const WANDER_STORY_THEME_EXAMPLE: &str = "雨夜借灯";
const WANDER_STORY_THEME_STYLE_RULE: &str = "storyTheme 必须是 24 字内主题短词，只概括这一幕或这条故事线的意象母题，禁止把剧情摘要直接写进 storyTheme，也不要写完整事件经过或长句解释。";
const WANDER_STORY_PREMISE_EXAMPLE: &str =
    "你循着残留血迹误入谷口深处，才觉今夜盘踞此地的异物并非寻常山兽。";
const WANDER_STORY_PREMISE_STYLE_RULE: &str = "storyPremise 必须是 8 到 120 字的故事引子，只概括整条奇遇当前的起势、缘由或悬念，像一句前情提要；禁止把整幕 opening 原样压缩，也不要写成标题、角色独白或过长剧情摘要。";
const WANDER_OPTION_STYLE_RULE: &str = "optionTexts 必须是长度恰好为 3 的字符串数组，每个元素都必须是非空短句，禁止返回空字符串、null、对象、嵌套数组或把三个选项拼成一个字符串。";
const WANDER_EPISODE_TITLE_STYLE_RULE: &str = "episodeTitle 必须是 24字内中文短标题，像“雨夜借灯”“断桥问剑”，禁止句子式长标题、标点堆砌和副标题。";
const WANDER_OPENING_STYLE_RULE: &str = "opening 必须是一段 80 到 420 字的完整正文，要交代当下场景、人物动作与异样征兆，并把局势推到玩家抉择前一刻；若 previousEpisodes 非空，opening 必须从最近一幕 summary 已经发生之后继续推进，只允许用极短承接句带过上一幕已成事实的结果，禁止复述最近一幕 summary 已明确写出的动作、景象、措辞或因果；禁止提前替玩家做选择，禁止提前给出尾声、结局或称号。";
const WANDER_OPENING_EXAMPLE: &str = "夜雨压桥，河雾顺着石栏缓缓爬起，你才在破庙檐下收住衣角，便见对岸灯影摇成一线。那人披着旧蓑衣，手里提灯不前不后，只隔着雨幕望来，像是在等谁认出他的来意；桥下水声却忽然沉了一拍，仿佛另有什么东西正贴着桥墩缓缓游过。";
const WANDER_ENDING_SCENE_RULE: &str = "若本幕是终幕抉择幕，opening 也只能把局势推到最后抉择前一刻，不能提前写玩家选择后的尾声、结局类型、称号名、称号描述、颜色或属性。";
static WANDER_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn build_wander_title_effect_value_max_map() -> serde_json::Value {
    serde_json::json!({
        "max_qixue": 240,
        "max_lingqi": 200,
        "wugong": 60,
        "fagong": 60,
        "wufang": 120,
        "fafang": 120,
        "sudu": 30,
        "fuyuan": 15,
        "mingzhong": 0.08,
        "shanbi": 0.08,
        "zhaojia": 0.08,
        "baoji": 0.08,
        "baoshang": 0.08,
        "jianbaoshang": 0.08,
        "jianfantan": 0.08,
        "kangbao": 0.08,
        "zengshang": 0.08,
        "zhiliao": 0.08,
        "jianliao": 0.08,
        "xixue": 0.08,
        "lengque": 0.08,
        "kongzhi_kangxing": 0.08,
        "jin_kangxing": 0.08,
        "mu_kangxing": 0.08,
        "shui_kangxing": 0.08,
        "huo_kangxing": 0.08,
        "tu_kangxing": 0.08,
        "qixue_huifu": 20,
        "lingqi_huifu": 15,
    })
}

fn build_wander_non_ending_title_field_example() -> serde_json::Value {
    serde_json::json!({
        "endingType": "none",
        "rewardTitleName": "",
        "rewardTitleDesc": "",
        "rewardTitleColor": "",
        "rewardTitleEffects": []
    })
}

fn build_wander_prompt_noise_hash(scope: &str, seed: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}", scope, seed));
    let digest = hasher.finalize();
    let hex = format!("{:x}", digest);
    hex.chars().take(16).collect()
}

fn build_wander_prompt_noise_seed() -> i64 {
    rand::thread_rng().gen_range(1_i64..=2_147_483_647_i64)
}

async fn settle_wander_episode_choice(
    state: &AppState,
    character_id: i64,
    episode: &WanderEpisodeRowData,
) -> Result<Option<String>, AppError> {
    let chosen_option_index = episode
        .chosen_option_index
        .ok_or_else(|| AppError::config("云游结算缺少已确认的选项"))?;
    let chosen_option_text = episode
        .chosen_option_text
        .as_deref()
        .ok_or_else(|| AppError::config("云游结算缺少已确认的选项"))?;
    let story = state.database.fetch_optional(
        "SELECT id, story_theme, story_premise, story_summary, story_seed, episode_count, story_partner_snapshot, story_other_player_snapshot FROM character_wander_story WHERE id = $1 LIMIT 1 FOR UPDATE",
        |query| query.bind(&episode.story_id),
    ).await?;
    let Some(story) = story else {
        return Err(AppError::config("奇遇故事不存在"));
    };
    let story_theme = story
        .try_get::<Option<String>, _>("story_theme")?
        .unwrap_or_else(|| "云游奇遇".to_string());
    let story_premise = story
        .try_get::<Option<String>, _>("story_premise")?
        .unwrap_or_default();
    let story_summary = story
        .try_get::<Option<String>, _>("story_summary")?
        .unwrap_or_default();
    let story_partner = resolve_wander_story_partner_snapshot_for_resolution(
        story.try_get::<Option<serde_json::Value>, _>("story_partner_snapshot")?,
    );
    let story_other_player = story
        .try_get::<Option<serde_json::Value>, _>("story_other_player_snapshot")?
        .and_then(parse_wander_story_other_player_context);
    let character_row = state
        .database
        .fetch_optional(
            "SELECT nickname, realm, sub_realm FROM characters WHERE id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let character_row = character_row.ok_or_else(|| AppError::config("角色不存在"))?;
    let nickname = character_row
        .try_get::<Option<String>, _>("nickname")?
        .unwrap_or_else(|| "道友".to_string());
    let realm = character_row
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character_row.try_get::<Option<String>, _>("sub_realm")?;
    let realm_text =
        if realm.trim() == "凡人" || sub_realm.as_deref().unwrap_or_default().trim().is_empty() {
            realm.trim().to_string()
        } else {
            format!(
                "{}·{}",
                realm.trim(),
                sub_realm.as_deref().unwrap_or_default().trim()
            )
        };
    let story_seed = story
        .try_get::<Option<i32>, _>("story_seed")?
        .unwrap_or(1)
        .max(1);
    let max_episode_index = resolve_wander_story_max_episode_index(
        story_seed,
        opt_i64_from_i32_opt(&story, "episode_count")?,
    );
    let story_location = resolve_wander_story_location_context_from_seed(story_seed)?;
    let has_team = load_wander_has_team_context(state, character_id).await?;
    let previous_episodes = load_wander_previous_episode_context(
        state,
        &episode.story_id,
        &episode.id,
        story_location.full_name.as_str(),
    )
    .await?;
    let prompt_noise_seed = build_wander_prompt_noise_seed();
    let resolution_user_message = build_wander_ai_resolution_user_message(
        nickname.as_str(),
        realm_text.as_str(),
        has_team,
        story_partner.as_ref(),
        story_other_player.as_ref(),
        &story_location,
        &story_theme,
        &story_premise,
        &story_summary,
        episode.day_index,
        max_episode_index,
        &episode.episode_title,
        &episode.opening,
        chosen_option_text,
        episode.is_ending,
        &previous_episodes,
        prompt_noise_seed,
    );
    let resolution_repair_system_message =
        build_wander_ai_resolution_repair_system_message(episode.is_ending);
    let ai_resolution = generate_wander_ai_episode_resolution_draft(
        state,
        build_wander_ai_resolution_system_message(episode.is_ending).as_str(),
        resolution_user_message.as_str(),
        prompt_noise_seed,
        episode.is_ending,
        resolution_repair_system_message.as_str(),
        |previous_output, validation_reason| {
            build_wander_ai_resolution_repair_user_message(
                resolution_user_message.as_str(),
                previous_output,
                validation_reason,
                episode.is_ending,
            )
        },
    )
    .await?;
    let WanderAiEpisodeResolutionDraft {
        summary,
        is_ending: _,
        ending_type,
        reward_title_name,
        reward_title_desc,
        reward_title_color,
        reward_title_effects,
    } = ai_resolution;
    let outcome = normalize_wander_resolution_outcome(WanderResolutionOutcome {
        summary,
        ending_type,
        reward_title_name: if reward_title_name.trim().is_empty() {
            None
        } else {
            Some(reward_title_name)
        },
        reward_title_desc: if reward_title_desc.trim().is_empty() {
            None
        } else {
            Some(reward_title_desc)
        },
        reward_title_color: if reward_title_color.trim().is_empty() {
            None
        } else {
            Some(reward_title_color)
        },
        reward_title_effects,
    });

    state.database.execute(
        "UPDATE character_wander_story_episode SET chosen_option_index = $2, chosen_option_text = $3, episode_summary = $4, ending_type = $5, reward_title_name = $6, reward_title_desc = $7, reward_title_color = $8, reward_title_effects = $9::jsonb, chosen_at = NOW() WHERE id = $1",
        |query| query
            .bind(&episode.id)
            .bind(chosen_option_index)
            .bind(chosen_option_text)
            .bind(&outcome.summary)
            .bind(&outcome.ending_type)
            .bind(outcome.reward_title_name.as_deref())
            .bind(outcome.reward_title_desc.as_deref())
            .bind(outcome.reward_title_color.as_deref())
            .bind(serde_json::json!(outcome.reward_title_effects)),
    ).await?;

    let reward_title_id = if episode.is_ending {
        validate_wander_ending_reward_fields(&outcome)?;
        let reward_title_name = outcome
            .reward_title_name
            .as_deref()
            .expect("ending reward title name checked");
        let reward_title_desc = outcome
            .reward_title_desc
            .as_deref()
            .expect("ending reward title desc checked");
        let generated_title_id = build_generated_title_id();
        let row = state.database.fetch_one(
            "INSERT INTO generated_title_def (id, name, description, color, icon, effects, source_type, source_id, enabled, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, $5::jsonb, 'wander_story', $6, TRUE, NOW(), NOW()) ON CONFLICT (source_type, source_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, color = EXCLUDED.color, effects = EXCLUDED.effects, enabled = TRUE, updated_at = NOW() RETURNING id",
            |query| query
                .bind(&generated_title_id)
                .bind(reward_title_name)
                .bind(reward_title_desc)
                .bind(outcome.reward_title_color.as_deref())
                .bind(serde_json::json!(outcome.reward_title_effects))
                .bind(&episode.story_id),
        ).await?;
        let title_id = row.try_get::<String, _>("id")?;
        state.database.execute(
            "INSERT INTO character_title (character_id, title_id, is_equipped, obtained_at, updated_at) VALUES ($1, $2, FALSE, NOW(), NOW()) ON CONFLICT (character_id, title_id) DO UPDATE SET obtained_at = NOW(), updated_at = NOW()",
            |query| query.bind(character_id).bind(&title_id),
        ).await?;
        Some(title_id)
    } else {
        None
    };

    state.database.execute(
        "UPDATE character_wander_story SET status = $2, story_summary = $3, reward_title_id = $4, finished_at = CASE WHEN $2 = 'finished' THEN NOW() ELSE finished_at END, updated_at = NOW() WHERE id = $1",
        |query| query
            .bind(&episode.story_id)
            .bind(if episode.is_ending { "finished" } else { "active" })
            .bind(&outcome.summary)
            .bind(reward_title_id.as_deref()),
    ).await?;
    if episode.is_ending {
        return Ok(None);
    }
    let next_day_key = advance_date_key(&episode.day_key);
    if let Some(existing_episode) =
        load_episode_row_by_day_key(state, character_id, &next_day_key).await?
    {
        return Ok(Some(existing_episode.id));
    }
    create_wander_episode_for_day_key(state, character_id, &next_day_key).await
}

fn build_wander_ai_resolution_system_message(is_ending: bool) -> String {
    let ending_rule = if is_ending {
        format!(
            "当前是终幕结算：endingType 只能是 good / neutral / tragic / bizarre；rewardTitleName 必须是 2 到 8 字中文正式称号名；rewardTitleDesc 必须是 8 到 40 字中文称号描述；rewardTitleColor 必须是合法 #RRGGBB；rewardTitleEffects 必须给出 {} 到 {} 条合法属性。",
            WANDER_TITLE_MIN_EFFECT_COUNT, WANDER_TITLE_MAX_EFFECT_COUNT,
        )
    } else {
        format!("当前不是终幕结算：{}", WANDER_NON_ENDING_TITLE_FIELD_RULE)
    };
    [
        "你是《九州修仙录》的云游奇遇导演。",
        "你必须输出严格 JSON，不得输出 markdown、解释、额外注释。",
        "剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。",
        "本阶段只负责根据玩家已经选定的选项，生成这一幕真正发生的结果与收束。",
        WANDER_REALM_ORDER_PROMPT,
        WANDER_REALM_RULE,
        "player.storyPartner 为 null 表示这条故事不带入伙伴；不为 null 时，说明该伙伴已卷入这条故事。你应让这一幕的结果继续自然体现其存在，但不要压过玩家主导地位。",
        "player.storyOtherPlayer 为 null 表示这条故事不带入其他玩家；不为 null 时，说明这名近期活跃的修士已卷入当前因果。你应让这一幕继续自然体现其反应、取舍或动作，但不能让其盖过玩家，也不要替其凭空改写既有立场。",
        "previousEpisodes 会按幕次顺序提供已经发生的完整前文，每一幕都包含标题、正文、玩家已选选项和选择后的结果；你必须把当前这一幕放在这些既有经历之后承接，不能忽略已发生的因果。",
        WANDER_SUMMARY_STYLE_RULE,
        &format!("summary 示例：{}", WANDER_SUMMARY_EXAMPLE),
        "rewardTitleColor 必须是 7 位十六进制颜色字符串，格式严格为 #RRGGBB，例如 #faad14。",
        &format!("rewardTitleColor 示例：{}", WANDER_TITLE_COLOR_EXAMPLE),
        &format!("rewardTitleEffects 可用属性：{}", WANDER_TITLE_EFFECT_GUIDE),
        &format!("rewardTitleEffects 上限：{}", WANDER_TITLE_EFFECT_LIMIT_GUIDE),
        &format!("rewardTitleEffects 示例：{}", WANDER_TITLE_EFFECT_EXAMPLE_JSON),
        WANDER_NON_ENDING_TITLE_FIELD_RULE,
        &format!("非终幕字段示例：{}", build_wander_non_ending_title_field_example()),
        &ending_rule,
    ]
    .join("\n")
}

fn build_wander_ai_resolution_repair_system_message(is_ending: bool) -> String {
    [
        build_wander_ai_resolution_system_message(is_ending),
        "如果用户消息指出上一轮 JSON 的具体错误，你必须严格按该错误修正，并完整重写整个 JSON 对象。".to_string(),
    ]
    .join("\n")
}

fn build_wander_ai_resolution_user_message(
    nickname: &str,
    realm_text: &str,
    has_team: bool,
    story_partner: Option<&WanderAiStoryPartnerDto>,
    story_other_player: Option<&WanderAiStoryOtherPlayerDto>,
    story_location: &WanderAiStoryLocationDto,
    story_theme: &str,
    story_premise: &str,
    story_summary: &str,
    current_episode_index: i64,
    max_episode_index: i64,
    episode_title: &str,
    opening: &str,
    chosen_option_text: &str,
    is_ending: bool,
    previous_episodes: &[WanderAiPreviousEpisodeContextDto],
    prompt_noise_seed: i64,
) -> String {
    let resolution_mode = if is_ending {
        "must_end"
    } else {
        "must_continue"
    };
    serde_json::json!({
        "promptNoiseHash": build_wander_prompt_noise_hash("wander-story-resolution", prompt_noise_seed),
        "player": {
            "nickname": nickname,
            "realm": realm_text,
            "hasTeam": has_team,
            "storyPartner": story_partner,
            "storyOtherPlayer": story_other_player,
        },
        "storyLocation": story_location,
        "story": {
            "activeTheme": if story_theme.trim().is_empty() { serde_json::Value::Null } else { serde_json::json!(story_theme) },
            "activePremise": if story_premise.trim().is_empty() { serde_json::Value::Null } else { serde_json::json!(story_premise) },
            "storySummary": if story_summary.trim().is_empty() { serde_json::Value::Null } else { serde_json::json!(story_summary) },
            "currentEpisodeIndex": current_episode_index,
            "maxEpisodeIndex": max_episode_index,
            "currentEpisodeTitle": episode_title,
            "currentEpisodeOpening": opening,
            "chosenOptionText": chosen_option_text,
            "isEndingEpisode": is_ending,
            "previousEpisodes": previous_episodes,
            "resolutionMode": resolution_mode,
        },
        "outputRules": {
            "summaryLengthRange": "20-160",
            "summaryStyleRule": WANDER_SUMMARY_STYLE_RULE,
            "summaryExample": WANDER_SUMMARY_EXAMPLE,
            "rewardTitleNameLengthRange": "2-8",
            "rewardTitleDescLengthRange": "8-40",
            "rewardTitleColorPattern": WANDER_TITLE_COLOR_PATTERN,
            "rewardTitleEffectCountRange": format!("{}-{}", WANDER_TITLE_MIN_EFFECT_COUNT, WANDER_TITLE_MAX_EFFECT_COUNT),
            "rewardTitleEffectKeys": WANDER_TITLE_EFFECT_KEYS,
            "rewardTitleEffectGuide": WANDER_TITLE_EFFECT_GUIDE,
            "rewardTitleEffectLimitGuide": WANDER_TITLE_EFFECT_LIMIT_GUIDE,
            "rewardTitleEffectValueMaxMap": build_wander_title_effect_value_max_map(),
            "nonEndingTitleFieldExample": build_wander_non_ending_title_field_example(),
            "endingTypeValues": ["none", "good", "neutral", "tragic", "bizarre"],
            "endingRule": if is_ending {
                format!(
                    "当前是终幕结算：endingType 只能是 good / neutral / tragic / bizarre；rewardTitleName 必须是 2 到 8 字中文正式称号名；rewardTitleDesc 必须是 8 到 40 字中文称号描述；rewardTitleColor 必须是合法 #RRGGBB；rewardTitleEffects 必须给出 {} 到 {} 条合法属性。",
                    WANDER_TITLE_MIN_EFFECT_COUNT,
                    WANDER_TITLE_MAX_EFFECT_COUNT,
                )
            } else {
                "当前不是终幕结算：endingType 必须是 none，rewardTitleName、rewardTitleDesc、rewardTitleColor 必须为空字符串，rewardTitleEffects 必须为空数组，不允许返回占位称号或任意属性。".to_string()
            },
            "endingMode": resolution_mode,
        }
    })
    .to_string()
}

fn parse_wander_story_other_player_context(
    value: serde_json::Value,
) -> Option<WanderAiStoryOtherPlayerDto> {
    let character_id = value.get("characterId")?.as_i64()?;
    let nickname = value.get("nickname")?.as_str()?.trim();
    let realm = value.get("realm")?.as_str()?.trim();
    if character_id <= 0 || nickname.is_empty() || realm.is_empty() {
        return None;
    }
    Some(WanderAiStoryOtherPlayerDto {
        character_id,
        nickname: nickname.to_string(),
        title: value
            .get("title")
            .and_then(|title| title.as_str())
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(|title| title.to_string()),
        realm: realm.to_string(),
        sub_realm: value
            .get("subRealm")
            .and_then(|sub_realm| sub_realm.as_str())
            .map(str::trim)
            .filter(|sub_realm| !sub_realm.is_empty())
            .map(|sub_realm| sub_realm.to_string()),
    })
}

fn parse_wander_story_partner_context(value: serde_json::Value) -> Option<WanderAiStoryPartnerDto> {
    let partner_id = value.get("partnerId")?.as_i64()?;
    let partner_def_id = value.get("partnerDefId")?.as_str()?.trim();
    let nickname = value.get("nickname")?.as_str()?.trim();
    let name = value.get("name")?.as_str()?.trim();
    let role = value.get("role")?.as_str()?.trim();
    let quality = value.get("quality")?.as_str()?.trim();
    if partner_id <= 0
        || partner_def_id.is_empty()
        || nickname.is_empty()
        || name.is_empty()
        || role.is_empty()
        || quality.is_empty()
    {
        return None;
    }
    Some(WanderAiStoryPartnerDto {
        partner_id,
        partner_def_id: partner_def_id.to_string(),
        nickname: nickname.to_string(),
        name: name.to_string(),
        description: value
            .get("description")
            .and_then(|description| description.as_str())
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(|description| description.to_string()),
        role: role.to_string(),
        quality: quality.to_string(),
    })
}

fn resolve_wander_story_location_context_from_seed(
    story_seed: i32,
) -> Result<WanderAiStoryLocationDto, AppError> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/map_def.json");
    let content = fs::read_to_string(&path)
        .map_err(|error| AppError::config(format!("failed to read map_def.json: {error}")))?;
    let payload: WanderMapSeedFile = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse map_def.json: {error}")))?;
    let mut maps = payload
        .maps
        .into_iter()
        .filter(|map| map.enabled != Some(false))
        .filter_map(|map| {
            let map_name = map.name.clone().unwrap_or_else(|| map.id.clone());
            let region = map.region.clone().unwrap_or_else(|| "未知地界".to_string());
            let rooms = map
                .rooms
                .unwrap_or_default()
                .into_iter()
                .filter_map(|room| {
                    let area_name = room.name.clone().unwrap_or_else(|| room.id.clone());
                    (!room.id.trim().is_empty() && !area_name.trim().is_empty())
                        .then_some((room.id, area_name))
                })
                .collect::<Vec<_>>();
            (!map.id.trim().is_empty() && !rooms.is_empty())
                .then_some((map.id, map_name, region, rooms))
        })
        .collect::<Vec<_>>();
    maps.sort_by(|left, right| left.0.cmp(&right.0));
    let Some((map_id, map_name, region, rooms)) = maps
        .get(deterministic_story_other_player_index(
            story_seed,
            maps.len(),
        ))
        .cloned()
    else {
        return Ok(WanderAiStoryLocationDto {
            region: "未知地界".to_string(),
            map_id: "unknown-map".to_string(),
            map_name: "未知地图".to_string(),
            area_id: "unknown-room".to_string(),
            area_name: "未知区域".to_string(),
            full_name: "未知地界·未知地图·未知区域".to_string(),
        });
    };
    let (area_id, area_name) = rooms
        .get(deterministic_story_seed_room_index(story_seed, rooms.len()))
        .cloned()
        .unwrap_or_else(|| ("unknown-room".to_string(), "未知区域".to_string()));
    Ok(WanderAiStoryLocationDto {
        region: region.clone(),
        map_id: map_id.clone(),
        map_name: map_name.clone(),
        area_id: area_id.clone(),
        area_name: area_name.clone(),
        full_name: format!("{}·{}·{}", region, map_name, area_name),
    })
}

fn deterministic_story_seed_room_index(story_seed: i32, candidate_count: usize) -> usize {
    if candidate_count <= 1 {
        return 0;
    }
    let digest = md5::compute(format!("wander-story-location-room:{story_seed}").as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize;
    value % candidate_count
}

async fn load_wander_story_partner_context(
    state: &AppState,
    character_id: i64,
) -> Result<Option<WanderAiStoryPartnerDto>, AppError> {
    let row = state.database.fetch_optional(
        "SELECT cp.id, cp.partner_def_id, cp.nickname, COALESCE(gpd.name, cp.nickname, '伙伴') AS name, gpd.description, COALESCE(gpd.role, '伙伴') AS role, COALESCE(gpd.quality, '黄') AS quality FROM character_partner cp LEFT JOIN generated_partner_def gpd ON gpd.id = cp.partner_def_id WHERE cp.character_id = $1 AND cp.is_active = TRUE ORDER BY cp.updated_at DESC, cp.id DESC LIMIT 1",
        |query| query.bind(character_id),
    ).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(WanderAiStoryPartnerDto {
        partner_id: row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        partner_def_id: row
            .try_get::<Option<String>, _>("partner_def_id")?
            .unwrap_or_default(),
        nickname: row
            .try_get::<Option<String>, _>("nickname")?
            .unwrap_or_else(|| "伙伴".to_string()),
        name: row
            .try_get::<Option<String>, _>("name")?
            .unwrap_or_else(|| "伙伴".to_string()),
        description: row.try_get::<Option<String>, _>("description")?,
        role: row
            .try_get::<Option<String>, _>("role")?
            .unwrap_or_else(|| "伙伴".to_string()),
        quality: row
            .try_get::<Option<String>, _>("quality")?
            .unwrap_or_else(|| "黄".to_string()),
    }))
}

async fn load_wander_story_partner_snapshot_for_new_story(
    state: &AppState,
    character_id: i64,
) -> Result<Option<serde_json::Value>, AppError> {
    Ok(load_wander_story_partner_context(state, character_id)
        .await?
        .map(|partner| {
            serde_json::json!({
                "partnerId": partner.partner_id,
                "partnerDefId": partner.partner_def_id,
                "nickname": partner.nickname,
                "name": partner.name,
                "description": partner.description,
                "role": partner.role,
                "quality": partner.quality,
            })
        }))
}

async fn load_wander_has_team_context(
    state: &AppState,
    character_id: i64,
) -> Result<bool, AppError> {
    Ok(state
        .database
        .fetch_optional(
            "SELECT 1 FROM team_members WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?
        .is_some())
}

async fn load_wander_previous_episode_context(
    state: &AppState,
    story_id: &str,
    current_episode_id: &str,
    location_name: &str,
) -> Result<Vec<WanderAiPreviousEpisodeContextDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT day_index, episode_title, opening, chosen_option_text, episode_summary, is_ending FROM character_wander_story_episode WHERE story_id = $1 AND id <> $2 AND chosen_at IS NOT NULL ORDER BY day_index ASC",
        |query| query.bind(story_id).bind(current_episode_id),
    ).await?;
    Ok(rows
        .into_iter()
        .map(|row| WanderAiPreviousEpisodeContextDto {
            day_index: opt_i64_from_i32(&row, "day_index"),
            location_name: location_name.to_string(),
            title: row
                .try_get::<Option<String>, _>("episode_title")
                .unwrap_or(None)
                .unwrap_or_default(),
            opening: row
                .try_get::<Option<String>, _>("opening")
                .unwrap_or(None)
                .unwrap_or_default(),
            chosen_option_text: row
                .try_get::<Option<String>, _>("chosen_option_text")
                .unwrap_or(None)
                .unwrap_or_default(),
            summary: row
                .try_get::<Option<String>, _>("episode_summary")
                .unwrap_or(None)
                .unwrap_or_default(),
            is_ending: row
                .try_get::<Option<bool>, _>("is_ending")
                .unwrap_or(None)
                .unwrap_or(false),
        })
        .collect())
}

async fn load_wander_previous_episode_context_for_story(
    state: &AppState,
    story_id: &str,
    location_name: &str,
) -> Result<Vec<WanderAiPreviousEpisodeContextDto>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT day_index, episode_title, opening, chosen_option_text, episode_summary, is_ending FROM character_wander_story_episode WHERE story_id = $1 AND chosen_at IS NOT NULL ORDER BY day_index ASC",
        |query| query.bind(story_id),
    ).await?;
    Ok(rows
        .into_iter()
        .map(|row| WanderAiPreviousEpisodeContextDto {
            day_index: opt_i64_from_i32(&row, "day_index"),
            location_name: location_name.to_string(),
            title: row
                .try_get::<Option<String>, _>("episode_title")
                .unwrap_or(None)
                .unwrap_or_default(),
            opening: row
                .try_get::<Option<String>, _>("opening")
                .unwrap_or(None)
                .unwrap_or_default(),
            chosen_option_text: row
                .try_get::<Option<String>, _>("chosen_option_text")
                .unwrap_or(None)
                .unwrap_or_default(),
            summary: row
                .try_get::<Option<String>, _>("episode_summary")
                .unwrap_or(None)
                .unwrap_or_default(),
            is_ending: row
                .try_get::<Option<bool>, _>("is_ending")
                .unwrap_or(None)
                .unwrap_or(false),
        })
        .collect())
}

fn build_wander_unique_id(prefix: &str) -> String {
    let timestamp = current_timestamp_ms().max(0) as u64;
    let counter = WANDER_ID_COUNTER.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff;
    format!("{prefix}-{:x}-{:08x}", timestamp, counter)
}

fn build_generated_title_id() -> String {
    build_wander_unique_id("title-wander")
}

async fn create_wander_episode_for_day_key(
    state: &AppState,
    character_id: i64,
    day_key: &str,
) -> Result<Option<String>, AppError> {
    let character = state
        .database
        .fetch_optional(
            "SELECT id, nickname, realm, sub_realm FROM characters WHERE id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    let Some(character) = character else {
        return Ok(None);
    };
    let nickname = character
        .try_get::<Option<String>, _>("nickname")?
        .unwrap_or_else(|| "道友".to_string());
    let realm = character
        .try_get::<Option<String>, _>("realm")?
        .unwrap_or_else(|| "凡人".to_string());
    let sub_realm = character.try_get::<Option<String>, _>("sub_realm")?;
    let realm_text =
        if realm.trim() == "凡人" || sub_realm.as_deref().unwrap_or_default().trim().is_empty() {
            realm.trim().to_string()
        } else {
            format!(
                "{}·{}",
                realm.trim(),
                sub_realm.as_deref().unwrap_or_default().trim()
            )
        };

    let active_story = state.database.fetch_optional(
        "SELECT id, story_theme, story_premise, story_summary, episode_count, story_seed, story_partner_snapshot, story_other_player_snapshot FROM character_wander_story WHERE character_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        |query| query.bind(character_id),
    ).await?;

    let new_story_seed = active_story
        .as_ref()
        .is_none()
        .then(|| resolve_new_wander_story_seed(current_timestamp_ms()));
    let current_story_location = if let Some(active_story) = active_story.as_ref() {
        resolve_wander_story_location_context_from_seed(
            active_story
                .try_get::<Option<i32>, _>("story_seed")?
                .unwrap_or(1)
                .max(1),
        )?
    } else {
        resolve_wander_story_location_context_from_seed(new_story_seed.unwrap_or(1))?
    };
    let (
        story_id,
        _story_seed,
        next_episode_index,
        max_episode_index,
        theme,
        premise,
        story_summary,
        story_partner,
        story_other_player,
    ) = if let Some(active_story) = active_story {
        let story_id = active_story
            .try_get::<Option<String>, _>("id")?
            .unwrap_or_default();
        let current_episode_count = opt_i64_from_i32(&active_story, "episode_count").max(0);
        let story_seed = active_story
            .try_get::<Option<i32>, _>("story_seed")?
            .unwrap_or(1)
            .max(1);
        let theme = active_story
            .try_get::<Option<String>, _>("story_theme")?
            .unwrap_or_else(|| "云游奇遇".to_string());
        let premise = active_story
            .try_get::<Option<String>, _>("story_premise")?
            .unwrap_or_else(|| format!("{}行至{}，感应到一缕异样机缘。", nickname, realm_text));
        let story_summary = active_story
            .try_get::<Option<String>, _>("story_summary")?
            .unwrap_or_default();
        let story_partner = active_story
            .try_get::<Option<serde_json::Value>, _>("story_partner_snapshot")?
            .and_then(parse_wander_story_partner_context);
        let story_other_player = active_story
            .try_get::<Option<serde_json::Value>, _>("story_other_player_snapshot")?
            .and_then(parse_wander_story_other_player_context);
        state.database.execute(
            "UPDATE character_wander_story SET episode_count = $2, updated_at = NOW() WHERE id = $1",
            |query| query.bind(&story_id).bind(current_episode_count + 1),
        ).await?;
        (
            story_id,
            story_seed,
            current_episode_count + 1,
            resolve_wander_target_episode_count(story_seed),
            theme,
            premise,
            story_summary,
            story_partner,
            story_other_player,
        )
    } else {
        let story_id = build_story_id();
        let theme = "云游奇遇".to_string();
        let premise = format!(
            "{}以{}之身踏上云游，偶遇一缕未明机缘。",
            nickname, realm_text
        );
        let story_seed = new_story_seed.unwrap_or(1);
        let story_partner_snapshot = if should_include_wander_story_partner(story_seed) {
            load_wander_story_partner_snapshot_for_new_story(state, character_id).await?
        } else {
            None
        };
        let story_other_player_snapshot = if should_include_wander_story_other_player(story_seed) {
            load_wander_story_other_player_snapshot_for_new_story(state, character_id, story_seed)
                .await?
        } else {
            None
        };
        let story_partner = story_partner_snapshot
            .clone()
            .and_then(parse_wander_story_partner_context);
        let story_other_player = story_other_player_snapshot
            .clone()
            .and_then(parse_wander_story_other_player_context);
        state.database.execute(
            "INSERT INTO character_wander_story (id, character_id, status, story_theme, story_premise, story_summary, episode_count, story_seed, story_partner_snapshot, story_other_player_snapshot, reward_title_id, finished_at, created_at, updated_at) VALUES ($1, $2, 'active', $3, $4, '', 1, $5, $6::jsonb, $7::jsonb, NULL, NULL, NOW(), NOW())",
            |query| query.bind(&story_id).bind(character_id).bind(&theme).bind(&premise).bind(story_seed).bind(story_partner_snapshot).bind(story_other_player_snapshot),
        ).await?;
        (
            story_id,
            story_seed,
            1,
            resolve_wander_target_episode_count(story_seed),
            theme,
            premise,
            String::new(),
            story_partner,
            story_other_player,
        )
    };

    let has_team = load_wander_has_team_context(state, character_id).await?;
    let previous_episodes = load_wander_previous_episode_context_for_story(
        state,
        &story_id,
        current_story_location.full_name.as_str(),
    )
    .await?;

    let episode_id = build_episode_id();
    let is_ending = next_episode_index >= max_episode_index;
    let prompt_noise_seed = build_wander_prompt_noise_seed();
    let setup_user_message = build_wander_ai_setup_user_message(
        nickname.as_str(),
        realm_text.as_str(),
        has_team,
        story_partner.as_ref(),
        story_other_player.as_ref(),
        &current_story_location,
        if theme.trim().is_empty() {
            None
        } else {
            Some(theme.as_str())
        },
        if premise.trim().is_empty() {
            None
        } else {
            Some(premise.as_str())
        },
        if story_summary.trim().is_empty() {
            None
        } else {
            Some(story_summary.as_str())
        },
        next_episode_index,
        max_episode_index,
        is_ending,
        &previous_episodes,
        prompt_noise_seed,
    );
    let setup_repair_system_message = build_wander_ai_setup_repair_system_message(is_ending);
    let ai_setup = generate_wander_ai_episode_setup_draft(
        state,
        build_wander_ai_setup_system_message(is_ending).as_str(),
        setup_user_message.as_str(),
        prompt_noise_seed,
        setup_repair_system_message.as_str(),
        |previous_output, validation_reason| {
            build_wander_ai_setup_repair_user_message(
                setup_user_message.as_str(),
                previous_output,
                validation_reason,
                is_ending,
            )
        },
    )
    .await?;
    let WanderAiEpisodeSetupDraft {
        story_theme,
        story_premise,
        episode_title,
        opening,
        option_texts,
    } = ai_setup;
    let options = serde_json::json!(option_texts);
    let persisted_theme = if theme.trim().is_empty() || theme == "云游奇遇" {
        story_theme
    } else {
        theme
    };
    let persisted_premise = if premise.trim().is_empty() {
        story_premise
    } else {
        premise
    };

    state.database.execute(
        "UPDATE character_wander_story SET story_theme = $2, story_premise = $3, updated_at = NOW() WHERE id = $1",
        |query| query.bind(&story_id).bind(&persisted_theme).bind(&persisted_premise),
    ).await?;

    state.database.execute(
        "INSERT INTO character_wander_story_episode (id, story_id, character_id, day_key, day_index, episode_title, opening, option_texts, chosen_option_index, chosen_option_text, episode_summary, is_ending, ending_type, reward_title_name, reward_title_desc, reward_title_color, reward_title_effects, created_at, chosen_at) VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::jsonb, NULL, NULL, '', $9, 'none', NULL, NULL, NULL, NULL, NOW(), NULL)",
        |query| query
            .bind(&episode_id)
            .bind(&story_id)
            .bind(character_id)
            .bind(day_key)
            .bind(next_episode_index)
            .bind(&episode_title)
            .bind(&opening)
            .bind(&options)
            .bind(is_ending),
    ).await?;

    let _ = theme;
    Ok(Some(episode_id))
}

fn build_wander_ai_setup_system_message(is_ending: bool) -> String {
    let ending_scene_rule = if is_ending {
        "本幕是终幕抉择幕，opening 也只能把局势推到最后抉择前一刻，不能提前写玩家选择后的尾声、结局类型、称号名、称号描述、颜色或属性。".to_string()
    } else {
        "本幕不是终幕，只能继续制造悬念与分叉，不能提前把整条故事写完。".to_string()
    };
    [
        "你是《九州修仙录》的云游奇遇导演。",
        "你必须输出严格 JSON，不得输出 markdown、解释、额外注释。",
        "剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。",
        "本阶段只负责生成待玩家选择的幕次，不负责结算结果。",
        WANDER_REALM_ORDER_PROMPT,
        WANDER_REALM_RULE,
        "player.storyPartner 为 null 表示这条故事不带入伙伴；不为 null 时，说明该伙伴会卷入这条故事。你应自然写出其同行、反应、插话或协助，但不要喧宾夺主，也不要替玩家做选择。",
        "player.storyOtherPlayer 为 null 表示这条故事不带入其他玩家；不为 null 时，说明有一名近期活跃的其他修士会卷入这条故事。你应自然写出其同行、路遇、竞争或援手，但不能让其压过玩家主导地位，也不要替该玩家擅自决定立场。",
        "previousEpisodes 会按幕次顺序提供已经发生的完整前文，每一幕都包含标题、正文、玩家已选选项和选择后的结果；续写时必须严格承接这些既成事实，不得遗忘、改写或跳过已经发生的因果。",
        WANDER_STORY_THEME_STYLE_RULE,
        &format!("storyTheme 示例：{}", WANDER_STORY_THEME_EXAMPLE),
        WANDER_STORY_PREMISE_STYLE_RULE,
        &format!("storyPremise 示例：{}", WANDER_STORY_PREMISE_EXAMPLE),
        WANDER_OPTION_STYLE_RULE,
        &format!("optionTexts 示例：{}", WANDER_OPTION_EXAMPLE_JSON),
        WANDER_EPISODE_TITLE_STYLE_RULE,
        WANDER_OPENING_STYLE_RULE,
        &format!("opening 示例：{}", WANDER_OPENING_EXAMPLE),
        &ending_scene_rule,
        "三条选项都必须可执行、方向明确、互相有差异，不能只换措辞。",
    ]
    .join("\n")
}

fn build_wander_ai_setup_repair_system_message(is_ending: bool) -> String {
    [
        build_wander_ai_setup_system_message(is_ending),
        "如果用户消息指出上一轮 JSON 的具体错误，你必须严格按该错误修正，并完整重写整个 JSON 对象。".to_string(),
    ]
    .join("\n")
}

fn build_wander_ai_setup_repair_user_message(
    original_task: &str,
    previous_output: &str,
    validation_reason: &str,
    is_ending: bool,
) -> String {
    serde_json::json!({
        "task": "你上一轮输出的 JSON 未通过校验，请基于同一幕剧情进行修正，并完整重写整个 JSON 对象。",
        "validationReason": validation_reason,
        "outputRules": {
            "storyThemeLengthRange": "2-24",
            "storyThemeStyleRule": WANDER_STORY_THEME_STYLE_RULE,
            "storyThemeExample": WANDER_STORY_THEME_EXAMPLE,
            "storyPremiseLengthRange": "8-120",
            "storyPremiseStyleRule": WANDER_STORY_PREMISE_STYLE_RULE,
            "storyPremiseExample": WANDER_STORY_PREMISE_EXAMPLE,
            "optionCount": 3,
            "optionStyleRule": WANDER_OPTION_STYLE_RULE,
            "optionExample": serde_json::from_str::<serde_json::Value>(WANDER_OPTION_EXAMPLE_JSON).unwrap_or_else(|_| serde_json::json!([])),
            "episodeTitleLengthRange": "2-24",
            "episodeTitleStyleRule": WANDER_EPISODE_TITLE_STYLE_RULE,
            "openingLengthRange": "80-420",
            "openingStyleRule": WANDER_OPENING_STYLE_RULE,
            "openingExample": WANDER_OPENING_EXAMPLE,
            "endingSceneRule": if is_ending {
                format!("本幕是终幕抉择幕。{}", WANDER_ENDING_SCENE_RULE)
            } else {
                "本幕不是终幕，只能继续制造悬念与分叉，不能提前把整条故事写完。".to_string()
            }
        },
        "originalTask": serde_json::from_str::<serde_json::Value>(original_task).unwrap_or_else(|_| serde_json::json!({})),
        "previousOutput": previous_output,
    }).to_string()
}

fn build_wander_ai_resolution_repair_user_message(
    original_task: &str,
    previous_output: &str,
    validation_reason: &str,
    is_ending: bool,
) -> String {
    let resolution_mode = if is_ending {
        "must_end"
    } else {
        "must_continue"
    };
    serde_json::json!({
        "task": "你上一轮输出的 JSON 未通过校验，请基于同一幕剧情进行修正，并完整重写整个 JSON 对象。",
        "validationReason": validation_reason,
        "outputRules": {
            "summaryLengthRange": "20-160",
            "summaryStyleRule": WANDER_SUMMARY_STYLE_RULE,
            "summaryExample": WANDER_SUMMARY_EXAMPLE,
            "rewardTitleNameLengthRange": "2-8",
            "rewardTitleDescLengthRange": "8-40",
            "rewardTitleColorPattern": WANDER_TITLE_COLOR_PATTERN,
            "rewardTitleEffectCountRange": format!("{}-{}", WANDER_TITLE_MIN_EFFECT_COUNT, WANDER_TITLE_MAX_EFFECT_COUNT),
            "rewardTitleEffectKeys": WANDER_TITLE_EFFECT_KEYS,
            "rewardTitleEffectGuide": WANDER_TITLE_EFFECT_GUIDE,
            "rewardTitleEffectLimitGuide": WANDER_TITLE_EFFECT_LIMIT_GUIDE,
            "rewardTitleEffectValueMaxMap": build_wander_title_effect_value_max_map(),
            "nonEndingTitleFieldExample": build_wander_non_ending_title_field_example(),
            "endingTypeValues": ["none", "good", "neutral", "tragic", "bizarre"],
            "endingRule": if is_ending {
                format!(
                    "当前是终幕结算：endingType 只能是 good / neutral / tragic / bizarre；rewardTitleName 必须是 2 到 8 字中文正式称号名；rewardTitleDesc 必须是 8 到 40 字中文称号描述；rewardTitleColor 必须是合法 #RRGGBB；rewardTitleEffects 必须给出 {} 到 {} 条合法属性。",
                    WANDER_TITLE_MIN_EFFECT_COUNT,
                    WANDER_TITLE_MAX_EFFECT_COUNT,
                )
            } else {
                WANDER_NON_ENDING_TITLE_FIELD_RULE.to_string()
            },
            "endingMode": resolution_mode,
        },
        "originalTask": serde_json::from_str::<serde_json::Value>(original_task).unwrap_or_else(|_| serde_json::json!({})),
        "previousOutput": previous_output,
    }).to_string()
}

fn build_wander_ai_setup_user_message(
    nickname: &str,
    realm_text: &str,
    has_team: bool,
    story_partner: Option<&WanderAiStoryPartnerDto>,
    story_other_player: Option<&WanderAiStoryOtherPlayerDto>,
    story_location: &WanderAiStoryLocationDto,
    active_theme: Option<&str>,
    active_premise: Option<&str>,
    story_summary: Option<&str>,
    next_episode_index: i64,
    max_episode_index: i64,
    is_ending: bool,
    previous_episodes: &[WanderAiPreviousEpisodeContextDto],
    prompt_noise_seed: i64,
) -> String {
    let resolved_story_summary =
        resolve_wander_setup_story_summary(story_summary, previous_episodes);
    serde_json::json!({
        "promptNoiseHash": build_wander_prompt_noise_hash("wander-story-setup", prompt_noise_seed),
        "player": {
            "nickname": nickname,
            "realm": realm_text,
            "hasTeam": has_team,
            "storyPartner": story_partner,
            "storyOtherPlayer": story_other_player,
        },
        "storyLocation": story_location,
        "story": {
            "activeTheme": active_theme,
            "activePremise": active_premise,
            "storySummary": resolved_story_summary,
            "nextEpisodeIndex": next_episode_index,
            "maxEpisodeIndex": max_episode_index,
            "isEndingEpisode": is_ending,
            "previousEpisodes": previous_episodes,
        },
        "outputRules": {
            "storyThemeLengthRange": "2-24",
            "storyThemeStyleRule": WANDER_STORY_THEME_STYLE_RULE,
            "storyThemeExample": WANDER_STORY_THEME_EXAMPLE,
            "storyPremiseLengthRange": "8-120",
            "storyPremiseStyleRule": WANDER_STORY_PREMISE_STYLE_RULE,
            "storyPremiseExample": WANDER_STORY_PREMISE_EXAMPLE,
            "optionCount": 3,
            "optionStyleRule": WANDER_OPTION_STYLE_RULE,
            "optionExample": serde_json::from_str::<serde_json::Value>(WANDER_OPTION_EXAMPLE_JSON).unwrap_or_else(|_| serde_json::json!([])),
            "episodeTitleLengthRange": "2-24",
            "episodeTitleStyleRule": WANDER_EPISODE_TITLE_STYLE_RULE,
            "openingLengthRange": "80-420",
            "openingStyleRule": WANDER_OPENING_STYLE_RULE,
            "openingExample": WANDER_OPENING_EXAMPLE,
            "endingSceneRule": if is_ending {
                format!("本幕是终幕抉择幕。{}", WANDER_ENDING_SCENE_RULE)
            } else {
                "本幕不是终幕，只能继续制造悬念与分叉，不能提前把整条故事写完。".to_string()
            }
        }
    })
    .to_string()
}

fn resolve_wander_target_episode_count(story_seed: i32) -> i64 {
    let digest = md5::compute(format!("wander-target-episode:{story_seed}").as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 2;
    3 + value as i64
}

fn build_story_id() -> String {
    build_wander_unique_id("wander-story")
}

async fn load_wander_story_other_player_snapshot_for_new_story(
    state: &AppState,
    character_id: i64,
    story_seed: i32,
) -> Result<Option<serde_json::Value>, AppError> {
    let rows = state.database.fetch_all(
        "SELECT c.id, COALESCE(NULLIF(c.nickname, ''), CONCAT('修士', c.id::text)) AS nickname, NULLIF(TRIM(c.title), '') AS title, COALESCE(NULLIF(TRIM(c.realm), ''), '凡人') AS realm, NULLIF(TRIM(c.sub_realm), '') AS sub_realm FROM characters c JOIN users u ON u.id = c.user_id WHERE c.id <> $1 AND u.last_login IS NOT NULL ORDER BY u.last_login DESC, c.id ASC LIMIT 16",
        |query| query.bind(character_id),
    ).await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let index = deterministic_story_other_player_index(story_seed, rows.len());
    let row = &rows[index];
    Ok(Some(serde_json::json!({
        "characterId": row.try_get::<Option<i64>, _>("id")?.unwrap_or_default(),
        "nickname": row.try_get::<Option<String>, _>("nickname")?.unwrap_or_default(),
        "title": row.try_get::<Option<String>, _>("title")?,
        "realm": row.try_get::<Option<String>, _>("realm")?.unwrap_or_else(|| "凡人".to_string()),
        "subRealm": row.try_get::<Option<String>, _>("sub_realm")?,
    })))
}

fn deterministic_story_other_player_index(story_seed: i32, candidate_count: usize) -> usize {
    if candidate_count <= 1 {
        return 0;
    }
    let digest = md5::compute(format!("wander-story-other-player:{story_seed}").as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) as usize;
    value % candidate_count
}

fn should_include_wander_story_partner(story_seed: i32) -> bool {
    deterministic_story_seed_unit_float("wander-story-partner", story_seed)
        < WANDER_STORY_PARTNER_INCLUDE_RATE
}

fn should_include_wander_story_other_player(story_seed: i32) -> bool {
    deterministic_story_seed_unit_float("wander-story-other-player", story_seed)
        < WANDER_STORY_OTHER_PLAYER_INCLUDE_RATE
}

fn deterministic_story_seed_unit_float(namespace: &str, story_seed: i32) -> f64 {
    let digest = md5::compute(format!("{namespace}:{story_seed}").as_bytes());
    let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    (value as f64) / (u32::MAX as f64)
}

fn build_episode_id() -> String {
    build_wander_unique_id("wander-episode")
}

fn parse_episode_row(row: sqlx::postgres::PgRow) -> Result<WanderEpisodeRowData, AppError> {
    Ok(WanderEpisodeRowData {
        id: row.try_get::<Option<String>, _>("id")?.unwrap_or_default(),
        story_id: row
            .try_get::<Option<String>, _>("story_id")?
            .unwrap_or_default(),
        day_key: normalize_date_key(
            row.try_get::<Option<String>, _>("day_key_text")?
                .unwrap_or_default(),
        ),
        day_index: opt_i64_from_i32(&row, "day_index"),
        episode_title: row
            .try_get::<Option<String>, _>("episode_title")?
            .unwrap_or_default(),
        opening: row
            .try_get::<Option<String>, _>("opening")?
            .unwrap_or_default(),
        option_texts: row
            .try_get::<Option<serde_json::Value>, _>("option_texts")?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        chosen_option_index: opt_i64_from_i32_opt(&row, "chosen_option_index")?,
        chosen_option_text: row.try_get::<Option<String>, _>("chosen_option_text")?,
        episode_summary: row
            .try_get::<Option<String>, _>("episode_summary")?
            .unwrap_or_default(),
        is_ending: row
            .try_get::<Option<bool>, _>("is_ending")?
            .unwrap_or(false),
        ending_type: row
            .try_get::<Option<String>, _>("ending_type")?
            .unwrap_or_else(|| "none".to_string()),
        reward_title_name: row.try_get::<Option<String>, _>("reward_title_name")?,
        reward_title_desc: row.try_get::<Option<String>, _>("reward_title_desc")?,
        reward_title_color: row.try_get::<Option<String>, _>("reward_title_color")?,
        reward_title_effects: parse_number_map(
            row.try_get::<Option<serde_json::Value>, _>("reward_title_effects")?,
        ),
        created_at: row
            .try_get::<Option<String>, _>("created_at_text")?
            .unwrap_or_default(),
        chosen_at: row.try_get::<Option<String>, _>("chosen_at_text")?,
    })
}

fn map_episode_row(row: WanderEpisodeRowData) -> WanderEpisodeDto {
    WanderEpisodeDto {
        id: row.id,
        day_key: row.day_key,
        day_index: row.day_index,
        title: row.episode_title,
        opening: row.opening,
        options: row
            .option_texts
            .into_iter()
            .enumerate()
            .map(|(index, text)| WanderEpisodeOptionDto {
                index: index as i64,
                text,
            })
            .collect(),
        chosen_option_index: row.chosen_option_index,
        chosen_option_text: row.chosen_option_text,
        summary: row.episode_summary,
        is_ending: row.is_ending,
        ending_type: normalize_ending_type(&row.ending_type),
        reward_title_name: row.reward_title_name,
        reward_title_desc: row.reward_title_desc,
        reward_title_color: normalize_wander_title_color(row.reward_title_color),
        reward_title_effects: normalize_wander_title_effects_value_map(row.reward_title_effects),
        created_at: row.created_at,
        chosen_at: row.chosen_at,
    }
}

fn parse_number_map(value: Option<serde_json::Value>) -> std::collections::BTreeMap<String, f64> {
    value
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(k, v)| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .map(|n| (k, n))
        })
        .collect()
}

fn normalize_wander_title_color(color: Option<String>) -> Option<String> {
    let normalized = color
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let is_hex = normalized.len() == 7
        && normalized.starts_with('#')
        && normalized.chars().skip(1).all(|ch| ch.is_ascii_hexdigit());
    is_hex.then(|| normalized.to_string())
}

fn normalize_wander_title_effects(
    value: Option<serde_json::Value>,
) -> std::collections::BTreeMap<String, f64> {
    normalize_wander_title_effects_value_map(parse_number_map(value))
}

fn normalize_wander_title_effects_value_map(
    raw: std::collections::BTreeMap<String, f64>,
) -> std::collections::BTreeMap<String, f64> {
    raw.into_iter()
        .filter(|(key, value)| {
            WANDER_TITLE_EFFECT_KEYS.contains(&key.as_str()) && value.is_finite() && *value != 0.0
        })
        .map(|(key, value)| {
            let normalized = if WANDER_TITLE_RATIO_EFFECT_KEYS.contains(&key.as_str()) {
                (value * WANDER_TITLE_RATIO_EFFECT_PRECISION).round()
                    / WANDER_TITLE_RATIO_EFFECT_PRECISION
            } else {
                value.floor()
            };
            (key, normalized)
        })
        .filter(|(_, value)| *value != 0.0)
        .collect()
}

fn normalize_date_key(raw: String) -> String {
    raw.chars().take(10).collect()
}

fn normalize_ending_type(raw: &str) -> String {
    match raw.trim() {
        "good" | "neutral" | "tragic" | "bizarre" => raw.trim().to_string(),
        _ => "none".to_string(),
    }
}

fn failure_result<T>(message: &str) -> ServiceResult<T> {
    ServiceResult {
        success: false,
        message: Some(message.to_string()),
        data: None,
    }
}

struct WanderCooldownState {
    cooldown_until: Option<String>,
    cooldown_remaining_seconds: i64,
    is_cooling_down: bool,
}

#[derive(Clone)]
struct WanderGenerationJobWithDayKeyRowData {
    day_key: String,
    status: String,
    error_message: Option<String>,
    generated_episode_id: Option<String>,
}

fn build_wander_cooldown_state(
    latest_episode_created_at: Option<&str>,
    now: time::OffsetDateTime,
    node_env: &str,
) -> WanderCooldownState {
    let bypass = node_env == "development";
    if bypass {
        return WanderCooldownState {
            cooldown_until: None,
            cooldown_remaining_seconds: 0,
            is_cooling_down: false,
        };
    }
    let Some(created_at) = latest_episode_created_at.and_then(parse_rfc3339) else {
        return WanderCooldownState {
            cooldown_until: None,
            cooldown_remaining_seconds: 0,
            is_cooling_down: false,
        };
    };
    let cooldown_until = created_at + time::Duration::hours(1);
    let remaining_ms =
        (cooldown_until.unix_timestamp_nanos() - now.unix_timestamp_nanos()).max(0) / 1_000_000;
    let remaining = ((remaining_ms + 999) / 1_000) as i64;
    WanderCooldownState {
        cooldown_until: Some(
            cooldown_until
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
        ),
        cooldown_remaining_seconds: remaining,
        is_cooling_down: remaining > 0,
    }
}

fn parse_rfc3339(raw: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339).ok()
}

fn format_rfc3339(value: time::OffsetDateTime) -> Result<String, AppError> {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| AppError::config(format!("failed to format wander timestamp: {error}")))
}

fn build_date_key(date: time::OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

fn resolve_wander_generation_day_key(
    latest_episode_day_key: Option<&str>,
    now: time::OffsetDateTime,
) -> String {
    let today = build_date_key(now);
    let Some(latest_day) = latest_episode_day_key.and_then(parse_date_key) else {
        return today;
    };
    let Some(today_day) = parse_date_key(&today) else {
        return today;
    };
    if latest_day < today_day {
        today
    } else {
        build_date_key(latest_day + time::Duration::days(1))
    }
}

fn parse_date_key(raw: &str) -> Option<time::OffsetDateTime> {
    let value = format!("{raw}T00:00:00+00:00");
    parse_rfc3339(&value)
}

fn advance_date_key(day_key: &str) -> String {
    parse_date_key(day_key)
        .map(|day| build_date_key(day + time::Duration::days(1)))
        .unwrap_or_else(|| day_key.to_string())
}

fn format_wander_cooldown_remaining(cooldown_remaining_seconds: i64) -> String {
    let safe_seconds = cooldown_remaining_seconds.max(0);
    let hour_seconds = 3600;
    let minute_seconds = 60;
    if safe_seconds >= hour_seconds {
        let hours = safe_seconds / hour_seconds;
        let minutes = (safe_seconds % hour_seconds) / minute_seconds;
        if minutes > 0 {
            return format!("{hours}小时{minutes}分");
        }
        return format!("{hours}小时");
    }
    if safe_seconds >= minute_seconds {
        let minutes = safe_seconds / minute_seconds;
        let seconds = safe_seconds % minute_seconds;
        if seconds > 0 {
            return format!("{minutes}分{seconds}秒");
        }
        return format!("{minutes}分");
    }
    format!("{safe_seconds}秒")
}

fn build_generation_id() -> String {
    build_wander_unique_id("wander-job")
}

fn current_local_time() -> time::OffsetDateTime {
    let now_utc = time::OffsetDateTime::now_utc();
    match time::UtcOffset::current_local_offset() {
        Ok(offset) => now_utc.to_offset(offset),
        Err(_) => now_utc,
    }
}

fn current_timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        WanderOverviewDto, build_date_key, build_wander_cooldown_state, current_local_time,
        format_wander_cooldown_remaining, process_failure_result, process_generated_result,
        resolve_wander_generation_day_key,
    };
    use crate::integrations::wander_ai::parse_and_validate_wander_ai_episode_resolution_draft;

    #[test]
    fn wander_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": serde_json::to_value(WanderOverviewDto {
                today: "2026-04-11".to_string(),
                ai_available: true,
                has_pending_episode: false,
                is_resolving_episode: false,
                can_generate: true,
                is_cooling_down: false,
                cooldown_until: None,
                cooldown_remaining_seconds: 0,
                current_generation_job: None,
                active_story: None,
                current_episode: None,
                latest_finished_story: None,
                generated_titles: Vec::new(),
            }).expect("overview dto should serialize")
        });
        assert_eq!(payload["data"]["today"], "2026-04-11");
        assert_eq!(payload["message"], "ok");
        assert_eq!(payload["data"]["aiAvailable"], true);
        println!("WANDER_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn wander_cooldown_rounds_up_subsecond_gap_like_node() {
        let created_at = "2026-04-12T00:00:00Z";
        let now = time::OffsetDateTime::parse(
            "2026-04-12T00:59:59.001Z",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("timestamp should parse");

        let state = build_wander_cooldown_state(Some(created_at), now, "production");

        assert_eq!(state.cooldown_remaining_seconds, 1);
        assert!(state.is_cooling_down);
    }

    #[test]
    fn wander_cooldown_bypasses_in_development() {
        let now = current_local_time();
        let state = build_wander_cooldown_state(Some("2026-04-12T00:00:00Z"), now, "development");

        assert_eq!(state.cooldown_remaining_seconds, 0);
        assert!(!state.is_cooling_down);
        assert_eq!(state.cooldown_until, None);
    }

    #[test]
    fn date_key_uses_offset_datetime_calendar_date() {
        let local = time::OffsetDateTime::parse(
            "2026-04-12T00:30:00+08:00",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("timestamp should parse");

        assert_eq!(build_date_key(local), "2026-04-12");
    }

    #[test]
    fn wander_generate_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "当前云游已进入推演",
            "data": {
                "job": {
                    "generationId": "wander-gen-123",
                    "status": "pending",
                    "startedAt": "2026-04-12T00:00:00Z",
                    "finishedAt": null,
                    "errorMessage": null
                }
            }
        });
        assert_eq!(payload["data"]["job"]["status"], "pending");
        assert_eq!(payload["data"]["job"]["generationId"], "wander-gen-123");
        println!("WANDER_GENERATE_RESPONSE={}", payload);
    }

    #[test]
    fn generation_day_key_moves_forward_when_latest_is_today() {
        let now = time::OffsetDateTime::parse(
            "2026-04-12T12:00:00+08:00",
            &time::format_description::well_known::Rfc3339,
        )
        .expect("timestamp should parse");
        assert_eq!(
            resolve_wander_generation_day_key(Some("2026-04-12"), now),
            "2026-04-13"
        );
    }

    #[test]
    fn cooldown_remaining_format_matches_node_style() {
        assert_eq!(format_wander_cooldown_remaining(3661), "1小时1分");
        assert_eq!(format_wander_cooldown_remaining(61), "1分1秒");
        assert_eq!(format_wander_cooldown_remaining(5), "5秒");
    }

    #[test]
    fn wander_choose_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "本幕抉择已落定，正在推演后续结果",
            "data": {
                "story": {
                    "id": "wander-story-1",
                    "status": "active",
                    "theme": "雨夜借灯",
                    "premise": "你误入谷口深处。",
                    "summary": "",
                    "episodeCount": 1,
                    "rewardTitleId": null,
                    "finishedAt": null,
                    "createdAt": "2026-04-12T00:00:00Z",
                    "updatedAt": "2026-04-12T00:00:00Z",
                    "episodes": []
                },
                "job": {
                    "generationId": "wander-gen-456",
                    "status": "pending",
                    "startedAt": "2026-04-12T00:01:00Z",
                    "finishedAt": null,
                    "errorMessage": null
                }
            }
        });
        assert_eq!(payload["data"]["job"]["status"], "pending");
        assert_eq!(payload["data"]["story"]["status"], "active");
        println!("WANDER_CHOOSE_RESPONSE={}", payload);
    }

    #[test]
    fn pending_generation_process_success_payload_matches_contract() {
        let payload = serde_json::to_value(process_generated_result("episode-1"))
            .expect("result should serialize");
        assert_eq!(payload["data"]["status"], "generated");
        assert_eq!(payload["data"]["episodeId"], "episode-1");
        println!("WANDER_PROCESS_GENERATED_RESPONSE={}", payload);
    }

    #[test]
    fn wander_resolution_validation_accepts_ending_payload() {
        let outcome = parse_and_validate_wander_ai_episode_resolution_draft(
            "{\n                \"summary\":\"你在《云梦夜航》的终幕中选择了驻足观望，最终借月下潮声看清了整段奇遇的真意，并为自己留下一枚完整的归航印记。\",\n                \"endingType\":\"good\",\n                \"rewardTitleName\":\"云航客\",\n                \"rewardTitleDesc\":\"在云梦夜航的终幕中仍能稳住心神之人。\",\n                \"rewardTitleColor\":\"#4CAF50\",\n                \"rewardTitleEffects\":[{\"key\":\"max_qixue\",\"value\":50},{\"key\":\"wugong\",\"value\":5}]\n            }",
        )
        .expect("resolution draft should validate");
        assert_eq!(outcome.ending_type, "good");
        assert_eq!(outcome.reward_title_name, "云航客");
        assert!(outcome.reward_title_effects.contains_key("max_qixue"));
    }

    #[test]
    fn wander_resolution_user_message_contains_story_context() {
        let message = super::build_wander_ai_resolution_user_message(
            "韩立",
            "炼炁化神·结胎期",
            true,
            Some(&super::WanderAiStoryPartnerDto {
                partner_id: 9,
                partner_def_id: "generated-partner-1".to_string(),
                nickname: "青木灵伴".to_string(),
                name: "青木灵伴".to_string(),
                description: Some("与你结伴而行的灵伴".to_string()),
                role: "support".to_string(),
                quality: "玄".to_string(),
            }),
            Some(&super::WanderAiStoryOtherPlayerDto {
                character_id: 77,
                nickname: "白尘".to_string(),
                title: Some("散修".to_string()),
                realm: "炼精化炁".to_string(),
                sub_realm: Some("养气期".to_string()),
            }),
            &super::WanderAiStoryLocationDto {
                region: "青云洲".to_string(),
                map_id: "map-qingyun-outskirts".to_string(),
                map_name: "青云郊外".to_string(),
                area_id: "room-forest-clearing".to_string(),
                area_name: "林间空地".to_string(),
                full_name: "青云洲·青云郊外·林间空地".to_string(),
            },
            "云梦夜航",
            "你在夜色中踏入云水深处。",
            "前两幕里你已追到桥头灯影背后的因果。",
            3,
            3,
            "云梦终幕",
            "夜雨压桥，河雾顺着石栏缓缓爬起。",
            "驻足观望，静察风向",
            true,
            &[super::WanderAiPreviousEpisodeContextDto {
                day_index: 1,
                location_name: "青云洲·青云郊外·林间空地".to_string(),
                title: "桥头灯影".to_string(),
                opening: "夜雨压桥，河雾顺着石栏缓缓爬起。".to_string(),
                chosen_option_text: "先借檐避雨，再试探来意".to_string(),
                summary: "你先借檐避雨，再试探桥头提灯客的真实来意。".to_string(),
                is_ending: false,
            }],
            4203,
        );
        let payload: serde_json::Value =
            serde_json::from_str(&message).expect("message should be json");
        assert_eq!(payload["player"]["nickname"], "韩立");
        assert_eq!(payload["player"]["hasTeam"], true);
        assert_eq!(payload["player"]["storyPartner"]["partnerId"], 9);
        assert_eq!(payload["player"]["storyPartner"]["quality"], "玄");
        assert_eq!(
            payload["player"]["storyPartner"]["description"],
            "与你结伴而行的灵伴"
        );
        assert_eq!(payload["player"]["storyOtherPlayer"]["characterId"], 77);
        assert_eq!(payload["player"]["storyOtherPlayer"]["nickname"], "白尘");
        assert_eq!(payload["player"]["storyOtherPlayer"]["realm"], "炼精化炁");
        assert_eq!(payload["player"]["storyOtherPlayer"]["subRealm"], "养气期");
        assert_eq!(
            payload["storyLocation"]["fullName"],
            "青云洲·青云郊外·林间空地"
        );
        assert_eq!(payload["story"]["activeTheme"], "云梦夜航");
        assert_eq!(
            payload["story"]["activePremise"],
            "你在夜色中踏入云水深处。"
        );
        assert_eq!(
            payload["story"]["storySummary"],
            "前两幕里你已追到桥头灯影背后的因果。"
        );
        assert_eq!(payload["story"]["currentEpisodeIndex"], 3);
        assert_eq!(payload["story"]["maxEpisodeIndex"], 3);
        assert_eq!(payload["story"]["currentEpisodeTitle"], "云梦终幕");
        assert_eq!(
            payload["story"]["currentEpisodeOpening"],
            "夜雨压桥，河雾顺着石栏缓缓爬起。"
        );
        assert_eq!(payload["story"]["chosenOptionText"], "驻足观望，静察风向");
        assert_eq!(payload["story"]["isEndingEpisode"], true);
        assert_eq!(payload["story"]["resolutionMode"], "must_end");
        assert_eq!(payload["outputRules"]["summaryLengthRange"], "20-160");
        assert_eq!(payload["outputRules"]["rewardTitleNameLengthRange"], "2-8");
        assert_eq!(payload["outputRules"]["rewardTitleDescLengthRange"], "8-40");
        assert_eq!(payload["outputRules"]["rewardTitleColorPattern"], "#RRGGBB");
        assert_eq!(payload["outputRules"]["rewardTitleEffectCountRange"], "1-5");
        assert_eq!(
            payload["outputRules"]["rewardTitleEffectValueMaxMap"]["max_qixue"],
            240
        );
        assert_eq!(
            payload["outputRules"]["rewardTitleEffectValueMaxMap"]["wugong"],
            60
        );
        assert_eq!(
            payload["outputRules"]["nonEndingTitleFieldExample"]["endingType"],
            "none"
        );
        assert_eq!(payload["story"]["previousEpisodes"][0]["title"], "桥头灯影");
        assert_eq!(
            payload["story"]["previousEpisodes"][0]["locationName"],
            "青云洲·青云郊外·林间空地"
        );
        assert_eq!(
            payload["story"]["previousEpisodes"][0]["chosenOptionText"],
            "先借檐避雨，再试探来意"
        );
        assert_eq!(
            payload["story"]["previousEpisodes"][0]["summary"],
            "你先借檐避雨，再试探桥头提灯客的真实来意。"
        );
        println!("WANDER_RESOLUTION_CONTEXT_PAYLOAD={payload}");
    }

    #[test]
    fn wander_resolution_system_message_contains_richer_rule_set() {
        let ending = super::build_wander_ai_resolution_system_message(true);
        let continuing = super::build_wander_ai_resolution_system_message(false);
        assert!(ending.contains("你必须输出严格 JSON"));
        assert!(ending.contains("游戏境界顺序示例"));
        assert!(ending.contains("禁止写炼气期、筑基期、结丹期"));
        assert!(ending.contains("summary 示例"));
        assert!(ending.contains("rewardTitleColor 示例：#faad14"));
        assert!(ending.contains("rewardTitleEffects 上限"));
        assert!(ending.contains("rewardTitleEffects 示例"));
        assert!(continuing.contains("非终幕结算必须返回 endingType=none"));
        println!("WANDER_RESOLUTION_SYSTEM_ENDING={ending}");
        println!("WANDER_RESOLUTION_SYSTEM_CONTINUING={continuing}");
    }

    #[test]
    fn wander_resolution_repair_user_message_contains_original_task_and_reason() {
        let original = super::build_wander_ai_resolution_user_message(
            "韩立",
            "炼炁化神·结胎期",
            true,
            None,
            None,
            &super::WanderAiStoryLocationDto {
                region: "青云洲".to_string(),
                map_id: "map-qingyun-outskirts".to_string(),
                map_name: "青云郊外".to_string(),
                area_id: "room-forest-clearing".to_string(),
                area_name: "林间空地".to_string(),
                full_name: "青云洲·青云郊外·林间空地".to_string(),
            },
            "云梦夜航",
            "你在夜色中踏入云水深处。",
            "前两幕里你已追到桥头灯影背后的因果。",
            3,
            3,
            "云梦终幕",
            "夜雨压桥，河雾顺着石栏缓缓爬起。",
            "驻足观望，静察风向",
            true,
            &[],
            4203,
        );
        let repair = super::build_wander_ai_resolution_repair_user_message(
            original.as_str(),
            "{bad json}",
            "rewardTitleColor 非法",
            true,
        );
        let payload: serde_json::Value =
            serde_json::from_str(&repair).expect("repair payload should be json");
        assert_eq!(payload["validationReason"], "rewardTitleColor 非法");
        assert_eq!(payload["previousOutput"], "{bad json}");
        assert_eq!(payload["outputRules"]["rewardTitleColorPattern"], "#RRGGBB");
        assert_eq!(
            payload["originalTask"]["story"]["currentEpisodeTitle"],
            "云梦终幕"
        );
        println!("WANDER_RESOLUTION_REPAIR_USER_PAYLOAD={payload}");
    }

    #[test]
    fn wander_resolution_repair_system_message_extends_base_rules() {
        let base = super::build_wander_ai_resolution_system_message(true);
        let repair = super::build_wander_ai_resolution_repair_system_message(true);
        assert!(repair.contains(base.as_str()));
        assert!(repair.contains("上一轮 JSON 的具体错误"));
        println!("WANDER_RESOLUTION_REPAIR_SYSTEM={repair}");
    }

    #[test]
    fn wander_story_max_episode_index_prefers_persisted_story_count() {
        let persisted = super::resolve_wander_story_max_episode_index(42, Some(4));
        let fallback_zero = super::resolve_wander_story_max_episode_index(42, Some(0));
        let fallback_none = super::resolve_wander_story_max_episode_index(42, None);
        assert_eq!(persisted, 4);
        assert_eq!(
            fallback_zero,
            super::resolve_wander_target_episode_count(42)
        );
        assert_eq!(
            fallback_none,
            super::resolve_wander_target_episode_count(42)
        );
        println!(
            "WANDER_MAX_EPISODE_INDEX={{\"persisted\":{},\"fallbackZero\":{},\"fallbackNone\":{}}}",
            persisted, fallback_zero, fallback_none
        );
    }

    #[test]
    fn wander_new_story_seed_is_positive_and_stable_for_same_timestamp() {
        let first = super::resolve_new_wander_story_seed(1_234_567_890);
        let second = super::resolve_new_wander_story_seed(1_234_567_890);
        let next = super::resolve_new_wander_story_seed(1_234_567_891);
        assert_eq!(first, second);
        assert!(first > 0);
        assert!(next > 0);
        println!(
            "WANDER_NEW_STORY_SEED={{\"first\":{},\"second\":{},\"next\":{}}}",
            first, second, next
        );
    }

    #[test]
    fn wander_unique_ids_include_prefix_and_do_not_collide() {
        let story_id = super::build_story_id();
        let episode_id = super::build_episode_id();
        let title_id = super::build_generated_title_id();
        let generation_id = super::build_generation_id();
        assert!(story_id.starts_with("wander-story-"));
        assert!(episode_id.starts_with("wander-episode-"));
        assert!(title_id.starts_with("title-wander-"));
        assert!(generation_id.starts_with("wander-job-"));
        assert_ne!(story_id, episode_id);
        assert_ne!(story_id, title_id);
        assert_ne!(story_id, generation_id);
        assert_ne!(episode_id, title_id);
        assert_ne!(episode_id, generation_id);
        println!(
            "WANDER_UNIQUE_IDS={{\"storyId\":{:?},\"episodeId\":{:?},\"titleId\":{:?},\"generationId\":{:?}}}",
            story_id, episode_id, title_id, generation_id
        );
    }

    #[test]
    fn wander_setup_story_summary_omits_summary_when_previous_episodes_exist() {
        let resolved = super::resolve_wander_setup_story_summary(
            Some("前两幕里你已追到桥头灯影背后的因果。"),
            &[super::WanderAiPreviousEpisodeContextDto {
                day_index: 1,
                location_name: "青云洲·青云郊外·林间空地".to_string(),
                title: "桥头灯影".to_string(),
                opening: "夜雨压桥，河雾顺着石栏缓缓爬起。".to_string(),
                chosen_option_text: "先借檐避雨，再试探来意".to_string(),
                summary: "你先借檐避雨，再试探桥头提灯客的真实来意。".to_string(),
                is_ending: false,
            }],
        );
        let initial_story = super::resolve_wander_setup_story_summary(Some("初入云游。"), &[]);
        assert_eq!(resolved, None);
        assert_eq!(initial_story.as_deref(), Some("初入云游。"));
        println!(
            "WANDER_SETUP_STORY_SUMMARY={{\"withPreviousEpisodes\":null,\"initialStory\":{:?}}}",
            initial_story
        );
    }

    #[test]
    fn wander_resolution_prefers_story_partner_snapshot_only() {
        let parsed =
            super::resolve_wander_story_partner_snapshot_for_resolution(Some(serde_json::json!({
                "partnerId": 9,
                "partnerDefId": "generated-partner-1",
                "nickname": "青木灵伴",
                "name": "青木灵伴",
                "description": "与你结伴而行的灵伴",
                "role": "support",
                "quality": "玄"
            })));
        let missing = super::resolve_wander_story_partner_snapshot_for_resolution(None);
        assert_eq!(parsed.as_ref().map(|value| value.partner_id), Some(9));
        assert!(missing.is_none());
        println!(
            "WANDER_RESOLUTION_PARTNER_SNAPSHOT_ONLY={{\"parsedPartnerId\":{},\"missingIsNone\":{}}}",
            parsed
                .as_ref()
                .map(|value| value.partner_id)
                .unwrap_or_default(),
            missing.is_none()
        );
    }

    #[test]
    fn wander_setup_user_message_contains_story_level_context() {
        let message = super::build_wander_ai_setup_user_message(
            "韩立",
            "炼炁化神·结胎期",
            true,
            Some(&super::WanderAiStoryPartnerDto {
                partner_id: 9,
                partner_def_id: "generated-partner-1".to_string(),
                nickname: "青木灵伴".to_string(),
                name: "青木灵伴".to_string(),
                description: Some("与你结伴而行的灵伴".to_string()),
                role: "support".to_string(),
                quality: "玄".to_string(),
            }),
            Some(&super::WanderAiStoryOtherPlayerDto {
                character_id: 77,
                nickname: "白尘".to_string(),
                title: Some("散修".to_string()),
                realm: "炼精化炁".to_string(),
                sub_realm: Some("养气期".to_string()),
            }),
            &super::WanderAiStoryLocationDto {
                region: "青云洲".to_string(),
                map_id: "map-qingyun-outskirts".to_string(),
                map_name: "青云郊外".to_string(),
                area_id: "room-forest-clearing".to_string(),
                area_name: "林间空地".to_string(),
                full_name: "青云洲·青云郊外·林间空地".to_string(),
            },
            Some("云梦夜航"),
            Some("你在夜色中踏入云水深处。"),
            Some("前两幕里你已追到桥头灯影背后的因果。"),
            3,
            4,
            false,
            &[super::WanderAiPreviousEpisodeContextDto {
                day_index: 1,
                location_name: "青云洲·青云郊外·林间空地".to_string(),
                title: "桥头灯影".to_string(),
                opening: "夜雨压桥，河雾顺着石栏缓缓爬起。".to_string(),
                chosen_option_text: "先借檐避雨，再试探来意".to_string(),
                summary: "你先借檐避雨，再试探桥头提灯客的真实来意。".to_string(),
                is_ending: false,
            }],
            4203,
        );
        let payload: serde_json::Value =
            serde_json::from_str(&message).expect("message should be json");
        assert_eq!(payload["player"]["storyPartner"]["partnerId"], 9);
        assert_eq!(payload["player"]["storyPartner"]["quality"], "玄");
        assert_eq!(payload["player"]["storyOtherPlayer"]["characterId"], 77);
        assert_eq!(payload["player"]["storyOtherPlayer"]["subRealm"], "养气期");
        assert_eq!(
            payload["storyLocation"]["fullName"],
            "青云洲·青云郊外·林间空地"
        );
        assert!(
            payload["promptNoiseHash"]
                .as_str()
                .is_some_and(|value| value.len() == 16)
        );
        assert_eq!(payload["story"]["activeTheme"], "云梦夜航");
        assert!(payload["story"]["storySummary"].is_null());
        assert_eq!(payload["story"]["maxEpisodeIndex"], 4);
        assert_eq!(payload["story"]["previousEpisodes"][0]["title"], "桥头灯影");
        assert_eq!(payload["outputRules"]["storyThemeLengthRange"], "2-24");
        assert_eq!(payload["outputRules"]["storyPremiseLengthRange"], "8-120");
        assert_eq!(payload["outputRules"]["optionCount"], 3);
        assert_eq!(payload["outputRules"]["episodeTitleLengthRange"], "2-24");
        assert_eq!(payload["outputRules"]["openingLengthRange"], "80-420");
        assert_eq!(payload["outputRules"]["storyThemeExample"], "雨夜借灯");
        assert_eq!(
            payload["outputRules"]["storyPremiseExample"],
            "你循着残留血迹误入谷口深处，才觉今夜盘踞此地的异物并非寻常山兽。"
        );
        assert_eq!(
            payload["outputRules"]["optionExample"][0],
            "先借檐避雨，再试探来意"
        );
        println!("WANDER_SETUP_CONTEXT_PAYLOAD={payload}");
    }

    #[test]
    fn wander_setup_system_message_contains_richer_rule_set() {
        let ending = super::build_wander_ai_setup_system_message(true);
        let continuing = super::build_wander_ai_setup_system_message(false);
        assert!(ending.contains("你必须输出严格 JSON"));
        assert!(ending.contains("游戏境界顺序示例"));
        assert!(ending.contains("storyTheme 示例：雨夜借灯"));
        assert!(ending.contains("storyPremise 示例"));
        assert!(ending.contains("optionTexts 示例"));
        assert!(ending.contains("opening 示例"));
        assert!(ending.contains("本幕是终幕抉择幕"));
        assert_eq!(ending.matches("若本幕是终幕抉择幕").count(), 0);
        assert!(continuing.contains("本幕不是终幕，只能继续制造悬念与分叉"));
        println!("WANDER_SETUP_SYSTEM_ENDING={ending}");
        println!("WANDER_SETUP_SYSTEM_CONTINUING={continuing}");
    }

    #[test]
    fn wander_prompt_noise_hash_is_stable_for_same_scope_and_seed() {
        let setup = super::build_wander_prompt_noise_hash("wander-story-setup", 4203);
        let setup_again = super::build_wander_prompt_noise_hash("wander-story-setup", 4203);
        let resolution = super::build_wander_prompt_noise_hash("wander-story-resolution", 4203);
        assert_eq!(setup, setup_again);
        assert_ne!(setup, resolution);
        assert_eq!(setup.len(), 16);
        println!(
            "WANDER_PROMPT_NOISE_HASH={{\"setup\":{:?},\"resolution\":{:?}}}",
            setup, resolution
        );
    }

    #[test]
    fn wander_prompt_noise_seed_is_positive_and_in_i32_range() {
        let seed = super::build_wander_prompt_noise_seed();
        assert!((1..=2_147_483_647).contains(&seed));
        println!("WANDER_PROMPT_NOISE_SEED={seed}");
    }

    #[test]
    fn wander_setup_repair_user_message_contains_original_task_and_reason() {
        let original = super::build_wander_ai_setup_user_message(
            "韩立",
            "炼炁化神·结胎期",
            true,
            None,
            None,
            &super::WanderAiStoryLocationDto {
                region: "青云洲".to_string(),
                map_id: "map-qingyun-outskirts".to_string(),
                map_name: "青云郊外".to_string(),
                area_id: "room-forest-clearing".to_string(),
                area_name: "林间空地".to_string(),
                full_name: "青云洲·青云郊外·林间空地".to_string(),
            },
            Some("云梦夜航"),
            Some("你在夜色中踏入云水深处。"),
            Some("前两幕里你已追到桥头灯影背后的因果。"),
            3,
            4,
            false,
            &[],
            4203,
        );
        let repair = super::build_wander_ai_setup_repair_user_message(
            original.as_str(),
            "{bad json}",
            "storyTheme 长度必须在 2 到 24 之间",
            false,
        );
        let payload: serde_json::Value =
            serde_json::from_str(&repair).expect("repair payload should be json");
        assert_eq!(
            payload["validationReason"],
            "storyTheme 长度必须在 2 到 24 之间"
        );
        assert_eq!(payload["previousOutput"], "{bad json}");
        assert_eq!(payload["outputRules"]["optionCount"], 3);
        assert_eq!(payload["originalTask"]["story"]["activeTheme"], "云梦夜航");
        println!("WANDER_SETUP_REPAIR_USER_PAYLOAD={payload}");
    }

    #[test]
    fn wander_setup_repair_system_message_extends_base_rules() {
        let base = super::build_wander_ai_setup_system_message(false);
        let repair = super::build_wander_ai_setup_repair_system_message(false);
        assert!(repair.contains(base.as_str()));
        assert!(repair.contains("上一轮 JSON 的具体错误"));
        println!("WANDER_SETUP_REPAIR_SYSTEM={repair}");
    }

    #[test]
    fn wander_story_location_from_seed_is_stable_and_non_empty() {
        let first = super::resolve_wander_story_location_context_from_seed(42)
            .expect("story location should resolve");
        let second = super::resolve_wander_story_location_context_from_seed(42)
            .expect("story location should resolve again");
        assert_eq!(first.full_name, second.full_name);
        assert!(!first.map_id.is_empty());
        assert!(!first.area_id.is_empty());
        println!(
            "WANDER_STORY_LOCATION={}",
            serde_json::json!({
                "mapId": first.map_id,
                "areaId": first.area_id,
                "fullName": first.full_name
            })
        );
    }

    #[test]
    fn wander_title_read_normalization_filters_invalid_color_and_effects() {
        let effects = super::normalize_wander_title_effects(Some(serde_json::json!({
            "max_qixue": 50.9,
            "wugong": 5.2,
            "baoji": 0.123456,
            "invalid_key": 999,
            "fuyuan": 0,
            "sudu": -1
        })));
        assert_eq!(
            super::normalize_wander_title_color(Some("#4CAF50".to_string())),
            Some("#4CAF50".to_string())
        );
        assert_eq!(
            super::normalize_wander_title_color(Some("green".to_string())),
            None
        );
        assert_eq!(effects.get("max_qixue"), Some(&50.0));
        assert_eq!(effects.get("wugong"), Some(&5.0));
        assert_eq!(effects.get("baoji"), Some(&0.1235));
        assert!(!effects.contains_key("invalid_key"));
        println!(
            "WANDER_TITLE_EFFECTS_NORMALIZED={}",
            serde_json::json!(effects)
        );
    }

    #[test]
    fn wander_resolution_outcome_is_normalized_before_persist() {
        let outcome = super::normalize_wander_resolution_outcome(super::WanderResolutionOutcome {
            summary: "你稳住桥势后回身压住暗潮，整段云游因果终于收拢。".to_string(),
            ending_type: "unexpected".to_string(),
            reward_title_name: Some("  断桥镇潮  ".to_string()),
            reward_title_desc: Some("  断桥一战后，余威仍镇河潮。  ".to_string()),
            reward_title_color: Some(" #faad14 ".to_string()),
            reward_title_effects: serde_json::from_value(serde_json::json!({
                "max_qixue": 50.9,
                "wugong": 5.2,
                "baoji": 0.123456,
                "invalid_key": 999,
                "fuyuan": 0,
                "sudu": -1
            }))
            .expect("effect map should deserialize"),
        });
        assert_eq!(outcome.ending_type, "none");
        assert_eq!(outcome.reward_title_name.as_deref(), Some("断桥镇潮"));
        assert_eq!(
            outcome.reward_title_desc.as_deref(),
            Some("断桥一战后，余威仍镇河潮。")
        );
        assert_eq!(outcome.reward_title_color.as_deref(), Some("#faad14"));
        assert_eq!(outcome.reward_title_effects.get("max_qixue"), Some(&50.0));
        assert_eq!(outcome.reward_title_effects.get("wugong"), Some(&5.0));
        assert_eq!(outcome.reward_title_effects.get("baoji"), Some(&0.1235));
        assert!(!outcome.reward_title_effects.contains_key("invalid_key"));
        println!(
            "WANDER_RESOLUTION_OUTCOME_NORMALIZED={}",
            serde_json::json!({
                "endingType": outcome.ending_type,
                "rewardTitleName": outcome.reward_title_name,
                "rewardTitleColor": outcome.reward_title_color,
                "rewardTitleEffects": outcome.reward_title_effects,
            })
        );
    }

    #[test]
    fn wander_ending_reward_validation_rejects_missing_color_or_effects_after_normalization() {
        let outcome = super::normalize_wander_resolution_outcome(super::WanderResolutionOutcome {
            summary: "你在桥上收住最后一式，整段奇遇也因此真正落幕。".to_string(),
            ending_type: "good".to_string(),
            reward_title_name: Some("断桥镇潮".to_string()),
            reward_title_desc: Some("断桥一战后，余威仍镇河潮。".to_string()),
            reward_title_color: Some("not-a-color".to_string()),
            reward_title_effects: std::collections::BTreeMap::new(),
        });
        let error = super::validate_wander_ending_reward_fields(&outcome)
            .expect_err("missing ending reward fields should fail");
        assert_eq!(error.to_string(), "configuration error: 结局称号数据缺失");
    }

    #[test]
    fn story_partner_snapshot_parser_accepts_persisted_shape() {
        let snapshot = serde_json::json!({
            "partnerId": 9,
            "partnerDefId": "generated-partner-1",
            "nickname": "青木灵伴",
            "name": "青木灵伴",
            "description": "与你结伴而行的灵伴",
            "role": "support",
            "quality": "玄"
        });
        let parsed = super::parse_wander_story_partner_context(snapshot)
            .expect("story partner snapshot should parse");
        assert_eq!(parsed.partner_id, 9);
        assert_eq!(parsed.partner_def_id, "generated-partner-1");
        assert_eq!(parsed.nickname, "青木灵伴");
        assert_eq!(parsed.description.as_deref(), Some("与你结伴而行的灵伴"));
        println!(
            "WANDER_STORY_PARTNER_SNAPSHOT={}",
            serde_json::json!({
                "partnerId": parsed.partner_id,
                "partnerDefId": parsed.partner_def_id,
                "nickname": parsed.nickname
            })
        );
    }

    #[test]
    fn wander_story_include_predicates_are_stable_and_non_degenerate() {
        let partner_first = super::should_include_wander_story_partner(42);
        let partner_second = super::should_include_wander_story_partner(42);
        let other_first = super::should_include_wander_story_other_player(42);
        let other_second = super::should_include_wander_story_other_player(42);
        assert_eq!(partner_first, partner_second);
        assert_eq!(other_first, other_second);
        let partner_hits = (1..=1000)
            .filter(|seed| super::should_include_wander_story_partner(*seed))
            .count();
        let other_hits = (1..=1000)
            .filter(|seed| super::should_include_wander_story_other_player(*seed))
            .count();
        assert!(partner_hits > 0 && partner_hits < 1000);
        assert!(other_hits > 0 && other_hits < 1000);
        println!(
            "WANDER_STORY_INCLUDE_COUNTS={{\"partner\":{},\"otherPlayer\":{}}}",
            partner_hits, other_hits
        );
    }

    #[test]
    fn pending_generation_process_failure_payload_matches_contract() {
        let payload = serde_json::to_value(process_failure_result("云游奇遇生成能力尚未迁移完成"))
            .expect("result should serialize");
        assert_eq!(payload["data"]["status"], "failed");
        assert_eq!(
            payload["data"]["errorMessage"],
            "云游奇遇生成能力尚未迁移完成"
        );
        println!("WANDER_PROCESS_FAILED_RESPONSE={}", payload);
    }
}
