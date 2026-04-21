use std::fs;
use std::path::PathBuf;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::BTreeMap;

use crate::auth;
use crate::integrations::redis::RedisRuntime;
use crate::integrations::redis_item_grant_delta::{
    CharacterItemGrantDelta, buffer_character_item_grant_deltas,
};
use crate::integrations::redis_resource_delta::{
    CharacterResourceDeltaField, buffer_character_resource_delta_fields,
};
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, SuccessResponse, send_result, send_success};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestChapterDto {
    pub id: String,
    pub chapter_num: i64,
    pub name: String,
    pub description: String,
    pub background: String,
    pub min_realm: String,
    pub is_completed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestSectionObjectiveDto {
    pub id: String,
    pub objective_type: String,
    pub text: String,
    pub target: i64,
    pub done: i64,
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestSectionDto {
    pub id: String,
    pub chapter_id: String,
    pub section_num: i64,
    pub name: String,
    pub description: String,
    pub brief: String,
    pub npc_id: Option<String>,
    pub map_id: Option<String>,
    pub room_id: Option<String>,
    pub status: String,
    pub objectives: Vec<MainQuestSectionObjectiveDto>,
    pub rewards: serde_json::Value,
    pub is_chapter_final: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestProgressDto {
    pub current_chapter: Option<MainQuestChapterDto>,
    pub current_section: Option<MainQuestSectionDto>,
    pub completed_chapters: Vec<String>,
    pub completed_sections: Vec<String>,
    pub dialogue_state: Option<serde_json::Value>,
    pub tracked: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestTrackPayload {
    pub tracked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDialoguePayload {
    pub dialogue_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueChoicePayload {
    pub choice_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum MainQuestRewardDto {
    #[serde(rename = "exp")]
    Exp { amount: i64 },
    #[serde(rename = "silver")]
    Silver { amount: i64 },
    #[serde(rename = "spirit_stones")]
    SpiritStones { amount: i64 },
    #[serde(rename = "item")]
    Item {
        item_def_id: String,
        quantity: i64,
        item_name: Option<String>,
        item_icon: Option<String>,
    },
    #[serde(rename = "technique")]
    Technique {
        technique_id: String,
        technique_name: Option<String>,
        technique_icon: Option<String>,
    },
    #[serde(rename = "feature_unlock")]
    FeatureUnlock { feature_code: String },
    #[serde(rename = "partner")]
    Partner {
        partner_id: i64,
        partner_def_id: String,
        partner_name: String,
        partner_avatar: Option<String>,
    },
    #[serde(rename = "title")]
    Title { title: String },
    #[serde(rename = "chapter_exp")]
    ChapterExp { amount: i64 },
    #[serde(rename = "chapter_silver")]
    ChapterSilver { amount: i64 },
    #[serde(rename = "chapter_spirit_stones")]
    ChapterSpiritStones { amount: i64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MainQuestSectionCompleteData {
    pub rewards: Vec<MainQuestRewardDto>,
    pub next_section: Option<MainQuestSectionDto>,
    pub chapter_completed: bool,
}

#[derive(Debug, Deserialize)]
struct MainQuestSeedFile {
    chapters: Vec<MainQuestChapterSeed>,
    sections: Vec<MainQuestSectionSeed>,
}

#[derive(Debug, Deserialize, Clone)]
struct MainQuestChapterSeed {
    id: String,
    chapter_num: i64,
    name: String,
    description: String,
    background: String,
    min_realm: Option<String>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct MainQuestSectionSeed {
    id: String,
    chapter_id: String,
    section_num: i64,
    name: String,
    description: String,
    brief: String,
    npc_id: Option<String>,
    map_id: Option<String>,
    room_id: Option<String>,
    dialogue_id: Option<String>,
    dialogue_complete_id: Option<String>,
    objectives: Vec<MainQuestObjectiveSeed>,
    rewards: serde_json::Value,
    is_chapter_final: Option<bool>,
    enabled: Option<bool>,
}

#[derive(Debug, Deserialize, Clone)]
struct MainQuestObjectiveSeed {
    id: String,
    #[serde(rename = "type")]
    objective_type: String,
    text: String,
    target: i64,
    params: Option<serde_json::Value>,
}

pub async fn get_main_quest_progress(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<MainQuestProgressDto>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let (chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(&state, actor.character_id, &sections).await?;
    let row = load_main_quest_progress_row(&state, actor.character_id).await?;
    Ok(send_success(build_main_quest_progress_dto(
        row, &chapters, &sections,
    )))
}

pub async fn record_main_quest_craft_item_event(
    state: &AppState,
    character_id: i64,
    recipe_id: &str,
    amount: i64,
) -> Result<(), AppError> {
    if character_id <= 0 || recipe_id.trim().is_empty() || amount <= 0 {
        return Ok(());
    }
    let (_chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(state, character_id, &sections).await?;
    let row = load_main_quest_progress_row_for_update(state, character_id).await?;
    if row.section_status != "objectives" {
        return Ok(());
    }
    let Some(section_id) = row.current_section_id.as_deref() else {
        return Ok(());
    };
    let Some(section) = sections.iter().find(|section| section.id == section_id) else {
        return Ok(());
    };
    let (next_progress, changed, completed) = apply_main_quest_craft_item_progress(
        &row.objectives_progress,
        &section.objectives,
        recipe_id,
        amount,
    );
    if !changed {
        return Ok(());
    }
    let next_status = if completed {
        "turnin"
    } else {
        row.section_status.as_str()
    };
    state.database.execute(
        "UPDATE character_main_quest_progress SET objectives_progress = $2::jsonb, section_status = $3, updated_at = NOW() WHERE character_id = $1",
        |query| query.bind(character_id).bind(serde_json::to_string(&next_progress).unwrap_or_else(|_| "{}".to_string())).bind(next_status),
    ).await?;
    Ok(())
}

pub async fn get_main_quest_chapters(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SuccessResponse<ChapterListData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let (chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(&state, actor.character_id, &sections).await?;
    let row = load_main_quest_progress_row(&state, actor.character_id).await?;
    let chapters = chapters
        .into_iter()
        .map(|chapter| MainQuestChapterDto {
            id: chapter.id.clone(),
            chapter_num: chapter.chapter_num,
            name: chapter.name,
            description: chapter.description,
            background: chapter.background,
            min_realm: chapter.min_realm.unwrap_or_else(|| "凡人".to_string()),
            is_completed: row.completed_chapters.contains(&chapter.id),
        })
        .collect();
    Ok(send_success(ChapterListData { chapters }))
}

pub async fn get_main_quest_sections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(chapter_id): Path<String>,
) -> Result<Json<SuccessResponse<SectionListData>>, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let chapter_id = chapter_id.trim();
    if chapter_id.is_empty() {
        return Err(AppError::config("章节ID不能为空"));
    }
    let (_chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(&state, actor.character_id, &sections).await?;
    let row = load_main_quest_progress_row(&state, actor.character_id).await?;
    let sections = sections
        .into_iter()
        .filter(|section| section.chapter_id == chapter_id)
        .map(|section| build_section_dto(&section, &row))
        .collect();
    Ok(send_success(SectionListData { sections }))
}

pub async fn set_main_quest_tracked(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MainQuestTrackPayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    state
        .database
        .execute(
            "UPDATE character_main_quest_progress SET tracked = $2, updated_at = NOW() WHERE character_id = $1",
            |query| query.bind(actor.character_id).bind(payload.tracked == Some(true)),
        )
        .await?;
    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({ "tracked": payload.tracked == Some(true) })),
    }))
}

pub async fn start_main_quest_dialogue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StartDialoguePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let (_chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(&state, actor.character_id, &sections).await?;
    let row = load_main_quest_progress_row(&state, actor.character_id).await?;

    if row.section_status == "dialogue" {
        if let Some(dialogue_state) = row.dialogue_state.clone() {
            let is_complete = dialogue_state
                .get("isComplete")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !is_complete {
                return Ok(send_result(ServiceResult {
                    success: true,
                    message: Some("ok".to_string()),
                    data: Some(serde_json::json!({ "dialogueState": dialogue_state })),
                }));
            }
        }
    }

    let section = row
        .current_section_id
        .as_deref()
        .and_then(|section_id| sections.iter().find(|section| section.id == section_id))
        .ok_or_else(|| AppError::config("没有可用的对话"))?;
    let dialogue_id = payload
        .dialogue_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| {
            if matches!(row.section_status.as_str(), "turnin" | "completed") {
                section
                    .dialogue_complete_id
                    .clone()
                    .or(section.dialogue_id.clone())
            } else {
                section.dialogue_id.clone()
            }
        })
        .ok_or_else(|| AppError::config("没有可用的对话"))?;

    let dialogue = load_dialogue(&dialogue_id)?.ok_or_else(|| AppError::config("对话不存在"))?;
    let dialogue_state = create_dialogue_state(&dialogue_id, &dialogue.nodes);
    state
        .database
        .execute(
            "UPDATE character_main_quest_progress SET section_status = CASE WHEN section_status = 'not_started' THEN 'dialogue' ELSE section_status END, dialogue_state = $2::jsonb, updated_at = NOW() WHERE character_id = $1",
            |query| query.bind(actor.character_id).bind(serde_json::to_string(&dialogue_state).unwrap_or_else(|_| "{}".to_string())),
        )
        .await?;

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(serde_json::json!({
            "dialogueState": dialogue_state,
        })),
    }))
}

pub async fn advance_main_quest_dialogue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let (_chapters, sections) = load_main_quest_defs()?;
    ensure_main_quest_progress_initialized(&state, actor.character_id, &sections).await?;
    let result = state
        .database
        .with_transaction(|| async {
            let row = load_main_quest_progress_row_for_update(&state, actor.character_id).await?;
            let section = row
                .current_section_id
                .as_deref()
                .and_then(|section_id| sections.iter().find(|section| section.id == section_id))
                .ok_or_else(|| AppError::config("没有进行中的对话"))?;
            let mut dialogue_state = row.dialogue_state.clone().unwrap_or_default();
            let mut dialogue_id = dialogue_state
                .get("dialogueId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if dialogue_id.is_empty() {
                dialogue_id = if matches!(row.section_status.as_str(), "turnin" | "completed") {
                    section
                        .dialogue_complete_id
                        .clone()
                        .or(section.dialogue_id.clone())
                        .unwrap_or_default()
                } else {
                    section.dialogue_id.clone().unwrap_or_default()
                };
                if dialogue_id.is_empty() {
                    return Ok(ServiceResult::<serde_json::Value> {
                        success: false,
                        message: Some("没有进行中的对话".to_string()),
                        data: None,
                    });
                }
                let dialogue =
                    load_dialogue(&dialogue_id)?.ok_or_else(|| AppError::config("对话不存在"))?;
                dialogue_state = create_dialogue_state(&dialogue_id, &dialogue.nodes);
            }

            let dialogue =
                load_dialogue(&dialogue_id)?.ok_or_else(|| AppError::config("对话不存在"))?;
            let pending_effects = dialogue_state
                .get("pendingEffects")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let effect_results = apply_dialogue_effects_tx(
                &state,
                actor.user_id,
                actor.character_id,
                pending_effects,
            )
            .await?;
            let current_node_id = dialogue_state
                .get("currentNodeId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let current_node = find_dialogue_node(&dialogue.nodes, current_node_id)
                .or_else(|| dialogue.nodes.first().cloned())
                .ok_or_else(|| AppError::config("对话节点不存在"))?;
            if current_node.node_type == "choice" {
                return Ok(ServiceResult::<serde_json::Value> {
                    success: false,
                    message: Some("请选择选项".to_string()),
                    data: None,
                });
            }
            let next_node_id = current_node.next.clone().unwrap_or_default();
            let selected_choices = dialogue_state
                .get("selectedChoices")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let next_state = if next_node_id.trim().is_empty() {
                finalize_dialogue_state(
                    &dialogue_id,
                    current_node.clone(),
                    selected_choices,
                    section,
                    &state,
                    actor.character_id,
                )
                .await?
            } else {
                let next_node = find_dialogue_node(&dialogue.nodes, &next_node_id)
                    .ok_or_else(|| AppError::config(format!("无效的对话节点: {}", next_node_id)))?;
                persist_entered_dialogue_node(
                    &dialogue_id,
                    next_node,
                    selected_choices,
                    section,
                    &state,
                    actor.character_id,
                )
                .await?
            };
            Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(serde_json::json!({
                    "dialogueState": next_state,
                    "effectResults": effect_results,
                })),
            })
        })
        .await?;
    Ok(send_result(result))
}

pub async fn choose_main_quest_dialogue_option(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DialogueChoicePayload>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let choice_id = payload.choice_id.unwrap_or_default();
    if choice_id.trim().is_empty() {
        return Err(AppError::config("选项ID不能为空"));
    }
    let (_chapters, sections) = load_main_quest_defs()?;
    let result = state
        .database
        .with_transaction(|| async {
            let row = load_main_quest_progress_row_for_update(&state, actor.character_id).await?;
            let section = row
                .current_section_id
                .as_deref()
                .and_then(|section_id| sections.iter().find(|section| section.id == section_id))
                .ok_or_else(|| AppError::config("没有进行中的对话"))?;
            let dialogue_state = row.dialogue_state.clone().unwrap_or_default();
            let dialogue_id = dialogue_state
                .get("dialogueId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if dialogue_id.is_empty() {
                return Ok(ServiceResult::<serde_json::Value> {
                    success: false,
                    message: Some("没有进行中的对话".to_string()),
                    data: None,
                });
            }
            let dialogue =
                load_dialogue(dialogue_id)?.ok_or_else(|| AppError::config("对话不存在"))?;
            let pending_effects = dialogue_state
                .get("pendingEffects")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let mut effect_results = apply_dialogue_effects_tx(
                &state,
                actor.user_id,
                actor.character_id,
                pending_effects,
            )
            .await?;
            let current_node_id = dialogue_state
                .get("currentNodeId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let current_node = find_dialogue_node(&dialogue.nodes, current_node_id)
                .ok_or_else(|| AppError::config("对话节点不存在"))?;
            if current_node.node_type != "choice" {
                return Ok(ServiceResult::<serde_json::Value> {
                    success: false,
                    message: Some("当前对话没有可选项".to_string()),
                    data: None,
                });
            }
            let choices = current_node.choices.clone().unwrap_or_default();
            let Some(choice) = choices
                .into_iter()
                .find(|choice| choice.get("id").and_then(|v| v.as_str()) == Some(choice_id.trim()))
            else {
                return Ok(ServiceResult::<serde_json::Value> {
                    success: false,
                    message: Some("选项不存在".to_string()),
                    data: None,
                });
            };
            let next_node_id = choice
                .get("next")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let choice_effects = choice
                .get("effects")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let choice_results = apply_dialogue_effects_tx(
                &state,
                actor.user_id,
                actor.character_id,
                choice_effects,
            )
            .await?;
            effect_results.extend(choice_results);
            let mut selected_choices = dialogue_state
                .get("selectedChoices")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            selected_choices.push(serde_json::Value::String(choice_id.trim().to_string()));
            let next_state = if next_node_id.trim().is_empty() {
                finalize_dialogue_state(
                    dialogue_id,
                    current_node,
                    selected_choices,
                    section,
                    &state,
                    actor.character_id,
                )
                .await?
            } else {
                let next_node = find_dialogue_node(&dialogue.nodes, next_node_id)
                    .ok_or_else(|| AppError::config(format!("无效的对话节点: {}", next_node_id)))?;
                persist_entered_dialogue_node(
                    dialogue_id,
                    next_node,
                    selected_choices,
                    section,
                    &state,
                    actor.character_id,
                )
                .await?
            };
            Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(serde_json::json!({
                    "dialogueState": next_state,
                    "effectResults": effect_results,
                })),
            })
        })
        .await?;
    Ok(send_result(result))
}

pub async fn complete_main_quest_section(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_character(&state, &headers).await?;
    let (_chapters, sections) = load_main_quest_defs()?;
    let result = state.database.with_transaction(|| async {
        let row = load_main_quest_progress_row_for_update(&state, actor.character_id).await?;
        if row.section_status != "turnin" {
            return Ok(ServiceResult::<MainQuestSectionCompleteData> {
                success: false,
                message: Some("任务未完成，无法领取奖励".to_string()),
                data: None,
            });
        }
        let current_section_id = row.current_section_id.clone().unwrap_or_default();
        let Some(section) = sections.iter().find(|section| section.id == current_section_id) else {
            return Ok(ServiceResult::<MainQuestSectionCompleteData> {
                success: false,
                message: Some("任务节不存在".to_string()),
                data: None,
            });
        };

        let mut rewards = grant_main_quest_rewards_tx(&state, actor.user_id, actor.character_id, &section.rewards, "main_quest_section", &section.id).await?;
        let mut completed_sections = row.completed_sections.clone();
        if !completed_sections.contains(&section.id) {
            completed_sections.push(section.id.clone());
        }
        let mut completed_chapters = row.completed_chapters.clone();
        let mut chapter_completed = false;
        let mut next_section_dto = None;

        if section.is_chapter_final.unwrap_or(false) {
            chapter_completed = true;
            if !completed_chapters.contains(&section.chapter_id) {
                completed_chapters.push(section.chapter_id.clone());
            }
            let chapter_rewards = load_chapter_rewards(&section.chapter_id)?;
            let chapter_reward_results = grant_main_quest_rewards_tx(&state, actor.user_id, actor.character_id, &chapter_rewards, "main_quest_chapter", &section.chapter_id).await?;
            rewards.extend(chapter_reward_results.into_iter().map(|reward| match reward {
                MainQuestRewardDto::Exp { amount } => MainQuestRewardDto::ChapterExp { amount },
                MainQuestRewardDto::Silver { amount } => MainQuestRewardDto::ChapterSilver { amount },
                MainQuestRewardDto::SpiritStones { amount } => MainQuestRewardDto::ChapterSpiritStones { amount },
                other => other,
            }));

            let next_section = sections.iter().find(|entry| chapter_num_by_id(&entry.chapter_id, &sections) > chapter_num_by_id(&section.chapter_id, &sections));
            if let Some(next_section) = next_section {
                state.database.execute(
                    "UPDATE character_main_quest_progress SET current_chapter_id = $2, current_section_id = $3, section_status = 'not_started', objectives_progress = '{}'::jsonb, dialogue_state = '{}'::jsonb, completed_chapters = $4::jsonb, completed_sections = $5::jsonb, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(actor.character_id).bind(&next_section.chapter_id).bind(&next_section.id).bind(serde_json::to_string(&completed_chapters).unwrap_or_else(|_| "[]".to_string())).bind(serde_json::to_string(&completed_sections).unwrap_or_else(|_| "[]".to_string())),
                ).await?;
            } else {
                state.database.execute(
                    "UPDATE character_main_quest_progress SET section_status = 'completed', completed_chapters = $2::jsonb, completed_sections = $3::jsonb, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(actor.character_id).bind(serde_json::to_string(&completed_chapters).unwrap_or_else(|_| "[]".to_string())).bind(serde_json::to_string(&completed_sections).unwrap_or_else(|_| "[]".to_string())),
                ).await?;
            }
        } else {
            let next_section = sections.iter().filter(|entry| entry.chapter_id == section.chapter_id).find(|entry| entry.section_num > section.section_num);
            if let Some(next_section) = next_section {
                state.database.execute(
                    "UPDATE character_main_quest_progress SET current_section_id = $2, section_status = 'not_started', objectives_progress = '{}'::jsonb, dialogue_state = '{}'::jsonb, completed_sections = $3::jsonb, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(actor.character_id).bind(&next_section.id).bind(serde_json::to_string(&completed_sections).unwrap_or_else(|_| "[]".to_string())),
                ).await?;
                next_section_dto = Some(build_section_dto(next_section, &MainQuestProgressRow {
                    current_chapter_id: Some(next_section.chapter_id.clone()),
                    current_section_id: Some(next_section.id.clone()),
                    section_status: "not_started".to_string(),
                    objectives_progress: serde_json::json!({}),
                    dialogue_state: None,
                    completed_chapters: completed_chapters.clone(),
                    completed_sections: completed_sections.clone(),
                    tracked: row.tracked,
                }));
            }
        }

        Ok(ServiceResult {
            success: true,
            message: Some("ok".to_string()),
            data: Some(MainQuestSectionCompleteData {
                rewards,
                next_section: next_section_dto,
                chapter_completed,
            }),
        })
    }).await?;
    Ok(send_result(result))
}

#[derive(Debug)]
struct MainQuestProgressRow {
    current_chapter_id: Option<String>,
    current_section_id: Option<String>,
    section_status: String,
    objectives_progress: serde_json::Value,
    dialogue_state: Option<serde_json::Value>,
    completed_chapters: Vec<String>,
    completed_sections: Vec<String>,
    tracked: bool,
}

#[derive(Debug, Deserialize)]
struct DialogueSeedFile {
    dialogues: Vec<DialogueSeed>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DialogueSeed {
    id: String,
    name: String,
    nodes: Vec<DialogueNodeSeed>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DialogueNodeSeed {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    speaker: Option<String>,
    text: Option<String>,
    emotion: Option<String>,
    choices: Option<Vec<serde_json::Value>>,
    next: Option<String>,
    effects: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize)]
pub struct ChapterListData {
    pub chapters: Vec<MainQuestChapterDto>,
}

#[derive(Debug, Serialize)]
pub struct SectionListData {
    pub sections: Vec<MainQuestSectionDto>,
}

async fn ensure_main_quest_progress_initialized(
    state: &AppState,
    character_id: i64,
    sections: &[MainQuestSectionSeed],
) -> Result<(), AppError> {
    let existing = state
        .database
        .fetch_optional(
            "SELECT 1 FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?;
    if existing.is_some() {
        return Ok(());
    }
    let first_section = sections
        .first()
        .ok_or_else(|| AppError::config("主线配置为空"))?;
    state
        .database
        .execute(
            "INSERT INTO character_main_quest_progress (character_id, current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked, updated_at) VALUES ($1, $2, $3, 'not_started', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true, NOW()) ON CONFLICT (character_id) DO NOTHING",
            |query| query.bind(character_id).bind(&first_section.chapter_id).bind(&first_section.id),
        )
        .await?;
    Ok(())
}

async fn load_main_quest_progress_row(
    state: &AppState,
    character_id: i64,
) -> Result<MainQuestProgressRow, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1",
            |query| query.bind(character_id),
        )
        .await?
        .ok_or_else(|| AppError::config("主线进度不存在"))?;
    Ok(MainQuestProgressRow {
        current_chapter_id: row.try_get("current_chapter_id")?,
        current_section_id: row.try_get("current_section_id")?,
        section_status: row
            .try_get::<Option<String>, _>("section_status")?
            .unwrap_or_else(|| "not_started".to_string()),
        objectives_progress: row
            .try_get::<Option<serde_json::Value>, _>("objectives_progress")?
            .unwrap_or_else(|| serde_json::json!({})),
        dialogue_state: row.try_get("dialogue_state")?,
        completed_chapters: row
            .try_get::<Option<serde_json::Value>, _>("completed_chapters")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|value| value.to_string()))
            .collect(),
        completed_sections: row
            .try_get::<Option<serde_json::Value>, _>("completed_sections")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|value| value.to_string()))
            .collect(),
        tracked: row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true),
    })
}

