use axum::Json;
use axum::extract::State;
use axum::http::HeaderMap;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::auth;
use crate::shared::error::AppError;
use crate::shared::response::{ServiceResult, send_result};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct InsightInjectRequest {
    pub exp: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightOverviewDto {
    pub unlocked: bool,
    pub unlock_realm: String,
    pub current_level: i64,
    pub current_progress_exp: i64,
    pub current_bonus_pct: f64,
    pub next_level_cost_exp: i64,
    pub character_exp: i64,
    pub cost_stage_levels: i64,
    pub cost_stage_base_exp: i64,
    pub bonus_pct_per_level: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightInjectResultDto {
    pub before_level: i64,
    pub after_level: i64,
    pub after_progress_exp: i64,
    pub actual_injected_levels: i64,
    pub spent_exp: i64,
    pub remaining_exp: i64,
    pub gained_bonus_pct: f64,
    pub current_bonus_pct: f64,
}

#[derive(Debug, Deserialize)]
struct InsightConfigFile {
    config: InsightConfig,
}

#[derive(Debug, Deserialize, Clone)]
struct InsightConfig {
    unlock_realm: String,
    cost_stage_levels: i64,
    cost_stage_base_exp: i64,
    bonus_pct_per_level: f64,
}

pub async fn get_overview(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let config = load_insight_config()?;
    let character = load_character_insight_row(&state, actor.user_id, false).await?;
    let Some(character) = character else {
        return Ok(send_result(ServiceResult::<InsightOverviewDto> {
            success: false,
            message: Some("角色不存在".to_string()),
            data: None,
        }));
    };
    let progress = load_insight_progress(&state, character.character_id, false).await?;
    let unlocked = is_insight_unlocked(
        &character.realm,
        character.sub_realm.as_deref(),
        &config.unlock_realm,
    );

    Ok(send_result(ServiceResult {
        success: true,
        message: Some("ok".to_string()),
        data: Some(InsightOverviewDto {
            unlocked,
            unlock_realm: config.unlock_realm.clone(),
            current_level: progress.level,
            current_progress_exp: progress.progress_exp,
            current_bonus_pct: build_insight_pct_bonus_by_level(progress.level, &config),
            next_level_cost_exp: calc_insight_cost_by_level(progress.level + 1, &config),
            character_exp: character.exp,
            cost_stage_levels: config.cost_stage_levels,
            cost_stage_base_exp: config.cost_stage_base_exp,
            bonus_pct_per_level: config.bonus_pct_per_level,
        }),
    }))
}

pub async fn inject_exp(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<InsightInjectRequest>,
) -> Result<axum::response::Response, AppError> {
    let actor = auth::require_auth(&state, &headers).await?;
    let inject_budget = payload.exp.unwrap_or_default();
    if inject_budget <= 0 {
        return Ok(send_result(ServiceResult::<InsightInjectResultDto> {
            success: false,
            message: Some("exp 参数无效，需为大于 0 的整数".to_string()),
            data: None,
        }));
    }

    let config = load_insight_config()?;
    let result = state
        .database
        .with_transaction(|| async {
            let character = load_character_insight_row(&state, actor.user_id, true).await?;
            let Some(character) = character else {
                return Ok(ServiceResult::<InsightInjectResultDto> {
                    success: false,
                    message: Some("角色不存在".to_string()),
                    data: None,
                });
            };
            if !is_insight_unlocked(&character.realm, character.sub_realm.as_deref(), &config.unlock_realm) {
                return Ok(ServiceResult::<InsightInjectResultDto> {
                    success: false,
                    message: Some(format!("未达到{}，无法悟道", config.unlock_realm)),
                    data: None,
                });
            }

            let before_progress = load_insight_progress(&state, character.character_id, true).await?;
            let plan = resolve_insight_inject_plan(
                before_progress.level,
                before_progress.progress_exp,
                character.exp,
                inject_budget,
                &config,
            )?;
            if plan.spent_exp <= 0 {
                return Ok(ServiceResult::<InsightInjectResultDto> {
                    success: false,
                    message: Some("经验不足，无法悟道".to_string()),
                    data: None,
                });
            }

            state
                .database
                .execute(
                    "UPDATE characters SET exp = $2, updated_at = NOW() WHERE id = $1",
                    |query| query.bind(character.character_id).bind(plan.remaining_exp),
                )
                .await?;
            state
                .database
                .execute(
                    "UPDATE character_insight_progress SET level = $2, progress_exp = $3, total_exp_spent = total_exp_spent + $4, updated_at = NOW() WHERE character_id = $1",
                    |query| query.bind(character.character_id).bind(plan.after_level).bind(plan.after_progress_exp).bind(plan.spent_exp),
                )
                .await?;

            Ok(ServiceResult {
                success: true,
                message: Some("ok".to_string()),
                data: Some(InsightInjectResultDto {
                    before_level: before_progress.level,
                    after_level: plan.after_level,
                    after_progress_exp: plan.after_progress_exp,
                    actual_injected_levels: plan.actual_injected_levels,
                    spent_exp: plan.spent_exp,
                    remaining_exp: plan.remaining_exp,
                    gained_bonus_pct: plan.after_bonus_pct - plan.before_bonus_pct,
                    current_bonus_pct: plan.after_bonus_pct,
                }),
            })
        })
        .await?;

    Ok(send_result(result))
}

#[derive(Debug, Clone)]
struct CharacterInsightRow {
    character_id: i64,
    realm: String,
    sub_realm: Option<String>,
    exp: i64,
}

#[derive(Debug, Clone)]
struct InsightProgressRow {
    level: i64,
    progress_exp: i64,
}

#[derive(Debug, Clone)]
struct InsightInjectPlan {
    actual_injected_levels: i64,
    spent_exp: i64,
    remaining_exp: i64,
    after_level: i64,
    after_progress_exp: i64,
    before_bonus_pct: f64,
    after_bonus_pct: f64,
}

fn load_insight_config() -> Result<InsightConfig, AppError> {
    let content = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../server/src/data/seeds/insight_growth.json"),
    )
    .map_err(|error| AppError::config(format!("failed to read insight_growth.json: {error}")))?;
    let payload: InsightConfigFile = serde_json::from_str(&content).map_err(|error| {
        AppError::config(format!("failed to parse insight_growth.json: {error}"))
    })?;
    Ok(payload.config)
}

async fn load_character_insight_row(
    state: &AppState,
    user_id: i64,
    for_update: bool,
) -> Result<Option<CharacterInsightRow>, AppError> {
    let sql = if for_update {
        "SELECT id, realm, sub_realm, exp FROM characters WHERE user_id = $1 LIMIT 1 FOR UPDATE"
    } else {
        "SELECT id, realm, sub_realm, exp FROM characters WHERE user_id = $1 LIMIT 1"
    };
    let row = state
        .database
        .fetch_optional(sql, |query| query.bind(user_id))
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    Ok(Some(CharacterInsightRow {
        character_id: row.try_get("id")?,
        realm: row
            .try_get::<Option<String>, _>("realm")?
            .unwrap_or_else(|| "凡人".to_string()),
        sub_realm: row.try_get::<Option<String>, _>("sub_realm")?,
        exp: row.try_get::<Option<i64>, _>("exp")?.unwrap_or_default(),
    }))
}

async fn load_insight_progress(
    state: &AppState,
    character_id: i64,
    for_update: bool,
) -> Result<InsightProgressRow, AppError> {
    if for_update {
        state.database.execute(
            "INSERT INTO character_insight_progress (character_id, level, progress_exp, total_exp_spent, created_at, updated_at) VALUES ($1, 0, 0, 0, NOW(), NOW()) ON CONFLICT (character_id) DO NOTHING",
            |query| query.bind(character_id),
        ).await?;
    }
    let sql = if for_update {
        "SELECT level, progress_exp FROM character_insight_progress WHERE character_id = $1 LIMIT 1 FOR UPDATE"
    } else {
        "SELECT level, progress_exp FROM character_insight_progress WHERE character_id = $1 LIMIT 1"
    };
    let row = state
        .database
        .fetch_optional(sql, |query| query.bind(character_id))
        .await?;
    let Some(row) = row else {
        return Ok(InsightProgressRow {
            level: 0,
            progress_exp: 0,
        });
    };
    Ok(InsightProgressRow {
        level: row.try_get::<Option<i64>, _>("level")?.unwrap_or_default(),
        progress_exp: row
            .try_get::<Option<i64>, _>("progress_exp")?
            .unwrap_or_default(),
    })
}

fn is_insight_unlocked(realm: &str, sub_realm: Option<&str>, unlock_realm: &str) -> bool {
    realm_rank(build_full_realm(realm, sub_realm.unwrap_or_default()))
        >= realm_rank(unlock_realm.to_string())
}

fn build_full_realm(realm: &str, sub_realm: &str) -> String {
    let realm = realm.trim();
    let sub_realm = sub_realm.trim();
    if realm.is_empty() {
        return "凡人".to_string();
    }
    if realm == "凡人" || sub_realm.is_empty() {
        return realm.to_string();
    }
    format!("{}·{}", realm, sub_realm)
}

fn realm_rank(realm: String) -> i64 {
    const ORDER: &[&str] = &[
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
    ];
    ORDER
        .iter()
        .position(|item| *item == realm.trim())
        .unwrap_or(0) as i64
}

fn calc_insight_cost_by_level(level: i64, config: &InsightConfig) -> i64 {
    let safe_level = level.max(1);
    let stage_index = (safe_level - 1).div_euclid(config.cost_stage_levels.max(1));
    config.cost_stage_base_exp.max(1) * (stage_index + 1)
}

fn build_insight_pct_bonus_by_level(level: i64, config: &InsightConfig) -> f64 {
    (level.max(0) as f64) * config.bonus_pct_per_level.max(0.0)
}

fn resolve_insight_inject_plan(
    before_level: i64,
    before_progress_exp: i64,
    character_exp: i64,
    inject_exp_budget: i64,
    config: &InsightConfig,
) -> Result<InsightInjectPlan, AppError> {
    let safe_before_level = before_level.max(0);
    let safe_character_exp = character_exp.max(0);
    let safe_inject_budget = inject_exp_budget.max(0).min(safe_character_exp);
    let mut remaining_budget_exp = safe_inject_budget;
    let mut current_level = safe_before_level;
    let mut current_progress_exp = before_progress_exp.max(0);
    let mut gained_levels = 0;

    let before_level_cost = calc_insight_cost_by_level(safe_before_level + 1, config);
    if current_progress_exp >= before_level_cost {
        return Err(AppError::config("悟道进度异常：当前等级进度已超过升级需求"));
    }

    while remaining_budget_exp > 0 {
        let next_level_cost = calc_insight_cost_by_level(current_level + 1, config);
        let required_exp = (next_level_cost - current_progress_exp).max(0);
        if required_exp == 0 {
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }
        if remaining_budget_exp >= required_exp {
            remaining_budget_exp -= required_exp;
            current_level += 1;
            current_progress_exp = 0;
            gained_levels += 1;
            continue;
        }
        current_progress_exp += remaining_budget_exp;
        remaining_budget_exp = 0;
    }

    let spent_exp = safe_inject_budget - remaining_budget_exp;
    let before_bonus_pct = build_insight_pct_bonus_by_level(safe_before_level, config);
    let after_bonus_pct = build_insight_pct_bonus_by_level(current_level, config);
    Ok(InsightInjectPlan {
        actual_injected_levels: gained_levels,
        spent_exp,
        remaining_exp: (safe_character_exp - spent_exp).max(0),
        after_level: current_level,
        after_progress_exp: current_progress_exp,
        before_bonus_pct,
        after_bonus_pct,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn insight_overview_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "unlocked": true,
                "unlockRealm": "炼精化炁·养气期",
                "currentLevel": 2,
                "currentProgressExp": 30,
                "currentBonusPct": 0.1,
                "nextLevelCostExp": 100,
                "characterExp": 500,
                "costStageLevels": 10,
                "costStageBaseExp": 100,
                "bonusPctPerLevel": 0.05
            }
        });
        assert_eq!(payload["data"]["currentLevel"], 2);
        println!("INSIGHT_OVERVIEW_RESPONSE={}", payload);
    }

    #[test]
    fn insight_inject_payload_matches_contract() {
        let payload = serde_json::json!({
            "success": true,
            "message": "ok",
            "data": {
                "beforeLevel": 1,
                "afterLevel": 2,
                "afterProgressExp": 20,
                "actualInjectedLevels": 1,
                "spentExp": 120,
                "remainingExp": 80,
                "gainedBonusPct": 0.05,
                "currentBonusPct": 0.1
            }
        });
        assert_eq!(payload["data"]["afterLevel"], 2);
        println!("INSIGHT_INJECT_RESPONSE={}", payload);
    }
}