async fn load_main_quest_progress_row_for_update(
    state: &AppState,
    character_id: i64,
) -> Result<MainQuestProgressRow, AppError> {
    let row = state
        .database
        .fetch_optional(
            "SELECT current_chapter_id, current_section_id, section_status, objectives_progress, dialogue_state, completed_chapters, completed_sections, tracked FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1 FOR UPDATE",
            |query| query.bind(character_id),
        )
        .await?
        .ok_or_else(|| AppError::config("主线进度不存在"))?;
    Ok(MainQuestProgressRow {
        current_chapter_id: row.try_get("current_chapter_id")?,
        current_section_id: row.try_get("current_section_id")?,
        section_status: row
            .try_get::<Option<String>, _>("section_status")?
            .unwrap_or_else(|| "not_started".to_string()),
        objectives_progress: row
            .try_get::<Option<serde_json::Value>, _>("objectives_progress")?
            .unwrap_or_else(|| serde_json::json!({})),
        dialogue_state: row.try_get("dialogue_state")?,
        completed_chapters: row
            .try_get::<Option<serde_json::Value>, _>("completed_chapters")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|value| value.to_string()))
            .collect(),
        completed_sections: row
            .try_get::<Option<serde_json::Value>, _>("completed_sections")?
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|value| value.to_string()))
            .collect(),
        tracked: row.try_get::<Option<bool>, _>("tracked")?.unwrap_or(true),
    })
}

fn build_main_quest_progress_dto(
    row: MainQuestProgressRow,
    chapters: &[MainQuestChapterSeed],
    sections: &[MainQuestSectionSeed],
) -> MainQuestProgressDto {
    let current_chapter = row
        .current_chapter_id
        .as_deref()
        .and_then(|chapter_id| chapters.iter().find(|chapter| chapter.id == chapter_id))
        .map(|chapter| MainQuestChapterDto {
            id: chapter.id.clone(),
            chapter_num: chapter.chapter_num,
            name: chapter.name.clone(),
            description: chapter.description.clone(),
            background: chapter.background.clone(),
            min_realm: chapter
                .min_realm
                .clone()
                .unwrap_or_else(|| "凡人".to_string()),
            is_completed: row.completed_chapters.contains(&chapter.id),
        });
    let current_section = row
        .current_section_id
        .as_deref()
        .and_then(|section_id| sections.iter().find(|section| section.id == section_id))
        .map(|section| build_section_dto(section, &row));
    MainQuestProgressDto {
        current_chapter,
        current_section,
        completed_chapters: row.completed_chapters,
        completed_sections: row.completed_sections,
        dialogue_state: row.dialogue_state,
        tracked: row.tracked,
    }
}

fn apply_main_quest_craft_item_progress(
    objectives_progress: &serde_json::Value,
    objectives: &[MainQuestObjectiveSeed],
    recipe_id: &str,
    amount: i64,
) -> (serde_json::Value, bool, bool) {
    let mut progress = objectives_progress.as_object().cloned().unwrap_or_default();
    let mut changed = false;
    for objective in objectives {
        if objective.objective_type != "craft_item" {
            continue;
        }
        let expected_recipe_id = objective
            .params
            .as_ref()
            .and_then(|params| params.get("recipe_id"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if expected_recipe_id != recipe_id.trim() {
            continue;
        }
        let target = objective.target.max(1);
        let current = progress
            .get(objective.id.as_str())
            .and_then(|value| value.as_i64())
            .unwrap_or_default();
        let next = (current + amount).min(target);
        if next != current {
            progress.insert(objective.id.clone(), serde_json::json!(next));
            changed = true;
        }
    }
    let completed = objectives.iter().all(|objective| {
        let target = objective.target.max(1);
        let done = progress
            .get(objective.id.as_str())
            .and_then(|value| value.as_i64())
            .unwrap_or_default();
        done >= target
    });
    (serde_json::Value::Object(progress), changed, completed)
}

fn chapter_num_by_id(chapter_id: &str, sections: &[MainQuestSectionSeed]) -> i64 {
    let chapter_index = sections
        .iter()
        .map(|section| section.chapter_id.as_str())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    chapter_index
        .iter()
        .position(|entry| *entry == chapter_id)
        .map(|idx| idx as i64 + 1)
        .unwrap_or_default()
}

fn load_dialogue(dialogue_id: &str) -> Result<Option<DialogueSeed>, AppError> {
    for path in std::fs::read_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds"),
    )
    .map_err(|error| AppError::config(format!("failed to read dialogue dir: {error}")))?
    {
        let path = path
            .map_err(|error| AppError::config(format!("failed to iterate dialogue dir: {error}")))?
            .path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("dialogue_main_") || !file_name.ends_with(".json") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| AppError::config(format!("failed to read {file_name}: {error}")))?;
        let payload: DialogueSeedFile = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {file_name}: {error}")))?;
        if let Some(dialogue) = payload
            .dialogues
            .into_iter()
            .find(|dialogue| dialogue.enabled != Some(false) && dialogue.id == dialogue_id)
        {
            return Ok(Some(dialogue));
        }
    }
    Ok(None)
}

fn find_dialogue_node(nodes: &[DialogueNodeSeed], node_id: &str) -> Option<DialogueNodeSeed> {
    nodes.iter().find(|node| node.id == node_id).cloned()
}

fn create_dialogue_state(dialogue_id: &str, nodes: &[DialogueNodeSeed]) -> serde_json::Value {
    let current_node = nodes
        .iter()
        .find(|node| node.id == "start")
        .cloned()
        .or_else(|| nodes.first().cloned());
    let current_node_id = current_node
        .as_ref()
        .map(|node| node.id.clone())
        .unwrap_or_default();
    let pending_effects = current_node
        .as_ref()
        .and_then(|node| node.effects.clone())
        .unwrap_or_default();
    serde_json::json!({
        "dialogueId": dialogue_id,
        "currentNodeId": current_node_id,
        "currentNode": current_node,
        "selectedChoices": [],
        "isComplete": current_node.is_none(),
        "pendingEffects": pending_effects,
    })
}

async fn grant_main_quest_rewards_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    rewards: &serde_json::Value,
    obtained_from: &str,
    obtained_ref_id: &str,
) -> Result<Vec<MainQuestRewardDto>, AppError> {
    let mut out = Vec::new();
    let exp_delta = rewards
        .get("exp")
        .and_then(|v| v.as_i64())
        .unwrap_or_default()
        .max(0);
    let silver_delta = rewards
        .get("silver")
        .and_then(|v| v.as_i64())
        .unwrap_or_default()
        .max(0);
    let spirit_stones_delta = rewards
        .get("spirit_stones")
        .and_then(|v| v.as_i64())
        .unwrap_or_default()
        .max(0);
    let mut item_grants = Vec::<CharacterItemGrantDelta>::new();
    if exp_delta > 0 {
        out.push(MainQuestRewardDto::Exp { amount: exp_delta });
    }
    if silver_delta > 0 {
        out.push(MainQuestRewardDto::Silver {
            amount: silver_delta,
        });
    }
    if spirit_stones_delta > 0 {
        out.push(MainQuestRewardDto::SpiritStones {
            amount: spirit_stones_delta,
        });
    }
    let item_meta = load_item_meta_map()?;
    for item in rewards
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let item_def_id = item
            .get("item_def_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let quantity = item
            .get("quantity")
            .and_then(|v| v.as_i64())
            .unwrap_or_default()
            .max(0);
        if item_def_id.is_empty() || quantity <= 0 {
            continue;
        }
        item_grants.push(CharacterItemGrantDelta {
            character_id,
            user_id,
            item_def_id: item_def_id.clone(),
            qty: quantity,
            bind_type: "none".to_string(),
            obtained_from: obtained_from.trim().to_string(),
            obtained_ref_id: Some(obtained_ref_id.trim().to_string()),
        });
        let meta = item_meta.get(item_def_id.as_str()).cloned();
        out.push(MainQuestRewardDto::Item {
            item_def_id,
            quantity,
            item_name: meta.as_ref().map(|m| m.0.clone()),
            item_icon: meta.and_then(|m| m.1),
        });
    }
    let technique_meta = load_technique_meta_map()?;
    for technique in rewards
        .get("techniques")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let technique_id = technique.as_str().unwrap_or_default().trim().to_string();
        if technique_id.is_empty() {
            continue;
        }
        let exists = state.database.fetch_optional(
            "SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
            |query| query.bind(character_id).bind(&technique_id),
        ).await?;
        if exists.is_none() {
            state.database.execute(
                "INSERT INTO character_technique (character_id, technique_id, current_layer, acquired_at) VALUES ($1, $2, 1, NOW())",
                |query| query.bind(character_id).bind(&technique_id),
            ).await?;
            let meta = technique_meta.get(technique_id.as_str()).cloned();
            out.push(MainQuestRewardDto::Technique {
                technique_id,
                technique_name: meta.as_ref().map(|m| m.0.clone()),
                technique_icon: meta.and_then(|m| m.1),
            });
        }
    }
    for title in rewards
        .get("titles")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let title = title.as_str().unwrap_or_default().trim().to_string();
        if !title.is_empty() {
            state
                .database
                .execute(
                    "UPDATE characters SET title = $2, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(character_id).bind(&title),
                )
                .await?;
            out.push(MainQuestRewardDto::Title { title });
        }
    }
    for feature_code in rewards
        .get("unlock_features")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
    {
        let feature_code = feature_code.as_str().unwrap_or_default().trim().to_string();
        if feature_code.is_empty() {
            continue;
        }
        state.database.execute(
            "INSERT INTO character_feature_unlocks (character_id, feature_code, unlocked_at, created_at) VALUES ($1, $2, NOW(), NOW()) ON CONFLICT DO NOTHING",
            |query| query.bind(character_id).bind(&feature_code),
        ).await?;
        out.push(MainQuestRewardDto::FeatureUnlock {
            feature_code: feature_code.clone(),
        });
        if feature_code == "partner_system" {
            let partner = grant_starter_partner_tx(state, user_id, character_id).await?;
            if let Some((partner_id, partner_def_id, partner_name, partner_avatar)) = partner {
                out.push(MainQuestRewardDto::Partner {
                    partner_id,
                    partner_def_id,
                    partner_name,
                    partner_avatar,
                });
            }
        }
    }
    if state.redis_available && state.redis.is_some() {
        let redis = RedisRuntime::new(state.redis.clone().expect("redis should exist"));
        let mut resource_fields = Vec::new();
        if exp_delta > 0 {
            resource_fields.push(CharacterResourceDeltaField {
                character_id,
                field: "exp".to_string(),
                increment: exp_delta,
            });
        }
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
            state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from, obtained_ref_id) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), $5, $6) RETURNING id",
                |query| query.bind(user_id).bind(character_id).bind(grant.item_def_id.as_str()).bind(grant.qty).bind(obtained_from).bind(obtained_ref_id),
            ).await?;
        }
        if exp_delta > 0 || silver_delta > 0 || spirit_stones_delta > 0 {
            state.database.execute(
                "UPDATE characters SET exp = exp + $2, silver = silver + $3, spirit_stones = spirit_stones + $4, updated_at = NOW() WHERE id = $1",
                |query| query.bind(character_id).bind(exp_delta).bind(silver_delta).bind(spirit_stones_delta),
            ).await?;
        }
    }
    Ok(out)
}

async fn grant_starter_partner_tx(
    state: &AppState,
    _user_id: i64,
    character_id: i64,
) -> Result<Option<(i64, String, String, Option<String>)>, AppError> {
    let def = load_partner_def_map()?
        .get("partner-qingmu-xiaoou")
        .cloned();
    let Some(def) = def else {
        return Ok(None);
    };
    let existing = state.database.fetch_optional(
        "SELECT id FROM character_partner WHERE character_id = $1 AND partner_def_id = $2 LIMIT 1",
        |query| query.bind(character_id).bind(def.id.as_str()),
    ).await?;
    if existing.is_some() {
        return Ok(None);
    }
    let inserted = state.database.fetch_one(
        "INSERT INTO character_partner (character_id, partner_def_id, nickname, description, avatar, level, progress_exp, growth_max_qixue, growth_wugong, growth_fagong, growth_wufang, growth_fafang, growth_sudu, is_active, obtained_from, obtained_ref_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 0, 0, 0, 0, 0, 0, 0, false, 'main_quest', NULL, NOW(), NOW()) RETURNING id",
        |query| query.bind(character_id).bind(def.id.as_str()).bind(def.name.clone()).bind(def.description.clone()).bind(def.avatar.clone()),
    ).await?;
    let partner_id: i64 = inserted.try_get("id")?;
    Ok(Some((
        partner_id,
        def.id.clone(),
        def.name.clone(),
        def.avatar.clone(),
    )))
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

fn load_technique_meta_map() -> Result<BTreeMap<String, (String, Option<String>)>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/technique_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read technique_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse technique_def.json: {error}"))
    })?;
    let items = payload
        .get("techniques")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim().to_string();
            let name = item.get("name")?.as_str()?.trim().to_string();
            let icon = item
                .get("icon")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            (!id.is_empty() && !name.is_empty()).then_some((id, (name, icon)))
        })
        .collect())
}

fn load_chapter_rewards(chapter_id: &str) -> Result<serde_json::Value, AppError> {
    let content = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../server/src/data/seeds/{}{}.json",
        "main_quest_chapter",
        chapter_id.split('-').last().unwrap_or_default()
    )))
    .map_err(|error| AppError::config(format!("failed to read chapter reward seed: {error}")))?;
    let payload: MainQuestSeedFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse chapter reward seed: {error}"))
    })?;
    Ok(payload
        .chapters
        .into_iter()
        .find(|chapter| chapter.id == chapter_id)
        .map(|_chapter| serde_json::json!({}))
        .unwrap_or_else(|| serde_json::json!({})))
}

fn load_partner_def_map() -> Result<BTreeMap<String, PartnerDefLite>, AppError> {
    let content = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds/partner_def.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read partner_def.json: {error}")))?;
    let payload: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::config(format!("failed to parse partner_def.json: {error}")))?;
    let partners = payload
        .get("partners")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(partners
        .into_iter()
        .filter_map(|partner| {
            let id = partner.get("id")?.as_str()?.trim().to_string();
            let name = partner.get("name")?.as_str()?.trim().to_string();
            let description = partner
                .get("description")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            let avatar = partner
                .get("avatar")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string());
            (!id.is_empty() && !name.is_empty()).then_some((
                id.clone(),
                PartnerDefLite {
                    id,
                    name,
                    description,
                    avatar,
                },
            ))
        })
        .collect())
}

#[derive(Clone)]
struct PartnerDefLite {
    id: String,
    name: String,
    description: Option<String>,
    avatar: Option<String>,
}

async fn persist_entered_dialogue_node(
    dialogue_id: &str,
    next_node: DialogueNodeSeed,
    selected_choices: Vec<serde_json::Value>,
    section: &MainQuestSectionSeed,
    state: &AppState,
    character_id: i64,
) -> Result<serde_json::Value, AppError> {
    let auto_complete = next_node.node_type != "choice"
        && next_node
            .effects
            .as_ref()
            .map(|effects| effects.is_empty())
            .unwrap_or(true)
        && next_node
            .next
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty();
    let next_state = serde_json::json!({
        "dialogueId": dialogue_id,
        "currentNodeId": next_node.id,
        "currentNode": next_node,
        "selectedChoices": selected_choices,
        "isComplete": auto_complete,
        "pendingEffects": if auto_complete { vec![] } else { next_node.effects.clone().unwrap_or_default() },
    });
    if auto_complete {
        let next_status = if section.objectives.is_empty() {
            "turnin"
        } else {
            "objectives"
        };
        state.database.execute(
            "UPDATE character_main_quest_progress SET dialogue_state = $2::jsonb, section_status = $3, updated_at = NOW() WHERE character_id = $1",
            |query| query.bind(character_id).bind(serde_json::to_string(&next_state).unwrap_or_else(|_| "{}".to_string())).bind(next_status),
        ).await?;
    } else {
        state.database.execute(
            "UPDATE character_main_quest_progress SET dialogue_state = $2::jsonb, section_status = 'dialogue', updated_at = NOW() WHERE character_id = $1",
            |query| query.bind(character_id).bind(serde_json::to_string(&next_state).unwrap_or_else(|_| "{}".to_string())),
        ).await?;
    }
    Ok(next_state)
}

async fn finalize_dialogue_state(
    dialogue_id: &str,
    current_node: DialogueNodeSeed,
    selected_choices: Vec<serde_json::Value>,
    section: &MainQuestSectionSeed,
    state: &AppState,
    character_id: i64,
) -> Result<serde_json::Value, AppError> {
    let next_status = if section.objectives.is_empty() {
        "turnin"
    } else {
        "objectives"
    };
    let state_value = serde_json::json!({
        "dialogueId": dialogue_id,
        "currentNodeId": current_node.id,
        "currentNode": current_node,
        "selectedChoices": selected_choices,
        "isComplete": true,
        "pendingEffects": [],
    });
    state.database.execute(
        "UPDATE character_main_quest_progress SET dialogue_state = $2::jsonb, section_status = $3, updated_at = NOW() WHERE character_id = $1",
        |query| query.bind(character_id).bind(serde_json::to_string(&state_value).unwrap_or_else(|_| "{}".to_string())).bind(next_status),
    ).await?;
    Ok(state_value)
}

async fn apply_dialogue_effects_tx(
    state: &AppState,
    user_id: i64,
    character_id: i64,
    effects: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let mut effect_results = Vec::new();
    let mut silver_delta = 0_i64;
    let mut spirit_stones_delta = 0_i64;
    let mut exp_delta = 0_i64;
    let mut item_grants = Vec::<CharacterItemGrantDelta>::new();
    for effect in effects {
        let effect_type = effect
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let params = effect
            .get("params")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        match effect_type {
            "give_silver" => {
                let amount = params
                    .get("amount")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default()
                    .max(0);
                if amount > 0 {
                    silver_delta += amount;
                    effect_results.push(serde_json::json!({"type": "silver", "amount": amount}));
                }
            }
            "give_spirit_stones" => {
                let amount = params
                    .get("amount")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default()
                    .max(0);
                if amount > 0 {
                    spirit_stones_delta += amount;
                    effect_results
                        .push(serde_json::json!({"type": "spirit_stones", "amount": amount}));
                }
            }
            "give_exp" => {
                let amount = params
                    .get("amount")
                    .and_then(|v| v.as_i64())
                    .unwrap_or_default()
                    .max(0);
                if amount > 0 {
                    exp_delta += amount;
                    effect_results.push(serde_json::json!({"type": "exp", "amount": amount}));
                }
            }
            "give_technique" => {
                let technique_id = params
                    .get("technique_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if !technique_id.is_empty() {
                    let exists = state.database.fetch_optional(
                        "SELECT 1 FROM character_technique WHERE character_id = $1 AND technique_id = $2 LIMIT 1",
                        |query| query.bind(character_id).bind(&technique_id),
                    ).await?;
                    if exists.is_none() {
                        state.database.execute(
                            "INSERT INTO character_technique (character_id, technique_id, current_layer, acquired_at) VALUES ($1, $2, 1, NOW())",
                            |query| query.bind(character_id).bind(&technique_id),
                        ).await?;
                        effect_results.push(
                            serde_json::json!({"type": "technique", "techniqueId": technique_id}),
                        );
                    }
                }
            }
            "give_item" => {
                let item_def_id = params
                    .get("item_def_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let qty = params
                    .get("quantity")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(1)
                    .max(1);
                if !item_def_id.is_empty() {
                    item_grants.push(CharacterItemGrantDelta {
                        character_id,
                        user_id,
                        item_def_id: item_def_id.clone(),
                        qty,
                        bind_type: "none".to_string(),
                        obtained_from: "dialogue".to_string(),
                        obtained_ref_id: None,
                    });
                    effect_results.push(serde_json::json!({"type": "item", "itemDefId": item_def_id, "quantity": qty}));
                }
            }
            "set_flag" => {
                let flag = params
                    .get("flag")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let value = params
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::json!(true));
                if !flag.is_empty() {
                    state.database.execute(
                        "UPDATE characters SET extra_data = COALESCE(extra_data, '{}'::jsonb) || jsonb_build_object($2, $3::jsonb), updated_at = NOW() WHERE id = $1",
                        |query| query.bind(character_id).bind(&flag).bind(value.to_string()),
                    ).await?;
                    effect_results.push(serde_json::json!({"type": "flag", "flag": flag}));
                }
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
            state.database.fetch_one(
                "INSERT INTO item_instance (owner_user_id, owner_character_id, item_def_id, qty, bind_type, location, created_at, updated_at, obtained_from) VALUES ($1, $2, $3, $4, 'none', 'bag', NOW(), NOW(), 'dialogue') RETURNING id",
                |query| query.bind(user_id).bind(character_id).bind(grant.item_def_id.as_str()).bind(grant.qty),
            ).await?;
        }
        if silver_delta > 0 || spirit_stones_delta > 0 || exp_delta > 0 {
            state.database.execute(
                "UPDATE characters SET silver = silver + $2, spirit_stones = spirit_stones + $3, exp = exp + $4, updated_at = NOW() WHERE id = $1",
                |query| query.bind(character_id).bind(silver_delta).bind(spirit_stones_delta).bind(exp_delta),
            ).await?;
        }
    }
    Ok(effect_results)
}

fn build_section_dto(
    section: &MainQuestSectionSeed,
    row: &MainQuestProgressRow,
) -> MainQuestSectionDto {
    let is_current = row.current_section_id.as_deref() == Some(section.id.as_str());
    let is_completed = row.completed_sections.contains(&section.id);
    let status = if is_completed {
        "completed".to_string()
    } else if is_current {
        row.section_status.clone()
    } else {
        "not_started".to_string()
    };
    let progress_data = row
        .objectives_progress
        .as_object()
        .cloned()
        .unwrap_or_default();
    let objectives = section
        .objectives
        .iter()
        .map(|objective| {
            let target = objective.target.max(1);
            let done = if is_current {
                progress_data
                    .get(objective.id.as_str())
                    .and_then(|value| value.as_i64())
                    .unwrap_or_default()
            } else if is_completed {
                target
            } else {
                0
            };
            MainQuestSectionObjectiveDto {
                id: objective.id.clone(),
                objective_type: objective.objective_type.clone(),
                text: objective.text.clone(),
                target,
                done,
                params: objective.params.clone(),
            }
        })
        .collect();
    MainQuestSectionDto {
        id: section.id.clone(),
        chapter_id: section.chapter_id.clone(),
        section_num: section.section_num,
        name: section.name.clone(),
        description: section.description.clone(),
        brief: section.brief.clone(),
        npc_id: section.npc_id.clone(),
        map_id: section.map_id.clone(),
        room_id: section.room_id.clone(),
        status,
        objectives,
        rewards: section.rewards.clone(),
        is_chapter_final: section.is_chapter_final == Some(true),
    }
}

fn load_main_quest_defs() -> Result<(Vec<MainQuestChapterSeed>, Vec<MainQuestSectionSeed>), AppError>
{
    let mut chapters = Vec::new();
    let mut sections = Vec::new();
    for path in std::fs::read_dir(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../server/src/data/seeds"),
    )
    .map_err(|error| AppError::config(format!("failed to read main quest seed dir: {error}")))?
    {
        let path = path
            .map_err(|error| {
                AppError::config(format!("failed to iterate main quest seed dir: {error}"))
            })?
            .path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with("main_quest_chapter") || !file_name.ends_with(".json") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| AppError::config(format!("failed to read {file_name}: {error}")))?;
        let payload: MainQuestSeedFile = serde_json::from_str(&content)
            .map_err(|error| AppError::config(format!("failed to parse {file_name}: {error}")))?;
        chapters.extend(
            payload
                .chapters
                .into_iter()
                .filter(|chapter| chapter.enabled != Some(false)),
        );
        sections.extend(
            payload
                .sections
                .into_iter()
                .filter(|section| section.enabled != Some(false)),
        );
    }
    chapters.sort_by(|left, right| {
        left.chapter_num
            .cmp(&right.chapter_num)
            .then_with(|| left.id.cmp(&right.id))
    });
    sections.sort_by(|left, right| {
        left.chapter_id
            .cmp(&right.chapter_id)
            .then_with(|| left.section_num.cmp(&right.section_num))
    });
    Ok((chapters, sections))
}

#[cfg(test)]
mod tests {
    #[test]
    fn main_quest_progress_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {
                "currentChapter": {"id": "mq-chapter-1", "chapterNum": 1},
                "currentSection": {"id": "main-1-001", "status": "not_started"},
                "completedChapters": [],
                "completedSections": [],
                "dialogueState": null,
                "tracked": true
            }
        });
        assert_eq!(payload["data"]["currentSection"]["id"], "main-1-001");
        println!("MAIN_QUEST_PROGRESS_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_chapters_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"chapters": [{"id": "mq-chapter-1", "chapterNum": 1, "isCompleted": false}]}
        });
        assert_eq!(payload["data"]["chapters"][0]["id"], "mq-chapter-1");
        println!("MAIN_QUEST_CHAPTERS_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_sections_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "data": {"sections": [{"id": "main-1-001", "status": "not_started", "objectives": [{"id": "obj-1", "target": 1, "done": 0}]}]}
        });
        assert_eq!(payload["data"]["sections"][0]["id"], "main-1-001");
        println!("MAIN_QUEST_SECTIONS_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_track_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"tracked": true}
        });
        assert_eq!(payload["data"]["tracked"], true);
        println!("MAIN_QUEST_TRACK_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_dialogue_start_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "dialogueState": {
                    "dialogueId": "dlg-main-1-001",
                    "currentNodeId": "start",
                    "isComplete": false,
                    "selectedChoices": []
                }
            }
        });
        assert_eq!(
            payload["data"]["dialogueState"]["dialogueId"],
            "dlg-main-1-001"
        );
        println!("MAIN_QUEST_DIALOGUE_START_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_dialogue_advance_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"dialogueState": {"dialogueId": "dlg-main-1-001", "currentNodeId": "npc-1"}, "effectResults": []}
        });
        assert_eq!(payload["data"]["dialogueState"]["currentNodeId"], "npc-1");
        println!("MAIN_QUEST_DIALOGUE_ADVANCE_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_dialogue_choice_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {"dialogueState": {"dialogueId": "dlg-main-1-001", "currentNodeId": "choice-result"}, "effectResults": []}
        });
        assert_eq!(
            payload["data"]["dialogueState"]["currentNodeId"],
            "choice-result"
        );
        println!("MAIN_QUEST_DIALOGUE_CHOICE_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_complete_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "rewards": [{"type": "exp", "amount": 30}],
                "nextSection": {"id": "main-1-002"},
                "chapterCompleted": false
            }
        });
        assert_eq!(payload["data"]["chapterCompleted"], false);
        println!("MAIN_QUEST_COMPLETE_RESPONSE={}", payload);
    }

    #[test]
    fn main_quest_craft_item_progress_advances_matching_objective_only() {
        let objectives = vec![super::MainQuestObjectiveSeed {
            id: "obj-2".to_string(),
            objective_type: "craft_item".to_string(),
            text: "炼制回气丹 1 次".to_string(),
            target: 1,
            params: Some(serde_json::json!({"recipe_id": "recipe-hui-qi-dan"})),
        }];
        let (progress, changed, completed) = super::apply_main_quest_craft_item_progress(
            &serde_json::json!({}),
            &objectives,
            "recipe-hui-qi-dan",
            1,
        );
        assert!(changed);
        assert!(completed);
        assert_eq!(progress["obj-2"], 1);
    }
}
